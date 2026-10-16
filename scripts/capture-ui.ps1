<#
.SYNOPSIS
  逐屏截图当前运行中的 DshRemote App（模拟器/真机），用于与 docs/01-设计/原型 的 6 张原型图比对。

.DESCRIPTION
  只看缩略图不算验收：本脚本同时 dump 每屏的 UI 层级 XML（含每个节点的 bounds 与 text），
  便于按坐标核对字号/间距，而不是凭肉眼猜。

  依赖：adb（默认取仓库内 .toolchain\android-dev\sdk\platform-tools\adb.exe）。
  注意：本文件必须保存为 UTF-8 with BOM，否则 Windows PowerShell 5.1 会按 ANSI 解析导致中文乱码。

.PARAMETER Out
  证据输出目录。默认 android\evidence\ui\shots。

.PARAMETER Package
  目标包名。默认 debug 包 com.deepseek.dshremote.debug。

.PARAMETER SkipInstall
  跳过重新安装 APK（默认会安装 android\app\build\outputs\apk\debug\app-debug.apk，存在时）。

.EXAMPLE
  & scripts\capture-ui.ps1
  & scripts\capture-ui.ps1 -Out android\evidence\ui\after -SkipInstall
#>
[CmdletBinding()]
param(
  [string]$Out = 'android\evidence\ui\shots',
  [string]$Package = 'com.deepseek.dshremote.debug',
  [string]$Serial = '',
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$adbCandidates = @(
  (Join-Path $root '.toolchain\android-dev\sdk\platform-tools\adb.exe'),
  (Join-Path $root '.toolchain\sdk\platform-tools\adb.exe')
)
$adb = $adbCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $adb) { throw "找不到 adb，试过：`n  $($adbCandidates -join "`n  ")" }

$outDir = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $root $Out }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$rawDir = Join-Path $outDir 'raw'
New-Item -ItemType Directory -Force -Path $rawDir | Out-Null

function Invoke-Adb {
  param([string[]]$AdbArgs, [switch]$AllowFail)
  $all = @()
  if ($Serial) { $all += @('-s', $Serial) }
  $all += $AdbArgs
  # PowerShell 5.1 会把原生命令的 stderr 当成 NativeCommandError（adb pull 的 "1 file pulled" 就写在 stderr），
  # 因此这里只在【函数内】把 ErrorActionPreference 调成 Continue，退出码仍按 $LASTEXITCODE 判定。
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $result = & $adb $all 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  if ($code -ne 0 -and -not $AllowFail) {
    throw "adb $($AdbArgs -join ' ') 失败（exit $code）：`n$($result -join "`n")"
  }
  return ($result | ForEach-Object { "$_" })
}

Write-Host "adb      : $adb"
Write-Host "out      : $outDir"

