// The game's maths (MarioUtil/MathUtil.cpp, JMath, MSL rand), from the decomp. The game works
// in degrees, through 16-bit binary angles into a 4096-entry sine table (JMANewSinTable(12)),
// and an arctangent table (matan); these are reproduced, since enemies' turns and paths follow
// from them.

export const fr = Math.fround;

// ---------------------------------------------------------------- MSL rand (MSL_Common/rand.c)
let next = 1;
/**
 * Replaying a ghost's RNG tape: cur is the object performing (JDrama::TViewObj::testPerform), roll
 * gives the number the game's rand() returned for it there (null: none recorded, the sim's own
 * LCG answers), node a graph node a Moonshine RNG control chose for it.
 */
export const rngCtx: { cur: object | null; roll: ((who: object | null) => number | null) | null; node: ((who: object | null) => number | null) | null } = { cur: null, roll: null, node: null };
export function rand(): number {
    if (rngCtx.roll) { const v = rngCtx.roll(rngCtx.cur); if (v !== null) return v; }
    next = (Math.imul(0x41C64E6D, next) + 12345) >>> 0;
    return (next >>> 16) & 0x7FFF;
}
export function srand(seed: number) { next = seed >>> 0; }
export function randState() { return next; }
/** MsRandF (RandomUtil.hpp): rand() / 32768. */
export const MsRandF = (l = 0, r = 1) => fr(rand() * (1 / 32768) * (r - l) + l);
/** MsRandI */
export const MsRandI = (l: number, r: number) => 1 + l + Math.trunc(rand() * (1 / 32768) * (r - l));

// ---------------------------------------------------------------- sine table (JMath)
const SIN_SHIFT = 16 - 12;
// JMANewSinTable: sinf(2pi / size * i) for size + size / 4 entries; the cosine table is the same one a quarter in.
const sinAll = new Float32Array(4096 + 1024);
for (let i = 0; i < sinAll.length; i++) sinAll[i] = Math.sin(fr(fr(Math.PI * 2) / 4096) * i);
const sinT = sinAll.subarray(0, 4096), cosT = sinAll.subarray(1024);
/** (s16) of a float, as fctiwz then a 16-bit truncation does it. */
export const s16 = (v: number) => (Math.trunc(v) << 16) >> 16;
export const JMASSin = (a: number) => sinT[(a & 0xFFFF) >>> SIN_SHIFT];
export const JMASCos = (a: number) => cosT[(a & 0xFFFF) >>> SIN_SHIFT];
export const MsSin = (deg: number) => JMASSin(s16(deg * (65536 / 360)));
export const MsCos = (deg: number) => JMASCos(s16(deg * (65536 / 360)));

