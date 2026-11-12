// v3: one whole captured frame of the game (web/gxframe.ts, as tests/gxdump.ts writes them) made into a job for
// tools/hwprobe, so that a real console draws it: its picture is what a renderer of the same frame is compared with.
// Run: node hwframe.mjs job <dump folder> <frame index> <out.job> [frames before]
//        The job draws [frames before] (default 1) whole frames and then the wanted one, every command going to the
//        console's GPU as the game sent it (display lists in their place in the stream), with the memory they read
//        (vertex arrays, the arrays matrices are loaded from by index, texture images, palettes) as blocks of the
//        console's arena and every address set to where its block is. A copy out of the frame buffer writes into a
//        block of the arena too, so a texture the game makes by copy is the console's own when it is sampled later.
//        Saved: each texture copy of the wanted frame, the frame buffer just before its copy to the display (RGBA8),
//        the depth buffer (Z24X8), and the copy to the display itself (YUYV). <out.job>.txt says what the job holds.
//        (XF=plain: a matrix loaded by index goes as a plain load, with the words the game's memory had.)
//      node hwframe.mjs check <out.job>
//        The job walked without a console: the stream must parse to its end, every read (indexed vertex, matrix
//        loaded by index, texture, palette) must land in memory the job has set or the console has written, every
//        copy inside the arena, no block changed under commands the GPU may not have run yet. Exit code 1 if not.
//      node hwframe.mjs picture <answer> <out.png> [which]
//        A saved block of a console's answer as a PNG: efb (the default), z, xfb, copy0, copy1, ... or a number;
//        list: only the list; all: every block, as <out>.<name>.png. (ALPHA=1: with the block's alpha; else opaque.
//        The depth buffer's 24 bits are the picture's red, green and blue, from the top byte down.)
//      node hwframe.mjs diff <a.png> <b.png> <out.png>
//        The difference of two pictures, channel by channel, and how many pixels are off by more than 8.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { decodeGxFrame, type GxFrame } from '../web/gxframe.ts';
import { OP, Script, readScript, rleEncode, rleDecode, type Op } from '../tools/hwprobe/script.ts';
import { Gx } from '../ppc/gx.ts';

const r32 = (b: Uint8Array, p: number) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const hex = (n: number) => n.toString(16);
const up32 = (n: number) => (n + 31) & ~31;
/** the game's RAM, the console's arena and the biggest operation its program takes */
const RAM_SIZE = 0x01800000, ARENA_MAX = 8 << 20, PAYLOAD_MAX = 128 << 10, PACK_MAX = 512 << 10;
/** BP registers that hold an address (>> 5): the eight texture images, the copy's destination, a palette's source */
const TEX_ADDR = [0x94, 0x95, 0x96, 0x97, 0xB4, 0xB5, 0xB6, 0xB7], COPY_DST = 0x4B, TLUT_SRC = 0x64;
/** BP registers the console's own program answers to (draw done, the tokens) or that are the console's (bus clocks): never sent */
const BP_DROP = new Set([0x45, 0x46, 0x47, 0x48, 0x69]);
/** BP registers that are plain state: sent as they stood before the first frame drawn */
const BP_STATE: number[] = [];
for (const [a, b] of [[0x00, 0x04], [0x06, 0x22], [0x25, 0x44], [0x49, 0x4A], [0x4D, 0x51], [0x53, 0x54], [0x59, 0x59], [0x68, 0x68], [0x80, 0x9B], [0xA0, 0xBB], [0xC0, 0xDF], [0xE8, 0xFD]]) for (let r = a; r <= b; r++) BP_STATE.push(r);
/** the vertical filter that leaves every line as it is (GXSetCopyFilter off) */
const FILTER_OFF = [0x595000, 0x000015];

// ---------------------------------------------------------------- sets of address ranges
/** ranges [lo, hi) kept sorted and merged */
class Ranges {
    lo: number[] = []; hi: number[] = [];
    private find(a: number) { let l = 0, h = this.lo.length; while (l < h) { const m = (l + h) >> 1; if (this.hi[m] < a) l = m + 1; else h = m; } return l; }
    add(a: number, b: number) {
        if (b <= a) return;
        const i = this.find(a); let j = i;
        while (j < this.lo.length && this.lo[j] <= b) { a = Math.min(a, this.lo[j]); b = Math.max(b, this.hi[j]); j++; }
        this.lo.splice(i, j - i, a); this.hi.splice(i, j - i, b);
    }
    /** the range with a in it (-1: none) */
    at(a: number) { const i = this.find(a + 1); return i < this.lo.length && this.lo[i] <= a ? i : -1; }
    has(a: number, b: number) { if (b <= a) return true; const i = this.at(a); return i >= 0 && this.hi[i] >= b; }
    hits(a: number, b: number) { const i = this.find(a + 1); return i < this.lo.length && this.lo[i] < b; }
    clear() { this.lo.length = 0; this.hi.length = 0; }
    get bytes() { let n = 0; for (let i = 0; i < this.lo.length; i++) n += this.hi[i] - this.lo[i]; return n; }
}

// ---------------------------------------------------------------- textures and vertices
/** the bytes of a texture image: its format, its size, how many levels (0: no such format) */
function texBytes(fmt: number, w: number, h: number, levels: number) {
    let n = 0;
    for (let l = 0; l < levels; l++) {
        switch (fmt) {
            case 0: case 8: case 14: n += ((w + 7) >> 3) * ((h + 7) >> 3) * 32; break;
            case 1: case 2: case 9: n += ((w + 7) >> 3) * ((h + 3) >> 2) * 32; break;
            case 3: case 4: case 5: case 10: n += ((w + 3) >> 2) * ((h + 3) >> 2) * 32; break;
            case 6: n += ((w + 3) >> 2) * ((h + 3) >> 2) * 64; break;
            default: return 0;
        }
        w = Math.max(w >> 1, 1); h = Math.max(h >> 1, 1);
    }
    return n;
}
/** a frame buffer copy's format as the texture format laid out the same way (7 to 10: one channel; 11, 12: two) */
const COPY_AS = [0, 1, 2, 3, 4, 5, 6, 1, 1, 1, 1, 3, 3, -1, -1, -1];
/** The texture images a primitive drawn with these BP registers samples (the maps of the texture environment's stages and of the indirect stages): address, bytes. */
function sampled(bp: Uint32Array): { addr: number; len: number; w: number; h: number; fmt: number }[] {
    let maps = 0;
    for (let st = 0, n = ((bp[0] >>> 10) & 15) + 1; st < n; st++) { const order = bp[0x28 + (st >> 1)] >>> ((st & 1) * 12); if (order & 0x40) maps |= 1 << (order & 7); }
    for (let i = 0, n = (bp[0] >>> 16) & 7; i < n; i++) maps |= 1 << ((bp[0x27] >>> (i * 6)) & 7);
    const out = [];
    for (let i = 0; i < 8; i++) {
        if (!(maps & (1 << i))) continue;
        const base = i < 4 ? i : 0x20 + (i - 4), m0 = bp[0x80 + base], i0 = bp[0x88 + base], w = (i0 & 0x3FF) + 1, h = ((i0 >>> 10) & 0x3FF) + 1, fmt = (i0 >>> 20) & 15;
        // (with mipmaps: the levels up to the largest the mode allows, as far as the size goes)
        const levels = (m0 >>> 5) & 3 ? Math.min(32 - Math.clz32(Math.max(w, h)), ((((bp[0x84 + base] >>> 8) & 0xFF) + 15) >> 4) + 1) : 1;
        out.push({ addr: (bp[0x94 + base] << 5) & 0x03FFFFFF, len: texBytes(fmt, w, h, levels), w, h, fmt });
    }
    return out;
}

