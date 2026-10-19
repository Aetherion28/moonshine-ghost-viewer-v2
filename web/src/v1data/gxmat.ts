// The converters' material export (tools/build_stage.py unlit / uv_for, tools/build_mario_iso.py
// pick_base, toon_stages, tev_factor, gx_tev_spec, gx_tev_uvs, material_for).
import { pyRound, contentHash } from './bin.js';
import { GlbWriter } from './glb.js';
import { Model, Material, Mesh, TexEntry, TEX0, Texture } from './bmd.js';

export function unlit(name: string, tex: number | null = null, alpha: any = null, factor: number[] = [1, 1, 1, 1], double = true) {
    const m: any = { name, doubleSided: double, extensions: { KHR_materials_unlit: {} },
        pbrMetallicRoughness: { baseColorFactor: factor.map((c) => pyRound(c, 4)), metallicFactor: 0, roughnessFactor: 1 } };
    if (tex !== null && tex !== undefined) m.pbrMetallicRoughness.baseColorTexture = { index: tex };
    if (alpha === 'MASK') m.alphaMode = 'MASK';
    else if (alpha) Object.assign(m, alpha);
    return m;
}

/** uv @ mtx[:, :2].T + mtx[:, 2] (in double), as f32 */
export function applyTexMtx(uv: Float32Array, mtx: number[] | null): Float32Array {
    if (!mtx) return Float32Array.from(uv);
    const out = new Float32Array(uv.length);
    for (let i = 0; i < uv.length; i += 2) {
        const u = uv[i], v = uv[i + 1];
        out[i] = u * mtx[0] + v * mtx[1] + mtx[2];
        out[i + 1] = u * mtx[3] + v * mtx[4] + mtx[5];
    }
    return out;
}
const firstUv = (mesh: Mesh) => { for (const v of mesh.uv.values()) return v; return null; };
export function uvFor(mesh: Mesh, entry: TexEntry): Float32Array | null {
    const [, attr, mtx] = entry;
    const uv = mesh.uv.get(attr) || firstUv(mesh);
    return uv ? applyTexMtx(uv, mtx) : null;
}

const MASK_TEXTURES = /polmask|rak_dummy|toon|mask_i4/i;
export function pickBase(model: Model, mat: Material): TexEntry | null {
    for (const e of mat.used) if (!MASK_TEXTURES.test(model.textures[e[0]][0])) return e;
    return mat.base;
}

/** Parts models' placeholder textures the game swaps for the body's (MarioDraw / MarioCap / WaterGun). */
export const SUBSTITUTE = new Map<string, Texture>();

const KCSEL = [1, 7 / 8, 3 / 4, 5 / 8, 1 / 2, 3 / 8, 1 / 4, 1 / 8];
const imgKey = (t: Texture) => (t[1] ? contentHash(t[1].d).slice(0, 10) : 'none');

export function toonStages(w: GlbWriter, model: Model, mat: Material) {
    const st = mat.tev?.stages || [];
    if (st.length !== 5 || st[3].chan !== 4 || st[3].texmap < 0 || st[4].texmap >= 0) return null;
    const t = model.textures[st[3].texmap];
    if (!t[0].toLowerCase().includes('toon') || !t[1]) return null;
    const c3 = st[3].c, c4 = st[4].c;
    if (!(c3[0] === 8 && c3[1] === 10 && c3[2] === 14 && c3[3] === 2) || c4[0] !== 4 || c4[2] !== 14 || c4[3] !== 0) return null;
    const k = (sel: number) => (sel < 8 ? KCSEL[sel] : 0.5);
    const tex = w.textureRgba(`tex:${t[0]}`, t[1], t[2], t[3])!;
    const reg0 = mat.tev!.regs[1];
    return { tex: tex[0], reg0: reg0.slice(0, 3).map((v) => pyRound(Math.min(255, Math.max(0, v)) / 255, 4)), k3: k(st[3].kc), k4: k(st[4].kc), spec: +(st[4].chan === 5 && c4[1] === 10) };
}

