// v3: the GPU, as far as the game's own logic depends on it.
//
// The command stream (the GX FIFO, and the display lists it calls) is parsed all the time, so that the
// GPU's registers (CP: vertex formats and arrays; XF: matrices, projection, viewport; BP: the texture
// environment, textures, blending, the frame buffer copies) are always what the game last set, and so
// that the commands the game waits on are found exactly: draw-sync tokens, draw-done.
//
// Nothing is drawn for the screen (the viewer draws). But the game draws its goop maps on the GPU and
// reads the results back (Map/PollutionCount.cpp): each layer's map is drawn into the frame buffer
// through the texture environment (which fades it), stamps are blended over it (water cleans, enemies
// dirty), the frame buffer is copied back into the texture the collision code reads, and the pixels
// drawn are counted (GXReadPixMetric) to know how dirty a layer or an object is. While `raster` is on
// (the replay turns it on around those draws) primitives are rasterised here in software, following
// the hardware's arithmetic as Dolphin's software renderer documents it (the rasteriser's fixed-point
// edges and fill rule, texture sampling, the texture environment's formulas, blending, the copy).

export interface GxHost {
    /** GXSetDrawSync's token reached the pixel engine (withInterrupt: BP 0x48; else 0x47, the register only) */
    token(value: number, withInterrupt: boolean): void;
    /** GXSetDrawDone */
    finish(): void;
    /** something this model doesn't do was needed while rasterising (reported once per kind) */
    unsupported(what: string): void;
}

export const EFB_W = 640, EFB_H = 528;
const fr = Math.fround;

/** a vertex format's layout: the bytes of a vertex, and where its position and texture coordinates are */
interface Layout {
    size: number;
    pnIdx: number;   // offset of the position matrix index (-1: none)
    txIdx: Int8Array;   // offsets of the texture matrix indexes (-1: none)
    pos: Attr | null; tex: (Attr | null)[];
    /** the two colours: offset, how (0 none), format (0 RGB565, 1 RGB8, 2 RGBX8, 3 RGBA4, 4 RGBA6, 5 RGBA8) */
    col: { off: number; how: number; fmt: number }[];
}
/** how: 1 direct, 2 an 8-bit index, 3 a 16-bit index; fmt 0 u8, 1 s8, 2 u16, 3 s16, 4 f32 */
interface Attr { off: number; how: number; comps: number; fmt: number; frac: number; array: number }
const COMP_SIZE = [1, 1, 2, 2, 4];
const COLOR_SIZE = [2, 3, 4, 2, 3, 4];

/** c: the two channels' colours (r g b a each, 0..255) */
interface Vtx { x: number; y: number; z: number; w: number; s: Float64Array; t: Float64Array; q: Float64Array; c: Float64Array }
const newVtx = (): Vtx => ({ x: 0, y: 0, z: 0, w: 1, s: new Float64Array(8), t: new Float64Array(8), q: new Float64Array(8), c: new Float64Array(8) });

export class Gx {
    cp = new Uint32Array(256);
    xfw = new Uint32Array(0x1100);
    xf = new Float32Array(this.xfw.buffer);
    bp = new Uint32Array(256);
    private bpMask = 0xFFFFFF;
    /** the TEV colour registers (PREV, C0, C1, C2: r g b a, signed 11-bit) and the constant colours */
    tevReg = new Int32Array(16); konst = new Int32Array(16);

    /** rasterise the primitives that come (else they are skipped) */
    raster = false;
    /**
     * Where in a pixel the interpolated values (texture coordinates, colours, depth) are taken, in pixels from its
     * left and top edges. Not the middle: the recordings fix x between 0.646 and 0.687 and y between 0.438 and 0.484
     * (README, "the goop"); these are the middle of that. Dolphin's software renderer has 0.495 for both.
     */
    sampleX = Math.fround(2 / 3);
    sampleY = Math.fround(11 / 24);
    /** the embedded frame buffer: RGBA, 8 bits each */
    efb = new Uint8Array(EFB_W * EFB_H * 4);
    /** the pixel engine's counter of 2 x 2 pixel groups that reached the blender (GXReadPixMetric multiplies by 4) */
    blendQuads = 0;
    // statistics
    commands = 0; drawn = 0; copies = 0; trianglesDrawn = 0;
    private warned = new Set<string>();
    /** what is rasterised and copied, as it happens (debugging) */
    trace: ((s: string) => void) | null = null;
    pixelTrace: ((s: string) => void) | null = null;
    private layouts = new Map<string, Layout>();

    constructor(private ram: Uint8Array, private host: GxHost) { }

    private warn(what: string) { if (!this.warned.has(what)) { this.warned.add(what); this.host.unsupported(what); } }

    // ---------------------------------------------------------------- the stream
    private acc = new Uint8Array(4096);
    private accLen = 0;
    /** bytes of a primitive still to come that nothing will look at */
    private skip = 0;
    /** the stream position (bytes since the start) of the next byte no command has taken yet */
    private pos = 0;
    /** positions in the stream where rasterising turns on or off (the replay marks the game's goop passes) */
    private marks: { at: number; on: boolean; untilCopy: boolean }[] = [];
    private nextMark = Infinity;
    private stopAfterCopy = false;
    /** From stream position `at` (see Hardware.streamPos) primitives are rasterised (on) or skipped; untilCopy: off again after the next frame buffer copy. */
    mark(at: number, on: boolean, untilCopy = false) { this.marks.push({ at, on, untilCopy }); this.nextMark = this.marks[0].at; }
    private applyMarks(at: number) {
        while (this.marks.length && this.marks[0].at <= at) { const m = this.marks.shift()!; this.raster = m.on; this.stopAfterCopy = m.on && m.untilCopy; }
        this.nextMark = this.marks.length ? this.marks[0].at : Infinity;
    }
    /** FIFO bytes, in order (a 32-byte burst of the write-gather pipe) */
    feed(b: Uint8Array, off: number, n: number) {
        if (this.skip) { const k = Math.min(this.skip, n); this.skip -= k; this.pos += k; off += k; n -= k; if (!n) return; }
        if (this.accLen === 0) {
            // (the usual case: whole commands in the burst)
            const used = this.run(b, off, off + n, false, this.pos - off);
            this.pos += used - off;
            if (used < off + n) { this.grow(off + n - used); this.acc.set(b.subarray(used, off + n), 0); this.accLen = off + n - used; }
            return;
        }
        this.grow(this.accLen + n);
        this.acc.set(b.subarray(off, off + n), this.accLen); this.accLen += n;
        const used = this.run(this.acc, 0, this.accLen, false, this.pos);
        this.pos += used;
        if (used >= this.accLen) this.accLen = 0;
        else if (used > 0) { this.acc.copyWithin(0, used, this.accLen); this.accLen -= used; }
    }
    private grow(n: number) { if (this.acc.length < n) { const a = new Uint8Array(Math.max(n, this.acc.length * 2)); a.set(this.acc.subarray(0, this.accLen)); this.acc = a; } }

