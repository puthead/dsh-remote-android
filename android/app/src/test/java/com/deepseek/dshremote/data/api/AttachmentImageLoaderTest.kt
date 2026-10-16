package com.deepseek.dshremote.data.api

import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 附件图片加载器：**内存 LRU + 磁盘缓存 + 同 id 请求合并**。
 *
 * 为什么这些用例值得写：图片是这条链路上唯一"体积大 + 会被反复请求"的东西。
 * 缓存写错的表现不是崩溃，而是"每滑一次列表就重下 700 KiB"——性能问题不会有人报 bug，
 * 只会觉得"这 App 很卡"。所以这里逐个钉住：命中不再取、并发只取一次、
 * **失败不进缓存**（否则一次超时就永久坏一张图）、内容寻址的磁盘缓存可以跨实例复用。
 */
class AttachmentImageLoaderTest {

    private val id = "sha256:3d0e4bafd3ab66872856c9bf7c3c74029660b027eba6c25e0dbf93048dbe9fb9"
    private val otherId = "sha256:aa0e4bafd3ab66872856c9bf7c3c74029660b027eba6c25e0dbf93048dbe9fb9"

    private fun ref(id: String = "sha256:3d0e4bafd3ab66872856c9bf7c3c74029660b027eba6c25e0dbf93048dbe9fb9") =
        ImageRef(id = id, mediaType = "image/png", width = 4, height = 4, bytes = 8)

    private fun tempDir(): File = Files.createTempDirectory("dsh-attach-test").toFile()

    private fun bytes(n: Int, seed: Byte = 7): ByteArray = ByteArray(n) { (it + seed).toByte() }

    @Test
    fun `同一张图只取一次`() = runTest {
        var fetches = 0
        val payload = bytes(64)
        val loader = AttachmentImageLoader(fetch = { fetches++; payload })

        val first = loader.load(ref())
        val second = loader.load(ref())

        assertEquals(1, fetches)
        assertArrayEquals(payload, (first as ImageLoadResult.Ready).bytes)
        assertEquals("第二次必须命中缓存且结果与第一次相同", first, second)
    }

    @Test
    fun `同时打开气泡与全屏查看器只发一次请求`() = runTest {
        var fetches = 0
        val payload = bytes(128)
        val gate = CompletableDeferred<Unit>()
        val loader = AttachmentImageLoader(fetch = {
            fetches++
            // 卡在这里让四个请求真正重叠：没有 inflight 合并的话它们会各取一遍
            gate.await()
            payload
        })

        val jobs = List(4) { async { loader.load(ref()) } }
        yield()
        gate.complete(Unit)
        val results = jobs.awaitAll()

        assertEquals(1, fetches)
        assertTrue(results.all { it is ImageLoadResult.Ready && it.bytes.contentEquals(payload) })
    }

    @Test
    fun `失败不进缓存 下一次还会重试`() = runTest {
        var fetches = 0
        val loader = AttachmentImageLoader(fetch = {
            fetches++
            if (fetches == 1) throw IllegalStateException("隧道断了") else bytes(32)
        })

        val failed = loader.load(ref())
        assertTrue(failed is ImageLoadResult.Failed)
        assertEquals("隧道断了", (failed as ImageLoadResult.Failed).message)

        // 关键：失败必须能被重试。若把 Failed 缓存起来，用户会永远看到"图片损坏"
        val retried = loader.load(ref())
        assertTrue(retried is ImageLoadResult.Ready)
        assertEquals(2, fetches)
    }

    @Test
    fun `引用不完整时不去请求`() = runTest {
        var fetches = 0
        val loader = AttachmentImageLoader(fetch = { fetches++; bytes(8) })

        val result = loader.load(ImageRef(id = "3d0e4bafd3ab66", width = 10, height = 10))

        assertEquals(0, fetches)
        assertTrue(result is ImageLoadResult.Failed)
    }

    @Test
    fun `空响应算失败而不是当成一张零字节的图`() = runTest {
        var fetches = 0
        val loader = AttachmentImageLoader(fetch = { fetches++; ByteArray(0) })

        val result = loader.load(ref())

        assertTrue(result is ImageLoadResult.Failed)
        assertTrue((result as ImageLoadResult.Failed).message.contains("空"))
        // 失败不缓存：下一屏再滚回来应该还能重试
        loader.load(ref())
        assertEquals(2, fetches)
    }

    @Test
    fun `超过上限的图被拒绝而不是把内存塞满`() = runTest {
        val loader = AttachmentImageLoader(fetch = { ByteArray(AttachmentImageLoader.MAX_IMAGE_BYTES + 1) })

        val result = loader.load(ref())

        assertTrue(result is ImageLoadResult.Failed)
        assertTrue((result as ImageLoadResult.Failed).message.contains("过大"))
    }

    @Test
    fun `磁盘缓存跨实例复用且不再发请求`() = runTest {
        val dir = tempDir()
        var fetches = 0
        val payload = bytes(256)
        val first = AttachmentImageLoader(fetch = { fetches++; payload }, diskDir = dir)

        assertArrayEquals(payload, (first.load(ref()) as ImageLoadResult.Ready).bytes)
        assertEquals(1, fetches)
        // 落盘是尽力而为，但单测里磁盘一定可用——文件必须真的在
        val cached = File(dir, id.substringAfter(':') + ".bin")
        assertTrue("落盘缓存应存在：${cached.name}", cached.isFile)

        // 新实例（模拟进程重启）应该直接从磁盘拿，不再打网络
        val second = AttachmentImageLoader(fetch = { fetches++; payload }, diskDir = dir)
        assertArrayEquals(payload, (second.load(ref()) as ImageLoadResult.Ready).bytes)
        assertEquals(1, fetches)
    }

    @Test
    fun `内存上限按字节淘汰最久未用的一张`() = runTest {
        val payload = bytes(80)
        val loads = mutableListOf<String>()
        val loader = AttachmentImageLoader(
            fetch = { requested -> loads += requested; payload },
            memoryCapacityBytes = 100,
        )

        loader.load(ref(id))
        loader.load(ref(otherId))
        // 容量只够一张：先取的那张应被淘汰
        loader.load(ref(id))

        assertEquals(3, loads.size)
        assertEquals(listOf(id, otherId, id), loads)
    }

    @Test
    fun `不接网络的空实现给出可读原因`() = runTest {
        val result = ImageLoader.None.load(ref())
        assertTrue(result is ImageLoadResult.Failed)
        assertFalse((result as ImageLoadResult.Failed).message.isBlank())
    }
}