/** a vertex format: the bytes of a vertex, and its attributes given as an index into an array (8 or 16 bits; the array; the bytes of an element) */
interface Lay { size: number; idx: { off: number; wide: boolean; array: number; size: number }[] }
const COMP = [1, 1, 2, 2, 4, 4, 4, 4], COLOR = [2, 3, 4, 2, 3, 4, 4, 4];
const layouts = new Map<string, Lay>();
function layoutOf(cp: Uint32Array, vat: number): Lay {
    const lo = cp[0x50], hi = cp[0x60], a = cp[0x70 + vat], b = cp[0x80 + vat], c = cp[0x90 + vat], key = `${lo},${hi},${a},${b},${c}`;
    let L = layouts.get(key);
    if (L) return L;
    let off = 0;
    const idx: Lay['idx'] = [];
    // (how: 1 in the vertex, 2 an 8-bit index, 3 a 16-bit one; times: indexes in a row)
    const attr = (how: number, bytes: number, array: number, times = 1) => {
        if (how === 1) off += bytes;
        else if (how) for (let i = 0; i < times; i++) { idx.push({ off, wide: how === 3, array, size: bytes }); off += how - 1; }
    };
    // the matrix indexes (position, eight texture matrices), a byte each
    for (let i = 0; i < 9; i++) if (lo & (1 << i)) off++;
    attr((lo >>> 9) & 3, (a & 1 ? 3 : 2) * COMP[(a >>> 1) & 7], 0);
    // the normal: 3 components, or 9 with its tangents (then three indexes when the format says so)
    const nbt = (a >>> 9) & 1;
    attr((lo >>> 11) & 3, (nbt ? 9 : 3) * COMP[(a >>> 10) & 7], 1, nbt && (a >>> 31) ? 3 : 1);
    for (let i = 0; i < 2; i++) attr((lo >>> (13 + 2 * i)) & 3, COLOR[(a >>> (14 + 4 * i)) & 7], 2 + i);
    const tf = [[a, 21, a, 22], [b, 0, b, 1], [b, 9, b, 10], [b, 18, b, 19], [b, 27, b, 28], [c, 5, c, 6], [c, 14, c, 15], [c, 23, c, 24]];
    for (let i = 0; i < 8; i++) attr((hi >>> (2 * i)) & 3, ((tf[i][0] >>> tf[i][1]) & 1 ? 2 : 1) * COMP[(tf[i][2] >>> tf[i][3]) & 7], 4 + i);
    layouts.set(key, L = { size: off, idx });
    return L;
}
/** The smallest and largest index of an indexed attribute over a primitive's vertices at b[p] (a position index of all ones skips its vertex); false: none. */
const span = [0, 0];
function indexSpan(L: Lay, at: Lay['idx'][0], count: number, b: Uint8Array, p: number): boolean {
    let q = p + at.off, mn = 0x10000, mx = -1;
    const none = at.array === 0 ? (at.wide ? 0xFFFF : 0xFF) : -1;
    for (let i = 0; i < count; i++, q += L.size) { const v = at.wide ? (b[q] << 8) | b[q + 1] : b[q]; if (v === none) continue; if (v > mx) mx = v; if (v < mn) mn = v; }
    span[0] = mn; span[1] = mx;
    return mx >= 0;
}

// ---------------------------------------------------------------- the GPU's registers, and a walk through its commands
class Gpu {
    cp = new Uint32Array(256); bp = new Uint32Array(256); xf = new Uint32Array(0x1100);
    /** the mask for the next BP load */
    mask = 0xFFFFFF;
    /** what is behind 0xE0..0xE7: the TEV colours, then the constant colours (loaded with bit 23), as last loaded; which were ever loaded */
    tev = new Uint32Array(16); tevSet = 0;
    /** the palettes loaded, by their place in the GPU's own memory: where from, the load's word */
    tluts = new Map<number, { addr: number; word: number }>();
    /** (while walking) inside a display list */
    inList = false;
    setRegs(r: NonNullable<GxFrame['regs']>) {
        this.cp.set(r.cp.subarray(0, 256)); this.bp.set(r.bp.subarray(0, 256)); this.xf.set(r.xf.subarray(0, 0x1100)); this.mask = 0xFFFFFF;
        if (r.bp.length >= 272) { this.tev.set(r.bp.subarray(256, 272)); this.tevSet = 0xFFFF; }
        else for (let i = 0; i < 8; i++) this.tevLoad(0xE0 + i, r.bp[0xE0 + i]);
    }
    tevLoad(reg: number, v: number) { const k = (reg - 0xE0) + (v & 0x800000 ? 8 : 0); this.tev[k] = v; this.tevSet |= 1 << k; }
    clone() { const g = new Gpu(); g.cp.set(this.cp); g.bp.set(this.bp); g.xf.set(this.xf); g.mask = this.mask; g.tev.set(this.tev); g.tevSet = this.tevSet; g.tluts = new Map(this.tluts); return g; }
}
/** what a walk tells of each command, before it takes effect (raw: the command's bytes, in place) */
interface Sink {
    /** a command of the outer stream at p is about to run */
    at?(p: number): void;
    cp?(reg: number, v: number, raw: Uint8Array): void;
    xf?(raw: Uint8Array): void;
    /** a load by index: the array (12..15), where its words are in memory, how many, the XF address */
    xfIndexed?(array: number, src: number, n: number, addr: number, raw: Uint8Array): void;
    /** v: the register's 24 bits as they will stand (the mask applied) */
    bp?(reg: number, v: number, raw: Uint8Array): void;
    /** vtx: where the vertices are in raw's buffer */
    prim?(L: Lay, count: number, raw: Uint8Array, b: Uint8Array, vtx: number): void;
    /** the one-byte commands (0x44, 0x48) */
    other?(raw: Uint8Array): void;
    /** a display list is called (true: don't go into it) */
    list?(addr: number, size: number): boolean | void;
}
/**
 * Runs the commands in b[p..end) on the registers g, display lists read from mem (addresses & 0x03FFFFFF).
 * Returns where it stopped: end, or the start of a command that isn't all there.
 */
function walk(g: Gpu, mem: Uint8Array, b: Uint8Array, p: number, end: number, sink: Sink, inList = false): number {
    while (p < end) {
        const cmd = b[p];
        if (cmd === 0) { p++; continue; }
        if (!inList && sink.at) sink.at(p);
        if (cmd & 0x80) {
            if (p + 3 > end) return p;
            const count = (b[p + 1] << 8) | b[p + 2], L = layoutOf(g.cp, cmd & 7), total = 3 + count * L.size;
            if (p + total > end) { if (inList) throw new Error('a display list ends inside a primitive'); return p; }
            if (sink.prim) sink.prim(L, count, b.subarray(p, p + total), b, p + 3);
            p += total; continue;
        }
        switch (cmd) {
            case 0x08: {
                if (p + 6 > end) return p;
                const reg = b[p + 1], v = r32(b, p + 2);
                if (sink.cp) sink.cp(reg, v, b.subarray(p, p + 6));
                g.cp[reg] = v; p += 6; continue;
            }
            case 0x10: {
                if (p + 5 > end) return p;
                const n = (b[p + 2] & 0xF) + 1, addr = (b[p + 3] << 8) | b[p + 4];
                if (p + 5 + 4 * n > end) return p;
                if (sink.xf) sink.xf(b.subarray(p, p + 5 + 4 * n));
                for (let i = 0; i < n; i++) if (addr + i < 0x1100) g.xf[addr + i] = r32(b, p + 5 + 4 * i);
                p += 5 + 4 * n; continue;
            }
            case 0x20: case 0x28: case 0x30: case 0x38: {
                if (p + 5 > end) return p;
                const index = (b[p + 1] << 8) | b[p + 2], v = (b[p + 3] << 8) | b[p + 4], n = (v >>> 12) + 1, addr = v & 0xFFF, arr = 12 + ((cmd - 0x20) >> 3);
                const src = (g.cp[0xA0 + arr] & 0x03FFFFFF) + index * (g.cp[0xB0 + arr] & 0xFF);
                if (sink.xfIndexed) sink.xfIndexed(arr, src, n, addr, b.subarray(p, p + 5));
                if (src + 4 * n <= mem.length) for (let i = 0; i < n; i++) if (addr + i < 0x1100) g.xf[addr + i] = r32(mem, src + 4 * i);
                p += 5; continue;
            }
            case 0x40: {
                if (p + 9 > end) return p;
                const addr = r32(b, p + 1) & 0x03FFFFFF, size = r32(b, p + 5);
                if (inList) throw new Error('a display list calls another');
                if (!(sink.list && sink.list(addr, size))) {
                    if (addr + size > mem.length) throw new Error(`a display list at ${hex(addr)} outside memory`);
                    g.inList = true;
                    const stop = walk(g, mem, mem, addr, addr + size, sink, true);
                    g.inList = false;
                    if (stop !== addr + size) throw new Error(`the display list at ${hex(addr)} ends inside a command`);
                }
                p += 9; continue;
            }
            case 0x44: case 0x48: if (sink.other) sink.other(b.subarray(p, p + 1)); p++; continue;
            case 0x61: {
                if (p + 5 > end) return p;
                const w = r32(b, p + 1), reg = w >>> 24;
                if (reg === 0xFE) { if (sink.bp) sink.bp(reg, w & 0xFFFFFF, b.subarray(p, p + 5)); g.mask = w & 0xFFFFFF; p += 5; continue; }
                const v = ((g.bp[reg] & ~g.mask) | (w & g.mask)) & 0xFFFFFF;
                if (sink.bp) sink.bp(reg, v, b.subarray(p, p + 5));
                g.mask = 0xFFFFFF;
                if (reg >= 0xE0 && reg <= 0xE7) g.tevLoad(reg, v);
                if (reg === 0x65) { g.tluts.delete(v & 0x3FF); g.tluts.set(v & 0x3FF, { addr: (g.bp[TLUT_SRC] << 5) & 0x03FFFFFF, word: v }); }
                g.bp[reg] = v; p += 5; continue;
            }
        }
        throw new Error(`an unknown GX command 0x${hex(cmd)}${inList ? ' in a display list' : ''} at ${p}`);
    }
    return p;
}

