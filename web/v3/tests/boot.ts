// v3 milestone 2 probe: run the DOL from its entry and see where it stops (unimplemented ops, hardware).
import { readFileSync } from 'node:fs';
import { Machine } from '../ppc/machine.ts';
import { symbols } from './syms.ts';
import { installHle } from '../ppc/hle.ts';

const dol = readFileSync(process.argv[2] || '/mnt/user-data/uploads/ghosts/_main_jp.dol');
const M = new Machine(); const mem = M.mem, cpu = M.cpu;
const entry = M.load(new Uint8Array(dol.buffer, dol.byteOffset, dol.byteLength));
const S = symbols();
const io = new Map<string, number>();
const hw0 = M.hw, rd = hw0.read.bind(hw0), wr = hw0.write.bind(hw0);
hw0.read = (a, s) => { const k = 'R' + a.toString(16); io.set(k, (io.get(k) || 0) + 1); return rd(a, s); };
hw0.write = (a, s, v) => { const k = 'W' + a.toString(16); io.set(k, (io.get(k) || 0) + 1); wr(a, s, v); };
console.log('hle missing', installHle(cpu, S));
const calls = new Map<number, number>();
let last = ''; const ring: string[] = []; const lowpc = new Map<number, number>();
const N = +(process.argv[3] || 20_000_000);
try {
    for (let i = 0; i < N; i++) {
        const pc = cpu.pc;
        if (S.byAddr.has(pc)) { calls.set(pc, (calls.get(pc) || 0) + 1); last = S.byAddr.get(pc)!; ring.push(last + '@' + i); if (process.env.ARGS && last === process.env.ARGS) console.log('ARGS', last, [3,4,5,6].map(r => cpu.gpr[r].toString(16)).join(' '), 'lr', S.who(cpu.lr)); if (ring.length > 30) ring.shift(); }
        if (pc < 0x80003100) { lowpc.set(pc, (lowpc.get(pc) || 0) + 1); }
        M.step();
    }
    console.log('ran', N);
} catch (e) { console.log('STOP', String(e), 'in', last); }
console.log('pc', cpu.pc.toString(16), S.who(cpu.pc), 'lr', cpu.lr.toString(16), S.who(cpu.lr));
console.log('top calls', [...calls].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([a, n]) => S.byAddr.get(a) + ':' + n).join(' '));
console.log('distinct functions', calls.size);
console.log('last', ring.join(' '));
console.log('low pcs', [...lowpc].slice(0, 20).map(([a, n]) => a.toString(16) + ':' + n).join(' '));
console.log('io', [...io].slice(0, 40).map(([k, n]) => k + ':' + n).join(' '));
