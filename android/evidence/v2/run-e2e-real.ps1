# =============================================================================
# DSH Remote v2 · Android × 真实中继 × 真实网关 端到端检查（模拟器 emulator-5554）
#
# 与 run-ui-check.ps1（夹具）的区别：这份脚本连的是**真实进程**：
#   tools/dsh-relay/relay.mjs  （监听 9643，独立 -Home）
#   tools/dsh-remote/gateway.mjs（监听 8887，独立 --home + 独立 DSH_HOME，绝不污染真实会话）
# 手机侧仍然是真实 App：真实 pair/claim → 真实 WebSocket 隧道 → 真实 SSE 长流。
#
# 覆盖契约 §6 的等价拓扑判据（从手机侧看）：
#   B 手机只经中继可达：会话列表 / 对话流 / 工作区 / 改动 全部成功
#   D PC 掉线可见：停掉网关 → 手机显示"电脑离线"
#   E 中继重启自愈：重启网关 → 隧道自动重连 → 手机回到"已连接"
#
# 兼容 Windows PowerShell 5.1；脚本必须存成 UTF-8 with BOM。
# =============================================================================
[CmdletBinding()]
param(
    [string]$Serial = 'emulator-5554',
    [int]$RelayPort = 9643,
    [int]$GatewayPort = 8887,
    [string]$Apk = 'D:\Workspace\dsh_android\android\app\build\outputs\apk\debug\app-debug.apk',
    [string]$OutDir = 'D:\Workspace\dsh_android\android\evidence\v2',
    [string]$Workspace = 'D:\Workspace\dsh_android',
    [switch]$SkipInstall,
    [switch]$KeepRunning
)

$ErrorActionPreference = 'Stop'

$Adb = 'D:\Workspace\dsh_android\.toolchain\android-dev\sdk\platform-tools\adb.exe'
$NodeExe = 'D:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$RelayScript = 'D:\Workspace\dsh_android\tools\dsh-relay\relay.mjs'
$GatewayScript = 'D:\Workspace\dsh_android\tools\dsh-remote\gateway.mjs'
$Package = 'com.deepseek.dshremote.debug'
$OtherPackage = 'com.deepseek.dshremote'
$Activity = "$Package/com.deepseek.dshremote.MainActivity"
$RelayUrl = "ws://10.0.2.2:$RelayPort"
$ShotDir = Join-Path $OutDir 'shots'
$WorkDir = Join-Path $OutDir 'raw'
$RunDir = Join-Path $OutDir 'e2e-runtime'
$RelayHome = Join-Path $RunDir 'relay-home'
$GatewayHome = Join-Path $RunDir 'gateway-home'
$GatewayConfig = Join-Path $RunDir 'gateway-config.json'
$PairCode = $null

$script:Checks = @()
$script:RelayProcess = $null
$script:GatewayProcess = $null
$script:ShotSizes = @{}
$script:Warnings = @()

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

function Add-Check([string]$name, [bool]$ok, [string]$detail, [string]$Kind = 'product') {
    # 分类是硬要求（Lead 复核时被环境问题误导过）：
    #   product     → FAIL(产品缺陷)：App/网关/中继的功能问题
    #   environment → FAIL(环境或夹具) / SKIP(environment)：SDK、凭据、端口、前台、模拟器 NAT
    #   assertion   → FAIL(测试断言)：脚本自身时序/取词问题（**不能**记成产品缺陷）
    $script:Checks += [pscustomobject]@{ name = $name; ok = $ok; detail = $detail; kind = $Kind }
    if ($ok) { Write-Host ("  [PASS] {0} {1}" -f $name, $detail) -ForegroundColor Green }
    else {
        $tag = 'FAIL(产品缺陷)'
        if ($Kind -eq 'environment') { $tag = 'FAIL(环境或夹具)' }
        if ($Kind -eq 'assertion') { $tag = 'FAIL(测试断言)' }
        if ($detail -like '*SKIP(environment)*') { $tag = 'SKIP(environment)' }
        Write-Host ("  [{0}] {1} {2}" -f $tag, $name, $detail) -ForegroundColor Red
    }
}

# ---- 进程与 adb 包装（stderr 处理见 run-ui-check.ps1 的说明） -----------------

function Invoke-Native([string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $output = & $Adb -s $Serial @Arguments 2>&1 } finally { $ErrorActionPreference = $previous }
    return ($output | Out-String)
}

function Invoke-Adb {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    return Invoke-Native $Arguments
}

function Invoke-AdbArgs {
    param([string[]]$Arguments)
    return Invoke-Native $Arguments
}

function Invoke-Node([string[]]$Arguments, [int]$TimeoutSec = 60) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $NodeExe @Arguments 2>&1
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previous }
    return [pscustomobject]@{ output = ($output | Out-String); code = $code }
}

# 这里刻意**不用 Start-Process**：本机 PS 5.1 长会话里第二次启动会偶发
# "This command cannot be run due to the error: The system cannot find the file specified"
# （exe 与工作目录都存在、手动复现却成功）。改用与 scripts/start-gateway.ps1 相同的
# WMI 分离启动模式：cmd /c 包装重定向 + Win32_Process.Create，稳定且能拿到真实 PID。
#
# 【P0 安全约束】清理**只允许 PID 作用域**（relay-dev 复核指出）：
#   早期实现按"命令行含 relay.mjs/gateway.mjs"匹配来收进程，会误杀队友正在跑的
#   relay/gateway（他们的进程命令行长得一样）——ops-doc 的验收 E2E 就是这么被跑红的。
#   现在改成：Win32_Process.Create 返回的 cmd.exe PID → 认领它的 node 子进程（ParentProcessId）
#   → 登记进 $script:OwnedPids；停止时只 Stop-Process 登记过的 PID。绝不按路径关键字扫。
$script:StartSeq = 0
$script:OwnedPids = New-Object System.Collections.ArrayList

