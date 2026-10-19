// tools/build_objects.py, part 2, and tools/build_triggers.py: an area's object model library (.glb)
// and each of its scenes' object lists, from the scene archives.
import { Bytes, s32, u16, u32, f32, pyRound, ascii, contentHash } from './bin.js';
import * as bmd from './bmd.js';
import { GlbWriter } from './glb.js';
import { parseBtk, parseBrk, parseBck, bckPose } from './anim.js';
import { materialFor, uvFor, gxTevUvs, SUBSTITUTE } from './gxmat.js';
import { addModel as stageAddModel } from './stage.js';
import { parseCol } from './collision.js';
import { parseScene, placement, lstr, actorTail, parsePrm, Prm, isFloat, SceneObj, asciiStr } from './scenebin.js';
import * as P from './objparts.js';
import MAPOBJ_TABLE from './tables/mapobj_table.json';
import type { Arc, LibCtx } from './objparts.js';

const OBJTABLE: any = MAPOBJ_TABLE;
const sortedKeys = (arc: Arc) => [...arc.keys()].sort();

export function quatFromMatrix(m: number[]): number[] {
    const at = (i: number, j: number) => m[i * 3 + j];
    const t = at(0, 0) + at(1, 1) + at(2, 2);
    if (t > 0) { const s = Math.sqrt(t + 1.0) * 2; return [(at(2, 1) - at(1, 2)) / s, (at(0, 2) - at(2, 0)) / s, (at(1, 0) - at(0, 1)) / s, 0.25 * s]; }
    let i = 0;
    if (at(1, 1) > at(i, i)) i = 1;
    if (at(2, 2) > at(i, i)) i = 2;
    const j = (i + 1) % 3, k = (i + 2) % 3;
    const s = Math.sqrt(1.0 + at(i, i) - at(j, j) - at(k, k)) * 2;
    const q = [0, 0, 0, 0];
    q[i] = 0.25 * s; q[j] = (at(j, i) + at(i, j)) / s; q[k] = (at(k, i) + at(i, k)) / s; q[3] = (at(k, j) - at(j, k)) / s;
    return q;
}
/** np.linalg.inv(m).T.reshape(-1) for each joint, as f32 */
export function inverseBinds(world: bmd.M4[]) {
    const out = new Float32Array(world.length * 16);
    world.forEach((m, n) => { const v = bmd.inv4(m); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[n * 16 + c * 4 + r] = v[r * 4 + c]; });
    return out;
}
const usesVtx = (mat: bmd.Material | null) => !!mat && (mat.useVertexColor || (mat.gx?.chans || []).some((c: number[] | null) => c && (c[1] === 1 || c[5] === 1)));
/** joints / weights (first 4 of each draw matrix's), weights normalised in f32 */
export function skinArrays(model: bmd.Model, mesh: bmd.Mesh) {
    const n = mesh.pos.length / 3, joints = new Uint16Array(n * 4), weights = new Float32Array(n * 4);
    mesh.drw.forEach((d, vi) => model.drawWeights[d].slice(0, 4).forEach(([j, wt], k) => { joints[vi * 4 + k] = j; weights[vi * 4 + k] = wt; }));
    for (let v = 0; v < n; v++) {
        let s = Math.fround(0);
        for (let k = 0; k < 4; k++) s = Math.fround(s + weights[v * 4 + k]);
        const d = Math.max(s, Math.fround(1e-6));
        for (let k = 0; k < 4; k++) weights[v * 4 + k] = Math.fround(weights[v * 4 + k] / d);
    }
    return { joints, weights };
}
/** _add_mesh: add_arrays plus JOINTS_0 / WEIGHTS_0 */
export function addMesh(w: GlbWriter, name: string, pos: ArrayLike<number>, tris: ArrayLike<number>, mat: number, uv: ArrayLike<number> | null = null, color: ArrayLike<number> | null = null,
    joints: Uint16Array | null = null, weights: Float32Array | null = null, normal: ArrayLike<number> | null = null) {
    w.addArrays(name, pos, tris, mat, uv, color, normal);
    if (joints) {
        const prim = w.gltf.meshes[w.gltf.meshes.length - 1].primitives[0];
        prim.attributes.JOINTS_0 = w.accessor(joints, 'VEC4', 5123, 34962);
        prim.attributes.WEIGHTS_0 = w.accessor(weights!, 'VEC4', 5126, 34962);
    }
}
const texAnimsOf = (btk: any | null) => {
    if (!btk) return null;
    const m = new Map<string, any>();
    for (const an of btk.anims) m.set(`${an.mat}|${an.tm}`, { ...an, duration: btk.duration });
    return m;
};

