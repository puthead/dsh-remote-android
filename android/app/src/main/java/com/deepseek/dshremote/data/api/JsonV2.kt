package com.deepseek.dshremote.data.api

import com.deepseek.dshremote.data.ApiException
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * 契约 v2 §4 的 JSON 编解码（纯函数，可单测）。
 *
 * 宽容策略与 v1 一致：
 * - 缺失的可选字段按契约默认值处理；
 * - 单条消息解析失败就跳过该条，而不是让整页白屏（网关版本可能更新出新形状）；
 * - 中文/emoji 原样保留（org.json 不做转义，`optString` 直接给出 UTF-8 文本）。
 */
object JsonV2 {

    // ---------- 会话 ----------

    fun parseSessions(json: String): List<SessionSummary> {
        val obj = runCatching { JSONObject(json) }.getOrNull() ?: return emptyList()
        val array = obj.optJSONArray("sessions") ?: return emptyList()
        val result = ArrayList<SessionSummary>(array.length())
        for (i in 0 until array.length()) {
            array.optJSONObject(i)?.let { result += parseSession(it) }
        }
        return result
    }

    fun parseSession(obj: JSONObject): SessionSummary = SessionSummary(
        id = obj.optString("id", ""),
        // 注意：JSON 里的 null 会被 optString 变成字符串 "null"（真机联调实测到「标题显示 null」），
        // 因此标题单独走 optTextOrEmpty
        title = obj.optTextOrEmpty("title"),
        workspace = obj.optString("workspace", ""),
        cwd = obj.optString("cwd", obj.optString("workspace", "")),
        createdAt = obj.optLong("createdAt", 0L),
        updatedAt = obj.optLong("updatedAt", 0L),
        turns = obj.optInt("turns", 0),
        steps = obj.optInt("steps", 0),
        live = obj.optBoolean("live", false),
        // 会话种类：**缺字段必须是 null，不能回退成 "user"**。真实桌面端写顶层会话 header 时
        // 就不写 origin，只有子代理才写 `"subagent"`；旧代码 `optString("origin", "user")`
        // 把"没告诉我"当成"它是用户会话"，于是子智能体会话在手机上刷屏。
        // 缺字段时由 SessionSummary.isSubagent 用 delegationDepth / parentSession 推断。
        origin = obj.optStringOrNull("origin"),
        // 派生关系的两个证据（契约 §4.2）：父会话 id 与委派深度。
        // 深度缺失按 0 处理是安全的——旧网关不给时，origin 仍由服务端补过（同源判据）。
        parentSession = obj.optStringOrNull("parentSession"),
        delegationDepth = obj.optInt("delegationDepth", 0).coerceAtLeast(0),
        agentPreset = obj.optString("agentPreset", ""),
        bytes = obj.optLong("bytes", 0L),
        eventCount = obj.optInt("eventCount", 0),
        hasChanges = obj.optBoolean("hasChanges", false),
        changeCount = obj.optInt("changeCount", 0),
        lastTurnState = obj.optJSONObject("lastTurn")?.optStringOrNull("state"),
        lastTurnReason = obj.optJSONObject("lastTurn")?.optStringOrNull("reason"),
        source = parseSource(obj),
        writableFlag = if (obj.has("writable")) obj.optBoolean("writable", false) else null,
        // 不可写的原因（`desktop_disabled` = 网关没接入电脑端 / `subagent` = 子代理会话不单独接 /
        // `runtime_gone` = 手机会话的 SDK 运行时已没）。只用于把"为什么发不了"说准，
        // **不参与可写性判定**（判定仍然只看 `writable`）。
        writableReasonFlag = obj.optStringOrNull("writableReason"),
        // 驱动方（契约新增）：电脑端 runtime 驱动时服务端下发 `"desktop"`，网关自有会话下发
        // `"gateway"`。老网关不发该字段 → 由 SessionSummary.driver 按 source 推导。
        driverFlag = obj.optStringOrNull("driver"),
        // 谁发起的（契约新增）：`"phone"` | `"desktop"`。与 source/driver 是三个独立维度：
        // 手机发起但落在电脑端执行的会话是 createdBy=phone + source=computer + driver=desktop。
        // 老网关（2.0.0）不发该字段 → 由 SessionSummary.createdBy 按 source 回退成旧行为。
        createdByFlag = obj.optStringOrNull("createdBy"),
    )

