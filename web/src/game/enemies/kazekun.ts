// Kazekun (Enemy/Kazekun.cpp, かぜくん): the wind spirits. Hidden until Mario comes within
// mAppearDist of its spot; then it appears, circles him (closer the farther he is) for
// mAroundTime, winds up (a spinning pose, aiming at where Mario is a little into it) and blows
// at him in a straight dash, slowing down with air drag; then it vanishes and comes back after
// mResetTime. It only hurts Mario while circling / winding up / dashing; FLUDD's water then
// makes it vanish for mResetTimeHitting. It gives up if Mario climbs or drops too far.

import { fr, V3, Quat, mtx, Mtx } from '../math.js';
import { World, LF, HF, HC, MSG, nerve, Spine, Stream, ANM_BCK, HitActor, PathNode, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemy, SmallEnemyManager, smallParams } from './smallEnemy.js';
import { register } from '../scene.js';
import { qRotate, mtxToQuat, setLength, isZero, jNormalize, tolerantStream } from './jgeom.js';

/** TKazekunParams */
const KAZEKUN_PARAMS = {
    mAppearDist: ['f', 1000], mAroundDist: ['f', 400], mAroundSpeed: ['f', 30], mAroundTime: ['i', 600], mAttackSpeed: ['f', 30], mAirFric: ['f', 0.97],
    mResetTime: ['i', 300], mResetTimeHitting: ['i', 1500], mPoseTime: ['i', 120], mDicideTiming: ['f', 0.1], mTurnOffsetY: ['f', 200],
    mLostOffsetYUp: ['f', 500], mLostOffsetYDown: ['f', 500], mPoseSpeed: ['f', 7.6], mPoseOmegaRate: ['f', 0.04],
} satisfies PSchema;

export class KazekunManager extends SmallEnemyManager {
    constructor(w: World, name = 'かぜくんマネージャ') { super(w, name); }
    load(s: Stream) {
        const p = smallParams('/enemy/kazekun.prm', this.world.files, KAZEKUN_PARAMS);
        p.mSLAttackRadius = 50; p.mSLAttackHeight = 40; p.mSLDamageRadius = 50; p.mSLDamageHeight = 40;
        this.saveParams = p;
        super.load(s);
        this.unk5C = 0;
    }
    createModelData() { this.createModelDataArray(['kazekun.bmd']); }
}

/** SMS_CalcToDirMatrix: m's rotation with z along dir, y as near up as it can be. */
export function calcToDirMatrix(m: Mtx, dir: V3, up: V3) {
    const z = dir.clone();
    if (isZero(z)) z.set(0, 0, 1); else jNormalize(z);
    const x = new V3().cross(up, z);
    if (isZero(x)) x.set(1, 0, 0); else jNormalize(x);
    const y = new V3().cross(z, x);
    jNormalize(y);
    m[0] = x.x; m[4] = x.y; m[8] = x.z;
    m[1] = y.x; m[5] = y.y; m[9] = y.z;
    m[2] = z.x; m[6] = z.y; m[10] = z.z;
}

