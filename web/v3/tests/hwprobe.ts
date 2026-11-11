// Makes a script for tools/hwprobe (a Wii program that feeds a console's GPU and saves what it drew): the goop
// passes of a replay, each as the console's GPU got it (its registers, its textures, its commands up to the frame
// buffer copy), to be drawn again on a real console and compared with ppc/gx.ts texel by texel.
// Run: node v3hwprobe.mjs capture <trace> <out.passes> <ticks a-b[,c-d ...]> [most passes]    (ONLY=stamps: the passes that draw a stamp)
//      node v3hwprobe.mjs script <out.gxps> <a.passes> [...]     the script, and <out.gxps>.cases.json (what each case is)
//        (VERBATIM=n passes as they were, evenly spread; MUST='x,y;x,y' and those with a stamp over these texels;
//         SYN=n passes with test textures; GRID=0 without the script's own stamp cases)
//      node v3hwprobe.mjs check <script.gxps>                    the script through ppc/gx.ts (what it expects of a console)
//      node v3hwprobe.mjs compare <script.gxps> <answer.gxpo>    a console's answer against ppc/gx.ts, case by case
//      node v3hwprobe.mjs model <script.gxps> <out.gxpo>         ppc/gx.ts's own answer, as a console would save it
//      node v3hwprobe.mjs feed <script.gxps> <out.bin>           the bytes the script sends to the GPU (for tools/hwprobe/hosttest)
import { readFileSync, writeFileSync } from 'node:fs';
import { serialize, deserialize } from 'node:v8';
import { Gx } from '../ppc/gx.ts';
import { OP, Script, readScript, rleDecode, rleEncode, type Op } from '../tools/hwprobe/script.ts';

const r32 = (b: Uint8Array, p: number) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const hex = (n: number) => n.toString(16);
/** BP registers that hold an address (>> 5): the eight textures' images, the copy's destination */
const TEX_ADDR = [0x94, 0x95, 0x96, 0x97, 0xB4, 0xB5, 0xB6, 0xB7], COPY_DST = 0x4B;
/** BP registers that aren't state (draw done, tokens, the copy, the bounding box's and the counters' clear, the TLUT load, the cache's invalidate, the mask) or are the console's own (the bus clocks); the TEV colours (two sets behind one address) */
const BP_SKIP = new Set([0x45, 0x46, 0x47, 0x48, 0x52, 0x55, 0x56, 0x57, 0x64, 0x65, 0x66, 0x69, 0xFE, 0xE0, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7]);
const texBytes = (w: number, h: number, fmt: number) => {
    const bw = (w + 7) >> 3, bh = (h + 3) >> 2, b4 = ((w + 3) >> 2) * bh;
    switch (fmt) { case 0: return bw * ((h + 7) >> 3) * 32; case 1: case 2: return bw * bh * 32; case 3: case 4: case 5: return b4 * 32; case 6: return b4 * 64; case 14: return ((w + 7) >> 3) * ((h + 7) >> 3) * 32; }
    throw new Error(`a texture of format ${fmt}`);
};

/** one pass as recorded: the GPU's state before it, its commands, the RAM it reads */
interface Pass {
    tick: number; bp: Uint32Array; cp: Uint32Array; xfw: Uint32Array; tevReg: Int32Array; konst: Int32Array; bpSeen: Uint8Array;
    cmds: Uint8Array[]; ram: Uint8Array | null;
    /** the arrays' reads: `${array}:${base}` -> [lowest address, highest end] */
    arrays: Map<string, [number, number]>;
    /** RAM the pass needs, by game address (cut from `ram` when the pass ends) */
    blocks: Map<number, { size: number; data: Uint8Array; kind: string; w?: number; h?: number; fmt?: number }>;
    dst: number; dstSize: number; result: Uint8Array | null;
    /** the stamps drawn: the quad on the screen (x1, y1, x2, y2), the texture, 0 cleaning / 1 goop, the height window */
    stamps: { q: number[]; tex: number; type: number; c0: number; c1: number }[];
    /** the height map the stamps test (their second texture) */
    hmap: number;
}

/** walks a pass's commands with the BP and CP registers kept, calling back at every primitive and copy */
function walk(P: Pass, onPrim: (bp: Uint32Array, cp: Uint32Array) => void, onCopy: (bp: Uint32Array, ctl: number) => void) {
    const bp = P.bp.slice(), cp = P.cp.slice(); let mask = 0xFFFFFF;
    for (const c of P.cmds) {
        if (c[0] & 0x80) onPrim(bp, cp);
        else if (c[0] === 0x08) cp[c[1]] = r32(c, 2);
        else if (c[0] === 0x61) {
            const w = r32(c, 1), reg = w >>> 24;
            if (reg === 0xFE) { mask = w & 0xFFFFFF; continue; }
            const v = ((bp[reg] & ~mask) | (w & mask)) & 0xFFFFFF; mask = 0xFFFFFF;
            if (reg === 0x52) onCopy(bp, v);
            bp[reg] = v;
        }
    }
}

