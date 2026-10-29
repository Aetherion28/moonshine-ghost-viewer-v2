// What the map objects of MapObjBianco.cpp and its neighbours share: MarioUtil/MathUtil.hpp's
// rotation matrices, MapObjLib.cpp's helpers that aren't in base.ts (the water drop queries,
// makeRootMtxRot*, getVerticalVecToTargetXZ, TMapObjLibWave, TMapObjMessenger), the root and
// joint matrices a map object writes itself (J3DModel::setAnmMtx: for the viewer, its base
// matrix or its joints' local matrices), MoveBG/MapObjWave.cpp (gpMapObjWave, the sea's height),
// the stream cubes (gpCubeStream over tables.bin's 流れキューブテーブル) and the Mario queries
// (SMS_GetMario*, TWaterGun) as the Mario the stage has can answer them.

import { mat4 } from 'gl-matrix';
import { fr, V3, Mtx, mtx, MsSin, MsCos, MsRandF, sinf, cosf, HALF_PI_F } from '../math.js';
import { fmadd as FMA, fmsub as FMS } from '../player/fmath.js';
import { vNormMs } from '../vecops.js';
import { World, NameRef, Stream, HitActor, LiveActor, parseSceneBin, SceneNode, CUE_MOVE, readParams } from '../engine.js';
import { isPointInCube } from '../mapwire.js';
import { Skeleton, jointMatrices } from '../skeleton.js';
import type { BGCheckData } from '../collision.js';
import { register } from '../scene.js';
import type { MapObjBase } from './base.js';

// ---------------------------------------------------------------- matrices (row-major 3x4: m[r * 4 + c])
/** MsMtxSetRotX */
export function MsMtxSetRotX(m: Mtx, deg: number) {
    const s = MsSin(deg), c = MsCos(deg);
    m[0] = 1; m[1] = 0; m[2] = 0; m[3] = 0;
    m[4] = 0; m[5] = c; m[6] = -s; m[7] = 0;
    m[8] = 0; m[9] = s; m[10] = c; m[11] = 0;
}
/** MsMtxSetRotY */
export function MsMtxSetRotY(m: Mtx, deg: number) {
    const s = MsSin(deg), c = MsCos(deg);
    m[0] = c; m[1] = 0; m[2] = s; m[3] = 0;
    m[4] = 0; m[5] = 1; m[6] = 0; m[7] = 0;
    m[8] = -s; m[9] = 0; m[10] = c; m[11] = 0;
}
/** MsMtxSetRotZ */
export function MsMtxSetRotZ(m: Mtx, deg: number) {
    const s = MsSin(deg), c = MsCos(deg);
    m[0] = c; m[1] = -s; m[2] = 0; m[3] = 0;
    m[4] = s; m[5] = c; m[6] = 0; m[7] = 0;
    m[8] = 0; m[9] = 0; m[10] = 1; m[11] = 0;
}
/**
 * PSMTXConcat(a, b, out): out = a * b (out may be a or b). The paired-single code (dolphin mtx.c):
 * per element ps_muls0, ps_madds1, ps_madds0 (b0j a0, + b1j a1, + b2j a2, each rounded to f32),
 * the translation column then ps_madds1 by Unit01 (+ 1 * a3).
 */
export function MTXConcat(a: Mtx, b: Mtx, out: Mtx) {
    const r = new Float64Array(12);
    for (let i = 0; i < 3; i++) {
        const a0 = a[i * 4], a1 = a[i * 4 + 1], a2 = a[i * 4 + 2];
        for (let j = 0; j < 4; j++) {
            let v = fr(fr(fr(b[j] * a0) + b[4 + j] * a1) + b[8 + j] * a2);
            if (j === 3) v = fr(a[i * 4 + 3] + v);
            r[i * 4 + j] = v;
        }
    }
    out.set(r);
    return out;
}
/** PSMTXRotAxisRad around a unit axis */
export function MTXRotAxisRad(m: Mtx, ax: V3, rad: number) {
    const s = Math.sin(rad), c = Math.cos(rad), t = 1 - c;
    const l = Math.sqrt(ax.x * ax.x + ax.y * ax.y + ax.z * ax.z) || 1;
    const x = ax.x / l, y = ax.y / l, z = ax.z / l;
    m[0] = fr(t * x * x + c); m[1] = fr(t * x * y - s * z); m[2] = fr(t * x * z + s * y); m[3] = 0;
    m[4] = fr(t * x * y + s * z); m[5] = fr(t * y * y + c); m[6] = fr(t * y * z - s * x); m[7] = 0;
    m[8] = fr(t * x * z - s * y); m[9] = fr(t * y * z + s * x); m[10] = fr(t * z * z + c); m[11] = 0;
    return m;
}
/** MsVECNormalize: the raw frsqrte estimate, no Newton step, no zero guard -- not a Math.sqrt-based normalize. */
export function normalize(v: V3) { return vNormMs(v); }
const toMat4 = (m: Mtx) => mat4.fromValues(m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, m[3], m[7], m[11], 1);

