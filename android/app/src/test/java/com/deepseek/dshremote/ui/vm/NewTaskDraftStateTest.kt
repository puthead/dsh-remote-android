package com.deepseek.dshremote.ui.vm

import com.deepseek.dshremote.data.api.ModelCatalog
import com.deepseek.dshremote.data.api.ModelEntry
import com.deepseek.dshremote.data.api.ModelFailure
import com.deepseek.dshremote.data.api.ModelGroup
import com.deepseek.dshremote.data.api.ModelSelection
import com.deepseek.dshremote.data.api.TaskAccess
import com.deepseek.dshremote.data.api.TaskHost
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「新建任务」草稿态的纯判据（用户需求：新建任务要直接进对话界面，并且**能在里面换模型、选权限**）。
 *
 * 这里只钉 [PhoneTasksViewModel.UiState] 上的派生属性——它们决定了请求体里到底带了什么字段、
 * 以及"什么时候才允许把人导航进对话"。真正发请求的路径由
 * `data.api.TaskOriginTest`（payload）与 `data.api.JsonV2Test`（回执解析）各自钉住。
 *
 * 三条不许退化的规则：
 * 1. 没选模型 → `model`/`provider`/`reasoningEffort` **一个都不发**（少一个字段就少一处撒谎的机会）；
 * 2. `provider` / `reasoningEffort` 只跟着 `model` 走（单独一个 provider 网关选不出模型）；
 * 3. 回执说"模型没生效"时 [PhoneTasksViewModel.UiState.readySessionId] 必须为 null，
 *    不允许界面自动进对话把原因冲掉。
 */
class NewTaskDraftStateTest {

    private fun state(
        prompt: String = "跑一遍全量单测",
        workspace: String = "D:\\Workspace\\dsh_android",
        model: ModelSelection? = null,
        models: ModelCatalog = ModelCatalog.UNKNOWN,
        phoneOnly: Boolean = false,
        access: TaskAccess = TaskAccess.DEFAULT,
        createdSessionId: String? = null,
        needsAck: Boolean = false,
    ) = PhoneTasksViewModel.UiState(
        newTaskWorkspace = workspace,
        newTaskPrompt = prompt,
        newTaskModel = model,
        models = models,
        newTaskOnPhoneOnly = phoneOnly,
        newTaskAccess = access,
        createdSessionId = createdSessionId,
        createdNeedsAck = needsAck,
    )

    @Test
    fun `没选模型时三个模型字段一个都不发`() {
        val plain = state()
        assertNull(plain.newTaskModelId)
        assertNull(plain.newTaskProvider)
        assertNull(plain.newTaskReasoningEffort)
    }

    @Test
    fun `选了模型才带 provider 与推理等级`() {
        val picked = state(model = ModelSelection("deepseek-official", "deepseek-v4-pro", "high"))
        assertEquals("deepseek-v4-pro", picked.newTaskModelId)
        assertEquals("deepseek-official", picked.newTaskProvider)
        assertEquals("high", picked.newTaskReasoningEffort)
    }

    @Test
    fun `模型名是空白等于没选，provider 跟着一起不发`() {
        val blank = state(model = ModelSelection("deepseek-official", "   ", "high"))
        assertNull("空串不许发给网关让它去猜", blank.newTaskModelId)
        assertNull(blank.newTaskProvider)
        assertNull(blank.newTaskReasoningEffort)

        val noProvider = state(model = ModelSelection("  ", "deepseek-v4-flash"))
        assertEquals("deepseek-v4-flash", noProvider.newTaskModelId)
        assertNull("provider 空白时宁可不带，也不发空串", noProvider.newTaskProvider)
        assertNull(noProvider.newTaskReasoningEffort)
    }

    @Test
    fun `缺省落电脑端，只有打开仅在手机上执行才落网关`() {
        assertEquals(TaskHost.DESKTOP, state().newTaskHost)
        assertEquals(TaskHost.GATEWAY, state(phoneOnly = true).newTaskHost)
    }

    @Test
    fun `能创建的门槛是工作区与任务内容都不为空，且没有正在创建`() {
        assertTrue(state().canCreate)
        assertFalse(state(prompt = "   ").canCreate)
        assertFalse(state(workspace = "").canCreate)
    }

    @Test
    fun `模型没生效时不许自动进对话，确认后才放行`() {
        val needsAck = state(createdSessionId = "session-x", needsAck = true)
        assertNull("用户还没读到原因，不许把会话 id 交出去", needsAck.readySessionId)
        assertEquals("确认入口仍拿得到 id", "session-x", needsAck.createdSessionId)

        val fine = state(createdSessionId = "session-y")
        assertEquals("session-y", fine.readySessionId)
        assertNull(state().readySessionId)
    }

    @Test
    fun `旧网关没有模型目录时不画选择器`() {
        val ui = state()
        assertFalse("不认识的目录不许当成有得选", ui.models.isKnown)
        assertFalse(ui.models.hasChoices)
        assertEquals(ModelCatalog.UNKNOWN, ui.models)
    }

    @Test
    fun `目录里的默认值只用于展示，不替用户做选择`() {
        val catalog = ModelCatalog(
            defaultSelection = ModelSelection("deepseek-official", "deepseek-v4-flash"),
            groups = listOf(
                ModelGroup(
                    id = "deepseek-official",
                    name = "DeepSeek 官方",
                    models = listOf(ModelEntry("deepseek-v4-flash", "DeepSeek V4 Flash")),
                ),
            ),
            failures = listOf(ModelFailure("openai", "OpenAI", "缺 API key")),
            source = ModelCatalog.SOURCE_DESKTOP,
        )
        val ui = state(models = catalog)
        assertTrue(ui.models.isKnown)
        assertTrue(ui.models.hasChoices)
        assertNull("目录里有默认值不等于用户选了它", ui.newTaskModelId)
        assertEquals("DeepSeek V4 Flash", catalog.labelFor(null))
        assertEquals("没在目录里的 id 也要能显示出来", "ghost-model", catalog.labelFor(ModelSelection("x", "ghost-model")))
    }
}
