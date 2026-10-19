// tools/build_objects.py, part 1: per-object helpers (rails, lights, parameters, speeds, movement,
// windmill blocks and bridge boards, NPC colours and parts, cannons, corks, models, wires, cameras,
// Shine sources). Part 2 (objects.ts) builds each area's library and object lists.
import { Bytes, u16, u32, s32, f32, s16, pyRound, contentHash, openArc } from './bin.js';
import * as bmd from './bmd.js';
import { parseBck, bckPose } from './anim.js';
import { GlbWriter } from './glb.js';
import { decode as gxDecode } from './gxtex.js';
import { parseScene, placement, stringsAfter, lstr, actorTail, parsePrm, Prm, isFloat, SceneObj, builtinCalls, npcFields, asciiStr, sjisStr } from './scenebin.js';
import { calcKeyCode } from '../game/engine.js';
import MAPOBJ_COLS from './tables/mapobj_cols.json';
import NPC_INIT from './tables/npc_init.json';

export type Arc = Map<string, Bytes>;
const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...b: Bytes[]) => { const n = b.reduce((s, x) => s + x.length, 0), o = new Uint8Array(n); let p = 0; for (const x of b) { o.set(x, p); p += x.length; } return o; };
export const digest = (...b: Bytes[]) => contentHash(cat(...b));
const sortedKeys = (arc: Arc) => [...arc.keys()].sort();
const lowerMap = (arc: Arc) => { const m = new Map<string, string>(); for (const k of arc.keys()) m.set(k.toLowerCase(), k); return m; };
const rad = (d: number) => (d * Math.PI) / 180;

export const SKIP_TYPES = /^(Light|AmbColor|Cube\w*|AreaCylinder|\w*Manager|Map|Sky|SunMgr|MirrorCamera|Mario|GroupObj|IdxGroup|MarScene|MapObjSoundGroup|MapObjWave|Pollution|\w*Camera\w*|\w*Event\w*Point|Strategy|ConductorInit|NameRefGrp|ScenarioArchiveName\w*|Shimmer)$/;
export const PICKUP_TYPES: Record<string, string> = { Coin: 'coin', CoinBlue: 'coin_blue', CoinRed: 'coin_red', Shine: 'shine', Mushroom1up: '1up', Mushroom1upR: '1up', Mushroom1upX: '1up', NozzleItem: 'nozzle', Item: 'item' };
export const TYPE_FOLDERS: Record<string, string> = { NPCMareM: 'marem', NPCMareMB: 'maremb', NPCMareW: 'marew', NPCMareWB: 'marewb',
    AnimalMew: 'mew', AnimalBird: 'bird', NameKuri: 'namekuri2', BombHei: 'bombhei', Cannon: 'cannon', RaccoonDog: 'raccoondog', NPCRaccoonDog: 'raccoondog',
    Gesso: 'mamegesso', LandGesso: 'rikugesso', BossGesso: 'bgeso', PoiHana: 'poihana', PoiHanaRed: 'poihana', SleepPoiHana: 'poihana', StayPakkun: 'pakkun', Pakkun: 'pakkun',
    HanaSambo: 'sambohead', Yumbo: 'sambohead', ElecNokonoko: 'dennoko', Telesa: 'telesa', LoopTelesa: 'telesa', BoxTelesa: 'telesa', MarioModokiTelesa: 'telesa', BossTelesa: 'telesa',
    FishoidA: 'fish', FishoidB: 'fish', FishoidC: 'fish', FishoidD: 'fish', ButterflyA: 'butterfly', ButterflyB: 'butterfly', ButterflyC: 'butterfly',
    NPCBoard: 'boardnpc', NPCKinopio: 'kinopio', NPCKinojii: 'kinojii', NPCPeach: 'peach', Amenbo: 'amenbo', AmenboManager: 'amenbo', HamuKuri: 'hamukuri', Hamukuri: 'hamukuri',
    HaneHamuKuri: 'hanekuri', HaneHamuKuri2: 'hanekuri', DoroHaneKuri: 'hanekuri', KageMario: 'kagemario', Kazekun: 'kazekun', Manta: 'manta', FireWanwan: 'firewanwan', BossWanwan: 'bwanwan',
    BeeHive: 'beehive', Kugu: 'kug', Aminoko: 'aminoko', GateKeeper: 'gatekeeper', OrangeSeal: 'seal', BossPakkun: 'kbosspakkun', Gorogoro: 'gorogoro' };
const PREFERRED_FILES: Record<string, string> = { poihana: 'default.bmd', sambohead: 'sambohead.bmd', telesa: 'telesa.bmd', mamegesso: 'default.bmd', rikugesso: 'geso_model1.bmd',
    bgeso: 'bgeso_body.bmd', pakkun: 'pakun.bmd', kinopio: 'kinopio_body.bmd', kinojii: 'kinoji_body.bmd', peach: 'peach_model.bmd', beehive: 'bee_nest.bmd', firewanwan: 'wanwan.bmd',
    bwanwan: 'bwanwan_body.bmd', gatekeeper: 'gene_pakkun_model1.bmd', seal: 'gene_orange_model1.bmd' };
const NPC_BODIES: Record<string, [string, string]> = {};
for (const v of ['', 'A', 'B', 'C', 'D']) NPC_BODIES[`NPCMareM${v}`] = ['marem', 'marem.bmd'];
for (const v of ['', 'A', 'B']) NPC_BODIES[`NPCMareW${v}`] = ['marew', 'marew.bmd'];
NPC_BODIES.NPCRaccoonDog = ['raccoondog', 'tanuki.bmd']; NPC_BODIES.RaccoonDog = ['raccoondog', 'tanuki.bmd'];
const TYPE_FILES: Record<string, string> = { Yumbo: 'yumbo.bmd', HaneHamuKuri: 'hanekuri.bmd', HaneHamuKuri2: 'hanekuri.bmd', DoroHaneKuri: 'dorohane.bmd', MarioModokiTelesa: 'modoki.bmd',
    FishoidA: 'fisha.bmd', FishoidB: 'fishb.bmd', FishoidC: 'fishc.bmd', FishoidD: 'fishd.bmd', ButterflyA: 'butterflya.bmd', ButterflyB: 'butterflyb.bmd', ButterflyC: 'butterflyc.bmd' };
