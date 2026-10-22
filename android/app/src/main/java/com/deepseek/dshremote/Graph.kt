package com.deepseek.dshremote

import android.content.Context
import com.deepseek.dshremote.data.ConsoleRepository
import com.deepseek.dshremote.data.CrashReporter
import com.deepseek.dshremote.data.PrefsStore
import com.deepseek.dshremote.data.api.AttachmentImageLoader
import com.deepseek.dshremote.data.api.WorkspaceImageLoader
import com.deepseek.dshremote.data.api.DshApiV2
import com.deepseek.dshremote.data.api.RelayHttpClient
import com.deepseek.dshremote.data.relay.OkHttpWsTransport
import com.deepseek.dshremote.data.relay.RelayClient
import com.deepseek.dshremote.data.relay.TunnelHttp
import com.deepseek.dshremote.data.store.Outbox
import com.deepseek.dshremote.data.store.SessionCache
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * 极简依赖容器（不引入 Hilt/Koin）。
 *
 * v2 的依赖图是一条**单行道**，对着它就能验证契约 §0.2「手机不直连 PC」：
 *
 * ```
 * UI → ConsoleRepository → DshApiV2 → TunnelHttp → RelayClient → 中继 WS
 *                        ↘ RelayHttpClient（配对/健康检查，走中继 HTTP）
 * ```
 *
 * 图中没有任何"PC 地址"，手机拿不到也构造不出直连 PC 的请求。
 */
object Graph {

    /**
     * 应用级作用域：隧道重连、SSE 消费必须活得比任何 Activity 长。
     *
     * 挂 [CrashReporter.coroutineHandler]：这里的子协程是 SupervisorJob 的**根协程**，
     * 未捕获异常既不会取消兄弟协程，也不会被任何地方接住——没有这个 handler 时它会直接
     * 落到线程的未捕获异常处理器上，把整个进程带崩（例如一次隧道重连里的解析异常）。
     * 装上之后退化为"记录 + 该协程结束"，其余连接照常。
     */
    private val appScope = CoroutineScope(
        SupervisorJob() + Dispatchers.Default + CrashReporter.coroutineHandler,
    )

    @Volatile
    private var instance: ConsoleRepository? = null

    @Volatile
    private var appContextRef: Context? = null

    /** 应用 Context（日志导出、设备信息等需要，不持有 Activity）。 */
    val appContext: Context
        get() = appContextRef ?: error("Graph 未初始化：请确认 AndroidManifest 里声明了 DshRemoteApp")

    val repository: ConsoleRepository
        get() = instance ?: error("Graph 未初始化：请确认 AndroidManifest 里声明了 DshRemoteApp")

    /** 幂等初始化；[DshRemoteApp] 与测试都可以安全重复调用。 */
    fun init(context: Context) {
        if (instance != null) return
        synchronized(this) {
            if (instance != null) return
            val appContext = context.applicationContext
            appContextRef = appContext
            val prefs = PrefsStore(appContext)
            val relay = RelayClient(
                transport = OkHttpWsTransport(),
                scope = appScope,
            )
            // 令牌由仓库的 settings 流提供；用一次性引用打破构造顺序上的环
            val holder = AtomicReference<ConsoleRepository?>(null)
            val tunnel = TunnelHttp(relay = relay, tokenProvider = { holder.get()?.settings?.value?.apiToken })
            val api = DshApiV2(tunnel = tunnel)
            // 会话图片的取字节入口：内存 LRU + 磁盘缓存都挂在这里，界面只拿 ImageLoader 接口。
            // 目录与 SessionCache 同一层（filesDir/attachments），卸载/清缓存时一起走。
            val images = AttachmentImageLoader(
                fetch = { id -> api.fetchAttachment(id) },
                diskDir = AttachmentImageLoader.defaultDir(appContext.filesDir),
            )
            val repository = ConsoleRepository(
                prefs = prefs,
                relay = relay,
                tunnel = tunnel,
                api = api,
                relayHttp = RelayHttpClient(),
                cache = SessionCache(SessionCache.defaultDir(appContext.filesDir)),
                outbox = Outbox(Outbox.defaultFile(appContext.filesDir)),
                scope = appScope,
                images = WorkspaceImageLoader(images) { path, workspace -> api.fetchWorkspaceImage(path, workspace) },
            )
            holder.set(repository)
            instance = repository
        }
    }

    /** 测试入口：注入替身仓库。 */
    fun overrideForTest(repository: ConsoleRepository) {
        instance = repository
    }
}
