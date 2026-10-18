// Invisible triggers, read from the stage archive the way v1's tools/build_triggers.py does:
// stage changes, cutscene starts, warps, area cylinders (scene.bin), the cubes (tables.bin) and
// enemies' own distance checks (ENEMY_ZONES, with the stage's map/params/enemy/<name>.prm).

import * as RARC from '../noclip/Common/JSYSTEM/JKRArchive.js';
import { BMD } from '../noclip/Common/JSYSTEM/J3D/J3DLoader.js';
import { mat4 } from 'gl-matrix';

export type TriggerKind = 'stage' | 'stageHipDrop' | 'demo' | 'warp' | 'areaCyl' | 'camera' | 'area' | 'stream' | 'wire' | 'shadow'
    | 'mirror' | 'sound' | 'fastA' | 'fastB' | 'fastC' | 'cube' | 'enemy';
export interface Trigger {
    kind: TriggerKind;
    label: string;
    pos: [number, number, number];
    rot: [number, number, number];   // degrees (cubes: turned x then y then z)
    /** Cylinder: radius, height (from its base up). Cube: size x, y, z (centred in x / z, from its base up). Sphere: radius. */
    a: number; b: number; c: number;
    info: any;
}

export const TRIG_STYLE: Record<string, [string, string]> = {
    stage: ['#ff3b3b', 'Load zone'], stageHipDrop: ['#ff8a3b', 'Load zone (ground pound)'], demo: ['#ff4fd8', 'Cutscene trigger'],
    warp: ['#a66bff', 'Warp'], areaCyl: ['#9aa3ad', 'Area cylinder'], camera: ['#3b8bff', 'Camera cube'], area: ['#33d6e0', 'Area cube'],
    stream: ['#2fd18b', 'Flow cube'], wire: ['#ffd23b', 'Wire cube'], shadow: ['#6b6b80', 'Shadow cube'], mirror: ['#f2f2f2', 'Mirror cube'],
    sound: ['#7bdc4b', 'Sound cube'], fastA: ['#b07a4b', 'Draw cube A'], fastB: ['#b07a4b', 'Draw cube B'], fastC: ['#b07a4b', 'Draw cube C'],
    cube: ['#cccccc', 'Cube'], enemy: ['#ff5a1f', 'Enemy zone'],
};
export const ENEMY_ZONE_COLOR: Record<string, string> = { bomb: '#ff5a1f', bomb2: '#ffb21f', hide: '#8fd14f', unhide: '#4fc3d1' };

const CUBES: Record<string, TriggerKind> = {
    'カメラキューブテーブル': 'camera', 'エリアキューブテーブル': 'area', '流れキューブテーブル': 'stream', 'ワイヤーキューブテーブル': 'wire',
    '影キューブテーブル': 'shadow', '鏡キューブテーブル': 'mirror', 'サウンド切り替えキューブテーブル': 'sound', '高速Ａキューブテーブル': 'fastA',
    '高速Ｂキューブテーブル': 'fastB', '高速Ｃキューブテーブル': 'fastC',
};
const STAGE_CHANGE: Record<string, TriggerKind> = { MapObjChangeStage: 'stage', MapObjChangeStageHipDrop: 'stageHipDrop', ChangeStageMerrygoround: 'stage' };

// ---------------------------------------------------------------- scene.bin (JDrama NameRef tree)
const sjis = new TextDecoder('shift_jis');
export interface SceneObj { type: string; name: string; payload: DataView; bytes: Uint8Array; path: string[]; }

export function parseNameRefs(buf: ArrayBufferLike, off = 0, len?: number): SceneObj[] {
    const b = new Uint8Array(buf, off, len), v = new DataView(buf, off, len);
    const str = (o: number): [string, number] => { const n = v.getUint16(o + 2); return [sjis.decode(b.subarray(o + 4, o + 4 + n)), o + 4 + n]; };
    const looks = (o: number, end: number) => {
        if (o + 12 > end) return false;
        const size = v.getUint32(o);
        if (size < 12 || o + size > end) return false;
        const n = v.getUint16(o + 6);
        if (n === 0 || n > 64 || o + 8 + n > end) return false;
        for (let i = 0; i < n; i++) { const c = b[o + 8 + i]; if (!((c >= 48 && c < 123) || c === 95)) return false; }
        return true;
    };
    const out: SceneObj[] = [];
    const walk = (o: number, path: string[]): number => {
        const size = v.getUint32(o);
        const [type, p0] = str(o + 4);
        const [name, p] = str(p0);
        const end = o + size;
        for (const lead of [0, 4]) {
            let q = p + lead;
            if (q + 4 <= end) {
                const cnt = v.getUint32(q);
                if (cnt > 0 && cnt < 5000 && looks(q + 4, end)) {
                    q += 4;
                    for (let i = 0; i < cnt && looks(q, end); i++) q = walk(q, [...path, name]);
                    return end;
                }
            }
        }
        out.push({ type, name, payload: new DataView(buf, off + p, end - p), bytes: b.subarray(p, end), path });
        return end;
    };
    walk(0, []);
    return out;
}

