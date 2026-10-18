// Kukku (Enemy/Kukku.cpp, クック): the birds that fly around their graph and, while Mario is
// within their search range, drop goop on him (TKukkuBall: it falls with air drag and pollutes
// where it lands). FLUDD's water knocks one out of the sky: it drops coins (and a 1-up once ten
// have dropped) and tumbles; if it hits the ground it dies, otherwise it flaps back up and
// returns to its graph. A stomp kills it.

import { fr, V3, Quat, MsRandF, MsSin, MsCos, MsWrap, MsClamp, MsAngleDiff, MsGetRotFromZaxis } from '../math.js';
import { World, LF, HF, MSG, nerve, Spine, Stream, ANM_BCK, ANM_FRAME_RATE, HitActor, LiveActor, PSchema, CUE_MOVE, CUE_CALC_ANIM } from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemy, SmallEnemyManager, SmallEnemyNerves, smallParams } from './smallEnemy.js';
import { register } from '../scene.js';
import { qRotate, qEulerX, qEulerY, eulerToQuat, chase, setLength, tolerantStream } from './jgeom.js';

/** TKukkuParams */
const KUKKU_PARAMS = {
    mMarchSpeed: ['f', 3], mTurnSpeed: ['f', 0.2], mWaterPowerY: ['f', 12], mShootSpeed: ['f', 1], mShootInterval: ['i', 60], mSearchRange: ['f', 800],
    mHabatakiTimer: ['i', 45], mAirFric: ['f', 0.97], mUpperVelocityY: ['f', 0], mDropSpeed: ['f', 5], mDropAngleX: ['f', -0.25],
} satisfies PSchema;

/** cDropCoinNumTable: the coins a bird drops, picked at random from the last three. */
const DROP_COIN_NUM = [3, 3, 1, 2];

export class KukkuManager extends SmallEnemyManager {
    constructor(w: World, name = 'クックマネージャー') { super(w, name); }
    load(s: Stream) {
        const p = smallParams('/enemy/kukku.prm', this.world.files, KUKKU_PARAMS);
        p.mSLAttackRadius = 30; p.mSLAttackHeight = 30; p.mSLDamageRadius = 100; p.mSLDamageHeight = 100; p.mSLBodyRadius = 5;
        this.saveParams = p;
        super.load(s);
    }
    createModelData() { this.createModelDataArray(['tori.bmd']); }
}

/** The goop's model (torifun.bmd), drawn while it falls. */
class BallModel extends LiveActor {
    constructor(owner: Kukku, file: string, public ball: KukkuBall) {
        super(owner.world, file);
        this.manager = owner.manager; this.mactor = this.createMActorByName(file); this.manager = null;
    }
    perform() { }
    drawn() { return !(this.ball.flags & 1); }
}

