#Requires -Version 5.1
<#
.SYNOPSIS
  后台启动 dsh-remote 网关（写入 PID 文件，重复启动有检测）。

.DESCRIPTION
  行为：
    1. 读取运行目录下的 config.json（缺文件会明确提示先跑 setup-pc.ps1）。
    2. 若 PID 文件里的进程仍在运行且 /api/v1/health 正常 → 直接提示「已在运行」并返回 0（幂等）。
    3. 若端口已被别的进程占用 → 区分「就是网关」和「不是网关」两种情况，后者明确报错。
    4. 后台启动：node gateway.mjs serve --config <home>\config.json --home <home>
       stdout/stderr 落盘到 <home>\logs\gateway-console-<时间戳>.log / .err.log。
    5. 启动后轮询 /api/v1/health，就绪才写 PID 文件；失败则打印日志尾部并非 0 退出。

.PARAMETER Foreground
  前台运行（便于排障），Ctrl+C 结束；此模式不写 PID 文件。

.EXAMPLE
  pwsh -File scripts/start-gateway.ps1

.EXAMPLE
  # 用测试运行目录与测试端口
  pwsh -File scripts/start-gateway.ps1 -Home ".runtime\scripts-selftest" -Port 18787

.NOTES
  执行策略：Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  兼容 Windows PowerShell 5.1 与 PowerShell 7.x。
#>
[CmdletBinding()]
param(
    [Alias('Home')][string]$DshRemoteHome,
    [int]$Port = 0,
    [string]$GatewayDir,
    [string]$Node,
    [string]$ConfigPath,
    [string[]]$Env = @(),
    [switch]$Foreground,
    [int]$WaitSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_common.ps1')

Write-Banner -Title 'dsh-remote 网关启动（start-gateway.ps1）' -SubTitle ("PowerShell: " + (Test-PowerShellEdition))

$remoteHome = Resolve-DshRemoteHome -Home $DshRemoteHome
if (-not $GatewayDir) { $GatewayDir = Get-DefaultGatewayDir }
$gatewayEntry = Assert-GatewaySource -GatewayDir $GatewayDir
if (-not $ConfigPath) { $ConfigPath = Join-Path $remoteHome 'config.json' }
$homeArg = ''
if ($DshRemoteHome) { $homeArg = " -Home `"$remoteHome`"" }
$psHint = 'pwsh'
if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) { $psHint = 'powershell' }

Write-Section '1/4 读取配置'
Write-Kv -Key '运行目录' -Value $remoteHome
Write-Kv -Key '网关入口' -Value $gatewayEntry
Write-Kv -Key '配置文件' -Value $ConfigPath
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw ("找不到配置文件：$ConfigPath`n  请先执行：$psHint -File scripts/setup-pc.ps1$homeArg")
}
$config = Read-JsonFile -Path $ConfigPath

$effectivePort = [int](Get-JsonProp -Object $config -Name 'port' -Default $script:DefaultPort)
if ($Port -gt 0) { $effectivePort = $Port }
$baseUrl = "http://127.0.0.1:$effectivePort"

$dshSection = Get-JsonProp -Object $config -Name 'dsh'
$nodeExe = $Node
if (-not $nodeExe) { $nodeExe = [string](Get-JsonProp -Object $dshSection -Name 'node' -Default '') }
if ($nodeExe -and -not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) { $nodeExe = $null }
if (-not $nodeExe) { $nodeExe = Find-NodeExe -DshHome $env:DSH_HOME }
if (-not $nodeExe) { throw '找不到 node.exe：请安装 Node.js 18+，或用 -Node "<node.exe 路径>" 指定。' }

Write-Kv -Key '监听端口' -Value ([string]$effectivePort)
Write-Kv -Key '本机地址' -Value $baseUrl
Write-Kv -Key 'node.exe' -Value $nodeExe

Write-Section '2/4 重复启动检测'
$pidInfo = Read-GatewayPidInfo -Home $remoteHome
$pidPath = Get-PidFilePath -Home $remoteHome
$health = Get-GatewayHealth -BaseUrl $baseUrl -TimeoutSec 4
if ($health) {
    $runningPid = Get-JsonProp -Object $pidInfo -Name 'pid' -Default 0
    Write-Ok "网关已在运行（health ok:true）。"
    Write-Kv -Key 'PID' -Value ([string]$runningPid)
    Write-Kv -Key '服务器名' -Value ([string](Get-JsonProp -Object $health -Name 'serverName'))
    Write-Kv -Key '网关版本' -Value ([string](Get-JsonProp -Object $health -Name 'gatewayVersion'))
    Write-Kv -Key 'dsh 版本' -Value ([string](Get-JsonProp -Object $health -Name 'dshVersion'))
    Write-Info '无需重复启动。如需重启：先 stop-gateway.ps1 再 start-gateway.ps1。'
    exit 0
}
if ($pidInfo) {
    $stalePid = [int](Get-JsonProp -Object $pidInfo -Name 'pid' -Default 0)
    if ($stalePid -gt 0 -and (Test-ProcessAlive -ProcessId $stalePid)) {
        Write-Warn "PID 文件中的进程 $stalePid 仍存活，但 $baseUrl/api/v1/health 无响应。"
        Write-Info '可能仍在启动中或已卡死；建议先执行：pwsh -File scripts/stop-gateway.ps1'
    } else {
        Write-Info "清理过期的 PID 文件（进程 $stalePid 已不存在）：$pidPath"
        Remove-Item -LiteralPath $pidPath -Force
    }
}
$portOwner = Get-PortOwnerProcessId -Port $effectivePort
if ($portOwner -gt 0) {
    throw ("端口 $effectivePort 已被 PID $portOwner 占用，但它不是本脚本启动的网关（health 无响应）。`n" +
           "  处理：结束该进程，或用 -Port <其它端口> 启动。查看：netstat -ano | findstr :$effectivePort")
}

Write-Section '3/4 启动网关'
# -Env 用于隔离环境（例如 E2E 把 DSH_HOME 指到测试目录，绝不污染真实 ~/.dsh）。
# 语法：-Env "K=V" -Env "K2=V2"（WMI 路线不继承调用方环境，必须显式 set）。
$envPairs = New-Object System.Collections.ArrayList
foreach ($item in @($Env)) {
    if (-not $item) { continue }
    $eq = $item.IndexOf('=')
    if ($eq -le 0) { throw "-Env 需要 K=V 形式，收到：$item" }
    [void]$envPairs.Add([pscustomobject]@{ Key = $item.Substring(0, $eq); Value = $item.Substring($eq + 1) })
}
if ($envPairs.Count -gt 0) {
    Write-Kv -Key '注入环境变量' -Value (($envPairs | ForEach-Object { $_.Key }) -join ', ')
}
if ($Foreground) {
    Write-Info '前台模式运行（Ctrl+C 结束；不写 PID 文件）'
    foreach ($pair in $envPairs) { [System.Environment]::SetEnvironmentVariable($pair.Key, $pair.Value, 'Process') }
    Write-Host ''
    & $nodeExe $gatewayEntry serve --config $ConfigPath --home $remoteHome
    exit $LASTEXITCODE
}

$logsDir = Join-Path $remoteHome 'logs'
if (-not (Test-Path -LiteralPath $logsDir -PathType Container)) { [void](New-Item -ItemType Directory -Force -Path $logsDir) }
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$outLog = Join-Path $logsDir "gateway-console-$stamp.log"
$errLog = Join-Path $logsDir "gateway-console-$stamp.err.log"
# node 退出时把退出码写在这里：排查「网关进程悄悄没了」时能区分
# 正常退出(0) / JS 崩溃(1) / 被 Ctrl+C 结束(3221225786 = 0xC000013A)。
$exitLog = Join-Path $logsDir "gateway-exit-$stamp.log"

function Quote-Arg {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value -match '[\s"]') { return ('"' + $Value.Replace('"', '\"') + '"') }
    return $Value
}

