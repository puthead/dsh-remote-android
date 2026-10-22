package com.deepseek.dshremote.data.api

import java.util.TreeMap

/**
 * 对话记录的**滑动窗口**状态机（m00002「手机端对话分页」的数据核心）。
 *
 * 为什么要有这一层，而不是让仓库/ViewModel 直接 `messages + page.messages`：
 *
 * 1. **去重**必须按 seq（本地乐观消息与 `turn.ended` 后的权威投影会在同一 seq 上重叠）；
 * 2. **有序**必须是升序（"加载更早"是头插，不能假设 append）；
 * 3. **有界**：长会话动辄上千条消息，窗口不能随翻页无限增长（这正是"都在单页里影响查看"的根因）；
 * 4. **游标只由服务端页推进**：本地插入的消息没有服务端下标，不能拿来当 cursor。
 *
 * 纯计算、不依赖 Android/协程，因此可以在 JVM 单测里把"翻页 + 去重 + 裁剪"整条路径跑穿。
 *
 * @param capacity 窗口上限（条）。超出时按调用方给的方向裁剪：
 *   追新（尾部刷新）裁最旧，翻更早裁最新 —— 保证刚载入的那一页一定留得下来。
 */
class TranscriptPager(private val capacity: Int = DEFAULT_CAPACITY) {

    /**
     * 窗口用 [TreeMap]（按 seq 有序）而不是 LinkedHashMap：
     *
     * - 「加载更早」是**头插**，插入顺序 ≠ seq 顺序，LinkedHashMap 会让 [messages] 的升序承诺失效
     *   （`[101..150, 51..100]` 这种顺序会被 LazyColumn 原样渲染成倒着的历史）；
     * - 裁剪必须按 **seq 方向**（丢最小 seq / 丢最大 seq），而不是按插入顺序，
     *   否则「先插新页、后插更早页」时会把**刚载入的更早那一页**丢掉，表现为"上拉永远看不到新的历史"。
     */
    private val window = TreeMap<Long, ChatMessage>()
    private var synthetic = 0L
    private var trimFlags = TrimFlags()

    /**
     * 已经分配过合成 key 的本地消息（按调用方原样传进来的 [ChatMessage] 认身份）。
     *
     * 为什么必须记这一笔：合成 key 原来**每调用一次就自增**，于是同一条本地乐观消息只要被
     * [upsert] 两次，窗口里就会出现**两行**（同一个 seq=0 的值挂在两个 key 上）。
     * 这不是理论风险 —— `ConsoleRepository.restoreLocalMessages` 每轮 `resetWindow`/`mergeNewestPage`
     * 都会把"还没被服务端投影接管"的本地消息再 upsert 一遍，而带图回合的本地文案
     * （`[N 张图片] …`）与服务端投影文本**永远不相等**，于是它每次都"还没被接管"，
     * 每轮都新分一个 key ⇒ 屏幕上并排两条一模一样的用户气泡（m00011）。
     */
    private val syntheticKeys = HashMap<ChatMessage, Long>()

    /**
     * 本地乐观消息在窗口里占的**内部 key**（它们对外暴露的 seq 恒为 0）。
     *
     * 单独记一份而不是靠"seq < 0"识别：这两件事必须解耦 ——
     * 见 [keyOf] 里关于"排在哪"与"对外报什么 seq"的说明。
     */
    private val localKeys = LinkedHashSet<Long>()

    /**
     * 当前窗口内的消息（**按调用方看到的时间线顺序**）。
     *
     * 顺序 = 内部 key 的升序，也就是 [TreeMap] 的迭代顺序：
     * 服务端消息按真实 seq 升序，本地乐观消息的 key 恒大于所有服务端 seq，所以排在最末
     * ——它们正是用户刚发出去、还没来得及被服务端投影的那几条，时间线上就在最后。
     */
    val messages: List<ChatMessage> get() = window.values.toList()

