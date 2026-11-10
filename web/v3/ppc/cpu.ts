// v3: a Gekko (PowerPC 750CL) interpreter that runs the game's own machine code from the user's DOL.
// Integer, branch, load/store, FPU and paired-single instructions, the exceptions the GameCube OS
// uses (system call, external interrupt, decrementer, FP unavailable for its lazy FPU switching),
// and the special registers it touches. Floating point follows the hardware as Dolphin's tests
// describe it (fpu.ts). FPRs are raw bits: fctiw's results and NaN payloads survive moves and stores.

import { Memory, MEM1_SIZE, LC_BASE } from './mem.js';
import { fr, fmaD, fmaS, force25, fres, frsqrte, singleToDoubleBits, doubleToSingleBits, MIN_NORMAL_F32, MIN_NORMAL_F64, trunc25 } from './fpu.js';

/** call() returns when the PC reaches this (unmapped) address */
export const RETURN_SENTINEL = 0xFFFFFFF0;
/** instructions per time-base tick: the Gekko at 486 MHz, the time base at bus (162 MHz) / 4 */
export const TB_DIV = 12;

/** A JS stand-in at an address. Returns false to go on and run the instruction there (a probe);
 *  otherwise the CPU returns to LR (unless the hook moved the PC itself). */
export type Hook = (cpu: Cpu) => boolean | void;

export class Unimpl extends Error { }

const MSR_EE = 0x8000, MSR_FP = 0x2000, MSR_DR = 0x10;
// SPR numbers
const SPR_XER = 1, SPR_LR = 8, SPR_CTR = 9, SPR_DEC = 22, SPR_SRR0 = 26, SPR_SRR1 = 27, SPR_TBL = 268, SPR_TBU = 269,
    SPR_TBL_W = 284, SPR_TBU_W = 285, SPR_PVR = 287, SPR_GQR0 = 912, SPR_HID2 = 920, SPR_DMAU = 922, SPR_DMAL = 923;

export class Cpu {
    gpr = new Uint32Array(32);
    // FPRs as raw doubles: ps0[i] / ps1[i] the values, ps0w / ps1w their [lo, hi] words (2 i, 2 i + 1)
    private fbuf = new ArrayBuffer(32 * 8 * 2);
    ps0 = new Float64Array(this.fbuf, 0, 32); ps1 = new Float64Array(this.fbuf, 256, 32);
    ps0w = new Uint32Array(this.fbuf, 0, 64); ps1w = new Uint32Array(this.fbuf, 256, 64);
    pc = 0; lr = 0; ctr = 0;
    cr = 0;
    xerSO = 0; xerOV = 0; xerCA = 0; xerBC = 0;
    fpscr = 0;
    /** FPSCR[NI]: results below the smallest normal number are flushed to zero */
    private ni = false;
    gqr = new Uint32Array(8);
    msr = 0; srr0 = 0; srr1 = 0;
    spr = new Uint32Array(1024);
    reserve = 0;

    /** instructions executed: the machine's clock */
    count = 0;
    private tbBase = 0; private tbCount0 = 0;
    private decBase = 0xFFFFFFFF; private decCount0 = 0;
    /** called when the game writes DEC (the machine reschedules the decrementer exception) */
    onDecWrite: (() => void) | null = null;
    /** the external interrupt line (PI), and a decrementer exception waiting for MSR[EE] */
    extIrq = false; decPending = false;
    private intr = false;
    /** leave run() after the current instruction */
    brk = false;
    /** run() stops when the count reaches this; the machine lowers it when an earlier event is scheduled */
    limit = 0;

    private hookMap = new Uint16Array(MEM1_SIZE >>> 2);
    private hookFns: (Hook | null)[] = [null];

    constructor(public mem: Memory) { }

    // ---------------------------------------------------------------- hooks
    hook(addr: number, fn: Hook) {
        const o = (addr ^ 0x80000000) >>> 0;
        if (o >= MEM1_SIZE || (o & 3)) throw new Error(`hook at 0x${(addr >>> 0).toString(16)}`);
        this.hookFns.push(fn); this.hookMap[o >>> 2] = this.hookFns.length - 1;
    }
    unhook(addr: number) { this.hookMap[((addr ^ 0x80000000) >>> 0) >>> 2] = 0; }
    hookAt(addr: number): Hook | null { return this.hookFns[this.hookMap[((addr ^ 0x80000000) >>> 0) >>> 2]]; }

    // ---------------------------------------------------------------- time
    /** the time base (bus ticks / 4) */
    tb() { return this.tbBase + Math.floor((this.count - this.tbCount0) / TB_DIV); }
    dec() { return (this.decBase - Math.floor((this.count - this.decCount0) / TB_DIV)) >>> 0; }
    /** the instruction count at which DEC passes from 0 to -1 (its exception), or Infinity if it already is negative */
    decZeroAt() { return this.decBase & 0x80000000 ? Infinity : this.decCount0 + (this.decBase + 1) * TB_DIV; }
    setExtIrq(on: boolean) { this.extIrq = on; this.intr = on || this.decPending; }
    setDecPending(on: boolean) { this.decPending = on; this.intr = on || this.extIrq; }

    // ---------------------------------------------------------------- running
    /** Calls the game function at addr with integer and float arguments; runs until it returns. r3 is the result. */
    call(addr: number, ints: number[] = [], floats: number[] = [], limit = 200_000_000) {
        for (let i = 0; i < ints.length; i++) this.gpr[3 + i] = ints[i];
        for (let i = 0; i < floats.length; i++) { this.ps0[1 + i] = floats[i]; this.ps1[1 + i] = floats[i]; }
        this.lr = RETURN_SENTINEL; this.pc = addr >>> 0;
        const end = this.count + limit;
        while (this.pc !== RETURN_SENTINEL) {
            if (this.count >= end) throw new Error(`call(0x${(addr >>> 0).toString(16)}): instruction limit at 0x${this.pc.toString(16)}`);
            this.run(end);
        }
        return this.gpr[3];
    }
    /** Runs until the instruction count reaches `until`, a hook or the game sets brk, or call()'s return. */
    run(until: number) {
        const hookMap = this.hookMap, hookFns = this.hookFns, mem = this.mem, dv = mem.dv;
        this.brk = false; this.limit = until;
        while (this.count < this.limit && !this.brk) {
            if (this.intr && (this.msr & MSR_EE)) this.interrupt();
            const pc = this.pc, o = (pc ^ 0x80000000) >>> 0;
            let ins: number;
            if (o < MEM1_SIZE) {
                const h = hookMap[o >>> 2];
                if (h !== 0 && hookFns[h]!(this) !== false) { this.count++; if (this.pc === pc) this.pc = this.lr >>> 0; continue; }
                ins = dv.getUint32(o);
            } else if (pc === RETURN_SENTINEL) return;
            else ins = mem.r32(pc);   // (physical addresses, with the MMU off)
            this.pc = (pc + 4) >>> 0;
            this.count++;
            this.exec(ins, pc);
        }
    }
    private interrupt() {
        if (this.extIrq) this.exception(0x500, this.pc);
        else { this.setDecPending(false); this.exception(0x900, this.pc); }
    }
    /** Takes an exception: SRR0 = where to resume, SRR1 = the MSR, then the vector (MSR[IP] is clear). */
    exception(vector: number, resume: number) {
        this.srr0 = resume >>> 0; this.srr1 = this.msr & 0x87C0FFFF;
        this.setMsr(this.msr & ~0x04EF36);
        this.pc = (0x80000000 | vector) >>> 0;
    }
    setMsr(v: number) { this.msr = v >>> 0; this.mem.real = !(v & MSR_DR); }

