// v3: checks a dump of GPU frames (tests/gxdump.ts, web/gxframe.ts) the way a page that draws them uses it: a
// mirror of the game's RAM that only the patches fill, the registers, and the commands walked in order. Every read
// of memory a command makes (a display list, a vertex array through an index, a matrix loaded by index, a texture
// image, a palette) must be of bytes a patch has delivered (or a frame buffer copy has written: the page's own).
// Run: node gxcheck.mjs <folder> [frames to list, default 5]     (env: ALL=1 lists every frame; ORDER=n lists the
//   frame buffer copies of the dump's n-th frame in their order, with the primitives drawn before each)
// Prints what is missing, the totals a frame, and what a renderer wants to know of the frames (the viewport and
// scissor, the frame buffer copies, the texture formats).
import { readFileSync, readdirSync } from 'node:fs';
import { decodeGxFrame } from '../web/gxframe.ts';

const dir = process.argv[2], listN = process.env.ALL ? Infinity : +(process.argv[3] || 5);
if (!dir) { console.log('usage: node gxcheck.mjs <folder>'); process.exit(2); }
const files = readdirSync(dir).filter((n: string) => n.endsWith('.gxf')).sort();

const RAM = 0x01800000;
const ram = new Uint8Array(RAM), have = new Uint8Array(RAM);
let cp = new Uint32Array(256), bp = new Uint32Array(256), xfw = new Uint32Array(0x1100), bpMask = 0xFFFFFF;
const r32 = (b: Uint8Array, p: number) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const fw = new Uint32Array(1), ff = new Float32Array(fw.buffer);
const f32 = (w: number) => { fw[0] = w; return ff[0]; };
const hex = (v: number) => v.toString(16);

// ---- what is missing
const missing = new Map<string, { reads: number; bytes: number; first: string }>();
let frameNo = 0, cmdAt = 0;
/** the ranges found whole so far, by their start: their length (what was delivered stays delivered) */
const whole = new Map<number, number>();
function need(kind: string, a: number, n: number) {
    if (n <= 0) return;
    if (a < 0 || a + n > RAM) { note(kind + ' (outside RAM)', n, a); return; }
    const was = whole.get(a) || 0;
    if (was >= n) return;
    let miss = 0;
    for (let i = a + was; i < a + n; i++) if (!have[i]) miss++;
    if (miss) note(kind, miss, a); else whole.set(a, n);
}
function note(kind: string, bytes: number, a: number) {
    const m = missing.get(kind) || { reads: 0, bytes: 0, first: `frame file ${frameNo}, command at ${cmdAt}, memory 0x${hex(0x80000000 + a)}` };
    m.reads++; m.bytes += bytes; missing.set(kind, m);
}

// ---- vertex formats: a vertex's size and its indexed attributes (offset, index bytes, array, bytes of an element)
const COMP = [1, 1, 2, 2, 4, 4, 4, 4], COLOR = [2, 3, 4, 2, 3, 4, 4, 4];
function format(vat: number) {
    const lo = cp[0x50], hi = cp[0x60], a = cp[0x70 + vat], b = cp[0x80 + vat], c = cp[0x90 + vat];
    let off = 0;
    const idx: { off: number; n: number; array: number; size: number }[] = [];
    for (let i = 0; i < 9; i++) if (lo & (1 << i)) off++;   // the matrix indexes
    const put = (how: number, array: number, size: number, times = 1) => {
        if (how === 1) off += size;
        else if (how) for (let i = 0; i < times; i++) { idx.push({ off, n: how - 1, array, size }); off += how - 1; }
    };
    put((lo >>> 9) & 3, 0, (a & 1 ? 3 : 2) * COMP[(a >>> 1) & 7]);
    const nbt = (a >>> 9) & 1;
    put((lo >>> 11) & 3, 1, (nbt ? 9 : 3) * COMP[(a >>> 10) & 7], nbt && (a >>> 31) ? 3 : 1);
    put((lo >>> 13) & 3, 2, COLOR[(a >>> 14) & 7]);
    put((lo >>> 15) & 3, 3, COLOR[(a >>> 18) & 7]);
    const tf = [[a, 21, a, 22], [b, 0, b, 1], [b, 9, b, 10], [b, 18, b, 19], [b, 27, b, 28], [c, 5, c, 6], [c, 14, c, 15], [c, 23, c, 24]];
    for (let i = 0; i < 8; i++) put((hi >>> (2 * i)) & 3, 4 + i, ((tf[i][0] >>> tf[i][1]) & 1 ? 2 : 1) * COMP[(tf[i][2] >>> tf[i][3]) & 7]);
    return { size: off, idx };
}

