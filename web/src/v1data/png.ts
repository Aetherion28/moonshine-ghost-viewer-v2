// PNG encoding for the converted textures (RGBA, or RGB without alpha), downscaled to fit a size
// with a box filter (the tools used PIL's thumbnail). Straight alpha, nothing premultiplied.
import type { Image } from './gxtex.js';

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array, start: number, end: number) { let c = 0xffffffff; for (let i = start; i < end; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

async function deflate(data: Uint8Array): Promise<Uint8Array> {
    const cs = new CompressionStream('deflate');
    const w = cs.writable.getWriter();
    void w.write(data as unknown as BufferSource); void w.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/** PIL Image.thumbnail's size: fit in max x max, keeping the aspect */
export function fitSize(w: number, h: number, max: number): [number, number] {
    if (Math.max(w, h) <= max) return [w, h];
    const s = max / Math.max(w, h);
    return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}
export function downscale(img: Image, nw: number, nh: number): Image {
    if (nw === img.w && nh === img.h) return img;
    const out = new Uint8Array(nw * nh * 4), sx = img.w / nw, sy = img.h / nh;
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
        const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx)), y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
        const acc = [0, 0, 0, 0];
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const o = (yy * img.w + xx) * 4; for (let c = 0; c < 4; c++) acc[c] += img.d[o + c]; }
        const n = (x1 - x0) * (y1 - y0), o = (y * nw + x) * 4;
        for (let c = 0; c < 4; c++) out[o + c] = Math.round(acc[c] / n);
    }
    return { w: nw, h: nh, d: out };
}

export async function encodePng(img: Image, alpha: boolean, maxSide = Infinity): Promise<Uint8Array> {
    const [nw, nh] = fitSize(img.w, img.h, maxSide);
    const im = downscale(img, nw, nh);
    const ch = alpha ? 4 : 3, stride = im.w * ch + 1;
    const raw = new Uint8Array(stride * im.h);
    for (let y = 0; y < im.h; y++) {
        raw[y * stride] = 0;
        for (let x = 0; x < im.w; x++) for (let c = 0; c < ch; c++) raw[y * stride + 1 + x * ch + c] = im.d[(y * im.w + x) * 4 + c];
    }
    const idat = await deflate(raw);
    const chunks: [string, Uint8Array][] = [];
    const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
    dv.setUint32(0, im.w); dv.setUint32(4, im.h); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
    chunks.push(['IHDR', ihdr], ['IDAT', idat], ['IEND', new Uint8Array(0)]);
    const total = 8 + chunks.reduce((s, [, d]) => s + 12 + d.length, 0);
    const out = new Uint8Array(total), od = new DataView(out.buffer);
    out.set([137, 80, 78, 71, 13, 10, 26, 10]);
    let o = 8;
    for (const [t, d] of chunks) {
        od.setUint32(o, d.length);
        for (let i = 0; i < 4; i++) out[o + 4 + i] = t.charCodeAt(i);
        out.set(d, o + 8);
        od.setUint32(o + 8 + d.length, crc32(out, o + 4, o + 8 + d.length));
        o += 12 + d.length;
    }
    return out;
}
export function b64(u: Uint8Array) { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); }
export const pngDataUri = async (img: Image, alpha = true) => 'data:image/png;base64,' + b64(await encodePng(img, alpha));