    // ---------------------------------------------------------------- flags
    private setCR0(v: number) {
        v |= 0;
        this.cr = ((this.cr & 0x0FFFFFFF) | (((v < 0 ? 8 : v > 0 ? 4 : 2) | this.xerSO) << 28)) >>> 0;
    }
    setCRField(n: number, f: number) { const s = 28 - 4 * n; this.cr = ((this.cr & ~(0xF << s)) | ((f & 0xF) << s)) >>> 0; }
    crBit(b: number) { return (this.cr >>> (31 - b)) & 1; }
    private setCrBit(b: number, v: number) { const m = 1 << (31 - b); this.cr = (v ? this.cr | m : this.cr & ~m) >>> 0; }
    get xer() { return ((this.xerSO << 31) | (this.xerOV << 30) | (this.xerCA << 29) | this.xerBC) >>> 0; }
    set xer(v: number) { this.xerSO = (v >>> 31) & 1; this.xerOV = (v >>> 30) & 1; this.xerCA = (v >>> 29) & 1; this.xerBC = v & 0x7F; }
    private ov(v: number) { this.xerOV = v; if (v) this.xerSO = 1; }
    setFpscr(v: number) {
        this.fpscr = v >>> 0; this.ni = (v & 4) !== 0;
        if (v & 3) throw new Unimpl(`FPSCR rounding mode ${v & 3}`);
    }

    // ---------------------------------------------------------------- decode
    private exec(ins: number, pc: number) {
        const g = this.gpr, m = this.mem;
        const rD = (ins >>> 21) & 31, rA = (ins >>> 16) & 31;
        switch (ins >>> 26) {
            case 14: g[rD] = (rA ? g[rA] : 0) + ((ins << 16) >> 16); return;   // addi
            case 15: g[rD] = (rA ? g[rA] : 0) + (ins << 16); return;   // addis
            case 32: g[rD] = m.r32((rA ? g[rA] : 0) + ((ins << 16) >> 16)); return;   // lwz
            case 36: m.w32((rA ? g[rA] : 0) + ((ins << 16) >> 16), g[rD]); return;   // stw
            case 18: {   // b
                const li = (ins & 0x03FFFFFC) << 6 >> 6;
                if (ins & 1) this.lr = (pc + 4) >>> 0;
                this.pc = (ins & 2 ? li : pc + li) >>> 0; return;
            }
            case 16: {   // bc
                if (this.bcCond(rD, rA)) {
                    const bd = (ins & 0xFFFC) << 16 >> 16;
                    if (ins & 1) this.lr = (pc + 4) >>> 0;
                    this.pc = (ins & 2 ? bd : pc + bd) >>> 0;
                }
                return;
            }
            case 19: return this.op19(ins, pc);
            case 31: return this.op31(ins, pc);
            case 10: { const a = g[rA], u = ins & 0xFFFF; this.setCRField(rD >>> 2, (a < u ? 8 : a > u ? 4 : 2) | this.xerSO); return; }   // cmpli
            case 11: { const a = g[rA] | 0, s = (ins << 16) >> 16; this.setCRField(rD >>> 2, (a < s ? 8 : a > s ? 4 : 2) | this.xerSO); return; }   // cmpi
            case 21: { g[rA] = rotl(g[rD], (ins >>> 11) & 31) & MASK[(ins >>> 1) & 0x3FF]; if (ins & 1) this.setCR0(g[rA]); return; }   // rlwinm
            case 20: { const mk = MASK[(ins >>> 1) & 0x3FF]; g[rA] = (rotl(g[rD], (ins >>> 11) & 31) & mk) | (g[rA] & ~mk); if (ins & 1) this.setCR0(g[rA]); return; }   // rlwimi
            case 23: { g[rA] = rotl(g[rD], g[(ins >>> 11) & 31] & 31) & MASK[(ins >>> 1) & 0x3FF]; if (ins & 1) this.setCR0(g[rA]); return; }   // rlwnm
            case 24: g[rA] = g[rD] | (ins & 0xFFFF); return;   // ori
            case 25: g[rA] = g[rD] | (ins << 16); return;   // oris
            case 26: g[rA] = g[rD] ^ (ins & 0xFFFF); return;   // xori
            case 27: g[rA] = g[rD] ^ (ins << 16); return;   // xoris
            case 28: g[rA] = g[rD] & (ins & 0xFFFF); this.setCR0(g[rA]); return;   // andi.
            case 29: g[rA] = g[rD] & (ins << 16); this.setCR0(g[rA]); return;   // andis.
            case 7: g[rD] = Math.imul(g[rA], (ins << 16) >> 16); return;   // mulli
            case 8: { const a = g[rA], s = (ins << 16) >> 16; this.xerCA = carry((~a) >>> 0, s >>> 0, 1); g[rD] = s - a; return; }   // subfic
            case 12: case 13: {   // addic, addic.
                const a = g[rA], s = (ins << 16) >> 16;
                this.xerCA = carry(a, s >>> 0, 0); g[rD] = a + s;
                if (ins & 0x04000000) this.setCR0(g[rD]);
                return;
            }
            case 33: { const a = (g[rA] + ((ins << 16) >> 16)) >>> 0; g[rD] = m.r32(a); g[rA] = a; return; }   // lwzu
            case 34: g[rD] = m.r8((rA ? g[rA] : 0) + ((ins << 16) >> 16)); return;   // lbz
            case 35: { const a = (g[rA] + ((ins << 16) >> 16)) >>> 0; g[rD] = m.r8(a); g[rA] = a; return; }
            case 37: { const a = (g[rA] + ((ins << 16) >> 16)) >>> 0; m.w32(a, g[rD]); g[rA] = a; return; }   // stwu
            case 38: m.w8((rA ? g[rA] : 0) + ((ins << 16) >> 16), g[rD] & 0xFF); return;   // stb
            case 39: { const a = (g[rA] + ((ins << 16) >> 16)) >>> 0; m.w8(a, g[rD] & 0xFF); g[rA] = a; return; }
            case 40: g[rD] = m.r16((rA ? g[rA] : 0) + ((ins << 16) >> 16)); return;   // lhz
            case 41: { const a = (g[rA] + ((ins << 16) >> 16)) >>> 0; g[rD] = m.r16(a); g[rA] = a; return; }
            case 42: g[rD] = (m.r16((rA ? g[rA] : 0) + ((ins << 16) >> 16)) << 16) >> 16; return;   // lha
            case 43: { const a = (g[rA] + ((ins << 16) >> 16)) >>> 0; g[rD] = (m.r16(a) << 16) >> 16; g[rA] = a; return; }
            case 44: m.w16((rA ? g[rA] : 0) + ((ins << 16) >> 16), g[rD] & 0xFFFF); return;   // sth
            case 45: { const a = (g[rA] + ((ins << 16) >> 16)) >>> 0; m.w16(a, g[rD] & 0xFFFF); g[rA] = a; return; }
            case 46: { let a = ((rA ? g[rA] : 0) + ((ins << 16) >> 16)) >>> 0; for (let r = rD; r < 32; r++, a += 4) g[r] = m.r32(a); return; }   // lmw
            case 47: { let a = ((rA ? g[rA] : 0) + ((ins << 16) >> 16)) >>> 0; for (let r = rD; r < 32; r++, a += 4) m.w32(a, g[r]); return; }   // stmw
            case 3: if (trapCond(rD, g[rA] | 0, (ins << 16) >> 16)) throw new Error(`twi trap at 0x${pc.toString(16)}`); return;
            case 17: return this.exception(0xC00, (pc + 4) >>> 0);   // sc
        }
        // floating point: the OS switches FPU contexts lazily, on the FP unavailable exception
        const op = ins >>> 26;
        if (op !== 4 && (op < 48 || op === 58 || op === 62)) throw new Unimpl(`opcode ${op} (0x${(ins >>> 0).toString(16)}) at 0x${pc.toString(16)}`);
        if (!(this.msr & MSR_FP)) return this.exception(0x800, pc);
        switch (op) {
            case 48: singleToDoubleBits(m.r32((rA ? g[rA] : 0) + ((ins << 16) >> 16)), this.ps0w, rD * 2); this.ps1w[rD * 2] = this.ps0w[rD * 2]; this.ps1w[rD * 2 + 1] = this.ps0w[rD * 2 + 1]; return;   // lfs
            case 49: { const a = (g[rA] + ((ins << 16) >> 16)) >>> 0; this.lfs(rD, a); g[rA] = a; return; }
            case 50: { const a = (rA ? g[rA] : 0) + ((ins << 16) >> 16); this.ps0w[rD * 2 + 1] = m.r32(a); this.ps0w[rD * 2] = m.r32(a + 4); return; }   // lfd
            case 51: { const a = (g[rA] + ((ins << 16) >> 16)) >>> 0; this.ps0w[rD * 2 + 1] = m.r32(a); this.ps0w[rD * 2] = m.r32(a + 4); g[rA] = a; return; }
            case 52: m.w32((rA ? g[rA] : 0) + ((ins << 16) >> 16), doubleToSingleBits(this.ps0w[rD * 2 + 1], this.ps0w[rD * 2])); return;   // stfs
            case 53: { const a = (g[rA] + ((ins << 16) >> 16)) >>> 0; m.w32(a, doubleToSingleBits(this.ps0w[rD * 2 + 1], this.ps0w[rD * 2])); g[rA] = a; return; }
            case 54: { const a = (rA ? g[rA] : 0) + ((ins << 16) >> 16); m.w32(a, this.ps0w[rD * 2 + 1]); m.w32(a + 4, this.ps0w[rD * 2]); return; }   // stfd
            case 55: { const a = (g[rA] + ((ins << 16) >> 16)) >>> 0; m.w32(a, this.ps0w[rD * 2 + 1]); m.w32(a + 4, this.ps0w[rD * 2]); g[rA] = a; return; }
            case 59: return this.op59(ins);
            case 63: return this.op63(ins);
            case 4: return this.op4(ins);
            case 56: return this.psqLoad(rD, ((rA ? g[rA] : 0) + ((ins << 20) >> 20)) >>> 0, (ins >>> 15) & 1, (ins >>> 12) & 7);
            case 57: { const a = (g[rA] + ((ins << 20) >> 20)) >>> 0; this.psqLoad(rD, a, (ins >>> 15) & 1, (ins >>> 12) & 7); g[rA] = a; return; }
            case 60: return this.psqStore(rD, ((rA ? g[rA] : 0) + ((ins << 20) >> 20)) >>> 0, (ins >>> 15) & 1, (ins >>> 12) & 7);
            case 61: { const a = (g[rA] + ((ins << 20) >> 20)) >>> 0; this.psqStore(rD, a, (ins >>> 15) & 1, (ins >>> 12) & 7); g[rA] = a; return; }
        }
        throw new Unimpl(`opcode ${ins >>> 26} (0x${(ins >>> 0).toString(16)}) at 0x${pc.toString(16)}`);
    }

