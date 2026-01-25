# Stop the Node server started by start-node.ps1 (uses node.pid)
$projRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$projRoot = $projRoot.Path
$pidFile = Join-Path $projRoot 'node.pid'

if (Test-Path $pidFile) {
    $pidValue = (Get-Content $pidFile) -as [int]
    if ($pidValue -and (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $pidValue -Force
        Write-Output "Stopped process $pidValue"
    } else {
        Write-Output "No running process found for PID $pidValue"
    }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
} else {
    Write-Output "No PID file found at $pidFile"
}
