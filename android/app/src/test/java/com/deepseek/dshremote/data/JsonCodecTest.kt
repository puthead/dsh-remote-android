package com.deepseek.dshremote.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 契约 v1 的 JSON 解析测试：字段缺失/为 null/未知枚举都必须能不炸。 */
class JsonCodecTest {

    @Test
    fun `解析 health 全字段`() {
        val health = JsonCodec.parseHealth(
            """
            {
              "ok": true,
              "apiVersion": 1,
              "serverName": "DESKTOP-XXX",
              "gatewayVersion": "1.0.0",
              "dshVersion": "0.1.0-rc.7",
              "uptimeMs": 123456,
              "activeTasks": 1,
              "queuedTasks": 0,
              "pairingOpen": true,
              "authRequired": true,
              "capabilities": ["tasks", "events", "pairing", "workspaces", "cancel"]
            }
            """.trimIndent(),
        )
        assertTrue(health.ok)
        assertEquals("DESKTOP-XXX", health.serverName)
        assertEquals(5, health.capabilities.size)
        assertEquals(123456L, health.uptimeMs)
    }

    @Test
    fun `解析 Task 的空值字段`() {
        val task = JsonCodec.parseTask(
            """
            {
              "id": "task_01J",
              "title": "跑单测",
              "prompt": "帮我把 D:\\proj 的单元测试跑一遍",
              "workspace": "D:\\proj",
              "status": "queued",
              "createdAt": 1730000000000,
              "startedAt": null,
              "finishedAt": null,
              "exitCode": null,
              "output": "",
              "error": null,
              "truncated": false,
              "sessionId": null
            }
            """.trimIndent(),
        )
        assertEquals("task_01J", task.id)
        assertEquals(TaskStatus.QUEUED, task.status)
        assertNull(task.startedAt)
        assertNull(task.exitCode)
        assertNull(task.error)
        assertNull(task.sessionId)
        assertTrue(task.status.isActive)
    }

    @Test
    fun `解析终态 Task`() {
        val task = JsonCodec.parseTask(
            """
            {
              "id": "task_2", "title": "t", "prompt": "p", "workspace": "D:\\proj",
              "status": "failed", "createdAt": 1, "startedAt": 2, "finishedAt": 3,
              "exitCode": 1, "output": "boom", "error": "命令返回非 0",
              "truncated": true, "sessionId": "sess_1"
            }
            """.trimIndent(),
        )
        assertEquals(TaskStatus.FAILED, task.status)
        assertTrue(task.status.isTerminal)
        assertEquals(1, task.exitCode)
        assertEquals("命令返回非 0", task.error)
        assertTrue(task.truncated)
        assertEquals(1L, task.durationMs(now = 999))
    }

    @Test
    fun `解析 task output 事件的转义换行`() {
        val event = JsonCodec.parseEvent(
            """
            {"seq":42,"taskId":"task_01J","at":1730000001000,"type":"task.output","delta":"正在读取文件…\n完成\n"}
            """.trimIndent(),
        )
        requireNotNull(event)
        assertEquals(42L, event.seq)
        assertEquals(TaskEventType.TASK_OUTPUT, event.type)
        // JSON 转义必须还原成真实换行，供 UI 逐行渲染
        assertEquals("正在读取文件…\n完成\n", event.delta)
    }

    @Test
    fun `解析 task finished 事件内的完整任务对象`() {
        val event = JsonCodec.parseEvent(
            """
            {"seq":7,"taskId":"task_9","at":5,"type":"task.finished",
             "task":{"id":"task_9","title":"t","prompt":"p","workspace":"D:\\proj","status":"succeeded",
                     "createdAt":1,"startedAt":2,"finishedAt":3,"exitCode":0,"output":"done","error":null,
                     "truncated":false,"sessionId":"s"}}
            """.trimIndent(),
        )
        requireNotNull(event)
        assertEquals(TaskEventType.TASK_FINISHED, event.type)
        assertEquals(TaskStatus.SUCCEEDED, event.task?.status)
        assertEquals("done", event.task?.output)
    }