    private bcCond(bo: number, bi: number) {
        if (!(bo & 4)) { this.ctr = (this.ctr - 1) >>> 0; if ((this.ctr !== 0) === ((bo & 2) !== 0)) return false; }
        return (bo & 16) !== 0 || ((this.cr >>> (31 - bi)) & 1) === ((bo >>> 3) & 1);
    }

    // ---------------------------------------------------------------- 19: branches to LR / CTR, CR logic, rfi
    private op19(ins: number, pc: number) {
        const d = (ins >>> 21) & 31, a = (ins >>> 16) & 31, b = (ins >>> 11) & 31;
        switch ((ins >>> 1) & 0x3FF) {
            case 16: {   // bclr
                const target = this.lr;
                if (this.bcCond(d, a)) { if (ins & 1) this.lr = (pc + 4) >>> 0; this.pc = (target & ~3) >>> 0; }
                return;
            }
            case 528: {   // bcctr
                if ((d & 16) !== 0 || this.crBit(a) === ((d >>> 3) & 1)) { if (ins & 1) this.lr = (pc + 4) >>> 0; this.pc = (this.ctr & ~3) >>> 0; }
                return;
            }
            case 50: {   // rfi
                this.setMsr(((this.msr & ~0x87C0FFFF) | (this.srr1 & 0x87C0FFFF)) & 0xFFFBFFFF);
                this.pc = (this.srr0 & ~3) >>> 0; return;
            }
            case 0: this.setCRField(d >>> 2, (this.cr >>> (28 - 4 * (a >>> 2))) & 0xF); return;   // mcrf
            case 33: return this.setCrBit(d, (this.crBit(a) | this.crBit(b)) ^ 1);   // crnor
            case 129: return this.setCrBit(d, this.crBit(a) & (this.crBit(b) ^ 1));   // crandc
            case 193: return this.setCrBit(d, this.crBit(a) ^ this.crBit(b));   // crxor
            case 225: return this.setCrBit(d, (this.crBit(a) & this.crBit(b)) ^ 1);   // crnand
            case 257: return this.setCrBit(d, this.crBit(a) & this.crBit(b));   // crand
            case 289: return this.setCrBit(d, this.crBit(a) ^ this.crBit(b) ^ 1);   // creqv
            case 417: return this.setCrBit(d, this.crBit(a) | (this.crBit(b) ^ 1));   // crorc
            case 449: return this.setCrBit(d, this.crBit(a) | this.crBit(b));   // cror
            case 150: return;   // isync
        }
        throw new Unimpl(`op19 xo ${(ins >>> 1) & 0x3FF} at 0x${pc.toString(16)}`);
    }

