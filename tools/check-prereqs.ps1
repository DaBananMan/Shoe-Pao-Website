<#
Simple prereq checker for ShoePao development on Windows.
Usage: run from project root or double-click in tools folder (PowerShell will open).
It checks for:
 - node.exe availability (Get-Command, where.exe, common Program Files, nvm-windows)
 - npm availability
 - PowerShell version
 - Git presence
It doesn't install anything, but prints guidance and URLs if items are missing.
#>

Write-Host "ShoePao prereq checker" -ForegroundColor Cyan

function Find-NodeExecutable {
    try { $cmd = Get-Command node -ErrorAction SilentlyContinue; if ($cmd -and $cmd.Path) { return $cmd.Path } } catch {}
    try { $where = & where.exe node 2>$null; if ($where) { return $where.Split("`n")[0].Trim() } } catch {}
    $common = @("$env:ProgramFiles\nodejs\node.exe","$env:ProgramFiles(x86)\nodejs\node.exe")
    foreach ($p in $common) { if (Test-Path $p) { return $p } }
    try{
        $nvmBase = Join-Path $env:USERPROFILE "AppData\Roaming\nvm"
        if (Test-Path $nvmBase) { $found = Get-ChildItem -Path $nvmBase -Recurse -Filter node.exe -ErrorAction SilentlyContinue | Select-Object -First 1; if ($found) { return $found.FullName } }
    } catch {}
    return $null
}

$nodePath = Find-NodeExecutable
if ($nodePath) {
    Write-Host "node.exe found:" $nodePath -ForegroundColor Green
    try { & $nodePath --version } catch {}
} else {
    Write-Host "node.exe not found." -ForegroundColor Yellow
    Write-Host "Recommended: Install Node.js LTS or nvm-windows. Links:" -ForegroundColor Cyan
    Write-Host " - Node.js LTS: https://nodejs.org/en/download/" -ForegroundColor White
    Write-Host " - nvm-windows (useful for multiple node versions): https://github.com/coreybutler/nvm-windows" -ForegroundColor White
}

# npm
try { $npm = Get-Command npm -ErrorAction SilentlyContinue; if ($npm -and $npm.Path) { Write-Host "npm found:" $npm.Path -ForegroundColor Green; & npm --version } else { Write-Host "npm not found." -ForegroundColor Yellow } } catch { Write-Host "npm check failed." -ForegroundColor Red }

# PowerShell
$psv = $PSVersionTable.PSVersion
Write-Host "PowerShell version:" $psv -ForegroundColor Green
if ($psv.Major -lt 5) { Write-Host "PowerShell 5.1 or newer recommended on Windows." -ForegroundColor Yellow }

# Git
try { $git = Get-Command git -ErrorAction SilentlyContinue; if ($git -and $git.Path) { Write-Host "git found:" $git.Path -ForegroundColor Green; & git --version } else { Write-Host "git not found." -ForegroundColor Yellow } } catch { Write-Host "git check failed." -ForegroundColor Red }

Write-Host "\nIf node/npm are missing you can run the project start helper: tools\\start-node.ps1 (Windows)." -ForegroundColor Cyan
Write-Host "Ensure you run PowerShell as Administrator when registering scheduled tasks or installing global software." -ForegroundColor Yellow

# Quick actionable tips file
$tips = @(
    "If you prefer nvm for Windows, install nvm-windows and then 'nvm install lts' and 'nvm use lts'.",
    "If you want to install Node manually, download the Node.js LTS Windows installer (MSI) and run it.",
    "After installing Node, open a new PowerShell and verify 'node -v' and 'npm -v'.",
    "If npm is present but 'node' missing, check your PATH or reinstall Node as npm is bundled with Node.js."
)

Write-Host "\nQuick tips:" -ForegroundColor Cyan
$tips | ForEach-Object { Write-Host " - $_" }

Write-Host "\nScript complete." -ForegroundColor Green
