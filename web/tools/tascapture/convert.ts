// Converts capture2.bin (capture2.ps1: Dolphin's MEM1 read during the TAS's playback) into one Moonshine
// .smsghost and one .msgt trace per level, named as Moonshine's IL list names them (iling_entries.inc).
//   node convert.mjs <capture2.bin> <outdir>
// A level runs from its first stage's first Mario update to the tick his status turns 0x1302 (the Shine touch).
// A level with a secret also gets the secret alone ("<level> (Secret)"), from the secret's load to its Shine.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fnv1a } from '../../src/ghost/mstr.js';

const [, , capPath, outDir] = process.argv;
const cap = readFileSync(capPath);
const cdv = new DataView(cap.buffer, cap.byteOffset, cap.byteLength);

/** The levels of this run: the Shine ID set in them, their label, the secret area (if any), the area their file starts in. */
const LEVELS: { shine: number; label: string; secret?: number; startArea?: number }[] = [
    { shine: 86, label: 'Airstrip 1' }, { shine: 1, label: 'Bianco 2' },
    { shine: 2, label: 'Bianco 3', secret: 0x2f }, { shine: 3, label: 'Bianco 4' }, { shine: 4, label: 'Bianco 5' },
    { shine: 27, label: 'Gelato GBS' }, { shine: 26, label: 'Gelato 7' },
    { shine: 60, label: 'Pianta 1' }, { shine: 65, label: 'Pianta 2' }, { shine: 62, label: 'Pianta 3' }, { shine: 61, label: 'Pianta 4' },
    { shine: 64, label: 'Pianta 5', secret: 0x2a }, { shine: 63, label: 'Pianta 6' }, { shine: 66, label: 'Pianta 7' },
    { shine: 30, label: 'Pinna 1', startArea: 0x0d }, { shine: 31, label: 'Pinna 2', secret: 0x32 },
    { shine: 32, label: 'Pinna 3', startArea: 0x0d }, { shine: 33, label: 'Pinna 4' }, { shine: 35, label: 'Pinna 6', secret: 0x29 },
    { shine: 36, label: 'Pinna 7', startArea: 0x0d },
    { shine: 10, label: 'Ricco 1' }, { shine: 11, label: 'Ricco 2' }, { shine: 12, label: 'Ricco 3' }, { shine: 13, label: 'Ricco 4', secret: 0x30 },
    { shine: 14, label: 'Ricco 5' }, { shine: 15, label: 'Ricco 6' }, { shine: 16, label: 'Ricco 7' },
    { shine: 5, label: 'Bianco 6', secret: 0x2e }, { shine: 6, label: 'Bianco 7' },
];
// (Moonshine labels a level with a secret "<n> (Full)", Ricco 2 included: SHINE_FULL("Ricco 2 (Full)"))
const FULL = new Set(['Bianco 3', 'Pianta 5', 'Pinna 2', 'Pinna 6', 'Ricco 2', 'Ricco 4', 'Bianco 6']);

// ---------------------------------------------------------------- reading the capture
const u32 = (d: Uint8Array, o: number) => (d[o] << 24 | d[o + 1] << 16 | d[o + 2] << 8 | d[o + 3]) >>> 0;