/** TMapObjBase::makeRootMtxRotZ / RotY / RotX (sinf of the degrees; the Y offset taken off) */
export function makeRootMtxRot(o: MapObjBase, axis: 'x' | 'y' | 'z'): Mtx {
    const m = mtx(), a = fr(o.rot[axis] * 0.017453294), s = fr(Math.sin(a)), c = fr(Math.cos(a));
    if (axis === 'z') { m[0] = c; m[1] = -s; m[4] = s; m[5] = c; }
    else if (axis === 'y') { m[0] = c; m[2] = s; m[8] = -s; m[10] = c; }
    else { m[5] = c; m[6] = -s; m[9] = s; m[10] = c; }
    m[3] = o.pos.x; m[7] = fr(o.pos.y - o.yOffset); m[11] = o.pos.z;
    return m;
}

/**
 * getModel()->setAnmMtx(0, m) / writing getAnmMtx(0) on a model whose animation calc is off: the
 * root joint's matrix is m (base.ts's anmMtx0, what rootMtx() gives the collision); the viewer
 * draws the model from baseTR x scale, so baseTR becomes m without the scale.
 */
export function setRootMtx(o: MapObjBase, m: Mtx) {
    o.anmMtx0 = Float64Array.from(m);
    const s = o.scale, B = o.baseTR;
    const ix = s.x ? 1 / s.x : 1, iy = s.y ? 1 / s.y : 1, iz = s.z ? 1 / s.z : 1;
    B[0] = m[0] * ix; B[1] = m[1] * iy; B[2] = m[2] * iz; B[3] = m[3];
    B[4] = m[4] * ix; B[5] = m[5] * iy; B[6] = m[6] * iz; B[7] = m[7];
    B[8] = m[8] * ix; B[9] = m[9] * iy; B[10] = m[10] * iz; B[11] = m[11];
}

/** The rest pose's joint matrices of the actor's model (J3DModel::calc with no animation): row-major 3x4. */
export function restJointMtx(o: LiveActor, j: number): Mtx | null {
    const a = o.mactor;
    if (!a) return null;
    const sk = Skeleton.of(a.data.files.scene(a.model));
    if (!sk || j < 0 || j >= sk.names.length) return null;
    const W = jointMatrices(sk, null, 0, o.baseTR, [o.scale.x, o.scale.y, o.scale.z]);
    const w = W[j], m = mtx();
    m[0] = w[0]; m[1] = w[4]; m[2] = w[8]; m[3] = w[12];
    m[4] = w[1]; m[5] = w[5]; m[6] = w[9]; m[7] = w[13];
    m[8] = w[2]; m[9] = w[6]; m[10] = w[10]; m[11] = w[14];
    return m;
}
/** J3DVertexData::getVtxNum: how many positions a BMD's VTX1 holds (its position array's size by its format) */
export function vtxPosCount(b: Uint8Array | null): number {
    if (!b) return 0;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let o = 0x20;
    while (o + 8 <= b.length) {
        const tag = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]), size = v.getUint32(o + 4);
        if (tag === 'VTX1') {
            const fmt = o + v.getUint32(o + 8);
            const offs: number[] = [];
            for (let i = 0; i < 13; i++) offs.push(v.getUint32(o + 0xC + i * 4));
            let comp = 3, type = 4;
            for (let f = fmt; f + 16 <= o + size; f += 16) {
                const attr = v.getUint32(f);
                if (attr === 0xFF) break;
                if (attr === 9) { comp = v.getUint32(f + 4) === 0 ? 2 : 3; type = v.getUint32(f + 8); break; }
            }
            const pos = offs[0];
            if (!pos) return 0;
            const next = Math.min(size, ...offs.filter((x) => x > pos));
            const bytes = type === 4 ? 4 : type >= 2 ? 2 : 1;
            return Math.trunc((next - pos) / (comp * bytes));
        }
        if (!size) break;
        o += size;
    }
    return 0;
}
export function jointCount(o: LiveActor) {
    const a = o.mactor;
    const sk = a ? Skeleton.of(a.data.files.scene(a.model)) : null;
    return sk ? sk.names.length : 0;
}

