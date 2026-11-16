# The sweep's control as an icon in the taskbar's notification area (click it for the menu): Pause, Start, Capture winners.
# Green: running. Yellow: paused. Red: stopped or stuck. The tooltip and the menu's top lines show the progress.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$created = $false; $mutex = New-Object System.Threading.Mutex($true, 'MantaSweepTray', [ref]$created)
if (-not $created) { exit }
$pause = Join-Path $here 'pause.txt'; $stop = Join-Path $here 'stop.txt'
function Workers { @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*run_worker.cmd*' }).Count }
function Lines($f) { if (Test-Path $f) { [IO.File]::ReadAllLines($f) } else { @() } }
function Idle { $l = Get-ChildItem (Join-Path $here 'sweep_log*.txt') | Sort-Object LastWriteTime | Select-Object -Last 1; if ($l) { ((Get-Date) - $l.LastWriteTime).TotalMinutes } else { 999 } }
function Dot($color) { $b = New-Object Drawing.Bitmap 16, 16; $g = [Drawing.Graphics]::FromImage($b); $g.SmoothingMode = 'AntiAlias'; $g.Clear([Drawing.Color]::Transparent)
    $g.FillEllipse((New-Object Drawing.SolidBrush $color), 1, 1, 14, 14); $g.DrawEllipse((New-Object Drawing.Pen ([Drawing.Color]::Black), 1), 1, 1, 14, 14); $g.Dispose(); [Drawing.Icon]::FromHandle($b.GetHicon()) }
$icons = @{ run = (Dot ([Drawing.Color]::LimeGreen)); pause = (Dot ([Drawing.Color]::Gold)); stop = (Dot ([Drawing.Color]::Red)) }
$ni = New-Object Windows.Forms.NotifyIcon; $ni.Icon = $icons.stop; $ni.Visible = $true; $ni.Text = 'Manta sweep'
$menu = New-Object Windows.Forms.ContextMenuStrip
$l1 = $menu.Items.Add('State'); $l2 = $menu.Items.Add('Done'); $l3 = $menu.Items.Add('Left'); $l4 = $menu.Items.Add('Winners')
foreach ($x in @($l1, $l2, $l3, $l4)) { $x.Enabled = $false }
[void]$menu.Items.Add('-')
$mp = $menu.Items.Add('Pause (running attempts finish)'); $ms = $menu.Items.Add('Start'); $mc = $menu.Items.Add('Capture winners')
[void]$menu.Items.Add('-')
$mo = $menu.Items.Add('Open the sweep folder'); $mx = $menu.Items.Add('Hide this icon (the sweep goes on)')
$ni.ContextMenuStrip = $menu
function Refresh {
    $res = Lines (Join-Path $here 'sweep_results.txt'); $done = @($res | Where-Object { $_ -like 'split_*' }).Count
    $win = @(Lines (Join-Path $here 'winners.txt')).Count
    $cut = (Get-Date).AddHours(-1); $hour = 0
    foreach ($c in Lines (Join-Path $here 'sweep_claims.txt')) { $p = $c -split '\|'; if ($p.Count -ge 3 -and $p[0].Trim() -like 'split_*') { try { if ([datetime]::ParseExact($p[2].Trim(), 'yyyy-MM-dd HH:mm:ss', $null) -gt $cut) { $hour++ } } catch { } } }
    $w = Workers; $paused = Test-Path $pause; $idle = Idle
    if ($paused) { $state = if ($w -gt 0) { 'Paused (finishing current runs)' } else { 'Paused' }; $ni.Icon = $icons.pause }
    elseif ($w -eq 0) { $state = 'Stopped: click Start'; $ni.Icon = $icons.stop }
    elseif ($idle -gt 5) { $state = 'Stuck ' + [math]::Round($idle) + ' min: click Start'; $ni.Icon = $icons.stop }
    else { $state = "Running ($w Dolphins)"; $ni.Icon = $icons.run }
    $eta = if ($hour -gt 0) { [math]::Round((32768 - $done) / $hour / 24, 1).ToString() + ' days left' } else { '-' }
    $l1.Text = $state; $l2.Text = "Split values done: $done of 32768 ($hour in the last hour)"; $l3.Text = $eta; $l4.Text = "Shine grabs: $win"
    $t = "Manta sweep: $state, $done/32768, grabs $win"; if ($t.Length -gt 63) { $t = $t.Substring(0, 63) }; $ni.Text = $t
    $mp.Enabled = -not $paused; $ms.Enabled = $paused -or $w -eq 0 -or $idle -gt 5; $mc.Enabled = $win -gt 0
}
$mp.Add_Click({ Set-Content -Path $pause -Value 'paused from the tray'; Refresh })
$ms.Add_Click({ Remove-Item -ErrorAction SilentlyContinue $pause, $stop
    if ((Workers) -eq 0 -or (Idle) -gt 5) { Start-Process -FilePath 'powershell.exe' -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $here 'parallel.ps1')`"" -WorkingDirectory $here -WindowStyle Hidden }
    Refresh })
$mc.Add_Click({ Start-Process -FilePath 'cmd.exe' -ArgumentList "/c `"$(Join-Path $here 'capture_winners.cmd')`"" -WorkingDirectory $here })
$mo.Add_Click({ Start-Process explorer.exe $here })
$mx.Add_Click({ $ni.Visible = $false; [Windows.Forms.Application]::Exit() })
$ni.Add_MouseClick({ param($s, $e) if ($e.Button -eq 'Left') { Refresh; $m = [Windows.Forms.NotifyIcon].GetMethod('ShowContextMenu', [Reflection.BindingFlags]'Instance,NonPublic'); $m.Invoke($ni, $null) } })
$timer = New-Object Windows.Forms.Timer; $timer.Interval = 10000; $timer.Add_Tick({ Refresh }); $timer.Start()
Refresh
[Windows.Forms.Application]::Run()
$ni.Dispose()
