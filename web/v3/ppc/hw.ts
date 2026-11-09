// v3: the little of the GameCube's hardware that the game needs to boot and run its frames, at register
// level. The registers at 0xCC00xxxx read back what was written unless a device says otherwise:
//   CP / PE   the GPU's command and pixel engines: always idle; the FIFO's bytes are counted and dropped
//             (the viewer draws); draw-done and draw-sync tokens are raised by HLE (hle.ts)
//   VI        the beam position from the time, and its display interrupts at the retrace
//   PI        interrupt cause and mask, the FIFO's write pointer
//   DSP       the ARAM (16 MB) and its DMA, done at once; no DSP program runs
//   DI        the disc drive: reads from a virtual disc (disc.ts), done after a short delay
//   SI / EXI  nothing attached: transfers complete at once and read zero
// The embedded frame buffer (0xC8000000, GXPeekZ / GXPeekARGB) reads through efbPeek.
import type { Mmio } from './mem.js';
import type { Machine } from './machine.js';
import type { VirtualDisc } from './disc.js';

export const ARAM_SIZE = 0x1000000;

// PI interrupt causes (INTSR bits)
export const PI_ERROR = 1 << 0, PI_RSW = 1 << 1, PI_DI = 1 << 2, PI_SI = 1 << 3, PI_EXI = 1 << 4, PI_AI = 1 << 5, PI_DSP = 1 << 6,
    PI_MEM = 1 << 7, PI_VI = 1 << 8, PI_PE_TOKEN = 1 << 9, PI_PE_FINISH = 1 << 10, PI_CP = 1 << 11, PI_DEBUG = 1 << 12, PI_HSP = 1 << 13;

/** instructions per video field: NTSC's 59.94 Hz (JP / US), PAL's 50 Hz */
export const FIELD_NTSC = Math.round(486_000_000 / 59.94), FIELD_PAL = 486_000_000 / 50;

export class Hardware implements Mmio {
    /** 0xCC000000..0xCC00FFFF as last written (big-endian) */
    io = new Uint8Array(0x10000);
    private dv = new DataView(this.io.buffer);
    aram = new Uint8Array(ARAM_SIZE);
    piCause = 0; piMask = 0;
    disc: VirtualDisc | null = null;
    /** a read of the embedded frame buffer (the Z or colour at a pixel): the trace's feedback records answer these */
    efbPeek: (addr: number, size: number) => number = () => 0;
    /** bytes the game wrote to the GX FIFO (dropped) */
    fifoBytes = 0;
    /** instructions per field, lines per frame (NTSC interlaced: 525) */
    field = FIELD_NTSC; lines = 525;
    private fieldStart = 0; private fieldNo = 0;
    /** instructions a disc read takes to complete (the drive's speed isn't modelled: the game only waits for it) */
    discDelay = 20_000;
    /** log of unusual accesses (debugging) */
    log: ((s: string) => void) | null = null;
    diReads = 0; diBytes = 0;

    constructor(public m: Machine) { }

    // ---------------------------------------------------------------- interrupts
    private setCause(bit: number, on: boolean) {
        this.piCause = on ? this.piCause | bit : this.piCause & ~bit;
        this.m.cpu.setExtIrq((this.piCause & this.piMask) !== 0);
    }

    // ---------------------------------------------------------------- register access
    private r16(a: number) { return this.dv.getUint16(a); }
    private r32(a: number) { return this.dv.getUint32(a); }
    private w16(a: number, v: number) { this.dv.setUint16(a, v); }
    private w32(a: number, v: number) { this.dv.setUint32(a, v); }
    private raw(a: number, size: number) { return size === 4 ? this.dv.getUint32(a) : size === 2 ? this.dv.getUint16(a) : this.io[a]; }
    private store(a: number, size: number, v: number) { if (size === 4) this.dv.setUint32(a, v); else if (size === 2) this.dv.setUint16(a, v); else this.io[a] = v; }