// ---------------------------------------------------------------- a job's operations
/** the operations of a script as they are made: commands gathered into pieces the console's program takes, a wait before memory is changed under them */
class Out {
    ops: Op[] = [];
    private pend: Uint8Array[] = []; private pendLen = 0;
    /** commands were sent since the last wait (how many bytes) */
    dirty = false; private since = 0;
    fifoBytes = 0; memBytes = 0; syncs = 0; blocks = 0;
    private flush() {
        if (!this.pendLen) return;
        const all = new Uint8Array(this.pendLen); let o = 0;
        for (const d of this.pend) { all.set(d, o); o += d.length; }
        for (let q = 0; q < all.length; q += 0xF000) this.ops.push({ op: OP.FIFO, a: 0, b: 0, data: all.subarray(q, Math.min(q + 0xF000, all.length)) });
        this.pend = []; this.pendLen = 0;
    }
    /** whole commands (a mask together with the load it is for). The console's command buffer is 512 KB: a wait at least every 192 KB keeps it far from full. */
    fifo(d: ArrayLike<number>) {
        const u = d instanceof Uint8Array ? d : Uint8Array.from(d);
        this.pend.push(u); this.pendLen += u.length; this.fifoBytes += u.length; this.dirty = true;
        if ((this.since += u.length) >= 0x30000) this.sync();
    }
    bpw(reg: number, v: number) { this.fifo([0x61, reg, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF]); }
    bpAddr(reg: number, at: number) { this.flush(); this.ops.push({ op: OP.BPADDR, a: reg, b: at }); this.fifoBytes += 5; this.dirty = true; }
    cpAddr(reg: number, at: number) { this.flush(); this.ops.push({ op: OP.CPADDR, a: reg, b: at >>> 0 }); this.fifoBytes += 6; this.dirty = true; }
    sync() { if (!this.dirty) return; this.flush(); this.ops.push({ op: OP.SYNC, a: 0, b: 0 }); this.dirty = false; this.since = 0; this.syncs++; }
    /** (the GPU must have run everything sent before memory changes) */
    mem(at: number, data: Uint8Array) {
        this.sync();
        for (let o = 0; o < data.length; o += 0x10000) {
            const raw = data.slice(o, o + 0x10000), packed = rleEncode(raw);
            if (packed.length < raw.length) this.ops.push({ op: OP.MEMRLE, a: at + o, b: raw.length, data: packed }); else this.ops.push({ op: OP.MEM, a: at + o, b: 0, data: raw });
        }
        this.memBytes += data.length; this.blocks++;
    }
    note(text: string) { this.flush(); this.ops.push({ op: OP.NOTE, a: 0, b: 0, data: new TextEncoder().encode(text) }); }
    /** a block saved (in pieces the console packs), with what it is said before it */
    save(what: Save) {
        this.sync();
        this.note('save ' + JSON.stringify(what));
        for (let o = 0; o < what.size; o += PACK_MAX) this.ops.push({ op: OP.DUMP, a: what.at + o, b: Math.min(PACK_MAX, what.size - o) });
    }
}
/** a block a job saves: kind tex (a texture: fmt, w, h; depth: a Z24X8 copy of the depth buffer) or xfb (YUYV lines of `stride` bytes) */
interface Save { name: string; kind: 'tex' | 'xfb'; at: number; size: number; w: number; h: number; fmt?: number; depth?: boolean; stride?: number; note?: string }

// ---------------------------------------------------------------- job: frames of a dump as a script
/** what the frames to draw become, in order, before the arena is laid out */
type Item =
    | { k: 'fifo'; d: Uint8Array }
    /** a BP register that holds an address */
    | { k: 'addr'; reg: number; addr: number; raw: Uint8Array }
    /** a CP array base */
    | { k: 'array'; reg: number; v: number; raw: Uint8Array }
    /** the game's memory changes */
    | { k: 'patch'; addr: number; d: Uint8Array }
    /** the console has written this memory itself (a copy out of the frame buffer) */
    | { k: 'copied'; lo: number; hi: number }
    | { k: 'save'; name: string; addr: number; size: number; w: number; h: number; fmt: number; depth: boolean; note: string }
    /** the frame buffer and the depth buffer saved (before the wanted frame's copy to the display): the registers as they stand */
    | { k: 'capture'; bp: Uint32Array }
    | { k: 'savexfb'; w: number; h: number; stride: number }
    | { k: 'frame'; index: number; frame: number; tick: number };

function loadFrame(dir: string, i: number): GxFrame {
    const path = `${dir}/f_${String(i).padStart(6, '0')}.gxf`;
    if (!existsSync(path)) throw new Error(`${path} is not there`);
    return decodeGxFrame(new Uint8Array(readFileSync(path)));
}

