// v3: plays a trace in the game and reports how far the game's own state matches the recording.
// Run: node v3replay.mjs <trace.msgt> [millions of instructions] (env: QUIET=1 hides the game's console, ALL=1 doesn't stop at the first issue)
import { readFileSync } from 'node:fs';
import { readTrace } from '../game/trace.ts';
import { Replay, JP10 } from '../game/replay.ts';
import { symbols } from './syms.ts';
import { jpDisc, JP_DOL, loadBytes } from './jpdisc.ts';
import { threads } from './debug.ts';

const S = symbols();
const file = process.argv[2];
const b = readFileSync(file);
const T = readTrace(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
if (T.gameId !== 'GMSJ01' || T.discRevision !== 0) { console.log(`the trace is from ${T.gameId} revision ${T.discRevision}: only GMSJ01 revision 0 is set up here`); process.exit(2); }
const who = (text: string) => text.replace(/\b(80[0-9a-f]{6})\b/g, (m) => { const w = S.who(parseInt(m, 16)); return w === '?' ? m : `${m} ${w}`; });
const stopOn = process.env.ALL ? ['heap'] : undefined;
const make = (fstPad: number) => new Replay(loadBytes(JP_DOL), jpDisc(), T, JP10, (n) => S.byName.get(n), {
    log: (s) => console.log(who(s)), report: process.env.QUIET ? undefined : (t) => process.stdout.write('[game] ' + t),
    stopOn, maxIssues: process.env.ALL ? 200 : 50, fstPad,
});
const budget = +(process.argv[3] || 4000) * 1e6;
const t0 = performance.now();
let err: unknown = null, res = 'error';
let R = make(0);
try {
    res = R.run(budget);
    if (R.heapDelta) {
        // the arena's top: boot again with the file system table as big as the recording console's
        console.log(`... booting again with the file system table ${R.heapDelta} bytes bigger`);
        R = make(R.heapDelta); res = R.run(budget);
    }
} catch (e) { err = e; }
const dt = (performance.now() - t0) / 1000, cpu = R.m.cpu;
if (err) { console.log('STOP', String(err), (err as Error).stack?.split('\n').slice(1, 5).join(' | ')); console.log('pc', cpu.pc.toString(16), S.who(cpu.pc), 'lr', cpu.lr.toString(16), S.who(cpu.lr)); if (process.env.THREADS) console.log(threads(R.m, S)); }
console.log(`${res}: ${R.frames} of ${T.frames.length} frames, ${R.ticks} of ${T.ticks.length} movement ticks (${R.marioChecked} Mario records compared), ${R.calls} rand calls and ${R.literals} GPU reads in step${R.shimCalls ? ` (${R.shimCalls} through Moonshine's shims)` : ''}; ${R.issues.length} issue(s)`);
console.log(`${(cpu.count / 1e6).toFixed(0)} M instructions (${((cpu.count - R.m.idleSkipped) / 1e6).toFixed(0)} M run) in ${dt.toFixed(1)} s; stage load ${((R.countAtPlay - R.countAtStage) / 486e6).toFixed(2)} s of game time, ${R.extraLoadFrames} extra loading frame(s)`);
process.exit(R.issues.length ? 1 : 0);
