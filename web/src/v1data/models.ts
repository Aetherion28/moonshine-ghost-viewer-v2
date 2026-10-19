// Mario, Yoshi and the shared screen data (tools/build_mario_iso.py, build_yoshi.py,
// build_water_tex.py, build_shine_get.py).
import { Bytes, u16, u32, s16, ascii } from './bin.js';
import * as bmd from './bmd.js';
import { GlbWriter } from './glb.js';
import { parseBck } from './anim.js';
import { materialFor, uvFor, SUBSTITUTE, pickBase } from './gxmat.js';
import { quatFromMatrix, inverseBinds, skinArrays, addMesh, addSkinned } from './objects.js';
import { btiRgba } from './objparts.js';
import type { Image } from './gxtex.js';

type Arc = Map<string, Bytes>;
const addNode = (w: GlbWriter, node: any) => { w.gltf.nodes.push(node); return w.gltf.nodes.length - 1; };

function addStaticPart(w: GlbWriter, model: bmd.Model, name: string, parentNode: number, matrix: bmd.M4 | null = null, skipTex: string[] = []) {
    const holder: any = { name, children: [] };
    if (matrix) { const m = []; for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) m.push(matrix[r * 4 + c]); holder.matrix = m; }
    const hi = addNode(w, holder);
    (w.gltf.nodes[parentNode].children = w.gltf.nodes[parentNode].children || []).push(hi);
    for (const mesh of model.meshes) {
        const mat = mesh.material >= 0 && mesh.material < model.materials.length ? model.materials[mesh.material] : null;
        const pb = mat ? pickBase(model, mat) : null;
        if (mat && pb && skipTex.includes(model.textures[pb[0]][0].toLowerCase())) continue;
        const [mi, entry] = materialFor(w, model, mat, name);
        const uv = entry ? uvFor(mesh, entry) : null;
        const color = mat && mat.useVertexColor ? mesh.color || null : null;
        addMesh(w, `${name}_s${mesh.shape}`, mesh.pos, mesh.tris, mi, uv, color, null, null, mesh.nrm || null);
        const node = w.gltf.nodes.pop();
        w.gltf.scenes[0].nodes.pop();
        w.gltf.nodes[hi].children.push(addNode(w, node));
    }
    return hi;
}
function addSkinnedPart(w: GlbWriter, model: bmd.Model, name: string, parentNode: number, rootMtx: bmd.M4, skipTex: string[] = []) {
    const holder = addNode(w, { name, children: [] });
    (w.gltf.nodes[parentNode].children = w.gltf.nodes[parentNode].children || []).push(holder);
    const jn = model.jointNames.map((_, i) => {
        const [sc, rot, tr] = model.jointTrs[i];
        return addNode(w, { name: `${name}_j${i}`, translation: tr.slice(), rotation: quatFromMatrix(bmd.eulerMatrix(rot[0], rot[1], rot[2])), scale: sc.slice() });
    });
    model.jointParent.forEach((par, i) => { const p = par >= 0 ? w.gltf.nodes[jn[par]] : w.gltf.nodes[holder]; (p.children = p.children || []).push(jn[i]); });
    const world = model.jointsWorld.map((m) => bmd.mul4(rootMtx, m));
    (w.gltf.skins = w.gltf.skins || []).push({ joints: jn, skeleton: jn[0], inverseBindMatrices: w.accessor(inverseBinds(world), 'MAT4', 5126, null) });
    const skin = w.gltf.skins.length - 1;
    const R = [0, 1, 2].map((r) => [0, 1, 2].map((c) => rootMtx[r * 4 + c])), T = [rootMtx[3], rootMtx[7], rootMtx[11]];
    const Ri = bmd.inv4(Float64Array.from([...R[0], 0, ...R[1], 0, ...R[2], 0, 0, 0, 0, 1]));
    for (const mesh of model.meshes) {
        const mat = mesh.material >= 0 && mesh.material < model.materials.length ? model.materials[mesh.material] : null;
        const pb = mat ? pickBase(model, mat) : null;
        if (mat && pb && skipTex.includes(model.textures[pb[0]][0].toLowerCase())) continue;
        const [mi, entry] = materialFor(w, model, mat, name);
        const uv = entry ? uvFor(mesh, entry) : null;
        const color = mat && mat.useVertexColor ? mesh.color || null : null;
        const { joints, weights } = skinArrays(model, mesh);
        const n = mesh.pos.length / 3, pos = new Float64Array(n * 3);
        for (let v = 0; v < n; v++) for (let r = 0; r < 3; r++) pos[v * 3 + r] = mesh.pos[v * 3] * R[r][0] + mesh.pos[v * 3 + 1] * R[r][1] + mesh.pos[v * 3 + 2] * R[r][2] + T[r];
        let nrm: Float64Array | null = null;
        if (mesh.nrm) {
            nrm = new Float64Array(n * 3);
            for (let v = 0; v < n; v++) {
                const x = mesh.nrm[v * 3], y = mesh.nrm[v * 3 + 1], z = mesh.nrm[v * 3 + 2];
                // nrm @ inv(R): row vector times matrix
                const a = x * Ri[0] + y * Ri[4] + z * Ri[8], b = x * Ri[1] + y * Ri[5] + z * Ri[9], c = x * Ri[2] + y * Ri[6] + z * Ri[10];
                const l = Math.max(Math.sqrt(a * a + b * b + c * c), 1e-9);
                nrm[v * 3] = a / l; nrm[v * 3 + 1] = b / l; nrm[v * 3 + 2] = c / l;
            }
        }
        addMesh(w, `${name}_s${mesh.shape}`, pos, mesh.tris, mi, uv, color, joints, weights, nrm);
        const node = w.gltf.nodes.pop();
        w.gltf.scenes[0].nodes.pop();
        node.skin = skin;
        w.gltf.nodes[holder].children.push(addNode(w, node));
    }
    return jn;
}

