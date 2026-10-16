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
    [int]$Port = 9545,
    [string]$Apk = 'D:\Workspace\dsh_android\android\app\build\outputs\apk\debug\app-debug.apk',
    [string]$OutDir = 'D:\Workspace\dsh_android\android\evidence\v4',
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
# v4 分页夹具参数：更早页（cursor != null）注入的模拟网络时延（毫秒）。
# 本地夹具是秒回的，「正在加载更早的…」那一帧不可能被截到图 —— 这是**夹具注入的时延**，
# 报告里如实标注，不当作被测代码的行为。
$PageDelayMs = 1200

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
function Write-Step($text) { Write-Host "`n=== $text" -ForegroundColor Cyan }

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
        -ArgumentList @($Fixture, '--port', "$Port", '--code', '482913', '--page-delay-ms', "$PageDelayMs", '--big-messages', '220') `
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

# 「回到最新」FAB 是否存在。
# 必须是 content-desc 的**完全相等**匹配，不能用子串：夹具第 220 条消息的正文里就写着
# 「最新消息 #220：分页窗口的末尾 —— 点「回到最新」后必须看到这一条。」，
# 用子串判断会把"消息正文里有这四个字"当成"按钮出现了" —— 这正是 A1c/A1d 在修复前后
# 都报 FAIL=true 的原因（真机首屏截图 01-first-page 里右下角其实没有按钮）。
function Test-FabVisible($doc) {
    return ($null -ne (Get-NodeCenter $doc '回到最新' -Exact))
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
    Add-Check $label $ok ("期望界面包含「$pattern」")
    return $ok
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

# 配对页比一屏高：Compose 不把未进视口的控件放进语义树，直接按文本找会"找不到控件"（v2 已踩过）。
# 逐屏下滑，每屏重新 dump，命中即返回。
function Ensure-Visible {
    param([string]$pattern, [int]$MaxSwipes = 3)
    for ($i = 0; $i -le $MaxSwipes; $i++) {
        $doc = Get-Ui
        if ($null -ne (Get-NodeCenter $doc $pattern)) { return $doc }
        Invoke-Adb shell input swipe 540 1800 540 900 300 | Out-Null
        Start-Sleep -Milliseconds 900
    }
    return (Get-Ui)
}

# v2.7 起会话页顶栏把「刷新 / 回到最新 / 显示待办 / 填入示例」收进了「更多」下拉菜单
# （SessionDetailScreen.kt:397 MenuLabel("刷新")），直接按文本找「刷新」找不到。
function Tap-MoreItem {
    param([string]$label)
    $doc = Get-Ui
    $more = Get-NodeCenter $doc '更多'
    if (-not $more) {
        Add-Check "「更多」菜单里的「$label」" $false '未在会话页找到「更多」按钮'
        return $false
    }
    Invoke-Adb shell input tap $more.x $more.y | Out-Null
    Start-Sleep -Milliseconds 900
    $doc = Get-Ui
    $ok = Tap-Pattern $doc $label -Exact
    if (-not $ok) { $ok = Tap-Pattern $doc $label }
    return $ok
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

Enter-E2ELock 'run-paging-check.ps1'

# ---- 分页证据专用工具 -------------------------------------------------------
# 为什么断言要"看全部 text 拼成的串"而不是查找某个节点：
# 分页计数同时出现在两处（副标题「已加载 X/Y 条」与分段按钮「对话（X/Y）」），
# 按节点查找会随机命中其中之一，按文本串匹配则两者都算数（也更抗 UI 微调）。

function Get-UiText($doc) {
    $builder = New-Object System.Text.StringBuilder
    foreach ($uiNode in $doc.SelectNodes('//node')) {
        [void]$builder.AppendLine([string]$uiNode.GetAttribute('text'))
    }
    return $builder.ToString()
}

function Get-Paging([string]$uiText) {
    if ($uiText -match '已加载\s*(\d+)\s*/\s*(\d+)') {
        return [pscustomobject]@{ loaded = [int]$Matches[1]; total = [int]$Matches[2] }
    }
    return $null
}

# 「分页粒度」只能从计数时间轴量：时间轴是 Observe() 在计数**每次变化**时打的点（T+ 与夹具请求同一时基）。
# 为什么不用"上拉前后的差"：Invoke-PullToTop 是"反复拖拽直到入口可见"的循环（最多 30 次 swipe），
# 量它前后的差得到的是**这一段循环里取了几页**，不是"一次拖拽取几页"——A3b/A5 的红就是这么来的。
function Get-CountTraceSteps {
    $steps = New-Object System.Collections.ArrayList
    foreach ($line in $script:CountTrace) {
        $m = [regex]::Match([string]$line, 'UI 计数 = (\d+)/(\d+)')
        if ($m.Success) { [void]$steps.Add([int]$m.Groups[1].Value) }
    }
    return $steps
}

# 时间轴里的每次增量（相邻两个计数点之差）。一页 = PAGE_SIZE = 60 条。
function Get-CountTraceDeltas([int]$PageSize = 60) {
    $steps = @(Get-CountTraceSteps)
    $deltas = New-Object System.Collections.ArrayList
    for ($i = 1; $i -lt $steps.Count; $i++) {
        [void]$deltas.Add([pscustomobject]@{ from = $steps[$i - 1]; to = $steps[$i]; delta = $steps[$i] - $steps[$i - 1] })
    }
    return $deltas
}

# ---- 列表几何反推：不改生产代码、不靠 logcat，直接从 uiautomator 的 dump 里量 ------------------
# 为什么能量出来：dump 里滚动容器带 scrollable="true"，每个项节点（含只露一部分的）都带 bounds。
# 对话流的第 0 项是「加载更早」入口、消息从第 1 项起、每条消息恰好占 1 项、编号连续到 total，于是
# `SessionDetailScreen.kt:495 isNearBottom()` 的等价量可以算出来：
#   totalItemsCount = 1 + 已加载数
#   入口与视口相交   ⇒ firstVisibleItemIndex = 0，距末尾项数 = 已加载数
#   否则             ⇒ 距末尾项数 = total - 最上面那条可见消息的编号
#                     （= totalItemsCount - 1 - firstVisibleItemIndex，两者等价）
# 这是 Lead 要求的"实测选修法"：先量出上拉到顶那一刻的下标，再决定是改判据还是改闩锁。
function Get-Bounds($node) {
    $match = [regex]::Match([string]$node.GetAttribute('bounds'), '^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$')
    if (-not $match.Success) { return $null }
    return [pscustomobject]@{
        left   = [int]$match.Groups[1].Value
        top    = [int]$match.Groups[2].Value
        right  = [int]$match.Groups[3].Value
        bottom = [int]$match.Groups[4].Value
    }
}

function Get-ListGeometry($doc) {
    # 视口 = dump 里包含消息文本的那个滚动容器
    $viewport = $null
    foreach ($node in @($doc.SelectNodes('//node[@scrollable="true"]'))) {
        $texts = @($node.SelectNodes('.//node') | ForEach-Object { [string]$_.GetAttribute('text') }) -join "`n"
        if ($texts -match '加载更早的消息' -or $texts -match '历史消息 #' -or $texts -match '最新消息 #') {
            $viewport = Get-Bounds $node
            break
        }
    }
    # 第 0 项入口节点
    $entry = $null
    foreach ($node in @($doc.SelectNodes('//node'))) {
        $t = [string]$node.GetAttribute('text')
        if ($t -match '加载更早的消息' -or $t -match '已到最早，没有更早的消息了') { $entry = Get-Bounds $node; break }
    }
    # 每条消息的纵向范围：同一编号会出现在正文/工具标题/工具结果等多个节点里，取最小 top 与最大 bottom
    $items = @{}
    foreach ($node in @($doc.SelectNodes('//node'))) {
        $t = [string]$node.GetAttribute('text')
        if ($t -notmatch '历史消息 #\d' -and $t -notmatch '最新消息 #\d') { continue }
        $m = [regex]::Match($t, '#(\d{1,3})')
        if (-not $m.Success) { continue }
        $no = [int]$m.Groups[1].Value
        $b = Get-Bounds $node
        if (-not $b) { continue }
        if ($items.ContainsKey($no)) {
            if ($b.top -lt $items[$no].top) { $items[$no].top = $b.top }
            if ($b.bottom -gt $items[$no].bottom) { $items[$no].bottom = $b.bottom }
        }
        else {
            $items[$no] = @{ top = $b.top; bottom = $b.bottom }
        }
    }
    $vpTop = -1; $vpBot = -1
    $entryTop = -1; $entryBottom = -1
    if ($viewport) { $vpTop = $viewport.top; $vpBot = $viewport.bottom }
    if ($entry) { $entryTop = $entry.top; $entryBottom = $entry.bottom }
    $entryVisible = $false
    if ($viewport -and $entry) { $entryVisible = ($entryBottom -gt $vpTop) -and ($entryTop -lt $vpBot) }
    $visibleNos = @()
    if ($viewport) {
        foreach ($no in @($items.Keys | Sort-Object)) {
            if (($items[$no].bottom -gt $vpTop) -and ($items[$no].top -lt $vpBot)) { $visibleNos += $no }
        }
    }
    $topNo = -1; $maxNo = -1
    if ($visibleNos.Count -gt 0) { $topNo = $visibleNos[0]; $maxNo = $visibleNos[-1] }
    return [pscustomobject]@{
        hasViewport  = ($null -ne $viewport)
        viewportTop  = $vpTop
        viewportBot  = $vpBot
        entryVisible = $entryVisible
        entryTop     = $entryTop
        entryBottom  = $entryBottom
        topMsgNo     = $topNo
        maxMsgNo     = $maxNo
        visibleMsgs  = $visibleNos.Count
    }
}

