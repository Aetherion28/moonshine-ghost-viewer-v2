// v3: the CPU, memory and hardware together, with time. The clock is the instruction count (one
// instruction is one CPU cycle: the Gekko at 486 MHz); events (the video field, the decrementer, disc
// reads completing) are scheduled against it. When every thread sleeps the OS spins in its idle loop
// with interrupts on: the machine then skips straight to the next event.
import { Memory, loadDol } from './mem.js';
import { Cpu } from './cpu.js';
import { Hardware } from './hw.js';
import type { VirtualDisc } from './disc.js';

interface Event { at: number; id: number; fn: () => void }

export class Machine {
    mem = new Memory();
    cpu = new Cpu(this.mem);
    hw = new Hardware(this);
    private events: Event[] = [];
    private nextId = 1;
    private decEvent = 0;
    /** fields begun (the video retraces) */
    fields = 0;
    /** instructions skipped while idle */
    idleSkipped = 0;
    entry = 0;

    constructor() {
        this.mem.mmio = this.hw;
        this.cpu.onDecWrite = () => this.scheduleDec();
    }

    // ---------------------------------------------------------------- events
    at(count: number, fn: () => void): number {
        const e = { at: count, id: this.nextId++, fn };
        let i = this.events.length;
        while (i > 0 && this.events[i - 1].at > count) i--;
        this.events.splice(i, 0, e);
        if (count < this.cpu.limit) this.cpu.limit = count;   // (scheduled from inside a run: it must stop there)
        return e.id;
    }
    after(n: number, fn: () => void) { return this.at(this.cpu.count + n, fn); }
    cancel(id: number) { const i = this.events.findIndex((e) => e.id === id); if (i >= 0) this.events.splice(i, 1); }
    nextEventAt() { return this.events.length ? this.events[0].at : Infinity; }
    private scheduleDec() {
        if (this.decEvent) this.cancel(this.decEvent);
        const at = this.cpu.decZeroAt();
        this.decEvent = at === Infinity ? 0 : this.at(at, () => { this.decEvent = 0; this.cpu.setDecPending(true); });
    }

    // ---------------------------------------------------------------- boot
    /**
     * Loads the DOL and sets memory and registers up as the console's boot ROM and the disc's apploader leave them.
     * The file system table sits at the top of memory and the arena ends below it.
     */
    load(dol: Uint8Array, disc: VirtualDisc, fstPad = 0) {
        const { entry } = loadDol(this.mem, dol);
        const m = this.mem;
        this.hw.disc = disc;
        // the disc header's first 0x20 bytes (the game's ID), and the boot info the OS reads
        m.ram.set(disc.header.subarray(0, 0x20), 0);
        m.w32(0x80000020, 0x0D15EA5E);   // booted normally
        m.w32(0x80000024, 1);
        m.w32(0x80000028, 0x01800000);   // physical memory
        m.w32(0x8000002C, 3);   // console type: retail
        // the file system table at the top of memory, the arena below it
        // (fstPad: the console's own table was that much bigger, and its arena ends that much lower)
        const fst = disc.fst, fstAddr = (0x81800000 - fst.length - fstPad) & ~0x1F;
        m.ram.set(fst, fstAddr & 0x01FFFFFF);
        m.w32(0x80000030, 0); m.w32(0x80000034, fstAddr);
        m.w32(0x80000038, fstAddr); m.w32(0x8000003C, fst.length);
        m.w32(0x800000CC, disc.pal ? 1 : 0);   // the TV format the boot ROM set
        m.w32(0x800000D0, 0x01000000);   // ARAM size
        m.w32(0x800000EC, 0x81800000); m.w32(0x800000F0, 0x01800000);   // debug monitor (none), simulated memory size
        m.w32(0x800000F4, 0);   // no BI2
        m.w32(0x800000F8, 162_000_000); m.w32(0x800000FC, 486_000_000);   // bus and CPU clocks
        for (const v of [0x300, 0x800, 0xC00]) m.w32(0x80000000 + v, 0x4C000064);   // default handlers: rfi
        m.ram.set(disc.header.subarray(0, 4), 0x3180);   // the game's ID again (for the OS's reset code)
        const c = this.cpu;
        c.setMsr(0x2032);   // FP, IR, DR, RI
        c.spr[920] = 0xE0000000;   // HID2: paired singles, the locked cache and the write pipe enabled
        c.gpr[1] = 0x816FFFF0;
        c.pc = entry; c.lr = 0;
        this.entry = entry;
        this.hw.field = disc.pal ? 486_000_000 / 50 : Math.round(486_000_000 / 59.94);
        this.hw.lines = disc.pal ? 625 : 525;
        const field = () => { this.fields++; this.hw.vsync(); this.after(this.hw.field, field); };
        this.after(this.hw.field, field);
    }

    // ---------------------------------------------------------------- running
    /** Runs until the instruction count reaches `until` (or the CPU's brk is set by a hook). */
    run(until: number) {
        const c = this.cpu;
        for (;;) {
            const next = this.nextEventAt(), lim = next < until ? next : until;
            if (c.count < lim) { c.run(lim); if (c.brk) return; }
            while (this.events.length && this.events[0].at <= c.count) this.events.shift()!.fn();
            if (c.count >= until) return;
        }
    }
    /** From the OS's idle loop (no thread can run, interrupts on): skip to the next event. */
    idle() {
        const c = this.cpu, next = this.nextEventAt();
        if (next === Infinity) throw new Error('idle with no event pending: the game would hang');
        if (next > c.count) { this.idleSkipped += next - c.count; c.count = next; }
    }
}
