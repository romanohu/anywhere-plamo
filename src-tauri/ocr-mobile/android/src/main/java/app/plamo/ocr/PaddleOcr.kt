// Detection, normalization and CTC decoding follow PaddleOCR / RapidOCR (Apache-2.0).
// Layout grouping follows this application's desktop OCR worker. See ../../../NOTICE.
package app.plamo.ocr

import android.content.res.AssetManager
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import org.opencv.android.OpenCVLoader
import org.opencv.core.*
import org.opencv.imgcodecs.Imgcodecs
import org.opencv.imgproc.Imgproc
import org.json.JSONObject
import java.nio.FloatBuffer
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.*

private data class Box(val x: Double, val y: Double, val right: Double, val bottom: Double) {
    val width get() = right - x
    val height get() = bottom - y
    fun json(w: Int, h: Int) = JSONObject().put("x", x / w).put("y", y / h)
        .put("width", width / w).put("height", height / h)
}
private data class Line(val text: String, val box: Box, val size: Double, val vertical: Boolean)
private data class Recognizer(val session: OrtSession, val characters: List<String>) : AutoCloseable {
    override fun close() = session.close()
}

class PaddleOcr(private val assets: AssetManager, private val cancelled: AtomicBoolean) : AutoCloseable {
    private val environment = OrtEnvironment.getEnvironment().also { it.setTelemetry(false) }
    private var detector: OrtSession? = null
    private var recognizer: Recognizer? = null
    private var korean: Recognizer? = null
    private var koreanPath: String? = null
    @Volatile private var running: OrtSession.RunOptions? = null

    init {
        check(OpenCVLoader.initLocal()) { "画像処理エンジンを起動できません。" }
        Core.setNumThreads(2)
    }

    private fun checkCancelled() { if (cancelled.get()) error("CANCELLED") }
    fun cancel() { running?.setTerminate(true) }
    override fun close() {
        detector?.close(); recognizer?.close(); korean?.close()
        detector = null; recognizer = null; korean = null; koreanPath = null
    }

    private fun session(bytes: ByteArray): OrtSession = OrtSession.SessionOptions().use { options ->
        options.setIntraOpNumThreads(2)
        options.setInterOpNumThreads(1)
        options.setCPUArenaAllocator(false)
        environment.createSession(bytes, options)
    }
    private fun recognizer(bytes: ByteArray): Recognizer {
        val session = session(bytes)
        try {
            val dictionary = session.metadata.customMetadata["character"] ?: error("OCR辞書がありません。")
            return Recognizer(session, listOf("") + dictionary.trimEnd('\r', '\n').lines() + listOf(" "))
        } catch (error: Exception) { session.close(); throw error }
    }

    private fun tensor(image: Mat, width: Int, height: Int, paddedWidth: Int = width): OnnxTensor {
        val resized = Mat()
        try {
            Imgproc.resize(image, resized, Size(width.toDouble(), height.toDouble()))
            val bytes = ByteArray(width * height * 3)
            resized.get(0, 0, bytes)
            val values = FloatArray(3 * height * paddedWidth)
            for (y in 0 until height) for (x in 0 until width) for (c in 0..2) {
                values[c * height * paddedWidth + y * paddedWidth + x] = (bytes[(y * width + x) * 3 + c].toInt().and(255) / 255f - .5f) / .5f
            }
            return OnnxTensor.createTensor(environment, FloatBuffer.wrap(values), longArrayOf(1, 3, height.toLong(), paddedWidth.toLong()))
        } finally { resized.release() }
    }

    private fun run(session: OrtSession, input: OnnxTensor): Pair<FloatArray, LongArray> {
        checkCancelled()
        OrtSession.RunOptions().use { options ->
            running = options
            try {
                checkCancelled()
                session.run(mapOf(session.inputNames.first() to input), options).use { result ->
                    val output = result[0] as OnnxTensor
                    val buffer = output.floatBuffer
                    val values = FloatArray(buffer.remaining())
                    buffer.get(values)
                    return Pair(values, output.info.shape)
                }
            } finally { running = null }
        }
    }

    private fun corners(rect: RotatedRect): Array<Point> {
        val points = Array(4) { Point() }
        rect.points(points)
        val sorted = points.sortedBy { it.x }
        val left = sorted.take(2).sortedBy { it.y }
        val right = sorted.drop(2).sortedBy { it.y }
        return arrayOf(left[0], right[0], right[1], left[1])
    }