/** TKukkuBall (クック玉) */
export class KukkuBall extends HitActor {
    flags = 1; vel = new V3(); unk7C = 0;
    model: BallModel;
    constructor(public owner: Kukku) {
        super('クック玉');
        this.model = new BallModel(owner, 'torifun.bmd', this);
        owner.world.extras.push(this.model);
    }
    init() {
        this.initHitActor(AT.KUKKU, 1, 0x80000000 | 0, 30, 30, 0, 0);
        this.onHitFilter(HF.NO_COLLISION);
        this.onHitFilter(HF.NO_DAMAGE);
        this.owner.world.addToGroup('敵グループ', this);
        // (SMS_ChangeTextureAll(torifun, "K_name_dummy", /scene/map/pollution/H_ma_rak.bti): the stage's goop texture)
    }
    perform(cue: number) {
        if (this.flags & 1) return;
        if (cue & CUE_CALC_ANIM) {
            const m = this.model;
            m.pos.set(this.pos); m.scale.set(this.scale); m.rot.zero();
            m.calcRootMatrixBasic();
        }
        if (cue & CUE_MOVE) { this.checkHitActors(); this.bind(); }
        if (!(this.flags & 4) && (cue & CUE_CALC_ANIM) && this.model.mactor) this.model.mactor.frameUpdate();
    }
    /** Falls with a little air drag and pollutes the ground where it lands. */
    bind() {
        this.vel.y = fr(this.vel.y - 0.9);
        this.vel.scale(0.94).fround();
        const next = V3.add(this.pos, this.vel).fround();
        const w = this.owner.world;
        const [h] = w.checkGround(next.x, next.y + this.attackHeight, next.z);
        if (next.y <= 0.05 + (h + 1)) this.kill();
        const p = { x: next.x, z: next.z };
        w.isTouchedOneWallAndMoveXZ(p, next.y + this.attackHeight, this.attackRadius);
        next.x = p.x; next.z = p.z;
        this.pos.set(next);
    }
    checkHitActors() {
        for (const c of this.collisions.slice()) {
            if (c.isActorType(AT.MARIO)) { this.owner.world.mario.receiveMessage(this, MSG.ATTACK); this.kill(); }
        }
    }
    startToMove(p: V3, v: V3) {
        this.offHitFilter(HF.NO_COLLISION);
        this.flags &= ~1;
        this.pos.set(p); this.vel.set(v);
    }
    kill() {
        this.onHitFilter(HF.NO_COLLISION);
        this.flags |= 1;
        // gpPollution->pollute: stamp(1, ...)
        const pol = this.owner.world.pollution;
        if (pol) pol.stamp(1, this.pos.x, this.pos.y, this.pos.z, 500);
    }
    isDead() { return (this.flags & 1) !== 0 && this.unk7C === 0; }
}

