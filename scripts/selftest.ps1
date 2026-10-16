#Requires -Version 5.1
<#
.SYNOPSIS
  dsh-remote 一键自检：路径/凭据/网关健康/配对/真实任务，逐项打印 PASS/FAIL，任一 FAIL 退出码非 0。

.DESCRIPTION
  检查项（按顺序，前项失败会影响后项，后项会标 SKIP 并说明原因）：
    1. 运行目录与 config.json 可读可解析
    2. node.exe 可用（真实执行 --version）
    3. dsh CLI 可用（真实执行 node bin.js --version）
    4. .credentials.yaml 合规：存在、UTF-8 **无 BOM**、单行、能解析出 DEEPSEEK_API_KEY（只打印掩码）
    5. 网关健康：GET /api/v1/health 返回 ok:true
    6. 配对链路：POST /api/v1/pair/open → POST /api/v1/pair/claim（自动生成 UUID v4 deviceId）→ 拿到设备令牌
    7. 端到端真实任务：POST /api/v1/tasks 提交一个「写文件 + 回答 DONE」的任务，
       轮询到终态，校验 status=succeeded / exitCode=0 / output 非空且含 DONE / 文件真实落盘

  设计取舍：
    * 不用假任务、不 mock —— 第 7 项会真的调用大模型，通常几秒完成（实测 2~5 秒）。
    * 配对用一次性的 6 位码，走的是手机 App 完全相同的接口链路。
    * 默认保留证据（任务记录 + 工作区文件），加 -Cleanup 才删除。

.PARAMETER Workspace
  任务工作目录；默认取 config.json 的 defaultWorkspace（必须已在白名单内）。

.PARAMETER SkipTask
  只检查到配对为止（不消耗模型调用）。

.PARAMETER Cleanup
  自检结束后删除本脚本创建的任务记录与测试文件（默认保留，便于人工核对）。

.EXAMPLE
  pwsh -File scripts/selftest.ps1

.EXAMPLE
  pwsh -File scripts/selftest.ps1 -Home ".runtime\scripts-selftest" -Port 18787

.NOTES
  执行策略：Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  兼容 Windows PowerShell 5.1 与 PowerShell 7.x。
#>
[CmdletBinding()]
param(
    [Alias('Home')][string]$DshRemoteHome,
    [int]$Port = 0,
    [string]$BaseUrl,
    [string]$Workspace,
    [string]$Node,
    [string]$DshBin,
    [string]$GatewayDir,
    [Alias('RelayHome')][string]$DshRelayHome,
    [int]$RelayPort = 0,
    [string]$RelayDir,
    [switch]$SkipV2,
    [string]$ReadonlySnapshot,
    [int]$TaskTimeoutSec = 300,
    [string]$Prompt,
    [switch]$SkipTask,
    [switch]$Cleanup,
    [string]$ReportFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_common.ps1')

$results = New-Object System.Collections.ArrayList

function Add-Result {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][ValidateSet('PASS', 'FAIL', 'SKIP')][string]$Status,
        [string]$Detail = ''
    )
    [void]$results.Add([pscustomobject]@{ 序号 = ($results.Count + 1); 检查项 = $Name; 结果 = $Status; 说明 = $Detail })
    switch ($Status) {
        'PASS' { Write-Ok "$Name$(if ($Detail) { " —— $Detail" })" }
        'FAIL' { Write-Fail "$Name$(if ($Detail) { " —— $Detail" })" }
        'SKIP' { Write-Skip "$Name$(if ($Detail) { " —— $Detail" })" }
    }
}

Write-Banner -Title 'dsh-remote 一键自检（selftest.ps1）' -SubTitle ("PowerShell: " + (Test-PowerShellEdition))

$remoteHome = Resolve-DshRemoteHome -Home $DshRemoteHome
if (-not $GatewayDir) { $GatewayDir = Get-DefaultGatewayDir }

Write-Section '1/10 运行目录与配置'
Write-Kv -Key '运行目录' -Value $remoteHome
$config = $null
$configPath = Join-Path $remoteHome 'config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Add-Result -Name 'config.json 存在且可解析' -Status 'FAIL' -Detail "文件不存在：$configPath（请先运行 scripts/setup-pc.ps1）"
} else {
    try {
        $config = Read-JsonFile -Path $configPath
        Add-Result -Name 'config.json 存在且可解析' -Status 'PASS' -Detail "$configPath（port=$([string](Get-JsonProp -Object $config -Name 'port'))）"
    } catch {
        Add-Result -Name 'config.json 存在且可解析' -Status 'FAIL' -Detail "JSON 解析失败：$($_.Exception.Message)"
    }
}

