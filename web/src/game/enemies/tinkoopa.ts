// Mecha-Bowser (TTinKoopa, メカクッパ, Enemy/tinkoopa.cpp), Pinna Park's roller coaster boss, with
// his manager (TTinKoopaManager), his parameters (TTinKoopaParams, /enemy/tinkoopa.prm: all but
// the spine ones are set by its constructor, whatever the file says), his flame (TTinKoopaFlame),
// his six breakable parts (TTinKoopaPartsBase: head, breast, stomach, right and left arm, leg) and
// his Bullet Bill timetable (TTinKoopaLaunchSchedule / TTinKoopaLaunchOrder).
//
// He doesn't move: the coaster cart does. Everything is timed by the cart's track animation
// (Mario's mKoopaRail: checkTruckAnimationPass, its frames, and checkLap counting its three laps):
// at the schedule's frames of each lap he queues one to three Bullet Bills (TCoasterKiller, more
// the more he's broken), fired from his killer_null joints mSLKillerInterval apart, forward or
// back along the track; at frame 2750 (3400 once broken) his flame hits Mario unless water has put
// it out (mSLFlameHP sprays, then out for mSLFlameRevivalTime). Each part's collision
// (TMapCollisionMove on its joint) tells him when a rocket (TRocket) hits it: mSLPartsHP hits and
// he breaks (TNerveTinKoopaBreak: the next part falls off, its own model playing its breaking
// animation, its collision removed), else he's just shaken (TNerveTinKoopaDamage). Four breaks
// and he's beaten: the coaster Bullet Bills stop hurting Mario, and mSLDefeatWaitTime later the
// flag MSF_MECHA_BOWSER_DEFEATED is set.
//
// The cart's animation is Mario's (TMario::mKoopaRail, made in TMario's draw init for the
// coaster stage and moved by calcBaseMtxTorocco): taken from the stage's Mario when it has one,
// else a stand-in MActor of map/map/Koopa_rail here (see koopaRail).
//
// Not here: the particles (sparks, smoke, fire, the parts' trails), the camera shake, the BGM
// stop, the balloon messages (startTinKoopaMessage: the console's), the animation sounds (.bas),
// the skin deform, the light type and TTinKoopaMtxCalc (an empty blend calc).

import { MSF } from '../flags.js';
import { fr, V3 } from '../math.js';
import { vLen } from '../vecops.js';
import { World, Stream, HitActor, LiveActor, LiveManager, SpineEnemy, EnemyManager, MActor, AnmData, MoveCollision, LF, HF, MSG, ANM_BCK, CUE_MOVE, CUE_CALC_ANIM, nerve, Spine, FrameCtrl, readParams, SPINE_PARAMS, PSchema, GraphWeb } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import { holdKey } from '../sound.js';
import type { mat4 } from 'gl-matrix';
import { sendToMario } from '../mapobj/lib.js';
import { CoasterKiller, CoasterKillerManager } from './coasterkiller.js';

// ---------------------------------------------------------------- params
const TIN_KOOPA_PARAMS = {
    ...SPINE_PARAMS,
    mSLPartsHP: ['i', 2], mSLFlameHP: ['i', 10], mSLFlameRevivalTime: ['i', 10], mSLFlameDamageRadius0: ['f', 100], mSLFlameDamageHeight0: ['f', 400],
    mSLFlameDamageRadius1: ['f', 100], mSLFlameDamageHeight1: ['f', 400], mSLDamageRadius: ['f', 1000], mSLDamageHeight0: ['f', 4000],
    mSLDamageHeight1: ['f', 4000], mSLKillerInterval: ['i', 30], mSLDefeatWaitTime: ['i', 600], mSLKillerApproachingDistance: ['f', 6000],
} satisfies PSchema;
type TinKoopaParams = { [K in keyof typeof TIN_KOOPA_PARAMS]: number };
/** TTinKoopaParams::TTinKoopaParams: after TParams::load these are set, overriding the file */
function tinKoopaParams(w: World): TinKoopaParams {
    const p = readParams('/enemy/tinkoopa.prm', w.files, TIN_KOOPA_PARAMS) as TinKoopaParams;
    p.mSLPartsHP = 1; p.mSLFlameHP = 50; p.mSLFlameRevivalTime = 1200;
    p.mSLFlameDamageRadius0 = 500; p.mSLFlameDamageHeight0 = 300; p.mSLFlameDamageRadius1 = 700; p.mSLFlameDamageHeight1 = 400;
    p.mSLKillerInterval = 60; p.mSLDamageRadius = 800; p.mSLDamageHeight0 = 4000; p.mSLDamageHeight1 = 3400;
    p.mSLDefeatWaitTime = 160; p.mSLKillerApproachingDistance = 2000;
    return p;
}