    read(addr: number, size: number): number {
        if ((addr >>> 24) < 0xCC) return this.efbPeek(addr, size);
        const a = addr & 0xFFFF;
        if (a >= 0x8000) return 0;   // the FIFO is write-only
        switch (a & 0xFF00) {
            case 0x0000:   // CP
                if (a === 0x00) return 0x000C;   // status: the GPU is idle (read idle, command idle)
                if (a === 0x30 || a === 0x32) return 0;   // FIFO read-write distance: all consumed
                if (a === 0x38) return this.r16(0x34); if (a === 0x3A) return this.r16(0x36);   // the read pointer follows the write pointer
                break;
            case 0x1000:   // PE
                if (a === 0x100A) return this.r16(a) & 3;   // the interrupt bits are write-only (a 1 acknowledges): they read 0
                break;
            case 0x2000:   // VI
                if (a === 0x202C) return this.beam()[0];
                if (a === 0x202E) return this.beam()[1];
                break;
            case 0x3000:   // PI
                if (a === 0x3000) return (this.piCause | 0x10000) >>> 0;   // (the reset switch isn't pressed)
                if (a === 0x3004) return this.piMask;
                if (a === 0x302C) return 0x246500B1;   // the Flipper's revision
                break;
            case 0x5000:   // DSP
                if (a === 0x5004 || a === 0x5006) return 0;   // no mail from the DSP
                if (a === 0x5000) return this.r16(a) & 0x7FFF;   // mail to the DSP is taken at once
                if (a === 0x5016) return this.r16(a) | 1;   // ARAM mode: ready
                break;
        }
        return this.raw(a, size) >>> 0;
    }

    write(addr: number, size: number, v: number): void {
        if ((addr >>> 24) < 0xCC) return;   // (EFB pokes)
        const a = addr & 0xFFFF;
        if (a >= 0x8000) { this.fifo(size, v); return; }
        switch (a & 0xFF00) {
            case 0x1000:   // PE
                if (a === 0x100A) {   // interrupt status: the enables stay, a 1 clears the token (4) / finish (8) interrupt
                    const cur = this.r16(a), nv = ((cur & ~(v & 0xC)) & 0xC) | (v & 3);
                    this.w16(a, nv);
                    this.setCause(PI_PE_TOKEN, (nv & 4) !== 0 && (nv & 1) !== 0); this.setCause(PI_PE_FINISH, (nv & 8) !== 0 && (nv & 2) !== 0);
                    return;
                }
                break;
            case 0x2000:   // VI
                this.store(a, size, v); this.viIrq(); return;
            case 0x3000:   // PI
                if (a === 0x3000) { this.setCause(v & (PI_ERROR | PI_RSW | PI_DEBUG), false); return; }
                if (a === 0x3004) { this.piMask = v >>> 0; this.setCause(0, false); return; }
                if (a === 0x3014) { this.w32(a, v & ~0x04000000); this.fifoPartial = 0; return; }   // the FIFO's write pointer
                break;
            case 0x5000:   // DSP
                if (a === 0x500A) {
                    // CSR: a 1 clears DSPINT (0x80), ARINT (0x20), AIDINT (0x08); the masks (0x150) and halt (4) are kept; reset (1, 0x800) completes at once
                    const cur = this.r16(a);
                    this.w16(a, ((cur & 0xA8) & ~(v & 0xA8)) | (v & 0x0154)); this.dspIrq(); return;
                }
                if (a === 0x5028) { this.w16(a, v); return; }
                if (a === 0x502A) { this.w16(a, v); this.aramDma(); return; }
                break;
            case 0x6000:   // DI
                if (a < 0x6040) { this.diWrite(a, size, v); return; }
                break;
            case 0x6400:   // SI
                if (a === 0x6434) { this.w32(a, v & ~1 & 0x7FFFFFFF); return; }   // the transfer is done (nothing answers)
                if (a === 0x6438) { this.w32(a, 0); return; }   // SISR: no errors, outputs copied
                break;
            case 0x6800:   // EXI
                if (a === 0x680C || a === 0x6820 || a === 0x6834) { this.w32(a, v & ~1); this.w32(a + 4, 0); return; }   // the transfer is done; it read zeros
                if (a === 0x6800 || a === 0x6814 || a === 0x6828) { this.w32(a, v & ~0x080A & 0x3FFF); return; }   // CSR: a 1 clears the interrupts; nothing is attached (EXT 0)
                break;
            case 0x6C00:   // AI
                if (a === 0x6C00) { this.w32(a, v & ~0x28); return; }   // AICR: the interrupt cleared, the sample counter reset done
                break;
        }
        this.store(a, size, v);
    }

