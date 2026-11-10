// The script format of tools/hwprobe (big-endian, as the console reads it):
//   header: 'GXPS', version 1, the arena's size in bytes, 0
//   operations: op, a, b, the payload's length, the payload (padded to 4 bytes)
// The arena is one block of the console's RAM (8 MB), 32-byte aligned; places in it are offsets.
// The answer: 'GXPO', 1, the program's version, 0; then records (kind, a, b, length, data padded to 4 bytes):
// 100 the console (Hollywood's revision, the CPU's, the arena's address), DUMP / MEMRLE a saved block (packed if
// smaller), READ16 registers, 102 why the script stopped, 101 the end (operations run, blocks saved).
export const OP = {
    END: 0,
    /** payload -> arena + a (then flushed out of the CPU's cache) */
    MEM: 1,
    /** payload -> the GPU's command stream */
    FIFO: 2,
    /** a BP register (a) loaded with the address of arena + b (>> 5) */
    BPADDR: 3,
    /** wait until the GPU has drawn everything sent */
    SYNC: 4,
    /** b bytes at arena + a -> the answer file */
    DUMP: 5,
    /** a CP register (a: an array's base) loaded with the address of arena + b (b signed) */
    CPADDR: 6,
    /** b 16-bit hardware registers from address a -> the answer file */
    READ16: 7,
    /** payload: a line of text for the screen */
    NOTE: 8,
    /** as MEM, the payload packed (rleEncode); b: the unpacked length */
    MEMRLE: 9,
    /** the program leaves once the script is done */
    QUIT: 10,
} as const;

/** Runs of a byte packed: a control byte c, then c + 1 bytes as they are (c < 128) or one byte to repeat c - 126 times. */
export function rleEncode(s: Uint8Array): Uint8Array {
    const d: number[] = [], n = s.length;
    for (let i = 0; i < n;) {
        let run = 1;
        while (i + run < n && run < 129 && s[i + run] === s[i]) run++;
        if (run >= 3) { d.push(run + 126, s[i]); i += run; continue; }
        const start = i; let len = 0;
        while (i < n && len < 128) {
            let r = 1; while (i + r < n && r < 3 && s[i + r] === s[i]) r++;
            if (r >= 3) break;
            i++; len++;
        }
        d.push(len - 1); for (let k = 0; k < len; k++) d.push(s[start + k]);
    }
    return Uint8Array.from(d);
}
export function rleDecode(s: Uint8Array, n: number): Uint8Array {
    const d = new Uint8Array(n); let o = 0;
    for (let i = 0; i < s.length;) {
        const c = s[i++];
        if (c < 128) { d.set(s.subarray(i, i + c + 1), o); i += c + 1; o += c + 1; } else { d.fill(s[i++], o, o + c - 126); o += c - 126; }
    }
    if (o !== n) throw new Error('a packed block of the wrong length');
    return d;
}
export interface Op { op: number; a: number; b: number; data?: Uint8Array }

export class Script {
    ops: Op[] = [];
    arena = 0;
    private pend: number[] = [];
    private flush() { if (this.pend.length) { this.ops.push({ op: OP.FIFO, a: 0, b: 0, data: Uint8Array.from(this.pend) }); this.pend = []; } }
    fifo(b: ArrayLike<number>) { for (let i = 0; i < b.length; i++) this.pend.push(b[i]); if (this.pend.length > 60000) this.flush(); }
    /** (in pieces the console's buffer holds) */
    mem(at: number, data: Uint8Array) {
        this.flush();
        for (let o = 0; o < data.length; o += 0x10000) {
            const raw = data.slice(o, o + 0x10000), packed = rleEncode(raw);
            if (packed.length < raw.length) this.ops.push({ op: OP.MEMRLE, a: at + o, b: raw.length, data: packed }); else this.ops.push({ op: OP.MEM, a: at + o, b: 0, data: raw });
        }
    }
    bpAddr(reg: number, at: number) { this.flush(); this.ops.push({ op: OP.BPADDR, a: reg, b: at }); }
    cpAddr(reg: number, at: number) { this.flush(); this.ops.push({ op: OP.CPADDR, a: reg, b: at >>> 0 }); }
    sync() { this.flush(); this.ops.push({ op: OP.SYNC, a: 0, b: 0 }); }
    dump(at: number, n: number) { this.flush(); this.ops.push({ op: OP.DUMP, a: at, b: n }); }
    read16(addr: number, n: number) { this.flush(); this.ops.push({ op: OP.READ16, a: addr >>> 0, b: n }); }
    note(text: string) { this.flush(); this.ops.push({ op: OP.NOTE, a: 0, b: 0, data: new TextEncoder().encode(text) }); }
    bytes(): Uint8Array {
        this.flush();
        let n = 16 + 16;
        for (const o of this.ops) n += 16 + (((o.data?.length ?? 0) + 3) & ~3);
        const out = new Uint8Array(n), v = new DataView(out.buffer);
        v.setUint32(0, 0x47585053); v.setUint32(4, 1); v.setUint32(8, (this.arena + 31) & ~31);
        let p = 16;
        for (const o of [...this.ops, { op: OP.END, a: 0, b: 0 } as Op]) {
            v.setUint32(p, o.op); v.setUint32(p + 4, o.a >>> 0); v.setUint32(p + 8, o.b >>> 0); v.setUint32(p + 12, o.data?.length ?? 0);
            if (o.data) out.set(o.data, p + 16);
            p += 16 + (((o.data?.length ?? 0) + 3) & ~3);
        }
        return out;
    }
}

export function readScript(b: Uint8Array): { arena: number; ops: Op[] } {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (v.getUint32(0) !== 0x47585053 || v.getUint32(4) !== 1) throw new Error('not a hwprobe script');
    const ops: Op[] = [];
    for (let p = 16; p + 16 <= b.length;) {
        const op = v.getUint32(p), len = v.getUint32(p + 12);
        if (op === OP.END) break;
        ops.push({ op, a: v.getUint32(p + 4), b: v.getUint32(p + 8), data: len ? b.slice(p + 16, p + 16 + len) : undefined });
        p += 16 + ((len + 3) & ~3);
    }
    return { arena: v.getUint32(8), ops };
}
