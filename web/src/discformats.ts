// Disc image formats Dolphin users keep their games in, read in the browser: plain ISO / GCM,
// RVZ and WIA (zstd or uncompressed), GCZ (zlib) and CISO. Each is a byte source for the disc's
// own address space; disc.ts reads the file system through it.
//
// Formats from Dolphin's Source/Core/DiscIO (WIABlob.cpp, WIACompression.cpp,
// LaggedFibonacciGenerator.cpp, CompressedBlob.cpp, CISOBlob.cpp) and docs/WiaAndRvz.md.

import { decompress as zstdDecompress } from 'fzstd';

export interface DiscSource {
    /** Size of the disc data. */
    size: number;
    kind: string;
    read(off: number, len: number): Promise<Uint8Array>;
}

const u64 = (v: DataView, o: number, le = false) => v.getUint32(o + (le ? 4 : 0), le) * 0x100000000 + v.getUint32(o + (le ? 0 : 4), le);

async function bytes(blob: Blob, off: number, len: number) {
    return new Uint8Array(await blob.slice(off, off + len).arrayBuffer());
}

/** A small cache of decoded blocks, most recent last. */
class BlockCache {
    private m = new Map<number, Promise<Uint8Array>>();
    constructor(private max: number) { }
    get(k: number, make: () => Promise<Uint8Array>) {
        let p = this.m.get(k);
        if (p) { this.m.delete(k); this.m.set(k, p); return p; }
        p = make();
        this.m.set(k, p);
        p.catch(() => this.m.delete(k));
        if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
        return p;
    }
}

/** Reads a range out of fixed-size blocks: block(i) gives block i's bytes. */
async function readBlocks(off: number, len: number, blockSize: number, block: (i: number) => Promise<Uint8Array>) {
    const out = new Uint8Array(len);
    let done = 0;
    while (done < len) {
        const p = off + done, i = Math.floor(p / blockSize), at = p - i * blockSize;
        const b = await block(i);
        const n = Math.min(len - done, blockSize - at);
        out.set(b.subarray(at, at + n), done);   // a short last block leaves zeros
        done += n;
    }
    return out;
}

// ---------------------------------------------------------------- plain ISO / GCM
class RawSource implements DiscSource {
    kind = 'ISO';
    size: number;
    constructor(private blob: Blob) { this.size = blob.size; }
    read(off: number, len: number) { return bytes(this.blob, off, len); }
}

// ---------------------------------------------------------------- CISO
// Little endian: "CISO", u32 block size, then a 0x7FF8-byte map (1 = block present); present
// blocks follow the 0x8000-byte header in order.
class CisoSource implements DiscSource {
    kind = 'CISO';
    size: number;
    private map: Int32Array;
    private blockSize: number;
    constructor(private blob: Blob, head: Uint8Array) {
        const v = new DataView(head.buffer, head.byteOffset);
        this.blockSize = v.getUint32(4, true);
        const n = 0x8000 - 8;
        this.map = new Int32Array(n);
        let c = 0;
        for (let i = 0; i < n; i++) this.map[i] = head[8 + i] === 1 ? c++ : -1;
        this.size = n * this.blockSize;
    }
    async read(off: number, len: number) {
        const out = new Uint8Array(len), bs = this.blockSize;
        let done = 0;
        while (done < len) {
            const p = off + done, i = Math.floor(p / bs), at = p - i * bs, n = Math.min(len - done, bs - at);
            if (i < this.map.length && this.map[i] >= 0) out.set(await bytes(this.blob, 0x8000 + this.map[i] * bs + at, n), done);
            done += n;
        }
        return out;
    }
}

// ---------------------------------------------------------------- GCZ
// Little endian header (32 bytes): magic 0xB10BC001, sub type, u64 compressed size, u64 disc size,
// u32 block size, u32 block count; then u64 block pointers (top bit: stored uncompressed), u32
// Adler-32 hashes, then the data. Compressed blocks are zlib streams.
async function inflate(data: Uint8Array): Promise<Uint8Array> {
    const s = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(s).arrayBuffer());
}
class GczSource implements DiscSource {
    kind = 'GCZ';
    size = 0;
    private ptrs: number[] = [];
    private flags: boolean[] = [];
    private compressedSize = 0;
    private blockSize = 0;
    private dataOff = 0;
    private cache = new BlockCache(32);
    constructor(private blob: Blob) { }
    async init(head: Uint8Array) {
        const v = new DataView(head.buffer, head.byteOffset);
        this.compressedSize = u64(v, 8, true);
        this.size = u64(v, 16, true);
        this.blockSize = v.getUint32(24, true);
        const n = v.getUint32(28, true);
        const t = new DataView((await bytes(this.blob, 32, n * 8)).buffer);
        for (let i = 0; i < n; i++) {
            const hi = t.getUint32(i * 8 + 4, true);
            this.flags.push(!!(hi & 0x80000000));
            this.ptrs.push((hi & 0x7FFFFFFF) * 0x100000000 + t.getUint32(i * 8, true));
        }
        this.dataOff = 32 + n * 8 + n * 4;
        return this;
    }
    private block(i: number) {
        return this.cache.get(i, async () => {
            if (i >= this.ptrs.length) return new Uint8Array(this.blockSize);
            const start = this.ptrs[i], end = i + 1 < this.ptrs.length ? this.ptrs[i + 1] : this.compressedSize;
            const raw = await bytes(this.blob, this.dataOff + start, end - start);
            return this.flags[i] ? raw : inflate(raw);
        });
    }
    read(off: number, len: number) { return readBlocks(off, len, this.blockSize, (i) => this.block(i)); }
}

