// v3: plays a Dolphin TAS movie (.dtm) from power-on and reports where the game goes.
// Run: npx esbuild v3/tests/tas.ts --bundle --platform=node --format=esm --outfile=/tmp/claude-0/ct/tas.mjs && node /tmp/claude-0/ct/tas.mjs <movie.dtm> [seconds of game time]
// The movie holds the controller as Dolphin's serial interface polled it: three polls a video field, eight bytes a
// poll (Movie.h ControllerState: Start A B X Y Z Up Down / Left Right L R disc reset connected -, triggers L R, main
// stick X Y, C stick X Y). Each PADRead gets the last poll before the current field ends. Env: OFFSET=n shifts the
// movie by n polls (the game's timing against Dolphin's), LOG=1 prints every button change the game is given.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { encodeGxFrame } from '../web/gxframe.ts';
import { Machine } from '../ppc/machine.ts';
import { installHle } from '../ppc/hle.ts';
import { symbols } from './syms.ts';
import { jpDisc, JP_DOL, loadBytes } from './jpdisc.ts';
import { threads } from './debug.ts';
import { dolphinFma } from '../ppc/fpu.ts';
import { JP10 } from '../game/replay.ts';

const S = symbols();
const M = new Machine(), cpu = M.cpu, mem = M.mem;
M.load(loadBytes(JP_DOL), jpDisc());
// DOLPHIN=1: Dolphin's float rule (the TAS was made in Dolphin; `Cpu.laneRounds`)
if (process.env.DOLPHIN) cpu.laneRounds = true;
// DFMA=1: Dolphin's double-rounded single multiply-add (ppc/fpu.ts dolphinFma)
if (process.env.DFMA) dolphinFma.on = true;
installHle(M, (n) => S.byName.get(n), { report: (t) => { if (process.env.GAMELOG) process.stdout.write('[game] ' + t); } });

const dtm = readFileSync(process.argv[2]);
const POLLS = (dtm.length - 0x100) >> 3;
const poll = (i: number) => dtm.subarray(0x100 + 8 * i, 0x108 + 8 * i);
// STAGE4=a,b,...: the movie frame where each stage's play (TMarDirector state 4) begins in Dolphin, stage by stage
// (a frame followed by g: from the stage's first gameplay field instead, where the application's area changes)
const OFFSET = +(process.env.OFFSET || 0), STAGE_SPEC = (process.env.STAGE4 || '').split(',').filter((x) => x);
const STAGES = STAGE_SPEC.map((x) => parseFloat(x)), STAGE_AT_GAME = STAGE_SPEC.map((x) => x.endsWith('g'));
let STAGE4 = STAGES.length ? STAGES[0] : -1, stageNo = -1, stageArea = '';
let stage4Field = -1, stage4Reads = 0;
// Dolphin's ControllerState to the SDK's PADStatus (12 bytes: buttons, stick x y, C x y, triggers L R, analog A B, err)
const BITS: [number, number, number][] = [[0, 0x01, 0x1000], [0, 0x02, 0x100], [0, 0x04, 0x200], [0, 0x08, 0x400], [0, 0x10, 0x800], [0, 0x20, 0x10],
    [0, 0x40, 0x8], [0, 0x80, 0x4], [1, 0x01, 0x1], [1, 0x02, 0x2], [1, 0x04, 0x40], [1, 0x08, 0x20]];
