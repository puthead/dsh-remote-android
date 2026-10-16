#Requires -Version 5.1
<#
.SYNOPSIS
  在 PC 本机生成 6 位配对码（走回环 /api/v2/pair/open，同时在中继上打开配对窗口），并打印中继隧道地址 + 文本二维码。

.DESCRIPTION
  与 v1 的 scripts/pair.ps1 的差别：
    * v2 的配对码由网关的 `POST /api/v2/pair/open` 生成，网关会**同时**经隧道在中继上打开配对窗口
      （契约 §4.1），手机因此可以在任意网络下用「中继地址 + 6 位码」完成配对。
    * 打印给手机的是**中继隧道地址**（wss://relay.example.com/api/v2/tunnel/device），不是 PC 的局域网地址。
    * 二维码内容为 `dshremote2:pair?code=<code>&relay=<tunnelUrl>`（ASCII，字节模式，纠错等级 L）；
      渲染前跑内置自校验（scripts/_qrcode.ps1），不通过就只打印文字说明。
    * 网关 v2 路由尚未就绪时（HTTP 404）自动降级到 v1 `/api/v1/pair/open` 并**明确提示**：
      本次配对码没有在中继上打开窗口，只能走局域网直连（v1 形态）。

.EXAMPLE
  powershell -File scripts/relay-pair.ps1

.EXAMPLE
  powershell -File scripts/relay-pair.ps1 -Home ".runtime\e2e-crossnetwork\home" -Port 8787 -NoQr

.NOTES
  执行策略：Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  兼容 Windows PowerShell 5.1。
#>
[CmdletBinding()]
param(
    [Alias('Home')][string]$DshRemoteHome,
    [int]$Port = 0,
    [string]$BaseUrl,
    [string]$RelayUrl,
    [Alias('RelayHome')][string]$DshRelayHome,
    [switch]$NoQr,
    [switch]$AsciiQr,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_common.ps1')
. (Join-Path $PSScriptRoot '_qrcode.ps1')

Write-Banner -Title 'dsh-remote v2 配对码（relay-pair.ps1）' -SubTitle '回环 /api/v2/pair/open → 中继配对窗口'

$remoteHome = Resolve-DshRemoteHome -Home $DshRemoteHome
$config = Get-ConfigDefaults -Home $remoteHome
$effectivePort = [int](Get-JsonProp -Object $config -Name 'port' -Default $script:DefaultPort)
if ($Port -gt 0) { $effectivePort = $Port }
$loopbackUrl = "http://127.0.0.1:$effectivePort"
if ($BaseUrl) { $loopbackUrl = $BaseUrl.TrimEnd('/') }

Write-Section '1/4 网关健康'
Write-Kv -Key '运行目录' -Value $remoteHome
Write-Kv -Key '回环地址' -Value $loopbackUrl
$health = Get-GatewayHealth -BaseUrl $loopbackUrl -TimeoutSec 5
if (-not $health) {
    Write-Fail "网关未响应：$loopbackUrl/api/v1/health"
    Write-Info '请先启动网关：powershell -File scripts/start-gateway.ps1'
    exit 1
}
$capabilities = @()
$rawCaps = Get-JsonProp -Object $health -Name 'capabilities'
if ($rawCaps) { $capabilities = @($rawCaps | ForEach-Object { [string]$_ }) }
Write-Ok ("网关在线：" + [string](Get-JsonProp -Object $health -Name 'serverName') +
    " / 版本 " + [string](Get-JsonProp -Object $health -Name 'gatewayVersion') +
    " / dsh " + [string](Get-JsonProp -Object $health -Name 'dshVersion'))
if ($capabilities.Count -gt 0) { Write-Kv -Key 'capabilities' -Value ($capabilities -join ', ') }

Write-Section '2/4 生成配对码（v2 优先，404 降级 v1）'
$pairOpen = $null
$usedV2 = $false
$relayBlock = $null
$r2 = Invoke-DshV2Api -BaseUrl $loopbackUrl -Path '/api/v2/pair/open' -Method POST -TimeoutSec 15
if ($r2.Ok) {
    $pairOpen = $r2.Json
    $usedV2 = $true
    $relayBlock = Get-JsonProp -Object $pairOpen -Name 'relay'
    Write-Ok 'POST /api/v2/pair/open → 200（v2 配对码已生成）'
} elseif ($r2.Status -eq 404 -or $r2.Status -eq 405) {
    Write-Warn ("POST /api/v2/pair/open → HTTP $($r2.Status)：网关 v2 路由尚未实现/未启用。")
    Write-Info '降级到 v1 配对码：本次配对码**没有**在中继上打开配对窗口，手机只能走局域网直连（v1 形态）。'
    $pairOpen = Invoke-DshPairOpen -BaseUrl $loopbackUrl -TimeoutSec 10
} else {
    Write-Fail ("生成 v2 配对码失败：HTTP $($r2.Status) " + (Get-ApiErrorMessage -Result $r2))
    Write-Info '若提示 relay 未连接：先在网关侧执行 POST /api/v2/relay/connect（回环），或检查 relay.enabled/url 配置。'
    exit 1
}

$code = [string](Get-JsonProp -Object $pairOpen -Name 'code')
$expiresAt = Get-JsonProp -Object $pairOpen -Name 'expiresAt'
if ($code -notmatch '^\d{6}$') {
    Write-Fail "配对码格式异常（期望 6 位数字）：$code"
    exit 1
}
$expireTime = $null
$remainSec = 300
try {
    $expireTime = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$expiresAt).ToLocalTime()
    $remainSec = [int][Math]::Max(0, [Math]::Floor(($expireTime - [DateTimeOffset]::Now).TotalSeconds))
} catch { }

