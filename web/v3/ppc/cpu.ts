// v3: a Gekko (PowerPC 750CL) interpreter that runs the game's own machine code from the user's DOL.
// User-mode integer, branch, load/store, FPU and paired-single instructions. Floating point follows
// Dolphin's hardware-tested rules: single ops round once (fused ops too), a single multiply's frC
// keeps 25 bits, single results go to both ps0 and ps1, fres / frsqrte use the Gekko's tables.
// FPRs are kept as raw bits (fctiw and stfd/lfd must keep NaN payloads).

import { Memory } from './mem.js';
import { fr, maddD, maddS, force25, fres, frsqrte } from './fpu.js';

export const RETURN_SENTINEL = 0xFFFFFFF0;

/** A JS replacement for a game function (by address): it reads arguments from the CPU and returns like blr. */
export type Hook = (cpu: Cpu) => void;

export class Cpu {
    gpr = new Uint32Array(32);
    /** ps0 / ps1 of each FPR as raw doubles ([lo, hi] host words; Float64 views over them) */
    private ps0b = new ArrayBuffer(32 * 8); private ps1b = new ArrayBuffer(32 * 8);
    ps0 = new Float64Array(this.ps0b); ps1 = new Float64Array(this.ps1b);
    ps0w = new Uint32Array(this.ps0b); ps1w = new Uint32Array(this.ps1b);
    pc = 0; lr = 0; ctr = 0;
    cr = 0;
    xerSO = 0; xerOV = 0; xerCA = 0; xerBC = 0;
    fpscr = 0;
    gqr = new Uint32Array(8);
    msr = 0; srr0 = 0; srr1 = 0; dec = 0;
    sprg = new Uint32Array(4);
    spr = new Map<number, number>();
    /** the time base, in bus ticks / 4 (advanced by the host) */
    tb = 0n;
    hooks = new Map<number, Hook>();
    /** instructions executed */
    count = 0;
    constructor(public mem: Memory) { }

    // ---------------------------------------------------------------- helpers
    f(i: number) { return this.ps0[i]; }
    setF(i: number, v: number) { this.ps0[i] = v; }
    /** a single-precision result: ps0 = ps1 = v (HID2[PSE]) */
    setS(i: number, v: number) { v = fr(v); this.ps0[i] = v; this.ps1[i] = v; }
    private setCR0(v: number) {
        v |= 0;
        const f = (v < 0 ? 8 : v > 0 ? 4 : 2) | this.xerSO;
        this.cr = (this.cr & 0x0FFFFFFF) | (f << 28);
    }
    setCRField(n: number, f: number) { const s = (7 - n) * 4; this.cr = ((this.cr & ~(0xF << s)) | ((f & 0xF) << s)) >>> 0; }
    crBit(b: number) { return (this.cr >>> (31 - b)) & 1; }
    setCrBit(b: number, v: number) { const m = 1 << (31 - b); this.cr = (v ? this.cr | m : this.cr & ~m) >>> 0; }
    get xer() { return ((this.xerSO << 31) | (this.xerOV << 30) | (this.xerCA << 29) | this.xerBC) >>> 0; }
    set xer(v: number) { this.xerSO = (v >>> 31) & 1; this.xerOV = (v >>> 30) & 1; this.xerCA = (v >>> 29) & 1; this.xerBC = v & 0x7F; }
    private fcmp(a: number, b: number) { return a !== a || b !== b ? 1 : a < b ? 8 : a > b ? 4 : 2; }

    /** Calls the game function at addr with integer and float arguments; runs until it returns. */
    call(addr: number, ints: number[] = [], floats: number[] = [], limit = 50_000_000) {
        ints.forEach((v, i) => (this.gpr[3 + i] = v >>> 0));
        floats.forEach((v, i) => { this.ps0[1 + i] = v; this.ps1[1 + i] = v; });
        this.lr = RETURN_SENTINEL; this.pc = addr >>> 0;
        this.run(limit);
        return this.gpr[3];
    }
    run(limit: number) {
        const end = this.count + limit;
        while (this.pc !== RETURN_SENTINEL) {
            if (this.count >= end) throw new Error(`instruction limit at 0x${this.pc.toString(16)}`);
            const h = this.hooks.get(this.pc);
            if (h) { h(this); this.pc = this.lr; continue; }
            this.step();
        }
    }
    step() {
        const pc = this.pc, ins = this.mem.r32(pc);
        this.pc = (pc + 4) >>> 0;
        this.count++;
        try { this.exec(ins, pc); }
        catch (e) { if (e instanceof Unimpl) e.message += ` at 0x${pc.toString(16)}`; throw e; }
    }

