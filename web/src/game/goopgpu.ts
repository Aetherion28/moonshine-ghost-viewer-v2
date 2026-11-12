// The goop's texture stamps drawn as the console's GPU draws them.
//
// The game cleans and dirties a goop layer by drawing quads into the frame buffer and copying it back into the
// layer's texture (TPollutionCounterLayer::drawTexStamp / doTask, Map/PollutionCount.cpp). What a stamp leaves in
// each texel is the GPU's arithmetic: where a pixel's middle falls in the stamp's texture, how four texels are
// mixed, how the blender rounds. v3's rasteriser (v3/ppc/gx.ts) has that arithmetic as it was measured on a
// console, so the stamps go through it here: the registers as the game's calls leave them (goopregs.ts, taken from
// a capture, with what depends on the layer, the stamp and the task set as doTask and initGXforStamp set it), the
// quads as doTask sends them.
import { Gx } from '../../v3/ppc/gx.ts';
import { GOOP_BP, GOOP_XF, GOOP_XF_MEM, GOOP_CP, GOOP_FADE_BP, GOOP_FADE_XF, GOOP_FADE_CP, GOOP_FADE_TEVREG, GOOP_FADE_KONST } from './goopregs.js';

/** a stamp's shape as the GPU takes it: the BTI's image in its own format, its wrap modes and filters */
export interface StampTex { fmt: number; w: number; h: number; data: Uint8Array; wrapS: number; wrapT: number; min: number; mag: number }
export interface StampTask { x: number; z: number; size: number; y: number }

const EFB_W = 640;
const HEIGHT_AT = 0x100000, STAMP_AT = 0x200000, MODEL_AT = 0x300000, MODEL_TEX_AT = 0x500000, RAM_SIZE = 0x600000;
const F = new Float32Array(1), W = new Uint32Array(F.buffer);
const bits = (v: number) => { F[0] = v; return W[0]; };
const texBytes = (fmt: number, w: number, h: number) => fmt === 0 ? ((w + 7) >> 3) * ((h + 7) >> 3) * 32 : fmt === 3 ? ((w + 3) >> 2) * ((h + 3) >> 2) * 32 : fmt === 6 ? ((w + 3) >> 2) * ((h + 3) >> 2) * 64 : ((w + 7) >> 3) * ((h + 3) >> 2) * 32;

