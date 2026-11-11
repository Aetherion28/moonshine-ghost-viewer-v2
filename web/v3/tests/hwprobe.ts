// Makes a script for tools/hwprobe (a Wii program that feeds a console's GPU and saves what it drew): the goop
// passes of a replay, each as the console's GPU got it (its registers, its textures, its commands up to the frame
// buffer copy), to be drawn again on a real console and compared with ppc/gx.ts texel by texel.
// Run: node v3hwprobe.mjs capture <trace> <out.passes> <ticks a-b[,c-d ...]> [most passes]    (ONLY=stamps: the passes that draw a stamp;
//        TEXEL='x,y': the passes that change this texel of their map or stamp over it (NEAR=n: or within n texels of it); LOCKED=a.sb: event scripts that start locked)
//      node v3hwprobe.mjs script <out.gxps> <a.passes> [...]     the script, and <out.gxps>.cases.json (what each case is)
//        (VERBATIM=n passes as they were, evenly spread; MUST='x,y;x,y' and those with a stamp over these texels;
//         SYN=n passes with test textures; GRID=0 without the script's own stamp cases)
//      node v3hwprobe.mjs check <script.gxps>                    the script through ppc/gx.ts (what it expects of a console)
//      node v3hwprobe.mjs compare <script.gxps> <answer.gxpo>    a console's answer against ppc/gx.ts, case by case
//      node v3hwprobe.mjs model <script.gxps> <out.gxpo>         ppc/gx.ts's own answer, as a console would save it
//      node v3hwprobe.mjs chain <trace> <prefix> <last tick> [passes a job]
//        every goop pass of a replay as jobs <prefix>-000.gxps, ..., the layer's map carried from pass to pass on the
//        console (sent once: after that each pass draws over what the console's own last pass left), so the answers
//        are the console's map after every pass of the recording; <prefix>.model.bin: ppc/gx.ts's own maps
//      node v3hwprobe.mjs chaincmp <prefix> <answer 000> [...]    the console's maps against ppc/gx.ts's, pass by pass
//        (WATCH='x,y': that texel's history; writes <prefix>.console.bin, the console's maps)
//      node v3hwprobe.mjs feed <script.gxps> <out.bin>           the bytes the script sends to the GPU (for tools/hwprobe/hosttest)
import { readFileSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { serialize, deserialize } from 'node:v8';
import { Gx, xfArith } from '../ppc/gx.ts';
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
    stamps: { q: number[]; tex: number; type: number; c0: number; c1: number; k?: number }[];
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
        const depth = fmt === 6 && (bp[0x43] & 7) === 3;   // (the depth buffer as a Z24X8 texture)
        if ((fmt < 7 || fmt > 10) && !depth) throw new Error(`a copy to format ${fmt}`);
        P.dst = (bp[COPY_DST] << 5) & 0x03FFFFFF; P.dstSize = depth ? ((sw + 3) >> 2) * ((sh + 3) >> 2) * 64 : ((sw + 7) >> 3) * ((sh + 3) >> 2) * 32;
        need(P.dst, P.dstSize, 'dst', { w: sw, h: sh, fmt: depth ? 6 : 1 });
    });
    for (const [key, [lo, hi]] of P.arrays) need(lo, hi - lo, 'array ' + key);
    P.result = ramAfter.slice(P.dst, P.dst + P.dstSize);
    P.ram = null;
}

/**
 * A pass as a script case. sub: other contents for a block (by game address); window: the stamps' height window
 * (TEV colours 1 and 2) set to these two values instead of each stamp's own; repeat: the stamps' texture repeats
 * (for texture coordinates past 1).
 */
