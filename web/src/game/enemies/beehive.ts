// The hanging beehive and its bees (Animal/BeeHive.cpp: ハチの巣とハチ). Spraying it swings it
// (a damped pendulum, swinging further each time it's pushed past its limit); swung far enough,
// or trampled / hip-dropped / punched, it falls, drops its item and breaks, and the whole swarm
// chases Mario (one bee a tick can hurt him) until he gets mGiveupRange away or stays in water
// mGiveupTimer ticks; then the hive grows back. While it hangs, three bees buzz around it,
// going after Mario when he's within mSearchRange. Each bee Yoshi eats drops a coin.

import { fr, V3, Quat, MsCos, MsMtxSetRotRPH, mtx } from '../math.js';
import { World, LiveManager, EnemyManager, PathNode, LF, HF, HC, MSG, nerve, Spine, Stream, MActor, readParams, SPINE_PARAMS, PSchema, HitActor, TakeActor, SpineEnemy } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { quatEulerX, quatEulerY, mtxGetQuat, mtxSetSQT, jnormalize, clamp, ItemRef, itemByEventID, itemByName, appearItem } from './animal.js';
import { Realoid, RealoidActor, RF_UNK2, RF_UNK4, RF_UNK2_OR_UNK4 } from './boid.js';

export const BEEHIVE_PARAMS = {
    ...SPINE_PARAMS,
    mGiveupTimer: ['i', 600], mGiveupRange: ['f', 1750], mDecrimentTimer: ['i', 60], mRebound: ['f', 0.007], mDecay: ['f', 0.98],
    mAngleMaxAdd: ['f', 0.08], mShakePower: ['f', 0.003], mFallAngularVel: ['f', 0.01], mSearchRange: ['f', 800],
} satisfies PSchema;
type BeeHiveParams = { [K in keyof typeof BEEHIVE_PARAMS]: number };

/** cAngleLimit: it falls once it swings further than this. */
const ANGLE_LIMIT = fr(Math.PI * 0.375);
const HALF_PI = fr(Math.PI / 2);

/** SMS_IsMarioInWater (MARIO_FLAG_VISIBLE 0x2, IN_SHALLOW_WATER, a water surface under him, IN_WATER) */
function isMarioInWater(w: World) {
    const m = w.mario;
    return m.checkFlag(0x2) || m.checkFlag(0x10000) || m.groundPlane.isWaterSurface() || m.checkFlag(0x20000);
}

export class Bee extends RealoidActor {
    constructor(w: World, m: MActor | null, public hive: BeeHive) { super(w, m); }
    initRealoid() {
        this.initHitActor(AT.BEE, 1, HC.PLAYER, 20, 20, 50, 50);
        this.world.addToGroup('敵グループ', this);
        this.onHitFilter(HF.NO_COLLISION);
    }
    receiveMessage(sender: HitActor, msg: number) {
        switch (msg) {
            case MSG.TAKE: if (!this.holder) { this.holder = sender as TakeActor; this.world.effect('ms_enm_wathit', this.pos); return true; } break;
            case MSG.DETACH: if (this.holder) { this.holder = null; return true; } break;
            case MSG.UNKB: this.hive.receiveMessageFromChild(this); return true;
        }
        return false;
    }
}

export class BeeHiveManager extends EnemyManager {
    constructor(w: World, name = 'ハチの巣マネージャー') { super(w, name); }
    load(s: Stream) {
        this.saveParams = readParams('/Animal/beehive.prm', this.world.files, BEEHIVE_PARAMS);
        super.load(s);
    }
    createModelData() { this.createModelDataArray(['bee_body.bmd', 'bee_nest.bmd', 'bee_nest_break.bmd']); }
}

