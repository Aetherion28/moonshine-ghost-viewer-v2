// MSL sinf / cosf (JP 0x80087104 / 0x80086F70) against the port's, over many angles: node sin.mjs [n]
import { readFileSync } from 'node:fs';
import { Memory, loadDol } from '../../v3/ppc/mem.ts';
import { Cpu } from '../../v3/ppc/cpu.ts';
import { fr, sinf, cosf } from '../../src/game/math.ts';
const dol = readFileSync('/mnt/user-data/uploads/ghosts/_main_jp.dol');
const mem = new Memory(); loadDol(mem, new Uint8Array(dol.buffer, dol.byteOffset, dol.byteLength));
const cpu = new Cpu(mem); cpu.setMsr(0x2032); cpu.call(0x80005364);
for (let a = 0x8036FBA0; ; a += 4) { const f = mem.r32(a); if (!f) break; cpu.call(f); }
const F = new Float32Array(1), W = new Uint32Array(F.buffer);
const bits = (v: number) => { F[0] = v; return W[0]; };
const fromBits = (u: number) => { W[0] = u; return F[0]; };
const N = +(process.argv[2] || 20000);
let bad = { s: 0, c: 0 }, seed = 3;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
const tests: number[] = [fr(3.14 * fr(fromBits(0xc0d2e786) / 180))];
for (let k = 0; k < N; k++) tests.push(fr((rnd() - 0.5) * [0.01, 0.5, 4, 20][k & 3]));
for (const a of tests) {
    const gs = (cpu.call(0x80087104, [], [a]), cpu.ps0[1]), gc = (cpu.call(0x80086F70, [], [a]), cpu.ps0[1]);
    const ps = sinf(a), pc = cosf(a);
    if (bits(gs) !== bits(ps)) { if (bad.s++ < 6) console.log('SIN', a, bits(a).toString(16), 'game', bits(gs).toString(16), 'port', bits(ps).toString(16)); }
    if (bits(gc) !== bits(pc)) { if (bad.c++ < 6) console.log('COS', a, bits(a).toString(16), 'game', bits(gc).toString(16), 'port', bits(pc).toString(16)); }
}
{ const a = tests[0]; cpu.call(0x80087104, [], [a]); console.log('first', bits(a).toString(16), 'game', bits(cpu.ps0[1]).toString(16), 'port', bits(sinf(a)).toString(16)); }
console.log('of', tests.length, 'sin differ', bad.s, 'cos differ', bad.c);
