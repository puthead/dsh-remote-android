#Requires -Version 5.1
<#
.SYNOPSIS
  交付验收脚本：输出一张验收报告表（APK 路径/大小/sha256、网关健康、配对可用、端到端任务）。

.DESCRIPTION
  验收项：
    V1 APK 产物   —— 自动探测多个候选路径（release / debug / 递归查找），打印大小与 sha256
    V2 工具链     —— JDK / Android SDK / Gradle 目录是否存在（信息项，不影响退出码）
    V3 网关健康   —— GET /api/v1/health 返回 ok:true，并展示 serverName/gatewayVersion/dshVersion
    V4 配对可用   —— pair/open → pair/claim 走完整链路拿到设备令牌
    V5 端到端任务 —— 提交真实任务并等到 succeeded，校验 output 与落盘文件

  退出码：任一「失败」项 → 非 0；「跳过」项不计入失败（例如网关未运行时的任务项会标跳过，但网关健康本身已经失败）。

.PARAMETER ApkPath
  显式指定 APK 路径（默认自动探测）。

.PARAMETER SkipTask
  跳过端到端任务（只做静态验收）。

.EXAMPLE
  pwsh -File scripts/verify.ps1

.EXAMPLE
  pwsh -File scripts/verify.ps1 -ReportFile ".runtime\acceptance.json"

.NOTES
  执行策略：Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  兼容 Windows PowerShell 5.1 与 PowerShell 7.x。
