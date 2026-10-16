package com.deepseek.dshremote.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * 方向 A 栅格与形状 —— 逐项对齐 `docs/01-设计/原型/proto_kit.py`。
 *
 * 原型是 1080×2340 / 3x 的画稿，即 **360×780dp**；所有画稿里的 `N*3` 像素常量除以 3 就是这里的 dp。
 * 关键结论只有五条：
 * 1. 屏幕左右边距固定 **20dp**，内容宽 320dp —— 不是 M3 的 16dp，也不是 12dp。
 * 2. 卡片圆角 **16dp**（主卡）/ 14dp（工具卡、轨迹步骤卡、diff 卡、提示卡）/ 12dp（次级卡、输入框、横幅）。
 * 3. 纵向节奏是 **8dp 的倍数**：区块间距 12dp、卡间距 14dp、chip 间距 8dp、对话节点 6dp。
 * 4. 描边统一 **1dp 实色**（画稿里是 2px @3x ≈ 0.67dp，Compose 最小可用 1dp），分隔线同色但缩进 14dp。
 * 5. 触摸目标与视觉尺寸分离：36dp 圆形图标按钮、34×34dp 导航选中方块、24dp 高 chip、
 *    30dp 高按钮 —— 不为了凑 48dp 而把视觉放大。
 */
@Immutable
data class DshDimens(
    /** 屏幕左右边距。 */
    val pageMargin: Dp = 20.dp,
    /** 主卡内边距。 */
    val cardPad: Dp = 14.dp,
    /** 相邻卡片间距。 */
    val gapCard: Dp = 12.dp,
    /** 同一屏内两个区块之间。 */
    val gapBlock: Dp = 14.dp,
    /** 设置页分组之间。 */
    val gapSection: Dp = 14.dp,
    /** chip 之间。 */
    val gapChip: Dp = 8.dp,
    /** 对话节点 / 轨迹步骤之间。 */
    val gapNode: Dp = 6.dp,
    /** 卡片描边宽度。 */
    val border: Dp = 1.dp,
    /** 分隔线缩进。 */
    val hairlineInset: Dp = 14.dp,
    /** 分裂线厚度。 */
    val hairline: Dp = 1.dp,
    /** 圆形图标按钮直径。 */
    val iconButton: Dp = 36.dp,
    /** chip 默认高度。 */
    val chipHeight: Dp = 24.dp,
    /** 小号 chip（工作区名、轮数等元信息）。 */
    val chipHeightSmall: Dp = 20.dp,
    /** chip 左右内边距。 */
    val chipPadX: Dp = 9.dp,
    /** 按钮高度（停止 / 允许一次 / 拒绝）。 */
    val buttonHeight: Dp = 30.dp,
    /** 主操作按钮（新任务等）高度。 */
    val buttonHeightLarge: Dp = 34.dp,
    /** FAB 直径。 */
    val fab: Dp = 56.dp,
    /** 列表行高：会话行。 */
    val rowSession: Dp = 92.dp,
    /** 列表行高：任务行。 */
    val rowTask: Dp = 88.dp,
    /** 列表行高：文件行。 */
    val rowFile: Dp = 46.dp,
    /** 列表行高：设置行。 */
    val rowSetting: Dp = 45.dp,
    /** 底部导航高度（不含系统手势条）。 */
    val navBarHeight: Dp = 62.dp,
    /** 底部导航选中方块。 */
    val navActiveBox: Dp = 34.dp,
    /** 底部导航单个 tab 内图标视觉尺寸。 */
    val navIcon: Dp = 22.dp,

    // ---- 会话列表「静默状态版」追加项（2026-10 列表重做；**只追加，不改上面任何既有值**）----
    // 上面 rowSession=92dp 是画稿三行 + 来源/工作区双芯片的密度；新版把状态收成"只在值得说时出现"
    // 的一个胶囊、去掉常驻的「可续聊」，行内实际只有「标题 / 预览 / 元信息」三行，
    // 92dp 会空出一大块，所以另给一档而不是改 rowSession（手机任务页仍按 92dp 的语义排）。
    /** 列表行高：会话行（静默状态版，三行 + 左右 14dp）。 */
    val rowSessionQuiet: Dp = 84.dp,
    /** 会话行头像方块边长（工作区标识位）。 */
    val rowAvatar: Dp = 34.dp,
    /** 会话行头像里的图标视觉尺寸。 */
    val rowAvatarIcon: Dp = 16.dp,
    /** 会话行内边距（左右）。 */
    val rowPadX: Dp = 14.dp,
    /** 会话行内边距（上下）。 */
    val rowPadY: Dp = 8.dp,
    /** 列表滚动区的底部留白：FAB(56) + 两倍间距 + 一行脚注的呼吸位，保证最后一行不被 FAB 压住。 */
    val fabClearance: Dp = 96.dp,
    /** 空态 / 错误态卡片的图标方块。 */
    val emptyIconBox: Dp = 44.dp,
) {
    companion object {
        val Default = DshDimens()
    }
}

/** 圆角令牌。 */
object DshRadius {
    /** 主卡 / 新建任务卡 / git 卡。 */
    val Card = 16.dp

    /** 工具卡 / 轨迹步骤卡 / diff 卡 / 提示卡 / 警告条。 */
    val Panel = 14.dp

    /** 次级卡 / 输入框 / 横幅 / 目录选择器 / 思考折叠行 / 流末端 chip。 */
    val Sub = 12.dp

    /** 导航选中方块 / 文件徽标。 */
    val Small = 10.dp

    /** 文件类型徽标。 */
    val Badge = 6.dp

    /** 底部统计条。 */
    val Summary = 18.dp
}

/** 当前主题的栅格。取法：`LocalDshDimens.current.pageMargin`。 */
val LocalDshDimens = staticCompositionLocalOf { DshDimens.Default }

/** M3 形状槽位兜底，避免未显式传 shape 的 M3 组件退回 28dp 大圆角。 */
val DshShapes = Shapes(
    extraSmall = RoundedCornerShape(DshRadius.Badge),
    small = RoundedCornerShape(DshRadius.Small),
    medium = RoundedCornerShape(DshRadius.Sub),
    large = RoundedCornerShape(DshRadius.Card),
    extraLarge = RoundedCornerShape(DshRadius.Card),
)
