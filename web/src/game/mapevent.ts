// The stage events that move parts of the map model itself (Map/MapEvent*.cpp, Map/Map.cpp's
// initStage), ported from the decomp (aetherion28/sms-ai-decomp):
//
// - TMapEvent (base): watch() until it says go, startControl, control() each move tick until it says
//   done, finishControl (back to watching unless isFinishedAll). unk1C is the map's joint model
//   (map/map/map.bmd: gpMap->getModelManager()->getJointModel(0)).
// - TMapEventSink and its kinds (MapEventSink.cpp): buried buildings (the map model's building joints,
//   hidden and sunk) that rise when their goop is cleaned (TMapEventSinkInPollution, ...Reset: the
//   cleaned goop object swapped for its reset copy), when the gatekeeper's dead (TMapEventSinkBianco:
//   Bianco Hills' slope; the Shine), or when Shadow Mario asks (TMapEventSinkShadowMario).
// - TMapEventSirenaSink (MapEventSirena.cpp, イベント（ホテル沈む）): Sirena's hotel, up once
//   Phantamanta's gone (TBossManta sets unk64): the hotel-up camera, its Shine, HOTEL_RISING, Mario
//   warped to the scene.bin's place.
// - TDolpicEventBiancoGate (the Bianco Hills gate, dptKing, rises once the polluted Piranha's beaten)
//   and TDolpicEventRiccoMammaGate (the Ricco boathouse / Gelato lighthouse, grown back from flat
//   while their RICCO / GELATO_UNLOCKABLE flag clears) (MapEventDolpic.cpp).
// - Noki Bay (MapEventMare.cpp): TMareWallRock x7 (TMareEventWallRock; episode 1's cliff blocks slide
//   out once their goop layer is clean), TMareEventDepressWall (three made by Map.cpp's initMare; the
//   wall blocks the TMareEventPoint "mareEP0..2" start: they sink in, then come back out one by one)
//   and TMareEventBumpyWall (凸凹壁: a block pushed in or out once sprayed).
// - TMap::loadAfter's initStage (Map.cpp): the building collisions some stages set up at the start,
//   and Noki Bay's depress walls (the scene.bin 'Map' object; its load stays scene.ts's).
// - TMarDirector::setNextStage (MarDirectorEvent.cpp) and the gate-demo part of updateGameMode
//   (MarDirectorDirect.cpp): Delfino -> Pinna Park starts the plaza cannon's demo (TDemoCannon::startDemo).
//
// Moving the map: the parts are the map model's joints (MapJointModel below: the TJointObj tree, each
// joint's J3DTransformInfo and shown state). Their collision is the game's: building%02d.col as a
// TMapCollisionWarp (static grid, set up / removed) and a TMapCollisionMove (moved into the move grid
// every tick it moves), mapobj/objcol.ts's ObjCollision. For the viewer: mapJoints(w) holds the live
// joint transforms; `version` goes up whenever one changes (calcMap). To move the drawn map, the viewer
// can, for map/map/map.bmd, take joint j's local matrix from jointLocal(j) (rest rotation, the live
// scale and translation) in its joint callback the way it does LiveActor.locals, and hide the joints
// whose shown(j) is false.
//
// RNG: none of these call rand() (no MapEvent*.cpp / Map.cpp function is in the retail callers list).
//
// Not here: particles, rumble, camera shakes, the BGM (setBossLivesFlag, setTrackVolume), the demo
// cameras' own motion (told as 'demo:<name>' effects), the pollution depth maps (updateDepthMap),
// Bianco's mirror terrain (鏡内地形).

import { fr, V3, Mtx, mtx } from './math.js';
import { World, NameRef, Stream, HitActor, LiveActor, LF, MSG, CUE_MOVE } from './engine.js';
import { register } from './scene.js';
import { SE } from './soundids.js';
import './sound.js';
import { Skeleton } from './skeleton.js';
import { FLAG_DECAY, Layer, sinkCleaned } from './pollution.js';
import { MSF } from './flags.js';
import { ObjCollision, KIND_WARP, KIND_MOVE } from './mapobj/objcol.js';
import { MapObjBase, mapObjGlobals, STATE_NORMAL } from './mapobj/base.js';
import { marioGroundPlane } from './mapobj/lib.js';
import { AT } from './actortypes.js';
import { quat, mat4 } from 'gl-matrix';

const pad2 = (n: number) => String(n).padStart(2, '0');
/** TMapObjBase::isDemo */
const isDemo = (w: World) => w.talkMode || w.demoMode;
/** TMapObjBase::marioIsOn */
const marioIsOn = (w: World, a: LiveActor) => marioGroundPlane(w).actor === a && !(w.mario as any).isJumping();
/** SMS_MarioWarpRequest */
const marioWarpRequest = (w: World, p: V3, angle: number) => { const m = w.mario as any; if (typeof m.warpRequest === 'function') m.warpRequest(p.clone(), angle); };
/** TMarDirector::fireStartDemoCamera / fireEndDemoCamera (the camera itself isn't driven from here) */
const demoCamera = (w: World, name: string, p: V3 | null) => { w.effect('demo:' + name, p ? p.clone() : new V3()); if (w.talk) w.talk.fireStartDemoCamera(name, p ? p.clone() : null); };

// ================================================================ the map model's joints
/** JNT1's per-joint data the game reads (J3DJoint's J3DTransformInfo, getMin / getMax). */
function readJoints(b: Uint8Array) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let o = 0x20, jnt1 = -1;
    while (o + 8 <= b.length) {
        const tag = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]), size = v.getUint32(o + 4);
        if (tag === 'JNT1') jnt1 = o;
        if (!size) break;
        o += size;
    }
    const out: { scale: number[]; rot: number[]; trans: number[]; min: number[]; max: number[] }[] = [];
    if (jnt1 < 0) return out;
    const n = v.getUint16(jnt1 + 8), dataOff = jnt1 + v.getUint32(jnt1 + 0xC), remap = jnt1 + v.getUint32(jnt1 + 0x10);
    for (let i = 0; i < n; i++) {
        const d = dataOff + v.getUint16(remap + i * 2) * 0x40;
        const f = (k: number) => v.getFloat32(d + k);
        out.push({
            scale: [f(4), f(8), f(0xC)], rot: [v.getInt16(d + 0x10), v.getInt16(d + 0x12), v.getInt16(d + 0x14)], trans: [f(0x18), f(0x1C), f(0x20)],
            min: [f(0x28), f(0x2C), f(0x30)], max: [f(0x34), f(0x38), f(0x3C)],
        });
    }
    return out;
}

export const JOINT_DEAD = 0x1, JOINT_ASLEEP = 0x2, JOINT_SITTING = 0x4;
/**
 * TJointObj and its J3DJoint in one: the joint's transform (getTransformInfo / setTransformInfo), its
 * box (getMin / getMax) and its shown state (kill / alive / sleep / awake). children are TJointObj's
 * (initChildren fills them last J3D child first); j3dChildren are J3DNode's child / younger order.
 */
