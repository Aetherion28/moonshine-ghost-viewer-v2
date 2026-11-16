# Manta Sweep: the control program for the Manta Storm split sweep (see MANUAL.txt).
# A window with tabs (Home, Results, Winners, Next search, Help), a manta icon near the clock, and the Stage: one window
# that houses the six game panels over the logo, for capturing. Started by "Manta Sweep.vbs" (no console window).
param([switch]$Tray)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$errlog = Join-Path $here 'app_error.txt'
function LogErr($e) { try { Add-Content -Path $errlog -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $e) } catch { } }
trap { LogErr $_; continue }
# one copy of the program: older copies (and the older tray / pointer scripts) are ended
foreach ($o in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and ($_.CommandLine -like '*sweep_tray.ps1*' -or $_.CommandLine -like '*cursor_toggle.ps1*' -or $_.CommandLine -clike '*MantaSweepApp.ps1*' -or ($_.CommandLine -like '*MantaSweep.ps1*' -and $_.CommandLine -notlike '*-Worker*')) })) { Stop-Process -Id $o.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 400
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Windows.Forms;
public class AppKeys : NativeWindow {
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
    [DllImport("user32.dll")] static extern IntPtr CreateCursor(IntPtr inst, int x, int y, int w, int h, byte[] andMask, byte[] xorMask);
    [DllImport("user32.dll")] static extern IntPtr CopyIcon(IntPtr c);
    [DllImport("user32.dll")] static extern bool SetSystemCursor(IntPtr c, uint id);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint a, uint b, IntPtr c, uint d);
    static readonly uint[] IDS = { 32512, 32513, 32514, 32515, 32516, 32642, 32643, 32644, 32645, 32646, 32648, 32649, 32650, 32651 };
    public bool Hidden; public Action OnFull;
    public AppKeys() { CreateHandle(new CreateParams()); RegisterHotKey(Handle, 1, 0x1 | 0x2 | 0x4000, 0x4D); RegisterHotKey(Handle, 2, 0x1 | 0x2 | 0x4000, 0x46); }
    public void HidePointer() { var a = new byte[128]; for (int i = 0; i < 128; i++) a[i] = 0xFF; var x = new byte[128];
        IntPtr blank = CreateCursor(IntPtr.Zero, 0, 0, 32, 32, a, x); foreach (uint id in IDS) SetSystemCursor(CopyIcon(blank), id); Hidden = true; }
    public void ShowPointer() { SystemParametersInfo(0x57, 0, IntPtr.Zero, 0); Hidden = false; }
    public void TogglePointer() { if (Hidden) ShowPointer(); else HidePointer(); }
    protected override void WndProc(ref Message m) { if (m.Msg == 0x0312) { int id = m.WParam.ToInt32(); if (id == 1) TogglePointer(); else if (id == 2 && OnFull != null) OnFull(); } base.WndProc(ref m); }
}
public static class WinUtil {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint f);
    public static void Frame(IntPtr h, bool border, int x, int y, int w, int hgt) { int st = GetWindowLong(h, -16);
        if (border) st |= 0x00C00000 | 0x00040000; else st &= ~(0x00C00000 | 0x00040000);
        SetWindowLong(h, -16, st); SetWindowPos(h, IntPtr.Zero, x, y, w, hgt, 0x0020 | 0x0040 | 0x0004); }
}
"@
[void][WinUtil]::SetProcessDPIAware()
[Windows.Forms.Application]::EnableVisualStyles()
$keys = New-Object AppKeys; $keys.ShowPointer()

$pause = Join-Path $here 'pause.txt'; $stop = Join-Path $here 'stop.txt'
$csv = Join-Path $here 'sweep_results.csv'; $winnersFile = Join-Path $here 'winners.txt'; $claims = Join-Path $here 'sweep_claims.txt'
$queue1 = Join-Path $here 'sweep_queue_first.txt'; $autoFile = Join-Path $here 'auto_next.txt'
$stageDir = Join-Path $here 'stage'; New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
$stageFile = Join-Path $stageDir 'stage.txt'
$CODE = '800888C8:7C0802A6,800888CC:90010004,800888D0:9421FFF0,800888D4:4BFFD1F1,800888D8:3C808000,800888DC:80A41824,800888E0:80C41828,800888E4:7C053000,800888E8:40800018,800888EC:38C50001,800888F0:90C41824,800888F4:54A6083C,800888F8:38C61830,800888FC:7C64322E,80088900:80010014,80088904:38210010,80088908:7C0803A6,8008890C:4E800020,803211E8:4BD676E1'
$TOTAL = 32768

function Lines($f) { if (-not (Test-Path $f)) { return @() }
    try { $fs = New-Object IO.FileStream($f, 'Open', 'Read', 'ReadWrite'); $sr = New-Object IO.StreamReader($fs); $t = $sr.ReadToEnd(); $sr.Close(); $fs.Close()
        return @($t -split "`r?`n" | Where-Object { $_ }) } catch { return @() } }
