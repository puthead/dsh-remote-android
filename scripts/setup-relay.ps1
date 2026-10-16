#Requires -Version 5.1
<#
.SYNOPSIS
  初始化中继（relay）运行目录：写 config.json（端口/名称/relaySecret/TLS 模式）、生成自签证书、打印隧道地址。

.DESCRIPTION
  严格按 docs/01-设计/协议契约-v2.md §2/§5 与 tools/dsh-relay/config.example.json 的键名生成配置，
  底层复用中继自带的 `node relay.mjs init`（幂等；stdout 只有一行 JSON，日志走 stderr）。

  行为：
    1. 校验 tools/dsh-relay/relay.mjs 是否存在；不存在 → 明确报「中继源码尚未实现」并退出（不静默失败）。
    2. 调 `relay.mjs init --home <运行目录> --port --host --relay-name --tls-mode [--relay-secret]`。
       * 已存在的 config.json 且未给 -Force / -RelaySecret 时保持原样（幂等）。
       * tls.mode=selfsigned 时生成本机自签证书（<运行目录>\tls\relay.crt|relay.key）。
    3. `tls.mode=file` 时把 -CertFile/-KeyFile 写回 config.json（init 不接收这两个参数）。
    4. 回读校验：port/host/tls.mode/relayName 必须与请求一致；打印隧道地址与下一步命令。
    5. `-RegisterHome` 时额外调 `relay.mjs home-token` 注册一台 PC，明文 homeToken 只写入
       <运行目录>\home-token.json（提醒：这是秘密，别贴聊天/日志）。

.PARAMETER TlsMode
  off（本机验证默认，明文 http/ws）| selfsigned（自签证书 https/wss）| file（自带证书，需 -CertFile/-KeyFile）。

.EXAMPLE
  powershell -File scripts/setup-relay.ps1 -Home ".runtime\relay-home"

.EXAMPLE
  # 本机验证：明文、非默认端口
  powershell -File scripts/setup-relay.ps1 -Home ".runtime\e2e-crossnetwork\relay" -Port 9443 -TlsMode off -Force

.NOTES
  执行策略：Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  兼容 Windows PowerShell 5.1（本机只有 5.1；不使用 PS7-only 语法）。
#>
[CmdletBinding()]
param(
    [Alias('Home')][string]$RelayHome,
    [int]$Port = 9443,
    [string]$BindHost = '0.0.0.0',
    [string]$RelayName = 'relay.local',
    [ValidateSet('off', 'selfsigned', 'file')][string]$TlsMode,
    [string]$RelaySecret,
    [string]$CertFile,
    [string]$KeyFile,
    [string]$PublicUrl,
    [string]$RelayDir,
    [string]$Node,
    [switch]$RegisterHome,
    [string]$HomeName,
    [switch]$Force,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_common.ps1')

Write-Banner -Title 'dsh-relay 中继初始化（setup-relay.ps1）' -SubTitle ("PowerShell: " + (Test-PowerShellEdition))

$relayHomeResolved = Resolve-RelayHome -Home $RelayHome
if (-not $RelayDir) { $RelayDir = Get-DefaultRelayDir }
$entry = Assert-RelaySource -RelayDir $RelayDir
$nodeExe = Find-NodeExe -Node $Node
if (-not $nodeExe) { throw '找不到 node.exe：请安装 Node.js 18+，或用 -Node "<node.exe 路径>" 指定。' }
$configPath = Get-RelayConfigPath -Home $relayHomeResolved

Write-Section '1/4 环境'
Write-Kv -Key '运行目录' -Value $relayHomeResolved
Write-Kv -Key '中继入口' -Value $entry
Write-Kv -Key '配置文件' -Value $configPath
Write-Kv -Key 'node.exe' -Value $nodeExe

# 已有的 tls 模式：未显式传 -TlsMode 时沿用配置，避免把用户的正式证书配置改回明文
$existingConfig = Get-ConfigDefaults -Home $relayHomeResolved
$effectiveTls = 'off'
if ($existingConfig) {
    $existingTls = Get-JsonProp -Object (Get-JsonProp -Object $existingConfig -Name 'tls') -Name 'mode' -Default 'off'
    if ($existingTls) { $effectiveTls = [string]$existingTls }
}
if ($PSBoundParameters.ContainsKey('TlsMode')) { $effectiveTls = $TlsMode }
if ($effectiveTls -eq 'file') {
    if (-not $CertFile -or -not $KeyFile) { throw 'tls.mode=file 必须同时提供 -CertFile 与 -KeyFile（PEM 或 PEM 链 + 私钥）。' }
    foreach ($f in @($CertFile, $KeyFile)) {
        if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw "证书/私钥文件不存在：$f" }
    }
}

