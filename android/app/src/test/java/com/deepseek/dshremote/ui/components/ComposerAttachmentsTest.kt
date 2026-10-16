package com.deepseek.dshremote.ui.components

import androidx.exifinterface.media.ExifInterface
import com.deepseek.dshremote.data.api.ImagePayloads
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 输入区图片附件（task-5）的纯逻辑单测。
 *
 * 为什么只测这两个函数：
 * - [sampleSizeFor] / [rotationDegreesFor] 是这个文件里**唯一**不碰 Compose、也不碰
 *   BitmapFactory 的逻辑（`androidx.exifinterface.media.ExifInterface` 的方向常量是普通
 *   `static final int`，JVM 单测读得到，所以这两个函数能真跑）。
 * - `rememberImagePicker` / `ComposerImageRow` / `PendingImageThumb` 都是 @Composable
 *   （本仓库没有 Compose UI 测试基建）；`normalizeCameraPhoto` / `decodeThumbnail` 需要
 *   真 Bitmap 与真文件；`THUMB_BOX` / `THUMB_PX` / `newCameraFile` 是文件级 private。
 *
 * 这些断言不是"重复实现一遍"：[rotationDegreesFor] 与
 * [ImagePayloads.rotationDegreesFor] 是**同一件事的两份拷贝**（UI 侧拍照旋正、数据侧
 * 压缩旋正），任何一份漂移都会让竖拍照片在一个入口是正的、另一个入口是躺的 ——
 * 而那种 bug 在模拟器上用横屏截图测是看不出来的，所以这里用断言把它锁死。
 */
class ComposerAttachmentsTest {

    // ------------------------------------------------------------ sampleSizeFor

    /** 采样率只用 2 的幂：BitmapFactory 对非 2 的幂只保证"不小于请求值"，结果不可预测。 */
    @Test
    fun sample_size_is_power_of_two_and_never_upscales() {
        assertEquals(1, sampleSizeFor(100, 80, 192))
        for (edge in listOf(100, 512, 1920, 4000, 8000)) {
            for (maxEdge in listOf(64, 192, 1600)) {
                val sample = sampleSizeFor(edge, edge / 2, maxEdge)
                assertEquals("sampleSize 必须是 2 的幂：$sample", 0, sample and (sample - 1))
            }
        }
    }

    /** 小图不放大：解码后长边必须 ≥ 目标，采样率就得停在 1。 */
    @Test
    fun small_image_keeps_sample_one() {
        assertEquals(1, sampleSizeFor(192, 192, 192))
        assertEquals(1, sampleSizeFor(100, 50, 192))
    }

    /**
     * 采样率的真实契约是**两条**：
     * ① 只要采样率 > 1（也就是"采下来了"），解码后长边仍须 ≥ [maxEdge]，且**再折半一次就会掉下去**
     *    —— 不过度采样，缩略图 192 px 的目标采到 250 px 就该停手；
     * ② 采样率 = 1 时图片本身比目标还小，按"绝不放大"的约定原样解码（这里要求原长边 < 2×目标，
     *    否则就该被采一次了）。
     *
     * 期望值按这两条**算出来**，不写死数字：`4000→192` 是 16（4000/32 = 125 < 192 会掉下去），
     * 手算时很容易误当成 32 —— 那正好是"再多折一次"的档位。
     */
    @Test
    fun decoded_longest_edge_stays_at_or_above_target() {
        fun expectedSample(edge: Int, maxEdge: Int): Int {
            var sample = 1
            var longest = edge
            while (longest / 2 >= maxEdge) {
                longest /= 2
                sample *= 2
            }
            return sample
        }
        // 用 assertTrue 而不是 Kotlin 的 assert：JVM 单测默认不开 -ea，`assert` 会被整个跳过。
        for (edge in listOf(4000, 1920, 800, 400)) {
            for (maxEdge in listOf(192, 1600)) {
                val sample = sampleSizeFor(edge, edge, maxEdge)
                assertEquals("edge=$edge maxEdge=$maxEdge", expectedSample(edge, maxEdge), sample)
                val decodedLongest = edge / sample
                if (sample == 1) {
                    assertTrue(
                        "edge=$edge maxEdge=$maxEdge 没采样，但原图已经大到该采一次了",
                        edge < maxEdge * 2,
                    )
                } else {
                    assertTrue(
                        "edge=$edge maxEdge=$maxEdge sample=$sample 把长边采到了 $maxEdge 以下",
                        decodedLongest >= maxEdge,
                    )
                    assertTrue(
                        "edge=$edge maxEdge=$maxEdge sample=$sample 还能再折一次（过度采样）",
                        edge / (sample * 2) < maxEdge,
                    )
                }
            }
        }
        // 两个锚点写死，防止上面的公式与实现"一起漂移"：小图不放大、大图确实被采下来过。
        assertEquals(1, sampleSizeFor(400, 400, 1600))
        assertEquals(16, sampleSizeFor(4000, 4000, 192))
    }

    /** 非法输入退化成 1（1 是"不采样"，也就是最安全的那一档），而不是抛异常或返回 0。 */
    @Test
    fun degenerate_inputs_fall_back_to_one() {
        assertEquals(1, sampleSizeFor(0, 100, 192))
        assertEquals(1, sampleSizeFor(100, 0, 192))
        assertEquals(1, sampleSizeFor(-1, -1, 192))
        assertEquals(1, sampleSizeFor(100, 100, 0))
        assertEquals(1, sampleSizeFor(100, 100, -5))
    }

