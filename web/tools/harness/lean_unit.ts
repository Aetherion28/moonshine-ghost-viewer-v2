// The game's own functions (the user's DOL, run in v3's CPU) against the port's, on the same inputs.
// node tools/harness/bpm.mjs tools/harness/lean_unit.ts /tmp/claude-0/ct/lean.mjs && node /tmp/claude-0/ct/lean.mjs
import { readFileSync } from 'node:fs';
import { Memory, loadDol } from '../../v3/ppc/mem.ts';
import { Cpu } from '../../v3/ppc/cpu.ts';
import { V3, mtx, fr, sinf, cosf, HALF_PI_F } from '../../src/game/math.ts';
import { MsSqrtf, fmadd as FMA, fmsub as FMS } from '../../src/game/player/fmath.ts';
import { normalize, rotationSetRotate, MTXConcat } from '../../src/game/mapobj/lib.ts';
import { vNorm, vMag } from '../../src/game/vecops.ts';
const dol = readFileSync('/mnt/user-data/uploads/ghosts/_main_jp.dol');
const mem = new Memory(); loadDol(mem, new Uint8Array(dol.buffer, dol.byteOffset, dol.byteLength));
const cpu = new Cpu(mem); cpu.setMsr(0x2032); cpu.call(0x80005364);
for (let a = 0x8036FBA0; ; a += 4) { const f = mem.r32(a); if (!f) break; cpu.call(f); }
const F = new Float32Array(1), W = new Uint32Array(F.buffer);
const bits = (v: number) => { F[0] = v; return W[0]; }, h = (v: number) => bits(v).toString(16).padStart(8, '0');
const P = 0x80700000, Q = 0x80700100, R = 0x80700200;
const wv = (a: number, v: number[]) => v.forEach((x, i) => mem.w32(a + 4 * i, bits(x)));
const rv = (a: number, n: number) => Array.from({ length: n }, (_, i) => mem.r32(a + 4 * i).toString(16).padStart(8, '0')).join(' ');
let seed = 7; const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
const stat: Record<string, [number, number]> = {};
function check(name: string, game: string, port: string, arg: string) { const s = stat[name] ??= [0, 0]; s[0]++; if (game !== port) { if (s[1]++ < 3) console.log('DIFF', name, arg, '\n   game', game, '\n   port', port); } }
for (let k = 0; k < 2000; k++) {
    const sc = [1e-8, 1e-3, 1, 100][k & 3];
    const v = [fr((rnd() - 0.5) * sc), fr((rnd() - 0.5) * 2), fr((rnd() - 0.5) * sc * 3)];
    // MsVECNormalize
    wv(P, v); cpu.call(0x800C57F8, [P, Q]);
    const n = normalize(new V3(v[0], v[1], v[2]));
    check('MsVECNormalize', rv(Q, 3), [n.x, n.y, n.z].map(h).join(' '), v.map(h).join(' '));
    // TRotation3::setRotate(axis, angle) on an identity 3x4
    const ang = fr((rnd() - 0.5) * (k & 4 ? 0.002 : 2));
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    wv(R, id); wv(P, v); cpu.call(0x8019193C, [R, P], [ang]);
    const m = mtx(); rotationSetRotate(m, new V3(v[0], v[1], v[2]), ang);
    check('setRotate', rv(R, 12), Array.from(m as Float64Array).map(h).join(' '), v.map(h).join(' ') + ' ' + h(ang));
    // concatOnlyRotFromRight(a, b, out)
    const a = Array.from({ length: 12 }, () => fr((rnd() - 0.5) * 2)), b = Array.from({ length: 12 }, () => fr((rnd() - 0.5) * 2));
    wv(P, a); wv(Q, b); cpu.call(0x80191C34, [P, Q, R]);
    const o = Float64Array.from(a), t = [o[3], o[7], o[11]]; o[3] = o[7] = o[11] = 0;
    const out = mtx(); MTXConcat(o, Float64Array.from(b), out); out[3] = t[0]; out[7] = t[1]; out[11] = t[2];
    check('concatOnlyRotFromRight', rv(R, 12), Array.from(out as Float64Array).map(h).join(' '), '');
}
for (let k = 0; k < 4000; k++) {
    const sc = [1e-3, 1, 100, 3000][k & 3];
    const v = [fr((rnd() - 0.5) * sc), fr((rnd() - 0.5) * sc), fr((rnd() - 0.5) * sc)];
    wv(P, v); cpu.call(0x80094EF0, [P, Q]);
    const n = vNorm(new V3(v[0], v[1], v[2]));
    check('PSVECNormalize', rv(Q, 3), [n.x, n.y, n.z].map(h).join(' '), v.map(h).join(' '));
    wv(P, v); cpu.call(0x80094F34, [P]);
    check('PSVECMag', h(cpu.ps0[1]), h(vMag(new V3(v[0], v[1], v[2]))), v.map(h).join(' '));
}
{ const r2 = cpu.gpr[2]; console.log('pi/2: game', mem.r32((r2 - 0x3f50) >>> 0).toString(16), 'port', h(HALF_PI_F), ' zero', mem.r32((r2 - 0x4100) >>> 0).toString(16), 'eps', mem.r32((r2 - 0x3f54) >>> 0).toString(16)); }
for (let k = 0; k < 2000; k++) {
    const sc = [1e-8, 1e-3, 1, 100][k & 3];
    const v = [fr((rnd() - 0.5) * sc), 0, fr((rnd() - 0.5) * (k & 8 ? 0.02 : 2))];
    wv(P, v); cpu.call(0x8019139C, [P], [HALF_PI_F]);
    const sn = sinf(HALF_PI_F), cs = cosf(HALF_PI_F);
    const ax = [FMA(sn, v[2], fr(cs * v[0])), 0, FMS(cs, v[2], fr(sn * v[0]))];
    check('rotateVecByAxisY', rv(P, 3), ax.map(h).join(' '), v.map(h).join(' '));
}
for (const [n, [c, b]] of Object.entries(stat)) console.log(`${n}: ${c - b} of ${c} the same`);