    /** 分页元信息。 */
    var state: TranscriptSync = TranscriptSync()
        private set

    /**
     * 不变量（给后续改这份代码的人）：
     *
     * - **驱动翻页的只有 [TranscriptSync.nextCursor]**（服务端给的排他上界 offset）；
     *   `loadedFrom`/`loadedTo` 是给标题栏「已加载 X/Y 条」用的**显示近似值**。
     *   窗口一旦发生裁剪，服务端的 `from` 下标在本地已经没有对应含义，
     *   所以这里用「上界 - 窗口内服务端条数」推算，而不是直接抄 `page.from`。
     * - 谁都不许用 `loadedCount >= total` 去代替 `nextCursor == null` 判断"已到最早"：
     *   裁剪过的窗口完全可能条数刚好等于 total，但中间是断的。
     * - **服务端的 cursor 是"排他上界"，相邻两页在 seq 上永不重叠**（`nextCursor = from`）。
     *   所以绝对不能用"页首 seq 是否已在本窗口里"来判断连续性 —— 那对每一个合法的更早页
     *   都会得到 false，从而把游标永久卡住（详见 [pickNextCursor]）。
     */

    /**
     * 首屏 / 强制刷新：用一页最新数据**整个替换**窗口（含本地乐观消息）。
     *
     * 本地乐观消息的清理**不在这里**，也不需要一个 [removeLocal] 之类的入口：
     * 权威投影一到，[ConsoleRepository.restoreLocalMessages] 就会把"已被服务端投影接管"
     * 的那几条从它自己的 `localMessages` 里摘掉、并且不再 [upsert] 回来 —— 单一事实源在仓库层，
     * 本类只负责"当前窗口里有什么"。
     */
    fun reset(page: TranscriptPage) {
        window.clear()
        localKeys.clear()
        syntheticKeys.clear()
        synthetic = 0
        state = TranscriptSync()
        trimFlags = TrimFlags()
        // 首屏这一页是"最新的 60 条"，必须按追新方向裁剪（裁最旧），否则一次超量响应会把最新的丢掉。
        merge(page, CursorPolicy.ADVANCE, trimOldest = true)
    }

    /**
     * 合并一页。
     *
     * @param cursorPolicy 游标推进策略，见 [CursorPolicy]。**调用方必须给对**：
     *   追最新页时给 [CursorPolicy.PRESERVE]，否则会把游标推到"比当前窗口还新"的位置，
     *   窗口与游标之间就出现一段永远取不到的断档。
     * @param trimOldest true = 超出容量时裁掉**最旧**的（追新场景）；
     *   false = 裁掉**最新**的（上拉加载更早场景，用户正在往上看，不能把眼前的裁掉）。
     */
    fun merge(
        page: TranscriptPage,
        cursorPolicy: CursorPolicy = CursorPolicy.ADVANCE,
        trimOldest: Boolean = true,
    ): List<ChatMessage> {
        for (message in page.messages) {
            val key = keyOf(message)
            // 值一律原样入窗：本地乐观消息拿到的是内部合成 key，但它对外的 seq 必须保持
            // 调用方给的 0（不占服务端序号空间）；服务端消息 key == seq，本来就一致。
            window[key] = message
            if (key != message.seq) localKeys.add(key)
        }
        val trimmed = enforceCapacity(trimOldest)
        val pageHasMessages = page.messages.isNotEmpty()
        // 上界只许前进：一次不带 from/to 的 merge（例如空响应）不能把已加载区间算小
        val loadedTo = maxOf(
            state.loadedTo,
            if (pageHasMessages && page.to > 0) page.to else serverCount(),
            serverCount(),
        )
        val loaded = serverCount()
        state = state.copy(
            nextCursor = pickNextCursor(page.nextCursor, page.cursorProvided, cursorPolicy),
            // 临时回声不占服务端消息条数，接管时也不能让总数凭空多一条。
            total = maxOf(if (page.total > 0) page.total else loaded, loaded),
            loadedFrom = maxOf(0, loadedTo - loaded),
            loadedTo = loadedTo,
            // 计数只看窗口：推算值会虚高（见 TranscriptSync.loaded 的注释）
            loaded = loaded,
            trimmedOlder = trimFlags.older,
            trimmedNewer = trimFlags.newer,
            initialized = true,
        )
        return messages
    }

