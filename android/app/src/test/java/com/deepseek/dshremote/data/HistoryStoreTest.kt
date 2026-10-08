package com.deepseek.dshremote.data

import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** 本地历史的落盘/读回，包含"文件损坏不能让 App 崩"的降级行为。 */
class HistoryStoreTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun task(id: String, status: TaskStatus, createdAt: Long, output: String = "out") =
        RemoteTask(id = id, title = id, prompt = "p", workspace = "D:\\proj", status = status, createdAt = createdAt, output = output)

    @Test
    fun `upsert 后可以读回`() = runBlocking {
        val store = HistoryStore(File(tmp.root, "history.json"))
        store.upsert(task("task_1", TaskStatus.SUCCEEDED, 10))

        val reopened = HistoryStore(File(tmp.root, "history.json"))
        val loaded = reopened.load()
        assertEquals(1, loaded.size)
        assertEquals("task_1", loaded[0].id)
        assertEquals(TaskStatus.SUCCEEDED, loaded[0].status)
    }

    @Test
    fun `同 id 重复 upsert 只保留最新`() = runBlocking {
        val store = HistoryStore(File(tmp.root, "history.json"))
        store.upsert(task("task_1", TaskStatus.RUNNING, 10, output = "部分输出"))
        val list = store.upsert(task("task_1", TaskStatus.SUCCEEDED, 10, output = "完整输出\n第二行"))

        assertEquals(1, list.size)
        assertEquals(TaskStatus.SUCCEEDED, list[0].status)
        assertEquals("完整输出\n第二行", list[0].output)
    }

    @Test
    fun `按创建时间倒序且受条数上限约束`() = runBlocking {
        val store = HistoryStore(File(tmp.root, "history.json"), maxEntries = 3)
        (1..5).forEach { store.upsert(task("task_$it", TaskStatus.SUCCEEDED, it.toLong() * 100)) }

        val list = store.load()
        assertEquals(3, list.size)
        assertEquals(listOf("task_5", "task_4", "task_3"), list.map { it.id })
    }

    @Test
    fun `超长输出只截断落库副本`() = runBlocking {
        val store = HistoryStore(File(tmp.root, "history.json"))
        val huge = "x".repeat(HistoryStore.MAX_OUTPUT_CHARS + 5_000)
        val list = store.upsert(task("task_1", TaskStatus.SUCCEEDED, 1, output = huge))

        assertEquals(HistoryStore.MAX_OUTPUT_CHARS, list[0].output.length)
        // 截断保留尾部：用户最关心的是最后发生了什么
        assertTrue(huge.endsWith(list[0].output))
    }

    @Test
    fun `删除与清空`() = runBlocking {
        val store = HistoryStore(File(tmp.root, "history.json"))
        store.upsert(task("task_1", TaskStatus.SUCCEEDED, 1))
        store.upsert(task("task_2", TaskStatus.FAILED, 2))

        assertEquals(1, store.delete("task_1").size)
        assertTrue(store.clear().isEmpty())
        assertTrue(store.load().isEmpty())
    }

    @Test
    fun `历史文件损坏时按空历史处理`() = runBlocking {
        val file = File(tmp.root, "history.json")
        file.writeText("{ 这不是合法 JSON")

        val store = HistoryStore(file)
        assertTrue(store.load().isEmpty())
        // 损坏文件不应阻止后续写入
        assertEquals(1, store.upsert(task("task_1", TaskStatus.SUCCEEDED, 1)).size)
        assertFalse(file.readText().startsWith("{"))
    }

    @Test
    fun `目录不存在时自动创建`() = runBlocking {
        val file = File(File(tmp.root, "nested/dir"), "history.json")
        val store = HistoryStore(file)
        store.upsert(task("task_1", TaskStatus.CANCELED, 1))
        assertTrue(file.exists())
    }
}
