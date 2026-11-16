# The sweep's control as an icon in the taskbar's notification area (click it for the menu): Pause, Start, Capture winners.
# Green: running. Yellow: paused. Red: stopped or stuck. The tooltip and the menu's top lines show the progress.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# one tray: an older tray or the separate pointer hotkey script is ended first
foreach ($o in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and ($_.CommandLine -like '*sweep_tray.ps1*' -or $_.CommandLine -like '*cursor_toggle.ps1*') })) { Stop-Process -Id $o.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
# the mouse pointer: Ctrl+Alt+M (or the menu) hides / shows it everywhere; it comes back when the tray ends
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Windows.Forms;
public class PointerToggle : NativeWindow {
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
    [DllImport("user32.dll")] static extern IntPtr CreateCursor(IntPtr inst, int x, int y, int w, int h, byte[] andMask, byte[] xorMask);
    [DllImport("user32.dll")] static extern IntPtr CopyIcon(IntPtr c);
    [DllImport("user32.dll")] static extern bool SetSystemCursor(IntPtr c, uint id);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint a, uint b, IntPtr c, uint d);
    static readonly uint[] IDS = { 32512, 32513, 32514, 32515, 32516, 32642, 32643, 32644, 32645, 32646, 32648, 32649, 32650, 32651 };
    public bool Hidden, HotkeyOk;
    public PointerToggle() { CreateHandle(new CreateParams()); HotkeyOk = RegisterHotKey(Handle, 1, 0x1 | 0x2 | 0x4000, 0x4D); }
    public void Hide() { var a = new byte[128]; for (int i = 0; i < 128; i++) a[i] = 0xFF; var x = new byte[128];
        IntPtr blank = CreateCursor(IntPtr.Zero, 0, 0, 32, 32, a, x); foreach (uint id in IDS) SetSystemCursor(CopyIcon(blank), id); Hidden = true; }
    public void Show() { SystemParametersInfo(0x57, 0, IntPtr.Zero, 0); Hidden = false; }
    public void Toggle() { if (Hidden) Show(); else Hide(); }
    protected override void WndProc(ref Message m) { if (m.Msg == 0x0312) Toggle(); base.WndProc(ref m); }
}
"@
$pointer = New-Object PointerToggle
$pause = Join-Path $here 'pause.txt'; $stop = Join-Path $here 'stop.txt'
function Workers { @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*run_worker.cmd*' }).Count }
function Lines($f) { if (Test-Path $f) { [IO.File]::ReadAllLines($f) } else { @() } }
function Idle { $l = Get-ChildItem (Join-Path $here 'sweep_log*.txt') | Sort-Object LastWriteTime | Select-Object -Last 1; if ($l) { ((Get-Date) - $l.LastWriteTime).TotalMinutes } else { 999 } }
# the icon: a manta ray seen from above, coloured by the sweep's state
function Dot($color) { $b = New-Object Drawing.Bitmap 32, 32; $g = [Drawing.Graphics]::FromImage($b); $g.SmoothingMode = 'AntiAlias'; $g.Clear([Drawing.Color]::Transparent)
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
    # the head fins and the tail
    $g.FillEllipse($br, 12.5, 2.5, 3, 5); $g.FillEllipse($br, 16.5, 2.5, 3, 5); $g.DrawEllipse($pen, 12.5, 2.5, 3, 5); $g.DrawEllipse($pen, 16.5, 2.5, 3, 5)
    $tp = New-Object Drawing.Pen ([Drawing.Color]::Black), 2.5; $g.DrawLine($tp, 16, 23, 16, 31); $tc = New-Object Drawing.Pen $color, 1.2; $g.DrawLine($tc, 16, 23.5, 16, 30.5)
    $g.Dispose(); [Drawing.Icon]::FromHandle($b.GetHicon()) }
$icons = @{ run = (Dot ([Drawing.Color]::LimeGreen)); pause = (Dot ([Drawing.Color]::Gold)); stop = (Dot ([Drawing.Color]::Red)) }
$ni = New-Object Windows.Forms.NotifyIcon; $ni.Icon = $icons.stop; $ni.Visible = $true; $ni.Text = 'Manta sweep'
$menu = New-Object Windows.Forms.ContextMenuStrip
$l1 = $menu.Items.Add('State'); $l2 = $menu.Items.Add('Done'); $l3 = $menu.Items.Add('Left'); $l4 = $menu.Items.Add('Winners')
foreach ($x in @($l1, $l2, $l3, $l4)) { $x.Enabled = $false }
[void]$menu.Items.Add('-')
$mp = $menu.Items.Add('Pause (running attempts finish)'); $ms = $menu.Items.Add('Start'); $mc = $menu.Items.Add('Capture winners')
[void]$menu.Items.Add('-')
$mm = $menu.Items.Add('Hide / show the mouse pointer (Ctrl+Alt+M)')
$mo = $menu.Items.Add('Open the sweep folder'); $mx = $menu.Items.Add('Hide this icon (the sweep goes on; the pointer comes back)')
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
$mc.Add_Click({ Start-Process -FilePath 'powershell.exe' -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $here 'capture_winners.ps1')`" -Quiet" -WorkingDirectory $here -WindowStyle Hidden
    $ni.ShowBalloonTip(5000, 'Manta sweep', 'Capturing the winners in the background (captures folder); the sweep pauses meanwhile.', 'Info') })
$mm.Add_Click({ $pointer.Toggle() })
$mo.Add_Click({ Start-Process explorer.exe $here })
$mx.Add_Click({ $pointer.Show(); $ni.Visible = $false; [Windows.Forms.Application]::Exit() })
$ni.Add_MouseClick({ param($s, $e) if ($e.Button -eq 'Left') { Refresh; $m = [Windows.Forms.NotifyIcon].GetMethod('ShowContextMenu', [Reflection.BindingFlags]'Instance,NonPublic'); $m.Invoke($ni, $null) } })
$timer = New-Object Windows.Forms.Timer; $timer.Interval = 10000; $timer.Add_Tick({ Refresh }); $timer.Start()
Refresh
try { [Windows.Forms.Application]::Run() } finally { $pointer.Show(); $ni.Dispose() }