/**
 * getModel()->setAnmMtx(j, m) for some joints (their world matrices): the viewer's joint callback
 * takes each joint's matrix in its parent's (LiveActor.locals, as TBossPakkun's), worked out here
 * from the rest pose with the joints given replaced; the others ride their parents.
 */
export function setJointWorlds(o: LiveActor, worlds: Map<number, Mtx>) {
    const a = o.mactor;
    if (!a) return;
    const sk = Skeleton.of(a.data.files.scene(a.model));
    if (!sk) return;
    const sc: [number, number, number] = [o.scale.x, o.scale.y, o.scale.z];
    const R = restLocals(o, sk, sc);
    const B = o.baseTR;
    const root = mat4.fromValues(B[0], B[4], B[8], 0, B[1], B[5], B[9], 0, B[2], B[6], B[10], 0, B[3], B[7], B[11], 1);
    mat4.scale(root, root, sc);
    const F: mat4[] = [], L: mat4[] = ((o as any).locals as mat4[]) || [];
    const inv = mat4.create();
    for (const j of sk.order) {
        const p = sk.parent[j];
        const parentNow = p >= 0 ? F[p] : root;
        L[j] = L[j] || mat4.create();
        const ov = worlds.get(j);
        if (ov) {
            F[j] = toMat4(ov);
            mat4.invert(inv, parentNow);
            mat4.mul(L[j], inv, F[j]);
        } else {
            // the rest local on the parent as it is now
            mat4.copy(L[j], R[j]);
            F[j] = mat4.mul(F[j] || mat4.create(), parentNow, R[j]);
        }
    }
    (o as any).locals = L;
}
/** Each joint's rest matrix in its parent's (the root's in the scaled base matrix), for the scale */
function restLocals(o: LiveActor, sk: Skeleton, sc: [number, number, number]): mat4[] {
    const key = sc.join(',');
    const c = (o as any)._restLocals as { key: string; sk: Skeleton; L: mat4[] } | undefined;
    if (c && c.key === key && c.sk === sk) return c.L;
    const W = jointMatrices(sk, null, 0, mtx(), sc);
    const root = mat4.fromScaling(mat4.create(), sc), inv = mat4.create(), L: mat4[] = [];
    for (const j of sk.order) {
        const p = sk.parent[j];
        mat4.invert(inv, p >= 0 ? W[p] : root);
        L[j] = mat4.mul(mat4.create(), inv, W[j]);
    }
    (o as any)._restLocals = { key, sk, L };
    return L;
}

// ---------------------------------------------------------------- the water drops (MapObjLib.cpp)
/** getWaterID: the drop the water hit actor stands for (its unk68) */
export const waterID = (a: HitActor) => ((a as any).unk68 ?? -1) as number;
/** getWaterPlane: the plane the drop has landed on (gpModelWaterManager->unk2914) */
export function getWaterPlane(w: World, a: HitActor): BGCheckData | null { const i = waterID(a); return w.water && i >= 0 ? w.water.plane[i] : null; }
/** getWaterPos */
export function getWaterPos(w: World, a: HitActor): V3 { const i = waterID(a); return w.water && i >= 0 ? w.water.pos[i] : a.pos; }
/** getWaterSpeed */
export function getWaterSpeed(w: World, a: HitActor): V3 { const i = waterID(a); return w.water && i >= 0 ? w.water.vel[i] : new V3(); }
/** waterHitPlane: it landed on a plane moving across it, against the plane's facing */
export function waterHitPlane(w: World, a: HitActor) {
    const plane = getWaterPlane(w, a);
    if (!plane) return false;
    const v = getWaterSpeed(w, a);
    if (v.x === 0 && v.z === 0) return false;
    if (v.x * plane.n[0] > 0 || v.z * plane.n[2] > 0) return false;
    return true;
}
/** getVerticalVecToTargetXZ: the unit XZ offset to (x, z) turned 90 degrees round Y */
export function getVerticalVecToTargetXZ(o: { pos: V3 }, x: number, z: number) {
    const v = normalize(new V3(fr(x - o.pos.x), 0, fr(z - o.pos.z)));
    // rotateVecByAxisY(v, pi/2): TRotation3::setEular(0, a, 0).mult33 -- real sinf/cosf(1.5707963705062866)
    // rounded to f32, not Math.sin/cos of the 7-digit source spelling.
    const s = sinf(HALF_PI_F), c = cosf(HALF_PI_F);
    return new V3(FMA(s, v.z, fr(c * v.x)), 0, FMS(c, v.z, fr(s * v.x)));
}

