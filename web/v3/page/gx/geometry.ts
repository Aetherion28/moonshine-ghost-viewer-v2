// v3, the page's GPU: a primitive's vertices, from the bytes of the command stream (and the vertex arrays in the
// game's RAM that indexed attributes point into) to vertex and index buffers.
//
// A vertex's bytes are laid out by the vertex descriptor (CP 0x50, 0x60: which attributes are there, direct or as
// an index) and the vertex format the primitive names (CP 0x70, 0x80, 0x90 + format: each attribute's type). The
// decoding itself is noclip's vertex loader (gx_displaylist.ts), which makes one function per layout; this file
// builds its inputs from the registers, keeps one loader per layout, and owns the buffers:
//   - primitives in a display list are decoded once and kept (the list, the registers they were decoded under,
//     the arrays read), until the game writes the list or the arrays again;
//   - primitives in the stream itself go into one buffer that is filled from its start each frame.

import ArrayBufferSlice from '../../../noclip/ArrayBufferSlice.js';
import { compileVtxLoaderMultiVat, GX_Array, GX_VtxAttrFmt, GX_VtxDesc, VtxLoader } from '../../../noclip/gx/gx_displaylist.js';
import { getVertexInputLocation } from '../../../noclip/gx/gx_material.js';
import { FormatFlags, FormatTypeFlags, getFormatComponentCount, getFormatFlags, getFormatTypeFlags } from '../../../noclip/gfx/platform/GfxPlatformFormat.js';

const COMP_SIZE = [1, 1, 2, 2, 4, 4, 4, 4];
const COLOR_SIZE = [2, 3, 4, 2, 3, 4, 4, 4];
/** the attributes' numbers (GX.Attr): the matrix indexes 0..8, then position, normal, two colours, eight texture coordinates */
const POS = 9, NRM = 10, CLR0 = 11, TEX0 = 13;

/** an attribute given as an index: where in the vertex, one byte or two, which array (CP 0xA0 + array), how many indexes */
interface IndexedAttr { off: number; wide: boolean; array: number; count: number }

/** one way a vertex is laid out in the stream */
export interface Layout {
    id: number;
    /** bytes of a vertex in the stream */
    size: number;
    hasPos: boolean;
    /** the vertex carries a position matrix index; the texture matrix indexes it carries (bit per coordinate) */
    hasPnIdx: boolean; texIdx: number;
    hasNrm: boolean; hasClr: number;
    indexed: IndexedAttr[];
    loader: VtxLoader | null;
    /** the decoded vertex's size, and the vertex array object for the stream's buffer */
    stride: number;
    vao: WebGLVertexArrayObject | null;
}

/** primitives decoded and in buffers */
export interface Geometry {
    vao: WebGLVertexArrayObject;
    /** index count and where the indexes start in the index buffer (bytes) */
    count: number; offset: number;
    layout: Layout;
}

/** primitives of a display list, kept */
interface Kept extends Geometry {
    addr: number; len: number;
    /** the arrays' places and strides it was decoded under (pairs, for the indexed attributes) */
    arrays: Int32Array;
    /** the parts of RAM it was decoded from */
    ranges: Int32Array;
    vbo: WebGLBuffer; ibo: WebGLBuffer;
    vboSize: number; iboSize: number;
    /** the patch count when decoded, when last checked; the frame last drawn in */
    stamp: number; checked: number; used: number;
}

export interface RamView {
    ram: Uint8Array;
    /** how many patches changed RAM so far, and for each kilobyte the count at its last change */
    patchSeq: number;
    pageStamp: Uint32Array;
}
export const PAGE_SHIFT = 10;
export const RAM_MASK = 0x01FFFFFF;

/** true if any byte of [from, to) changed after `stamp` */
export function changedSince(v: RamView, from: number, to: number, stamp: number): boolean {
    const ps = v.pageStamp, last = Math.min((to - 1) >> PAGE_SHIFT, ps.length - 1);
    for (let p = from >> PAGE_SHIFT; p <= last; p++) if (ps[p] > stamp) return true;
    return false;
}

