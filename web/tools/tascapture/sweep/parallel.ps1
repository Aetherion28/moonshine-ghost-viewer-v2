# Starts one sweep worker per physical core (or the number given), copying Dolphin-x64 for each extra worker.
param([int]$Workers = 0)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($Workers -le 0) { $Workers = [int]((Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum) }
Write-Host "starting $Workers workers"
Remove-Item -ErrorAction SilentlyContinue (Join-Path $here "stop.txt")
# end any old workers (and the Dolphin each is running) first, so each worker number runs once
foreach ($w in @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*run_worker.cmd*' })) { & taskkill.exe /T /F /PID $w.ProcessId | Out-Null }
Start-Sleep -Seconds 2
# runs that were going when the workers ended have no result: a RESET line frees them to run again
Add-Content -Path (Join-Path $here "sweep_claims.txt") -Value ("RESET | " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss"))
for ($i = 1; $i -lt $Workers; $i++) { $d = Join-Path $here "Dolphin-x64-w$i"; if (-not (Test-Path $d)) { Write-Host "copying Dolphin for worker $i"; Copy-Item -Recurse (Join-Path $here "Dolphin-x64") $d } }
for ($i = 0; $i -lt $Workers; $i++) { Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$(Join-Path $here "run_worker.cmd")`" $i" -WorkingDirectory $here -WindowStyle Hidden; Start-Sleep -Seconds 3 }