export class BeeHive extends Realoid {
    swingDirGoal = new Quat(); swingDir = new Quat(); baseRot = new Quat();
    swingAngle = 0; swingSpeed = 0; swingLimit = 0;
    initPos = new V3(); soundPos = new V3();
    item: ItemRef | null = null;
    collisionBee = 0; activeBeeNum = 0;
    coins: (ItemRef | null)[] = [];
    eatenBeeNum = 0;
    nest: MActor | null = null; nestBreak: MActor | null = null;
    constructor(w: World, name = 'ハチの巣とハチ') { super(w, name); }
    get P(): BeeHiveParams { return this.getSaveParam(); }
    init(m: LiveManager | null) {
        this.manager = m;
        if (m) m.manageActor(this);
        this.onLiveFlag(LF.UNK8 | LF.UNK10);
        this.spine!.initWith(BeeHiveNerves.wait);
        this.initPos.set(this.pos);
        this.activeBeeNum = 0; this.eatenBeeNum = 0;
        this.initCollision();
    }
    initCollision() {
        this.initHitActor(AT.BEE_HIVE, 0, HC.PLAYER, 50, 50, 100, 100);
        this.onHitFilter(HF.NO_ATTACK);
    }
    reset() {
        this.pos.set(this.initPos);
        const m = mtx();
        MsMtxSetRotRPH(m, this.rot.x, 0, this.rot.z);
        mtxGetQuat(m, this.baseRot);
        // (the game hands setEulerY the rotation in degrees, as radians)
        this.swingDir = quatEulerY(this.rot.y);
        this.swingDirGoal = this.swingDir.clone();
        this.swingAngle = 0; this.swingSpeed = 0; this.swingLimit = 0.015707964;
        this.collisionBee = 0;
        this.onLiveFlag(LF.UNK10 | LF.AIRBORNE);
        this.mactor = this.nest;
        this.offHitFilter(HF.NO_COLLISION);
    }
    initBoids() { for (let i = 0; i < this.leader.num; i++) { const b = this.getRealoid(i); b.initRealoid(); b.onFlag(RF_UNK2); } }
    setBoidBaseParams() {
        const L = this.leader;
        L.baseSpeed = 25; L.neighborRadius = 80; L.yawSpeed = 8; L.pitchSpeed = 8; L.maxPitch = 85; L.alignmentStrength = 0.001;
    }
    setBoidParamOnAttacking() { this.setBoidBaseParams(); this.leader.goal = new PathNode(this.world.mario); this.leader.goalOffset.set(0, 200, 0); }
    setBoidParamOnWaiting() { this.setBoidBaseParams(); this.leader.goal = new PathNode(null, this.pos.clone()); this.leader.goalOffset.set(0, 0, 0); }
    setBoidParamOnMarioWaterIn() { this.setBoidBaseParams(); this.leader.goal = new PathNode(this.world.mario); this.leader.goalOffset.set(0, 500, 0); }
    receiveMessageFromChild(b: Bee) {
        if (b.checkFlag(RF_UNK4)) return;
        b.onFlag(RF_UNK4);
        b.onHitFilter(HF.NO_COLLISION);
        let c = this.coins[this.eatenBeeNum];
        if (this.eatenBeeNum !== this.leader.num - 1) c = itemByName('coin');
        if (c) appearItem(this.world, c, b.pos, new V3(0, 15, 0));
        ++this.eatenBeeNum;
    }
    load(s: Stream) {
        this.loadDefault(s, 'bee_body.bmd', 2);
        this.loadCoin(s);
        this.nestBreak = this.createMActorByName('bee_nest_break.bmd');
        this.nest = this.mactor = this.createMActorByName('bee_nest.bmd');
        this.initBoids();
        this.reset();
    }
    loadCoin(s: Stream) {
        const itemId = s.u32(), lastId = s.u32();
        this.item = itemByEventID(this.world, itemId, '');
        const n = this.leader.num;
        this.coins = [];
        for (let i = 0; i < n - 1; i++) this.coins.push(itemByName('coin'));
        this.coins.push(itemByEventID(this.world, lastId, '') || itemByName('coin'));
    }
    createRealoidActor(m: MActor | null) { return new Bee(this.world, m, this); }
    receiveMessage(sender: HitActor, msg: number) {
        switch (msg) {
            case MSG.SPRAYED_BY_WATER: {
                this.setShakePower(V3.sub(this.pos, this.world.mario.pos));
                this.world.effect('ms_enm_wathit', sender.pos);
                return true;
            }
            case MSG.TRAMPLE: case MSG.HIP_DROP: case MSG.PUNCH:
                if (this.isWaiting()) { this.spine!.reset(); this.spine!.setNext(BeeHiveNerves.fall); }
                return true;
        }
        return false;
    }
    perform(cue: number) {
        super.perform(cue);
        SpineEnemy.prototype.perform.call(this, cue);
    }
    control() {
        this.controlCollision();
        if (this.spine) this.spine.update();
        // (controlSound: the swarm's buzz at its centre)
    }
    bind() {
        if (this.checkLiveFlag(LF.UNK10)) return;
        const next = this.pos.clone().add(this.posDelta).add(this.vel);
        this.vel.y -= this.getGravityY();
        if (this.vel.y < -40) this.vel.y = -40;
        // the hive hangs from its top, so its bottom rises as it tilts
        const lift = fr(-60 * (-1 + MsCos(57.295776 * this.swingAngle)));
        const [h, d] = this.world.checkGround(next.x, lift + (next.y + this.headHeight), next.z);
        this.groundPlane = d; this.groundHeight = fr(h + 1);
        if (next.y + lift <= 0.05 + this.groundHeight) {
            if (d.isIllegal()) this.kill();
            this.offLiveFlag(LF.AIRBORNE);
            this.vel.zero();
            next.y = this.groundHeight - lift;
        } else this.onLiveFlag(LF.AIRBORNE);
        this.world.isTouchedOneWallAndMoveXZ(next, next.y + this.headHeight, this.bodyRadius);
        this.posDelta.set(V3.sub(next, this.pos));
    }
    /** Only one bee a tick takes part in collision. */
    controlCollision() {
        const num = this.activeBeeNum, idx = this.collisionBee;
        const bee = this.getRealoid(idx);
        bee.checkHitActors();
        bee.onHitFilter(HF.NO_ATTACK);
        this.collisionBee = num <= idx + 1 ? 0 : idx + 1;
        let next = this.collisionBee;
        if (num <= next) next = 0;
        const nb = this.getRealoid(next);
        if (!nb.checkFlag(RF_UNK2_OR_UNK4)) nb.offHitFilter(HF.NO_ATTACK);
    }
    calcRootMatrix() {
        const rot = this.baseRot.clone();
        const swing = quatEulerX(this.swingAngle);
        rot.mul(rot.clone(), this.swingDir);
        rot.mul(rot.clone(), swing);
        // (setSQ with mScaling: the viewer scales the model by it itself)
        mtxSetSQT(this.baseTR, new V3(1, 1, 1), rot, this.pos);
        this.baseTR[7] += 120;
    }
    prepareWait() {
        this.onLiveFlag(LF.UNK10 | LF.AIRBORNE);
        if (this.activeBeeNum < 3) { for (let i = 0; i < 3; i++) this.appearBee(i); this.activeBeeNum = 3; }
    }
    /** Swing like a pendulum; true once it swings so far it falls. */
    doWait() {
        const P = this.P;
        this.swingSpeed = fr(this.swingSpeed + this.swingAngle * -P.mRebound);
        this.swingSpeed = fr(this.swingSpeed * P.mDecay);
        this.swingAngle = fr(this.swingAngle + this.swingSpeed);
        if (this.swingAngle < -this.swingLimit || this.swingLimit < this.swingAngle) {
            this.swingLimit = clamp(fr(this.swingLimit + P.mAngleMaxAdd), 0, HALF_PI);
            this.swingAngle = clamp(this.swingAngle, -this.swingLimit, this.swingLimit);
            this.swingSpeed = 0;
            // (MSD_SE_EN_BEENEST_SWING; also each time it turns back)
        }
        this.swingDir = this.swingDir.clone().slerp(this.swingDir, this.swingDirGoal, 0.01).normalize();
        const r = P.mSearchRange;
        if (V3.sub(this.world.mario.pos, this.pos).squared() <= r * r) this.setBoidParamOnAttacking();
        else this.setBoidParamOnWaiting();
        return ANGLE_LIMIT <= Math.abs(this.swingAngle);
    }
    prepareFall() {
        this.offLiveFlag(LF.UNK10);
        this.onLiveFlag(LF.AIRBORNE);
        const d = this.swingDir.getZDir();
        this.swingSpeed = this.P.mFallAngularVel;
        this.vel.set(d).fround();
    }
    doFall() { this.swingAngle = fr(this.swingAngle + this.swingSpeed); return !this.checkLiveFlag(LF.AIRBORNE); }
    appearBee(i: number) {
        const b = this.getRealoid(i);
        if (b.checkFlag(RF_UNK4) || !b.checkFlag(RF_UNK2)) return;
        b.offFlag(RF_UNK2);
        b.offHitFilter(HF.NO_COLLISION);
        this.leader.boids[i].pos.set(this.pos);
    }
    disappearBee(i: number) {
        const b = this.getRealoid(i);
        if (b.checkFlag(RF_UNK2)) return;
        b.onFlag(RF_UNK2);
        b.onHitFilter(HF.NO_COLLISION);
    }
    decrimentBee() { if (this.activeBeeNum > 3) { --this.activeBeeNum; this.disappearBee(this.activeBeeNum); } }
    appearAllBees() { for (let i = 0; i < this.leader.num; i++) this.appearBee(i); this.activeBeeNum = this.leader.num; }
    dropCoin() {
        if (!this.item) return;
        appearItem(this.world, this.item, this.pos, new V3());
        this.item = null;
    }
    prepareBreak() {
        this.mactor = this.nestBreak;
        if (this.mactor) this.mactor.setBck('bee_nest_break');
        this.onHitFilter(HF.NO_COLLISION);
        this.world.effect('ms_enm_disap_a', this.pos, new V3(2, 2, 2));
        this.world.effect('ms_enm_disap_b', this.pos, new V3(2, 2, 2));
    }
    prepareVanish() { this.onLiveFlag(LF.HIDDEN); }
    prepareReset() { this.reset(); this.offLiveFlag(LF.HIDDEN); this.scale.set(0, 0, 0); }
    /** Grow back in; true once full size. */
    doScaling() {
        this.scale.x = fr(this.scale.x + 0.01);
        if (1 <= this.scale.x) { this.scale.set(1, 1, 1); return true; }
        this.scale.y = fr(this.scale.y + 0.01); this.scale.z = fr(this.scale.z + 0.01);
        return false;
    }
    /** The swarm gives up once Mario is far enough from it. */
    isMissMario() {
        if (this.activeBeeNum === 0) return false;
        const r = this.P.mGiveupRange;
        return r * r <= V3.sub(this.world.mario.pos, this.getCenterOfGravity()).squared();
    }
    setShakePower(dir: V3) {
        if (this.isFalling()) return;
        const flat = dir.clone(); flat.y = 0; jnormalize(flat);
        const s = this.swingSpeed;
        const sign = Math.abs(s) < 0.0001 ? 1 : s > 0 ? 1 : s < 0 ? -1 : 0;
        this.swingDirGoal.setRotateFromTo(new V3(0, 0, 1), flat, 1);
        this.swingSpeed = fr(this.swingSpeed + sign * this.P.mShakePower);
    }
    getCenterOfGravity() {
        if (this.activeBeeNum === 0) return new V3();
        const s = new V3();
        for (let i = 0; i < this.activeBeeNum; i++) s.add(this.leader.boids[i].pos);
        return s.scale(1 / this.activeBeeNum);
    }
    isFalling() { return this.spine!.getLatestNerve() === BeeHiveNerves.fall; }
    isWaiting() { return this.spine!.getLatestNerve() === BeeHiveNerves.wait; }
    isNotBreakOnceYet() { return false; }
}

