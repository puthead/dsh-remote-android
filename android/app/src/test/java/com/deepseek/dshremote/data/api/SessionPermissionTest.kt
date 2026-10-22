package com.deepseek.dshremote.data.api

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 会话权限视图与新建任务权限回执（v2.11.0）。
 *
 * 三条产品约束：
 * 1. 旧网关没有 `permission` → null，界面显示"未知"，不许拿默认档假装知道；
 * 2. `editable` 缺省 false（宁可少给入口，也不画一个点了会 400 的开关）；
 * 3. 权限没生效（`permissionApplied=false`）必须在回执/文案里说清。
 */
class SessionPermissionTest {

    @Test
    fun `解析 permission 视图并保留 options 与 editable`() {
        val session = JsonV2.parseSession(
            JSONObject(
                """
                {
                  "id": "session-a", "title": "权限", "workspace": "D:\\ws",
                  "source": "computer", "writable": true, "driver": "desktop",
                  "permission": {
                    "currentValue": "danger-full-access",
                    "editable": true,
                    "source": "desktop",
                    "options": [
                      {"value":"read-only","name":"Read Only","description":"只读","selectable":true},
                      {"value":"workspace-write","name":"Workspace Write","description":"工作区","selectable":true},
                      {"value":"danger-full-access","name":"Full Access","description":"全部","selectable":true}
                    ]
                  }
                }
                """.trimIndent(),
            ),
        )
        val permission = session.permission
        assertTrue(permission != null)
        assertEquals("danger-full-access", permission!!.currentValue)
        assertEquals("全部权限", permission.currentLabel)
        assertTrue(permission.isDangerous)
        assertTrue(permission.editable)
        assertEquals(SessionPermission.SOURCE_DESKTOP, permission.source)
        assertEquals(3, permission.options.size)
        assertTrue(session.canEditPermission)
        assertEquals("仅工作区", permission.displayName("workspace-write"))
        assertEquals("只读", permission.displayName("read-only"))
    }

    @Test
    fun `旧网关没有 permission 时是 null，界面不许自己编默认档`() {
        val session = JsonV2.parseSession(JSONObject("""{"id":"session-b","source":"computer","writable":true}"""))
        assertNull(session.permission)
        assertFalse(session.canEditPermission)
        assertEquals("权限未知", session.permissionLabel)
    }

    @Test
    fun `权限视图不可编辑时仍显示当前档位（网关自有会话）`() {
        val session = JsonV2.parseSession(
            JSONObject(
                """
                {
                  "id": "session-c", "source": "phone",
                  "permission": {
                    "currentValue": "workspace-write", "editable": false,
                    "source": "gateway", "reason": "gateway_access_fixed",
                    "options": [
                      {"value":"workspace-write","name":"Workspace Write"},
                      {"value":"danger-full-access","name":"Full Access"}
                    ]
                  }
                }
                """.trimIndent(),
            ),
        )
        assertEquals("仅工作区", session.permission?.currentLabel)
        assertFalse(session.canEditPermission)
        assertEquals("gateway_access_fixed", session.permission?.reason)
    }

    @Test
    fun `解析新建任务的权限回执（成功与软失败）`() {
        val ok = JsonV2.parseCreateTask(
            """
            {
              "sessionId":"session-a","accepted":true,"source":"computer","host":"desktop",
              "access":"full","permissionApplied":true,
              "permission":{"currentValue":"danger-full-access","editable":true,"source":"desktop"}
            }
            """.trimIndent(),
        )
        assertEquals(true, ok.permissionApplied)
        assertEquals(TaskAccess.FULL, ok.taskAccess)
        assertEquals("全部权限", ok.permission?.currentLabel)
        assertTrue(ok.placementNote().contains("全部权限"))

        val softFail = JsonV2.parseCreateTask(
            """{"sessionId":"session-b","accepted":true,"source":"computer","host":"desktop","permissionApplied":false,"permissionWarning":"桌面端拒绝执行"}""",
        )
        assertEquals(false, softFail.permissionApplied)
        assertEquals("桌面端拒绝执行", softFail.permissionWarning)
        assertTrue(softFail.placementNote().contains("权限没切上"))
    }

    @Test
    fun `没有 permissionApplied 也没有 warning 时是 null（旧网关或没请求）`() {
        val legacy = JsonV2.parseCreateTask("""{"sessionId":"session-c","source":"computer","host":"desktop"}""")
        assertNull(legacy.permissionApplied)
        assertNull(legacy.permissionWarning)
        assertNull(legacy.permission)
    }

    @Test
    fun `离线缓存往返不丢权限视图`() {
        val session = JsonV2.parseSession(
            JSONObject(
                """
                {"id":"session-d","source":"computer","writable":true,
                 "permission":{"currentValue":"read-only","editable":true,"source":"desktop",
                   "options":[{"value":"read-only","name":"Read Only"},{"value":"workspace-write","name":"Workspace Write"}]}}
                """.trimIndent(),
            ),
        )
        val restored = JsonV2.sessionsFromJson(JsonV2.sessionsToJson(listOf(session))).first()
        assertEquals("read-only", restored.permission?.currentValue)
        assertEquals("只读", restored.permission?.currentLabel)
        assertTrue(restored.permission?.editable == true)
        assertEquals(2, restored.permission?.options?.size)
    }
}
