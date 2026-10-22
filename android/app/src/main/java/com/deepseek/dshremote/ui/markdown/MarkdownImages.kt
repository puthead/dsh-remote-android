package com.deepseek.dshremote.ui.markdown

import androidx.compose.runtime.staticCompositionLocalOf
import com.deepseek.dshremote.data.api.ImageLoader
import com.deepseek.dshremote.data.api.ImageRef
import com.deepseek.dshremote.data.api.workspaceImageRef

data class MarkdownImages(
    val workspace: String,
    val loader: ImageLoader,
    val onOpen: (List<ImageRef>, Int) -> Unit,
    val baseDirectory: String = workspace,
) {
    fun resolve(image: MdInline.Image): ImageRef? =
        workspaceImageRef(image.url, workspace, baseDirectory, image.alt)
}

val LocalMarkdownImages = staticCompositionLocalOf<MarkdownImages?> { null }

/** 拆开文本和图片，保留图片前后强调/链接的语义及原顺序。代码节点永远不解析图片。 */
internal fun imageSegments(nodes: List<MdInline>): List<List<MdInline>> {
    val out = mutableListOf<List<MdInline>>()
    val text = mutableListOf<MdInline>()
    fun flush() { if (text.isNotEmpty()) { out += text.toList(); text.clear() } }
    for (node in nodes) {
        val children = when (node) {
            is MdInline.Strong -> node.children
            is MdInline.Emph -> node.children
            is MdInline.Strike -> node.children
            is MdInline.Link -> node.children
            else -> null
        }
        if (node is MdInline.Image) {
            flush(); out += listOf(node)
        } else if (children != null) {
            for (part in imageSegments(children)) {
                if (part.singleOrNull() is MdInline.Image) {
                    flush(); out += part
                } else text += when (node) {
                    is MdInline.Strong -> node.copy(children = part)
                    is MdInline.Emph -> node.copy(children = part)
                    is MdInline.Strike -> node.copy(children = part)
                    is MdInline.Link -> node.copy(children = part)
                    else -> node
                }
            }
        } else text += node
    }
    flush()
    return out
}