    /**
     * 选中下一页游标 —— 本类最容易写错的地方，改动前请先读这段。
     *
     * 服务端契约（协议契约 v2 §4.2.1）：`cursor` 是**排他上界**（offset），
     * 返回其之前最多 `limit` 条，`nextCursor = from` 是**更早**那一页的游标。
     * 也就是说相邻两页**天生不重叠**：更早页不会重发边界那条消息。
     *
     * 因此"页首 seq 是否已在本窗口内"是个**恒为 false** 的判据，用它拒绝推进游标
     * 会让"上拉加载更早"每次都重复请求同一页：既看不到更早的消息，
     * `hasMoreOlder` 又永远为 true（界面表现为转圈不停）。
     *
     * 真正需要保护的只有两件事：
     *
     * 1. **追最新页不许把游标往前（更新方向）推**：`PRESERVE` 语义，有游标就留着。
     * 2. **更早页的游标必须严格变小**：服务端游标是十进制下标。若它没有变小（或压根解析不出来），
     *    再取一次只会拿到同一页 —— 此时把游标**关掉**（null）而不是留在原地：
     *    留在原地会让界面的滚动监听反复请求同一页（表现为一直转圈），
     *    而 null 会让上拉入口显示"已到最早"并停止请求。这是"宁可少一次也不空转"的取舍。
     *
     * ## `offered == null` 有两种含义，必须靠 [TranscriptPage.cursorProvided] 分开
     *
     * - **字段在、值为 null**：服务端**明确说**"已到最早"（`from == 0` 那一页的回包）⇒ 返回 null。
     *   这里曾经错误地返回 `current`，后果是实测出来的：最早页反复被请求 8 次、
     *   「已到最早」永远不出现（`hasMoreOlder` 恒真）。
     * - **字段缺失**（老网关）：服务端没表态 ⇒ 保留旧游标，否则一次老网关响应就把向上翻页废掉。
     *
     * ## 不可解析的游标一个都不许收
     *
     * 放行一个 `parseCursor` 解析不出来的值（`"abc"`、`"-5"`），下一轮 `parseCursor(current)` 又是 null、
     * 守卫再次放行，同一个游标就被反复拿来请求同一页 —— 也就是 D2 在真机上的症状。
     * 所以**首屏也一样只收可解析的游标**：宁可这一轮就没有"加载更早"，也不留一个会空转的入口。
     *
     * ## 追最新页（[CursorPolicy.PRESERVE]）为什么连"服务端明确说 null"也不能采纳
     *
     * 服务端的 `nextCursor` 只描述**它刚返回的那一页**的位置。追最新拿到的是窗口**另一头**的一页，
     * 它的 `nextCursor` 指的是"比那一页更早"的位置，与本地窗口里已有的历史无关：
     *
     * - 采纳一个**更小**的游标：窗口与它下方那段历史之间出现永远取不回来的断档；
     * - 采纳一个 **null**（最新页 `from == 0`，即整段会话就一页）：会直接关掉"加载更早"，
     *   可本地明明还留着更早的历史 —— 用户从此再也翻不回去。
     *
     * 所以 PRESERVE 下只有一个动作：**有游标就留着，没有才拿 `offered` 兜底**。
     */
    private fun pickNextCursor(offered: String?, offeredProvided: Boolean, policy: CursorPolicy): String? {
        val current = state.nextCursor
        // PRESERVE 分支连兜底那一下也只收可解析的：`current` 为 null 的情形正是"首屏还没拿到游标"，
        // 此时若把追新页带回来的垃圾游标存进去，下一轮 ADVANCE 会把入口直接关掉（最多白跑一次），
        // 但"窗口里存着一个根本解析不了的游标"本身就不该发生 —— 有一处收垃圾，就有一处要替它兜底。
        if (policy == CursorPolicy.PRESERVE) {
            return current ?: offered?.takeIf { it.isNotEmpty() && parseCursor(it) != null }
        }
        if (!offeredProvided) return current

        // 往后每一行都在拒绝"不可解析的游标"，一次也不能放行：
        // 放行一个解析不出来的值，下一轮 `parseCursor(current)` 又是 null、守卫再次放行，
        // 于是同一个游标被反复用来请求同一页 —— D2 在真机上就是这个症状（重复请求 8 次）。
        val currentText = current?.trim().orEmpty()
        if (currentText.isEmpty()) {
            // 首次拿游标：同样只收可解析的，否则首屏一个协议违例的游标就把入口钉死成"一直有更早"。
            return offered?.takeIf { !it.isEmpty() && parseCursor(it) != null }
        }
        val oldOffset = parseCursor(currentText) ?: return null
        val newOffset = parseCursor(offered) ?: return null
        // 只有明确更早（下标严格变小）才接受；否则视为"服务端没有更早的页了"，
        // 把入口关掉（null）而不是留在原地：留在原地会让滚动监听反复请求同一页（一直转圈）。
        return if (newOffset < oldOffset) offered else null
    }