let gx: Gx | null = null, ram: Uint8Array | null = null;
const problems = new Set<string>();
function machine() {
    if (gx) return gx;
    ram = new Uint8Array(RAM_SIZE);
    gx = new Gx(ram, { unsupported: (what: string) => { problems.add(what); }, finish: () => {}, token: () => {} } as any);
    restore(gx);
    gx.raster = true;
    return gx;
}
/** the registers as the game's stamp pass has them (goopregs.ts), over whatever was drawn before */
function restore(g: Gx) {
    // (the registers not listed are 0)
    g.bp.fill(0); g.cp.fill(0); g.xfw.fill(0, 0x1000, 0x1058);
    for (const [k, v] of Object.entries(GOOP_BP)) g.bp[+k] = v;
    for (const [k, v] of Object.entries(GOOP_XF)) g.xfw[+k] = v;
    // (the matrix memory as captured: the words not listed are 0)
    g.xfw.fill(0, 0, 0x100);
    for (const [k, v] of Object.entries(GOOP_XF_MEM)) g.xfw[+k] = v;
    for (const [k, v] of Object.entries(GOOP_CP)) g.cp[+k] = v;
    // (the second texture matrix, GX_PTIDENTITY: 0x500 + 0x3D * 4)
    for (let i = 0; i < 12; i++) g.xfw[0x5F4 + i] = bits(i % 5 === 0 ? 1 : 0);
    // (the TEV registers are kept apart from the BP words: decode them again)
    for (let r = 0xE0; r < 0xE8; r++) bpw(g, r, g.bp[r]);
}
function fadeState(g: Gx, w: number, h: number, step: number, threshold: number) {
    const xw = g.xfw;
    g.bp.fill(0); g.cp.fill(0); xw.fill(0, 0x1000, 0x1058);
    for (const [k, v] of Object.entries(GOOP_FADE_BP)) g.bp[+k] = v;
    for (const [k, v] of Object.entries(GOOP_FADE_XF)) xw[+k] = v;
    for (const [k, v] of Object.entries(GOOP_FADE_CP)) g.cp[+k] = v;
    layerView(g, w, h);
    g.tevReg.set(GOOP_FADE_TEVREG); g.konst.set(GOOP_FADE_KONST);
    for (let k = 0; k < 4; k++) { g.tevReg[4 + k] = step & 0xFF; g.tevReg[8 + k] = threshold & 0xFF; }
}
const one = new Uint8Array(5);
function bpw(g: Gx, reg: number, v: number) { one[0] = 0x61; one[1] = reg; one[2] = v >>> 16; one[3] = v >>> 8; one[4] = v; g.feed(one, 0, 5); }
function cpw(g: Gx, reg: number, v: number) { const c = new Uint8Array(6); c[0] = 0x08; c[1] = reg; c[2] = v >>> 24; c[3] = v >>> 16; c[4] = v >>> 8; c[5] = v; g.feed(c, 0, 6); }
function xfw(g: Gx, addr: number, vals: ArrayLike<number>) {
    const c = new Uint8Array(5 + 4 * vals.length); c[0] = 0x10; c[1] = 0; c[2] = vals.length - 1; c[3] = addr >> 8; c[4] = addr;
    for (let i = 0; i < vals.length; i++) { const v = vals[i] >>> 0; c[5 + 4 * i] = v >>> 24; c[6 + 4 * i] = v >>> 16; c[7 + 4 * i] = v >>> 8; c[8 + 4 * i] = v; }
    g.feed(c, 0, c.length);
}
/** what the rasteriser met that it doesn't model (should stay empty) */
export function goopGpuProblems() { return [...problems]; }
/** the formats the rasteriser reads a stamp's texture in (I4, I8, IA4, IA8, RGBA8) */
export const stampFormatOk = (fmt: number) => fmt === 0 || fmt === 1 || fmt === 2 || fmt === 3 || fmt === 6;

/**
 * A layer's texture stamps of this frame (drawTexStamp): `map` (the layer's I8 texture, GX tiles) is what the frame
 * buffer holds when they are drawn and takes what it holds after. `index` gives a texel's place in the tiles;
 * height is the layer's height map (the same tiles), window its unk48; stamps[type] the tasks of each stamp type.
 */