    // ---------------------------------------------------------------- 31: integer and indexed memory
    private op31(ins: number, pc: number) {
        const xo = (ins >>> 1) & 0x3FF, d = (ins >>> 21) & 31, a = (ins >>> 16) & 31, b = (ins >>> 11) & 31;
        const g = this.gpr, m = this.mem;
        switch (xo) {
            // ---- arithmetic (the OE forms are xo + 512)
            case 266: case 778: { const x = g[a], y = g[b], r = (x + y) >>> 0; if (xo & 512) this.ov(((x ^ r) & (y ^ r)) >>> 31); g[d] = r; break; }   // add
            case 40: case 552: { const x = g[a], y = g[b], r = (y - x) >>> 0; if (xo & 512) this.ov(((x ^ y) & (y ^ r)) >>> 31); g[d] = r; break; }   // subf
            case 10: case 522: { const x = g[a], y = g[b], r = (x + y) >>> 0; this.xerCA = r < x ? 1 : 0; if (xo & 512) this.ov(((x ^ r) & (y ^ r)) >>> 31); g[d] = r; break; }   // addc
            case 8: case 520: { const x = g[a], y = g[b], r = (y - x) >>> 0; this.xerCA = y >= x ? 1 : 0; if (xo & 512) this.ov(((x ^ y) & (y ^ r)) >>> 31); g[d] = r; break; }   // subfc
            case 138: case 650: { const x = g[a], y = g[b], c = this.xerCA, r = (x + y + c) >>> 0; this.xerCA = carry(x, y, c); if (xo & 512) this.ov(((x ^ r) & (y ^ r)) >>> 31); g[d] = r; break; }   // adde
            case 136: case 648: { const x = (~g[a]) >>> 0, y = g[b], c = this.xerCA, r = (x + y + c) >>> 0; this.xerCA = carry(x, y, c); if (xo & 512) this.ov(((x ^ r) & (y ^ r)) >>> 31); g[d] = r; break; }   // subfe
            case 202: case 714: { const x = g[a], c = this.xerCA, r = (x + c) >>> 0; this.xerCA = carry(x, 0, c); if (xo & 512) this.ov((~x & r) >>> 31); g[d] = r; break; }   // addze
            case 200: case 712: { const x = (~g[a]) >>> 0, c = this.xerCA, r = (x + c) >>> 0; this.xerCA = carry(x, 0, c); if (xo & 512) this.ov((~x & r) >>> 31); g[d] = r; break; }   // subfze
            case 234: case 746: { const x = g[a], c = this.xerCA, r = (x + 0xFFFFFFFF + c) >>> 0; this.xerCA = carry(x, 0xFFFFFFFF, c); if (xo & 512) this.ov((x & ~r) >>> 31); g[d] = r; break; }   // addme
            case 232: case 744: { const x = (~g[a]) >>> 0, c = this.xerCA, r = (x + 0xFFFFFFFF + c) >>> 0; this.xerCA = carry(x, 0xFFFFFFFF, c); if (xo & 512) this.ov((x & ~r) >>> 31); g[d] = r; break; }   // subfme
            case 104: case 616: { const x = g[a]; if (xo & 512) this.ov(x === 0x80000000 ? 1 : 0); g[d] = -x; break; }   // neg
            case 235: case 747: { const x = g[a] | 0, y = g[b] | 0; if (xo & 512) { const p = x * y; this.ov(p > 2147483647 || p < -2147483648 ? 1 : 0); } g[d] = Math.imul(x, y); break; }   // mullw
            case 75: g[d] = mulhw(g[a] | 0, g[b] | 0); break;   // mulhw
            case 11: g[d] = mulhwu(g[a], g[b]); break;   // mulhwu
            case 491: case 1003: {   // divw
                const x = g[a] | 0, y = g[b] | 0;
                if (y === 0 || (x === -2147483648 && y === -1)) { g[d] = x < 0 ? 0xFFFFFFFF : 0; if (xo & 512) this.ov(1); }
                else { g[d] = (x / y) | 0; if (xo & 512) this.ov(0); }
                break;
            }
            case 459: case 971: {   // divwu
                const x = g[a], y = g[b];
                if (y === 0) { g[d] = 0; if (xo & 512) this.ov(1); }
                else { g[d] = Math.floor(x / y); if (xo & 512) this.ov(0); }
                break;
            }
            // ---- compares, traps
            case 0: { const x = g[a] | 0, y = g[b] | 0; this.setCRField(d >>> 2, (x < y ? 8 : x > y ? 4 : 2) | this.xerSO); return; }   // cmp
            case 32: { const x = g[a], y = g[b]; this.setCRField(d >>> 2, (x < y ? 8 : x > y ? 4 : 2) | this.xerSO); return; }   // cmpl
            case 4: if (trapCond(d, g[a] | 0, g[b] | 0)) throw new Error(`tw trap at 0x${pc.toString(16)}`); return;
            // ---- logic and shifts (the result goes to rA; Rc sets CR0)
            case 28: g[a] = g[d] & g[b]; if (ins & 1) this.setCR0(g[a]); return;
            case 60: g[a] = g[d] & ~g[b]; if (ins & 1) this.setCR0(g[a]); return;
            case 444: g[a] = g[d] | g[b]; if (ins & 1) this.setCR0(g[a]); return;
            case 412: g[a] = g[d] | ~g[b]; if (ins & 1) this.setCR0(g[a]); return;
            case 316: g[a] = g[d] ^ g[b]; if (ins & 1) this.setCR0(g[a]); return;
            case 124: g[a] = ~(g[d] | g[b]); if (ins & 1) this.setCR0(g[a]); return;
            case 476: g[a] = ~(g[d] & g[b]); if (ins & 1) this.setCR0(g[a]); return;
            case 284: g[a] = ~(g[d] ^ g[b]); if (ins & 1) this.setCR0(g[a]); return;
            case 24: { const s = g[b] & 63; g[a] = s > 31 ? 0 : g[d] << s; if (ins & 1) this.setCR0(g[a]); return; }   // slw
            case 536: { const s = g[b] & 63; g[a] = s > 31 ? 0 : g[d] >>> s; if (ins & 1) this.setCR0(g[a]); return; }   // srw
            case 792: {   // sraw
                const s = g[b] & 63, v = g[d] | 0;
                if (s > 31) { this.xerCA = v < 0 ? 1 : 0; g[a] = v < 0 ? 0xFFFFFFFF : 0; }
                else { this.xerCA = v < 0 && (v << (32 - s)) !== 0 && s !== 0 ? 1 : 0; g[a] = v >> s; }
                if (ins & 1) this.setCR0(g[a]);
                return;
            }
            case 824: {   // srawi
                const v = g[d] | 0;
                this.xerCA = v < 0 && b !== 0 && (v << (32 - b)) !== 0 ? 1 : 0; g[a] = v >> b;
                if (ins & 1) this.setCR0(g[a]);
                return;
            }
            case 26: g[a] = Math.clz32(g[d]); if (ins & 1) this.setCR0(g[a]); return;   // cntlzw
            case 954: g[a] = (g[d] << 24) >> 24; if (ins & 1) this.setCR0(g[a]); return;   // extsb
            case 922: g[a] = (g[d] << 16) >> 16; if (ins & 1) this.setCR0(g[a]); return;   // extsh
            // ---- indexed loads and stores
            case 23: g[d] = m.r32((a ? g[a] : 0) + g[b]); return;   // lwzx
            case 55: { const e = (g[a] + g[b]) >>> 0; g[d] = m.r32(e); g[a] = e; return; }
            case 87: g[d] = m.r8((a ? g[a] : 0) + g[b]); return;   // lbzx
            case 119: { const e = (g[a] + g[b]) >>> 0; g[d] = m.r8(e); g[a] = e; return; }
            case 279: g[d] = m.r16((a ? g[a] : 0) + g[b]); return;   // lhzx
            case 311: { const e = (g[a] + g[b]) >>> 0; g[d] = m.r16(e); g[a] = e; return; }
            case 343: g[d] = (m.r16((a ? g[a] : 0) + g[b]) << 16) >> 16; return;   // lhax
            case 375: { const e = (g[a] + g[b]) >>> 0; g[d] = (m.r16(e) << 16) >> 16; g[a] = e; return; }
            case 151: m.w32((a ? g[a] : 0) + g[b], g[d]); return;   // stwx
            case 183: { const e = (g[a] + g[b]) >>> 0; m.w32(e, g[d]); g[a] = e; return; }
            case 215: m.w8((a ? g[a] : 0) + g[b], g[d] & 0xFF); return;   // stbx
            case 247: { const e = (g[a] + g[b]) >>> 0; m.w8(e, g[d] & 0xFF); g[a] = e; return; }
            case 407: m.w16((a ? g[a] : 0) + g[b], g[d] & 0xFFFF); return;   // sthx
            case 439: { const e = (g[a] + g[b]) >>> 0; m.w16(e, g[d] & 0xFFFF); g[a] = e; return; }
            case 534: g[d] = bswap32(m.r32((a ? g[a] : 0) + g[b])); return;   // lwbrx
            case 662: m.w32((a ? g[a] : 0) + g[b], bswap32(g[d])); return;   // stwbrx
            case 790: g[d] = bswap16(m.r16((a ? g[a] : 0) + g[b])); return;   // lhbrx
            case 918: m.w16((a ? g[a] : 0) + g[b], bswap16(g[d] & 0xFFFF)); return;   // sthbrx
            case 20: { const e = ((a ? g[a] : 0) + g[b]) >>> 0; g[d] = m.r32(e); this.reserve = e; return; }   // lwarx
            case 150: m.w32((a ? g[a] : 0) + g[b], g[d]); this.setCRField(0, 2 | this.xerSO); return;   // stwcx. (one CPU: it always succeeds)
            case 597: {   // lswi
                let e = (a ? g[a] : 0) >>> 0, n = b || 32, r = d - 1, i = 0;
                while (n-- > 0) { if (i === 0) { r = (r + 1) & 31; g[r] = 0; } g[r] |= m.r8(e++) << (24 - i * 8); i = (i + 1) & 3; }
                return;
            }
            case 725: {   // stswi
                let e = (a ? g[a] : 0) >>> 0, n = b || 32, r = d - 1, i = 0;
                while (n-- > 0) { if (i === 0) r = (r + 1) & 31; m.w8(e++, (g[r] >>> (24 - i * 8)) & 0xFF); i = (i + 1) & 3; }
                return;
            }
            // ---- special registers
            case 339: g[d] = this.mfspr((b << 5) | a); return;
            case 467: this.mtspr((b << 5) | a, g[d]); return;
            case 371: { const t = this.tb(); g[d] = ((b << 5) | a) === SPR_TBU ? Math.floor(t / 4294967296) : t % 4294967296; return; }   // mftb
            case 19: g[d] = this.cr; return;   // mfcr
            case 144: {   // mtcrf
                const crm = (ins >>> 12) & 0xFF;
                let mk = 0;
                for (let i = 0; i < 8; i++) if (crm & (0x80 >>> i)) mk |= 0xF0000000 >>> (i * 4);
                this.cr = ((this.cr & ~mk) | (g[d] & mk)) >>> 0; return;
            }
            case 512: this.setCRField(d >>> 2, this.xer >>> 28); this.xerSO = this.xerOV = this.xerCA = 0; return;   // mcrxr
            case 83: g[d] = this.msr; return;   // mfmsr
            case 146: this.setMsr(g[d]); return;   // mtmsr
            case 595: case 659: g[d] = 0; return;   // mfsr, mfsrin
            case 210: case 242: return;   // mtsr, mtsrin
            // ---- cache and synchronisation: nothing to model, but for dcbz
            case 598: case 854: case 982: case 86: case 54: case 470: case 278: case 246: case 306: case 566: return;   // sync, eieio, icbi, dcbf, dcbst, dcbi, dcbt, dcbtst, tlbie, tlbsync
            case 1014: { const e = (((a ? g[a] : 0) + g[b]) & ~31) >>> 0; for (let i = 0; i < 32; i += 4) m.w32(e + i, 0); return; }   // dcbz
            // ---- indexed floating-point loads and stores
            case 535: case 567: case 599: case 631: case 663: case 695: case 727: case 759: case 983: {
                if (!(this.msr & MSR_FP)) return this.exception(0x800, pc);
                const update = xo === 567 || xo === 631 || xo === 695 || xo === 759;
                const e = ((a || update ? g[a] : 0) + g[b]) >>> 0, w = this.ps0w;
                switch (xo) {
                    case 535: case 567: this.lfs(d, e); break;
                    case 599: case 631: w[d * 2 + 1] = m.r32(e); w[d * 2] = m.r32(e + 4); break;
                    case 663: case 695: m.w32(e, doubleToSingleBits(w[d * 2 + 1], w[d * 2])); break;
                    case 727: case 759: m.w32(e, w[d * 2 + 1]); m.w32(e + 4, w[d * 2]); break;
                    case 983: m.w32(e, w[d * 2]); break;   // stfiwx
                }
                if (update) g[a] = e;
                return;
            }
            default: throw new Unimpl(`op31 xo ${xo} at 0x${pc.toString(16)}`);
        }
        if (ins & 1) this.setCR0(g[d]);   // (the arithmetic forms' Rc)
    }

