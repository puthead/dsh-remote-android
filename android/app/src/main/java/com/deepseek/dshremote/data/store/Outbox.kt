package com.deepseek.dshremote.data.store

import com.deepseek.dshremote.data.Logger
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/** 一条待发送的续聊请求（离线排队）。 */
data class PendingTurn(
    val sessionId: String,
    val prompt: String,
    val clientTurnId: String,
    val createdAt: Long,
    val attempts: Int = 0,
) {
    val preview: String get() = prompt.replace('\n', ' ').take(60)
}

/**
 * 待发队列（Outbox）。
 *
 * 场景：用户在电梯里点了"发送"，此时隧道断了。v1 的做法是直接报错、内容丢失；
 * v2 把请求排队，隧道恢复后自动补发（**幂等**：`clientTurnId` 由客户端生成并持久化，
 * 即使补发两次，网关也只会真正执行一次——这是契约 §4.2 里 `clientTurnId` 的用途）。
 */
class Outbox(private val file: File) {

    fun load(): List<PendingTurn> {
        if (!file.exists()) return emptyList()
        return runCatching { OutboxCodec.decode(file.readText(Charsets.UTF_8)) }
            .onFailure { Logger.w(TAG, "待发队列损坏，按空处理", it) }
            .getOrDefault(emptyList())
    }

    fun enqueue(turn: PendingTurn): List<PendingTurn> {
        val current = load().filterNot { it.clientTurnId == turn.clientTurnId } + turn
        persist(current)
        Logger.i(TAG, "续聊请求已入队 session=${turn.sessionId.take(20)} 队列长度=${current.size}")
        return current
    }

    fun remove(clientTurnId: String): List<PendingTurn> {
        val current = load().filterNot { it.clientTurnId == clientTurnId }
        persist(current)
        return current
    }

    /** 补发失败时累加尝试次数；超过 [MAX_ATTEMPTS] 由调用方决定丢弃并提示。 */
    fun markAttempt(clientTurnId: String): List<PendingTurn> {
        val current = load().map { if (it.clientTurnId == clientTurnId) it.copy(attempts = it.attempts + 1) else it }
        persist(current)
        return current
    }

    fun clear(): List<PendingTurn> {
        persist(emptyList())
        return emptyList()
    }

    private fun persist(turns: List<PendingTurn>) {
        runCatching {
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, file.name + ".tmp")
            val text = OutboxCodec.encode(turns)
            tmp.writeText(text, Charsets.UTF_8)
            // 先 rename 再兜底：POSIX 的 rename 会原子替换已存在的目标。旧写法"先 delete 再 rename"
            // 在两步之间留下窗口——此时进程被杀或磁盘满，旧队列已删、新队列未就位，
            // 用户离线排队的消息会**静默整体丢失**（load() 只会返回空列表，日志里什么都没有）。
            if (!tmp.renameTo(file)) {
                file.writeText(text, Charsets.UTF_8)
                tmp.delete()
            }
        }.onFailure { Logger.w(TAG, "写待发队列失败", it) }
    }

    companion object {
        const val MAX_ATTEMPTS = 3
        private const val TAG = "Outbox"

        fun defaultFile(filesDir: File): File = File(filesDir, "outbox.json")
    }
}

/** 队列的 JSON 编解码（纯函数，可单测）。 */
object OutboxCodec {

    fun encode(turns: List<PendingTurn>): String {
        val array = JSONArray()
        turns.forEach { turn ->
            array.put(
                JSONObject().apply {
                    put("sessionId", turn.sessionId)
                    put("prompt", turn.prompt)
                    put("clientTurnId", turn.clientTurnId)
                    put("createdAt", turn.createdAt)
                    put("attempts", turn.attempts)
                },
            )
        }
        return JSONObject().put("pending", array).toString()
    }

    /** 损坏的 JSON 返回空列表：待发队列坏掉不该让 App 起不来。 */
    fun decode(text: String): List<PendingTurn> {
        val root = runCatching { JSONObject(text) }.getOrNull() ?: return emptyList()
        val array = root.optJSONArray("pending") ?: return emptyList()
        val result = ArrayList<PendingTurn>(array.length())
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            val sessionId = item.optString("sessionId", "")
            val prompt = item.optString("prompt", "")
            if (sessionId.isEmpty() || prompt.isEmpty()) continue
            result += PendingTurn(
                sessionId = sessionId,
                prompt = prompt,
                clientTurnId = item.optString("clientTurnId", ""),
                createdAt = item.optLong("createdAt", 0L),
                attempts = item.optInt("attempts", 0),
            )
        }
        return result
    }
}