export function drawLayerGpu(map: Uint8Array, lw: number, lh: number, index: (x: number, z: number) => number, height: Uint8Array, window: number,
    models: { gm: GpuModel; draw: ArrayLike<number>[] }[], stamps: { tex: StampTex; clean: boolean; tasks: StampTask[] }[], fade: { step: number; threshold: number } = { step: 0, threshold: 0 }) {
    const g = machine(), w = 1 << lw, h = 1 << lh, efb = g.efb, zb = g.zbuf;
    // the frame buffer as the layer's pass left it (the faded texture drawn 1:1 in all three colours), the depth as
    // the copy before cleared it (the fade's quad neither tests nor writes it)
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) { const o = (z * EFB_W + x) * 4, v = map[index(x, z)]; efb[o] = efb[o + 1] = efb[o + 2] = v; zb[z * EFB_W + x] = 0xFFFFFF; }
    // the viewport, the projection and the scissor of the layer's frame (an orthographic view of w x h pixels at the buffer's corner)
    layerView(g, w, h);
    if (models.length) {
        // the state the fade's quad left (initGXforPollutionLayer: C0 the step, C1 the threshold), which the
        // models' materials load over only in part
        fadeState(g, w, h, fade.step, fade.threshold);
        for (const M of models) drawModel(g, M.gm, M.draw);
    }
    if (stamps.length) texStamps(g, lw, lh, height, window, stamps);
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) map[index(x, z)] = efb[(z * EFB_W + x) * 4];
}
/** the viewport, the projection and the scissor of a layer's frame (an orthographic view of w x h pixels at the buffer's corner) */
function layerView(g: Gx, w: number, h: number) {
    const xw = g.xfw;
    xw[0x101A] = bits(w / 2); xw[0x101B] = bits(-h / 2); xw[0x101D] = bits(342 + w / 2); xw[0x101E] = bits(342 + h / 2);
    xw[0x1020] = bits(2 / w); xw[0x1021] = bits(-1); xw[0x1022] = bits(-2 / h); xw[0x1023] = bits(1);
    g.bp[0x20] = (342 << 12) | 342; g.bp[0x21] = ((342 + w - 1) << 12) | (342 + h - 1);
}
function texStamps(g: Gx, lw: number, lh: number, height: Uint8Array, window: number, stamps: { tex: StampTex; clean: boolean; tasks: StampTask[] }[]) {
    const R = ram!, w = 1 << lw, h = 1 << lh;
    // (ReInitializeGX and initGXforStamp: the stamps' state over whatever the models left)
    restore(g);
    layerView(g, w, h);
    // initGXforStamp: positions s16, the stamp's coordinate u16 (0 or 1), the height map's s16 with `frac` bits; the
    // height map on map 1 (I8, clamped, nearest)
    const frac = lw >= lh ? lw : lh;
    g.cp[0x80] = (g.cp[0x80] & ~0x1FF) | 1 | (3 << 1) | (frac << 4);
    R.set(height, HEIGHT_AT);
    g.bp[0x81] = 0x100; g.bp[0x85] = 0x1000; g.bp[0x89] = (w - 1) | ((h - 1) << 10) | (1 << 20); g.bp[0x95] = HEIGHT_AT >>> 5;
    g.bp[0x32] = (g.bp[0x32] & ~0xFFFF) | (w - 1); g.bp[0x33] = (g.bp[0x33] & ~0xFFFF) | (h - 1);
    // doTask: the coordinates of the longer side's texels are scaled to the square the fraction bits assume
    let sx = 1, sy = 1;
    if (w <= h) sx = Math.trunc(h / w); else sy = Math.trunc(w / h);
    const q = new Uint8Array(3 + 4 * 12), put = (o: number, v: number) => { q[o] = (v >> 8) & 0xFF; q[o + 1] = v & 0xFF; };
    q[0] = 0x80; q[1] = 0; q[2] = 4;
    for (const S of stamps) {
        if (!S.tasks.length) continue;
        const T = S.tex;
        // JUTTexture::load on map 0, and the coordinate's scale (the texture's size)
        R.set(T.data.subarray(0, texBytes(T.fmt, T.w, T.h)), STAMP_AT);
        g.bp[0x80] = (T.wrapS & 3) | ((T.wrapT & 3) << 2) | (T.mag ? 0x10 : 0) | (T.min === 1 ? 0x80 : 0) | 0x100;
        g.bp[0x84] = T.min === 1 && T.mag ? 0 : 0x1000;
        g.bp[0x88] = (T.w - 1) | ((T.h - 1) << 10) | (T.fmt << 20); g.bp[0x94] = STAMP_AT >>> 5;
        g.bp[0x30] = (g.bp[0x30] & ~0xFFFF) | (T.w - 1); g.bp[0x31] = (g.bp[0x31] & ~0xFFFF) | (T.h - 1);
        // setTevColorInByStampType: a clean stamp puts in its texture's colour, any other 255 (GX_CC_TEXC / GX_CC_ONE as a; the rest zero)
        g.bp[0xC4] = (g.bp[0xC4] & ~0xFFFF) | ((S.clean ? 8 : 12) << 12) | 0xFFF;
        for (const t of S.tasks) {
            let lo = t.y - window, hi = t.y + window;
            if (lo < 0) lo = 0;
            if (hi > 0xFF) hi = 0xFF;
            lo &= 0xFF; hi &= 0xFF;
            for (let k = 0; k < 4; k++) { g.tevReg[4 + k] = lo; g.tevReg[8 + k] = hi; }
            const half = t.size >> 1, s16 = (v: number) => (v << 16) >> 16;
            const x1 = s16(t.x - half), y1 = s16(t.z - half), x2 = s16(t.x + half), y2 = s16(t.z + half);
            const s1 = (x1 * sx) & 0xFFFF, s2 = (x2 * sx) & 0xFFFF, t1 = (y1 * sy) & 0xFFFF, t2 = (y2 * sy) & 0xFFFF;
            const V: number[][] = [[x1, y1, 0, 0, s1, t1], [x2, y1, 1, 0, s2, t1], [x2, y2, 1, 1, s2, t2], [x1, y2, 0, 1, s1, t2]];
            for (let k = 0; k < 4; k++) for (let c = 0; c < 6; c++) put(3 + k * 12 + c * 2, V[k][c]);
            if (goopGpuDebug.onPrim) goopGpuDebug.onPrim(g, 'tex', q);
            g.feed(q, 0, q.length);
        }
    }
}

