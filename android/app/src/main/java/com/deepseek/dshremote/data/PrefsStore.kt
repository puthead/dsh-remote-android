package com.deepseek.dshremote.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.deepseek.dshremote.data.api.PairClaimV2
import com.deepseek.dshremote.data.relay.RelayUrls
import com.deepseek.dshremote.data.store.KeystoreSecretCipher
import com.deepseek.dshremote.data.store.SecretCipher
import com.deepseek.dshremote.data.store.SecretCodec
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/** DataStore 必须进程内唯一，因此挂在文件级委托上。 */
private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "dsh_remote_v2")

/**
 * 连接配置（契约 v2：中继地址 + 设备令牌 + homeId + 续传游标）。
 *
 * 与 v1 的区别：v1 存的是 PC 地址（手机直连），v2 只存**中继**地址；
 * 手机不再知道、也不该知道 PC 的网络位置。
 */
data class ConsoleSettings(
    val relayUrl: String,
    val tunnelUrl: String,
    val deviceToken: String,
    val apiToken: String,
    val tokenId: String,
    val homeId: String,
    val serverName: String,
    val deviceId: String,
    val deviceName: String,
    val lightTheme: Boolean = false,
    val lastEventSeq: Long = -1L,
) {
    /** 隧道端点：优先用中继在配对响应里给的地址（PC 不知道自己的公网地址）。 */
    val tunnelEndpoint: String get() = tunnelUrl.ifEmpty { relayUrl }

    /** 明文 `ws://`：设置页必须显示风险提示卡（契约 §5.6）。 */
    val isCleartext: Boolean get() = RelayUrls.isCleartext(tunnelEndpoint)

    /** 是否已配对（有令牌即可连隧道）。 */
    val paired: Boolean get() = deviceToken.isNotEmpty() && relayUrl.isNotEmpty()
}

/**
 * 配置持久化。
 *
 * 令牌用 [SecretCipher]（Android Keystore AES/GCM）加密后落盘；Keystore 不可用时
 * 回退明文并带 `plain:` 前缀，[tokenStorageNote] 会把这件事显示在设置页上。
 */