    /** Runs the commands in b[p..end); returns where it stopped (a command not all there yet, in the stream). base + p is p's stream position. */
    private run(b: Uint8Array, p: number, end: number, inList: boolean, base = 0): number {
        while (p < end) {
            if (!inList && base + p >= this.nextMark) this.applyMarks(base + p);
            const cmd = b[p];
            if (cmd === 0) { p++; continue; }
            if (cmd & 0x80) {   // a primitive
                if (p + 3 > end) break;
                const count = (b[p + 1] << 8) | b[p + 2], lay = this.layout(cmd & 7), total = 3 + count * lay.size;
                if (p + total > end) {
                    if (inList) { this.warn('a display list ends inside a primitive'); return end; }
                    if (!this.raster) { this.skip = total - (end - p); this.commands++; return end; }
                    break;
                }
                this.commands++;
                if (this.raster) this.draw(cmd & 0xF8, count, lay, b, p + 3);
                p += total; continue;
            }
            this.commands++;
            switch (cmd) {
                case 0x08: if (p + 6 > end) return p; this.cp[b[p + 1]] = r32(b, p + 2); p += 6; continue;
                case 0x10: {
                    if (p + 5 > end) return p;
                    const n = (b[p + 2] & 0xF) + 1, addr = (b[p + 3] << 8) | b[p + 4];
                    if (p + 5 + 4 * n > end) return p;
                    for (let i = 0; i < n; i++) this.xfLoad(addr + i, r32(b, p + 5 + 4 * i));
                    p += 5 + 4 * n; continue;
                }
                case 0x20: case 0x28: case 0x30: case 0x38: {   // matrices and lights loaded from an array by index
                    if (p + 5 > end) return p;
                    const index = (b[p + 1] << 8) | b[p + 2], v = (b[p + 3] << 8) | b[p + 4], n = (v >>> 12) + 1, addr = v & 0xFFF, arr = 12 + ((cmd - 0x20) >> 3);
                    const src = (this.cp[0xA0 + arr] & 0x03FFFFFF) + index * (this.cp[0xB0 + arr] & 0xFF);
                    for (let i = 0; i < n; i++) this.xfLoad(addr + i, r32(this.ram, src + 4 * i));
                    p += 5; continue;
                }
                case 0x40: {
                    if (p + 9 > end) return p;
                    const addr = r32(b, p + 1) & 0x03FFFFFF, size = r32(b, p + 5);
                    if (inList) this.warn('a display list calls another');
                    else if (addr + size <= this.ram.length) this.run(this.ram, addr, addr + size, true);
                    p += 9; continue;
                }
                case 0x44: case 0x48: p++; continue;   // metrics, invalidate the vertex cache
                case 0x61: if (p + 5 > end) return p; this.bpLoad(r32(b, p + 1)); p += 5; continue;
            }
            this.warn(`an unknown GX command 0x${cmd.toString(16)}${inList ? ' in a display list' : ''}`);
            return end;
        }
        return p;
    }

    private xfLoad(addr: number, v: number) { if (addr < 0x1100) this.xfw[addr] = v; }

    private bpLoad(word: number) {
        const reg = word >>> 24, v = ((this.bp[reg] & ~this.bpMask) | (word & this.bpMask)) & 0xFFFFFF;
        if (reg !== 0xFE) this.bpMask = 0xFFFFFF;
        switch (reg) {
            case 0xFE: this.bpMask = word & 0xFFFFFF; return;
            case 0x45: this.bp[reg] = v; if (v & 2) this.host.finish(); return;
            case 0x47: this.bp[reg] = v; this.host.token(v & 0xFFFF, false); return;
            case 0x48: this.bp[reg] = v; this.host.token(v & 0xFFFF, true); return;
            case 0x52: this.bp[reg] = v; if (this.raster) { this.copy(v); if (this.stopAfterCopy) { this.raster = false; this.stopAfterCopy = false; } } return;
            case 0x57: this.bp[reg] = v; this.blendQuads = 0; return;
            case 0xE0: case 0xE1: case 0xE2: case 0xE3: case 0xE4: case 0xE5: case 0xE6: case 0xE7: {
                // a TEV register (RA, BG): signed 11-bit colours; with bit 23, the constant colours
                const i = (reg - 0xE0) >> 1, lo = (v << 21) >> 21, hi = (v << 9) >> 21, k = v & 0x800000 ? this.konst : this.tevReg;
                if (reg & 1) { k[i * 4 + 2] = lo; k[i * 4 + 1] = hi; } else { k[i * 4] = lo; k[i * 4 + 3] = hi; }
                this.bp[reg] = v; return;
            }
        }
        this.bp[reg] = v;
    }

    // ---------------------------------------------------------------- vertex formats
    private layNow: (Layout | null)[] = [null, null, null, null, null, null, null, null];
    private layKey = new Uint32Array(8 * 5);
    private layout(vat: number): Layout {
        const lo = this.cp[0x50], hi = this.cp[0x60], a = this.cp[0x70 + vat], b = this.cp[0x80 + vat], c = this.cp[0x90 + vat];
        // (the format last used with these registers, without building a key)
        const K = this.layKey, k = vat * 5, last = this.layNow[vat];
        if (last && K[k] === lo && K[k + 1] === hi && K[k + 2] === a && K[k + 3] === b && K[k + 4] === c) return last;
        K[k] = lo; K[k + 1] = hi; K[k + 2] = a; K[k + 3] = b; K[k + 4] = c;
        const key = `${lo},${hi},${a},${b},${c}`;
        let L = this.layouts.get(key);
        if (L) return this.layNow[vat] = L;
        let off = 0;
        const txIdx = new Int8Array(8).fill(-1);
        const pnIdx = lo & 1 ? off++ : -1;
        for (let i = 0; i < 8; i++) if (lo & (2 << i)) txIdx[i] = off++;
        const attr = (how: number, comps: number, fmt: number, frac: number, array: number): Attr | null => {
            if (!how) return null;
            const at: Attr = { off, how, comps, fmt, frac, array };
            off += how === 1 ? comps * COMP_SIZE[Math.min(fmt, 4)] : how - 1;
            return at;
        };
        const pos = attr((lo >>> 9) & 3, a & 1 ? 3 : 2, (a >>> 1) & 7, (a >>> 4) & 31, 0);
        {   // the normal: 3 components, or 9 (with its tangents); three indexes when the format says so
            const how = (lo >>> 11) & 3, nbt = (a >>> 9) & 1, fmt = (a >>> 10) & 7;
            if (how === 1) off += (nbt ? 9 : 3) * COMP_SIZE[Math.min(fmt, 4)];
            else if (how) off += (how - 1) * (nbt && (a >>> 31) ? 3 : 1);
        }
        const col: { off: number; how: number; fmt: number }[] = [];
        for (let i = 0; i < 2; i++) {
            const how = (lo >>> (13 + 2 * i)) & 3, fmt = Math.min((a >>> (14 + 4 * i)) & 7, 5);
            col.push({ off, how, fmt });
            if (how === 1) off += COLOR_SIZE[fmt]; else if (how) off += how - 1;
        }
        const tex: (Attr | null)[] = [];
        const tf = [[a, 21, a, 22, a, 25], [b, 0, b, 1, b, 4], [b, 9, b, 10, b, 13], [b, 18, b, 19, b, 22], [b, 27, b, 28, c, 0], [c, 5, c, 6, c, 9], [c, 14, c, 15, c, 18], [c, 23, c, 24, c, 27]];
        for (let i = 0; i < 8; i++) {
            const f = tf[i];
            tex.push(attr((hi >>> (2 * i)) & 3, (f[0] >>> f[1]) & 1 ? 2 : 1, (f[2] >>> f[3]) & 7, (f[4] >>> f[5]) & 31, 4 + i));
        }
        L = { size: off, pnIdx, txIdx, pos, tex, col };
        this.layouts.set(key, L);
        return this.layNow[vat] = L;
    }
    private comp = new Float64Array(3);
    /** an attribute's components (dequantised) of the vertex at b[p] into this.comp */
    private read(at: Attr, b: Uint8Array, p: number) {
        let src = b, q = p + at.off;
        if (at.how !== 1) {
            const index = at.how === 2 ? b[q] : (b[q] << 8) | b[q + 1];
            src = this.ram; q = (this.cp[0xA0 + at.array] & 0x03FFFFFF) + index * (this.cp[0xB0 + at.array] & 0xFF);
        }
        const out = this.comp, scale = at.fmt === 4 ? 1 : 1 / (1 << at.frac);
        for (let i = 0; i < at.comps; i++) {
            let v: number;
            switch (at.fmt) {
                case 0: v = src[q + i]; break;
                case 1: v = (src[q + i] << 24) >> 24; break;
                case 2: v = (src[q + 2 * i] << 8) | src[q + 2 * i + 1]; break;
                case 3: v = (((src[q + 2 * i] << 8) | src[q + 2 * i + 1]) << 16) >> 16; break;
                default: F32W[0] = r32(src, q + 4 * i); v = F32[0]; break;
            }
            out[i] = fr(v * scale);
        }
        for (let i = at.comps; i < 3; i++) out[i] = 0;
    }

