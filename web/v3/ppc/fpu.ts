// v3: the Gekko's floating point, bit for bit.
// - fused multiply-adds rounded once (exactly: error-free transformations, the tail rounded to odd);
// - a single multiply's frC keeps 25 bits of mantissa (Dolphin's Force25Bit, from hardware tests);
// - FPSCR[NI] (set by the GameCube OS): a result below the smallest normal number is flushed to zero;
// - lfs / stfs convert between single and double as the hardware does (stfs truncates, NaNs keep
//   their payloads);
// - fres / frsqrte are the Gekko's table estimates (Dolphin's tables, from hardware tests).
// Doubles are JS numbers; where bits matter (NaN payloads, fctiw's result) the callers use raw words.

export const fr = Math.fround;

const f64 = new Float64Array(1), w64 = new Uint32Array(f64.buffer);   // [lo, hi] (little-endian host)
const f32 = new Float32Array(1), w32 = new Uint32Array(f32.buffer);

export const MIN_NORMAL_F32 = 1.1754943508222875e-38, MIN_NORMAL_F64 = 2.2250738585072014e-308;

// ---------------------------------------------------------------- exact fused multiply-add
const SPLIT = 134217729;   // 2^27 + 1
/** the remainder of the last fmaD: exact - result (only its sign and zero-ness are meaningful) */
let tail = 0;
/** a * c + b rounded once to double */
export function fmaD(a: number, c: number, b: number): number {
    const p = a * c;
    const ap = p < 0 ? -p : p;
    // zero, infinite or NaN products, and magnitudes where the splitting would overflow / underflow:
    // the plain sum has the right special values (and such magnitudes don't occur in the game's data)
    if (!(ap > 1e-290 && ap < 1e290) || b !== b || b === Infinity || b === -Infinity) { tail = 0; return p + b; }
    // p + e = a * c exactly (Dekker)
    let t = SPLIT * a; const ah = t - (t - a), al = a - ah;
    t = SPLIT * c; const ch = t - (t - c), cl = c - ch;
    const e = ((ah * ch - p) + ah * cl + al * ch) + al * cl;
    // s + err = p + b exactly (Knuth)
    const s = p + b; let bb = s - p; const err = (p - (s - bb)) + (b - bb);
    if (e === 0) { tail = err; return s; }
    // t1 + t2 = err + e exactly
    const t1 = err + e; bb = t1 - err; const t2 = (err - (t1 - bb)) + (e - bb);
    // u + v = s + t1 exactly
    const u = s + t1; bb = u - s; const v = (s - (u - bb)) + (t1 - bb);
    // w = v + t2 rounded to odd (so that the final rounding of u + w sees a sticky bit)
    let w = v + t2; bb = w - v; const werr = (v - (w - bb)) + (t2 - bb);
    if (werr !== 0) {
        f64[0] = w;
        if (!(w64[0] & 1)) {
            if (w === 0) w = werr;
            else if ((werr > 0) === (w > 0)) { if (++w64[0] === 0) w64[1]++; w = f64[0]; }
            else { if (w64[0]-- === 0) w64[1]--; w = f64[0]; }
        }
    }
    const r = u + w; bb = r - u;
    tail = (u - (r - bb)) + (w - bb);
    return r;
}
/** a * c + b rounded once to single */
/** Dolphin's single multiply-add (its JIT of 2016): the sum rounded to double, then to single (a TAS made there) */
export const dolphinFma = { on: false };
export function fmaS(a: number, c: number, b: number): number {
    if (dolphinFma.on) return fr(a * c + b);
    const d = fmaD(a, c, b), r = fr(d);
    if (tail === 0 || r === d || r !== r || r === Infinity || r === -Infinity) return r;
    // d was rounded from the exact value; if d sits exactly halfway between two singles, the
    // exact value's side decides (not ties-to-even)
    f32[0] = r; const bits = w32[0];
    // the neighbouring single on d's side of r
    w32[0] = r === 0 ? ((d > 0 ? 0 : 0x80000000) | 1) >>> 0 : (d > r) === (r > 0) ? bits + 1 : bits - 1;
    const o = f32[0];
    if (d !== (r + o) / 2) return r;
    return (tail > 0) === (o > r) ? o : r;
}