// ---------------------------------------------------------------- model stamps
// calcViewMtx: each model stamp's J3DModel goes through viewCalc with makeWorldToPollutionMtx as the view and
// into the layer's draw buffer; the pass draws it with J3D's own packets: each material's registers as J3D loads
// them (from MAT3), each shape's vertex format (VTX1), arrays and display lists (SHP1), its draw matrices loaded
// as J3DShapeMtx / J3DShapeMtxMulti load them. Here the file's own vertex data and display lists go to the GPU.

/** one shape of a model, as the GPU takes it */
interface GpuShape { mat: number; mtxType: number; vcdLo: number; vcdHi: number; packets: { dl: Uint8Array; table: Uint16Array; mtx: number }[] }
export interface GpuModel { file: Uint8Array; vat: [number, number, number]; arrays: { base: number; stride: number }[]; shapes: GpuShape[]; mats: (Uint8Array | null)[]; tex: { data: Uint8Array; at: number }[]; problems: string[] }

const COMP_BYTES = [1, 1, 2, 2, 4];
const COLOR_BYTES = [2, 3, 4, 2, 3, 4];
const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const rgba = (c: { r: number; g: number; b: number; a: number }) => [c.r, c.g, c.b, c.a].map((v) => Math.round(v * 255));
const s11 = (v: number) => v & 0x7FF;

/** the BMD's blocks by name */
function blocks(b: Uint8Array) {
    const m = new Map<string, number>();
    for (let o = 0x20; o + 8 <= b.length;) { const n = u32(b, o + 4); m.set(String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]), o); if (!n) break; o += n; }
    return m;
}

/**
 * The model as the GPU draws it: `file` the BMD, `bmd` noclip's reading of it (its materials). The vertex
 * formats and arrays are VTX1's, the shapes and their display lists SHP1's.
 */
