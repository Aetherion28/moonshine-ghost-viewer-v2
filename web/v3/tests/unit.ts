// v3: the interpreter against independent references.
//   integer instructions: random operands against a BigInt model written from the PowerPC manual;
//   fused multiply-add: against exact rational arithmetic in BigInt, rounded to nearest-even;
//   fres / frsqrte: against v2's implementations (BigInt bit manipulation of Dolphin's algorithm).
// Run: npx esbuild v3/tests/unit.ts --bundle --platform=node --format=esm --outfile=/tmp/v3unit.mjs && node /tmp/v3unit.mjs
import { Memory } from '../ppc/mem.ts';
import { Cpu } from '../ppc/cpu.ts';
import { fmaD, fmaS, fres, frsqrte, force25, trunc25, doubleToSingleBits, singleToDoubleBits, f32Bits } from '../ppc/fpu.ts';
import { fres as fresV2, frsqrte as frsqrteV2 } from '../../src/game/player/fmath.ts';

let seed = 0x1234567;
const rnd32 = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed; };
/** operands that hit the edges often */
const EDGE = [0, 1, 2, 0x7FFFFFFF, 0x80000000, 0x80000001, 0xFFFFFFFF, 0xFFFFFFFE, 0xFFFF, 0x10000, 0x8000, 0xFFFF8000, 31, 32, 33, 63, 64];
const operand = () => (rnd32() % 4 === 0 ? EDGE[rnd32() % EDGE.length] : rnd32() % 3 === 0 ? rnd32() >>> (rnd32() % 32) : rnd32());

let fails = 0, checks = 0;
function expect(what: string, got: number | bigint, want: number | bigint) {
    checks++;
    if (got !== want && !(typeof got === 'number' && got !== got && want !== want)) { if (fails++ < 25) console.log('FAIL', what, 'got', typeof got === 'number' ? got.toString(16) : got, 'want', typeof want === 'number' ? want.toString(16) : want); }
}

// ---------------------------------------------------------------- integer
const mem = new Memory(), cpu = new Cpu(mem);
cpu.setMsr(0x2032);
const CODE = 0x80010000;
function run1(ins: number) { mem.w32(CODE, ins >>> 0); cpu.pc = CODE; cpu.run(cpu.count + 1); }
const X = (xo: number, d: number, a: number, b: number, rc = 0, oe = 0) => ((31 << 26) | (d << 21) | (a << 16) | (b << 11) | (oe << 10) | (xo << 1) | rc) >>> 0;
const D = (op: number, d: number, a: number, imm: number) => ((op << 26) | (d << 21) | (a << 16) | (imm & 0xFFFF)) >>> 0;
const M32 = 0xFFFFFFFFn;
const s32 = (v: bigint) => BigInt.asIntN(32, v), u32 = (v: bigint) => BigInt.asUintN(32, v);
const cr0 = (r: bigint, so: number) => { const s = s32(r); return (s < 0n ? 8 : s > 0n ? 4 : 2) | so; };

