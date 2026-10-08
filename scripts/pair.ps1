#Requires -Version 5.1
<#
.SYNOPSIS
  在 PC 本机生成 6 位配对码（走 127.0.0.1 回环接口），并打印纯文本二维码 + 手输说明。

.DESCRIPTION
  * 调 POST http://127.0.0.1:<port>/api/v1/pair/open（契约 §2.1：配对码只能本机生成）。
  * 打印大号配对码、到期倒计时、以及手机该填的服务器地址。
  * 二维码：内置纯 PowerShell 实现（scripts/_qrcode.ps1），无第三方依赖；
    渲染前会跑自校验（Reed-Solomon 余式 + 格式信息 BCH + 结构不变量），
    自校验不通过就只打印配对码与手输说明，不打印可能扫不出来的图。
  * 二维码内容为 dshremote:pair?code=<code>&host=<addr>:<port>（ASCII，字节模式，纠错等级 L）。
    注意：当前 Android 客户端按契约只支持「手动输入 6 位码」，二维码是给人看的辅助信息，
    并未经过真机扫码实测（README 中已注明）。

.PARAMETER HostAddress
  二维码里给手机用的地址（默认自动探测本机内网 IPv4）。也可用 -BaseUrl 直接指定完整 URL。

.PARAMETER NoQr
  只打印配对码与说明，不生成二维码。

.PARAMETER Json
  额外输出机器可读的 JSON（code/expiresAt/serverHost/port），便于脚本串联。

.EXAMPLE
  pwsh -File scripts/pair.ps1

.EXAMPLE
  pwsh -File scripts/pair.ps1 -Port 18787 -HostAddress 192.168.1.23 -NoQr

.NOTES
  执行策略：Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  兼容 Windows PowerShell 5.1 与 PowerShell 7.x。
#>
[CmdletBinding()]
param(
    [Alias('Home')][string]$DshRemoteHome,
    [int]$Port = 0,
    [string]$BaseUrl,
    [string]$HostAddress,
    [switch]$NoQr,
    [switch]$AsciiQr,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_common.ps1')
. (Join-Path $PSScriptRoot '_qrcode.ps1')

function Get-LanAddress {
    <#
      探测本机内网 IPv4（优先有默认网关的网卡），供二维码内容与手输提示使用。
      探测不到时回退到计算机名。
    #>
    [CmdletBinding()]
    param()
    try {
        $configs = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue |
                Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.IPv4DefaultGateway -and $_.IPv4Address } |
                Sort-Object -Property InterfaceIndex)
        foreach ($cfg in $configs) {
            foreach ($addr in @($cfg.IPv4Address)) {
                $ip = [string]$addr.IPAddress
                if ($ip -and $ip -notlike '169.254.*' -and $ip -ne '127.0.0.1') { return $ip }
            }
        }
    } catch { }
    try {
        $ips = @([System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
                Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork })
        foreach ($ip in $ips) {
            $s = $ip.ToString()
            if ($s -notlike '169.254.*' -and $s -ne '127.0.0.1') { return $s }
        }
    } catch { }
    return $env:COMPUTERNAME
}

Write-Banner -Title 'dsh-remote 配对码生成（pair.ps1）' -SubTitle '本机回环调用 /api/v1/pair/open'

$remoteHome = Resolve-DshRemoteHome -Home $DshRemoteHome
$config = Get-ConfigDefaults -Home $remoteHome
$effectivePort = [int](Get-JsonProp -Object $config -Name 'port' -Default $script:DefaultPort)
if ($Port -gt 0) { $effectivePort = $Port }
$loopbackUrl = "http://127.0.0.1:$effectivePort"
if ($BaseUrl) { $loopbackUrl = $BaseUrl.TrimEnd('/') }

Write-Section '1/3 请求配对码'
Write-Kv -Key '运行目录' -Value $remoteHome
Write-Kv -Key '回环地址' -Value $loopbackUrl
$health = Get-GatewayHealth -BaseUrl $loopbackUrl -TimeoutSec 5
if (-not $health) {
    Write-Fail "网关未响应：$loopbackUrl/api/v1/health"
    Write-Info '请先启动网关：pwsh -File scripts/start-gateway.ps1'
    exit 1
}
Write-Ok ("网关在线：" + [string](Get-JsonProp -Object $health -Name 'serverName') +
    " / 网关版本 " + [string](Get-JsonProp -Object $health -Name 'gatewayVersion') +
    " / dsh " + [string](Get-JsonProp -Object $health -Name 'dshVersion'))

