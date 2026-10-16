package com.deepseek.dshremote.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.deepseek.dshremote.BuildConfig
import com.deepseek.dshremote.Graph
import com.deepseek.dshremote.ui.components.CleartextWarningCard
import com.deepseek.dshremote.ui.components.DshButton
import com.deepseek.dshremote.ui.components.DshCard
import com.deepseek.dshremote.ui.components.DshInputField
import com.deepseek.dshremote.ui.components.DshPageContainer
import com.deepseek.dshremote.ui.components.DshPageHeader
import com.deepseek.dshremote.ui.components.RelayStatusBar
import com.deepseek.dshremote.ui.theme.DshBackground
import com.deepseek.dshremote.ui.theme.DshNeutral
import com.deepseek.dshremote.ui.theme.DshOnBackground
import com.deepseek.dshremote.ui.theme.DshOnSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshPrimary
import com.deepseek.dshremote.ui.theme.DshRadius
import com.deepseek.dshremote.ui.theme.DshSurfaceVariant
import com.deepseek.dshremote.ui.theme.LocalDshType
import com.deepseek.dshremote.ui.vm.SettingsViewModel
import com.deepseek.dshremote.ui.vm.appViewModel

/**
 * 配对页（画稿未覆盖，按同一套令牌与栅格推导）：
 * 页边距 20dp、页头 22sp、大号等宽配对码、二维码卡 16dp 圆角、主按钮 34dp 实心主色。
 *
 * 功能与原实现一致：三个输入（中继地址 / 设备名 / 6 位配对码）、配对并连接、重新配对、
 * 探测中继、配对成功后回调 [onPaired]。页面自身不发任何网络请求，全部交给 ViewModel。
 */
