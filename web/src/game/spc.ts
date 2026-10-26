// The SPC script machine (Strategic/spcinterp.cpp, include/Strategic/spcinterp.hpp): TSpcBinary
// (an .sb file: the compiled script) and TSpcInterp (its stack machine), ported one to one.
//
// An .sb file ("SPCB", big endian): a header (text, data and symbol offsets, the data / symbol
// counts, the global variable count), the text (the byte code), the data (a u32 offset table, then
// the strings, Shift-JIS) and the symbols (20 bytes each: type, name offset, data, the name's hash,
// the native call bound to it; the names follow the table). Symbols of type 0 are builtins: the
// game binds a native function to each by name (bindSystemDataToSymbol); a builtin the game
// doesn't bind is called as nothing (its arguments popped, 0 pushed: dispatchBuiltinDefault).
//
// The machine: a process stack (operands), a storage stack (variables: the globals, then each
// call's arguments and locals), a context stack (return addresses, frame bases, saved displays)
// and four displays (the storage index of each nesting level's frame). Every stack is a fixed
// array (TSpcStack: a push past its capacity is dropped, a pop of an empty one returns slot 0's
// value); the variables are read and written straight into the storage array (getFromBottom),
// past its size too, as the game does. update() runs up to mStepsToDo instructions a call (the
// event watcher's 0x20); `yield` ends the call, `exit` / `end` stop the script for good, and
// `lock` makes instructions free (the budget stops counting) until `unlock`.
//
// Value semantics follow TSpcSlice: int / float / string; int <-> float as the PowerPC converts
// (fctiwz truncation, f32 rounding); the comparisons compare strings by strcmp when both are
// strings, as floats when either is a float, else as ints (a string reads as 0 / 0.0).
//
// Not modelled: SpcTrace (compiled out of the game), dump(); the uninitialised mLocked of a fresh
// TSpcInterp (the constructor never writes it: taken as 0, as a freshly allocated heap block's
// would be most of the time).

import { fr } from './math.js';

export const SLICE_INT = 0, SLICE_FLOAT = 1, SLICE_STRING = 2;

/** float -> int as fctiwz does (truncation, saturating; NaN gives 0x80000000) */
export function f2i(f: number) {
    if (Number.isNaN(f)) return 0x80000000 | 0;
    if (f >= 2147483647) return 0x7FFFFFFF;
    if (f <= -2147483648) return 0x80000000 | 0;
    return Math.trunc(f) | 0;
}

/** TSpcSlice */
export class SpcSlice {
    type = SLICE_INT; i = 0; f = 0; s = '';
    static int(v: number) { const r = new SpcSlice(); r.i = v | 0; return r; }
    static float(v: number) { const r = new SpcSlice(); r.type = SLICE_FLOAT; r.f = fr(v); return r; }
    static str(v: string | null) { const r = new SpcSlice(); r.type = SLICE_STRING; r.s = v ?? ''; return r; }
    clone() { const r = new SpcSlice(); r.type = this.type; r.i = this.i; r.f = this.f; r.s = this.s; return r; }
    copyFrom(o: SpcSlice) { this.type = o.type; this.i = o.i; this.f = o.f; this.s = o.s; }
    getDataInt() { return this.type === SLICE_INT ? this.i : this.type === SLICE_FLOAT ? f2i(this.f) : 0; }
    getDataFloat() { return this.type === SLICE_INT ? fr(this.i) : this.type === SLICE_FLOAT ? this.f : 0; }
    getDataString() { return this.type === SLICE_STRING ? this.s : ''; }
    inc() { if (this.type === SLICE_INT) this.i = (this.i + 1) | 0; else if (this.type === SLICE_FLOAT) this.f = fr(this.f + 1); }
    dec() { if (this.type === SLICE_INT) this.i = (this.i - 1) | 0; else if (this.type === SLICE_FLOAT) this.f = fr(this.f - 1); }
    negate() { if (this.type === SLICE_INT) this.i = -this.i | 0; else if (this.type === SLICE_FLOAT) this.f = -this.f; return this; }
    eq(o: SpcSlice) {
        if (this.type === SLICE_STRING && o.type === SLICE_STRING) return this.s === o.s;
        if (this.type === SLICE_FLOAT || o.type === SLICE_FLOAT) return this.getDataFloat() === o.getDataFloat();
        return this.getDataInt() === o.getDataInt();
    }
    /** operator> / < / >= / <= (strings compare as ints: 0) */
    cmp(o: SpcSlice, op: (a: number, b: number) => boolean) {
        if (this.type === SLICE_FLOAT || o.type === SLICE_FLOAT) return op(this.getDataFloat(), o.getDataFloat());
        return op(this.getDataInt(), o.getDataInt());
    }
}

