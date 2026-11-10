// v3: straight runs of the game's code compiled to WebAssembly. A block is the instructions from an
// address to the first unconditional branch (conditional branches leave it early), compiled into one
// function. The interpreter (cpu.ts) stays the definition: a block does exactly what the interpreter
// would for the same instructions, and everything rare, anything that touches hardware and most of the
// floating-point core go through the interpreter's own methods (imported functions).
//
// Time is the instruction count, so a block only runs when all of it fits before the next event
// (the CPU's limit); where an instruction leaves the fast path (a hardware register, an exception)
// the count and PC are made exact first and the block is left if anything changed.
//
// RAM, the registers and the block tables live in one WebAssembly memory (mem.ts has the layout), so
// the interpreter and the blocks work on the same state with no copying. The dispatcher (the loop
// that looks the PC's block up and calls it) is a small WebAssembly module of its own.
import { MEM1_SIZE, CODE_SPAN, BMAP, BLEN, STATE, WASM_BYTES } from './mem.js';

// ---- the registers' places in memory (cpu.ts reads them through typed-array views)
export const GPR = STATE, PS0 = STATE + 0x80, PS1 = STATE + 0x180;
export const COUNT = STATE + 0x280, LIMIT = STATE + 0x288, B0 = STATE + 0x290;
export const REGS = STATE + 0x2A0, GQRS = STATE + 0x2E0;
/** the write-gather pipe: the bytes waiting for a burst of 32 (hw.ts), and how many */
export const PIPE_LEN = STATE + 0x300, PIPE = STATE + 0x340;
export const R_PC = 0, R_LR = 1, R_CTR = 2, R_CR = 3, R_MSR = 4, R_XERCA = 5, R_XERSO = 6, R_INTR = 7, R_BRK = 8, R_FPSCR = 9;
const PC = REGS + 4 * R_PC, LR = REGS + 4 * R_LR, CTR = REGS + 4 * R_CTR, CR = REGS + 4 * R_CR, MSR = REGS + 4 * R_MSR,
    XERCA = REGS + 4 * R_XERCA, XERSO = REGS + 4 * R_XERSO, INTR = REGS + 4 * R_INTR, BRK = REGS + 4 * R_BRK, FPSCR = REGS + 4 * R_FPSCR;

/** the functions a block imports, in this order */
export const IMPORTS = ['fb', 'pure', 'op59', 'op63', 'op4', 'fpx', 'lfsSlow', 'stfsSlow', 'resS', 'resD', 'resL', 'lfsLane', 'pipeFull'] as const;
const F_FB = 0, F_PURE = 1, F_OP59 = 2, F_OP63 = 3, F_OP4 = 4, F_FPX = 5, F_LFS = 6, F_STFS = 7, F_RESS = 8, F_RESD = 9, F_RESL = 10, F_LFSLANE = 11, F_PIPE = 12;
// (their types: indexes into TYPES)
const IMPORT_TYPES = [1, 2, 3, 3, 3, 2, 2, 4, 5, 5, 7, 8, 9];
const I32 = 0x7F, I64 = 0x7E, F64 = 0x7C;
const TYPES: [number[], number[]][] = [
    [[], []], [[I32, I32, I32, I32], [I32]], [[I32, I32], []], [[I32], []], [[I32], [I32]], [[I32, F64, I32, I32, I32], []], [[], [I32]],
    [[I32, I32, F64, I32, I32, I32], []], [[I32, I32, I32], []], [[I32, I32], [I32]],
];

const MAXLEN = 64;
const MASK = new Int32Array(1024);
for (let mb = 0; mb < 32; mb++) for (let me = 0; me < 32; me++) {
    const a = 0xFFFFFFFF >>> mb, b = me === 31 ? 0xFFFFFFFF : ~(0xFFFFFFFF >>> (me + 1));
    MASK[(mb << 5) | me] = mb <= me ? a & b : a | b;
}
const MIN_NORMAL_F32 = 1.1754943508222875e-38, MIN_NORMAL_F64 = 2.2250738585072014e-308;

// ---------------------------------------------------------------- a small assembler
const f64buf = new Float64Array(1), f64bytes = new Uint8Array(f64buf.buffer);
class Asm {
    b: number[] = [];
    /** open if / else constructs (a branch to the block's loop goes out through them) */
    nest = 0;
    u(v: number) { v >>>= 0; do { let x = v & 0x7F; v >>>= 7; if (v) x |= 0x80; this.b.push(x); } while (v); return this; }
    private sleb(v: number) { v |= 0; for (;;) { const x = v & 0x7F; v >>= 7; if ((v === 0 && !(x & 0x40)) || (v === -1 && (x & 0x40))) { this.b.push(x); return; } this.b.push(x | 0x80); } }
    op(...c: number[]) { for (const x of c) this.b.push(x); return this; }
    c(v: number) { this.b.push(0x41); this.sleb(v); return this; }
    c64(v: bigint) {
        this.b.push(0x42); v = BigInt.asIntN(64, v);
        for (;;) { const x = Number(v & 0x7Fn); v >>= 7n; if ((v === 0n && !(x & 0x40)) || (v === -1n && (x & 0x40))) { this.b.push(x); return this; } this.b.push(x | 0x80); }
    }
    cf(v: number) { f64buf[0] = v; this.b.push(0x44, ...f64bytes); return this; }
    get(i: number) { this.b.push(0x20, i); return this; }
    set(i: number) { this.b.push(0x21, i); return this; }
    tee(i: number) { this.b.push(0x22, i); return this; }
    /** the 32-bit value at a constant address */
    k32(addr: number) { this.b.push(0x41, 0, 0x28, 2); return this.u(addr); }
    k64(addr: number) { this.b.push(0x41, 0, 0x29, 3); return this.u(addr); }
    kf(addr: number) { this.b.push(0x41, 0, 0x2B, 3); return this.u(addr); }
    /** a store to a constant address: value() leaves the value on the stack */
    s32(addr: number, value: () => unknown) { this.b.push(0x41, 0); value(); this.b.push(0x36, 2); return this.u(addr); }
    s64(addr: number, value: () => unknown) { this.b.push(0x41, 0); value(); this.b.push(0x37, 3); return this.u(addr); }
    sf(addr: number, value: () => unknown) { this.b.push(0x41, 0); value(); this.b.push(0x39, 3); return this.u(addr); }
    if_() { this.b.push(0x04, 0x40); this.nest++; return this; }
    /** an if that leaves an i32 */
    ifv() { this.b.push(0x04, I32); this.nest++; return this; }
    else_() { this.b.push(0x05); return this; }
    end() { this.b.push(0x0B); this.nest--; return this; }
    ret() { this.b.push(0x0F); return this; }
    call(f: number) { this.b.push(0x10); return this.u(f); }
}
// opcodes
const ADD = 0x6A, SUB = 0x6B, MUL = 0x6C, AND = 0x71, OR = 0x72, XOR = 0x73, SHL = 0x74, SHR_S = 0x75, SHR_U = 0x76, ROTL = 0x77, ROTR = 0x78, CLZ = 0x67,
    EQZ = 0x45, EQ = 0x46, NE = 0x47, LT_S = 0x48, LT_U = 0x49, GT_S = 0x4A, GT_U = 0x4B, SELECT = 0x1B,
    WRAP = 0xA7, EXT_S = 0xAC, EXT_U = 0xAD, ADD64 = 0x7C, MUL64 = 0x7E, AND64 = 0x83, XOR64 = 0x85, SHL64 = 0x86, SHRS64 = 0x87, SHRU64 = 0x88, EQZ64 = 0x50,
    FADD = 0xA0, FSUB = 0xA1, FMUL = 0xA2, FDIV = 0xA3, FABS = 0x99, FEQ = 0x61, FNE = 0x62, FLT = 0x63, FGT = 0x64, FGE = 0x66, OR64 = 0x84;
