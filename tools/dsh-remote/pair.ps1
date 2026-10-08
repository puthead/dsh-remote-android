<#
.SYNOPSIS
    在 PC 本机生成 6 位配对码（调用网关的本地回环接口，不经过局域网）。

.DESCRIPTION
    契约 §2.1 要求配对码只能由 PC 本机生成，因此本脚本只访问 127.0.0.1。
    为什么不在脚本里直接读网关内部状态：配对码是"活"的一次性凭据，
    必须由正在运行的网关进程生成，脚本只做触发与展示。

.PARAMETER Port
    网关端口，默认 8787。

.PARAMETER Config
    网关配置文件路径；默认取脚本同目录（tools/dsh-remote）下的 config.json，
    用于在端口被 --port 覆盖时读出实际端口。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\pair.ps1
    powershell -ExecutionPolicy Bypass -File .\pair.ps1 -Port 8788
#>
[CmdletBinding()]
param(
    [int]$Port = 8787,
    [string]$Config
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Config) { $Config = Join-Path $scriptDir 'config.json' }
if (Test-Path -LiteralPath $Config) {
    try {
        $cfg = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -ne $cfg.port) { $Port = [int]$cfg.port }
    } catch {
        Write-Warning "读取配置文件失败，改用默认端口 $Port：$($_.Exception.Message)"
    }
}

$uri = "http://127.0.0.1:$Port/api/v1/pair/open"
Write-Host "正在向 $uri 申请配对码…" -ForegroundColor Cyan

try {
    $resp = Invoke-RestMethod -Method Post -Uri $uri -TimeoutSec 10
} catch {
    Write-Host ""
    Write-Host "生成配对码失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "请确认网关已在运行：tools\dsh-remote\dsh-remote.cmd serve" -ForegroundColor Yellow
    exit 1
}

$expires = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$resp.expiresAt).LocalDateTime
$remaining = [int][Math]::Max(0, ($expires - (Get-Date)).TotalSeconds)

Write-Host ""
Write-Host "  配对码（在手机 App 的配对页面输入）：" -ForegroundColor Green
Write-Host ""
Write-Host "        $($resp.code)" -ForegroundColor White -BackgroundColor DarkBlue
Write-Host ""
Write-Host "  有效期至：$($expires.ToString('yyyy-MM-dd HH:mm:ss'))（剩余约 $remaining 秒）" -ForegroundColor Gray
Write-Host "  一次性使用；过期或已使用请重新运行本脚本。" -ForegroundColor Gray
Write-Host ""