    mfspr(n: number): number {
        switch (n) {
            case SPR_XER: return this.xer; case SPR_LR: return this.lr; case SPR_CTR: return this.ctr;
            case SPR_DEC: return this.dec(); case SPR_SRR0: return this.srr0; case SPR_SRR1: return this.srr1;
            case SPR_TBL: return this.tb() % 4294967296; case SPR_TBU: return Math.floor(this.tb() / 4294967296);
            case SPR_PVR: return 0x00083214;   // the Gekko
        }
        if (n >= SPR_GQR0 && n < SPR_GQR0 + 8) return this.gqr[n - SPR_GQR0];
        return this.spr[n];
    }
    mtspr(n: number, v: number) {
        v >>>= 0;
        switch (n) {
            case SPR_XER: this.xer = v; return; case SPR_LR: this.lr = v; return; case SPR_CTR: this.ctr = v; return;
            case SPR_SRR0: this.srr0 = v; return; case SPR_SRR1: this.srr1 = v; return;
            case SPR_DEC: this.decBase = v; this.decCount0 = this.count; if (this.onDecWrite) this.onDecWrite(); return;
            case SPR_TBL_W: { const t = this.tb(); this.tbBase = Math.floor(t / 4294967296) * 4294967296 + v; this.tbCount0 = this.count; return; }
            case SPR_TBU_W: { const t = this.tb(); this.tbBase = v * 4294967296 + t % 4294967296; this.tbCount0 = this.count; return; }
            case SPR_DMAL: this.spr[n] = v; if (v & 2) this.lcDma(); return;
        }
        if (n >= SPR_GQR0 && n < SPR_GQR0 + 8) { this.gqr[n - SPR_GQR0] = v; return; }
        this.spr[n] = v;
    }
    /** the locked cache's DMA (DMAU / DMAL): blocks of 32 bytes between it and memory, at once */
    private lcDma() {
        const u = this.spr[SPR_DMAU], l = this.spr[SPR_DMAL];
        const memA = (u & ~31) >>> 0, lcA = (l & ~31) >>> 0, toCache = (l & 0x10) !== 0;
        let blocks = ((u & 0x1F) << 2) | ((l >>> 2) & 3);
        if (blocks === 0) blocks = 128;
        const n = blocks * 32, ram = this.mem.bytes(memA, n), lc = this.mem.lc.subarray(lcA - LC_BASE, lcA - LC_BASE + n);
        if (toCache) lc.set(ram); else ram.set(lc);
        this.spr[SPR_DMAL] = l & ~3;
    }

