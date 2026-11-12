// The lockstep comparer's v3 side (a worker thread): plays the trace in the game's own code and, at every movement
// tick, sends the raw bytes of the objects the comparer reads: Mario, the camera, rand's state and every actor of
// the conductor (v3 game/replay.ts roster, the recorder's order), each with its class (vtable symbol) and name.
// Messages go through a ring in shared memory (lockstep_lib.ts reads them) as length-prefixed JSON.
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
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
const makeReplay = (pad: number) => new Replay(loadBytes(D.dol), D.disc(), T, V.addrs, (n) => S.byName.get(n), { log: () => {}, fstPad: pad, maxIssues: 50 });
let pad = +(process.env.FSTPAD ?? 480);
for (let tries = 0; tries < 3; tries++) {
    const probe = makeReplay(pad);
    while (probe.ticks === 0 && !probe.heapDelta && probe.run(50e6) !== 'done');
    if (probe.ticks > 0 || !probe.heapDelta) break;
    pad += probe.heapDelta;
}
const R = makeReplay(pad);
const mem = R.m.mem, sjis = new TextDecoder('shift_jis');
const nameOf = (p: number) => { const s = mem.r32(p + 4); if (s < 0x80003000 || s >= 0x81800000) return ''; const o: number[] = []; for (let i = 0; i < 64; i++) { const c = mem.r8(s + i); if (!c) break; o.push(c); } return sjis.decode(Uint8Array.from(o)); };
const lenOf = new Map<string, number>();
const extent = (cls: string) => { let n = lenOf.get(cls); if (n === undefined) { n = 0; for (const f of layoutOf(cls)) n = Math.max(n, f.off + SIZE[f.type]); n = Math.min(n, 0x4000); lenOf.set(cls, n); } return n; };
const obj = (p: number, role: string) => {
    if (p < 0x80003000 || p >= 0x81800000) return null;
    const cls = className(vts.get(mem.r32(p)) ?? '?'), n = extent(cls);
    const bytes = Buffer.alloc(n); for (let i = 0; i < n; i++) bytes[i] = mem.r8(p + i);
    return { role, addr: p, cls, name: nameOf(p), b: bytes.toString('base64') };
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
const hit = (a: number, n: number, v: number) => {
    if (!watching || a + n <= watching.lo || a >= watching.hi) return;
    writes++;
    say(`LS-WRITE tick ${curTick} +0x${(a - watching.lo + +('0x' + WATCH![2])).toString(16)} (${n} byte(s)) = 0x${(v >>> 0).toString(16)} by ${cpu.pc.toString(16)} ${who(cpu.pc)} (lr ${(cpu.lr >>> 0).toString(16)} ${who(cpu.lr)})`);
};
let curTick = 0, writes = 0;
// (lines for the comparer to print: a worker's own output is lost when it is stopped)
const say = (text: string) => send({ log: text });
const keyOf = (p: number, role: string, count: Map<string, number>) => { if (role !== 'actor') return role; const n = nameOf(p), k = count.get(n) || 0; count.set(n, k + 1); return `${n}#${k}`; };
R.onTick = (tick) => {
    curTick = tick;
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