export class JointObj {
    flags = 0;
    children: JointObj[] = [];
    j3dChildren: JointObj[] = [];
    scale = [1, 1, 1]; rot = [0, 0, 0]; trans = [0, 0, 0];
    min = [0, 0, 0]; max = [0, 0, 0];
    constructor(public model: MapJointModel, public index: number) { }
    getChild(i: number) { return this.children[i]; }
    getChildrenNum() { return this.children.length; }
    /** (TJointObj::getJoint: the joint itself here) */
    getJoint() { return this; }
    /** J3DNode::getChild / getYounger */
    j3dChild(): JointObj | null { return this.j3dChildren[0] || null; }
    younger(): JointObj | null { const p = this.model.parentOf(this); if (!p) return null; const s = p.j3dChildren; return s[s.indexOf(this) + 1] || null; }
    private set(f: number) { if (f !== this.flags) { this.flags = f; this.model.version++; } }
    alive() { for (const c of this.children) c.alive(); this.set(this.flags & ~(JOINT_DEAD | JOINT_ASLEEP | JOINT_SITTING)); }
    kill() { for (const c of this.children) c.kill(); if (!(this.flags & JOINT_DEAD)) this.set((this.flags | JOINT_DEAD) & ~(JOINT_ASLEEP | JOINT_SITTING)); }
    awake() { for (const c of this.children) c.awake(); if (this.flags & (JOINT_SITTING | JOINT_ASLEEP)) this.set(this.flags & ~(JOINT_SITTING | JOINT_ASLEEP)); }
    sleep() { for (const c of this.children) c.sleep(); if (!(this.flags & JOINT_DEAD) && !(this.flags & JOINT_ASLEEP)) this.set((this.flags & ~JOINT_SITTING) | JOINT_ASLEEP); }
    /** its shapes drawn (J3DShpFlag_Visible off) */
    shown() { return (this.flags & (JOINT_DEAD | JOINT_ASLEEP | JOINT_SITTING)) === 0; }
}

/** TJointModel for map/map/map.bmd: the root TJointObj (joint 0) and every joint's live transform. */
export class MapJointModel extends JointObj {
    joints: JointObj[] = [];
    private parent: number[] = [];
    private sk: Skeleton | null = null;
    /** goes up whenever a joint's transform or shown state changes (for the viewer) */
    version = 0;
    constructor(bmd: Uint8Array | null) {
        super(null as any, 0);
        this.model = this;
        const sk = this.sk = Skeleton.of(bmd);
        const data = bmd ? readJoints(bmd) : [];
        if (!sk || !data.length) return;
        this.parent = sk.parent.slice();
        this.joints = data.map((d, j) => {
            const o = j === 0 ? this : new JointObj(this, j);
            o.scale = d.scale.slice(); o.rot = d.rot.slice(); o.trans = d.trans.slice(); o.min = d.min; o.max = d.max;
            return o;
        });
        // J3DNode::appendChild in INF1 order; TJointObj::initChildren fills them in reverse
        for (const j of sk.order) { const p = sk.parent[j]; if (p >= 0) this.joints[p].j3dChildren.push(this.joints[j]); }
        for (const o of this.joints) o.children = o.j3dChildren.slice().reverse();
    }
    parentOf(o: JointObj) { const p = this.parent[o.index]; return p >= 0 ? this.joints[p] : null; }
    /** J3DModel::calc after setTransformInfo (TMapObjBase::calcMap): tell the viewer */
    calc() { this.version++; }
    /** Joint j's local matrix (column-major): the rest rotation, the live scale and translation. */
    jointLocal(j: number): mat4 | null {
        const o = this.joints[j];
        if (!o || !this.sk) return null;
        const q = this.sk.rest[j].rotation as quat;
        return mat4.fromRotationTranslationScale(mat4.create(), q, o.trans as [number, number, number], o.scale as [number, number, number]);
    }
    shownJoint(j: number) { const o = this.joints[j]; return !o || o.shown(); }
}

const mapJointModels = new WeakMap<World, MapJointModel>();
/** gpMap->getModelManager()->getJointModel(0) (also gpMap->getRootJointModel()) */
export function mapJoints(w: World): MapJointModel {
    let m = mapJointModels.get(w);
    if (!m) { m = new MapJointModel(w.files.scene('map/map/map.bmd')); mapJointModels.set(w, m); }
    return m;
}
/** TMapObjBase::getBuildingJointObj / getBuildingJoint */
export const getBuildingJointObj = (w: World, i: number) => mapJoints(w).getChild(0)?.getChild(i & 0xFFFF) ?? null;
/** TMapObjBase::setJointTransX/Y/Z, getJointTrans*, setJointScaleY, getJointScaleY, moveJoint */
const setJointTrans = (j: JointObj, k: number, v: number) => { j.trans[k] = fr(v); j.model.version++; };
const setJointScaleY = (j: JointObj, v: number) => { j.scale[1] = fr(v); j.model.version++; };
const moveJoint = (j: JointObj, x: number, y: number, z: number) => { j.trans[0] = fr(j.trans[0] + x); j.trans[1] = fr(j.trans[1] + y); j.trans[2] = fr(j.trans[2] + z); j.model.version++; };

/** TMapObjBase::newAndInitBuildingCollisionWarp / Move: "/scene/map/map/building%02d.col" */
export function newAndInitBuildingCollision(w: World, kind: number, i: number, owner: LiveActor | null) {
    const c = new ObjCollision(w, kind, owner);
    c.init(`map/map/building${pad2(i)}.col`, 0);
    return c;
}

// ================================================================ goop objects
/**
 * TPollutionObj: a goop layer model's child joint's box on the layer (getLayer(l)->getObj(i)). The
 * game's mCounter is the GPU's count of its still-polluted pixels (TPollutionCounterObj, drawn each
 * frame): pollution.ts countObjDegree, once registerPollutionObj'd (TMapEventSinkInPollution::loadAfter).
 */
export class PollutionObj {
    dead = false;
    minS = 0; maxS = 0; minT = 0; maxT = 0;
    /** the GPU count (pollution.ts countObjDegree), each frame once registerPollutionObj'd; else 0 */
    mCounter = 0;
    /**
     * TPollutionObj::initAreaInfo: the joint's box in texels, clamped as the game does (a low edge
     * under 0 zeroes the high one). joint: its TJointObj (kill / alive hide and show its shapes).
     */
    constructor(public layer: Layer, public jointIndex: number, public min: number[], max: number[], public joint: JointObj | null = null, private world: World | null = null) {
        this.minS = layer.texS(min[0]); this.maxS = layer.texS(max[0]);
        this.minT = layer.texT(min[2]); this.maxT = layer.texT(max[2]);
        if (this.minS < 0) this.maxS = 0;
        if (this.minT < 0) this.maxT = 0;
        if (this.maxS > layer.pos.w) this.maxS = layer.pos.w;
        if (this.maxT > layer.pos.h) this.maxT = layer.pos.h;
    }
    isCleaned() { return this.mCounter < sinkStatics.mCleanedDegree; }
    /** TJointObj::kill / alive (the joint and its children: their shapes hidden / shown) */
    kill() { this.dead = true; if (this.joint) this.joint.kill(); }
    alive() { this.dead = false; if (this.joint) this.joint.alive(); }
    /**
     * getDepthFromMap (0x801f0318): the ground at the texel's four corners (5 out), all within 30 of
     * each other in turn: the depth (worldToDepth) of the ground at its centre; else 0xFF (prohibited).
     */
    getDepthFromMap(x: number, z: number) {
        const L = this.layer, col = this.world!.col, t = L.pos.texel;
        const wx = fr(L.minX + fr(x * t)), wz = fr(L.minZ + fr(z * t));
        const x0 = fr(wx - 5), x1 = fr(5 + fr(wx + t)), z0 = fr(wz - 5), z1 = fr(5 + fr(wz + t));
        const h00 = col.checkGround(x0, 9999999, z0)[0], h10 = col.checkGround(x1, 9999999, z0)[0];
        const h01 = col.checkGround(x0, 9999999, z1)[0], h11 = col.checkGround(x1, 9999999, z1)[0];
        const near = (a: number, b: number) => fr(a - 30) <= b && b <= fr(30 + a);
        if (near(h00, h01) && near(h01, h10) && near(h10, h11)) {
            const half = fr(0.5 * t);
            return L.pos.worldToDepth(col.checkGround(fr(wx + half), 9999999, fr(wz + half))[0]) & 0xFF;
        }
        return 0xFF;
    }
    /** updateDepthMap: the box's depths from the map as it is now (a building risen out of the goop) */
    updateDepthMap() {
        if (!this.world) return;
        for (let z = this.minT; z < this.maxT; ++z) for (let x = this.minS; x < this.maxS; ++x) this.layer.pos.setDepth(x, z, this.getDepthFromMap(x, z));
        this.layer.dirty = true;
    }
}
const pollutionObjs = new WeakMap<Layer, PollutionObj[]>();
const pollutionJointModels = new WeakMap<Layer, MapJointModel>();
/**
 * The goop layer's TJointModel (map/pollution/<name>.bmd): its joints' shown state as the map
 * events leave it (TMapEventSinkInPollutionReset kills the goop object it doesn't show), for the
 * viewer to hide the killed joints' shapes; null while no event has asked for its objects.
 */