function buildJob(dir: string, index: number, before: number, plainXf: boolean) {
    const start = Math.max(0, index - before), ram = new Uint8Array(RAM_SIZE), g = new Gpu();
    const put = (addr: number, d: Uint8Array) => { const a = addr & 0x03FFFFFF; if (a + d.length > RAM_SIZE) throw new Error(`a patch at ${hex(addr)} outside the game's memory`); ram.set(d, a); };
    // ---- the frames before the first one drawn: only the registers and the memory are followed
    let gotRegs = false;
    for (let i = 0; i < start; i++) {
        const f = loadFrame(dir, i); let k = 0;
        if (f.regs) { g.setRegs(f.regs); gotRegs = true; }
        const stop = walk(g, ram, f.fifo, 0, f.fifo.length, { at(p) { while (k < f.patches.length && f.patches[k].at <= p) put(f.patches[k].addr, f.patches[k++].data); } });
        if (stop !== f.fifo.length) throw new Error(`frame ${i} ends inside a command`);
        while (k < f.patches.length) put(f.patches[k].addr, f.patches[k++].data);
    }
    // ---- the frames drawn: what they send, what they read
    const items: Item[] = [], needs = new Ranges(), hulls = new Map<string, [number, number]>();
    const xfbDst = new Set<number>(); let xfbSize = 0;
    const copies: string[] = [], warnings = new Set<string>();
    /** what the commands read, in order (a digest each; for a texture also its range), to be held against the finished job's */
    const evD: number[] = [], evLo: number[] = [], evHi: number[] = [], copyDst = new Ranges();
    const ev = (d: number, lo = -1, hi = -1) => { evD.push(d); evLo.push(lo); evHi.push(hi); };
    let g0: Gpu | null = null, ram0: Uint8Array | null = null, wanted = false, nCopy = 0, mask: Uint8Array | null = null, lists = 0, listBytes = 0, prims = 0, capSize = 0;
    const need = (lo: number, hi: number, what: string) => { if (hi > RAM_SIZE) throw new Error(`${what} at ${hex(lo)}..${hex(hi)} outside the game's memory`); needs.add(lo & ~31, up32(hi)); };
    const hull = (array: number, base: number, lo: number, hi: number) => { const key = `${array}:${base}`, h = hulls.get(key); if (!h) hulls.set(key, [lo, hi]); else { if (lo < h[0]) h[0] = lo; if (hi > h[1]) h[1] = hi; } };
    // (bytes in the game's memory are copied: a later patch may change them)
    const own = (raw: Uint8Array) => g.inList ? raw.slice() : raw;
    const fifo = (raw: Uint8Array) => items.push({ k: 'fifo', d: own(raw) });
    /** a BP load, with the mask before it if there was one (one piece: nothing may come between the two) */
    const masked = (m: Uint8Array | null, raw: Uint8Array) => { if (!m) { fifo(raw); return; } const d = new Uint8Array(10); d.set(m); d.set(raw, 5); items.push({ k: 'fifo', d }); };
    let texKey = '';
    const sink: Sink = {
        cp(reg, v, raw) { if (reg >= 0xA0 && reg < 0xB0) items.push({ k: 'array', reg, v, raw: own(raw) }); else fifo(raw); },
        xf(raw) { fifo(raw); },
        xfIndexed(array, src, n, addr, raw) {
            if (plainXf) {
                const c = new Uint8Array(5 + 4 * n); c[0] = 0x10; c[2] = n - 1; c[3] = addr >> 8; c[4] = addr & 0xFF; c.set(ram.subarray(src, src + 4 * n), 5);
                items.push({ k: 'fifo', d: c });
            } else { hull(array, g.cp[0xA0 + array] & 0x03FFFFFF, src, src + 4 * n); ev(fnv(1, ram, src, 4 * n)); fifo(raw); }
        },
        bp(reg, v, raw) {
            texKey = '';
            if (reg === 0xFE) { mask = own(raw); return; }
            const m = mask; mask = null;
            if (BP_DROP.has(reg)) return;
            if (reg === COPY_DST || reg === TLUT_SRC || TEX_ADDR.includes(reg)) {
                if (m) throw new Error(`a masked load of BP register 0x${hex(reg)}, which holds an address`);
                items.push({ k: 'addr', reg, addr: (v << 5) & 0x03FFFFFF, raw: own(raw) });
                return;
            }
            if (reg >= 0x60 && reg <= 0x63) warnings.add('a texture preloaded into the GPU\'s own memory (BP 0x60..0x63): its image is not supplied');
            if (reg === 0x65) { const a = (g.bp[TLUT_SRC] << 5) & 0x03FFFFFF, n = ((v >>> 10) & 0x7FF) * 32; need(a, a + n, 'a palette'); ev(fnv(2, ram, a, n)); }
            if (reg === 0x52) {
                const bp = g.bp, sx = bp[0x49] & 0x3FF, sy = (bp[0x49] >>> 10) & 0x3FF, sw = (bp[0x4A] & 0x3FF) + 1, sh = ((bp[0x4A] >>> 10) & 0x3FF) + 1, dst = (bp[COPY_DST] << 5) & 0x03FFFFFF;
                if (v & 0x4000) {
                    // to the display: lines of (register 0x4D) * 32 bytes; with the vertical scale on, 256 / (register 0x4E) lines a line
                    const stride = (bp[0x4D] & 0x3FF) << 5, scale = bp[0x4E] & 0x1FF, lines = v & 0x400 && scale ? Math.ceil(sh * 256 / scale) : sh;
                    xfbDst.add(dst); xfbSize = Math.max(xfbSize, stride * (lines + 4));
                    if (wanted) { items.push({ k: 'capture', bp: bp.slice() }); capSize = texBytes(6, sw, sh, 1); }
                    masked(m, raw);
                    if (wanted) items.push({ k: 'savexfb', w: sw, h: lines, stride });
                    return;
                }
                const f = (v >>> 3) & 15, fmt = (f >> 1) | ((f & 1) << 3), half = (v >>> 9) & 1, w = (sw + half) >> half, h = (sh + half) >> half, as = COPY_AS[fmt], depth = (bp[0x43] & 7) === 3;
                if (as < 0) throw new Error(`a copy to format ${fmt}`);
                // (the console puts each row of blocks (register 0x4D) * 32 bytes after the last)
                const rows = as === 0 ? (h + 7) >> 3 : (h + 3) >> 2, natural = texBytes(as, w, h, 1), row = natural / rows, stride = (bp[0x4D] & 0x3FF) << 5;
                const size = Math.max(natural, (rows - 1) * stride + row);
                if (stride !== row) warnings.add(`a copy whose rows are ${stride} bytes apart where its texture's are ${row}`);
                need(dst, dst + size, 'a copy\'s destination'); copyDst.add(dst, dst + size);
                masked(m, raw);
                items.push({ k: 'copied', lo: dst, hi: dst + size });
                const what = `${wanted ? `copy${nCopy}` : 'copy (frame before)'}: ${sw} x ${sh} at (${sx}, ${sy}) -> ${w} x ${h}, copy format ${fmt}${depth ? ' of the depth buffer' : ''}${half ? ', half size' : ''}${v & 0x800 ? ', clears' : ''}, ${size} bytes at ${hex(0x80000000 + dst)} (control ${hex(v)})`;
                copies.push(what);
                if (wanted) items.push({ k: 'save', name: `copy${nCopy++}`, addr: dst, size, w, h, fmt: as, depth: depth && as === 6, note: what });
                return;
            }
            masked(m, raw);
        },
        prim(L, count, raw, b, vtx) {
            prims++;
            for (const at of L.idx) {
                if (!indexSpan(L, at, count, b, vtx)) continue;
                const base = g.cp[0xA0 + at.array] & 0x03FFFFFF, stride = g.cp[0xB0 + at.array] & 0xFF;
                hull(at.array, base, base, base + span[1] * stride + Math.max(stride, at.size));
            }
            // (the textures: worked out again after a BP load)
            if (!texKey) { texKey = 'x'; for (const t of sampled(g.bp)) { if (!t.len) warnings.add(`a texture of format ${t.fmt}`); else { need(t.addr, t.addr + t.len, 'a texture'); ev(fnv(3, ram, t.addr, t.len), t.addr, t.addr + t.len); } } }
            ev(fetched(g, ram, L, count, b, vtx));
            fifo(raw);
        },
        other(raw) { fifo(raw); },
        list(_addr, size) { lists++; listBytes += size; },
    };
    let fifoIn = 0, patchesIn = 0;
    for (let i = start; i <= index; i++) {
        const f = loadFrame(dir, i); let k = 0;
        if (f.regs) { if (i > start) throw new Error(`frames were skipped before frame ${i} of the dump: it cannot follow frame ${i - 1} in one job`); g.setRegs(f.regs); gotRegs = true; }
        if (!gotRegs) throw new Error('no frame of the dump up to the first one drawn carries the registers');
        if (i === start) { g0 = g.clone(); ram0 = ram.slice(); }
        wanted = i === index; fifoIn += f.fifo.length; patchesIn += f.patches.length;
        items.push({ k: 'frame', index: i, frame: f.frame, tick: f.tick });
        const patch = () => { const P = f.patches[k++]; put(P.addr, P.data); items.push({ k: 'patch', addr: P.addr & 0x03FFFFFF, d: P.data }); };
        sink.at = (p) => { while (k < f.patches.length && f.patches[k].at <= p) patch(); };
        const stop = walk(g, ram, f.fifo, 0, f.fifo.length, sink);
        if (stop !== f.fifo.length) throw new Error(`frame ${i} ends inside a command`);
        while (k < f.patches.length) patch();
        if (wanted && !capSize) throw new Error(`frame ${i} has no copy to the display`);
    }
    for (const [, h] of hulls) need(h[0], h[1], 'an array');
    for (const [, t] of g0!.tluts) { const n = ((t.word >>> 10) & 0x7FF) * 32; if (t.addr + n <= RAM_SIZE) needs.add(t.addr & ~31, up32(t.addr + n)); }

    // ---- the arena: the game's ranges one after another, the display's buffer, the place the frame buffer is saved to
    const place: number[] = []; let top = 0;
    for (let i = 0; i < needs.lo.length; i++) { place.push(top); top += needs.hi[i] - needs.lo[i]; }
    const lookup = (addr: number) => { const i = needs.at(addr); return i < 0 ? -1 : place[i] + (addr - needs.lo[i]); };
    const xfbAt = top; top += up32(xfbSize);
    // (the clear at the start copies 640 x 528 pixels, a byte each, to the same place)
    const capBytes = up32(Math.max(capSize, 640 / 8 * (528 / 4) * 32));
    if (top > ARENA_MAX) throw new Error(`the frames read ${needs.bytes} bytes of the game's memory: with the display's buffer ${top} bytes, more than the console's arena (${ARENA_MAX}); fewer frames before would need less`);
    // (when the arena is too small for it beside the rest: over the blocks, which nothing reads any more by then)
    const capAt = top + capBytes <= ARENA_MAX ? top : 0, arena = Math.max(top, capAt + capBytes);
    const shadow = new Uint8Array(arena), owned = new Uint8Array(arena);

    const out = new Out(), G = g0!, saves: Save[] = [];
    out.note(`hwframe: frames ${start}..${index} of ${dir.replace(/^.*\/(?=[^/])/, '')}`);
    // ---- the frame buffer cleared (as the copy to the display before these frames left it): a copy of all of it with the clear on
    out.bpw(0x43, G.bp[0x43]); out.bpw(0x41, 0x18); out.bpw(0x40, 0x1F);
    out.bpw(0x49, 0); out.bpw(0x4A, (527 << 10) | 639); out.bpw(0x4D, 80); out.bpAddr(COPY_DST, capAt);
    out.bpw(0x4F, G.bp[0x4F]); out.bpw(0x50, G.bp[0x50]); out.bpw(0x51, G.bp[0x51]); out.bpw(0x52, 0x80B);
    out.sync();
    // ---- the memory as it stood before the first frame drawn
    for (let i = 0; i < needs.lo.length; i++) { const d = ram0!.subarray(needs.lo[i], needs.hi[i]); out.mem(place[i], d); shadow.set(d, place[i]); }
    const firstBlocks = out.blocks, firstBytes = out.memBytes;
    // ---- the registers: CP (vertex formats, arrays), XF (matrices, lights, the registers), BP
    const cpw = (reg: number, v: number) => out.fifo([0x08, reg, v >>> 24, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF]);
    const array = (reg: number, v: number, raw: Uint8Array | null) => {
        const h = hulls.get(`${reg - 0xA0}:${v & 0x03FFFFFF}`);
        if (h) out.cpAddr(reg, lookup(h[0]) - (h[0] - (v & 0x03FFFFFF))); else if (raw) out.fifo(raw); else cpw(reg, v);
    };
    const addr = (reg: number, a: number, raw: Uint8Array | null) => {
        const at = reg === COPY_DST && xfbDst.has(a) ? xfbAt : lookup(a);
        // (a copy's destination that no copy of these frames uses is left where the last one was: inside the arena)
        if (at >= 0) out.bpAddr(reg, at); else if (reg !== COPY_DST && raw) out.fifo(raw);
    };
    for (const r of [0x30, 0x40, 0x50, 0x60]) cpw(r, G.cp[r]);
    for (let r = 0x70; r < 0x98; r++) cpw(r, G.cp[r]);
    for (let r = 0xA0; r < 0xB0; r++) array(r, G.cp[r], null);
    for (let r = 0xB0; r < 0xC0; r++) cpw(r, G.cp[r]);
    for (const [from, to] of [[0x000, 0x100], [0x400, 0x460], [0x500, 0x600], [0x600, 0x680], [0x1005, 0x1006], [0x1008, 0x1027], [0x103F, 0x1058]]) {
        for (let a = from; a < to; a += 16) {
            const n = Math.min(16, to - a), c = [0x10, 0, n - 1, a >> 8, a & 0xFF];
            for (let i = 0; i < n; i++) { const v = G.xf[a + i]; c.push(v >>> 24, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF); }
            out.fifo(c);
        }
    }
    for (const r of BP_STATE) { if (TEX_ADDR.includes(r)) addr(r, (G.bp[r] << 5) & 0x03FFFFFF, Uint8Array.from([0x61, r, (G.bp[r] >>> 16) & 0xFF, (G.bp[r] >>> 8) & 0xFF, G.bp[r] & 0xFF])); else out.bpw(r, G.bp[r]); }
    addr(COPY_DST, (G.bp[COPY_DST] << 5) & 0x03FFFFFF, null);
    // (the TEV colours and the constant colours: red and alpha once, blue and green three times, as GXSetTevColor does)
    for (let k = 0; k < 16; k++) if (G.tevSet & (1 << k)) for (let n = k & 1 ? 3 : 1; n > 0; n--) out.bpw(0xE0 + (k & 7), G.tev[k]);
    // (the palettes in the GPU's own memory, loaded again from where they came)
    for (const [, t] of G.tluts) {
        const at = lookup(t.addr);
        if (at < 0) continue;
        out.bpw(0x0F, G.bp[0x0F]); out.bpAddr(TLUT_SRC, at); out.bpw(0x65, t.word); out.bpw(0x0F, G.bp[0x0F]);
    }
    addr(TLUT_SRC, (G.bp[TLUT_SRC] << 5) & 0x03FFFFFF, null);
    // (nothing of an earlier job in the vertex cache or the texture cache)
    out.fifo([0x48]); out.bpw(0x0F, G.bp[0x0F]); out.bpw(0x66, 0x001000); out.bpw(0x66, 0x001100); out.bpw(0x0F, G.bp[0x0F]);

    // ---- the frames
    let patchBytes = 0, patchRuns = 0, ownedBytes = 0;
    /** the game's memory changes: what of it the arena holds is sent, where it differs and the console hasn't written it itself */
    const patch = (a: number, d: Uint8Array) => {
        for (let i = Math.max(0, needs.at(a)), end = a + d.length; i < needs.lo.length && needs.lo[i] < end; i++) {
            if (needs.hi[i] <= a) continue;
            const lo = Math.max(a, needs.lo[i]), hi = Math.min(end, needs.hi[i]), at = place[i] + (lo - needs.lo[i]), src = lo - a, n = hi - lo;
            // (runs of bytes to send: a gap of up to 64 unchanged bytes doesn't end one)
            let from = -1, last = -1;
            const send = () => { if (from < 0) return; const piece = d.slice(src + from, src + last + 1); out.mem(at + from, piece); shadow.set(piece, at + from); patchBytes += piece.length; patchRuns++; from = -1; };
            for (let q = 0; q < n; q++) {
                if (owned[at + q]) { if (d[src + q] !== shadow[at + q]) ownedBytes++; send(); continue; }
                if (d[src + q] === shadow[at + q]) { if (from >= 0 && q - last > 64) send(); continue; }
                if (from < 0) from = q;
                last = q;
            }
            send();
        }
    };
    for (const it of items) {
        switch (it.k) {
            case 'fifo': out.fifo(it.d); break;
            case 'addr': addr(it.reg, it.addr, it.raw); break;
            case 'array': array(it.reg, it.v, it.raw); break;
            case 'patch': patch(it.addr, it.d); break;
            case 'copied': { const at = lookup(it.lo); owned.fill(1, at, at + (it.hi - it.lo)); break; }
            case 'save': { const s: Save = { name: it.name, kind: 'tex', at: lookup(it.addr), size: it.size, w: it.w, h: it.h, fmt: it.fmt, depth: it.depth, note: it.note }; out.save(s); saves.push(s); break; }
            case 'frame': out.sync(); out.note(`frame ${it.index} of the dump (replay frame ${it.frame}, tick ${it.tick})${it.index === index ? '' : ', drawn before the wanted one'}`); break;
            case 'capture': {
                // the frame buffer as an RGBA8 texture, then the depth buffer as Z24X8 (the pixel format set to depth for
                // the copy, as GXCopyTex does), every line as it is; then the registers back for the game's own copy
                const bp = it.bp, w = (bp[0x4A] & 0x3FF) + 1, h = ((bp[0x4A] >>> 10) & 0x3FF) + 1, size = texBytes(6, w, h, 1);
                out.bpw(0x53, FILTER_OFF[0]); out.bpw(0x54, FILTER_OFF[1]); out.bpw(0x4D, ((w + 3) >> 2) * 2); out.bpAddr(COPY_DST, capAt);
                out.bpw(0x52, 0x10063);
                const efb: Save = { name: 'efb', kind: 'tex', at: capAt, size, w, h, fmt: 6, note: `the frame buffer before the copy to the display, pixel format ${bp[0x43] & 7}` };
                out.save(efb); saves.push(efb);
                out.bpw(0x43, (bp[0x43] & ~7) | 3); out.bpw(0x52, 0x10063); out.bpw(0x43, bp[0x43]);
                const z: Save = { name: 'z', kind: 'tex', at: capAt, size, w, h, fmt: 6, depth: true, note: 'the depth buffer before the copy to the display' };
                out.save(z); saves.push(z);
                out.bpw(0x53, bp[0x53]); out.bpw(0x54, bp[0x54]); out.bpw(0x4D, bp[0x4D]); out.bpAddr(COPY_DST, xfbAt);
                break;
            }
            case 'savexfb': { const s: Save = { name: 'xfb', kind: 'xfb', at: xfbAt, size: it.stride * it.h, w: it.w, h: it.h, stride: it.stride, note: 'the copy to the display' }; out.save(s); saves.push(s); break; }
        }
    }
    out.sync();
    const S = new Script(); S.ops = out.ops; S.arena = arena;
    const bytes = S.bytes();

    // ---- the finished job run here and held against the game: what its commands read out of the arena must be what
    // the game's read out of the game's memory (but for textures the console's own copies write), and the registers
    // must end as the game's did
    const mem = new Uint8Array(HERE + arena + 64), J = new Gpu();
    let live = false, n = 0, texKey2 = '';
    const same = (d: number, what: string) => {
        if (!live) return;
        if (n >= evD.length) throw new Error('the job reads more than the game did');
        if (evD[n] !== d && !(evLo[n] >= 0 && copyDst.hits(evLo[n], evHi[n]))) throw new Error(`the job's read ${n} (${what}) is not what the game's GPU got`);
        n++;
    };
    runOps(readScript(bytes).ops, mem, HERE, J, {
        xfIndexed(_array, src, k) { same(fnv(1, mem, src, 4 * k), 'a matrix loaded by index'); },
        bp(reg, v) { texKey2 = ''; if (reg === 0x65) same(fnv(2, mem, (J.bp[TLUT_SRC] << 5) & 0x03FFFFFF, ((v >>> 10) & 0x7FF) * 32), 'a palette'); },
        prim(L, count, _raw, b, vtx) {
            if (!texKey2) { texKey2 = 'x'; for (const t of sampled(J.bp)) if (t.len) same(fnv(3, mem, t.addr, t.len), `a texture ${t.w} x ${t.h}`); }
            same(fetched(J, mem, L, count, b, vtx), 'a primitive\'s vertices');
        },
    }, (o) => { if (o.op === OP.NOTE && new TextDecoder().decode(o.data!).startsWith('frame ')) live = true; });
    if (n !== evD.length) throw new Error(`the job reads ${n} times, the game ${evD.length}`);
    const differ: string[] = [], stray: string[] = [];
    const held = (what: string, job: number, game: number, must: boolean) => { if (job !== game) (must ? differ : stray).push(`${what}: ${hex(game)} in the game, ${hex(job)} in the job`); };
    for (let r = 0; r < 256; r++) {
        if (r >= 0xA0 && r < 0xB0) { const h = hulls.get(`${r - 0xA0}:${g.cp[r] & 0x03FFFFFF}`); held(`CP 0x${hex(r)}`, J.cp[r], h ? HERE + lookup(h[0]) - (h[0] - (g.cp[r] & 0x03FFFFFF)) : g.cp[r], true); }
        else held(`CP 0x${hex(r)}`, J.cp[r], g.cp[r], r === 0x30 || r === 0x40 || r === 0x50 || r === 0x60 || (r >= 0x70 && r < 0x98) || r >= 0xB0);
    }
    const xfSent = (a: number) => a < 0x100 || (a >= 0x400 && a < 0x460) || (a >= 0x500 && a < 0x680) || a === 0x1005 || (a >= 0x1008 && a < 0x1027) || (a >= 0x103F && a < 0x1058);
    for (let a = 0; a < 0x1100; a++) held(`XF 0x${hex(a)}`, J.xf[a], g.xf[a], xfSent(a));
    for (let r = 0; r < 256; r++) {
        if (BP_DROP.has(r) || r === 0xFE || (r >= 0xE0 && r <= 0xE7)) continue;
        if (r === COPY_DST) continue;
        if (TEX_ADDR.includes(r) || r === TLUT_SRC) { const at = lookup((g.bp[r] << 5) & 0x03FFFFFF); held(`BP 0x${hex(r)}`, J.bp[r], at >= 0 ? ((HERE + at) >>> 5) & 0xFFFFFF : g.bp[r], r !== TLUT_SRC || at >= 0); }
        else held(`BP 0x${hex(r)}`, J.bp[r], g.bp[r], BP_STATE.includes(r));
    }
    for (let k = 0; k < 16; k++) if (g.tevSet & (1 << k)) held(`the TEV register behind BP 0x${hex(0xE0 + (k & 7))}${k & 8 ? ' (constant colour)' : ''}`, J.tev[k], g.tev[k], true);
    if (differ.length) throw new Error(`the job leaves the registers other than the game did:\n  ${differ.slice(0, 20).join('\n  ')}`);
    const text = [
        `A job for tools/hwprobe (tests/hwframe.ts): a console draws frames of the game as they were captured, and saves what it drew.`,
        `Check it: node hwframe.mjs check <this job>. Its answer: node hwframe.mjs picture <answer> <out.png> [efb | z | xfb | copyN | all].`,
        '',
        `frames ${start}..${index} of ${dir} (the wanted one: ${index}; ${index - start} drawn before it)`,
        `commands: ${out.fifoBytes} bytes to the GPU (the frames' own streams: ${fifoIn} bytes; ${lists} display lists of ${listBytes} bytes in their place; ${prims} primitives)`,
        `memory: ${needs.lo.length} ranges of the game's memory, ${needs.bytes} bytes, sent first as ${firstBlocks} blocks (${firstBytes} bytes); then ${patchRuns} changes (${patchBytes} bytes) of the frames' ${patchesIn} patches, each after a wait for the GPU (${out.syncs} waits in all)`,
        `  ${ownedBytes} changed bytes of patches were not sent: they are in memory the console's own copies have written`,
        `arena: ${arena} bytes of ${ARENA_MAX} (the display's buffer at ${xfbAt}, ${up32(xfbSize)} bytes; the frame buffer saved at ${capAt}${capAt ? '' : ', over the blocks'})`,
        `script: ${bytes.length} bytes, ${out.ops.length} operations`,
        `texture copies:${copies.length ? '' : ' none'}`, ...copies.map((c) => '  ' + c),
        'saved, in this order:', ...saves.map((s) => `  ${s.name}: ${s.kind === 'xfb' ? `YUYV ${s.w} x ${s.h}, lines of ${s.stride} bytes` : `${s.w} x ${s.h}, texture format ${s.fmt}${s.depth ? ' (depth: Z24X8)' : ''}`}, ${s.size} bytes${s.name.startsWith('copy') ? '' : ` (${s.note})`}`),
        `held against the game here: ${n} reads (indexed vertices of every primitive, matrices loaded by index, palettes, texture images) give the job's commands what the game's GPU got; the registers end as the game's`,
        ...(stray.length ? [`registers the job doesn't set that the game has otherwise than a console that never got them (${stray.length}): ${stray.slice(0, 12).join('; ')}`] : []),
        ...[...warnings].map((w) => '! ' + w),
    ].join('\n') + '\n';
    return { bytes, text };
}

