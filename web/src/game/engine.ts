// The game's object system and per-frame loop, ported from the decomp (aetherion28/sms-ai-decomp):
// JDrama's name refs and actors, THitActor / TTakeActor / TLiveActor (Strategic/), the managers
// (TObjManager / TLiveManager / TEnemyManager), the spine and nerves, TSpineEnemy (Enemy/enemy.cpp),
// the graphs enemies walk (Enemy/graph.cpp), TObjHitCheck, TConductor, the parameter files
// (System/Params.cpp), MActor's animation frame control (M3DUtil, J3DFrameCtrl) and the director's
// frame (System/MarDirectorDirect.cpp: four movement ticks a frame, hit checks every fourth, the
// animations once at the end). Drawing is the viewer's: this only works out where everything is,
// which animation it plays at which frame, and what's visible.

import { AnmSound, loadBas } from './anmsound.js';
import { BAS_TABLES } from './bastables.js';
import { FlagManager } from './flags.js';
import { SplineRail } from './spline.js';
import { psVecMag } from './camera/lib.js';
import { rngCtx, fr, V3, Mtx, mtx, MsWrap, MsAngleDiff, MsGetRotFromZaxisY, MsSin, MsCos, MsClamp, MsIsInSight, matan, MsRandF, sqDist, MsMtxSetRotRPH, MsMtxSetXYZRPH, mtxMultVec, mtxInverse, psMtxMultVec, psMtxInverse, MsMtxSetTRS, SMSCalcJumpVelocityY } from './math.js';
import type { MarioProxy } from './mario.js';
import type { PlayerMario } from './player/player.js';
import type { mat4 } from 'gl-matrix';
import { Skeleton, parseBCK, jointMatrices } from './skeleton.js';
import type { Water, Fludd } from './water.js';
import type { Pollution } from './pollution.js';
import { MapCollision, BGCheckData, IGNORE_WATER_SURFACE, IGNORE_WATER_THROUGH, WallCheck } from './collision.js';

// ---------------------------------------------------------------- constants
export const CUE_MOVE = 0x1, CUE_CALC_ANIM = 0x2, CUE_CALC_VIEW = 0x4, CUE_ENTRY = 0x200;

export const LF = {
    DEAD: 0x1, HIDDEN: 0x2, CLIPPED_OUT: 0x4, UNK8: 0x8, UNK10: 0x10, UNK20: 0x20, UNK40: 0x40, AIRBORNE: 0x80,
    ENABLE_CLIPPING: 0x100, UNK200: 0x200, FORCE_SHADOW: 0x400, UNK800: 0x800, UNK1000: 0x1000, UNK2000: 0x2000,
    // From here on the values are the US / PAL ones (VERSION_SELECT's default; GMSJ01's are half).
    UNK4000: 0x8000, UNK8000: 0x10000, UNK10000: 0x20000, UNK20000: 0x40000, UNK40000: 0x80000, UNK80000: 0x100000,
    UNK100000: 0x200000, UNK200000: 0x400000, UNK400000: 0x800000, UNK1000000: 0x2000000,
};
export const HF = { NO_COLLISION: 0x1, NO_ATTACK: 0x2, NO_DAMAGE: 0x4 };
export const MSG = {
    TRAMPLE: 0x0, HIP_DROP: 0x1, PUSH_UP: 0x2, SUPER_HIP_DROP: 0x3, TAKE: 0x4, ATTACH: 0x5, PUT: 0x6, THROWN: 0x7, DETACH: 0x8,
    ELECTRIC_SHOCK: 0x9, BURN: 0xA, UNKB: 0xB, PUNCH: 0xC, UNKD: 0xD, ATTACK: 0xE, SPRAYED_BY_WATER: 0xF, UNK10: 0x10, UNK11: 0x11, UNK12: 0x12,
};
export const HC = {
    ANIMAL: 0x800000, WATER: 0x1000000, GENERATOR: 0x2000000, NPC: 0x4000000, BOSS: 0x8000000, ENEMY: 0x10000000,
    ITEM: 0x20000000, MAP_OBJECT: 0x40000000, PLAYER: 0x80000000 | 0,
};
export const HC_MASK = 0xFFFF0000 | 0;
export const ANM_BCK = 0, ANM_BPK = 1, ANM_BTP = 2, ANM_BTK = 3, ANM_BRK = 4, ANM_BLK = 5;
/** SMSGetAnmFrameRate: 60 fps animations at 30 frames a second. */
export const ANM_FRAME_RATE = 2;

// ---------------------------------------------------------------- the archive the stage runs from
/** What the engine reads files from: the stage archive (/scene/...) and params.szs (/...). */
export interface Files {
    /** A file of the stage archive by its path below the archive root, lower case ("pakkun/pakun.bmd"). */
    scene(path: string): Uint8Array | null;
    /** The files directly in a stage archive folder, in archive order. */
    folder(path: string): string[];
    /** params.szs */
    params(path: string): Uint8Array | null;
}

// ---------------------------------------------------------------- JSUMemoryInputStream
const sjis = new TextDecoder('shift_jis');
export class Stream {
    pos = 0;
    v: DataView;
    constructor(public b: Uint8Array) { this.v = new DataView(b.buffer, b.byteOffset, b.byteLength); }
    get left() { return this.b.length - this.pos; }
    // JSUMemoryInputStream past its end reads nothing (the value is left as it was: 0 here, or what
    // a caller passes) and the string is empty — some nodes end before all their class reads
    // (Amenbo: TSpineEnemy::load's graph name and TSmallEnemy's coin id aren't in scene.bin).
    private has(n: number) { if (this.pos + n <= this.b.length) return true; this.pos = this.b.length; return false; }
    u8(d = 0) { return this.has(1) ? this.v.getUint8(this.pos++) : d; }
    s8(d = 0) { return this.has(1) ? this.v.getInt8(this.pos++) : d; }
    u16(d = 0) { if (!this.has(2)) return d; const r = this.v.getUint16(this.pos); this.pos += 2; return r; }
    s16(d = 0) { if (!this.has(2)) return d; const r = this.v.getInt16(this.pos); this.pos += 2; return r; }
    u32(d = 0) { if (!this.has(4)) return d; const r = this.v.getUint32(this.pos); this.pos += 4; return r; }
    s32(d = 0) { if (!this.has(4)) return d; const r = this.v.getInt32(this.pos); this.pos += 4; return r; }
    f32(d = 0) { if (!this.has(4)) return d; const r = this.v.getFloat32(this.pos); this.pos += 4; return r; }
    str() { const n = this.u16(); const e = Math.min(this.b.length, this.pos + n); const s = sjis.decode(this.b.subarray(this.pos, e)); this.pos = e; return s; }
    sub(n: number) { const s = new Stream(this.b.subarray(this.pos, this.pos + n)); this.pos += n; return s; }
    skip(n: number) { this.pos += n; }
}

/** JDrama::TNameRef::calcKeyCode */
export function calcKeyCode(name: string) {
    const enc = sjisEncode(name);
    let k = 0;
    for (const c of enc) k = (k * 3 + c) & 0xFFFF;
    return k;
}
// Shift-JIS encoding for names (key codes are over the SJIS bytes): a reverse table from the decoder.
let sjisRev: Map<string, number> | null = null;
function sjisEncode(s: string): number[] {
    const out: number[] = [];
    for (const ch of s) {
        const c = ch.charCodeAt(0);
        if (c < 0x80) { out.push(c); continue; }
        if (!sjisRev) {
            sjisRev = new Map();
            for (let hi = 0x81; hi <= 0xFC; hi++) for (let lo = 0x40; lo <= 0xFC; lo++) {
                const d = sjis.decode(new Uint8Array([hi, lo]));
                if (d.length === 1 && d !== '�' && !sjisRev.has(d)) sjisRev.set(d, (hi << 8) | lo);
            }
            for (let k = 0xA1; k <= 0xDF; k++) sjisRev.set(sjis.decode(new Uint8Array([k])), k);
        }
        const v = sjisRev.get(ch);
        if (v === undefined) out.push(0x3F);
        else if (v < 0x100) out.push(v);
        else out.push(v >> 8, v & 0xFF);
    }
    return out;
}
/** MActorCalcKeyCode */
export function mactorKeyCode(name: string) { let r = 0; for (let i = 0; i < name.length; i++) r = (name.charCodeAt(i) + r * 5) >>> 0; return r & 0xFFFF; }

