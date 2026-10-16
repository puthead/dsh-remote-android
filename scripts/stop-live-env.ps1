#Requires -Version 5.1
<#
.SYNOPSIS
  停止「活动环境（live-env）」：只结束本夹具的中继/网关进程，幂等、按证据识别、绝不误杀生产实例。

.DESCRIPTION
  识别目标的两条独立路径（合并去重）：
    1. PID 文件：<RuntimeDir>\relay.pid、<RuntimeDir>\gateway.pid（start-live-env.ps1 写的）。
    2. 命令行扫描：node 进程中命令行同时包含 <RuntimeDir> 与 relay.mjs/gateway.mjs 的（覆盖手工启动、没写 PID 文件的实例）。

  安全护栏（硬约束：不能碰生产网关 PID 396 / 公网中继）：
    * 命令行里出现 `.dsh-remote\config.json`（生产网关配置）或端口 8787/9443 的进程 → **一律拒绝**。
    * 命令行不含 <RuntimeDir> 的进程 → 默认拒绝，只有显式 -Force 才结束。
    * 不碰 127.0.0.1:19387（真实桌面端运行时）、不碰 emulator 进程、不删中继/网关的 home（配对信息保留）。
    * 结束时按进程树 taskkill /T /F，再轮询确认端口已释放。

  退出码：0=已停止或本来就没跑；1=未预期异常；2=参数非法；4=拒绝结束（有非本夹具的进程占用端口）。

.PARAMETER RelayPort
  本机回环中继端口，默认 9700（仅用于结束后的端口释放校验）。

.PARAMETER GatewayPort
  网关 HTTP 端口，默认 18087（同上）。

.PARAMETER Force
  命令行证据不匹配时也强制结束（慎用；生产进程仍然拒绝）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\stop-live-env.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\stop-live-env.ps1 -RelayPort 9701 -GatewayPort 18088

.NOTES
  执行策略：Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  兼容 Windows PowerShell 5.1（本文件必须带 UTF-8 BOM）。
#>
[CmdletBinding()]
param(
    [int]$RelayPort = 9700,
    [int]$GatewayPort = 18087,
    [string]$RuntimeDir,
    [string]$RelayHome,
    [string]$GatewayHome,
    [switch]$Force,
    [int]$WaitSeconds = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Title { param([string]$Text) Write-Host ''; Write-Host ('=' * 74); Write-Host " $Text"; Write-Host ('=' * 74) }
function Write-Step  { param([string]$Text) Write-Host ''; Write-Host "--- $Text" -ForegroundColor Cyan }
function Write-Kv    { param([string]$Key, [string]$Value) Write-Host ("    {0,-14} {1}" -f $Key, $Value) }
function Write-Ok    { param([string]$Text) Write-Host "    [OK]   $Text" -ForegroundColor Green }
function Write-Warn  { param([string]$Text) Write-Host "    [WARN] $Text" -ForegroundColor Yellow }
function Write-Err   { param([string]$Text) Write-Host "    [ERR]  $Text" -ForegroundColor Red }
function Write-Note  { param([string]$Text) Write-Host "    $Text" -ForegroundColor DarkGray }
$script:Refused = $false

function Test-ProcAlive {
    param([int]$ProcId)
    if ($ProcId -le 0) { return $false }
    try { $null = Get-Process -Id $ProcId -ErrorAction Stop; return $true } catch { return $false }
}

function Get-ProcInfo {
    param([int]$ProcId)
    try {
        $p = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId=" + $ProcId) -ErrorAction Stop
        if ($null -ne $p) { return [pscustomobject]@{ Pid = [int]$p.ProcessId; Name = [string]$p.Name; CommandLine = [string]$p.CommandLine } }
    } catch { }
    return $null
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
        return [pscustomobject]@{ Code = [int]$LASTEXITCODE; Text = ($out | Out-String) }
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Wait-ProcGone {
    param([int]$ProcId, [int]$Seconds)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-ProcAlive -ProcId $ProcId)) { return $true }
        Start-Sleep -Milliseconds 400
    }
    return (-not (Test-ProcAlive -ProcId $ProcId))
}

function Wait-PortFree {
    param([int]$Port, [int]$Seconds)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if ($null -eq (Get-PortOwner -Port $Port)) { return $true }
        Start-Sleep -Milliseconds 400
    }
    return ($null -eq (Get-PortOwner -Port $Port))
}

