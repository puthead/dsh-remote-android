package com.deepseek.dshremote.data

import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject

/**
 * 契约 v1 的 HTTP 客户端（除事件流外的所有端点）。
 *
 * 设计取舍：所有方法都是阻塞式的（OkHttp 同步调用），由调用方放进 IO 调度器。
 * 这样 Repository 不需要在每个方法上重复写 `withContext`，单测里也可以直接调用。
 */
class ApiClient(
    private val http: OkHttpClient = defaultClient(),
    private val apiVersion: Int = 1,
) {

    /** `GET /api/v1/health` —— 无需认证，配置页用它做连通性探测。 */
    @Throws(ApiException::class, IOException::class)
    fun health(baseUrl: String): HealthInfo {
        val json = get(normalizeBaseUrl(baseUrl) + PATH_HEALTH, token = null)
        return JsonCodec.parseHealth(json)
    }

    /** `POST /api/v1/pair/claim` —— 用 6 位配对码换设备令牌（无需认证）。 */
    @Throws(ApiException::class, IOException::class)
    fun pairClaim(
        baseUrl: String,
        code: String,
        deviceName: String,
        deviceId: String,
    ): PairClaim {
        val body = JSONObject().apply {
            put("code", code)
            put("deviceName", deviceName)
            put("deviceId", deviceId)
        }
        val json = post(normalizeBaseUrl(baseUrl) + PATH_PAIR_CLAIM, token = null, body = body)
        return JsonCodec.parsePairClaim(json)
    }

    /** `GET /api/v1/workspaces` —— 提交任务前必须从白名单里选工作区。 */
    @Throws(ApiException::class, IOException::class)
    fun workspaces(baseUrl: String, token: String): WorkspaceList =
        JsonCodec.parseWorkspaces(get(normalizeBaseUrl(baseUrl) + PATH_WORKSPACES, token))

    /** `POST /api/v1/tasks` —— 返回网关创建的完整 Task 对象（`201`）。 */
    @Throws(ApiException::class, IOException::class)
    fun createTask(
        baseUrl: String,
        token: String,
        prompt: String,
        workspace: String,
        title: String? = null,
        model: String? = null,
        reasoningEffort: String? = null,
        timeoutSec: Int? = null,
    ): RemoteTask {
        val body = JSONObject().apply {
            put("prompt", prompt)
            put("workspace", workspace)
            // 可选字段缺省时不发送：让网关用它自己的默认值，避免客户端写死策略
            title?.takeIf { it.isNotBlank() }?.let { put("title", it) }
            model?.takeIf { it.isNotBlank() }?.let { put("model", it) }
            reasoningEffort?.takeIf { it.isNotBlank() }?.let { put("reasoningEffort", it) }
            timeoutSec?.let { put("timeoutSec", it) }
        }
        Logger.d(TAG, "提交任务 workspace=$workspace promptLen=${prompt.length}")
        return JsonCodec.parseTask(post(normalizeBaseUrl(baseUrl) + PATH_TASKS, token, body))
    }

    /** `GET /api/v1/tasks?status=active|all&limit=n`。 */
    @Throws(ApiException::class, IOException::class)
    fun listTasks(
        baseUrl: String,
        token: String,
        status: String = "all",
        limit: Int = 50,
    ): List<RemoteTask> {
        val url = normalizeBaseUrl(baseUrl) + PATH_TASKS + "?status=$status&limit=$limit"
        return JsonCodec.parseTaskList(get(url, token))
    }

    /** `GET /api/v1/tasks/{id}` —— 当前累计输出，用于断线后的最终对账。 */
    @Throws(ApiException::class, IOException::class)
    fun getTask(baseUrl: String, token: String, taskId: String): RemoteTask =
        JsonCodec.parseTask(get(normalizeBaseUrl(baseUrl) + PATH_TASKS + "/$taskId", token))

    /** `POST /api/v1/tasks/{id}/cancel` —— 终态任务幂等返回原对象。 */
    @Throws(ApiException::class, IOException::class)
    fun cancelTask(baseUrl: String, token: String, taskId: String): RemoteTask =
        JsonCodec.parseTask(
            post(normalizeBaseUrl(baseUrl) + PATH_TASKS + "/$taskId/cancel", token, body = null),
        )

    /** `DELETE /api/v1/tasks/{id}` —— 只允许删终态任务。 */
    @Throws(ApiException::class, IOException::class)
    fun deleteTask(baseUrl: String, token: String, taskId: String) {
        val request = Request.Builder()
            .url(normalizeBaseUrl(baseUrl) + PATH_TASKS + "/$taskId")
            .header("X-Api-Version", apiVersion.toString())
            .apply { header("Authorization", "Bearer $token") }
            .delete()
            .build()
        execute(request) { "" }
    }

    /** 组装事件流地址；`fromSeq` 只在已知游标时附加，避免让网关做无意义的重放。 */
    fun eventsUrl(baseUrl: String, taskId: String? = null, fromSeq: Long = -1L): String {
        val sb = StringBuilder(normalizeBaseUrl(baseUrl)).append(PATH_EVENTS)
        val params = mutableListOf<String>()
        taskId?.takeIf { it.isNotEmpty() }?.let { params += "taskId=$it" }
        if (fromSeq >= 0) params += "fromSeq=$fromSeq"
        if (params.isNotEmpty()) sb.append('?').append(params.joinToString("&"))
        return sb.toString()
    }

    // ---------- 内部实现 ----------

    private fun get(url: String, token: String?): String {
        val request = Request.Builder()
            .url(url)
            .header("X-Api-Version", apiVersion.toString())
            .apply { if (!token.isNullOrEmpty()) header("Authorization", "Bearer $token") }
            .get()
            .build()
        return execute(request) { it }
    }

    private fun post(url: String, token: String?, body: JSONObject?): String {
        val payload = (body?.toString() ?: "").toRequestBody(JSON)
        val request = Request.Builder()
            .url(url)
            .header("X-Api-Version", apiVersion.toString())
            .apply { if (!token.isNullOrEmpty()) header("Authorization", "Bearer $token") }
            .post(payload)
            .build()
        return execute(request) { it }
    }

    /**
     * 统一执行 + 错误体解析。
     *
     * 3xx 不做重定向跟随：内网里出现重定向基本意味着地址填错（例如填了反向代理的登录页），
     * 静默跟随会把 HTML 登录页当 JSON 解析，报错信息会非常难懂。
     */
    private fun <T> execute(request: Request, map: (String) -> T): T =
        http.newCall(request).execute().use { response: Response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw JsonCodec.parseError(
                    body = text,
                    httpStatus = response.code,
                    fallbackMessage = "请求失败 HTTP ${response.code}",
                )
            }
            map(text)
        }

    companion object {
        private const val TAG = "ApiClient"
        private const val PATH_HEALTH = "/api/v1/health"
        private const val PATH_PAIR_CLAIM = "/api/v1/pair/claim"
        private const val PATH_WORKSPACES = "/api/v1/workspaces"
        private const val PATH_TASKS = "/api/v1/tasks"
        private const val PATH_EVENTS = "/api/v1/events"

        private val JSON = "application/json; charset=utf-8".toMediaType()

        /**
         * 规范化用户输入的服务器地址。
         *
         * 用户在手机上只会输入 `192.168.1.8:8787`，缺协议头时必须补 `http://`，
         * 否则 OkHttp 会直接抛 `IllegalArgumentException: Expected URL scheme`。
         */
        fun normalizeBaseUrl(raw: String): String {
            var value = raw.trim()
            if (value.isEmpty()) return ""
            if (!value.startsWith("http://", ignoreCase = true) &&
                !value.startsWith("https://", ignoreCase = true)
            ) {
                value = "http://$value"
            }
            return value.trimEnd('/')
        }

        /** 普通请求客户端：给所有调用一个上界，避免 UI 卡在"提交中"。 */
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .callTimeout(60, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}
