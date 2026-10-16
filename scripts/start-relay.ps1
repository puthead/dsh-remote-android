#Requires -Version 5.1
<#
.SYNOPSIS
  后台启动中继（relay）：分离启动 + PID 文件 + health 等待，幂等。

.DESCRIPTION
  行为：
    1. 校验 tools/dsh-relay/relay.mjs 与 <运行目录>\config.json（缺失时提示先跑 setup-relay.ps1）。
    2. 若 <运行目录>\relay.pid.json 里的进程仍在且 /health 正常 → 直接提示「已在运行」并返回 0（幂等）。
    3. 端口被别的进程占用 → 区分「就是中继」和「不是中继」，后者明确报错。
    4. 分离启动：node relay.mjs serve --home <运行目录>
       * stdout 只有一行 JSON（含真实端口/pid），日志走 stderr —— 分别落盘到 logs\relay-console-*.log / .err.log。
       * WMI Win32_Process.Create + scripts/tests/detached-run.mjs，避免宿主等到服务退出。
    5. 轮询 /health 就绪后写 relay.pid.json（含真实 PID、端口、baseUrl、TLS 模式）。

.PARAMETER Foreground
  前台运行（排障用；Ctrl+C 结束；不写 PID 文件）。

.EXAMPLE
  powershell -File scripts/start-relay.ps1 -Home ".runtime\relay-home"

.EXAMPLE
  powershell -File scripts/start-relay.ps1 -Home ".runtime\e2e-crossnetwork\relay" -Port 9443

.NOTES
  执行策略：Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  兼容 Windows PowerShell 5.1。