class PrefsStore(
    private val context: Context,
    private val cipher: SecretCipher = KeystoreSecretCipher(),
) {

    @Volatile
    private var lastStorageNote: String = "未保存令牌"

    val settings: Flow<ConsoleSettings?> = context.dataStore.data
        // 磁盘损坏时给一份空配置，而不是让 App 启动即崩（未配置时应进配对页）
        .catch { e -> if (e is IOException) emit(emptyPreferences()) else throw e }
        .map { prefs -> toSettings(prefs) }

    suspend fun current(): ConsoleSettings? = settings.first()

    /**
     * deviceId 首次使用时生成（小写 UUID v4，v1 裁定 A4），非法历史值直接重建。
     */
    suspend fun deviceId(): String {
        val existing = read(KEY_DEVICE_ID)
        if (!existing.isNullOrEmpty() && DEVICE_ID_REGEX.matches(existing)) return existing
        val generated = UUID.randomUUID().toString()
        context.dataStore.edit { it[KEY_DEVICE_ID] = generated }
        return generated
    }

    suspend fun deviceName(): String = read(KEY_DEVICE_NAME).orEmpty().ifEmpty { "Android" }

    /** 保存配对结果；返回落库后的快照，调用方立刻用它连隧道。 */
    suspend fun savePairing(
        claim: PairClaimV2,
        requestedRelayUrl: String,
        deviceName: String,
        /** 实际使用的隧道端点（可能因主机名不可解析而从宣告地址回退，见 RelayUrls.pickTunnelEndpoint）。 */
        tunnelEndpoint: String = claim.tunnelUrl,
    ): ConsoleSettings {
        val deviceId = deviceId()
        val name = deviceName.ifBlank { "Android" }
        val encryptedDeviceToken = cipher.encrypt(claim.effectiveDeviceToken)
        val encryptedApiToken = cipher.encrypt(claim.apiToken)
        lastStorageNote = storageNoteFor(encryptedDeviceToken)
        context.dataStore.edit { prefs ->
            prefs[KEY_RELAY_URL] = requestedRelayUrl.trim()
            prefs[KEY_TUNNEL_URL] = tunnelEndpoint
            prefs[KEY_DEVICE_TOKEN] = encryptedDeviceToken
            prefs[KEY_API_TOKEN] = encryptedApiToken
            prefs[KEY_TOKEN_ID] = claim.tokenId
            prefs[KEY_HOME_ID] = claim.homeId
            prefs[KEY_SERVER_NAME] = claim.serverName
            prefs[KEY_DEVICE_ID] = deviceId
            prefs[KEY_DEVICE_NAME] = name
            // 新配对：旧游标在新 home 上没有意义
            prefs[KEY_LAST_SEQ] = -1L
        }
        Logger.i(TAG, "配对已保存 relay=${requestedRelayUrl.trim()} 端点=$tunnelEndpoint storage=$lastStorageNote")
        return ConsoleSettings(
            relayUrl = requestedRelayUrl.trim(),
            tunnelUrl = tunnelEndpoint,
            deviceToken = claim.effectiveDeviceToken,
            apiToken = claim.apiToken,
            tokenId = claim.tokenId,
            homeId = claim.homeId,
            serverName = claim.serverName,
            deviceId = deviceId,
            deviceName = name,
        )
    }

    /** 换中继地址（设置页测试/迁移用）：保留令牌，只改地址。 */
    suspend fun updateRelayUrl(url: String) {
        context.dataStore.edit { it[KEY_RELAY_URL] = url.trim() }
        Logger.i(TAG, "中继地址已更新 url=${url.trim()}")
    }

    /** 记住 SSE 游标，App 重启后从断点续传（契约 §4.2 `fromSeq`）。 */
    suspend fun saveEventSeq(seq: Long) {
        if (seq < 0) return
        context.dataStore.edit { it[KEY_LAST_SEQ] = seq }
    }

    /** 浅色降级开关（默认关闭，深色为主）。 */
    suspend fun setLightTheme(enabled: Boolean) {
        context.dataStore.edit { it[KEY_LIGHT_THEME] = enabled }
    }

    suspend fun updateServerName(serverName: String) {
        context.dataStore.edit { it[KEY_SERVER_NAME] = serverName }
    }

    /** 解除配对：清掉地址与令牌，保留 deviceId（同一台设备重配时 id 不变）。 */
    suspend fun clear() {
        context.dataStore.edit { prefs ->
            prefs.remove(KEY_RELAY_URL)
            prefs.remove(KEY_TUNNEL_URL)
            prefs.remove(KEY_DEVICE_TOKEN)
            prefs.remove(KEY_API_TOKEN)
            prefs.remove(KEY_TOKEN_ID)
            prefs.remove(KEY_HOME_ID)
            prefs.remove(KEY_SERVER_NAME)
            prefs.remove(KEY_LAST_SEQ)
        }
        lastStorageNote = "未保存令牌"
        Logger.i(TAG, "已清除本机配对信息")
    }

    /** 设置页展示用：令牌是加密存储还是明文回退。 */
    fun tokenStorageNote(): String = lastStorageNote

    private fun toSettings(prefs: Preferences): ConsoleSettings? {
        val relayUrl = prefs[KEY_RELAY_URL].orEmpty()
        val deviceToken = cipher.decrypt(prefs[KEY_DEVICE_TOKEN].orEmpty())
        val apiToken = cipher.decrypt(prefs[KEY_API_TOKEN].orEmpty()).ifEmpty { deviceToken }
        if (relayUrl.isEmpty() || deviceToken.isEmpty()) return null
        lastStorageNote = storageNoteFor(prefs[KEY_DEVICE_TOKEN].orEmpty())
        return ConsoleSettings(
            relayUrl = relayUrl,
            tunnelUrl = prefs[KEY_TUNNEL_URL].orEmpty(),
            deviceToken = deviceToken,
            apiToken = apiToken,
            tokenId = prefs[KEY_TOKEN_ID].orEmpty(),
            homeId = prefs[KEY_HOME_ID].orEmpty(),
            serverName = prefs[KEY_SERVER_NAME].orEmpty(),
            deviceId = prefs[KEY_DEVICE_ID].orEmpty(),
            deviceName = prefs[KEY_DEVICE_NAME].orEmpty().ifEmpty { "Android" },
            lightTheme = prefs[KEY_LIGHT_THEME] ?: false,
            lastEventSeq = prefs[KEY_LAST_SEQ] ?: -1L,
        )
    }

    private fun storageNoteFor(stored: String): String = when {
        stored.isEmpty() -> "未保存令牌"
        SecretCodec.isEncrypted(stored) -> "令牌已用 Android Keystore 加密存储"
        SecretCodec.isPlainFallback(stored) -> "Keystore 不可用：令牌以明文回退存储（建议重新配对）"
        else -> "令牌存储格式为历史明文"
    }

    private suspend fun read(key: Preferences.Key<String>): String? =
        context.dataStore.data
            .catch { e -> if (e is IOException) emit(emptyPreferences()) else throw e }
            .first()[key]

    private companion object {
        const val TAG = "PrefsStore"
        val KEY_RELAY_URL = stringPreferencesKey("relayUrl")
        val KEY_TUNNEL_URL = stringPreferencesKey("tunnelUrl")
        val KEY_DEVICE_TOKEN = stringPreferencesKey("deviceToken")
        val KEY_API_TOKEN = stringPreferencesKey("apiToken")
        val KEY_TOKEN_ID = stringPreferencesKey("tokenId")
        val KEY_HOME_ID = stringPreferencesKey("homeId")
        val KEY_SERVER_NAME = stringPreferencesKey("serverName")
        val KEY_DEVICE_ID = stringPreferencesKey("deviceId")
        val KEY_DEVICE_NAME = stringPreferencesKey("deviceName")
        val KEY_LIGHT_THEME = booleanPreferencesKey("lightTheme")
        val KEY_LAST_SEQ = longPreferencesKey("lastEventSeq")

        val DEVICE_ID_REGEX =
            Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    }
}
