# Puts the lid back to the Windows default: closing it sleeps the laptop.
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1
powercfg /setactive SCHEME_CURRENT
Write-Host "Lid close = sleep again (plugged in and on battery)." -ForegroundColor Green
