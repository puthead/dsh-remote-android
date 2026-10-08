package com.deepseek.dshremote.data

import android.util.Log
import com.deepseek.dshremote.BuildConfig

/**
 * 极简日志门面。
 *
 * 存在的理由：安全红线要求"令牌不落日志"，所以集中在这里做**脱敏**，
 * 而不是在每个调用点靠自觉。
 */
object Logger {

    private const val MAX_TAG = 23

    fun d(tag: String, message: String) {
        if (BuildConfig.DEBUG) Log.d(tag.take(MAX_TAG), redact(message))
    }

    fun i(tag: String, message: String) {
        Log.i(tag.take(MAX_TAG), redact(message))
    }

    fun w(tag: String, message: String, throwable: Throwable? = null) {
        Log.w(tag.take(MAX_TAG), redact(message), throwable)
    }

    fun e(tag: String, message: String, throwable: Throwable? = null) {
        Log.e(tag.take(MAX_TAG), redact(message), throwable)
    }

    /** 把 `dshr_...` 形态的令牌与 Bearer 头替换掉，避免日志泄露凭据。 */
    fun redact(message: String): String {
        var result = message
        TOKEN_PATTERN.findAll(result).forEach { match ->
            val token = match.value
            val tail = token.takeLast(4)
            result = result.replace(token, "dshr_***$tail")
        }
        return result
    }

    private val TOKEN_PATTERN = Regex("dshr_[A-Za-z0-9_\\-]{8,}")
}
