package com.deepseek.dshremote.ui.screens

import com.deepseek.dshremote.data.api.SessionSummary

/**
 * 会话行的**状态语言**（纯函数，无 Android / Compose 依赖，可直接 JVM 单测）。
 *
 * ## 为什么要重做
 * 旧行版在右侧挂了一个「可续聊」绿色胶囊：服务端给了 `writable:true` 就显示。
 * 结果是 42 个会话里绝大多数都挂着同一个绿胶囊——**一个几乎所有行都成立的标记不携带任何信息**，
 * 只是把每行右侧变成一片复读的噪声，还把「运行中」这个真正需要一眼看到的动态状态稀释掉了。
 *
 * 新规则只有一条：**默认状态不表达，值得说的状态才出现**。
 * 于是"普通可写会话"（最常见的默认态）在界面上**一个状态字都没有**，
 * 右列只剩时间戳；真正异常的「只读」和真正动态的「运行中」才拿到胶囊。
 *
 * ## 真值表（按判定优先级从上到下，第一个命中即胜出）
 *
 * | # | 条件 | 状态 | 界面表现 |
 * |---|------|------|----------|
 * | 1 | `live && !stale` | [Live] | 绿点（呼吸）+「运行中」 |
 * | 2 | `live && stale`（离线快照） | [ReadOnly] | 中性灰「只读」——快照里的"运行中"不可能是真的 |
 * | 3 | `!writable` | [ReadOnly] | 中性灰「只读」，点击给原因 |
 * | 4 | `isPhoneTask` | [Phone] | 极轻的「手机」标记 |
 * | 5 | 其余（可写、非手机、不在跑） | [Idle] | **什么都不显示** |
 *
 * 两条刻意的取舍：
 * 1. 「运行中」压过「只读」：一条正在电脑端跑的只读会话，用户此刻想知道的**是它在跑**，
 *    "为什么不能发消息"点一下再问（[Resolved.hint]）也来得及。
 * 2. **离线快照里的 live 不算数**（第 2 条）：缓存回放时 `live` 还停在断线那一刻的取值，
 *    继续画呼吸点会让用户以为电脑端在跑一个早已停下的任务。
 *
 * ## 尊重一条硬约束：只读的兜底原因不许说得太早
 * [SessionSummary.readOnlyHeadline] 在 `writableReason` 缺失时会按来源兜底成
 * 「网关重启或被停止过…」——那对**手机端**会话是对的，对**电脑端镜像**会话是错的
 * （老网关不下发 `writable` 字段，不是"被停止过"）。所以这里只在拿到了服务端的原因时
 * 才转述它（[detail]），否则退到与来源相符的兜底（[reason]）。
 */
sealed interface SessionStatus {

    /** 状态档；界面按它选语义色角色，不靠字符串比较。 */
    val kind: SessionStatusKind

    /** 状态胶囊上的**短**文案；[Idle] 为空串（不显示胶囊）。 */
    val label: String

    /** 无障碍朗读 / 点击后的完整说明；[Idle] 为空串。 */
    val hint: String

    /** 是否画状态点（目前只有 [Live] 会画，且是呼吸点）。 */
    val showsDot: Boolean

    /** 是否显示状态胶囊；[Idle] 为 false —— 这是"去掉噪音"的落点。 */
    val visible: Boolean get() = kind != SessionStatusKind.Idle

    /** 语义色角色。界面在 `theme` 里把它映射成具体颜色，本文件不碰 `Color`。 */
    enum class SessionStatusKind { Live, ReadOnly, Phone, Idle }

    /** 正在运行（电脑端/网关正在驱动这一轮）。唯一的动态状态，唯一常显。 */
    data class Live(override val hint: String) : SessionStatus {
        override val kind = SessionStatusKind.Live
        override val label: String = "运行中"
        override val showsDot: Boolean = true
    }

    /**
     * 只读（手机发不出去）。
     *
     * [reason] 是可以直接给用户看的一句「为什么」——**从不静默**：
     * 行上的胶囊点击后弹 snackbar，文案就是它（会话详情页另有完整说明）。
     */
    data class ReadOnly(val reason: String) : SessionStatus {
        override val kind = SessionStatusKind.ReadOnly
        override val label: String = "只读"
        override val hint: String = "只读：$reason"
        override val showsDot: Boolean = false
    }

    /**
     * 手机发起（含"手机发起 · 电脑执行"）。用极轻的「手机」标记与电脑端会话区分，
     * 不加点、不用语义色——它不是状态，只是出处。
     */
    data object Phone : SessionStatus {
        override val kind = SessionStatusKind.Phone
        override val label: String = "手机"
        override val hint: String = "手机发起的会话"
        override val showsDot: Boolean = false
    }

    /** 默认态：可写、非手机发起、当前没在跑 —— **什么都不显示**。 */
    data object Idle : SessionStatus {
        override val kind = SessionStatusKind.Idle
        override val label: String = ""
        override val hint: String = ""
        override val showsDot: Boolean = false
    }