/** TMapObjMessenger: a hit actor standing in for its owner (receiveMessage goes to unk68) */
export class MapObjMessenger extends HitActor {
    owner: HitActor | null = null;
    constructor(name = '地形オブジェメッセンジャー') { super(name); }
    receiveMessage(sender: HitActor, msg: number): boolean { return this.owner ? this.owner.receiveMessage(sender, msg) : false; }
}

// ---------------------------------------------------------------- Mario
/** The stage's Mario as a TMario (the port in player/) or the ghost's proxy */
const M = (w: World) => w.mario as any;
const isTMario = (m: any) => m && typeof m.mStatus === 'number';
/** SMS_GetMarioGrPlane */
export function marioGroundPlane(w: World): BGCheckData { const m = M(w); return isTMario(m) ? m.mGroundPlane : m.groundPlane; }
/** SMS_GetMarioGrLevel */
export function marioGroundLevel(w: World): number { const m = M(w); return isTMario(m) ? m.mFloorPosition.y : m.groundHeight; }
/** SMS_GetMarioSpeedY */
export function marioSpeedY(w: World): number { const m = M(w); return isTMario(m) ? m.mVel.y : m.vel.y; }
/** SMS_IsMarioTouchGround4cm */
export function marioTouchGround4cm(w: World) { return w.mario.pos.y <= marioGroundLevel(w) + 4; }
/**
 * Mario's status (TMario::mStatus). The proxy has none: it is made up from what it knows — a
 * jump (0x880: JUMPING, type jumping), a hip drop, swimming (0x22D2), else standing on the
 * ground (0x0C400201, MARIO_STATUS_WAIT: UNK200 among its flags).
 */
export function marioStatus(w: World): number {
    const m = M(w);
    if (isTMario(m)) return m.mStatus;
    if (m.hipDrop) return 0x8008A9;   // (MARIO_STATUS_HIP_DROP)
    if (m.jumping) return 0x02000880;
    if (marioSwimming(w)) return 0x22D2;
    return 0x0C400201;
}
/** SMS_IsMarioStatusTypeSwimming: proxy: below a water surface under him */
export function marioSwimming(w: World) {
    const m = M(w);
    if (isTMario(m)) return (m.mStatus & 0x2000) !== 0;
    const [h, d] = w.checkGround(m.pos.x, m.pos.y + 100, m.pos.z);
    return d.isWaterSurface() && m.pos.y < h - 20;
}
/** SMS_GetMarioThrowPower: Mario's mDeParams.mThrowPower (/Mario/Mario.prm; the proxy reads it too) */
const THROW = new WeakMap<World, number>();
export function marioThrowPower(w: World): number {
    const m = M(w);
    if (isTMario(m) && m.mDeParams) return m.mDeParams.mThrowPower;
    let v = THROW.get(w);
    if (v === undefined) { v = (readParams('/Mario/Mario.prm', w.files, { mThrowPower: ['f', 2] }) as any).mThrowPower as number; THROW.set(w, v); }
    return v;
}
/** SMS_GetMarioAngleY: his mFaceAngle.y */
export function marioAngleY(w: World): number { return (w.mario as any).faceAngle; }
/** SMS_IsMarioStatusHipDrop */
/** SMS_IsMarioStatusHipDrop: MARIO_STATUS_HIP_DROP (0x8008A9) */
export function marioHipDropping(w: World) { const m = M(w); return isTMario(m) ? m.mStatus === 0x8008A9 : !!m.hipDrop; }
/** The object Mario holds (TTakeActor::mHeldObject) */
export function marioHeld(w: World): HitActor | null { const m = M(w); return (isTMario(m) ? m.mHeldObject : m.held) || null; }
/**
 * TWaterGun: whether it emitted water this tick (getEmittedWaterCount() > 0) and its first
 * emitter's matrix (getEmitMtx(0): the nozzle's X axis is the spray's direction). The proxy's
 * FLUDD record gives the direction from its yaw and pitch.
 */
