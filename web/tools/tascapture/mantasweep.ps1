# One attempt of the Manta Storm sync sweep (run_mantasweep.cmd calls it in a loop, so edits apply to the next attempt).
# Takes the first line of sweep_queue.txt whose name isn't in sweep_results.txt, sets Dolphin up that way, plays the
# TAS from boot at unlimited speed and watches the game's memory:
#   success  Mario's status reads 0x1302 (the Shine touch) in Sirena Beach 1 (area 6, episode 0)
#   fail     Sirena left or reloaded without it (a death), 30000 fields in Sirena, Sirena not reached by field 200000,
#            the game stalled for 3 minutes
# Exit codes: 0 attempt done, 2 queue empty (the loop waits for more lines), 3 a winner (the loop runs capture3).
# Queue line:  name; sram=mono|stereo; backend=D3D|D3D12|OGL|Software Renderer; Section.Key=Value; ...
# (Section.Key goes into User/GameSettings/GMSJ01.ini, which overrides Dolphin's own game ini.)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dol = Join-Path $here 'Dolphin-x64'
$iso = 'C:\Users\devon\OneDrive\Desktop\Dolphin-x64\Games\SMS\JP 1.0 (GMSJ01).iso'
$dtm = Join-Path $here 'sms-anypct-tas.dtm'
$queue = Join-Path $here 'sweep_queue.txt'
$results = Join-Path $here 'sweep_results.txt'
$log = Join-Path $here 'sweep_log.txt'
function Log($s) { $l = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $s; Add-Content -Path $log -Value $l; Write-Host $l }

$done = @{}
# an ERROR (Dolphin didn't start, stalled) doesn't use a line up: it is tried again, up to three times
$errs = @{}
if (Test-Path $results) { foreach ($l in Get-Content $results) { $f = $l -split '\|'; $n = $f[0].Trim(); if (-not $n) { continue }
    if ($f.Count -gt 1 -and $f[1].Trim().StartsWith('ERROR')) { $errs[$n] = 1 + [int]$errs[$n]; if ($errs[$n] -ge 3) { $done[$n] = 1 } } else { $done[$n] = 1 } } }
$entry = $null
foreach ($l in Get-Content $queue) {
    $t = $l.Trim(); if (-not $t -or $t.StartsWith('#')) { continue }
    $n = ($t -split ';')[0].Trim(); if (-not $done.ContainsKey($n)) { $entry = $t; break }
}
if (-not $entry) { Log 'queue empty'; exit 2 }
$parts = $entry -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$name = $parts[0]; $sram = 'stereo'; $backend = 'D3D'; $game = @{}; $loadstate = 0; $savestate = 0; $gecko = @(); $pokes = ''
foreach ($p in $parts[1..($parts.Count - 1)]) {
    $k, $v = $p -split '=', 2
    if ($k -eq 'sram') { $sram = $v } elseif ($k -eq 'backend') { $backend = $v } elseif ($k -eq 'loadstate') { $loadstate = [int]$v } elseif ($k -eq 'savestate') { $savestate = [int]$v } elseif ($k -eq 'gecko') { $gecko += $v } elseif ($k -eq 'poke') { $pokes = $v }
    else { $s, $key = $k -split '\.', 2; if (-not $game.ContainsKey($s)) { $game[$s] = @() }; $game[$s] += "$key = $v" }
}
Log "attempt $name : $entry"

# Dolphin.ini: unlimited speed, the backend (the movie sets idle skip, dual core, DSP and the EFB access / copy options itself)
$ini = Join-Path $dol 'User\Config\Dolphin.ini'
if (-not (Test-Path "$ini.sweepbak")) { Copy-Item $ini "$ini.sweepbak" }
$c = Get-Content $ini
$c = $c -replace '^EnableCheats = .*', ('EnableCheats = ' + $(if ($gecko.Count) { 'True' } else { 'False' })) -replace '^EmulationSpeed = .*', 'EmulationSpeed = 0.00000000' -replace '^GFXBackend = .*', "GFXBackend = $backend"
Set-Content -Path $ini -Value $c
# the game ini
$gdir = Join-Path $dol 'User\GameSettings'; New-Item -ItemType Directory -Force -Path $gdir | Out-Null
$g = @(); foreach ($s in $game.Keys) { $g += "[$s]"; $g += $game[$s] }
if ($gecko.Count) { $g += '[Gecko]'; $g += '$Sweep'; $g += $gecko; $g += '[Gecko_Enabled]'; $g += '$Sweep' }
Set-Content -Path (Join-Path $gdir 'GMSJ01.ini') -Value ($g -join "`r`n")
# SRAM: the sound mode bit (flags byte 0x13, 4 = stereo), with the checksums over the four halfwords at 0x0C
$sp = Join-Path $dol 'User\GC\SRAM.raw'
if (-not (Test-Path "$sp.sweepbak")) { Copy-Item $sp "$sp.sweepbak" }
$b = [IO.File]::ReadAllBytes($sp)
if ($sram -eq 'mono') { $b[0x13] = $b[0x13] -band 0xFB } else { $b[0x13] = $b[0x13] -bor 4 }
$sum = 0; $inv = 0
for ($i = 0x0C; $i -lt 0x14; $i += 2) { $w = ($b[$i] -shl 8) -bor $b[$i + 1]; $sum += $w; $inv += (0xFFFF -bxor $w) }
$b[0] = ($sum -shr 8) -band 0xFF; $b[1] = $sum -band 0xFF; $b[2] = ($inv -shr 8) -band 0xFF; $b[3] = $inv -band 0xFF
[IO.File]::WriteAllBytes($sp, $b)

