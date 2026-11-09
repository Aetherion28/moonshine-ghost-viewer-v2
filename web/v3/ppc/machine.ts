// v3: the CPU, memory and hardware together, with time: the time base, the decrementer and the
// video retrace. One time-base tick per 12 instructions (the Gekko at 486 MHz, the bus at 162 MHz,
// the time base at bus / 4); the retrace every 1/60 s of time base.
import { Memory, loadDol } from './mem.js';
import { Cpu } from './cpu.js';
import { Hardware } from './hw.js';

export const TB_PER_INSTR = 12;
export const TB_HZ = 40_500_000;

export class Machine {
    mem = new Memory();
    cpu = new Cpu(this.mem);
    hw = new Hardware(this.cpu);
    private sub = 0;
    nextRetrace = TB_HZ / 60;
    retraces = 0;
    constructor() { this.mem.mmio = this.hw; }

    load(dol: Uint8Array) {
        const { entry } = loadDol(this.mem, dol);
        const m = this.mem;
        // low memory as the IPL leaves it (OSInit reads these)
        m.w32(0x80000000, 0x474D534A); m.w32(0x80000004, 0x30310000);   // the disc ID (GMSJ01)
        m.w32(0x8000001C, 0xC2339F3D);   // the GameCube disc magic
        m.w32(0x80000028, 0x01800000); m.w32(0x8000002C, 1);   // memory size, console type: retail
        m.w32(0x800000F0, 0x01800000);
        m.w32(0x800000F8, 162_000_000); m.w32(0x800000FC, 486_000_000);   // bus and CPU clocks
        this.cpu.msr = 0x2032; this.cpu.pc = entry; this.cpu.lr = 0;
        return entry;
    }

    /** one instruction, then time and interrupts */
    step() {
        const c = this.cpu;
        c.step();
        if (++this.sub >= TB_PER_INSTR) {
            this.sub = 0;
            c.tb += 1n;
            const was = c.dec;
            c.dec = (c.dec - 1) >>> 0;
            if (!(was & 0x80000000) && (c.dec & 0x80000000)) this.decPending = true;
            if (Number(c.tb) >= this.nextRetrace) { this.nextRetrace += TB_HZ / 60; this.retrace(); }
        }
        if (c.msr & 0x8000) {   // MSR[EE]
            if (this.hw.pending()) c.exception(0x500, c.pc);
            else if (this.decPending) { this.decPending = false; c.exception(0x900, c.pc); }
        }
    }
    decPending = false;
    private retrace() { this.retraces++; this.hw.retrace(); }
}
