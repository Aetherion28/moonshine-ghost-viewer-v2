// v3, the page's GPU: textures. A texture unit's registers (BP TX_SETIMAGE0: size and format, TX_SETIMAGE3: where
// the image is in RAM, TX_SETTLUT: its palette in the GPU's texture memory, TX_SETMODE0 / 1: wrapping and filters)
// become a GL texture and a sampler. Images are decoded by noclip's decoders (every GX format, with palettes) and
// kept by address, size, format and palette until the game writes the image again.
//
// Palettes: the game loads them from RAM into the GPU's texture memory (BP 0x64: where from, 0x65: where to and how
// many), and a paletted texture names a place there. That part of texture memory is kept here.
//
// A texture the game made by copying the frame buffer (see efb.ts) is found by its address before RAM is looked at.

import * as GX from '../../../noclip/gx/gx_enum.js';
import { calcTextureSize } from '../../../noclip/gx/gx_texture.js';
import { rust } from '../../../noclip/rustlib.js';
import { changedSince, RamView, RAM_MASK } from './geometry.js';

export interface Tex { tex: WebGLTexture; w: number; h: number }
interface Decoded extends Tex {
    /** size, format (the low 24 bits of TX_SETIMAGE0), mip levels, palette format and a hash of the palette */
    image0: number; mips: number; tlutFmt: number; tlutHash: number;
    bytes: number;
    stamp: number; checked: number; used: number;
}
/** a frame buffer copy: the texture, the bytes its image has in RAM, the patch count when it was made */
export interface Copy extends Tex { bytes: number; stamp: number; frame: number }

const FORMATS: { [f: number]: number } = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 8: 8, 9: 9, 10: 10, 14: 7 };   // GX format -> the decoder's
const PALETTE_ENTRIES: { [f: number]: number } = { 8: 16, 9: 256, 10: 16384 };

export class TextureCache {
    /** the palette part of the GPU's texture memory (BP 0x65's offset, in units of 512 bytes) */
    private tmem = new Uint8Array(0x400 * 512 + 0x8000);
    /** counts palette loads (a bound texture is looked up again after one) */
    tlutSeq = 0;
    private decoded = new Map<number, Decoded[]>();
    private samplers = new Map<number, WebGLSampler>();
    /** frame buffer copies by the address of their image; addresses where RAM has the image instead (the worker draws those itself) */
    copies = new Map<number, Copy>();
    ramWins = new Set<number>();
    /** counts copies (a bound texture is looked up again after one) */
    copySeq = 0;
    white: Tex; clear: Tex;
    // statistics
    decodes = 0;

    constructor(private gl: WebGL2RenderingContext, private view: RamView, private rewritten: (from: number, to: number, stamp: number) => boolean) {
        this.white = this.solid(255); this.clear = this.solid(0);
    }
    private solid(v: number): Tex {
        const gl = this.gl, tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([v, v, v, v]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
        return { tex, w: 1, h: 1 };
    }

    /** BP 0x65: a palette goes from RAM (BP 0x64) into texture memory */
    loadTlut(src: number, dst: number) {
        const from = (src << 5) & RAM_MASK, to = (dst & 0x3FF) << 9, n = ((dst >>> 10) & 0x7FF) << 5;
        const ram = this.view.ram;
        if (from + n > ram.length || to + n > this.tmem.length) return;
        this.tmem.set(ram.subarray(from, from + n), to);
        this.tlutSeq++;
    }

    /** The texture of unit `unit` as the registers bind it (null: nothing usable). `frame` marks it used. */
    lookup(bp: Uint32Array, unit: number, frame: number): Tex | null {
        const base = unit < 4 ? unit : 0x20 + (unit - 4);
        const m0 = bp[0x80 + base], m1 = bp[0x84 + base], i0 = bp[0x88 + base] & 0xFFFFFF, addr = (bp[0x94 + base] << 5) & RAM_MASK;
        const v = this.view;
        const copy = this.copies.get(addr);
        if (copy) {
            // (RAM written again after the copy: the worker drew this image itself, and its pixels are the console's)
            if (this.rewritten(addr, addr + copy.bytes, copy.stamp)) { this.dropCopy(addr); this.ramWins.add(addr); }
            else { copy.frame = frame; return copy; }
        }
        const fmt = (i0 >>> 20) & 15, w = (i0 & 0x3FF) + 1, h = ((i0 >>> 10) & 0x3FF) + 1;
        if (FORMATS[fmt] === undefined) return null;
        // mip levels: as many as the largest level of detail asks for, when the filter uses them
        let mips = 1;
        if ((m0 >>> 5) & 3) { mips = Math.min(((m1 >>> 12) & 0xF) + 1, Math.floor(Math.log2(Math.max(w, h))) + 1); if (mips < 1) mips = 1; }
        let tlutFmt = 0, tlutHash = 0, pal: Uint8Array | undefined;
        if (PALETTE_ENTRIES[fmt]) {
            const tl = bp[0x98 + base], at = (tl & 0x3FF) << 9;
            tlutFmt = (tl >>> 10) & 3;
            pal = this.tmem.subarray(at, at + PALETTE_ENTRIES[fmt] * 2);
            let hh = 0x811C9DC5;
            for (let i = 0; i < pal.length; i++) hh = Math.imul(hh ^ pal[i], 0x01000193);
            tlutHash = hh >>> 0;
        }
        let list = this.decoded.get(addr);
        if (!list) this.decoded.set(addr, list = []);
        let d: Decoded | undefined;
        for (const c of list) if (c.image0 === i0 && c.mips === mips && c.tlutFmt === tlutFmt && c.tlutHash === tlutHash) { d = c; break; }
        if (d) {
            d.used = frame;
            if (d.checked === v.patchSeq) return d;
            d.checked = v.patchSeq;
            if (!changedSince(v, addr, addr + d.bytes, d.stamp)) return d;
        }
        return this.decode(addr, i0, fmt, w, h, mips, tlutFmt, tlutHash, pal, frame, d, list);
    }

    private decode(addr: number, i0: number, fmt: number, w: number, h: number, mips: number, tlutFmt: number, tlutHash: number, pal: Uint8Array | undefined, frame: number, d: Decoded | undefined, list: Decoded[]): Tex | null {
        const gl = this.gl, v = this.view, ram = v.ram;
        if (!d) { d = { tex: gl.createTexture()!, w, h, image0: i0, mips, tlutFmt, tlutHash, bytes: 0, stamp: 0, checked: 0, used: frame }; list.push(d); }
        d.stamp = d.checked = v.patchSeq; d.used = frame;
        gl.bindTexture(gl.TEXTURE_2D, d.tex);
        let at = addr, lw = w, lh = h, level = 0;
        for (; level < mips; level++) {
            const size = calcTextureSize(fmt as GX.TexFormat, lw, lh);
            if (at + size > ram.length) break;
            let px: Uint8Array;
            try { px = rust.decode_texture(FORMATS[fmt], pal ? tlutFmt : undefined, ram.subarray(at, at + size), pal, lw, lh); } catch { break; }
            gl.texImage2D(gl.TEXTURE_2D, level, gl.RGBA8, lw, lh, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
            at += Math.max(size, 32);
            if (lw === 1 && lh === 1) { level++; break; }
            lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1);
        }
        d.bytes = at - addr;
        this.decodes++;
        if (!level) return null;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, level - 1);
        return d;
    }