/** models/mario.glb and models/mario_bck.json from mario.szs */
export async function buildMario(arc: Arc): Promise<{ glb: Uint8Array; bck: any }> {
    SUBSTITUTE.clear();
    const w = new GlbWriter(256);
    const body = bmd.parse(arc.get('bmd/ma_mdl1.bmd')!);
    SUBSTITUTE.set('H_ma_main_dummy', body.textures[0]);
    const jointNodes = body.jointNames.map((name, i) => {
        const [sc, rot, tr] = body.jointTrs[i];
        return addNode(w, { name, translation: tr.slice(), rotation: quatFromMatrix(bmd.eulerMatrix(rot[0], rot[1], rot[2])), scale: sc.slice() });
    });
    body.jointParent.forEach((p, i) => { if (p >= 0) (w.gltf.nodes[jointNodes[p]].children = w.gltf.nodes[jointNodes[p]].children || []).push(jointNodes[i]); else w.gltf.scenes[0].nodes.push(jointNodes[i]); });
    (w.gltf.skins = w.gltf.skins || []).push({ joints: jointNodes, skeleton: jointNodes[0], inverseBindMatrices: w.accessor(inverseBinds(body.jointsWorld), 'MAT4', 5126, null) });
    for (const mesh of body.meshes) {
        const mat = mesh.material >= 0 && mesh.material < body.materials.length ? body.materials[mesh.material] : null;
        const [mi, entry] = materialFor(w, body, mat, 'mario');
        const uv = entry ? uvFor(mesh, entry) : null;
        const { joints, weights } = skinArrays(body, mesh);
        addMesh(w, `body_s${mesh.shape}`, mesh.pos, mesh.tris, mi, uv, null, joints, weights, mesh.nrm || null);
        w.gltf.nodes[w.gltf.nodes.length - 1].skin = 0;
    }
    const eyes: any = {};
    body.textures.forEach((tx, ti) => {
        if (tx[0].startsWith('H_ma_eye') && tx[1]) {
            const ref = w.textureRgba(`tex:${tx[0]}:${digest10(tx[1])}`, tx[1], tx[2], tx[3]);
            if (ref) eyes[String(ti)] = ref[0];
        }
    });
    for (const m of w.gltf.materials) if ((m.name || '').endsWith('_mat_eye_L') || (m.name || '').endsWith('_mat_eye_R')) (m.extras = m.extras || {}).eyes = eyes;
    const jidx = new Map(body.jointNames.map((n, i) => [n, jointNodes[i]]));
    for (const [hid, side, joint] of [['2', 'r', 'jnt_hand_R'], ['2', 'l', 'jnt_hand_L'], ['3', 'r', 'jnt_hand_R'], ['3', 'l', 'jnt_hand_L'], ['4', 'r', 'jnt_hand_R']]) {
        const key = `bmd/ma_hnd${hid}${side}.bmd`;
        if (arc.has(key)) addStaticPart(w, bmd.parse(arc.get(key)!), `hand_${hid}_${side}`, jidx.get(joint)!);
    }
    addStaticPart(w, bmd.parse(arc.get('bmd/ma_cap1.bmd')!), 'cap', jidx.get('M_head')!);
    const fludd = bmd.parse(arc.get('watergun2/body/wg_mdl1.bmd')!);
    SUBSTITUTE.set('H_watergun_main_dummy', fludd.textures[1]);
    const chest = body.jointsWorld[body.jointNames.indexOf('jnt_chest')];
    const fj = addSkinnedPart(w, fludd, 'fludd_body', jidx.get('jnt_chest')!, chest, ['h_watergun_mask_i4']);
    const nci = fludd.jointNames.indexOf('nozzle_center');
    const mount = bmd.mul4(chest, fludd.jointsWorld[nci]);
    for (const noz of ['normal_wg', 'hover_wg', 'rocket_wg', 'back_wg']) {
        const key = `watergun2/${noz}/${noz}.bmd`;
        if (arc.has(key)) addSkinnedPart(w, bmd.parse(arc.get(key)!), `nozzle_${noz}`, fj[nci], mount);
    }
    const glb = await w.write();
    SUBSTITUTE.clear();
    const anims: any = {}, fl: any = {};
    for (const [k, v] of arc) {
        let m = /^bck\/ma_(.+)\.bck$/.exec(k);
        if (m) anims[m[1]] = parseBck(v);
        m = /^watergun2\/(?:body|normal_wg|hover_wg|rocket_wg|back_wg)\/(.+)\.bck$/.exec(k);
        if (m) fl[m[1]] = parseBck(v);
    }
    return { glb, bck: { joints: body.jointNames, anims, fludd: fl } };
}
import { contentHash } from './bin.js';
const digest10 = (img: Image) => contentHash(img.d).slice(0, 10);