export function pollutionJoints(L: Layer): MapJointModel | null { return pollutionJointModels.get(L) || null; }
/** gpPollution->getLayer(l)->getObj(i) */
export function getPollutionObj(w: World, l: number, i: number): PollutionObj | null {
    const L = w.pollution?.layers[l];
    if (!L) return null;
    let objs = pollutionObjs.get(L);
    if (!objs) {
        const jm = new MapJointModel(w.files.scene(`map/pollution/${L.name}.bmd`));
        pollutionJointModels.set(L, jm);
        objs = jm.children.map((c) => new PollutionObj(L, c.index, c.min, c.max, c, w));
        pollutionObjs.set(L, objs);
    }
    return objs[i] || null;
}
const startDecay = (w: World, l: number) => { const L = w.pollution?.layers[l]; if (L) L.flags |= FLAG_DECAY; };
const stopDecay = (w: World, l: number) => { const L = w.pollution?.layers[l]; if (L) L.flags &= ~FLAG_DECAY; };

const itemManager = (w: World) => mapObjGlobals(w).itemManager as any;

// ================================================================ TMapEvent
export abstract class MapEvent extends NameRef {
    unk18 = 1;
    unk1C: MapJointModel | null = null;
    constructor(public world: World, name: string) { super(name); world.conductor.others.push(this); }
    load(_s: Stream) { this.unk1C = mapJoints(this.world); }
    stateIs(s: number) { return this.unk18 === s; }
    isFinishedAll() { return this.stateIs(0); }
    abstract watch(): boolean;
    startControl() { this.unk18 = 2; }
    abstract control(): boolean;
    finishControl() { this.unk18 = this.isFinishedAll() ? 0 : 1; }
    getBuilding(i: number): JointObj { return this.unk1C!.getChild(0).getChild(i); }
    perform(cue: number) {
        if (!this.stateIs(0) && (cue & CUE_MOVE)) {
            if (this.stateIs(1) && this.watch()) this.startControl();
            if (this.stateIs(2) && this.control()) this.finishControl();
        }
    }
}

// ================================================================ TMapEventSink
/** TMapEventSink::mCleanedDegree (static; every constructor sets it back to 10) */
export const sinkStatics = sinkCleaned;

export class MapEventSink extends MapEvent {
    mBuildingNum = 0; unk24 = 0; mRaisingBuildingIdx = -1;
    unk2C: JointObj | null = null; unk30: JointObj | null = null;
    unk34 = 0; unk38 = 0; unk3C = 5;
    unk40 = 600; unk44 = 0; unk48 = 0; unk4C = 0;
    /** the buildings' sound places (SE_OBJ_QUAKE): never set here but by TMapEventSinkBianco */
    unk50: V3[] = [];
    mIsBuildingRecovered: boolean[] = [];
    unk58: ObjCollision[] = []; unk5C: ObjCollision[] = [];
    /** each building's goop object: layer, object */
    unk60: { unk0: number; unk2: number }[] = [];
    constructor(w: World, name: string) { super(w, name); sinkStatics.mCleanedDegree = 10; }
    getRaisingBuildingIdx() { return this.mRaisingBuildingIdx; }
    getBuilding(i: number) { return this.unk1C!.getChild(0).getChild(i + this.unk24); }
    isBuried(i: number) { return !this.mIsBuildingRecovered[i - this.unk24]; }
    getSinkOffsetY() { return fr(this.unk30!.max[1] - this.unk30!.min[1]); }
    getPollutionObj(i: number) { return getPollutionObj(this.world, this.unk60[i].unk0, this.unk60[i].unk2); }
    isFinishedAll() {
        for (let i = 0; i < this.mBuildingNum; ++i) if (!this.mIsBuildingRecovered[i]) return false;
        return true;
    }
    watch() { return false; }
    makeBuildingRecovered(i: number) {
        const b = this.getBuilding(i);
        b.alive();
        setJointTrans(b, 1, this.unk34);
        this.unk5C[i].remove();
        this.unk58[i].setUp();
        this.mIsBuildingRecovered[i] = true;
    }
    finishControl() {
        this.makeBuildingRecovered(this.mRaisingBuildingIdx);
        this.unk2C = null; this.unk30 = null;
        this.mRaisingBuildingIdx = -1;
        // (MSMainProc::setBossLivesFlag / setBossLivesFlag2(false): the BGM)
        super.finishControl();
    }
    rising() {
        const j = this.unk30!;
        setJointTrans(j, 1, fr(j.trans[1] + this.unk3C));
        this.unk1C!.calc();
    }
    control() {
        if (this.unk4C < this.unk40 - this.unk44 && this.unk4C > this.unk48) this.rising();
        const t = this.unk30!.trans;
        this.unk5C[this.mRaisingBuildingIdx].moveTrans(new V3(t[0], t[1], t[2]));
        if (this.unk4C > this.unk48 && (this.world.map !== 2 || !this.mIsBuildingRecovered[1 - this.unk24] || this.mRaisingBuildingIdx !== 1))
            this.world.sound(SE.OBJ_QUAKE, this.unk50[this.mRaisingBuildingIdx]);
        if (this.unk4C > 0) { --this.unk4C; return false; }
        return true;
    }
    startControl() {
        this.unk18 = 2;
        this.unk2C = this.getBuilding(this.getRaisingBuildingIdx());
        this.unk2C.alive();
        const j = this.unk30 = this.getBuilding(this.getRaisingBuildingIdx()).getJoint();
        this.unk34 = j.trans[1];
        const d = this.unk38 !== 0 ? this.unk38 : this.getSinkOffsetY();
        setJointTrans(j, 1, fr(j.trans[1] - d));
        this.unk1C!.calc();
        const n = (this.unk40 - this.unk44) - this.unk48;
        this.unk3C = fr(d / n);
        this.unk4C = this.unk40;
        this.unk5C[this.mRaisingBuildingIdx].setUpTrans(new V3(j.trans[0], j.trans[1], j.trans[2]));
    }
    initBuilding(i: number, s: Stream) {
        this.unk60[i] = { unk0: s.u32() & 0xFFFF, unk2: s.u32() & 0xFFFF };
        this.unk58[i] = newAndInitBuildingCollision(this.world, KIND_WARP, i + 1, null);
        this.unk5C[i] = newAndInitBuildingCollision(this.world, KIND_MOVE, i + 1, null);
    }
    initWithBuildingNum(s: Stream) {
        this.unk24 = s.u32();
        this.unk50 = Array.from({ length: this.mBuildingNum }, () => new V3());
        this.unk58 = []; this.unk5C = [];
        this.mIsBuildingRecovered = new Array(this.mBuildingNum).fill(false);
        this.unk60 = [];
    }
    load(s: Stream) {
        super.load(s);
        this.mBuildingNum = s.u32();
        this.initWithBuildingNum(s);
        for (let i = 0; i < this.mBuildingNum; ++i) {
            this.mIsBuildingRecovered[i] = false;
            this.getBuilding(i)?.kill();
            this.initBuilding(i, s);
        }
        if (this.world.map === 0) { sinkStatics.mCleanedDegree = 30; this.unk38 = 200; }
        else if (this.world.map === 2) sinkStatics.mCleanedDegree = 30;
    }
}

