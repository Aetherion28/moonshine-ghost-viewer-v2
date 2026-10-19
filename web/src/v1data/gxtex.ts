// GameCube (GX) texture decoding (tools/gx_texture.py): RGBA8 images, rows top to bottom.
import { Bytes, u16 } from './bin.js';

export interface Image { w: number; h: number; d: Uint8Array }

export const I4 = 0, I8 = 1, IA4 = 2, IA8 = 3, RGB565 = 4, RGB5A3 = 5, RGBA8 = 6, C4 = 8, C8 = 9, C14X2 = 10, CMPR = 14;
const BLOCK: Record<number, [number, number, number]> = {
    [I4]: [8, 8, 4], [I8]: [8, 4, 8], [IA4]: [8, 4, 8], [IA8]: [4, 4, 16], [RGB565]: [4, 4, 16], [RGB5A3]: [4, 4, 16],
    [RGBA8]: [4, 4, 32], [C4]: [8, 8, 4], [C8]: [8, 4, 8], [C14X2]: [4, 4, 16], [CMPR]: [8, 8, 4],
};
export function dataSize(fmt: number, w: number, h: number) {
    const [bw, bh, bpp] = BLOCK[fmt];
    return Math.floor((Math.ceil(w / bw) * Math.ceil(h / bh) * bw * bh * bpp) / 8);
}
export function rgb565(v: number, out: Uint8Array | number[], o: number) {
    const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
    out[o] = (r << 3) | (r >> 2); out[o + 1] = (g << 2) | (g >> 4); out[o + 2] = (b << 3) | (b >> 2); out[o + 3] = 255;
}
function rgb5a3(v: number, out: Uint8Array, o: number) {
    if (v & 0x8000) {
        const r5 = (v >> 10) & 31, g5 = (v >> 5) & 31, b5 = v & 31;
        out[o] = (r5 << 3) | (r5 >> 2); out[o + 1] = (g5 << 3) | (g5 >> 2); out[o + 2] = (b5 << 3) | (b5 >> 2); out[o + 3] = 255;
    } else {
        const a3 = (v >> 12) & 7;
        out[o] = ((v >> 8) & 15) * 17; out[o + 1] = ((v >> 4) & 15) * 17; out[o + 2] = (v & 15) * 17; out[o + 3] = (a3 << 5) | (a3 << 2) | (a3 >> 1);
    }
}
function ia8(v: number, out: Uint8Array, o: number) { const i = v & 255; out[o] = out[o + 1] = out[o + 2] = i; out[o + 3] = (v >> 8) & 255; }

function palette(pal: Bytes | null, palFmt: number, count: number): Uint8Array {
    const out = new Uint8Array(count * 4);
    if (!pal) return out;
    const n = Math.min(count, pal.length >> 1);
    for (let i = 0; i < n; i++) {
        const v = u16(pal, i * 2);
        if (palFmt === 0) ia8(v, out, i * 4); else if (palFmt === 1) rgb565(v, out, i * 4); else rgb5a3(v, out, i * 4);
    }
    return out;
}