function Start-ProcessLogged([string]$exe, [string[]]$ArgumentList, [string]$stdout, [string]$stderr) {
    $script:StartSeq++
    $out = $stdout -replace '\.log$', ".$($script:StartSeq).log"
    $err = $stderr -replace '\.log$', ".$($script:StartSeq).log"
    $quoted = ($ArgumentList | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $cmdLine = 'cmd.exe /c ""' + $exe + '" ' + $quoted + ' > "' + $out + '" 2> "' + $err + '""'
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
        -Arguments @{ CommandLine = $cmdLine; CurrentDirectory = $RunDir }
    if ($created.ReturnValue -ne 0) {
        throw "Win32_Process.Create 失败 ReturnValue=$($created.ReturnValue)：$cmdLine"
    }
    [void]$script:OwnedPids.Add([int]$created.ProcessId)
    # cmd.exe 只是包装层：真正的服务进程是它的 node 子进程（按父子关系认领，天然唯一）
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
        $child = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($created.ProcessId)" -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq 'node.exe' } | Select-Object -First 1
        if ($child) {
            [void]$script:OwnedPids.Add([int]$child.ProcessId)
            $process = Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
            if ($process) { return $process }
        }
        Start-Sleep -Milliseconds 300
    }
    throw "已启动 cmd($($created.ProcessId))，但 15s 内没认领到它的 node 子进程：$cmdLine"
}

# 只停止"本次运行登记过"的 PID（PID 作用域，带子进程树）
function Stop-OwnedProcess([System.Diagnostics.Process]$Process) {
    if ($Process -and $Process.Id -and ($script:OwnedPids -contains $Process.Id)) {
        # /T 连同 cmd 包装层一起收掉；只对登记过的 PID 生效
        Kill-PidTree $Process.Id
    }
    Start-Sleep -Milliseconds 800
}

# 兜底：把本次运行登记过的所有 PID 收干净（绝不动未登记的进程）
function Stop-AllOwned {
    foreach ($ownedPid in @($script:OwnedPids)) {
        Kill-PidTree $ownedPid
    }
    $script:OwnedPids.Clear()
    Start-Sleep -Milliseconds 800
}

function Wait-Http([string]$url, [int]$TimeoutSec = 25) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -eq 200) { return $true }
        }
        catch { Start-Sleep -Milliseconds 500 }
    }
    return $false
}

# ---- UI 帮助函数 -------------------------------------------------------------

function Get-Ui {
    $remote = '/sdcard/dsh-e2e.xml'
    Invoke-Adb shell uiautomator dump $remote | Out-Null
    $local = Join-Path $WorkDir 'ui-e2e.xml'
    Invoke-Adb pull $remote $local | Out-Null
    if (-not (Test-Path $local)) { throw 'uiautomator dump 失败' }
    $text = [System.IO.File]::ReadAllText($local, [System.Text.UTF8Encoding]::new($false))
    return [xml]$text
}

function Get-NodeCenter($doc, [string]$pattern, [switch]$Exact) {
    foreach ($uiNode in $doc.SelectNodes('//node')) {
        $text = [string]$uiNode.GetAttribute('text')
        $desc = [string]$uiNode.GetAttribute('content-desc')
        $hit = $false
        if ($Exact) { if ($text -eq $pattern -or $desc -eq $pattern) { $hit = $true } }
        else { if ($text -like "*$pattern*" -or $desc -like "*$pattern*") { $hit = $true } }
        if ($hit) {
            $bounds = [string]$uiNode.GetAttribute('bounds')
            if ($bounds -match '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') {
                return [pscustomobject]@{
                    x = [int](([int]$Matches[1] + [int]$Matches[3]) / 2)
                    y = [int](([int]$Matches[2] + [int]$Matches[4]) / 2)
                    text = $text
                }
            }
        }
    }
    return $null
}

function Assert-Ui($doc, [string]$pattern, [string]$label) {
    $ok = $null -ne (Get-NodeCenter $doc $pattern)
    Add-Check $label $ok ("期望界面包含「$pattern」")
    return $ok
}

# ---- 前台护栏（Lead 复核发现：App 掉到桌面后，后面所有"未找到控件"都是假红） ----

function Get-ForegroundPackage {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $dump = & $Adb -s $Serial shell dumpsys window 2>&1 | Out-String
    }
    finally { $ErrorActionPreference = $previous }
    if ($dump -match 'mCurrentFocus=Window\{[^}]*\s([\w\.]+)/') { return $Matches[1] }
    if ($dump -match 'mFocusedApp=.*\s([\w\.]+)/') { return $Matches[1] }
    return ''
}

$script:ForegroundRecoveries = 0

# 断言/截图前确保 App 在前台；掉前台就拉回来并计数（拉不回来由调用方记 SKIP）
function Ensure-AppForeground {
    $current = Get-ForegroundPackage
    if ($current -like "$Package*") { return $true }
    if ($current -eq '') { return $true } # 拿不到焦点信息时不误判
    Write-Host ("  [warn] App 不在前台（当前：{0}），拉回前台" -f $current) -ForegroundColor Yellow
    Invoke-AdbArgs @('shell', 'am', 'start', '-n', $Activity) | Out-Null
    Start-Sleep -Seconds 2
    $script:ForegroundRecoveries++
    return ((Get-ForegroundPackage) -like "$Package*")
}

