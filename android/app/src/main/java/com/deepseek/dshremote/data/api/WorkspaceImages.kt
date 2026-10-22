package com.deepseek.dshremote.data.api

import java.net.URI
import java.net.URLDecoder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** 本地路径只通过已认证的网关读取；不把电脑路径交给手机文件系统。 */
fun workspaceImageRef(url: String, workspace: String, baseDirectory: String = workspace, name: String? = null): ImageRef? {
    var path = url.trim()
    if (path.startsWith("file:", ignoreCase = true)) {
        val uri = runCatching { URI(path) }.getOrNull() ?: return null
        if (!uri.authority.isNullOrEmpty()) return null
        path = uri.rawPath ?: return null
        if (Regex("^/[A-Za-z]:").containsMatchIn(path)) path = path.drop(1)
    }
    path = runCatching { URLDecoder.decode(path.replace("+", "%2B"), "UTF-8") }.getOrNull() ?: return null
    path = path.replace('\\', '/')
    if (path.isBlank() || path.startsWith("//") || path.contains('\u0000')) return null
    val drive = Regex("^[A-Za-z]:/").containsMatchIn(path)
    if (!drive && Regex("^[A-Za-z][A-Za-z0-9+.-]*:").containsMatchIn(path)) return null
    if (!drive && !path.startsWith('/')) {
        if (baseDirectory.isBlank()) return null
        path = baseDirectory.trimEnd('/', '\\') + "/" + path
    }
    val root = workspace.takeIf { it.isNotBlank() }
    return ImageRef(id = "workspace:${root.orEmpty()}:$path", name = name?.takeIf { it.isNotBlank() }
        ?: path.substringAfterLast('/'), path = path, workspace = root)
}

fun isWorkspaceImage(path: String): Boolean =
    path.substringAfterLast('.', "").lowercase() in setOf("png", "jpg", "jpeg", "gif", "webp")

/** 路径图片可能被覆盖（如二维码）；不使用内容哈希附件的永久缓存。 */
class WorkspaceImageLoader(
    private val attachments: ImageLoader,
    private val fetch: suspend (String, String?) -> ByteArray,
) : ImageLoader {
    override suspend fun load(ref: ImageRef): ImageLoadResult = withContext(Dispatchers.IO) {
        val path = ref.path ?: return@withContext attachments.load(ref)
        try {
            val bytes = fetch(path, ref.workspace)
            if (bytes.isEmpty() || bytes.size > AttachmentImageLoader.MAX_IMAGE_BYTES) {
                ImageLoadResult.Failed("图片为空或超过大小限制")
            } else ImageLoadResult.Ready(bytes)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            ImageLoadResult.Failed(e.message ?: "图片读取失败")
        }
    }
}