$arguments = @(
    (Quote-Arg $gatewayEntry)
    'serve'
    '--config', (Quote-Arg $ConfigPath)
    '--home', (Quote-Arg $remoteHome)
)
if ($Port -gt 0) { $arguments += @('--port', [string]$Port) }

# 为什么用 WMI 创建进程（Win32_Process.Create）而不是 Start-Process：
#   Start-Process 拉起的子进程会继承当前会话的标准句柄 / 作业对象，
#   在 CI、Agent、任务编排等「捕获输出的宿主」里会导致宿主一直等到网关退出才返回。
#   WMI 由 WmiPrvSE 创建进程，与当前会话完全解耦；cmd.exe 只负责 cd 与日志重定向，本体即刻退出。
$launcherPid = 0
$launchMode = ''
$envPrefix = ''
foreach ($pair in $envPairs) {
    $envPrefix += 'set "' + $pair.Key + '=' + $pair.Value + '" && '
}
# 退出码记录必须用「延迟展开」（cmd /v:on + !VAR!）：
#   cmd 在解析整行时就会把 %ERRORLEVEL% / %TIME% 展开成启动前的旧值与启动时刻，
#   只有 !ERRORLEVEL! / !TIME! 才会在命令真正结束后取值 —— 否则记下来的是「启动时 = 0」这种假证据。
# 取子串是为了只留 ASCII（!DATE! 在中文系统上带「周二」，会让记录文件变成 GBK 编码、与其它日志不一致）。
$innerCommand = $envPrefix + 'cd /d "' + (Split-Path -Parent $gatewayEntry) + '" && "' + $nodeExe + '" ' + ($arguments -join ' ') +
    ' 1> "' + $outLog + '" 2> "' + $errLog + '"' +
    ' & echo [!DATE:~0,10! !TIME:~0,8!] node exit=!ERRORLEVEL! >> "' + $exitLog + '"'
