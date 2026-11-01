# Starts PocketDesk, the private laptop-to-phone hub. Safe to run again: it skips it if it is already running.
# It does NOT use Claude's own Remote Control: nothing is linked to any claude.ai account.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$pd   = Join-Path $root "pocketdesk"
$logs = Join-Path $pd "logs"
New-Item -ItemType Directory -Force $logs | Out-Null

$pdRunning = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*pocketdesk*server.js*" }
if ($pdRunning) {
    Write-Host "PocketDesk already running (PID $($pdRunning.ProcessId -join ', '))."
} else {
    Start-Process node -ArgumentList "`"$pd\server.js`"" -WorkingDirectory $pd -WindowStyle Hidden `
        -RedirectStandardOutput "$logs\pocketdesk.out.log" -RedirectStandardError "$logs\pocketdesk.err.log"
    Write-Host "PocketDesk started on http://127.0.0.1:8765" -ForegroundColor Green
}
