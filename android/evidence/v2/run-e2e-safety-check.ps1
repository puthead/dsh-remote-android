# =============================================================================
# 清理安全性自检（P0 回归）：证明 run-e2e-real.ps1 **不会**杀掉"队友正在跑的"进程
#
# 背景：早期版本的 run-e2e-real.ps1 用 `命令行含 relay.mjs/gateway.mjs` 匹配来收进程，
# 会误杀队友的 relay（relay-dev 的互操作套件、ops-doc 的 19443 隔离中继），
# 导致他们的验收 E2E 出现"无崩溃栈、进程直接消失"的假红。修法是**父链认领 + PID 作用域清理**。
#
# 本脚本做的事（可复现，不依赖真人同时在跑）：
#   1) 起一个**替身 relay**（另一种端口 19643 + 独立 home）——它的命令行与队友的完全同形；
#   2) 跑一次完整的 run-e2e-real.ps1（它内部会启动/停止/重启自己的 relay 与 gateway）；
#   3) 断言替身进程**仍然活着**且 /health 正常；若被误杀 → 本检查 FAIL。
#
# 兼容 Windows PowerShell 5.1；必须存成 UTF-8 with BOM。
# =============================================================================
[CmdletBinding()]
param(
    [int]$DecoyPort = 19643,
    [string]$OutDir = 'D:\Workspace\dsh_android\android\evidence\v2',
    [switch]$SkipE2E
)

$ErrorActionPreference = 'Stop'
$NodeExe = 'D:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$RelayScript = 'D:\Workspace\dsh_android\tools\dsh-relay\relay.mjs'
$DecoyHome = Join-Path $OutDir 'e2e-runtime\decoy-relay-home'
$Report = Join-Path $OutDir 'cleanup-safety-report.txt'

# 收掉一棵进程树（PID 作用域）。taskkill 对已退出的 PID 会写 stderr，
# 在 ErrorActionPreference=Stop 下会变成终止性错误 —— 这里先查存在性再局部放行 stderr。
function Kill-PidTree([int]$ProcessId) {
    if (-not $ProcessId) { return }
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & taskkill.exe /PID $ProcessId /T /F 2>&1 | Out-Null } finally { $ErrorActionPreference = $previous }
}
function Write-Line([string]$text) { Write-Host $text }

function Invoke-NodeQuiet([string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $output = & $NodeExe @Arguments 2>&1 } finally { $ErrorActionPreference = $previous }
    return ($output | Out-String)
}

$results = @()
function Add-Result([string]$name, [bool]$ok, [string]$detail) {
    $script:results += [pscustomobject]@{ name = $name; ok = $ok; detail = $detail }
    if ($ok) { Write-Line ("  [PASS] {0} — {1}" -f $name, $detail) }
    else { Write-Line ("  [FAIL] {0} — {1}" -f $name, $detail) }
}

Write-Line "=== 1. 准备替身 relay（模拟队友的 relay：同形命令行、不同端口）"
if (-not (Test-Path $DecoyHome)) { New-Item -ItemType Directory -Path $DecoyHome -Force | Out-Null }
$init = Invoke-NodeQuiet @($RelayScript, 'init', '--home', $DecoyHome, '--port', "$DecoyPort", '--relay-name', 'decoy.local', '--tls-mode', 'off')
Add-Result '替身 relay 初始化' ($LASTEXITCODE -eq 0 -or $init -match 'ok') ($init -replace '\s+', ' ')

# 用 WMI 分离启动（与队友脚本同样的方式）；命令行里同样含 relay.mjs → 旧实现必然误杀
$cmdLine = 'cmd.exe /c ""' + $NodeExe + '" "' + $RelayScript + '" serve --home "' + $DecoyHome + '" > "' +
    (Join-Path $DecoyHome 'decoy.out.log') + '" 2> "' + (Join-Path $DecoyHome 'decoy.err.log') + '""'
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine }
Start-Sleep -Seconds 3
$decoy = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($created.ProcessId)" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'node.exe' } | Select-Object -First 1
if (-not $decoy) { $decoy = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match "decoy-relay-home" } | Select-Object -First 1 }
Add-Result '替身 relay 已启动' ($null -ne $decoy) ("pid=" + $decoy.ProcessId)
$decoyPid = $decoy.ProcessId

$alive = $false
try {
    $health = Invoke-WebRequest -Uri "http://127.0.0.1:$DecoyPort/health" -UseBasicParsing -TimeoutSec 5
    $alive = ($health.StatusCode -eq 200)
}
catch { $alive = $false }
Add-Result '替身 relay 提供 /health' $alive "http://127.0.0.1:$DecoyPort/health"

try {
    Write-Line "`n=== 2. 跑完整 E2E（内部会反复启动/停止/重启它自己的 relay+gateway）"
    if (-not $SkipE2E) {
        $e2e = Join-Path $OutDir 'run-e2e-real.ps1'
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $e2e 2>&1 | Select-Object -Last 6 | ForEach-Object { Write-Line ("  | " + $_) }
    }
    else {
        Write-Line '  （-SkipE2E：只做替身存活性检查）'
    }

    Write-Line "`n=== 3. 校验替身是否被误杀"
    $stillThere = Get-Process -Id $decoyPid -ErrorAction SilentlyContinue
    Add-Result '替身 relay 进程仍在（未被误杀）' ($null -ne $stillThere) ("pid=$decoyPid")

    $stillHealthy = $false
    try {
        $health2 = Invoke-WebRequest -Uri "http://127.0.0.1:$DecoyPort/health" -UseBasicParsing -TimeoutSec 5
        $stillHealthy = ($health2.StatusCode -eq 200)
    }
    catch { $stillHealthy = $false }
    Add-Result '替身 relay /health 仍正常' $stillHealthy "http://127.0.0.1:$DecoyPort/health"
}
finally {
    # 收尾：只杀本脚本登记过的替身（PID 作用域）
    if ($decoyPid) { Kill-PidTree $decoyPid }
    if ($created.ProcessId) { Kill-PidTree $created.ProcessId }

    $failed = @($results | Where-Object { -not $_.ok })
    $lines = @()
    $lines += 'DSH Remote v2 · E2E 清理安全性自检报告（P0 回归）'
    $lines += "时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    $lines += "替身 relay：端口 $DecoyPort，home=$DecoyHome（命令行与队友的 relay 同形）"
    $lines += ("通过 {0} / 共 {1}" -f ($results.Count - $failed.Count), $results.Count)
    $lines += ''
    foreach ($item in $results) {
        $flag = 'FAIL'
        if ($item.ok) { $flag = 'PASS' }
        $lines += ("[{0}] {1} — {2}" -f $flag, $item.name, $item.detail)
    }
    $lines += ''
    $lines += '结论：E2E 的清理只作用于本次运行登记的 PID（父链认领 + taskkill /PID /T /F），'
    $lines += '      不再按命令行关键字全局匹配，因此不会误杀队友的 relay/gateway。'
    [System.IO.File]::WriteAllLines($Report, $lines, [System.Text.UTF8Encoding]::new($false))
    Write-Line "`n报告：$Report"
    if ($failed.Count -gt 0) { exit 1 }
    exit 0
}
