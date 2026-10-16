package com.deepseek.dshremote.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider

/**
 * 应用主题。
 *
 * **深色是默认值**（`darkTheme = true`），浅色只有在用户显式打开"浅色模式"时才使用；
 * v1 的"跟随系统"在这里被有意去掉：远程控制台的主题不该被系统设置悄悄改掉。
 *
 * 三件事必须一起换，否则界面会「一半是画稿、一半是 M3 默认」：
 * - `colorScheme`：方向 A 色板（`DshDarkScheme`）；
 * - `typography`：方向 A 字号（`DshType`，同时铺满 15 个 M3 槽位，漏配即退回 22sp 大字号）；
 * - `shapes`：方向 A 圆角（`DshShapes`，避免 M3 默认 28dp 圆角泄漏到对话框/芯片上）。
 *
 * 另外把字号与栅格放进 CompositionLocal，页面里可以直接写 `LocalDshType.current.cardTitle`、
 * `LocalDshDimens.current.pageMargin`，不必层层传参。
 */
@Composable
fun DshRemoteTheme(
    darkTheme: Boolean = true,
    content: @Composable () -> Unit,
) {
    val type = if (darkTheme) DshType.dark() else DshType.light()
    CompositionLocalProvider(
        LocalDshType provides type,
        LocalDshDimens provides DshDimens.Default,
    ) {
        MaterialTheme(
            colorScheme = if (darkTheme) DshDarkScheme else DshLightScheme,
            typography = type.toMaterialTypography(),
            shapes = DshShapes,
            content = content,
        )
    }
}