/**
 * A script's operations run without a console: its commands walked on the registers g (the arena at `base` of mem,
 * blocks put there as the script sets them), `on` told of every other operation once the commands before it have run.
 */
function runOps(ops: Op[], mem: Uint8Array, base: number, g: Gpu, sink: Sink, on: (o: Op, index: number) => void, fed?: (b: Uint8Array, index: number) => void) {
    let pend: Uint8Array[] = [], pendLen = 0;
    const run = (index: number) => {
        if (!pendLen) return;
        const all = new Uint8Array(pendLen); let o = 0;
        for (const d of pend) { all.set(d, o); o += d.length; }
        pend = []; pendLen = 0;
        if (fed) fed(all, index);
        if (walk(g, mem, all, 0, all.length, sink) !== all.length) throw new Error(`the stream stops inside a command before operation ${index}`);
    };
    const feed = (d: Uint8Array) => { pend.push(d); pendLen += d.length; };
    ops.forEach((o, i) => {
        switch (o.op) {
            case OP.FIFO: feed(o.data!); return;
            case OP.BPADDR: { const v = ((base + o.b) >>> 5) & 0xFFFFFF; feed(Uint8Array.from([0x61, o.a, v >>> 16, (v >>> 8) & 0xFF, v & 0xFF])); return; }
            case OP.CPADDR: { const v = (base + (o.b | 0)) >>> 0; feed(Uint8Array.from([0x08, o.a, v >>> 24, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF])); return; }
        }
        run(i + 1);
        on(o, i + 1);
        if (o.op === OP.MEM || o.op === OP.MEMRLE) { const d = o.op === OP.MEM ? o.data! : rleDecode(o.data!, o.b); if (base + o.a + d.length <= mem.length) mem.set(d, base + o.a); }
    });
    run(ops.length + 1);
}
/** where a script's arena is when it is run here: past the game's own memory, so an address left as the game's is told from one of the arena */
const HERE = 0x02000000;
const fnv = (h: number, b: Uint8Array, p: number, n: number) => { for (let i = 0; i < n; i++) h = Math.imul(h ^ b[p + i], 0x01000193); return h >>> 0; };
/** a digest of what a primitive's indexes fetch from the arrays */
function fetched(g: Gpu, mem: Uint8Array, L: Lay, count: number, b: Uint8Array, vtx: number): number {
    let h = 0x811C9DC5;
    for (const at of L.idx) {
        const base = g.cp[0xA0 + at.array] & 0x03FFFFFF, stride = g.cp[0xB0 + at.array] & 0xFF, none = at.array === 0 ? (at.wide ? 0xFFFF : 0xFF) : -1;
        for (let i = 0, q = vtx + at.off; i < count; i++, q += L.size) { const v = at.wide ? (b[q] << 8) | b[q + 1] : b[q]; if (v !== none) h = fnv(h, mem, base + v * stride, at.size); }
    }
    return h;
}

