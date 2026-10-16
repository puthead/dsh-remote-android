package com.deepseek.dshremote.ui.components

import com.deepseek.dshremote.data.api.ChatMessage
import com.deepseek.dshremote.data.api.TrajectoryKind
import com.deepseek.dshremote.data.api.TrajectoryRow

/**
 * 「轨迹」视图的**纯投影逻辑**（m00002）。
 *
 * 为什么单独一个文件、而不是和 [TrajectoryList] 放一起：
 *
 * 1. 这两个函数是**可测的逻辑**（没有 Compose 运行时、没有 Robolectric 依赖），
 *    放在本文件就能被普通 JVM 单测直接跑；本仓库没有 Compose UI 测试，
 *    把逻辑塞进 @Composable 文件等于放弃测试。
 * 2. 轨迹视图与对话流共用同一份分页窗口（同一 [ChatMessage.seq] 空间），
 *    所以投影只做"摊平"，**不做**任何过滤/裁剪——裁剪是 [com.deepseek.dshremote.data.api.TranscriptPager]
 *    的职责。两边各裁一次，长度就对不上了。
 */

/**
 * 把一页对话消息摊平成轨迹行。
 *
 * 顺序必须稳定：先按 `messages` 的顺序，同一条消息内按产出顺序。
 * 界面用 `seq:index:kind` 当 LazyColumn 的 key，顺序抖动会让列表跳动。
 */
fun buildTrajectory(messages: List<ChatMessage>): List<TrajectoryRow> {
    val rows = ArrayList<TrajectoryRow>()
    for (message in messages) {
        if (message.isEmpty) continue
        var index = 0
        fun add(kind: TrajectoryKind, title: String, detail: String = "", isError: Boolean = false) {
            rows += TrajectoryRow(
                seq = message.seq,
                index = index++,
                at = message.at,
                kind = kind,
                title = title,
                detail = detail,
                isError = isError,
            )
        }

        when {
            message.isUser -> add(TrajectoryKind.TURN, "你", trajectoryDetailPreview(message.text))
            else -> {
                // 待办先出：它是"这一步要做什么"的摘要，工具调用是"真的做了什么"
                message.todos.forEach { todo -> add(TrajectoryKind.TODO, todo.text, todo.status) }
                message.toolCalls.forEach { call ->
                    add(TrajectoryKind.TOOL, call.name, call.argsSummary)
                    // 只有拿到结果才配一行"结果"：还在跑的工具调用下面挂个空行只是噪音
                    if (call.hasResult) {
                        add(
                            kind = TrajectoryKind.RESULT,
                            title = if (call.isError) "执行失败" else "执行结果",
                            detail = trajectoryDetailPreview(call.result),
                            isError = call.isError,
                        )
                    }
                }
                if (message.isAssistant && message.text.isNotBlank()) {
                    add(TrajectoryKind.THOUGHT, "模型输出", trajectoryDetailPreview(message.text))
                }
                // 非 user、非 assistant 的消息（system 提示/运行时快照、tool 角色）单独成行。
                // 这里必须显式兜住：只认 assistant 的话 system 消息会整条从轨迹里消失，
                // 而"轨迹"恰恰是用户用来核对"到底发生了哪些步骤"的视图。
                if (!message.isAssistant && message.text.isNotBlank()) {
                    add(
                        kind = TrajectoryKind.NOTE,
                        title = if (message.role == "system") "系统" else message.role,
                        detail = trajectoryDetailPreview(message.text),
                    )
                }
                message.deliverables.forEach { deliverable ->
                    add(TrajectoryKind.DELIVERABLE, deliverable.path, deliverable.description)
                }
            }
        }
    }
    return rows
}

/**
 * 轨迹行的副标题压缩：换行/连续空白压成单空格，超长截断。
 *
 * 轨迹视图刻意**不做二次展开**（对话流里工具卡可以点开看全文），
 * 一行的信息量必须固定，否则"一屏扫过很多步"这个唯一优势就没了。
 */
fun trajectoryDetailPreview(text: String, limit: Int = 160): String {
    val flat = text.replace(Regex("\\s+"), " ").trim()
    if (flat.length <= limit) return flat
    // limit <= 1 时没有位置放省略号，直接给空串而不是崩在 substring 上
    if (limit <= 1) return flat.take(limit.coerceAtLeast(0))
    return flat.take(limit - 1).trimEnd() + "…"
}