    private fun detect(image: Mat): List<Array<Point>> {
        val ratio = min(1.0, 1280.0 / max(image.cols(), image.rows()))
        val width = max(32, (image.cols() * ratio / 32).roundToInt() * 32)
        val height = max(32, (image.rows() * ratio / 32).roundToInt() * 32)
        val (values, shape) = tensor(image, width, height).use { run(detector!!, it) }
        val h = shape[2].toInt(); val w = shape[3].toInt()
        val probabilities = Mat(h, w, CvType.CV_32F)
        val mask = Mat(h, w, CvType.CV_8U)
        val hierarchy = Mat()
        val contours = mutableListOf<MatOfPoint>()
        val kernel = Mat.ones(2, 2, CvType.CV_8U)
        val results = mutableListOf<Array<Point>>()
        try {
            probabilities.put(0, 0, values)
            mask.put(0, 0, ByteArray(values.size) { if (values[it] > .3f) 255.toByte() else 0 })
            Imgproc.dilate(mask, mask, kernel)
            Imgproc.findContours(mask, contours, hierarchy, Imgproc.RETR_LIST, Imgproc.CHAIN_APPROX_SIMPLE)
            for (contour in contours.take(1000)) {
                checkCancelled()
                val floating = MatOfPoint2f(*contour.toArray())
                val rect = try { Imgproc.minAreaRect(floating) } finally { floating.release() }
                if (min(rect.size.width, rect.size.height) < 3) continue
                val polygon = MatOfPoint(*corners(rect))
                mask.setTo(Scalar(0.0))
                try { Imgproc.fillPoly(mask, listOf(polygon), Scalar(1.0)) } finally { polygon.release() }
                if (Core.mean(probabilities, mask).`val`[0] < .5) continue
                // DB unclip: the minimum enclosing rectangle of a rounded rectangle
                // offset expands each dimension by twice area * 1.6 / perimeter.
                val distance = rect.size.width * rect.size.height * 1.6 / (2 * (rect.size.width + rect.size.height))
                rect.size.width += 2 * distance; rect.size.height += 2 * distance
                if (min(rect.size.width, rect.size.height) < 5) continue
                results.add(corners(rect).map { p -> Point(
                    (p.x / w * image.cols()).roundToInt().coerceIn(0, image.cols() - 1).toDouble(),
                    (p.y / h * image.rows()).roundToInt().coerceIn(0, image.rows() - 1).toDouble()) }.toTypedArray())
            }
        } finally {
            probabilities.release(); mask.release(); hierarchy.release(); kernel.release(); contours.forEach { it.release() }
        }
        return results.sortedWith(compareBy({ it[0].y }, { it[0].x }))
    }

    private fun crop(image: Mat, points: Array<Point>): Mat {
        fun distance(a: Point, b: Point) = hypot(a.x - b.x, a.y - b.y)
        val width = max(distance(points[0], points[1]), distance(points[2], points[3])).toInt().coerceAtLeast(1)
        val height = max(distance(points[0], points[3]), distance(points[1], points[2])).toInt().coerceAtLeast(1)
        val from = MatOfPoint2f(*points)
        val to = MatOfPoint2f(Point(0.0, 0.0), Point(width.toDouble(), 0.0), Point(width.toDouble(), height.toDouble()), Point(0.0, height.toDouble()))
        val transform = Imgproc.getPerspectiveTransform(from, to)
        val result = Mat()
        try {
            Imgproc.warpPerspective(image, result, transform, Size(width.toDouble(), height.toDouble()), Imgproc.INTER_CUBIC, Core.BORDER_REPLICATE)
            if (height >= width * 1.5) Core.rotate(result, result, Core.ROTATE_90_COUNTERCLOCKWISE)
            return result
        } catch (error: Exception) { result.release(); throw error }
        finally { from.release(); to.release(); transform.release() }
    }

    private fun read(image: Mat, model: Recognizer): Pair<String, Double> {
        val width = ceil(48.0 * image.cols() / image.rows()).toInt().coerceIn(1, 4096)
        val (values, shape) = tensor(image, width, 48, max(320, width)).use { run(model.session, it) }
        val classes = shape[2].toInt()
        check(classes == model.characters.size) { "OCR辞書がモデルと一致しません。" }
        var previous = 0; var count = 0; var score = 0.0
        val text = StringBuilder()
        for (time in 0 until shape[1].toInt()) {
            val offset = time * classes
            var best = 0
            for (index in 1 until classes) if (values[offset + index] > values[offset + best]) best = index
            if (best != 0 && best != previous) {
                text.append(model.characters[best]); score += values[offset + best]; count++
            }
            previous = best
        }
        return Pair(text.toString().trim(), if (count == 0) 0.0 else score / count)
    }