    // ---------------------------------------------------------------- decode
    private exec(ins: number, pc: number) {
        const op = ins >>> 26, rD = (ins >>> 21) & 31, rA = (ins >>> 16) & 31, rB = (ins >>> 11) & 31;
        const simm = (ins << 16) >> 16, uimm = ins & 0xFFFF;
        const g = this.gpr, m = this.mem;
        const ea0 = () => (rA ? g[rA] : 0) + simm;
        switch (op) {
            case 3: if (this.trapCond(rD, g[rA] | 0, simm)) throw new Error(`twi trap at 0x${pc.toString(16)}`); return;
            case 4: return this.ps(ins, pc);
            case 7: g[rD] = Math.imul(g[rA], simm); return;   // mulli
            case 8: { const a = g[rA]; this.xerCA = carry3(~a >>> 0, simm >>> 0, 1); g[rD] = (simm - a) >>> 0; return; }   // subfic
            case 10: { const f = g[rA] < (uimm >>> 0) ? 8 : g[rA] > uimm ? 4 : 2; this.setCRField(rD >>> 2, f | this.xerSO); return; }   // cmpli
            case 11: { const a = g[rA] | 0, f = a < simm ? 8 : a > simm ? 4 : 2; this.setCRField(rD >>> 2, f | this.xerSO); return; }   // cmpi
            case 12: case 13: { const a = g[rA]; this.xerCA = carry3(a, simm >>> 0, 0); g[rD] = (a + simm) >>> 0; if (op === 13) this.setCR0(g[rD]); return; }   // addic(.)
            case 14: g[rD] = ((rA ? g[rA] : 0) + simm) >>> 0; return;   // addi
            case 15: g[rD] = ((rA ? g[rA] : 0) + (uimm << 16)) >>> 0; return;   // addis
            case 16: {   // bc
                const bo = rD, bi = rA, bd = (ins & 0xFFFC) << 16 >> 16;
                if (this.bcCond(bo, bi)) { if (ins & 1) this.lr = (pc + 4) >>> 0; this.pc = (ins & 2 ? bd : pc + bd) >>> 0; }
                return;
            }
            case 17: throw new Unimpl('sc');
            case 18: { const li = (ins & 0x03FFFFFC) << 6 >> 6; if (ins & 1) this.lr = (pc + 4) >>> 0; this.pc = (ins & 2 ? li : pc + li) >>> 0; return; }
            case 19: return this.op19(ins, pc);
            case 20: { const sh = rB, mb = (ins >>> 6) & 31, me = (ins >>> 1) & 31, mk = mask(mb, me); g[rA] = ((rotl(g[rD], sh) & mk) | (g[rA] & ~mk)) >>> 0; if (ins & 1) this.setCR0(g[rA]); return; }   // rlwimi
            case 21: { const mk = mask((ins >>> 6) & 31, (ins >>> 1) & 31); g[rA] = (rotl(g[rD], rB) & mk) >>> 0; if (ins & 1) this.setCR0(g[rA]); return; }   // rlwinm
            case 23: { const mk = mask((ins >>> 6) & 31, (ins >>> 1) & 31); g[rA] = (rotl(g[rD], g[rB] & 31) & mk) >>> 0; if (ins & 1) this.setCR0(g[rA]); return; }   // rlwnm
            case 24: g[rA] = (g[rD] | uimm) >>> 0; return;
            case 25: g[rA] = (g[rD] | (uimm << 16)) >>> 0; return;
            case 26: g[rA] = (g[rD] ^ uimm) >>> 0; return;
            case 27: g[rA] = (g[rD] ^ (uimm << 16)) >>> 0; return;
            case 28: g[rA] = g[rD] & uimm; this.setCR0(g[rA]); return;
            case 29: g[rA] = (g[rD] & (uimm << 16)) >>> 0; this.setCR0(g[rA]); return;
            case 31: return this.op31(ins, pc);
            case 32: g[rD] = m.r32(ea0()); return;
            case 33: { const a = (g[rA] + simm) >>> 0; g[rD] = m.r32(a); g[rA] = a; return; }
            case 34: g[rD] = m.r8(ea0()); return;
            case 35: { const a = (g[rA] + simm) >>> 0; g[rD] = m.r8(a); g[rA] = a; return; }
            case 36: m.w32(ea0(), g[rD]); return;
            case 37: { const a = (g[rA] + simm) >>> 0; m.w32(a, g[rD]); g[rA] = a; return; }
            case 38: m.w8(ea0(), g[rD] & 0xFF); return;
            case 39: { const a = (g[rA] + simm) >>> 0; m.w8(a, g[rD] & 0xFF); g[rA] = a; return; }
            case 40: g[rD] = m.r16(ea0()); return;
            case 41: { const a = (g[rA] + simm) >>> 0; g[rD] = m.r16(a); g[rA] = a; return; }
            case 42: g[rD] = (m.r16(ea0()) << 16) >> 16; return;
            case 43: { const a = (g[rA] + simm) >>> 0; g[rD] = (m.r16(a) << 16) >> 16; g[rA] = a; return; }
            case 44: m.w16(ea0(), g[rD] & 0xFFFF); return;
            case 45: { const a = (g[rA] + simm) >>> 0; m.w16(a, g[rD] & 0xFFFF); g[rA] = a; return; }
            case 46: { let a = ea0() >>> 0; for (let r = rD; r < 32; r++, a += 4) g[r] = m.r32(a); return; }   // lmw
            case 47: { let a = ea0() >>> 0; for (let r = rD; r < 32; r++, a += 4) m.w32(a, g[r]); return; }   // stmw
            case 48: this.lfs(rD, ea0()); return;
            case 49: { const a = (g[rA] + simm) >>> 0; this.lfs(rD, a); g[rA] = a; return; }
            case 50: m.r64(ea0(), this.ps0w, rD * 2); return;
            case 51: { const a = (g[rA] + simm) >>> 0; m.r64(a, this.ps0w, rD * 2); g[rA] = a; return; }
            case 52: this.stfs(rD, ea0()); return;
            case 53: { const a = (g[rA] + simm) >>> 0; this.stfs(rD, a); g[rA] = a; return; }
            case 54: m.w64(ea0(), this.ps0w, rD * 2); return;
            case 55: { const a = (g[rA] + simm) >>> 0; m.w64(a, this.ps0w, rD * 2); g[rA] = a; return; }
            case 56: return this.psqLoad(rD, ((rA ? g[rA] : 0) + ((ins << 20) >> 20)) >>> 0, (ins >>> 15) & 1, (ins >>> 12) & 7);
            case 57: { const a = ((g[rA] + ((ins << 20) >> 20)) >>> 0); this.psqLoad(rD, a, (ins >>> 15) & 1, (ins >>> 12) & 7); g[rA] = a; return; }
            case 59: return this.op59(ins);
            case 60: return this.psqStore(rD, ((rA ? g[rA] : 0) + ((ins << 20) >> 20)) >>> 0, (ins >>> 15) & 1, (ins >>> 12) & 7);
            case 61: { const a = ((g[rA] + ((ins << 20) >> 20)) >>> 0); this.psqStore(rD, a, (ins >>> 15) & 1, (ins >>> 12) & 7); g[rA] = a; return; }
            case 63: return this.op63(ins);
        }
        throw new Unimpl(`opcode ${op} (0x${(ins >>> 0).toString(16)})`);
    }