$src = @"
using System;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class Sweep {
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a, bool b, int pid);
    [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] buf, IntPtr n, out IntPtr r);
    [DllImport("kernel32.dll")] static extern bool WriteProcessMemory(IntPtr h, IntPtr a, byte[] buf, IntPtr n, out IntPtr w);
    [DllImport("kernel32.dll")] static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr a, out MBI m, IntPtr len);
    [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint f);
    delegate bool EnumProc(IntPtr hwnd, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetMenu(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr m);
    [DllImport("user32.dll")] static extern IntPtr GetSubMenu(IntPtr m, int i);
    [DllImport("user32.dll")] static extern uint GetMenuItemID(IntPtr m, int i);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetMenuString(IntPtr m, uint item, System.Text.StringBuilder s, int max, uint flags);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    static string menuText(IntPtr m, int i) { var sb = new System.Text.StringBuilder(256); GetMenuString(m, (uint)i, sb, 256, 0x400); return sb.ToString().Replace("&", ""); }
    // Dolphin's own menu command Emulation > (Save|Load) State > Slot n, posted to its main window (no focus or hotkey needed)
    public static string stateCommand(int pid, string which, int slot) {
        IntPtr main = IntPtr.Zero;
        EnumWindows((w, l) => { uint q; GetWindowThreadProcessId(w, out q); if (q == pid && GetMenu(w) != IntPtr.Zero) { main = w; return false; } return true; }, IntPtr.Zero);
        if (main == IntPtr.Zero) return "no main window";
        IntPtr bar = GetMenu(main);
        for (int i = 0; i < GetMenuItemCount(bar); i++) {
            if (!menuText(bar, i).StartsWith("Emulation")) continue;
            IntPtr em = GetSubMenu(bar, i);
            for (int j = 0; j < GetMenuItemCount(em); j++) {
                if (!menuText(em, j).StartsWith(which)) continue;
                IntPtr sub = GetSubMenu(em, j);
                for (int k = 0; k < GetMenuItemCount(sub); k++) {
                    string t = menuText(sub, k);
                    if (t.StartsWith("Slot " + slot + " ")) { PostMessage(main, 0x0111, new IntPtr((int)GetMenuItemID(sub, k)), IntPtr.Zero); return "ok " + t; }
                }
            }
        }
        return "menu item not found";
    }
    [StructLayout(LayoutKind.Sequential)] public struct MBI { public IntPtr Base; public IntPtr AllocBase; public uint AllocProtect; public IntPtr Size; public uint State; public uint Protect; public uint Type; }
    // the synced capture's stage changes up to Sirena Beach 1: field (retrace count), area, episode
    static readonly uint[] REF = { 7,0,0,325,15,0,615,0,0,5339,0,1,13047,1,0,26458,1,1,30332,2,255,30826,2,0,32382,55,0,37361,1,5,38192,2,255,38665,2,2,39964,47,0,41667,1,5,45261,2,255,45733,2,3,48584,1,5,49414,2,255,49909,2,4,57976,1,5,62050,4,255,62540,4,0,64270,1,6,65090,4,255,65605,4,6,67165,1,6,68259,8,255,68733,8,0,71307,1,6,71937,8,255,72405,8,1,76317,1,6,76947,8,255,77231,8,2,79471,1,7,80284,8,255,80761,8,3,83747,1,7,84560,8,255,85035,8,4,86106,42,0,88147,1,7,88960,8,255,89435,8,5,93631,1,7,94444,8,255,94924,8,6,96452,1,7,97861,1,8,98584,5,255,99073,5,0,99612,13,0,100121,13,6,100739,58,1,102722,13,7,103983,1,8,104982,5,255,105463,5,1,106230,50,0,108529,1,8,109527,5,255,110014,5,2,110552,13,1,112999,1,8,113997,5,255,114496,5,3,118090,1,8,119271,5,255,119804,5,2,122484,41,0,124514,1,8,125695,5,255,126187,5,6,126726,13,4,128067,1,8,129556,3,255,130035,3,0,131124,59,0,134292,1,8,135309,3,255,135793,3,1,136945,30,0,139386,1,8,140403,3,255,140884,3,2,142226,1,8,143243,3,255,143721,3,3,144503,48,0,146764,1,8,147781,3,255,148272,3,4,151896,1,8,152913,3,255,153388,3,5,156717,1,8,157734,3,255,158212,3,6,159618,1,8,160955,2,255,161421,2,5,163033,46,0,165838,1,8,166845,2,255,167317,2,6,168783,1,8,170270,6,255,170733,6,0 };
    static IntPtr h; static long ram;
    static bool okp(uint p) { return p >= 0x80000000u && p < 0x81800000u; }
    static byte[] b4 = new byte[4], b2 = new byte[2];
    static uint u32(uint a) { IntPtr r; ReadProcessMemory(h, new IntPtr(ram + (a & 0x1FFFFFF)), b4, new IntPtr(4), out r); return (uint)(b4[0] << 24 | b4[1] << 16 | b4[2] << 8 | b4[3]); }
    static float f32(uint a) { uint v = u32(a); return BitConverter.ToSingle(BitConverter.GetBytes(v), 0); }
    static long findRam() {
        long a = 0; MBI m;
        while (VirtualQueryEx(h, new IntPtr(a), out m, new IntPtr(Marshal.SizeOf(typeof(MBI)))) != IntPtr.Zero) {
            long size = m.Size.ToInt64();
            if (m.State == 0x1000 && m.Type == 0x40000 && size >= 0x2000000) {
                var b = new byte[6]; IntPtr r;
                if (ReadProcessMemory(h, m.Base, b, new IntPtr(6), out r) && System.Text.Encoding.ASCII.GetString(b) == "GMSJ01") return m.Base.ToInt64();
            }
            a = m.Base.ToInt64() + size; if (size <= 0) break;
        }
        return 0;
    }
    // returns "SUCCESS ..." or "FAIL ..." or "ERROR ..."
    public static string Run(string exe, string args, string trackPath, string logPath, int loadState, int saveState, string pokes) {
        SetThreadExecutionState(0x80000001u);   // ES_CONTINUOUS | ES_SYSTEM_REQUIRED: no idle sleep while this runs
        var track = new StreamWriter(trackPath); track.AutoFlush = true;
        var log = new StreamWriter(logPath, true); log.AutoFlush = true;
        var p = Process.Start(exe, args);
        try {
            h = OpenProcess(0x0438, false, p.Id);
            var sw = Stopwatch.StartNew();
            while (ram == 0 && !p.HasExited && sw.ElapsedMilliseconds < 120000) { System.Threading.Thread.Sleep(100); ram = findRam(); }
            if (ram == 0) return "ERROR no game memory";
            if (loadState > 0) {
                // load the savestate made at Sirena's start through Dolphin's menu, then check only Sirena
                System.Threading.Thread.Sleep(5000);
                log.WriteLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "   load state " + loadState + ": " + stateCommand(p.Id, "Load State", loadState));
                System.Threading.Thread.Sleep(4000);
            }
            // pokes "ADDR:WORD,..." written into game memory after the state load (code not yet run since the load is
            // compiled from memory, since loading a state clears Dolphin's JIT cache)
            if (pokes.Length > 0) foreach (string pk in pokes.Split(',')) {
                string[] aw = pk.Trim().Split(':'); uint pa = Convert.ToUInt32(aw[0], 16), pv = Convert.ToUInt32(aw[1], 16);
                byte[] wb = { (byte)(pv >> 24), (byte)(pv >> 16), (byte)(pv >> 8), (byte)pv }; IntPtr wn;
                bool ok = WriteProcessMemory(h, new IntPtr(ram + (pa & 0x1FFFFFF)), wb, new IntPtr(4), out wn);
                log.WriteLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "   poke " + pa.ToString("X8") + " = " + pv.ToString("X8") + (ok ? " ok" : " FAILED"));
            }
            uint lastRc = 0; long lastRcChange = 0, lastLog = 0, lastRcLog = 0; int lastArea = -1, lastEp = -1;
            bool inSirena = false; int refIdx = 0; uint sirenaRc = 0, lastTrackRc = 0;
            while (true) {
                if (p.HasExited) return "ERROR Dolphin exited at field " + lastRc;
                long now = sw.ElapsedMilliseconds;
                uint rc = u32(0x80409F00);
                byte area = (byte)(u32(0x803E600C) >> 8), ep = (byte)u32(0x803E600C);
                if (rc != lastRc) { lastRc = rc; lastRcChange = now; }
                if (now - lastRcChange > 180000) return "ERROR stalled at field " + rc;
                if (area != lastArea || ep != lastEp) {
                    track.WriteLine("area " + rc + " " + area + "," + ep); lastArea = area; lastEp = ep;
                    // before Sirena, every stage change has to come as the synced capture's did; that capture saw a new stage only once its
                    // director ticked, up to a load later, so a change may come up to 900 fields before the reference, 120 after
                    if (!inSirena && loadState == 0 && refIdx * 3 < REF.Length) {
                        uint rr = REF[refIdx * 3], ra = REF[refIdx * 3 + 1], re = REF[refIdx * 3 + 2];
                        if (area != ra || ep != re || (refIdx > 0 && ((long)rc > rr + 120 || (long)rc + 900 < rr)))
                            return "FAIL desync before Sirena: field " + rc + " entered " + area + "," + ep + ", the synced run entered " + ra + "," + re + " at " + rr;
                        refIdx++;
                    }
                }
                if (!inSirena && loadState == 0 && refIdx * 3 < REF.Length && rc > REF[refIdx * 3] + 600)
                    return "FAIL desync before Sirena: no change to " + REF[refIdx * 3 + 1] + "," + REF[refIdx * 3 + 2] + " by field " + rc + " (synced run: " + REF[refIdx * 3] + ")";
                uint md = u32(0x8040A2A8), mario = u32(0x8040A378);
                if (!inSirena && area == 6 && ep == 0 && okp(md) && okp(mario)) { inSirena = true; sirenaRc = rc; track.WriteLine("sirena " + rc);
                    if (saveState > 0) { log.WriteLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "   save state " + saveState + " at field " + rc + ": " + stateCommand(p.Id, "Save State", saveState)); System.Threading.Thread.Sleep(3000); } }
                if (inSirena) {
                    if (!okp(md)) return "FAIL the stage ended without the Shine at field " + rc + " (" + (rc - sirenaRc) + " in)";
                    if (area != 6 || ep != 0) return "FAIL left Sirena without the Shine at field " + rc + " (" + (rc - sirenaRc) + " in)";
                    if (okp(mario)) {
                        uint st = u32(mario + 0x7C);
                        if (st == 0x1302) return "SUCCESS Shine touch at field " + rc + " (" + (rc - sirenaRc) + " in)";
                        if (rc - lastTrackRc >= 10) {
                            lastTrackRc = rc;
                            track.WriteLine(rc + " " + st.ToString("X") + " " + f32(mario + 0x10) + " " + f32(mario + 0x14) + " " + f32(mario + 0x18) + " " + u32(0x80408CF0).ToString("X"));
                        }
                    }
                    if (rc - sirenaRc > 30000) return "FAIL no Shine after 30000 fields in Sirena";
                } else if (rc > 200000) return "FAIL Sirena not reached by field " + rc;
                if (now - lastLog >= 60000) {
                    double fps = (rc - lastRcLog) * 1000.0 / Math.Max(1, now - lastLog);
                    lastLog = now; lastRcLog = rc;
                    log.WriteLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "   field " + rc + " area " + area + "," + ep + " (" + fps.ToString("F0") + " fields/s)");
                }
                System.Threading.Thread.Sleep(inSirena ? 1 : 20);
            }
        } finally {
            try { if (!p.HasExited) { p.Kill(); p.WaitForExit(20000); } } catch { }
            track.Close(); log.Close();
        }
    }
}
"@
Add-Type -TypeDefinition $src 
$safe = $name -replace '[^A-Za-z0-9_-]', '_'
New-Item -ItemType Directory -Force -Path (Join-Path $here 'sweep') | Out-Null
$dargs = "-b -e `"$iso`" -m `"$dtm`""
$t0 = Get-Date
$st = Join-Path $dol "User\StateSaves\GMSJ01.s0$loadstate"
if ($loadstate -gt 0 -and -not (Test-Path $st)) { Log "waiting for the savestate $st"; exit 2 }
if ($true) {
$r = [Sweep]::Run((Join-Path $dol 'Dolphin.exe'), $dargs, (Join-Path $here "sweep\$safe.txt"), $log, $loadstate, $savestate, $pokes) }
$mins = [math]::Round(((Get-Date) - $t0).TotalMinutes, 1)
Log "result $name : $r ($mins min)"
Add-Content -Path $results -Value "$name | $r | $mins min | $entry"
if ($r.StartsWith('SUCCESS')) {
    Set-Content -Path (Join-Path $here 'WINNER.txt') -Value "$entry`r`n$r"
    $c = Get-Content $ini; $c = $c -replace '^EmulationSpeed = .*', 'EmulationSpeed = 1.00000000'; Set-Content -Path $ini -Value $c
    exit 3
}
exit 0