Write-Section '3/4 中继隧道地址'
$tunnelUrl = [string](Get-JsonProp -Object $relayBlock -Name 'tunnelUrl' -Default '')
$homeId = [string](Get-JsonProp -Object $relayBlock -Name 'homeId' -Default '')
$relayStatus = $null
try { $relayStatus = Get-GatewayRelayStatus -BaseUrl $loopbackUrl -TimeoutSec 5 } catch { $relayStatus = $null }
if (-not $tunnelUrl) {
    # 网关没给 relay 块：尝试从网关 relay 状态 / 中继配置推导，便于人工核对
    if ($relayStatus) {
        $relayName = [string](Get-JsonProp -Object $relayStatus -Name 'relayName' -Default '')
        $homeId = [string](Get-JsonProp -Object $relayStatus -Name 'homeId' -Default $homeId)
        if ($relayName) {
            if ($relayName -notmatch '^[a-z]+://') { $relayName = "wss://$relayName" }
            $tunnelUrl = ($relayName.TrimEnd('/') + '/api/v2/tunnel/device')
        }
    }
}
if (-not $tunnelUrl -and $RelayUrl) { $tunnelUrl = (ConvertTo-RelayTunnelWsUrl -BaseUrl $RelayUrl -Role 'device') }
if (-not $tunnelUrl) {
    $relayHomeResolved = Resolve-RelayHome -Home $DshRelayHome
    $relayConfig = Get-ConfigDefaults -Home $relayHomeResolved
    if ($relayConfig) {
        $publicUrl = [string](Get-JsonProp -Object $relayConfig -Name 'publicUrl' -Default '')
        if (-not $publicUrl) { $publicUrl = [string](Get-JsonProp -Object $relayConfig -Name 'relayName' -Default '') }
        if ($publicUrl) {
            $scheme = 'ws'
            $tlsMode = [string](Get-JsonProp -Object (Get-JsonProp -Object $relayConfig -Name 'tls') -Name 'mode' -Default 'off')
            if ($tlsMode -ne 'off') { $scheme = 'wss' }
            $relayPort = [int](Get-JsonProp -Object $relayConfig -Name 'port' -Default $script:DefaultRelayPort)
            if ($publicUrl -match '^[a-z]+://') { $tunnelUrl = ($publicUrl.TrimEnd('/') + '/api/v2/tunnel/device') }
            else { $tunnelUrl = "$scheme`://$publicUrl`:$relayPort/api/v2/tunnel/device" }
        }
    }
}
$relayConnected = $false
if ($relayStatus) { $relayConnected = ((Get-JsonProp -Object $relayStatus -Name 'connected') -eq $true) }

