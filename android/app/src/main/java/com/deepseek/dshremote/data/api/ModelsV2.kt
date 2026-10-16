package com.deepseek.dshremote.data.api

import org.json.JSONArray
import org.json.JSONObject

/**
 * 契约 v2 §4 的领域模型。
 *
 * 本文件是「手机端分页」的**公共契约**（m00002：对话与轨迹都不能再一股脑塞进单页）：
 * [TranscriptPage] / [TranscriptSync] 由数据层产出，界面层只读它们，不自己算游标。
 *
 * 约定：`argsJson` 这类"结构不固定"的字段保留**原始 JSON 文本**而不是解析好的对象，
 * 一是可以原样展示给用户（工具参数就是给用户看的），二是 data class 的 equals/hashCode
 * 在 Compose 里能正常工作（`JSONObject` 没有值语义）。
 */

/** 契约 §4.2 `GET /api/v2/sessions` 的一项。 */
data class SessionSummary(
    val id: String,
    val title: String,
    val workspace: String,
    val cwd: String,
    val createdAt: Long,
    val updatedAt: Long,
    val turns: Int,
    val steps: Int,
    val live: Boolean,
    /**
     * 会话种类（契约 §4.2 `origin`）：`"user"` 顶层用户会话 | `"subagent"` 子智能体会话。
     *
     * **可能是 null**（老网关/某些 driver 不下发该字段）。真实 DSH 桌面端写**顶层**会话
     * header 时根本不写 origin（实测 135 条会话里 30 条顶层全无此字段），只有子代理会话才由
     * `dsh-subagent` 显式写 `origin:"subagent"`。所以**缺字段绝不能当成 user**——
     * 那正是"子智能体会话在手机上刷屏"的成因。判定统一走 [isSubagent]。
     */
    val origin: String? = null,
    /**
     * 父会话 id（契约 §4.2 `parentSession`）：子代理会话、fork 出来的副本才有。
     *
     * 它和 [delegationDepth] 是 [isSubagent] 在 origin 缺失时的两条推断依据，
     * 也是「含子代理」打开后标出父子关系的依据。
     */
    val parentSession: String? = null,
    /**
     * 委派深度（契约 §4.2 `delegationDepth`）：顶层会话是 0，子代理是**父深度 + 1**。
     *
     * 它比 [origin] 更可靠——即使某个 driver 忘了写 origin，深度也骗不了人。
     */
    val delegationDepth: Int = 0,
    /**
     * 父会话标题（**本地派生，不在 wire 上**）：由 [com.deepseek.dshremote.data.ConsoleRepository]
     * 在同一次"含子代理"抓取的列表里按 [parentSession] 查出来回填。
     *
     * 有了它，用户才能把一条子代理会话认到具体某个任务上（「父会话「优化手机端 App 界面」」），
     * 而不是看到一串互相不认识的派生条目。父会话不在本次列表里时为 null，界面用 id 短写兜底。
     */
    val parentTitle: String? = null,
    val agentPreset: String,
    val bytes: Long,
    val eventCount: Int,
    val hasChanges: Boolean,
    val changeCount: Int,
    val lastTurnState: String?,
    val lastTurnReason: String?,
    /**
     * 来源：`computer`（PC 桌面端会话）| `phone`（网关自有 DSH_HOME 的手机任务）。
     *
     * 契约 §7.3 的两类会话仍然分开：手机任务一直是网关自己跑的。
     * 但电脑端会话**不再是只读镜像**——契约更新后电脑端 runtime 常驻，
     * 服务端对这类会话给 `writable:true`，手机发消息会写回电脑端同一段会话，
     * 电脑端的执行过程也经既有 SSE 实时推回来（见 [writable]）。
     */
    val source: String = SOURCE_COMPUTER,
    /** 服务端显式给出的可写性（契约 §4.2）；缺省时按 source 推导（老网关对电脑端会话不下发 → 只读）。 */
    val writableFlag: Boolean? = null,
    /**
     * 服务端给出的"为什么不可写"（契约 §4.2 `writableReason`）：
     * `desktop_disabled`（网关没接入电脑端）/ `subagent`（子代理会话不单独接管）/
     * `runtime_gone`（手机会话的 SDK 运行时已经没了）。null = 可写，或老网关没给。
     *
     * 只用于把"为什么发不了"说准，**不参与 [writable] 判定**。
     */
    val writableReasonFlag: String? = null,
    /**
     * 谁在驱动该会话（契约 §4.2 新增字段 `driver`）。
     *
     * 服务端在电脑端 runtime 驱动时下发 `"computer"`，网关自有会话下发 `"gateway"`，
     * 手机会话下发 null。归一化后只有 [DRIVER_DESKTOP] / [DRIVER_GATEWAY] 两个取值；
     * 老网关不发该字段时由 [driver] 按 source 推导。
     */
    val driverFlag: String? = null,
    /**
     * 谁**发起**的该会话（契约 §4.2 新增字段 `createdBy`）：`"phone"` | `"desktop"`。
     *
     * 网关 v2.1.0 起手机新建任务**默认落在电脑端 DSH**，于是同一条会话是
     * `createdBy:"phone" + source:"computer" + driver:"desktop"`——三个字段
     * 各说各的事（谁发起 / 数据长在谁家 / 现在谁在驱动），**不许互相反推**。
     * 老网关（2.0.0）不下发该字段，由 [createdBy] 按 source 回退成旧行为。
     */
    val createdByFlag: String? = null,
) {
    /** 工作区末段目录名：列表里显示全路径太吵。 */
    val workspaceLabel: String get() = WorkspaceLabels.label(workspace)

    /**
     * 是不是**子智能体/派生会话**（不该出现在缺省的「电脑会话」列表里）。
     *
     * 判据与服务端 `tools/dsh-remote/lib/dsh-home.mjs` 的 `isDerivedSession` **同源**，
     * 且同样是"缺 origin 时推断、绝不默认成 user"：
     * 1. `origin == "subagent"`（显式）；
     * 2. origin **缺失**时：`delegationDepth > 0` ⇒ 子代理（父深度 + 1 的权威计数）；
     * 3. origin **缺失**时：`parentSession` 非空 ⇒ fork/副本，同样不算顶层。
     *
     * 为什么 origin 存在时不再看 depth/parent：那是 DSH 桌面端自己的判据
     * （`origin === "subagent"` 一律隐藏），两端必须一致，否则同一个会话在电脑端
     * 隐藏、在手机端却冒出来。
     */
    val isSubagent: Boolean
        get() {
            val explicit = origin?.trim()?.lowercase()
            if (explicit != null && explicit.isNotEmpty()) return explicit == ORIGIN_SUBAGENT
            return delegationDepth > 0 || !parentSession.isNullOrBlank()
        }

    /**
     * 「含子代理」打开后，条目上的父子关系标注（例：「子代理 · 父会话「优化手机端 App 界面」」）。
     *
     * 父会话标题优先取本地回填的 [parentTitle]；查不到时退化成父会话 id 的短写，
     * 至少让人看出"它是别人派生的、不是独立任务"。顶层会话返回 null（不加徽标）。
     */
    val derivedLabel: String?
        get() {
            if (!isSubagent) return null
            val parentId = parentSession?.takeIf { it.isNotBlank() }
            val parent = parentTitle?.takeIf { it.isNotBlank() }
            return when {
                parent != null && delegationDepth > 1 -> "子代理 · 父会话「$parent」· 第 ${delegationDepth} 层"
                parent != null -> "子代理 · 父会话「$parent」"
                parentId != null && delegationDepth > 1 -> "子代理 · 父会话 ${shortId(parentId)} · 第 ${delegationDepth} 层"
                parentId != null -> "子代理 · 父会话 ${shortId(parentId)}"
                delegationDepth > 1 -> "子代理 · 第 ${delegationDepth} 层"
                else -> "子代理"
            }
        }

    /**
     * 谁发起的：服务端 `createdBy` 优先；**缺字段（老网关 2.0.0）时回退**
     * `source == "phone" -> phone`、否则 `desktop`，与旧版按 source 认"我的任务"完全一致。
     */
    val createdBy: String get() = when (createdByFlag?.trim()?.lowercase()) {
        CREATED_BY_PHONE -> CREATED_BY_PHONE
        CREATED_BY_DESKTOP -> CREATED_BY_DESKTOP
        else -> if (source == SOURCE_PHONE) CREATED_BY_PHONE else CREATED_BY_DESKTOP
    }

    /** 手机发起的会话（含"手机发起但落在电脑端执行"）——「手机任务」页认这个。 */
    val isPhoneTask: Boolean get() = createdBy == CREATED_BY_PHONE

    /** 电脑端会话（按**数据在哪**判，与谁发起无关）：电脑端会话列表认这个。 */
    val isComputerSession: Boolean get() = source == SOURCE_COMPUTER

    /** 数据长在谁家：「手机」/「电脑」。只描述 source，不描述谁发起。 */
    val sourceLabel: String get() = when (source) {
        SOURCE_PHONE -> "手机"
        SOURCE_COMPUTER -> "电脑"
        else -> source
    }

    /** 谁发起的：「手机发起」/「电脑发起」。 */
    val createdByLabel: String get() = if (isPhoneTask) "手机发起" else "电脑发起"

    /** 在哪执行：「手机执行」（网关自有 SDK 会话）/「电脑执行」。 */
    val executionLabel: String get() = if (source == SOURCE_PHONE) "手机执行" else "电脑执行"

    /**
     * 列表/详情里的来源徽标：把"谁发起"和"在哪执行"合起来说，避免误导。
     *
     * 三种真实组合各自的文案：
     * - 手机发起 + 电脑执行（v2.1.0 的默认新建）→ 「手机发起 · 电脑执行」
     * - 电脑发起 + 电脑执行（电脑端自己的会话）→ 「电脑」
     * - 手机发起 + 手机执行（`host:"gateway"`）→ 「手机」
     */
    val originLabel: String get() = when {
        isPhoneTask && source == SOURCE_COMPUTER -> "手机发起 · 电脑执行"
        isPhoneTask -> "手机"
        source == SOURCE_COMPUTER -> "电脑"
        else -> sourceLabel
    }

    /** 手机能否在该会话里发消息（契约 §4.2）：服务端 `writable` 优先，缺字段时只有网关自有会话可写。 */
    val writable: Boolean get() = writableFlag ?: (source == SOURCE_PHONE)

    /**
     * 驱动方：服务端 `driver` 优先；**缺字段（老网关）时按 source 推导**
     * （computer → [DRIVER_DESKTOP]，phone → [DRIVER_GATEWAY]）。
     *
     * 服务端在 wire 上用 `"computer"` 表示电脑端 runtime（[DRIVER_COMPUTER]），
     * 这里归一化成 [DRIVER_DESKTOP]；未知取值同样回退到 source 推导。
     */
    val driver: String get() = when (driverFlag?.trim()?.lowercase()) {
        DRIVER_DESKTOP, DRIVER_COMPUTER -> DRIVER_DESKTOP
        DRIVER_GATEWAY -> DRIVER_GATEWAY
        else -> if (source == SOURCE_PHONE) DRIVER_GATEWAY else DRIVER_DESKTOP
    }

    /** 是否由电脑端 runtime 真实驱动（详情页据此说明"消息落到哪里"）。 */
    val isDesktopDriven: Boolean get() = driver == DRIVER_DESKTOP

    /** 驱动方文案（详情页副标题）。 */
    val driverLabel: String get() = if (isDesktopDriven) "电脑驱动" else "网关驱动"

    /**
     * 不可写时的一句**原因**（不含"接下来怎么办"的建议——那半句由界面按来源补）。
     * 可写时为 null，界面不必再判 [writable]。
     */
    val readOnlyHeadline: String?
        get() = when {
            writable -> null
            writableReasonFlag?.trim()?.lowercase() == REASON_DESKTOP_DISABLED ->
                "电脑端还没把该会话交给网关接管"
            writableReasonFlag?.trim()?.lowercase() == REASON_SUBAGENT ->
                "子代理会话不单独接管，请在它的上层会话里继续"
            writableReasonFlag?.trim()?.lowercase() == REASON_RUNTIME_GONE ->
                "本会话已不可继续（网关重启或被停止过，SDK 无法接管既有会话）"
            // 老网关不给原因：只能按来源给一句兜底
            source == SOURCE_PHONE -> "本会话已不可继续（网关重启或被停止过，SDK 无法接管既有会话）"
            else -> "电脑端还没把该会话交给网关接管"
        }

    /**
     * 可续聊徽标文案：电脑端会话要在列表里一眼分清「能续聊」与「只读镜像」。
     *
     * 网关自有会话（`source == phone`）返回 null——它们从来都可续聊。
     * 判据用 source 而不是 [isPhoneTask]：手机发起但落在电脑端的会话也要显示「可续聊」。
     */
    val accessLabel: String? get() = when {
        source == SOURCE_PHONE -> null
        writable -> "可续聊"
        else -> "只读"
    }

    /** `live == true` 那一行的文案。 */
    val liveHint: String get() = when {
        source == SOURCE_PHONE -> "网关正在运行这一轮"
        writable -> "电脑端正在驱动 · 手机可续聊"
        else -> "电脑端正在驱动（手机只读）"
    }

    companion object {
        const val SOURCE_COMPUTER = "computer"
        const val SOURCE_PHONE = "phone"

        /** `origin`：顶层用户会话（服务端可能下发，也可能整个字段都不给）。 */
        const val ORIGIN_USER = "user"

        /** `origin`：子智能体（派生）会话。 */
        const val ORIGIN_SUBAGENT = "subagent"

        /** 会话 id 的短写（列表里显示完整 UUID 太吵；父会话找不到标题时用它兜底）。 */
        fun shortId(id: String): String {
            val body = id.removePrefix("session-")
            return if (body.length <= 8) body else body.take(8)
        }

        /** `createdBy`：手机发起。 */
        const val CREATED_BY_PHONE = "phone"

        /** `createdBy`：电脑端发起。 */
        const val CREATED_BY_DESKTOP = "desktop"

        /** 归一化后的驱动方：电脑端 runtime。 */
        const val DRIVER_DESKTOP = "desktop"

        /** 服务端 wire 上表示电脑端 runtime 的取值（[driver] 会把它归一化成 [DRIVER_DESKTOP]）。 */
        const val DRIVER_COMPUTER = "computer"

        /** 归一化后的驱动方：网关自有 SDK 会话（wire 上同值）。 */
        const val DRIVER_GATEWAY = "gateway"

        /** `writableReason`：网关没接入电脑端。 */
        const val REASON_DESKTOP_DISABLED = "desktop_disabled"

        /** `writableReason`：子代理会话不单独接管。 */
        const val REASON_SUBAGENT = "subagent"

        /** `writableReason`：手机会话的 SDK 运行时已经没了。 */
        const val REASON_RUNTIME_GONE = "runtime_gone"
    }
}