export class Kukku extends SmallEnemy {
    balls: KukkuBall[] = [];
    unk1A4 = 0; centerJoint = -1; shootTimer = 0; droppedNum = 0;
    hasOneUp = true;
    get PK(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'クック') { super(w, name); }
    /** (TSmallEnemy::load: its placement data may end early: see tolerantStream) */
    load(s: Stream) { super.load(tolerantStream(s)); }
    init(m: any) {
        this.manager = m; m.manageActor(this);
        this.mactor = this.createMActorByName('tori.bmd');
        this.spine!.initWith(KukkuNerves.graphWander);
        // mOneUp = TMapObjBaseManager::newAndRegisterObj("mushroom1upR")
        for (let i = 0; i < 3; i++) { const b = new KukkuBall(this); b.init(); this.balls.push(b); }
        this.initCollision();
        this.centerJoint = this.mactor ? this.mactor.jointIndex('center') : -1;
        this.reset();
    }
    initCollision() {
        this.initHitActor(AT.KUKKU, 1, 0x80000000 | 0, 30, 30, 100, 100);
        this.offHitFilter(HF.NO_COLLISION);
    }
    reset() {
        this.unk1A4 = 0; this.shootTimer = 0; this.gravity = 0; this.droppedNum = 0;
        this.onLiveFlag(LF.AIRBORNE);
        this.scaledBodyRadius = 75;
    }
    receiveMessage(s: HitActor, m: number) {
        if (this.checkLiveFlag(LF.DEAD)) return false;
        if (m === MSG.TRAMPLE || m === MSG.HIP_DROP) { this.behaveHitTrample(); return true; }
        return super.receiveMessage(s, m);
    }
    control() {
        if (this.unk1A4 > 0) this.unk1A4--;
        LiveActor.prototype.control.call(this);
    }
    calcRootMatrix() {
        if (this.isDying()) {
            // lie down flat on whatever the bird fell on
            const g = this.groundPlane;
            const up = g ? new V3(g.n[0], g.n[1], g.n[2]).normalize() : new V3(0, 1, 0);
            const yaw = qEulerY(0.017453294 * this.rot.y);
            const tilt = new Quat().setRotateFromTo(new V3(0, 1, 0), up, 1);
            tilt.mul(tilt.clone(), yaw);
            tilt.toMtx(this.baseTR, this.pos);
        } else super.calcRootMatrix();
        this.updateEffect();
    }
    bind() { LiveActor.prototype.bind.call(this); }
    perform(cue: number) {
        super.perform(cue);
        for (const b of this.balls) b.perform(cue);
    }
    /** (feathers while falling, sweat while flapping: bound emitters, not modelled) */
    updateEffect() { }
    behaveToWater(_a: HitActor) {
        if (!this.isFalling() && !this.isRecoveringGraph()) { this.spine!.reset(); this.spine!.setNext(KukkuNerves.fall); }
    }
    behaveHitTrample() { this.spine!.reset(); this.spine!.setNext(SmallEnemyNerves.die); }
    doFlyToCurPathNode() {
        if (this.isReachedToGoal()) {
            this.goToRandomNextGraphNode();
            if (!this.mactor!.checkCurAnm('tori_wait', ANM_BCK)) this.changeBck('tori_wait');
        }
        if (this.isFindOutMario()) {
            if (this.shootTimer >= 0) this.shootTimer--;
            else this.shotBall();
        }
        this.updateRotation();
        this.posDelta.set(this.calcMomentum(this.PK.mMarchSpeed));
    }
    updateRotation() {
        const diff = V3.sub(this.goal.point(), this.pos);
        const dist = diff.length();
        if (dist < 100) return;
        const march = this.PK.mMarchSpeed;
        let turn = this.PK.mTurnSpeed;
        if (dist <= 2 * this.calcMinimumTurnRadius(march, turn)) turn = this.calcTurnSpeedToReach(march, 0.5 * dist);
        getRotationFlyToDir(this.rot, diff, march, turn);
        // no banking or pitching while tumbling down
        this.rot.x *= this.isFalling() ? 0 : 1;
        this.rot.z *= this.isFalling() ? 0 : 1;
    }
    calcMomentum(speed: number) { return qRotate(eulerToQuat(this.rot), new V3(0, 0, speed)); }
    doRecoverToCurPathNode() {
        this.updateRotation();
        this.posDelta.set(this.calcMomentum(this.PK.mMarchSpeed));
    }
    /** Flap back up after the fall: true once the climb has stopped. */
    doHabataki() {
        const v = this.vel.clone().scale(this.PK.mAirFric).fround();
        v.y = fr(v.y + this.PK.mUpperVelocityY);
        let stopped = false;
        if (-0.1 < v.y) { stopped = true; v.y = 0; }
        this.vel.set(v);
        return stopped;
    }
    decideFlyingAnm() {
        if (this.mactor!.checkCurAnm('tori_back', ANM_BCK)) this.changeBck('tori_back');
        else this.changeBck('tori_wait');
    }
    shotBall() {
        const b = this.getUnusedBall();
        if (!b) return;
        const v = setLength(new V3(0, 1, 0), this.PK.mShootSpeed);
        // (the game looks up joint "null_osen" and doesn't use it: the goop starts at the bird)
        b.startToMove(this.pos, v);
        this.shootTimer = this.PK.mShootInterval;
    }
    /** Scatter a few coins around the bird, and a 1-up once ten have dropped. */
    dropCoins() {
        if (this.droppedNum > 10) return;
        const w = this.world;
        if (this.droppedNum === 10 && this.hasOneUp) {
            this.droppedNum++;
            w.events.push({ t: w.tickCount, kind: '1up', data: { p: this.pos.clone(), v: new V3() } });
            return;
        }
        let index = Math.trunc(4 * MsRandF());
        if (index < 1) index = 1; else if (index > 3) index = 3;
        const num = DROP_COIN_NUM[index];
        const step = qEulerY(6.2831855 / num);
        const tilt = qEulerX(3.1415927 * this.PK.mDropAngleX);
        const sp = this.PK.mDropSpeed;
        const v = new V3(fr(sp * MsSin(this.rot.y)), 0, fr(sp * MsCos(this.rot.y)));
        qRotate(tilt, v, v);
        qRotate(step, v, v);
        for (let i = 0; i < num; i++) {
            // gpItemManager->makeObjAppear(ACTOR_TYPE_COIN): (no item pool here: always a coin)
            w.events.push({ t: w.tickCount, kind: 'coin', data: { p: this.pos.clone(), v: v.clone() } });
            if (++this.droppedNum === 10) break;
            qRotate(step, v, v);
        }
    }
    isFalling() { const n = this.spine!.getLatestNerve(); return n === KukkuNerves.fall || n === KukkuNerves.postFall; }
    isRecoveringGraph() { return this.spine!.getLatestNerve() === KukkuNerves.recoverGraph; }
    isDying() { return this.spine!.getLatestNerve() === SmallEnemyNerves.die; }
    isFindOutMario() {
        const d = V3.sub(this.world.mario.pos, this.pos); d.y = 0;
        const r = this.PK.mSearchRange;
        return d.squared() < r * r;
    }
    changeBck(name: string) { this.mactor!.setBck(name); }
    setDeadAnm() { this.changeBck('tori_down'); }
    setAfterDeadEffect() {
        super.setAfterDeadEffect();
        const pol = this.world.pollution;
        if (pol) pol.stamp((this.manager as SmallEnemyManager).unk58, this.pos.x, this.pos.y, this.pos.z, 1000);
    }
    getWaterPowerY() { return this.PK.mWaterPowerY; }
    getUnusedBall() { return this.balls.find((b) => b.isDead()) || null; }
}