/** what a finished pass reads and writes, cut out of the RAM copy */
function finish(P: Pass, ramAfter: Uint8Array) {
    const ram = P.ram!, need = (addr: number, size: number, kind: string, extra: object = {}) => {
        const b = P.blocks.get(addr);
        if (!b || b.size < size) P.blocks.set(addr, { size, data: ram.slice(addr, addr + size), kind: b ? b.kind + '+' + kind : kind, ...extra });
        else if (!b.kind.includes(kind)) b.kind += '+' + kind;
    };
    walk(P, (bp) => {
        const stages = ((bp[0] >>> 10) & 15) + 1;
        if (bp[0] & 0x70000) throw new Error('indirect textures');
        for (let st = 0; st < stages; st++) {
            const order = bp[0x28 + (st >> 1)] >>> ((st & 1) * 12);
            if (!(order & 0x40)) continue;
            const m = order & 7, base = m < 4 ? m : 0x20 + (m - 4), i0 = bp[0x88 + base], w = (i0 & 0x3FF) + 1, h = ((i0 >>> 10) & 0x3FF) + 1, fmt = (i0 >>> 20) & 15;
            // (with mipmaps: the smaller levels follow the image, a third as much again at most)
            const mips = ((bp[0x80 + base] >>> 5) & 3) !== 0, size = texBytes(w, h, fmt);
            need((bp[0x94 + base] << 5) & 0x03FFFFFF, mips ? (size * 3 / 2 + 64 + 31) & ~31 : size, 'tex', { w, h, fmt });
        }
    }, (bp, ctl) => {
        if (ctl & 0x4000) throw new Error('a copy to the display inside a pass');
        const sw = (bp[0x4A] & 0x3FF) + 1, sh = ((bp[0x4A] >>> 10) & 0x3FF) + 1, f = (ctl >>> 3) & 15, fmt = (f >> 1) + (f & 1) * 8;
        if (fmt < 7 || fmt > 10) throw new Error(`a copy to format ${fmt}`);
        P.dst = (bp[COPY_DST] << 5) & 0x03FFFFFF; P.dstSize = ((sw + 7) >> 3) * ((sh + 3) >> 2) * 32;
        need(P.dst, P.dstSize, 'dst', { w: sw, h: sh, fmt: 1 });
    });
    for (const [key, [lo, hi]] of P.arrays) need(lo, hi - lo, 'array ' + key);
    P.result = ramAfter.slice(P.dst, P.dst + P.dstSize);
    P.ram = null;
}

/**
 * A pass as a script case. sub: other contents for a block (by game address); window: the stamps' height window
 * (TEV colours 1 and 2) set to these two values instead of each stamp's own.
 */