    // ---------------------------------------------------------------- FPU
    private lfs(d: number, a: number) {
        const w = this.ps0w, w1 = this.ps1w;
        singleToDoubleBits(this.mem.r32(a), w, d * 2); w1[d * 2] = w[d * 2]; w1[d * 2 + 1] = w[d * 2 + 1];
    }
    private fpRc(ins: number) { if (ins & 1) this.setCRField(1, this.fpscr >>> 28); }
    private isNan(s: number) {
        const w = s & 32 ? this.ps1w : this.ps0w, i = (s & 31) * 2;
        return (w[i + 1] & 0x7FF00000) === 0x7FF00000 && ((w[i + 1] & 0x000FFFFF) | w[i]) !== 0;
    }
    /** A NaN result into lane `lane` of FPR d: the first NaN operand's bits, quieted, else the default QNaN.
     *  Operands are a register number (+ 32 for its ps1), or -1. */
    private nan(d: number, lane: number, single: boolean, s1: number, s2: number, s3: number) {
        let hi = 0x7FF80000, lo = 0;
        const s = s1 >= 0 && this.isNan(s1) ? s1 : s2 >= 0 && this.isNan(s2) ? s2 : s3 >= 0 && this.isNan(s3) ? s3 : -1;
        if (s >= 0) { const w = s & 32 ? this.ps1w : this.ps0w, i = (s & 31) * 2; hi = (w[i + 1] | 0x00080000) >>> 0; lo = w[i]; }
        if (single) lo = (lo & 0xE0000000) >>> 0;
        const o = lane ? this.ps1w : this.ps0w;
        o[d * 2] = lo; o[d * 2 + 1] = hi;
    }
    /** a double result (v) of operands a, b, c */
    private resD(d: number, v: number, a: number, b: number, c: number) {
        if (v !== v) return this.nan(d, 0, false, a, b, c);
        if (this.ni && v < MIN_NORMAL_F64 && v > -MIN_NORMAL_F64) v *= 0;
        this.ps0[d] = v;
    }
    /** a single result into both lanes: v is the value before its rounding to single */
    private resS(d: number, v: number, a: number, b: number, c: number) {
        if (v !== v) { this.nan(d, 0, true, a, b, c); this.ps1w[d * 2] = this.ps0w[d * 2]; this.ps1w[d * 2 + 1] = this.ps0w[d * 2 + 1]; return; }
        const r = this.ni && v < MIN_NORMAL_F32 && v > -MIN_NORMAL_F32 ? v * 0 : fr(v);
        this.ps0[d] = r; this.ps1[d] = r;
    }
    /** one lane of a paired-single result */
    private resL(d: number, lane: number, v: number, a: number, b: number, c: number) {
        if (v !== v) return this.nan(d, lane, true, a, b, c);
        const r = this.ni && v < MIN_NORMAL_F32 && v > -MIN_NORMAL_F32 ? v * 0 : fr(v);
        if (lane) this.ps1[d] = r; else this.ps0[d] = r;
    }
    /** a * c + b (c with 25 bits) rounded once to single, flushed under NI: fmadds' value before any negation */
    private madds(a: number, c: number, b: number) {
        const r = fmaS(a, force25(c), b);
        return this.ni && r <= MIN_NORMAL_F32 && r >= -MIN_NORMAL_F32 ? flushS(a, force25(c), b, r) : r;
    }

    /** 59: single precision */
    private op59(ins: number) {
        const d = (ins >>> 21) & 31, a = (ins >>> 16) & 31, b = (ins >>> 11) & 31, c = (ins >>> 6) & 31;
        const A = this.ps0[a], B = this.ps0[b], C = this.ps0[c];
        switch ((ins >>> 1) & 31) {
            case 18: this.resS(d, A / B, a, b, -1); break;
            case 20: this.resS(d, A - B, a, b, -1); break;
            case 21: this.resS(d, A + B, a, b, -1); break;
            case 25: this.resS(d, A * force25(C), a, -1, c); break;
            case 24: this.resS(d, fres(B), b, -1, -1); break;
            case 29: this.resS(d, this.madds(A, C, B), a, b, c); break;   // fmadds
            case 28: this.resS(d, this.madds(A, C, -B), a, b, c); break;   // fmsubs
            case 31: { const r = this.madds(A, C, B); this.resS(d, r === r ? -r : r, a, b, c); break; }   // fnmadds
            case 30: { const r = this.madds(A, C, -B); this.resS(d, r === r ? -r : r, a, b, c); break; }   // fnmsubs
            default: throw new Unimpl(`op59 xo ${(ins >>> 1) & 31}`);
        }
        this.fpRc(ins);
    }

    /** 63: double precision and FPU control */
    private op63(ins: number) {
        const d = (ins >>> 21) & 31, a = (ins >>> 16) & 31, b = (ins >>> 11) & 31, c = (ins >>> 6) & 31;
        const w = this.ps0w;
        if (ins & 0x20) {   // the A forms
            const A = this.ps0[a], B = this.ps0[b], C = this.ps0[c];
            switch ((ins >>> 1) & 31) {
                case 18: this.resD(d, A / B, a, b, -1); break;
                case 20: this.resD(d, A - B, a, b, -1); break;
                case 21: this.resD(d, A + B, a, b, -1); break;
                case 25: this.resD(d, A * C, a, -1, c); break;
                case 29: this.resD(d, fmaD(A, C, B), a, b, c); break;   // fmadd
                case 28: this.resD(d, fmaD(A, C, -B), a, b, c); break;   // fmsub
                case 31: { const r = fmaD(A, C, B); this.resD(d, r === r ? -r : r, a, b, c); break; }   // fnmadd
                case 30: { const r = fmaD(A, C, -B); this.resD(d, r === r ? -r : r, a, b, c); break; }   // fnmsub
                case 23: { const s = A >= 0 ? c : b; w[d * 2] = w[s * 2]; w[d * 2 + 1] = w[s * 2 + 1]; break; }   // fsel (a NaN selects frB)
                case 26: this.resD(d, frsqrte(B), b, -1, -1); break;
                default: throw new Unimpl(`op63 xo ${(ins >>> 1) & 31}`);
            }
            return this.fpRc(ins);
        }
        const B = this.ps0[b];
        switch ((ins >>> 1) & 0x3FF) {
            case 72: w[d * 2] = w[b * 2]; w[d * 2 + 1] = w[b * 2 + 1]; break;   // fmr
            case 40: w[d * 2] = w[b * 2]; w[d * 2 + 1] = (w[b * 2 + 1] ^ 0x80000000) >>> 0; break;   // fneg
            case 264: w[d * 2] = w[b * 2]; w[d * 2 + 1] = w[b * 2 + 1] & 0x7FFFFFFF; break;   // fabs
            case 136: w[d * 2] = w[b * 2]; w[d * 2 + 1] = (w[b * 2 + 1] | 0x80000000) >>> 0; break;   // fnabs
            case 12: this.resS(d, B, b, -1, -1); break;   // frsp
            case 14: case 15: {   // fctiw, fctiwz
                let r: number;
                if (B !== B) r = 0x80000000;
                else if (B > 2147483647) r = 0x7FFFFFFF;
                else if (B < -2147483648) r = 0x80000000;
                else if (((ins >>> 1) & 0x3FF) === 15) r = Math.trunc(B);
                else { const t = B + 0.5; r = Math.floor(t); if (t - r === 0) r &= ~1; }
                w[d * 2] = r >>> 0;
                w[d * 2 + 1] = (r | 0) === 0 && (B < 0 || Object.is(B, -0)) ? 0xFFF80001 : 0xFFF80000;
                break;
            }
            case 0: case 32: {   // fcmpu, fcmpo
                const A = this.ps0[a], f = A !== A || B !== B ? 1 : A < B ? 8 : A > B ? 4 : 2;
                this.setCRField(d >>> 2, f); this.fpscr = ((this.fpscr & ~0xF000) | (f << 12)) >>> 0;
                return;
            }
            case 583: w[d * 2] = this.fpscr; w[d * 2 + 1] = 0xFFF80000; break;   // mffs
            case 711: {   // mtfsf
                const fm = (ins >>> 17) & 0xFF;
                let mk = 0;
                for (let i = 0; i < 8; i++) if (fm & (0x80 >>> i)) mk |= 0xF0000000 >>> (i * 4);
                this.setFpscr((this.fpscr & ~mk) | (w[b * 2] & mk)); break;
            }
            case 134: { const s = 28 - 4 * (d >>> 2); this.setFpscr((this.fpscr & ~(0xF << s)) | (((ins >>> 12) & 0xF) << s)); break; }   // mtfsfi
            case 38: this.setFpscr(this.fpscr | (0x80000000 >>> d)); break;   // mtfsb1
            case 70: this.setFpscr(this.fpscr & ~(0x80000000 >>> d)); break;   // mtfsb0
            case 64: this.setCRField(d >>> 2, this.fpscr >>> (28 - 4 * (a >>> 2))); return;   // mcrfs
            default: throw new Unimpl(`op63 xo ${(ins >>> 1) & 0x3FF}`);
        }
        this.fpRc(ins);
    }