export function placement(o: SceneObj): [number[], number[], number[]] | null {
    if (o.payload.byteLength < 36) return null;
    const f: number[] = [];
    for (let i = 0; i < 9; i++) f.push(o.payload.getFloat32(i * 4));
    if (f.some((x) => !(Math.abs(x) <= 1e7))) return null;
    return [f.slice(0, 3), f.slice(3, 6), f.slice(6, 9)];
}

const lstrEnd = (v: DataView, p: number) => p + 2 + v.getUint16(p);
/** Just past TActor + TMapObjBase strings: [desc][u32][model key]. */
function actorTail(v: DataView) { return lstrEnd(v, lstrEnd(v, 36) + 4); }

/** JDrama TParams .prm: [u32 count] then [u16 hash][u16 len][name][u32 size][value]. */
export function parsePrm(buf: ArrayBufferLike, off: number, len: number): Record<string, number> {
    const v = new DataView(buf, off, len), b = new Uint8Array(buf, off, len), out: Record<string, number> = {};
    const n = v.getUint32(0);
    let o = 4;
    for (let k = 0; k < n; k++) {
        const ln = v.getUint16(o + 2);
        const name = String.fromCharCode(...b.subarray(o + 4, o + 4 + ln));
        o += 4 + ln;
        const sz = v.getUint32(o);
        if (sz === 4) { const f = v.getFloat32(o + 4), i = v.getInt32(o + 4); out[name] = (Math.abs(f) > 1e-6 && Math.abs(f) < 1e7) || i === 0 ? f : i; }
        else if (sz === 1) out[name] = b[o + 4];
        o += 4 + sz;
    }
    return out;
}

// ---------------------------------------------------------------- enemy zones
// Enemies that act on Mario's distance from them (PSVECSquareDistance: a sphere). TCannon
// (Enemy/cannon.cpp, TNerveCannonSearch): within mSLBombDist it throws a bomb once
// mSLBombInterval is up, else (within mSLKillerDist) three goop shots, then a bomb if Mario is
// within sqrt(2) x mSLBombDist (TNerveCannonForceBombShoot); within mSLHideDist the mole hides
// (TNerveCannonClose) until Mario is past 3 x mSLHideDist. mSLKillerDist takes in about the whole
// stage, so it isn't drawn.
const ENEMY_ZONES: Record<string, { prm: string, defaults: Record<string, number>, zones: [string, string, (p: Record<string, number>) => number][] }> = {
    Cannon: {
        prm: 'cannon', defaults: { mSLHideDist: 300, mSLBombDist: 2000, mSLKillerDist: 10000 }, zones: [
            ['bomb', 'Monty Mole: throws bombs', (p) => p.mSLBombDist],
            ['bomb2', 'Monty Mole: bomb after goop', (p) => p.mSLBombDist * Math.SQRT2],
            ['hide', 'Monty Mole: hides', (p) => p.mSLHideDist],
            ['unhide', 'Monty Mole: comes back out past', (p) => p.mSLHideDist * 3],
        ],
    },
};

function fileData(rarc: RARC.JKRArchive, path: string) {
    const f = rarc.findFileData(path);
    return f ? { buf: f.arrayBuffer, off: f.byteOffset, len: f.byteLength } : null;
}

/** Noki Bay's cannon rides the cork (TMareCork::loadAfter takes it): TCannon::calcRootMatrix puts it at the cork's getTakingMtx, joint 2 (posnull1), in the model's bind pose. */
function corkHeld(rarc: RARC.JKRArchive, cork: [number[], number[]] | null): number[] | null {
    const f = rarc.findFileData('mapobj/marecork.bmd');
    if (!cork || !f) return null;
    const bmd = BMD.parse(f);
    // Joint 2's bind pose in model space: the joint chain's transforms composed. Parents from
    // INF1's hierarchy (u16 type, u16 value: 0x01 open, 0x02 close, 0x10 joint, 0x00 end).
    const h = bmd.inf1.hierarchyData.createDataView();
    const parent: number[] = [];
    const stack: number[] = [-1];
    let last = -1;
    for (let o = 0; o + 4 <= h.byteLength; o += 4) {
        const type = h.getUint16(o), value = h.getUint16(o + 2);
        if (type === 0x00) break;
        if (type === 0x01) stack.push(last);
        else if (type === 0x02) stack.pop();
        else if (type === 0x10) { parent[value] = stack[stack.length - 1]; last = value; }
    }
    const chain: number[] = [];
    for (let j = 2; j >= 0 && chain.length < 64; j = parent[j] ?? -1) chain.unshift(j);
    const m = mat4.create(), local = mat4.create();
    for (const j of chain) {
        const tr = bmd.jnt1.joints[j].transform;
        mat4.fromRotationTranslationScale(local, tr.rotation, tr.translation, tr.scale);
        mat4.mul(m, m, local);
    }
    const lx = m[12], ly = m[13], lz = m[14];
    const ry = (cork[1][1] * Math.PI) / 180, [cx, cy, cz] = cork[0];
    return [cx + lx * Math.cos(ry) + lz * Math.sin(ry), cy + ly, cz - lx * Math.sin(ry) + lz * Math.cos(ry)];
}