export class Kazekun extends SmallEnemy {
    unk194 = new V3(); unk1A0 = new Quat(); unk1B0 = 0;
    get PZ(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'かぜくん') { super(w, name); this.onLiveFlag(LF.UNK10); }
    /** (TSmallEnemy::load: its placement data may end early: see tolerantStream) */
    load(s: Stream) { super.load(tolerantStream(s)); }
    init(m: any) {
        this.manager = m; m.manageActor(this);
        this.mactor = this.createMActorByName('kazekun.bmd');
        this.spine!.initWith(KazekunNerves.search);
        this.initCollision();
        this.unk194.set(this.pos);
        this.reset();
    }
    reset() {
        this.unk1A0.set4(0, 0, 0, 1);
        this.pos.set(this.unk194);
        this.setVisible(false);
    }
    initCollision() {
        this.headHeight = 40; this.bodyRadius = 50; this.scaledBodyRadius = 50;
        this.initHitActor(AT.KAZEKUN, 1, HC.PLAYER, this.getBodyRadius(), this.getHeadHeight(), this.getBodyRadius(), this.getHeadHeight());
        this.onHitFilter(HF.NO_COLLISION);
    }
    calcRootMatrix() {
        if (this.holder) { super.calcRootMatrix(); return; }
        this.unk1A0.toMtx(this.baseTR, this.pos);
        // (hasWind: the wind and blur emitters bound to the matrix, not modelled)
    }
    bind() { this.posDelta.add(this.vel); }
    behaveToWater(_a: HitActor) {
        if (this.isHitWater()) { this.spine!.reset(); this.spine!.setNext(KazekunNerves.hitWater); }
    }
    isHitWater() {
        const n = this.spine!.getLatestNerve();
        return n === KazekunNerves.turn || n === KazekunNerves.preAttack || n === KazekunNerves.attack;
    }
    isDamage() { return this.isHitWater(); }
    hasWind() { return this.isHitWater() || this.spine!.getLatestNerve() === KazekunNerves.hitWater; }
    attackToMario() { if (this.isDamage()) this.world.mario.receiveMessage(this, MSG.ATTACK); }
    isCollidMove(_a: HitActor) { return false; }
    emitAppearEffect() { this.world.effect('kazeAppear', this.pos); }
    isGiveUpAround() {
        const dy = this.world.mario.pos.y - this.unk194.y;
        return dy < -this.PZ.mLostOffsetYDown || this.PZ.mLostOffsetYUp < dy;
    }
    changeBck(name: string) { this.mactor!.setBck(name); }
    setDeadAnm() { const fc = this.mactor!.getFrameCtrl(ANM_BCK); if (fc) { fc.init(1); fc.frame = 0; } }
    flyAroundMario() {
        const P = this.PZ;
        const to = this.world.mario.pos.clone();
        to.y = fr(to.y + P.mTurnOffsetY);
        to.sub(this.pos);
        const climb = fr(Math.min(Math.max(to.y, -400), 400) * 0.0025);
        to.y = 0;
        const q = Kazekun.getAroundQuat(to, this.getAroundRate(to));
        this.unk1A0.set(q);
        const v = qRotate(q, new V3(0, 0, 1));
        v.y = climb;
        v.scale(1 + Math.abs(climb)).scale(P.mAroundSpeed).fround();
        this.posDelta.set(v);
    }
    getAroundRate(dir: V3) { return Math.min(Math.max(dir.length() / this.PZ.mAroundDist, 0), 2); }
    static getAroundQuat(dir: V3, rate: number) {
        const m = mtx();
        calcToDirMatrix(m, dir, new V3(0, 1, 0));
        const q = mtxToQuat(m);
        const axis = new V3(m[1], m[5], m[9]);   // getYDir
        const r = new Quat().setRotateAxis(axis, (2 - rate) * (Math.PI / 2));
        return q.mul(q.clone(), r);
    }
    doAttackPose(start: boolean) {
        const P = this.PZ;
        const to = V3.sub(this.world.mario.pos, this.pos); to.y = 0;
        if (start) {
            const q = Kazekun.getAroundQuat(to, 1);
            this.unk1A0.set(q);
            this.vel.set(qRotate(q, new V3(0, 0, P.mPoseSpeed)));
        }
        const axis = qRotate(this.unk1A0, new V3(-1, 0, 0));
        const spin = new Quat().setRotateAxis(axis, Math.PI * P.mPoseOmegaRate);
        spin.mul(spin.clone(), this.unk1A0);
        this.unk1A0.set(spin);
        this.vel.set(qRotate(spin, new V3(0, 0, this.vel.length())));
        return false;
    }
    doAttack(start: boolean) {
        if (start) {
            const d = V3.sub(this.goal104.point(), this.pos);
            setLength(d, this.PZ.mAttackSpeed);
            this.vel.set(d);
        }
        const target = Kazekun.getAroundQuat(this.vel, 2);
        const q = new Quat().slerp(this.unk1A0, target, 0.1).normalize();
        this.unk1A0.set(q);
    }
    setVisible(v: boolean) {
        if (v) this.offLiveFlag(LF.HIDDEN | LF.UNK8);
        else this.onLiveFlag(LF.HIDDEN | LF.UNK8);
    }
}

