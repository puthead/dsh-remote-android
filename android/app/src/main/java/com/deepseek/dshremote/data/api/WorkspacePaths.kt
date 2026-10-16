package com.deepseek.dshremote.data.api

/**
 * 工作区路径安全（契约 §4.3 的硬性规则在**客户端侧**的第二道闸）。
 *
 * 网关已经用 `realpath` 做过白名单校验，客户端为什么还要做一遍：
 * 1. UI 需要知道"当前目录的父目录"、"面包屑"，这些都要在本地算；
 * 2. 手机可能持有过期的工作区快照，用户手动输入的路径不该被原样发给网关
 *    （少一次越界请求，也少一条审计噪音）；
 * 3. 交付物卡片里的路径要判断"能不能点开"。
 *
 * 纯字符串实现（不碰 `java.nio.file`），因此 JVM 单测与真机行为完全一致。
 */
object WorkspacePaths {

    /**
     * 把 [raw] 归一成"相对 [root] 的路径"。
     *
     * @return 相对路径（根目录为 `""`）；**越界/非法一律返回 null**：
     *   `..` 穿越、UNC（`\\\\server\\share`）、不在 root 下的绝对路径、含 NUL、空串。
     */
    fun normalize(root: String, raw: String): String? {
        if (raw.isBlank()) return null
        if (raw.contains('\u0000')) return null
        val rootNorm = canonicalRoot(root) ?: return null
        val path = raw.trim().replace('\\', '/')
        if (path.startsWith("//")) return null // UNC：明确拒绝
        val segments: List<String> = if (hasDriveLetter(path)) {
            val trimmed = path.trimEnd('/')
            if (trimmed.equals(rootNorm, ignoreCase = true)) return ""
            if (!trimmed.startsWith("$rootNorm/", ignoreCase = true)) return null
            trimmed.substring(rootNorm.length + 1).split('/')
        } else {
            path.trim('/').split('/')
        }
        val stack = ArrayDeque<String>()
        for (segment in segments) {
            when (segment) {
                "", "." -> Unit
                ".." -> if (stack.isEmpty()) return null else stack.removeLast()
                else -> stack.addLast(segment)
            }
        }
        return stack.joinToString("/")
    }

    /** 是否在 root 内（[normalize] 不为 null 即视为在内）。 */
    fun isInside(root: String, raw: String): Boolean = normalize(root, raw) != null

    /**
     * 归一化后的绝对路径（用于展示/回传给网关）。
     *
     * 分隔符跟随 root 的写法（Windows 传 `D:\…` 就返回反斜杠），这样 UI 上显示的是
     * 用户在 PC 上熟悉的形式；网关两种写法都接受。
     */
    fun absolute(root: String, relative: String): String {
        val separator = if (root.contains('\\') && !root.contains('/')) "\\" else "/"
        val trimmed = root.trimEnd('\\', '/')
        if (relative.isEmpty()) return trimmed
        return trimmed + separator + relative.replace('/', separator.first())
    }

    /**
     * 父目录的相对路径。
     *
     * @return 上一级；`null` 表示已经是根（UI 据此禁用"返回上级"）。
     */
    fun parent(relative: String): String? {
        if (relative.isEmpty()) return null
        val index = relative.lastIndexOf('/')
        return if (index < 0) "" else relative.substring(0, index)
    }

    /** 面包屑：从根到当前目录，元素是 `名称 to 相对路径`。 */
    fun breadcrumbs(relative: String): List<Pair<String, String>> {
        if (relative.isEmpty()) return emptyList()
        val parts = relative.split('/')
        val result = ArrayList<Pair<String, String>>(parts.size)
        var acc = StringBuilder()
        for (part in parts) {
            if (acc.isNotEmpty()) acc.append('/')
            acc.append(part)
            result += part to acc.toString()
        }
        return result
    }

    /** 末段名字（面包屑/标题用）。 */
    fun name(relative: String): String =
        if (relative.isEmpty()) "工作区" else relative.substringAfterLast('/')

    /** 是否是 Markdown 文件（只按扩展名判断，决定文件页是否提供渲染预览）。 */
    fun isMarkdown(relative: String): Boolean {
        val fileName = relative.replace('\\', '/').substringAfterLast('/').lowercase()
        return fileName.endsWith(".md") || fileName.endsWith(".markdown")
    }

    private fun canonicalRoot(root: String): String? {
        val value = root.trim().replace('\\', '/').trimEnd('/')
        if (value.isEmpty()) return null
        if (value.startsWith("//")) return null
        if (!hasDriveLetter(value)) return null
        return value
    }

    private fun hasDriveLetter(path: String): Boolean =
        path.length >= 2 && path[1] == ':' && path[0].isLetter()
}
