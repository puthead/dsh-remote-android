package com.deepseek.dshremote.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.deepseek.dshremote.Graph
import com.deepseek.dshremote.ui.vm.SetupViewModel
import com.deepseek.dshremote.ui.vm.appViewModel

/**
 * 配置页（需求 1）。
 *
 * 未配置服务器时 App 的入口页：这里不发任何网络请求就能正常渲染，
 * 网络动作只发生在用户点击"探测/配对"之后（需求：未配置不得崩溃或无网络请求）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SetupScreen(
    onDone: () -> Unit,
    onBack: (() -> Unit)? = null,
) {
    val viewModel = appViewModel { SetupViewModel(Graph.repository) }
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(ui.message) {
        ui.message?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.consumeMessage()
        }
    }
    LaunchedEffect(ui.savedTick) {
        if (ui.savedTick > 0) onDone()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("连接 PC 网关") },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.Default.ArrowBack, contentDescription = "返回")
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = "在 PC 上启动 dsh-remote 网关后，用下面的方式把手机接入。配对码由 PC 侧生成，一次性、5 分钟内有效。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            if (ui.isCleartext) {
                CleartextWarning()
            }

            OutlinedTextField(
                value = ui.baseUrl,
                onValueChange = viewModel::onBaseUrlChange,
                label = { Text("服务器地址") },
                placeholder = { Text("192.168.1.8:8787") },
                supportingText = { Text("可填 http:// 或 https://，省略协议头时默认 http") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth(),
            )

            OutlinedTextField(
                value = ui.deviceName,
                onValueChange = viewModel::onDeviceNameChange,
                label = { Text("设备名（PC 端识别用）") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(onClick = viewModel::probe, enabled = !ui.busy) {
                    Text("仅探测连通性")
                }
                if (ui.busy) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                }
            }

            ui.health?.let { health ->
                Card(
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                ) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("服务器：${health.serverName}", style = MaterialTheme.typography.titleSmall)
                        Text("网关版本 ${health.gatewayVersion} · dsh ${health.dshVersion} · API v${health.apiVersion}")
                        Text(
                            "活动任务 ${health.activeTasks} · 排队 ${health.queuedTasks} · " +
                                "配对${if (health.pairingOpen) "已开启" else "未开启"}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            HorizontalDivider()

            Text("方式一：配对码", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = ui.code,
                onValueChange = viewModel::onCodeChange,
                label = { Text("6 位配对码") },
                placeholder = { Text("482913") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                onClick = viewModel::pair,
                enabled = ui.canPair,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (ui.busy) "处理中…" else "配对并保存")
            }

            HorizontalDivider()

            Text("方式二：手动粘贴令牌", style = MaterialTheme.typography.titleMedium)
            Text(
                text = "配对码过期、或 PC 侧已存在本机令牌时使用。令牌形如 dshr_xxx，只保存本机。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                value = ui.token,
                onValueChange = viewModel::onTokenChange,
                label = { Text("设备令牌") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedButton(
                onClick = viewModel::saveToken,
                enabled = ui.canSaveToken,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("保存令牌并校验")
            }

            if (ui.pairedServerName != null) {
                TextButton(onClick = viewModel::disconnect) { Text("清除本机令牌并断开") }
            }

            Spacer(Modifier.height(24.dp))
        }
    }
}

/** 明文 HTTP 风险提示（需求 7）：内网可用，但不能让用户以为它是安全的。 */
@Composable
private fun CleartextWarning() {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.error.copy(alpha = 0.12f)),
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Icon(
                imageVector = Icons.Default.Warning,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
            )
            Text(
                text = "当前是明文 HTTP：同一 Wi-Fi 下，令牌与任务内容可被同网段设备嗅探或篡改。\n" +
                    "仅建议在可信家庭内网使用；需要跨公网时请叠加 Tailscale 或 frp+TLS，再改成 https:// 地址。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}