export const SHRINK_STEPS = 6;
export const CARRY_TYPES: Record<string, string> = { JumpBase: 'spring', ResetFruit: 'fruit', FruitBanana: 'fruit', FruitCoconut: 'fruit', FruitDurian: 'fruit', FruitPapaya: 'fruit', FruitPine: 'fruit' };
const PREFERRED: Record<string, string> = { cannon: 'default.bmd', bombhei: 'nejibomb_model1.bmd' };
export const ROLL_TYPES = new Set(['Umaibou', 'GetaGreen', 'GetaOrange', 'RollBlock', 'RollBlockR', 'RollBlockY', 'RollBlockB']);
export const RAIL_TYPES = new Set(['EXRollCube', 'RailBlock', 'RailBlockR', 'RailBlockY', 'RailBlockB']);
export const LIFT_TYPES = new Set(['NormalLift', 'EXKickBoard', 'Kamaboko', 'Uirou', 'Castella', 'Hikidashi', 'WoodBlock', 'YoshiBlock', 'RideCloud']);
export const OBJ_COLS: Record<string, { col: string; flags: number }[]> = MAPOBJ_COLS as any;

export function isSpine(payload: Bytes) {
    try {
        const [, p] = lstr(payload, 36);
        const [mgr] = lstr(payload, p + 4);
        const m = sjisStr(mgr);
        return m.includes('マネージャー') || m.includes('管理');
    } catch { return false; }
}

export function parseRails(ral: Bytes): Record<string, any[]> {
    const rails: Record<string, any[]> = {};
    let i = 0;
    while (i + 12 <= ral.length) {
        const n = u32(ral, i), no = u32(ral, i + 4), dO = u32(ral, i + 8);
        i += 12;
        if (n === 0) break;
        let e = no; while (ral[e]) e++;
        const name = asciiStr(ral.subarray(no, e));
        const nodes = [];
        for (let k = 0; k < n; k++) {
            const b = dO + k * 0x44;
            const x = s16(ral, b), y = s16(ral, b + 2), z = s16(ral, b + 4), cn = s16(ral, b + 6), fl = u32(ral, b + 8);
            const pi = u16(ral, b + 12), ya = u16(ral, b + 14), ro = u16(ral, b + 16), sp = u16(ral, b + 18);
            const con = Array.from({ length: 8 }, (_, q) => u16(ral, b + 0x14 + q * 2)).slice(0, Math.max(cn, 0));
            nodes.push([x, y, z, pi, ya, ro, sp, fl, con]);
        }
        rails[name] = nodes;
    }
    return rails;
}

const LIGHT_GROUPS: Record<string, string> = { プレイヤー: 'player', オブジェクト: 'object', 敵: 'enemy' };
const LIGHT_KINDS: Record<string, string> = { 太陽: 'sun', 太陽サブ: 'sub', 影: 'shade', 影サブ: 'shadeSub', 太陽スペキュラ: 'spec', 太陽アンビエント: 'amb', 影アンビエント: 'shadeAmb' };
export function stageLights(scene: Bytes) {
    const out: any = {};
    for (const o of parseScene(scene)) {
        if (o.type !== 'Light' && o.type !== 'AmbColor') continue;
        const m = /^(.+?)（(.+?)）/.exec(o.name || '');
        if (!m || !(m[2] in LIGHT_GROUPS) || !(m[1] in LIGHT_KINDS)) continue;
        const g = (out[LIGHT_GROUPS[m[2]]] = out[LIGHT_GROUPS[m[2]]] || {});
        const p = o.payload;
        if (o.type === 'AmbColor' && p.length >= 4) g[LIGHT_KINDS[m[1]]] = Array.from(p.subarray(0, 3));
        else if (o.type === 'Light' && p.length >= 16) g[LIGHT_KINDS[m[1]]] = { p: [0, 1, 2].map((k) => pyRound(f32(p, k * 4), 1)), c: Array.from(p.subarray(12, 15)) };
    }
    return out;
}

// ---------------------------------------------------------------- parameters (params.szs)
let paramsArc: Arc | null = null;
const globalPrm = new Map<string, Prm>();
export function setParamsArchive(a: Arc | null) { paramsArc = a; globalPrm.clear(); }
export function globalParams(name: string): Prm {
    if (!globalPrm.has(name)) {
        let v: Prm = {};
        try { if (paramsArc && paramsArc.has(name)) v = parsePrm(paramsArc.get(name)!); } catch { v = {}; }
        globalPrm.set(name, v);
    }
    return globalPrm.get(name)!;
}
const SPEED_KEYS = ['mMaxMarchSpeed', 'mSLMaxMarchSpeed', 'mMarchSpeed', 'mSLMoveSpeed', 'mSLWalkSpeed'];
const DEFAULT_SPEED: Record<string, number> = { AnimalBird: 5.0, AnimalMew: 10.0, Butterfly: 2.0, ButterflyB: 2.0, ButterflyC: 2.0, FishoidA: 2.0, FishoidB: 2.0, FishoidC: 2.0, FishoidD: 2.0 };
export const NPC_ORDER = ['NPCMonteM', 'NPCMonteMA', 'NPCMonteMB', 'NPCMonteMC', 'NPCMonteMD', 'NPCMonteME', 'NPCMonteMF', 'NPCMonteMG', 'NPCMonteMH', 'NPCMonteW', 'NPCMonteWA',
    'NPCMonteWB', 'NPCMonteWC', 'NPCMareM', 'NPCMareMA', 'NPCMareMB', 'NPCMareMC', 'NPCMareMD', 'NPCMareW', 'NPCMareWA', 'NPCMareWB', 'NPCKinopio', 'NPCKinojii', 'NPCPeach',
    'NPCRaccoonDog', 'NPCSunflowerL', 'NPCSunflowerS'];
const NPC_PRM = [...new Array(5).fill('MonteM'), 'MonteME', 'MonteMF', 'MonteMG', 'MonteMH', ...new Array(3).fill('MonteW'), 'MonteWC', 'MareM', 'MareMA', 'MareMB', 'MareMC', 'MareMD',
    'MareW', 'MareWA', 'MareWB', 'Kinopio', 'Kinojii', 'Peach', 'RaccoonDog', 'SunflowerL', 'SunflowerS'];