#>
[CmdletBinding()]
param(
    [Alias('Home')][string]$DshRemoteHome,
    [int]$Port = 0,
    [string]$BaseUrl,
    [string]$ApkPath,
    [string]$Workspace,
    [int]$TaskTimeoutSec = 300,
    [switch]$SkipTask,
    [string]$ReportFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_common.ps1')

$repoRoot = Get-RepoRoot
$rows = New-Object System.Collections.ArrayList
$apkInfo = $null

function Add-Row {
    param(
        [Parameter(Mandatory = $true)][string]$Item,
        [Parameter(Mandatory = $true)][ValidateSet('PASS', 'FAIL', 'SKIP', 'INFO')][string]$Status,
        [string]$Evidence = ''
    )
    [void]$rows.Add([pscustomobject]@{ 验收项 = $Item; 结果 = $Status; 证据 = $Evidence })
    switch ($Status) {
        'PASS' { Write-Ok "$Item —— $Evidence" }
        'FAIL' { Write-Fail "$Item —— $Evidence" }
        'SKIP' { Write-Skip "$Item —— $Evidence" }
        default { Write-Info "$Item —— $Evidence" }
    }
}

Write-Banner -Title 'dsh-remote 交付验收（verify.ps1）' -SubTitle ("PowerShell: " + (Test-PowerShellEdition) + " / 仓库根 " + $repoRoot)

# ── V1 APK 产物 ───────────────────────────────────────────────────────────────
Write-Section 'V1 APK 产物'
$androidDir = Join-Path $repoRoot 'android'
$candidates = New-Object System.Collections.ArrayList
if ($ApkPath) {
    [void]$candidates.Add([System.IO.Path]::GetFullPath($ApkPath))
} else {
    $apkBase = Join-Path (Join-Path (Join-Path $androidDir 'app') 'build') 'outputs\apk'
    [void]$candidates.Add((Join-Path (Join-Path $apkBase 'release') 'app-release.apk'))
    [void]$candidates.Add((Join-Path (Join-Path $apkBase 'debug') 'app-debug.apk'))
    if (Test-Path -LiteralPath $androidDir -PathType Container) {
        foreach ($f in @(Get-ChildItem -LiteralPath $androidDir -Recurse -Filter '*.apk' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)) {
            [void]$candidates.Add($f.FullName)
        }
    }
}
$foundApk = $null
foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $foundApk = $candidate; break }
}
if ($foundApk) {
    $apkItem = Get-Item -LiteralPath $foundApk
    $sha = Get-FileSha256 -Path $foundApk
    $apkInfo = [ordered]@{
        path    = $apkItem.FullName
        relative = $apkItem.FullName.Substring($repoRoot.Length).TrimStart('\', '/')
        size    = $apkItem.Length
        sizeText = (Format-Bytes -Bytes $apkItem.Length)
        sha256  = $sha
        modifiedAt = $apkItem.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
    }
    Write-Kv -Key '路径' -Value $apkItem.FullName
    Write-Kv -Key '相对路径' -Value $apkInfo.relative
    Write-Kv -Key '大小' -Value $apkInfo.sizeText
    Write-Kv -Key 'SHA256' -Value $sha
    Write-Kv -Key '修改时间' -Value $apkInfo.modifiedAt
    Add-Row -Item 'V1 APK 产物' -Status 'PASS' -Evidence ("$($apkInfo.relative) / $($apkInfo.sizeText) / sha256=$($sha.Substring(0, 16))…")
} else {
    Write-Warn '已检查的候选路径：'
    foreach ($candidate in $candidates) { Write-Info "  - $candidate" }
    Add-Row -Item 'V1 APK 产物' -Status 'FAIL' -Evidence '未找到任何 APK（先执行 gradlew.bat :app:assembleDebug，或用 -ApkPath 指定）'
}

# ── V2 工具链（信息项）────────────────────────────────────────────────────────
Write-Section 'V2 工具链（信息项）'
$toolchainDir = Join-Path (Join-Path $repoRoot '.toolchain') 'android-dev'
$jdkDir = Join-Path $toolchainDir 'jdk17'
$sdkDir = Join-Path $toolchainDir 'sdk'
$gradleDir = Join-Path $toolchainDir 'gradle-8.9'
$toolchainParts = @()
foreach ($pair in @(@('JDK17', $jdkDir), @('Android SDK', $sdkDir), @('Gradle 8.9', $gradleDir))) {
    $exists = Test-Path -LiteralPath $pair[1] -PathType Container
    $toolchainParts += ("$($pair[0])=" + $(if ($exists) { '有' } else { '无' }))
}
Add-Row -Item 'V2 工具链目录' -Status 'INFO' -Evidence (($toolchainParts -join ' / ') + "（$toolchainDir）")

# ── 运行目录与网关地址 ────────────────────────────────────────────────────────
$remoteHome = Resolve-DshRemoteHome -Home $DshRemoteHome
$config = Get-ConfigDefaults -Home $remoteHome
$effectivePort = [int](Get-JsonProp -Object $config -Name 'port' -Default $script:DefaultPort)
if ($Port -gt 0) { $effectivePort = $Port }
$baseUrlResolved = "http://127.0.0.1:$effectivePort"
if ($BaseUrl) { $baseUrlResolved = $BaseUrl.TrimEnd('/') }
Write-Section '验收环境'
Write-Kv -Key '运行目录' -Value $remoteHome
Write-Kv -Key '网关地址' -Value $baseUrlResolved

# ── V3 网关健康 ───────────────────────────────────────────────────────────────
Write-Section 'V3 网关健康'
$health = Get-GatewayHealth -BaseUrl $baseUrlResolved -TimeoutSec 6
if ($health -and (Get-JsonProp -Object $health -Name 'ok') -eq $true) {
    $evidence = "serverName=$([string](Get-JsonProp -Object $health -Name 'serverName'))，gatewayVersion=$([string](Get-JsonProp -Object $health -Name 'gatewayVersion'))，dshVersion=$([string](Get-JsonProp -Object $health -Name 'dshVersion'))，uptimeMs=$([string](Get-JsonProp -Object $health -Name 'uptimeMs'))"
    Add-Row -Item 'V3 网关健康' -Status 'PASS' -Evidence $evidence
} else {
    Add-Row -Item 'V3 网关健康' -Status 'FAIL' -Evidence "$baseUrlResolved/api/v1/health 无响应或 ok!=true"
}

# ── V4 配对可用 ───────────────────────────────────────────────────────────────
Write-Section 'V4 配对可用'
$pair = $null
if (-not $health) {
    Add-Row -Item 'V4 配对可用' -Status 'SKIP' -Evidence '网关不可达'
} else {
    try {
        $pair = Invoke-DshPairAndClaim -BaseUrl $baseUrlResolved -DeviceName ('verify-' + $env:COMPUTERNAME)
        Add-Row -Item 'V4 配对可用' -Status 'PASS' -Evidence "pair/open 返回 6 位码，pair/claim 成功，tokenId=$($pair.TokenId)，serverName=$($pair.ServerName)"
    } catch {
        Add-Row -Item 'V4 配对可用' -Status 'FAIL' -Evidence $_.Exception.Message
    }
}

# ── V5 端到端任务 ─────────────────────────────────────────────────────────────
Write-Section 'V5 端到端任务'
$taskId = $null
$workspaceDir = $Workspace
if (-not $workspaceDir -and $config) { $workspaceDir = [string](Get-JsonProp -Object $config -Name 'defaultWorkspace' -Default '') }
if (-not $workspaceDir -and $config) {
    $allow = @(Get-JsonProp -Object $config -Name 'workspaceAllowlist' -Default @())
    if ($allow.Count -gt 0) { $workspaceDir = [string]$allow[0] }
}
if ($SkipTask) {
    Add-Row -Item 'V5 端到端任务' -Status 'SKIP' -Evidence '已指定 -SkipTask'
} elseif (-not $pair) {
    Add-Row -Item 'V5 端到端任务' -Status 'SKIP' -Evidence '配对不可用，无法提交任务'
} elseif (-not $workspaceDir) {
    Add-Row -Item 'V5 端到端任务' -Status 'FAIL' -Evidence '未找到可用工作区（config.json 的 workspaceAllowlist 为空）'
} else {
    if (-not (Test-Path -LiteralPath $workspaceDir -PathType Container)) { [void](New-Item -ItemType Directory -Force -Path $workspaceDir) }
    Write-Kv -Key '工作区' -Value $workspaceDir
    $testFile = Join-Path $workspaceDir 'dshr-verify.txt'
    if (Test-Path -LiteralPath $testFile -PathType Leaf) { Remove-Item -LiteralPath $testFile -Force }
    $prompt = '请在工作目录创建文件 dshr-verify.txt，内容为 VERIFY-OK（不要换行、不要引号），然后只回答 DONE。'
    try {
        $task = Submit-DshTask -BaseUrl $baseUrlResolved -Token $pair.Token -Prompt $prompt -Workspace $workspaceDir -Title 'verify 端到端'
        $taskId = [string](Get-JsonProp -Object $task -Name 'id')
        Write-Info "已提交任务 $taskId，等待终态（最多 $TaskTimeoutSec 秒）…"
        $wait = Wait-DshTask -BaseUrl $baseUrlResolved -Token $pair.Token -TaskId $taskId -TimeoutSec $TaskTimeoutSec `
            -OnProgress { param($status, $elapsed) Write-Info ("  状态 → $status（$([Math]::Round($elapsed.TotalSeconds, 1))s）") }
        $status = [string](Get-JsonProp -Object $wait.Task -Name 'status')
        $exitCode = Get-JsonProp -Object $wait.Task -Name 'exitCode'
        $output = [string](Get-JsonProp -Object $wait.Task -Name 'output' -Default '')
        $fileContent = ''
        if (Test-Path -LiteralPath $testFile -PathType Leaf) { $fileContent = (Read-TextFileUtf8 -Path $testFile).Trim() }
        $okAll = ($status -eq 'succeeded' -and -not $wait.TimedOut -and $output.Trim() -and $fileContent -eq 'VERIFY-OK')
        if ($okAll) {
            Add-Row -Item 'V5 端到端任务' -Status 'PASS' `
                -Evidence "taskId=$taskId，status=succeeded，exitCode=$exitCode，耗时=$($wait.ElapsedSec)s，文件已落盘（dshr-verify.txt=VERIFY-OK）"
        } else {
            $reason = "status=$status，exitCode=$exitCode，超时=$($wait.TimedOut)，文件内容='$fileContent'"
            Add-Row -Item 'V5 端到端任务' -Status 'FAIL' -Evidence "$reason（taskId=$taskId）"
        }
    } catch {
        Add-Row -Item 'V5 端到端任务' -Status 'FAIL' -Evidence $_.Exception.Message
    }
}

