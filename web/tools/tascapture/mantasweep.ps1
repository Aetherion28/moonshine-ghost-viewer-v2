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
if (Test-Path $results) { foreach ($l in Get-Content $results) { $n = ($l -split '\|')[0].Trim(); if ($n) { $done[$n] = 1 } } }
$entry = $null
foreach ($l in Get-Content $queue) {
    $t = $l.Trim(); if (-not $t -or $t.StartsWith('#')) { continue }
    $n = ($t -split ';')[0].Trim(); if (-not $done.ContainsKey($n)) { $entry = $t; break }
}
if (-not $entry) { Log 'queue empty'; exit 2 }
$parts = $entry -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$name = $parts[0]; $sram = 'stereo'; $backend = 'D3D'; $game = @{}
foreach ($p in $parts[1..($parts.Count - 1)]) {
    $k, $v = $p -split '=', 2
    if ($k -eq 'sram') { $sram = $v } elseif ($k -eq 'backend') { $backend = $v }
    else { $s, $key = $k -split '\.', 2; if (-not $game.ContainsKey($s)) { $game[$s] = @() }; $game[$s] += "$key = $v" }
}
Log "attempt $name : $entry"

# Dolphin.ini: unlimited speed, the backend (the movie sets idle skip, dual core, DSP and the EFB access / copy options itself)
$ini = Join-Path $dol 'User\Config\Dolphin.ini'
if (-not (Test-Path "$ini.sweepbak")) { Copy-Item $ini "$ini.sweepbak" }
$c = Get-Content $ini
$c = $c -replace '^EmulationSpeed = .*', 'EmulationSpeed = 0.00000000' -replace '^GFXBackend = .*', "GFXBackend = $backend"
Set-Content -Path $ini -Value $c
# the game ini
$gdir = Join-Path $dol 'User\GameSettings'; New-Item -ItemType Directory -Force -Path $gdir | Out-Null
$g = @(); foreach ($s in $game.Keys) { $g += "[$s]"; $g += $game[$s] }
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
    [DllImport("kernel32.dll")] static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr a, out MBI m, IntPtr len);
    [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint f);
    [StructLayout(LayoutKind.Sequential)] public struct MBI { public IntPtr Base; public IntPtr AllocBase; public uint AllocProtect; public IntPtr Size; public uint State; public uint Protect; public uint Type; }
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
    public static string Run(string exe, string args, string trackPath, string logPath) {
        SetThreadExecutionState(0x80000001u);   // ES_CONTINUOUS | ES_SYSTEM_REQUIRED: no idle sleep while this runs
        var track = new StreamWriter(trackPath); track.AutoFlush = true;
        var log = new StreamWriter(logPath, true); log.AutoFlush = true;
        var p = Process.Start(exe, args);
        try {
            h = OpenProcess(0x0410, false, p.Id);
            var sw = Stopwatch.StartNew();
            while (ram == 0 && !p.HasExited && sw.ElapsedMilliseconds < 120000) { System.Threading.Thread.Sleep(100); ram = findRam(); }
            if (ram == 0) return "ERROR no game memory";
            uint lastRc = 0; long lastRcChange = 0, lastLog = 0, lastRcLog = 0; int lastArea = -1, lastEp = -1;
            bool inSirena = false; uint sirenaRc = 0, lastTrackRc = 0;
            while (true) {
                if (p.HasExited) return "ERROR Dolphin exited at field " + lastRc;
                long now = sw.ElapsedMilliseconds;
                uint rc = u32(0x80409F00);
                byte area = (byte)(u32(0x803E600C) >> 8), ep = (byte)u32(0x803E600C);
                if (rc != lastRc) { lastRc = rc; lastRcChange = now; }
                if (now - lastRcChange > 180000) return "ERROR stalled at field " + rc;
                if (area != lastArea || ep != lastEp) { track.WriteLine("area " + rc + " " + area + "," + ep); lastArea = area; lastEp = ep; }
                uint md = u32(0x8040A2A8), mario = u32(0x8040A378);
                if (!inSirena && area == 6 && ep == 0 && okp(md) && okp(mario)) { inSirena = true; sirenaRc = rc; track.WriteLine("sirena " + rc); }
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
$dargs = "-b -V `"$backend`" -e `"$iso`" -m `"$dtm`""
$t0 = Get-Date
$r = [Sweep]::Run((Join-Path $dol 'Dolphin.exe'), $dargs, (Join-Path $here "sweep\$safe.txt"), $log)
$mins = [math]::Round(((Get-Date) - $t0).TotalMinutes, 1)
Log "result $name : $r ($mins min)"
Add-Content -Path $results -Value "$name | $r | $mins min | $entry"
if ($r.StartsWith('SUCCESS')) {
    Set-Content -Path (Join-Path $here 'WINNER.txt') -Value "$entry`r`n$r"
    $c = Get-Content $ini; $c = $c -replace '^EmulationSpeed = .*', 'EmulationSpeed = 1.00000000'; Set-Content -Path $ini -Value $c
    exit 3
}
exit 0
