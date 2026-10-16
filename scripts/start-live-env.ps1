#Requires -Version 5.1
<#
.SYNOPSIS
  一键起「活动环境（live-env）」：本机回环中继 + 跑新代码的网关，让模拟器 App 真在线。

.DESCRIPTION
  这是一套**完全隔离**的联调夹具，不碰生产实例（生产网关 8787 / 公网中继 9443 / PID 396）：

    中继：node tools/dsh-relay/relay.mjs  serve --home .runtime\live-env\relay-home --port 9700 --host 127.0.0.1
    网关：node tools/dsh-remote/gateway.mjs serve --config .runtime\live-env\config.json --home .runtime\live-env\home

  关键点（为什么手机能看到「真会话」）：
    * 网关配置里 mirror.dshHome / desktop.dshHome 指向**真实桌面端 home**（%USERPROFILE%\.dsh），
      desktop.port 指向真实桌面端运行时 127.0.0.1:19387 → 「电脑会话」列表来自真 runtime，不是离线快照。
    * relay.url 指向本机回环中继；Android 模拟器用 10.0.2.2 访问宿主回环，
      所以 App 侧中继地址是 ws://10.0.2.2:<RelayPort>（脚本会打印/注入这个地址）。

  幂等性：
    * 中继/网关已在跑（PID 文件 + 健康检查都通过）→ 跳过启动，只做校验。
    * 中继配置（含 relaySecret）只在缺失时 init；已存在就原样继承 → 已配对的 App **不会**失效。
    * 网关配置每次按当前参数重写（值全部由参数推导），避免端口/home 漂移；_readme 里已声明会被覆盖。

  退出码：0=成功；1=未预期异常；2=前置缺失/参数非法；3=端口被别的进程占用；4=启动超时；5=-Pair 配对失败。

.PARAMETER RelayPort
  本机回环中继端口，默认 9700。已存在中继配置时以配置里的端口为准（改端口需要 -Force 重新 init，且 App 需重新配对）。

.PARAMETER GatewayPort
  网关 HTTP 端口，默认 18087。

.PARAMETER RuntimeDir
  运行根目录，默认 <repo>\.runtime\live-env（PID/配置/日志/状态都放这里）。

.PARAMETER RelayHome
  中继运行目录，默认 <RuntimeDir>\relay-home。

.PARAMETER GatewayHome
  网关运行 home（凭据/tasks/devices），默认 <RuntimeDir>\home。注意：**不是**被镜像的桌面端 home。

.PARAMETER GatewayConfig
  网关配置文件，默认 <RuntimeDir>\config.json。

.PARAMETER MirrorHome
  被只读镜像的真实桌面端 home，默认 %USERPROFILE%\.dsh。

.PARAMETER DesktopPort
  真实桌面端运行时端口，默认 19387。

.PARAMETER PublicHost
  打印/注入给模拟器用的宿主机别名，默认 10.0.2.2（Android 模拟器访问宿主回环的固定地址）。

.PARAMETER Pair
  顺带把模拟器 App 配对到本中继（adb 驱动：下滚 → 点「填入示例（debug）」→ 点「配对并连接」→ 校验已连接）。
  不加这个开关时脚本只起服务，App 侧配对命令会打印出来。

.PARAMETER DeviceSerial
  adb 设备序列号，默认 emulator-5554。

.PARAMETER Force
  端口/配置冲突时强制重建（会重新 init 中继配置 → relaySecret 变化 → 已配对的 App 必须重新配对）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\start-live-env.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\start-live-env.ps1 -RelayPort 9701 -GatewayPort 18088 -Pair

.NOTES
  执行策略：Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  兼容 Windows PowerShell 5.1（本文件必须带 UTF-8 BOM，否则 5.1 按 ANSI 解析会语法错误）。
  本脚本刻意**不** dot-source scripts\_common.ps1：那套公共库归生产脚本所有、仍在被并行修改，
  夹具脚本自包含可以避免跨改动耦合，也把写范围限制在 scripts\start-live-env.ps1 一个文件里。
#>
[CmdletBinding()]
param(
    [int]$RelayPort = 9700,
    [int]$GatewayPort = 18087,
    [string]$RuntimeDir,
    [string]$RelayHome,
    [string]$GatewayHome,
    [string]$GatewayConfig,
    [string]$MirrorHome,
    [int]$DesktopPort = 19387,
    [string]$RelayDir,
    [string]$GatewayDir,
    [string]$Node,
    [string]$PublicHost = '10.0.2.2',
    [string]$Adb,
    [string]$DeviceSerial = 'emulator-5554',
    [switch]$Pair,
    [switch]$Force,
    [int]$WaitSeconds = 45
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 输出助手（自包含，不复用 _common.ps1）
# ---------------------------------------------------------------------------
function Write-Title { param([string]$Text) Write-Host ''; Write-Host ('=' * 74); Write-Host " $Text"; Write-Host ('=' * 74) }
function Write-Step  { param([string]$Text) Write-Host ''; Write-Host "--- $Text" -ForegroundColor Cyan }
function Write-Kv    { param([string]$Key, [string]$Value) Write-Host ("    {0,-14} {1}" -f $Key, $Value) }
function Write-Ok    { param([string]$Text) Write-Host "    [OK]   $Text" -ForegroundColor Green }
function Write-Warn  { param([string]$Text) Write-Host "    [WARN] $Text" -ForegroundColor Yellow }
function Write-Err   { param([string]$Text) Write-Host "    [ERR]  $Text" -ForegroundColor Red }
function Write-Note  { param([string]$Text) Write-Host "    $Text" -ForegroundColor DarkGray }
$script:Failure = $null

function Fail {
    param([string]$Text, [int]$Code = 1)
    Write-Err $Text
    $script:Failure = [pscustomobject]@{ Message = $Text; Code = $Code }
    throw (New-Object System.Exception($Text))
}

# ---------------------------------------------------------------------------
# 通用助手
# ---------------------------------------------------------------------------
function Test-ProcAlive {
    param([int]$ProcId)
    if ($ProcId -le 0) { return $false }
    try { $null = Get-Process -Id $ProcId -ErrorAction Stop; return $true } catch { return $false }
}

function Get-ProcCommandLine {
    param([int]$ProcId)
    try {
        $p = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId=" + $ProcId) -ErrorAction Stop
        if ($null -ne $p) { return [string]$p.CommandLine }
    } catch { }
    return ''
}

function Get-PortOwner {
    param([int]$Port)
    $conns = @()
    try { $conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop) } catch { $conns = @() }
    if ($conns.Count -gt 0) {
        $owning = [int]$conns[0].OwningProcess
        $pname = '?'
        try { $pname = (Get-Process -Id $owning -ErrorAction Stop).ProcessName } catch { }
        return [pscustomobject]@{ Port = $Port; Pid = $owning; Name = $pname }
    }
    # 回退：老系统没有 Get-NetTCPConnection 时用 netstat 解析 LISTENING
    $netstat = ''
    try { $netstat = (& netstat.exe -ano -p tcp 2>$null | Out-String) } catch { return $null }
    foreach ($line in ($netstat -split "`r?`n")) {
        if ($line -match ('^\s*TCP\s+\S+:' + $Port + '\s+\S+\s+LISTENING\s+(\d+)\s*$')) {
            $owning = [int]$Matches[1]
            $pname = '?'
            try { $pname = (Get-Process -Id $owning -ErrorAction Stop).ProcessName } catch { }
            return [pscustomobject]@{ Port = $Port; Pid = $owning; Name = $pname }
        }
    }
    return $null
}