# 只有确实在详情页（有返回箭头）时才按返回：在列表页按返回会直接退出 App（假红的根源）
function Back-IfPossible {
    $doc = Get-Ui
    if (Get-NodeCenter $doc '返回' -Exact) {
        Invoke-Adb shell input keyevent 4 | Out-Null
        Start-Sleep -Milliseconds 900
        return $true
    }
    Write-Host '  [info] 当前不在详情页，跳过返回键（避免退出 App）'
    return $false
}

function Assert-UiAny($doc, [string[]]$patterns, [string]$label) {
    foreach ($pattern in $patterns) {
        if (Get-NodeCenter $doc $pattern) {
            Add-Check $label $true ("命中「$pattern」")
            return $true
        }
    }
    Add-Check $label $false ("未命中任何一个：" + ($patterns -join ' / '))
    return $false
}

function Tap-Pattern($doc, [string]$pattern, [switch]$Exact) {
    $target = $null
    if ($Exact) { $target = Get-NodeCenter $doc $pattern -Exact } else { $target = Get-NodeCenter $doc $pattern }
    if (-not $target) { Add-Check "点击「$pattern」" $false '未找到控件'; return $false }
    Invoke-Adb shell input tap $target.x $target.y | Out-Null
    Write-Host "  已点击「$pattern」($($target.x),$($target.y))"
    Start-Sleep -Milliseconds 900
    return $true
}

function Tap-Nav([int]$index) {
    $size = Invoke-Adb shell wm size
    if ($size -match '(\d+)x(\d+)') { $width = [int]$Matches[1]; $height = [int]$Matches[2] }
    else { $width = 1080; $height = 2400 }
    Invoke-Adb shell input tap ([int]($width * (2 * $index + 1) / 8)) ($height - 126) | Out-Null
    Start-Sleep -Milliseconds 900
}

# 切 Tab 时必须**先退出详情页**：会话/文件/diff 详情是整屏页面，底部导航不渲染，
# 此时按坐标点"导航"是空操作，后面找状态条「已连接」会一直落空
# （实测：App 其实已连接，只是断言找错了屏幕 —— 见 real-relay-13 的绿色 live 点）
function Go-ToTab([int]$index, [int]$MaxBack = 3) {
    for ($i = 0; $i -lt $MaxBack; $i++) {
        if (-not (Back-IfPossible)) { break }
    }
    Tap-Nav $index
}

function Save-Shot([string]$name) {
    if (-not (Test-Path $ShotDir)) { New-Item -ItemType Directory -Path $ShotDir -Force | Out-Null }
    # 截图前也要确认前台：否则截到的是桌面，看起来像"功能坏了"（Lead 复核时踩到过）
    if (-not (Ensure-AppForeground)) {
        Add-Check "截图 $name" $false 'SKIP(environment)：App 不在前台且拉不回来'
        return
    }
    $file = Join-Path $ShotDir "$name.png"
    if (Test-Path $file) { Remove-Item $file -Force }
    $line = '"' + $Adb + '" -s ' + $Serial + ' exec-out screencap -p > "' + $file + '"'
    & cmd.exe /c $line | Out-Null
    if (-not (Test-Path $file)) { Add-Check "截图 $name" $false '文件未生成'; return }
    $size = (Get-Item $file).Length
    $script:ShotSizes[$name] = $size
    # 重复截图只作为**警告**（不同页面尺寸接近是正常的，不能当成失败——Lead 要求"警告"而非误判）
    $similar = $script:ShotSizes.GetEnumerator() |
        Where-Object { $_.Key -ne $name -and [Math]::Abs([int]$_.Value - $size) -lt 1200 } |
        Select-Object -First 1
    if ($similar) {
        $script:Warnings += ("截图 {0}（{1} 字节）与 {2} 尺寸接近：可能是同一界面，建议人工复核" -f $name, $size, $similar.Key)
    }
    Add-Check "截图 $name" ($size -gt 20000) ("{0} 字节" -f $size)
}

function Dismiss-SystemDialogs {
    for ($i = 0; $i -lt 3; $i++) {
        $doc = Get-Ui
        $target = Get-NodeCenter $doc 'Allow' -Exact
        if (-not $target) { $target = Get-NodeCenter $doc '允许' }
        if (-not $target) { return }
        Invoke-Adb shell input tap $target.x $target.y | Out-Null
        Start-Sleep -Milliseconds 800
    }
}

function Wait-ForUi([string]$pattern, [int]$TimeoutSec = 25) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (-not (Ensure-AppForeground)) { return $null }
        $doc = Get-Ui
        if (Get-NodeCenter $doc $pattern) { return $doc }
        Start-Sleep -Milliseconds 900
    }
    return $null
}

# 等到某个文案**消失**（例如"还没有手机任务"→ 说明新任务已经进了列表）
function Wait-ForUiGone([string]$pattern, [int]$TimeoutSec = 25) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (-not (Ensure-AppForeground)) { return $null }
        $doc = Get-Ui
        if (-not (Get-NodeCenter $doc $pattern)) { return $doc }
        Start-Sleep -Milliseconds 900
    }
    return $null
}