// ---------------------------------------------------------------- matan
const ATN = new Uint16Array([0, 10, 20, 31, 41, 51, 61, 71, 81, 92, 102, 112, 122, 132, 143, 153, 163, 173, 183, 194, 204, 214, 224, 234,
    244, 255, 265, 275, 285, 295, 305, 316, 326, 336, 346, 356, 367, 377, 387, 397, 407, 417, 428, 438, 448, 458, 468, 478,
    489, 499, 509, 519, 529, 539, 550, 560, 570, 580, 590, 600, 610, 621, 631, 641, 651, 661, 671, 681, 692, 702, 712, 722,
    732, 742, 752, 763, 773, 783, 793, 803, 813, 823, 833, 844, 854, 864, 874, 884, 894, 904, 914, 924, 935, 945, 955, 965,
    975, 985, 995, 1005, 1015, 1025, 1036, 1046, 1056, 1066, 1076, 1086, 1096, 1106, 1116, 1126, 1136, 1146, 1156, 1166, 1177, 1187, 1197, 1207,
    1217, 1227, 1237, 1247, 1257, 1267, 1277, 1287, 1297, 1307, 1317, 1327, 1337, 1347, 1357, 1367, 1377, 1387, 1397, 1407, 1417, 1427, 1437, 1447,
    1457, 1467, 1477, 1487, 1497, 1507, 1517, 1527, 1537, 1547, 1557, 1567, 1577, 1587, 1597, 1607, 1617, 1627, 1637, 1646, 1656, 1666, 1676, 1686,
    1696, 1706, 1716, 1726, 1736, 1746, 1756, 1765, 1775, 1785, 1795, 1805, 1815, 1825, 1835, 1845, 1854, 1864, 1874, 1884, 1894, 1904, 1914, 1923,
    1933, 1943, 1953, 1963, 1973, 1982, 1992, 2002, 2012, 2022, 2031, 2041, 2051, 2061, 2071, 2080, 2090, 2100, 2110, 2120, 2129, 2139, 2149, 2159,
    2168, 2178, 2188, 2198, 2207, 2217, 2227, 2237, 2246, 2256, 2266, 2275, 2285, 2295, 2305, 2314, 2324, 2334, 2343, 2353, 2363, 2372, 2382, 2392,
    2401, 2411, 2421, 2430, 2440, 2450, 2459, 2469, 2478, 2488, 2498, 2507, 2517, 2526, 2536, 2546, 2555, 2565, 2574, 2584, 2594, 2603, 2613, 2622,
    2632, 2641, 2651, 2660, 2670, 2679, 2689, 2699, 2708, 2718, 2727, 2737, 2746, 2756, 2765, 2775, 2784, 2793, 2803, 2812, 2822, 2831, 2841, 2850,
    2860, 2869, 2879, 2888, 2897, 2907, 2916, 2926, 2935, 2944, 2954, 2963, 2973, 2982, 2991, 3001, 3010, 3019, 3029, 3038, 3047, 3057, 3066, 3075,
    3085, 3094, 3103, 3113, 3122, 3131, 3141, 3150, 3159, 3168, 3178, 3187, 3196, 3206, 3215, 3224, 3233, 3243, 3252, 3261, 3270, 3279, 3289, 3298,
    3307, 3316, 3325, 3335, 3344, 3353, 3362, 3371, 3380, 3390, 3399, 3408, 3417, 3426, 3435, 3444, 3453, 3463, 3472, 3481, 3490, 3499, 3508, 3517,
    3526, 3535, 3544, 3553, 3562, 3571, 3580, 3589, 3599, 3608, 3617, 3626, 3635, 3644, 3653, 3662, 3670, 3679, 3688, 3697, 3706, 3715, 3724, 3733,
    3742, 3751, 3760, 3769, 3778, 3787, 3796, 3804, 3813, 3822, 3831, 3840, 3849, 3858, 3867, 3875, 3884, 3893, 3902, 3911, 3920, 3928, 3937, 3946,
    3955, 3964, 3972, 3981, 3990, 3999, 4007, 4016, 4025, 4034, 4042, 4051, 4060, 4069, 4077, 4086, 4095, 4103, 4112, 4121, 4129, 4138, 4147, 4155,
    4164, 4173, 4181, 4190, 4199, 4207, 4216, 4224, 4233, 4242, 4250, 4259, 4267, 4276, 4284, 4293, 4302, 4310, 4319, 4327, 4336, 4344, 4353, 4361,
    4370, 4378, 4387, 4395, 4404, 4412, 4421, 4429, 4438, 4446, 4454, 4463, 4471, 4480, 4488, 4497, 4505, 4513, 4522, 4530, 4539, 4547, 4555, 4564,
    4572, 4580, 4589, 4597, 4605, 4614, 4622, 4630, 4639, 4647, 4655, 4663, 4672, 4680, 4688, 4697, 4705, 4713, 4721, 4730, 4738, 4746, 4754, 4762,
    4771, 4779, 4787, 4795, 4803, 4812, 4820, 4828, 4836, 4844, 4852, 4860, 4869, 4877, 4885, 4893, 4901, 4909, 4917, 4925, 4933, 4941, 4949, 4958,
    4966, 4974, 4982, 4990, 4998, 5006, 5014, 5022, 5030, 5038, 5046, 5054, 5062, 5070, 5078, 5086, 5094, 5101, 5109, 5117, 5125, 5133, 5141, 5149,
    5157, 5165, 5173, 5181, 5188, 5196, 5204, 5212, 5220, 5228, 5235, 5243, 5251, 5259, 5267, 5275, 5282, 5290, 5298, 5306, 5313, 5321, 5329, 5337,
    5344, 5352, 5360, 5368, 5375, 5383, 5391, 5398, 5406, 5414, 5421, 5429, 5437, 5444, 5452, 5460, 5467, 5475, 5483, 5490, 5498, 5505, 5513, 5521,
    5528, 5536, 5543, 5551, 5559, 5566, 5574, 5581, 5589, 5596, 5604, 5611, 5619, 5626, 5634, 5641, 5649, 5656, 5664, 5671, 5679, 5686, 5694, 5701,
    5708, 5716, 5723, 5731, 5738, 5745, 5753, 5760, 5768, 5775, 5782, 5790, 5797, 5804, 5812, 5819, 5826, 5834, 5841, 5848, 5856, 5863, 5870, 5878,
    5885, 5892, 5899, 5907, 5914, 5921, 5928, 5936, 5943, 5950, 5957, 5964, 5972, 5979, 5986, 5993, 6000, 6008, 6015, 6022, 6029, 6036, 6043, 6050,
    6058, 6065, 6072, 6079, 6086, 6093, 6100, 6107, 6114, 6121, 6128, 6135, 6142, 6150, 6157, 6164, 6171, 6178, 6185, 6192, 6199, 6206, 6213, 6220,
    6227, 6234, 6240, 6247, 6254, 6261, 6268, 6275, 6282, 6289, 6296, 6303, 6310, 6317, 6323, 6330, 6337, 6344, 6351, 6358, 6365, 6371, 6378, 6385,
    6392, 6399, 6406, 6412, 6419, 6426, 6433, 6440, 6446, 6453, 6460, 6467, 6473, 6480, 6487, 6493, 6500, 6507, 6514, 6520, 6527, 6534, 6540, 6547,
    6554, 6560, 6567, 6574, 6580, 6587, 6594, 6600, 6607, 6613, 6620, 6627, 6633, 6640, 6646, 6653, 6660, 6666, 6673, 6679, 6686, 6692, 6699, 6705,
    6712, 6718, 6725, 6731, 6738, 6744, 6751, 6757, 6764, 6770, 6777, 6783, 6790, 6796, 6803, 6809, 6815, 6822, 6828, 6835, 6841, 6848, 6854, 6860,
    6867, 6873, 6879, 6886, 6892, 6898, 6905, 6911, 6917, 6924, 6930, 6936, 6943, 6949, 6955, 6962, 6968, 6974, 6980, 6987, 6993, 6999, 7005, 7012,
    7018, 7024, 7030, 7037, 7043, 7049, 7055, 7061, 7068, 7074, 7080, 7086, 7092, 7098, 7105, 7111, 7117, 7123, 7129, 7135, 7141, 7147, 7154, 7160,
    7166, 7172, 7178, 7184, 7190, 7196, 7202, 7208, 7214, 7220, 7226, 7232, 7238, 7244, 7250, 7256, 7262, 7268, 7274, 7280, 7286, 7292, 7298, 7304,
    7310, 7316, 7322, 7328, 7334, 7340, 7346, 7352, 7358, 7363, 7369, 7375, 7381, 7387, 7393, 7399, 7405, 7411, 7416, 7422, 7428, 7434, 7440, 7446,
    7451, 7457, 7463, 7469, 7475, 7480, 7486, 7492, 7498, 7503, 7509, 7515, 7521, 7526, 7532, 7538, 7544, 7549, 7555, 7561, 7566, 7572, 7578, 7584,
    7589, 7595, 7601, 7606, 7612, 7618, 7623, 7629, 7635, 7640, 7646, 7651, 7657, 7663, 7668, 7674, 7679, 7685, 7691, 7696, 7702, 7707, 7713, 7718,
    7724, 7730, 7735, 7741, 7746, 7752, 7757, 7763, 7768, 7774, 7779, 7785, 7790, 7796, 7801, 7807, 7812, 7818, 7823, 7828, 7834, 7839, 7845, 7850,
    7856, 7861, 7866, 7872, 7877, 7883, 7888, 7893, 7899, 7904, 7910, 7915, 7920, 7926, 7931, 7936, 7942, 7947, 7952, 7958, 7963, 7968, 7974, 7979,
    7984, 7990, 7995, 8000, 8005, 8011, 8016, 8021, 8026, 8032, 8037, 8042, 8047, 8053, 8058, 8063, 8068, 8074, 8079, 8084, 8089, 8094, 8100, 8105,
    8110, 8115, 8120, 8125, 8131, 8136, 8141, 8146, 8151, 8156, 8161, 8166, 8172, 8177, 8182, 8187, 8192]);