export function addSkinned(w: GlbWriter, model: bmd.Model, name: string, anim: any, idle: any = null, btkAnim: any = null) {
    const texAnims = texAnimsOf(btkAnim);
    const holder: any = { name, children: [] };
    w.gltf.nodes.push(holder);
    w.gltf.scenes[0].nodes.push(w.gltf.nodes.length - 1);
    const jointNodes: number[] = [];
    model.jointNames.forEach((_, i) => {
        const [sc, rot, tr] = model.jointTrs[i];
        w.gltf.nodes.push({ name: `${name}_j${i}`, translation: tr.slice(), rotation: quatFromMatrix(bmd.eulerMatrix(rot[0], rot[1], rot[2])), scale: sc.slice() });
        jointNodes.push(w.gltf.nodes.length - 1);
    });
    model.jointParent.forEach((par, i) => { if (par >= 0) (w.gltf.nodes[jointNodes[par]].children = w.gltf.nodes[jointNodes[par]].children || []).push(jointNodes[i]); else holder.children.push(jointNodes[i]); });
    (w.gltf.skins = w.gltf.skins || []).push({ joints: jointNodes, skeleton: jointNodes[0], inverseBindMatrices: w.accessor(inverseBinds(model.jointsWorld), 'MAT4', 5126, null) });
    const skin = w.gltf.skins.length - 1;
    for (const mesh of model.meshes) {
        const mat = mesh.material >= 0 && mesh.material < model.materials.length ? model.materials[mesh.material] : null;
        const [mi, entry] = materialFor(w, model, mat, name, false, true, texAnims);
        if (texAnims) for (const g of ((w.gltf.materials[mi].extras || {}).gxTev || {}).gen || []) if (g && g.anim) g.anim.manual = 1;
        const uv = entry ? uvFor(mesh, entry) : null;
        const color = usesVtx(mat) ? mesh.color || null : null;
        const { joints, weights } = skinArrays(model, mesh);
        addMesh(w, `${name}_s${mesh.shape}`, mesh.pos, mesh.tris, mi, uv, color, joints, weights, mesh.nrm || null);
        const prim = w.gltf.meshes[w.gltf.meshes.length - 1].primitives[0];
        if (mat && mat.lit) for (const [k, v] of gxTevUvs(mesh, mat, texAnims)) prim.attributes[k] = w.accessor(v, 'VEC2', 5126, 34962);
        const node = w.gltf.nodes.pop();
        w.gltf.scenes[0].nodes.pop();
        node.skin = skin;
        w.gltf.nodes.push(node);
        holder.children.push(w.gltf.nodes.length - 1);
    }
    const sc0 = w.gltf.scenes[0];
    const anims = ((sc0.extras = sc0.extras || {}).anims = sc0.extras.anims || {});
    anims[name] = anim;
    if (idle) anims[name + '~idle'] = idle;
}

export function parseBtp(data: Bytes): any | null {
    if (ascii(data, 0, 8) !== 'J3D1btp1') return null;
    let o = 0x20;
    while (o < data.length && ascii(data, o, 4) !== 'TPT1') o += u32(data, o + 4);
    const c = data.subarray(o);
    const loop = c[8], dur = u16(c, 0x0a), n = u16(c, 0x0c);
    const tabO = u32(c, 0x10), idxO = u32(c, 0x14), namesO = u32(c, 0x1c);
    const names = bmd.stringTable(c, namesO);
    const anims = [];
    for (let i = 0; i < n; i++) {
        const cnt = u16(c, tabO + i * 8), first = u16(c, tabO + i * 8 + 2);
        anims.push({ mat: names[i], tm: c[tabO + i * 8 + 4], t: Array.from({ length: cnt }, (_, k) => u16(c, idxO + (first + k) * 2)) });
    }
    return { d: dur, l: loop, anims };
}

// ---------------------------------------------------------------- Gooper Blooper
const GESSO_DIR = 'bgeso/';
const gessoFiles = (arc: Arc, ext: string) => [...arc.keys()].filter((k) => k.startsWith(GESSO_DIR) && k.split('/').length === 2 && k.endsWith(ext));
export function gessoAnims(arc: Arc) {
    const skel = (name: string) => { const m = bmd.parse(arc.get(GESSO_DIR + name + '.bmd')!, { decodeTextures: false }); return { parent: m.jointParent.slice(), trs: m.jointTrs.map((trs) => trs.map((part) => part.map((v) => pyRound(v, 5)))) }; };
    const out: any = { bck: [], names: [], btp: gessoFiles(arc, '.btp').map((k) => parseBtp(arc.get(k)!)), btk: gessoFiles(arc, '.btk').map((k) => parseBtk(arc.get(k)!)), shand: skel('bgeso_shand'), body: skel('bgeso_body') };
    for (const k of gessoFiles(arc, '.bck')) {
        const a = parseBck(arc.get(k)!);
        out.names.push(k.split('/').pop()!.slice(0, -4));
        out.bck.push(k.endsWith('bgeso_body_fly.bck') || k.endsWith('bgeso_dirty_osen.bck') ? null : a);
    }
    return out;
}
function gessoBody(ctx: LibCtx, arc: Arc) {
    const { w, lib } = ctx, raw = arc.get(GESSO_DIR + 'bgeso_body.bmd')!;
    const key = 'bgbody:' + P.digest(raw);
    if (lib.has(key)) return lib.get(key)!;
    const idx = lib.size;
    lib.set(key, idx);
    try {
        const model = bmd.parse(raw);
        const hit = arc.has(GESSO_DIR + 'bgeso_hit.btk') ? parseBtk(arc.get(GESSO_DIR + 'bgeso_hit.btk')!) : null;
        addSkinned(w, model, `m${idx}`, parseBck(arc.get(GESSO_DIR + 'bgeso_wait2.bck')!), null, hit);
        const eye = model.materials.find((m) => m.name === '_mat_eye');
        if (eye && eye.gx) {
            const texnos = eye.gx.texnos, slots: number[] = [];
            for (const [, tm] of eye.gx.orders) if (tm < 8 && texnos[tm] >= 0 && !slots.includes(tm)) slots.push(tm);
            const alt: any = {};
            const idxs = new Set<number>();
            for (const b of gessoFiles(arc, '.btp')) for (const a of parseBtp(arc.get(b)!).anims) for (const v of a.t) idxs.add(v);
            for (const ti of [...idxs].sort((a, b) => a - b)) {
                const tx = ti < model.textures.length ? model.textures[ti] : null;
                if (!tx || !tx[1]) continue;
                const ref = w.textureRgba(`tex:${tx[0]}:${contentHash(tx[1].d).slice(0, 10)}`, tx[1], tx[2], tx[3]);
                if (ref) alt[String(ti)] = ref[0];
            }
            for (const m of w.gltf.materials) if ((m.name || '') === `m${idx} _mat_eye` && slots.includes(0)) (m.extras = m.extras || {}).texAlt = { slot: slots.indexOf(0), idx: alt };
        }
    } catch (e) { console.warn('[v1data] skip Gooper Blooper body', e); lib.set(key, -1); }
    return lib.get(key)!;
}
function gessoPart(ctx: LibCtx, arc: Arc, name: string, skinnedBck: string | null = null) {
    const { w, lib } = ctx, path = GESSO_DIR + name + '.bmd';
    if (!arc.has(path)) return -1;
    const key = 'bgpart:' + name + ':' + P.digest(arc.get(path)!);
    if (lib.has(key)) return lib.get(key)!;
    const idx = lib.size;
    lib.set(key, idx);
    try {
        const model = bmd.parse(arc.get(path)!);
        if (skinnedBck !== null) addSkinned(w, model, `m${idx}`, skinnedBck ? parseBck(arc.get(GESSO_DIR + skinnedBck + '.bck')!) : { d: 1, l: 0, j: [] });
        else addModels(w, [model], `m${idx}`);
    } catch (e) { console.warn('[v1data] skip Gooper Blooper part', name, e); lib.set(key, -1); }
    return lib.get(key)!;
}
const GESSO_TENTACLE: any = { mNodeLength: 130.0, mNodeLenLimit: 1000.0, mTotalLenLimit: 800.0, mSpeedProp: 1.4, mInertiaProp: 0.6, mReflectProp: 0.1, mSpeedMax: 50.0,
    mVibrationForce: 6.0, mVibrationSpeed: 3.0, mDamagePropF: 4.0, mDamagePropS: 2.0, mDamageCountMax: 256, mDamageReflectProp: 1.5, mDamageNodeLength: 100.0, mAttackRadius: 80.0,
    mAttackHeight: 120.0, mDamageRadius: 150.0, mDamageHeight: 200.0, mAtkSoundTime: 120.0 };
