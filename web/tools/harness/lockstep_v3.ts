// The lockstep comparer's v3 side (a worker thread): plays the trace in the game's own code and, at every movement
// tick, sends the raw bytes of the objects the comparer reads: Mario, the camera, rand's state and every actor of
// the conductor (v3 game/replay.ts roster, the recorder's order), each with its class (vtable symbol) and name.
// Messages go through a ring in shared memory (lockstep_lib.ts reads them) as length-prefixed JSON.
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync, existsSync } from 'node:fs';
import { readTrace } from '../../v3/game/trace.ts';
import { Replay } from '../../v3/game/replay.ts';
import { versionOf } from '../../v3/game/versions.ts';
import { symbols } from '../../v3/tests/syms.ts';
import { discOf, loadBytes } from '../../v3/tests/jpdisc.ts';
import { layoutOf, SIZE } from './layouts.ts';

const { file, sab, size } = workerData as { file: string; sab: SharedArrayBuffer; size: number };
const ctl = new Int32Array(sab, 0, 4), ring = new Uint8Array(sab, 16, size);
const enc = new TextEncoder();
function send(o: unknown) {
    const b = enc.encode(JSON.stringify(o)), n = b.length + 4;
    if (n > size / 2) throw new Error('message too big');
    // wait for room: write - read <= size - n
    for (;;) { const w = Atomics.load(ctl, 0), r = Atomics.load(ctl, 1); if (w - r + n <= size) break; Atomics.wait(ctl, 1, r, 1000); }
    let w = Atomics.load(ctl, 0);
    const put = (byte: number) => { ring[w % size] = byte; w++; };
    put(b.length & 0xFF); put((b.length >>> 8) & 0xFF); put((b.length >>> 16) & 0xFF); put(b.length >>> 24);
    for (let i = 0; i < b.length; i++) put(b[i]);
    Atomics.store(ctl, 0, w); Atomics.notify(ctl, 0);
}