    // ---------------------------------------------------------------- primitives
    private vb: Vtx[] = [];
    private draw(prim: number, count: number, L: Layout, b: Uint8Array, p: number) {
        this.drawn++;
        if (!L.pos || !count) return;
        const v = this.vb;
        while (v.length < count) v.push(newVtx());
        for (let i = 0; i < count; i++) this.vertex(L, b, p + i * L.size, v[i]);
        if (this.trace) this.trace(`prim ${prim.toString(16)} x${count} (${v[0].x},${v[0].y})-(${v[Math.min(2, count - 1)].x},${v[Math.min(2, count - 1)].y}) uv0 ${v[0].s[0]},${v[0].t[0]}..${v[Math.min(2, count - 1)].s[0]},${v[Math.min(2, count - 1)].t[0]} stages ${((this.bp[0] >>> 10) & 15) + 1} gens ${this.bp[0] & 15} c0 ${this.tevReg.slice(4, 8)} c1 ${this.tevReg.slice(8, 12)} blend ${this.bp[0x41].toString(16)} atest ${this.bp[0xF3].toString(16)} z ${this.bp[0x40].toString(16)} cull ${(this.bp[0] >>> 14) & 3} tex0 ${((this.bp[0x94] << 5) >>> 0).toString(16)} ${(this.bp[0x88] & 0x3FF) + 1}x${((this.bp[0x88] >>> 10) & 0x3FF) + 1} f${(this.bp[0x88] >>> 20) & 15} m${this.bp[0x80].toString(16)} quads ${this.blendQuads} | cenv ${this.bp[0xC0].toString(16)} ${this.bp[0xC2].toString(16)} ${this.bp[0xC4].toString(16)} aenv ${this.bp[0xC1].toString(16)} order ${this.bp[0x28].toString(16)} cc ${this.xfw[0x100E].toString(16)} ac ${this.xfw[0x1010].toString(16)} mat ${this.xfw[0x100C].toString(16)} col ${v[0].c.slice(0, 4)}`);
        switch (prim) {
            case 0x80: case 0x88: for (let i = 0; i + 3 < count; i += 4) { this.triangle(v[i], v[i + 1], v[i + 2]); this.triangle(v[i], v[i + 2], v[i + 3]); } return;   // quads
            case 0x90: for (let i = 0; i + 2 < count; i += 3) this.triangle(v[i], v[i + 1], v[i + 2]); return;
            case 0x98: for (let i = 2; i < count; i++) { if (i & 1) this.triangle(v[i - 1], v[i - 2], v[i]); else this.triangle(v[i - 2], v[i - 1], v[i]); } return;   // a strip
            case 0xA0: for (let i = 2; i < count; i++) this.triangle(v[0], v[i - 1], v[i]); return;   // a fan
        }
        this.warn(`a primitive of kind 0x${prim.toString(16)} (lines or points)`);
    }

    /** A vertex through the transform unit: position to the screen, colours, texture coordinates through their generators. */
    private vertex(L: Layout, b: Uint8Array, p: number, out: Vtx) {
        const xf = this.xf, xw = this.xfw, c = this.comp;
        this.read(L.pos!, b, p);
        const px = c[0], py = c[1], pz = c[2];
        const m = (L.pnIdx >= 0 ? b[p + L.pnIdx] & 63 : xw[0x1018] & 63) * 4;
        const ex = fr(fr(fr(xf[m] * px) + fr(xf[m + 1] * py)) + fr(fr(xf[m + 2] * pz) + xf[m + 3]));
        const ey = fr(fr(fr(xf[m + 4] * px) + fr(xf[m + 5] * py)) + fr(fr(xf[m + 6] * pz) + xf[m + 7]));
        const ez = fr(fr(fr(xf[m + 8] * px) + fr(xf[m + 9] * py)) + fr(fr(xf[m + 10] * pz) + xf[m + 11]));
        // the projection (0x1020..0x1025, its kind in 0x1026: 1 orthographic)
        let cx: number, cy: number, w: number;
        const cz = fr(fr(xf[0x1024] * ez) + xf[0x1025]);
        if (xw[0x1026] & 1) { cx = fr(fr(xf[0x1020] * ex) + xf[0x1021]); cy = fr(fr(xf[0x1022] * ey) + xf[0x1023]); w = 1; }
        else { cx = fr(fr(xf[0x1020] * ex) + fr(xf[0x1021] * ez)); cy = fr(fr(xf[0x1022] * ey) + fr(xf[0x1023] * ez)); w = -ez; }
        if (!(w > 0)) this.warn('a vertex behind the eye (no clipping here)');
        const iw = fr(1 / w);
        // the viewport (0x101A: half width, half height, depth range, origin x, y, far); the screen starts at 342
        out.x = fr(fr(fr(cx * iw) * xf[0x101A]) + xf[0x101D]) - 342;
        out.y = fr(fr(fr(cy * iw) * xf[0x101B]) + xf[0x101E]) - 342;
        out.z = fr(fr(fr(cz * iw) * xf[0x101C]) + xf[0x101F]);
        out.w = w;
        // the colour channels, unlit: the material's register, or the vertex's colour (0x100E.. colour, 0x1010.. alpha: bit 0)
        for (let ch = 0; ch < 2; ch++) {
            const mat = xw[0x100C + ch], col = L.col[ch], o = ch * 4;
            let r = mat >>> 24, g = (mat >>> 16) & 0xFF, bl = (mat >>> 8) & 0xFF, al = mat & 0xFF;
            const vc = xw[0x100E + ch] & 1, va = xw[0x1010 + ch] & 1;
            if ((vc || va) && col.how) {
                let src = b, q = p + col.off;
                if (col.how !== 1) { const index = col.how === 2 ? b[q] : (b[q] << 8) | b[q + 1]; src = this.ram; q = (this.cp[0xA2 + ch] & 0x03FFFFFF) + index * (this.cp[0xB2 + ch] & 0xFF); }
                let vr: number, vg: number, vb: number, vl = 255;
                switch (col.fmt) {
                    case 0: { const v = (src[q] << 8) | src[q + 1]; vr = ((v >> 11) << 3) | (v >> 13); vg = (((v >> 5) & 63) << 2) | ((v >> 9) & 3); vb = ((v & 31) << 3) | ((v & 31) >> 2); break; }
                    case 1: case 2: vr = src[q]; vg = src[q + 1]; vb = src[q + 2]; break;
                    case 3: vr = (src[q] >> 4) * 17; vg = (src[q] & 15) * 17; vb = (src[q + 1] >> 4) * 17; vl = (src[q + 1] & 15) * 17; break;
                    case 4: { const v = (src[q] << 16) | (src[q + 1] << 8) | src[q + 2], e = (x: number) => (x << 2) | (x >> 4); vr = e((v >> 18) & 63); vg = e((v >> 12) & 63); vb = e((v >> 6) & 63); vl = e(v & 63); break; }
                    default: vr = src[q]; vg = src[q + 1]; vb = src[q + 2]; vl = src[q + 3];
                }
                if (vc) { r = vr; g = vg; bl = vb; }
                if (va) al = vl;
            }
            out.c[o] = r; out.c[o + 1] = g; out.c[o + 2] = bl; out.c[o + 3] = al;
        }
        // texture coordinates: each generator's source row through its matrix, scaled to texels
        const gens = xw[0x103F] & 15;
        for (let g = 0; g < gens; g++) {
            const info = xw[0x1040 + g], row = (info >>> 7) & 31, type = (info >>> 4) & 7;
            let s = 0, t = 0, q = 1;
            if (type !== 0) this.warn('a texture coordinate generator that is not a matrix (bump or colour)');
            if (row === 0) { s = px; t = py; q = pz; }
            else if (row >= 5 && row <= 12) { const at = L.tex[row - 5]; if (at) { this.read(at, b, p); s = c[0]; t = c[1]; } q = 1; }
            else this.warn('a texture coordinate generated from normals or colours');
            const ti = (L.txIdx[g] >= 0 ? b[p + L.txIdx[g]] & 63 : g < 4 ? (xw[0x1018] >>> (6 + 6 * g)) & 63 : (xw[0x1019] >>> (6 * (g - 4))) & 63) * 4;
            // (the input form AB11: s, t, 1, 1; ABC1 takes the position's z)
            const z = info & 4 ? q : 1;
            let os = fr(fr(fr(xf[ti] * s) + fr(xf[ti + 1] * t)) + fr(fr(xf[ti + 2] * z) + xf[ti + 3]));
            let ot = fr(fr(fr(xf[ti + 4] * s) + fr(xf[ti + 5] * t)) + fr(fr(xf[ti + 6] * z) + xf[ti + 7]));
            let oq = 1;
            if (info & 2) oq = fr(fr(fr(xf[ti + 8] * s) + fr(xf[ti + 9] * t)) + fr(fr(xf[ti + 10] * z) + xf[ti + 11]));
            if (xw[0x1012] & 1) {   // the second (post) transform
                const pi = 0x500 + (xw[0x1050 + g] & 63) * 4, a0 = os, a1 = ot, a2 = oq;
                os = fr(fr(fr(xf[pi] * a0) + fr(xf[pi + 1] * a1)) + fr(fr(xf[pi + 2] * a2) + xf[pi + 3]));
                ot = fr(fr(fr(xf[pi + 4] * a0) + fr(xf[pi + 5] * a1)) + fr(fr(xf[pi + 6] * a2) + xf[pi + 7]));
                oq = fr(fr(fr(xf[pi + 8] * a0) + fr(xf[pi + 9] * a1)) + fr(fr(xf[pi + 10] * a2) + xf[pi + 11]));
            }
            out.s[g] = fr(os * ((this.bp[0x30 + 2 * g] & 0xFFFF) + 1)); out.t[g] = fr(ot * ((this.bp[0x31 + 2 * g] & 0xFFFF) + 1)); out.q[g] = oq;
        }
    }

