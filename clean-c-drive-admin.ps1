# C-drive cleanup (requires administrator rights).
# Cleans ONLY:
#   1) C:\Windows\SoftwareDistribution\Download  (downloaded Windows Update payloads, ~2.0 GB)
#   2) C:\Windows\Logs                           (CBS/DISM/WindowsUpdate logs, ~0.6 GB)
# Does NOT touch personal files or C:\Windows\Installer.
# ASCII only on purpose: Windows PowerShell 5.1 mis-decodes UTF-8-no-BOM files.
# Results are appended to clean-c-drive-admin.log next to this script.

$ErrorActionPreference = 'SilentlyContinue'

$log = 'D:\Workspace\dsh_android\clean-c-drive-admin.log'
Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue
function Log([string]$m) {
    $line = "[{0:HH:mm:ss}] {1}" -f (Get-Date), $m
    Write-Host $line
    Add-Content -LiteralPath $log -Value $line -Encoding ASCII
}

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Log ("Elevated={0}  User={1}  PS={2}" -f $elevated, $id.Name, $PSVersionTable.PSVersion)
if (-not $elevated) {
    Log "NOT elevated - aborting."
    exit 1
}

function SizeOf([string]$p) {
    if (Test-Path -LiteralPath $p) {
        $s = (Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue |
              Measure-Object -Property Length -Sum).Sum
        if ($s) { [int64]$s } else { 0 }
    } else { 0 }
}
function Purge([string]$p) {
    if (Test-Path -LiteralPath $p) {
        Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$free0 = (Get-Volume -DriveLetter C).SizeRemaining

# ---- 1) Windows Update download cache (stop the service first) ----
$wu = 'C:\Windows\SoftwareDistribution\Download'
$b = SizeOf $wu
Stop-Service wuauserv -Force
Stop-Service bits -Force
Purge $wu
Start-Service wuauserv
$a = SizeOf $wu
Log ("WindowsUpdateCache  before={0,7:N2} GB  after={1,7:N2} GB  freed={2,7:N2} GB" -f ($b/1GB), ($a/1GB), (($b-$a)/1GB))

# ---- 2) Windows logs ----
$lg = 'C:\Windows\Logs'
$b = SizeOf $lg
Purge $lg
$a = SizeOf $lg
Log ("WindowsLogs         before={0,7:N2} GB  after={1,7:N2} GB  freed={2,7:N2} GB" -f ($b/1GB), ($a/1GB), (($b-$a)/1GB))

$free1 = (Get-Volume -DriveLetter C).SizeRemaining
Log ("FreedThisRun={0:N2} GB  C_FreeNow={1:N2} GB  C_FreeBefore={2:N2} GB" -f (($free1-$free0)/1GB), ($free1/1GB), ($free0/1GB))
Log ("wuauserv={0}" -f (Get-Service wuauserv).Status)
Log "DONE"
