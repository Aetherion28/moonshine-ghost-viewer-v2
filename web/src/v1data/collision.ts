// Stage collision for v1's physics (tools/convert_map.py parse_col, tools/build_collision.py pack):
// 'SCOL', quantised vertices, indices, BG types and the per-triangle light set ('LGHT').
import { Bytes, u16, u32, s16, f32 } from './bin.js';

export function parseCol(data: Bytes): { verts: number[][]; tris: number[][]; types: number[] } {
    const vcount = u32(data, 0), voff = u32(data, 4), gcount = u32(data, 8), goff = u32(data, 12);
    const verts = Array.from({ length: vcount }, (_, i) => [f32(data, voff + i * 12), f32(data, voff + i * 12 + 4), f32(data, voff + i * 12 + 8)]);
    let lastErr: any = null;
    for (const stride of [0x18, 0x14, 0x1c, 0x10]) {
        try {
            const tris: number[][] = [], types: number[] = [];
            for (let g = 0; g < gcount; g++) {
                const o = goff + g * stride;
                if (o + 12 > data.length) throw new Error('struct');
                const ctype = u16(data, o), ntri = u16(data, o + 2), ioff = u32(data, o + 8);
                if (ioff + ntri * 6 > data.length) throw new Error('index block out of range');
                for (let t = 0; t < ntri; t++) {
                    const a = u16(data, ioff + t * 6), b = u16(data, ioff + t * 6 + 2), c = u16(data, ioff + t * 6 + 4);
                    if (Math.max(a, b, c) >= vcount) throw new Error('vertex index out of range');
                    tris.push([a, b, c]); types.push(ctype);
                }
            }
            if (!tris.length) throw new Error('no triangles');
            return { verts, tris, types };
        } catch (e) { lastErr = e; }
    }
    throw new Error(`could not parse collision: ${lastErr}`);
}

function lightIds(col: Bytes, ntris: number) {
    const gcount = u32(col, 8), goff = u32(col, 12), out: number[] = [];
    for (let g = 0; g < gcount; g++) {
        const o = goff + g * 0x18, bgtype = u16(col, o), ntri = u16(col, o + 2), flags = u16(col, o + 4), dataO = u32(col, o + 0x14);
        for (let t = 0; t < ntri; t++) {
            const d = flags & 1 && dataO ? s16(col, dataO + t * 2) : 0;
            out.push(bgtype & 0x4000 && d >= 0 && d < 256 ? d : 0);
        }
    }
    return out.length === ntris ? out : new Array(ntris).fill(0);
}

/** numpy's round: half to even */
const rint = (x: number) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; };

export function packCollision(col: Bytes): Uint8Array {
    const { verts, tris, types } = parseCol(col);
    const lights = lightIds(col, tris.length);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of verts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
    const origin = [0, 1, 2].map((k) => rint((lo[k] + hi[k]) / 2));
    let mx = 0;
    for (const v of verts) for (let k = 0; k < 3; k++) mx = Math.max(mx, Math.abs(v[k] - origin[k]));
    const step = Math.max(1.0, Math.ceil((mx / 32767) * 4) / 4);
    const parts: Uint8Array[] = [];
    const head = new Uint8Array(4 + 8 + 16), hd = new DataView(head.buffer);
    head.set([0x53, 0x43, 0x4f, 0x4c]); hd.setUint32(4, verts.length, true); hd.setUint32(8, tris.length, true);
    origin.forEach((v, i) => hd.setFloat32(12 + i * 4, v, true)); hd.setFloat32(24, step, true);
    parts.push(head);
    const pad4 = (b: Uint8Array) => (b.length % 4 ? (() => { const o = new Uint8Array(b.length + 4 - (b.length % 4)); o.set(b); return o; })() : b);
    const q = new Int16Array(verts.length * 3);
    verts.forEach((v, i) => { for (let k = 0; k < 3; k++) q[i * 3 + k] = rint((v[k] - origin[k]) / step); });
    parts.push(pad4(new Uint8Array(q.buffer)));
    const flat = tris.flat();
    const idx = verts.length <= 65535 ? Uint16Array.from(flat) : Uint32Array.from(flat);
    parts.push(pad4(new Uint8Array(idx.buffer)));
    parts.push(pad4(new Uint8Array(Uint16Array.from(types).buffer)));
    if (lights.some((x) => x)) { parts.push(new Uint8Array([0x4c, 0x47, 0x48, 0x54])); parts.push(Uint8Array.from(lights)); }
    const total = parts.reduce((s, p) => s + p.length, 0), out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}