function emit(S: Script, A: Arena, P: Pass, label: string, sub: Map<number, Uint8Array> = new Map(), window: number[] | null = null) {
    S.note(label);
    const off = new Map<number, number>();
    for (const [addr, b] of P.blocks) {
        const key = `${addr}:${b.size}`, d = sub.get(addr) ?? b.data;
        if (d.length !== b.size) throw new Error('a substitute of another size');
        let at = A.at.get(key);
        if (at === undefined) { at = A.top; A.at.set(key, at); A.top += (b.size + 31) & ~31; }
        off.set(addr, at);
        // (a block the console has as the script left it isn't sent again)
        const has = A.has.get(key);
        if (!has || has.length !== d.length || has.some((v, i) => v !== d[i])) { S.mem(at, d); A.has.set(key, d); }
    }
    A.has.delete(`${P.dst}:${P.blocks.get(P.dst)!.size}`);   // (the copy will write it)
    if (A.scratch < 0) { A.scratch = A.top; A.top += 640 / 8 * (528 / 4) * 32; }
    const scratch = A.scratch;
    S.arena = Math.max(S.arena, A.top);
    const arrayOff = (reg: number, base: number): number | null => {
        const r = P.arrays.get(`${reg - 0xA0}:${base & 0x03FFFFFF}`);
        return r ? off.get(r[0])! - (r[0] - (base & 0x03FFFFFF)) : null;
    };
    const bpw = (reg: number, v: number) => S.fifo([0x61, reg, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF]);
    const cpw = (reg: number, v: number) => { const o = reg >= 0xA0 && reg < 0xB0 ? arrayOff(reg, v) : null; if (o !== null) S.cpAddr(reg, o); else S.fifo([0x08, reg, v >>> 24, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF]); };
    const bpAny = (reg: number, v: number) => {
        const o = TEX_ADDR.includes(reg) || reg === COPY_DST ? off.get((v << 5) & 0x03FFFFFF) : undefined;
        if (o !== undefined) S.bpAddr(reg, o); else bpw(reg, v);
    };
    // ---- the frame buffer cleared (colour 0, depth far), as ppc/gx.ts starts: a copy of all of it with the clear on
    bpw(0x43, P.bp[0x43]); bpw(0x41, 0x18); bpw(0x40, 0x1F);
    bpw(0x49, 0); bpw(0x4A, (527 << 10) | 639); S.bpAddr(COPY_DST, scratch);
    bpw(0x4F, 0); bpw(0x50, 0); bpw(0x51, 0xFFFFFF); bpw(0x52, 0x80B);
    // ---- the state: CP (vertex formats, arrays), XF (matrices, lights, the registers), BP
    for (const r of [0x30, 0x40, 0x50, 0x60]) cpw(r, P.cp[r]);
    // (the vertex formats: eight in each of three groups; then the arrays' bases and strides)
    for (const g of [0x70, 0x80, 0x90]) for (let r = g; r < g + 8; r++) cpw(r, P.cp[r]);
    for (let r = 0xA0; r < 0xC0; r++) cpw(r, P.cp[r]);
    const xf = (from: number, to: number) => {
        for (let a = from; a < to; a += 16) {
            const n = Math.min(16, to - a), c = [0x10, 0, n - 1, a >> 8, a & 0xFF];
            for (let i = 0; i < n; i++) { const v = P.xfw[a + i]; c.push(v >>> 24, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF); }
            S.fifo(c);
        }
    };
    xf(0x000, 0x100); xf(0x400, 0x460); xf(0x500, 0x600); xf(0x600, 0x680); xf(0x1005, 0x1006); xf(0x1008, 0x1027); xf(0x103F, 0x1058);
    for (let r = 0; r < 256; r++) if (P.bpSeen[r] && !BP_SKIP.has(r)) bpAny(r, P.bp[r]);
    for (let i = 0; i < 4; i++) for (const [k, bit] of [[P.tevReg, 0], [P.konst, 0x800000]] as [Int32Array, number][]) {
        // (GXSetTevColor: red and alpha once, blue and green three times)
        bpw(0xE0 + 2 * i, bit | ((k[i * 4 + 3] & 0x7FF) << 12) | (k[i * 4] & 0x7FF));
        for (let n = 0; n < 3; n++) bpw(0xE1 + 2 * i, bit | ((k[i * 4 + 1] & 0x7FF) << 12) | (k[i * 4 + 2] & 0x7FF));
    }
    // (GXInvalidateTexAll)
    bpw(0x0F, P.bp[0x0F]); bpw(0x66, 0x001000); bpw(0x66, 0x001100); bpw(0x0F, P.bp[0x0F]);
    // ---- the pass
    const bp = P.bp.slice(); let mask = 0xFFFFFF, stampsOn = false;
    for (const c of P.cmds) {
        if (c[0] === 0x61) {
            const w = r32(c, 1), reg = w >>> 24; let v = w & 0xFFFFFF;
            if (reg === 0xFE) mask = v; else { bp[reg] = ((bp[reg] & ~mask) | (v & mask)) & 0xFFFFFF; mask = 0xFFFFFF; }
            // (the stamps' height window: set before each stamp, after the layer's own quad)
            if (window && stampsOn && reg >= 0xE2 && reg <= 0xE5 && !(v & 0x800000)) { const k = window[(reg - 0xE2) >> 1] & 0x7FF; v = (k << 12) | k; }
            bpAny(reg, v);
        } else if (c[0] === 0x08) cpw(c[1], r32(c, 2));
        else { if ((c[0] & 0x80) && ((bp[0] >>> 10) & 15) === 1) stampsOn = true; S.fifo(c); }
    }
    S.sync();
    S.read16(0xCC001018, 12);
    S.dump(off.get(P.dst)!, P.dstSize);
}

/** where the blocks of a script's cases are in the console's arena (by game address and size), and what the script last put there */
interface Arena { at: Map<string, number>; has: Map<string, Uint8Array>; top: number; scratch: number }

