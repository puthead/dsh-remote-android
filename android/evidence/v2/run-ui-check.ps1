# =============================================================================
# DSH Remote v2 · Android 真机 UI 证据脚本（模拟器 emulator-5554）
#
# 做什么：
#   1) 起一个**按契约 §2/§3/§4 实现的夹具中继+网关**（mock-tunnel.mjs），
#      手机侧走真实 WebSocket 隧道（req/res/chunk/end + SSE 长流），只有数据是夹具；
#   2) 装 debug APK、清数据、走完「配对 → 电脑会话 → 对话流 → 工作区 → 改动 → diff → 设置」；
#   3) 每一步都 `uiautomator dump` 校验关键中文文案，并截图到 android/evidence/v2/；
#   4) 最后驱动夹具切到「电脑离线」，验证手机显示"电脑离线"而不是转圈。
#
# 为什么要重新 dump 取坐标：明文 ws:// 会插入风险提示卡，把下方控件顶下去（BUILD.md §7.1），
# 复用旧坐标会点到说明文字上，表现为"点了没反应"。
#
# 兼容：Windows PowerShell 5.1（本机没有 pwsh）。脚本本体必须存成 **UTF-8 with BOM**，
#      否则 5.1 会按 ANSI 解析中文，直接语法错误。
# =============================================================================
[CmdletBinding()]
param(
    [string]$Serial = 'emulator-5554',
    # 刻意不用 9443：真实中继（tools/dsh-relay）默认监听它，抢端口会让证据跑不稳定
    [int]$Port = 9543,
    [string]$Apk = 'D:\Workspace\dsh_android\android\app\build\outputs\apk\debug\app-debug.apk',
    [string]$OutDir = 'D:\Workspace\dsh_android\android\evidence\v2',
    [switch]$SkipInstall,
    [switch]$KeepFixture
)

$ErrorActionPreference = 'Stop'

$Adb = 'D:\Workspace\dsh_android\.toolchain\android-dev\sdk\platform-tools\adb.exe'
$NodeExe = 'D:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$Fixture = Join-Path $OutDir 'mock-tunnel.mjs'
$Package = 'com.deepseek.dshremote.debug'
$OtherPackage = 'com.deepseek.dshremote'
$Activity = "$Package/com.deepseek.dshremote.MainActivity"
$RelayUrl = "ws://10.0.2.2:$Port"
$ShotDir = Join-Path $OutDir 'shots'
$WorkDir = Join-Path $OutDir 'raw'

$script:Checks = @()
$script:FixtureProcess = $null

# 收掉一棵进程树（PID 作用域）。taskkill 对已退出的 PID 会写 stderr，
# 在 ErrorActionPreference=Stop 下会变成终止性错误 —— 这里先查存在性再局部放行 stderr。
function Kill-PidTree([int]$ProcessId) {
    if (-not $ProcessId) { return }
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & taskkill.exe /PID $ProcessId /T /F 2>&1 | Out-Null } finally { $ErrorActionPreference = $previous }
}
function Write-Step($text) {
    Write-Host "`n=== $text" -ForegroundColor Cyan
    # 每步开头把 DSH 拉回前台。模拟器上别的 App（典型：系统 Email 首次运行向导）会抢走前台，
    # 此后所有按"上一份 dump 的坐标"发出的盲点都打在别人身上：本轮实测一次被抢走，
    # 第 5 步之后的 40 项断言全红，且 08/09、16/17/18、19/20 的截图字节数完全相同。
    if ($Package) { Ensure-Foreground | Out-Null }
}

# 当前前台包名（优先 mCurrentFocus，其次 mFocusedApp；读不到返回空串）
function Get-ForegroundPackage {
    $dump = ''
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $dump = (Invoke-Adb shell dumpsys window 2>$null | Out-String) } finally { $ErrorActionPreference = $previous }
    foreach ($pattern in @('mCurrentFocus=.*?\s([A-Za-z0-9_\.]+)/', 'mFocusedApp=.*?\s([A-Za-z0-9_\.]+)/')) {
        foreach ($line in ($dump -split "`n")) {
            if ($line -match $pattern) { return $Matches[1] }
        }
    }
    return ''
}

# 保证 DSH 在前台；抢回来了才返回 $true（丢前台会让整段断言级联假红，比单个 FAIL 昂贵得多）
function Ensure-Foreground([int]$MaxTries = 3) {
    for ($i = 1; $i -le $MaxTries; $i++) {
        $foreground = Get-ForegroundPackage
        if ($foreground -eq $Package) { return $true }
        Write-Host "  前台是 '$foreground'（不是 $Package），第 $i 次拉回 DSH" -ForegroundColor Yellow
        Invoke-Adb shell am start -n $Activity | Out-Null
        Start-Sleep -Seconds 3
    }
    $foreground = Get-ForegroundPackage
    if ($foreground -ne $Package) {
        Add-Check 'DSH 回到前台' $false "当前前台是 '$foreground'（别的 App 抢走了前台，后续断言不可信）"
        return $false
    }
    Add-Check 'DSH 回到前台' $true "$Package 已在前台"
    return $true
}

function Add-Check([string]$name, [bool]$ok, [string]$detail) {
    $script:Checks += [pscustomobject]@{ name = $name; ok = $ok; detail = $detail }
    if ($ok) {
        Write-Host ("  [PASS] {0} {1}" -f $name, $detail) -ForegroundColor Green
    }
    else {
        Write-Host ("  [FAIL] {0} {1}" -f $name, $detail) -ForegroundColor Red
    }
}