// ---------------------------------------------------------------- check: a job walked without a console
function checkJob(file: string): boolean {
    const sc = readScript(new Uint8Array(readFileSync(file))), BASE = HERE, arena = sc.arena;
    const mem = new Uint8Array(BASE + ARENA_MAX + 64), g = new Gpu();
    const fails: string[] = [], fail = (s: string) => { if (fails.length < 30 && !fails.includes(s)) fails.push(s); };
    /** arena bytes the job has set or the console has written; what the GPU reads and writes since the last wait */
    const defined = new Ranges(), reads = new Ranges(), writes = new Ranges();
    let opIndex = 0, prims = 0, vertices = 0, commands = 0, copies = 0, texReads = 0, syncs = 0, fifoBytes = 0, memBytes = 0, dumps = 0, dumpBytes = 0, inSave: Save | null = null, saveGot = 0;
    const saves: Save[] = [];
    if (arena > ARENA_MAX) fail(`the arena is ${arena} bytes: more than the console's ${ARENA_MAX}`);
    const read = (a: number, n: number, what: string) => {
        if (n <= 0) return;
        if (a < BASE || a + n > BASE + arena) { fail(`${what} read at ${hex(a)} (${n} bytes): not in the arena (operation ${opIndex})`); return; }
        if (!defined.has(a - BASE, a - BASE + n)) { fail(`${what} read at arena ${a - BASE} (${n} bytes): memory nothing has set (operation ${opIndex})`); return; }
        reads.add(a - BASE, a - BASE + n);
    };
    let texKey = '';
    const sink: Sink = {
        cp() { commands++; }, xf() { commands++; }, other() { commands++; },
        xfIndexed(_array, src, n) { commands++; read(src, 4 * n, 'a matrix loaded by index'); },
        bp(reg, v) {
            commands++; texKey = '';
            if (reg === 0x45 || reg === 0x47 || reg === 0x48) fail(`BP register 0x${hex(reg)} (draw done, a token) in the stream (operation ${opIndex})`);
            if (g.mask !== 0xFFFFFF && (reg === COPY_DST || reg === TLUT_SRC || TEX_ADDR.includes(reg))) fail(`a masked load of BP register 0x${hex(reg)}, which holds an address (operation ${opIndex})`);
            if (reg === 0x65) read((g.bp[TLUT_SRC] << 5) & 0x03FFFFFF, ((v >>> 10) & 0x7FF) * 32, 'a palette');
            if (reg === 0x52) {
                const bp = g.bp, sw = (bp[0x4A] & 0x3FF) + 1, sh = ((bp[0x4A] >>> 10) & 0x3FF) + 1, dst = (bp[COPY_DST] << 5) & 0x03FFFFFF, stride = (bp[0x4D] & 0x3FF) << 5;
                let size: number;
                if (v & 0x4000) { const scale = bp[0x4E] & 0x1FF; size = stride * (v & 0x400 && scale ? Math.ceil(sh * 256 / scale) : sh); }
                else {
                    const f = (v >>> 3) & 15, fmt = (f >> 1) | ((f & 1) << 3), half = (v >>> 9) & 1, w = (sw + half) >> half, h = (sh + half) >> half, as = COPY_AS[fmt];
                    if (as < 0) { fail(`a copy to format ${fmt} (operation ${opIndex})`); return; }
                    const rows = as === 0 ? (h + 7) >> 3 : (h + 3) >> 2, natural = texBytes(as, w, h, 1);
                    size = Math.max(natural, (rows - 1) * stride + natural / rows);
                }
                copies++;
                if (dst < BASE || dst + size > BASE + arena) { fail(`a copy of ${size} bytes to ${hex(dst)}: not in the arena (operation ${opIndex})`); return; }
                defined.add(dst - BASE, dst - BASE + size); writes.add(dst - BASE, dst - BASE + size);
            }
        },
        prim(L, count, _raw, b, vtx) {
            commands++; prims++; vertices += count;
            for (const at of L.idx) {
                if (!indexSpan(L, at, count, b, vtx)) continue;
                const base = g.cp[0xA0 + at.array] & 0x03FFFFFF, stride = g.cp[0xB0 + at.array] & 0xFF;
                read(base + span[0] * stride, (span[1] - span[0]) * stride + at.size, `array ${at.array}`);
            }
            if (!texKey) { texKey = 'x'; for (const t of sampled(g.bp)) { texReads++; if (!t.len) fail(`a texture of format ${t.fmt}`); else read(t.addr, t.len, `a texture (${t.w} x ${t.h}, format ${t.fmt})`); } }
        },
        list(addr, size) { fail(`a display list called at ${hex(addr)} (${size} bytes): the job has no way to place one (operation ${opIndex})`); return true; },
    };
    // (the same bytes through ppc/gx.ts's parser, as a second opinion on where each command ends)
    const gxWarn: string[] = [];
    const gx = new Gx(mem, { token() { }, finish() { }, unsupported(w) { gxWarn.push(w); } });
    const inArena = (a: number, n: number, what: string) => { if (a > arena || n > arena - a) { fail(`${what} at ${a} (${n} bytes) outside the arena (operation ${opIndex})`); return false; } return true; };
    sc.ops.forEach((o, i) => {
        if ((o.data?.length ?? 0) > PAYLOAD_MAX) fail(`operation ${i + 1} carries ${o.data!.length} bytes: more than the console's program takes`);
        if (o.op === OP.BPADDR && (o.b & 31)) fail(`an address register set to arena ${o.b}: not on 32 bytes (operation ${i + 1})`);
        if (o.op === OP.FIFO) fifoBytes += o.data!.length; else if (o.op === OP.BPADDR) fifoBytes += 5; else if (o.op === OP.CPADDR) fifoBytes += 6;
    });
    try {
        runOps(sc.ops, mem, HERE, g, sink, (o, index) => {
            opIndex = index;
            switch (o.op) {
                case OP.MEM: case OP.MEMRLE: {
                    const n = o.op === OP.MEM ? o.data!.length : o.b;
                    if (!inArena(o.a, n, 'a block')) break;
                    if (reads.hits(o.a, o.a + n) || writes.hits(o.a, o.a + n)) fail(`a block at arena ${o.a} (${n} bytes) changes memory that commands sent since the last wait use (operation ${index})`);
                    defined.add(o.a, o.a + n); memBytes += n;
                    break;
                }
                case OP.SYNC:
                    // (the console's wait loads a BP register of its own: a mask waiting for its load would go to that)
                    if (g.mask !== 0xFFFFFF) fail(`a wait between a BP mask and the load it is for (operation ${index})`);
                    reads.clear(); writes.clear(); syncs++; break;
                case OP.DUMP:
                    if (!inArena(o.a, o.b, 'a saved block')) break;
                    if (writes.hits(o.a, o.a + o.b)) fail(`a block is saved at arena ${o.a} before the wait for the copy that writes it (operation ${index})`);
                    if (!defined.has(o.a, o.a + o.b)) fail(`a block is saved at arena ${o.a} (${o.b} bytes) that nothing has written (operation ${index})`);
                    dumps++; dumpBytes += o.b;
                    if (inSave) { saveGot += o.b; if (saveGot >= inSave.size) inSave = null; }
                    break;
                case OP.NOTE: {
                    const t = new TextDecoder().decode(o.data!);
                    if (t.startsWith('save ')) { inSave = JSON.parse(t.slice(5)) as Save; saveGot = 0; saves.push(inSave); }
                    break;
                }
                default: fail(`operation ${index} is of kind ${o.op}: not one a frame job has`);
            }
        }, (all, index) => { opIndex = index; try { gx.feed(all, 0, all.length); } catch (e) { gxWarn.push((e as Error).message); } });
    } catch (e) { fail(`${(e as Error).message} (at operation ${opIndex})`); }
    if (inSave) fail(`the saved block ${(inSave as Save).name} is not all there`);
    if (!saves.some((s) => s.name === 'efb')) fail('the job doesn\'t save the frame buffer');
    console.log(`${sc.ops.length} operations, arena ${arena} bytes; ${fifoBytes} bytes of commands: ${commands} commands, ${prims} primitives (${vertices} vertices), ${copies} copies, ${texReads} texture binds checked; ${memBytes} bytes of blocks (${defined.lo.length} ranges set, ${defined.bytes} bytes); ${syncs} waits; ${dumps} saves of ${dumpBytes} bytes`);
    for (const s of saves) console.log(`  saves ${s.name}: ${s.kind === 'xfb' ? `YUYV ${s.w} x ${s.h}` : `${s.w} x ${s.h} format ${s.fmt}${s.depth ? ' (depth)' : ''}`}, ${s.size} bytes at arena ${s.at}`);
    const bad = gxWarn.filter((w) => /unknown GX command|ends inside/.test(w));
    if (gx.commands !== commands) fail(`ppc/gx.ts counts ${gx.commands} commands in the stream, this walk ${commands}`);
    for (const w of bad) fail('ppc/gx.ts: ' + w);
    for (const f of fails) console.log('FAIL ' + f);
    console.log(fails.length ? `${file}: NOT fit for a console (${fails.length}${fails.length >= 30 ? ' or more' : ''} failures)` : `${file}: every read lands in a block, the stream parses to its end`);
    return !fails.length;
}

