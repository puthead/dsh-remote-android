<#
.SYNOPSIS
  一条命令把 DshRemote 的崩溃现场从手机里拉出来：`logcat -b crash`、系统 tombstone/dropbox、
  以及 app 私有目录里的 `files/crashes/crash-*.txt`（由 CrashReporter 落盘）。

.DESCRIPTION
  为什么需要这个脚本：crash-*.txt 写在 `filesDir/crashes/`（app 私有目录，不需要任何存储权限），
  用户没法在文件管理器里直接取；同时系统侧还有三条互补的证据通道（logcat crash 缓冲、
  dropbox、tombstone）。本脚本一次性把四路证据归到同一个目录，并打印最新一条崩溃的头部摘要。

  四路证据：
    1. logcat-crash.txt      —— `adb logcat -d -b crash`，系统默认 handler 打的 Java 崩溃栈
    2. logcat-main.txt       —— `adb logcat -d -b main -b system`，崩溃前 App 自己打的日志
    3. dropbox-*.txt         —— `dumpsys dropbox --print`，含 native crash / ANR（部分设备需 root）
    4. app-crash/*.txt       —— app 私有目录 `files/crashes/crash-*.txt`（含设备信息 + 崩溃前 200 行日志）

  debug 包（com.deepseek.dshremote.debug）是 debuggable，`adb shell run-as` 能读私有目录；
  release 包读不到 —— 脚本会明确提示，并让你改用「设置 → 导出自检日志」。

  依赖：adb（默认取仓库内 .toolchain\android-dev\sdk\platform-tools\adb.exe）。
  注意：本文件必须保存为 UTF-8 with BOM，否则 Windows PowerShell 5.1 会按 ANSI 解析导致中文乱码。

.PARAMETER Out
  证据输出目录。默认 android\evidence\crash。

.PARAMETER Package
  目标包名。默认 debug 包 com.deepseek.dshremote.debug。

.PARAMETER Serial
  指定设备序列号（多设备时必须给）。

.PARAMETER LogcatTail
  main/system 日志最多取多少行。默认 20000；给 0 表示全量。

.PARAMETER Clear
  取证完成后顺手清空 app 私有目录的 crash-*.txt 与 logcat 缓冲（便于"复现一次干净的崩溃"）。

.EXAMPLE
  & scripts\collect-crash.ps1
  & scripts\collect-crash.ps1 -Out android\evidence\crash\after-fix -Clear
  # 不看脚本、只要最原始的一条命令：
  #   adb logcat -d -b crash ; adb shell run-as com.deepseek.dshremote.debug ls files/crashes
#>
[CmdletBinding()]
param(
  [string]$Out = 'android\evidence\crash',
  [string]$Package = 'com.deepseek.dshremote.debug',
  [string]$Serial = '',
  [int]$LogcatTail = 20000,
  [switch]$Clear
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
$appCrashDir = Join-Path $outDir 'app-crash'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
New-Item -ItemType Directory -Force -Path $appCrashDir | Out-Null

function Invoke-Adb {
  param([string[]]$AdbArgs, [switch]$AllowFail)
  $all = @()
  if ($Serial) { $all += @('-s', $Serial) }
  $all += $AdbArgs
  # PowerShell 5.1 会把原生命令的 stderr 当成 NativeCommandError，因此这里只在【函数内】把
  # ErrorActionPreference 调成 Continue，退出码仍按 $LASTEXITCODE 判定。
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

# 文本统一按 UTF-8(无 BOM) 落盘：crash-*.txt 是 UTF-8，logcat 里的中文也是。
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Save-Text {
  param([string]$Path, [string[]]$Lines)
  [System.IO.File]::WriteAllLines($Path, $Lines, $utf8NoBom)
}

Write-Host "adb      : $adb"
Write-Host "package  : $Package"
Write-Host "out      : $outDir"

# ── 0) 连接检查 + 包是否装了 ─────────────────────────────────────────────
$devices = Invoke-Adb -AdbArgs @('devices')
if (-not (($devices -join "`n") -match '\sdevice')) {
  throw "没有可用设备（adb devices 输出：`n$($devices -join "`n")）"
}

$pmList = Invoke-Adb -AdbArgs @('shell', 'pm', 'list', 'packages', $Package) -AllowFail
$installed = (($pmList -join "`n") -match [regex]::Escape($Package))
if (-not $installed) {
  Write-Warning "设备上没装 $Package（包名不对？release 包请加 -Package com.deepseek.dshremote）。仍会拉系统侧三路证据。"
}

# run-as 只对 debuggable 包有效；先探一下能不能读私有目录
$runAsOk = $false
if ($installed) {
  $probe = Invoke-Adb -AdbArgs @('shell', 'run-as', $Package, 'ls', 'files') -AllowFail
  $runAsOk = -not (($probe -join "`n") -match 'not debuggable|unknown package|Permission denied|inaccessible')
  if (-not $runAsOk) {
    Write-Warning "run-as $Package 不可用（release 包不可读私有目录）——crash-*.txt 只能让用户在「设置 → 导出自检日志」里导出。"
  }
}

# ── 1) logcat：crash 缓冲 + main/system ─────────────────────────────────
Write-Host "`n[1/4] logcat"
$crashLog = Join-Path $outDir 'logcat-crash.txt'
$mainLog = Join-Path $outDir 'logcat-main.txt'
try {
  Save-Text -Path $crashLog -Lines (Invoke-Adb -AdbArgs @('logcat', '-d', '-b', 'crash', '-v', 'threadtime') -AllowFail)
  Write-Host ("  logcat-crash.txt  : {0} 行" -f (Get-Content $crashLog -ErrorAction SilentlyContinue).Count)
} catch {
  Write-Warning "拉 crash 缓冲失败：$_"
}
try {
  $tailArgs = @('logcat', '-d', '-b', 'main', '-b', 'system', '-v', 'threadtime')
  if ($LogcatTail -gt 0) { $tailArgs += @('-t', "$LogcatTail") }
  Save-Text -Path $mainLog -Lines (Invoke-Adb -AdbArgs $tailArgs -AllowFail)
  Write-Host ("  logcat-main.txt   : {0} 行" -f (Get-Content $mainLog -ErrorAction SilentlyContinue).Count)
} catch {
  Write-Warning "拉 main 日志失败：$_"
}

# ── 2) dropbox（native crash / ANR，root 之外的兜底通道） ───────────────
Write-Host "`n[2/4] dropbox"
foreach ($tag in @('data_app_crash', 'data_app_native_crash', 'data_app_anr', 'SYSTEM_TOMBSTONE')) {
  $lines = Invoke-Adb -AdbArgs @('shell', 'dumpsys', 'dropbox', '--print', $tag) -AllowFail
  $text = $lines -join "`n"
  if ($text -match 'Permission Denial|Unknown tag|No such|not found') {
    Write-Host "  $tag : 不可读（跳过）"
    continue
  }
  # dropbox 常年空着，空文件不进证据目录，免得误导
  if ($text.Trim().Length -lt 32) {
    Write-Host "  $tag : 无记录"
    continue
  }
  Save-Text -Path (Join-Path $outDir "dropbox-$tag.txt") -Lines $lines
  Write-Host ("  dropbox-{0}.txt : {1} 行" -f $tag, $lines.Count)
}

# ── 3) tombstone（需 root，读不到不算失败） ──────────────────────────────
Write-Host "`n[3/4] tombstone"
$tombList = Invoke-Adb -AdbArgs @('shell', 'ls', '-l', '/data/tombstones/') -AllowFail
$tombText = $tombList -join "`n"
if ($tombText -match 'Permission denied|No such file') {
  Write-Host "  /data/tombstones 不可读（未 root）。native 崩溃请看 dropbox-data_app_native_crash / logcat-crash。"
} else {
  Save-Text -Path (Join-Path $outDir 'tombstones-list.txt') -Lines $tombList
  $names = $tombList | Where-Object { $_ -match '(tombstone_\d+)$' } | ForEach-Object { $Matches[1] } | Select-Object -Unique
  Write-Host ("  tombstones-list.txt : {0} 个 tombstone" -f $names.Count)
  foreach ($name in $names) {
    $body = Invoke-Adb -AdbArgs @('shell', 'cat', "/data/tombstones/$name") -AllowFail
    Save-Text -Path (Join-Path $outDir "tombstone-$name.txt") -Lines $body
    Write-Host "    tombstone-$name.txt"
  }
}

# ── 4) app 私有目录的 crash-*.txt ───────────────────────────────────────
Write-Host "`n[4/4] files/crashes（CrashReporter 落盘）"
$pulled = @()
if ($runAsOk) {
  $listing = Invoke-Adb -AdbArgs @('shell', 'run-as', $Package, 'ls', '-1', 'files/crashes') -AllowFail
  $names = $listing |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -match '^crash-.*\.txt$' } |
    Sort-Object -Descending
  if ($names.Count -eq 0) {
    Write-Host "  没有 crash-*.txt（也可能目录还不存在）"
  }
  foreach ($name in $names) {
    $body = Invoke-Adb -AdbArgs @('shell', 'run-as', $Package, 'cat', "files/crashes/$name") -AllowFail
    $local = Join-Path $appCrashDir $name
    Save-Text -Path $local -Lines $body
    $pulled += $local
    Write-Host "  app-crash\$name"
  }
  # 顺手把「设置 → 导出自检日志」产出的文件也带走（落在外部私有目录
  # /sdcard/Android/data/<pkg>/files/，内容同样脱敏，含崩溃报告 + 最近 500 行运行日志）。
  # 注意 Logger 本身只维护内存环形缓冲、不落盘，所以这是唯一一份"完整"日志。
  $extDir = "/sdcard/Android/data/$Package/files"
  $logListing = Invoke-Adb -AdbArgs @('shell', 'run-as', $Package, 'ls', '-1', $extDir) -AllowFail
  $logNames = $logListing |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -match '^dsh-remote-log-.*\.txt$' } |
    Sort-Object -Descending |
    Select-Object -First 3
  foreach ($name in $logNames) {
    $body = Invoke-Adb -AdbArgs @('shell', 'run-as', $Package, 'cat', "$extDir/$name") -AllowFail
    Save-Text -Path (Join-Path $outDir "app-log-$name") -Lines $body
    Write-Host "  app-log-$name"
  }
}

# ── 摘要：最新一条崩溃的头部 ────────────────────────────────────────────
Write-Host "`n===== 最新一条崩溃 ====="
if ($pulled.Count -gt 0) {
  $latest = $pulled | Sort-Object -Descending | Select-Object -First 1
  Write-Host "文件：$latest"
  Get-Content $latest | Select-Object -First 24 | ForEach-Object { "  $_" }
} elseif (($devices -join "`n") -match '\sdevice' -and -not $runAsOk) {
  Write-Host "  （release 包读不到私有目录；改用「设置 → 导出自检日志」）"
} else {
  Write-Host "  未发现 app 侧崩溃文件；若 logcat-crash.txt 非空，说明崩溃发生在 CrashReporter 安装之前"
  Write-Host "  （例如 Application 类加载阶段），请看 logcat-crash.txt。"
}

if ($Clear) {
  Write-Host "`n清理现场（-Clear）"
  if ($runAsOk) {
    Invoke-Adb -AdbArgs @('shell', 'run-as', $Package, 'sh', '-c', 'rm -f files/crashes/crash-*.txt') -AllowFail | Out-Null
  }
  Invoke-Adb -AdbArgs @('logcat', '-b', 'crash', '-c') -AllowFail | Out-Null
  Invoke-Adb -AdbArgs @('logcat', '-c') -AllowFail | Out-Null
  Write-Host "  已清空 crash-*.txt 与 logcat 缓冲"
}

Write-Host "`n完成。证据目录：$outDir"
