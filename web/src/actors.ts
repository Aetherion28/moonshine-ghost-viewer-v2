// The stage's characters (NPCs, enemies, animals): noclip's Sunshine loader draws map objects
// only, so the viewer adds every placed TSpineEnemy (its manager is a …マネージャー / 管理 object)
// whose model it can find in the scene archive, standing where it's placed and playing its idle
// animation. Model lookup as v1's tools/build_objects.py find_model. NPCs get their colours and
// parts the way TBaseNPC::setIndividualDifference_ gives them (NpcInitPrg.cpp, NpcColor.cpp, with
// sAllNpcInitData from NpcInitData.cpp in data/npc_init.json).

import { mat4, quat } from 'gl-matrix';
const _q = quat.create();
import * as RARC from '../noclip/Common/JSYSTEM/JKRArchive.js';
import { J3DModelData } from '../noclip/Common/JSYSTEM/J3D/J3DGraphBase.js';
import { J3DModelInstanceSimple } from '../noclip/Common/JSYSTEM/J3D/J3DGraphSimple.js';
import { BCK, BMD, BTK, BRK } from '../noclip/Common/JSYSTEM/J3D/J3DLoader.js';
import { GfxDevice } from '../noclip/gfx/platform/GfxPlatform.js';
import { GfxRenderCache } from '../noclip/gfx/render/GfxRenderCache.js';
import { parseNameRefs, placement, SceneObj } from './triggers.js';
import { SMSPass } from './sms_scene.js';
import { ColorKind } from '../noclip/gx/gx_render.js';
import { BTI, BTIData } from '../noclip/Common/JSYSTEM/JUTTexture.js';
import NPC_INIT from './data/npc_init.json';

// NPC types in ACTOR_TYPE_NPC_* order, which indexes sAllNpcInitData.
const NPC_ORDER = ['NPCMonteM', 'NPCMonteMA', 'NPCMonteMB', 'NPCMonteMC', 'NPCMonteMD', 'NPCMonteME', 'NPCMonteMF', 'NPCMonteMG', 'NPCMonteMH',
    'NPCMonteW', 'NPCMonteWA', 'NPCMonteWB', 'NPCMonteWC', 'NPCMareM', 'NPCMareMA', 'NPCMareMB', 'NPCMareMC', 'NPCMareMD', 'NPCMareW', 'NPCMareWA',
    'NPCMareWB', 'NPCKinopio', 'NPCKinojii', 'NPCPeach', 'NPCRaccoonDog', 'NPCSunflowerL', 'NPCSunflowerS'];
const POLLUTION_NPCS = new Set(['NPCMonteM', 'NPCMonteMA', 'NPCMonteMC', 'NPCMonteW', 'NPCMonteWA', 'NPCMareM', 'NPCMareW', 'NPCKinopio']);
const SPECIAL_NPCS = new Set(['NPCMonteMF', 'NPCMonteMG', 'NPCMonteMH', 'NPCMonteWC', 'NPCMareMA', 'NPCMareMB', 'NPCMareMC', 'NPCMareMD', 'NPCMareWA', 'NPCMareWB']);

/** TBaseNPC's per-instance fields after TActor and TSpineEnemy (manager, graph): colour indices, parts flags. */
function npcFields(o: SceneObj) {
    try {
        const v = o.payload;
        let p = 36;
        p += 2 + v.getUint16(p) + 4;    // TActor: name, u32
        p += 2 + v.getUint16(p);        // manager
        p += 2 + v.getUint16(p);        // graph
        const vals: number[] = [];
        for (let k = 0; k < 9; k++) vals.push(v.getInt32(p + k * 4));
        return { c0: vals.slice(0, 3), c1: vals.slice(3, 6), parts: Math.max(0, vals[6]) };
    } catch { return null; }
}

const s10 = (c: number[]) => ({ r: c[0] / 255, g: c[1] / 255, b: c[2] / 255, a: 1 });
/** SMS_InitChangeNpcColor: kind 0 the material colour, 1 TEV register 0, 2 registers 1 (first table) and 2 (second). */
function npcColour(m: J3DModelInstanceSimple, cc: any, idx: number) {
    if (!cc || idx < 0) return;
    const mi = m.materialInstances.find((x) => x.name === cc.mat);
    if (!mi) return;
    const a = cc.c0 && cc.c0[idx], b = cc.c1 && cc.c1[idx];
    if (cc.kind === 0 && a) mi.setColorOverride(ColorKind.MAT0, { ...s10(a), a: 1 });
    else if (cc.kind === 1 && a) mi.setColorOverride(ColorKind.C0, s10(a));
    else if (cc.kind === 2) { if (a) mi.setColorOverride(ColorKind.C1, s10(a)); if (b) mi.setColorOverride(ColorKind.C2, s10(b)); }
}