    // ---------------------------------------------------------------- the rasteriser
    private triangle(a: Vtx, b: Vtx, c: Vtx) {
        this.trianglesDrawn++;
        // (every triangle sent counts one group in the blender's counter, whatever it covers: the game takes it off again)
        this.blendQuads++;
        // the front is clockwise on the screen (with the usual viewport, whose height is negative)
        const nz = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
        if (nz === 0) return;
        const front = (nz > 0) !== (this.xf[0x101B] > 0), cull = (this.bp[0] >>> 14) & 3;
        if (front ? cull & 2 : cull & 1) return;
        // (the rasteriser wants its vertices counter-clockwise on the screen; the first stays the first)
        if (nz < 0) this.raster3(a, b, c); else this.raster3(a, c, b);
    }
    private raster3(v0: Vtx, v1: Vtx, v2: Vtx) {
        // 28.4 fixed-point coordinates, rounded to nearest and adjusted to the hardware's output
        const X1 = Math.round(16 * v0.x) - 9, X2 = Math.round(16 * v1.x) - 9, X3 = Math.round(16 * v2.x) - 9;
        const Y1 = Math.round(16 * v0.y) - 9, Y2 = Math.round(16 * v1.y) - 9, Y3 = Math.round(16 * v2.y) - 9;
        const DX12 = X1 - X2, DX23 = X2 - X3, DX31 = X3 - X1, DY12 = Y1 - Y2, DY23 = Y2 - Y3, DY31 = Y3 - Y1;
        const FDX12 = DX12 * 16, FDX23 = DX23 * 16, FDX31 = DX31 * 16, FDY12 = DY12 * 16, FDY23 = DY23 * 16, FDY31 = DY31 * 16;
        let minx = (Math.min(X1, X2, X3) + 0xF) >> 4, maxx = (Math.max(X1, X2, X3) + 0xF) >> 4;
        let miny = (Math.min(Y1, Y2, Y3) + 0xF) >> 4, maxy = (Math.max(Y1, Y2, Y3) + 0xF) >> 4;
        // the scissor (0x20: top and left + 342; 0x21: bottom and right + 341; 0x59: the offset, halved)
        const bp = this.bp, xoff = (bp[0x59] & 0x3FF) * 2 - 342, yoff = ((bp[0x59] >>> 10) & 0x3FF) * 2 - 342;
        const sl = Math.max(0, ((bp[0x20] >>> 12) & 0x7FF) - xoff - 342), st = Math.max(0, (bp[0x20] & 0x7FF) - yoff - 342);
        const sr = Math.min(EFB_W, ((bp[0x21] >>> 12) & 0x7FF) - xoff - 341), sb = Math.min(EFB_H, (bp[0x21] & 0x7FF) - yoff - 341);
        minx = Math.max(minx, sl); maxx = Math.min(maxx, sr); miny = Math.max(miny, st); maxy = Math.min(maxy, sb);
        if (minx >= maxx || miny >= maxy) return;
        this.setupPixel();
        // slopes: each interpolated value as a plane over the screen, from vertex 0
        const fx1 = v0.x, fy1 = v0.y, dx31 = fr(v2.x - fx1), dx12 = fr(fx1 - v1.x), dy12 = fr(fy1 - v1.y), dy31 = fr(v2.y - fy1);
        const vx0 = (X1 + 0xF) >> 4, vy0 = (Y1 + 0xF) >> 4;
        const offX = fr(fr(vx0 - fx1) + this.sampleX), offY = fr(fr(vy0 - fy1) + this.sampleY);
        const w0 = fr(1 / v0.w), w1 = fr(1 / v1.w), w2 = fr(1 / v2.w);
        const cden = fr(fr(-dx12 * dy31) - fr(dx31 * -dy12));
        const S = this.slopes;
        const slope = (f1: number, f2: number, f3: number, i: number) => {
            const d31 = fr(f3 - f1), d21 = fr(f2 - f1);
            const pa = fr(fr(d31 * -dy12) - fr(d21 * dy31)), pb = fr(fr(dx31 * d21) + fr(dx12 * d31));
            S[i] = f1; S[i + 1] = fr(-pa / cden); S[i + 2] = fr(-pb / cden);
        };
        const gens = (bp[0] & 15), ras = this.ras;
        slope(w0, w1, w2, 0);
        for (let g = 0; g < gens; g++) {
            slope(fr(v0.s[g] * w0), fr(v1.s[g] * w1), fr(v2.s[g] * w2), 3 + g * 9);
            slope(fr(v0.t[g] * w0), fr(v1.t[g] * w1), fr(v2.t[g] * w2), 6 + g * 9);
            slope(fr(v0.q[g] * w0), fr(v1.q[g] * w1), fr(v2.q[g] * w2), 9 + g * 9);
        }
        // the channels' colours: the same at the three corners, or planes too
        let varying = false;
        for (let i = 0; i < 8; i++) {
            if (!this.chanUsed[i >> 2]) continue;
            ras[i] = v0.c[i];
            if (v0.c[i] !== v1.c[i] || v0.c[i] !== v2.c[i]) { varying = true; }
            slope(v0.c[i], v1.c[i], v2.c[i], 80 + i * 3);
        }
        const zOn = (bp[0x40] & 1) !== 0;
        if (zOn) slope(v0.z, v1.z, v2.z, 104);
        // (with one intensity texture as the only thing that changes from pixel to pixel, the environment's result is a function of one byte: kept)
        const memo = !varying && this.memoMap !== -1;
        if (memo) this.memoState.fill(0);
        // half-edge constants, corrected for the fill convention (top-left)
        let C1 = DY12 * X1 - DX12 * Y1, C2 = DY23 * X2 - DX23 * Y2, C3 = DY31 * X3 - DX31 * Y3;
        if (DY12 < 0 || (DY12 === 0 && DX12 > 0)) C1++;
        if (DY23 < 0 || (DY23 === 0 && DX23 > 0)) C2++;
        if (DY31 < 0 || (DY31 === 0 && DX31 > 0)) C3++;
        let CY1 = C1 + DX12 * (miny << 4) - DY12 * (minx << 4), CY2 = C2 + DX23 * (miny << 4) - DY23 * (minx << 4), CY3 = C3 + DX31 * (miny << 4) - DY31 * (minx << 4);
        const uv = this.uv, proj = this.xfw;
        // the groups of 2 x 2 pixels this triangle put through the blender
        const qw = (EFB_W >> 1) + 1, seen = this.quadSeen;
        const qx0 = minx >> 1, qx1 = (maxx - 1) >> 1, qy0 = miny >> 1, qy1 = (maxy - 1) >> 1;
        for (let qy = qy0; qy <= qy1; qy++) seen.fill(0, qy * qw + qx0, qy * qw + qx1 + 1);
        for (let y = miny; y < maxy; y++) {
            let CX1 = CY1, CX2 = CY2, CX3 = CY3;
            for (let x = minx; x < maxx; x++) {
                if (CX1 > 0 && CX2 > 0 && CX3 > 0) {
                    const dx = fr(offX + (x - vx0)), dy = fr(offY + (y - vy0));
                    const invW = fr(1 / fr(fr(S[0] + fr(S[1] * dx)) + fr(S[2] * dy)));
                    for (let g = 0; g < gens; g++) {
                        const o = 3 + g * 9;
                        let pr = invW;
                        if (proj[0x1040 + g] & 2) { const q = fr(fr(fr(S[o + 6] + fr(S[o + 7] * dx)) + fr(S[o + 8] * dy)) * invW); if (q !== 0) pr = fr(invW / q); }
                        // (the texture environment takes texture coordinates with 7 fractional bits)
                        uv[g * 2] = Math.trunc(fr(fr(fr(fr(S[o] + fr(S[o + 1] * dx)) + fr(S[o + 2] * dy)) * pr) * 128));
                        uv[g * 2 + 1] = Math.trunc(fr(fr(fr(fr(S[o + 3] + fr(S[o + 4] * dx)) + fr(S[o + 5] * dy)) * pr) * 128));
                    }
                    if (varying) for (let i = 0; i < 8; i++) if (this.chanUsed[i >> 2]) { const o = 80 + i * 3, v = Math.trunc(fr(fr(S[o] + fr(S[o + 1] * dx)) + fr(S[o + 2] * dy))); ras[i] = v < 0 ? 0 : v > 255 ? 255 : v; }
                    let z = 0;
                    if (zOn) { z = Math.trunc(fr(fr(S[104] + fr(S[105] * dx)) + fr(S[106] * dy))); z = z < 0 ? 0 : z > 0xFFFFFF ? 0xFFFFFF : z; }
                    if (this.pixel(x, y, z, memo)) { const qi = (y >> 1) * qw + (x >> 1); if (!seen[qi]) { seen[qi] = 1; this.blendQuads++; } }
                }
                CX1 -= FDY12; CX2 -= FDY23; CX3 -= FDY31;
            }
            CY1 += FDX12; CY2 += FDX23; CY3 += FDX31;
        }
    }
    private slopes = new Float64Array(110);
    private uv = new Int32Array(16);
    private quadSeen = new Uint8Array(((EFB_W >> 1) + 1) * ((EFB_H >> 1) + 1));
    /** the depth buffer (24 bits) */
    zbuf = new Uint32Array(EFB_W * EFB_H).fill(0xFFFFFF);