    @Test
    fun `非法事件返回 null 而不是抛异常`() {
        assertNull(JsonCodec.parseEvent("not json"))
        assertNull(JsonCodec.parseEvent("""{"taskId":"t"}""")) // 缺 seq
        assertNull(JsonCodec.parseEvent("""{"seq":1}""")) // 缺 taskId
    }

    @Test
    fun `未知事件类型不吞掉整条事件`() {
        val event = JsonCodec.parseEvent(
            """{"seq":3,"taskId":"t","at":1,"type":"task.future.thing"}""",
        )
        requireNotNull(event)
        assertEquals(TaskEventType.UNKNOWN, event.type)
        assertEquals(3L, event.seq)
    }

    @Test
    fun `解析 workspaces`() {
        val result = JsonCodec.parseWorkspaces(
            """
            {"workspaces":[{"path":"D:\\proj","label":"proj","exists":true},
                           {"path":"D:\\gone","label":"gone","exists":false}],
             "default":"D:\\proj"}
            """.trimIndent(),
        )
        assertEquals(2, result.workspaces.size)
        assertEquals("D:\\proj", result.default)
        assertEquals("proj", result.workspaces[0].label)
        assertTrue(!result.workspaces[1].exists)
    }

    @Test
    fun `解析 pair claim`() {
        val claim = JsonCodec.parsePairClaim(
            """{"token":"dshr_abc","tokenId":"tok_1","serverName":"DESKTOP-XXX","expiresAt":null}""",
        )
        assertEquals("dshr_abc", claim.token)
        assertNull(claim.expiresAt)
    }

    @Test
    fun `解析统一错误体`() {
        val error = JsonCodec.parseError(
            """{"error":{"code":"unauthorized","message":"设备令牌无效或已吊销"}}""",
            httpStatus = 401,
            fallbackMessage = "x",
        )
        assertEquals("unauthorized", error.code)
        assertEquals("设备令牌无效或已吊销", error.message)
        assertTrue(error.isUnauthorized)
    }

    @Test
    fun `错误体不是 JSON 时按状态码兜底`() {
        val error = JsonCodec.parseError("<html>502 Bad Gateway</html>", 502, "网关错误")
        assertEquals("internal", error.code)
        assertEquals("网关错误", error.message)
        assertEquals(502, error.httpStatus)
    }

    @Test
    fun `任务历史序列化往返`() {
        val tasks = listOf(
            RemoteTask(
                id = "task_1",
                title = "跑单测",
                prompt = "跑单测",
                workspace = "D:\\proj",
                status = TaskStatus.SUCCEEDED,
                createdAt = 1,
                startedAt = 2,
                finishedAt = 3,
                exitCode = 0,
                output = "第一行\n第二行 with \"quotes\" 和中文",
                truncated = false,
                sessionId = "sess",
            ),
            RemoteTask(id = "task_2", status = TaskStatus.CANCELED, createdAt = 9),
        )
        val json = JsonCodec.tasksToJson(tasks)
        val restored = JsonCodec.tasksFromJson(json)
        assertEquals(tasks, restored)
    }

    @Test
    fun `历史文件损坏时返回空列表`() {
        assertTrue(JsonCodec.tasksFromJson("{ truncated").isEmpty())
    }

    @Test
    fun `状态合并不允许从终态回退`() {
        assertEquals(TaskStatus.SUCCEEDED, TaskStatus.later(TaskStatus.SUCCEEDED, TaskStatus.RUNNING))
        assertEquals(TaskStatus.FAILED, TaskStatus.later(TaskStatus.QUEUED, TaskStatus.FAILED))
        assertEquals(TaskStatus.RUNNING, TaskStatus.later(TaskStatus.QUEUED, TaskStatus.RUNNING))
    }
}
