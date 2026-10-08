package com.deepseek.dshremote

import android.content.Context
import com.deepseek.dshremote.data.ApiClient
import com.deepseek.dshremote.data.EventStream
import com.deepseek.dshremote.data.HistoryStore
import com.deepseek.dshremote.data.PrefsStore
import com.deepseek.dshremote.data.SseClient
import com.deepseek.dshremote.data.TaskRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * 极简依赖容器。
 *
 * 为什么不上 Hilt/Koin：整个 App 只有 4 个需要注入的对象、1 个仓库，
 * 引入 DI 框架会带来注解处理器、编译变慢、以及"注入失败只能运行时发现"的代价。
 * 这里的选择是显式的手工构造，一眼能看出生命周期归属。
 */
object Graph {

    /** 应用级作用域：事件流、历史落库都必须活得比任何 Activity 长。 */
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Volatile
    private var instance: TaskRepository? = null

    val repository: TaskRepository
        get() = instance ?: error("Graph 未初始化：请确认 AndroidManifest 里声明了 DshRemoteApp")

    /** 幂等初始化；[DshRemoteApp] 与测试都可以安全重复调用。 */
    fun init(context: Context) {
        if (instance != null) return
        synchronized(this) {
            if (instance != null) return
            val appContext = context.applicationContext
            instance = TaskRepository(
                api = ApiClient(),
                prefs = PrefsStore(appContext),
                historyStore = HistoryStore(HistoryStore.defaultFile(appContext.filesDir)),
                eventStream = EventStream(SseClient()),
                scope = appScope,
            )
        }
    }
}
