package com.deepseek.dshremote.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.CloudQueue
import androidx.compose.material.icons.filled.DarkMode
import androidx.compose.material.icons.filled.DeleteSweep
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.DesktopWindows
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.LinkOff
import androidx.compose.material.icons.filled.NotificationsActive
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.VpnKey
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.deepseek.dshremote.BuildConfig
import com.deepseek.dshremote.Graph
import com.deepseek.dshremote.data.CrashReporter
import com.deepseek.dshremote.ui.components.CleartextWarningCard
import com.deepseek.dshremote.ui.components.DshButton
import com.deepseek.dshremote.ui.components.DshInputField
import com.deepseek.dshremote.ui.components.DshSectionLabel
import com.deepseek.dshremote.ui.components.Hairline
import com.deepseek.dshremote.ui.components.KeyValueRow
import com.deepseek.dshremote.ui.components.RelayStatusBar
import com.deepseek.dshremote.ui.theme.DshError
import com.deepseek.dshremote.ui.theme.DshNeutral
import com.deepseek.dshremote.ui.theme.DshOnBackground
import com.deepseek.dshremote.ui.theme.DshOnSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshOutline
import com.deepseek.dshremote.ui.theme.DshPrimary
import com.deepseek.dshremote.ui.theme.DshRadius
import com.deepseek.dshremote.ui.theme.DshSecondary
import com.deepseek.dshremote.ui.theme.DshSuccess
import com.deepseek.dshremote.ui.theme.DshSurfaceHigh
import com.deepseek.dshremote.ui.theme.DshSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshWarning
import com.deepseek.dshremote.ui.theme.LocalDshDimens
import com.deepseek.dshremote.ui.theme.LocalDshType
import com.deepseek.dshremote.ui.components.DshCard
import com.deepseek.dshremote.ui.components.DshPageContainer
import com.deepseek.dshremote.ui.components.DshPageHeader
import com.deepseek.dshremote.ui.vm.SettingsViewModel
import com.deepseek.dshremote.ui.vm.appViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 设置页（画稿 06）：44dp 行卡片 + 分组小标题 + 开关 / 数值 / 箭头三种行尾。
 *
 * 数据全部来自 [SettingsViewModel.UiState] 里**真实存在**的字段 —— 画稿示例里的
 * 「跟随系统」「代码字号滑杆」「开源许可页」在本仓库并不存在（已全仓 grep 确认），
 * 因此这几行按指示不硬造新状态：保留原功能的对应入口（浅色降级、日志导出、账户诊断），
 * 开源许可用真实依赖清单在应用内弹窗呈现。
 */
