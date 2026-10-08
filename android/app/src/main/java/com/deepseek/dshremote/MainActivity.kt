package com.deepseek.dshremote

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.deepseek.dshremote.data.Logger
import com.deepseek.dshremote.ui.DshRemoteRoot
import com.deepseek.dshremote.ui.theme.DshRemoteTheme

/**
 * 唯一的 Activity：Compose 单页应用 + 状态驱动导航（不引入 navigation-compose，
 * 因为只有 4 个平级页面，手写状态机反而更少坑：返回栈、深链都不需要）。
 */
class MainActivity : ComponentActivity() {

    private val requestNotificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            // 优雅降级：拒绝授权只是"看不到通知"，前台服务与 SSE 保活照常工作
            Logger.i(TAG, "通知权限授权结果 granted=$granted")
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Graph.init(applicationContext)
        setContent {
            DshRemoteTheme {
                DshRemoteRoot(onRequestNotificationPermission = ::ensureNotificationPermission)
            }
        }
    }

    /** Android 13+ 首次使用时申请通知权限；低版本无需申请。 */
    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            runCatching { requestNotificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS) }
        }
    }

    private companion object {
        const val TAG = "MainActivity"
    }
}