interface Blob { addr: number; data: Uint8Array }
interface Tick { status: number; hasMario: boolean; mt: number; mario: Uint8Array | null; camera: Uint8Array | null; marioAddr: number; cameraAddr: number }
interface Frame {
    i: number; rc: number; dticks: number; moveTicks: number; dirState: number; seed: number; area: number; episode: number;
    pad: Uint8Array; ticks: Tick[]; mario: Uint8Array | null; fludd: Blob | null; yoshi: Blob | null; frameCtrl: Uint8Array | null;
    actors: { addr: number; data: Uint8Array }[]; shines: Set<number>; ms: number;
    marioPtr?: number; flPtr?: number; yoPtr?: number; flags?: Uint8Array;
}
const blobs = new Map<number, Blob>();
let frames: Frame[] = [];
let light: Frame[] = [];
let pendingTicks: Tick[] = [];
let lastFrame: Frame | null = null;
let rosterAddrs: number[] = [];
let inFrameBlobs = false;
let nFrames = 0;
const shineSet = (flags: Uint8Array) => { const s = new Set<number>(); for (let i = 0; i < 120; i++) if (flags[i >> 3] >> (i & 7) & 1) s.add(i); return s; };
let p = 0;
function applyBlob(b: Uint8Array) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const key = v.getUint32(0), addr = v.getUint32(4), size = v.getUint32(8), n = v.getUint32(12);
    let s = blobs.get(key);
    if (!s || s.addr !== addr || s.data.length !== size) { s = { addr, data: new Uint8Array(size) }; blobs.set(key, s); }
    for (let i = 0, q = 16; i < n; i++, q += 6) { const w = v.getUint16(q); s.data.set(b.subarray(q + 2, q + 6), w * 4); }
    return key;
}
const copy = (k: number) => { const s = blobs.get(k); return s ? { addr: s.addr, data: s.data.slice() } : null; };
function parse(full: (i: number) => boolean, cb: (f: Frame) => void) {
blobs.clear(); pendingTicks = []; lastFrame = null; rosterAddrs = []; inFrameBlobs = false; nFrames = 0; p = 0;
while (p < cap.length) {
    const tag = cap.toString('latin1', p, p + 4), len = cdv.getUint32(p + 4, true);
    const body = new Uint8Array(cap.buffer, cap.byteOffset + p + 8, len);
    const bv = new DataView(body.buffer, body.byteOffset, len);
    p += 8 + len;
    if (tag === 'TICK') pendingTicks.push({ status: 0, hasMario: false, mt: bv.getUint32(0), mario: null, camera: null, marioAddr: 0, cameraAddr: 0 });
    else if (tag === 'BLOB') {
        const key = applyBlob(body);
        if ((key === 1 || key === 2) && pendingTicks.length && !inFrameBlobs) {
            const t = pendingTicks[pendingTicks.length - 1], s = blobs.get(key)!;
            if (key === 1) { t.hasMario = true; t.status = u32(s.data, 0x7c); }
            if (full(nFrames)) { const c = copy(key)!; if (key === 1) { t.mario = c.data; t.marioAddr = c.addr; } else { t.camera = c.data; t.cameraAddr = c.addr; } }
        }
    } else if (tag === 'FRAM') {
        inFrameBlobs = true;
        const app = body.subarray(44, 44 + 0x30);
        const f: Frame = {
            i: nFrames++, rc: bv.getUint32(0), dticks: bv.getUint32(8), moveTicks: bv.getUint32(12), dirState: bv.getUint32(16),
            seed: bv.getUint32(24), area: app[0xe], episode: app[0xf], pad: body.slice(44 + 0x30, 44 + 0x70), ticks: pendingTicks,
            mario: null, fludd: null, yoshi: null, frameCtrl: null, actors: [], shines: new Set(), ms: bv.getUint32(44 + 0x70),
        };
        f.marioPtr = bv.getUint32(28); f.flPtr = bv.getUint32(36); f.yoPtr = bv.getUint32(40);
        pendingTicks = [];
        lastFrame = f;
    } else if (tag === 'ROST') {
        const n = bv.getUint32(0); rosterAddrs = [];
        for (let i = 0; i < n; i++) rosterAddrs.push(bv.getUint32(4 + 8 * i));
    } else if (tag === 'DONE') break;
    // a frame's own blobs end at the next TICK or FRAM: close the frame then
    const next = p < cap.length ? cap.toString('latin1', p, p + 4) : 'DONE';
    if (inFrameBlobs && next !== 'BLOB' && next !== 'ROST') {
        const f = lastFrame!;
        const fg = blobs.get(5); f.shines = fg ? shineSet(fg.data) : new Set();
        inFrameBlobs = false;
        if (!full(f.i)) { f.pad = new Uint8Array(0); cb(f); continue; }
        f.flags = fg ? fg.data.slice(0, 0x100) : undefined;
        const m = blobs.get(1); f.mario = m && m.addr === f.marioPtr ? m.data.slice() : null;
        const fl = blobs.get(3); f.fludd = fl && fl.addr === f.flPtr ? { addr: fl.addr, data: fl.data.slice() } : null;
        const yo = blobs.get(4); f.yoshi = yo && yo.addr === f.yoPtr ? { addr: yo.addr, data: yo.data.slice() } : null;
        const fc = blobs.get(7); f.frameCtrl = fc ? fc.data.slice() : null;
        f.actors = rosterAddrs.map((a, i) => { const s = blobs.get(0x1000 + i); return s && s.addr === a ? { addr: a, data: s.data.slice() } : null; }).filter((x): x is { addr: number; data: Uint8Array } => !!x);
        cb(f);
    }
}
}
parse(() => false, (f) => { light.push(f); });
console.log(`${light.length} frames read`);

