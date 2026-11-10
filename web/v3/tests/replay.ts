// v3: plays a trace in the game and reports how far the game's own state matches the recording.
// Run: node v3replay.mjs <trace.msgt> [millions of instructions] (env: QUIET=1 hides the game's console, ALL=1 doesn't stop at the first issue,
// FSTPAD=n the file table's padding if known, WALL=s a time limit,
// GX_SP the GPU model's sample points, eight numbers: x,y for the pixels (even x, even y), (odd, even), (even, odd), (odd, odd) (experiments))
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
const stopOn = process.env.ALL ? ['heap', 'layout'] : undefined;
const make = (fstPad: number, shinyShines = false) => tune(new Replay(loadBytes(JP_DOL), jpDisc(), T, JP10, (n) => S.byName.get(n), {
    log: (s) => console.log(who(s)), report: process.env.QUIET ? undefined : (t) => process.stdout.write('[game] ' + t),
    stopOn, maxIssues: process.env.ALL ? 200 : 50, fstPad, shinyShines,
}));
const tune = (r: Replay) => { if (process.env.JIT === '0') r.m.cpu.jit = false; if (process.env.JITVERIFY) r.m.cpu.jitVerify = true; if (process.env.GX_SP) r.m.hw.gx.samplePoint.set(process.env.GX_SP.split(',').map(Number)); return r; };
const budget = +(process.argv[3] || 4000) * 1e6;
const t0 = performance.now();
let err: unknown = null, res = 'error', shiny = false;
// FSTPAD: the padding a previous run found (skips the second boot); WALL: stop after that many seconds
let R = make(+(process.env.FSTPAD || 0));
const wall = +(process.env.WALL || 0) * 1000;
const go = () => { const end = R.m.cpu.count + budget; let r: string = 'budget'; while (R.m.cpu.count < end && (r = R.run(Math.min(200e6, end - R.m.cpu.count))) !== 'done') if (wall && performance.now() - t0 > wall) { r = 'time'; break; } return r; };
try {
    res = go();
    if (R.heapDelta) {
        // the arena's top: boot again with the file system table as big as the recording console's
        console.log(`... booting again with the file system table ${R.heapDelta} bytes bigger`);
        R = make(R.heapDelta); res = go();
    }
    if (R.layoutDelta) {
        // the heap's layout: Moonshine's Shiny Shines isn't recorded; see whether it explains the recording's
        const pad = R.fstPadUsed;
        console.log('... booting again with Shiny Shines on');
        const R2 = make(pad, true), res2 = (R = R2, go());
        if (R2.layoutDelta) console.log('    (still laid out differently)');
        res = res2; shiny = true;
    }
} catch (e) { err = e; }
const dt = (performance.now() - t0) / 1000, cpu = R.m.cpu;
if (err) { console.log('STOP', String(err), (err as Error).stack?.split('\n').slice(1, 5).join(' | ')); console.log('pc', cpu.pc.toString(16), S.who(cpu.pc), 'lr', cpu.lr.toString(16), S.who(cpu.lr)); if (process.env.THREADS) console.log(threads(R.m, S)); }
console.log(`scene ${(T.stages[0].words[4] >>> 24)},${(T.stages[0].words[4] >>> 16) & 0xFF} ${R.stageName}${shiny ? ' (Shiny Shines)' : ''}${R.unsupported.length ? ' unsupported: ' + R.unsupported.join(', ') : ''}`);
console.log(`${res}: ${R.frames} of ${T.frames.length} frames, ${R.ticks} of ${T.ticks.length} movement ticks (${R.marioChecked} Mario records compared), ${R.calls} rand calls and ${R.literals} GPU reads in step${R.shimCalls ? ` (${R.shimCalls} through Moonshine's shims)` : ''}; ${R.padCorrections} pad correction(s); ${R.issues.length} issue(s)`);
console.log(`${(cpu.count / 1e6).toFixed(0)} M instructions (${((cpu.count - R.m.idleSkipped) / 1e6).toFixed(0)} M run) in ${dt.toFixed(1)} s; stage load ${((R.countAtPlay - R.countAtStage) / 486e6).toFixed(2)} s of game time, ${R.extraLoadFrames} extra loading frame(s)`);
process.exit(R.issues.length ? 1 : 0);
