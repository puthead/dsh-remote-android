package com.deepseek.dshremote.data

import android.content.Context
import android.os.Build
import android.os.Process
import com.deepseek.dshremote.BuildConfig
import java.io.File
import java.text.SimpleDateFormat
import java.util.Collections
import java.util.Date
import java.util.IdentityHashMap
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineExceptionHandler

/**
 * 全局崩溃取证（设置页「崩溃记录」与日志导出都读它）。
 *
 * 三条不可动摇的约束：
 * 1. **不改变进程的死亡方式**：本 handler 只负责"写下来"，写完仍然把异常交回安装前的
 *    旧 handler（系统默认实现），由它走 tombstone / Play 上报 / `adb logcat -b crash`。
 *    所以顺序是「先落盘 → 再交回」，反过来就没机会写了（默认 handler 直接杀进程）。
 * 2. **handler 自身绝不能再抛**：整条链路 try/catch 全包，并且限制堆栈帧数、cause 链
 *    深度与报告总长；循环引用的 cause 链也会被切断。
 * 3. **不做"捕获后继续跑"**：崩溃后进程必须干净结束，否则内存状态已经坏了，
 *    继续跑只会产生更难查的二次崩溃。下次启动时把上次的崩溃读出来展示/导出即可。
 *
 * 落盘位置是 `filesDir/crashes/crash-<yyyyMMdd-HHmmss-SSS>.txt`：app 私有目录，
 * 不需要任何存储权限，debug 包可以用 `adb shell run-as <applicationId>` 直接读走
 * （见 `scripts/collect-crash.ps1`）。
 */
object CrashReporter {

    /** 崩溃目录名（在 `filesDir` 下）。 */
    const val DIR_NAME = "crashes"

    private const val TAG = "CrashReporter"
    private const val PREFIX = "crash-"
    private const val SUFFIX = ".txt"

    /** 最多保留的崩溃文件数：崩溃循环时也不能把磁盘写满。 */
    private const val MAX_FILES = 10

    /** 单个 throwable 最多写多少帧 / cause 链最多多少层。 */
    private const val MAX_FRAMES = 200
    private const val MAX_CAUSE_DEPTH = 12
    private const val MAX_MESSAGE_CHARS = 2000

    /** 崩溃前日志最多带多少行（Logger 环形缓冲本身上限 500 行）。 */
    private const val MAX_LOG_LINES = 200

    /** 各段长度上限，防止一条巨长的服务端消息把报告撑爆。 */
    private const val MAX_STACK_CHARS = 96 * 1024
    private const val MAX_LOG_CHARS = 64 * 1024
    private const val MAX_BODY_CHARS = 256 * 1024

    /** 设置页只展示报告头部，不把整个堆栈塞进 UI。 */
    private const val PREVIEW_CHARS = 4000

    private val installed = AtomicBoolean(false)
    private val appContextRef = AtomicReference<Context?>(null)
    private val crashDirRef = AtomicReference<File?>(null)

