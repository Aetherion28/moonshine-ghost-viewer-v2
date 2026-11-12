// (a tool for the v2 goop port) plays a trace and prints, for the frames of the ticks asked for, every GPU command
// the game sends while it draws the goop (what ppc/gx.ts rasterises): register loads decoded, primitives with
// their vertices' bytes, the copies. Run: node goopstream.mjs <trace> <from tick> <to tick>   (env FSTPAD, default 480)
import { readFileSync } from 'node:fs';
import { readTrace } from '../game/trace.ts';
import { Replay, JP10 } from '../game/replay.ts';
import { symbols } from './syms.ts';
import { jpDisc, JP_DOL, loadBytes } from './jpdisc.ts';
const S = symbols();
const b = readFileSync(process.argv[2]);
const T = readTrace(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
const from = +process.argv[3], to = +process.argv[4];
const R = new Replay(loadBytes(JP_DOL), jpDisc(), T, JP10, (n) => S.byName.get(n), { log: () => {}, fstPad: +(process.env.FSTPAD ?? 480) });
const gx = R.m.hw.gx;
const hx = (v: number, n = 8) => (v >>> 0).toString(16).padStart(n, '0');
const F = new Float32Array(1), W = new Uint32Array(F.buffer);
const fl = (v: number) => { W[0] = v; return +F[0].toPrecision(9); };
gx.rec = (c, raster) => {
    if (R.ticks < from || R.ticks > to || !raster) return;
    const r32 = (p: number) => ((c[p] << 24) | (c[p + 1] << 16) | (c[p + 2] << 8) | c[p + 3]) >>> 0;
    if (c[0] === 0x61) console.log(`t${R.ticks} BP ${hx(c[1], 2)} ${hx(r32(1) & 0xFFFFFF, 6)}`);
    else if (c[0] === 0x08) console.log(`t${R.ticks} CP ${hx(c[1], 2)} ${hx(r32(2))}`);
    else if (c[0] === 0x10) { const n = (c[2] & 15) + 1, a = (c[3] << 8) | c[4]; const v: string[] = []; for (let i = 0; i < n; i++) v.push(a + i < 0x1000 || (a + i >= 0x101A && a + i <= 0x1025) ? String(fl(r32(5 + 4 * i))) : hx(r32(5 + 4 * i))); console.log(`t${R.ticks} XF ${hx(a, 4)} x${n} ${v.join(' ')}`); }
    else if (c[0] & 0x80) { const n = (c[1] << 8) | c[2], sz = (c.length - 3) / n; const rows: string[] = []; for (let i = 0; i < n && i < 12; i++) rows.push(Buffer.from(c.subarray(3 + i * sz, 3 + (i + 1) * sz)).toString('hex')); console.log(`t${R.ticks} PRIM ${hx(c[0], 2)} x${n} (${sz} bytes each) ${rows.join(' ')}${n > 12 ? ' ...' : ''}`); }
    else console.log(`t${R.ticks} ?? ${Buffer.from(c).toString('hex').slice(0, 60)}`);
};
// JSONL=<file>: one line per primitive (and per copy) with the registers as they stand then
import { appendFileSync, writeFileSync } from 'node:fs';
if (process.env.JSONL) {
    writeFileSync(process.env.JSONL, '');
    const prev = gx.rec!;
    gx.rec = (c, raster) => {
        if (!(R.ticks < from || R.ticks > to || !raster)) {
            const isCopy = c[0] === 0x61 && c[1] === 0x52;
            if ((c[0] & 0x80) || isCopy) {
                const bp = Array.from(gx.bp), xf = Array.from(gx.xfw.subarray(0x1000, 0x1058)), cp = Array.from(gx.cp);
                const mi = gx.xfw[0x1018] & 63;
                const row = { tick: R.ticks, kind: isCopy ? 'copy' : 'prim', cmd: c[0], count: isCopy ? 0 : (c[1] << 8) | c[2], data: Buffer.from(isCopy ? c.subarray(1) : c.subarray(3)).toString('hex'), bp, xf, cp,
                    pos: Array.from(gx.xfw.subarray(mi * 4, mi * 4 + 12)), mem0: Array.from(gx.xfw.subarray(0, 0x100)), tevReg: Array.from((gx as any).tevReg), konst: Array.from((gx as any).konst) };
                appendFileSync(process.env.JSONL!, JSON.stringify(row) + '\n');
            }
        }
        if (!process.env.QUIETSTREAM) prev(c, raster);
    };
}
gx.recAll = false;
while (R.ticks <= to && R.run(200e6) !== 'done');
console.log(`the replay: tick ${R.ticks}, ${R.issues.length} issue(s)`);
