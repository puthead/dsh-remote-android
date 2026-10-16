package com.deepseek.dshremote.data.api

import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.util.Locale
import kotlin.math.roundToInt

/**
 * 「从相册 / 相机拿到一张图 → 压成塞得进 1 MiB 请求体」的底层管道。
 *
 * 预算从哪来（别在这里"顺手放宽"）：中继 `tools/dsh-relay/lib/config.mjs:69` 与网关
 * `tools/dsh-remote/lib/config.mjs:216` 都是 `maxBodyBytes = 1_048_576`，超了直接 413
 * `payload_too_large`；base64 还有 4/3 膨胀，所以**压缩后单图字节数**上限是
 * [MAX_COMPRESSED_BYTES]（700 KiB ⇒ base64 约 933 KiB，剩 ~90 KiB 留给 JSON 壳与同条消息的文本）。
 *
 * **这条预算是对"单张图"说的**：整包 1 MiB 是图片字段、文本、会话 id 一起算的，且网关/中继侧
 * 约定的整包 base64 总量上限是 `1_000_000` 字符（约 976.6 KiB，比 1 MiB 的硬上限再收一点，
 * 但仍高于单图满额时的 955_736 字符），所以 N 张图时每张的可用额度是
 * `(1_000_000 − 文本与壳) / N` 量级——4 张各 700 KiB（base64 后共约 3.7 MiB）**必然 413**。
 * 调用方要么限制张数、要么按张数收紧单张上限，并建议在客户端先做整包预校验；这里只保证单张
 * 不超 [MAX_COMPRESSED_BYTES]。
 *
 * 三个关键取舍：
 * 1. PNG/WebP/GIF 本来就 ≤ 700 KiB 就**原样发**，不做"统一转 JPEG"：透明图转 JPEG 会把 alpha
 *    填成黑底，且不可逆；小截图/表情包重编码也只会更糊。超预算才重编码，且先试保 alpha 的 PNG。
 * 2. JPEG 一律重编码：手机原图动辄 3~10 MB，不重编码必然 413。质量与长边按
 *    [JPEG_QUALITY_LADDER] → [EDGE_PX_LADDER] 逐档降，**先降质量再降长边**；降到底仍超预算就
 *    明确失败并把实际字节数告诉用户，而不是让 413 在几十秒后才变成一句"发送失败"。
 * 3. EXIF 方向用 `Matrix` 烘进像素（而不是把 orientation 原样透传）：下游是桌面端 runtime，
 *    它只拿到 base64 字节，没有任何地方会替我们转正。
 *
 * 线程：IO 方法（[fromUri]）是**阻塞**的——读流 + 解码 + 压缩，几百毫秒到两三秒，必须在
 * `Dispatchers.IO` 一类后台线程调用。纯函数（[mediaTypeOf]、[formatBytes]、[describeFailure]
 * 以及所有 internal 算法函数）可以在 JVM 单测里直接跑，不碰 BitmapFactory / ContentResolver。
 */
object ImagePayloads {

    /** 压缩后单图上限（字节）。700 KiB 留出 JSON/文本余量，保证 base64 后的整包 < 1 MiB。 */
    const val MAX_COMPRESSED_BYTES: Int = 700 * 1024

    /** 长边上限（px）：1600 对"看截图/看图"足够，又能把手机原图压到几百 KB。 */
    const val MAX_EDGE_PX: Int = 1600

    const val JPEG_QUALITY: Int = 82

    val SUPPORTED_MEDIA_TYPES: Set<String> = setOf("image/png", "image/jpeg", "image/webp", "image/gif")

    /**
     * 降档顺序：先降质量（82→70→58→46），同一档质量再把长边从 1600 降到 800。
     *
     * 为什么质量排在长边前面：长边是"能不能看清字"的硬指标，质量只是"糊不糊"。
     * 一张 1600px 的截图降到质量 46 仍然认得清，而把它降到 800px 之后字就先糊了。
     */
    internal val JPEG_QUALITY_LADDER: IntArray = intArrayOf(JPEG_QUALITY, 70, 58, 46)

