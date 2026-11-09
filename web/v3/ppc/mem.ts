// v3: the GameCube's memory as the game sees it. MEM1 (24 MB) at 0x80000000 (cached) and 0xC0000000
// (uncached); physical addresses while the MMU is off (exception entry); the locked L1 cache at
// 0xE0000000 (16 KB); hardware registers at 0xCC000000 and the embedded frame buffer at 0xC8000000,
// both handed to the hardware model. Big-endian, like the Gekko.

export const MEM1_SIZE = 0x01800000;
export const LC_BASE = 0xE0000000, LC_SIZE = 0x4000;

export interface Mmio {
    read(addr: number, size: number): number;
    write(addr: number, size: number, value: number): void;
}

export class MemFault extends Error {
    constructor(public addr: number, public size: number, public write: boolean) {
        super(`memory fault: ${write ? 'write' : 'read'} of ${size} at 0x${(addr >>> 0).toString(16)}`);
    }
}

export class Memory {
    readonly ram = new Uint8Array(MEM1_SIZE);
    readonly dv = new DataView(this.ram.buffer);
    readonly lc = new Uint8Array(LC_SIZE);
    readonly lcdv = new DataView(this.lc.buffer);
    mmio: Mmio | null = null;
    /** MSR[DR] is off: data addresses are physical (the CPU keeps this in step with its MSR) */
    real = false;

    // The fast path is the cached mirror; everything else goes through the slow path.
    r8(a: number): number { const o = (a ^ 0x80000000) >>> 0; return o < MEM1_SIZE ? this.ram[o] : this.slowR(a >>> 0, 1); }
    r16(a: number): number { const o = (a ^ 0x80000000) >>> 0; return o < MEM1_SIZE - 1 ? this.dv.getUint16(o) : this.slowR(a >>> 0, 2); }
    r32(a: number): number { const o = (a ^ 0x80000000) >>> 0; return o < MEM1_SIZE - 3 ? this.dv.getUint32(o) : this.slowR(a >>> 0, 4); }
    w8(a: number, v: number) { const o = (a ^ 0x80000000) >>> 0; if (o < MEM1_SIZE) this.ram[o] = v; else this.slowW(a >>> 0, 1, v); }
    w16(a: number, v: number) { const o = (a ^ 0x80000000) >>> 0; if (o < MEM1_SIZE - 1) this.dv.setUint16(o, v); else this.slowW(a >>> 0, 2, v); }
    w32(a: number, v: number) { const o = (a ^ 0x80000000) >>> 0; if (o < MEM1_SIZE - 3) this.dv.setUint32(o, v); else this.slowW(a >>> 0, 4, v); }

    /** the offset in RAM of an address outside the fast path, or -1 (MMIO / EFB), or -2 (the locked cache) */
    private where(a: number, size: number, write: boolean): number {
        const top = a >>> 24;
        if (top >= 0xC8 && top <= 0xCD) return -1;
        if (a >= 0xC0000000 && a <= 0xC0000000 + MEM1_SIZE - size) return a - 0xC0000000;
        if (a >= LC_BASE && a <= LC_BASE + LC_SIZE - size) return -2;
        if (this.real && a <= MEM1_SIZE - size) return a;
        throw new MemFault(a, size, write);
    }
    private slowR(a: number, size: number): number {
        const o = this.where(a, size, false);
        if (o === -1) { if (!this.mmio) throw new MemFault(a, size, false); return this.mmio.read(a, size) >>> 0; }
        const dv = o === -2 ? this.lcdv : this.dv, p = o === -2 ? a - LC_BASE : o;
        return size === 1 ? dv.getUint8(p) : size === 2 ? dv.getUint16(p) : dv.getUint32(p);
    }
    private slowW(a: number, size: number, v: number) {
        const o = this.where(a, size, true);
        if (o === -1) { if (!this.mmio) throw new MemFault(a, size, true); this.mmio.write(a, size, v >>> 0); return; }
        const dv = o === -2 ? this.lcdv : this.dv, p = o === -2 ? a - LC_BASE : o;
        if (size === 1) dv.setUint8(p, v); else if (size === 2) dv.setUint16(p, v); else dv.setUint32(p, v);
    }

    /** a view of RAM at a cached or physical address (host-side copies: DVD, ARAM, HLE) */
    bytes(a: number, n: number) { const o = (a >>> 0) & 0x3FFFFFFF; if (o + n > MEM1_SIZE) throw new MemFault(a, n, false); return this.ram.subarray(o, o + n); }
    cstr(a: number, max = 512) { let s = ''; for (let i = 0; i < max; i++) { const c = this.r8(a + i); if (!c) break; s += String.fromCharCode(c); } return s; }
    /** a C string's bytes (the game's names are Shift-JIS) */
    cbytes(a: number, max = 512) { let n = 0; while (n < max && this.r8(a + n)) n++; return this.bytes(a, n); }
}

/** Loads a DOL (the user's main.dol) into memory; returns its entry point, BSS range and sections. */
export function loadDol(mem: Memory, dol: Uint8Array) {
    const dv = new DataView(dol.buffer, dol.byteOffset, dol.byteLength);
    // (the BSS range covers the small-data sections too, so it is cleared first)
    const bss = dv.getUint32(0xD8), bssSize = dv.getUint32(0xDC), entry = dv.getUint32(0xE0);
    mem.ram.fill(0, bss & 0x0FFFFFFF, (bss & 0x0FFFFFFF) + bssSize);
    const sections: { addr: number; size: number; text: boolean }[] = [];
    for (let i = 0; i < 18; i++) {
        const off = dv.getUint32(i * 4), addr = dv.getUint32(0x48 + i * 4), size = dv.getUint32(0x90 + i * 4);
        if (!size) continue;
        mem.ram.set(dol.subarray(off, off + size), addr & 0x0FFFFFFF);
        sections.push({ addr, size, text: i < 7 });
    }
    return { entry, bss, bssSize, sections };
}
