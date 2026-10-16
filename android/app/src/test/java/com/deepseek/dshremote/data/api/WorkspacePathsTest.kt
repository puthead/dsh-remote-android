package com.deepseek.dshremote.data.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 工作区路径安全（契约 §4.3 的客户端侧第二道闸）。
 *
 * 网关会用 `realpath` 再校验一次，但客户端不该把明显越界的路径发出去，
 * 更不该让 UI 显示一个"能点但必然 403"的条目。
 */
class WorkspacePathsTest {

    private val root = "D:\\Workspace\\dsh_android"

    @Test
    fun `相对路径归一化`() {
        assertEquals("android/app/build.gradle.kts", WorkspacePaths.normalize(root, "android/app/build.gradle.kts"))
        assertEquals("docs/a.md", WorkspacePaths.normalize(root, ".\\docs\\a.md"))
        assertEquals("android", WorkspacePaths.normalize(root, "android/"))
        assertEquals("android", WorkspacePaths.normalize(root, "./android/."))
        assertEquals("", WorkspacePaths.normalize(root, root))
        assertEquals("", WorkspacePaths.normalize(root, "D:/Workspace/dsh_android/"))
    }

    @Test
    fun `工作区内的绝对路径被接受（大小写不敏感）`() {
        assertEquals("android", WorkspacePaths.normalize(root, "D:\\Workspace\\dsh_android\\android"))
        assertEquals("android", WorkspacePaths.normalize(root, "d:/workspace/DSH_ANDROID/android"))
        assertEquals("docs/01-设计/协议契约-v2.md", WorkspacePaths.normalize(root, "$root\\docs\\01-设计\\协议契约-v2.md"))
    }

    @Test
    fun `拒绝 点 点 穿越`() {
        assertNull(WorkspacePaths.normalize(root, "..\\..\\Windows\\system32"))
        assertNull(WorkspacePaths.normalize(root, "../../etc/passwd"))
        assertNull(WorkspacePaths.normalize(root, "android/../../outside.txt"))
        assertNull(WorkspacePaths.normalize(root, "docs/../../secret"))
        // 内部 .. 只要不越界仍然合法
        assertEquals("docs/a.md", WorkspacePaths.normalize(root, "android/../docs/a.md"))
    }

    @Test
    fun `拒绝 UNC 与其它盘符`() {
        assertNull(WorkspacePaths.normalize(root, "\\\\server\\share\\secret.txt"))
        assertNull(WorkspacePaths.normalize(root, "//server/share/secret.txt"))
        assertNull(WorkspacePaths.normalize(root, "C:\\Windows\\System32\\config\\SAM"))
        assertNull(WorkspacePaths.normalize(root, "E:\\other\\x"))
        assertNull(WorkspacePaths.normalize(root, "D:\\Workspace\\other_project\\x"))
    }

    @Test
    fun `拒绝空值与 NUL 注入`() {
        assertNull(WorkspacePaths.normalize(root, ""))
        assertNull(WorkspacePaths.normalize(root, "   "))
        assertNull(WorkspacePaths.normalize(root, "android\u0000/../../etc"))
        assertNull("工作区根非法时一律拒绝", WorkspacePaths.normalize("", "android"))
        assertNull(WorkspacePaths.normalize("relative/root", "android"))
    }

    @Test
    fun `绝对路径拼接与父目录`() {
        assertEquals("D:\\Workspace\\dsh_android\\android", WorkspacePaths.absolute(root, "android"))
        assertEquals("D:\\Workspace\\dsh_android", WorkspacePaths.absolute(root, ""))
        assertEquals("android", WorkspacePaths.parent("android/app"))
        assertEquals("", WorkspacePaths.parent("android"))
        assertNull("根目录没有父目录", WorkspacePaths.parent(""))
    }

    @Test
    fun `面包屑从根到当前目录`() {
        val crumbs = WorkspacePaths.breadcrumbs("android/app/src")
        assertEquals(listOf("android", "app", "src"), crumbs.map { it.first })
        assertEquals(listOf("android", "android/app", "android/app/src"), crumbs.map { it.second })
        assertTrue(WorkspacePaths.breadcrumbs("").isEmpty())
        assertEquals("工作区", WorkspacePaths.name(""))
        assertEquals("src", WorkspacePaths.name("android/app/src"))
    }

    @Test
    fun `isInside 与 normalize 语义一致`() {
        assertTrue(WorkspacePaths.isInside(root, "android/app"))
        assertFalse(WorkspacePaths.isInside(root, "../outside"))
        assertFalse(WorkspacePaths.isInside(root, "\\\\evil\\share"))
    }

    @Test
    fun `Markdown 文件按扩展名识别`() {
        assertTrue(WorkspacePaths.isMarkdown("README.md"))
        assertTrue(WorkspacePaths.isMarkdown("docs/02-开发/开发规范.MD"))
        assertTrue(WorkspacePaths.isMarkdown("docs\\a\\b.markdown"))
        assertFalse("只是名字里有 md", WorkspacePaths.isMarkdown("docs/md/README"))
        assertFalse(WorkspacePaths.isMarkdown("android/build.gradle.kts"))
        assertFalse(WorkspacePaths.isMarkdown(""))
        assertFalse("不能靠 .md 出现在路径中段就判定", WorkspacePaths.isMarkdown("docs.md/notes.txt"))
    }
}
