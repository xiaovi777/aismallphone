// 酒馆卡（SillyTavern 角色卡）导入。
// 支持 PNG 内嵌数据（tEXt/iTXt/zTXt，关键字 chara/Chara/ccv2/ccv3，base64 或裸 JSON）
// 与 JSON 文件；兼容 Character Card Spec v1/v2/v3 及常见包装层。
// 解析结果交给导入对话框预览：用户可编辑人设，并选择是否把随卡
// character_book 导入为世界书并绑定给该角色。
//
// 注：仅实现社区公开的卡片规范解析，与任何第三方实现的授权机制无关。

import { createWorldBook } from "./settings-storage";
import type { WorldBookConfig, WorldBookEntry } from "./settings-types";

export type TavernCardParseResult = {
    name: string;
    persona: string;
    avatar: string; // PNG 卡为图片 dataURL，JSON 卡为空
    tags: string[];
    worldbook: WorldBookConfig | null;
    spec: string; // chara_card_v2 / chara_card_v3 / v1 等，仅展示用
};

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHARA_KEYWORDS = new Set(["chara", "Chara", "ccv2", "ccv3"]);
const WRAP_KEYS = ["character", "card", "char", "chara_card", "charaCard", "chara_card_v2", "chara_card_v3"];

// ── 小工具 ────────────────────────────────────────────────

function extOf(name: string): string {
    const m = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : "";
}

function isPngBuffer(u8: Uint8Array): boolean {
    if (u8.length < 8) return false;
    for (let i = 0; i < PNG_SIG.length; i++) {
        if (u8[i] !== PNG_SIG[i]) return false;
    }
    return true;
}

async function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
    return await file.arrayBuffer();
}

function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error || new Error("read_failed"));
        reader.readAsDataURL(file);
    });
}

function decodeBytesUtf8(bytes: Uint8Array): string {
    if (!bytes.length) return "";
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        // 部分老卡片的嵌入文本是 GBK（Chromium 支持 gbk 标签）
        try {
            return new TextDecoder("gbk").decode(bytes);
        } catch {
            return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        }
    }
}

function decodeBase64ToText(b64: string): string {
    const clean = String(b64 || "").replace(/\s/g, "");
    if (!clean) return "";
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
    return decodeBytesUtf8(bytes);
}

function decodeEmbeddedJson(text: string): unknown | null {
    const raw = String(text || "").trim();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        try {
            return JSON.parse(decodeBase64ToText(raw));
        } catch {
            return null;
        }
    }
}

// 宽松版：tEXt 块按规范是 latin1，但部分工具会把 UTF-8 原始 JSON 直接塞进去。
// 若文本含 U+0080–U+00FF 的“latin1 伪装字节”，优先把字符串还原成字节再按
// UTF-8/GBK 解码解析（JSON 骨架是 ASCII，乱码文本也可能“解析成功”，不能靠失败触发回退）。
function decodeEmbeddedJsonLenient(text: string): unknown | null {
    const raw = String(text || "");
    if (!raw.trim()) return null;
    if (/[\u0080-\u00ff]/.test(raw)) {
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
        const fromBytes = decodeEmbeddedJson(decodeBytesUtf8(bytes));
        if (fromBytes) return fromBytes;
    }
    return decodeEmbeddedJson(raw);
}

async function inflateZlib(payload: Uint8Array): Promise<Uint8Array> {
    if (typeof DecompressionStream === "undefined") throw new Error("no_inflate");
    // 复制一份，保证底层是普通 ArrayBuffer（兼容 TS 的 BlobPart 类型约束）
    const copy = new Uint8Array(payload.length);
    copy.set(payload);
    const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("deflate"));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
}

// ── PNG 文本块解析 ────────────────────────────────────────

type PngTextHit = { keyword: string; text: string };
type PngCompressedHit = { keyword: string; payload: Uint8Array };

function readUint32BE(u8: Uint8Array, offset: number): number {
    return ((u8[offset] << 24) | (u8[offset + 1] << 16) | (u8[offset + 2] << 8) | u8[offset + 3]) >>> 0;
}

