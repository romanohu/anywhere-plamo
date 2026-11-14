package app.plamo.ocr

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Matrix
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.opencv.core.*
import org.opencv.imgproc.Imgproc
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

@RunWith(AndroidJUnit4::class)
class PaddleOcrTest {
    @Test
    fun localBoxScoresMatchFullFrameIncludingClippedPolygons() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        PaddleOcr(context.assets, AtomicBoolean(false)).use { ocr ->
            val score = PaddleOcr::class.java.getDeclaredMethod("boxScore", Mat::class.java, Mat::class.java, MatOfPoint::class.java)
                .apply { isAccessible = true }
            val probabilities = Mat(120, 160, CvType.CV_32F)
            val mask = Mat(120, 160, CvType.CV_8U)
            try {
                probabilities.put(0, 0, FloatArray(120 * 160) { (it * 17 % 1024) / 1024f })
                for (x in listOf(-12.0, 0.0, 42.0, 159.0, 175.0)) {
                    for (angle in listOf(-35.0, 0.0, 70.0)) {
                        val corners = Array(4) { Point() }
                        RotatedRect(Point(x, 55.0), Size(44.0, 18.0), angle).points(corners)
                        val polygon = MatOfPoint(*corners)
                        try {
                            mask.setTo(Scalar(0.0))
                            Imgproc.fillPoly(mask, listOf(polygon), Scalar(1.0))
                            val expected = Core.mean(probabilities, mask).`val`[0]
                            mask.setTo(Scalar(255.0))
                            assertEquals("x=$x angle=$angle", expected, score.invoke(ocr, probabilities, mask, polygon) as Double, 1e-9)
                        } finally { polygon.release() }
                    }
                }
            } finally { probabilities.release(); mask.release() }
        }
    }

    @Test
    fun sidewaysEnglishInBothDirections() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val capture = File(context.cacheDir, "ocr-rotation-test.png")
        val bitmap = Bitmap.createBitmap(360, 130, Bitmap.Config.ARGB_8888)
        try {
            Canvas(bitmap).apply {
                drawColor(Color.WHITE)
                val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK; textSize = 27f }
                drawText("Hello world", 20f, 48f, paint)
                drawText("Good morning", 20f, 90f, paint)
            }
            PaddleOcr(context.assets, AtomicBoolean(false)).use { ocr ->
                for (degrees in listOf(90f, 270f)) {
                    val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { postRotate(degrees) }, true)
                    try { capture.outputStream().use { rotated.compress(Bitmap.CompressFormat.PNG, 100, it) } }
                    finally { rotated.recycle() }
                    val blocks = ocr.recognize(capture.path, null)
                    val text = blocks.joinToString(" ") { it.getString("text") }
                    assertTrue("$degrees: $text", text.contains("Hello world", ignoreCase = true))
                    assertTrue("$degrees: $text", text.contains("Good morning", ignoreCase = true))
                    blocks.forEach { block ->
                        assertEquals(degrees.toInt(), block.getInt("rotation"))
                        assertTrue(block.getDouble("x") >= 0 && block.getDouble("y") >= 0)
                        assertTrue(block.getDouble("x") + block.getDouble("width") <= 1.001)
                        assertTrue(block.getDouble("y") + block.getDouble("height") <= 1.001)
                    }
                }
            }
        } finally { bitmap.recycle(); capture.delete() }
    }

    @Test
    fun offlineEnglishJapaneseAndCancellation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val cancelled = AtomicBoolean(false)
        val capture = File(context.cacheDir, "ocr-test.png")
        val bitmap = Bitmap.createBitmap(640, 240, Bitmap.Config.ARGB_8888)
        try {
            Canvas(bitmap).apply {
                drawColor(Color.WHITE)
                val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK; textSize = 36f }
                drawText("Hello world", 30f, 75f, paint)
                drawText("今日は晴れです", 30f, 190f, paint)
            }
            capture.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            PaddleOcr(context.assets, cancelled).use { ocr ->
                val blocks = ocr.recognize(capture.path, null)
                val text = blocks.joinToString("\n") { it.getString("text") }
                assertTrue(text, text.contains("Hello world", ignoreCase = true))
                assertTrue(text, text.contains("今日は晴れです"))
                assertEquals(2, blocks.size)
                blocks.forEach { block ->
                    assertTrue(block.getDouble("x") in 0.0..1.0)
                    assertTrue(block.getDouble("y") in 0.0..1.0)
                    assertTrue(block.getDouble("width") > 0)
                    assertTrue(block.getDouble("height") > 0)
                }
                cancelled.set(true)
                try { ocr.recognize(capture.path, null); fail("Cancelled OCR must stop") }
                catch (error: IllegalStateException) { assertEquals("CANCELLED", error.message) }
            }
        } finally { bitmap.recycle(); capture.delete() }
    }
}