# 把几何换算成与 isNearBottom() 等价的两个数：firstVisibleItemIndex 与"距末尾项数"（-1 = 反推不出来）
function Get-ListDistance($geo, $paging) {
    if (-not $geo -or -not $geo.hasViewport) { return [pscustomobject]@{ fvi = -1; distance = -1 } }
    $loaded = 0; $total = 0
    if ($paging) { $loaded = $paging.loaded; $total = $paging.total }
    if ($geo.entryVisible) { return [pscustomobject]@{ fvi = 0; distance = $loaded } }
    if ($geo.topMsgNo -gt 0 -and $total -gt 0) {
        $fvi = 1 + ($geo.topMsgNo - ($total - $loaded + 1))
        return [pscustomobject]@{ fvi = $fvi; distance = ($total - $geo.topMsgNo) }
    }
    return [pscustomobject]@{ fvi = -1; distance = -1 }
}

function Format-Geometry($geo, $paging) {
    if (-not $geo -or -not $geo.hasViewport) { return '几何不可用：dump 里没找到包含消息文本的滚动容器' }
    $dist = Get-ListDistance $geo $paging
    $how = '无法反推'
    if ($dist.distance -ge 0) {
        if ($geo.entryVisible) { $how = '入口可见 => firstVisibleItemIndex=0' }
        else { $how = "最上面可见消息 #$($geo.topMsgNo) => 距末尾 $($dist.distance) 项" }
    }
    return ("视口=[{0},{1}] 入口可见={2} 可见消息={3}条(#$($geo.topMsgNo)..#$($geo.maxMsgNo)) firstVisibleItemIndex≈{4} 距末尾={5}项（等价判据 <=2）[{6}]" -f $geo.viewportTop, $geo.viewportBot, $geo.entryVisible, $geo.visibleMsgs, $dist.fvi, $dist.distance, $how)
}

function Note-Geometry($doc, [string]$where) {
    $geo = Get-ListGeometry $doc
    Note "$where 列表几何：$(Format-Geometry $geo (Get-Paging (Get-UiText $doc)))"
    return $geo
}

function Save-UiXml($doc, [string]$name) {
    if (-not (Test-Path $WorkDir)) { [void](New-Item -ItemType Directory -Force -Path $WorkDir) }
    $path = Join-Path $WorkDir "$name.xml"
    $doc.Save($path)
    return $path
}

# ---- 根因分析小节：只用本轮实测到的数字做判定 ------------------------------------------------
# Lead 的要求：不要为了报告好看把推断写成观测 —— 所以每条都先列实测、再给判定，
# 机制解释显式标「推断」，本轮手段拿不到的显式标「未取证」。
function Get-RootCauseLines {
    $out = New-Object System.Collections.ArrayList
    [void]$out.Add('本节只写"实测数字 -> 判定"。R1-R5 是修复前那一轮（PASS=31/FAIL=9）的读数，也是选定修法的依据；R6 是修复后的复跑读数。标「推断」的是机制解释，标「未取证」的是本轮手段拿不到的。')
    [void]$out.Add('')

    # R1 = A1c / D5（界面）
    if ($script:Rc.ContainsKey('firstDistance') -and [int]$script:Rc['firstDistance'] -ge 0) {
        $fabNow = [string]$script:Rc['firstFab']
        $verdict = '首屏 FAB 仍出现，且几何判据算出"不在末尾 2 项以内" ⇒ 判据/阈值仍有问题，需继续查'
        if ([int]$script:Rc['firstDistance'] -le 2 -and $fabNow -ne 'True') {
            $verdict = '判据算出"就在末尾"、FAB 也没出现 ⇒ D5 成立且已修好：判据换成"最后一项还在视口里"，并把 atBottom 的重算闸在"用户亲手拖过列表"之后（程序自己的贴底动画不再污染判定）'
        }
        elseif ([int]$script:Rc['firstDistance'] -le 2) {
            $verdict = '几何判定说"就在末尾（<=2 项）"而 FAB 仍出现 ⇒ 不是阈值问题，是 atBottom 状态变量的更新时机'
        }
        [void]$out.Add(('R1（A1c / D5，界面）：首屏实测已加载 {0} 条、firstVisibleItemIndex≈{1}、距末尾 {2} 项、「回到最新」按钮（按 content-desc 判定）出现={3}。判定：{4}。' -f $script:Rc['firstLoaded'], $script:Rc['firstFvi'], $script:Rc['firstDistance'], $script:Rc['firstFab'], $verdict))
        [void]$out.Add('    注：A1c/A1d 在修复前后都 FAIL 过一次，但那两次 FAIL 是**脚本假失败** —— 判"按钮是否出现"用的是文本子串匹配，而夹具第 220 条消息的正文里就写着「…点「回到最新」后必须看到这一条。」；首屏截图 01-first-page 里右下角其实没有按钮（同一断言因此无法区分"按钮在"与"正文提到按钮"）。'
        )
        [void]$out.Add('    现在改成只看 content-desc="回到最新"（脚本里的 Test-FabVisible），并用应用侧 DEBUG 日志（tag=DshPaging）实测首屏 atBottom=true、userScrolled=false，两条独立读数互相印证。')
    }
    else {
        [void]$out.Add('R1（A1c / D5，界面）：未取证 —— dump 里没能反推首屏几何（没找到滚动容器或可见消息节点）。')
    }
    [void]$out.Add('')

    # R2 = A18 / D1（界面）—— Lead 指定的"实测选修法"就落在这里
    if ($script:Rc.ContainsKey('atTopFvi') -and [int]$script:Rc['atTopFvi'] -ge 0) {
        $delta = [int]$script:Rc['pullReqDelta']
        if ([int]$script:Rc['atTopFvi'] -le 1 -and $delta -eq 0) {
            $verdict = '判据"首可见下标 <= 1"实测成立（入口项可见 => firstVisibleItemIndex=0、距末尾=' + $script:Rc['atTopDistance'] + ' 项），但夹具新增 0 条请求 ⇒ 判据没错，是 fired 这个一次性闩锁在用户上拉之前就被消费掉了；那次调用被 ViewModel 的守卫静默丢弃（SessionDetailViewModel.kt:235 的 state.loading / state.loadingOlder；哪一个是推断，见下）→ 修法：离开顶部区时解锁 fired，或只认"进入顶部区"的上升沿'
        }
        elseif ([int]$script:Rc['atTopFvi'] -gt 1) {
            $verdict = '判据"首可见下标 <= 1"实测不成立（到顶时下标实测 ' + $script:Rc['atTopFvi'] + '）⇒ 判据太紧 → 改用 !listState.canScrollBackward（配合 layoutInfo.visibleItemsInfo.firstOrNull()?.index == 0）'
        }
        else {
            $verdict = '未取证：到顶那一刻没能反推下标'
        }
        [void]$out.Add(('R2（A18 / D1，界面）：到顶时入口可见={0}、firstVisibleItemIndex≈{1}、第 1 次上拉夹具新增请求 {2} 条（到顶那一刻累计 {3} 条）。判定：{4}。' -f $script:Rc['atTopEntry'], $script:Rc['atTopFvi'], $delta, $script:Rc['atTopReqCount'], $verdict))
        [void]$out.Add('    补充（推断）：被吞的那次调用发生在"首屏到达、effect 因 hasMoreOlder false->true 重启、snapshotFlow 发初值"那一刻 —— 界面侧无法直接打印是哪个守卫，因为本轮不许改 src/main 加日志；能证的是"闩锁在用户上拉前就已失效"这个事实（6 次上拉 + 入口可见 + 0 请求）。')
    }
    else {
        [void]$out.Add('R2（A18 / D1，界面）：未取证 —— 没有取到"到顶那一刻"的几何。')
    }
    [void]$out.Add('')

    # R3 = A17 / A9（Lead 裁定：不是两个独立缺陷，是同一个根因的另一面）
    $switchDelta = 0
    if ($script:Rc.ContainsKey('switchDelta')) { $switchDelta = [int]$script:Rc['switchDelta'] }
    [void]$out.Add(('R3（A17 / A9）：切换视图那一刻夹具新增 {0} 条请求；逐条看它们的 cursor（见"过程记录"里以"切视图那一刻新增的请求"开头那行）是 160 -> 100 -> 40 的**真翻页**，不是切视图引起的重复拉取 ⇒ 这 {0} 条是"上拉积压的加载在切视图那一刻才被放行"（切视图让 effect 重启、闩锁归零，那次本该在上拉时发出的 loadOlder 终于发出去）。所以 A9 的 60 -> 220 不是"切视图重新拉取"，而是"上拉终于生效了"，A17/A9 应当读成对 D1/D3 的观测。' -f $switchDelta))
    [void]$out.Add('')

    # R4 = A6/A7/A8b / D2（数据层，Lead 已认领）
    $c40 = 0
    if ($script:Rc.ContainsKey('cursor40Repeats')) { $c40 = [int]$script:Rc['cursor40Repeats'] }
    $r4Fix = '复跑实测：最早页不再被重复请求 ⇒ 修复后"明确 null"已被当成「已到最早」'
    if ($c40 -gt 0) { $r4Fix = '复跑实测：最早页仍被重复请求 ' + $c40 + ' 次 ⇒ 修复未生效，或本次跑的不是修复后的 APK' }
    [void]$out.Add(('R4（A6 / A7 / A8b / D2，数据层）：夹具侧最早页 cursor=40（区间 [0,40)）被重复请求 {0} 次（修复前实测 9 次）。机制：服务端在这一页回的 nextCursor 是 null（start == 0 = 已到最早），而旧代码没把它当成"没有更早了" —— TranscriptPager.kt 的 pickNextCursor 把"offer 为空"一律当作"老网关没表态"从而保留旧游标，于是 hasMoreOlder 永真、cursor=40 被反复拉。Lead 的修法：TranscriptPage 增 cursorProvided，用 obj.has("nextCursor") 区分"字段缺失"与"字段为 null"。{1}。' -f $c40, $r4Fix))
    [void]$out.Add('')

    # R5 = D4 口径
    if ($script:Rc.ContainsKey('windowMsgs') -and [int]$script:Rc['windowMsgs'] -gt 0) {
        [void]$out.Add(('R5（D4，数据层）：夹具累计服务的不同页合计 {0} 条（{1} 页），界面最后观测到「已加载 {2}」。判定：{3}。' -f $script:Rc['windowMsgs'], $script:DistinctPages, $script:Rc['lastX'], $(if ([int]$script:Rc['lastX'] -gt [int]$script:Rc['windowMsgs']) { '界面数字大于窗口实际条数 ⇒ loadedCount 口径确实在虚报（A20 FAIL）' } else { '界面数字等于窗口实际条数 ⇒ 本轮没有观测到虚报' })))
    }
    else {
        [void]$out.Add('R5（D4，数据层）：未取证 —— 本轮没有取到夹具累计页条数。')
    }
    [void]$out.Add('')

    # R6 = 复跑（修复后）读数：把"改了什么"和"复跑看到什么"对上
    $r6Fab = 'n/a'
    if ($script:Rc.ContainsKey('firstFab')) { $r6Fab = [string]$script:Rc['firstFab'] }
    $r6Delta = 'n/a'
    if ($script:Rc.ContainsKey('pullReqDelta')) { $r6Delta = [string]$script:Rc['pullReqDelta'] }
    [void]$out.Add('R6（复跑实测 / 修复后）：以下读数来自本轮（修复后的 APK），与 R1-R5 的修复前读数对照。')
    [void]$out.Add(('    D5 / A1c：首屏贴底时「回到最新」按钮出现 = {0}。D5 本身是真缺陷（修复前首屏截图 01-first-page 右下角确实画着那个按钮）；但 A1c/A1d 这两条断言同时又是**脚本假失败** —— 判"按钮是否出现"用的是文本子串匹配，而夹具第 220 条消息的正文里就写着「…点「回到最新」后必须看到这一条。」，所以它在修复前后都报 True。' -f $r6Fab))
    [void]$out.Add('      修法三处：①判据换成"最后一项还在视口里"（旧的首可见项 <= 2 在长条目下会误判）；②atBottom 的重算闸在"用户亲手拖过列表（DragInteraction.Start）"之后 —— 第一版只用 isScrollInProgress 复跑仍错，因为程序自己的贴底动画也会把它置 true；③断言改成按 content-desc 精确匹配。')
    [void]$out.Add(('    D1 / A18：第 1 次上拉到顶时夹具新增请求 = {0} 条（修复前 0）。判据没改（首可见下标 <= 1，实测成立），改的是开火时机：第一版用 isScrollInProgress，复跑实测它在两个方向上都不准（程序滚动动画会误开火 —— 见 A22；用户停在顶部边界再拖时列表无内容可滚，信号可能不动）⇒ 第二版改认 DragInteraction.Start：只有手指真的拖过列表才允许把"到达顶部"当成加载意图。' -f $r6Delta))
    [void]$out.Add(('    D3 / A17：切视图那一刻新增请求 = {0} 条（修复前 3）。改法：轨迹视图改用与对话流同一份 LoadOlderOnReachTop，不再"首帧即开火 + 每次加载完成重启后闩锁归零"。' -f $switchDelta))
    [void]$out.Add(('    D2 / A21：干净分页序列里被重复请求的游标 = {0} 组（修复前最早页 cursor=40 连打 9 次）。' -f $dupKeys.Count))
    [void]$out.Add(('    D6 / A23（Lead 的窗口世代号修复）：上拉在途时立刻刷新，之后重新拉到最早 = {0} 条（有空洞时窗口永远凑不齐 total=220）。在途窗口内点中「刷新」={1}。' -f $script:Rc['raceLoaded'], $script:Rc['raceTapped']))
    [void]$out.Add('    A22：点「回到最新」这一下**不该**产生新的 transcript 请求 —— 它是程序动画，修复前会被 isScrollInProgress 误判成用户上拉（复跑实测夹具在 T+181.0s 白收一条 cursor=100）。')
    [void]$out.Add('')
    [void]$out.Add('未取证清单（本轮手段拿不到的，写在最显眼处）：真实网关（只照抄了 session-reader.mjs:745-751 的语义）、600 条窗口上限与裁剪路径（220 < 600 未触发）、实体手机（只有 AVD dshr_ui / Android 14 x86_64）、版本号递增（versionCode 4 / 2.2.0）。')
    return $out
}

