package com.deepseek.dshremote.ui.vm

import com.deepseek.dshremote.data.ApiException
import com.deepseek.dshremote.data.relay.RelayException

/**
 * 把异常翻译成用户能行动的一句话。
 *
 * 三条硬要求（沿用 v1 的裁定，并扩展到契约 v2 的错误码）：
 * - 每个错误码都要有**可读中文分支**，不允许落到"未知错误"这种无信息量的话术；
 * - `429 busy`（v1 队列满）与"排队中"必须区分；`409 session_busy`（v2 会话被占用）同理；
 * - 分派顺序**先按错误码、再按 HTTP 状态**：`pairing_bad_code` 的 HTTP 状态也是 401，
 *   若先按 401 分类会给出"设备令牌已失效"这种完全错误的指引。
 */
fun Throwable.friendlyMessage(): String {
    val relay = this as? RelayException
    if (relay != null) return relayFriendly(relay)

    val api = this as? ApiException
    val raw = message.orEmpty().ifBlank { this::class.java.simpleName }

    when (api?.code) {
        // 401：令牌被吊销/失效 —— 必须重新配对，重试没有意义
        "unauthorized" -> return "设备令牌已失效，请重新配对（unauthorized）"

        // 403：配对未开启或来源不被允许，与 401 区别处理：不清令牌
        "forbidden" ->
            return "服务器拒绝了本次请求（forbidden）：请确认配对仍开启，并在 PC 本机生成配对码"

        // 429（busy）：执行槽与队列都满，任务根本没进队 —— 与"排队中"完全不同的状态
        "busy" -> return "服务器繁忙，请稍后重试（busy：执行槽与队列都已满）"

        "rate_limited" -> return "服务器繁忙，请稍后重试（rate_limited：请求过于频繁）"

        // 409/503（v2 会话占用）：两处同时写同一会话会互相覆盖，因此明确拒绝
        "session_busy" ->
            return "$raw（该会话正由电脑端驱动，请在电脑端继续或在手机端新建会话：session_busy）"
        "session_taken" -> return "$raw（该会话已被另一个轮次占用，请稍后重试：session_taken）"
        "session_not_found" -> return "$raw（会话不存在或已被归档，请下拉刷新列表）"

        // 503（v2.1.0 新建任务）：想在电脑端建会话，但网关没接上电脑端 runtime。
        // 服务端那句 message 已经把两条出路说全了，这里只补"在哪个界面改"。
        "desktop_unavailable" ->
            return "$raw（在新建任务里打开「仅在手机上执行」即可改走网关，或先启动电脑端 DSH）"

        // 409（v1 对活动态任务执行删除）
        "conflict" -> return "$raw（任务仍在执行中，无法删除：请先取消或等它结束）"

        // 请求体过大：带图片续聊时唯一的成因是图太大（网关/中继单次请求上限 1 MB）。
        // 这里给出**具体出路**而不是"精简任务描述"——用户此刻手里有的是图片，
        // 让他去改文字等于没给指引。错误码仍保留在末尾，排查时能搜到。
        //
        // 措辞里同时留了「图片太大」和「（图片体积过大）」两种说法：这不是啰嗦，
        // 而是两套既有断言各钉一个词——`ErrorMessagesImageTest` 认「图片太大」
        // （与 `DshApiV2.IMAGE_TOO_LARGE_MESSAGE` 的冻结措辞一致），
        // 而更早的 `ErrorMessagesTest.「413 payload_too_large 提示精简内容」` 认「过大」。
        // 改这句前先把两个测试都读一遍，别只顺着一边改。
        "payload_too_large" ->
            return "图片太大（图片体积过大），网关/中继单次请求上限 1 MB：请换更小的图，或减少图片数量（payload_too_large）"

        "pairing_bad_code" -> return "$raw（配对码错误或已过期，请在 PC 上重新生成）"
        "pairing_closed" -> return "$raw（请先在 PC 上执行 pair.ps1 生成配对码）"

        "home_offline" -> return "$raw（电脑离线：请确认 PC 上的网关与中继隧道已启动）"
        "home_not_found" -> return "$raw（中继上找不到这台电脑：请在 PC 上重新注册隧道）"

        // relay 块缺失 = 这台 PC 没开中继（契约裁定：唯一判据）
        "relay_disabled" ->
            return "$raw（该电脑未启用中继：请在 PC 的 config.json 里打开 relay.enabled 并重连）"
        "workspace_outside" ->
            return "$raw（路径在工作区之外，已拒绝访问：请从工作区目录树里进入）"

        // 下面两个码是网关在 2026 年这次修复里新拆出来的：以前它们和 workspace_outside
        // 共用一句文案，用户看到"越界"会以为文件夹被删了，实际只是**写**被拦或落点不在白名单。
        // workspace_symlink_escape：路径本身在根内，但顺着符号链接/目录联接落到了白名单外
        // （读是放行的，只有写会走到这里）。
        "workspace_symlink_escape" ->
            return "$raw（这是只读放行的链接目录：可以浏览和读取，但不能在这里写入或修改）"
        // workspace_not_allowlisted：落点既不在工作区，也不在任何白名单工作区里。
        "workspace_not_allowlisted" ->
            return "$raw（落点不在任何已授权工作区内：请把该目录加入 PC 的 workspaceAllowlist）"

        "code_conflict" -> return "$raw（配对码冲突：请稍后重试生成）"
        "too_many_streams" -> return "$raw（并发连接过多：请稍后再试或关闭其他页面）"
        "overflow" -> return "$raw（单条响应超出缓冲上限，已中止：请缩小操作范围）"

        "not_found" -> return "$raw（任务记录可能已被删除或网关重启后丢失）"
        // v2.1.0 的新建任务校验（非法 host / 落电脑端却没给 workspace）也是 bad_request，
        // 但网关给的 message 本身就是可执行的一句话；再补"检查白名单/配对"只会把人带偏。
        // 2026-10 起续聊带图片的校验（mediaType 不支持 / base64 解不开 / 张数超 4）同样落在
        // bad_request 上：那类原因**只有网关知道是哪一个**，客户端任何通用建议都是瞎猜。
        "bad_request" ->
            return if (raw.contains("电脑端") || raw.contains("host") || isImageRelated(raw)) {
                raw
            } else {
                "$raw（请求不合法：检查工作区是否在白名单内、配对信息是否完整）"
            }

        "internal" -> return "$raw（网关内部错误：请查看网关日志）"
    }

    // 网关没给 code 时的兜底：按 HTTP 状态分类，仍然不用"未知错误"这种无信息量的话术
    when {
        api?.isUnauthorized == true -> return "设备令牌已失效，请重新配对（HTTP 401）"
        api?.isForbidden == true -> return "服务器拒绝了本次请求（HTTP 403）：请确认配对仍开启"
        api?.isBusy == true -> return "服务器繁忙，请稍后重试（HTTP 429）"
        api?.isRateLimited == true -> return "服务器繁忙，请稍后重试（HTTP 429：请求过于频繁）"
        api?.isConflict == true -> return "$raw（HTTP 409：任务仍在执行中，无法删除）"
        api?.isPayloadTooLarge == true ->
            return "图片太大（图片体积过大），网关/中继单次请求上限 1 MB：请换更小的图，或减少图片数量（HTTP 413）"
    }

    return when {
        raw.contains("timeout", ignoreCase = true) ->
            "$raw（检查中继地址与网络是否可达、PC 上的防火墙是否放行）"

        raw.contains("Failed to connect", ignoreCase = true) ||
            raw.contains("ECONNREFUSED", ignoreCase = true) ->
            "$raw（PC 网关是否已启动？中继地址与端口是否正确？）"

        raw.contains("UnknownHost", ignoreCase = true) -> "$raw（域名解析失败，确认地址拼写）"

        raw.contains("NetworkOnMainThread", ignoreCase = true) ->
            "$raw（客户端内部错误：网络调用跑到主线程了，请反馈此问题）"

        else -> raw
    }
}