# ---------------------------------------------------------------------------
# 解析路径
# ---------------------------------------------------------------------------
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $RuntimeDir)  { $RuntimeDir = Join-Path $repoRoot '.runtime\live-env' }
if (-not $RelayHome)   { $RelayHome = Join-Path $RuntimeDir 'relay-home' }
if (-not $GatewayHome) { $GatewayHome = Join-Path $RuntimeDir 'home' }
$logDir = Join-Path $RuntimeDir 'logs'
$relayPidPath = Join-Path $RuntimeDir 'relay.pid'
$gatewayPidPath = Join-Path $RuntimeDir 'gateway.pid'

Write-Title '活动环境（live-env）停止 —— 只结束本夹具的中继/网关'
Write-Kv '运行根' $RuntimeDir
Write-Kv '中继端口' ([string]$RelayPort)
Write-Kv '网关端口' ([string]$GatewayPort)

try {
    # -----------------------------------------------------------------------
    # 1. 收集目标
    # -----------------------------------------------------------------------
    Write-Step '1/4 收集目标进程'
    $targets = @{}
    foreach ($item in @(
            @{ File = $relayPidPath;   Kind = 'relay';   Port = $RelayPort },
            @{ File = $gatewayPidPath; Kind = 'gateway'; Port = $GatewayPort })) {
        $info = Read-PidFile -Path $item.File
        if ($null -eq $info) { Write-Note ($item.Kind + '：没有 PID 文件（' + $item.File + '）'); continue }
        $procId = [int]$info.pid
        if (-not (Test-ProcAlive -ProcId $procId)) {
            Write-Note ($item.Kind + "：PID " + $procId + " 已不在（陈旧 PID 文件）")
            continue
        }
        $targets[$procId] = [pscustomobject]@{ Pid = $procId; Kind = $item.Kind; Source = 'pidfile'; Info = (Get-ProcInfo -ProcId $procId) }
    }
    # 命令行扫描：覆盖手工启动、没写 PID 文件的实例
    try {
        $nodeProcs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)
    } catch { $nodeProcs = @() }
    foreach ($p in $nodeProcs) {
        $cmd = [string]$p.CommandLine
        if (-not $cmd) { continue }
        if ($cmd -notlike ('*' + $RuntimeDir + '*')) { continue }
        if ($cmd -notlike '*relay.mjs*' -and $cmd -notlike '*gateway.mjs*') { continue }
        $procId = [int]$p.ProcessId
        if (-not $targets.ContainsKey($procId)) {
            $kind = if ($cmd -like '*relay.mjs*') { 'relay' } else { 'gateway' }
            $targets[$procId] = [pscustomobject]@{ Pid = $procId; Kind = $kind; Source = 'cmdline'; Info = (Get-ProcInfo -ProcId $procId) }
        }
    }
    if ($targets.Count -eq 0) {
        Write-Ok '没有发现本夹具的中继/网关进程（幂等：本来就没跑）'
    } else {
        foreach ($k in ($targets.Keys | Sort-Object)) {
            $t = $targets[$k]
            Write-Kv ($t.Kind + ' PID') ([string]$t.Pid + '（来源 ' + $t.Source + '）')
            if ($null -ne $t.Info) { Write-Note ('    ' + $t.Info.CommandLine) }
        }
    }

    # -----------------------------------------------------------------------
    # 2. 安全判定
    # -----------------------------------------------------------------------
    Write-Step '2/4 安全判定（生产实例一律拒绝）'
    $approved = @()
    foreach ($k in ($targets.Keys | Sort-Object)) {
        $t = $targets[$k]
        $cmd = ''
        if ($null -ne $t.Info) { $cmd = [string]$t.Info.CommandLine }
        $isProduction = ($cmd -like '*.dsh-remote\config.json*') -or ($cmd -like '*:8787*' -and $cmd -like '*gateway.mjs*') -or ($cmd -like '*:9443*' -and $cmd -like '*relay.mjs*')
        if ($isProduction) {
            Write-Err ("PID " + $t.Pid + " 看起来是**生产实例**（命令行含 .dsh-remote\config.json 或生产端口），拒绝结束。")
            $script:Refused = $true
            continue
        }
        $isOurs = ($cmd -like ('*' + $RuntimeDir + '*'))
        if ($isOurs -or $Force) {
            if (-not $isOurs) { Write-Warn ("PID " + $t.Pid + " 命令行不含 " + $RuntimeDir + "，但指定了 -Force → 仍结束。") }
            $approved += $t
        } else {
            Write-Err ("PID " + $t.Pid + " 的命令行不含本夹具运行根，拒绝结束（要强制请加 -Force）。")
            $script:Refused = $true
        }
    }
    Write-Note '不碰：生产网关 PID 396 / 公网中继 9443 / 真实桌面端运行时 127.0.0.1:19387 / emulator 进程'

    # -----------------------------------------------------------------------
    # 3. 结束进程
    # -----------------------------------------------------------------------
    Write-Step '3/4 结束进程（taskkill /T /F）'
    if ($approved.Count -eq 0 -and $targets.Count -gt 0) { Write-Warn '没有可结束的目标（全被安全判定拦下）' }
    foreach ($t in $approved) {
        $kill = Invoke-Native -FilePath 'taskkill.exe' -ArgList @('/PID', [string]$t.Pid, '/T', '/F') -TimeoutSec 30
        $text = ($kill.Text -replace "`r?`n", ' ').Trim()
        # 128 = 进程已经不存在（并发退出），视为成功
        if ($kill.Code -eq 0 -or $kill.Code -eq 128) { Write-Ok ("已结束 " + $t.Kind + " PID " + $t.Pid) }
        else { Write-Warn ("taskkill 退出码 " + $kill.Code + "：" + $text) }
        $null = Wait-ProcGone -ProcId $t.Pid -Seconds $WaitSeconds
    }

    # -----------------------------------------------------------------------
    # 4. 收尾校验
    # -----------------------------------------------------------------------
    Write-Step '4/4 收尾校验'
    foreach ($item in @(
            @{ File = $relayPidPath;   Kind = '中继'; Port = $RelayPort },
            @{ File = $gatewayPidPath; Kind = '网关'; Port = $GatewayPort })) {
        $free = Wait-PortFree -Port $item.Port -Seconds $WaitSeconds
        $owner = Get-PortOwner -Port $item.Port
        if ($free) { Write-Ok ($item.Kind + " 端口 " + $item.Port + " 已释放") }
        else {
            Write-Warn ($item.Kind + " 端口 " + $item.Port + " 仍被占用")
            if ($null -ne $owner) {
                $info = Get-ProcInfo -ProcId $owner.Pid
                Write-Note ("    占用者 PID " + $owner.Pid + " (" + $owner.Name + ")")
                if ($null -ne $info) { Write-Note ('    ' + $info.CommandLine) }
            }
        }
        if (Test-Path -LiteralPath $item.File -PathType Leaf) {
            Remove-Item -LiteralPath $item.File -Force
            Write-Note ("已删除 PID 文件 " + $item.File)
        }
    }
    $stateFile = Join-Path $RuntimeDir 'live-env.json'
    if (Test-Path -LiteralPath $stateFile -PathType Leaf) {
        Remove-Item -LiteralPath $stateFile -Force
        Write-Note ("已删除状态文件 " + $stateFile)
    }
    Write-Note ('保留（故意的）：' + $RelayHome + '、' + $GatewayHome + ' → 中继密钥与设备令牌不失效，重新 start 后模拟器 App 自动恢复连接')

    # 生产/桌面端仍在跑的话只报告，不动
    $desktop = $null
    try {
        $req = [System.Net.WebRequest]::Create('http://127.0.0.1:19387/')
        $req.Method = 'GET'; $req.Timeout = 3000
        $resp = $req.GetResponse(); $desktop = [int]$resp.StatusCode; $resp.Close()
    } catch [System.Net.WebException] {
        # 404/401 也算「在跑」：只要能应答就说明进程活着
        if ($null -ne $_.Exception.Response) { $desktop = [int]$_.Exception.Response.StatusCode }
    } catch { $desktop = $null }
    if ($null -ne $desktop) { Write-Ok ("真实桌面端运行时 127.0.0.1:19387 未受影响（HTTP " + $desktop + "）") }
    else { Write-Warn '真实桌面端运行时 127.0.0.1:19387 当前不可达（不是本脚本停的）' }

    Write-Host ''
    if ($script:Refused) {
        Write-Host ' 已停止本夹具进程，但有目标被安全判定拦下（见上面 [ERR]）。' -ForegroundColor Yellow
        exit 4
    }
    Write-Host ' live-env 已停止（幂等，可重复执行）。' -ForegroundColor Green
    exit 0
} catch {
    Write-Host ''
    Write-Host (" 未预期异常：" + $_.Exception.Message) -ForegroundColor Red
    Write-Host ($_.ScriptStackTrace) -ForegroundColor DarkGray
    exit 1
}