function gessoExtra(ctx: LibCtx, arc: Arc) {
    const prmRaw = arc.get('map/params/enemy/bossgesso.prm');
    const params: Prm = prmRaw ? parsePrm(prmRaw) : P.globalParams('enemy/bossgesso.prm');
    const tent = { ...GESSO_TENTACLE };
    const traw = arc.get('map/params/enemy/tentacle.prm');
    Object.assign(tent, traw ? parsePrm(traw) : P.globalParams('enemy/tentacle.prm'));
    const prm: any = {};
    for (const [k, v] of Object.entries(params)) prm[k] = isFloat(params, k) ? pyRound(v, 5) : v;
    return { anims: 'objects/bgeso.json', hand: gessoPart(ctx, arc, 'bgeso_hand', ''), kolk: gessoPart(ctx, arc, 'bgeso_kolk'),
        kolkBreak: gessoPart(ctx, arc, 'bgeso_kolk_break', 'bgeso_kolk_break'), ball: gessoPart(ctx, arc, 'bgeso_osenball_white'), prm, tprm: tent };
}

// ---------------------------------------------------------------- library models
export function addModels(w: GlbWriter, models: bmd.Model[], name: string) {
    const holder: any = { name, children: [] };
    w.gltf.nodes.push(holder);
    w.gltf.scenes[0].nodes.push(w.gltf.nodes.length - 1);
    models.forEach((model, pi) => {
        for (const mesh of model.meshes) {
            const mat = mesh.material >= 0 && mesh.material < model.materials.length ? model.materials[mesh.material] : null;
            const [mi, entry] = materialFor(w, model, mat, `${name}p${pi}`, false, true);
            const uv = entry ? uvFor(mesh, entry) : null;
            const color = usesVtx(mat) ? mesh.color || null : null;
            w.addArrays(`${name}_p${pi}s${mesh.shape}`, mesh.pos, mesh.tris, mi, uv, color, mesh.nrm || null, mat && mat.lit ? gxTevUvs(mesh, mat) : null);
            const node = w.gltf.nodes.pop();
            w.gltf.scenes[0].nodes.pop();
            w.gltf.nodes.push(node);
            holder.children.push(w.gltf.nodes.length - 1);
        }
    });
}
P.setAddModels(addModels);
const BTK_TYPES = new Set(['MareGate']);
const TEV_TINT_TYPES = new Set(['HaneHamuKuri', 'HaneHamuKuri2', 'DoroHaneKuri', 'HamuKuri']);
function addModel(w: GlbWriter, model: bmd.Model, name: string, tev = false, anim: any = null) {
    const anims = new Map<string, any>();
    for (const an of (anim && anim.anims) || []) anims.set(`${an.mat}|${an.tm}`, { ...an, duration: anim.duration });
    const holder: any = { name, children: [] };
    w.gltf.nodes.push(holder);
    w.gltf.scenes[0].nodes.push(w.gltf.nodes.length - 1);
    for (const mesh of model.meshes) {
        const mat = mesh.material >= 0 && mesh.material < model.materials.length ? model.materials[mesh.material] : null;
        const full = !!mat && [...anims.keys()].some((k) => k.slice(0, k.lastIndexOf('|')) === mat.name);
        const [mi, entry] = materialFor(w, model, mat, name, tev, full ? 'full' : true, anims);
        const uv = entry ? uvFor(mesh, entry) : null;
        const color = usesVtx(mat) ? mesh.color || null : null;
        w.addArrays(`${name}_s${mesh.shape}`, mesh.pos, mesh.tris, mi, uv, color, mesh.nrm || null, mat && (mat.lit || full) ? gxTevUvs(mesh, mat, anims) : null);
        const node = w.gltf.nodes.pop();
        w.gltf.scenes[0].nodes.pop();
        w.gltf.nodes.push(node);
        holder.children.push(w.gltf.nodes.length - 1);
    }
}