function Invoke-Api {
    param(
        [string]$Url,
        [string]$Method = 'GET',
        [hashtable]$Headers = $null,
        [string]$Body = $null,
        [int]$TimeoutSec = 15
    )
    $result = [ordered]@{ Ok = $false; Status = 0; Text = ''; Json = $null; Error = '' }
    try {
        $req = [System.Net.WebRequest]::Create($Url)
        $req.Method = $Method
        $req.Timeout = $TimeoutSec * 1000
        $req.ReadWriteTimeout = $TimeoutSec * 1000
        $req.Accept = 'application/json'
        if ($null -ne $Headers) { foreach ($k in $Headers.Keys) { $req.Headers[[string]$k] = [string]$Headers[$k] } }
        if ($Body) {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
            $req.ContentType = 'application/json; charset=utf-8'
            $req.ContentLength = $bytes.Length
            $stream = $req.GetRequestStream()
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Close()
        }
        $resp = $req.GetResponse()
        $result.Status = [int]$resp.StatusCode
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $result.Text = $reader.ReadToEnd()
        $reader.Close(); $resp.Close()
        $result.Ok = $true
    } catch [System.Net.WebException] {
        $we = $_.Exception
        if ($null -ne $we.Response) {
            $result.Status = [int]$we.Response.StatusCode
            try {
                $reader2 = New-Object System.IO.StreamReader($we.Response.GetResponseStream(), [System.Text.Encoding]::UTF8)
                $result.Text = $reader2.ReadToEnd(); $reader2.Close()
            } catch { }
        }
        $result.Error = $we.Message
    } catch {
        $result.Error = $_.Exception.Message
    }
    if ($result.Text -and $result.Text.Trim().Length -gt 0) {
        try { $result.Json = $result.Text | ConvertFrom-Json } catch { }
    }
    return [pscustomobject]$result
}

function Wait-Api {
    param([string]$Url, [int]$Seconds, [hashtable]$Headers = $null, [string]$Expect = '')
    $deadline = (Get-Date).AddSeconds($Seconds)
    $last = $null
    while ((Get-Date) -lt $deadline) {
        $last = Invoke-Api -Url $Url -Headers $Headers -TimeoutSec 5
        if ($last.Ok) {
            if (-not $Expect) { return $last }
            if ($last.Text -like ('*' + $Expect + '*')) { return $last }
        }
        Start-Sleep -Milliseconds 700
    }
    return $last
}

function Quote-NativeArg {
    param([string]$Text)
    if ($Text -match '[\s"]') { return '"' + ($Text -replace '"', '\"') + '"' }
    return $Text
}

