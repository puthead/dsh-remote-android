package com.deepseek.dshremote.ui.components

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.BrokenImage
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.deepseek.dshremote.data.api.ImageLoadResult
import com.deepseek.dshremote.data.api.ImageLoader
import com.deepseek.dshremote.data.api.ImageRef
import com.deepseek.dshremote.ui.theme.DshNeutral
import com.deepseek.dshremote.ui.theme.DshOnBackground
import com.deepseek.dshremote.ui.theme.DshOnSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshOutline
import com.deepseek.dshremote.ui.theme.DshRadius
import com.deepseek.dshremote.ui.theme.DshSurfaceVariant
import com.deepseek.dshremote.ui.theme.LocalDshType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 对话内的图片（缩略图带 + 全屏查看器）。
 *
 * 为什么自己解码而**不引图片库**（Coil/Glide）：这个 App 只连中继，图片只能经
 * `/api/v2/attachments/{id}` 拿字节，图片库的 HTTP 栈在这里用不上，而它们的
 * 磁盘缓存策略、生命周期集成又都是按"任意 URL"设计的。真正需要的三件事 ——
 * 按需降采样、内存 LRU、同一张图只下一次 —— 加起来不到 200 行，见
 * `data/api/AttachmentImages.kt`（缓存/去重）与本文件（解码/呈现）。
 *
 * 解码一律在 IO 线程 + `inSampleSize` 降采样：桌面端会话里的截图常常是
 * 1600×900 的 PNG（几百 KB 到 1 MB），原样解码成 ARGB_8888 就是 5.7 MB 一张，
 * 一张缩略图能把 dalvik 堆顶掉。
 */

/** 单张缩略图的最大宽度（用户气泡本身 250dp，再宽就会把气泡撑出屏幕）。 */
private val ThumbMaxWidth = 260.dp

/** 单张缩略图的最大高度：竖屏截图很高，不夹住会把对话流拉成"一屏一张图"。 */
private val ThumbMaxHeight = 200.dp

/** 多图并排时的单格边长下限（保证 3 张并排也还能看清是不是自己发的那张）。 */
private val ThumbMinSide = 76.dp

private val StripGap = 6.dp

/** 并排显示的最大张数；更多的用最后一格上的「+N」表示。 */
private const val MaxVisibleThumbs = 3

/** 单图缩略的默认宽高比（未知尺寸时按 3:2，正好是桌面端窗口截图的比例）。 */
private const val DefaultAspect = 0.68f

/** 图片加载 + 解码的状态机。 */
private sealed interface ImageUiState {
    data object Loading : ImageUiState

    data class Ready(val bitmap: ImageBitmap) : ImageUiState

    data class Failed(val message: String) : ImageUiState
}

/**
 * 消息里的图片带。
 *
 * 布局规则（对齐成熟 IM 的做法）：1 张按原始比例给大图；2 张并排两格；
 * 3 张及以上并排三格，超出部分在末格盖「+N」。
 *
 * @param onOpen 点第 index 张时打开全屏查看器；索引针对 [images] 原列表，
 *   所以带「+N」的末格也能把用户带到被折叠的那几张。
 */
@Composable
fun MessageImageStrip(
    images: List<ImageRef>,
    loader: ImageLoader,
    onOpen: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (images.isEmpty()) return
    BoxWithConstraints(modifier) {
        val density = LocalDensity.current
        val available = maxWidth
        val count = minOf(images.size, MaxVisibleThumbs)
        val single = images.size == 1
        val tileWidth: Dp
        val tileHeight: Dp
        if (single) {
            val ref = images.first()
            tileWidth = minOf(available, ThumbMaxWidth)
            val aspect = aspectOf(ref)
            val raw = tileWidth * aspect
            tileHeight = raw.coerceIn(ThumbMinSide, ThumbMaxHeight)
        } else {
            val side = ((available - StripGap * (count - 1)) / count).coerceAtLeast(ThumbMinSide)
            tileWidth = side
            tileHeight = side
        }
        val reqWidth = with(density) { tileWidth.roundToPx() }
        val reqHeight = with(density) { tileHeight.roundToPx() }
        Row(horizontalArrangement = Arrangement.spacedBy(StripGap)) {
            repeat(count) { index ->
                val ref = images[index]
                val hidden = if (index == MaxVisibleThumbs - 1) images.size - MaxVisibleThumbs else 0
                MessageImageTile(
                    ref = ref,
                    loader = loader,
                    tileWidth = tileWidth,
                    tileHeight = tileHeight,
                    overlay = hidden,
                    crop = !single,
                    requestWidthPx = reqWidth,
                    requestHeightPx = reqHeight,
                    onClick = { onOpen(index) },
                )
            }
        }
    }
}