    private trapCond(to: number, a: number, b: number) {
        return ((to & 16) && a < b) || ((to & 8) && a > b) || ((to & 4) && a === b) || ((to & 2) && (a >>> 0) < (b >>> 0)) || ((to & 1) && (a >>> 0) > (b >>> 0));
    }
    private bcCond(bo: number, bi: number) {
        if (!(bo & 4)) this.ctr = (this.ctr - 1) >>> 0;
        const ctrOk = (bo & 4) || ((this.ctr !== 0) !== !!(bo & 2));
        const condOk = (bo & 16) || (this.crBit(bi) === ((bo >>> 3) & 1));
        return ctrOk && condOk;
    }

    // ---------------------------------------------------------------- 19: branches to LR / CTR, CR logic
    private op19(ins: number, pc: number) {
        const xo = (ins >>> 1) & 0x3FF, d = (ins >>> 21) & 31, a = (ins >>> 16) & 31, b = (ins >>> 11) & 31;
        switch (xo) {
            case 0: this.setCRField(d >>> 2, (this.cr >>> ((7 - (a >>> 2)) * 4)) & 0xF); return;   // mcrf
            case 16: {   // bclr
                const target = this.lr & ~3;
                if (this.bcCond(d, a)) { if (ins & 1) this.lr = (pc + 4) >>> 0; this.pc = target >>> 0; }
                return;
            }
            case 528: {   // bcctr
                const ok = (d & 16) || (this.crBit(a) === ((d >>> 3) & 1));
                if (ok) { if (ins & 1) this.lr = (pc + 4) >>> 0; this.pc = (this.ctr & ~3) >>> 0; }
                return;
            }
            case 33: return this.setCrBit(d, ~(this.crBit(a) | this.crBit(b)) & 1);
            case 129: return this.setCrBit(d, this.crBit(a) & ~this.crBit(b) & 1);
            case 193: return this.setCrBit(d, this.crBit(a) ^ this.crBit(b));
            case 225: return this.setCrBit(d, ~(this.crBit(a) & this.crBit(b)) & 1);
            case 257: return this.setCrBit(d, this.crBit(a) & this.crBit(b));
            case 289: return this.setCrBit(d, ~(this.crBit(a) ^ this.crBit(b)) & 1);
            case 417: return this.setCrBit(d, (this.crBit(a) | (~this.crBit(b) & 1)) & 1);
            case 449: return this.setCrBit(d, this.crBit(a) | this.crBit(b));
            case 150: return;   // isync
            case 50: this.msr = this.srr1; this.pc = this.srr0 & ~3; return;   // rfi
        }
        throw new Unimpl(`op19 xo ${xo}`);
    }