// ---------------------------------------------------------------- WIA / RVZ
// Lagged Fibonacci generator (f = xor, j = 32, k = 521) for RVZ's packed padding.
class Lfg {
    private b = new Uint32Array(521);
    private pos = 0;   // bytes into the buffer
    private bytesView = new Uint8Array(521 * 4);
    seed(s: Uint8Array) {
        const b = this.b, v = new DataView(s.buffer, s.byteOffset, 68);
        for (let i = 0; i < 17; i++) b[i] = v.getUint32(i * 4);
        for (let i = 17; i < 521; i++) b[i] = ((b[i - 17] << 23) ^ (b[i - 16] >>> 9) ^ b[i - 1]) >>> 0;
        // The output shifts byte 2 by 18 instead of 16; do that once here (it commutes with the xors).
        for (let i = 0; i < 521; i++) b[i] = ((b[i] & 0xFF00FFFF) | ((b[i] >>> 2) & 0x00FF0000)) >>> 0;
        for (let k = 0; k < 4; k++) this.forward();
        this.pos = 0;
        this.sync();
    }
    private forward() {
        const b = this.b;
        for (let i = 0; i < 32; i++) b[i] ^= b[i + 521 - 32];
        for (let i = 32; i < 521; i++) b[i] ^= b[i - 32];
    }
    private sync() { const v = new DataView(this.bytesView.buffer); for (let i = 0; i < 521; i++) v.setUint32(i * 4, this.b[i]); }
    skip(n: number) {
        this.pos += n;
        let moved = false;
        while (this.pos >= 521 * 4) { this.forward(); this.pos -= 521 * 4; moved = true; }
        if (moved) this.sync();
    }
    out(dst: Uint8Array, at: number, n: number) {
        while (n > 0) {
            const k = Math.min(n, 521 * 4 - this.pos);
            dst.set(this.bytesView.subarray(this.pos, this.pos + k), at);
            at += k; n -= k; this.pos += k;
            if (this.pos === 521 * 4) { this.forward(); this.sync(); this.pos = 0; }
        }
    }
}

interface RawEntry { off: number; size: number; group: number; groups: number; }
interface Group { off: number; size: number; compressed: boolean; packed: number; }

class WiaRvzSource implements DiscSource {
    kind: string;
    size = 0;
    private chunk = 0;
    private comp = 0;
    private header = new Uint8Array(0x80);
    private raw: RawEntry[] = [];
    private groups: Group[] = [];
    private cache = new BlockCache(48);
    constructor(private blob: Blob, private rvz: boolean) { this.kind = rvz ? 'RVZ' : 'WIA'; }

    private decompress(data: Uint8Array, expected: number, compressed = true): Uint8Array {
        if (!compressed || this.comp === 0) return data;
        if (this.comp === 5) return zstdDecompress(data);
        throw new Error(`This ${this.kind} image uses ${['', 'Purge', 'bzip2', 'LZMA', 'LZMA2'][this.comp] || 'an unknown'} compression, which the viewer can't read yet. Convert it to RVZ (Zstandard) or ISO in Dolphin.`);
    }