/** the script through ppc/gx.ts: every dump and counter read, in order */
function simulate(ops: Op[], arena: number, seed = 0, fed: number[] | null = null): Uint8Array[] {
    const BASE = 0x01000000, ram = new Uint8Array(BASE + arena + 64), warned: string[] = [];
    const gx = new Gx(ram, { token() { }, finish() { }, unsupported(w) { if (!warned.includes(w)) { warned.push(w); console.log('! ppc/gx.ts: ' + w); } } });
    gx.raster = true;
    if (process.env.TRACE) gx.trace = (t) => { if (new RegExp(process.env.TRACE!).test(t)) console.log(t); };
    if (seed) { let s = seed; for (let i = 0; i < gx.efb.length; i++) { s = (s * 1103515245 + 12345) >>> 0; gx.efb[i] = s >>> 24; } }
    const out: Uint8Array[] = [], feed = (b: number[] | Uint8Array) => { if (fed) for (let i = 0; i < b.length; i++) fed.push(b[i]); gx.feed(b instanceof Uint8Array ? b : Uint8Array.from(b), 0, b.length); };
    for (const o of ops) {
        switch (o.op) {
            case OP.MEM: ram.set(o.data!, BASE + o.a); break;
            case OP.MEMRLE: ram.set(rleDecode(o.data!, o.b), BASE + o.a); break;
            case OP.FIFO: feed(o.data!); break;
            case OP.BPADDR: { const v = ((BASE + o.b) >>> 5) & 0xFFFFFF; feed([0x61, o.a, v >>> 16, (v >>> 8) & 0xFF, v & 0xFF]); break; }
            case OP.CPADDR: { const v = (BASE + (o.b | 0)) >>> 0; feed([0x08, o.a, v >>> 24, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF]); break; }
            case OP.DUMP: out.push(ram.slice(BASE + o.a, BASE + o.a + o.b)); break;
            case OP.READ16: { const d = new Uint8Array(o.b * 2); if (o.a === 0xCC001018) { d[16] = (gx.blendQuads >>> 8) & 0xFF; d[17] = gx.blendQuads & 0xFF; d[18] = (gx.blendQuads >>> 24) & 0xFF; d[19] = (gx.blendQuads >>> 16) & 0xFF; } out.push(d); break; }
        }
    }
    return out;
}

/** texels of an 8-bit texture (blocks of 8 x 4) that differ: [x, y, a, b] */
function diffI8(a: Uint8Array, b: Uint8Array, w: number, h: number) {
    const out: number[][] = [], bw = (w + 7) >> 3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = ((y >> 2) * bw + (x >> 3)) * 32 + (y & 3) * 8 + (x & 7); if (a[i] !== b[i]) out.push([x, y, a[i], b[i]]); }
    return out;
}

// ---------------------------------------------------------------- test textures (8-bit, 64 x 64, in blocks of 8 x 4)
const i8 = (w: number, h: number, f: (x: number, y: number) => number) => {
    const bw = (w + 7) >> 3, out = new Uint8Array(bw * ((h + 3) >> 2) * 32);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[((y >> 2) * bw + (x >> 3)) * 32 + (y & 3) * 8 + (x & 7)] = f(x, y) & 255;
    return out;
};
/** the stamps' texture in a variant: by texel (s, t) */
const VARIANTS: [string, (s: number, t: number) => number][] = [
    ['rampS', (s) => 4 * s], ['rampT', (_s, t) => 4 * t],
    ['sawS0', (s) => 16 * s], ['sawS8', (s) => 16 * s + 128], ['sawT0', (_s, t) => 16 * t], ['sawT8', (_s, t) => 16 * t + 128],
    ['fineS0', (s) => 64 * s], ['fineS2', (s) => 64 * s + 128], ['fineT0', (_s, t) => 64 * t], ['fineT2', (_s, t) => 64 * t + 128],
    ['full', () => 255],
    ['blocks0', (s, t) => ((t >> 3) * 8 + (s >> 3)) * 4], ['blocks1', (s, t) => ((t >> 3) * 8 + (s >> 3)) * 4 + 1], ['blocks2', (s, t) => ((t >> 3) * 8 + (s >> 3)) * 4 + 2], ['blocks3', (s, t) => ((t >> 3) * 8 + (s >> 3)) * 4 + 3],
];

/** the height window of the test cases: [TEV colour 1, TEV colour 2], around the one height their height map has (128) */
const WINDOW = [0, 255];

interface Case { label: string; source: string; tick: number; variant: string; w: number; h: number; stamps: Pass['stamps'] }

/**
 * A pass that draws stamps, with other stamps in their place: squares of `size` pixels with the corner at (x, y),
 * drawn as the game draws its own (four vertices: the place in pixels, the texture's corner, the place again for
 * the height map; 16-bit numbers).
 */