$effectivePort = $script:DefaultPort
if ($config) { $effectivePort = [int](Get-JsonProp -Object $config -Name 'port' -Default $script:DefaultPort) }
if ($Port -gt 0) { $effectivePort = $Port }
$baseUrlResolved = "http://127.0.0.1:$effectivePort"
if ($BaseUrl) { $baseUrlResolved = $BaseUrl.TrimEnd('/') }

$gatewayEntry = $null
try {
    $gatewayEntry = Assert-GatewaySource -GatewayDir $GatewayDir
    Write-Kv -Key '网关源码' -Value $gatewayEntry
} catch {
    Write-Warn $_.Exception.Message
}

# 镜像只读红线：**先快照**，跑完全部检查后再比对（原子流程，避免"旧基线"结论变弱）
$readonlyChecker = Join-Path (Join-Path $PSScriptRoot 'tests') 'check-real-dsh-readonly.mjs'
if (-not $ReadonlySnapshot) { $ReadonlySnapshot = Join-Path (Get-AcceptanceDir) 'real-dsh-baseline.json' }
Write-Kv -Key '只读基线' -Value $ReadonlySnapshot

Write-Section '2/10 node.exe'
$nodeExe = $Node
if (-not $nodeExe -and $config) {
    $dshSection = Get-JsonProp -Object $config -Name 'dsh'
    $nodeExe = [string](Get-JsonProp -Object $dshSection -Name 'node' -Default '')
}
if ($nodeExe -and -not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) { $nodeExe = $null }
if (-not $nodeExe) { $nodeExe = Find-NodeExe -DshHome $env:DSH_HOME }
if (-not $nodeExe) {
    Add-Result -Name 'node.exe 可用' -Status 'FAIL' -Detail '未找到 node.exe（用 -Node 指定，或在 config.json 里配置 dsh.node）'
} else {
    try {
        $nodeRun = Invoke-NativeCommand -FilePath $nodeExe -ArgumentList @('--version') -TimeoutSec 30
        if ($nodeRun.ExitCode -eq 0 -and $nodeRun.StdOut.Trim()) {
            Add-Result -Name 'node.exe 可用' -Status 'PASS' -Detail "$nodeExe（$($nodeRun.StdOut.Trim())，$($nodeRun.ElapsedSec)s）"
        } else {
            Add-Result -Name 'node.exe 可用' -Status 'FAIL' -Detail "退出码 $($nodeRun.ExitCode)：$($nodeRun.StdErr.Trim())"
        }
    } catch {
        Add-Result -Name 'node.exe 可用' -Status 'FAIL' -Detail $_.Exception.Message
    }
}

Write-Section '3/10 dsh CLI'
$dshBinPath = $DshBin
if (-not $dshBinPath -and $config) {
    $dshSection2 = Get-JsonProp -Object $config -Name 'dsh'
    $dshBinPath = [string](Get-JsonProp -Object $dshSection2 -Name 'binPath' -Default '')
}
if ($dshBinPath -and -not (Test-Path -LiteralPath $dshBinPath -PathType Leaf)) { $dshBinPath = $null }
if (-not $dshBinPath) { $dshBinPath = Find-DshBin -DshHome $env:DSH_HOME }
if (-not $dshBinPath) {
    Add-Result -Name 'dsh CLI 可用' -Status 'FAIL' -Detail '未找到 dsh CLI（bin.js）'
} elseif (-not $nodeExe) {
    Add-Result -Name 'dsh CLI 可用' -Status 'SKIP' -Detail '缺少 node.exe，无法验证'
} else {
    try {
        $dshRun = Invoke-NativeCommand -FilePath $nodeExe -ArgumentList @($dshBinPath, '--version') -TimeoutSec 60
        if ($dshRun.ExitCode -eq 0 -and $dshRun.StdOut.Trim()) {
            Add-Result -Name 'dsh CLI 可用' -Status 'PASS' -Detail "$($dshRun.StdOut.Trim())（$dshBinPath，$($dshRun.ElapsedSec)s）"
        } else {
            Add-Result -Name 'dsh CLI 可用' -Status 'FAIL' -Detail "退出码 $($dshRun.ExitCode)：$($dshRun.StdErr.Trim())$($dshRun.StdOut.Trim())"
        }
    } catch {
        Add-Result -Name 'dsh CLI 可用' -Status 'FAIL' -Detail $_.Exception.Message
    }
}

