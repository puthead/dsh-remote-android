package com.deepseek.dshremote.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.deepseek.dshremote.Graph
import com.deepseek.dshremote.MainActivity
import com.deepseek.dshremote.R
import com.deepseek.dshremote.data.ConnectionState
import com.deepseek.dshremote.data.Logger

/**
 * 保持 SSE 长连接的前台服务（需求 5）。
 *
 * 为什么必须是前台服务：Android 8 起后台进程会被冻结，Doze 下 socket 也会被掐，
 * 只有前台服务能让"任务跑 10 分钟、用户切到微信再切回来"时输出仍然是连续的。
 *
 * 权限降级策略：
 * - Android 13+ 没有 POST_NOTIFICATIONS：`startForeground` 仍合法，只是通知不展示，
 *   事件流照常消费（用户只是少了一个进度通知）；
 * - Android 12+ 若从后台启动会抛 `ForegroundServiceStartNotAllowedException`：
 *   我们只从 Activity 前台启动，同时这里也捕获异常兜底，绝不因保活失败而崩溃。
 */
class SseForegroundService : Service() {

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        startForegroundCompat()
        // 仓库是应用级单例：这里只是"续上"事件流，不会重置 fromSeq 游标
        Graph.repository.startStream()
        return START_STICKY
    }

    override fun onDestroy() {
        Graph.repository.stopStream()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startForegroundCompat() {
        val notification = buildNotification(Graph.repository.connection.value)
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                } else {
                    0
                },
            )
        } catch (t: Throwable) {
            // 少数 ROM 在"后台启动前台服务"时会拒绝；保活降级，但应用必须继续可用
            Logger.w(TAG, "启动前台服务失败，降级为普通后台任务", t)
        }
    }

    private fun buildNotification(state: ConnectionState): Notification {
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stopSelf = PendingIntent.getService(
            this,
            1,
            Intent(this, SseForegroundService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val text = when (state) {
            is ConnectionState.Connected -> "已连接网关，正在接收任务事件"
            is ConnectionState.Connecting -> "正在连接网关（第 ${state.attempt} 次）"
            is ConnectionState.Retrying -> "连接中断，${state.retryInMs / 1000}s 后重连：${state.reason}"
            is ConnectionState.Failed -> state.reason
            ConnectionState.Idle -> "已停止接收事件"
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_dsh)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(openApp)
            .addAction(0, "停止保活", stopSelf)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    /** Android 8+ 必须先建渠道，否则通知直接丢弃。 */
    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.notification_channel_desc)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    companion object {
        private const val TAG = "SseService"
        private const val CHANNEL_ID = "dsh_sse"
        private const val NOTIFICATION_ID = 1001
        private const val ACTION_STOP = "com.deepseek.dshremote.action.STOP_KEEPALIVE"

        /** 从 Activity 前台调用；重复调用是幂等的（onStartCommand 会被再次触发但不会重建连接）。 */
        fun start(context: Context) {
            val intent = Intent(context, SseForegroundService::class.java)
            runCatching { ContextCompat.startForegroundService(context, intent) }
                .onFailure { Logger.w(TAG, "启动保活服务被系统拒绝", it) }
        }

        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, SseForegroundService::class.java)) }
        }
    }
}
