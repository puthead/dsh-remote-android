package com.deepseek.dshremote.data

import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 全局崩溃取证（[CrashReporter]）。
 *
 * 这些断言守的是三条硬约束，因为它们的失效方式都很安静：
 * 1. 取证代码**自己**不能抛异常 / 不能无限递归 / 不能把磁盘写满 —— 否则崩溃现场反而是被取证代码毁掉的；
 * 2. 报告必须自带足够的上下文（时间/线程/版本/设备/崩溃前日志），否则拉回来的文件没法定位问题；
 * 3. 落盘必须是"最新在前、只留 N 份"，崩溃循环时不能把用户手机塞满。
 *
 * 全程只碰 `java.io.File` 与纯函数（不碰 Android API），因此可以在 JVM 单测里跑。
 */
class CrashReporterTest {

    private val dir: java.io.File = Files.createTempDirectory("dsh-crash-test").toFile()

    @After
    fun tearDown() {
        dir.deleteRecursively()
    }

    private fun report(
        error: Throwable = RuntimeException("boom"),
        kind: String = "未捕获异常",
        threadName: String = "main",
        device: String = "Google / Pixel 8 / Android 14 (API 34)",
        logLines: List<String> = listOf("12:00:00 I Relay 已连接", "12:00:01 W Sse 心跳超时"),
    ) = CrashReporter.buildReport(
        kind = kind,
        timestamp = 1_700_000_000_000L,
        threadName = threadName,
        error = error,
        versionName = "0.3.2",
        versionCode = 32L,
        buildType = "debug",
        device = device,
        logLines = logLines,
    )

    // ───────────────────────── 报告内容 ─────────────────────────

    @Test
    fun `报告包含时间线程异常版本设备与崩溃前日志`() {
        val text = report()

        assertTrue(text, text.contains("DSH Remote 崩溃报告"))
        assertTrue(text, text.contains("类型：未捕获异常"))
        assertTrue(text, text.contains("线程：main"))
        assertTrue(text, text.contains("异常：java.lang.RuntimeException"))
        assertTrue(text, text.contains("0.3.2 (32) · debug"))
        assertTrue(text, text.contains("Google / Pixel 8 / Android 14 (API 34)"))
        assertTrue(text, text.contains("--- 堆栈 ---"))
        // 崩溃前的应用日志必须原样带上：用户复述不出"上一秒发生了什么"
        assertTrue(text, text.contains("12:00:00 I Relay 已连接"))
        assertTrue(text, text.contains("心跳超时"))
        assertTrue(text, text.contains("最近 2 行"))
    }

    @Test
    fun `报告里的明文令牌被脱敏`() {
        // record() 在落盘前统一过 Logger.redact，这里是"脱敏确实作用到崩溃报告"的可执行保障
        val text = Logger.redact(report(error = RuntimeException("token=dshr_9f2cAbCdEfGh1234567890 失效")))
        assertFalse(text, text.contains("dshr_9f2cAbCdEfGh1234567890"))
        assertTrue(text, text.contains("dshr****"))
    }

    @Test
    fun `崩溃前日志只保留最近 200 行`() {
        val lines = (1..500).map { "line-$it" }
        val text = report(logLines = lines)
        assertFalse("最早的日志应该被丢掉", text.contains("line-1\n"))
        assertTrue(text, text.contains("line-500"))
        assertTrue(text, text.contains("line-301"))
        assertTrue(text, text.contains("最近 200 行"))
    }

    @Test
    fun `超大异常与超长日志不会把报告撑爆`() {
        // 服务端回来的文本是不可信输入：一条 4 MiB 的 message 不能变成 4 MiB 的崩溃文件
        val huge = RuntimeException("x".repeat(4 * 1024 * 1024))
        val text = report(error = huge, logLines = List(50) { "y".repeat(64 * 1024) })

        assertTrue("报告必须远小于原始输入", text.length < 256 * 1024)
        assertTrue("message 保留前 2000 字", text.contains("x".repeat(2000)))
        assertFalse("第 2001 字起必须被丢掉", text.contains("x".repeat(2001)))
    }

    @Test
    fun `报告超长时截断并留提示`() {
        // device 段没有单独限长（真实来源是 Build.*，天然有界），用它把正文顶过 256 KiB 上限
        val text = report(device = "d".repeat(300 * 1024))
        assertTrue(text.length < 300 * 1024)
        assertTrue(text, text.contains("已截断"))
    }

