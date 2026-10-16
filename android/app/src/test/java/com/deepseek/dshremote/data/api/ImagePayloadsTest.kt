package com.deepseek.dshremote.data.api

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.FileNotFoundException
import java.io.IOException

/**
 * 图片压缩管道的**纯函数**部分。
 *
 * 这里刻意不碰 `BitmapFactory` / `ContentResolver` / `Bitmap`：单测跑在 JVM 上，`android.jar`
 * 是空壳（`isReturnDefaultValues = true` 之后只会返回 0/null），真去调 `Bitmap.compress`
 * 不是抛 "not mocked" 就是拿一个假的"成功"，两种都测不出东西。
 * 所以采样、缩放、EXIF 角度、命名、预算换算这些**算法**在主源码里就被拆成了无 Android 依赖的
 * 纯函数，解码那一段（[ImagePayloads.fromUri]）留给真机验证。
 *
 * 断言里的数字都直接来自契约：中继/网关单请求体 ≤ 1_048_576（`tools/dsh-relay/lib/config.mjs:69`、
 * `tools/dsh-remote/lib/config.mjs:216`），base64 膨胀 4/3。
 */
class ImagePayloadsTest {

    // ------------------------------------------------------------------ MIME 归一化

    @Test
    fun `jpeg 系列的别名都归一到 image jpeg`() {
        assertEquals("image/jpeg", ImagePayloads.mediaTypeOf("image/jpeg"))
        assertEquals("image/jpeg", ImagePayloads.mediaTypeOf("image/jpg"))
        assertEquals("image/jpeg", ImagePayloads.mediaTypeOf("image/pjpeg"))
    }

    @Test
    fun `png webp gif 按原样归一`() {
        assertEquals("image/png", ImagePayloads.mediaTypeOf("image/png"))
        assertEquals("image/png", ImagePayloads.mediaTypeOf("image/x-png"))
        assertEquals("image/webp", ImagePayloads.mediaTypeOf("image/webp"))
        assertEquals("image/gif", ImagePayloads.mediaTypeOf("image/gif"))
    }

    @Test
    fun `未知与 null 一律回退 jpeg`() {
        assertEquals("image/jpeg", ImagePayloads.mediaTypeOf(null))
        assertEquals("image/jpeg", ImagePayloads.mediaTypeOf(""))
        assertEquals("image/jpeg", ImagePayloads.mediaTypeOf("   "))
        assertEquals("image/jpeg", ImagePayloads.mediaTypeOf("image/heic"))
        assertEquals("image/jpeg", ImagePayloads.mediaTypeOf("text/plain"))
        assertEquals("image/jpeg", ImagePayloads.mediaTypeOf("image/svg+xml"))
    }

    @Test
    fun `大小写与 provider 附带的参数不影响判定`() {
        assertEquals("image/jpeg", ImagePayloads.mediaTypeOf("IMAGE/JPEG"))
        assertEquals("image/jpeg", ImagePayloads.mediaTypeOf("image/jpeg; charset=binary"))
        assertEquals("image/png", ImagePayloads.mediaTypeOf(" Image/PNG ;charset=utf-8"))
    }

    @Test
    fun `归一化的结果永远落在契约允许的四种里`() {
        val inputs = listOf(
            null, "", "  ", "image/jpeg", "image/jpg", "image/pjpeg", "image/png", "image/x-png",
            "image/webp", "image/gif", "image/heic", "image/heif", "image/bmp", "image/tiff",
            "application/octet-stream", "*/*", "IMAGE/GIF",
        )
        for (input in inputs) {
            val mediaType = ImagePayloads.mediaTypeOf(input)
            assertTrue("$input → $mediaType", mediaType in ImagePayloads.SUPPORTED_MEDIA_TYPES)
            assertTrue(ImagePayloads.isSupportedMediaType(mediaType))
        }
        assertFalse(ImagePayloads.isSupportedMediaType("image/heic"))
        assertEquals(
            setOf("image/png", "image/jpeg", "image/webp", "image/gif"),
            ImagePayloads.SUPPORTED_MEDIA_TYPES,
        )
    }

