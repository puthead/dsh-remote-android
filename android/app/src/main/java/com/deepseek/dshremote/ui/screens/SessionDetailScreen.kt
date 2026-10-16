package com.deepseek.dshremote.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.util.Log
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.VerticalAlignBottom
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.deepseek.dshremote.BuildConfig
import com.deepseek.dshremote.Graph
import com.deepseek.dshremote.data.api.ChatMessage
import com.deepseek.dshremote.data.api.Deliverable
import com.deepseek.dshremote.data.api.ImageLoader
import com.deepseek.dshremote.data.api.ImageRef
import com.deepseek.dshremote.data.api.SessionViewMode
import com.deepseek.dshremote.data.api.TaskAccess
import com.deepseek.dshremote.data.api.TrajectoryKind
import com.deepseek.dshremote.data.api.TrajectoryRow
import com.deepseek.dshremote.data.api.WireApprovals
import com.deepseek.dshremote.ui.components.AssistantMessage
import com.deepseek.dshremote.ui.components.ComposerImageRow
import com.deepseek.dshremote.ui.components.DshCard
import com.deepseek.dshremote.ui.components.DshIconButton
import com.deepseek.dshremote.ui.components.EmptyHint
import com.deepseek.dshremote.ui.components.ErrorText
import com.deepseek.dshremote.ui.components.ImageViewerDialog
import com.deepseek.dshremote.ui.components.LoadOlderEntry
import com.deepseek.dshremote.ui.components.LoadOlderOnReachTop
import com.deepseek.dshremote.ui.components.TodoListCard
import com.deepseek.dshremote.ui.components.TrajectoryList
import com.deepseek.dshremote.ui.components.UserBubble
import com.deepseek.dshremote.ui.components.rememberImagePicker
import com.deepseek.dshremote.ui.theme.DshError
import com.deepseek.dshremote.ui.theme.DshNeutral
import com.deepseek.dshremote.ui.theme.DshOnBackground
import com.deepseek.dshremote.ui.theme.DshOnSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshPrimary
import com.deepseek.dshremote.ui.theme.DshRadius
import com.deepseek.dshremote.ui.theme.DshSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshWarning
import com.deepseek.dshremote.ui.theme.LocalDshDimens
import com.deepseek.dshremote.ui.theme.LocalDshType
import com.deepseek.dshremote.ui.vm.SessionDetailViewModel
import com.deepseek.dshremote.ui.vm.appViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * 会话详情：**对话**（画稿 02）与**轨迹**（画稿 03）两个页签。
 *
 * 结构按画稿重排为：自绘顶栏（返回 / 标题 / 副标题 / 停止 / 更多）→ 页签 →
 * 实时状态条（只在真跑时出现）→ 内容 → 底部（对话页是输入区，轨迹页是三格汇总条）。
 *
 * 状态机部分**刻意原样保留**（分页窗口、贴底判定、视图持久化、"回到最新"一次性信号）：
 * 这次只换视觉与密度。分页/贴底的每一条注释都对应一次真机实测的坑，
 * 重写它们属于另一件事，不该混在改画稿的改动里。
 *
 * 下面这段是旧的说明，仍然成立：
 * 工具调用折叠、交付物可点开、待办固定在输入区上方。
 * 这里有两套分页线（合同 §4）：对话流首屏只取最新一页、上拉到顶再往回取；
 * 轨迹视图把同一段会话摊平成"一步一行"。两者共用同一个分页窗口与同一个滚动状态，
 * 因此"翻到哪儿了"在两个视图之间是连续的。
 *
 * @param pendingApproval 服务端审批待应答时的输入区接管口子（见 [PendingApprovalPrompt]）。
 *   当前数据层还没有这条状态，默认 `null` 就是没有审批的旧行为；接上审批数据后
 *   只要传非空实例，输入框那一格自动换成审批条。
 */