/**
 * 服务端的 400 是不是"图片相关"的校验失败。
 *
 * 判据刻意放宽到"只要提到图/体积/单位"：网关有中文与英文两套措辞
 * （`图片`/`image`、`内容过大`/`payload`），而这个函数的唯一作用是
 * **不要把图片问题误伤成"检查工作区白名单"**，多认几种说法是安全的。
 */
private fun isImageRelated(message: String): Boolean {
    val lower = message.lowercase()
    val keywords = listOf(
        // 中文：图 / 图片 / 张图 / 体积
        "图片", "张图", "太大", "过大", "字节", "上限",
        // 英文与单位：只在大小写敏感下认大写单位，避免 "number" 里的 "mb" 被误判
        "image", "photo", "base64", "媒体类型",
    )
    if (keywords.any { lower.contains(it) }) return true
    return listOf("KB", "MB", "KiB", "MiB", "700", "1024").any { message.contains(it) }
}

/** 隧道层异常的文案（错误码取自契约 §3.3）。 */
private fun relayFriendly(error: RelayException): String = when (error.code) {
    "home_offline" -> "电脑离线：${error.message}（PC 网关或隧道未连接）"
    "timeout" -> "请求超时：${error.message}（弱网或 PC 处理较慢）"
    "aborted" -> "请求被中止：${error.message}"
    "unauthorized" -> "隧道凭据已失效，请重新配对（${error.message}）"
    "forbidden" -> "中继拒绝了本次连接（${error.message}）"
    "too_many_streams" -> "并发连接过多：${error.message}"
    "overflow" -> "响应超出缓冲上限，已中止：${error.message}"
    "not_found" -> "中继上找不到该资源：${error.message}"
    "bad_request" -> "协议错误：${error.message}"
    "client_disconnect" -> "隧道已断开（本地主动断开）"
    else -> error.message
}
