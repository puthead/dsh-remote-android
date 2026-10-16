package com.deepseek.dshremote.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.deepseek.dshremote.Graph
import com.deepseek.dshremote.data.api.DiffClassifier
import com.deepseek.dshremote.data.api.DiffLineKind
import com.deepseek.dshremote.data.api.WorkspaceSummary
import com.deepseek.dshremote.ui.components.BreadcrumbBar
import com.deepseek.dshremote.ui.components.ChangeRow
import com.deepseek.dshremote.ui.components.DiffLineText
import com.deepseek.dshremote.ui.components.DshButton
import com.deepseek.dshremote.ui.components.DshCard
import com.deepseek.dshremote.ui.components.DshChip
import com.deepseek.dshremote.ui.components.DshIconButton
import com.deepseek.dshremote.ui.components.DshInputField
import com.deepseek.dshremote.ui.components.DshPageContainer
import com.deepseek.dshremote.ui.components.DshPageHeader
import com.deepseek.dshremote.ui.components.DshSectionLabel
import com.deepseek.dshremote.ui.components.EmptyHint
import com.deepseek.dshremote.ui.components.EntryRow
import com.deepseek.dshremote.ui.components.Hairline
import com.deepseek.dshremote.ui.components.SearchHitRow
import com.deepseek.dshremote.ui.components.UntrackedRow
import com.deepseek.dshremote.ui.components.UpButton
import com.deepseek.dshremote.ui.theme.DshError
import com.deepseek.dshremote.ui.theme.DshOnBackground
import com.deepseek.dshremote.ui.theme.DshOnSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshOutline
import com.deepseek.dshremote.ui.theme.DshPrimary
import com.deepseek.dshremote.ui.theme.DshPrimaryContainer
import com.deepseek.dshremote.ui.theme.DshRadius
import com.deepseek.dshremote.ui.theme.DshSecondary
import com.deepseek.dshremote.ui.theme.DshSuccess
import com.deepseek.dshremote.ui.theme.DshSurface
import com.deepseek.dshremote.ui.theme.DshSurfaceHigh
import com.deepseek.dshremote.ui.theme.DshSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshWarning
import com.deepseek.dshremote.ui.theme.LocalDshDimens
import com.deepseek.dshremote.ui.theme.LocalDshType
import com.deepseek.dshremote.ui.vm.WorkspaceViewModel
import com.deepseek.dshremote.ui.vm.appViewModel

/**
 * 工作区页（画稿 05）。
 *
 * 页面骨架：页头 → 目录选择器 → 三个 tab（文件 / 改动 / 搜索）。
 * 画稿画的是「改动」tab，所以 git 概览卡、比例条与 diff 预览都长在 ChangesTab 里；
 * 文件 tab 沿用同一套行高 46dp 与卡片栅格，搜索 tab 只换输入控件。
 * 页头的右钮保留原功能（刷新当前工作区 / 切换工作区）。
 */
