package com.deepseek.dshremote.data

/**
 * 服务端 Task 对象与本地状态的归并规则。
 *
 * 单独抽成纯函数是为了能单测：这条规则直接决定"看到的历史输出是不是完整的"，
 * 而它埋在 Repository 里时无法脱离 Android 运行时验证。
 */
object TaskMerger {

    /**
     * 归并同 id 的任务快照。
     *
     * 三个关键决策：
     * 1. **状态只进不退**：网关重启或事件重放可能带来旧快照，不能让 `succeeded` 退回 `running`；
     * 2. **输出取更长的那个**：正常情况下服务端对象与本地拼接一致；重连补发前服务端可能更全，
     *    而本地更长时说明收到的是较旧的快照。宁可多留日志也不要丢输出；
     * 3. **字段缺失不覆盖已有值**：`task.progress` 类事件可能只带部分字段。
     */
    fun merge(local: RemoteTask?, incoming: RemoteTask): RemoteTask {
        if (local == null) return incoming
        return incoming.copy(
            status = TaskStatus.later(local.status, incoming.status),
            output = if (incoming.output.length >= local.output.length) incoming.output else local.output,
            title = incoming.title.ifEmpty { local.title },
            prompt = incoming.prompt.ifEmpty { local.prompt },
            workspace = incoming.workspace.ifEmpty { local.workspace },
            createdAt = if (incoming.createdAt == 0L) local.createdAt else incoming.createdAt,
            startedAt = incoming.startedAt ?: local.startedAt,
            finishedAt = incoming.finishedAt ?: local.finishedAt,
            exitCode = incoming.exitCode ?: local.exitCode,
            error = incoming.error ?: local.error,
            sessionId = incoming.sessionId ?: local.sessionId,
            truncated = incoming.truncated || local.truncated,
        )
    }
}
