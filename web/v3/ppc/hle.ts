// v3: high-level stand-ins for the SDK functions that face hardware the viewer doesn't emulate,
// hooked by address. The game's code above them runs as it is.
import type { Cpu } from './cpu.js';
import type { Machine } from './machine.js';

/** address of a function by its name in the decomp's symbols (undefined: not in this build) */
export type Sym = (name: string) => number | undefined;

/** The arguments of a variadic call (the EABI: r3-r10 then the stack; doubles in f1-f8 then the stack). */
export class VarArgs {
    private gi: number; private fi = 1; private sp: number;
    constructor(private cpu: Cpu, firstGpr: number) { this.gi = firstGpr; this.sp = cpu.gpr[1] + 8; }
    int(): number {
        if (this.gi <= 10) return this.cpu.gpr[this.gi++];
        const v = this.cpu.mem.r32(this.sp); this.sp += 4; return v;
    }
    double(): number {
        if (this.fi <= 8) return this.cpu.ps0[this.fi++];
        this.sp = (this.sp + 7) & ~7;
        const b = new DataView(new ArrayBuffer(8)); b.setUint32(0, this.cpu.mem.r32(this.sp)); b.setUint32(4, this.cpu.mem.r32(this.sp + 4)); this.sp += 8;
        return b.getFloat64(0);
    }
}
/** printf's formatting, enough for the game's messages */
export function format(cpu: Cpu, fmtAddr: number, args: VarArgs): string {
    const fmt = cpu.mem.cstr(fmtAddr, 2048);
    return fmt.replace(/%([-+ 0#]*)(\d+|\*)?(?:\.(\d+|\*))?(hh|h|ll|l|L)?([diouxXcspfFeEgG%])/g, (_m, flags: string, width: string, prec: string, _len: string, conv: string) => {
        if (conv === '%') return '%';
        if (width === '*') width = String(args.int() | 0);
        if (prec === '*') prec = String(args.int() | 0);
        let s: string;
        switch (conv) {
            case 'd': case 'i': s = String(args.int() | 0); break;
            case 'u': s = String(args.int() >>> 0); break;
            case 'o': s = (args.int() >>> 0).toString(8); break;
            case 'x': s = (args.int() >>> 0).toString(16); break;
            case 'X': s = (args.int() >>> 0).toString(16).toUpperCase(); break;
            case 'p': s = '0x' + (args.int() >>> 0).toString(16).padStart(8, '0'); break;
            case 'c': s = String.fromCharCode(args.int() & 0xFF); break;
            case 's': { const a = args.int(); s = a ? cpu.mem.cstr(a, 1024) : '(null)'; if (prec !== undefined) s = s.slice(0, +prec); break; }
            default: { const v = args.double(); s = conv === 'e' || conv === 'E' ? v.toExponential(prec === undefined ? 6 : +prec) : v.toFixed(prec === undefined ? 6 : +prec); break; }
        }
        if (prec !== undefined && 'diouxX'.includes(conv)) s = s.replace(/^(-?)(.*)$/, (_a, sg: string, d: string) => sg + d.padStart(+prec, '0'));
        const w = width ? +width : 0;
        if (s.length < w) s = flags.includes('-') ? s.padEnd(w) : flags.includes('0') && conv !== 's' ? s.replace(/^(-?)(.*)$/, (_a, sg: string, d: string) => sg + d.padStart(w - sg.length, '0')) : s.padStart(w);
        return s;
    });
}

export interface HleOptions {
    /** the game's console output (OSReport) */
    report?: (text: string) => void;
}

export function installHle(m: Machine, sym: Sym, opt: HleOptions = {}) {
    const cpu = m.cpu, missing: string[] = [];
    const on = (name: string, fn: (cpu: Cpu) => boolean | void) => {
        const a = sym(name);
        if (a === undefined) { missing.push(name); return; }
        cpu.hook(a, fn);
    };
    const nop = () => { };

    // ---- the DSP's boot handshake and the sample-rate calibration (no DSP program runs, audio is off)
    on('__OSInitAudioSystem', nop); on('__OSStopAudioSystem', nop);
    on('__AI_SRC_INIT', nop);
    // ---- JAudio's DSP program: never booted, its command mails dropped. The audio thread still sets its own
    //      structures up (the main thread's sound calls use them), then waits for audio interrupts that never come.
    on('DspBoot__FPFPv_v', nop);
    on('DSPSendCommands2__FPUlUlPFUs_v', (c) => { c.gpr[3] = 0; });
    on('DsetupTable__FUlUlUlUlUl', nop);
    // ---- cache maintenance: no cache is modelled (memory is always coherent)
    for (const n of ['DCFlushRange', 'DCFlushRangeNoSync', 'DCInvalidateRange', 'DCStoreRange', 'DCStoreRangeNoSync']) if (sym(n) !== undefined) on(n, nop);
    //      (instructions were changed: the blocks compiled from the old ones go)
    if (sym('ICInvalidateRange') !== undefined) on('ICInvalidateRange', (c) => { c.invalidateCode(c.gpr[3], c.gpr[4]); });
    if (sym('ICFlashInvalidate') !== undefined) on('ICFlashInvalidate', (c) => { c.invalidateCode(); });
    // ---- the console
    on('OSReport', (c) => { if (opt.report) opt.report(format(c, c.gpr[3], new VarArgs(c, 4))); });
    on('OSPanic', (c) => {
        const file = c.mem.cstr(c.gpr[3]), line = c.gpr[4] | 0;
        throw new Error(`OSPanic at ${file}:${line}: ${format(c, c.gpr[5], new VarArgs(c, 6))}`);
    });
    // ---- the OS's idle loop (in SelectThread, with interrupts on, while no thread can run): skip to the next event.
    //      Found by its shape: lwz r0, RunQueueBits(r13); cmplwi r0, 0; beq -8
    const st = sym('SelectThread');
    if (st !== undefined) {
        let found = 0;
        for (let a = st; a < st + 0x200; a += 4) {
            const i0 = m.mem.r32(a), i1 = m.mem.r32(a + 4), i2 = m.mem.r32(a + 8);
            if ((i0 >>> 16) === 0x800D && (i1 === 0x2C000000 || i1 === 0x28000000) && i2 === 0x4182FFF8) { found = a; break; }
        }
        if (!found) missing.push('SelectThread idle loop');
        else {
            const bits = (m.mem.r32(found) << 16) >> 16;   // RunQueueBits' offset from r13
            cpu.hook(found, (c) => { if (c.mem.r32(c.gpr[13] + bits) === 0 && (c.msr & 0x8000)) m.idle(); return false; });
        }
    }
    return missing;
}