    /** 长边档位，见 [JPEG_QUALITY_LADDER] 的取舍说明。 */
    internal val EDGE_PX_LADDER: IntArray = intArrayOf(MAX_EDGE_PX, 1280, 1024, 800)

    private const val MEDIA_JPEG = "image/jpeg"
    private const val MEDIA_PNG = "image/png"

    /** 原图探测上限：多读 1 字节就能区分"正好 700 KiB"和"超了"，又不会把 10 MB 原图整读进内存。 */
    private const val PEEK_BYTES = MAX_COMPRESSED_BYTES + 1

    private const val READ_CHUNK_BYTES = 16 * 1024
    private const val COMPRESS_BUFFER_BYTES = 256 * 1024
    private const val MAX_NAME_LENGTH = 120

    private const val KIB = 1024L
    private const val MIB = 1024L * 1024L
    private const val GIB = 1024L * 1024L * 1024L

    private const val NOT_READABLE = "打不开这张图片：系统没有给出可读的数据流（可能已被删除或没有权限）。"
    private const val NOT_AN_IMAGE = "这个文件不是能识别的图片格式。"

    // ---------------------------------------------------------------- 纯函数（单测覆盖）

    /** 从 MIME 串归一化出契约允许的四种类型；无法映射时回退 `"image/jpeg"`。纯函数。 */
    fun mediaTypeOf(mime: String?): String = mediaTypeOfOrNull(mime) ?: MEDIA_JPEG

    /**
     * 同 [mediaTypeOf]，但映射不出来时返回 null，好让调用方继续看文件扩展名
     * （Photo Picker 的 `getType` 偶发返回 null 或 `image/heic`，那时扩展名比"默认 JPEG"更准）。
     */
    internal fun mediaTypeOfOrNull(mime: String?): String? {
        // 有些 provider 会带参数（"image/jpeg; charset=binary"），先切掉再比。
        val normalized = mime?.substringBefore(';')?.trim()?.lowercase(Locale.US).orEmpty()
        return when (normalized) {
            "image/jpeg", "image/jpg", "image/pjpeg" -> MEDIA_JPEG
            "image/png", "image/x-png" -> MEDIA_PNG
            "image/webp" -> "image/webp"
            "image/gif" -> "image/gif"
            else -> null
        }
    }

    internal fun isSupportedMediaType(mediaType: String): Boolean = mediaType in SUPPORTED_MEDIA_TYPES

    /** 依次看「provider 给的 MIME → 文件名扩展名 → URI 末段扩展名」，都认不出才回退 JPEG。 */
    internal fun resolveMediaType(declared: String?, fileName: String?, uriPath: String?): String =
        mediaTypeOfOrNull(declared)
            ?: mediaTypeForExtension(extensionOf(fileName))
            ?: mediaTypeForExtension(extensionOf(uriPath))
            ?: MEDIA_JPEG

    /** 取出小写扩展名（不带点）。`IMG_1.JPG` → `jpg`；无扩展名 / `.hidden` → null。 */
    internal fun extensionOf(value: String?): String? {
        val base = value?.substringAfterLast('/')?.substringAfterLast('\\')?.trim().orEmpty()
        val dot = base.lastIndexOf('.')
        if (dot <= 0 || dot == base.length - 1) return null
        return base.substring(dot + 1).lowercase(Locale.US)
    }

    internal fun mediaTypeForExtension(extension: String?): String? = when (extension) {
        "jpg", "jpeg", "jpe", "jfif" -> MEDIA_JPEG
        "png" -> MEDIA_PNG
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        else -> null
    }