export class MapEventSinkInPollution extends MapEventSink {
    constructor(w: World, name = '建物沈む（落書き）') { super(w, name); }
    watch() {
        for (let i = 0; i < this.mBuildingNum; ++i) {
            if (!this.mIsBuildingRecovered[i] && this.getPollutionObj(i)?.isCleaned()) { this.mRaisingBuildingIdx = i; return true; }
        }
        return false;
    }
    initBuriedBuilding() { for (let i = 0; i < this.mBuildingNum; ++i) if (this.getPollutionObj(i)?.isCleaned()) this.makeBuildingRecovered(i); }
    loadAfter() {
        super.loadAfter();
        for (let i = 0; i < this.mBuildingNum; ++i) { const o = this.getPollutionObj(i); if (o) this.world.pollution?.registerPollutionObj(o); }
    }
}

export class MapEventSinkInPollutionReset extends MapEventSinkInPollution {
    constructor(w: World, name = '建物沈む（落書き再セット）') { super(w, name); }
    getResetPollutionObj(i: number) { return getPollutionObj(this.world, this.unk60[i].unk0, this.unk60[i].unk2 + 1); }
    makeBuildingRecovered(i: number) {
        super.makeBuildingRecovered(i);
        this.getPollutionObj(i)?.kill();
        const r = this.getResetPollutionObj(i);
        if (r) { r.alive(); r.updateDepthMap(); }
    }
    loadAfter() {
        super.loadAfter();
        for (let i = 0; i < this.mBuildingNum; ++i) { this.getPollutionObj(i)?.alive(); this.getResetPollutionObj(i)?.kill(); }
    }
}

/** イベント（地形沈むビアンコ）: Bianco Hills' slope (building 0: the gatekeeper's dead) and building 1 (its goop). */
export class MapEventSinkBianco extends MapEventSinkInPollutionReset {
    /** TODO: 鏡内地形's joint 2 (the mirror's copy of the slope) isn't in the sim */
    unk64: JointObj | null = null;
    mGateKeeper: LiveActor | null = null;
    unk6C = new V3(); unk78 = 0; unk7C = 0;
    constructor(w: World, name = 'イベント（建物沈むビアンコ）') { super(w, name); }
    finishControl() {
        const w = this.world;
        if (this.mRaisingBuildingIdx === 0) {
            if (this.unk64) setJointTrans(this.unk64, 1, 0);
            // the banana trees and the goop inside the mirror, as if sprayed (gpModelWaterManager->unk2514[0])
            const water = (w.water as any)?.staticHitActor as HitActor | undefined;
            for (let i = 0; i < 6; ++i) { const a = w.search(`バナナツリー（スケール） ${i}`) as any; if (a && water) a.receiveMessage(water, MSG.SPRAYED_BY_WATER); }
            for (let i = 0; i < 7; ++i) { const a = w.search(`落書き内${pad2(i)}`) as any; if (a && water) a.receiveMessage(water, MSG.SPRAYED_BY_WATER); }
        }
        super.finishControl();
        const n = w.pollution ? w.pollution.layers.length : 0;
        for (let i = 0; i < n; ++i) stopDecay(w, i);
    }
    rising() {
        super.rising();
        if (this.mRaisingBuildingIdx === 0 && this.unk64) moveJoint(this.unk64, 0, this.unk3C, 0);
    }
    control() {
        if (this.mRaisingBuildingIdx === 0 && this.unk4C === this.unk7C) {
            const p = this.unk50[this.mRaisingBuildingIdx];
            itemManager(this.world)?.makeShineAppearWithTime('シャイン（坂上げ用）', 300, p.x, p.y, p.z, 0, 0x3C, 0x3C);
        }
        return super.control();
    }
    startControl() {
        switch (this.mRaisingBuildingIdx) {
            case 0: this.unk40 = 1320; this.unk44 = 120; this.unk48 = 600; this.unk38 = 1700; this.unk7C = 360; break;
            case 1: this.unk40 = 600; this.unk44 = 120; this.unk48 = 120; this.unk38 = 1500; break;
        }
        super.startControl();
        if (this.mRaisingBuildingIdx === 0) {
            if (this.unk64) this.unk64.alive();   // (SMS_ShowJoint(unk64->getMesh(), true))
            marioWarpRequest(this.world, this.unk6C, this.unk78);
            this.unk50[this.mRaisingBuildingIdx].set(7170, 3675, -185);
            demoCamera(this.world, 'bianco0_event0', null);
        }
    }
    watch() {
        const w = this.world;
        if (!this.mIsBuildingRecovered[0] && this.mGateKeeper && this.mGateKeeper.checkLiveFlag(LF.DEAD)) {
            this.mRaisingBuildingIdx = 0;
            const n = w.pollution ? w.pollution.layers.length : 0;
            for (let i = 0; i < n; ++i) startDecay(w, i);
            return true;
        }
        for (let i = 1; i < this.mBuildingNum; ++i) {
            if (!this.mIsBuildingRecovered[i] && getPollutionObj(w, this.unk60[i].unk0, this.unk60[i].unk2)?.isCleaned()) { this.mRaisingBuildingIdx = i; return true; }
        }
        return false;
    }
    loadAfter() {
        super.loadAfter();
        // (unk64 = 鏡内地形's joint 2, moved down 1700 and hidden: not in the sim)
        this.mGateKeeper = this.world.search('ゲートキーパー') as LiveActor | null;
    }
    load(s: Stream) {
        super.load(s);
        s.str();
        this.unk6C.set(s.f32(), s.f32(), s.f32());
        s.s32();
        this.unk78 = s.f32();
    }
}

/**
 * TAirportEventSink (イベント（地形沈む空港）, MoveBG/MapObjAirport.cpp): the Airstrip's sunk ground,
 * up once the gatekeeper (ゲートキーパー（ビアンコ）) is dead: watch starts the slope-up camera and
 * goop layer 0's decay; control (720 ticks; the ground, 200 down, rises while 60 < ticks left < 240) turns
 * layer 0's counter off 300 ticks in (and shakes the camera); finishControl stamps the cleaned
 * building's goop object onto layer 0 (pushJointObjStampTask(0, 0): drawn black, i.e. cleaned;
 * not drawn here, but the layer's counter is off, which clears the whole layer anyway: see
 * pollution.ts countTexDegree), makes the graffiti Shine appear with its camera, and turns the
 * counter off again. Only building 0 is watched (TMapEventSinkInPollution's goop watch isn't used).
 */