# 0) 连接检查
$devices = Invoke-Adb -AdbArgs @('devices')
if (-not (($devices -join "`n") -match '\sdevice')) {
  throw "没有可用设备（adb devices 输出：`n$($devices -join "`n")）"
}

# 1) 安装最新 debug APK
$apk = Join-Path $root 'android\app\build\outputs\apk\debug\app-debug.apk'
if (-not $SkipInstall) {
  if (Test-Path $apk) {
    Write-Host "install  : $apk"
    Invoke-Adb -AdbArgs @('install', '-r', '-d', $apk) | Write-Host
  } else {
    Write-Warning "未找到 $apk，跳过安装（先跑 :app:assembleDebug）"
  }
}

function Start-App {
  Invoke-Adb -AdbArgs @('shell', 'am', 'force-stop', $Package) | Out-Null
  Invoke-Adb -AdbArgs @('shell', 'am', 'start', '-n', "$Package/com.deepseek.dshremote.MainActivity") | Out-Null
  Start-Sleep -Seconds 3
}

function Get-UiXml {
  param([string]$Name)
  Invoke-Adb -AdbArgs @('shell', 'uiautomator', 'dump', '/sdcard/ui.xml') -AllowFail | Out-Null
  $local = Join-Path $rawDir "$Name.xml"
  Invoke-Adb -AdbArgs @('pull', '/sdcard/ui.xml', $local) -AllowFail | Out-Null
  if (Test-Path $local) { return [System.IO.File]::ReadAllText($local, [System.Text.Encoding]::UTF8) }
  return ''
}

function Save-Shot {
  param([string]$Name)
  $png = Join-Path $outDir "$Name.png"
  # 用 shell + pull 拿二进制，避免 PowerShell 管道破坏 PNG
  Invoke-Adb -AdbArgs @('shell', 'screencap', '-p', '/sdcard/shot.png') | Out-Null
  Invoke-Adb -AdbArgs @('pull', '/sdcard/shot.png', $png) | Out-Null
  if (-not (Test-Path $png) -or (Get-Item $png).Length -lt 1000) {
    Write-Warning "截图 $Name 疑似失败"
  } else {
    Write-Host ("shot     : {0} ({1:N0} KB)" -f $Name, ((Get-Item $png).Length / 1KB))
  }
}

function Tap-Text {
  param([string]$Text, [string]$UiXml)
  if (-not $UiXml) { throw "UI 层级为空，无法定位「$Text」" }
  $doc = [xml]$UiXml
  foreach ($n in $doc.SelectNodes('//node')) {
    if ($n.text -and $n.text.Trim() -eq $Text) {
      if ("$($n.bounds)" -match '\[(\d+),(\d+)\]\[(\d+),(\d+)\]') {
        $x = [int]((([int]$Matches[1]) + ([int]$Matches[3])) / 2)
        $y = [int]((([int]$Matches[2]) + ([int]$Matches[4])) / 2)
        Invoke-Adb -AdbArgs @('shell', 'input', 'tap', "$x", "$y") | Out-Null
        Start-Sleep -Milliseconds 900
        Write-Host "tap      : 「$Text」 @ $x,$y"
        return $true
      }
    }
  }
  Write-Warning "未在 UI 层级里找到文本「$Text」，跳过该步"
  return $false
}

# 2) 逐屏
Start-App
Save-Shot '00-launch'
$ui = Get-UiXml '00-launch'

$isPairing = ($ui -match '配对码') -and ($ui -notmatch '电脑会话')

if ($isPairing) {
  Write-Warning 'App 处于配对页（未配对），仅记录该页。'
} else {
  $tabs = @(
    @{ Label = '电脑会话'; Shot = '01-computer-sessions' },
    @{ Label = '手机任务'; Shot = '02-phone-tasks' },
    @{ Label = '工作区';   Shot = '03-workspace' },
    @{ Label = '设置';     Shot = '04-settings' }
  )
  foreach ($t in $tabs) {
    $ui = Get-UiXml ("tab-" + $t.Shot)
    if (Tap-Text -Text $t.Label -UiXml $ui) {
      Start-Sleep -Milliseconds 1500
      Save-Shot $t.Shot
      Get-UiXml $t.Shot | Out-Null
    }
  }

  # 会话详情：回到电脑会话，点第一条可点卡片
  $ui = Get-UiXml 'back-to-sessions'
  Tap-Text -Text '电脑会话' -UiXml $ui | Out-Null
  Start-Sleep -Milliseconds 1500
  $ui = Get-UiXml 'sessions-list'
  $doc = [xml]$ui
  $first = $null
  # 只挑"列表行"：会话行 92dp（×2.75 ≈ 253px 高、≈970px 宽），任务行 88dp。
  # 早先只按 top>300 挑 → 命中的是筛选芯片；只按高度 ≥120px 挑 → 芯片触摸区是 48dp=132px 也会命中。
  # 这里同时卡高度（≥200px）与宽度（≥600px），把芯片、圆钮、导航项全部排除。
  foreach ($n in $doc.SelectNodes('//node[@clickable="true"]')) {
    if ("$($n.bounds)" -match '\[(\d+),(\d+)\]\[(\d+),(\d+)\]') {
      $top = [int]$Matches[2]
      $w = [int]$Matches[3] - [int]$Matches[1]
      $h = [int]$Matches[4] - $top
      if ($top -gt 300 -and $h -ge 200 -and $w -ge 600) { $first = $n; break }
    }
  }
  if ($first) {
    $null = "$($first.bounds)" -match '\[(\d+),(\d+)\]\[(\d+),(\d+)\]'
    $x = [int]((([int]$Matches[1]) + ([int]$Matches[3])) / 2)
    $y = [int]((([int]$Matches[2]) + ([int]$Matches[4])) / 2)
    $label = ($first.SelectNodes('.//node[@text]') | Select-Object -First 1).text
    Invoke-Adb -AdbArgs @('shell', 'input', 'tap', "$x", "$y") | Out-Null
    Write-Host "tap      : 会话卡片「$label」 @ $x,$y"
    Start-Sleep -Seconds 3
    Save-Shot '05-session-detail'
    Get-UiXml '05-session-detail' | Out-Null
    Invoke-Adb -AdbArgs @('shell', 'input', 'swipe', '540', '1800', '540', '700', '300') | Out-Null
    Start-Sleep -Seconds 2
    Save-Shot '06-session-detail-bottom'
    Get-UiXml '06-session-detail-bottom' | Out-Null
    # 轨迹视图
    $ui = Get-UiXml 'detail-tabs'
    if (Tap-Text -Text '轨迹' -UiXml $ui) {
      Start-Sleep -Milliseconds 1500
      Save-Shot '07-trajectory'
      Get-UiXml '07-trajectory' | Out-Null
    }
  } else {
    Write-Warning '会话列表里没找到可点卡片，跳过详情页截图'
  }
}

Write-Host "`n完成。证据目录：$outDir"
