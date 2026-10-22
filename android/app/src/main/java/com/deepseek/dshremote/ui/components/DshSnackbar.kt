package com.deepseek.dshremote.ui.components

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalAccessibilityManager
import androidx.compose.ui.unit.dp
import com.deepseek.dshremote.ui.theme.DshOnBackground
import com.deepseek.dshremote.ui.theme.DshSurfaceHigh
import com.deepseek.dshremote.ui.theme.LocalDshType
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal const val NOTICE_DURATION_MS = 1500L

/** Main-thread UI state: a newer notice replaces the previous one, including queued notices. */
class DshSnackbarState {
    internal val host = SnackbarHostState()
    private var active: Job? = null

    suspend fun showMessage(message: String) = coroutineScope {
        active?.cancel()
        val display = launch(start = CoroutineStart.UNDISPATCHED) {
            host.showSnackbar(message, duration = SnackbarDuration.Indefinite)
        }
        active = display
        display.join()
    }
}

/** Short-lived, manually dismissible notice; accessibility timeout preferences remain respected. */
@Composable
fun DshSnackbarHost(state: DshSnackbarState) {
    val data = state.host.currentSnackbarData
    val accessibility = LocalAccessibilityManager.current
    LaunchedEffect(data, accessibility) {
        if (data != null) {
            val duration = accessibility?.calculateRecommendedTimeoutMillis(
                originalTimeoutMillis = NOTICE_DURATION_MS,
                containsIcons = true,
                containsText = true,
                containsControls = true,
            ) ?: NOTICE_DURATION_MS
            delay(duration)
            data.dismiss()
        }
    }
    SnackbarHost(state.host) { notice ->
        Snackbar(
            containerColor = DshSurfaceHigh,
            contentColor = DshOnBackground,
            shape = RoundedCornerShape(12.dp),
            dismissAction = {
                IconButton(onClick = { notice.dismiss() }) {
                    Icon(Icons.Default.Close, contentDescription = "关闭提示", tint = DshOnBackground)
                }
            },
        ) {
            Text(notice.visuals.message, style = LocalDshType.current.body)
        }
    }
}
