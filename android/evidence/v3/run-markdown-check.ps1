# =============================================================================
# DSH Remote · Markdown 渲染 UI 证据脚本（模拟器 emulator-5554）
#
# 做什么：
#   1) 复用 v2 的夹具中继+网关（../v2/mock-tunnel.mjs，夹具里的手机任务回答已改成
#      一份覆盖标题/列表/围栏代码/表格/引用/任务项/链接的 Markdown 文本）；
#   2) 装 debug APK，走完「配对 → 手机任务 → 续聊一轮」，抓**流式中**与**轮次结束**两帧；
#   3) 断言渲染结果：markdown 标记（`##`、`**`、`| ---`、`> `、`- [x]`、` ``` `）必须
#      **不出现在界面文本里**，而对应的可见文本（标题、粗体正文、表格单元格、引用正文）
#      必须出现 —— 这才是"渲染了"而不是"原样显示了"；
#   4) 工作区 → README.md：默认走 Markdown 预览，断言预览里没有 `#` 标记且表格/代码块可见；
#      再点「查看源码」切回原文，断言原文里的 `##` 又出现了。
#
# 为什么和 v2 的 run-ui-check.ps1 分开：v2 那份是 46 条基线断言，不能被新功能改动污染；
# 这份只证明 Markdown 渲染这一件事，失败时不会把基线报告染红。两份脚本**不能同时跑**：
# 同一个模拟器 + 同一套底部导航坐标会互相踩（v2 的 .e2e.lock 也会被本脚本尊重）。
#
# 编码：本机只有 Windows PowerShell 5.1（没有 pwsh），本文件必须存成 **UTF-8 with BOM**，
#       否则 5.1 会按 ANSI 解析中文，直接语法错误（与 v2 脚本同一约定）。
# =============================================================================
[CmdletBinding()]
param(
    [string]$Serial = 'emulator-5554',
    # 刻意避开 v2 的 9543 与真实中继的 9443：抢端口会让证据跑不稳定
    [int]$Port = 9544,
    [string]$Apk = 'D:\Workspace\dsh_android\android\app\build\outputs\apk\debug\app-debug.apk',
    [string]$OutDir = 'D:\Workspace\dsh_android\android\evidence\v3',
    [string]$Fixture = 'D:\Workspace\dsh_android\android\evidence\v2\mock-tunnel.mjs',
    [string]$V2OutDir = 'D:\Workspace\dsh_android\android\evidence\v2',
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

$Adb = 'D:\Workspace\dsh_android\.toolchain\android-dev\sdk\platform-tools\adb.exe'
$NodeExe = 'D:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$Package = 'com.deepseek.dshremote.debug'
$OtherPackage = 'com.deepseek.dshremote'
$Activity = "$Package/com.deepseek.dshremote.MainActivity"
$RelayUrl = "ws://10.0.2.2:$Port"
$ShotDir = Join-Path $OutDir 'shots'
$WorkDir = Join-Path $OutDir 'raw'

$script:Checks = @()
$script:FixtureProcess = $null

function Write-Step($text) { Write-Host "`n=== $text" -ForegroundColor Cyan }

function Add-Check([string]$name, [bool]$ok, [string]$detail) {
    $script:Checks += [pscustomobject]@{ name = $name; ok = $ok; detail = $detail }
    if ($ok) { Write-Host ("  [PASS] {0} — {1}" -f $name, $detail) -ForegroundColor Green }
    else { Write-Host ("  [FAIL] {0} — {1}" -f $name, $detail) -ForegroundColor Red }
}

# adb 会把进度写到 stderr；配合 ErrorActionPreference=Stop 会直接把脚本打断，
# 所以只在包装函数内部临时放行（与 v2 脚本同一处理，实测必须这么做）。
function Invoke-AdbArgs([string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { return (& $Adb -s $Serial @Arguments 2>&1 | Out-String) }
    finally { $ErrorActionPreference = $previous }
}

function Invoke-Adb {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    return Invoke-AdbArgs $Arguments
}

function Test-Device {
    $devices = Invoke-AdbArgs @('devices')
    return ($devices -match [regex]::Escape($Serial) + '\s+device')
}

function Kill-PidTree([int]$ProcessId) {
    if (-not $ProcessId) { return }
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & taskkill.exe /PID $ProcessId /T /F 2>&1 | Out-Null } finally { $ErrorActionPreference = $previous }
}

# ---- 夹具 -------------------------------------------------------------------

function Test-Fixture {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 3
        return ($response.StatusCode -eq 200 -and $response.Content -match 'relay\.fixture')
    }
    catch { return $false }
}