/** TAnimalBase::getRotationFlyToDir */
export function getRotationFlyToDir(cur: V3, diff: V3, speedX: number, speedY: number) {
    const r = MsGetRotFromZaxis(diff);
    r.y = MsWrap(r.y, 0, 360);
    const d = MsClamp(MsAngleDiff(r.y, cur.y), -speedY, speedY);
    cur.y = fr(MsWrap(fr(cur.y + d), 0, 360));
    const roll = MsClamp(30 * -d, -45, 45);
    cur.z = fr(chase(cur.z, roll, 0.1 * speedX));
    r.x = MsWrap(r.x, -180, 180);
    cur.x = MsWrap(cur.x, -180, 180);
    cur.x = fr(chase(cur.x, r.x, 0.1 * speedX));
}

type S = Spine<Kukku>;
export const KukkuNerves: Record<string, any> = {};
KukkuNerves.graphWander = nerve<Kukku>('TNerveKukkuGraphWander', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.vel.zero();
        self.tracer.reset();
        self.goToShortestNextGraphNode();
        self.decideFlyingAnm();
    }
    self.doFlyToCurPathNode();
    return false;
});
/** (UNUSED in the game: nothing sets it) */
KukkuNerves.hit = nerve<Kukku>('TNerveKukkuHit', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck('tori_hit');
    if (self.checkCurAnmEnd(ANM_BCK)) { spine.pushAfterCurrent(KukkuNerves.graphWander); return true; }
    return false;
});
KukkuNerves.fall = nerve<Kukku>('TNerveKukkuFall', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.changeBck('tori_wait');
        self.mactor!.setFrameRate(2 * ANM_FRAME_RATE, ANM_BCK);
        self.vel.set(0, -self.getWaterPowerY(), 0);
        self.dropCoins();
    }
    // hitting the ground finishes it off
    if (!self.checkLiveFlag(LF.AIRBORNE)) {
        self.world.effect('popoBombA', self.pos); self.world.effect('popoBombB', self.pos);
        spine.pushAfterCurrent(SmallEnemyNerves.die);
        return true;
    }
    if (self.doHabataki()) { spine.pushAfterCurrent(KukkuNerves.recoverGraph); return true; }
    return false;
});
KukkuNerves.postFall = nerve<Kukku>('TNerveKukkuPostFall', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.changeBck('tori_back'); self.vel.zero(); }
    if (self.checkCurAnmEnd(ANM_BCK) && self.PK.mHabatakiTimer < spine.time) { spine.pushAfterCurrent(KukkuNerves.graphWander); return true; }
    return false;
});
KukkuNerves.recoverGraph = nerve<Kukku>('TNerveKukkuRecoverGraph', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.changeBck('tori_back'); self.vel.zero(); }
    if (self.PK.mHabatakiTimer < spine.time) { spine.pushAfterCurrent(KukkuNerves.graphWander); return true; }
    self.doRecoverToCurPathNode();
    return false;
});

register('KukkuManager', (w, n) => new KukkuManager(w, n));
register('Kukku', (w, n) => new Kukku(w, n));