@Composable
fun SettingsScreen() {
    val viewModel = appViewModel { SettingsViewModel(Graph.repository, Graph.appContext) }
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val relayState by viewModel.relayState.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val focusManager = LocalFocusManager.current
    // 中继地址/设备名与配对码是"行内展开编辑器"：行本身保持 44dp 的紧凑卡面，
    // 需要改的时候才展开输入框，避免设置页被两个 TextField 撑长
    var relayEditor by remember { mutableStateOf(false) }
    var pairEditor by remember { mutableStateOf(false) }
    var showLicenses by remember { mutableStateOf(false) }
    var showCrashes by remember { mutableStateOf(false) }
    var crashSummary by remember { mutableStateOf<CrashReporter.CrashSummary?>(null) }
    var crashCount by remember { mutableStateOf(0) }
    // 读崩溃目录要碰文件系统，放 IO 线程；crashTick 自增即强制重读（清除后刷新用）
    var crashTick by remember { mutableStateOf(0) }

    // 展示完就消费掉：message 不清空的话，每次回到本页都会用没变的 key 重跑一遍，同一条反复弹。
    // 只消费非错误提示，错误原因要留在屏幕上（判据与完整理由见 MessageConsumption.kt）。
    // 注意本页与配对页共用同一个 SettingsViewModel 实例，消费对两页同时生效。
    LaunchedEffect(ui.message) {
        val shown = ui.message ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(shown)
        if (shouldConsumeSnackbarMessage(ui.message, ui.isError)) viewModel.consumeMessage()
    }

    LaunchedEffect(crashTick) {
        val context = Graph.appContext
        val loaded = withContext(Dispatchers.IO) {
            CrashReporter.summarize(context) to CrashReporter.listCrashes(context).size
        }
        crashSummary = loaded.first
        crashCount = loaded.second
    }

    Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState()),
        ) {
            DshPageHeader(title = "设置")

            DshPageContainer { RelayStatusBar(state = relayState) }
            Spacer(Modifier.height(14.dp))

            // ── 连接 ──────────────────────────────────────────────
            DshSectionLabel("连接")
            Spacer(Modifier.height(8.dp)) // DshSectionLabel 自带 7dp → 与画稿的"小标题下留 15dp"对齐
            SettingCard {
                SettingRow(
                    icon = Icons.Default.CloudQueue,
                    label = "中继地址",
                    value = ui.relayUrl.ifEmpty { "未设置" },
                    chevron = true,
                    onClick = { relayEditor = !relayEditor },
                )
                Hairline(inset = 14.dp)
                SettingRow(
                    icon = Icons.Default.Bolt,
                    label = "连接状态",
                    value = ui.relayStateText,
                )
                Hairline(inset = 14.dp)
                SettingRow(
                    icon = Icons.Default.PhoneAndroid,
                    label = "本机设备",
                    value = ui.deviceName.ifEmpty { "未命名" },
                    chevron = true,
                    onClick = { relayEditor = !relayEditor },
                )
                Hairline(inset = 14.dp)
                SettingRow(
                    icon = Icons.Default.DesktopWindows,
                    label = "桌面端",
                    value = if (ui.paired) ui.serverName.ifEmpty { "已配对" } else "未配对",
                )
                Hairline(inset = 14.dp)
                SettingRow(
                    icon = Icons.Default.Link,
                    label = "隧道端点",
                    value = ui.tunnelEndpoint,
                )
            }
            if (relayEditor) {
                Spacer(Modifier.height(10.dp))
                RelayEditorCard(
                    ui = ui,
                    onUrlChange = viewModel::onRelayUrlChange,
                    onDeviceNameChange = viewModel::onDeviceNameChange,
                    onSave = viewModel::saveRelayUrl,
                    onProbeRelay = viewModel::probeRelay,
                    onProbeGateway = viewModel::probeGateway,
                )
            }
            if (ui.isCleartext) {
                Spacer(Modifier.height(10.dp))
                DshPageContainer { CleartextWarningCard() }
            }
            Spacer(Modifier.height(14.dp))

            // ── 外观 ──────────────────────────────────────────────
            DshSectionLabel("外观")
            Spacer(Modifier.height(8.dp))
            SettingCard {
                SettingRow(
                    icon = Icons.Default.DarkMode,
                    label = "深色模式",
                    trailing = {
                        SettingToggle(
                            checked = !ui.lightTheme,
                            onCheckedChange = { viewModel.toggleLightTheme() },
                        )
                    },
                )
            }
            Caption("默认始终深色；关闭后走浅色降级方案（仅作可选降级，不是完整浅色主题）")
            Spacer(Modifier.height(14.dp))

            // ── 通知与后台 ────────────────────────────────────────
            DshSectionLabel("通知与后台")
            Spacer(Modifier.height(8.dp))
            SettingCard {
                SettingRow(
                    icon = Icons.Default.NotificationsActive,
                    label = "保持隧道常驻（前台服务）",
                    value = if (ui.paired) "已启用" else "未启用",
                    valueColor = if (ui.paired) DshSuccess else DshOnSurfaceVariant,
                )
                Hairline(inset = 14.dp)
                SettingRow(
                    icon = Icons.Default.DeleteSweep,
                    label = "清除离线缓存",
                    value = "释放会话缓存",
                    chevron = true,
                    enabled = !ui.busy,
                    onClick = viewModel::clearCache,
                )
            }
            Caption("配对成功后由 App 自动常驻（会话与任务通知需要它）；没有单独开关")
            Spacer(Modifier.height(14.dp))

            // ── 安全 ──────────────────────────────────────────────
            DshSectionLabel("安全")
            Spacer(Modifier.height(8.dp))
            SettingCard {
                SettingRow(
                    icon = Icons.Default.QrCodeScanner,
                    label = "重新配对（6 位配对码）",
                    value = if (ui.paired) "已配对" else "未配对",
                    chevron = true,
                    onClick = { pairEditor = !pairEditor },
                )
                Hairline(inset = 14.dp)
                SettingRow(
                    icon = Icons.Default.VpnKey,
                    label = "吊销本机令牌",
                    value = if (ui.paired) "立即失效" else "未配对",
                    danger = true,
                    enabled = ui.paired && !ui.busy,
                    onClick = viewModel::revoke,
                )
                Hairline(inset = 14.dp)
                SettingRow(
                    icon = Icons.Default.LinkOff,
                    label = "解除配对",
                    value = if (ui.paired) "清空本机密钥" else "未配对",
                    danger = true,
                    enabled = ui.paired && !ui.busy,
                    onClick = viewModel::unpair,
                )
            }
            if (pairEditor) {
                Spacer(Modifier.height(10.dp))
                PairEditorCard(
                    ui = ui,
                    onCodeChange = viewModel::onCodeChange,
                    onPair = {
                        focusManager.clearFocus()
                        viewModel.pair()
                    },
                    onRepair = viewModel::repair,
                    onFillDemo = viewModel::fillDemo,
                )
            }
            Spacer(Modifier.height(14.dp))

            // ── 关于 ──────────────────────────────────────────────
            DshSectionLabel("关于")
            Spacer(Modifier.height(8.dp))
            SettingCard {
                SettingRow(
                    icon = Icons.Default.Info,
                    label = "版本",
                    value = "v${BuildConfig.VERSION_NAME} · API v${BuildConfig.API_VERSION}",
                )
                Hairline(inset = 14.dp)
                SettingRow(
                    icon = Icons.Default.Download,
                    label = "导出自检日志",
                    value = if (ui.logPath != null) "已导出" else null,
                    chevron = true,
                    enabled = !ui.busy,
                    onClick = viewModel::exportLog,
                )
                Hairline(inset = 14.dp)
                // 崩溃记录：直接读 filesDir/crashes（只读、无业务状态，因此不进 ViewModel，
                // 设置页的 UI 结构保持不变）。导出走的仍是上面那一行「导出自检日志」。
                SettingRow(
                    icon = Icons.Default.BugReport,
                    label = "崩溃记录",
                    value = if (crashCount > 0) "$crashCount 份 · ${crashSummary?.time.orEmpty()}" else "无",
                    valueColor = if (crashCount > 0) DshWarning else DshOnSurfaceVariant,
                    chevron = crashCount > 0,
                    onClick = if (crashCount > 0) ({ showCrashes = !showCrashes }) else null,
                )
                Hairline(inset = 14.dp)
                SettingRow(
                    icon = Icons.Default.Description,
                    label = "开源许可",
                    value = "4 项依赖",
                    chevron = true,
                    onClick = { showLicenses = true },
                )
            }
            ui.logPath?.let { path ->
                Spacer(Modifier.height(10.dp))
                DshPageContainer {
                    DshCard(radius = DshRadius.Sub) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("日志文件", style = LocalDshType.current.meta.copy(fontWeight = FontWeight.Bold), color = DshOnSurfaceVariant)
                            Text(path, style = LocalDshType.current.monoMeta, color = DshOnBackground)
                            Caption("内容已脱敏（令牌/配对码只保留前 4 位）；可在 文件管理器 → Android/data/com.deepseek.dshremote*/files 下取走")
                        }
                    }
                }
            }
            // 崩溃摘要：只展示头部（时间/线程/异常类型），完整堆栈留在崩溃文件里。
            // 上次崩溃的现场在这里可见，用户不必插电脑就能截图反馈。
            if (showCrashes) {
                crashSummary?.let { crash ->
                    Spacer(Modifier.height(10.dp))
                    DshPageContainer {
                        DshCard(radius = DshRadius.Sub, containerColor = DshSurfaceVariant) {
                            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(
                                    text = "最近一次崩溃（共 $crashCount 份）",
                                    style = LocalDshType.current.meta.copy(fontWeight = FontWeight.Bold),
                                    color = DshOnSurfaceVariant,
                                )
                                Text("时间：${crash.time}", style = LocalDshType.current.monoMeta, color = DshOnBackground)
                                Text("线程：${crash.thread}", style = LocalDshType.current.monoMeta, color = DshOnBackground)
                                Text(
                                    text = "异常：${crash.cause}",
                                    style = LocalDshType.current.monoMeta,
                                    color = DshError,
                                    maxLines = 3,
                                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                                )
                                Text(crash.path, style = LocalDshType.current.monoMeta, color = DshNeutral)
                                Caption("完整堆栈与崩溃前 200 行日志已写入该文件；点上面「导出自检日志」可整份导出（内容已脱敏）")
                                DshButton(
                                    text = "清除崩溃记录",
                                    onClick = {
                                        CrashReporter.clearAll(Graph.appContext)
                                        showCrashes = false
                                        crashTick++
                                    },
                                    enabled = crashCount > 0,
                                )
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(14.dp))

            // ── 本机账户状态（诊断）────────────────────────────────
            DshSectionLabel("本机账户状态")
            Spacer(Modifier.height(8.dp))
            DshPageContainer {
                DshCard(radius = DshRadius.Card) {
                    Column(Modifier.padding(horizontal = 14.dp, vertical = 6.dp)) {
                        KeyValueRow("PC 名称", ui.serverName.ifEmpty { "—" })
                        KeyValueRow("homeId", ui.homeIdMasked.ifEmpty { "—" })
                        KeyValueRow("tokenId", ui.tokenId.ifEmpty { "—" })
                        KeyValueRow("连接", ui.relayStateText)
                        KeyValueRow("令牌存储", ui.secretNote)
                        KeyValueRow(
                            key = "明文传输",
                            value = if (ui.isCleartext) "是（ws:// 未加密）" else "否（wss:// 已加密）",
                            valueColor = if (ui.isCleartext) DshWarning else DshOnSurfaceVariant,
                        )
                        // 契约 §4.5：v2 能力看 supportedApiVersions，apiVersion 恒为 1
                        KeyValueRow(
                            key = "网关能力",
                            value = ui.gatewayHealth?.capabilityNote
                                ?: "未探测（点下面「探测网关」；判定只看 supportedApiVersions）",
                            valueColor = when (ui.gatewayHealth?.supportsV2) {
                                true -> DshOnSurfaceVariant
                                false -> DshWarning
                                null -> DshOnSurfaceVariant
                            },
                        )
                        ui.gatewayHealth?.let { health ->
                            KeyValueRow("网关版本", "v${health.gatewayVersion} · dsh ${health.dshVersion}")
                            KeyValueRow(
                                "网关 relay",
                                if (health.relayEnabled) {
                                    if (health.relayConnected) "已启用 · 隧道在线" else "已启用 · 隧道离线"
                                } else {
                                    "未启用"
                                },
                            )
                        }
                    }
                }
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DshButton("探测中继", viewModel::probeRelay, enabled = !ui.busy)
                    DshButton("探测网关", viewModel::probeGateway, enabled = !ui.busy && ui.paired)
                }
            }

            // 常驻结果条：Snackbar 会自己消失，用户与自动化都可能错过
            ui.message?.let { text ->
                Spacer(Modifier.height(12.dp))
                DshPageContainer {
                    DshCard(
                        radius = DshRadius.Sub,
                        containerColor = if (ui.isError) DshError.copy(alpha = 0.14f) else DshPrimary.copy(alpha = 0.14f),
                        borderColor = if (ui.isError) DshError.copy(alpha = 0.35f) else DshPrimary.copy(alpha = 0.35f),
                    ) {
                        Text(
                            text = text,
                            style = LocalDshType.current.bodyLoose,
                            color = if (ui.isError) DshError else DshPrimary,
                            modifier = Modifier.fillMaxWidth().padding(12.dp),
                        )
                    }
                }
            }

            if (ui.busy) {
                Spacer(Modifier.height(12.dp))
                DshPageContainer {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = DshPrimary)
                        Text("处理中…", style = LocalDshType.current.meta, color = DshOnSurfaceVariant)
                    }
                }
            }

            Spacer(Modifier.height(12.dp))
            Caption(
                "DSH Remote ${BuildConfig.VERSION_NAME} · API v${BuildConfig.API_VERSION} · " +
                    if (BuildConfig.DEBUG) "debug 变体" else "release 变体",
            )
            Spacer(Modifier.height(28.dp))
        }
    }

    if (showLicenses) {
        LicensesDialog(onDismiss = { showLicenses = false })
    }
}

