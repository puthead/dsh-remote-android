param(
  [string]$Marker = '测试越界写入审批重试',
  [string]$Out = 'D:\Workspace\dsh_android\android\evidence\approval\shots',
  [string]$Package = 'com.deepseek.dshremote.debug',
  [string]$Serial = ''
)

# 手机侧取证：把 App 导航到带 $Marker 标题的会话详情 → 拍「审批卡等待你响应」→ 点「允许一次」→ 拍提交后的样子。
# 复用 capture-ui.ps1 的 adb/dump 套路（PowerShell 5.1 + UTF-8 BOM）。

$ErrorActionPreference = 'Stop'
$adb = 'D:\Workspace\dsh_android\.toolchain\android-dev\sdk\platform-tools\adb.exe'
$script:Serial = $Serial
New-Item -ItemType Directory -Force -Path $Out | Out-Null

function Invoke-Adb {
  param([string[]]$AdbArgs)
  $all = @()
  if ($script:Serial) { $all += @('-s', $script:Serial) }
  $all += $AdbArgs
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $adb @all 2>&1 | ForEach-Object { "$_" } }
  finally { $ErrorActionPreference = $prev }
}

function Get-UiXml {
  $raw = 'D:\Workspace\dsh_android\.probe\ui-dump.xml'
  Invoke-Adb @('shell', 'uiautomator', 'dump', '/sdcard/ui.xml') | Out-Null
  Invoke-Adb @('pull', '/sdcard/ui.xml', $raw) | Out-Null
  return [xml](Get-Content -Raw -Encoding UTF8 $raw)
}

function Get-Nodes { param([xml]$Xml) return $Xml.SelectNodes('//node') }

function Tap-Node {
  param($Node, [string]$Label)
  if ($Node.bounds -notmatch '\[(\d+),(\d+)\]\[(\d+),(\d+)\]') { throw "无法解析 bounds：$($Node.bounds)" }
  $x = [int](([int]$Matches[1] + [int]$Matches[3]) / 2); $y = [int](([int]$Matches[2] + [int]$Matches[4]) / 2)
  Write-Host "tap : $Label @ $x,$y"
  Invoke-Adb @('shell', 'input', 'tap', "$x", "$y") | Out-Null
  Start-Sleep -Milliseconds 700
}

function Shot {
  param([string]$Name)
  Invoke-Adb @('shell', 'screencap', '-p', '/sdcard/shot.png') | Out-Null
  Invoke-Adb @('pull', '/sdcard/shot.png', (Join-Path $Out "$Name.png")) | Out-Null
  Write-Host "shot: $Name"
}

function Find-Text {
  param([xml]$Xml, [string]$Needle)
  foreach ($n in (Get-Nodes $Xml)) {
    if ($n.text -and $n.text.Contains($Needle)) { return $n }
  }
  return $null
}

Write-Host '=== 1. 启动 App ==='
Invoke-Adb @('shell', 'am', 'start', '-n', "$Package/com.deepseek.dshremote.MainActivity") | Out-Null
Start-Sleep -Seconds 5

Write-Host '=== 2. 切到「电脑会话」 ==='
$xml = Get-UiXml
$tab = Find-Text $xml '电脑会话'
if ($tab) { Tap-Node $tab '底栏「电脑会话」' } else { Write-Host 'warn: 未找到底栏文本，假设已在列表页' }
Start-Sleep -Seconds 3

Write-Host "=== 3. 找标题含 $Marker 的会话并按「全部」筛选 ==="
$xml = Get-UiXml
$all = Find-Text $xml '全部'
if ($all) { Tap-Node $all '筛选芯片「全部」' }
Start-Sleep -Seconds 2
$xml = Get-UiXml
$row = $null
foreach ($n in (Get-Nodes $xml)) {
  if ($n.text -and $n.text.Contains($Marker) -and $n.bounds -match '\[(\d+),(\d+)\]\[(\d+),(\d+)\]') {
    $h = [int]$Matches[4] - [int]$Matches[2]; $w = [int]$Matches[3] - [int]$Matches[1]
    Write-Host "candidate: '$($n.text.Substring(0, [Math]::Min(40, $n.text.Length)))' bounds=$($n.bounds) h=$h w=$w clickable=$($n.clickable)"
    # 文本节点本身通常不可点：向上找可点的整行祖先
    $cur = $n; $depth = 0
    while ($cur -and $depth -lt 6) {
      if ($cur.clickable -eq 'true' -and $cur.bounds -match '\[(\d+),(\d+)\]\[(\d+),(\d+)\]') {
        $ch = [int]$Matches[4] - [int]$Matches[2]; $cw = [int]$Matches[3] - [int]$Matches[1]
        Write-Host "  -> ancestor clickable bounds=$($cur.bounds) h=$ch w=$cw"
        if ($ch -ge 150 -and $cw -ge 600) { $row = $cur; break }
      }
      $cur = $cur.ParentNode; $depth++
    }
    if ($row) { break }
  }
}
if (-not $row) {
  $card = $null
  foreach ($n in (Get-Nodes $xml)) {
    if ($n.clickable -eq 'true' -and $n.bounds -match '\[(\d+),(\d+)\]\[(\d+),(\d+)\]') {
      $top = [int]$Matches[2]; $h = [int]$Matches[4] - $top; $w = [int]$Matches[3] - [int]$Matches[1]
      if ($top -gt 300 -and $h -ge 200 -and $w -ge 600) { $card = $n; break }
    }
  }
  if (-not $card) { throw "既没找到含 $Marker 的行，也没找到会话卡" }
  $row = $card
  Write-Host 'warn: 用「第一张会话卡」兜底'
}
Tap-Node $row '审批目标会话行'
Start-Sleep -Seconds 4

Write-Host '=== 4. 拍审批卡（应显示琥珀卡 + 允许一次/拒绝）==='
Shot '20-approval-asked'
$xml = Get-UiXml
$texts = (Get-Nodes $xml) | Where-Object { $_.text } | ForEach-Object { $_.text }
Write-Host ('屏幕文本：' + (($texts | Select-Object -First 25) -join ' | '))

Write-Host '=== 5. 点「允许一次」 ==='
$allow = Find-Text $xml '允许一次'
if (-not $allow) { throw '屏幕上没有「允许一次」——审批卡没出现（取证失败）' }
Tap-Node $allow '「允许一次」'
Start-Sleep -Seconds 3
Shot '21-after-allow'
$xml = Get-UiXml
$texts = (Get-Nodes $xml) | Where-Object { $_.text } | ForEach-Object { $_.text }
Write-Host ('提交后屏幕文本：' + (($texts | Select-Object -First 25) -join ' | '))
Write-Host '=== 完成：照片在 ' $Out ' ==='