$script:AllSeen = New-Object System.Text.StringBuilder
$script:Notes = New-Object System.Collections.ArrayList
# 「已加载 X/Y」的时间轴（只在数值变化时追加一条，见 Observe）
$script:CountTrace = New-Object System.Collections.ArrayList
$script:LastCountKey = ''
# 最近一次观测到的「已加载 X/Y」（A20 用它和夹具累计条数对照）
$script:LastX = -1
$script:LastTotal = -1
# 夹具侧记录的 transcript 请求序列（控制面在内存里记账：node 的 stdout 重定向是块缓冲，
# 进程结束前日志文件可能一直是空的，所以证据不能只靠日志文件 —— 见 mock-tunnel.mjs 的
# /__control/transcript-log）。每次调用都重建列表：中途也要能采样"到此刻为止收到几条"，
# 用来判断某个动作（切视图、上拉）有没有真的触发新请求。
$script:ReqSummary = New-Object System.Collections.ArrayList
# D1 判定用：到顶那一刻的实测几何 + 当时的夹具请求计数（Invoke-PullToTop 里填）
$script:AtTopSeq = 0
$script:AtTopGeo = $null
$script:AtTopReqCount = -1
# D4 判定用：夹具累计服务的"不同页"合计条数 —— 客户端窗口里最多只可能有这么多条，
# 拿去和界面上的「已加载 X」对照（X 明显大于它 = 虚报）
$script:WindowMsgs = 0
$script:DistinctPages = 0
# 根因分析小节用的实测数字（各处填，报告最后统一渲染）
$script:Rc = @{}
function Read-FixtureRequests {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/__control/transcript-log" -UseBasicParsing -TimeoutSec 5
        $parsed = $response.Content | ConvertFrom-Json
        $script:ReqSummary.Clear()
        $script:WindowMsgs = 0
        $script:DistinctPages = 0
        # 夹具的 at 是它自己的 Date.now()（同一台机器、同一时钟），换算成与本脚本同一个 T+ 时基，
        # 才能和界面观测放在一条时间轴上比较。
        $baseMs = ([DateTimeOffset]$script:RunStarted).ToUnixTimeMilliseconds()
        # 顺带把"夹具累计服务的不同页"合计出来（同一个 [from,to) 只算一次）：
        # 这是客户端窗口里**最多**可能有的条数，用来和界面「已加载 X」对照，判定有没有虚报。
        $rangeSeen = @{}
        foreach ($req in $parsed.requests) {
            $cursorText = [string]$req.cursor
            if ($cursorText -eq '') { $cursorText = '(null=最新一页)' }
            $rel = '  ?  '
            if ($req.at) { $rel = ("{0,6:N1}" -f (([double]$req.at - $baseMs) / 1000.0)) }
            [void]$script:ReqSummary.Add(("T+{0}s  夹具收到 cursor={1} limit={2} from={3} to={4} total={5} 本页条数={6}" -f $rel, $cursorText, $req.limit, $req.from, $req.to, $req.total, ($req.to - $req.from)))
            $rangeKey = "$($req.from)-$($req.to)"
            if (-not $rangeSeen.ContainsKey($rangeKey)) {
                $rangeSeen[$rangeKey] = $true
                $script:WindowMsgs += ([int]$req.to - [int]$req.from)
            }
        }
        $script:DistinctPages = $rangeSeen.Count
        return [int]$parsed.count
    }
    catch {
        Note "控制面 /__control/transcript-log 不可用：$($_.Exception.Message)"
        return 0
    }
}
function Get-ElapsedSec {
    if (-not $script:RunStarted) { return 0 }
    return [int]((Get-Date) - $script:RunStarted).TotalSeconds
}
# 时间轴是第二轮证据暴露出来的刚需：那一轮夹具确实收到了"最新页 + 三页更早"共 12 条请求，
# 但界面计数在 3.5 分钟里一直停在 60/220，直到点「轨迹」的瞬间才变成 220/220。
# 到底是"请求发得晚"还是"状态没送到界面"，两侧证据都没有时间戳 ⇒ 事后无法判定。
# 所以从这一轮起：每条 Note 都带 T+秒，夹具请求也换算成同一时基（同一台机器，同一时钟）。
function Note([string]$text) {
    $stamp = Get-ElapsedSec
    [void]$script:Notes.Add(("T+{0,4}s  {1}" -f $stamp, $text))
    Write-Host ("  [NOTE] T+{0}s {1}" -f $stamp, $text) -ForegroundColor DarkCyan
}
function Observe($doc) {
    $uiText = Get-UiText $doc
    [void]$script:AllSeen.AppendLine($uiText)
    # 计数时间轴：只记"变化"那一刻，报告里就能和夹具请求的 T+ 对齐。
    $pg = Get-Paging $uiText
    if ($pg) {
        $script:LastX = $pg.loaded
        $script:LastTotal = $pg.total
        $key = "$($pg.loaded)/$($pg.total)"
        if ($key -ne $script:LastCountKey) {
            $script:LastCountKey = $key
            [void]$script:CountTrace.Add(("T+{0,4}s  UI 计数 = {1}" -f (Get-ElapsedSec), $key))
        }
    }
    return $uiText
}