export function gpuModelOf(file: Uint8Array, bmd: any): GpuModel {
    const B = blocks(file), problems: string[] = [];
    const v = B.get('VTX1')!, sh = B.get('SHP1')!;
    // VTX1: the formats (attribute, count, type, fraction) and each array's place: POS NRM NBT CLR0 CLR1 TEX0..7
    const fmt = new Map<number, { cnt: number; type: number; frac: number }>();
    for (let o = v + u32(file, v + 8); u32(file, o) !== 0xFF; o += 0x10) fmt.set(u32(file, o), { cnt: u32(file, o + 4), type: u32(file, o + 8), frac: file[o + 12] });
    const slotOf = (attr: number) => attr === 9 ? 0 : attr === 10 ? 1 : attr === 25 ? 2 : attr === 11 ? 3 : attr === 12 ? 4 : attr >= 13 && attr <= 20 ? attr - 8 : -1;
    const arrays: { base: number; stride: number }[] = [];
    const arrayOf = (attr: number) => attr === 9 ? 0 : attr === 10 || attr === 25 ? 1 : attr === 11 ? 2 : attr === 12 ? 3 : attr - 9;
    for (const [attr, f] of fmt) {
        const slot = slotOf(attr), off = slot >= 0 ? u32(file, v + 0x0C + slot * 4) : 0;
        if (!off) continue;
        let stride: number;
        if (attr === 9) stride = (f.cnt ? 3 : 2) * COMP_BYTES[f.type];
        else if (attr === 10) stride = (f.cnt ? 9 : 3) * COMP_BYTES[f.type];
        else if (attr === 25) stride = 9 * COMP_BYTES[f.type];
        else if (attr === 11 || attr === 12) stride = COLOR_BYTES[f.type];
        else stride = (f.cnt ? 2 : 1) * COMP_BYTES[f.type];
        arrays[arrayOf(attr)] = { base: v + off, stride };
    }
    // the vertex attribute format (VTXFMT0), as J3D makes it from VTX1
    const F = (a: number) => fmt.get(a) || { cnt: 1, type: 0, frac: 0 };
    const p = F(9), n = F(10), c0 = F(11), c1 = F(12), t = [13, 14, 15, 16, 17, 18, 19, 20].map(F);
    const vatA = ((p.cnt & 1) | (p.type << 1) | (p.frac << 4) | ((fmt.has(25) ? 1 : n.cnt & 1) << 9) | (n.type << 10) | ((c0.cnt & 1) << 13) | (c0.type << 14) | ((c1.cnt & 1) << 17) | (c1.type << 18)
        | ((t[0].cnt & 1) << 21) | (t[0].type << 22) | (t[0].frac << 25) | (1 << 30)) >>> 0;
    const vatB = ((t[1].cnt & 1) | (t[1].type << 1) | (t[1].frac << 4) | ((t[2].cnt & 1) << 9) | (t[2].type << 10) | (t[2].frac << 13) | ((t[3].cnt & 1) << 18) | (t[3].type << 19) | (t[3].frac << 22)
        | ((t[4].cnt & 1) << 27) | (t[4].type << 28) | (1 << 31)) >>> 0;
    const vatC = (t[4].frac | ((t[5].cnt & 1) << 5) | (t[5].type << 6) | (t[5].frac << 9) | ((t[6].cnt & 1) << 14) | (t[6].type << 15) | (t[6].frac << 18) | ((t[7].cnt & 1) << 23) | (t[7].type << 24) | (t[7].frac << 27)) >>> 0;
    // SHP1: each shape's attributes, matrix groups and display lists (the order noclip reads them in)
    const count = u16(file, sh + 8), init = sh + u32(file, sh + 0x0C), decl = sh + u32(file, sh + 0x18), mtab = sh + u32(file, sh + 0x1C);
    const dls = sh + u32(file, sh + 0x20), minit = sh + u32(file, sh + 0x24), dinit = sh + u32(file, sh + 0x28);
    const shapes: GpuShape[] = [];
    for (let i = 0; i < count; i++) {
        const e = init + i * 0x28, mtxType = file[e], groups = u16(file, e + 2), declAt = decl + u16(file, e + 4), mi = u16(file, e + 6), di = u16(file, e + 8);
        let lo = 0, hi = 0;
        for (let o = declAt; u32(file, o) !== 0xFF; o += 8) {
            const a = u32(file, o), ty = u32(file, o + 4) & 3;
            if (a === 0) lo |= ty ? 1 : 0;
            else if (a <= 8) lo |= (ty ? 1 : 0) << a;
            else if (a === 9) lo |= ty << 9;
            else if (a === 10 || a === 25) lo |= ty << 11;
            else if (a === 11) lo |= ty << 13;
            else if (a === 12) lo |= ty << 15;
            else if (a <= 20) hi |= ty << (2 * (a - 13));
        }
        const packets: GpuShape['packets'] = [];
        for (let j = 0; j < groups; j++) {
            const d = dinit + (di + j) * 8, size = u32(file, d), start = dls + u32(file, d + 4);
            const m = minit + (mi + j) * 8, use = u16(file, m), cnt = u16(file, m + 2), first = u32(file, m + 4);
            const table = new Uint16Array(cnt);
            for (let k = 0; k < cnt; k++) table[k] = u16(file, mtab + (first + k) * 2);
            packets.push({ dl: file.subarray(start, start + size), table, mtx: use });
        }
        if (mtxType !== 0 && mtxType !== 3) problems.push(`a billboard shape (${mtxType})`);
        shapes.push({ mat: bmd.shp1.shapes[i].materialIndex, mtxType, vcdLo: lo, vcdHi: hi, packets });
    }
    // the textures the materials take (TEX1's images as the file has them)
    const tex: GpuModel['tex'] = [];
    let at = MODEL_TEX_AT;
    for (const td of bmd.tex1.textureDatas) {
        const d: Uint8Array = td.data ? td.data.createTypedArray(Uint8Array) : new Uint8Array(0);
        tex.push({ data: d, at }); at += (d.length + 31) & ~31;
    }
    const model: GpuModel = { file, vat: [vatA, vatB, vatC], arrays, shapes, mats: [], tex, problems };
    model.mats = bmd.mat3.materialEntries.map((m: any) => materialCommands(m, bmd, model));
    return model;
}