/** TSpcStack<T>: a fixed array, its size apart */
export class SpcStack<T> {
    data: T[]; size = 0;
    constructor(public capacity: number, make: () => T) { this.data = []; for (let i = 0; i < capacity; i++) this.data.push(make()); }
}
class SliceStack extends SpcStack<SpcSlice> {
    constructor(cap: number) { super(cap, () => new SpcSlice()); }
    push(v: SpcSlice) { if (this.size >= this.capacity) return; this.data[this.size].copyFrom(v); this.size++; }
    pop(): SpcSlice { if (this.size <= 0) return this.data[this.size].clone(); this.size--; return this.data[this.size].clone(); }
    /** getFromBottom: the slot itself (no bound check, as the game's array index) */
    at(i: number): SpcSlice { const d = this.data[i]; if (d) return d; return this.data[i] = new SpcSlice(); }
    top(i: number) { return this.at(this.size - 1 - i); }
}
class U32Stack extends SpcStack<number> {
    constructor(cap: number) { super(cap, () => 0); }
    push(v: number) { if (this.size >= this.capacity) return; this.data[this.size] = v >>> 0; this.size++; }
    pop(): number { if (this.size <= 0) return this.data[this.size] ?? 0; this.size--; return this.data[this.size]; }
    top(i: number) { return this.data[this.size - 1 - i] ?? 0; }
}

/** A builtin: the interpreter and its argument count (the arguments are on the process stack). */
export type SpcBuiltin<I extends SpcInterp = SpcInterp> = (interp: I, argNum: number) => void;

interface SpcSymbol { type: number; name: string; data: number; hash: number; call: SpcBuiltin<any> | null; }

const sjis = new TextDecoder('shift_jis');

