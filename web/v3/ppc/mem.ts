// v3: the GameCube's memory as the game sees it. MEM1 (24 MB) at 0x80000000 (cached) and 0xC0000000
// (uncached), the locked L1 cache at 0xE0000000 (16 KB), and hardware registers at 0xCC000000
// handed to an MMIO handler. Big-endian, like the Gekko.

export const MEM1_SIZE = 0x01800000;
export const LC_BASE = 0xE0000000, LC_SIZE = 0x4000;

export interface Mmio {
    read(addr: number, size: 1 | 2 | 4): number;
    write(addr: number, size: 1 | 2 | 4, value: number): void;
}

export class Memory {
    readonly ram = new Uint8Array(MEM1_SIZE);
    readonly dv = new DataView(this.ram.buffer);
    readonly lc = new Uint8Array(LC_SIZE);
    readonly lcdv = new DataView(this.lc.buffer);
    mmio: Mmio | null = null;

    /** [view, offset] for a virtual address, or null for MMIO */
    private map(addr: number, size: number): [DataView, number] | null {
        addr >>>= 0;
        const seg = addr >>> 28;
        if (seg === 0x8 || seg === 0x0 || seg === 0x9) {
            const o = addr & 0x0FFFFFFF;
            if (o + size <= MEM1_SIZE) return [this.dv, o];
        } else if (seg === 0xC || seg === 0xD) {
            if ((addr >>> 24) === 0xCC) return null;
            const o = addr & 0x0FFFFFFF;
            if (o + size <= MEM1_SIZE) return [this.dv, o];
        } else if (seg === 0xE) {
            const o = addr - LC_BASE;
            if (o >= 0 && o + size <= LC_SIZE) return [this.lcdv, o];
        }
        throw new MemFault(addr, size);
    }
    r8(a: number) { const m = this.map(a, 1); return m ? m[0].getUint8(m[1]) : this.io(a, 1); }
    r16(a: number) { const m = this.map(a, 2); return m ? m[0].getUint16(m[1]) : this.io(a, 2); }
    r32(a: number) { const m = this.map(a, 4); return m ? m[0].getUint32(m[1]) : this.io(a, 4); }
    w8(a: number, v: number) { const m = this.map(a, 1); if (m) m[0].setUint8(m[1], v); else this.iow(a, 1, v); }
    w16(a: number, v: number) { const m = this.map(a, 2); if (m) m[0].setUint16(m[1], v); else this.iow(a, 2, v); }
    w32(a: number, v: number) { const m = this.map(a, 4); if (m) m[0].setUint32(m[1], v >>> 0); else this.iow(a, 4, v); }
    /** raw 8 bytes (a double's bits) into a 2-word [lo, hi] host array */
    r64(a: number, out: Uint32Array, i: number) { out[i + 1] = this.r32(a); out[i] = this.r32(a + 4); }
    w64(a: number, src: Uint32Array, i: number) { this.w32(a, src[i + 1]); this.w32(a + 4, src[i]); }
    private io(a: number, s: 1 | 2 | 4) { if (!this.mmio) throw new MemFault(a, s); return this.mmio.read(a >>> 0, s) >>> 0; }
    private iow(a: number, s: 1 | 2 | 4, v: number) { if (!this.mmio) throw new MemFault(a, s); this.mmio.write(a >>> 0, s, v >>> 0); }
    bytes(a: number, n: number) { const o = (a >>> 0) & 0x0FFFFFFF; return this.ram.subarray(o, o + n); }
    cstr(a: number, max = 256) { let s = ''; for (let i = 0; i < max; i++) { const c = this.r8(a + i); if (!c) break; s += String.fromCharCode(c); } return s; }
}

export class MemFault extends Error {
    constructor(public addr: number, public size: number) { super(`memory fault at 0x${(addr >>> 0).toString(16)} (${size})`); }
}

/** Loads a DOL (the user's main.dol) into memory; returns its entry point and BSS range. */
export function loadDol(mem: Memory, dol: Uint8Array) {
    const dv = new DataView(dol.buffer, dol.byteOffset, dol.byteLength);
    // (the BSS range covers the small-data sections too, so it is cleared first)
    const bss = dv.getUint32(0xD8), bssSize = dv.getUint32(0xDC), entry = dv.getUint32(0xE0);
    mem.ram.fill(0, bss & 0x0FFFFFFF, (bss & 0x0FFFFFFF) + bssSize);
    for (let i = 0; i < 18; i++) {
        const off = dv.getUint32(i * 4), addr = dv.getUint32(0x48 + i * 4), size = dv.getUint32(0x90 + i * 4);
        if (!size) continue;
        mem.ram.set(dol.subarray(off, off + size), addr & 0x0FFFFFFF);
    }
    return { entry, bss, bssSize };
}
