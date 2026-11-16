// LZMA and LZMA2 decoding, for Dolphin's WIA and RVZ images that use them: raw LZMA1 streams with
// their properties in the image's header, and LZMA2 chunk streams. After Igor Pavlov's reference
// decoder (LzmaSpec.cpp, public domain) and the xz format's LZMA2 chunks. Each stream is decoded
// whole into a buffer of its known size, which is also its dictionary.

const damaged = () => new Error('The LZMA data in this disc image is damaged.');

class RangeDecoder {
    range = 0xFFFFFFFF;
    code = 0;
    pos: number;
    constructor(private buf: Uint8Array, at: number, private end: number) {
        if (buf[at] !== 0) throw damaged();
        this.pos = at + 1;
        for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.byte()) >>> 0;
    }
    private byte() {
        if (this.pos >= this.end) throw damaged();
        return this.buf[this.pos++];
    }
    bit(p: Uint16Array, i: number): number {
        const v = p[i], bound = (this.range >>> 11) * v;
        let b: number;
        if (this.code < bound) { p[i] = v + ((2048 - v) >>> 5); this.range = bound; b = 0; }
        else { p[i] = v - (v >>> 5); this.code = (this.code - bound) >>> 0; this.range = (this.range - bound) >>> 0; b = 1; }
        if (this.range < 0x1000000) { this.range = (this.range << 8) >>> 0; this.code = ((this.code << 8) | this.byte()) >>> 0; }
        return b;
    }
    direct(n: number): number {
        let r = 0;
        while (n--) {
            this.range >>>= 1;
            let c = (this.code - this.range) >>> 0;
            const under = c >>> 31;   // the subtraction went below zero: a 0 bit
            if (under) c = (c + this.range) >>> 0;
            this.code = c;
            r = ((r << 1) | (1 - under)) >>> 0;
            if (this.range < 0x1000000) { this.range = (this.range << 8) >>> 0; this.code = ((this.code << 8) | this.byte()) >>> 0; }
        }
        return r;
    }
}

function tree(rc: RangeDecoder, p: Uint16Array, off: number, bits: number): number {
    let m = 1;
    for (let i = 0; i < bits; i++) m = (m << 1) | rc.bit(p, off + m);
    return m - (1 << bits);
}
function reverseTree(rc: RangeDecoder, p: Uint16Array, off: number, bits: number): number {
    let m = 1, s = 0;
    for (let i = 0; i < bits; i++) { const b = rc.bit(p, off + m); m = (m << 1) | b; s |= b << i; }
    return s;
}

class LenDecoder {
    choice = new Uint16Array(2);
    low = new Uint16Array(16 * 8);
    mid = new Uint16Array(16 * 8);
    high = new Uint16Array(256);
    reset() { for (const a of [this.choice, this.low, this.mid, this.high]) a.fill(1024); }
    decode(rc: RangeDecoder, posState: number): number {
        if (rc.bit(this.choice, 0) === 0) return tree(rc, this.low, posState * 8, 3);
        if (rc.bit(this.choice, 1) === 0) return 8 + tree(rc, this.mid, posState * 8, 3);
        return 16 + tree(rc, this.high, 0, 8);
    }
}

/** The coder's state: kept across the chunks of an LZMA2 stream unless a chunk resets it. */
class LzmaState {
    lc = 3; lp = 0; pb = 2;
    lit = new Uint16Array(0);
    isMatch = new Uint16Array(12 << 4);
    isRep = new Uint16Array(12);
    isRepG0 = new Uint16Array(12);
    isRepG1 = new Uint16Array(12);
    isRepG2 = new Uint16Array(12);
    isRep0Long = new Uint16Array(12 << 4);
    posSlot = new Uint16Array(4 * 64);
    posDec = new Uint16Array(1 + 128 - 14);
    align = new Uint16Array(16);
    len = new LenDecoder();
    repLen = new LenDecoder();
    state = 0; rep0 = 0; rep1 = 0; rep2 = 0; rep3 = 0;
    setProps(d: number) {
        if (d >= 9 * 5 * 5) throw damaged();
        this.lc = d % 9; d = (d / 9) | 0;
        this.lp = d % 5; this.pb = (d / 5) | 0;
    }
    reset() {
        if (this.lit.length !== 0x300 << (this.lc + this.lp)) this.lit = new Uint16Array(0x300 << (this.lc + this.lp));
        for (const a of [this.lit, this.isMatch, this.isRep, this.isRepG0, this.isRepG1, this.isRepG2, this.isRep0Long, this.posSlot, this.posDec, this.align]) a.fill(1024);
        this.len.reset(); this.repLen.reset();
        this.state = 0; this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
    }
}

