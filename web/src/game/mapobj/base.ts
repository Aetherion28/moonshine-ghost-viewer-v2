// Map objects (MoveBG/MapObjBase.cpp, MapObjInit.cpp's init*, MapObjLib.cpp's helpers,
// MapObjManager.cpp). A map object is a TLiveActor whose model, hit cylinders, collision files and
// flags come from its entry in sObjDataTable (objdata.ts), found by the individual name scene.bin
// gives it; its manager (named by that entry) performs it.
//
// Not here: sounds (startSound / soundBas), particles (emit*: told as world events), the BCK-driven
// movement (TMapObjMoveData: none in Bianco Hills), hold data's taking model, mirror actors and
// the static draw buffers (drawing only).

import { fr, V3, Mtx, mtx, MsMtxSetXYZRPH, MsMtxSetRotRPH } from '../math.js';
import {
    World, Stream, Actor, HitActor, TakeActor, LiveActor, LiveManager, MActor, LF, HF, HC, MSG, ANM_BCK, CUE_MOVE, CUE_CALC_ANIM,
    CUE_CALC_VIEW, CUE_ENTRY, calcKeyCode,
} from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { OBJ_DATA } from './objdata.js';
import type { MapObjData } from './types.js';
import { ObjCollisionManager, KIND_STATIC, KIND_MOVE, COL_UNK4000, COL_UNK8000, MsMtxSetTRS } from './objcol.js';

/** MAP_OBJ_FLAG_* */
export const MOF = {
    NO_CLIPPING: 0x1, MOVE_COLLISION_ON_CONTACT: 0x2, SCALE_AND_ROTATE_COLLISION: 0x4, UNK8: 0x8, UNK10: 0x10, UNK20: 0x20, CLIMBABLE: 0x40,
    LOAD_HIT_HEIGHT: 0x80, NO_ANIMATIONS: 0x100, TURN_OFF_ANIMATIONS_AT_END: 0x200, USE_SIMPLE_VIEW_CALC: 0x400, STATIC_DRAW: 0x800, UNK1000: 0x1000,
    SQUARE_SHADOW: 0x2000, UNK4000: 0x4000, INDIRECT_TEXTURE: 0x8000, ENABLE_WALL_COLLISION: 0x10000, ENABLE_ROOF_COLLISION: 0x20000,
    DISAPPEARING: 0x40000, RESPAWNING: 0x80000, TAKEABLE: 0x100000, UNK200000: 0x200000, KILLED_BY_WATER: 0x400000, UNK800000: 0x800000,
    CAN_SINK: 0x1000000, UNK2000000: 0x2000000, UNK4000000: 0x4000000, UNK8000000: 0x8000000, UNK10000000: 0x10000000, UNK20000000: 0x20000000,
};
export const STATE_DEAD = 0, STATE_NORMAL = 1;
const MOVE_COLLISION_ON_CONTACT_GRACE_TIMER = 4;

// ---------------------------------------------------------------- sObjDataTable
const END_DATA: MapObjData = OBJ_DATA[OBJ_DATA.length - 1];
const DATA_BY_KEY = new Map<number, MapObjData[]>();
for (const d of OBJ_DATA) {
    if (!d.type || !d.name) continue;
    const k = calcKeyCode(d.name);
    (DATA_BY_KEY.get(k) || DATA_BY_KEY.set(k, []).get(k)!).push(d);
}
/** initActorData's search: key code and name (the end entry when it isn't there). */
export function findObjData(name: string): MapObjData {
    const list = DATA_BY_KEY.get(calcKeyCode(name));
    return (list && list.find((d) => d.name === name)) || END_DATA;
}

// ---------------------------------------------------------------- the stage's managers (gpMapObjManager, gpItemManager)
interface MapObjGlobals { mapObjManager: MapObjManager | null; itemManager: any | null; }
const GLOBALS = new WeakMap<World, MapObjGlobals>();
export function mapObjGlobals(w: World): MapObjGlobals {
    let g = GLOBALS.get(w);
    if (!g) { g = { mapObjManager: null, itemManager: null }; GLOBALS.set(w, g); }
    return g;
}