function scanPngChunks(u8: Uint8Array): { texts: PngTextHit[]; compressed: PngCompressedHit[] } {
    const texts: PngTextHit[] = [];
    const compressed: PngCompressedHit[] = [];
    if (!isPngBuffer(u8)) return { texts, compressed };

    let offset = 8;
    while (offset + 8 <= u8.length) {
        const length = readUint32BE(u8, offset);
        const type = String.fromCharCode(u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7]);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > u8.length) break;
        const data = u8.subarray(dataStart, dataEnd);

        if (type === "tEXt" || type === "iTXt" || type === "zTXt") {
            let nul = -1;
            for (let i = 0; i < data.length; i++) {
                if (data[i] === 0) { nul = i; break; }
            }
            if (nul >= 0) {
                const keyword = new TextDecoder("latin1").decode(data.subarray(0, nul));
                if (CHARA_KEYWORDS.has(keyword)) {
                    if (type === "tEXt") {
                        texts.push({ keyword, text: new TextDecoder("latin1").decode(data.subarray(nul + 1)) });
                    } else if (type === "zTXt") {
                        // keyword\0 compressionMethod(1) text
                        const rest = data.subarray(nul + 1);
                        if (rest.length >= 1) compressed.push({ keyword, payload: rest.subarray(1) });
                    } else {
                        // iTXt: keyword\0 flag(1) method(1) lang\0 translated\0 text
                        const rest = data.subarray(nul + 1);
                        if (rest.length >= 2) {
                            const flag = rest[0];
                            let p = 2;
                            while (p < rest.length && rest[p] !== 0) p++;
                            p++;
                            while (p < rest.length && rest[p] !== 0) p++;
                            p++;
                            if (p <= rest.length) {
                                if (flag === 0) {
                                    texts.push({ keyword, text: new TextDecoder("utf-8").decode(rest.subarray(p)) });
                                } else {
                                    compressed.push({ keyword, payload: rest.subarray(p) });
                                }
                            }
                        }
                    }
                }
            }
        }

        offset = dataEnd + 4;
    }
    return { texts, compressed };
}

async function extractJsonFromPng(buf: ArrayBuffer): Promise<Record<string, unknown> | null> {
    const u8 = new Uint8Array(buf);
    const { texts, compressed } = scanPngChunks(u8);

    for (const hit of texts) {
        const parsed = decodeEmbeddedJsonLenient(hit.text);
        if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    }
    for (const hit of compressed) {
        try {
            const bytes = await inflateZlib(hit.payload);
            const parsed = decodeEmbeddedJson(decodeBytesUtf8(bytes));
            if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
        } catch {
            // 该块解不开就继续试下一个
        }
    }
    return null;
}

// ── 卡片结构展开与 v1 别名归一 ────────────────────────────

const RECOGNIZED_KEYS = [
    "name", "char_name", "description", "char_persona", "personality",
    "scenario", "first_mes", "char_greeting", "mes_example", "system_prompt",
    "character_book", "creator_notes", "post_history_instructions",
];

function looksLikeCharacterData(obj: Record<string, unknown>): boolean {
    for (const key of RECOGNIZED_KEYS) {
        const val = obj[key];
        if (val != null && String(val).trim() !== "") return true;
    }
    if (Array.isArray(obj.alternate_greetings) && obj.alternate_greetings.length > 0) return true;
    if (Array.isArray(obj.tags) && obj.tags.length > 0) return true;
    return false;
}

function normalizeCharacterData(data: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...data };
    if (!String(out.name ?? "").trim() && out.char_name) out.name = out.char_name;
    if (!String(out.description ?? "").trim() && out.char_persona) out.description = out.char_persona;
    if (!String(out.first_mes ?? "").trim() && out.char_greeting) out.first_mes = out.char_greeting;
    if (!String(out.personality ?? "").trim() && out.char_personality) out.personality = out.char_personality;
    if (!String(out.scenario ?? "").trim() && out.world_scenario) out.scenario = out.world_scenario;
    if (!String(out.mes_example ?? "").trim() && out.example_dialogue) out.mes_example = out.example_dialogue;
    return out;
}

function parseMaybeJson(value: unknown): unknown | null {
    if (value == null) return null;
    if (typeof value === "object") return value;
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        try {
            return JSON.parse(decodeBase64ToText(text));
        } catch {
            return null;
        }
    }
}

export function unwrapCardRoot(raw: unknown): Record<string, unknown> | null {
    if (raw == null) return null;

    if (Array.isArray(raw)) {
        for (const item of raw) {
            const found = unwrapCardRoot(item);
            if (found) return found;
        }
        return null;
    }

    if (typeof raw !== "object") {
        if (typeof raw === "string") return unwrapCardRoot(parseMaybeJson(raw));
        return null;
    }

    const obj = raw as Record<string, unknown>;

    for (const key of WRAP_KEYS) {
        const wrapped = obj[key];
        if (wrapped != null) {
            const found = unwrapCardRoot(wrapped);
            if (found) return found;
        }
    }

    for (const key of ["chara", "ccv3"]) {
        if (obj[key] != null) {
            const found = unwrapCardRoot(parseMaybeJson(obj[key]));
            if (found) return found;
        }
    }

    if (obj.data != null) {
        const inner = parseMaybeJson(obj.data) ?? obj.data;
        if (inner && typeof inner === "object") {
            const spec = String(obj.spec ?? "").toLowerCase();
            if (spec.includes("chara") || spec.includes("ccv") || obj.spec_version || looksLikeCharacterData(inner as Record<string, unknown>)) {
                return normalizeCharacterData(inner as Record<string, unknown>);
            }
        }
    }

    if (looksLikeCharacterData(obj)) return normalizeCharacterData(obj);
    return null;
}

