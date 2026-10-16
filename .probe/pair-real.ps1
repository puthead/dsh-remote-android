# 一次性 E2E 辅助（不是交付物）：把模拟器 App 配对到**真实安装的网关**（经公网中继），
# 复现用户真机的完整链路：模拟器 → wss://123.207.183.237:9443 → PC 网关 8787（新代码）。
[CmdletBinding()]
param(
    [string]$Serial = 'emulator-5554',
    [string]$RelayUrl = 'wss://123.207.183.237:9443',
    [Parameter(Mandatory = $true)][string]$Code,
    [string]$Adb = 'D:\Workspace\dsh_android\.toolchain\android-dev\sdk\platform-tools\adb.exe',
    [string]$WorkDir = 'D:\Workspace\dsh_android\.probe\real-relay',
    [string]$ShotDir = 'D:\Workspace\dsh_android\android\evidence\v2.7.0\shots'
)
$ErrorActionPreference = 'Continue'
$Package = 'com.deepseek.dshremote.debug'
$Activity = "$Package/com.deepseek.dshremote.MainActivity"
New-Item -ItemType Directory -Force -Path $WorkDir, $ShotDir | Out-Null

function Get-Ui {
    & $Adb -s $Serial shell uiautomator dump /sdcard/dsh-ui.xml 2>&1 | Out-Null
    $local = Join-Path $WorkDir 'ui.xml'
    & $Adb -s $Serial pull /sdcard/dsh-ui.xml $local 2>&1 | Out-Null
    if (-not (Test-Path $local)) { return $null }
    return [xml][System.IO.File]::ReadAllText($local, (New-Object System.Text.UTF8Encoding($false)))
}
function Get-NodeCenter($doc, [string]$pattern) {
    if (-not $doc) { return $null }
    foreach ($n in $doc.SelectNodes('//node')) {
        $t = [string]$n.GetAttribute('text'); $d = [string]$n.GetAttribute('content-desc')
        if ($t -like "*$pattern*" -or $d -like "*$pattern*") {
            $b = [string]$n.GetAttribute('bounds')
            if ($b -match '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') {
                return [pscustomobject]@{ x = [int](([int]$Matches[1] + [int]$Matches[3]) / 2); y = [int](([int]$Matches[2] + [int]$Matches[4]) / 2); text = $t }
            }
        }
    }
    return $null
}
function Tap($doc, [string]$pattern) {
    $t = Get-NodeCenter $doc $pattern
    if (-not $t) { Write-Host "  [MISS] 未找到控件：$pattern"; return $false }
    & $Adb -s $Serial shell input tap $t.x $t.y 2>&1 | Out-Null
    Write-Host "  已点击「$($t.text)」($($t.x),$($t.y))"
    Start-Sleep -Milliseconds 900
    return $true
}
function Dismiss-Dialogs {
    for ($i = 0; $i -lt 3; $i++) {
        $doc = Get-Ui
        $t = Get-NodeCenter $doc 'Allow'; if (-not $t) { $t = Get-NodeCenter $doc '允许' }; if (-not $t) { $t = Get-NodeCenter $doc '确定' }
        if (-not $t) { return }
        & $Adb -s $Serial shell input tap $t.x $t.y 2>&1 | Out-Null
        Write-Host "  关闭系统弹窗「$($t.text)」"; Start-Sleep -Milliseconds 900
    }
}
function Save-Shot([string]$name) {
    $file = Join-Path $ShotDir "$name.png"
    $line = '"' + $Adb + '" -s ' + $Serial + ' exec-out screencap -p > "' + $file + '"'
    & cmd.exe /c $line | Out-Null
    Write-Host "  截图 $file ($((Get-Item $file -ErrorAction SilentlyContinue).Length) 字节)"
}
function Show-Texts($doc, [string]$title) {
    Write-Host "=== $title ==="
    if (-not $doc) { Write-Host "  (无 UI)"; return }
    foreach ($n in $doc.SelectNodes('//node')) { $t = [string]$n.GetAttribute('text'); if ($t) { Write-Host "  | $t" } }
}

Write-Host "=== 1. 清数据 + 冷启动（真实中继 $RelayUrl）==="
& $Adb -s $Serial shell pm clear $Package 2>&1 | Out-Null
& $Adb -s $Serial shell pm grant $Package android.permission.POST_NOTIFICATIONS 2>&1 | Out-Null
& $Adb -s $Serial logcat -c 2>&1 | Out-Null
Write-Host (& $Adb -s $Serial shell am start -W -n $Activity --es dsh_relay_url $RelayUrl --es dsh_pair_code $Code 2>&1 | Out-String)
Start-Sleep -Seconds 3; Dismiss-Dialogs
$doc = Get-Ui
Show-Texts $doc '2. 配对页文本'
Save-Shot '00-pair-real'
Tap $doc '配对并连接' | Out-Null
Start-Sleep -Seconds 5; Dismiss-Dialogs

Write-Host "=== 3. 等主界面（最多 60 秒）==="
$deadline = (Get-Date).AddSeconds(60); $ok = $false; $doc = $null
while ((Get-Date) -lt $deadline) {
    $doc = Get-Ui
    if ($doc -and (Get-NodeCenter $doc '电脑会话')) { $ok = $true; break }
    Start-Sleep -Milliseconds 1500
}
Write-Host "  主界面出现=$ok"
Save-Shot '01-sessions-real'
Show-Texts $doc '4. 会话列表文本'

Write-Host "=== 5. 相关日志 ==="
Write-Host (& $Adb -s $Serial logcat -d -t 400 2>&1 | Select-String -Pattern 'DshRemote|RelayClient|配对|CrashReporter|AndroidRuntime' | Out-String)