    // ---------------------------------------------------------------- 31: integer and indexed memory
    private op31(ins: number, pc: number) {
        const xo = (ins >>> 1) & 0x3FF, d = (ins >>> 21) & 31, a = (ins >>> 16) & 31, b = (ins >>> 11) & 31, rc = ins & 1;
        const g = this.gpr, m = this.mem;
        const eax = () => ((a ? g[a] : 0) + g[b]) >>> 0, eau = () => (g[a] + g[b]) >>> 0;
        const res = (v: number) => { g[d] = v >>> 0; if (rc) this.setCR0(g[d]); };
        const resA = (v: number) => { g[a] = v >>> 0; if (rc) this.setCR0(g[a]); };
        // the 9-bit XO forms (with OE): add, subf, mul, div
        const xo9 = xo & 0x1FF, oe = (ins >>> 10) & 1;
        switch (xo9) {
            case 266: { const r = (g[a] + g[b]) >>> 0; if (oe) this.ov(((g[a] ^ r) & (g[b] ^ r)) >>> 31); return res(r); }   // add
            case 10: { this.xerCA = carry3(g[a], g[b], 0); const r = (g[a] + g[b]) >>> 0; if (oe) this.ov(((g[a] ^ r) & (g[b] ^ r)) >>> 31); return res(r); }   // addc
            case 138: { const c = this.xerCA; this.xerCA = carry3(g[a], g[b], c); const r = (g[a] + g[b] + c) >>> 0; if (oe) this.ov(((g[a] ^ r) & (g[b] ^ r)) >>> 31); return res(r); }   // adde
            case 202: { const c = this.xerCA; this.xerCA = carry3(g[a], 0, c); return res(g[a] + c); }   // addze
            case 234: { const c = this.xerCA; this.xerCA = carry3(g[a], 0xFFFFFFFF, c); return res(g[a] + 0xFFFFFFFF + c); }   // addme
            case 40: { const r = (g[b] - g[a]) >>> 0; if (oe) this.ov(((~g[a] ^ r) & (g[b] ^ r)) >>> 31); return res(r); }   // subf
            case 8: { this.xerCA = carry3(~g[a] >>> 0, g[b], 1); return res(g[b] - g[a]); }   // subfc
            case 136: { const c = this.xerCA; this.xerCA = carry3(~g[a] >>> 0, g[b], c); return res((~g[a] >>> 0) + g[b] + c); }   // subfe
            case 200: { const c = this.xerCA; this.xerCA = carry3(~g[a] >>> 0, 0, c); return res((~g[a] >>> 0) + c); }   // subfze
            case 232: { const c = this.xerCA; this.xerCA = carry3(~g[a] >>> 0, 0xFFFFFFFF, c); return res((~g[a] >>> 0) + 0xFFFFFFFF + c); }   // subfme
            case 104: { if (oe) this.ov(g[a] === 0x80000000 ? 1 : 0); return res(-g[a]); }   // neg
            case 235: { if (oe) { const p = (g[a] | 0) * (g[b] | 0); this.ov(p > 0x7FFFFFFF || p < -0x80000000 ? 1 : 0); } return res(Math.imul(g[a], g[b])); }   // mullw
            case 75: return res(Number((BigInt(g[a] | 0) * BigInt(g[b] | 0)) >> 32n) | 0);   // mulhw
            case 11: return res(Number((BigInt(g[a]) * BigInt(g[b])) >> 32n) | 0);   // mulhwu
            case 491: { const x = g[a] | 0, y = g[b] | 0; let r: number, bad = 0; if (y === 0 || (x === -0x80000000 && y === -1)) { r = x < 0 && y === 0 ? -1 : 0; if (x === -0x80000000 && y === -1) r = -1; bad = 1; } else r = (x / y) | 0; if (oe) this.ov(bad); return res(r); }   // divw
            case 459: { const y = g[b]; if (oe) this.ov(y ? 0 : 1); return res(y ? Math.floor(g[a] / y) : 0); }   // divwu
        }
        switch (xo) {
            case 0: { const x = g[a] | 0, y = g[b] | 0; this.setCRField(d >>> 2, (x < y ? 8 : x > y ? 4 : 2) | this.xerSO); return; }   // cmp
            case 32: { const x = g[a], y = g[b]; this.setCRField(d >>> 2, (x < y ? 8 : x > y ? 4 : 2) | this.xerSO); return; }   // cmpl
            case 4: if (this.trapCond(d, g[a] | 0, g[b] | 0)) throw new Error(`tw trap at 0x${pc.toString(16)}`); return;
            case 28: return resA(g[d] & g[b]);
            case 60: return resA(g[d] & ~g[b]);
            case 444: return resA(g[d] | g[b]);
            case 412: return resA(g[d] | ~g[b]);
            case 316: return resA(g[d] ^ g[b]);
            case 124: return resA(~(g[d] | g[b]));
            case 476: return resA(~(g[d] & g[b]));
            case 284: return resA(~(g[d] ^ g[b]));
            case 24: { const s = g[b] & 63; return resA(s > 31 ? 0 : g[d] << s); }   // slw
            case 536: { const s = g[b] & 63; return resA(s > 31 ? 0 : g[d] >>> s); }   // srw
            case 792: {   // sraw
                const s = g[b] & 63, v = g[d] | 0;
                if (s > 31) { this.xerCA = v < 0 ? 1 : 0; return resA(v < 0 ? -1 : 0); }
                const r = v >> s; this.xerCA = v < 0 && s && ((v & ((1 << s) - 1)) !== 0) ? 1 : 0; return resA(r);
            }
            case 824: { const s = b, v = g[d] | 0, r = v >> s; this.xerCA = v < 0 && s && ((v & ((1 << s) - 1)) !== 0) ? 1 : 0; return resA(r); }   // srawi
            case 26: return resA(Math.clz32(g[d]));
            case 954: return resA((g[d] << 24) >> 24);
            case 922: return resA((g[d] << 16) >> 16);
            case 19: g[d] = this.cr; return;   // mfcr
            case 144: { const crm = (ins >>> 12) & 0xFF; let mk = 0; for (let i = 0; i < 8; i++) if (crm & (0x80 >>> i)) mk |= 0xF0000000 >>> (i * 4); this.cr = ((this.cr & ~mk) | (g[d] & mk)) >>> 0; return; }   // mtcrf
            case 512: { this.setCRField(d >>> 2, (this.xer >>> 28) & 0xF); this.xer = this.xer & 0x0FFFFFFF; return; }   // mcrxr
            case 83: g[d] = this.msr; return;
            case 146: this.msr = g[d]; return;
            case 339: g[d] = this.mfspr(((b << 5) | a)); return;
            case 467: this.mtspr(((b << 5) | a), g[d]); return;
            case 371: { const n = ((b << 5) | a); g[d] = n === 268 ? Number(this.tb & 0xFFFFFFFFn) : Number((this.tb >> 32n) & 0xFFFFFFFFn); return; }   // mftb
            case 595: case 659: g[d] = 0; return;   // mfsr(in)
            case 210: case 242: return;   // mtsr(in)
            case 598: case 854: case 982: case 86: case 54: case 470: case 278: case 246: case 306: case 566: return;   // sync, eieio, icbi, dcbf, dcbst, dcbi, dcbt, dcbtst, tlbie, tlbsync
            case 1014: { const ea = eax() & ~31; for (let i = 0; i < 32; i += 4) m.w32(ea + i, 0); return; }   // dcbz
            // indexed loads and stores
            case 23: g[d] = m.r32(eax()); return;
            case 55: { const e = eau(); g[d] = m.r32(e); g[a] = e; return; }
            case 87: g[d] = m.r8(eax()); return;
            case 119: { const e = eau(); g[d] = m.r8(e); g[a] = e; return; }
            case 279: g[d] = m.r16(eax()); return;
            case 311: { const e = eau(); g[d] = m.r16(e); g[a] = e; return; }
            case 343: g[d] = (m.r16(eax()) << 16) >> 16; return;
            case 375: { const e = eau(); g[d] = (m.r16(e) << 16) >> 16; g[a] = e; return; }
            case 151: m.w32(eax(), g[d]); return;
            case 183: { const e = eau(); m.w32(e, g[d]); g[a] = e; return; }
            case 215: m.w8(eax(), g[d] & 0xFF); return;
            case 247: { const e = eau(); m.w8(e, g[d] & 0xFF); g[a] = e; return; }
            case 407: m.w16(eax(), g[d] & 0xFFFF); return;
            case 439: { const e = eau(); m.w16(e, g[d] & 0xFFFF); g[a] = e; return; }
            case 534: g[d] = bswap32(m.r32(eax())); return;   // lwbrx
            case 662: m.w32(eax(), bswap32(g[d])); return;   // stwbrx
            case 790: g[d] = bswap16(m.r16(eax())); return;   // lhbrx
            case 918: m.w16(eax(), bswap16(g[d] & 0xFFFF)); return;   // sthbrx
            case 20: g[d] = m.r32(eax()); this.reserve = eax(); return;   // lwarx
            case 150: { m.w32(eax(), g[d]); this.setCRField(0, 2 | this.xerSO); return; }   // stwcx.
            case 535: this.lfs(d, eax()); return;
            case 567: { const e = eau(); this.lfs(d, e); g[a] = e; return; }
            case 599: m.r64(eax(), this.ps0w, d * 2); return;
            case 631: { const e = eau(); m.r64(e, this.ps0w, d * 2); g[a] = e; return; }
            case 663: this.stfs(d, eax()); return;
            case 695: { const e = eau(); this.stfs(d, e); g[a] = e; return; }
            case 727: m.w64(eax(), this.ps0w, d * 2); return;
            case 759: { const e = eau(); m.w64(e, this.ps0w, d * 2); g[a] = e; return; }
            case 983: m.w32(eax(), this.ps0w[d * 2]); return;   // stfiwx
            case 533: case 661: throw new Unimpl('lswx/stswx');
            case 597: { let e = (a ? g[a] : 0) >>> 0, n = b || 32, r = d - 1; let i = 0; while (n-- > 0) { if (i === 0) { r = (r + 1) & 31; g[r] = 0; } g[r] |= m.r8(e++) << (24 - i * 8); i = (i + 1) & 3; } return; }   // lswi
            case 725: { let e = (a ? g[a] : 0) >>> 0, n = b || 32, r = d - 1; let i = 0; while (n-- > 0) { if (i === 0) r = (r + 1) & 31; m.w8(e++, (g[r] >>> (24 - i * 8)) & 0xFF); i = (i + 1) & 3; } return; }   // stswi
        }
        throw new Unimpl(`op31 xo ${xo}`);
    }
    reserve = 0;
    private ov(v: number) { this.xerOV = v; if (v) this.xerSO = 1; }
    mfspr(n: number) {
        switch (n) {
            case 1: return this.xer; case 8: return this.lr; case 9: return this.ctr;
            case 22: return this.dec; case 26: return this.srr0; case 27: return this.srr1;
            case 268: return Number(this.tb & 0xFFFFFFFFn); case 269: return Number(this.tb >> 32n);
        }
        if (n >= 272 && n <= 275) return this.sprg[n - 272];
        if (n >= 912 && n <= 919) return this.gqr[n - 912];
        return this.spr.get(n) ?? 0;
    }
    mtspr(n: number, v: number) {
        v >>>= 0;
        switch (n) {
            case 1: this.xer = v; return; case 8: this.lr = v; return; case 9: this.ctr = v; return;
            case 22: this.dec = v; return; case 26: this.srr0 = v; return; case 27: this.srr1 = v; return;
            case 284: this.tb = (this.tb & ~0xFFFFFFFFn) | BigInt(v); return;
            case 285: this.tb = (this.tb & 0xFFFFFFFFn) | (BigInt(v) << 32n); return;
        }
        if (n >= 272 && n <= 275) { this.sprg[n - 272] = v; return; }
        if (n >= 912 && n <= 919) { this.gqr[n - 912] = v; return; }
        this.spr.set(n, v);
    }

