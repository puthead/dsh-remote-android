package com.deepseek.dshremote.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/** DataStore 必须进程内唯一，因此挂在文件级委托上。 */
private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "dsh_remote")

/**
 * 连接配置的持久化（契约 §7 指定的 DataStore Preferences）。
 *
 * 只存 4 个值：`baseUrl` / `token` / `deviceId` / `deviceName`。
 * `deviceId` 在首次配对时生成并永久保留：契约 §2.2 规定同一 deviceId 重复配对会吊销旧令牌，
 * 因此重装 App 后拿到新 UUID、需要重新配对，这是预期行为。
 */
class PrefsStore(private val context: Context) {

    val settings: Flow<AppSettings?> = context.dataStore.data
        // 磁盘损坏时给一份空配置，而不是让 App 启动即崩（未配置时应进配置页）
        .catch { e -> if (e is IOException) emit(emptyPreferences()) else throw e }
        .map { prefs ->
            val baseUrl = prefs[KEY_BASE_URL].orEmpty()
            val token = prefs[KEY_TOKEN].orEmpty()
            val deviceId = prefs[KEY_DEVICE_ID].orEmpty()
            if (baseUrl.isEmpty() || token.isEmpty() || deviceId.isEmpty()) {
                null
            } else {
                AppSettings(
                    baseUrl = baseUrl,
                    token = token,
                    deviceId = deviceId,
                    deviceName = prefs[KEY_DEVICE_NAME].orEmpty().ifEmpty { "Android" },
                    serverName = prefs[KEY_SERVER_NAME]?.takeIf { it.isNotEmpty() },
                )
            }
        }

    /** 当前配置的快照；未配置时返回 null。 */
    suspend fun current(): AppSettings? = settings.first()

    /** deviceId 首次使用（含配对前探测）时生成并落库，保证配对与后续请求用同一个 id。 */
    suspend fun deviceId(): String {
        val existing = read(KEY_DEVICE_ID)
        if (!existing.isNullOrEmpty()) return existing
        val generated = UUID.randomUUID().toString()
        context.dataStore.edit { it[KEY_DEVICE_ID] = generated }
        return generated
    }

    suspend fun deviceName(): String = read(KEY_DEVICE_NAME).orEmpty().ifEmpty { "Android" }

    /** 保存连接信息；令牌与地址都非空才算"已配置"。 */
    suspend fun saveConnection(
        baseUrl: String,
        token: String,
        deviceName: String,
        serverName: String?,
    ): AppSettings {
        val deviceId = deviceId()
        val normalized = ApiClient.normalizeBaseUrl(baseUrl)
        context.dataStore.edit { prefs ->
            prefs[KEY_BASE_URL] = normalized
            prefs[KEY_TOKEN] = token
            prefs[KEY_DEVICE_ID] = deviceId
            prefs[KEY_DEVICE_NAME] = deviceName.ifBlank { "Android" }
            serverName?.let { prefs[KEY_SERVER_NAME] = it } ?: prefs.remove(KEY_SERVER_NAME)
        }
        Logger.i(TAG, "已保存服务器配置 baseUrl=$normalized serverName=${serverName.orEmpty()}")
        return AppSettings(
            baseUrl = normalized,
            token = token,
            deviceId = deviceId,
            deviceName = deviceName.ifBlank { "Android" },
            serverName = serverName,
        )
    }

    /** 仅更新服务器名（health 探测成功后回填）。 */
    suspend fun updateServerName(serverName: String) {
        context.dataStore.edit { it[KEY_SERVER_NAME] = serverName }
    }

    /** 解除配置：清掉地址与令牌，保留 deviceId（重装/重配时仍是同一台设备）。 */
    suspend fun clearConnection() {
        context.dataStore.edit { prefs ->
            prefs.remove(KEY_BASE_URL)
            prefs.remove(KEY_TOKEN)
            prefs.remove(KEY_SERVER_NAME)
        }
    }

    private suspend fun read(key: Preferences.Key<String>): String? =
        context.dataStore.data
            .catch { e -> if (e is IOException) emit(emptyPreferences()) else throw e }
            .first()[key]

    private companion object {
        const val TAG = "PrefsStore"
        val KEY_BASE_URL = stringPreferencesKey("baseUrl")
        val KEY_TOKEN = stringPreferencesKey("token")
        val KEY_DEVICE_ID = stringPreferencesKey("deviceId")
        val KEY_DEVICE_NAME = stringPreferencesKey("deviceName")
        val KEY_SERVER_NAME = stringPreferencesKey("serverName")
    }
}
