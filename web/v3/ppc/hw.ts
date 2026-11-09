// v3: the little of the GameCube's hardware that the game's boot and frame loop need, at register level.
// PI (interrupt cause / mask), DSP's ARAM DMA (the 16 MB ARAM, copied at once), EXI (transfers
// complete at once, nothing attached), VI (the retrace interrupt on a timer), the GX write-gather pipe
// (discarded). Unknown registers read back what was written.
import type { Mmio } from './mem.js';
import type { Cpu } from './cpu.js';

export const ARAM_SIZE = 0x1000000;

// PI interrupt causes (INTSR bits)
export const PI_DSP = 1 << 6, PI_VI = 1 << 8, PI_EXI = 1 << 4, PI_DI = 1 << 2, PI_SI = 1 << 3, PI_AI = 1 << 5, PI_PE_TOKEN = 1 << 9, PI_PE_FINISH = 1 << 10;

export class Hardware implements Mmio {
    regs = new Map<number, number>();   // by address & 0xFFFFFF, as written (16- or 32-bit)
    aram = new Uint8Array(ARAM_SIZE);
    piCause = 0; piMask = 0;
    dspCsr = 0;
    log: ((s: string) => void) | null = null;
    constructor(public cpu: Cpu) { }

    read(addr: number, size: 1 | 2 | 4): number {
        const a = addr & 0xFFFFFF;
        switch (a) {
            case 0x3000: return this.piCause | 0x00010000;   // (RESETSW not pressed)
            case 0x3004: return this.piMask;
            case 0x302C: return 0x10000000;   // PI_FLIPPER revision
            case 0x500A: return this.dspCsr;
            case 0x5016: return 1;   // ARAM mode: ready
        }
        if (a >= 0x8000 && a < 0x9000) return 0;
        if (a >= 0x2000 && a < 0x2100) return size === 4 ? ((this.r16(a) << 16) | this.r16(a + 2)) >>> 0 : this.r16(a & ~1);
        return this.regs.get(a) ?? 0;
    }
    write(addr: number, size: 1 | 2 | 4, v: number): void {
        const a = addr & 0xFFFFFF;
        if (a >= 0x8000 && a < 0x9000) return;   // the GX FIFO: the viewer draws, not the GPU
        switch (a) {
            case 0x3000: this.piCause &= ~v; return;   // write 1 to clear
            case 0x3004: this.piMask = v >>> 0; return;
            case 0x500A: {
                // write 1 to clear DSPINT (0x80), ARINT (0x20), AIDINT (0x08); RES (bit 0) completes at once
                this.dspCsr = (this.dspCsr & ~(v & 0xA8)) | (v & 0x0154);
                this.dspIrq(); return;
            }
            case 0x502A: this.regs.set(a, v); this.aramDma(); return;
            case 0x680C: case 0x6820: case 0x6834: this.regs.set(a, v & ~1); return;   // EXI: the transfer is done
        }
        if (a >= 0x2000 && a < 0x2100) {   // VI: 16-bit registers (a 32-bit write sets a pair)
            if (size === 4) { this.regs.set(a, v >>> 16); this.regs.set(a + 2, v & 0xFFFF); } else this.regs.set(a, v & 0xFFFF);
            this.viIrq(); return;
        }
        this.regs.set(a, v >>> 0);
    }
    private r16(a: number) { return (this.regs.get(a) ?? 0) & 0xFFFF; }
    private aramDma() {
        const mm = ((this.r16(0x5020) & 0x3FF) << 16 | this.r16(0x5022)) & 0x03FFFFE0;
        const ar = ((this.r16(0x5024) & 0x3FF) << 16 | this.r16(0x5026)) & 0x03FFFFE0;
        const hi = this.r16(0x5028), len = ((hi & 0x3FF) << 16 | this.r16(0x502A)) & 0x03FFFFE0;
        const toMain = (hi & 0x8000) !== 0;
        const ram = this.cpu.mem.ram;
        for (let i = 0; i < len; i++) {
            const m = (mm + i) % ram.length, r = (ar + i) % ARAM_SIZE;
            if (toMain) ram[m] = this.aram[r]; else this.aram[r] = ram[m];
        }
        this.dspCsr |= 0x20;   // ARINT
        this.dspIrq();
    }
    private dspIrq() {
        // DSP interrupts reach PI when their mask bit (the bit above each status bit) is set
        const pend = ((this.dspCsr & 0x80) && (this.dspCsr & 0x100)) || ((this.dspCsr & 0x20) && (this.dspCsr & 0x40)) || ((this.dspCsr & 0x08) && (this.dspCsr & 0x10));
        if (pend) this.piCause |= PI_DSP; else this.piCause &= ~PI_DSP;
    }
    raise(cause: number) { this.piCause |= cause; }
    /** the retrace: each enabled display interrupt (VI_DIn, bit 12 of its high half) raises its status (bit 15) */
    retrace() { for (const r of [0x2030, 0x2034, 0x2038, 0x203C]) { const v = this.r16(r); if (v & 0x1000) this.regs.set(r, v | 0x8000); } this.viIrq(); }
    private viIrq() { let p = false; for (const r of [0x2030, 0x2034, 0x2038, 0x203C]) if (this.r16(r) & 0x8000) p = true; if (p) this.piCause |= PI_VI; else this.piCause &= ~PI_VI; }
    /** an external interrupt is pending and enabled */
    pending() { return (this.piCause & this.piMask) !== 0; }
}
