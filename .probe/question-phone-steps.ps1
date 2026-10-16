param(
  [string]$Title = '',
  [string]$Option = '生产',
  [string]$Out = 'D:\Workspace\dsh_android\android\evidence\approval\shots',
  [string]$Package = 'com.deepseek.dshremote.debug'
)

# 手机侧取证（提问）：进到标题含 $Title 的会话详情 → 拍提问卡 → 选项 → 提交 → 拍结果。
$ErrorActionPreference = 'Stop'
$adb = 'D:\Workspace\dsh_android\.toolchain\android-dev\sdk\platform-tools\adb.exe'
New-Item -ItemType Directory -Force -Path $Out | Out-Null

function Invoke-Adb {
  param([string[]]$AdbArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $adb @AdbArgs 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $prev }
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
function Shot { param([string]$Name)
  Invoke-Adb @('shell', 'screencap', '-p', '/sdcard/shot.png') | Out-Null
  Invoke-Adb @('pull', '/sdcard/shot.png', (Join-Path $Out "$Name.png")) | Out-Null
  Write-Host "shot: $Name"
}
function Get-Texts { param([xml]$Xml)
  return (Get-Nodes $Xml) | Where-Object { $_.text } | ForEach-Object { $_.text }
}
function Find-Text { param([xml]$Xml, [string]$Needle)
  foreach ($n in (Get-Nodes $Xml)) { if ($n.text -and $n.text.Contains($Needle)) { return $n } }
  return $null
}
function Tap-Row { param([xml]$Xml, [string]$Needle, [string]$Label)
  foreach ($n in (Get-Nodes $Xml)) {
    if ($n.text -and $n.text.Contains($Needle) -and $n.bounds -match '\[(\d+),(\d+)\]\[(\d+),(\d+)\]') {
      $cur = $n; $d = 0
      while ($cur -and $d -lt 6) {
        if ($cur.clickable -eq 'true' -and $cur.bounds -match '\[(\d+),(\d+)\]\[(\d+),(\d+)\]') {
          $ch = [int]$Matches[4] - [int]$Matches[2]; $cw = [int]$Matches[3] - [int]$Matches[1]
          if ($ch -ge 100 -and $cw -ge 400) { Tap-Node $cur $Label; return $true }
        }
        $cur = $cur.ParentNode; $d++
      }
    }
  }
  return $false
}

Write-Host '=== 1. 启动 App + 回列表 ==='
Invoke-Adb @('shell', 'am', 'start', '-n', "$Package/com.deepseek.dshremote.MainActivity") | Out-Null
Start-Sleep -Seconds 5
$xml = Get-UiXml
$tab = Find-Text $xml '电脑会话'
if ($tab) { Tap-Node $tab '底栏「电脑会话」' }
Start-Sleep -Seconds 3
$xml = Get-UiXml
$all = Find-Text $xml '全部'
if ($all) { Tap-Node $all '筛选芯片「全部」' }
Start-Sleep -Seconds 2

Write-Host "=== 2. 点开会话「$Title」 ==="
$xml = Get-UiXml
if (-not (Tap-Row $xml $Title '会话行')) {
  Write-Host 'warn: 列表里没有该会话，先点右上角刷新再试'
  $refreshed = $false
  foreach ($n in (Get-Nodes $xml)) {
    $desc = $n.GetAttribute('content-desc')
    if ($desc -and ($desc -like '*刷新*' -or $desc -like '*refresh*')) { Tap-Node $n "刷新（$desc）"; $refreshed = $true; break }
  }
  if (-not $refreshed) { Tap-Node ([pscustomobject]@{ bounds = '[650,180][690,266]' }) '刷新（坐标兜底）' }
  Start-Sleep -Seconds 5
  $xml = Get-UiXml
  if (-not (Tap-Row $xml $Title '会话行')) { Write-Host ('当前屏幕文本：' + ((Get-Texts $xml) -join ' | ')); throw "列表里没找到会话：$Title" }
}
Start-Sleep -Seconds 4

Write-Host '=== 3. 拍提问卡 ==='
Shot '30-question-asked'
$xml = Get-UiXml
$texts = Get-Texts $xml
Write-Host ('屏幕文本：' + (($texts | Select-Object -First 30) -join ' | '))

Write-Host "=== 4. 选「$Option」==="
$xml = Get-UiXml
if (-not (Tap-Row $xml $Option '选项')) { throw "屏幕上没有选项：$Option" }
Start-Sleep -Seconds 1
$xml = Get-UiXml
$texts = Get-Texts $xml
Write-Host ('选择后文本：' + (($texts | Select-Object -First 30) -join ' | '))

Write-Host '=== 5. 提交 ==='
$submitted = $false
# 必须**精确匹配**：提示行「…答完点「提交回答」…」也含这几个字，模糊匹配会点到提示文字上（已踩）。
foreach ($cand in @('提交回答', '提交答案', '提交', '发送答案', '发送')) {
  $xml = Get-UiXml
  $hit = $null
  foreach ($n in (Get-Nodes $xml)) { if ($n.text -and $n.text.Trim() -eq $cand) { $hit = $n; break } }
  if ($hit) {
    $cur = $hit; $d = 0
    while ($cur -and $d -lt 4) {
      if ($cur.clickable -eq 'true') { break }
      $cur = $cur.ParentNode; $d++
    }
    if ($cur -and $cur.clickable -eq 'true') { Tap-Node $cur "「$cand」（精确）"; $submitted = $true; Write-Host "已点：$cand"; break }
    Write-Host "warn: 找到文本「$cand」但没有可点祖先，跳过"
  }
}
if (-not $submitted) {
  Write-Host 'warn: 没找到提交类按钮，打印全部文本供判断'
  $xml = Get-UiXml
  Write-Host ((Get-Texts $xml) -join ' | ')
} else {
  Start-Sleep -Seconds 4
  Shot '31-after-answer'
  $xml = Get-UiXml
  Write-Host ('提交后文本：' + (((Get-Texts $xml) | Select-Object -First 30) -join ' | '))
}
Write-Host "=== 完成：照片在 $Out ==="