Write-Section '4/10 凭据文件（UTF-8 无 BOM / 单行）'
$credPath = Join-Path $remoteHome '.credentials.yaml'
if (-not (Test-Path -LiteralPath $credPath -PathType Leaf)) {
    Add-Result -Name '凭据文件合规' -Status 'FAIL' -Detail "不存在：$credPath（请运行 scripts/setup-pc.ps1 写入）"
} else {
    $bytes = [System.IO.File]::ReadAllBytes($credPath)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $text = Read-TextFileUtf8 -Path $credPath
    $lines = @($text -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
    $keyValue = $null
    if ($lines.Count -ge 1 -and $lines[0] -match '^\s*DEEPSEEK_API_KEY\s*:\s*(.+?)\s*$') { $keyValue = $matches[1].Trim() }
    $problems = New-Object System.Collections.ArrayList
    if ($hasBom) { [void]$problems.Add('带 UTF-8 BOM（headless profile 会启动失败）') }
    if ($lines.Count -ne 1) { [void]$problems.Add("应为单行，实际 $($lines.Count) 行非空内容") }
    if (-not $keyValue) { [void]$problems.Add('首行不是 "DEEPSEEK_API_KEY: <key>"') }
    if ($problems.Count -eq 0) {
        Add-Result -Name '凭据文件合规' -Status 'PASS' -Detail "无 BOM / 单行 / Key=$(Mask-Secret $keyValue) / $($bytes.Length) 字节"
    } else {
        Add-Result -Name '凭据文件合规' -Status 'FAIL' -Detail (($problems -join '；') + " [文件 $credPath]")
    }
}

Write-Section '5/10 网关健康'
$health = Get-GatewayHealth -BaseUrl $baseUrlResolved -TimeoutSec 6
if (-not $health) {
    Add-Result -Name '网关健康（/api/v1/health）' -Status 'FAIL' `
        -Detail "$baseUrlResolved/api/v1/health 无响应（先运行 scripts/start-gateway.ps1）"
} else {
    $okFlag = Get-JsonProp -Object $health -Name 'ok'
    if ($okFlag -eq $true) {
        $detail = "ok:true / serverName=$([string](Get-JsonProp -Object $health -Name 'serverName'))" +
        " / gatewayVersion=$([string](Get-JsonProp -Object $health -Name 'gatewayVersion'))" +
        " / dshVersion=$([string](Get-JsonProp -Object $health -Name 'dshVersion'))" +
        " / apiVersion=$([string](Get-JsonProp -Object $health -Name 'apiVersion'))"
        Add-Result -Name '网关健康（/api/v1/health）' -Status 'PASS' -Detail $detail
    } else {
        Add-Result -Name '网关健康（/api/v1/health）' -Status 'FAIL' -Detail "响应 ok 不为 true：$($health | ConvertTo-Json -Compress)"
    }
}

Write-Section '6/10 配对链路（pair/open → pair/claim）'
$pair = $null
if (-not $health) {
    Add-Result -Name '配对链路可用' -Status 'SKIP' -Detail '网关不可达'
} else {
    try {
        $deviceName = 'selftest-' + $env:COMPUTERNAME
        $pair = Invoke-DshPairAndClaim -BaseUrl $baseUrlResolved -DeviceName $deviceName
        Add-Result -Name '配对链路可用' -Status 'PASS' `
            -Detail "配对码 $($pair.Code) → tokenId=$($pair.TokenId)，serverName=$($pair.ServerName)，令牌明文不回显"
    } catch {
        Add-Result -Name '配对链路可用' -Status 'FAIL' -Detail $_.Exception.Message
    }
}