const npcPrm = (typ: string): Prm => (NPC_ORDER.includes(typ) ? globalParams(`npc/npc${NPC_PRM[NPC_ORDER.indexOf(typ)].toLowerCase()}.prm`) : {});
function walkAnimRate(typ: string) {
    if (NPC_ORDER.includes(typ)) { const p = npcPrm(typ), r = p.mSLMaxWalkAnmRate; return pyRound(2.0 * (isFloat(p, 'mSLMaxWalkAnmRate') && r > 0 ? r : 1.5), 3); }
    return 2.0;
}
const FIXED_SPEED: Record<string, number> = { FishoidA: 4.0, FishoidB: 4.0, FishoidC: 4.0, FishoidD: 4.0, Butterfly: 6.0, ButterflyB: 6.0, ButterflyC: 6.0 };
export function enemyParams(arc: Arc, typ: string): Prm | null {
    const names = [...new Set([typ.toLowerCase(), (TYPE_FOLDERS[typ] || '').toLowerCase()])];
    for (const n of names) {
        const raw = n ? arc.get(`map/params/enemy/${n}.prm`) : null;
        if (raw) { try { return parsePrm(raw); } catch { return null; } }
    }
    return null;
}
function walkSpeed(arc: Arc, typ: string) {
    if (typ in FIXED_SPEED) return FIXED_SPEED[typ];
    if (typ === 'AnimalMew') { const p = globalParams('animal/mew.prm'); return pyRound(2.0 * (isFloat(p, 'mSLMaxMarchSpeed') ? p.mSLMaxMarchSpeed : 6.0), 3); }
    if (typ === 'AnimalBird') { const p = globalParams('animal/bird.prm'); return pyRound(2.0 * (isFloat(p, 'mMarchSpeed') ? p.mMarchSpeed : 5.0), 3); }
    if (NPC_ORDER.includes(typ)) { const p = npcPrm(typ), v = p.mMaxMarchSpeed; return pyRound(isFloat(p, 'mMaxMarchSpeed') && v > 0 ? v : 3.0, 3); }
    for (const n of [typ.toLowerCase(), (TYPE_FOLDERS[typ] || '').toLowerCase()]) {
        if (!n) continue;
        for (const path of [`npc/${n}.prm`, `enemy/${n}.prm`, `animal/${n}.prm`]) {
            let p: Prm | null = path.startsWith('enemy/') ? enemyParams(arc, typ) : null;
            if (!p || !Object.keys(p).length) p = globalParams(path);
            if (!p || !Object.keys(p).length) continue;
            if ('mSLMarchSpeedLow' in p && 'mSLMarchSpeedHigh' in p) return pyRound((p.mSLMarchSpeedLow + p.mSLMarchSpeedHigh) / 2, 3);
            for (const k of SPEED_KEYS) if (isFloat(p, k) && p[k] >= 0.3) return pyRound(p[k], 3);
        }
    }
    return DEFAULT_SPEED[typ] ?? 1.5;
}
export function walkExtra(typ: string, payload: Bytes, rails: Record<string, any[]>, arc: Arc) {
    let name: string;
    try { name = asciiStr(lstr(payload, actorTail(payload))[0]); } catch { return null; }
    if (!(name in rails) || rails[name].length < 2) return null;
    return { walk: name, v: walkSpeed(arc, typ), ar: walkAnimRate(typ) };
}

export const SPIN_TYPES: Record<string, [number, number]> = { BigWindmill: [2, -0.05], BiaWatermill: [2, -0.3], Merrygoround: [1, 0.1] };
const WATERMILL_BRIDGE_RATE = 0.03;
export function moveExtra(typ: string, payload: Bytes, rails: Record<string, any[]>, name = '', spinRates: Record<string, number> | null = null): any {
    try {
        if (typ in SPIN_TYPES) { const [ax, rate] = SPIN_TYPES[typ]; return { spin: { ax, rate } }; }
        if (typ === 'BiaWatermillVertical') return { spin: { ax: 1, rate: pyRound(watermillVerticalRate(payload), 5) } };
        if (typ === 'BiaTurnBridge' && spinRates) {
            const parts = name ? name.trim().split(/\s+/) : ['0'];
            const rate = (spinRates[name ? parts[parts.length - 1] : '0'] ?? 0.0) * WATERMILL_BRIDGE_RATE;
            return rate ? { spin: { ax: 1, rate: pyRound(rate, 5) } } : null;
        }
        if (typ === 'CraneRotY') { const p = actorTail(payload); if (p + 4 > payload.length) throw new RangeError(); return { osc: { ax: 1, lo: 0.0, hi: pyRound(f32(payload, p), 3), sp: 0.1, wait: 120, start: 'lo' } }; }
        if (typ === 'craneUpDown') return { osc: { ax: 0, lo: -25.0, hi: name.endsWith(' 0') ? 45.0 : 30.0, sp: 0.1, wait: 120, abs: 1, start: 'mid' } };
        if (ROLL_TYPES.has(typ)) { const p = actorTail(payload); if (p + 4 > payload.length) throw new RangeError(); return { roll: s32(payload, p) * 0.01 }; }
        if (RAIL_TYPES.has(typ) || LIFT_TYPES.has(typ)) {
            const rn = asciiStr(lstr(payload, actorTail(payload))[0]);
            if (typ === 'NormalLift' && rn.startsWith('S_') && rn in rails) return starSpin(rails[rn]);
            if (typ === 'RideCloud' && (!(rn in rails) || rn.startsWith('S_'))) return { lift: [], cloud: 1 };
            if (rn in rails && !rn.startsWith('S_')) {
                const ex: any = { [LIFT_TYPES.has(typ) ? 'lift' : 'rail']: rails[rn] };
                if (typ === 'RideCloud') ex.cloud = 1;
                return ex;
            }
        }
    } catch { /* struct.error */ }
    return null;
}
function starSpin(nodes: any[]) {
    if (nodes.length < 3 || nodes.some((n) => n[8].length !== 2)) return null;
    const cx = nodes.reduce((s, n) => s + n[0], 0) / nodes.length, cz = nodes.reduce((s, n) => s + n[2], 0) / nodes.length;
    let loop = 0;
    nodes.forEach((n, k) => { const m = nodes[(k + 1) % nodes.length]; loop += Math.hypot(m[0] - n[0], m[2] - n[2]); });
    const spd = (nodes[0][4] !== 0xffff ? nodes[0][4] : 100) * 0.01;
    const a = nodes[0], b = nodes[1];
    const turn = (a[2] - cz) * (b[0] - cx) - (a[0] - cx) * (b[2] - cz);
    const rate = loop ? (360.0 * spd) / loop : 0.0;
    return rate ? { spin: { ax: 1, rate: pyRound(turn > 0 ? rate : -rate, 5) } } : null;
}
export function watermillVerticalRate(payload: Bytes) {
    const p = actorTail(payload);
    if (p + 4 > payload.length) throw new RangeError();
    let f = f32(payload, p);
    if (!(Math.abs(f) < 1e6) || (f !== 0 && Math.abs(f) < 1e-6)) f = s32(payload, p);
    return f / 1000.0;
}