function withStamps(P: Pass, list: { x: number; y: number; size: number }[]): Pass {
    const bp = P.bp.slice(), cmds: Uint8Array[] = []; let done = false;
    for (const c of P.cmds) {
        if (c[0] === 0x61) bp[c[1]] = r32(c, 1) & 0xFFFFFF;
        if ((c[0] & 0x80) && ((bp[0] >>> 10) & 15) === 2) {
            if (c[0] !== 0x80 || c.length !== 51) throw new Error('a stamp that is not four vertices of 12 bytes');
            if (done) continue;
            done = true;
            for (const st of list) {
                const b: number[] = [0x80, 0, 4], w = (v: number) => b.push((v >> 8) & 0xFF, v & 0xFF);
                for (const [i, j] of [[0, 0], [1, 0], [1, 1], [0, 1]]) { const x = st.x + i * st.size, y = st.y + j * st.size; w(x); w(y); w(i); w(j); w(x); w(y); }
                cmds.push(Uint8Array.from(b));
            }
        } else cmds.push(c);
    }
    if (!done) throw new Error('a pass without a stamp');
    const s0 = P.stamps[0];
    return { ...P, cmds, stamps: list.map((st) => ({ q: [st.x, st.y, st.x + st.size, st.y + st.size], tex: s0.tex, type: s0.type, c0: WINDOW[0], c1: WINDOW[1] })) };
}
/** the stamps of the grid cases: every even size to 24 with the corner on an even or odd column and row, some odd sizes; three arrangements */
function grid(layout: number): { x: number; y: number; size: number }[] {
    const cells: { size: number; px: number; py: number }[] = [];
    for (let size = 2; size <= 24; size += 2) for (const [px, py] of [[0, 0], [1, 0], [0, 1], [1, 1]]) cells.push({ size, px, py });
    for (const size of [3, 5, 7, 9, 11, 13, 17, 23]) for (const [px, py] of [[0, 0], [1, 1]]) cells.push({ size, px, py });
    // (GRIDOFF='x,y': the whole arrangement moved, for maps bigger than 256)
    const off = (process.env.GRIDOFF || '0,0').split(',').map(Number);
    const [bx, by] = [[2 + off[0], 2 + off[1]], [4 + off[0], 6 + off[1]], [off[0], off[1]]][layout];
    return cells.map((c, k) => { const cell = layout === 0 ? k : layout === 1 ? 63 - k : (k * 29 + 7) % 64; return { x: 32 * (cell & 7) + bx + c.px, y: 32 * (cell >> 3) + by + c.py, size: c.size }; });
}

