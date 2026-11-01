# Keeps the laptop running when the lid is closed, so Claude sessions keep working.
# Run once in PowerShell (if it says "access denied", run PowerShell as Administrator).
#
#   .\1-lid-keep-running.ps1                 -> only while plugged in (recommended)
#   .\1-lid-keep-running.ps1 -AlsoOnBattery  -> also on battery
#
# Undo with .\undo-lid.ps1
param([switch]$AlsoOnBattery)

# LIDACTION values: 0 = do nothing, 1 = sleep, 2 = hibernate, 3 = shut down
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
if ($AlsoOnBattery) {
    powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
}

# Never idle-sleep while plugged in (the screen may still turn off; that is fine).
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP HYBRIDSLEEP 0

powercfg /setactive SCHEME_CURRENT

Write-Host ""
Write-Host "Done. Closing the lid now does nothing while plugged in." -ForegroundColor Green
if ($AlsoOnBattery) { Write-Host "Also on battery. Do NOT put the laptop in a bag while it runs - it will overheat." -ForegroundColor Yellow }
Write-Host "Battery low/critical actions are unchanged, so it still hibernates safely when the battery runs out."
