#Requires -Version 5.1
<#
.SYNOPSIS
  二维码实现的回归自检：内置自校验 + 与参考实现（python-qrcode）逐模块比对。

.DESCRIPTION
  scripts/_qrcode.ps1 是手写的 QR 编码器（字节模式 / 纠错等级 L / 版本 1~5）。
  本脚本用 tests/golden/ 下的「金标准矩阵」验证它——这些矩阵由 **python-qrcode**（成熟第三方实现）
  以完全相同的参数（payload / version / 纠错等级 / 掩码）生成，属于独立参考，不是自证。

  校验项：
    1. 矩阵尺寸 = 17 + 4×version
    2. Reed-Solomon 余式全 0（在 g(x) 的每个根处取值为 0）
    3. 格式信息两份拷贝 = BCH(15,5) 结果（含已知常量 L/掩码0 = 0x77C4）
    4. 与本实现矩阵逐模块比对金标准矩阵（不一致即失败）
    5. 渲染出的文本块尺寸 = 静默区 + 矩阵（防止 Format-QrText 回归）

.EXAMPLE
  pwsh -File scripts/tests/qr-selftest.ps1
  powershell -File scripts/tests/qr-selftest.ps1

.NOTES
  重新生成金标准（需要 python + qrcode）：
      pip install qrcode
      然后按 scripts/tests/golden/cases.json 中的 payload/version/mask 用
      qrcode.QRCode(version=..., error_correction=ERROR_CORRECT_L, border=0, mask_pattern=...)
      + QRData(payload, mode=MODE_8BIT_BYTE) 生成，写回同名文件。
  兼容 Windows PowerShell 5.1 与 PowerShell 7.x。
#>
[CmdletBinding()]
param(
    [string]$GoldenDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptsDir = Split-Path -Parent $PSScriptRoot
. (Join-Path $scriptsDir '_common.ps1')
. (Join-Path $scriptsDir '_qrcode.ps1')

Write-Banner -Title 'QR 编码器回归自检（scripts/tests/qr-selftest.ps1）' -SubTitle ("PowerShell: " + (Test-PowerShellEdition))

if (-not $GoldenDir) { $GoldenDir = Join-Path $PSScriptRoot 'golden' }
if (-not (Test-Path -LiteralPath $GoldenDir -PathType Container)) {
    throw "金标准目录不存在：$GoldenDir"
}

$casesFile = Join-Path $GoldenDir 'cases.json'
if (-not (Test-Path -LiteralPath $casesFile -PathType Leaf)) {
    throw "缺少用例清单：$casesFile"
}
$cases = @(Read-JsonFile -Path $casesFile)

$pass = 0
$fail = 0
Write-Section "用例（金标准来源：python-qrcode，目录 $GoldenDir）"
foreach ($case in $cases) {
    $payload = [string](Get-JsonProp -Object $case -Name 'payload')
    $version = [int](Get-JsonProp -Object $case -Name 'version')
    $mask = [int](Get-JsonProp -Object $case -Name 'mask')
    $goldenName = [string](Get-JsonProp -Object $case -Name 'golden')
    $expectedSize = [int](Get-JsonProp -Object $case -Name 'size')
    $goldenFile = Join-Path $GoldenDir $goldenName

    Write-Host ''
    Write-Host ("  ── v$version / 掩码 $mask / $($payload.Length) 字节：$payload") -ForegroundColor Cyan

    $matrix = New-QrMatrix -Text $payload -EccLevel 'L' -Version $version -MaskPattern $mask

    $checks = New-Object System.Collections.ArrayList
    [void]$checks.Add(@{ Name = '矩阵尺寸'; Ok = ($matrix.Size -eq (17 + 4 * $version) -and $matrix.Size -eq $expectedSize); Note = "$($matrix.Size)x$($matrix.Size)（期望 $expectedSize）" })
    [void]$checks.Add(@{ Name = 'Reed-Solomon 余式为 0'; Ok = [bool]$matrix.SelfCheck; Note = "版本 $version 纠错等级 L" })

    $selfCheck = Test-QrSelfCheck -Matrix $matrix -Text $payload
    [void]$checks.Add(@{ Name = '结构不变量（定位/时序/暗模块/格式信息）'; Ok = [bool]$selfCheck.Ok; Note = "$(@($selfCheck.Details).Count) 项" })

    $cmp = Compare-QrGoldenMatrix -Matrix $matrix -GoldenFile $goldenFile
    [void]$checks.Add(@{ Name = '与 python-qrcode 金标准逐模块一致'; Ok = [bool]$cmp.Ok; Note = "差异 $($cmp.Diffs)/$($cmp.Total) $($cmp.Note)" })

    $rendered = Format-QrText -Matrix $matrix -QuietZone 4
    $renderLines = @($rendered -split "`n")
    $expectedLines = $matrix.Size + 8
    $renderOk = ($renderLines.Count -eq $expectedLines -and $renderLines[0].Trim().Length -eq 0 -and $renderLines[4].Length -eq (($matrix.Size + 8) * 2))
    [void]$checks.Add(@{ Name = '文本渲染尺寸'; Ok = $renderOk; Note = "$($renderLines.Count) 行（期望 $expectedLines），单行 $($renderLines[4].Length) 字符" })

    foreach ($check in $checks) {
        if ($check.Ok) {
            Write-Ok ("$($check.Name)：$($check.Note)")
            $pass++
        } else {
            Write-Fail ("$($check.Name)：$($check.Note)")
            $fail++
        }
    }
}

Write-Section '汇总'
Write-Host ("  用例 $($cases.Count) 组，检查项 PASS=$pass FAIL=$fail") -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
if ($fail -gt 0) {
    Write-Fail 'QR 编码器自检未通过。'
    exit 1
}
Write-Ok 'QR 编码器自检全部通过（与独立参考实现逐模块一致）。'
exit 0