function Start-Detached {
    param([string]$FilePath, [string[]]$ArgList, [string]$WorkDir, [string]$OutLog, [string]$ErrLog)
    $quoted = @()
    foreach ($a in $ArgList) { $quoted += (Quote-NativeArg $a) }
    return Start-Process -FilePath $FilePath -ArgumentList $quoted -WorkingDirectory $WorkDir `
        -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -WindowStyle Hidden -PassThru
}

function Save-PidFile {
    param([string]$Path, [hashtable]$Info)
    $json = ($Info | ConvertTo-Json -Compress)
    [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Read-PidFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try {
        $raw = [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false)))
        return ($raw | ConvertFrom-Json)
    } catch { return $null }
}

function Invoke-Native {
    param([string]$FilePath, [string[]]$ArgList, [int]$TimeoutSec = 60)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $FilePath @ArgList 2>&1
        $code = $LASTEXITCODE
        return [pscustomobject]@{ Code = [int]$code; Text = ($out | Out-String) }
    } finally {
        $ErrorActionPreference = $prev
    }
}

# ---------------------------------------------------------------------------
# 模拟器 App 配对（-Pair；本任务实测踩过的三个坑都在这里）
#   坑 1：uiautomator dump **只包含可见节点**；配对页很长（二维码），
#         「填入示例（debug）」/「配对并连接」初始在屏幕外 → 必须先下滚。
#   坑 2：点完「填入示例」会插入「明文 ws:// 风险提示卡」，把「配对并连接」**再次顶出屏幕**
#         → 必须「下滚 → 找控件 → 再下滚」循环，不能只滚一次。
#   坑 3：配对成功后列表首拉要等（实测 4 秒时还是「全部 0」，约 1 分钟后才是真数据）
#         → 校验必须轮询，不能只 sleep 一次。
# ---------------------------------------------------------------------------
function Get-UiDump {
    param([string]$AdbExe, [string]$Serial, [string]$WorkDir)
    $remote = '/sdcard/dsh-liveenv-ui.xml'
    $local = Join-Path $WorkDir 'ui.xml'
    $null = Invoke-Native -FilePath $AdbExe -ArgList @('-s', $Serial, 'shell', 'uiautomator', 'dump', $remote) -TimeoutSec 40
    $null = Invoke-Native -FilePath $AdbExe -ArgList @('-s', $Serial, 'pull', $remote, $local) -TimeoutSec 40
    if (-not (Test-Path -LiteralPath $local -PathType Leaf)) { return $null }
    # 必须显式按 UTF-8 读：PS 5.1 的 Get-Content 会按 ANSI 读，中文关键字全部落空
    $text = [System.IO.File]::ReadAllText($local, (New-Object System.Text.UTF8Encoding($false)))
    try { return [xml]$text } catch { return $null }
}

function Find-NodeCenter {
    param([xml]$Doc, [string]$Pattern, [switch]$DescOnly)
    if ($null -eq $Doc) { return $null }
    foreach ($n in $Doc.SelectNodes('//node')) {
        $t = [string]$n.GetAttribute('text')
        $d = [string]$n.GetAttribute('content-desc')
        $hay = if ($DescOnly) { $d } else { "$t|$d" }
        if ($hay -like ("*" + $Pattern + "*")) {
            $b = [string]$n.GetAttribute('bounds')
            if ($b -match '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') {
                $cx = [int](([int]$Matches[1] + [int]$Matches[3]) / 2)
                $cy = [int](([int]$Matches[2] + [int]$Matches[4]) / 2)
                return @($cx, $cy)
            }
        }
    }
    return $null
}

function Get-UiTexts {
    param([xml]$Doc)
    $list = @()
    if ($null -eq $Doc) { return $list }
    foreach ($n in $Doc.SelectNodes('//node')) {
        $t = [string]$n.GetAttribute('text')
        if ($t) { $list += $t }
    }
    return $list
}

function Tap-ByText {
    param([string]$AdbExe, [string]$Serial, [string]$WorkDir, [string]$Pattern, [int]$Scrolls = 4)
    for ($i = 0; $i -le $Scrolls; $i++) {
        $doc = Get-UiDump -AdbExe $AdbExe -Serial $Serial -WorkDir $WorkDir
        $center = Find-NodeCenter -Doc $doc -Pattern $Pattern
        if ($null -ne $center) {
            $null = Invoke-Native -FilePath $AdbExe -ArgList @('-s', $Serial, 'shell', 'input', 'tap', [string]$center[0], [string]$center[1]) -TimeoutSec 20
            return $true
        }
        $null = Invoke-Native -FilePath $AdbExe -ArgList @('-s', $Serial, 'shell', 'input', 'swipe', '540', '1700', '540', '700', '300') -TimeoutSec 20
        Start-Sleep -Milliseconds 700
    }
    return $false
}

function Invoke-LiveEnvPair {
    param(
        [string]$Adb, [string]$Serial, [int]$GatewayPort, [string]$RelayUrl,
        [string]$Package, [string]$Activity, [string]$GatewayEntry, [string]$Node, [string]$LogDir
    )
    $result = [ordered]@{ Ok = $false; Detail = '' }
    $devicesText = (Invoke-Native -FilePath $Adb -ArgList @('devices') -TimeoutSec 20).Text
    if ($devicesText -notlike ("*" + $Serial + "*")) {
        $result.Detail = ("adb 里没有设备 " + $Serial + "：" + ($devicesText -replace "`r?`n", ' '))
        return [pscustomobject]$result
    }
    $null = Invoke-Native -FilePath $Adb -ArgList @('-s', $Serial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP') -TimeoutSec 20
    $null = Invoke-Native -FilePath $Adb -ArgList @('-s', $Serial, 'shell', 'wm', 'dismiss-keyguard') -TimeoutSec 20
    # 从源头避免系统通知权限弹窗盖住界面
    $null = Invoke-Native -FilePath $Adb -ArgList @('-s', $Serial, 'shell', 'pm', 'grant', $Package, 'android.permission.POST_NOTIFICATIONS') -TimeoutSec 20

    $pairCli = Invoke-Native -FilePath $Node -ArgList @($GatewayEntry, 'pair', '--port', [string]$GatewayPort) -TimeoutSec 30
    $code = ''
    if ($pairCli.Text -match '(\d{6})') { $code = $Matches[1] }
    if (-not $code) { $result.Detail = ('生成配对码失败：' + $pairCli.Text); return [pscustomobject]$result }

    $null = Invoke-Native -FilePath $Adb -ArgList @('-s', $Serial, 'shell', 'am', 'force-stop', $Package) -TimeoutSec 20
    Start-Sleep -Milliseconds 500
    $startArgs = @('-s', $Serial, 'shell', 'am', 'start', '-W', '-n', ($Package + '/' + $Activity),
                   '--es', 'dsh_relay_url', $RelayUrl, '--es', 'dsh_pair_code', $code)
    $null = Invoke-Native -FilePath $Adb -ArgList $startArgs -TimeoutSec 60
    Start-Sleep -Seconds 3
    # 已经配对过（本机常见）：直接判定成功，别去点不存在的按钮
    $preDoc = Get-UiDump -AdbExe $Adb -Serial $Serial -WorkDir $LogDir
    $preText = (Get-UiTexts -Doc $preDoc) -join ' | '
    if ($preText -like '*已连接*' -or $preText -like '*隧道正常*') {
        $result.Ok = $true
        $result.Detail = 'App 本来就连着本中继（已连接），无需重新配对'
        return [pscustomobject]$result
    }

    # 「填入示例（debug）」把 RelayUrl/配对码灌进输入框；pair() 要求 code.length==6
    $filled = Tap-ByText -AdbExe $Adb -Serial $Serial -WorkDir $LogDir -Pattern '填入示例' -Scrolls 4
    if (-not $filled) { $result.Detail = '找不到「填入示例（debug）」按钮（配对页布局变了？）'; return [pscustomobject]$result }
    Start-Sleep -Milliseconds 800
    $paired = Tap-ByText -AdbExe $Adb -Serial $Serial -WorkDir $LogDir -Pattern '配对并连接' -Scrolls 5
    if (-not $paired) { $result.Detail = '找不到「配对并连接」按钮'; return [pscustomobject]$result }

    # 轮询等待连接成立（坑 3：不能只 sleep 一次）
    $deadline = (Get-Date).AddSeconds(40)
    $seen = @()
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        $doc = Get-UiDump -AdbExe $Adb -Serial $Serial -WorkDir $LogDir
        $texts = Get-UiTexts -Doc $doc
        $seen = $texts
        $joined = ($texts -join ' | ')
        if ($joined -like '*已连接*' -or $joined -like '*隧道正常*') {
            $result.Ok = $true
            $shots = Join-Path $repoRoot 'android\evidence\live-env\shots'
            if (Test-Path -LiteralPath $shots -PathType Container) {
                $file = Join-Path $shots '10-paired-by-script.png'
                if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
                $null = Invoke-Native -FilePath 'cmd.exe' -ArgList @('/c', ('"' + $Adb + '" -s ' + $Serial + ' exec-out screencap -p > "' + $file + '"')) -TimeoutSec 60
                $result.Detail = ('已连接（截图 ' + $file + '）')
            } else {
                $result.Detail = '已连接'
            }
            return [pscustomobject]$result
        }
        if ($joined -like '*配对失败*' -or $joined -like '*配对码错误*') { break }
    }
    $result.Detail = ('40 秒内没看到「已连接」；当前可见文本：' + (($seen | Select-Object -First 12) -join ' / '))
    return [pscustomobject]$result
}

# ---------------------------------------------------------------------------
# 0. 解析路径
# ---------------------------------------------------------------------------
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $RuntimeDir)   { $RuntimeDir = Join-Path $repoRoot '.runtime\live-env' }
if (-not $RelayHome)    { $RelayHome = Join-Path $RuntimeDir 'relay-home' }
if (-not $GatewayHome)  { $GatewayHome = Join-Path $RuntimeDir 'home' }
if (-not $GatewayConfig){ $GatewayConfig = Join-Path $RuntimeDir 'config.json' }
if (-not $RelayDir)     { $RelayDir = Join-Path $repoRoot 'tools\dsh-relay' }
if (-not $GatewayDir)   { $GatewayDir = Join-Path $repoRoot 'tools\dsh-remote' }
if (-not $MirrorHome)   { $MirrorHome = Join-Path $env:USERPROFILE '.dsh' }
$logDir = Join-Path $RuntimeDir 'logs'

Write-Title '活动环境（live-env）启动 —— 本机回环中继 + 新代码网关'
Write-Kv '仓库根'   $repoRoot
Write-Kv '运行根'   $RuntimeDir
Write-Kv '中继目录' $RelayHome
Write-Kv '网关 home' $GatewayHome
Write-Kv '网关配置' $GatewayConfig
Write-Kv '镜像 home' $MirrorHome
Write-Kv '桌面端'   ("127.0.0.1:" + $DesktopPort)

try {
    # -----------------------------------------------------------------------
    # 1. 前置检查
    # -----------------------------------------------------------------------
    Write-Step '1/6 前置检查'
    foreach ($d in @($RuntimeDir, $RelayHome, $GatewayHome, $logDir)) {
        if (-not (Test-Path -LiteralPath $d -PathType Container)) { $null = New-Item -ItemType Directory -Path $d -Force }
    }
    $relayEntry   = Join-Path $RelayDir 'relay.mjs'
    $gatewayEntry = Join-Path $GatewayDir 'gateway.mjs'
    if (-not (Test-Path -LiteralPath $relayEntry -PathType Leaf))   { Fail ("找不到中继入口：" + $relayEntry) 2 }
    if (-not (Test-Path -LiteralPath $gatewayEntry -PathType Leaf)) { Fail ("找不到网关入口：" + $gatewayEntry) 2 }
    if (-not $Node) {
        $candidates = @(
            (Join-Path $repoRoot 'node_modules\.bin\node.exe'),
            'D:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
        )
        foreach ($c in $candidates) { if (Test-Path -LiteralPath $c -PathType Leaf) { $Node = $c; break } }
    }
    if (-not $Node) { $cmd = Get-Command node -ErrorAction SilentlyContinue; if ($null -ne $cmd) { $Node = $cmd.Source } }
    if (-not $Node -or -not (Test-Path -LiteralPath $Node -PathType Leaf)) { Fail '找不到 node.exe，请用 -Node 指定' 2 }
    Write-Ok  ("node      " + $Node)
    Write-Ok  ("中继入口  " + $relayEntry)
    Write-Ok  ("网关入口  " + $gatewayEntry)

    $desktopProbe = Invoke-Api -Url ("http://127.0.0.1:" + $DesktopPort + "/") -TimeoutSec 4
    if ($desktopProbe.Status -gt 0) { Write-Ok ("桌面端运行时 127.0.0.1:" + $DesktopPort + " 可达（电脑会话镜像有数据源）HTTP " + $desktopProbe.Status) }
    else { Write-Warn ("桌面端运行时 127.0.0.1:" + $DesktopPort + " 不可达：" + $desktopProbe.Error + " → 手机能连上，但「电脑会话」列表会是空的") }

    # -----------------------------------------------------------------------
    # 2. 中继
    # -----------------------------------------------------------------------
    Write-Step '2/6 中继（tools/dsh-relay）'
    $relayConfigPath = Join-Path $RelayHome 'config.json'
    $relaySecret = ''
    $effectiveRelayPort = $RelayPort
    $relayNeedsInit = $true
    if (Test-Path -LiteralPath $relayConfigPath -PathType Leaf) {
        $existing = $null
        try {
            $existing = [System.IO.File]::ReadAllText($relayConfigPath, (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json
        } catch { $existing = $null }
        if ($null -ne $existing) {
            $relayNeedsInit = $false
            $relaySecret = [string]$existing.relaySecret
            if ($existing.port) { $effectiveRelayPort = [int]$existing.port }
            if ($RelayPort -ne $effectiveRelayPort) {
                if (-not $Force) {
                    Write-Warn ("请求端口 " + $RelayPort + " 与现有中继配置端口 " + $effectiveRelayPort + " 不一致：沿用现有端口（重新 init 会换 relaySecret，已配对的 App 会失效）。要换端口请加 -Force 并重新配对 App。")
                } else {
                    $relayNeedsInit = $true
                    Write-Warn ("-Force：按端口 " + $RelayPort + " 重新 init 中继配置，relaySecret 会变，App 必须重新配对。")
                }
            }
        }
    }
    if ($relayNeedsInit) {
        $initArgs = @($relayEntry, 'init', '--home', $RelayHome, '--host', '127.0.0.1', '--port', [string]$RelayPort,
                      '--relay-name', 'live-relay', '--tls-mode', 'off', '--public-url', ("ws://" + $PublicHost + ":" + $RelayPort), '--force')
        $init = Invoke-Native -FilePath $Node -ArgList $initArgs -TimeoutSec 60
        if ($init.Code -ne 0) { Fail ("中继 init 失败（exit " + $init.Code + "）：" + $init.Text) 4 }
        Write-Ok '中继配置已生成（relaySecret 写入中继 home）'
        $effectiveRelayPort = $RelayPort
        $relayCfg2 = [System.IO.File]::ReadAllText($relayConfigPath, (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json
        $relaySecret = [string]$relayCfg2.relaySecret
    }
    Write-Kv '端口' ("127.0.0.1:" + $effectiveRelayPort)
    Write-Kv 'relaySecret' ($relaySecret.Substring(0, 6) + '…（已隐藏）')

    $relayPidPath = Join-Path $RuntimeDir 'relay.pid'
    $relayBaseUrl = "http://127.0.0.1:$effectiveRelayPort"
    $relayPidInfo = Read-PidFile -Path $relayPidPath
    $relayAlreadyUp = $false
    if ($null -ne $relayPidInfo -and (Test-ProcAlive -ProcId ([int]$relayPidInfo.pid))) {
        $probe = Invoke-Api -Url ($relayBaseUrl + '/health') -TimeoutSec 5
        if ($probe.Ok) { $relayAlreadyUp = $true }
    }
    if (-not $relayAlreadyUp) {
        $owner = Get-PortOwner -Port $effectiveRelayPort
        if ($null -ne $owner) {
            $cmdline = Get-ProcCommandLine -ProcId $owner.Pid
            if ($cmdline -like ('*' + $RelayHome + '*')) {
                Write-Warn ("端口 " + $effectiveRelayPort + " 上已有本夹具的中继（PID " + $owner.Pid + "，没有 PID 文件）→ 复用它")
                Save-PidFile -Path $relayPidPath -Info @{ pid = $owner.Pid; port = $effectiveRelayPort; home = $RelayHome; entry = $relayEntry; startedAt = (Get-Date).ToString('o'); adopted = $true }
                $relayAlreadyUp = $true
                $relayPidInfo = Read-PidFile -Path $relayPidPath
            } else {
                Fail ("端口 " + $effectiveRelayPort + " 被别的进程占用：PID " + $owner.Pid + " (" + $owner.Name + ")。换端口用 -RelayPort，或先结束它。") 3
            }
        }
    }
    if ($relayAlreadyUp) {
        Write-Ok ("中继已在运行，跳过启动（PID " + [int]$relayPidInfo.pid + "）")
    } else {
        $proc = Start-Detached -FilePath $Node -ArgList @($relayEntry, 'serve', '--home', $RelayHome, '--host', '127.0.0.1', '--port', [string]$effectiveRelayPort) `
            -WorkDir $RelayDir -OutLog (Join-Path $logDir 'relay.out.log') -ErrLog (Join-Path $logDir 'relay.err.log')
        Start-Sleep -Milliseconds 800
        if (-not (Test-ProcAlive -ProcId $proc.Id)) {
            Fail ("中继进程立刻退出（PID " + $proc.Id + "），看日志：" + (Join-Path $logDir 'relay.err.log')) 4
        }
        Save-PidFile -Path $relayPidPath -Info @{ pid = $proc.Id; port = $effectiveRelayPort; home = $RelayHome; entry = $relayEntry; startedAt = (Get-Date).ToString('o'); adopted = $false }
        Write-Kv 'PID' ([string]$proc.Id)
    }
    $relayHealth = Wait-Api -Url ($relayBaseUrl + '/health') -Seconds $WaitSeconds -Expect '"ok":true'
    if ($null -eq $relayHealth -or -not $relayHealth.Ok) {
        Fail ("中继 /health 未就绪：" + $(if ($null -ne $relayHealth) { $relayHealth.Error } else { 'timeout' }) + "；日志 " + (Join-Path $logDir 'relay.err.log')) 4
    }
    Write-Ok ("中继 /health OK：" + ($relayHealth.Text.Trim()))

    # -----------------------------------------------------------------------
    # 3. 网关配置（每次按参数刷新）
    # -----------------------------------------------------------------------
    Write-Step '3/6 网关配置（每次刷新，值全部由参数推导）'
    $gatewayCfg = [ordered]@{
        _readme = @(
            '活动环境（live-env）网关配置：本机回环中继 + 本机网关，不经公网。',
            '由 scripts/start-live-env.ps1 生成/覆盖，手工改动会在下次启动时被覆盖。',
            '本文件不含任何密钥：API Key 只放在同目录的 .credentials.yaml。',
            'mirror/desktop 指向真实桌面端 home，手机端「电脑会话」才不是离线快照。'
        )
        host = '127.0.0.1'
        port = $GatewayPort
        dshHome = $GatewayHome
        serverName = 'live-env-gateway'
        gatewayVersion = '2.9.0'
        authRequired = $true
        maxConcurrent = 2
        maxQueue = 100
        defaultTimeoutSec = 3600
        maxTimeoutSec = 86400
        workspaceAllowlist = @('D:\Workspace\插件', 'D:\Workspace\dsh_android', 'D:\Workspace\论文', 'D:\Workspace\canpy', (Join-Path $env:USERPROFILE 'dsh-workspace'))
        defaultWorkspace = (Join-Path $env:USERPROFILE 'dsh-workspace')
        dsh = [ordered]@{
            node = $Node
            binPath = (Join-Path $env:USERPROFILE '.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js')
            profile = 'headless'
            discoverSessionId = $true
            launcherArgs = @()
        }
        mirror = [ordered]@{
            _readme = @(
                '只读镜像真实桌面端 home（%USERPROFILE%\.dsh），手机端「电脑会话」列表就来自这里。',
                '网关自身运行时 home 是 .runtime\live-env\home，与镜像严格分离。'
            )
            enabled = $true
            dshHome = $MirrorHome
            liveWindowMs = 60000
            onlyAllowlistedWorkspaces = $false
            listLimit = 50
            listLimitMax = 200
            includeSubagentsByDefault = $false
        }
        desktop = [ordered]@{
            _readme = @(
                '电脑端 Web 运行时（默认 127.0.0.1:19387）：实时会话详情 + 审批闭环。',
                '凭据读 %USERPROFILE%\.dsh\.credentials.yaml 的 client-connection/browser-session。'
            )
            enabled = $true
            host = '127.0.0.1'
            port = $DesktopPort
            dshHome = $MirrorHome
        }
        relay = [ordered]@{
            _readme = @(
                '本机回环中继：relay host 必须是回环地址，否则网关拒绝启动（安全红线）。',
                ('Android 模拟器用 ' + $PublicHost + ' 访问宿主回环，因此 App 侧中继地址是 ws://' + $PublicHost + ':' + $effectiveRelayPort + '。')
            )
            enabled = $true
            url = ("ws://127.0.0.1:" + $effectiveRelayPort)
            homeName = '活动环境台式机'
            relaySecret = $relaySecret
            gatewayVersion = '2.9.0'
            maxStreams = 64
            requestTimeoutMs = 60000
            maxFrameBytes = 8388608
            reconnect = [ordered]@{ minMs = 1000; maxMs = 30000; factor = 2; jitter = 0.2 }
            tls = [ordered]@{ rejectUnauthorized = $true; ca = $null }
            pairWindow = [ordered]@{ attempts = 5 }
            allowNonLoopback = $false
        }
        tasks = [ordered]@{ dirName = 'tasks' }
        log = [ordered]@{ dirName = 'logs'; filePrefix = 'gateway'; toConsole = $true }
        limits = [ordered]@{
            maxBodyBytes = 1048576; maxOutputBytes = 1048576; pairClaimPerMinute = 10; authFailPerMinute = 30
            pairCodeTtlMs = 300000; maxSseClients = 16; requestTimeoutMs = 30000; headersTimeoutMs = 20000
            outputFlushMs = 200; outputFlushBytes = 8192
        }
        events = [ordered]@{ bufferSize = 2000; heartbeatMs = 15000 }
    }
    $cfgJson = ($gatewayCfg | ConvertTo-Json -Depth 8)
    [System.IO.File]::WriteAllText($GatewayConfig, $cfgJson, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok ("已写入 " + $GatewayConfig)
    Write-Note ("mirror.dshHome = " + $MirrorHome + "（只读镜像，电脑会话来源）")
    Write-Note ("relay.url       = ws://127.0.0.1:" + $effectiveRelayPort + "（回环，网关强制校验）")

    # -----------------------------------------------------------------------
    # 4. 网关
    # -----------------------------------------------------------------------
    Write-Step '4/6 网关（tools/dsh-remote，跑工作区里的新代码）'
    $gatewayPidPath = Join-Path $RuntimeDir 'gateway.pid'
    $gatewayBase = "http://127.0.0.1:$GatewayPort"
    $gatewayPidInfo = Read-PidFile -Path $gatewayPidPath
    $gatewayAlreadyUp = $false
    if ($null -ne $gatewayPidInfo -and (Test-ProcAlive -ProcId ([int]$gatewayPidInfo.pid))) {
        $probe = Invoke-Api -Url ($gatewayBase + '/api/v1/health') -TimeoutSec 5
        if ($probe.Ok -and $probe.Text -like '*live-env-gateway*') { $gatewayAlreadyUp = $true }
    }
    if (-not $gatewayAlreadyUp) {
        $owner = Get-PortOwner -Port $GatewayPort
        if ($null -ne $owner) {
            $cmdline = Get-ProcCommandLine -ProcId $owner.Pid
            if ($cmdline -like ('*' + $GatewayConfig + '*') -or $cmdline -like ('*' + $RuntimeDir + '*')) {
                Write-Warn ("端口 " + $GatewayPort + " 上已有本夹具的网关（PID " + $owner.Pid + "，没有 PID 文件）→ 复用它")
                Save-PidFile -Path $gatewayPidPath -Info @{ pid = $owner.Pid; port = $GatewayPort; home = $GatewayHome; config = $GatewayConfig; entry = $gatewayEntry; startedAt = (Get-Date).ToString('o'); adopted = $true }
                $gatewayAlreadyUp = $true
                $gatewayPidInfo = Read-PidFile -Path $gatewayPidPath
            } else {
                Fail ("端口 " + $GatewayPort + " 被别的进程占用：PID " + $owner.Pid + " (" + $owner.Name + ")。换端口用 -GatewayPort。") 3
            }
        }
    }
    if ($gatewayAlreadyUp) {
        Write-Warn ("网关已在运行（PID " + [int]$gatewayPidInfo.pid + "）：配置刚被重写，端口/home 未变时不需重启；若刚改了配置请先跑 stop-live-env.ps1")
    } else {
        $proc = Start-Detached -FilePath $Node -ArgList @($gatewayEntry, 'serve', '--config', $GatewayConfig, '--home', $GatewayHome) `
            -WorkDir $GatewayDir -OutLog (Join-Path $logDir 'gateway.out.log') -ErrLog (Join-Path $logDir 'gateway.err.log')
        Start-Sleep -Milliseconds 800
        if (-not (Test-ProcAlive -ProcId $proc.Id)) {
            Fail ("网关进程立刻退出（PID " + $proc.Id + "），看日志：" + (Join-Path $logDir 'gateway.err.log')) 4
        }
        Save-PidFile -Path $gatewayPidPath -Info @{ pid = $proc.Id; port = $GatewayPort; home = $GatewayHome; config = $GatewayConfig; entry = $gatewayEntry; startedAt = (Get-Date).ToString('o'); adopted = $false }
        Write-Kv 'PID' ([string]$proc.Id)
    }
    $gwHealth = Wait-Api -Url ($gatewayBase + '/api/v1/health') -Seconds $WaitSeconds -Expect '"ok":true'
    if ($null -eq $gwHealth -or -not $gwHealth.Ok) {
        Fail ("网关 /api/v1/health 未就绪；日志 " + (Join-Path $logDir 'gateway.err.log')) 4
    }
    Write-Ok ("网关 /api/v1/health OK（" + $gwHealth.Json.serverName + " / gatewayVersion " + $gwHealth.Json.gatewayVersion + " / dsh " + $gwHealth.Json.dshVersion + "）")

    # -----------------------------------------------------------------------
    # 5. 校验 + 设备令牌（给 teammates 做无头 API 验证用）
    # -----------------------------------------------------------------------
    Write-Step '5/6 校验（中继隧道 / 镜像 / 审批桥 / 设备令牌）'
    $tokenPath = Join-Path $logDir 'headless-device-token.txt'
    $token = ''
    if (Test-Path -LiteralPath $tokenPath -PathType Leaf) {
        $token = ([System.IO.File]::ReadAllText($tokenPath, (New-Object System.Text.UTF8Encoding($false)))).Trim()
    }
    $authed = $false
    if ($token) {
        $probe = Invoke-Api -Url ($gatewayBase + '/api/v2/sessions?limit=1') -Headers @{ Authorization = ('Bearer ' + $token) } -TimeoutSec 10
        if ($probe.Ok) { $authed = $true; Write-Ok '已存的无头设备令牌仍然有效（不重复配对，devices.json 不膨胀）' }
    }
    if (-not $authed) {
        $pairCli = Invoke-Native -FilePath $Node -ArgList @($gatewayEntry, 'pair', '--port', [string]$GatewayPort) -TimeoutSec 30
        $code = ''
        if ($pairCli.Text -match '(\d{6})') { $code = $Matches[1] }
        if (-not $code) { Write-Warn ('无法生成配对码，跳过令牌获取：' + $pairCli.Text) }
        else {
            $body = (@{ code = $code; deviceName = 'live-env-headless'; deviceId = '11111111-2222-4333-8444-555566667777' } | ConvertTo-Json -Compress)
            $claim = Invoke-Api -Url ($gatewayBase + '/api/v2/pair/claim') -Method 'POST' -Body $body -TimeoutSec 15
            if ($claim.Ok -and $claim.Json.token) {
                $token = [string]$claim.Json.token
                [System.IO.File]::WriteAllText($tokenPath, $token, (New-Object System.Text.UTF8Encoding($false)))
                Write-Ok ("已用配对码换到无头设备令牌并落盘：" + $tokenPath)
            } else { Write-Warn ("无头配对失败：" + $claim.Status + " " + $claim.Text) }
        }
    }
    $authHeaders = @{}
    if ($token) { $authHeaders = @{ Authorization = ('Bearer ' + $token) } }

    $relayStatus = $null; $approvals = $null; $sessions = $null; $health2 = $null
    if ($token) {
        $relayStatus = Wait-Api -Url ($gatewayBase + '/api/v2/relay/status') -Seconds 30 -Headers $authHeaders -Expect '"connected":true'
        if ($null -ne $relayStatus -and $relayStatus.Ok -and $relayStatus.Text -like '*"connected":true*') {
            Write-Ok ("中继隧道已连上：homeId=" + $relayStatus.Json.homeId + " relayName=" + $relayStatus.Json.relayName)
        } else {
            Write-Warn ("中继隧道未连上：" + $(if ($null -ne $relayStatus) { $relayStatus.Text } else { 'timeout' }))
        }
        $health2 = Invoke-Api -Url ($gatewayBase + '/api/v2/health') -Headers $authHeaders -TimeoutSec 10
        if ($health2.Ok) {
            foreach ($root in $health2.Json.sessionMirror.roots) {
                Write-Note ("镜像源 " + $root.source + " → " + $root.home + "（writable=" + $root.writable + "）")
            }
        }
        $approvals = Invoke-Api -Url ($gatewayBase + '/api/v2/approvals') -Headers $authHeaders -TimeoutSec 10
        if ($approvals.Ok) {
            if ($approvals.Json.state.connected) { Write-Ok ("审批桥已连上桌面端事件流（connected=true，available=" + $approvals.Json.state.available + "）") }
            else { Write-Warn ("审批桥未连上：" + $approvals.Text) }
        }
        $sessions = Invoke-Api -Url ($gatewayBase + '/api/v2/sessions?limit=200') -Headers $authHeaders -TimeoutSec 20
        if ($sessions.Ok) {
            $count = @($sessions.Json.sessions).Count
            $live  = @($sessions.Json.sessions | Where-Object { $null -ne $_.PSObject.Properties['live'] -and $_.live }).Count
            Write-Ok ("电脑端会话（只读镜像）：" + $count + " 条，其中 live=" + $live)
            if ($count -eq 0) { Write-Warn '会话数为 0：确认桌面端 runtime 在跑、mirror.dshHome 指向的是真实 home' }
        }
    }

    # -----------------------------------------------------------------------
    # 6. 状态文件 + App 配对（可选）
    # -----------------------------------------------------------------------
    Write-Step '6/6 收尾'
    $statePath = Join-Path $RuntimeDir 'live-env.json'
    $state = [ordered]@{
        generatedAt   = (Get-Date).ToString('o')
        repoRoot      = $repoRoot
        relayPort     = $effectiveRelayPort
        relayBaseUrl  = $relayBaseUrl
        relayHome     = $RelayHome
        relayPid      = if ($null -ne $relayPidInfo) { [int]$relayPidInfo.pid } else { 0 }
        gatewayPort   = $GatewayPort
        gatewayBaseUrl = $gatewayBase
        gatewayHome   = $GatewayHome
        gatewayConfig = $GatewayConfig
        gatewayPid    = if ($null -ne $gatewayPidInfo) { [int]$gatewayPidInfo.pid } else { 0 }
        mirrorHome    = $MirrorHome
        desktopPort   = $DesktopPort
        androidRelayUrl = ("ws://" + $PublicHost + ":" + $effectiveRelayPort)
        deviceTokenFile = $tokenPath
        homeId        = if ($null -ne $relayStatus -and $relayStatus.Ok) { [string]$relayStatus.Json.homeId } else { '' }
        sessionCount  = if ($null -ne $sessions -and $sessions.Ok) { @($sessions.Json.sessions).Count } else { -1 }
        approvalsConnected = if ($null -ne $approvals -and $approvals.Ok) { [bool]$approvals.Json.state.connected } else { $false }
        logDir        = $logDir
    }
    Save-PidFile -Path $statePath -Info $state
    Write-Ok ("状态文件：" + $statePath)

    if ($Pair) {
        if (-not $Adb) {
            $adbCandidates = @()
            if ($env:ANDROID_HOME) { $adbCandidates += (Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe') }
            $adbCandidates += (Join-Path $repoRoot '.toolchain\android-dev\sdk\platform-tools\adb.exe')
            foreach ($c in $adbCandidates) { if (Test-Path -LiteralPath $c -PathType Leaf) { $Adb = $c; break } }
        }
        if (-not $Adb) { $cmd = Get-Command adb -ErrorAction SilentlyContinue; if ($null -ne $cmd) { $Adb = $cmd.Source } }
        if (-not $Adb -or -not (Test-Path -LiteralPath $Adb -PathType Leaf)) {
            Write-Warn '加了 -Pair 但找不到 adb.exe（用 -Adb 指定），跳过配对；App 侧手工配对命令见下方'
        } else {
            Write-Kv 'adb' $Adb
            $pairResult = Invoke-LiveEnvPair -Adb $Adb -Serial $DeviceSerial -GatewayPort $GatewayPort `
                -RelayUrl ("ws://" + $PublicHost + ":" + $effectiveRelayPort) -Package 'com.deepseek.dshremote.debug' `
                -Activity 'com.deepseek.dshremote.MainActivity' -GatewayEntry $gatewayEntry -Node $Node -LogDir $logDir
            if ($pairResult.Ok) { Write-Ok ("App 已配对：" + $pairResult.Detail) }
            else { Write-Warn ("App 配对未确认成功：" + $pairResult.Detail) }
        }
    }

    Write-Host ''
    Write-Host '  ── 下一步 ────────────────────────────────────────────────'
    Write-Note ("App 中继地址（模拟器）：ws://" + $PublicHost + ":" + $effectiveRelayPort)
    Write-Note ('手工配对：powershell -File scripts\pair.ps1  （或 start-live-env.ps1 -Pair 自动完成）')
    Write-Note ('无头验证模板：')
    Write-Note ('  $t = Get-Content .runtime\live-env\logs\headless-device-token.txt -Raw')
    Write-Note ('  Invoke-RestMethod http://127.0.0.1:' + $GatewayPort + '/api/v2/sessions?limit=5 -Headers @{Authorization="Bearer $t"}')
    Write-Note ('  Invoke-RestMethod http://127.0.0.1:' + $GatewayPort + '/api/v2/approvals -Headers @{Authorization="Bearer $t"}')
    Write-Note ('停止：powershell -File scripts\stop-live-env.ps1')
    Write-Host ''
    Write-Host ' live-env 就绪。' -ForegroundColor Green
    exit 0
} catch {
    if ($null -ne $script:Failure) {
        Write-Host ''
        Write-Host (" 启动失败：" + $script:Failure.Message) -ForegroundColor Red
        exit $script:Failure.Code
    }
    Write-Host ''
    Write-Host (" 未预期异常：" + $_.Exception.Message) -ForegroundColor Red
    Write-Host ($_.ScriptStackTrace) -ForegroundColor DarkGray
    exit 1
}
