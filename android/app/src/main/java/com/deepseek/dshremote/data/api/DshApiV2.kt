package com.deepseek.dshremote.data.api

import com.deepseek.dshremote.data.ApiException
import com.deepseek.dshremote.data.Logger
import com.deepseek.dshremote.data.relay.RelayException
import com.deepseek.dshremote.data.relay.TunnelEvent
import com.deepseek.dshremote.data.relay.TunnelHttp
import java.net.URLEncoder
import java.util.Base64
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.transform

/**
 * 契约 v2 §4 的 API 客户端。
 *
 * **所有** 请求都经 [TunnelHttp]（= 中继隧道），本类里没有任何 PC 地址的概念，
 * 从类型上保证"手机不直连 PC"。
 *
 * 错误统一抛 [ApiException]（契约 §4.4 错误体），由 UI 层的 `friendlyMessage()` 翻译成中文。
 */
class DshApiV2(
    private val tunnel: TunnelHttp,
    private val requestTimeoutMs: Long = 60_000L,
    private val attachmentTimeoutMs: Long = ATTACHMENT_TIMEOUT_MS,
) {

    // ---------- 会话镜像 ----------

    suspend fun sessions(
        workspace: String? = null,
        limit: Int = 50,
        includeSubagent: Boolean = false,
        source: String? = null,
    ): List<SessionSummary> = JsonV2.parseSessions(
        get(
            path = "/api/v2/sessions" + query(
                "workspace" to workspace,
                "limit" to limit.toString(),
                "include" to if (includeSubagent) "subagent" else null,
                // 服务端可忽略：客户端仍会按 source 再过滤一次（见 SessionSummary.source）
                "source" to source,
            ),
        ),
    )

    /**
     * 新建手机任务（契约裁定：`POST /api/v2/tasks` 是唯一新建入口）。
     *
     * 请求 `{prompt, workspace, model?, provider?, reasoningEffort?, access?, host?}` →
     * 202 `{sessionId, accepted, source, fromSeq, modelApplied?, modelWarning?}`；
     * 之后用 [postTurn] 续聊同一会话。
     *
     * `modelApplied=false` 表示"手机选了模型但没切上"（网关仍把任务跑起来了）——
     * 这种情况**必须**把 `modelWarning` 显示给用户（见 [CreateTaskOutcome]）。
     */
    suspend fun createPhoneTask(payloadJson: String): CreateTaskOutcome {
        val response = tunnel.postJson("/api/v2/tasks", payloadJson, timeoutMs = requestTimeoutMs)
        if (!response.isSuccessful) {
            throw JsonV2.parseError(
                body = response.bodyText(),
                httpStatus = response.status,
                fallbackMessage = "新建任务失败 HTTP ${response.status}",
            )
        }
        return JsonV2.parseCreateTask(response.bodyText())
    }

    suspend fun transcript(
        sessionId: String,
        tail: Int? = null,
        limit: Int? = null,
        cursor: String? = null,
    ): List<ChatMessage> = transcriptPage(sessionId, limit = limit ?: tail, cursor = cursor).messages

    /**
     * transcript 的一页（契约 §4.2，m00002 手机端分页的取数口）。
     *
     * 语义完全按服务端裁定（`session-reader.mjs:669-684`）：`cursor` 是**排他上界**，
     * 返回它之前最多 [limit] 条，响应里的 `nextCursor` 才是"更早"那一页要用的游标。
     * 因此：
     * - 首屏/追新：`cursor = null`（取最新一页）；
     * - 上拉加载更早：`cursor = 上一页的 nextCursor`；
     * - `nextCursor` 为 null = 已经到最早，界面不该再显示"加载更早"。
     *
     * `tail` 是给老网关/调试用的"取尾部 N 条"入口，等价于只带 limit 的首屏；两者都传时
     * 以 [limit] 为准，避免出现"服务端按 tail 截断、客户端按 limit 算游标"的错配。
     */
    suspend fun transcriptPage(
        sessionId: String,
        limit: Int? = null,
        cursor: String? = null,
    ): TranscriptPage = JsonV2.parseTranscriptPage(
        get(
            path = "/api/v2/sessions/${encodePath(sessionId)}/transcript" + query(
                "limit" to limit?.toString(),
                "cursor" to cursor,
            ),
        ),
    )

    /**
     * 续聊一轮（契约 §4.2 `POST /api/v2/sessions/{id}/turns`）。
     *
     * [images] 非空时请求体多一个 `content` 数组（冻结协议）：
     * `[{type:"text",text:prompt}, {type:"image",mediaType,data,name?}, …]`，
     * 顺序固定**先 text 再 image**（网关按同一份实现透传）。
     *
     * 三条不能动的约束：
     * 1. **无图时请求体与加图片功能之前逐字节一致**（没有 `content` 字段）——
     *    旧网关不认识 `content`，凭空多一个字段就是行为漂移；
     * 2. `data` 是**裸 base64**（标准字母表、无换行、无 `data:` 前缀）；
     * 3. base64 与图片字节**不进任何日志/异常消息**（一张 700 KiB 的图就是 900+ KiB 日志）。
     *
     * 编码器用 [java.util.Base64] 而不是 `android.util.Base64`（与
     * `data/relay/FrameCodec.kt` 同一取舍）：android.jar 在 JVM 单测里是空壳，
     * [android.util.Base64.NO_WRAP] 那套在单测中拿到的是默认返回值（null/空串），
     * 于是"上行 body 到底长什么样"这条最关键的判据在单测里**永远测不到真的**。
     * `java.util.Base64` 只做标准字母表 + 不换行，正是冻结协议要的形状，
     * 且不需要 `android.util.Base64.NO_WRAP` 这个标志（minSdk 26 起可用）。
     *
     * **发之前先验整包预算**（[bodyWithinLimit]）：上限是**整个 JSON 请求体** 1 MiB，
     * 不是单图 700 KiB —— 4 张 700 KiB 的图 base64 后是 3.7 MiB，必然被中间层掐断
     * （实测：body=1_048_500 B 通过，1_048_640 B 连接被直接关闭）。
     * 超预算时**不建连接**就失败：省掉一次注定 413 的往返，也让用户拿到"该改什么"的文案。
     */
    suspend fun postTurn(
        sessionId: String,
        prompt: String,
        clientTurnId: String,
        images: List<PendingImage> = emptyList(),
    ): TurnAccepted {
        // 先量再发：turnBodyJson 已经是纯函数，这里量的是它真正要发出去的**字节数**。
        // 量字节而不是量字符，是因为网关的 1 MiB 卡在网络层收到的字节上：
        // 中文一个字 3 字节，按 `String.length` 量会低估 —— 实测过的边界是
        // 1_048_500 B 通过 / 1_048_640 B 被关闭连接，量错了就正好会踩进这个窗口。
        // 先绑一次，量的是**这一条**、发的也是**这一条**。
        // 不要写成 `val bodyBytes = bodyBytes(turnBodyJson(...))`：局部变量会把同名函数
        // 遮住（Kotlin 解析局部变量优先，于是 `bodyBytes(...)` 变成"不能 invoke"），
        // 而更阴的后果是 body 字符串被顺手丢掉、下一行只剩一个不存在的名字 ——
        // 这正是本文件编不过一次的原因（`Unresolved reference 'body'`，lead 报的）。
        val body = turnBodyJson(prompt, clientTurnId, images)
        val bodyByteCount = utf8Length(body)
        if (!bodyWithinBudget(bodyByteCount, images.size)) {
            throw BudgetExceededException(imagesBudgetMessage(bodyByteCount, images.size))
        }
        return JsonV2.parseTurnAccepted(
            turnRequest("/api/v2/sessions/${encodePath(sessionId)}/turns", body),
        )
    }

    /**
     * 发一轮请求（含错误映射）。抽出来是为了让"413 → 图片太大"这条映射
     * 走与其它端点同一个 [read] 出口，而不是在 [postTurn] 里另造一套错误类型。
     *
     * [body] 由调用方传入（而不是在这里现算）：预算是按**最终字符串**判定的，
     * 量一次、发同一条，避免"量的是一个串、发的是另一个串"。
     */
    private suspend fun turnRequest(
        path: String,
        body: String,
    ): String = read(
        tunnel.postJson(path, body, timeoutMs = requestTimeoutMs),
        payloadTooLargeMessage = IMAGE_TOO_LARGE_MESSAGE,
    )

    suspend fun abortTurn(sessionId: String): TurnAccepted = JsonV2.parseTurnAccepted(
        post("/api/v2/sessions/${encodePath(sessionId)}/abort", null),
    )

    /**
     * SSE：全仓库会话状态 + 指定会话增量事件。
     *
     * 逐 chunk 增量解析（[SseV2Parser]），断线重连时用 [fromSeq]/[lastEventId] 续传，
     * 服务端回放 ≥ fromSeq 的事件，因此"网络抖一下"不会丢消息。
     *
     * @param onCursor 网关**总线游标**推进回调（来自 `id:` 行）。gateway-dev 明确：
     *   `id:` 是总线游标（`Last-Event-ID` 用它），`data.seq` 是 DSH 事件序号，
     *   两者不能混用 —— 因此续传游标必须从 `id:` 取，而不是从事件载荷的 `seq` 取。
     */
    fun sessionEvents(
        fromSeq: Long?,
        lastEventId: String?,
        onCursor: (Long) -> Unit = {},
    ): Flow<ConsoleEvent> {
        var status = 0
        val errorBody = BoundedText(MAX_ERROR_BODY_CHARS)
        val parser = SseV2Parser()
        // 跨 chunk 的有状态解码器：中继按固定 128 KiB 切片下发，切片边界不尊重 UTF-8 字符边界，
        // 逐 chunk `String(bytes, UTF_8)` 会把一个三字节中文/四字节 emoji 劈成两个 U+FFFD，
        // 而 JSON 依然解析成功 → 静默乱码。见 [StreamTextDecoder]。
        val decoder = StreamTextDecoder()
        return tunnel.stream(
            method = "GET",
            path = ConsoleStreams.path(fromSeq),
            // 流式请求必须自带 Accept：中继靠它判定 SSE（`relay-client.mjs` 的 isStream），
            // 判错就会给这个长连接装上 60s 空闲超时，静默超过 60s 就被 abort{timeout} 掐断。
            // ConsoleStreams.headers() 只带 Last-Event-ID（禁改文件），所以在这里补。
            headers = ConsoleStreams.headers(lastEventId) + ("Accept" to "text/event-stream"),
        ).transform { event ->
            when (event) {
                is TunnelEvent.Head -> status = event.status

                is TunnelEvent.Body -> {
                    val text = decoder.decode(event.bytes)
                    if (status in 200..299) {
                        for (parsed in parser.feed(text)) {
                            emit(parsed)
                            parser.lastEventId?.toLongOrNull()?.let(onCursor)
                        }
                    } else {
                        errorBody.append(text)
                    }
                }

                TunnelEvent.End -> {
                    if (status !in 200..299) {
                        throw JsonV2.parseError(
                            body = errorBody.toString(),
                            httpStatus = status,
                            fallbackMessage = "会话事件流失败 HTTP $status",
                        )
                    }
                }

                is TunnelEvent.Aborted -> throw RelayException(
                    event.reason.ifEmpty { "aborted" },
                    "会话事件流被终止：${event.reason}",
                )
            }
        }
    }

    // ---------- 工作区 ----------
    //
    // 为什么每个端点都要带 `?workspace=`（2026-10-15 修「越界」误拒）：
    // 网关在缺 `workspace` 时回落到 defaultWorkspace，随后拿「默认工作区的根」去装
    // 「另一个白名单工作区里的绝对路径」，词法包含必然失败 → 403 workspace_outside，
    // 实测文案 `路径越界（不在工作区内）：D:\Workspace\插件`——手机上选 D:\Workspace\插件
    // 时 100% 复现，用户看到的就是这个。
    // 客户端是唯一知道"这个路径属于哪个工作区"的一方（用户刚在界面上选过），
    // 所以第一道就在这里补上；网关侧另有 inferWorkspaceFromPath 兜底老客户端。

    // ---------- 模型 ----------

    /**
     * 手机端可选模型目录（`GET /api/v2/models`）。
     *
     * **旧网关没有这个端点** → 404：这里不抛错，回 [ModelCatalog.UNKNOWN]（`source` 为空），
     * 界面据此整块不画模型选择器。理由：新建任务的主流程不该因为一个"锦上添花"的端点
     * 让用户看到报错，而"画一个点不动的空菜单"比不画更糟。
     */
    suspend fun modelCatalog(): ModelCatalog = try {
        JsonV2.parseModelCatalog(get("/api/v2/models"))
    } catch (e: ApiException) {
        if (e.httpStatus == 404) ModelCatalog.UNKNOWN else throw e
    }

    suspend fun workspaces(): List<WorkspaceSummary> = JsonV2.parseWorkspaces(get("/api/v2/workspaces"))

    suspend fun entries(path: String?, depth: Int = 1, showHidden: Boolean = false, workspace: String? = null): DirListing =
        JsonV2.parseEntries(
            get(
                path = "/api/v2/workspaces/files" + query(
                    "workspace" to workspace,
                    "path" to path,
                    "depth" to depth.toString(),
                    "showHidden" to showHidden.toString(),
                ),
            ),
        )

    suspend fun file(path: String, workspace: String? = null): FileContent =
        JsonV2.parseFile(get("/api/v2/workspaces/file" + query("workspace" to workspace, "path" to path)))

    suspend fun changes(path: String, workspace: String? = null): ChangeSet =
        JsonV2.parseChanges(get("/api/v2/workspaces/changes" + query("workspace" to workspace, "path" to path)))

    suspend fun diff(path: String, file: String, workspace: String? = null): DiffResult =
        JsonV2.parseDiff(get("/api/v2/workspaces/diff" + query("workspace" to workspace, "path" to path, "file" to file)))

    suspend fun search(query: String, path: String?, limit: Int = 50, workspace: String? = null): List<SearchHit> =
        JsonV2.parseSearch(
            get("/api/v2/workspaces/search" + query("workspace" to workspace, "q" to query, "path" to path, "limit" to limit.toString())),
        )

    // ---------- 设备（令牌吊销） ----------

    /**
     * 网关健康 + 版本能力（经隧道调用）。
     *
     * 注意契约 §4.5：`apiVersion` 恒为 1，**不能**用它判断 v2 是否可用，
     * 必须看 `supportedApiVersions`。
     */
    suspend fun gatewayHealth(): GatewayHealth = JsonV2.parseGatewayHealth(
        get("/api/v1/health"),
    )

    suspend fun devices(): List<DeviceInfo> = JsonV2.parseDevices(get("/api/v1/devices"))

    /** 吊销本机令牌（v1 端点，语义不变；吊销后网关立刻 401）。 */
    suspend fun revokeDevice(tokenId: String) {
        val response = tunnel.execute(
            method = "DELETE",
            path = "/api/v1/devices/${encodePath(tokenId)}",
            timeoutMs = requestTimeoutMs,
        )
        if (!response.isSuccessful) {
            throw JsonV2.parseError(response.bodyText(), response.status, "吊销失败 HTTP ${response.status}")
        }
    }

    // ---------- 审批 / 提问（契约 §7.7）----------

    /**
     * 未决的审批与提问（`GET /api/v2/approvals`，可带 `?sessionId=` 过滤）。
     *
     * 为什么除了 SSE 还要这个端点：手机可能在提问**之后**才连上来（waterfall 没有重放保证），
     * REST 语义的列表端点是"打开 App 就知道有没有东西等我"的唯一可靠答案。
     *
     * 签名返回可空：整份响应不是 JSON 时返回 null（[JsonV2] 的同款宽容策略），调用方当作拉取失败。
     */
    suspend fun approvals(sessionId: String? = null): WireApprovals.ApprovalsResponse? =
        WireApprovals.parseApprovals(
            get("/api/v2/approvals" + query("sessionId" to sessionId)),
        )

    /**
     * 提交一个答案（`POST /api/v2/approvals/{eventId}`）。
     *
     * [bodyJson] 由 [WireApprovals] 的 `encodeApproval` / `encodeAnswers` / `encodeAbstain` 生成
     * —— 形状的坑都在那边集中处理，这里不做二次判断。
     *
     * 失败时抛 [ApiException]，错误码由网关给出：`not_found`（已被电脑端先答或不存在）、
     * `approval_expired`（超过网关 TTL）、`bad_request`（答案形状不合法）、
     * `desktop_unavailable` / `desktop_unreachable` / `desktop_error`（通道问题）。
     */
    suspend fun submitApproval(eventId: String, bodyJson: String): String =
        post("/api/v2/approvals/${encodePath(eventId)}", bodyJson)

    // ---------- 图片附件（契约 §4.2，v2.9.0） ----------

    /**
     * 取回一张会话图片的**原始字节**（`GET /api/v2/attachments/{id}`）。
     *
     * 为什么必须另开一个端点：图片字节从来不进会话事件日志（日志里只有
     * `{type:'image', attachment:{attachmentId:'sha256:…'}}` 这样的引用），
     * 所以"对话里能看图"这件事只能靠"先拿到引用、再按引用取字节"两步走。
     *
     * 三个刻意的取舍：
     * 1. **不过 JSON**：响应体就是图片字节本身（`TunnelResponse.body`）。中继隧道本来就是二进制
     *    帧（`FrameCodec`），把它 base64 进 JSON 只会让 1 MiB 的响应涨到 1.37 MiB；
     * 2. **Accept 用通配符**：隧道默认头是 `application/json`，对二进制端点语义不对。网关照发字节，
     *    但把请求头写对能避免任何中间层按 JSON 处理它；
     * 3. **超时放宽到 2 分钟**：一张 8 MiB 的图要跨中继完整落盘，60 秒在弱网下会假失败，
     *    而失败一次就得从头发（本方法是幂等的，重试无副作用）。
     *
     * 失败抛 [ApiException]：`not_found`（对象库没有这张图，通常是电脑端清理过）、
     * `bad_request`（id 形状不对）、`attachment_too_large`（超过网关上限 8 MiB）。
     */
    suspend fun fetchAttachment(id: String): ByteArray {
        val response = tunnel.execute(
            method = "GET",
            path = "/api/v2/attachments/${encodePath(id)}",
            headers = mapOf("Accept" to "*/*"),
            timeoutMs = attachmentTimeoutMs,
        )
        if (!response.isSuccessful) {
            throw JsonV2.parseError(
                body = response.bodyText(),
                httpStatus = response.status,
                fallbackMessage = "图片下载失败 HTTP ${response.status}",
            )
        }
        return response.body
    }

    /**
     * 会话的轮次索引（`GET /api/v2/sessions/{id}/turn-index`，v2.9.0）。
     *
     * 手机只把最近 60 条消息拿在手里，"跳到第 12 轮"必须知道第 12 轮在服务端消息数组里的
     * 下标区间 —— 这个信息只有服务端能给（没加载的历史客户端根本看不见）。
     * 拿到 [TurnIndexEntry.toIndex] 之后，跳转就是一次普通的分页请求
     * （`cursor=toIndex&limit=60`，见 [transcriptPage]），翻页语义完全一致。
     */
    suspend fun turnIndex(sessionId: String): TurnIndex =
        JsonV2.parseTurnIndex(get("/api/v2/sessions/${encodePath(sessionId)}/turn-index"))

    // ---------- 内部 ----------

    private suspend fun get(path: String): String = read(tunnel.execute("GET", path, timeoutMs = requestTimeoutMs))

    private suspend fun post(path: String, json: String?): String = read(
        tunnel.postJson(path, json, timeoutMs = requestTimeoutMs),
    )

    private fun read(
        response: com.deepseek.dshremote.data.relay.TunnelResponse,
        payloadTooLargeMessage: String? = null,
    ): String {
        if (!response.isSuccessful) {
            val error = JsonV2.parseError(
                body = response.bodyText(),
                httpStatus = response.status,
                fallbackMessage = "请求失败 HTTP ${response.status}",
            )
            // 只对**带图片的这条请求**把 413 说成人话：网关/中继的单次请求上限是 1 MB，
            // 用户唯一的出路是换小图或减少张数（重试一定会再失败）。
            // 服务端另有 code=payload_too_large 的分支（见 friendlyMessage）。
            if (payloadTooLargeMessage != null && (response.status == 413 || error.isPayloadTooLarge)) {
                Logger.w(TAG, "API 请求体过大 status=${response.status} code=${error.code}")
                throw ApiException(code = "payload_too_large", message = payloadTooLargeMessage, httpStatus = response.status)
            }
            Logger.w(TAG, "API 失败 status=${response.status} code=${error.code}")
            throw error
        }
        return response.bodyText()
    }

    companion object {
        private const val TAG = "DshApiV2"

        /**
         * 带图片时 413 的人话（网关/中继单次请求上限 1 MB）。
         *
         * 常量在这里是因为**只有带图片的请求**会遇到它：同一句话也用于服务端的
         * `payload_too_large` 错误码（见 `friendlyMessage`，那边行为按任务口径单独改）。
         */
        const val IMAGE_TOO_LARGE_MESSAGE: String =
            "图片太大，网关/中继单次请求上限 1 MB：请换更小的图，或减少图片数量"

        /**
         * 续聊请求体（冻结协议；无图时与历史实现逐字节一致）。
         *
         * 可见性放开到包内是为了让单测能直接断言**字符串形状**（不需要起隧道），
         * 而端到端那份仍走 [postTurn] → 隧道 → 真实字节。
         */
        internal fun turnBodyJson(
            prompt: String,
            clientTurnId: String,
            images: List<PendingImage> = emptyList(),
        ): String = org.json.JSONObject().apply {
            put("prompt", prompt)
            // 只在真的有图时才写 content：空数组也是"多了一个字段"，旧网关会当未知字段处理
            if (images.isNotEmpty()) put("content", turnContent(prompt, images))
            put("clientTurnId", clientTurnId)
        }.toString()

        /**
         * `content: ContentBlock[]`：**先 text 块、再 image 块**。
         *
         * 文字为空（"只发图片"）时**不写空的 text 块**：网关侧按冻结协议补占位文本，
         * 客户端塞一个 `text:""` 反而会让上游多一条空消息。
         */
        internal fun turnContent(prompt: String, images: List<PendingImage>): org.json.JSONArray =
            org.json.JSONArray().apply {
                if (prompt.isNotEmpty()) {
                    put(org.json.JSONObject().apply {
                        put("type", "text")
                        put("text", prompt)
                    })
                }
                images.forEach { image ->
                    put(org.json.JSONObject().apply {
                        put("type", "image")
                        put("mediaType", image.mediaType)
                        // 裸 base64、无换行：换行会被上游按字面收进字段里
                        // （java.util.Base64 的 MIME 编码器才会折行，基础编码器不会）
                        put("data", Base64.getEncoder().encodeToString(image.bytes))
                        // 名字只在真的有值时写（老安卓的取自 MEDIA_DISPLAY_NAME，可能为空）
                        if (image.name.isNotEmpty()) put("name", image.name)
                    })
                }
            }

        // ---------- 整包预算（1 MiB 是整个请求体，不是单图） ----------

        /**
         * 附件下载的超时：**2 分钟**（比普通请求的 60 秒宽一倍）。
         *
         * 理由：附件是这条隧道上唯一的"大响应"（网关上限 8 MiB）。弱网下 8 MiB 走完
         * 60 秒是有可能不够的，而超时一次就要从头发 —— 内容是哈希寻址、下载是幂等的，
         * 与其假失败一次，不如把窗口放宽。它不影响任何其它端点。
         */
        const val ATTACHMENT_TIMEOUT_MS = 120_000L

        /**
         * 单个请求体上限：**1 MiB**，作用于整个 JSON body。
         *
         * 实测边界（`.probe/e2e-image-turn.mjs --limits`，真 HTTP）：body=1_048_500 B 通过
         * （读完体、返回业务错误），body=1_048_640 B 时连接被直接关闭。
         * 也就是说卡的是"整个请求体"，而**不是**单张图。
         *
         * 量的是**字节**（见 [utf8Length]）：网关卡在网络层收到的字节上，中文一字三字节，
         * 按 `String.length` 量会低估，正好会踩进 1_048_500–1_048_640 这个实测窗口。
         */
        const val MAX_BODY_CHARS = 1_048_576

        /**
         * 整包预算里留给图片的额度：**900 KiB**（团队裁定，gw-wire 网关侧同值校验）。
         *
         * 与 [MAX_BODY_CHARS] 差 124 KiB，是留给 JSON 壳
         * （`{"prompt":…,"content":[…],"clientTurnId":…}`）与一段长文本的余量。
         */
        const val IMAGE_BUDGET_CHARS = 900 * 1024

        /**
         * 单图额外放行 [TIGHT] 时，从**硬边界**里扣掉的余量：92 KiB。
         *
         * **为什么单图必须走另一条线**：一张压到 [ImagePayloads.MAX_COMPRESSED_BYTES]（700 KiB）
         * 的图，base64 后就是 955_736 B，**本身就超过 900 KiB 的整包预算 35 KiB**。
         * 如果连单图也按 [IMAGE_BUDGET_CHARS] 卡，`ImagePayloads` 那套"压到 700 KiB 就能发"的
         * 降档阶梯（`ImagePayloadsTest.「满预算的图 base64 之后仍然小于 1 MiB」`）会在发送时
         * 被自己的客户端拦下——压缩器额定的输出发不出去，是自相矛盾的。
         *
         * 数值是**实测反推**的，不是拍的：`PostTurnImagesTest` 里那张满预算单图的真实 body 是
         * **955_885 B**（955_736 base64 + prompt/壳约 149 B）。96 KiB(98_304) → 950_272 B、
         * 94 KiB(96_256) → 952_320 B、92 KiB(94_208) → 954_368 B，**三个都不够** ——
         * 这就是最初 96/94 KiB 两版把这条测试写红的原因。扣 90 KiB(92_160) 得 956_416 B，
         * 才真正把实测值放进去，余量 531 B。
         *
         * 注意这**不是**把单图线拉到硬边界上：它仍比 [MAX_BODY_CHARS] 低，留出的余量
         * 只够一层 JSON 壳和一小段文字。用户在单图旁边贴长文时，[bodyWithinLimit] 那道
         * 硬边界仍会独立把关（两层判据都跑，见 [bodyWithinBudget] 的调用点）。
         */
        const val SINGLE_IMAGE_HEADROOM_CHARS = 90 * 1024

        /** 单图放行的字节线：[MAX_BODY_CHARS] 扣掉 [SINGLE_IMAGE_HEADROOM_CHARS]。 */
        const val SINGLE_IMAGE_BUDGET_BYTES = MAX_BODY_CHARS - SINGLE_IMAGE_HEADROOM_CHARS

        /**
         * 序列化后真正要发出去的**字节数**（UTF-8）。
         *
         * 不用 `String.length`：那是 UTF-16 码元数，中文一个字只算 1，而网关收到的是 3 字节。
         * 实测窗口只有 140 B 宽（1_048_500 通过 / 1_048_640 关闭），低估几百字节就足以
         * 让"本地判过、网关断连"这种最难查的失败重现。
         *
         * 原名 `bodyBytes`，改名是因为 [postTurn] 里需要一个局部变量装 body 的字节数，
         * 同名会把函数遮住（详见 [postTurn] 的注释）。
         */
        fun utf8Length(json: String): Int = json.toByteArray(Charsets.UTF_8).size

        /**
         * 整包是否在限内。**量的是真序列化后的字节数**，不是估算：
         * base64 的膨胀、JSON 转义、prompt 长度、中文的多字节全都算进去了，
         * 判据与实际发出去的字节是同一个。
         *
         * 为什么不直接用 [PendingImage.approxBase64Chars] 求和：那是近似（按 4/3 向上取整），
         * 而这里量一次 `turnBodyJson` 的代价只是一次字符串拼接——多花几毫秒，
         * 换来"判定依据 == 发出内容"这条不会再漂移的等价关系。
         */
        fun bodyWithinLimit(bodyBytes: Int): Boolean = bodyBytes <= MAX_BODY_CHARS

        /**
         * 单图放行的字节线（见 [SINGLE_IMAGE_HEADROOM_CHARS] 的推导）。
         *
         * 独立成一个函数而不是内联，是为了让单测能直接钉住"这张 700 KiB 的图到底能不能发"。
         */
        fun singleImageWithinLimit(bodyBytes: Int): Boolean =
            bodyBytes <= SINGLE_IMAGE_BUDGET_BYTES

        /**
         * 整包预算的最终判定（`postTurn` 用的就是它）。**规则只有两条**：
         *
         * - 只有 1 张图：按 [singleImageWithinLimit]（实测硬边界减余量），
         *   否则 700 KiB 的合法单图会被自己的客户端拦死；
         * - 2 张及以上：按团队裁定的 [IMAGE_BUDGET_CHARS]（900 KiB），因为多图时
         *   JSON 壳与文本的占比可以忽略，900 KiB 已经足够宽松；
         * - 没有图：只看 [MAX_BODY_CHARS]，此时 body 就是 `{"prompt":…,"clientTurnId":…}`。
         */
        fun bodyWithinBudget(bodyBytes: Int, imageCount: Int): Boolean = when {
            imageCount <= 0 -> bodyWithinLimit(bodyBytes)
            imageCount == 1 -> singleImageWithinLimit(bodyBytes)
            else -> bodyBytes <= IMAGE_BUDGET_CHARS
        }

        /**
         * 超预算的文案。
         *
         * 必须点明三件事，否则用户只能瞎试：**合计多少 KB**（实际值，不是"太大了"）、
         * **上限多少**、**该做什么**（减张数或压缩）。[count] 决定报哪条上限
         * （见 [bodyWithinBudget]：单图与多图不是同一条线），并给"减少张数"一个锚点。
         */
        fun imagesBudgetMessage(bodyBytes: Int, count: Int): String {
            val kb = bodyBytes / 1024
            val limitBytes = if (count <= 1) SINGLE_IMAGE_BUDGET_BYTES else IMAGE_BUDGET_CHARS
            val limitKb = limitBytes / 1024
            return "图片总量超出单次请求预算（本次合计约 $kb KB，上限 $limitKb KB，" +
                "共 $count 张）：请减少张数或压缩后再发"
        }

        /**
         * 发送**之前**用真实序列化后的 body 判一次预算：超了返回可直接给用户看的文案，没超返回 null。
         *
         * 为什么需要"还没发就问"的版本：[postTurn] 的判据跑在**乐观回声之后**，超预算时用户会
         * 先看到一条 `[N 张图片] …` 的本地气泡、紧接着才是失败提示——那条气泡在电脑端并不存在，
         * 是幽灵消息（android-wire 在 task-3 报告里点名要求补的前置闸门）。
         *
         * 为什么**必须**真序列化而不是估算：估算（[PendingImage.approxBase64Chars]）只算图片的
         * base64，**不含** JSON 壳与文本。第一版就是拿估算值跟 [IMAGE_BUDGET_CHARS] 比，结果
         * 出现"估算刚好过线、真实 body 却没超"的放行，也就是预估放行了真判据不接受的东西——
         * 那正是"发出去必失败"的幽灵消息本身。这里直接量 `turnBodyJson` 的 UTF-8 字节数，
         * 与 [bodyWithinBudget] 是同一个数，两层判据不可能各说各话。
         *
         * 代价：调用方要能拿到 body 字符串。多拼一次 JSON 的成本只有几十微秒，
         * 换来的是"本地拦下 ⇔ 服务端也会拦下"这条不再漂移的等价关系。
         */
        internal fun imagesBudgetPrecheck(prompt: String, images: List<PendingImage>): String? {
            if (images.isEmpty()) return null
            val bodyBytes = utf8Length(turnBodyJson(prompt, "precheck", images))
            if (bodyWithinBudget(bodyBytes, images.size)) return null
            return imagesBudgetMessage(bodyBytes, images.size)
        }

        /** 超预算时抛它。继承 [IllegalArgumentException] 是为了走仓库统一的"输入不合法"出口。 */
        internal class BudgetExceededException(message: String) : IllegalArgumentException(message)

        /** 非 2xx 时错误 body 的保留上限：流式 5xx 会一路 append 到 32 MiB 流上限。 */
        private const val MAX_ERROR_BODY_CHARS = 64 * 1024

        /** 拼接 query（跳过 null/空值）。 */
        fun query(vararg pairs: Pair<String, String?>): String {
            val parts = pairs.mapNotNull { (key, value) ->
                if (value.isNullOrEmpty()) null else "$key=${encode(value)}"
            }
            return if (parts.isEmpty()) "" else "?" + parts.joinToString("&")
        }

        fun encode(value: String): String = URLEncoder.encode(value, "UTF-8")

        /** 路径段编码：会话 id / tokenId 都是安全字符，但仍然编码一次防注入。 */
        fun encodePath(segment: String): String = URLEncoder.encode(segment, "UTF-8").replace("+", "%20")
    }
}