// ---------------------------------------------------------------- the levels
const f32 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset + o, 4).getFloat32(0);
const s16 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset + o, 2).getInt16(0);
const u16 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset + o, 2).getUint16(0);
const isPlaza = (a: number) => a === 1 || a === 15;

/** the frame (and tick) where the Shine flag was set, then back to the tick status first reads 0x1302 */
interface Cut { f0: number; f1: number; t1: number }
function cutFor(L: typeof LEVELS[0], secretOnly: boolean): Cut {
    const frames = light;
    const fs = frames.findIndex((f) => f.shines.has(L.shine));
    if (fs < 0) throw new Error('no Shine ' + L.shine);
    // the Shine touch: the last tick at or before the flag's frame whose Mario status turns 0x1302
    let f1 = -1, t1 = -1;
    for (let i = fs; i >= 0 && f1 < 0; i--) {
        const ts = frames[i].ticks;
        for (let k = 0; k < ts.length; k++) {
            if (!ts[k].hasMario || ts[k].status !== 0x1302) continue;
            const prev = k ? ts[k - 1] : frames[i - 1].ticks.length ? frames[i - 1].ticks[frames[i - 1].ticks.length - 1] : null;
            if (prev && prev.hasMario && prev.status === 0x1302) continue;
            f1 = i; t1 = k;
        }
    }
    if (f1 < 0) throw new Error('no Shine touch for ' + L.label);
    // the level's start: back over its stages to the episode select (episode 255) or the plaza
    let f0 = f1;
    const stageOk = (f: Frame) => !isPlaza(f.area) && f.episode !== 255;
    while (f0 > 0 && stageOk(frames[f0 - 1])) f0--;
    if (secretOnly) { f0 = f1; while (f0 > 0 && frames[f0 - 1].area === L.secret) f0--; }
    else if (L.startArea !== undefined) { while (frames[f0].area !== L.startArea) f0++; }
    // the first frame with Mario updates
    while (!frames[f0].ticks.some((t) => t.hasMario)) f0++;
    return { f0, f1, t1 };
}