type S = Spine<Kazekun>;
export const KazekunNerves: Record<string, any> = {};
KazekunNerves.search = nerve<Kazekun>('TNerveKazekunSearch', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.reset();
    self.updateSquareToMario();
    const d = self.PZ.mAppearDist;
    if (self.distToMarioSq <= d * d) { spine.pushAfterCurrent(KazekunNerves.appear); return true; }
    return false;
});
KazekunNerves.appear = nerve<Kazekun>('TNerveKazekunAppear', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.setVisible(true); self.emitAppearEffect(); self.changeBck('kazekun_appear'); }
    if (self.checkCurAnmEnd(ANM_BCK)) { spine.pushAfterCurrent(KazekunNerves.turn); return true; }
    return false;
});
KazekunNerves.turn = nerve<Kazekun>('TNerveKazekunTurn', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.changeBck('kazekun_wait'); self.offHitFilter(HF.NO_COLLISION); }
    self.flyAroundMario();
    if (self.isGiveUpAround()) { spine.pushAfterCurrent(KazekunNerves.disappear); return true; }
    if (self.PZ.mAroundTime < spine.time) { spine.pushAfterCurrent(KazekunNerves.preAttack); return true; }
    return false;
});
KazekunNerves.preAttack = nerve<Kazekun>('TNerveKazekunPreAttack', (spine: S) => {
    const self = spine.body, P = self.PZ;
    if (spine.time === 0) self.doAttackPose(true);
    if (fr(P.mPoseTime * P.mDicideTiming) < spine.time) self.setGoalPath(new PathNode(null, self.world.mario.pos.clone()));
    self.doAttackPose(false);
    if (P.mPoseTime < spine.time) { spine.pushAfterCurrent(KazekunNerves.attack); return true; }
    return false;
});
KazekunNerves.attack = nerve<Kazekun>('TNerveKazekunAttack', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.changeBck('kazekun_attack'); self.doAttack(true); }
    self.doAttack(false);
    const v = self.vel.clone().scale(self.PZ.mAirFric).fround();
    self.vel.set(v);
    if (v.squared() < 1) { spine.pushAfterCurrent(KazekunNerves.disappear); self.unk1B0 = self.PZ.mResetTime; return true; }
    return false;
});
KazekunNerves.disappear = nerve<Kazekun>('TNerveKazekunDisappear', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.changeBck('kazekun_vanish'); self.emitAppearEffect(); self.vel.zero(); self.onHitFilter(HF.NO_COLLISION); }
    if (self.checkCurAnmEnd(ANM_BCK)) { spine.pushAfterCurrent(KazekunNerves.wait); return true; }
    return false;
});
KazekunNerves.wait = nerve<Kazekun>('TNerveKazekunWait', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setVisible(false);
    if (self.unk1B0 < spine.time) { spine.pushAfterCurrent(KazekunNerves.search); return true; }
    return false;
});
KazekunNerves.hitWater = nerve<Kazekun>('TNerveKazekunHitWater', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck('kazekun_hit');
    if (self.checkCurAnmEnd(ANM_BCK)) { spine.pushAfterCurrent(KazekunNerves.disappear); self.unk1B0 = self.PZ.mResetTimeHitting; return true; }
    self.vel.zero();
    return false;
});

register('KazekunManager', (w, n) => new KazekunManager(w, n));
register('Kazekun', (w, n) => new Kazekun(w, n));