    // ───────────────────────── throwable 渲染 ─────────────────────────

    @Test
    fun `帧数与 cause 深度都被限制`() {
        val deep = RuntimeException("root")
        var current: Throwable = deep
        repeat(40) {
            current = RuntimeException("wrap-$it", current)
        }

        val text = CrashReporter.describeThrowable(current, maxFrames = 5, maxCauseDepth = 3)
        assertTrue(text, text.contains("wrap-39"))
        assertEquals("只应展开 3 层 cause", 3, Regex("wrap-\\d+").findAll(text).count())
        assertTrue(text, text.contains("cause 链超过 3 层，已截断"))
    }

    @Test
    fun `帧数超过上限时提示省略了多少帧`() {
        val error = RuntimeException("many frames").also {
            it.stackTrace = Array(400) { index -> StackTraceElement("C$index", "m$index", "F.kt", index) }
        }
        val text = CrashReporter.describeThrowable(error, maxFrames = 10)
        assertTrue(text, text.contains("省略 390 帧"))
    }

    @Test
    fun `环形 cause 链被切断而不是死循环`() {
        val a = RuntimeException("A")
        val b = RuntimeException("B")
        a.initCause(b)
        b.initCause(a)

        val text = CrashReporter.describeThrowable(a)
        assertTrue(text, text.contains("A"))
        assertTrue(text, text.contains("B"))
        assertTrue(text, text.contains(CrashReporter.CAUSE_CYCLE_MARKER))
        assertEquals("两个异常只应各出现一次", 1, Regex("java\\.lang\\.RuntimeException: B").findAll(text).count())
    }

    @Test
    fun `equals 恒等的不同异常不会被误判成循环引用`() {
        // 判定循环必须按【对象身份】而不是 equals：库里有 equals 被覆写成"内容相等"、
        // 甚至恒真的异常类型（例如把 message 当业务标识的比较器），按 equals 判会直接把
        // 正常的 cause 链当成环切断，现场就丢了。
        val a = StickyEquals("A")
        val b = StickyEquals("B")
        val c = StickyEquals("C")
        a.initCause(b)
        b.initCause(c)

        val text = CrashReporter.describeThrowable(a)
        // 注意：这里断言的是**标记常量**而不是字面量 "循环引用"。
        // describeThrowable 的输出里带着栈帧，而栈帧里带着本测试方法自己的名字，
        // 方法名里恰好有"循环引用"四个字 —— 直接 contains("循环引用") 会恒真，
        // 于是这条用例永远失败（2026-10-15 真踩过）。
        assertFalse("不能被误判成循环", text.contains(CrashReporter.CAUSE_CYCLE_MARKER))
        assertTrue(text, text.contains("StickyEquals: A"))
        assertTrue(text, text.contains("StickyEquals: B"))
        assertTrue(text, text.contains("StickyEquals: C"))
    }

    @Test
    fun `没有 message 的异常也能渲染`() {
        val text = CrashReporter.describeThrowable(IllegalStateException())
        assertTrue(text, text.contains("java.lang.IllegalStateException"))
        assertFalse("没有 message 时不应拼出个 null", text.contains("null"))
    }

    // ───────────────────────── 文件名与轮转 ─────────────────────────

    @Test
    fun `崩溃文件名是时间戳且字典序等于时间序`() {
        val early = CrashReporter.fileNameFor(1_700_000_000_000L)
        val late = CrashReporter.fileNameFor(1_700_000_001_000L)

        assertTrue(early, early.startsWith("crash-") && early.endsWith(".txt"))
        assertTrue(early, Regex("""crash-\d{8}-\d{6}-\d{3}\.txt""").matches(early))
        assertTrue("字典序必须与时间序一致（listCrashes 靠它排序）", early < late)
    }

    @Test
    fun `同一毫秒内的第二次崩溃不会覆盖第一次`() {
        val name = CrashReporter.fileNameFor(1_700_000_000_000L)
        val first = CrashReporter.persist(dir, name, "第一次")
        val second = CrashReporter.persist(dir, name, "第二次")

        assertTrue(first.exists())
        assertTrue(second.exists())
        assertTrue(first.name != second.name)
        assertEquals("第一次", first.readText())
        assertEquals("第二次", second.readText())
    }