    // ---- the texture environment, per pixel
    private stages = 0;
    /** the two channels' rasterised colours at the pixel (r g b a each); which channels a stage takes */
    private ras = new Int32Array(8);
    private chanUsed = [false, false];
    /** the one texture map and coordinate every textured stage takes, an intensity texture (-1: not so; -2: no stage takes a texture) */
    private memoMap = -1; private memoCoord = 0;
    private memoState = new Uint8Array(256); private memoOut = new Int32Array(256 * 4);
    private texInfo: { addr: number; w: number; h: number; fmt: number; wrapS: number; wrapT: number; linear: boolean; mixed: boolean }[] = [];
    /** what stays the same over a triangle */
    private setupPixel() {
        const bp = this.bp, xw = this.xfw;
        this.stages = ((bp[0] >>> 10) & 15) + 1;
        for (let i = 0; i < 8; i++) {
            const base = i < 4 ? i : 0x20 + (i - 4), m0 = bp[0x80 + base], i0 = bp[0x88 + base], i3 = bp[0x94 + base];
            // (the filter for a texture drawn larger; the one for smaller is expected to be the same kind: checked where sampled)
            this.texInfo[i] = { addr: (i3 << 5) & 0x03FFFFFF, w: (i0 & 0x3FF) + 1, h: ((i0 >>> 10) & 0x3FF) + 1, fmt: (i0 >>> 20) & 15, wrapS: m0 & 3, wrapT: (m0 >>> 2) & 3, linear: (m0 & 0x10) !== 0, mixed: ((m0 >>> 4) & 1) !== ((m0 >>> 7) & 1) || ((m0 >>> 5) & 3) !== 0 };
        }
        this.chanUsed[0] = this.chanUsed[1] = false;
        let map = -2, coord = 0;
        for (let st = 0; st < this.stages; st++) {
            const order = bp[0x28 + (st >> 1)] >>> ((st & 1) * 12), chan = (order >>> 7) & 7;
            if (chan < 2) {
                this.chanUsed[chan] = true;
                if ((xw[0x100E + chan] & 2) || (xw[0x1010 + chan] & 2)) this.warn('lighting');
            }
            if (order & 0x40) {
                const m = order & 7, c = (order >>> 3) & 7;
                if (map === -2 && this.texInfo[m].fmt < 2) { map = m; coord = c; } else if (map !== m || coord !== c) map = -1;
            }
        }
        this.memoMap = map; this.memoCoord = coord;
        if (bp[0] & 0x70000) this.warn('indirect textures');
        if (bp[0x43] & 7) this.warn('a frame buffer that is not 8 bits a colour');
    }
    private reg = new Int32Array(16);
    private texel = new Int32Array(4);
    private out = new Int32Array(4);
    /** One pixel through the depth test, the texture environment, the alpha test and the blender; true if it reached the blender. */
    private pixel(x: number, y: number, z: number, memo: boolean): boolean {
        const bp = this.bp, O = this.out, zm = bp[0x40], pi = y * EFB_W + x;
        const early = (bp[0x43] & 0x40) !== 0;
        if ((zm & 1) && early) { if (!alphaPass(z, this.zbuf[pi], (zm >>> 1) & 7)) return false; if (zm & 0x10) this.zbuf[pi] = z; }
        if (memo) {
            let v = 0;
            if (this.memoMap >= 0) { this.sample(this.memoMap, this.uv[this.memoCoord * 2], this.uv[this.memoCoord * 2 + 1]); v = this.texel[0]; }
            const M = this.memoOut, k = v * 4;
            if (!this.memoState[v]) { const t = this.texel; t[0] = t[1] = t[2] = t[3] = v; this.memoState[v] = this.tev(true) ? 1 : 2; M[k] = O[0]; M[k + 1] = O[1]; M[k + 2] = O[2]; M[k + 3] = O[3]; }
            if (this.memoState[v] === 2) return false;
            O[0] = M[k]; O[1] = M[k + 1]; O[2] = M[k + 2]; O[3] = M[k + 3];
        } else if (!this.tev(false)) return false;
        if ((zm & 1) && !early) { if (!alphaPass(z, this.zbuf[pi], (zm >>> 1) & 7)) return false; if (zm & 0x10) this.zbuf[pi] = z; }
        const sr = O[0], sg = O[1], sb = O[2], sa = O[3];
        // ---- the blender (0x41)
        const bm = bp[0x41], efb = this.efb, o = pi * 4;
        let nr = sr, ng = sg, nb = sb, na = sa;
        if (bm & 1) {
            if (bm & 0x800) this.warn('subtractive blending');
            const dr = efb[o], dg = efb[o + 1], db = efb[o + 2], da = 255;   // (no alpha in an RGB8 frame buffer: it reads as full)
            const sf = (bm >>> 8) & 7, df = (bm >>> 5) & 7;
            nr = blend(sr, dr, factor(sf, sr, dr, sa, da, true), factor(df, sr, dr, sa, da, false));
            ng = blend(sg, dg, factor(sf, sg, dg, sa, da, true), factor(df, sg, dg, sa, da, false));
            nb = blend(sb, db, factor(sf, sb, db, sa, da, true), factor(df, sb, db, sa, da, false));
            na = blend(sa, da, factor(sf, sa, da, sa, da, true), factor(df, sa, da, sa, da, false));
        } else if (bm & 2) this.warn('logic operations');
        if (this.pixelTrace) this.pixelTrace(`px ${x},${y} uv ${this.uv[0]},${this.uv[1]} ${this.uv[2]},${this.uv[3]} src ${sr},${sa} dst ${efb[o]} -> ${nr}`);
        if (bm & 8) { efb[o] = nr; efb[o + 1] = ng; efb[o + 2] = nb; }
        if (bm & 0x10) efb[o + 3] = na;
        return true;
    }
    /** The texture environment and the alpha test for the pixel set up (this.uv, this.ras): the colour into this.out; false if the alpha test fails. preset: this.texel is the texture's sample already. */
    private tev(preset: boolean): boolean {
        const bp = this.bp, R = this.reg, tex = this.texel, K = this.konst, ras = this.ras;
        R.set(this.tevReg);
        let tr = 0, tg = 0, tb = 0, ta = 0;
        for (let st = 0; st < this.stages; st++) {
            const order = bp[0x28 + (st >> 1)] >>> ((st & 1) * 12), cenv = bp[0xC0 + 2 * st], aenv = bp[0xC1 + 2 * st];
            if (order & 0x40) {
                if (!preset) { const coord = (order >>> 3) & 7; this.sample(order & 7, this.uv[coord * 2], this.uv[coord * 2 + 1]); }
                tr = tex[0]; tg = tex[1]; tb = tex[2]; ta = tex[3];
                if (aenv & 0xC) this.warn('a texture colour swap');
            }
            const chan = (order >>> 7) & 7;
            let rr = 0, rg = 0, rb = 0, ra = 0;
            if (chan < 2) { rr = ras[chan * 4]; rg = ras[chan * 4 + 1]; rb = ras[chan * 4 + 2]; ra = ras[chan * 4 + 3]; }
            // the constant colour this stage selects (KSEL 0xF6 + stage / 2)
            const ks = bp[0xF6 + (st >> 1)] >>> ((st & 1) * 10), kc = (ks >>> 4) & 31, ka = (ks >>> 9) & 31;
            let kr: number, kg: number, kb: number, kav: number;
            if (kc < 8) kr = kg = kb = KFRAC[kc];
            else if (kc < 12) { kr = kg = kb = 0; this.warn('a reserved constant colour selection'); }
            else if (kc < 16) { const i = (kc - 12) * 4; kr = K[i] & 0xFF; kg = K[i + 1] & 0xFF; kb = K[i + 2] & 0xFF; }
            else { const i = (kc & 3) * 4 + ((kc - 16) >> 2); kr = kg = kb = K[i] & 0xFF; }
            if (ka < 8) kav = KFRAC[ka]; else if (ka < 16) { kav = 0; this.warn('a reserved constant alpha selection'); } else kav = K[(ka & 3) * 4 + ((ka - 16) >> 2)] & 0xFF;
            // ---- colour
            const dest = ((cenv >>> 22) & 3) * 4, sa = (cenv >>> 12) & 15, sb = (cenv >>> 8) & 15, sc = (cenv >>> 4) & 15, sd = cenv & 15, cmpC = ((cenv >>> 16) & 3) === 3;
            const a0 = this.pickC(sa, 0, R, tr, tg, tb, ta, rr, rg, rb, ra, kr, kg, kb) & 0xFF, a1 = this.pickC(sa, 1, R, tr, tg, tb, ta, rr, rg, rb, ra, kr, kg, kb) & 0xFF, a2 = this.pickC(sa, 2, R, tr, tg, tb, ta, rr, rg, rb, ra, kr, kg, kb) & 0xFF;
            const b0 = this.pickC(sb, 0, R, tr, tg, tb, ta, rr, rg, rb, ra, kr, kg, kb) & 0xFF, b1 = this.pickC(sb, 1, R, tr, tg, tb, ta, rr, rg, rb, ra, kr, kg, kb) & 0xFF, b2 = this.pickC(sb, 2, R, tr, tg, tb, ta, rr, rg, rb, ra, kr, kg, kb) & 0xFF;
            let or = 0, og = 0, ob = 0;
            for (let ch = 0; ch < 3; ch++) {
                const A = ch === 0 ? a0 : ch === 1 ? a1 : a2, B = ch === 0 ? b0 : ch === 1 ? b1 : b2;
                const C = this.pickC(sc, ch, R, tr, tg, tb, ta, rr, rg, rb, ra, kr, kg, kb) & 0xFF, D = this.pickC(sd, ch, R, tr, tg, tb, ta, rr, rg, rb, ra, kr, kg, kb);
                let v: number;
                if (cmpC) {   // a comparison of a and b (their red, red and green, all three as one number, or channel by channel): d + (it holds ? c : 0)
                    const mode = (cenv >>> 20) & 3;
                    const x = mode === 0 ? a0 : mode === 1 ? (a1 << 8) | a0 : mode === 2 ? (a2 << 16) | (a1 << 8) | a0 : A;
                    const yv = mode === 0 ? b0 : mode === 1 ? (b1 << 8) | b0 : mode === 2 ? (b2 << 16) | (b1 << 8) | b0 : B;
                    v = D + (((cenv >>> 18) & 1 ? x === yv : x > yv) ? C : 0);
                } else v = tevLerp(A, B, C, D, (cenv >>> 16) & 3, (cenv >>> 18) & 1, (cenv >>> 20) & 3);
                v = cenv & 0x80000 ? (v < 0 ? 0 : v > 255 ? 255 : v) : (v < -1024 ? -1024 : v > 1023 ? 1023 : v);
                if (ch === 0) or = v; else if (ch === 1) og = v; else ob = v;
            }
            // ---- alpha
            const xa = (aenv >>> 13) & 7, xb = (aenv >>> 10) & 7, xc = (aenv >>> 7) & 7, xd = (aenv >>> 4) & 7;
            const AA = (xa === 0 ? R[3] : xa === 1 ? R[7] : xa === 2 ? R[11] : xa === 3 ? R[15] : xa === 4 ? ta : xa === 5 ? ra : xa === 6 ? kav : 0) & 0xFF;
            const AB = (xb === 0 ? R[3] : xb === 1 ? R[7] : xb === 2 ? R[11] : xb === 3 ? R[15] : xb === 4 ? ta : xb === 5 ? ra : xb === 6 ? kav : 0) & 0xFF;
            const AC = (xc === 0 ? R[3] : xc === 1 ? R[7] : xc === 2 ? R[11] : xc === 3 ? R[15] : xc === 4 ? ta : xc === 5 ? ra : xc === 6 ? kav : 0) & 0xFF;
            const AD = xd === 0 ? R[3] : xd === 1 ? R[7] : xd === 2 ? R[11] : xd === 3 ? R[15] : xd === 4 ? ta : xd === 5 ? ra : xd === 6 ? kav : 0;
            let oa: number;
            if (((aenv >>> 16) & 3) === 3) {   // (but for the per-channel mode, alpha compares the colour inputs)
                const mode = (aenv >>> 20) & 3;
                const x = mode === 0 ? a0 : mode === 1 ? (a1 << 8) | a0 : mode === 2 ? (a2 << 16) | (a1 << 8) | a0 : AA;
                const yv = mode === 0 ? b0 : mode === 1 ? (b1 << 8) | b0 : mode === 2 ? (b2 << 16) | (b1 << 8) | b0 : AB;
                oa = AD + (((aenv >>> 18) & 1 ? x === yv : x > yv) ? AC : 0);
            } else oa = tevLerp(AA, AB, AC, AD, (aenv >>> 16) & 3, (aenv >>> 18) & 1, (aenv >>> 20) & 3);
            oa = aenv & 0x80000 ? (oa < 0 ? 0 : oa > 255 ? 255 : oa) : (oa < -1024 ? -1024 : oa > 1023 ? 1023 : oa);
            R[dest] = or; R[dest + 1] = og; R[dest + 2] = ob;
            R[((aenv >>> 22) & 3) * 4 + 3] = oa;
        }
        const O = this.out, sa = R[3] & 0xFF;
        O[0] = R[0] & 0xFF; O[1] = R[1] & 0xFF; O[2] = R[2] & 0xFF; O[3] = sa;
        // ---- the alpha test (0xF3)
        const at = bp[0xF3], p0 = alphaPass(sa, at & 0xFF, (at >>> 16) & 7), p1 = alphaPass(sa, (at >>> 8) & 0xFF, (at >>> 19) & 7);
        const logic = (at >>> 22) & 3;
        return logic === 0 ? p0 && p1 : logic === 1 ? p0 || p1 : logic === 2 ? p0 !== p1 : p0 === p1;
    }
    private pickC(sel: number, ch: number, R: Int32Array, tr: number, tg: number, tb: number, ta: number, rr: number, rg: number, rb: number, ra: number, kr: number, kg: number, kb: number): number {
        switch (sel) {
            case 0: return R[ch]; case 1: return R[3]; case 2: return R[4 + ch]; case 3: return R[7]; case 4: return R[8 + ch]; case 5: return R[11];
            case 6: return R[12 + ch]; case 7: return R[15]; case 8: return ch === 0 ? tr : ch === 1 ? tg : tb; case 9: return ta;
            case 10: return ch === 0 ? rr : ch === 1 ? rg : rb; case 11: return ra; case 12: return 255; case 13: return 128;
            case 14: return ch === 0 ? kr : ch === 1 ? kg : kb; default: return 0;
        }
    }