/** models/yoshi.glb from yoshi.szs */
export async function buildYoshi(arc: Arc): Promise<Uint8Array> {
    SUBSTITUTE.clear();
    const model = bmd.parse(arc.get('yoshi_model.bmd')!);
    const names = [...arc.keys()].filter((k) => k.endsWith('.bck')).sort();
    const anims = names.map((k) => parseBck(arc.get(k)!));
    const w = new GlbWriter(128);
    addSkinned(w, model, 'yoshi', anims[names.indexOf('yoshi_wait.bck')]);
    const ex = (w.gltf.scenes[0].extras = w.gltf.scenes[0].extras || {});
    ex.anims = Object.fromEntries(anims.map((a, i) => [`yoshi#${i}`, a]));
    ex.animNames = names.map((n) => n.slice(0, -4));
    return w.write();
}

/** WATER_TEX: FLUDD's water textures as opaque RGB PNG data URIs (channels packed so nothing premultiplies) */
export async function buildWaterTex(arc: Arc, png: (img: Image, alpha: boolean) => Promise<string>) {
    const ref = btiRgba(arc.get('timg/waterref.bti')!);
    const pack = (src: Image, f: (d: Uint8Array, i: number) => [number, number, number]) => {
        const out = { w: src.w, h: src.h, d: new Uint8Array(src.d.length) };
        for (let i = 0; i < src.d.length; i += 4) { const [r, g, b] = f(src.d, i); out.d[i] = r; out.d[i + 1] = g; out.d[i + 2] = b; out.d[i + 3] = 255; }
        return out;
    };
    const tex: any = {};
    tex.ref = await png(pack(ref, (d, i) => [d[i + 3], d[i], 0]), false);
    for (const [k, n] of [['mask', 'watermask'], ['spec', 'waterspec']]) { const p = btiRgba(arc.get(`timg/${n}.bti`)!); tex[k] = await png(pack(p, (d, i) => [d[i], d[i], d[i]]), false); }
    const sp = btiRgba(arc.get('timg/splash.bti')!);
    tex.splash = await png(pack(sp, (d, i) => [d[i], d[i + 3], 0]), false);
    return tex;
}

function bloPictures(d: Bytes) {
    const out: any = {};
    let o = 0x20;
    while (o + 8 <= d.length) {
        const tag = ascii(d, o, 4), sz = u32(d, o + 4);
        if (sz < 8) break;
        const b = d.subarray(o + 8, o + sz);
        if (tag === 'PIC1') {
            const name = ascii(b, 4, 4), x = s16(b, 8), y = s16(b, 10), w = s16(b, 12), h = s16(b, 14), ln = b[22];
            const tex = ascii(b, 23, ln), c0 = 23 + ln + 13;
            out[name] = [x, y, w, h, tex, [0, 1, 2, 3].map((i) => Array.from(b.subarray(c0 + i * 4, c0 + i * 4 + 4)))];
        }
        o += sz;
    }
    return out;
}
/** SHINE_BCK, CAM_BCK and SG_LETTERS (the Shine get demo) */
export async function buildShineGet(scene: Arc, common: Arc, game: Arc, png: (img: Image, alpha: boolean) => Promise<string>) {
    const shine: any = {};
    for (const [k, n] of [['float', 'float'], ['get', 'demo_shine_get'], ['get_yo', 'demo_shine_get_yo']]) shine[k] = parseBck(scene.get(`mapobj/shine_${n}.bck`)!);
    const cam: any = {};
    for (const k of ['outside', 'inside']) cam[k] = parseBck(common.get(`camera/camera_demo_shine_get_${k}.bck`)!);
    const pics = bloPictures(game.get('scrn/big_tx_1.blo')!);
    const letters = [];
    for (let i = 0; i < 9; i++) {
        const [x, y, w, h, tex, corners] = pics[`sg${String(i).padStart(2, '0')}`];
        letters.push({ x, y, w, h, c: corners, tex: await png(btiRgba(game.get(`timg/${tex}`)!), true) });
    }
    return { SHINE_BCK: shine, CAM_BCK: cam, SG_LETTERS: letters };
}
void u16;