/**
 * 在一批会话里就地回填父会话标题（**只查这一批，不发请求**）。
 *
 * 为什么需要：`parentTitle` 是本地派生字段、不落缓存，离线回放时它是 null，
 * 于是「含子代理」打开后只能显示父会话 id 的短写。界面拿到列表后过一遍这个函数，
 * 只要父会话也在这批里（正常情况下都在），就能显示成「父会话「优化手机端 App 界面」」。
 * 父会话不在本批里就原样返回——宁可显示 id，也不编一个标题。
 */
fun List<SessionSummary>.withParentTitles(): List<SessionSummary> {
    if (none { it.parentSession != null }) return this
    val titles = associate { it.id to it.title }
    return map { session ->
        val title = session.parentSession?.let { titles[it] }
        if (title.isNullOrBlank()) session else session.copy(parentTitle = title)
    }
}

object WorkspaceLabels {
    fun label(path: String): String {
        val normalized = path.replace('\\', '/').trimEnd('/')
        if (normalized.isEmpty()) return path
        return normalized.substringAfterLast('/').ifEmpty { normalized }
    }
}

/**
 * 会话里的一张图片（契约 §4.2 `images[]`，v2.9.0）。
 *
 * **为什么是"引用"而不是字节**：图片字节从来不进会话事件日志，运行时把它们写在本机
 * 附件对象库里（`<dsh home>/attachments/<version>/objects/<前2位>/<64位hex>`），日志里只有
 * `{type:'image', attachment:{attachmentId:'sha256:<hex>', mediaType, width, height, bytes, name}}`。
 * 所以服务端投影出来的只能是"哪里有一张图"，字节要另走
 * `GET /api/v2/attachments/{id}` 按需取（见 `DshApiV2.fetchAttachment`）。
 *
 * [id] 是内容哈希（`sha256:` 前缀 + 64 位小写 hex），同一张图在多个消息里复用同一个 id，
 * 因此它可以安全地当内存/磁盘缓存的键——内容寻址意味着**字节永不变**。
 */