    /**
     * 安装全局未捕获异常兜底。幂等：重复调用只生效第一次（保留的旧 handler 不会被链式套娃）。
     *
     * 应在 `Application.onCreate` 的**最前面**调用，这样连依赖图初始化阶段的崩溃也能抓到。
     */
    fun install(context: Context) {
        val app = runCatching { context.applicationContext }.getOrNull() ?: return
        appContextRef.set(app)
        if (!installed.compareAndSet(false, true)) return
        // 先取出系统默认 handler（Android 上是 RuntimeInit 装的 KillApplicationHandler）
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            handleUncaught(thread, error, previous)
        }
        Logger.i(TAG, "全局崩溃兜底已安装，落盘目录=${crashDirPath(app)}")
    }

    /**
     * 应用级协程异常处理器。
     *
     * 挂在 `SupervisorJob` 的 scope 上（见 [com.deepseek.dshremote.Graph]）：父 Job 是 Supervisor
     * 时，子协程的异常不会取消兄弟协程，但**如果没有这个 handler 就会被丢给线程的未捕获
     * 异常处理器 → 直接崩进程**。装上它以后，协程异常退化成"记录 + 继续跑"。
     */
    val coroutineHandler: CoroutineExceptionHandler = CoroutineExceptionHandler { context, error ->
        try {
            Logger.e(TAG, "协程未捕获异常（协程异常不会崩进程，已记录）", error)
            record("协程", Thread.currentThread().name, error)
        } catch (ignored: Throwable) {
            // 记录失败也不能反过来崩进程
        }
    }

    /** 崩溃目录（可能尚不存在）。 */
    fun crashDir(context: Context): File? = crashDirRef.get()
        ?: runCatching { context.applicationContext?.filesDir?.let { File(it, DIR_NAME) } }.getOrNull()
            ?.also { crashDirRef.set(it) }

    /** `filesDir/crashes` 的绝对路径，仅用于日志展示。 */
    private fun crashDirPath(context: Context): String =
        runCatching { crashDir(context)?.absolutePath ?: "（不可用）" }.getOrDefault("（不可用）")

    /** 已落盘的崩溃报告，新的在前。 */
    fun listCrashes(context: Context): List<File> =
        crashDir(context)?.let { listCrashes(it) } ?: emptyList()

    /** 最新一份崩溃报告的预览文本（只取头部，避免在 UI 里渲染整个堆栈）。 */
    fun readLatest(context: Context, maxChars: Int = PREVIEW_CHARS): String? =
        crashDir(context)?.let { readLatest(it, maxChars) }

    /** 最新崩溃的摘要行（时间 / 异常 / 线程），给设置页用。 */
    fun summarize(context: Context): CrashSummary? = summarize(crashDir(context))

    /** 清空崩溃记录（设置页「清除崩溃记录」）。 */
    fun clearAll(context: Context) {
        runCatching { crashDir(context)?.let { listCrashes(it).forEach { file -> file.delete() } } }
    }

    // ───────────────────────── 崩溃处理 ─────────────────────────

    private fun handleUncaught(
        thread: Thread,
        error: Throwable,
        previous: Thread.UncaughtExceptionHandler?,
    ) {
        try {
            // 1) 先落盘：此刻进程还活着，文件系统还能用
            record("未捕获异常", thread.name, error)
        } catch (ignored: Throwable) {
            // 绝不因为取证失败改变崩溃语义
        }
        try {
            // 2) 再交回旧 handler：tombstone / Play 上报 / `logcat -b crash` 都靠它
            if (previous != null) {
                previous.uncaughtException(thread, error)
            } else {
                // JVM 兜底：没有默认 handler 时自己干净退出（非 0 退出码表示异常终止）
                Process.killProcess(Process.myPid())
                kotlin.system.exitProcess(10)
            }
        } catch (ignored: Throwable) {
            runCatching { kotlin.system.exitProcess(10) }
        }
    }

    /**
     * 记录一次异常。任何内部失败都被吞掉——调用点包含崩溃 handler 与协程 handler，
     * 这里再抛异常会造成二次崩溃。
     */
    private fun record(kind: String, threadName: String, error: Throwable) {
        runCatching {
            val timestamp = System.currentTimeMillis()
            val report = Logger.redact(
                buildReport(
                    kind = kind,
                    timestamp = timestamp,
                    threadName = threadName,
                    error = error,
                    versionName = versionName(),
                    versionCode = versionCode(),
                    buildType = if (BuildConfig.DEBUG) "debug" else "release",
                    device = deviceSummary(),
                    logLines = Logger.snapshot(),
                ),
            )
            val file = appContextRef.get()?.let { crashDir(it) }?.let { dir ->
                runCatching { persist(dir, fileNameFor(timestamp), report) }.getOrNull()
            }
            // 同时进内存环形缓冲 + logcat，这样"导出自检日志"和 adb logcat 都能看到
            Logger.e(TAG, "崩溃已记录[${kind}] ${file?.absolutePath ?: "（无私有目录，未落盘）"}")
        }
    }

    // ───────────────────────── 纯函数（可单测） ─────────────────────────

    /** 崩溃文件名：`crash-<yyyyMMdd-HHmmss-SSS>.txt`，字典序即时间序。 */
    internal fun fileNameFor(timestamp: Long): String =
        PREFIX + SimpleDateFormat("yyyyMMdd-HHmmss-SSS", Locale.US).format(Date(timestamp)) + SUFFIX

    /**
     * cause 链成环时的标记。
     *
     * 单独抽成常量是给单测用的：**别在断言里直接写 `contains("循环引用")`**。
     * `describeThrowable` 的输出里包含栈帧文本，而栈帧里带着测试方法自己的名字，
     * 方法名一叫「…不会被误判成循环引用」就会让断言恒真（本轮真踩过这个坑）。
     */
    internal const val CAUSE_CYCLE_MARKER = "<cause 链存在循环引用，已截断>"

    /**
     * 组装报告正文。纯函数：不碰 Android API、不碰磁盘，便于 JVM 单测直接断言。
     */
    internal fun buildReport(
        kind: String,
        timestamp: Long,
        threadName: String,
        error: Throwable,
        versionName: String,
        versionCode: Long,
        buildType: String,
        device: String,
        logLines: List<String>,
    ): String {
        val time = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(Date(timestamp))
        val stack = describeThrowable(error).take(MAX_STACK_CHARS)
        val logs = logLines.takeLast(MAX_LOG_LINES).joinToString("\n").take(MAX_LOG_CHARS)
        val body = buildString {
            appendLine("=== DSH Remote 崩溃报告 ===")
            appendLine("类型：$kind")
            appendLine("时间：$time")
            appendLine("线程：$threadName")
            appendLine("异常：${error.javaClass.name}")
            appendLine("应用版本：$versionName ($versionCode) · $buildType")
            appendLine("设备：$device")
            appendLine("--- 堆栈 ---")
            appendLine(stack)
            appendLine("--- 崩溃前应用日志（最近 ${logLines.takeLast(MAX_LOG_LINES).size} 行）---")
            append(logs)
            appendLine()
        }
        return if (body.length <= MAX_BODY_CHARS) {
            body
        } else {
            body.take(MAX_BODY_CHARS) + "\n... 报告超过 ${MAX_BODY_CHARS / 1024} KiB，已截断\n"
        }
    }

    /**
     * 渲染 throwable：限制帧数与 cause 深度，并用 identity 集合切断环形 cause 链。
     *
     * 不用 `stackTraceToString()` 的原因就是它三个限制都没有——服务端回来一个自引用异常
     * 就能让取证代码自己 OOM。
     */
    internal fun describeThrowable(
        error: Throwable,
        maxFrames: Int = MAX_FRAMES,
        maxCauseDepth: Int = MAX_CAUSE_DEPTH,
    ): String {
        val out = StringBuilder()
        val seen = Collections.newSetFromMap(IdentityHashMap<Throwable, Boolean>())
        var current: Throwable? = error
        var depth = 0
        while (current != null && depth < maxCauseDepth) {
            if (!seen.add(current)) {
                out.append("Caused by: ").append(CAUSE_CYCLE_MARKER).append('\n')
                current = null
                break
            }
            if (depth > 0) out.append("Caused by: ")
            out.append(current.javaClass.name)
            current.message?.let { out.append(": ").append(it.take(MAX_MESSAGE_CHARS)) }
            out.append('\n')
            val frames = current.stackTrace
            for (index in 0 until minOf(frames.size, maxFrames)) {
                out.append("\tat ").append(frames[index].toString()).append('\n')
            }
            if (frames.size > maxFrames) {
                out.append("\t... 省略 ${frames.size - maxFrames} 帧\n")
            }
            current = current.cause
            depth++
        }
        if (current != null) out.append("... cause 链超过 $maxCauseDepth 层，已截断\n")
        return out.toString()
    }

    /** 写入报告并轮转。返回落盘文件。 */
    internal fun persist(dir: File, fileName: String, report: String): File {
        if (!dir.exists()) dir.mkdirs()
        // 同一毫秒内连续两次崩溃（崩溃循环）：加后缀避免互相覆盖
        var file = File(dir, fileName)
        var suffix = 1
        while (file.exists() && suffix < 100) {
            file = File(dir, fileName.removeSuffix(SUFFIX) + "-$suffix" + SUFFIX)
            suffix++
        }
        file.writeText(report, Charsets.UTF_8)
        prune(dir, MAX_FILES)
        return file
    }

    /** 只保留最新的 [keep] 份崩溃报告（文件名是时间戳，字典序即时间序）。 */
    internal fun prune(dir: File, keep: Int) {
        listCrashes(dir).drop(keep).forEach { runCatching { it.delete() } }
    }

    /** 已落盘报告，新的在前；目录不存在时返回空列表而不是抛异常。 */
    internal fun listCrashes(dir: File): List<File> {
        val files = runCatching {
            dir.listFiles { file ->
                file.isFile && file.name.startsWith(PREFIX) && file.name.endsWith(SUFFIX)
            }
        }.getOrNull() ?: return emptyList()
        return files.sortedByDescending { it.name }
    }

    internal fun readLatest(dir: File, maxChars: Int = PREVIEW_CHARS): String? =
        listCrashes(dir).firstOrNull()?.let { file ->
            runCatching { file.readText(Charsets.UTF_8).take(maxChars) }.getOrNull()
        }

    internal fun summarize(dir: File?): CrashSummary? {
        val file = dir?.let { listCrashes(it).firstOrNull() } ?: return null
        val head = runCatching { file.readLines(Charsets.UTF_8).take(24) }.getOrDefault(emptyList())
        fun field(label: String): String =
            head.firstOrNull { it.startsWith(label) }?.removePrefix(label)?.trim().orEmpty()
        return CrashSummary(
            fileName = file.name,
            time = field("时间：").ifEmpty { "未知" },
            thread = field("线程：").ifEmpty { "未知" },
            cause = field("异常：").ifEmpty { "未知" },
            path = runCatching { file.absolutePath }.getOrDefault(file.name),
        )
    }

    // ───────────────────────── 环境信息 ─────────────────────────

    private fun versionName(): String = runCatching { BuildConfig.VERSION_NAME }.getOrDefault("unknown")

    private fun versionCode(): Long = runCatching { BuildConfig.VERSION_CODE.toLong() }.getOrDefault(0L)

    /**
     * 设备信息。全部走 `runCatching`：单测运行时 `android.os.Build` 是空壳，
     * 字段可能是 null，静默降级成 unknown 而不是让取证自己崩掉。
     */
    private fun deviceSummary(): String = runCatching {
        val manufacturer = Build.MANUFACTURER.orEmpty()
        val model = Build.MODEL.orEmpty()
        val release = Build.VERSION.RELEASE.orEmpty()
        val sdk = Build.VERSION.SDK_INT
        val abis = Build.SUPPORTED_ABIS?.joinToString(",").orEmpty()
        val suffix = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            runCatching { Build.SOC_MANUFACTURER.orEmpty() + " " + Build.SOC_MODEL.orEmpty() }.getOrDefault("")
        } else {
            Build.HARDWARE.orEmpty()
        }
        listOf(manufacturer, model, "Android $release (API $sdk)", abis, suffix)
            .filter { it.isNotBlank() }
            .joinToString(" / ")
            .ifBlank { "unknown" }
    }.getOrDefault("unknown")

    /** 设置页展示用的崩溃摘要。 */
    data class CrashSummary(
        val fileName: String,
        val time: String,
        val thread: String,
        val cause: String,
        val path: String,
    )
}