function emit(S: Script, A: Arena, P: Pass, label: string, sub: Map<number, Uint8Array> = new Map(), window: number[] | null = null, repeat = false, chain: Set<string> | null = null) {
    S.note(label);
    const off = new Map<number, number>();
    for (const [addr, b] of P.blocks) {
        const key = `${addr}:${b.size}`, d = sub.get(addr) ?? b.data;
        if (d.length !== b.size) throw new Error('a substitute of another size');
        let at = A.at.get(key);
        if (at === undefined) { at = A.top; A.at.set(key, at); A.top += (b.size + 31) & ~31; }
        off.set(addr, at);
        // (chained: the map the console's own last pass left is drawn over, not this replay's)
        if (chain && addr === P.dst && chain.has(key)) continue;
        // (a block the console has as the script left it isn't sent again)
        const has = A.has.get(key);
        if (!has || has.length !== d.length || has.some((v, i) => v !== d[i])) { S.mem(at, d); A.has.set(key, d); }
    }
    A.has.delete(`${P.dst}:${P.blocks.get(P.dst)!.size}`);   // (the copy will write it)
    if (chain) chain.add(`${P.dst}:${P.blocks.get(P.dst)!.size}`);
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
    const bp = P.bp.slice(); let mask = 0xFFFFFF, stampsOn = false, repeated = false;
    for (const c of P.cmds) {
        if (c[0] === 0x61) {
            const w = r32(c, 1), reg = w >>> 24; let v = w & 0xFFFFFF;
            if (reg === 0xFE) mask = v; else { bp[reg] = ((bp[reg] & ~mask) | (v & mask)) & 0xFFFFFF; mask = 0xFFFFFF; }
            // (the stamps' height window: set before each stamp, after the layer's own quad)
            if (window && stampsOn && reg >= 0xE2 && reg <= 0xE5 && !(v & 0x800000)) { const k = window[(reg - 0xE2) >> 1] & 0x7FF; v = (k << 12) | k; }
            if (repeat && stampsOn && reg === 0x80) v = (v & ~0xF) | 5;
            bpAny(reg, v);
        } else if (c[0] === 0x08) cpw(c[1], r32(c, 2));
        else {
            if ((c[0] & 0x80) && ((bp[0] >>> 10) & 15) === 1) stampsOn = true;
            if (repeat && !repeated && (c[0] & 0x80) && ((bp[0] >>> 10) & 15) === 2) { repeated = true; bpw(0x80, (bp[0x80] & ~0xF) | 5); }
            S.fifo(c);
        }
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
 * the height map; 16-bit numbers). k: the texture's corner is (k, k) instead of (1, 1): the texture k times across. w, h: a rectangle instead of a square.
 */
function withStamps(P: Pass, list: { x: number; y: number; size: number; k?: number; w?: number; h?: number }[]): Pass {
    const bp = P.bp.slice(), cmds: Uint8Array[] = []; let done = false;
    for (const c of P.cmds) {
        if (c[0] === 0x61) bp[c[1]] = r32(c, 1) & 0xFFFFFF;
        if ((c[0] & 0x80) && ((bp[0] >>> 10) & 15) === 2) {
            if (c[0] !== 0x80 || c.length !== 51) throw new Error('a stamp that is not four vertices of 12 bytes');
            if (done) continue;
            done = true;
            for (const st of list) {
                const b: number[] = [0x80, 0, 4], w = (v: number) => b.push((v >> 8) & 0xFF, v & 0xFF);
                for (const [i, j] of [[0, 0], [1, 0], [1, 1], [0, 1]]) { const x = st.x + i * (st.w ?? st.size), y = st.y + j * (st.h ?? st.size); w(x); w(y); w(i * (st.k ?? 1)); w(j * (st.k ?? 1)); w(x); w(y); }
                cmds.push(Uint8Array.from(b));
            }
        } else cmds.push(c);
    }
    if (!done) throw new Error('a pass without a stamp');
    const s0 = P.stamps[0];
    return { ...P, cmds, stamps: list.map((st) => ({ q: [st.x, st.y, st.x + (st.w ?? st.size), st.y + (st.h ?? st.size)], tex: s0.tex, type: s0.type, c0: WINDOW[0], c1: WINDOW[1], k: st.k ?? 1 })) };
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
    const R = new Replay(loadBytes(JP_DOL), jpDisc(), T, JP10, (n) => S.byName.get(n), { log: (s) => { if (/^\[/.test(s)) console.log(s); }, fstPad: +(process.env.FSTPAD ?? (process.env.DISC ? 0 : 480)), scriptsLocked: (process.env.LOCKED || '').split(',').filter(Boolean), drawBath: !!process.env.BATH, stopOn: process.env.ALL ? ['heap', 'layout'] : undefined, maxIssues: process.env.ALL ? 100000 : 50 });
    const m = R.m, gx = m.hw.gx, ram = m.mem.ram;
    const texel = process.env.TEXEL ? process.env.TEXEL.split(',').map(Number) : null;
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
        cur.stamps.push({ q: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round),   // (a corner past the viewport's middle is 1/12 lower)
             tex: (bp[0x94] << 5) & 0x03FFFFFF, type: ((bp[0xC4] >>> 12) & 15) === 8 ? 0 : 1, c0: gx.tevReg[7], c1: gx.tevReg[11] });
        cur.hmap = (bp[0x95] << 5) & 0x03FFFFFF;
    };
    // a pass ends with its copy
    gx.copyTrace = () => {
        gx.recAll = false; skipping = false;
        if (!cur) return;
        seen++;
        if (process.env.LIST) {
            // (LIST=clean | goop: only a line a pass with those stamps' quads; nothing kept)
            const want = process.env.LIST === 'clean' ? 0 : 1, l = cur.stamps.filter((st) => st.type === want);
            if (l.length) console.log(`tick ${cur.tick}: ${l.map((st) => st.q.join(' ')).join('; ')}`);
        } else if (texel) {
            finish(cur, ram);
            const d = cur.blocks.get(cur.dst)!, [x, y] = texel, at = (((y >> 2) * (d.w! >> 3)) + (x >> 3)) * 32 + (y & 3) * 8 + (x & 7);
            const near = +(process.env.NEAR || 0), over = cur.stamps.some((st) => x + near >= st.q[0] && x - near < st.q[2] && y + near >= st.q[1] && y - near < st.q[3]);
            if (x < d.w! && y < d.h! && (over || d.data[at] !== cur.result![at])) { passes.push(cur); console.log(`pass ${passes.length} at tick ${cur.tick}: ${cur.stamps.length} stamps${over ? ', one over the texel: ' + cur.stamps.filter((st) => x + near >= st.q[0] && x - near < st.q[2] && y + near >= st.q[1] && y - near < st.q[3]).map((st) => `${st.type ? 'goop' : 'clean'} ${st.q.join(' ')}`).slice(0, 6).join('; ') : ''}; the texel ${d.data[at]} -> ${cur.result![at]} (map ${hex(cur.dst)}, ${d.w} x ${d.h})`); }
        } else if (!onlyStamps || cur.stamps.length) { finish(cur, ram); passes.push(cur); if (passes.length % 100 === 1) console.log(`pass ${passes.length} at tick ${cur.tick}: ${cur.cmds.length} commands, ${cur.stamps.length} stamps, ${[...cur.blocks].map(([a, k]) => `${hex(a)} ${k.kind} ${k.size}`).join(', ')}`); }
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
        const add = (type: number, variant: string, list: { x: number; y: number; size: number; k?: number; w?: number; h?: number }[], tex: Uint8Array | null, map: Uint8Array) => {
            const P = list.length ? withStamps(T[type], list) : { ...T[type], cmds: withStamps(T[type], []).cmds, stamps: [] }, label = `grid ${type ? 'goop' : 'clean'} ${variant}`;
            // (the height map all of one height, and every height let through)
            const m = new Map<number, Uint8Array>([[P.dst, map], [P.hmap, new Uint8Array(P.blocks.get(P.hmap)!.size).fill(128)]]); if (tex) m.set(T[type].stamps[0].tex, tex);
            emit(Sc, A, P, label, m, WINDOW, list.some((st) => (st.k ?? 1) > 1));
            cases.push({ label, source: 'grid', tick: 0, variant: `${type ? 'goop' : 'clean'} ${variant}`, w: dim[type].w!, h: dim[type].h!, stamps: P.stamps });
        };
        // (a map of 0: a goop stamp leaves its alpha there, a cleaning stamp its alpha squared, near enough)
        const flat = (type: number) => new Uint8Array(dim[type].size);
        const texes: [string, Uint8Array][] = [['realClean', realTex[0]], ['realGoop', realTex[1]], ...VARIANTS.filter(([n]) => !n.startsWith('blocks')).map(([n, f]) => [n, i8(64, 64, f)] as [string, Uint8Array])];
        if (!process.env.SWEEP) for (const type of [0, 1]) {
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
        // AMP=1: one big stamp with the texture many times across (the texture repeating), so that the rounding of the
        // console's interpolation grows to something the saw-tooth textures show
        if (process.env.AMP) for (const k of [1, 16, 256, 1024]) for (const [x, y, size] of [[8, 8, 240], [10, 10, 100], [140, 140, 100], [120, 120, 24], [3, 131, 120]]) {
            for (const [name, tex] of texes.filter(([nm]) => /^(fine|saw)/.test(nm))) add(1, `${name} amp ${k} ${x},${y},${size}`, [{ x, y, size, k }], tex, flat(1));
        }
        // DENSE=1: the game's stamp sizes with a corner on every column and row of the map (fine saw-tooth textures)
        if (process.env.DENSE) for (const size of [4, 6, 8, 12, 14, 16, 18, 20, 24]) {
            const P = Math.ceil((size + 8) / 8) * 8, n = Math.floor(256 / P);
            for (let L = 0; L * n < P; L++) {
                const list: { x: number; y: number; size: number }[] = [];
                for (let r = 0; r < n; r++) for (let j = 0; j < n; j++) { const x = j * P + (L * n + r) % P, y = r * P + (L * n + j) % P; if (x + size <= 256 && y + size <= 256) list.push({ x, y, size }); }
                for (const [name, tex] of texes.filter(([nm]) => /^fine/.test(nm))) add(1, `${name} dense ${size} ${L}`, list, tex, flat(1));
            }
        }
        // SWEEP=1 (and nothing else of the grid): thin stamps of every length, the texture 256, 1024 or 4096 times across,
        // to read the slope of the console's texture coordinate along each one (S along rows, T along columns)
        if (process.env.SWEEP === '1') {
            type St = { x: number; y: number; size: number; k?: number; w?: number; h?: number };
            const fine = (A: string) => texes.filter(([nm]) => nm.startsWith('fine' + A));
            const put = (A: string, name: string, list: St[]) => { for (let o = 0; o < list.length; o += 40) for (const [nm, tex] of fine(A)) add(1, `${nm} sweep ${name} ${o / 40}`, list.slice(o, o + 40).map((st, n) => A === 'S' ? { ...st, y: 2 + 6 * n } : { ...st, x: 2 + 6 * n }), tex, flat(1)); };
            const len = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_v, i) => from + i);
            for (const k of [1024, 256, 4096]) for (const x of k === 1024 ? [4, 130, 64] : [4]) {
                put('S', `k ${k} x ${x}`, len(2, 121).map((w) => ({ x, y: 0, size: 0, w, h: 5, k })));
                put('T', `k ${k} y ${x}`, len(2, 121).map((h) => ({ x: 0, y: x, size: 0, w: 5, h, k })));
            }
            // the same lengths from other corners, and with other heights
            put('S', 'corner', [100, 120, 24, 50, 64].flatMap((w) => len(0, 7).map((x) => ({ x, y: 0, size: 0, w, h: 5, k: 1024 }))));
            for (const w of [100, 120]) for (const [nm, tex] of fine('S')) {
                let y = 1; const list: St[] = [];
                for (const h of [2, 3, 5, 9, 17, 33, 65, 100]) { list.push({ x: 4, y, size: 0, w, h, k: 1024 }); y += h + 1; }
                add(1, `${nm} sweep heights ${w}`, list, tex, flat(1));
            }
        }
        // SWEEP=2: the same thin stamps with the texture a different number of times across in each case, so that each
        // pixel's weight (what the console multiplies the texture's length by) can be read to a few bits past its own
        if (process.env.SWEEP === '2') {
            const list: { x: number; y: number; size: number; k?: number; w?: number; h?: number }[] = [];
            let y = 2;
            for (const x of [4, 6, 130, 60]) for (const w of [100, 64, 97, 120, 50, 24, 12, 77]) { list.push({ x, y, size: 0, w, h: 5 }); y += 6; }
            for (const [w, h] of [[100, 3], [100, 9], [97, 3], [97, 9]]) { list.push({ x: 4, y, size: 0, w, h }); y += h + 1; }
            const tall = list.map((st) => ({ x: st.y, y: st.x, size: 0, w: st.h, h: st.w }));
            for (const k of [1024, 1021, 1013, 997, 983, 967, 947, 929, 911, 887, 863, 839, 811, 787, 761, 733, 709, 683, 659, 631, 607, 577, 547, 521]) {
                for (const [nm, tex] of texes.filter(([n]) => /^fineS/.test(n))) add(1, `${nm} weights k ${k}`, list.map((st) => ({ ...st, k })), tex, flat(1));
                if (k > 1000 || k < 530) for (const [nm, tex] of texes.filter(([n]) => /^fineT/.test(n))) add(1, `${nm} weights k ${k}`, tall.map((st) => ({ ...st, k })), tex, flat(1));
            }
            // squares, for the triangle whose weights both change
            for (const k of [1024, 1021, 1013, 997, 983, 967, 947, 929]) for (const [nm, tex] of texes.filter(([n]) => /^fine/.test(n))) add(1, `${nm} weights square k ${k}`, [{ x: 4, y: 4, size: 100, k }, { x: 6, y: 134, size: 97, k }, { x: 134, y: 6, size: 100, k }, { x: 140, y: 140, size: 64, k }], tex, flat(1));
        }
        // SWEEP=3: one thin stamp shape on every row of the map and from several columns (is what the console loses a
        // matter of where on the screen the stamp is?)
        if (process.env.SWEEP === '3') {
            const fineS = texes.filter(([n]) => /^fineS/.test(n));
            const rows = (x: number, w: number, r: number) => Array.from({ length: 41 }, (_v, n) => ({ x, y: 6 * n + r, size: 0, w, h: 5, k: 1024 })).filter((st) => st.y + 5 <= 256);
            for (const w of [100, 92]) for (let r = 0; r < 6; r++) for (const [nm, tex] of fineS) add(1, `${nm} place w ${w} x 4 r ${r}`, rows(4, w, r), tex, flat(1));
            for (const x of [0, 1, 2, 3, 5, 8, 12, 16, 24]) for (const [nm, tex] of fineS) add(1, `${nm} place w 100 x ${x} r 2`, rows(x, 100, 2), tex, flat(1));
        }
        if (!process.env.SWEEP)
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
} else if (mode === 'chain') {
    const { readTrace } = await import('../game/trace.ts');
    const { Replay, JP10 } = await import('../game/replay.ts');
    const { symbols } = await import('./syms.ts');
    const { jpDisc, JP_DOL, loadBytes } = await import('./jpdisc.ts');
    const S = symbols();
    const b = readFileSync(process.argv[3]);
    const T = readTrace(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    const prefix = process.argv[4], lastTick = +process.argv[5], per = +(process.argv[6] || 250);
    const R = new Replay(loadBytes(JP_DOL), jpDisc(), T, JP10, (n) => S.byName.get(n), { log: (s) => { if (/^\[/.test(s)) console.log(s); }, fstPad: +(process.env.FSTPAD ?? (process.env.DISC ? 0 : 480)), scriptsLocked: (process.env.LOCKED || '').split(',').filter(Boolean), drawBath: !!process.env.BATH });
    const m = R.m, gx = m.hw.gx, ram = m.mem.ram;
    const A: Arena = { at: new Map(), has: new Map(), top: 0, scratch: -1 }, chained = new Set<string>();
    let Sc = new Script(), cases: object[] = [], lead: string[] = [], job = 0, n = 0;
    const model = openSync(prefix + '.model.bin', 'w');
    const endJob = () => {
        if (!cases.length) return;
        const name = `${prefix}-${String(job).padStart(3, '0')}.gxps`, bytes = Sc.bytes();
        writeFileSync(name, bytes); writeFileSync(name + '.cases.json', JSON.stringify({ lead, cases }));
        console.log(`${name}: ${cases.length} passes, ${bytes.length} bytes, arena ${A.top}`);
        job++; Sc = new Script(); Sc.arena = A.top; cases = [];
        // (the next job begins by saving the maps as the console has them: they must be what the last job left)
        lead = [...chained];
        for (const key of lead) Sc.dump(A.at.get(key)!, +key.split(':')[1]);
    };
    let cur: Pass | null = null;
    gx.rec = (cmd, raster) => {
        if (R.ticks > lastTick) return;
        if (!cur) {
            gx.recAll = true;
            cur = { tick: R.ticks, bp: gx.bp.slice(), cp: gx.cp.slice(), xfw: gx.xfw.slice(), tevReg: gx.tevReg.slice(), konst: gx.konst.slice(), bpSeen: gx.bpSeen.slice(), cmds: [], ram: ram.slice(), arrays: new Map(), blocks: new Map(), dst: 0, dstSize: 0, result: null, stamps: [], hmap: 0 };
        }
        if (cmd[0] === 0x61 && (cmd[1] === 0x45 || cmd[1] === 0x47 || cmd[1] === 0x48 || (cmd[1] === 0x52 && !raster))) return;
        cur.cmds.push(cmd.slice());
    };
    gx.arrayTrace = (array, at, len) => {
        if (!cur) return;
        const key = `${array}:${gx.cp[0xA0 + array] & 0x03FFFFFF}`, r = cur.arrays.get(key);
        if (!r) cur.arrays.set(key, [at, at + len]); else { if (at < r[0]) r[0] = at; if (at + len > r[1]) r[1] = at + len; }
    };
    gx.drawTrace = (prim, count) => { if (cur && prim === 0x80 && count === 4 && ((gx.bp[0] >>> 10) & 15) === 2) cur.stamps.push({ q: [], tex: 0, type: 0, c0: 0, c1: 0 }); };
    gx.copyTrace = () => {
        gx.recAll = false;
        if (!cur) return;
        const P = cur; cur = null;
        finish(P, ram);
        const d = P.blocks.get(P.dst)!;
        emit(Sc, A, P, `pass ${n} tick ${P.tick}`, new Map(), null, false, chained);
        const packed = rleEncode(P.result!), head = new Uint8Array(16), hv = new DataView(head.buffer);
        hv.setUint32(0, n); hv.setUint32(4, P.tick); hv.setUint32(8, P.result!.length); hv.setUint32(12, packed.length);
        writeSync(model, head); writeSync(model, packed);
        cases.push({ n, tick: P.tick, w: d.w, h: d.h, dst: P.dst, stamps: P.stamps.length });
        if (++n % per === 0) endJob();
    };
    while (m.cpu.count < 4000e9 && R.run(50e6) !== 'done' && R.ticks <= lastTick + 8) { /* on */ }
    endJob(); closeSync(model);
    console.log(`${n} passes in ${job} jobs to tick ${R.ticks}; issues: ${R.issues.length ? String((R.issues[0] as any).text).split('\n')[0] : 'none'}`);
    process.exit(0);
} else if (mode === 'chaincmp') {
    const prefix = process.argv[3], watch = process.env.WATCH ? process.env.WATCH.split(',').map(Number) : null;
    const mb = readFileSync(prefix + '.model.bin'), models: { n: number; tick: number; at: number; raw: number; len: number }[] = [];
    for (let p = 0; p < mb.length;) { const len = r32(mb, p + 12); models.push({ n: r32(mb, p), tick: r32(mb, p + 4), raw: r32(mb, p + 8), at: p + 16, len }); p += 16 + len; }
    const out = openSync(prefix + '.console.bin', 'w');
    let last = new Map<string, Uint8Array>(), prevDiff = new Map<number, string>(), k = 0, firstBad = -1, worst = 0;
    const news: object[] = [];
    for (const [j, file] of process.argv.slice(4).entries()) {
        const meta = JSON.parse(readFileSync(`${prefix}-${String(j).padStart(3, '0')}.gxps.cases.json`, 'utf8')) as { lead: string[]; cases: { n: number; tick: number; w: number; h: number; dst: number; stamps: number }[] };
        const o = new Uint8Array(readFileSync(file)), got: Uint8Array[] = [];
        if (r32(o, 0) !== 0x4758504F) throw new Error('not an answer file');
        for (let p = 16; p + 16 <= o.length;) {
            const kind = r32(o, p), bb = r32(o, p + 8), len = r32(o, p + 12), data = o.subarray(p + 16, p + 16 + len);
            if (kind === 102) console.log(`job ${j}: the console stopped the script: ${Buffer.from(data).toString('latin1')}`);
            else if (kind === OP.DUMP || kind === OP.READ16) got.push(data.slice());
            else if (kind === OP.MEMRLE) got.push(rleDecode(data, bb));
            p += 16 + ((len + 3) & ~3);
        }
        for (const [i, key] of meta.lead.entries()) {
            const was = last.get(key), now = got[i];
            if (was && (was.length !== now.length || was.some((v, q) => v !== now[q]))) throw new Error(`job ${j}: the console's map ${key} is not what job ${j - 1} left`);
        }
        for (const [i, c] of meta.cases.entries()) {
            const map = got[meta.lead.length + 2 * i + 1], M = models[k++];
            if (!map) { console.log(`pass ${c.n}: no answer`); continue; }
            if (M.n !== c.n) throw new Error('the model file and the jobs are out of step');
            const want = rleDecode(mb.subarray(M.at, M.at + M.len), M.raw);
            last.set(`${c.dst}:${map.length}`, map);
            const packed = rleEncode(map), head = new Uint8Array(16), hv = new DataView(head.buffer);
            hv.setUint32(0, c.n); hv.setUint32(4, c.tick); hv.setUint32(8, map.length); hv.setUint32(12, packed.length);
            writeSync(out, head); writeSync(out, packed);
            const d = diffI8(want, map, c.w, c.h), now = new Map<number, string>();
            const fresh: number[][] = [];
            for (const q of d) { const id = q[1] * 4096 + q[0], v = `${q[2]}>${q[3]}`; now.set(id, v); if (prevDiff.get(id) !== v) fresh.push(q); }
            if (d.length && firstBad < 0) firstBad = c.n;
            worst = Math.max(worst, d.length);
            if (fresh.length) news.push({ n: c.n, tick: c.tick, total: d.length, fresh });
            if (fresh.length && news.length <= 40) console.log(`pass ${c.n} tick ${c.tick} (${c.stamps} stamps): ${d.length} texels differ, new: ${fresh.slice(0, 8).map((q) => `(${q[0]},${q[1]}) ${q[2]}->${q[3]}`).join(' ')}${fresh.length > 8 ? ` ... ${fresh.length}` : ''}`);
            if (watch) { const at = (((watch[1] >> 2) * (c.w >> 3)) + (watch[0] >> 3)) * 32 + (watch[1] & 3) * 8 + (watch[0] & 7); const key = `${want[at]}/${map[at]}`; if ((watch as any).last !== key) { (watch as any).last = key; console.log(`    pass ${c.n} tick ${c.tick}: texel (${watch[0]},${watch[1]}) is ${want[at]} here, ${map[at]} on the console`); } }
            prevDiff = now;
        }
    }
    closeSync(out);
    writeFileSync(prefix + '.news.json', JSON.stringify(news));
    console.log(`${k} passes compared (model -> console); the first with a difference: ${firstBad}; passes with new differences: ${news.length}; most texels different at once: ${worst}`);
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
} else if (mode === 'depth') {
    // depth cases on a bath water pass's state (its view from above, its projection, its depth test): the pass's
    // own primitives replaced by flat squares at many heights (what depth a vertex gets) and by triangles between
    // heights (how depth goes over a triangle). <out>.cases.json has each case's primitives.
    //   node v3hwprobe.mjs depth <out.gxps> <bath.passes> [flat cases] [triangle cases]   (SEED=n)
    const outPath = process.argv[3], P0 = (deserialize(readFileSync(process.argv[4])) as Pass[])[0];
    const nFlat = +(process.argv[5] ?? 4), nTri = +(process.argv[6] ?? 8);   // (STAGES=n: and n cases of each step of a vertex's depth)
    const Sc = new Script(), A: Arena = { at: new Map(), has: new Map(), top: 0, scratch: -1 }, cases: object[] = [];
    let seed = +(process.env.SEED || 1);
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) / 16777216; };
    // the state as the pass's caps are drawn: every command but the primitives; the commands after the last primitive are the copy
    let lastPrim = -1; P0.cmds.forEach((c, i) => { if (c[0] & 0x80) lastPrim = i; });
    const state = P0.cmds.slice(0, lastPrim).filter((c) => !(c[0] & 0x80)), tail = P0.cmds.slice(lastPrim + 1);
    // the transform there (to place the cases on the screen): the position matrix, the projection, the viewport
    const xw = P0.xfw.slice(), xf = new Float32Array(xw.buffer);
    for (const c of state) if (c[0] === 0x10) { const n = (c[2] & 15) + 1, addr = (c[3] << 8) | c[4]; for (let i = 0; i < n; i++) if (addr + i < xw.length) xw[addr + i] = r32(c, 5 + 4 * i); }
    const m = (xw[0x1018] & 63) * 4;
    const screen = (x: number, y: number, z: number) => {
        const ex = xf[m] * x + xf[m + 1] * y + xf[m + 2] * z + xf[m + 3], ey = xf[m + 4] * x + xf[m + 5] * y + xf[m + 6] * z + xf[m + 7];
        return [(xf[0x1020] * ex + xf[0x1021]) * xf[0x101A] + xf[0x101D] - 342, (xf[0x1022] * ey + xf[0x1023]) * xf[0x101B] + xf[0x101E] - 342];
    };
    // (the view looks straight down: the screen is the model's x and z, the depth its height)
    const o = screen(0, 0, 0), dx = screen(1, 0, 0), dz = screen(0, 0, 1);
    const a11 = dx[0] - o[0], a12 = dz[0] - o[0], a21 = dx[1] - o[1], a22 = dz[1] - o[1], det = a11 * a22 - a12 * a21;
    const model = (sx: number, sy: number) => { const u = sx - o[0], v = sy - o[1]; return [(u * a22 - a12 * v) / det, (a11 * v - u * a21) / det]; };
    const f32 = new DataView(new ArrayBuffer(4));
    const vert = (out: number[], sx: number, sy: number, h: number) => { const [x, z] = model(sx, sy); for (const v of [x, h, z]) { f32.setFloat32(0, v); out.push(f32.getUint8(0), f32.getUint8(1), f32.getUint8(2), f32.getUint8(3)); } out.push(0x40, 0x40); return [Math.fround(x), Math.fround(h), Math.fround(z)]; };
    const add = (label: string, prims: { cmd: number[]; verts: number[][]; pre?: number[][]; meta?: object }[]) => {
        const cmds: Uint8Array[] = [];
        for (const p of prims) { for (const c of p.pre ?? []) cmds.push(Uint8Array.from(c)); cmds.push(Uint8Array.from(p.cmd)); }
        const P: Pass = { ...P0, cmds: [...state, ...cmds, ...tail] };
        emit(Sc, A, P, label);
        const d = P.blocks.get(P.dst)!;
        cases.push({ label, source: 'depth', tick: P0.tick, variant: '', w: d.w!, h: d.h!, stamps: [], prims: prims.map((p) => p.verts), meta: prims.map((p) => p.meta ?? null) });
    };
    const xfLoad = (addr: number, vals: number[]) => { const c = [0x10, 0, vals.length - 1, addr >> 8, addr & 0xFF]; for (const v of vals) { f32.setFloat32(0, v); c.push(f32.getUint8(0), f32.getUint8(1), f32.getUint8(2), f32.getUint8(3)); } return c; };
    // a flat square of 4 x 4 pixels, the q-th of 20 x 20, at height h (the two windings: one is culled)
    const square = (q: number, h: number, pre: number[][] = [], meta: object | undefined = undefined) => {
        const x0 = 2 + (q % 20) * 4, y0 = 2 + ((q / 20) | 0) * 4, corners = [[x0, y0], [x0 + 4, y0], [x0 + 4, y0 + 4], [x0, y0 + 4]], out: { cmd: number[]; verts: number[][]; pre?: number[][]; meta?: object }[] = [];
        for (const order of [[0, 1, 2, 3], [3, 2, 1, 0]]) {
            const cmd = [0x80, 0, 4], verts: number[][] = [];
            for (const k of order) verts.push(vert(cmd, corners[k][0], corners[k][1], h));
            out.push({ cmd, verts, pre: out.length ? [] : pre, meta });
        }
        return out;
    };
    // ---- the steps of a vertex's depth, one at a time (STAGES=n cases of each): the eye's depth is row 3 of the
    // position matrix times the vertex, the clip depth is projection[4] * eye + projection[5], the screen's is
    // clip * viewport scale + viewport offset. Each case keeps the other steps exact (a matrix row of (0, 1, 0, 0),
    // a projection of (1, 0), a viewport of powers of two that leaves the clip depth's every bit in the result).
    const nStage = +(process.env.STAGES || 0), row3 = m + 8;
    const mant = () => (0x800000 + Math.floor(rnd() * 0x800000)) / 0x1000000;   // 24 bits, in [0.5, 1)
    for (let k = 0; k < nStage; k++) {
        // the viewport step: clip depths of every size against the game's scale and offset, and two other pairs
        const [zs, zo] = [[16777215, 16777215], [16777215, 16777215], [16777216, 16777216], [8388607, 16777215], [12345678, 14000000]][k % 5];
        const prims = [];
        for (let q = 0; q < 400; q++) {
            const b = q % 12, cz = -mant() * Math.pow(2, -b);   // (-1, 0), twelve sizes
            prims.push(...square(q, cz, [xfLoad(row3, [0, 1, 0, 0]), xfLoad(0x1024, [1, 0]), xfLoad(0x101C, [zs]), xfLoad(0x101F, [zo])], { step: 'viewport', cz, zs, zo }));
        }
        add(`viewport ${k}`, prims);
    }
    for (let k = 0; k < nStage; k++) {
        // the projection step: clip = a * eye + b, read back whole through a viewport of 2^(24 + size) and 2^24
        const prims = [];
        for (let q = 0; q < 400; q++) {
            const b = q % 6;
            let a = 0, eye = 0, c = 0, cz = 0;
            for (let tries = 0; tries < 1000; tries++) {
                // (the game's kind: a small factor, a depth of thousands, minus one; and others)
                if (k % 2 === 0) { a = Math.fround(-(0.5 + rnd()) / 12000); eye = Math.fround(-rnd() * 12000); c = -1; }
                else { a = Math.fround((rnd() - 0.5) * 4); eye = Math.fround((rnd() - 0.5) * 4); c = Math.fround((rnd() - 0.5) * 2); }
                cz = a * eye + c;
                if (cz < -Math.pow(2, -b - 1) * 1.001 && cz > -Math.pow(2, -b) * 0.999) break;
            }
            prims.push(...square(q, eye, [xfLoad(row3, [0, 1, 0, 0]), xfLoad(0x1024, [a, c]), xfLoad(0x101C, [Math.pow(2, 24 + b)]), xfLoad(0x101F, [16777216])], { step: 'projection', a, eye, c, b }));
        }
        add(`projection ${k}`, prims);
    }
    for (let k = 0; k < nStage; k++) {
        // the position matrix's step: eye = m * height + t (the row's other two are 0), read back whole
        const prims = [];
        for (let q = 0; q < 400; q++) {
            const b = q % 6;
            let mm = 0, h = 0, t = 0, ez = 0;
            for (let tries = 0; tries < 1000; tries++) {
                if (k % 2 === 0) { mm = 1; h = Math.fround(1900 + rnd() * 11800); t = Math.fround(-13800 - rnd()); }
                else { mm = Math.fround((rnd() - 0.5) * 4); h = Math.fround((rnd() - 0.5) * 4); t = Math.fround((rnd() - 0.5) * 2); }
                ez = mm * h + t;
                // (as a clip depth it has to be in (-1, 0): the first kind is scaled down by 2^-14 in the projection, exactly)
                const cz = k % 2 === 0 ? ez / 16384 : ez;
                if (cz < -Math.pow(2, -b - 1) * 1.001 && cz > -Math.pow(2, -b) * 0.999) break;
            }
            prims.push(...square(q, h, [xfLoad(row3, [0, mm, 0, t]), xfLoad(0x1024, [k % 2 === 0 ? 1 / 16384 : 1, 0]), xfLoad(0x101C, [Math.pow(2, 24 + b)]), xfLoad(0x101F, [16777216])], { step: 'matrix', mm, h, t, b, scale: k % 2 === 0 ? 1 / 16384 : 1 }));
        }
        add(`matrix ${k}`, prims);
    }
    // ---- depth over a triangle, one thing at a time (SLOPES=1): right triangles whose corners sit in the middle of
    // a grid cell just past a whole pixel (so the corner's place on the grid of 1/12 pixel is certain), with heights
    // found for exact depths at the corners (so the slope across and down is known exactly). Both windings start
    // with the same corner.
    if (process.env.SLOPES) {
        const { cut, mulCut, addCut, UNDER_ONE } = xfArith;
        if (xf[row3] !== 0 || xf[row3 + 2] !== 0) throw new Error('the depth here depends on more than the height');
        const zOf = (h: number) => Math.floor(addCut(xf[0x101F], mulCut(cut(addCut(mulCut(xf[0x1024], addCut(mulCut(xf[row3 + 1], h), xf[row3 + 3])), xf[0x1025]) * UNDER_ONE), xf[0x101C])));
        const bitsOf = (v: number) => { f32.setFloat32(0, v); return f32.getUint32(0); }, at = (b: number) => { f32.setUint32(0, b); return f32.getFloat32(0); };
        const hFor = (zT: number) => {
            // (the depth falls as the height rises)
            let lo = bitsOf(1850), hi = bitsOf(13790);
            while (lo < hi) { const mid = (lo + hi) >>> 1; if (zOf(at(mid)) > zT) lo = mid + 1; else hi = mid; }
            for (const d of [0, -1, 1, -2, 2, -3, 3]) if (zOf(at(lo + d)) === zT) return at(lo + d);
            return NaN;   // (the arithmetic skips this depth)
        };
        type Pt = [number, number, number];   // pixel x, y (whole or in twelfths), the depth wanted
        const tri = (pts: Pt[], first = 0) => {
            const out: { cmd: number[]; verts: number[][]; meta?: object }[] = [];
            const o = [first, (first + 1) % 3, (first + 2) % 3];
            for (const order of [o, [o[0], o[2], o[1]]]) {
                const cmd = [0x90, 0, 3], verts: number[][] = [];
                for (const q of order) verts.push(vert(cmd, pts[q][0] + 1 / 24, pts[q][1] + 1 / 24, hFor(pts[q][2])));
                out.push({ cmd, verts, meta: { step: 'slope', pts, order } });
            }
            return out;
        };
        const right = (x: number, y: number, w: number, h: number, z0: number, dx: number, dy: number): Pt[] => {
            // (the nearest depth from z0 up whose three corners all have a height)
            while (isNaN(hFor(z0)) || isNaN(hFor(z0 + dx)) || isNaN(hFor(z0 + dy))) z0++;
            return [[x, y, z0], [x + w, y, z0 + dx], [x, y + h, z0 + dy]];
        };
        if (process.env.SLOPES === '3') {
            // the weights' steps, read through the depth's slope: right triangles of w x h twelfths with a depth
            // difference of 2^(N - 7) along one leg, N = 10 + floor(log2(w h)): the slope in units of 2^-15 is then
            // 256 times the step of the weight along that leg ((the other leg << N) / area on paper). Legs for which
            // that quotient is just above or below a whole number, areas next to a power of two, and others.
            const legs = new Map<string, string>();
            const want = (w: number, h: number, kind: string) => { if (w >= 90 && h >= 90 && w <= 960 && h <= 960 && !legs.has(`${w},${h}`)) legs.set(`${w},${h}`, kind); };
            const nOf = (w: number, h: number) => 10 + Math.floor(Math.log2(w * h));
            const fracOf = (w: number, h: number) => { const q = Math.pow(2, nOf(w, h)) / w; return q - Math.floor(q); };   // (2^N h / (w h))
            for (const [w, h] of [[720, 720], [720, 360], [360, 720], [360, 360], [180, 180], [720, 540], [540, 720], [900, 900], [450, 450], [768, 768], [384, 768], [960, 960], [480, 480], [240, 240], [120, 120], [600, 600], [300, 300], [150, 150], [444, 636], [636, 444], [960, 480], [480, 960]]) want(w, h, 'known');
            // (the quotient's fraction small, large, or middling: the legs with the smallest of each, at most three heights a width)
            const all: [number, number, number][] = [];
            for (let w = 90; w <= 960; w++) for (const h of [w, Math.round(w * 0.71), Math.round(w * 0.5), Math.min(960, Math.round(w * 1.41))]) if (h >= 90 && h <= 960) all.push([w, h, fracOf(w, h)]);
            const pick = (list: [number, number, number][], n: number, kind: string) => { let k = 0; const seen = new Set<number>(); for (const [w, h] of list) { if (k >= n) break; if (seen.has(w)) continue; seen.add(w); want(w, h, kind); k++; } };
            pick(all.filter((v) => v[2] > 0 && v[2] < 0.02).sort((p, q) => p[2] - q[2]), 60, 'just over');
            pick(all.filter((v) => v[2] >= 0.02 && v[2] < 0.06).sort((p, q) => p[2] - q[2]), 40, 'over');
            pick(all.filter((v) => v[2] >= 0.06 && v[2] < 0.15).sort((p, q) => p[2] - q[2]), 25, 'well over');
            pick(all.filter((v) => v[2] > 0.985).sort((p, q) => q[2] - p[2]), 20, 'just under');
            pick(all.filter((v) => v[2] === 0), 12, 'whole');
            // (areas next to a power of two, from both sides)
            for (let e = 13; e <= 19; e++) for (const r of [0.97, 0.985, 0.995, 1.004, 1.015]) { const w = Math.round(Math.sqrt(r * Math.pow(2, e))); let h = Math.round(r * Math.pow(2, e) / w); if ((w * h >= Math.pow(2, e)) !== (r > 1)) h += r > 1 ? 1 : -1; want(w, h, 'power of two'); }
            for (let k = 0; k < 36; k++) want(90 + Math.floor(rnd() * 860), 90 + Math.floor(rnd() * 860), 'any');
            for (const [key, kind] of legs) {
                const [w, h] = key.split(',').map(Number), d = Math.pow(2, nOf(w, h) - 7);
                add(`weight ${kind} ${w}x${h} across ${d}`, tri(right(2, 2, w / 12, h / 12, 9000000, d, 0)));
                add(`weight ${kind} ${w}x${h} down ${d}`, tri(right(2, 2, w / 12, h / 12, 9000000, 0, d)));
            }
        } else if (process.env.SLOPES === '5') {
            // one area, many legs: triangles of the same base and height sheared by s twelfths, so that the step of one
            // weight is (s << N) / area with the same area: the shears for which that quotient is just over or just
            // under a whole number (is the step one lower? how far over may the quotient be?)
            for (const [bs, h] of [[720, 720], [504, 504], [510, 255], [723, 362], [512, 750], [698, 289], [548, 238], [784, 678], [956, 865], [601, 433], [665, 364], [951, 858], [959, 510]]) {
                const A = BigInt(bs * h), L = Math.floor(Math.log2(bs * h)), N = 10 + L, cand: [number, number][] = [];
                for (let sh = 30; sh <= 940; sh++) {
                    const q = (BigInt(sh) << BigInt(N + 20)) / A, frac = Number(q & 0xFFFFFn) / 1048576;
                    const over = frac * 32768 / sh, under = (1 - frac) * 32768 / sh;
                    if (over < 2.2) cand.push([sh, over]); else if (under < 2.2) cand.push([sh, -under]);
                }
                cand.sort((p, q) => p[1] - q[1]);
                const n = Math.min(16, cand.length), d = Math.pow(2, N - 7);
                for (let k = 0; k < n; k++) {
                    const [sh, t] = cand[Math.floor(k * (cand.length - 1) / Math.max(1, n - 1))];
                    let z0 = 9000000; while (isNaN(hFor(z0)) || isNaN(hFor(z0 + d))) z0++;
                    add(`shear ${bs}x${h} by ${sh} (${t.toFixed(3)}) ${d}`, tri([[2, 2, z0], [2 + bs / 12, 2, z0 + d], [2 + sh / 12, 2 + h / 12, z0]]));
                }
            }
        } else if (process.env.SLOPES === '4') {
            // the area's reciprocal (job 27: m = floor(2^(L + 25) / area - c), c between 0.0955 and 0.2315): legs whose
            // weight's step is one lower exactly when c is above the reciprocal's fraction f, for many f in that range
            const picked: [number, number, number, boolean][] = [];
            for (let w = 90; w <= 960 && picked.length < 4000; w++) for (let h = 90; h <= 960; h++) {
                const A = BigInt(w * h), L = Math.floor(Math.log2(w * h)), M = (1n << BigInt(L + 25 + 20)) / A, f = Number(M & 0xFFFFFn) / 1048576;
                if (f < 0.09 || f > 0.24) continue;
                for (const down of [false, true]) {
                    const leg = down ? w : h, q = (BigInt(leg) << BigInt(10 + L + 20)) / A, frac = Number(q & 0xFFFFFn) / 1048576;
                    // (lowered with the fraction plus one, not with the fraction alone; clear of both edges)
                    if (frac > leg * (f + 0.02) / 32768 && frac < leg * (f + 0.98) / 32768) picked.push([w, h, f, down]);
                }
            }
            picked.sort((p, q) => p[2] - q[2]);
            const n = 96;
            for (let k = 0; k < n; k++) {
                const [w, h, f, down] = picked[Math.floor(k * (picked.length - 1) / (n - 1))], d = Math.pow(2, 10 + Math.floor(Math.log2(w * h)) - 7);
                add(`reciprocal ${f.toFixed(5)} ${w}x${h} ${down ? 'down' : 'across'} ${d}`, tri(right(2, 2, w / 12, h / 12, 9000000, down ? 0 : d, down ? d : 0)));
            }
        } else if (process.env.SLOPES === '2') {
            // thin triangles, nine a case, with the slope across only: every slope of a run, the same slope at many
            // places, and corners whose depth has a fraction (a viewport of 2^18: depths in 64ths)
            const thin = (x: number, t: number, z0: number, dx: number): Pt[] => right(x, 2 + 9 * t, 64, 8, z0, dx, 0);
            const runs = (label: string, slopes: number[]) => { for (let k = 0; k < slopes.length; k += 9) add(`${label} ${slopes[k]}..${slopes[Math.min(k + 8, slopes.length - 1)]}`, slopes.slice(k, k + 9).flatMap((d, t) => tri(thin(8, t, 12000000, d)))); };
            const upTo = (n: number, f: (j: number) => number) => Array.from({ length: n }, (_, j) => f(j + 1));
            runs('thin 3j', upTo(135, (j) => 3 * j)); runs('thin -3j', upTo(135, (j) => -3 * j));
            runs('thin j', upTo(135, (j) => j)); runs('thin -j', upTo(135, (j) => -j));
            for (const d of [3, 7, 33, 65, 4099, -33]) for (let k = 0; k < 18; k += 9) add(`thin at x ${2 + k}..${10 + k}: ${d}`, Array.from({ length: 9 }, (_, t) => tri(thin(2 + k + t, t, 12000000, d))).flat());
            // (fractions: the depth of each corner as the transform leaves it, before it is cut to a whole number)
            const zs = 262144, fOf = (h: number) => addCut(zs, mulCut(cut(addCut(mulCut(xf[0x1024], addCut(mulCut(xf[row3 + 1], h), xf[row3 + 3])), xf[0x1025]) * UNDER_ONE), zs));
            const hFrac = (zT: number) => {
                let lo = bitsOf(1850), hi = bitsOf(13790);
                while (lo < hi) { const mid = (lo + hi) >>> 1; if (fOf(at(mid)) > zT) lo = mid + 1; else hi = mid; }
                for (const d of [0, -1, 1, -2, 2, -3, 3]) if (fOf(at(lo + d)) === zT) return at(lo + d);
                return NaN;
            };
            const fracTri = (t: number, z0: number, dx: number, flat = false) => {
                while (isNaN(hFrac(z0)) || isNaN(hFrac(z0 + dx))) z0 += 1 / 64;
                const pts: Pt[] = [[8, 2 + 9 * t, z0], [72, 2 + 9 * t, z0 + dx], [8, 10 + 9 * t, z0]], out: { cmd: number[]; verts: number[][]; pre?: number[][]; meta?: object }[] = [];
                for (const order of [[0, 1, 2], [0, 2, 1]]) {
                    const cmd = [0x90, 0, 3], verts: number[][] = [];
                    for (const q of order) verts.push(vert(cmd, pts[q][0] + 1 / 24, pts[q][1] + 1 / 24, hFrac(pts[q][2])));
                    out.push({ cmd, verts, meta: { step: 'fraction', pts, order, zs } });
                }
                return out;
            };
            const view = [xfLoad(0x101C, [zs]), xfLoad(0x101F, [zs])];
            for (const dx of [0, 1, 3, 33, -1]) for (let k = 0; k < 2; k++) {
                const prims = Array.from({ length: 9 }, (_, t) => fracTri(t, 150000 + (k * 9 + t) * (dx === 0 ? 5 : 4) / 64, dx)).flat();
                prims[0].pre = view;
                add(`fraction ${dx}, ${k}`, prims);
            }
        } else {
        const Z0 = 12000000, D = [1, 2, 3, 7, 16, 31, 32, 33, 63, 64, 65, 95, 96, 97, 127, 128, 129, 1000, 4099, 65543, 1048583, -1, -3, -33, -64, -97, -4099, -65543, -1048583];
        for (const d of D) add(`slope x ${d}`, tri(right(8, 8, 64, 64, Z0, d, 0)));
        for (const d of D) add(`slope y ${d}`, tri(right(8, 8, 64, 64, Z0, 0, d)));
        for (const [dx, dy] of [[33, 97], [97, 33], [-33, 97], [65, -31], [4099, 65543], [-65543, 4099], [1, 1], [127, 127], [3, -3], [1048583, -1048583], [129, 4099], [-4099, -129]]) add(`slope xy ${dx} ${dy}`, tri(right(8, 8, 64, 64, Z0, dx, dy)));
        // (where the triangle starts: odd and even pixels)
        for (const [ox, oy] of [[9, 8], [8, 9], [9, 9]]) for (const [dx, dy] of [[33, 0], [4099, 0], [0, 33], [0, 4099]]) add(`slope at ${ox},${oy}: ${dx} ${dy}`, tri(right(ox, oy, 64, 64, Z0, dx, dy)));
        // (which corner comes first)
        for (const first of [1, 2]) for (const [dx, dy] of [[33, 0], [0, 97], [33, 97]]) add(`slope from corner ${first}: ${dx} ${dy}`, tri(right(8, 8, 64, 64, Z0, dx, dy), first));
        // (other widths and heights)
        for (const [w, h] of [[60, 60], [37, 53], [80, 80]]) for (const [dx, dy] of [[1000, 0], [0, 1000], [4099, 0], [0, 4099]]) add(`slope ${w}x${h}: ${dx} ${dy}`, tri(right(2, 2, w, h, Z0, dx, dy)));
        // (corners between pixels)
        for (const k of [1, 5, 6, 7, 11]) { add(`slope x off ${k}/12: 4099`, tri(right(8 + k / 12, 8, 64, 64, Z0, 4099, 0))); add(`slope y off ${k}/12: 4099`, tri(right(8, 8 + k / 12, 64, 64, Z0, 0, 4099))); }
        // (small triangles, nine a case)
        for (const size of [8, 16]) for (const [dx, dy] of [[33, 0], [0, 97], [4099, 65543]]) {
            const prims = [];
            for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) prims.push(...tri(right(4 + i * 26 + (i & 1), 4 + j * 26 + (j >> 1), size, size, Z0 + (j * 3 + i) * 1001, dx, dy)));
            add(`slope small ${size}: ${dx} ${dy}`, prims);
        }
        // (other depths)
        for (const z0 of [300000, 5000000, 8388000, 16000000]) { add(`slope x 4099 from ${z0}`, tri(right(8, 8, 64, 64, z0, 4099, 0))); add(`slope y 97 from ${z0}`, tri(right(8, 8, 64, 64, z0, 0, 97))); }
        }
    }
    // (heights between the two planes of the projection: the eye is at 13,800, the far plane 12,000 below)
    const height = () => Math.fround(1900 + rnd() * 11800);
    for (let k = 0; k < nFlat; k++) {
        // flat squares of 4 x 4 pixels, 20 x 20 of them, each at a height of its own (the two windings: one is culled)
        const prims: { cmd: number[]; verts: number[][] }[] = [];
        for (let j = 0; j < 20; j++) for (let i = 0; i < 20; i++) {
            const h = k === 0 ? Math.fround(1900 + (j * 20 + i) * 29.5) : height(), x0 = 2 + i * 4, y0 = 2 + j * 4;
            for (const order of [[0, 1, 2, 3], [3, 2, 1, 0]]) {
                const cmd = [0x80, 0, 4], corners = [[x0, y0], [x0 + 4, y0], [x0 + 4, y0 + 4], [x0, y0 + 4]], verts: number[][] = [];
                for (const q of order) verts.push(vert(cmd, corners[q][0], corners[q][1], h));
                prims.push({ cmd, verts });
            }
        }
        add(`flat ${k}`, prims);
    }
    for (let k = 0; k < nTri; k++) {
        // triangles between three heights, one in each of 3 x 3 regions of 26 pixels (both windings)
        const prims: { cmd: number[]; verts: number[][] }[] = [];
        for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
            const span = k < 2 ? 40 : k < 4 ? 600 : 6000, base = Math.fround(2500 + rnd() * (11000 - span));
            const pts = [0, 1, 2].map(() => [2 + i * 27 + rnd() * 25, 2 + j * 27 + rnd() * 25, Math.fround(base + rnd() * span)]);
            for (const order of [[0, 1, 2], [2, 1, 0]]) {
                const cmd = [0x90, 0, 3], verts: number[][] = [];
                for (const q of order) verts.push(vert(cmd, pts[q][0], pts[q][1], pts[q][2]));
                prims.push({ cmd, verts });
            }
        }
        add(`triangles ${k}`, prims);
    }
    const bytes = Sc.bytes();
    writeFileSync(outPath, bytes); writeFileSync(outPath + '.cases.json', JSON.stringify(cases));
    console.log(`${cases.length} cases, arena ${Sc.arena}, script ${bytes.length} bytes; screen of the model's origin ${o.map((v) => v.toFixed(2)).join(', ')}, a unit of x ${a11.toFixed(5)}, ${a21.toFixed(5)}, of z ${a12.toFixed(5)}, ${a22.toFixed(5)}`);
    process.exit(0);
} else if (mode === 'zcompare') {
    // depth maps (Z24X8 copies of the depth buffer): a console's answer against ppc/gx.ts, case by case
    //   node v3hwprobe.mjs zcompare <script.gxps> <answer.gxpo> [out.json]   (SHOW=n: that many differing texels a case)
    const sc = readScript(new Uint8Array(readFileSync(process.argv[3]))), cases = JSON.parse(readFileSync(process.argv[3] + '.cases.json', 'utf8')) as Case[];
    const model = simulate(sc.ops, sc.arena, +(process.env.SEED || 0));
    const o = new Uint8Array(readFileSync(process.argv[4])), got: Uint8Array[] = [];
    if (r32(o, 0) !== 0x4758504F) throw new Error('not an answer file');
    for (let p = 16; p + 16 <= o.length;) {
        const kind = r32(o, p), b = r32(o, p + 8), len = r32(o, p + 12), data = o.subarray(p + 16, p + 16 + len);
        if (kind === 102) console.log(`the console stopped the script: ${Buffer.from(data).toString('latin1')}`);
        else if (kind === OP.DUMP || kind === OP.READ16) got.push(data.slice());
        else if (kind === OP.MEMRLE) got.push(rleDecode(data, b));
        p += 16 + ((len + 3) & ~3);
    }
    const depth = (m: Uint8Array, w: number, h: number) => {
        const z = new Int32Array(w * h), bw = (w + 3) >> 2;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const q = ((y >> 2) * bw + (x >> 2)) * 64 + ((y & 3) * 4 + (x & 3)) * 2; z[y * w + x] = (m[q + 1] << 16) | (m[q + 32] << 8) | m[q + 33]; }
        return z;
    };
    const out: object[] = [], all = new Map<number, number>();
    for (const [i, c] of cases.entries()) {
        const mine = depth(model[2 * i + 1], c.w, c.h), theirs = depth(got[2 * i + 1], c.w, c.h), hist = new Map<number, number>();
        let off = 0, far = 0, covered = 0; const ex: string[] = [];
        for (let k = 0; k < mine.length; k++) {
            if (theirs[k] !== 0xFFFFFF) covered++;
            const d = mine[k] - theirs[k];
            if ((mine[k] === 0xFFFFFF) !== (theirs[k] === 0xFFFFFF)) { far++; continue; }
            hist.set(d, (hist.get(d) || 0) + 1); all.set(d, (all.get(d) || 0) + 1);
            if (d) { off++; if (ex.length < +(process.env.SHOW || 0)) ex.push(`(${k % c.w},${(k / c.w) | 0}) ${mine[k]} here, ${theirs[k]} there`); }
        }
        console.log(`${c.label}: ${c.w}x${c.h}, ${covered} texels drawn on the console; ${off} differ in depth, ${far} drawn on one side only${ex.length ? ' | ' + ex.join('; ') : ''}`);
        out.push({ label: c.label, w: c.w, h: c.h, mine: [...mine], theirs: [...theirs] });
    }
    console.log('depth here minus the console\'s: ' + [...all].sort((a, b) => a[0] - b[0]).map(([d, n]) => `${d}: ${n}`).join(', '));
    if (process.argv[5]) writeFileSync(process.argv[5], JSON.stringify(out));
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
} else { console.log('capture | script | check | compare | model | chain | chaincmp | feed'); process.exit(2); }