    @Test
    fun `provider 给不出 MIME 时按扩展名兜底`() {
        // Photo Picker 偶发返回 null / image/heic：这时扩展名比"默认 JPEG"更可信。
        assertEquals("image/png", ImagePayloads.resolveMediaType(null, "shot.PNG", null))
        assertEquals("image/jpeg", ImagePayloads.resolveMediaType(null, "IMG_0001.jpg", null))
        assertEquals("image/webp", ImagePayloads.resolveMediaType("image/heic", "a.webp", null))
        assertEquals("image/gif", ImagePayloads.resolveMediaType(null, null, "media/1234.gif"))
        // 名字与末段都认不出 → 回退 jpeg（后续一定会重编码成 JPEG，字节与类型自洽）
        assertEquals("image/jpeg", ImagePayloads.resolveMediaType(null, "noext", "media/1000000034"))
        // 认得出的 MIME 优先于扩展名（provider 说是 png 就是 png）
        assertEquals("image/png", ImagePayloads.resolveMediaType("image/png", "weird.jpg", null))
    }

    @Test
    fun `扩展名解析的边界`() {
        assertEquals("jpg", ImagePayloads.extensionOf("IMG_1.JPG"))
        assertEquals("png", ImagePayloads.extensionOf("content://media/external/images/media/a.png"))
        assertEquals("jpeg", ImagePayloads.extensionOf("D:\\DCIM\\a.jpeg"))
        assertNull(ImagePayloads.extensionOf("noext"))
        assertNull(ImagePayloads.extensionOf(".hidden"))
        assertNull(ImagePayloads.extensionOf("trailing."))
        assertNull(ImagePayloads.extensionOf("dir.d/file"))
        assertNull(ImagePayloads.extensionOf(null))
    }

    // ------------------------------------------------------------------ formatBytes

    @Test
    fun `不足 1 KiB 直接按字节报`() {
        assertEquals("0 B", ImagePayloads.formatBytes(0))
        assertEquals("1 B", ImagePayloads.formatBytes(1))
        assertEquals("512 B", ImagePayloads.formatBytes(512))
        assertEquals("1023 B", ImagePayloads.formatBytes(1023))
    }

    @Test
    fun `KB MB GB 各带一位小数且用点号`() {
        assertEquals("1.0 KB", ImagePayloads.formatBytes(1024))
        assertEquals("700.0 KB", ImagePayloads.formatBytes(700 * 1024))
        assertEquals("1.0 MB", ImagePayloads.formatBytes(1024 * 1024))
        assertEquals("1.2 MB", ImagePayloads.formatBytes(1_258_291))
        assertEquals("2.0 GB", ImagePayloads.formatBytes(Int.MAX_VALUE))
    }

    @Test
    fun `负数按零处理不抛异常`() {
        assertEquals("0 B", ImagePayloads.formatBytes(-1))
        assertEquals("0 B", ImagePayloads.formatBytes(Int.MIN_VALUE))
    }

    // ------------------------------------------------------------------ PendingImage

    @Test
    fun `approxBase64Chars 按 4 3 向上取整`() {
        fun chars(size: Int) = PendingImage(ByteArray(size), "image/jpeg", "a.jpg", 1, 1).approxBase64Chars
        assertEquals(0, chars(0))
        assertEquals(4, chars(1))
        assertEquals(4, chars(2))
        assertEquals(4, chars(3))
        assertEquals(8, chars(4))
        assertEquals(8, chars(5))
        assertEquals(8, chars(6))
        assertEquals(12, chars(7))
    }

    @Test
    fun `满预算的图 base64 之后仍然小于 1 MiB`() {
        val image = PendingImage(ByteArray(ImagePayloads.MAX_COMPRESSED_BYTES), "image/jpeg", "max.jpg", 1600, 1200)
        // 716800 不是 3 的倍数，这一步正是"少算一组"会踩坑的地方
        assertEquals(955_736, image.approxBase64Chars)
        assertTrue(image.approxBase64Chars < 1_048_576)
        // 余量要够放 JSON 壳 + 同条消息里的文本（约 90 KiB）
        assertTrue(1_048_576 - image.approxBase64Chars > 64 * 1024)
    }

