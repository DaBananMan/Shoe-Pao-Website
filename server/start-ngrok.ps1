<#
Helper script to download and run ngrok for local webhook testing.

Usage:
  # from repo root
  powershell -ExecutionPolicy Bypass -File server/start-ngrok.ps1

What it does:
  - Downloads ngrok stable zip to server/.tools if not present
  - Extracts ngrok.exe to server/.tools
  - Runs `ngrok http 3000` and opens the forwarding URL in the console

Notes:
  - This script commits only the helper; it does NOT add ngrok binary to git.
  - If you prefer to install ngrok globally, skip this script and add ngrok to PATH.
#>

param(
  [int]$Port = 3000,
  [string]$ToolsDir = "$PSScriptRoot/.tools",
  [string]$NgrokZip = "ngrok-stable-windows-amd64.zip"
)

Set-StrictMode -Version Latest

if(-not (Test-Path $ToolsDir)){
  New-Item -Path $ToolsDir -ItemType Directory | Out-Null
}

$ngrokExe = Join-Path $ToolsDir 'ngrok.exe'

if(-not (Test-Path $ngrokExe)){
  Write-Host "ngrok not found in $ToolsDir — downloading..."
  $tmpZip = Join-Path $ToolsDir $NgrokZip
  $downloadUrl = 'https://bin.equinox.io/c/4VmDzA7iaHb/ngrok-stable-windows-amd64.zip'
  try{
    Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpZip -UseBasicParsing -ErrorAction Stop
    Write-Host "Downloaded to $tmpZip"
    Expand-Archive -Path $tmpZip -DestinationPath $ToolsDir -Force
    Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
    if(-not (Test-Path $ngrokExe)){
      Write-Error "ngrok.exe not found after extraction. Check permissions or download URL."
      exit 2
    }
  }catch{
    Write-Error "Failed to download or extract ngrok: $_"
    exit 1
  }
} else {
  Write-Host "Found ngrok at $ngrokExe"
}

# Run ngrok
Write-Host "Starting ngrok to forward port $Port... (press Ctrl+C to stop)"
& $ngrokExe http $Port
