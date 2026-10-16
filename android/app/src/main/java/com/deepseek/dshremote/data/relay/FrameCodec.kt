package com.deepseek.dshremote.data.relay

import com.deepseek.dshremote.data.Logger
import java.util.Base64
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * NDJSON over WebSocket 的帧编解码（契约 §3：每帧一个 JSON 对象，无长度前缀）。
 *
 * 两点刻意的宽容：
 * 1. **一次文本帧里可能有多行 JSON**：中继若把多条帧合并发送（或将来加尾部换行），
 *    [decodeLines] 会逐行解析，不会把两帧粘成一个非法 JSON；
 * 2. **未知 `t` 不抛异常**：返回 [UnknownFrame]，调用方跳过即可——版本升级不该让连接崩掉。
 *
 * Base64 用 `java.util.Base64`（API 26+ 可用）：`android.util.Base64` 在 JVM 单测里是空壳，
 * 会让编解码用例全部失去意义。
 */
object FrameCodec {

    private const val TAG = "FrameCodec"

    fun encode(frame: RelayFrame): String = when (frame) {
        is HelloFrame -> JSONObject().apply {
            put("t", FrameType.HELLO)
            put("proto", frame.proto)
            put("role", frame.role)
            frame.name?.let { put("name", it) }
        }.toString()

        is ReadyFrame -> JSONObject().apply {
            put("t", FrameType.READY)
            put("proto", frame.proto)
            put("role", frame.role)
            put("homeId", frame.homeId)
            frame.homeName?.let { put("homeName", it) }
            put("homeOnline", frame.homeOnline)
        }.toString()

        is ErrorFrame -> JSONObject().apply {
            put("t", FrameType.ERROR)
            put("code", frame.code)
            put("message", frame.message)
            put("fatal", frame.fatal)
        }.toString()

        is ReqFrame -> JSONObject().apply {
            put("t", FrameType.REQ)
            put("id", frame.id)
            put("method", frame.method)
            put("path", frame.path)
            put("headers", headersToJson(frame.headers))
            frame.bodyB64?.let { put("bodyB64", it) }
        }.toString()

        is ResFrame -> JSONObject().apply {
            put("t", FrameType.RES)
            put("id", frame.id)
            put("status", frame.status)
            put("headers", headersToJson(frame.headers))
        }.toString()

        is ChunkFrame -> JSONObject().apply {
            put("t", FrameType.CHUNK)
            put("id", frame.id)
            put("dataB64", frame.dataB64)
        }.toString()

        is EndFrame -> JSONObject().apply {
            put("t", FrameType.END)
            put("id", frame.id)
        }.toString()

        is AbortFrame -> JSONObject().apply {
            put("t", FrameType.ABORT)
            put("id", frame.id)
            put("reason", frame.reason)
        }.toString()

        is PingFrame -> JSONObject().apply {
            put("t", FrameType.PING)
            frame.id?.let { put("id", it) }
        }.toString()

        is PongFrame -> JSONObject().apply {
            put("t", FrameType.PONG)
            frame.id?.let { put("id", it) }
        }.toString()

        is CancelFrame -> JSONObject().apply {
            put("t", FrameType.CANCEL)
            put("id", frame.id)
        }.toString()

        is NoticeFrame -> JSONObject().apply {
            put("t", FrameType.NOTICE)
            put("kind", frame.kind)
            frame.homeId?.let { put("homeId", it) }
        }.toString()

        is UnknownFrame -> frame.raw
    }