# adb 会把进度/提示写到 stderr（pull 的 "1 file pulled"、install 的 "Performing Streamed Install"）。
# PowerShell 5.1 的 `2>&1` 会把原生 stderr 变成 ErrorRecord，配合 ErrorActionPreference=Stop
# 会直接把脚本打断 —— 所以只在这几个包装函数内部临时放行 stderr，其余位置仍然 Stop。
function Invoke-Native([string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $Adb -s $Serial @Arguments 2>&1
    }
    finally {
        $ErrorActionPreference = $previous
    }
    return ($output | Out-String)
}

function Invoke-Adb {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    return Invoke-Native $Arguments
}

function Invoke-AdbRaw {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    return (Invoke-Native $Arguments)
}

# 含 `-W`/`-r` 这类"像 PowerShell 参数"的 adb 选项时必须显式传数组：
# 直接写 `Invoke-Adb shell am start -W ...` 会被解析成 -WarningAction 并报 ambiguous（实测）
function Invoke-AdbArgs {
    param([string[]]$Arguments)
    return Invoke-Native $Arguments
}

function Test-Device {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $devices = & $Adb devices 2>&1 | Out-String
    }
    finally {
        $ErrorActionPreference = $previous
    }
    return ($devices -match [regex]::Escape($Serial) + '\s+device')
}

# ---- 夹具（中继+网关替身） ---------------------------------------------------

function Test-Fixture {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 3
        if ($response.StatusCode -ne 200) { return $false }
        # 必须是"我们自己的夹具"：不能把别的服务（例如真实中继）当成夹具复用
        return ($response.Content -match 'relay\.fixture')
    }
    catch {
        return $false
    }
}

# 只清理"确认是我们这次运行的夹具"残留：必须**同时**满足
#   ① 命令行含 mock-tunnel.mjs（夹具脚本）
#   ② 命令行含本次运行的唯一端口 `--port <Port>`（队友用别的端口，绝不命中）
#   ③ 进程创建时间晚于本脚本启动时间
# 三条任一不满足 → 跳过并打印 SKIP（relay-dev 复核指出：只按脚本名匹配会误杀共享夹具）
$script:RunStartedAt = Get-Date
function Clear-StaleFixture {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $candidates = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -match 'mock-tunnel\.mjs' }
        foreach ($candidate in $candidates) {
            $isOurs = ($candidate.CommandLine -match ("--port\s+" + $Port)) -and
                ($candidate.CreationDate -ge $script:RunStartedAt.AddHours(-6))
            if ($isOurs) {
                Write-Host "  清理本次运行的残留夹具 pid=$($candidate.ProcessId)"
                Kill-PidTree $candidate.ProcessId
            }
            else {
                Write-Host "  SKIP kill pid=$($candidate.ProcessId)（不属于本次运行：端口或启动时间不匹配）"
            }
        }
        if ($candidates) { Start-Sleep -Milliseconds 800 }
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

function Start-Fixture {
    Clear-StaleFixture
    if (Test-Fixture) {
        Write-Host "夹具已在 127.0.0.1:$Port 运行（复用）"
        return
    }
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        throw "端口 $Port 被别的进程占用（不是本夹具）。请换 -Port，或先停掉占用它的服务。"
    }
    $stdout = Join-Path $OutDir 'fixture-tunnel.log'
    $stderr = Join-Path $OutDir 'fixture-tunnel.err.log'
    $script:FixtureProcess = Start-Process -FilePath $NodeExe `
        -ArgumentList @($Fixture, '--port', "$Port", '--code', '482913') `
        -WorkingDirectory $OutDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    Write-Host "夹具已启动 pid=$($script:FixtureProcess.Id) → $stdout"
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 400
        if (Test-Fixture) { return }
    }
    throw "夹具未能在 20s 内就绪，请看 $stderr"
}

function Stop-Fixture {
    if ($KeepFixture) {
        Write-Host '保留夹具进程（-KeepFixture）'
        return
    }
    if ($script:FixtureProcess -and -not $script:FixtureProcess.HasExited) {
        Stop-Process -Id $script:FixtureProcess.Id -Force -ErrorAction SilentlyContinue
    }
    # 兜底：端口仍被占用时按 owning process 收掉（此时已确认是本夹具占用的）
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($conn) {
            $conn | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
                Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
            }
        }
    }
    catch {
        Write-Host "端口清理跳过：$($_.Exception.Message)"
    }
}

function Set-ComputerOnline([bool]$online) {
    $path = '/__control/offline'
    if ($online) { $path = '/__control/online' }
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port$path" -Method Post -UseBasicParsing -TimeoutSec 5
    Write-Host "  控制面 $path → $($response.Content)"
}

# ---- UI 交互 ----------------------------------------------------------------

function Get-Ui {
    $remote = '/sdcard/dsh-ui.xml'
    Invoke-Adb shell uiautomator dump $remote | Out-Null
    $local = Join-Path $WorkDir 'ui.xml'
    Invoke-Adb pull $remote $local | Out-Null
    if (-not (Test-Path $local)) { throw 'uiautomator dump 失败：未取到 ui.xml' }
    # uiautomator 输出是 UTF-8：PS 5.1 的 Get-Content 默认按 ANSI 读，中文关键字会全部落空（BUILD.md §7.2）
    $text = [System.IO.File]::ReadAllText($local, [System.Text.UTF8Encoding]::new($false))
    return [xml]$text
}

# 取当屏所有非空文案（text + content-desc），失败诊断用：报告里能直接看出"这一页到底是什么"
function Get-UiTexts($doc) {
    $out = New-Object System.Collections.ArrayList
    foreach ($uiNode in $doc.SelectNodes('//node')) {
        foreach ($attr in @('text', 'content-desc')) {
            $value = [string]$uiNode.GetAttribute($attr)
            if ($value -and $value.Trim().Length -gt 0) { [void]$out.Add($value.Trim()) }
        }
    }
    return @($out | Select-Object -Unique)
}

