"use client";

import { useMemo, useState } from "react";
import { BookOpen, ChevronDown, ChevronUp, X } from "lucide-react";
import type { TavernCardParseResult } from "@/lib/tavern-card-import";
import type { WorldBookConfig } from "@/lib/settings-types";

export type TavernImportConfirmPayload = {
  name: string;
  persona: string;
  avatar: string;
  tags: string[];
  worldbook: WorldBookConfig | null;
};

type Props = {
  data: TavernCardParseResult;
  onConfirm: (payload: TavernImportConfirmPayload) => void;
  onClose: () => void;
};

export function TavernCardImportDialog({ data, onConfirm, onClose }: Props) {
  const [name, setName] = useState(data.name);
  const [persona, setPersona] = useState(data.persona);
  const [importBook, setImportBook] = useState(true);
  const [entriesOpen, setEntriesOpen] = useState(false);

  const entries = data.worldbook?.entries ?? [];
  const canConfirm = name.trim().length > 0 || persona.trim().length > 0;
  const specLabel = useMemo(() => {
    const s = data.spec || "";
    if (s.includes("v3")) return "V3";
    if (s.includes("v2")) return "V2";
    return s ? s.toUpperCase() : "V1";
  }, [data.spec]);

  function handleConfirm() {
    if (!canConfirm) return;
    onConfirm({
      name: name.trim().slice(0, 32) || "未命名角色",
      persona: persona.trim(),
      avatar: data.avatar,
      tags: data.tags,
      worldbook: importBook ? data.worldbook : null,
    });
  }

  return (
    <div
      className="fixed inset-0 z-[10020] flex items-end justify-center bg-black/45 sm:items-center sm:px-5"
      role="dialog"
      aria-modal="true"
      aria-label="导入酒馆卡"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[86vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl border border-[var(--c-panel-border)] bg-[var(--c-page-body-bg)] text-[var(--c-text)] shadow-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-[var(--c-panel-border)] px-5 py-4">
          <div>
            <div className="font-bold">导入酒馆卡</div>
            <div className="mt-0.5 text-xs opacity-60">SillyTavern 角色卡 · {specLabel}</div>
          </div>
          <button type="button" className="px-2 py-1 font-semibold" onClick={onClose} aria-label="关闭">关闭</button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="flex items-center gap-3">
            {data.avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={data.avatar} alt="角色卡头像" className="h-14 w-14 shrink-0 rounded-xl border border-[var(--c-panel-border)] object-cover" />
            ) : null}
            <div className="min-w-0 flex-1">
              <label className="text-xs opacity-60" htmlFor="tavern-import-name">角色名</label>
              <input
                id="tavern-import-name"
                className="mt-1 w-full rounded-xl border border-[var(--c-panel-border)] bg-transparent px-3 py-2 text-sm outline-none"
                value={name}
                maxLength={32}
                onChange={(e) => setName(e.target.value)}
                placeholder="未命名角色"
              />
            </div>
          </div>

          <div>
            <label className="text-xs opacity-60" htmlFor="tavern-import-persona">
              人设与背景（已按卡内内容预填，可自行修改）
            </label>
            <textarea
              id="tavern-import-persona"
              className="mt-1 min-h-[180px] w-full resize-y rounded-xl border border-[var(--c-panel-border)] bg-transparent px-3 py-2 text-sm leading-relaxed outline-none"
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              placeholder="填写角色人设…"
            />
          </div>

          {data.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {data.tags.slice(0, 12).map((tag) => (
                <span key={tag} className="rounded-full border border-[var(--c-panel-border)] px-2 py-0.5 text-xs opacity-70">{tag}</span>
              ))}
            </div>
          ) : null}

          {data.worldbook ? (
            <div className="rounded-xl border border-[var(--c-panel-border)] p-3">
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={importBook}
                  onChange={(e) => setImportBook(e.target.checked)}
                />
                <span className="flex-1 text-sm">
                  同时导入世界书并绑定给该角色
                  <span className="mt-0.5 flex items-center gap-1 text-xs opacity-60">
                    <BookOpen size={12} />
                    《{data.worldbook.name}》 · {entries.length} 条词条
                  </span>
                </span>
              </label>
              <button
                type="button"
                className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg border border-[var(--c-panel-border)] px-2 py-1.5 text-xs opacity-75"
                onClick={() => setEntriesOpen(v => !v)}
              >
                {entriesOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                {entriesOpen ? "收起词条" : "查看词条"}
              </button>
              {entriesOpen ? (
                <ul className="mt-2 max-h-56 space-y-2 overflow-y-auto">
                  {entries.map((entry) => (
                    <li key={entry.uid} className="rounded-lg border border-[var(--c-panel-border)] px-2.5 py-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-semibold">
                          {entry.comment || `条目 ${entry.insertion_order + 1}`}
                        </span>
                        <span className="shrink-0 opacity-55">
                          {entry.constant ? "常驻" : entry.disable ? "已停用" : "关键词触发"}
                        </span>
                      </div>
                      {!entry.constant && entry.key ? (
                        <div className="mt-0.5 truncate opacity-60">关键词：{entry.key}</div>
                      ) : null}
                      <div className="mt-1 line-clamp-3 whitespace-pre-wrap opacity-80">{entry.content}</div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <p className="text-xs opacity-55">该角色卡未附带世界书。</p>
          )}
        </div>

        <div className="flex gap-2 border-t border-[var(--c-panel-border)] px-5 py-4">
          <button
            type="button"
            className="flex-1 rounded-xl border border-[var(--c-panel-border)] px-4 py-3 font-semibold"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="flex-1 rounded-xl bg-[var(--c-text)] px-4 py-3 font-semibold text-[var(--c-page-body-bg)] disabled:opacity-40"
            disabled={!canConfirm}
            onClick={handleConfirm}
          >
            确认导入
          </button>
        </div>
      </div>
    </div>
  );
}