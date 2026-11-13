package app.plamo.ocr

import android.app.Activity
import android.content.Intent
import android.net.Uri
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@InvokeArg
class ReadArgs {
    lateinit var path: String
    var korean: String? = null
}

@TauriPlugin
class OcrPlugin(private val activity: Activity) : Plugin(activity) {
    private val worker = Executors.newSingleThreadExecutor()
    private val cancelled = AtomicBoolean(false)
    @Volatile private var ocr: PaddleOcr? = null

    @Command
    fun recognize(invoke: Invoke) {
        val args = invoke.parseArgs(ReadArgs::class.java)
        // Only private captures created by Rust; never interpret a URL or arbitrary file.
        if (!File(args.path).canonicalPath.startsWith(activity.cacheDir.canonicalPath + File.separator)) {
            invoke.reject("撮影画像の保存先が無効です。")
            return
        }
        cancelled.set(false)
        worker.execute {
            try {
                if (cancelled.get()) error("CANCELLED")
                val engine = ocr ?: PaddleOcr(activity.assets, cancelled).also { ocr = it }
                val blocks = engine.recognize(args.path, args.korean)
                if (cancelled.get()) error("CANCELLED")
                invoke.resolve(JSObject().put("blocks", JSONArray(blocks)))
            } catch (error: Exception) {
                invoke.reject(if (cancelled.get()) "CANCELLED" else "文字を読み取れませんでした。${error.message.orEmpty()}")
            }
        }
    }

    @Command
    fun cancel(invoke: Invoke) {
        cancelled.set(true)
        ocr?.cancel()
        invoke.resolve()
    }

    @Command
    fun release(invoke: Invoke) {
        worker.execute {
            ocr?.close()
            ocr = null
            invoke.resolve()
        }
    }

    @Command
    fun openLicense(invoke: Invoke) {
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://plamo.preferredai.jp/info/plamo-community-license-ja")))
            invoke.resolve()
        } catch (_: Exception) { invoke.reject("ブラウザを開けませんでした。") }
    }
}