export class GeometryCache {
    private layouts = new Map<string, Layout>();
    private layNow: (Layout | null)[] = [null, null, null, null, null, null, null, null];
    private layKey = new Uint32Array(8 * 5);
    private kept = new Map<number, Kept[]>();
    private ramSlice: ArrayBufferSlice;
    private arrays: GX_Array[] = [];
    // the stream's own primitives
    private vbo: WebGLBuffer; private ibo: WebGLBuffer;
    private vboSize = 1 << 21; private iboSize = 1 << 19;
    private vboAt = 0; private iboAt = 0;
    private scratch = new ArrayBuffer(1 << 16);
    private scratchView = new DataView(this.scratch);
    private scratchBytes = new Uint8Array(this.scratch);
    /** statistics: primitives decoded this frame (kept ones, the stream's) and their vertices */
    decodedKept = 0; decodedStream = 0; vertices = 0;

    constructor(private gl: WebGL2RenderingContext, private view: RamView) {
        this.ramSlice = new ArrayBufferSlice(view.ram.buffer as ArrayBuffer, view.ram.byteOffset, view.ram.byteLength);
        this.vbo = gl.createBuffer()!; this.ibo = gl.createBuffer()!;
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo); gl.bufferData(gl.ARRAY_BUFFER, this.vboSize, gl.STREAM_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.iboSize, gl.STREAM_DRAW);
    }

    /** the layout of a vertex of format `fmt` under the registers as they are */
    layout(cp: Uint32Array, fmt: number): Layout {
        const lo = cp[0x50], hi = cp[0x60], a = cp[0x70 + fmt], b = cp[0x80 + fmt], c = cp[0x90 + fmt];
        const K = this.layKey, k = fmt * 5, last = this.layNow[fmt];
        if (last && K[k] === lo && K[k + 1] === hi && K[k + 2] === a && K[k + 3] === b && K[k + 4] === c) return last;
        K[k] = lo; K[k + 1] = hi; K[k + 2] = a; K[k + 3] = b; K[k + 4] = c;
        const key = `${fmt},${lo},${hi},${a},${b},${c}`;
        let L = this.layouts.get(key);
        if (!L) { L = this.makeLayout(fmt, lo, hi, a, b, c); this.layouts.set(key, L); }
        return this.layNow[fmt] = L;
    }

    private makeLayout(fmt: number, lo: number, hi: number, a: number, b: number, c: number): Layout {
        const vcd: GX_VtxDesc[] = [], vat: GX_VtxAttrFmt[] = [], indexed: IndexedAttr[] = [];
        let off = 0, texIdx = 0;
        for (let i = 0; i < 9; i++) {
            const on = (lo >>> i) & 1;
            vcd[i] = { type: on };
            vat[i] = { compType: 0, compCnt: 0, compShift: 0 };
            if (on) { off++; if (i > 0) texIdx |= 1 << (i - 1); }
        }
        const attr = (at: number, how: number, direct: number, compType: number, compCnt: number, compShift: number, indexes = 1) => {
            vcd[at] = { type: how };
            vat[at] = { compType, compCnt, compShift };
            if (how === 1) off += direct;
            else if (how) { indexed.push({ off, wide: how === 3, array: at - POS, count: indexes }); off += (how - 1) * indexes; }
        };
        const posCnt = a & 1, posFmt = (a >>> 1) & 7;
        attr(POS, (lo >>> 9) & 3, (posCnt ? 3 : 2) * COMP_SIZE[posFmt], posFmt, posCnt, (a >>> 4) & 31);
        // the normal: 3 components, or 9 with its tangents (then one index, or three when the format says so)
        const nbt = (a >>> 9) & 1, nrmFmt = (a >>> 10) & 7, three = nbt && (a >>> 31) ? 1 : 0;
        attr(NRM, (lo >>> 11) & 3, (nbt ? 9 : 3) * COMP_SIZE[nrmFmt], nrmFmt, nbt ? (three ? 2 : 1) : 0, 0, three ? 3 : 1);
        for (let i = 0; i < 2; i++) {
            const f = (a >>> (14 + 4 * i)) & 7;
            attr(CLR0 + i, (lo >>> (13 + 2 * i)) & 3, COLOR_SIZE[f], Math.min(f, 5), (a >>> (13 + 4 * i)) & 1, 0);
        }
        // the eight texture coordinates' fields: count, type, shift (register, bit)
        const tf = [[a, 21, a, 22, a, 25], [b, 0, b, 1, b, 4], [b, 9, b, 10, b, 13], [b, 18, b, 19, b, 22], [b, 27, b, 28, c, 0], [c, 5, c, 6, c, 9], [c, 14, c, 15, c, 18], [c, 23, c, 24, c, 27]];
        for (let i = 0; i < 8; i++) {
            const f = tf[i], cnt = (f[0] >>> f[1]) & 1, type = (f[2] >>> f[3]) & 7;
            attr(TEX0 + i, (hi >>> (2 * i)) & 3, (cnt ? 2 : 1) * COMP_SIZE[type], type, cnt, (f[4] >>> f[5]) & 31);
        }
        const L: Layout = { id: this.layouts.size + 1, size: off, hasPos: !!vcd[POS].type, hasPnIdx: !!(lo & 1), texIdx, hasNrm: !!vcd[NRM].type, hasClr: (vcd[CLR0].type ? 1 : 0) | (vcd[CLR0 + 1].type ? 2 : 0), indexed, loader: null, stride: 0, vao: null };
        if (!L.hasPos) return L;
        try {
            const vats: GX_VtxAttrFmt[][] = []; vats[fmt] = vat;
            L.loader = compileVtxLoaderMultiVat(vats, vcd);
            L.stride = L.loader.loadedVertexLayout.vertexBufferStrides[0];
        } catch (e) { console.warn('[gx] a vertex layout that cannot be decoded', key(lo, hi, a, b, c), e); L.loader = null; }
        return L;
    }

    /** a vertex array object for `layout`'s decoded vertices in `vbo`, with `ibo` as its indexes */
    private makeVao(layout: Layout, vbo: WebGLBuffer, ibo: WebGLBuffer): WebGLVertexArrayObject {
        const gl = this.gl, vao = gl.createVertexArray()!;
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        for (const at of layout.loader!.loadedVertexLayout.singleVertexInputLayouts) {
            const loc = getVertexInputLocation(at.attrInput), type = getFormatTypeFlags(at.format);
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, getFormatComponentCount(at.format), type === FormatTypeFlags.F32 ? gl.FLOAT : gl.UNSIGNED_BYTE, !!(getFormatFlags(at.format) & FormatFlags.Normalized), layout.stride, at.bufferOffset);
        }
        return vao;
    }

    /** the arrays the loader may index, as the registers place them */
    private setArrays(cp: Uint32Array, layout: Layout) {
        const A = this.arrays;
        for (const ia of layout.indexed) A[POS + ia.array] = { buffer: this.ramSlice, offs: cp[0xA0 + ia.array] & RAM_MASK, stride: cp[0xB0 + ia.array] & 0xFF };
    }

    /** bytes of the triangle primitives (quads, triangles, strips, fans) that follow each other at b[p] with one vertex format (up to `end`); 0 if the first isn't all there */
    static run(b: Uint8Array, p: number, end: number, size: number): number {
        const fmt = b[p] & 7;
        let q = p;
        while (q + 3 <= end && b[q] >= 0x80 && b[q] < 0xA8 && (b[q] & 7) === fmt) {
            const n = 3 + ((b[q + 1] << 8) | b[q + 2]) * size;
            if (q + n > end) break;
            q += n;
        }
        return q - p;
    }

    /** Primitives at b[p .. p + len) of the stream itself: decoded into the frame's buffer. */
    stream(cp: Uint32Array, layout: Layout, b: Uint8Array, p: number, len: number): Geometry | null {
        if (!layout.loader) return null;
        const gl = this.gl, loader = layout.loader;
        this.setArrays(cp, layout);
        // (the buffer's next vertex, counted in this layout's vertices: indexes are 16 bits)
        let first = Math.ceil(this.vboAt / layout.stride);
        let data;
        try { data = loader.parseDisplayList(new ArrayBufferSlice(b.buffer as ArrayBuffer, b.byteOffset + p, len), { firstVertexId: first }); } catch { return null; }
        if (!data.totalIndexCount) return null;
        const bytes = data.totalVertexCount * layout.stride, ibytes = data.totalIndexCount * 2;
        if (first + data.totalVertexCount > 0xFFFF || first * layout.stride + bytes > this.vboSize || this.iboAt + ibytes > this.iboSize) {
            // (full: start the buffers again; what was drawn from them is drawn)
            while (bytes > this.vboSize) this.vboSize *= 2;
            while (ibytes > this.iboSize) this.iboSize *= 2;
            gl.bindVertexArray(null);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo); gl.bufferData(gl.ARRAY_BUFFER, this.vboSize, gl.STREAM_DRAW);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.iboSize, gl.STREAM_DRAW);
            this.vboAt = this.iboAt = 0; first = 0;
            data = loader.parseDisplayList(new ArrayBufferSlice(b.buffer as ArrayBuffer, b.byteOffset + p, len), { firstVertexId: 0 });
        }
        this.fill(layout, data, bytes);
        if (!layout.vao) layout.vao = this.makeVao(layout, this.vbo, this.ibo);
        gl.bindVertexArray(layout.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, first * layout.stride, this.scratchBytes, 0, bytes);
        gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, this.iboAt, new Uint8Array(data.indexData as ArrayBuffer), 0, ibytes);
        const g = this.streamGeom;
        g.vao = layout.vao; g.count = data.totalIndexCount; g.offset = this.iboAt; g.layout = layout;
        this.vboAt = first * layout.stride + bytes; this.iboAt += ibytes;
        this.decodedStream++; this.vertices += data.totalVertexCount;
        return g;
    }
    private streamGeom: Geometry = { vao: null!, count: 0, offset: 0, layout: null! };

    /** the vertices of parsed primitives into the scratch buffer */
    private fill(layout: Layout, data: ReturnType<VtxLoader['parseDisplayList']>, bytes: number) {
        if (bytes > this.scratch.byteLength) { this.scratch = new ArrayBuffer(Math.max(bytes, this.scratch.byteLength * 2)); this.scratchView = new DataView(this.scratch); this.scratchBytes = new Uint8Array(this.scratch); }
        // (the loader leaves what a layout doesn't carry as it finds it: a missing matrix index must read 0)
        this.scratchBytes.fill(0, 0, bytes);
        layout.loader!.loadVertexDataInto(this.scratchView, 0, data, this.arrays);
    }

    /** Primitives at RAM[addr .. addr + len), in a display list: decoded once, again when the game wrote what they were decoded from. */
    list(cp: Uint32Array, layout: Layout, addr: number, len: number, frame: number): Geometry | null {
        if (!layout.loader) return null;
        const v = this.view;
        let list = this.kept.get(addr);
        if (!list) this.kept.set(addr, list = []);
        let k: Kept | undefined;
        find: for (const c of list) {
            if (c.layout !== layout || c.len !== len) continue;
            const A = c.arrays;
            for (let i = 0; i < layout.indexed.length; i++) { const ar = layout.indexed[i].array; if (A[i * 2] !== (cp[0xA0 + ar] & RAM_MASK) || A[i * 2 + 1] !== (cp[0xB0 + ar] & 0xFF)) continue find; }
            k = c; break;
        }
        if (k) {
            k.used = frame;
            if (k.checked === v.patchSeq) return k.count ? k : null;
            k.checked = v.patchSeq;
            const R = k.ranges;
            let stale = false;
            for (let i = 0; i < R.length && !stale; i += 2) stale = changedSince(v, R[i], R[i + 1], k.stamp);
            if (!stale) return k.count ? k : null;
        }
        return this.decodeKept(cp, layout, addr, len, frame, k, list);
    }

    private decodeKept(cp: Uint32Array, layout: Layout, addr: number, len: number, frame: number, k: Kept | undefined, list: Kept[]): Geometry | null {
        const gl = this.gl, v = this.view, ram = v.ram, loader = layout.loader!;
        this.setArrays(cp, layout);
        let data;
        try { data = loader.parseDisplayList(new ArrayBufferSlice(ram.buffer as ArrayBuffer, ram.byteOffset + addr, len)); } catch { data = null; }
        const n = layout.indexed.length;
        if (!k) {
            k = { vao: null!, count: 0, offset: 0, layout, addr, len, arrays: new Int32Array(n * 2), ranges: new Int32Array(2 + n * 2), vbo: gl.createBuffer()!, ibo: gl.createBuffer()!, vboSize: 0, iboSize: 0, stamp: 0, checked: 0, used: frame };
            for (let i = 0; i < n; i++) { const ar = layout.indexed[i].array; k.arrays[i * 2] = cp[0xA0 + ar] & RAM_MASK; k.arrays[i * 2 + 1] = cp[0xB0 + ar] & 0xFF; }
            k.vao = this.makeVao(layout, k.vbo, k.ibo);
            list.push(k);
        }
        k.stamp = k.checked = v.patchSeq; k.used = frame;
        k.ranges[0] = addr; k.ranges[1] = addr + len;
        if (!data || !data.totalIndexCount) { k.count = 0; for (let i = 0; i < n; i++) k.ranges[2 + i * 2] = k.ranges[3 + i * 2] = 0; return null; }
        // the parts of the arrays the indexes reach
        for (let i = 0; i < n; i++) {
            const ia = layout.indexed[i];
            let lo = 0xFFFF, hi = 0;
            for (let q = addr; q < addr + len;) {
                const count = (ram[q + 1] << 8) | ram[q + 2];
                q += 3;
                for (let j = 0; j < count; j++, q += layout.size) for (let t = 0; t < ia.count; t++) {
                    const o = q + ia.off + t * (ia.wide ? 2 : 1), ix = ia.wide ? (ram[o] << 8) | ram[o + 1] : ram[o];
                    if (ix < lo) lo = ix;
                    if (ix > hi) hi = ix;
                }
            }
            const base = k.arrays[i * 2], stride = k.arrays[i * 2 + 1];
            k.ranges[2 + i * 2] = base + lo * stride; k.ranges[3 + i * 2] = base + (hi + 1) * stride + 36;
        }
        const bytes = data.totalVertexCount * layout.stride, ibytes = data.totalIndexCount * 2;
        this.fill(layout, data, bytes);
        gl.bindVertexArray(k.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, k.vbo);
        if (bytes > k.vboSize) { gl.bufferData(gl.ARRAY_BUFFER, this.scratchBytes.subarray(0, bytes), gl.DYNAMIC_DRAW); k.vboSize = bytes; }
        else gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.scratchBytes, 0, bytes);
        if (ibytes > k.iboSize) { gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint8Array(data.indexData as ArrayBuffer), gl.DYNAMIC_DRAW); k.iboSize = ibytes; }
        else gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, new Uint8Array(data.indexData as ArrayBuffer), 0, ibytes);
        k.count = data.totalIndexCount;
        this.decodedKept++; this.vertices += data.totalVertexCount;
        return k;
    }

    /** A new frame: the stream's buffer from its start; now and then, kept primitives not drawn for a long time are let go. */
    newFrame(frame: number) {
        this.vboAt = this.iboAt = 0;
        this.decodedKept = this.decodedStream = this.vertices = 0;
        if (frame % 512 !== 511) return;
        const gl = this.gl;
        for (const [addr, list] of this.kept) {
            for (let i = list.length - 1; i >= 0; i--) if (frame - list[i].used > 1200) { const k = list[i]; gl.deleteVertexArray(k.vao); gl.deleteBuffer(k.vbo); gl.deleteBuffer(k.ibo); list.splice(i, 1); }
            if (!list.length) this.kept.delete(addr);
        }
    }

    /** everything kept is let go (the buffers stay) */
    clear() {
        const gl = this.gl;
        for (const list of this.kept.values()) for (const k of list) { gl.deleteVertexArray(k.vao); gl.deleteBuffer(k.vbo); gl.deleteBuffer(k.ibo); }
        this.kept.clear();
        this.vboAt = this.iboAt = 0;
    }
    destroy() {
        const gl = this.gl;
        this.clear();
        for (const L of this.layouts.values()) if (L.vao) gl.deleteVertexArray(L.vao);
        gl.deleteBuffer(this.vbo); gl.deleteBuffer(this.ibo);
    }
}

const key = (...v: number[]) => v.map((x) => x.toString(16)).join(' ');