    // ---------------------------------------------------------------- FPU
    private lfs(d: number, a: number) { const v = f32FromBits(this.mem.r32(a)); this.ps0[d] = v; this.ps1[d] = v; }
    private stfs(d: number, a: number) { this.mem.w32(a, f32Bits(this.ps0[d])); }
    private fpRc(ins: number) { if (ins & 1) this.setCRField(1, (this.fpscr >>> 28) & 0xF); }

    /** 59: single precision */
    private op59(ins: number) {
        const d = (ins >>> 21) & 31, a = (ins >>> 16) & 31, b = (ins >>> 11) & 31, c = (ins >>> 6) & 31, xo = (ins >>> 1) & 31;
        const A = this.ps0[a], B = this.ps0[b], C = this.ps0[c];
        switch (xo) {
            case 18: this.setS(d, A / B); break;
            case 20: this.setS(d, A - B); break;
            case 21: this.setS(d, A + B); break;
            case 24: this.setS(d, fres(B)); break;
            case 25: this.setS(d, A * force25(C)); break;
            case 28: this.setS(d, maddS(A, force25(C), -B)); break;   // fmsubs
            case 29: this.setS(d, maddS(A, force25(C), B)); break;    // fmadds
            case 30: this.setS(d, -maddS(A, force25(C), -B)); break;  // fnmsubs
            case 31: this.setS(d, -maddS(A, force25(C), B)); break;   // fnmadds
            case 22: this.setS(d, Math.sqrt(B)); break;   // fsqrts (not on the Gekko; harmless)
            default: throw new Unimpl(`op59 xo ${xo}`);
        }
        this.fpRc(ins);
    }