// locals
const A = 0, O = 1, X = 2, Y = 3, V = 4, T = 5, T2 = 6, FX = 7, FY = 8;

function section(id: number, body: number[]) { return [id, ...new Asm().u(body.length).b, ...body]; }
function vec(items: number[][]) { return new Asm().u(items.length).b.concat(...items); }
function str(s: string) { return [s.length, ...[...s].map((ch) => ch.charCodeAt(0))]; }
const HEADER = [0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00];
const typeSection = () => section(1, vec(TYPES.map(([p, r]) => [0x60, p.length, ...p, r.length, ...r])));
const memImport = () => [...str('e'), ...str('m'), 0x02, 0x00, ...new Asm().u(WASM_BYTES >>> 16).b];

// ---------------------------------------------------------------- the dispatcher
/**
 * The module that runs blocks one after another: exports run(), which returns
 * 1 the limit was reached or brk is set, 2 an interrupt is due, 3 the PC has no block (or a hook),
 * 4 the PC's block doesn't fit before the limit.
 */
export function dispatcherModule(): Uint8Array {
    const a = new Asm();
    const out = (code: number) => { a.if_().c(code).ret().end(); };
    a.op(0x03, 0x40);   // loop
    a.kf(COUNT).kf(LIMIT).op(FGE); out(1);
    a.k32(BRK); out(1);
    a.k32(INTR).if_().k32(MSR).c(0x8000).op(AND); out(2); a.end();
    a.k32(PC).c(0x80000000 | 0).op(XOR).tee(0).c(CODE_SPAN).op(0x4F /* ge_u */); out(3);
    a.get(0).c(-4).op(AND).op(0x28, 2).u(BMAP).tee(1).c(1).op(LT_S); out(3);
    a.kf(COUNT).get(1).c(2).op(SHL).op(0x28, 2).u(BLEN).op(0xB8 /* f64.convert_i32_u */).op(FADD).kf(LIMIT).op(FGT); out(4);
    a.sf(B0, () => a.kf(COUNT));
    a.get(1).op(0x11, 0, 0);   // call_indirect (type 0) (table 0)
    a.op(0x0C, 0);   // br: around again
    a.op(0x0B);   // end loop
    a.op(0x00);   // unreachable (the loop only leaves by returning)
    const body = [1, 2, I32, ...a.b, 0x0B];
    const imports = vec([memImport(), [...str('e'), ...str('t'), 0x01, 0x70, 0x00, 1]]);
    return Uint8Array.from([...HEADER, ...typeSection(), ...section(2, imports), ...section(3, vec([[6]])),
        ...section(7, vec([[...str('run'), 0x00, 0]])), ...section(10, vec([[...new Asm().u(body.length).b, ...body]]))]);
}

// ---------------------------------------------------------------- blocks
export interface BlockCode {
    pc: number; n: number; words: Uint32Array;
    /** the function's body (locals and code) */
    body: number[];
    /** where control can go from here (branch targets, the address after the block or after its call) */
    next: number[];
}

/** One module of several blocks: its exports b0, b1, ... are the blocks' functions. */
export function blocksModule(blocks: BlockCode[]): Uint8Array {
    if (!MODULE_HEAD) {
        const imports = vec([memImport(), ...IMPORTS.map((n, i) => [...str('e'), ...str(n), 0x00, IMPORT_TYPES[i]])]);
        MODULE_HEAD = Uint8Array.from([...HEADER, ...typeSection(), ...section(2, imports)]);
    }
    const funcs = section(3, vec(blocks.map(() => [0])));
    const exports = section(7, vec(blocks.map((_b, i) => [...str('b' + i), 0x00, ...new Asm().u(IMPORTS.length + i).b])));
    let codeLen = uleb(blocks.length).length;
    for (const b of blocks) codeLen += uleb(b.body.length).length + b.body.length;
    const sizeLeb = uleb(codeLen);
    const out = new Uint8Array(MODULE_HEAD.length + funcs.length + exports.length + 1 + sizeLeb.length + codeLen);
    let p = 0;
    out.set(MODULE_HEAD, p); p += MODULE_HEAD.length;
    out.set(funcs, p); p += funcs.length;
    out.set(exports, p); p += exports.length;
    out[p++] = 10; out.set(sizeLeb, p); p += sizeLeb.length;
    const n = uleb(blocks.length); out.set(n, p); p += n.length;
    for (const b of blocks) { const l = uleb(b.body.length); out.set(l, p); p += l.length; out.set(b.body, p); p += b.body.length; }
    return out;
}
let MODULE_HEAD: Uint8Array | null = null;
const uleb = (v: number) => new Asm().u(v).b;