// Placeholder textures characters' models ship with, swapped at load for the real ones
// (SMS_ChangeTextureAll in NpcManager.cpp; the goop texture also on Mario, MarioDraw.cpp).
const TEXTURE_SWAPS: [string, string][] = [
    ['H_ma_rak_dummy', 'map/pollution/h_ma_rak.bti'],
    ['I_mom_mino_dummyI4', 'montemcommon/i_mom_mino_rgba.bti'],
    ['I_mow_mino_dummyI4', 'montewcommon/i_mow_mino_rgba.bti'],
    ['J_jellyFish_dummy', 'marejellyfish/j_kurage.bti'],
];
const btiCache = new WeakMap<RARC.JKRArchive, Map<string, BTIData | null>>();
export function swapTextures(device: GfxDevice, cache: GfxRenderCache, arc: RARC.JKRArchive, models: J3DModelInstanceSimple[]) {
    let c = btiCache.get(arc);
    if (!c) { c = new Map(); btiCache.set(arc, c); }
    for (const [name, path] of TEXTURE_SWAPS) {
        let d = c.get(path);
        if (d === undefined) {
            const f = arc.findFileData(path);
            d = f ? new BTIData(device, cache, BTI.parse(f, name).texture) : null;
            c.set(path, d);
        }
        if (!d) continue;
        for (const m of models) { const r = m.getTextureMappingReference(name); if (r) d.fillTextureMapping(r); }
    }
}

/** Parts hung on a character's joints, placed each frame after its animation. */
export interface ActorPart { part: J3DModelInstanceSimple; body: J3DModelInstanceSimple; joint: number; }
export function updateActorParts(parts: ActorPart[], timeMs: number) {
    const done = new Set<J3DModelInstanceSimple>();
    for (const p of parts) {
        if (!done.has(p.body)) { p.body.animationController.setTimeInMilliseconds(timeMs); p.body.calcAnim(); done.add(p.body); }
        mat4.copy(p.part.modelMatrix, p.body.shapeInstanceState.jointToWorldMatrixArray[p.joint] || p.body.modelMatrix);
    }
}

const SKIP = /^(Light|AmbColor|Cube\w*|AreaCylinder|\w*Manager|Map|Sky|SunMgr|MirrorCamera|Mario|GroupObj|IdxGroup|MarScene|MapObjSoundGroup|MapObjWave|Pollution|\w*Camera\w*|\w*Event\w*Point|Strategy|ConductorInit|NameRefGrp|ScenarioArchiveName\w*|Shimmer)$/;
const TYPE_FOLDERS: Record<string, string> = {
    NPCMareM: 'marem', NPCMareMB: 'maremb', NPCMareW: 'marew', NPCMareWB: 'marewb', AnimalMew: 'mew', AnimalBird: 'bird', NameKuri: 'namekuri2',
    BombHei: 'bombhei', Cannon: 'cannon', RaccoonDog: 'raccoondog', NPCRaccoonDog: 'raccoondog', Gesso: 'mamegesso', LandGesso: 'rikugesso',
    BossGesso: 'bgeso', PoiHana: 'poihana', PoiHanaRed: 'poihana', SleepPoiHana: 'poihana', StayPakkun: 'pakkun', Pakkun: 'pakkun',
    HanaSambo: 'sambohead', Yumbo: 'sambohead', ElecNokonoko: 'dennoko', Telesa: 'telesa', LoopTelesa: 'telesa', BoxTelesa: 'telesa',
    MarioModokiTelesa: 'telesa', BossTelesa: 'telesa', FishoidA: 'fish', FishoidB: 'fish', FishoidC: 'fish', FishoidD: 'fish',
    ButterflyA: 'butterfly', ButterflyB: 'butterfly', ButterflyC: 'butterfly', NPCBoard: 'boardnpc', NPCKinopio: 'kinopio',
    NPCKinojii: 'kinojii', NPCPeach: 'peach', Amenbo: 'amenbo', HamuKuri: 'hamukuri', Hamukuri: 'hamukuri', HaneHamuKuri: 'hanekuri',
    HaneHamuKuri2: 'hanekuri', DoroHaneKuri: 'hanekuri', KageMario: 'kagemario', Kazekun: 'kazekun', Manta: 'manta', FireWanwan: 'firewanwan',
    BossWanwan: 'bwanwan', BeeHive: 'beehive', Kugu: 'kug', Aminoko: 'aminoko', GateKeeper: 'gatekeeper', OrangeSeal: 'seal',
    BossPakkun: 'kbosspakkun', Gorogoro: 'gorogoro',
};
const PREFERRED_FILES: Record<string, string> = {
    poihana: 'default.bmd', sambohead: 'sambohead.bmd', telesa: 'telesa.bmd', mamegesso: 'default.bmd', rikugesso: 'geso_model1.bmd',
    bgeso: 'bgeso_body.bmd', pakkun: 'pakun.bmd', kinopio: 'kinopio_body.bmd', kinojii: 'kinoji_body.bmd', peach: 'peach_model.bmd',
    beehive: 'bee_nest.bmd', firewanwan: 'wanwan.bmd', bwanwan: 'bwanwan_body.bmd', gatekeeper: 'gene_pakkun_model1.bmd',
    seal: 'gene_orange_model1.bmd', cannon: 'default.bmd', bombhei: 'nejibomb_model1.bmd',
};
const NPC_BODIES: Record<string, [string, string]> = {
    NPCMareM: ['marem', 'marem.bmd'], NPCMareMA: ['marem', 'marem.bmd'], NPCMareMB: ['marem', 'marem.bmd'], NPCMareMC: ['marem', 'marem.bmd'],
    NPCMareMD: ['marem', 'marem.bmd'], NPCMareW: ['marew', 'marew.bmd'], NPCMareWA: ['marew', 'marew.bmd'], NPCMareWB: ['marew', 'marew.bmd'],
    NPCRaccoonDog: ['raccoondog', 'tanuki.bmd'], RaccoonDog: ['raccoondog', 'tanuki.bmd'],
};
const TYPE_FILES: Record<string, string> = {
    Yumbo: 'yumbo.bmd', HaneHamuKuri: 'hanekuri.bmd', HaneHamuKuri2: 'hanekuri.bmd', DoroHaneKuri: 'dorohane.bmd', MarioModokiTelesa: 'modoki.bmd',
    FishoidA: 'fisha.bmd', FishoidB: 'fishb.bmd', FishoidC: 'fishc.bmd', FishoidD: 'fishd.bmd', ButterflyA: 'butterflya.bmd',
    ButterflyB: 'butterflyb.bmd', ButterflyC: 'butterflyc.bmd',
};
const IDLE_WORDS = ['wait', 'idle', 'stand', 'taiki', 'walk', 'fly', 'swim', 'swing'];