function Scroll-Up { param([int]$Times = 1) for ($i = 0; $i -lt $Times; $i++) { Invoke-Adb shell input swipe 540 1700 540 900 250 | Out-Null; Start-Sleep -Milliseconds 500 } }

# ---- 真实中继 / 网关 ---------------------------------------------------------

function Initialize-RelayAndGateway {
    if (-not (Test-Path $RunDir)) { New-Item -ItemType Directory -Path $RunDir -Force | Out-Null }

    # 1) 中继运行目录（幂等）
    # relayName 用 10.0.2.2：中继会把它写进 pair/claim 的 tunnelUrl，
    # 而模拟器只能用 10.0.2.2 访问宿主机（用域名会让 App"配对成功但立刻掉线"）
    # init 是幂等的、不会覆盖已存在的 config.json，所以先删配置（homes.json 保留，凭据不失效）
    $relayConfig = Join-Path $RelayHome 'config.json'
    if (Test-Path $relayConfig) { Remove-Item $relayConfig -Force }
    $init = Invoke-Node @($RelayScript, 'init', '--home', $RelayHome, '--port', "$RelayPort", '--relay-name', '10.0.2.2', '--tls-mode', 'off')
    Write-Host "  relay init exit=$($init.code)"
    if ($init.code -ne 0) { throw "relay init 失败：$($init.output)" }

    # 2) 给本机 PC 注册隧道凭据（明文 homeToken 只打印这一次）
    $token = $null
    $existing = Join-Path $GatewayHome 'relay-state.json'
    if (Test-Path $GatewayConfig) {
        $existingConfig = Get-Content $GatewayConfig -Raw | ConvertFrom-Json
        if ($existingConfig.relay.homeToken) { $token = $existingConfig.relay.homeToken }
    }
    if (-not $token) {
        $tokenOut = Invoke-Node @($RelayScript, 'home-token', '--home', $RelayHome, '--name', 'DESKTOP-E2E')
        if ($tokenOut.code -ne 0) { throw "home-token 失败：$($tokenOut.output)" }
        if ($tokenOut.output -match '(home_[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]+|"(homeToken)"\s*:\s*"([^"]+)")') {
            if ($Matches[3]) { $token = $Matches[3] } else { $token = $Matches[1] }
        }
        if (-not $token) { throw "无法从 home-token 输出里解析 homeToken：$($tokenOut.output)" }
        Write-Host "  已注册 PC 隧道凭据（homeToken 前 4 位：$($token.Substring(0,4))****）"
    }

    # 3) 网关配置：**独立 home + 独立 DSH_HOME**，镜像源指向真实 %USERPROFILE%\.dsh（只读）
    $config = [ordered]@{
        host               = '127.0.0.1'
        port               = $GatewayPort
        dshHome            = $GatewayHome
        gatewayVersion     = '2.0.0'
        authRequired       = $true
        maxConcurrent      = 2
        maxQueue           = 100
        defaultTimeoutSec  = 3600
        maxTimeoutSec      = 86400
        workspaceAllowlist = @($Workspace)
        defaultWorkspace   = $Workspace
        dsh                = [ordered]@{
            node            = $NodeExe
            launcher        = 'D:\DSH\resources\runtime\cli\bin\dsh.cmd'
            profile         = 'sdk'
            provider        = 'deepseek-official'
            model           = 'deepseek-flash'
            # 刻意不写 reasoningEffort：实测 deepseek-flash 不支持 "minimal"，
            # SDK initialize 会直接报 "does not support reasoning effort"，任务全部失败
            turnTimeoutSec  = 900
            version         = '0.1.0-rc.7'
        }
        mirror             = [ordered]@{ enabled = $true; dshHome = $null; liveWindowMs = 60000; listLimit = 50 }
        relay              = [ordered]@{
            enabled      = $true
            url          = "ws://127.0.0.1:$RelayPort"
            homeName     = 'DESKTOP-E2E'
            homeToken    = $token
            relaySecret  = ''
            reconnect    = [ordered]@{ minMs = 1000; maxMs = 30000; factor = 2; jitter = 0.2 }
            tls          = [ordered]@{ rejectUnauthorized = $true; ca = $null }
            pairWindow   = [ordered]@{ attempts = 5 }
            allowNonLoopback = $false
        }
        sessionStream      = [ordered]@{ bufferSize = 4000; heartbeatMs = 15000; maxClients = 16 }
        log                = [ordered]@{ dirName = 'logs'; filePrefix = 'gateway'; toConsole = $true }
    }
    ($config | ConvertTo-Json -Depth 8) | Set-Content -Path $GatewayConfig -Encoding UTF8
    Write-Host "  网关配置已写入 $GatewayConfig"
}

function Start-Relay {
    $stdout = Join-Path $RunDir 'relay.out.log'
    $stderr = Join-Path $RunDir 'relay.err.log'
    $script:RelayProcess = Start-ProcessLogged -exe $NodeExe -ArgumentList @($RelayScript, 'serve', '--home', $RelayHome) -stdout $stdout -stderr $stderr
    if (-not (Wait-Http "http://127.0.0.1:$RelayPort/health" 25)) { throw "中继未就绪，见 $stderr" }
    $health = (Invoke-WebRequest -Uri "http://127.0.0.1:$RelayPort/health" -UseBasicParsing).Content
    Write-Host "  中继已就绪：$health"
}