/** TSpcBinary */
export class SpcBinary {
    v: DataView;
    textOfs = 0; dataOfs = 0; dataNum = 0; symOfs = 0; symNum = 0; globals = 0;
    magicOk = false;
    symbols: SpcSymbol[] = [];
    private strings = new Map<number, string>();
    constructor(public b: Uint8Array) {
        this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
        this.magicOk = b[0] === 0x53 && b[1] === 0x50 && b[2] === 0x43 && b[3] === 0x42;
        this.textOfs = this.v.getUint32(4); this.dataOfs = this.v.getUint32(8); this.dataNum = this.v.getUint32(12);
        this.symOfs = this.v.getUint32(16); this.symNum = this.v.getUint32(20); this.globals = this.v.getInt32(24);
        const names = this.symOfs + this.symNum * 20;
        for (let i = 0; i < this.symNum; i++) {
            const o = this.symOfs + i * 20;
            this.symbols.push({ type: this.v.getUint32(o), name: this.cstr(names + this.v.getUint32(o + 4)), data: this.v.getUint32(o + 8), hash: 0, call: null });
        }
    }
    private cstr(o: number) { let e = o; while (e < this.b.length && this.b[e]) e++; return sjis.decode(this.b.subarray(o, e)); }
    /** init: calcAndStoreKeys, initSystemBuiltin, initUserBuiltin */
    init(user?: (b: SpcBinary) => void) {
        for (const s of this.symbols) s.hash = SpcBinary.calcKey(s.name);
        this.initSystemBuiltin();
        if (user) user(this);
    }
    /**
     * calcKey (result = *name + result * 3 over the name's chars). Here over the decoded string's
     * code units: the key only pre-filters searchSymbol's name compare, so any consistent key
     * finds the same symbol.
     */
    static calcKey(name: string) {
        let r = 0;
        for (let i = 0; i < name.length; i++) r = (name.charCodeAt(i) + Math.imul(r, 3)) >>> 0;
        return r;
    }
    searchSymbol(name: string) {
        const h = SpcBinary.calcKey(name);
        for (const s of this.symbols) if (s.hash === h && s.name === name) return s;
        return null;
    }
    bindSystemDataToSymbol(name: string, call: SpcBuiltin<any>) { const s = this.searchSymbol(name); if (s) s.call = call; }
    initSystemBuiltin() {
        this.bindSystemDataToSymbol('yield', spcYield);
        this.bindSystemDataToSymbol('exit', spcExit);
        this.bindSystemDataToSymbol('lock', spcLock);
        this.bindSystemDataToSymbol('unlock', spcUnlock);
        this.bindSystemDataToSymbol('print', spcPrint);
        this.bindSystemDataToSymbol('dump', spcDump);
        this.bindSystemDataToSymbol('int', spcInt);
        this.bindSystemDataToSymbol('float', spcFloat);
        this.bindSystemDataToSymbol('typeof', spcTypeof);
    }
    getSymbol(i: number) { return this.symbols[i] ?? null; }
    /** getData: the data section's string i */
    getData(i: number) {
        let s = this.strings.get(i);
        if (s === undefined) {
            const base = this.dataOfs + this.dataNum * 4;
            s = this.cstr(base + this.v.getUint32(this.dataOfs + i * 4));
            this.strings.set(i, s);
        }
        return s;
    }
    textByte(pc: number) { return this.b[this.textOfs + pc] ?? 0; }
    textU32(pc: number) { return this.v.getUint32(this.textOfs + pc); }
    textF32(pc: number) { return this.v.getFloat32(this.textOfs + pc); }
}

// ---------------------------------------------------------------- the system builtins (spcinterp.cpp)
function popArgs(it: SpcInterp, n: number) { for (let i = 0; i < n; i++) it.pop(); }
const spcYield: SpcBuiltin = (it, n) => { it.mStepsLeft = 0; popArgs(it, n); it.pushVoid(); };
const spcExit: SpcBuiltin = (it, n) => { it.mStepsToDo = 0; it.mStepsLeft = 0; popArgs(it, n); it.pushVoid(); };
const spcLock: SpcBuiltin = (it, n) => { it.mLocked = 1; popArgs(it, n); it.pushVoid(); };
const spcUnlock: SpcBuiltin = (it, n) => { it.mLocked = 0; popArgs(it, n); it.pushVoid(); };
const spcPrint: SpcBuiltin = (it, n) => { popArgs(it, n); it.pushVoid(); };
const spcDump: SpcBuiltin = (it, n) => { popArgs(it, n); it.pushVoid(); };
const spcInt: SpcBuiltin = (it, n) => { const a = { n }; if (n !== 1) it.verifyArgNum(1, a); it.pushInt(it.pop().getDataInt()); };
const spcFloat: SpcBuiltin = (it, n) => { const a = { n }; if (n !== 1) it.verifyArgNum(1, a); it.pushFloat(it.pop().getDataFloat()); };
const spcTypeof: SpcBuiltin = (it, n) => { const a = { n }; if (n !== 1) it.verifyArgNum(1, a); it.pushInt(it.pop().type); };