    // ---- textures
    /** texture `map` at (s, t) (texels, 7 fractional bits) into this.texel */
    private sample(map: number, s: number, t: number) {
        const ti = this.texInfo[map], out = this.texel;
        if (ti.mixed) this.warn('a texture with mipmaps or two kinds of filter');
        if (!ti.linear) { this.fetch(ti, wrap(s >> 7, ti.wrapS, ti.w), wrap(t >> 7, ti.wrapT, ti.h), out); return; }
        s -= 64; t -= 64;
        const is = s >> 7, it = t >> 7, fs = s & 127, ft = t & 127;
        const s0 = wrap(is, ti.wrapS, ti.w), s1 = wrap(is + 1, ti.wrapS, ti.w), t0 = wrap(it, ti.wrapT, ti.h), t1 = wrap(it + 1, ti.wrapT, ti.h);
        const tmp = this.tmp;
        let r = 0, g = 0, b = 0, a = 0, w = (128 - fs) * (128 - ft);
        this.fetch(ti, s0, t0, tmp); r += tmp[0] * w; g += tmp[1] * w; b += tmp[2] * w; a += tmp[3] * w;
        w = fs * (128 - ft); this.fetch(ti, s1, t0, tmp); r += tmp[0] * w; g += tmp[1] * w; b += tmp[2] * w; a += tmp[3] * w;
        w = (128 - fs) * ft; this.fetch(ti, s0, t1, tmp); r += tmp[0] * w; g += tmp[1] * w; b += tmp[2] * w; a += tmp[3] * w;
        w = fs * ft; this.fetch(ti, s1, t1, tmp); r += tmp[0] * w; g += tmp[1] * w; b += tmp[2] * w; a += tmp[3] * w;
        out[0] = r >> 14; out[1] = g >> 14; out[2] = b >> 14; out[3] = a >> 14;
    }
    private tmp = new Int32Array(4);
    private fetch(ti: { addr: number; w: number; h: number; fmt: number }, x: number, y: number, out: Int32Array) {
        const ram = this.ram;
        switch (ti.fmt) {
            case 0: {   // I4: 8 x 8 blocks, 4 bits
                const p = ti.addr + ((y >> 3) * ((ti.w + 7) >> 3) + (x >> 3)) * 32 + (y & 7) * 4 + ((x & 7) >> 1);
                let v = x & 1 ? ram[p] & 15 : ram[p] >> 4; v |= v << 4;
                out[0] = out[1] = out[2] = out[3] = v; return;
            }
            case 1: {   // I8: 8 x 4 blocks
                const v = ram[ti.addr + ((y >> 2) * ((ti.w + 7) >> 3) + (x >> 3)) * 32 + (y & 3) * 8 + (x & 7)];
                out[0] = out[1] = out[2] = out[3] = v; return;
            }
            case 2: {   // IA4: 8 x 4 blocks, alpha in the high half
                const v = ram[ti.addr + ((y >> 2) * ((ti.w + 7) >> 3) + (x >> 3)) * 32 + (y & 3) * 8 + (x & 7)];
                out[0] = out[1] = out[2] = (v & 15) * 17; out[3] = (v >> 4) * 17; return;
            }
            case 3: {   // IA8: 4 x 4 blocks, alpha then intensity
                const p = ti.addr + ((y >> 2) * ((ti.w + 3) >> 2) + (x >> 2)) * 32 + ((y & 3) * 4 + (x & 3)) * 2;
                out[0] = out[1] = out[2] = ram[p + 1]; out[3] = ram[p]; return;
            }
        }
        this.warn(`a texture of format ${ti.fmt}`);
        out[0] = out[1] = out[2] = out[3] = 0;
    }