const b = readFileSync(file);
const T = readTrace(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
const V = versionOf(T.gameId, T.discRevision)!;
const symFile = `${process.env.DECOMP || '/home/claude/sms-ai-decomp/config'}/${V.decomp}/symbols.txt`;
const S = symbols(symFile), D = discOf(V.key);
const vts = new Map<number, string>();
for (const l of readFileSync(symFile, 'utf8').split('\n')) { const m = /^__vt__(\S+) = \.\w+:0x([0-9A-F]+);/.exec(l); if (m) vts.set(parseInt(m[2], 16), m[1]); }
// a vtable symbol's class: __vt__6TMario -> TMario, __vt__Q26JDrama6TActor -> TActor
const className = (sym: string) => { const q = /^Q(\d)(.*)$/.exec(sym); let s = q ? q[2] : sym; let last = ''; while (s.length) { const m = /^(\d+)/.exec(s); if (!m) break; const n = +m[1]; last = s.substr(m[1].length, n); s = s.slice(m[1].length + n); if (!q) break; } return last || sym; };
// (the stage heap must be the recording console's: when the disc's file table here sizes it otherwise, v3 says by
// how much, and the trace is played again with that much more padding before any tick has been sent)
// LS_OPTS=<file>: the setup v3's replay test settled on for this trace (tests/replay.ts OPTS_OUT: the file table's
// padding, Shiny Shines, locked scripts, Dolphin's arithmetic, the NPC phase, the select screen's hold)
const OPTS = process.env.LS_OPTS && existsSync(process.env.LS_OPTS) ? JSON.parse(readFileSync(process.env.LS_OPTS, 'utf8')) : null;
const makeReplay = (pad: number) => new Replay(loadBytes(D.dol), D.disc(), T, V.addrs, (n) => S.byName.get(n), {
    log: () => {}, fstPad: pad, maxIssues: 50, recorded: V.addrs,
    ...(OPTS ? { shinyShines: OPTS.shinyShines, scriptsLocked: OPTS.scriptsLocked, dolphin: OPTS.dolphin, npcPhase: OPTS.npcPhase, selectHold: OPTS.selectHold } : {}),
});
let pad = OPTS ? OPTS.fstPad : +(process.env.FSTPAD ?? 480);
for (let tries = 0; tries < 3; tries++) {
    const probe = makeReplay(pad);
    while (probe.ticks === 0 && !probe.heapDelta && probe.run(50e6) !== 'done');
    if (probe.ticks > 0 || !probe.heapDelta) break;
    pad += probe.heapDelta;
}
// LS_UNSET (on unless 0): the stage's load runs in the interpreter with a shadow of RAM (as tests/uninit.ts): a heap
// block's bytes are unset from its allocation until the game writes them. An object's bytes still unset at its first
// tick hold what the session left there (garbage the recording doesn't give); each tick says which of them the game
// still hasn't changed, and the comparer leaves those fields out until it does.
const UNSET = process.env.LS_UNSET !== '0';
let shadow: Uint8Array | null = UNSET ? new Uint8Array(0x01800000) : null;
const R = new Replay(loadBytes(D.dol), D.disc(), T, V.addrs, (n) => S.byName.get(n), {
    log: () => {}, fstPad: pad, maxIssues: 50, recorded: V.addrs,
    ...(OPTS ? { shinyShines: OPTS.shinyShines, scriptsLocked: OPTS.scriptsLocked, dolphin: OPTS.dolphin, npcPhase: OPTS.npcPhase, selectHold: OPTS.selectHold } : {}),
    onAlloc: (p: number, n: number) => { if (shadow) { const o = p & 0x01FFFFFF; shadow.fill(1, o, Math.min(shadow.length, o + n)); } },
});
const mem = R.m.mem as any, sjis = new TextDecoder('shift_jis');
const nameOf = (p: number) => { const s = mem.r32(p + 4); if (s < 0x80003000 || s >= 0x81800000) return ''; const o: number[] = []; for (let i = 0; i < 64; i++) { const c = mem.r8(s + i); if (!c) break; o.push(c); } return sjis.decode(Uint8Array.from(o)); };
const lenOf = new Map<string, number>();
const extent = (cls: string) => { let n = lenOf.get(cls); if (n === undefined) { n = 0; for (const f of layoutOf(cls)) n = Math.max(n, f.off + SIZE[f.type]); n = Math.min(n, 0x4000); lenOf.set(cls, n); } return n; };
const obj = (p: number, role: string) => {
    if (p < 0x80003000 || p >= 0x81800000) return null;
    const cls = className(vts.get(mem.r32(p)) ?? '?'), n = extent(cls);
    const bytes = Buffer.alloc(n); for (let i = 0; i < n; i++) bytes[i] = mem.r8(p + i);
    let u: string | undefined;
    if (UNSET) {
        let e = unset0.get(p);
        if (!e && shadow) { const mask = new Uint8Array(n); const o = (p ^ 0x80000000) >>> 0; for (let i = 0; i < n; i++) mask[i] = shadow[o + i]; e = { mask, first: Uint8Array.from(bytes) }; unset0.set(p, e); }
        if (e) {
            const bits = Buffer.alloc((n + 7) >> 3); let any = false;
            for (let i = 0; i < n && i < e.mask.length; i++) { if (e.mask[i] && bytes[i] !== e.first[i]) e.mask[i] = 0; if (e.mask[i]) { bits[i >> 3] |= 1 << (i & 7); any = true; } }
            if (any) u = bits.toString('base64');
        }
    }
    return { role, addr: p, cls, name: nameOf(p), b: bytes.toString('base64'), ...(u ? { u } : {}) };
};
const RAND_NEXT = +(process.env.RAND_NEXT || 0x80408CF0);
let stopAt = +(process.env.LS_TO || 1e9);
// LS_WATCH=<tick>:<key>:<hex offset>:<hex length>: every write the game makes to those bytes of that object between
// the entries of ticks <tick>-1 and <tick> (the comparer's two reads), with the instruction and its function. The
// key is the comparer's: mario, camera or <name>#<n>. (Run without the JIT in that tick: its stores aren't hooked.)
const WATCH = process.env.LS_WATCH ? process.env.LS_WATCH.split(':') : null;
let watching: { lo: number; hi: number } | null = null;
const cpu = R.m.cpu as any, w8 = mem.w8.bind(mem), w16 = mem.w16.bind(mem), w32 = mem.w32.bind(mem);
const who = (a: number) => { const w = S.who(a); return w ? w : '?'; };
if (shadow) {
    cpu.jit = false;
    const sh = shadow, set = (a: number, n: number) => { const o = (a ^ 0x80000000) >>> 0; if (o < sh.length) sh.fill(0, o, Math.min(sh.length, o + n)); };
    mem.w8 = (a: number, v: number) => { set(a, 1); w8(a, v); };
    mem.w16 = (a: number, v: number) => { set(a, 2); w16(a, v); };
    mem.w32 = (a: number, v: number) => { set(a, 4); w32(a, v); };
    // (what the hardware writes into RAM is set: the disc, ARAM, frame-buffer copies)
    const clear = (o: number, n: number) => { o &= 0x01FFFFFF; sh.fill(0, o, Math.min(sh.length, o + n)); };
    const hw = R.m.hw as any, disc = hw.disc, discRead = disc.read.bind(disc);
    disc.read = (off: number, len: number, ram: Uint8Array, at: number) => { clear(at, len); return discRead(off, len, ram, at); };
    const aramDma = hw.aramDma.bind(hw);
    hw.aramDma = () => { const mm = (((hw.r16(0x5020) & 0x3FF) << 16) | hw.r16(0x5022)) & 0x03FFFFE0, hi = hw.r16(0x5028), len = (((hi & 0x3FF) << 16) | hw.r16(0x502A)) & 0x03FFFFE0; if (hi & 0x8000) clear(mm, len); aramDma(); };
    const gx = hw.gx as any, gxCopy = gx.copy.bind(gx);
    gx.copy = (ctl: number) => { const bp = gx.bp, w = (bp[0x4A] & 0x3FF) + 1, h = ((bp[0x4A] >>> 10) & 0x3FF) + 1; clear((bp[0x4B] << 5) >>> 0, w * h * 4); gxCopy(ctl); };
}
// per object: its bytes unset at its first tick and their values then (a byte that changes has been written)
const unset0 = new Map<number, { mask: Uint8Array; first: Uint8Array }>();
const hit = (a: number, n: number, v: number) => {
    if (!watching || a + n <= watching.lo || a >= watching.hi) return;
    writes++;
    say(`LS-WRITE tick ${curTick} +0x${(a - watching.lo + +('0x' + WATCH![2])).toString(16)} (${n} byte(s)) = 0x${(v >>> 0).toString(16)} by ${cpu.pc.toString(16)} ${who(cpu.pc)} (lr ${(cpu.lr >>> 0).toString(16)} ${who(cpu.lr)})`);
};
let curTick = 0, writes = 0;
// LS_WATCHVAL=<hex word>: every 4-byte store of that value before the first tick (the stage's load), counted by the
// storing function (run without the JIT until then): who set a field the comparer finds different from the start
const WATCHVAL = process.env.LS_WATCHVAL ? parseInt(process.env.LS_WATCHVAL, 16) >>> 0 : null;
const valHits = new Map<string, number>(), valAddr = new Map<number, string>();
if (WATCHVAL !== null) {
    cpu.jit = false;
    // (the address of each such store, its function and caller: matched with the objects' fields at the first tick)
    mem.w32 = (a: number, v: number) => {
        if ((v >>> 0) === WATCHVAL) {
            // the call chain: the back chain of stack frames from r1, each frame's saved lr at +4
            const chain: string[] = [who(cpu.pc), who(cpu.lr)];
            let sp = cpu.gpr[1] >>> 0;
            for (let i = 0; i < 8; i++) { const nx = mem.r32(sp) >>> 0; if (nx < 0x80000000 || nx >= 0x81800000 || nx <= sp) break; chain.push(who(mem.r32(nx + 4) >>> 0)); sp = nx; }
            valAddr.set(a >>> 0, chain.join(' < '));
        }
        w32(a, v);
    };
}
// (lines for the comparer to print: a worker's own output is lost when it is stopped)
const say = (text: string) => send({ log: text });
const keyOf = (p: number, role: string, count: Map<string, number>) => { if (role !== 'actor') return role; const n = nameOf(p), k = count.get(n) || 0; count.set(n, k + 1); return `${n}#${k}`; };
// LS_CALLS=<hex addr>,...: each call of those functions up to LS_CALLS_TO (default tick 12), with r3 and r4 (the
// receiver and, for a perform, the cue) and the caller: the order the game runs things in
const seenMtx = new Set<number>();
if (process.env.LS_CALLS) {
    const upto = +(process.env.LS_CALLS_TO || 12);
    for (const a of process.env.LS_CALLS.split(',')) {
        const addr = parseInt(a, 16) >>> 0;
        cpu.hook(addr, (c: any) => { if (curTick <= upto && process.env.LS_CALLS_MTX && !seenMtx.has(curTick)) { seenMtx.add(curTick); const g = (c.gpr[3] >>> 0) + +process.env.LS_CALLS_MTX; const f: string[] = []; for (let i = 0; i < 12; i++) { const v = mem.r32(g + i * 4) >>> 0; f.push(new Float32Array(new Uint32Array([v]).buffer)[0].toPrecision(9)); } say(`LS-MTX ${curTick} ${f.join(' ')}`); }
            if (curTick <= upto) say(`LS-CALL ${curTick} ${who(addr)} r3 ${(c.gpr[3] >>> 0).toString(16)} ${nameOf(c.gpr[3] >>> 0)} r4 0x${(c.gpr[4] >>> 0).toString(16)} from ${who(c.lr >>> 0)}`); return false; });
    }
}
let shadowOn = !!shadow;
R.onTick = (tick) => {
    curTick = tick;
    if (shadowOn) {
        // (the objects of this first tick take their unset bytes now; then the shadow stops and the JIT runs)
        obj(mem.r32(V.addrs.gpMarioOriginal), 'mario'); obj(mem.r32(V.addrs.gpCamera), 'camera'); for (const p of R.roster()) obj(p, 'actor');
        shadowOn = false; shadow = null; mem.w8 = w8; mem.w16 = w16; mem.w32 = w32; if (!WATCHVAL && !WATCH) cpu.jit = true;
    }
    if (WATCHVAL !== null && valHits.size >= 0 && cpu.jit === false && !WATCH) {
        const count = new Map<string, number>(), off = +('0x' + (process.env.LS_WATCHOFF || '0'));
        for (const p of R.roster()) { const k = keyOf(p, 'actor', count), w = valAddr.get(p + off); if (w && mem.r32(p + off) === WATCHVAL) valHits.set(w, (valHits.get(w) || 0) + 1), say(`LS-VAL ${k} +0x${off.toString(16)} last stored by ${w}`); }
        valHits.clear(); mem.w32 = w32; cpu.jit = true;
    }
    if (WATCH) {
        const wt = +WATCH[0];
        if (tick === wt - 1) {
            const cands: [number, string][] = [[mem.r32(V.addrs.gpMarioOriginal), 'mario'], [mem.r32(V.addrs.gpCamera), 'camera'], ...R.roster().map((p) => [p, 'actor'] as [number, string])];
            const count = new Map<string, number>();
            for (const [p, role] of cands) if (keyOf(p, role, count) === WATCH[1]) { const lo = p + parseInt(WATCH[2], 16); watching = { lo, hi: lo + parseInt(WATCH[3], 16) }; }
            if (watching) {
                cpu.jit = false;
                mem.w8 = (a: number, v: number) => { hit(a >>> 0, 1, v); w8(a, v); };
                mem.w16 = (a: number, v: number) => { hit(a >>> 0, 2, v); w16(a, v); };
                mem.w32 = (a: number, v: number) => { hit(a >>> 0, 4, v); w32(a, v); };
                say(`LS-WATCH ${WATCH[1]} +0x${WATCH[2]} at 0x${watching.lo.toString(16)} from tick ${tick}`);
            } else say(`LS-WATCH no object ${WATCH[1]} at tick ${tick}`);
        } else if (tick === wt && watching) { say(`LS-WATCH end at tick ${tick}: ${writes} write(s)`); watching = null; cpu.jit = true; mem.w8 = w8; mem.w16 = w16; mem.w32 = w32; }
    }
    if (tick > stopAt) return;
    const objs: unknown[] = [];
    const ma = obj(mem.r32(V.addrs.gpMarioOriginal), 'mario'); if (ma) objs.push(ma);
    const ca = obj(mem.r32(V.addrs.gpCamera), 'camera'); if (ca) objs.push(ca);
    for (const p of R.roster()) { const o = obj(p, 'actor'); if (o) objs.push(o); }
    send({ t: tick, rand: mem.r32(RAND_NEXT) >>> 0, objs });
};
let res: string;
while ((res = R.run(200e6)) !== 'done' && R.ticks <= stopAt + 8);
// the functions the game ran (every block start the JIT's map has seen, interpreted or compiled), by symbol: the
// coverage ledger's input (tools/harness/ledger.py)
const covered: string[] = [];
{
    const bmap: Int32Array = cpu.bmap, list: [number, number, string][] = [];
    for (const l of readFileSync(symFile, 'utf8').split('\n')) { const m = /^(\S+) = \.text:0x([0-9A-F]+); \/\/ type:function size:0x([0-9A-F]+)/.exec(l); if (m) list.push([parseInt(m[2], 16), parseInt(m[3], 16), m[1]]); }
    for (const [a, n, name] of list) { const o = (a ^ 0x80000000) >>> 2; let hit = false; for (let i = 0; i < n >>> 2 && !hit; i++) if (bmap[o + i] !== 0) hit = true; if (hit) covered.push(name); }
}
send({ end: true, ticks: R.ticks, issues: R.issues.slice(0, 3).map((i) => i.text), covered });
parentPort?.postMessage('done');