Write-Section '2/4 初始化中继运行目录（node relay.mjs init）'
$initArgs = @(
    $entry, 'init',
    '--home', $relayHomeResolved,
    '--port', [string]$Port,
    '--host', $BindHost,
    '--relay-name', $RelayName,
    '--tls-mode', $effectiveTls,
    '--self-signed-dir', 'tls'
)
if ($RelaySecret) { $initArgs += @('--relay-secret', $RelaySecret) }
if ($Force) { $initArgs += '--force' }

Write-Info ("实测命令：" + $nodeExe + ' ' + (($initArgs | ForEach-Object { ConvertTo-CommandLineArgument -Value ([string]$_) }) -join ' '))
$initRun = Invoke-NativeCommand -FilePath $nodeExe -ArgumentList $initArgs -WorkingDirectory $RelayDir -TimeoutSec 120
if ($initRun.StdOut.Trim()) { Write-Host $initRun.StdOut.TrimEnd() -ForegroundColor DarkGray }
if ($initRun.StdErr.Trim()) { Write-Host $initRun.StdErr.TrimEnd() -ForegroundColor DarkGray }
if ($initRun.ExitCode -ne 0) {
    Write-Fail "relay.mjs init 失败（退出码 $($initRun.ExitCode)）"
    exit 1
}

Write-Section '3/4 回读校验'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "init 未生成配置文件：$configPath" }
$config = Read-JsonFile -Path $configPath

# tls.mode=file：把证书路径写回配置（init 不接收 --cert/--key）
if ($effectiveTls -eq 'file') {
    $tlsSection = Get-JsonProp -Object $config -Name 'tls'
    if ($tlsSection) {
        $tlsSection.mode = 'file'
        $tlsSection.certFile = [System.IO.Path]::GetFullPath($CertFile)
        $tlsSection.keyFile = [System.IO.Path]::GetFullPath($KeyFile)
        [void](Backup-ExistingFile -Path $configPath)
        Write-JsonFileNoBom -Path $configPath -Object $config
        Write-Info "已把 -CertFile/-KeyFile 写回 config.json（tls.mode=file）"
    }
}
if ($PublicUrl) {
    $config.publicUrl = $PublicUrl
    Write-JsonFileNoBom -Path $configPath -Object $config
    Write-Info "已写入 publicUrl=$PublicUrl"
}
$config = Read-JsonFile -Path $configPath

# 兼容旧配置：中继新版对 heartbeat.timeoutMs < intervalMs×2 直接拒绝启动（超时阈值等于周期
# 会让健康连接在第一个心跳周期就被误判死链，且不可自愈）。这里自动修复为 intervalMs×3。
$hbSection = Get-JsonProp -Object $config -Name 'heartbeat'
if ($hbSection) {
    $hbInterval = [int](Get-JsonProp -Object $hbSection -Name 'intervalMs' -Default 30000)
    $hbTimeout = [int](Get-JsonProp -Object $hbSection -Name 'timeoutMs' -Default 0)
    if ($hbTimeout -lt ($hbInterval * 2)) {
        [void](Backup-ExistingFile -Path $configPath)
        $hbSection.timeoutMs = $hbInterval * 3
        Write-JsonFileNoBom -Path $configPath -Object $config
        Write-Warn ("已自动修复 heartbeat.timeoutMs：$hbTimeout → $($hbInterval * 3)（中继要求 ≥ intervalMs×2，推荐 ×3）")
        $config = Read-JsonFile -Path $configPath
    }
}