/** TSpcInterp */
export class SpcInterp {
    mStepsToDo: number; mProgramCounter = 0; mStepsLeft: number;
    mLocked = 0;
    proc: SliceStack; storage: SliceStack; ctx: U32Stack;
    display = [0, 0, 0, 0];
    /** mCurrentlyExecutingBuiltinName */
    builtinName = '';
    /** instructions run so far (for the viewer / debugging) */
    steps = 0;
    constructor(public bin: SpcBinary | null, public owner: any, steps: number, procSize: number, storageSize: number, ctxSize: number) {
        this.mStepsToDo = steps; this.mStepsLeft = steps;
        this.proc = new SliceStack(procSize); this.storage = new SliceStack(storageSize); this.ctx = new U32Stack(ctxSize);
        if (!bin) return;
        for (let i = 0; i < bin.globals; i++) this.storage.push(SpcSlice.int(0));
    }
    get finished() { return this.mStepsToDo === 0; }
    // push / pop (TSpcInterp's helpers)
    push(s: SpcSlice) { this.proc.push(s); }
    pushInt(v: number) { this.proc.push(SpcSlice.int(v)); }
    pushFloat(v: number) { this.proc.push(SpcSlice.float(v)); }
    pushStr(v: string | null) { this.proc.push(SpcSlice.str(v)); }
    pushBool(b: boolean) { this.pushInt(b ? 1 : 0); }
    /** push(): an int 0 (the builtins' void result) */
    pushVoid() { this.proc.push(SpcSlice.int(0)); }
    pop() { return this.proc.pop(); }
    /** verifyArgNum: pops extra arguments / pushes missing ones (n is the caller's count, updated) */
    verifyArgNum(want: number, a: { n: number }) {
        while (want < a.n) { this.pop(); a.n--; }
        while (want > a.n) { this.pushVoid(); a.n++; }
    }

    private u8() { const r = this.bin!.textByte(this.mProgramCounter); this.mProgramCounter++; return r; }
    private u32() { const r = this.bin!.textU32(this.mProgramCounter); this.mProgramCounter += 4; return r; }
    private s32() { return this.u32() | 0; }
    private f32() { const r = this.bin!.textF32(this.mProgramCounter); this.mProgramCounter += 4; return r; }
    private bin2(f: (a: SpcSlice, b: SpcSlice) => void) { const b = this.proc.pop(), a = this.proc.pop(); f(a, b); }
    private arith(fi: (a: number, b: number) => number, ff: ((a: number, b: number) => number) | null) {
        this.bin2((a, b) => {
            if (ff && (a.type === SLICE_FLOAT || b.type === SLICE_FLOAT)) this.pushFloat(ff(a.getDataFloat(), b.getDataFloat()));
            else this.pushInt(fi(a.getDataInt(), b.getDataInt()));
        });
    }
    /** var operand: the storage slot of (display level, index) */
    private slot(level: number, idx: number) { return this.storage.at((this.display[level] + idx) >>> 0); }