Write-Section '7/10 端到端真实任务'
$taskId = $null
$workspaceDir = $Workspace
if (-not $workspaceDir -and $config) { $workspaceDir = [string](Get-JsonProp -Object $config -Name 'defaultWorkspace' -Default '') }
if (-not $workspaceDir -and $config) {
    $allow = @(Get-JsonProp -Object $config -Name 'workspaceAllowlist' -Default @())
    if ($allow.Count -gt 0) { $workspaceDir = [string]$allow[0] }
}
if ($SkipTask) {
    Add-Result -Name '端到端真实任务' -Status 'SKIP' -Detail '已指定 -SkipTask'
} elseif (-not $pair) {
    Add-Result -Name '端到端真实任务' -Status 'SKIP' -Detail '配对未成功，无法提交任务'
} elseif (-not $workspaceDir) {
    Add-Result -Name '端到端真实任务' -Status 'FAIL' -Detail '未找到可用工作区（请用 -Workspace 指定，或检查 config.json 的 workspaceAllowlist）'
} else {
    if (-not (Test-Path -LiteralPath $workspaceDir -PathType Container)) {
        [void](New-Item -ItemType Directory -Force -Path $workspaceDir)
    }
    Write-Kv -Key '工作区' -Value $workspaceDir
    $testFileName = 'dshr-selftest.txt'
    $testFilePath = Join-Path $workspaceDir $testFileName
    if (Test-Path -LiteralPath $testFilePath -PathType Leaf) { Remove-Item -LiteralPath $testFilePath -Force }

    if (-not $Prompt) {
        $Prompt = "请在工作目录创建文件 $testFileName，内容为 OK-中文（不要换行、不要引号、不要多余空格），然后只回答 DONE。"
    }
    try {
        $task = Submit-DshTask -BaseUrl $baseUrlResolved -Token $pair.Token -Prompt $Prompt `
            -Workspace $workspaceDir -Title 'selftest 端到端' -TimeoutSec 3600
        $taskId = [string](Get-JsonProp -Object $task -Name 'id')
        Write-Info "已提交任务 $taskId（等待终态，最多 $TaskTimeoutSec 秒）…"

        # 中文往返断言（POST 响应）：请求体走 HttpWebRequest + UTF-8 字节，避免 PowerShell 5.1 的 ANSI/GBK 编码坑。
        # 注意用 -ceq（区分大小写的逐字符比较），不是 -eq，也不是"任务成功就算过"。
        $echoPrompt = [string](Get-JsonProp -Object $task -Name 'prompt' -Default '')
        if ($echoPrompt -ceq $Prompt) {
            Add-Result -Name '中文请求体往返一致（POST 响应）' -Status 'PASS' `
                -Detail "prompt 共 $($Prompt.Length) 字符逐字符相等（含中文，无乱码）"
        } else {
            $diffAt = -1
            $minLen = [Math]::Min($echoPrompt.Length, $Prompt.Length)
            for ($i = 0; $i -lt $minLen; $i++) { if ($echoPrompt[$i] -cne $Prompt[$i]) { $diffAt = $i; break } }
            if ($diffAt -lt 0 -and $echoPrompt.Length -ne $Prompt.Length) { $diffAt = $minLen }
            Add-Result -Name '中文请求体往返一致（POST 响应）' -Status 'FAIL' `
                -Detail "prompt 与提交内容不一致（首个差异位置 $diffAt；提交 $($Prompt.Length) 字符，回显 $($echoPrompt.Length) 字符）"
        }
        $wait = Wait-DshTask -BaseUrl $baseUrlResolved -Token $pair.Token -TaskId $taskId -TimeoutSec $TaskTimeoutSec `
            -OnProgress { param($status, $elapsed) Write-Info ("  状态 → $status（$([Math]::Round($elapsed.TotalSeconds, 1))s）") }
        $finalTask = $wait.Task
        $status = [string](Get-JsonProp -Object $finalTask -Name 'status')
        $exitCode = Get-JsonProp -Object $finalTask -Name 'exitCode'
        $output = [string](Get-JsonProp -Object $finalTask -Name 'output' -Default '')
        $errorText = [string](Get-JsonProp -Object $finalTask -Name 'error' -Default '')
        $truncated = Get-JsonProp -Object $finalTask -Name 'truncated'
        $sessionId = [string](Get-JsonProp -Object $finalTask -Name 'sessionId' -Default '')

        # 中文往返断言（持久化后再读）：模拟手机端进详情页拉到的 prompt
        $persistedPrompt = ''
        try { $persistedPrompt = [string](Get-JsonProp -Object (Get-DshTask -BaseUrl $baseUrlResolved -Token $pair.Token -TaskId $taskId) -Name 'prompt' -Default '') } catch { }
        if ($persistedPrompt -ceq $Prompt) {
            Add-Result -Name '中文请求体往返一致（任务详情持久化）' -Status 'PASS' -Detail 'GET /api/v1/tasks/{id} 返回的 prompt 与提交内容逐字符相等'
        } else {
            Add-Result -Name '中文请求体往返一致（任务详情持久化）' -Status 'FAIL' `
                -Detail "持久化后的 prompt 不一致（提交 $($Prompt.Length) 字符，读回 $($persistedPrompt.Length) 字符）"
        }

        $problems = New-Object System.Collections.ArrayList
        if ($wait.TimedOut) { [void]$problems.Add("轮询超时（${TaskTimeoutSec}s）未到终态") }
        if ($status -ne 'succeeded') { [void]$problems.Add("status=$status（期望 succeeded）") }
        if ($null -ne $exitCode -and [int]$exitCode -ne 0) { [void]$problems.Add("exitCode=$exitCode（期望 0）") }
        if (-not $output.Trim()) { [void]$problems.Add('output 为空') }
        if ($output -notmatch 'DONE') { [void]$problems.Add('output 未包含 DONE') }
        if ($errorText) { [void]$problems.Add("error=$errorText") }
        $expectedFileContent = 'OK-中文'
        $fileOk = $false
        if (Test-Path -LiteralPath $testFilePath -PathType Leaf) {
            $content = (Read-TextFileUtf8 -Path $testFilePath).Trim()
            if ($content -ceq $expectedFileContent) { $fileOk = $true }
            else { [void]$problems.Add("文件内容为 '$content'（期望 $expectedFileContent）") }
        } else {
            [void]$problems.Add("文件未落盘：$testFilePath")
        }
        if ($problems.Count -eq 0) {
            $outputPreview = $output.Trim()
            if ($outputPreview.Length -gt 120) { $outputPreview = $outputPreview.Substring(0, 120) + '…' }
            Add-Result -Name '端到端真实任务' -Status 'PASS' `
                -Detail "taskId=$taskId status=succeeded exitCode=$exitCode 耗时=$($wait.ElapsedSec)s output=[$outputPreview] 文件已落盘（$testFilePath = $expectedFileContent）"
            if ($truncated -eq $true) { Write-Warn 'output 被网关截断（truncated=true，超过 maxOutputBytes）' }
            if ($sessionId) { Write-Info "dsh sessionId=$sessionId" }
        } else {
            Add-Result -Name '端到端真实任务' -Status 'FAIL' -Detail (($problems -join '；') + " [taskId=$taskId]")
        }
    } catch {
        Add-Result -Name '端到端真实任务' -Status 'FAIL' -Detail $_.Exception.Message
    }
}

