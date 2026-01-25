<#
node-watch.ps1
Simple supervisor loop to keep the Node server running. Designed for local dev.
It starts `start-node.ps1` (which launches Node) and restarts on unexpected exit
with an exponential backoff. Logs stdout/stderr to server-out.log / server-err.log.

Run this script once (or register via `register-startup.ps1`) to ensure Node
is kept running across crashes and reboots (task scheduler will restart at logon).
#>

[CmdletBinding()]
param(
    [int]$MaxRestartsPerHour = 20,
    [int]$InitialBackoffSeconds = 2
)

$projRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$projRoot = $projRoot.Path
$startScript = Join-Path $projRoot 'tools\start-node.ps1'
$outLog = Join-Path $projRoot 'server-out.log'
$errLog = Join-Path $projRoot 'server-err.log'
$pidFile = Join-Path $projRoot 'node.pid'

if (-not (Test-Path $startScript)) {
    Write-Error "start-node.ps1 not found at $startScript"
    exit 1
}

function Log($msg) { $t = Get-Date -Format o; Add-Content -Path $outLog -Value ("[$t] " + $msg) }
function LogErr($msg) { $t = Get-Date -Format o; Add-Content -Path $errLog -Value ("[$t] " + $msg) }

Log "node-watch started; using start script: $startScript"

$restartTimestamps = New-Object System.Collections.Generic.List[datetime]
$backoff = $InitialBackoffSeconds

while ($true) {
    try {
        # Start the node process via the start script — it will write node.pid
        Log "Invoking start script"
        $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`"" -WorkingDirectory $projRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
        if ($proc -and $proc.Id) { Log "Launched start script PID $($proc.Id)" } else { LogErr "Failed to launch start script" }

        # Wait for a short period for node.pid to appear
        $nodePid = $null
        for ($i=0; $i -lt 20; $i++) {
            if (Test-Path $pidFile) { $nodePid = (Get-Content $pidFile -ErrorAction SilentlyContinue) -as [string]; break }
            Start-Sleep -Milliseconds 250
        }

        if ($nodePid) {
            Log "Detected node PID: $nodePid. Monitoring process."
            # Monitor the node process; if it exits, continue to restart loop
            while ($true) {
                Start-Sleep -Seconds 1
                try { $p = Get-Process -Id $nodePid -ErrorAction SilentlyContinue } catch { $p = $null }
                if (-not $p) { LogErr "Node process $nodePid exited or not found"; break }
            }
        } else {
            # If no pid file, wait a short time and consider the start failed
            LogErr "node.pid not detected after start; treating as start failure"
            Start-Sleep -Seconds 1
        }

        # Record restart timestamp and enforce rate limiting
        $restartTimestamps.Add((Get-Date))
        # Remove timestamps older than one hour
        $cut = (Get-Date).AddHours(-1)
        $restartTimestamps.RemoveAll({ param($dt) $dt -lt $cut }) | Out-Null
        if ($restartTimestamps.Count -gt $MaxRestartsPerHour) {
            LogErr "Too many restarts in the last hour ($($restartTimestamps.Count)). Backing off for 10 minutes."
            Start-Sleep -Seconds 600
            $backoff = $InitialBackoffSeconds
        } else {
            # exponential backoff before next restart attempt
            Log "Restarting node after backoff ${backoff}s"
            Start-Sleep -Seconds $backoff
            $backoff = [Math]::Min($backoff * 2, 300)
        }
    } catch {
        LogErr "node-watch loop exception: $_"
        Start-Sleep -Seconds 10
    }
}