const f32be = (...v: number[]) => { const b = new Uint8Array(v.length * 4), d = new DataView(b.buffer); v.forEach((x, i) => d.setFloat32(i * 4, x)); return b; };
const keyBytes = (key: string) => { const kb = enc(key); return cat(new Uint8Array([0, 0, kb.length >> 8, kb.length & 255]), kb); };
export function windmillBlocks(objs: SceneObj[]): SceneObj[] {
    const out: SceneObj[] = [];
    for (const o of objs) {
        if (o.type !== 'BigWindmill') continue;
        const pl = placement(o.payload);
        if (!pl) continue;
        const [[px, py, pz], [, , rz]] = pl;
        for (let i = 0; i < 4; i++) {
            const a = rz + 90 * i;
            const p = [px + 2380 * Math.cos(rad(a)), py + 2380 * Math.sin(rad(a)), pz - 150];
            out.push({ type: 'MapObjBase', name: '', hash: 0, path: [], ptypes: [], orbit: { c: [px, py, pz], r: 2380, sub: 150, a, rate: -0.05 },
                payload: cat(f32be(...p, 0, 0, 0, 1, 1, 1), keyBytes('bigWindmillBlock')) });
        }
    }
    return out;
}
export const DYNAMIC_CARRY: Record<number, [string, string, string]> = { 0x1000001e: ['bombhei/nejibomb_model1.bmd', 'bomb', 'bombhei'] };
export const DYNAMIC_SPRAYED: Record<number, [string, string]> = { 0x1000001e: ['Q_nejibomb_s3tc', 'Q_stop_nejibomb_s3tc'] };
const POLLUTION_NPCS = new Set(['NPCMonteM', 'NPCMonteMA', 'NPCMonteMC', 'NPCMonteW', 'NPCMonteWA', 'NPCMareM', 'NPCMareW', 'NPCKinopio']);
const SPECIAL_NPCS = new Set(['NPCMonteMF', 'NPCMonteMG', 'NPCMonteMH', 'NPCMonteWC', 'NPCMareMA', 'NPCMareMB', 'NPCMareMC', 'NPCMareMD', 'NPCMareWA', 'NPCMareWB']);
export const PICTURE_TYPES = new Set(['WaterHitPictureHideObj', 'HideObjPictureTwin', 'PictureTeresa']);
export const PICTURE_START: Record<string, number> = { ChipShine: 32, star_sign: 30, PictureTeresa: 0 };

export function btiRgba(tex: Bytes) {
    const fmt = tex[0], w = u16(tex, 2), h = u16(tex, 4), palFmt = tex[9], palCnt = u16(tex, 10), palOff = u32(tex, 12), doff = u32(tex, 0x1c);
    return gxDecode(tex.subarray(doff), fmt, w, h, palOff ? tex.subarray(palOff, palOff + palCnt * 2) : null, palFmt);
}

