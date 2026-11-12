// v3, the page's GPU: draws what the game sent its GPU.
//
// The worker hands over, per video frame, the bytes the game wrote to the GPU's command stream and the parts of
// the game's RAM those commands read (web/gxframe.ts). This runs them, as the GPU does: it keeps a copy of RAM and
// of the GPU's registers (CP: vertex formats and arrays; XF: matrices, lights, projection, viewport, texture
// coordinate generators; BP: the texture environment, textures, blending, depth, the frame buffer copies), walks
// the stream once, and draws every primitive in WebGL2 with the state of its moment, in the stream's order:
//   geometry.ts   a primitive's vertices to buffers (noclip's vertex loader), kept for display lists
//   material.ts   the registers to a shader (noclip's GX shader generator) and its uniform blocks
//   textures.ts   texture units to GL textures (noclip's decoders), palettes
//   efb.ts        the frame buffer, its copies to textures and to the canvas, its clears
// So the stage, Mario, objects, particles and the HUD all come out of the one mechanism: the game's own drawing.

import type { GxFrame, GxPatch } from '../../web/gxframe.js';
import { Efb, EFB_H, EFB_W } from './efb.js';
import { Geometry, GeometryCache, Layout, PAGE_SHIFT, RamView, RAM_MASK } from './geometry.js';
import { FIXED, Mat, Materials, OFF_AMB, OFF_BIAS, OFF_IND, OFF_KONST, OFF_MAT, OFF_REG, OFF_SIZES, OFF_TEXMTX } from './material.js';
import { Tex, TextureCache } from './textures.js';

const RAM_SIZE = 0x01800000;
/** RAM is also followed in cells of 32 bytes (a texture's alignment): which were ever given, and when one given before was last changed */
const CELL_SHIFT = 5;

/** a block of uniforms, written anew for each draw that changes it: the buffer is filled from its start each frame */
class UniformStream {
    private buf: WebGLBuffer;
    private at = 0;
    constructor(private gl: WebGL2RenderingContext, private index: number, private size: number, private align: number) {
        this.buf = gl.createBuffer()!;
        this.restart();
    }
    restart() { const gl = this.gl; gl.bindBuffer(gl.UNIFORM_BUFFER, this.buf); gl.bufferData(gl.UNIFORM_BUFFER, this.size, gl.STREAM_DRAW); this.at = 0; }
    push(data: Float32Array, floats: number) {
        const gl = this.gl, bytes = floats * 4;
        if (this.at + bytes > this.size) this.restart(); else gl.bindBuffer(gl.UNIFORM_BUFFER, this.buf);
        gl.bufferSubData(gl.UNIFORM_BUFFER, this.at, data, 0, floats);
        gl.bindBufferRange(gl.UNIFORM_BUFFER, this.index, this.buf, this.at, bytes);
        this.at = Math.ceil((this.at + bytes) / this.align) * this.align;
    }
    destroy() { this.gl.deleteBuffer(this.buf); }
}

/** one frame buffer copy to a texture, as the game asked for it (for tests and reports) */
export interface CopyNote { x: number; y: number; w: number; h: number; format: number; intensity: boolean; depth: boolean; half: boolean; clear: boolean; dst: number; kept: boolean }
export interface GxStats {
    frame: number;
    /** draw calls; of them, primitives of display lists found already decoded */
    draws: number; keptHits: number;
    decodedKept: number; decodedStream: number; vertices: number;
    programs: number; textures: number;
    /** primitives not drawn: lines and points; with a layout or material that could not be made */
    lines: number; failed: number;
    copies: CopyNote[];
    patches: number; patchBytes: number;
    ms: number;
}

export class GxRenderer {
    private gl: WebGL2RenderingContext;
    private ram = new Uint8Array(RAM_SIZE);
    private cp = new Uint32Array(256);
    private bp = new Uint32Array(256);
    private xfw = new Uint32Array(0x1100);
    private xf = new Float32Array(this.xfw.buffer);
    private bpMask = 0xFFFFFF;
    /** the texture environment's colour registers (PREV, C0, C1, C2) and constant colours: r g b a, signed 11 bits */
    private tevReg = new Int32Array(16); private konst = new Int32Array(16);
    private view: RamView = { ram: this.ram, patchSeq: 0, pageStamp: new Uint32Array(RAM_SIZE >> PAGE_SHIFT) };
    private known = new Uint8Array(RAM_SIZE >> CELL_SHIFT);
    private rewriteStamp = new Uint32Array(RAM_SIZE >> CELL_SHIFT);

    private efb: Efb;
    private geom: GeometryCache;
    private mats: Materials;
    private tex: TextureCache;
    private uScene: UniformStream; private uMat: UniformStream; private uDraw: UniformStream;
    private sceneData = new Float32Array(20);
    private matData = new Float32Array(FIXED + 240 + 160 + 20 + 4);
    private drawData = new Float32Array(120);

