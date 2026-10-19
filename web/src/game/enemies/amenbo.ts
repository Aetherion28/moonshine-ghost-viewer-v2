// Pond skaters (Enemy/Amenbo.cpp, アメンボくん): skate the water of their territory in spurts,
// turn toward Mario when he's in the water near them and dash at him; Mario can bounce on their
// back (their collision, a TMapCollisionWarp, is in the map while they aren't stunned); FLUDD's
// water stuns them. They die after 600 ticks out of water.

import { fr, V3, Quat, MsRandF } from '../math.js';
import { World, LF, HF, HC, MSG, nerve, Spine, Stream, ANM_BCK, HitActor, WarpCollision, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemy, SmallEnemyManager, SmallEnemyNerves, smallParams } from './smallEnemy.js';
import type { WaterHitActor } from '../water.js';
import { register } from '../scene.js';

const AMENBO_PARAMS = {
    mSpeed: ['f', 10], mAttackSpeed: ['f', 15], mWaterFric: ['f', 0.995], mEpsilon: ['f', 1], mIsNotSearchTimerMax: ['i', 240],
    mSearchRange: ['f', 1000], mSearchHeight: ['f', 200], mTerritoryRange: ['f', 5000], mHitWaterTimer: ['i', 600], mPreAttackTimer: ['i', 90],
} satisfies PSchema;

export class AmenboManager extends SmallEnemyManager {
    constructor(w: World, name = 'アメンボくんマネージャー') { super(w, name); }
    load(s: Stream) {
        const p = smallParams('/enemy/amenbo.prm', this.world.files, AMENBO_PARAMS);
        p.mSLAttackRadius = 60; p.mSLAttackHeight = 120; p.mSLDamageRadius = 100; p.mSLDamageHeight = 150; p.mSLWallRadius = 150;
        this.saveParams = p;
        super.load(s);
    }
    createModelData() { this.createModelDataArray(['amenbo_model1.bmd']); }
}

