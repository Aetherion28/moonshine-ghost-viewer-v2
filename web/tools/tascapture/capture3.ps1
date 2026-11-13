# Plays the any% TAS in Dolphin 5.0-114 and records the game's state from its memory, enough to build both a
# Moonshine ghost (.smsghost) and a full trace (.msgt), split by level afterwards (the stage is in every frame).
#
# capture2.bin: a stream of records, each  u32 tag, u32 length, payload  (the record header little-endian; the
# game's bytes as the game has them, big-endian):
#   'HEAD'  the capture's version (2), the RAM base found, the start time
#   'FRAM'  once a game frame, when the director's movement stopped for 2 ms (the frame's work done):
#           u32 retrace count, u32 field count, u32 director ticks, u32 movement ticks, u32 director state,
#           u32 director setup word (0x260), u32 rand seed, u32 Mario, camera, FLUDD, Yoshi pointers, then
#           0x30 bytes of the application (state, areas), 0x40 of JUTGamePad::mPadStatus, u32 wall ms
#   'TICK'  every movement tick seen (the director's tick word changed): u32 movement ticks, u32 retrace count
#   'BLOB'  an object's bytes, sent as the 4-byte words that changed since its last record of that key:
#           u32 key, u32 address, u32 size, u32 word count n, then n x (u16 word index, u32 word)
#           keys: 1 Mario (0x574), 2 camera (0x350), 3 FLUDD (0x1DBC), 4 Yoshi (0x124), 5 TFlagManager (0x400),
#           6 the director (0x300), 7 Mario's motion frame control (0x14: the animation's frame for the ghost),
#           0x1000 + i the roster's actor i (0x150; its address says which actor it is)
#           (a key's state starts over when its address or size changes: then every word is sent)
#   'ROST'  each frame: the conductor's actors in the recorder's order (enemy managers, other managers, alone):
#           u32 count, then per actor u32 address, u32 vtable
#   capture3 adds (keys): per movement tick 7 Mario's motion frame control, 8 Mario's TMarioGamePad (0xF0),
#           9 his TMarioControllerWork (0x24), 10..13 the wall / roof / floor / water-floor triangles (0x48 each),
#           14 the camera's in-between (0x48), 15 JUTGamePad's button / stick mirrors (0x50, from 0x80400D80 /
#           0x80400E40 / 0x80400E80), and 'TPTR': u32 tick, the four triangle pointers, the in-between pointer, the
#           camera mode; per frame 16 the application's game pad 0 (0xF0), 17 the stage heap (0x74), 'VISL':
#           the 8-byte FLUDD / Yoshi observation as Moonshine's GhostFludd::capture makes it, and u32 NPC phase
#           (TBaseNPC::initSinkNpc_'s sCheckPollutedStartCounter, 0x8040A4A0)
#   'DONE'  the end
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = @"
using System;
using System.IO;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class Cap3 {
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a, bool b, int pid);
    [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] buf, IntPtr n, out IntPtr r);
    [DllImport("kernel32.dll")] static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr a, out MBI m, IntPtr len);
    [StructLayout(LayoutKind.Sequential)] public struct MBI { public IntPtr Base; public IntPtr AllocBase; public uint AllocProtect; public IntPtr Size; public uint State; public uint Protect; public uint Type; }
    const int MEM1 = 0x1800000;
    static IntPtr h; static long ram;
    static byte[] mem = new byte[MEM1];
    static byte[] small = new byte[0x600];
    static BinaryWriter o;
    static Dictionary<uint, uint[]> prev = new Dictionary<uint, uint[]>();
    static Dictionary<uint, uint> prevAddr = new Dictionary<uint, uint>();
    static bool okp(uint p) { return p >= 0x80000000u && p < 0x81800000u; }
    static uint be(byte[] b, int i) { return (uint)(b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]); }
    static uint m32(uint a) { int i = (int)(a & 0x1FFFFFF); return i + 4 <= MEM1 ? be(mem, i) : 0; }
    static bool rd(uint a, byte[] b, int n) { IntPtr r; return ReadProcessMemory(h, new IntPtr(ram + (a & 0x1FFFFFF)), b, new IntPtr(n), out r); }
    static uint u32(uint a) { var b = new byte[4]; rd(a, b, 4); return be(b, 0); }
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
    static void rec(string tag, byte[] body, int n) {
        o.Write((uint)(tag[0] | tag[1] << 8 | tag[2] << 16 | tag[3] << 24)); o.Write((uint)n); o.Write(body, 0, n);
    }
    static void put(List<byte> l, uint v) { l.Add((byte)(v >> 24)); l.Add((byte)(v >> 16)); l.Add((byte)(v >> 8)); l.Add((byte)v); }
    // an object's changed words, from src at off (src is MEM1 or a separate read)
    static void blob(uint key, uint addr, byte[] src, int off, int size) {
        int words = size / 4; uint[] p; uint pa;
        bool fresh = !prev.TryGetValue(key, out p) || p.Length != words || !prevAddr.TryGetValue(key, out pa) || pa != addr;
        if (fresh) { p = new uint[words]; prev[key] = p; prevAddr[key] = addr; }
        var body = new List<byte>(16 + words * 6);
        put(body, key); put(body, addr); put(body, (uint)size); put(body, 0);
        int n = 0;
        for (int i = 0; i < words; i++) {
            uint v = be(src, off + i * 4);
            if (fresh || v != p[i]) { p[i] = v; body.Add((byte)(i >> 8)); body.Add((byte)i); put(body, v); n++; }
        }
        if (n == 0) return;
        var a = body.ToArray(); a[12] = (byte)(n >> 24); a[13] = (byte)(n >> 16); a[14] = (byte)(n >> 8); a[15] = (byte)n;
        rec("BLOB", a, a.Length);
    }
    static void blobMem(uint key, uint addr, int size) { if (okp(addr) && (addr & 0x1FFFFFF) + size <= MEM1) blob(key, addr, mem, (int)(addr & 0x1FFFFFF), size); }
    static float f32m(uint a) { return BitConverter.ToSingle(BitConverter.GetBytes(m32(a)), 0); }
    static int s16m(uint a) { uint w = m32(a & ~3u); return (short)((a & 2) != 0 ? (w & 0xFFFF) : (w >> 16)); }
    static byte u8m(uint a) { return mem[(int)(a & 0x1FFFFFF)]; }
    static byte[] padMirror = new byte[0x50];
    static float lastEmitAcc = 0; static uint lastGun = 0;
    static bool fin(float v) { return v >= -1000000f && v <= 1000000f; }
    // GhostFludd::pack (ghost_fludd.cpp)
    static void pack(byte[] o, uint mario, int nozzle, float px, float py, float pz, float dx, float dy, float dz, bool spray, float power) {
        Array.Clear(o, 0, 8);
        if (!fin(dx) || !fin(dy) || !fin(dz)) return;
        float flat = (float)Math.Sqrt(dx * dx + dz * dz);
        if (flat + Math.Abs(dy) < 0.0001f) return;
        float[] off = { px - f32m(mario + 0x10), py - f32m(mario + 0x14), pz - f32m(mario + 0x18) };
        for (int i = 0; i < 3; i++) if (!fin(off[i]) || off[i] < -254f || off[i] > 254f) return;
        for (int i = 0; i < 3; i++) o[1 + i] = (byte)(sbyte)(int)(off[i] * 0.5f + (off[i] < 0 ? -0.5f : 0.5f));
        float turn = 651.8986469f;
        uint yaw = (uint)(int)((float)Math.Atan2(dx, dz) * turn) & 4095u;
        uint pitch = (uint)(int)((float)Math.Atan2(dy, flat) * turn) & 4095u;
        o[4] = (byte)(yaw >> 4); o[5] = (byte)((yaw << 4) | (pitch >> 8)); o[6] = (byte)pitch;
        o[0] = (byte)(nozzle | 0x08 | (spray ? 0x10 : 0));
        if (spray && fin(power) && power > 0) o[7] = (byte)(power >= 255 ? 255 : power + 0.5f);
    }
    // the emitter joint per nozzle (WaterGun.cpp nozzleBmdData, emitter 0: flags, joint index)
    static readonly int[] emitFlag = { 1, 2, 1, 3, 1, 1 }, emitJoint = { 0, 1, 0, 0, 0, 0 };
    // GhostFludd::capture from the frame's memory: Yoshi's observation, else FLUDD's (emitting when its water
    // counter unk1C88 grew this frame: TWaterGun::updateUnk1C88 adds to it on every accepted emitRequest)
    static byte[] visual(uint mario) {
        var o = new byte[8];
        if (!okp(mario)) return o;
        uint gun = m32(mario + 0x3E4), yo = m32(mario + 0x3F0);
        bool emitted = false, burst = false; int cur = okp(gun) ? u8m(gun + 0x1C84) : 9;
        if (okp(gun)) {
            float acc = f32m(gun + 0x1C88);
            emitted = gun == lastGun && acc > lastEmitAcc;
            lastEmitAcc = acc; lastGun = gun;
            burst = (cur == 0 && u8m(gun + 0x390 + 0x385) == 1) || (cur == 3 && u8m(gun + 0x11B8 + 0x385) == 1);
        }
        if (okp(yo) && (sbyte)u8m(yo) == 8) {
            uint actor = m32(yo + 0x34); if (!okp(actor)) return o;
            uint bck = m32(actor + 0x0C), model = m32(actor + 4); if (!okp(bck) || !okp(model)) return o;
            uint md = m32(model + 4); if (!okp(md) || (m32(md + 0x1C) >> 16) <= 21) return o;
            uint anms = m32(actor + 0x28), anm = okp(anms) ? m32(anms) : 0; if (!okp(anm)) return o;
            int index = (int)m32(anm); float fr = f32m(anm + 4 + 0x10);
            if (index < 0 || index >= 26 || !fin(fr) || fr < 0 || fr >= 4096) return o;
            o[0] = (byte)(0x80 | (emitted ? 0x10 | (burst ? 0x20 : 0) : 0));
            o[1] = (byte)index;
            uint ph = (uint)(fr * 16f + 0.5f); if (ph > 65535) ph = 65535;
            o[2] = (byte)(ph >> 8); o[3] = (byte)ph;
            uint ctl = m32(bck + 0x34), calc = okp(ctl) ? m32(ctl + 8) : 0; float blend = okp(calc) ? f32m(calc + 0x50) : 0f;
            if (index == 15 && fin(blend) && blend > 0) o[4] = blend >= 1 ? (byte)255 : (byte)(blend * 255f + 0.5f);
            uint joints = m32(md + 0x20), upper = okp(joints) ? m32(joints + 18 * 4) : 0, uc = okp(upper) ? m32(upper + 0x58) : 0;
            if (uc != 0 && uc == m32(yo + 0x54)) o[5] = 3; else if (uc != 0 && uc == m32(yo + 0x58)) o[5] = 4;
            int nf = s16m(yo + 0x5C + 8); float uf = f32m(yo + 0x5C + 0x10);
            if (o[5] != 0 && nf > 0 && fin(uf)) { float r = uf / nf; if (r < 0) r = 0; o[6] = r >= 1 ? (byte)255 : (byte)(r * 255f + 0.5f); }
            if (okp(gun) && cur < 6) { uint nz = m32(gun + 0x1C68 + 4 * (uint)cur); if (okp(nz)) o[7] = (byte)(s16m(nz + 0x36E) / 256); }
            return o;
        }
        if ((m32(mario + 0x118) & 0x8000) == 0 || !okp(gun) || cur >= 6) return o;
        if (emitted) {
            uint ei = m32(gun + 0x1D0C); if (!okp(ei)) return o;
            pack(o, mario, cur, f32m(ei + 0x70), f32m(ei + 0x74), f32m(ei + 0x78), f32m(ei + 0x54), f32m(ei + 0x58), f32m(ei + 0x5C), true, f32m(ei + 0xBC));
            if (o[0] != 0 && burst) o[0] |= 0x20;
        } else {
            uint mtx = 0;
            if (emitFlag[cur] == 3) { uint a = okp(yo) ? m32(yo + 0x34) : 0, mdl = okp(a) ? m32(a + 4) : 0, nm = okp(mdl) ? m32(mdl + 0x58) : 0; if (okp(nm)) mtx = nm + (m32(yo + 0x3C) >> 16) * 0x30; }
            else { uint nz = m32(gun + 0x1C68 + 4 * (uint)cur), a = okp(nz) ? m32(nz + 0x380) : 0, mdl = okp(a) ? m32(a + 4) : 0, nm = okp(mdl) ? m32(mdl + 0x58) : 0; if (okp(nm)) mtx = nm + (uint)emitJoint[cur] * 0x30; }
            if (!okp(mtx)) return o;
            pack(o, mario, cur, f32m(mtx + 12), f32m(mtx + 28), f32m(mtx + 44), f32m(mtx), f32m(mtx + 16), f32m(mtx + 32), false, 0);
        }
        return o;
    }
    static void blobLive(uint key, uint addr, int size) { if (okp(addr) && rd(addr, small, size)) blob(key, addr, small, 0, size); }
    // the conductor's actors, as Moonshine's recorder (and v3's roster()) lists them
    static List<uint> roster() {
        var outl = new List<uint>(); var seen = new HashSet<uint>();
        uint con = m32(0x8040A6E8); if (!okp(con)) return outl;
        foreach (uint list in new uint[] { 0x20, 0x10 }) {
            uint end = con + list + 8; int guard = 0;
            for (uint node = m32(end); node != end && okp(node) && guard++ < 4096; node = m32(node)) {
                uint mgr = m32(node + 8); if (!okp(mgr)) continue;
                uint n = m32(mgr + 0x14), ary = m32(mgr + 0x18);
                if (n <= 2048 && okp(ary)) for (uint i = 0; i < n; i++) { uint a = m32(ary + 4 * i); if (okp(a) && seen.Add(a)) outl.Add(a); }
            }
        }
        { uint end = con + 0x30 + 8; int guard = 0;
          for (uint node = m32(end); node != end && okp(node) && guard++ < 4096; node = m32(node)) { uint a = m32(node + 8); if (okp(a) && seen.Add(a)) outl.Add(a); } }
        return outl;
    }
    public static void Run(string dir, string exe, string iso, string dtm) {
        var log = new StreamWriter(Path.Combine(dir, "capture3_log.txt")); log.AutoFlush = true;
        o = new BinaryWriter(new BufferedStream(File.Create(Path.Combine(dir, "capture3.bin")), 1 << 20));
        var p = Process.Start(exe, "-b -e \"" + iso + "\" -m \"" + dtm + "\"");
        h = OpenProcess(0x0410, false, p.Id);
        var sw = Stopwatch.StartNew();
        while (ram == 0 && !p.HasExited) { System.Threading.Thread.Sleep(50); ram = findRam(); }
        log.WriteLine("ram at " + ram.ToString("X") + " after " + sw.ElapsedMilliseconds + " ms");
        { var hb = new List<byte>(); put(hb, 3); put(hb, (uint)(ram >> 32)); put(hb, (uint)ram); put(hb, (uint)DateTime.UtcNow.Subtract(new DateTime(1970, 1, 1)).TotalSeconds); var a = hb.ToArray(); rec("HEAD", a, a.Length); }
        uint lastRc = 0xFFFFFFFF, lastMt = 0xFFFFFFFF, lastSampledTicks = 0xFFFFFFFF; long lastChange = 0; bool pending = false;
        long frames = 0, ticks = 0, fields = 0, lastLog = 0;
        var tb = new byte[8];
        while (!p.HasExited) {
            uint rc = u32(0x80409F00);
            uint md = u32(0x8040A2A8);
            long now = sw.ElapsedTicks * 1000 / Stopwatch.Frequency;
            if (rc != lastRc) { lastRc = rc; fields++; pending = true; }
            if (okp(md)) {
                uint mt = u32(md + 0x58);
                if (mt != lastMt) {
                    lastMt = mt; lastChange = now; ticks++;
                    // Mario and the camera at each movement tick (the recorder takes them as each tick's Mario perform begins)
                    var t = new List<byte>(); put(t, mt); put(t, rc); var ta = t.ToArray(); rec("TICK", ta, ta.Length);
                    blobLive(1, u32(0x8040A378), 0x574);
                    blobLive(2, u32(0x8040B370), 0x350);
                    uint ma = u32(0x8040A378), ca = u32(0x8040B370);
                    if (okp(ma)) {
                        blobLive(8, u32(ma + 0x4FC), 0xF0); blobLive(9, u32(ma + 0x108), 0x24);
                        uint mdl = u32(ma + 0x3A8); if (okp(mdl)) blobLive(7, u32(mdl + 0xC), 0x14);
                        var tp = new List<byte>(); put(tp, mt);
                        for (uint r = 0; r < 4; r++) { uint tri = u32(ma + 0xD8 + 4 * r); put(tp, tri); blobLive(10 + r, tri, 0x48); }
                        uint ib = okp(ca) ? u32(ca + 0x6C) : 0; put(tp, ib); put(tp, okp(ca) ? u32(ca + 0x50) : 0xFFFFFFFF);
                        blobLive(14, ib, 0x48);
                        var tpa = tp.ToArray(); rec("TPTR", tpa, tpa.Length);
                    }
                    if (rd(0x80400D80, padMirror, 0x30)) { var b2 = new byte[0x10]; rd(0x80400E40, b2, 0x10); Array.Copy(b2, 0, padMirror, 0x30, 0x10); rd(0x80400E80, b2, 0x10); Array.Copy(b2, 0, padMirror, 0x40, 0x10); blob(15, 0x80400D80, padMirror, 0, 0x50); }
                }
            }
            bool idle = !okp(md) || now - lastChange >= 2;
            // (without a director, between stages and in menus, one frame record each 8 fields is enough)
            if (pending && !okp(md) && fields % 8 != 0) pending = false;
            if (pending && idle) {
                IntPtr r;
                if (!ReadProcessMemory(h, new IntPtr(ram), mem, new IntPtr(MEM1), out r)) { System.Threading.Thread.Sleep(1); continue; }
                pending = false;
                uint d = m32(0x8040A2A8), dticks = okp(d) ? m32(d + 0x5C) : 0;
                if (okp(d) && dticks == lastSampledTicks) continue;   // nothing moved since the last frame record
                lastSampledTicks = dticks; frames++;
                uint mario = m32(0x8040A378), cam = m32(0x8040B370);
                uint fludd = okp(mario) ? m32(mario + 0x3E4) : 0, yoshi = okp(mario) ? m32(mario + 0x3F0) : 0;
                var f = new List<byte>(256);
                put(f, rc); put(f, (uint)fields); put(f, dticks); put(f, okp(d) ? m32(d + 0x58) : 0); put(f, okp(d) ? m32(d + 0x64) : 0xFFFFFFFF);
                put(f, okp(d) ? m32(d + 0x260) : 0); put(f, m32(0x80408CF0)); put(f, mario); put(f, cam); put(f, fludd); put(f, yoshi);
                for (int i = 0; i < 0x30; i++) f.Add(mem[0x3E6000 + i]);
                for (int i = 0; i < 0x40; i++) f.Add(mem[0x400D50 + i]);
                put(f, (uint)now);
                var fa = f.ToArray(); rec("FRAM", fa, fa.Length);
                blobMem(1, mario, 0x574); blobMem(2, cam, 0x350); blobMem(3, fludd, 0x1DBC); blobMem(4, yoshi, 0x124);
                blobMem(5, m32(0x8040A290), 0x400); blobMem(6, d, 0x300);
                blobMem(16, m32(0x803E6020), 0xF0); blobMem(17, m32(0x803E6040), 0x74);
                { var vl = new List<byte>(); vl.AddRange(visual(mario)); put(vl, m32(0x8040A4A0)); var va = vl.ToArray(); rec("VISL", va, va.Length); }
                var list = roster();
                var rl = new List<byte>(8 + list.Count * 8); put(rl, (uint)list.Count);
                foreach (uint a in list) { put(rl, a); put(rl, m32(a)); }
                var ra = rl.ToArray(); rec("ROST", ra, ra.Length);
                for (int i = 0; i < list.Count; i++) blobMem((uint)(0x1000 + i), list[i], 0x150);
                if (now - lastLog >= 10000) {
                    lastLog = now; o.Flush();
                    uint app = 0x3E6000;
                    log.WriteLine("t " + now + " fields " + fields + " frames " + frames + " ticks " + ticks + " area " + mem[app + 0xE] + "," + mem[app + 0xF] + " dirState " + (okp(d) ? m32(d + 0x64) : 0xFFFFFFFF) + " actors " + list.Count + " bytes " + o.BaseStream.Position);
                }
            } else if (!pending) System.Threading.Thread.SpinWait(50);
        }
        rec("DONE", new byte[0], 0); o.Close(); log.WriteLine("done: " + frames + " frames, " + ticks + " ticks, " + fields + " fields");
    }
}
"@
Add-Type -TypeDefinition $src
[Cap3]::Run($here, (Join-Path $here 'Dolphin-x64\Dolphin.exe'), 'C:\Users\devon\OneDrive\Desktop\Dolphin-x64\Games\SMS\JP 1.0 (GMSJ01).iso', (Join-Path $here 'sms-anypct-tas.dtm'))