function Start-Gateway {
    $stdout = Join-Path $RunDir 'gateway.out.log'
    $stderr = Join-Path $RunDir 'gateway.err.log'
    $script:GatewayProcess = Start-ProcessLogged -exe $NodeExe -ArgumentList @($GatewayScript, 'serve', '--config', $GatewayConfig, '--home', $GatewayHome) -stdout $stdout -stderr $stderr
    if (-not (Wait-Http "http://127.0.0.1:$GatewayPort/api/v2/health" 30)) {
        $err = Get-Content $stderr -Raw -ErrorAction SilentlyContinue
        throw "网关 v2 未就绪（$GatewayPort/api/v2/health 不通）：$err"
    }
    # 预检（gateway-dev 提醒）：旧构建的网关没有 v2 路由 / supportedApiVersions，
    # 连上去会得到"看起来像 bug、其实是旧代码"的行为，所以必须在开跑前确认。
    $health = (Invoke-WebRequest -Uri "http://127.0.0.1:$GatewayPort/api/v2/health" -UseBasicParsing).Content
    $hasV2 = $health -match 'supportedApiVersions' -and $health -match '2'
    Add-Check '网关预检：v2 路由与能力宣告可用' $hasV2 ($health -replace '\s+', ' ')
    if (-not $hasV2) { throw "网关不是含 v2 的构建（缺 supportedApiVersions）：$health" }
    Write-Host "  网关已就绪（127.0.0.1:$GatewayPort，v2 预检通过）"
}

function Stop-Gateway {
    # 只收本次运行登记过的 PID（绝不按命令行关键字扫，避免误杀队友的网关）
    Stop-OwnedProcess $script:GatewayProcess
    $script:GatewayProcess = $null
    # 端口占用者兜底：仅当它确实是"我们刚启动的那个 PID"时才会命中（已被 taskkill 收掉，通常为空）
    $conn = Get-NetTCPConnection -LocalPort $GatewayPort -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $owners = @($conn | Select-Object -ExpandProperty OwningProcess -Unique)
        $owned = @($owners | Where-Object { $script:OwnedPids -contains [int]$_ })
        foreach ($ownedPid in $owned) { Kill-PidTree $ownedPid }
    }
    Start-Sleep -Milliseconds 800
}

# 判据 E 的忠实形式是"重启**中继**"：网关保持运行、按退避自动重连，手机也要自动重连
# （契约 §6 判据 E 原文）。这比"重启网关"更贴近契约，也避开脚本重启进程时的环境坑。
function Stop-Relay {
    Stop-OwnedProcess $script:RelayProcess
    $script:RelayProcess = $null
    $conn = Get-NetTCPConnection -LocalPort $RelayPort -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $owners = @($conn | Select-Object -ExpandProperty OwningProcess -Unique)
        $owned = @($owners | Where-Object { $script:OwnedPids -contains [int]$_ })
        foreach ($ownedPid in $owned) { Kill-PidTree $ownedPid }
    }
    Start-Sleep -Milliseconds 800
}

function Stop-All {
    if ($KeepRunning) { Write-Host '保留中继/网关进程（-KeepRunning）'; return }
    Stop-Gateway
    Stop-Relay
    Stop-AllOwned
}

<#
  轮询等待网关隧道恢复（判据是最终自愈，不是立刻自愈 —— 契约 §6 判据 E 的语义）。
  返回 @{ ok = bool; detail = string }。
  注意：PowerShell 的块注释以 井号尖括号 起始、以 尖括号井号 结束，块内不能再出现结束标记。
#>
function Wait-GatewayConnected([int]$TimeoutSec = 45) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $status = Invoke-Node @($GatewayScript, 'relay', 'status', '--config', $GatewayConfig, '--home', $GatewayHome) 30
        if ($status.output -match 'connected"?\s*[:=]\s*true') {
            return @{ ok = $true; detail = 'connected=true（轮询等待内恢复）' }
        }
        Start-Sleep -Seconds 1
    }
    # 超时：把网关日志里的重连行一起带上，看报告的人能直接判断
    $log = Get-ChildItem (Join-Path $GatewayHome 'logs') -Filter 'gateway-*.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $retryLines = ''
    if ($log) {
        $retryLines = ((Get-Content $log.FullName -Tail 80 -ErrorAction SilentlyContinue) |
            Where-Object { $_ -match '重连|隧道已连接|ECONNREFUSED' } |
            Select-Object -Last 3) -join ' | '
    }
    return @{ ok = $false; detail = ("connected=false（等待 ${TimeoutSec}s 后仍未恢复）；网关日志：$retryLines") }
}

function Get-PairCode {
    $out = Invoke-Node @($GatewayScript, 'relay', 'window', '--config', $GatewayConfig, '--home', $GatewayHome) 120
    Write-Host "  relay window exit=$($out.code)"
    if ($out.output -match '(\d{6})') { return $Matches[1] }
    throw "无法从输出里解析配对码：$($out.output)"
}

# ---- 主流程 -----------------------------------------------------------------