/** 单格缩略图：加载中给占位、失败给可重试的说明、成功给降采样后的位图。 */
@Composable
private fun MessageImageTile(
    ref: ImageRef,
    loader: ImageLoader,
    tileWidth: Dp,
    tileHeight: Dp,
    overlay: Int,
    crop: Boolean,
    requestWidthPx: Int,
    requestHeightPx: Int,
    onClick: () -> Unit,
) {
    val type = LocalDshType.current
    // 重试就是换一个 key 让 produceState 重跑；失败不进 loader 的缓存，
    // 所以重试一定是一次真实的重新拉取（网络恢复后点一下就能出图）。
    var retryTick by remember(ref.id) { mutableStateOf(0) }
    val state by rememberDecodedImage(ref, loader, requestWidthPx, requestHeightPx, retryTick)
    Box(
        modifier = Modifier
            .size(tileWidth, tileHeight)
            .clip(RoundedCornerShape(DshRadius.Sub))
            .background(DshSurfaceVariant)
            .border(0.5.dp, DshOutline, RoundedCornerShape(DshRadius.Sub))
            .clickable(enabled = state !is ImageUiState.Failed, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        when (val current = state) {
            is ImageUiState.Loading -> CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                strokeWidth = 2.dp,
                color = DshNeutral,
            )

            is ImageUiState.Ready -> Image(
                bitmap = current.bitmap,
                contentDescription = ref.label,
                contentScale = if (crop) ContentScale.Crop else ContentScale.Fit,
                modifier = Modifier.fillMaxSize(),
            )

            is ImageUiState.Failed -> Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.padding(8.dp),
            ) {
                Icon(Icons.Outlined.BrokenImage, contentDescription = null, tint = DshNeutral)
                Spacer(Modifier.height(4.dp))
                Text(
                    text = current.message,
                    style = type.tiny,
                    color = DshOnSurfaceVariant,
                    textAlign = TextAlign.Center,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                TextButton(onClick = { retryTick += 1 }) {
                    Text(text = "重试", style = type.meta, color = DshOnBackground)
                }
            }
        }
        if (overlay > 0) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.45f)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "+$overlay",
                    style = type.detailTitle,
                    color = Color.White,
                )
            }
        }
    }
}

/**
 * 全屏查看器。
 *
 * 用 `Dialog` + `HorizontalPager` 而不是自己写手势：多图之间左右滑动是系统级手势，
 * 自己实现出来的版本在"滑到边界还会再滑一点"这种细节上永远不如现成的。
 * 点图或点右上角关闭；查看器与缩略图共用同一个 [loader]，所以打开不会二次下载。
 */
@Composable
fun ImageViewerDialog(
    images: List<ImageRef>,
    startIndex: Int,
    loader: ImageLoader,
    onDismiss: () -> Unit,
) {
    if (images.isEmpty()) return
    val pagerState = rememberPagerState(
        initialPage = startIndex.coerceIn(0, images.lastIndex),
        pageCount = { images.size },
    )
    val type = LocalDshType.current
    val configuration = LocalConfiguration.current
    val density = LocalDensity.current
    val screenWidthPx = with(density) { configuration.screenWidthDp.dp.roundToPx() }
    val screenHeightPx = with(density) { configuration.screenHeightDp.dp.roundToPx() }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            HorizontalPager(state = pagerState, modifier = Modifier.fillMaxSize()) { page ->
                ViewerPage(
                    ref = images[page],
                    loader = loader,
                    requestWidthPx = screenWidthPx,
                    requestHeightPx = screenHeightPx,
                    onDismiss = onDismiss,
                )
            }
            Row(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "${pagerState.currentPage + 1} / ${images.size}",
                    style = type.meta,
                    color = DshOnBackground,
                )
                Spacer(Modifier.weight(1f))
                IconButton(onClick = onDismiss) {
                    Icon(Icons.Default.Close, contentDescription = "关闭", tint = DshOnBackground)
                }
            }
            val currentRef = images[pagerState.currentPage.coerceIn(0, images.lastIndex)]
            Text(
                text = detailOf(currentRef, images.size > 1),
                style = type.meta,
                color = DshOnSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp, vertical = 28.dp),
            )
        }
    }
}

/**
 * 查看器里的一页。
 *
 * 重试状态放在页内（按图 id 记忆）：多图之间左右滑动时每页各自持有自己的重试计数，
 * 返回上一页不会把已经加载好的那页又打回占位。
 */
