// v3: prints a trace's events (a summary, or a range). Run: node v3tracedump.mjs <trace> [from] [to]
import { readFileSync } from 'node:fs';
import { readTrace, Ev, EV_NAMES, IN } from '../game/trace.ts';
import { symbols } from './syms.ts';

const S = symbols();
const b = readFileSync(process.argv[2]);
const T = readTrace(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
const hex = (x: number) => x.toString(16).padStart(8, '0');
console.log(`${T.gameId} rev ${T.discRevision}, container ${T.container}, events ${T.n}: stages ${T.stages.length}, frames ${T.frames.length}, ticks ${T.ticks.length}, run flags ${T.runFlags}`);
for (const s of T.stages) {
    const w = s.words;
    console.log(`stage at event ${s.ev}: scene ${hex(w[2])} prev ${hex(w[3])} cur ${hex(w[4])} next ${hex(w[5])} seed ${hex(w[6])} generation ${w[7]} heap used ${hex(w[9])} tail ${hex(w[10])} size ${hex(w[11])} tv ${w[14]} movie ${w[15]} npc phase ${s.npcPhase} observations ${s.observations}`);
    console.log('  session', s.session ? Buffer.from(s.session).toString('hex') : '-');
}
const from = +(process.argv[3] ?? 0), to = +(process.argv[4] ?? 0);
if (to > from) {
    let run = 0, runCaller = 0;
    const flushRun = () => { if (run) console.log(`      rand x${run} from ${hex(runCaller)} ${S.who(runCaller)}`); run = 0; };
    for (let i = from; i < Math.min(to, T.n); i++) {
        const k = T.kind[i];
        if (k === Ev.RAND) { if (run && T.a[i] !== runCaller) flushRun(); runCaller = T.a[i]; run++; continue; }
        flushRun();
        if (k === Ev.FRAME) { const f = T.frames[T.a[i]]; console.log(`${i} frame ${f.frame}: seed ${hex(f.seed)} ticks ${f.tick} state ${f.state} retrace ${f.retrace}${f.menuShown ? ' MENU' : ''}${f.setupThreadDone ? ' loaded' : ''}${f.setupDone ? ' setup' : ''}${f.session ? ' session' : ''}`); }
        else if (k === Ev.PAD) { const p = T.pads[T.a[i]]; console.log(`${i}   pad ${Buffer.from(p.input.subarray(IN.raw, IN.raw + 11)).toString('hex')}${p.frozen ? ' FROZEN' : ''}${p.suppressed ? ' SUPPRESSED' : ''}`); }
        else if (k === Ev.TICK) { const t = T.ticks[T.a[i]]; const dv = t.mario ? new DataView(t.mario.buffer) : null; console.log(`${i}   tick ${t.tick} cue ${hex(new DataView(t.input.buffer).getUint32(0))} mario@${hex(t.marioPtr)}${dv ? ` pos ${dv.getFloat32(0x10).toFixed(3)} ${dv.getFloat32(0x14).toFixed(3)} ${dv.getFloat32(0x18).toFixed(3)} status ${hex(dv.getUint32(0x7C))}` : ''}`); }
        else if (k === Ev.LIT) console.log(`${i}   literal ${hex(T.a[i])} = ${hex(T.b[i])} (seed ${hex(T.c[i])})`);
        else console.log(`${i} ${EV_NAMES[k]}`);
    }
    flushRun();
} else {
    // summary: the loading frames, the callers of rand during loading, the first ticks
    const firstSetup = T.frames.findIndex((f) => f.setupDone), firstLoaded = T.frames.findIndex((f) => f.setupThreadDone);
    console.log(`frames before the setup thread ended: ${firstLoaded}; first frame after setupObjects: ${firstSetup} (event ${T.frames[firstSetup]?.ev})`);
    const callers = new Map<number, number>();
    const end = T.frames[firstSetup]?.ev ?? T.n;
    for (let i = 0; i < end; i++) if (T.kind[i] === Ev.RAND) callers.set(T.a[i], (callers.get(T.a[i]) || 0) + 1);
    console.log('rand callers before it:', [...callers].sort((x, y) => y[1] - x[1]).slice(0, 25).map(([a, n]) => `${hex(a)} ${S.who(a)} x${n}`).join('\n  '));
    const states = new Map<number, number>(); for (const f of T.frames) states.set(f.state, (states.get(f.state) || 0) + 1);
    console.log('director states (frames):', [...states].map(([s, n]) => `${s}:${n}`).join(' '));
    console.log('frozen frames', T.pads.filter((p) => p.frozen).length, 'suppressed', T.pads.filter((p) => p.suppressed).length, 'menu', T.frames.filter((f) => f.menuShown).length, 'session changes', T.frames.filter((f) => f.session).length);
    console.log('first tick', T.ticks[0] && `event ${T.ticks[0].ev} frame ${T.ticks[0].frame} mario@${hex(T.ticks[0].marioPtr)}`);
}
