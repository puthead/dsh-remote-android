package com.deepseek.dshremote.ui.screens

/**
 * 「一次性提示」展示完之后，要不要把 UiState.message 消费掉。
 *
 * 为什么必须有这个判据（用户报的缺陷，别改回去）：
 * 六个屏幕都是 `LaunchedEffect(ui.message) { ui.message?.let { snackbarHostState.showSnackbar(it) } }`，
 * 而 ViewModel 把 message 写进去之后**从来没有人清空**它。于是只要页面被重建/重新进入
 * （从列表点回会话、切页签再切回、Activity 重建、配置变化后重组），
 * LaunchedEffect 就会用一个**没变过的 key 重新跑一遍**，同一条提示反复自己弹出来挡住界面
 * ——用户看到的就是"一点界面就弹出『已提交回答…』"。
 *
 * 两条语义必须分开（这是本判据存在的全部理由）：
 * - `isError == false`：纯一次性提示（"已提交回答…"、"已复制 N 步到剪贴板"、"地址已保存…"）。
 *   snackbar 显示完就消费掉，页面重建不再复现。**这就是本次缺陷的那一条。**
 * - `isError == true`：失败原因必须**留在屏幕上**给用户看。详情页 :442 还有一条常驻
 *   `ErrorText(ui.message)` 依赖它非空；一起清成 null 会让用户看不到失败原因。
 *   所以错误条**不消费**：宁可它常驻，也不要它消失。
 *   常驻不会造成"反复弹"：key 一直是同一个字符串，LaunchedEffect 只在 key 变化时重启，
 *   消息内容不变就不会再弹第二次。
 *
 * @param message 当前 UiState.message（null 表示没有待展示的提示）
 * @param isError 当前 UiState.isError
 * @return true = 这条提示已经展示完，调用方应当 `viewModel.consumeMessage()`
 */
internal fun shouldConsumeSnackbarMessage(message: String?, isError: Boolean): Boolean =
    !message.isNullOrEmpty() && !isError
