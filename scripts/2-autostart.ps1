# Makes start-phone-access.ps1 run every time you log in to Windows (Startup folder shortcut, no admin needed).
#   .\2-autostart.ps1          -> turn on
#   .\2-autostart.ps1 -Remove  -> turn off
param([switch]$Remove)
$startup = [Environment]::GetFolderPath("Startup")
$lnk = Join-Path $startup "PocketDesk phone access.lnk"

if ($Remove) {
    if (Test-Path $lnk) { Remove-Item $lnk; Write-Host "Autostart removed." -ForegroundColor Green }
    else { Write-Host "Autostart was not set." }
    return
}

$script = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "start-phone-access.ps1"
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = (Get-Command powershell.exe).Source
$s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$s.WorkingDirectory = Split-Path -Parent $script
$s.WindowStyle = 7  # minimized
$s.Save()
Write-Host "Autostart on: $lnk" -ForegroundColor Green
