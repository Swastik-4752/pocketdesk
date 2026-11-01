# Private network between your laptop and your phone (Tailscale), and shares PocketDesk on it.
# Only devices signed in to YOUR Tailscale account can reach it. Nothing is opened to the internet.
#
#   .\3-tailscale.ps1          -> install (if needed) + share PocketDesk
#   .\3-tailscale.ps1 -Stop    -> stop sharing PocketDesk
param([switch]$Stop)
$ts = "C:\Program Files\Tailscale\tailscale.exe"

if ($Stop) {
    & $ts serve reset
    Write-Host "PocketDesk is no longer shared on Tailscale." -ForegroundColor Green
    return
}

if (-not (Test-Path $ts)) {
    Write-Host "Installing Tailscale (Windows will ask for permission)..." -ForegroundColor Cyan
    $winget = (Get-Command winget -ErrorAction SilentlyContinue).Source
    if (-not $winget) { $winget = "$env:LOCALAPPDATA\Microsoft\WindowsApps\winget.exe" }
    & $winget install --id Tailscale.Tailscale -e --accept-source-agreements --accept-package-agreements
    if (-not (Test-Path $ts)) { Write-Host "Install did not finish. Run this script again." -ForegroundColor Red; return }
}

$status = & $ts status --json 2>$null | ConvertFrom-Json
if (-not $status -or $status.BackendState -ne "Running") {
    Write-Host ""
    Write-Host "Sign in to Tailscale now with YOUR PERSONAL account (not the college one)." -ForegroundColor Yellow
    Write-Host "A browser window will open. Come back here when it says you are connected."
    & $ts up
    $status = & $ts status --json 2>$null | ConvertFrom-Json
}
if (-not $status -or $status.BackendState -ne "Running") { Write-Host "Tailscale is not connected yet. Run this script again after signing in." -ForegroundColor Red; return }

# HTTPS on the private network -> PocketDesk on this laptop. (First time, Tailscale may ask you to enable HTTPS
# certificates for your tailnet: follow the link it prints, click Enable, then run this script again.)
& $ts serve --bg 8765
$name = $status.Self.DNSName.TrimEnd('.')
Write-Host ""
Write-Host "Done. Phone address:  https://$name" -ForegroundColor Green
Write-Host "On your phone: install Tailscale, sign in with the SAME account, then open that address."