export function marioWaterGun(w: World): { emitting: boolean; mtx: Mtx } {
    const m = M(w), out = mtx();
    const wg = isTMario(m) ? m.mWaterGun : null;
    if (wg && typeof wg.getEmitMtx === 'function') {
        return { emitting: (wg.mEmittedWaterCount | 0) > 0, mtx: wg.getEmitMtx(0) };
    }
    const f = m.fludd;
    if (!f || !f.spraying) return { emitting: false, mtx: out };
    const cp = Math.cos(f.pitch);
    out[0] = fr(Math.sin(f.yaw) * cp); out[4] = fr(Math.sin(f.pitch)); out[8] = fr(Math.cos(f.yaw) * cp);
    return { emitting: true, mtx: out };
}
/** SMS_IsMarioOnYoshi (the proxy's flag, the player's onYoshi()) */
export function marioOnYoshi(w: World): boolean { const m = M(w); return typeof m.onYoshi === 'function' ? !!m.onYoshi() : !!m.onYoshi; }
/** SMS_SendMessageToMario */
export function sendToMario(w: World, from: HitActor, msg: number) { return w.mario.receiveMessage(from, msg); }

// ---------------------------------------------------------------- gpCubeStream
export interface StreamCube { c: V3; r: V3; s: V3; unk34: number; unk38: number; unk3C: number; unk40: number; }
const STREAMS = new WeakMap<World, StreamCube[]>();
/** 流れキューブテーブル's TCubeStreamInfo cubes: unk18 their rotation, unk40 their strength */
export function streamCubes(w: World): StreamCube[] {
    let l = STREAMS.get(w);
    if (l) return l;
    l = [];
    const b = w.files.scene('map/tables.bin');
    if (b) {
        let found: SceneNode | null = null;
        const find = (n: SceneNode) => { if (found) return; if (n.name === '流れキューブテーブル' && n.children) { found = n; return; } for (const c of n.children || []) find(c); };
        try { find(parseSceneBin(b)); } catch { }
        if (found) for (const ch of (found as SceneNode).children || []) {
            const s = new Stream(ch.data);
            const c = new V3(s.f32(), s.f32(), s.f32()), r = new V3(s.f32(), s.f32(), s.f32());
            const sc = new V3(fr(s.f32() * 100), fr(s.f32() * 100), fr(s.f32() * 100));
            s.u32(); s.u32();
            const unk34 = s.u32() | 0;
            const unk40 = s.s32(), unk38 = s.s32();
            l.push({ c, r, s: sc, unk34, unk38, unk3C: unk34, unk40 });
        }
    }
    STREAMS.set(w, l);
    return l;
}
/** gpCubeStream->getInCubeNo */
export function inStreamCube(w: World, p: V3): StreamCube | null {
    for (const c of streamCubes(w)) if (isPointInCube(p, c.c, c.r, c.s)) return c;
    return null;
}

// ---------------------------------------------------------------- TMapObjWave (gpMapObjWave)
const WAVES = new WeakMap<World, MapObjWave>();
/**
 * TMapObjWave: the sea's waves (two sines over X and Z, moving with time) and their drawing.
 * Only the heights are here; it is updated every movement tick as the game's movement list does
 * (lazily: to the stage's tick when asked). Outside Ricco and Gelato (map 4 and 6) the wave
 * heights don't change with where Mario is.
 */
