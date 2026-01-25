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

# Start the server via cmd.exe so npm start behaves as expected on Windows
$startCmd = "npm start"
$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList "/c $startCmd" -WorkingDirectory $projRoot -RedirectStandardOutput $logOut -RedirectStandardError $logErr -WindowStyle Hidden -PassThru

# Record PID
try{
    $proc.Id | Out-File -FilePath $pidFile -Encoding ascii -Force
    Write-Output "Started Node (via 'npm start') with PID $($proc.Id). Logs: $logOut and $logErr"
} catch {
    Write-Error "Started process but failed to write PID file: $_"
}