let reads = 0, lastButtons = -1, lastReadField = -1;
// SEED=n: srand's argument (the game seeds rand with OSGetTick at boot, Application.cpp; Dolphin's tick then isn't v3's)
cpu.hook(S.byName.get('srand')!, (c) => { console.log(`srand(${c.gpr[3] >>> 0}) at instruction ${cpu.count}, field ${M.fields}`); if (process.env.SEED) c.gpr[3] = +process.env.SEED >>> 0; return false; });
const PADRead = S.byName.get('PADRead')!;
cpu.hook(PADRead, (c) => {
    const p = c.gpr[3];
    for (let i = 0; i < 48; i++) mem.w8(p + i, 0);
    for (let ch = 1; ch < 4; ch++) mem.w8(p + ch * 12 + 10, 0xFF);   // PAD_ERR_NO_CONTROLLER
    // STAGE4=<movie frame>: from the first frame of the stage's play (TMarDirector state 4) the movie is read from that frame on
    // BYREAD=1: one game frame (six polls) per pad read from the stage on, as if the game never lagged
    let k = Math.min(POLLS - 1, Math.max(0, stage4Field >= 0 ? (process.env.BYREAD ? STAGE4 * 6 + (reads - stage4Reads) * 6 + 5 + OFFSET : STAGE4 * 6 + (M.fields - stage4Field) * 3 + 2 + OFFSET) : M.fields * 3 + 2 + OFFSET));
    // SHIFT2=n AFTER2=<movie frame>: from that movie frame on, n more polls (the game's later part against Dolphin's)
    if (process.env.SHIFT2 && k >= +(process.env.AFTER2 || 0) * 6) k = Math.min(POLLS - 1, k + +process.env.SHIFT2);
    const s = poll(k);
    let b = 0; for (const [byte, bit, pad] of BITS) if (s[byte] & bit) b |= pad;
    mem.w16(p, b); mem.w8(p + 2, s[4] - 128); mem.w8(p + 3, s[5] - 128); mem.w8(p + 4, s[6] - 128); mem.w8(p + 5, s[7] - 128);
    if (!process.env.NOTRIG) { mem.w8(p + 6, s[2]); mem.w8(p + 7, s[3]); }
    if (stage4Field >= 0 && process.env.LAG && lastReadField >= 0 && M.fields - lastReadField !== 2) console.log(`  lag: read ${reads - stage4Reads} came ${M.fields - lastReadField} fields after the last`);
    lastReadField = M.fields;
    reads++;
    if (process.env.LOG && b !== lastButtons) console.log(`  field ${M.fields} poll ${k} (movie frame ${(k / 6).toFixed(1)}) buttons ${b.toString(16)}`);
    lastButtons = b;
    c.gpr[3] = 0; c.pc = c.lr; return true;
});