    // ---------------------------------------------------------------- GX FIFO
    private fifoPartial = 0;
    private fifoLast = -1;
    /** instructions from a draw-done / draw-sync command being written to the GPU's interrupt for it */
    gpuDelay = 3_000;
    /** Bytes written through the write-gather pipe advance the FIFO's write pointer by 32 at a time. Nothing is
     *  drawn; of the stream only the commands the game waits on are noticed, by their shape (a BP register load:
     *  the byte 0x61, then the word): 0x45 the frame is done, 0x48 a draw-sync token with its interrupt. */
    private fifo(n: number, v: number) {
        if (n === 4 && this.fifoLast === 0x61) {
            const reg = v >>> 24;
            if (reg === 0x45 && (v & 2)) this.m.after(this.gpuDelay, () => this.peFinish());
            else if (reg === 0x48) { const token = v & 0xFFFF; this.m.after(this.gpuDelay, () => this.peToken(token)); }
        }
        this.fifoLast = n === 1 ? v : -1;
        this.fifoBytes += n;
        this.fifoPartial += n;
        if (this.fifoPartial >= 32) {
            let wp = this.r32(0x3014) & 0x03FFFFE0;
            const end = this.r32(0x3010) & 0x03FFFFE0, base = this.r32(0x300C) & 0x03FFFFE0;
            while (this.fifoPartial >= 32) { this.fifoPartial -= 32; wp = wp === end ? base : wp + 32; }
            this.w32(0x3014, wp);
        }
    }
    /** GXSetDrawSync's token reaching the pixel engine: its interrupt, if enabled */
    peToken(token: number) {
        this.w16(0x100E, token & 0xFFFF);
        const s = this.r16(0x100A) | 4; this.w16(0x100A, s);
        this.setCause(PI_PE_TOKEN, (s & 1) !== 0);
    }
    /** the frame's last command drawn (GXSetDrawDone) */
    peFinish() {
        const s = this.r16(0x100A) | 8; this.w16(0x100A, s);
        this.setCause(PI_PE_FINISH, (s & 2) !== 0);
    }

    // ---------------------------------------------------------------- VI
    /** the beam's [line (1..lines), half-line position (1..)] now */
    private beam(): [number, number] {
        const linesPerField = this.lines / 2;
        const frac = Math.min(0.999999, (this.m.cpu.count - this.fieldStart) / this.field);
        const pos = ((this.fieldNo & 1) + frac) * linesPerField;   // lines into the frame
        const line = Math.floor(pos);
        return [1 + line, 1 + Math.floor((pos - line) * 858)];
    }
    /** a field begins: the display interrupts whose line was passed since the last one are raised */
    vsync() {
        const prev = (this.fieldNo & 1) * this.lines / 2;   // the line the last field began at
        this.fieldNo++; this.fieldStart = this.m.cpu.count;
        const now = (this.fieldNo & 1) * this.lines / 2;
        for (let r = 0x2030; r <= 0x203C; r += 4) {
            const hi = this.r16(r);
            if (!(hi & 0x1000)) continue;   // not enabled
            const line = (hi & 0x3FF) - 1;   // VCT of the interrupt
            const hit = prev < now ? line >= prev && line < now : line >= prev || line < now;
            if (hit) this.w16(r, hi | 0x8000);
        }
        this.viIrq();
    }
    private viIrq() {
        let p = false;
        for (let r = 0x2030; r <= 0x203C; r += 4) if (this.r16(r) & 0x8000) p = true;
        this.setCause(PI_VI, p);
    }

