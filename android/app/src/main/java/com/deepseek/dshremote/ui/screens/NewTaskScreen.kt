package com.deepseek.dshremote.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.deepseek.dshremote.BuildConfig
import com.deepseek.dshremote.Graph
import com.deepseek.dshremote.data.api.ModelCatalog
import com.deepseek.dshremote.data.api.ModelSelection
import com.deepseek.dshremote.data.api.TaskAccess
import com.deepseek.dshremote.ui.components.DshCard
import com.deepseek.dshremote.ui.components.DshChip
import com.deepseek.dshremote.ui.components.DshFilterChip
import com.deepseek.dshremote.ui.components.DshIconButton
import com.deepseek.dshremote.ui.components.DshPageHeader
import com.deepseek.dshremote.ui.components.DshSectionLabel
import com.deepseek.dshremote.ui.theme.DshBackground
import com.deepseek.dshremote.ui.theme.DshError
import com.deepseek.dshremote.ui.theme.DshNeutral
import com.deepseek.dshremote.ui.theme.DshPrimary
import com.deepseek.dshremote.ui.theme.DshRadius
import com.deepseek.dshremote.ui.theme.DshSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshWarning
import com.deepseek.dshremote.ui.theme.LocalDshDimens
import com.deepseek.dshremote.ui.theme.LocalDshType
import com.deepseek.dshremote.ui.vm.PhoneTasksViewModel
import com.deepseek.dshremote.ui.vm.appViewModel

/**
 * 「新建任务」页：**直接就是一个对话界面**，不是弹窗。
 *
 * 用户需求原话（2026-10-15）：「新建任务的时候要直接可以进入对话的界面，然后直接在里面进行输入，
 * 并且可以在里面选择或者修改权限、更换模型」。所以这一屏的顺序是：
 * 页头 → 工作区/执行位置·权限/模型（可滚动，等同"空对话"里贴着输入框上方的那几行设置）
 * → 输入胶囊（就是对话页同款 [ComposerCapsule] + [CircleSendButton]）。
 *
 * 三条"不许骗用户"的规则（都有单测/界面判据钉住）：
 * 1. **权限档只在「仅在手机上执行」时出现**——落电脑端时权限跟随电脑端自己的会话设置，
 *    手机端指定不了（[com.deepseek.dshremote.data.api.accessForHost]）。旧弹窗把这个条件写反了：
 *    恰好只在权限不生效的那一侧画权限芯片。
 * 2. **模型只在网关真的报了目录时才画选择器**（旧网关没有 `GET /api/v2/models`）；
 *    电脑端没连上时（`source="config"`）目录里只有一个模型，界面如实说明"只能按它跑"。
 * 3. **创建成功但模型没生效**时**不自动进对话**：先把原因摆在屏幕上，用户点「仍然进入」才走
 *    （见 [PhoneTasksViewModel.takeReadySessionId]）。
 */
