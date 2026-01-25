# Register a Scheduled Task that runs start-node.ps1 at user logon
# Usage (run in PowerShell as the user who should own the task):
#   .\register-startup.ps1

$taskName = 'ShoePaoNode'
$projRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$projRoot = $projRoot.Path
$script = Join-Path $projRoot 'tools\start-node.ps1'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogon

try {
    # Register for current user. No password required when run as that user.
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Description "Start ShoePao Node server at user logon" -Force
    Write-Output "Registered scheduled task '$taskName'. It will run at next logon."
} catch {
    Write-Error "Failed to register scheduled task: $_"
}