// ---------------------------------------------------------------- the goop (build_stage.pollution_layers, add_goop)
const EDGE_ALPHA = 50;
const ptexIndex = (x: number, z: number, log2w: number) => (z & 3) * 8 + ((x >> 3) + ((z >> 2) << (log2w - 3))) * 0x20 + (x & 7);
export function* pollutionLayers(arc: Arc, scene: string): Generator<[string, Bytes, { w: number; h: number; d: Uint8Array }, Bytes | null]> {
    const ymp = arc.get('map/ymap.ymp');
    if (!ymp) return;
    const n = u16(ymp, 0), infos = u32(ymp, 4);
    const mare = scene.startsWith('mare');
    const names = mare && arc.has('map/pollution/pollutiona.bmd') ? ['pollution00', 'pollution01', 'pollution02', 'pollution03', 'pollution04', 'pollution05', 'pollution06', 'pollutionA', 'pollutionB']
        : Array.from({ length: 20 }, (_, i) => `pollution${String(i).padStart(2, '0')}`);
    for (let i = 0; i < Math.min(n, names.length); i++) {
        const o = infos + i * 0x2c, plane = u16(ymp, o + 4), lw = u16(ymp, o + 0x20), lh = u16(ymp, o + 0x22), hmOff = u32(ymp, o + 0x28);
        const w = 1 << lw, h = 1 << lh, name = names[i];
        const bmdf = `map/pollution/${name.toLowerCase()}.bmd`, bmpf = `map/pollution/${name.toLowerCase()}.bmp`;
        if (plane === 6 || !arc.has(bmdf) || !arc.has(bmpf)) continue;
        const hm = ymp.subarray(hmOff, hmOff + w * h), bmpRaw = arc.get(bmpf)!;
        const bmp = (x: number, y: number) => bmpRaw[0x436 + (h - 1 - y) * w + x];
        const img = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const d = bmp(x, y);
            if (!d || hm[ptexIndex(x, y, lw)] === 0xff) continue;
            if (mare && !(x > 0 && x < w - 1 && y > 0 && y < h - 1)) continue;
            let deg = 0;
            for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) if ((dx || dy) && x + dx >= 0 && x + dx < w && y + dy >= 0 && y + dy < h && hm[ptexIndex(x + dx, y + dy, lw)] === 0xff) deg++;
            img[y * w + x] = (d - deg * EDGE_ALPHA) & 0xff;
        }
        yield [name, arc.get(bmdf)!, { w, h, d: img }, arc.get(`map/pollution/${name.toLowerCase()}.btk`) || null];
    }
}
function addGoop(w: GlbWriter, raw: Bytes, img: { w: number; h: number; d: Uint8Array }, anim: Bytes | null, name: string) {
    const model = bmd.parse(raw);
    const rgba = { w: img.w, h: img.h, d: new Uint8Array(img.d.length * 4) };
    for (let i = 0; i < img.d.length; i++) rgba.d[i * 4] = rgba.d[i * 4 + 1] = rgba.d[i * 4 + 2] = rgba.d[i * 4 + 3] = img.d[i];
    model.textures = model.textures.map((t) => (t[0].startsWith('DummyPollution') ? [t[0], rgba, t[2], t[3]] : t)) as any;
    const roots = w.gltf.scenes[0].nodes, s0 = roots.length;
    stageAddModel(w, model, name, 'map', anim ? parseBtk(anim) : null);
    const kids = roots.splice(s0);
    w.gltf.nodes.push({ name, children: kids });
    roots.push(w.gltf.nodes.length - 1);
}

// ---------------------------------------------------------------- triggers (tools/build_triggers.py)
const CUBES: Record<string, string> = { カメラキューブテーブル: 'camera', エリアキューブテーブル: 'area', 流れキューブテーブル: 'stream', ワイヤーキューブテーブル: 'wire', 影キューブテーブル: 'shadow',
    鏡キューブテーブル: 'mirror', サウンド切り替えキューブテーブル: 'sound', 高速Ａキューブテーブル: 'fastA', 高速Ｂキューブテーブル: 'fastB', 高速Ｃキューブテーブル: 'fastC' };
