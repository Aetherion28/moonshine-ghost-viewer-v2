// v3 diagnostic: where the game uses memory it never wrote. Plays a trace with the interpreter only, with a
// shadow of RAM: a heap block's bytes are "unset" from its allocation until the game writes them (STACK=1:
// a new stack frame's bytes too). Copies carry the mark along (registers, memory); the first instruction
// that does more than copy an unset value (compares it, computes with it, uses it as an address) is listed,
// with the block it came from. On the console such bytes hold what the session left there; here mostly zeros.
// Run: node uninit.mjs <trace.msgt> [millions of instructions]   (env: FSTPAD, LOCKED, FROM=frame TO=frame to list only uses in those frames,
// STACK=1, MAX=lines, SHINY=1)
import { readFileSync } from 'node:fs';
import { readTrace } from '../game/trace.ts';
import { Replay, JP10 } from '../game/replay.ts';
import { symbols } from './syms.ts';
import { jpDisc, JP_DOL, loadBytes } from './jpdisc.ts';
import { MEM1_SIZE } from '../ppc/mem.ts';

const S = symbols();
const vts = new Map<number, string>();
for (const l of readFileSync('/home/claude/sms-ai-decomp/config/GMSJ01/symbols.txt', 'utf8').split('\n')) { const m = /^(__vt__\S+) = \.\w+:0x([0-9A-F]+);/.exec(l); if (m) vts.set(parseInt(m[2], 16), m[1]); }
const b = readFileSync(process.argv[2]);
const T = readTrace(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
const who = (text: string) => text.replace(/\b(80[0-9a-f]{6})\b/g, (m) => { const w = S.who(parseInt(m, 16)); return w === '?' ? m : `${m} ${w}`; });
const R = new Replay(loadBytes(JP_DOL), jpDisc(), T, JP10, (n) => S.byName.get(n), {
    log: (s) => { if (!/uninitialised/.test(s)) console.log(who(s)); }, stopOn: ['heap', 'layout'], maxIssues: 200, fstPad: +(process.env.FSTPAD || 480), shinyShines: !!process.env.SHINY,
    scriptsLocked: (process.env.LOCKED || '').split(',').filter(Boolean),
});
const cpu = R.m.cpu as any, mem = R.m.mem as any, g: Uint32Array = cpu.gpr;
cpu.jit = false;
const FROM = +(process.env.FROM || 0), TO = +(process.env.TO || 1e9), STACK = !!process.env.STACK;

// ---------------------------------------------------------------- the shadow
const shadow = new Uint8Array(MEM1_SIZE);   // 1: unset
const came = new Int32Array(MEM1_SIZE);   // an unset byte that was copied: where the value came from (offset + 1; 0: itself)
const allocOf = new Int32Array(MEM1_SIZE >> 2);   // the allocation (index + 1) a word belongs to
interface Alloc { ptr: number; size: number; by: number[]; frame: number }
const allocs: Alloc[] = [];
const from = (o: number) => came[o] ? came[o] - 1 : o;
let readT = -1, writeT = -1, inExec = false;
const r8 = mem.r8.bind(mem), r16 = mem.r16.bind(mem), r32 = mem.r32.bind(mem), w8 = mem.w8.bind(mem), w16 = mem.w16.bind(mem), w32 = mem.w32.bind(mem);
mem.r8 = (a: number) => { const o = (a ^ 0x80000000) >>> 0; if (inExec && o < MEM1_SIZE && shadow[o] && readT < 0) readT = from(o); return r8(a); };
mem.r16 = (a: number) => { const o = (a ^ 0x80000000) >>> 0; if (inExec && o < MEM1_SIZE - 1 && (shadow[o] | shadow[o + 1]) && readT < 0) readT = from(shadow[o] ? o : o + 1); return r16(a); };
mem.r32 = (a: number) => { const o = (a ^ 0x80000000) >>> 0; if (inExec && o < MEM1_SIZE - 3 && (shadow[o] | shadow[o + 1] | shadow[o + 2] | shadow[o + 3]) && readT < 0) { let k = o; while (!shadow[k]) k++; readT = from(k); } return r32(a); };
const wrote = (o: number, n: number) => {
    for (let k = o; k < o + n; k++) {
        if (writeT >= 0) { shadow[k] = 1; came[k] = writeT + 1; } else if (shadow[k]) { shadow[k] = 0; came[k] = 0; }
    }
};
mem.w8 = (a: number, v: number) => { const o = (a ^ 0x80000000) >>> 0; if (o < MEM1_SIZE) wrote(o, 1); w8(a, v); };
mem.w16 = (a: number, v: number) => { const o = (a ^ 0x80000000) >>> 0; if (o < MEM1_SIZE - 1) wrote(o, 2); w16(a, v); };
mem.w32 = (a: number, v: number) => { const o = (a ^ 0x80000000) >>> 0; if (o < MEM1_SIZE - 3) wrote(o, 4); w32(a, v); };
// what the hardware model writes into RAM (the disc, ARAM, a frame-buffer copy) is set
const clear = (o: number, n: number) => { o &= 0x01FFFFFF; shadow.fill(0, o, Math.min(MEM1_SIZE, o + n)); came.fill(0, o, Math.min(MEM1_SIZE, o + n)); };
const hw = R.m.hw as any;
const disc = hw.disc, discRead = disc.read.bind(disc);
disc.read = (off: number, len: number, ram: Uint8Array, at: number) => { clear(at, len); return discRead(off, len, ram, at); };
const aramDma = hw.aramDma.bind(hw);
hw.aramDma = () => { const mm = (((hw.r16(0x5020) & 0x3FF) << 16) | hw.r16(0x5022)) & 0x03FFFFE0, hi = hw.r16(0x5028), len = (((hi & 0x3FF) << 16) | hw.r16(0x502A)) & 0x03FFFFE0; if (hi & 0x8000) clear(mm, len); aramDma(); };
const gx = hw.gx as any, gxCopy = gx.copy.bind(gx);
gx.copy = (ctl: number) => { const bp = gx.bp, w = (bp[0x4A] & 0x3FF) + 1, h = ((bp[0x4A] >>> 10) & 0x3FF) + 1; clear((bp[0x4B] << 5) >>> 0, w * h * 4); gxCopy(ctl); };
const bytes = mem.bytes.bind(mem);
// (host-side views: the replay's own comparisons read through them, so they don't count as writes)

// ---------------------------------------------------------------- allocations
const HEAP_LO = 0x8000A04C, HEAP_HI = 0x8000DE30;   // the JKR heaps and operator new
const inHeapCode = (a: number) => a >= HEAP_LO && a < HEAP_HI;
const pend: { size: number; by: number[] }[] = [];
const callers = () => {
    const by: number[] = [cpu.lr >>> 0]; let sp = g[1];
    for (let k = 0; k < 6 && sp > 0x80000000 && sp < 0x81800000; k++) { const up = r32(sp); if (up <= sp || up >= 0x81800000) break; by.push(r32(up + 4)); sp = up; }
    return by.filter((a) => !inHeapCode(a)).slice(0, 3);
};
const allocEntry = (c: any) => { pend.push({ size: c.gpr[4], by: callers() }); return false; };
const allocExit = (c: any) => {
    const p = pend.pop(), ptr = c.gpr[3];
    if (p && ptr) {
        const o = ptr & 0x01FFFFFF;
        shadow.fill(1, o, o + p.size); came.fill(0, o, o + p.size);
        allocs.push({ ptr, size: p.size, by: p.by, frame: R.frames });
        allocOf.fill(allocs.length, o >> 2, (o + p.size + 3) >> 2);
    }
    return false;
};
cpu.hook(0x8000A04C, allocEntry); cpu.hook(0x8000A18C, allocExit);   // JKRExpHeap::alloc
cpu.hook(0x8000D520, allocEntry); cpu.hook(0x8000D5CC, allocExit);   // JKRSolidHeap::alloc

// ---------------------------------------------------------------- registers and uses
const gT = new Int32Array(32).fill(-1), fT = new Int32Array(32).fill(-1);
interface Use { pc: number; kind: string; origin: string; n: number; frame: number; tick: number; example: number }
const uses = new Map<string, Use>();
let curPc = 0;
const describe = (o: number) => {
    const a = allocOf[o >> 2];
    if (!a) return o >= 0x01600000 ? 'stack' : `memory at ${(0x80000000 + o).toString(16)}`;
    const A = allocs[a - 1], vt = r32(A.ptr), off = (0x80000000 + o - A.ptr) >>> 0;
    if (off >= A.size) return '';   // (past the block's end: a string function reading whole words)
    return `${vts.get(vt) ?? 'block'} +0x${off.toString(16)} (0x${A.size.toString(16)} bytes from ${A.by.map((x) => S.who(x)).join(' < ')})`;
};
const U = (t: number, kind: string) => {
    if (t < 0) return;
    if (R.phase !== 'stage' || R.frames < FROM || R.frames > TO) return;
    const origin = describe(t), key = `${curPc}:${kind}:${origin}`;
    if (!origin) return;
    const u = uses.get(key);
    if (u) u.n++; else uses.set(key, { pc: curPc, kind, origin, n: 1, frame: R.frames, tick: R.ticks, example: 0x80000000 + t });
};
const exec = cpu.exec.bind(cpu);
cpu.exec = (ins: number, pc: number) => {
    const op = ins >>> 26, rD = (ins >>> 21) & 31, rA = (ins >>> 16) & 31, rB = (ins >>> 11) & 31;
    curPc = pc; readT = -1; writeT = -1;
    switch (op) {
        // loads
        case 32: case 33: case 34: case 35: case 40: case 41: case 42: case 43:
            if (rA) U(gT[rA], 'address'); inExec = true; exec(ins, pc); inExec = false; gT[rD] = readT; return;
        case 48: case 49: case 50: case 51: case 56: case 57:
            if (rA) U(gT[rA], 'address'); inExec = true; exec(ins, pc); inExec = false; fT[rD] = readT; return;
        case 46: {   // lmw
            const ea = (((rA ? g[rA] : 0) + ((ins << 16) >> 16)) ^ 0x80000000) >>> 0;
            exec(ins, pc);
            for (let r = rD, o = ea; r < 32; r++, o += 4) gT[r] = o < MEM1_SIZE - 3 && (shadow[o] | shadow[o + 1] | shadow[o + 2] | shadow[o + 3]) ? from(o) : -1;
            return;
        }
        // stores
        case 36: case 37: case 38: case 39: case 44: case 45: {
            if (rA) U(gT[rA], 'address'); writeT = gT[rD];
            if (op === 37 && rA === 1 && rD === 1 && STACK) {   // stwu r1, -n(r1): a new frame
                const old = g[1]; exec(ins, pc); const sp = g[1];
                if (sp < old && old - sp < 0x10000) { const o = sp & 0x01FFFFFF; shadow.fill(1, o + 8, (old & 0x01FFFFFF)); came.fill(0, o + 8, (old & 0x01FFFFFF)); }
                return;
            }
            exec(ins, pc); return;
        }
        case 52: case 53: case 54: case 55: case 60: case 61:
            if (rA) U(gT[rA], 'address'); writeT = fT[rD]; exec(ins, pc); return;
        case 47: {   // stmw
            const ea = (((rA ? g[rA] : 0) + ((ins << 16) >> 16)) ^ 0x80000000) >>> 0;
            exec(ins, pc);
            for (let r = rD, o = ea; r < 32; r++, o += 4) if (gT[r] >= 0 && o < MEM1_SIZE - 3) for (let k = 0; k < 4; k++) { shadow[o + k] = 1; came[o + k] = gT[r] + 1; }
            return;
        }
        case 7: case 8: case 12: case 13: U(gT[rA], 'arithmetic'); exec(ins, pc); gT[rD] = -1; return;
        case 10: case 11: U(gT[rA], 'compare'); exec(ins, pc); return;
        case 14: { const t = rA && (ins & 0xFFFF) === 0 ? gT[rA] : -1; if (rA && (ins & 0xFFFF)) U(gT[rA], 'arithmetic'); exec(ins, pc); gT[rD] = t; return; }
        case 15: if (rA) U(gT[rA], 'arithmetic'); exec(ins, pc); gT[rD] = -1; return;
        case 20: { const t = gT[rA] >= 0 ? gT[rA] : gT[rD]; exec(ins, pc); gT[rA] = t; return; }
        case 21: { const t = gT[rD]; if (ins & 1) U(t, 'compare'); exec(ins, pc); gT[rA] = t; return; }
        case 23: U(gT[rB], 'arithmetic'); { const t = gT[rD]; exec(ins, pc); gT[rA] = t; } return;
        case 24: case 25: case 26: case 27: { const t = gT[rD]; exec(ins, pc); gT[rA] = t; return; }
        case 28: case 29: U(gT[rD], 'compare'); exec(ins, pc); gT[rA] = -1; return;
        case 31: {
            const xo = (ins >>> 1) & 0x3FF;
            switch (xo) {
                case 0: case 32: U(gT[rA], 'compare'); U(gT[rB], 'compare'); exec(ins, pc); return;
                // loads
                case 23: case 55: case 87: case 119: case 279: case 311: case 343: case 375: case 534: case 790: case 20:
                    if (rA) U(gT[rA], 'address'); U(gT[rB], 'address'); inExec = true; exec(ins, pc); inExec = false; gT[rD] = readT; return;
                case 535: case 567: case 599: case 631:
                    if (rA) U(gT[rA], 'address'); U(gT[rB], 'address'); inExec = true; exec(ins, pc); inExec = false; fT[rD] = readT; return;
                // stores
                case 151: case 183: case 215: case 247: case 407: case 439: case 662: case 918: case 150:
                    if (rA) U(gT[rA], 'address'); U(gT[rB], 'address'); writeT = gT[rD]; exec(ins, pc); return;
                case 663: case 695: case 727: case 759: case 983:
                    if (rA) U(gT[rA], 'address'); U(gT[rB], 'address'); writeT = fT[rD]; exec(ins, pc); return;
                // logic: the mark goes along
                case 444: case 28: case 60: case 316: case 476: case 124: case 412: case 284: {
                    const t = gT[rD] >= 0 ? gT[rD] : gT[rB]; if (ins & 1) U(t, 'compare'); exec(ins, pc); gT[rA] = xo === 316 && rD === rB ? -1 : t; return;
                }
                case 24: case 536: case 792: U(gT[rB], 'arithmetic'); { const t = gT[rD]; exec(ins, pc); gT[rA] = t; } return;
                case 824: case 954: case 922: { const t = gT[rD]; if (ins & 1) U(t, 'compare'); exec(ins, pc); gT[rA] = t; return; }
                case 26: U(gT[rD], 'compare'); exec(ins, pc); gT[rA] = -1; return;
                case 339: case 19: case 83: case 371: exec(ins, pc); gT[rD] = -1; return;
                case 467: U(gT[rD], 'jump'); exec(ins, pc); return;
                case 144: U(gT[rD], 'compare'); exec(ins, pc); return;
            }
            switch (xo & 0x1FF) {
                case 266: case 40: case 235: case 491: case 459: case 10: case 138: case 8: case 136: case 75: case 11:
                    U(gT[rA], 'arithmetic'); U(gT[rB], 'arithmetic'); exec(ins, pc); gT[rD] = -1; return;
                case 104: case 202: case 200: case 234: case 232: U(gT[rA], 'arithmetic'); exec(ins, pc); gT[rD] = -1; return;
            }
            exec(ins, pc); return;
        }
        case 59: case 63: {
            const xo = (ins >>> 1) & 0x3FF, rC = (ins >>> 6) & 31;
            if (op === 63) switch (xo) {
                case 0: case 32: U(fT[rA], 'compare'); U(fT[rB], 'compare'); exec(ins, pc); return;
                case 72: case 12: case 40: case 264: case 136: { const t = fT[rB]; exec(ins, pc); fT[rD] = t; return; }
                case 14: case 15: U(fT[rB], 'arithmetic'); exec(ins, pc); fT[rD] = -1; return;
                case 583: exec(ins, pc); fT[rD] = -1; return;
                case 711: case 70: case 38: case 134: case 64: exec(ins, pc); return;
            }
            switch (xo & 31) {
                case 18: case 20: case 21: U(fT[rA], 'arithmetic'); U(fT[rB], 'arithmetic'); break;
                case 22: case 24: case 26: U(fT[rB], 'arithmetic'); break;
                case 25: U(fT[rA], 'arithmetic'); U(fT[rC], 'arithmetic'); break;
                case 23: case 28: case 29: case 30: case 31: U(fT[rA], 'arithmetic'); U(fT[rB], 'arithmetic'); U(fT[rC], 'arithmetic'); break;
            }
            exec(ins, pc); fT[rD] = -1; return;
        }
        case 4: {
            const xo = (ins >>> 1) & 0x3FF, x6 = (ins >>> 1) & 0x3F, rC = (ins >>> 6) & 31;
            if (x6 === 6 || x6 === 38) { if (rA) U(gT[rA], 'address'); U(gT[rB], 'address'); inExec = true; exec(ins, pc); inExec = false; fT[rD] = readT; return; }
            if (x6 === 7 || x6 === 39) { if (rA) U(gT[rA], 'address'); U(gT[rB], 'address'); writeT = fT[rD]; exec(ins, pc); return; }
            switch (xo) {
                case 0: case 32: case 64: case 96: U(fT[rA], 'compare'); U(fT[rB], 'compare'); exec(ins, pc); return;
                case 72: case 40: case 264: case 136: { const t = fT[rB]; exec(ins, pc); fT[rD] = t; return; }
                case 528: case 560: case 592: case 624: { const t = fT[rA] >= 0 ? fT[rA] : fT[rB]; exec(ins, pc); fT[rD] = t; return; }
                case 1014: exec(ins, pc); return;
            }
            switch (xo & 31) {
                case 18: case 20: case 21: U(fT[rA], 'arithmetic'); U(fT[rB], 'arithmetic'); break;
                case 24: case 26: U(fT[rB], 'arithmetic'); break;
                case 12: case 13: case 25: U(fT[rA], 'arithmetic'); U(fT[rC], 'arithmetic'); break;
                case 10: case 11: case 14: case 15: case 23: case 28: case 29: case 30: case 31: U(fT[rA], 'arithmetic'); U(fT[rB], 'arithmetic'); U(fT[rC], 'arithmetic'); break;
            }
            exec(ins, pc); fT[rD] = -1; return;
        }
    }
    exec(ins, pc);
};

// ---------------------------------------------------------------- run
const budget = +(process.argv[3] || 200000) * 1e6, t0 = performance.now(), wall = +(process.env.WALL || 0) * 1000;
let res = 'budget';
try {
    const end = cpu.count + budget;
    while (cpu.count < end && (res = R.run(Math.min(200e6, end - cpu.count))) !== 'done') if ((wall && performance.now() - t0 > wall) || R.frames > TO) { res = 'stopped'; break; }
} catch (e) { console.log('STOP', String(e)); }
console.log(`${res}: ${R.frames} of ${T.frames.length} frames, ${R.ticks} ticks, ${R.issues.length} issue(s), ${allocs.length} allocations, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
// grouped by the function that uses the value and the block it came from
interface Group { fn: string; kinds: Set<string>; origin: string; lo: number; hi: number; n: number; frame: number; tick: number; pcs: Set<number>; example: number }
const groups = new Map<string, Group>();
for (const u of uses.values()) {
    const fn = S.who(u.pc).replace(/\+0x[0-9a-f]+$/, ''), m = /^(.*?) \+0x([0-9a-f]+) (.*)$/.exec(u.origin), origin = m ? `${m[1]} ${m[3]}` : u.origin, off = m ? parseInt(m[2], 16) : 0;
    const key = `${fn}|${origin}`; let G = groups.get(key);
    if (!G) groups.set(key, G = { fn, kinds: new Set(), origin, lo: off, hi: off, n: 0, frame: u.frame, tick: u.tick, pcs: new Set(), example: u.example });
    G.kinds.add(u.kind); G.lo = Math.min(G.lo, off); G.hi = Math.max(G.hi, off); G.n += u.n; G.pcs.add(u.pc);
    if (u.frame < G.frame || (u.frame === G.frame && u.tick < G.tick)) { G.frame = u.frame; G.tick = u.tick; G.example = u.example; }
}
const list = [...groups.values()].sort((a, b) => a.frame - b.frame || a.tick - b.tick);
const max = +(process.env.MAX || 400);
console.log(`${uses.size} use(s) of unset memory in the stage${FROM || TO < 1e9 ? ` (frames ${FROM}-${TO})` : ''}, in ${list.length} group(s):`);
for (const G of list.slice(0, max)) console.log(`frame ${G.frame} tick ${G.tick}: ${G.fn} (${[...G.kinds].join(', ')}; ${[...G.pcs].slice(0, 3).map((x) => x.toString(16)).join(' ')}${G.pcs.size > 3 ? ' …' : ''}): ${G.origin} +0x${G.lo.toString(16)}${G.hi > G.lo ? `..0x${G.hi.toString(16)}` : ''} [x${G.n}, first at ${G.example.toString(16)}]`);
