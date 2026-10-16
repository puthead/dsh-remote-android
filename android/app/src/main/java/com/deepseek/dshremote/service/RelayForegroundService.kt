package com.deepseek.dshremote.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.deepseek.dshremote.Graph
import com.deepseek.dshremote.MainActivity
import com.deepseek.dshremote.R
import com.deepseek.dshremote.data.CrashReporter
import com.deepseek.dshremote.data.Logger
import com.deepseek.dshremote.data.relay.RelayState
import com.deepseek.dshremote.data.relay.describe
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

/**
 * 维持中继隧道的前台服务。
 *
 * 为什么需要前台服务：手机退到后台后，系统会在几分钟内冻结普通进程的网络与定时器，
 * 隧道一断 SSE 就停了，用户回到前台只能看到"连接中断，正在重连"。
 * 前台服务 + 常驻通知让隧道在后台继续活着，通知文案直接显示连接状态
 * （已连接 / 电脑离线 / 重连中），这也是用户唯一需要的"后台在干什么"。
 *
 * 通知权限被拒不影响隧道（只是没有通知），这是有意的优雅降级（BUILD.md §7.6）。
 */
class RelayForegroundService : Service() {

    /**
     * 服务自己的作用域，同样挂应用级协程异常处理器。
     *
     * 这里的根协程是 [Graph.repository] 的 `relayState` 收集任务：它是热流 + StateFlow，
     * 上游解析异常会在这里冒出来，没有 handler 就是进程级崩溃，而"通知文案刷不出来"
     * 显然不该让 App 直接退出。
     */
    private val scope = CoroutineScope(
        SupervisorJob() + Dispatchers.Default + CrashReporter.coroutineHandler,
    )
    private var observeJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val initial = runCatching { Graph.repository.relayState.value }.getOrNull() ?: RelayState.Idle
        // Android 12+ 在后台启动前台服务会抛 ForegroundServiceStartNotAllowedException，
        // Android 14 还可能在类型/权限不匹配时抛 SecurityException；这两个都是**环境**问题
        // （用户从后台恢复、被 START_STICKY 拉起、厂商省电策略），不该让整个 App 崩掉。
        // 起不来就干净地停掉自己，前台功能照常可用（只是退到后台后隧道可能被冻结）。
        val promoted = runCatching { startForeground(NOTIFICATION_ID, buildNotification(initial)) }
        if (promoted.isFailure) {
            Logger.w(TAG, "前台服务提升失败，停止保活（不影响前台使用）", promoted.exceptionOrNull())
            stopSelf()
            return START_NOT_STICKY
        }
        if (observeJob?.isActive != true) {
            observeJob = scope.launch {
                runCatching {
                    Graph.repository.relayState.collect { state ->
                        notify(buildNotification(state))
                    }
                }
            }
        }
        Logger.i(TAG, "隧道保活服务已启动")
        // 被系统杀掉后自动重启：隧道必须自愈，不能等用户手动打开 App
        return START_STICKY
    }

    override fun onDestroy() {
        observeJob?.cancel()
        scope.cancel()
        Logger.i(TAG, "隧道保活服务已停止")
        super.onDestroy()
    }

    private fun notify(notification: Notification) {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        runCatching { manager.notify(NOTIFICATION_ID, notification) }
    }

    private fun buildNotification(state: RelayState): Notification {
        val text = state.describe()
        val intent = Intent(this, MainActivity::class.java)
        val pending = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("DSH 远程控制台")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_stat_dsh)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setContentIntent(pending)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "隧道连接状态",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "显示与中继/PC 的连接状态；关闭不影响隧道本身"
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    companion object {
        private const val TAG = "RelayService"
        private const val CHANNEL_ID = "dsh_relay_tunnel"
        private const val NOTIFICATION_ID = 4201

        fun start(context: Context) {
            val intent = Intent(context, RelayForegroundService::class.java)
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            }.onFailure { Logger.w(TAG, "前台服务启动失败（不影响前台使用）", it) }
        }

        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, RelayForegroundService::class.java)) }
        }
    }
}
