package com.deepseek.dshremote.ui.screens

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「一次性提示展示完就消费」的收敛判据（用户报的缺陷：一点界面就弹出「已提交回答…」挡住界面）。
 *
 * 为什么测的是这个纯函数而不是 Composable：真正的缺陷有**两个**成因，必须在两层各自钉住：
 * 1. 展示层：`LaunchedEffect(ui.message)` 在页面重建时用没变过的 key 重跑 —— 由
 *    屏幕里"showSnackbar 之后再 consumeMessage"的写法解决，只能靠模拟器实测（见报告）；
 * 2. 判据层：消费哪一条 —— 「已提交回答（若电脑端先答过，以先答的为准）」这类
 *    `isError=false` 的一次性提示必须被消费掉（否则 message 永远是那个 key，重建必再弹），
 *    而 `isError=true` 的失败原因**不能**被消费掉（详情页 :442 的常驻 ErrorText 依赖它非空，
 *    清成 null 用户就看不到失败原因了）。这一层是纯逻辑，就该在这里被钉死。
 */
class MessageConsumptionTest {

    @Test
    fun `一次性成功提示展示完必须被消费`() {
        // 就是这么一条：提交成功后 VM 写进 message 的就是它，原来从没有人清空 → 反复弹。
        assertTrue(
            shouldConsumeSnackbarMessage("已提交回答（若电脑端先答过，以先答的为准）", isError = false),
        )
        assertTrue(shouldConsumeSnackbarMessage("已复制 12 步轨迹到剪贴板", isError = false))
        assertTrue(shouldConsumeSnackbarMessage("地址已保存，正在重连…", isError = false))
    }

    @Test
    fun `错误提示不消费以免失败原因从屏幕上消失`() {
        // 详情页 :442 `ui.message?.takeIf { ui.isError }?.let { ErrorText(it) }`：消费掉就等于把
        // 失败原因也抹掉，用户只看到一个"什么都没发生"的界面 —— 比多留一条更糟。
        assertFalse(shouldConsumeSnackbarMessage("加载对话失败：连接已断开", isError = true))
        assertFalse(shouldConsumeSnackbarMessage("还没有填写任何答案", isError = true))
        assertFalse(shouldConsumeSnackbarMessage("内部错误：null", isError = true))
    }

    @Test
    fun `没有待展示提示时不消费`() {
        // 消费本身会触发一次 _ui.update；空转没有意义，而且会把"本来就没提示"伪装成"刚消费过"。
        assertFalse(shouldConsumeSnackbarMessage(null, isError = false))
        assertFalse(shouldConsumeSnackbarMessage(null, isError = true))
        assertFalse(shouldConsumeSnackbarMessage("", isError = false))
    }
}
