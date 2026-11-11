// Records everything the goop's exactness depends on while a trace replays, for tools/goopfit/sim.py:
// every goop draw (the stamps' quads with texture and height window, the models' triangles, the copies that end
// a layer's frame) and every goop test the game makes whose verdict the recording fixes (the random tests of
// TPollutionLayer::action, which decide how many rand() calls follow, and Mario's nine texels, which decide his
// dirty flag). While the replay is in step, the draws are the console's and so are the verdicts.
// Run: node v3goopcap.mjs <trace> <out.jsonl> [last tick]
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { readTrace } from '../game/trace.ts';
import { Replay, JP10 } from '../game/replay.ts';
import { symbols } from './syms.ts';
import { jpDisc, JP_DOL, loadBytes } from './jpdisc.ts';

const S = symbols();
const b = readFileSync(process.argv[2]);
const T = readTrace(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
const out = process.argv[3], last = +(process.argv[4] || 1e9);
const R = new Replay(loadBytes(JP_DOL), jpDisc(), T, JP10, (n) => S.byName.get(n), { log: (s) => { if (/^\[/.test(s)) console.log(s); }, fstPad: +(process.env.FSTPAD ?? (process.env.DISC ? 0 : 480)) });
const m = R.m, mem = m.mem, gx = m.hw.gx;
const sym = (n: string) => { const a = S.byName.get(n); if (a === undefined) throw new Error('no symbol ' + n); return a; };
const f32 = (a: number) => { const d = new DataView(new ArrayBuffer(4)); d.setUint32(0, mem.r32(a)); return d.getFloat32(0); };
const idx = (x: number, z: number, l2w: number) => (z & 3) * 8 + ((x >> 3) + ((z >> 2) << (l2w - 3))) * 0x20 + (x & 7);
interface Layer { i: number; L: number; map: number; hmap: number; w: number; h: number; l2w: number; thr: number; delta: number; cthr: number; minX: number; minZ: number; inv: number; frames: number }
let layers: Layer[] = [];
const findLayers = () => {
    const pol = mem.r32(JP10.gpPollution); if (!pol) return;
    const n = mem.r32(pol + 0x10), arr = mem.r32(pol + 0x14);
    layers = [];
    for (let i = 0; i < n; i++) { const L = mem.r32(arr + 4 * i); layers.push({ i, L, map: mem.r32(L + 0x54), hmap: mem.r32(L + 0x78), w: mem.r32(L + 0x5C), h: mem.r32(L + 0x60), l2w: mem.r32(L + 0x64), thr: mem.r8(L + 0x50), delta: mem.r8(L + 0x84), cthr: mem.r8(L + 0x85), minX: f32(L + 0x38), minZ: f32(L + 0x40), inv: f32(L + 0x74), frames: 0 }); }
};
let buf: string[] = [];
const put = (o: unknown) => { buf.push(JSON.stringify(o)); if (buf.length > 5000) flush(); };
const flush = () => { if (buf.length) { appendFileSync(out, buf.join('\n') + '\n'); buf = []; } };
writeFileSync(out, '');
const bytes = (l: Layer, base: number) => { const o: number[] = []; for (let z = 0; z < l.h; z++) for (let x = 0; x < l.w; x++) o.push(mem.r8(base + idx(x, z, l.l2w))); return Buffer.from(o).toString('base64'); };
let started = false;
const texSeen = new Set<number>();
const r3 = (v: number) => Math.round(v * 1e6) / 1e6;
// ---- the draws
gx.drawTrace = (prim, count, v) => {
    if (!started) { findLayers(); if (!layers.length) return; started = true; put({ k: 'init', layers: layers.map((l) => ({ i: l.i, w: l.w, h: l.h, thr: l.thr, delta: l.delta, cthr: l.cthr, minX: l.minX, minZ: l.minZ, inv: l.inv, map: bytes(l, l.map), hmap: bytes(l, l.hmap) })) }); }
    const bp = gx.bp, stages = ((bp[0] >>> 10) & 15) + 1, blend = bp[0x41], tex0 = (bp[0x94] << 5) & 0x03FFFFFF, tex1 = (bp[0x95] << 5) & 0x03FFFFFF;
    const common = { t: R.ticks, stages, blend, z: bp[0x40], at: bp[0xF3] };
    if (prim === 0x80 && count === 4) {
        const xs = [v[0].x, v[1].x, v[2].x, v[3].x], ys = [v[0].y, v[1].y, v[2].y, v[3].y];
        const q = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(r3);
        // which corner has the texture's origin (the stamps: the first vertex, top left)
        if (stages === 3 && !texSeen.has(tex0)) {
            // (a stamp's texture: 8-bit intensity in blocks of 8 x 4)
            texSeen.add(tex0);
            const tw = (bp[0x88] & 0x3FF) + 1, th = ((bp[0x88] >>> 10) & 0x3FF) + 1, fmt = (bp[0x88] >>> 20) & 15, o: number[] = [];
            if (fmt === 1) for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) o.push(mem.r8(0x80000000 + tex0 + ((y >> 2) * (tw >> 3) + (x >> 3)) * 32 + (y & 3) * 8 + (x & 7)));
            put({ k: 'tex', addr: tex0, w: tw, h: th, fmt, data: Buffer.from(o).toString('base64') });
        }
        if (stages === 3) put({ k: 's', ...common, q, tex: tex0, tw: (bp[0x88] & 0x3FF) + 1, th: ((bp[0x88] >>> 10) & 0x3FF) + 1, mode: bp[0x80], c0: gx.tevReg[7], c1: gx.tevReg[11], type: ((bp[0xC4] >>> 12) & 15) === 8 ? 0 : 1, uv: [v[0].s[0], v[0].t[0], v[2].s[0], v[2].t[0]], v0: [r3(v[0].x), r3(v[0].y)] });
        else put({ k: 'q', ...common, q, tex0, tex1, gens: bp[0] & 15, cenv: bp[0xC0], aenv: bp[0xC1], reg: Array.from(gx.tevReg), col: Array.from(v[0].c).slice(0, 4) });
    } else {
        // (a model: its triangles, as the rasteriser gets them)
        const tri = (a: number, b: number, c: number) => put({ k: 'm', ...common, v: [a, b, c].map((i) => [r3(v[i].x), r3(v[i].y), v[i].c[0], v[i].c[3]]), cull: (bp[0] >>> 14) & 3 });
        if (prim === 0x90) for (let i = 0; i + 2 < count; i += 3) tri(i, i + 1, i + 2);
        else if (prim === 0x98) for (let i = 2; i < count; i++) { if (i & 1) tri(i - 1, i - 2, i); else tri(i - 2, i - 1, i); }
        else if (prim === 0xA0) for (let i = 2; i < count; i++) tri(0, i - 1, i);
        else if (prim === 0x80 || prim === 0x88) for (let i = 0; i + 3 < count; i += 4) { tri(i, i + 1, i + 2); tri(i, i + 2, i + 3); }
        else put({ k: '?', ...common, prim, count });
    }
};
gx.copyTrace = (dst) => { const l = layers.find((q) => (q.map & 0x03FFFFFF) === dst); put({ k: 'c', t: R.ticks, layer: l ? l.i : -1, dst }); if (l) l.frames++; };
// ---- the tests: isSame (the texel and whether its height fits), under the manager's isPolluted or a layer's action
let ctx = '', group = 0, attempt = 0, lastSame: { layer: number; x: number; z: number } | null = null;
// (isSame's result is read where TPollutionLayer::isPolluted gets it back: JP 1.0, +0xD4)
const sameRet = sym('isPolluted__15TPollutionLayerCFfff') + 0xD4;
m.cpu.hook(sym('isSame__13TPollutionPosCFiif'), (c) => {
    const l = layers.find((q) => q.L + 0x5C === c.gpr[3]);
    lastSame = l && c.lr === sameRet ? { layer: l.i, x: c.gpr[4] | 0, z: c.gpr[5] | 0 } : null;
    return false;
});
m.cpu.hook(sameRet, (c) => { same(c.gpr[3] & 0xFF); return false; });
function same(ok: number) {
    const s = lastSame; lastSame = null;
    if (!s || !ctx) return;
    const l = layers[s.layer], inside = s.x >= 0 && s.z >= 0 && s.x < l.w && s.z < l.h;
    put({ k: 't', t: R.ticks, ctx, group, n: attempt++, layer: s.layer, x: s.x, z: s.z, hok: ok ? 1 : 0, frames: l.frames, val: inside ? mem.r8(l.map + idx(s.x, s.z, l.l2w)) : -1, call: (R as any).calls + (R as any).literals });
}
const action = sym('action__15TPollutionLayerFv'), graffito = sym('checkGraffito__6TMarioFv');
const rets = (a: number, size: number, f: () => void) => { for (let p = a; p < a + size; p += 4) if (mem.r32(p) === 0x4E800020) m.cpu.hook(p, () => { f(); return false; }); };
m.cpu.hook(action, (c) => { const l = layers.find((q) => q.L === c.gpr[3]); ctx = 'A'; group++; attempt = 0; put({ k: 'a', t: R.ticks, group, layer: l ? l.i : -1, call: (R as any).calls + (R as any).literals }); return false; });
rets(action, 0x3CC, () => { put({ k: 'e', group, call: (R as any).calls + (R as any).literals }); ctx = ''; });
m.cpu.hook(graffito, () => { ctx = 'M'; group++; attempt = 0; return false; });
rets(graffito, 0x5D8, () => { if (ctx === 'M') { const mario = mem.r32(JP10.gpMarioOriginal); put({ k: 'g', t: R.ticks, group, dirty: (mem.r32(mario + 0x118) >>> 6) & 1, x: f32(mario + 0x10), y: f32(mario + 0x14), z: f32(mario + 0x18) }); } ctx = ''; });
// (each of Mario's nine places is one call of the manager's isPolluted: a new place)
m.cpu.hook(sym('isPolluted__17TPollutionManagerCFfff'), () => { if (ctx === 'M') put({ k: 'p', group }); return false; });

const timer = setInterval(() => { }, 1000);
let r: string = 'budget';
while (m.cpu.count < 200e9 && (r = R.run(200e6)) !== 'done' && R.ticks <= last) { /* on */ }
clearInterval(timer);
put({ k: 'end', result: r, ticks: R.ticks, issues: R.issues.map((i: any) => ({ kind: i.kind, tick: i.tick, text: String(i.text).split('\n')[0], call: (R as any).calls + (R as any).literals })) });
flush();
console.log(r, 'ticks', R.ticks, 'issues', R.issues.length, R.issues[0] ? String((R.issues[0] as any).text).split('\n')[0] : '');
process.exit(0);