export class AirportEventSink extends MapEventSinkInPollutionReset {
    unk64 = 0; unk68 = 360;
    unk6C: LiveActor | null = null;
    constructor(w: World, name = 'イベント（地形沈む空港）') { super(w, name); }
    finishControl() {
        // (gpPollution->getCounterLayer().pushJointObjStampTask(0, 0, getPollutionObj(mRaisingBuildingIdx)))
        itemManager(this.world)?.makeShineAppearWithDemoOffset('シャイン（落書き用）', '落書きシャインカメラ', 0, 0, 0);
        this.world.pollution?.offLayer(0);
        super.finishControl();
    }
    control() {
        if (this.unk4C === this.unk40 - 300) this.world.pollution?.offLayer(0);
        // (unk4C > unk48: gpCameraShake->keepShake(CAM_SHAKE_MODE_UNK5, 0.1))
        return super.control();
    }
    watch() {
        if (!this.mIsBuildingRecovered[0] && this.unk6C && this.unk6C.checkLiveFlag(LF.DEAD)) {
            this.mRaisingBuildingIdx = 0;
            demoCamera(this.world, '空港坂上げカメラ', this.unk6C.pos);
            startDecay(this.world, 0);
            return true;
        }
        return false;
    }
    loadAfter() {
        super.loadAfter();
        this.unk6C = this.world.search('ゲートキーパー（ビアンコ）') as LiveActor | null;
        this.unk40 = 720; this.unk44 = 480; this.unk48 = 60; this.unk38 = 200;
    }
}

/** 建物沈む（影マリオ）: buildings Shadow Mario's chase raises (raiseBuilding), with a placed object riding each. */
export class MapEventSinkShadowMario extends MapEventSink {
    unk64: (any | null)[] = [];
    unk68: string[] = [];
    constructor(w: World, name = '建物沈む（影マリオ）') { super(w, name); }
    rising() {
        super.rising();
        const p = this.unk64[this.mRaisingBuildingIdx];
        if (p) p.pos.y = fr(p.pos.y + this.unk3C);
    }
    /** TODO: its caller (Shadow Mario's) isn't found in the ported code */
    raiseBuilding(i: number) { this.mRaisingBuildingIdx = i; this.startControl(); }
    loadAfter() {
        super.loadAfter();
        for (let i = 0; i < this.mBuildingNum; ++i) {
            const p = this.unk64[i] = this.world.search(this.unk68[i]) as any;
            const o = this.getBuilding(i);
            if (p && o) p.pos.y = fr(p.pos.y - fr(o.max[1] - o.min[1]));
        }
    }
    initBuilding(i: number, s: Stream) { super.initBuilding(i, s); this.unk68[i] = s.str(); }
    initWithBuildingNum(s: Stream) { super.initWithBuildingNum(s); this.unk64 = []; this.unk68 = []; }
}

/** イベント（ホテル沈む）: Sirena's hotel, sunk until Phantamanta's beaten (TBossManta sets unk64). */
export class MapEventSirenaSink extends MapEventSink {
    unk64 = false;
    unk68 = new V3(); unk74 = new V3(); unk80 = 0;
    constructor(w: World, name = 'ホテル沈む') { super(w, name); }
    watch() {
        if (!this.unk64) return false;
        const w = this.world;
        startDecay(w, 0);
        this.mRaisingBuildingIdx = 0;
        demoCamera(w, 'ホテル上げカメラ', this.unk68);
        itemManager(w)?.makeShineAppearWithDemo('シャイン（ホテル上げ用）', 'ホテル上げシャインカメラ', this.unk68.x, this.unk68.y, this.unk68.z);
        w.flags.setBool(true, MSF.HOTEL_RISING);
        marioWarpRequest(w, this.unk74, this.unk80);
        return true;
    }
    loadAfter() {
        // unk40: the hotel-up camera's length (TCameraMapTool::getDemoLengthFrames).
        // TODO: the camera map tool's frames aren't read here; the scene.bin's ホテル上げカメラ, else 600 (the default)
        const cam = this.world.search('ホテル上げカメラ') as any;
        if (cam && typeof cam.getDemoLengthFrames === 'function') this.unk40 = cam.getDemoLengthFrames();
        this.unk44 = 240; this.unk48 = 240;
        this.unk38 = 3500;
        this.unk68.set(0, 3300, -2570);
    }
    load(s: Stream) {
        super.load(s);
        s.str();
        this.unk74.set(s.f32(), s.f32(), s.f32());
        s.f32();
        this.unk80 = s.f32();
    }
}

// ================================================================ Delfino Plaza (MapEventDolpic.cpp)
/** イベント（ビアンコゲート）: the gate to Bianco Hills (dptKing), up out of the ground once the polluted Piranha's beaten. */
export class DolpicEventBiancoGate extends MapEvent {
    unk20: MapObjBase | null = null;
    unk24 = 3;
    constructor(w: World, name = 'イベント（ビアンコゲート）') { super(w, name); }
    isFinishedAll() { return this.stateIs(0); }
    control() {
        const g = this.unk20;
        if (!g) return true;
        g.pos.y = fr(g.pos.y + this.unk24);
        if (this.world.pollution) this.world.pollution.clean(g.pos.x, g.pos.y, g.pos.z, 10000, this.world.map);
        if (g.pos.y >= g.initialPos.y) {
            g.pos.y = g.initialPos.y;
            g.setUpMapCollision(0);
            this.unk18 = 0;
            return true;
        }
        return false;
    }
    watch() {
        if (this.unk20 && this.world.flags.getBool(MSF.BIANCO_POLLUTED_PIRANHA_DEFEATED)) {
            this.unk20.appear();
            this.unk20.setUpMapCollision(1);
            return true;
        }
        return false;
    }
    loadAfter() {
        this.unk20 = this.world.search('dptKing') as MapObjBase | null;
        if (!this.unk20) return;
        this.unk20.kill();
        this.unk20.pos.y = fr(this.unk20.pos.y - 1800);
    }
}

/** イベント（リコゲート） / イベント（マンマゲート）: the boathouse (building 1) / the lighthouse (building 2), flat until their unlock flag clears. */
export class DolpicEventRiccoMammaGate extends MapEvent {
    unk20: JointObj | null = null;
    unk24: ObjCollision | null = null; unk28: ObjCollision | null = null;
    unk2C = 0; unk30 = false; unk34 = 0;
    unk38 = 0; unk3C = 0; unk40 = 0; unk44 = 0;
    unk48 = new V3(); unk54 = new V3(); unk60 = 0;
    constructor(w: World, name = 'イベント（リコ、マンマゲート）') { super(w, name); }
    isFinishedAll() { return this.stateIs(0); }
    rising() {
        const j = this.unk20!;
        const scale = fr(j.scale[1] + this.unk34);
        const m: Mtx = mtx();
        m[5] = scale;
        this.unk24!.moveMtx(m);
        setJointScaleY(j, scale);
        setJointTrans(j, 1, fr(300 * fr(1 - scale)));
        this.unk1C!.calc();
    }
    control() {
        if (this.unk44 < this.unk38 - this.unk3C && this.unk44 > this.unk40) this.rising();
        if (this.unk44 > this.unk40) this.world.sound(SE.OBJ_QUAKE, this.unk48);
        if (this.unk44 > 0) { this.unk44 -= 1; return false; }
        setJointScaleY(this.unk20!, 1);
        this.unk24!.remove();
        this.unk28!.setUp();
        demoCamera(this.world, 'end', null);
        this.unk18 = 0;
        return true;
    }
    watch() {
        const w = this.world;
        if (w.flags.getBool(this.unk2C)) return false;
        const j = this.unk20!;
        j.alive();   // (SMS_ShowJoint(unk20->getMesh(), true))
        setJointScaleY(j, this.unk34);
        this.unk24!.setUp();
        this.unk44 = this.unk38;
        if (this.unk2C === MSF.RICCO_UNLOCKABLE) { demoCamera(w, 'マニ屋上げデモカメラ', this.unk48); startDecay(w, 0); }
        else { demoCamera(w, '灯台上げデモカメラ', this.unk48); startDecay(w, 1); }
        marioWarpRequest(w, this.unk54, this.unk60);
        return true;
    }
    loadAfter() {
        this.unk38 = 720; this.unk3C = 120; this.unk40 = 120;
        this.unk34 = fr(1 / ((this.unk38 - this.unk3C) - this.unk40));
        if (this.unk30) {
            const w0 = this.world;
            this.unk28!.setUp();
            this.unk18 = 0;
            w0.pollution?.offLayer(this.unk2C === MSF.RICCO_UNLOCKABLE ? 0 : 1);
        }
    }
    load(s: Stream) {
        super.load(s);
        s.str();
        this.unk54.set(s.f32(), s.f32(), s.f32());
        s.f32();
        this.unk60 = s.f32();
        let idx: number;
        if (this.name === 'イベント（リコゲート）') { this.unk2C = MSF.RICCO_UNLOCKABLE; idx = 0; }
        else { this.unk2C = MSF.GELATO_UNLOCKABLE; idx = 1; }
        this.unk24 = newAndInitBuildingCollision(this.world, KIND_MOVE, idx + 1, null);
        this.unk28 = newAndInitBuildingCollision(this.world, KIND_WARP, idx + 1, null);
        if (this.world.flags.getBool(this.unk2C)) {
            const j = this.unk20 = this.getBuilding(idx + 1).getJoint();
            setJointScaleY(j, 0.008);
            setJointTrans(j, 1, 295);
            this.unk1C!.calc();
            if (this.unk2C === MSF.RICCO_UNLOCKABLE) this.unk48.set(-10500, 300, 2003);
            else this.unk48.set(9915, 300, -7565);
            this.unk30 = false;
        } else this.unk30 = true;
    }
}