function Workers { @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*run_worker.cmd*' }).Count }
function Idle { $l = Get-ChildItem (Join-Path $here 'sweep_log*.txt') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1; if ($l) { ((Get-Date) - $l.LastWriteTime).TotalMinutes } else { 999 } }
function QueueEmpty { $f = Join-Path $here 'sweep_log.txt'; if (-not (Test-Path $f)) { return $false }
    try { $fs = New-Object IO.FileStream($f, 'Open', 'Read', 'ReadWrite'); $n = [Math]::Min(300, $fs.Length); [void]$fs.Seek(-$n, 'End'); $b = New-Object byte[] $n; [void]$fs.Read($b, 0, $n); $fs.Close()
        $t = [Text.Encoding]::ASCII.GetString($b).TrimEnd(); return $t.EndsWith('queue empty') } catch { return $false } }
function F($size, $bold) { if ($bold) { New-Object Drawing.Font('Segoe UI', $size, [Drawing.FontStyle]::Bold) } else { New-Object Drawing.Font('Segoe UI', $size) } }

# the icon: a manta ray seen from above, coloured by the state
function Manta($color) { $b = New-Object Drawing.Bitmap 32, 32; $g = [Drawing.Graphics]::FromImage($b); $g.SmoothingMode = 'AntiAlias'; $g.Clear([Drawing.Color]::Transparent)
    $p = New-Object Drawing.Drawing2D.GraphicsPath
    $p.AddBeziers([Drawing.PointF[]]@(
        (New-Object Drawing.PointF 16, 5),
        (New-Object Drawing.PointF 19, 5), (New-Object Drawing.PointF 22, 9), (New-Object Drawing.PointF 31, 15),
        (New-Object Drawing.PointF 26, 18), (New-Object Drawing.PointF 21, 19), (New-Object Drawing.PointF 18, 22),
        (New-Object Drawing.PointF 17, 23), (New-Object Drawing.PointF 16.5, 24), (New-Object Drawing.PointF 16, 24),
        (New-Object Drawing.PointF 15.5, 24), (New-Object Drawing.PointF 15, 23), (New-Object Drawing.PointF 14, 22),
        (New-Object Drawing.PointF 11, 19), (New-Object Drawing.PointF 6, 18), (New-Object Drawing.PointF 1, 15),
        (New-Object Drawing.PointF 10, 9), (New-Object Drawing.PointF 13, 5), (New-Object Drawing.PointF 16, 5)))
    $p.CloseFigure()
    $br = New-Object Drawing.SolidBrush $color; $pen = New-Object Drawing.Pen ([Drawing.Color]::Black), 1.5
    $g.FillPath($br, $p); $g.DrawPath($pen, $p)
    $g.FillEllipse($br, 12.5, 2.5, 3, 5); $g.FillEllipse($br, 16.5, 2.5, 3, 5); $g.DrawEllipse($pen, 12.5, 2.5, 3, 5); $g.DrawEllipse($pen, 16.5, 2.5, 3, 5)
    $tp = New-Object Drawing.Pen ([Drawing.Color]::Black), 2.5; $g.DrawLine($tp, 16, 23, 16, 31); $tc = New-Object Drawing.Pen $color, 1.2; $g.DrawLine($tc, 16, 23.5, 16, 30.5)
    $g.Dispose(); [Drawing.Icon]::FromHandle($b.GetHicon()) }
$icons = @{ run = (Manta ([Drawing.Color]::LimeGreen)); pause = (Manta ([Drawing.Color]::Gold)); stop = (Manta ([Drawing.Color]::Red)) }

# ---------- the stage: one window with the six games over the logo ----------
$stage = New-Object Windows.Forms.Form
$stage.Text = 'Manta Sweep - Stage'; $stage.BackColor = [Drawing.Color]::Black; $stage.Icon = $icons.run; $stage.StartPosition = 'Manual'
$stage.Location = New-Object Drawing.Point(60, 40); $stage.ClientSize = New-Object Drawing.Size(1280, 720); $stage.MinimumSize = New-Object Drawing.Size(480, 320)
$logo = Join-Path $here 'stage_logo.png'
if (Test-Path $logo) { try { $stage.BackgroundImage = [Drawing.Image]::FromFile($logo); $stage.BackgroundImageLayout = 'Zoom' } catch { } }
$cellLabels = @()
for ($i = 0; $i -lt 6; $i++) { $l = New-Object Windows.Forms.Label; $l.AutoSize = $true; $l.Font = F 12 $true; $l.ForeColor = [Drawing.Color]::White; $l.BackColor = [Drawing.Color]::Black; $l.Visible = $false; $stage.Controls.Add($l); $cellLabels += $l }
function StageLayout { $w = [int][math]::Floor($stage.ClientSize.Width / 3); $h = [int][math]::Floor($stage.ClientSize.Height / 2)
    for ($i = 0; $i -lt 6; $i++) { $l = $cellLabels[$i]; $x = ($i % 3) * $w; $y = [int][math]::Floor($i / 3) * $h; $l.Location = New-Object Drawing.Point(($x + $w - $l.Width), $y) } }
function StageLabels { for ($i = 0; $i -lt 6; $i++) { $t = ''; $f = Join-Path $stageDir "cell$i.txt"; if (Test-Path $f) { try { $t = ([IO.File]::ReadAllText($f)).Trim() } catch { } }
        $l = $cellLabels[$i]; if ($l.Text -ne $t) { $l.Text = $t }; $l.Visible = ($t.Length -gt 0) }; StageLayout }
$script:full = $false; $script:stageOn = $false
function ToggleFull { if (-not $script:stageOn) { return }
    if ($script:full) { $r = $script:saved; [WinUtil]::Frame($stage.Handle, $true, $r.X, $r.Y, $r.Width, $r.Height); $script:full = $false }
    else { $script:saved = $stage.Bounds; $s = [Windows.Forms.Screen]::FromControl($stage).Bounds; [WinUtil]::Frame($stage.Handle, $false, $s.X, $s.Y, $s.Width, $s.Height); $script:full = $true }
    StageLayout }
function StageOn { $stage.Show(); if ($stage.WindowState -eq 'Minimized') { $stage.WindowState = 'Normal' }; Set-Content -Path $stageFile -Value ([string]$stage.Handle.ToInt64()); $script:stageOn = $true; StageLabels }
function StageOff { if ($script:full) { ToggleFull }; Remove-Item -ErrorAction SilentlyContinue $stageFile; $stage.Hide(); $script:stageOn = $false }
$stage.Add_Resize({ StageLayout })
$stage.Add_FormClosing({ param($s, $e) if (-not $script:reallyExit) { $e.Cancel = $true; $stage.WindowState = 'Minimized' } })
$keys.OnFull = [Action] { ToggleFull }

# ---------- sweep actions ----------
function DoStart { Remove-Item -ErrorAction SilentlyContinue $pause, $stop
    if ((Workers) -eq 0 -or (Idle) -gt 5) { Start-Process -FilePath 'powershell.exe' -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $here 'parallel.ps1')`"" -WorkingDirectory $here -WindowStyle Hidden }
    UpdateAll }
function DoPause { Set-Content -Path $pause -Value 'paused from the program'; UpdateAll }
function DoStop { $a = [Windows.Forms.MessageBox]::Show('Stop all six games right now? The runs they are in the middle of are thrown away and done again later. (Pause is gentler: it lets them finish.)', 'Manta Sweep', 'YesNo', 'Warning')
    if ($a -ne 'Yes') { return }
    Set-Content -Path $pause -Value 'stopped from the program'
    foreach ($w in @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*run_worker.cmd*' })) { & taskkill.exe /T /F /PID $w.ProcessId 2>$null | Out-Null }
    UpdateAll }
function DoCapture { Start-Process -FilePath 'powershell.exe' -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $here 'capture_winners.ps1')`" -Quiet" -WorkingDirectory $here -WindowStyle Hidden
    [void][Windows.Forms.MessageBox]::Show('Capturing every winner that has no capture yet, in the background. The sweep pauses while this runs (about 25 minutes per winner, six at a time) and continues afterwards. The files appear in the captures folder.', 'Manta Sweep') }

# the override that forces the first N splits: N values in a table, the split code reads them in turn
function PokeFor($vals) { $v = @($vals); $n = $v.Count; if ($v.Count % 2) { $v += 0 }
    $s = '80001824:00000000,80001828:' + $n.ToString('X8')
    for ($i = 0; $i -lt $v.Count; $i += 2) { $s += ',8000' + (0x1830 + 2 * $i).ToString('X4') + ':' + ((([int]$v[$i]) -shl 16) -bor ([int]$v[$i + 1])).ToString('X8') }
    return $s + ',' + $CODE }
# the best runs so far: winners first, then the latest first hit
function BestRuns($count) { $list = New-Object System.Collections.ArrayList
    foreach ($p in $script:runs) { $f = 0; [void][int]::TryParse($p[3], [ref]$f); if ($p[2] -eq 'WINNER') { $f += 10000000 }; if ($f -gt 0) { [void]$list.Add([pscustomobject]@{ Key = $f; Row = $p }) } }
    $seen = @{}; $out = @()
    foreach ($o in @($list | Sort-Object Key -Descending)) { $v = $o.Row[1]; if ($seen.ContainsKey($v)) { continue }; $seen[$v] = 1; $out += , $o.Row; if ($out.Count -ge $count) { break } }
    return , $out }
# next search: for each of the best K runs, force one more split with M evenly spread values
function AddNextSearch($k, $m) { $have = @{}; foreach ($l in @(Lines $queue1)) { $have[(($l.TrimStart('#', 'X', ' ')) -split ';')[0].Trim()] = 1 }
    $new = New-Object System.Collections.ArrayList
    foreach ($row in (BestRuns $k)) { $prefix = @($row[1] -split '\+' | ForEach-Object { [int]$_ }); if ($prefix.Count -ge 4) { continue }
        for ($i = 0; $i -lt $m; $i++) { $v = [int][math]::Floor($i * 32768 / $m); $vals = @($prefix) + $v; $name = 'split' + $vals.Count + '_' + ($vals -join '_')
            if ($have.ContainsKey($name)) { continue }; $have[$name] = 1
            [void]$new.Add("$name; sram=stereo; backend=D3D; loadstate=1; poke=" + (PokeFor $vals)) } }
    if ($new.Count -gt 0) { Add-Content -Path $queue1 -Value $new }
    return $new.Count }
function CancelNext { if (-not (Test-Path $queue1)) { return 0 }; $done = @{}; foreach ($p in $script:runsAll) { $done[$p[1]] = 1 }
    $n = 0; $out = foreach ($l in [IO.File]::ReadAllLines($queue1)) { $t = $l.Trim(); if (-not $t -or $t.StartsWith('#')) { $l; continue }
        $v = ((($t -split ';')[0].Trim()) -replace '^split\d*_', '') -replace '_', '+'; if ($done.ContainsKey($v)) { $l } else { $n++; '#X ' + $l } }
    Set-Content -Path $queue1 -Value $out; return $n }

# ---------- the control window ----------
$form = New-Object Windows.Forms.Form
$form.SuspendLayout(); $form.AutoScaleDimensions = New-Object Drawing.SizeF(96, 96); $form.AutoScaleMode = 'Dpi'
$form.Text = 'Manta Sweep'; $form.ClientSize = New-Object Drawing.Size(780, 560); $form.StartPosition = 'CenterScreen'; $form.Icon = $icons.run; $form.FormBorderStyle = 'FixedSingle'; $form.MaximizeBox = $false; $form.Font = F 10 $false
$tabs = New-Object Windows.Forms.TabControl; $tabs.Dock = 'Fill'
function Tab($name) { $t = New-Object Windows.Forms.TabPage; $t.Text = $name; $t.BackColor = [Drawing.Color]::White; [void]$tabs.TabPages.Add($t); $t }
function Lbl($parent, $text, $x, $y, $w, $h, $size, $bold) { $l = New-Object Windows.Forms.Label; $l.Text = $text; $l.Location = New-Object Drawing.Point($x, $y); $l.Size = New-Object Drawing.Size($w, $h); $l.Font = F $size $bold; $parent.Controls.Add($l); $l }
function Btn($parent, $text, $x, $y, $w, $h) { $b = New-Object Windows.Forms.Button; $b.Text = $text; $b.Location = New-Object Drawing.Point($x, $y); $b.Size = New-Object Drawing.Size($w, $h); $parent.Controls.Add($b); $b }
function Cols($lv, $cols) { $lv.View = 'Details'; $lv.FullRowSelect = $true; $lv.GridLines = $true; foreach ($c in $cols) { [void]$lv.Columns.Add($c[0], $c[1]) } }

# Home
$tHome = Tab 'Home'
$lblState = Lbl $tHome 'Starting...' 20 15 730 40 18 $true
$bar = New-Object Windows.Forms.ProgressBar; $bar.Location = New-Object Drawing.Point(20, 60); $bar.Size = New-Object Drawing.Size(730, 24); $bar.Maximum = $TOTAL; $tHome.Controls.Add($bar)
$lblNums = Lbl $tHome '' 20 92 730 92 10 $false
$bStart = Btn $tHome 'START' 20 190 230 60; $bStart.Font = F 14 $true; $bStart.BackColor = [Drawing.Color]::FromArgb(200, 240, 200)
$bPause = Btn $tHome 'PAUSE' 270 190 230 60; $bPause.Font = F 14 $true; $bPause.BackColor = [Drawing.Color]::FromArgb(250, 240, 180)
$bStop = Btn $tHome 'Stop right now' 520 190 230 60; $bStop.BackColor = [Drawing.Color]::FromArgb(250, 205, 205)
[void](Lbl $tHome 'START: run the tests (or continue after a pause or a restart of the PC).    PAUSE: the six games finish the run they are on (about 2 minutes), then nothing new starts. Use it when you want your PC back.    Stop right now: closes the six games at once.' 20 256 730 62 9 $false)
$lblStageHead = Lbl $tHome 'The stage (one window with all six games over your logo, for recording):' 20 328 730 22 10 $true
$bStage = Btn $tHome 'Show the stage' 20 354 230 40
$bFull = Btn $tHome 'Stage full screen on / off  (Ctrl+Alt+F)' 270 354 300 40
$bPointer = Btn $tHome 'Hide / show mouse pointer  (Ctrl+Alt+M)' 20 420 300 40
$bFolder = Btn $tHome 'Open the sweep folder' 340 420 200 40
$bShortcut = Btn $tHome 'Put a shortcut on my Desktop' 560 420 190 40
[void](Lbl $tHome 'Closing this window does not stop anything: the program stays as the manta icon near the clock (click it to come back). Each game takes one of 6 slots; a new game opens in a slot when the last one there ends.' 20 472 730 50 9 $false)

# Results
$tRes = Tab 'Results'
[void](Lbl $tRes 'The runs that got furthest. Each run ends when Mario is first hit, so a later "field" (a field is 1/60 second of game time) means the run followed the TAS for longer. The TAS wins the fight at about field 174224. A WINNER is a run where Mario grabbed the Shine.' 15 10 745 62 9 $false)
$lvRes = New-Object Windows.Forms.ListView; $lvRes.Location = New-Object Drawing.Point(15, 76); $lvRes.Size = New-Object Drawing.Size(745, 390); Cols $lvRes @(@('Attempt', 90), @('Split value(s)', 190), @('Outcome', 110), @('Field of the first hit', 160), @('Finished', 170)); $tRes.Controls.Add($lvRes)
$bRefresh = Btn $tRes 'Refresh this list' 15 476 180 40
$bCsv = Btn $tRes 'Open the full spreadsheet (every run)' 210 476 300 40

# Winners
$tWin = Tab 'Winners'
[void](Lbl $tWin 'Runs where Mario grabbed the Shine. The attempt number is the one shown above that game while it ran, so you can find it in a recording.' 15 10 745 44 9 $false)
$lvWin = New-Object Windows.Forms.ListView; $lvWin.Location = New-Object Drawing.Point(15, 58); $lvWin.Size = New-Object Drawing.Size(745, 300); Cols $lvWin @(@('When', 150), @('Attempt', 90), @('Split value(s)', 170), @('Captured?', 100), @('Result', 220)); $tWin.Controls.Add($lvWin)
$bCapture = Btn $tWin 'Capture the winners (record the rest of the TAS)' 15 370 420 50; $bCapture.Font = F 11 $true
[void](Lbl $tWin 'Capture = play each winner again from the start of Manta Storm to the end of the TAS and record the game state (needed to make ghosts and traces). It pauses the sweep, takes about 25 minutes per winner (six at a time), then the sweep continues by itself. Results: the captures folder. Safe to press again: finished ones are skipped.' 15 428 745 84 9 $false)

# Next search
$tNext = Tab 'Next search'
[void](Lbl $tNext 'What this is for' 15 10 745 22 10 $true)
[void](Lbl $tNext 'The normal sweep tries every possible direction (32768 of them) for the FIRST time the Manta splits, and leaves the later splits to chance. If none of them wins, the next step is to take the runs that got furthest and also choose the direction of the NEXT split for them (then the next, up to 4 splits). This page adds those runs. They run before the rest of the normal sweep.' 15 34 745 84 9 $false)
[void](Lbl $tNext 'How many of the best runs to build on:' 15 130 300 26 10 $false)
$nK = New-Object Windows.Forms.NumericUpDown; $nK.Location = New-Object Drawing.Point(330, 128); $nK.Size = New-Object Drawing.Size(90, 26); $nK.Minimum = 1; $nK.Maximum = 500; $nK.Value = 20; $tNext.Controls.Add($nK)
[void](Lbl $tNext 'Directions to try for the next split, each:' 15 164 300 26 10 $false)
$nM = New-Object Windows.Forms.NumericUpDown; $nM.Location = New-Object Drawing.Point(330, 162); $nM.Size = New-Object Drawing.Size(90, 26); $nM.Minimum = 4; $nM.Maximum = 4096; $nM.Value = 64; $tNext.Controls.Add($nM)
$lblCost = Lbl $tNext '' 440 130 320 60 9 $false
$bAdd = Btn $tNext 'Add these runs now' 15 204 260 50; $bAdd.Font = F 11 $true
$bCancel = Btn $tNext 'Cancel the added runs that have not started' 295 204 340 50
$lblNext = Lbl $tNext '' 15 264 745 44 9 $false
$cAuto = New-Object Windows.Forms.CheckBox; $cAuto.Text = 'Keep searching by itself: whenever everything queued is finished, add the next search (with the numbers above) and carry on'; $cAuto.Location = New-Object Drawing.Point(15, 320); $cAuto.Size = New-Object Drawing.Size(745, 48); $cAuto.Checked = (Test-Path $autoFile); $tNext.Controls.Add($cAuto)
[void](Lbl $tNext 'Bigger numbers = a wider search that takes longer. A good start is 20 and 64 (1280 runs, about 4 to 5 hours). With the box ticked the search widens by itself for as long as you leave it running: you never have to come back here.' 15 376 745 70 9 $false)

# Help
$tHelp = Tab 'Help'
$txtHelp = New-Object Windows.Forms.TextBox; $txtHelp.Multiline = $true; $txtHelp.ReadOnly = $true; $txtHelp.ScrollBars = 'Vertical'; $txtHelp.Location = New-Object Drawing.Point(10, 10); $txtHelp.Size = New-Object Drawing.Size(755, 455); $txtHelp.Font = New-Object Drawing.Font('Consolas', 9.5); $txtHelp.BackColor = [Drawing.Color]::White; $tHelp.Controls.Add($txtHelp)
$bManual = Btn $tHelp 'Open the manual as a text file (give it to any AI helper)' 10 475 420 40
$man = Join-Path $here 'MANUAL.txt'; if (Test-Path $man) { $txtHelp.Text = ([IO.File]::ReadAllText($man)) -replace "(?<!`r)`n", "`r`n" }
# the stage (one window housing the games) is not offered: the games sit on the desktop grid
$bStage.Visible = $false; $bFull.Visible = $false; $lblStageHead.Visible = $false
$form.Controls.Add($tabs); $form.ResumeLayout()

# ---------- refresh ----------
$script:runs = New-Object 'System.Collections.Generic.List[string[]]'; $script:runsAll = $script:runs; $script:csvStamp = ''
function ReadRuns { if (-not (Test-Path $csv)) { return }; $i = Get-Item $csv; $stamp = "$($i.Length) $($i.LastWriteTimeUtc.Ticks)"; if ($stamp -eq $script:csvStamp) { return }; $script:csvStamp = $stamp
    $ok = New-Object 'System.Collections.Generic.List[string[]]'; $main = 0; $pri = 0
    foreach ($l in @(Lines $csv | Select-Object -Skip 1)) { $p = $l.Split(',', 8); if ($p.Count -lt 8) { continue }; if ($p[2] -like 'error*') { continue }
        if ($p[0].StartsWith('P')) { $pri++ } else { $main++ }; $ok.Add($p) }
    $script:runs = $ok; $script:runsAll = $ok; $script:doneMain = $main; $script:donePri = $pri }
function FillResults { $lvRes.BeginUpdate(); $lvRes.Items.Clear()
    foreach ($p in (BestRuns 40)) { $it = New-Object Windows.Forms.ListViewItem([string]('#' + $p[0])); [void]$it.SubItems.Add($p[1]); [void]$it.SubItems.Add($p[2]); [void]$it.SubItems.Add($p[3]); [void]$it.SubItems.Add($p[6]); if ($p[2] -eq 'WINNER') { $it.BackColor = [Drawing.Color]::LightGreen }; [void]$lvRes.Items.Add($it) }
    $lvRes.EndUpdate() }
function FillWinners { $lvWin.BeginUpdate(); $lvWin.Items.Clear()
    foreach ($l in @(Lines $winnersFile)) { $p = @($l -split '\|' | ForEach-Object { $_.Trim() }); if ($p.Count -lt 4) { continue }
        $name = $p[2]; $val = ($name -replace '^split\d*_', '') -replace '_', '+'; $cap = if (Test-Path (Join-Path $here "captures\$name.done")) { 'yes' } else { 'not yet' }
        $it = New-Object Windows.Forms.ListViewItem([string]$p[0]); [void]$it.SubItems.Add($p[1]); [void]$it.SubItems.Add($val); [void]$it.SubItems.Add($cap); [void]$it.SubItems.Add($p[3]); [void]$lvWin.Items.Add($it) }
    $lvWin.EndUpdate() }
function Cost { $n = [int]$nK.Value * [int]$nM.Value; $rate = if ($script:hour -gt 20) { $script:hour } else { 290 }; $lblCost.Text = "= up to $n runs, about " + [math]::Round($n / $rate, 1) + ' hours at the current speed' }
function UpdateAll { try {
    ReadRuns
    $win = @(Lines $winnersFile).Count
    $cut = (Get-Date).AddHours(-1); $hour = 0
    foreach ($c in @(Lines $claims)) { $p = $c -split '\|'; if ($p.Count -ge 3 -and $p[0].StartsWith('split')) { try { if ([datetime]::ParseExact($p[2].Trim(), 'yyyy-MM-dd HH:mm:ss', $null) -gt $cut) { $hour++ } } catch { } } }
    $script:hour = $hour
    $priTotal = @(Lines $queue1 | Where-Object { -not $_.TrimStart().StartsWith('#') }).Count; $priLeft = [math]::Max(0, $priTotal - [int]$script:donePri)
    $mainLeft = [math]::Max(0, $TOTAL - [int]$script:doneMain)
    $w = Workers; $paused = Test-Path $pause; $idle = Idle; $empty = QueueEmpty
    if ($paused) { if ($w -gt 0 -and $idle -lt 3) { $state = 'PAUSING: the games finish their current runs'; $col = 'DarkGoldenrod' } else { $state = 'PAUSED. Press START to continue'; $col = 'DarkGoldenrod' }; $ic = $icons.pause }
    elseif ($w -eq 0) { $state = 'STOPPED. Press START'; $col = 'Firebrick'; $ic = $icons.stop }
    elseif ($empty) { $state = 'FINISHED everything queued (see Next search)'; $col = 'SteelBlue'; $ic = $icons.pause }
    elseif ($idle -gt 5) { $state = 'STUCK for ' + [math]::Round($idle) + ' minutes. Press START'; $col = 'Firebrick'; $ic = $icons.stop }
    else { $state = "RUNNING ($w games at once)"; $col = 'ForestGreen'; $ic = $icons.run }
    if ($win -gt 0) { $state += "   -   WINNERS: $win" }
    $lblState.Text = $state; $lblState.ForeColor = [Drawing.Color]::FromName($col); $ni.Icon = $ic; $form.Icon = $ic
    $bar.Value = [math]::Min($TOTAL, [int]$script:doneMain)
    $left = $mainLeft + $priLeft; $eta = if ($hour -gt 0) { $h = $left / $hour; if ($h -gt 48) { [math]::Round($h / 24, 1).ToString() + ' days' } else { [math]::Round($h, 1).ToString() + ' hours' } } else { 'unknown (nothing ran in the last hour)' }
    $t = "First-split sweep: $($script:doneMain) of $TOTAL directions tried  (" + [math]::Round(100 * $script:doneMain / $TOTAL, 1) + "%)`n"
    $t += "Next-search runs: $($script:donePri) done, $priLeft waiting`n"
    $t += "Speed: $hour runs in the last hour.   Time left for everything queued: $eta`n"
    $t += "Shine grabs (winners): $win" + $(if ($win -gt 0) { '   <- look at the Winners tab' } else { '   (none yet)' })
    $lblNums.Text = $t
    $bStart.Enabled = $paused -or $w -eq 0 -or $idle -gt 5; $bPause.Enabled = (-not $paused) -and $w -gt 0; $bStop.Enabled = $w -gt 0
    $bStage.Text = if ($script:stageOn) { 'Hide the stage' } else { 'Show the stage (experimental)' }; $bFull.Enabled = $script:stageOn
    $tip = "Manta Sweep: $($script:doneMain)/$TOTAL, winners $win"; if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }; $ni.Text = $tip
    $mStart.Enabled = $bStart.Enabled; $mPause.Enabled = $bPause.Enabled
    $lblNext.Text = "Added so far: $priTotal next-search runs ($($script:donePri) done, $priLeft waiting)."
    Cost
    # keep searching by itself
    if ($cAuto.Checked -and $empty -and -not $paused -and $w -gt 0 -and $priLeft -eq 0) { $n = AddNextSearch ([int]$nK.Value) ([int]$nM.Value); if ($n -gt 0) { $ni.ShowBalloonTip(5000, 'Manta Sweep', "Everything queued was finished: added $n next-search runs.", 'Info') } }
    if ($win -gt [int]$script:lastWin) { if ($script:lastWin -ne $null) { $ni.ShowBalloonTip(10000, 'Manta Sweep', 'A run grabbed the Shine! See the Winners tab.', 'Info') }; FillWinners }; $script:lastWin = $win
} catch { LogErr $_ } }

