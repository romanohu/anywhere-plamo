package app.plamo.ocr

import android.app.*
import android.content.Intent
import android.content.res.Configuration
import android.graphics.*
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.*
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.view.*
import android.widget.*
import app.tauri.annotation.InvokeArg
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import java.io.File
import java.util.UUID
import kotlin.math.*

@InvokeArg
class ScreenStartArgs { var target: String = "ja" }
@InvokeArg
class ScreenStopArgs { var error: String? = null }
@InvokeArg
class ScreenText {
    var text: String = ""
    var source: String = ""
    var x: Double = 0.0
    var y: Double = 0.0
    var width: Double = 0.0
    var height: Double = 0.0
}
@InvokeArg
class ScreenResultArgs {
    var revision: Int = 0
    var blocks: Array<ScreenText> = emptyArray()
    var message: String = ""
}

/** Display capture is held only while the visible, user-controlled lens is open. */
class ScreenLensService : Service() {
    companion object {
        @Volatile var instance: ScreenLensService? = null
            private set
        private var onStarted: ((String?) -> Unit)? = null
        fun start(activity: Activity, code: Int, data: Intent, target: String, callback: (String?) -> Unit) {
            onStarted = callback
            try {
                activity.startForegroundService(Intent(activity, ScreenLensService::class.java)
                    .putExtra("code", code).putExtra("data", data).putExtra("target", target))
            } catch (error: Exception) { onStarted = null; callback(error.message.orEmpty()) }
        }
    }

    private val ui = Handler(Looper.getMainLooper())
    private val imageThread = HandlerThread("ScreenLensCapture")
    private lateinit var images: Handler
    private lateinit var windows: WindowManager
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var latest: Image? = null // imageThread owns images and pixel processing.
    private var frameNumber = 0L
    private var lastPixels: IntArray? = null
    private var previousFile: File? = null
    @Volatile private var pending: Invoke? = null
    @Volatile private var stopped = false
    private var revision = 1
    private var automatic = true
    private var refresh = true
    private var original = false
    private var reading = false
    private var dragging = false
    private var appVisible = false
    private var target = "ja"
    private var screenWidth = 1
    private var screenHeight = 1
    private lateinit var bar: LinearLayout
    private lateinit var footer: LinearLayout
    private lateinit var region: FrameLayout
    private lateinit var overlay: LensDrawing
    private lateinit var transcript: ScrollView
    private lateinit var status: TextView
    private lateinit var readButton: TextView
    private lateinit var barParams: WindowManager.LayoutParams
    private lateinit var regionParams: WindowManager.LayoutParams
    private lateinit var footerParams: WindowManager.LayoutParams
    private val languages = linkedMapOf("ja" to "日本語", "en" to "English", "ko" to "한국어", "zh-hans" to "简体中文", "fr" to "Français", "de" to "Deutsch", "es" to "Español")
    private fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()