export class Amenbo extends SmallEnemy {
    initial = new V3(); quat = new Quat(); q1C0 = new Quat(); q1D0 = new Quat(); t1E0 = 0;
    chasing = false; hitCooldown = 0; searchCooldown = 0; outOfWater = 0;
    warp!: WarpCollision;
    get PA(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'アメンボくん') { super(w, name); this.onLiveFlag(LF.UNK8); }
    init(m: any) {
        this.manager = m; m.manageActor(this);
        this.mactor = this.createMActorByName('amenbo_model1.bmd');
        this.spine!.initWith(AmenboNerves.walk);
        this.initHitActor(AT.AMENBO, 2, HC.PLAYER | HC.ENEMY | HC.BOSS, 60, 120, 100, 150);
        this.offHitFilter(HF.NO_COLLISION);
        this.wallRadius = this.PA.mSLWallRadius;
        this.warp = new WarpCollision(this.world, '/scene/amenbo/col/amenbo.col', this);
        this.initial.set(this.pos);
        this.quat.set4(0, 0, 0, 1);
        this.chasing = false; this.hitCooldown = 0; this.searchCooldown = 0; this.outOfWater = 0;
    }
    load(s: Stream) { super.load(s); this.initial.set(this.pos); }
    reset() { }
    kill() { super.kill(); }
    bind() {
        if (this.checkLiveFlag(LF.UNK10)) return;
        const n = this.pos.clone(); n.y += this.headHeight; n.add(this.posDelta).add(this.vel);
        this.vel.y -= this.getGravityY();
        if (this.vel.y < -40) this.vel.y = -40;
        const [h, d] = this.world.checkGround(n.x, n.y + this.headHeight, n.z);
        this.groundPlane = d; this.groundHeight = fr(h + 1);
        if (n.y <= this.groundHeight + 0.05) {
            if (d.isIllegal()) this.kill();
            this.offLiveFlag(LF.AIRBORNE);
            const sea = d.bgType === 0x102 || d.bgType === 0x103;
            if (d.isWaterSurface() || sea || d.isPool()) { this.vel.y = 0; this.outOfWater = 0; }
            else { this.vel.zero(); this.outOfWater += 1; }
            n.y = this.groundHeight;
        } else this.onLiveFlag(LF.AIRBORNE);
        const p = { x: n.x, z: n.z };
        this.world.isTouchedOneWallAndMoveXZ(p, n.y + this.headHeight, this.wallRadius);
        n.x = p.x; n.z = p.z;
        n.y -= this.headHeight;
        this.posDelta.set(V3.sub(n, this.pos));
    }
    control() {
        if (this.hitCooldown > 0) this.hitCooldown--;
        if (this.searchCooldown > 0) this.searchCooldown--;
        this.updateCollision();
        // (SMS_AskJumpIntoWaterEffectExist: Mario's splash into the water -> checkMarioWaterIn)
        if (this.world.mario.justEnteredWater) this.checkMarioWaterIn();
        super.control();
    }
    checkMarioWaterIn() {
        if (!this.isOverTerritory(new V3()) && this.searchCooldown <= 0 && this.isFreeze() && !this.isChangedBlock()) {
            this.decideTargetOnFindingMario();
            this.spine!.reset(); this.spine!.setNext(AmenboNerves.turn);
            this.vel.zero();
        }
    }
    updateCollision() { if (!this.isFreeze() && !this.mactor!.checkCurAnm('amenbo_hit1_end', ANM_BCK)) this.activateJumpBase(); else this.deactivateJumpBase(); }
    receiveMessage(s: HitActor, m: number) {
        if (this.checkLiveFlag(LF.DEAD)) return false;
        if (m === MSG.TRAMPLE || m === MSG.HIP_DROP) return false;
        return super.receiveMessage(s, m);
    }
    behaveToWater(a: HitActor) {
        if (this.hitCooldown <= 0 && this.isWaterFromWaterGun(a)) { this.hitCooldown = 45; this.spine!.reset(); this.spine!.setNext(AmenboNerves.hitWater); }
    }
    calcRootMatrix() {
        if (this.holder && this.holder.held === this) { super.calcRootMatrix(); return; }
        this.quat.toMtx(this.baseTR, this.pos);
        this.baseTR[7] += this.headHeight;
    }
    forceKill() {
        if (this.outOfWater < 600) return;
        if (this.spine!.getLatestNerve() !== SmallEnemyNerves.die) { this.onLiveFlag(LF.UNK20000); this.kill(); }
    }
    isCollidMove(a: HitActor) { return a !== this; }
    doKeepDistance() { return !this.isAttacking(); }
    attackToMario() { if (this.isAttacking()) this.sendAttackMsgToMario(); }
    setDeadAnm() { const fc = this.mactor!.getFrameCtrl(ANM_BCK); if (fc) { fc.init(1); fc.frame = 0; } }
    changeBck(name: string, k: number) { this.mactor!.setBck(name); this.mactor!.setFrameRate(2 * k, ANM_BCK); }
    prepareWalk() { const d = this.quat.getZDir(); d.scale(this.chasing ? this.PA.mAttackSpeed : this.PA.mSpeed); this.vel.set(d); }
    doWalk() {
        const v = this.vel.clone().scale(this.PA.mWaterFric), e = this.PA.mEpsilon;
        let r = false;
        if (v.x * v.x + v.z * v.z < e * e) { r = true; v.zero(); }
        this.vel.set(v);
        return r;
    }
    doAdjustTarget() {
        this.vel.scale(0.9);
        this.t1E0 = this.mactor!.getFrameCtrl(ANM_BCK)!.frame * (1 / 63);
        if (1 <= this.t1E0) this.t1E0 = 1;
        this.quat.slerp(this.q1C0, this.q1D0, this.t1E0).normalize();
    }
    doChangeWaitAnm() {
        if (this.checkCurAnmEnd(ANM_BCK)) {
            const a = this.mactor!;
            if (a.checkCurAnm('amenbo_wait1_start', ANM_BCK)) this.changeBck('amenbo_wait1_loop', 1);
            else if (a.checkCurAnm('amenbo_wait1_loop', ANM_BCK)) this.changeBck('amenbo_wait1_end', 1);
            else this.changeBck('amenbo_wait1_start', 1);
        }
    }
    decideTarget() {
        this.chasing = false;
        const d = new V3();
        if (this.isOverTerritory(d)) { this.setWalkDirV(d.normalize()); return; }
        if (this.isFindOutMario()) { this.decideTargetOnFindingMario(); return; }
        const q = new Quat().setRotateAxis(new V3(0, 1, 0), fr(fr(1.5 - MsRandF()) * fr(Math.PI)));   // (f32 pi)
        this.setWalkDirQ(q);
    }
    decideTargetOnFindingMario() {
        const d = V3.sub(this.world.mario.pos, this.pos); d.y = 0; d.normalize();
        this.setWalkDirV(d);
        this.chasing = true;
        this.searchCooldown = this.PA.mIsNotSearchTimerMax;
    }
    setWalkDirV(v: V3) { this.q1D0.setRotateFromTo(new V3(0, 0, 1), v, 1); this.q1C0.set(this.quat); this.t1E0 = 0; }
    setWalkDirQ(q: Quat) { this.q1C0.set(this.quat); this.q1D0.mul(q, this.quat); this.t1E0 = 0; }
    isStartMoving() { return this.mactor!.getFrameCtrl(ANM_BCK)!.checkPass(63); }
    isFindOutMario() {
        const m = this.world.mario;
        if (!m.checkFlag(0x10000) && !m.groundPlane.isWaterSurface() && !m.checkFlag(0x20000)) return false;
        const d = V3.sub(m.pos, this.pos);
        const r = this.PA.mSearchRange;
        if (Math.trunc(Math.abs(d.y)) < this.PA.mSearchHeight) { d.y = 0; if (d.squared() < r * r) return true; }
        return false;
    }
    isOverTerritory(out: V3) { out.set(this.initial).sub(this.pos); out.y = 0; const r = this.PA.mTerritoryRange; return r * r < out.squared(); }
    isAttacking() { return this.spine!.getLatestNerve() !== AmenboNerves.hitWater || this.mactor!.checkCurAnm('amenbo_hit1_end', ANM_BCK); }
    isFreeze() { return this.spine!.getLatestNerve() !== AmenboNerves.hitWater; }
    isChangedBlock() { return false; }
    isWaterFromWaterGun(a: HitActor) { const w = this.world.water, i = (a as WaterHitActor).unk68; return !!w && i >= 0 && (w.flag[i] & 0x40) !== 0; }
    activateJumpBase() {
        if (this.warp.isSetUp()) this.deactivateJumpBase();
        this.warp.setUpTrans(this.pos);
        this.onHitFilter(HF.NO_ATTACK);
        this.damageRadius = 215; this.damageHeight = 120; this.calcEntryRadius();
        this.onLiveFlag(LF.UNK10);
    }
    deactivateJumpBase() {
        if (!this.warp.isSetUp()) return;
        this.warp.remove();
        this.offHitFilter(HF.NO_ATTACK);
        this.damageRadius = 100; this.damageHeight = 150; this.calcEntryRadius();
        this.offLiveFlag(LF.UNK10);
    }
}