$launchCommandLine = 'cmd.exe /v:on /c "' + $innerCommand + '"'
try {
    $createResult = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $launchCommandLine } -ErrorAction Stop
    if ($createResult.ReturnValue -eq 0 -and $createResult.ProcessId -gt 0) {
        $launcherPid = [int]$createResult.ProcessId
        $launchMode = '分离启动（WMI Win32_Process.Create + cmd 重定向）'
    }
} catch {
    Write-Warn "WMI 分离启动不可用（$($_.Exception.Message)），回退 Start-Process。"
}
if ($launcherPid -le 0) {
    if ($envPairs.Count -gt 0) { Write-Warn 'Start-Process 回退路线无法注入环境变量（-Env 会被忽略）；请改用 WMI 路线或 -Foreground。' }
    $proc = Start-Process -FilePath $nodeExe -ArgumentList $arguments -PassThru -WindowStyle Hidden `
        -WorkingDirectory (Split-Path -Parent $gatewayEntry) `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $launcherPid = $proc.Id
    $launchMode = 'Start-Process 回退（在捕获输出的宿主里会等到网关退出才返回）'
}
Write-Info "启动方式：$launchMode"
Write-Info "已拉起进程 PID $launcherPid，等待 health 就绪（最多 $WaitSeconds 秒）…"

Write-Section '4/4 健康检查'
$health = Wait-GatewayHealth -BaseUrl $baseUrl -TimeoutSec $WaitSeconds
if (-not $health) {
    Write-Fail "网关未在 $WaitSeconds 秒内就绪：$baseUrl/api/v1/health 无响应"
    if (Test-Path -LiteralPath $errLog -PathType Leaf) {
        $tail = @(Get-Content -LiteralPath $errLog -Tail 15 -ErrorAction SilentlyContinue)
        if ($tail.Count -gt 0) {
            Write-Host ''
            Write-Host "  ── $errLog 末尾 ──" -ForegroundColor DarkYellow
            foreach ($line in $tail) { Write-Host ("  " + $line) -ForegroundColor DarkGray }
        }
    }
    if (Test-Path -LiteralPath $outLog -PathType Leaf) {
        $tailOut = @(Get-Content -LiteralPath $outLog -Tail 15 -ErrorAction SilentlyContinue)
        if ($tailOut.Count -gt 0) {
            Write-Host ''
            Write-Host "  ── $outLog 末尾 ──" -ForegroundColor DarkYellow
            foreach ($line in $tailOut) { Write-Host ("  " + $line) -ForegroundColor DarkGray }
        }
    }
    Write-Info '常见原因：凭据文件格式错（必须单行 UTF-8 无 BOM）、端口被占、node 版本过低。'
    exit 1
}

# 端口占用者就是真正在跑的 node 进程；WMI 路线的 launcherPid 是短命的 cmd.exe，仅作兜底记录。
$nodePid = Get-PortOwnerProcessId -Port $effectivePort
if ($nodePid -le 0) { $nodePid = $launcherPid }

$pidRecord = [ordered]@{
    pid         = $nodePid
    launcherPid = $launcherPid
    launchMode  = $launchMode
    port        = $effectivePort
    baseUrl     = $baseUrl
    home        = $remoteHome
    node        = $nodeExe
    entry       = $gatewayEntry
    configPath  = $ConfigPath
    startedAt   = (Get-Date).ToString('o')
    stdoutLog   = $outLog
    stderrLog   = $errLog
    exitLog     = $exitLog
    scriptPid   = $PID
}
Write-JsonFileNoBom -Path $pidPath -Object $pidRecord

Write-Ok "网关已就绪：$baseUrl（node PID $nodePid）"
Write-Kv -Key '服务器名' -Value ([string](Get-JsonProp -Object $health -Name 'serverName'))
Write-Kv -Key '网关版本' -Value ([string](Get-JsonProp -Object $health -Name 'gatewayVersion'))
Write-Kv -Key 'dsh 版本' -Value ([string](Get-JsonProp -Object $health -Name 'dshVersion'))
Write-Kv -Key 'apiVersion' -Value ([string](Get-JsonProp -Object $health -Name 'apiVersion'))
Write-Kv -Key 'PID 文件' -Value $pidPath
Write-Kv -Key '控制台日志' -Value $outLog
Write-Kv -Key '错误日志' -Value $errLog
Write-Kv -Key '退出码记录' -Value $exitLog

$homeArg = ''
if ($DshRemoteHome) { $homeArg = " -Home `"$remoteHome`"" }
Write-NextStep -Steps @(
    "$psHint -File scripts/pair.ps1$homeArg -Port $effectivePort",
    "$psHint -File scripts/selftest.ps1$homeArg -Port $effectivePort",
    "$psHint -File scripts/stop-gateway.ps1$homeArg"
)
exit 0
