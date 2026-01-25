# Unregister the Scheduled Task created by register-startup.ps1
# Usage: .\unregister-startup.ps1

$taskName = 'ShoePaoNode'
try {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Output "Unregistered scheduled task '$taskName'."
    } else {
        Write-Output "Task '$taskName' not found."
    }
} catch {
    Write-Error "Failed to unregister scheduled task: $_"
}