    /** 63: double precision and FPU control */
    private op63(ins: number) {
        const d = (ins >>> 21) & 31, a = (ins >>> 16) & 31, b = (ins >>> 11) & 31, c = (ins >>> 6) & 31;
        const xo5 = (ins >>> 1) & 31, xo = (ins >>> 1) & 0x3FF;
        const A = this.ps0[a], B = this.ps0[b], C = this.ps0[c];
        switch (xo5) {
            case 18: this.ps0[d] = A / B; return this.fpRc(ins);
            case 20: this.ps0[d] = A - B; return this.fpRc(ins);
            case 21: this.ps0[d] = A + B; return this.fpRc(ins);
            case 23: this.ps0[d] = A >= 0 ? C : B; return this.fpRc(ins);   // fsel (NaN: B)
            case 25: this.ps0[d] = A * C; return this.fpRc(ins);
            case 26: this.ps0[d] = frsqrte(B); return this.fpRc(ins);
            case 28: this.ps0[d] = maddD(A, C, -B); return this.fpRc(ins);
            case 29: this.ps0[d] = maddD(A, C, B); return this.fpRc(ins);
            case 30: this.ps0[d] = -maddD(A, C, -B); return this.fpRc(ins);
            case 31: this.ps0[d] = -maddD(A, C, B); return this.fpRc(ins);
            case 24: this.ps0[d] = fres(B); return this.fpRc(ins);
            case 22: this.ps0[d] = Math.sqrt(B); return this.fpRc(ins);
        }
        switch (xo) {
            case 0: case 32: this.setCRField(d >>> 2, this.fcmp(A, B)); this.fpscr = ((this.fpscr & ~0xF000) | (this.fcmp(A, B) << 12)) >>> 0; return;   // fcmpu, fcmpo
            case 12: this.ps0[d] = fr(B); return this.fpRc(ins);   // frsp
            case 14: case 15: { const r = s32sat(xo === 15 ? Math.trunc(B) : roundMode(B, this.fpscr & 3)); this.ps0w[d * 2] = r >>> 0; this.ps0w[d * 2 + 1] = 0xFFF80000; return this.fpRc(ins); }   // fctiw(z)
            case 40: this.ps0[d] = -B; return this.fpRc(ins);
            case 72: this.ps0w[d * 2] = this.ps0w[b * 2]; this.ps0w[d * 2 + 1] = this.ps0w[b * 2 + 1]; return this.fpRc(ins);   // fmr
            case 136: this.ps0[d] = -Math.abs(B); return this.fpRc(ins);
            case 264: this.ps0[d] = Math.abs(B); return this.fpRc(ins);
            case 583: this.ps0w[d * 2] = this.fpscr; this.ps0w[d * 2 + 1] = 0xFFF80000; return this.fpRc(ins);   // mffs
            case 711: { const fm = (ins >>> 17) & 0xFF; let mk = 0; for (let i = 0; i < 8; i++) if (fm & (0x80 >>> i)) mk |= 0xF0000000 >>> (i * 4); this.fpscr = ((this.fpscr & ~mk) | (this.ps0w[b * 2] & mk)) >>> 0; return this.fpRc(ins); }   // mtfsf
            case 134: { const n = d >>> 2, imm = (ins >>> 12) & 0xF, s = (7 - n) * 4; this.fpscr = ((this.fpscr & ~(0xF << s)) | (imm << s)) >>> 0; return this.fpRc(ins); }   // mtfsfi
            case 38: this.fpscr = (this.fpscr | (0x80000000 >>> d)) >>> 0; return this.fpRc(ins);   // mtfsb1
            case 70: this.fpscr = (this.fpscr & ~(0x80000000 >>> d)) >>> 0; return this.fpRc(ins);   // mtfsb0
            case 64: { const s = (7 - (a >>> 2)) * 4; this.setCRField(d >>> 2, (this.fpscr >>> s) & 0xF); return; }   // mcrfs
        }
        throw new Unimpl(`op63 xo ${xo}`);
    }

