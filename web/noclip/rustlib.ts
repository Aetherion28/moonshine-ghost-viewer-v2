// Moonshine Ghost Viewer v2: noclip's Rust/WebAssembly support library replaced by the few
// functions this viewer needs, in TypeScript: Yaz0 decompression and GX texture decoding
// (ported from noclip's rust/src/yaz0.rs and rust/src/gx_texture.rs, MIT).

export enum PixelFormat { I4, I8, IA4, IA8, RGB565, RGB5A3, RGBA8, CMPR, C4, C8, C14X2 }
export enum PaletteFormat { IA8, RGB565, RGB5A3 }

function expand(bits: number, n: number): number {
    if (bits === 3) return ((n << 5) | (n << 2) | (n >> 1)) & 0xFF;
    return ((n << (8 - bits)) | (n >> (bits * 2 - 8))) & 0xFF;
}

function rgb5a3(dst: Uint8Array, o: number, p: number) {
    if (p & 0x8000) {
        dst[o] = expand(5, (p >> 10) & 0x1F); dst[o + 1] = expand(5, (p >> 5) & 0x1F); dst[o + 2] = expand(5, p & 0x1F); dst[o + 3] = 0xFF;
    } else {
        dst[o] = expand(4, (p >> 8) & 0x0F); dst[o + 1] = expand(4, (p >> 4) & 0x0F); dst[o + 2] = expand(4, p & 0x0F); dst[o + 3] = expand(3, (p >> 12) & 0x07);
    }
}

function rgb565(dst: Uint8Array, o: number, p: number) {
    dst[o] = expand(5, (p >> 11) & 0x1F); dst[o + 1] = expand(6, (p >> 5) & 0x3F); dst[o + 2] = expand(5, p & 0x1F); dst[o + 3] = 0xFF;
}

const be16 = (s: Uint8Array, o: number) => (s[o] << 8) | s[o + 1];

function tiled(src: Uint8Array, w: number, h: number, bw: number, bh: number, px: (src: Uint8Array, idx: number, dst: Uint8Array, o: number) => void): Uint8Array {
    const dst = new Uint8Array(w * h * 4);
    let idx = 0;
    for (let yy = 0; yy < h; yy += bh)
        for (let xx = 0; xx < w; xx += bw)
            for (let y = 0; y < bh; y++)
                for (let x = 0; x < bw; x++, idx++)
                    if (xx + x < w && yy + y < h) px(src, idx, dst, ((yy + y) * w + (xx + x)) * 4);
    return dst;
}

function rgba8(src: Uint8Array, w: number, h: number): Uint8Array {
    const dst = new Uint8Array(w * h * 4);
    let s = 0;
    for (let yy = 0; yy < h; yy += 4)
        for (let xx = 0; xx < w; xx += 4) {
            for (let y = 0; y < 4; y++)
                for (let x = 0; x < 4; x++, s += 2)
                    if (xx + x < w && yy + y < h) { const o = ((yy + y) * w + xx + x) * 4; dst[o + 3] = src[s]; dst[o] = src[s + 1]; }
            for (let y = 0; y < 4; y++)
                for (let x = 0; x < 4; x++, s += 2)
                    if (xx + x < w && yy + y < h) { const o = ((yy + y) * w + xx + x) * 4; dst[o + 1] = src[s]; dst[o + 2] = src[s + 1]; }
        }
    return dst;
}

function cmpr(src: Uint8Array, w: number, h: number): Uint8Array {
    const dst = new Uint8Array(w * h * 4), t = new Uint8Array(16);
    const s3 = (a: number, b: number) => ((a * 3 + b * 5) >> 3) & 0xFF, half = (a: number, b: number) => (a + b) >> 1;
    let s = 0;
    for (let yy = 0; yy < h; yy += 8)
        for (let xx = 0; xx < w; xx += 8)
            for (let yb = 0; yb < 8; yb += 4)
                for (let xb = 0; xb < 8; xb += 4) {
                    const b = s; s += 8;
                    const c1 = be16(src, b), c2 = be16(src, b + 2);
                    rgb565(t, 0, c1); rgb565(t, 4, c2);
                    if (c1 > c2) {
                        for (let k = 0; k < 3; k++) { t[8 + k] = s3(t[4 + k], t[k]); t[12 + k] = s3(t[k], t[4 + k]); }
                        t[11] = 0xFF; t[15] = 0xFF;
                    } else {
                        for (let k = 0; k < 3; k++) { t[8 + k] = half(t[k], t[4 + k]); t[12 + k] = t[8 + k]; }
                        t[11] = 0xFF; t[15] = 0x00;
                    }
                    for (let y = 0; y < 4; y++) {
                        let bits = src[b + 4 + y];
                        for (let x = 0; x < 4; x++, bits <<= 2) {
                            if (xx + xb + x >= w || yy + yb + y >= h) continue;
                            const o = ((yy + yb + y) * w + xx + xb + x) * 4, c = ((bits >> 6) & 3) * 4;
                            dst[o] = t[c]; dst[o + 1] = t[c + 1]; dst[o + 2] = t[c + 2]; dst[o + 3] = t[c + 3];
                        }
                    }
                }
    return dst;
}