data class ImageRef(
    val id: String,
    val mediaType: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val bytes: Int? = null,
    val name: String? = null,
) {
    /** 这张图能不能真的取回来（没有 id 的引用只用于占位，别去请求）。 */
    val isFetchable: Boolean get() = id.startsWith("sha256:") && id.length == 71

    /** 无障碍/占位文案：优先文件名，其次尺寸，最后兜底。 */
    val label: String
        get() = name?.takeIf { it.isNotBlank() }
            ?: if (width != null && height != null) "${width}×${height} 图片" else "图片"
}

/** 工具调用（契约 §4.2 `toolCalls[]`）。 */
data class ToolCall(
    val id: String,
    val name: String,
    val argsJson: String,
    val result: String,
    val isError: Boolean,
    val truncated: Boolean,
    val durationMs: Long,
    /**
     * 这次工具调用产出的图片（`read_image`、截图、画图类工具常见）。
     *
     * 与 [ChatMessage.images] 同一形状、同一取字节的方式：结果文本里往往只有一句
     * "已读取图片"，真正的产物是附件引用。
     */
    val images: List<ImageRef> = emptyList(),
) {
    val args: JSONObject? get() = runCatching { JSONObject(argsJson) }.getOrNull()

    /** 参数摘要（折叠态显示）：取第一个有意义的标量参数。 */
    val argsSummary: String get() = ToolCallSummary.summarize(name, argsJson)

    val hasResult: Boolean get() = result.isNotEmpty()
}