function npcColour(cc: any, idx: number | null) {
    if (!cc || idx === null || idx === undefined || idx < 0) return null;
    const b0 = cc.c0, b1 = cc.c1;
    const pick = (b: any) => (b && idx < b.length ? b[idx].map((v: number) => Math.max(0, Math.min(510, v))) : null);
    const rawPick = (b: any) => (b && idx < b.length ? b[idx].map((v: number) => Math.max(-1024, Math.min(1023, v))) : null);
    const c0 = pick(b0), c1 = pick(b1);
    const raw = [cc.kind, rawPick(b0), rawPick(b1)];
    if (cc.kind === 2 && c0 && c1) return [cc.mat, 'grad', c0, c1, ...raw];
    const c = c0 || c1;
    return c ? [cc.mat, 'mul', c, null, ...raw] : null;
}
const colMajor4 = (m: bmd.M4) => { const o = []; for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o.push(pyRound(m[r * 4 + c], 4)); return o; };
export function npcExtra(ctx: LibCtx, arc: Arc, typ: string, payload: Bytes, body: bmd.Model) {
    if (!NPC_ORDER.includes(typ)) return null;
    const info = (NPC_INIT as any)[NPC_ORDER.indexOf(typ)];
    const f = npcFields(payload);
    if (!f) return null;
    const mats = [0, 1].map((j) => npcColour(info.body[j], f.c0[j])).filter((c) => c);
    let k0: number[] | null = null;
    if (POLLUTION_NPCS.has(typ) || SPECIAL_NPCS.has(typ)) {
        const amount = POLLUTION_NPCS.has(typ) ? Math.max(0, f.c0[2]) / 255 : 0;
        k0 = [255, 255, 255, Math.trunc(amount * 150) & 0xff];
    }
    const lower = new Map<string, string>();
    for (const k of arc.keys()) if (k.toLowerCase().endsWith('.bmd')) { const s = k.toLowerCase().split('/'); lower.set(s[s.length - 1], k); }
    const parts: any[] = [];
    (info.parts as any[]).forEach((part, i) => {
        if (!part || !((f.parts >> i) & 1)) return;
        const path = lower.get(part.file.toLowerCase());
        if (!path) return;
        const idx = part.slot < 3 ? f.c1[part.slot] : null;
        const pc = (part.colors as any[]).map((cc) => npcColour(cc, idx)).filter((c) => c);
        let mtx = bmd.eye4(), ji = 0;
        if (!(part.joint === '__ROOT_JOINT__' || !body.jointNames.includes(part.joint))) { ji = body.jointNames.indexOf(part.joint); mtx = body.jointsWorld[ji]; }
        const pi = libAdd(ctx, 'part:' + digest(arc.get(path)!), () => [bmd.parse(arc.get(path)!)], { f: path });
        if (pi >= 0) parts.push([pi, colMajor4(mtx), pc, ji]);
    });
    if (!mats.length && !parts.length && !k0) return null;
    const out: any = { mats, parts };
    if (k0) out.k0 = k0;
    return { npc: out };
}
export function bodyScale(arc: Arc, typ: string) {
    const p = enemyParams(arc, typ);
    if (p && 'mSLBodyScaleLow' in p && 'mSLBodyScaleHigh' in p) return pyRound((p.mSLBodyScaleLow + p.mSLBodyScaleHigh) / 2, 4);
    return null;
}
const xf = (m: bmd.M4) => Array.from(m.subarray(0, 12)).map((v) => pyRound(v, 4));
export function transformed(model: bmd.Model, mtx: bmd.M4) {
    for (const mesh of model.meshes) {
        const p = mesh.pos, o = new Float32Array(p.length);
        for (let i = 0; i < p.length; i += 3) for (let r = 0; r < 3; r++) o[i + r] = p[i] * mtx[r * 4] + p[i + 1] * mtx[r * 4 + 1] + p[i + 2] * mtx[r * 4 + 2] + mtx[r * 4 + 3];
        mesh.pos = o;
    }
    return model;
}
export function cannonParts(arc: Arc): [bmd.Model[], bmd.Model | null, number[]] {
    const body = bmd.parse(arc.get('cannon/default.bmd')!);
    const parts = [body];
    if (arc.has('cannon/cannon_dom.bmd')) for (const jn of ['nullA', 'nullB', 'nullC']) if (body.jointNames.includes(jn)) parts.push(transformed(bmd.parse(arc.get('cannon/cannon_dom.bmd')!), body.jointsWorld[body.jointNames.indexOf(jn)]));
    let mole: bmd.Model | null = null;
    if (arc.has('cannon/tyorobe_model1.bmd')) {
        const raw = bmd.parse(arc.get('cannon/tyorobe_model1.bmd')!, { decodeTextures: false });
        let pose = null;
        if (arc.has('cannon/tyorobe_wait1_loop.bck')) { const anim = parseBck(arc.get('cannon/tyorobe_wait1_loop.bck')!); if (anim.j.length === raw.jointNames.length) pose = bckPose(anim, 0); }
        const lift = bmd.eye4(); lift[7] = 300.0;
        mole = transformed(bmd.parse(arc.get('cannon/tyorobe_model1.bmd')!, { pose }), lift);
    }
    return [parts, mole, [0.0, 150.0, 0.0]];
}
export function corkTrack(arc: Arc, step = 2) {
    if (!arc.has('mapobj/marecork.bck')) return null;
    const anim = parseBck(arc.get('mapobj/marecork.bck')!);
    const rest = bmd.parse(arc.get('mapobj/marecork.bmd')!, { decodeTextures: false });
    const inv1 = bmd.inv4(rest.jointsWorld[1]), inv2 = bmd.inv4(rest.jointsWorld[2]);
    const cork = [], carry = [];
    for (let f = 0; f <= Math.trunc(anim.d); f += step) {
        const m = bmd.parse(arc.get('mapobj/marecork.bmd')!, { decodeTextures: false, pose: bckPose(anim, f) });
        cork.push(xf(bmd.mul4(m.jointsWorld[1], inv1))); carry.push(xf(bmd.mul4(m.jointsWorld[2], inv2)));
    }
    return { step, cork, carry, shineFrame: 250 };
}
const ASCII_KEY = /^[\w.\- ]+$/;
export function asciiKeys(payload: Bytes) { return stringsAfter(payload).filter((s) => /^[\x00-\x7f]*$/.test(s) && ASCII_KEY.test(s)); }
function folderFiles(arc: Arc, f: string) {
    return sortedKeys(arc).filter((k) => { const l = k.toLowerCase(); return l.startsWith(f + '/') && (l.endsWith('.bmd') || l.endsWith('.bdl')) && k.split('/').length === 2; });
}
export const MAT_TABLES: Record<string, [string, boolean]> = { ACTOR_TYPE_WOOD_BARREL: ['barrel.bmt', false], ACTOR_TYPE_WOOD_BOX: ['kibako.bmt', false],
    ACTOR_TYPE_ARROW_BOARD_LR: ['arrowboard.bmt', false], ACTOR_TYPE_BRICK_BLOCK: ['brickblock.bmt', false], ACTOR_TYPE_WATER_MELON_BLOCK: ['watermelonblock.bmt', false],
    ACTOR_TYPE_FLOWER_ORANGE: ['flower.bmt', false], ACTOR_TYPE_RICCO_SHIP: ['riccoship.bmt', false], ACTOR_TYPE_LEAF_BOAT: ['leafboat.bmt', false],
    ACTOR_TYPE_LEAF_BOAT_ROTTEN: ['leafboat.bmt', false], ACTOR_TYPE_MIRROR_L: ['mirror.bmt', false], ACTOR_TYPE_SAND_LEAF_BASE00: ['sandbombbase.bmt', false],
    ACTOR_TYPE_SAND_BOMB_BASE00: ['sandbombbase.bmt', false], ACTOR_TYPE_SAND_BOMB_BASE_FOOT: ['sandbombbase.bmt', false], ACTOR_TYPE_SAND_CASTLE: ['sandbombbase.bmt', true],
    ACTOR_TYPE_NORMAL_NOZZLE_ITEM: ['nozzleitem.bmt', false], ACTOR_TYPE_BACK_NOZZLE_ITEM: ['nozzleitem.bmt', false], ACTOR_TYPE_WATERGUN_ITEM: ['nozzleitem.bmt', false],
    ACTOR_TYPE_ROCKET_NOZZLE_ITEM: ['nozzleitem.bmt', false], ACTOR_TYPE_NOZZLE_BOX: ['nozzlebox.bmt', true] };
for (const a of ['BIG_WINDMILL_BLOCK', 'BIG_WINDMILL', 'BIA_WATERMILL01', 'BIA_TURN_BRIDGE', 'BIA_BELL', 'BIA_WATERMILL00', 'BIA_WATERMILL_VERTICAL', 'LAMP_BIANCO', 'BIA_DOOR', 'MINI_WINDMILL_L'])
    MAT_TABLES['ACTOR_TYPE_' + a] = ['bianco.bmt', false];
export function matTable(arc: Arc, keys: string[] | null, table: any): [Bytes | null, boolean] {
    const lower = lowerMap(arc);
    for (const key of keys || []) {
        const ent = MAT_TABLES[(table[key] || {}).actor];
        if (ent && lower.has('mapobj/' + ent[0])) return [arc.get(lower.get('mapobj/' + ent[0])!)!, ent[1]];
    }
    return [null, false];
}
const MONTE_BOARDS = [[0, -130, 11965, 30], [0, -275, 12225, 29], [0, -415, 12490, 28], [0, -540, 12760, 26], [0, -660, 13035, 24], [0, -770, 13315, 22], [0, -875, 13595, 20],
    [0, -960, 13895, 12], [0, -1020, 14190, 8], [0, -1060, 14490, 4], [0, -1090, 14790, 2], [0, -1090, 15090, 0], [0, -1080, 15395, -4], [0, -1040, 15695, -6], [0, -995, 15990, -8],
    [0, -945, 16285, -8], [0, -900, 16580, -8], [0, -855, 16880, -8], [0, -800, 17175, -10]];