#>
[CmdletBinding()]
param(
    [Alias('Home')][string]$RelayHome,
    [int]$Port = 0,
    [string]$RelayDir,
    [string]$Node,
    [string]$ConfigPath,
    [switch]$Foreground,
    [int]$WaitSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_common.ps1')

Write-Banner -Title 'dsh-relay 中继启动（start-relay.ps1）' -SubTitle ("PowerShell: " + (Test-PowerShellEdition))

$relayHomeResolved = Resolve-RelayHome -Home $RelayHome
if (-not $RelayDir) { $RelayDir = Get-DefaultRelayDir }
$entry = Assert-RelaySource -RelayDir $RelayDir
if (-not $ConfigPath) { $ConfigPath = Get-RelayConfigPath -Home $relayHomeResolved }
$psHint = 'powershell'
$homeArg = ''
if ($RelayHome) { $homeArg = " -Home `"$relayHomeResolved`"" }

Write-Section '1/4 读取配置'
Write-Kv -Key '运行目录' -Value $relayHomeResolved
Write-Kv -Key '中继入口' -Value $entry
Write-Kv -Key '配置文件' -Value $ConfigPath
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw ("找不到中继配置：$ConfigPath`n  请先执行：$psHint -File scripts/setup-relay.ps1$homeArg")
}
$config = Read-JsonFile -Path $ConfigPath
$configPort = [int](Get-JsonProp -Object $config -Name 'port' -Default $script:DefaultRelayPort)
$tlsMode = [string](Get-JsonProp -Object (Get-JsonProp -Object $config -Name 'tls') -Name 'mode' -Default 'off')
if ($tlsMode -ne 'off') {
    Write-Warn "tls.mode=$tlsMode：本机 health 检查将使用 https（自签证书或只绑公网 IP 的证书都无法在回环校验通过，故加 -Insecure —— 仅本机验证，不代表手机侧可用）。"
}
$effectivePort = $configPort
if ($Port -gt 0) { $effectivePort = $Port }
$baseUrl = Get-RelayBaseUrl -Home $relayHomeResolved -Port $(if ($Port -gt 0) { $Port } else { 0 })
$insecure = ($tlsMode -ne 'off')

$nodeExe = Find-NodeExe -Node $Node
if (-not $nodeExe) { throw '找不到 node.exe：请安装 Node.js 18+，或用 -Node "<node.exe 路径>" 指定。' }
Write-Kv -Key '监听端口' -Value ([string]$effectivePort)
Write-Kv -Key '本机地址' -Value $baseUrl
Write-Kv -Key 'node.exe' -Value $nodeExe

Write-Section '2/4 重复启动检测'
$pidPath = Get-RelayPidFilePath -Home $relayHomeResolved
$pidInfo = Read-RelayPidInfo -Home $relayHomeResolved
$health = Get-RelayHealth -BaseUrl $baseUrl -TimeoutSec 4 -Insecure:$insecure
if ($health) {
    $runningPid = 0
    if ($pidInfo) { $runningPid = [int](Get-JsonProp -Object $pidInfo -Name 'pid' -Default 0) }
    Write-Ok '中继已在运行（/health ok:true）。'
    Write-Kv -Key 'PID' -Value ([string]$runningPid)
    Write-Kv -Key '中继名称' -Value ([string](Get-JsonProp -Object $health -Name 'relayName'))
    Write-Kv -Key '中继版本' -Value ([string](Get-JsonProp -Object $health -Name 'relayVersion'))
    Write-Kv -Key '已注册 home' -Value ([string](Get-JsonProp -Object $health -Name 'homes'))
    Write-Kv -Key '在线设备' -Value ([string](Get-JsonProp -Object $health -Name 'devices'))
    Write-Info '无需重复启动。如需重启：先 stop-relay.ps1 再 start-relay.ps1。'
    exit 0
}
if ($pidInfo) {
    $stalePid = [int](Get-JsonProp -Object $pidInfo -Name 'pid' -Default 0)
    if ($stalePid -gt 0 -and (Test-ProcessAlive -ProcessId $stalePid)) {
        Write-Warn "PID 文件中的进程 $stalePid 仍存活，但 $baseUrl/health 无响应（可能仍在启动或已卡死）。"
        Write-Info "建议先执行：$psHint -File scripts/stop-relay.ps1$homeArg"
    } else {
        Write-Info "清理过期的 PID 文件（进程 $stalePid 已不存在）：$pidPath"
        Remove-Item -LiteralPath $pidPath -Force
    }
}
$portOwner = Get-PortOwnerProcessId -Port $effectivePort
if ($portOwner -gt 0) {
    throw ("端口 $effectivePort 已被 PID $portOwner 占用，但它不是本脚本启动的中继（/health 无响应）。`n" +
           "  处理：结束该进程，或用 -Port <其它端口> 启动。查看：netstat -ano | findstr :$effectivePort")
}

Write-Section '3/4 启动中继'
if ($Foreground) {
    Write-Info '前台模式运行（Ctrl+C 结束；不写 PID 文件）'
    Write-Host ''
    & $nodeExe $entry serve --home $relayHomeResolved
    exit $LASTEXITCODE
}

$logsDir = Join-Path $relayHomeResolved 'logs'
if (-not (Test-Path -LiteralPath $logsDir -PathType Container)) { [void](New-Item -ItemType Directory -Force -Path $logsDir) }
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$outLog = Join-Path $logsDir "relay-console-$stamp.log"
$errLog = Join-Path $logsDir "relay-console-$stamp.err.log"

$serveArgs = @($entry, 'serve', '--home', $relayHomeResolved)
if ($Port -gt 0) { $serveArgs += @('--port', [string]$Port) }
$started = Start-DetachedCommand -FilePath $nodeExe -ArgumentList $serveArgs -WorkingDirectory $RelayDir `
    -StdOutLog $outLog -StdErrLog $errLog -WaitSeconds 20
Write-Info "启动方式：$($started.LaunchMode)"
Write-Info "已拉起中继进程 PID $($started.Pid)，等待 /health 就绪（最多 $WaitSeconds 秒）…"

Write-Section '4/4 健康检查'
$health = Wait-RelayHealth -BaseUrl $baseUrl -TimeoutSec $WaitSeconds -Insecure:$insecure
if (-not $health) {
    Write-Fail "中继未在 $WaitSeconds 秒内就绪：$baseUrl/health 无响应"
    foreach ($logPath in @($errLog, $outLog)) {
        $tail = @(Get-TextFileTail -Path $logPath -Lines 15)
        if ($tail.Count -gt 0) {
            Write-Host ''
            Write-Host "  ── $logPath 末尾 ──" -ForegroundColor DarkYellow
            foreach ($line in $tail) { Write-Host ("  " + $line) -ForegroundColor DarkGray }
        }
    }
    Write-Info '常见原因：端口被占、tls 证书缺失/不可读、config.json 键名不合法。'
    exit 1
}

# stdout 第一行 JSON 里有真实端口与 PID（port=0 时由系统分配），优先用它
$realPid = $started.Pid
$realPort = $effectivePort
$stdoutText = ''
if (Test-Path -LiteralPath $outLog -PathType Leaf) {
    try { $stdoutText = Read-TextFileUtf8 -Path $outLog } catch { $stdoutText = '' }
}
foreach ($line in @($stdoutText -split "`r?`n")) {
    $t = $line.Trim()
    if (-not $t.StartsWith('{')) { continue }
    try {
        $parsed = $t | ConvertFrom-Json
        $p = [int](Get-JsonProp -Object $parsed -Name 'port' -Default 0)
        $procId = [int](Get-JsonProp -Object $parsed -Name 'pid' -Default 0)
        if ($p -gt 0) { $realPort = $p }
        if ($procId -gt 0) { $realPid = $procId }
        break
    } catch { }
}
if ($realPort -ne $effectivePort) {
    Write-Info "中继实际监听端口为 $realPort（配置为 $effectivePort），已按实际端口记录。"
    $baseUrl = Get-RelayBaseUrl -Home $relayHomeResolved -Port $realPort
}

$pidRecord = [ordered]@{
    pid         = $realPid
    launcherPid = $started.LauncherPid
    launchMode  = $started.LaunchMode
    port        = $realPort
    tlsMode     = $tlsMode
    baseUrl     = $baseUrl
    home        = $relayHomeResolved
    node        = $nodeExe
    entry       = $entry
    configPath  = $ConfigPath
    startedAt   = (Get-Date).ToString('o')
    stdoutLog   = $outLog
    stderrLog   = $errLog
    scriptPid   = $PID
}
Write-JsonFileNoBom -Path $pidPath -Object $pidRecord

Write-Ok "中继已就绪：$baseUrl（node PID $realPid）"
Write-Kv -Key '中继名称' -Value ([string](Get-JsonProp -Object $health -Name 'relayName'))
Write-Kv -Key '中继版本' -Value ([string](Get-JsonProp -Object $health -Name 'relayVersion'))
Write-Kv -Key 'apiVersion' -Value ([string](Get-JsonProp -Object $health -Name 'apiVersion'))
Write-Kv -Key 'PID 文件' -Value $pidPath
Write-Kv -Key '控制台日志' -Value $outLog
Write-Kv -Key '错误日志' -Value $errLog

Write-NextStep -Steps @(
    "$psHint -File scripts/relay-pair.ps1$homeArg",
    "$psHint -File scripts/e2e-crossnetwork.ps1 -Home `".runtime\e2e-crossnetwork`"",
    "$psHint -File scripts/stop-relay.ps1$homeArg"
)
exit 0