/** 交付物（契约 §4.2 `deliverables[]`）。 */
data class Deliverable(val path: String, val description: String)

/** 待办项（从 `todo`/`write` 类工具调用的参数里投影出来，见 [TodoExtractor]）。 */
data class TodoItem(val text: String, val status: String) {
    val done: Boolean get() = status == "completed" || status == "done" || status == "finished"
}

/** 一条已投影的对话消息。 */
data class ChatMessage(
    val seq: Long,
    val role: String,
    val at: Long,
    val text: String,
    val toolCalls: List<ToolCall> = emptyList(),
    val deliverables: List<Deliverable> = emptyList(),
    /** 系统消息里的待办（gateway-dev 确认：待办是 `{role:'system', todos:[{content,status}]}`）。 */
    val todos: List<TodoItem> = emptyList(),
    val truncated: Boolean = false,
    /**
     * 这条消息里的图片（契约 §4.2，v2.9.0）。
     *
     * 典型场景：用户在电脑端贴了一张图提问，网关投影出的是**只有图片、没有文本**的一条
     * user 消息（`text` 为空串）。所以 [isEmpty] 必须把图片算作内容，否则界面会把这条
     * 消息整条丢掉——那正是"手机上看不到图"的第一个断点。
     */
    val images: List<ImageRef> = emptyList(),
    /**
     * 这条消息属于第几轮（v2.9.0 起 user 消息也带上；老网关/本地乐观消息为 null）。
     *
     * 用途只有一个：让界面知道"这一轮已经在窗口里了"，从而把轮次导航里的该项标成已加载，
     * 而不是再取一次同样的数据。
     */
    val turn: Int? = null,
) {
    val isUser: Boolean get() = role == "user"

    val isAssistant: Boolean get() = role == "assistant"

    val isEmpty: Boolean
        get() = text.isBlank() && toolCalls.isEmpty() && deliverables.isEmpty() &&
            todos.isEmpty() && images.isEmpty()
}

/**
 * 实时草稿的增量合并规则（SSE 事件的唯一实现）。
 *
 * `ConsoleRepository.applyEvent` 收到 `assistant/message`、`tool/start`、`tool/result` 时，
 * 把事件合并进"正在生成的那条消息"（草稿）——电脑端会话的实时性就靠这三条规则。
 * 规则本身抽在这里而不是留在仓库里，是因为 `ConsoleRepository` 需要 Android Context，
 * 纯 JVM 单测起不来（同一原因见 TranscriptPagerTest 的说明）；这里全是无副作用的纯函数，
 * 仓库层只负责把结果落进 `_drafts`。**不要在两处各写一份**。
 */
object LiveDraftMerge {
    /**
     * `assistant/message` 增量：同一会话的草稿上累加文本。
     *
     * `seq` 取事件给出的值；事件没给（例如只有一个纯文本帧）时保留旧值，
     * 新建草稿则用 0（与本地乐观消息同一约定：[ChatMessage.seq] 恒由服务端投影覆盖）。
     */
    fun delta(existing: ChatMessage?, seq: Long?, role: String, text: String, at: Long): ChatMessage =
        if (existing == null) {
            ChatMessage(seq = seq ?: 0L, role = role, at = at, text = text)
        } else {
            existing.copy(text = existing.text + text, seq = seq ?: existing.seq)
        }

    /** `tool/start`：没有草稿就先起一条空的 assistant 消息，再把工具调用挂上去。 */
    fun toolStarted(
        existing: ChatMessage?,
        seq: Long?,
        name: String,
        argsJson: String,
        at: Long,
    ): ChatMessage {
        val base = existing ?: ChatMessage(seq = seq ?: 0L, role = "assistant", at = at, text = "")
        val call = ToolCall(
            id = "live-${seq ?: 0L}",
            name = name,
            argsJson = argsJson,
            result = "",
            isError = false,
            truncated = false,
            durationMs = 0L,
        )
        return base.copy(toolCalls = base.toolCalls + call)
    }

    /**
     * `tool/result`：回填**第一个还没有结果的**工具调用（并发调用按到达顺序两两配对）。
     *
     * 返回 null 表示该会话没有在途草稿，调用方直接跳过（不凭空造一条只有结果的消息）。
     */
    fun toolResult(existing: ChatMessage?, result: String, isError: Boolean): ChatMessage? {
        if (existing == null) return null
        var filled = false
        val calls = existing.toolCalls.map { call ->
            if (!filled && call.result.isEmpty()) {
                filled = true
                call.copy(result = result, isError = isError)
            } else {
                call
            }
        }
        return existing.copy(toolCalls = calls)
    }
}

