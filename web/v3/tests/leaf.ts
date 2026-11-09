// v3 milestone 1: run leaf functions from the user's DOL and compare them with v2's checked ports.
// node --experimental-strip-types? (bundled with esbuild: see run below)
import { readFileSync } from 'node:fs';
import { Memory, loadDol } from '../ppc/mem.ts';
import { Cpu, f32Bits } from '../ppc/cpu.ts';
import { sinf, cosf, mslAtan2f } from '../../src/game/math.ts';

const dol = readFileSync(process.argv[2] || '/mnt/user-data/uploads/ghosts/_main_jp.dol');
const mem = new Memory(); loadDol(mem, new Uint8Array(dol.buffer, dol.byteOffset, dol.byteLength));
const cpu = new Cpu(mem);
cpu.call(0x80005364);   // __init_registers: r1, r2, r13
// the static constructors (__init_cpp: the _ctors table, 0x8036FBA0), as __start runs them before main
let ctorFail = 0;
for (let a = 0x8036FBA0; ; a += 4) { const f = mem.r32(a); if (!f) break; try { cpu.call(f); } catch (e) { ctorFail++; if (ctorFail < 5) console.log('ctor', f.toString(16), String(e).slice(0, 100)); cpu.call(0x80005364); } }
console.log('ctors failed', ctorFail);
// paired-single quantisation registers as OSInit leaves them (GQR0 = 0: floats)
const SINF = 0x80087104, COSF = 0x80086F70, ATAN2F = 0x80086E14;
let n = 0, bad = 0;
const f = Math.fround;
function check(name: string, got: number, want: number, arg: string) { n++; if (f32Bits(got) !== f32Bits(want)) { if (bad++ < 10) console.log('DIFF', name, arg, got, want); } }
let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
for (let i = 0; i < 20000; i++) {
    const x = f((rnd() - 0.5) * (i < 10000 ? 8 : 2000));
    cpu.call(SINF, [], [x]); check('sinf', cpu.ps0[1], sinf(x), String(x));
    cpu.call(COSF, [], [x]); check('cosf', cpu.ps0[1], cosf(x), String(x));
    const y = f((rnd() - 0.5) * 100);
    cpu.call(ATAN2F, [], [y, x]); check('atan2f', cpu.ps0[1], mslAtan2f(y, x), `${y},${x}`);
}
console.log('checked', n, 'differences', bad, 'instructions', cpu.count);

// paired singles: PSMTXConcat (0x80094310) and PSMTXMultVec (0x80094BF0) against v2's ports
import { concat } from '../../src/game/j3dcalc.ts';
import { psMtxMultVec, V3 } from '../../src/game/math.ts';
{
    const A = 0x81000000, B = 0x81000040, O = 0x81000080, V = 0x810000C0, W = 0x810000D0;
    let n2 = 0, bad2 = 0;
    for (let t = 0; t < 3000; t++) {
        const a = Array.from({ length: 12 }, () => f((rnd() - 0.5) * 4)), b = Array.from({ length: 12 }, () => f((rnd() - 0.5) * 4));
        a.forEach((v, i) => mem.w32(A + i * 4, f32Bits(v))); b.forEach((v, i) => mem.w32(B + i * 4, f32Bits(v)));
        cpu.call(0x80094310, [A, B, O]);
        const want: number[] = new Array(12); concat(a, b, want);
        for (let i = 0; i < 12; i++) { n2++; if (mem.r32(O + i * 4) !== f32Bits(want[i])) { if (bad2++ < 5) console.log('DIFF concat', t, i); } }
        const v = [f((rnd() - 0.5) * 100), f((rnd() - 0.5) * 100), f((rnd() - 0.5) * 100)];
        v.forEach((x, i) => mem.w32(V + i * 4, f32Bits(x)));
        cpu.call(0x80094BF0, [A, V, W]);
        const r = psMtxMultVec(a as any, new V3(v[0], v[1], v[2])), rr = [r.x, r.y, r.z];
        for (let i = 0; i < 3; i++) { n2++; if (mem.r32(W + i * 4) !== f32Bits(rr[i])) { if (bad2++ < 5) console.log('DIFF multvec', t, i); } }
    }
    console.log('paired singles: checked', n2, 'differences', bad2);
}