    companion object {

        /**
         * 判定一个会话行该不该有状态表达。
         *
         * @param stale `true` = 这份列表来自**离线快照**（`ConsoleRepository.fromCache`）：
         *   此时 `live` 是断线前的残留，不当作"运行中"。
         */
        fun resolve(session: SessionSummary, stale: Boolean = false): SessionStatus = when {
            session.live && !stale -> Live(liveHint(session))
            // 快照里的 live 不可信：当成只读，理由就是"这是旧快照"
            stale -> if (session.writable) Idle else ReadOnly(STALE_REASON)
            !session.writable -> ReadOnly(reason(session))
            session.isPhoneTask -> Phone
            else -> Idle
        }

        /**
         * 运行中的一句说明：与 `SessionSummary.liveHint` 同源，但**不重复状态词**
         * （胶囊上已经写了「运行中」），只补"谁在驱动"。
         */
        fun liveHint(session: SessionSummary): String = when {
            session.source == SessionSummary.SOURCE_PHONE -> "网关正在运行这一轮"
            session.writable -> "电脑端正在运行这一轮"
            else -> "电脑端正在运行这一轮（手机只读）"
        }

        /**
         * 「为什么发不出去」。
         *
         * 只在服务端**显式**给了 `writableReason` 时转述 [SessionSummary.readOnlyHeadline]；
         * 缺字段（老网关 2.0.0 整个 `writable` 都不下发）时按来源兜底，规则与
         * `ConsoleRepository` 的只读判定保持一致。**不编造"网关重启过"**——
         * 那对电脑端镜像会话是假话，用户会去电脑端找一个根本不存在的重启记录。
         */
        fun reason(session: SessionSummary): String {
            val explicit = session.writableReasonFlag?.trim()?.takeIf { it.isNotEmpty() }
            if (explicit != null) return session.readOnlyHeadline ?: UNKNOWN_REASON
            return when (session.source) {
                SessionSummary.SOURCE_PHONE -> "本会话已不可继续（网关重启或被停止过，SDK 无法接管既有会话）"
                // 电脑端会话 + 老网关：只读是"没交接"，不是"坏掉了"
                else -> "该会话还没交给网关接管（老网关或已断开的电脑端连接）"
            }
        }

        /** 会话详情页的"接下来怎么办"（列表里只弹原因，这里是完整一句）。 */
        fun readOnlyAction(session: SessionSummary): String = when {
            session.writableReasonFlag?.trim()?.equals(
                SessionSummary.REASON_SUBAGENT,
                ignoreCase = true,
            ) == true -> "在它的上层会话里继续。"
            session.source == SessionSummary.SOURCE_PHONE -> "需要新建一个任务。"
            else -> "在电脑端 DSH 里打开它，或等电脑端把会话交回网关后重试。"
        }

        internal const val STALE_REASON = "这是离线快照，联网后会重新确认"
        internal const val UNKNOWN_REASON = "本会话当前不可继续"
    }
}

/**
 * 行内第二/第三行的**元信息**（`12 轮 · 3 个文件`）——状态词在标题行的胶囊里，
 * 这里只放计数，不重复状态。
 *
 * 轮数为 0 时整段省略：新会话显示「0 轮」等于往空态里再塞一行零。
 */
fun sessionMetaLine(session: SessionSummary): String = buildList {
    if (session.turns > 0) add("${session.turns} 轮")
    if (session.hasChanges && session.changeCount > 0) add("${session.changeCount} 个文件")
}.joinToString(" · ")

/**
 * 预览行：`SessionSummary` 里没有消息正文（契约 §4.2 只给 `lastTurnState` / `lastTurnReason`），
 * 所以用真实存在的这两个字段拼一句，并把线上的英文枚举转成中文——
 * 界面上直接显示 `最后：completed` 的英文原值对用户没有任何意义。
 */
fun sessionPreviewText(session: SessionSummary): String {
    val state = session.lastTurnState?.trim()?.takeIf { it.isNotEmpty() }
    val reason = session.lastTurnReason?.trim()?.takeIf { it.isNotEmpty() }
    val body = when {
        reason != null -> reasonLabel(reason)
        state != null -> "上一轮 ${stateLabel(state)}"
        session.live -> "正在执行…"
        else -> "暂无摘要"
    }
    return "最后：$body"
}

private fun stateLabel(state: String): String = when (state.lowercase()) {
    "ended" -> "已结束"
    "running" -> "执行中"
    "aborted" -> "已中断"
    else -> state
}

private fun reasonLabel(reason: String): String = when (reason.lowercase()) {
    "completed" -> "已完成"
    "aborted" -> "已停止"
    "cancelled", "canceled" -> "已取消"
    "failed", "error" -> "执行失败"
    else -> reason
}