/** 一组设置行（一张 16dp 圆角卡，行间 14dp 缩进细线）。 */
@Composable
private fun SettingCard(content: @Composable () -> Unit) {
    DshPageContainer {
        DshCard(radius = DshRadius.Card) {
            Column { content() }
        }
    }
}

/** 分组说明：与设置行左对齐（卡左 20dp + 行内 14dp = 34dp），11sp 中性色。 */
@Composable
private fun Caption(text: String) {
    Text(
        text = text,
        style = LocalDshType.current.meta,
        color = DshNeutral,
        modifier = Modifier.fillMaxWidth().padding(start = 34.dp, end = 20.dp, top = 6.dp),
    )
}

/**
 * 一行设置（画稿 06：45dp 高、图标圆心距卡左 23dp、标签从卡左 40dp 起、右控件右缘距卡右 14dp）。
 *
 * 行尾三选一：`trailing`（开关）> `value`（数值）> 空；`chevron` 表示点进去还有东西。
 * danger 行只把标签染红，图标仍是第二强调色（画稿明确如此）。
 */
@Composable
private fun SettingRow(
    icon: ImageVector,
    label: String,
    modifier: Modifier = Modifier,
    value: String? = null,
    valueColor: Color = DshOnSurfaceVariant,
    danger: Boolean = false,
    enabled: Boolean = true,
    chevron: Boolean = false,
    trailing: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null,
) {
    val type = LocalDshType.current
    val dimens = LocalDshDimens.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(dimens.rowSetting)
            .then(
                if (onClick != null && enabled) {
                    Modifier.clickable(role = Role.Button, onClick = onClick)
                } else {
                    Modifier
                },
            )
            // 带箭头的行尾内边距收到 6dp：这样数值右缘落在画稿的 x=310dp、箭头圆心 x=328dp
            .padding(start = 14.dp, end = if (chevron) 6.dp else 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = DshSecondary,
            modifier = Modifier.size(18.dp),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = label,
            style = type.emphasis.copy(fontWeight = FontWeight.Normal),
            color = when {
                danger && enabled -> DshError
                danger -> DshError.copy(alpha = 0.45f)
                enabled -> DshOnBackground
                else -> DshNeutral
            },
            maxLines = 1,
            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        when {
            trailing != null -> trailing()
            value != null -> Text(
                text = value,
                style = type.bodyLoose,
                color = if (enabled) valueColor else DshNeutral,
                maxLines = 1,
                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                textAlign = TextAlign.End,
                modifier = Modifier.widthIn(),
            )
        }
        if (chevron) {
            Spacer(Modifier.width(12.dp))
            Icon(
                imageVector = Icons.Default.ChevronRight,
                contentDescription = null,
                tint = DshOnSurfaceVariant,
                modifier = Modifier.size(12.dp),
            )
        }
    }
}

