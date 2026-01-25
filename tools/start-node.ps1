# Start the Node server for the ShoePao project in background and save PID
# Usage: run this script once (or let Task Scheduler run it at logon)

$projRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$projRoot = $projRoot.Path
$logOut = Join-Path $projRoot 'server-out.log'
$logErr = Join-Path $projRoot 'server-err.log'
$pidFile = Join-Path $projRoot 'node.pid'

# If a pid file exists and process is alive, do nothing
if (Test-Path $pidFile) {
    try {
        $existing = Get-Content $pidFile -ErrorAction Stop
        if ($existing -and (Get-Process -Id $existing -ErrorAction SilentlyContinue)) {
            Write-Output "Node already running with PID $existing"
            exit 0
        } else {
            Remove-Item $pidFile -ErrorAction SilentlyContinue
        }
    } catch {
        # continue
    }
}

# Ensure npm is available on PATH
$npm = 'npm'
try{
    $nodeCheck = & $npm -v 2>$null
} catch {
    Write-Error "npm not found in PATH. Please ensure Node.js and npm are installed and available in PATH."
    exit 1
}

# Try to locate node.exe
try{
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd -and $nodeCmd.Path) { $nodePath = $nodeCmd.Path }
    else {
        # fallback to where.exe
        try{ $where = & where.exe node 2>$null } catch { $where = $null }
        if ($where) { $nodePath = $where.Split("`n")[0].Trim() }
    }
} catch { $nodePath = $null }

if (-not $nodePath) {
    # Log a helpful error and exit
    $msg = "node executable not found in PATH. Please ensure Node.js is installed and available in PATH."
    try{ Add-Content -Path $logErr -Value ("[" + (Get-Date).ToString() + "] " + $msg) } catch {}
    Write-Error $msg
    exit 1
}

# Prefer running node directly with server.js so we capture the real node PID
$serverJs = Join-Path $projRoot 'server.js'
if (-not (Test-Path $serverJs)) {
    $msg = "server.js not found at $serverJs"
    try{ Add-Content -Path $logErr -Value ("[" + (Get-Date).ToString() + "] " + $msg) } catch {}
    Write-Error $msg
    exit 1
}

# Start the node process directly and capture its PID
try{
    $proc = Start-Process -FilePath $nodePath -ArgumentList $serverJs -WorkingDirectory $projRoot -RedirectStandardOutput $logOut -RedirectStandardError $logErr -WindowStyle Hidden -PassThru
    # Wait briefly for process to spawn
    Start-Sleep -Milliseconds 300
    $nodePid = $proc.Id
    # If the started process is a wrapper (like npm spawning node), attempt to find the child node process
    try{
        $childNode = Get-Process -Id $nodePid -ErrorAction SilentlyContinue
        if ($childNode -and $childNode.ProcessName -ne 'node') {
            # try to find node processes started after this time
            $since = (Get-Date).AddSeconds(-5)
            $nodes = Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $since }
            if ($nodes.Count -gt 0) { $nodePid = $nodes[0].Id }
        }
    } catch {}

    # Record PID
    try{
        $nodePid | Out-File -FilePath $pidFile -Encoding ascii -Force
        Write-Output "Started Node ($nodePath $serverJs) with PID $nodePid. Logs: $logOut and $logErr"
    } catch {
        Write-Error "Started process but failed to write PID file: $_"
    }
} catch {
    $msg = "Failed to start node: $_"
    try{ Add-Content -Path $logErr -Value ("[" + (Get-Date).ToString() + "] " + $msg) } catch {}
    Write-Error $msg
    exit 1
}
