package com.deepseek.dshremote.ui.vm

import android.os.Build
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.deepseek.dshremote.data.ApiClient
import com.deepseek.dshremote.data.HealthInfo
import com.deepseek.dshremote.data.TaskRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 配置页状态机。
 *
 * 三条通道都保留：配对码（正常路径）、手动令牌（配对码过期/网关重启后的兜底）、
 * 仅探测（在没配对前先确认网络可达，避免"配对失败了吗？其实是 IP 填错"）。
 */
class SetupViewModel(private val repository: TaskRepository) : ViewModel() {

    data class UiState(
        val baseUrl: String = "",
        val deviceName: String = Build.MODEL.orEmpty().ifBlank { "Android" },
        val code: String = "",
        val token: String = "",
        val health: HealthInfo? = null,
        val busy: Boolean = false,
        val message: String? = null,
        val isError: Boolean = false,
        val pairedServerName: String? = null,
        /** 配对/令牌保存成功的自增计数；UI 用它触发"进入首页"，避免用消息文本判断成败。 */
        val savedTick: Int = 0,
    ) {
        /** 明文 HTTP 风险提示的触发条件。 */
        val isCleartext: Boolean get() = ApiClient.normalizeBaseUrl(baseUrl).startsWith("http://")

        val canPair: Boolean
            get() = !busy && baseUrl.isNotBlank() && code.length == 6

        val canSaveToken: Boolean
            get() = !busy && baseUrl.isNotBlank() && token.isNotBlank()
    }

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    init {
        viewModelScope.launch {
            repository.settings.collect { settings ->
                if (settings == null) return@collect
                // 已配置过时回填地址与服务器名，便于"换地址重配"；设备名保留用户当前输入
                _ui.update {
                    it.copy(
                        baseUrl = it.baseUrl.ifBlank { settings.baseUrl },
                        pairedServerName = settings.serverName,
                    )
                }
            }
        }
    }

    fun onBaseUrlChange(value: String) = _ui.update { it.copy(baseUrl = value, message = null) }

    fun onDeviceNameChange(value: String) = _ui.update { it.copy(deviceName = value) }

    /** 配对码只允许 6 位数字：在输入层就挡掉，避免用户提交后才被网关拒绝。 */
    fun onCodeChange(value: String) =
        _ui.update { it.copy(code = value.filter { ch -> ch.isDigit() }.take(6), message = null) }

    fun onTokenChange(value: String) = _ui.update { it.copy(token = value.trim(), message = null) }

    fun consumeMessage() = _ui.update { it.copy(message = null) }

    fun probe() {
        val baseUrl = _ui.value.baseUrl
        if (baseUrl.isBlank()) {
            showError("请先填写服务器地址，例如 192.168.1.8:8787")
            return
        }
        launchBusy {
            repository.probeHealth(baseUrl)
                .onSuccess { health ->
                    _ui.update {
                        it.copy(
                            health = health,
                            message = "连接成功：${health.serverName} · 网关 ${health.gatewayVersion} · dsh ${health.dshVersion}",
                            isError = !health.ok,
                        )
                    }
                }
                .onFailure { showError("探测失败：${it.friendlyMessage()}") }
        }
    }

    fun pair() {
        val state = _ui.value
        if (!state.canPair) return
        launchBusy {
            repository.pairAndSave(state.baseUrl, state.code, state.deviceName)
                .onSuccess { outcome ->
                    _ui.update {
                        it.copy(
                            health = outcome.health,
                            code = "",
                            message = "配对成功：${outcome.health.serverName}（令牌 ${outcome.tokenId.take(8)}…）",
                            isError = false,
                            savedTick = it.savedTick + 1,
                        )
                    }
                }
                .onFailure { showError("配对失败：${it.friendlyMessage()}") }
        }
    }

    fun saveToken() {
        val state = _ui.value
        if (!state.canSaveToken) return
        launchBusy {
            repository.saveManualToken(state.baseUrl, state.token, state.deviceName)
                .onSuccess { health ->
                    _ui.update {
                        it.copy(
                            health = health,
                            token = "",
                            message = "令牌已保存并校验通过：${health.serverName}",
                            isError = false,
                            savedTick = it.savedTick + 1,
                        )
                    }
                }
                .onFailure { showError("令牌校验失败：${it.friendlyMessage()}") }
        }
    }

    fun disconnect() {
        viewModelScope.launch {
            repository.disconnect()
            _ui.update { it.copy(health = null, message = "已断开并清除本机令牌", isError = false) }
        }
    }

    private fun launchBusy(block: suspend () -> Unit) {
        if (_ui.value.busy) return
        _ui.update { it.copy(busy = true, message = null) }
        viewModelScope.launch {
            try {
                block()
            } finally {
                _ui.update { it.copy(busy = false) }
            }
        }
    }

    private fun showError(text: String) = _ui.update { it.copy(message = text, isError = true) }
}

/**
 * 把异常翻译成用户能行动的一句话。
 *
 * 403 `pairing_closed` 之类的错误如果直接抛原始英文，用户唯一的动作就是"再点一次"，
 * 因此这里给出可执行指引。
 */
fun Throwable.friendlyMessage(): String {
    val raw = message.orEmpty().ifBlank { this::class.java.simpleName }
    return when {
        raw.contains("pairing_bad_code") || raw.contains("配对码") -> "$raw（请确认码没输错且未过期）"
        raw.contains("pairing_closed") -> "$raw（请先在 PC 上执行 pair.ps1 生成配对码）"
        raw.contains("unauthorized") -> "$raw（令牌无效，请重新配对或在 PC 上撤销后重配）"
        raw.contains("rate_limited") -> "$raw（失败次数过多，请等待 1 分钟）"
        raw.contains("timeout", ignoreCase = true) -> "$raw（检查手机与 PC 是否同一网段、防火墙是否放行 8787）"
        raw.contains("Failed to connect", ignoreCase = true) -> "$raw（PC 网关是否已启动？IP 是否正确？）"
        else -> raw
    }
}