# ---------- tray icon ----------
$ni = New-Object Windows.Forms.NotifyIcon; $ni.Icon = $icons.stop; $ni.Visible = $true; $ni.Text = 'Manta Sweep'
$menu = New-Object Windows.Forms.ContextMenuStrip
$mOpen = $menu.Items.Add('Open Manta Sweep'); $mOpen.Font = F 9 $true
[void]$menu.Items.Add('-')
$mStart = $menu.Items.Add('Start'); $mPause = $menu.Items.Add('Pause (games finish their runs)')
$mStageM = New-Object Windows.Forms.ToolStripMenuItem; $mFull = New-Object Windows.Forms.ToolStripMenuItem; $mPointer = $menu.Items.Add('Hide / show the mouse pointer (Ctrl+Alt+M)')
[void]$menu.Items.Add('-')
$mExit = $menu.Items.Add('Close this program')
$ni.ContextMenuStrip = $menu
function ShowMain { $form.Show(); if ($form.WindowState -eq 'Minimized') { $form.WindowState = 'Normal' }; $form.Activate(); UpdateAll }
function ToggleStage { if ($script:stageOn) { StageOff } else { StageOn }; UpdateAll }
function ExitApp { $a = [Windows.Forms.MessageBox]::Show('Close the Manta Sweep program? The sweep itself keeps running in the background, but games showing inside the stage are closed (their runs are done again later) and new games go back to the desktop. Open the program again any time with its shortcut.', 'Manta Sweep', 'YesNo', 'Question')
    if ($a -ne 'Yes') { return }; $script:reallyExit = $true; $keys.ShowPointer(); Remove-Item -ErrorAction SilentlyContinue $stageFile; $ni.Visible = $false; [Windows.Forms.Application]::Exit() }