// ---------------------------------------------------------------- .smsghost
function crc32(b: Uint8Array, z0: number, z1: number) {
    const T = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = T[(c ^ (i >= z0 && i < z1 ? 0 : b[i])) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
/** the run QF of each frame from the cut's start: the director's tick count within a stage, four QF per game frame (two fields) elsewhere */
function runQf(c: Cut): Map<number, number> {
    const q = new Map<number, number>(); let qf = 0;
    for (let i = c.f0; i <= c.f1; i++) {
        const f = frames[i], pf = i > c.f0 ? frames[i - 1] : null;
        if (pf) { const d = f.dticks - pf.dticks; qf += f.dticks && pf.dticks && d > 0 && d <= 16 ? d : Math.max(1, Math.round((f.rc - pf.rc) / 2)) * 4; }
        q.set(i, qf);
    }
    return q;
}
const PARENT = [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 6, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 5, 6, 0xFF, 9, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 3, 9, 4, 4, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 6, 5, 8, 0xFF, 9, 0xFF, 2, 2, 3, 0xFF, 5, 6, 0xFF, 0xFF, 0xFF, 2, 6, 9, 5, 3];
/** The ghost's segments and samples as Moonshine's recorder takes them (ghost.cpp recordSample / appendSegment), for mkghost.py. */
function smsghost(label: string, c: Cut) {
    const RQ = runQf(c);
    const segs: { area: number; episode: number; parent: number; flags: number; variant: number; samples: number[][] }[] = [];
    let lastQf = -1;
    for (let i = c.f0; i <= c.f1; i++) {
        const f = frames[i];
        const m = i === c.f1 ? c.t1 >= 0 && f.ticks[c.t1].mario : f.mario;
        if (!m || !f.dticks) continue;
        const qf = RQ.get(i)!;
        // the route: the scene, its parent area (LevelWarp::parentArea), the parent episode (flag 0x40003: mGameInts[3])
        const parent = f.area < PARENT.length ? PARENT[f.area] : 0xff;
        const variant = f.flags ? (u32(f.flags, 0xdc) | 0) : -1;
        let g = segs[segs.length - 1];
        if (!g || g.area !== f.area || g.episode !== f.episode) {
            g = { area: f.area, episode: f.episode, parent, flags: parent === 0xff ? 0 : 1, variant, samples: [] }; segs.push(g);
        } else if (qf - lastQf < 4 && i !== c.f1) continue;
        // the phase: frame * 4096 / mNumFrames + 0.5, at most 4095
        let phase = 0;
        if (f.frameCtrl) {
            const end = s16(f.frameCtrl, 8); let cur = f32(f.frameCtrl, 0x10);
            if (end > 0 && cur === cur) { cur = Math.min(Math.max(cur, 0), end); phase = Math.min(4095, Math.floor(Math.fround(Math.fround(cur * 4096) / end) + 0.5)); }
        }
        const ty = f.yoshi ? (f.yoshi.data[0xd0] << 24 >> 24) : -1;
        const yo = f.yoshi && f.yoshi.data[0] === 8 ? (ty >= 0 && ty <= 3 ? ty + 1 : 5) : 0;
        const fx = (o: number) => Math.trunc(Math.fround(f32(m, o) * 8));
        g.samples.push([fx(0x10), fx(0x14), fx(0x18), s16(m, 0x9a), g.samples.length ? qf - lastQf : 0, Math.min(u16(m, 0xfa), 511), phase, yo, 0, qf]);
        lastQf = qf;
    }
    return { name: label, segments: segs.filter((g) => g.samples.length) };
}

// ---------------------------------------------------------------- .msgt (MSTR v2)
class Mstr {
    chunks: Uint8Array[] = []; cur: number[] = []; recs: Uint8Array[] = []; size = 0; first = -1; last = -1; seq = 0;
    out: Uint8Array[] = [];
    constructor(public run: number, public scene: number, public caps: number) {
        const h = new DataView(new ArrayBuffer(64));
        const w = [0x4d535452, 2, 64, 0x474d534a, 0x54415331, run, scene, caps, 0x80000];
        w.forEach((v, i) => h.setUint32(i * 4, v >>> 0));
        h.setUint32(60, fnv1a(new Uint8Array(h.buffer, 0, 60)));
        this.out.push(new Uint8Array(h.buffer));
    }
    rec(kind: number, frame: number, tick: number, body: Uint8Array) {
        if (this.size + 12 + body.length > 0x80000) this.flush();
        const r = new Uint8Array(12 + body.length), v = new DataView(r.buffer);
        v.setUint16(0, kind); v.setUint16(2, body.length); v.setUint32(4, frame); v.setUint32(8, tick); r.set(body, 12);
        this.recs.push(r); this.size += r.length;
        if (this.first < 0) this.first = frame;
        this.last = frame;
    }
    flush() {
        if (!this.recs.length) return;
        const data = new Uint8Array(this.size); let o = 0; for (const r of this.recs) { data.set(r, o); o += r.length; }
        const h = new DataView(new ArrayBuffer(32));
        [this.run, ++this.seq, data.length, fnv1a(data), this.first, this.last, 0, 0].forEach((v, i) => h.setUint32(i * 4, v >>> 0));
        this.out.push(new Uint8Array(h.buffer), data);
        this.recs = []; this.size = 0; this.first = -1;
    }
    /** a native object's bytes as literal blocks of at most 512 bytes, only the windows that changed */
    prev = new Map<number, { addr: number; data: Uint8Array }>();
    blob(kind: number, frame: number, tick: number, addr: number, data: Uint8Array) {
        const pv = this.prev.get(kind), fresh = !pv || pv.addr !== addr || pv.data.length !== data.length;
        for (let off = 0; off < data.length; off += 512) {
            const n = Math.min(512, data.length - off);
            if (!fresh) { let same = true; for (let i = 0; i < n && same; i++) same = pv!.data[off + i] === data[off + i]; if (same) continue; }
            const b = new Uint8Array(16 + n), v = new DataView(b.buffer);
            v.setUint32(0, addr); v.setUint32(4, off); v.setUint32(8, data.length); v.setUint32(12, n); b.set(data.subarray(off, off + n), 16);
            this.rec(kind, frame, tick, b);
        }
        this.prev.set(kind, { addr, data: data.slice() });
    }
    finish(): Uint8Array {
        this.flush();
        const before = this.out.reduce((a, b) => a + b.length, 0);
        const d = new DataView(new ArrayBuffer(32));
        [0x444f4e45, this.run, this.seq, before, this.caps].forEach((v, i) => d.setUint32(i * 4, v >>> 0));
        this.out.push(new Uint8Array(d.buffer));
        const all = new Uint8Array(before + 32); let o = 0; for (const c of this.out) { all.set(c, o); o += c.length; }
        return all;
    }
}
function msgt(c: Cut, run: number): Uint8Array {
    const f0 = frames[c.f0];
    // session, frame, Mario, camera, FLUDD, Yoshi, actors, controller
    const caps = 2 | 4 | 8 | 32 | 64 | 128 | 1024;
    const M = new Mstr(run, f0.area << 8 | f0.episode, caps);
    const id = new DataView(new ArrayBuffer(16));
    id.setUint32(0, 0x474d534a); id.setUint32(4, 0x30310000); id.setUint32(8, 0); id.setUint32(12, 0);
    M.rec(17, 0, 0, new Uint8Array(id.buffer));
    const pv = new DataView(new ArrayBuffer(8)); pv.setUint32(0, 1); pv.setUint32(4, 0x21);
    M.rec(28, 0, 0, new Uint8Array(pv.buffer));
    let tick = 0, frameNo = 0;
    const actorIds = new Map<number, number>(); let nextId = 1;
    const actorPrev = new Map<number, Uint32Array>();
    let prevFrame: Frame | null = null, lastMt = -1;
    for (let i = c.f0; i <= c.f1; i++, frameNo++) {
        const f = frames[i];
        // the frame record as the frame begins: what the last frame left (the first: this frame's own)
        const s = prevFrame && prevFrame.area === f.area && prevFrame.episode === f.episode ? prevFrame : f;
        // a stretch without the director (a load) is written as one frame record a game frame, so the viewer's clock keeps up
        if (prevFrame && (!f.dticks || !prevFrame.dticks)) for (let k = 1; k < Math.round((f.rc - prevFrame.rc) / 2); k++, frameNo++) {
            const e = new DataView(new ArrayBuffer(32));
            [f.area << 8 | f.episode, 0, prevFrame.rc + 2 * k, f.ms, prevFrame.seed, tick, 0xffffffff, 0].forEach((v, n) => e.setUint32(n * 4, v >>> 0));
            M.rec(2, frameNo, tick, new Uint8Array(e.buffer));
        }
        const fb = new DataView(new ArrayBuffer(32));
        [f.area << 8 | f.episode, 0, f.rc, f.ms, s.seed, tick, s.dirState === 0xffffffff ? 0xffffffff : s.dirState >>> 16, 0].forEach((v, k) => fb.setUint32(k * 4, v >>> 0));
        M.rec(2, frameNo, tick, new Uint8Array(fb.buffer));
        if (s !== f || i === c.f0) {
            if (s.fludd) M.blob(8, frameNo, tick, s.fludd.addr, s.fludd.data);
            if (s.yoshi) M.blob(9, frameNo, tick, s.yoshi.addr, s.yoshi.data);
            // the actors as the frame begins (Moonshine's roster(), each object's first 0x150 bytes, changed words)
            const live = new Set<number>();
            for (const a of s.actors) {
                let aid = actorIds.get(a.addr); const created = aid === undefined;
                if (created) { aid = nextId++; actorIds.set(a.addr, aid); }
                live.add(a.addr);
                const w = new Uint32Array(0x54); for (let k = 0; k < 0x54; k++) w[k] = u32(a.data, k * 4);
                const pw = actorPrev.get(aid!); const m = [0, 0, 0]; const vals: number[] = [];
                for (let k = 0; k < 0x54; k++) if (created || !pw || pw[k] !== w[k]) { m[k >> 5] |= 1 << (k & 31); vals.push(w[k]); }
                actorPrev.set(aid!, w);
                if (!vals.length) continue;
                const b = new DataView(new ArrayBuffer(28 + 4 * vals.length));
                [aid!, a.addr, 0x150, created ? 1 : 0, m[0], m[1], m[2]].forEach((v, k) => b.setUint32(k * 4, v >>> 0));
                vals.forEach((v, k) => b.setUint32(28 + 4 * k, v));
                M.rec(6, frameNo, tick, new Uint8Array(b.buffer));
            }
            for (const [addr, aid] of [...actorIds]) if (!live.has(addr)) {
                const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, aid); M.rec(7, frameNo, tick, new Uint8Array(b.buffer));
                actorIds.delete(addr); actorPrev.delete(aid);
            }
        }
        const nt = i === c.f1 ? c.t1 + 1 : f.ticks.length;
        for (let k = 0; k < nt; k++) {
            const t = f.ticks[k];
            tick += lastMt >= 0 && t.mt > lastMt && t.mt - lastMt <= 8 ? t.mt - lastMt : 1;
            lastMt = t.mt;
            if (!t.mario) continue;
            // the controller observation: cue 1, pad 0, the frame's PADStatus, valid
            const inp = new Uint8Array(300), iv = new DataView(inp.buffer);
            iv.setUint32(0, 1); iv.setUint32(4, 0); inp.set(f.pad.subarray(0, 12), 8); iv.setUint32(20, 1);
            M.rec(14, frameNo, tick, inp);
            M.blob(3, frameNo, tick, t.marioAddr, t.mario);
            if (t.camera) M.blob(4, frameNo, tick, t.cameraAddr, t.camera);
        }
        prevFrame = f;
    }
    return M.finish();
}

// ---------------------------------------------------------------- write
mkdirSync(outDir + '/ghosts', { recursive: true }); mkdirSync(outDir + '/traces', { recursive: true });
const jobs: { name: string; c: Cut; run: number }[] = [];
let run = 1;
for (const L of LEVELS) {
    jobs.push({ name: FULL.has(L.label) ? `${L.label} (Full)` : L.label, c: cutFor(L, false), run: run++ });
    if (L.secret !== undefined) jobs.push({ name: `${L.label} (Secret)`, c: cutFor(L, true), run: run++ });
}
let low = 0;
const need = (i: number) => jobs.some((j) => j.c.f0 <= i && i <= j.c.f1);
parse(need, (f) => {
    if (!need(f.i)) return;
    frames[f.i] = f;
    for (const j of jobs) if (j.c.f1 === f.i) {
        const c = j.c, name = j.name;
        const g = smsghost(name, c), t = msgt(c, j.run);
        writeFileSync(`${outDir}/ghosts/${name}.json`, JSON.stringify(g));
        writeFileSync(`${outDir}/traces/${name}.msgt`, t);
        const qf = runQf(c).get(c.f1);
        console.log(`${name}: frames ${c.f0}..${c.f1} (areas ${[...new Set(frames.slice(c.f0, c.f1 + 1).map((f) => f.area.toString(16)))].join(',')}), ${qf} QF, samples ${g.segments.reduce((a, x) => a + x.samples.length, 0)}, trace ${t.length} B`);
    }
    // drop what no later job needs
    const keep = Math.min(...jobs.filter((j) => j.c.f1 > f.i).map((j) => j.c.f0), f.i + 1);
    for (; low < keep; low++) delete frames[low];
});