# ── 验收报告表 ────────────────────────────────────────────────────────────────
Write-Section '验收报告表'
$rows | Format-Table -AutoSize -Property 验收项, 结果, 证据 | Out-String -Width 400 | Write-Host

if ($apkInfo) {
    Write-Host '  APK 交付信息' -ForegroundColor Cyan
    Write-Host ("    路径   : " + $apkInfo.path)
    Write-Host ("    大小   : " + $apkInfo.sizeText)
    Write-Host ("    SHA256 : " + $apkInfo.sha256)
    Write-Host ("    时间   : " + $apkInfo.modifiedAt)
    Write-Host ''
}

$passCount = @($rows | Where-Object { $_.结果 -eq 'PASS' }).Count
$failCount = @($rows | Where-Object { $_.结果 -eq 'FAIL' }).Count
$skipCount = @($rows | Where-Object { $_.结果 -eq 'SKIP' }).Count
if ($failCount -eq 0) {
    Write-Ok "验收通过：PASS=$passCount FAIL=0 SKIP=$skipCount"
} else {
    Write-Fail "验收未通过：PASS=$passCount FAIL=$failCount SKIP=$skipCount"
}

if ($ReportFile) {
    $report = [ordered]@{
        generatedAt = (Get-Date).ToString('o')
        repoRoot    = $repoRoot
        home        = $remoteHome
        baseUrl     = $baseUrlResolved
        powerShell  = (Test-PowerShellEdition)
        apk         = $apkInfo
        pass        = $passCount
        fail        = $failCount
        skip        = $skipCount
        items       = @($rows)
    }
    Write-JsonFileNoBom -Path $ReportFile -Object $report
    Write-Info "验收报告已写入：$ReportFile"
}

if ($failCount -gt 0) { exit 1 }
exit 0
