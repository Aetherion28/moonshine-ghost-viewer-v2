// v3: plays a trace in the game and reports how far the game's own state matches the recording.
// Run: node v3replay.mjs <trace.msgt> [millions of instructions] (env: QUIET=1 hides the game's console, ALL=1 doesn't stop at the first issue,
// FSTPAD=n the file table's padding if known, WALL=s a time limit, LOCKED=a.sb,b.sb event scripts that start locked,
import { readFileSync } from 'node:fs';
import { readTrace, NO_NPC_PHASE } from '../game/trace.ts';
import { Replay, nextScriptLocks, followsFurther, partedInArithmetic } from '../game/replay.ts';
import { versionOf, VERSIONS } from '../game/versions.ts';
import { symbols } from './syms.ts';
import { discOf, loadBytes } from './jpdisc.ts';
import { threads } from './debug.ts';

const file = process.argv[2];
const b = readFileSync(file);
const T = readTrace(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
const V = versionOf(T.gameId, T.discRevision);
if (!V) { console.log(`the trace is from ${T.gameId} revision ${T.discRevision}: that version isn't set up here`); process.exit(2); }
// ON=<version key>: play it on another version's disc (the replay then follows the recording)
const VD = process.env.ON ? VERSIONS.find((v) => v.key === process.env.ON) : V;
if (!VD) { console.log(`no version ${process.env.ON}: ${VERSIONS.map((v) => v.key).join(', ')}`); process.exit(2); }
const S = symbols(`${process.env.DECOMP || '/home/claude/sms-ai-decomp/config'}/${VD.decomp}/symbols.txt`), D = discOf(VD.key);
const who = (text: string) => text.replace(/\b(80[0-9a-f]{6})\b/g, (m) => { const w = S.who(parseInt(m, 16)); return w === '?' ? m : `${m} ${w}`; });
const stopOn = process.env.ALL ? ['heap', 'layout'] : undefined;
const tried = new Set<string>();
let dolphin = !!process.env.DOLPHIN, npcPhase: number | undefined = process.env.NPCPHASE ? +process.env.NPCPHASE : undefined, stopOnActors = false;
const make = (fstPad: number, shinyShines = false, scriptsLocked: string[] = [], whole = false, selectHold = 0) => tune(new Replay(loadBytes(D.dol), D.disc(), T, VD.addrs, (n) => S.byName.get(n), {
    recorded: V.addrs,
    log: (s) => console.log(who(s)), report: process.env.QUIET ? undefined : (t) => process.stdout.write('[game] ' + t),
    stopOn, maxIssues: process.env.ALL ? 200 : 50, fstPad, shinyShines, scriptsLocked, selectHold, dolphin, npcPhase, stopOnActors, follow: !!process.env.FOLLOW, tried: whole || process.env.WHOLE ? undefined : tried,
}));
const tune = (r: Replay) => { if (process.env.JIT === '0') r.m.cpu.jit = false; if (process.env.JITVERIFY) r.m.cpu.jitVerify = true; return r; };
const budget = +(process.argv[3] || 4000) * 1e6;
const t0 = performance.now();
let err: unknown = null, res = 'error', shiny = false;
// FSTPAD: the padding a previous run found (skips the second boot); WALL: stop after that many seconds
let R = make(+(process.env.FSTPAD || 0), false, (process.env.LOCKED || '').split(',').filter(Boolean));
const wall = +(process.env.WALL || 0) * 1000;
const go = () => { const end = R.m.cpu.count + budget; let r: string = 'budget'; while (R.m.cpu.count < end && (r = R.run(Math.min(200e6, end - R.m.cpu.count))) !== 'done') if (wall && performance.now() - t0 > wall) { r = 'time'; break; } return r; };
try {
    res = go();
    if (R.heapDelta) {
        // the arena's top: boot again with the file system table as big as the recording console's
        console.log(`... booting again with the file system table ${R.fstPadUsed + R.heapDelta} bytes bigger`);
        R = make(R.fstPadUsed + R.heapDelta); res = go();
    }
    if (R.layoutDelta) {
        // the heap's layout: Moonshine's Shiny Shines isn't recorded; see whether it explains the recording's
        const pad = R.fstPadUsed;
        console.log('... booting again with Shiny Shines on');
        const R2 = make(pad, true), res2 = (R = R2, go());
        if (R2.layoutDelta) console.log('    (still laid out differently)');
        res = res2; shiny = true;
    }
    if (res === 'done' && partedInArithmetic(R) && !process.env.ALL) {
        // a number differs, not what the game did: the recording may be Dolphin's (one float rule differs from the console's)
        console.log("... booting again with Dolphin's arithmetic");
        const R1 = R; dolphin = true; R = make(R1.fstPadUsed, shiny, R1.scriptsLocked); const res2 = go();
        if (res2 === 'done' && followsFurther(R, R1)) res = res2; else { console.log('    (no further: kept as it was)'); R = R1; dolphin = false; }
    }
    // an event script's lock word is the console's heap garbage: where it decided something before the replay parted, try it the other way
    for (let locks; res === 'done' && (locks = nextScriptLocks(R, tried));) {
        console.log(`... booting again with the unset word of [${locks.join(', ')}] not 0`);
        const R1 = R; R = make(R1.fstPadUsed, shiny, locks); const res2 = go();
        if (res2 === 'done' && followsFurther(R, R1)) res = res2; else { console.log('    (no further: kept as it was)'); R = R1; }
    }
    if (res === 'done' && R.cutShort) {
        // no doubt explains the difference this replay was stopped at: play it whole
        console.log('... booting again to play it to the end');
        R = make(R.fstPadUsed, shiny, R.scriptsLocked, true); res = go();
    }
    // an older recording doesn't have the NPCs' goop-check counter (the first NPC of a session starts it; each takes the next of 30):
    // where an actor then differs, the other values are tried, and the one under which nothing differs is the console's
    if (res === 'done' && T.stages[0].npcPhase === NO_NPC_PHASE && npcPhase === undefined && !R.follow && R.issues.some((i) => i.kind === 'actor')) {
        const R0 = R; stopOnActors = true;
        for (let p = 1; p < 30 && R === R0; p++) {
            console.log(`... booting again with the NPC phase ${p}`);
            npcPhase = p; const R2 = make(R0.fstPadUsed, shiny, R0.scriptsLocked, true); R = R2;
            if (go() !== 'done' || R2.issues.length || R2.frames < T.frames.length) { console.log(`    (differs at frame ${R2.issues[0]?.frame})`); R = R0; npcPhase = undefined; }
        }
        stopOnActors = false;
    }
    // the episode select screen between two stages ended early here: its loading took longer on the console
    for (let n = 0; res === 'done' && R.selectDelta && n < 3; n++) {
        console.log(`... booting again with the episode select screen's loading ${R.selectDelta} frame(s) longer`);
        const R1 = R; R = make(R1.fstPadUsed, shiny, R1.scriptsLocked, true, R1.selectDelta); const res2 = go();
        if (res2 === 'done' && followsFurther(R, R1)) res = res2; else { console.log('    (no further: kept as it was)'); R = R1; break; }
    }
} catch (e) { err = e; }
const dt = (performance.now() - t0) / 1000, cpu = R.m.cpu;
if (err) { console.log('STOP', String(err), (err as Error).stack?.split('\n').slice(1, 5).join(' | ')); console.log('pc', cpu.pc.toString(16), S.who(cpu.pc), 'lr', cpu.lr.toString(16), S.who(cpu.lr)); if (process.env.THREADS) console.log(threads(R.m, S)); }
console.log(`scene ${(T.stages[0].words[4] >>> 24)},${(T.stages[0].words[4] >>> 16) & 0xFF} ${R.stageName}${shiny ? ' (Shiny Shines)' : ''}${R.dolphin ? " (Dolphin's arithmetic)" : ''}${R.npcPhaseTaken !== undefined ? ` (NPC phase ${R.npcPhaseTaken})` : ''}${R.unsupported.length ? ' unsupported: ' + R.unsupported.join(', ') : ''}`);
console.log(`${res}: ${R.frames} of ${T.frames.length} frames, ${R.ticks} of ${T.ticks.length} movement ticks (${R.marioChecked} Mario records compared), ${R.calls} rand calls and ${R.literals} GPU reads in step, ${R.actorsChecked} actor samples (${R.actorWordsOff} word(s) off) and ${R.waters} water requests (${R.watersOff} off) compared${R.shimCalls ? ` (${R.shimCalls} through Moonshine's shims)` : ''}; ${R.padCorrections} pad correction(s)${R.flagBytesTaken ? `, ${R.flagBytesTaken} flag byte(s) taken from the recording between stages` : ''}${R.bathDrawn ? `, ${R.bathDrawn} bath water height map(s) drawn by the GPU model` : ''}${R.leaveHeldFrames ? `, ${R.leaveHeldFrames} frame(s) between stages waited out` : ''}; ${R.issues.length} issue(s)`);
if (R.follow) console.log(`following: the recording's state taken ${Object.entries(R.taken).map(([k, n]) => `${k} ${n}`).join(', ') || 'nowhere'}`);
if (R.actorTakenAt.size) console.log('    actor words put in, by offset: ' + [...R.actorTakenAt].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([o, n]) => `+0x${o.toString(16)} ${n}`).join(', '));
if (R.occlusionTaken || R.occlusionOpen) console.log(`occlusion reads found from the camera's next record: ${R.occlusionTaken}; camera ticks neither value explains: ${R.occlusionOpen}`);
console.log(`${(cpu.count / 1e6).toFixed(0)} M instructions (${((cpu.count - R.m.idleSkipped) / 1e6).toFixed(0)} M run) in ${dt.toFixed(1)} s; stage load ${((R.countAtPlay - R.countAtStage) / 486e6).toFixed(2)} s of game time, ${R.extraLoadFrames} extra loading frame(s)`);
// OPTS_OUT=<file>: the setup this run settled on, for a tool that plays the trace again (tools/harness/lockstep_v3.ts)
if (process.env.OPTS_OUT) (await import('node:fs')).writeFileSync(process.env.OPTS_OUT, JSON.stringify({ fstPad: R.fstPadUsed, shinyShines: shiny, scriptsLocked: R.scriptsLocked, dolphin: R.dolphin, npcPhase: R.npcPhaseTaken, selectHold: R.selectHoldUsed, issues: R.issues.length, frames: R.frames, of: T.frames.length }));
process.exit(R.issues.length ? 1 : 0);
