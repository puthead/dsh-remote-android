@echo off
chcp 65001 >nul
title DSH Remote Gateway
echo ============================================================
echo   DSH Remote Gateway - keep this PC awake to command it from phone
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\Workspace\dsh_android\scripts\start-gateway.ps1"
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $h = Invoke-RestMethod -Uri http://127.0.0.1:8787/api/v1/health -TimeoutSec 8; Write-Host ('  [OK] gateway online: ' + $h.serverName + ' / dsh ' + $h.dshVersion) } catch { Write-Host '  [!!] gateway did not respond - see the error above' }"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-RestMethod -Uri http://127.0.0.1:8787/api/v2/relay/status -TimeoutSec 8; if ($r.connected) { Write-Host ('  [OK] relay connected: ' + $r.url) } else { Write-Host ('  [!!] relay not connected: ' + $r.lastError) } } catch { Write-Host '  [!!] relay status query failed' }"
echo.
echo   Starting the background watchdog (it re-launches the gateway if the process dies)...
start "DSH watchdog" /min "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "D:\Workspace\dsh_android\scripts\watchdog-gateway.ps1" -Home "C:\Users\Administrator\.dsh-remote" -IntervalSeconds 120 -Quiet
echo   [OK] watchdog requested (single instance: a second copy exits by itself).
echo.
echo   Phone relay address: wss://123.207.183.237:9443
echo   Closing this window does NOT stop the gateway (it runs in background).
echo   To stop the gateway:  powershell -File D:\Workspace\dsh_android\scripts\stop-gateway.ps1
echo   To stop the watchdog: powershell -File D:\Workspace\dsh_android\scripts\watchdog-gateway.ps1 -Stop
echo.
pause