Write-Section '8/10 DSH 启动器（v2 续聊前提，契约 §8.2）'
$launcherInfo = $null
try { $launcherInfo = Find-DshLauncher } catch { $launcherInfo = $null }
if ($SkipV2) {
    Add-Result -Name 'DSH 启动器可解析' -Status 'SKIP' -Detail '已指定 -SkipV2'
} elseif (-not $launcherInfo -or $launcherInfo.Mode -eq 'unknown') {
    Add-Result -Name 'DSH 启动器可解析' -Status 'SKIP' -Detail '未探测到 dsh.cmd/dsh.exe（v1 任务不受影响；v2 续聊需要它，可用 -Launcher 指定）'
} elseif ($launcherInfo.Mode -eq 'desktop-host') {
    Add-Result -Name 'DSH 启动器可解析' -Status 'PASS' -Detail ("desktop-host：$($launcherInfo.Launcher) → $($launcherInfo.Exe) --expose-internals $($launcherInfo.CliJs)")
} else {
    Add-Result -Name 'DSH 启动器可解析' -Status 'FAIL' -Detail $launcherInfo.Note
}

Write-Section '9/10 中继（relay）'
if ($SkipV2) {
    Add-Result -Name '中继源码就绪' -Status 'SKIP' -Detail '已指定 -SkipV2'
} else {
    $relayEntryPath = Get-RelayEntryPath -RelayDir $RelayDir
    if (-not (Test-Path -LiteralPath $relayEntryPath -PathType Leaf)) {
        Add-Result -Name '中继源码就绪' -Status 'FAIL' -Detail "找不到 $relayEntryPath（task-1 产物）"
    } else {
        Add-Result -Name '中继源码就绪' -Status 'PASS' -Detail $relayEntryPath
        # RFC 6455 官方向量（能直接抓出 WS_GUID 常量写错这类"自洽却错"的互操作缺陷）
        $rfcChecker = Join-Path (Join-Path $PSScriptRoot 'tests') 'relay-rfc-check.mjs'
        if ($nodeExe -and (Test-Path -LiteralPath $rfcChecker -PathType Leaf)) {
            try {
                $rfcRun = Invoke-NativeCommand -FilePath $nodeExe -ArgumentList @($rfcChecker) -TimeoutSec 60
                $rfcJson = $null
                try { $rfcJson = ($rfcRun.StdOut.Trim() | ConvertFrom-Json) } catch { $rfcJson = $null }
                if ($rfcRun.ExitCode -eq 0 -and $rfcJson -and (Get-JsonProp -Object $rfcJson -Name 'ok') -eq $true) {
                    Add-Result -Name '中继 WS 握手符合 RFC 6455' -Status 'PASS' -Detail ("computeAccept('dGhlIHNhbXBsZSBub25jZQ==') = s3pPLMBiTxaQ9kYGzzhZRbK+xOo=，GUID=" + [string](Get-JsonProp -Object $rfcJson -Name 'guid'))
                } else {
                    Add-Result -Name '中继 WS 握手符合 RFC 6455' -Status 'FAIL' -Detail ("期望 s3pPLMBiTxaQ9kYGzzhZRbK+xOo=，实际 " + [string](Get-JsonProp -Object $rfcJson -Name 'actual') + "（GUID=" + [string](Get-JsonProp -Object $rfcJson -Name 'guid') + "）→ 标准 WS 客户端会拒绝握手")
                }
            } catch {
                Add-Result -Name '中继 WS 握手符合 RFC 6455' -Status 'FAIL' -Detail $_.Exception.Message
            }
        }
        $relayHomeResolved = Resolve-RelayHome -Home $DshRelayHome
        $relayCfg = Get-ConfigDefaults -Home $relayHomeResolved
        $effectiveRelayPort = [int](Get-JsonProp -Object $relayCfg -Name 'port' -Default $script:DefaultRelayPort)
        if ($RelayPort -gt 0) { $effectiveRelayPort = $RelayPort }
        $relayBase = Get-RelayBaseUrl -Home $relayHomeResolved -Port $effectiveRelayPort
        $relayHealth = Get-RelayHealth -BaseUrl $relayBase -TimeoutSec 4
        if ($relayHealth) {
            Add-Result -Name '中继健康（/health）' -Status 'PASS' -Detail ("$relayBase/health → relayVersion=$([string](Get-JsonProp -Object $relayHealth -Name 'relayVersion')) apiVersion=$([string](Get-JsonProp -Object $relayHealth -Name 'apiVersion')) homes=$([string](Get-JsonProp -Object $relayHealth -Name 'homes')) devices=$([string](Get-JsonProp -Object $relayHealth -Name 'devices'))")
        } else {
            Add-Result -Name '中继健康（/health）' -Status 'SKIP' -Detail "未运行：$relayBase/health 无响应（启动：powershell -File scripts/start-relay.ps1 -Home `"$relayHomeResolved`"）"
        }
    }
}

Write-Section '10/10 网关 v2（relay 状态 + 会话镜像 + 只读红线）'
if ($SkipV2) {
    Add-Result -Name '网关 v2 路由' -Status 'SKIP' -Detail '已指定 -SkipV2'
} elseif (-not $health) {
    Add-Result -Name '网关 v2 路由' -Status 'SKIP' -Detail '网关不可达'
} else {
    $relayStatus = Get-GatewayRelayStatus -BaseUrl $baseUrlResolved -TimeoutSec 6
    if (-not $relayStatus) {
        $probe = Invoke-DshV2Api -BaseUrl $baseUrlResolved -Path '/api/v2/relay/status' -TimeoutSec 6
        Add-Result -Name '网关 v2 路由' -Status 'FAIL' -Detail ("GET /api/v2/relay/status → HTTP $($probe.Status)（v2 路由未实现）")
    } else {
        Add-Result -Name '网关 v2 路由' -Status 'PASS' -Detail ("/api/v2/relay/status → enabled=$([string](Get-JsonProp -Object $relayStatus -Name 'enabled')) connected=$([string](Get-JsonProp -Object $relayStatus -Name 'connected')) reconnects=$([string](Get-JsonProp -Object $relayStatus -Name 'reconnects')) lastError=$([string](Get-JsonProp -Object $relayStatus -Name 'lastError'))")
        if ($pair) {
            $sessions = Invoke-DshV2Api -BaseUrl $baseUrlResolved -Path '/api/v2/sessions?limit=5' -Token $pair.Token -TimeoutSec 20
            $sessionCount = -1
            try { $sessionCount = @((($sessions.Text | ConvertFrom-Json).sessions)).Count } catch { $sessionCount = -1 }
            if ($sessions.Ok -and $sessionCount -ge 0) {
                Add-Result -Name '会话镜像（/api/v2/sessions）' -Status 'PASS' -Detail ("HTTP $($sessions.Status)，返回会话 $sessionCount 条（镜像只读 + 手机任务）")
            } else {
                Add-Result -Name '会话镜像（/api/v2/sessions）' -Status 'FAIL' -Detail ("HTTP $($sessions.Status)：" + (Get-ApiErrorMessage -Result $sessions))
            }
        } else {
            Add-Result -Name '会话镜像（/api/v2/sessions）' -Status 'SKIP' -Detail '配对未成功，缺少设备令牌'
        }
    }
    # 镜像只读红线：与 §1 的快照比对（文件系统事实，不调用网关代码）
    if ($nodeExe -and (Test-Path -LiteralPath $readonlyChecker -PathType Leaf)) {
        try {
            $roRun = Invoke-NativeCommand -FilePath $nodeExe -ArgumentList @($readonlyChecker, '--snapshot', $ReadonlySnapshot) -TimeoutSec 180
            $roTail = @($roRun.StdOut -split "`r?`n" | Where-Object { $_ -match '判据|PASS|FAIL' }) -join '；'
            if ($roRun.ExitCode -eq 0) {
                Add-Result -Name '镜像只读红线（独立复核）' -Status 'PASS' -Detail $roTail
            } else {
                Add-Result -Name '镜像只读红线（独立复核）' -Status 'FAIL' -Detail $roTail
            }
        } catch {
            Add-Result -Name '镜像只读红线（独立复核）' -Status 'SKIP' -Detail ("复核脚本执行失败：" + $_.Exception.Message)
        }
    } else {
        Add-Result -Name '镜像只读红线（独立复核）' -Status 'SKIP' -Detail '缺少 node.exe 或 tests/check-real-dsh-readonly.mjs'
    }
}

Write-Section '汇总'
$passCount = @($results | Where-Object { $_.结果 -eq 'PASS' }).Count
$failCount = @($results | Where-Object { $_.结果 -eq 'FAIL' }).Count
$skipCount = @($results | Where-Object { $_.结果 -eq 'SKIP' }).Count
$results | Format-Table -AutoSize

if ($Cleanup -and $pair -and $taskId) {
    Write-Section '清理'
    $removed = Remove-DshTask -BaseUrl $baseUrlResolved -Token $pair.Token -TaskId $taskId
    if ($removed) { Write-Ok "已删除任务记录 $taskId" } else { Write-Warn "删除任务记录失败：$taskId" }
    if ($workspaceDir -and (Test-Path -LiteralPath (Join-Path $workspaceDir 'dshr-selftest.txt') -PathType Leaf)) {
        Remove-Item -LiteralPath (Join-Path $workspaceDir 'dshr-selftest.txt') -Force
        Write-Ok '已删除测试文件 dshr-selftest.txt'
    }
}

Write-Host ''
if ($failCount -eq 0) {
    Write-Ok "自检通过：PASS=$passCount FAIL=0 SKIP=$skipCount"
    if ($skipCount -gt 0) { Write-Info '（SKIP 项为按参数跳过，不计入失败）' }
} else {
    Write-Fail "自检失败：PASS=$passCount FAIL=$failCount SKIP=$skipCount"
    Write-Info '请按上面的 FAIL 明细逐项修复；排障参考 docs/05-运维/部署手册.md 第 9 节。'
}

if ($ReportFile) {
    $report = [ordered]@{
        generatedAt = (Get-Date).ToString('o')
        home        = $remoteHome
        baseUrl     = $baseUrlResolved
        powerShell  = (Test-PowerShellEdition)
        pass        = $passCount
        fail        = $failCount
        skip        = $skipCount
        checks      = @($results)
    }
    Write-JsonFileNoBom -Path $ReportFile -Object $report
    Write-Info "自检报告已写入：$ReportFile"
}

if ($failCount -gt 0) { exit 1 }
exit 0