    /** One instruction (chooseExecFunction's table). */
    exec(cmd: number) {
        switch (cmd) {
            case 0: this.pushInt(this.s32()); break;                                  // int
            case 1: this.pushFloat(this.f32()); break;                                // flt
            case 2: this.pushStr(this.bin!.getData(this.u32())); break;               // str
            case 3: this.pushInt(this.u32()); break;                                  // adr
            case 4: { const l = this.u32(), i = this.u32(); this.push(this.slot(l, i)); break; }   // var
            case 5: break;                                                            // nop
            case 6: case 7: {                                                         // inc / dec
                this.u8(); const l = this.u32(), i = this.u32();
                const s = this.slot(l, i); if (cmd === 6) s.inc(); else s.dec();
                this.push(this.slot(l, i)); break;
            }
            case 8: this.arith((a, b) => (a + b) | 0, (a, b) => fr(a + b)); break;
            case 9: this.arith((a, b) => (a - b) | 0, (a, b) => fr(a - b)); break;
            case 10: this.arith((a, b) => Math.imul(a, b), (a, b) => fr(a * b)); break;
            // divw: by zero the Gekko gives -1 for a negative dividend and 0 otherwise; 0x80000000 / -1 gives 0
            case 11: this.arith((a, b) => (b === 0 ? (a < 0 ? -1 : 0) : (a === -0x80000000 && b === -1) ? 0 : (a / b) | 0), (a, b) => fr(a / b)); break;
            case 12: this.arith((a, b) => (b === 0 ? a : (a % b) | 0), null); break;
            case 13: { const v = this.proc.pop(); this.u8(); const l = this.u32(), i = this.u32(); this.slot(l, i).copyFrom(v); break; }  // ass
            case 14: this.bin2((a, b) => this.pushBool(a.eq(b))); break;
            case 15: this.bin2((a, b) => this.pushBool(!a.eq(b))); break;
            case 16: this.bin2((a, b) => this.pushBool(a.cmp(b, (x, y) => x > y))); break;
            case 17: this.bin2((a, b) => this.pushBool(a.cmp(b, (x, y) => x < y))); break;
            case 18: this.bin2((a, b) => this.pushBool(a.cmp(b, (x, y) => x >= y))); break;
            case 19: this.bin2((a, b) => this.pushBool(a.cmp(b, (x, y) => x <= y))); break;
            case 20: { const s = this.proc.pop(); this.push(s.negate()); break; }   // neg
            case 21: { const s = this.proc.pop(); this.pushBool(s.getDataInt() === 0); break; }   // not
            case 22: this.bin2((a, b) => this.pushBool(a.getDataInt() !== 0 && b.getDataInt() !== 0)); break;
            case 23: this.bin2((a, b) => this.pushBool(a.getDataInt() !== 0 || b.getDataInt() !== 0)); break;
            case 24: this.arith((a, b) => a & b, null); break;
            case 25: this.arith((a, b) => a | b, null); break;
            case 26: this.arith((a, b) => ((b & 63) >= 32 ? 0 : a << (b & 31)), null); break;   // slw
            case 27: this.arith((a, b) => ((b & 63) >= 32 ? a >> 31 : a >> (b & 31)), null); break;   // sraw
            case 28: {                                                                // call
                const addr = this.u32(), n = this.s32();
                this.ctx.push(this.mProgramCounter);
                this.ctx.push(this.storage.size);
                for (let i = 0; i < n; i++) this.storage.push(new SpcSlice());
                for (let i = 0; i < n; i++) this.storage.top(i).copyFrom(this.proc.pop());
                this.mProgramCounter = addr; break;
            }
            case 29: { const sym = this.u32(), n = this.u32(); this.dispatchBuiltin(sym, n); break; }   // func
            case 30: { const n = this.s32(); if (this.ctx.size > 0) for (let i = 0; i < n; i++) this.storage.push(new SpcSlice()); break; }   // mkfr
            case 31: {                                                                // mkds
                const d = this.s32(); const old = this.display[d] ?? 0;
                this.display[d] = this.ctx.top(0);
                this.ctx.push(old); this.ctx.push(d); break;
            }
            case 32: this.ret(); break;
            case 33: this.pushInt(0); this.ret(); break;                              // ret0
            case 34: { const a = this.u32(); if (!this.pop().getDataInt()) this.mProgramCounter = a; break; }   // jne
            case 35: this.mProgramCounter = this.u32(); break;                        // jmp
            case 36: this.proc.pop(); break;                                          // pop
            case 37: this.pushInt(0); break;
            case 38: this.pushInt(1); break;
            case 39: this.mStepsToDo = 0; this.mStepsLeft = 0; break;                 // end
            default: break;                                                           // unknown: nothing
        }
    }
    private ret() {
        const di = this.ctx.pop(), disp = this.ctx.pop(), size = this.ctx.pop();
        for (let i = this.storage.size; i > size; i--) this.storage.pop();
        this.display[di] = disp;
        this.mProgramCounter = this.ctx.pop();
    }
    /** dispatchBuiltin (TSpcTypedInterp's: the symbol's bound call, else dispatchBuiltinDefault) */
    dispatchBuiltin(symIdx: number, argNum: number) {
        const sym = this.bin!.getSymbol(symIdx);
        if (!sym || !sym.call) { for (let i = 0; i < argNum; i++) this.pop(); this.pushVoid(); return; }
        this.builtinName = sym.name;
        sym.call(this, argNum);
    }
    /** update: up to mStepsToDo instructions (lock: uncounted), then the budget refills */
    update() {
        if (!this.bin) return;
        let guard = 0;
        while (this.mStepsLeft > 0) {
            if (!this.mLocked) this.mStepsLeft--;
            // (a locked script that never yields hangs the game; here it is cut off)
            else if (++guard > 1000000) { console.warn('[spc] locked script never yields'); this.mStepsLeft = 0; break; }
            const cmd = this.u8();
            this.steps++;
            this.exec(cmd);
        }
        this.mStepsLeft = this.mStepsToDo;
    }
}