@Composable
fun SessionDetailScreen(
    sessionId: String,
    onBack: () -> Unit,
    onOpenFile: (workspace: String, path: String) -> Unit,
    onOpenWorkspace: (workspace: String) -> Unit,
    onGoPhoneTasks: () -> Unit = {},
    pendingApproval: PendingApprovalPrompt? = null,
) {
    val viewModel = appViewModel(key = "session-$sessionId") {
        SessionDetailViewModel(Graph.repository, sessionId)
    }
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    // 对话流与轨迹共用同一个滚动状态：它们对用户来说是"同一段会话的两种切法"，
    // 各记一份的话切一下视图就跳到别处，"回到最新"也得各判一次。
    val listState = rememberLazyListState()

    // 图片选择（相册走系统 Photo Picker，免运行时权限；拍照走 CAMERA + FileProvider）。
    // 拿到 Uri 后立刻交给 ViewModel 的 IO 线程去读+压，界面这一侧不做任何解码：
    // 8 MB 的原图在 UI 线程解一次就是一次可见的掉帧，甚至 OOM。
    val imagePicker = rememberImagePicker(
        onPicked = { uri, displayName -> viewModel.attachImage(uri, displayName) },
        onError = { message -> scope.launch { snackbarHostState.showSnackbar(message) } },
    )

    var showTodos by rememberSaveable { mutableStateOf(true) }
    var moreMenu by remember { mutableStateOf(false) }
    var filterMenu by remember { mutableStateOf(false) }
    var kindFilter by rememberSaveable { mutableStateOf(TrajectoryFilter.All) }

    // 全屏看图：列表与面板都只是"点开某一组图的第几张"，
    // 真正的查看器只有这一个实例（多开会让返回键的语义变得说不清）。
    var viewerImages by remember { mutableStateOf<List<ImageRef>>(emptyList()) }
    var viewerIndex by remember { mutableStateOf(0) }
    val openImage: (List<ImageRef>, Int) -> Unit = { images, index ->
        if (images.isNotEmpty()) {
            viewerImages = images
            viewerIndex = index.coerceIn(0, images.lastIndex)
        }
    }

    // 视图选择持久化：进程重建后 ViewModel 会退回默认的对话视图，这里把用户上次的选择
    // 重新下发一次。渲染仍然只认 ui.viewMode（单一数据源），否则两个状态迟早对不上。
    var savedViewMode by rememberSaveable { mutableStateOf(SessionViewMode.CONVERSATION) }
    LaunchedEffect(savedViewMode) {
        if (ui.viewMode != savedViewMode) viewModel.switchView(savedViewMode)
    }

    // 「已用 02:14」需要秒级推进。只在真的在跑时开表：不在跑的时候还每秒重组一次列表
    // 纯属白烧电，而静止状态下的耗时不推进才是对的。
    var nowMs by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(ui.live, ui.sending) {
        while (ui.live || ui.sending) {
            delay(1000)
            nowMs = System.currentTimeMillis()
        }
    }

    // 兜底拉取（REST 补齐）。为什么必须有：SSE 是**即时**通道，手机断线/切后台期间
    // 电脑端发出的 approval.asked 事件是补不回来的 —— 用户回到这个页面时，未决列表
    // 若只依赖 SSE，就会一直空着（这正是"手机上从来没有选项"的成因之一）。
    //
    // 三个细节：
    // 1. 只在电脑端相关的会话里跑：纯网关会话永远不会产生审批，轮询纯属浪费手机流量；
    // 2. 15 秒一次：待答是**低频且要求人操作**的事件，比会话列表的刷新频率低一档就够，
    //    而 TTL 有 15 分钟，晚十几秒看到不会误事；
    // 3. collectAsStateWithLifecycle + LaunchedEffect 的组合天然做到了"回前台立刻拉一次、
    //    退后台就停"：effect 在 STOPPED 时被取消、回到 STARTED 时重新启动，先拉后睡。
    LaunchedEffect(ui.session?.id, approvalRelevant(ui)) {
        while (approvalRelevant(ui)) {
            viewModel.refreshApprovals()
            delay(15_000)
        }
    }

    // 是否"本来就在底部"：只在滚动停下时根据当前布局重算，而且**只认用户自己拖出来的滚动**。
    // 关键点一：不能每次布局变化都现算 —— 新消息一落下来 totalItemsCount 就变，
    // 现算会把"用户守在底部"误判成"用户翻走了"，于是贴底与不贴底同时失效。
    // 关键点二（真机 A1c/A1d 实测）：程序自己的贴底动画（animateScrollToItem）同样会让
    // isScrollInProgress 为 true —— 首屏那次自动贴底还没落定就把 atBottom 算成了 false，
    // 之后没有任何事件再纠正它：视口明明贴在新最新一条上，右下角却一直挂着「回到最新」。
    // 所以先立一道闸：用户没亲手拖过列表之前，atBottom 保持初始的 true（首屏就该贴底）。
    var userScrolled by remember { mutableStateOf(false) }
    LaunchedEffect(listState) {
        listState.interactionSource.interactions.collect { interaction ->
            if (interaction is DragInteraction.Start) {
                userScrolled = true
                // 诊断用途（只在 DEBUG 包打）：A1c 要区分"闸门被谁打开"与"判据算错"，
                // 所以把闸门置位点和每次重算读数都留在 logcat 里，release 包不受影响。
                if (BuildConfig.DEBUG) Log.d(Tag, "drag-start -> userScrolled=true")
            }
        }
    }
    var atBottom by remember { mutableStateOf(true) }
    LaunchedEffect(listState) {
        // 观测"末可见项下标"而不是"首可见项下标"：atBottom 的判据依赖的是末项，
        // 跟着它才会收敛。真机实测：首屏贴底后首可见项早就停在 58 不再变化（判据算出来是"在底部"），
        // 而末项下标还在从中间值往 total-1 走 —— 用首可见项当 key，最后那次变化发不出来，
        // atBottom 就永远停在"用户翻走了"，于是贴底时右下角一直挂着「回到最新」。
        snapshotFlow { listState.isScrollInProgress to listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index }
            .collect { (scrolling, lastIdx) ->
                if (BuildConfig.DEBUG) {
                    Log.d(
                        Tag,
                        "observe scrolling=$scrolling userScrolled=$userScrolled lastIdx=$lastIdx " +
                            "total=${listState.layoutInfo.totalItemsCount} nearBottom=${listState.isNearBottom()} atBottom=$atBottom",
                    )
                }
                if (!scrolling && userScrolled) atBottom = listState.isNearBottom()
            }
    }

    // 展示完就消费掉（用户报的「一点界面就弹出『已提交回答…』」就是这个缺陷）：
    // message 写进 UiState 后原先从不归位 null，于是每次进入/重建本页，
    // LaunchedEffect 都用同一个没变过的 key 再跑一遍 → 同一条 snackbar 反复自己弹出来挡视线。
    //
    // 三个细节都别改：
    // 1. **先把文案抓成局部变量再 await**：showSnackbar 是挂起函数，await 期间 ui 可能已经变了，
    //    再去读 ui.message 就是另一条消息了；
    // 2. **消费放在 await 之后**（= 用户看过 / Short 时长到了 / 被下一条顶掉之后），
    //    提前消费会让「正在显示的那条」在重建时消失；
    // 3. **只消费 !isError 的那条**：isError=true 的失败原因由下面 :442 的常驻 ErrorText 呈现，
    //    一起清成 null 用户就看不到失败原因了。判据见 shouldConsumeSnackbarMessage 的注释。
    LaunchedEffect(ui.message) {
        val shown = ui.message ?: return@LaunchedEffect
        // 只在 DEBUG 包打：这条日志是"本缺陷不再复现"的现场证据（每一次 effect 触发一行）。
        // 修复前它会在每次进入/重建本页时重复出现；修复后同一条文案只会出现一次，
        // 紧接着一行 consumed=true（错误条则是 consumed=false, keep-as-error）。
        if (BuildConfig.DEBUG) Log.d(TagSnackbar, "snackbar-effect fire: $shown")
        snackbarHostState.showSnackbar(shown)
        val consume = shouldConsumeSnackbarMessage(ui.message, ui.isError)
        if (consume) viewModel.consumeMessage()
        if (BuildConfig.DEBUG) {
            Log.d(TagSnackbar, "snackbar-effect done: consumed=$consume isError=${ui.isError}")
        }
    }

    // 末尾标识：只有"末尾这一条换了"才需要贴底。
    // 为什么不用 messages.size 当触发条件：加载更早也会让 size 变大，而那时用户正在往回看，
    // 一次 animateScrollToItem 就把人拽回底部，分页等于白做（旧实现正是被这个抵消的）。
    val conversationTail: Any? = ui.messages.lastOrNull()?.let { Triple(it.seq, it.text.length, it.toolCalls.size) }
    LaunchedEffect(conversationTail, ui.viewMode) {
        if (ui.viewMode != SessionViewMode.CONVERSATION || conversationTail == null) return@LaunchedEffect
        // 用户上翻历史 / 正在取更早：绝不抢滚动，改用右下角「回到最新」
        if (!atBottom || ui.loadingOlder) return@LaunchedEffect
        runCatching { listState.animateScrollToItem(ui.messages.size) }
    }

    // 上拉到顶自动取更早一页：判定与轨迹视图共用（TrajectoryList.kt 的 LoadOlderOnReachTop），
    // 对话流这边只多一个"当前是不是对话视图"的条件。
    LoadOlderOnReachTop(
        listState = listState,
        enabled = ui.viewMode == SessionViewMode.CONVERSATION && ui.hasMoreOlder && !ui.loadingOlder,
        onLoadOlder = viewModel::loadOlder,
    )

    // 消费「回到最新」一次性信号：tick 每次点击 +1，首次组合时是 0（不该抢滚动）。
    LaunchedEffect(ui.scrollToNewestTick) {
        if (ui.scrollToNewestTick <= 0) return@LaunchedEffect
        val lastIndex = if (ui.viewMode == SessionViewMode.TRAJECTORY) ui.trajectory.size else ui.messages.size
        runCatching { listState.animateScrollToItem(lastIndex) }
    }

    // 消费「定位到第 N 轮」一次性信号：目标是一**条消息**的 seq，不是下标 ——
    // 下标会随分页窗口移动（取更早/贴底都会改），seq 在整个会话里稳定。
    // 第 0 项是「加载更早」入口，所以落点要 +1。
    LaunchedEffect(ui.scrollToSeq) {
        val target = ui.scrollToSeq ?: return@LaunchedEffect
        // 跳到某一轮 = 主动离开最新那条：把闸门打开，让贴底判定在动画停下后自己收敛，
        // 否则"用户正在往回看"与"界面以为仍在底部"会同时成立（右下角不出现「回到最新」）。
        userScrolled = true
        val index = ui.messages.indexOfFirst { it.seq == target }
        if (index >= 0) {
            runCatching { listState.animateScrollToItem(index + 1) }
            atBottom = false
        }
        viewModel.consumeScrollTarget()
    }

    // 定位结果的轻提示（已定位到第 N 轮 / 第 N 轮没有可显示的内容）：
    // 与 ui.message 那套分开，是因为它不是错误、也不需要常驻，展示完就消费。
    LaunchedEffect(ui.jumpNote) {
        val note = ui.jumpNote ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(note)
        viewModel.consumeJumpNote()
    }

    val conversationSelected = ui.viewMode == SessionViewMode.CONVERSATION
    // 轮次只认一个数：服务端 turns 与"已加载窗口里的用户消息条数"取大者。
    // 画稿里状态条写"第 13 轮"、末端芯片写"第 14 轮进行中"，两处对不上；
    // 同屏出现两个轮号只会让人怀疑哪个是真的，所以统一用它。
    val completedTurns = ui.session?.turns ?: 0
    val startedTurns = ui.trajectory.count { it.kind == TrajectoryKind.TURN }
    val totalTurns = maxOf(completedTurns, startedTurns)
    val running = ui.live || ui.sending
    val runningTool = ui.messages.lastOrNull()?.toolCalls?.lastOrNull { !it.hasResult }?.name
    val steps = (ui.session?.steps ?: 0).takeIf { it > 0 } ?: ui.trajectory.size
    val toolCalls = ui.trajectory.count { it.kind == TrajectoryKind.TOOL }
    // 用时按**已加载窗口**的首末时间戳算：服务端没有下发整段会话的耗时，
    // 窗口外的部分拿不到就不假装拿得到。
    val firstAt = ui.messages.firstOrNull { it.at > 0 }?.at
    val lastAt = ui.messages.lastOrNull { it.at > 0 }?.at
    val elapsedMs = when {
        firstAt == null -> 0L
        running -> (nowMs - firstAt).coerceAtLeast(0L)
        lastAt != null -> (lastAt - firstAt).coerceAtLeast(0L)
        else -> 0L
    }
    val visibleRows = if (kindFilter == TrajectoryFilter.All) {
        ui.trajectory
    } else {
        ui.trajectory.filter(kindFilter::matches)
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        containerColor = DetailBackground,
    ) { _ ->
        // 不用 Scaffold 的 innerPadding：它把顶部状态栏和底部手势条一起算进来，
        // 而本页的顶部是自绘顶栏、底部是输入区，两处的内边距语义不一样（见下面两处 padding）。
        Column(
            Modifier
                .fillMaxSize()
                .background(DetailBackground)
                .statusBarsPadding()
                .navigationBarsPadding(),
        ) {
            DetailTopBar(
                title = if (conversationSelected) ui.title.ifEmpty { "会话" } else "执行轨迹",
                subtitle = if (conversationSelected) {
                    conversationSubtitle(ui)
                } else {
                    trajectorySubtitle(ui, totalTurns, steps, toolCalls)
                },
                onBack = onBack,
                titleStyle = if (conversationSelected) type.detailTitle else type.screenTitle,
                // 画稿 02 的副标题是 10.5sp（tiny），画稿 03 的是 11sp（meta）
                subtitleStyle = if (conversationSelected) type.tiny else type.meta,
                subtitleColor = if (ui.offline) DshWarning else DshOnSurfaceVariant,
            ) {
                if (conversationSelected) {
                    // 轮次导航：桌面端在对话区右侧挂了「轮次导航」浮层，手机没有 hover，
                    // 所以入口放在顶栏、面板落到底部抽屉（见 TurnNavSheet）。
                    DshIconButton(
                        icon = Icons.Default.History,
                        contentDescription = "轮次导航",
                        onClick = viewModel::openTurnNav,
                    )
                    Spacer(Modifier.width(4.dp))
                    // 停止只在真能停的时候出现：不能停的会话挂一个"点了没反应"的按钮最伤信任
                    if (ui.inputEnabled && running) {
                        DetailStopButton(onClick = viewModel::requestStop)
                        Spacer(Modifier.width(4.dp))
                    }
                    Box {
                        DshIconButton(
                            icon = Icons.Default.MoreVert,
                            contentDescription = "更多",
                            onClick = { moreMenu = true },
                        )
                        DropdownMenu(expanded = moreMenu, onDismissRequest = { moreMenu = false }) {
                            // 刷新 / 回到最新 / 待办开关 / 示例文本：画稿把顶栏压到只剩两个按钮，
                            // 这些原来的入口收进「…」，功能一个不少。
                            DropdownMenuItem(
                                text = { MenuLabel("刷新") },
                                onClick = {
                                    moreMenu = false
                                    viewModel.refresh(force = true)
                                },
                            )
                            DropdownMenuItem(
                                text = { MenuLabel("回到最新") },
                                onClick = {
                                    moreMenu = false
                                    viewModel.scrollToNewest()
                                },
                            )
                            if (ui.todos.isNotEmpty()) {
                                DropdownMenuItem(
                                    text = { MenuLabel(if (showTodos) "隐藏待办" else "显示待办") },
                                    onClick = {
                                        moreMenu = false
                                        showTodos = !showTodos
                                    },
                                )
                            }
                            if (BuildConfig.DEBUG && ui.inputEnabled) {
                                // 模拟器没有中文输入法（BUILD.md §7.3）：示例文本必须能一键写入
                                DropdownMenuItem(
                                    text = { MenuLabel("填入示例") },
                                    onClick = {
                                        moreMenu = false
                                        viewModel.fillDemoPrompt()
                                    },
                                )
                            }
                        }
                    }
                } else {
                    Box {
                        DshIconButton(
                            icon = Icons.Default.FilterList,
                            contentDescription = "筛选",
                            onClick = { filterMenu = true },
                            // 实心 = 筛选生效中：画稿只有两个圆钮，状态只能挂在按钮自己身上
                            solid = kindFilter != TrajectoryFilter.All,
                        )
                        DropdownMenu(expanded = filterMenu, onDismissRequest = { filterMenu = false }) {
                            TrajectoryFilter.values().forEach { option ->
                                DropdownMenuItem(
                                    text = {
                                        MenuLabel(
                                            text = option.label,
                                            color = if (option == kindFilter) DshPrimary else DshOnBackground,
                                            bold = option == kindFilter,
                                        )
                                    },
                                    onClick = {
                                        kindFilter = option
                                        filterMenu = false
                                    },
                                )
                            }
                        }
                    }
                    DshIconButton(
                        icon = Icons.Default.Download,
                        contentDescription = "导出轨迹",
                        onClick = {
                            // 协议没有导出接口，落点是系统剪贴板：写文件会让用户以为存到电脑上了
                            copyToClipboard(context, trajectoryExportText(visibleRows, totalTurns))
                            scope.launch {
                                snackbarHostState.showSnackbar("已复制 ${visibleRows.size} 步轨迹到剪贴板")
                            }
                        },
                    )
                }
            }

            // 页签：两个方向都要能走通，所以对话页也保留这一行。
            // 画稿 02 里没有画它（画稿 03 有），但少了它「对话↔轨迹」就没有互达路径 ——
            // 那是功能缺失，不是风格差异。
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(start = dimens.pageMargin, bottom = 8.dp),
            ) {
                DetailTabRow(
                    conversationSelected = conversationSelected,
                    onSelectConversation = {
                        savedViewMode = SessionViewMode.CONVERSATION
                        viewModel.switchView(SessionViewMode.CONVERSATION)
                    },
                    onSelectTrajectory = {
                        savedViewMode = SessionViewMode.TRAJECTORY
                        viewModel.switchView(SessionViewMode.TRAJECTORY)
                    },
                )
            }

            // 实时状态条：只在对话页、且真的在跑时出现（画稿 02）。
            // 轨迹页由轮次芯片 + 进度条表达"现在到哪一步了"，再叠一条会挤掉一屏步骤。
            if (conversationSelected && running) {
                LiveRunBar(
                    label = if (totalTurns > 0) {
                        "正在执行第 $totalTurns 轮 · 已用 ${formatElapsed(elapsedMs)}"
                    } else {
                        "正在执行 · 已用 ${formatElapsed(elapsedMs)}"
                    },
                    chip = runningTool?.let { "工具 $it" },
                    modifier = Modifier.padding(start = dimens.pageMargin, end = dimens.pageMargin, bottom = dimens.gapNode),
                )
            }

            // 必须保留的几条说明（离线会进待发队列 / 只读原因 / 停止后不可继续 / 电脑端执行）：
            // 它们是行为语义，不是装饰，换成画稿的形状但文案一字不改。
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = dimens.pageMargin),
                verticalArrangement = Arrangement.spacedBy(dimens.gapNode),
            ) {
                if (ui.offline) {
                    DetailNoteRow(
                        text = "电脑离线：现在发送的内容会进入待发队列，隧道恢复后自动补发",
                        tone = DshWarning,
                        icon = Icons.Default.CloudOff,
                        modifier = Modifier.padding(bottom = dimens.gapNode),
                    )
                }
                ui.message?.takeIf { ui.isError }?.let { text ->
                    ErrorText(text, modifier = Modifier.padding(bottom = dimens.gapNode))
                }
                // 服务端说不可写时才拦（老网关的电脑端会话、被 abort 的手机任务）。
                // 这条必须在输入框之前，说明"为什么发不了"
                if (!ui.writable) {
                    DetailNoteRow(
                        text = ui.readOnlyReason,
                        tone = DshPrimary,
                        icon = Icons.Default.Info,
                        action = "去手机任务",
                        onAction = onGoPhoneTasks,
                        modifier = Modifier.padding(bottom = dimens.gapNode),
                    )
                } else if (!ui.resumable) {
                    // 手机会话：停止 = 杀进程（SDK 没有 cancel），会话作废，必须显式说出来。
                    // 电脑端会话：走到这里说明是网关重启/没接入，不是刚才那次停止造成的。
                    DetailNoteRow(
                        text = ui.nonResumableReason,
                        tone = DshError,
                        icon = Icons.Default.Warning,
                        action = "新建任务",
                        onAction = onGoPhoneTasks,
                        modifier = Modifier.padding(bottom = dimens.gapNode),
                    )
                }
                // 可续聊的电脑端会话：用户对"电脑"徽标的旧印象是只能看，
                // 得明确告诉他消息会落到**电脑上那段会话**里执行
                ui.livePeerNote?.let { note ->
                    DetailNoteRow(
                        text = note,
                        tone = DshPrimary,
                        icon = Icons.Default.Sync,
                        modifier = Modifier.padding(bottom = dimens.gapNode),
                    )
                }
            }

            // 内容区：FAB 叠在两种视图之上，因为"回到最新"对它们都成立
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (conversationSelected) {
                    if (ui.messages.isEmpty()) {
                        Box(Modifier.fillMaxSize().padding(dimens.pageMargin)) {
                            EmptyHint(
                                text = if (ui.loading) {
                                    "正在加载对话…"
                                } else {
                                    "这段会话还没有可显示的消息。\n可以直接在下面输入，续聊会写回 PC 上的同一个会话。"
                                },
                            )
                        }
                    } else {
                        LazyColumn(
                            state = listState,
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(
                                start = dimens.pageMargin,
                                end = dimens.pageMargin,
                                top = 6.dp,
                                bottom = 6.dp,
                            ),
                            // 画稿的对话节点间距：6dp（令牌 gapNode），不再是 14dp
                            verticalArrangement = Arrangement.spacedBy(dimens.gapNode),
                        ) {
                            // 第 0 项是「加载更早」入口：上拉到顶时它就是"上面还有"的唯一可见证据
                            item(key = "conversation-load-older") {
                                LoadOlderEntry(
                                    loadingOlder = ui.loadingOlder,
                                    hasMoreOlder = ui.hasMoreOlder,
                                    onLoadOlder = viewModel::loadOlder,
                                    noun = "消息",
                                )
                            }
                            // 不设 key：本地乐观插入的用户消息与服务端消息可能撞 seq，
                            // 重复 key 会让 LazyColumn 直接抛异常，这里用下标更稳。
                            itemsIndexed(ui.messages) { index, message ->
                                MessageItem(
                                    message = message,
                                    streaming = ui.streaming && index == ui.messages.lastIndex,
                                    expandedTools = ui.expandedTools,
                                    onToggleTool = viewModel::toggleTool,
                                    onOpenDeliverable = { deliverable ->
                                        val workspace = viewModel.deliverableWorkspace(deliverable)
                                        if (workspace != null) {
                                            onOpenFile(workspace, deliverable.path)
                                        } else {
                                            onOpenWorkspace(ui.session?.workspace.orEmpty())
                                        }
                                    },
                                    loader = ui.images,
                                    onOpenImage = openImage,
                                    // 轮次导航跳过来之后停在这一条上：高亮是"你跳到了这里"的锚点，
                                    // 它比"滚动位置"更明确（同一个位置上可能有好几条消息）
                                    highlighted = ui.highlightSeq != null && message.seq == ui.highlightSeq,
                                )
                            }
                            // 流末端芯片：它证明"这一轮还在跑"，而不是界面卡住了
                            if (running) {
                                item(key = "conversation-running-round") {
                                    RunningRoundChip(round = totalTurns.coerceAtLeast(1))
                                }
                            }
                        }
                    }
                } else {
                    Column(Modifier.fillMaxSize()) {
                        Spacer(Modifier.height(8.dp))
                        RoundProgressBar(
                            total = totalTurns,
                            current = totalTurns,
                            modifier = Modifier.padding(horizontal = dimens.pageMargin),
                        )
                        if (totalTurns > 0) {
                            Spacer(Modifier.height(6.dp))
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .padding(start = dimens.pageMargin),
                            ) {
                                RoundChip(round = totalTurns)
                            }
                        }
                        Spacer(Modifier.height(8.dp))
                        TrajectoryList(
                            rows = visibleRows,
                            modifier = Modifier.weight(1f),
                            listState = listState,
                            loadingOlder = ui.loadingOlder,
                            hasMoreOlder = ui.hasMoreOlder,
                            onLoadOlder = viewModel::loadOlder,
                            // 与对话流同一判定：本来就在底部才跟随，上翻历史时不抢滚动
                            autoFollow = atBottom,
                        )
                        TrajectorySummaryBar(
                            steps = steps.toString(),
                            toolCalls = toolCalls.toString(),
                            elapsed = formatElapsed(elapsedMs),
                            modifier = Modifier.padding(
                                start = dimens.pageMargin,
                                end = dimens.pageMargin,
                                top = 8.dp,
                                bottom = 8.dp,
                            ),
                        )
                    }
                }

                // 上翻历史后新消息不再把视图拽回底部，改由这个按钮显式"回到最新"：
                // 自动跟随与"能安静地往回看"二者只能选一个，这里把选择权交回用户
                if (!atBottom) {
                    SmallFloatingActionButton(
                        onClick = viewModel::scrollToNewest,
                        modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
                    ) {
                        Icon(Icons.Default.VerticalAlignBottom, contentDescription = "回到最新")
                    }
                }
            }

            if (conversationSelected) {
                // 待办固定在输入区上方：它是"这一轮要做什么"的清单，跟着对话流滚走就没人看了
                if (ui.todos.isNotEmpty() && showTodos) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .padding(start = dimens.pageMargin, end = dimens.pageMargin, bottom = 6.dp),
                    ) {
                        TodoListCard(todos = ui.todos)
                    }
                }
                DetailComposer(
                    ui = ui,
                    pendingApproval = pendingApproval,
                    onInputChange = viewModel::onInputChange,
                    onSend = viewModel::send,
                    onNotice = { message -> scope.launch { snackbarHostState.showSnackbar(message) } },
                    onPickGallery = { imagePicker.pickFromGallery() },
                    onTakePhoto = { imagePicker.takePhoto() },
                    onRemoveImage = viewModel::removeImage,
                    onApprovalPick = viewModel::selectOption,
                    onApprovalCustom = viewModel::setCustomAnswer,
                    onApprovalClear = viewModel::clearAnswer,
                    onApprovalSubmit = viewModel::submitAnswers,
                    onApprovalDecide = viewModel::decideApproval,
                    onApprovalAbstain = viewModel::abstainApproval,
                    now = viewModel.now(),
                )
            }
        }
    }

    // 停止 = 中止本轮：手机会话只能杀进程（SDK 协议没有 cancel），电脑端会话的 runtime 不受影响。
    // 后果按驱动方分岔，别把"电脑端中止"也写成"会话作废"。
    if (ui.showStopConfirm) {
        val desktopDriven = ui.session?.isDesktopDriven == true
        AlertDialog(
            onDismissRequest = viewModel::cancelStop,
            title = { Text("停止当前轮次？") },
            text = {
                Text(
                    if (desktopDriven) {
                        "停止会把这一轮从电脑端 runtime 上中止；**会话本身不受影响**，之后仍可继续聊。"
                    } else {
                        "SDK 协议没有 cancel：停止会终止该会话的进程，" +
                            "**停止后本会话无法继续**，需要到「手机任务」新建任务。"
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = viewModel::confirmStop) { Text("确认停止") }
            },
            dismissButton = {
                TextButton(onClick = viewModel::cancelStop) { Text("取消") }
            },
        )
    }

    // 轮次导航面板：只在对话页、且用户点开了入口时存在。
    // 用 UiState 里的开关（而不是界面自己的 bool）是因为"打开面板要顺带取一次轮次索引"
    // 属于状态层的事，界面只负责画。
    if (conversationSelected && ui.turnNavOpen) {
        TurnNavSheet(
            total = ui.turnCount,
            turns = ui.turnIndex?.turns.orEmpty(),
            loading = ui.turnIndexLoading,
            error = ui.turnIndexError,
            currentTurn = ui.activeTurn,
            onSelect = viewModel::jumpToTurn,
            onRefresh = { viewModel.loadTurnIndex(force = true) },
            onDismiss = viewModel::closeTurnNav,
        )
    }

    // 全屏看图：点缩略图打开，返回键/点图/右上角关闭
    if (viewerImages.isNotEmpty()) {
        ImageViewerDialog(
            images = viewerImages,
            startIndex = viewerIndex,
            loader = ui.images,
            onDismiss = { viewerImages = emptyList() },
        )
    }
}

