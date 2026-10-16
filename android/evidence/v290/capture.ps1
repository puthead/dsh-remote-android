#Requires -Version 5.1
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI when there is no BOM.
# Reason this helper exists: the emulator lags far behind state (EGL frame times of tens of seconds),
# so after every action we must wait for the frame to catch up before screenshotting.
param(
    [string]$Dir = $PSScriptRoot,
    [string]$Serial = 'emulator-5554'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$script:Adb = 'D:\Workspace\dsh_android\.toolchain\android-dev\sdk\platform-tools\adb.exe'
$script:Dir = $Dir
$script:Serial = $Serial

# NOTE: pass one single string. A trailing argument array let PowerShell eat flags like "-p"
# ("A parameter cannot be found that matches parameter name 'p'"), and the failure was silent
# because stderr is suppressed here - screencap never ran and every pull failed.
function Invoke-Adb {
    param([string]$Line)
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    $argv = @('-s', $script:Serial) + ($Line -split ' ')
    & $script:Adb @argv 2>$null | Out-Null
    $ErrorActionPreference = $saved
}

function Get-UiXml {
    param([string]$Tag = 'tmp')
    Invoke-Adb "shell uiautomator dump /sdcard/$Tag.xml"
    $local = Join-Path $script:Dir "$Tag.xml"
    Invoke-Adb "pull /sdcard/$Tag.xml `"$local`""
    return (Get-Content $local -Raw -Encoding UTF8)
}

function Get-UiTexts {
    param([string]$Tag = 'tmp')
    $xml = Get-UiXml -Tag $Tag
    return [regex]::Matches($xml, 'text="([^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Where-Object { $_ -ne '' }
}

function Get-UiDescs {
    param([string]$Tag = 'tmp')
    $xml = Get-UiXml -Tag $Tag
    return [regex]::Matches($xml, 'content-desc="([^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Where-Object { $_ -ne '' }
}

# center point of a node matched by exact-ish text or content-desc
function Find-Node {
    param([string]$Text, [string]$Desc, [string]$Tag = 'tmp')
    $xml = Get-UiXml -Tag $Tag
    $nodes = [regex]::Matches($xml, '<node[^>]*?/>')
    foreach ($n in $nodes) {
        $v = $n.Value
        $t = if ($v -match 'text="([^"]*)"') { $Matches[1] } else { '' }
        $d = if ($v -match 'content-desc="([^"]*)"') { $Matches[1] } else { '' }
        $hit = $false
        if ($Text -and $t -like $Text) { $hit = $true }
        if (-not $hit -and $Desc -and $d -like $Desc) { $hit = $true }
        if (-not $hit) { continue }
        if ($v -match 'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"') {
            $x1 = [int]$Matches[1]; $y1 = [int]$Matches[2]; $x2 = [int]$Matches[3]; $y2 = [int]$Matches[4]
            return [pscustomobject]@{
                Text = $t; Desc = $d
                X = [int](($x1 + $x2) / 2); Y = [int](($y1 + $y2) / 2)
                X1 = $x1; Y1 = $y1; X2 = $x2; Y2 = $y2
            }
        }
    }
    return $null
}

function Tap-Node {
    param([string]$Text, [string]$Desc, [string]$Tag = 'tmp')
    $n = Find-Node -Text $Text -Desc $Desc -Tag $Tag
    if (-not $n) { throw "node not found: text='$Text' desc='$Desc'" }
    Invoke-Adb "shell input tap $($n.X) $($n.Y)"
    return $n
}

function Tap-Xy {
    param([int]$X, [int]$Y)
    Invoke-Adb "shell input tap $X $Y"
}

function Swipe {
    param([int]$X1, [int]$Y1, [int]$X2, [int]$Y2, [int]$Ms = 300)
    Invoke-Adb "shell input swipe $X1 $Y1 $X2 $Y2 $Ms"
}

function Wait-Frame {
    param([int]$Seconds = 12)
    Start-Sleep -Seconds $Seconds
}

# capture until two consecutive frames are byte-identical
function Shot {
    param([string]$Name, [int]$Tries = 6, [int]$GapSeconds = 5)
    $prev = $null
    for ($i = 1; $i -le $Tries; $i++) {
        Invoke-Adb 'shell screencap -p /sdcard/shot.png'
        $out = Join-Path $script:Dir "$Name.png"
        Invoke-Adb "pull /sdcard/shot.png `"$out`""
        if (-not (Test-Path $out)) { throw "screencap/pull failed for $Name" }
        $hash = (Get-FileHash $out -Algorithm SHA256).Hash
        if ($prev -eq $hash) { Write-Output "Shot $Name stable after $i frame(s)"; return $out }
        $prev = $hash
        Start-Sleep -Seconds $GapSeconds
    }
    Write-Output "Shot $Name hit retry limit ($Tries)"
    return (Join-Path $script:Dir "$Name.png")
}

function Assert-Text {
    param([string]$Pattern, [string]$Tag = 'tmp', [switch]$Absent)
    $texts = Get-UiTexts -Tag $Tag
    $hit = @($texts | Where-Object { $_ -like $Pattern })
    if ($Absent) {
        if ($hit.Count -gt 0) { throw "assert failed: '$Pattern' should be absent, found $($hit.Count)" }
        Write-Output "OK absent: $Pattern"
        return
    }
    if ($hit.Count -eq 0) { throw "assert failed: '$Pattern' not found (texts: $($texts -join ' / '))" }
    Write-Output "OK found: $Pattern x$($hit.Count)"
}
