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

# Ensure npm is available on PATH (we'll use it as a fallback)
$npm = 'npm'
try{
    $npmVersion = & $npm -v 2>$null
} catch {
    $npmVersion = $null
}

# Helper: try multiple techniques to find node.exe
function Find-NodeExecutable {
    param()
    # 1) Get-Command
    try {
        $cmd = Get-Command node -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Path) { return $cmd.Path }
    } catch {}

    # 2) where.exe
    try{
        $where = & where.exe node 2>$null
        if ($where) { return $where.Split("`n")[0].Trim() }
    } catch {}

    # 3) Common install paths
    $common = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "$env:ProgramFiles(x86)\nodejs\node.exe"
    )
    foreach ($p in $common) { if (Test-Path $p) { return $p } }

    # 4) nvm-windows typical location under %USERPROFILE%\AppData\Roaming\nvm
    try{
        $nvmBase = Join-Path $env:USERPROFILE "AppData\Roaming\nvm"
        if (Test-Path $nvmBase) {
            # find any node.exe under that tree (versioned dirs)
            $found = Get-ChildItem -Path $nvmBase -Recurse -Filter node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($found -and $found.FullName) { return $found.FullName }
        }
    } catch {}

    return $null
}

# Locate node executable if possible
$nodePath = Find-NodeExecutable

if (-not $nodePath) {
    $msg = "node executable not found via Get-Command/where/common paths."
    if ($npmVersion) { $msg += " npm detected (version $npmVersion); will try 'npm start' as a fallback." }
    else { $msg += " Also, npm not found. Please install Node.js and npm or ensure they are on PATH." }
    try{ Add-Content -Path $logErr -Value ("[" + (Get-Date).ToString() + "] " + $msg) } catch {}
    Write-Output $msg
}

# Prefer running node directly with server.js so we capture the real node PID when possible
$serverJs = Join-Path $projRoot 'server.js'
if (-not (Test-Path $serverJs)) {
    $msg = "server.js not found at $serverJs"
    try{ Add-Content -Path $logErr -Value ("[" + (Get-Date).ToString() + "] " + $msg) } catch {}
    Write-Error $msg
    exit 1
}

# Helper to persist start metadata alongside numeric PID
function Write-StartInfo {
    param(
        [int]$processId,
        [string]$launcher,
        [string]$launcherPath
    )
    # Keep node.pid numeric for compatibility with other tools
    try{ $processId | Out-File -FilePath $pidFile -Encoding ascii -Force } catch {}
    # Write extra info to node.pid.info as JSON
    $infoFile = Join-Path $projRoot 'node.pid.info'
    $info = @{ startedAt = (Get-Date).ToString(); launcher = $launcher; launcherPath = $launcherPath; pid = $processId }
    try{ $info | ConvertTo-Json | Out-File -FilePath $infoFile -Encoding utf8 -Force } catch {}
}

if ($nodePath) {
    # Start the node process directly and capture its PID
    try{
        $proc = Start-Process -FilePath $nodePath -ArgumentList $serverJs -WorkingDirectory $projRoot -RedirectStandardOutput $logOut -RedirectStandardError $logErr -WindowStyle Hidden -PassThru
        # Wait briefly for process to spawn
        Start-Sleep -Milliseconds 500
        $nodePid = $proc.Id
        # If the started process is not 'node' (unlikely when starting node.exe directly), try to find an actual node child
        try{
            $started = Get-Process -Id $nodePid -ErrorAction SilentlyContinue
            if ($started -and $started.ProcessName -ne 'node') {
                $since = (Get-Date).AddSeconds(-10)
                $nodes = Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $since } | Sort-Object StartTime -Descending
                if ($nodes.Count -gt 0) { $nodePid = $nodes[0].Id }
            }
        } catch {}

    Write-StartInfo -processId $nodePid -launcher 'node' -launcherPath $nodePath
        Write-Output "Started Node ($nodePath $serverJs) with PID $nodePid. Logs: $logOut and $logErr"
    } catch {
        $msg = "Failed to start node directly: $_"
        try{ Add-Content -Path $logErr -Value ("[" + (Get-Date).ToString() + "] " + $msg) } catch {}
        Write-Error $msg
        exit 1
    }
} elseif ($npmVersion) {
    # Fall back to npm start
    try{
        $proc = Start-Process -FilePath $npm -ArgumentList 'start' -WorkingDirectory $projRoot -RedirectStandardOutput $logOut -RedirectStandardError $logErr -WindowStyle Hidden -PassThru
        Start-Sleep -Milliseconds 800
        $launcherPid = $proc.Id

        # Try to find a node child process started recently
        $since = (Get-Date).AddSeconds(-15)
        $nodes = Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $since } | Sort-Object StartTime -Descending
        if ($nodes.Count -gt 0) {
            $nodePid = $nodes[0].Id
            Write-StartInfo -processId $nodePid -launcher 'npm' -launcherPath (Get-Command $npm).Path
            Write-Output "Started via npm (PID $launcherPid). Detected node child PID $nodePid. Logs: $logOut and $logErr"
        } else {
            # No child node found; record npm PID so we can attempt cleanup later
            Write-StartInfo -processId $launcherPid -launcher 'npm' -launcherPath (Get-Command $npm).Path
            Write-Output "Started npm (PID $launcherPid). No node process detected yet; logs: $logOut and $logErr"
        }
    } catch {
        $msg = "Failed to start via npm: $_"
        try{ Add-Content -Path $logErr -Value ("[" + (Get-Date).ToString() + "] " + $msg) } catch {}
        Write-Error $msg
        exit 1
    }
} else {
    $msg = "No node.exe and no npm available to start the server."
    try{ Add-Content -Path $logErr -Value ("[" + (Get-Date).ToString() + "] " + $msg) } catch {}
    Write-Error $msg
    exit 1
}
