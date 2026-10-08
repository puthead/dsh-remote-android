package com.deepseek.dshremote.ui.vm

import android.os.Build
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.deepseek.dshremote.data.ApiClient
import com.deepseek.dshremote.data.ApiException
import com.deepseek.dshremote.data.HealthInfo
import com.deepseek.dshremote.data.Logger
import com.deepseek.dshremote.data.TaskRepository
import kotlinx.coroutines.CancellationException
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
        val state = _ui.value
        Logger.i(TAG, "点击「测试连接」 baseUrl='${state.baseUrl}' busy=${state.busy}")
        if (state.baseUrl.isBlank()) {
            showError("请先填写服务器地址，例如 192.168.1.8:8787")
            return
        }
        launchBusy {
            repository.probeHealth(state.baseUrl)
                .onSuccess { health ->
                    Logger.i(TAG, "探测成功 server=${
                        health.serverName
                    } gateway=${health.gatewayVersion} dsh=${health.dshVersion}")
                    _ui.update {
                        it.copy(
                            health = health,
                            message = "连接成功：${health.serverName} · 网关 ${health.gatewayVersion} · dsh ${health.dshVersion}",
                            isError = !health.ok,
                        )
                    }
                }
                .onFailure { error ->
                    Logger.w(TAG, "探测失败", error)
                    showError("探测失败：${error.friendlyMessage()}")
                }
        }
    }

    fun pair() {
        val state = _ui.value
        Logger.i(
            TAG,
            "点击「配对并保存」 canPair=${state.canPair} busy=${state.busy} " +
                "baseUrl='${state.baseUrl}' codeLen=${state.code.length}",
        )
        if (!state.canPair) {
            // 按钮禁用时不会走到这里；真走到了说明状态与 UI 不一致，必须给出可见提示而不是静默
            showError("请先填写服务器地址并输入 6 位配对码")
            return
        }
        launchBusy {
            repository.pairAndSave(state.baseUrl, state.code, state.deviceName)
                .onSuccess { outcome ->
                    Logger.i(TAG, "配对成功 server=${outcome.health.serverName} tokenId=${outcome.tokenId}")
                    repository.consumeNotice()
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
                .onFailure { error ->
                    Logger.w(TAG, "配对失败", error)
                    showError("配对失败：${error.friendlyMessage()}")
                }
        }
    }

    fun saveToken() {
        val state = _ui.value
        Logger.i(TAG, "点击「保存令牌并校验」 canSave=${state.canSaveToken} baseUrl='${state.baseUrl}'")
        if (!state.canSaveToken) {
            showError("请先填写服务器地址与设备令牌")
            return
        }
        launchBusy {
            repository.saveManualToken(state.baseUrl, state.token, state.deviceName)
                .onSuccess { health ->
                    Logger.i(TAG, "令牌校验通过 server=${health.serverName}")
                    repository.consumeNotice()
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
                .onFailure { error ->
                    Logger.w(TAG, "令牌校验失败", error)
                    showError("令牌校验失败：${error.friendlyMessage()}")
                }
        }
    }

    fun disconnect() {
        Logger.i(TAG, "点击「清除本机令牌并断开」")
        viewModelScope.launch {
            repository.disconnect()
            _ui.update { it.copy(health = null, message = "已断开并清除本机令牌", isError = false) }
        }
    }

    /**
     * 统一的"忙碌 + 异常兜底"包装。
     *
     * 所有分支都必须产生**用户可见**的结果：任何异常（含线程策略、解析、空指针）都要变成
     * 提示文案。之前 OkHttp 在主线程被 `NetworkOnMainThreadException` 打断时表现为"点了没反应"，
     * 就是因为异常在协程里静默消失了。
     */
    private fun launchBusy(block: suspend () -> Unit) {
        if (_ui.value.busy) {
            Logger.i(TAG, "launchBusy 忽略：busy=true")
            return
        }
        _ui.update { it.copy(busy = true, message = null) }
        viewModelScope.launch {
            try {
                block()
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                Logger.e(TAG, "操作内部错误", t)
                showError("内部错误：${t.message ?: t::class.java.simpleName}")
            } finally {
                _ui.update { it.copy(busy = false) }
            }
        }
    }

    private fun showError(text: String) {
        Logger.i(TAG, "提示：$text")
        _ui.update { it.copy(message = text, isError = true) }
    }

    private companion object {
        const val TAG = "SetupViewModel"
    }
}

/**
 * 把异常翻译成用户能行动的一句话。
 *
 * 两个硬要求：
 * - 契约 §0 的每个错误码都要有**可读中文分支**，不允许落到"未知错误"兜底；
 * - `429 busy`（队列满，裁定 A2）必须与"排队中"区分开：前者是"服务器繁忙，请稍后重试"，
 *   后者是任务已经进队、只是还没轮到执行。
 *
 * 注意分派顺序：**先按错误码，再按 HTTP 状态**。因为 `pairing_bad_code` 的 HTTP 状态也是 401，
 * 若先按 401 分类会给出"设备令牌已失效，请重新配对"这种完全错误的指引。
 */
fun Throwable.friendlyMessage(): String {
    val api = this as? ApiException
    val raw = message.orEmpty().ifBlank { this::class.java.simpleName }

    when (api?.code) {
        // 401：令牌被吊销/失效 —— 必须重新配对，重试没有意义
        "unauthorized" -> return "设备令牌已失效，请重新配对（unauthorized）"

        // 403：配对未开启或来源不被允许（裁定 A1），与 401 区别处理：不清令牌
        "forbidden" ->
            return "服务器拒绝了本次请求（forbidden）：请确认配对仍开启，并在 PC 本机生成配对码"

        // 429（busy）：队列已满，任务根本没进队 —— 与"排队中"完全不同的状态
        "busy" -> return "服务器繁忙，请稍后重试（busy：执行槽与队列都已满）"

        // 429（rate_limited）：失败限速（契约 §6.4）
        "rate_limited" -> return "服务器繁忙，请稍后重试（rate_limited：请求过于频繁）"

        // 409：对活动态任务执行删除（裁定 A7）
        "conflict" -> return "$raw（任务仍在执行中，无法删除：请先取消或等它结束）"

        // 413：请求体过大
        "payload_too_large" -> return "$raw（内容过大被服务器拒绝：请精简任务描述后重试）"

        "pairing_bad_code" -> return "$raw（配对码错误或已过期，请在 PC 上重新生成）"
        "pairing_closed" -> return "$raw（请先在 PC 上执行 pair.ps1 生成配对码）"
        "not_found" -> return "$raw（任务记录可能已被删除或网关重启后丢失）"
        "bad_request" ->
            return "$raw（请求不合法：检查工作区是否在白名单内、配对信息是否完整）"

        "internal" -> return "$raw（网关内部错误：请查看网关日志）"
    }

    // 网关没给 code 时的兜底：按 HTTP 状态分类，仍然不用"未知错误"这种无信息量的话术
    when {
        api?.isUnauthorized == true -> return "设备令牌已失效，请重新配对（HTTP 401）"
        api?.isForbidden == true -> return "服务器拒绝了本次请求（HTTP 403）：请确认配对仍开启"
        api?.isBusy == true -> return "服务器繁忙，请稍后重试（HTTP 429）"
        api?.isRateLimited == true -> return "服务器繁忙，请稍后重试（HTTP 429：请求过于频繁）"
        api?.isConflict == true -> return "$raw（HTTP 409：任务仍在执行中，无法删除）"
        api?.isPayloadTooLarge == true -> return "$raw（HTTP 413：内容过大）"
    }

    return when {
        raw.contains("timeout", ignoreCase = true) ->
            "$raw（检查手机与 PC 是否同一网段、Windows 防火墙是否放行 8787）"
        raw.contains("Failed to connect", ignoreCase = true) ||
            raw.contains("ECONNREFUSED", ignoreCase = true) ->
            "$raw（PC 网关是否已启动？IP 与端口是否正确？）"
        raw.contains("UnknownHost", ignoreCase = true) -> "$raw（域名解析失败，确认地址拼写）"
        raw.contains("NetworkOnMainThread", ignoreCase = true) ->
            "$raw（客户端内部错误：网络调用跑到主线程了，请反馈此问题）"
        else -> raw
    }
}
