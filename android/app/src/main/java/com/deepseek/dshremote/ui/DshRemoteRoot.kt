package com.deepseek.dshremote.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.deepseek.dshremote.Graph
import com.deepseek.dshremote.service.SseForegroundService

private const val SCREEN_AUTO = "auto"
private const val SCREEN_SPLASH = "splash"
private const val SCREEN_SETUP = "setup"
private const val SCREEN_HOME = "home"
private const val SCREEN_HISTORY = "history"
private const val PREFIX_DETAIL = "detail/"

/**
 * 应用导航根节点。
 *
 * 用状态机而不是 navigation-compose：页面只有 4 个、且"是否已配置"本身就是路由条件
 * （未配置一律进配置页），状态机比一整套 NavHost + 参数序列化更好读、更好测。
 */
@Composable
fun DshRemoteRoot(onRequestNotificationPermission: () -> Unit) {
    val repository = Graph.repository
    val settings by repository.settings.collectAsStateWithLifecycle()
    val ready by repository.ready.collectAsStateWithLifecycle()
    val context = LocalContext.current

    // AUTO = 首次启动按"是否已配置"决定；其余值为用户显式导航结果
    var screen by rememberSaveable { mutableStateOf(SCREEN_AUTO) }
    var backTarget by rememberSaveable { mutableStateOf(SCREEN_HOME) }

    val resolved: String = when {
        !ready -> SCREEN_SPLASH
        // 未配置服务器：直接进配置页，且不发起任何网络请求
        settings == null -> SCREEN_SETUP
        screen == SCREEN_AUTO -> SCREEN_HOME
        else -> screen
    }

    // 已配置：拉起前台服务保活 SSE，并顺带申请通知权限（拒绝也能正常用）
    LaunchedEffect(ready, settings?.baseUrl, settings?.token) {
        if (!ready) return@LaunchedEffect
        if (settings != null) {
            onRequestNotificationPermission()
            SseForegroundService.start(context)
        } else {
            SseForegroundService.stop(context)
        }
    }

    val canGoBack = resolved == SCREEN_HISTORY || resolved.startsWith(PREFIX_DETAIL) || resolved == SCREEN_SETUP
    BackHandler(enabled = canGoBack) {
        screen = backTarget
    }

    when {
        resolved == SCREEN_SPLASH -> SplashScreen()

        resolved == SCREEN_SETUP -> SetupScreen(
            onDone = {
                backTarget = SCREEN_HOME
                screen = SCREEN_HOME
            },
            // 已配置过才给返回入口；首次安装时配置页是流程起点，没有可返回的页面
            onBack = if (settings != null) {
                {
                    screen = SCREEN_HOME
                }
            } else {
                null
            },
        )

        resolved == SCREEN_HOME -> HomeScreen(
            onOpenDetail = { taskId ->
                backTarget = SCREEN_HOME
                screen = PREFIX_DETAIL + taskId
            },
            onOpenHistory = {
                backTarget = SCREEN_HOME
                screen = SCREEN_HISTORY
            },
            onOpenSetup = {
                backTarget = SCREEN_HOME
                screen = SCREEN_SETUP
            },
        )

        resolved == SCREEN_HISTORY -> HistoryScreen(
            onBack = { screen = SCREEN_HOME },
            onOpenDetail = { taskId ->
                backTarget = SCREEN_HISTORY
                screen = PREFIX_DETAIL + taskId
            },
        )

        resolved.startsWith(PREFIX_DETAIL) -> TaskDetailScreen(
            taskId = resolved.removePrefix(PREFIX_DETAIL),
            onBack = { screen = backTarget },
        )

        else -> SplashScreen()
    }
}

/** 读取本地配置期间的占位页：避免"配置页闪一下再进首页"的跳变。 */
@Composable
private fun SplashScreen() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}