$problems = New-Object System.Collections.ArrayList
$cfgPort = [int](Get-JsonProp -Object $config -Name 'port' -Default 0)
$cfgHost = [string](Get-JsonProp -Object $config -Name 'host' -Default '')
$cfgName = [string](Get-JsonProp -Object $config -Name 'relayName' -Default '')
$cfgTls = [string](Get-JsonProp -Object (Get-JsonProp -Object $config -Name 'tls') -Name 'mode' -Default '')
$cfgSecret = [string](Get-JsonProp -Object $config -Name 'relaySecret' -Default '')
if ($cfgPort -ne $Port) { [void]$problems.Add("port 期望 $Port，实际 $cfgPort") }
if ($cfgHost -ne $BindHost) { [void]$problems.Add("host 期望 $BindHost，实际 $cfgHost") }
if ($cfgTls -ne $effectiveTls) { [void]$problems.Add("tls.mode 期望 $effectiveTls，实际 $cfgTls") }
if (-not $cfgSecret) { [void]$problems.Add('relaySecret 为空（本机验证可以，公网部署必须设置）') }

$certPath = Join-Path (Join-Path $relayHomeResolved 'tls') 'relay.crt'
$keyPath = Join-Path (Join-Path $relayHomeResolved 'tls') 'relay.key'
$certExists = Test-Path -LiteralPath $certPath -PathType Leaf
$keyExists = Test-Path -LiteralPath $keyPath -PathType Leaf
if ($effectiveTls -eq 'selfsigned' -and (-not $certExists -or -not $keyExists)) {
    [void]$problems.Add("tls.mode=selfsigned 但证书未生成：$certPath / $keyPath")
}

$scheme = 'ws'
$httpScheme = 'http'
if ($effectiveTls -ne 'off') { $scheme = 'wss'; $httpScheme = 'https' }
$baseUrl = "$httpScheme`://127.0.0.1:$cfgPort"
# 隧道地址：publicUrl 优先；否则用 relayName；没有显式端口且不是该 scheme 的默认端口时补上端口
$tunnelHost = $PublicUrl
if (-not $tunnelHost) { $tunnelHost = $cfgName }
$hostPart = [string]$tunnelHost
if ($hostPart -match '^[a-z]+://') { $hostPart = $hostPart.TrimEnd('/') } else { $hostPart = "$scheme`://$hostPart" }
$defaultTlsPort = 80
if ($scheme -eq 'wss') { $defaultTlsPort = 443 }
if (-not ([regex]::IsMatch($hostPart, ':\d+$')) -and $cfgPort -ne $defaultTlsPort) { $hostPart = "$hostPart`:$cfgPort" }
$deviceTunnel = "$hostPart/api/v2/tunnel/device"
$homeTunnel = "$hostPart/api/v2/tunnel/home"

Write-Kv -Key 'relayName' -Value $cfgName
Write-Kv -Key '监听' -Value ("$cfgHost`:$cfgPort（TLS: $cfgTls）")
Write-Kv -Key 'relaySecret' -Value (Mask-Secret $cfgSecret)
Write-Kv -Key '本机 health' -Value "$baseUrl/health"
Write-Kv -Key 'phone 隧道' -Value $deviceTunnel
Write-Kv -Key 'PC 隧道' -Value $homeTunnel
if ($effectiveTls -eq 'selfsigned') {
    Write-Kv -Key '自签证书' -Value "$certPath（$([Math]::Round((Get-Item -LiteralPath $certPath).Length / 1024, 1)) KiB）"
    Write-Warn '自签证书仅用于开发/本机验证：手机 App 没有「信任自签证书」开关（需求 FR-15/O8），release 变体连不上。公网请用正式证书（tls.mode=file；无域名可用 Let''s Encrypt IP 地址证书，见 中继部署手册 §5.1）。'
}
if ($cfgHost -eq '0.0.0.0') {
    Write-Warn '中继监听 0.0.0.0：公网部署必须配合防火墙只放行本端口，且 relaySecret 不能为空。'
}