export function bridgeBoards(scene: string, objs: SceneObj[]): SceneObj[] {
    if (!objs.some((o) => o.type === 'HangingBridge')) return [];
    let key: string, boards: [number[], number[]][];
    if (scene.startsWith('monte')) { key = 'HangingBridgeBoard'; boards = MONTE_BOARDS.map(([x, y, z, rx]) => [[x, y, z], [rx, 0, 0]]); }
    else if (scene.startsWith('pinnaParco')) {
        const a = [1550, 2980, -9410], b = [3570, 2455, -9410], n = 14;
        key = 'PinnaHangingBridgeBoard';
        boards = Array.from({ length: n }, (_, i) => [[0, 1, 2].map((k) => a[k] + ((b[k] - a[k]) * i) / (n - 1)), [15, 90, 0]]);
    } else return [];
    return boards.map(([p, r]) => ({ type: 'MapObjBase', name: '', hash: 0, path: [], ptypes: [], payload: cat(f32be(...p, ...r, 1, 1, 1), keyBytes(key)) }));
}
export async function bridgeRopes(arc: Arc, scene: string, objs: SceneObj[], pngDataUri: (img: any) => Promise<string>) {
    if (!objs.some((o) => o.type === 'HangingBridge')) return null;
    let n: number, a: number[], b: number[], height: number, half: number, boards: [number[], number][];
    if (scene.startsWith('monte')) { n = 19; a = [0, 0, 11356]; b = [0, -750, 17743]; height = 1000.0; half = 315.0; boards = MONTE_BOARDS.map(([x, y, z]) => [[x, y, z], 0.0]); }
    else if (scene.startsWith('pinnaParco')) {
        n = 14; a = [1550, 2980, -9410]; b = [3570, 2455, -9410]; height = 200.0; half = 150.0;
        const A = a, B = b;
        boards = Array.from({ length: n }, (_, i) => [[0, 1, 2].map((k) => A[k] + ((B[k] - A[k]) * i) / (n - 1)), 90.0]);
        a = [1350, 2980, -9410]; b = [3650, 2455, -9410];
    } else return null;
    void n;
    const lower = lowerMap(arc);
    const tex = arc.get(lower.get('mapobj/mon_bri_rope.bti') || '');
    const tris: number[] = [], uvs: number[] = [];
    const strip = (verts: [number[], number[]][]) => {
        for (let i = 0; i < verts.length - 2; i++) for (const [p, t] of verts.slice(i, i + 3)) { tris.push(...p.map((c) => pyRound(c, 2))); uvs.push(pyRound(t[0], 4), pyRound(t[1], 4)); }
    };
    const anchors: [number[], number[]][] = [];
    for (const [[x, y, z], ry] of boards) {
        const ax = Math.cos(rad(ry)), az = -Math.sin(rad(ry));
        anchors.push([[x - ax * half, y + 70, z - az * half], [x + ax * half, y + 70, z + az * half]]);
    }
    for (const pair of anchors) for (const [x, y, z] of pair) {
        const top = y + height, wx = 10.0, wz = 7.0;
        const pts: [number[], number][] = [[[x, top, z + wz], 0], [[x, y, z + wz], 0], [[x - wx, top, z - wz], 1], [[x - wx, y, z - wz], 1],
            [[x + wx, top, z - wz], 2], [[x + wx, y, z - wz], 2], [[x, top, z + wz], 3], [[x, y, z + wz], 3]];
        strip(pts.map(([p, s]) => [p, [s, 0.01 * (p[1] - y)]]));
    }
    const dx = b[0] - a[0], dz = b[2] - a[2], ln = Math.hypot(dx, dz);
    const px = -dz / ln, pz = dx / ln, wx = px * 10.0, wz = pz * 10.0;
    const sag = Array.from({ length: 10 }, (_, i) => 50.0 * Math.sin((3.14 * i) / 10));
    for (const [lift, count] of [[0.0, 10], [height, 1]]) for (const [side, sign] of [[0, 1], [1, -1]]) {
        const ends = [[a[0] + sign * px * half, a[1] + lift, a[2] + sign * pz * half], [b[0] + sign * px * half, b[1] + lift, b[2] + sign * pz * half]];
        const path = [ends[0], ...anchors.map((pr) => pr[side]).map((q) => [q[0], q[1] + lift, q[2]]), ends[1], ends[1]];
        for (const kind of ['minus', 'plus', 'upper']) {
            const verts: [number[], number[]][] = [];
            for (let s = 0; s + 1 < path.length; s++) {
                const p0 = path[s], p1 = path[s + 1];
                for (let i = 0; i < count; i++) {
                    const f = i / count;
                    const [x, y, z] = [0, 1, 2].map((k) => p0[k] + (p1[k] - p0[k]) * f);
                    const h = y - sag[i], t = 0.01 * (x + z);
                    if (kind === 'minus') verts.push([[x - wx, h, z - wz], [0, t]], [[x, h - 10, z], [1, t]]);
                    else if (kind === 'plus') verts.push([[x, h - 10, z], [0, t]], [[x + wx, h, z + wz], [1, t]]);
                    else verts.push([[x + wx, h, z + wz], [0, t]], [[x - wx, h, z - wz], [1, t]]);
                }
            }
            strip(verts);
        }
    }
    const out: any = { pos: tris, uv: uvs };
    if (tex) out.tex = await pngDataUri(btiRgba(tex));
    return out;
}