    // ---------------------------------------------------------------- the copy out of the frame buffer
    /** BP 0x52: copies a rectangle of the frame buffer into a texture in memory (and clears it). */
    private copy(ctl: number) {
        const bp = this.bp, ram = this.ram, efb = this.efb;
        const sx = bp[0x49] & 0x3FF, sy = (bp[0x49] >>> 10) & 0x3FF, sw = (bp[0x4A] & 0x3FF) + 1, sh = ((bp[0x4A] >>> 10) & 0x3FF) + 1;
        if (this.trace) this.trace(`copy ctl ${ctl.toString(16)} src ${sx},${sy} ${sw}x${sh} to ${((bp[0x4B] << 5) >>> 0).toString(16)} quads ${this.blendQuads} filter ${bp[0x53].toString(16)} ${bp[0x54].toString(16)} samples ${bp[1].toString(16)}`);
        if (!(ctl & 0x4000)) {
            this.copies++;
            const f = (ctl >>> 3) & 15, fmt = (f >> 1) + (f & 1) * 8, dst = (bp[0x4B] << 5) & 0x03FFFFFF, half = (ctl >>> 9) & 1;
            if (half) this.warn('a half-size frame buffer copy');
            if (ctl & 0x8000) this.warn('a frame buffer copy to intensity');
            if (((ctl >>> 7) & 3) !== 0) this.warn('a frame buffer copy with gamma');
            // (the vertical filter's seven weights: 0x53, 0x54; the usual set leaves each line as it is)
            const w = [bp[0x53] & 63, (bp[0x53] >>> 6) & 63, (bp[0x53] >>> 12) & 63, (bp[0x53] >>> 18) & 63, bp[0x54] & 63, (bp[0x54] >>> 6) & 63, (bp[0x54] >>> 12) & 63];
            const wp = w[0] + w[1], wc = w[2] + w[3] + w[4], wn = w[5] + w[6];
            // the channel an 8-bit copy takes: A8 (7), R8 (8), G8 (9), B8 (10)
            const ch = fmt === 8 ? 0 : fmt === 9 ? 1 : fmt === 10 ? 2 : fmt === 7 ? 3 : -1;
            if (ch < 0) { this.warn(`a frame buffer copy to format ${fmt}`); }
            else {
                const bw = (sw + 7) >> 3;
                for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
                    const ex = sx + x, ey = sy + y;
                    if (ex >= EFB_W || ey >= EFB_H) continue;
                    const cur = efb[(ey * EFB_W + ex) * 4 + ch];
                    let v = cur;
                    if (wp || wn || wc !== 64) {
                        const prev = efb[(Math.max(ey - 1, ctl & 1 ? sy : 0) * EFB_W + ex) * 4 + ch], next = efb[(Math.min(ey + 1, ctl & 2 ? sy + sh - 1 : EFB_H - 1) * EFB_W + ex) * 4 + ch];
                        v = (prev * wp + cur * wc + next * wn) >> 6; if (v > 255) v = 255;
                    }
                    ram[dst + ((y >> 2) * bw + (x >> 3)) * 32 + (y & 3) * 8 + (x & 7)] = v;
                }
            }
        } else this.warn('a frame buffer copy to the display while rasterising');
        if (ctl & 0x800) {
            // the clear: colour 0x4F (alpha, red) and 0x50 (green, blue), where the blender's updates are on
            const bm = bp[0x41], cr = bp[0x4F] & 0xFF, ca = (bp[0x4F] >>> 8) & 0xFF, cb = bp[0x50] & 0xFF, cg = (bp[0x50] >>> 8) & 0xFF;
            for (let y = sy; y < sy + sh && y < EFB_H; y++) for (let x = sx; x < sx + sw && x < EFB_W; x++) {
                const o = (y * EFB_W + x) * 4;
                if (bm & 8) { efb[o] = cr; efb[o + 1] = cg; efb[o + 2] = cb; }
                if (bm & 0x10) efb[o + 3] = ca;
                if (bp[0x40] & 0x10) this.zbuf[y * EFB_W + x] = bp[0x51] & 0xFFFFFF;
            }
        }
    }
}