// ---------------------------------------------------------------- parameter files (TParams)
/** A parameter's type (TParamRT<T>): f32, s32, u8, s16, u16, u32, or a TVec3<f32>. */
export type PType = 'f' | 'i' | 'u8' | 's16' | 'u16' | 'u32' | 'v3';
export type PSchema = Record<string, [PType, number | number[]]>;
export class Params {
    private raw = new Map<string, Uint8Array>();
    found = false;
    constructor(path: string | null, files: Files) {
        if (!path) return;
        const p = path.replace(/^\//, '').toLowerCase();
        const b = files.scene('map/params/' + p) || files.params(p);
        if (!b) return;
        this.found = true;
        try {
            const s = new Stream(b);
            const n = s.s32();
            for (let i = 0; i < n; i++) {
                s.u16();
                const name = s.str();
                const size = s.s32();
                this.raw.set(name, b.subarray(s.pos, s.pos + size));
                s.skip(size);
            }
        } catch { }
    }
    has(name: string) { return this.raw.has(name); }
    get(name: string, t: PType, def: number | number[]): any {
        const r = this.raw.get(name);
        if (!r) return def;
        const v = new DataView(r.buffer, r.byteOffset, r.byteLength);
        // (TParamT<T>::load reads sizeof(T): the stored size says what's there)
        if (t === 'v3') return r.length >= 12 ? [v.getFloat32(0), v.getFloat32(4), v.getFloat32(8)] : def;
        if (r.length === 1) return t === 'u8' ? v.getUint8(0) : v.getInt8(0);
        if (r.length === 2) return t === 'u16' ? v.getUint16(0) : v.getInt16(0);
        if (r.length < 4) return def;
        switch (t) {
            case 'f': return v.getFloat32(0);
            case 'i': return v.getInt32(0);
            case 'u32': return v.getUint32(0);
            case 'u8': return v.getUint32(0) & 0xFF;
            case 's16': return (v.getInt32(0) << 16) >> 16;
            case 'u16': return v.getUint32(0) & 0xFFFF;
        }
    }
    /** The parameters of a TParams subclass (its PARAM_INIT list: name, type, default). */
    read<S extends PSchema>(schema: S): { [K in keyof S]: S[K][1] } {
        const out: any = {};
        for (const k in schema) out[k] = this.get(k, schema[k][0], schema[k][1]);
        return out;
    }
    f32(name: string, def: number) { return this.get(name, 'f', def); }
    s32(name: string, def: number) { return this.get(name, 'i', def); }
    u8(name: string, def: number) { return this.get(name, 'u8', def); }
    s16(name: string, def: number) { return this.get(name, 's16', def); }
    u32(name: string, def: number) { return this.get(name, 'u32', def); }
}
export function readParams<S extends PSchema>(path: string, files: Files, schema: S) { return new Params(path, files).read(schema); }

/** TSpineEnemyParams */
export const SPINE_PARAMS = {
    mSLHeadHeight: ['f', 120], mSLBodyRadius: ['f', 30], mSLWallRadius: ['f', 50], mSLClipRadius: ['f', 300], mSLFarClip: ['f', 10000],
    mSLHitPointMax: ['u8', 1], mSLInstanceNum: ['u8', 100], mSLActiveEnemyNum: ['u8', 10],
} satisfies PSchema;
export type SpineParams = { [K in keyof typeof SPINE_PARAMS]: number };

// ---------------------------------------------------------------- scene.bin
/** A node of scene.bin: its class, name, its own data, and its children if it's a group. */
export interface SceneNode { type: string; name: string; data: Uint8Array; children: SceneNode[] | null; groupIndex?: number; }

/** Group nodes (TViewObjPtrListT, TNameRefPtrAryT, TStrategy, TIdxGroupObj...) read a child count and
 *  children, sometimes after a few bytes of their own (TIdxGroupObj's group index): a payload that
 *  parses exactly as that is a group. */
function childrenAt(v: DataView, q: number, end: number): number | null {
    if (q + 4 > end) return null;
    const n = v.getUint32(q); q += 4;
    if (n > 4096) return null;
    for (let i = 0; i < n; i++) {
        if (q + 12 > end) return null;
        const size = v.getUint32(q);
        if (size < 12 || q + size > end) return null;
        const tl = v.getUint16(q + 6);
        if (8 + tl + 4 > size) return null;
        const nl = v.getUint16(q + 8 + tl + 2);
        if (8 + tl + 4 + nl > size) return null;
        q += size;
    }
    return q === end ? n : null;
}

export function parseSceneBin(b: Uint8Array): SceneNode {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const node = (o: number): [SceneNode, number] => {
        const size = v.getUint32(o);
        const s = new Stream(b.subarray(o + 4, o + size));
        s.u16(); const type = s.str();
        s.u16(); const name = s.str();
        const start = o + 4 + s.pos, end = o + size;
        let children: SceneNode[] | null = null, groupIndex: number | undefined;
        let data = b.subarray(start, end);
        for (const lead of [0, 4]) {
            const n = childrenAt(v, start + lead, end);
            if (n === null || (n === 0 && lead === 0 && end - start !== 4)) continue;
            if (lead === 4) groupIndex = v.getInt32(start);
            let q = start + lead + 4;
            children = [];
            for (let i = 0; i < n; i++) { const [c, nq] = node(q); children.push(c); q = nq; }
            data = b.subarray(start, start + lead);
            break;
        }
        return [{ type, name, data, children, groupIndex }, end];
    };
    return node(0)[0];
}

// ---------------------------------------------------------------- name refs
export class NameRef {
    name = ''; keyCode = 0;
    constructor(name = '') { this.name = name; }
    /** (The scene loader has read the class and name already.) */
    load(_s: Stream) { }
    loadAfter() { }
    perform(_cue: number) { }
    /** JDrama::TViewObj::testPerform: unkC masks out cues (the gates aren't used by anything here). */
    flags = 0;
    testPerform(cue: number) {
        cue &= ~this.flags;
        if (!cue) return;
        const prev = rngCtx.cur; rngCtx.cur = this;
        try { this.perform(cue); } finally { rngCtx.cur = prev; }
    }
}

// ---------------------------------------------------------------- actors
export class Actor extends NameRef {
    pos = new V3(); rot = new V3(); scale = new V3(1, 1, 1);
    character: string = '';
    /** Its place in scene.bin (for the viewer to find what it drew for it). */
    sceneIndex = -1;
    /** where scene.bin put it */
    loadPos: V3 | null = null;
    load(s: Stream) {
        super.load(s);
        this.pos.set(s.f32(), s.f32(), s.f32());
        this.loadPos = this.pos.clone();
        this.rot.set(s.f32(), s.f32(), s.f32());
        this.scale.set(s.f32(), s.f32(), s.f32());
        this.character = s.str();
        const n = s.s32();   // TLightMap
        for (let i = 0; i < n; i++) { s.u32(); s.str(); }
    }
}

export class HitActor extends Actor {
    collisions: HitActor[] = []; colCapacity = 0;
    actorType = 0;
    attackRadius = 0; attackHeight = 0; damageRadius = 0; damageHeight = 0; entryRadius = 0; hitFilter = 0;
    receiveMessage(_sender: HitActor, _msg: number): boolean { return false; }
    calcEntryRadius() {
        const r = Math.max(this.attackRadius, this.damageRadius), h = Math.max(this.attackHeight, this.damageHeight);
        const d = r * r + h * h;
        this.entryRadius = d > 0 ? 1.4142135 * Math.sqrt(d) : 0;
    }
    initHitActor(type: number, max: number, filter: number, ar: number, ah: number, dr: number, dh: number) {
        this.actorType = type | 0; this.colCapacity = max; this.collisions = [];
        this.hitFilter |= filter;
        this.attackRadius = ar; this.attackHeight = ah; this.damageRadius = dr; this.damageHeight = dh;
        this.calcEntryRadius();
    }
    setHitParams(ar: number, ah: number, dr: number, dh: number) { this.attackRadius = ar; this.attackHeight = ah; this.damageRadius = dr; this.damageHeight = dh; this.calcEntryRadius(); }
    getHitCategory() { return this.actorType & HC_MASK; }
    isHitCategory(c: number) { return (this.actorType & c) !== 0; }
    isActorType(t: number) { return this.actorType === (t | 0); }
    checkHitFilter(f: number) { return (this.hitFilter & f) !== 0; }
    onHitFilter(f: number) { this.hitFilter |= f; }
    offHitFilter(f: number) { this.hitFilter &= ~f; }
    canAttack(o: HitActor) { return this.checkHitFilter(o.getHitCategory()); }
}

export class TakeActor extends HitActor {
    holder: TakeActor | null = null; held: TakeActor | null = null;
    getTakingMtx(): Mtx | null { return null; }
    /** TTakeActor::getRadiusAtY: a pole's / tree's radius at height y (Mario climbing it is drawn that far off its axis): mDamageRadius */
    getRadiusAtY(_y: number) { return this.damageRadius; }
    ensureTakeSituation() {
        if (this.held && this.held.holder !== this) this.held = null;
        if (this.holder && this.holder.held !== this) this.holder = null;
    }
}

// ---------------------------------------------------------------- animations (MActor, J3DFrameCtrl)
export const FC_ONCE = 0, FC_ONCE_RESET = 1, FC_LOOP = 2, FC_PINGPONG = 3, FC_PINGPONG_LOOP = 4;
export class FrameCtrl {
    attr = FC_LOOP; state = 0; start = 0; end = 0; loop = 0; rate = 1; frame = 0;
    init(end: number) { this.attr = FC_LOOP; this.state = 0; this.start = 0; this.end = end; this.loop = 0; this.rate = 1; this.frame = 0; }
    update() {
        this.state = 0;
        this.frame = fr(this.frame + this.rate);
        switch (this.attr) {
            case FC_ONCE:
                if (this.frame < this.start) { this.frame = this.start; this.rate = 0; this.state |= 1; }
                if (this.frame >= this.end) { this.frame = this.end - 0.001; this.rate = 0; this.state |= 1; }
                break;
            case FC_ONCE_RESET:
                if (this.frame < this.start) { this.frame = this.start; this.rate = 0; this.state |= 1; }
                if (this.frame >= this.end) { this.frame = this.start; this.rate = 0; this.state |= 1; }
                break;
            case FC_LOOP:
                while (this.frame < this.start) { this.state |= 2; if (this.loop - this.start <= 0) break; this.frame += this.loop - this.start; }
                while (this.frame >= this.end) { this.state |= 2; if (this.end - this.loop <= 0) break; this.frame -= this.end - this.loop; }
                break;
            case FC_PINGPONG:
                if (this.frame >= this.end) { this.frame = this.end - 0.001; this.rate = -this.rate; }
                if (this.frame < this.start) { this.frame = this.start; this.rate = 0; this.state |= 1; }
                break;
            case FC_PINGPONG_LOOP:
                if (this.frame >= this.end) { this.frame = this.end - 0.001; this.rate = -this.rate; }
                if (this.frame < this.start) { this.frame = this.start; this.rate = -this.rate; this.state |= 2; }
                break;
        }
    }
    checkPass(p: number): boolean {
        const cur = this.frame;
        let next = cur + this.rate;
        switch (this.attr) {
            case FC_ONCE: case FC_ONCE_RESET:
                if (next < this.start) next = this.start;
                if (next >= this.end) next = this.end - 0.001;
                if (cur <= next) return cur <= p && p < next;
                return next <= p && p < cur;
            case FC_LOOP:
                if (cur < this.start) {
                    while (next < this.start) { if (this.loop - this.start <= 0) break; next += this.loop - this.start; }
                    return next <= p && p < this.loop;
                } else if (this.end <= cur) {
                    while (next >= this.end) { if (this.end - this.loop <= 0) break; next -= this.end - this.loop; }
                    return this.loop <= p && p < next;
                } else if (next < this.start) {
                    while (next < this.start) { if (this.loop - this.start <= 0) break; next += this.loop - this.start; }
                    return (this.start <= p && p < cur) || (next <= p && p < this.loop);
                } else if (this.end <= next) {
                    while (next >= this.end) { if (this.end - this.loop <= 0) break; next -= this.end - this.loop; }
                    return (cur <= p && p < this.end) || (this.loop <= p && p < next);
                } else if (cur <= next) return cur <= p && p < next;
                return next <= p && p < cur;
            case FC_PINGPONG: case FC_PINGPONG_LOOP:
                if (next >= this.end) next = this.end - 0.001;
                if (next < this.start) next = this.start;
                if (cur <= next) return cur <= p && p < next;
                return next <= p && p < cur;
        }
        return false;
    }
}

/** One animation file of a model's folder: its name (no extension), key code, length and loop mode. */
export interface AnmFile { name: string; key: number; frameMax: number; attr: number; }
const ANM_EXT = ['.bck', '.bpk', '.btp', '.btk', '.brk', '.blk'];
/** J3D animation headers: loop mode at 0x08, length at 0x0A of the first chunk. */
function anmInfo(b: Uint8Array): [number, number] {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return [v.getUint16(0x20 + 0x0A), v.getUint8(0x20 + 0x08)];
}
/** MActorAnmData: every animation file in a folder, by type, in archive order. */
export class AnmData {
    anms: AnmFile[][] = [[], [], [], [], [], []];
    constructor(public folder: string, public files: Files) {
        for (const f of files.folder(folder)) {
            const t = ANM_EXT.findIndex((e) => f.endsWith(e));
            if (t < 0) continue;
            const b = files.scene(folder + '/' + f);
            if (!b) continue;
            let [frameMax, attr] = [0, FC_LOOP];
            try { [frameMax, attr] = anmInfo(b); } catch { }
            const name = f.slice(0, -4);
            this.anms[t].push({ name, key: mactorKeyCode(name), frameMax, attr });
        }
    }
    /** MActorAnmBase::findName: the index of the one animation with the name's key code. */
    find(type: number, name: string) {
        const k = mactorKeyCode(name.replace(/\.[a-z]{3}$/i, ''));
        let n = 0, m = -1;
        this.anms[type].forEach((a, i) => { if (a.key === k) { n++; m = i; } });
        if (n === 1) return m;
        if (n === 0) return -1;
        return this.anms[type].findIndex((a) => a.name.toLowerCase() === name.replace(/\.[a-z]{3}$/i, '').toLowerCase());
    }
}

class AnmSlot {
    idx = -1; fc = new FrameCtrl();
    constructor(public data: AnmData, public type: number) { }
    setFromIndex(i: number) {
        this.idx = i;
        if (i < 0) return false;
        const a = this.data.anms[this.type][i];
        if (!a) { this.idx = -1; return false; }
        this.fc.init(a.frameMax);
        this.fc.attr = a.attr;
        this.fc.rate = ANM_FRAME_RATE;
        return true;
    }
    endsNext() { return this.fc.frame + this.fc.rate + 0.1 >= this.fc.end; }
}

/** MActor: a model and the animations it plays (one at a time per type). */
export class MActor {
    slots: (AnmSlot | null)[];
    /** a material table it takes (J3DModelData::setMaterialTable), for the viewer */
    bmt: string | null = null;
    /** The model file (for the viewer). */
    constructor(public model: string, public data: AnmData) {
        this.slots = data.anms.map((list, t) => (list.length ? new AnmSlot(data, t) : null));
    }
    frameUpdate() { for (const s of this.slots) if (s && s.idx >= 0) s.fc.update(); }
    matAnmFrameUpdate() { for (let t = ANM_BPK; t < this.slots.length; t++) { const s = this.slots[t]; if (s && s.idx >= 0) s.fc.update(); } }
    getFrameCtrl(type: number) { const s = this.slots[type]; return s ? s.fc : null; }
    getCurAnmIdx(type: number) { const s = this.slots[type]; return s ? s.idx : -1; }
    setAnimation(name: string, type: number) { const s = this.slots[type]; if (s) s.setFromIndex(this.data.find(type, name)); }
    setBck(name: string) { this.setAnimation(name, ANM_BCK); }
    setBckFromIndex(i: number) { const s = this.slots[ANM_BCK]; if (s) s.setFromIndex(i); }
    setFromIndex(type: number, i: number) { const s = this.slots[type]; if (s) s.setFromIndex(i); }
    checkCurBckFromIndex(i: number) { const s = this.slots[ANM_BCK]; return !!s && s.idx === i; }
    checkCurAnm(name: string, type: number) { const s = this.slots[type]; return !!s && this.data.find(type, name) === s.idx; }
    curAnmEndsNext(type: number) { const s = this.slots[type]; return !s ? true : s.endsNext(); }
    isCurAnmAlreadyEnd(type: number) {
        const c = this.getFrameCtrl(type);
        return !c || (c.state & 1) !== 0 || (c.state & 2) !== 0 || c.frame + 0.1 >= c.end;
    }
    checkBckPass(f: number) { const c = this.getFrameCtrl(ANM_BCK); return !!c && c.checkPass(f); }
    setFrameRate(r: number, type: number) { const c = this.getFrameCtrl(type); if (c) c.rate = r; }
    /** J3DModel::getAnmMtx: joint j's world matrix at the BCK's frame, for the base TR matrix and scale. */
    anmMtx(j: number, base: Mtx, scale: V3, post?: (j: number, m: mat4) => void): mat4 | null {
        const all = this.anmMtxAll(base, scale, post);
        return all && j >= 0 && j < all.length ? all[j] : null;
    }
    /** Every joint's world matrix (J3DModel::calc's anmMtx array), or null with no skeleton. */
    anmMtxAll(base: Mtx, scale: V3, post?: (j: number, m: mat4) => void): mat4[] | null {
        const sk = Skeleton.of(this.data.files.scene(this.model));
        if (!sk) return null;
        const s = this.slots[ANM_BCK];
        const a = s && s.idx >= 0 ? this.data.anms[ANM_BCK][s.idx] : null;
        const anm = a ? parseBCK(this.data.files.scene(this.data.folder + '/' + a.name + '.bck')) : null;
        return jointMatrices(sk, anm, s ? s.fc.frame : 0, base, [scale.x, scale.y, scale.z], [], post);
    }
    jointIndex(name: string) { const sk = Skeleton.of(this.data.files.scene(this.model)); return sk ? sk.index(name) : -1; }
    /** The BCK playing and its frame (for the viewer). */
    bckName() { const s = this.slots[ANM_BCK]; return s && s.idx >= 0 ? this.data.anms[ANM_BCK][s.idx].name : null; }
    anmState() {
        return this.slots.map((s) => (s && s.idx >= 0 ? { name: this.data.anms[s.type][s.idx].name, frame: s.fc.frame } : null));
    }
}

// ---------------------------------------------------------------- spine and nerves
export interface Nerve<T = any> { name: string; execute(spine: Spine<T>): boolean; }
/** DEFINE_NERVE: a nerve singleton. */
export const nerve = <T = any>(name: string, execute: (spine: Spine<T>) => boolean): Nerve<T> => ({ name, execute });

export class Spine<T = any> {
    stack: Nerve<T>[] = [];
    current: Nerve<T> | null = null; default: Nerve<T> | null = null; previous: Nerve<T> | null = null;
    time = 0;
    constructor(public body: T) { }
    getLatestNerve() { return this.current || this.previous; }
    isNerve(n: Nerve<T>) { return this.getLatestNerve() === n; }
    /** TSolidStack(8): pushes past its capacity are dropped. */
    private push(n: Nerve<T>) { if (this.stack.length < 8) this.stack.push(n); }
    pushNerve(n: Nerve<T> | null) { if (!n) return; if (this.current) { this.previous = this.current; this.push(this.current); } this.time = 0; this.current = n; }
    update() {
        if (!this.current) this.skip();
        if (this.current) {
            const cont = this.current.execute(this);
            this.time += 1;
            if (this.time < 0) this.time = 1;
            if (cont) { this.previous = this.current; this.current = null; }
        }
    }
    setNext(n: Nerve<T> | null) { if (this.current) this.previous = this.current; this.time = 0; this.current = n; }
    skip() {
        const n = this.stack.length > 0 ? this.stack.pop()! : null;
        if (n) { if (this.current) this.previous = this.current; this.current = n; this.time = 0; }
    }
    initWith(n: Nerve<T>) { this.stack.length = 0; this.time = 0; this.current = n; this.default = n; this.previous = null; }
    pushAfterCurrent(n: Nerve<T> | null) { if (n) this.push(n); }
    reset() { this.stack.length = 0; }
    setDefaultNext() { this.setNext(this.default); }
    getTime() { return this.time; }
    isIdle() { return !this.current && this.stack.length === 0; }
}

// ---------------------------------------------------------------- the world (globals the game code reaches)
/** SMS_getShineIDofExStage (System/StageUtil.cpp): the Shine of a secret stage (areas 0x15..0x34), else 0xFF */
const EX_SHINE = [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x37, 0x14, 0xFF, 0xFF, 0xFF, 0xFF,
    0xFF, 0xFF, 0xFF, 0x2B, 0x23, 0x40, 0xFF, 0xFF, 0xFF, 0x05, 0x02, 0x0D, 0xFF, 0x1F, 0x29, 0xFF];
export function shineIDofExStage(area: number) { return area <= 0x14 || area >= 0x35 ? 0xFF : EX_SHINE[area - 0x15]; }

export class World {
    col!: MapCollision;
    files!: Files;
    byName = new Map<string, NameRef>();
    conductor = new Conductor(this);
    hitCheck = new ObjHitCheck(this);
    groups: (HitActor[] | null)[] = [];
    /** gpMarioAddress: the ghost's proxy, or the input-driven player */
    mario!: MarioProxy | PlayerMario;
    water: Water | null = null;
    fludd: Fludd | null = null;
    pollution: Pollution | null = null;
    graphs = new Map<string, GraphWeb>();
    /** Actors no manager holds (enemies' attachments: Piranha Plant seeds...), drawn too. */
    extras: LiveActor[] = [];
    /** TFlowerCoin items (コイン（フラワー用）): their unit index (unk158) and place */
    flowerCoins: { unk158: number; pos: V3; kill?: () => void }[] = [];
    nullGraph = new GraphWeb([], '<nullrail>');
    /** Managers by the name their objects use to find them. */
    moveTickCount = 0; tickCount = 0;
    /** TMarDirector state the game code asks about. */
    map = 0; stage = 0;
    /** TFlagManager's Shine flag of this secret stage's Shine (SMS_getShineIDofExStage): got before the run */
    exShineGot = false;
    /** TFlagManager (flags.ts): set up for the stage by Stage's constructor (setupStage) */
    flags = new FlagManager();
    demoMode = false; talkMode = false;
    /** Per-frame hooks: things the viewer wants told (an enemy's coin, a Shine). */
    events: { t: number; kind: string; data: any }[] = [];
    search(name: string) { return this.byName.get(name) || null; }
    register(r: NameRef) { if (r.name && !this.byName.has(r.name)) this.byName.set(r.name, r); }
    graphByName(name: string | null) { return (name && this.graphs.get(name)) || this.nullGraph; }