/** newUniqueObjByName's other classes, by name (each world's file adds its own). */
export const UNIQUE_MAKERS = new Map<string, (w: World) => MapObjBase>();
/** The objects newAndRegisterObj makes by name (newItemByName / newUniqueObjByName: item.ts fills these). */
export const OBJ_MAKERS = {
    item: null as ((w: World, name: string) => MapObjBase | null) | null,
    unique: null as ((w: World, name: string) => MapObjBase | null) | null,
};

const toLowerPath = (p: string) => p.replace(/^\/?scene\//i, '').replace(/^\//, '').toLowerCase();

// ---------------------------------------------------------------- TMapObjBase
export class MapObjBase extends LiveActor {
    individualName = '';
    mapObjFlags = 0;
    state = STATE_NORMAL;
    activeAnimIndex = 0xFFFF;
    activeSoundIndex = 0xFFFF;
    graceTimer = 0;
    stateTimer = 0;
    yOffset = 0;
    initialPos = new V3(); initialRot = new V3(); initialScale = new V3(1, 1, 1);
    data: MapObjData = END_DATA;
    eventId = 0;
    colMgr: ObjCollisionManager | null = null;
    /** TMActorKeeper: the models by file name */
    mactors: MActor[] = [];
    /** the root joint matrix, when something sets it (setModelMtx) */
    anmMtx0: Mtx | null = null;

    constructor(w: World, name = '地形オブジェ基底') { super(w, name); }

    checkMapObjFlag(f: number) { return (this.mapObjFlags & f) !== 0; }
    onMapObjFlag(f: number) { this.mapObjFlags |= f; }
    offMapObjFlag(f: number) { this.mapObjFlags &= ~f; }
    isState(s: number) { return this.state === s; }
    isStateTimerEngaged() { return this.stateTimer > 0; }

    /**
     * getModel()->getAnmMtx(0): the root joint's matrix (the base matrix and scale; the root joint
     * itself is at rest). J3DMtxCalcBasic::init (0x8001F904) scales the base matrix's columns by
     * fmuls, translation as it is; a rest root joint's concat with the identity leaves it so.
     * It is what the model's calc (CalcAnim: once a frame, the last tick) made it: baseTR only
     * changes there (calcRootMatrix), so it stands for the whole frame's four movement ticks.
     */
    rootMtx(): Mtx {
        if (this.anmMtx0) return this.anmMtx0;
        const B = this.baseTR, s = this.scale, m = mtx();
        const sx = fr(s.x), sy = fr(s.y), sz = fr(s.z);
        m[0] = fr(B[0] * sx); m[1] = fr(B[1] * sy); m[2] = fr(B[2] * sz); m[3] = fr(B[3]);
        m[4] = fr(B[4] * sx); m[5] = fr(B[5] * sy); m[6] = fr(B[6] * sz); m[7] = fr(B[7]);
        m[8] = fr(B[8] * sx); m[9] = fr(B[9] * sy); m[10] = fr(B[10] * sz); m[11] = fr(B[11]);
        return m;
    }

    // ------------------------------------------------------------ loading
    load(s: Stream) {
        Actor.prototype.load.call(this, s);
        this.individualName = s.str();
        this.loadBeforeInit(s);
        this.initMapObj();
        this.offMapObjFlag(MOF.DISAPPEARING);
        this.makeObjAppeared();
        if (this.checkMapObjFlag(MOF.LOAD_HIT_HEIGHT)) {
            const v = s.f32();
            this.damageHeight = v; this.attackHeight = v; this.calcEntryRadius();
            this.offHitFilter(HF.NO_DAMAGE); this.offHitFilter(HF.NO_ATTACK);
        }
    }
    loadBeforeInit(_s: Stream) { }
    loadAfter() {
        const [h, d] = this.world.checkGround(this.pos.x, this.pos.y, this.pos.z);
        this.groundHeight = h; this.groundPlane = d;
    }
    /** initAndRegister: made by name (newAndRegisterObj), into its entry's group */
    initAndRegister(name: string) {
        this.individualName = name;
        this.initMapObj();
        if (this.data.group) this.world.addToGroup(this.data.group, this);
    }
    initMapObj() {
        this.initialPos.set(this.pos); this.initialRot.set(this.rot); this.initialScale.set(this.scale);
        this.initActorData();
        this.initModelData();
        this.initObjCollisionData();
        this.initMapCollisionData();
        this.initBckMoveData();
        this.initHoldData();
        this.initUnique();
        this.checkIllegalAttr();
        if (this.data.unk30 === 0) this.onLiveFlag(LF.UNK8);
        this.makeObjDead();
    }
    initActorData() {
        const d = findObjData(this.individualName);
        if (this.name === '地形オブジェ') this.name = this.individualName;
        this.data = d;
        this.mapObjFlags = d.flags;
        const m = d.manager ? this.world.search(d.manager) as LiveManager | null : null;
        this.manager = m;
        if (m) m.manageActor(this);
        if (d.hit) this.yOffset = fr(this.scale.y * d.hit.unk8);
        this.pos.y = fr(this.pos.y + this.yOffset);
        this.scaledBodyRadius = fr(d.unk30 * this.scale.x);
        if (this.checkMapObjFlag(MOF.NO_CLIPPING)) this.offLiveFlag(LF.ENABLE_CLIPPING);
        if (this.checkMapObjFlag(MOF.TAKEABLE)) this.unkE8 = 2;
    }
    getSDLModelFlag() { return 3; }
    initModelData() { this.makeMActors(); }
    /** TMActorKeeper::getMActor(name) */
    getMActor(file: string | null): MActor | null {
        if (!file) return null;
        const p = file.toLowerCase();
        return this.mactors.find((a) => a.model.endsWith('/' + p) || a.model === p) || null;
    }
    initMActor(file: string): MActor | null {
        const old = this.mactor;
        let a: MActor | null = null;
        if (this.manager) {
            const folder = this.manager.folder();
            a = new MActor((folder ? folder + '/' : '') + file.toLowerCase(), this.manager.getMActorAnmData());
            if (!this.world.files.scene(a.model)) a = null;
        }
        if (a) this.mactors.push(a);
        this.mactor = a;
        if (a) this.calcRootMatrix();
        this.mactor = old;
        return a;
    }
    makeMActors() {
        const anim = this.data.anim;
        const max = anim ? anim.max : 1;
        if (max === 0) return;
        if (anim) {
            this.mactor = this.initMActor(anim.entries[0].bmd || '');
            for (let i = 1; i < anim.num; i++) {
                const e = anim.entries[i];
                if (e.bmd && !anim.entries.slice(0, i).some((p) => p.bmd && p.bmd === e.bmd)) this.initMActor(e.bmd);
            }
        } else this.mactor = this.initMActor(`${this.data.name}.bmd`);
    }
    getHitObjNumMax() { return 5; }
    initObjCollisionData() {
        const h = this.data.hit;
        if (h) {
            this.initHitActor(this.data.type, this.getHitObjNumMax(), h.filter, 0, 0, 0, 0);
            this.setObjHitData(0);
            const t = h.entries[0];
            const rs = this.scale.x > this.scale.z ? this.scale.x : this.scale.z;
            if (t[2] > 0) { this.bodyRadius = fr(t[2] * rs); this.headHeight = fr(t[3] * this.scale.y); }
            else { this.bodyRadius = fr(t[0] * rs); this.headHeight = fr(t[1] * this.scale.y); }
        } else {
            this.initHitActor(0, 1, 0, 0, 0, 0, 0);
            this.bodyRadius = 0; this.headHeight = 0;
        }
        if (this.attackRadius === 0 || this.attackHeight === 0) this.onHitFilter(HF.NO_ATTACK);
        if (this.damageRadius === 0 || this.damageHeight === 0) this.onHitFilter(HF.NO_DAMAGE);
    }
    initMapCollisionData() {
        const c = this.data.col;
        if (!c) return;
        this.colMgr = new ObjCollisionManager(this.world, c.max, 'mapObj', this);
        for (let i = 0; i < c.num; i++) if (c.entries[i].file) this.colMgr.init(c.entries[i].file!, c.entries[i].flags);
        this.mapCollision = this.colMgr;
    }
    // TODO: TMapObjMoveData (a BCK driving the object): no Bianco Hills object has one.
    initBckMoveData() { }
    initHoldData() { }
    /** initUnique: the material tables some objects take (for the viewer: MActor.bmt) */
    initUnique() {
        const a = this.mactor, t = this.actorType;
        if (!a) return;
        const bmt = (f: string, tex = false) => { for (const m of this.mactors) { m.bmt = f; if (tex) (m as any).bmtTex = true; } };
        if ([AT.BIG_WINDMILL_BLOCK, AT.BIG_WINDMILL, AT.BIA_WATERMILL01, AT.BIA_TURN_BRIDGE, AT.BIA_BELL, AT.BIA_WATERMILL00, AT.BIA_WATERMILL_VERTICAL,
            AT.LAMP_BIANCO, AT.BIA_DOOR, AT.MINI_WINDMILL_L].includes(t)) { if (this.world.map === 2) a.bmt = 'mapobj/bianco.bmt'; }
        else if (t === AT.LEAF_BOAT || t === AT.LEAF_BOAT_ROTTEN) a.bmt = 'mapobj/leafboat.bmt';
        else if (t === AT.ARROW_BOARD_LR) a.bmt = 'mapobj/arrowboard.bmt';
        else if (t === AT.FLOWER_ORANGE) a.bmt = 'mapobj/flower.bmt';
        else if ([AT.NORMAL_NOZZLE_ITEM, AT.BACK_NOZZLE_ITEM, AT.WATERGUN_ITEM, AT.ROCKET_NOZZLE_ITEM].includes(t)) a.bmt = 'mapobj/nozzleitem.bmt';
        else if (t === AT.NOZZLE_BOX) bmt('mapobj/nozzlebox.bmt', true);
        else if (t === AT.MIRROR_L) a.bmt = 'mapobj/mirror.bmt';
        else if (t === AT.RICCO_SHIP) a.bmt = 'mapobj/riccoship.bmt';
    }
    checkIllegalAttr() { }

    // ------------------------------------------------------------ hit data and collision
    setObjHitData(i: number) {
        const h = this.data.hit;
        if (!h || h.num <= i) return;
        const t = h.entries[i];
        if (t[0] >= 0) {
            const rs = this.scale.x > this.scale.z ? this.scale.x : this.scale.z, hs = this.scale.y;
            this.setHitParams(fr(t[0] * rs), fr(t[1] * hs), fr(t[2] * rs), fr(t[3] * hs));
        }
    }
    removeMapCollision() {
        const c = this.colMgr;
        if (!c) return;
        const a = c.getActiveCollision();
        if (a && a.kind !== KIND_STATIC) c.removeActiveCollision();
    }
    private colPos() { return new V3(this.pos.x, fr(this.pos.y - this.yOffset), this.pos.z); }
    setUpCurrentMapCollision() {
        const c = this.colMgr;
        if (!c) return;
        if (this.checkMapObjFlag(MOF.UNK8)) c.getActiveCollision()!.setUpMtx(this.rootMtx());
        else c.setUpActiveCollisionTRS(this.colPos(), this.rot, this.scale);
    }
    setUpMapCollision(i: number) {
        const col = this.data.col;
        if (!col || !col.entries[i] || !col.entries[i].file || !this.colMgr) return;
        const p = this.colPos();
        this.colMgr.changeCollision(i);
        if (this.checkMapObjFlag(MOF.UNK8)) this.colMgr.getActiveCollision()!.setUpMtx(this.rootMtx());
        else this.colMgr.setUpActiveCollisionTRS(p, this.rot, this.scale);
    }
    setGroundCollision() {
        const c = this.colMgr;
        if (!c) return;
        const a = c.getActiveCollision();
        if (!a || a.kind !== KIND_MOVE) return;
        if (this.checkMapObjFlag(MOF.MOVE_COLLISION_ON_CONTACT)) {
            if (this.collisions.length === 0 && this.graceTimer === 0) return;
            this.graceTimer = (this.graceTimer - 1) << 16 >> 16;
            if (this.collisions.length !== 0) this.graceTimer = MOVE_COLLISION_ON_CONTACT_GRACE_TIMER;
        }
        if (this.checkMapObjFlag(MOF.UNK8)) c.moveActiveCollisionMtx(this.rootMtx());
        else {
            const p = this.colPos();
            if (this.checkMapObjFlag(MOF.SCALE_AND_ROTATE_COLLISION)) {
                a.flags &= ~COL_UNK8000; a.flags &= ~COL_UNK4000;
                c.moveActiveCollisionSRT(p, this.rot, this.scale);
            } else {
                a.flags &= ~COL_UNK4000;
                c.moveActiveCollisionTrans(p);
            }
        }
    }
    hasMapCollision() { return !!this.colMgr; }
    changeObjMtx(m: Mtx) {
        this.pos.set(m[3], fr(m[7] + this.yOffset), m[11]);
        if (this.mactor) {
            if (this.checkMapObjFlag(MOF.NO_ANIMATIONS)) this.anmMtx0 = Float64Array.from(m);
            else this.calcRootMatrix();
        }
        this.removeMapCollision();
        this.setUpCurrentMapCollision();
    }
    changeObjSRT(t: V3, r: V3, s: V3) { const m = mtx(); MsMtxSetTRS(m, t.x, t.y, t.z, r.x, r.y, r.z, s.x, s.y, s.z); this.changeObjMtx(m); }
    awake() { this.offLiveFlag(LF.UNK4000); this.offHitFilter(HF.NO_COLLISION); this.setUpCurrentMapCollision(); }
    sleep() { this.onLiveFlag(LF.UNK4000); this.onHitFilter(HF.NO_COLLISION); this.removeMapCollision(); }

    // ------------------------------------------------------------ animations
    private anim() { return this.data.anim; }
    hasModelOrAnimData(i: number) {
        const a = this.anim();
        return !(!a || a.num <= i || (!a.entries[i].anm && !a.entries[i].bmd));
    }
    hasAnim(i: number) { const a = this.anim(); return !(!a || a.num <= i || !a.entries[i].anm); }
    animIsFinished() {
        const a = this.anim();
        if (!a || a.num === 0 || !a.entries[this.activeAnimIndex] || !a.entries[this.activeAnimIndex].anm) return true;
        return !this.mactor || this.mactor.curAnmEndsNext(ANM_BCK);
    }
    private stopActive() {
        const a = this.anim();
        if (this.activeAnimIndex === 0xFFFF || !a || a.num === 0) return;
        const e = a.entries[this.activeAnimIndex];
        if (!e || !e.anm || !this.mactor) return;
        const fc = this.mactor.getFrameCtrl(e.type);
        if (fc) { fc.rate = 0; fc.frame = 0; }
        this.mactor.setFromIndex(e.type, -1);
        this.activeAnimIndex = 0xFFFF;
    }
    startAnim(index: number) {
        const anim = this.anim();
        if (!this.mactor && anim && anim.num !== 0) this.mactor = this.getMActor(anim.entries[0].bmd);
        if (!anim || index >= anim.num) return;
        const d = anim.entries[index];
        if (d.type === 0) {
            this.stopActive();
            if (this.activeAnimIndex !== index) {
                this.activeAnimIndex = index;
                if (d.bmd) this.mactor = this.getMActor(d.bmd);
            }
        }
        if (d.anm && this.mactor) {
            this.offMapObjFlag(MOF.NO_ANIMATIONS);
            this.mactor.setAnimation(d.anm, d.type);
            if (this.checkMapObjFlag(MOF.TURN_OFF_ANIMATIONS_AT_END)) this.offMapObjFlag(MOF.NO_ANIMATIONS);
        }
    }
    startControlAnim(i: number) {
        this.startAnim(i);
        const a = this.anim();
        if (a && i < a.num && this.mactor) { const fc = this.mactor.getFrameCtrl(a.entries[i].type); if (fc) fc.rate = 0; }
    }
    startBck(name: string) { this.offMapObjFlag(MOF.NO_ANIMATIONS); if (this.mactor) this.mactor.setBck(name); }
    startSound(i: number) { if (this.activeSoundIndex !== i) this.activeSoundIndex = i; }

    // ------------------------------------------------------------ states
    makeObjDefault() {
        this.pos.set(this.initialPos.x, fr(this.initialPos.y + this.yOffset), this.initialPos.z);
        this.rot.set(this.initialRot); this.scale.set(this.initialScale);
        this.vel.zero();
        this.onLiveFlag(LF.UNK10);
        if (this.mactor) this.calcRootMatrix();
        const [h, d] = this.world.checkGround(this.pos.x, this.pos.y, this.pos.z);
        this.groundHeight = h; this.groundPlane = d;
    }
    makeObjDead() {
        this.vel.zero();
        this.onLiveFlag(LF.UNK10);
        this.stopActive();
        this.activeSoundIndex = 0xFFFF;
        this.onHitFilter(HF.NO_COLLISION);
        this.removeMapCollision();
        this.stateTimer = 0;
        if (this.held) { this.held.receiveMessage(this, MSG.DETACH); this.held = null; }
        if (this.holder) { this.holder.receiveMessage(this, MSG.DETACH); this.holder = null; }
        this.onLiveFlag(LF.DEAD | LF.UNK8 | LF.UNK10 | LF.UNK40 | LF.AIRBORNE);
        this.state = STATE_DEAD;
    }
    makeObjAppeared() {
        this.offLiveFlag(LF.DEAD | LF.UNK8);
        this.vel.zero();
        this.onLiveFlag(LF.UNK10);
        this.stateTimer = 0;
        this.offHitFilter(HF.NO_COLLISION);
        this.setObjHitData(0);
        this.startSound(0);
        const [h, d] = this.world.checkGround(this.pos.x, this.pos.y, this.pos.z);
        this.groundHeight = h; this.groundPlane = d;
        if (this.checkLiveFlag(LF.UNK10)) this.onLiveFlag(LF.AIRBORNE);
        this.startAnim(0);
        this.pos.y = fr(this.pos.y - this.yOffset);
        this.setUpMapCollision(0);
        this.pos.y = fr(this.pos.y + this.yOffset);
        this.state = STATE_NORMAL;
    }
    kill() { this.makeObjDead(); }
    appear() { this.makeObjAppeared(); }
    dead() { }
    calc() { }

    // ------------------------------------------------------------ touching
    touchBoss(a: HitActor) { a.receiveMessage(this, MSG.ATTACK); }
    touchEnemy(a: HitActor) { a.receiveMessage(this, MSG.ATTACK); }
    touchPlayer(a: HitActor) { a.receiveMessage(this, MSG.ATTACK); }
    touchWater(_a: HitActor): number { return 0; }
    touchActor(a: HitActor) {
        if (a.isHitCategory(HC.PLAYER)) this.touchPlayer(a);
        else if (a.isHitCategory(HC.ENEMY)) this.touchEnemy(a);
        else if (a.isHitCategory(HC.BOSS)) this.touchBoss(a);
    }
    ensureTakeSituation() {
        if (this.held && this.held.holder !== this) this.held = null;
        if (this.holder && this.holder.held !== this) {
            if (this.pos.y !== this.groundHeight) this.offLiveFlag(LF.UNK10);
            this.holder = null;
        }
    }
    control() {
        for (const c of this.collisions.slice()) this.touchActor(c);
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (msg === MSG.ATTACH && this.checkMapObjFlag(MOF.CLIMBABLE)) { this.held = sender as TakeActor; return true; }
        if (msg === MSG.SPRAYED_BY_WATER) return this.touchWater(sender) !== 0;
        return false;
    }
    getTakingMtx(): Mtx | null { return this.checkMapObjFlag(MOF.CLIMBABLE) ? null : super.getTakingMtx(); }
    getRootJointMtx(): Mtx | null { return this.checkMapObjFlag(MOF.UNK8) || this.yOffset !== 0 ? this.rootMtx() : null; }
    calcRootMatrix() {
        MsMtxSetXYZRPH(this.baseTR, this.pos.x, fr(this.pos.y - this.yOffset), this.pos.z, this.rot.x, this.rot.y, this.rot.z);
        this.anmMtx0 = null;
    }

    perform(cue: number) {
        const w = this.world;
        if (w.talkMode && !w.demoMode) {
            if (this.checkLiveFlag(LF.DEAD)) return;
            if (this.isActorType(AT.MAP_OBJ_TREE_SCALE)) return;
            if (cue & CUE_MOVE) { this.setGroundCollision(); cue &= ~CUE_MOVE; }
            if (this.checkLiveFlag(LF.UNK200)) return;
            if (this.hasMapCollision()) cue &= ~CUE_CALC_ANIM;
        }
        if (cue & CUE_MOVE) {
            if (this.isStateTimerEngaged()) --this.stateTimer;
            if (this.activeSoundIndex === 0) this.startSound(this.activeSoundIndex);
            if (this.checkLiveFlag(LF.DEAD)) this.dead();
        }
        if (this.checkLiveFlag(LF.DEAD)) return;
        if (this.checkLiveFlag(LF.UNK4000)) cue &= ~(CUE_CALC_ANIM | CUE_ENTRY | CUE_CALC_VIEW);
        if (cue & CUE_CALC_ANIM) {
            this.calc();
            if (this.checkMapObjFlag(MOF.NO_ANIMATIONS)) cue &= ~CUE_CALC_ANIM;
            else if (this.checkMapObjFlag(MOF.TURN_OFF_ANIMATIONS_AT_END)) {
                if (this.mactor && this.mactor.curAnmEndsNext(ANM_BCK)) this.onMapObjFlag(MOF.NO_ANIMATIONS);
            }
        }
        if (cue) super.perform(cue);
    }
    drawn() { return super.drawn() && !this.checkLiveFlag(LF.UNK4000); }

    // ------------------------------------------------------------ MapObjLib
    static isCoin(a: HitActor) { return a.isActorType(AT.COIN) || a.isActorType(AT.COIN_RED) || a.isActorType(AT.COIN_BLUE); }
    static isFruit(a: HitActor) {
        return [AT.FRUIT_COCONUT, AT.FRUIT_PAPAYA, AT.FRUIT_PINE, AT.FRUIT_DURIAN, AT.FRUIT_BANANA, AT.RED_PEPPER].some((t) => a.isActorType(t));
    }
    /** loadHideObjInfo: event id, appear speed (x 0.06), appear Y speed (20 if negative), time (x 10, 1200 if none) */
    static loadHideObjInfo(s: Stream): [number, number, number, number] {
        const ev = s.s32();
        const sp = fr(s.f32() * 0.06);
        let ys = s.f32(); if (ys < 0) ys = 20;
        let t = s.s32(); t = t <= 0 ? 1200 : t * 10;
        return [ev, sp, ys, t];
    }
    private throwVel(o: MapObjBase, speed: number, ys: number) {
        let m: Mtx;
        if (this.mactor) m = this.rootMtx();
        else { m = mtx(); MsMtxSetRotRPH(m, this.rot.x, this.rot.y, this.rot.z); }
        o.vel.set(fr(m[2] * speed), fr(fr(m[6] * speed) + ys), fr(m[10] * speed));
        o.offLiveFlag(LF.UNK10);
    }
    throwObjToFront(o: MapObjBase, yOff: number, speed: number, ys: number) {
        o.appear();
        o.pos.set(this.pos.x, fr(this.pos.y + yOff), this.pos.z);
        this.throwVel(o, speed, ys);
    }
    throwObjToFrontFromPoint(o: MapObjBase, p: V3, speed: number, ys: number) {
        o.appear();
        o.pos.set(p);
        this.throwVel(o, speed, ys);
    }
    static throwObjFromPointWithRot(o: MapObjBase, p: V3, r: V3, speed: number, ys: number) {
        o.appear();
        o.pos.set(p);
        const m = mtx(); MsMtxSetRotRPH(m, r.x, r.y, r.z);
        o.vel.set(fr(m[2] * speed), fr(fr(m[6] * speed) + ys), fr(m[10] * speed));
        o.offLiveFlag(LF.UNK10);
    }
    calcReflectingVelocity(wall: { n: number[] }, k: number, v: V3) {
        const dot = v.x * wall.n[0] + v.y * wall.n[1] + v.z * wall.n[2], f = 1 + k;
        v.x = fr(v.x - dot * wall.n[0] * f); v.y = fr(v.y - dot * wall.n[1] * f); v.z = fr(v.z - dot * wall.n[2] * f);
    }
    getDistanceXZ(p: V3) { const dx = p.x - this.pos.x, dz = p.z - this.pos.z; return fr(Math.sqrt(dx * dx + dz * dz)); }
    /** getWaterID: the drop the water hit actor stands for */
    static getWaterID(a: HitActor) { return (a as any).unk68 ?? -1; }
    getWaterSpeed(a: HitActor): V3 { const w = this.world.water, i = MapObjBase.getWaterID(a); return w && i >= 0 ? w.vel[i] : new V3(); }
    marioIsOn() { const m = this.world.mario; return m.groundPlane.actor === this && !m.isJumping(); }
    marioHeadAttack() { const m = this.world.mario; return m.pos.y < this.pos.y - this.yOffset && m.isJumping() && m.vel.y > 0; }
    marioHipAttack() { const m = this.world.mario; return m.groundPlane.actor === this && m.hipDrop && m.pos.y + m.vel.y < m.groundHeight; }
    /** particles and other effects the game shows: told to the viewer */
    emit(kind: string, p: V3 = this.pos) { this.world.effect(kind, p); }
    /** checkOnManhole (MapObjLib.cpp): on a manhole, that manhole is sealed while this is there */
    checkOnManhole() {
        const [h, d] = this.world.checkGround(this.pos.x, fr(this.pos.y + 20), this.pos.z);
        this.groundHeight = h; this.groundPlane = d;
        const a = d.actor as any;
        if (a && a.isActorType && a.isActorType(AT.MANHOLE) && a.makeManholeUnuseful) a.makeManholeUnuseful(this);
    }
}

// ---------------------------------------------------------------- managers
export class MapObjBaseManager extends LiveManager {
    clipFar = 0; actorRadius = 0;
    /** unk30 & 2: no clipping */
    unk30 = 0;
    load(s: Stream) { super.load(s); this.clipFar = s.f32(); this.actorRadius = s.f32(); }
    clipActors() { if (!(this.unk30 & 2)) this.clipActorsAux(this.clipFar, this.actorRadius); }
    createModelData() { this.createModelDataArray([]); }
    getObjNumWithActorType(t: number) { return this.objs.filter((o) => o.isActorType(t)).length; }
    canAppear(o: MapObjBase, t: number) {
        return o.isActorType(t) && !o.checkMapObjFlag(MOF.RESPAWNING) && o.checkLiveFlag(LF.DEAD) && (!o.isActorType(AT.COIN) || o.mactor !== null);
    }
    makeObjAppearAt(x: number, y: number, z: number, t: number, onGround: boolean): MapObjBase | null {
        let y2 = y;
        if (onGround) {
            const [h, d] = this.world.checkGround(x, fr(y + 5), z);
            if (d.isIllegal()) return null;
            y2 = h;
        }
        for (const o of this.objs as MapObjBase[]) if (o instanceof MapObjBase && this.canAppear(o, t)) { o.pos.set(x, y2, z); o.appear(); return o; }
        return null;
    }
    makeObjAppear(t: number): MapObjBase | null {
        for (const o of this.objs as MapObjBase[]) if (o instanceof MapObjBase && this.canAppear(o, t)) { o.appear(); return o; }
        return null;
    }
    makeObjAppeared(t: number): MapObjBase | null {
        for (const o of this.objs as MapObjBase[]) if (o instanceof MapObjBase && this.canAppear(o, t)) { o.makeObjAppeared(); return o; }
        return null;
    }
}
/** TMapObjBaseManager::newAndRegisterObj */
export function newAndRegisterObj(w: World, name: string, p = new V3(), r = new V3(), s = new V3(1, 1, 1)): MapObjBase | null {
    let o = OBJ_MAKERS.item ? OBJ_MAKERS.item(w, name) : null;
    if (!o && OBJ_MAKERS.unique) o = OBJ_MAKERS.unique(w, name);
    if (!o) return null;
    if (o.isActorType(AT.COIN)) return o;
    o.pos.set(p); o.rot.set(r); o.scale.set(s);
    o.initAndRegister(name);
    return o;
}
/** getActorTypeByEventID */
export function getActorTypeByEventID(id: number) {
    if (id < 50) return AT.COIN;
    switch (id) {
        case 100: return AT.COIN; case 200: return AT.COIN_RED; case 777: return AT.SHINE;
        case 1000: return AT.FRUIT_BANANA; case 1001: return AT.FRUIT_DURIAN; case 1002: return AT.FRUIT_PAPAYA;
        case 1003: return AT.FRUIT_PINE; case 1004: return AT.FRUIT_COCONUT; case 2000: case 2001: return AT.MUSHROOM1UP;
    }
    return 0;
}

export class MapObjManager extends MapObjBaseManager {
    constructor(w: World, name = '地形オブジェ管理') { super(w, name); mapObjGlobals(w).mapObjManager = this; }
    hasMapCollision() { return true; }
    loadAfter() {
        this.clipFar = 100000; this.actorRadius = 1000;
        newAndRegisterObj(this.world, 'NormalBlock');
        for (let i = 0; i < 10; i++) newAndRegisterObj(this.world, 'JuiceBlock');
    }
}

register('MapObjBaseManager', (w, n) => new MapObjBaseManager(w, n));
register('MapObjManager', (w, n) => new MapObjManager(w, n));
register('MapObjBase', (w, n) => new MapObjBase(w, n));
export { CUE_MOVE, CUE_CALC_ANIM };
