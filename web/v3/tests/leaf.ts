// v3: functions of the user's DOL run in the interpreter and compared with independent implementations:
//   MSL sinf / cosf / atan2f and the SDK's paired-single PSMTXConcat / PSMTXMultVec against v2's ports
//   (which were checked against the DOL's instructions and thousands of ticks of recorded play);
//   rand (the libc generator), JDrama::TNameRef::calcKeyCode, and JKRDecomp::decodeSZS on a real archive
//   against plain JS.
// Run: npx esbuild v3/tests/leaf.ts --bundle --platform=node --format=esm --outfile=/tmp/v3leaf.mjs && node /tmp/v3leaf.mjs [main.dol] [an .szs]
import { readFileSync } from 'node:fs';
import { Memory, loadDol } from '../ppc/mem.ts';
import { Cpu } from '../ppc/cpu.ts';
import { f32Bits } from '../ppc/fpu.ts';
import { sinf, cosf, mslAtan2f, psMtxMultVec, V3 } from '../../src/game/math.ts';
import { concat } from '../../src/game/j3dcalc.ts';
import { yaz0 } from '../../src/v1data/bin.ts';

const dol = readFileSync(process.argv[2] || '/mnt/user-data/uploads/ghosts/_main_jp.dol');
const szs = readFileSync(process.argv[3] || '/mnt/user-data/uploads/Games/_ghostviewer_extract/data/params.szs');
const mem = new Memory(); loadDol(mem, new Uint8Array(dol.buffer, dol.byteOffset, dol.byteLength));
const cpu = new Cpu(mem);
cpu.setMsr(0x2032);
// JP 1.0 addresses (the decomp's symbols.txt)
const A = { initRegisters: 0x80005364, ctors: 0x8036FBA0, sinf: 0x80087104, cosf: 0x80086F70, atan2f: 0x80086E14,
    PSMTXConcat: 0x80094310, PSMTXMultVec: 0x80094BF0, rand: 0x80085AC4, srand: 0x80085ABC, calcKeyCode: 0x8004468C, decodeSZS: 0x80036974 };
cpu.call(A.initRegisters);   // r1, r2, r13
// the static constructors (the _ctors table), as __start runs them before main: the MSL's tables are built there
for (let a = A.ctors; ; a += 4) { const f = mem.r32(a); if (!f) break; cpu.call(f); }

let n = 0, bad = 0;
const f = Math.fround;
function check(name: string, got: number, want: number, arg: string) { n++; if (got !== want) { if (bad++ < 10) console.log('DIFF', name, arg, got, want); } }
let seed = 12345; const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };

for (let i = 0; i < 20000; i++) {
    const x = f((rnd() - 0.5) * (i < 10000 ? 8 : 2000));
    cpu.call(A.sinf, [], [x]); check('sinf', f32Bits(cpu.ps0[1]), f32Bits(sinf(x)), String(x));
    cpu.call(A.cosf, [], [x]); check('cosf', f32Bits(cpu.ps0[1]), f32Bits(cosf(x)), String(x));
    const y = f((rnd() - 0.5) * 100);
    cpu.call(A.atan2f, [], [y, x]); check('atan2f', f32Bits(cpu.ps0[1]), f32Bits(mslAtan2f(y, x)), `${y},${x}`);
}
console.log('MSL trig: checked', n, 'differences', bad);

{
    const MA = 0x81000000, MB = 0x81000040, MO = 0x81000080, V = 0x810000C0, W = 0x810000D0;
    const n0 = n, b0 = bad;
    for (let t = 0; t < 3000; t++) {
        const a = Array.from({ length: 12 }, () => f((rnd() - 0.5) * 4)), b = Array.from({ length: 12 }, () => f((rnd() - 0.5) * 4));
        a.forEach((v, i) => mem.w32(MA + i * 4, f32Bits(v))); b.forEach((v, i) => mem.w32(MB + i * 4, f32Bits(v)));
        cpu.call(A.PSMTXConcat, [MA, MB, MO]);
        const want: number[] = new Array(12); concat(a, b, want);
        for (let i = 0; i < 12; i++) check('PSMTXConcat', mem.r32(MO + i * 4), f32Bits(want[i]), `${t}/${i}`);
        const v = [f((rnd() - 0.5) * 100), f((rnd() - 0.5) * 100), f((rnd() - 0.5) * 100)];
        v.forEach((x, i) => mem.w32(V + i * 4, f32Bits(x)));
        cpu.call(A.PSMTXMultVec, [MA, V, W]);
        const r = psMtxMultVec(a as any, new V3(v[0], v[1], v[2])), rr = [r.x, r.y, r.z];
        for (let i = 0; i < 3; i++) check('PSMTXMultVec', mem.r32(W + i * 4), f32Bits(rr[i]), `${t}/${i}`);
    }
    console.log('paired singles: checked', n - n0, 'differences', bad - b0);
}
{
    const n0 = n, b0 = bad;
    // rand: the C library's linear congruential generator
    cpu.call(A.srand, [777]);
    let s = 777;
    for (let i = 0; i < 20000; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; check('rand', cpu.call(A.rand), (s >>> 16) & 0x7FFF, String(i)); }
    // calcKeyCode: the 16-bit hash of a name (Shift-JIS bytes)
    const S = 0x81001000;
    for (let i = 0; i < 5000; i++) {
        const len = 1 + Math.floor(rnd() * 40);
        let h = 0;
        for (let k = 0; k < len; k++) { const c = 1 + Math.floor(rnd() * 255); mem.w8(S + k, c); h = (c + h * 3) >>> 0; }
        mem.w8(S + len, 0);
        check('calcKeyCode', cpu.call(A.calcKeyCode, [S]) & 0xFFFF, h & 0xFFFF, String(i));
    }
    // decodeSZS: a whole archive from the disc
    const SRC = 0x80800000, DST = 0x80C00000;
    const want = yaz0(new Uint8Array(szs.buffer, szs.byteOffset, szs.byteLength) as any) as Uint8Array;
    mem.ram.set(szs, SRC & 0x01FFFFFF);
    const c0 = cpu.count;
    cpu.call(A.decodeSZS, [SRC, DST, want.length, 0], [], 2_000_000_000);
    let diff = 0;
    for (let i = 0; i < want.length; i++) if (mem.ram[(DST & 0x01FFFFFF) + i] !== want[i]) diff++;
    check('decodeSZS', diff, 0, `${want.length} bytes`);
    console.log('rand / calcKeyCode / decodeSZS: checked', n - n0, 'differences', bad - b0, `(decodeSZS: ${want.length} bytes in ${cpu.count - c0} instructions)`);
}
const t0 = performance.now(), c1 = cpu.count;
for (let i = 0; i < 300; i++) cpu.call(A.decodeSZS, [0x80800000, 0x80C00000, 100000, 0], [], 2_000_000_000);
const dt = (performance.now() - t0) / 1000;
console.log(`speed: ${((cpu.count - c1) / dt / 1e6).toFixed(1)} million instructions a second`);
console.log(bad ? `FAILED: ${bad}` : `all ${n} checks passed`);
if (bad) process.exit(1);