/** 轨迹行的种类（界面图标/配色的唯一判据）。 */
enum class TrajectoryKind { TURN, THOUGHT, TOOL, RESULT, DELIVERABLE, TODO, NOTE }

/**
 * 「轨迹」视图的一行（m00002）。
 *
 * 轨迹不是另一份数据，而是**对话记录的另一种切分**：把每条消息里的工具调用、结果、交付物、
 * 待办摊平成"一步一行"，于是长会话可以按步翻页，而不是把整段对话一次画完。
 * 它与对话流共用同一份分页窗口（同一个 [ChatMessage.seq] 空间），因此翻页语义完全一致。
 */
data class TrajectoryRow(
    /** 归属消息的 seq：分页/去重/稳定性都靠它。 */
    val seq: Long,
    /** 同一消息内的行序（工具调用可能一次并行好几个）。 */
    val index: Int,
    val at: Long,
    val kind: TrajectoryKind,
    val title: String,
    val detail: String = "",
    val isError: Boolean = false,
) {
    /** LazyColumn 的稳定 key（同一条消息可以摊出多行，故必须带上 index）。 */
    val rowKey: String get() = "$seq:$index:$kind"
}

/**
 * transcript 的一页（契约 §4.2 `GET /api/v2/sessions/{id}/transcript`）。
 *
 * [nextCursor] 是**更早**那一页的游标（服务端语义：cursor 是排他上界）；null = 已到最早。
 *
 * ## 为什么"字段为 null"与"字段缺失"必须分开（[cursorProvided]）
 *
 * 协议里这两种情况都会让 [nextCursor] 读出来是 null，但含义**相反**：
 *
 * - **字段在、值为 null**：服务端**明确说**"已经到最早，没有更早的页了" ⇒ 客户端必须关掉游标；
 * - **字段压根不在**（老网关，例如证据夹具 `mock-tunnel.mjs` 老版本只回 `{sessionId, messages}`）：
 *   服务端**没有表态**，只是不给分页 ⇒ 客户端必须保留手里的旧游标，不能把"没分页信息"
 *   误判成"已到最早"，否则一次老网关响应就会让向上翻页永久失效。
 *
 * 不能靠 `optString("nextCursor") == ""` 区分：`optString` 对"缺失"和"显式 null"都返回空串，
 * 只有 `JSONObject.has("nextCursor")` 能把它们分开（显式 JSON null 时 `has` 为 true、`isNull` 为 true）。
 */
data class TranscriptPage(
    val messages: List<ChatMessage> = emptyList(),
    val nextCursor: String? = null,
    val total: Int = 0,
    val from: Int = 0,
    val to: Int = 0,
    /** 响应里是否**存在** `nextCursor` 字段（false = 老网关不表态，见类注释）。 */
    val cursorProvided: Boolean = true,
) {
    /** 服务端是否明确说了"还有更早的消息"。 */
    val hasMoreOlder: Boolean get() = !nextCursor.isNullOrEmpty()
}

/**
 * 分页元信息：界面用它渲染「加载更早」入口与「已加载 N / 共 M 条」。
 *
 * 与消息列表**分开**保存：消息列表会被 SSE 增量与本地乐观消息改写，
 * 而游标只能由服务端分页响应推进（本地插入的消息没有服务端下标，不能拿来算游标）。
 */
data class TranscriptSync(
    /** 下一次「加载更早」要带的游标；null = 已经到最早（或无更多）。 */
    val nextCursor: String? = null,
    /** 服务端报告的当前投影总条数（排除 internal）。 */
    val total: Int = 0,
    /** 本机已缓存的滑动窗口下界/上界（服务端下标，0 = 未知）。**只是显示用的近似值**。 */
    val loadedFrom: Int = 0,
    val loadedTo: Int = 0,
    /**
     * 窗口里**实际**装着多少条服务端消息。
     *
     * 为什么不拿 [loadedTo] - [loadedFrom] 当已加载条数：那两个数只是"上界减窗口条数"的推算，
     * 一旦有裁剪或页与页之间不连续，推算值会**虚高**（实测：只取回一页更早的，
     * 计数就跳到"已加载 220/220"，而窗口里只有 120 条）。计数必须来自窗口本身。
     */
    val loaded: Int = 0,
    /** 窗口是否被裁过（裁掉的是"更早"还是"最新"，决定提示文案）。 */
    val trimmedOlder: Boolean = false,
    val trimmedNewer: Boolean = false,
    /** 首屏分页是否已完成（false 时界面显示骨架而不是"没有更多"）。 */
    val initialized: Boolean = false,
) {
    val hasMoreOlder: Boolean get() = !nextCursor.isNullOrEmpty()

    /** 「已加载 N / 共 M 条」用的已加载条数 —— 窗口内实际条数。 */
    val loadedCount: Int get() = loaded
}

/**
 * 轮次索引的一行（契约 §4.2 `GET /api/v2/sessions/{id}/turn-index`，v2.9.0）。
 *
 * **为什么需要服务端给下标**：手机端只把最近 60 条消息拿在手里，而"跳到第 12 轮"要能取回
 * 第 12 轮那一段。让客户端自己数是没有用的（没加载的历史它根本看不见），所以服务端在
 * **与 `/transcript` 完全同一套投影**上给出每轮的消息区间：
 * `[fromIndex, toIndex)` —— 于是客户端只要 `cursor=toIndex&limit=60` 就能取到
 * "以该轮结尾"的那一页，和任何一页的翻页语义完全一致（cursor 是排他上界）。
 *
 * [userText]/[assistantText] 已在服务端截断（各 ≤200 字符），就是给预览卡用的：
 * 手机不需要为了显示两行摘要而把整轮正文拉过来。
 */