// ---------------------------------------------------------------- tables
const TTinKoopa_jointNameTable = ['jnt_head', 'jnt_breast', 'jnt_stomach', 'jnt_rarm', 'jnt_larm', 'jnt_leg', 'jnt_leye', 'jnt_reye',
    'fire_null', 'fire_col_null', 'jnt_femur', 'killer_null1', 'killer_null2', 'killer_null3', 'killer_null4'];
const collisionFileName = ['/scene/tinkoopa/head_col.col', '/scene/tinkoopa/breast_col.col', '/scene/tinkoopa/stomach_col.col',
    '/scene/tinkoopa/rarm_col.col', '/scene/tinkoopa/larm_col.col', '/scene/tinkoopa/leg_col.col'];
const partsFileName = [null, 'tinkoopa_breast.bmd', 'tinkoopa_stomach.bmd', 'tinkoopa_rarm.bmd', 'tinkoopa_larm.bmd', null];
const breakingAnimationIndex = [0, 4, 11, 9, 10, 0];
const partsActorType = [AT.TIN_KOOPA_HEAD, AT.TIN_KOOPA_BREAST, AT.TIN_KOOPA_STOMACH, AT.TIN_KOOPA_RARM, AT.TIN_KOOPA_LARM, AT.TIN_KOOPA_LEG];
// tinkoopa_bastable's BCKs: break1..4 (0..3), damage1..4 (5..8), wait1..5 (12..16); by mBreakCount
const waitAnimationIndex = [12, 13, 14, 15, 16];
const breakAnimationIndex = [0, 1, 2, 3, 16];
const damageAnimationIndex = [5, 6, 7, 8, 16];
const partsVisibleFrame = [100, 134, 134, 100, 0];
const breakingPartsIndex = [2, 3, 4, 1, 2];
const breastTrackJointNameTable = ['breast_1', 'breast_2', 'breast_3', 'breast_4', 'breast_5', 'breast_6'];
const bellyTrackJointNameTable = ['stomach_1', 'stomach_2', 'stomach_3', 'stomach_4', 'stomach_5', 'stomach_6'];
const rightArmTrackJointNameTable = ['rarm_1', 'rarm_2', 'rarm_3', 'rarm_4'];
const leftArmTrackJointNameTable = ['larm_1', 'larm_2', 'larm_3', 'larm_4'];

export const TIMER_KILLER_INTERVAL = 0, TIMER_FLAME_REVIVAL = 1, TIMER_DEFEAT_WAIT = 2;

const trans = (m: mat4 | null, out = new V3()) => (m ? out.set(fr(m[12]), fr(m[13]), fr(m[14])) : out);

// ---------------------------------------------------------------- the cart (TMario::mKoopaRail)
const RAILS = new WeakMap<World, MActor | null>();
/**
 * gpMarioOriginal->mKoopaRail: the coaster track's animation (its BCK 0 at rate 0.5, from frame
 * 0). The sim's Mario doesn't make it: a stand-in here, moved on by Mecha-Bowser
 * (TODO: in the game TMario::calcBaseMtxTorocco calculates it, as Mario moves; when in the tick
 * relative to Mecha-Bowser's checks is a guess).
 */
function koopaRail(w: World): [MActor | null, boolean] {
    const own = (w.mario as any).mKoopaRail as MActor | null | undefined;
    if (own) return [own, false];
    let r = RAILS.get(w);
    if (r === undefined) {
        const data = new AnmData('map/map/koopa_rail', w.files);
        r = new MActor('map/map/koopa_rail/koopa_rail.bmd', data);
        r.setBckFromIndex(0);
        const c = r.getFrameCtrl(ANM_BCK);
        if (c && r.getCurAnmIdx(ANM_BCK) >= 0) { c.rate = 0.5; c.frame = 0; } else r = null;
        RAILS.set(w, r);
    }
    return [r, true];
}

