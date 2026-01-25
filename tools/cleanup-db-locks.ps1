<#
tools/cleanup-db-locks.ps1

Attempt to safely stop the local Node server (if running via node.pid) and remove
SQLite shared-memory / WAL lock files that prevent opening the DB.

Usage: run from project root (or double-click in tools folder):
  powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\cleanup-db-locks.ps1

This script makes a best-effort to stop a Node process recorded in node.pid,
then retries to delete data/orders.db-shm and data/orders.db-wal. If files are
still locked, it prints guidance for identifying the locking process.
#>

Set-StrictMode -Version Latest

$projRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$projRoot = $projRoot.Path
$dataDir = Join-Path $projRoot 'data'
$shm = Join-Path $dataDir 'orders.db-shm'
$wal = Join-Path $dataDir 'orders.db-wal'
$pidFile = Join-Path $projRoot 'node.pid'

Write-Host "Running DB lock cleanup in: $projRoot" -ForegroundColor Cyan

function Stop-NodeIfRunning {
    if (Test-Path $pidFile) {
        try {
            $nodePid = (Get-Content $pidFile -ErrorAction SilentlyContinue).Trim()
            if ($nodePid -and ($nodePid -as [int])) {
                $nodePid = [int]$nodePid
                $p = Get-Process -Id $nodePid -ErrorAction SilentlyContinue
                if ($p) {
                    Write-Host "Stopping Node process with PID $nodePid..." -ForegroundColor Yellow
                    try { Stop-Process -Id $nodePid -Force -ErrorAction Stop; Start-Sleep -Milliseconds 500 } catch { Write-Host ("Failed to stop PID " + $nodePid + ": " + $_.ToString()) -ForegroundColor Red }
                } else {
                    Write-Host ("No process found with PID " + $nodePid + ". Removing stale PID file.") -ForegroundColor Yellow
                }
            }
        } catch { Write-Host ("Error reading PID file: " + $_.ToString()) -ForegroundColor Red }
        # remove stale pid file to avoid future confusion
        try { Remove-Item $pidFile -ErrorAction SilentlyContinue } catch {}
    } else {
        Write-Host "No node.pid file found; skipping Node stop." -ForegroundColor Gray
    }
}

function TryRemoveFileWithRetries([string]$path, [int]$attempts = 6, [int]$delaySeconds = 1) {
    for ($i=1; $i -le $attempts; $i++) {
        if (-not (Test-Path $path)) { Write-Host "No file: $path" -ForegroundColor Green; return $true }
        try {
            Remove-Item $path -Force -ErrorAction Stop
            Write-Host "Removed: $path" -ForegroundColor Green
            return $true
        } catch {
            Write-Host ("Attempt " + $i + ": failed to remove " + $path + " - " + $_.Exception.Message) -ForegroundColor Yellow
            Start-Sleep -Seconds $delaySeconds
        }
    }
    return $false
}

Stop-NodeIfRunning

$shmRemoved = TryRemoveFileWithRetries -path $shm -attempts 8 -delaySeconds 1
$walRemoved = TryRemoveFileWithRetries -path $wal -attempts 8 -delaySeconds 1

if ($shmRemoved -and $walRemoved) {
    Write-Host "DB lock files removed successfully." -ForegroundColor Green
    exit 0
}

Write-Host "\nOne or more DB lock files could not be removed." -ForegroundColor Red
Write-Host "Common causes: Node server still running, another process holding the file, or antivirus/file indexing locking the file." -ForegroundColor Yellow

# If Sysinternals handle.exe is available, try to list owners of the locked file
$handleExe = 'handle.exe'
if (Get-Command $handleExe -ErrorAction SilentlyContinue) {
    Write-Host "\nInvoking handle.exe to show processes holding locks (requires admin) ..." -ForegroundColor Cyan
    try { & $handleExe $shm } catch { Write-Host ("handle.exe invocation failed: " + $_.ToString()) -ForegroundColor Yellow }
} else {
    Write-Host "\nhandle.exe not found. To identify locking processes on Windows you can:" -ForegroundColor Cyan
    Write-Host " - Open Resource Monitor (resmon) -> CPU tab -> Associated Handles -> search for 'orders.db-shm'" -ForegroundColor White
    Write-Host " - Use Sysinternals 'Handle' utility: https://docs.microsoft.com/sysinternals/downloads/handle" -ForegroundColor White
    Write-Host " - Or reboot the machine to clear file locks if that's acceptable." -ForegroundColor White
}

Write-Host "\nIf you want me to attempt again after you stop any locking processes, run this script again." -ForegroundColor Cyan
exit 2