@Composable
fun PairingScreen(onPaired: () -> Unit) {
    val viewModel = appViewModel { SettingsViewModel(Graph.repository, Graph.appContext) }
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val relayState by viewModel.relayState.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val focusManager = LocalFocusManager.current

    // 展示完就消费掉：message 不清空的话，每次回到本页都会用没变的 key 重跑一遍，同一条反复弹。
    // 只消费非错误提示，错误原因要留在屏幕上（判据与完整理由见 MessageConsumption.kt）。
    // 注意本页与设置页共用同一个 SettingsViewModel 实例，消费对两页同时生效。
    LaunchedEffect(ui.message) {
        val shown = ui.message ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(shown)
        if (shouldConsumeSnackbarMessage(ui.message, ui.isError)) viewModel.consumeMessage()
    }
    LaunchedEffect(ui.paired) {
        if (ui.paired) onPaired()
    }

    Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(DshBackground)
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(bottom = 28.dp),
        ) {
            DshPageHeader(title = "配对")

            DshPageContainer {
                // 产品定位一句讲清：这个 App 不是"手机连 PC"，两边都只连中继
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .size(44.dp)
                            .clip(RoundedCornerShape(DshRadius.Sub))
                            .background(DshPrimary.copy(alpha = 0.18f)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = Icons.Default.PhoneAndroid,
                            contentDescription = null,
                            tint = DshPrimary,
                            modifier = Modifier.size(22.dp),
                        )
                    }
                    Spacer(Modifier.width(12.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("DSH 远程控制台", style = LocalDshType.current.emphasis, color = DshOnBackground)
                        Text(
                            text = "手机只连中继，PC 只出站连接；任何网络下都能用",
                            style = LocalDshType.current.bodyLoose,
                            color = DshOnSurfaceVariant,
                        )
                    }
                }
            }
            Spacer(Modifier.height(14.dp))

            DshPageContainer { RelayStatusBar(state = relayState) }
            Spacer(Modifier.height(14.dp))

            StepCard()
            if (ui.isCleartext) {
                Spacer(Modifier.height(14.dp))
                DshPageContainer { CleartextWarningCard() }
            }
            Spacer(Modifier.height(18.dp))

            // ── 配对码（本页主角）──────────────────────────────────
            Section("配对码")
            DshPageContainer {
                DshInputField(
                    value = ui.code,
                    onValueChange = viewModel::onCodeChange,
                    placeholder = "482913",
                    height = 58.dp,
                    mono = true,
                    enabled = !ui.busy,
                    // 24sp 等宽 + 4sp 字距：6 位码要能隔着桌子一眼读出来
                    style = LocalDshType.current.monoBody.copy(
                        fontSize = 24.sp,
                        lineHeight = 30.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 4.sp,
                    ),
                    textAlign = TextAlign.Center,
                    keyboardType = KeyboardType.NumberPassword,
                    imeAction = ImeAction.Done,
                    onImeAction = {
                        focusManager.clearFocus()
                        viewModel.pair()
                    },
                )
            }
            Spacer(Modifier.height(8.dp))
            Caption("在 PC 上执行 scripts\\relay-pair.ps1 生成，一次性、5 分钟有效")
            Spacer(Modifier.height(14.dp))

            DshPageContainer {
                DshCard(radius = DshRadius.Card, containerColor = DshSurfaceVariant) {
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        QrPanel(text = ui.relayUrl + ui.code)
                        Text(
                            text = "配对二维码（离线示意，内容为当前中继地址与配对码的占位图案）",
                            style = LocalDshType.current.meta,
                            color = DshNeutral,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }
            Spacer(Modifier.height(18.dp))

            // ── 中继与设备 ────────────────────────────────────────
            Section("中继与设备")
            DshPageContainer {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    FieldLabel("中继地址")
                    DshInputField(
                        value = ui.relayUrl,
                        onValueChange = viewModel::onRelayUrlChange,
                        placeholder = "ws://10.0.2.2:9443 或 wss://relay.example.com",
                        keyboardType = KeyboardType.Uri,
                        imeAction = ImeAction.Next,
                        enabled = !ui.busy,
                    )
                    Caption("开发期用 ws://（明文，会有风险提示）；生产用 wss://")
                    FieldLabel("设备名（PC 端识别用）")
                    DshInputField(
                        value = ui.deviceName,
                        onValueChange = viewModel::onDeviceNameChange,
                        placeholder = "例如 Pixel 8",
                        enabled = !ui.busy,
                    )
                }
            }
            Spacer(Modifier.height(16.dp))

            DshPageContainer {
                DshButton(
                    text = if (ui.busy) "配对中…" else "配对并连接",
                    onClick = {
                        focusManager.clearFocus()
                        viewModel.pair()
                    },
                    enabled = ui.canPair,
                    solid = true,
                    height = 34.dp,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Spacer(Modifier.height(8.dp))
            DshPageContainer {
                DshButton(
                    text = "探测中继",
                    onClick = viewModel::probeRelay,
                    enabled = !ui.busy,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            if (ui.busy) {
                Spacer(Modifier.height(12.dp))
                DshPageContainer {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = DshPrimary)
                        Text("正在与中继通信…", style = LocalDshType.current.meta, color = DshOnSurfaceVariant)
                    }
                }
            }

            ui.message?.let { text ->
                Spacer(Modifier.height(12.dp))
                DshPageContainer {
                    DshCard(
                        radius = DshRadius.Sub,
                        containerColor = if (ui.isError) {
                            com.deepseek.dshremote.ui.theme.DshError.copy(alpha = 0.14f)
                        } else {
                            DshPrimary.copy(alpha = 0.14f)
                        },
                        borderColor = if (ui.isError) {
                            com.deepseek.dshremote.ui.theme.DshError.copy(alpha = 0.35f)
                        } else {
                            DshPrimary.copy(alpha = 0.35f)
                        },
                    ) {
                        Text(
                            text = text,
                            style = LocalDshType.current.bodyLoose,
                            color = if (ui.isError) com.deepseek.dshremote.ui.theme.DshError else DshPrimary,
                            modifier = Modifier.fillMaxWidth().padding(12.dp),
                        )
                    }
                }
            }

            ui.relayHealth?.let { health ->
                Spacer(Modifier.height(12.dp))
                DshPageContainer {
                    DshCard(radius = DshRadius.Sub, containerColor = DshSurfaceVariant) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("中继：${health.relayName}", style = LocalDshType.current.bodyLoose, color = DshOnBackground)
                            Text(
                                text = "版本 ${health.relayVersion} · API v${health.apiVersion} · " +
                                    "PC ${health.homes} 台 · 设备 ${health.devices}",
                                style = LocalDshType.current.meta,
                                color = DshOnSurfaceVariant,
                            )
                        }
                    }
                }
            }

            if (BuildConfig.DEBUG) {
                Spacer(Modifier.height(12.dp))
                DshPageContainer {
                    // 仅 debug：模拟器没有中文/复杂输入，自动化需要用应用内按钮写入示例值
                    DshButton("填入示例（debug）", viewModel::fillDemo, modifier = Modifier.fillMaxWidth())
                }
            }
        }
    }
}