    // ---------------------------------------------------------------- DSP: ARAM
    private aramDma() {
        const mm = (((this.r16(0x5020) & 0x3FF) << 16) | this.r16(0x5022)) & 0x03FFFFE0;
        const ar = (((this.r16(0x5024) & 0x3FF) << 16) | this.r16(0x5026)) & 0x03FFFFE0;
        const hi = this.r16(0x5028), len = (((hi & 0x3FF) << 16) | this.r16(0x502A)) & 0x03FFFFE0;
        const toMain = (hi & 0x8000) !== 0, ram = this.m.mem.ram;
        // (a retail console has no expansion: addresses past the 16 MB read zero and writes are lost)
        for (let i = 0; i < len; i++) {
            const m = mm + i, r = ar + i;
            if (m >= ram.length) break;
            if (toMain) ram[m] = r < ARAM_SIZE ? this.aram[r] : 0; else if (r < ARAM_SIZE) this.aram[r] = ram[m];
        }
        this.w16(0x500A, this.r16(0x500A) | 0x20);   // ARINT
        this.dspIrq();
    }
    private dspIrq() {
        const c = this.r16(0x500A);
        // each interrupt reaches PI when its mask bit (the bit above its status) is set
        this.setCause(PI_DSP, ((c & 0x80) !== 0 && (c & 0x100) !== 0) || ((c & 0x20) !== 0 && (c & 0x40) !== 0) || ((c & 0x08) !== 0 && (c & 0x10) !== 0));
    }

    // ---------------------------------------------------------------- DI: the disc drive
    private diWrite(a: number, size: number, v: number) {
        if (size !== 4) throw new Error(`DI: ${size}-byte write at 0x${a.toString(16)}`);
        switch (a) {
            case 0x6000: {   // DISR: masks as written; a 1 clears DEINT (4), TCINT (0x10), BRKINT (0x40)
                const cur = this.r32(a);
                this.w32(a, ((cur & 0x54) & ~(v & 0x54)) | (v & 0x2A)); this.diIrq(); return;
            }
            case 0x6004: {   // DICVR: the cover is closed; a 1 clears CVRINT (4)
                const cur = this.r32(a);
                this.w32(a, ((cur & 4) & ~(v & 4)) | (v & 2)); this.diIrq(); return;
            }
            case 0x601C:   // DICR
                this.w32(a, v);
                if (v & 1) this.diCommand();
                return;
        }
        this.w32(a, v);
    }
    private diIrq() {
        const s = this.r32(0x6000), c = this.r32(0x6004);
        this.setCause(PI_DI, ((s & 0x10) !== 0 && (s & 8) !== 0) || ((s & 4) !== 0 && (s & 2) !== 0) || ((s & 0x40) !== 0 && (s & 0x20) !== 0) || ((c & 4) !== 0 && (c & 2) !== 0));
    }
    private diCommand() {
        const cmd = this.r32(0x6008), arg = this.r32(0x600C), len = this.r32(0x6018);
        const mar = this.r32(0x6014) & 0x03FFFFFF, dma = (this.r32(0x601C) & 2) !== 0;
        let imm = 0;
        switch (cmd >>> 24) {
            case 0xA8: {   // read (sub-command 0x40: the disc ID)
                if (!this.disc) throw new Error('DI: a read with no disc');
                const off = (cmd & 0xFF) === 0x40 ? 0 : arg * 4;
                this.disc.read(off, len, this.m.mem.ram, mar);
                this.diReads++; this.diBytes += len;
                break;
            }
            case 0x12: {   // inquiry: the drive's identity
                const p = new DataView(this.m.mem.ram.buffer, mar, 0x20);
                for (let i = 0; i < 0x20; i += 4) p.setUint32(i, 0);
                p.setUint32(0, 0x00000002); p.setUint32(4, 0x20020402); p.setUint32(8, 0x61000000);
                break;
            }
            case 0xAB: case 0xE3: case 0xE4: case 0xE1: break;   // seek, stop the motor, audio buffer config, audio stream
            case 0xE0: case 0xE2: imm = 0; break;   // request error: none; audio status
            default: throw new Error(`DI: command 0x${cmd.toString(16)}`);
        }
        this.m.after(this.discDelay, () => {
            if (dma) { this.w32(0x6014, mar + len); this.w32(0x6018, 0); } else this.w32(0x6020, imm);
            this.w32(0x601C, this.r32(0x601C) & ~1);
            this.w32(0x6000, this.r32(0x6000) | 0x10);   // TCINT
            this.diIrq();
        });
    }
}