// ---------------------------------------------------------------- TTinKoopaFlame
export class TinKoopaFlame extends HitActor {
    /** 0x6C: the fire's size (shrinks to 0.3 while it's out) */
    unk6C = 1;
    /** 0x70: sprays left before it goes out */
    unk70 = 0;
    unk72 = false;
    constructor(name: string, public mOwner: TinKoopa) {
        super(name);
        const P = mOwner.getSaveParam2();
        this.initHitActor(AT.TIN_KOOPA_FLAME, 0, 0, 0, 0, P.mSLFlameDamageRadius0, P.mSLFlameDamageHeight0);
        this.offHitFilter(HF.NO_COLLISION);
        mOwner.world.addToGroup('敵グループ', this);
        this.resetTinKoopaFlame();
    }
    makeHitCollision() {
        const o = this.mOwner, P = o.getSaveParam2();
        if (o.mBreakCount === 0) this.setHitParams(0, 0, P.mSLFlameDamageRadius0, P.mSLFlameDamageHeight0);
        else if (o.mBreakCount === 1) this.setHitParams(0, 0, P.mSLFlameDamageRadius1, P.mSLFlameDamageHeight1);
    }
    resetTinKoopaFlame() { this.unk70 = this.mOwner.getSaveParam2().mSLFlameHP; this.unk6C = 1; this.unk72 = false; }
    receiveMessage(_s: HitActor, msg: number) { if (msg === MSG.SPRAYED_BY_WATER) { this.hitWater(); return true; } return false; }
    hitWater() {
        const o = this.mOwner;
        if (o.mTimers[TIMER_FLAME_REVIVAL] > 0) return;
        if (this.unk70 > 0) --this.unk70;
        if (this.unk70 <= 0) {
            this.unk70 = o.getSaveParam2().mSLFlameHP;
            o.mTimers[TIMER_FLAME_REVIVAL] = (o.getSaveParam2().mSLFlameRevivalTime << 16) >> 16;
            this.onHitFilter(HF.NO_COLLISION);
        }
        if (!this.unk72) { this.unk72 = true; o.world.effect('ms_mkp_flame_yuge', this.pos); }
    }
    perform(cue: number) {
        const o = this.mOwner;
        if (cue & CUE_MOVE) {
            if (o.mTimers[TIMER_FLAME_REVIVAL] <= 0 && o.mBreakCount !== 4) {
                const frame = o.mBreakCount === 0 ? 2750 : 3400;
                if (o.checkTruckAnimationPass(frame)) sendToMario(o.world, this, MSG.ATTACK);
            }
        }
        if (cue & CUE_CALC_ANIM) {
            trans(o.jointMtx(9), this.pos);
            this.emitFlameEffects();
            if (o.mTimers[TIMER_FLAME_REVIVAL] <= 0) this.offHitFilter(HF.NO_COLLISION);
            this.unk72 = false;
        }
    }
    /** emitFlameEffects: the fire (particles: not here) and its size */
    emitFlameEffects() {
        const o = this.mOwner;
        if (o.spine!.current !== TinKoopaNerves.wait) return;
        if (o.mTimers[TIMER_FLAME_REVIVAL] > 0) { this.unk6C = fr(this.unk6C - 0.05); if (this.unk6C < 0.3) this.unk6C = 0.3; }
        else { this.unk6C = fr(this.unk6C + 0.05); if (this.unk6C > 1) this.unk6C = 1; }
        o.world.sound(SE.BS_MKP_FIRE, this.pos, { hold: holdKey(this, 'fire') });
    }
}