    fun recognize(path: String, koreanFile: String?): List<JSONObject> {
        checkCancelled()
        if (detector == null) detector = session(assets.open("ocr/PP-OCRv6_det_small.onnx").use { it.readBytes() })
        checkCancelled()
        if (recognizer == null) recognizer = recognizer(assets.open("ocr/PP-OCRv6_rec_small.onnx").use { it.readBytes() })
        if (koreanPath != koreanFile) {
            korean?.close(); korean = null; koreanPath = null
            if (koreanFile != null) { korean = recognizer(java.io.File(koreanFile).readBytes()); koreanPath = koreanFile }
        }
        val image = Imgcodecs.imread(path)
        try {
            check(!image.empty() && max(image.rows(), image.cols()) <= 2048) { "画像が無効です。" }
            val lines = mutableListOf<Line>()
            for (points in detect(image)) {
                checkCancelled()
                val crop = crop(image, points)
                var result: Pair<String, Double>
                try {
                    result = read(crop, recognizer!!)
                    korean?.let { model ->
                        val candidate = read(crop, model)
                        val omitted = result.first.none(::cjk) && result.first.replace(" ", "").length < candidate.first.replace(" ", "").length * .7
                        if (candidate.first.count { it in '\uac00'..'\ud7a3' } >= 2 && candidate.second >= .9 && (candidate.second > result.second + .05 || omitted)) result = candidate
                    }
                } finally { crop.release() }
                if (result.second < .5 || result.first.isBlank()) continue
                val box = Box(points.minOf { it.x }, points.minOf { it.y }, points.maxOf { it.x }, points.maxOf { it.y })
                if (box.width <= 0 || box.height <= 0) continue
                lines.add(Line(result.first, box, min(box.width, box.height), box.height > box.width * 1.8))
            }
            val refined = geometry(image, lines)
            val kept = refined.filter { line -> !refined.any { body -> ruby(line, body) } }
            return group(kept).map { paragraph ->
                var text = ""
                for (line in paragraph) {
                    if (text.isNotEmpty() && !cjk(text.last()) && !cjk(line.text.first()) && text.last() != '-') text += " "
                    text += line.text
                }
                val box = Box(paragraph.minOf { it.box.x }, paragraph.minOf { it.box.y }, paragraph.maxOf { it.box.right }, paragraph.maxOf { it.box.bottom })
                box.json(image.cols(), image.rows()).put("text", text)
                    .put("regions", org.json.JSONArray(paragraph.map { it.box.json(image.cols(), image.rows()) }))
            }
        } finally { image.release() }
    }

    private fun geometry(image: Mat, lines: List<Line>): List<Line> {
        val mask = Mat(); val labels = Mat(); val stats = Mat(); val centers = Mat()
        try {
            Imgproc.cvtColor(image, mask, Imgproc.COLOR_BGR2GRAY)
            Imgproc.threshold(mask, mask, 0.0, 255.0, Imgproc.THRESH_BINARY_INV + Imgproc.THRESH_OTSU)
            if (Core.countNonZero(mask) > mask.total() / 2) Core.bitwise_not(mask, mask)
            val count = Imgproc.connectedComponentsWithStats(mask, labels, stats, centers)
            val allStats = IntArray(count * 5)
            val allCenters = DoubleArray(count * 2)
            stats.get(0, 0, allStats); centers.get(0, 0, allCenters)
            return lines.map { line ->
                val b = line.box
                val middle = if (line.vertical) (b.x + b.right) / 2 else (b.y + b.bottom) / 2
                val thickness = if (line.vertical) b.width else b.height
                val components = (1 until count).mapNotNull { i ->
                    val offset = i * 5
                    if (allCenters[i * 2] in b.x..b.right && allCenters[i * 2 + 1] in b.y..b.bottom
                        && abs(allCenters[i * 2 + if (line.vertical) 0 else 1] - middle) <= thickness * .3
                        && allStats[offset + 4] >= 3 && allStats[offset + 2] <= b.width * 1.2 && allStats[offset + 3] <= b.height * 1.2)
                        allStats.copyOfRange(offset, offset + 5) else null
                }
                if (components.isEmpty()) line else {
                    var weight = 0; val half = components.sumOf { it[4] } / 2.0
                    val dimension = if (line.vertical) 2 else 3
                    val size = components.sortedBy { it[dimension] }.first { weight += it[4]; weight >= half }[dimension].toDouble()
                    line.copy(box = Box(max(b.x, components.minOf { it[0] }.toDouble()), max(b.y, components.minOf { it[1] }.toDouble()),
                        min(b.right, components.maxOf { it[0] + it[2] }.toDouble()), min(b.bottom, components.maxOf { it[1] + it[3] }.toDouble())), size = max(1.0, size))
                }
            }
        } finally { mask.release(); labels.release(); stats.release(); centers.release() }
    }