/** 画稿 06 的开关：40×22dp 轨道 + 18dp 旋钮（开：主色 45% 底 + 主色描边，旋钮贴右缘）。 */
@Composable
private fun SettingToggle(checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    val shape = RoundedCornerShape(11.dp)
    Box(
        modifier = Modifier
            .size(width = 40.dp, height = 22.dp)
            .clip(shape)
            .background(if (checked) DshPrimary.copy(alpha = 0.45f) else DshSurfaceHigh)
            .border(LocalDshDimens.current.border, if (checked) DshPrimary else DshOutline, shape)
            .clickable(role = Role.Switch) { onCheckedChange(!checked) },
    ) {
        Box(
            modifier = Modifier
                .align(Alignment.CenterStart)
                // 画稿：开时旋钮圆心在轨道 x=31（距右缘 9dp），关时在 x=11（距左缘 11dp）
                .padding(start = if (checked) 22.dp else 2.dp)
                .size(18.dp)
                .clip(CircleShape)
                .background(if (checked) DshPrimary else DshOnSurfaceVariant),
        )
    }
}

/** 中继地址 / 设备名的行内编辑器（保存并重连、探测中继、探测网关）。 */
@Composable
private fun RelayEditorCard(
    ui: SettingsViewModel.UiState,
    onUrlChange: (String) -> Unit,
    onDeviceNameChange: (String) -> Unit,
    onSave: () -> Unit,
    onProbeRelay: () -> Unit,
    onProbeGateway: () -> Unit,
) {
    val type = LocalDshType.current
    DshPageContainer {
        DshCard(radius = DshRadius.Sub, containerColor = DshSurfaceVariant) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("中继地址", style = type.meta.copy(fontWeight = FontWeight.Bold), color = DshOnSurfaceVariant)
                DshInputField(
                    value = ui.relayUrl,
                    onValueChange = onUrlChange,
                    placeholder = "wss://relay.example.com",
                    keyboardType = KeyboardType.Uri,
                    enabled = !ui.busy,
                )
                Text("生产用 wss://；开发期 ws:// 会被标记为明文风险", style = type.meta, color = DshNeutral)
                Text("设备名（PC 端识别用）", style = type.meta.copy(fontWeight = FontWeight.Bold), color = DshOnSurfaceVariant)
                DshInputField(
                    value = ui.deviceName,
                    onValueChange = onDeviceNameChange,
                    placeholder = "例如 Pixel 8",
                    enabled = !ui.busy,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DshButton("保存并重连", onSave, enabled = !ui.busy, solid = true)
                    DshButton("探测中继", onProbeRelay, enabled = !ui.busy)
                    DshButton("探测网关", onProbeGateway, enabled = !ui.busy && ui.paired)
                }
                Text(
                    text = "实际隧道端点：${ui.tunnelEndpoint}\n${ui.endpointNote}",
                    style = type.meta,
                    color = DshNeutral,
                )
            }
        }
    }
}