    /**
     * 会话来源（契约 §7.3 两类会话分离）。
     *
     * 服务端会显式返回 `source`；这里保留对常见别名与缺省值的兼容探测，
     * **未知取值一律当"电脑镜像"**（只读）——宁可少给写权限，也不可能误给。
     */
    fun parseSource(obj: JSONObject): String {
        val explicit = sequenceOf("source", "kind", "driver", "owner")
            .mapNotNull { key -> obj.optStringOrNull(key) }
            .map { it.lowercase() }
            .firstOrNull()
        return when (explicit) {
            "phone", "gateway", "self", "task", "phone_task" -> SessionSummary.SOURCE_PHONE
            "computer", "mirror", "desktop", "user", "host" -> SessionSummary.SOURCE_COMPUTER
            else -> when {
                obj.optBoolean("phoneTask", false) -> SessionSummary.SOURCE_PHONE
                obj.optStringOrNull("origin") == "phone" -> SessionSummary.SOURCE_PHONE
                else -> SessionSummary.SOURCE_COMPUTER
            }
        }
    }

    // ---------- 对话记录 ----------

    fun parseMessages(json: String): List<ChatMessage> {
        val obj = runCatching { JSONObject(json) }.getOrNull() ?: return emptyList()
        val array = obj.optJSONArray("messages") ?: return emptyList()
        val result = ArrayList<ChatMessage>(array.length())
        for (i in 0 until array.length()) {
            array.optJSONObject(i)?.let { result += parseMessage(it) }
        }
        return result.sortedBy { it.seq }
    }

    /**
     * transcript 的一页：消息 + 分页元信息（契约 §4.2 的 `nextCursor/total/from/to`）。
     *
     * 与 [parseMessages] 并存的原因：老网关只回 `messages`，此时后者仍然够用；
     * 而"加载更早"必须拿到 `nextCursor`，缺了它就只能退化成一次全量。
     * JSON 解析失败一律返回空页 + `initialized` 交给调用方判定（不抛异常打断界面）。
     *
     * **`cursorProvided` 是本函数存在的另一半理由**：只有这里能看到"字段缺失"这个原始事实。
     * 显式 `"nextCursor": null`（服务端说已到最早）与整个字段不在（老网关不表态）经
     * `optString` 读出来都是空串，必须用 `has("nextCursor")` 区分，否则一次老网关响应
     * 就会把"没有分页信息"当成"已经到最早"，向上翻页永久失效。
     */
    fun parseTranscriptPage(json: String): TranscriptPage {
        val obj = runCatching { JSONObject(json) }.getOrNull() ?: return TranscriptPage(cursorProvided = false)
        val array = obj.optJSONArray("messages") ?: return TranscriptPage(cursorProvided = false)
        val result = ArrayList<ChatMessage>(array.length())
        for (i in 0 until array.length()) {
            array.optJSONObject(i)?.let { result += parseMessage(it) }
        }
        val from = obj.optInt("from", 0)
        val to = obj.optInt("to", from + result.size)
        return TranscriptPage(
            messages = result.sortedBy { it.seq },
            nextCursor = obj.optStringOrNull("nextCursor"),
            total = obj.optInt("total", result.size),
            from = from,
            to = to,
            cursorProvided = obj.has("nextCursor"),
        )
    }

    fun parseMessage(obj: JSONObject): ChatMessage {
        val toolArray = obj.optJSONArray("toolCalls")
        val toolCalls = ArrayList<ToolCall>(toolArray?.length() ?: 0)
        if (toolArray != null) {
            for (i in 0 until toolArray.length()) {
                toolArray.optJSONObject(i)?.let { toolCalls += parseToolCall(it) }
            }
        }
        val deliverableArray = obj.optJSONArray("deliverables")
        val deliverables = ArrayList<Deliverable>(deliverableArray?.length() ?: 0)
        if (deliverableArray != null) {
            for (i in 0 until deliverableArray.length()) {
                val item = deliverableArray.opt(i)
                when (item) {
                    is JSONObject -> deliverables += parseDeliverable(item)
                    is String -> if (item.isNotEmpty()) deliverables += Deliverable(item, "")
                }
            }
        }
        return ChatMessage(
            seq = obj.optLong("seq", 0L),
            role = obj.optString("role", "assistant"),
            at = obj.optLong("at", 0L),
            text = obj.optString("text", ""),
            toolCalls = toolCalls,
            deliverables = deliverables,
            todos = parseTodos(obj.optJSONArray("todos")),
            truncated = obj.optBoolean("truncated", false),
            images = parseImages(obj.optJSONArray("images")),
            turn = obj.optIntOrNull("turn"),
        )
    }