// The index is fctiwz(fmadds(1024, fmuls(b, fres(a)), 0.5)): __fres is the Gekko's reciprocal
// estimate (about 12 bits), so the index is often one off what an exact 1 / a gives.
const atanT = (a: number, b: number) => (a === 0 ? ATN[0] : ATN[Math.trunc(fr(fr(b * fres(a)) * 1024 + 0.5))]);

// ---------------------------------------------------------------- Gekko estimates (fres, frsqrte)
// Bit-exact, as Dolphin has them from the hardware (Common/FloatUtils.cpp: ApproximateReciprocal,
// ApproximateReciprocalSquareRoot).
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
/** fres: the Gekko's reciprocal estimate (an f32). */
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
/** frsqrte: the Gekko's reciprocal square root estimate (a double). */
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
/** MsSqrtf (MathUtil.hpp): frsqrte and one Newton step in double, then frsp; 0 for x <= 0. */
export function MsSqrtfHW(x: number): number {
    if (!(x > 0)) return x;
    const e = frsqrte(x);
    return fr(x * ((0.5 * e) * (3 - x * (e * e))));
}
/** matan(x, y): atan2(y, x) as a signed 16-bit binary angle. */
export function matan(x: number, y: number): number {
    let r: number;
    if (y >= 0) {
        if (x >= 0) r = x >= y ? atanT(x, y) : 0x4000 - atanT(y, x);
        else { x = -x; r = x < y ? 0x4000 + atanT(y, x) : 0x8000 - atanT(x, y); }
    } else {
        y = -y;
        if (x < 0) { x = -x; r = x >= y ? 0x8000 + atanT(x, y) : 0xC000 - atanT(y, x); }
        else r = x < y ? 0xC000 + atanT(y, x) : 0x0000 - atanT(x, y);
    }
    return ((r & 0xFFFF) << 16) >> 16;
}