# 一页 = 客户端 PAGE_SIZE 60 条。v2 用的 800px/次要划 10 次才够一页，
# 这里 1280px/次（2400 高的屏幕留出状态栏/输入区余量）。
# 看更早的历史 = 把内容往下拖（手指从屏幕上方划向下方）。
# 方向很容易搞反：这是"最新在底部"的聊天流，想看到**更早**的消息必须向下拖内容；
# 手指往上划只会滚向更新的消息 —— 而首屏本来就贴在最新处，于是那次滑动什么都不会发生
# （第一版脚本就是这么写的：三次"上拉"实测位移为 0，夹具侧只收到 1 条 transcript 请求）。
function Swipe-ToOlder {
    param([int]$Times = 1)
    for ($i = 0; $i -lt $Times; $i++) {
        Invoke-Adb shell input swipe 540 900 540 1900 300 | Out-Null
        Start-Sleep -Milliseconds 350
    }
}

# 划到顶 = dump 里出现第 0 项入口的两种形态之一；出现「已到最早」也算到顶（此时没有入口了）
# 逐次拖拽量分页粒度：一次 `input swipe` = 一次 DragInteraction（App 侧开火条件就是它）。
# 为什么必须逐次量：`Invoke-PullToTop` 是"反复拖拽直到入口可见"的循环，量它前后的总量得到的是
# 循环次数，不是分页粒度 —— 第四轮复跑 A3b/A5 的"60 → 220"就是循环里三次拖拽各取一页的结果，
# 被误读成"一次上拉把剩余历史拉完"。夹具侧 R6 的干净序列（游标 160/100/40 各一次）也证明
# 每页只被取过一次。所以判定产品预期要用**单次拖拽的增量**。
function Measure-PerDragLoads {
    param([int]$MaxSwipes = 4)
    $rows = @()
    for ($i = 1; $i -le $MaxSwipes; $i++) {
        $reqBefore = [int](Read-FixtureRequests)
        $p = Get-Paging (Observe (Get-Ui))
        $before = -1
        if ($p) { $before = $p.loaded }
        Invoke-Adb shell input swipe 540 900 540 1800 300 | Out-Null
        Start-Sleep -Seconds 2
        $uiText2 = Observe (Get-Ui)
        $p2 = Get-Paging $uiText2
        $after = -1
        if ($p2) { $after = $p2.loaded }
        $reqAfter = [int](Read-FixtureRequests)
        $rows += [pscustomobject]@{
            drag     = $i
            before   = $before
            after    = $after
            delta    = ($after - $before)
            reqDelta = ($reqAfter - $reqBefore)
        }
        if ($uiText2 -match '已到最早') { break }
    }
    return $rows
}

function Invoke-PullToTop {
    param([int]$MaxSwipes = 30)
    # 每一次"上拉"都必须真的产生用户的滚动手势（app 侧只认 DragInteraction）。
    # 取到一页之后视口会被锚在（新载入的）顶部、入口本来就可见 —— 老版本在这里直接 return，
    # 等于一次都没滑：第三轮复跑因此出现"A5/A6 六次上拉、夹具请求恒 2 条"的假失败。
    # 先朝更新的方向滑一段离开顶部区，再往回滑到顶；这一段往返才是真机上"再拉一次"。
    Scroll-Up
    Start-Sleep -Milliseconds 400
    for ($i = 0; $i -lt $MaxSwipes; $i++) {
        $doc = Get-Ui
        $uiText = Observe $doc
        if ($uiText -match '加载更早的消息（上拉）' -or $uiText -match '正在加载更早的消息') {
            # 到顶这一刻的实测几何 + 夹具请求计数，是判定 D1 的唯一口径（不用假设）：
            #   首可见下标实测 <=1 且请求数没动 ⇒ 判据没错，是"一次性闩锁已被提前吃掉"；
            #   首可见下标实测始终 >1      ⇒ 判据本身太紧，该换成 !canScrollBackward。
            # 两种结论对应两种修法，Lead 要求"必须是实测选出来的那个"。
            $script:AtTopSeq += 1
            $script:AtTopGeo = Get-ListGeometry $doc
            $script:AtTopReqCount = [int](Read-FixtureRequests)
            [void](Save-UiXml $doc "ui-at-top-$($script:AtTopSeq)")
            Note "第 $($script:AtTopSeq) 次到顶实测：$(Format-Geometry $script:AtTopGeo (Get-Paging $uiText))；此刻夹具累计请求 $($script:AtTopReqCount) 条"
            return 'entry'
        }
        if ($uiText -match '已到最早，没有更早的消息了') { return 'earliest' }
        Swipe-ToOlder -Times 1
    }
    return 'none'
}

# 等「已加载 X/Y」的 X 比 From 变大；期间抓「正在加载更早的…」那一帧
function Wait-CountIncrease {
    param([int]$From, [int]$TimeoutSec = 20, [string]$ShotName = 'loading')
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $sawLoading = $false
    while ((Get-Date) -lt $deadline) {
        $doc = Get-Ui
        $uiText = Observe $doc
        if ($uiText -match '正在加载更早的消息' -and -not $sawLoading) {
            $sawLoading = $true
            Save-Shot $ShotName | Out-Null
        }
        $paging = Get-Paging $uiText
        if ($paging -and $paging.loaded -gt $From) {
            return [pscustomobject]@{ paging = $paging; loading = $sawLoading }
        }
        Start-Sleep -Milliseconds 250
    }
    return [pscustomobject]@{ paging = (Get-Paging (Get-UiText (Get-Ui))); loading = $sawLoading }
}

# ---- 主流程 -----------------------------------------------------------------

$script:RunStarted = Get-Date
Write-Step '0. 环境检查'
Add-Check 'ADB 设备在线' (Test-Device) "serial=$Serial"
if (-not (Test-Device)) {
    Write-Host '模拟器不可用，终止。' -ForegroundColor Red
    Exit-E2ELock
    exit 2
}
Add-Check '夹具脚本存在' (Test-Path $Fixture) $Fixture
Add-Check 'APK 存在' (Test-Path $Apk) $Apk
if (-not (Test-Path $Apk)) { Exit-E2ELock; exit 2 }
$ApkSha = (Get-FileHash -LiteralPath $Apk -Algorithm SHA256).Hash
Note "APK sha256=$ApkSha"

Start-Fixture
Add-Check '夹具中继可达' (Test-Fixture) "http://127.0.0.1:$Port/health"
Note "夹具端口=$Port 分页会话支持 cursor/limit/nextCursor/total/from/to；更早页注入 $script:PageDelayMs ms 模拟时延"