    // ---------------------------------------------------------------- paired singles (opcode 4)
    private ps(ins: number, pc: number) {
        const d = (ins >>> 21) & 31, a = (ins >>> 16) & 31, b = (ins >>> 11) & 31, c = (ins >>> 6) & 31;
        const xo5 = (ins >>> 1) & 31, xo = (ins >>> 1) & 0x3FF, P0 = this.ps0, P1 = this.ps1, g = this.gpr;
        const set = (x: number, y: number) => { P0[d] = fr(x); P1[d] = fr(y); this.fpRc(ins); };
        switch (xo & 0x3F) {   // psq_lx / psq_stx / psq_lux / psq_stux: 6-bit XO
            case 6: return this.psqLoad(d, ((a ? g[a] : 0) + g[b]) >>> 0, (ins >>> 10) & 1, (ins >>> 7) & 7);
            case 7: return this.psqStore(d, ((a ? g[a] : 0) + g[b]) >>> 0, (ins >>> 10) & 1, (ins >>> 7) & 7);
            case 38: { const e = (g[a] + g[b]) >>> 0; this.psqLoad(d, e, (ins >>> 10) & 1, (ins >>> 7) & 7); g[a] = e; return; }
            case 39: { const e = (g[a] + g[b]) >>> 0; this.psqStore(d, e, (ins >>> 10) & 1, (ins >>> 7) & 7); g[a] = e; return; }
        }
        switch (xo5) {
            case 10: return set(P0[a] + P1[b], P1[c]);   // ps_sum0
            case 11: return set(P0[c], P0[a] + P1[b]);   // ps_sum1
            case 12: return set(P0[a] * force25(P0[c]), P1[a] * force25(P0[c]));   // ps_muls0
            case 13: return set(P0[a] * force25(P1[c]), P1[a] * force25(P1[c]));   // ps_muls1
            case 14: return set(maddS(P0[a], force25(P0[c]), P0[b]), maddS(P1[a], force25(P0[c]), P1[b]));   // ps_madds0
            case 15: return set(maddS(P0[a], force25(P1[c]), P0[b]), maddS(P1[a], force25(P1[c]), P1[b]));   // ps_madds1
            case 18: return set(P0[a] / P0[b], P1[a] / P1[b]);
            case 20: return set(P0[a] - P0[b], P1[a] - P1[b]);
            case 21: return set(P0[a] + P0[b], P1[a] + P1[b]);
            case 23: return set(P0[a] >= 0 ? P0[c] : P0[b], P1[a] >= 0 ? P1[c] : P1[b]);   // ps_sel
            case 24: return set(fres(P0[b]), fres(P1[b]));
            case 25: return set(P0[a] * force25(P0[c]), P1[a] * force25(P1[c]));
            case 26: return set(frsqrte(P0[b]), frsqrte(P1[b]));
            case 28: return set(maddS(P0[a], force25(P0[c]), -P0[b]), maddS(P1[a], force25(P1[c]), -P1[b]));
            case 29: return set(maddS(P0[a], force25(P0[c]), P0[b]), maddS(P1[a], force25(P1[c]), P1[b]));
            case 30: return set(-maddS(P0[a], force25(P0[c]), -P0[b]), -maddS(P1[a], force25(P1[c]), -P1[b]));
            case 31: return set(-maddS(P0[a], force25(P0[c]), P0[b]), -maddS(P1[a], force25(P1[c]), P1[b]));
        }
        switch (xo) {
            case 40: { const x = -P0[b], y = -P1[b]; P0[d] = x; P1[d] = y; return this.fpRc(ins); }   // ps_neg
            case 72: { P0[d] = P0[b]; P1[d] = P1[b]; return this.fpRc(ins); }   // ps_mr
            case 136: { P0[d] = -Math.abs(P0[b]); P1[d] = -Math.abs(P1[b]); return this.fpRc(ins); }
            case 264: { P0[d] = Math.abs(P0[b]); P1[d] = Math.abs(P1[b]); return this.fpRc(ins); }
            case 528: { const x = P0[a], y = P0[b]; P0[d] = x; P1[d] = y; return this.fpRc(ins); }   // ps_merge00
            case 560: { const x = P0[a], y = P1[b]; P0[d] = x; P1[d] = y; return this.fpRc(ins); }   // ps_merge01
            case 592: { const x = P1[a], y = P0[b]; P0[d] = x; P1[d] = y; return this.fpRc(ins); }   // ps_merge10
            case 624: { const x = P1[a], y = P1[b]; P0[d] = x; P1[d] = y; return this.fpRc(ins); }   // ps_merge11
            case 0: case 32: this.setCRField(d >>> 2, this.fcmp(P0[a], P0[b])); return;   // ps_cmpu0 / ps_cmpo0
            case 64: case 96: this.setCRField(d >>> 2, this.fcmp(P1[a], P1[b])); return;   // ps_cmpu1 / ps_cmpo1
            case 1014: { const ea = ((a ? g[a] : 0) + g[b]) & ~31; for (let i = 0; i < 32; i += 4) this.mem.w32(ea + i, 0); return; }   // dcbz_l
        }
        throw new Unimpl(`ps xo ${xo} (0x${(ins >>> 0).toString(16)})`);
    }
    private psqLoad(d: number, ea: number, w: number, i: number) {
        const q = this.gqr[i], type = (q >>> 16) & 7, scale = sext6((q >>> 24) & 0x3F), m = this.mem;
        const sz = type === 4 || type === 6 ? 1 : type === 5 || type === 7 ? 2 : 4;
        const rd = (o: number) => {
            const a = (ea + o) >>> 0;
            switch (type) {
                case 4: return m.r8(a) * 2 ** -scale;
                case 5: return m.r16(a) * 2 ** -scale;
                case 6: return ((m.r8(a) << 24) >> 24) * 2 ** -scale;
                case 7: return ((m.r16(a) << 16) >> 16) * 2 ** -scale;
                default: return f32FromBits(m.r32(a));
            }
        };
        const x = rd(0), y = w ? 1 : rd(sz);
        this.ps0[d] = x; this.ps1[d] = y;
    }
    private psqStore(d: number, ea: number, w: number, i: number) {
        const q = this.gqr[i], type = q & 7, scale = sext6((q >>> 8) & 0x3F), m = this.mem;
        const sz = type === 4 || type === 6 ? 1 : type === 5 || type === 7 ? 2 : 4;
        const wr = (o: number, v: number) => {
            const a = (ea + o) >>> 0;
            switch (type) {
                case 4: m.w8(a, qclamp(v * 2 ** scale, 0, 255)); return;
                case 5: m.w16(a, qclamp(v * 2 ** scale, 0, 65535)); return;
                case 6: m.w8(a, qclamp(v * 2 ** scale, -128, 127) & 0xFF); return;
                case 7: m.w16(a, qclamp(v * 2 ** scale, -32768, 32767) & 0xFFFF); return;
                default: m.w32(a, f32Bits(v));
            }
        };
        wr(0, this.ps0[d]);
        if (!w) wr(sz, this.ps1[d]);
    }
}