    // what has to be set again before the next draw
    private glDirty = true;        // everything GL holds (after a copy, a clear, a new frame)
    private bpDirty = true;        // a BP register changed: the material, the pixel state, the material's block
    private xfDirty = true;        // an XF register changed (0x1000 and up): the same, and the projection
    private mtxDirty = true;       // matrix memory changed: positions (the draw block)
    private paramDirty = true;     // texture matrices, lights and so on (the material block)
    private curMat: Mat | null = null; private curLayout: Layout | null = null; private curDstAlpha = -2;
    private curProgram: WebGLProgram | null = null;
    private blockMat: Mat | null = null;
    private blockPnIdx = -2;
    private unitKey = new Float64Array(8 * 7); private unitTex: (Tex | null)[] = [null, null, null, null, null, null, null, null];
    private boundTex: (WebGLTexture | null)[] = []; private boundSampler: (WebGLSampler | null)[] = [];
    private cullAll = false;

    private frameNo = 0;
    private ended = false;
    stats: GxStats = { frame: 0, draws: 0, keptHits: 0, decodedKept: 0, decodedStream: 0, vertices: 0, programs: 0, textures: 0, lines: 0, failed: 0, copies: [], patches: 0, patchBytes: 0, ms: 0 };
    private warned = new Set<string>();