/** 分组小标题：与设置页同规格（左 24dp、11sp bold），保证两页节奏一致。 */
@Composable
private fun Section(text: String) {
    Text(
        text = text,
        style = LocalDshType.current.meta.copy(fontWeight = FontWeight.Bold),
        color = DshOnSurfaceVariant,
        modifier = Modifier.padding(start = 24.dp, bottom = 8.dp),
    )
}

/** 输入框上方的小标签。 */
@Composable
private fun FieldLabel(text: String) {
    Text(
        text = text,
        style = LocalDshType.current.meta.copy(fontWeight = FontWeight.Bold),
        color = DshOnSurfaceVariant,
    )
}

/** 说明文字：与卡内文字对齐（页边距 + 14dp）。 */
@Composable
private fun Caption(text: String) {
    Text(
        text = text,
        style = LocalDshType.current.meta,
        color = DshNeutral,
        modifier = Modifier.fillMaxWidth().padding(start = 34.dp, end = 20.dp),
    )
}

/** 「怎么配对」三步卡：把 PC 侧脚本名写全，省掉来回翻文档。 */
@Composable
private fun StepCard() {
    DshPageContainer {
        DshCard(radius = DshRadius.Sub, containerColor = DshSurfaceVariant) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("怎么配对", style = LocalDshType.current.meta.copy(fontWeight = FontWeight.Bold), color = DshOnSurfaceVariant)
                Text(
                    text = "1. PC 上启动中继与网关：scripts\\start-relay.ps1 / scripts\\start-gateway.ps1\n" +
                        "2. PC 上生成配对码：scripts\\relay-pair.ps1（一次性，5 分钟有效）\n" +
                        "3. 把中继地址与 6 位码填到下面，点「配对」",
                    style = LocalDshType.current.bodyLoose,
                    color = DshOnBackground,
                )
            }
        }
    }
}

/**
 * 二维码占位面板。
 *
 * 真码需要中继侧下发的配对 URI，当前契约里没有这个字段（不硬造数据），所以这里只画一个
 * 由中继地址+配对码派生的确定性图案（同一输入永远同一图案）+ 三个定位角，视觉上就是二维码卡。
 * 它不可被扫描，页面上的说明文字已明确标注为"离线示意"。
 */
@Composable
private fun QrPanel(text: String, modifier: Modifier = Modifier) {
    val grid = 21
    val side = 168.dp
    val modules = remember(text) {
        val cells = BooleanArray(grid * grid)
        fun finder(ox: Int, oy: Int) {
            for (y in 0 until 7) {
                for (x in 0 until 7) {
                    val edge = x == 0 || y == 0 || x == 6 || y == 6
                    val core = x in 2..4 && y in 2..4
                    if (edge || core) cells[(oy + y) * grid + ox + x] = true
                }
            }
        }
        finder(0, 0)
        finder(grid - 7, 0)
        finder(0, grid - 7)
        var state = text.hashCode()
        for (i in 0 until grid * grid) {
            state = state * 1103515245 + 12345
            val x = i % grid
            val y = i / grid
            val inFinder = (x < 8 && y < 8) || (x >= grid - 8 && y < 8) || (x < 8 && y >= grid - 8)
            val inLabel = x in 8..12 && y in 8..12 // 中心留给 logo 方块
            if (!inFinder && !inLabel && ((state ushr 16) and 1) == 1) cells[i] = true
        }
        cells
    }
    Box(
        modifier = modifier
            .size(side)
            .clip(RoundedCornerShape(8.dp))
            // 扫码需要真实反差，深色界面里二维码底色必须是白
            .background(Color.White)
            .padding(12.dp),
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val cell = size.minDimension / grid
            for (y in 0 until grid) {
                for (x in 0 until grid) {
                    if (modules[y * grid + x]) {
                        drawRect(
                            color = Color(0xFF101010),
                            topLeft = Offset(x * cell, y * cell),
                            size = Size(cell, cell),
                        )
                    }
                }
            }
        }
        Box(
            modifier = Modifier
                .align(Alignment.Center)
                .size(side * 0.2f)
                .clip(RoundedCornerShape(6.dp))
                .background(DshPrimary),
            contentAlignment = Alignment.Center,
        ) {
            Text("DSH", style = LocalDshType.current.badge, color = Color.White)
        }
    }
}