    async init(head: Uint8Array) {
        const v1 = new DataView(head.buffer, head.byteOffset);
        this.size = u64(v1, 0x24);
        const h2 = await bytes(this.blob, 0x48, v1.getUint32(0x0C));
        const v = new DataView(h2.buffer);
        if (v.getUint32(0) !== 1) throw new Error(`This ${this.kind} image isn't a GameCube disc.`);
        this.comp = v.getUint32(4);
        this.chunk = v.getUint32(0x0C);
        this.header = h2.slice(0x10, 0x90);
        const nRaw = v.getUint32(0xB4), rawOff = u64(v, 0xB8), rawSize = v.getUint32(0xC0);
        const nGroups = v.getUint32(0xC4), groupOff = u64(v, 0xC8), groupSize = v.getUint32(0xD0);
        const rawTab = this.decompress(await bytes(this.blob, rawOff, rawSize), nRaw * 0x18);
        const rv = new DataView(rawTab.buffer, rawTab.byteOffset);
        for (let i = 0; i < nRaw; i++) this.raw.push({ off: u64(rv, i * 0x18), size: u64(rv, i * 0x18 + 8), group: rv.getUint32(i * 0x18 + 16), groups: rv.getUint32(i * 0x18 + 20) });
        const gs = this.rvz ? 0x0C : 0x08;
        const gTab = this.decompress(await bytes(this.blob, groupOff, groupSize), nGroups * gs);
        const gv = new DataView(gTab.buffer, gTab.byteOffset);
        for (let i = 0; i < nGroups; i++) {
            const size = gv.getUint32(i * gs + 4);
            this.groups.push({
                off: gv.getUint32(i * gs) * 4, size: this.rvz ? size & 0x7FFFFFFF : size,
                compressed: this.rvz ? !!(size & 0x80000000) : true, packed: this.rvz ? gv.getUint32(i * gs + 8) : 0,
            });
        }
        return this;
    }

    /** Group gi's data: chunk bytes (fewer for the last of an entry), starting dataOffset into the entry's sector-aligned data. */
    private group(gi: number, length: number, dataOffset: number) {
        return this.cache.get(gi, async () => {
            const g = this.groups[gi];
            if (!g || g.size === 0) return new Uint8Array(length);
            let d = this.decompress(await bytes(this.blob, g.off, g.size), g.packed || length, g.compressed);
            if (g.packed) d = unpack(d, length, dataOffset);
            return d;
        });
    }

    async read(off: number, len: number) {
        const out = new Uint8Array(len);
        // The first 0x80 bytes are kept in the header.
        if (off < 0x80) out.set(this.header.subarray(off, Math.min(0x80, off + len)), 0);
        for (const r of this.raw) {
            // Entries' data starts at their offset rounded down to a 0x8000-byte sector.
            const skipped = r.off % 0x8000, start = r.off - skipped, size = r.size + skipped;
            const a = Math.max(off, start, 0x80), b = Math.min(off + len, start + size);
            if (a >= b) continue;
            let p = a;
            while (p < b) {
                const i = Math.floor((p - start) / this.chunk), gStart = start + i * this.chunk;
                const gLen = Math.min(this.chunk, size - i * this.chunk);
                const data = await this.group(r.group + i, gLen, i * this.chunk);
                const n = Math.min(b - p, gStart + gLen - p);
                out.set(data.subarray(p - gStart, p - gStart + n), p - off);
                p += n;
            }
        }
        return out;
    }
}

/** RVZ packing: [u32 size] then size bytes, or (top bit set) 68 bytes of seed for size bytes of padding. */
function unpack(d: Uint8Array, length: number, dataOffset: number): Uint8Array {
    const out = new Uint8Array(length), v = new DataView(d.buffer, d.byteOffset, d.byteLength), lfg = new Lfg();
    let i = 0, o = 0;
    while (i + 4 <= d.length && o < length) {
        const s = v.getUint32(i); i += 4;
        const n = Math.min(s & 0x7FFFFFFF, length - o);
        if (s & 0x80000000) {
            lfg.seed(d.subarray(i, i + 68)); i += 68;
            lfg.skip((dataOffset + o) % 0x8000);
            lfg.out(out, o, n);
        } else {
            out.set(d.subarray(i, i + n), o);
            i += s & 0x7FFFFFFF;
        }
        o += n;
    }
    return out;
}

/** The disc inside a file, whatever format it's in. */
export async function openSource(file: Blob, name: string): Promise<DiscSource> {
    const head = await bytes(file, 0, 0x8000);
    const v = new DataView(head.buffer);
    const magic = String.fromCharCode(...head.subarray(0, 4));
    if (magic === 'RVZ\x01') return new WiaRvzSource(file, true).init(head);
    if (magic === 'WIA\x01') return new WiaRvzSource(file, false).init(head);
    if (head.length >= 4 && v.getUint32(0, true) === 0xB10BC001) return new GczSource(file).init(head);
    if (magic === 'CISO') return new CisoSource(file, head);
    if (head.length >= 0x20 && v.getUint32(0x1C) === 0xC2339F3D) return new RawSource(file);
    if (/\.wbfs$/i.test(name)) throw new Error(`${name} is a Wii image (WBFS); Sunshine is a GameCube game.`);
    throw new Error(`${name} isn't a GameCube disc image the viewer knows (ISO, GCM, RVZ, WIA, GCZ or CISO).`);
}