@Composable
fun NewTaskScreen(
    onBack: () -> Unit,
    onOpenSession: (String) -> Unit,
) {
    val viewModel = appViewModel { PhoneTasksViewModel(Graph.repository) }
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val dimens = LocalDshDimens.current
    var workspaceMenu by remember { mutableStateOf(false) }
    var modelMenu by remember { mutableStateOf(false) }

    // beginDraft 清掉上一次留下的提示（返回再进来不该还看着三分钟前的"创建失败"）
    LaunchedEffect(Unit) {
        viewModel.beginDraft()
        viewModel.loadModels()
    }
    // 建好了就直接进对话。模型没生效时 takeReadySessionId() 故意返回 null，等用户确认后再走
    // （acknowledgeCreated，见下面的横幅按钮）。
    LaunchedEffect(ui.createdSessionId, ui.createdNeedsAck) {
        viewModel.takeReadySessionId()?.let(onOpenSession)
    }

    Column(modifier = Modifier.fillMaxSize().background(DshBackground)) {
        DshPageHeader(
            title = "新建任务",
            subtitle = draftSubtitle(ui),
            subtitleWarning = !ui.online,
            actions = {
                DshIconButton(
                    icon = Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "返回",
                    onClick = onBack,
                )
            },
        )
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = dimens.pageMargin),
            verticalArrangement = Arrangement.spacedBy(dimens.gapCard),
        ) {
            DraftHint()
            WorkspaceSection(
                ui = ui,
                expanded = workspaceMenu,
                onExpandedChange = { workspaceMenu = it },
                onPick = { path ->
                    workspaceMenu = false
                    viewModel.onWorkspaceChange(path)
                },
            )
            ExecutionSection(
                ui = ui,
                onPhoneOnlyChange = viewModel::onPhoneOnlyChange,
                onAccessChange = viewModel::onAccessChange,
            )
            if (ui.models.isKnown) {
                ModelSection(
                    ui = ui,
                    expanded = modelMenu,
                    onExpandedChange = { modelMenu = it },
                    onPick = { selection ->
                        modelMenu = false
                        viewModel.onModelChange(selection)
                    },
                    onRetry = viewModel::loadModels,
                )
            } else {
                DshSectionLabel("模型")
                OfflineCard(
                    text = "网关没报模型清单（旧版本网关），这次按执行端当前模型跑。",
                )
            }
            if (BuildConfig.DEBUG) {
                // 模拟器没有中文输入法（BUILD.md §7.3）：调试构建给一个能直接点的示例
                DshChip(text = "填入示例（debug）", onClick = viewModel::fillDemoTask)
            }
            Spacer(Modifier.height(2.dp))
        }
        OutcomeBanner(
            ui = ui,
            onAck = { viewModel.acknowledgeCreated()?.let(onOpenSession) },
            onDismiss = viewModel::consumeMessage,
        )
        Composer(
            ui = ui,
            onPromptChange = viewModel::onPromptChange,
            onSend = viewModel::create,
        )
    }
}

/** 页头副标题：先说清这一句话会发到哪去（剩下的交给下面的「在哪执行」卡片）。 */
private fun draftSubtitle(ui: PhoneTasksViewModel.UiState): String = buildString {
    append(if (ui.newTaskOnPhoneOnly) "在手机上执行" else "默认在电脑端执行")
    if (!ui.online) append(" · 电脑离线")
}

/** 空对话的说明：告诉用户"这一屏现在是什么、下一步做什么"。 */
@Composable
private fun DraftHint() {
    val type = LocalDshType.current
    Column(modifier = Modifier.fillMaxWidth().padding(top = 2.dp)) {
        Text(
            text = "还没有消息",
            style = type.labelTight,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = "在下面写第一句话，点发送就开始；开始后这里会变成对话。" +
                "例如：跑一遍全量单测，把失败用例整理成清单",
            style = type.label,
            color = DshNeutral,
        )
    }
}