    /** scale: pixels a side for each of the game's (1: the console's 640 x 528 frame buffer) */
    constructor(private canvas: HTMLCanvasElement, scale = 1) {
        const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
        if (!gl) throw new Error('WebGL2 is not available');
        this.gl = gl;
        this.efb = new Efb(gl, Math.max(1, Math.floor(scale)));
        this.geom = new GeometryCache(gl, this.view);
        this.mats = new Materials(gl);
        this.tex = new TextureCache(gl, this.view, (from, to, stamp) => this.rewritten(from, to, stamp));
        const align = gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT) as number;
        this.uScene = new UniformStream(gl, 0, 1 << 16, align);
        this.uMat = new UniformStream(gl, 1, 1 << 22, align);
        this.uDraw = new UniformStream(gl, 2, 1 << 21, align);
        // (a vertex without a colour is white)
        gl.vertexAttrib4f(6, 1, 1, 1, 1); gl.vertexAttrib4f(7, 1, 1, 1, 1);
        this.unitKey.fill(-1);
        if (!canvas.width || canvas.width === 300) { canvas.width = EFB_W * this.efb.scale; canvas.height = 448 * this.efb.scale; }
    }

    private warn(what: string) { if (!this.warned.has(what)) { this.warned.add(what); console.warn('[gx] ' + what); } }

    /** Runs one frame's commands and presents the result on the canvas. */
    frame(f: GxFrame): void {
        const t0 = performance.now(), gl = this.gl, S = this.stats;
        this.frameNo++;
        S.frame = f.frame; S.patches = f.patches.length;
        this.geom.newFrame(this.frameNo);
        if (this.frameNo % 512 === 511) { this.tex.sweep(this.frameNo); this.unitKey.fill(-1); }
        const programs0 = this.mats.compiled, tex0 = this.tex.decodes;
        // A frame that starts from the registers alone (the first one, or the one after a gap) draws with textures
        // the game copied out of the frame buffer in the frame before, which was never seen here. Its commands are
        // run twice: the first run makes this frame's copies, which stand in for the missing ones in the second.
        for (let pass = f.regs ? 0 : 1; pass < 2; pass++) {
            if (f.regs) this.loadRegs(f.regs);
            this.walk(f);
        }
        gl.bindVertexArray(null);
        gl.flush();
        S.decodedKept = this.geom.decodedKept; S.decodedStream = this.geom.decodedStream; S.vertices = this.geom.vertices;
        S.programs = this.mats.compiled - programs0; S.textures = this.tex.decodes - tex0;
        S.ms = performance.now() - t0;
    }

    /** the stream once through, with each patch put into RAM as the command at its offset comes up */
    private walk(f: GxFrame) {
        const S = this.stats, b = f.fifo, P = f.patches;
        S.draws = S.keptHits = S.lines = S.failed = 0; S.copies = []; S.patchBytes = 0;
        this.uScene.restart(); this.uMat.restart(); this.uDraw.restart();
        this.glDirty = this.sceneFresh = true; this.ended = false;
        this.blockMat = null; this.blockPnIdx = -2;
        let pi = 0, p = 0;
        while (p < b.length) {
            let stop = b.length;
            if (pi < P.length) {
                if (P[pi].at <= p) { this.patch(P[pi++]); continue; }
                stop = Math.min(stop, P[pi].at);
            }
            const q = this.run(b, p, stop, b.length, false);
            if (q <= p) { if (q >= 0) this.warn('the stream stops inside a command'); break; }
            p = q;
        }
        while (pi < P.length) this.patch(P[pi++]);
    }

    /** Forgets everything (a new replay started). */
    reset(): void {
        this.ram.fill(0); this.cp.fill(0); this.bp.fill(0); this.xfw.fill(0);
        this.tevReg.fill(0); this.konst.fill(0); this.bpMask = 0xFFFFFF;
        this.view.patchSeq = 0; this.view.pageStamp.fill(0); this.known.fill(0); this.rewriteStamp.fill(0);
        this.geom.clear(); this.tex.clearAll();
        this.unitKey.fill(-1);
        this.efb.clear(0, 0, EFB_W, EFB_H, [0, 0, 0, 255], true, true, 0xFFFFFF);
        this.glDirty = this.bpDirty = this.xfDirty = this.mtxDirty = this.paramDirty = true;
        this.curMat = null; this.blockMat = null;
    }

    destroy(): void {
        this.geom.destroy(); this.tex.destroy(); this.mats.destroy(); this.efb.destroy();
        this.uScene.destroy(); this.uMat.destroy(); this.uDraw.destroy();
    }

    /** (for tests) the frame buffer copies there are: where their images are in RAM, and one's pixels (RGBA, top row first) */
    copyAddresses(): number[] { return [...this.tex.copies.keys()].map((a) => a + 0x80000000); }
    readCopy(addr: number): { w: number; h: number; data: Uint8Array } | null {
        const c = this.tex.copies.get(addr & RAM_MASK), gl = this.gl;
        if (!c) return null;
        const w = c.w * this.efb.scale, h = c.h * this.efb.scale, data = new Uint8Array(w * h * 4), fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, c.tex, 0);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb);
        this.glDirty = true;
        return { w, h, data };
    }

    private loadRegs(r: { cp: Uint32Array; bp: Uint32Array; xf: Uint32Array }) {
        this.cp.set(r.cp.subarray(0, 256)); this.bp.set(r.bp.subarray(0, 256)); this.xfw.set(r.xf.subarray(0, 0x1100));
        for (let i = 0; i < 256; i++) this.bp[i] &= 0xFFFFFF;
        // (the colour registers share their numbers with the constant colours: both follow the 256, colours first)
        if (r.bp.length >= 272) for (let i = 0; i < 8; i++) { this.tevColor(0xE0 + i, r.bp[256 + i] & 0x7FFFFF); this.tevColor(0xE0 + i, (r.bp[264 + i] & 0x7FFFFF) | 0x800000); }
        else for (let reg = 0xE0; reg < 0xE8; reg++) this.tevColor(reg, this.bp[reg]);
        this.bpMask = 0xFFFFFF;
        this.bpDirty = this.xfDirty = this.mtxDirty = this.paramDirty = true;
    }

    // ---------------------------------------------------------------- RAM
    private patch(p: GxPatch) {
        const ram = this.ram, d = p.data, at = p.addr & RAM_MASK, n = Math.min(d.length, ram.length - at);
        if (n <= 0) return;
        this.stats.patchBytes += n;
        const v = this.view, seq = v.patchSeq + 1, known = this.known, rw = this.rewriteStamp, ps = v.pageStamp;
        let any = false;
        for (let c = at >> CELL_SHIFT, last = (at + n - 1) >> CELL_SHIFT; c <= last; c++) {
            const from = Math.max(at, c << CELL_SHIFT), to = Math.min(at + n, (c + 1) << CELL_SHIFT);
            let diff = false;
            for (let i = from; i < to; i++) if (ram[i] !== d[i - at]) { diff = true; break; }
            if (diff) { any = true; if (known[c]) rw[c] = seq; ps[c >> (PAGE_SHIFT - CELL_SHIFT)] = seq; }
            known[c] = 1;
        }
        if (!any) return;
        ram.set(n === d.length ? d : d.subarray(0, n), at);
        v.patchSeq = seq;
    }
    /** true if the game wrote [from, to) again (bytes the page had already been given) after `stamp` */
    private rewritten(from: number, to: number, stamp: number): boolean {
        const rw = this.rewriteStamp, last = Math.min((to - 1) >> CELL_SHIFT, rw.length - 1);
        for (let c = from >> CELL_SHIFT; c <= last; c++) if (rw[c] > stamp) return true;
        return false;
    }

    // ---------------------------------------------------------------- the stream
    /**
     * Runs the commands in b[p .. stop) (a command that starts before `stop` may run on up to `end`); returns where
     * it stopped: `stop` or beyond, p itself when the command there isn't all in the buffer, -1 when the frame ended.
     */
    private run(b: Uint8Array, p: number, stop: number, end: number, inList: boolean): number {
        const cp = this.cp, ram = this.ram;
        while (p < stop) {
            const cmd = b[p];
            if (cmd === 0) { p++; continue; }
            if (cmd & 0x80) {
                if (p + 3 > end) return inList ? end : p;
                const L = this.geom.layout(cp, cmd & 7);
                if (cmd >= 0xA8 || !L.loader) {
                    // lines and points, or a layout without a position: passed over
                    const total = 3 + ((b[p + 1] << 8) | b[p + 2]) * L.size;
                    if (p + total > end) return inList ? end : p;
                    if (cmd >= 0xA8) this.stats.lines++; else this.stats.failed++;
                    p += total; continue;
                }
                // (primitives that follow each other are drawn as one, up to where the next patch comes in)
                const len = GeometryCache.run(b, p, inList ? end : stop, L.size) || GeometryCache.run(b, p, end, L.size);
                if (!len) return inList ? end : p;
                if (!this.ended) {
                    const dec = this.geom.decodedKept;
                    const g = inList ? this.geom.list(cp, L, p, len, this.frameNo) : this.geom.stream(cp, L, b, p, len);
                    if (inList && dec === this.geom.decodedKept) this.stats.keptHits++;
                    if (g) this.draw(g);
                }
                p += len; continue;
            }
            switch (cmd) {
                case 0x08: {
                    if (p + 6 > end) return inList ? end : p;
                    this.cp[b[p + 1]] = r32(b, p + 2);
                    p += 6; continue;
                }
                case 0x10: {
                    if (p + 5 > end) return inList ? end : p;
                    const n = (b[p + 2] & 0xF) + 1, addr = (b[p + 3] << 8) | b[p + 4];
                    if (p + 5 + 4 * n > end) return inList ? end : p;
                    for (let i = 0; i < n; i++) this.xfLoad(addr + i, r32(b, p + 5 + 4 * i));
                    p += 5 + 4 * n; continue;
                }
                case 0x20: case 0x28: case 0x30: case 0x38: {   // matrices and lights loaded from an array in RAM by index
                    if (p + 5 > end) return inList ? end : p;
                    const index = (b[p + 1] << 8) | b[p + 2], v = (b[p + 3] << 8) | b[p + 4], n = (v >>> 12) + 1, addr = v & 0xFFF, arr = 12 + ((cmd - 0x20) >> 3);
                    const src = ((cp[0xA0 + arr] & RAM_MASK) + index * (cp[0xB0 + arr] & 0xFF)) & RAM_MASK;
                    if (src + 4 * n <= ram.length) for (let i = 0; i < n; i++) this.xfLoad(addr + i, r32(ram, src + 4 * i));
                    p += 5; continue;
                }
                case 0x40: {
                    if (p + 9 > end) return inList ? end : p;
                    const addr = r32(b, p + 1) & RAM_MASK, size = r32(b, p + 5);
                    if (inList) this.warn('a display list calls another');
                    else if (addr + size <= ram.length) { if (this.run(ram, addr, addr + size, addr + size, true) < 0) return -1; }
                    p += 9; continue;
                }
                case 0x44: case 0x48: p++; continue;
                case 0x61: {
                    if (p + 5 > end) return inList ? end : p;
                    this.bpLoad(r32(b, p + 1));
                    p += 5; continue;
                }
            }
            this.warn(`an unknown command 0x${cmd.toString(16)}${inList ? ' in a display list' : ''}`);
            return inList ? end : -1;
        }
        return p;
    }

    private xfLoad(addr: number, v: number) {
        if (addr >= 0x1100 || this.xfw[addr] === v) return;
        this.xfw[addr] = v;
        if (addr >= 0x1000) this.xfDirty = true;
        else if (addr < 120) this.mtxDirty = true;
        else this.paramDirty = true;
    }

    private tevColor(reg: number, v: number) {
        // a register pair (red and alpha, then blue and green), signed 11 bits each; bit 23: the constant colours
        const i = (reg - 0xE0) >> 1, lo = (v << 21) >> 21, hi = (v << 9) >> 21, k = v & 0x800000 ? this.konst : this.tevReg;
        if (reg & 1) { k[i * 4 + 2] = lo; k[i * 4 + 1] = hi; } else { k[i * 4] = lo; k[i * 4 + 3] = hi; }
    }

    private bpLoad(word: number) {
        const bp = this.bp, reg = word >>> 24, v = ((bp[reg] & ~this.bpMask) | (word & this.bpMask)) & 0xFFFFFF;
        if (reg === 0xFE) { this.bpMask = word & 0xFFFFFF; return; }
        this.bpMask = 0xFFFFFF;
        if (reg >= 0xE0 && reg < 0xE8) { bp[reg] = v; this.tevColor(reg, v); this.paramDirty = true; return; }
        switch (reg) {
            case 0x52: bp[reg] = v; this.copy(v); return;
            case 0x65: bp[reg] = v; this.tex.loadTlut(bp[0x64], v); return;
        }
        if (bp[reg] === v) return;
        bp[reg] = v;
        this.bpDirty = true;
    }

    // ---------------------------------------------------------------- the copy out of the frame buffer
    private copy(ctl: number) {
        const bp = this.bp, efb = this.efb;
        const x = bp[0x49] & 0x3FF, y = (bp[0x49] >>> 10) & 0x3FF, w = (bp[0x4A] & 0x3FF) + 1, h = ((bp[0x4A] >>> 10) & 0x3FF) + 1;
        const pixelFormat = bp[0x43] & 7, hasAlpha = pixelFormat === 1;
        if (this.ended) return;
        if (ctl & 0x4000) {
            // to the display: the frame is done
            efb.present(this.canvas, x, y, Math.min(w, EFB_W - x), Math.min(h, EFB_H - y));
            this.ended = true;
        } else {
            const f = (ctl >>> 3) & 15, format = (f >> 1) + (f & 1) * 8, dst = (bp[0x4B] << 5) & RAM_MASK, half = !!(ctl & 0x200), intensity = !!(ctl & 0x8000), depth = pixelFormat === 3;
            const keep = !this.tex.ramWins.has(dst);
            if (keep) {
                const old = this.tex.copies.get(dst), t = old ? old.tex : this.gl.createTexture()!;
                const size = efb.copyTo(t, x, y, w, h, half, format, intensity, depth);
                this.tex.setCopy(dst, { tex: t, w: size.w, h: size.h, bytes: Efb.copyBytes(format, size.w, size.h), stamp: this.view.patchSeq, frame: this.frameNo });
            }
            this.stats.copies.push({ x, y, w, h, format, intensity, depth, half, clear: !!(ctl & 0x800), dst: dst + 0x80000000, kept: keep });
        }
        if (ctl & 0x800) {
            // the clear: colour 0x4F (alpha, red) and 0x50 (green, blue), depth 0x51, each where its update is on
            // (A frame buffer of 8 bits a colour and no alpha is the same memory as one of 6 bits each with alpha:
            // what is cleared in the first reads, in the second, with the blue's low 6 bits as its alpha.)
            const bm = bp[0x41], blue = bp[0x50] & 0xFF, a6 = blue & 63;
            const alpha = hasAlpha ? (bp[0x4F] >>> 8) & 0xFF : (a6 << 2) | (a6 >> 4);
            efb.clear(x, y, w, h, [bp[0x4F] & 0xFF, (bp[0x50] >>> 8) & 0xFF, blue, alpha], !!(bm & 8), hasAlpha ? !!(bm & 0x10) : pixelFormat === 0 && !!(bm & 8), bp[0x40] & 0x10 ? bp[0x51] & 0xFFFFFF : null);
        }
        this.glDirty = true;
    }

    // ---------------------------------------------------------------- a draw
    private draw(g: Geometry) {
        const gl = this.gl, bp = this.bp, xfw = this.xfw, L = g.layout;
        if (this.glDirty) this.resetGl();
        const dirty = this.bpDirty || this.xfDirty;
        if (dirty) this.pixelState();
        if (this.cullAll) return;
        // the constant alpha (0x42) replaces the pixel's alpha in the frame buffer only: with blending on, the
        // colour is drawn with the pixel's own alpha first, then the constant alpha alone
        const bm = bp[0x41], hasAlpha = (bp[0x43] & 7) === 1;
        const dstAlpha = (bp[0x42] & 0x100) && (bm & 0x10) && hasAlpha ? bp[0x42] & 0xFF : -1;
        const blending = (bm & 0x801) !== 0;
        const twoPass = dstAlpha >= 0 && blending && (bm & 8) !== 0;
        const want = twoPass ? -1 : dstAlpha;
        let m = this.curMat;
        if (dirty || !m || L !== this.curLayout || want !== this.curDstAlpha) {
            m = this.curMat = this.mats.get(bp, xfw, L, want);
            this.curLayout = L; this.curDstAlpha = want;
        }
        if (!m.program) { this.stats.failed++; this.bpDirty = this.xfDirty = false; return; }
        this.useMat(m, L, dirty);
        this.bpDirty = this.xfDirty = false;
        gl.bindVertexArray(g.vao);
        if (twoPass) gl.colorMask(true, true, true, false);
        gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_SHORT, g.offset);
        this.stats.draws++;
        if (twoPass) {
            const m2 = this.mats.get(bp, xfw, L, dstAlpha);
            if (m2.program) {
                this.useMat(m2, L, false);
                gl.colorMask(false, false, false, true);
                gl.disable(gl.BLEND); gl.depthMask(false);
                const zm = bp[0x40], func = (zm >>> 1) & 7;
                // (the first pass wrote its depth: a strict comparison must now let its own pixels through)
                if ((zm & 1) && func === 1) gl.depthFunc(gl.GEQUAL); else if ((zm & 1) && func === 4) gl.depthFunc(gl.LEQUAL);
                gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_SHORT, g.offset);
            }
            this.curMat = null;
            this.pixelState();
        }
    }

    /** after something else used GL: the frame buffer and everything cached about GL's state */
    private resetGl() {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.efb.fbo);
        gl.enable(gl.SCISSOR_TEST);
        this.curProgram = null;
        for (let i = 0; i < 8; i++) { this.boundTex[i] = null; this.boundSampler[i] = null; }
        this.glDirty = false;
        this.bpDirty = true;
    }

    /** viewport, scissor, culling, depth, blending and which channels are written, from the registers */
    private pixelState() {
        const gl = this.gl, bp = this.bp, xf = this.xf, s = this.efb.scale;
        // the viewport (0x101A: half width, half height (negative: y runs down), depth range, middle x, y (+ 342), far depth)
        const wd = xf[0x101A], ht = xf[0x101B], aht = Math.abs(ht);
        gl.viewport(Math.round((xf[0x101D] - 342 - wd) * s), Math.round((xf[0x101E] - 342 - aht) * s), Math.max(0, Math.round(2 * wd * s)), Math.max(0, Math.round(2 * aht * s)));
        const far = xf[0x101F] / 16777215, range = xf[0x101C] / 16777215;
        gl.depthRange(clamp01(1 - far), clamp01(1 - far + range));
        // the scissor (0x20: top and left + 342; 0x21: bottom and right + 341; 0x59: the offset, halved)
        const xoff = (bp[0x59] & 0x3FF) * 2 - 342, yoff = ((bp[0x59] >>> 10) & 0x3FF) * 2 - 342;
        const sl = Math.max(0, ((bp[0x20] >>> 12) & 0x7FF) - xoff - 342), st = Math.max(0, (bp[0x20] & 0x7FF) - yoff - 342);
        const sr = Math.min(EFB_W, ((bp[0x21] >>> 12) & 0x7FF) - xoff - 341), sb = Math.min(EFB_H, (bp[0x21] & 0x7FF) - yoff - 341);
        gl.scissor(sl * s, st * s, Math.max(0, sr - sl) * s, Math.max(0, sb - st) * s);
        // culling (0x00, bits 14 and 15: 1 the back, 2 the front); the front is clockwise on the screen
        const cull = (bp[0] >>> 14) & 3;
        this.cullAll = cull === 3;
        gl.frontFace(ht < 0 ? gl.CCW : gl.CW);
        if (cull === 0) gl.disable(gl.CULL_FACE); else { gl.enable(gl.CULL_FACE); gl.cullFace(cull === 1 ? gl.BACK : gl.FRONT); }
        // depth (0x40), kept reversed here
        const zm = bp[0x40];
        if (zm & 1) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(DEPTH_FUNC[(zm >>> 1) & 7]); gl.depthMask(!!(zm & 0x10)); } else gl.disable(gl.DEPTH_TEST);
        // blending (0x41): subtract, blend, or a logic operation (the two that are blends too)
        const bm = bp[0x41], hasAlpha = (bp[0x43] & 7) === 1;
        if (bm & 0x800) { gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT); gl.blendFunc(gl.ONE, gl.ONE); }
        else if (bm & 1) {
            let sf = (bm >>> 8) & 7, df = (bm >>> 5) & 7;
            // (a frame buffer without alpha reads as full alpha)
            if (!hasAlpha) { if (sf === 6) sf = 1; else if (sf === 7) sf = 0; if (df === 6) df = 1; else if (df === 7) df = 0; }
            gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(SRC_FACTOR[sf], DST_FACTOR[df]);
        } else if (bm & 2) {
            const lop = (bm >>> 12) & 15;
            if (lop === 0) { gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ZERO, gl.ZERO); }
            else if (lop === 5) { gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ZERO, gl.ONE); }
            else { gl.disable(gl.BLEND); if (lop !== 3) this.warn(`logic operation ${lop} (drawn as a plain write)`); }
        } else gl.disable(gl.BLEND);
        const c = !!(bm & 8);
        gl.colorMask(c, c, c, hasAlpha && !!(bm & 0x10));
    }

    /** the program, its textures and its three uniform blocks */
    private useMat(m: Mat, L: Layout, dirty: boolean) {
        const gl = this.gl, bp = this.bp, xfw = this.xfw, xf = this.xf;
        if (this.curProgram !== m.program) { gl.useProgram(m.program); this.curProgram = m.program; }
        // ---- textures
        const P = this.matData;
        let texChanged = false;
        for (let u = 0; u < 8; u++) {
            if (!(m.maps & (1 << u))) continue;
            const base = u < 4 ? u : 0x20 + (u - 4), K = this.unitKey, k = u * 7;
            const m0 = bp[0x80 + base], m1 = bp[0x84 + base], i0 = bp[0x88 + base], i3 = bp[0x94 + base], tl = bp[0x98 + base];
            let t = this.unitTex[u];
            if (K[k] !== i0 || K[k + 1] !== i3 || K[k + 2] !== tl || K[k + 3] !== this.view.patchSeq || K[k + 4] !== this.tex.copySeq || K[k + 5] !== this.tex.tlutSeq || K[k + 6] !== (m0 & 0xE0) + m1 * 256) {
                K[k] = i0; K[k + 1] = i3; K[k + 2] = tl; K[k + 3] = this.view.patchSeq; K[k + 4] = this.tex.copySeq; K[k + 5] = this.tex.tlutSeq; K[k + 6] = (m0 & 0xE0) + m1 * 256;
                t = this.unitTex[u] = this.tex.lookup(bp, u, this.frameNo);
                this.boundTex[u] = null;
            }
            const gt = t ? t.tex : this.tex.clear.tex;
            if (this.boundTex[u] !== gt) { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, gt); this.boundTex[u] = gt; }
            const smp = this.tex.sampler(m0, m1);
            if (this.boundSampler[u] !== smp) { gl.bindSampler(u, smp); this.boundSampler[u] = smp; }
            const w = t ? t.w : 1, h = t ? t.h : 1, bias = ((m0 << 15) >> 24) / 32;
            if (P[OFF_SIZES + u * 2] !== w || P[OFF_SIZES + u * 2 + 1] !== h || P[OFF_BIAS + u] !== bias) { P[OFF_SIZES + u * 2] = w; P[OFF_SIZES + u * 2 + 1] = h; P[OFF_BIAS + u] = bias; texChanged = true; }
        }
        // ---- the scene block: the projection (0x1020.., its kind in 0x1026), turned to GL's clip space with y as the viewport runs and depth reversed
        if (this.xfDirty || this.sceneFresh) {
            const D = this.sceneData, ys = xf[0x101B] < 0 ? -1 : 1;
            D.fill(0);
            if (xfw[0x1026] & 1) { D[0] = xf[0x1020]; D[3] = xf[0x1021]; D[5] = ys * xf[0x1022]; D[7] = ys * xf[0x1023]; D[10] = -2 * xf[0x1024]; D[11] = -2 * xf[0x1025] - 1; D[15] = 1; }
            else { D[0] = xf[0x1020]; D[2] = xf[0x1021]; D[5] = ys * xf[0x1022]; D[6] = ys * xf[0x1023]; D[10] = 1 - 2 * xf[0x1024]; D[11] = -2 * xf[0x1025]; D[14] = -1; }
            this.uScene.push(D, 20);
            this.sceneFresh = false;
        }
        // ---- the material block
        if (dirty || this.paramDirty || texChanged || this.blockMat !== m) {
            for (let i = 0; i < 2; i++) { rgba8(P, OFF_MAT + i * 4, xfw[0x100C + i]); rgba8(P, OFF_AMB + i * 4, xfw[0x100A + i]); }
            for (let i = 0; i < 16; i++) { P[OFF_KONST + i] = this.konst[i] / 255; P[OFF_REG + i] = this.tevReg[i] / 255; }
            P.set(xf.subarray(120, 240), OFF_TEXMTX);
            for (let i = 0; i < 3; i++) {
                // an indirect matrix (0x06 + 3i ..): six signed 11-bit elements in 1/1024, and a scale 2^(n - 17) in three pieces
                const a = bp[6 + i * 3], b = bp[7 + i * 3], c = bp[8 + i * 3], o = OFF_IND + i * 8;
                const sc = Math.pow(2, (((a >>> 22) & 3) | (((b >>> 22) & 3) << 2) | (((c >>> 22) & 3) << 4)) - 17), f = sc / 1024;
                P[o] = s11(a) * f; P[o + 1] = s11(b) * f; P[o + 2] = s11(c) * f; P[o + 3] = sc;
                P[o + 4] = s11(a >>> 11) * f; P[o + 5] = s11(b >>> 11) * f; P[o + 6] = s11(c >>> 11) * f; P[o + 7] = 0;
            }
            if (m.post >= 0) P.set(xf.subarray(0x500, 0x500 + 240), m.post);
            if (m.lights >= 0) for (let i = 0; i < 8; i++) {
                // a light (0x600 + 16i): colour at +3, angle falloff +4, distance falloff +7, position +10, direction +13
                const o = m.lights + i * 20, l = 0x600 + i * 16;
                rgba8(P, o, xfw[l + 3]);
                P[o + 4] = xf[l + 10]; P[o + 5] = xf[l + 11]; P[o + 6] = xf[l + 12]; P[o + 7] = 0;
                P[o + 8] = xf[l + 13]; P[o + 9] = xf[l + 14]; P[o + 10] = xf[l + 15]; P[o + 11] = 0;
                P[o + 12] = xf[l + 7]; P[o + 13] = xf[l + 8]; P[o + 14] = xf[l + 9]; P[o + 15] = 0;
                P[o + 16] = xf[l + 4]; P[o + 17] = xf[l + 5]; P[o + 18] = xf[l + 6]; P[o + 19] = 0;
            }
            if (m.fog >= 0) {
                // the fog (0xEE: a; 0xEF, 0xF0: b as a number and a shift; 0xF1: c and the kind; 0xF2: the colour): for a
                // perspective view the eye distance is a / (b - depth), for a flat one a * depth; the fog is that minus c
                const o = m.fog, a = fogFloat(bp[0xEE]), shift = Math.pow(2, bp[0xF0] & 31);
                P.fill(0, o, o + 20);
                if (bp[0xF1] & 0x100000) { P[o] = a; P[o + 1] = 0; } else { P[o] = a * shift; P[o + 1] = (bp[0xEF] & 0xFFFFFF) * shift / 16777216; }
                P[o + 2] = fogFloat(bp[0xF1]);
                P[o + 16] = ((bp[0xF2] >>> 16) & 0xFF) / 255; P[o + 17] = ((bp[0xF2] >>> 8) & 0xFF) / 255; P[o + 18] = (bp[0xF2] & 0xFF) / 255;
            }
            P[m.alpha] = (bp[0xF3] & 0xFF) / 255; P[m.alpha + 1] = ((bp[0xF3] >>> 8) & 0xFF) / 255;
            this.uMat.push(P, m.floats);
            this.blockMat = m; this.paramDirty = false;
        }
        // ---- the draw block: the ten position matrices (matrix memory's first rows); a vertex without a matrix index takes the first, which is then the one 0x1018 names
        const pn = L.hasPnIdx ? -1 : xfw[0x1018] & 63;
        if (this.mtxDirty || pn !== this.blockPnIdx) {
            const D = this.drawData;
            D.set(xf.subarray(0, 120));
            if (pn > 0) D.set(xf.subarray(pn * 4, pn * 4 + 12));
            this.uDraw.push(D, 120);
            this.mtxDirty = false; this.blockPnIdx = pn;
        }
    }
    private sceneFresh = true;
}

