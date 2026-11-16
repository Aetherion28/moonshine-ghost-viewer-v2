# The sweep's control window: Pause (no new attempt starts; the ones running finish) and Start (go on; starts the workers if none run or they are stuck).
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pause = Join-Path $here 'pause.txt'; $stop = Join-Path $here 'stop.txt'
function Workers { @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*run_worker.cmd*' }).Count }
function Lines($f) { if (Test-Path $f) { [IO.File]::ReadAllLines($f) } else { @() } }
function Idle { $l = Get-ChildItem (Join-Path $here 'sweep_log*.txt') | Sort-Object LastWriteTime | Select-Object -Last 1; if ($l) { ((Get-Date) - $l.LastWriteTime).TotalMinutes } else { 999 } }
$f = New-Object Windows.Forms.Form; $f.Text = 'Manta sweep'; $f.Size = New-Object Drawing.Size(460, 360); $f.TopMost = $true; $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false
$lab = New-Object Windows.Forms.Label; $lab.Location = New-Object Drawing.Point(15, 12); $lab.Size = New-Object Drawing.Size(420, 170); $lab.Font = New-Object Drawing.Font('Segoe UI', 10)
$bp = New-Object Windows.Forms.Button; $bp.Text = 'Pause'; $bp.Location = New-Object Drawing.Point(15, 195); $bp.Size = New-Object Drawing.Size(200, 50); $bp.Font = New-Object Drawing.Font('Segoe UI', 12, [Drawing.FontStyle]::Bold)
$bs = New-Object Windows.Forms.Button; $bs.Text = 'Start'; $bs.Location = New-Object Drawing.Point(235, 195); $bs.Size = New-Object Drawing.Size(200, 50); $bs.Font = $bp.Font
$bc = New-Object Windows.Forms.Button; $bc.Text = 'Capture winners'; $bc.Location = New-Object Drawing.Point(15, 255); $bc.Size = New-Object Drawing.Size(420, 40); $bc.Font = New-Object Drawing.Font('Segoe UI', 10)
$f.Controls.AddRange(@($lab, $bp, $bs, $bc))
function Refresh {
    $res = Lines (Join-Path $here 'sweep_results.txt'); $done = @($res | Where-Object { $_ -like 'split_*' }).Count
    $win = @(Lines (Join-Path $here 'winners.txt')).Count
    $cut = (Get-Date).AddHours(-1); $hour = 0
    foreach ($c in Lines (Join-Path $here 'sweep_claims.txt')) { $p = $c -split '\|'; if ($p.Count -ge 3 -and $p[0].Trim() -like 'split_*') { try { if ([datetime]::ParseExact($p[2].Trim(), 'yyyy-MM-dd HH:mm:ss', $null) -gt $cut) { $hour++ } } catch { } } }
    $w = Workers; $paused = Test-Path $pause; $idle = Idle
    $state = if ($paused) { if ($w -gt 0) { 'PAUSED (running attempts finish, no new ones start)' } else { 'PAUSED' } } elseif ($w -eq 0) { 'STOPPED (press Start)' } elseif ($idle -gt 5) { 'STUCK (no activity for ' + [math]::Round($idle) + ' min: press Start)' } else { 'RUNNING' }
    $eta = if ($hour -gt 0) { [math]::Round((32768 - $done) / $hour / 24, 1).ToString() + ' days at the last hour''s rate' } else { '-' }
    $lab.Text = "State: $state`nWorkers: $w`nSplit values done: $done of 32768`nStarted in the last hour: $hour`nLeft: $eta`nShine grabs: $win (winners.txt, sweep\winners)"
    $bc.Enabled = $win -gt 0; $bp.Enabled = -not $paused; $bs.Enabled = $paused -or $w -eq 0 -or $idle -gt 5
}
$bc.Add_Click({ Start-Process -FilePath 'cmd.exe' -ArgumentList "/c `"$(Join-Path $here 'capture_winners.cmd')`"" -WorkingDirectory $here })
$bp.Add_Click({ Set-Content -Path $pause -Value 'paused from the control window'; Refresh })
$bs.Add_Click({ Remove-Item -ErrorAction SilentlyContinue $pause, $stop
    if ((Workers) -eq 0 -or (Idle) -gt 5) { Start-Process -FilePath 'powershell.exe' -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $here 'parallel.ps1')`"" -WorkingDirectory $here -WindowStyle Hidden }
    Start-Sleep -Seconds 2; Refresh })
$t = New-Object Windows.Forms.Timer; $t.Interval = 5000; $t.Add_Tick({ Refresh }); $t.Start()
Refresh; [void]$f.ShowDialog()