    override fun onBind(intent: Intent?) = null
    override fun onCreate() {
        super.onCreate()
        windows = getSystemService(WindowManager::class.java)
        imageThread.start(); images = Handler(imageThread.looper)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "stop" || intent == null) { stopSelf(); return START_NOT_STICKY }
        if (projection != null) return START_NOT_STICKY
        try {
            target = intent.getStringExtra("target").takeIf { languages.containsKey(it) } ?: "ja"
            val notifications = getSystemService(NotificationManager::class.java)
            notifications.createNotificationChannel(NotificationChannel("screen-lens", "画面OCRレンズ", NotificationManager.IMPORTANCE_LOW))
            val stop = PendingIntent.getService(this, 1, Intent(this, ScreenLensService::class.java).setAction("stop"), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val notification = Notification.Builder(this, "screen-lens").setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentTitle("画面OCRレンズ").setContentText("枠内の文字を端末上で翻訳しています")
                .setOngoing(true).addAction(Notification.Action.Builder(null, "レンズを閉じる", stop).build()).build()
            if (Build.VERSION.SDK_INT >= 29) startForeground(21, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
            else startForeground(21, notification)
            @Suppress("DEPRECATION") val data = intent.getParcelableExtra<Intent>("data") ?: error("画面共有の許可を取得できません。")
            projection = getSystemService(MediaProjectionManager::class.java).getMediaProjection(intent.getIntExtra("code", Activity.RESULT_CANCELED), data)
            projection!!.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() { stopSelf() }
                override fun onCapturedContentResize(width: Int, height: Int) {
                    if (width != screenWidth || height != screenHeight) {
                        // A display-coordinate lens cannot safely map a cropped app surface.
                        screenWidth = width; screenHeight = height
                        resizeCapture(); fitWindows(); invalidateScene()
                    }
                }
            }, ui)
            dimensions()
            showWindows()
            resizeCapture()
            instance = this
            onStarted?.invoke(null); onStarted = null
        } catch (error: Exception) {
            onStarted?.invoke("画面レンズを開始できません。${error.message.orEmpty()}"); onStarted = null
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun dimensions() {
        if (Build.VERSION.SDK_INT >= 30) {
            val bounds = windows.maximumWindowMetrics.bounds
            screenWidth = bounds.width(); screenHeight = bounds.height()
        } else {
            val metrics = android.util.DisplayMetrics()
            @Suppress("DEPRECATION") windows.defaultDisplay.getRealMetrics(metrics)
            screenWidth = metrics.widthPixels; screenHeight = metrics.heightPixels
        }
    }

    private fun params(width: Int, height: Int): WindowManager.LayoutParams = WindowManager.LayoutParams(width, height,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
        PixelFormat.TRANSLUCENT).apply {
        gravity = Gravity.TOP or Gravity.LEFT
        if (Build.VERSION.SDK_INT >= 30) setFitInsetsTypes(0)
    }

    private fun button(label: String, action: (TextView) -> Unit): TextView = TextView(this).apply {
        text = label; contentDescription = label; textSize = 12f; setTextColor(Color.WHITE)
        gravity = Gravity.CENTER; setPadding(dp(6), 0, dp(6), 0)
        isClickable = true; setOnClickListener { action(this) }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(40))
    }