type S = Spine<Amenbo>;
export const AmenboNerves: Record<string, any> = {};
AmenboNerves.search = nerve<Amenbo>('TNerveAmenboSearch', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.decideTarget(); spine.pushAfterCurrent(AmenboNerves.turn); return true; }
    if (self.checkCurAnmEnd(ANM_BCK)) { self.decideTargetOnFindingMario(); spine.pushAfterCurrent(AmenboNerves.turn); return true; }
    return false;
});
AmenboNerves.turn = nerve<Amenbo>('TNerveAmenboTurn', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck('amenbo_run1', self.chasing ? 3 : 1);
    self.doAdjustTarget();
    if (self.isStartMoving()) { spine.pushAfterCurrent(self.chasing ? AmenboNerves.preAttack : AmenboNerves.walk); return true; }
    return false;
});
AmenboNerves.preAttack = nerve<Amenbo>('TNerveAmenboPreAttack', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck('amenbo_hit1_loop', 2);
    if (self.PA.mPreAttackTimer < spine.time) {
        self.changeBck('amenbo_run1', self.chasing ? 3 : 1);
        self.mactor!.getFrameCtrl(ANM_BCK)!.frame = 63;
        spine.pushAfterCurrent(AmenboNerves.walk);
        return true;
    }
    return false;
});
AmenboNerves.walk = nerve<Amenbo>('TNerveAmenboWalk', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.prepareWalk();
    if (self.doWalk()) { spine.pushAfterCurrent(AmenboNerves.search); return true; }
    self.doChangeWaitAnm();
    return false;
});
AmenboNerves.hitWater = nerve<Amenbo>('TNerveAmenboHitWater', (spine: S) => {
    const self = spine.body, a = self.mactor!;
    if (spine.time === 0) {
        if (a.checkCurAnm('amenbo_hit1_end', ANM_BCK) || a.checkCurAnm('amenbo_hit1_loop', ANM_BCK)) self.changeBck('amenbo_hit1_loop', 1);
        else if (!a.checkCurAnm('amenbo_hit1_start', ANM_BCK)) self.changeBck('amenbo_hit1_start', 1);
    }
    self.vel.zero();
    if (self.checkCurAnmEnd(ANM_BCK)) {
        if (a.checkCurAnm('amenbo_hit1_start', ANM_BCK)) self.changeBck('amenbo_hit1_loop', 1);
        else if (a.checkCurAnm('amenbo_hit1_loop', ANM_BCK) && self.PA.mHitWaterTimer < spine.time) self.changeBck('amenbo_hit1_end', 1);
        else if (a.checkCurAnm('amenbo_hit1_end', ANM_BCK)) { spine.pushAfterCurrent(AmenboNerves.search); return true; }
    }
    return false;
});

register('AmenboManager', (w, n) => new AmenboManager(w, n));
register('Amenbo', (w, n) => new Amenbo(w, n));