/** Every file in the archive by its path from the root, lower case. */
function listFiles(arc: RARC.JKRArchive): Map<string, RARC.RARCFile> {
    const out = new Map<string, RARC.RARCFile>();
    const walk = (d: RARC.RARCDir, prefix: string) => {
        for (const f of d.files) out.set((prefix + f.name).toLowerCase(), f);
        for (const s of d.subdirs) if (s.name !== '.' && s.name !== '..') walk(s, prefix + s.name + '/');
    };
    walk(arc.root, '');
    return out;
}

function isSpine(o: SceneObj): boolean {
    // [TActor model key string] [u32] [manager name string]: an actor managed by a …マネージャー / 管理.
    try {
        const v = o.payload;
        let p = 36 + 2 + v.getUint16(36);
        p += 4;
        const n = v.getUint16(p);
        const name = new TextDecoder('shift_jis').decode(o.bytes.subarray(p + 2, p + 2 + n));
        return name.includes('マネージャー') || name.includes('管理');
    } catch { return false; }
}

function findModel(files: Map<string, RARC.RARCFile>, typ: string): string | null {
    if (NPC_BODIES[typ]) { const [f, fn] = NPC_BODIES[typ]; if (files.has(`${f}/${fn}`)) return `${f}/${fn}`; }
    const base = typ.toLowerCase().replace(/^(npc|animal|enemy)/, '');
    const folders = [(TYPE_FOLDERS[typ] || '').toLowerCase(), typ.toLowerCase(), base];
    for (let n = base.length - 1; n > 3; n--) folders.push(base.slice(0, n));
    for (const f of folders) {
        if (!f || f === 'mapobj' || f === 'map') continue;
        const names = [...files.keys()].filter((k) => k.startsWith(f + '/') && k.split('/').length === 2 && (k.endsWith('.bmd') || k.endsWith('.bdl'))).sort();
        if (!names.length) continue;
        for (const want of [TYPE_FILES[typ], PREFERRED_FILES[f], `${f}.bmd`]) if (want && names.includes(`${f}/${want.toLowerCase()}`)) return `${f}/${want.toLowerCase()}`;
        for (const word of ['model1', '_model', 'default', 'set', 'body']) { const hit = names.find((k) => k.includes(word)); if (hit) return hit; }
        return names.reduce((a, b) => (b.length < a.length ? b : a));
    }
    return null;
}

