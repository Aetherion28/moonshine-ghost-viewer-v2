// (debugging) plays a trace and prints, between two ticks, the goop under Mario and what the GPU model draws.
// Run: node v3goopdbg.mjs <trace> <from tick> <to tick>
import { readFileSync } from 'node:fs';
import { readTrace } from '../game/trace.ts';
import { Replay, JP10 } from '../game/replay.ts';
import { symbols } from './syms.ts';
import { jpDisc, JP_DOL, loadBytes } from './jpdisc.ts';

const S = symbols();
const b = readFileSync(process.argv[2]);
const T = readTrace(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
const from = +process.argv[3], to = +process.argv[4];
const R = new Replay(loadBytes(JP_DOL), jpDisc(), T, JP10, (n) => S.byName.get(n), { log: (s) => { if (/^\[/.test(s)) console.log(s); }, fstPad: +(process.env.FSTPAD || 480), stopOn: process.env.ALL ? ['heap', 'layout'] : undefined });
const m = R.m, mem = m.mem, gx = m.hw.gx;
const f32 = (a: number) => { const d = new DataView(new ArrayBuffer(4)); d.setUint32(0, mem.r32(a)); return d.getFloat32(0); };
let lastTick = -1;
if (process.env.EARLY) { const [li, tx, tz] = process.env.EARLY.split(',').map(Number); let n = 0; const val = () => { const l = layers()[li]; return l ? mem.r8(l.map + idx(tx, tz, l.l2w)) : -1; }; m.cpu.hook(JP10.goopLayerDraw + 4, (c) => { if (n++ < 40) console.log(`layer draw ${c.gpr[4]} at count ${c.count} tick ${R.ticks}: texel = ${val()}`); return false; }); gx.trace = (s) => { if (n < 40 && /^copy|stages 2/.test(s)) console.log('   ' + s.slice(0, 200) + ' texel ' + val()); }; }
const layers = () => {
    const pol = mem.r32(JP10.gpPollution); if (!pol) return [];
    const n = mem.r32(pol + 0x10), arr = mem.r32(pol + 0x14), out = [];
    for (let i = 0; i < n; i++) {
        const L = mem.r32(arr + 4 * i);
        out.push({ i, L, type: mem.r16(L + 0x30), flags: mem.r16(L + 0x32), counter: mem.r32(L + 0x34), minX: f32(L + 0x38), maxX: f32(L + 0x3C), minZ: f32(L + 0x40), maxZ: f32(L + 0x44), map: mem.r32(L + 0x54),
            w: mem.r32(L + 0x5C), h: mem.r32(L + 0x60), l2w: mem.r32(L + 0x64), voff: f32(L + 0x6C), inv: f32(L + 0x74), hmap: mem.r32(L + 0x78), thr: mem.r8(L + 0x50), delta: mem.r8(L + 0x84), cthr: mem.r8(L + 0x85) });
    }
    return out;
};
const idx = (x: number, z: number, l2w: number) => (z & 3) * 8 + ((x >> 3) + ((z >> 2) << (l2w - 3))) * 0x20 + (x & 7);
const timer = setInterval(() => { }, 1000);
const hookTick = () => {
    const t = R.ticks;
    if (t === lastTick) return; lastTick = t;
    if (t === from && process.env.WATCH) {
        // every pixel drawn at one place of the frame buffer, with the draw it belongs to
        const [wx, wy] = process.env.WATCH.split(',').map(Number);
        let cur = '';
        gx.trace = (s) => { cur = s.replace(/ \|.*/, '').slice(0, 150); if (/^copy/.test(s)) console.log(`  gx@${R.ticks}: ${s}`); };
        gx.pixelTrace = (p) => { if (p.startsWith(`px ${wx},${wy} `)) console.log(`  gx@${R.ticks}: ${cur}\n      ${p}`); };
    } else if (t === from) { gx.trace = (s) => { console.log(`  gx@${R.ticks}: ${s}`); gx.pixelTrace = process.env.PX && /stages 3/.test(s) && new RegExp(process.env.PX).test(s) ? (p) => console.log('      ' + p) : null; }; console.log(layers().map((l) => `layer ${l.i}: type ${l.type} flags ${l.flags.toString(16)} ${l.w}x${l.h} x ${l.minX}..${l.maxX} z ${l.minZ}..${l.maxZ} inv ${l.inv} voff ${l.voff} thr ${l.thr} delta ${l.delta} cthr ${l.cthr} counter ${l.counter}`).join('\n')); }
    if (t < from || t > to) return;
    const mario = mem.r32(JP10.gpMarioOriginal), x = f32(mario + 0x10), y = f32(mario + 0x14), z = f32(mario + 0x18);
    const rec = T.ticks[t - 1]?.mario, rd = rec ? new DataView(rec.buffer, rec.byteOffset) : null;
    let line = `tick ${t} mario ${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)} flag ${mem.r32(mario + 0x118).toString(16)}${rd ? '/' + rd.getUint32(0x118).toString(16) : ''} +134 ${f32(mario + 0x134)}${rd ? '/' + rd.getFloat32(0x134) : ''}`;
    for (const l of layers()) {
        if (x < l.minX || x > l.maxX || z < l.minZ || z > l.maxZ) continue;
        const tx = Math.trunc((x - l.minX) * l.inv), tz = Math.trunc((z - l.minZ) * l.inv);
        const row = (dz: number) => [-2, -1, 0, 1, 2].map((dx) => mem.r8(l.map + idx(tx + dx, tz + dz, l.l2w)).toString().padStart(3)).join(' ');
        line += `\n   layer ${l.i} texel ${tx},${tz} height ${mem.r8(l.hmap + idx(tx, tz, l.l2w))} depth(y) ${Math.trunc((y - l.voff) * 0.025)} counter ${l.counter}\n     ${row(-2)}\n     ${row(-1)}\n     ${row(0)}\n     ${row(1)}\n     ${row(2)}`;
    }
    if (process.env.TEXEL) { const [li, tx, tz] = process.env.TEXEL.split(',').map(Number), l = layers()[li]; if (l) line += ` | texel ${tx},${tz} = ${mem.r8(l.map + idx(tx, tz, l.l2w))} height ${mem.r8(l.hmap + idx(tx, tz, l.l2w))}`; }
    console.log(line);
};
m.cpu.hook(JP10.marioPerform + 4, () => { hookTick(); return false; });
let r: string = 'budget';
const end = 100e9;
while (m.cpu.count < end && (r = R.run(200e6)) !== 'done' && R.ticks <= to + 1) { /* on */ }
clearInterval(timer);
console.log(r, 'ticks', R.ticks, 'issues', R.issues.length);
process.exit(0);