    /** 展示用文件名；用于拼 JSON 里的 filename 字段与 UI 上的小字。纯函数。 */
    internal fun displayNameOf(suggested: String?, uriPath: String?, mediaType: String): String {
        for (candidate in listOf(basenameOf(suggested), basenameOf(uriPath))) {
            val sanitized = sanitizeName(candidate)
            if (sanitized.isEmpty()) continue
            // Photo Picker 的 URI 末段常常是一串纯数字 id（content://…/media/1000000034）：
            // 拿它当文件名，用户看到的是"1000000034"这种垃圾，不如回退成 image.jpg。
            if (!sanitized.contains('.') && sanitized.all { it.isDigit() }) continue
            return sanitized
        }
        return "image.${extensionFor(mediaType)}"
    }

    internal fun extensionFor(mediaType: String): String = when (mediaType) {
        MEDIA_PNG -> "png"
        "image/webp" -> "webp"
        "image/gif" -> "gif"
        else -> "jpg"
    }

    /**
     * 采样率：保证解码后的长边落在 `[maxEdge, 2 * maxEdge)`，因此既不会解出比目标大得多的位图
     * （那才是 OOM 的来源），也不会小到没法再缩到 [MAX_EDGE_PX]。
     *
     * 用 2 的幂而不是精确比例：`inSampleSize` 只保证"不小于请求值"的近似效果，
     * 精确缩放交给之后的 [fitInside] + `Matrix`，那一步才是像素级准确的。
     */
    internal fun computeInSampleSize(width: Int, height: Int, maxEdge: Int): Int {
        if (width <= 0 || height <= 0 || maxEdge <= 0) return 1
        var sample = 1
        while (maxOf(width, height) / (sample * 2) >= maxEdge) sample *= 2
        return sample
    }

    /** 等比缩到长边 ≤ [maxEdge]；本来就够小就原样返回（绝不放大）。纯函数。 */
    internal fun fitInside(width: Int, height: Int, maxEdge: Int): Pair<Int, Int> {
        if (width <= 0 || height <= 0) return 1 to 1
        if (maxEdge <= 0) return width to height
        val longest = maxOf(width, height)
        if (longest <= maxEdge) return width to height
        val ratio = maxEdge.toDouble() / longest
        return (width * ratio).roundToInt().coerceAtLeast(1) to (height * ratio).roundToInt().coerceAtLeast(1)
    }

    /** 用户**看到**的宽高：EXIF 5~8 是 90°/270° 旋转，宽高要对调。纯函数。 */
    internal fun orientedSize(width: Int, height: Int, orientation: Int): Pair<Int, Int> =
        if (swapsAxesFor(orientation)) height to width else width to height

    /** EXIF 5,6,7,8 的宽高与存储方向相反。 */
    internal fun swapsAxesFor(orientation: Int): Boolean = orientation in 5..8

    /**
     * EXIF orientation → 需要顺时针旋转的角度。
     *
     * 只返回 0/90/180/270：5 与 7 除了旋转还各带一次镜像，由 [mirrorAfterRotation] 单独表达，
     * 因为镜像必须在**旋转之后**作用在已经转正的画面上（见 [applyExif]）。
     */
    internal fun rotationDegreesFor(orientation: Int): Int = when (orientation) {
        5, 6 -> 90
        3, 4 -> 180
        7, 8 -> 270
        else -> 0
    }

    /** EXIF 5（transpose）/ 7（transverse）：旋转之后再水平镜像。 */
    internal fun mirrorAfterRotation(orientation: Int): Boolean = orientation == 5 || orientation == 7

    /** EXIF 2：纯水平镜像（自拍前置摄像头常见）。 */
    internal fun mirrorHorizontally(orientation: Int): Boolean = orientation == 2

    /** EXIF 4：纯垂直镜像。 */
    internal fun mirrorVertically(orientation: Int): Boolean = orientation == 4

    /** `"1.2 MB"` 之类。纯函数，且强制 `Locale.US`：小数点不能跟着系统语言变成逗号。 */
    fun formatBytes(bytes: Int): String {
        val value = if (bytes < 0) 0L else bytes.toLong()
        return when {
            value < KIB -> "$value B"
            value < MIB -> oneDecimal(value.toDouble() / KIB) + " KB"
            value < GIB -> oneDecimal(value.toDouble() / MIB) + " MB"
            else -> oneDecimal(value.toDouble() / GIB) + " GB"
        }
    }