    private fun ruby(line: Line, body: Line): Boolean {
        if (line === body || line.vertical != body.vertical || line.size > body.size * .72 || body.text.none(::cjk)) return false
        val b = line.box; val a = body.box
        return if (line.vertical) min(b.bottom, a.bottom) - max(b.y, a.y) >= b.height * .6 && b.x - a.right in 0.0..body.size * 1.2
        else min(b.right, a.right) - max(b.x, a.x) >= b.width * .6 && a.y - b.bottom in 0.0..body.size * 1.2
    }

    private fun group(lines: List<Line>): List<List<Line>> {
        fun median(values: List<Double>): Double {
            val sorted = values.sorted(); if (sorted.isEmpty()) return 0.0
            return (sorted[(sorted.size - 1) / 2] + sorted[sorted.size / 2]) / 2
        }
        val horizontal = lines.filter { !it.vertical }
        val groups = mutableListOf<MutableList<Line>>()
        val size = median(horizontal.flatMap { line -> line.text.map { line.size } })
        val left = horizontal.minOfOrNull { it.box.x } ?: 0.0
        val prose = horizontal.count { it.box.width >= size * 20 } >= 2 && horizontal.all { it.box.x - left <= size * 1.5 }
            && horizontal.sumOf { it.text.count(::cjk) } > horizontal.sumOf { it.text.length } * .5
        val pitches = horizontal.mapNotNull { line -> horizontal.mapNotNull { other ->
            val distance = (other.box.y + other.box.bottom - line.box.y - line.box.bottom) / 2
            val step = max(line.size, other.size)
            if (distance > 0 && distance <= step * 4 && min(line.box.right, other.box.right) - max(line.box.x, other.box.x) >= min(line.box.width, other.box.width) * .5) distance / step else null
        }.minOrNull() }
        val spacing = if (pitches.isEmpty()) 2.2 else (median(pitches) * 1.25).coerceIn(2.2, 3.6)
        for (line in horizontal.sortedWith(compareBy({ (it.box.y + it.box.bottom) / 2 }, { it.box.x }))) {
            val matches = groups.mapNotNull { group ->
                val previous = group.last(); val a = previous.box; val b = line.box
                val distance = (b.y + b.bottom - a.y - a.bottom) / 2
                if (distance > 0 && distance <= max(line.size, previous.size) * (if (prose) 3.2 else spacing)
                    && min(b.right, a.right) - max(b.x, a.x) >= min(b.width, a.width) * .5 && (!prose || b.x - left < size * .6)) Pair(distance, group) else null
            }
            val match = matches.minByOrNull { it.first }?.second
            if (match == null) groups.add(mutableListOf(line)) else match.add(line)
        }
        val rows = mutableListOf<MutableList<MutableList<Line>>>()
        for (group in groups.sortedBy { it.first().box.y }) {
            if (rows.isEmpty() || group.first().box.y - rows.last().first().first().box.y > max(group.first().size, rows.last().first().first().size) * 1.5) rows.add(mutableListOf())
            rows.last().add(group)
        }
        val vertical = mutableListOf<MutableList<Line>>()
        for (line in lines.filter { it.vertical }.sortedWith(compareBy({ -it.box.x }, { it.box.y }))) {
            val match = vertical.mapNotNull { group ->
                val previous = group.last(); val a = previous.box; val b = line.box
                val distance = (a.x + a.right - b.x - b.right) / 2
                if (distance > 0 && distance <= max(line.size, previous.size) * 2.6 && min(b.bottom, a.bottom) - max(b.y, a.y) >= min(b.height, a.height) * .5) Pair(distance, group) else null
            }.minByOrNull { it.first }?.second
            if (match == null) vertical.add(mutableListOf(line)) else match.add(line)
        }
        return rows.flatMap { row -> row.sortedBy { group -> group.minOf { it.box.x } } } + vertical
    }

    private fun cjk(ch: Char) = ch in '\u3000'..'\u9fff' || ch in '\uff00'..'\uffef'
}