// ---------------------------------------------------------------- Force25Bit
/** a single multiply's frC: its mantissa rounded to 25 bits */
export function force25(d: number) {
    f64[0] = d;
    const lo = w64[0];
    if (!(lo & 0x0FFFFFFF)) return d;   // (a single's low 29 bits are zero: unchanged)
    const n = ((lo & 0xF8000000) >>> 0) + (lo & 0x08000000);
    if (n > 0xFFFFFFFF) { w64[0] = 0; w64[1]++; } else w64[0] = n;
    return f64[0];
}

/**
 * The multiplier the second lane takes from frC's first lane (ps_muls0, ps_madds0): cut to 25 bits, not
 * rounded. Dolphin rounds it as the first lane's. A console recording says otherwise (Bianco Hills episode 1,
 * a/trace_41726535_80000003: MsVECNormalize multiplies y by a frsqrte estimate, 0x3FF000082C000000, at movement
 * tick 596, and Mario's head matrix then needs y * 0x3FF0000820000000; four ticks earlier a 24-bit multiplier
 * gives a wrong element of another of his matrices (+0x260), so the cut is at 25 bits). With it the recording stays bit-identical for 2,347
 * ticks; with the rounded multiplier, 598.
 */
export function trunc25(d: number) {
    f64[0] = d;
    const lo = w64[0];
    if (!(lo & 0x0FFFFFFF)) return d;
    w64[0] = (lo & 0xF0000000) >>> 0;
    return f64[0];
}

// ---------------------------------------------------------------- single <-> double as the hardware converts
/** lfs: a single's bits as a double, into words[i] (lo), words[i + 1] (hi); NaNs keep their bits */
export function singleToDoubleBits(x: number, words: Uint32Array, i: number) {
    if ((x & 0x7F800000) === 0x7F800000 && (x & 0x007FFFFF)) {   // a NaN: not quieted
        words[i + 1] = ((x & 0xC0000000) | 0x38000000 | ((x & 0x3FFFFFFF) >>> 3)) >>> 0;
        words[i] = (x << 29) >>> 0;
        return;
    }
    w32[0] = x; f64[0] = f32[0];
    words[i] = w64[0]; words[i + 1] = w64[1];
}
/** stfs: a double's bits (hi, lo) as a single's. Not a rounding: the hardware drops the low bits. */
export function doubleToSingleBits(hi: number, lo: number): number {
    const exp = (hi >>> 20) & 0x7FF;
    if (exp > 896 || ((hi & 0x7FFFFFFF) | lo) === 0 || exp < 874)
        return ((hi & 0xC0000000) | (((hi & 0x07FFFFFF) << 3) | (lo >>> 29))) >>> 0;
    // a denormal single
    let t = (0x80000000 | ((hi & 0x000FFFFF) << 11) | (lo >>> 21)) >>> 0;
    t = t >>> (905 - exp);
    return (t | (hi & 0x80000000)) >>> 0;
}
export const f32FromBits = (b: number) => { w32[0] = b; return f32[0]; };
export const f32Bits = (v: number) => { f32[0] = v; return w32[0]; };

// ---------------------------------------------------------------- fres / frsqrte
const FRES_BASE = new Int32Array([
    0x7ff800, 0x783800, 0x70ea00, 0x6a0800, 0x638800, 0x5d6200, 0x579000, 0x520800,
    0x4cc800, 0x47ca00, 0x430800, 0x3e8000, 0x3a2c00, 0x360800, 0x321400, 0x2e4a00,
    0x2aa800, 0x272c00, 0x23d600, 0x209e00, 0x1d8800, 0x1a9000, 0x17ae00, 0x14f800,
    0x124400, 0x0fbe00, 0x0d3800, 0x0ade00, 0x088400, 0x065000, 0x041c00, 0x020c00]);