if ($tunnelUrl) {
    Write-Kv -Key '手机连中继' -Value $tunnelUrl
} else {
    Write-Kv -Key '手机连中继' -Value '(未获取到：中继未连接，或网关 v2 未实现)'
}
if ($homeId) { Write-Kv -Key 'homeId' -Value $homeId }
if ($relayStatus) {
    Write-Kv -Key 'relay 状态' -Value ("connected=" + [string](Get-JsonProp -Object $relayStatus -Name 'connected') +
        " / reconnects=" + [string](Get-JsonProp -Object $relayStatus -Name 'reconnects') +
        " / lastError=" + [string](Get-JsonProp -Object $relayStatus -Name 'lastError'))
}
if ($usedV2 -and -not $relayConnected) {
    Write-Warn '网关报告中继未连接：手机即使拿到码也换不到设备令牌（中继会返回 503 home_offline）。'
    Write-Info '处理：确认 scripts/start-relay.ps1 已启动，再在网关侧 POST /api/v2/relay/connect。'
}

Write-Section '4/4 配对码 / 二维码'
Write-Host ''
Write-Host ("        " + ($code.ToCharArray() -join '  ')) -ForegroundColor Black -BackgroundColor White
Write-Host ''
Write-Kv -Key '配对码' -Value $code
if ($expireTime) {
    Write-Kv -Key '有效期至' -Value ("$($expireTime.ToString('yyyy-MM-dd HH:mm:ss'))（剩余约 $remainSec 秒）")
} else {
    Write-Kv -Key '有效期' -Value '默认 5 分钟，一次性使用'
}
$qrPayload = "dshremote2:pair?code=$code"
if ($tunnelUrl) { $qrPayload += "&relay=$tunnelUrl" }
Write-Kv -Key '二维码内容' -Value $qrPayload

if ($NoQr) {
    Write-Skip '已指定 -NoQr：不生成二维码，按上面的中继地址 + 6 位配对码手动配对。'
} else {
    $qrOk = $false
    try {
        $matrix = New-QrMatrix -Text $qrPayload -EccLevel 'L' -MaxVersion 6
        $check = Test-QrSelfCheck -Matrix $matrix -Text $qrPayload
        if (-not $check.Ok) {
            Write-Warn '二维码自校验未通过，已放弃打印（避免给出扫不出来的图）：'
            foreach ($item in $check.Details) {
                if (-not $item.Passed) { Write-Info ("  - 失败项：" + $item.Name + " —— " + $item.Note) }
            }
        } else {
            Write-Info ("自校验通过：版本 $($matrix.Version) / 纠错 L / 掩码 $($matrix.Mask) / $($matrix.DataBytes) 字节")
            Write-Host ''
            Write-Host (Format-QrText -Matrix $matrix -QuietZone 4 -AsciiOnly:$AsciiQr) -ForegroundColor White
            Write-Host ''
            $qrOk = $true
        }
    } catch {
        Write-Warn ("二维码生成失败：" + $_.Exception.Message)
    }
    if (-not $qrOk) { Write-Info '不影响使用：手输「中继地址 + 6 位配对码」即可。' }
}

Write-Section '配对步骤（手机在任意网络下）'
if ($usedV2 -and $tunnelUrl) {
    Write-Info '1) 手机打开 DshRemote → 设置页 → 中继地址填：'
    Write-Info "     $tunnelUrl"
    Write-Info "2) 配对码填：$code（剩余约 $remainSec 秒）"
    Write-Info '3) 点「配对」→ 中继把 claim 转发给 PC 网关，成功后会返回 deviceToken'
    Write-Info '4) 之后所有请求（会话列表 / 续聊 / 工作区）都经中继隧道，手机不需要能访问 PC。'
} else {
    Write-Info '1) 当前是 v1 降级形态：手机需要与 PC 处于同一局域网，服务器地址填 http://<PC内网IP>:端口'
    Write-Info "2) 配对码填：$code（剩余约 $remainSec 秒）"
    Write-Info '3) 想走中继：先完成 tools/dsh-relay 部署 + 网关 /api/v2/relay/connect，再重新运行本脚本。'
}
Write-Info '注意：配对码一次性使用；过期或已用请重新运行本脚本。'

if ($Json) {
    $payload = [ordered]@{
        code        = $code
        expiresAt   = $expiresAt
        remainSec   = $remainSec
        usedV2      = $usedV2
        tunnelUrl   = $tunnelUrl
        homeId      = $homeId
        relayConnected = $relayConnected
        qrPayload   = $qrPayload
        gateway     = $loopbackUrl
    }
    Write-Host ''
    Write-Host (ConvertTo-JsonText -InputObject $payload -Compress)
}
exit 0