// ---------------------------------------------------------------- pictures
const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
const crc32 = (b: Uint8Array) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
/** an RGBA picture (8 bits a channel) as a PNG */
function pngEncode(w: number, h: number, rgba: Uint8Array): Uint8Array {
    const raw = new Uint8Array(h * (1 + w * 4));
    for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1);
    const chunk = (type: string, data: Uint8Array) => {
        const c = new Uint8Array(12 + data.length), v = new DataView(c.buffer);
        v.setUint32(0, data.length); for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i); c.set(data, 8);
        v.setUint32(8 + data.length, crc32(c.subarray(4, 8 + data.length)));
        return c;
    };
    const head = new Uint8Array(13), hv = new DataView(head.buffer);
    hv.setUint32(0, w); hv.setUint32(4, h); head[8] = 8; head[9] = 6;
    return Buffer.concat([Uint8Array.from(PNG_SIG), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]);
}
/** a PNG of 8 bits a channel (RGBA, RGB or grey), not interlaced, as RGBA */
function pngDecode(b: Uint8Array): { w: number; h: number; rgba: Uint8Array } {
    if (PNG_SIG.some((v, i) => b[i] !== v)) throw new Error('not a PNG');
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength), idat: Uint8Array[] = [];
    let w = 0, h = 0, ch = 0;
    for (let p = 8; p + 12 <= b.length;) {
        const n = v.getUint32(p), type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
        if (type === 'IHDR') {
            w = v.getUint32(p + 8); h = v.getUint32(p + 12);
            ch = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[b[p + 17]] ?? 0;
            if (b[p + 16] !== 8 || !ch || b[p + 20]) throw new Error('a PNG that is not 8 bits a channel, or is interlaced or has a palette');
        } else if (type === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + n));
        else if (type === 'IEND') break;
        p += 12 + n;
    }
    const raw = inflateSync(Buffer.concat(idat)), line = w * ch, rgba = new Uint8Array(w * h * 4), cur = new Uint8Array(line), prev = new Uint8Array(line);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (line + 1)], s = y * (line + 1) + 1;
        for (let x = 0; x < line; x++) {
            const a = x >= ch ? cur[x - ch] : 0, up = prev[x], c = x >= ch ? prev[x - ch] : 0;
            let pred = 0;
            if (f === 1) pred = a; else if (f === 2) pred = up; else if (f === 3) pred = (a + up) >> 1;
            else if (f === 4) { const q = a + up - c, pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
            cur[x] = (raw[s + x] + pred) & 0xFF;
        }
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4, q = x * ch;
            if (ch >= 3) { rgba[o] = cur[q]; rgba[o + 1] = cur[q + 1]; rgba[o + 2] = cur[q + 2]; rgba[o + 3] = ch === 4 ? cur[q + 3] : 255; }
            else { rgba[o] = rgba[o + 1] = rgba[o + 2] = cur[q]; rgba[o + 3] = ch === 2 ? cur[q + 1] : 255; }
        }
        prev.set(cur);
    }
    return { w, h, rgba };
}
/** a texture's first level as RGBA (depth: a Z24X8 copy of the depth buffer, its 24 bits as red, green, blue) */
function texToRgba(d: Uint8Array, w: number, h: number, fmt: number, depth = false): Uint8Array {
    const out = new Uint8Array(w * h * 4), bw = fmt === 0 || fmt === 1 || fmt === 2 ? 8 : 4, bh = fmt === 0 ? 8 : 4, per = fmt === 6 ? 64 : 32, across = Math.ceil(w / bw);
    const e5 = (v: number) => (v << 3) | (v >> 2), e4 = (v: number) => v * 17, e3 = (v: number) => (v << 5) | (v << 2) | (v >> 1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const blk = ((y / bh | 0) * across + (x / bw | 0)) * per, i = (y % bh) * bw + (x % bw), o = (y * w + x) * 4;
        let r = 0, g = 0, b = 0, a = 255;
        switch (fmt) {
            case 0: r = g = b = e4((d[blk + (i >> 1)] >> (i & 1 ? 0 : 4)) & 15); break;
            case 1: r = g = b = d[blk + i]; break;
            case 2: r = g = b = e4(d[blk + i] & 15); a = e4(d[blk + i] >> 4); break;
            case 3: a = d[blk + 2 * i]; r = g = b = d[blk + 2 * i + 1]; break;
            case 4: { const v = (d[blk + 2 * i] << 8) | d[blk + 2 * i + 1]; r = e5(v >> 11); g = ((v >> 5) & 63) << 2 | ((v >> 9) & 3); b = e5(v & 31); break; }
            case 5: { const v = (d[blk + 2 * i] << 8) | d[blk + 2 * i + 1]; if (v & 0x8000) { r = e5((v >> 10) & 31); g = e5((v >> 5) & 31); b = e5(v & 31); } else { a = e3(v >> 12); r = e4((v >> 8) & 15); g = e4((v >> 4) & 15); b = e4(v & 15); } break; }
            case 6: a = depth ? 255 : d[blk + 2 * i]; r = d[blk + 2 * i + 1]; g = d[blk + 32 + 2 * i]; b = d[blk + 33 + 2 * i]; break;
            default: throw new Error(`a texture of format ${fmt}`);
        }
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
    return out;
}
/** the display's buffer (pairs of pixels as Y, Cb, Y, Cr) as RGBA */
function xfbToRgba(d: Uint8Array, w: number, h: number, stride: number): Uint8Array {
    const out = new Uint8Array(w * h * 4), cl = (v: number) => v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = y * stride + (x >> 1) * 4, Y = 1.164 * (d[p + (x & 1) * 2] - 16), u = d[p + 1] - 128, v = d[p + 3] - 128, o = (y * w + x) * 4;
        out[o] = cl(Y + 1.596 * v); out[o + 1] = cl(Y - 0.813 * v - 0.391 * u); out[o + 2] = cl(Y + 2.018 * u); out[o + 3] = 255;
    }
    return out;
}
/** A console's answer: its saved blocks (each named by the note before it), and what else it says. */
function readAnswer(b: Uint8Array) {
    if (r32(b, 0) !== 0x4758504F) throw new Error('not an answer file');
    const saves: { what: Save; data: Uint8Array; got: number }[] = [], lines: string[] = [];
    let cur: (typeof saves)[0] | null = null;
    for (let p = 16; p + 16 <= b.length;) {
        const kind = r32(b, p), a = r32(b, p + 4), bb = r32(b, p + 8), len = r32(b, p + 12), data = b.subarray(p + 16, p + 16 + len);
        p += 16 + ((len + 3) & ~3);
        const text = () => new TextDecoder('latin1').decode(data);
        if (kind === 100) lines.push(`console: Hollywood ${hex(r32(data, 0))}, CPU ${hex(r32(data, 4))}, arena at ${hex(r32(data, 8))}`);
        else if (kind === 102) lines.push('the console stopped the script: ' + text());
        else if (kind === 104) lines.push('a fault on the console');
        else if (kind === 101) lines.push(`end: ${a} operations, ${bb} blocks saved`);
        else if (kind === 103 && text().startsWith('save ')) { const what = JSON.parse(text().slice(5)) as Save; cur = { what, data: new Uint8Array(what.size), got: 0 }; saves.push(cur); }
        else if ((kind === OP.DUMP || kind === OP.MEMRLE) && cur) {
            const d = kind === OP.MEMRLE ? rleDecode(data, bb) : data, o = a - cur.what.at;
            if (o >= 0 && o + d.length <= cur.what.size) { cur.data.set(d, o); cur.got += d.length; }
        }
    }
    return { saves, lines };
}