    // ---------------------------------------------------------------- paired singles (opcode 4)
    private op4(ins: number) {
        const d = (ins >>> 21) & 31, a = (ins >>> 16) & 31, b = (ins >>> 11) & 31, c = (ins >>> 6) & 31;
        const P0 = this.ps0, P1 = this.ps1, w0 = this.ps0w, w1 = this.ps1w, g = this.gpr;
        if ((PS_AFORM >>> ((ins >>> 1) & 31)) & 1) {
            const a0 = P0[a], a1 = P1[a], b0 = P0[b], b1 = P1[b], c0 = P0[c], c1 = P1[c];
            const A1 = a | 32, B1 = b | 32, C1 = c | 32;
            switch ((ins >>> 1) & 31) {
                case 21: this.resL(d, 0, a0 + b0, a, b, -1); this.resL(d, 1, a1 + b1, A1, B1, -1); break;   // ps_add
                case 20: this.resL(d, 0, a0 - b0, a, b, -1); this.resL(d, 1, a1 - b1, A1, B1, -1); break;   // ps_sub
                case 18: this.resL(d, 0, a0 / b0, a, b, -1); this.resL(d, 1, a1 / b1, A1, B1, -1); break;   // ps_div
                case 25: this.resL(d, 0, a0 * force25(c0), a, -1, c); this.resL(d, 1, a1 * force25(c1), A1, -1, C1); break;   // ps_mul
                case 12: this.resL(d, 0, a0 * force25(c0), a, -1, c); this.resL(d, 1, a1 * trunc25(c0), A1, -1, c); break;   // ps_muls0
                case 13: this.resL(d, 0, a0 * force25(c1), a, -1, C1); this.resL(d, 1, a1 * force25(c1), A1, -1, C1); break;   // ps_muls1
                case 29: { const x = this.madds(a0, c0, b0), y = this.madds(a1, c1, b1); this.resL(d, 0, x, a, b, c); this.resL(d, 1, y, A1, B1, C1); break; }   // ps_madd
                case 28: { const x = this.madds(a0, c0, -b0), y = this.madds(a1, c1, -b1); this.resL(d, 0, x, a, b, c); this.resL(d, 1, y, A1, B1, C1); break; }   // ps_msub
                case 31: { const x = this.madds(a0, c0, b0), y = this.madds(a1, c1, b1); this.resL(d, 0, x === x ? -x : x, a, b, c); this.resL(d, 1, y === y ? -y : y, A1, B1, C1); break; }   // ps_nmadd
                case 30: { const x = this.madds(a0, c0, -b0), y = this.madds(a1, c1, -b1); this.resL(d, 0, x === x ? -x : x, a, b, c); this.resL(d, 1, y === y ? -y : y, A1, B1, C1); break; }   // ps_nmsub
                case 14: { const x = this.madds(a0, c0, b0), y = this.madds(a1, trunc25(c0), b1); this.resL(d, 0, x, a, b, c); this.resL(d, 1, y, A1, B1, c); break; }   // ps_madds0
                case 15: { const x = this.madds(a0, c1, b0), y = this.madds(a1, c1, b1); this.resL(d, 0, x, a, b, C1); this.resL(d, 1, y, A1, B1, C1); break; }   // ps_madds1
                case 10: this.resL(d, 0, a0 + b1, a, B1, -1); this.resL(d, 1, c1, C1, -1, -1); break;   // ps_sum0
                case 11: this.resL(d, 1, a0 + b1, a, B1, -1); this.resL(d, 0, c0, c, -1, -1); break;   // ps_sum1
                case 24: this.resL(d, 0, fres(b0), b, -1, -1); this.resL(d, 1, fres(b1), B1, -1, -1); break;   // ps_res
                case 26: this.resL(d, 0, frsqrte(b0), b, -1, -1); this.resL(d, 1, frsqrte(b1), B1, -1, -1); break;   // ps_rsqrte
                case 23: {   // ps_sel
                    const s0 = a0 >= 0 ? c : b, s1 = a1 >= 0 ? c : b;
                    const l0 = w0[s0 * 2], h0 = w0[s0 * 2 + 1], l1 = w1[s1 * 2], h1 = w1[s1 * 2 + 1];
                    w0[d * 2] = l0; w0[d * 2 + 1] = h0; w1[d * 2] = l1; w1[d * 2 + 1] = h1; break;
                }
                default: throw new Unimpl(`ps xo ${(ins >>> 1) & 31}`);
            }
            return this.fpRc(ins);
        }
        const xo = (ins >>> 1) & 0x3FF;
        switch (xo & 0x3F) {   // psq_lx, psq_stx, psq_lux, psq_stux
            case 6: return this.psqLoad(d, ((a ? g[a] : 0) + g[b]) >>> 0, (ins >>> 10) & 1, (ins >>> 7) & 7);
            case 7: return this.psqStore(d, ((a ? g[a] : 0) + g[b]) >>> 0, (ins >>> 10) & 1, (ins >>> 7) & 7);
            case 38: { const e = (g[a] + g[b]) >>> 0; this.psqLoad(d, e, (ins >>> 10) & 1, (ins >>> 7) & 7); g[a] = e; return; }
            case 39: { const e = (g[a] + g[b]) >>> 0; this.psqStore(d, e, (ins >>> 10) & 1, (ins >>> 7) & 7); g[a] = e; return; }
        }
        switch (xo) {
            case 72: { const l0 = w0[b * 2], h0 = w0[b * 2 + 1], l1 = w1[b * 2], h1 = w1[b * 2 + 1]; w0[d * 2] = l0; w0[d * 2 + 1] = h0; w1[d * 2] = l1; w1[d * 2 + 1] = h1; break; }   // ps_mr
            case 40: { const l0 = w0[b * 2], h0 = w0[b * 2 + 1], l1 = w1[b * 2], h1 = w1[b * 2 + 1]; w0[d * 2] = l0; w0[d * 2 + 1] = (h0 ^ 0x80000000) >>> 0; w1[d * 2] = l1; w1[d * 2 + 1] = (h1 ^ 0x80000000) >>> 0; break; }   // ps_neg
            case 264: { const l0 = w0[b * 2], h0 = w0[b * 2 + 1], l1 = w1[b * 2], h1 = w1[b * 2 + 1]; w0[d * 2] = l0; w0[d * 2 + 1] = h0 & 0x7FFFFFFF; w1[d * 2] = l1; w1[d * 2 + 1] = h1 & 0x7FFFFFFF; break; }   // ps_abs
            case 136: { const l0 = w0[b * 2], h0 = w0[b * 2 + 1], l1 = w1[b * 2], h1 = w1[b * 2 + 1]; w0[d * 2] = l0; w0[d * 2 + 1] = (h0 | 0x80000000) >>> 0; w1[d * 2] = l1; w1[d * 2 + 1] = (h1 | 0x80000000) >>> 0; break; }   // ps_nabs
            case 528: { const l0 = w0[a * 2], h0 = w0[a * 2 + 1], l1 = w0[b * 2], h1 = w0[b * 2 + 1]; w0[d * 2] = l0; w0[d * 2 + 1] = h0; w1[d * 2] = l1; w1[d * 2 + 1] = h1; break; }   // ps_merge00
            case 560: { const l0 = w0[a * 2], h0 = w0[a * 2 + 1], l1 = w1[b * 2], h1 = w1[b * 2 + 1]; w0[d * 2] = l0; w0[d * 2 + 1] = h0; w1[d * 2] = l1; w1[d * 2 + 1] = h1; break; }   // ps_merge01
            case 592: { const l0 = w1[a * 2], h0 = w1[a * 2 + 1], l1 = w0[b * 2], h1 = w0[b * 2 + 1]; w0[d * 2] = l0; w0[d * 2 + 1] = h0; w1[d * 2] = l1; w1[d * 2 + 1] = h1; break; }   // ps_merge10
            case 624: { const l0 = w1[a * 2], h0 = w1[a * 2 + 1], l1 = w1[b * 2], h1 = w1[b * 2 + 1]; w0[d * 2] = l0; w0[d * 2 + 1] = h0; w1[d * 2] = l1; w1[d * 2 + 1] = h1; break; }   // ps_merge11
            case 0: case 32: { const x = P0[a], y = P0[b]; this.setCRField(d >>> 2, x !== x || y !== y ? 1 : x < y ? 8 : x > y ? 4 : 2); return; }   // ps_cmpu0, ps_cmpo0
            case 64: case 96: { const x = P1[a], y = P1[b]; this.setCRField(d >>> 2, x !== x || y !== y ? 1 : x < y ? 8 : x > y ? 4 : 2); return; }   // ps_cmpu1, ps_cmpo1
            case 1014: { const e = (((a ? g[a] : 0) + g[b]) & ~31) >>> 0; for (let i = 0; i < 32; i += 4) this.mem.w32(e + i, 0); return; }   // dcbz_l
            default: throw new Unimpl(`ps xo ${xo} (0x${(ins >>> 0).toString(16)})`);
        }
        this.fpRc(ins);
    }
    private psqLoad(d: number, ea: number, w: number, i: number) {
        const q = this.gqr[i], type = (q >>> 16) & 7, m = this.mem;
        if (type < 4) {   // floats
            singleToDoubleBits(m.r32(ea), this.ps0w, d * 2);
            if (w) this.ps1[d] = 1; else singleToDoubleBits(m.r32(ea + 4), this.ps1w, d * 2);
            return;
        }
        const s = DEQUANT[(q >>> 24) & 0x3F];
        let x: number, y = 1;
        switch (type) {
            case 4: x = m.r8(ea) * s; if (!w) y = m.r8(ea + 1) * s; break;
            case 5: x = m.r16(ea) * s; if (!w) y = m.r16(ea + 2) * s; break;
            case 6: x = ((m.r8(ea) << 24) >> 24) * s; if (!w) y = ((m.r8(ea + 1) << 24) >> 24) * s; break;
            default: x = ((m.r16(ea) << 16) >> 16) * s; if (!w) y = ((m.r16(ea + 2) << 16) >> 16) * s; break;
        }
        this.ps0[d] = fr(x); this.ps1[d] = fr(y);
    }
    private psqStore(d: number, ea: number, w: number, i: number) {
        const q = this.gqr[i], type = q & 7, m = this.mem;
        if (type < 4) {   // floats (denormals are stored as zero)
            m.w32(ea, doubleToSingleBitsFtz(this.ps0w[d * 2 + 1], this.ps0w[d * 2]));
            if (!w) m.w32(ea + 4, doubleToSingleBitsFtz(this.ps1w[d * 2 + 1], this.ps1w[d * 2]));
            return;
        }
        const s = QUANT[(q >>> 8) & 0x3F];
        const x = fr(fr(this.ps0[d]) * s), y = fr(fr(this.ps1[d]) * s);
        switch (type) {
            case 4: m.w8(ea, qclamp(x, 0, 255)); if (!w) m.w8(ea + 1, qclamp(y, 0, 255)); break;
            case 5: m.w16(ea, qclamp(x, 0, 65535)); if (!w) m.w16(ea + 2, qclamp(y, 0, 65535)); break;
            case 6: m.w8(ea, qclamp(x, -128, 127) & 0xFF); if (!w) m.w8(ea + 1, qclamp(y, -128, 127) & 0xFF); break;
            default: m.w16(ea, qclamp(x, -32768, 32767) & 0xFFFF); if (!w) m.w16(ea + 2, qclamp(y, -32768, 32767) & 0xFFFF); break;
        }
    }
}