export class MapObjWave extends NameRef {
    unk10 = 0; unk14 = 0; unk18 = 0; unk1C = 0; unk20 = 0; unk24 = 0; unk28 = 0;
    unk2C = 0; unk30 = 0; unk34 = 0; unk38 = 0; unk3C = 0; unk40 = 0; unk44 = 0; unk48 = fr(0.1);
    unk4C = 0; unk50 = 0; unk54 = 255; unk58 = 255; unk5C = 0; unk60 = 0;
    unk64: number; unk68: number; unk6C: number; unk70: number;
    hasTex = false;
    private tick = -1;
    constructor(public world: World, name = '波の表現') {
        super(name);
        this.unk64 = fr(MsRandF() * 360); this.unk68 = fr(MsRandF() * 360); this.unk6C = MsRandF(); this.unk70 = MsRandF();
        WAVES.set(world, this);
    }
    load(s: Stream) {
        super.load(s);
        this.unk10 = 5200; this.unk1C = 200; this.unk14 = fr(this.unk10 / 2); this.unk18 = fr(1 / this.unk14); this.unk20 = Math.trunc(this.unk10 / this.unk1C);
        this.hasTex = !!this.world.files.scene('map/map/wave.bti');
        this.unk60 = fr(0.0015); this.unk4C = 400; this.unk50 = 150; this.unk24 = fr(0.02); this.unk28 = fr(0.03);
        switch (this.world.map) {
            case 3: case 30: this.unk2C = 25; this.unk30 = 20; this.unk34 = 0; this.unk38 = 0; break;
            case 4: this.unk2C = 40; this.unk30 = 30; this.unk34 = 5; this.unk38 = 0; break;
            case 13: this.unk2C = 30; this.unk30 = 25; this.unk34 = 5; this.unk38 = 0; break;
            case 9: case 52: this.unk2C = 10; this.unk30 = 15; this.unk34 = 0; this.unk38 = 0; break;
            default: this.unk2C = 30; this.unk30 = 25; this.unk34 = 0; this.unk38 = 0; break;
        }
        this.unk3C = this.unk2C; this.unk40 = this.unk30;
        this.tick = this.world.tickCount;
    }
    /** updateTime */
    private updateTime() {
        const T = fr(6.28318);
        this.unk64 = fr(this.unk64 + this.unk24); if (this.unk64 > T) this.unk64 = fr(this.unk64 - T);
        this.unk68 = fr(this.unk68 + this.unk28); if (this.unk68 > T) this.unk68 = fr(this.unk68 - T);
        this.unk6C = fr(this.unk6C + this.unk60); if (this.unk6C > 1) this.unk6C = fr(this.unk6C - 1);
        this.unk70 = fr(this.unk70 + this.unk60); if (this.unk70 > 1) this.unk70 = fr(this.unk70 - 1);
    }
    /** perform(CUE_MOVE) for each movement tick since the last ask. TODO: updateHeightAndAlpha (maps 4 and 6). */
    catchUp() {
        if (!this.hasTex) return;
        const t = this.world.tickCount;
        if (this.tick < 0) this.tick = t;
        while (this.tick < t) { this.updateTime(); this.tick++; }
    }
    perform(cue: number) { if (cue & CUE_MOVE) this.catchUp(); }
    /** getWaveHeight */
    getWaveHeight(x: number, z: number) {
        if (!this.hasTex) return 0;
        this.catchUp();
        const a = fr(this.unk3C * fr(Math.sin(fr(this.unk24 * fr(x * fr(1 / 6.28318))) + this.unk64)));
        const b = fr(this.unk40 * fr(Math.sin(fr(this.unk28 * fr(z * fr(1 / 6.28318))) + this.unk68)));
        return fr(a + b);
    }
}
export function mapObjWave(w: World): MapObjWave | null { return WAVES.get(w) || null; }
register('MapObjWave', (w, n) => new MapObjWave(w, n));

/** TMapObjLibWave: a floating thing's bobbing (pushed down when stood on, rising back) */
export class MapObjLibWave {
    unk0: number; unk8 = 0;
    static mWaveSpeed = fr(0.7);
    constructor(public w: World, public unk4: number, public unkC: number, public unk10: number, public unk14: number) {
        // rand() * (1 / (RAND_MAX + 1)) * 360
        this.unk0 = fr(fr(MsRandF() * 360));
    }
    push() { this.unk8 = fr(this.unk8 + this.unk10); if (this.unk8 > this.unkC) this.unk8 = this.unkC; }
    getCurrentHeight(x: number, z: number) { const wv = mapObjWave(this.w); return fr((wv ? wv.getWaveHeight(x, z) : 0) - this.unk8); }
    movement() {
        if (this.unk8 > 0) { this.unk8 = fr(this.unk8 - this.unk14); if (this.unk8 < 0) this.unk8 = 0; }
        this.unk0 = fr(this.unk0 + MapObjLibWave.mWaveSpeed);
        if (this.unk0 > 360) this.unk0 = fr(this.unk0 - 360);
    }
}