// ---------------------------------------------------------------- vectors (JGeometry::TVec3<f32>)
export class V3 {
    constructor(public x = 0, public y = 0, public z = 0) { }
    set(x: number | V3, y?: number, z?: number) { if (x instanceof V3) { this.x = x.x; this.y = x.y; this.z = x.z; } else { this.x = x; this.y = y!; this.z = z!; } return this; }
    setAll(v: number) { this.x = this.y = this.z = v; return this; }
    zero() { this.x = this.y = this.z = 0; return this; }
    clone() { return new V3(this.x, this.y, this.z); }
    add(v: V3) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    sub(v: V3) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    scale(s: number) { this.x *= s; this.y *= s; this.z *= s; return this; }
    dot(v: V3) { return this.x * v.x + this.y * v.y + this.z * v.z; }
    squared() { return this.x * this.x + this.y * this.y + this.z * this.z; }
    length() { return Math.sqrt(this.squared()); }
    normalize() { const l = this.length(); if (l > 0) this.scale(1 / l); return this; }
    cross(a: V3, b: V3) { const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x; this.x = x; this.y = y; this.z = z; return this; }
    static sub(a: V3, b: V3) { return new V3(a.x - b.x, a.y - b.y, a.z - b.z); }
    static add(a: V3, b: V3) { return new V3(a.x + b.x, a.y + b.y, a.z + b.z); }
    arr(): number[] { return [this.x, this.y, this.z]; }
    /** to f32 */
    fround() { this.x = Math.fround(this.x); this.y = Math.fround(this.y); this.z = Math.fround(this.z); return this; }
}
/** PSVECSquareDistance */
export const sqDist = (a: V3, b: V3) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