for (let t = 0; t < 200000; t++) {
    const a = operand(), b = operand(), ca = rnd32() & 1;
    const A = BigInt(a), B = BigInt(b), C = BigInt(ca);
    const set = () => { cpu.gpr[3] = a; cpu.gpr[4] = b; cpu.gpr[5] = 0xDEADBEEF; cpu.xer = ca << 29; cpu.cr = 0; };
    // [name, instruction, result register, expected result, expected CA (or -1), expected OV (or -1)]
    const ovAdd = (x: bigint, y: bigint, c: bigint) => { const r = s32(x) + s32(y) + c; return r > 0x7FFFFFFFn || r < -0x80000000n ? 1 : 0; };
    const cases: [string, number, number, bigint, number, number][] = [
        ['add', X(266, 5, 3, 4, 1, 1), 5, u32(A + B), -1, ovAdd(A, B, 0n)],
        ['addc', X(10, 5, 3, 4, 1, 1), 5, u32(A + B), Number((A + B) >> 32n), ovAdd(A, B, 0n)],
        ['adde', X(138, 5, 3, 4, 1, 1), 5, u32(A + B + C), Number((A + B + C) >> 32n), ovAdd(A, B, C)],
        ['addze', X(202, 5, 3, 0, 1, 1), 5, u32(A + C), Number((A + C) >> 32n), ovAdd(A, 0n, C)],
        ['addme', X(234, 5, 3, 0, 1, 1), 5, u32(A + M32 + C), Number((A + M32 + C) >> 32n), ovAdd(A, M32, C)],
        ['subf', X(40, 5, 3, 4, 1, 1), 5, u32(B - A), -1, ovAdd(u32(~A), B, 1n)],
        ['subfc', X(8, 5, 3, 4, 1, 1), 5, u32(B - A), Number((u32(~A) + B + 1n) >> 32n), ovAdd(u32(~A), B, 1n)],
        ['subfe', X(136, 5, 3, 4, 1, 1), 5, u32(u32(~A) + B + C), Number((u32(~A) + B + C) >> 32n), ovAdd(u32(~A), B, C)],
        ['subfze', X(200, 5, 3, 0, 1, 1), 5, u32(u32(~A) + C), Number((u32(~A) + C) >> 32n), ovAdd(u32(~A), 0n, C)],
        ['subfme', X(232, 5, 3, 0, 1, 1), 5, u32(u32(~A) + M32 + C), Number((u32(~A) + M32 + C) >> 32n), ovAdd(u32(~A), M32, C)],
        ['neg', X(104, 5, 3, 0, 1, 1), 5, u32(-A), -1, a === 0x80000000 ? 1 : 0],
        ['mullw', X(235, 5, 3, 4, 1, 1), 5, u32(s32(A) * s32(B)), -1, (() => { const p = s32(A) * s32(B); return p > 0x7FFFFFFFn || p < -0x80000000n ? 1 : 0; })()],
        ['mulhw', X(75, 5, 3, 4, 1), 5, u32((s32(A) * s32(B)) >> 32n), -1, -1],
        ['mulhwu', X(11, 5, 3, 4, 1), 5, u32((A * B) >> 32n), -1, -1],
        ['and', X(28, 3, 5, 4, 1), 5, A & B, -1, -1], ['or', X(444, 3, 5, 4, 1), 5, A | B, -1, -1], ['xor', X(316, 3, 5, 4, 1), 5, A ^ B, -1, -1],
        ['nand', X(476, 3, 5, 4, 1), 5, u32(~(A & B)), -1, -1], ['nor', X(124, 3, 5, 4, 1), 5, u32(~(A | B)), -1, -1], ['eqv', X(284, 3, 5, 4, 1), 5, u32(~(A ^ B)), -1, -1],
        ['andc', X(60, 3, 5, 4, 1), 5, A & u32(~B), -1, -1], ['orc', X(412, 3, 5, 4, 1), 5, A | u32(~B), -1, -1],
        ['slw', X(24, 3, 5, 4, 1), 5, (b & 63) > 31 ? 0n : u32(A << BigInt(b & 63)), -1, -1],
        ['srw', X(536, 3, 5, 4, 1), 5, (b & 63) > 31 ? 0n : A >> BigInt(b & 63), -1, -1],
        ['sraw', X(792, 3, 5, 4, 1), 5, u32(s32(A) >> BigInt(Math.min(b & 63, 32))), (() => { const n = BigInt(Math.min(b & 63, 32)); return s32(A) < 0n && (A & ((1n << n) - 1n)) !== 0n ? 1 : 0; })(), -1],
        ['cntlzw', X(26, 3, 5, 0, 1), 5, BigInt(a === 0 ? 32 : 32 - a.toString(2).length), -1, -1],
        ['extsb', X(954, 3, 5, 0, 1), 5, u32(BigInt.asIntN(8, A)), -1, -1], ['extsh', X(922, 3, 5, 0, 1), 5, u32(BigInt.asIntN(16, A)), -1, -1],
    ];
    const sh = b & 31;
    cases.push(['srawi', X(824, 3, 5, sh, 1), 5, u32(s32(A) >> BigInt(sh)), s32(A) < 0n && (A & ((1n << BigInt(sh)) - 1n)) !== 0n ? 1 : 0, -1]);
    if (b !== 0 && !(a === 0x80000000 && b === 0xFFFFFFFF)) cases.push(['divw', X(491, 5, 3, 4, 1, 1), 5, u32(s32(A) / s32(B)), -1, 0]);
    if (b !== 0) cases.push(['divwu', X(459, 5, 3, 4, 1, 1), 5, A / B, -1, 0]);
    const simm = (rnd32() << 16) >> 16, S = BigInt(simm), SU = u32(S);
    cases.push(['addic.', D(13, 5, 3, simm), 5, u32(A + SU), Number((A + SU) >> 32n), -1]);
    cases.push(['subfic', D(8, 5, 3, simm), 5, u32(SU - A), Number((u32(~A) + SU + 1n) >> 32n), -1]);
    cases.push(['mulli', D(7, 5, 3, simm), 5, u32(s32(A) * S), -1, -1]);
    cases.push(['addi', D(14, 5, 3, simm), 5, u32(A + SU), -1, -1]);
    cases.push(['addis', D(15, 5, 3, simm), 5, u32(A + (SU << 16n)), -1, -1]);
    cases.push(['ori', D(24, 3, 5, simm), 5, A | BigInt(simm & 0xFFFF), -1, -1]);
    cases.push(['xoris', D(27, 3, 5, simm), 5, A ^ BigInt((simm & 0xFFFF) * 65536), -1, -1]);
    cases.push(['andi.', D(28, 3, 5, simm), 5, A & BigInt(simm & 0xFFFF), -1, -1]);
    cases.push(['andis.', D(29, 3, 5, simm), 5, A & BigInt((simm & 0xFFFF) * 65536), -1, -1]);
    for (const [name, ins, reg, want, wca, wov] of cases) {
        set(); run1(ins);
        expect(name, cpu.gpr[reg], Number(want));
        if (wca >= 0) expect(name + ' CA', cpu.xerCA, wca);
        if (wov >= 0 && (ins & 0x400)) expect(name + ' OV', cpu.xerOV, wov);
        const rcSet = (ins >>> 26) === 31 ? ins & 1 : (ins >>> 26) === 13 || (ins >>> 26) === 28 || (ins >>> 26) === 29;
        if (rcSet) expect(name + ' CR0', cpu.cr >>> 28, cr0(want, cpu.xerSO));
    }
    // rotates with masks: against a bit-by-bit model (the manual's MASK(mb, me): big-endian bit numbers)
    const mb = rnd32() & 31, me = rnd32() & 31, rot = rnd32() & 31;
    let mk = 0n;
    for (let i = mb; ; i = (i + 1) & 31) { mk |= 1n << BigInt(31 - i); if (i === me) break; }
    const rotl = (v: bigint, n: number) => u32((v << BigInt(n)) | (v >> BigInt(32 - n)));
    set(); run1(((21 << 26) | (3 << 21) | (5 << 16) | (rot << 11) | (mb << 6) | (me << 1) | 1) >>> 0);
    expect('rlwinm', cpu.gpr[5], Number(rotl(A, rot) & mk));
    set(); cpu.gpr[5] = b; run1(((20 << 26) | (3 << 21) | (5 << 16) | (rot << 11) | (mb << 6) | (me << 1)) >>> 0);
    expect('rlwimi', cpu.gpr[5], Number((rotl(A, rot) & mk) | (B & u32(~mk))));
    set(); run1(((23 << 26) | (3 << 21) | (5 << 16) | (4 << 11) | (mb << 6) | (me << 1)) >>> 0);
    expect('rlwnm', cpu.gpr[5], Number(rotl(A, b & 31) & mk));
    // compares
    set(); run1(X(0, 2 << 2, 3, 4)); expect('cmp', (cpu.cr >>> 20) & 0xF, s32(A) < s32(B) ? 8 : s32(A) > s32(B) ? 4 : 2);
    set(); run1(X(32, 7 << 2, 3, 4)); expect('cmpl', cpu.cr & 0xF, A < B ? 8 : A > B ? 4 : 2);
    set(); run1(D(11, 1 << 2, 3, simm)); expect('cmpi', (cpu.cr >>> 24) & 0xF, s32(A) < S ? 8 : s32(A) > S ? 4 : 2);
    set(); run1(D(10, 0, 3, simm)); expect('cmpli', cpu.cr >>> 28, A < BigInt(simm & 0xFFFF) ? 8 : A > BigInt(simm & 0xFFFF) ? 4 : 2);
}
console.log('integer: checks', checks, 'failures', fails);

