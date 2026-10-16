package com.deepseek.dshremote.ui.components

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 时间/大小/耗时的统一格式化。
 *
 * 放在一处的原因：会话列表、对话流、改动列表都要显示时间，
 * 各写一份必然出现"同一时刻显示成两种样子"的不一致。
 */
object Fmt {

    private val dateTime = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault())
    private val clock = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    /** 相对时间（会话列表用）：刚刚 / N 分钟前 / N 小时前 / N 天前 / 具体时间。 */
    fun relative(millis: Long, now: Long = System.currentTimeMillis()): String {
        if (millis <= 0L) return "—"
        val diff = now - millis
        return when {
            diff < 0 -> "刚刚"
            diff < 60_000L -> "刚刚"
            diff < 3_600_000L -> "${diff / 60_000L} 分钟前"
            diff < 86_400_000L -> "${diff / 3_600_000L} 小时前"
            diff < 7 * 86_400_000L -> "${diff / 86_400_000L} 天前"
            else -> dateTime.format(Date(millis))
        }
    }

    fun dateTime(millis: Long?): String =
        if (millis == null || millis <= 0L) "—" else dateTime.format(Date(millis))

    fun clock(millis: Long): String = clock.format(Date(millis))

    /** 耗时：<60s 显示 `12.3s`，否则 `3m12s`，超过 1 小时 `1h02m`。 */
    fun duration(millis: Long): String {
        val seconds = (millis / 1000.0).coerceAtLeast(0.0)
        return when {
            millis <= 0L -> "—"
            seconds < 60 -> String.format(Locale.US, "%.1fs", seconds)
            seconds < 3600 -> "${(seconds / 60).toInt()}m${(seconds % 60).toInt()}s"
            else -> "${(seconds / 3600).toInt()}h${((seconds % 3600) / 60).toInt()}m"
        }
    }

    fun size(bytes: Long): String = when {
        bytes < 1024 -> "${bytes}B"
        bytes < 1024 * 1024 -> String.format(Locale.US, "%.1fKB", bytes / 1024.0)
        else -> String.format(Locale.US, "%.1fMB", bytes / 1024.0 / 1024.0)
    }

    /** 行数角标：`+42 −7`（改动列表与 diff 页共用）。 */
    fun counts(insertions: Int, deletions: Int): String = "+$insertions −$deletions"
}
