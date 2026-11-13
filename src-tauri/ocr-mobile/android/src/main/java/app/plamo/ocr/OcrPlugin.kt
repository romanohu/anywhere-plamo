package app.plamo.ocr

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.ActivityCallback
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
    private var startingScreen = false

    override fun onResume(activity: AppCompatActivity) { ScreenLensService.instance?.appVisible(true) }
    override fun onPause(activity: AppCompatActivity) { ScreenLensService.instance?.appVisible(false) }

    @Command
    fun startScreen(invoke: Invoke) {
        if (ScreenLensService.instance != null) { activity.moveTaskToBack(true); invoke.resolve(); return }
        if (startingScreen) { invoke.reject("レンズを準備中です。"); return }
        startingScreen = true
        try {
            if (!Settings.canDrawOverlays(activity)) {
                startActivityForResult(invoke, Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:${activity.packageName}")), "overlayPermission")
            } else requestProjection(invoke)
        } catch (error: Exception) { startingScreen = false; invoke.reject(error.message.orEmpty()) }
    }

    @ActivityCallback
    private fun overlayPermission(invoke: Invoke, result: ActivityResult) {
        if (!Settings.canDrawOverlays(activity)) {
            startingScreen = false; invoke.reject("画面レンズには「他のアプリの上に重ねて表示」の許可が必要です。")
        } else requestProjection(invoke)
    }

    private fun requestProjection(invoke: Invoke) {
        try {
            val manager = activity.getSystemService(MediaProjectionManager::class.java)
            // The movable lens uses display coordinates, so request the display
            // rather than an app surface with unrelated cropping/letterboxing.
            val intent = if (Build.VERSION.SDK_INT >= 34) manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
                else manager.createScreenCaptureIntent()
            startActivityForResult(invoke, intent, "screenPermission")
        } catch (error: Exception) { startingScreen = false; invoke.reject(error.message.orEmpty()) }
    }

    @ActivityCallback
    private fun screenPermission(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK || result.data == null) {
            startingScreen = false; invoke.reject("画面共有をキャンセルしました。"); return
        }
        val args = invoke.parseArgs(ScreenStartArgs::class.java)
        ScreenLensService.start(activity, result.resultCode, result.data!!, args.target) { error ->
            startingScreen = false
            if (error != null) invoke.reject(error) else {
                invoke.resolve()
                activity.moveTaskToBack(true)
            }
        }
    }

    @Command
    fun resumeScreen(invoke: Invoke) {
        if (ScreenLensService.instance == null) { invoke.reject("レンズを終了中です。もう一度開いてください。"); return }
        activity.moveTaskToBack(true)
        invoke.resolve()
    }

    @Command
    fun screenFrame(invoke: Invoke) = activity.runOnUiThread {
        ScreenLensService.instance?.capture(invoke) ?: invoke.resolve(JSObject().put("stopped", true))
    }

    @Command
    fun screenState(invoke: Invoke) = activity.runOnUiThread {
        invoke.resolve(ScreenLensService.instance?.state() ?: JSObject().put("stopped", true))
    }

    @Command
    fun screenResult(invoke: Invoke) = activity.runOnUiThread {
        ScreenLensService.instance?.result(invoke.parseArgs(ScreenResultArgs::class.java))
        invoke.resolve()
    }

    @Command
    fun stopScreen(invoke: Invoke) = activity.runOnUiThread {
        ScreenLensService.instance?.stopSelf()
        invoke.parseArgs(ScreenStopArgs::class.java).error?.let {
            android.widget.Toast.makeText(activity, it, android.widget.Toast.LENGTH_LONG).show()
        }
        invoke.resolve()
    }

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
