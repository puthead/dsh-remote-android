package com.deepseek.dshremote.data.api

/**
 * 一张「准备随消息一起发出去」的图片：已经压到预算内、已经纠正过 EXIF 方向、字节与
 * [mediaType] 永远自洽（是什么格式就标什么格式，不玩"字节是 JPEG 却标 image/png"那套）。
 *
 * 为什么 [equals] / [hashCode] 必须手写：`bytes` 是 `ByteArray`，data class 的默认实现走**引用**比较，
 * 于是"同一张图重新读一遍"会被判成两张不同的图——UI 侧的去重、`StateFlow` 的 `distinctUntilChanged`、
 * 单测里的 `assertEquals` 全都会因此骗人。
 *
 * [approxBase64Chars] 是给"这条消息发出去会不会 413"预检用的：中继与网关的单请求体上限都是
 * 1 MiB（`tools/dsh-relay/lib/config.mjs:69`、`tools/dsh-remote/lib/config.mjs:216`），
 * base64 膨胀 4/3，所以上限内单图的 base64 字符数必须明显小于 1_048_576。
 */
data class PendingImage(
    val bytes: ByteArray,
    /** 契约允许的四种之一，见 [ImagePayloads.SUPPORTED_MEDIA_TYPES]。 */
    val mediaType: String,
    /** 展示用文件名（例 `IMG_20261015_2210.jpg`），不是磁盘路径。 */
    val name: String,
    val width: Int,
    val height: Int,
) {

    /**
     * base64 之后的字符数（含 `=` 补齐）。
     *
     * 用 `((n + 2) / 3) * 4` 而不是 `n / 3 * 4`：后者在 n 不是 3 的倍数时会少算一组，
     * 而 716800（700 KiB 整）恰好不是 3 的倍数——真按少算的数去预检，就会在边界上放行一个必然 413 的包。
     */
    val approxBase64Chars: Int get() = ((bytes.size + 2) / 3) * 4

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is PendingImage) return false
        return width == other.width &&
            height == other.height &&
            mediaType == other.mediaType &&
            name == other.name &&
            bytes.contentEquals(other.bytes)
    }

    override fun hashCode(): Int {
        var result = bytes.contentHashCode()
        result = 31 * result + mediaType.hashCode()
        result = 31 * result + name.hashCode()
        result = 31 * result + width
        result = 31 * result + height
        return result
    }

    /**
     * 只打元信息、不打字节：一张图几百 KB，落进日志既没用又会把崩溃报告撑爆；
     * 而 data class 默认的 `toString` 打出来是 `[B@3f2a1c` 这种毫无信息量的东西。
     */
    override fun toString(): String =
        "PendingImage(name=$name, mediaType=$mediaType, ${width}x$height, ${bytes.size} bytes)"
}