Write-Section '4/4 注册 home（可选）'
$homeTokenInfo = $null
if ($RegisterHome) {
    $name = $HomeName
    if (-not $name) { $name = $env:COMPUTERNAME }
    $tokenArgs = @($entry, 'home-token', '--home', $relayHomeResolved, '--name', $name)
    Write-Info ("实测命令：" + $nodeExe + ' ' + (($tokenArgs | ForEach-Object { ConvertTo-CommandLineArgument -Value ([string]$_) }) -join ' '))
    $tokenRun = Invoke-NativeCommand -FilePath $nodeExe -ArgumentList $tokenArgs -WorkingDirectory $RelayDir -TimeoutSec 60
    if ($tokenRun.ExitCode -ne 0) {
        Write-Fail "home-token 失败（退出码 $($tokenRun.ExitCode)）：$($tokenRun.StdErr.Trim())"
        [void]$problems.Add('home-token 注册失败')
    } else {
        $homeTokenInfo = $tokenRun.StdOut | ConvertFrom-Json
        $tokenFile = Join-Path $relayHomeResolved 'home-token.json'
        Write-JsonFileNoBom -Path $tokenFile -Object $homeTokenInfo
        Write-Ok "已注册 home：homeId=$([string](Get-JsonProp -Object $homeTokenInfo -Name 'homeId'))，明文 homeToken 只写入 $tokenFile"
        Write-Kv -Key 'homeToken' -Value ((Mask-Secret ([string](Get-JsonProp -Object $homeTokenInfo -Name 'homeToken'))) + '（仅本文件可见明文）')
        Write-Warn 'homeToken 是秘密：不要贴进聊天、日志或提交到仓库。'
    }
} else {
    Write-Info '未指定 -RegisterHome：跳过。网关连中继时会自动注册并持久化到 <网关运行目录>\relay.json（见契约 §2.2）。'
}

Write-Section '结果'
if ($problems.Count -gt 0) {
    foreach ($p in $problems) { Write-Fail $p }
    Write-Info '提示：relaySecret 为空只适用于本机回环验证；公网部署请设置。'
    exit 1
}
Write-Ok '中继运行目录已就绪，配置回读校验通过。'
$psHint = 'powershell'
Write-NextStep -Steps @(
    "$psHint -File scripts/start-relay.ps1 -Home `"$relayHomeResolved`"",
    "$psHint -File scripts/setup-relay.ps1 -Home `"$relayHomeResolved`" -RegisterHome   # 可选：预注册 PC 的 homeToken",
    "$psHint -File scripts/e2e-crossnetwork.ps1 -Home `".runtime\e2e-crossnetwork`"     # 跨网络等价拓扑 A~E"
)

if ($Json) {
    $payload = [ordered]@{
        home        = $relayHomeResolved
        configPath  = $configPath
        relayName   = $cfgName
        host        = $cfgHost
        port        = $cfgPort
        tlsMode     = $cfgTls
        relaySecret = (Mask-Secret $cfgSecret)
        healthUrl   = "$baseUrl/health"
        deviceTunnelUrl = $deviceTunnel
        homeTunnelUrl   = $homeTunnel
        homeId      = $(if ($homeTokenInfo) { [string](Get-JsonProp -Object $homeTokenInfo -Name 'homeId') } else { $null })
    }
    Write-Host ''
    Write-Host (ConvertTo-JsonText -InputObject $payload -Compress)
}
exit 0