    /** 追加/覆盖一条（SSE 增量、本地乐观消息）。 */
    fun upsert(message: ChatMessage): List<ChatMessage> {
        val key = keyOf(message)
        window[key] = message
        if (key != message.seq) localKeys.add(key)
        val loaded = serverCount()
        state = state.copy(total = maxOf(state.total, loaded), loaded = loaded)
        return messages
    }

    /** 删除已由服务端接管的本地回声，不能只从仓库记账中删除。 */
    fun removeLocal(message: ChatMessage) {
        val key = syntheticKeys.remove(message) ?: return
        if (localKeys.remove(key)) window.remove(key)
    }

    fun clear() {
        window.clear()
        localKeys.clear()
        syntheticKeys.clear()
        synthetic = 0
        state = TranscriptSync()
        trimFlags = TrimFlags()
    }

    /** 窗口内服务端消息条数（本地乐观消息不计入：它们不占服务端序号空间）。 */
    private fun serverCount(): Int = window.size - localKeys.size

    /**
     * 内部排序 key。**这里有两个必须分开的问题**，混在一起会同时写错两处：
     *
     * 1. **"排在哪"**：本地乐观消息是用户刚发出去的那几条，在时间线上就是最后，
     *    所以它们的内部 key 必须恒大于窗口里所有服务端 seq（从 [SYNTHETIC_BASE] 起往上发），
     *    否则 [`messages`] 会把它们排到最前，界面表现为"刚发的话跑到最上面去了"。
     * 2. **"对外报什么 seq"**：它们**没有**服务端序号，对外必须一直报 0，
     *    既不能被当成真实 seq 参与去重/游标推算，也不能占用正数序号空间。
     *
     * 把 2 实现成"分配一个负数 seq"是错的：负数在 [TreeMap] 里排最前，直接破坏 1。
     * 所以合成 key 只活在窗口内部（[localKeys] 记账），值里的 seq 保持调用方给的 0。
     *
     * ## 分配必须**幂等**（m00011 的第二个必要条件）
     *
     * 同一条本地消息被 [upsert] 多次时必须拿到**同一个** key：否则第二次落地不是"覆盖自己"，
     * 而是"多出一行"，界面上就是两条一模一样的用户气泡。
     * 仓库层每轮刷新都会把尚未接管的本地消息补回来（见 [ConsoleRepository.restoreLocalMessages]），
     * 所以"被 upsert 多次"是常态而不是异常。
     *
     * 认身份用 [ChatMessage] 的**值相等**（data class）：`restoreLocalMessages` 每次补回来的都是
     * 当初 `appendLocalUserMessage` 造的那一个对象，以及 `localMessages` 里存的那一份，
     * 两者内容相同 ⇒ 拿到同一个 key。反过来，内容不同的两条本地消息天然拿到不同 key，
     * 该并排显示的就并排显示。
     */
    private fun keyOf(message: ChatMessage): Long {
        if (message.seq != 0L) return message.seq
        syntheticKeys[message]?.let { return it }
        synthetic += 1
        // 钳住上界：合成 key 必须严格大于任何真实 seq，也绝不能溢出成负数（那就排到最前面去了）
        val key = if (synthetic >= SYNTHETIC_MAX_OFFSET) SYNTHETIC_BASE + SYNTHETIC_MAX_OFFSET else SYNTHETIC_BASE + synthetic
        syntheticKeys[message] = key
        return key
    }