// OCC=0|1: Mario's occlusion probe (TMario::drawSyncCallback's GXPeekARGB) forced visible (0) or hidden (1); OCCLOG=1 lists its changes
let occLast = -1;
cpu.hook(S.byName.get('GXPeekARGB')!, (c) => {
    if (process.env.OCCLOG && stage4Field >= 0) { /* logged after the read: see below */ }
    peeks++; if (process.env.OCCLOG && peeks < 20 && stage4Field >= 0) console.log(`  peek ${c.gpr[3]},${c.gpr[4]}`);
    if (process.env.OCC === undefined) return false;
    mem.w32(c.gpr[5], process.env.OCC === '0' ? 0x10000000 : 0xFF000000); c.pc = c.lr; return true;
});
let dsc = 0, peeks = 0;
cpu.hook(S.byName.get('drawSyncCallback__6TMarioFUs')!, (c) => { dsc++; if (process.env.OCCLOG && stage4Field >= 0 && dsc % 50 === 0) { const t = c.gpr[3] >>> 0, f = (a: number) => { const v = new DataView(new ArrayBuffer(4)); v.setUint32(0, mem.r32(a)); return v.getFloat32(0).toFixed(1); }; console.log(`  drawSync this ${t.toString(16)} unk114 ${mem.r16(t + 0x114).toString(16)} screen ${f(t + 0x450)},${f(t + 0x454)} flag ${mem.r32(t + 0x118).toString(16)} (arg ${c.gpr[4]})`); } return false; });
const occWatch = () => { const ma = mem.r32(0x8040A378); if (process.env.OCCLOG && ma && stage4Field >= 0) { const o = mem.r32(ma + 0x118) & 1; if (o !== occLast) { console.log(`  occluded ${o} at stage frame ${((M.fields - stage4Field) / 2).toFixed(1)}`); occLast = o; } } M.after(M.hw.field, occWatch); };
M.after(M.hw.field, occWatch);
// The GPU work the game's logic reads back (as game/replay.ts does): the goop maps drawn and copied on the GPU, and
// Mario's occlusion test, a read of the frame buffer's alpha at his place (TMario::drawSyncCallback): every primitive
// is rasterised at that one pixel (ppc/gx.ts probeAt). NOPROBE=1 leaves the reads at 0 (Mario always hidden).
{
    const A = JP10, gx = M.hw.gx;
    if (!process.env.NOGOOP) cpu.hook(A.goopLayerDraw, () => { gx.mark(M.hw.streamPos(), true, true); return false; });
    cpu.hook(A.goopObjDraw[0], () => { gx.mark(M.hw.streamPos(), true); return false; });
    for (let a = A.goopObjDraw[0]; a < A.goopObjDraw[0] + A.goopObjDraw[1]; a += 4) if (mem.r32(a) === 0x4E800020) cpu.hook(a, () => { gx.mark(M.hw.streamPos(), false); return false; });
    if (!process.env.NOPROBE) {
        const pt = { x: 0, y: 0 }, fv = new DataView(new ArrayBuffer(4));
        const f = (a: number) => { fv.setUint32(0, mem.r32(a)); return fv.getFloat32(0); };
        gx.probeAt = () => {
            const ma = mem.r32(A.gpMarioOriginal); if (!ma) return null;
            const x = f(ma + 0x450), y = f(ma + 0x454);
            if (!(x >= 0 && y >= 0)) return null;
            pt.x = x >>> 0 & 0xFFFF; pt.y = y >>> 0 & 0xFFFF; return pt;
        };
        M.hw.efbPeek = (addr) => {
            const x = (addr >>> 2) & 0x3FF, y = (addr >>> 12) & 0x3FF;
            if (x >= 640 || y >= 528) return 0;
            if (addr & 0x400000) return gx.zbuf[y * 640 + x];
            const o = (y * 640 + x) * 4, e = gx.efb;
            return ((e[o + 3] << 24) | (e[o] << 16) | (e[o + 1] << 8) | e[o + 2]) >>> 0;
        };
    }
}
let gxWarn = new Set<string>();
M.hw.gxUnsupported = (what) => { if (!gxWarn.has(what)) { gxWarn.add(what); if (process.env.GXWARN) console.log(`  gpu: ${what}`); } };
// the application's state (TApplication gpApplication, JP 0x803E6000), reported as it changes
const APP = 0x803E6000;
const gks: number[] = [];
let lastGm = -2, lastApp = '', lastDir = '', lastDs = -2, shineSeen = false;
const watch = () => {
    const st = mem.r8(APP + 8), dir = mem.r32(APP + 4), cur = [mem.r8(APP + 0xE), mem.r8(APP + 0xF)], next = [mem.r8(APP + 0x12), mem.r8(APP + 0x13)];
    const k = `app state ${st} director ${dir ? S.who(mem.r32(dir)) : '-'} area ${cur} next ${next}`;
    if (k !== lastApp) { lastApp = k; console.log(`[field ${M.fields}, movie frame ${(M.fields / 2).toFixed(1)}, pad reads ${reads}]`, k); }
    // the director's state and Mario (gpMarDirector 0x8040A2A8: mState +0x64; gpMarioOriginal 0x8040A378: position +0x10, status +0x7C)
    const md = mem.r32(0x8040A2A8), ma = mem.r32(0x8040A378);
    const ds = md ? mem.r8(md + 0x64) : -1;
    const f = (a: number) => { const v = new DataView(new ArrayBuffer(4)); v.setUint32(0, mem.r32(a)); return v.getFloat32(0).toFixed(1); };
    const mk = ma ? `mario ${f(ma + 0x10)},${f(ma + 0x14)},${f(ma + 0x18)} st ${mem.r32(ma + 0x7C).toString(16)}` : 'no mario';
    const areaKey = `${mem.r8(APP + 0xE)},${mem.r8(APP + 0xF)}`;
    if (STAGES.length && stageNo + 1 < STAGES.length && (STAGE_AT_GAME[stageNo + 1] ? st === 5 : ds === 4) && mem.r8(APP + 0xE) !== 15 && areaKey !== stageArea) {
        stageArea = areaKey; STAGE4 = STAGES[++stageNo];
        stage4Field = M.fields; stage4Reads = reads; console.log(`  [field ${M.fields}] the stage's play begins: the movie from frame ${STAGE4}`);
        // DUMP=<folder>: from here every video frame's GPU commands (web/gxframe.ts) for tests/gxview.mjs, DUMPN of them
        // (DUMPSTAGE=n: from the n-th stage's start instead of the first's)
        if (process.env.DUMP && stageNo === +(process.env.DUMPSTAGE || 0)) {
            const out = process.env.DUMP, max = +(process.env.DUMPN || 6000); mkdirSync(out, { recursive: true });
            let seq = 0;
            M.hw.gx.onFrame = (fr) => { if (seq >= max) return; writeFileSync(`${out}/f_${String(seq).padStart(6, '0')}.gxf`, encodeGxFrame(fr)); if (++seq >= max) M.hw.gx.capture(false); };
            M.hw.gx.capture(true);
        }
    }
    if (ma && (mem.r32(ma + 0x7C) & 0x1FF) === 0x102 && !shineSeen) { shineSeen = true; console.log(`  SHINE GET at movie frame ${STAGE4 >= 0 && stage4Field >= 0 ? (STAGE4 + (M.fields - stage4Field) / 2).toFixed(1) : (M.fields / 2).toFixed(1)}`); }
    // the director's game mode (mGameMode +0x124: talk, demo) as it changes, with the stage's frame
    const gm = md ? mem.r8(md + 0x124) : -1;
    if (gm !== lastGm) { lastGm = gm; console.log(`  game mode ${gm} at stage frame ${stage4Field >= 0 ? ((M.fields - stage4Field) / 2).toFixed(1) : '-'} (stage ${stageNo})`); }
    // GK=<stage>: the gatekeepers' wake counter (TBiancoGateKeeper::unk17C) and water hit timer (unk154) per frame
    if (process.env.GK && stageNo === +process.env.GK && stage4Field >= 0 && (M.fields - stage4Field) % 2 === 0) {
        if ((M.fields - stage4Field) % 60 === 0) gks.length = 0;
        if (!gks.length) for (let a = 0x80400000; a < 0x81800000; a += 4) if (mem.r32(a) === 0x803DFDF4) gks.push(a);
        console.log(`  gk frame ${(M.fields - stage4Field) / 2}: ` + gks.map((g) => `${g.toString(16)} wake ${mem.r16(g + 0x17C) << 16 >> 16} hit ${mem.r32(g + 0x154) | 0}`).join(' | ') + ` | mario ${mk}`);
    }
    // FIXES=stage:frame:kind,...: corrections where the run parts from the TAS's own (the video's) at that stage frame.
    //   gkwake: the gatekeeper with the highest wake counter wakes (TBiancoGateKeeper::unk17C = 255)
    if (process.env.FIXES && stage4Field >= 0 && (M.fields - stage4Field) % 2 === 0) for (const f of process.env.FIXES.split(',')) {
        const [fs, ff, kind] = f.split(':');
        if (+fs !== stageNo || +ff !== (M.fields - stage4Field) / 2) continue;
        if (kind === 'gkwake') {
            let best = 0, bw = -1;
            for (let a = 0x80400000; a < 0x81800000; a += 4) if (mem.r32(a) === 0x803DFDF4) { const w = mem.r16(a + 0x17C) << 16 >> 16; if (w > bw) { bw = w; best = a; } }
            if (best) { mem.w16(best + 0x17C, 0xFF); mem.w16(best + 0x17E, 0x10); console.log(`  FIX stage ${fs} frame ${ff}: gatekeeper ${best.toString(16)} woken (its counter was ${bw})`); }
        }
    }
    const key = `dir ${ds} ${mk}`;
    if (key !== lastDir && (ds !== lastDs || M.fields % +(process.env.EVERY || 60) === 0)) { console.log(`  [movie frame ${(M.fields / 2).toFixed(1)}] ${key}`); lastDir = key; lastDs = ds; }
    // STACKAT=<field>[,<field>...]: every OS thread with its call stack then
    if (process.env.STACKAT && process.env.STACKAT.split(',').map(Number).includes(M.fields)) console.log(`THREADS at field ${M.fields}\n` + threads(M, S));
    M.after(M.hw.field, watch);
};
M.after(M.hw.field, watch);

const secs = +(process.argv[3] || 100);
const t0 = performance.now();
try { M.run(secs * 486e6); } catch (e) { console.log('STOP', String(e)); }
console.log(`drawSyncCallback ${dsc} times, GXPeekARGB ${peeks}`);
console.log(`ran ${(cpu.count / 486e6).toFixed(1)} s of game time in ${((performance.now() - t0) / 1000).toFixed(1)} s; fields ${M.fields}; pad reads ${reads}`);