const r32 = (b: Uint8Array, p: number) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const clamp01 = (v: number) => v < 0 ? 0 : v > 1 ? 1 : v;
const s11 = (v: number) => (v << 21) >> 21;
const rgba8 = (d: Float32Array, o: number, v: number) => { d[o] = (v >>> 24) / 255; d[o + 1] = ((v >>> 16) & 0xFF) / 255; d[o + 2] = ((v >>> 8) & 0xFF) / 255; d[o + 3] = (v & 0xFF) / 255; };
/** a fog parameter: 11 bits of mantissa, 8 of exponent, a sign (a float with a short mantissa) */
function fogFloat(v: number): number {
    const mant = v & 0x7FF, exp = (v >>> 11) & 0xFF, sign = (v >>> 19) & 1;
    if (!mant && !exp) return 0;
    return (sign ? -1 : 1) * Math.pow(2, exp - 127) * (1 + mant / 2048);
}
// GL's constants, by the registers' numbers. Depth is reversed here, so the comparisons are turned round.
const GLC = WebGL2RenderingContext;
const DEPTH_FUNC = [GLC.NEVER, GLC.GREATER, GLC.EQUAL, GLC.GEQUAL, GLC.LESS, GLC.NOTEQUAL, GLC.LEQUAL, GLC.ALWAYS];
const SRC_FACTOR = [GLC.ZERO, GLC.ONE, GLC.DST_COLOR, GLC.ONE_MINUS_DST_COLOR, GLC.SRC_ALPHA, GLC.ONE_MINUS_SRC_ALPHA, GLC.DST_ALPHA, GLC.ONE_MINUS_DST_ALPHA];
const DST_FACTOR = [GLC.ZERO, GLC.ONE, GLC.SRC_COLOR, GLC.ONE_MINUS_SRC_COLOR, GLC.SRC_ALPHA, GLC.ONE_MINUS_SRC_ALPHA, GLC.DST_ALPHA, GLC.ONE_MINUS_DST_ALPHA];