data class TurnIndexEntry(
    /** 轮次号（从 1 开始，与界面上的「第 N 轮」同一套编号）。 */
    val turn: Int,
    /** 该轮第一条消息在 transcript 消息数组里的下标（0 基）。 */
    val fromIndex: Int,
    /** 该轮之后第一条消息的下标（排他上界）= 取这一轮要用的 cursor。 */
    val toIndex: Int,
    /** 该轮开始时间（毫秒；老网关不给时为 0）。 */
    val at: Long = 0L,
    val userText: String = "",
    val assistantText: String = "",
    /** 这一轮里的步数（助手消息条数）与工具调用数，用于预览卡的次级信息。 */
    val steps: Int = 0,
    val toolCalls: Int = 0,
) {
    /** 这一轮包含多少条消息（服务端投影口径，含工具结果）。 */
    val messageCount: Int get() = (toIndex - fromIndex).coerceAtLeast(0)

    /** 取这一轮要用的分页游标（服务端 cursor 是排他上界）。 */
    val cursor: String get() = toIndex.toString()
}

/**
 * 会话的轮次索引（`total` = 总轮数，`turns` 可能被服务端裁剪，故两者分开看）。
 *
 * [totalMessages] 是与 `/transcript` 同口径的消息总条数——它让界面能说清
 * "已加载 60 / 共 733 条"，而不必再单独请求一次空页。
 */
data class TurnIndex(
    val sessionId: String = "",
    val total: Int = 0,
    val totalMessages: Int = 0,
    val turns: List<TurnIndexEntry> = emptyList(),
) {
    val isEmpty: Boolean get() = turns.isEmpty()

    /** 索引是否覆盖到第 [turn] 轮（没覆盖时界面不该承诺"能跳"）。 */
    fun contains(turn: Int): Boolean = turns.any { it.turn == turn }

    fun entry(turn: Int): TurnIndexEntry? = turns.firstOrNull { it.turn == turn }
}

/**
 * 会话详情页的两个视图（m00002：分开翻页，避免单页里堆到看不见）。
 *
 * - [CONVERSATION]：对话流（气泡 + 助手消息 + 工具卡）；
 * - [TRAJECTORY]：轨迹（把工具调用/结果/交付物/待办摊平成"一步一行"）。
 */
enum class SessionViewMode { CONVERSATION, TRAJECTORY }

data class WorkspaceEntry(
    val name: String,
    val path: String,
    val type: String,
    val size: Long?,
    val modifiedAt: Long?,
) {
    val isDir: Boolean get() = type == "dir"

    val isSymlink: Boolean get() = type == "symlink"
}

data class DirListing(
    val workspace: String,
    val path: String,
    val entries: List<WorkspaceEntry>,
    val truncated: Boolean,
)

data class FileContent(
    val path: String,
    val name: String,
    val size: Long,
    val modifiedAt: Long?,
    val binary: Boolean,
    val truncated: Boolean,
    val text: String,
) {
    val lineCount: Int get() = if (text.isEmpty()) 0 else text.count { it == '\n' } + 1
}

/** 改动项；`status` 是 git porcelain 的字母（M/A/D/?…），UI 映射见 [VcsBadge]。 */
data class ChangeEntry(
    val path: String,
    val status: String,
    val staged: Boolean,
    val insertions: Int,
    val deletions: Int,
    val isBinary: Boolean,
) {
    val badge: VcsBadge get() = VcsBadge.of(status)

    val fileName: String get() = path.replace('\\', '/').substringAfterLast('/')
}

data class ChangeSet(
    val workspace: String,
    val vcs: String,
    val branch: String?,
    val changed: List<ChangeEntry>,
    val untracked: List<String>,
    val clean: Boolean,
) {
    val isGit: Boolean get() = vcs == "git"

    val totalInsertions: Int get() = changed.sumOf { it.insertions }

    val totalDeletions: Int get() = changed.sumOf { it.deletions }
}

data class DiffResult(
    val workspace: String,
    val path: String,
    val file: String,
    val vcs: String,
    val unified: String,
    val truncated: Boolean,
) {
    val lines: List<String> get() = if (unified.isEmpty()) emptyList() else unified.split('\n')
}

data class SearchHit(
    val path: String,
    val name: String,
    val line: Int?,
    val text: String,
    val kind: String,
) {
    val isFileHit: Boolean get() = kind == "file"
}

/** `POST /api/v2/sessions/{id}/turns` 与 `/abort` 的响应。 */
data class TurnAccepted(
    val accepted: Boolean,
    val sessionId: String,
    val turnId: String,
    val fromSeq: Long,
    /**
     * 该会话是否还能继续（契约裁定）。
     *
     * `POST /abort` 的响应会带 `resumable:false` —— SDK 没有 cancel，停进程等于毁掉该会话。
     */
    val resumable: Boolean? = null,
)