    /** 把 `Result` 的失败变成人话（给 snackbar 用）。纯函数。 */
    fun describeFailure(error: Throwable): String = when (error) {
        is ImageReadException, is ImageTooLargeException ->
            error.message?.takeIf { it.isNotBlank() } ?: "处理这张图片失败。"
        // 先于 IOException 匹配：OOM 不是"读文件出错"，把它说成 IO 错会让用户去查权限。
        is OutOfMemoryError -> "这张图片太大，手机内存不够处理它。先裁剪一下，或换一张小一点的图。"
        is SecurityException, is FileNotFoundException -> "读不到这张图片：系统没有给读取权限，或文件已经被移走。"
        is IOException -> "读取图片时出错：${error.message ?: "I/O 错误"}"
        else -> "处理图片失败：${error.message ?: error.javaClass.simpleName}"
    }

    // ---------------------------------------------------------------- IO 管道（需真机/模拟器）

    /**
     * 读取 `content://` 或 `file://` 的图片，按需缩放并纠正 EXIF 方向，输出 ≤ [MAX_COMPRESSED_BYTES] 的图。
     *
     * 阻塞调用，须在后台线程执行。失败一律走 `Result.failure`，异常类型见 [describeFailure]。
     */
    fun fromUri(context: Context, uri: Uri, displayName: String?): Result<PendingImage> = runCatching {
        val resolver = context.contentResolver
        val path = uri.lastPathSegment
        // getType 在个别 provider 上会抛（权限/已删除），它只影响格式判断，不该让整次发送失败。
        val declared = runCatching { resolver.getType(uri) }.getOrNull()
        val mediaType = resolveMediaType(declared, displayName, path)
        val name = displayNameOf(displayName, path, mediaType)

        // ① 非 JPEG：先只读 700 KiB + 1 字节。够小就原样保留（见类注释取舍 1），
        //    连解码都只为拿宽高与方向；超了才走下面的重编码。
        if (mediaType != MEDIA_JPEG) {
            val peek = resolver.openInputStream(uri)?.use { readAtMost(it, PEEK_BYTES) }
                ?: throw ImageReadException(NOT_READABLE)
            if (peek.isEmpty()) throw ImageReadException("这张图片是 0 字节的空文件。")
            if (peek.size <= MAX_COMPRESSED_BYTES) {
                val (rawWidth, rawHeight) = decodeBounds(peek)
                val (width, height) = orientedSize(rawWidth, rawHeight, orientationOf(peek))
                return@runCatching PendingImage(peek, mediaType, name, width, height)
            }
        }

        // ② 重编码：三段式重新开流——量尺寸 → 读 EXIF → 解码。
        //    InputStream 是一次性的，读 EXIF 必须再开一次（复用已消费的流只会读到 0 字节，
        //    然后"方向偶尔丢失"这种 bug 会以"某些照片躺着"的形式出现在用户那里）。
        val (rawWidth, rawHeight) = readBounds(resolver, uri)
        val orientation = readOrientation(resolver, uri)
        val sample = computeInSampleSize(rawWidth, rawHeight, MAX_EDGE_PX)
        val decoded = decodeSampled(resolver, uri, sample)
        try {
            if (mediaType != MEDIA_JPEG && decoded.hasAlpha()) {
                // 有 alpha：先在 PNG（无损、保 alpha）这条路上逐档试，实在塞不进预算才退到 JPEG
                // ——那时 mediaType 会一起改成 image/jpeg，保证"字节是什么格式就标什么格式"。
                encodePngWithinBudget(decoded, orientation, name)?.let { return@runCatching it }
            }
            encodeJpegWithinBudget(decoded, orientation, name)
        } finally {
            decoded.recycle()
        }
    }