// ---- textures
function texBytes(fmt: number, w: number, h: number, levels: number) {
    const per: Record<number, [number, number, number]> = { 0: [8, 8, 32], 8: [8, 8, 32], 14: [8, 8, 32], 1: [8, 4, 32], 2: [8, 4, 32], 9: [8, 4, 32], 3: [4, 4, 32], 4: [4, 4, 32], 5: [4, 4, 32], 10: [4, 4, 32], 6: [4, 4, 64] };
    const f = per[fmt];
    if (!f) return -1;
    let n = 0;
    for (let l = 0; l < levels; l++) { n += Math.ceil(w / f[0]) * Math.ceil(h / f[1]) * f[2]; w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
    return n;
}
const FMT = ['I4', 'I8', 'IA4', 'IA8', 'RGB565', 'RGB5A3', 'RGBA8', '7', 'C4', 'C8', 'C14X2', '11', '12', '13', 'CMPR', '15'];
const texFormats = new Map<string, number>(), texFromCopy = new Map<string, number>();
/** the textures frame buffer copies wrote, by address: as what, how many bytes, how often, and how often a patch brought the memory's own bytes after one */
const copyDst = new Map<number, { what: string; n: number; copies: number; sent: number; fresh: boolean }>();
const viewports = new Map<string, number>(), scissors = new Map<string, number>(), texCopies = new Map<string, number>(), xfbCopies = new Map<string, number>();
const bpUsed = new Uint8Array(256);
/** (ORDER) the copies of the frame asked for, in order */
const orderOf = process.env.ORDER === undefined ? -1 : +process.env.ORDER, order: string[] = [];
let primsAtCopy = 0;
let vpOf: number[] = [], vp = '', scOf: number[] = [], sc = '';
let stat = { prims: 0, verts: 0, lists: 0, xfIdx: 0, tluts: 0, texCopies: 0, xfbCopies: 0, cmds: 0 };
function textures() {
    let maps = 0;
    const stages = ((bp[0] >>> 10) & 15) + 1, ind = (bp[0] >>> 16) & 7;
    for (let s = 0; s < stages; s++) { const o = bp[0x28 + (s >> 1)] >>> ((s & 1) * 12); if (o & 0x40) maps |= 1 << (o & 7); }
    for (let i = 0; i < ind; i++) maps |= 1 << ((bp[0x27] >>> (6 * i)) & 7);
    for (let i = 0; i < 8; i++) {
        if (!(maps & (1 << i))) continue;
        const r = i < 4 ? i : 0x20 + i - 4, i0 = bp[0x88 + r], w = (i0 & 0x3FF) + 1, h = ((i0 >>> 10) & 0x3FF) + 1, fmt = (i0 >>> 20) & 15;
        const mips = ((bp[0x80 + r] >>> 5) & 3) !== 0, levels = mips ? Math.min(Math.floor(Math.log2(Math.max(w, h))) + 1, Math.floor((((bp[0x84 + r] >>> 8) & 0xFF) + 15) / 16) + 1) : 1;
        const a = (bp[0x94 + r] << 5) & 0x03FFFFFF, n = texBytes(fmt, w, h, levels);
        const key = FMT[fmt] + (mips ? ' with mipmaps' : '');
        texFormats.set(key, (texFormats.get(key) || 0) + 1);
        if (n < 0) { note(`a texture of format ${fmt}`, 0, a); continue; }
        if (copyDst.has(a)) { const k = `0x${hex(0x80000000 + a)} ${w}x${h} ${FMT[fmt]} (copied as ${copyDst.get(a)!.what})`; texFromCopy.set(k, (texFromCopy.get(k) || 0) + 1); }
        need('texture image', a, n);
    }
}

// ---- the commands
function bpLoad(word: number) {
    const reg = word >>> 24, v = ((bp[reg] & ~bpMask) | (word & bpMask)) & 0xFFFFFF;
    bpUsed[reg] = 1;
    if (reg === 0xFE) { bpMask = word & 0xFFFFFF; return; }
    bpMask = 0xFFFFFF; bp[reg] = v;
    if (reg === 0x65) { stat.tluts++; need('palette', (bp[0x64] << 5) & 0x01FFFFFF, ((v >>> 10) & 0x7FF) * 32); }
    if (reg === 0x52) {
        const x = bp[0x49] & 0x3FF, y = (bp[0x49] >>> 10) & 0x3FF, w = (bp[0x4A] & 0x3FF) + 1, h = ((bp[0x4A] >>> 10) & 0x3FF) + 1;
        if (frameNo === orderOf) {
            order.push(`  at ${cmdAt}: ${stat.prims - primsAtCopy} primitives (last viewport ${vp || 'none'}), then a copy ${v & 0x4000 ? 'to the display' : `to the texture at 0x${hex(0x80000000 + ((bp[0x4B] << 5) & 0x03FFFFFF))}`} from ${x},${y} ${w}x${h}, control 0x${hex(v)}${v & 0x800 ? `, clearing to colour ${hex(bp[0x4F] & 0xFFFF)} ${hex(bp[0x50] & 0xFFFF)} depth ${hex(bp[0x51])} (colour ${(bp[0x41] >>> 3) & 1}, alpha ${(bp[0x41] >>> 4) & 1}, depth ${(bp[0x40] >>> 4) & 1} written)` : ''}; pixel format ${bp[0x43] & 7}`);
            primsAtCopy = stat.prims;
        }
        if (v & 0x4000) {
            stat.xfbCopies++;
            const k = `from ${x},${y} ${w}x${h} to 0x${hex(0x80000000 + ((bp[0x4B] << 5) & 0x03FFFFFF))}, clear ${(v >>> 11) & 1}, control 0x${hex(v)}, y scale 0x${hex(bp[0x4E] & 0x1FF)}`;
            xfbCopies.set(k, (xfbCopies.get(k) || 0) + 1);
        } else {
            stat.texCopies++;
            const f = (v >>> 3) & 15, fmt = (f >> 1) + (f & 1) * 8, half = (v >>> 9) & 1, a = (bp[0x4B] << 5) & 0x03FFFFFF;
            const as = [0, 1, 2, 3, 4, 5, 6, 1, 1, 1, 1, 3, 3][fmt], n = as === undefined ? 0 : texBytes(as, w >> half, h >> half, 1);
            const what = `format ${fmt}${(bp[0x43] & 7) === 3 ? ' of the depth buffer' : ''}${v & 0x8000 ? ' as intensity' : ''}${half ? ' at half size' : ''}`;
            const k = `from ${x},${y} ${w}x${h} to 0x${hex(0x80000000 + a)}, ${what}, clear ${(v >>> 11) & 1}`;
            texCopies.set(k, (texCopies.get(k) || 0) + 1);
            const d = copyDst.get(a) || { what, n, copies: 0, sent: 0, fresh: false };
            d.what = what; d.n = n; d.copies++; d.fresh = true; copyDst.set(a, d);
            // (the copy writes the texture's memory: the page's own copy stands for it)
            if (a + n <= RAM) have.fill(1, a, a + n);
        }
    }
}
function run(b: Uint8Array, p: number, end: number, inList: boolean, before: ((p: number) => void) | null): number {
    while (p < end) {
        if (before) before(p);
        const cmd = b[p];
        if (cmd === 0) { p++; continue; }
        if (!inList) cmdAt = p;
        stat.cmds++;
        if (cmd & 0x80) {
            const count = (b[p + 1] << 8) | b[p + 2], F = format(cmd & 7), total = 3 + count * F.size;
            if (p + total > end) throw new Error(`a primitive runs past the end of ${inList ? 'its display list' : 'the frame'} (at ${p})`);
            stat.prims++; stat.verts += count;
            for (const at of F.idx) {
                let max = -1;
                for (let i = 0, q = p + 3 + at.off; i < count; i++, q += F.size) { const v = at.n === 1 ? b[q] : (b[q] << 8) | b[q + 1]; if (at.array === 0 && v === (at.n === 1 ? 0xFF : 0xFFFF)) continue; if (v > max) max = v; }
                if (max >= 0) { const stride = cp[0xB0 + at.array] & 0xFF; need(`vertex array ${at.array}`, cp[0xA0 + at.array] & 0x03FFFFFF, max * stride + Math.max(stride, at.size)); }
            }
            textures();
            if (xfw[0x101A] !== vpOf[0] || xfw[0x101B] !== vpOf[1] || xfw[0x101D] !== vpOf[2] || xfw[0x101E] !== vpOf[3] || xfw[0x101C] !== vpOf[4] || xfw[0x101F] !== vpOf[5]) {
                vpOf = [xfw[0x101A], xfw[0x101B], xfw[0x101D], xfw[0x101E], xfw[0x101C], xfw[0x101F]];
                vp = `${f32(xfw[0x101A]) * 2} x ${-f32(xfw[0x101B]) * 2} at ${f32(xfw[0x101D]) - 342 - f32(xfw[0x101A])},${f32(xfw[0x101E]) - 342 + f32(xfw[0x101B])}, depth ${f32(xfw[0x101F]) - f32(xfw[0x101C])} to ${f32(xfw[0x101F])}`;
            }
            viewports.set(vp, (viewports.get(vp) || 0) + 1);
            if (bp[0x20] !== scOf[0] || bp[0x21] !== scOf[1] || bp[0x59] !== scOf[2]) {
                scOf = [bp[0x20], bp[0x21], bp[0x59]];
                const xo = (bp[0x59] & 0x3FF) * 2 - 342, yo = ((bp[0x59] >>> 10) & 0x3FF) * 2 - 342;
                sc = `${((bp[0x20] >>> 12) & 0x7FF) - 342},${(bp[0x20] & 0x7FF) - 342} to ${((bp[0x21] >>> 12) & 0x7FF) - 342},${(bp[0x21] & 0x7FF) - 342} (inclusive), offset ${xo},${yo}`;
            }
            scissors.set(sc, (scissors.get(sc) || 0) + 1);
            p += total; continue;
        }
        switch (cmd) {
            case 0x08: cp[b[p + 1]] = r32(b, p + 2); p += 6; continue;
            case 0x10: { const n = (b[p + 2] & 0xF) + 1, addr = (b[p + 3] << 8) | b[p + 4]; for (let i = 0; i < n; i++) if (addr + i < 0x1100) xfw[addr + i] = r32(b, p + 5 + 4 * i); p += 5 + 4 * n; continue; }
            case 0x20: case 0x28: case 0x30: case 0x38: {
                const index = (b[p + 1] << 8) | b[p + 2], v = (b[p + 3] << 8) | b[p + 4], n = (v >>> 12) + 1, addr = v & 0xFFF, arr = 12 + ((cmd - 0x20) >> 3);
                const src = (cp[0xA0 + arr] & 0x03FFFFFF) + index * (cp[0xB0 + arr] & 0xFF);
                stat.xfIdx++; need('matrix loaded by index', src, 4 * n);
                if (src + 4 * n <= RAM) for (let i = 0; i < n; i++) if (addr + i < 0x1100) xfw[addr + i] = r32(ram, src + 4 * i);
                p += 5; continue;
            }
            case 0x40: {
                const addr = r32(b, p + 1) & 0x03FFFFFF, size = r32(b, p + 5);
                if (inList) throw new Error('a display list calls another');
                stat.lists++; need('display list', addr, size);
                if (addr + size <= RAM) run(ram, addr, addr + size, true, null);
                p += 9; continue;
            }
            case 0x44: case 0x48: p++; continue;
            case 0x61: bpLoad(r32(b, p + 1)); p += 5; continue;
        }
        throw new Error(`an unknown command 0x${hex(cmd)} at ${p}${inList ? ' of a display list' : ''}`);
    }
    return p;
}

// ---- the frames
let tot = { fifo: 0, patch: 0, patches: 0, prims: 0, verts: 0, lists: 0 }, frames = 0, problems = 0;
const say = (s: string) => { problems++; console.log('PROBLEM ' + s); };
for (const name of files) {
    const f = decodeGxFrame(new Uint8Array(readFileSync(`${dir}/${name}`)));
    if (f.regs) { cp = f.regs.cp.slice(0, 256); bp = f.regs.bp.slice(0, 256); xfw = f.regs.xf.slice(0, 0x1100); bpMask = 0xFFFFFF; }
    else if (!frames) say(`${name}: the first frame has no registers`);
    stat = { prims: 0, verts: 0, lists: 0, xfIdx: 0, tluts: 0, texCopies: 0, xfbCopies: 0, cmds: 0 };
    let k = 0, patchBytes = 0;
    for (let i = 1; i < f.patches.length; i++) if (f.patches[i].at < f.patches[i - 1].at) say(`${name}: the patches aren't in the order of their commands`);
    const before = (p: number) => {
        while (k < f.patches.length && f.patches[k].at <= p) {
            const q = f.patches[k++], a = q.addr - 0x80000000;
            if (q.at !== p) say(`${name}: a patch at ${q.at}, which is not where a command starts (the next starts at ${p})`);
            if (a < 0 || a + q.data.length > RAM) { say(`${name}: a patch outside RAM (0x${hex(q.addr)}, ${q.data.length} bytes)`); continue; }
            ram.set(q.data, a); have.fill(1, a, a + q.data.length); patchBytes += q.data.length;
            for (const [da, d] of copyDst) if (d.fresh && a < da + d.n && a + q.data.length > da) { d.fresh = false; d.sent++; }
        }
    };
    let endAt = -1;
    try { endAt = run(f.fifo, 0, f.fifo.length, false, before); } catch (e) { say(`${name}: ${(e as Error).message}`); }
    if (k < f.patches.length) say(`${name}: ${f.patches.length - k} patch(es) after the last command`);
    if (stat.xfbCopies !== 1) say(`${name}: ${stat.xfbCopies} copies to the display in the frame`);
    else if (!(f.fifo.length >= 5 && f.fifo[f.fifo.length - 5] === 0x61 && f.fifo[f.fifo.length - 4] === 0x52 && (f.fifo[f.fifo.length - 2] & 0x40))) say(`${name}: the frame doesn't end with its copy to the display`);
    if (frames < listN) console.log(`${name}: replay frame ${f.frame}, tick ${f.tick}${f.regs ? ', with the registers' : ''}: ${f.fifo.length} bytes of commands (${stat.cmds} commands, ${stat.prims} primitives, ${stat.verts} vertices, ${stat.lists} display list calls, ${stat.xfIdx} matrices by index, ${stat.tluts} palettes, ${stat.texCopies} copies to textures), ${f.patches.length} patches of ${patchBytes} bytes`);
    frames++; frameNo++;
    tot.fifo += f.fifo.length; tot.patch += patchBytes; tot.patches += f.patches.length; tot.prims += stat.prims; tot.verts += stat.verts; tot.lists += stat.lists;
    if (frames === 1) console.log(`   (the first frame: ${patchBytes} bytes of memory)`);
}
if (order.length) console.log(`the copies of frame file ${orderOf}, in order:\n${order.join('\n')}`);
const top = (m: Map<string, number>, n = 12) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `    ${c} x ${k}`).join('\n') + (m.size > n ? `\n    ... ${m.size - n} more` : '');
console.log(`${frames} frames. A frame on average: ${Math.round(tot.fifo / frames)} bytes of commands, ${Math.round(tot.patch / frames)} bytes of memory in ${Math.round(tot.patches / frames)} patches, ${Math.round(tot.prims / frames)} primitives, ${Math.round(tot.verts / frames)} vertices, ${Math.round(tot.lists / frames)} display list calls`);
console.log(`viewports (width x height at left,top; by primitives):\n${top(viewports)}`);
console.log(`scissors (by primitives):\n${top(scissors)}`);
console.log(`copies to the display:\n${top(xfbCopies)}`);
console.log(`copies to textures (${texCopies.size} kinds):\n${top(texCopies, 40)}`);
console.log(`textures drawn from memory a copy wrote:\n${top(texFromCopy, 40) || '    none'}`);
console.log(`after a copy to a texture, the memory's own bytes came in a patch (the copy was made in software and is the memory's: use the patch), or not (the page's own copy is the texture):\n${[...copyDst].map(([a, d]) => `    0x${hex(0x80000000 + a)} (${d.what}): ${d.copies} copies, a patch after ${d.sent}`).join('\n') || '    none'}`);
console.log(`texture formats (by primitives):\n${top(texFormats, 20)}`);
console.log(`BP registers loaded: ${[...bpUsed].map((u, i) => u ? hex(i) : '').filter(Boolean).join(' ')}`);
if (missing.size) { problems += missing.size; for (const [kind, m] of missing) console.log(`MISSING ${kind}: ${m.reads} read(s), ${m.bytes} byte(s) no patch delivered; first in ${m.first}`); }
else console.log('every read is of bytes a patch delivered');
process.exit(problems ? 1 : 0);
