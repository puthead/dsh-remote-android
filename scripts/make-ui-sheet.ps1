<#
.SYNOPSIS
  把逐屏截图拼成一张总览图（对标 docs/01-设计/原型/00-总览.png 的交付形态）。

.DESCRIPTION
  原型目录里的 `gen_00_sheet.py` 生成的是六图拼版，用来一眼看完整套界面。
  本脚本做同样的事，但直接吃真机截图：3 列 × N 行、每张下面带屏名，
  便于交付说明与前后对比（旧版 vs 新版）。

  注意：拼版只用于"看整体节奏"，**不能当验收依据** —— 原型 README 明确写着
  「只看缩略图不算验收」，细节要用 `scripts/crop-shot.ps1` 裁全分辨率再看。

.EXAMPLE
  & .\scripts\make-ui-sheet.ps1 -Shots @('01:android\evidence\ui\iter4\01-computer-sessions.png','02:...\05-session-detail.png') -Out android\evidence\ui\iter4\sheet.png -Title '方向 A 纯黑极简 · 实机截图'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string[]]$Shots,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Title = 'DSH 远程 · 实机截图',
  [string]$Subtitle = '',
  [int]$Columns = 3,
  [int]$Scale = 50,
  [int]$ColGap = 24,
  [int]$RowGap = 40,
  [int]$Margin = 32
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Get-CjkFont([single]$size, [System.Drawing.FontStyle]$style) {
  foreach ($name in @('Microsoft YaHei', 'Microsoft YaHei UI', 'SimHei', 'Arial')) {
    try { return New-Object System.Drawing.Font($name, $size, $style) } catch { }
  }
  return New-Object System.Drawing.Font([System.Drawing.FontFamily]::GenericSansSerif, $size, $style)
}

# 解析 '标签:路径' 或纯路径
$items = @()
foreach ($raw in $Shots) {
  $label = ''
  $path = $raw
  # 注意：$Matches 会被**每一次** -match 覆盖，所以必须先把第一组捕获取出来再判第二次，
  # 否则第二次 -match 之后 $Matches[1] 已经是新匹配里不存在的分组 → null。
  if ($raw -match '^([^:]{1,20}):(.+)$') {
    $candLabel = $Matches[1].Trim()
    $candPath = $Matches[2].Trim()
    if ($candPath -match '[\\/]') {
      $label = $candLabel
      $path = $candPath
    }
  }
  $full = (Resolve-Path -LiteralPath $path).Path
  if (-not $label) { $label = [System.IO.Path]::GetFileNameWithoutExtension($full) }
  $items += [pscustomobject]@{ Label = $label; Path = $full }
}
if ($items.Count -eq 0) { throw '没有可拼的截图' }

$s = $Scale / 100.0
$labelH = 34
$titleH = if ($Subtitle) { 92 } else { 60 }
$shotW = 0; $shotH = 0
$imgs = @()
foreach ($it in $items) {
  $img = [System.Drawing.Image]::FromFile($it.Path)
  $imgs += [pscustomobject]@{ Item = $it; Img = $img }
  $shotW = [Math]::Max($shotW, [int]($img.Width * $s))
  $shotH = [Math]::Max($shotH, [int]($img.Height * $s))
}

$rows = [Math]::Ceiling($items.Count / $Columns)
$cols = [Math]::Min($Columns, $items.Count)
$sheetW = $Margin * 2 + $cols * $shotW + ($cols - 1) * $ColGap
$sheetH = $Margin * 2 + $titleH + $rows * ($shotH + $labelH) + ($rows - 1) * $RowGap

$sheet = New-Object System.Drawing.Bitmap($sheetW, $sheetH)
$g = [System.Drawing.Graphics]::FromImage($sheet)
try {
  $g.Clear([System.Drawing.Color]::FromArgb(255, 0, 0, 0))
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

  $fTitle = Get-CjkFont 26 ([System.Drawing.FontStyle]::Bold)
  $fSub = Get-CjkFont 13 ([System.Drawing.FontStyle]::Regular)
  $fLabel = Get-CjkFont 15 ([System.Drawing.FontStyle]::Bold)
  $bTitle = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 236, 236, 236))
  $bSub = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 154, 154, 154))
  $bLabel = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 217, 119, 87))

  $g.DrawString($Title, $fTitle, $bTitle, $Margin, $Margin)
  if ($Subtitle) { $g.DrawString($Subtitle, $fSub, $bSub, ($Margin + 2), ($Margin + 40)) }

  for ($i = 0; $i -lt $imgs.Count; $i++) {
    $col = $i % $Columns
    $row = [Math]::Floor($i / $Columns)
    $x = $Margin + $col * ($shotW + $ColGap)
    $y = $Margin + $titleH + $row * ($shotH + $labelH + $RowGap)
    $dest = New-Object System.Drawing.Rectangle($x, $y, $shotW, $shotH)
    $g.DrawImage($imgs[$i].Img, $dest)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 42, 42, 42)), 1
    $g.DrawRectangle($pen, $dest)
    $pen.Dispose()
    $g.DrawString($imgs[$i].Item.Label, $fLabel, $bLabel, $x, ($y + $shotH + 6))
  }

  $outFull = [System.IO.Path]::GetFullPath($Out)
  $outDir = Split-Path -Parent $outFull
  if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
  $sheet.Save($outFull, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Host ("sheet: {0}  ({1}x{2}, {3} 屏)" -f $outFull, $sheetW, $sheetH, $imgs.Count)
} finally {
  $g.Dispose(); $sheet.Dispose()
  foreach ($it in $imgs) { $it.Img.Dispose() }
}