/** the commands J3D's material blocks send for a material (null: something here doesn't model it) */
function materialCommands(m: any, bmd: any, model: GpuModel): Uint8Array | null {
    const g = m.gxMaterial, out: number[] = [], bad = (why: string) => { model.problems.push(`${m.name}: ${why}`); };
    const bp = (reg: number, v: number) => out.push(0x61, reg, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF);
    const xf = (addr: number, vals: number[]) => { out.push(0x10, 0, vals.length - 1, addr >> 8, addr & 0xFF); for (const v0 of vals) { const v = v0 >>> 0; out.push(v >>> 24, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF); } };
    // the colour channels (J3DColorBlock): material and ambient colours, the channel controls
    const chans = g.lightChannels.length;
    const ctrl = (c: any) => (c.matColorSource & 1) | ((c.lightingEnabled ? 1 : 0) << 1) | ((c.litMask & 15) << 2) | ((c.ambColorSource & 1) << 6)
        | ((c.attenuationFunction === 0 ? 0 : c.diffuseFunction) << 7) | ((c.attenuationFunction !== 2 ? 1 : 0) << 9) | ((c.attenuationFunction !== 0 ? 1 : 0) << 10) | (((c.litMask >> 4) & 15) << 11);
    const col32 = (c: number[]) => ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | c[3]) >>> 0;
    xf(0x1009, [chans]);
    for (let i = 0; i < chans; i++) {
        const lc = g.lightChannels[i];
        if (lc.colorChannel.lightingEnabled || lc.alphaChannel.lightingEnabled) bad('a lit colour channel');
        xf(0x100A + i, [col32(rgba(m.colorAmbRegs[i]))]);
        xf(0x100C + i, [col32(rgba(m.colorMatRegs[i]))]);
        xf(0x100E + i, [ctrl(lc.colorChannel)]);
        xf(0x1010 + i, [ctrl(lc.alphaChannel)]);
    }
    // the texture coordinates (J3DTexGenBlock)
    const gens = g.texGens.length;
    xf(0x103F, [gens]);
    let mi0 = 0, mi1 = 0;
    for (let i = 0; i < gens; i++) {
        const tg = g.texGens[i];
        if (tg.type > 1) bad('a bump or SRTG texture coordinate');
        if (tg.matrix !== 60) bad('a texture matrix');
        const src = tg.source, row = src <= 3 ? [0, 1, 3, 4][src] : src <= 11 ? src + 1 : src >= 19 ? 2 : 5;
        xf(0x1040 + i, [((tg.type === 0 ? 1 : 0) << 1) | ((src <= 3 ? 1 : 0) << 2) | (row << 7)]);
        xf(0x1050 + i, [((tg.postMatrix - 64) & 63) | ((tg.normalize ? 1 : 0) << 8)]);
        if (i < 4) mi0 |= tg.matrix << (6 + 6 * i); else mi1 |= tg.matrix << (6 * (i - 4));
    }
    for (let i = gens; i < 8; i++) if (i < 4) mi0 |= 60 << (6 + 6 * i); else mi1 |= 60 << (6 * (i - 4));
    xf(0x1018, [mi0]); xf(0x1019, [mi1]);
    // the textures the stages take (J3DTevBlock's texture numbers: TEX1's samplers)
    const st = g.tevStages, ns = st.length, size: number[] = [];
    for (let k = 0; k < 8; k++) {
        const ti = m.textureIndexes[k];
        if (ti === undefined || ti < 0) continue;
        if (!st.some((s: any) => s.texMap === k)) continue;
        const smp = bmd.tex1.samplers[ti], td = bmd.tex1.textureDatas[smp.textureDataIndex], T = model.tex[smp.textureDataIndex];
        if (!stampFormatOk(td.format) || (td.mipCount || 1) > 1) bad(`a texture format ${td.format} / mipmaps`);
        const minHw = [0, 4, 1, 5, 2, 6][smp.minFilter] ?? 4;
        const a = k < 4 ? 0x80 + k : 0xA0 + (k - 4);
        bp(a, (smp.wrapS & 3) | ((smp.wrapT & 3) << 2) | ((smp.magFilter & 1) << 4) | (minHw << 5) | (1 << 8) | ((Math.round(smp.lodBias * 32) & 0xFF) << 9));
        bp(a + 4, (Math.round(smp.minLOD * 16) & 0xFF) | ((Math.round(smp.maxLOD * 16) & 0xFF) << 8));
        bp(k < 4 ? 0x88 + k : 0xA8 + (k - 4), (td.width - 1) | ((td.height - 1) << 10) | (td.format << 20));
        bp(k < 4 ? 0x94 + k : 0xB4 + (k - 4), T.at >>> 5);
        size[k] = (td.width - 1) | ((td.height - 1) << 16);
    }
    // the stages (J3DTevBlock: orders, colour and alpha environments, constants' selections, colours)
    if (g.indTexStages.length) bad('indirect stages');
    const hwOp = (op: number, bias: number, scale: number) => op <= 1 ? { b: bias, s: op, sc: scale } : { b: 3, s: op & 1, sc: (op >> 1) & 3 };
    for (let i = 0; i < ns; i++) {
        const s = st[i];
        if ((s.rasSwapTable && s.rasSwapTable.join() !== '0,1,2,3') || (s.texSwapTable && s.texSwapTable.join() !== '0,1,2,3')) bad('a swap table');
        const c = hwOp(s.colorOp, s.colorBias, s.colorScale), a = hwOp(s.alphaOp, s.alphaBias, s.alphaScale);
        bp(0xC0 + 2 * i, s.colorInD | (s.colorInC << 4) | (s.colorInB << 8) | (s.colorInA << 12) | (c.b << 16) | (c.s << 18) | ((s.colorClamp ? 1 : 0) << 19) | (c.sc << 20) | (s.colorRegId << 22));
        bp(0xC1 + 2 * i, (s.alphaInD << 4) | (s.alphaInC << 7) | (s.alphaInB << 10) | (s.alphaInA << 13) | (a.b << 16) | (a.s << 18) | ((s.alphaClamp ? 1 : 0) << 19) | (a.sc << 20) | (s.alphaRegId << 22));
        bp(0x10 + i, 0);
    }
    // J3DTevBlock1 (one stage) loads no colours, constants or their selections: what was there stays
    const block1 = ns <= 1;
    const order = (s: any) => s ? ((s.texMap === 0xFF ? 7 : s.texMap & 7) | ((s.texCoordId === 0xFF ? 0 : s.texCoordId & 7) << 3) | ((s.texMap !== 0xFF ? 1 : 0) << 6) | ((s.channelId & 7) << 7)) : 7 | (7 << 7);
    for (let i = 0; i < ns; i += 2) bp(0x28 + (i >> 1), order(st[i]) | (order(st[i + 1]) << 12));
    if (!block1) {
        // J3DTevBlock2 takes its two selections for every pair, Block4 and Block16 each stage's; the swap tables
        // (J3DTevSwapModeTable) as noclip doesn't keep them: table 0 straight, 1 RRRA, 2 GGGA, 3 BBBA
        const tables = [[0, 1, 2, 3], [0, 0, 0, 3], [1, 1, 1, 3], [2, 2, 2, 3]];
        for (let i = 0; i < 8; i++) {
            const t = tables[i >> 1], sw = i & 1 ? t[2] | (t[3] << 2) : t[0] | (t[1] << 2);
            const a = ns <= 2 ? st[0] : st[2 * i], b2 = ns <= 2 ? st[1] : st[2 * i + 1];
            bp(0xF6 + i, sw | ((a ? a.konstColorSel : 0) << 4) | ((a ? a.konstAlphaSel : 0) << 9) | ((b2 ? b2.konstColorSel : 0) << 14) | ((b2 ? b2.konstAlphaSel : 0) << 19));
        }
    }
    // the coordinates' scales (GX works them out from the stages' textures at the draw)
    for (const s of st) if (s.texMap !== 0xFF && s.texCoordId !== 0xFF && size[s.texMap] !== undefined) { bp(0x30 + 2 * s.texCoordId, size[s.texMap] & 0xFFFF); bp(0x31 + 2 * s.texCoordId, size[s.texMap] >>> 16); }
    for (let i = 0; i < 3 && !block1; i++) {
        const c = rgba(m.colorRegisters[i]);
        bp(0xE2 + 2 * i, s11(c[0]) | (s11(c[3]) << 12)); bp(0xE3 + 2 * i, s11(c[2]) | (s11(c[1]) << 12));
    }
    for (let i = 0; i < 4 && !block1; i++) {
        const c = rgba(m.colorConstants[i]);
        bp(0xE0 + 2 * i, c[0] | (c[3] << 12) | (1 << 23)); bp(0xE1 + 2 * i, c[2] | (c[1] << 12) | (1 << 23));
    }
    // the pixel engine (J3DPEBlock): alpha test, blend, depth
    const at = g.alphaTest, rop = g.ropInfo;
    bp(0xF3, (at.referenceA & 0xFF) | ((at.referenceB & 0xFF) << 8) | (at.compareA << 16) | (at.compareB << 19) | (at.op << 22));
    // (GDSetBlendMode through the BP mask: dither, the colour and alpha updates and the logic op stay as they were)
    bp(0xFE, 0x0FE3);
    bp(0x41, ((rop.blendMode === 1 || rop.blendMode === 3) ? 1 : 0) | ((rop.blendMode === 2 ? 1 : 0) << 1) | (rop.blendDstFactor << 5) | (rop.blendSrcFactor << 8) | ((rop.blendMode === 3 ? 1 : 0) << 11));
    bp(0x40, (rop.depthTest ? 1 : 0) | (rop.depthFunc << 1) | ((rop.depthWrite ? 1 : 0) << 4));
    // the general mode last: texture coordinates, channels, stages, culling (GX's numbering: front and back swapped)
    const cull = g.cullMode === 1 ? 2 : g.cullMode === 2 ? 1 : g.cullMode;
    bp(0x00, gens | (chans << 4) | ((ns - 1) << 10) | (cull << 14));
    return new Uint8Array(out);
}

