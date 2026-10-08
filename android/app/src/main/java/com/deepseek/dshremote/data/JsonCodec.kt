package com.deepseek.dshremote.data

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * 契约 v1 的 JSON 编解码。
 *
 * 全部做成纯函数（不依赖 Android Context），这样 JVM 单测可以直接覆盖解析逻辑；
 * 使用 `org.json` 是契约 §7 的硬性约束（不引入 Gson/Moshi）。
 */
object JsonCodec {

    // ---------- 解析 ----------

    /** 解析 `Task` 对象。缺失的可选字段按契约的默认值处理（`null` / 空串）。 */
    fun parseTask(obj: JSONObject): RemoteTask = RemoteTask(
        id = obj.optString("id", ""),
        title = obj.optString("title", ""),
        prompt = obj.optString("prompt", ""),
        workspace = obj.optString("workspace", ""),
        status = TaskStatus.fromWire(obj.optStringOrNull("status")),
        createdAt = obj.optLong("createdAt", 0L),
        startedAt = obj.optLongOrNull("startedAt"),
        finishedAt = obj.optLongOrNull("finishedAt"),
        exitCode = obj.optIntOrNull("exitCode"),
        output = obj.optString("output", ""),
        error = obj.optStringOrNull("error"),
        truncated = obj.optBoolean("truncated", false),
        sessionId = obj.optStringOrNull("sessionId"),
    )

    fun parseTask(json: String): RemoteTask = parseTask(JSONObject(json))

    fun parseHealth(json: String): HealthInfo {
        val obj = JSONObject(json)
        return HealthInfo(
            ok = obj.optBoolean("ok", false),
            apiVersion = obj.optInt("apiVersion", 0),
            serverName = obj.optString("serverName", ""),
            gatewayVersion = obj.optString("gatewayVersion", ""),
            dshVersion = obj.optString("dshVersion", ""),
            uptimeMs = obj.optLong("uptimeMs", 0L),
            activeTasks = obj.optInt("activeTasks", 0),
            queuedTasks = obj.optInt("queuedTasks", 0),
            pairingOpen = obj.optBoolean("pairingOpen", false),
            authRequired = obj.optBoolean("authRequired", true),
            capabilities = obj.optJSONArray("capabilities").toStringList(),
        )
    }

    fun parseWorkspaces(json: String): WorkspaceList {
        val obj = JSONObject(json)
        val array = obj.optJSONArray("workspaces") ?: JSONArray()
        val list = ArrayList<WorkspaceInfo>(array.length())
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            list += WorkspaceInfo(
                path = item.optString("path", ""),
                label = item.optString("label", item.optString("path", "")),
                exists = item.optBoolean("exists", true),
            )
        }
        return WorkspaceList(workspaces = list, default = obj.optStringOrNull("default"))
    }

    fun parsePairClaim(json: String): PairClaim {
        val obj = JSONObject(json)
        return PairClaim(
            token = obj.optString("token", ""),
            tokenId = obj.optString("tokenId", ""),
            serverName = obj.optString("serverName", ""),
            expiresAt = obj.optLongOrNull("expiresAt"),
        )
    }

    fun parseTaskList(json: String): List<RemoteTask> {
        val array = JSONObject(json).optJSONArray("tasks") ?: return emptyList()
        val result = ArrayList<RemoteTask>(array.length())
        for (i in 0 until array.length()) {
            array.optJSONObject(i)?.let { result += parseTask(it) }
        }
        return result
    }

    /**
     * 解析一条 SSE 事件载荷。
     *
     * 返回 `null` 表示"这条事件不可用"（缺 seq/taskId、非法 JSON）：调用方应跳过而不是断开流，
     * 因为网关侧可能有版本更新的新事件类型。
     */
    fun parseEvent(json: String): TaskEvent? {
        val obj = try {
            JSONObject(json)
        } catch (e: JSONException) {
            return null
        }
        val seq = obj.optLongOrNull("seq") ?: return null
        val taskId = obj.optStringOrNull("taskId") ?: return null
        return TaskEvent(
            seq = seq,
            taskId = taskId,
            at = obj.optLong("at", 0L),
            type = TaskEventType.fromWire(obj.optStringOrNull("type")),
            delta = obj.optString("delta", ""),
            task = obj.optJSONObject("task")?.let { parseTask(it) },
            phase = obj.optStringOrNull("phase"),
            note = obj.optStringOrNull("note"),
        )
    }

    /** 契约 §0 错误体；解析失败时退化成一个带 HTTP 状态的通用错误。 */
    fun parseError(body: String?, httpStatus: Int, fallbackMessage: String): ApiException {
        val obj = runCatching { JSONObject(body ?: "") }.getOrNull()
        val error = obj?.optJSONObject("error")
        return ApiException(
            code = error?.optString("code", "")?.takeIf { it.isNotEmpty() } ?: defaultCode(httpStatus),
            message = error?.optString("message", "")?.takeIf { it.isNotEmpty() } ?: fallbackMessage,
            httpStatus = httpStatus,
        )
    }

    private fun defaultCode(httpStatus: Int): String = when (httpStatus) {
        401 -> "unauthorized"
        403 -> "forbidden"
        404 -> "not_found"
        409 -> "conflict"
        413 -> "payload_too_large"
        429 -> "rate_limited"
        else -> if (httpStatus >= 500) "internal" else "bad_request"
    }

    // ---------- 序列化（本地历史落库） ----------

    fun taskToJson(task: RemoteTask): JSONObject = JSONObject().apply {
        put("id", task.id)
        put("title", task.title)
        put("prompt", task.prompt)
        put("workspace", task.workspace)
        put("status", task.status.wire)
        put("createdAt", task.createdAt)
        put("startedAt", task.startedAt ?: JSONObject.NULL)
        put("finishedAt", task.finishedAt ?: JSONObject.NULL)
        put("exitCode", task.exitCode ?: JSONObject.NULL)
        put("output", task.output)
        put("error", task.error ?: JSONObject.NULL)
        put("truncated", task.truncated)
        put("sessionId", task.sessionId ?: JSONObject.NULL)
    }

    fun tasksToJson(tasks: List<RemoteTask>): String {
        val array = JSONArray()
        tasks.forEach { array.put(taskToJson(it)) }
        return array.toString()
    }

    /** 历史文件损坏时返回空列表而不是抛异常：历史是"best effort"的辅助数据。 */
    fun tasksFromJson(text: String): List<RemoteTask> {
        val array = try {
            JSONArray(text)
        } catch (e: JSONException) {
            return emptyList()
        }
        val result = ArrayList<RemoteTask>(array.length())
        for (i in 0 until array.length()) {
            array.optJSONObject(i)?.let { result += parseTask(it) }
        }
        return result
    }

    // ---------- 小工具：区分"字段存在且为 null"与"字段缺失" ----------

    private fun JSONObject.optStringOrNull(key: String): String? =
        if (!has(key) || isNull(key)) null else optString(key, "").takeIf { it.isNotEmpty() }

    private fun JSONObject.optLongOrNull(key: String): Long? =
        if (!has(key) || isNull(key)) null else optLong(key)

    private fun JSONObject.optIntOrNull(key: String): Int? =
        if (!has(key) || isNull(key)) null else optInt(key)

    private fun JSONArray?.toStringList(): List<String> {
        if (this == null) return emptyList()
        val result = ArrayList<String>(length())
        for (i in 0 until length()) {
            optString(i)?.takeIf { it.isNotEmpty() }?.let { result += it }
        }
        return result
    }
}