@Composable
fun WorkspaceScreen(
    workspaceHint: String?,
    onOpenFile: (String, String) -> Unit,
    onOpenDiff: (String, String) -> Unit,
) {
    val viewModel = appViewModel { WorkspaceViewModel(Graph.repository) }
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    var switcherOpen by remember { mutableStateOf(false) }

    LaunchedEffect(workspaceHint) { viewModel.bootstrap(workspaceHint) }
    // 展示完就消费掉：message 不清空的话，每次回到本页都会用没变的 key 重跑一遍，同一条反复弹。
    // 只消费非错误提示，错误原因要留在屏幕上（判据与完整理由见 MessageConsumption.kt）。
    LaunchedEffect(ui.message) {
        val shown = ui.message ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(shown)
        if (shouldConsumeSnackbarMessage(ui.message, ui.isError)) viewModel.consumeMessage()
    }

    Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            DshPageHeader(
                title = "工作区",
                actions = {
                    DshIconButton(
                        icon = Icons.Default.Refresh,
                        contentDescription = "刷新工作区",
                        onClick = viewModel::refresh,
                    )
                    DshIconButton(
                        icon = Icons.Default.FolderOpen,
                        contentDescription = "切换工作区",
                        onClick = { switcherOpen = true },
                    )
                },
            )

            WorkspacePicker(
                label = ui.absolutePath.ifEmpty { "未选择工作区" },
                expanded = switcherOpen,
                onExpandChange = { switcherOpen = it },
                workspaces = ui.workspaces,
                onSelect = viewModel::selectWorkspace,
            )
            Spacer(Modifier.height(12.dp))

            TabStrip(
                current = ui.tab,
                loading = ui.loading,
                onSelect = viewModel::setTab,
            )
            Spacer(Modifier.height(12.dp))

            when (ui.tab) {
                WorkspaceViewModel.Tab.FILES -> FilesTab(
                    viewModel = viewModel,
                    workspaceLabel = ui.workspaceLabel,
                    crumbs = ui.crumbs,
                    canGoUp = ui.canGoUp,
                    showHidden = ui.showHidden,
                    entries = ui.entries,
                    truncated = ui.truncated,
                    dirError = ui.dirError,
                    onOpenFile = { path -> onOpenFile(ui.currentWorkspace, path) },
                )

                WorkspaceViewModel.Tab.CHANGES -> ChangesTab(
                    viewModel = viewModel,
                    workspace = ui.currentWorkspace,
                    changes = ui.changes,
                    onOpenDiff = { path -> onOpenDiff(ui.currentWorkspace, path) },
                )

                WorkspaceViewModel.Tab.SEARCH -> SearchTab(
                    viewModel = viewModel,
                    query = ui.searchQuery,
                    hits = ui.hits,
                    onOpenHit = { path -> onOpenFile(ui.currentWorkspace, path) },
                )
            }
        }
    }
}

