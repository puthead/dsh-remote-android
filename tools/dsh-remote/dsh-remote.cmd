@echo off
rem ============================================================================
rem  dsh-remote gateway launcher (Windows)
rem
rem  NOTE: this .cmd is intentionally ASCII-only. cmd.exe parses batch files in
rem  the OEM code page, so non-ASCII bytes here are unsafe on some locales.
rem  Chinese documentation lives in README.md and in the PowerShell scripts
rem  (which are UTF-8 with BOM, so Windows PowerShell 5.1 reads them correctly).
rem
rem  Why the DSH-bundled node.exe is preferred: the DSH runtime ships a fixed
rem  Node build (24.x). Using it keeps the gateway process and the dsh child
rem  processes on the same runtime regardless of the system PATH.
rem
rem  Usage:
rem    dsh-remote.cmd                    start the gateway (= serve)
rem    dsh-remote.cmd pair               print a pairing code
rem    dsh-remote.cmd devices list       list paired devices
rem    dsh-remote.cmd help               show help
rem ============================================================================
setlocal
set "SCRIPT_DIR=%~dp0"

set "NODE_EXE=%DSH_REMOTE_NODE%"
if not defined NODE_EXE set "NODE_EXE=D:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if exist "%NODE_EXE%" goto run

rem Fallback: use node.exe from PATH
for %%I in (node.exe) do set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE (
  echo [dsh-remote] node.exe not found. Set DSH_REMOTE_NODE to a Node 24 executable.
  exit /b 2
)

:run
"%NODE_EXE%" "%SCRIPT_DIR%gateway.mjs" %*
exit /b %ERRORLEVEL%