    /** @return 是否真的裁掉了。 */
    private fun enforceCapacity(trimOldest: Boolean): Boolean {
        if (window.size <= capacity) return false
        val drop = window.size - capacity
        // 按 seq 方向裁，不按插入顺序：先插新页后插更早页时，插入顺序会把刚载入的更早页丢掉。
        repeat(drop) {
            val key = if (trimOldest) window.firstKey() else window.lastKey()
            window.remove(key)
            // 被裁掉的若是本地乐观消息，记账也必须跟着删，否则 serverCount() 会把它算漏
            localKeys.remove(key)
        }
        if (trimOldest) trimFlags = trimFlags.copy(older = true) else trimFlags = trimFlags.copy(newer = true)
        return true
    }

    /** 服务端游标是十进制下标；解析不出来时返回 null（调用方按"游标不前进"处理）。 */
    private fun parseCursor(token: String?): Long? {
        val text = token?.trim().orEmpty()
        if (text.isEmpty()) return null
        val value = text.toLongOrNull() ?: return null
        return if (value >= 0) value else null
    }

    private data class TrimFlags(val older: Boolean = false, val newer: Boolean = false)

    /**
     * 游标推进策略。
     *
     * 为什么要有这个枚举，而不是让 [merge] 自己猜：服务端的 `nextCursor` 只描述
     * **它刚返回的那一页**的位置，不描述本地窗口的位置。追最新页时那一页在窗口的"另一头"，
     * 直接采纳它的游标会把"更早"的起点推到窗口上界之外，中间那一段就再也取不回来了。
     */
    enum class CursorPolicy {
        /** 采纳服务端给的游标（用于"加载更早"：游标必须一路往更早走）。 */
        ADVANCE,

        /** 已有游标就留着（用于追最新 / 首屏之后的尾部刷新：不许把游标往更新方向推）。 */
        PRESERVE,
    }

    companion object {
        /**
         * 窗口上限：600 条。
         *
         * 取值理由：一屏大约 6~10 条消息，600 条 ≈ 60~100 屏，远超"往回翻着看"的实际需要；
         * 同时 600 条正文的常驻内存远小于原来"全量常驻 + 全量渲染"的代价。
         */
        const val DEFAULT_CAPACITY = 600

        /**
         * 本地乐观消息合成 key 的基数。
         *
         * 取 2^60 是因为服务端 seq 是会话事件日志的水位（实测在千级），
         * 而 2^60 ≈ 1.15e18 既远大于它、又离 [Long.MAX_VALUE] ≈ 9.22e18 还有 8 倍余量，
         * 于是"从基数往上发临时 key"既不会撞上真实 seq，也不会溢出。
         */
        private const val SYNTHETIC_BASE = 1L shl 60

        /** 合成 key 的偏移上限（远远够用，只是防溢出的兜底钳位）。 */
        private const val SYNTHETIC_MAX_OFFSET = Long.MAX_VALUE - SYNTHETIC_BASE
    }
}
