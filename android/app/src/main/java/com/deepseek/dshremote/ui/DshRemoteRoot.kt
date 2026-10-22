package com.deepseek.dshremote.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Scaffold
import com.deepseek.dshremote.ui.components.DshSnackbarHost
import com.deepseek.dshremote.ui.components.DshSnackbarState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.deepseek.dshremote.Graph
import com.deepseek.dshremote.service.RelayForegroundService
import com.deepseek.dshremote.ui.components.DshNavBar
import com.deepseek.dshremote.ui.components.DshNavItem
import com.deepseek.dshremote.ui.screens.ComputerSessionsScreen
import com.deepseek.dshremote.ui.screens.DiffScreen
import com.deepseek.dshremote.ui.screens.FileViewerScreen
import com.deepseek.dshremote.ui.screens.NewTaskScreen
import com.deepseek.dshremote.ui.screens.PairingScreen
import com.deepseek.dshremote.ui.screens.PhoneTasksScreen
import com.deepseek.dshremote.ui.screens.SessionDetailScreen
import com.deepseek.dshremote.ui.screens.SettingsScreen
import com.deepseek.dshremote.ui.screens.WorkspaceScreen
import com.deepseek.dshremote.ui.theme.DshPrimary
import com.deepseek.dshremote.ui.theme.DshRemoteTheme

private const val ROUTE_MAIN = "main"
private const val PREFIX_SESSION = "session|"
private const val PREFIX_FILE = "file|"
private const val PREFIX_DIFF = "diff|"

/**
 * 「新建任务」是**独立路由**而不是弹窗（用户需求：新建任务要直接进对话界面）。
 *
 * 不带参数：工作区/权限/模型都放在这一屏里现选，创建成功后由这一屏自己跳到 `session|<id>`。
 */
private const val ROUTE_NEW_TASK = "newtask"

private const val TAB_COMPUTER = 0
private const val TAB_PHONE = 1
private const val TAB_WORKSPACE = 2
private const val TAB_SETTINGS = 3

/**
 * 应用导航根节点。
 *
 * 仍然是手写状态机（不引入 navigation-compose）：只有 4 个平级 Tab + 3 类详情页，
 * 且"是否已配对"本身就是路由条件；状态机比 NavHost + 参数序列化更好读、更好测。
 *
 * 主题也在这里应用：浅色是设置里的**可选降级**，默认（也是唯一默认）是深色。
 */
@Composable
fun DshRemoteRoot(onRequestNotificationPermission: () -> Unit) {
    val repository = Graph.repository
    val ready by repository.ready.collectAsStateWithLifecycle()
    val settings by repository.settings.collectAsStateWithLifecycle()
    val notice by repository.notice.collectAsStateWithLifecycle()
    val context = LocalContext.current

    var tab by rememberSaveable { mutableStateOf(TAB_COMPUTER) }
    var route by rememberSaveable { mutableStateOf(ROUTE_MAIN) }
    var workspaceHint by rememberSaveable { mutableStateOf<String?>(null) }

    // 已配对：拉起前台服务维持中继隧道（通知显示连接状态），并顺带申请通知权限
    LaunchedEffect(ready, settings?.deviceToken) {
        if (!ready) return@LaunchedEffect
        if (settings != null) {
            onRequestNotificationPermission()
            RelayForegroundService.start(context)
        } else {
            RelayForegroundService.stop(context)
        }
    }

    DshRemoteTheme(darkTheme = settings?.lightTheme != true) {
        when {
            !ready -> SplashScreen()

            settings == null -> PairingScreen(onPaired = { route = ROUTE_MAIN })

            else -> Shell(
                tab = tab,
                onSelectTab = { selected ->
                    // 点底栏 = 回主路由并切 Tab：从详情页"退出"到 Tab 是同一个动作，
                    // 不额外记"来源 Tab"，否则返回栈会出现两套（路由 + Tab）。
                    tab = selected
                    route = ROUTE_MAIN
                },
                notice = notice,
                onNoticeDismissed = repository::consumeNotice,
            ) { padding ->
                Box(Modifier.fillMaxSize().padding(padding)) {
                    when {
                        route.startsWith(PREFIX_SESSION) -> {
                            val sessionId = route.removePrefix(PREFIX_SESSION)
                            SessionDetailScreen(
                                sessionId = sessionId,
                                onBack = { route = ROUTE_MAIN },
                                onOpenFile = { workspace, path -> route = PREFIX_FILE + workspace + "|" + path },
                                onOpenWorkspace = { workspace ->
                                    workspaceHint = workspace
                                    tab = TAB_WORKSPACE
                                    route = ROUTE_MAIN
                                },
                                onGoPhoneTasks = {
                                    tab = TAB_PHONE
                                    route = ROUTE_MAIN
                                },
                            )
                        }

                        route.startsWith(PREFIX_FILE) -> {
                            val parts = route.removePrefix(PREFIX_FILE).split('|', limit = 2)
                            val workspace = parts.getOrNull(0).orEmpty()
                            val path = parts.getOrNull(1).orEmpty()
                            FileViewerScreen(workspace = workspace, path = path, onBack = { route = ROUTE_MAIN })
                        }

                        route.startsWith(PREFIX_DIFF) -> {
                            val parts = route.removePrefix(PREFIX_DIFF).split('|', limit = 2)
                            val workspace = parts.getOrNull(0).orEmpty()
                            val file = parts.getOrNull(1).orEmpty()
                            DiffScreen(
                                workspace = workspace,
                                file = file,
                                onBack = { route = ROUTE_MAIN },
                                onOpenFile = { route = PREFIX_FILE + workspace + "|" + file },
                            )
                        }

                        route == ROUTE_NEW_TASK -> {
                            NewTaskScreen(
                                onBack = { route = ROUTE_MAIN },
                                onOpenSession = { id -> route = PREFIX_SESSION + id },
                            )
                        }

                        else -> TabContent(
                            tab = tab,
                            workspaceHint = workspaceHint,
                            onOpenSession = { id -> route = PREFIX_SESSION + id },
                            onOpenFile = { workspace, path -> route = PREFIX_FILE + workspace + "|" + path },
                            onOpenDiff = { workspace, file -> route = PREFIX_DIFF + workspace + "|" + file },
                            onOpenNewTask = { route = ROUTE_NEW_TASK },
                        )
                    }
                }
            }
        }
    }

    BackHandler(enabled = route != ROUTE_MAIN) { route = ROUTE_MAIN }
}