function Get-NodeCenter($doc, [string]$pattern, [switch]$Exact) {
    foreach ($uiNode in $doc.SelectNodes('//node')) {
        $text = [string]$uiNode.GetAttribute('text')
        $desc = [string]$uiNode.GetAttribute('content-desc')
        $hit = $false
        if ($Exact) {
            if ($text -eq $pattern -or $desc -eq $pattern) { $hit = $true }
        }
        else {
            if ($text -like "*$pattern*" -or $desc -like "*$pattern*") { $hit = $true }
        }
        if ($hit) {
            $bounds = [string]$uiNode.GetAttribute('bounds')
            if ($bounds -match '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') {
                return [pscustomobject]@{
                    x    = [int](([int]$Matches[1] + [int]$Matches[3]) / 2)
                    y    = [int](([int]$Matches[2] + [int]$Matches[4]) / 2)
                    text = $text
                    desc = $desc
                }
            }
        }
    }
    return $null
}

function Tap-Pattern($doc, [string]$pattern, [switch]$Exact) {
    $target = $null
    if ($Exact) { $target = Get-NodeCenter $doc $pattern -Exact }
    else { $target = Get-NodeCenter $doc $pattern }
    if (-not $target) {
        Add-Check "点击「$pattern」" $false '未在界面上找到该控件'
        return $false
    }
    Invoke-Adb shell input tap $target.x $target.y | Out-Null
    Write-Host "  已点击「$pattern」($($target.x),$($target.y))"
    Start-Sleep -Milliseconds 900
    return $true
}

# 配对的表单在屏幕之外（页头 + 说明 + 二维码 + 表单 + 按钮比一屏高），Compose 不会把
# 没进视口的控件放进语义树 ⇒ 直接 dump 找不到「填入示例」「配对并连接」，脚本会在
# 第 2 步整段假红。这里先向上滑到目标出现为止（最多 3 次），每次重新 dump 取坐标。
function Ensure-Visible([string]$pattern, [int]$MaxSwipes = 3) {
    for ($i = 0; $i -le $MaxSwipes; $i++) {
        $doc = Get-Ui
        if ($null -ne (Get-NodeCenter $doc $pattern)) { return $doc }
        Invoke-Adb shell input swipe 540 1800 540 900 300 | Out-Null
        Start-Sleep -Milliseconds 900
    }
    return (Get-Ui)
}

# 底部导航按坐标点：标签文本（如"工作区"）会与页面内的文字（搜索框占位符"搜索标题 / 工作区"）撞名，
# 按文本查找会点到别处（实测踩过）。屏幕宽度等分四份即为四个 Tab 的中心。
function Tap-Nav([int]$index) {
    $size = Invoke-Adb shell wm size
    if ($size -match '(\d+)x(\d+)') {
        $width = [int]$Matches[1]
        $height = [int]$Matches[2]
    }
    else {
        $width = 1080
        $height = 2400
    }
    $x = [int]($width * (2 * $index + 1) / 8)
    $y = $height - 126
    Invoke-Adb shell input tap $x $y | Out-Null
    Write-Host "  已点击底部导航 #$index ($x,$y)"
    Start-Sleep -Milliseconds 900
}

function Assert-Ui($doc, [string]$pattern, [string]$label) {
    $NodeExe = Get-NodeCenter $doc $pattern
    $ok = $null -ne $NodeExe
    if ($ok) {
        Add-Check $label $true ("期望界面包含「$pattern」")
    }
    else {
        # 失败时把当屏可见文案带进报告：否则"缺文案"与"压根不在这一页"在报告里长得一样，
        # 排查只能靠人肉看截图（本轮就吃过这个亏）。
        $seen = @(Get-UiTexts $doc | Select-Object -First 24) -join ' | '
        Add-Check $label $false ("期望界面包含「$pattern」；当屏文案：$seen")
    }
    return $ok
}

# 会话页的「填入示例」在 v2.7 起移进了顶栏「更多」下拉菜单（SessionDetailScreen.kt:422 的
# MenuLabel("填入示例")），不再是输入框旁的按钮 —— 旧脚本直接 Tap-Pattern 必然落空。
function Fill-DemoPrompt {
    $doc = Get-Ui
    $more = Get-NodeCenter $doc '更多'
    if (-not $more) {
        Add-Check '打开「更多」菜单填示例' $false '未在会话页找到「更多」按钮'
        return $false
    }
    Invoke-Adb shell input tap $more.x $more.y | Out-Null
    Start-Sleep -Milliseconds 900
    $doc = Get-Ui
    $item = Get-NodeCenter $doc '填入示例'
    if (-not $item) {
        Add-Check '打开「更多」菜单填示例' $false '「更多」菜单里没有「填入示例」'
        return $false
    }
    Invoke-Adb shell input tap $item.x $item.y | Out-Null
    Start-Sleep -Milliseconds 500
    Add-Check '打开「更多」菜单填示例' $true '已从「更多」菜单点击「填入示例」'
    return $true
}