let loadedModel: Uint8Array | null = null;
/** a model stamp: the model's shapes with `draw` (view x draw matrices, 12 words each, rows) */
function drawModel(g: Gx, M: GpuModel, draw: ArrayLike<number>[]) {
    for (const p of M.problems) problems.add(p);
    const R = ram!;
    if (loadedModel !== M.file) { R.set(M.file, MODEL_AT); for (const t of M.tex) R.set(t.data, t.at); loadedModel = M.file; }
    cpw(g, 0x70, M.vat[0]); cpw(g, 0x80, M.vat[1]); cpw(g, 0x90, M.vat[2]);
    M.arrays.forEach((a, k) => { if (a) { cpw(g, 0xA0 + k, MODEL_AT + a.base); cpw(g, 0xB0 + k, a.stride); } });
    const mtx = (slot: number, m: ArrayLike<number>) => { const w = new Uint32Array(12); for (let i = 0; i < 12; i++) w[i] = bits(m[i]); xfw(g, slot * 12, w); };
    let lastMat = -1;
    for (const S of M.shapes) {
        const cmds = M.mats[S.mat];
        if (!cmds) continue;
        if (S.mat !== lastMat) { g.feed(cmds, 0, cmds.length); lastMat = S.mat; }
        cpw(g, 0x50, S.vcdLo); cpw(g, 0x60, S.vcdHi);
        for (const P of S.packets) {
            if (S.mtxType === 3) { for (let i = 0; i < P.table.length; i++) if (P.table[i] !== 0xFFFF) mtx(i, draw[P.table[i]]); }
            else { mtx(0, draw[P.mtx]); xfw(g, 0x1018, [g.xfw[0x1018] & ~63]); }
            if (goopGpuDebug.onPrim) goopGpuDebug.onPrim(g);
            g.feed(P.dl, 0, P.dl.length);
        }
    }
}
/** (for tests) the GPU's registers at each model primitive */
export const goopGpuDebug: { onPrim: ((g: Gx, kind?: string, data?: Uint8Array) => void) | null } = { onPrim: null };
