package com.deepseek.dshremote.data.api

import com.deepseek.dshremote.data.ApiException
import com.deepseek.dshremote.data.Logger
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException

/**
 * 一张会话图片的取字节结果。
 *
 * 刻意**不**在这里解码成 `Bitmap`：解码需要 android.graphics，而本文件是纯 JVM 可测的
 * （JVM 单测里 android.jar 是空壳）。解码放在界面层（`BitmapFactory`），
 * 于是"缓存/去重/失败文案"这些真正容易写错的逻辑可以在单测里跑穿。
 */
sealed interface ImageLoadResult {
    data class Ready(val bytes: ByteArray) : ImageLoadResult {
        // ByteArray 的 equals 是引用比较，data class 生成的 equals 会骗人；
        // 这里显式按内容比，避免单测里断言一个"看起来一样"的结果却失败。
        override fun equals(other: Any?): Boolean =
            this === other || (other is Ready && bytes.contentEquals(other.bytes))

        override fun hashCode(): Int = bytes.contentHashCode()
    }

    data class Failed(val message: String) : ImageLoadResult
}

/**
 * 图片取字节的统一入口（界面只依赖这个接口，不依赖仓库/网络）。
 *
 * `fun interface` + 默认 [None] 的用意：Composable 的入参可以写成
 * `images: ImageLoader = ImageLoader.None`，于是"渲染一张图"这件事在预览/单测里可以不接网络，
 * 也不会多一层可空判断。
 */
fun interface ImageLoader {
    suspend fun load(ref: ImageRef): ImageLoadResult

    companion object {
        /** 不接网络的空实现：任何请求都返回失败，界面据此显示占位与原因。 */
        val None: ImageLoader = ImageLoader { ImageLoadResult.Failed("图片加载未接入") }
    }
}

/**
 * 附件图片的加载器：**内存 LRU + 磁盘缓存 + 同 id 请求合并**。
 *
 * 为什么值得单独写一层，而不是每次 `BitmapFactory.decodeStream`：
 *
 * 1. **同 id 会被请求很多次**。一条消息里的图在 LazyColumn 里滚出滚入会反复组合，
 *    不做缓存就是"每滑一次重下一次 700 KiB"；
 * 2. **内容寻址 ⇒ 永不失效**。id 是 `sha256:<hex>`，字节不可能变，所以缓存不需要 TTL、
 *    不需要失效逻辑，磁盘上可以一直留着（这也让"离线看已读会话里的图"成立）；
 * 3. **并发去重**：同一张图可能同时被"消息气泡"和"全屏查看器"请求，
 *    没有 [inflight] 就会发两遍（大图上是肉眼可见的浪费）。
 *
 * 线程模型：所有状态由 [lock] 保护，[load] 是挂起函数但**不持有锁**等待网络
 * —— 先取到 `CompletableDeferred` 的所有权，再去请求，其余人 await 同一个结果。
 * 这正是"锁只保护表结构、不保护 IO"的写法。
 *
 * @param fetch 真正取字节的动作（生产环境是 [DshApiV2.fetchAttachment]）。
 * @param diskDir 磁盘缓存目录；null = 只做内存缓存（单测/无 Context 场景）。
 * @param memoryCapacityBytes 内存缓存上限（**按字节**而不是条数：一张 8 MiB 的图和
 *   一张 20 KiB 的缩略图对内存的压力差三个数量级，按条数算没有意义）。
 */
