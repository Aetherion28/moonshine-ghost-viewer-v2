// v3: boots the game from the DOL's entry and reports how far it gets.
// Run: npx esbuild v3/tests/boot.ts --bundle --platform=node --format=esm --outfile=/tmp/v3boot.mjs && node /tmp/v3boot.mjs [millions of instructions]
import { Machine } from '../ppc/machine.ts';
import { installHle } from '../ppc/hle.ts';
import { symbols } from './syms.ts';
import { jpDisc, JP_DOL, loadBytes } from './jpdisc.ts';
import { threads } from './debug.ts';

const S = symbols();
const M = new Machine(), cpu = M.cpu, mem = M.mem;
const disc = jpDisc();
M.load(loadBytes(JP_DOL), disc);
const opened: string[] = [];
disc.onOpen = (p) => { opened.push(p); if (process.env.FILES) console.log('[disc]', p, 'at', cpu.count); };
const missing = installHle(M, (n) => S.byName.get(n), { report: (t) => { if (!process.env.QUIET) process.stdout.write('[game] ' + t); } });
if (missing.length) console.log('hle: not found', missing);

// function entries seen (a cheap profile of where the game is)
const calls = new Map<number, number>(); const ring: string[] = [];
if (process.env.PROFILE) for (const [a, name] of S.byAddr) if (!cpu.hookAt(a)) cpu.hook(a, () => { calls.set(a, (calls.get(a) || 0) + 1); ring.push(name); if (ring.length > 40) ring.shift(); return false; });

// the application's state (TApplication gpApplication, JP 0x803E6000), reported as it changes
const APP = 0x803E6000;
let lastApp = '';
const watch = () => {
    const st = mem.r8(APP + 8), dir = mem.r32(APP + 4), cur = [mem.r8(APP + 0xE), mem.r8(APP + 0xF)], next = [mem.r8(APP + 0x12), mem.r8(APP + 0x13)];
    const k = `app state ${st} director ${dir ? S.who(mem.r32(dir)) + '@' + dir.toString(16) : '-'} area ${cur} next ${next}`;
    if (k !== lastApp) { lastApp = k; console.log(`[${(cpu.count / 486e6).toFixed(2)} s, field ${M.fields}]`, k); }
    M.after(M.hw.field, watch);
};
M.after(M.hw.field, watch);
// START=area,episode: when the logos end, go straight into that stage (TApplication::proc's loop head, JP 0x800FA1CC)
if (process.env.START) {
    const [area, ep] = process.env.START.split(',').map(Number);
    let done = false;
    cpu.hook(0x800FA1CC, (c) => {
        const app = c.gpr[31];
        if (!done && mem.r8(app + 8) === 4) {
            done = true;
            mem.w8(app + 8, 5);
            for (const o of [0xA, 0xE, 0x12]) { mem.w8(app + o, area); mem.w8(app + o + 1, ep); mem.w16(app + o + 2, 0); }
            console.log(`[${(cpu.count / 486e6).toFixed(2)} s] starting stage ${area},${ep}`);
        }
        return false;
    });
}
const N = +(process.argv[2] || 100) * 1e6;
const t0 = performance.now();
let err: unknown = null;
try { M.run(N); } catch (e) { err = e; }
const dt = (performance.now() - t0) / 1000;
if (err) console.log('STOP', String(err), (err as Error).stack?.split('\n').slice(1, 4).join(' | '));
console.log(`ran to ${cpu.count} (${(cpu.count / 486e6).toFixed(2)} s of game time) in ${dt.toFixed(1)} s; idle skipped ${(M.idleSkipped / 1e6).toFixed(1)} M; fields ${M.fields}`);
console.log('pc', cpu.pc.toString(16), S.who(cpu.pc), 'lr', cpu.lr.toString(16), S.who(cpu.lr), 'msr', cpu.msr.toString(16), 'fpscr', cpu.fpscr.toString(16));
console.log('disc: reads', M.hw.diReads, 'bytes', M.hw.diBytes, 'files', opened.length, opened.slice(0, 40).join(' '));
console.log('gx fifo bytes', M.hw.fifoBytes);
{ const io = new DataView(M.hw.io.buffer); console.log('PE status', io.getUint16(0x100A).toString(16), 'token', io.getUint16(0x100E).toString(16), 'PI cause', M.hw.piCause.toString(16), 'mask', M.hw.piMask.toString(16), 'extIrq', cpu.extIrq, 'events', (M as any).events.length, 'next', M.nextEventAt() - cpu.count); }
if (process.env.THREADS) console.log(threads(M, S));
if (process.env.PROFILE) {
    console.log('top calls', [...calls].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([a, n]) => S.byAddr.get(a) + ':' + n).join(' '));
    console.log('last', ring.join(' '));
}
