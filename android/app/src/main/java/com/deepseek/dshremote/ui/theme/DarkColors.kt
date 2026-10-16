package com.deepseek.dshremote.ui.theme

import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color

/**
 * 方向 A「纯黑极简」调色板 —— 对标 ChatGPT / Claude 现行深色语言。
 *
 * 三条规则（改色前先读）：
 * 1. 底真黑、面近黑、白字：底 #000000，面 #141414 / #1E1E1E，正文 #ECECEC。
 * 2. 强调色只出现在「可操作」与「正在发生」两类元素上：主按钮、发送键、FAB、
 *    导航选中态、运行中指示点。其余一律灰阶。
 * 3. 状态色是语义色，不是装饰色：绿=成功/运行中，琥珀=等待交互/警告，红=失败，
 *    蓝=代码 hunk 头与链接。不要把强调色当品牌底色铺开。
 *
 * 色板基线见 docs/01-设计/原型/README.md，样张见 .proto-out/01..06-*.png。
 *
 * 与原型脚本对齐（2026-10-14）：以下三处语义色以 `docs/01-设计/原型/gen_*.py` 实际写死的色值为准，
 * 而不是让画稿迁就旧代码 —— 画稿是这次的视觉基线：
 * - accentGreen `#4CC38A` → `#3FBF7F`（DshSuccess / DshLive，画稿绿更低饱和）
 * - accentAmber `#E0A15C` → `#E0A33E`（DshWarning / DshTertiary，画稿琥珀更黄）
 * - accentRed   `#FF5A52` → `#E5484D`（DshError，画稿红更收敛）
 * 面/次文字色同时对齐为 `#1C1C1E` / `#242426` / `#B4B4B4`；`DshSecondary` 从灰改回画稿的 `#E08B6E`
 * （画稿里 secondary 是橙族第二色，中性灰另有 `DshNeutral`）。
 */

// 底与面
val DshBackground = Color(0xFF000000)
val DshSurface = Color(0xFF141414)
val DshSurfaceVariant = Color(0xFF1C1C1E)
val DshSurfaceHigh = Color(0xFF242426)

// 强调色（Claude 陶土橙系）—— 只给主操作与运行中
val DshPrimary = Color(0xFFD97757)
val DshPrimaryContainer = Color(0xFF3A2318)
val DshOnPrimary = Color(0xFFFFFFFF)
val DshSecondary = Color(0xFFE08B6E)
val DshTertiary = Color(0xFFE0A33E)

// 文本
val DshOnBackground = Color(0xFFECECEC)
val DshOnSurfaceVariant = Color(0xFFB4B4B4)
val DshOutline = Color(0xFF2A2A2A)
val DshHairline = Color(0xFF222222)

// 语义色
val DshError = Color(0xFFE5484D)
val DshSuccess = Color(0xFF3FBF7F)
val DshWarning = Color(0xFFE0A33E)

/** 运行中呼吸点（会话列表 / 对话流的 live 指示）。 */
val DshLive = Color(0xFF3FBF7F)

/** 非强调的中性图标/次要标记。 */
val DshNeutral = Color(0xFF8A8A8A)

// 代码 / diff —— 取值同画稿（`gen_02_detail.py:101` / `gen_05_workspace.py:75-98`）：
// hunk 头不是蓝而是**橙族第二色 SECONDARY**，增删行的底/字比旧值更收敛。
val DshCodeText = Color(0xFFC9C9C9)
val DshDiffAddedBg = Color(0xFF0E2A1C)
val DshDiffAddedText = Color(0xFF8FE0B0)
val DshDiffRemovedBg = Color(0xFF2E1417)
val DshDiffRemovedText = Color(0xFFF09A9A)
val DshDiffHunkText = DshSecondary
val DshDiffMetaText = DshNeutral

// git 徽标
val DshBadgeModified = DshWarning
val DshBadgeAdded = DshSuccess
val DshBadgeDeleted = DshError
val DshBadgeUntracked = DshNeutral
val DshBadgeRenamed = DshSecondary

val DshDarkScheme = darkColorScheme(
    primary = DshPrimary,
    onPrimary = DshOnPrimary,
    primaryContainer = DshPrimaryContainer,
    onPrimaryContainer = DshOnBackground,
    secondary = DshSecondary,
    onSecondary = DshOnPrimary,
    secondaryContainer = DshPrimary.copy(alpha = 0.18f),
    onSecondaryContainer = DshPrimary,
    tertiary = DshTertiary,
    onTertiary = Color(0xFF231A00),
    tertiaryContainer = DshWarning.copy(alpha = 0.14f),
    onTertiaryContainer = DshWarning,
    error = DshError,
    onError = Color(0xFF1A0000),
    errorContainer = DshError.copy(alpha = 0.12f),
    onErrorContainer = DshError,
    background = DshBackground,
    onBackground = DshOnBackground,
    surface = DshSurface,
    onSurface = DshOnBackground,
    surfaceVariant = DshSurfaceVariant,
    onSurfaceVariant = DshOnSurfaceVariant,
    outline = DshOutline,
    outlineVariant = DshHairline,
    surfaceContainerLowest = DshBackground,
    surfaceContainerLow = DshSurface,
    surfaceContainer = DshSurface,
    surfaceContainerHigh = DshSurfaceVariant,
    surfaceContainerHighest = DshSurfaceHigh,
    surfaceTint = DshPrimary,
    surfaceBright = DshSurfaceHigh,
    surfaceDim = DshBackground,
    inverseSurface = DshOnBackground,
    inverseOnSurface = DshBackground,
    inversePrimary = DshPrimaryContainer,
    scrim = Color(0xFF000000),
)

/** 浅色降级方案：只保证可读，不做设计打磨（默认不启用）。 */
val DshLightScheme = lightColorScheme(
    primary = LightPrimary,
    secondary = LightSecondary,
    tertiary = LightTertiary,
    background = Color(0xFFF7F8FA),
    onBackground = Color(0xFF16181C),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF16181C),
    surfaceVariant = Color(0xFFEFF1F5),
    onSurfaceVariant = Color(0xFF4A4F58),
    outline = Color(0xFFC9CDD4),
)