    /**
     * 读取「至多 limit 字节」：用返回长度是否等于 limit 来判断原文件是否超限，
     * 因此不会把一个 12 MB 的原图整个读进内存（那本身就是一次自找的 OOM）。
     */
    internal fun readAtMost(input: InputStream, limit: Int): ByteArray {
        if (limit <= 0) return ByteArray(0)
        val out = ByteArrayOutputStream(minOf(limit, READ_CHUNK_BYTES))
        val buffer = ByteArray(READ_CHUNK_BYTES)
        var total = 0
        while (total < limit) {
            val read = input.read(buffer, 0, minOf(buffer.size, limit - total))
            if (read <= 0) break
            out.write(buffer, 0, read)
            total += read
        }
        return out.toByteArray()
    }

    /** 把 EXIF 方向按正确的复合顺序压进矩阵：先缩放，再旋转，最后才是 5/7/2 的镜像。 */
    private fun applyExif(matrix: Matrix, orientation: Int): Boolean {
        var changed = false
        val degrees = rotationDegreesFor(orientation)
        if (degrees != 0) {
            matrix.postRotate(degrees.toFloat())
            changed = true
        }
        // 顺序不能反：EXIF 5 的定义就是"先转 90°、再把转正后的画面水平翻一次"
        // （transpose 把 (x,y) 映到 (y,x)，只有 R90 之后再水平镜像才对得上）。
        if (mirrorAfterRotation(orientation) || mirrorHorizontally(orientation)) {
            matrix.postScale(-1f, 1f)
            changed = true
        } else if (mirrorVertically(orientation)) {
            matrix.postScale(1f, -1f)
            changed = true
        }
        return changed
    }

    /** 把 [source] 缩到长边 ≤ [maxEdge] 并纠正方向；什么都不用做时直接返回 [source]（不复制）。 */
    private fun renderForEdge(source: Bitmap, orientation: Int, maxEdge: Int): Bitmap {
        val (fitWidth, fitHeight) = fitInside(source.width, source.height, maxEdge)
        val matrix = Matrix()
        var changed = false
        if (fitWidth != source.width || fitHeight != source.height) {
            matrix.postScale(fitWidth.toFloat() / source.width, fitHeight.toFloat() / source.height)
            changed = true
        }
        if (applyExif(matrix, orientation)) changed = true
        if (!changed) return source
        return Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
    }

    /**
     * JPEG：质量档 × 长边档的笛卡尔积里取第一个塞得进预算的结果。
     *
     * 去重（[lastEffectiveEdge]）不是可有可无的小优化：原图本来就比 800px 还小时，
     * 四档长边算出来是同一张位图，不去重就要白白压 16 次，用户会看到转圈多转一两秒。
     */
    private fun encodeJpegWithinBudget(source: Bitmap, orientation: Int, name: String): PendingImage {
        val longest = maxOf(source.width, source.height)
        var current = source
        var ownsCurrent = false
        var smallestSeen = Int.MAX_VALUE
        var lastEffectiveEdge = 0
        try {
            for (edge in EDGE_PX_LADDER) {
                val effective = minOf(edge, longest)
                if (effective == lastEffectiveEdge) continue
                lastEffectiveEdge = effective
                val rendered = renderForEdge(source, orientation, edge)
                if (rendered !== current) {
                    if (ownsCurrent) current.recycle()
                    current = rendered
                    ownsCurrent = rendered !== source
                }
                for (quality in JPEG_QUALITY_LADDER) {
                    val bytes = compressJpeg(current, quality)
                    if (bytes.size <= MAX_COMPRESSED_BYTES) {
                        return PendingImage(bytes, MEDIA_JPEG, name, current.width, current.height)
                    }
                    smallestSeen = minOf(smallestSeen, bytes.size)
                }
            }
        } finally {
            if (ownsCurrent) current.recycle()
        }
        throw ImageTooLargeException(tooLargeMessage(smallestSeen))
    }