// ---------------------------------------------------------------- TTinKoopaLaunchOrder / Schedule
export class TinKoopaLaunchOrder {
    mLap = 0; mFrame = 0; mKillerNum = 0; mKillerDir = 0;
    constructor(public mOwner: TinKoopa) { }
    makeOrder(lap: number, frame: number, num: number, dir: number) { this.mLap = lap; this.mFrame = frame; this.mKillerNum = num; this.mKillerDir = dir; }
    /** checkOrder: at its lap and track frame, queue the Bullet Bills (-1: by how broken he is) */
    checkOrder() {
        const o = this.mOwner;
        if (o.mLap !== this.mLap) return;
        if (!o.checkTruckAnimationPass(this.mFrame)) return;
        let num = 1;
        if (this.mKillerNum === -1) {
            if (o.mBreakCount === 0) num = 1;
            else if (o.mBreakCount === 1) num = 1;
            else if (o.mBreakCount === 2) num = 2;
            else if (o.mBreakCount === 3) num = 3;
        } else num = this.mKillerNum;
        if (this.mKillerDir === 1) num = num <= 2 ? num : 2;
        o.makeKillerQueue(num, this.mKillerDir);
    }
}
export class TinKoopaLaunchSchedule {
    mOrders: TinKoopaLaunchOrder[] = [];
    constructor(public mOrderNum: number, public mOwner: TinKoopa) { for (let i = 0; i < mOrderNum; ++i) this.mOrders.push(new TinKoopaLaunchOrder(mOwner)); }
    checkOrder() { for (const o of this.mOrders) o.checkOrder(); }
}

// ---------------------------------------------------------------- TTinKoopaPartsBase
/**
 * One of his parts: its collision follows its joint; a rocket hitting it (the collision's actor)
 * counts as a hit on him. The four that fall off have their own model, drawn (world.extras)
 * only while it plays its breaking animation where the part was.
 */
export class TinKoopaPartsBase extends LiveActor {
    mCollision!: MoveCollision;
    /** (TMapCollisionMove's FLAG_NEEDS_SETUP: removed) */
    mCollisionSetUp = false;
    mIsBreaking = false;
    unk104: MActor | null = null;
    unk108: V3[] = [0, 1, 2, 3, 4, 5].map(() => new V3());
    constructor(name: string, public mIndex: number, public mOwner: TinKoopa) { super(mOwner.world, name); }
    initTinKoopaPartsBase() {
        this.initHitActor(partsActorType[this.mIndex], 0, 0, 0, 0, 0, 0);
        this.onHitFilter(HF.NO_COLLISION);
        this.world.addToGroup('敵グループ', this);
        this.mCollision = new MoveCollision(this.world, collisionFileName[this.mIndex], this);
        this.mCollisionSetUp = true;
        const f = partsFileName[this.mIndex];
        if (f) { this.unk104 = this.mOwner.createMActorByName(f); this.mactor = this.unk104; this.world.extras.push(this); }
        this.resetTinKoopaPartsBase();
    }
    reset() { this.resetTinKoopaPartsBase(); }
    resetTinKoopaPartsBase() { this.mIsBreaking = false; this.mCollisionSetUp = true; }
    removeCollision() { this.mCollisionSetUp = false; }
    startBreaking() {
        this.mIsBreaking = true;
        trans(this.mOwner.jointMtx(this.mIndex), this.pos);
        if (this.unk104) {
            this.unk104.setBckFromIndex(breakingAnimationIndex[this.mIndex]);
            this.baseTR[3] = this.pos.x; this.baseTR[7] = this.pos.y; this.baseTR[11] = this.pos.z;
            // (emitPartsTrackEffects: the smoke trails on its joints)
        }
    }
    /** emitPartsDisappearEffects: at frame 60 of its breaking animation it blows up, an explosion on each of its joints */
    emitPartsDisappearEffects() {
        const a = this.unk104;
        if (!a) return;
        if (!a.checkCurBckFromIndex(breakingAnimationIndex[this.mIndex])) return;
        if (!a.getFrameCtrl(ANM_BCK)!.checkPass(60)) return;
        if (this.mIndex === 1) this.emitPartsDisappearEffects_(breastTrackJointNameTable, 4);
        else if (this.mIndex === 2) this.emitPartsDisappearEffects_(bellyTrackJointNameTable, 4);
        else if (this.mIndex === 3) this.emitPartsDisappearEffects_(rightArmTrackJointNameTable, 3);
        else if (this.mIndex === 4) this.emitPartsDisappearEffects_(leftArmTrackJointNameTable, 3);
        this.mOwner.unk1E4 = null;
    }
    private emitPartsDisappearEffects_(names: string[], scale: number) {
        const a = this.unk104!;
        const scaling = this.scale.clone().scale(scale);
        const all = a.anmMtxAll(this.baseTR, this.scale);
        for (let i = 0; i < names.length; ++i) {
            const j = a.jointIndex(names[i]);
            if (j < 0) break;
            trans(all ? all[j] : null, this.unk108[i]);
            const e = this.world.conductor.makeOneEnemyAppear(this.unk108[i], 'エフェクト爆発マネージャー', 1) as any;
            if (!e) break;
            e.generate(this.unk108[i], scaling);
        }
    }
    receiveMessage(sender: HitActor) { if (sender.isActorType(AT.ROCKET)) { this.mOwner.hitParts(); return true; } return false; }
    perform(cue: number) {
        // (TLiveActor::perform: nothing it does shows — no spine, no model of its own while whole)
        if ((cue & CUE_MOVE) && this.mCollisionSetUp) { const m = this.mOwner.jointMtx(this.mIndex); if (m) this.mCollision.moveMat4(m); }
        if ((cue & CUE_CALC_ANIM) && this.mIsBreaking) { if (this.unk104 && this.unk104.curAnmEndsNext(ANM_BCK)) this.mIsBreaking = false; }
        if (this.mIsBreaking && this.unk104 && (cue & CUE_CALC_ANIM)) this.unk104.frameUpdate();
    }
    calcRootMatrix() { }
    drawn() { return this.mIsBreaking && !!this.unk104; }
}

