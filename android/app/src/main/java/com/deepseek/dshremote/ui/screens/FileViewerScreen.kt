package com.deepseek.dshremote.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Article
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.FormatListNumbered
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.deepseek.dshremote.Graph
import com.deepseek.dshremote.data.api.FileContent
import com.deepseek.dshremote.data.api.WorkspacePaths
import com.deepseek.dshremote.ui.components.CodeView
import com.deepseek.dshremote.ui.components.DshCard
import com.deepseek.dshremote.ui.components.DshDetailTopBar
import com.deepseek.dshremote.ui.components.DshIconButton
import com.deepseek.dshremote.ui.components.DshPageContainer
import com.deepseek.dshremote.ui.components.DshToggleIconButton
import com.deepseek.dshremote.ui.components.EmptyHint
import com.deepseek.dshremote.ui.components.Fmt
import com.deepseek.dshremote.ui.markdown.MarkdownBlockList
import com.deepseek.dshremote.ui.theme.DshBackground
import com.deepseek.dshremote.ui.theme.DshOnSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshPrimary
import com.deepseek.dshremote.ui.theme.DshRadius
import com.deepseek.dshremote.ui.theme.DshSurfaceVariant
import com.deepseek.dshremote.ui.theme.LocalDshType
import com.deepseek.dshremote.ui.vm.friendlyMessage

/** 文件页的三态：加载中 / 成功 / 失败（失败信息已经是人话，直接展示）。 */
private sealed interface FileLoadState {
    object Loading : FileLoadState

    data class Ok(val file: FileContent) : FileLoadState

    data class Fail(val message: String) : FileLoadState
}

/**
 * 文件查看页（画稿未覆盖，按同一套令牌与栅格推导）。
 *
 * 顶栏自绘 46dp（返回箭头圆心 x=32、标题从 x=52 起），不用 M3 TopAppBar 的 64dp：
 * 详情类页面要把高度让给正文，且要和画稿 02 的详情页顶栏保持一致。
 * 功能与原实现一致：行号开关、Markdown 预览/源码切换、重新加载。
 */
@Composable
fun FileViewerScreen(workspace: String, path: String, onBack: () -> Unit) {
    var reload by remember { mutableIntStateOf(0) }
    var showLineNumbers by rememberSaveable { mutableStateOf(true) }
    val isMarkdown = remember(path) { WorkspacePaths.isMarkdown(path) }
    var preview by rememberSaveable(path) { mutableStateOf(true) }

    val state by produceState<FileLoadState>(FileLoadState.Loading, path, reload) {
        value = FileLoadState.Loading
        value = runCatching { Graph.repository.loadFile(path) }.fold(
            onSuccess = { result ->
                result.fold(
                    onSuccess = { FileLoadState.Ok(it) },
                    onFailure = { FileLoadState.Fail(it.friendlyMessage()) },
                )
            },
            onFailure = { FileLoadState.Fail(it.message ?: "加载失败") },
        )
    }

    val ok = state as? FileLoadState.Ok
    Column(modifier = Modifier.fillMaxSize().background(DshBackground)) {
        DshDetailTopBar(
            title = ok?.file?.name?.ifEmpty { null }
                ?: path.replace('\\', '/').substringAfterLast('/'),
            subtitle = WorkspacePaths.normalize(workspace, path) ?: path,
            onBack = onBack,
            actions = {
                if (isMarkdown) {
                    // 高亮态表示"当前正在预览 Markdown"，点一下切回源码
                    DshToggleIconButton(
                        icon = if (preview) Icons.Default.Code else Icons.AutoMirrored.Filled.Article,
                        contentDescription = if (preview) "查看源码" else "预览 Markdown",
                        active = preview,
                        onClick = { preview = !preview },
                    )
                }
                if (!isMarkdown || !preview) {
                    DshToggleIconButton(
                        icon = Icons.Default.FormatListNumbered,
                        contentDescription = if (showLineNumbers) "隐藏行号" else "显示行号",
                        active = showLineNumbers,
                        onClick = { showLineNumbers = !showLineNumbers },
                    )
                }
                DshIconButton(
                    icon = Icons.Default.Refresh,
                    contentDescription = "重新加载",
                    onClick = { reload++ },
                )
            },
        )

        when (val current = state) {
            FileLoadState.Loading -> Box(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp, color = DshPrimary)
                    Text("正在读取…", style = LocalDshType.current.bodyLoose, color = DshOnSurfaceVariant)
                }
            }

            is FileLoadState.Fail -> Column {
                Spacer(Modifier.height(8.dp))
                EmptyHint(current.message)
            }

            is FileLoadState.Ok -> {
                val file = current.file
                Spacer(Modifier.height(6.dp))
                DshPageContainer {
                    DshCard(radius = DshRadius.Sub, containerColor = DshSurfaceVariant) {
                        Text(
                            text = buildString {
                                append(Fmt.size(file.size))
                                append(" · ${file.lineCount} 行")
                                file.modifiedAt?.let { append(" · ${Fmt.relative(it)} 修改") }
                                if (file.truncated) append(" · 已截断")
                            },
                            style = LocalDshType.current.monoMeta,
                            color = DshOnSurfaceVariant,
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))
                when {
                    file.binary -> EmptyHint("这是二进制文件（${Fmt.size(file.size)}），不展示内容。")
                    isMarkdown && preview -> MarkdownBlockList(
                        text = file.text,
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
                    )

                    else -> CodeView(
                        text = file.text,
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                        showLineNumbers = showLineNumbers,
                    )
                }
            }
        }
    }
}