/** 目录选择器（画稿 05：40dp 高、12dp 圆角、面变底 + 描边，路径 12.5sp 等宽）。 */
@Composable
private fun WorkspacePicker(
    label: String,
    expanded: Boolean,
    onExpandChange: (Boolean) -> Unit,
    workspaces: List<WorkspaceSummary>,
    onSelect: (String) -> Unit,
) {
    val type = LocalDshType.current
    DshPageContainer {
        Box {
            DshCard(
                radius = DshRadius.Sub,
                containerColor = DshSurfaceVariant,
                borderColor = if (expanded) DshPrimary.copy(alpha = 0.55f) else DshOutline,
                modifier = Modifier.fillMaxWidth().height(40.dp),
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxSize()
                        .clickable { onExpandChange(true) }
                        .padding(start = 12.dp, end = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // 画稿里这个图标是第二强调色（橙），不是灰 —— 它是"当前工作区"的第一标识
                    Icon(
                        imageVector = Icons.Default.Folder,
                        contentDescription = null,
                        tint = DshSecondary,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = label,
                        style = type.label.copy(fontFamily = FontFamily.Monospace),
                        color = DshOnBackground,
                        maxLines = 1,
                        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.width(6.dp))
                    Icon(
                        imageVector = Icons.Default.ExpandMore,
                        contentDescription = "展开工作区列表",
                        tint = DshOnSurfaceVariant,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
            // 只有一个工作区时没有可选项，菜单里给一行说明而不是弹空框
            DropdownMenu(expanded = expanded, onDismissRequest = { onExpandChange(false) }) {
                if (workspaces.isEmpty()) {
                    DropdownMenuItem(
                        text = { Text("没有发现可用工作区", style = type.bodyLoose) },
                        onClick = { onExpandChange(false) },
                    )
                } else {
                    workspaces.forEach { workspace ->
                        DropdownMenuItem(
                            text = {
                                Column {
                                    Text(
                                        text = workspace.label.ifEmpty { workspace.path },
                                        style = type.bodyLoose,
                                    )
                                    Text(
                                        text = if (workspace.isGit) {
                                            "git:${workspace.branch.orEmpty()}"
                                        } else {
                                            "非 git 仓库"
                                        },
                                        style = type.meta,
                                        color = DshOnSurfaceVariant,
                                    )
                                }
                            },
                            onClick = {
                                onSelect(workspace.path)
                                onExpandChange(false)
                            },
                        )
                    }
                }
            }
        }
    }
}

/** 三个 tab 的胶囊条：选中态用主色容器（与底部导航的激活态同一语言）。 */
@Composable
private fun TabStrip(
    current: WorkspaceViewModel.Tab,
    loading: Boolean,
    onSelect: (WorkspaceViewModel.Tab) -> Unit,
) {
    DshPageContainer {
        Row(verticalAlignment = Alignment.CenterVertically) {
            listOf(
                WorkspaceViewModel.Tab.FILES,
                WorkspaceViewModel.Tab.CHANGES,
                WorkspaceViewModel.Tab.SEARCH,
            ).forEachIndexed { index, tab ->
                if (index > 0) Spacer(Modifier.width(8.dp))
                val selected = tab == current
                DshChip(
                    text = when (tab) {
                        WorkspaceViewModel.Tab.FILES -> "文件"
                        WorkspaceViewModel.Tab.CHANGES -> "改动"
                        WorkspaceViewModel.Tab.SEARCH -> "搜索"
                    },
                    containerColor = if (selected) DshPrimaryContainer else DshSurfaceVariant,
                    contentColor = if (selected) DshPrimary else DshOnSurfaceVariant,
                    borderColor = if (selected) DshPrimary.copy(alpha = 0.45f) else DshOutline,
                    bold = selected,
                    onClick = { onSelect(tab) },
                )
            }
            if (loading) {
                Spacer(Modifier.width(10.dp))
                CircularProgressIndicator(
                    modifier = Modifier.size(14.dp),
                    strokeWidth = 2.dp,
                    color = DshPrimary,
                )
            }
        }
    }
}

// ── 文件 tab ──────────────────────────────────────────────────────
@Composable
private fun ColumnScope.FilesTab(
    viewModel: WorkspaceViewModel,
    workspaceLabel: String,
    crumbs: List<Pair<String, String>>,
    canGoUp: Boolean,
    showHidden: Boolean,
    entries: List<com.deepseek.dshremote.data.api.WorkspaceEntry>,
    truncated: Boolean,
    dirError: String?,
    onOpenFile: (String) -> Unit,
) {
    DshPageContainer { BreadcrumbBar(workspaceLabel, crumbs, viewModel::openDir) }
    Spacer(Modifier.height(8.dp))
    DshPageContainer {
        Row(verticalAlignment = Alignment.CenterVertically) {
            UpButton(enabled = canGoUp, onClick = viewModel::up)
            Spacer(Modifier.weight(1f))
            DshChip(
                text = if (showHidden) "隐藏点文件" else "显示点文件",
                containerColor = if (showHidden) DshPrimaryContainer else DshSurfaceVariant,
                contentColor = if (showHidden) DshPrimary else DshOnSurfaceVariant,
                borderColor = if (showHidden) DshPrimary.copy(alpha = 0.45f) else DshOutline,
                onClick = viewModel::toggleHidden,
            )
        }
    }
    Spacer(Modifier.height(12.dp))

    // 加载失败必须先于"空目录"判断：否则一次 403/超时会被画成「这个目录是空的」，
    // 用户以为文件夹没了（现场 03-workspace.png 就是这个假象），实际只是这一层没取回来。
    if (dirError != null && entries.isEmpty()) {
        DshPageContainer {
            DshCard(
                radius = DshRadius.Card,
                containerColor = DshError.copy(alpha = 0.10f),
                borderColor = DshError.copy(alpha = 0.45f),
            ) {
                Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
                    Text(
                        text = "这一层目录没有取回来",
                        style = LocalDshType.current.cardTitle,
                        color = DshError,
                    )
                    Spacer(Modifier.height(6.dp))
                    Text(
                        text = dirError,
                        style = LocalDshType.current.meta,
                        color = DshOnSurfaceVariant,
                    )
                    Spacer(Modifier.height(12.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        DshButton("重试", viewModel::refresh, solid = true)
                        Spacer(Modifier.width(8.dp))
                        DshButton("返回上级", viewModel::up, enabled = canGoUp)
                    }
                }
            }
        }
        return
    }
    if (entries.isEmpty()) {
        EmptyHint("这个目录是空的（或未加载）。")
        return
    }
    LazyColumn(modifier = Modifier.weight(1f).fillMaxWidth()) {
        items(entries, key = { it.path }) { entry ->
            DshPageContainer {
                EntryRow(
                    entry = entry,
                    onClick = { if (entry.isDir) viewModel.openDir(entry.path) else onOpenFile(entry.path) },
                )
            }
            // 行是独立卡片，细线取卡内 14dp 缩进（页边距 20 + 14 = 34dp）
            Hairline(inset = 34.dp)
        }
    }
    if (truncated) {
        Text(
            text = "（目录条目超过上限，服务端已截断；进入子目录可以看到剩下的内容）",
            style = LocalDshType.current.meta,
            color = DshOnSurfaceVariant,
            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
        )
    }
}

// ── 改动 tab（画稿 05 的正面）─────────────────────────────────────
@Composable
private fun ColumnScope.ChangesTab(
    viewModel: WorkspaceViewModel,
    workspace: String?,
    changes: com.deepseek.dshremote.data.api.ChangeSet?,
    onOpenDiff: (String) -> Unit,
) {
    val set = changes
    if (set == null) {
        EmptyHint("正在加载改动…")
        return
    }

    val total = set.changed.size + set.untracked.size
    val modified = set.changed.count { it.status.uppercase() == "M" }
    val added = set.changed.count { it.status.uppercase() == "A" } + set.untracked.size
    val removed = set.changed.count { it.status.uppercase() == "D" }
    val untracked = set.untracked.size
    val previewPath = set.changed.firstOrNull()?.path ?: set.untracked.firstOrNull()

    // 预览 diff 只取"足够说明改动"的片段：一次网络请求换来首页的一眼可见
    val preview: List<String>? by produceState<List<String>?>(initialValue = null, workspace, previewPath) {
        value = null
        val ws = workspace
        val path = previewPath
        if (ws == null || path == null) return@produceState
        value = runCatching { Graph.repository.loadDiff(ws, path) }
            .fold(onSuccess = { it.getOrNull()?.lines }, onFailure = { null })
    }

    LazyColumn(modifier = Modifier.weight(1f).fillMaxWidth()) {
        item {
            DshPageContainer {
                GitOverviewCard(
                    total = total,
                    modified = modified,
                    added = added,
                    removed = removed,
                    untracked = untracked,
                    isGit = set.isGit,
                    branch = set.branch,
                    clean = set.clean,
                )
            }
        }

        if (!set.isGit) {
            item {
                Spacer(Modifier.height(12.dp))
                EmptyHint("该工作区不是 git 仓库（vcs=none），下面是其中的文件。")
            }
        } else if (total == 0) {
            item {
                Spacer(Modifier.height(12.dp))
                EmptyHint("工作区没有改动（git status 干净）。")
            }
        }

        if (set.changed.isNotEmpty()) {
            item {
                Spacer(Modifier.height(14.dp))
                DshSectionLabel("已跟踪改动")
                DshPageContainer {
                    DshCard(radius = DshRadius.Card) {
                        Column {
                            set.changed.forEachIndexed { index, change ->
                                // 整张卡只画一次，行间用 16dp 缩进细线（画稿 05 的列表缩进）
                                if (index > 0) Hairline(inset = 16.dp)
                                ChangeRow(change = change, onClick = { onOpenDiff(change.path) })
                            }
                        }
                    }
                }
            }
        }

        if (set.untracked.isNotEmpty()) {
            item {
                Spacer(Modifier.height(14.dp))
                DshSectionLabel("未跟踪文件")
                DshPageContainer {
                    DshCard(radius = DshRadius.Card) {
                        Column {
                            set.untracked.forEachIndexed { index, path ->
                                if (index > 0) Hairline(inset = 16.dp)
                                UntrackedRow(path = path, onClick = { onOpenDiff(path) })
                            }
                        }
                    }
                }
            }
        }

        if (previewPath != null) {
            item {
                Spacer(Modifier.height(12.dp))
                DshPageContainer {
                    DiffPreviewCard(
                        fileName = previewPath.replace('\\', '/').substringAfterLast('/'),
                        lines = preview ?: emptyList(),
                        loading = preview == null,
                    )
                }
            }
        }
        item { Spacer(Modifier.height(20.dp)) }
    }
}

/**
 * git 概览卡（画稿 05）：主标题 + branch 芯片 + 三枚统计胶囊 + 比例条。
 *
 * 比例条用 Row 的 weight 分配，天然按占比伸缩，不需要知道像素宽度；
 * 段间留 4dp 空隙就是为了在只有一两段时也看得出"这是分段的"。
 */
@Composable
private fun GitOverviewCard(
    total: Int,
    modified: Int,
    added: Int,
    removed: Int,
    untracked: Int,
    isGit: Boolean,
    branch: String?,
    clean: Boolean,
) {
    val type = LocalDshType.current
    val dimens = LocalDshDimens.current
    DshCard(radius = DshRadius.Card) {
        Column {
            Row(
                modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = when {
                        !isGit -> "非 git 工作区"
                        clean || total == 0 -> "没有改动"
                        else -> "改动 $total 个文件"
                    },
                    style = type.detailTitle,
                    color = DshOnBackground,
                    modifier = Modifier.weight(1f),
                )
                if (isGit && !branch.isNullOrEmpty()) {
                    Icon(
                        imageVector = Icons.Default.AccountTree,
                        contentDescription = null,
                        tint = DshOnSurfaceVariant,
                        modifier = Modifier.size(14.dp),
                    )
                    Spacer(Modifier.width(12.dp))
                    DshChip(
                        text = branch,
                        containerColor = DshSurfaceVariant,
                        contentColor = DshOnBackground,
                        borderColor = DshOutline,
                        height = dimens.chipHeightSmall,
                        mono = true,
                    )
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 11.dp),
                horizontalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                StatCapsule("修改", modified, DshWarning)
                StatCapsule("新增", added, DshSuccess)
                StatCapsule("未跟踪", untracked, DshOnSurfaceVariant)
            }
            if (removed > 0) {
                // 删除数不占胶囊位（画稿只有三枚），单独一行小字说明，避免信息丢失
                Text(
                    text = "删除 $removed 个",
                    style = type.meta,
                    color = DshOnSurfaceVariant,
                    modifier = Modifier.padding(start = 16.dp, top = 6.dp),
                )
            }
            RatioBar(
                modified = modified,
                added = added,
                untracked = untracked,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 11.dp, bottom = 14.dp),
            )
        }
    }
}

/** 统计胶囊：底色与描边都由语义色稀释而来（画稿规定 10% / 28%）。 */
@Composable
private fun StatCapsule(label: String, count: Int, color: Color) {
    DshChip(
        text = "$label $count",
        containerColor = color.copy(alpha = 0.10f).compositeOver(DshSurface),
        contentColor = color,
        borderColor = color.copy(alpha = 0.28f).compositeOver(DshSurface),
        height = 22.dp,
        mono = true,
    )
}

/** 修改 / 新增 / 未跟踪的占比条（画稿 05 第三行）。 */
@Composable
private fun RatioBar(modified: Int, added: Int, untracked: Int, modifier: Modifier = Modifier) {
    val segments = listOf(
        modified to DshWarning,
        added to DshSuccess,
        untracked to Color(0xFF3A3A3A),
    ).filter { it.first > 0 }
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(6.dp)
            .clip(RoundedCornerShape(3.dp))
            .background(DshSurfaceHigh),
    ) {
        Row(Modifier.fillMaxSize()) {
            segments.forEachIndexed { index, (count, color) ->
                if (index > 0) Spacer(Modifier.width(4.dp))
                Box(
                    modifier = Modifier
                        .weight(count.toFloat())
                        .fillMaxHeight()
                        .background(color),
                )
            }
        }
    }
}