// ── 卡片 → 人设文本 / 世界书 ──────────────────────────────

function addSection(sections: string[], label: string, val: unknown): void {
    const text = String(val ?? "").trim();
    if (text) sections.push(`【${label}】\n${text}`);
}

export function buildPersonaFromCard(data: Record<string, unknown>): string {
    const sections: string[] = [];
    addSection(sections, "描述", data.description);
    addSection(sections, "性格", data.personality);
    addSection(sections, "情景", data.scenario);
    addSection(sections, "系统提示", data.system_prompt);
    addSection(sections, "历史后指令", data.post_history_instructions);
    addSection(sections, "首条消息", data.first_mes);
    addSection(sections, "对话示例", data.mes_example);
    if (Array.isArray(data.alternate_greetings) && data.alternate_greetings.length > 0) {
        const alts = data.alternate_greetings.map(g => String(g ?? "")).filter(Boolean);
        if (alts.length) addSection(sections, "备选开场", alts.join("\n---\n"));
    }
    addSection(sections, "创作者备注", data.creator_notes);
    return sections.join("\n\n");
}

let entrySeq = 0;
function nextEntryUid(): string {
    entrySeq += 1;
    return `wb-entry_${Date.now()}_${entrySeq}_${Math.random().toString(36).slice(2, 6)}`;
}

function collectEntryKeys(entry: Record<string, unknown>): string[] {
    // SillyTavern 里 secondary keys 语义是“且”，本应用按逗号“或”匹配，
    // 这里与主流转换做法一致：合并进同一关键词列表，宁多勿漏。
    const keys: string[] = [];
    if (Array.isArray(entry.keys)) {
        for (const k of entry.keys) keys.push(String(k ?? ""));
    } else if (entry.key != null && String(entry.key).trim() !== "") {
        keys.push(...String(entry.key).split(","));
    }
    if (Array.isArray(entry.secondary_keys)) {
        for (const k of entry.secondary_keys) keys.push(String(k ?? ""));
    } else if (entry.keysecondary != null && String(entry.keysecondary).trim() !== "") {
        keys.push(...String(entry.keysecondary).split(","));
    }
    return keys.map(k => k.trim()).filter(Boolean);
}

function mapTavernPosition(pos: unknown): WorldBookEntry["position"] {
    if (pos === 0 || pos === "0" || pos === "before_char") return "before_char";
    if (pos === 1 || pos === "1" || pos === "after_char") return "after_char";
    if (pos === 2 || pos === "2" || pos === "before_em") return "before_em";
    if (pos === 3 || pos === "3" || pos === "after_em") return "after_em";
    if (pos === 4 || pos === "4") return 4; // at depth：按 entry.depth 注入
    if (pos === "before_an" || pos === "after_an") return pos;
    if (typeof pos === "number") return pos;
    return "before_char";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapTavernEntry(entry: any, index: number): WorldBookEntry | null {
    if (!entry || typeof entry !== "object") return null;
    const content = String(entry.content ?? "");
    const keywords = collectEntryKeys(entry);
    const isConstant = Boolean(entry.constant);
    if (!content.trim() && keywords.length === 0 && !isConstant) return null;

    const probability = Number(entry.probability);
    return {
        uid: entry.uid != null ? String(entry.uid) : nextEntryUid(),
        key: keywords.join(","),
        content,
        comment: String(entry.comment ?? entry.name ?? "").slice(0, 120),
        use_regex: Boolean(entry.use_regex || entry.isRegex),
        disable: entry.enabled === false || Boolean(entry.disable || entry.disabled),
        constant: isConstant,
        position: mapTavernPosition(entry.position),
        depth: Number(entry.depth ?? entry.insertion_depth) || 0,
        probability: Number.isFinite(probability) ? Math.max(0, Math.min(100, probability)) : 100,
        useProbability: Boolean(entry.useProbability ?? entry.use_probability ?? false),
        role: Number(entry.role) || 0,
        insertion_order: Number(entry.insertion_order ?? entry.order ?? index),
    };
}

function extractWorldbook(data: Record<string, unknown>, charName: string): WorldBookConfig | null {
    const book = data.character_book;
    if (!book || typeof book !== "object") return null;

    const rawEntries: unknown[] = Array.isArray((book as Record<string, unknown>).entries)
        ? ((book as Record<string, unknown>).entries as unknown[])
        : (book as Record<string, unknown>).entries && typeof (book as Record<string, unknown>).entries === "object"
            ? Object.values((book as Record<string, unknown>).entries as Record<string, unknown>)
            : [];
    if (!rawEntries.length) return null;

    const bookName = String((book as Record<string, unknown>).name ?? (book as Record<string, unknown>).description ?? "").trim()
        || `${charName || "角色"} · 角色世界书`;
    const wb = createWorldBook(bookName.slice(0, 60));

    const mapped: WorldBookEntry[] = [];
    rawEntries.forEach((raw, index) => {
        const entry = mapTavernEntry(raw, index);
        if (entry) mapped.push(entry);
    });
    if (!mapped.length) return null;

    wb.entries = mapped;
    return wb;
}

// ── 文件解析入口 ──────────────────────────────────────────

function detectSpec(raw: unknown, data: Record<string, unknown>): string {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const spec = String((raw as Record<string, unknown>).spec ?? "");
        if (spec) return spec;
        if ((raw as Record<string, unknown>).spec_version != null) return `chara_card_v${String((raw as Record<string, unknown>).spec_version)}`;
        if ((raw as Record<string, unknown>).chara_card_v3 != null) return "chara_card_v3";
        if ((raw as Record<string, unknown>).chara_card_v2 != null) return "chara_card_v2";
    }
    if (data.spec) return String(data.spec);
    return "v1";
}