function idleAnim(files: Map<string, RARC.RARCFile>, model: string, joints: number) {
    const folder = model.split('/')[0];
    const folders = [folder, folder + 'anm', folder + 'common', folder.slice(0, -1) + 'common', folder.slice(0, -2) + 'common'];
    const cands = [...files.keys()].filter((k) => folders.some((f) => k.startsWith(f + '/')) && k.split('/').length === 2 && k.endsWith('.bck')).sort();
    for (const w of IDLE_WORDS)
        for (const k of cands) {
            if (!k.split('/')[1].includes(w)) continue;
            try { const a = BCK.parse(files.get(k)!.buffer); if (a.jointAnimationEntries.length === joints) return a; } catch { }
        }
    return null;
}

/** Characters for the stage, as model instances placed in the world. Objects noclip already draws are left out. */
export function buildActors(device: GfxDevice, cache: GfxRenderCache, arc: RARC.JKRArchive, actorParts: ActorPart[]): J3DModelInstanceSimple[] {
    const scene = arc.findFileData('map/scene.bin');
    if (!scene) return [];
    const files = listFiles(arc);
    const models = new Map<string, J3DModelData | null>();
    const out: J3DModelInstanceSimple[] = [];
    for (const o of parseNameRefs(scene.arrayBuffer, scene.byteOffset, scene.byteLength)) {
        if (SKIP.test(o.type) || !isSpine(o)) continue;
        const pl = placement(o);
        if (!pl) continue;
        const path = findModel(files, o.type);
        if (!path) continue;
        if (!models.has(path)) {
            try { models.set(path, new J3DModelData(device, cache, BMD.parse(files.get(path)!.buffer))); } catch { models.set(path, null); }
        }
        const data = models.get(path);
        if (!data) continue;
        const m = new J3DModelInstanceSimple(data);
        m.passMask = SMSPass.MAIN;
        const anim = idleAnim(files, path, data.bmd.jnt1.joints.length);
        if (anim) m.bindANK1(anim);
        const base = path.replace(/\.(bmd|bdl)$/, '');
        const btk = files.get(base + '.btk'), brk = files.get(base + '.brk');
        try { if (btk) m.bindTTK1(BTK.parse(btk.buffer)); if (brk) m.bindTRK1(BRK.parse(brk.buffer)); } catch { }
        const [[x, y, z], [rx, ry, rz], [sx, sy, sz]] = pl;
        quat.fromEuler(_q, rx, ry, rz);   // as noclip's loader places map objects
        mat4.fromRotationTranslationScale(m.modelMatrix, _q, [x, y, z], [sx, sy, sz]);
        m.name = `${o.type} ${o.name}`;
        out.push(m);
        const ni = NPC_ORDER.indexOf(o.type), f = ni >= 0 ? npcFields(o) : null;
        if (f) {
            const info: any = (NPC_INIT as any)[ni];
            for (let j = 0; j < 2; j++) npcColour(m, info.body[j], f.c0[j]);
            if (POLLUTION_NPCS.has(o.type) || SPECIAL_NPCS.has(o.type)) {
                // KCOLOR0 = (255, 255, 255, pollution) on every material but the eyes; its alpha is the
                // threshold the TEV compares the pollution mask against.
                const amount = POLLUTION_NPCS.has(o.type) ? Math.max(0, f.c0[2]) / 255 : 0;
                const k0 = { r: 1, g: 1, b: 1, a: (Math.floor(amount * 150) & 0xFF) / 255 };
                for (const mi of m.materialInstances) if (!/eye/i.test(mi.name)) mi.setColorOverride(ColorKind.K0, k0);
            }
            info.parts.forEach((part: any, i: number) => {
                if (!part || !((f.parts >> i) & 1)) return;
                const path = [...files.keys()].find((k) => k.endsWith('/' + part.file.toLowerCase()));
                if (!path) return;
                if (!models.has(path)) { try { models.set(path, new J3DModelData(device, cache, BMD.parse(files.get(path)!.buffer))); } catch { models.set(path, null); } }
                const pd = models.get(path);
                if (!pd) return;
                const pm = new J3DModelInstanceSimple(pd);
                pm.passMask = SMSPass.MAIN;
                const idx = part.slot < 3 ? f.c1[part.slot] : -1;
                for (const cc of part.colors || []) npcColour(pm, cc, idx);
                const joint = data.bmd.jnt1.joints.findIndex((j) => j.name === part.joint);
                actorParts.push({ part: pm, body: m, joint: joint < 0 ? 0 : joint });
                out.push(pm);
            });
        }
    }
    swapTextures(device, cache, arc, out);
    return out;
}
