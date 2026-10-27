// The bluebird (Animal/Bird.cpp: "(幸せの青い)鳥"): sits at its perch (waits, pecks, hops about),
// takes off when Mario comes near or it's sprayed, flies its graph for mReturnTimer ticks, comes
// back and lands. Spraying it in flight takes its hit points; at none it turns into its item
// (from its event ID: a blue coin, a coin, a red coin or a Shine; the body's colour says which).

import { fr, V3, MsRandF, MsWrap, MsAngleDiff } from '../math.js';
import { World, SpineEnemy, EnemyManager, LiveManager, PathNode, LF, HF, MSG, nerve, Spine, Stream, ANM_BCK, FC_ONCE_RESET, readParams, SPINE_PARAMS, PSchema, HitActor, TakeActor } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { RATE, AnimalBase, SMS_Eular2Quat, quatRotate, clamp, ItemRef, itemByEventID, appearItem } from './animal.js';
import { SE } from '../soundids.js';
import '../sound.js';

export const BIRD_PARAMS = {
    ...SPINE_PARAMS,
    mMarchSpeed: ['f', 5], mTurnSpeed: ['f', 0.1], mReturnTimer: ['i', 1800], mSearchLength: ['f', 800], mSearchHeight: ['f', 600],
    mSearchAware: ['f', 400], mSearchAngle: ['f', 90], mActionTimer: ['i', 100], mWaterproofTimerMax: ['i', 45], mFloatingTimerMax: ['i', 30],
    mLandingGravityY: ['f', 1], mLandingTorqueY: ['f', 2], mWalkingTorqueY: ['f', 0.5], mWalkingSpeed: ['f', 2], mWalkTimer: ['i', 100],
    mLandingFric: ['f', 0.95], mActionTimerAdd: ['i', 300], mWaterPowerY: ['f', 15],
} satisfies PSchema;
type BirdParams = { [K in keyof typeof BIRD_PARAMS]: number };

/** The model's BCKs (bird folder, archive order): beat, fly, open, ride, stab, start, stop, wait, walk. */
export const BIRD_ANM = { UNK0: 0, FLY: 1, OPEN: 2, UNK3: 3, UNK4: 4, START: 5, STOP: 6, UNK7: 7, UNK8: 8 };
/** cRandomAnims: the idle animations picked sitting on the ground (UNK8 starts a walk). */
const RANDOM_ANIMS = [BIRD_ANM.UNK7, BIRD_ANM.UNK4, BIRD_ANM.UNK0, BIRD_ANM.OPEN, BIRD_ANM.UNK8];
/** cColorTable: _mat_body1's TEVREG1 by item (blue coin, coin, Shine, red coin). */
export const BIRD_COLORS = [[0, 100, 255, 0], [0, 200, 0, 0], [255, 200, 0, 0], [255, 0, 0, 0]];

export class AnimalBirdManager extends EnemyManager {
    constructor(w: World, name = '(幸せの青い)鳥マネージャー') { super(w, name); }
    load(s: Stream) {
        this.saveParams = readParams('/Animal/bird.prm', this.world.files, BIRD_PARAMS);
        super.load(s);
    }
    createModelData() { this.createModelDataArray(['bird_man.bmd']); }
}

/**
 * gpMapWireManager as TWireBinder uses it (getWireNo: gpCubeWire->getInCubeNo; getPoint:
 * TMapWire::getPointPosOnWire at getPosInWire(p)). Not in the engine yet: world.mapWires, when
 * something provides it.
 */
export interface MapWires { getWireNo(p: V3): number; getPointOnWire(no: number, p: V3): V3; }
const mapWires = (w: World): MapWires | null => (w as any).mapWires || null;

/** TWireBinder (Enemy/wireBinder.cpp): the bird standing on its wire. */
export class WireBinder {
    constructor(public wires: MapWires, public no: number) { }
    static isOnWire(w: World, p: V3) { const m = mapWires(w); return !!m && m.getWireNo(p) !== -1; }
    getPoint(p: V3) { return this.wires.getPointOnWire(this.no, p); }
    bind(a: SpineEnemy) {
        const next = a.pos.clone().add(a.posDelta).add(a.vel);
        let q = this.getPoint(next);
        if (isNaN(q.x) || isNaN(q.y) || isNaN(q.z)) q = a.pos.clone();
        if (next.y <= 0.05 + q.y) a.offLiveFlag(LF.AIRBORNE); else a.onLiveFlag(LF.AIRBORNE);
        a.posDelta.set(V3.sub(q, a.pos));
    }
}