function palette(fmt: PaletteFormat, p: Uint8Array): Uint8Array {
    const n = p.length >> 1, dst = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
        if (fmt === PaletteFormat.IA8) { dst[i * 4] = dst[i * 4 + 1] = dst[i * 4 + 2] = p[i * 2 + 1]; dst[i * 4 + 3] = p[i * 2]; }
        else if (fmt === PaletteFormat.RGB565) rgb565(dst, i * 4, be16(p, i * 2));
        else rgb5a3(dst, i * 4, be16(p, i * 2));
    }
    return dst;
}

function decode_texture(fmt: PixelFormat, paletteFmt: PaletteFormat | undefined, src: Uint8Array, paletteSrc: Uint8Array | undefined, w: number, h: number): Uint8Array {
    const copy = (pal: Uint8Array, dst: Uint8Array, o: number, i: number) => { dst[o] = pal[i * 4]; dst[o + 1] = pal[i * 4 + 1]; dst[o + 2] = pal[i * 4 + 2]; dst[o + 3] = pal[i * 4 + 3]; };
    switch (fmt) {
    case PixelFormat.I4: return tiled(src, w, h, 8, 8, (s, i, d, o) => { d[o] = d[o + 1] = d[o + 2] = d[o + 3] = expand(4, (s[i >> 1] >> (i & 1 ? 0 : 4)) & 0xF); });
    case PixelFormat.I8: return tiled(src, w, h, 8, 4, (s, i, d, o) => { d[o] = d[o + 1] = d[o + 2] = d[o + 3] = s[i]; });
    case PixelFormat.IA4: return tiled(src, w, h, 8, 4, (s, i, d, o) => { d[o] = d[o + 1] = d[o + 2] = expand(4, s[i] & 0xF); d[o + 3] = expand(4, s[i] >> 4); });
    case PixelFormat.IA8: return tiled(src, w, h, 4, 4, (s, i, d, o) => { d[o] = d[o + 1] = d[o + 2] = s[i * 2 + 1]; d[o + 3] = s[i * 2]; });
    case PixelFormat.RGB565: return tiled(src, w, h, 4, 4, (s, i, d, o) => rgb565(d, o, be16(s, i * 2)));
    case PixelFormat.RGB5A3: return tiled(src, w, h, 4, 4, (s, i, d, o) => rgb5a3(d, o, be16(s, i * 2)));
    case PixelFormat.RGBA8: return rgba8(src, w, h);
    case PixelFormat.CMPR: return cmpr(src, w, h);
    case PixelFormat.C4: { const pal = palette(paletteFmt!, paletteSrc!); return tiled(src, w, h, 8, 8, (s, i, d, o) => copy(pal, d, o, (s[i >> 1] >> (i & 1 ? 0 : 4)) & 0xF)); }
    case PixelFormat.C8: { const pal = palette(paletteFmt!, paletteSrc!); return tiled(src, w, h, 8, 4, (s, i, d, o) => copy(pal, d, o, s[i])); }
    case PixelFormat.C14X2: { const pal = palette(paletteFmt!, paletteSrc!); return tiled(src, w, h, 4, 4, (s, i, d, o) => copy(pal, d, o, be16(s, i * 2) & 0x3FFF)); }
    }
}

