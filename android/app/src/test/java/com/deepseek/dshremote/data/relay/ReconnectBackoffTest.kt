package com.deepseek.dshremote.data.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 重连退避（1s → 30s）与心跳判死（30s 无 pong）。
 *
 * 退避序列必须是**可断言的**：弱网下退避太快会打爆中继，太慢会让用户以为 App 死了。
 */
class ReconnectBackoffTest {

    @Test
    fun `退避序列从 1s 翻倍到 30s 后封顶`() {
        val backoff = ReconnectBackoff()
        assertEquals(1_000L, backoff.nextDelayMs())
        assertEquals(2_000L, backoff.nextDelayMs())
        assertEquals(4_000L, backoff.nextDelayMs())
        assertEquals(8_000L, backoff.nextDelayMs())
        assertEquals(16_000L, backoff.nextDelayMs())
        assertEquals(30_000L, backoff.nextDelayMs())
        assertEquals("封顶后保持 30s，不再增长", 30_000L, backoff.nextDelayMs())
        assertEquals(
            listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L, 30_000L),
            ReconnectBackoff().sequence(8),
        )
    }

    @Test
    fun `连接成功后 reset 让下一次断线从 1s 重新开始`() {
        val backoff = ReconnectBackoff()
        repeat(4) { backoff.nextDelayMs() }
        assertEquals(4, backoff.attempt)
        backoff.reset()
        assertEquals(0, backoff.attempt)
        assertEquals(1_000L, backoff.nextDelayMs())
    }

    @Test
    fun `抖动模式仍落在 0 到 30s 之间`() {
        val backoff = ReconnectBackoff(jitterRatio = 0.3, random = { 1.0 })
        repeat(20) {
            val delay = backoff.nextDelayMs()
            assertTrue("延迟应落在 [0, 30000]：$delay", delay in 0..30_000)
        }
        // 抖动上限不超过 maxMs
        val maxJittered = ReconnectBackoff(initialMs = 30_000, jitterRatio = 0.5, random = { 1.0 })
        assertEquals(30_000L, maxJittered.nextDelayMs())
    }

    @Test
    fun `心跳超时判定`() {
        val now = 1_000_000L
        assertFalse("从未收到 pong 时不判死（还没开始计时）", HeartbeatPolicy.isExpired(lastPongAt = 0, now = now))
        assertFalse(
            "29s 未收到 pong 仍在容忍内",
            HeartbeatPolicy.isExpired(lastPongAt = now - 29_000, now = now),
        )
        assertTrue(
            "31s 未收到 pong 判死链（契约 §3.1：30s 无 pong 视为死链）",
            HeartbeatPolicy.isExpired(lastPongAt = now - 31_000, now = now),
        )
    }

    @Test
    fun `心跳发送间隔判定`() {
        assertTrue("从未发过 ping 时应该发", HeartbeatPolicy.shouldPing(lastPingAt = 0, now = 1_000))
        assertFalse(HeartbeatPolicy.shouldPing(lastPingAt = 1_000, now = 1_000 + 5_000))
        assertTrue(HeartbeatPolicy.shouldPing(lastPingAt = 1_000, now = 1_000 + 20_000))
    }

    @Test
    fun `中继地址规范化补协议头与隧道路径`() {
        assertEquals(
            "ws://10.0.2.2:9443/api/v2/tunnel/device",
            RelayUrls.tunnelUrl("10.0.2.2:9443"),
        )
        assertEquals(
            "wss://relay.example.com/api/v2/tunnel/device",
            RelayUrls.tunnelUrl("wss://relay.example.com"),
        )
        assertEquals(
            "ws://192.168.1.8:9443/api/v2/tunnel/device",
            RelayUrls.tunnelUrl("http://192.168.1.8:9443/"),
        )
        assertEquals(
            "ws://10.0.2.2:9443/api/v2/tunnel/device",
            RelayUrls.tunnelUrl("ws://10.0.2.2:9443/api/v2/tunnel/device"),
        )
        assertEquals("空地址返回空串（由调用方给提示）", "", RelayUrls.tunnelUrl("  "))
        assertEquals(
            "带 query 的地址要丢掉 query",
            "wss://relay.example.com/api/v2/tunnel/device",
            RelayUrls.tunnelUrl("wss://relay.example.com/?token=abc"),
        )
    }

    @Test
    fun `中继 HTTP 基地址与明文判定`() {
        assertEquals("http://10.0.2.2:9443", RelayUrls.httpBase("ws://10.0.2.2:9443/api/v2/tunnel/device"))
        assertEquals("https://relay.example.com", RelayUrls.httpBase("wss://relay.example.com"))
        assertEquals("http://relay.example.com", RelayUrls.httpBase("relay.example.com"))

        assertTrue(RelayUrls.isCleartext("ws://10.0.2.2:9443"))
        assertTrue(RelayUrls.isCleartext("http://relay.example.com"))
        assertTrue("省略协议头默认 ws://（明文）", RelayUrls.isCleartext("relay.example.com"))
        assertFalse(RelayUrls.isCleartext("wss://relay.example.com"))
        assertFalse(RelayUrls.isCleartext("https://relay.example.com"))
    }

    @Test
    fun `隧道端点优先用中继宣告地址，解析不了才回退`() {
        // 正常情况：中继宣告的公网地址可用 → 用它（PC 不需要知道自己的公网地址）
        assertEquals(
            "wss://relay.example.com/api/v2/tunnel/device",
            RelayUrls.pickTunnelEndpoint(
                advertised = "wss://relay.example.com/api/v2/tunnel/device",
                fallback = "wss://user-typed.example.com",
                canResolve = { true },
            ),
        )
        // 实测踩到的坑：开发期 relayName 只是证书 CN（relay.e2e.local），DNS 解析不了
        // → 必须回退到"刚刚配对成功的那台中继"，否则表现为"配对成功但立刻掉线"
        assertEquals(
            "ws://10.0.2.2:9643/api/v2/tunnel/device",
            RelayUrls.pickTunnelEndpoint(
                advertised = "ws://relay.e2e.local:9643/api/v2/tunnel/device",
                fallback = "ws://10.0.2.2:9643",
                canResolve = { host -> host != "relay.e2e.local" },
            ),
        )
        // 中继没给 tunnelUrl（老网关/字段缺失）→ 直接回退
        assertEquals(
            "ws://10.0.2.2:9643/api/v2/tunnel/device",
            RelayUrls.pickTunnelEndpoint("", "ws://10.0.2.2:9643", canResolve = { true }),
        )
    }

    @Test
    fun `主机名提取`() {
        assertEquals("relay.example.com", RelayUrls.hostOf("wss://relay.example.com/api/v2/tunnel/device"))
        assertEquals("10.0.2.2", RelayUrls.hostOf("ws://10.0.2.2:9643/api/v2/tunnel/device"))
        assertEquals("10.0.2.2", RelayUrls.hostOf("10.0.2.2:9643"))
        assertEquals("", RelayUrls.hostOf(""))
    }
}