    /**
     * 解析一帧；非法 JSON 或缺 `t` 视为**协议错误**（抛异常让上层重连），
     * 因为静默丢弃会让某条请求永远挂住。
     */
    fun decode(text: String): RelayFrame {
        val obj = try {
            JSONObject(text)
        } catch (e: JSONException) {
            throw RelayException("bad_request", "隧道帧不是合法 JSON：${text.take(120)}")
        }
        val type = obj.optString("t", "")
        if (type.isEmpty()) throw RelayException("bad_request", "隧道帧缺少 t 字段：${text.take(120)}")
        return when (type) {
            FrameType.HELLO -> HelloFrame(
                proto = obj.optInt("proto", 2),
                role = obj.optString("role", RelayRole.DEVICE),
                name = obj.optStringOrNull("name"),
            )

            FrameType.READY -> ReadyFrame(
                proto = obj.optInt("proto", 2),
                role = obj.optString("role", RelayRole.DEVICE),
                homeId = obj.optString("homeId", ""),
                homeName = obj.optStringOrNull("homeName"),
                // 缺省 true：中继没给这个字段时不该把 PC 判成离线
                homeOnline = if (obj.has("homeOnline")) obj.optBoolean("homeOnline", true) else true,
            )

            FrameType.ERROR -> ErrorFrame(
                code = obj.optString("code", "internal"),
                message = obj.optString("message", ""),
                fatal = if (obj.has("fatal")) obj.optBoolean("fatal", true) else true,
            )

            FrameType.REQ -> ReqFrame(
                id = obj.optLong("id", -1L),
                method = obj.optString("method", "GET"),
                path = obj.optString("path", ""),
                headers = jsonToHeaders(obj.optJSONObject("headers")),
                bodyB64 = obj.optStringOrNull("bodyB64"),
            )

            FrameType.RES -> ResFrame(
                id = obj.optLong("id", -1L),
                status = obj.optInt("status", 0),
                headers = jsonToHeaders(obj.optJSONObject("headers")),
            )

            FrameType.CHUNK -> ChunkFrame(
                id = obj.optLong("id", -1L),
                dataB64 = obj.optString("dataB64", ""),
            )

            FrameType.END -> EndFrame(id = obj.optLong("id", -1L))

            FrameType.ABORT -> AbortFrame(
                id = obj.optLong("id", -1L),
                reason = obj.optString("reason", ""),
            )

            FrameType.PING -> PingFrame(id = obj.optLongOrNull("id"))
            FrameType.PONG -> PongFrame(id = obj.optLongOrNull("id"))
            FrameType.CANCEL -> CancelFrame(id = obj.optLong("id", -1L))
            FrameType.NOTICE -> NoticeFrame(
                kind = obj.optString("kind", ""),
                homeId = obj.optStringOrNull("homeId"),
            )

            else -> UnknownFrame(wireType = type, raw = text)
        }
    }

    /**
     * 解析一个可能含多行 JSON 的文本帧（NDJSON）。
     *
     * 空行直接跳过；**单行解析失败只丢这一行**，不抛异常。
     *
     * 为什么不能抛：中继会把多条帧合并进一个 WebSocket 文本帧（心跳、end 常常和业务帧挤在一起），
     * 只要有一行被截断，整批就会一起解析失败——同批里完好的 `end`/`pong` 被静默丢掉，
     * 表现是"流永远不结束"，比重试一次难查得多。协议错误改由 [Logger] 留痕。
     * 需要严格语义时请直接用 [decode]（它仍然对单帧抛错）。
     */
    fun decodeLines(text: String): List<RelayFrame> {
        if (text.isBlank()) return emptyList()
        val trimmed = text.trim()
        // 快路径：绝大多数帧就是单行
        if (!trimmed.contains('\n')) return listOfNotNull(decodeOrNull(trimmed))
        return trimmed.split('\n')
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .mapNotNull { decodeOrNull(it) }
    }

    /** 单行解析失败返回 null 并留日志，见 [decodeLines]。 */
    private fun decodeOrNull(line: String): RelayFrame? =
        runCatching { decode(line) }.getOrElse { error ->
            Logger.w(TAG, "丢弃无法解析的隧道帧（${error.message}）：${line.take(120)}")
            null
        }

    fun encodeBody(body: ByteArray?): String? =
        body?.let { Base64.getEncoder().encodeToString(it) }

    /** 非法 Base64 返回 null，由调用方转成 `abort(reason=bad_chunk)`。 */
    fun decodeBody(dataB64: String): ByteArray? = try {
        Base64.getDecoder().decode(dataB64)
    } catch (e: IllegalArgumentException) {
        null
    }

    private fun headersToJson(headers: Map<String, String>): JSONObject = JSONObject().apply {
        headers.forEach { (k, v) -> put(k, v) }
    }

    private fun jsonToHeaders(obj: JSONObject?): Map<String, String> {
        if (obj == null) return emptyMap()
        val result = LinkedHashMap<String, String>()
        val keys: Iterator<String> = obj.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            result[key] = obj.optString(key, "")
        }
        return result
    }

    private fun JSONObject.optStringOrNull(key: String): String? =
        if (!has(key) || isNull(key)) null else optString(key, "").takeIf { it.isNotEmpty() }

    private fun JSONObject.optLongOrNull(key: String): Long? =
        if (!has(key) || isNull(key)) null else optLong(key)

    /** 供中继侧调试输出用（手机端只做断言）。 */
    fun typesOf(text: String): List<String> = decodeLines(text).map { it.type }

    internal fun arrayToString(array: JSONArray?): String = array?.toString().orEmpty()
}