/**
 * 改动首页的 diff 预览卡（画稿 05 最下面一张，14dp 圆角）。
 *
 * 只显示片段（每 hunk 的头部上下文 + 全部增删行，总行数封顶），点列表里的行才进完整 diff。
 */
@Composable
private fun DiffPreviewCard(fileName: String, lines: List<String>, loading: Boolean) {
    val type = LocalDshType.current
    val added = lines.count { it.startsWith("+") && !it.startsWith("+++") }
    val removed = lines.count { it.startsWith("-") && !it.startsWith("---") }
    DshCard(radius = DshRadius.Panel) {
        Column {
            Row(
                modifier = Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = 11.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = fileName,
                    style = type.label.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold),
                    color = DshOnBackground,
                    maxLines = 1,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                DshChip(
                    text = "+$added −$removed",
                    containerColor = DshSuccess.copy(alpha = 0.10f).compositeOver(DshSurface),
                    contentColor = DshSuccess,
                    borderColor = DshSuccess.copy(alpha = 0.28f).compositeOver(DshSurface),
                    height = 20.dp,
                    mono = true,
                )
            }
            when {
                loading -> Text(
                    text = "正在生成 diff…",
                    style = type.meta,
                    color = DshOnSurfaceVariant,
                    modifier = Modifier.padding(start = 14.dp, bottom = 14.dp),
                )

                lines.isEmpty() -> Text(
                    text = "这个文件没有可显示的 diff（可能是二进制或未跟踪文件）。",
                    style = type.meta,
                    color = DshOnSurfaceVariant,
                    modifier = Modifier.padding(start = 14.dp, end = 14.dp, bottom = 14.dp),
                )

                else -> {
                    // 这里**绝不能**用 DiffView：它自己是一个 LazyColumn，而本卡是
                    // ChangesTab 那个 LazyColumn 的 item —— item 在滚动方向上高度无界，
                    // 内层 LazyColumn 量到 infinity 约束会直接抛 IllegalStateException
                    // 把进程干掉（真机复现：工作区 → 改动 一进就崩，crash-*.txt 里有原文）。
                    // 预览本来就只有 previewSlice 的十几行，用普通 Column 逐行画即可。
                    Column(modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
                        previewSlice(lines).forEach { line ->
                            DiffLineText(line = line, lineNumber = null)
                        }
                    }
                }
            }
        }
    }
}