    /** the sampler for a unit's mode registers */
    sampler(m0: number, m1: number): WebGLSampler {
        const key = (m0 & 0xFF) | ((m1 & 0xFFFF) << 8);
        let s = this.samplers.get(key);
        if (s) return s;
        const gl = this.gl;
        s = gl.createSampler()!;
        const wrap = (m: number) => m === 1 ? gl.REPEAT : m === 2 ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
        gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, wrap(m0 & 3));
        gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, wrap((m0 >>> 2) & 3));
        gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, m0 & 0x10 ? gl.LINEAR : gl.NEAREST);
        // the filter for a texture drawn smaller: bit 2 linear, the low two bits how mip levels are used (0 not, 1 the nearest, 2 two blended)
        const min = (m0 >>> 5) & 7, lin = (min & 4) !== 0, mip = min & 3;
        gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, mip === 0 ? (lin ? gl.LINEAR : gl.NEAREST) : mip === 1 ? (lin ? gl.LINEAR_MIPMAP_NEAREST : gl.NEAREST_MIPMAP_NEAREST) : (lin ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_LINEAR));
        gl.samplerParameterf(s, gl.TEXTURE_MIN_LOD, (m1 & 0xFF) / 16);
        gl.samplerParameterf(s, gl.TEXTURE_MAX_LOD, ((m1 >>> 8) & 0xFF) / 16);
        this.samplers.set(key, s);
        return s;
    }

    /** a frame buffer copy made for the image at `addr` (the caller fills the texture) */
    setCopy(addr: number, c: Copy) {
        const old = this.copies.get(addr);
        if (old && old.tex !== c.tex) this.gl.deleteTexture(old.tex);
        this.copies.set(addr, c);
        this.copySeq++;
    }
    private dropCopy(addr: number) {
        const c = this.copies.get(addr);
        if (c) { this.gl.deleteTexture(c.tex); this.copies.delete(addr); this.copySeq++; }
    }

    /** now and then: images not used for a long time are let go */
    sweep(frame: number) {
        const gl = this.gl;
        for (const [addr, list] of this.decoded) {
            for (let i = list.length - 1; i >= 0; i--) if (frame - list[i].used > 1200) { gl.deleteTexture(list[i].tex); list.splice(i, 1); }
            if (!list.length) this.decoded.delete(addr);
        }
    }
    clearAll() {
        const gl = this.gl;
        for (const list of this.decoded.values()) for (const d of list) gl.deleteTexture(d.tex);
        this.decoded.clear();
        for (const c of this.copies.values()) gl.deleteTexture(c.tex);
        this.copies.clear(); this.ramWins.clear();
        this.tmem.fill(0);
        this.tlutSeq++; this.copySeq++;
    }
    destroy() {
        const gl = this.gl;
        this.clearAll();
        for (const s of this.samplers.values()) gl.deleteSampler(s);
        gl.deleteTexture(this.white.tex); gl.deleteTexture(this.clear.tex);
    }
}