// ---------------------------------------------------------------- MathUtil.hpp
export function MsWrap(t: number, l: number, r: number) {
    if (l >= r) return l;
    while (t >= r) t -= r - l;
    while (t < l) t += r - l;
    return t;
}
export const MsClamp = (t: number, l: number, r: number) => (t < l ? l : t > r ? r : t);
export const MsAngleDiff = (a: number, b: number) => a - MsWrap(b, a - 180, a + 180);
export const MsAngleWrap = (a: number) => MsWrap(a, 0, 360);
export function MsGetRotFromZaxisY(v: V3) {
    if (v.z === 0) return v.x >= 0 ? 90 : -90;
    if (v.z >= 0) return (360 / 65536) * matan(v.z, v.x);
    return 180 - matan(-v.z, v.x) * (360 / 65536);
}
/** MsGetRotFromZaxis: the (x, y) rotation in degrees turning +Z to v. */
export function MsGetRotFromZaxis(v: V3) {
    const a = v.clone().normalize();
    const r = new V3();
    if (a.y === 1) r.x = 90; else if (a.y === -1) r.x = -90; else r.x = -(matan(Math.sqrt(1 - a.y * a.y), a.y) * (360 / 65536));
    if (a.z === 0) r.y = a.x > 0 ? 90 : -90;
    else if (a.z > 0) r.y = (360 / 65536) * matan(a.z, a.x);
    else r.y = 180 - matan(-a.z, a.x) * (360 / 65536);
    return r;
}
export const MsAtan2 = (y: number, x: number) => Math.abs(matan(y, x) * (360 / 65536));
export function MsIsInSight(eye: V3, sight: number, target: V3, length: number, angle: number, aware: number) {
    const t = V3.sub(target, eye);
    if (t.squared() < aware * aware) return true;
    return t.squared() < length * length && Math.abs(MsAngleDiff(MsGetRotFromZaxisY(t), sight)) < angle * 0.5;
}
export function IConverge(v: number, t: number, inc: number, dec: number) {
    if (v < t) { v += inc; if (v > t) v = t; } else { v -= dec; if (v < t) v = t; }
    return v;
}
export const FConverge = IConverge;

/** A 3x4 matrix, row-major as the game's Mtx (m[r * 4 + c]). */
export type Mtx = Float64Array;
export const mtx = () => { const m = new Float64Array(12); m[0] = m[5] = m[10] = 1; return m; };
export function MsMtxSetRotRPH(m: Mtx, r: number, p: number, h: number) {
    const sr = MsSin(r), sp = MsSin(p), sh = MsSin(h), cr = MsCos(r), cp = MsCos(p), ch = MsCos(h);
    m[0] = ch * cp; m[4] = sh * cp; m[8] = -sp;
    m[1] = sr * (ch * sp) - sh * cr; m[5] = sr * (sh * sp) + ch * cr; m[9] = cp * sr;
    m[2] = cr * (ch * sp) + sh * sr; m[6] = cr * (sh * sp) - ch * sr; m[10] = cp * cr;
    m[3] = m[7] = m[11] = 0;
}
/** MsMtxSetXYZRPH (the s16 angles from degrees) */
export function MsMtxSetXYZRPH(m: Mtx, x: number, y: number, z: number, rd: number, pd: number, hd: number) {
    const r = s16(rd * (65536 / 360)), p = s16(pd * (65536 / 360)), h = s16(hd * (65536 / 360));
    const sr = JMASSin(r), sp = JMASSin(p), sh = JMASSin(h), cr = JMASCos(r), cp = JMASCos(p), ch = JMASCos(h);
    m[8] = -sp; m[0] = ch * cp; m[4] = sh * cp; m[9] = cp * sr; m[10] = cp * cr;
    const crsh = cr * sh, srch = sr * ch, srsh = sr * sh, crch = cr * ch;
    m[1] = srch * sp - crsh; m[6] = crsh * sp - srch; m[2] = crch * sp + srsh; m[5] = srsh * sp + crch;
    m[3] = x; m[7] = y; m[11] = z;
}
export function mtxMultVec(m: Mtx, v: V3, out = new V3()) {
    const x = m[0] * v.x + m[1] * v.y + m[2] * v.z + m[3], y = m[4] * v.x + m[5] * v.y + m[6] * v.z + m[7], z = m[8] * v.x + m[9] * v.y + m[10] * v.z + m[11];
    return out.set(x, y, z);
}
export function mtxInverse(m: Mtx, out: Mtx = new Float64Array(12)) {
    // affine inverse of a 3x4 (rotation/scale + translation)
    const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (det === 0) return out.set(m), out;
    const id = 1 / det;
    const r = [A * id, -(b * i - c * h) * id, (b * f - c * e) * id, B * id, (a * i - c * g) * id, -(a * f - c * d) * id, C * id, -(a * h - b * g) * id, (a * e - b * d) * id];
    out[0] = r[0]; out[1] = r[1]; out[2] = r[2]; out[4] = r[3]; out[5] = r[4]; out[6] = r[5]; out[8] = r[6]; out[9] = r[7]; out[10] = r[8];
    const tx = m[3], ty = m[7], tz = m[11];
    out[3] = -(out[0] * tx + out[1] * ty + out[2] * tz); out[7] = -(out[4] * tx + out[5] * ty + out[6] * tz); out[11] = -(out[8] * tx + out[9] * ty + out[10] * tz);
    return out;
}