export class AnimalBird extends SpineEnemy {
    item: ItemRef | null = null;
    wireBinder: WireBinder | null = null;
    homePos = new V3(); homeRot = new V3();
    walkDir = 1; birdScale = 1;
    waterproofTimer = 0; floatingTimer = 0;
    colorIndex = 1;
    constructor(w: World, name = '(幸せの青い)鳥') { super(w, name); }
    get P(): BirdParams { return this.getSaveParam(); }
    init(m: LiveManager | null) {
        this.manager = m;
        if (m) m.manageActor(this); else this.world.conductor.aloneActors.push(this);
        this.mactor = this.createMActorByName('bird_man.bmd');
        this.spine!.initWith(BirdNerves.waitOnGround);
        this.initParams();
        this.initCollision();
    }
    initCollision() {
        this.initHitActor(AT.ANIMAL_BIRD, 0, 0, 50, 50, 70, 80);
        this.onHitFilter(HF.NO_ATTACK);
        this.offHitFilter(HF.NO_COLLISION);
        this.scaledBodyRadius = 35;
    }
    initParams() {
        this.homePos.set(this.pos); this.homePos.y += 90;
        this.homeRot.set(this.rot);
        this.resetHitPoints();
        this.waterproofTimer = 0; this.floatingTimer = 0; this.walkDir = 1;
        this.offLiveFlag(LF.AIRBORNE);
        this.birdScale = fr(1 - fr(0.1) * (MsRandF() - 0.5));   // (fnmsubs with the f32 0.1)
        if (WireBinder.isOnWire(this.world, this.pos)) { const m = mapWires(this.world)!; this.wireBinder = new WireBinder(m, m.getWireNo(this.pos)); }
    }
    load(s: Stream) {
        super.load(s);
        const id = s.s32();
        this.item = itemByEventID(this.world, id >= 0 ? id : 100, id >= 0 ? '鳥用' : '');
        const t = this.item ? this.item.type : AT.COIN;
        if (t === AT.SHINE) this.colorIndex = 2;
        else if (t === AT.COIN_RED) this.colorIndex = 3;
        else if (t === AT.COIN_BLUE) { this.colorIndex = 0; this.checkNotAppear(id); }
        else this.colorIndex = 1;
    }
    /** checkNotAppear: its blue coin taken already (TFlagManager): none taken here. */
    checkNotAppear(_id: number) { }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (this.checkLiveFlag(LF.DEAD)) return false;
        if (msg === MSG.SPRAYED_BY_WATER) { this.world.effect('ms_enm_wathit', sender.pos); this.world.sound(SE.EN_COMMON_W_HIT_OK, this.pos); this.behaveHitWater(); return true; }
        if (msg === MSG.TAKE && !this.holder) { this.onHitFilter(HF.NO_COLLISION); this.holder = sender as TakeActor; this.world.effect('ms_enm_wathit', sender.pos); return true; }
        if ((msg === MSG.PUT || msg === MSG.THROWN) && this.holder === sender) { this.holder = null; this.offHitFilter(HF.NO_COLLISION); return true; }
        if (msg === MSG.UNKB) {
            this.holder = null;
            if (this.isChangeToItem()) { this.spine!.reset(); this.spine!.setNext(BirdNerves.changeToCoin); } else this.kill();
            return true;
        }
        if (msg === MSG.TRAMPLE && sender.isActorType(AT.POPO)) {
            if (this.isChangeToItem()) { this.spine!.reset(); this.spine!.setNext(BirdNerves.changeToCoin); }
            else this.receiveMessage(this, MSG.SPRAYED_BY_WATER);
            return true;
        }
        return super.receiveMessage(sender, msg);
    }
    calcRootMatrix() {
        const hm = this.holder ? this.holder.getTakingMtx() : null;
        if (hm) this.baseTR.set(hm); else super.calcRootMatrix();
        this.baseTR[7] += 35;
    }
    moveObject() {
        if (this.isWaterproof()) this.waterproofTimer--;
        this.checkFalling();
        this.checkChangeToItem();
        super.moveObject();
    }
    bind() { if (this.isCheckWithWireBinder()) this.wireBinder!.bind(this); else super.bind(); }
    isWaterproof() { return this.waterproofTimer > 0; }
    behaveHitWater() {
        if (this.isWaterproof()) return;
        this.waterproofTimer = this.P.mWaterproofTimerMax;
        if (this.checkLiveFlag(LF.AIRBORNE)) this.decHitPoints();
    }
    isOnGroundNerve() { const n = this.spine!.getLatestNerve(); return n === BirdNerves.waitOnGround || n === BirdNerves.actionOnGround || n === BirdNerves.walkOnGround; }
    /** Sitting while airborne too long: what it stood on is gone, so it takes off. */
    checkFalling() {
        if (!this.isOnGroundNerve()) return;
        if (this.checkLiveFlag(LF.AIRBORNE)) {
            if (this.P.mFloatingTimerMax < ++this.floatingTimer) { this.spine!.reset(); this.spine!.setNext(BirdNerves.takeoff); }
        } else this.floatingTimer = 0;
    }
    checkChangeToItem() { if (this.isChangeToItem() && this.hitPoints === 0) { this.spine!.reset(); this.spine!.setNext(BirdNerves.changeToCoin); } }
    isWantToFly() { return (this.isWaterproof() || this.isFindMario()) && MsRandF() < 0.5; }
    isWantToAction() {
        const t = this.spine!.getTime() - this.P.mActionTimer;
        if (t < 0) return false;
        return MsRandF() < fr(t / this.P.mActionTimerAdd);
    }
    isWantToRest() { return this.P.mWalkTimer < this.spine!.getTime(); }
    isFindMario() {
        const m = this.world.mario.pos, P = this.P;
        if (P.mSearchHeight < Math.abs(m.y - this.pos.y)) return false;
        return this.isInSight(m, this.birdScale * P.mSearchLength, this.birdScale * P.mSearchAngle, this.birdScale * P.mSearchAware);
    }
    isChangeToItem() { return !this.isChanged(); }
    isGroundShaken() { return false; }
    isCheckWithWireBinder() { return !!this.wireBinder && (this.isOnGroundNerve() || this.spine!.getLatestNerve() === BirdNerves.preLanding); }
    isChanged() { return this.spine!.getLatestNerve() === BirdNerves.changeToCoin; }
    isFlying() { const n = this.spine!.getLatestNerve(); return n === BirdNerves.graphWander || n === BirdNerves.comeback; }
    doDropCoin() {
        const it = this.item;
        if (!it) return;
        if (it.type === AT.SHINE) { appearItem(this.world, it, this.pos, new V3()); this.world.effect('demo:鳥シャインカメラ', this.pos); return; }
        appearItem(this.world, it, this.pos, new V3(0, -10, 0));
    }
    getMyMarchSpeed() { return fr(this.birdScale * this.P.mMarchSpeed); }
    getWaterDamageRate() { return fr(this.waterproofTimer / this.P.mWaterproofTimerMax); }
    getWaterPowerY() { return fr(this.P.mWaterPowerY * this.getWaterDamageRate()); }
    getFootGroundHeight() {
        if (this.wireBinder) return this.wireBinder.getPoint(this.homePos).y;
        const [h, d] = this.world.checkGround(this.pos.x, this.pos.y, this.pos.z); this.groundPlane = d; return h;
    }
    doFlyToCurPathNode() {
        const diff = V3.sub(this.goal.point(), this.pos);
        const dist = diff.length();
        if (dist < 100) return;
        const march = fr(this.getMyMarchSpeed() * RATE);
        let turn = fr(this.P.mTurnSpeed * RATE);
        if (dist <= 2 * this.calcMinimumTurnRadius(march, turn)) turn = this.calcTurnSpeedToReach(march, 0.5 * dist);
        AnimalBase.getRotationFlyToDir(this.rot, diff, march, turn);
        const v = quatRotate(SMS_Eular2Quat(this.rot), new V3(0, 0, march));
        // getting sprayed slows it down and pushes it toward the ground
        v.scale(1 - this.getWaterDamageRate());
        v.y -= this.getWaterPowerY();
        this.posDelta.set(v).fround();
    }
    doWalk() {
        this.gravity = 0.15;
        this.rot.y = MsWrap(fr(this.walkDir * (this.P.mWalkingTorqueY * RATE) + this.rot.y), 0, 360);
        this.posDelta.set(quatRotate(SMS_Eular2Quat(this.rot), new V3(0, 0, this.P.mWalkingSpeed))).fround();
    }
    /** Glide down to the perch, turning back to the scene's facing; true once there and facing it. */
    doLanding(init: boolean) {
        if (init) {
            const sp = fr(this.getMyMarchSpeed() * RATE);
            const d = quatRotate(SMS_Eular2Quat(this.rot), new V3(0, 0, sp));
            this.vel.set(d.x, 0, d.z);
        }
        let landed = false;
        const delta = new V3();
        this.getFootGroundHeight();
        if (this.checkLiveFlag(LF.AIRBORNE)) delta.y = -this.P.mLandingGravityY; else landed = true;
        this.rot.x = this.homeRot.x; this.rot.z = this.homeRot.z;
        const torque = fr(this.P.mLandingTorqueY * RATE);
        const turn = clamp(MsAngleDiff(this.homeRot.y, this.rot.y), -torque, torque);
        this.rot.y = MsWrap(fr(this.rot.y + turn), 0, 360);
        this.posDelta.set(delta);
        const v = new V3(0, 0, this.vel.length()).scale(this.P.mLandingFric);
        this.vel.set(quatRotate(SMS_Eular2Quat(this.rot), v)).fround();
        return landed && Math.abs(turn) < 0.01;
    }
    doGotoRandomNextGraphNode() {
        this.goToRandomNextGraphNode();
        const g = this.goal104.point().clone();
        g.x = fr(g.x + 200 * (MsRandF() - 0.5));
        g.y = fr(g.y + 200 * (MsRandF() - 0.5));
        g.z = fr(g.z + 200 * (MsRandF() - 0.5));
        this.setGoalPath(new PathNode(null, g));
    }
    setGoalToComeback() { this.setGoalPath(new PathNode(null, this.homePos.clone())); }
    setParamsOnFloating() { this.onLiveFlag(LF.AIRBORNE); this.gravity = 0; this.floatingTimer = 0; }
    setBckAnm(i: number) { this.mactor!.setBckFromIndex(i); }
}