// ---------------------------------------------------------------- exact fused multiply-add
const f64 = new Float64Array(1), b64 = new BigUint64Array(f64.buffer);
/** a finite double as [sign, mantissa (BigInt), exponent]: value = mantissa * 2^exponent */
function parts(v: number): [bigint, bigint] {
    f64[0] = v;
    const bits = b64[0], e = Number((bits >> 52n) & 0x7FFn), m = bits & 0xFFFFFFFFFFFFFn;
    const mant = e === 0 ? m : m | (1n << 52n), exp = e === 0 ? -1074 : e - 1075;
    return [bits >> 63n ? -mant : mant, BigInt(exp)];
}
/** num * 2^exp rounded to nearest-even with `prec` bits of mantissa and the format's minimum exponent (subnormals), as a JS number */
function roundTo(num: bigint, exp: bigint, prec: number, emin: number, emax: number): number {
    if (num === 0n) return 0;
    const neg = num < 0n; if (neg) num = -num;
    let e = Number(exp);
    const len = num.toString(2).length;
    // drop bits beyond the precision, or below the minimum exponent's unit
    let drop = Math.max(len - prec, emin - e);
    if (drop > 0) {
        const half = 1n << BigInt(drop - 1), rem = num & ((1n << BigInt(drop)) - 1n);
        num >>= BigInt(drop); e += drop;
        if (rem > half || (rem === half && (num & 1n))) num += 1n;
        if (num.toString(2).length > prec) { num >>= 1n; e += 1; }
    }
    if (e + num.toString(2).length - 1 > emax) return neg ? -Infinity : Infinity;
    const r = Number(num) * 2 ** e;
    return neg ? -r : r;
}
function fmaExact(a: number, c: number, b: number, single: boolean): number {
    const [ma, ea] = parts(a), [mc, ec] = parts(c), [mb, eb] = parts(b);
    let pm = ma * mc, pe = ea + ec, bm = mb, be = eb;
    const e = pe < be ? pe : be;
    pm <<= pe - e; bm <<= be - e;
    return single ? roundTo(pm + bm, e, 24, -149, 127) : roundTo(pm + bm, e, 53, -1074, 1023);
}
const rndF = () => {
    const kind = rnd32() % 6;
    f64[0] = 0;
    if (kind === 0) return Math.fround((rnd32() / 4294967296 - 0.5) * 2 ** ((rnd32() % 40) - 20));
    if (kind === 1) return (rnd32() / 4294967296 - 0.5) * 2 ** ((rnd32() % 80) - 40) + rnd32() * 2 ** -60;
    if (kind === 2) return Math.fround(rnd32() % 1000 - 500);
    if (kind === 3) return Math.fround((1 + (rnd32() >>> 9) * 2 ** -23) * 2 ** ((rnd32() % 16) - 8)) * (rnd32() & 1 ? -1 : 1);
    if (kind === 4) return Math.fround(2 ** ((rnd32() % 60) - 30));
    return Math.fround((rnd32() / 4294967296) * 1e-3);
};
let f0 = fails;
for (let t = 0; t < 400000; t++) {
    let a = rndF(), c = rndF(), b = rndF();
    // provoke halfway cases: b chosen so that a*c + b sits near a rounding boundary
    if (t % 3 === 0) { const p = a * c; b = Math.fround(-p) + Math.fround(p * 2 ** -24) * ((rnd32() % 5) - 2) * 0.5; }
    if (t % 7 === 0) { const p = Math.fround(a * c); b = Math.fround(p * (1 + ((rnd32() % 9) - 4) * 2 ** -24)); }
    if (!isFinite(a * c + b) || (a * c !== 0 && Math.abs(a * c) < 1e-280)) continue;
    const wd = fmaExact(a, c, b, false), ws = fmaExact(a, c, b, true);
    const gd = fmaD(a, c, b), gs = fmaS(a, c, b);
    if (wd === 0 && gd === 0) checks++; else expect(`fmaD(${a}, ${c}, ${b})`, gd, wd);
    if (ws === 0 && gs === 0) checks++; else expect(`fmaS(${a}, ${c}, ${b})`, gs, ws);
}
console.log('fused multiply-add: failures', fails - f0);