/** decode(data, fmt, w, h, palette, palette format) */
export function decode(data: Bytes, fmt: number, w: number, h: number, pal: Bytes | null = null, palFmt = 0): Image {
    const blk = BLOCK[fmt];
    if (!blk) throw new Error(`unsupported texture format ${fmt}`);
    const [bw, bh] = blk, n = dataSize(fmt, w, h);
    if (data.length < n) throw new Error('texture data short');
    const bx = Math.ceil(w / bw), by = Math.ceil(h / bh);
    const out = new Uint8Array(w * h * 4);
    // pixel p (0..) in block order -> its (x, y)
    const put = (p: number, src: Uint8Array | number[], so: number) => {
        const blkI = Math.floor(p / (bw * bh)), inB = p % (bw * bh);
        const x = (blkI % bx) * bw + (inB % bw), y = Math.floor(blkI / bx) * bh + Math.floor(inB / bw);
        if (x >= w || y >= h) return;
        const o = (y * w + x) * 4;
        out[o] = src[so]; out[o + 1] = src[so + 1]; out[o + 2] = src[so + 2]; out[o + 3] = src[so + 3];
    };
    const tmp = new Uint8Array(4);
    const npx = bx * by * bw * bh;
    if (fmt === I4 || fmt === C4) {
        const P = fmt === C4 ? palette(pal, palFmt, 16) : null;
        for (let p = 0; p < npx; p++) {
            const b = data[p >> 1], idx = p & 1 ? b & 15 : b >> 4;
            if (P) put(p, P, idx * 4); else { tmp[0] = tmp[1] = tmp[2] = tmp[3] = idx * 17; put(p, tmp, 0); }
        }
    } else if (fmt === I8 || fmt === C8) {
        const P = fmt === C8 ? palette(pal, palFmt, 256) : null;
        for (let p = 0; p < npx; p++) { const v = data[p]; if (P) put(p, P, v * 4); else { tmp[0] = tmp[1] = tmp[2] = tmp[3] = v; put(p, tmp, 0); } }
    } else if (fmt === IA4) {
        for (let p = 0; p < npx; p++) { const v = data[p]; tmp[0] = tmp[1] = tmp[2] = (v & 15) * 17; tmp[3] = (v >> 4) * 17; put(p, tmp, 0); }
    } else if (fmt === IA8 || fmt === RGB565 || fmt === RGB5A3 || fmt === C14X2) {
        const pcount = fmt === C14X2 ? Math.max(1, pal ? pal.length >> 1 : 1) : 0;
        const P = fmt === C14X2 ? palette(pal, palFmt, pcount) : null;
        for (let p = 0; p < npx; p++) {
            const v = u16(data, p * 2);
            if (fmt === IA8) ia8(v, tmp, 0); else if (fmt === RGB565) rgb565(v, tmp, 0); else if (fmt === RGB5A3) rgb5a3(v, tmp, 0);
            else { const i = Math.min(Math.max(v & 0x3fff, 0), pcount - 1); tmp.set(P!.subarray(i * 4, i * 4 + 4)); }
            put(p, tmp, 0);
        }
    } else if (fmt === RGBA8) {
        for (let blkI = 0; blkI < bx * by; blkI++) {
            const o = blkI * 64;
            for (let k = 0; k < 16; k++) {
                tmp[3] = data[o + k * 2]; tmp[0] = data[o + k * 2 + 1]; tmp[1] = data[o + 32 + k * 2]; tmp[2] = data[o + 32 + k * 2 + 1];
                put(blkI * 16 + k, tmp, 0);
            }
        }
    } else if (fmt === CMPR) {
        const pal4 = new Uint8Array(16), p0 = new Uint8Array(4), p1 = new Uint8Array(4);
        const nsub = n >> 3;
        for (let s = 0; s < nsub; s++) {
            const o = s * 8, c0 = u16(data, o), c1 = u16(data, o + 2);
            rgb565(c0, p0, 0); rgb565(c1, p1, 0);
            const gt = c0 > c1;
            for (let c = 0; c < 4; c++) {
                pal4[c] = p0[c]; pal4[4 + c] = p1[c];
                pal4[8 + c] = gt ? Math.floor((2 * p0[c] + p1[c]) / 3) : (p0[c] + p1[c]) >> 1;
                pal4[12 + c] = gt ? Math.floor((p0[c] + 2 * p1[c]) / 3) : 0;
            }
            pal4[11] = 255; pal4[15] = gt ? 255 : 0;
            // sub-block s: macro block s >> 2, its quadrant (s & 3) in Z order
            const mb = s >> 2, q = s & 3;
            const mx = (mb % Math.ceil(w / 8)) * 8 + (q & 1) * 4, my = Math.floor(mb / Math.ceil(w / 8)) * 8 + (q >> 1) * 4;
            for (let r = 0; r < 4; r++) {
                const bits = data[o + 4 + r];
                for (let c = 0; c < 4; c++) {
                    const idx = (bits >> (6 - c * 2)) & 3, x = mx + c, y = my + r;
                    if (x >= w || y >= h) continue;
                    const oo = (y * w + x) * 4;
                    out[oo] = pal4[idx * 4]; out[oo + 1] = pal4[idx * 4 + 1]; out[oo + 2] = pal4[idx * 4 + 2]; out[oo + 3] = pal4[idx * 4 + 3];
                }
            }
        }
    }
    return { w, h, d: out };
}
