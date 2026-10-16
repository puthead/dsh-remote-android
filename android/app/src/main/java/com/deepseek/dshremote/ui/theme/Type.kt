package com.deepseek.dshremote.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * 方向 A 字号体系 —— 逐项对齐 `docs/01-设计/原型/proto_kit.py` 与 `gen_0*.py` 的实际取值。
 *
 * 为什么不用 M3 默认字号：M3 的 titleLarge 是 22sp/28sp 行高、bodyLarge 16sp/24sp，
 * 在 360dp 宽的手机上渲染出来的就是「大而稀」—— 一行标题占掉 1/25 屏、卡片只有两条信息。
 * 画稿实际只用 10sp–22sp 这一档，且行高倍率随场景变化（正文 1.34 / 等宽终端 1.5 /
 * diff 行 1.55 / 文件预览 1.6），所以这里按「用途」而不是按「M3 语义槽」来命名。
 *
 * 三档字体族：
 * - 中文/正文用默认字体（画稿用微软雅黑 Regular/Bold），
 * - 等宽用 Monospace（画稿用 Consolas），
 * - 数字/时长/counts 也走等宽，保证列对齐。
 *
 * 大小与行高换算（画稿 px ÷ 3 = sp，行高 = round(size × lh)）：
 * pageTitle 22/28、screenTitle 17/22、detailTitle 15/20、cardTitle 14/19、emphasis 13.5/18、
 * body 13/18、bodyLoose 12.5/17、label 12/16、labelTight 11.5/16、
 * monoBody 11.5/17、roundChip 11.5/15、meta 11/15、monoMeta 11/17、tiny 10.5/14、badge 10/13。
 *
 * 注意：这里**没有** `letterSpacing`——画稿全程不调字距，加字距会让中文变松。
 */
@Immutable
class DshType(
    // 页面大标题：「DSH 远程」「手机任务」「工作区」「设置」
    val pageTitle: TextStyle,
    // 二级页标题：执行轨迹的「执行轨迹」
    val screenTitle: TextStyle,
    // 详情页顶栏标题
    val detailTitle: TextStyle,
    // 卡片/列表行标题（会话标题、任务标题、设置分组标题）
    val cardTitle: TextStyle,
    // 比正文重一档：git 概览「改动 4 个文件」、审批卡「需要批准」
    val emphasis: TextStyle,
    // 正文/助手回复
    val body: TextStyle,
    // 紧凑正文：助手长段落（画稿 lh=1.34）
    val bodyLoose: TextStyle,
    // 列表预览行、设置行标签
    val label: TextStyle,
    // 更紧凑的标签：免责声明、次要说明
    val labelTight: TextStyle,
    // 等宽正文：工具卡命令行、diff 行、文件路径
    val monoBody: TextStyle,
    // 等宽小字：轮数 · 时间 · 用量等元信息行（画稿 lh=1.5，11sp→17sp）
    val monoMeta: TextStyle,
    // 小号元信息：图片说明、相对时间
    val meta: TextStyle,
    // 10.5sp：副标题、任务元信息
    val tiny: TextStyle,
    // 10sp：文件徽标字母、chip 内文字
    val badge: TextStyle,
) {
    /** 按 M3 槽位铺满，避免任何一处漏配又退回 M3 默认的大字号。 */
    fun toMaterialTypography(): Typography = Typography(
        displayLarge = pageTitle,
        displayMedium = pageTitle,
        displaySmall = screenTitle,
        headlineLarge = screenTitle,
        headlineMedium = screenTitle,
        headlineSmall = detailTitle,
        titleLarge = pageTitle,
        titleMedium = detailTitle,
        titleSmall = cardTitle,
        bodyLarge = body,
        bodyMedium = body,
        bodySmall = label,
        labelLarge = label,
        labelMedium = meta,
        labelSmall = tiny,
    )

    companion object {
        private val Sans = FontFamily.Default
        private val Mono = FontFamily.Monospace

        private fun sans(
            size: Float,
            lineHeight: Float,
            weight: FontWeight = FontWeight.Normal,
        ) = TextStyle(
            fontFamily = Sans,
            fontWeight = weight,
            fontSize = size.sp,
            lineHeight = lineHeight.sp,
        )

        private fun mono(
            size: Float,
            lineHeight: Float,
            weight: FontWeight = FontWeight.Normal,
        ) = TextStyle(
            fontFamily = Mono,
            fontWeight = weight,
            fontSize = size.sp,
            lineHeight = lineHeight.sp,
        )

        /** 深色主题（默认）：正文 #ECECEC，次要 #B4B4B4，等宽 #C9C9C9。 */
        fun dark() = DshType(
            pageTitle = sans(22f, 28f, FontWeight.Bold),
            screenTitle = sans(17f, 22f, FontWeight.Bold),
            detailTitle = sans(15f, 20f, FontWeight.Bold),
            cardTitle = sans(14f, 19f, FontWeight.SemiBold),
            emphasis = sans(13.5f, 18f, FontWeight.SemiBold),
            body = sans(13f, 18f),
            bodyLoose = sans(12.5f, 17f),
            label = sans(12f, 16f),
            labelTight = sans(11.5f, 16f),
            monoBody = mono(11.5f, 17f),
            monoMeta = mono(11f, 17f),
            meta = sans(11f, 15f),
            tiny = sans(10.5f, 14f),
            badge = sans(10f, 13f, FontWeight.Bold),
        )

        /** 浅色降级：同字号，字色交给主题色（此对象只保证字号一致）。 */
        fun light() = dark()
    }
}

/** 等宽 + 次要字色，工具输出的兜底样式。 */
val OutputTextStyle = TextStyle(
    fontFamily = FontFamily.Monospace,
    fontSize = 11.5.sp,
    lineHeight = 17.sp,
    color = Color.Unspecified,
)

/** 当前主题的字号体系。取法：`LocalDshType.current.cardTitle`。 */
val LocalDshType = staticCompositionLocalOf { DshType.dark() }