// ================================================================ Noki Bay (MapEventMare.cpp)
export class MareWallRock extends LiveActor {
    static mAppearSpeed = 3; static mDepressSpeed = 3; static mCleanedDegree = 50;
    static mWaitTimeToAppear = 240; static mWaitTimeToDepress = 1200;
    /** 0 waiting for its goop, 2 sliding out, 1 out, 3 waiting to come out again, 4 sliding back in */
    unkF4 = 0;
    /** its index (the building is unkF8 + 1, the goop layer unkF8) */
    unkF8 = 0;
    unkFC = 0; unk100 = 0;
    unk104: JointObj | null = null;
    unk108 = 0;
    unk10C: ObjCollision[] = [];
    constructor(w: World) { super(w, 'マーレ壁の岩'); }
    depress() { }
    appear() {
        this.unk10C[0].setUp();
        this.unk104!.awake();
        this.unk10C[0].moveTrans(new V3(0, 0, this.unkFC));
        this.unkF4 = 2;
    }
    movement() {
        const w = this.world;
        switch (this.unkF4) {
            case 0: {
                // TPollutionLayer::getPollutionDegree: the layer pass's GPU count (pollution.ts)
                const L = w.pollution?.layers[this.unk108];
                if (L && L.degree() < MareWallRock.mCleanedDegree) {
                    this.appear();
                    w.pollution?.offLayer(this.unk108);
                }
                break;
            }
            case 2: {
                const j = this.unk104!;
                if (!isDemo(w)) {
                    j.trans[2] = fr(j.trans[2] - MareWallRock.mAppearSpeed);
                    if (marioIsOn(w, this)) this.pos.z = fr(this.pos.z - MareWallRock.mAppearSpeed);
                    w.sound(SE.OBJ_QUAKE, this.pos);
                }
                j.model.calc();
                const z = j.trans[2];
                if (z < 0) { this.unk100 = MareWallRock.mWaitTimeToDepress; this.unk10C[1].setUp(); this.unkF4 = 1; return; }
                this.unk10C[0].moveTrans(new V3(0, 0, z));
                break;
            }
            case 3:
                if (!isDemo(w)) { this.unk100 -= 1; if (this.unk100 <= 0) { this.appear(); return; } }
                break;
            case 4: {
                const j = this.unk104!;
                if (!isDemo(w)) {
                    j.trans[2] = fr(j.trans[2] + MareWallRock.mDepressSpeed);
                    if (marioIsOn(w, this)) this.pos.z = fr(this.pos.z + MareWallRock.mDepressSpeed);
                }
                j.model.calc();
                const z = j.trans[2];
                if (z > this.unkFC) { this.unk10C[0].remove(); j.sleep(); this.unk100 = MareWallRock.mWaitTimeToAppear; this.unkF4 = 3; return; }
                this.unk10C[0].moveTrans(new V3(0, 0, z));
                break;
            }
        }
    }
    perform(cue: number) { if (cue & CUE_MOVE) this.movement(); }
    loadAfter() {
        const w = this.world;
        this.unk10C = [new ObjCollision(w, KIND_MOVE, this), new ObjCollision(w, KIND_WARP, this)];
        const path = `map/map/building${pad2(this.unkF8 + 1)}`;
        this.unk10C[0].init(path, 0);
        this.unk10C[1].init(path, 0);
        const j = this.unk104 = getBuildingJointObj(w, this.unkF8 + 1);
        this.unk108 = this.unkF8;
        if (!j) return;
        this.pos.set(fr((j.max[0] + j.min[0]) / 2), fr((j.max[1] + j.min[1]) / 2), fr((j.max[2] + j.min[2]) / 2));
        this.unkFC = fr(100 + fr(j.max[2] - j.min[2]));
        moveJoint(j, 0, 0, this.unkFC);
        j.sleep();
        this.initHitActor(AT.MARE_WALL_ROCK, 1, 0, 0, 0, 0, 0);
        // (initEffect: the slide-out particles' places and sizes)
    }
}

/** イベント（マーレ壁の岩）: Noki Bay episode 1's seven cliff blocks (TMareWallRock), out once their goop's cleaned. */
export class MareEventWallRock extends NameRef {
    unk10 = 7;
    unk14: MareWallRock[] = [];
    constructor(public world: World, name = 'イベント（マーレ壁の岩）') { super(name); }
    load(_s: Stream) {
        this.unk14 = [];
        for (let i = 0; i < this.unk10; ++i) {
            const r = new MareWallRock(this.world);
            r.unkF8 = i;
            this.unk14.push(r);
            // (into マップグループ: performed with the map)
            this.world.conductor.others.push(r);
        }
    }
    loadAfter() { for (const r of this.unk14) r.loadAfter(); }
}

