package com.deepseek.dshremote.data.relay

/**
 * 中继地址的规范化（纯函数，可单测）。
 *
 * 用户只会输入 `relay.example.com` 或 `ws://10.0.2.2:9443` 这种形态，
 * 手机端必须自己补齐 scheme 与隧道路径，否则 OkHttp 会抛 `Expected URL scheme`。
 * 注意：`ws://` = 明文（契约 §5.5 要求给出风险提示），`wss://` 才是生产形态。
 */
object RelayUrls {

    const val DEVICE_TUNNEL_PATH = "/api/v2/tunnel/device"

    /** 规范化出设备隧道 WS 地址（手机不直连 PC，永远只连这个地址）。 */
    fun tunnelUrl(raw: String): String {
        val base = stripPath(normalize(raw)) ?: return ""
        return base + DEVICE_TUNNEL_PATH
    }

    /** 中继 HTTP 端点（`/health`、`/api/v2/pair/claim`）的基地址。 */
    fun httpBase(raw: String): String {
        val stripped = stripPath(normalize(raw)) ?: return ""
        return when {
            stripped.startsWith("ws://", ignoreCase = true) ->
                "http://" + stripped.substring("ws://".length)

            stripped.startsWith("wss://", ignoreCase = true) ->
                "https://" + stripped.substring("wss://".length)

            else -> stripped
        }
    }

    /** 明文判定：`ws://` 或 `http://` 都要在设置页给风险提示卡（契约 §5.6）。 */
    fun isCleartext(raw: String): Boolean {
        val value = normalize(raw)
        return value.startsWith("ws://", ignoreCase = true) ||
            value.startsWith("http://", ignoreCase = true)
    }

    /**
     * 选隧道端点：**中继宣告的 `tunnelUrl` 优先**（契约 §2.3：PC 不需要知道自己的公网地址），
     * 但宣告的地址必须在本机可解析；解析不了就回退到"刚刚成功连过的中继地址"。
     *
     * 为什么需要这一步（实测踩到）：开发/自建部署时中继的 `relayName` 常常只是证书 CN
     * （例如 `relay.e2e.local`），并不在 DNS 里。此时若盲从宣告地址，手机配对会"成功但立刻掉线"，
     * 报错是 `Unable to resolve host`——看起来像手机的问题，其实是地址来源选错了。
     * 两个地址指向同一个中继（配对请求就是打到 fallback 上的），回退不降低信任要求。
     */
    fun pickTunnelEndpoint(
        advertised: String,
        fallback: String,
        canResolve: (String) -> Boolean,
    ): String {
        if (advertised.isEmpty()) return tunnelUrl(fallback)
        val host = hostOf(advertised)
        if (host.isEmpty()) return tunnelUrl(fallback)
        return if (canResolve(host)) advertised else tunnelUrl(fallback)
    }

    /** 取 URL 的 host（无 scheme 时按 host:port 处理）。 */
    fun hostOf(raw: String): String {
        val value = normalize(raw)
        if (value.isEmpty()) return ""
        val withoutScheme = if (value.contains("://")) value.substringAfter("://") else value
        return withoutScheme.substringBefore('/').substringBefore(':')
    }

    private fun normalize(raw: String): String {
        var value = raw.trim()
        if (value.isEmpty()) return ""
        // 去掉 query/fragment：用户从浏览器复制地址时经常带上
        value = value.substringBefore('?').substringBefore('#')
        // http/https 是同一个语义的另一种写法，统一成 ws/wss（否则隧道 URL 会是非法的 http://…/api/v2/tunnel/device）
        value = when {
            value.startsWith("https://", ignoreCase = true) -> "wss://" + value.substring("https://".length)
            value.startsWith("http://", ignoreCase = true) -> "ws://" + value.substring("http://".length)
            else -> value
        }
        val hasScheme = SCHEMES.any { value.startsWith(it, ignoreCase = true) }
        if (!hasScheme) value = "ws://$value"
        return value.trimEnd('/')
    }

    /** 去掉已带的隧道路径，得到纯 origin。 */
    private fun stripPath(value: String): String? {
        if (value.isEmpty()) return null
        val schemeEnd = value.indexOf("://")
        val scheme = if (schemeEnd > 0) value.substring(0, schemeEnd + 3) else ""
        val rest = if (schemeEnd > 0) value.substring(schemeEnd + 3) else value
        val origin = rest.substringBefore('/')
        if (origin.isEmpty()) return null
        return scheme + origin
    }

    private val SCHEMES = listOf("ws://", "wss://", "http://", "https://")
}