const mode = process.argv[2];
if (mode === 'capture') {
    const { readTrace } = await import('../game/trace.ts');
    const { Replay, JP10 } = await import('../game/replay.ts');
    const { symbols } = await import('./syms.ts');
    const { jpDisc, JP_DOL, loadBytes } = await import('./jpdisc.ts');
    const S = symbols();
    const b = readFileSync(process.argv[3]);
    const T = readTrace(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    const outPath = process.argv[4], spans = process.argv[5].split(',').map((s) => s.split('-').map(Number)), most = +(process.argv[6] || 1e9);
    const lastTick = Math.max(...spans.map((s) => s[1] ?? s[0])), onlyStamps = process.env.ONLY === 'stamps';
    const wanted = (t: number) => spans.some((s) => t >= s[0] && t <= (s[1] ?? s[0]));
    const R = new Replay(loadBytes(JP_DOL), jpDisc(), T, JP10, (n) => S.byName.get(n), { log: (s) => { if (/^\[/.test(s)) console.log(s); }, fstPad: +(process.env.FSTPAD ?? (process.env.DISC ? 0 : 480)) });
    const m = R.m, gx = m.hw.gx, ram = m.mem.ram;
    const passes: Pass[] = [];
    let cur: Pass | null = null, skipping = false, seen = 0;
    gx.rec = (cmd, raster) => {
        if (skipping) return;
        if (!cur) {
            if (!wanted(R.ticks) || passes.length >= most) { skipping = true; return; }
            gx.recAll = true;
            cur = { tick: R.ticks, bp: gx.bp.slice(), cp: gx.cp.slice(), xfw: gx.xfw.slice(), tevReg: gx.tevReg.slice(), konst: gx.konst.slice(), bpSeen: gx.bpSeen.slice(), cmds: [], ram: ram.slice(), arrays: new Map(), blocks: new Map(), dst: 0, dstSize: 0, result: null, stamps: [], hmap: 0 };
        }
        // (outside the game's goop drawing only the state counts: no copy, no draw done or token)
        if (cmd[0] === 0x61 && (cmd[1] === 0x45 || cmd[1] === 0x47 || cmd[1] === 0x48 || (cmd[1] === 0x52 && !raster))) return;
        cur.cmds.push(cmd.slice());
    };
    gx.arrayTrace = (array, at, n) => {
        if (!cur) return;
        const key = `${array}:${gx.cp[0xA0 + array] & 0x03FFFFFF}`, r = cur.arrays.get(key);
        if (!r) cur.arrays.set(key, [at, at + n]); else { if (at < r[0]) r[0] = at; if (at + n > r[1]) r[1] = at + n; }
    };
    gx.drawTrace = (prim, count, v) => {
        const bp = gx.bp;
        if (!cur || prim !== 0x80 || count !== 4 || ((bp[0] >>> 10) & 15) !== 2) return;
        const xs = [v[0].x, v[1].x, v[2].x, v[3].x], ys = [v[0].y, v[1].y, v[2].y, v[3].y];
        cur.stamps.push({ q: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], tex: (bp[0x94] << 5) & 0x03FFFFFF, type: ((bp[0xC4] >>> 12) & 15) === 8 ? 0 : 1, c0: gx.tevReg[7], c1: gx.tevReg[11] });
        cur.hmap = (bp[0x95] << 5) & 0x03FFFFFF;
    };
    // a pass ends with its copy
    gx.copyTrace = () => {
        gx.recAll = false; skipping = false;
        if (!cur) return;
        seen++;
        if (!onlyStamps || cur.stamps.length) { finish(cur, ram); passes.push(cur); if (passes.length % 100 === 1) console.log(`pass ${passes.length} at tick ${cur.tick}: ${cur.cmds.length} commands, ${cur.stamps.length} stamps, ${[...cur.blocks].map(([a, k]) => `${hex(a)} ${k.kind} ${k.size}`).join(', ')}`); }
        cur = null;
    };
    while (m.cpu.count < 4000e9 && R.run(50e6) !== 'done' && R.ticks <= lastTick + 8) { /* on */ }
    writeFileSync(outPath, serialize(passes));
    console.log(`${passes.length} passes kept of ${seen} to tick ${R.ticks}; issues: ${R.issues.length ? String((R.issues[0] as any).text).split('\n')[0] : 'none'}`);
    process.exit(0);
} else if (mode === 'script') {
    const outPath = process.argv[3], Sc = new Script(), cases: Case[] = [], A: Arena = { at: new Map(), has: new Map(), top: 0, scratch: -1 };
    const nVerb = +(process.env.VERBATIM ?? 1e9), nSyn = +(process.env.SYN ?? 16);
    for (const file of process.argv.slice(4)) {
        const passes = deserialize(readFileSync(file)) as Pass[], source = file.replace(/^.*\//, '').replace(/\.passes$/, '');
        // ---- the passes as they were
        // (MUST: texels 'x,y;x,y': every pass with a stamp over one of them, besides the evenly spread ones)
        const must = (process.env.MUST || '').split(';').filter(Boolean).map((t) => t.split(',').map(Number));
        const nv = Math.min(nVerb, passes.length), pick = new Set<number>();
        for (let k = 0; k < nv; k++) pick.add(Math.floor(k * passes.length / nv));
        for (const [i, P] of passes.entries()) if (P.stamps.some((st) => must.some(([x, y]) => x >= st.q[0] && x < st.q[2] && y >= st.q[1] && y < st.q[3]))) pick.add(i);
        for (const i of [...pick].sort((a, b) => a - b)) {
            const P = passes[i], d = P.blocks.get(P.dst)!, label = `${source} ${i} tick ${P.tick}`;
            emit(Sc, A, P, label);
            cases.push({ label, source, tick: P.tick, variant: '', w: d.w!, h: d.h!, stamps: P.stamps });
        }
        // ---- test textures in place of the stamps', on a flat map, every height allowed: the passes that between
        // them have every kind of stamp (size, cleaning or goop, the corner's column and row even or odd)
        const kind = (st: Pass['stamps'][0]) => `${st.q[2] - st.q[0]},${st.type},${st.q[0] & 1},${st.q[1] & 1}`;
        const have = new Set<string>(), chosen: number[] = [];
        const oneType = (P: Pass) => P.stamps.length > 0 && P.stamps.every((st) => st.type === P.stamps[0].type);
        for (;;) {
            let best = -1, gain = 0;
            for (const [i, P] of passes.entries()) { if (!oneType(P) || chosen.includes(i)) continue; const g = new Set(P.stamps.map(kind).filter((k) => !have.has(k))).size; if (g > gain) { gain = g; best = i; } }
            if (best < 0 || chosen.length >= nSyn) break;
            chosen.push(best); for (const st of passes[best].stamps) have.add(kind(st));
        }
        for (const i of chosen) {
            const P = passes[i], d = P.blocks.get(P.dst)!, type = P.stamps[0].type, texes = new Set(P.stamps.map((st) => st.tex));
            const flat = new Uint8Array(P.dstSize).fill(type ? 0 : 255), grad = i8(d.w!, d.h!, (x, y) => 50 + ((x * 5 + y * 3) % 206));
            const sub = (f: ((s: number, t: number) => number) | null, map: Uint8Array) => {
                const m = new Map<number, Uint8Array>([[P.dst, map], [P.hmap, new Uint8Array(P.blocks.get(P.hmap)!.size).fill(128)]]);
                if (f) for (const t of texes) { const b = P.blocks.get(t)!; if (b.w !== 64 || b.h !== 64 || b.fmt !== 1) throw new Error('a stamp texture that is not 64 x 64, 8 bits'); m.set(t, i8(64, 64, f)); }
                return m;
            };
            const add = (variant: string, m: Map<number, Uint8Array>) => {
                const label = `${source} ${i} tick ${P.tick} ${variant}`;
                emit(Sc, A, P, label, m, WINDOW);
                cases.push({ label, source, tick: P.tick, variant, w: d.w!, h: d.h!, stamps: P.stamps });
            };
            add('real', sub(null, flat));
            for (const [name, f] of VARIANTS) add(name, sub(f, name.startsWith('blocks') ? grad : flat));
        }
        console.log(`${source}: ${passes.length} passes; test textures on passes ${chosen.join(' ')} (${have.size} kinds of stamp)`);
    }
    if (process.env.GRID !== '0') {
        // ---- stamps of this script's own, in the place of a pass's: a pass that cleans and one that adds goop
        const first = deserialize(readFileSync(process.argv[4])) as Pass[];
        const one = (type: number) => { const P = first.filter((q) => q.stamps.length > 0 && q.stamps.every((st) => st.type === type) && q.blocks.get(q.dst)!.w! >= 256 && q.blocks.get(q.dst)!.h! >= 256).sort((a, b) => a.stamps.length - b.stamps.length)[0]; if (!P) throw new Error(`no pass with stamps of type ${type} only`); return P; };
        const T = [one(0), one(1)], realTex = T.map((P) => P.blocks.get(P.stamps[0].tex)!.data), dim = T.map((P) => P.blocks.get(P.dst)!);
        const add = (type: number, variant: string, list: { x: number; y: number; size: number }[], tex: Uint8Array | null, map: Uint8Array) => {
            const P = list.length ? withStamps(T[type], list) : { ...T[type], cmds: withStamps(T[type], []).cmds, stamps: [] }, label = `grid ${type ? 'goop' : 'clean'} ${variant}`;
            // (the height map all of one height, and every height let through)
            const m = new Map<number, Uint8Array>([[P.dst, map], [P.hmap, new Uint8Array(P.blocks.get(P.hmap)!.size).fill(128)]]); if (tex) m.set(T[type].stamps[0].tex, tex);
            emit(Sc, A, P, label, m, WINDOW);
            cases.push({ label, source: 'grid', tick: 0, variant: `${type ? 'goop' : 'clean'} ${variant}`, w: dim[type].w!, h: dim[type].h!, stamps: P.stamps });
        };
        // (a map of 0: a goop stamp leaves its alpha there, a cleaning stamp its alpha squared, near enough)
        const flat = (type: number) => new Uint8Array(dim[type].size);
        const texes: [string, Uint8Array][] = [['realClean', realTex[0]], ['realGoop', realTex[1]], ...VARIANTS.filter(([n]) => !n.startsWith('blocks')).map(([n, f]) => [n, i8(64, 64, f)] as [string, Uint8Array])];
        for (const type of [0, 1]) {
            // every size and corner, three arrangements, each texture
            for (const [name, tex] of texes) for (let layout = 0; layout < 3; layout++) add(type, `${name} layout ${layout}`, grid(layout), tex, flat(type));
            // the blender: stamps of 64 pixels (a texel a pixel) with 64 flat squares each, on maps of every value
            const four = [[0, 0], [128, 0], [0, 128], [128, 128]];
            for (let g = 0; g < 8; g++) {
                const map = (type: number) => i8(dim[type].w!, dim[type].h!, (x, y) => [x + y * 16, x * 3 + y * 7, 255 - x + y * 5, (x >> 2) * 4 + (y >> 2) * 36 + g, x * 9 + y, x ^ (y * 3), x * y, (x >> 3) * 8 + (y >> 3) * 72 + 3][g]);
                for (let k = 0; k < 4; k++) add(type, `blocks${k} map ${g}`, four.map(([x, y]) => ({ x: x + 32, y: y + 32, size: 64 })), i8(64, 64, VARIANTS.find(([n]) => n === `blocks${k}`)![1]), map(type));
                add(type, `no stamp map ${g}`, [], null, map(type));
            }
        }
        // bigger stamps (to a texel a pixel and two pixels a texel), each corner even or odd
        for (const [px, py] of [[0, 0], [1, 0], [0, 1], [1, 1]]) for (const [name, tex] of texes.filter(([n]) => /^(realClean|rampS|rampT|sawS0|sawT0|fineS0|fineT0)$/.test(n))) {
            add(1, `${name} big ${px}${py}`, [{ x: 2 + px, y: 2 + py, size: 32 }, { x: 40 + px, y: 2 + py, size: 48 }, { x: 96 + px, y: 2 + py, size: 64 }, { x: 2 + px, y: 80 + py, size: 128 }, { x: 140 + px, y: 80 + py, size: 96 }, { x: 170 + px, y: 2 + py, size: 28 }, { x: 204 + px, y: 2 + py, size: 40 }], tex, flat(1));
        }
    }
    const bytes = Sc.bytes();
    writeFileSync(outPath, bytes);
    writeFileSync(outPath + '.cases.json', JSON.stringify(cases));
    console.log(`${cases.length} cases, arena ${Sc.arena}, script ${bytes.length} bytes`);
    process.exit(0);
} else if (mode === 'feed') {
    // the bytes the script sends to the GPU, addresses counted from 0x01000000 (to compare with tools/hwprobe/hosttest's fifo.bin)
    const sc = readScript(new Uint8Array(readFileSync(process.argv[3]))), fed: number[] = [];
    simulate(sc.ops, sc.arena, 0, fed);
    writeFileSync(process.argv[4], Uint8Array.from(fed));
    console.log(`${fed.length} bytes`);
    process.exit(0);
} else if (mode === 'model') {
    // what ppc/gx.ts draws, as an answer file (the records tools/hwprobe writes on a console)
    const sc = readScript(new Uint8Array(readFileSync(process.argv[3]))), got = simulate(sc.ops, sc.arena);
    const parts: Uint8Array[] = [], rec = (kind: number, a: number, b: number, data: Uint8Array) => {
        const h = new Uint8Array(16 + ((data.length + 3) & ~3)), v = new DataView(h.buffer);
        v.setUint32(0, kind); v.setUint32(4, a); v.setUint32(8, b); v.setUint32(12, data.length); h.set(data, 16); parts.push(h);
    };
    const head = new Uint8Array(16); new DataView(head.buffer).setUint32(0, 0x4758504F); new DataView(head.buffer).setUint32(4, 1); parts.push(head);
    rec(100, 0, 0, new Uint8Array(16));
    let k = 0, dumps = 0;
    for (const o of sc.ops) {
        if (o.op === OP.READ16) rec(OP.READ16, o.a, o.b, got[k++]);
        else if (o.op === OP.DUMP) { const d = got[k++], p = rleEncode(d); if (p.length < d.length) rec(OP.MEMRLE, o.a, o.b, p); else rec(OP.DUMP, o.a, o.b, d); dumps++; }
    }
    rec(101, sc.ops.length, dumps, new Uint8Array(0));
    writeFileSync(process.argv[4], Buffer.concat(parts));
    console.log(`${dumps} blocks`);
    process.exit(0);
} else if (mode === 'check' || mode === 'compare') {
    const sc = readScript(new Uint8Array(readFileSync(process.argv[3]))), cases = JSON.parse(readFileSync(process.argv[3] + '.cases.json', 'utf8')) as Case[];
    const model = simulate(sc.ops, sc.arena, +(process.env.SEED || 0));
    if (mode === 'check') {
        // (what the model draws: a line a case)
        for (const [i, c] of cases.entries()) { const map = model[2 * i + 1]; let n = 0, sum = 0; for (const v of map) { if (v) n++; sum += v; } console.log(`${c.label}: ${c.w}x${c.h}, ${c.stamps.length} stamps, ${n} texels not 0, sum ${sum}`); }
        process.exit(0);
    }
    // a console's answer: records of (kind, a, b, length, data)
    const o = new Uint8Array(readFileSync(process.argv[4])), got: Uint8Array[] = [];
    if (r32(o, 0) !== 0x4758504F) throw new Error('not an answer file');
    for (let p = 16; p + 16 <= o.length;) {
        const kind = r32(o, p), b = r32(o, p + 8), len = r32(o, p + 12), data = o.subarray(p + 16, p + 16 + len);
        if (kind === 100) console.log(`console: Hollywood ${hex(r32(data, 0))}, CPU ${hex(r32(data, 4))}, arena at ${hex(r32(data, 8))}`);
        else if (kind === 101) console.log(`the console ran ${r32(o, p + 4)} operations and saved ${b} blocks`);
        else if (kind === 102) console.log(`the console stopped the script: ${Buffer.from(data).toString('latin1')}`);
        else if (kind === OP.DUMP || kind === OP.READ16) got.push(data.slice());
        else if (kind === OP.MEMRLE) got.push(rleDecode(data, b));
        p += 16 + ((len + 3) & ~3);
    }
    let bad = 0;
    const detail: object[] = [];
    for (const [i, c] of cases.entries()) {
        const counters = got[2 * i], map = got[2 * i + 1], want = model[2 * i + 1];
        if (!map) { console.log(`${c.label}: no answer`); bad++; continue; }
        const d = diffI8(want, map, c.w, c.h);
        const cs = [...Array(counters.length / 2).keys()].map((k) => (counters[2 * k] << 8) | counters[2 * k + 1]).join(' ');
        if (d.length || process.env.ALL) console.log(`${c.label}: ${d.length ? d.length + ' texels differ' : 'the same'}; counters ${cs}${d.length ? ' | ' + d.slice(0, 10).map((q) => `(${q[0]},${q[1]}) ${q[2]}->${q[3]}`).join(' ') : ''}`);
        if (d.length) bad++;
        detail.push({ label: c.label, differ: d });
    }
    console.log(bad ? `${bad} of ${cases.length} cases differ from ppc/gx.ts` : `all ${cases.length} cases as ppc/gx.ts draws them`);
    if (process.argv[5]) writeFileSync(process.argv[5], JSON.stringify(detail));
    process.exit(0);
} else { console.log('capture | script | check | compare | model'); process.exit(2); }