// ---------------------------------------------------------------- all of a stage's triggers
export function buildTriggers(rarc: RARC.JKRArchive): Trigger[] {
    const out: Trigger[] = [];
    const scene = fileData(rarc, 'map/scene.bin');
    if (!scene) return out;
    const objs = parseNameRefs(scene.buf, scene.off, scene.len);
    const placed: [SceneObj, number[]][] = [];
    let cork: [number[], number[]] | null = null;
    for (const o of objs) {
        const pl = placement(o);
        if (!pl) continue;
        const [[x, y, z], [rx, ry, rz], [sx, sy, sz]] = pl;
        if (ENEMY_ZONES[o.type]) placed.push([o, [x, y, z]]);
        else if (o.type === 'MareCork') cork = [[x, y, z], [rx, ry, rz]];
        if (STAGE_CHANGE[o.type] || o.type === 'MapObjStartDemo') {
            let val = 0;
            try { val = o.payload.getUint32(actorTail(o.payload)); } catch { }
            out.push({ kind: STAGE_CHANGE[o.type] || 'demo', label: o.type, pos: [x, y, z], rot: [rx, ry, rz], a: 100 * Math.max(sx, sz), b: 100 * sy, c: 0, info: val });
        } else if (o.type === 'WarpArea') {
            const n = o.payload.byteLength;
            const info = n >= 44 ? [o.payload.getUint32(n - 8), o.payload.getUint32(n - 4)] : [0, 0];
            out.push({ kind: 'warp', label: o.type, pos: [x, y, z], rot: [rx, ry, rz], a: 100 * sx, b: 100 * sy, c: 0, info });
        } else if (o.type === 'AreaCylinder' || o.type === 'AreaSphere') {
            out.push({ kind: 'areaCyl', label: o.name, pos: [x, y, z], rot: [0, 0, 0], a: sx * 50, b: sy * 50, c: 0, info: 0 });
        }
    }
    const tables = fileData(rarc, 'map/tables.bin');
    if (tables) {
        for (const o of parseNameRefs(tables.buf, tables.off, tables.len)) {
            if (o.type !== 'CubeGeneralInfo' && o.type !== 'CameraCubeInfo' && o.type !== 'CubeStreamInfo') continue;
            const f: number[] = [];
            for (let i = 0; i < 9; i++) f.push(o.payload.getFloat32(i * 4));
            out.push({ kind: CUBES[o.path[o.path.length - 1]] || 'cube', label: o.name, pos: [f[0], f[1], f[2]], rot: [f[3], f[4], f[5]], a: f[6] * 100, b: f[7] * 100, c: f[8] * 100, info: 0 });
        }
    }
    for (const [type, z] of Object.entries(ENEMY_ZONES)) {
        const p = { ...z.defaults };
        const prm = fileData(rarc, `map/params/enemy/${z.prm}.prm`);
        if (prm) try { Object.assign(p, parsePrm(prm.buf, prm.off, prm.len)); } catch { }
        for (const [o, pos] of placed) {
            if (o.type !== type) continue;
            const at = (type === 'Cannon' && corkHeld(rarc, cork)) || pos;
            for (const [zone, label, rad] of z.zones)
                out.push({ kind: 'enemy', label, pos: at as any, rot: [0, 0, 0], a: rad(p), b: 0, c: 0, info: zone });
        }
    }
    return out;
}

/** Where Mario starts on this stage, facing (yaw degrees), from scene.bin's Mario. */
export function marioStart(rarc: RARC.JKRArchive): [number, number, number, number] | null {
    const scene = fileData(rarc, 'map/scene.bin');
    if (!scene) return null;
    for (const o of parseNameRefs(scene.buf, scene.off, scene.len)) {
        if (o.type !== 'Mario') continue;
        const pl = placement(o);
        if (pl) return [pl[0][0], pl[0][1], pl[0][2], pl[1][1]];
    }
    return null;
}