/** 配对码的行内编辑器（配对并连接 / 重新配对 / debug 示例值）。 */
@Composable
private fun PairEditorCard(
    ui: SettingsViewModel.UiState,
    onCodeChange: (String) -> Unit,
    onPair: () -> Unit,
    onRepair: () -> Unit,
    onFillDemo: () -> Unit,
) {
    val type = LocalDshType.current
    DshPageContainer {
        DshCard(radius = DshRadius.Sub, containerColor = DshSurfaceVariant) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("6 位配对码", style = type.meta.copy(fontWeight = FontWeight.Bold), color = DshOnSurfaceVariant)
                DshInputField(
                    value = ui.code,
                    onValueChange = onCodeChange,
                    placeholder = "482913",
                    height = 48.dp,
                    mono = true,
                    enabled = !ui.busy,
                    // 大号等宽 + 4sp 字距：6 位码在户外/单手场景下一眼可读
                    style = type.monoBody.copy(
                        fontSize = 20.sp,
                        lineHeight = 26.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 4.sp,
                    ),
                    textAlign = TextAlign.Center,
                    keyboardType = KeyboardType.NumberPassword,
                    imeAction = ImeAction.Done,
                    onImeAction = onPair,
                )
                Text(
                    text = "在 PC 上执行 scripts\\relay-pair.ps1 生成，一次性、5 分钟有效",
                    style = type.meta,
                    color = DshNeutral,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DshButton(
                        text = if (ui.busy) "配对中…" else "配对并连接",
                        onClick = onPair,
                        enabled = ui.canPair,
                        solid = true,
                        modifier = Modifier.weight(1f),
                    )
                    DshButton("重新配对", onRepair, enabled = ui.canPair)
                }
                if (BuildConfig.DEBUG) {
                    // 仅 debug：模拟器没有中文输入法，自动化需要用应用内按钮写入示例值
                    DshButton("填入示例（debug）", onFillDemo, enabled = !ui.busy)
                }
            }
        }
    }
}

/** 开源许可弹窗：列出 `app/build.gradle.kts` 里真实声明的直接依赖与许可证。 */
@Composable
private fun LicensesDialog(onDismiss: () -> Unit) {
    val type = LocalDshType.current
    Dialog(onDismissRequest = onDismiss) {
        DshCard(radius = DshRadius.Card) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("开源许可", style = type.screenTitle, color = DshOnBackground)
                listOf(
                    "AndroidX / Jetpack Compose" to "Apache License 2.0",
                    "Kotlin 标准库 / kotlinx.coroutines" to "Apache License 2.0",
                    "OkHttp / okhttp-sse（事件流）" to "Apache License 2.0",
                    "DataStore Preferences" to "Apache License 2.0",
                ).forEach { (name, license) ->
                    Column {
                        Text(name, style = type.bodyLoose, color = DshOnBackground)
                        Text(license, style = type.meta, color = DshOnSurfaceVariant)
                    }
                }
                Text(
                    text = "以上为 app/build.gradle.kts 中声明的直接依赖；完整许可文本见 " +
                        "https://www.apache.org/licenses/LICENSE-2.0",
                    style = type.meta,
                    color = DshNeutral,
                )
                DshButton("关闭", onDismiss, solid = true)
            }
        }
    }
}
