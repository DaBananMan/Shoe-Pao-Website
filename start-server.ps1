# start-server.ps1
# Starts the Node.js server in the background (PowerShell). Logs are written to server.log
# Run from project root in an elevated PowerShell if needed.

$node = "node"
$script = Join-Path $PSScriptRoot 'server.js'
$log = Join-Path $PSScriptRoot 'server.log'

Write-Output "Starting ShoePao Node server: $script"
try{
    Start-Process -FilePath $node -ArgumentList "`"$script`"" -RedirectStandardOutput $log -RedirectStandardError $log -WindowStyle Hidden -NoNewWindow -PassThru | Out-Null
    Write-Output "Started. Logs: $log"
}catch{
    Write-Error "Failed to start Node server: $_"
}