class AttachmentImageLoader(
    private val fetch: suspend (String) -> ByteArray,
    private val diskDir: File? = null,
    private val memoryCapacityBytes: Long = DEFAULT_MEMORY_BYTES,
) : ImageLoader {

    private val lock = Any()

    /** accessOrder = true：读一次就挪到队尾，淘汰时从队首（最久未用）开始。 */
    private val memory = LinkedHashMap<String, ByteArray>(16, 0.75f, true)

    private var memoryBytes = 0L

    private val inflight = HashMap<String, CompletableDeferred<ImageLoadResult>>()

    override suspend fun load(ref: ImageRef): ImageLoadResult {
        if (!ref.isFetchable) return ImageLoadResult.Failed("图片引用不完整，无法取回")
        memoryGet(ref.id)?.let { return ImageLoadResult.Ready(it) }

        val (pending, owner) = synchronized(lock) {
            val existing = inflight[ref.id]
            if (existing != null) {
                existing to false
            } else {
                CompletableDeferred<ImageLoadResult>() to true
            }
        }
        if (!owner) return pending.await()
        synchronized(lock) { inflight[ref.id] = pending }

        val result = try {
            ImageLoadResult.Ready(fetchThrough(ref.id))
        } catch (e: CancellationException) {
            // 调用方（界面）退出导致的取消不是"加载失败"：把等待者一起取消，别把失败缓存起来。
            synchronized(lock) { inflight.remove(ref.id) }
            pending.cancel(e)
            throw e
        } catch (t: Throwable) {
            Logger.w(TAG, "附件加载失败 id=${ref.id.take(20)}… ${t.javaClass.simpleName}: ${t.message}")
            ImageLoadResult.Failed(friendly(t))
        }

        synchronized(lock) { inflight.remove(ref.id) }
        pending.complete(result)
        return result
    }

    /** 磁盘 → 网络 → 落盘 → 进内存。任何一步失败都当作整体失败（不做"半张图"）。 */
    private suspend fun fetchThrough(id: String): ByteArray {
        diskFile(id)?.takeIf { it.isFile && it.length() > 0 }?.let { cached ->
            val bytes = cached.readBytes()
            putMemory(id, bytes)
            return bytes
        }
        val bytes = fetch(id)
        if (bytes.isEmpty()) throw IllegalStateException("服务端返回了空图片")
        if (bytes.size > MAX_IMAGE_BYTES) {
            throw IllegalStateException("图片过大（${bytes.size / 1024} KiB），已放弃缓存")
        }
        putMemory(id, bytes)
        // 落盘是**尽力而为**：磁盘满/无权限不该让"已经下载成功的图"显示失败。
        diskFile(id)?.let { file ->
            runCatching {
                file.parentFile?.mkdirs()
                // 先写临时文件再改名：进程被杀时不会留下一个"长度对、内容是半张"的缓存，
                // 而半张的 PNG 解码失败会被误当成"这张图坏了"。
                val tmp = File(file.parentFile, "${file.name}.tmp")
                tmp.writeBytes(bytes)
                if (!tmp.renameTo(file)) {
                    file.writeBytes(bytes)
                    tmp.delete()
                }
            }.onFailure { t -> Logger.w(TAG, "附件落盘失败 ${file.name}: ${t.message}") }
        }
        return bytes
    }

    private fun memoryGet(id: String): ByteArray? = synchronized(lock) { memory[id] }

    private fun putMemory(id: String, bytes: ByteArray) {
        synchronized(lock) {
            memory[id]?.let { memoryBytes -= it.size }
            memory[id] = bytes
            memoryBytes += bytes.size
            val iterator = memory.entries.iterator()
            while (memoryBytes > memoryCapacityBytes && iterator.hasNext()) {
                val entry = iterator.next()
                memoryBytes -= entry.value.size
                iterator.remove()
            }
        }
    }

    /** 文件名里不能有 `:`（Windows 会把冒号当盘符分隔），故只取哈希部分。 */
    private fun diskFile(id: String): File? {
        val dir = diskDir ?: return null
        val hash = id.substringAfter(':', id).takeIf { it.isNotEmpty() } ?: return null
        return File(dir, "$hash.bin")
    }

    private fun friendly(t: Throwable): String = when (t) {
        is ApiException -> t.message
        else -> t.message
    }?.takeIf { it.isNotBlank() } ?: "图片加载失败"

    companion object {
        private const val TAG = "AttachmentImage"

        /**
         * 内存缓存上限：24 MiB。
         *
         * 取值理由：上限内够放 ~30 张 700 KiB 的聊天图（大概是一屏到两屏的可见量），
         * 又不至于在低端机上和 Compose 自己的图片缓存抢内存（Android 默认堆常见 192–512 MiB）。
         */
        const val DEFAULT_MEMORY_BYTES = 24L * 1024 * 1024

        /** 单张图的上限：与网关的 8 MiB 对齐，再留一点余量给"服务端换了实现"的情况。 */
        const val MAX_IMAGE_BYTES = 12 * 1024 * 1024

        /** 生产环境的缓存目录：`filesDir/attachments`（与 SessionCache 同一层，便于一起清理）。 */
        fun defaultDir(filesDir: File): File = File(filesDir, "attachments")
    }
}