    // gpMap
    checkGround(x: number, y: number, z: number): [number, BGCheckData] { return this.col.checkGround(x, y, z, 0); }
    checkGroundIgnoreWaterSurface(x: number, y: number, z: number) { return this.col.checkGround(x, y, z, IGNORE_WATER_SURFACE); }
    checkGroundIgnoreWaterThrough(x: number, y: number, z: number) { return this.col.checkGround(x, y, z, IGNORE_WATER_THROUGH); }
    checkRoof(x: number, y: number, z: number) { return this.col.checkRoof(x, y, z, 0); }
    /** isTouchedOneWallAndMoveXZ: pushes p (x, z) out of the one wall the sphere touches. */
    isTouchedOneWallAndMoveXZ(p: { x: number, z: number }, y: number, radius: number) {
        const r: WallCheck = { center: [p.x, y, p.z], radius, maxResults: 1, flags: 0, results: [] };
        if (this.col.checkWalls(r)) { p.x = r.center[0]; p.z = r.center[2]; return true; }
        return false;
    }
    isTouchedWallsAndMoveXZ(r: WallCheck) { return this.col.checkWalls(r) !== 0; }
    isInArea(x: number, z: number) { return -this.col.ex < x && x < this.col.ex && -this.col.ez < z && z < this.col.ez; }
    get illegal() { return this.col.illegal; }
}

// ---------------------------------------------------------------- managers
export class ObjManager extends NameRef {
    world: World;
    objs: HitActor[] = []; capacity = 0;
    charaFolder = '';
    modelFiles: string[] = [];
    anmData: AnmData | null = null;
    constructor(world: World, name = '') { super(name); this.world = world; }
    load(s: Stream) {
        super.load(s);
        const chara = s.str();
        const c = this.world.search(chara) as any;
        this.charaFolder = c && c.folder ? c.folder : '';
        this.capacity = s.s32();
    }
    manageObj(o: HitActor) { this.objs.push(o); }
    getObjNum() { return this.objs.length; }
    getObj(i: number) { return this.objs[i]; }
    perform(cue: number) { for (const o of this.objs) o.testPerform(cue); }
    /** The folder a model / animations live in, below the archive root ("/scene/pakkun" -> "pakkun"). */
    folder() { return this.charaFolder.replace(/^\/?scene\//i, '').replace(/^\//, '').toLowerCase(); }
    getMActorAnmData() { if (!this.anmData) this.anmData = new AnmData(this.folder(), this.world.files); return this.anmData; }
    /** createModelDataArray: the model files the manager loads, from its folder. */
    createModelDataArray(entries: string[]) { this.modelFiles = entries.map((e) => (this.folder() + '/' + e).toLowerCase()); }
    createModelData() { }
}

/** TObjChara: the character a manager's models come from (its folder in the stage archive). */
export class ObjChara extends NameRef {
    folder = '';
    load(s: Stream) { super.load(s); this.folder = s.str(); }
}

export class LiveManager extends ObjManager {
    constructor(world: World, name = '') { super(world, name); world.conductor.liveManagers.push(this); }
    load(s: Stream) { super.load(s); }
    manageActor(a: LiveActor) { a.instanceIndex = this.objs.length; this.manageObj(a); }
    /** clipActorsAux: in the game camera's view (within far, radius r), else CLIPPED_OUT. */
    clipActorsAux(far: number, r: number) {
        for (const o of this.objs as LiveActor[]) {
            if (!o.checkLiveFlag(LF.ENABLE_CLIPPING)) o.offLiveFlag(LF.CLIPPED_OUT);
            else if (this.world.inView(o.pos, r, far)) o.offLiveFlag(LF.CLIPPED_OUT);
            else o.onLiveFlag(LF.CLIPPED_OUT);
        }
    }
    clipActors() { this.clipActorsAux(4000, 200); }
    setFlagOutOfCube() { for (const o of this.objs as LiveActor[]) { if (this.world.inAreaCube(o.pos)) o.offLiveFlag(LF.UNK200); else o.onLiveFlag(LF.UNK200); } }
    perform(cue: number) {
        if (cue & CUE_CALC_ANIM) { this.clipActors(); this.setFlagOutOfCube(); }
        super.perform(cue);
    }
    hasMapCollision() { return this.objs.length > 0 && (this.objs[0] as LiveActor).hasMapCollision(); }
    getActorByFlag(f: number) { for (const o of this.objs as LiveActor[]) if (o.checkLiveFlag(f)) return o; return null; }
}

// ---------------------------------------------------------------- TLiveActor
export class LiveActor extends TakeActor {
    world: World;
    manager: LiveManager | null = null;
    mactor: MActor | null = null;
    instanceIndex = 0;
    spine: Spine<any> | null = null;
    posDelta = new V3(); rotDelta = new V3(); vel = new V3();
    scaledBodyRadius = 10; bodyRadius = 25; headHeight = 50;
    groundPlane!: BGCheckData; groundHeight = 0; gravity = 0.15;
    groundActor: LiveActor | null = null; ridePos = new V3(); groundActorYaw = 0; unkE8 = 1;
    liveFlag = LF.ENABLE_CLIPPING;
    /** Its own map collision (lifts, platforms): moved with it. */
    mapCollision: { moveSRT(p: V3, r: V3, s: V3): void } | null = null;
    baseTR: Mtx = mtx();
    constructor(world: World, name = '') {
        super(name);
        this.world = world;
        this.groundPlane = world.illegal;
        if (world.map !== 8) this.liveFlag |= LF.UNK2000;
    }
    checkLiveFlag(f: number) { return (this.liveFlag & f) !== 0; }
    onLiveFlag(f: number) { this.liveFlag |= f; }
    offLiveFlag(f: number) { this.liveFlag &= ~f; }
    isAirborne() { return this.checkLiveFlag(LF.AIRBORNE); }
    getGravityY() { return this.gravity; }
    hasMapCollision() { return !!this.mapCollision; }
    getRootJointMtx(): Mtx | null { return null; }
    /** SMS_GetActorMtx: MsMtxSetTRS of its position, rotation and scale */
    actorMtx(): Mtx { const m = mtx(); MsMtxSetTRS(m, this.pos.x, this.pos.y, this.pos.z, this.rot.x, this.rot.y, this.rot.z, this.scale.x, this.scale.y, this.scale.z); return m; }
    /** the ground actor's root joint matrix (copied: MTXCopy), else SMS_GetActorMtx */
    private groundMtx(a: LiveActor): Mtx { const m = a.getRootJointMtx(); return m ? Float64Array.from(m) : a.actorMtx(); }
    load(s: Stream) {
        super.load(s);
        const mgr = s.str();
        this.groundPlane = this.world.illegal;
        this.init(this.world.search(mgr) as LiveManager | null);
    }
    init(manager: LiveManager | null) {
        if (manager) {
            this.manager = manager;
            manager.manageActor(this);
            this.mactor = this.createMActor(0);
        } else this.world.conductor.aloneActors.push(this);
        this.initHitActor(0, 1, 0, this.bodyRadius, this.headHeight, this.bodyRadius, this.headHeight);
        this.onHitFilter(HF.NO_COLLISION);
        this.offLiveFlag(LF.FORCE_SHADOW);
    }
    /** TMActorKeeper::createMActorFromNthData */
    createMActor(n: number): MActor | null {
        const m = this.manager;
        if (!m || !m.modelFiles[n]) return null;
        return new MActor(m.modelFiles[n], m.getMActorAnmData());
    }
    /** TMActorKeeper::createMActor(name): one of the manager folder's models by file name. */
    createMActorByName(file: string): MActor | null {
        const m = this.manager;
        if (!m) return null;
        return new MActor((m.folder() + '/' + file).toLowerCase(), m.getMActorAnmData());
    }
    calcVelocityToJumpToY(p: V3, speed: number, g: number) { return SMSCalcJumpVelocityY(p, this.pos, speed, g, -40); }
    belongToGround() { return !!this.groundPlane && !this.groundPlane.isIllegal() && !!this.groundPlane.actor && !this.isAirborne(); }
    calcRidePos() {
        if (!this.groundActor) return;
        const m = this.groundMtx(this.groundActor);
        psMtxInverse(m, m);
        psMtxMultVec(m, this.pos, this.ridePos);
    }
    calcRideMomentum() {
        if (this.unkE8 === 0) return;
        if (this.belongToGround()) {
            const ga = this.groundPlane.actor as LiveActor;
            if (!this.groundActor || this.groundActor !== ga) {
                this.groundActor = ga;
                this.calcRidePos();
                if (this.unkE8 >= 2 && this.groundActor) this.groundActorYaw = this.groundActor.rot.y;
            } else {
                const v = psMtxMultVec(this.groundMtx(this.groundActor), this.ridePos).sub(this.pos);
                this.posDelta.add(v);
                if (this.unkE8 >= 2) { this.rotDelta.y += MsAngleDiff(this.groundActor.rot.y, this.groundActorYaw); this.groundActorYaw = this.groundActor.rot.y; }
            }
        } else this.groundActor = null;
    }
    /** mBinder: binds its movement instead (TWalker...) */
    binder: { bind(a: LiveActor): void } | null = null;
    bind() {
        if (this.checkLiveFlag(LF.UNK10)) return;
        if (this.binder) { this.binder.bind(this); return; }
        const next = this.pos.clone().add(this.posDelta).add(this.vel);
        this.vel.y -= this.getGravityY();
        if (this.vel.y < -40) this.vel.y = -40;
        const [h, d] = this.checkLiveFlag(LF.UNK1000) ? this.world.checkGroundIgnoreWaterSurface(next.x, next.y + this.headHeight, next.z) : this.world.checkGround(next.x, next.y + this.headHeight, next.z);
        this.groundPlane = d; this.groundHeight = h + 1;
        if (next.y <= this.groundHeight + 0.05) {
            if (this.groundPlane.isIllegal()) this.kill();
            this.offLiveFlag(LF.AIRBORNE);
            this.vel.set(0, 0, 0);
            next.y = this.groundHeight;
        } else this.onLiveFlag(LF.AIRBORNE);
        this.world.isTouchedOneWallAndMoveXZ(next, next.y + this.headHeight, this.bodyRadius);
        this.posDelta.set(V3.sub(next, this.pos));
    }
    control() { if (this.spine) this.spine.update(); }
    calcRootMatrix() { this.calcRootMatrixBasic(); }
    /** TLiveActor::calcRootMatrix: MsMtxSetXYZRPH(getModel()->getBaseTRMtx(), ...) */
    calcRootMatrixBasic() { MsMtxSetXYZRPH(this.baseTR, this.pos.x, this.pos.y, this.pos.z, this.rot.x, this.rot.y, this.rot.z); }
    setGroundCollision() { if (this.mapCollision) this.mapCollision.moveSRT(this.pos, this.rot, this.scale); }
    moveObject() {
        this.ensureTakeSituation();
        this.posDelta.zero(); this.rotDelta.zero();
        this.control();
        this.calcRideMomentum();
        this.bind();
        this.pos.add(this.posDelta);
        this.rot.add(this.rotDelta);
        this.setGroundCollision();
        this.calcRidePos();
    }
    kill() { this.liveFlag |= LF.DEAD | LF.UNK40; }
    // ---- the animation sounds (anmsound.ts: TLiveActor::setAnmSound / setCurAnmSound / updateAnmSound)
    anmSoundPath: string | null = null;
    anmSound: AnmSound | null = null;
    /** the BCK index setCurAnmSound last looked at (the sim sets the sound on each BCK change, as the game's ports of it do) */
    private anmSoundBck = -2;
    /** getBasNameTable: the class's table (bastables.ts, by the class or the nearest one it extends) */
    getBasNameTable(): (string | null)[] | null {
        for (let c: any = this.constructor; c && c !== Object; c = Object.getPrototypeOf(c)) { const t = BAS_TABLES[c.name]; if (t) return t; }
        return null;
    }
    getBas(i: number) { const t = this.getBasNameTable(); return t && i >= 0 ? t[i] ?? null : null; }
    setAnmSound(path: string | null) {
        this.anmSoundPath = path;
        this.anmSound = path ? new AnmSound(loadBas(this.world, path)) : null;
    }
    setCurAnmSound() { const i = this.mactor ? this.mactor.getCurAnmIdx(ANM_BCK) : -1; this.anmSoundBck = i; this.setAnmSound(this.getBas(i)); }
    updateAnmSound() {
        if (!this.mactor) return;
        // (an actor with a table: its sound follows its BCK, as setBckAnm / setCurAnmSound set it)
        if (this.anmSoundAuto) { const i = this.mactor.getCurAnmIdx(ANM_BCK); if (i !== this.anmSoundBck && this.getBasNameTable()) this.setCurAnmSound(); }
        if (!this.anmSoundPath || !this.anmSound) return;
        const fc = this.mactor.getFrameCtrl(ANM_BCK);
        if (fc) this.anmSound.loop(this.world, this.pos, fc.frame, fc.rate);
    }
    /** false: the port sets its sound itself (setAnmSound) */
    anmSoundAuto = true;
    perform(cue: number) {
        if (this.liveFlag & (LF.UNK200 | LF.DEAD)) return;
        if (cue & CUE_MOVE) this.moveObject();
        if (cue & CUE_CALC_ANIM) this.updateAnmSound();
        if (this.mactor) {
            if (cue & CUE_CALC_ANIM) this.mactor.frameUpdate();
            if (!(this.liveFlag & (LF.HIDDEN | LF.CLIPPED_OUT)) && (cue & CUE_CALC_ANIM)) this.calcRootMatrix();
        }
    }
    performOnlyDraw(cue: number) { if (this.liveFlag & (LF.UNK200 | LF.DEAD)) return; if (this.mactor && (cue & CUE_CALC_ANIM)) this.calcRootMatrix(); }
    getJointTrans(_i: number): V3 { return this.pos.clone(); }
    /** For the viewer: shown at all, and the matrix it's drawn with. */
    drawn() { return !(this.liveFlag & (LF.DEAD | LF.HIDDEN)) && !(this.liveFlag & LF.UNK200); }
}

// ---------------------------------------------------------------- graphs (Enemy/graph.cpp)
export interface RailNode { x: number; y: number; z: number; conns: number[]; flags: number; pitch: number; yaw: number; roll: number; speed: number; periods: number[]; }
export function parseRails(b: Uint8Array): Map<string, RailNode[]> {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength), out = new Map<string, RailNode[]>();
    for (let o = 0; o + 12 <= b.length; o += 12) {
        const n = v.getInt32(o);
        if (n === 0) break;
        const no = v.getUint32(o + 4), ro = v.getUint32(o + 8);
        let e = no; while (b[e]) e++;
        const name = sjis.decode(b.subarray(no, e));
        const nodes: RailNode[] = [];
        for (let i = 0; i < n; i++) {
            const p = ro + i * 0x44;
            const cn = v.getInt16(p + 6);
            const conns: number[] = [], periods: number[] = [];
            for (let k = 0; k < 8; k++) { conns.push(v.getUint16(p + 0x14 + k * 2)); periods.push(v.getFloat32(p + 0x24 + k * 4)); }
            nodes.push({ x: v.getInt16(p), y: v.getInt16(p + 2), z: v.getInt16(p + 4), conns: conns.slice(0, Math.max(0, cn)), flags: v.getUint32(p + 8),
                pitch: v.getUint16(p + 0xC), yaw: v.getUint16(p + 0xE), roll: v.getUint16(p + 0x10), speed: v.getUint16(p + 0x12), periods: periods.slice(0, Math.max(0, cn)) });
        }
        out.set(name, nodes);
    }
    return out;
}

export class GraphWeb {
    nodes: RailNode[];
    goalIdx = -1;
    unk4: number[] = []; unk8: number[] = [];
    dummy: boolean;
    /** unk14: the spline a graph named "S_..." is followed along (TSplineRail) */
    spline: SplineRail | null = null;
    constructor(rail: RailNode[], public name: string) {
        this.dummy = rail.length === 0;
        if (this.dummy) rail = [{ x: 0, y: 0, z: 0, conns: [1], flags: 0, pitch: 0, yaw: 0, roll: 0, speed: 0, periods: [1] }, { x: 0, y: 0, z: 0, conns: [0], flags: 0, pitch: 0, yaw: 0, roll: 0, speed: 0, periods: [1] }];
        this.nodes = rail.map((n) => ({ ...n, conns: n.conns.slice(), periods: n.periods.slice() }));
        this.translateNodes();
        if (name.startsWith('S_') && !this.dummy) this.spline = new SplineRail(this);
    }
    get count() { return this.nodes.length; }
    isDummy() { return this.dummy; }
    point(i: number) { const n = this.nodes[i]; return new V3(n.x, n.y, n.z); }
    /** the first node's two connections include the last and the last's the first (the rail loops) */
    startIsEnd() {
        const N = this.nodes, n = N.length, c0 = N[0].conns, c1 = N[n - 1].conns;
        // (the game reads the first two connection slots whatever the count; an unused slot holds 0)
        if (c0.length > 2 || ((c0[0] ?? 0) !== n - 1 && (c0[1] ?? 0) !== n - 1)) return false;
        if (c1.length > 2 || ((c1[0] ?? 0) !== 0 && (c1[1] ?? 0) !== 0)) return false;
        return true;
    }
    checkFlag(i: number, f: number) { return (this.nodes[i].flags & f) !== 0; }
    private translateNodes() {
        const N = this.nodes;
        for (let i = 0; i < N.length; i++) {
            const n = N[i];
            if (n.flags & 0x8) { const keep = n.conns.map((c, j) => [c, n.periods[j]] as [number, number]).filter(([c]) => !(N[c] && N[c].flags & 0x4)); n.conns = keep.map((k) => k[0]); n.periods = keep.map((k) => k[1]); }
            if (n.flags & 0x200) { const keep = n.conns.map((c, j) => [c, n.periods[j]] as [number, number]).filter(([c]) => c >= i); n.conns = keep.map((k) => k[0]); n.periods = keep.map((k) => k[1]); }
        }
    }
    private conns(i: number, filter: number) {
        const n = this.nodes[i];
        if (filter === -1) return n.conns;
        return n.conns.filter((c) => { const o = this.nodes[c]; return o.flags === 0 || (o.flags & filter); });
    }
    private easy(i: number, prev: number, c: number[]) {
        if (c.length === 0) return i;
        if (c.length === 1) return c[0];
        if (c.length === 2 && prev >= 0) return c[0] !== prev ? c[0] : c[1];
        return null;
    }
    getShortestNextIndex(i: number, prev: number, filter = -1) {
        const c = this.conns(i, filter), e = this.easy(i, prev, c);
        if (e !== null) return e;
        const p = this.point(i);
        let r = -1, min = 0;
        for (const k of c) { if (k === prev) continue; const d = this.point(k).sub(p).squared(); if (r < 0 || min > d) { min = d; r = k; } }
        return r;
    }
    getRandomNextIndex(i: number, prev: number, filter = -1) {
        const c = this.conns(i, filter), e = this.easy(i, prev, c);
        if (e !== null) return e;
        const rnd = Math.trunc(MsRandF() * c.length);
        let r = rnd;
        if (c[rnd] === prev) r = rnd === c.length - 1 ? 0 : c.length - 1;
        return c[r];
    }
    getEscapeFromMarioIndex(i: number, prev: number, pos: V3, mario: V3, filter = -1) {
        const c = this.conns(i, filter), e = this.easy(i, prev, c);
        if (e !== null) return e;
        const m = V3.sub(mario, pos).normalize();
        let r = -1, best = 0;
        for (const k of c) { if (k === prev) continue; const d = this.point(k).sub(pos).normalize().dot(m); if (r < 0 || d < best) { best = d; r = k; } }
        return r;
    }
    getAimToDirNextIndex(i: number, prev: number, dir: V3, pos: V3, filter = -1) {
        const c = this.conns(i, filter), e = this.easy(i, prev, c);
        if (e !== null) return e;
        const d0 = dir.clone().normalize();
        let r = -1, best = 0;
        for (const k of c) { if (k === prev) continue; const d = this.point(k).sub(pos).normalize().dot(d0); if (r < 0 || d > best) { best = d; r = k; } }
        return r;
    }
    getRandomButDirLimited(i: number, prev: number, dir: V3, pos: V3, limit: number, filter = -1) {
        const c = this.conns(i, filter), e = this.easy(i, prev, c);
        if (e !== null) return e;
        const d0 = dir.clone().normalize();
        let r = -1, n = 0;
        for (const k of c) {
            if (k === prev) continue;
            const d = this.point(k).sub(pos).normalize();
            const cr = new V3().cross(d0, d);
            const ang = Math.abs(matan(d0.dot(d), cr.length()) * (360 / 65536));
            if (Math.abs(ang) < limit) { if (n === 0) r = k; else if (MsRandF() < fr(1 / (n + 1))) r = k; n++; }   // (fdivs)
        }
        if (n > 0) return r;
        r = -1; let best = 0;
        for (const k of c) { if (k === prev) continue; const d = this.point(k).sub(pos).normalize().dot(d0); if (r < 0 || d > best) { best = d; r = k; } }
        return r;
    }
    findNearestNodeIndex(p: V3, filter = -1) {
        let r = -1, min = -1;
        for (let i = 0; i < this.nodes.length; i++) {
            if (filter !== -1 && this.checkFlag(i, filter)) continue;
            const d = this.point(i).sub(p).squared();
            if (min < 0 || d < min) { min = d; r = i; }
        }
        return r;
    }
    findNearestVisibleIndex(p: V3, sight: number, len: number, ang: number, filter = -1) {
        let r = -1, min = -1;
        for (let i = 0; i < this.nodes.length; i++) {
            if (filter !== -1 && this.checkFlag(i, filter)) continue;
            const q = this.point(i);
            if (MsIsInSight(p, sight, q, len, ang, 0)) { const d = q.sub(p).squared(); if (min < 0 || d < min) { min = d; r = i; } }
        }
        return r;
    }
    getNeighborNodeIndexByFlag(i: number, prev: number, f: number) {
        const good = this.nodes[i].conns.filter((c) => c !== prev && this.checkFlag(c, f));
        if (!good.length) return -1;
        return good[Math.trunc(MsRandF() * good.length)];
    }
    getNearestPosOnGraphLink(p: V3) {
        let first = true, best = new V3(), min = 0;
        for (let i = 0; i < this.nodes.length; i++) {
            const a = this.point(i);
            for (const c of this.nodes[i].conns) {
                const d = this.point(c).sub(a);
                const t = MsClamp((p.dot(d) - a.dot(d)) / d.squared(), 0, 1);
                const q = d.clone().scale(t).add(a);
                const dd = V3.sub(q, p).squared();
                if (first || dd < min) { best = q; first = false; min = dd; }
            }
        }
        return best;
    }
    calcGraphDirection(n: number) {
        const node = this.nodes[n];
        node.conns.forEach((c, i) => {
            const total = node.periods[i] + this.unk8[n];
            if (this.unk4[c] === 0 || this.unk8[c] > total) { this.unk4[c]++; this.unk8[c] = total; this.calcGraphDirection(c); }
        });
    }
    initGoalIndex(p: V3) {
        this.goalIdx = this.findNearestNodeIndex(p, -1);
        this.unk4 = this.nodes.map(() => 0); this.unk8 = this.nodes.map(() => 0);
        if (this.goalIdx < 0) return;
        this.unk4[this.goalIdx] += 1; this.unk8[this.goalIdx] = 0;
        this.calcGraphDirection(this.goalIdx);
    }
    attachToGround(w: World) {
        for (const n of this.nodes) if (n.flags & 0x10) { const [h, d] = w.checkGround(n.x, n.y, n.z); if (!d.isIllegal()) n.y = Math.trunc(h); }
    }
}

export class GraphTracer {
    /** unk14: where along the spline rail it is (its t) */
    graph: GraphWeb | null = null; cur = -1; prev = -1; unkC = 100; unk10 = 1; unk14 = 0;
    init(g: GraphWeb) { this.graph = g; }
    reset() { this.prev = -1; }
    reset2() { this.cur = -1; }
    setParamFromGraph() {
        this.unk10 = this.cur >= 0 ? this.graph!.nodes[this.cur].pitch * (1 / 65535) : 0;
        if (this.prev >= 0) this.unkC = this.graph!.nodes[this.prev].yaw * 0.01;
    }
    setTo(i: number) { this.prev = -1; this.cur = i; this.setParamFromGraph(); }
    moveTo(i: number) { if (i < 0) return i; this.prev = this.cur; this.cur = i; this.setParamFromGraph(); return i; }
    current() { return this.graph!.point(this.cur); }
    /** a speed in units along the chord from the previous node to the current, as a step of t */
    calcSplineSpeed(sp: number) {
        const g = this.graph!, S = g.spline;
        if (!S || this.prev < 0) return fr(0.001);
        const n = g.count, d = V3.sub(g.point(this.cur), g.point(this.prev));
        const l = psVecMag(d);
        let t1: number, t2: number;
        if (S.closed && this.prev === n - 1 && this.cur === 0) { t1 = S.getNthT(0); t2 = S.getNthT(1); }
        else if (S.closed && this.prev === 0 && this.cur === n - 1) { t1 = S.getNthT(n + 1); t2 = S.getNthT(n); }
        else { t1 = S.getNthT(S.closed ? this.prev + 1 : this.prev); t2 = S.getNthT(S.closed ? this.cur + 1 : this.cur); }
        return fr(fr(sp * fr(t2 - t1)) / l);
    }
    /** t moves on by dt (wrapped on a loop); true when it passes the current node's t */
    traceSpline(dt: number) {
        const g = this.graph!, S = g.spline;
        if (!S) return false;
        const n = g.count, t0 = this.unk14, t9 = fr(t0 + dt);
        let t10: number;
        if (S.closed && this.prev === n - 1 && this.cur === 0) t10 = S.getNthT(n + 1);
        else if (S.closed && this.prev === 0 && this.cur === n - 1) t10 = S.getNthT(this.prev);
        else t10 = S.getNthT(S.closed ? this.cur + 1 : this.cur);
        const result = (dt >= 0 && t0 <= t10 && t10 <= t9) || (dt < 0 && t9 <= t10 && t10 <= t0);
        this.unk14 = S.wrapT(t9);
        return result;
    }
}

/** TPathNode: a fixed point, or an actor (its position at the time asked). */
export class PathNode {
    constructor(public actor: HitActor | null = null, public p = new V3()) { if (actor) this.p.set(actor.pos); }
    point(): V3 { return this.actor ? this.actor.pos : this.p; }
    copy() { return new PathNode(this.actor, this.p.clone()); }
}

/** A random graph choice, or the node a Moonshine RNG control picked for the object there instead (the ghost's tape). */
function overrideNode(i: number) { const n = rngCtx.node ? rngCtx.node(rngCtx.cur) : null; return n !== null && n >= 0 ? n : i; }

// ---------------------------------------------------------------- TSpineEnemy
export class SpineEnemy extends LiveActor {
    goal = new PathNode(); goal104 = new PathNode(); goalStack: PathNode[] = [];
    tracer = new GraphTracer();
    unk128 = 0; unk12C = 0; unk130 = 0;
    distToMarioSq = 0; unk138: BGCheckData | null = null;
    hitPoints = 1; marchSpeed = 1; turnSpeed = 5; bodyScale = 1; wallRadius = 1;
    constructor(world: World, name = '') { super(world, name); this.spine = new Spine(this); }
    get mgr() { return this.manager as EnemyManager | null; }
    /** TSpineEnemy::getSaveParam: the manager's parameters (its TSpineEnemyParams subclass, read). */
    getSaveParam(): any { return this.mgr ? this.mgr.saveParams : null; }
    load(s: Stream) {
        Actor.prototype.load.call(this, s);
        const mgr = s.str();
        const graph = s.str();
        this.tracer.init(this.world.graphByName(graph));
        this.groundPlane = this.world.illegal;
        this.init(this.world.search(mgr) as LiveManager | null);
    }
    init(m: LiveManager | null) {
        super.init(m);
        const p = this.getSaveParam();
        if (p) {
            this.bodyRadius = p.mSLBodyRadius; this.wallRadius = p.mSLWallRadius;
            this.headHeight = p.mSLHeadHeight; this.scaledBodyRadius = fr(this.bodyScale * this.bodyRadius);
        }
    }
    maxHitPoints() { const p = this.getSaveParam(); return p ? p.mSLHitPointMax : 1; }
    resetHitPoints() { this.hitPoints = this.maxHitPoints(); }
    decHitPoints() { if (this.hitPoints > 0) this.hitPoints -= 1; }
    getHeadHeight() { return this.bodyScale * this.headHeight; }
    getBodyRadius() { return this.bodyScale * this.bodyRadius; }
    reset() {
        this.tracer.reset();
        this.goToShortestNextGraphNode();
        this.offLiveFlag(LF.DEAD); this.offLiveFlag(LF.UNK8); this.offLiveFlag(LF.UNK10); this.offLiveFlag(LF.CLIPPED_OUT);
        this.onLiveFlag(LF.UNK800);
        this.spine!.reset();
        this.spine!.pushAfterCurrent(this.spine!.default);
    }
    resetToPosition(p: V3) {
        this.pos.set(p);
        this.offLiveFlag(LF.UNK8); this.offLiveFlag(LF.DEAD);
        this.reset();
        this.resetHitPoints();
        this.offHitFilter(HF.NO_COLLISION);
        this.vel.set(0, 5, 0);
        this.onLiveFlag(LF.UNK8000); this.onLiveFlag(LF.AIRBORNE);
        this.control();
    }
    calcEnemyRootMatrix() {
        const m = this.baseTR;
        const setCols = (v1: V3, v2: V3, v3: V3) => { m[0] = v1.x; m[4] = v1.y; m[8] = v1.z; m[1] = v2.x; m[5] = v2.y; m[9] = v2.z; m[2] = v3.x; m[6] = v3.y; m[10] = v3.z; };
        if (this.unk130 === 0) MsMtxSetRotRPH(m, this.rot.x, this.rot.y, this.rot.z);
        else if (this.unk130 >= 2 && !this.isAirborne() && this.unk138) {
            const v2 = new V3(this.unk138.n[0], this.unk138.n[1], this.unk138.n[2]);
            const v1 = new V3().cross(v2, new V3(0, 1, 0)).normalize();
            const v3 = new V3().cross(v1, v2).normalize();
            setCols(v1, v2, v3);
        } else if (this.unk130 >= 1 && !this.groundPlane.isIllegal()) {
            const v2 = new V3(this.groundPlane.n[0], this.groundPlane.n[1], this.groundPlane.n[2]);
            const v1 = new V3().cross(v2, new V3(MsSin(this.rot.y), 0, MsCos(this.rot.y))).normalize();
            const v3 = new V3().cross(v1, v2).normalize();
            setCols(v1, v2, v3);
        } else MsMtxSetRotRPH(m, this.rot.x, this.rot.y, this.rot.z);
        m[3] = this.pos.x; m[7] = this.pos.y; m[11] = this.pos.z;
    }
    calcRootMatrix() {
        if (this.holder && this.holder.held === this) {
            const src = this.holder.getTakingMtx();
            if (src) { this.baseTR.set(src); this.pos.set(src[3], src[7], src[11]); return; }
        }
        this.calcEnemyRootMatrix();
    }
    updateSquareToMario() { this.distToMarioSq = sqDist(this.pos, this.world.mario.pos); }
    receiveMessage(sender: HitActor, msg: number) {
        if (msg === MSG.TAKE && !this.holder) { this.holder = sender as TakeActor; return true; }
        if (msg <= MSG.PUSH_UP) { this.kill(); return true; }
        return false;
    }
    isInSight(p: V3, len: number, ang: number, aware: number) { return MsIsInSight(this.pos, this.rot.y, p, len, ang, aware); }
    setGoalPathFromGraph() { const p = this.tracer.current(); this.goal = new PathNode(null, p); this.goal104 = new PathNode(null, p.clone()); this.goalStack = []; }
    setGoalPath(n: PathNode) { this.goal = n.copy(); this.goal104 = n.copy(); this.goalStack = []; }
    /** unk114 (TSolidStack<TPathNode>(4)) */
    pushGoal(n: PathNode) { if (this.goalStack.length < 4) this.goalStack.push(n.copy()); }
    popGoal() { return this.goalStack.length ? this.goalStack.pop()! : this.goal.copy(); }
    /** switchNextGoalPath: the next goal off the stack (if any) */
    switchNextGoalPath() { if (this.goalStack.length) this.goal = this.goalStack.pop()!; }
    zigzagToCurPathNode(speed: number, turn: number, cycle: number, angle: number) {
        if (this.tracer.unk10 === 0) { this.walkToCurPathNode(speed, turn, 0); return; }
        let a = angle * this.tracer.unk10;
        const dist = V3.sub(this.goal.point(), this.pos).length();
        let ph = MsWrap(dist, 0, cycle) * (360 * (1 / cycle)) + this.getPhaseShift();
        a *= MsSin(ph);
        const target = a + MsGetRotFromZaxisY(V3.sub(this.goal.point(), this.pos));
        const diff = MsAngleDiff(target, this.rot.y);
        let r: number;
        // (the game's code reads its minimum turn radius before setting it in one branch: walkToCurPathNode's rule here)
        if (dist > this.calcMinimumTurnRadius(speed, turn) * 2) r = diff > 0 ? Math.min(diff, turn) : Math.max(diff, -turn);
        else { const ts = this.calcTurnSpeedToReach(speed, dist * 0.5); r = diff > 0 ? Math.min(diff, ts) : Math.max(diff, -ts); }
        this.rot.y = MsWrap(this.rot.y + r, 0, 360);
        this.posDelta.add(new V3(speed * MsSin(this.rot.y), 0, speed * MsCos(this.rot.y)));
        if (Math.abs(dist - this.unk12C) < 100) this.unk128 += 1; else { this.unk128 = 0; this.unk12C = dist; }
    }
    getPhaseShift() { return 0; }
    doShortCut() {
        if (this.goalStack.length <= 0) return;
        if (V3.sub(this.goal.point(), this.pos).length() < this.getBodyRadius()) { if (this.goalStack.length) this.goal = this.popGoal(); return; }
        const node = this.popGoal();
        const d = V3.sub(node.point(), this.pos);
        if (d.x === 0 && d.y === 0 && d.z === 0) d.x = 1;
        d.normalize().scale(this.marchSpeed).add(this.pos);
        const p = { x: d.x, z: d.z };
        if (!this.world.isTouchedOneWallAndMoveXZ(p, d.y + this.getHeadHeight(), this.getBodyRadius() * 2)) { if (this.goalStack.length) this.goal = this.popGoal(); }
    }
    goToShortestNextGraphNode() {
        const t = this.tracer, g = t.graph;
        if (!g) return -1;
        if (t.cur < 0) t.setTo(g.findNearestNodeIndex(this.pos, -1));
        else t.moveTo(g.getShortestNextIndex(t.cur, t.prev, -1));
        if (t.cur < 0) return -1;
        this.setGoalPathFromGraph(); this.unk128 = 0; this.unk12C = 0;
        return 0;
    }
    jumpToNextGraphNode() {
        const t = this.tracer, g = t.graph!;
        if (t.cur < 0 || !g.checkFlag(t.cur, 1)) return -1;
        const i = g.getNeighborNodeIndexByFlag(t.cur, t.prev, 2);
        if (i >= 0) { t.moveTo(i); this.setGoalPathFromGraph(); this.unk128 = 0; this.unk12C = 0; return i; }
        return -1;
    }
    goToRandomNextGraphNode() {
        const t = this.tracer, g = t.graph!;
        if (t.cur < 0) t.setTo(g.findNearestNodeIndex(this.pos, -1));
        else t.moveTo(overrideNode(g.getRandomNextIndex(t.cur, t.prev, -1)));
        this.setGoalPathFromGraph(); this.unk128 = 0; this.unk12C = 0;
    }
    goToRandomEscapeGraphNode() {
        const t = this.tracer, g = t.graph!;
        if (t.cur < 0) t.setTo(g.findNearestNodeIndex(this.pos, -1));
        else t.moveTo(overrideNode(g.getEscapeFromMarioIndex(t.cur, -1, this.pos, this.world.mario.pos, -1)));
        this.setGoalPathFromGraph(); this.unk128 = 0; this.unk12C = 0;
    }
    goToExclusiveNextGraphNode() {
        if (!this.manager) { this.goToRandomNextGraphNode(); return; }
        const t = this.tracer, g = t.graph!;
        if (t.cur < 0) t.setTo(g.findNearestNodeIndex(this.pos, -1));
        else {
            let idx = g.getRandomNextIndex(t.cur, t.prev, -1);
            for (const e of this.manager.objs as SpineEnemy[]) if (e !== this && idx === e.tracer.cur) idx = g.getRandomNextIndex(t.cur, idx, -1);
            t.moveTo(overrideNode(idx));
        }
        this.setGoalPathFromGraph(); this.unk128 = 0; this.unk12C = 0;
    }
    goToDirectedNextGraphNode(dir: V3) {
        const t = this.tracer, g = t.graph!;
        if (t.cur < 0) t.setTo(g.findNearestNodeIndex(this.pos, -1));
        else t.moveTo(g.getAimToDirNextIndex(t.cur, t.prev, dir, this.pos, -1));
        this.setGoalPathFromGraph(); this.unk128 = 0; this.unk12C = 0;
    }
    goToDirLimitedNextGraphNode(limit: number) {
        const t = this.tracer, g = t.graph!;
        if (t.cur < 0) t.setTo(g.findNearestNodeIndex(this.pos, -1));
        else t.moveTo(overrideNode(g.getRandomButDirLimited(t.cur, t.prev, new V3(MsSin(this.rot.y), 0, MsCos(this.rot.y)), this.pos, limit, -1)));
        this.setGoalPathFromGraph(); this.unk128 = 0; this.unk12C = 0;
    }
    calcMinimumTurnRadius(speed: number, turn: number) {
        if (turn >= 90) return 0;
        const s = MsSin(turn);
        return s === 0 ? 100000 : (speed * MsSin(-(turn * 0.5 - 90))) / s;
    }
    calcTurnSpeedToReach(speed: number, d: number) {
        if (d === 0) return 0;
        const f = d * 2 * d;
        const c = MsClamp(-(speed * speed - f) / f, -1, 1);
        if (c === 1) return 0;
        if (c === -1) return 180;
        const s = Math.sqrt(-(c * c - 1));
        return 90 - matan(s, c) * (360 / 65536);
    }
    turnToCurPathNode(max: number) {
        const t = V3.sub(this.goal.point(), this.pos);
        let r = MsAngleDiff(MsGetRotFromZaxisY(t), this.rot.y), done = false;
        if (r > 0) { if (r < max) done = true; else r = max; }
        else { if (r > -max) done = true; else r = -max; }
        this.rot.y = MsWrap(this.rot.y + r, 0, 360);
        return done;
    }
    walkToCurPathNode(speed: number, turn: number, offset: number) {
        const t = V3.sub(this.goal.point(), this.pos);
        const dist = t.length();
        const ang = MsWrap(offset + MsGetRotFromZaxisY(t), 0, 360);
        const diff = MsAngleDiff(ang, this.rot.y);
        let r: number;
        if (dist > this.calcMinimumTurnRadius(speed, turn) * 2) r = diff > 0 ? Math.min(diff, turn) : Math.max(diff, -turn);
        else { const ts = this.calcTurnSpeedToReach(speed, dist * 0.5); r = diff > 0 ? Math.min(diff, ts) : Math.max(diff, -ts); }
        this.rot.y = MsWrap(this.rot.y + r, 0, 360);
        this.posDelta.add(new V3(speed * MsSin(this.rot.y), 0, speed * MsCos(this.rot.y)));
        if (Math.abs(dist - this.unk12C) < 100) this.unk128 += 1;
        else { this.unk128 = 0; this.unk12C = dist; }
    }
    isReachedToGoal() { return V3.sub(this.goal104.point(), this.pos).length() < 100; }
    getCurAnmFrameNo(type: number) {
        const m = this.mgr, a = this.mactor!;
        const set = m ? m.getSharedMActorSet(a.getCurAnmIdx(type)) : null;
        return set ? set.get(this.instanceIndex).getFrameCtrl(type)!.frame : a.getFrameCtrl(type)!.frame;
    }
    checkCurAnmEnd(type: number) {
        const m = this.mgr, a = this.mactor!;
        const set = m ? m.getSharedMActorSet(a.getCurAnmIdx(type)) : null;
        return set ? set.get(this.instanceIndex).curAnmEndsNext(type) : a.curAnmEndsNext(type);
    }
    perform(cue: number) {
        const m = this.mgr;
        if (m) {
            if ((cue & CUE_CALC_ANIM) && !this.checkLiveFlag(LF.HIDDEN | LF.CLIPPED_OUT) && m.copyIdx >= 0) {
                if (this.checkLiveFlag(LF.DEAD | LF.UNK200)) return;
                if (m.copyAnmMtx(this)) return;
            }
        } else if ((cue & CUE_CALC_ANIM) && !this.checkLiveFlag(LF.HIDDEN | LF.CLIPPED_OUT) && this.checkLiveFlag(LF.DEAD | LF.UNK200)) return;
        super.perform(cue);
    }
}

// ---------------------------------------------------------------- TEnemyManager
/** TSharedMActorSet: animations several enemies show at once (each at its own phase). */
export class SharedMActorSet {
    mactors: MActor[] = []; idx = -1;
    init(data: AnmData, model: string, bck: string, n: number) {
        for (let i = 0; i < n; i++) {
            const a = new MActor(model, data);
            a.setBck(bck);
            const c = a.getFrameCtrl(ANM_BCK)!;
            c.frame = (1 / n) * c.end * i;
            this.mactors.push(a);
        }
        this.idx = this.mactors[0] ? this.mactors[0].getCurAnmIdx(ANM_BCK) : -1;
    }
    get(i: number) { return this.mactors[i % this.mactors.length]; }
}

export class EnemyManager extends LiveManager {
    /** unk38: the enemies' parameters (a TSpineEnemyParams subclass, read). */
    saveParams: any = null;
    /** unk4C: the BCK whose joints copyAnmMtx shares (-1: none). */
    copyIdx = -1;
    sharedNum = 0;
    shared: SharedMActorSet[] | null = null;
    constructor(world: World, name = '') { super(world, name); world.conductor.enemyManagers.push(this); }
    load(s: Stream) { super.load(s); this.createModelData(); this.sharedNum = s.s32(); }
    createEnemyInstance(): SpineEnemy | null { return null; }
    createEnemies(count: number) {
        if (count + this.getObjNum() > this.capacity) count = this.capacity - this.getObjNum();
        const inst = this.saveParams ? this.saveParams.mSLInstanceNum : -1;
        if (this.saveParams && count + this.getObjNum() > inst) count = inst - this.getObjNum();
        if (count < 0) return;
        for (let i = 0; i < count; i++) {
            const e = this.createEnemyInstance();
            if (!e) continue;
            this.world.addToGroup('敵グループ', e);
            e.init(this);
        }
    }
    createSharedMActorSet(names: string[]) {
        if (this.sharedNum <= 0 || !this.modelFiles[0]) return;
        const n = this.sharedNum;
        this.shared = names.map((b) => { const s = new SharedMActorSet(); s.init(this.getMActorAnmData(), this.modelFiles[0], b, n); return s; });
        this.sharedNum = names.length;
    }
    /** copyAnmMtx: an enemy on the shared animation just moves its animation on (no movement this tick). */
    copyAnmMtx(e: SpineEnemy) {
        if (this.copyIdx !== e.mactor!.getCurAnmIdx(ANM_BCK)) return false;
        e.calcRootMatrix();
        e.updateAnmSound();
        e.mactor!.frameUpdate();
        return true;
    }
    getSharedMActorSet(idx: number) { if (!this.shared) return null; for (const s of this.shared) if (s.idx === idx) return s; return null; }
    getActiveObjNum() {
        if (!this.saveParams) return this.getObjNum();
        const n = this.saveParams.mSLActiveEnemyNum;
        return n > this.getObjNum() ? this.getObjNum() : n;
    }
    clipActors() {
        const p = this.saveParams;
        this.clipActorsAux(p ? p.mSLFarClip : 5000, p ? p.mSLClipRadius : 300);
    }
    perform(cue: number) {
        if (this.shared) { this.performShared(cue); return; }
        if (cue & CUE_CALC_ANIM) { this.clipActors(); this.setFlagOutOfCube(); }
        const num = this.getActiveObjNum();
        if (cue & CUE_MOVE) for (let i = num; i < this.objs.length; i++) (this.objs[i] as LiveActor).onLiveFlag(LF.DEAD);
        for (let i = 0; i < num; i++) this.objs[i].testPerform(cue);
    }
    performShared(cue: number) {
        const num = this.getActiveObjNum();
        let alive = 0;
        for (let i = 0; i < num; i++) if (!(this.objs[i] as LiveActor).checkLiveFlag(LF.DEAD)) alive++;
        if (alive <= 0) return;
        if (cue & CUE_CALC_ANIM) {
            this.clipActors();
            for (const s of this.shared!) for (const a of s.mactors) a.frameUpdate();
            // setSharedFlags
            for (const e of this.objs as SpineEnemy[]) {
                e.offLiveFlag(LF.UNK4000);
                if (!e.checkLiveFlag(LF.HIDDEN | LF.CLIPPED_OUT)) {
                    const idx = e.mactor!.getCurAnmIdx(ANM_BCK);
                    for (const s of this.shared!) if (idx < 0 || idx === s.idx) { e.onLiveFlag(LF.UNK4000); break; }
                }
            }
        }
        if (cue & CUE_MOVE) for (let i = num; i < this.objs.length; i++) this.objs[i].onHitFilter(HF.NO_COLLISION);
        for (let i = 0; i < num; i++) {
            const e = this.objs[i] as SpineEnemy;
            if (e.checkLiveFlag(LF.DEAD)) continue;
            if (cue & CUE_MOVE) e.moveObject();
            if (cue & CUE_CALC_ANIM) {
                e.updateSquareToMario();
                e.calcRootMatrix();
                if (!e.checkLiveFlag(LF.UNK4000)) e.mactor!.frameUpdate();
                else e.mactor!.matAnmFrameUpdate();
            }
        }
    }
    getNearestEnemy(p: V3) { let best: SpineEnemy | null = null, d = 0; for (let i = 0; i < this.getActiveObjNum(); i++) { const c = this.objs[i] as SpineEnemy; if (c.checkLiveFlag(LF.DEAD)) continue; const x = Math.sqrt(sqDist(p, c.pos)); if (!best || d > x) { best = c; d = x; } } return best; }
    countLivingEnemy() { let n = 0; for (let i = 0; i < this.getActiveObjNum(); i++) if (!(this.objs[i] as LiveActor).checkLiveFlag(LF.DEAD)) n++; return n; }
    killChildren() { for (const o of this.objs as LiveActor[]) o.onLiveFlag(LF.DEAD | LF.UNK40); }
}

// ---------------------------------------------------------------- TObjHitCheck
function checkDistance(a: V3, ar: number, ah: number, b: V3, dr: number, dh: number) {
    if (a.y > b.y + dh) return false;
    if (a.y + ah < b.y) return false;
    const r = ar + dr, dx = a.x - b.x, dz = a.z - b.z;
    return !(r * r <= dx * dx + dz * dz);
}
export const IDX = { MAP: 0, EMPTY: 1, MANAGER: 2, OBJECT: 3, GRAFFITI: 4, ITEM: 5, PLAYER: 6, ENEMY: 7, BOSS: 8, NPC: 9, WATER_PARTICLE: 10, INIT: 11 };
export class ObjHitCheck {
    table: HitActor[][] = [];
    constructor(public w: World) { }
    private index(p: V3, r: number): [number, number] {
        const s = Math.abs(p.x) + Math.abs(p.y) + Math.abs(p.z);
        const i = (Math.trunc((s - r) * (10 / 700)) >>> 0) & 0xFF;
        let e = Math.trunc((s + r) * (10 / 700)) >>> 0;
        if (((Math.trunc((s - r) * (10 / 700))) >>> 0) === e) e += 1;
        return [i, e & 0xFF];
    }
    private suffer(att: HitActor, suf: HitActor) {
        if (att.collisions.length >= att.colCapacity) return;
        if (att.collisions.includes(suf)) return;
        att.collisions.push(suf);
    }
    private checkInList(a: HitActor, list: HitActor[]) {
        // (the game's lists are newest first)
        for (let k = list.length - 1; k >= 0; k--) {
            const c = list[k];
            if (!a.checkHitFilter(HF.NO_ATTACK) && !c.checkHitFilter(HF.NO_DAMAGE) && a.canAttack(c)
                && checkDistance(a.pos, a.attackRadius, a.attackHeight, c.pos, c.damageRadius, c.damageHeight)) this.suffer(a, c);
            if (!c.checkHitFilter(HF.NO_ATTACK) && !a.checkHitFilter(HF.NO_DAMAGE) && c.canAttack(a)
                && checkDistance(c.pos, c.attackRadius, c.attackHeight, a.pos, a.damageRadius, a.damageHeight)) this.suffer(c, a);
        }
    }
    private entry(a: HitActor, i: number) {
        if (!a.checkHitFilter(HF.NO_ATTACK) || !a.checkHitFilter(HF.NO_DAMAGE)) this.table[i].push(a);
    }
    private entryGroup(g: HitActor[] | null, check: boolean) {
        if (!g) return;
        for (const a of g) {
            a.collisions.length = 0;
            if (a.checkHitFilter(HF.NO_COLLISION)) continue;
            let [i, e] = this.index(a.pos, a.entryRadius);
            while (i !== e) {
                if (check) this.checkInList(a, this.table[i]);
                this.entry(a, i);
                i = i === 0xFF ? 0 : i + 1;
            }
        }
    }
    clearHitNum() { for (const k of [IDX.ENEMY, IDX.BOSS, IDX.NPC, IDX.PLAYER, IDX.WATER_PARTICLE, IDX.ITEM]) for (const a of this.w.groups[k] || []) a.collisions.length = 0; }
    checkActorsHit() {
        this.table = []; for (let i = 0; i < 256; i++) this.table.push([]);
        const g = this.w.groups;
        this.entryGroup(g[IDX.OBJECT], false);
        this.entryGroup(g[IDX.ENEMY], true);
        this.entryGroup(g[IDX.BOSS], true);
        this.entryGroup(g[IDX.NPC], true);
        this.entryGroup(g[IDX.PLAYER], true);
        this.w.checkWater(this);
        const m = this.w.mario;
        for (const a of g[IDX.ITEM] || []) {
            a.collisions.length = 0;
            if (a.checkHitFilter(HF.NO_COLLISION)) continue;
            if (checkDistance(a.pos, a.attackRadius, a.attackHeight, m.pos, m.damageRadius, m.damageHeight)) this.suffer(a, m);
        }
    }
    /** checkWaterWithActorsInList for a drop at p: undefined when its cells span nothing (the slot keeps what it had). */
    waterHitAt(p: V3, ar: number, ah: number, er: number): HitActor | null | undefined {
        const [i, e] = this.index(p, er);
        if (i === e) return undefined;
        const L = this.table[i];
        for (let k = L.length - 1; k >= 0; k--) {
            const c = L[k];
            if (c.isHitCategory(HC.PLAYER) || c.checkHitFilter(HF.NO_DAMAGE)) continue;
            if (checkDistance(p, ar, ah, c.pos, c.damageRadius, c.damageHeight)) return c;
        }
        return null;
    }
}

// ---------------------------------------------------------------- TConductor
export class Conductor {
    liveManagers: LiveManager[] = []; enemyManagers: EnemyManager[] = []; aloneActors: LiveActor[] = []; generators: NameRef[] = []; others: NameRef[] = [];
    constructor(public w: World) { }
    init() {
        for (const m of this.enemyManagers) if (m.name !== 'ヒノクリ２マネージャー' && m.name !== 'ボスゲッソーマネージャー') m.createEnemies(m.capacity);
    }
    getManagerByName(name: string) { return this.liveManagers.find((m) => m.name === name) || null; }
    makeOneEnemyAppear(p: V3, name: string, mode: number): SpineEnemy | null {
        const m = this.getManagerByName(name) as EnemyManager | null;
        if (!m) return null;
        let r = m.getActorByFlag(LF.DEAD) as SpineEnemy | null;
        if (r) { r.resetToPosition(p); return r; }
        if (mode === 0) return null;
        r = m.getActorByFlag(LF.CLIPPED_OUT | LF.UNK800) as SpineEnemy | null;
        if (r) { r.resetToPosition(p); return r; }
        if (mode === 1) return null;
        r = m.objs[0] as SpineEnemy;
        r.resetToPosition(p);
        return r;
    }
    /** genEnemyFromPollution (enemies/enemytable.ts sets it when the stage has a TStageEnemyInfoTable) */
    performHead: ((cue: number) => void) | null = null;
    perform(cue: number) {
        if (this.performHead) this.performHead(cue);
        for (let i = 1; i >= 0; --i) {
            for (const m of this.liveManagers) if ((i !== 0) === m.hasMapCollision()) m.testPerform(cue);
            for (const a of this.aloneActors) if ((i !== 0) === a.hasMapCollision()) a.testPerform(cue);
        }
        for (const g of this.generators) g.testPerform(cue);
        for (const o of this.others) o.testPerform(cue);
    }
}

declare module './engine.js' {
    interface World {
        addToGroup(name: string, a: HitActor): void;
        inAreaCube(p: V3): boolean;
        inView(p: V3, r: number, far: number, near?: number): boolean;
        effect(kind: string, p: V3, s?: V3): void;
        newAndRegisterCoin(id: number): any;
        makeCoinAppear(coin: any): any;
        makeCoinAt(x: number, y: number, z: number): any;
        checkWater(h: ObjHitCheck): void;
    }
}
World.prototype.addToGroup = function (this: World, name: string, a: HitActor) {
    const idx = GROUP_NAMES.indexOf(name);
    if (idx >= 0) (this.groups[idx] = this.groups[idx] || []).push(a);
};
World.prototype.inAreaCube = function () { return true; };
/** Effects and sounds the game makes (particles, splashes): told to the viewer. */
World.prototype.effect = function (this: World, kind: string, p: V3, s?: V3) { this.events.push({ t: this.tickCount, kind, data: { p: p.clone(), s: s ? s.clone() : null } }); };
World.prototype.newAndRegisterCoin = function () { return null; };
World.prototype.makeCoinAppear = function (this: World, _c: any) { return null; };
World.prototype.makeCoinAt = function (this: World, x: number, y: number, z: number) { this.events.push({ t: this.tickCount, kind: 'coin', data: { p: new V3(x, y, z) } }); return null; };
/** ViewFrustumClipCheck against the frame's game camera (SetViewFrustumClipCheckPerspective's planes). */
World.prototype.inView = function (this: World, p: V3, r: number, far: number, near?: number) {
    const c = (this as any).clipCamera as { pos: number[]; quat: number[]; fovy: number; aspect: number; near: number } | null;
    if (!c) return true;
    // into view space: the inverse of the camera's rotation
    const [qx, qy, qz, qw] = c.quat;
    const dx = p.x - c.pos[0], dy = p.y - c.pos[1], dz = p.z - c.pos[2];
    const tx = 2 * (-qy * dz + qz * dy), ty = 2 * (-qz * dx + qx * dz), tz = 2 * (-qx * dy + qy * dx);
    const x = dx + qw * tx + (-qy * tz + qz * ty), y = dy + qw * ty + (-qz * tx + qx * tz), z = dz + qw * tz + (-qx * ty + qy * tx);
    const tv = Math.tan((c.fovy * Math.PI) / 360), th = tv * c.aspect;
    if (-z - (near ?? c.near) < -r || far + z < -r) return false;
    const kv = 1 / Math.sqrt(1 + tv * tv), kh = 1 / Math.sqrt(1 + th * th);
    if (-(x + z * th) * kh < -r || (x - z * th) * kh < -r) return false;
    if (-(y + z * tv) * kv < -r || (y - z * tv) * kv < -r) return false;
    return true;
};
World.prototype.checkWater = function (this: World, h: ObjHitCheck) { if (this.water) this.water.checkHits(h); };
/** TStrategy's groups by index (IDX). */
export const GROUP_NAMES = ['マップグループ', '空グループ', 'マネージャーグループ', 'オブジェクトグループ', '落書きグループ', 'アイテムグループ', 'プレーヤーグループ', '敵グループ', 'ボスグループ', 'ＮＰＣグループ', '水パーティクルグループ', '初期化用グループ'];

/**
 * TMapCollisionMove: an actor's collision file, put into the move grid (which TMap::perform empties
 * every tick) wherever its matrix says (moveMtx / moveSRT).
 */
export class MoveCollision {
    private src: BGCheckData[] = [];
    tris: BGCheckData[] = [];
    constructor(public w: World, path: string, public owner: LiveActor | null) {
        const b = w.files.scene(path.replace(/^\/?scene\//i, '').replace(/^\//, ''));
        if (b) this.src = MapCollision.readCol(b.slice().buffer);
    }
    /** moveActiveCollisionMtx with a column-major 4x4 (a joint's anmMtx). */
    moveMat4(m: ArrayLike<number>) {
        const tf = (p: number[]) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
        this.tris = this.src.map((s) => {
            const d = new BGCheckData();
            d.bgType = s.bgType; d.data = s.data; d.flags = s.flags & ~0x8;
            d.setVertex(tf(s.p1), tf(s.p2), tf(s.p3));
            d.actor = this.owner;
            this.w.col.add(d, 'move');
            return d;
        });
    }
    moveSRT(p: V3, r: V3, sc: V3) {
        const m = mtx(); MsMtxSetXYZRPH(m, p.x, p.y, p.z, r.x, r.y, r.z);
        this.moveMat4([m[0] * sc.x, m[4] * sc.x, m[8] * sc.x, 0, m[1] * sc.y, m[5] * sc.y, m[9] * sc.y, 0, m[2] * sc.z, m[6] * sc.z, m[10] * sc.z, 0, m[3], m[7], m[11], 1]);
    }
}
/** TMapCollisionWarp: a collision file put into the map's lists at a place and taken out again. */
export class WarpCollision {
    tris: BGCheckData[] = [];
    private src: BGCheckData[] = [];
    setUp = false;
    constructor(public w: World, path: string, public owner: LiveActor | null) {
        const b = w.files.scene(path.replace(/^\/?scene\//i, '').replace(/^\//, ''));
        if (b) this.src = MapCollision.readCol(b.slice().buffer);
    }
    isSetUp() { return this.setUp; }
    setUpTrans(p: V3) {
        if (this.setUp) return;
        this.setUp = true;
        this.tris = this.src.map((s) => {
            const d = new BGCheckData();
            d.bgType = s.bgType; d.data = s.data; d.flags = s.flags & ~0x8;
            d.setVertex([s.p1[0] + p.x, s.p1[1] + p.y, s.p1[2] + p.z], [s.p2[0] + p.x, s.p2[1] + p.y, s.p2[2] + p.z], [s.p3[0] + p.x, s.p3[1] + p.y, s.p3[2] + p.z]);
            d.actor = this.owner;
            this.w.col.add(d, 'static');
            return d;
        });
    }
    remove() { if (!this.setUp) return; this.setUp = false; for (const d of this.tris) this.w.col.remove(d); this.tris = []; }
}