# 长页面断言：设置页一屏放不下，而"一次滑到底"会滑过头（实测把「吊销本机令牌」滑过去 ⇒ 假红）。
# 逐屏下滑、每屏重新 dump，命中即停；返回最后一次 dump 供后续截图/点击。
function Assert-UiByScrolling([string]$pattern, [string]$label, [int]$MaxSwipes = 5) {
    for ($i = 0; $i -le $MaxSwipes; $i++) {
        $doc = Get-Ui
        if ($null -ne (Get-NodeCenter $doc $pattern)) {
            Add-Check $label $true ("期望界面包含「$pattern」（下滑 $i 屏后命中）")
            return $doc
        }
        if ($i -lt $MaxSwipes) {
            Scroll-Up -Times 1
            Start-Sleep -Milliseconds 700
        }
    }
    $seen = @(Get-UiTexts (Get-Ui) | Select-Object -First 24) -join ' | '
    Add-Check $label $false ("期望界面包含「$pattern」；滑了 $MaxSwipes 屏仍未命中；当屏文案：$seen")
    return (Get-Ui)
}

function Save-Shot([string]$name) {
    if (-not (Test-Path $ShotDir)) { New-Item -ItemType Directory -Path $ShotDir -Force | Out-Null }
    $file = Join-Path $ShotDir "$name.png"
    if (Test-Path $file) { Remove-Item $file -Force }
    # 二进制重定向必须走 cmd：PowerShell 5.1 的 ">" 会把 PNG 当文本，写出损坏文件
    $line = '"' + $Adb + '" -s ' + $Serial + ' exec-out screencap -p > "' + $file + '"'
    & cmd.exe /c $line | Out-Null
    if (-not (Test-Path $file)) {
        Add-Check "截图 $name" $false '文件未生成'
        return $null
    }
    $size = (Get-Item $file).Length
    $ok = $size -gt 20000
    Add-Check "截图 $name" $ok ("$size 字节")
    return $file
}

function Scroll-Up {
    param([int]$Times = 1)
    for ($i = 0; $i -lt $Times; $i++) {
        Invoke-Adb shell input swipe 540 1700 540 900 250 | Out-Null
        Start-Sleep -Milliseconds 500
    }
}

function Back {
    Invoke-Adb shell input keyevent 4 | Out-Null
    Start-Sleep -Milliseconds 900
}

# 系统弹窗（"Allow DSH 远程 to send you notifications?"）会盖住 App 且被 uiautomator 当成前台窗口，
# 使所有断言全部落空（实测）。脚本先用 pm grant 从源头避免，再兜底点掉弹窗。
function Dismiss-SystemDialogs {
    for ($i = 0; $i -lt 3; $i++) {
        $doc = Get-Ui
        $target = Get-NodeCenter $doc 'Allow' -Exact
        if (-not $target) { $target = Get-NodeCenter $doc '允许' }
        if (-not $target) { $target = Get-NodeCenter $doc '确定' }
        if (-not $target) { return }
        Invoke-Adb shell input tap $target.x $target.y | Out-Null
        Write-Host ("  已关闭系统弹窗「{0}」" -f $target.text)
        Start-Sleep -Milliseconds 900
    }
}

function Wait-ForUi([string]$pattern, [int]$TimeoutSec = 20) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $doc = Get-Ui
        if (Get-NodeCenter $doc $pattern) { return $doc }
        Start-Sleep -Milliseconds 800
    }
    return $null
}

# 确保当前在"带底部导航的 Tab 页"。详情页是整屏页面（没有底部导航），
# 一旦命中的屏幕不对，后续所有列表类断言会级联失败（实测出现过一次 43 项级联假红）。
#
# 关键：**只在"确实有返回箭头（=详情页）"时才按返回**。在列表页按返回会直接退出 App，
# 之后所有点击都落在桌面上 —— 这正是上一轮 38 项级联假红的成因。
function Ensure-TabScreen([int]$index, [string]$expectText, [int]$MaxBack = 2) {
    for ($i = 0; $i -le $MaxBack; $i++) {
        $doc = Get-Ui
        if ($null -ne (Get-NodeCenter $doc $expectText)) { return $doc }
        if ($null -ne (Get-NodeCenter $doc '返回' -Exact)) {
            Invoke-Adb shell input keyevent 4 | Out-Null
            Start-Sleep -Milliseconds 900
            continue
        }
        break
    }
    Tap-Nav $index
    Start-Sleep -Seconds 1
    return (Get-Ui)
}