const STAGE_CHANGE: Record<string, string> = { MapObjChangeStage: 'stage', MapObjChangeStageHipDrop: 'stageHipDrop', ChangeStageMerrygoround: 'stage' };
const ENEMY_ZONES: Record<string, [string, any, [string, string, (p: any) => number][]]> = {
    Cannon: ['cannon', { mSLHideDist: 300.0, mSLBombDist: 2000.0, mSLKillerDist: 10000.0 }, [
        ['bomb', 'Monty Mole: throws bombs', (p) => p.mSLBombDist], ['bomb2', 'Monty Mole: bomb after goop', (p) => p.mSLBombDist * 2 ** 0.5],
        ['hide', 'Monty Mole: hides', (p) => p.mSLHideDist], ['unhide', 'Monty Mole: comes back out past', (p) => p.mSLHideDist * 3]]],
};
const r2 = (v: number) => pyRound(v, 2);
function corkHeld(arc: Arc, objs: [SceneObj, any][]) {
    const cork = objs.find(([o]) => o.type === 'MareCork');
    if (!cork || !arc.has('mapobj/marecork.bmd')) return null;
    const [[cx, cy, cz], rot] = cork[1], ry = (rot[1] * Math.PI) / 180;
    const j = bmd.parse(arc.get('mapobj/marecork.bmd')!).jointsWorld[2];
    const lx = j[3], ly = j[7], lz = j[11];
    return [cx + lx * Math.cos(ry) + lz * Math.sin(ry), cy + ly, cz - lx * Math.sin(ry) + lz * Math.cos(ry)];
}
export function triggers(arc: Arc) {
    const out: any[] = [], placed: [SceneObj, any][] = [];
    for (const o of parseScene(arc.get('map/scene.bin')!)) {
        const t = o.type, pl = placement(o.payload);
        if (!pl) continue;
        const [[x, y, z], [rx, ry, rz], [sx, sy, sz]] = pl;
        if (t in ENEMY_ZONES) placed.push([o, [x, y, z]]);
        else if (t === 'MareCork') placed.push([o, [[x, y, z], [rx, ry, rz]]]);
        if (t in STAGE_CHANGE || t === 'MapObjStartDemo') {
            let val = 0;
            try { const p = actorTail(o.payload); if (p + 4 > o.payload.length) throw new RangeError(); val = u32(o.payload, p); } catch { val = 0; }
            out.push([STAGE_CHANGE[t] || 'demo', t, r2(x), r2(y), r2(z), r2(rx), r2(ry), r2(rz), r2(100 * Math.max(sx, sz)), r2(100 * sy), 0, val]);
        } else if (t === 'WarpArea') {
            let a = 0, b = 0;
            try { lstr(o.payload, 36); if (o.payload.length < 8) throw new RangeError(); a = u32(o.payload, o.payload.length - 8); b = u32(o.payload, o.payload.length - 4); } catch { a = b = 0; }
            out.push(['warp', t, r2(x), r2(y), r2(z), r2(rx), r2(ry), r2(rz), r2(100 * sx), r2(100 * sy), 0, [a, b]]);
        } else if (t === 'AreaCylinder' || t === 'AreaSphere') out.push(['areaCyl', o.name, r2(x), r2(y), r2(z), 0, 0, 0, r2(sx * 50), r2(sy * 50), 0, 0]);
    }
    if (arc.has('map/tables.bin')) for (const o of parseScene(arc.get('map/tables.bin')!)) {
        if (!['CubeGeneralInfo', 'CameraCubeInfo', 'CubeStreamInfo'].includes(o.type)) continue;
        const kind = CUBES[o.path.length ? o.path[o.path.length - 1] : ''] || 'cube';
        const v = Array.from({ length: 9 }, (_, i) => f32(o.payload, i * 4));
        out.push([kind, o.name, ...v.slice(0, 6).map(r2), r2(v[6] * 100), r2(v[7] * 100), r2(v[8] * 100), 0]);
    }
    for (const [t, [name, defaults, zones]] of Object.entries(ENEMY_ZONES)) {
        const prm: any = { ...defaults };
        const raw = arc.get(`map/params/enemy/${name}.prm`);
        if (raw) { try { Object.assign(prm, parsePrm(raw)); } catch { /* */ } }
        for (const [o, pos] of placed) {
            if (o.type !== t) continue;
            let [x, y, z] = pos;
            if (t === 'Cannon') [x, y, z] = corkHeld(arc, placed) || [x, y, z];
            for (const [zone, label, radius] of zones) out.push(['enemy', label, r2(x), r2(y), r2(z), 0, 0, 0, r2(radius(prm)), 0, 0, zone]);
        }
    }
    return out;
}

// ---------------------------------------------------------------- an area (build_objects.main's loop body)
export interface AreaEntry { id: string; routes: [number, number][]; scenes: string[] }
export interface AreaObjects { lib: Uint8Array; scenes: Map<string, any>; extra: Map<string, any> }
const T = (b: Uint8Array | null) => b || new Uint8Array(0);

