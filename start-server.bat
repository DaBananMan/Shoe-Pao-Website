@echo off
REM start-server.bat
REM Starts the Node.js server in the background and redirects output to server.log
REM Usage: double-click or run from PowerShell/CMD in the project root

setlocal
set NODE_EXE=node
if exist "%~dp0\server-proxy-config.php" (
  REM If you want to hardcode a node path in server-proxy-config.php, that's honored by the PHP proxy.
)

echo Starting ShoePao Node server in background...
start "ShoePao Node" /B cmd /c "%NODE_EXE% "%~dp0server.js" > "%~dp0server.log" 2>&1"
echo Started. Logs: %~dp0server.log
endlocal