export function findModel(arc: Arc, typ: string, keys: string[] | string | null, table: any): string | null {
    const ks = typeof keys === 'string' || keys === null ? (keys ? [keys] : []) : keys;
    const lower = lowerMap(arc);
    for (const key of ks) {
        const cands: string[] = [];
        if (table[key] && table[key].bmd && table[key].bmd.length) cands.push('mapobj/' + table[key].bmd[0].toLowerCase());
        cands.push(`mapobj/${key.toLowerCase()}.bmd`);
        for (const c of cands) if (lower.has(c)) return lower.get(c)!;
    }
    if (typ in NPC_BODIES) { const [f, fn] = NPC_BODIES[typ]; if (lower.has(`${f}/${fn}`)) return lower.get(`${f}/${fn}`)!; }
    const base = typ.toLowerCase().replace(/^(npc|animal|enemy)/, '');
    const folders = [(TYPE_FOLDERS[typ] || '').toLowerCase(), typ.toLowerCase(), base];
    for (let n = base.length - 1; n > 3; n--) folders.push(base.slice(0, n));
    for (const f of folders) {
        if (!f || f === 'mapobj') continue;
        const files = folderFiles(arc, f);
        if (!files.length) continue;
        const names = files.map((k) => k.toLowerCase());
        for (const want of [TYPE_FILES[typ], PREFERRED_FILES[f], PREFERRED[f], `${f}.bmd`]) if (want && names.includes(`${f}/${want}`)) return files[names.indexOf(`${f}/${want}`)];
        for (const word of ['model1', '_model', 'default', 'set', 'body']) { const hit = files.filter((k) => k.toLowerCase().includes(word)); if (hit.length) return hit[0]; }
        return files.reduce((m, k) => (k.length < m.length ? k : m), files[0]);
    }
    return null;
}

export function wires(arc: Arc) {
    const out: number[][] = [];
    if (!arc.has('map/tables.bin')) return out;
    for (const o of parseScene(arc.get('map/tables.bin')!)) {
        if (o.type !== 'CubeGeneralInfo' || !o.path.length || !o.path[o.path.length - 1].includes('ワイヤー')) continue;
        const pl = placement(o.payload);
        if (!pl) continue;
        const [[cx, cy, cz], [rx, ry, rz], [, sy, sz]] = pl;
        const length = sz * 100.0, lift = sy * 100.0;
        const r = bmd.eulerMatrix(rad(rx), rad(ry), rad(rz));
        const hz0 = length * 0.5;
        const hx = r[2] * hz0, hy = r[5] * hz0, hz = r[8] * hz0;
        out.push([pyRound(cx - hx, 1), pyRound(cy - hy + lift, 1), pyRound(cz - hz, 1), pyRound(cx + hx, 1), pyRound(cy + hy + lift, 1), pyRound(cz + hz, 1)]);
    }
    return out;
}
export function cameraTools(arc: Arc) {
    const out: any = {};
    if (!arc.has('map/tables.bin')) return out;
    for (const o of parseScene(arc.get('map/tables.bin')!)) {
        if (o.type !== 'CameraMapInfo' || o.payload.length < 36) continue;
        const p = o.payload;
        const x = f32(p, 0), y = f32(p, 4), z = f32(p, 8), pitch = f32(p, 12), yaw = f32(p, 16), mode = s32(p, 24), flags = s32(p, 28), length = u32(p, 32);
        out[o.name] = [length, mode, pyRound(x, 1), pyRound(y, 1), pyRound(z, 1), pyRound(pitch, 2), pyRound(yaw, 2), Math.max(flags, 0)];
    }
    return out;
}
export function cameraBcks(arc: Arc) {
    const out: any = {};
    for (const k of sortedKeys(arc)) { const m = /^map\/camera\/(.+)\.bck$/.exec(k); if (m && m[1] !== 'startcamera') out[m[1]] = parseBck(arc.get(k)!); }
    return out;
}
export const nameKey = (name: string) => calcKeyCode(name);

const BOSS_SHINE = 'シャイン（ボス用）', BOSS_CAM = 'ボスシャインカメラ';
const CODE_SHINES: Record<string, [string, string, string, number]> = {
    MareCork: [BOSS_SHINE, BOSS_CAM, 'at', 0], BossPakkun: [BOSS_SHINE, BOSS_CAM, 'mario', 0], BossTelesa: [BOSS_SHINE, BOSS_CAM, 'at', 0],
    BossEel: [BOSS_SHINE, 'めおとウナギシャインカメラ', 'at', 0], BossHanachan: [BOSS_SHINE, BOSS_CAM, 'mario', 0], FireWanwan: [BOSS_SHINE, BOSS_CAM, 'near', 500],
    BellDolpicPolice: ['シャイン（ドルピック鐘警察署用）', 'ドルピック鐘警察署カメラ', 'at', 0], BellDolpicTV: ['シャイン（ドルピック鐘テレビ局用）', 'ドルピック鐘テレビ局カメラ', 'at', 0],
    MonumentShine: ['シャイン（モニュメントシャイン用）', 'モニュメントシャインカメラ', 'at', 0], AirportEventSink: ['シャイン（落書き用）', '落書きシャインカメラ', 'self', 0],
    NPCSunflowerL: ['ひまわり用シャイン', 'ひまわりシャインカメラ', 'near', 500], NPCSunflowerS: ['ひまわり用シャイン', 'ひまわりシャインカメラ', 'near', 500],
    AmiKing: ['シャイン（観覧車シャイン用）', '観覧車シャインカメラ', 'near', 0], WaterMelon: ['シャイン（お化けスイカ用）', 'スイカシャインカメラ', 'self', 0],
    AnimalBird: ['シャイン（鳥用）', '鳥シャインカメラ', 'near', 0],
};
const jsonEq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
export function shineSources(arc: Arc, objs: SceneObj[]) {
    const shines = new Set(objs.filter((o) => o.type === 'Shine').map((o) => o.name));
    const out: any[] = [];
    const add = (shine: string, cam: string | null = null, kw: any = {}) => {
        if (!shines.has(shine)) return;
        const ev: any = { s: nameKey(shine), ...(cam ? { cam } : {}), ...kw };
        const noAt = (e: any) => { const c = { ...e }; delete c.at; return c; };
        for (const e of out) if ('at' in e && 'at' in ev && jsonEq(noAt(e), noAt(ev))) { e.at.push(...ev.at.filter((p: any) => !e.at.some((q: any) => jsonEq(q, p)))); return; }
        if (!out.some((e) => jsonEq(e, ev))) out.push(ev);
    };
    const pos = (o: SceneObj, dy = 0.0) => { const pl = placement(o.payload); return pl ? [pyRound(pl[0][0], 1), pyRound(pl[0][1] + dy, 1), pyRound(pl[0][2], 1)] : null; };
    const isStr = (a: any) => typeof a === 'string', isInt = (a: any) => typeof a === 'number';
    for (const k of sortedKeys(arc)) {
        if (!/^map\/sp\/.+\.sb$/.test(k)) continue;
        for (const [name, args] of builtinCalls(arc.get(k)!)) {
            if (name === 'appearShine' && args.length === 2 && isStr(args[0]) && isStr(args[1])) add(args[0] as string, args[1] as string);
            else if (name === 'appearShineFromNPC' && args.length === 3 && isStr(args[0]) && isStr(args[2])) add(args[0] as string, args[2] as string, { npc: isStr(args[1]) ? nameKey(args[1] as string) : 0 });
            else if (name === 'appearShineFromKageMario' && args.length === 3 && isStr(args[0])) add(args[0] as string, null, { simple: isInt(args[2]) ? args[2] : 360 });
            else if (name === 'appearShineFromNPCWithoutDemo' && args.length && isStr(args[0])) add(args[0] as string, null, { onMario: 1, at: objs.filter((o) => o.name.startsWith('マニ屋')).map((o) => pos(o)).filter((p) => p) });
            else if (name === 'appearShineForWoodBox') for (const n of ['木箱ゲーム用シャイン１', '木箱ゲーム用シャイン２']) add(n, '木箱ゲーム用シャインカメラ', { at: [[-4010.0, 9850.0, -4040.0]] });
        }
    }
    for (const o of objs) {
        const pl = o.payload;
        if ([16, 28].some((off) => pl.length >= off && s32(pl, pl.length - off) === 777)) { const p = pos(o); if (p) add(`シャイン（${o.name}）`, `シャイン（${o.name}）カメラ`, { at: [p] }); }
    }
    const byType = new Map<string, SceneObj[]>();
    for (const o of objs) { if (!byType.has(o.type)) byType.set(o.type, []); byType.get(o.type)!.push(o); }
    for (const [typ, [shine, cam, how, dy]] of Object.entries(CODE_SHINES)) {
        if (!byType.has(typ)) continue;
        if (how === 'self') add(shine, cam);
        else if (how === 'mario') add(shine, cam, { mario: 1, ...(dy ? { dy } : {}) });
        else { const ps = byType.get(typ)!.map((o) => pos(o, dy)).filter((p) => p); if (ps.length) add(shine, cam, { at: how === 'near' ? ps : ps.slice(0, 1) }); }
    }
    if (byType.has('SleepBossHanachan') && byType.has('ShiningStone')) add(BOSS_SHINE, BOSS_CAM, { at: [pos(byType.get('ShiningStone')![0], 1100.0)] });
    if (byType.has('MapEventSirenaSink')) add('シャイン（ホテル上げ用）', 'ホテル上げシャインカメラ', { at: [[0.0, 3300.0, -2570.0]] });
    add('シャイン（１００枚コイン用）', 'シャイン（１００枚コイン用）カメラ', { mario: 1 });
    for (const o of objs) if (o.type === 'Shine') { try { if (asciiStr(lstr(o.payload, actorTail(o.payload))[0]) === 'quickly') add(o.name, 'シャイン（いきなり出現）カメラ'); } catch { /* */ } }
    return out;
}

