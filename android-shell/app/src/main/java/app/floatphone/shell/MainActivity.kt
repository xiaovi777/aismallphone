package app.floatphone.shell

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.content.ContentValues
import android.media.MediaScannerConnection
import android.provider.MediaStore
import android.util.Base64
import android.webkit.MimeTypeMap
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat

/**
 * Float 小手机安卓壳：全屏 WebView 直接加载线上站点。
 * 网页每次部署即时生效，本壳只负责原生能力（推送长连接、文件上下行、外链）。
 */
class MainActivity : AppCompatActivity() {

    companion object {
        val SITE_URL: String = BuildConfig.SITE_URL
        const val VERSION = "1.1.0"
        /** 来电接听等场景的站内深链（必须以 SITE_URL 开头，否则忽略） */
        const val EXTRA_OPEN_URL = "open_url"
    }

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback ?: return@registerForActivityResult
        filePathCallback = null
        val data = result.data?.data
        callback.onReceiveValue(if (data != null) arrayOf(data) else emptyArray())
    }

    private val notifPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) PushService.start(this)
    }

    // 网页侧 getUserMedia（通话按住说话、语音条录音、视频通话摄像头）触发的
    // WebView 权限请求：先要系统运行时权限，拿到后再转授给页面。
    // 不实现 onPermissionRequest 时 WebView 会静默拒绝，页面永远拿不到麦克风。
    private var pendingWebPermissionRequest: android.webkit.PermissionRequest? = null

    // ── blob:/data: 导出落盘 ─────────────────────────────────────────────
    // WebView 不会自己保存 a[download] 的 blob/data 下载，只会回调 DownloadListener；
    // 壳里必须把数据读出来写进公共媒体库，否则用户只见「导出中」不见文件。
    private data class PendingBlobDownload(val mimeHint: String?, val contentDisposition: String?)

    private val pendingBlobDownloads = ConcurrentHashMap<String, PendingBlobDownload>()
    private val blobTokenSeq = AtomicLong(0)
    private val ioExecutor = Executors.newSingleThreadExecutor()
    private var pendingLegacyFileSave: Pair<ByteArray, String>? = null
    private val saveSubDir = "小手机"

    // API 28 及以下写公共「下载」目录需要存储权限（29+ 走 MediaStore 免权限）
    private val storagePermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        val pending = pendingLegacyFileSave ?: return@registerForActivityResult
        pendingLegacyFileSave = null
        if (!granted) {
            toastOnMain("未授予存储权限，无法保存到「下载」目录")
            return@registerForActivityResult
        }
        ioExecutor.execute {
            runCatching { writeLegacyPublicDownload(pending.first, pending.second) }
                .onFailure { toastOnMain("保存失败：${it.message}") }
        }
    }

    private val webPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        val request = pendingWebPermissionRequest ?: return@registerForActivityResult
        pendingWebPermissionRequest = null
        val granted = request.resources.filter { resource ->
            webResourcePermissions(resource).all {
                ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
            }
        }
        if (granted.isEmpty()) request.deny() else request.grant(granted.toTypedArray())
    }

    private fun webResourcePermissions(resource: String): List<String> = when (resource) {
        android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE -> listOf(Manifest.permission.RECORD_AUDIO)
        android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE -> listOf(Manifest.permission.CAMERA)
        else -> emptyList()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = false
        // 音量键默认调媒体流：WebView 里的语音条/TTS 都走媒体流播放，
        // 不设的话短音频没在播时按键调的是铃声，用户感觉"音量键无效、声音巨大"
        volumeControlStream = AudioManager.STREAM_MUSIC

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            userAgentString = "$userAgentString FloatShell/$VERSION"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)

        webView.addJavascriptInterface(ShellBridge(), "AndroidShell")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                val scheme = url.scheme ?: return false
                // 站内导航留在壳里；http(s) 外链和自定义协议（shortcuts:// 等）交给系统
                if (scheme == "http" || scheme == "https") {
                    if (url.host == Uri.parse(SITE_URL).host) return false
                    return runCatching {
                        startActivity(Intent(Intent.ACTION_VIEW, url)); true
                    }.getOrDefault(true)
                }
                return runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW, url)); true
                }.getOrDefault(true)
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                val supported = request.resources.filter { webResourcePermissions(it).isNotEmpty() }
                if (supported.isEmpty()) { request.deny(); return }
                val missing = supported.flatMap { webResourcePermissions(it) }
                    .distinct()
                    .filter { ContextCompat.checkSelfPermission(this@MainActivity, it) != PackageManager.PERMISSION_GRANTED }
                if (missing.isEmpty()) { request.grant(supported.toTypedArray()); return }
                if (pendingWebPermissionRequest != null) { request.deny(); return }
                pendingWebPermissionRequest = request
                webPermissionLauncher.launch(missing.toTypedArray())
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                filePathCallback?.onReceiveValue(emptyArray())
                filePathCallback = callback
                return runCatching {
                    fileChooserLauncher.launch(params.createIntent()); true
                }.getOrElse {
                    filePathCallback = null; false
                }
            }
        }

        // 备份导出等下载：交给系统下载管理器，落到公共下载目录
        // 备份导出等下载：http(s) 交给系统下载管理器；blob/data 由壳内 JS 桥读出后落盘
        webView.setDownloadListener(DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            runCatching {
                when {
                    url.startsWith("data:") -> handleDataUrlDownload(url, mimeType)
                    url.startsWith("blob:") -> startBlobDownload(url, mimeType, contentDisposition)
                    else -> {
                        val request = DownloadManager.Request(Uri.parse(url)).apply {
                            addRequestHeader("User-Agent", userAgent)
                            addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                            setDestinationInExternalPublicDir(
                                Environment.DIRECTORY_DOWNLOADS,
                                android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType),
                            )
                        }
                        (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                        Toast.makeText(this, "已开始下载到「下载」目录", Toast.LENGTH_SHORT).show()
                    }
                }
            }
        })

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
            }
        })

        // 冷启动带深链（如来电接听）直接加载目标；否则加载首页
        webView.loadUrl(consumeOpenUrl(intent) ?: SITE_URL)
        ensurePushService()
    }

    /** singleTask：App 已在运行时（如全屏来电页接听）通过 onNewIntent 送达深链 */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val target = consumeOpenUrl(intent) ?: return
        // SPA 已加载：loadUrl 到同页 hash 只触发 hashchange，不会整页重载
        webView.loadUrl(target)
    }

    /** blob: 下载——在页面上下文把 blob 读成 dataURL，经 AndroidShell 桥回传给壳落盘。 */
    private fun startBlobDownload(url: String, mimeType: String?, contentDisposition: String?) {
        val token = "dl_${blobTokenSeq.incrementAndGet()}_${System.currentTimeMillis()}"
        pendingBlobDownloads[token] = PendingBlobDownload(mimeType, contentDisposition)
        Toast.makeText(this, "正在导出…", Toast.LENGTH_SHORT).show()
        val tokenJs = JSONObject.quote(token)
        val urlJs = JSONObject.quote(url)
        val js = "(function(){try{fetch($urlJs).then(function(r){return r.blob();}).then(function(b){" +
            "var fr=new FileReader();fr.onload=function(){window.AndroidShell.receiveBlobDownload($tokenJs,String(fr.result));};" +
            "fr.onerror=function(){window.AndroidShell.receiveBlobDownload($tokenJs,'');};fr.readAsDataURL(b);})" +
            ".catch(function(){window.AndroidShell.receiveBlobDownload($tokenJs,'');});}" +
            "catch(e){window.AndroidShell.receiveBlobDownload($tokenJs,'');}})()"
        webView.evaluateJavascript(js, null)
    }

    /** data: 下载——壳内直接解码落盘，无需经过页面 JS。 */
    private fun handleDataUrlDownload(url: String, mimeType: String?) {
        Toast.makeText(this, "正在导出…", Toast.LENGTH_SHORT).show()
        ioExecutor.execute {
            runCatching {
                val comma = url.indexOf(',')
                require(comma >= 5) { "数据无效" }
                val head = url.substring(5, comma)
                val isBase64 = head.contains("base64", ignoreCase = true)
                val mime = head.substringBefore(';').trim().ifBlank { mimeType ?: "application/octet-stream" }
                val payload = url.substring(comma + 1)
                val bytes = if (isBase64) Base64.decode(payload, Base64.DEFAULT)
                else java.net.URLDecoder.decode(payload, "UTF-8").toByteArray()
                saveDownloadBytes(bytes, mime, makeDownloadFilename(mime, null))
            }.onFailure { toastOnMain("导出失败：${it.message}") }
        }
    }

    private fun makeDownloadFilename(mime: String, contentDisposition: String?): String {
        val fromDisposition = contentDisposition?.takeIf { it.isNotBlank() }
            ?.let { runCatching { android.webkit.URLUtil.guessFileName("https://download.local/file", it, mime) }.getOrNull() }
            ?.takeIf { it.isNotBlank() && !it.equals("downloadfile.bin", ignoreCase = true) }
        if (fromDisposition != null) return sanitizeFileName(fromDisposition)
        val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)?.let { ".$it" } ?: ".bin"
        val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val base = if (mime.startsWith("image/")) "小手机图片" else "小手机导出"
        return "${base}_$stamp$ext"
    }

    private fun sanitizeFileName(name: String): String =
        name.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim().take(120).ifBlank { "download" }

    /** 在 IO 线程调用：API 29+ 走 MediaStore（免权限），28 及以下图片进相册、其余文件写公共下载目录。 */
    @Suppress("DEPRECATION")
    private fun saveDownloadBytes(bytes: ByteArray, mime: String, filename: String) {
        val isImage = mime.startsWith("image/")
        if (Build.VERSION.SDK_INT >= 29) {
            val collection = if (isImage) MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            else MediaStore.Downloads.EXTERNAL_CONTENT_URI
            val relativePath = if (isImage) "${Environment.DIRECTORY_PICTURES}/$saveSubDir"
            else "${Environment.DIRECTORY_DOWNLOADS}/$saveSubDir"
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, filename)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = contentResolver.insert(collection, values) ?: error("MediaStore 拒绝写入")
            contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: error("无法写入文件")
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            contentResolver.update(uri, values, null, null)
            toastOnMain(if (isImage) "已保存到相册（图片/$saveSubDir）" else "已保存到「下载/$saveSubDir」")
            return
        }
        if (isImage) {
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, filename)
                put(MediaStore.Images.Media.MIME_TYPE, mime)
            }
            val uri = contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                ?: error("MediaStore 拒绝写入")
            contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: error("无法写入文件")
            toastOnMain("已保存到相册")
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
            == PackageManager.PERMISSION_GRANTED
        ) {
            writeLegacyPublicDownload(bytes, filename)
        } else {
            pendingLegacyFileSave = Pair(bytes, filename)
            runOnUiThread { storagePermissionLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE) }
        }
    }

    @Suppress("DEPRECATION")
    private fun writeLegacyPublicDownload(bytes: ByteArray, filename: String) {
        val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        dir.mkdirs()
        val file = File(dir, filename)
        file.writeBytes(bytes)
        MediaScannerConnection.scanFile(this, arrayOf(file.absolutePath), null, null)
        toastOnMain("已保存到「下载」目录")
    }

    private fun toastOnMain(text: String) {
        runOnUiThread { Toast.makeText(this, text, Toast.LENGTH_SHORT).show() }
    }

    private fun consumeOpenUrl(intent: Intent?): String? {
        val target = intent?.getStringExtra(EXTRA_OPEN_URL) ?: return null
        intent.removeExtra(EXTRA_OPEN_URL)
        return target.takeIf { it.startsWith(SITE_URL) }
    }

    private fun ensurePushService() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            PushService.start(this)
        }
    }

    override fun onDestroy() {
        CookieManager.getInstance().flush()
        ioExecutor.shutdown()
        webView.destroy()
        super.onDestroy()
    }

    /** 暴露给网页的原生桥（网页侧可用 window.AndroidShell 特性检测壳环境）。 */
    inner class ShellBridge {
        @JavascriptInterface
        fun getVersion(): String = VERSION

        /** 页面内 JS 把 blob 读成 dataURL 后回调到这里，由壳落盘（见 startBlobDownload）。 */
        @JavascriptInterface
        fun receiveBlobDownload(token: String, dataUrl: String) {
            val pending = pendingBlobDownloads.remove(token) ?: return
            if (dataUrl.isBlank()) {
                toastOnMain("导出失败：无法读取页面数据")
                return
            }
            ioExecutor.execute {
                runCatching {
                    val comma = dataUrl.indexOf(',')
                    require(comma > 5 && dataUrl.startsWith("data:")) { "数据无效" }
                    val head = dataUrl.substring(5, comma)
                    val mime = head.substringBefore(';').trim()
                        .ifBlank { pending.mimeHint ?: "application/octet-stream" }
                    val bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT)
                    saveDownloadBytes(bytes, mime, makeDownloadFilename(mime, pending.contentDisposition))
                }.onFailure { toastOnMain("导出失败：${it.message}") }
            }
        }

        /** 打开本应用的系统设置页（引导用户关电池限制、开自启动）。 */
        @JavascriptInterface
        fun openAppSettings() {
            runCatching {
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }

        /** 请求忽略电池优化（保活关键一步）。 */
        @SuppressLint("BatteryLife")
        @JavascriptInterface
        fun requestIgnoreBatteryOptimization() {
            runCatching {
                startActivity(
                    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }
    }
}