    /** 竖向图按长边算采样：1920×1080 竖过来是 1080×1920，两者必须得到同一个采样率。 */
    @Test
    fun orientation_does_not_change_sample_size() {
        assertEquals(sampleSizeFor(1920, 1080, 192), sampleSizeFor(1080, 1920, 192))
    }

    /**
     * 与数据层的采样实现锁死一致。
     *
     * 两份实现服务同一张图的两个阶段（缩略图预览 vs 压缩上传），算出来的采样率不同本身无害，
     * 但**同时漂移**就说明有人在只改一边，而两边都没有"看得见"的断言时，用户看到的只是
     * "缩略图和发出去的图不一样清晰" —— 这种问题没人会去查单测，所以在这里钉住。
     */
    @Test
    fun matches_data_layer_sampling_for_the_same_scale() {
        for (edge in listOf(200, 400, 800, 1600, 3200, 6000)) {
            assertEquals(
                "edge=$edge 时两份采样实现不一致",
                ImagePayloads.computeInSampleSize(edge, edge, 192),
                sampleSizeFor(edge, edge, 192),
            )
        }
    }

    // -------------------------------------------------------- rotationDegreesFor

    /** EXIF 常量 → 顺时针角度：相机写的是 ORIGINAL/ROTATE_*，1/90/180/270 四态成对。 */
    @Test
    fun exif_orientation_maps_to_clockwise_degrees() {
        assertEquals(0, rotationDegreesFor(ExifInterface.ORIENTATION_NORMAL))
        assertEquals(90, rotationDegreesFor(ExifInterface.ORIENTATION_ROTATE_90))
        assertEquals(180, rotationDegreesFor(ExifInterface.ORIENTATION_ROTATE_180))
        assertEquals(270, rotationDegreesFor(ExifInterface.ORIENTATION_ROTATE_270))
    }

    /**
     * 未定义 / 越界的方向必须落到 0（"不转"），而不是抛异常。
     *
     * 真实来源：部分相机与截图工具写出 0、9 甚至随机值；[normalizeCameraPhoto] 拿到 0
     * 就原样返回文件，这正是"看不懂的 EXIF 就当它没写"这条正确行为。
     */
    @Test
    fun unknown_orientation_means_no_rotation() {
        assertEquals(0, rotationDegreesFor(0))
        assertEquals(0, rotationDegreesFor(9))
        assertEquals(0, rotationDegreesFor(-1))
        assertEquals(0, rotationDegreesFor(Int.MIN_VALUE))
    }

    /**
     * UI 侧的旋转表**有意只覆盖"不含镜像的那三档"**（ROTATE_90/180/270）。
     *
     * 这不是"漏了 5/7"：数据层的 [ImagePayloads.rotationDegreesFor] 要覆盖全部 8 种方向，
     * 因为它的入口是**任意来源的 URI**（含别人传的、从网上下载的图），并且有
     * `mirrorHorizontally`/`mirrorVertically`/`mirrorAfterRotation` 把镜像一起做掉；
     * 而拍照入口的文件是 `ActivityResultContracts.TakePicture` 在系统相机里刚写的，
     * 系统相机只写 1/3/6/8 四档。
     *
     * 这条断言的作用是**把"未覆盖"显式化**：凡 UI 侧给非 0 角度的方向，必须与数据层同角度
     * （两份拷贝不能各转各的）；凡 UI 侧给 0 的方向，必须真的是镜像类（1/2/3/4/5/7/8 之外的值
     * 或未定义值），一旦系统相机开始写 5/7，这里就会红 —— 那时**同批**补上 `MirrorMatrix`，
     * 而不是让竖拍照片在电脑端躺着。
     */
    @Test
    fun camera_path_rotations_match_the_data_layer() {
        // 不含镜像的三档：两份实现必须同角度
        for (orientation in listOf(1, 3, 6, 8)) {
            assertEquals(
                "orientation=$orientation 时两份旋转实现不一致",
                ImagePayloads.rotationDegreesFor(orientation),
                rotationDegreesFor(orientation),
            )
        }
        // 含镜像的四档（2/4/5/7）：UI 侧这一版不做镜像，因此必须是 0；数据层只表达"旋转那部分"
        for (orientation in listOf(2, 4, 5, 7)) {
            assertEquals("orientation=$orientation UI 侧应保持不转", 0, rotationDegreesFor(orientation))
            assertTrue(
                "orientation=$orientation 是镜像类，数据层应当有明确处理",
                ImagePayloads.mirrorHorizontally(orientation) ||
                    ImagePayloads.mirrorVertically(orientation) ||
                    ImagePayloads.mirrorAfterRotation(orientation),
            )
        }
        // 相机三档（6/8 是手机竖拍最常见的两种）
        assertEquals(90, rotationDegreesFor(ExifInterface.ORIENTATION_ROTATE_90))
        assertEquals(180, rotationDegreesFor(ExifInterface.ORIENTATION_ROTATE_180))
        assertEquals(270, rotationDegreesFor(ExifInterface.ORIENTATION_ROTATE_270))
        // 镜像方向（transpose / transverse / flip）在这一版不做镜像，返回「不转」
        assertEquals(0, rotationDegreesFor(ExifInterface.ORIENTATION_FLIP_HORIZONTAL))
        assertEquals(0, rotationDegreesFor(ExifInterface.ORIENTATION_FLIP_VERTICAL))
    }
}
