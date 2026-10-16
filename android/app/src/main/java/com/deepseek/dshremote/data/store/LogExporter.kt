package com.deepseek.dshremote.data.store

import android.content.Context
import com.deepseek.dshremote.data.CrashReporter
import com.deepseek.dshremote.data.Logger
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 日志导出（设置页"导出日志"）。
 *
 * 两条约束：
 * 1. 导出内容必须**已经脱敏**——[Logger.snapshot] 里的每一行都过了 `redact()`，
 *    调用方补充的 [extraLines] 也必须自己保证不含令牌（当前调用点只放地址与状态）；
 * 2. 写到 `getExternalFilesDir`（应用外部私有目录）：用户能用文件管理器取走，
 *    又不需要任何存储权限（Android 10+ 的 scoped storage 下最省事）。
 */
object LogExporter {

    /** 导出时携带的崩溃报告份数（完整报告始终留在 filesDir/crashes，这里只带最近几次）。 */
    private const val MAX_CRASH_REPORTS = 3

    fun export(context: Context, extraLines: List<String> = emptyList()): File {
        val dir = context.getExternalFilesDir(null) ?: context.filesDir
        if (!dir.exists()) dir.mkdirs()
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        val file = File(dir, "dsh-remote-log-$stamp.txt")
        // 崩溃报告与运行日志同源（都过 Logger.redact），因此直接内联进同一份导出文件，
        // 用户点一次「导出自检日志」就同时拿到崩溃现场，不需要第二个入口
        val crashes = runCatching { CrashReporter.listCrashes(context) }.getOrDefault(emptyList())
        file.writeText(buildString {
            appendLine("=== DSH Remote 诊断日志 ===")
            appendLine("导出时间：${SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date())}")
            appendLine("应用版本：${appVersion(context)}")
            appendLine("设备：${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL} / Android ${android.os.Build.VERSION.RELEASE}")
            appendLine("令牌与配对码已脱敏（前 4 位 + ****）")
            if (extraLines.isNotEmpty()) {
                appendLine("--- 连接状态 ---")
                extraLines.forEach { appendLine(it) }
            }
            appendLine("--- 崩溃记录（本机共 ${crashes.size} 份，目录 filesDir/${CrashReporter.DIR_NAME}）---")
            if (crashes.isEmpty()) {
                appendLine("（无崩溃记录）")
            } else {
                crashes.take(MAX_CRASH_REPORTS).forEach { crash ->
                    appendLine()
                    appendLine("### ${crash.name}")
                    appendLine(runCatching { crash.readText(Charsets.UTF_8) }.getOrElse { "（读取失败：${it.message}）" })
                }
            }
            appendLine("--- 运行日志（最近 ${Logger.snapshot().size} 行）---")
            Logger.snapshot().forEach { appendLine(it) }
        }, Charsets.UTF_8)
        Logger.i(TAG, "日志已导出：${file.absolutePath}")
        return file
    }

    private fun appVersion(context: Context): String = runCatching {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        "${info.versionName} (${info.longVersionCode})"
    }.getOrDefault("unknown")

    private const val TAG = "LogExporter"
}