// ---------------------------------------------------------------- TTinKoopaManager
export class TinKoopaManager extends EnemyManager {
    constructor(w: World, name = 'メカクッパマネージャー') { super(w, name); }
    load(s: Stream) { super.load(s); this.saveParams = tinKoopaParams(this.world); }
    // loadAfter: the particles only
    createModelData() { this.createModelDataArray(['tinkoopa_body.bmd']); }
    hasMapCollision() { return true; }
    createEnemyInstance(): SpineEnemy | null { return null; }
}

// ---------------------------------------------------------------- TTinKoopa
export class TinKoopa extends SpineEnemy {
    /** 0x150: parts broken off (4: beaten) */
    mBreakCount = 0;
    unk154 = 0; unk158 = 0;
    /** 0x15C: the cart's lap (0..2) */
    mLap = 0;
    mFlame!: TinKoopaFlame;
    /** 0x164: the cart's track animation */
    mTruckActor: MActor | null = null;
    private ownRail = false;
    mFirstFlameMessageShown = false;
    mQueuedKillerDirs = [0, 0, 0, 0];
    mQueuedKillerNum = 0; mQueuedKillersLaunchedNum = 0;
    mTimers = [0, 0, 0];
    unk184 = new V3(); unk190 = new V3(); unk19C = new V3(); unk1A8 = new V3();
    unk1B4 = 0; unk1B8 = 0; unk1BC = 0; unk1C0 = 0;
    mPartsHp = 0;
    mParts: TinKoopaPartsBase[] = [];
    /** 0x1E4: the part falling off */
    unk1E4: TinKoopaPartsBase | null = null;
    /** 0x1E8: the lengths of the killer graph's links */
    unk1E8: number[] = [];
    unk1EC: GraphWeb | null = null;
    unk1F0: CoasterKillerManager | null = null;
    mLaunchSchedule!: TinKoopaLaunchSchedule;
    unk1F8 = 0;
    /** (the sim's: MSF_MECHA_BOWSER_DEFEATED told) */
    defeatFlagSet = false;
    /** TTinKoopa_jointIndexTable */
    jointIndexTable: number[] = [];
    /** the joints' world matrices as the last calc left them */
    joints: mat4[] | null = null;
    constructor(w: World, name = 'メカクッパ') {
        super(w, name);
        this.onLiveFlag(LF.UNK10);
        this.offLiveFlag(LF.ENABLE_CLIPPING);
        this.scaledBodyRadius = 2000;
    }
    getSaveParam2(): TinKoopaParams { return this.getSaveParam() as TinKoopaParams; }
    hasMapCollision() { return true; }
    init(m: LiveManager | null) {
        if (!m) return;
        this.manager = m;
        m.manageActor(this);
        this.spine!.initWith(TinKoopaNerves.wait);
        this.mactor = this.createMActorByName('tinkoopa_body.bmd');
        this.jointIndexTable = TTinKoopa_jointNameTable.map((n) => (this.mactor ? this.mactor.jointIndex(n) : -1));
        this.mFlame = new TinKoopaFlame('flame', this);
        for (let i = 0; i < 6; ++i) {
            this.mParts[i] = new TinKoopaPartsBase(collisionFileName[i], i, this);
            this.mParts[i].initTinKoopaPartsBase();
        }
        const P = this.getSaveParam2();
        this.initHitActor(AT.TIN_KOOPA, 1, 0, 0, 0, P.mSLDamageRadius, P.mSLDamageHeight0);
        this.offHitFilter(HF.NO_COLLISION);
        this.calcRootMatrix();
        this.unk1EC = this.world.graphByName('killer');
        this.makeCoasterDistanceTable();
        this.mLaunchSchedule = new TinKoopaLaunchSchedule(11, this);
        this.makeLaunchSchedule();
        this.resetTinKoopa();
    }
    makeLaunchSchedule() {
        const O = this.mLaunchSchedule.mOrders;
        let i = 0;
        O[i++].makeOrder(0, 600, -1, 0);
        O[i++].makeOrder(0, 1230, -1, 1);
        O[i++].makeOrder(0, 2450, -1, 1);
        O[i++].makeOrder(1, 240, -1, 0);
        O[i++].makeOrder(1, 280, -1, 1);
        O[i++].makeOrder(1, 630, -1, 0);
        O[i++].makeOrder(1, 900, -1, 0);
        O[i++].makeOrder(1, 1200, -1, 1);
        O[i++].makeOrder(2, 565, -1, 0);
        O[i++].makeOrder(2, 700, -1, 0);
        O[i++].makeOrder(2, 2220, -1, 1);
    }
    // ------------------------------------------------ the track (the killer graph)
    makeCoasterDistanceTable() {
        const g = this.unk1EC!;
        this.unk1E8 = [];
        let point = g.point(0);
        for (let i = 0; i < g.count - 1; ++i) {
            const prev = point;
            point = g.point(i + 1);
            // makeCoasterDistanceTable: prev.distance(point) -- TVec3<f32>::length of the delta.
            this.unk1E8[i] = vLen(V3.sub(prev, point));
        }
    }
    calcCoasterDistance(from: number, to: number) { let d = 0; for (let i = from; i < to; ++i) d = fr(d + this.unk1E8[i]); return d; }
    calcCoasterDistanceInOrder(from: number, to: number) {
        if (to >= from) return this.calcCoasterDistance(from, to);
        return fr(this.calcCoasterDistance(0, to) + this.calcCoasterDistance(from, this.unk1EC!.count - 1));
    }
    checkKillerApproachingFromBack(k: CoasterKiller, p: V3, dist: number) {
        if (k.checkLiveFlag(LF.DEAD)) return false;
        if (k.getPathDir() !== 0) return false;
        const i = this.unk1EC!.findNearestNodeIndex(p, -1);
        return this.calcCoasterDistanceInOrder(k.getPathIdx(), i) <= dist;
    }
    // ------------------------------------------------ resets
    reset() {
        super.reset();
        this.mFlame.resetTinKoopaFlame();
        for (const p of this.mParts) p.reset();
        this.makeHitCollision();
        this.resetTinKoopa();
        this.changeBck(waitAnimationIndex[this.mBreakCount]);
    }
    resetTinKoopa() {
        if (!this.unk1F0) this.unk1F0 = this.world.search('コースターキラーマネージャー') as CoasterKillerManager | null;
        [this.mTruckActor, this.ownRail] = koopaRail(this.world);
        this.mBreakCount = 0; this.unk154 = 0; this.unk158 = 0; this.mLap = 0;
        this.mFirstFlameMessageShown = false;
        this.mPartsHp = this.getSaveParam2().mSLPartsHP;
        this.unk1E4 = null;
        this.mQueuedKillerNum = 0; this.mQueuedKillersLaunchedNum = 0;
        this.mQueuedKillerDirs = [0, 0, 0, 0];
        this.mTimers = [0, 0, 0];
        this.unk1B4 = 0; this.unk1B8 = 30; this.unk1BC = 15; this.unk1C0 = 45;
    }
    makeHitCollision() {
        const P = this.getSaveParam2();
        if (this.mBreakCount === 0) this.setHitParams(0, 0, P.mSLDamageRadius, P.mSLDamageHeight0);
        else if (this.mBreakCount === 1) this.setHitParams(0, 0, P.mSLDamageRadius, P.mSLDamageHeight1);
        this.mFlame.makeHitCollision();
    }
    makeKillerQueue(num: number, dir: number) {
        if (num > 4) num = 4;
        this.mQueuedKillersLaunchedNum = 0;
        this.mQueuedKillerNum = num;
        for (let i = 0; i < num; ++i) this.mQueuedKillerDirs[i] = dir;
        this.mTimers[TIMER_KILLER_INTERVAL] = 0;
    }
    private truckCtrl(): FrameCtrl | null { return this.mTruckActor ? this.mTruckActor.getFrameCtrl(ANM_BCK) : null; }
    checkLap() {
        const c = this.truckCtrl();
        if (!c) return;
        if (c.checkPass(c.end - 1)) { ++this.mLap; if (this.mLap > 2) this.mLap = 0; }
    }
    checkTruckAnimationPass(frame: number) { const c = this.truckCtrl(); return !!c && c.checkPass(frame); }
    // ------------------------------------------------ the frame
    perform(cue: number) {
        if (cue & CUE_CALC_ANIM) { this.emitTinKoopaEffects(); this.checkKillerLaunch(); }
        if (cue & CUE_MOVE) {
            this.updateTimers();
            this.checkLap();
            this.mLaunchSchedule.checkOrder();
            // (checkTinKoopaMessage: the balloons)
            if (this.ownRail && this.mTruckActor) this.mTruckActor.frameUpdate();
        }
        super.perform(cue);
        this.mFlame.testPerform(cue);
        for (const p of this.mParts) p.testPerform(cue);
    }
    updateTimers() { for (let i = 0; i < 3; ++i) if (this.mTimers[i] > 0) --this.mTimers[i]; }
    changeBck(i: number) { if (this.mactor) this.mactor.setBckFromIndex(i); }
    receiveMessage(sender: HitActor, _msg: number) { if (sender.isActorType(AT.ROCKET)) { this.hitParts(); return true; } return false; }
    /** hitParts: a rocket hit him: shaken, or a part breaks off */
    hitParts() {
        const s = this.spine!;
        if (s.current === TinKoopaNerves.break_) return;
        if (s.current === TinKoopaNerves.damage) return;
        if (this.mBreakCount === 4) return;
        // (startTinKoopaMessage(0xE0024))
        --this.mPartsHp;
        if (this.mPartsHp <= 0) s.pushNerve(TinKoopaNerves.break_);
        else s.pushNerve(TinKoopaNerves.damage);
    }
    startBreakingParts() {
        this.unk1E4 = this.mParts[breakingPartsIndex[this.mBreakCount]];
        this.unk1E4.startBreaking();
    }
    launchKiller(dir: number) {
        const k = this.unk1F0 ? this.unk1F0.getDeadEnemy() : null;
        if (!k) return;
        k.reset();
        const joint = this.jointIndexTable[dir === 1 ? this.mQueuedKillersLaunchedNum + 11 : 14 - this.mQueuedKillersLaunchedNum];
        trans(this.joints && joint >= 0 ? this.joints[joint] : null, k.pos);
        k.mPathDir = dir;
        this.world.sound(SE.EN_KILLER_FIRE, k.pos);
    }
    checkKillerLaunch() {
        if (this.spine!.current !== TinKoopaNerves.wait) return;
        if (this.mQueuedKillersLaunchedNum < this.mQueuedKillerNum && this.mTimers[TIMER_KILLER_INTERVAL] <= 0) {
            this.launchKiller(this.mQueuedKillerDirs[this.mQueuedKillersLaunchedNum]);
            ++this.mQueuedKillersLaunchedNum;
            this.mTimers[TIMER_KILLER_INTERVAL] = this.getSaveParam2().mSLKillerInterval;
        }
    }
    /** emitTinKoopaEffects: the joints' places (for the particles, not here) and the falling part's explosions */
    emitTinKoopaEffects() {
        trans(this.jointMtx(0), this.unk184);
        trans(this.jointMtx(1), this.unk190);
        trans(this.jointMtx(3), this.unk19C);
        trans(this.jointMtx(4), this.unk1A8);
        if (this.unk1E4) this.unk1E4.emitPartsDisappearEffects();
    }
    // ------------------------------------------------ joints
    /** getModel()->getAnmMtx(TTinKoopa_getJointIndex(i)) */
    jointMtx(i: number): mat4 | null { const j = this.jointIndexTable[i]; return this.joints && j >= 0 && j < this.joints.length ? this.joints[j] : null; }
    calcRootMatrix() {
        super.calcRootMatrix();
        this.joints = this.mactor ? this.mactor.anmMtxAll(this.baseTR, this.scale) : null;
    }
}

