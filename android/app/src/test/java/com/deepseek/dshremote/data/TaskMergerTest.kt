package com.deepseek.dshremote.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** [TaskMerger] 的归并规则测试（状态只进不退、输出取更长、字段缺失不覆盖）。 */
class TaskMergerTest {

    private fun running(id: String = "task_1") = RemoteTask(
        id = id,
        title = "跑单测",
        prompt = "跑单测",
        workspace = "D:\\proj",
        status = TaskStatus.RUNNING,
        createdAt = 100,
        startedAt = 200,
        output = "部分输出",
    )

    @Test
    fun `本地为空时直接采用服务端对象`() {
        val incoming = RemoteTask(id = "t", status = TaskStatus.QUEUED, createdAt = 1)
        assertEquals(incoming, TaskMerger.merge(null, incoming))
    }

    @Test
    fun `终态不会被后续活动态快照覆盖`() {
        val local = running().copy(status = TaskStatus.SUCCEEDED, finishedAt = 300, exitCode = 0)
        val stale = running(status = TaskStatus.RUNNING)
        val merged = TaskMerger.merge(local, stale)
        assertEquals(TaskStatus.SUCCEEDED, merged.status)
        assertEquals(0, merged.exitCode)
        assertEquals(300L, merged.finishedAt)
    }

    @Test
    fun `输出取更长的那个`() {
        val local = running().copy(output = "很长很长的本地拼接输出")
        val shorter = running().copy(output = "短")
        assertEquals("很长很长的本地拼接输出", TaskMerger.merge(local, shorter).output)

        val longer = running().copy(output = "服务端更完整的输出内容")
        assertEquals("服务端更完整的输出内容", TaskMerger.merge(local, longer).output)
    }

    @Test
    fun `服务端缺失字段不覆盖本地已有值`() {
        val partial = RemoteTask(id = "task_1", status = TaskStatus.RUNNING)
        val merged = TaskMerger.merge(running(), partial)
        assertEquals("跑单测", merged.title)
        assertEquals("D:\\proj", merged.workspace)
        assertEquals(100L, merged.createdAt)
        assertEquals(200L, merged.startedAt)
        assertTrue(merged.error == null)
    }

    @Test
    fun `错误与截断标记会被保留`() {
        val local = running().copy(truncated = true)
        val incoming = running().copy(status = TaskStatus.FAILED, error = "命令返回非 0", exitCode = 1)
        val merged = TaskMerger.merge(local, incoming)
        assertEquals(TaskStatus.FAILED, merged.status)
        assertEquals("命令返回非 0", merged.error)
        assertEquals(1, merged.exitCode)
        assertTrue(merged.truncated)
    }

    @Test
    fun `终态任务落库前保留完整输出`() {
        val local = running().copy(output = "line1\nline2\n")
        val finished = running().copy(
            status = TaskStatus.SUCCEEDED,
            finishedAt = 400,
            exitCode = 0,
            output = "line1\nline2\n",
        )
        val merged = TaskMerger.merge(local, finished)
        assertEquals("line1\nline2\n", merged.output)
        assertEquals(200L, merged.durationMs(now = 999))
        assertNull(merged.error)
    }
}