@Composable
private fun ViewerPage(
    ref: ImageRef,
    loader: ImageLoader,
    requestWidthPx: Int,
    requestHeightPx: Int,
    onDismiss: () -> Unit,
) {
    val type = LocalDshType.current
    var retryTick by remember(ref.id) { mutableStateOf(0) }
    val state by rememberDecodedImage(ref, loader, requestWidthPx, requestHeightPx, retryTick)
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        when (val current = state) {
            is ImageUiState.Loading -> CircularProgressIndicator(
                modifier = Modifier.size(28.dp),
                strokeWidth = 2.dp,
                color = DshNeutral,
            )

            is ImageUiState.Ready -> Image(
                bitmap = current.bitmap,
                contentDescription = ref.label,
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = onDismiss,
                    ),
            )

            is ImageUiState.Failed -> Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.padding(24.dp),
            ) {
                Icon(
                    Icons.Outlined.BrokenImage,
                    contentDescription = null,
                    tint = DshNeutral,
                    modifier = Modifier.size(32.dp),
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    text = current.message,
                    style = type.body,
                    color = DshOnBackground,
                    textAlign = TextAlign.Center,
                )
                TextButton(onClick = { retryTick += 1 }) {
                    Text(text = "重试", style = type.meta, color = DshOnBackground)
                }
            }
        }
    }
}

/** 底部的图片说明：尺寸 + 体积（服务端下发的元数据，拿不到就不编）。 */
private fun detailOf(ref: ImageRef, swipeHint: Boolean): String {
    val parts = mutableListOf<String>()
    if (ref.width != null && ref.height != null && ref.width > 0 && ref.height > 0) {
        parts += "${ref.width}×${ref.height}"
    }
    if (ref.bytes != null && ref.bytes > 0) parts += formatBytes(ref.bytes)
    ref.mediaType?.let { parts += it.substringAfter('/') }
    if (swipeHint) parts += "左右滑动切换"
    return parts.joinToString(" · ")
}

internal fun formatBytes(bytes: Int): String = when {
    bytes >= 1024 * 1024 -> "%.1f MB".format(bytes / 1024f / 1024f)
    bytes >= 1024 -> "${bytes / 1024} KB"
    else -> "$bytes B"
}

/** 单图缩略的宽高比（高/宽）；未知尺寸回落到 3:2 的横图比例。 */
private fun aspectOf(ref: ImageRef): Float {
    val width = ref.width ?: return DefaultAspect
    val height = ref.height ?: return DefaultAspect
    if (width <= 0 || height <= 0) return DefaultAspect
    return (height.toFloat() / width.toFloat()).coerceIn(0.5f, 1.6f)
}

/**
 * 取一张图的位图：加载（走 [loader] 的内存/磁盘/网络三级）与解码都在 IO 线程。
 *
 * 为什么把"加载"和"解码"合成一个状态机而不是拆两层：对界面来说
 * 「还没有东西可画」只有一种表现（占位），拆开只会多一个必然同步变化的中间态。
 */
@Composable
private fun rememberDecodedImage(
    ref: ImageRef,
    loader: ImageLoader,
    requestWidthPx: Int,
    requestHeightPx: Int,
    retryTick: Int,
): State<ImageUiState> = produceState<ImageUiState>(
    initialValue = ImageUiState.Loading,
    ref.id,
    loader,
    retryTick,
) {
    value = when (val result = loader.load(ref)) {
        is ImageLoadResult.Ready -> withContext(Dispatchers.IO) {
            decodeSampled(result.bytes, requestWidthPx, requestHeightPx)
        }

        is ImageLoadResult.Failed -> ImageUiState.Failed(result.message)
    }
}

/**
 * 按需降采样解码。
 *
 * 两步走是 Android 上的标准做法：先 `inJustDecodeBounds` 只读头部拿到原始尺寸
 * （不分配像素内存），再按 2 的幂选 `inSampleSize` 真正解码。
 * `BitmapFactory` 只认 2 的幂（其它值会被向下取整到 2 的幂），所以这里也用位移算。
 */
private fun decodeSampled(bytes: ByteArray, requestWidthPx: Int, requestHeightPx: Int): ImageUiState {
    if (bytes.isEmpty()) return ImageUiState.Failed("图片为空")
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val sourceWidth = bounds.outWidth
    val sourceHeight = bounds.outHeight
    if (sourceWidth <= 0 || sourceHeight <= 0) return ImageUiState.Failed("无法识别的图片格式")
    val options = BitmapFactory.Options().apply {
        inSampleSize = sampleSize(sourceWidth, sourceHeight, requestWidthPx, requestHeightPx)
    }
    val bitmap = runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) }
        .getOrNull()
        ?: return ImageUiState.Failed("图片解码失败")
    return ImageUiState.Ready(bitmap.asImageBitmap())
}

/** 最大的 2 的幂，使降采样后仍不小于请求尺寸（多留一点是为了缩放时不做二次插值放大）。 */
private fun sampleSize(sourceWidth: Int, sourceHeight: Int, requestWidthPx: Int, requestHeightPx: Int): Int {
    if (requestWidthPx <= 0 || requestHeightPx <= 0) return 1
    var sample = 1
    var width = sourceWidth
    var height = sourceHeight
    while (width / 2 >= requestWidthPx && height / 2 >= requestHeightPx) {
        width /= 2
        height /= 2
        sample *= 2
    }
    return sample
}