    @Test
    fun `PendingImage 按内容相等而不是引用`() {
        val a = PendingImage(byteArrayOf(1, 2, 3), "image/jpeg", "a.jpg", 10, 20)
        val b = PendingImage(byteArrayOf(1, 2, 3), "image/jpeg", "a.jpg", 10, 20)
        assertEquals(a, b)
        assertEquals(a.hashCode(), b.hashCode())
        // 同一张图重读一遍也会被认成同一张：UI 去重 / distinctUntilChanged 依赖这一点
        assertTrue(a == b)
    }

    @Test
    fun `任一字段不同就不相等`() {
        val base = PendingImage(byteArrayOf(1, 2, 3), "image/jpeg", "a.jpg", 10, 20)
        assertNotEquals(base, base.copy(bytes = byteArrayOf(1, 2, 4)))
        assertNotEquals(base, base.copy(mediaType = "image/png"))
        assertNotEquals(base, base.copy(name = "b.jpg"))
        assertNotEquals(base, base.copy(width = 11))
        assertNotEquals(base, base.copy(height = 21))
        assertFalse(base.equals(null))
        assertFalse(base.equals("not an image"))
    }

    @Test
    fun `toString 只打元信息不打字节`() {
        val text = PendingImage(ByteArray(5), "image/webp", "shot.webp", 640, 480).toString()
        assertTrue(text, text.contains("shot.webp"))
        assertTrue(text, text.contains("image/webp"))
        assertTrue(text, text.contains("640x480"))
        assertTrue(text, text.contains("5 bytes"))
        assertFalse(text, text.contains("[B@"))
    }

    // ------------------------------------------------------------------ 采样与缩放

    @Test
    fun `computeInSampleSize 让解码长边落在 maxEdge 与两倍之间`() {
        val cases = listOf(
            4000 to 3000, 3000 to 4000, 8000 to 6000, 3200 to 2400, 3201 to 2401,
            1600 to 1200, 1601 to 1200, 1599 to 1200, 800 to 600, 200 to 200,
        )
        for ((width, height) in cases) {
            val sample = ImagePayloads.computeInSampleSize(width, height, ImagePayloads.MAX_EDGE_PX)
            assertTrue("$width x $height 采样率必须是 2 的幂：$sample", sample > 0 && (sample and (sample - 1)) == 0)
            val longest = maxOf(width, height)
            if (longest >= ImagePayloads.MAX_EDGE_PX) {
                val decoded = longest / sample
                assertTrue("$width x $height → sample $sample → $decoded 太小", decoded >= ImagePayloads.MAX_EDGE_PX)
                assertTrue("$width x $height → sample $sample → $decoded 太大", decoded < ImagePayloads.MAX_EDGE_PX * 2)
            } else {
                assertEquals("$width x $height 本来就够小，不该再采样", 1, sample)
            }
        }
    }

    @Test
    fun `computeInSampleSize 的档位与非法输入`() {
        assertEquals(1, ImagePayloads.computeInSampleSize(1600, 1200, 1600))
        assertEquals(2, ImagePayloads.computeInSampleSize(3200, 2400, 1600))
        assertEquals(2, ImagePayloads.computeInSampleSize(4000, 3000, 1600))
        assertEquals(4, ImagePayloads.computeInSampleSize(6400, 4800, 1600))
        assertEquals(8, ImagePayloads.computeInSampleSize(12800, 9600, 1600))
        assertEquals(1, ImagePayloads.computeInSampleSize(0, 100, 1600))
        assertEquals(1, ImagePayloads.computeInSampleSize(100, -1, 1600))
        assertEquals(1, ImagePayloads.computeInSampleSize(100, 100, 0))
    }

