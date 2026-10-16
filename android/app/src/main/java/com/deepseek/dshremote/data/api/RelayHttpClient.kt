package com.deepseek.dshremote.data.api

import com.deepseek.dshremote.data.relay.RelayUrls
import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * 中继自身的 HTTP 端点（契约 §2.1、§2.3）。
 *
 * 为什么需要它：[POST /api/v2/pair/claim] 是**配对前**的调用——那时手机还没有
 * `deviceToken`，不可能走隧道（§3 的 device 端点要求 Bearer 认证）。因此：
 * 配对与健康检查走中继 HTTP，其余全部走隧道。
 *
 * 阻塞式实现（与 v1 [com.deepseek.dshremote.data.ApiClient] 一致），由仓库层放进 `Dispatchers.IO`。
 */
class RelayHttpClient(
    private val http: OkHttpClient = defaultClient(),
    private val apiVersion: Int = 2,
) {

    /** `GET /health`（无需认证）。 */
    @Throws(IOException::class)
    fun health(relayUrl: String): RelayHealth {
        val base = RelayUrls.httpBase(relayUrl)
        require(base.isNotEmpty()) { "请先填写中继地址" }
        return JsonV2.parseRelayHealth(get("$base/health"))
    }

    /**
     * `POST /api/v2/pair/claim`：用 6 位配对码换取设备令牌。
     *
     * 响应里的 `relay.tunnelUrl` 是**中继告诉手机的隧道地址**（PC 不需要知道自己的公网地址），
     * 优先用它而不是用户手填的地址。
     */
    @Throws(IOException::class)
    fun pairClaim(relayUrl: String, code: String, deviceName: String, deviceId: String): PairClaimV2 {
        val base = RelayUrls.httpBase(relayUrl)
        require(base.isNotEmpty()) { "请先填写中继地址" }
        val body = JSONObject().apply {
            put("code", code)
            put("deviceName", deviceName)
            put("deviceId", deviceId)
        }
        return JsonV2.parsePairClaim(post("$base/api/v2/pair/claim", body.toString()))
    }

    private fun get(url: String): String {
        val request = Request.Builder()
            .url(url)
            .header("X-Api-Version", apiVersion.toString())
            .get()
            .build()
        return execute(request)
    }

    private fun post(url: String, json: String): String {
        val request = Request.Builder()
            .url(url)
            .header("X-Api-Version", apiVersion.toString())
            .post(json.toRequestBody(JSON))
            .build()
        return execute(request)
    }

    private fun execute(request: Request): String =
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw JsonV2.parseError(
                    body = text,
                    httpStatus = response.code,
                    fallbackMessage = "中继请求失败 HTTP ${response.code}",
                )
            }
            text
        }

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()

        /** 普通请求客户端：给 UI 一个上界，避免配对按钮一直转圈。 */
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .callTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}
