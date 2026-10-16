package com.deepseek.dshremote

import android.Manifest
import android.content.Intent
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
        seedDebugAutomation(intent)
        setContent {
            DshRemoteTheme {
                DshRemoteRoot(onRequestNotificationPermission = ::ensureNotificationPermission)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        seedDebugAutomation(intent)
    }

    /**
     * 仅 debug 变体：允许用启动参数注入"填入示例"要用的中继地址/配对码，
     * 让真机自动化不必依赖中文输入法（BUILD.md §7.3）。release 不读这些 extra。
     */
    private fun seedDebugAutomation(intent: Intent?) {
        if (!BuildConfig.DEBUG || intent == null) return
        intent.getStringExtra(EXTRA_RELAY_URL)?.takeIf { it.isNotBlank() }?.let {
            DebugSeeds.relayUrl = it.trim()
            Logger.i(TAG, "debug 自动化种子：中继地址=${it.trim()}")
        }
        intent.getStringExtra(EXTRA_PAIR_CODE)?.takeIf { it.length == 6 }?.let {
            DebugSeeds.pairCode = it
        }
        intent.getStringExtra(EXTRA_TASK_PROMPT)?.takeIf { it.isNotBlank() }?.let {
            DebugSeeds.taskPrompt = it
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

        /** debug 自动化用：`--es dsh_relay_url ws://10.0.2.2:9543`。 */
        const val EXTRA_RELAY_URL = "dsh_relay_url"

        /** debug 自动化用：`--es dsh_pair_code 482913`。 */
        const val EXTRA_PAIR_CODE = "dsh_pair_code"

        /** debug 自动化用：`--es dsh_task_prompt "reply OK"`（真机联调要便宜的 prompt）。 */
        const val EXTRA_TASK_PROMPT = "dsh_task_prompt"
    }
}