/** 新建手机任务的结果（`POST /api/v2/tasks`，契约 §4.2 裁定）。 */
data class CreateTaskOutcome(
    val sessionId: String,
    val turnId: String,
    val accepted: Boolean,
    val source: String = SessionSummary.SOURCE_PHONE,
    val fromSeq: Long = -1L,
    /**
     * 网关实际生效的权限档（契约 §4.2 的 `access`）。
     *
     * 旧网关不回该字段 → null；手机据此提示"该网关不支持权限选择，任务按仅当前工作区执行"。
     */
    val access: String? = null,
    /**
     * 这次任务实际落在哪执行（契约 §4.2 回执字段 `host`）：`"desktop"` | `"gateway"`。
     *
     * 旧网关不回该字段 → null，由 [runsOnDesktop] 按 [source] 推导。
     */
    val host: String? = null,
    /** 谁发起的（回执里恒为 `"phone"`，留着是为了不靠猜）。旧网关不回 → null。 */
    val createdBy: String? = null,
    /**
     * 请求里的模型**是否真的生效了**（`GET /api/v2/models` 那一套的能力边界）。
     *
     * - `false`：手机选了模型、网关也收到了，但切换失败（电脑端拒绝/连不上），任务仍按电脑端
     *   当前模型跑 —— 这时必须让用户看见 [modelWarning]，否则界面上写着 A 模型、实际跑的是 B；
     * - `null`：没请求模型，或网关是旧版本不回这个字段（此时"没生效"不可知，不许当成成功）。
     */
    val modelApplied: Boolean? = null,
    /** 模型没生效的原因（人类可读，直接展示）；仅 [modelApplied] == false 时有值。 */
    val modelWarning: String? = null,
) {
    /** 生效档位（未知/缺失一律按默认档理解）。 */
    val taskAccess: TaskAccess get() = TaskAccess.fromWire(access)

    /**
     * 是否落在电脑端执行：回执 `host` 优先，缺字段（旧网关）时按 [source] 推导。
     *
     * 电脑端任务**没有**权限档可谈——权限跟随电脑端 DSH 自己的设置。
     */
    val runsOnDesktop: Boolean get() = when (TaskHost.fromWireOrNull(host)) {
        TaskHost.DESKTOP -> true
        TaskHost.GATEWAY -> false
        else -> source == SessionSummary.SOURCE_COMPUTER
    }
}

/**
 * 创建成功后给用户一句"这次到底在哪跑、以哪种权限跑的"。
 *
 * 两条硬要求（抽成纯函数就是为了在单测里钉住它们）：
 * - 落电脑端时**不许谈权限档**：权限跟随电脑端 DSH 自己的设置，手机端根本没指定
 *   （请求也不带 `access`，回执里也没有），说成"已按某档执行"就是撒谎；
 * - 旧网关（不带 `access` 回执）必须说清楚是**按默认档**执行的，否则用户勾了「全部权限」
 *   却只拿到工作区档，会以为任务失败或网关坏掉。
 */
fun CreateTaskOutcome.placementNote(): String = when {
    runsOnDesktop -> "（已在电脑端执行，电脑上也能看到；权限跟随电脑端 DSH 设置）"
    access == null -> "（网关未回执权限档，按「仅当前工作区」执行）"
    taskAccess.isDangerous -> "（已按「全部权限」执行）"
    else -> "（已按「仅当前工作区」执行）"
}

// ---------- 模型（新建任务时可选） ----------

/**
 * 一次模型选择（wire 上就是 `model` + `provider` + 可选 `reasoningEffort`）。
 *
 * `provider` 不是可有可无的装饰：同一个模型 id 可能挂在多个 provider（官方 API、订阅登录…）下，
 * 只发 `model` 时由服务端猜 provider，猜错的表现是"任务跑了，但用的是另一个账号/配额"。
 */
data class ModelSelection(
    val provider: String,
    val model: String,
    val reasoningEffort: String? = null,
)

/** 目录里的一个模型（`GET /api/v2/models` 的 `groups[].models[]`）。 */
data class ModelEntry(val id: String, val name: String, val description: String? = null)

/** 一个 provider 及其可用模型（`groups[]`）。 */
data class ModelGroup(val id: String, val name: String, val models: List<ModelEntry>)

/** 某个 provider 探不到模型时的原因（`failures[]`）——要能显示给用户，不能静默吞掉。 */
data class ModelFailure(val id: String, val name: String, val message: String)

/**
 * 手机端可选模型目录（`GET /api/v2/models`）。
 *
 * 设计要点（决定了界面上"模型"这一项该怎么画）：
 * - [source] 是**能力边界**而不是装饰：`"desktop"` = 目录来自电脑端 runtime（真实清单）；
 *   `"config"` = 电脑端没连上，网关只能报它自己配置里的那一个模型（[groups] 为空）。
 *   界面据此把选择器置灰并说明原因，而不是画一个点不动的空菜单；
 * - 旧网关没有这个端点 → [isKnown] 为 false：此时**不显示模型选择器**（宁可不给，也不给假的）；
 * - [defaultSelection] 是"不选就按它跑"的那个模型，用来给选择器一个诚实的默认文案。
 */
data class ModelCatalog(
    val defaultSelection: ModelSelection? = null,
    val groups: List<ModelGroup> = emptyList(),
    val failures: List<ModelFailure> = emptyList(),
    val source: String = "",
) {
    /** 网关是否真的有这个端点（旧网关 → false：不画选择器）。 */
    val isKnown: Boolean get() = source.isNotEmpty()

    /** 目录里是否真有可选项（只有默认模型时不算）。 */
    val hasChoices: Boolean get() = groups.any { it.models.isNotEmpty() }

    /**
     * 给选择器用的一行文案。
     *
     * [selection] 为 null = 跟随默认；查不到名字时**回落成原始 id**（宁可显示 `deepseek-v4-pro`
     * 也不要显示"未知模型"——用户至少能认出自己选的是哪个）。
     */
    fun labelFor(selection: ModelSelection?): String {
        val target = selection ?: defaultSelection ?: return "默认"
        val name = groups.asSequence()
            .flatMap { it.models.asSequence() }
            .firstOrNull { it.id == target.model }
            ?.name
        return name ?: target.model
    }

    /** 这个 provider 在不在目录里（用来判断用户手上那个选择还需要保留吗）。 */
    fun contains(selection: ModelSelection?): Boolean {
        if (selection == null) return true
        return groups.any { group -> group.id == selection.provider && group.models.any { it.id == selection.model } }
    }

    companion object {
        const val SOURCE_DESKTOP = "desktop"
        const val SOURCE_CONFIG = "config"

        /** 旧网关：端点不存在。空目录 + 空 source。 */
        val UNKNOWN = ModelCatalog()
    }
}