const FRES_DEC = new Int32Array([
    0x3e1, 0x3a7, 0x371, 0x340, 0x313, 0x2ea, 0x2c4, 0x2a0, 0x27f, 0x261, 0x245, 0x22a, 0x212, 0x1fb, 0x1e5, 0x1d1,
    0x1be, 0x1ac, 0x19b, 0x18b, 0x17c, 0x16e, 0x15b, 0x15b, 0x143, 0x143, 0x12d, 0x12d, 0x11a, 0x11a, 0x108, 0x106]);
/** fres: the reciprocal estimate (ApproximateReciprocal) */
export function fres(v: number): number {
    f64[0] = v;
    const hi = w64[1], lo = w64[0], sign = hi & 0x80000000, exp = (hi >>> 20) & 0x7FF, mhi = hi & 0xFFFFF;
    if (exp === 0 && (mhi | lo) === 0) return sign ? -Infinity : Infinity;
    if (exp === 0x7FF) return (mhi | lo) === 0 ? (sign ? -0 : 0) : v + 0;
    if (exp < 895) return sign ? -3.4028234663852886e38 : 3.4028234663852886e38;
    if (exp >= 1149) return sign ? -0 : 0;
    const i = mhi >>> 5, k = i >>> 10;
    const val = FRES_BASE[k] - ((FRES_DEC[k] * (i & 1023) + 1) >> 1);
    w64[1] = (sign | ((0x7FD - exp) << 20) | (val >>> 3)) >>> 0; w64[0] = (val << 29) >>> 0;
    return f64[0];
}
const FRSQRTE_BASE = new Int32Array([
    0x3ffa000, 0x3c29000, 0x38aa000, 0x3572000, 0x3279000, 0x2fb7000, 0x2d26000, 0x2ac0000,
    0x2881000, 0x2665000, 0x2468000, 0x2287000, 0x20c1000, 0x1f12000, 0x1d79000, 0x1bf4000,
    0x1a7e800, 0x17cb800, 0x1552800, 0x130c000, 0x10f2000, 0x0eff000, 0x0d2e000, 0x0b7c000,
    0x09e5000, 0x0867000, 0x06ff000, 0x05ab800, 0x046a000, 0x0339800, 0x0218800, 0x0105800]);
const FRSQRTE_DEC = new Int32Array([
    0x7a4, 0x700, 0x670, 0x5f2, 0x584, 0x524, 0x4cc, 0x47e, 0x43a, 0x3fa, 0x3c2, 0x38e, 0x35e, 0x332, 0x30a, 0x2e6,
    0x568, 0x4f3, 0x48d, 0x435, 0x3e7, 0x3a2, 0x365, 0x32e, 0x2fc, 0x2d0, 0x2a8, 0x283, 0x261, 0x243, 0x226, 0x20b]);
/** frsqrte: the reciprocal square root estimate (ApproximateReciprocalSquareRoot), a double */
export function frsqrte(v: number): number {
    f64[0] = v;
    let hi = w64[1], lo = w64[0];
    const sign = hi & 0x80000000;
    let exp = (hi >>> 20) & 0x7FF, mhi = hi & 0xFFFFF;
    if (exp === 0 && (mhi | lo) === 0) return sign ? -Infinity : Infinity;
    if (exp === 0x7FF) { if ((mhi | lo) === 0) return sign ? NaN : 0; return v + 0; }
    if (sign) return NaN;
    if (exp === 0) {   // a denormal: normalised first
        do { exp--; mhi = ((mhi << 1) | (lo >>> 31)) >>> 0; lo = (lo << 1) >>> 0; } while (!(mhi & 0x100000));
        mhi &= 0xFFFFF; exp++;
    }
    const odd = !(exp & 1);
    const i = mhi >>> 5, k = (i >>> 11) + (odd ? 16 : 0);
    const val = FRSQRTE_BASE[k] - FRSQRTE_DEC[k] * (i & 2047);
    w64[1] = ((((3068 - exp) >> 1) & 0x7FF) << 20 | (val >>> 6)) >>> 0; w64[0] = (val << 26) >>> 0;
    return f64[0];
}
