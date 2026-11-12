// MSL acosf / atan2f and JGeometry inv_sqrt against the port's: node msl.mjs
import { readFileSync } from 'node:fs';
import { Memory, loadDol } from '../../v3/ppc/mem.ts';
import { Cpu } from '../../v3/ppc/cpu.ts';
import { fr, mslAcosf, mslAtan2f, jgInvSqrt } from '../../src/game/math.ts';
const dol = readFileSync('/mnt/user-data/uploads/ghosts/_main_jp.dol');
const mem = new Memory(); loadDol(mem, new Uint8Array(dol.buffer, dol.byteOffset, dol.byteLength));
const cpu = new Cpu(mem); cpu.setMsr(0x2032); cpu.call(0x80005364);
for (let a = 0x8036FBA0; ; a += 4) { const f = mem.r32(a); if (!f) break; cpu.call(f); }
const F = new Float32Array(1), W = new Uint32Array(F.buffer); const bits = (v: number) => { F[0] = v; return W[0]; };
let seed = 5; const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
const bad: Record<string, number> = { acos: 0, atan2: 0, invsqrt: 0 };
for (let k = 0; k < 20000; k++) {
    const x = fr(rnd() * [1, 0.01, 0.999, 1][k & 3] * (k & 4 ? -1 : 1));
    cpu.call(0x80086DD0, [], [x]); const g = cpu.ps0[1], p = mslAcosf(x);
    if (bits(g) !== bits(p) && bad.acos++ < 4) console.log('ACOS', x, bits(g).toString(16), bits(p).toString(16));
    const y = fr((rnd() - 0.5) * [1, 100, 0.01, 5][k & 3]), z = fr((rnd() - 0.5) * [1, 100, 0.01, 5][(k >> 2) & 3]);
    cpu.call(0x80086E14, [], [y, z]); const g2 = cpu.ps0[1], p2 = mslAtan2f(y, z);
    if (bits(g2) !== bits(p2) && bad.atan2++ < 4) console.log('ATAN2', y, z, bits(g2).toString(16), bits(p2).toString(16));
    const s = fr(rnd() * [1, 1e-4, 100, 1e5][k & 3]);
    cpu.call(0x8006CD70, [], [s]); const g3 = cpu.ps0[1], p3 = jgInvSqrt(s);
    if (bits(g3) !== bits(p3) && bad.invsqrt++ < 4) console.log('INVSQRT', s, bits(g3).toString(16), bits(p3).toString(16));
}
console.log(bad);