@Composable
private fun WorkspaceSection(
    ui: PhoneTasksViewModel.UiState,
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    onPick: (String) -> Unit,
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    DshSectionLabel("工作区")
    Box {
        DshCard(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = dimens.buttonHeightLarge)
                    .clickable(role = Role.Button) { onExpandedChange(true) }
                    .padding(horizontal = dimens.cardPad, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = ui.newTaskWorkspace.ifBlank { "选择工作区" },
                        style = type.body,
                        color = MaterialTheme.colorScheme.onBackground,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = "任务在这个目录里跑",
                        style = type.meta,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                    )
                }
                Icon(
                    imageVector = Icons.Default.KeyboardArrowDown,
                    contentDescription = "选择工作区",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { onExpandedChange(false) }) {
            ui.workspaces.forEach { ws ->
                DropdownMenuItem(
                    text = {
                        Text(
                            text = if (ws.exists) ws.path else "${ws.path}（不存在）",
                            style = type.label,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                    onClick = { onPick(ws.path) },
                )
            }
            if (ui.workspaces.isEmpty()) {
                DropdownMenuItem(
                    text = { Text("没拿到工作区列表，先检查电脑是否在线", style = type.label) },
                    onClick = {},
                    enabled = false,
                )
            }
        }
    }
}

/**
 * 「在哪执行」+ 权限档。
 *
 * 两件事必须同时说清（历史缺陷：旧弹窗只在**落电脑端**时画权限芯片，而那正是权限不生效的一侧）：
 * - 落电脑端：权限跟随电脑端 DSH 自己的会话设置，这里**不画**权限档，只说明原因；
 * - 仅在手机上执行：权限档真的会进请求体（`host:"gateway"`），画出来并附后果说明。
 */
@Composable
private fun ExecutionSection(
    ui: PhoneTasksViewModel.UiState,
    onPhoneOnlyChange: (Boolean) -> Unit,
    onAccessChange: (TaskAccess) -> Unit,
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    DshSectionLabel("在哪执行 · 权限")
    DshCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(dimens.cardPad),
            verticalArrangement = Arrangement.spacedBy(dimens.gapChip),
        ) {
            DshFilterChip(
                text = "仅在手机上执行",
                selected = ui.newTaskOnPhoneOnly,
                onClick = { onPhoneOnlyChange(!ui.newTaskOnPhoneOnly) },
            )
            if (ui.newTaskOnPhoneOnly) {
                Row(horizontalArrangement = Arrangement.spacedBy(dimens.gapChip)) {
                    TaskAccess.values().forEach { access ->
                        DshFilterChip(
                            text = access.label,
                            selected = ui.newTaskAccess == access,
                            onClick = { onAccessChange(access) },
                        )
                    }
                }
                Text(
                    text = ui.newTaskAccess.detail,
                    style = type.label,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (ui.newTaskAccess.isDangerous) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = Icons.Default.Warning,
                            contentDescription = null,
                            tint = DshWarning,
                            modifier = Modifier.size(14.dp),
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(
                            text = "「全部权限」= 放开沙箱 + 审批策略 never，请确认任务内容可信",
                            style = type.label,
                            color = DshWarning,
                        )
                    }
                }
            } else {
                Text(
                    text = "落在电脑端 DSH：权限跟随电脑端自己的会话设置，手机端指定不了，" +
                        "所以这里不画权限档（想让权限档生效请打开上面那个开关）。",
                    style = type.label,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** 模型选择器：一个药丸 + 下拉菜单（菜单里按 provider 分组，与电脑端的模型菜单同构）。 */
@Composable
private fun ModelSection(
    ui: PhoneTasksViewModel.UiState,
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    onPick: (ModelSelection?) -> Unit,
    onRetry: () -> Unit,
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    val selected = ui.newTaskModel
    DshSectionLabel("模型")
    Box {
        DshCard(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(dimens.cardPad)) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = dimens.buttonHeightLarge)
                        .clickable(role = Role.Button) { onExpandedChange(true) },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = ui.models.labelFor(selected),
                            style = type.body,
                            color = MaterialTheme.colorScheme.onBackground,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = modelNote(ui, selected),
                            style = type.meta,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Icon(
                        imageVector = Icons.Default.KeyboardArrowDown,
                        contentDescription = "选择模型",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(18.dp),
                    )
                }
                if (ui.loadingModels) {
                    Text(
                        text = "正在读取模型清单…",
                        style = type.meta,
                        color = DshNeutral,
                    )
                }
                ui.modelsError?.let { reason ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = "模型清单没读到：$reason",
                            style = type.meta,
                            color = DshWarning,
                            modifier = Modifier.weight(1f),
                        )
                        Spacer(Modifier.width(6.dp))
                        DshChip(text = "重试", onClick = onRetry)
                    }
                }
            }
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { onExpandedChange(false) }) {
            DropdownMenuItem(
                text = { Text("默认（${ui.models.labelFor(null)}）", style = type.label) },
                onClick = { onPick(null) },
                trailingIcon = { if (selected == null) SelectedMark() },
            )
            ui.models.groups.forEach { group ->
                DropdownMenuItem(
                    text = {
                        Text(
                            text = group.name,
                            style = type.meta,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            fontWeight = FontWeight.Bold,
                        )
                    },
                    onClick = {},
                    enabled = false,
                )
                group.models.forEach { entry ->
                    val picked = selected?.provider == group.id && selected?.model == entry.id
                    DropdownMenuItem(
                        text = {
                            Column {
                                Text(entry.name, style = type.label)
                                entry.description?.takeIf { it.isNotBlank() }?.let { description ->
                                    Text(
                                        text = description,
                                        style = type.meta,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        },
                        onClick = { onPick(ModelSelection(provider = group.id, model = entry.id)) },
                        trailingIcon = { if (picked) SelectedMark() },
                    )
                }
            }
            ui.models.failures.forEach { failure ->
                DropdownMenuItem(
                    text = {
                        Text(
                            text = "${failure.name} 不可用：${failure.message}",
                            style = type.meta,
                            color = DshWarning,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                    onClick = {},
                    enabled = false,
                )
            }
        }
    }
}

@Composable
private fun SelectedMark() {
    Icon(
        imageVector = Icons.Default.Check,
        contentDescription = "已选",
        tint = DshPrimary,
        modifier = Modifier.size(16.dp),
    )
}

/** 药丸下那行小字：这次选的模型**怎么**生效（会话级 / 进程级），别让人以为点了就立刻换。 */
private fun modelNote(ui: PhoneTasksViewModel.UiState, selected: ModelSelection?): String = when {
    ui.newTaskOnPhoneOnly ->
        "在手机上执行：模型在网关侧进程启动时生效"
    ui.models.source == ModelCatalog.SOURCE_CONFIG ->
        "电脑端没连上，只能按网关配置的这一个模型跑"
    selected == null ->
        "不指定：按电脑端当前模型跑"
    else ->
        "切换电脑端这个新会话用的模型"
}

@Composable
private fun OfflineCard(text: String) {
    val type = LocalDshType.current
    val dimens = LocalDshDimens.current
    DshCard(modifier = Modifier.fillMaxWidth(), radius = DshRadius.Sub) {
        Text(
            text = text,
            style = type.meta,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(dimens.cardPad),
        )
    }
}

/**
 * 创建结果横幅。
 *
 * 只有两种内容会走到这里：创建失败（留在本页、prompt 不丢，可重试）和
 * 创建成功但**模型没生效**（给出原因 + 「仍然进入」）。
 */
@Composable
private fun OutcomeBanner(
    ui: PhoneTasksViewModel.UiState,
    onAck: () -> Unit,
    onDismiss: () -> Unit,
) {
    val message = ui.message ?: return
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(DshSurfaceVariant)
            .padding(horizontal = dimens.pageMargin, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = message,
            style = type.label,
            color = if (ui.isError) DshError else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(8.dp))
        if (ui.createdNeedsAck) {
            DshChip(
                text = "仍然进入",
                containerColor = DshPrimary,
                contentColor = androidx.compose.ui.graphics.Color.White,
                borderColor = null,
                bold = true,
                onClick = onAck,
            )
        } else {
            DshChip(text = "知道了", onClick = onDismiss)
        }
    }
}

/** 输入区：与对话页共用的胶囊 + 圆形发送键（不另画一套，省得两处手感不一致）。 */
@Composable
private fun Composer(
    ui: PhoneTasksViewModel.UiState,
    onPromptChange: (String) -> Unit,
    onSend: () -> Unit,
) {
    val dimens = LocalDshDimens.current
    val type = LocalDshType.current
    ComposerCapsule(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = dimens.pageMargin, end = dimens.pageMargin, top = 8.dp, bottom = 10.dp),
    ) {
        BasicTextField(
            value = ui.newTaskPrompt,
            onValueChange = onPromptChange,
            enabled = !ui.creating,
            textStyle = type.body.copy(color = MaterialTheme.colorScheme.onBackground),
            cursorBrush = SolidColor(DshPrimary),
            maxLines = 4,
            modifier = Modifier.weight(1f).padding(vertical = 8.dp),
            decorationBox = { innerTextField ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (ui.newTaskPrompt.isEmpty()) {
                        Text(
                            text = if (ui.newTaskOnPhoneOnly) {
                                "写一句话，在手机上执行…"
                            } else {
                                "写一句话，交给电脑端 DSH 执行…"
                            },
                            style = type.body,
                            color = DshNeutral,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    innerTextField()
                }
            },
        )
        if (ui.creating) {
            Box(
                modifier = Modifier.size(30.dp),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    strokeWidth = 2.dp,
                    color = DshPrimary,
                )
            }
        } else {
            CircleSendButton(
                enabled = ui.canCreate,
                onClick = onSend,
                modifier = Modifier.padding(end = 2.dp),
            )
        }
    }
}
