package com.deepseek.dshremote.data

/**
 * SSE（`text/event-stream`）增量帧解析器。
 *
 * 为什么不用 `okhttp-sse` 的 EventSource：契约要求客户端显式实现 `fromSeq` 断点续传与
 * 指数退避，而 EventSource 自己会重连并隐藏 `id:`，拿不到续传游标；同时"一条事件被拆成
 * 多个 TCP 包"是内网弱信号下的常见情况，需要一个可单测的纯解析器。
 *
 * 行为遵循 SSE 规范（`https://html.spec.whatwg.org/multipage/server-sent-events.html`）：
 * - 行终止符 `\n`、`\r\n`、`\r` 均可；
 * - `:` 开头是注释（网关 15s 心跳 `: ping`）；
 * - 空行派发事件；多个 `data:` 行以 `\n` 连接；
 * - `field: value` 中冒号后的**一个**空格被忽略，其余空白保留（避免破坏缩进敏感的模型输出）。
 *
 * 注意：`data` 里的 `\n` 是两个字符（反斜杠 + n），属于 JSON 转义，解析器**不得**把它当换行；
 * 只有真正的字节级换行才切行。
 */
class SseFrameParser {

    /** 尚未收到行终止符的尾巴。 */
    private val line = StringBuilder()

    /** 当前事件中累积的 data 行。 */
    private val dataLines = mutableListOf<String>()

    private var eventName: String? = null
    private var lastId: String? = null

    /** 喂入一个网络包（已按 UTF-8 解码的字符串），返回其中解析完成的帧。 */
    fun feed(chunk: String): List<SseFrame> {
        if (chunk.isEmpty()) return emptyList()
        val frames = mutableListOf<SseFrame>()
        line.append(chunk)

        var start = 0
        while (true) {
            val terminator = findTerminator(start)
            if (terminator < 0) break
            val end = terminator
            val isCrLf = line[end] == '\r' && end + 1 < line.length && line[end + 1] == '\n'
            val text = line.substring(start, end)
            start = end + if (isCrLf) 2 else 1
            handleLine(text)?.let { frames += it }
        }
        // 保留未完成的尾巴（同时丢弃已消费部分，避免长连接内存无限增长）
        if (start > 0) line.delete(0, start)
        return frames
    }

    /** 连接彻底结束时调用：丢弃半条事件，避免把残缺帧当完整事件派发。 */
    fun reset() {
        line.setLength(0)
        dataLines.clear()
        eventName = null
        lastId = null
    }

    /**
     * 在当前缓冲区里找行终止符。
     *
     * 边界处理：如果缓冲区最后一个字符是 `\r`，无法判断后面是否还跟 `\n`，必须等下一个包，
     * 否则会把一条 `\r\n` 拆成两个空行、提前派发事件。
     */
    private fun findTerminator(from: Int): Int {
        for (i in from until line.length) {
            val c = line[i]
            if (c == '\n') return i
            if (c == '\r') {
                if (i == line.length - 1) return -1
                return i
            }
        }
        return -1
    }

    /** 处理一整行；返回非 null 表示该行触发了事件派发。 */
    private fun handleLine(text: String): SseFrame? {
        if (text.isEmpty()) return dispatch()
        if (text[0] == ':') return null // 心跳注释

        val colon = text.indexOf(':')
        val field = if (colon < 0) text else text.substring(0, colon)
        var value = if (colon < 0) "" else text.substring(colon + 1)
        if (value.startsWith(" ")) value = value.substring(1)

        when (field) {
            "data" -> dataLines += value
            "event" -> eventName = value
            "id" -> if (!value.contains('\u0000')) lastId = value
            // retry 由客户端自己的退避策略控制（契约要求 1s→30s），这里刻意忽略网关建议值
        }
        return null
    }

    private fun dispatch(): SseFrame? {
        if (dataLines.isEmpty() && eventName == null) return null
        val frame = SseFrame(
            id = lastId,
            event = eventName,
            data = dataLines.joinToString("\n"),
        )
        // 依规范：派发后 data 缓冲清空，event 名重置；id 是"粘性"的（供 Last-Event-ID 用）
        dataLines.clear()
        eventName = null
        return frame
    }
}