function Start-Fixture {
    if (Test-Fixture) {
        Write-Host "夹具已在 127.0.0.1:$Port 运行（复用）"
        return
    }
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        throw "端口 $Port 被别的进程占用（不是本夹具）。请换 -Port，或先停掉占用它的服务。"
    }
    $stdout = Join-Path $OutDir 'fixture.log'
    $stderr = Join-Path $OutDir 'fixture.err.log'
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
    if ($script:FixtureProcess -and -not $script:FixtureProcess.HasExited) {
        # PID 作用域：只收自己拉起来的进程树，绝不按命令行关键字杀别的 node
        Kill-PidTree $script:FixtureProcess.Id
    }
}

# ---- UI ---------------------------------------------------------------------

function Get-Ui {
    $remote = '/sdcard/dsh-md-ui.xml'
    Invoke-Adb shell uiautomator dump $remote | Out-Null
    $local = Join-Path $WorkDir 'ui.xml'
    Invoke-Adb pull $remote $local | Out-Null
    if (-not (Test-Path $local)) { throw 'uiautomator dump 失败：未取到 ui.xml' }
    # uiautomator 输出是 UTF-8；按 ANSI 读会让所有中文断言落空
    return [xml][System.IO.File]::ReadAllText($local, [System.Text.UTF8Encoding]::new($false))
}

# 把 dump 里所有 text/content-desc 拼成一整串：断言"界面上**没有**出现 markdown 标记"要用它
function Get-UiText($doc) {
    $builder = New-Object System.Text.StringBuilder
    foreach ($node in $doc.SelectNodes('//node')) {
        [void]$builder.AppendLine([string]$node.GetAttribute('text'))
        [void]$builder.AppendLine([string]$node.GetAttribute('content-desc'))
    }
    return $builder.ToString()
}