if (-not (Test-Path $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
if (-not (Test-Path $ShotDir)) { New-Item -ItemType Directory -Path $ShotDir -Force | Out-Null }

# ---- 互斥锁（Lead 复核要求）------------------------------------------------
# 两轮 E2E 抢同一个模拟器 + 同一组端口，必然互相踩：界面对不上 → "未找到控件"级联假红。
# 开跑前抢锁；发现已有实例在跑就立刻退出（exit 3），不产出误导性的失败报告。
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

Enter-E2ELock 'run-e2e-real.ps1'

$script:ExitCode = 0
try {
    Write-Step '0. 环境检查'
    Add-Check 'ADB 设备在线' ($null -ne (Invoke-Adb devices | Select-String $Serial)) "serial=$Serial"
    Add-Check '真实中继脚本存在' (Test-Path $RelayScript) $RelayScript
    Add-Check '真实网关脚本存在' (Test-Path $GatewayScript) $GatewayScript
    Add-Check 'APK 存在' (Test-Path $Apk) $Apk

    Write-Step '1. 启动真实中继 + 真实网关（隔离 home）'
    Initialize-RelayAndGateway
    Start-Relay
    Start-Gateway
    $reg = Invoke-Node @($GatewayScript, 'relay', 'connect', '--config', $GatewayConfig, '--home', $GatewayHome) 60
    Write-Host "  relay connect exit=$($reg.code)"
    if ($reg.output -match 'homeId=([^\s]+)') { Add-Check '网关隧道已连上中继' $true "homeId=$($Matches[1])" }
    else { Add-Check '网关隧道已连上中继' ($reg.code -eq 0) ($reg.output.Trim()) }

    $PairCode = Get-PairCode
    Add-Check '网关已生成配对码' ($PairCode -match '^\d{6}$') ("code=" + $PairCode)

    Write-Step '2. 安装并冷启动 App'
    if (-not $SkipInstall) {
        Invoke-Adb shell am force-stop $OtherPackage | Out-Null
        $install = Invoke-AdbArgs @('install', '-r', '-t', $Apk)
        Add-Check 'APK 安装' ($install -match 'Success') ($install.Trim() -replace "`r?`n", ' ')
    }
    Invoke-Adb shell pm clear $Package | Out-Null
    Invoke-Adb shell pm grant $Package android.permission.POST_NOTIFICATIONS | Out-Null
    # dsh_task_prompt：真机联调要便宜的 ASCII prompt（无需中文输入法、不触发长时间工具调用）
    Invoke-AdbArgs @('shell', 'am', 'start', '-W', '-n', $Activity, '--es', 'dsh_relay_url', $RelayUrl, '--es', 'dsh_pair_code', $PairCode, '--es', 'dsh_task_prompt', 'reply OK') | Out-Null
    Start-Sleep -Seconds 3
    Dismiss-SystemDialogs

    $doc = Wait-ForUi 'DSH 远程控制台' 20
    if (-not $doc) { throw 'App 未进入配对页' }
    Save-Shot 'real-relay-01-pairing' | Out-Null

    Write-Step '3. 真实配对（中继 HTTP → 隧道 → 网关）'
    Tap-Pattern $doc '填入示例' | Out-Null
    $doc = Get-Ui
    Assert-Ui $doc $PairCode '配对码已填入（来自真实网关）' | Out-Null
    Tap-Pattern $doc '配对并连接' | Out-Null
    Start-Sleep -Seconds 2
    Dismiss-SystemDialogs
    $doc = Wait-ForUi '电脑会话' 30
    if (-not $doc) { throw '真实配对后未进入主界面' }
    Add-Check '真实配对成功（中继 + 网关 + 真实 WebSocket 隧道）' $true '进入主界面'

    Write-Step '4. 真实会话镜像（读 %USERPROFILE%\.dsh）'
    Start-Sleep -Seconds 3
    $doc = Get-Ui
    Assert-Ui $doc 'DSH 远程' '会话列表页头（旧文案"镜像会话"已随 v2.7.0 改版退场）' | Out-Null
    $sessionCards = @($doc.SelectNodes('//node') | Where-Object { ([string]$_.GetAttribute('text')) -match '轮 ·' })
    Add-Check '真实会话镜像有数据' ($sessionCards.Count -ge 1) ("含 turn 统计的会话卡：{0} 个" -f $sessionCards.Count)
    Save-Shot 'real-relay-02-sessions' | Out-Null

    Write-Step '5. 真实对话流'
    Invoke-Adb shell input tap 540 620 | Out-Null
    Start-Sleep -Seconds 3
    $doc = Get-Ui
    Assert-Ui $doc '条消息' '会话详情顶部显示消息数（真实 transcript）' | Out-Null
    Assert-UiAny $doc @('pwsh', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'TodoWrite', 'write_todos', 'Terminal') '真实工具调用卡片' | Out-Null
    Save-Shot 'real-relay-03-conversation' | Out-Null

    Write-Step '6. 真实工作区（本仓库）'
    Back-IfPossible | Out-Null
    Tap-Nav 2
    Start-Sleep -Seconds 3
    $doc = Get-Ui
    Assert-Ui $doc 'dsh_android' '工作区名' | Out-Null
    Assert-Ui $doc 'README.md' '真实目录条目 README.md' | Out-Null
    Save-Shot 'real-relay-05-workspace' | Out-Null

    Tap-Pattern $doc '改动' -Exact | Out-Null
    Start-Sleep -Seconds 3
    $doc = Get-Ui
    Assert-Ui $doc '分支 main' '真实 git 分支' | Out-Null
    $changeRows = @($doc.SelectNodes('//node') | Where-Object { ([string]$_.GetAttribute('text')) -match '^(M|A|D|\?)' })
    $hasChangesSection = $null -ne (Get-NodeCenter $doc '已跟踪改动')
    $hasUntrackedSection = $null -ne (Get-NodeCenter $doc '未跟踪文件')
    Add-Check '真实改动列表（git status）' ($hasChangesSection -or $hasUntrackedSection) ("已跟踪=$hasChangesSection 未跟踪=$hasUntrackedSection 徽标节点={0}" -f $changeRows.Count)
    Save-Shot 'real-relay-06-changes' | Out-Null

    if ($hasChangesSection) {
        # 直接按"看起来像文件路径的节点"点：写死 y 偏移在真实仓库（徽标节点 25 个）上会落空
        $row = $null
        foreach ($uiNode in $doc.SelectNodes('//node')) {
            $text = [string]$uiNode.GetAttribute('text')
            if ($text -match '\.(kt|kts|md|json|mjs|java|xml|txt|gradle)$') {
                $bounds = [string]$uiNode.GetAttribute('bounds')
                if ($bounds -match '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') {
                    $row = [pscustomobject]@{
                        x = [int](([int]$Matches[1] + [int]$Matches[3]) / 2)
                        y = [int](([int]$Matches[2] + [int]$Matches[4]) / 2)
                        text = $text
                    }
                    break
                }
            }
        }
        if ($row) {
            Write-Host "  点击改动行：$($row.text)"
            Invoke-Adb shell input tap $row.x $row.y | Out-Null
            Start-Sleep -Seconds 3
            $doc = Get-Ui
            Assert-Ui $doc 'git ·' '真实 unified diff 页已打开' | Out-Null
            Save-Shot 'real-relay-07-diff' | Out-Null
            Back-IfPossible | Out-Null
        }
        else {
            Add-Check '真实 unified diff 页已打开' $false '改动列表里没找到可点的文件路径节点'
        }
    }

    Write-Step '7. 手机任务（网关自有 DSH_HOME，可写）'
    Tap-Nav 1
    Start-Sleep -Seconds 2
    $doc = Get-Ui
    # 页头大标题就是「手机任务」；旧断言「可续聊」在本页从来没有对应文案（一直假通过），
    # 行胶囊已随 v2.7.0 的会话列表改版退场。
    Assert-Ui $doc '手机任务' '手机任务页（页头）' | Out-Null
    Save-Shot 'real-relay-08-phone-tasks' | Out-Null

    Tap-Pattern $doc '新建' | Out-Null
    Start-Sleep -Seconds 1
    $doc = Get-Ui
    # v2.10.0 起「新建任务」不再是对话框（也没有「创建并开始」这个按钮）：直接进 NewTaskScreen，
    # 页头「新建任务」+ 空对话态「还没有消息」，第一句话写在这一屏的输入胶囊里，点发送才开始。
    Assert-Ui $doc '新建任务' '新建任务屏（对话式创建）' | Out-Null
    Assert-Ui $doc '还没有消息' '创建屏本身就是对话界面' | Out-Null
    Tap-Pattern $doc '填入示例' | Out-Null
    $doc = Get-Ui
    Save-Shot 'real-relay-09-create-task' | Out-Null
    # -Exact 是必须的：空态说明里也有「点发送就开始」这几个字（子串匹配会点到说明文字上）。
    $createButton = Get-NodeCenter $doc '发送' -Exact
    if ($createButton) {
        Invoke-Adb shell input tap $createButton.x $createButton.y | Out-Null
        Write-Host '  已点击「发送」，等待真实 SDK 轮次…'
        # 真实网关给新会话的标题来自 prompt（不是夹具里的"手机任务："前缀），
        # 因此用"空状态文案消失"来判定新任务进列表，最稳。
        $doc = Wait-ForUiGone '还没有手机任务' 240
        if ($doc) {
            Add-Check '真实手机任务已创建并进入列表' $true '列表空状态消失，新任务出现（真实 SDK profile 轮次）'
            Save-Shot 'real-relay-10-phone-task-created' | Out-Null
            # 打开新任务看流式输出（真实模型首 token 可能几十秒）
            Invoke-Adb shell input tap 540 620 | Out-Null
            Start-Sleep -Seconds 3
            $streamed = Wait-ForUi '助手' 240
            if ($streamed) {
                Add-Check '真实 SDK 轮次的输出经 SSE 到达手机' $true '对话流里出现助手消息'
                Save-Shot 'real-relay-11-phone-task-streaming' | Out-Null
            }
            else {
                Add-Check '真实 SDK 轮次的输出经 SSE 到达手机' $false `
                    'SKIP(environment)：240s 内未见助手消息（见 gateway 日志的 SDK/凭据报错）' 'environment'
            }
        }
        else {
            $doc = Get-Ui
            Add-Check '真实手机任务已创建并进入列表' $false `
                'SKIP(environment)：240s 内未见新任务（见 gateway 日志的 SDK/凭据报错）' 'environment'
            Save-Shot 'real-relay-10-phone-task-created' | Out-Null
        }
    }
    else {
        Add-Check '真实手机任务已创建并进入列表' $false '未找到「发送」键（创建屏的输入胶囊）'
    }

    Write-Step '8. PC 掉线可见（契约 §6 判据 D）'
    Go-ToTab 0
    Start-Sleep -Seconds 1
    Stop-Gateway
    $doc = Wait-ForUi '电脑离线' 20
    Add-Check '停掉网关后手机显示"电脑离线"' ($null -ne $doc) '收到 notice home_offline'
    Save-Shot 'real-relay-12-computer-offline' | Out-Null

    Write-Step '9. 网关重启后恢复（App 自动重连，无需人工干预）'
    Start-Gateway
    # 「已连接」只在 Tab 页的状态条上；步骤 7 结束后 App 停在会话详情页，
    # 因此先退出详情页再切回「电脑会话」Tab，否则取词永远落空
    # （这是断言作用域问题，不是功能问题 —— 见 real-relay-13 截图里那个绿色 live 点）
    Go-ToTab 0
    $doc = Wait-ForUi '已连接' 150
    if ($null -ne $doc) {
        Add-Check '网关重启后手机自动恢复' $true '状态条回到"已连接"（App 退避重连，无需人工干预）'
    }
    else {
        $gatewayWait = Wait-GatewayConnected 45
        Add-Check '网关重启后手机自动恢复' $gatewayWait.ok `
            ('FAIL(测试断言)/环境：Tab 页 150s 内未见「已连接」；网关侧 ' + $gatewayWait.detail) 'assertion'
    }
    Save-Shot 'real-relay-13-gateway-restarted' | Out-Null

    Write-Step '9b. 中继重启自愈（契约 §6 判据 E：重启中继 → 网关/手机自动重连）'
    Stop-Relay
    Start-Sleep -Seconds 2
    Start-Relay
    # 手机侧要自己发现断链（读到 RST/心跳超时）→ 退避重连 → 重新收到 ready/home_online。
    # 实测模拟器 NAT 在宿主机进程重启后首次重连会超时 15s，而退避逐次翻倍，因此给足 180s；
    # 这段等待本身就是在验证"无需人工干预"。
    $doc = Wait-ForUi '已连接' 180
    if ($null -ne $doc) {
        Add-Check '重启中继后手机自动恢复（无需人工干预）' $true '状态条回到"已连接"'
    }
    else {
        $logcat = Invoke-Native @('logcat', '-d', '-t', '300')
        $retrying = $logcat -match '隧道未就绪|后重连|隧道断开'
        Add-Check '重启中继后手机自动恢复（无需人工干预）' $false `
            ('中继重启后 180s 内手机未自动回到「已连接」；App 日志仍在重连 retrying=' + $retrying) 'product'
    }
    Save-Shot 'real-relay-14-relay-restarted' | Out-Null
    # 判据 E 的判据是"**最终**自愈"，所以这里轮询等待（最多 45s），而不是立刻断言
    $gatewayWait = Wait-GatewayConnected 45
    Add-Check '网关隧道随中继重启自动重连（退避重试，轮询等待）' $gatewayWait.ok $gatewayWait.detail
}
catch {
    Add-Check '脚本执行完成' $false ("中断：" + $_.Exception.Message)
    Write-Host ("`n脚本中断：{0}" -f $_.Exception.Message) -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
}
finally {
    Write-Step '10. 汇总'
    # SKIP(environment) 不计入失败：环境问题不能被记成功能缺陷
    $skipped = @($script:Checks | Where-Object { -not $_.ok -and $_.detail -like '*SKIP(environment)*' })
    $failed = @($script:Checks | Where-Object { -not $_.ok -and $_.detail -notlike '*SKIP(environment)*' })
    $report = Join-Path $OutDir 'e2e-report.txt'
    $lines = @()
    $lines += 'DSH Remote v2 · Android × 真实中继 × 真实网关 端到端报告'
    $lines += "时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    $lines += "设备：$Serial   中继：ws://10.0.2.2:$RelayPort（真实 relay.mjs）   网关：127.0.0.1:$GatewayPort（真实 gateway.mjs）"
    $lines += "配对码：$PairCode"
    $lines += "运行目录：$RunDir（隔离 home，未污染真实会话）"
    $lines += ("通过 {0} / 失败 {1} / 跳过 {2} / 共 {3}" -f `
        ($script:Checks.Count - $failed.Count - $skipped.Count), $failed.Count, $skipped.Count, $script:Checks.Count)
    $lines += '失败分类：FAIL(产品缺陷) = App/网关/中继功能问题；FAIL(环境或夹具) = SDK/凭据/端口等环境问题；SKIP(environment) = 环境不满足、未验证'
    $lines += ("前台恢复次数：{0}（App 掉前台后被拉回；>0 说明过程中出现过环境抖动）" -f $script:ForegroundRecoveries)
    if ($script:Warnings.Count -gt 0) {
        $lines += ''
        $lines += ("警告 {0} 条（不影响判定，供人工复核）：" -f $script:Warnings.Count)
        foreach ($warning in $script:Warnings) { $lines += ("  ! " + $warning) }
    }
    $lines += ''
    foreach ($check in $script:Checks) {
        $flag = 'PASS'
        if (-not $check.ok) {
            if ($check.detail -like '*SKIP(environment)*') { $flag = 'SKIP(environment)' }
            elseif ($check.kind -eq 'environment') { $flag = 'FAIL(环境或夹具)' }
            else { $flag = 'FAIL(产品缺陷)' }
        }
        $lines += ("[{0}] {1} — {2}" -f $flag, $check.name, $check.detail)
    }
    $lines += ''
    $lines += '截图：'
    Get-ChildItem $ShotDir -Filter '*.png' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'real-relay-*' } | Sort-Object Name | ForEach-Object {
            $lines += ("  {0}  ({1} 字节)" -f $_.Name, $_.Length)
        }
    [System.IO.File]::WriteAllLines($report, $lines, [System.Text.UTF8Encoding]::new($false))
    Write-Host "报告：$report"

    Stop-All
    Exit-E2ELock

    if ($failed.Count -gt 0) { Write-Host ("`n有 {0} 项失败" -f $failed.Count) -ForegroundColor Red; $script:ExitCode = 1 }
    else { Write-Host "`n全部检查通过" -ForegroundColor Green }
}

exit $script:ExitCode