    /**
     * 消息里的图片引用数组（契约 §4.2 `images[]`，v2.9.0）。
     *
     * 只认 `attachmentId`/`id` 这一个必填字段：老网关没有这个数组 ⇒ 返回空列表，
     * 界面照旧显示 `[图片]` 占位，不会因为缺字段而崩。
     */
    fun parseImages(array: JSONArray?): List<ImageRef> {
        if (array == null || array.length() == 0) return emptyList()
        val result = ArrayList<ImageRef>(array.length())
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            val ref = parseImageRef(item)
            if (ref.id.isNotEmpty()) result += ref
        }
        return result
    }

    fun parseImageRef(obj: JSONObject): ImageRef = ImageRef(
        // 网关投影用 `id`；原始事件里嵌套的 `attachment.attachmentId` 也认（同一个东西的两种写法）
        id = obj.optString("id", "").ifEmpty { obj.optString("attachmentId", "") },
        mediaType = obj.optStringOrNull("mediaType"),
        width = obj.optIntOrNull("width"),
        height = obj.optIntOrNull("height"),
        bytes = obj.optIntOrNull("bytes"),
        name = obj.optStringOrNull("name"),
    )

    /**
     * 轮次索引（契约 §4.2 `GET /api/v2/sessions/{id}/turn-index`，v2.9.0）。
     *
     * 解析失败/字段缺失一律返回空索引：界面据此显示"这次取不到轮次列表"，
     * 而不是把"没有索引"误判成"这个会话只有一轮"。
     */
    fun parseTurnIndex(json: String): TurnIndex {
        val obj = runCatching { JSONObject(json) }.getOrNull() ?: return TurnIndex()
        val array = obj.optJSONArray("turns") ?: return TurnIndex()
        val turns = ArrayList<TurnIndexEntry>(array.length())
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            val turn = item.optInt("turn", 0)
            if (turn <= 0) continue
            turns += TurnIndexEntry(
                turn = turn,
                fromIndex = item.optInt("fromIndex", 0),
                toIndex = item.optInt("toIndex", 0),
                at = item.optLong("at", 0L),
                userText = item.optString("userText", ""),
                assistantText = item.optString("assistantText", ""),
                steps = item.optInt("steps", 0),
                toolCalls = item.optInt("toolCalls", 0),
            )
        }
        return TurnIndex(
            sessionId = obj.optString("sessionId", ""),
            total = obj.optInt("total", turns.size),
            totalMessages = obj.optInt("totalMessages", 0),
            turns = turns.sortedBy { it.turn },
        )
    }

    /** 系统消息里的待办数组（`{content|text|title, status|state}`）。 */
    fun parseTodos(array: JSONArray?): List<TodoItem> {
        if (array == null) return emptyList()
        val result = ArrayList<TodoItem>(array.length())
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            val text = item.optString("content", "")
                .ifEmpty { item.optString("text", "") }
                .ifEmpty { item.optString("title", "") }
            if (text.isEmpty()) continue
            result += TodoItem(
                text = text,
                status = item.optString("status", item.optString("state", "pending")),
            )
        }
        return result
    }

    fun parseToolCall(obj: JSONObject): ToolCall {
        val args = obj.opt("args")
        val argsJson = when (args) {
            null, JSONObject.NULL -> "{}"
            is JSONObject -> args.toString()
            is String -> args
            else -> args.toString()
        }
        return ToolCall(
            id = obj.optString("id", ""),
            name = obj.optString("name", "tool"),
            argsJson = argsJson,
            result = obj.optString("result", ""),
            isError = obj.optBoolean("isError", false),
            truncated = obj.optBoolean("truncated", false),
            durationMs = obj.optLong("durationMs", 0L),
            images = parseImages(obj.optJSONArray("images")),
        )
    }

    fun parseDeliverable(obj: JSONObject): Deliverable = Deliverable(
        path = obj.optString("path", ""),
        description = obj.optString("description", ""),
    )

    // ---------- 工作区 ----------

    fun parseWorkspaces(json: String): List<WorkspaceSummary> {
        val obj = runCatching { JSONObject(json) }.getOrNull() ?: return emptyList()
        val array = obj.optJSONArray("workspaces") ?: return emptyList()
        val result = ArrayList<WorkspaceSummary>(array.length())
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            val git = item.optJSONObject("git")
            result += WorkspaceSummary(
                path = item.optString("path", ""),
                label = item.optString("label", WorkspaceLabels.label(item.optString("path", ""))),
                exists = item.optBoolean("exists", true),
                vcs = item.optString("vcs", git?.optString("vcs", "none") ?: "none"),
                branch = item.optStringOrNull("branch") ?: git?.optStringOrNull("branch"),
                changed = item.optInt("changed", git?.optInt("changed", 0) ?: 0),
                insertions = item.optInt("insertions", git?.optInt("insertions", 0) ?: 0),
                deletions = item.optInt("deletions", git?.optInt("deletions", 0) ?: 0),
            )
        }
        return result
    }

    fun parseEntries(json: String): DirListing {
        val obj = runCatching { JSONObject(json) }.getOrNull() ?: return DirListing("", "", emptyList(), false)
        val array = obj.optJSONArray("entries") ?: JSONArray()
        val entries = ArrayList<WorkspaceEntry>(array.length())
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            entries += WorkspaceEntry(
                name = item.optString("name", ""),
                path = item.optString("path", ""),
                type = item.optString("type", "file"),
                size = item.optLongOrNull("size"),
                modifiedAt = item.optLongOrNull("modifiedAt"),
            )
        }
        return DirListing(
            workspace = obj.optString("workspace", ""),
            path = obj.optString("path", ""),
            entries = entries.sortedWith(
                compareByDescending<WorkspaceEntry> { it.isDir }.thenBy { it.name.lowercase() },
            ),
            truncated = obj.optBoolean("truncated", false),
        )
    }

    fun parseFile(json: String): FileContent {
        val obj = runCatching { JSONObject(json) }.getOrDefault(JSONObject())
        val path = obj.optString("path", "")
        return FileContent(
            path = path,
            name = obj.optString("name", WorkspaceLabels.label(path)),
            size = obj.optLong("size", 0L),
            modifiedAt = obj.optLongOrNull("modifiedAt"),
            binary = obj.optBoolean("binary", false),
            truncated = obj.optBoolean("truncated", false),
            text = obj.optString("text", obj.optString("content", "")),
        )
    }

    fun parseChanges(json: String): ChangeSet {
        val obj = runCatching { JSONObject(json) }.getOrDefault(JSONObject())
        val array = obj.optJSONArray("changed") ?: JSONArray()
        val changed = ArrayList<ChangeEntry>(array.length())
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            changed += ChangeEntry(
                path = item.optString("path", ""),
                status = item.optString("status", "M"),
                staged = item.optBoolean("staged", false),
                insertions = item.optInt("insertions", 0),
                deletions = item.optInt("deletions", 0),
                isBinary = item.optBoolean("isBinary", false),
            )
        }
        val untrackedArray = obj.optJSONArray("untracked")
        val untracked = ArrayList<String>(untrackedArray?.length() ?: 0)
        if (untrackedArray != null) {
            for (i in 0 until untrackedArray.length()) {
                untrackedArray.optString(i, "").takeIf { it.isNotEmpty() }?.let { untracked += it }
            }
        }
        val vcs = obj.optString("vcs", "none")
        return ChangeSet(
            workspace = obj.optString("workspace", ""),
            vcs = vcs,
            branch = obj.optStringOrNull("branch"),
            changed = changed,
            untracked = untracked,
            clean = obj.optBoolean("clean", changed.isEmpty() && untracked.isEmpty()),
        )
    }

    fun parseDiff(json: String): DiffResult {
        val obj = runCatching { JSONObject(json) }.getOrDefault(JSONObject())
        return DiffResult(
            workspace = obj.optString("workspace", ""),
            path = obj.optString("path", ""),
            file = obj.optString("file", ""),
            vcs = obj.optString("vcs", "none"),
            unified = obj.optString("unified", obj.optString("diff", "")),
            truncated = obj.optBoolean("truncated", false),
        )
    }

    fun parseSearch(json: String): List<SearchHit> {
        val obj = runCatching { JSONObject(json) }.getOrNull() ?: return emptyList()
        val array = obj.optJSONArray("hits") ?: obj.optJSONArray("results") ?: return emptyList()
        val result = ArrayList<SearchHit>(array.length())
        for (i in 0 until array.length()) {
            val item = array.opt(i)
            when (item) {
                is JSONObject -> result += SearchHit(
                    path = item.optString("path", ""),
                    name = item.optString("name", WorkspaceLabels.label(item.optString("path", ""))),
                    line = item.optIntOrNull("line"),
                    text = item.optString("text", item.optString("preview", "")),
                    kind = item.optString("kind", "content"),
                )

                is String -> result += SearchHit(path = item, name = WorkspaceLabels.label(item), line = null, text = "", kind = "file")
            }
        }
        return result
    }

    fun parseTurnAccepted(json: String): TurnAccepted {
        val obj = runCatching { JSONObject(json) }.getOrDefault(JSONObject())
        return TurnAccepted(
            accepted = obj.optBoolean("accepted", false),
            sessionId = obj.optString("sessionId", ""),
            turnId = obj.optString("turnId", ""),
            fromSeq = obj.optLong("fromSeq", -1L),
            resumable = if (obj.has("resumable")) obj.optBoolean("resumable", true) else null,
        )
    }

    /**
     * 新建任务的响应（契约裁定：`POST /api/v2/tasks` → 202
     * `{sessionId, accepted, source:"phone", fromSeq}`）。
     *
     * 同时兼容 `{id:…}`（返回完整会话对象）与 `{task:{…}}` 包裹，避免服务端形状微调即失效。
     */
    fun parseCreateTask(json: String): CreateTaskOutcome {
        val obj = runCatching { JSONObject(json) }.getOrDefault(JSONObject())
        val nested = obj.optJSONObject("task") ?: obj.optJSONObject("session")
        val sessionId = sequenceOf(
            obj.optString("sessionId", ""),
            obj.optString("id", ""),
            nested?.optString("sessionId", "").orEmpty(),
            nested?.optString("id", "").orEmpty(),
        ).firstOrNull { it.isNotEmpty() }.orEmpty()
        return CreateTaskOutcome(
            sessionId = sessionId,
            turnId = obj.optString("turnId", "").ifEmpty { nested?.optString("turnId", "").orEmpty() },
            accepted = if (obj.has("accepted")) obj.optBoolean("accepted", true) else sessionId.isNotEmpty(),
            source = parseSource(obj),
            fromSeq = obj.optLong("fromSeq", -1L),
            // 契约 §4.2：网关回执实际生效的权限档；旧网关没有该字段 → null（UI 会提示按默认档执行）
            access = parseAccess(obj, nested),
            // 契约 §4.2：这次任务实际落在哪执行（desktop = 电脑端 DSH）。旧网关不回 → null，
            // UI 按 source 推导，且不回执 access 时不说成"已按某档执行"。
            host = sequenceOf(
                obj.optString("host", ""),
                nested?.optString("host", "").orEmpty(),
            ).firstOrNull { it.isNotEmpty() },
            createdBy = sequenceOf(
                obj.optString("createdBy", ""),
                nested?.optString("createdBy", "").orEmpty(),
            ).firstOrNull { it.isNotEmpty() },
            // 模型是否真的生效：布尔与原因**两个字段合起来判**——只回了原因没回布尔时，
            // 原因本身就说明没生效（旧网关两种都不回 → null，界面不许当成成功）。
            modelApplied = when {
                obj.has("modelApplied") -> obj.optBoolean("modelApplied", false)
                nested?.has("modelApplied") == true -> nested.optBoolean("modelApplied", false)
                obj.optStringOrNull("modelWarning") != null -> false
                nested?.optStringOrNull("modelWarning") != null -> false
                else -> null
            },
            modelWarning = sequenceOf(
                obj.optStringOrNull("modelWarning"),
                nested?.optStringOrNull("modelWarning"),
            ).firstOrNull { !it.isNullOrEmpty() },
        )
    }

    // ---------- 模型目录 ----------

    /**
     * `GET /api/v2/models`。
     *
     * 宽容策略与其它解析一致：整个 body 坏了 → [ModelCatalog.UNKNOWN]（界面不画选择器，
     * 也就不会让用户对着一个假的"默认模型"发呆）；单个 group/model 坏了只跳过它自己。
     */
    fun parseModelCatalog(json: String): ModelCatalog {
        val obj = runCatching { JSONObject(json) }.getOrNull() ?: return ModelCatalog.UNKNOWN
        val groups = ArrayList<ModelGroup>()
        val rawGroups = obj.optJSONArray("groups")
        for (i in 0 until (rawGroups?.length() ?: 0)) {
            val group = rawGroups?.optJSONObject(i) ?: continue
            val id = group.optTextOrEmpty("id")
            if (id.isEmpty()) continue
            val entries = ArrayList<ModelEntry>()
            val rawModels = group.optJSONArray("models")
            for (j in 0 until (rawModels?.length() ?: 0)) {
                val entry = rawModels?.optJSONObject(j) ?: continue
                val modelId = entry.optTextOrEmpty("id")
                if (modelId.isEmpty()) continue
                entries += ModelEntry(
                    id = modelId,
                    // 名字缺失时回落成 id：选择器上不能出现一行空白
                    name = entry.optTextOrEmpty("name").ifEmpty { modelId },
                    description = entry.optStringOrNull("description"),
                )
            }
            groups += ModelGroup(id = id, name = group.optTextOrEmpty("name").ifEmpty { id }, models = entries)
        }
        val failures = ArrayList<ModelFailure>()
        val rawFailures = obj.optJSONArray("failures")
        for (i in 0 until (rawFailures?.length() ?: 0)) {
            val item = rawFailures?.optJSONObject(i) ?: continue
            val id = item.optTextOrEmpty("id")
            if (id.isEmpty()) continue
            failures += ModelFailure(
                id = id,
                name = item.optTextOrEmpty("name").ifEmpty { id },
                message = item.optTextOrEmpty("message"),
            )
        }
        return ModelCatalog(
            defaultSelection = parseModelSelection(obj.optJSONObject("default")),
            groups = groups,
            failures = failures,
            source = obj.optTextOrEmpty("source"),
        )
    }

    /** `{provider, model, reasoningEffort?}`；缺 provider 或 model 时整条丢掉（只有一半没用）。 */
    private fun parseModelSelection(obj: JSONObject?): ModelSelection? {
        if (obj == null) return null
        val provider = obj.optTextOrEmpty("provider")
        val model = obj.optTextOrEmpty("model")
        if (provider.isEmpty() || model.isEmpty()) return null
        return ModelSelection(
            provider = provider,
            model = model,
            reasoningEffort = obj.optStringOrNull("reasoningEffort"),
        )
    }

    /** 权限档回执：兼容平铺与 `{task:{…}}` 包裹；空串视为"网关没回执"。 */
    private fun parseAccess(obj: JSONObject, nested: JSONObject?): String? = sequenceOf(
        obj.optString("access", ""),
        nested?.optString("access", "").orEmpty(),
    ).firstOrNull { it.isNotEmpty() }

    fun parseDevices(json: String): List<DeviceInfo> {
        val obj = runCatching { JSONObject(json) }.getOrNull() ?: return emptyList()
        val array = obj.optJSONArray("devices") ?: return emptyList()
        val result = ArrayList<DeviceInfo>(array.length())
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            result += DeviceInfo(
                tokenId = item.optString("tokenId", ""),
                deviceName = item.optString("deviceName", ""),
                pairedAt = item.optLongOrNull("pairedAt"),
                lastSeenAt = item.optLongOrNull("lastSeenAt"),
                revoked = item.optBoolean("revoked", false),
            )
        }
        return result
    }

    // ---------- 中继 HTTP ----------

    fun parseRelayHealth(json: String): RelayHealth {
        val obj = runCatching { JSONObject(json) }.getOrDefault(JSONObject())
        return RelayHealth(
            ok = obj.optBoolean("ok", false),
            relayVersion = obj.optString("relayVersion", ""),
            apiVersion = obj.optInt("apiVersion", 0),
            uptimeMs = obj.optLong("uptimeMs", 0L),
            homes = obj.optInt("homes", 0),
            devices = obj.optInt("devices", 0),
            relayName = obj.optString("relayName", ""),
        )
    }

    /** 网关 health（契约 §4.5：`apiVersion` 恒为 1，v2 能力看 `supportedApiVersions`）。 */
    fun parseGatewayHealth(json: String): GatewayHealth {
        val obj = runCatching { JSONObject(json) }.getOrDefault(JSONObject())
        val versions = obj.optJSONArray("supportedApiVersions")
        val supported = ArrayList<Int>(versions?.length() ?: 0)
        if (versions != null) {
            for (i in 0 until versions.length()) supported += versions.optInt(i, 0)
        }
        val relay = obj.optJSONObject("relay")
        return GatewayHealth(
            ok = obj.optBoolean("ok", false),
            apiVersion = obj.optInt("apiVersion", 0),
            supportedApiVersions = supported,
            serverName = obj.optString("serverName", ""),
            gatewayVersion = obj.optString("gatewayVersion", ""),
            dshVersion = obj.optString("dshVersion", ""),
            relayEnabled = relay?.optBoolean("enabled", false) ?: false,
            relayConnected = relay?.optBoolean("connected", false) ?: false,
        )
    }

    fun parsePairClaim(json: String): PairClaimV2 {
        val obj = runCatching { JSONObject(json) }.getOrDefault(JSONObject())
        val relay = obj.optJSONObject("relay")
        return PairClaimV2(
            token = obj.optString("token", ""),
            tokenId = obj.optString("tokenId", ""),
            serverName = obj.optString("serverName", ""),
            expiresAt = obj.optLongOrNull("expiresAt"),
            homeId = relay?.optString("homeId", "").orEmpty(),
            deviceToken = relay?.optString("deviceToken", "").orEmpty(),
            tunnelUrl = relay?.optString("tunnelUrl", "").orEmpty(),
            hasRelayBlock = relay != null,
        )
    }

    /** 契约 §4.4 错误体；解析失败时按 HTTP 状态退化，绝不返回空 code。 */
    fun parseError(body: String?, httpStatus: Int, fallbackMessage: String): ApiException {
        val obj = runCatching { JSONObject(body ?: "") }.getOrNull()
        val error = obj?.optJSONObject("error")
        val code = error?.optString("code", "")?.takeIf { it.isNotEmpty() } ?: defaultCode(httpStatus)
        val message = error?.optString("message", "")?.takeIf { it.isNotEmpty() } ?: fallbackMessage
        return ApiException(code = code, message = message, httpStatus = httpStatus)
    }

    fun defaultCode(httpStatus: Int): String = when (httpStatus) {
        401 -> "unauthorized"
        403 -> "forbidden"
        404 -> "not_found"
        409 -> "conflict"
        429 -> "rate_limited"
        503 -> "home_offline"
        else -> if (httpStatus >= 500) "internal" else "bad_request"
    }

    // ---------- 离线缓存序列化 ----------

    fun sessionsToJson(sessions: List<SessionSummary>): String {
        val array = JSONArray()
        sessions.forEach { session ->
            array.put(JSONObject().apply {
                put("id", session.id)
                put("title", session.title)
                put("workspace", session.workspace)
                put("cwd", session.cwd)
                put("createdAt", session.createdAt)
                put("updatedAt", session.updatedAt)
                put("turns", session.turns)
                put("steps", session.steps)
                // 缓存里的 live 无意义（PC 状态会变），落盘时一律置 false，避免离线看到假的呼吸点
                put("live", false)
                // 会话种类与派生关系必须一起缓存：丢了 origin/parentSession/delegationDepth，
                // 离线回放时子智能体会话会重新变回"顶层会话"混进列表。**只在真的有值时才写**，
                // 这样"顶层会话本来就没 origin"这一事实会被如实保留（而不是被补成 "user"）。
                session.origin?.let { put("origin", it) }
                session.parentSession?.let { put("parentSession", it) }
                if (session.delegationDepth > 0) put("delegationDepth", session.delegationDepth)
                put("agentPreset", session.agentPreset)
                put("bytes", session.bytes)
                put("eventCount", session.eventCount)
                put("hasChanges", session.hasChanges)
                put("changeCount", session.changeCount)
                // 来源与可写性必须一起缓存：否则离线打开"手机任务"会因缺字段变成只读
                put("source", session.source)
                put("writable", session.writable)
                // 驱动方与不可写原因也要一起缓存：驱动方丢了，"电脑端可续聊"的会话在离线回放时
                // 会退化成只读镜像；原因丢了，横幅只能给一句含糊的"不可写"。
                // 只在服务端真的给过时才写（保持对旧缓存的兼容，不凭空造字段）。
                session.driverFlag?.let { put("driver", it) }
                session.writableReasonFlag?.let { put("writableReason", it) }
                // 谁发起的也要一起缓存：丢了它，"手机发起 · 电脑执行"的会话离线回放时会
                // 从「手机任务」页消失（isPhoneTask 会回退成 desktop）。同样只在服务端给过时才写。
                session.createdByFlag?.let { put("createdBy", it) }
                put("lastTurn", JSONObject().apply {
                    put("state", session.lastTurnState ?: JSONObject.NULL)
                    put("reason", session.lastTurnReason ?: JSONObject.NULL)
                })
            })
        }
        return JSONObject().put("sessions", array).toString()
    }

    fun sessionsFromJson(text: String): List<SessionSummary> = try {
        parseSessions(text)
    } catch (e: JSONException) {
        emptyList()
    }

    fun messagesToJson(messages: List<ChatMessage>): String {
        val array = JSONArray()
        messages.forEach { message ->
            array.put(JSONObject().apply {
                put("seq", message.seq)
                put("role", message.role)
                put("at", message.at)
                put("text", message.text)
                put("truncated", message.truncated)
                // 轮次号与图片引用必须一起落盘：漏掉它们时，离线重开一个会话会看到
                // "图片气泡只剩空气壳、轮次导航没有锚点"——而在线时一切正常，
                // 这种"只有离线才复现"的缺陷最难被用户描述清楚（v2.9.0 真机取证时踩到）。
                put("turn", message.turn ?: JSONObject.NULL)
                put("images", imagesToJson(message.images))
                put("toolCalls", JSONArray().apply {
                    message.toolCalls.forEach { call ->
                        put(JSONObject().apply {
                            put("id", call.id)
                            put("name", call.name)
                            put("args", runCatching { JSONObject(call.argsJson) }.getOrElse { JSONObject() })
                            put("result", call.result)
                            put("isError", call.isError)
                            put("truncated", call.truncated)
                            put("durationMs", call.durationMs)
                            put("images", imagesToJson(call.images))
                        })
                    }
                })
                put("deliverables", JSONArray().apply {
                    message.deliverables.forEach { item ->
                        put(JSONObject().apply {
                            put("path", item.path)
                            put("description", item.description)
                        })
                    }
                })
            })
        }
        return JSONObject().put("messages", array).toString()
    }

    /**
     * 图片引用写回缓存（[parseImages] 的逆操作）。
     *
     * 可空字段只在真有值时写：少写几个键比写一堆 `null` 更省缓存体积，
     * 也顺手保持了与网关投影（"没有的字段就不出现"）一致的形状。
     */
    private fun imagesToJson(images: List<ImageRef>): JSONArray = JSONArray().apply {
        images.forEach { ref ->
            put(JSONObject().apply {
                put("id", ref.id)
                ref.mediaType?.let { put("mediaType", it) }
                ref.width?.let { put("width", it) }
                ref.height?.let { put("height", it) }
                ref.bytes?.let { put("bytes", it) }
                ref.name?.let { put("name", it) }
            })
        }
    }

    fun messagesFromJson(text: String): List<ChatMessage> = try {
        parseMessages(text)
    } catch (e: JSONException) {
        emptyList()
    }

    // ---------- 小工具 ----------

    private fun JSONObject.optStringOrNull(key: String): String? =
        if (!has(key) || isNull(key)) null else optString(key, "").takeIf { it.isNotEmpty() }

    /** JSON null / 缺失 / 字面量 "null" 都当作空串（`optString` 会把 null 变成 "null"）。 */
    private fun JSONObject.optTextOrEmpty(key: String): String {
        if (!has(key) || isNull(key)) return ""
        return optString(key, "").takeIf { it != "null" }.orEmpty()
    }

    private fun JSONObject.optLongOrNull(key: String): Long? =
        if (!has(key) || isNull(key)) null else optLong(key)

    private fun JSONObject.optIntOrNull(key: String): Int? =
        if (!has(key) || isNull(key)) null else optInt(key)
}
