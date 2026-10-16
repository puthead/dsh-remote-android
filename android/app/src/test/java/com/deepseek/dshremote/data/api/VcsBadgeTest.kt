package com.deepseek.dshremote.data.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * git 状态字母 → 徽标映射，以及 unified diff 行分类。
 *
 * UI 完全依赖这两个纯函数把"改动"画对：字母认错会让人误判改动的性质（新增/删除最危险）。
 */
class VcsBadgeTest {

    @Test
    fun `常见 porcelain 字母映射到对应徽标`() {
        assertEquals(VcsBadge.MODIFIED, VcsBadge.of("M"))
        assertEquals(VcsBadge.ADDED, VcsBadge.of("A"))
        assertEquals(VcsBadge.DELETED, VcsBadge.of("D"))
        assertEquals(VcsBadge.RENAMED, VcsBadge.of("R"))
        assertEquals(VcsBadge.COPIED, VcsBadge.of("C"))
        assertEquals(VcsBadge.UNTRACKED, VcsBadge.of("?"))
        assertEquals(VcsBadge.CONFLICT, VcsBadge.of("U"))
        assertEquals(VcsBadge.TYPE_CHANGED, VcsBadge.of("T"))
        assertEquals(VcsBadge.IGNORED, VcsBadge.of("!"))
    }

    @Test
    fun `小写与带修饰的字母也能识别`() {
        assertEquals(VcsBadge.MODIFIED, VcsBadge.of("m"))
        assertEquals(VcsBadge.UNTRACKED, VcsBadge.of("??"))
        assertEquals(VcsBadge.IGNORED, VcsBadge.of("!!"))
        assertEquals(VcsBadge.RENAMED, VcsBadge.of("R "))
    }

    @Test
    fun `未知字母归到 OTHER 而不是被丢弃`() {
        assertEquals(VcsBadge.OTHER, VcsBadge.of("Z"))
        assertEquals(VcsBadge.OTHER, VcsBadge.of(""))
        assertEquals("未知状态也必须有可见字母", "?", VcsBadge.OTHER.letter)
    }

    @Test
    fun `徽标颜色区分新增与删除`() {
        // 精确值钉住调色板（2026-10-14 21:26 与 ui/theme/DarkColors.kt 对齐过一版：
        // 新增 0xFF35C08B → 0xFF4CC38A、删除 0xFFFF5C5C → 0xFFFF5A52）。
        assertTrue("新增用绿色系", VcsBadge.ADDED.colorArgb == 0xFF4CC38A.toInt())
        assertTrue("删除用红色系", VcsBadge.DELETED.colorArgb == 0xFFFF5A52.toInt())
        assertTrue(VcsBadge.MODIFIED.colorArgb != VcsBadge.ADDED.colorArgb)

        // 语义也要成立（换色时别把"新增"换成非绿色系）：绿通道占优 / 红通道占优。
        fun red(argb: Int) = (argb shr 16) and 0xFF
        fun green(argb: Int) = (argb shr 8) and 0xFF
        assertTrue("新增的绿通道必须高于红通道", green(VcsBadge.ADDED.colorArgb) > red(VcsBadge.ADDED.colorArgb))
        assertTrue("删除的红通道必须高于绿通道", red(VcsBadge.DELETED.colorArgb) > green(VcsBadge.DELETED.colorArgb))
    }

    @Test
    fun `diff 行分类`() {
        assertEquals(DiffLineKind.META, DiffClassifier.classify("diff --git a/a.kt b/a.kt"))
        assertEquals(DiffLineKind.META, DiffClassifier.classify("--- a/a.kt"))
        assertEquals(DiffLineKind.META, DiffClassifier.classify("+++ b/a.kt"))
        assertEquals(DiffLineKind.META, DiffClassifier.classify("index 1234567..89abcde 100644"))
        assertEquals(DiffLineKind.META, DiffClassifier.classify("new file mode 100644"))
        assertEquals(DiffLineKind.HUNK, DiffClassifier.classify("@@ -1,7 +1,9 @@"))
        assertEquals(DiffLineKind.ADDED, DiffClassifier.classify("+val x = 1"))
        assertEquals(DiffLineKind.REMOVED, DiffClassifier.classify("-val x = 1"))
        assertEquals(DiffLineKind.CONTEXT, DiffClassifier.classify(" val x = 1"))
        assertEquals(DiffLineKind.CONTEXT, DiffClassifier.classify(""))
    }

    @Test
    fun `文件头不会被误判成增删行`() {
        // +++/--- 是文件头，不能算增删，否则统计行数会多算 2
        assertFalse(DiffClassifier.classify("+++ b/a.kt") == DiffLineKind.ADDED)
        assertFalse(DiffClassifier.classify("--- a/a.kt") == DiffLineKind.REMOVED)
    }
}
