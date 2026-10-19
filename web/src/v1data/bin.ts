// Byte helpers for the v1 data converters (a TypeScript port of v1's tools/, which read the game's
// files with Python's struct module): big-endian reads, Shift-JIS strings, Python-compatible rounding
// and a content hash standing in for the tools' sha1 digests (only ever compared for equality).

export type Bytes = Uint8Array;

export const dv = (b: Bytes) => new DataView(b.buffer, b.byteOffset, b.byteLength);
export const u8 = (b: Bytes, o: number) => b[o];
export const u16 = (b: Bytes, o: number) => (b[o] << 8) | b[o + 1];
export const s16 = (b: Bytes, o: number) => (((b[o] << 8) | b[o + 1]) << 16) >> 16;
export const u32 = (b: Bytes, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
export const s32 = (b: Bytes, o: number) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
const f32buf = new DataView(new ArrayBuffer(4));
export function f32(b: Bytes, o: number) { f32buf.setUint32(0, u32(b, o)); return f32buf.getFloat32(0); }
export const s8 = (b: Bytes, o: number) => (b[o] << 24) >> 24;

const SJIS = new TextDecoder('shift_jis');
const ASCII = new TextDecoder('latin1');
/** bytes [o, the next NUL) */
export function cstr(b: Bytes, o: number, sjis = true) {
    let e = o;
    while (e < b.length && b[e] !== 0) e++;
    return (sjis ? SJIS : ASCII).decode(b.subarray(o, e));
}
export const ascii = (b: Bytes, o: number, n: number) => ASCII.decode(b.subarray(o, o + n));

/** Python's round(x, n): round half to even on the float's exact value. */
export function pyRound(x: number, n = 0): number {
    const m = Math.pow(10, n), y = x * m;
    let r = Math.round(y);   // (halves go up: the even neighbour of an odd one is below)
    if (Math.abs(y % 1) === 0.5 && r % 2 !== 0) r -= 1;
    const out = r / m;
    return Object.is(out, -0) ? 0 : out;
}

/** A 64-bit content hash (two FNV-1a lanes) as hex: equal bytes, equal key. */
export function contentHash(b: Uint8Array | ArrayBufferView): string {
    const u = b instanceof Uint8Array ? b : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ u.length;
    for (let i = 0; i < u.length; i++) { h1 = Math.imul(h1 ^ u[i], 0x01000193); h2 = Math.imul(h2 ^ u[i], 0x5bd1e995); h2 ^= h2 >>> 15; }
    return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'));
}

/** JSON.stringify with sorted keys (Python's json.dumps(sort_keys=True)), for cache keys. */
export function sortedJson(v: any): string {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(sortedJson).join(',') + ']';
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + sortedJson(v[k])).join(',') + '}';
}

// ---------------------------------------------------------------- Yaz0 / RARC (tools/convert_map.py)
export function yaz0(data: Bytes): Bytes {
    if (ascii(data, 0, 4) !== 'Yaz0') return data;
    const size = u32(data, 4), out = new Uint8Array(size);
    let src = 16, dst = 0;
    while (dst < size) {
        const code = data[src++];
        for (let bit = 7; bit >= 0; bit--) {
            if (dst >= size) break;
            if (code & (1 << bit)) out[dst++] = data[src++];
            else {
                const b1 = data[src], b2 = data[src + 1];
                src += 2;
                const dist = (((b1 & 0x0f) << 8) | b2) + 1;
                let n = b1 >> 4;
                if (n === 0) n = data[src++] + 0x12; else n += 2;
                for (let k = 0; k < n; k++, dst++) out[dst] = out[dst - dist];
            }
        }
    }
    return out;
}

/** rarc_files: every file by its path under the root node ("map/map/map.bmd"), in the archive's order. */
export function rarcFiles(data: Bytes): Map<string, Bytes> {
    if (ascii(data, 0, 4) !== 'RARC') throw new Error('not a RARC archive');
    const dataOff = u32(data, 0x0c) + 0x20, info = 0x20;
    const nNodes = u32(data, info), nodeOff = u32(data, info + 4) + info, entryOff = u32(data, info + 12) + info, stOff = u32(data, info + 20) + info;
    const files = new Map<string, Bytes>();
    const seen = new Set<number>();
    const walk = (ni: number, prefix: string) => {
        if (seen.has(ni) || ni >= nNodes) return;
        seen.add(ni);
        const o = nodeOff + ni * 0x10, count = u16(data, o + 10), first = u32(data, o + 12);
        for (let e = first; e < first + count; e++) {
            const eo = entryOff + e * 0x14;
            const fid = u16(data, eo), flags = data[eo + 4], noff = u16(data, eo + 6), doff = u32(data, eo + 8), dsize = u32(data, eo + 12);
            const name = cstr(data, stOff + noff, false);
            if (name === '.' || name === '..') continue;
            if (fid === 0xffff || (flags & 0x02)) walk(doff, `${prefix}${name}/`);
            else files.set(`${prefix}${name}`, data.subarray(dataOff + doff, dataOff + doff + dsize));
        }
    };
    walk(0, '');
    return files;
}
export const openArc = (b: Bytes) => rarcFiles(yaz0(b));
