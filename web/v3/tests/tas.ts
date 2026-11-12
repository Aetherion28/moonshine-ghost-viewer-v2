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

const S = symbols();
const M = new Machine(), cpu = M.cpu, mem = M.mem;
M.load(loadBytes(JP_DOL), jpDisc());
installHle(M, (n) => S.byName.get(n), { report: (t) => { if (process.env.GAMELOG) process.stdout.write('[game] ' + t); } });

const dtm = readFileSync(process.argv[2]);
const POLLS = (dtm.length - 0x100) >> 3;
const poll = (i: number) => dtm.subarray(0x100 + 8 * i, 0x108 + 8 * i);
const OFFSET = +(process.env.OFFSET || 0), STAGE4 = +(process.env.STAGE4 || -1);
let stage4Field = -1;
// Dolphin's ControllerState to the SDK's PADStatus (12 bytes: buttons, stick x y, C x y, triggers L R, analog A B, err)
const BITS: [number, number, number][] = [[0, 0x01, 0x1000], [0, 0x02, 0x100], [0, 0x04, 0x200], [0, 0x08, 0x400], [0, 0x10, 0x800], [0, 0x20, 0x10],
    [0, 0x40, 0x8], [0, 0x80, 0x4], [1, 0x01, 0x1], [1, 0x02, 0x2], [1, 0x04, 0x40], [1, 0x08, 0x20]];
let reads = 0, lastButtons = -1;
const PADRead = S.byName.get('PADRead')!;
cpu.hook(PADRead, (c) => {
    const p = c.gpr[3];
    for (let i = 0; i < 48; i++) mem.w8(p + i, 0);
    for (let ch = 1; ch < 4; ch++) mem.w8(p + ch * 12 + 10, 0xFF);   // PAD_ERR_NO_CONTROLLER
    // STAGE4=<movie frame>: from the first frame of the stage's play (TMarDirector state 4) the movie is read from that frame on
    const k = Math.min(POLLS - 1, Math.max(0, stage4Field >= 0 ? STAGE4 * 6 + (M.fields - stage4Field) * 3 + 2 + OFFSET : M.fields * 3 + 2 + OFFSET));
    const s = poll(k);
    let b = 0; for (const [byte, bit, pad] of BITS) if (s[byte] & bit) b |= pad;
    mem.w16(p, b); mem.w8(p + 2, s[4] - 128); mem.w8(p + 3, s[5] - 128); mem.w8(p + 4, s[6] - 128); mem.w8(p + 5, s[7] - 128);
    mem.w8(p + 6, s[2]); mem.w8(p + 7, s[3]);
    reads++;
    if (process.env.LOG && b !== lastButtons) console.log(`  field ${M.fields} poll ${k} (movie frame ${(k / 6).toFixed(1)}) buttons ${b.toString(16)}`);
    lastButtons = b;
    c.gpr[3] = 0; c.pc = c.lr; return true;
});

// the application's state (TApplication gpApplication, JP 0x803E6000), reported as it changes
const APP = 0x803E6000;
let lastApp = '', lastDir = '', lastDs = -2, shineSeen = false;
const watch = () => {
    const st = mem.r8(APP + 8), dir = mem.r32(APP + 4), cur = [mem.r8(APP + 0xE), mem.r8(APP + 0xF)], next = [mem.r8(APP + 0x12), mem.r8(APP + 0x13)];
    const k = `app state ${st} director ${dir ? S.who(mem.r32(dir)) : '-'} area ${cur} next ${next}`;
    if (k !== lastApp) { lastApp = k; console.log(`[field ${M.fields}, movie frame ${(M.fields / 2).toFixed(1)}, pad reads ${reads}]`, k); }
    // the director's state and Mario (gpMarDirector 0x8040A2A8: mState +0x64; gpMarioOriginal 0x8040A378: position +0x10, status +0x7C)
    const md = mem.r32(0x8040A2A8), ma = mem.r32(0x8040A378);
    const ds = md ? mem.r8(md + 0x64) : -1;
    const f = (a: number) => { const v = new DataView(new ArrayBuffer(4)); v.setUint32(0, mem.r32(a)); return v.getFloat32(0).toFixed(1); };
    const mk = ma ? `mario ${f(ma + 0x10)},${f(ma + 0x14)},${f(ma + 0x18)} st ${mem.r32(ma + 0x7C).toString(16)}` : 'no mario';
    if (STAGE4 >= 0 && stage4Field < 0 && ds === 4 && mem.r8(APP + 0xE) === 0) {
        stage4Field = M.fields; console.log(`  [field ${M.fields}] the stage's play begins: the movie from frame ${STAGE4}`);
        // DUMP=<folder>: from here every video frame's GPU commands (web/gxframe.ts) for tests/gxview.mjs, DUMPN of them
        if (process.env.DUMP) {
            const out = process.env.DUMP, max = +(process.env.DUMPN || 6000); mkdirSync(out, { recursive: true });
            let seq = 0;
            M.hw.gx.onFrame = (fr) => { if (seq >= max) return; writeFileSync(`${out}/f_${String(seq).padStart(6, '0')}.gxf`, encodeGxFrame(fr)); if (++seq >= max) M.hw.gx.capture(false); };
            M.hw.gx.capture(true);
        }
    }
    if (ma && (mem.r32(ma + 0x7C) & 0x1FF) === 0x102 && !shineSeen) { shineSeen = true; console.log(`  SHINE GET at movie frame ${STAGE4 >= 0 && stage4Field >= 0 ? (STAGE4 + (M.fields - stage4Field) / 2).toFixed(1) : (M.fields / 2).toFixed(1)}`); }
    const key = `dir ${ds} ${mk}`;
    if (key !== lastDir && (ds !== lastDs || M.fields % +(process.env.EVERY || 60) === 0)) { console.log(`  [movie frame ${(M.fields / 2).toFixed(1)}] ${key}`); lastDir = key; lastDs = ds; }
    M.after(M.hw.field, watch);
};
M.after(M.hw.field, watch);

const secs = +(process.argv[3] || 100);
const t0 = performance.now();
try { M.run(secs * 486e6); } catch (e) { console.log('STOP', String(e)); }
console.log(`ran ${(cpu.count / 486e6).toFixed(1)} s of game time in ${((performance.now() - t0) / 1000).toFixed(1)} s; fields ${M.fields}; pad reads ${reads}`);