    @Test
    fun `fitInside 等比缩到长边以内且从不放大`() {
        assertEquals(1600 to 1200, ImagePayloads.fitInside(4000, 3000, 1600))
        assertEquals(1200 to 1600, ImagePayloads.fitInside(3000, 4000, 1600))
        assertEquals(1600 to 1600, ImagePayloads.fitInside(1600, 1600, 1600))
        // 本来就够小：原样返回，绝不放大（放大会把糊图变成更大的糊图）
        assertEquals(800 to 600, ImagePayloads.fitInside(800, 600, 1600))
        assertEquals(100 to 50, ImagePayloads.fitInside(100, 50, ImagePayloads.MAX_EDGE_PX))
        // 极端长条：短边被压到 0 时要兜到 1，否则 createBitmap 会直接崩
        assertEquals(1 to 1600, ImagePayloads.fitInside(1, 10000, 1600))
        assertEquals(2 to 1600, ImagePayloads.fitInside(10, 10000, 1600))
    }

    @Test
    fun `fitInside 的结果长边永远不超上限`() {
        val cases = listOf(
            4000 to 3000, 3000 to 4000, 4032 to 3024, 12000 to 9000, 1 to 10000,
            10000 to 1, 1601 to 1601, 1600 to 1600, 999 to 1,
        )
        for ((width, height) in cases) {
            for (edge in ImagePayloads.EDGE_PX_LADDER) {
                val (fitWidth, fitHeight) = ImagePayloads.fitInside(width, height, edge)
                assertTrue("$width x $height @ $edge → $fitWidth x $fitHeight", maxOf(fitWidth, fitHeight) <= edge)
                assertTrue(fitWidth >= 1 && fitHeight >= 1)
                // 比例不能跑偏（允许 1px 的四舍五入误差）。极端长条的短边会被 coerceAtLeast(1)
                // 兜到 1px，那一档的比例本来就没有意义，只校验上面两条硬约束。
                if (minOf(width, height) >= 20) {
                    val before = width.toDouble() / height
                    val after = fitWidth.toDouble() / fitHeight
                    assertTrue("$width x $height @ $edge 比例跑偏：$before vs $after", Math.abs(before - after) < 0.05)
                }
            }
        }
    }

    // ------------------------------------------------------------------ EXIF 方向

    @Test
    fun `rotationDegreesFor 覆盖 8 种 EXIF 方向`() {
        assertEquals(0, ImagePayloads.rotationDegreesFor(1))   // normal
        assertEquals(0, ImagePayloads.rotationDegreesFor(2))   // 纯镜像，不转
        assertEquals(180, ImagePayloads.rotationDegreesFor(3))
        assertEquals(180, ImagePayloads.rotationDegreesFor(4)) // 上下镜像 = 180° + 左右镜像，这里只取旋转部分
        assertEquals(90, ImagePayloads.rotationDegreesFor(5))
        assertEquals(90, ImagePayloads.rotationDegreesFor(6))  // 竖拍手机最常见的一档
        assertEquals(270, ImagePayloads.rotationDegreesFor(7))
        assertEquals(270, ImagePayloads.rotationDegreesFor(8))
        // 脏 EXIF：不认的方向不能抛，只能当"正常"
        assertEquals(0, ImagePayloads.rotationDegreesFor(0))
        assertEquals(0, ImagePayloads.rotationDegreesFor(9))
        assertEquals(0, ImagePayloads.rotationDegreesFor(-1))
        assertEquals(0, ImagePayloads.rotationDegreesFor(Int.MIN_VALUE))
    }

    @Test
    fun `只有 5 到 8 需要把宽高对调`() {
        for (orientation in 1..4) {
            assertFalse("orientation=$orientation", ImagePayloads.swapsAxesFor(orientation))
        }
        for (orientation in 5..8) {
            assertTrue("orientation=$orientation", ImagePayloads.swapsAxesFor(orientation))
        }
        assertEquals(3000 to 4000, ImagePayloads.orientedSize(4000, 3000, 6))
        assertEquals(3000 to 4000, ImagePayloads.orientedSize(4000, 3000, 8))
        assertEquals(4000 to 3000, ImagePayloads.orientedSize(4000, 3000, 1))
        assertEquals(4000 to 3000, ImagePayloads.orientedSize(4000, 3000, 3))
    }