type S = Spine<AnimalBird>;
export const BirdNerves: Record<string, any> = {};
BirdNerves.waitOnGround = nerve<AnimalBird>('TNerveAnimalBirdWaitOnGround', (spine: S) => {
    const b = spine.body;
    if (spine.getTime() === 0) b.setBckAnm(BIRD_ANM.UNK7);
    if (b.isWantToFly()) { spine.pushAfterCurrent(BirdNerves.takeoff); return true; }
    if (b.checkCurAnmEnd(0) && b.isWantToAction()) { spine.pushAfterCurrent(BirdNerves.actionOnGround); return true; }
    return false;
});
BirdNerves.actionOnGround = nerve<AnimalBird>('TNerveAnimalBirdActionOnGround', (spine: S) => {
    const b = spine.body;
    if (spine.getTime() === 0) {
        const anm = RANDOM_ANIMS[Math.trunc(5 * MsRandF())];
        if (anm === BIRD_ANM.UNK8) { spine.pushAfterCurrent(BirdNerves.walkOnGround); return true; }
        if (!b.mactor!.checkCurBckFromIndex(anm)) b.mactor!.setBckFromIndex(anm);
    }
    if (b.isWantToFly()) { spine.pushAfterCurrent(BirdNerves.takeoff); return true; }
    if (b.checkCurAnmEnd(0)) { spine.pushAfterCurrent(BirdNerves.waitOnGround); return true; }
    return false;
});
BirdNerves.walkOnGround = nerve<AnimalBird>('TNerveAnimalBirdWalkOnGround', (spine: S) => {
    const b = spine.body;
    if (spine.getTime() === 0) { b.walkDir *= -1; b.setBckAnm(BIRD_ANM.UNK8); }
    if (b.isWantToFly()) { spine.pushAfterCurrent(BirdNerves.takeoff); return true; }
    b.doWalk();
    if (b.P.mWalkTimer < spine.getTime()) { spine.pushAfterCurrent(BirdNerves.waitOnGround); return true; }
    return false;
});
BirdNerves.takeoff = nerve<AnimalBird>('TNerveAnimalBirdTakeoff', (spine: S) => {
    const b = spine.body;
    if (spine.getTime() === 0) {
        b.setBckAnm(BIRD_ANM.START);
        b.setParamsOnFloating();
        b.world.sound(SE.OBJ_BIRD_DOL_TO_FLY1, b.pos);   // (behind gpMSound->gateCheck)
        const c = b.mactor!.getFrameCtrl(ANM_BCK);
        if (c) c.rate = fr(3 * c.rate);
    }
    if (b.checkCurAnmEnd(0)) { spine.pushAfterCurrent(BirdNerves.graphWander); b.setParamsOnFloating(); return true; }
    return false;
});
BirdNerves.graphWander = nerve<AnimalBird>('TNerveAnimalBirdGraphWander', (spine: S) => {
    const b = spine.body;
    if (spine.getTime() === 0) { b.vel.zero(); b.tracer.reset(); b.goToShortestNextGraphNode(); }
    if (spine.getTime() === 0 || b.isReachedToGoal()) {
        b.doGotoRandomNextGraphNode();
        // climb while the next goal is above, glide otherwise
        b.setBckAnm(b.pos.y <= b.goal.point().y ? BIRD_ANM.FLY : BIRD_ANM.UNK3);
    }
    b.checkCurAnmEnd(0);
    if (b.P.mReturnTimer < spine.getTime()) { spine.pushAfterCurrent(BirdNerves.comeback); return true; }
    b.doFlyToCurPathNode();
    return false;
});
BirdNerves.changeToCoin = nerve<AnimalBird>('TNerveAnimalBirdChangeToCoin', (spine: S) => {
    const b = spine.body;
    if (spine.getTime() === 0) { b.onLiveFlag(LF.DEAD); b.doDropCoin(); }
    return true;
});
BirdNerves.comeback = nerve<AnimalBird>('TNerveAnimalBirdComeback', (spine: S) => {
    const b = spine.body;
    if (spine.getTime() === 0) { b.setGoalToComeback(); b.setBckAnm(BIRD_ANM.UNK3); }
    b.doFlyToCurPathNode();
    if (b.isFindMario()) { spine.pushAfterCurrent(BirdNerves.graphWander); return true; }
    if (b.isReachedToGoal()) { spine.pushAfterCurrent(BirdNerves.preLanding); return true; }
    return false;
});
BirdNerves.preLanding = nerve<AnimalBird>('TNerveAnimalBirdPreLanding', (spine: S) => {
    const b = spine.body;
    if (spine.getTime() === 0) {
        b.setBckAnm(BIRD_ANM.FLY);
        const c = b.mactor!.getFrameCtrl(ANM_BCK);
        if (c) c.rate = fr(1.5 * c.rate);
        b.doLanding(true);
    }
    if (b.isFindMario()) { spine.pushAfterCurrent(BirdNerves.graphWander); return true; }
    if (b.doLanding(false)) { spine.pushAfterCurrent(BirdNerves.landing); return true; }
    return false;
});
BirdNerves.landing = nerve<AnimalBird>('TNerveAnimalBirdLanding', (spine: S) => {
    const b = spine.body;
    const c = b.mactor!.getFrameCtrl(ANM_BCK)!;
    if (spine.getTime() === 0) {
        b.vel.zero();
        b.setBckAnm(BIRD_ANM.START);
        c.attr = FC_ONCE_RESET;
        c.frame = c.end;
        c.rate = -1 * c.rate;
    }
    if (b.isFindMario()) { spine.pushAfterCurrent(BirdNerves.graphWander); return true; }
    if (c.state & 1) { spine.pushAfterCurrent(BirdNerves.waitOnGround); return true; }
    return false;
});

register('AnimalBirdManager', (w, n) => new AnimalBirdManager(w, n));
register('AnimalBird', (w, n) => new AnimalBird(w, n));