    private fun showWindows() {
        bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setBackgroundColor(0xee191919.toInt()) }
        val handle = button("⠿") {}; handle.contentDescription = "レンズを移動"
        bar.addView(handle); handle.setOnTouchListener(drag(false))
        bar.addView(button(languages[target]!!) { view ->
            val menu = PopupMenu(this, view)
            languages.entries.forEachIndexed { i, entry -> menu.menu.add(0, i, i, entry.value) }
            menu.setOnMenuItemClickListener { item -> target = languages.keys.elementAt(item.itemId); view.text = languages[target]; invalidateScene(); true }
            menu.show()
        })
        bar.addView(button("自動") { view -> automatic = !automatic; view.alpha = if (automatic) 1f else .45f; revision++; status.text = if (automatic) "自動更新中" else "停止中" })
        bar.addView(button("更新") { refresh = true; invalidateScene() })
        readButton = button("訳文") { reading = !reading; updateVisibility() }.apply { isEnabled = false; alpha = .45f }
        bar.addView(readButton)
        bar.addView(button("×") { stopSelf() }.apply { contentDescription = "レンズを閉じる" }, LinearLayout.LayoutParams(0, dp(40), 1f))
        region = FrameLayout(this)
        overlay = LensDrawing(); region.addView(overlay, FrameLayout.LayoutParams(-1, -1))
        transcript = ScrollView(this).apply { setBackgroundColor(0xf51b1b1b.toInt()); visibility = View.GONE }
        region.addView(transcript, FrameLayout.LayoutParams(-1, -1))
        footer = LinearLayout(this).apply { setBackgroundColor(0xe6191919.toInt()); gravity = Gravity.CENTER_VERTICAL }
        status = TextView(this).apply { text = "枠を文字に合わせてください"; textSize = 10f; setTextColor(Color.LTGRAY); maxLines = 1; setPadding(dp(6), 0, 0, 0) }
        footer.addView(status, LinearLayout.LayoutParams(0, dp(28), 1f))
        footer.addView(button("原文") { view -> original = !original; view.text = if (original) "訳文" else "原文"; updateVisibility() }.apply { layoutParams.height = dp(28) })
        val resize = button("↘") {}; resize.contentDescription = "レンズの範囲を変更"; resize.layoutParams.height = dp(28)
        footer.addView(resize); resize.setOnTouchListener(drag(true))
        barParams = params(screenWidth - dp(24), dp(40)).apply { x = dp(12); y = max(dp(40), screenHeight / 5) }
        regionParams = params(barParams.width, min(dp(360), screenHeight / 2)).apply {
            flags = flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
            // Android 12+ allows touches through an untrusted overlay only below
            // the obscuring-opacity limit. Controls are separate, non-overlapping windows.
            alpha = .75f
        }
        footerParams = params(barParams.width, dp(28))
        fitWindows(false)
        windows.addView(region, regionParams); windows.addView(bar, barParams); windows.addView(footer, footerParams)
    }

    private fun fitWindows(update: Boolean = true) {
        if (!::barParams.isInitialized) return
        barParams.width = barParams.width.coerceIn(min(dp(260), screenWidth), screenWidth)
        regionParams.height = regionParams.height.coerceIn(min(dp(80), screenHeight), max(dp(80), screenHeight - dp(112)))
        barParams.x = barParams.x.coerceIn(0, max(0, screenWidth - barParams.width))
        barParams.y = barParams.y.coerceIn(dp(28), max(dp(28), screenHeight - regionParams.height - dp(100)))
        regionParams.x = barParams.x; regionParams.y = barParams.y + barParams.height; regionParams.width = barParams.width
        footerParams.x = barParams.x; footerParams.y = regionParams.y + regionParams.height; footerParams.width = barParams.width
        if (update) { windows.updateViewLayout(bar, barParams); windows.updateViewLayout(region, regionParams); windows.updateViewLayout(footer, footerParams) }
    }

    private fun drag(resize: Boolean): View.OnTouchListener {
        var x = 0f; var y = 0f; var left = 0; var top = 0; var width = 0; var height = 0
        return View.OnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    x = event.rawX; y = event.rawY; left = barParams.x; top = barParams.y; width = barParams.width; height = regionParams.height
                    dragging = true; invalidateScene()
                }
                MotionEvent.ACTION_MOVE -> {
                    if (resize) { barParams.width = width + (event.rawX - x).toInt(); regionParams.height = height + (event.rawY - y).toInt() }
                    else { barParams.x = left + (event.rawX - x).toInt(); barParams.y = top + (event.rawY - y).toInt() }
                    fitWindows()
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { dragging = false; invalidateScene() }
            }
            true
        }
    }

    private fun invalidateScene() {
        revision++; refresh = true
        overlay.blocks = emptyArray(); overlay.invalidate()
        readButton.isEnabled = false; readButton.alpha = .45f
        transcript.removeAllViews(); reading = false; updateVisibility()
        images.post { lastPixels = null }
    }

    private fun updateVisibility() {
        if (!::region.isInitialized) return
        transcript.visibility = if (reading && !original) View.VISIBLE else View.GONE
        overlay.visibility = if (original || reading) View.INVISIBLE else View.VISIBLE
        regionParams.flags = if (reading && !original) regionParams.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
            else regionParams.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        regionParams.alpha = if (reading && !original) 1f else .75f
        windows.updateViewLayout(region, regionParams)
    }

    private fun resizeCapture() {
        val old = reader
        old?.setOnImageAvailableListener(null, null)
        val next = ImageReader.newInstance(screenWidth, screenHeight, PixelFormat.RGBA_8888, 3)
        reader = next
        images.post { latest?.close(); latest = null; old?.close(); lastPixels = null }
        next.setOnImageAvailableListener({ source ->
            try {
                val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
                latest?.close(); latest = image; frameNumber++
            } catch (_: IllegalStateException) { /* Reader was replaced during rotation. */ }
        }, images)
        if (display == null) display = projection!!.createVirtualDisplay("Anywhere Plamo OCR lens", screenWidth, screenHeight,
            resources.configuration.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, next.surface, null, images)
        else { display!!.resize(screenWidth, screenHeight, resources.configuration.densityDpi); display!!.surface = next.surface }
    }

    fun state(): JSObject = JSObject().put("stopped", stopped).put("revision", revision).put("target", target)

    fun appVisible(visible: Boolean) {
        if (appVisible == visible) return
        appVisible = visible
        listOf(bar, region, footer).forEach { it.visibility = if (visible) View.GONE else View.VISIBLE }
        invalidateScene()
    }

    fun capture(invoke: Invoke) {
        if (stopped) { invoke.resolve(JSObject().put("stopped", true)); return }
        if (pending != null) { invoke.reject("画面を取得中です。"); return }
        if (appVisible || dragging || reading || (!automatic && !refresh)) { invoke.resolve(state().put("unchanged", true)); return }
        pending = invoke
        readButton.isEnabled = false
        val version = revision; val language = target; val force = refresh; refresh = false
        val location = IntArray(2); region.getLocationOnScreen(location)
        val bounds = Rect(location[0], location[1], location[0] + region.width, location[1] + region.height)
        val hadText = overlay.blocks.isNotEmpty() && !original
        overlay.alpha = 0f
        // Hide translated pixels before sampling so the lens never reads itself.
        images.post {
            val before = frameNumber
            fun sample(attempt: Int) {
                if (pending !== invoke) return
                if (latest == null || (hadText && frameNumber <= before)) {
                    if (attempt < 15) { images.postDelayed({ sample(attempt + 1) }, 100); return }
                    ui.post { complete(invoke, state().put("unchanged", true)); status.text = "画面を動かして「更新」" }
                    return
                }
                val image = latest!!
                val padded = Bitmap.createBitmap(image.planes[0].rowStride / image.planes[0].pixelStride, image.height, Bitmap.Config.ARGB_8888)
                val allocated = mutableSetOf(padded)
                try {
                    padded.copyPixelsFromBuffer(image.planes[0].buffer.apply { rewind() })
                    val left = (bounds.left.toDouble() * image.width / screenWidth).roundToInt().coerceIn(0, image.width - 1)
                    val top = (bounds.top.toDouble() * image.height / screenHeight).roundToInt().coerceIn(0, image.height - 1)
                    val width = (bounds.width().toDouble() * image.width / screenWidth).roundToInt().coerceIn(1, image.width - left)
                    val height = (bounds.height().toDouble() * image.height / screenHeight).roundToInt().coerceIn(1, image.height - top)
                    val crop = Bitmap.createBitmap(padded, left, top, width, height).also { allocated.add(it) }
                    val tiny = Bitmap.createScaledBitmap(crop, 64, 48, true).also { allocated.add(it) }
                    val pixels = IntArray(64 * 48); tiny.getPixels(pixels, 0, 64, 0, 0, 64, 48)
                    val oldPixels = lastPixels
                    val difference = oldPixels?.let { old -> pixels.indices.sumOf { i ->
                        abs(Color.red(pixels[i]) - Color.red(old[i])) + abs(Color.green(pixels[i]) - Color.green(old[i])) + abs(Color.blue(pixels[i]) - Color.blue(old[i]))
                    }.toDouble() / (pixels.size * 3) } ?: 255.0
                    if (!force && difference < 2.5) {
                        ui.post { complete(invoke, state().put("revision", version).put("unchanged", true)) }
                    } else {
                        lastPixels = pixels
                        val scale = min(1.0, 1600.0 / max(width, height))
                        val capture = Bitmap.createScaledBitmap(crop, max(1, (width * scale).roundToInt()), max(1, (height * scale).roundToInt()), true).also { allocated.add(it) }
                        val directory = File(cacheDir, "screen-lens").apply { mkdirs() }
                        val file = File(directory, "${UUID.randomUUID()}.png")
                        file.outputStream().use { capture.compress(Bitmap.CompressFormat.PNG, 100, it) }
                        previousFile?.delete(); previousFile = file
                        ui.post {
                            if (version == revision) { overlay.blocks = emptyArray(); overlay.invalidate(); status.text = "文字を読み取り中…" }
                            complete(invoke, JSObject().put("revision", version).put("target", language).put("path", file.absolutePath))
                        }
                    }
                } catch (error: Exception) {
                    ui.post { if (pending === invoke) { pending = null; overlay.alpha = 1f; invoke.reject("画面を取得できません。${error.message.orEmpty()}") } }
                } finally { allocated.forEach { it.recycle() } }
            }
            images.postDelayed({ sample(0) }, 120)
        }
    }

    private fun complete(invoke: Invoke, result: JSObject) {
        if (pending !== invoke) return
        pending = null; overlay.alpha = 1f
        readButton.isEnabled = overlay.blocks.isNotEmpty()
        readButton.alpha = if (readButton.isEnabled) 1f else .45f
        invoke.resolve(if (stopped) JSObject().put("stopped", true) else result)
    }

    fun result(args: ScreenResultArgs) {
        if (stopped || args.revision != revision || dragging) return
        overlay.blocks = args.blocks; overlay.invalidate(); status.text = if (args.message == "自動更新中" && !automatic) "翻訳完了" else args.message
        readButton.isEnabled = args.blocks.isNotEmpty(); readButton.alpha = if (readButton.isEnabled) 1f else .45f
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), dp(8), dp(12), dp(8)) }
        args.blocks.forEachIndexed { index, block ->
            list.addView(TextView(this).apply { text = "${index + 1}. ${block.text}"; textSize = 14f; setTextColor(Color.WHITE); setPadding(0, dp(6), 0, dp(6)) })
        }
        transcript.removeAllViews(); transcript.addView(list)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (projection != null) { dimensions(); resizeCapture(); fitWindows(); invalidateScene() }
    }

    override fun onDestroy() {
        stopped = true; if (instance === this) instance = null
        pending?.resolve(JSObject().put("stopped", true)); pending = null
        if (::bar.isInitialized) listOf(bar, region, footer).forEach { view -> try { windows.removeView(view) } catch (_: IllegalArgumentException) {} }
        display?.release(); display = null
        projection?.stop(); projection = null
        images.post { latest?.close(); latest = null; reader?.close(); previousFile?.delete(); File(cacheDir, "screen-lens").deleteRecursively() }
        imageThread.quitSafely()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    private inner class LensDrawing : View(this@ScreenLensService) {
        var blocks: Array<ScreenText> = emptyArray()
        private val paint = TextPaint(Paint.ANTI_ALIAS_FLAG)
        override fun onDraw(canvas: Canvas) {
            paint.color = 0x99ffffff.toInt(); paint.style = Paint.Style.STROKE; paint.strokeWidth = dp(1).toFloat()
            canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint); paint.style = Paint.Style.FILL
            val occupied = mutableListOf<RectF>()
            blocks.forEachIndexed { index, block ->
                val left = (block.x * width).toFloat().coerceIn(0f, max(0f, width - 1f))
                val top = (block.y * height).toFloat().coerceIn(0f, max(0f, height - 1f))
                val box = RectF(left, top, min(width.toFloat(), left + (block.width * width).toFloat()), min(height.toFloat(), top + (block.height * height).toFloat()))
                if (box.width() <= 0 || box.height() <= 0 || block.text.isBlank()) return@forEachIndexed
                var font = dp(16).toFloat()
                fun textLayout(): StaticLayout {
                    paint.textSize = font; paint.color = Color.WHITE
                    return StaticLayout.Builder.obtain(block.text, 0, block.text.length, paint, max(1, box.width().toInt() - dp(6)))
                        .setAlignment(Layout.Alignment.ALIGN_NORMAL).setIncludePad(false).setLineSpacing(0f, 1.2f).build()
                }
                var text = textLayout()
                while (font > dp(10) && text.height + dp(4) > box.height()) { font -= dp(1); text = textLayout() }
                if (text.height + dp(4) > box.height() || occupied.any { RectF.intersects(it, box) }) {
                    val size = dp(22).toFloat()
                    box.set(left.coerceAtMost(max(0f, width - size)), top.coerceAtMost(max(0f, height - size)), 0f, 0f)
                    box.right = box.left + size; box.bottom = box.top + size
                    if (occupied.any { RectF.intersects(it, box) }) {
                        var free: RectF? = null
                        var y = 0f
                        while (y + size <= height && free == null) {
                            var x = 0f
                            while (x + size <= width) {
                                val candidate = RectF(x, y, x + size, y + size)
                                if (occupied.none { RectF.intersects(it, candidate) }) { free = candidate; break }
                                x += size + dp(3)
                            }
                            y += size + dp(3)
                        }
                        if (free == null) return@forEachIndexed
                        box.set(free)
                    }
                    paint.color = 0xf51b1b1b.toInt(); canvas.drawRoundRect(box, size / 2, size / 2, paint)
                    paint.color = Color.WHITE; paint.textSize = dp(11).toFloat()
                    val label = (index + 1).toString()
                    canvas.drawText(label, box.centerX() - paint.measureText(label) / 2, box.centerY() - (paint.ascent() + paint.descent()) / 2, paint)
                } else {
                    box.bottom = box.top + text.height + dp(4)
                    paint.color = 0xec1b1b1b.toInt(); canvas.drawRoundRect(box, dp(3).toFloat(), dp(3).toFloat(), paint)
                    paint.color = Color.WHITE; paint.textSize = font
                    canvas.save(); canvas.clipRect(box); canvas.translate(box.left + dp(3), box.top + dp(2)); text.draw(canvas); canvas.restore()
                }
                occupied.add(box)
            }
        }
    }
}
