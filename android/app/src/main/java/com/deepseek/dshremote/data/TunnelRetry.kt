package com.deepseek.dshremote.data

import com.deepseek.dshremote.data.relay.RelayException

/**
 * "撞上重连窗口的主动刷新，先等一等再重试一次"这条策略。
 *
 * 背景（2026-10-15 用户真机截图）：手机走蜂窝网时隧道会被运营商 NAT 掐断，中继日志里的关闭原因是
 * `code=1006 reason=socket`（真机 PGT-AN00 一天 47 次），实测每 20s~4min 一次；**恰好落在重连窗口里的
 * 那次下拉刷新**会立刻拿到 `home_offline`，界面就把一次抖动报成了"电脑离线：中继隧道未连接，
 * 请检查中继地址或等待重连"。重连耗时按中继日志复核是 **8.9s / 13.4s / 13.9s / 17.6s**
 * （不是几百毫秒），所以等待预算给到 `ConsoleRepository.TUNNEL_WAIT_MS = 20_000`。
 *
 * 为什么单独抽成文件：这段判定是纯逻辑（哪些错误可以等、等到了怎么重试），而
 * [ConsoleRepository] 需要 Android Context、在纯 JVM 单测里起不来，所以真正的判定必须落在
 * 这个不依赖 Android 的地方，才能被 [com.deepseek.dshremote.data.TunnelRetryTest] 钉住。
 *
 * 语义边界（**别放宽**）：
 * - 只对"隧道当前不可用"重试。真正的业务错误（403 `workspace_outside`、404、`desktop_unavailable`…）
 *   一次都不重试——确定性失败重试只会让用户多等，还会掩盖真实原因；
 * - 等不到就把**原始错误**如实返回，界面照旧显示"电脑离线"，不把"其实连不上"伪装成成功。
 */
internal object TunnelRetry {

    /** 这次失败是不是"隧道暂时不可用"（可以等重连），而不是业务错误。 */
    fun isTunnelGap(error: Throwable): Boolean = when (error) {
        // 本地判据：没有可写句柄 / 写入时对端正在关闭（RelayClient.writableHandle）
        is RelayException -> error.code == HOME_OFFLINE
        // 服务端判据：网关把中继的 503 home_offline 原样透传（DshApiV2.read → JsonV2.parseError）
        is ApiException -> error.code == HOME_OFFLINE
        else -> false
    }

    /**
     * 先跑一次 [block]；只有在**隧道暂时不可用**时才 [waitOnline]，等到了再原样重试一次。
     *
     * @param waitOnline 等待"隧道可用且 PC 在线"；返回 false = 超时或凭据失效，此时不重试。
     * @param onWait 进入等待时回调（测试用来断言"确实等过"）。
     * @param onResult 重试后的结果回调（测试用来断言重试次数恰好为 1）。**只有在真的等过、
     *   也真的重试过之后才会回调**——调用方据此把"这次是恢复"和"这次本来就是好的"分开，
     *   后者不该触发清离线态之类的恢复副作用。
     */
    suspend fun <T> withRetry(
        block: suspend () -> T,
        waitOnline: suspend () -> Boolean,
        onWait: () -> Unit = {},
        onResult: (Result<T>) -> Unit = {},
    ): Result<T> {
        val first = runCatching { block() }
        val cause = first.exceptionOrNull()
        if (cause == null || !isTunnelGap(cause)) return first
        onWait()
        if (!waitOnline()) return first
        val second = runCatching { block() }
        onResult(second)
        return second
    }

    private const val HOME_OFFLINE = "home_offline"
}