/**
 * 预览截断：每个 hunk 保留前 2 行"变更前"的上下文，总行数封顶 16。
 * 首页要的是"改了什么"，不是把整个文件搬上来。
 */
private fun previewSlice(lines: List<String>, maxLines: Int = 16, contextPerHunk: Int = 2): List<String> {
    val out = mutableListOf<String>()
    var contextLeft = 0
    var leadingContext = true
    for (line in lines) {
        if (out.size >= maxLines) break
        when (DiffClassifier.classify(line)) {
            DiffLineKind.HUNK -> {
                out += line
                contextLeft = contextPerHunk
                leadingContext = true
            }

            DiffLineKind.ADDED, DiffLineKind.REMOVED -> {
                out += line
                leadingContext = false
            }

            DiffLineKind.CONTEXT -> if (leadingContext && contextLeft > 0) {
                out += line
                contextLeft--
            }

            DiffLineKind.META -> Unit
        }
    }
    return out
}

// ── 搜索 tab ──────────────────────────────────────────────────────
@Composable
private fun ColumnScope.SearchTab(
    viewModel: WorkspaceViewModel,
    query: String,
    hits: List<com.deepseek.dshremote.data.api.SearchHit>,
    onOpenHit: (String) -> Unit,
) {
    DshPageContainer {
        Row(verticalAlignment = Alignment.CenterVertically) {
            DshInputField(
                value = query,
                onValueChange = viewModel::onSearchChange,
                placeholder = "搜索文件名或内容",
                imeAction = ImeAction.Search,
                onImeAction = viewModel::runSearch,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            DshButton("搜索", viewModel::runSearch, solid = true)
        }
    }
    Spacer(Modifier.height(12.dp))

    if (hits.isEmpty()) {
        EmptyHint("输入关键词后点「搜索」。搜索在 PC 上执行，只返回轻量结果。")
        return
    }
    LazyColumn(modifier = Modifier.weight(1f).fillMaxWidth()) {
        items(hits, key = { it.path + (it.line?.toString() ?: "") }) { hit ->
            DshPageContainer {
                SearchHitRow(hit = hit, onClick = { onOpenHit(hit.path) })
            }
            Hairline(inset = 34.dp)
        }
    }
}
