@echo off
rem Convenience batch wrapper to start the Node server using the PowerShell helper.
rem Place this file in the same folder as start-node.ps1 (tools\)
set SCRIPT_DIR=%~dp0
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start-node.ps1" %*
exit /b %ERRORLEVEL%
