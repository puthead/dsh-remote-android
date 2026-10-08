package com.deepseek.dshremote.ui.vm

import androidx.compose.runtime.Composable
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory

/**
 * 用手工构造的 ViewModel 工厂。
 *
 * 之所以不引入 Hilt：仓库 [com.deepseek.dshremote.data.TaskRepository] 是应用级单例，
 * 这里只需要"把单例塞进构造参数"，一个 inline helper 足够，且没有注解处理器的编译开销。
 *
 * @param key 同一 ViewModel 类型需要按业务主键区分实例时使用（例如任务详情页按 taskId）
 */
@Composable
inline fun <reified VM : ViewModel> appViewModel(
    key: String? = null,
    crossinline create: () -> VM,
): VM = viewModel(
    key = key,
    factory = viewModelFactory { initializer<VM> { create() } },
)