/** SMSCalcJumpVelocityY */
export function SMSCalcJumpVelocityY(desired: V3, initial: V3, vy: number, g: number, minY: number) {
    let y = initial.y, ticks = 1;
    for (let s = vy; ; ) { y += s; if (s < 0 && y <= desired.y) break; s -= g; if (s < minY) s = minY; ++ticks; }
    const k = 1 / ticks;
    return new V3((desired.x - initial.x) * k, vy, (desired.z - initial.z) * k);
}

/** JGeometry::TQuat4<f32> */
export class Quat {
    constructor(public x = 0, public y = 0, public z = 0, public w = 1) { }
    set(q: Quat) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
    set4(x: number, y: number, z: number, w: number) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
    clone() { return new Quat(this.x, this.y, this.z, this.w); }
    dot(q: Quat) { return this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w; }
    normalize() { const l = Math.sqrt(this.dot(this)); this.x /= l; this.y /= l; this.z /= l; this.w /= l; return this; }
    mul(a: Quat, b: Quat) {
        const x = a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y, y = a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z;
        const z = a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x, w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
        return this.set4(x, y, z, w);
    }
    getZDir(out = new V3()) { return out.set(this.x * this.z * 2 + this.w * this.y * 2, this.y * this.z * 2 - this.w * this.x * 2, 1 - this.x * this.x * 2 - this.y * this.y * 2); }
    setRotateAxis(v: V3, a: number) { const s = Math.sin(a * 0.5); this.x = v.x * s; this.y = v.y * s; this.z = v.z * s; this.w = Math.cos(a * 0.5); return this; }
    setRotateFromTo(from: V3, to: V3, amount = 1) {
        const ax = new V3().cross(from, to), len = ax.length();
        if (len <= 1.1920929e-7) return this.set4(0, 0, 0, 1);
        const h = 0.5 * Math.atan2(len, from.dot(to)) * amount, k = Math.sin(h) / len;
        return this.set4(ax.x * k, ax.y * k, ax.z * k, Math.cos(h));
    }
    slerp(a: Quat, b: Quat, t: number) {
        const q1 = a.clone().normalize(), q2 = b.clone().normalize();
        let d = q1.dot(q2), neg = false;
        if (d < 0) { neg = true; d = -d; }
        let k1: number;
        if (1 - d <= 1.1920929e-7) k1 = 1 - t;
        else { const o = Math.acos(d), s = Math.sin(o); k1 = Math.sin((1 - t) * o) / s; t = Math.sin(t * o) / s; }
        if (neg) t = -t;
        return this.set4(k1 * q1.x + t * q2.x, k1 * q1.y + t * q2.y, k1 * q1.z + t * q2.z, k1 * q1.w + t * q2.w);
    }
    /** TPosition3::setQT: the rotation into m (3x4 row-major), translation t */
    toMtx(m: Mtx, t: V3) {
        const { x, y, z, w } = this;
        m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y - w * z); m[2] = 2 * (x * z + w * y); m[3] = t.x;
        m[4] = 2 * (x * y + w * z); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z - w * x); m[7] = t.y;
        m[8] = 2 * (x * z - w * y); m[9] = 2 * (y * z + w * x); m[10] = 1 - 2 * (x * x + y * y); m[11] = t.z;
        return m;
    }
}

/** JMAHermiteInterpolation */
export function JMAHermiteInterpolation(frame: number, t0: number, v0: number, tan0: number, t1: number, v1: number, tan1: number) {
    const f = Math.fround;
    const len = f(t1 - t0), f9 = f(frame - t0), f1 = f(1 / len), f2 = f(f(f9 * f9) * f1), f10 = f(f2 * f1), f11 = f(f9 * f10), f12 = f(f11 * f1);
    return f(f(f(v0 * f(1 + f(f(2 * f12) - f(3 * f10)))) + f(v1 * f(f(-2 * f12) + f(3 * f10)))) + f(f(tan0 * f(f9 + f(f11 - f(2 * f2)))) + f(tan1 * f(f11 - f2))));
}
