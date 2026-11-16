// bzip2 decoding, for Dolphin's WIA and RVZ images that use it: the format as bzip2 1.0 writes it
// (decompress.c): blocks of Huffman-coded move-to-front values over a Burrows-Wheeler transform,
// with runs of zeros in bijective base 2 (RUNA / RUNB), then the first run-length coding undone.

const damaged = () => new Error('The bzip2 data in this disc image is damaged.');

const CRC = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04C11DB7 : c << 1;
    CRC[i] = c >>> 0;
}

class Bits {
    private p = 0;
    private bits = 0;
    private n = 0;
    constructor(private b: Uint8Array) { }
    /** k bits, most significant first (k up to 24) */
    read(k: number): number {
        while (this.n < k) {
            if (this.p >= this.b.length) throw damaged();
            this.bits = ((this.bits << 8) | this.b[this.p++]) >>> 0;
            this.n += 8;
        }
        this.n -= k;
        const v = (this.bits >>> this.n) & ((1 << k) - 1);
        this.bits &= (1 << this.n) - 1;
        return v;
    }
    align() { this.read(this.n % 8); }
}

interface Table { min: number; perm: Int32Array; base: Int32Array; limit: Int32Array; }

function makeTable(len: Uint8Array): Table {
    let min = 32, max = 0;
    for (const l of len) { if (l > max) max = l; if (l < min) min = l; }
    const perm = new Int32Array(len.length), base = new Int32Array(23), limit = new Int32Array(23);
    let pp = 0;
    for (let i = min; i <= max; i++) for (let j = 0; j < len.length; j++) if (len[j] === i) perm[pp++] = j;
    for (const l of len) base[l + 1]++;
    for (let i = 1; i < 23; i++) base[i] += base[i - 1];
    let vec = 0;
    for (let i = min; i <= max; i++) { vec += base[i + 1] - base[i]; limit[i] = vec - 1; vec <<= 1; }
    for (let i = max + 1; i < 23; i++) limit[i] = -1;   // (longer than any code: damaged data runs on to the error)
    for (let i = min + 1; i <= max; i++) base[i] = ((limit[i - 1] + 1) << 1) - base[i];
    return { min, perm, base, limit };
}

/** A bzip2 stream (or several in a row) of known decoded size. */
export function bunzip2(src: Uint8Array, size: number): Uint8Array {
    const out = new Uint8Array(size), br = new Bits(src);
    let o = 0;
    stream: while (o < size) {
        if (br.read(8) !== 0x42 || br.read(8) !== 0x5A || br.read(8) !== 0x68) throw damaged();   // "BZh"
        const level = br.read(8) - 0x30;
        if (level < 1 || level > 9) throw damaged();
        const max = level * 100000, tt = new Uint32Array(max);
        for (; ;) {
            const m1 = br.read(24), m2 = br.read(24);
            if (m1 === 0x177245 && m2 === 0x385090) { br.read(16); br.read(16); br.align(); continue stream; }   // the end, and its CRC
            if (m1 !== 0x314159 || m2 !== 0x265359) throw damaged();
            const crc = ((br.read(16) << 16) | br.read(16)) >>> 0;
            if (br.read(1)) throw new Error('This disc image uses bzip2\'s old randomised blocks, which the viewer can\'t read.');
            const origPtr = br.read(24);
            // the bytes used, in order
            const seq: number[] = [];
            const used = br.read(16);
            for (let i = 0; i < 16; i++) if (used & (0x8000 >>> i)) {
                const u = br.read(16);
                for (let j = 0; j < 16; j++) if (u & (0x8000 >>> j)) seq.push(i * 16 + j);
            }
            if (!seq.length) throw damaged();
            const alpha = seq.length + 2, EOB = alpha - 1;
            const nGroups = br.read(3), nSel = br.read(15);
            if (nGroups < 2 || nGroups > 6 || nSel < 1) throw damaged();
            // which Huffman table each group of 50 symbols uses (move-to-front coded)
            const order = [0, 1, 2, 3, 4, 5], sel = new Uint8Array(nSel);
            for (let i = 0; i < nSel; i++) {
                let j = 0;
                while (br.read(1)) if (++j >= nGroups) throw damaged();
                const t = order[j];
                for (; j > 0; j--) order[j] = order[j - 1];
                order[0] = t;
                sel[i] = t;
            }
            const tables: Table[] = [];
            for (let t = 0; t < nGroups; t++) {
                const len = new Uint8Array(alpha);
                let cur = br.read(5);
                for (let i = 0; i < alpha; i++) {
                    for (; ;) {
                        if (cur < 1 || cur > 20) throw damaged();
                        if (!br.read(1)) break;
                        cur += br.read(1) ? -1 : 1;
                    }
                    len[i] = cur;
                }
                tables.push(makeTable(len));
            }
            // the move-to-front values, with runs of the front byte
            const mtf = new Uint8Array(256);
            for (let i = 0; i < 256; i++) mtf[i] = i;
            const counts = new Uint32Array(256);
            let n = 0, group = -1, left = 0, tab = tables[0], run = 0, runBit = 1;
            for (; ;) {
                if (left === 0) {
                    if (++group >= nSel) throw damaged();
                    tab = tables[sel[group]];
                    left = 50;
                }
                left--;
                let zn = tab.min, zv = br.read(zn);
                while (zv > tab.limit[zn]) {
                    if (++zn > 20) throw damaged();
                    zv = (zv << 1) | br.read(1);
                }
                const k = zv - tab.base[zn];
                if (k < 0 || k >= alpha) throw damaged();
                const s = tab.perm[k];
                if (s <= 1) {   // RUNA / RUNB: a digit of a run's length
                    if (runBit >= 2 * 1024 * 1024) throw damaged();
                    run += (s + 1) * runBit;
                    runBit *= 2;
                    continue;
                }
                if (run) {
                    const b = seq[mtf[0]];
                    if (n + run > max) throw damaged();
                    counts[b] += run;
                    tt.fill(b, n, n + run);
                    n += run; run = 0; runBit = 1;
                }
                if (s === EOB) break;
                const m = s - 1, v = mtf[m];
                mtf.copyWithin(1, 0, m);
                mtf[0] = v;
                const b = seq[v];
                if (n >= max) throw damaged();
                counts[b]++;
                tt[n++] = b;
            }
            // undo the Burrows-Wheeler transform, and the first run-length coding with it
            if (origPtr >= n) throw damaged();
            const cf = new Uint32Array(256);
            for (let i = 0, sum = 0; i < 256; i++) { cf[i] = sum; sum += counts[i]; }
            for (let i = 0; i < n; i++) { const b = tt[i] & 0xFF; tt[cf[b]++] |= i << 8; }
            let t = tt[origPtr] >>> 8, c = 0xFFFFFFFF, last = -1, same = 0;
            const put = (b: number) => {
                if (o >= size) throw damaged();
                out[o++] = b;
                c = ((c << 8) ^ CRC[((c >>> 24) ^ b) & 0xFF]) >>> 0;
            };
            for (let i = 0; i < n; i++) {
                t = tt[t];
                const b = t & 0xFF;
                t >>>= 8;
                if (same === 4) {   // four alike: this byte is how many more
                    for (let r = 0; r < b; r++) put(last);
                    same = 0;
                    continue;
                }
                if (b === last) same++; else { same = 1; last = b; }
                put(b);
            }
            if ((~c >>> 0) !== crc) throw damaged();
        }
    }
    return out;
}