export function compileBlock(dv: DataView, pc0: number, hooked: (pc: number) => boolean): BlockCode | null {
    pc0 >>>= 0;
    // ---- which instructions: to the first unconditional branch (or a hook, or the length limit)
    const words: number[] = [], next: number[] = [];
    let loops = false, open = true;
    for (let pc = pc0; words.length < MAXLEN; pc = (pc + 4) >>> 0) {
        const o = (pc ^ 0x80000000) >>> 0;
        if (o >= CODE_SPAN - 3 || (words.length > 0 && hooked(pc))) break;
        const ins = dv.getUint32(o), op = ins >>> 26, bo = (ins >>> 21) & 31;
        words.push(ins);
        if (op === 18) {
            const li = (ins & 0x03FFFFFC) << 6 >> 6, target = (ins & 2 ? li : pc + li) >>> 0;
            if (ins & 1) next.push(target, (pc + 4) >>> 0); else if (target === pc0) loops = true; else next.push(target);
            open = false; break;
        }
        if (op === 16) {
            const bd = (ins & 0xFFFC) << 16 >> 16, target = (ins & 2 ? bd : pc + bd) >>> 0;
            if (ins & 1) next.push(target, (pc + 4) >>> 0); else if (target === pc0) loops = true; else next.push(target);
            if ((bo & 20) === 20) { open = false; break; }
        }
        if (op === 17) { open = false; break; }
        if (op === 19) {
            const xo = (ins >>> 1) & 0x3FF;
            if ((xo === 16 || xo === 528) && (ins & 1)) next.push((pc + 4) >>> 0);
            if (xo === 50 || (xo === 16 && (bo & 20) === 20) || (xo === 528 && (bo & 16))) { open = false; break; }
        }
        if (op === 31 && ((ins >>> 1) & 0x3FF) === 982) { open = false; break; }
    }
    const N = words.length;
    if (N === 0) return null;
    if (open) next.push((pc0 + 4 * N) >>> 0);

    const a = new Asm();
    let pc = pc0, k = 0, fpChecked = false, ended = false;
    const ldG = (r: number) => a.k32(GPR + 4 * r);
    const stG = (r: number, value: () => unknown) => a.s32(GPR + 4 * r, value);
    const setCount = () => a.sf(COUNT, () => a.kf(B0).cf(k + 1).op(FADD));
    /** leave the block after the current instruction, at the address target() pushes */
    const exit = (target: () => unknown) => { setCount(); a.s32(PC, target); a.ret(); };
    /** go to a constant address: around again when it is the block's own start */
    const jump = (target: number) => {
        if ((target >>> 0) !== pc0) return exit(() => a.c(target));
        a.sf(B0, () => a.kf(B0).cf(k + 1).op(FADD));
        a.kf(B0).cf(N).op(FADD).kf(LIMIT).op(0x65 /* f64.le */).op(0x0D).u(a.nest);   // br_if to the loop
        a.sf(COUNT, () => a.kf(B0)); a.s32(PC, () => a.c(pc0)); a.ret();
    };
    /** the instruction through the interpreter, exactly; leaves the block if it did anything but fall through */
    const viaInterp = (ins: number) => { a.c(ins).c(pc).c(k + 1).c(N).call(F_FB).if_().ret().end(); };
    /** the instruction through the interpreter, and out of the block whatever it did */
    const lastViaInterp = (ins: number) => { ended = true; a.c(ins).c(pc).c(k + 1).c(N).call(F_FB).op(0x1A).ret(); };
    /** the instruction through the interpreter where it can only change registers */
    const pure = (ins: number) => { a.c(ins).c(pc).call(F_PURE); };
    const fpCheck = () => {
        if (fpChecked) return;
        fpChecked = true;
        a.k32(MSR).c(0x2000).op(AND).op(EQZ).if_().c(pc).c(k + 1).call(F_FPX).ret().end();
    };
    /** CR field n from the comparison of locals X and Y */
    const crf = (n: number, signed: boolean) => {
        const sh = 28 - 4 * n;
        a.s32(CR, () => {
            a.k32(CR).c(~(0xF << sh)).op(AND);
            a.c(8).c(4).c(2).get(X).get(Y).op(signed ? GT_S : GT_U).op(SELECT).get(X).get(Y).op(signed ? LT_S : LT_U).op(SELECT);
            a.k32(XERSO).op(OR).c(sh).op(SHL).op(OR);
        });
    };
    const cr0 = (reg: number) => { ldG(reg).set(X); a.c(0).set(Y); crf(0, true); };
    const ea = (rA: number, imm: number) => () => { if (rA) ldG(rA).c(imm).op(ADD); else a.c(imm); };
    const eaU = (rA: number, imm: number) => () => { ldG(rA).c(imm).op(ADD); };
    const eax = (rA: number, rB: number) => () => { if (rA) { ldG(rA); ldG(rB).op(ADD); } else ldG(rB); };
    const eaxU = (rA: number, rB: number) => () => { ldG(rA); ldG(rB).op(ADD); };
    /** a memory instruction: fast() when the address (left in A, its RAM offset in O) is in RAM, else the interpreter */
    const memop = (ins: number, addr: () => void, lim: number, fast: () => void, pipe?: () => void) => {
        addr(); a.tee(A).c(0x80000000 | 0).op(XOR).tee(O).c(lim).op(LT_U).if_(); fast(); a.else_();
        if (pipe) { a.get(A).c(0xCC008000 | 0).op(EQ).if_(); pipe(); a.else_(); viaInterp(ins); a.end(); } else viaInterp(ins);
        a.end();
    };
    /** A store to the write-gather pipe: the bytes are appended (big-endian); a full pipe goes through the hardware model. */
    const toPipe = (size: number, value: () => unknown, rAupd = -1) => () => {
        const put = (v: () => unknown, off: number) => {
            if (size === 1) { a.get(Y); v(); a.op(0x3A, 0).u(PIPE + off); }
            else if (size === 2) { v(); a.set(V); a.get(Y).get(V).c(0xFF).op(AND).c(8).op(SHL).get(V).c(8).op(SHR_U).c(0xFF).op(AND).op(OR).op(0x3B, 0).u(PIPE + off); }
            else { v(); a.set(V); a.get(Y); bswapV(); a.op(0x36, 0).u(PIPE + off); }
        };
        value(); a.set(X);   // (before Y is taken: the value may use the scratch locals)
        a.k32(PIPE_LEN).set(Y);
        put(() => a.get(X), 0);
        a.s32(PIPE_LEN, () => a.get(Y).c(size).op(ADD));
        if (rAupd >= 0) upd(rAupd);
        a.get(Y).c(32 - size).op(0x4F /* ge_u */).if_();
        a.c(k + 1).c(N).call(F_PIPE).if_(); a.s32(PC, () => a.c(pc + 4)); a.ret(); a.end();
        a.end();
    };
    const bswapV = () => a.get(V).c(8).op(ROTL).c(0x00FF00FF).op(AND).get(V).c(8).op(ROTR).c(0xFF00FF00 | 0).op(AND).op(OR);
    /** the big-endian word at O + off */
    const be32 = (off = 0) => { a.get(O).op(0x28, 0).u(off).set(V); bswapV(); };
    const be16 = () => { a.get(O).op(0x2F, 0, 0).set(V); a.get(V).c(8).op(SHL).get(V).c(8).op(SHR_U).op(OR).c(0xFFFF).op(AND); };
    /** stores value() big-endian at O + off */
    const st32 = (value: () => unknown, off = 0) => { value(); a.set(V); a.get(O); bswapV(); a.op(0x36, 0).u(off); };
    const st16 = (value: () => unknown) => { value(); a.set(V); a.get(O).get(V).c(0xFF).op(AND).c(8).op(SHL).get(V).c(8).op(SHR_U).c(0xFF).op(AND).op(OR).op(0x3B, 0, 0); };
    const upd = (rA: number) => stG(rA, () => a.get(A));
    /** the condition of a conditional branch on the stack; false: it always branches */
    const cond = (bo: number, bi: number) => {
        let any = false;
        if (!(bo & 4)) { a.k32(CTR).c(1).op(SUB).set(X); a.s32(CTR, () => a.get(X)); a.get(X); if (bo & 2) a.op(EQZ); else a.c(0).op(NE); any = true; }
        if (!(bo & 16)) { a.k32(CR).c(1 << (31 - bi)).op(AND); if (bo & 8) a.c(0).op(NE); else a.op(EQZ); if (any) a.op(AND); any = true; }
        return any;
    };
    /** a 64-bit sum whose carry out goes to XER[CA] and low word to rD */
    const carry = (rD: number, sum: () => void) => { sum(); a.set(T); a.s32(XERCA, () => a.get(T).c64(32n).op(SHRU64).op(WRAP)); stG(rD, () => a.get(T).op(WRAP)); };
    const u64 = (r: number, inv = false) => { ldG(r); if (inv) a.c(-1).op(XOR); a.op(EXT_U); };
    const ps0 = (r: number) => PS0 + 8 * r, ps1 = (r: number) => PS1 + 8 * r;
    /** a single result FX of operands (a, b, c) into both lanes of d; the rare cases (NaN, below the smallest normal) through the interpreter */
    const resS = (d: number, ra: number, rb: number, rc: number) => {
        a.get(FX).op(FABS).cf(MIN_NORMAL_F32).op(FGE).get(FX).cf(0).op(FEQ).op(OR).if_();
        a.get(FX).op(0xB6, 0xBB).set(FX); a.sf(ps0(d), () => a.get(FX)); a.sf(ps1(d), () => a.get(FX));
        a.else_().c(d).get(FX).c(ra).c(rb).c(rc).call(F_RESS).end();
    };
    const resD = (d: number, ra: number, rb: number, rc: number) => {
        a.get(FX).op(FABS).cf(MIN_NORMAL_F64).op(FGE).get(FX).cf(0).op(FEQ).op(OR).if_();
        a.sf(ps0(d), () => a.get(FX));
        a.else_().c(d).get(FX).c(ra).c(rb).c(rc).call(F_RESD).end();
    };
    /** one lane of a paired-single result (the value in local f): as resS, for one lane */
    const resL = (d: number, lane: number, f: number, ra: number, rb: number, rc: number) => {
        a.get(f).op(FABS).cf(MIN_NORMAL_F32).op(FGE).get(f).cf(0).op(FEQ).op(OR).if_();
        a.sf(lane ? ps1(d) : ps0(d), () => a.get(f).op(0xB6, 0xBB));
        a.else_().c(d).c(lane).get(f).c(ra).c(rb).c(rc).call(F_RESL).end();
    };
    /** the single whose bits are at O + off, into a lane of FPR d (lfs's conversion) */
    const loadLane = (d: number, lane: number, off: number) => {
        be32(off); a.set(X);
        a.get(X).c(23).op(SHR_U).c(1).op(ADD).c(0xFE).op(AND).c(0).op(NE).get(X).c(1).op(SHL).op(EQZ).op(OR).if_();
        a.sf(lane ? ps1(d) : ps0(d), () => a.get(X).op(0xBE, 0xBB));
        a.else_().get(X).c(d).c(lane).call(F_LFSLANE).end();
    };
    /** psq_st's word from a lane of FPR d (doubleToSingleBitsFtz in cpu.ts: a denormal becomes a zero) */
    const psqBits = (d: number, lane: number) => {
        a.k64(lane ? ps1(d) : ps0(d)).set(T);
        a.get(T).c64(32n).op(SHRU64).op(WRAP).c(0xC0000000 | 0).op(AND).get(T).c64(29n).op(SHRU64).op(WRAP).c(0x3FFFFFFF).op(AND).op(OR);
        a.get(T).c64(32n).op(SHRU64).op(WRAP).c(0x80000000 | 0).op(AND);
        a.get(T).c64(52n).op(SHRU64).op(WRAP).c(0x7FF).op(AND).c(896).op(GT_U).get(T).c64(1n).op(SHL64).op(EQZ64).op(OR).op(SELECT);
    };
    /** frC's bits cut for a single multiply: rounded to 25 bits (force25), or cut there (trunc25) */
    const mul25 = (addr: number, cut = false) => {
        a.k64(addr).set(T);
        if (cut) a.get(T).c64(-0x10000000n).op(AND64).op(0xBF);
        else a.get(T).c64(-0x8000000n).op(AND64).get(T).c64(0x8000000n).op(AND64).op(ADD64).op(0xBF);
    };
    /** stfs's word from FPR d (doubleToSingleBits in fpu.ts): the ordinary numbers and zeros inline */
    const stfsBits = (d: number) => {
        a.k64(ps0(d)).set(T);
        a.get(T).c64(52n).op(SHRU64).op(WRAP).c(0x7FF).op(AND).c(896).op(GT_U).get(T).c64(1n).op(SHL64).op(EQZ64).op(OR).ifv();
        a.get(T).c64(32n).op(SHRU64).op(WRAP).c(0xC0000000 | 0).op(AND).get(T).c64(29n).op(SHRU64).op(WRAP).c(0x3FFFFFFF).op(AND).op(OR);
        a.else_().c(d).call(F_STFS).end();
    };

    const op31 = (ins: number) => {
        const xo = (ins >>> 1) & 0x3FF, d = (ins >>> 21) & 31, ra = (ins >>> 16) & 31, rb = (ins >>> 11) & 31, rc = ins & 1;
        const bin = (o: number, x = ra, y = rb) => { stG(d, () => { ldG(x); ldG(y).op(o); }); if (rc) cr0(d); };
        const log = (f: () => unknown) => { stG(ra, f); if (rc) cr0(ra); };
        const sum = (f: () => void) => { carry(d, f); if (rc) cr0(d); };
        switch (xo) {
            case 266: return bin(ADD);
            case 40: return bin(SUB, rb, ra);
            case 104: stG(d, () => { a.c(0); ldG(ra).op(SUB); }); if (rc) cr0(d); return;
            case 235: return bin(MUL);
            case 75: stG(d, () => { ldG(ra).op(EXT_S); ldG(rb).op(EXT_S).op(MUL64).c64(32n).op(SHRS64).op(WRAP); }); if (rc) cr0(d); return;
            case 11: stG(d, () => { ldG(ra).op(EXT_U); ldG(rb).op(EXT_U).op(MUL64).c64(32n).op(SHRU64).op(WRAP); }); if (rc) cr0(d); return;
            case 10: return sum(() => { u64(ra); u64(rb); a.op(ADD64); });
            case 8: return sum(() => { u64(ra, true); u64(rb); a.op(ADD64).c64(1n).op(ADD64); });
            case 138: return sum(() => { u64(ra); u64(rb); a.op(ADD64).k32(XERCA).op(EXT_U).op(ADD64); });
            case 136: return sum(() => { u64(ra, true); u64(rb); a.op(ADD64).k32(XERCA).op(EXT_U).op(ADD64); });
            case 202: return sum(() => { u64(ra); a.k32(XERCA).op(EXT_U).op(ADD64); });
            case 491:   // divw
                ldG(ra).set(X); ldG(rb).set(Y);
                stG(d, () => {
                    a.get(Y).op(EQZ).get(X).c(0x80000000 | 0).op(EQ).get(Y).c(-1).op(EQ).op(AND).op(OR).ifv();
                    a.get(X).c(31).op(SHR_S).else_().get(X).get(Y).op(0x6D).end();
                });
                if (rc) cr0(d); return;
            case 459:   // divwu
                ldG(ra).set(X); ldG(rb).set(Y);
                stG(d, () => { a.get(Y).op(EQZ).ifv().c(0).else_().get(X).get(Y).op(0x6E).end(); });
                if (rc) cr0(d); return;
            case 0: ldG(ra).set(X); ldG(rb).set(Y); crf(d >>> 2, true); return;
            case 32: ldG(ra).set(X); ldG(rb).set(Y); crf(d >>> 2, false); return;
            case 28: return log(() => { ldG(d); ldG(rb).op(AND); });
            case 60: return log(() => { ldG(d); ldG(rb).c(-1).op(XOR).op(AND); });
            case 444: return log(() => { ldG(d); if (d !== rb) ldG(rb).op(OR); });
            case 412: return log(() => { ldG(d); ldG(rb).c(-1).op(XOR).op(OR); });
            case 316: return log(() => { ldG(d); ldG(rb).op(XOR); });
            case 124: return log(() => { ldG(d); ldG(rb).op(OR).c(-1).op(XOR); });
            case 476: return log(() => { ldG(d); ldG(rb).op(AND).c(-1).op(XOR); });
            case 284: return log(() => { ldG(d); ldG(rb).op(XOR).c(-1).op(XOR); });
            case 24: return log(() => { a.c(0); ldG(d); ldG(rb).op(SHL); ldG(rb).c(32).op(AND).op(SELECT); });   // slw: 0 when the shift is 32..63
            case 536: return log(() => { a.c(0); ldG(d); ldG(rb).op(SHR_U); ldG(rb).c(32).op(AND).op(SELECT); });
            case 824:   // srawi
                if (rb === 0) { a.s32(XERCA, () => a.c(0)); return log(() => ldG(d)); }
                ldG(d).set(X);
                a.s32(XERCA, () => a.get(X).c(0).op(LT_S).get(X).c(32 - rb).op(SHL).c(0).op(NE).op(AND));
                return log(() => a.get(X).c(rb).op(SHR_S));
            case 26: return log(() => ldG(d).op(CLZ));
            case 954: return log(() => ldG(d).op(0xC0));
            case 922: return log(() => ldG(d).op(0xC1));
            case 23: return memop(ins, eax(ra, rb), MEM1_SIZE - 3, () => stG(d, () => be32()));
            case 55: return memop(ins, eaxU(ra, rb), MEM1_SIZE - 3, () => { stG(d, () => be32()); upd(ra); });
            case 87: return memop(ins, eax(ra, rb), MEM1_SIZE, () => stG(d, () => a.get(O).op(0x2D, 0, 0)));
            case 119: return memop(ins, eaxU(ra, rb), MEM1_SIZE, () => { stG(d, () => a.get(O).op(0x2D, 0, 0)); upd(ra); });
            case 279: return memop(ins, eax(ra, rb), MEM1_SIZE - 1, () => stG(d, () => be16()));
            case 311: return memop(ins, eaxU(ra, rb), MEM1_SIZE - 1, () => { stG(d, () => be16()); upd(ra); });
            case 343: return memop(ins, eax(ra, rb), MEM1_SIZE - 1, () => stG(d, () => { be16(); a.op(0xC1); }));
            case 375: return memop(ins, eaxU(ra, rb), MEM1_SIZE - 1, () => { stG(d, () => { be16(); a.op(0xC1); }); upd(ra); });
            case 151: return memop(ins, eax(ra, rb), MEM1_SIZE - 3, () => st32(() => ldG(d)), toPipe(4, () => ldG(d)));
            case 183: return memop(ins, eaxU(ra, rb), MEM1_SIZE - 3, () => { st32(() => ldG(d)); upd(ra); });
            case 215: return memop(ins, eax(ra, rb), MEM1_SIZE, () => { a.get(O); ldG(d).op(0x3A, 0, 0); }, toPipe(1, () => ldG(d)));
            case 247: return memop(ins, eaxU(ra, rb), MEM1_SIZE, () => { a.get(O); ldG(d).op(0x3A, 0, 0); upd(ra); });
            case 407: return memop(ins, eax(ra, rb), MEM1_SIZE - 1, () => st16(() => ldG(d)), toPipe(2, () => ldG(d)));
            case 439: return memop(ins, eaxU(ra, rb), MEM1_SIZE - 1, () => { st16(() => ldG(d)); upd(ra); });
            case 535: case 567:   // lfsx, lfsux
                fpCheck();
                return memop(ins, xo === 567 ? eaxU(ra, rb) : eax(ra, rb), MEM1_SIZE - 3, () => { loadLane(d, 0, 0); a.s64(ps1(d), () => a.k64(ps0(d))); if (xo === 567) upd(ra); });
            case 599: case 631:   // lfdx, lfdux
                fpCheck();
                return memop(ins, xo === 631 ? eaxU(ra, rb) : eax(ra, rb), MEM1_SIZE - 7, () => { a.s32(ps0(d) + 4, () => be32()); a.s32(ps0(d), () => be32(4)); if (xo === 631) upd(ra); });
            case 663: case 695:   // stfsx, stfsux
                fpCheck();
                return memop(ins, xo === 695 ? eaxU(ra, rb) : eax(ra, rb), MEM1_SIZE - 3, () => { st32(() => stfsBits(d)); if (xo === 695) upd(ra); }, toPipe(4, () => stfsBits(d), xo === 695 ? ra : -1));
            case 727: case 759:   // stfdx, stfdux
                fpCheck();
                return memop(ins, xo === 759 ? eaxU(ra, rb) : eax(ra, rb), MEM1_SIZE - 7, () => { st32(() => a.k32(ps0(d) + 4)); st32(() => a.k32(ps0(d)), 4); if (xo === 759) upd(ra); });
            case 339: {   // mfspr
                const n = (rb << 5) | ra;
                if (n === 8) { stG(d, () => a.k32(LR)); return; }
                if (n === 9) { stG(d, () => a.k32(CTR)); return; }
                if (n >= 912 && n < 920) { stG(d, () => a.k32(GQRS + 4 * (n - 912))); return; }
                return viaInterp(ins);
            }
            case 467: {   // mtspr
                const n = (rb << 5) | ra;
                if (n === 8) { a.s32(LR, () => ldG(d)); return; }
                if (n === 9) { a.s32(CTR, () => ldG(d)); return; }
                if (n >= 912 && n < 920) { a.s32(GQRS + 4 * (n - 912), () => ldG(d)); return; }
                return viaInterp(ins);
            }
            case 19: stG(d, () => a.k32(CR)); return;   // mfcr
            // (these only change registers)
            case 778: case 552: case 522: case 520: case 650: case 648: case 714: case 200: case 712: case 234: case 746: case 232: case 744: case 616: case 747:
            case 1003: case 971: case 792: case 144: case 512: case 83: case 4:
                return pure(ins);
            case 982: return lastViaInterp(ins);   // icbi: a changed instruction; the blocks made from the old ones go, this one too
            case 598: case 854: case 86: case 54: case 470: case 278: case 246: return;   // sync, eieio, dcbf, dcbst, dcbi, dcbt, dcbtst
        }
        // (the indexed FP forms check MSR[FP] in the interpreter)
        if (xo === 983) fpChecked = true;
        viaInterp(ins);
    };

    const one = (ins: number) => {
        const op = ins >>> 26, rD = (ins >>> 21) & 31, rA = (ins >>> 16) & 31, rB = (ins >>> 11) & 31;
        const simm = (ins << 16) >> 16, uimm = ins & 0xFFFF;
        switch (op) {
            case 14: stG(rD, () => { if (rA) ldG(rA).c(simm).op(ADD); else a.c(simm); }); return;
            case 15: stG(rD, () => { if (rA) ldG(rA).c(ins << 16).op(ADD); else a.c(ins << 16); }); return;
            case 24: if (rD !== rA || uimm) stG(rA, () => ldG(rD).c(uimm).op(OR)); return;
            case 25: stG(rA, () => ldG(rD).c(ins << 16).op(OR)); return;
            case 26: stG(rA, () => ldG(rD).c(uimm).op(XOR)); return;
            case 27: stG(rA, () => ldG(rD).c(ins << 16).op(XOR)); return;
            case 28: stG(rA, () => ldG(rD).c(uimm).op(AND)); cr0(rA); return;
            case 29: stG(rA, () => ldG(rD).c(ins << 16).op(AND)); cr0(rA); return;
            case 7: stG(rD, () => ldG(rA).c(simm).op(MUL)); return;
            case 8: carry(rD, () => { u64(rA, true); a.c64(BigInt(simm >>> 0) + 1n).op(ADD64); }); return;
            case 12: case 13: carry(rD, () => { u64(rA); a.c64(BigInt(simm >>> 0)).op(ADD64); }); if (op === 13) cr0(rD); return;
            case 10: ldG(rA).set(X); a.c(uimm).set(Y); crf(rD >>> 2, false); return;
            case 11: ldG(rA).set(X); a.c(simm).set(Y); crf(rD >>> 2, true); return;
            case 21: stG(rA, () => { ldG(rD); if (rB) a.c(rB).op(ROTL); a.c(MASK[(ins >>> 1) & 0x3FF]).op(AND); }); if (ins & 1) cr0(rA); return;
            case 20: { const mk = MASK[(ins >>> 1) & 0x3FF]; stG(rA, () => { ldG(rD); if (rB) a.c(rB).op(ROTL); a.c(mk).op(AND); ldG(rA).c(~mk).op(AND).op(OR); }); if (ins & 1) cr0(rA); return; }
            case 23: stG(rA, () => { ldG(rD); ldG(rB).c(31).op(AND).op(ROTL).c(MASK[(ins >>> 1) & 0x3FF]).op(AND); }); if (ins & 1) cr0(rA); return;
            case 32: return memop(ins, ea(rA, simm), MEM1_SIZE - 3, () => stG(rD, () => be32()));
            case 33: return memop(ins, eaU(rA, simm), MEM1_SIZE - 3, () => { stG(rD, () => be32()); upd(rA); });
            case 34: return memop(ins, ea(rA, simm), MEM1_SIZE, () => stG(rD, () => a.get(O).op(0x2D, 0, 0)));
            case 35: return memop(ins, eaU(rA, simm), MEM1_SIZE, () => { stG(rD, () => a.get(O).op(0x2D, 0, 0)); upd(rA); });
            case 36: return memop(ins, ea(rA, simm), MEM1_SIZE - 3, () => st32(() => ldG(rD)), toPipe(4, () => ldG(rD)));
            case 37: return memop(ins, eaU(rA, simm), MEM1_SIZE - 3, () => { st32(() => ldG(rD)); upd(rA); }, toPipe(4, () => ldG(rD), rA));
            case 38: return memop(ins, ea(rA, simm), MEM1_SIZE, () => { a.get(O); ldG(rD).op(0x3A, 0, 0); }, toPipe(1, () => ldG(rD)));
            case 39: return memop(ins, eaU(rA, simm), MEM1_SIZE, () => { a.get(O); ldG(rD).op(0x3A, 0, 0); upd(rA); });
            case 40: return memop(ins, ea(rA, simm), MEM1_SIZE - 1, () => stG(rD, () => be16()));
            case 41: return memop(ins, eaU(rA, simm), MEM1_SIZE - 1, () => { stG(rD, () => be16()); upd(rA); });
            case 42: return memop(ins, ea(rA, simm), MEM1_SIZE - 1, () => stG(rD, () => { be16(); a.op(0xC1); }));
            case 43: return memop(ins, eaU(rA, simm), MEM1_SIZE - 1, () => { stG(rD, () => { be16(); a.op(0xC1); }); upd(rA); });
            case 44: return memop(ins, ea(rA, simm), MEM1_SIZE - 1, () => st16(() => ldG(rD)), toPipe(2, () => ldG(rD)));
            case 45: return memop(ins, eaU(rA, simm), MEM1_SIZE - 1, () => { st16(() => ldG(rD)); upd(rA); });
            case 46: return memop(ins, ea(rA, simm), MEM1_SIZE - 4 * (32 - rD) + 1, () => { for (let r = rD, i = 0; r < 32; r++, i += 4) stG(r, () => be32(i)); });
            case 47: return memop(ins, ea(rA, simm), MEM1_SIZE - 4 * (32 - rD) + 1, () => { for (let r = rD, i = 0; r < 32; r++, i += 4) st32(() => ldG(r), i); });
            case 18: {
                const li = (ins & 0x03FFFFFC) << 6 >> 6, target = (ins & 2 ? li : pc + li) >>> 0;
                ended = true;
                if (ins & 1) { a.s32(LR, () => a.c(pc + 4)); exit(() => a.c(target)); } else jump(target);
                return;
            }
            case 16: {
                const bd = (ins & 0xFFFC) << 16 >> 16, target = (ins & 2 ? bd : pc + bd) >>> 0;
                const go = () => { if (ins & 1) { a.s32(LR, () => a.c(pc + 4)); exit(() => a.c(target)); } else jump(target); };
                if (cond(rD, rA)) { a.if_(); go(); a.end(); } else { ended = true; go(); }
                return;
            }
            case 19: {
                const xo = (ins >>> 1) & 0x3FF;
                if (xo === 16) {   // bclr
                    const go = () => {
                        if (ins & 1) { a.k32(LR).set(Y); a.s32(LR, () => a.c(pc + 4)); exit(() => a.get(Y).c(-4).op(AND)); }
                        else exit(() => a.k32(LR).c(-4).op(AND));
                    };
                    if (cond(rD, rA)) { a.if_(); go(); a.end(); } else { ended = true; go(); }
                    return;
                }
                if (xo === 528) {   // bcctr
                    const go = () => { if (ins & 1) a.s32(LR, () => a.c(pc + 4)); exit(() => a.k32(CTR).c(-4).op(AND)); };
                    if (rD & 16) { ended = true; go(); }
                    else { a.k32(CR).c(1 << (31 - rA)).op(AND); if (rD & 8) a.c(0).op(NE); else a.op(EQZ); a.if_(); go(); a.end(); }
                    return;
                }
                if (xo === 50) return lastViaInterp(ins);   // rfi
                if (xo === 193 && rA === rB) { a.s32(CR, () => a.k32(CR).c(~(1 << (31 - rD))).op(AND)); return; }   // crclr
                if (xo === 150) return;   // isync
                if (xo === 33 || xo === 129 || xo === 193 || xo === 225 || xo === 257 || xo === 289 || xo === 417 || xo === 449) {   // CR logic: bit rD from bits rA and rB
                    const bit = (n: number) => a.k32(CR).c(31 - n).op(SHR_U);
                    a.s32(CR, () => {
                        a.k32(CR).c(~(1 << (31 - rD))).op(AND);
                        bit(rA);
                        switch (xo) {
                            case 33: bit(rB).op(OR).c(1).op(XOR); break;
                            case 129: bit(rB).c(1).op(XOR).op(AND); break;
                            case 193: bit(rB).op(XOR); break;
                            case 225: bit(rB).op(AND).c(1).op(XOR); break;
                            case 257: bit(rB).op(AND); break;
                            case 289: bit(rB).op(XOR).c(1).op(XOR); break;
                            case 417: bit(rB).c(1).op(XOR).op(OR); break;
                            default: bit(rB).op(OR);
                        }
                        a.c(1).op(AND).c(31 - rD).op(SHL).op(OR);
                    });
                    return;
                }
                return pure(ins);
            }
            case 17: return lastViaInterp(ins);   // sc
            case 31: return op31(ins);
            case 3: return pure(ins);   // twi
        }
        // ---- floating point
        if (op === 48 || op === 49) {   // lfs: the ordinary numbers and zeros inline
            fpCheck();
            return memop(ins, op === 49 ? eaU(rA, simm) : ea(rA, simm), MEM1_SIZE - 3, () => {
                loadLane(rD, 0, 0); a.s64(ps1(rD), () => a.k64(ps0(rD)));
                if (op === 49) upd(rA);
            });
        }
        if (op === 50 || op === 51) {
            fpCheck();
            return memop(ins, op === 51 ? eaU(rA, simm) : ea(rA, simm), MEM1_SIZE - 7, () => { a.s32(ps0(rD) + 4, () => be32()); a.s32(ps0(rD), () => be32(4)); if (op === 51) upd(rA); });
        }
        if (op === 52 || op === 53) {
            fpCheck();
            return memop(ins, op === 53 ? eaU(rA, simm) : ea(rA, simm), MEM1_SIZE - 3, () => { st32(() => stfsBits(rD)); if (op === 53) upd(rA); }, toPipe(4, () => stfsBits(rD), op === 53 ? rA : -1));
        }
        if (op === 54 || op === 55) {
            fpCheck();
            return memop(ins, op === 55 ? eaU(rA, simm) : ea(rA, simm), MEM1_SIZE - 7, () => { st32(() => a.k32(ps0(rD) + 4)); st32(() => a.k32(ps0(rD)), 4); if (op === 55) upd(rA); });
        }
        if (op === 59 || op === 63) {
            const d = rD, ra = rA, rb = rB, rc = (ins >>> 6) & 31;
            fpCheck();
            if (!(ins & 1)) {
                const bin = (o: number) => { a.kf(ps0(ra)).kf(ps0(rb)).op(o).set(FX); };
                if (op === 59) switch ((ins >>> 1) & 31) {
                    case 18: bin(FDIV); return resS(d, ra, rb, -1);
                    case 20: bin(FSUB); return resS(d, ra, rb, -1);
                    case 21: bin(FADD); return resS(d, ra, rb, -1);
                    case 25: a.kf(ps0(ra)); mul25(ps0(rc)); a.op(FMUL).set(FX); return resS(d, ra, -1, rc);
                }
                else if (ins & 0x20) switch ((ins >>> 1) & 31) {
                    case 18: bin(FDIV); return resD(d, ra, rb, -1);
                    case 20: bin(FSUB); return resD(d, ra, rb, -1);
                    case 21: bin(FADD); return resD(d, ra, rb, -1);
                    case 25: a.kf(ps0(ra)).kf(ps0(rc)).op(FMUL).set(FX); return resD(d, ra, -1, rc);
                }
                else switch ((ins >>> 1) & 0x3FF) {
                    case 72: a.s64(ps0(d), () => a.k64(ps0(rb))); return;
                    case 40: a.s64(ps0(d), () => a.k64(ps0(rb)).c64(-0x8000000000000000n).op(XOR64)); return;
                    case 264: a.s64(ps0(d), () => a.k64(ps0(rb)).c64(0x7FFFFFFFFFFFFFFFn).op(AND64)); return;
                    case 136: a.s64(ps0(d), () => a.k64(ps0(rb)).c64(-0x8000000000000000n).op(OR64)); return;
                    case 12: a.kf(ps0(rb)).set(FX); return resS(d, rb, -1, -1);   // frsp
                    case 15:   // fctiwz: toward zero, saturating; a NaN gives the most negative
                        a.kf(ps0(rb)).set(FX);
                        a.c(0x80000000 | 0).get(FX).op(0xFC, 0x02).get(FX).get(FX).op(FNE).op(SELECT).set(V);
                        a.k64(ps0(rb)).set(T);
                        a.s32(ps0(d), () => a.get(V));
                        a.s32(ps0(d) + 4, () => a.c(0xFFF80000 | 0).get(V).op(EQZ).get(T).c64(63n).op(SHRU64).op(WRAP).op(AND).op(OR));
                        return;
                    case 0: case 32: {
                        const sh = 28 - 4 * (d >>> 2);
                        a.kf(ps0(ra)).set(FX); a.kf(ps0(rb)).set(FY);
                        a.c(1).c(8).c(4).c(2).get(FX).get(FY).op(FGT).op(SELECT).get(FX).get(FY).op(FLT).op(SELECT)
                            .get(FX).get(FX).op(FNE).get(FY).get(FY).op(FNE).op(OR).op(SELECT).set(V);
                        a.s32(CR, () => a.k32(CR).c(~(0xF << sh)).op(AND).get(V).c(sh).op(SHL).op(OR));
                        a.s32(FPSCR, () => a.k32(FPSCR).c(~0xF000).op(AND).get(V).c(12).op(SHL).op(OR));
                        return;
                    }
                }
            }
            a.c(ins).call(op === 59 ? F_OP59 : F_OP63);
            return;
        }
        if (op === 4) {
            const xo = (ins >>> 1) & 0x3FF, x6 = xo & 0x3F;
            // (the indexed quantised loads and stores and dcbz_l touch memory)
            if (x6 === 6 || x6 === 7 || x6 === 38 || x6 === 39 || xo === 1014) { fpChecked = true; return viaInterp(ins); }
            fpCheck();
            const d = rD, ra = rA, rb = rB, rc = (ins >>> 6) & 31;
            /** both lanes' values (in FX, FY) stored as the interpreter does: lane 0, then lane 1 */
            const lanes = (a0: number, b0: number, c0: number, a1: number, b1: number, c1: number) => { resL(d, 0, FX, a0, b0, c0); resL(d, 1, FY, a1, b1, c1); };
            const mov = (lo: number, hi: number) => { a.k64(lo).set(T); a.k64(hi).set(T2); a.s64(ps0(d), () => a.get(T)); a.s64(ps1(d), () => a.get(T2)); };
            if (!(ins & 1)) switch (xo & 31) {
                case 21: if (xo !== 21) break; a.kf(ps0(ra)).kf(ps0(rb)).op(FADD).set(FX); a.kf(ps1(ra)).kf(ps1(rb)).op(FADD).set(FY); return lanes(ra, rb, -1, ra | 32, rb | 32, -1);
                case 20: if (xo !== 20) break; a.kf(ps0(ra)).kf(ps0(rb)).op(FSUB).set(FX); a.kf(ps1(ra)).kf(ps1(rb)).op(FSUB).set(FY); return lanes(ra, rb, -1, ra | 32, rb | 32, -1);
                case 25: a.kf(ps0(ra)); mul25(ps0(rc)); a.op(FMUL).set(FX); a.kf(ps1(ra)); mul25(ps1(rc)); a.op(FMUL).set(FY); return lanes(ra, -1, rc, ra | 32, -1, rc | 32);
                case 12: a.kf(ps0(ra)); mul25(ps0(rc)); a.op(FMUL).set(FX); a.kf(ps1(ra)); mul25(ps0(rc), true); a.op(FMUL).set(FY); return lanes(ra, -1, rc, ra | 32, -1, rc);   // ps_muls0
                case 13: a.kf(ps0(ra)); mul25(ps1(rc)); a.op(FMUL).set(FX); a.kf(ps1(ra)); mul25(ps1(rc)); a.op(FMUL).set(FY); return lanes(ra, -1, rc | 32, ra | 32, -1, rc | 32);   // ps_muls1
                case 10: a.kf(ps0(ra)).kf(ps1(rb)).op(FADD).set(FX); a.kf(ps1(rc)).set(FY); return lanes(ra, rb | 32, -1, rc | 32, -1, -1);   // ps_sum0
                case 11: a.kf(ps0(ra)).kf(ps1(rb)).op(FADD).set(FY); a.kf(ps0(rc)).set(FX); resL(d, 1, FY, ra, rb | 32, -1); resL(d, 0, FX, rc, -1, -1); return;   // ps_sum1
            }
            if (!(ins & 1)) switch (xo) {
                case 72: return mov(ps0(rb), ps1(rb));   // ps_mr
                case 528: return mov(ps0(ra), ps0(rb));   // ps_merge00
                case 560: return mov(ps0(ra), ps1(rb));
                case 592: return mov(ps1(ra), ps0(rb));
                case 624: return mov(ps1(ra), ps1(rb));
                case 40: a.k64(ps0(rb)).c64(-0x8000000000000000n).op(XOR64).set(T); a.k64(ps1(rb)).c64(-0x8000000000000000n).op(XOR64).set(T2); a.s64(ps0(d), () => a.get(T)); a.s64(ps1(d), () => a.get(T2)); return;   // ps_neg
            }
            a.c(ins).call(F_OP4);
            return;
        }
        if (op === 56 || op === 57 || op === 60 || op === 61) {   // psq_l, psq_lu, psq_st, psq_stu: floats inline, the quantised types through the interpreter
            fpCheck();
            const w = (ins >>> 15) & 1, gq = GQRS + 4 * ((ins >>> 12) & 7), d12 = (ins << 20) >> 20, load = op < 58, update = op === 57 || op === 61;
            (update ? eaU(rA, d12) : ea(rA, d12))();
            a.tee(A).c(0x80000000 | 0).op(XOR).tee(O).c(MEM1_SIZE - (w ? 3 : 7)).op(LT_U);
            a.k32(gq).c(load ? 0x00040000 : 4).op(AND).op(EQZ).op(AND).if_();
            if (load) { loadLane(rD, 0, 0); if (w) a.sf(ps1(rD), () => a.cf(1)); else loadLane(rD, 1, 4); }
            else { st32(() => psqBits(rD, 0)); if (!w) st32(() => psqBits(rD, 1), 4); }
            if (update) upd(rA);
            a.else_(); viaInterp(ins); a.end();
            return;
        }
        viaInterp(ins);
    };

    if (loops) a.op(0x03, 0x40);
    for (; k < N; k++, pc = (pc + 4) >>> 0) one(words[k]);
    if (!ended) { k--; exit(() => a.c(pc)); k++; }
    if (loops) a.op(0x0B);
    if (a.nest !== 0) throw new Error('jit: unbalanced block');
    return { pc: pc0, n: N, words: Uint32Array.from(words), body: [3, 5, I32, 2, I64, 2, F64, ...a.b, 0x0B], next };
}
