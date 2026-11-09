// v3: the Gekko's floating point: fused multiply-adds rounded once, the 25-bit frC of single
// multiplies, and the fres / frsqrte estimate tables (from v2's player/fmath.ts, checked against the DOL).

export const fr = Math.fround;

const f32b = new Float32Array(1), u32b = new Uint32Array(f32b.buffer);
/** the f32 next to r (an f32) in the direction of t */
function f32Toward(r: number, t: number): number {
    if (r === 0) return t > 0 ? 1.401298464324817e-45 : -1.401298464324817e-45;
    f32b[0] = r; u32b[0] += (t > r) === (r > 0) ? 1 : -1; return f32b[0];
}
/** hi + lo (|lo| <= half an ulp of hi) rounded once to f32 */
function roundF32(hi: number, lo: number): number {
    const r = fr(hi);
    if (lo === 0 || r === hi || !isFinite(r)) return r;
    const o = f32Toward(r, hi);
    if (hi !== (r + o) / 2) return r;   // not a halfway point: the double rounding was harmless
    return (lo > 0) === (o > r) ? o : r;
}
function fusedSum(a: number, b: number, c: number): number[] {
    const [p, e] = twoProd(a, b);
    const s = p + c, bb = s - p, err = (p - (s - bb)) + (c - bb);
    const lo = err + e, hi = s + lo;
    return [hi, lo - (hi - s)];
}
// ---------------------------------------------------------------- exact double fused multiply-add
const SPLIT = 134217729;   // 2^27 + 1
/** a * b as hi + lo exactly (Dekker) */
function twoProd(a: number, b: number): [number, number] {
    const p = a * b;
    let t = SPLIT * a; const ah = t - (t - a), al = a - ah;
    t = SPLIT * b; const bh = t - (t - b), bl = b - bh;
    return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl];
}

// ---------------------------------------------------------------- fres / frsqrte
const fbuf = new Float64Array(1), ibuf = new BigInt64Array(fbuf.buffer);
const FRES_T = [
    [0x7ff800, 0x3e1], [0x783800, 0x3a7], [0x70ea00, 0x371], [0x6a0800, 0x340], [0x638800, 0x313], [0x5d6200, 0x2ea], [0x579000, 0x2c4], [0x520800, 0x2a0],
    [0x4cc800, 0x27f], [0x47ca00, 0x261], [0x430800, 0x245], [0x3e8000, 0x22a], [0x3a2c00, 0x212], [0x360800, 0x1fb], [0x321400, 0x1e5], [0x2e4a00, 0x1d1],
    [0x2aa800, 0x1be], [0x272c00, 0x1ac], [0x23d600, 0x19b], [0x209e00, 0x18b], [0x1d8800, 0x17c], [0x1a9000, 0x16e], [0x17ae00, 0x15b], [0x14f800, 0x15b],
    [0x124400, 0x143], [0x0fbe00, 0x143], [0x0d3800, 0x12d], [0x0ade00, 0x12d], [0x088400, 0x11a], [0x065000, 0x11a], [0x041c00, 0x108], [0x020c00, 0x106],
];
const FRSQRTE_T = [
    [0x1a7e800, -0x568], [0x17cb800, -0x4f3], [0x1552800, -0x48d], [0x130c000, -0x435], [0x10f2000, -0x3e7], [0x0eff000, -0x3a2], [0x0d2e000, -0x365], [0x0b7c000, -0x32e],
    [0x09e5000, -0x2fc], [0x0867000, -0x2d0], [0x06ff000, -0x2a8], [0x05ab800, -0x283], [0x046a000, -0x261], [0x0339800, -0x243], [0x0218800, -0x226], [0x0105800, -0x20b],
    [0x3ffa000, -0x7a4], [0x3c29000, -0x700], [0x38aa000, -0x670], [0x3572000, -0x5f2], [0x3279000, -0x584], [0x2fb7000, -0x524], [0x2d26000, -0x4cc], [0x2ac0000, -0x47e],
    [0x2881000, -0x43a], [0x2665000, -0x3fa], [0x2468000, -0x3c2], [0x2287000, -0x38e], [0x20c1000, -0x35e], [0x1f12000, -0x332], [0x1d79000, -0x30a], [0x1bf4000, -0x2e6],
];
const M52 = (1n << 52n) - 1n, EXPM = 0x7FFn << 52n, SIGN = 1n << 63n;
/** fres: the reciprocal estimate */
export function fres(v: number): number {
    if (v === 0) return Object.is(v, -0) ? -Infinity : Infinity;
    if (!isFinite(v)) return v !== v ? v : (v > 0 ? 0 : -0);
    fbuf[0] = v;
    const bits = ibuf[0], mant = bits & M52, sign = bits & SIGN;
    let exp = bits & EXPM;
    if (exp < (895n << 52n)) return v < 0 ? -3.4028234663852886e38 : 3.4028234663852886e38;
    if (exp >= (1149n << 52n)) return v < 0 ? -0 : 0;
    exp = (0x7FDn << 52n) - exp;
    const i = Number(mant >> 37n), e = FRES_T[i >> 10];
    ibuf[0] = sign | exp | (BigInt(e[0] - Math.trunc((e[1] * (i % 1024) + 1) / 2)) << 29n);
    return fbuf[0];
}
/** frsqrte: the reciprocal square root estimate (a double) */
export function frsqrte(v: number): number {
    if (v === 0) return Object.is(v, -0) ? -Infinity : Infinity;
    if (v !== v) return v;
    if (v < 0) return NaN;
    if (v === Infinity) return 0;
    fbuf[0] = v;
    let mant = ibuf[0] & M52, exp = ibuf[0] & EXPM;
    if (exp === 0n) { do { exp -= 1n << 52n; mant <<= 1n; } while (!(mant & (1n << 52n))); mant &= M52; exp += 1n << 52n; }
    const lsb = exp & (1n << 52n);
    exp = ((0x3FFn << 52n) - ((exp - (0x3FEn << 52n)) / 2n)) & EXPM;
    const i = Number((lsb | mant) >> 37n), e = FRSQRTE_T[Math.trunc(i / 2048)];
    ibuf[0] = exp | (BigInt(e[0] + e[1] * (i % 2048)) << 26n);
    return fbuf[0];
}

/**
 * MsSqrtf (MarioUtil/MathUtil.hpp): frsqrte and one Newton step in double, then x * guess
 * rounded to f32 (frsp); x itself for x <= 0. About 1 ulp off a true square root.
 */

/** a * c + b, rounded once to double (fmadd) */
export function maddD(a: number, c: number, b: number) { return fusedSum(a, c, b)[0]; }
/** a * c + b, rounded once to single (fmadds) */
export function maddS(a: number, c: number, b: number) { const [h, l] = fusedSum(a, c, b); return roundF32(h, l); }

// Force25Bit (Dolphin, from hardware tests): a single multiply's frC keeps 25 bits of its mantissa, rounded
const f64 = new Float64Array(1), w = new Uint32Array(f64.buffer);
export function force25(d: number) {
    f64[0] = d;
    const lo = w[0], keep = (lo & 0xF8000000) >>> 0, round = lo & 0x08000000;
    let nlo = keep + round, hi = w[1];
    if (nlo >= 0x100000000) { nlo -= 0x100000000; hi = (hi + 1) >>> 0; }
    w[0] = nlo; w[1] = hi;
    return f64[0];
}