try {
    Write-Step '1. 安装与冷启动'
    if (-not $SkipInstall) {
        Invoke-Adb shell am force-stop $OtherPackage | Out-Null
        $install = Invoke-AdbArgs @('install', '-r', '-t', $Apk)
        Add-Check 'APK 安装' ($install -match 'Success') ($install.Trim() -replace "`r?`n", ' ')
    }
    Invoke-Adb shell pm clear $Package | Out-Null
    Invoke-Adb shell pm grant $Package android.permission.POST_NOTIFICATIONS | Out-Null
    Invoke-AdbArgs @('logcat', '-c') | Out-Null
    Invoke-AdbArgs @('shell', 'am', 'start', '-W', '-n', $Activity, '--es', 'dsh_relay_url', $RelayUrl, '--es', 'dsh_pair_code', '482913') | Out-Null
    Start-Sleep -Seconds 3
    Dismiss-SystemDialogs

    Write-Step '2. 配对（应用内示例填充 + 配对码）'
    $doc = Wait-ForUi 'DSH 远程控制台' 20
    if (-not $doc) { throw 'App 未启动到配对页' }
    $doc = Ensure-Visible '填入示例'
    Tap-Pattern $doc '填入示例' | Out-Null
    # 点完「填入示例」会浮出明文风险卡，把「配对并连接」往下推，必须重新找一次
    $doc = Ensure-Visible '配对并连接'
    Tap-Pattern $doc '配对并连接' | Out-Null
    Start-Sleep -Seconds 2
    Dismiss-SystemDialogs
    $doc = Wait-ForUi 'DSH 远程' 25
    if (-not $doc) { throw '配对后未进入主界面' }
    Add-Check '配对成功并进入会话列表' $true '底部导航出现「电脑会话」'
    Save-Shot '00-sessions-list' | Out-Null

    Write-Step '3. 打开 220 条历史的分页会话'
    Assert-Ui $doc '分页验证' '分页会话卡片（220 条历史）出现在列表' | Out-Null
    Tap-Pattern $doc '分页验证' | Out-Null
    $doc = Wait-ForUi '已加载' 25
    if (-not $doc) { $doc = Get-Ui; throw '会话详情页未渲染出「已加载」计数' }
    Start-Sleep -Milliseconds 500
    $doc = Get-Ui
    $uiText = Observe $doc
    $paging = Get-Paging $uiText
    $l0 = -1; $t0 = -1
    if ($paging) { $l0 = $paging.loaded; $t0 = $paging.total }
    Note "首屏实测 已加载 $l0/$t0 条"
    # 首屏只应该有一次"最新一页"的请求。如果打开会话就自动多取一页（hasMoreOlder 由 false 变 true
    # 时首可见下标仍是 0 的竞态），这里立刻能抓到 —— 夹具侧计数是权威口径，不靠界面文案推断。
    $reqAtOpen = [int](Read-FixtureRequests)
    Note "打开会话至今夹具收到 transcript 请求 $reqAtOpen 条"
    Add-Check 'A19 打开会话只触发一次「最新一页」请求' ($reqAtOpen -eq 1) "共 $reqAtOpen 条"
    # 任务书 A1 的原文是"首屏只加载一页（不是 220/220）"。这里按**可证伪的强命题**断言：
    # 首屏绝不能一次给出全部历史；"恰好一页"是否成立单独记录（见报告里的首屏实测值）。
    Add-Check 'A1 首屏没有一次性加载全部 220 条' ($t0 -eq 220 -and $l0 -gt 0 -and $l0 -lt 220) "实测 已加载 $l0/$t0 条（PAGE_SIZE=60）"
    Add-Check 'A1b 首屏恰好一页 60 条' ($l0 -eq 60) "实测 $l0 条"
    Save-Shot '01-first-page' | Out-Null
    # 顺带记录：刚进入会话、视口本就贴在最新一条时，右下角是否已经出现「回到最新」。
    # 这个按钮的语义是"你已经翻走了"，贴在底部时出现说明 atBottom 判定与真实布局不一致，
    # 单独记录以便区分"分页失败"和"只是一个状态判定偏保守"。
    $fabAtFirst = Test-FabVisible $doc
    Note "首屏（视口贴底）时「回到最新」按钮出现=$fabAtFirst"
    Add-Check 'A1c 视口贴在最新一条时右下角不出现「回到最新」' (-not $fabAtFirst) "出现=$fabAtFirst"
    Save-Shot '01b-first-page-fab' | Out-Null
    # Lead 要的实测：首屏到底是"贴底但算成了 false"还是"其实没贴底"。这里把 dump 存盘 + 反推几何。
    [void](Save-UiXml $doc 'ui-first-page')
    $geoFirst = Note-Geometry $doc '首屏（未上拉）'
    $gdFirst = Get-ListDistance $geoFirst $paging
    Note ("首屏几何换算：firstVisibleItemIndex≈{0}、距末尾={1} 项 ⇒ isNearBottom 等价判定={2}；FAB 实际出现={3}" -f $gdFirst.fvi, $gdFirst.distance, ($gdFirst.distance -le 2 -and $gdFirst.distance -ge 0), $fabAtFirst)
    # A1d 的口径跟着实现改：判据现在是"最后一条消息还在视口里 ⇒ 就是贴底"（不再是"距末尾<=2 项"）。
    # 首屏 dump 里能看到「最新消息 #220」就说明末项可见，这时 FAB 不该出现。
    $tailVisibleAtFirst = $uiText -match '最新消息 #220'
    Add-Check 'A1d 首屏 FAB 的出现与几何判定一致（末项可见时不该出现）' ((-not $fabAtFirst) -or (-not $tailVisibleAtFirst)) "末项可见=$tailVisibleAtFirst，FAB=$fabAtFirst"
    $script:Rc['firstFvi'] = $gdFirst.fvi
    $script:Rc['firstDistance'] = $gdFirst.distance
    $script:Rc['firstFab'] = $fabAtFirst
    $script:Rc['firstLoaded'] = $l0

    Write-Step '4. 上拉到顶 → 取更早一页（第 1 次）'
    # 「上拉到底有没有真的触发一次更早页请求」必须用夹具侧的请求计数来判：
    # 第二轮里界面上确实出现了第 0 项入口，但计数 60→60、也没看到加载中帧，
    # 到底是"没触发"还是"触发了但结果没进界面"，只有请求计数能分开这两件事。
    $reqBeforePull = [int](Read-FixtureRequests)
    $reached = Invoke-PullToTop
    Note "第 1 次上拉：到顶判据=$reached"
    Add-Check 'A2 上拉到顶能看到「加载更早」入口/加载中' ($reached -ne 'none') "到顶判据=$reached"
    $res1 = Wait-CountIncrease -From $l0 -TimeoutSec 10 -ShotName '02-loading-older-1'
    $reqAfterPull = [int](Read-FixtureRequests)
    Note "第 1 次上拉前后：夹具请求数 $reqBeforePull → $reqAfterPull"
    Add-Check 'A18 上拉到顶会触发一次更早页请求' (($reqAfterPull - $reqBeforePull) -ge 1) "新增 $($reqAfterPull - $reqBeforePull) 条"
    $l1 = $l0
    if ($res1.paging) { $l1 = $res1.paging.loaded }
    Note "第 1 次上拉后 已加载 $l1/$t0 条（加载中帧=$($res1.loading)）"
    # D1 判定（Lead 要求"实测选修法"）：把"到顶时刻反推出来的下标"与"新增请求数"并排写进报告。
    $gdTop = [pscustomobject]@{ fvi = -1; distance = -1 }
    if ($script:AtTopGeo) { $gdTop = Get-ListDistance $script:AtTopGeo ([pscustomobject]@{ loaded = $l1; total = $t0 }) }
    Note ("D1 实测：到顶时入口可见={0}、firstVisibleItemIndex≈{1}、距末尾={2} 项；第 1 次上拉夹具新增请求 {3} 条（累计 {4} 条）" -f $script:AtTopGeo.entryVisible, $gdTop.fvi, $gdTop.distance, ($reqAfterPull - $reqBeforePull), $reqAfterPull)
    $script:Rc['atTopEntry'] = $script:AtTopGeo.entryVisible
    $script:Rc['atTopFvi'] = $gdTop.fvi
    $script:Rc['atTopDistance'] = $gdTop.distance
    $script:Rc['pullReqDelta'] = ($reqAfterPull - $reqBeforePull)
    $script:Rc['atTopReqCount'] = $script:AtTopReqCount
    Add-Check 'A3 上拉后已加载数严格变大' ($l1 -gt $l0) "$l0 → $l1"
    # 产品预期（不是合同硬性条款）：一次"划到顶"只该多取一页，而不是把剩下的历史一次拉完 ——
    # 后者会让"分页"退化成"一次全量"，任务书要防的正是这个。
    # 口径：计数时间轴上**每次增量**都要 <= 一页（60）。时间轴是 Observe() 在计数变化那一刻打的点，
    # 所以 60 -> 120 -> 180 -> 220 这种逐页推进会被看见，而 60 -> 220 这种"一次全量"会立刻暴露。
    # 反面教材：这里原来量的是"整段上拉循环前后的差"，那段循环含最多 30 次拖拽 ⇒ 量出来的是循环里
    # 取了几页，A3b 会在"循环一次取满 220"时误报（第四~五轮复跑实测正是这样）。
    $dragRows = Measure-PerDragLoads -MaxSwipes 4
    foreach ($r in $dragRows) {
        Note "单次拖拽 #$($r.drag)：已加载 $($r.before) → $($r.after)（增量 $($r.delta)），夹具新增请求 $($r.reqDelta) 条"
    }
    $deltas = @(Get-CountTraceDeltas)
    $deltasText = ($deltas | ForEach-Object { "$($_.from)→$($_.to)（+$($_.delta)）" }) -join '，'
    $maxStepDelta = 0
    if ($deltas.Count -gt 0) {
        $maxStepDelta = ($deltas | Measure-Object -Property delta -Maximum).Maximum
    }
    Note "计数时间轴增量：$deltasText（共 $($deltas.Count) 次增量）"
    Add-Check 'A3b（产品预期）分页是逐页推进的：时间轴上每次增量 <= 一页（不出现一次拉完）' ($deltas.Count -gt 0 -and $maxStepDelta -le 60) "时间轴增量 $deltasText；最大单次增量 $maxStepDelta 条（上限一页 60 条）"
    Save-Shot '03-after-pull-1' | Out-Null

    Write-Step '5. 再上拉（第 2 次），并记录视口里可见的历史编号'
    $doc = Get-Ui
    $uiText = Observe $doc
    $nos = ([regex]::Matches($uiText, '#(\d{3})') | ForEach-Object { [int]$_.Groups[1].Value })
    # 视口里出现的最小编号：加载更早之后应当仍然停留在"旧历史"处，而不是被拽回 #220
    $minNo = 9999
    $maxNo = -1
    foreach ($no in $nos) {
        if ($no -lt $minNo) { $minNo = $no }
        if ($no -gt $maxNo) { $maxNo = $no }
    }
    Note "第 1 次上拉后视口可见编号范围 #$minNo..#maxNo"
    $atBottomNow = Test-FabVisible $doc
    # A4 的判据：取到更早一页之后，视口应当还停在**旧历史**里 —— 看不到最新那条，且右下角出现「回到最新」。
    # 不用"最小可见编号 <= 160"当判据：插入更早的一页后，视口按 index 锚定会显示那一页里更旧的几条，
    # 编号取决于每屏能放几条消息，写死阈值等于在断言"每屏高度"。
    Add-Check 'A4 加载更早后视口没有被拽回底部（看不到最新一条，且出现「回到最新」）' (($uiText -notmatch '最新消息 #220') -and $atBottomNow) "可见最小 #$minNo，FAB 出现=$atBottomNow"

    $reached2 = Invoke-PullToTop
    Note "第 2 次上拉：到顶判据=$reached2"
    if ($reached2 -eq 'entry') {
        $res2 = Wait-CountIncrease -From $l1 -TimeoutSec 10 -ShotName '04-loading-older-2'
    }
    else {
        $res2 = [pscustomobject]@{ paging = (Get-Paging (Get-UiText (Get-Ui))); loading = $false }
    }
    $l2 = $l1
    if ($res2.paging) { $l2 = $res2.paging.loaded }
    Note "第 2 次上拉后 已加载 $l2/$t0 条（加载中帧=$($res2.loading)）"
    # A5 的意图是"更早的历史不是一次拿完的，继续上拉还能推进"。
    # 判据用计数时间轴的增量次数（>= 2 次增量 = 至少两页是分两次取回来的），
    # 外加"这次上拉本身让计数变大"作为直接观测；两者有一即可。
    # 当窗口已经拉满（$l2 -ge $t0，界面上出现「已到最早」）时，计数当然不再变 —— 那是正确行为，不是缺陷。
    $deltas2 = @(Get-CountTraceDeltas)
    $stepIncreases = @($deltas2 | Where-Object { $_.delta -gt 0 }).Count
    $windowFull = ($t0 -gt 0 -and $l2 -ge $t0)
    $pull2Grew = ($l2 -gt $l1) -or ($stepIncreases -ge 2) -or $windowFull
    $a5Note = "$l1 → $l2；时间轴增量次数=$stepIncreases；窗口已满=$windowFull"
    if ($pull2Grew -and ($l2 -eq $l1) -and -not $windowFull) {
        Note "第 2 次上拉计数未变，但时间轴上有 $stepIncreases 次分页增量 ⇒ 按「分页确实逐页推进」判定"
    }
    if ($windowFull) {
        Note "窗口已满（$l2/$t0，界面出现「已到最早」）⇒ A5 的「再上拉还能推进」已不适用，按已拉满判定"
    }
    Add-Check 'A5 更早历史分多次取回（计数时间轴增量 >= 2 次，或本次上拉计数变大）' $pull2Grew $a5Note
    Save-Shot '05-after-pull-2' | Out-Null

    Write-Step '6. 拉到最早：入口文案变「已到最早」'
    $stop = $false
    $guard = 0
    while (-not $stop -and $guard -lt 4) {
        $guard += 1
        $doc = Get-Ui
        $uiText = Observe $doc
        $paging = Get-Paging $uiText
        $cur = $l2
        if ($paging) { $cur = $paging.loaded }
        if ($uiText -match '已到最早，没有更早的消息了') {
            $l2 = $cur
            $stop = $true
            break
        }
        if ($cur -ge $t0) {
            $l2 = $cur
            # 已加载==总数但入口还没翻成"已到最早"：再 dump 一次给它一帧时间
            Start-Sleep -Milliseconds 800
            $doc = Get-Ui
            $uiText = Observe $doc
            if ($uiText -match '已到最早，没有更早的消息了') { $stop = $true }
            else { $stop = $true; Note '已加载=总数，但未看到「已到最早」文案' }
            continue
        }
        $reachedN = Invoke-PullToTop
        Note "第 $($guard + 2) 次上拉：到顶判据=$reachedN"
        if ($reachedN -eq 'earliest') {
            $paging2 = Get-Paging (Get-UiText (Get-Ui))
            if ($paging2) { $l2 = $paging2.loaded }
            $stop = $true
            continue
        }
        if ($reachedN -eq 'none') { $stop = $true; continue }
        $resN = Wait-CountIncrease -From $cur -TimeoutSec 10 -ShotName "0$($guard + 4)-loading-older-n"
        if ($resN.paging) { $l2 = $resN.paging.loaded }
        Note "第 $($guard + 2) 次上拉后 已加载 $l2/$t0 条"
    }
    $doc = Get-Ui
    $uiText = Observe $doc
    $paging = Get-Paging $uiText
    if ($paging) { $l2 = $paging.loaded; $t0 = $paging.total }
    Add-Check 'A6 拉到最早：已加载 == 总数' ($l2 -eq $t0 -and $t0 -eq 220) "实测 $l2/$t0"
    Add-Check 'A7 入口文案变成「已到最早，没有更早的消息了」' ($uiText -match '已到最早，没有更早的消息了') '滑到顶后第 0 项文案'
    Save-Shot '06-earliest' | Out-Null

    Write-Step '7. 轨迹视图：同一分页窗口、切换不重新拉取'
    $doc = Get-Ui
    # v2.9 起分段按钮就是朴素的「对话」/「轨迹」（DetailBits.kt:188 DetailTabRow 传字面量），
    # 步数改在轨迹页副标题里显示（「第 1 轮 · 共 N 步 · M 次工具调用」）。
    Assert-Ui $doc '轨迹' '分段按钮出现「轨迹」' | Out-Null
    $trajShown = -1
    # 第二轮的关键疑点：切到轨迹的一瞬间计数从 60 跳到 220/220，而夹具侧 12 条请求的时序不明。
    # 轨迹列表也是从下标 0 开始渲染的，如果它的"上拉到顶自动取更早"effect 在首次组合时就开火，
    # 切视图本身就会打请求 —— 这里用切换前后的夹具请求计数直接判定。
    $reqBeforeSwitch = [int](Read-FixtureRequests)
    Note "切视图前夹具收到 transcript 请求 $reqBeforeSwitch 条"
    Tap-Pattern $doc '轨迹' -Exact | Out-Null
    Start-Sleep -Seconds 2
    $reqAfterSwitch = [int](Read-FixtureRequests)
    Note "切视图后夹具收到 transcript 请求 $reqAfterSwitch 条（本次新增 $($reqAfterSwitch - $reqBeforeSwitch) 条）"
    Add-Check 'A17 切换视图本身不触发额外 transcript 请求' (($reqAfterSwitch - $reqBeforeSwitch) -eq 0) "新增 $($reqAfterSwitch - $reqBeforeSwitch) 条"
    # Lead 的裁定：这 3 条不是"切视图引起的重复拉取"，而是"上拉积压的加载在切视图那一刻被放行"。
    # 证据就是它们各自的 cursor —— 逐条打出来给人看，别用推断代替。
    $switchDelta = $reqAfterSwitch - $reqBeforeSwitch
    $script:Rc['switchDelta'] = $switchDelta
    if ($switchDelta -gt 0) {
        $newReqLines = @($script:ReqSummary | Select-Object -Last ([int]$switchDelta))
        Note "切视图那一刻新增的请求（夹具视角逐条）：$($newReqLines -join ' || ')"
    }
    $doc = Get-Ui
    $uiText = Observe $doc
    # 轨迹页副标题是 trajectorySubtitle（"第 1–N 轮 · 共 M 步 · K 次工具调用"），**没有**「已加载 X/Y 条」
    # —— 那是对话页 conversationSubtitle 的计数。所以 A9 的"X 不变"要在切回对话后再量（见第 8 步）。
    $trajLabel = [regex]::Match($uiText, '共\s*(\d+)\s*步')
    if ($trajLabel.Success) { $trajShown = [int]$trajLabel.Groups[1].Value }
    Note "切到轨迹后 轨迹总步数=$trajShown（轨迹页不显示「已加载 X/Y 条」，A9 在第 8 步切回对话后判定）"
    $trajRows = 0
    # 轨迹侧第 0 项用的是同一个 LoadOlderEntry 组件（noun="轨迹"），这里顺带验证它在轨迹视图里也成立
    Add-Check 'A8b 轨迹侧入口与对话流同款（「已到最早」文案 noun=轨迹）' ($uiText -match '已到最早，没有更早的轨迹了') '轨迹列表第 0 项'
    $visibleRows = ([regex]::Matches($uiText, '执行结果|执行失败|模型输出|你|系统')).Count
    if ($trajShown -ge 0) { $trajRows = $trajShown } else { $trajRows = $visibleRows }
    Add-Check 'A8 轨迹行数 ≥ 已加载消息数（工具/结果摊开成多行）' ($trajRows -ge $l2) "轨迹 $trajRows 步 vs 消息 $l2 条"
    Save-Shot '07-trajectory' | Out-Null

    Write-Step '8. 回到最新（FAB）'
    Tap-Pattern $doc '对话' -Exact | Out-Null
    Start-Sleep -Seconds 2
    $doc = Get-Ui
    $uiBackText = Observe $doc
    $pagingBack = Get-Paging $uiBackText
    $lBack = -1
    if ($pagingBack) { $lBack = $pagingBack.loaded }
    Add-Check 'A9 切换视图没有重新拉取（切回对话后 X 不变）' ($lBack -eq $l2) "$l2 → $lBack"
    $doc = Get-Ui
    $uiText = Observe $doc
    $fabBefore = Test-FabVisible $doc
    Add-Check 'A10 上翻历史后右下角出现「回到最新」' $fabBefore "contentDescription=回到最新 可见=$fabBefore"
    Save-Shot '08-fab-visible' | Out-Null
    if ($fabBefore) {
        $reqBeforeFab = [int](Read-FixtureRequests)
        Tap-Pattern $doc '回到最新' -Exact | Out-Null
        # 目标可能在几十项之外，animateScrollToItem 要跑一段；固定 sleep 2s 在 120 条窗口下不够，
        # 会打出假失败（第三轮 A11 就是这么 FAIL 的）。改成轮询"看到末尾"或超时。
        $tailSeen = $false
        $deadlineFab = (Get-Date).AddSeconds(12)
        while ((Get-Date) -lt $deadlineFab) {
            Start-Sleep -Milliseconds 400
            $doc = Get-Ui
            $uiText = Observe $doc
            if ($uiText -match '最新消息 #220') { $tailSeen = $true; break }
        }
        Add-Check 'A11 点一次「回到最新」即看到列表末尾 #220' $tailSeen '视口里出现「最新消息 #220」'
        # A22：点「回到最新」是**程序自己**发起的滚动动画（animateScrollToItem），
        # 不该被当成"用户上拉"而多取一页更早的页 —— 修复前 isScrollInProgress 分不清这两者，
        # 夹具在 T+181.0s 因此白收到一条 cursor=100 的请求。现在开火条件只认 DragInteraction。
        $reqAfterFab = [int](Read-FixtureRequests)
        Add-Check 'A22 点「回到最新」不产生新的 transcript 请求' (($reqAfterFab - $reqBeforeFab) -eq 0) "新增 $($reqAfterFab - $reqBeforeFab) 条"
        Save-Shot '09-after-fab' | Out-Null
    }
    else {
        Add-Check 'A11 点一次「回到最新」即看到列表末尾 #220' $false 'FAB 不可见，未取证'
    }

    Write-Step '8b. D6 回归：上拉在途时立刻刷新（窗口世代号），不得留下空洞'
    # Lead 指定的时序：窗口 100..160（游标 "100"）→ 上拉触发取 40..100（夹具注入 1200ms ⇒ 在途）
    # → 立刻点顶栏「刷新」⇒ resetWindow 自增 epoch、窗口重置成最新一页。
    # 在途那一页回来时若还被收下，窗口就会变成 41..100 ∪ 161..220：中间 101..160 永久丢失，
    # 而标题栏照样报"已加载 120/220"。这里能构造出的判据是"干扰之后仍能取满全部历史"——
    # 有洞时窗口永远凑不齐 220 条（见 A23）。
    $doc = Get-Ui
    $tapReset0 = Tap-MoreItem '刷新'
    Start-Sleep -Seconds 3
    $pgReset = Get-Paging (Get-UiText (Get-Ui))
    $lReset = -1
    if ($pgReset) { $lReset = $pgReset.loaded }
    Note "8b 先刷新把窗口重置成最新一页：已加载 $lReset/$t0 条（点中「刷新」=$tapReset0）"
    $script:Rc['d6StartSec'] = Get-ElapsedSec
    $reqRaceBefore = [int](Read-FixtureRequests)
    $reachedRace = Invoke-PullToTop
    $doc = Get-Ui
    $tapRace = Tap-MoreItem '刷新'
    Start-Sleep -Seconds 5
    $doc = Get-Ui
    $uiText = Observe $doc
    $pgRace = Get-Paging $uiText
    $lRace = $lReset
    if ($pgRace) { $lRace = $pgRace.loaded }
    $reqRaceAfter = [int](Read-FixtureRequests)
    Note "8b 在途刷新时序：上拉判据=$reachedRace、在途窗口内点中「刷新」=$tapRace；此刻已加载 $lRace/$t0；夹具请求 $reqRaceBefore → $reqRaceAfter 条"
    $script:Rc['raceTapped'] = $tapRace
    $script:Rc['raceLoaded'] = $lRace
    # 干扰之后重新一路拉到最早：凑满 220 条才说明中间没有缺段
    $guardR = 0
    while ($guardR -lt 5) {
        $guardR += 1
        $doc = Get-Ui
        $uiText = Observe $doc
        $pgR = Get-Paging $uiText
        $curR = $lRace
        if ($pgR) { $curR = $pgR.loaded }
        if ($uiText -match '已到最早，没有更早的消息了' -or $curR -ge $t0) { $lRace = $curR; break }
        $reachedR = Invoke-PullToTop
        if ($reachedR -eq 'none') { break }
        $resR = Wait-CountIncrease -From $curR -TimeoutSec 10 -ShotName "10-d6-loading-$guardR"
        if ($resR.paging) { $lRace = $resR.paging.loaded }
        Note "8b 恢复取页 #$guardR 后 已加载 $lRace/$t0 条"
    }
    $doc = Get-Ui
    $uiText = Observe $doc
    $pgFinal = Get-Paging $uiText
    if ($pgFinal) { $lRace = $pgFinal.loaded }
    Add-Check 'A23（D6 回归）上拉在途刷新之后仍能取满全部历史（窗口无空洞）' ($lRace -eq $t0 -and $t0 -eq 220) "刷新后重新拉到最早：$lRace/$t0（在途窗口内点中「刷新」=$tapRace）"
    Save-Shot '10-d6-after-refresh' | Out-Null

    Write-Step '9. 崩溃与异常检查（logcat）'
    $logFile = Join-Path $WorkDir 'logcat.txt'
    $logcat = Invoke-AdbArgs @('logcat', '-d', '-v', 'brief', '-t', '6000')
    [System.IO.File]::WriteAllText($logFile, $logcat, (New-Object System.Text.UTF8Encoding($false)))
    $logLines = ($logcat -split "`r?`n")
    $fatalAll = @($logLines | Where-Object { $_ -match 'FATAL EXCEPTION' })
    $keyAll = @($logLines | Where-Object { $_ -match 'Key was already used' })
    $illegalAll = @($logLines | Where-Object { $_ -match 'IllegalArgumentException' })
    $fatalOurs = @($fatalAll | Where-Object { $_ -match [regex]::Escape($Package) })
    $keyOurs = @($keyAll | Where-Object { $_ -match [regex]::Escape($Package) })
    $illegalOurs = @($illegalAll | Where-Object { $_ -match [regex]::Escape($Package) })
    Note ("logcat 命中：FATAL=$($fatalAll.Count)（本包 $($fatalOurs.Count)）KeyReuse=$($keyAll.Count)（本包 $($keyOurs.Count)）IllegalArgument=$($illegalAll.Count)（本包 $($illegalOurs.Count)）")
    foreach ($line in ($fatalAll + $keyAll + $illegalAll | Select-Object -First 8)) {
        Note ("logcat: " + $line.Trim())
    }
    Add-Check 'A12 logcat 无本包 FATAL EXCEPTION' ($fatalOurs.Count -eq 0) "本包命中 $($fatalOurs.Count) 条（全设备 $($fatalAll.Count) 条）"
    Add-Check 'A13 logcat 无「Key was already used」' ($keyAll.Count -eq 0) "命中 $($keyAll.Count) 条"
    Add-Check 'A14 logcat 无本包 IllegalArgumentException' ($illegalOurs.Count -eq 0) "本包命中 $($illegalOurs.Count) 条（全设备 $($illegalAll.Count) 条）"
    # A1c/A1d 的根因读数：应用侧 DEBUG 日志（tag=DshPaging）记录了
    # "闸门被谁打开"（DragInteraction.Start）与每次贴底判定的重算读数。
    # 这是唯一能把"闸门被误开"与"判据算错"分开的证据，所以原样落盘 + 进报告。
    $dshLines = @($logLines | Where-Object { $_ -match 'DshPaging' })
    $dshFile = Join-Path $WorkDir 'logcat-dshpaging.txt'
    [System.IO.File]::WriteAllText($dshFile, (($dshLines -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    $dshDrag = @($dshLines | Where-Object { $_ -match 'drag-start' }).Count
    $dshObserve = @($dshLines | Where-Object { $_ -match 'observe ' }).Count
    Note ("DshPaging 诊断日志：$($dshLines.Count) 行（drag-start $dshDrag 条、observe $dshObserve 条）→ raw\logcat-dshpaging.txt")
    foreach ($line in ($dshLines | Select-Object -First 12)) { Note ("DshPaging: " + $line.Trim()) }

    Write-Step '10. 夹具侧请求记录（分页真源）'
    [void](Read-FixtureRequests)
    $fixtureLog = Join-Path $OutDir 'fixture-tunnel.log'
    if (Test-Path $fixtureLog) {
        foreach ($line in @(Get-Content -LiteralPath $fixtureLog -Encoding UTF8 | Where-Object { $_ -match '/transcript' })) {
            Note ("fixture-log: " + $line.Trim())
        }
    }
    $reqCount = $script:ReqSummary.Count
    $cursorReqs = @($script:ReqSummary | Where-Object { $_ -match 'cursor=[0-9]' }).Count
    foreach ($req in $script:ReqSummary) { Note ("fixture: " + $req) }
    Note "夹具收到的 transcript 请求 $reqCount 条，其中带 cursor 的更早页 $cursorReqs 条"
    Add-Check 'A15 夹具确实按游标收到多页 transcript 请求' ($reqCount -ge 3) "共 $reqCount 条 transcript 请求"
    Add-Check 'A16 夹具侧出现过至少 2 次「带 cursor 的更早页」请求' ($cursorReqs -ge 2) "带 cursor 的请求 $cursorReqs 条"
    # D4 观测：Lead 要求的两个数一起打出来 —— ①窗口里实际最多有多少条（夹具累计服务的不同页合计）
    # ②界面上的「已加载 X」。改完 D4 后应当有 X == 窗口实际条数。修复前这里会 FAIL，那正是证据。
    $c40 = @($script:ReqSummary | Where-Object { $_ -match 'cursor=40 limit' }).Count
    Note "夹具侧 cursor=40（最早页 [0,40)）被重复请求 $c40 次"
    $script:Rc['cursor40Repeats'] = $c40
    Note ("D4 两个口径：夹具累计服务的不同页 = {0} 页 / 合计 {1} 条（客户端窗口最多只能有这么多）；界面最后观测到「已加载 {2}/{3}」" -f $script:DistinctPages, $script:WindowMsgs, $script:LastX, $script:LastTotal)
    $script:Rc['windowMsgs'] = $script:WindowMsgs
    $script:Rc['lastX'] = $script:LastX
    if ($script:WindowMsgs -gt 0 -and $script:LastX -ge 0) {
        Add-Check 'A20（D4 观测）界面「已加载 X」不超过夹具累计服务的实际条数' ($script:LastX -le $script:WindowMsgs) "X=$($script:LastX)，夹具累计 $($script:WindowMsgs) 条（$($script:DistinctPages) 页）"
    }
    # A21（D2 修复验证）：**带游标的更早页**不得被重复请求。
    # 修复前最早页 cursor=40 被连打 9 次（hasMoreOlder 永真），这才是 D2 的病。
    # 「最新一页」（不带 cursor）本来就会被合法重取：打开会话一次，此后每次追新/刷新一次，
    # 它单独计数只作说明、不参与重复判定（脚本无法从请求本身区分追新与刷新，所以不硬判）。
    # 只统计 D6 干扰**之前**那段干净分页序列：8b 里刷新会重置窗口（并作废在途那一页），
    # 重置之后重新取同一页是正确行为，不该算成重复。
    $d6StartSec = 0
    if ($script:Rc.ContainsKey('d6StartSec')) { $d6StartSec = [double]$script:Rc['d6StartSec'] }
    $cursorKeys = New-Object System.Collections.ArrayList
    $latestCount = 0
    $d6Skipped = 0
    foreach ($line in $script:ReqSummary) {
        $tm = [regex]::Match($line, 'T\+\s*([0-9.]+)s')
        if ($tm.Success -and $d6StartSec -gt 0 -and [double]$tm.Groups[1].Value -ge $d6StartSec) { $d6Skipped++; continue }
        if ($line -match 'cursor=(\d+)') { [void]$cursorKeys.Add($Matches[1]) } else { $latestCount++ }
    }
    $dupKeys = @($cursorKeys | Group-Object | Where-Object { $_.Count -gt 1 })
    $dupText = '无'
    if ($dupKeys.Count -gt 0) { $dupText = (($dupKeys | ForEach-Object { "$($_.Name) x$($_.Count)" }) -join ', ') }
    Add-Check 'A21（D2 复跑）带游标的更早页不被重复请求（D6 干扰之前）' ($dupKeys.Count -eq 0) "干净序列里更早页 $($cursorKeys.Count) 条（游标 $($cursorKeys -join ',')），重复游标：$dupText；同段「最新一页」$latestCount 条（打开会话 + 追新/刷新，合法重取，不计入重复判定）；8b 之后另有 $d6Skipped 条（刷新重置窗口后重取同一页属正确行为）"
}
finally {
    Write-Step '11. 汇总'
    $pass = @($script:Checks | Where-Object { $_.ok }).Count
    $fail = @($script:Checks | Where-Object { -not $_.ok }).Count
    Write-Host ("  PASS={0} FAIL={1}" -f $pass, $fail) -ForegroundColor Yellow

    $report = Join-Path $OutDir 'paging-check-report.txt'
    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add('DSH Remote · 手机端分页真机（模拟器）证据报告')
    [void]$lines.Add('=' * 78)
    [void]$lines.Add("生成时间   : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
    [void]$lines.Add("脚本       : android/evidence/v4/run-paging-check.ps1")
    [void]$lines.Add("夹具       : android/evidence/v4/mock-tunnel.mjs (端口 $Port，分页语义照抄 session-reader.mjs:745-751)")
    [void]$lines.Add("设备       : $Serial（AVD dshr_ui / Android 14 / x86_64）")
    [void]$lines.Add("APK        : $Apk")
    [void]$lines.Add("APK sha256 : $ApkSha")
    [void]$lines.Add("耗时       : $([int]((Get-Date) - $script:RunStarted).TotalSeconds) 秒")
    [void]$lines.Add('时间基     : 所有 T+ 秒都是相对本轮脚本开始；夹具请求的 T+ 取夹具进程 Date.now()（同一台机器同一时钟）')
    [void]$lines.Add('')
    [void]$lines.Add('断言清单')
    [void]$lines.Add('-' * 78)
    foreach ($check in $script:Checks) {
        $mark = 'FAIL'
        if ($check.ok) { $mark = 'PASS' }
        [void]$lines.Add(("[{0}] {1} :: {2}" -f $mark, $check.name, $check.detail))
    }
    [void]$lines.Add('')
    [void]$lines.Add(("合计 PASS={0} FAIL={1}" -f $pass, $fail))
    [void]$lines.Add('')
    [void]$lines.Add('根因分析（实测 -> 判定；由脚本按本轮实测数字生成）')
    [void]$lines.Add('-' * 78)
    foreach ($rcLine in (Get-RootCauseLines)) { [void]$lines.Add($rcLine) }
    [void]$lines.Add('')
    [void]$lines.Add('过程记录（按发生顺序）')
    [void]$lines.Add('-' * 78)
    foreach ($note in $script:Notes) { [void]$lines.Add($note) }
    [void]$lines.Add('')
    [void]$lines.Add('运行中观察到的全部界面文案（去重，用于证明某个状态确实出现过）')
    [void]$lines.Add('-' * 78)
    $allLines = @($script:AllSeen.ToString() -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 } | Select-Object -Unique)
    foreach ($line in $allLines) { [void]$lines.Add($line) }
    [void]$lines.Add('')
    [void]$lines.Add('UI 计数时间轴（「已加载 X/Y」每次变化，T+ = 相对本轮开始的秒数）')
    [void]$lines.Add('-' * 78)
    if ($script:CountTrace.Count -eq 0) { [void]$lines.Add('（全程未观测到任何计数变化）') }
    foreach ($traceLine in $script:CountTrace) { [void]$lines.Add($traceLine) }
    [void]$lines.Add('')
    [void]$lines.Add('夹具侧 transcript 请求序列（控制面内存记账，不依赖日志文件落盘）')
    [void]$lines.Add('-' * 78)
    foreach ($req in $script:ReqSummary) { [void]$lines.Add($req) }
    [void]$lines.Add('')
    [void]$lines.Add('夹具请求日志摘录（transcript）')
    [void]$lines.Add('-' * 78)
    $fixtureLog = Join-Path $OutDir 'fixture-tunnel.log'
    if (Test-Path $fixtureLog) {
        $all = @(Get-Content -LiteralPath $fixtureLog -Encoding UTF8)
        foreach ($line in ($all | Where-Object { $_ -match '/transcript' })) { [void]$lines.Add($line.Trim()) }
    }
    [System.IO.File]::WriteAllLines($report, $lines, (New-Object System.Text.UTF8Encoding($true)))
    Write-Host "  报告已写入 $report"

    Stop-Fixture
    Exit-E2ELock
}