/** 工作区 + git 摘要（`GET /api/v2/workspaces`）。 */
data class WorkspaceSummary(
    val path: String,
    val label: String,
    val exists: Boolean,
    val vcs: String,
    val branch: String?,
    val changed: Int,
    val insertions: Int,
    val deletions: Int,
) {
    val isGit: Boolean get() = vcs == "git"
}

/** `POST /api/v2/pair/claim` 的响应（含 §2.3 的 `relay` 块）。 */
data class PairClaimV2(
    val token: String,
    val tokenId: String,
    val serverName: String,
    val expiresAt: Long?,
    val homeId: String,
    val deviceToken: String,
    val tunnelUrl: String,
    /**
     * 网关是否**真的支持中继**（契约裁定：`relay` 块存在与否是唯一判据）。
     *
     * 旧网关不会返回 `relay` 块 —— 此时手机拿不到隧道凭据，v2 传输根本无法建立，
     * UI 必须明确说"该电脑未启用中继"，而不是笼统报一个配对失败。
     */
    val hasRelayBlock: Boolean = false,
) {
    /** 网关 API 用的 Bearer：v1 `token` 优先，缺失时退回隧道令牌。 */
    val apiToken: String get() = token.ifEmpty { deviceToken }

    /** 隧道准入令牌：`relay.deviceToken` 优先，缺失时退回 v1 `token`（老网关兼容）。 */
    val effectiveDeviceToken: String get() = deviceToken.ifEmpty { token }
}

/** 中继 `GET /health`（契约 §2.1）。 */
data class RelayHealth(
    val ok: Boolean,
    val relayVersion: String,
    val apiVersion: Int,
    val uptimeMs: Long,
    val homes: Int,
    val devices: Int,
    val relayName: String,
)

/**
 * 网关 `GET /api/v1/health`（经隧道调用）。
 *
 * 版本探测的硬规则（契约 §4.5）：`apiVersion` **恒为 1**（v1 端点的版本号，
 * 已装机客户端用它判兼容），v2 能力只能看新增字段 `supportedApiVersions`。
 */
data class GatewayHealth(
    val ok: Boolean,
    val apiVersion: Int,
    val supportedApiVersions: List<Int>,
    val serverName: String,
    val gatewayVersion: String,
    val dshVersion: String,
    val relayEnabled: Boolean,
    val relayConnected: Boolean,
) {
    val supportsV2: Boolean get() = supportedApiVersions.contains(2)

    /** 设置页展示用的一句话结论。 */
    val capabilityNote: String
        get() = when {
            supportsV2 -> "支持 v2（X-Api-Version: 2 可用）"
            supportedApiVersions.isEmpty() -> "老网关未声明 supportedApiVersions，只能按 v1 使用"
            else -> "仅支持 v${supportedApiVersions.maxOrNull()}"
        }
}

/** 设备（令牌）信息，设置页展示 + 吊销自己的令牌用。 */
data class DeviceInfo(
    val tokenId: String,
    val deviceName: String,
    val pairedAt: Long?,
    val lastSeenAt: Long?,
    val revoked: Boolean,
)

/**
 * git 状态字母 → 徽标（纯映射，可单测）。
 *
 * 直接对齐 `git status --porcelain` 的字母表；未知字母归到 [OTHER] 而不是丢弃，
 * 保证"有改动却看不出来"这种情况不会发生。
 */
enum class VcsBadge(val letter: String, val label: String, val colorArgb: Int) {
    MODIFIED("M", "修改", 0xFFE0A15C.toInt()),
    ADDED("A", "新增", 0xFF4CC38A.toInt()),
    DELETED("D", "删除", 0xFFFF5A52.toInt()),
    RENAMED("R", "重命名", 0xFF6FA8FF.toInt()),
    COPIED("C", "复制", 0xFF6FA8FF.toInt()),
    UNTRACKED("?", "未跟踪", 0xFF8A8A8A.toInt()),
    CONFLICT("U", "冲突", 0xFFFF5A52.toInt()),
    TYPE_CHANGED("T", "类型变更", 0xFFE0A15C.toInt()),
    IGNORED("!", "已忽略", 0xFF6B6B6B.toInt()),
    OTHER("?", "变更", 0xFF8A8A8A.toInt()),
    ;

    companion object {
        /** porcelain 原样给的未跟踪标记；`?` 与 `??` 都表示未跟踪。 */
        private const val UNTRACKED_LETTER = "?"

        fun of(status: String): VcsBadge {
            val trimmed = status.trim()
            if (trimmed.isEmpty()) return OTHER
            // git porcelain 的 `?`/`??` 与 `!`/`!!` 是"整串就是标记"，不能按首字母取
            if (trimmed.all { it == '?' }) return UNTRACKED
            if (trimmed.all { it == '!' }) return IGNORED
            val letter = trimmed.first().uppercaseChar().toString()
            return entries.firstOrNull { it.letter == letter } ?: OTHER
        }
    }
}

/** diff 单行分类（unified diff 着色用，纯函数）。 */
enum class DiffLineKind { ADDED, REMOVED, HUNK, META, CONTEXT }

object DiffClassifier {
    fun classify(line: String): DiffLineKind = when {
        line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") ||
            line.startsWith("index ") || line.startsWith("new file") ||
            line.startsWith("deleted file") || line.startsWith("similarity index") ||
            line.startsWith("rename ") -> DiffLineKind.META

        line.startsWith("@@") -> DiffLineKind.HUNK
        line.startsWith("+") -> DiffLineKind.ADDED
        line.startsWith("-") -> DiffLineKind.REMOVED
        else -> DiffLineKind.CONTEXT
    }
}