// ---------------------------------------------------------------- fres, frsqrte, conversions
f0 = fails;
for (let t = 0; t < 300000; t++) {
    const v = t < 200000 ? rndF() : (rnd32() / 4294967296) * 2 ** ((rnd32() % 2000) - 1000);
    expect(`fres(${v})`, fres(v), fresV2(v));
    expect(`frsqrte(${v})`, frsqrte(Math.abs(v)), frsqrteV2(Math.abs(v)));
    // a single survives lfs -> stfs bit for bit (NaNs and denormals included)
    const bits = rnd32(), w = new Uint32Array(2);
    singleToDoubleBits(bits, w, 0);
    expect('lfs/stfs ' + bits.toString(16), doubleToSingleBits(w[1], w[0]), bits);
}
// stfs of a double in single range drops the low bits (no rounding); force25 keeps 25 bits
{
    const w = new Uint32Array(new Float64Array([1 + 2 ** -24 + 2 ** -30]).buffer);
    expect('stfs truncates', doubleToSingleBits(w[1], w[0]), f32Bits(1));
    expect('force25 exact', force25(1.5), 1.5);
    expect('force25 rounds up', force25(1 + 2 ** -25), 1 + 2 ** -24);
    expect('force25 rounds down', force25(1 + 2 ** -26), 1);
    expect('trunc25 cuts', trunc25(1 + 2 ** -17 + 2 ** -23 + 2 ** -25 + 2 ** -26), 1 + 2 ** -17 + 2 ** -23);
    expect('trunc25 keeps 25 bits', trunc25(1 + 2 ** -24 + 2 ** -25), 1 + 2 ** -24);
    expect('force25 with the low word\'s top bit', force25(1 + 2 ** -21 + 2 ** -25), 1 + 2 ** -21 + 2 ** -24);
    expect('force25 carries into the high word', force25(1 + 2 ** -20 - 2 ** -25), 1 + 2 ** -20);   // (the low word 0xF8000000)
}
console.log('fres / frsqrte / conversions: failures', fails - f0);
console.log(fails ? `FAILED: ${fails}` : `all ${checks} checks passed`);
if (fails) process.exit(1);
