package com.deepseek.dshremote.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val DarkScheme = darkColorScheme(
    primary = DshPrimary,
    onPrimary = DshOnPrimary,
    secondary = DshSecondary,
    tertiary = DshTertiary,
    error = DshError,
    background = DshBackground,
    onBackground = DshOnBackground,
    surface = DshSurface,
    onSurface = DshOnBackground,
    surfaceVariant = DshSurfaceVariant,
    onSurfaceVariant = DshOnSurfaceVariant,
    outline = DshOutline,
)

private val LightScheme = lightColorScheme(
    primary = LightPrimary,
    secondary = LightSecondary,
    tertiary = LightTertiary,
)

/**
 * 应用主题。
 *
 * 恒定的 Material3 结构，只是把暗色方案设为默认（本 App 的核心界面是一块终端输出区），
 * 用户系统是浅色时仍提供可读的浅色方案，而不是强行暗色。
 */
@Composable
fun DshRemoteTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkScheme else LightScheme,
        typography = DshTypography,
        content = content,
    )
}