$pairOpen = Invoke-DshPairOpen -BaseUrl $loopbackUrl -TimeoutSec 10
$code = [string](Get-JsonProp -Object $pairOpen -Name 'code')
$expiresAt = Get-JsonProp -Object $pairOpen -Name 'expiresAt'
if ($code -notmatch '^\d{6}$') {
    Write-Fail "配对码格式异常（期望 6 位数字）：$code"
    exit 1
}

$expireTime = $null
$remainSec = 300
try {
    $expireTime = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$expiresAt).ToLocalTime()
    $remainSec = [int][Math]::Max(0, [Math]::Floor(($expireTime - [DateTimeOffset]::Now).TotalSeconds))
} catch { }

$serverHost = $HostAddress
if (-not $serverHost) { $serverHost = Get-LanAddress }
$serverUrl = "http://${serverHost}:$effectivePort"
$qrPayload = "dshremote:pair?code=$code&host=${serverHost}:$effectivePort"

Write-Section '2/3 配对码（请在手机 App 的「配对」页输入）'
Write-Host ''
$spaced = ($code.ToCharArray() -join '  ')
Write-Host ("        " + $spaced) -ForegroundColor Black -BackgroundColor White
Write-Host ''
Write-Kv -Key '配对码' -Value $code
if ($expireTime) {
    Write-Kv -Key '有效期至' -Value ("$($expireTime.ToString('yyyy-MM-dd HH:mm:ss'))（剩余约 $remainSec 秒）")
} else {
    Write-Kv -Key '有效期' -Value '默认 5 分钟，一次性使用'
}
Write-Kv -Key '手机填服务器地址' -Value $serverUrl
Write-Kv -Key '二维码内容' -Value $qrPayload

if ($NoQr) {
    Write-Section '3/3 二维码'
    Write-Skip '已指定 -NoQr：不生成二维码，请按上面的服务器地址 + 6 位配对码手动配对。'
} else {
    Write-Section '3/3 二维码（手机相机扫码，可选）'
    $qrOk = $false
    try {
        $matrix = New-QrMatrix -Text $qrPayload -EccLevel 'L' -MaxVersion 5
        $check = Test-QrSelfCheck -Matrix $matrix -Text $qrPayload
        if (-not $check.Ok) {
            Write-Warn '二维码自校验未通过，已放弃打印（避免给出扫不出来的图）：'
            foreach ($item in $check.Details) {
                if (-not $item.Passed) { Write-Info ("  - 失败项：" + $item.Name + " —— " + $item.Note) }
            }
        } else {
            Write-Info ("自校验通过：版本 $($matrix.Version) / 纠错 L / 掩码 $($matrix.Mask) / $($matrix.DataBytes) 字节，" +
                "矩阵 $($matrix.Size)x$($matrix.Size)")
            Write-Host ''
            Write-Host (Format-QrText -Matrix $matrix -QuietZone 4 -AsciiOnly:$AsciiQr) -ForegroundColor White
            Write-Host ''
            $qrOk = $true
        }
    } catch {
        Write-Warn ("二维码生成失败：" + $_.Exception.Message)
    }
    if (-not $qrOk) {
        Write-Info '不影响使用：直接用手输方式配对即可（6 位配对码 + 服务器地址）。'
    }
}

Write-Section '配对步骤'
Write-Info "1) 手机打开 DshRemote → 配置页"
Write-Info "2) 服务器地址填：$serverUrl"
Write-Info "3) 配对码填：$code（6 位，剩余约 $remainSec 秒）"
Write-Info "4) 点「配对」→ 成功后 App 会调 /api/v1/health 显示服务器名"
Write-Info '注意：配对码一次性使用；过期或已用请重新运行本脚本。'

if ($Json) {
    $payload = [ordered]@{
        code       = $code
        expiresAt  = $expiresAt
        remainSec  = $remainSec
        serverHost = $serverHost
        serverUrl  = $serverUrl
        qrPayload  = $qrPayload
        gateway    = $loopbackUrl
    }
    Write-Host ''
    Write-Host (ConvertTo-JsonText -InputObject $payload -Compress)
}
exit 0