// ---------------------------------------------------------------- nerves
type S = Spine<TinKoopa>;
export const TinKoopaNerves: Record<string, any> = {};
TinKoopaNerves.wait = nerve<TinKoopa>('TNerveTinKoopaWait', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.changeBck(waitAnimationIndex[self.mBreakCount]);
        self.mTimers[TIMER_DEFEAT_WAIT] = self.getSaveParam2().mSLDefeatWaitTime;
    }
    if (self.mBreakCount === 4 && self.mTimers[TIMER_DEFEAT_WAIT] <= 0) {
        // TFlagManager MSF_MECHA_BOWSER_DEFEATED (also told to the viewer, once)
        self.world.flags.setBool(true, MSF.MECHA_BOWSER_DEFEATED);
        if (!self.defeatFlagSet) { self.defeatFlagSet = true; self.world.events.push({ t: self.world.tickCount, kind: 'flag', data: { name: 'MSF_MECHA_BOWSER_DEFEATED' } }); }
    }
    return false;
});
TinKoopaNerves.damage = nerve<TinKoopa>('TNerveTinKoopaDamage', (spine: S) => {
    const self = spine.body, a = self.mactor;
    if (spine.time === 0) {
        self.changeBck(damageAnimationIndex[self.mBreakCount]);
        // (ms_mkp_hibana_d1he on the head joint, the camera shake)
    }
    if (a && a.checkCurBckFromIndex(damageAnimationIndex[self.mBreakCount]) && a.curAnmEndsNext(ANM_BCK)) {
        self.changeBck(waitAnimationIndex[self.mBreakCount]);
        return true;
    }
    return false;
});
TinKoopaNerves.break_ = nerve<TinKoopa>('TNerveTinKoopaBreak', (spine: S) => {
    const self = spine.body, a = self.mactor;
    if (spine.time === 0) {
        self.changeBck(breakAnimationIndex[self.mBreakCount]);
        // (ms_mkp_hibana_d1he on the head joint, the camera shake)
        if (self.mBreakCount === 3) {
            if (self.unk1F0) self.unk1F0.unk60 = 1;
            // (MSBgm::stopTrackBGMs(7, 10))
        }
    }
    if (a && a.checkCurBckFromIndex(breakAnimationIndex[self.mBreakCount])) {
        const parts = self.mParts[breakingPartsIndex[self.mBreakCount]];
        if (a.curAnmEndsNext(ANM_BCK)) {
            parts.removeCollision();
            ++self.mBreakCount;
            self.makeHitCollision();
            self.changeBck(waitAnimationIndex[self.mBreakCount]);
            self.mPartsHp = self.getSaveParam2().mSLPartsHP;
            return true;
        }
        if (!parts.mIsBreaking && a.getFrameCtrl(ANM_BCK)!.checkPass(partsVisibleFrame[self.mBreakCount])) self.startBreakingParts();
    }
    return false;
});

register('TinKoopaManager', (w, n) => new TinKoopaManager(w, n));
register('TinKoopa', (w, n) => new TinKoopa(w, n));