    /** 保 alpha 的重编码：只降长边（PNG 的 quality 参数被忽略），四档都塞不进就返回 null 交给 JPEG 兜底。 */
    private fun encodePngWithinBudget(source: Bitmap, orientation: Int, name: String): PendingImage? {
        val longest = maxOf(source.width, source.height)
        var lastEffectiveEdge = 0
        for (edge in EDGE_PX_LADDER) {
            val effective = minOf(edge, longest)
            if (effective == lastEffectiveEdge) continue
            lastEffectiveEdge = effective
            val rendered = renderForEdge(source, orientation, edge)
            try {
                val bytes = compressPng(rendered)
                if (bytes.size <= MAX_COMPRESSED_BYTES) {
                    return PendingImage(bytes, MEDIA_PNG, name, rendered.width, rendered.height)
                }
            } finally {
                if (rendered !== source) rendered.recycle()
            }
        }
        return null
    }

    private fun compressJpeg(bitmap: Bitmap, quality: Int): ByteArray {
        val out = ByteArrayOutputStream(COMPRESS_BUFFER_BYTES)
        bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
        return out.toByteArray()
    }

    private fun compressPng(bitmap: Bitmap): ByteArray {
        val out = ByteArrayOutputStream(COMPRESS_BUFFER_BYTES)
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        return out.toByteArray()
    }

    private fun readBounds(resolver: ContentResolver, uri: Uri): Pair<Int, Int> {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        val stream = resolver.openInputStream(uri) ?: throw ImageReadException(NOT_READABLE)
        stream.use { BitmapFactory.decodeStream(it, null, options) }
        if (options.outWidth <= 0 || options.outHeight <= 0) throw ImageReadException(NOT_AN_IMAGE)
        return options.outWidth to options.outHeight
    }

    private fun decodeBounds(bytes: ByteArray): Pair<Int, Int> {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        if (options.outWidth <= 0 || options.outHeight <= 0) throw ImageReadException(NOT_AN_IMAGE)
        return options.outWidth to options.outHeight
    }

    private fun decodeSampled(resolver: ContentResolver, uri: Uri, sampleSize: Int): Bitmap {
        val options = BitmapFactory.Options().apply {
            inSampleSize = sampleSize.coerceAtLeast(1)
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val stream = resolver.openInputStream(uri) ?: throw ImageReadException(NOT_READABLE)
        return stream.use { BitmapFactory.decodeStream(it, null, options) }
            ?: throw ImageReadException("这张图片解码失败：可能是不支持的格式，或文件已经损坏。")
    }

    /** EXIF 读不出来不算错误：没有 EXIF 的图本来就是"方向正常"，不能因为读方向失败就发不出图。 */
    private fun orientationOf(bytes: ByteArray): Int = runCatching {
        ExifInterface(ByteArrayInputStream(bytes))
            .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)

    private fun readOrientation(resolver: ContentResolver, uri: Uri): Int = runCatching {
        resolver.openInputStream(uri)?.use { stream ->
            ExifInterface(stream).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        } ?: ExifInterface.ORIENTATION_NORMAL
    }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)

    private fun tooLargeMessage(bytes: Int): String {
        val actual = if (bytes == Int.MAX_VALUE) "未知" else "${formatBytes(bytes)}（$bytes 字节）"
        return "这张图压到最低档（长边 ${EDGE_PX_LADDER.last()}px、JPEG 质量 ${JPEG_QUALITY_LADDER.last()}）" +
            "后仍有 $actual，超过单图 ${formatBytes(MAX_COMPRESSED_BYTES)} 的上限。请先裁剪再发。"
    }

    private fun basenameOf(raw: String?): String =
        raw?.substringAfterLast('/')?.substringAfterLast('\\')?.trim().orEmpty()

    private fun sanitizeName(raw: String): String =
        raw.filter { !it.isISOControl() && it != '/' && it != '\\' }.trim().take(MAX_NAME_LENGTH)

    private fun oneDecimal(value: Double): String = String.format(Locale.US, "%.1f", value)
}

/** 读图 / 解码类失败，message 已经是给用户看的中文，[ImagePayloads.describeFailure] 原样透出。 */
internal class ImageReadException(message: String) : Exception(message)

/** 压到最低档仍然超预算；message 里带实际字节数。 */
internal class ImageTooLargeException(message: String) : Exception(message)