export async function buildArea(entry: AreaEntry, table: string[][], sceneArc: (scene: string) => Promise<Arc | null>, pngDataUri: (img: any) => Promise<string>, maxTex = 128): Promise<AreaObjects> {
    const w = new GlbWriter(maxTex);
    const ctx: LibCtx = { w, lib: new Map(), specs: new Map() };
    const { lib } = ctx;
    const posed = new Map<string, bmd.Model>();
    const arcs = new Map<string, Arc | null>();
    const extraFiles = new Map<string, any>();
    const sceneJson = new Map<string, any>();
    SUBSTITUTE.clear();
    for (const [area, ep] of entry.routes) { const scene = table[area][ep]; if (!arcs.has(scene)) arcs.set(scene, await sceneArc(scene)); }
    for (const [scene, arc] of arcs) {
        if (!arc || !arc.has('map/scene.bin')) continue;
        for (const [dummy, real] of [['H_ma_rak_dummy', 'map/pollution/h_ma_rak.bti'], ['Q_kepper_dummy_128IA4', 'map/pollution/h_ma_rak.bti'], ['Q_gene_dummy_I4', 'map/pollution/h_ma_rak.bti'],
            ['I_mom_mino_dummyI4', 'montemcommon/i_mom_mino_rgba.bti'], ['I_mow_mino_dummyI4', 'montewcommon/i_mow_mino_rgba.bti'], ['J_jellyFish_dummy', 'marejellyfish/j_kurage.bti']]) {
            const k = [...arc.keys()].find((x) => x.toLowerCase() === real);
            if (k && !SUBSTITUTE.has(dummy)) { try { SUBSTITUTE.set(dummy, [real.split('/').pop()!.slice(0, -4), P.btiRgba(arc.get(k)!), 10497, 10497]); } catch { /* */ } }
        }
        const instances: any[] = [], cols: Record<string, any> = {}, usedGraphs = new Set<string>();
        const rails = arc.has('map/scene.ral') ? P.parseRails(arc.get('map/scene.ral')!) : {};
        const base = parseScene(arc.get('map/scene.bin')!);
        const sceneObjs = [...base, ...P.bridgeBoards(scene, base), ...P.windmillBlocks(base)];
        const spinRates: Record<string, number> = {};
        for (const so of sceneObjs) if (so.type === 'BiaWatermillVertical') { try { const nm = (so.name || 'x 0').trim().split(/\s+/); spinRates[nm[nm.length - 1]] = P.watermillVerticalRate(so.payload); } catch { /* */ } }
        for (const o of sceneObjs) {
            const typ = o.type;
            if (P.SKIP_TYPES.test(typ)) continue;
            const pl = placement(o.payload);
            if (!pl) continue;
            let keys = P.asciiKeys(o.payload);
            const key = keys.length ? keys[0] : null;
            const hidden = !!(key && key.startsWith('invisible_'));
            if (hidden) keys = [key!.slice('invisible_'.length), ...keys.slice(1)];
            const mpath = P.findModel(arc, typ, keys, OBJTABLE);
            let extra: any = null, mi = -1;
            const bmtPath = () => { for (const k of keys || []) { const e = P.MAT_TABLES[(OBJTABLE[k] || {}).actor]; if (e) return 'mapobj/' + e[0]; } return null; };
            if (typ === 'Cannon' && arc.has('cannon/default.bmd')) {
                const [parts, mole, hit] = P.cannonParts(arc);
                mi = P.libAdd(ctx, 'cannon:' + P.digest(arc.get('cannon/default.bmd')!), () => parts, { f: 'cannon/default.bmd', parts: arc.has('cannon/cannon_dom.bmd') ? ['nullA', 'nullB', 'nullC'].map((j) => ['cannon/cannon_dom.bmd', j]) : null });
                const moleI = P.libAdd(ctx, 'mole:' + P.digest(T(arc.get('cannon/tyorobe_model1.bmd') || null)), () => (mole ? [mole] : null),
                    { f: 'cannon/tyorobe_model1.bmd', bck: arc.has('cannon/tyorobe_wait1_loop.bck') ? 'cannon/tyorobe_wait1_loop.bck' : null, lift: 300.0 });
                const cp: any = P.enemyParams(arc, typ) || {};
                extra = { cannon: { mole: moleI, hit, hp: cp.mSLHitPointMax ?? 3, r: cp.mSLChorobeiAttackRadius ?? 100.0, h: cp.mSLChorobeiAttackHeight ?? 100.0 } };
            } else if (mpath) {
                const [bmt, texOnly] = P.matTable(arc, keys, OBJTABLE);
                const dg = P.digest(arc.get(mpath)!, T(bmt), texOnly ? new Uint8Array([0x54]) : new Uint8Array(0));
                if (!lib.has(dg)) {
                    try {
                        const raw = bmd.parse(arc.get(mpath)!, { bmt, bmtTexOnly: texOnly });
                        const pose = raw.jointNames.length > 1 ? P.idlePose(arc, mpath, raw) : null;
                        const model = pose ? bmd.parse(arc.get(mpath)!, { pose, bmt, bmtTexOnly: texOnly }) : raw;
                        posed.set(dg, model);
                        const idx = lib.size;
                        const btkPath = mpath.slice(0, -4) + '.btk';
                        const anim = BTK_TYPES.has(typ) && arc.has(btkPath) ? parseBtk(arc.get(btkPath)!) : null;
                        addModel(w, model, `m${idx}`, TEV_TINT_TYPES.has(typ), anim);
                        const shrink = typ === 'JumpBase' ? arc.get(mpath.slice(0, mpath.lastIndexOf('/')) + '/jumpbase_shrink.bck') : null;
                        if (shrink) {
                            const sa = parseBck(shrink);
                            if (sa.j.length === raw.jointNames.length) for (let k = 0; k <= P.SHRINK_STEPS; k++) addModel(w, bmd.parse(arc.get(mpath)!, { pose: bckPose(sa, (sa.d * k) / P.SHRINK_STEPS) }), `m${idx}_s${k}`);
                        }
                        lib.set(dg, idx);
                    } catch (e) { console.warn('[v1data] skip model', mpath, e); lib.set(dg, -1); }
                }
                mi = lib.get(dg)!;
                if (mi >= 0 && !ctx.specs.has(mi)) {
                    const sp = mpath.slice(0, mpath.lastIndexOf('/')) + '/jumpbase_shrink.bck';
                    P.spec(ctx, mi, { f: mpath, bmt: bmt ? bmtPath() : null, tex: texOnly ? 1 : 0,
                        bck: posed.has(dg) && posed.get(dg)!.jointNames.length > 1 ? P.waitBck(arc, mpath, posed.get(dg)!) : null,
                        shrink: typ === 'JumpBase' && arc.has(sp) ? sp : null });
                }
            }
            if (P.NPC_ORDER.includes(typ) && mpath && posed.get(P.digest(arc.get(mpath)!))) extra = P.npcExtra(ctx, arc, typ, o.payload, posed.get(P.digest(arc.get(mpath)!))!) || extra;
            if (typ === 'MareCork') { const track = P.corkTrack(arc); if (track) extra = { cork: track }; }
            if ((typ === 'WoodBlock' || typ === 'YoshiBlock') && o.payload.length >= 12) {
                const L = o.payload.length, rgb = [s32(o.payload, L - 12), s32(o.payload, L - 8), s32(o.payload, L - 4)];
                if (rgb.every((c) => c >= 0 && c <= 255) && !(rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255)) extra = { tint: rgb };
            }
            if (typ === 'AnimalBird' && o.payload.length >= 4) {
                let ev = s32(o.payload, o.payload.length - 4);
                ev = ev < 0 ? 100 : ev;
                const col = ev < 50 ? [0, 100, 255, 0] : ev === 200 ? [255, 0, 0, 0] : ev === 777 ? [255, 200, 0, 0] : [0, 200, 0, 0];
                extra = { ...(extra || {}), gxSet: [{ m: '_mat_body1', r: 1, c: col }] };
            }
            if (typ === 'NozzleBox') {
                const s = asciiStr(o.payload);
                const col = s.includes('normal_nozzle_item') ? [0, 0, 255, 100] : s.includes('rocket_nozzle_item') ? [255, 0, 0, 100] : s.includes('back_nozzle_item') ? [90, 90, 120, 100] : [255, 255, 255, 100];
                extra = { ...(extra || {}), gxSet: [{ r: 1, c: col }] };
            }
            if (['Telesa', 'LoopTelesa', 'BoxTelesa', 'SeeTelesa', 'MarioModokiTelesa'].includes(typ)) {
                const body = typ === 'BoxTelesa' ? [600, 270, 220, 255] : [350, 350, 350, 255];
                extra = { ...(extra || {}), gxSet: [{ m: '_mat_body', r: 0, c: body }, { k: 0, c: [255, 255, 255, 255] }] };
            }
            if (typ === 'Shine') {
                try {
                    const [mode, q] = lstr(o.payload, actorTail(o.payload));
                    if (q + 4 > o.payload.length) throw new RangeError();
                    const ev = s32(o.payload, q);
                    extra = { ...(extra || {}), shine: asciiStr(mode), ev };
                    if (o.payload.length >= q + 8 && s32(o.payload, q + 4) === 0) extra.inside = 1;
                    if ((o.name || '').includes('１００枚')) extra.coin100 = 1;
                } catch { /* */ }
            }
            if (P.PICTURE_TYPES.has(typ) && o.payload.length >= 12) {
                const L = o.payload.length, rr = u32(o.payload, L - 12), gg = u32(o.payload, L - 8), bb = u32(o.payload, L - 4);
                extra = { ...(extra || {}), c0: [rr & 255, gg & 255, bb & 255, P.PICTURE_START[key || ''] ?? 255] };
            }
            if (P.ROLL_TYPES.has(typ) || P.RAIL_TYPES.has(typ) || P.LIFT_TYPES.has(typ) || typ in P.SPIN_TYPES || o.orbit || ['BiaWatermillVertical', 'BiaTurnBridge', 'CraneRotY', 'craneUpDown'].includes(typ)) {
                let mv = P.moveExtra(typ, o.payload, rails, o.name || '', spinRates);
                if (o.orbit) mv = { orbit: o.orbit };
                if (mv) extra = { ...(extra || {}), ...mv };
            } else if (typ === 'BossGesso' && arc.has(GESSO_DIR + 'bgeso_body.bmd')) {
                const sk = gessoBody(ctx, arc);
                if (sk >= 0) {
                    extra = { ...(extra || {}), skin: sk, ar: 2.0, bg: gessoExtra(ctx, arc) };
                    if (!extraFiles.has('objects/bgeso.json')) extraFiles.set('objects/bgeso.json', gessoAnims(arc));
                }
            } else if (mpath && P.isSpine(o.payload)) {
                const wk = P.walkExtra(typ, o.payload, rails, arc);
                if (wk) { extra = { ...(extra || {}), ...wk }; usedGraphs.add(wk.walk); }
                const words = wk ? (typ === 'AnimalBird' ? ['fly', ...P.WALK_ANIM_WORDS] : P.WALK_ANIM_WORDS) : P.IDLE_ANIM_WORDS;
                const [bmt, texOnly] = P.matTable(arc, keys, OBJTABLE);
                const skey = (wk ? 'skin:' : 'idle:') + (wk && typ === 'AnimalBird' ? 'fly:' : '') + P.digest(arc.get(mpath)!, T(bmt), texOnly ? new Uint8Array([0x54]) : new Uint8Array(0));
                if (!lib.has(skey)) {
                    lib.set(skey, -1);
                    try {
                        const bind = bmd.parse(arc.get(mpath)!, { bmt, bmtTexOnly: texOnly });
                        const anim = bind.jointNames.length > 1 ? P.walkAnim(arc, mpath, bind, words) : null;
                        if (anim) {
                            const sidx = lib.size - 1;
                            let idle = wk ? P.walkAnim(arc, mpath, bind, P.IDLE_ANIM_WORDS.slice(0, 4)) : null;
                            if (typ === 'BossWanwan' && arc.has('bwanwan/bwanwan_down.bck')) idle = parseBck(arc.get('bwanwan/bwanwan_down.bck')!);
                            addSkinned(w, bind, `m${sidx}`, anim, idle);
                            lib.set(skey, sidx);
                        }
                    } catch (e) { console.warn('[v1data] skip skinned', mpath, e); }
                }
                if (lib.get(skey)! >= 0) {
                    P.spec(ctx, lib.get(skey)!, { f: mpath, bmt: bmt ? bmtPath() : null, tex: texOnly ? 1 : 0 });
                    extra = { ...(extra || {}), skin: lib.get(skey) };
                    if (!wk) extra.ar = 2.0;
                }
            }
            const ckey = (hidden ? key!.slice('invisible_'.length) : key) || '';
            for (const ce of P.OBJ_COLS[ckey] || []) {
                const cname = ce.col.toLowerCase();
                if (!(cname in cols) && arc.has(`mapobj/${cname}.col`)) {
                    try { const c = parseCol(arc.get(`mapobj/${cname}.col`)!); cols[cname] = { v: c.verts.flatMap((vv) => vv.map((x) => pyRound(x, 1))), t: c.tris.flat(), ty: c.types.slice() }; }
                    catch { cols[cname] = null; }
                }
                if (cols[cname]) extra = { ...(extra || {}), col: [...((extra || {}).col || []), cname] };
            }
            const info = OBJTABLE[(hidden ? key!.slice('invisible_'.length) : key) || ''] || {};
            let pick = P.PICKUP_TYPES[typ] || '';
            if (hidden && pick) pick += '_hidden';
            const hit = info.hitbox && info.hitbox.length ? info.hitbox : [0, 0];
            let [[px, py, pz], [rx, ry, rz], [sx, sy, sz]] = pl;
            const bs = P.bodyScale(arc, typ);
            if (bs !== null) sx = sy = sz = bs;
            if (typ === 'BossWanwan') {
                const pk = P.libAdd(ctx, 'bwpicket', () => (arc.has('bwanwan/bwanwan_picket.bmd') ? [bmd.parse(arc.get('bwanwan/bwanwan_picket.bmd')!)] : null), { f: 'bwanwan/bwanwan_picket.bmd' });
                const ch = P.libAdd(ctx, 'bwchain', () => (arc.has('bwanwan/bwanwan_chain.bmd') ? [bmd.parse(arc.get('bwanwan/bwanwan_chain.bmd')!)] : null), { f: 'bwanwan/bwanwan_chain.bmd' });
                extra = { ...(extra || {}), bw: { pk, ch, p: [6012.84, 0.0, 7323.15], n: 15, len: 120.0, v: 6.0, g: 'bwanwan' in rails ? 'bwanwan' : null } };
                for (const [nm, f] of [['brkBody', 'bwanwan/bwanwan_body.brk'], ['brkChain', 'bwanwan/bwanwan_chain.brk'], ['brkGold', 'bwanwan/bwanwan_body_gold.brk']]) {
                    if (arc.has(f)) { const b = parseBrk(arc.get(f)!); extra.bw[nm] = { dur: b.dur, c: b.color.map((a: any) => [a.mat, a.reg, a.rgba]) }; }
                }
                if ('bwanwan' in rails) usedGraphs.add('bwanwan');
                px = 5741.72; py = -100.0; pz = 6311.62;
            }
            if (mi < 0 && !pick) continue;
            const inst: any[] = [mi, typ, key || '', pyRound(px, 2), pyRound(py, 2), pyRound(pz, 2), pyRound(rx, 2), pyRound(ry, 2), pyRound(rz, 2), pyRound(sx, 3), pyRound(sy, 3), pyRound(sz, 3),
                pick, hit[0], hit[1], o.hash, P.CARRY_TYPES[typ] || ''];
            if (extra) inst.push(extra);
            instances.push(inst);
        }
        for (const [pname, praw, pimg, panim] of pollutionLayers(arc, scene)) {
            if (!pimg.d.some((v) => v)) continue;
            const dg = 'goop:' + P.digest(praw, pimg.d, T(panim));
            if (!lib.has(dg)) {
                const idx = lib.size;
                try { addGoop(w, praw, pimg, panim, `m${idx}`); lib.set(dg, idx); } catch (e) { console.warn('[v1data] skip goop', scene, pname, e); lib.set(dg, -1); }
            }
            if (lib.get(dg)! >= 0) instances.push([lib.get(dg), 'Pollution', pname, 0, 0, 0, 0, 0, 0, 1, 1, 1, '', 0, 0, 0, '']);
        }
        const usedCols = new Set<string>();
        for (const inst of instances) if (inst.length > 17) for (const c of inst[17].col || []) usedCols.add(c);
        const data: any = { g: Object.fromEntries([...usedGraphs].sort().map((k) => [k, rails[k].map((n: any[]) => [...n.slice(0, 3), n[7], n[8]])])),
            o: instances, w: P.wires(arc), lights: P.stageLights(arc.get('map/scene.bin')!) };
        if (usedCols.size) data.cols = Object.fromEntries([...usedCols].sort().map((c) => [c, cols[c]]));
        const ropes = await P.bridgeRopes(arc, scene, sceneObjs, pngDataUri);
        if (ropes) data.ropes = ropes;
        const cams = P.cameraTools(arc), camBcks = P.cameraBcks(arc);
        if (Object.keys(cams).length) data.cams = cams;
        if (Object.keys(camBcks).length) data.camBck = camBcks;
        const src = P.shineSources(arc, base);
        if (src.length) data.shineSrc = src;
        for (const o of base) {
            if (o.type === 'Mario' && o.payload.length >= 4 && u32(o.payload, o.payload.length - 4) & 1) data.noFludd = 1;
            if (o.type === 'Mario' && !('spawn' in data)) { const pl = placement(o.payload); if (pl) data.spawn = [pyRound(pl[0][0], 1), pyRound(pl[0][1], 1), pyRound(pl[0][2], 1), pyRound(pl[1][1], 2)]; }
        }
        const dyn: any = {};
        for (const [atypeS, [path, kind, pname]] of Object.entries(P.DYNAMIC_CARRY)) {
            const atype = +atypeS;
            if (!arc.has(path)) continue;
            const buildDyn = () => { const raw = bmd.parse(arc.get(path)!); const pose = raw.jointNames.length > 1 ? P.idlePose(arc, path, raw) : null; return [pose ? bmd.parse(arc.get(path)!, { pose }) : raw]; };
            const di = P.libAdd(ctx, P.digest(arc.get(path)!), buildDyn, { f: path });
            if (di >= 0) {
                const p: any = P.enemyParams(arc, pname) || {};
                const swap = P.DYNAMIC_SPRAYED[atype];
                const buildWet = () => { const model = buildDyn()[0]; const stop = model.textures.find((t) => t[0] === swap[1]); if (!stop) return null; model.textures = model.textures.map((t) => (t[0] === swap[0] ? stop : t)); return [model]; };
                const ai = swap ? P.libAdd(ctx, 'wet:' + P.digest(arc.get(path)!), buildWet, { f: path, swap: swap.slice() }) : -1;
                const prm: any = {};
                for (const [k, v] of Object.entries(p)) if (typeof v === 'number' && k.startsWith('mSL') && (k.includes('Thrown') || k.includes('Bomb') || k.includes('Body') || k.includes('Damage'))) prm[k.slice(3)] = v;
                dyn[atype.toString(16).padStart(8, '0')] = { m: di, sprayed: ai, kind, prm };
            }
        }
        if (Object.keys(dyn).length) data.dyn = dyn;
        data.trig = triggers(arc);
        data.mp = Object.fromEntries([...ctx.specs.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v]));
        sceneJson.set(scene, data);
    }
    const glb = await w.write();
    return { lib: glb, scenes: sceneJson, extra: extraFiles };
}