# ---- 主流程 -----------------------------------------------------------------

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
if (-not (Test-Path $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
if (-not (Test-Path $ShotDir)) { New-Item -ItemType Directory -Path $ShotDir -Force | Out-Null }

# ---- 互斥锁（Lead 复核要求）------------------------------------------------
# 两轮 E2E 抢同一个模拟器 + 同一组端口，必然互相踩：界面对不上 → "未找到控件"级联假红。
# 因此开跑前抢锁，发现已有实例在跑就立刻退出（exit 3），而不是跑出一堆假红误导验收。
$LockFile = Join-Path $OutDir '.e2e.lock'

function Enter-E2ELock([string]$name) {
    if (Test-Path $LockFile) {
        $info = Get-Content $LockFile -Raw -ErrorAction SilentlyContinue
        if ($info -match 'pid=(\d+)') {
            $otherPid = [int]$Matches[1]
            $other = Get-Process -Id $otherPid -ErrorAction SilentlyContinue
            if ($other) {
                Write-Host ("已有 E2E 在运行（PID {0}），请等待：" -f $otherPid) -ForegroundColor Yellow
                Write-Host ('  ' + ($info -replace "`r?`n", ' '))
                exit 3
            }
            Write-Host "发现陈旧锁（PID $otherPid 已退出），接管" -ForegroundColor Yellow
        }
    }
    ("pid=$PID`nname=$name`nstarted=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`nhost=$env:COMPUTERNAME`nserial=$Serial") |
        Set-Content -Path $LockFile -Encoding UTF8
}

function Exit-E2ELock {
    if (Test-Path $LockFile) { Remove-Item $LockFile -Force -ErrorAction SilentlyContinue }
}

Enter-E2ELock 'run-ui-check.ps1'

Write-Step '0. 环境检查'
Add-Check 'ADB 设备在线' (Test-Device) "serial=$Serial"
if (-not (Test-Device)) {
    Write-Host '模拟器不可用，终止。' -ForegroundColor Red
    Exit-E2ELock
    exit 2
}
Add-Check '夹具脚本存在' (Test-Path $Fixture) $Fixture
Add-Check 'APK 存在' (Test-Path $Apk) $Apk
if (-not (Test-Path $Apk)) { exit 2 }

Start-Fixture
Add-Check '夹具中继可达' (Test-Fixture) "http://127.0.0.1:$Port/health"

try {
    Write-Step '1. 安装与冷启动'
    if (-not $SkipInstall) {
        # 两个包并存会互相打断（BUILD.md §7.4）：先把 release 包停掉
        Invoke-Adb shell am force-stop $OtherPackage | Out-Null
        $install = Invoke-AdbArgs @('install', '-r', '-t', $Apk)
        Add-Check 'APK 安装' ($install -match 'Success') ($install.Trim() -replace "`r?`n", ' ')
    }
    Invoke-Adb shell pm clear $Package | Out-Null
    # 从源头避免通知授权弹窗盖住界面（Android 13+ 需要运行时授权；拒绝也不影响隧道）
    Invoke-Adb shell pm grant $Package android.permission.POST_NOTIFICATIONS | Out-Null
    # relayUrl 通过 debug 专用 extra 注入（模拟器没有中文输入法，输入 :// 也不可靠）
    Invoke-AdbArgs @('shell', 'am', 'start', '-W', '-n', $Activity, '--es', 'dsh_relay_url', $RelayUrl, '--es', 'dsh_pair_code', '482913') | Out-Null
    Start-Sleep -Seconds 3
    Dismiss-SystemDialogs

    $doc = Wait-ForUi 'DSH 远程控制台' 20
    if (-not $doc) { throw 'App 未启动到配对页' }
    Add-Check '配对页已渲染' ($null -ne (Get-NodeCenter $doc '中继地址')) '未配对时应进入配对页'
    Save-Shot '00-pairing' | Out-Null

    Write-Step '2. 配对（应用内示例填充 + 配对码）'
    # 表单在首屏之外：先滑到「填入示例」进视口，再重新 dump 取坐标（见 Ensure-Visible 注释）
    $doc = Ensure-Visible '填入示例'
    Tap-Pattern $doc '填入示例' | Out-Null
    $doc = Get-Ui
    Assert-Ui $doc '明文 ws://' '明文风险提示卡已出现' | Out-Null
    Assert-Ui $doc '482913' '示例配对码已填入' | Out-Null
    Save-Shot '01-pairing-filled' | Out-Null

    # 明文风险提示卡插进来以后按钮又被顶下去，同样要先滑到可见再点
    $doc = Ensure-Visible '配对并连接'
    Tap-Pattern $doc '配对并连接' | Out-Null
    Start-Sleep -Seconds 2
    Dismiss-SystemDialogs
    $doc = Wait-ForUi '电脑会话' 25
    if (-not $doc) { throw '配对后未进入主界面' }
    Add-Check '配对成功并进入主界面' $true '底部导航出现「电脑会话」'

    Write-Step '3. 电脑会话列表（状态胶囊：运行中 / 只读，默认态不复读）'
    Start-Sleep -Seconds 2
    # 先确保在"电脑会话"Tab 上（若误入详情页，按返回退出，避免整段断言级联假红）。
    # 守卫文案必须**只在本页出现**：页头大标题「DSH 远程」满足这一点；
    # 旧的「镜像会话」在 v2.7.0 改版后已从界面消失，一直是个假通过的守卫。
    $doc = Ensure-TabScreen 0 'DSH 远程'
    Assert-Ui $doc 'DSH 远程' '电脑会话页页头' | Out-Null
    Assert-Ui $doc '远程控制台开发' '会话标题（中文）正常渲染' | Out-Null
    # 状态语言：夹具里 session-88e9459c 是 live:true → 绿点 +「运行中」
    Assert-Ui $doc '运行中' '运行中会话显示呼吸点状态胶囊' | Out-Null
    # 夹具里除手机任务外全是 writable:false → 灰「只读」（旧版这里是绿「可续聊」，等于每行复读）
    Assert-Ui $doc '只读' '不可写会话显示"只读"而非"可续聊"' | Out-Null
    Assert-Ui $doc '7 个文件' '改动计数来自会话元数据（行内元信息 3 轮 · 7 个文件）' | Out-Null
    Save-Shot '02-sessions-computer' | Out-Null

    Write-Step '4. 对话流（工具调用折叠卡）'
    Tap-Pattern $doc '远程控制台开发' | Out-Null
    Start-Sleep -Seconds 2
    $doc = Get-Ui
    # 助手消息在夹具里是"只有工具调用、没有正文"的那一条（网关投影出来 text 为空），
    # 所以旧断言「助手」（正文里出现过这三个字）在改版后必然落空 —— 这里改钉工具调用名。
    Assert-Ui $doc 'write_todos' '助手消息（工具调用）已渲染' | Out-Null
    # 只读会话横幅：旧文案「该会话正由电脑端驱动」属 v2 早期版本，现在是真的横幅标题。
    Assert-Ui $doc '只读会话 · 无法从手机发送消息' '电脑会话详情显示只读横幅' | Out-Null
    Assert-Ui $doc 'pwsh' '工具调用卡片（含名称）已渲染' | Out-Null
    Save-Shot '03-conversation' | Out-Null

    Scroll-Up -Times 2
    $doc = Get-Ui
    # 折叠卡在 v2.7.0 起只显示「名称 · 时长 · exit 码」，错误结果正文要展开才有，
    # 所以先按 exit ≠0 找那张失败卡，再断言展开体里出现夹具的 ENOENT。
    $errorNode = Get-NodeCenter $doc 'exit ≠0'
    if ($errorNode) {
        Invoke-Adb shell input tap $errorNode.x $errorNode.y | Out-Null
        Start-Sleep -Milliseconds 1200
        $doc = Get-Ui
        Assert-Ui $doc 'ENOENT' '展开错误工具卡后显示失败原因（ENOENT）' | Out-Null
        # 展开态没有「参数」「结果」这类分区标题（v2.7 起刻意去掉：参数→结果本来就有固定先后），
        # 唯一能证明"确实展开了"的稳定文案是切换标签从「展开」变「收起」。
        Assert-Ui $doc '收起' 'isError 工具卡展开态已生效（切换标签变「收起」）' | Out-Null
        Save-Shot '04-tool-call-expanded' | Out-Null
    }
    else {
        Add-Check '展开错误工具卡' $false '未找到失败工具卡（exit ≠0）'
        Save-Shot '04-tool-call-expanded' | Out-Null
    }

    $doc = Get-Ui
    # 待办卡的标题在改版后是「任务清单」（旧断言「待办」是工具名 write_todos 的中文笔记，界面从没这么写）
    Assert-Ui $doc '任务清单' '待办列表（todo 工具投影）已显示' | Out-Null
    Save-Shot '05-conversation-todos' | Out-Null

    Write-Step '5. 工作区：目录树 / 改动 / diff'
    # expectText 必须选**只在该页出现**的文案：'文件' 会命中会话卡上的"7 个文件"，
    # 守卫就会以为已经在工作区页而不再切 Tab（实测踩到）。'返回上级' 只出现在工作区页。
    $doc = Ensure-TabScreen 2 '返回上级'
    Start-Sleep -Seconds 2
    $doc = Get-Ui
    Assert-Ui $doc 'dsh_android' '工作区名已渲染' | Out-Null
    Assert-Ui $doc 'README.md' '根目录条目已渲染' | Out-Null
    Assert-Ui $doc '文件' '「文件 / 改动 / 搜索」标签页已渲染' | Out-Null
    Save-Shot '06-workspace-root' | Out-Null

    Tap-Pattern $doc 'android' -Exact | Out-Null
    Start-Sleep -Seconds 2
    $doc = Get-Ui
    Assert-Ui $doc 'BUILD.md' '进入 android 目录后条目已渲染' | Out-Null
    Assert-Ui $doc '返回上级' '目录导航（返回上级）可用' | Out-Null
    Save-Shot '07-workspace-files' | Out-Null

    Tap-Pattern $doc '改动' -Exact | Out-Null
    # 改动页要等 diff 预览（一次 loadDiff 网络往返）落地：实测点完立刻 dump 时
    # 预览卡还在「正在生成 diff…」，而**旧版这里会把整进程打崩**（见下方 08 注释）。
    Start-Sleep -Seconds 6
    $doc = Get-Ui
    Assert-Ui $doc 'main' 'git 分支信息已渲染' | Out-Null
    Assert-Ui $doc '已跟踪改动' '改动分组标题' | Out-Null
    Assert-Ui $doc '未跟踪文件' '未跟踪分组标题' | Out-Null
    Assert-Ui $doc 'RelayClient.kt' '改动文件条目' | Out-Null
    # 回归守卫：改动页的 diff 预览卡曾把 LazyColumn(DiffView) 套进 LazyColumn 的 item 里，
    # 量到 infinity 约束直接抛 IllegalStateException ⇒ 一进「改动」就崩（crash-2026…txt）。
    # 预览卡渲染的是"hunk 头 + 若干行"（**不含** diff --git 头，那是点进文件后的 DiffScreen 才有），
    # 所以这里用 @@ 当守卫：改动页上只有预览卡会出现它。
    Assert-Ui $doc '@@' '改动页 diff 预览已渲染（不在滚动容器里嵌套滚动）' | Out-Null
    Save-Shot '08-workspace-changes' | Out-Null

    Tap-Pattern $doc 'RelayClient.kt' | Out-Null
    Start-Sleep -Seconds 2
    $doc = Get-Ui
    Assert-Ui $doc 'diff --git' 'unified diff 已渲染' | Out-Null
    Assert-Ui $doc 'nextDelayMs' 'diff 新增行（绿底）已渲染' | Out-Null
    Assert-Ui $doc '@@' 'diff hunk 头已渲染' | Out-Null
    Save-Shot '09-diff' | Out-Null

    Write-Step '6. 手机任务：续聊 → 流式 → 工具卡 → 停止（销毁性）'
    # 注意：本页页头标题与底栏项同名（都叫「手机任务」），所以**不能**拿它当 Ensure-TabScreen 的
    # 守卫——守卫永远能命中底栏标签，于是永远不切 Tab，后面所有点击都留在上一页（实测 6 步全红）。
    # 这里直接点底栏第 1 项，再用本页独有的筛选/列表内容确认落位。
    Tap-Nav 1
    Start-Sleep -Seconds 2
    $doc = Get-Ui
    Assert-Ui $doc '手机任务：跑一遍单元测试' '手机任务列表渲染' | Out-Null
    # 手机任务页仍走旧的 TaskStatusPill（「已完成」等任务档），**不复用**电脑会话页的状态语言；
    # 旧断言「可续聊」在本页从来没有过对应文案（本页也没有 accessLabel），已退场。
    Assert-Ui $doc '已完成' '任务档位胶囊（TaskStatusPill）仍在' | Out-Null
    Save-Shot '10-phone-tasks' | Out-Null

    Tap-Pattern $doc '手机任务：跑一遍单元测试' | Out-Null
    Start-Sleep -Seconds 2
    $doc = Get-Ui
    Assert-Ui $doc '条消息' '手机任务详情已打开' | Out-Null
    Save-Shot '11-phone-conversation' | Out-Null

    # 第一次续聊：夹具一轮约 9s（真机上一轮几十秒），抓"流式中"这一帧
    Fill-DemoPrompt | Out-Null
    $doc = Get-Ui
    # 必须 -Exact：输入框上方那行说明是「发送到网关执行 · 权限按网关下发…」，子串匹配会先命中它，
    # 点上去等于什么都没发生（实测踩到：消息留在输入框、后续"停止"流程全红）。
    Tap-Pattern $doc '发送' -Exact | Out-Null
    Start-Sleep -Milliseconds 700
    $doc = Get-Ui
    # App 不再有「生成中」这个文案：流式态由三处共同表达——
    # ① VM 消息「已发送，等待模型输出…」（SessionDetailViewModel.kt:658）；
    # ② 对话流末端「第 N 轮进行中」芯片（DetailBits.kt:336-359）；
    # ③ 助手正文末尾的流式光标 " ▍"（markdown/MarkdownView.kt:80 CARET）。
    Assert-Ui $doc '等待模型输出' '流式渲染中（已受理并等待模型输出）' | Out-Null
    Assert-Ui $doc '轮进行中' '流式渲染中（对话流末端轮次芯片）' | Out-Null
    Save-Shot '12-phone-streaming' | Out-Null

    $doc = Wait-ForUi 'BUILD SUCCESSFUL in 25s' 30
    if (-not $doc) { $doc = Get-Ui }
    Assert-Ui $doc 'pwsh' '轮次里的工具调用卡片（tool.call/tool.result）' | Out-Null
    Save-Shot '13-phone-turn-done' | Out-Null

    # 第二次续聊：立刻停止 → 二次确认 → 会话不可继续
    Fill-DemoPrompt | Out-Null
    $doc = Get-Ui
    Tap-Pattern $doc '发送' -Exact | Out-Null
    Start-Sleep -Milliseconds 500
    $doc = Get-Ui
    Tap-Pattern $doc '停止' | Out-Null
    Start-Sleep -Milliseconds 700
    $doc = Get-Ui
    Assert-Ui $doc '停止后本会话无法继续' '停止按钮有二次确认且写明后果' | Out-Null
    Save-Shot '14-stop-confirm' | Out-Null
    Tap-Pattern $doc '确认停止' -Exact | Out-Null
    Start-Sleep -Seconds 2
    $doc = Get-Ui
    Assert-Ui $doc '本会话已停止，无法继续' '停止后输入框灰化并给出说明' | Out-Null
    Save-Shot '15-phone-task-stopped' | Out-Null

    # v2.10.0 起「新建任务」不再是对话框：点进去直接是 NewTaskScreen（页头「新建任务」+ 空对话态
    # 「还没有消息」+ 工作区/在哪执行·权限/模型三段设置 + 底部输入胶囊）⇒ 第一句话就在这一屏里写。
    Write-Step '6b. 新建任务（对话式创建屏）'
    Back
    Start-Sleep -Milliseconds 800
    Tap-Nav 1
    Start-Sleep -Seconds 1
    $doc = Get-Ui
    Tap-Pattern $doc '新建' | Out-Null
    Start-Sleep -Seconds 1
    $doc = Get-Ui
    Assert-Ui $doc '新建任务' '新建任务屏已打开（页头）' | Out-Null
    Assert-Ui $doc '还没有消息' '创建屏本身是对话界面（空态说明）' | Out-Null
    Assert-Ui $doc '工作区' '创建屏里能选工作区' | Out-Null
    Assert-Ui $doc '在哪执行 · 权限' '创建屏里能选执行位置与权限档' | Out-Null
    # 「填入示例」把示例 prompt 直接写进这一屏的输入框：dump 里能看到那段文字，就证明创建屏的
    # 输入框真的接着 ViewModel（不是只有个占位符），也就是「第一句话在这一屏里写」这件事成立。
    Tap-Pattern $doc '填入示例' | Out-Null
    $doc = Get-Ui
    Assert-Ui $doc '在本工作区里跑一遍 android 模块的单元测试' '示例内容落在创建屏自己的输入框里' | Out-Null
    Save-Shot '16-create-phone-task' | Out-Null
    # 返回键（content-desc「返回」）而不是旧对话框的「取消」：这一屏是路由不是弹窗。
    Tap-Pattern $doc '返回' -Exact | Out-Null
    Start-Sleep -Milliseconds 800

    Write-Step '7. 设置页（中继地址 / 明文提示 / 令牌吊销 / 日志导出）'
    Start-Sleep -Milliseconds 800
    Tap-Nav 3
    Start-Sleep -Seconds 2
    $doc = Get-Ui
    Assert-Ui $doc '中继地址' '中继地址输入框' | Out-Null
    Assert-Ui $doc '当前中继地址是明文' '明文风险提示卡' | Out-Null
    Save-Shot '17-settings-top' | Out-Null

    # 令牌吊销 / 日志导出在页面下半部分：必须滚动后重新 dump 取坐标（复用旧坐标会落空）。
    # 设置页有 5 个分组（连接/安全/关于/设备/诊断），一屏放不下 ⇒ 逐屏下滑断言，避免滑过头。
    # 旧断言写的是「导出日志」，而入口文案从 v2.2 起就是「导出自检日志」（SettingsScreen.kt:307）。
    $doc = Assert-UiByScrolling '吊销本机令牌' '令牌吊销入口' 6
    $doc = Assert-UiByScrolling '导出自检日志' '日志导出入口' 6
    $doc = Assert-UiByScrolling '崩溃记录' '崩溃记录入口可见' 6
    # 「本机账户状态」卡在最底部：令牌存储 / 网关能力两行都在它里面，继续往下滑才看得到。
    $doc = Assert-UiByScrolling '令牌已用 Android Keystore 加密存储' '令牌加密存储状态可见' 6
    # 旧断言「supportedApiVersions」只在该行**未探测**时才出现在文案里（SettingsScreen.kt:405）；
    # 已配对探测过时显示的是 capabilityNote ⇒ 改钉恒存在的行键「网关能力」（契约 §4.5）。
    $doc = Assert-UiByScrolling '网关能力' 'v2 能力判定说明（契约 §4.5）' 6
    Save-Shot '18-settings-bottom' | Out-Null

    Write-Step '8. 电脑离线态（控制面触发 home_offline）'
    Set-ComputerOnline $false
    Start-Sleep -Seconds 2
    $doc = Ensure-TabScreen 0 'DSH 远程'
    Start-Sleep -Seconds 2
    $doc = Wait-ForUi '电脑离线' 15
    if ($doc) {
        Add-Check '手机显示"电脑离线"' $true '收到 notice home_offline 后状态条变为离线'
    }
    else {
        Add-Check '手机显示"电脑离线"' $false '未在界面上找到"电脑离线"'
        $doc = Get-Ui
    }
    Save-Shot '19-computer-offline' | Out-Null

    Write-Step '9. 恢复在线'
    Set-ComputerOnline $true
    Start-Sleep -Seconds 2
    $doc = Wait-ForUi '已连接' 15
    if ($doc) {
        Add-Check '恢复在线后状态条回到"已连接"' $true 'notice home_online 生效'
    }
    else {
        Add-Check '恢复在线后状态条回到"已连接"' $false '未看到"已连接"'
    }
    Save-Shot '20-recovered-online' | Out-Null

    Write-Step '10. 旧网关（无 relay 块）必须提示"该电脑未启用中继"'
    # 夹具切到"旧网关"模式：pair/claim 不再返回 relay 块（契约裁定：relay 块是唯一判据）
    $control = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/__control/legacy-gateway" -Method Post -UseBasicParsing
    Write-Host "  控制面 → $($control.Content)"
    Invoke-Adb shell pm clear $Package | Out-Null
    Invoke-Adb shell pm grant $Package android.permission.POST_NOTIFICATIONS | Out-Null
    Invoke-AdbArgs @('shell', 'am', 'start', '-W', '-n', $Activity, '--es', 'dsh_relay_url', $RelayUrl, '--es', 'dsh_pair_code', '482913') | Out-Null
    Start-Sleep -Seconds 3
    Dismiss-SystemDialogs
    $doc = Wait-ForUi 'DSH 远程控制台' 20
    if ($doc) {
        # 配对页比一屏高：Compose 不把未进视口的控件放进语义树，必须先滚到可见（同第 2 步）
        $doc = Ensure-Visible '填入示例'
        Tap-Pattern $doc '填入示例' | Out-Null
        $doc = Ensure-Visible '配对并连接'
        Tap-Pattern $doc '配对并连接' | Out-Null
        Start-Sleep -Seconds 3
        $doc = Get-Ui
        Assert-Ui $doc '该电脑未启用中继' '缺 relay 块时给出指向 PC 配置的提示' | Out-Null
        Save-Shot '21-legacy-gateway' | Out-Null
    }
    else {
        Add-Check '旧网关提示' $false 'App 未回到配对页'
    }
}
catch {
    # 任何一步失败都必须把原因记进报告：否则"全绿"的报告会掩盖真实的中断
    Add-Check '脚本执行完成' $false ("中断：" + $_.Exception.Message)
    Write-Host ("`n脚本中断：{0}" -f $_.Exception.Message) -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
}
finally {
    Write-Step '10. 汇总'
    $failed = @($script:Checks | Where-Object { -not $_.ok })
    $report = Join-Path $OutDir 'ui-check-report.txt'
    $lines = @()
    $lines += "DSH Remote v2 · Android 真机 UI 检查报告"
    $lines += "时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    $lines += "设备：$Serial   中继（夹具）：$RelayUrl   包：$Package"
    $lines += ("通过 {0} / 共 {1}" -f ($script:Checks.Count - $failed.Count), $script:Checks.Count)
    $lines += ''
    foreach ($check in $script:Checks) {
        $flag = 'FAIL'
        if ($check.ok) { $flag = 'PASS' }
        $lines += ("[{0}] {1} — {2}" -f $flag, $check.name, $check.detail)
    }
    $lines += ''
    $lines += '截图：'
    Get-ChildItem $ShotDir -Filter '*.png' -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object {
        $lines += ("  {0}  ({1} 字节)" -f $_.Name, $_.Length)
    }
    [System.IO.File]::WriteAllLines($report, $lines, [System.Text.UTF8Encoding]::new($false))
    Write-Host "报告：$report"

    Stop-Fixture
    Exit-E2ELock

    $script:ExitCode = 0
    if ($failed.Count -gt 0) {
        Write-Host ("`n有 {0} 项失败" -f $failed.Count) -ForegroundColor Red
        $script:ExitCode = 1
    }
    else {
        Write-Host "`n全部检查通过" -ForegroundColor Green
    }
}

exit $script:ExitCode