// ---------------------------------------------------------------- helpers
const F32 = new Float32Array(1), F32W = new Uint32Array(F32.buffer);
const r32 = (b: Uint8Array, p: number) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
/** the constant fractions a stage can select: 8/8 ... 1/8 */
const KFRAC = [255, 223, 191, 159, 128, 96, 64, 32];
const SCALE_L = [0, 1, 2, 0], SCALE_R = [0, 0, 0, 1], BIAS = [0, 128, -128, 0];
/** a stage's blend: d + bias +- lerp(a, b, c), scaled (the hardware's formula, as Dolphin's software renderer has it) */
function tevLerp(a: number, b: number, c: number, d: number, bias: number, sub: number, scale: number) {
    const cc = c + (c >> 7);
    let t = a * (256 - cc) + b * cc;
    t <<= SCALE_L[scale];
    t += scale === 3 ? 0 : sub ? 127 : 128;
    t >>= 8;
    if (sub) t = -t;
    return (((d + BIAS[bias]) << SCALE_L[scale]) + t) >> SCALE_R[scale];
}
function alphaPass(a: number, ref: number, comp: number) {
    switch (comp) { case 0: return false; case 1: return a < ref; case 2: return a === ref; case 3: return a <= ref; case 4: return a > ref; case 5: return a !== ref; case 6: return a >= ref; default: return true; }
}
/** a blend factor (0..255) for one channel: src 2 / 3 are the destination's colour, dst 2 / 3 the source's */
function factor(f: number, s: number, d: number, sa: number, da: number, src: boolean) {
    switch (f) {
        case 0: return 0; case 1: return 255;
        case 2: return src ? d : s; case 3: return 255 - (src ? d : s);
        case 4: return sa; case 5: return 255 - sa; case 6: return da; default: return 255 - da;
    }
}
function blend(s: number, d: number, sf: number, df: number) {
    // (a factor of 255 counts as 256)
    sf += sf >> 7; df += df >> 7;
    const v = (s * sf + d * df) >> 8;
    return v > 255 ? 255 : v;
}
function wrap(c: number, mode: number, size: number) {
    if (mode === 0) return c < 0 ? 0 : c >= size ? size - 1 : c;
    if (mode === 1) return ((c % size) + size) % size;
    const m = ((c % (2 * size)) + 2 * size) % (2 * size);
    return m < size ? m : 2 * size - 1 - m;
}