    @Test
    fun `镜像方向判定与旋转顺序`() {
        // EXIF 2 / 4 是纯镜像；5 / 7 是"转完之后再水平镜像"
        assertTrue(ImagePayloads.mirrorHorizontally(2))
        assertTrue(ImagePayloads.mirrorVertically(4))
        assertTrue(ImagePayloads.mirrorAfterRotation(5))
        assertTrue(ImagePayloads.mirrorAfterRotation(7))
        for (orientation in listOf(1, 3, 6, 8, 9, 0)) {
            assertFalse("orientation=$orientation", ImagePayloads.mirrorHorizontally(orientation))
            assertFalse("orientation=$orientation", ImagePayloads.mirrorVertically(orientation))
            assertFalse("orientation=$orientation", ImagePayloads.mirrorAfterRotation(orientation))
        }
        assertFalse(ImagePayloads.mirrorAfterRotation(2))
        // 5 与 7 一定带旋转，否则"旋转后再镜像"这条规则就落不到实处
        assertTrue(ImagePayloads.rotationDegreesFor(5) != 0)
        assertTrue(ImagePayloads.rotationDegreesFor(7) != 0)
    }

    // ------------------------------------------------------------------ 文件名

    @Test
    fun `displayNameOf 优先用调用方给的名字`() {
        assertEquals("IMG_20261015_2210.jpg", ImagePayloads.displayNameOf("IMG_20261015_2210.jpg", "1234", "image/jpeg"))
        assertEquals("photo.PNG", ImagePayloads.displayNameOf("  photo.PNG  ", null, "image/png"))
        // 调用方传了路径也只取末段
        assertEquals("name.png", ImagePayloads.displayNameOf("weird/../name.png", null, "image/png"))
    }

    @Test
    fun `displayNameOf 从 URI 末段兜底`() {
        assertEquals("CAM_01.jpeg", ImagePayloads.displayNameOf(null, "CAM_01.jpeg", "image/jpeg"))
        assertEquals("shot.webp", ImagePayloads.displayNameOf("", "shot.webp", "image/webp"))
        assertEquals("a.jpg", ImagePayloads.displayNameOf(null, "D:\\DCIM\\a.jpg", "image/jpeg"))
    }

    @Test
    fun `displayNameOf 对 Photo Picker 的纯数字 id 回退到默认名`() {
        // content://media/picker/0/com.android.providers.media.photopicker/media/1000000034
        assertEquals("image.jpg", ImagePayloads.displayNameOf(null, "1000000034", "image/jpeg"))
        assertEquals("image.png", ImagePayloads.displayNameOf(null, null, "image/png"))
        assertEquals("image.webp", ImagePayloads.displayNameOf(null, null, "image/webp"))
        assertEquals("image.gif", ImagePayloads.displayNameOf("   ", "media/1000000034", "image/gif"))
        assertEquals("image.jpg", ImagePayloads.displayNameOf(null, null, "image/heic"))
    }

    @Test
    fun `displayNameOf 剔除控制字符并截断超长名字`() {
        // sanitize 是"剔除"控制字符而不是替换成下划线：换行会让文件名在日志/通知里被截断
        assertEquals("badname.jpg", ImagePayloads.displayNameOf("bad\nname.jpg", null, "image/jpeg"))
        assertEquals("a.jpg", ImagePayloads.displayNameOf("a\u0000\u0007.jpg", null, "image/jpeg"))
        val long = "a".repeat(300) + ".jpg"
        assertEquals(120, ImagePayloads.displayNameOf(long, null, "image/jpeg").length)
    }

    // ------------------------------------------------------------------ readAtMost

    @Test
    fun `readAtMost 最多只读 limit 个字节`() {
        val payload = ByteArray(10) { it.toByte() }
        val read = ImagePayloads.readAtMost(ByteArrayInputStream(payload), 4)
        assertArrayEquals(byteArrayOf(0, 1, 2, 3), read)
    }

