package com.deepseek.dshremote.data.store

import com.deepseek.dshremote.data.Logger
import com.deepseek.dshremote.data.api.ChatMessage
import com.deepseek.dshremote.data.api.JsonV2
import com.deepseek.dshremote.data.api.SessionSummary
import java.io.File

/**
 * 会话镜像的本地缓存（离线可看）。
 *
 * 目的：手机在地铁里没信号时，**已经看过的**会话列表与对话内容仍然能打开，
 * 而不是一片空白。缓存是 best-effort：任何读写失败都退化成"没有缓存"，绝不抛给 UI。
 *
 * 落盘结构（`filesDir/console-cache/`）：
 * - `sessions.json`      —— 会话列表
 * - `transcript-<id>.json` —— 每个会话的对话记录（id 做文件名安全化）
 */
class SessionCache(private val dir: File) {

    fun loadSessions(): List<SessionSummary> {
        val file = File(dir, SESSIONS_FILE)
        if (!file.exists()) return emptyList()
        return runCatching { JsonV2.sessionsFromJson(file.readText(Charsets.UTF_8)) }
            .onFailure { Logger.w(TAG, "会话缓存损坏，按空处理", it) }
            .getOrDefault(emptyList())
    }

    fun saveSessions(sessions: List<SessionSummary>) {
        if (sessions.isEmpty()) return
        writeAtomically(File(dir, SESSIONS_FILE), JsonV2.sessionsToJson(sessions))
    }

    fun loadTranscript(sessionId: String): List<ChatMessage> {
        val file = File(dir, transcriptFile(sessionId))
        if (!file.exists()) return emptyList()
        return runCatching { JsonV2.messagesFromJson(file.readText(Charsets.UTF_8)) }
            .onFailure { Logger.w(TAG, "对话缓存损坏，按空处理", it) }
            .getOrDefault(emptyList())
    }

    fun saveTranscript(sessionId: String, messages: List<ChatMessage>) {
        if (sessionId.isEmpty() || messages.isEmpty()) return
        writeAtomically(File(dir, transcriptFile(sessionId)), JsonV2.messagesToJson(messages))
    }

    fun hasSessionsCache(): Boolean = File(dir, SESSIONS_FILE).exists()

    fun clear() {
        runCatching { dir.listFiles()?.forEach { it.delete() } }
    }

    private fun writeAtomically(target: File, content: String) {
        runCatching {
            if (!dir.exists()) dir.mkdirs()
            val tmp = File(dir, target.name + ".tmp")
            tmp.writeText(content, Charsets.UTF_8)
            // 先 rename 再兜底：POSIX 的 rename 会原子替换已存在的目标。旧写法"先 delete 再 rename"
            // 在两步之间留下窗口——此时进程被杀或磁盘满，旧缓存已删、新缓存未就位，
            // 离线内容会整体消失（loadSessions/loadTranscript 静默返回空，日志里什么都没有）。
            if (!tmp.renameTo(target)) {
                target.writeText(content, Charsets.UTF_8)
                tmp.delete()
            }
        }.onFailure { Logger.w(TAG, "写缓存失败 ${target.name}", it) }
    }

    private fun transcriptFile(sessionId: String): String = "transcript-${safeName(sessionId)}.json"

    companion object {
        private const val TAG = "SessionCache"
        private const val SESSIONS_FILE = "sessions.json"

        fun defaultDir(filesDir: File): File = File(filesDir, "console-cache")

        /** 文件名安全化：只留字母数字与 `-`/`_`，其余折叠成 `_`（会话 id 里本来只有这些）。 */
        fun safeName(sessionId: String): String {
            val cleaned = sessionId.map { if (it.isLetterOrDigit() || it == '-' || it == '_') it else '_' }
                .joinToString("")
            return if (cleaned.length <= 96) cleaned else cleaned.take(80) + "_" + sessionId.hashCode()
        }
    }
}
