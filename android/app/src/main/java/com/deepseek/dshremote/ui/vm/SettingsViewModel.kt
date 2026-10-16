package com.deepseek.dshremote.ui.vm

import android.content.Context
import android.os.Build
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.deepseek.dshremote.DebugSeeds
import com.deepseek.dshremote.data.ConsoleRepository
import com.deepseek.dshremote.data.Logger
import com.deepseek.dshremote.data.api.GatewayHealth
import com.deepseek.dshremote.data.api.RelayHealth
import com.deepseek.dshremote.data.relay.RelayClient
import com.deepseek.dshremote.data.relay.RelayState
import com.deepseek.dshremote.data.relay.RelayUrls
import com.deepseek.dshremote.data.relay.describe
import com.deepseek.dshremote.data.store.LogExporter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 设置页：中继地址、配对、连接状态、令牌吊销、明文提示、日志导出、主题降级。
 *
 * 与 v1 配置页的关键区别：地址是**中继**地址（`ws://` / `wss://`），
 * 手机不再需要、也不应该知道 PC 的内网地址。
 */
class SettingsViewModel(
    private val repository: ConsoleRepository,
    private val appContext: Context,
) : ViewModel() {

    data class UiState(
        val relayUrl: String = "",
        val deviceName: String = Build.MODEL.orEmpty().ifBlank { "Android" },
        val code: String = "",
        val busy: Boolean = false,
        val message: String? = null,
        val isError: Boolean = false,
        val paired: Boolean = false,
        val serverName: String = "",
        val homeIdMasked: String = "",
        val tokenId: String = "",
        val tunnelUrl: String = "",
        val lightTheme: Boolean = false,
        val secretNote: String = "未保存令牌",
        val relayHealth: RelayHealth? = null,
        val gatewayHealth: GatewayHealth? = null,
        val logPath: String? = null,
        val relayStateText: String = "未连接中继",
    ) {
        val isCleartext: Boolean get() = RelayUrls.isCleartext(relayUrl)

        val canPair: Boolean get() = !busy && relayUrl.isNotBlank() && code.length == 6

        val tunnelEndpoint: String get() = tunnelUrl.ifEmpty { RelayUrls.tunnelUrl(relayUrl) }

        /**
         * 实际使用的隧道端点说明（排障时能一眼看出"到底连的是哪个地址"）。
         *
         * `relayName` 派生 tunnelUrl 是本轮最阴的部署坑：中继宣告的域名手机可能解析不了，
         * 此时客户端会回退到刚配对成功的中继地址（[RelayUrls.pickTunnelEndpoint]）。
         */
        val endpointNote: String
            get() {
                if (!paired) return "未配对"
                if (tunnelUrl.isEmpty()) return "使用填写的中继地址"
                val entered = RelayUrls.tunnelUrl(relayUrl)
                return if (tunnelUrl.equals(entered, ignoreCase = true)) {
                    "与填写的地址一致"
                } else {
                    "来自中继宣告的 tunnelUrl（若手机解析不了，会自动回退到填写的地址）"
                }
            }
    }

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    val relayState: StateFlow<RelayState> = repository.relayState

    init {
        viewModelScope.launch {
            repository.settings.collect { settings ->
                _ui.update { current ->
                    current.copy(
                        relayUrl = current.relayUrl.ifBlank { settings?.relayUrl.orEmpty() },
                        deviceName = settings?.deviceName ?: current.deviceName,
                        paired = settings != null,
                        serverName = settings?.serverName.orEmpty(),
                        homeIdMasked = RelayClient.mask(settings?.homeId),
                        tokenId = settings?.tokenId.orEmpty(),
                        tunnelUrl = settings?.tunnelUrl.orEmpty(),
                        lightTheme = settings?.lightTheme ?: false,
                        secretNote = repository.secretStorageNote(),
                    )
                }
            }
        }
        viewModelScope.launch {
            repository.relayState.collect { state ->
                _ui.update { it.copy(relayStateText = state.describe()) }
            }
        }
    }

    fun onRelayUrlChange(value: String) = _ui.update { it.copy(relayUrl = value.trim(), message = null) }

    fun onCodeChange(value: String) =
        _ui.update { it.copy(code = value.filter { ch -> ch.isDigit() }.take(6), message = null) }

    fun onDeviceNameChange(value: String) = _ui.update { it.copy(deviceName = value) }

    /** 调试/自动化用：填入示例中继地址与配对码（模拟器没有中文输入法，见 BUILD.md §7.3）。 */
    fun fillDemo() = _ui.update {
        it.copy(
            relayUrl = if (it.relayUrl.isBlank()) {
                DebugSeeds.relayUrl ?: DEFAULT_RELAY_URL
            } else {
                it.relayUrl
            },
            code = if (it.code.length == 6) it.code else (DebugSeeds.pairCode ?: DEFAULT_PAIR_CODE),
            message = "已填入示例：中继地址与 6 位配对码",
            isError = false,
        )
    }

    fun pair() {
        val state = _ui.value
        if (!state.canPair) {
            _ui.update { it.copy(message = "请先填写中继地址并输入 6 位配对码", isError = true) }
            return
        }
        launchBusy("配对") {
            repository.pair(state.relayUrl, state.code, state.deviceName)
                .onSuccess { outcome ->
                    val health = outcome.health
                    _ui.update {
                        it.copy(
                            code = "",
                            relayHealth = health,
                            message = "配对成功：${outcome.settings.serverName.ifEmpty { "PC" }} · 中继 ${outcome.relayName.ifEmpty { "已连接" }}",
                            isError = false,
                        )
                    }
                    Logger.i(TAG, "配对成功 homeId=${RelayClient.mask(outcome.settings.homeId)}")
                }
                .onFailure { error ->
                    _ui.update { it.copy(message = "配对失败：${error.friendlyMessage()}", isError = true) }
                }
        }
    }

    /** 凭据失效后重新配对（先清旧令牌）。 */
    fun repair() {
        val state = _ui.value
        if (!state.canPair) {
            _ui.update { it.copy(message = "请先填写中继地址并输入 6 位配对码", isError = true) }
            return
        }
        launchBusy("重新配对") {
            repository.repair(state.relayUrl, state.code, state.deviceName)
                .onSuccess {
                    _ui.update { it.copy(code = "", message = "已重新配对并恢复连接", isError = false) }
                }
                .onFailure { error ->
                    _ui.update { it.copy(message = "重新配对失败：${error.friendlyMessage()}", isError = true) }
                }
        }
    }

    fun probeRelay() {
        val state = _ui.value
        if (state.relayUrl.isBlank()) {
            _ui.update { it.copy(message = "请先填写中继地址，例如 ws://10.0.2.2:9443", isError = true) }
            return
        }
        launchBusy("探测中继") {
            val result = runCatching { repository.probeRelay(state.relayUrl) }
            result.onSuccess { h ->
                _ui.update {
                    it.copy(
                        relayHealth = h,
                        message = "中继可达：${h.relayName} v${h.relayVersion} · 电脑 ${h.homes} 台 · 设备 ${h.devices}",
                        isError = !h.ok,
                    )
                }
            }.onFailure { error ->
                _ui.update { it.copy(message = "中继不可达：${error.friendlyMessage()}", isError = true) }
            }
        }
    }

    /**
     * 探测网关（**经隧道**，因此能同时验证"隧道通 + 网关活 + 版本能力"）。
     *
     * 版本判定只看 `supportedApiVersions`（契约 §4.5）：`apiVersion` 恒为 1，不能用来判断 v2。
     */
    fun probeGateway() {
        launchBusy("探测网关") {
            repository.probeGateway()
                .onSuccess { health ->
                    _ui.update {
                        it.copy(
                            gatewayHealth = health,
                            serverName = health.serverName.ifEmpty { it.serverName },
                            message = "网关可达：${health.serverName} · v${health.gatewayVersion} · ${health.capabilityNote}",
                            isError = !health.ok,
                        )
                    }
                }
                .onFailure { error ->
                    _ui.update { it.copy(message = "网关不可达：${error.friendlyMessage()}", isError = true) }
                }
        }
    }

    fun saveRelayUrl() {
        val state = _ui.value
        if (state.relayUrl.isBlank()) {
            _ui.update { it.copy(message = "中继地址不能为空", isError = true) }
            return
        }
        launchBusy("保存地址") {
            repository.setRelayUrl(state.relayUrl)
                .onSuccess { _ui.update { it.copy(message = "地址已保存，正在重连…", isError = false) } }
                .onFailure { error ->
                    _ui.update { it.copy(message = "保存失败：${error.friendlyMessage()}", isError = true) }
                }
        }
    }

    /** 吊销本机令牌（同时通知 PC 侧设备库）。 */
    fun revoke() {
        launchBusy("吊销令牌") {
            repository.revokeSelf()
                .onSuccess { text -> _ui.update { it.copy(message = text, isError = false) } }
                .onFailure { error ->
                    _ui.update { it.copy(message = "吊销失败：${error.friendlyMessage()}", isError = true) }
                }
        }
    }

    fun unpair() {
        launchBusy("解除配对") {
            repository.unpair()
            _ui.update { it.copy(message = "已解除本机配对", isError = false) }
        }
    }

    fun exportLog() {
        launchBusy("导出日志") {
            val file = withIoResult { LogExporter.export(appContext, extraLines = diagnosticLines()) }
            file.onSuccess { f ->
                _ui.update { it.copy(logPath = f.absolutePath, message = "日志已导出：${f.absolutePath}", isError = false) }
            }.onFailure { error ->
                _ui.update { it.copy(message = "导出失败：${error.message}", isError = true) }
            }
        }
    }

    /** 浅色降级开关（默认关闭：深色为主）。 */
    fun toggleLightTheme() {
        val next = !_ui.value.lightTheme
        viewModelScope.launch {
            repository.setLightTheme(next)
            _ui.update { it.copy(lightTheme = next, message = if (next) "已切到浅色（降级模式）" else "已切回深色（默认）") }
        }
    }

    fun clearCache() {
        launchBusy("清除缓存") {
            repository.clearCache()
            _ui.update { it.copy(message = "已清除本地离线缓存", isError = false) }
        }
    }

    fun consumeMessage() = _ui.update { it.copy(message = null) }

    /** 诊断行：只放地址与状态，**不放令牌**（日志本身还会再过一次脱敏）。 */
    private fun diagnosticLines(): List<String> = listOf(
        "中继地址：${_ui.value.relayUrl}",
        "隧道端点：${_ui.value.tunnelEndpoint}",
        "连接状态：${_ui.value.relayStateText}",
        "homeId：${_ui.value.homeIdMasked}",
        "tokenId：${_ui.value.tokenId}",
        "PC 名称：${_ui.value.serverName}",
        "已配对：${_ui.value.paired}",
        "令牌存储：${_ui.value.secretNote}",
    )

    private fun launchBusy(label: String, block: suspend () -> Unit) {
        if (_ui.value.busy) {
            Logger.i(TAG, "忽略「$label」：busy=true")
            return
        }
        _ui.update { it.copy(busy = true, message = null) }
        viewModelScope.launch {
            try {
                block()
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                // 所有分支都必须产生用户可见的结果：v1 的"点了没反应"就是这么来的
                Logger.e(TAG, "「$label」内部错误", t)
                _ui.update { it.copy(message = "内部错误：${t.message ?: t::class.java.simpleName}", isError = true) }
            } finally {
                _ui.update { it.copy(busy = false) }
            }
        }
    }

    private suspend fun <T> withIo(block: suspend () -> T): T = block()

    private suspend fun <T> withIoResult(block: () -> T): Result<T> = runCatching { block() }

    companion object {
        private const val TAG = "SettingsViewModel"
        const val DEFAULT_RELAY_URL = "ws://10.0.2.2:9443"
        const val DEFAULT_PAIR_CODE = "482913"
    }
}