// ---------------------------------------------------------------- the command line
const mode = process.argv[2];
if (mode === 'job') {
    const [dir, index, outPath] = [process.argv[3], +process.argv[4], process.argv[5]], before = +(process.argv[6] ?? 1);
    const { bytes, text } = buildJob(dir.replace(/\/$/, ''), index, before, process.env.XF === 'plain');
    writeFileSync(outPath, bytes); writeFileSync(outPath + '.txt', text);
    process.stdout.write(text);
} else if (mode === 'check') {
    process.exit(checkJob(process.argv[3]) ? 0 : 1);
} else if (mode === 'picture') {
    const A = readAnswer(new Uint8Array(readFileSync(process.argv[3]))), outPath = process.argv[4], which = process.argv[5] ?? 'efb', keepAlpha = process.env.ALPHA === '1';
    for (const l of A.lines) console.log(l);
    for (const [i, s] of A.saves.entries()) console.log(`${i} ${s.what.name}: ${s.what.w} x ${s.what.h}, ${s.got} of ${s.what.size} bytes${s.what.note ? ` (${s.what.note})` : ''}`);
    const write = (s: (typeof A.saves)[0], path: string) => {
        if (s.got < s.what.size) console.log(`${s.what.name}: only ${s.got} of ${s.what.size} bytes are in the answer`);
        const W = s.what, rgba = W.kind === 'xfb' ? xfbToRgba(s.data, W.w, W.h, W.stride!) : texToRgba(s.data, W.w, W.h, W.fmt!, !!W.depth);
        // (the frame buffer's alpha is the game's working value, not how see-through the picture is)
        if (!keepAlpha) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
        writeFileSync(path, pngEncode(W.w, W.h, rgba));
        console.log(`${path}: ${W.name}, ${W.w} x ${W.h}`);
    };
    if (which === 'all') for (const s of A.saves) write(s, `${outPath.replace(/\.png$/, '')}.${s.what.name}.png`);
    else if (which !== 'list') {
        const s = A.saves.find((q) => q.what.name === which) ?? (/^\d+$/.test(which) ? A.saves[+which] : undefined);
        if (!s) { console.log(`no saved block "${which}" in the answer`); process.exit(1); }
        write(s, outPath);
    }
} else if (mode === 'diff') {
    const a = pngDecode(new Uint8Array(readFileSync(process.argv[3]))), b = pngDecode(new Uint8Array(readFileSync(process.argv[4])));
    if (a.w !== b.w || a.h !== b.h) { console.log(`the pictures are ${a.w} x ${a.h} and ${b.w} x ${b.h}`); process.exit(1); }
    const out = new Uint8Array(a.w * a.h * 4);
    let off = 0, any = 0, worst = 0, sum = 0;
    for (let i = 0; i < out.length; i += 4) {
        let m = 0;
        for (let c = 0; c < 3; c++) { const d = Math.abs(a.rgba[i + c] - b.rgba[i + c]); out[i + c] = d; if (d > m) m = d; sum += d; }
        out[i + 3] = 255;
        if (m > 8) off++; if (m) any++; if (m > worst) worst = m;
    }
    writeFileSync(process.argv[5], pngEncode(a.w, a.h, out));
    console.log(`${a.w} x ${a.h}: ${off} pixels off by more than 8 in a channel (${(100 * off / (a.w * a.h)).toFixed(2)} %), ${any} different at all, the largest difference ${worst}, the mean ${(sum / (a.w * a.h * 3)).toFixed(3)} a channel`);
} else {
    console.log('usage: node hwframe.mjs job <dump folder> <frame index> <out.job> [frames before] | check <out.job> | picture <answer> <out.png> [which] | diff <a.png> <b.png> <out.png>');
    process.exit(2);
}