function yaz0dec(src: Uint8Array): Uint8Array {
    const size = (src[4] << 24 | src[5] << 16 | src[6] << 8 | src[7]) >>> 0;
    const dst = new Uint8Array(size);
    let s = 0x10, d = 0;
    while (d < size) {
        const cmd = src[s++];
        for (let i = 7; i >= 0 && d < size; i--) {
            if (cmd & (1 << i)) { dst[d++] = src[s++]; continue; }
            const b0 = src[s++], b1 = src[s++];
            const back = (((b0 & 0x0F) << 8) | b1) + 1;
            let n = b0 >> 4;
            n = n === 0 ? src[s++] + 0x12 : n + 2;
            for (let k = 0; k < n; k++, d++) dst[d] = dst[d - back];
        }
    }
    return dst;
}


// The view frustum as planes (noclip rust/src/geometry.rs ConvexHull).
class ConvexHull {
    private p: number[] = [];   // nx, ny, nz, d per plane, normalized
    clear() { this.p.length = 0; }
    free() { }
    copy(): ConvexHull { const c = new ConvexHull(); c.p = this.p.slice(); return c; }
    push_plane(x: number, y: number, z: number, d: number) { const m = Math.hypot(x, y, z) || 1; this.p.push(x / m, y / m, z / m, d / m); }
    js_intersect_aabb(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
        let r = 0;   // Inside
        const p = this.p;
        for (let i = 0; i < p.length; i += 4) {
            const nx = p[i], ny = p[i + 1], nz = p[i + 2], d = p[i + 3];
            if (nx * (nx >= 0 ? x1 : x0) + ny * (ny >= 0 ? y1 : y0) + nz * (nz >= 0 ? z1 : z0) + d < 0) return 1;   // Outside
            if (nx * (nx >= 0 ? x0 : x1) + ny * (ny >= 0 ? y0 : y1) + nz * (nz >= 0 ? z0 : z1) + d < 0) r = 2;   // Intersection
        }
        return r;
    }
    js_contains_aabb(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
        const p = this.p;
        for (let i = 0; i < p.length; i += 4) {
            const nx = p[i], ny = p[i + 1], nz = p[i + 2], d = p[i + 3];
            if (nx * (nx >= 0 ? x1 : x0) + ny * (ny >= 0 ? y1 : y0) + nz * (nz >= 0 ? z1 : z0) + d < 0) return false;
        }
        return true;
    }
    js_contains_sphere(x: number, y: number, z: number, r: number): boolean {
        const p = this.p;
        for (let i = 0; i < p.length; i += 4) if (p[i] * x + p[i + 1] * y + p[i + 2] * z + p[i + 3] < -r) return false;
        return true;
    }
    js_contains_point(v: Float32Array): boolean {
        const p = this.p;
        for (let i = 0; i < p.length; i += 4) if (p[i] * v[0] + p[i + 1] * v[1] + p[i + 2] * v[2] + p[i + 3] < 0) return false;
        return true;
    }
    js_transform(m: Float32Array) {
        // planes transform by the inverse transpose
        const a = m, inv = new Float64Array(16);
        const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4], b02 = a[0] * a[7] - a[3] * a[4], b03 = a[1] * a[6] - a[2] * a[5];
        const b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6], b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12];
        const b08 = a[8] * a[15] - a[11] * a[12], b09 = a[9] * a[14] - a[10] * a[13], b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
        const det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
        inv[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * det; inv[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * det;
        inv[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * det; inv[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * det;
        inv[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * det; inv[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * det;
        inv[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * det; inv[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * det;
        inv[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * det; inv[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * det;
        inv[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * det; inv[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * det;
        inv[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * det; inv[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * det;
        inv[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * det; inv[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * det;
        const p = this.p;
        for (let i = 0; i < p.length; i += 4) {
            const x = p[i], y = p[i + 1], z = p[i + 2], w = p[i + 3];
            // (inv)^T * plane: row j of the transpose = column j of inv
            p[i] = inv[0] * x + inv[1] * y + inv[2] * z + inv[3] * w;
            p[i + 1] = inv[4] * x + inv[5] * y + inv[6] * z + inv[7] * w;
            p[i + 2] = inv[8] * x + inv[9] * y + inv[10] * z + inv[11] * w;
            p[i + 3] = inv[12] * x + inv[13] * y + inv[14] * z + inv[15] * w;
        }
    }
}

export const rust: any = { PixelFormat, PaletteFormat, decode_texture, yaz0dec, ConvexHull };

export async function loadRustLib() { }