/** イベント（マーレへこむ壁）: a run of wall blocks the event point starts (made by Map.cpp's initMare). */
export class MareEventDepressWall extends NameRef {
    static mCleanedDegree = 42; static mDepressSpeed = 1; static mRiseSpeed = 5; static mWaitTimeToWatch = 120;
    /** the blocks: how many, and the first's building number */
    unk10 = 0; unk14 = 0;
    /** each block's wait before it comes back out */
    unk18: number[] = [];
    /** each block's way in: true +x, false -x */
    unk1C: boolean[] = [];
    /** how far each goes in */
    unk20: number[] = [];
    unk24: ObjCollision[] = []; unk28: ObjCollision[] = [];
    unk30: JointObj[] = [];
    /** each block's centre (its sounds); unk38 / unk3C / unk40 (its particles' size, rate, scale) aren't here */
    unk34: V3[] = [];
    /** 0 idle, 1 sinking in, 2 waiting, 3 coming back out, 4 waiting to watch again */
    unk44 = 0; unk48 = 0; unk4C = 0;
    constructor(public world: World, name: string) { super(name); }
    rising() {
        const w = this.world, i = this.unk48;
        let x = this.unk30[i].trans[0];
        w.sound(SE.OBJ_QUAKE, this.unk34[i]);
        if (this.unk1C[i] ? x > 0 : x < 0) {
            x = this.unk1C[i] ? fr(x - MareEventDepressWall.mRiseSpeed) : fr(x + MareEventDepressWall.mRiseSpeed);
            setJointTrans(this.unk30[i], 0, x);
            this.unk28[i].moveTrans(new V3(x, 0, 0));
            return;
        }
        this.unk28[i].remove();
        this.unk24[i].setUpTrans(new V3(0, 0, 0));
        setJointTrans(this.unk30[i], 0, 0);
        this.unk48 += 1;
        if (this.unk48 === this.unk10) { this.unk44 = 4; this.unk4C = MareEventDepressWall.mWaitTimeToWatch; return; }
        this.unk4C = this.unk18[this.unk48];
        this.unk44 = 2;
    }
    depressing() {
        const w = this.world;
        let done = 0;
        for (let i = 0; i < this.unk10; ++i) {
            let x = this.unk30[i].trans[0];
            const plus = this.unk1C[i];
            if (plus ? x < this.unk20[i] : x > -this.unk20[i]) {
                if (!isDemo(w)) {
                    x = plus ? fr(x + MareEventDepressWall.mDepressSpeed) : fr(x - MareEventDepressWall.mDepressSpeed);
                    w.sound(SE.OBJ_QUAKE, this.unk34[i]);
                }
                setJointTrans(this.unk30[i], 0, x);
                this.unk28[i].moveTrans(new V3(x, 0, 0));
                if (plus ? x >= this.unk20[i] : x <= -this.unk20[i]) {
                    this.unk28[i].remove();
                    this.unk24[i].setUpTrans(new V3(x, 0, 0));
                    done += 1;
                }
            } else done += 1;
        }
        if (done === this.unk10) {
            w.sound(SE.SY_CLEAR_SIGN_BIG);
            this.unk48 = 0;
            this.unk4C = this.unk18[this.unk48];
            this.unk44 = 2;
        }
    }
    perform(cue: number) {
        if (!(cue & CUE_MOVE)) return;
        const w = this.world;
        switch (this.unk44) {
            case 1: this.depressing(); mapJoints(w).calc(); return;
            case 2:
                if (!isDemo(w)) {
                    if (this.unk4C === 0) { this.unk28[this.unk48].setUp(); this.unk24[this.unk48].remove(); this.unk44 = 3; return; }
                    this.unk4C -= 1;
                }
                return;
            case 3: this.rising(); mapJoints(w).calc(); return;
            case 4:
                if (!isDemo(w)) { if (this.unk4C === 0) { this.unk44 = 0; return; } this.unk4C -= 1; }
                return;
        }
    }
    startEvent() {
        if (this.unk44 !== 0) return false;
        for (let i = 0; i < this.unk10; ++i) { this.unk28[i].setUp(); this.unk24[i].remove(); }
        this.unk44 = 1;
        return true;
    }
    initCommon() {
        const w = this.world, n = this.unk10;
        // TODO: unk18 is new u32[] (not cleared): only set when the event point is found
        this.unk18 = new Array(n).fill(0);
        this.unk20 = new Array(n).fill(400);
        this.unk1C = new Array(n).fill(true);
        this.unk24 = []; this.unk28 = [];
        for (let i = 0; i < n; ++i) {
            const path = `map/map/building${pad2(i + this.unk14)}.col`;
            const a = new ObjCollision(w, KIND_WARP, null); a.init(path, 0); a.setUp();
            const b = new ObjCollision(w, KIND_MOVE, null); b.init(path, 0); b.setUp(); b.remove();
            this.unk24.push(a); this.unk28.push(b);
        }
        this.unk30 = new Array(n); this.unk34 = Array.from({ length: n }, () => new V3());
        // getJointNodePointer(0)->getChild()->getYounger()->getChild(), then younger ones
        let j = mapJoints(w).j3dChild()?.younger()?.j3dChild() ?? null;
        const skip = 0x43 - (this.unk14 + (n - 1));
        for (let i = 0; i < skip && j; ++i) j = j.younger();
        for (let i = 0; i < n && j; ++i) {
            const idx = (n - 1) - i;
            this.unk30[idx] = j;
            this.unk34[idx].set(fr((j.min[0] + j.max[0]) / 2), fr((j.min[1] + j.max[1]) / 2), fr((j.min[2] + j.max[2]) / 2));
            j = j.younger();
        }
    }
    /** the event point (TMapModelActor::setActor writes TMareEventPoint::unk68: the point's wall event) */
    private bindPoint(name: string) {
        const p = this.world.search(name) as any;
        if (p) p.unk68 = this;
        return !!p;
    }
    init3rdEvent() {
        this.unk10 = 7; this.unk14 = 43;
        this.initCommon();
        if (this.bindPoint('mareEP2')) {
            this.unk18[0] = 2400;
            for (let i = 1; i < this.unk10; ++i) this.unk18[i] = 120;
            const b = this.unk14;
            this.unk20[43 - b] = 900; this.unk20[44 - b] = 1300; this.unk20[45 - b] = 1300; this.unk20[46 - b] = 1300;
            this.unk20[47 - b] = 400; this.unk20[48 - b] = 300; this.unk20[49 - b] = 200;
            this.unk1C[47 - b] = false; this.unk1C[48 - b] = false; this.unk1C[49 - b] = false;
        }
    }
    init2ndEvent() {
        this.unk10 = 15; this.unk14 = 19;
        this.initCommon();
        if (this.bindPoint('mareEP1')) { this.unk18[0] = 3600; for (let i = 1; i < this.unk10; ++i) this.unk18[i] = 120; }
    }
    init1stEvent() {
        this.unk10 = 11; this.unk14 = 8;
        this.initCommon();
        if (this.bindPoint('mareEP0')) { this.unk18[0] = 3600; for (let i = 1; i < this.unk10; ++i) this.unk18[i] = 120; }
    }
}

/** 凸凹壁: a wall block that, sprayed, slides in or out (along x or z, by its building number) and stays. */
export class MareEventBumpyWall extends MapObjBase {
    unk138 = 0;
    unk13C: JointObj | null = null;
    unk140 = 0; unk144 = 0;
    unk148: ObjCollision | null = null; unk14C: ObjCollision | null = null;
    /** 0 up x, 1 down x, 2 up z, 3 down z */
    unk150 = 0;
    constructor(w: World, name = '凸凹壁') { super(w, name); }
    touchWater(_a: HitActor): number {
        switch (this.unk150) {
            case 0: this.state = 2; break;
            case 2: this.state = 3; break;
            case 1: this.state = 4; break;
            case 3: this.state = 5; break;
        }
        this.unk148!.remove();
        this.unk14C!.setUp();
        return 1;
    }
    /** bumpUpX / bumpDownX / bumpUpZ / bumpDownZ: k the axis, sign the way */
    private bump(k: number, sign: number) {
        const w = this.world, j = this.unk13C!;
        let v = j.trans[k];
        const t = new V3(); t.set(k === 0 ? v : 0, 0, k === 2 ? v : 0);
        const limit = sign > 0 ? this.unk144 : -this.unk144;
        if (sign > 0 ? v < limit : v > limit) {
            if (!isDemo(w)) {
                v = sign > 0 ? fr(v + this.unk140) : fr(v - this.unk140);
                w.sound(SE.OBJ_QUAKE, this.pos);
            }
            setJointTrans(j, k, v);
            this.unk14C!.moveTrans(t);   // (the translation from before this tick's step, as the game's)
            return;
        }
        if (k === 0) t.x = limit; else t.z = limit;
        setJointTrans(j, k, limit);
        this.unk14C!.remove();
        this.unk148!.setUpTrans(t);
        this.kill();
    }
    control() {
        super.control();
        switch (this.state) {
            case 2: this.bump(0, 1); break;
            case 3: this.bump(2, 1); break;
            case 4: this.bump(0, -1); break;
            case 5: this.bump(2, -1); break;
        }
        if (!this.isState(STATE_NORMAL)) mapJoints(this.world).calc();
    }
    load(s: Stream) {
        super.load(s);
        this.unk138 = s.s32();
        this.unk13C = getBuildingJointObj(this.world, this.unk138);
        this.unk148 = newAndInitBuildingCollision(this.world, KIND_WARP, this.unk138, null);
        this.unk14C = newAndInitBuildingCollision(this.world, KIND_MOVE, this.unk138, null);
        this.unk148.setUp();
        this.unk140 = 2; this.unk144 = 400;
        const b = this.unk138;
        if ((b >= 0x32 && b <= 0x3A) || (b >= 0x3F && b <= 0x43)) this.unk150 = 0;
        else if ((b >= 0x22 && b <= 0x26) || b === 0x2A) this.unk150 = 1;
        else if (b >= 0x27 && b <= 0x29) this.unk150 = 2;
        else if (b >= 0x3B && b <= 0x3E) this.unk150 = 3;
    }
}

