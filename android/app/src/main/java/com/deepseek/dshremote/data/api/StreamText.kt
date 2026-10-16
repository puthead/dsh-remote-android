package com.deepseek.dshremote.data.api

/**
 * 把隧道下发的二进制 chunk 增量拼成文本。
 *
 * 为什么不能直接 `String(bytes, Charsets.UTF_8)`：中继按固定 128 KiB 切片下发
 * （`tools/dsh-remote/lib/relay-client.mjs` 的 `CHUNK_BYTES`），切片边界只保证字节数、
 * 不保证落在字符边界上。逐 chunk 转换会把一个三字节中文或四字节 emoji 劈成两个 U+FFFD，
 * 而外层的 JSON 依然能解析成功 —— 用户看到的是"偶发错字"，日志里什么都没有。
 *
 * 为什么不是"换成 [java.nio.charset.CharsetDecoder] 就有状态了"：`CharsetDecoder` 确实有状态，
 * 但它**不替你保存未消费的尾部字节** —— 那些字节留在**调用方传入的那个 ByteBuffer** 里。
 * 每次 `ByteBuffer.wrap(bytes)` 用完就丢，残留字节随之丢失，下一个 chunk 的续字节就被当成
 * 非法首字节。这个坑本轮真踩过：改用三参 `decode(input, output, false)` 之后测试照样失败。
 * 所以这里自己持有 [pending]，不依赖 JDK 的内部行为。
 *
 * 坏字节仍然按替换字符处理（不抛异常）：隧道里出现脏字节不该把整条事件流打断，
 * 与旧实现 `String(bytes, UTF_8)` 的宽容度保持一致。
 */
internal class StreamTextDecoder {

    /** 上一次没凑齐一个完整字符的尾部字节；UTF-8 里最多 3 个。 */
    private var pending: ByteArray = EMPTY

    /** 解码一个 chunk；跨 chunk 的多字节字符会被正确拼回。 */
    fun decode(bytes: ByteArray): String {
        val merged = if (pending.isEmpty()) bytes else pending + bytes
        pending = EMPTY
        if (merged.isEmpty()) return ""
        val complete = completePrefixLength(merged)
        if (complete < merged.size) pending = merged.copyOfRange(complete, merged.size)
        if (complete == 0) return ""
        return String(merged, 0, complete, Charsets.UTF_8)
    }

    private companion object {

        val EMPTY = ByteArray(0)

        /**
         * 返回 `bytes` 里"可以现在就解码"的前缀长度：不足一个完整字符的尾部留给下一次调用。
         *
         * 判据直接用 UTF-8 的编码规则（首字节定长度 + 续字节 0x80..0xBF），
         * 不用 `CharsetDecoder` —— 见类注释那段踩坑记录。
         * 长度够但续字节不对时只吃掉这个坏首字节（交给替换字符兜底）而不是整段留到下次，
         * 否则脏字节会让后面所有内容永远卡在 [pending] 里。
         */
        fun completePrefixLength(bytes: ByteArray): Int {
            var index = 0
            while (index < bytes.size) {
                val lead = bytes[index].toInt() and 0xFF
                val need = when {
                    lead < 0x80 -> 1
                    lead in 0xC2..0xDF -> 2
                    lead in 0xE0..0xEF -> 3
                    lead in 0xF0..0xF4 -> 4
                    // 0x80..0xC1 是多余的续字节/超长编码首字节，0xF5..0xFF 超出 UTF-8 范围：
                    // 都当成一个字节的坏序列，让 String 的替换字符处理掉。
                    else -> 1
                }
                if (index + need > bytes.size) break
                var continuationOk = true
                for (offset in 1 until need) {
                    val byte = bytes[index + offset].toInt() and 0xFF
                    if (byte < 0x80 || byte > 0xBF) {
                        continuationOk = false
                        break
                    }
                }
                index += if (continuationOk) need else 1
            }
            return index
        }
    }
}

/**
 * 有上限的文本累积器。
 *
 * 用于"非 2xx 响应体"这种没有天然结束点的流：对端只发不收时，无上限的 `StringBuilder`
 * 会一路涨到 [com.deepseek.dshremote.data.relay.PendingStreams] 的单流上限（32 MiB）才停。
 * 错误体只需要开头那几 KiB 就能定位问题。
 */
internal class BoundedText(private val maxChars: Int) {

    private val builder = StringBuilder()

    /** 追加文本，只保留前 [maxChars] 个字符，超出的部分直接丢弃。 */
    fun append(text: String) {
        val room = maxChars - builder.length
        if (room <= 0) return
        builder.append(text, 0, minOf(text.length, room))
    }

    val length: Int get() = builder.length

    override fun toString(): String = builder.toString()
}