function Get-NodeCenter($doc, [string]$pattern, [switch]$Exact) {
    foreach ($node in $doc.SelectNodes('//node')) {
        $text = [string]$node.GetAttribute('text')
        $desc = [string]$node.GetAttribute('content-desc')
        $hit = $false
        if ($Exact) { $hit = ($text -eq $pattern -or $desc -eq $pattern) }
        else { $hit = ($text -like "*$pattern*" -or $desc -like "*$pattern*") }
        if ($hit) {
            $bounds = [string]$node.GetAttribute('bounds')
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

# 底部导航按坐标点：标签文字（"工作区"）会与页面内文字撞名，按文本查找会点到别处
function Tap-Nav([int]$index) {
    $size = Invoke-Adb shell wm size
    if ($size -match '(\d+)x(\d+)') { $width = [int]$Matches[1]; $height = [int]$Matches[2] }
    else { $width = 1080; $height = 2400 }
    Invoke-Adb shell input tap ([int]($width * (2 * $index + 1) / 8)) ($height - 126) | Out-Null
    Start-Sleep -Milliseconds 900
}

function Assert-Present($doc, [string]$pattern, [string]$label) {
    $ok = $null -ne (Get-NodeCenter $doc $pattern)
    Add-Check $label $ok "界面应出现「$pattern」"
}

function Assert-Absent($doc, [string]$pattern, [string]$label) {
    $ok = -not (Get-UiText $doc).Contains($pattern)
    Add-Check $label $ok "界面不应出现原始标记「$pattern」"
}

function Save-Shot([string]$name) {
    if (-not (Test-Path $ShotDir)) { New-Item -ItemType Directory -Path $ShotDir -Force | Out-Null }
    $file = Join-Path $ShotDir "$name.png"
    if (Test-Path $file) { Remove-Item $file -Force }
    # 二进制重定向必须走 cmd：PowerShell 的 ">" 会把 PNG 当文本处理，写出损坏文件
    $line = '"' + $Adb + '" -s ' + $Serial + ' exec-out screencap -p > "' + $file + '"'
    & cmd.exe /c $line | Out-Null
    if (-not (Test-Path $file)) { Add-Check "截图 $name" $false '文件未生成'; return }
    Add-Check "截图 $name" ((Get-Item $file).Length -gt 20000) ("{0} 字节" -f (Get-Item $file).Length)
}

function Scroll-Up([int]$Times = 1) {
    for ($i = 0; $i -lt $Times; $i++) {
        Invoke-Adb shell input swipe 540 1700 540 900 250 | Out-Null
        Start-Sleep -Milliseconds 500
    }
}

# 配对页比一屏高：Compose 不把未进视口的控件放进语义树，直接按文本找会"找不到控件"（v2 已踩过）。
# 逐屏下滑，每屏重新 dump，命中即返回。
function Ensure-Visible([string]$pattern, [int]$MaxSwipes = 3) {
    for ($i = 0; $i -le $MaxSwipes; $i++) {
        $doc = Get-Ui
        if ($null -ne (Get-NodeCenter $doc $pattern)) { return $doc }
        Invoke-Adb shell input swipe 540 1800 540 900 300 | Out-Null
        Start-Sleep -Milliseconds 900
    }
    return (Get-Ui)
}

# v2.7 起会话页的「填入示例」移进了顶栏「更多」下拉菜单（SessionDetailScreen.kt:422），
# 输入框旁不再有这个按钮；直接按文本找会一直找不到。
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
    Start-Sleep -Milliseconds 900
    Add-Check '打开「更多」菜单填示例' $true '已通过「更多」→「填入示例」填入示例消息'
    return $true
}

# 长消息跨多屏：断言其中某一行时必须逐屏找（只看当屏会把"在别的屏"误报成"没渲染"）。
# 先向文档后面找（手指上滑），再向文档前面找（手指下滑）。
function Assert-PresentByScrolling([string]$pattern, [string]$label, [int]$MaxSwipes = 4) {
    $doc = Get-Ui
    if ($null -ne (Get-NodeCenter $doc $pattern)) {
        Add-Check $label $true "当前屏命中「$pattern」"
        return $true
    }
    foreach ($dir in @(@(1700, 900), @(900, 1800))) {
        for ($i = 0; $i -lt $MaxSwipes; $i++) {
            Invoke-Adb shell input swipe 540 $dir[0] 540 $dir[1] 300 | Out-Null
            Start-Sleep -Milliseconds 900
            $doc = Get-Ui
            if ($null -ne (Get-NodeCenter $doc $pattern)) {
                Add-Check $label $true "滚动 $($i + 1) 屏后命中「$pattern」"
                return $true
            }
        }
    }
    Add-Check $label $false "前后各滚 $MaxSwipes 屏仍未出现「$pattern」"
    return $false
}

function Dismiss-SystemDialogs {
    for ($i = 0; $i -lt 3; $i++) {
        $doc = Get-Ui
        $target = Get-NodeCenter $doc 'Allow' -Exact
        if (-not $target) { $target = Get-NodeCenter $doc '允许' }
        if (-not $target) { $target = Get-NodeCenter $doc '确定' }
        if (-not $target) { return }
        Invoke-Adb shell input tap $target.x $target.y | Out-Null
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

# 详情页有返回箭头；列表页按返回会直接退出 App，之后所有点击都落在桌面上
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

# ---- 互斥 -------------------------------------------------------------------
# v2 与 v3 抢同一个模拟器：谁先跑谁持锁，另一方 exit 3（不允许"跑出一堆假红"）
$LockFile = Join-Path $OutDir '.e2e.lock'
$V2Lock = Join-Path $V2OutDir '.e2e.lock'

function Assert-NoOtherRun {
    foreach ($other in @($V2Lock, (Join-Path $OutDir '.e2e.lock'))) {
        if (-not (Test-Path $other)) { continue }
        $info = Get-Content $other -Raw -ErrorAction SilentlyContinue
        if ($info -match 'pid=(\d+)') {
            $otherPid = [int]$Matches[1]
            if ($otherPid -ne $PID -and (Get-Process -Id $otherPid -ErrorAction SilentlyContinue)) {
                Write-Host ("已有 UI 证据脚本在运行（PID {0}，锁 {1}），请等待：" -f $otherPid, $other) -ForegroundColor Yellow
                exit 3
            }
        }
    }
}

Assert-NoOtherRun
("pid=$PID`nname=run-markdown-check.ps1`nstarted=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`nhost=$env:COMPUTERNAME`nserial=$Serial") |
    Set-Content -Path $LockFile -Encoding UTF8

# ---- 主流程 -----------------------------------------------------------------

foreach ($dir in @($OutDir, $ShotDir, $WorkDir)) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

Write-Step '0. 环境检查'
Add-Check 'ADB 设备在线' (Test-Device) "serial=$Serial"
if (-not (Test-Device)) { Remove-Item $LockFile -Force -ErrorAction SilentlyContinue; exit 2 }
Add-Check '夹具脚本存在' (Test-Path $Fixture) $Fixture
Add-Check 'APK 存在' (Test-Path $Apk) $Apk
if (-not (Test-Path $Apk)) { Remove-Item $LockFile -Force -ErrorAction SilentlyContinue; exit 2 }

Start-Fixture
Add-Check '夹具中继可达' (Test-Fixture) "http://127.0.0.1:$Port/health"

try {
    Write-Step '1. 安装与配对'
    if (-not $SkipInstall) {
        Invoke-Adb shell am force-stop $OtherPackage | Out-Null
        $install = Invoke-AdbArgs @('install', '-r', '-t', $Apk)
        Add-Check 'APK 安装' ($install -match 'Success') ($install.Trim() -replace "`r?`n", ' ')
    }
    Invoke-Adb shell pm clear $Package | Out-Null
    Invoke-Adb shell pm grant $Package android.permission.POST_NOTIFICATIONS | Out-Null
    Invoke-AdbArgs @('shell', 'am', 'start', '-W', '-n', $Activity, '--es', 'dsh_relay_url', $RelayUrl, '--es', 'dsh_pair_code', '482913') | Out-Null
    Start-Sleep -Seconds 3
    Dismiss-SystemDialogs
    $doc = Wait-ForUi 'DSH 远程控制台' 25
    if (-not $doc) { throw 'App 未启动到配对页' }
    $doc = Ensure-Visible '填入示例'
    Tap-Pattern $doc '填入示例' | Out-Null
    # 点完「填入示例」会浮出明文风险卡，把「配对并连接」往下推，必须重新找一次
    $doc = Ensure-Visible '配对并连接'
    Tap-Pattern $doc '配对并连接' | Out-Null
    Start-Sleep -Seconds 2
    Dismiss-SystemDialogs
    $doc = Wait-ForUi 'DSH 远程' 25
    Add-Check '配对成功并进入主界面' ($null -ne $doc) '底部导航出现「电脑会话」'
    if (-not $doc) { throw '配对后未进入主界面' }

    Write-Step '2. 手机任务：流式 Markdown（未闭合围栏代码块）'
    # 「手机任务」既是页头也是底栏标签，Ensure-TabScreen 会命中底栏而永不切 Tab（v2 踩过同名陷阱）
    Tap-Nav 1
    Start-Sleep -Seconds 2
    $doc = Get-Ui
    Assert-Present $doc '手机任务：跑一遍单元测试' '手机任务列表渲染'
    Tap-Pattern $doc '手机任务：跑一遍单元测试' | Out-Null
    Start-Sleep -Seconds 2
    $doc = Get-Ui
    Assert-Present $doc '条消息' '手机任务详情已打开'

    Fill-DemoPrompt | Out-Null
    $doc = Get-Ui
    Tap-Pattern $doc '发送' -Exact | Out-Null
    Start-Sleep -Milliseconds 700
    $doc = Get-Ui
    # ① VM 消息「已发送，等待模型输出…」（SessionDetailViewModel.kt:658）；
    # ② 对话流末端「第 N 轮进行中」芯片（DetailBits.kt:336-359）。
    Assert-Present $doc '等待模型输出' '流式渲染中（已受理并等待模型输出）'
    Assert-Present $doc '单元测试结果' '流式帧里标题已按标题渲染（不带 ##）'
    Assert-Absent $doc '## 单元测试结果' '流式帧里不出现原始 ## 标记'
    Save-Shot '00-phone-streaming'

    # 夹具一轮约 9s；等轮次结束（尾部内容出现即说明最终文本已落库）
    $doc = Wait-ForUi '真机截图' 30
    if (-not $doc) { $doc = Wait-ForUi '工具链核对' 10 }
    if (-not $doc) { $doc = Get-Ui }
    Save-Shot '01-phone-markdown-bottom'

    Write-Step '3. 手机任务：轮次结束后的完整 Markdown 渲染'
    Assert-PresentByScrolling '结论' '二级标题「结论」已渲染' | Out-Null
    Assert-PresentByScrolling '212 个用例全部通过' '粗体正文渲染（** 已去掉）' | Out-Null
    $doc = Get-Ui
    Assert-Absent $doc '**' '界面不出现原始粗体标记 **'
    Assert-Absent $doc '## ' '界面不出现原始标题标记 ##'
    # 长消息各段分布在不同的屏，统一走逐屏查找（只看当屏会把"在别的屏"误报成"没渲染"）
    Assert-PresentByScrolling '单元测试' '表格单元格「单元测试」已渲染' | Out-Null
    Assert-PresentByScrolling '通过' '表格单元格「通过」已渲染' | Out-Null
    $doc = Get-Ui
    Assert-Absent $doc '| ---' '界面不出现表格分隔行 | ---'
    Assert-PresentByScrolling '提示：跑真机 UI 证据前先' '引用块正文已渲染（不带 >）' | Out-Null
    $doc = Get-Ui
    Assert-Absent $doc '> 提示' '界面不出现引用标记 > '
    Assert-PresentByScrolling '工具链核对' '任务项文本已渲染' | Out-Null
    $doc = Get-Ui
    Assert-Absent $doc '- [x]' '界面不出现任务项原始标记 - [x]'
    Assert-PresentByScrolling 'BUILD.md' '链接标签已渲染' | Out-Null
    $doc = Get-Ui
    Assert-Absent $doc '```' '界面不出现围栏 ``` 标记'

    # 长消息：标题/代码块正文分布在多屏，必须逐屏找（只看当屏会误报未渲染）
    Assert-PresentByScrolling '单元测试结果' '上滚后顶部标题仍在（滚动未错位）' | Out-Null
    Assert-PresentByScrolling 'gradlew :app:testDebugUnitTest' '围栏代码块内容已渲染' | Out-Null
    Assert-PresentByScrolling '收到，我先在本工作区里跑一遍测试。' '代码块前后的正文都渲染' | Out-Null
    Save-Shot '02-phone-markdown-top'

    Write-Step '4. 文件预览：README.md 默认按 Markdown 渲染'
    $doc = Ensure-TabScreen 2 '返回上级'
    Start-Sleep -Seconds 2
    Assert-Present $doc 'README.md' '工作区根目录条目已渲染'
    Tap-Pattern $doc 'README.md' | Out-Null
    Start-Sleep -Seconds 2
    $doc = Get-Ui
    Assert-Present $doc '能力' '预览里二级标题「能力」已渲染（不带 ##）'
    Assert-Absent $doc '## 能力' '预览里不出现原始 ## 标记'
    Assert-Present $doc '电脑会话：只读镜像' '预览里列表项已渲染（不带 -）'
    Save-Shot '03-file-preview-top'

    Scroll-Up 2
    $doc = Get-Ui
    Assert-Present $doc '构建' '预览里「构建」小节已渲染'
    Assert-Present $doc 'assembleDebug' '预览里围栏代码块内容已渲染'
    Assert-Present $doc 'Kotlin' '预览里表格单元格已渲染'
    Assert-Absent $doc '| ---' '预览里不出现表格分隔行'
    Save-Shot '04-file-preview-table'

    Write-Step '5. 切回源码：原文与行号'
    Tap-Pattern $doc '查看源码' | Out-Null
    Start-Sleep -Seconds 2
    $doc = Get-Ui
    Assert-Present $doc '# DSH Remote v2' '源码模式显示原始 Markdown（# 保留）'
    Assert-Present $doc '## 能力' '源码模式显示原始 ## 标记'
    Save-Shot '05-file-source'

    $toggle = Get-NodeCenter $doc '预览 Markdown'
    Add-Check '可切回预览（按钮切换为「预览 Markdown」）' ($null -ne $toggle) '源码模式下按钮应回到预览语义'
}
catch {
    Add-Check '脚本执行完成' $false ("中断：" + $_.Exception.Message)
    Write-Host ("`n脚本中断：{0}" -f $_.Exception.Message) -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
}
finally {
    Write-Step '6. 汇总'
    $failed = @($script:Checks | Where-Object { -not $_.ok })
    $report = Join-Path $OutDir 'markdown-check-report.txt'
    $lines = @()
    $lines += 'DSH Remote · Markdown 渲染 UI 检查报告'
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
    if (Test-Path $LockFile) { Remove-Item $LockFile -Force -ErrorAction SilentlyContinue }

    $script:ExitCode = 0
    if ($failed.Count -gt 0) {
        Write-Host ("`n有 {0} 项失败" -f $failed.Count) -ForegroundColor Red
        $script:ExitCode = 1
    }
    else { Write-Host "`n全部检查通过" -ForegroundColor Green }
}

exit $script:ExitCode
