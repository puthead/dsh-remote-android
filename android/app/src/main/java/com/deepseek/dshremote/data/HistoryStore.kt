package com.deepseek.dshremote.data

import java.io.File
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * 本地任务历史（契约 §7："终态落库（本地历史）"）。
 *
 * 为什么用单文件 JSON 而不是 SQLite/Room：
 * - 需求只要"离线看上次输出"，历史条数上限 [MAX_ENTRIES] 条，单文件足够；
 * - Room 会引入注解处理器与 KSP 版本耦合，对这个体量的 App 是净负担；
 * - 文件读写逻辑可以脱离 Android 单测（[HistoryStore] 只依赖 [File]）。
 *
 * 写入采用"临时文件 + 原子重命名"，避免进程被杀时留下半截 JSON 导致历史整体丢失。
 */
class HistoryStore(
    private val file: File,
    private val maxEntries: Int = MAX_ENTRIES,
) {
    private val mutex = Mutex()
    private var cache: List<RemoteTask>? = null

    /** 读取历史；首次读磁盘，之后走内存缓存。 */
    suspend fun load(): List<RemoteTask> = mutex.withLock {
        cache ?: readFromDisk().also { cache = it }
    }

    /**
     * 新增或覆盖一条任务，返回最新历史列表。
     *
     * 输出可能很大，这里按 [MAX_OUTPUT_CHARS] 截断**只截落库副本**；
     * 内存中的实时输出不截断，避免影响任务详情页展示。
     */
    suspend fun upsert(task: RemoteTask): List<RemoteTask> = mutex.withLock {
        val current = cache ?: readFromDisk().also { cache = it }
        val stored = task.copy(output = task.output.takeLastOutput())
        val merged = buildList {
            add(stored)
            current.forEach { if (it.id != stored.id) add(it) }
        }.sortedByDescending { it.createdAt }
            .take(maxEntries)
        cache = merged
        writeToDisk(merged)
        merged
    }

    suspend fun delete(taskId: String): List<RemoteTask> = mutex.withLock {
        val current = cache ?: readFromDisk().also { cache = it }
        val merged = current.filterNot { it.id == taskId }
        cache = merged
        writeToDisk(merged)
        merged
    }

    suspend fun clear(): List<RemoteTask> = mutex.withLock {
        cache = emptyList()
        writeToDisk(emptyList())
        emptyList()
    }

    private suspend fun readFromDisk(): List<RemoteTask> = withContext(Dispatchers.IO) {
        if (!file.exists()) return@withContext emptyList()
        val text = runCatching { file.readText(Charsets.UTF_8) }.getOrElse { e ->
            Logger.w(TAG, "历史文件读取失败，按空历史处理", e)
            return@withContext emptyList()
        }
        JsonCodec.tasksFromJson(text).sortedByDescending { it.createdAt }
    }

    private suspend fun writeToDisk(tasks: List<RemoteTask>) = withContext(Dispatchers.IO) {
        try {
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, file.name + ".tmp")
            tmp.writeText(JsonCodec.tasksToJson(tasks), Charsets.UTF_8)
            if (!tmp.renameTo(file)) {
                // 某些文件系统上 rename 会失败（目标被占用），退化为覆盖写
                file.writeText(tmp.readText(Charsets.UTF_8), Charsets.UTF_8)
                tmp.delete()
            }
        } catch (e: IOException) {
            Logger.w(TAG, "历史写入失败（不影响实时流）", e)
        }
    }

    /** 单条历史的输出上限：手机上看完 20 万字日志没有意义，反而拖慢 JSON 解析。 */
    private fun String.takeLastOutput(): String =
        if (length <= MAX_OUTPUT_CHARS) this else takeLast(MAX_OUTPUT_CHARS)

    companion object {
        const val MAX_ENTRIES = 100
        const val MAX_OUTPUT_CHARS = 200_000
        private const val TAG = "HistoryStore"

        /** 历史文件固定放在应用私有目录：不需要任何存储权限。 */
        fun defaultFile(filesDir: File): File = File(filesDir, "task-history.json")
    }
}