    @Test
    fun `轮转只保留最新 10 份`() {
        repeat(13) { index ->
            // 文件名带时间戳，字典序即时间序；这里按秒递增构造
            CrashReporter.persist(dir, CrashReporter.fileNameFor(1_700_000_000_000L + index * 1000L), "报告 $index")
        }
        val rest = CrashReporter.listCrashes(dir)
        assertEquals(10, rest.size)
        assertTrue("最新一份必须在", rest.first().name.contains(CrashReporter.fileNameFor(1_700_000_012_000L)))
        assertTrue("最旧的三份必须被删掉", rest.none { it.readText() in listOf("报告 0", "报告 1", "报告 2") })
    }

    @Test
    fun `目录不存在时列举返回空而不是抛异常`() {
        val missing = java.io.File(dir, "not-yet")
        assertTrue(CrashReporter.listCrashes(missing).isEmpty())
        assertNull(CrashReporter.readLatest(missing))
        assertNull(CrashReporter.summarize(missing))
        assertNull(CrashReporter.summarize(null))
        // prune 面对不存在的目录也不能抛
        CrashReporter.prune(missing, 3)
    }

    @Test
    fun `非崩溃文件不会被当成崩溃记录`() {
        dir.mkdirs()
        java.io.File(dir, "crash-20231114-221320-000.txt").writeText("真实报告")
        java.io.File(dir, "crash-20231114-221320-000.txt.bak").writeText("备份")
        java.io.File(dir, "notes.txt").writeText("随手记")
        java.io.File(dir, "crash-").writeText("半截名字")

        val found = CrashReporter.listCrashes(dir)
        assertEquals(1, found.size)
        assertEquals("crash-20231114-221320-000.txt", found.first().name)
    }

    // ───────────────────────── 读取与摘要 ─────────────────────────

    @Test
    fun `落盘的报告能读回来并解析出摘要`() {
        val file = CrashReporter.persist(dir, CrashReporter.fileNameFor(1_700_000_000_000L), report())

        val latest = CrashReporter.readLatest(dir)
        assertNotNull(latest)
        assertTrue(latest!!, latest.contains("DSH Remote 崩溃报告"))

        val summary = CrashReporter.summarize(dir)
        assertNotNull(summary)
        assertEquals(file.name, summary!!.fileName)
        assertTrue(summary.time, summary.time.isNotEmpty() && summary.time != "未知")
        assertEquals("main", summary.thread)
        assertEquals("java.lang.RuntimeException", summary.cause)
        assertTrue(summary.path, summary.path.endsWith(file.name))
    }

    @Test
    fun `读最新一份时按上限截断`() {
        CrashReporter.persist(dir, CrashReporter.fileNameFor(1_700_000_000_000L), "A".repeat(10_000))
        assertEquals(64, CrashReporter.readLatest(dir, maxChars = 64)!!.length)
    }

    @Test
    fun `摘要字段缺失时降级为未知`() {
        dir.mkdirs()
        java.io.File(dir, "crash-20231114-221320-000.txt").writeText("不是一个正常的崩溃报告\n只有两行")
        val summary = CrashReporter.summarize(dir)
        assertNotNull(summary)
        assertEquals("未知", summary!!.time)
        assertEquals("未知", summary.thread)
        assertEquals("未知", summary.cause)
    }

    @Test
    fun `写入时间不同的多份报告按时间倒序排列`() {
        // 文件名一律由 fileNameFor 现算：断言写死日期会在非 UTC 时区的机器上翻车
        val newer = CrashReporter.fileNameFor(1_700_000_002_000L)
        val older = CrashReporter.fileNameFor(1_700_000_001_000L)
        CrashReporter.persist(dir, older, "更早的一份")
        CrashReporter.persist(dir, newer, "正常的一份")

        val list = CrashReporter.listCrashes(dir)
        assertEquals(2, list.size)
        assertEquals("最新的排在最前", newer, list.first().name)
        assertEquals(older, list.last().name)
        assertEquals("正常的一份", CrashReporter.readLatest(dir))
    }

    /** equals/hashCode 都被覆写成"永远相等"的异常，用来验证循环检测走的是对象身份。 */
    private class StickyEquals(message: String) : RuntimeException(message) {
        override fun equals(other: Any?): Boolean = true
        override fun hashCode(): Int = 1
    }
}