export class Unimpl extends Error { }

// ---------------------------------------------------------------- bit helpers
const rotl = (v: number, n: number) => ((v << n) | (v >>> (32 - n))) >>> 0;
function mask(mb: number, me: number) {
    const a = 0xFFFFFFFF >>> mb, b = me === 31 ? 0xFFFFFFFF : ~(0xFFFFFFFF >>> (me + 1));
    return (mb <= me ? a & b : a | b) >>> 0;
}
/** the carry out of a + b + c (unsigned 32-bit) */
const carry3 = (a: number, b: number, c: number) => ((a >>> 0) + (b >>> 0) + c > 0xFFFFFFFF ? 1 : 0);
const bswap32 = (v: number) => (((v & 0xFF) << 24) | ((v & 0xFF00) << 8) | ((v >>> 8) & 0xFF00) | (v >>> 24)) >>> 0;
const bswap16 = (v: number) => ((v & 0xFF) << 8) | ((v >>> 8) & 0xFF);
const sext6 = (v: number) => (v & 0x20 ? v - 64 : v);
const f32v = new Float32Array(1), f32u = new Uint32Array(f32v.buffer);
export const f32FromBits = (b: number) => { f32u[0] = b; return f32v[0]; };
export const f32Bits = (v: number) => { f32v[0] = v; return f32u[0]; };
const s32sat = (v: number) => (v !== v ? -0x80000000 : v >= 2147483647 ? 0x7FFFFFFF : v <= -2147483648 ? -0x80000000 : v);
/** round to integer by the FPSCR's RN (0 nearest even, 1 zero, 2 +inf, 3 -inf) */
function roundMode(v: number, rn: number) {
    if (rn === 1) return Math.trunc(v);
    if (rn === 2) return Math.ceil(v);
    if (rn === 3) return Math.floor(v);
    const f = Math.floor(v), d = v - f;
    return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1);
}
const qclamp = (v: number, lo: number, hi: number) => { const t = Math.trunc(v); return t < lo ? lo : t > hi ? hi : t; };