    @Test
    fun `readAtMost 正好 limit 与短流都按实际长度返回`() {
        val exactly = ByteArray(4) { (it + 1).toByte() }
        assertArrayEquals(exactly, ImagePayloads.readAtMost(ByteArrayInputStream(exactly), 4))
        assertArrayEquals(byteArrayOf(7, 8, 9), ImagePayloads.readAtMost(ByteArrayInputStream(byteArrayOf(7, 8, 9)), 64))
        assertArrayEquals(ByteArray(0), ImagePayloads.readAtMost(ByteArrayInputStream(ByteArray(0)), 64))
    }

    @Test
    fun `readAtMost 非正上限返回空数组`() {
        assertArrayEquals(ByteArray(0), ImagePayloads.readAtMost(ByteArrayInputStream(ByteArray(8)), 0))
        assertArrayEquals(ByteArray(0), ImagePayloads.readAtMost(ByteArrayInputStream(ByteArray(8)), -1))
    }

    // ------------------------------------------------------------------ 失败文案

    @Test
    fun `describeFailure 原样透出管道自己写好的原因`() {
        assertEquals("这张图片是 0 字节的空文件。", ImagePayloads.describeFailure(ImageReadException("这张图片是 0 字节的空文件。")))
        assertEquals("超过上限了", ImagePayloads.describeFailure(ImageTooLargeException("超过上限了")))
        // message 为空时不能返回空白 snackbar
        assertTrue(ImagePayloads.describeFailure(ImageReadException("  ")).isNotBlank())
    }

    @Test
    fun `describeFailure 把内存与权限问题说成人话`() {
        assertTrue(ImagePayloads.describeFailure(OutOfMemoryError()).contains("内存"))
        assertTrue(ImagePayloads.describeFailure(SecurityException("denied")).contains("权限"))
        assertTrue(ImagePayloads.describeFailure(FileNotFoundException("gone")).contains("移走"))
    }

    @Test
    fun `describeFailure 对未知异常兜底且永不空白`() {
        assertTrue(ImagePayloads.describeFailure(IOException("boom")).contains("boom"))
        assertTrue(ImagePayloads.describeFailure(IllegalStateException("自定义")).contains("自定义"))
        val fallback = ImagePayloads.describeFailure(RuntimeException())
        assertTrue(fallback.isNotBlank())
        assertTrue(fallback, fallback.contains("RuntimeException"))
    }

    // ------------------------------------------------------------------ 契约常量

    @Test
    fun `降档阶梯的第一档就是公开常量且严格递减`() {
        assertEquals(700 * 1024, ImagePayloads.MAX_COMPRESSED_BYTES)
        assertEquals(1600, ImagePayloads.MAX_EDGE_PX)
        assertEquals(82, ImagePayloads.JPEG_QUALITY)

        val qualities = ImagePayloads.JPEG_QUALITY_LADDER
        assertEquals(ImagePayloads.JPEG_QUALITY, qualities.first())
        assertTrue(qualities.size >= 2)
        assertTrue(qualities.all { it in 1..100 })
        for (index in 1 until qualities.size) {
            assertTrue("质量档必须递降：${qualities.toList()}", qualities[index] < qualities[index - 1])
        }

        val edges = ImagePayloads.EDGE_PX_LADDER
        assertEquals(ImagePayloads.MAX_EDGE_PX, edges.first())
        assertTrue(edges.size >= 2)
        assertTrue(edges.all { it in 1..ImagePayloads.MAX_EDGE_PX })
        for (index in 1 until edges.size) {
            assertTrue("长边档必须递降：${edges.toList()}", edges[index] < edges[index - 1])
        }
    }

    @Test
    fun `最低档压出来的字节仍然要过 base64 预算`() {
        // 最坏情况：正好卡在预算上限的一张图（前提是 desugar 之外的算术都用 Int，不会溢出）
        val worstCase = ImagePayloads.MAX_COMPRESSED_BYTES
        assertTrue(worstCase > 0)
        assertTrue(worstCase.toLong() * 4 / 3 + 64 * 1024 < 1_048_576)
    }
}
