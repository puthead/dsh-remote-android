package com.deepseek.dshremote.ui.screens

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.deepseek.dshremote.Graph
import com.deepseek.dshremote.data.api.DiffResult
import com.deepseek.dshremote.data.api.WorkspacePaths
import com.deepseek.dshremote.ui.components.CountsText
import com.deepseek.dshremote.ui.components.DiffView
import com.deepseek.dshremote.ui.components.DshCard
import com.deepseek.dshremote.ui.components.DshChip
import com.deepseek.dshremote.ui.components.DshDetailTopBar
import com.deepseek.dshremote.ui.components.DshIconButton
import com.deepseek.dshremote.ui.components.DshPageContainer
import com.deepseek.dshremote.ui.components.EmptyHint
import com.deepseek.dshremote.ui.theme.DshBackground
import com.deepseek.dshremote.ui.theme.DshOnSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshOutline
import com.deepseek.dshremote.ui.theme.DshPrimary
import com.deepseek.dshremote.ui.theme.DshRadius
import com.deepseek.dshremote.ui.theme.DshSurfaceVariant
import com.deepseek.dshremote.ui.theme.LocalDshDimens
import com.deepseek.dshremote.ui.theme.LocalDshType
import com.deepseek.dshremote.ui.vm.friendlyMessage

private sealed interface DiffLoadState {
    object Loading : DiffLoadState

    data class Ok(val diff: DiffResult) : DiffLoadState

    data class Fail(val message: String) : DiffLoadState
}

/**
 * diff 页（画稿未覆盖，按同一套令牌与栅格推导）。
 *
 * 顶栏沿用 02 详情页的 46dp 自绘规格；正文用 [DiffView]（11sp 等宽、行高 17.6dp、
 * 增删整行底色、hunk 头只染色不铺底）。功能与原实现一致：查看完整文件、重新生成、截断提示。
 */
@Composable
fun DiffScreen(
    workspace: String,
    file: String,
    onBack: () -> Unit,
    onOpenFile: (() -> Unit)? = null,
) {
    var reload by remember { mutableIntStateOf(0) }
    val state by produceState<DiffLoadState>(DiffLoadState.Loading, workspace, file, reload) {
        value = DiffLoadState.Loading
        value = runCatching { Graph.repository.loadDiff(workspace, file) }.fold(
            onSuccess = { result ->
                result.fold(
                    onSuccess = { DiffLoadState.Ok(it) },
                    onFailure = { DiffLoadState.Fail(it.friendlyMessage()) },
                )
            },
            onFailure = { DiffLoadState.Fail(it.message ?: "加载失败") },
        )
    }

    Column(modifier = Modifier.fillMaxSize().background(DshBackground)) {
        DshDetailTopBar(
            title = file.replace('\\', '/').substringAfterLast('/'),
            subtitle = WorkspacePaths.normalize(workspace, file) ?: file,
            onBack = onBack,
            actions = {
                onOpenFile?.let { open ->
                    DshIconButton(
                        icon = Icons.Default.Description,
                        contentDescription = "查看完整文件",
                        onClick = open,
                    )
                }
                DshIconButton(
                    icon = Icons.Default.Refresh,
                    contentDescription = "重新生成 diff",
                    onClick = { reload++ },
                )
            },
        )

        when (val current = state) {
            DiffLoadState.Loading -> Box(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp, color = DshPrimary)
                    Text("正在生成 diff…", style = LocalDshType.current.bodyLoose, color = DshOnSurfaceVariant)
                }
            }

            is DiffLoadState.Fail -> Column {
                Spacer(Modifier.height(8.dp))
                EmptyHint(current.message)
            }

            is DiffLoadState.Ok -> {
                val diff = current.diff
                val lines = diff.lines
                val insertions = lines.count { it.startsWith("+") && !it.startsWith("+++") }
                val deletions = lines.count { it.startsWith("-") && !it.startsWith("---") }

                Spacer(Modifier.height(6.dp))
                DshPageContainer {
                    DshCard(radius = DshRadius.Sub, containerColor = DshSurfaceVariant) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = "${diff.vcs} · ${lines.size} 行",
                                style = LocalDshType.current.monoMeta,
                                color = DshOnSurfaceVariant,
                                modifier = Modifier.weight(1f),
                            )
                            if (diff.truncated) {
                                DshChip(
                                    text = "已截断",
                                    containerColor = DshSurfaceVariant,
                                    contentColor = DshOnSurfaceVariant,
                                    borderColor = DshOutline,
                                    height = LocalDshDimens.current.chipHeightSmall,
                                )
                                Spacer(Modifier.width(8.dp))
                            }
                            CountsText(insertions = insertions, deletions = deletions)
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))

                if (lines.isEmpty()) {
                    EmptyHint("这个文件没有可显示的 diff（可能是二进制或未跟踪文件）。")
                } else {
                    DiffView(
                        lines = lines,
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                    )
                }
            }
        }
    }
}
