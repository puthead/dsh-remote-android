<#
.SYNOPSIS
  从整屏截图里裁一条带出来看全分辨率细节（验收用）。

.DESCRIPTION
  原型 README 明确写着「只看缩略图不算验收」：1080x2340 的截图缩到预览尺寸后，
  1dp = 2.75px 的细线、10sp 的字号、细分割线全都会糊掉。这个脚本用 System.Drawing
  按原始像素裁一条带（可再放大 N 倍）出来，供逐像素比对。

.EXAMPLE
  & .\scripts\crop-shot.ps1 -Src android\evidence\ui\iter4\01-computer-sessions.png -Y0 2080 -Y1 2280 -Scale 2
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Src,
  [Parameter(Mandatory = $true)][int]$Y0,
  [Parameter(Mandatory = $true)][int]$Y1,
  [string]$Out,
  [int]$X0 = 0,
  [int]$X1 = 0,
  [int]$Scale = 1
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = (Resolve-Path -LiteralPath $Src).Path
$img = [System.Drawing.Image]::FromFile($src)
try {
  if ($X1 -le 0) { $X1 = $img.Width }
  $Y0 = [Math]::Max(0, $Y0)
  $Y1 = [Math]::Min($img.Height, $Y1)
  $w = $X1 - $X0
  $h = $Y1 - $Y0
  if ($w -le 0 -or $h -le 0) { throw "裁剪区域为空：X $X0..$X1, Y $Y0..$Y1（图 ${($img.Width)}x${($img.Height)}）" }

  $bmp = New-Object System.Drawing.Bitmap(($w * $Scale), ($h * $Scale))
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $dest = New-Object System.Drawing.Rectangle(0, 0, ($w * $Scale), ($h * $Scale))
    $srcrect = New-Object System.Drawing.Rectangle($X0, $Y0, $w, $h)
    $g.DrawImage($img, $dest, $srcrect, [System.Drawing.GraphicsUnit]::Pixel)
  } finally { $g.Dispose() }

  if (-not $Out) {
    $dir = Split-Path -Parent $src
    $base = [System.IO.Path]::GetFileNameWithoutExtension($src)
    $Out = Join-Path $dir ("{0}-crop-{1}-{2}.png" -f $base, $Y0, $Y1)
  }
  $outFull = [System.IO.Path]::GetFullPath($Out)
  $outDir = Split-Path -Parent $outFull
  if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
  $bmp.Save($outFull, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("crop : {0}  ->  {1}  ({2}x{3} @x{4})" -f $src, $outFull, $w, $h, $Scale)
} finally {
  $img.Dispose()
}
