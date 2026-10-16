#Requires -Version 5.1
<#
.SYNOPSIS
  脚本静态校验：scripts/ 下所有 .ps1 必须是「UTF-8 带 BOM」且能通过 Windows PowerShell 5.1 解析器。

.DESCRIPTION
  为什么必须有这个脚本：
    * Windows PowerShell 5.1 只有在文件带 BOM 时才按 UTF-8 解析；否则按 ANSI(GBK) 解析，
      中文注释会直接变成语法错误（本项目已经踩过）。
    * PowerShell 7 不报错，所以「在我机器上能跑」不代表面向用户的 5.1 能跑。
  校验内容：
    1. 文件编码：前 3 字节必须是 EF BB BF（-FixBom 可自动补写 BOM）。
    2. 语法：用 [System.Management.Automation.Language.Parser]::ParseFile 解析，必须零错误。
    3. 兼容性：扫描 PS7-only 语法（?? / ?. / 三元 / -AdditionalChildPath / ForEach-Object -Parallel）。

.PARAMETER Path
  待校验目录（默认 scripts/）。

.PARAMETER FixBom
  对缺失 BOM 的 .ps1 自动补写 BOM（按 UTF-8 重新读取再以带 BOM 写回）。

.EXAMPLE
  powershell -File scripts/tests/check-scripts.ps1
.EXAMPLE
  powershell -File scripts/tests/check-scripts.ps1 -FixBom
#>
[CmdletBinding()]
param(
    [string]$Path,
    [switch]$FixBom
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Path) { $Path = Join-Path $repoRoot 'scripts' }
if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "目录不存在：$Path" }

Write-Host ''
Write-Host ('=' * 72) -ForegroundColor DarkCyan
Write-Host '  脚本静态校验（check-scripts.ps1）：UTF-8 BOM + 5.1 语法解析 + PS7-only 语法扫描' -ForegroundColor Cyan
Write-Host ('=' * 72) -ForegroundColor DarkCyan

$files = @(Get-ChildItem -LiteralPath $Path -Recurse -Filter '*.ps1' -File | Sort-Object FullName)
if ($files.Count -eq 0) { throw "在 $Path 下没有找到 .ps1 文件" }

$failures = New-Object System.Collections.ArrayList
$fixed = New-Object System.Collections.ArrayList

# PS7-only 语法（在 5.1 上要么直接语法错误、要么运行期参数不存在）
# 扫描前会剔除注释与字符串字面量（用解析器的 token 流），否则本文件与 _common.ps1 的
# 说明文字会把自己的模式匹配出来，产生假失败。
$ps7Patterns = @(
    @{ Name = '空合并 ?? 或 ??='; Pattern = '\?\?' }
    @{ Name = '空条件访问 ?.'; Pattern = '\?\.[A-Za-z_]' }
    @{ Name = 'ForEach-Object -Parallel'; Pattern = '-Parallel\b' }
    @{ Name = 'Get-ChildItem -AdditionalChildPath'; Pattern = '-AdditionalChildPath' }
    @{ Name = 'ConvertFrom-Json -AsHashtable'; Pattern = 'ConvertFrom-Json[^\r\n]{0,80}-AsHashtable' }
    @{ Name = 'Join-String（PS7 新增）'; Pattern = '\bJoin-String\b' }
    @{ Name = 'Test-Json（PS7 新增）'; Pattern = '\bTest-Json\b' }
)

$excludedTokenKinds = @(
    [System.Management.Automation.Language.TokenKind]::Comment,
    [System.Management.Automation.Language.TokenKind]::StringLiteral,
    [System.Management.Automation.Language.TokenKind]::StringExpandable,
    [System.Management.Automation.Language.TokenKind]::HereStringLiteral,
    [System.Management.Automation.Language.TokenKind]::HereStringExpandable
)

foreach ($file in $files) {
    $relative = $file.FullName.Substring($repoRoot.Length).TrimStart('\', '/')
    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)

    if (-not $hasBom) {
        if ($FixBom) {
            # 注意：这里必须显式按 UTF-8 读取（文件本身就是 UTF-8，只是缺 BOM）
            $text = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
            $enc = New-Object System.Text.UTF8Encoding($true)
            [System.IO.File]::WriteAllText($file.FullName, $text, $enc)
            [void]$fixed.Add($relative)
            Write-Host ("  [FIX ] 已补写 UTF-8 BOM：$relative") -ForegroundColor Yellow
            $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
            $hasBom = $true
        } else {
            [void]$failures.Add("$relative —— 缺少 UTF-8 BOM（加 -FixBom 自动修复）")
            Write-Host ("  [FAIL] 缺少 UTF-8 BOM：$relative") -ForegroundColor Red
            continue
        }
    }

    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    if ($errors -and $errors.Count -gt 0) {
        $messages = @($errors | ForEach-Object { "第 $($_.Extent.StartLineNumber) 行：$($_.Message)" })
        [void]$failures.Add("$relative —— 语法错误：" + ($messages -join '；'))
        Write-Host ("  [FAIL] 语法错误：$relative") -ForegroundColor Red
        foreach ($m in $messages) { Write-Host ("         $m") -ForegroundColor DarkYellow }
        continue
    }

    # 只扫描「代码 token」：剔除注释与字符串字面量，避免说明文字造成假失败
    $codeText = (@($tokens |
            Where-Object { $excludedTokenKinds -notcontains $_.Kind } |
            ForEach-Object { $_.Text }) -join ' ')
    $hits = New-Object System.Collections.ArrayList
    foreach ($rule in $ps7Patterns) {
        if ($codeText -match $rule.Pattern) { [void]$hits.Add($rule.Name) }
    }
    if ($hits.Count -gt 0) {
        [void]$failures.Add("$relative —— 含 PS7-only 语法：" + ($hits -join '、'))
        Write-Host ("  [FAIL] PS7-only 语法：$relative（" + ($hits -join '、') + "）") -ForegroundColor Red
        continue
    }

    Write-Host ("  [PASS] $relative（UTF-8 BOM / 5.1 解析通过 / 无 PS7-only 语法）") -ForegroundColor Green
}

Write-Host ''
Write-Host ("  校验文件数：$($files.Count)    自动修复：$($fixed.Count)    失败：$($failures.Count)")
if ($failures.Count -gt 0) {
    Write-Host ''
    foreach ($f in $failures) { Write-Host ("  [FAIL] $f") -ForegroundColor Red }
    exit 1
}
Write-Host '  全部通过。' -ForegroundColor Green
exit 0