$ni.Add_MouseClick({ param($s, $e) if ($e.Button -eq 'Left') { ShowMain } })
$mOpen.Add_Click({ ShowMain }); $mStart.Add_Click({ DoStart }); $mPause.Add_Click({ DoPause }); $mStageM.Add_Click({ ToggleStage }); $mFull.Add_Click({ ToggleFull }); $mPointer.Add_Click({ $keys.TogglePointer() }); $mExit.Add_Click({ ExitApp })
$bStart.Add_Click({ DoStart }); $bPause.Add_Click({ DoPause }); $bStop.Add_Click({ DoStop }); $bStage.Add_Click({ ToggleStage }); $bFull.Add_Click({ ToggleFull }); $bPointer.Add_Click({ $keys.TogglePointer() })
$bFolder.Add_Click({ Start-Process explorer.exe $here })
$bShortcut.Add_Click({ try { $ico = Join-Path $here 'manta.ico'; $fs = [IO.File]::Create($ico); $icons.run.Save($fs); $fs.Close()
        $sh = New-Object -ComObject WScript.Shell; $lnk = $sh.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Manta Sweep.lnk'))
        $lnk.TargetPath = 'wscript.exe'; $lnk.Arguments = '"' + (Join-Path $here 'Manta Sweep.vbs') + '"'; $lnk.WorkingDirectory = $here; $lnk.IconLocation = $ico; $lnk.Description = 'Manta Sweep control program'; $lnk.Save()
        [void][Windows.Forms.MessageBox]::Show('Done: "Manta Sweep" is on your Desktop.', 'Manta Sweep') } catch { LogErr $_; [void][Windows.Forms.MessageBox]::Show('Could not make the shortcut. You can still start the program with "Manta Sweep.vbs" in the sweep folder.', 'Manta Sweep') } })