type S = Spine<BeeHive>;
export const BeeHiveNerves: Record<string, any> = {};
BeeHiveNerves.wait = nerve<BeeHive>('TNerveBeeHiveWait', (spine: S) => {
    const h = spine.body;
    if (spine.getTime() === 0) { h.prepareWait(); h.setBoidParamOnWaiting(); }
    if (h.doWait()) { spine.pushAfterCurrent(BeeHiveNerves.fall); return true; }
    // one bee goes home every now and then
    if (h.P.mDecrimentTimer < spine.getTime()) { h.decrimentBee(); spine.pushAfterCurrent(BeeHiveNerves.wait); return true; }
    return false;
});
BeeHiveNerves.fall = nerve<BeeHive>('TNerveBeeHiveFall', (spine: S) => {
    const h = spine.body;
    if (spine.getTime() === 0) { h.prepareFall(); h.dropCoin(); }
    if (h.doFall()) { spine.pushAfterCurrent(BeeHiveNerves.break); return true; }
    return false;
});
BeeHiveNerves.break = nerve<BeeHive>('TNerveBeeHiveBreak', (spine: S) => {
    const h = spine.body;
    if (spine.getTime() === 0) { h.prepareBreak(); h.appearAllBees(); h.setBoidParamOnAttacking(); }
    if (h.checkCurAnmEnd(0)) { spine.pushAfterCurrent(BeeHiveNerves.attack); h.prepareVanish(); return true; }
    return false;
});
BeeHiveNerves.attack = nerve<BeeHive>('TNerveBeeHiveAttack', (spine: S) => {
    const h = spine.body;
    if (spine.getTime() === 0) h.setBoidParamOnAttacking();
    if (isMarioInWater(h.world)) { spine.pushAfterCurrent(BeeHiveNerves.marioWaterIn); return true; }
    if (h.isMissMario()) { spine.pushAfterCurrent(BeeHiveNerves.reset); return true; }
    return false;
});
BeeHiveNerves.marioWaterIn = nerve<BeeHive>('TNerveBeeHiveMarioWaterIn', (spine: S) => {
    const h = spine.body;
    if (spine.getTime() === 0) h.setBoidParamOnMarioWaterIn();
    if (h.P.mGiveupTimer < spine.getTime()) { spine.pushAfterCurrent(BeeHiveNerves.reset); return true; }
    if (!isMarioInWater(h.world)) { spine.pushAfterCurrent(BeeHiveNerves.attack); return true; }
    return false;
});
BeeHiveNerves.reset = nerve<BeeHive>('TNerveBeeHiveReset', (spine: S) => {
    const h = spine.body;
    if (spine.getTime() === 0) h.prepareReset();
    if (h.doScaling()) { spine.pushAfterCurrent(BeeHiveNerves.wait); return true; }
    return false;
});

register('BeeHiveManager', (w, n) => new BeeHiveManager(w, n));
register('BeeHive', (w, n) => new BeeHive(w, n));
