# Captures every split-sweep winner (winners.txt) that has no finished capture yet, up to six at once in the 3x2 grid.
# The sweep is paused while they run (each running sweep attempt finishes first) and goes on afterwards if it was running.
param([switch]$Quiet)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here 'captures'; $pause = Join-Path $here 'pause.txt'
$names = @(); if (Test-Path (Join-Path $here 'winners.txt')) { foreach ($l in Get-Content (Join-Path $here 'winners.txt')) { $n = ($l -split '\|')[1].Trim(); if ($n -and $names -notcontains $n) { $names += $n } } }
$todo = @($names | Where-Object { -not (Test-Path (Join-Path $out "$_.done")) })
if ($todo.Count -eq 0) { Write-Host ("No winners to capture (" + $names.Count + " winners, all captured)."); if (-not $Quiet) { Start-Sleep 8 }; exit }
Write-Host ("Capturing " + $todo.Count + ": " + ($todo -join ', '))
$wasPaused = Test-Path $pause
Set-Content -Path $pause -Value 'paused for the winners'' captures'
Write-Host 'Waiting for the sweep''s running attempts to finish...'
while (@(Get-Process Dolphin -ErrorAction SilentlyContinue | Where-Object { $_.Path -notlike '*Dolphin-x64-c*' }).Count -gt 0) { Start-Sleep 5 }
$slots = @($null) * 6; $i = 0
while ($i -lt $todo.Count -or @($slots | Where-Object { $_ -and -not $_.HasExited }).Count -gt 0) {
    for ($s = 0; $s -lt 6; $s++) {
        if ((-not $slots[$s] -or $slots[$s].HasExited) -and $i -lt $todo.Count) {
            $n = $todo[$i]; $i++
            Write-Host ((Get-Date -Format 'HH:mm:ss') + " start $n in cell $s")
            $slots[$s] = Start-Process -FilePath 'powershell.exe' -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $here 'capture_winner.ps1')`" -Name $n -Slot $s" -WorkingDirectory $here -WindowStyle Hidden -PassThru
            Start-Sleep 3
        }
    }
    Start-Sleep 5
}
foreach ($n in $todo) { Write-Host ("$n : " + $(if (Test-Path (Join-Path $out "$n.done")) { 'captured, captures\' + $n + '.bin' } else { 'FAILED (see captures\' + $n + '_log.txt)' })) }
if (-not $wasPaused) { Remove-Item -ErrorAction SilentlyContinue $pause; Write-Host 'The sweep goes on.' }
if (-not $Quiet) { Write-Host 'Done. Press Enter to close.'; [void](Read-Host) }