// ---------------------------------------------------------------- helpers
/** the paired-single A forms' 5-bit XOs: 10-15, 18, 20, 21, 23-26, 28-31 (22 is dcbz_l's low bits) */
const PS_AFORM = [10, 11, 12, 13, 14, 15, 18, 20, 21, 23, 24, 25, 26, 28, 29, 30, 31].reduce((m, x) => m | (1 << x), 0) >>> 0;
const rotl = (v: number, n: number) => (v << n) | (v >>> (32 - n));
/** the rlw* masks by (mb << 5 | me) */
const MASK = new Uint32Array(1024);
for (let mb = 0; mb < 32; mb++) for (let me = 0; me < 32; me++) {
    const a = 0xFFFFFFFF >>> mb, b = me === 31 ? 0xFFFFFFFF : ~(0xFFFFFFFF >>> (me + 1));
    MASK[(mb << 5) | me] = mb <= me ? a & b : a | b;
}
/** the carry out of a + b + c (a, b unsigned 32-bit; c 0 or 1) */
const carry = (a: number, b: number, c: number) => (a + b + c > 0xFFFFFFFF ? 1 : 0);
const bswap32 = (v: number) => (((v & 0xFF) << 24) | ((v & 0xFF00) << 8) | ((v >>> 8) & 0xFF00) | (v >>> 24)) >>> 0;
const bswap16 = (v: number) => ((v & 0xFF) << 8) | ((v >>> 8) & 0xFF);
function trapCond(to: number, a: number, b: number) {
    return ((to & 16) && a < b) || ((to & 8) && a > b) || ((to & 4) && a === b) || ((to & 2) && (a >>> 0) < (b >>> 0)) || ((to & 1) && (a >>> 0) > (b >>> 0));
}
/** the high word of a signed 32 x 32 product: with a = ah 2^16 + al, b = bh 2^16 + bl (al, bl unsigned),
 *  ah bh + floor((ah bl + al bh + floor(al bl / 2^16)) / 2^16); every term is exact in a double */
function mulhw(a: number, b: number) {
    const al = a & 0xFFFF, ah = a >> 16, bl = b & 0xFFFF, bh = b >> 16;
    return (ah * bh + Math.floor((ah * bl + al * bh + Math.floor((al * bl) / 65536)) / 65536)) | 0;
}
function mulhwu(a: number, b: number) {
    const al = a & 0xFFFF, ah = a >>> 16, bl = b & 0xFFFF, bh = b >>> 16;
    return (ah * bh + Math.floor((ah * bl + al * bh + Math.floor((al * bl) / 65536)) / 65536)) >>> 0;
}
/** psq_st's float conversion: as stfs, but a denormal becomes zero */
function doubleToSingleBitsFtz(hi: number, lo: number): number {
    const exp = (hi >>> 20) & 0x7FF;
    if (exp > 896 || ((hi & 0x7FFFFFFF) | lo) === 0) return ((hi & 0xC0000000) | (((hi & 0x07FFFFFF) << 3) | (lo >>> 29))) >>> 0;
    return (hi & 0x80000000) >>> 0;
}
/** the (de)quantisation scales by GQR's 6-bit scale field: 2^-s and 2^s for s < 32, 2^(64-s) and 2^(s-64) from 32 */
const DEQUANT = new Float32Array(64), QUANT = new Float32Array(64);
for (let s = 0; s < 64; s++) { const e = s < 32 ? s : s - 64; DEQUANT[s] = 2 ** -e; QUANT[s] = 2 ** e; }
const qclamp = (v: number, lo: number, hi: number) => (v !== v ? 0 : v <= lo ? lo : v >= hi ? hi : Math.trunc(v));
/** a fused single result under NI: zero (keeping the sign) if the value before the rounding to single was below the smallest normal */
function flushS(a: number, c: number, b: number, r: number) {
    const dbl = fmaD(a, c, b);
    return dbl < MIN_NORMAL_F32 && dbl > -MIN_NORMAL_F32 ? dbl * 0 : r;
}