function buildResult(data: Record<string, unknown>, avatar: string, spec: string): TavernCardParseResult {
    const name = String(data.name ?? "").trim().slice(0, 32);
    return {
        name,
        persona: buildPersonaFromCard(data),
        avatar,
        tags: Array.isArray(data.tags) ? data.tags.map(t => String(t)).filter(Boolean).slice(0, 30) : [],
        worldbook: extractWorldbook(data, name),
        spec,
    };
}

function decodeJsonText(buf: ArrayBuffer): string {
    const u8 = new Uint8Array(buf);
    if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
        return new TextDecoder("utf-8").decode(u8.subarray(3));
    }
    if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) {
        return new TextDecoder("utf-16le").decode(u8.subarray(2));
    }
    if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) {
        return new TextDecoder("utf-16be").decode(u8.subarray(2));
    }
    return decodeBytesUtf8(u8);
}

async function parseJsonBuffer(buf: ArrayBuffer): Promise<TavernCardParseResult> {
    const text = decodeJsonText(buf).replace(/^\uFEFF/, "").trim();
    if (!text) throw new Error("empty_json");
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw new Error("invalid_json");
    }
    const data = unwrapCardRoot(raw);
    if (!data) throw new Error("not_character_card");
    return buildResult(data, "", detectSpec(raw, data));
}

/** 解析酒馆卡文件（.png / .json，或按魔数兜底）。失败时抛出带错误码的 Error。 */
export async function parseTavernCardFile(file: File): Promise<TavernCardParseResult> {
    if (!file) throw new Error("no_file");
    const ext = extOf(file.name);
    const mime = String(file.type || "").toLowerCase();

    if (ext === "json" || mime === "application/json") {
        return parseJsonBuffer(await readFileAsArrayBuffer(file));
    }

    if (ext === "png" || mime === "image/png") {
        const [buf, dataUrl] = await Promise.all([readFileAsArrayBuffer(file), readFileAsDataUrl(file)]);
        const embedded = await extractJsonFromPng(buf);
        if (!embedded) throw new Error("png_no_chara");
        const data = unwrapCardRoot(embedded);
        if (!data) throw new Error("not_character_card");
        return buildResult(data, dataUrl || "", detectSpec(embedded, data));
    }

    // 扩展名不可信时按内容判断
    const buf = await readFileAsArrayBuffer(file);
    if (isPngBuffer(new Uint8Array(buf))) {
        const pngFile = new File([buf], `${file.name || "card"}.png`, { type: "image/png" });
        return parseTavernCardFile(pngFile);
    }
    return parseJsonBuffer(buf);
}

export function tavernParseErrorMessage(code: string): string {
    switch (code) {
        case "png_no_chara": return "PNG 中未找到酒馆卡数据";
        case "not_character_card": return "不是有效的酒馆角色卡";
        case "invalid_json": return "JSON 格式无效";
        case "empty_json": return "文件内容为空";
        case "no_inflate": return "当前浏览器不支持解压卡片数据块";
        default: return "读取角色卡失败";
    }
}