/** Decodes into out[pos..end) (or up to an end marker); dict is where the dictionary starts (its last reset). */
function decodeRun(st: LzmaState, rc: RangeDecoder, out: Uint8Array, pos: number, end: number, dict: number): number {
    const pbMask = (1 << st.pb) - 1, lpMask = (1 << st.lp) - 1, lc = st.lc;
    while (pos < end) {
        const rel = pos - dict, posState = rel & pbMask;
        if (rc.bit(st.isMatch, (st.state << 4) + posState) === 0) {
            const prev = rel > 0 ? out[pos - 1] : 0;
            const base = 0x300 * (((rel & lpMask) << lc) + (prev >>> (8 - lc)));
            let sym = 1;
            if (st.state >= 7) {
                let match = out[pos - st.rep0 - 1];
                do {
                    const mb = (match >>> 7) & 1;
                    match <<= 1;
                    const b = rc.bit(st.lit, base + ((1 + mb) << 8) + sym);
                    sym = (sym << 1) | b;
                    if (mb !== b) break;
                } while (sym < 0x100);
            }
            while (sym < 0x100) sym = (sym << 1) | rc.bit(st.lit, base + sym);
            out[pos++] = sym - 0x100;
            st.state = st.state < 4 ? 0 : st.state < 10 ? st.state - 3 : st.state - 6;
            continue;
        }
        let len: number;
        if (rc.bit(st.isRep, st.state)) {
            if (rel === 0) throw damaged();
            if (rc.bit(st.isRepG0, st.state) === 0) {
                if (rc.bit(st.isRep0Long, (st.state << 4) + posState) === 0) {
                    // a single byte at the last distance
                    st.state = st.state < 7 ? 9 : 11;
                    if (st.rep0 >= rel) throw damaged();
                    out[pos] = out[pos - st.rep0 - 1];
                    pos++;
                    continue;
                }
            } else {
                let dist: number;
                if (rc.bit(st.isRepG1, st.state) === 0) dist = st.rep1;
                else {
                    if (rc.bit(st.isRepG2, st.state) === 0) dist = st.rep2;
                    else { dist = st.rep3; st.rep3 = st.rep2; }
                    st.rep2 = st.rep1;
                }
                st.rep1 = st.rep0;
                st.rep0 = dist;
            }
            len = st.repLen.decode(rc, posState);
            st.state = st.state < 7 ? 8 : 11;
        } else {
            st.rep3 = st.rep2; st.rep2 = st.rep1; st.rep1 = st.rep0;
            len = st.len.decode(rc, posState);
            st.state = st.state < 7 ? 7 : 10;
            const slot = tree(rc, st.posSlot, (len < 3 ? len : 3) * 64, 6);
            let dist: number;
            if (slot < 4) dist = slot;
            else {
                const nd = (slot >>> 1) - 1;
                dist = ((2 | (slot & 1)) << nd) >>> 0;
                if (slot < 14) dist = (dist + reverseTree(rc, st.posDec, dist - slot, nd)) >>> 0;
                else dist = (dist + rc.direct(nd - 4) * 16 + reverseTree(rc, st.align, 0, 4)) >>> 0;
            }
            if (dist === 0xFFFFFFFF) return pos;   // the end marker
            st.rep0 = dist;
        }
        len += 2;
        if (st.rep0 >= rel || pos + len > end) throw damaged();
        const from = pos - st.rep0 - 1;
        for (let i = 0; i < len; i++) out[pos + i] = out[from + i];   // (they may overlap)
        pos += len;
    }
    return pos;
}

/** A raw LZMA1 stream (WIA / RVZ compression 3): props is the image's 5 property bytes. */
export function unlzma(src: Uint8Array, props: Uint8Array, size: number): Uint8Array {
    if (props.length < 5) throw damaged();
    const st = new LzmaState();
    st.setProps(props[0]);
    st.reset();
    const out = new Uint8Array(size);
    if (decodeRun(st, new RangeDecoder(src, 0, src.length), out, 0, size, 0) !== size) throw damaged();
    return out;
}

/** An LZMA2 stream (WIA / RVZ compression 4): chunks of stored or LZMA data. */
export function unlzma2(src: Uint8Array, size: number): Uint8Array {
    const out = new Uint8Array(size), st = new LzmaState();
    let p = 0, pos = 0, dict = 0;
    while (p < src.length && pos < size) {
        const c = src[p++];
        if (c === 0) break;   // the end of the stream
        if (p + 2 > src.length) throw damaged();
        if (c === 1 || c === 2) {   // stored (1: with a dictionary reset)
            if (c === 1) dict = pos;
            const n = ((src[p] << 8) | src[p + 1]) + 1;
            p += 2;
            if (pos + n > size || p + n > src.length) throw damaged();
            out.set(src.subarray(p, p + n), pos);
            p += n; pos += n;
            continue;
        }
        if (c < 0x80 || p + 4 > src.length) throw damaged();
        const unpacked = (c & 0x1F) * 65536 + ((src[p] << 8) | src[p + 1]) + 1;
        const packed = ((src[p + 2] << 8) | src[p + 3]) + 1;
        p += 4;
        const reset = (c >>> 5) & 3;   // 1: state, 2: + new properties, 3: + dictionary
        if (reset === 3) dict = pos;
        if (reset >= 2) st.setProps(src[p++]);
        if (reset >= 1) st.reset();
        else if (!st.lit.length) throw damaged();
        if (pos + unpacked > size || p + packed > src.length) throw damaged();
        if (decodeRun(st, new RangeDecoder(src, p, p + packed), out, pos, pos + unpacked, dict) !== pos + unpacked) throw damaged();
        p += packed; pos += unpacked;
    }
    if (pos !== size) throw damaged();
    return out;
}
