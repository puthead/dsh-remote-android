package com.deepseek.dshremote.ui.components

import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.exifinterface.media.ExifInterface
import com.deepseek.dshremote.data.api.PendingImage
import com.deepseek.dshremote.ui.theme.DshOnSurfaceVariant
import com.deepseek.dshremote.ui.theme.DshOutline
import com.deepseek.dshremote.ui.theme.DshPrimary
import com.deepseek.dshremote.ui.theme.DshSurfaceVariant
import com.deepseek.dshremote.ui.theme.LocalDshDimens
import com.deepseek.dshremote.ui.theme.LocalDshType
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 待发送图片的选图入口（相册 + 拍照）。
 *
 * 为什么相册走系统 Photo Picker：`ActivityResultContracts.PickVisualMedia` 在 Android 13+
 * 走系统的照片选择器，**不需要任何读媒体权限**（Android 11/12 同样是系统选择器，26–29 自动
 * 回落到 `ACTION_OPEN_DOCUMENT`，也不需要权限）；拍照那条路才需要 CAMERA + FileProvider。
 * 用 `ACTION_GET_CONTENT` 就得申请 `READ_EXTERNAL_STORAGE`/`READ_MEDIA_IMAGES`，
 * 平白多一条敏感权限，属于能避免就不申请的类别。
 *
 * 回调契约：`onPicked(uri, displayName)` 只交原始 `content://`/`file://`，
 * 真正读图/缩放/EXIF/体积压缩由 [ImagePayloads.fromUri] 在 IO 线程做（相册原图动辄 5–10 MB，
 * 必须压进「中继/网关单个请求体 1 MiB」的硬约束里）。
 */
@Composable
fun rememberImagePicker(
    onPicked: (Uri, String?) -> Unit,
    onError: (String) -> Unit,
): ImagePicker {
    val context = LocalContext.current
    val currentOnPicked by rememberUpdatedState(onPicked)
    val currentOnError by rememberUpdatedState(onError)

    // 拍照时先写进自己的 cache 目录再交给系统相机：相机 App 没有写我们私有目录的权限，
    // 必须用 FileProvider 授权的 content:// 交给它（`file://` 从 Android 7 起会 FileUriExposedException）。
    var cameraTarget by remember { mutableStateOf<File?>(null) }

    val gallery = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri ->
        if (uri != null) currentOnPicked(uri, displayNameOf(context, uri))
    }

    val camera = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture(),
    ) { ok ->
        val file = cameraTarget
        cameraTarget = null
        if (!ok || file == null || !file.exists()) {
            // 用户在相机里取消：不是错误，安静收场（弹一句"已取消拍照"只会显得吵）
            file?.delete()
            return@rememberLauncherForActivityResult
        }
        // normalizeCameraPhoto 把像素旋正（相机默认只写 EXIF 方向标记、像素是"躺"的）——
        // 压缩链路会重新编码并丢掉方向标记，不在这里旋正的话竖拍照片到电脑端会是横的。
        val rotated = runCatching { normalizeCameraPhoto(file) }.getOrNull()
        val deliver = if (rotated != null && rotated != file) {
            // 旋正后的文件不能立刻删：上层要在 IO 线程里读它。交给消费者读完再删。
            file.delete()
            rotated
        } else {
            file
        }
        currentOnPicked(Uri.fromFile(deliver), deliver.name)
    }

    val permission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (!granted) {
            currentOnError("没有相机权限，无法拍照；可在系统设置里开启，或改用相册选图")
            return@rememberLauncherForActivityResult
        }
        val file = newCameraFile(context)
        cameraTarget = file
        val uri = runCatching {
            FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        }.getOrElse {
            currentOnError("无法准备拍照临时文件：${it.message ?: it.javaClass.simpleName}")
            return@rememberLauncherForActivityResult
        }
        camera.launch(uri)
    }

    return remember(gallery, camera, permission) {
        ImagePicker(
            pickFromGallery = {
                // isPhotoPickerAvailable=false 时 PickVisualMedia 会自己回落到 OPEN_DOCUMENT，
                // 这里不需要分支，交给系统契约判断即可。
                gallery.launch(
                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                )
            },
            takePhoto = {
                if (ContextCompat.checkSelfPermission(context, android.Manifest.permission.CAMERA) ==
                    PackageManager.PERMISSION_GRANTED
                ) {
                    val file = newCameraFile(context)
                    cameraTarget = file
                    val uri = FileProvider.getUriForFile(
                        context,
                        "${context.packageName}.fileprovider",
                        file,
                    )
                    camera.launch(uri)
                } else {
                    permission.launch(android.Manifest.permission.CAMERA)
                }
            },
        )
    }
}

/** 选图入口的句柄：让调用方决定"点了哪个图标"，而不必关心权限/FileProvider 细节。 */
class ImagePicker(
    val pickFromGallery: () -> Unit,
    val takePhoto: () -> Unit,
)

/**
 * 待发送图片的缩略图行（可横向滚动、可单张删除）。
 *
 * 为什么不做"占位符 + 文件名"了事：用户选了 3 张图之后必须能一眼确认"选对没有"，
 * 文字文件名在相册图（`IMG_20261015_221012.jpg`）上完全不可辨认。
 */