// ================================================================ TMap::loadAfter's initStage
/** The scene.bin's Map (TMap): here only its loadAfter's initStage (Map.cpp). */
export class MapStage extends NameRef {
    constructor(public world: World, name = 'マップ') { super(name); }
    loadAfter() { initStage(this.world); }
}
const buildingWarpUp = (w: World, i: number) => newAndInitBuildingCollision(w, KIND_WARP, i, null).setUp();
/** initStage (Map.cpp): the building collisions some stages start with, and Noki Bay's depress walls (initMare). */
export function initStage(w: World) {
    const stage = w.stage;
    if (stage > 9) return;
    // (initStageCommon: the indirect sea and particles)
    switch (w.map) {
        case 1:
            if (stage === 5 || stage === 9) break;
            buildingWarpUp(w, 1); buildingWarpUp(w, 2);
            break;
        case 2:
            if (stage === 0) break;
            buildingWarpUp(w, 1); buildingWarpUp(w, 2);
            break;
        case 9: {
            // initMare (stage 5's EX gate, a TMapStaticObj "Mare5ExGate", isn't here)
            if (stage !== 0) for (let i = 1; i < 8; ++i) buildingWarpUp(w, i);
            const name = 'イベント（マーレへこむ壁）';
            const a = new MareEventDepressWall(w, name); a.init1stEvent();
            const b = new MareEventDepressWall(w, name); b.init2ndEvent();
            const c = new MareEventDepressWall(w, name); c.init3rdEvent();
            for (const e of [a, b, c]) { w.register(e); w.conductor.others.push(e); }
            break;
        }
        case 6:
            if (stage === 0) break;
            buildingWarpUp(w, 1);
            break;
    }
}

// ================================================================ TMarDirector::setNextStage
declare module './engine.js' {
    interface World {
        /** TMarDirector::setNextStage (and the gate demo updateGameMode starts) */
        setNextStage(stage: number, actor: any): void;
        /** DIRECTOR_FLAG_*_STAGE_TRANSITION_PENDING: a stage change asked for */
        stageTransitionPending?: boolean;
        /** TMarDirector::fireStreamingMovie */
        fireStreamingMovie(id: number): void;
        /** DIRECTOR_FLAG_MOVIE_PENDING */
        moviePending?: boolean;
        /** SMSGetApplication()->mNextArea as setNextStage / decideNextStage set it (scenario 0xFF: moveStage picks it); the movie setMovie asked for */
        nextArea?: { stage: number; scenario: number; movie?: number } | null;
    }
}
/**
 * TMarDirector::setNextStage: a stage change from Delfino (map 1) to Pinna Park (5), Sirena (6) or
 * Pianta (8) with no actor is a gate demo (DIRECTOR_FLAG_GATE_DEMO_STAGE_TRANSITION_PENDING); the
 * director's updateGameMode then starts its camera, and for Pinna Park the plaza cannon's demo
 * (unk254 = デモ砲台: TDemoCannon::startDemo). TODO: updateGameMode does it on its next pass, not here.
 */
World.prototype.setNextStage = function (this: World, stage: number, actor: any) {
    if (this.stageTransitionPending) return;
    this.stageTransitionPending = true;
    const next = stage >= 0x100 ? (stage >> 8) - 1 : stage;
    // SMSGetApplication()->setNextArea (a stage >= 0x100: (area + 1) << 8 | scenario)
    const na: { stage: number; scenario: number; movie?: number } = { stage: next & 0xFF, scenario: stage >= 0x100 ? stage & 0xFF : 0xFF, movie: this.nextArea ? this.nextArea.movie : undefined };
    if (next === 0x37) { this.moviePending = true; na.movie = 6; }
    this.nextArea = na;
    if (actor || this.map !== 1 || (next !== 5 && next !== 6 && next !== 8)) return;
    if (next === 5) {
        demoCamera(this, 'hodai_dpt_pinna1', null);
        const cannon = this.search('デモ砲台') as any;
        if (cannon && typeof cannon.startDemo === 'function') cannon.startDemo();
    } else demoCamera(this, next === 6 ? 'camera_sirena_gate_in' : 'camera_monte_gate_in', null);
};

/**
 * TMarDirector::fireStreamingMovie (MarDirectorEvent.cpp): once (DIRECTOR_FLAG_MOVIE_PENDING), the
 * movie's stage change (setNextStage) and SMSGetApplication()->setMovie (told as a 'streamingMovie'
 * event); movie 0 (the Bowser boat) also sets its two flags.
 */
World.prototype.fireStreamingMovie = function (this: World, id: number) {
    id &= 0xFF;
    if (this.moviePending) return;
    this.moviePending = true;
    const next: Record<number, number> = { 0: 0x1, 10: 0x3B, 7: 0xE06, 8: 0xE07, 11: 0x3C, 2: 0x101 };
    this.nextArea = { stage: 0xFF, scenario: 0xFF, movie: id };
    this.setNextStage(next[id] ?? 0xF, null);
    if (id === 0) {
        this.flags.setBool(true, MSF.BOWSER_BOAT_CUTSCENE_TRIGGERED);
        this.flags.setBool(true, MSF.PEACH_KIDNAP_FMV_WATCHED_SINCE_RESET);
    }
    this.events.push({ t: this.tickCount, kind: 'streamingMovie', data: { id } });
};

// ---------------------------------------------------------------- registry
register('MapEventSinkInPollution', (w, n) => new MapEventSinkInPollution(w, n));
register('MapEventSinkInPollutionReset', (w, n) => new MapEventSinkInPollutionReset(w, n));
register('MapEventSinkShadowMario', (w, n) => new MapEventSinkShadowMario(w, n));
register('MapEventSirenaSink', (w, n) => new MapEventSirenaSink(w, n));
register('AirportEventSink', (w, n) => new AirportEventSink(w, n));
register('MapEventSinkBianco', (w, n) => new MapEventSinkBianco(w, n));
register('DolpicEventBiancoGate', (w, n) => new DolpicEventBiancoGate(w, n));
register('DolpicEventRiccoGate', (w, n) => new DolpicEventRiccoMammaGate(w, n));
register('DolpicEventMammaGate', (w, n) => new DolpicEventRiccoMammaGate(w, n));
register('MareEventBumpyWall', (w, n) => new MareEventBumpyWall(w, n));
register('MareEventWallRock', (w, n) => new MareEventWallRock(w, n));
register('Map', (w, n) => new MapStage(w, n));