/**
 * 常驻外壳：**所有路由**（4 个 Tab + 会话详情 + 文件 + diff）都带同一条底栏。
 *
 * 为什么把 `Scaffold` 提到最外层：画稿 01–06 每一屏底部都是同一条 62dp 底栏，
 * 详情页只是"在底栏之上换了一层内容"；把底栏留在 Tab 外壳里的话，进详情页底栏会消失，
 * 手机端就失去了唯一的全局导航（返回键只能一路退回）。
 *
 * snackbar 仍然走 M3（它是浮层，不参与栅格）。
 */
@Composable
private fun Shell(
    tab: Int,
    onSelectTab: (Int) -> Unit,
    notice: String?,
    onNoticeDismissed: () -> Unit,
    content: @Composable (PaddingValues) -> Unit,
) {
    val snackbarHostState = remember { DshSnackbarState() }
    LaunchedEffect(notice) {
        notice?.let {
            snackbarHostState.showMessage(it)
            onNoticeDismissed()
        }
    }

    Scaffold(
        snackbarHost = { DshSnackbarHost(snackbarHostState) },
        bottomBar = {
            // 契约 §7.3：两类会话分开呈现 —— 电脑会话只读镜像 / 手机任务可续聊
            DshNavBar(
                items = NavItems,
                selectedIndex = tab,
                onSelect = onSelectTab,
            )
        },
        content = content,
    )
}

/** 4 个平级 Tab 的内容区（底栏由 [Shell] 提供）。 */
@Composable
private fun TabContent(
    tab: Int,
    workspaceHint: String?,
    onOpenSession: (String) -> Unit,
    onOpenFile: (String, String) -> Unit,
    onOpenDiff: (String, String) -> Unit,
    onOpenNewTask: () -> Unit,
) {
    when (tab) {
        TAB_PHONE -> PhoneTasksScreen(onOpenSession = onOpenSession, onCreateTask = onOpenNewTask)

        TAB_WORKSPACE -> WorkspaceScreen(
            workspaceHint = workspaceHint,
            onOpenFile = { workspace, path -> onOpenFile(workspace, path) },
            onOpenDiff = { workspace, file -> onOpenDiff(workspace, file) },
        )

        TAB_SETTINGS -> SettingsScreen()

        // 电脑会话页的 FAB 也走同一个「新建任务」页：新建任务缺省就落在电脑端，
        // 两处入口共用一条链路，省得两个入口的默认行为慢慢漂开。
        else -> ComputerSessionsScreen(onOpenSession = onOpenSession, onCreateTask = onOpenNewTask)
    }
}

/** 底栏四项。顺序即语义：电脑会话（只读）→ 手机任务（可续聊）→ 工作区 → 设置。 */
private val NavItems = listOf(
    DshNavItem("电脑会话", Icons.Default.Computer),
    DshNavItem("手机任务", Icons.AutoMirrored.Filled.Chat),
    DshNavItem("工作区", Icons.Default.AccountTree),
    DshNavItem("设置", Icons.Default.Settings),
)

/** 读取本地配置期间的占位页：避免"配对页闪一下再进主界面"的跳变。 */
@Composable
private fun SplashScreen() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(color = DshPrimary, strokeWidth = 2.dp, modifier = Modifier.size(28.dp))
    }
}