$bRefresh.Add_Click({ $script:csvStamp = ''; ReadRuns; FillResults }); $bCsv.Add_Click({ if (Test-Path $csv) { Start-Process $csv } })
$bCapture.Add_Click({ if (@(Lines $winnersFile).Count -eq 0) { [void][Windows.Forms.MessageBox]::Show('There are no winners yet, so there is nothing to capture.', 'Manta Sweep') } else { DoCapture } })
$nK.Add_ValueChanged({ Cost }); $nM.Add_ValueChanged({ Cost })
$bAdd.Add_Click({ ReadRuns; $n = AddNextSearch ([int]$nK.Value) ([int]$nM.Value); [void][Windows.Forms.MessageBox]::Show($(if ($n -gt 0) { "Added $n runs. They are done before the rest of the normal sweep. If the sweep is running you do not need to do anything else." } else { 'Nothing new to add: these runs were already added (or the best runs already have 4 splits chosen). Try bigger numbers.' }), 'Manta Sweep'); UpdateAll })
$bCancel.Add_Click({ $n = CancelNext; [void][Windows.Forms.MessageBox]::Show("Cancelled $n added runs that had not been done yet.", 'Manta Sweep'); UpdateAll })
$cAuto.Add_CheckedChanged({ if ($cAuto.Checked) { Set-Content -Path $autoFile -Value 'on' } else { Remove-Item -ErrorAction SilentlyContinue $autoFile } })
$bManual.Add_Click({ if (Test-Path $man) { Start-Process notepad.exe $man } })
$tabs.Add_SelectedIndexChanged({ if ($tabs.SelectedTab -eq $tRes) { ReadRuns; FillResults } elseif ($tabs.SelectedTab -eq $tWin) { FillWinners } })
$form.Add_FormClosing({ param($s, $e) if (-not $script:reallyExit) { $e.Cancel = $true; $form.Hide(); if (-not $script:told) { $script:told = $true; $ni.ShowBalloonTip(5000, 'Manta Sweep', 'Still running: click the manta icon near the clock to open this window again.', 'Info') } } })

