package com.deepseek.dshremote.data.api

import org.json.JSONObject
import java.util.UUID

/**
 * 任务权限档（契约 §4.2 的 `access` 字段）。
 *
 * 用户需求原话：**「可以在任务的时候选择给全部权限还是当前工作区」**。
 *
 * 语义（网关侧落到 `DSH_PERMISSION_MODE`，见 tools/dsh-remote/lib/permission.mjs）：
 * - [WORKSPACE]（默认）→ `workspace-write`：任务只能读写所选工作区，越界读写被沙箱拒绝；
 * - [FULL] → `danger-full-access`：任务可以读写这台电脑上的任何路径，且审批策略为 `never`。
 *
 * 默认必须是 [WORKSPACE]：手机端任何"忘记带字段"的路径（缓存重放、旧版本）都不得悄悄提权。
 */
enum class TaskAccess(val wire: String, val label: String, val detail: String) {
    WORKSPACE(
        wire = "workspace",
        label = "仅当前工作区",
        detail = "任务只能读写所选工作区，越界读写会被沙箱拒绝（推荐）",
    ),
    FULL(
        wire = "full",
        label = "全部权限",
        detail = "任务可以读写这台电脑上的任何路径（含桌面、其它盘、用户目录），请确认任务内容可信",
    ),
    ;

    val isDangerous: Boolean get() = this == FULL

    companion object {
        /** 手机端默认档：与网关的缺省值一致。 */
        val DEFAULT: TaskAccess = WORKSPACE

        /** 未知取值一律回落到默认档（失败即收紧）。 */
        fun fromWire(value: String?): TaskAccess =
            values().firstOrNull { it.wire == value } ?: DEFAULT
    }
}

/**
 * 任务落在哪执行（契约 §4.2 请求字段 `host`）。
 *
 * 网关 v2.1.0 起手机新建任务**默认落在电脑端 DSH**（`source:"computer"`，电脑上也能看到、
 * 能接管），只有显式要求时才在网关自己的 DSH_HOME 里用 SDK profile 起一轮。
 *
 * 权限档 [TaskAccess] **只在 [GATEWAY] 下有意义**：落在电脑端时权限跟随电脑端 DSH 自己的设置，
 * 手机端无法指定（服务端也不会回执 `access`）。
 */
object TaskHost {
    /** 电脑端 DSH runtime（默认）。要求 `workspace` 非空——电脑端是按工作区登记会话的。 */
    const val DESKTOP = "desktop"

    /** 网关自己的 DSH_HOME（SDK profile）。 */
    const val GATEWAY = "gateway"

    /** wire 取值归一化；未知/缺失返回 null（调用方自行决定缺省）。 */
    fun fromWireOrNull(value: String?): String? = when (value?.trim()?.lowercase()) {
        DESKTOP -> DESKTOP
        GATEWAY -> GATEWAY
        else -> null
    }
}

/**
 * 请求体里到底要不要带权限档：**只有落网关（`host:"gateway"`）才带**。
 *
 * 落电脑端（含缺省）时权限跟随电脑端 DSH 自己的设置，手机端指定了也不会生效——
 * 带上 `access` 只是自欺欺人，回执里也不会出现它。抽成纯函数是为了让这条
 * "不许骗用户"的规则能在 JVM 单测里钉住。
 */
fun accessForHost(access: TaskAccess, host: String?): TaskAccess? =
    if (TaskHost.fromWireOrNull(host) == TaskHost.GATEWAY) access else null

/**
 * 构造 `POST /api/v2/tasks` 的请求体。
 *
 * 抽成纯函数是为了让「权限档一定进了请求体」「默认档不写 full」这类契约能在 JVM 单测里断言，
 * 不必起网关、也不必起模拟器（`TaskAccessPayloadTest`）。
 *
 * @param host `"desktop"` | `"gateway"`；null = 不带该字段，由网关自己决定缺省
 *   （桌面端可用则 desktop，未接入则 gateway）。
 * @param access 权限档；**null = 不带 `access` 字段**（落在电脑端时权限由电脑端 DSH 说了算，
 *   调用方应当用 [accessForHost] 决定）。
 * @param model 模型 id（契约 §4.2 的 `model`）；null/空白 = 不带该字段，按执行端**当前**模型跑。
 * @param provider 模型所属 provider（`deepseek-official` 等）。**只有 [model] 非空时才会写进
 *   请求体**：单独一个 provider 没有任何意义（网关无法据此选模型），带上只会让网关白校验一次。
 * @param reasoningEffort 推理等级（`minimal`/`low`/`medium`/`high`…）；同样只在有 [model] 时写。
 */
fun buildCreateTaskPayload(
    workspace: String,
    prompt: String,
    clientTurnId: String = UUID.randomUUID().toString(),
    title: String? = null,
    model: String? = null,
    access: TaskAccess? = TaskAccess.DEFAULT,
    host: String? = null,
    provider: String? = null,
    reasoningEffort: String? = null,
): String = JSONObject().apply {
    put("workspace", workspace)
    put("prompt", prompt)
    put("clientTurnId", clientTurnId)
    access?.let { put("access", it.wire) }
    host?.let { put("host", it) }
    title?.takeIf { it.isNotBlank() }?.let { put("title", it) }
    model?.takeIf { it.isNotBlank() }?.let { picked ->
        put("model", picked)
        provider?.takeIf { it.isNotBlank() }?.let { put("provider", it) }
        reasoningEffort?.takeIf { it.isNotBlank() }?.let { put("reasoningEffort", it) }
    }
}.toString()