export function tevFactor(model: Model, mat: Material, baseTex: number): number[] | null {
    const st = mat.tev?.stages || [];
    if (!st.length) return null;
    const regs = [...(mat.tev!.regs || []).map((r) => r.slice(0, 4).map((c) => c / 255)), [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const kregs = [...(mat.tev!.kregs || []).map((r) => r.slice(0, 4).map((c) => c / 255)), [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]];
    const reg: Record<number, number[]> = { 0: regs[3].slice(), 1: regs[0].slice(), 2: regs[1].slice(), 3: regs[2].slice() };
    let usesReg = false;
    const mean = new Map<number, number[]>();
    const tex = (i: number) => {
        if (i < 0 || i === baseTex || i >= model.textures.length || !model.textures[i][1]) return [1, 1, 1, 1];
        if (!mean.has(i)) {
            const d = model.textures[i][1]!.d, s = [0, 0, 0, 0];
            for (let q = 0; q < d.length; q++) s[q & 3] += d[q];
            const n = d.length / 4;
            mean.set(i, s.map((x) => x / n / 255));
        }
        return mean.get(i)!;
    };
    for (const s of st) {
        const t = tex(s.texmap);
        const ras = s.chan === 4 || s.chan === 0 ? [1, 1, 1, 1] : [0, 0, 0, 0];
        const kc = s.kc;
        const k = kc < 8 ? [KCSEL[kc], KCSEL[kc], KCSEL[kc]] : kc >= 12 && kc <= 15 ? kregs[kc - 12].slice(0, 3) : [1, 1, 1];
        const P = reg[0], R0 = reg[1], R1 = reg[2], R2 = reg[3];
        const arg = (a: number, ch: number) => {
            if (a >= 2 && a <= 7) usesReg = true;
            const tbl: Record<number, number> = { 0: P[ch], 1: P[3], 2: R0[ch], 3: R0[3], 4: R1[ch], 5: R1[3], 6: R2[ch], 7: R2[3], 8: t[ch], 9: t[3], 10: ras[ch], 11: ras[3], 12: 1, 13: 0.5, 14: k[ch], 15: 0 };
            return tbl[a] ?? 0;
        };
        const [a, b, c, d, op, bias, scale, clamp, out] = s.c;
        const res = [];
        for (let ch = 0; ch < 3; ch++) {
            const va = arg(a, ch), vb = arg(b, ch), vc = arg(c, ch), vd = arg(d, ch);
            let v = va * (1 - vc) + vb * vc;
            v = op === 0 ? vd + v : vd - v;
            v += ({ 0: 0, 1: 0.5, 2: -0.5 } as Record<number, number>)[bias] ?? 0;
            v *= ({ 0: 1, 1: 2, 2: 4, 3: 0.5 } as Record<number, number>)[scale] ?? 1;
            res.push(clamp ? Math.min(1, Math.max(0, v)) : v);
        }
        const tgt = out in reg ? out : 0;
        reg[tgt][0] = res[0]; reg[tgt][1] = res[1]; reg[tgt][2] = res[2];
    }
    if (!usesReg) return null;
    return reg[0].slice(0, 3).map((v) => Math.min(1, Math.max(0, v)));
}

export function gxTevSpec(w: GlbWriter, model: Model, mat: Material, anims: Map<string, any> | null = null): any | null {
    const gx = mat.gx, st = mat.tev?.stages || [];
    if (!gx || !st.length) return null;
    const texnos: number[] = gx.texnos;
    const samplers: number[] = [], slot = new Map<number, number | null>(), sizes: number[][] = [];
    const addSlot = (tm: number): number | null => {
        if (slot.has(tm)) return slot.get(tm)!;
        let tx = model.textures[texnos[tm]];
        if (SUBSTITUTE.has(tx[0])) tx = SUBSTITUTE.get(tx[0])!;
        if (!tx[1]) return null;
        const ref = w.textureRgba(`tex:${tx[0]}:${imgKey(tx)}`, tx[1], tx[2], tx[3]);
        if (!ref) return null;
        slot.set(tm, samplers.length);
        samplers.push(ref[0]);
        sizes.push([tx[1].w, tx[1].h]);
        return slot.get(tm)!;
    };
    const stages: number[][] = [];
    for (let i = 0; i < Math.min(st.length, gx.orders.length); i++) {
        const x = st[i], [tc, tm] = gx.orders[i];
        let t = -1;
        if (tm < 8 && texnos[tm] >= 0) { const s = addSlot(tm); if (s === null) return null; t = s; }
        stages.push([...x.c.slice(0, 8), ...x.a.slice(0, 8), x.c[8], x.a[8], x.kc, x.ka, t, tc < 8 ? tc : -1, x.chan]);
    }
    const gens = gx.texgens.map((g: number[] | null, j: number) => {
        if (!g) return null;
        const [gtype, src, gm] = g;
        const mi = gm >= 30 && gm < 60 ? Math.floor((gm - 30) / 3) : -1;
        if (gtype === 10) return { k: 'srtg', c: src === 20 ? 1 : 0 };
        if (src === 1) { const raw = mi >= 0 ? gx.texmtx_raw[mi] : null; return { k: 'nrm', s: raw ? [raw[1], raw[2]] : [1, 1], t: raw ? [raw[3], raw[4]] : [0, 0] }; }
        if (src >= 4 && src <= 11) {
            const gen: any = { k: 'uv', a: `_GXTC${j}` };
            const an = mi >= 0 && anims ? anims.get(`${mat.name}|${mi}`) : null;
            if (an) { const raw = gx.texmtx_raw[mi]; gen.anim = { maya: +!!(raw && raw[0] >> 7), c: an.center.slice(0, 2), tr: an.tracks, dur: an.duration }; }
            return gen;
        }
        return null;
    });
    let ind: any = null;
    const gi = gx.ind;
    if (gi) {
        let ist: number[] | null = [];
        for (const [itc, itm] of gi.ord) {
            const sl = itm < 8 && itc < 8 && texnos[itm] >= 0 ? addSlot(itm) : null;
            if (sl === null) { ist = null; break; }
            ist.push(sl);
        }
        if (ist) ind = { st: gi.ord.map(([tc]: number[], q: number) => [tc, ist![q], gi.sc[q][0], gi.sc[q][1]]), mtx: gi.mtx.map((m: number[]) => m.slice()), tev: gi.tev.slice(0, stages.length).map((t: number[]) => t.slice(0, 7)) };
    }
    const q = (c: number[]) => c.map((v) => pyRound(v / 255, 4));
    const out: any = { st: stages, regs: mat.tev!.regs.map(q), k: mat.tev!.kregs.map(q), tex: samplers, gen: gens, chan: gx.chans.map((c: number[] | null) => (c ? c.slice() : null)),
        matc: gx.matc.map(q), amb: gx.amb.map(q), blend: mat.blendMode.slice(0, 3), xlu: +mat.translucent, aref: mat.alphaRef || 0,
        acmp: gx.acmp ? gx.acmp.slice() : [7, 0, 0, 7, 0], tsz: sizes };
    if (ind) out.ind = ind;
    return out;
}

export function gxTevUvs(mesh: Mesh, mat: Material | null, anims: Map<string, any> | null = null): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    const gx = mat ? mat.gx : null;
    if (!gx) return out;
    gx.texgens.forEach((g: number[] | null, j: number) => {
        if (!g || !(g[1] >= 4 && g[1] <= 11) || g[0] === 10) return;
        const gm = g[2], mi = gm >= 30 && gm < 60 ? Math.floor((gm - 30) / 3) : -1;
        const uv = mesh.uv.get(TEX0 + (g[1] - 4)) || firstUv(mesh);
        if (!uv) return;
        let mtx = mi >= 0 ? gx.texmtx[mi] : null;
        if (mi >= 0 && anims && anims.get(`${mat!.name}|${mi}`)) mtx = null;
        out.set(`_GXTC${j}`, applyTexMtx(uv, mtx));
    });
    return out;
}

/** material_for: [material index, base texture entry]. gx: true (lit materials) or 'full' (every material). */
export function materialFor(w: GlbWriter, model: Model, mat: Material | null, prefix: string, tev = false, gx: boolean | 'full' = false, anims: Map<string, any> | null = null): [number, TexEntry | null] {
    if (!mat) return [w.customMaterial(unlit(`${prefix}`)), null];
    const entry = pickBase(model, mat);
    let tex: [number, boolean] | null = null;
    if (entry) {
        let t = model.textures[entry[0]];
        if (SUBSTITUTE.has(t[0])) t = SUBSTITUTE.get(t[0])!;
        tex = w.textureRgba(`tex:${t[0]}:${imgKey(t)}`, t[1], t[2], t[3]);
    }
    let alpha: any = null;
    if (mat.alphaRef !== null) alpha = { alphaMode: 'MASK', alphaCutoff: pyRound(mat.alphaRef, 3) };
    else if (mat.blend) alpha = { alphaMode: 'BLEND' };
    let factor = !mat.useVertexColor ? mat.matColor.map((c) => c / 255) : [1, 1, 1, 1];
    if (tev && mat.lit && !toonStages(w, model, mat)) {
        const tf = tevFactor(model, mat, entry ? entry[0] : -1);
        if (tf && Math.max(...tf.map((v) => Math.abs(v - 1))) > 0.08) factor = [...factor.slice(0, 3).map((f, i) => pyRound(f * tf[i], 4)), factor[3]];
    }
    const spec = unlit(`${prefix} ${mat.name}`, tex ? tex[0] : null, alpha, factor);
    if (mat.lit) {
        spec.extras = { lit: 1, mask: mat.litMask, ambVtx: +mat.ambVtx, diff: mat.diffFn };
        const toon = toonStages(w, model, mat);
        if (toon) spec.extras.toon = toon;
    }
    const env = [];
    for (const layer of mat.env) {
        const t = model.textures[layer.tex];
        if (!t[1]) continue;
        const tx = w.textureRgba(`tex:${t[0]}:env`, t[1], 33071, 33071);
        if (tx) env.push({ tex: tx[0], k: layer.k.map((c: number) => pyRound(c / 255, 4)), s: layer.s.map((v: number) => pyRound(v, 4)), t: layer.t.map((v: number) => pyRound(v, 4)) });
    }
    if (env.length) (spec.extras = spec.extras || {}).env = env;
    if (gx && (mat.lit || gx === 'full') && !toonStages(w, model, mat)) {
        const gt = gxTevSpec(w, model, mat, anims);
        if (gt) (spec.extras = spec.extras || {}).gxTev = gt;
    }
    return [w.customMaterial(spec), entry];
}

/** btk animations by (material name, texture matrix index) -> {..., duration} */
export function animsByMat(anim: any | null): Map<string, any> {
    const out = new Map<string, any>();
    for (const an of (anim && anim.anims) || []) out.set(`${an.mat}|${an.tm}`, { ...an, duration: anim.duration });
    return out;
}