/**
 * 输入区（画稿 02）：一行权限说明 + 34dp 全圆胶囊（占位文案 / 两个图标 / 圆形发送键）。
 *
 * 审批 / 提问待应答时**整格换成接管卡**（原型 README 的硬性交互语义）：它在等人做决定，
 * 必须落在用户视线和手指都会到的地方，不能做成一条会滚走的普通消息。
 *
 * 优先级：数据层来的 [SessionDetailViewModel.UiState.pendingApproval]（完整协议形态）>
 * 外部传入的 [PendingApprovalPrompt]（36dp 简条，截图夹具用）> 正常输入胶囊。
 */
@Composable
private fun DetailComposer(
    ui: SessionDetailViewModel.UiState,
    pendingApproval: PendingApprovalPrompt?,
    onInputChange: (String) -> Unit,
    onSend: () -> Unit,
    onNotice: (String) -> Unit,
    // 相册 / 拍照的入口把动作交给调用方（那里才有 ActivityResultLauncher），
    // 输入区本身不认识 Activity Result API —— 它只负责"点了哪个按钮"
    onPickGallery: () -> Unit,
    onTakePhoto: () -> Unit,
    onRemoveImage: (Int) -> Unit,
    onApprovalPick: (questionId: String, label: String) -> Unit,
    onApprovalCustom: (questionId: String, text: String) -> Unit,
    onApprovalClear: (questionId: String) -> Unit,
    onApprovalSubmit: () -> Unit,
    onApprovalDecide: (WireApprovals.Outcome) -> Unit,
    onApprovalAbstain: () -> Unit,
    // 倒计时文案用的"现在"。由调用方每次重组时取一次：刷新节奏由 VM 的 countdownTick 决定，
    // 界面自己起一个计时器会在息屏/后台时白耗电，而且和 VM 的节拍对不上
    now: Long,
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    Column(
        Modifier
            .fillMaxWidth()
            .background(DetailBackground)
            // 输入区必须抬到键盘之上；底部手势条的间距由根布局统一给，这里不再重复加
            .imePadding(),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(dimens.border)
                .background(ComposerDivider),
        )
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = dimens.pageMargin, vertical = 8.dp),
        ) {
            Text(
                // 接管时的说明行换成语义说明：这时"只读/不可续"那条已经不重要了，
                // 用户需要知道的是"我这一答会发生什么"
                text = ui.pendingApproval?.let { approvalComposerNote(it) } ?: composerNote(ui),
                style = type.meta,
                color = DshOnSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            // 收不到审批时的诊断条：没有它，真机上"电脑端没启动/凭据不可用"与
            // "确实没有待答"在界面上完全一样（都是一片安静），用户只会以为 App 坏了。
            //
            // 只在"这一轮真的可能被挂住"时才显示（见 [approvalRelevant]）：纯网关会话
            // 永远不会产生审批，在那里挂一条"连不上电脑端"只会让用户以为出了故障。
            if (ui.pendingApproval == null && approvalRelevant(ui) && ui.approvalBridge.needsAttention) {
                Spacer(Modifier.height(6.dp))
                BridgeNotice(
                    note = ui.approvalBridge.note,
                    hint = ui.approvalBridge.hint,
                )
            }
            Spacer(Modifier.height(6.dp))
            // 待发图片：在说明行与输入胶囊之间，按"图片 → 胶囊"的顺序读下来就是
            // "这条消息带什么 → 说什么"，而缩略图排在胶囊里面会把 34dp 的输入行撑高。
            //
            // 只在正常输入态显示：审批/提问接管时那两格是"必须马上做决定"的界面，
            // 往里塞一条图片行会让接管卡看起来像还能发消息。
            if (ui.pendingApproval == null && pendingApproval == null && ui.pendingImages.isNotEmpty()) {
                Text(
                    text = ui.imageSendNote,
                    style = type.meta,
                    color = DshPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(6.dp))
                ComposerImageRow(images = ui.pendingImages, onRemove = onRemoveImage)
                Spacer(Modifier.height(6.dp))
            }
            val entry = ui.pendingApproval
            when {
                entry != null -> ApprovalCard(
                    entry = entry,
                    drafts = ui.approvalDrafts,
                    plan = ui.approvalPlan,
                    remaining = WireApprovals.formatRemaining(entry.remainingMillis(now)),
                    submitting = ui.approvalSubmitting,
                    onPick = onApprovalPick,
                    onCustom = onApprovalCustom,
                    onClear = onApprovalClear,
                    onSubmit = onApprovalSubmit,
                    onDecide = onApprovalDecide,
                    onAbstain = onApprovalAbstain,
                )

                pendingApproval != null -> ApprovalStrip(prompt = pendingApproval)
                else -> ComposerCapsule {
                    BasicTextField(
                        value = ui.input,
                        onValueChange = onInputChange,
                        // 只读 / 已停止的会话：输入框直接置灰，而不是让用户打完字再被拒绝
                        enabled = ui.inputEnabled,
                        textStyle = type.body.copy(
                            color = if (ui.inputEnabled) DshOnBackground else DshNeutral,
                        ),
                        cursorBrush = SolidColor(DshPrimary),
                        // 多行输入是既有能力（老实现 maxLines=5），胶囊会随行数长高
                        maxLines = 4,
                        decorationBox = { inner ->
                            Box(contentAlignment = Alignment.CenterStart) {
                                if (ui.input.isEmpty()) {
                                    Text(
                                        text = composerPlaceholder(ui),
                                        style = type.body,
                                        color = DshOnSurfaceVariant,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                inner()
                            }
                        },
                        modifier = Modifier
                            .weight(1f)
                            .padding(vertical = 8.dp),
                    )
                    // 回形针 / 相机的真实能力边界（别把这两个按钮做成"点了没反应"）：
                    // 图片只能进**可写的电脑端会话**。网关侧 `POST /api/v2/sessions/{id}/turns`
                    // 在 `source === 'phone'` 的会话上根本不支持 image 块（那条路走 SDK，
                    // 只认 text），所以这里按会话类型分岔把原因说清楚，而不是等网关 400。
                    ComposerIcon(
                        icon = Icons.Default.AttachFile,
                        contentDescription = "从相册选图片",
                        onClick = if (ui.session?.isDesktopDriven == true) onPickGallery else {
                            { onNotice("这个会话不支持发送图片：图片只能发给电脑端会话") }
                        },
                    )
                    ComposerIcon(
                        icon = Icons.Default.PhotoCamera,
                        contentDescription = "拍照发送",
                        onClick = if (ui.session?.isDesktopDriven == true) onTakePhoto else {
                            { onNotice("这个会话不支持发送图片：图片只能发给电脑端会话") }
                        },
                    )
                    Spacer(Modifier.width(4.dp))
                    CircleSendButton(enabled = ui.canSend, onClick = onSend)
                }
            }
        }
    }
}

/** 菜单项文案：M3 默认 14sp 在本页偏大，统一回落到设计令牌的 13sp。 */
@Composable
private fun MenuLabel(
    text: String,
    color: androidx.compose.ui.graphics.Color = DshOnBackground,
    bold: Boolean = false,
) {
    Text(
        text = text,
        style = LocalDshType.current.body,
        color = color,
        fontWeight = if (bold) FontWeight.Bold else null,
        maxLines = 1,
    )
}

/**
 * 输入区上方的权限说明（画稿 02 那一行）。
 *
 * 措辞按会话**真实**的执行方与可写状态生成，而不是写死画稿里的档位：
 * - 电脑端会话：手机在请求里根本不带 `access`（见 data/api/TaskAccess.kt 的 `accessForHost`），
 *   权限由电脑端 DSH 自己的设置决定 —— 所以只能承诺"跟随电脑端"；
 * - 网关/手机任务：档位由网关按请求下发，`TaskAccess.DEFAULT` 就是默认档（workspace-write），
 *   这里显示默认档的名字，而不是编一个具体策略；
 * - 不可写 / 不可续：直接说结论，别让用户打完字才被拒。
 */
/**
 * 这个会话是否可能产生审批/提问（决定要不要轮询、要不要显示诊断条）。
 *
 * 判据是"这一轮会不会在电脑端被挂住"：电脑端驱动的会话、或者手机发起但落在电脑端执行的
 * 任务（`isPhoneTask`）。**不**用 `isComputerSession`（那是"数据在哪"）：一条纯网关
 * 执行的电脑端会话永远不会走 desktop 通道，对它轮询或报"连不上电脑端"都是误导。
 */
private fun approvalRelevant(ui: SessionDetailViewModel.UiState): Boolean =
    ui.session?.let { it.isDesktopDriven || it.isPhoneTask } == true

private fun composerNote(ui: SessionDetailViewModel.UiState): String = when {
    !ui.writable -> "只读会话 · 无法从手机发送消息"
    !ui.resumable -> "本会话已停止 · 无法继续发送"
    ui.session?.isDesktopDriven == true -> "发送到电脑端执行 · 权限跟随电脑端（workspace-write · ask）"
    else -> "发送到网关执行 · 权限按网关下发（${TaskAccess.DEFAULT.label}）"
}

private fun composerPlaceholder(ui: SessionDetailViewModel.UiState): String = when {
    !ui.writable -> "该会话当前只读，无法在手机上续聊"
    !ui.resumable -> "本会话已停止，无法继续；请新建任务"
    else -> "给这个会话发一条消息…"
}

/**
 * 接管输入区时的那行说明。
 *
 * 为什么必须换掉 [composerNote]：那一行讲的是"发出去的消息以什么权限执行"，
 * 而接管期间**根本没有消息要发**——用户需要知道的是"我这一答会发生什么"。
 * 两句话都刻意点明"谁先答谁赢"：提交成功不等于决定由手机做出。
 */
private fun approvalComposerNote(entry: WireApprovals.ApprovalEntry): String =
    if (entry.kind == WireApprovals.Kind.APPROVAL) {
        "这一轮已挂住 · 结论会立刻回给电脑端；电脑端先答过的话这里会消失"
    } else {
        "这一轮已挂住 · 答完点「提交回答」；没答的问题会被跳过"
    }

/**
 * 对话页副标题（画稿 02 的「dsh_android · ⑂ main +3 −1」那一行的等价物）。
 *
 * 画稿的分支名/增删行数来自 git 域，本 App 没有这条数据；这里换成同等密度的
 * 会话事实：工作区、已加载/总数、改动数、驱动方、运行中、离线。
 * 旧的顶部副标题信息一条不丢，只是压成一行。
 */
private fun conversationSubtitle(ui: SessionDetailViewModel.UiState): String = buildString {
    append(ui.session?.workspaceLabel?.takeIf { it.isNotEmpty() } ?: "会话")
    // 分页之后"消息条数"不再等于"会话总条数"：必须说清已加载多少，
    // 否则用户会以为这段会话只有 60 条
    if (ui.totalCount > 0) {
        append(" · 已加载 ${ui.loadedCount}/${ui.totalCount} 条")
    } else {
        // 老网关不给 total（退化成一次全量）：退回原来的说法
        append(" · ${ui.messages.size} 条消息")
    }
    val session = ui.session
    if (session != null && session.hasChanges) append(" · ${session.changeCount} 处改动")
    if (ui.writable && session?.isComputerSession == true) {
        append(" · ${session.driverLabel}")
        // 手机发起、落在电脑端执行的任务：把"谁发起"也说出来，
        // 否则用户在电脑会话里看到「电脑驱动」会以为是电脑上开的
        if (session.isPhoneTask) append(" · ${session.createdByLabel}")
    }
    if (ui.live) append(" · 运行中")
    if (ui.offline) append(" · 电脑离线")
}

/** 轨迹页副标题（画稿 03 的「第 12–13 轮 · 共 47 步 · 6 次工具调用」）。 */
private fun trajectorySubtitle(
    ui: SessionDetailViewModel.UiState,
    totalTurns: Int,
    steps: Int,
    toolCalls: Int,
): String {
    val loadedTurns = ui.trajectory.count { it.kind == TrajectoryKind.TURN }
    val range = when {
        totalTurns <= 0 -> "暂无轮次"
        totalTurns == 1 -> "第 1 轮"
        // 已加载窗口覆盖了整段会话才敢写"第 1–N 轮"，否则只能写"最近 N 轮"
        loadedTurns >= totalTurns -> "第 1–$totalTurns 轮"
        else -> "最近 ${loadedTurns.coerceAtLeast(1)} 轮（共 $totalTurns 轮）"
    }
    return "$range · 共 $steps 步 · $toolCalls 次工具调用"
}

/** 导出的文本形态：一行一步，够贴进 issue / 聊天窗口核对。 */
private fun trajectoryExportText(rows: List<TrajectoryRow>, totalTurns: Int): String = buildString {
    appendLine("DSH 执行轨迹 · 共 $totalTurns 轮 · ${rows.size} 步")
    rows.forEach { row ->
        append("[${row.kind}] ${row.title}")
        if (row.detail.isNotEmpty()) append(" · ${row.detail}")
        appendLine()
    }
}

/**
 * 导出落点：系统剪贴板。
 *
 * 为什么不写文件：网关没有导出接口，本地存一份会让用户以为"已经存到电脑上了"，
 * 而剪贴板是明确落在手机上的、用户马上能验证的落点。
 */
private fun copyToClipboard(context: Context, text: String) {
    val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    manager.setPrimaryClip(ClipData.newPlainText("DSH 执行轨迹", text))
}

/** logcat 标签：分页/贴底判定的诊断读数（只在 DEBUG 包输出，见 [isNearBottom] 调用点）。 */
private const val Tag = "DshPaging"

/**
 * logcat 标签：一次性提示（snackbar）的触发与消费读数，只在 DEBUG 包输出。
 *
 * 单独一个标签是为了让"提示反复弹"这类缺陷下次能**直接从日志判定**：
 * 每次 effect 触发打一行 `snackbar-effect fire: <文案>`，展示完打一行 `consumed=`。
 * 修复前同一条文案会在每次进页面/切页签时重复 fire；修复后只该出现一次。
 */
private const val TagSnackbar = "DshSnackbar"

/**
 * 是否"本来就在底部"（合同 §4.3.3 的判定）。
 *
 * 判据是**最后一项还在视口里** —— 这就是"到底"的定义。
 * 旧实现用的是"首可见项落在最后三项里"（`lastIndex - firstVisibleIndex <= 2`），
 * 它在长条目下会误判：真机实测首屏贴底时首可见项下标 58、按旧判据算出"在底部"，
 * 但因为上一项有几像素被算进可见集合，实际状态是"用户翻走了"，右下角一直挂着「回到最新」。
 * 换成"末项可见"后，两种读法（首可见项其实是 57 还是 58）都会得到正确的"在底部"。
 */
private fun LazyListState.isNearBottom(): Boolean {
    val info = layoutInfo
    // 空列表：谈不上"往上翻过"，按贴底处理（首屏加载中 FAB 不该闪）
    if (info.totalItemsCount == 0) return true
    return info.visibleItemsInfo.lastOrNull()?.index == info.totalItemsCount - 1
}

/**
 * 对话流里的一个节点。
 *
 * 用户气泡与助手正文**不再套外层卡片**（画稿 02：气泡自己有容器，正文直接贴在黑底上）；
 * 系统消息保留自己的小卡，因为它是"运行时快照"，与模型输出不是一类东西。
 *
 * [highlighted] 是"轮次导航跳到了这一条"的落点标记：只加一层极淡的品牌底 + 细描边，
 * 不做自动淡出动画 —— 淡出之后用户就再也找不到自己跳到哪了。
 */
@Composable
private fun MessageItem(
    message: ChatMessage,
    streaming: Boolean,
    expandedTools: Set<String>,
    onToggleTool: (String) -> Unit,
    onOpenDeliverable: (Deliverable) -> Unit,
    loader: ImageLoader = ImageLoader.None,
    onOpenImage: (List<ImageRef>, Int) -> Unit = { _, _ -> },
    highlighted: Boolean = false,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .then(
                if (highlighted) {
                    Modifier
                        .background(DshPrimary.copy(alpha = 0.08f), RoundedCornerShape(DshRadius.Sub))
                        .border(0.5.dp, DshPrimary.copy(alpha = 0.55f), RoundedCornerShape(DshRadius.Sub))
                        .padding(vertical = 4.dp)
                } else {
                    Modifier
                },
            ),
    ) {
        when {
            message.isUser -> UserBubble(
                text = message.text,
                at = message.at,
                images = message.images,
                loader = loader,
                onOpenImage = onOpenImage,
            )

            message.role == "system" -> DshCard(containerColor = DshSurfaceVariant) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                    Text(
                        text = "系统",
                        style = LocalDshType.current.meta.copy(fontWeight = FontWeight.Bold),
                        color = DshOnSurfaceVariant,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = message.text,
                        style = LocalDshType.current.body,
                        color = DshOnBackground,
                    )
                }
            }

            else -> AssistantMessage(
                message = message,
                expandedTools = expandedTools,
                onToggleTool = onToggleTool,
                onOpenDeliverable = onOpenDeliverable,
                streaming = streaming,
                loader = loader,
                onOpenImage = onOpenImage,
            )
        }
    }
}