export function idlePose(arc: Arc, modelPath: string, model: bmd.Model) {
    const folder = modelPath.slice(0, modelPath.lastIndexOf('/'));
    for (const k of sortedKeys(arc)) {
        if (k.startsWith(folder + '/') && k.endsWith('.bck') && k.toLowerCase().includes('wait')) {
            let anim; try { anim = parseBck(arc.get(k)!); } catch { continue; }
            if (anim.j.length === model.jointNames.length) return bckPose(anim, 0);
        }
    }
    return null;
}
export function waitBck(arc: Arc, modelPath: string, model: bmd.Model) {
    const folder = modelPath.slice(0, modelPath.lastIndexOf('/'));
    for (const k of sortedKeys(arc)) if (k.startsWith(folder + '/') && k.endsWith('.bck') && k.toLowerCase().includes('wait')) {
        try { if (parseBck(arc.get(k)!).j.length === model.jointNames.length) return k; } catch { continue; }
    }
    return null;
}
export const WALK_ANIM_WORDS = ['walk', 'fly', 'swim', 'run', 'move', 'march', 'swing', 'wait'];
export const IDLE_ANIM_WORDS = ['wait', 'idle', 'stand', 'taiki', 'walk', 'fly', 'swim', 'swing'];
export function walkAnim(arc: Arc, modelPath: string, model: bmd.Model, words: string[] | null = null) {
    const folder = modelPath.slice(0, modelPath.lastIndexOf('/'));
    const folders = [folder, folder + 'anm', folder + 'common', folder.slice(0, -1) + 'common', folder.slice(0, -2) + 'common'];
    const keys = sortedKeys(arc);
    const cands: string[] = [];
    for (const f of folders) for (const k of keys) if (k.startsWith(f + '/') && k.split('/').length === 2 && k.endsWith('.bck')) cands.push(k);
    for (const word of words || WALK_ANIM_WORDS) for (const k of cands) {
        if (k.slice(k.lastIndexOf('/') + 1).toLowerCase().includes(word)) {
            let anim; try { anim = parseBck(arc.get(k)!); } catch { continue; }
            if (anim.j.length === model.jointNames.length) return anim;
        }
    }
    return null;
}
export { parseBck, bckPose };

// ---------------------------------------------------------------- the library (lib_add, spec)
export interface LibCtx { w: GlbWriter; lib: Map<string, number>; specs: Map<number, any> }
export function spec(ctx: LibCtx, idx: number, kw: any) {
    if (idx >= 0 && !ctx.specs.has(idx)) { const o: any = {}; for (const [k, v] of Object.entries(kw)) if (v) o[k] = typeof v === 'string' ? v.toLowerCase() : v; ctx.specs.set(idx, o); }
    return idx;
}
let addModelsFn: (w: GlbWriter, models: bmd.Model[], name: string) => void = () => { throw new Error('no add_models'); };
export function setAddModels(f: typeof addModelsFn) { addModelsFn = f; }
export function libAdd(ctx: LibCtx, key: string, build: () => bmd.Model[] | null, sp: any = null) {
    const { lib } = ctx;
    if (!lib.has(key)) {
        try {
            const models = build();
            if (!models || !models.length) { lib.set(key, -1); return -1; }
            const idx = lib.size;
            addModelsFn(ctx.w, models, `m${idx}`);
            lib.set(key, idx);
        } catch (e) { console.warn('[v1data] skip model', key, e); lib.set(key, -1); }
    }
    return sp ? spec(ctx, lib.get(key)!, sp) : lib.get(key)!;
}
export { openArc };