@Composable
fun ComposerImageRow(
    images: List<PendingImage>,
    onRemove: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (images.isEmpty()) return
    val dimens = LocalDshDimens.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        images.forEachIndexed { index, image ->
            PendingImageThumb(
                image = image,
                onRemove = { onRemove(index) },
                border = dimens.border,
            )
        }
    }
}

@Composable
private fun PendingImageThumb(
    image: PendingImage,
    onRemove: () -> Unit,
    border: Dp,
) {
    val type = LocalDshType.current
    val preview: Bitmap? by produceState<Bitmap?>(initialValue = null, image) {
        value = withContext(Dispatchers.IO) { decodeThumbnail(image.bytes, THUMB_PX) }
    }
    Box(
        modifier = Modifier
            .size(THUMB_BOX)
            .clip(RoundedCornerShape(10.dp))
            .background(DshSurfaceVariant)
            .border(border, DshOutline, RoundedCornerShape(10.dp)),
    ) {
        val bitmap = preview
        if (bitmap != null) {
            Image(
                bitmap = bitmap.asImageBitmap(),
                contentDescription = image.name,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            // 解码中/解码失败：不显示破图，用文件名兜底（同时保证这一格永远不是空白）
            Text(
                text = image.name,
                style = type.meta,
                color = DshOnSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .align(Alignment.Center)
                    .padding(horizontal = 6.dp),
            )
        }
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(3.dp)
                .size(18.dp)
                .clip(CircleShape)
                .background(DshPrimary)
                .clickable(role = Role.Button, onClick = onRemove),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Default.Close,
                contentDescription = "移除这张图片",
                tint = androidx.compose.ui.graphics.Color.White,
                modifier = Modifier.size(12.dp),
            )
        }
    }
}

/** 缩略图方框边长（dp）与解码目标长边（px，按 3x 密度留余量）。 */
private val THUMB_BOX = 56.dp
private const val THUMB_PX = 192

/**
 * 按长边 [maxEdge] 采样解码缩略图。
 *
 * 用 `inJustDecodeBounds` 先读尺寸再算 `inSampleSize`（2 的幂），而不是 `inPreferredConfig`
 * 硬解全图：相册里一张 4000×3000 的 JPEG 全解要 ~48 MB 堆内存，列表里放几张就会 OOM。
 */
internal fun decodeThumbnail(bytes: ByteArray, maxEdge: Int): Bitmap? = runCatching {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    val options = BitmapFactory.Options().apply {
        inSampleSize = sampleSizeFor(bounds.outWidth, bounds.outHeight, maxEdge)
    }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
}.getOrNull()

/** 采样倍数：2 的幂，保证解码后长边仍 ≥ [maxEdge]（小图返回 1，不放大）。 */
internal fun sampleSizeFor(width: Int, height: Int, maxEdge: Int): Int {
    if (width <= 0 || height <= 0 || maxEdge <= 0) return 1
    var sample = 1
    var longest = maxOf(width, height)
    while (longest / 2 >= maxEdge) {
        longest /= 2
        sample *= 2
    }
    return sample
}

/** 相机照片的旋转角度（相机的 JPEG 只写 EXIF 方向标记，像素本身是"躺"的）。 */
internal fun rotationDegreesFor(exifOrientation: Int): Int = when (exifOrientation) {
    ExifInterface.ORIENTATION_ROTATE_90 -> 90
    ExifInterface.ORIENTATION_ROTATE_180 -> 180
    ExifInterface.ORIENTATION_ROTATE_270 -> 270
    else -> 0
}

/**
 * 把相机刚写的文件按 EXIF 方向旋正并重新编码成 JPEG。
 *
 * 为什么必须在**落盘**这一步旋正：上下两条路（[ImagePayloads.fromUri] 与压缩）都会重新编码，
 * 而重新编码会**丢掉** EXIF 方向标记 —— 不先旋正的话，竖拍照片到电脑端就是横的。
 */
internal fun normalizeCameraPhoto(file: File): File {
    val degrees = rotationDegreesFor(ExifInterface(file).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL))
    val decoded = BitmapFactory.decodeFile(file.absolutePath) ?: return file
    if (degrees == 0) return file
    val matrix = Matrix().apply { postRotate(degrees.toFloat()) }
    val rotated = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
    val out = File(file.parentFile, "rotated-${file.name}")
    FileOutputStream(out).use { stream ->
        rotated.compress(Bitmap.CompressFormat.JPEG, 95, stream)
    }
    if (rotated !== decoded) rotated.recycle()
    decoded.recycle()
    return out
}

private fun newCameraFile(context: Context): File {
    val dir = File(context.cacheDir, "camera").apply { mkdirs() }
    val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
    return File(dir, "IMG_$stamp.jpg")
}

/** 相册里的显示名：`OpenableColumns.DISPLAY_NAME`，取不到就退回 URI 末段。 */
internal fun displayNameOf(context: Context, uri: Uri): String? {
    val fromProvider = runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
    }.getOrNull()
    return fromProvider?.takeIf { it.isNotBlank() } ?: uri.lastPathSegment
}