$timer = New-Object Windows.Forms.Timer; $timer.Interval = 15000; $timer.Add_Tick({ UpdateAll }); $timer.Start()
$stimer = New-Object Windows.Forms.Timer; $stimer.Interval = 1000; $stimer.Add_Tick({ if ($script:stageOn) { StageLabels } }); $stimer.Start()
# a shortcut with the manta icon next to the program
try { $ico = Join-Path $here 'manta.ico'; if (-not (Test-Path $ico)) { $fs = [IO.File]::Create($ico); $icons.run.Save($fs); $fs.Close() }
    $lnkPath = Join-Path $here 'Manta Sweep.lnk'
    if (-not (Test-Path $lnkPath)) { $sh = New-Object -ComObject WScript.Shell; $lnk = $sh.CreateShortcut($lnkPath); $lnk.TargetPath = 'wscript.exe'; $lnk.Arguments = '"' + (Join-Path $here 'Manta Sweep.vbs') + '"'; $lnk.WorkingDirectory = $here; $lnk.IconLocation = $ico; $lnk.Description = 'Manta Sweep control program'; $lnk.Save() } } catch { LogErr $_ }
if (-not $Tray) { $form.Show() }
UpdateAll
try { [Windows.Forms.Application]::Run() } finally { $keys.ShowPointer(); Remove-Item -ErrorAction SilentlyContinue $stageFile; $ni.Dispose() }
