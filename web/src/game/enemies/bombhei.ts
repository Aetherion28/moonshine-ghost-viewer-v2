// Bob-ombs (TBombHei, Enemy/bombhei.cpp, ボム兵): the walking bombs the Monty Mole cannons throw
// (TCannon::bombSet / bombShoot). One lands (Generate: nejibomb_model1.bmd, its fuse BTP still),
// walks at Mario (Attack) and after mSLBombTime ticks lights its fuse and walks on
// (WalkExplosion) until it blows up (Explosion: downnejibomb_model1.bmd, the explosion effect,
// its collision growing to mSLBombRange; touching Mario then burns him). FLUDD's water stops it
// (WaitExplosion: a wet fuse, it blows up 150 ticks later). Mario can pick one up (PickUp) and
// throw it (Thrown: mSLThrownVY up, mSLThrownRateXZ of his throw power along his facing, under
// mSLThrownGravityY) — it explodes where it lands, and thrown or exploding it's what hurts a
// cannon's Monty Mole (isDamageToCannon). An exploding Bob-omb sets off the others it touches
// (mSerialBomb).
//
// Not here: the Yoshi juice change (changeOut), the particles (the fuse), the camera shake and
// rumble, the anm sounds, and the director's flag 0xF check in calcRootMatrix.

import { fr, V3, JMASSin, JMASCos } from '../math.js';
import { World, Stream, HitActor, LF, HF, MSG, ANM_BCK, ANM_BTP, ANM_FRAME_RATE, nerve, Spine, PathNode, PSchema, SpineEnemy, MActor } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { SmallEnemyManager, rangeRand, LIVE_FLAG_MELT_ON_DEATH } from './smallEnemy.js';
import { WalkerEnemy, walkerParams } from './walker.js';
import { msVecNormalize } from '../camera/lib.js';
import { marioThrowPower, marioAngleY } from '../mapobj/lib.js';
import type { BGCheckData } from '../collision.js';

/** TBombHeiSaveLoadParams */
const BOMBHEI_PARAMS = {
    mSLBombTime: ['i', 1000], mSLBombRange: ['f', 300], mSLThrownVY: ['f', 50], mSLThrownRateXZ: ['f', 0.5], mSLThrownGravityY: ['f', 1.5],
    mSLShootVelocity: ['f', 12],
} satisfies PSchema;

// BCKs (/scene/bombhei, in the folder's order)
const BCK_DOWN = 0, BCK_FREEZE = 1, BCK_FALL = 2, BCK_LAND = 3, BCK_WALK = 4, BCK_WALK_EXPLOSION = 5, BCK_STOP_DOWN = 6;

const isSand = (d: BGCheckData) => d.bgType === 0x701 || d.bgType === 0x4701 || d.bgType === 0x8701 || d.bgType === 0xC701;

export class BombHeiManager extends SmallEnemyManager {
    unk60 = 0;
    constructor(w: World, name = 'ボム兵マネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.saveParams = walkerParams('/enemy/bombhei.prm', this.world.files, BOMBHEI_PARAMS);
    }
    createModelData() { this.createModelDataArray(['nejibomb_model1.bmd', 'downnejibomb_model1.bmd']); }
    createEnemyInstance(): SpineEnemy | null { return new BombHei(this.world); }
    canMakeDeadCoin() { if (this.unk60 < 20) { this.unk60++; return true; } return false; }
}

export class BombHei extends WalkerEnemy {
    static mSerialBomb = true;
    /** unk198 ticks walked (its fuse), unk19C keeps its distance (not yet exploding), unk1A0 the scale its blast grows to, unk1A4 Mario picked it up */
    unk198 = 0; unk19C = 1; unk1A0 = 0; unk1A4 = 0;
    /** the TMActorKeeper's two models */
    bodyModel: MActor | null = null; downModel: MActor | null = null;
    get PB(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'ボム兵') { super(w, name); }
    init(m: any) {
        super.init(m);
        this.actorType = AT.BOMB_HEI;
        this.unk150 = 0x11;
        this.spine!.initWith(BombHeiNerves.generate);
    }
    setMActorAndKeeper() {
        this.bodyModel = this.createMActorByName('nejibomb_model1.bmd');
        this.downModel = this.createMActorByName('downnejibomb_model1.bmd');
        this.mactor = this.bodyModel;
    }
    behaveToWater(_a: HitActor) {
        if (this.isBckAnm(BCK_WALK) || this.isBckAnm(BCK_LAND)) {
            if (this.hitPoints === 0) this.spine!.pushNerve(BombHeiNerves.waitExplosion);
            this.sprayCooldown = 20;
        }
    }
    isHitValid(m: number) {
        if (m === MSG.UNKB) { this.onLiveFlag(LF.DEAD); this.onHitFilter(HF.NO_COLLISION); this.genEventCoin(); return false; }
        return false;
    }
    kill() {
        if (this.checkLiveFlag(LF.DEAD)) return;
        this.hitPoints = 1;
        if (this.spine!.current !== BombHeiNerves.explosion) {
            this.spine!.reset();
            this.spine!.setNext(BombHeiNerves.explosion);
            this.spine!.pushAfterCurrent(BombHeiNerves.explosion);
        }
        this.onLiveFlag(LF.UNK40);
    }
    /** genEventCoin: a coin toward Mario when he picked it up (20 at most) */
    genEventCoin() {
        const man = this.manager as BombHeiManager;
        if (this.unk1A4 && man.canMakeDeadCoin()) {
            const c = this.world.makeCoinAt(this.pos.x, this.pos.y, this.pos.z);
            if (c) {
                c.pos.y = this.pos.y;
                const v = V3.sub(this.world.mario.pos, this.pos);
                msVecNormalize(v, v);
                c.vel.set(fr(v.x * 20), 20, fr(v.z * 20));
                c.offLiveFlag(LF.UNK10);
            }
        }
    }
    setWalkAnm() { this.setBckAnm(BCK_WALK); }
    setFreezeAnm() { this.setBckAnm(BCK_FREEZE); }
    setDeadAnm() {
        this.mactor = this.downModel;
        this.rot.y = rangeRand(0, 360);
        this.unk19C = 0;
        this.setBckAnm(BCK_DOWN);
        // (the camera shake and rumble)
    }
    calcRootMatrix() {
        super.calcRootMatrix();
        // TODO: SMSGetMarDirector()->checkFlag(0xF) kills it (not modelled)
        if (this.isBckAnm(BCK_DOWN) && this.mactor!.getFrameCtrl(ANM_BCK)!.checkPass(2)) {
            const e = this.world.conductor.makeOneEnemyAppear(this.pos, 'エフェクト爆発マネージャー', 1) as any;
            if (e && e.generate) e.generate(this.pos, this.scale);
        }
    }
    attackToMario() { if (this.spine!.current === BombHeiNerves.explosion) this.world.mario.receiveMessage(this, MSG.BURN); }
    behaveToTaken(a: HitActor) {
        if (this.spine!.current === BombHeiNerves.pickUp) return;
        if (a.isActorType(AT.MARIO)) this.unk1A4 = 1;
        this.spine!.pushNerve(BombHeiNerves.pickUp);
    }
    behaveToRelease() {
        if (this.unk164 === 0 && this.spine!.current !== BombHeiNerves.walkExplosion) return;
        if (this.spine!.current === BombHeiNerves.thrown) return;
        this.spine!.pushNerve(BombHeiNerves.thrown);
    }
    bombIn() { this.spine!.pushNerve(BombHeiNerves.explosion); }
    reset() {
        super.reset();
        this.unk198 = 0; this.unk1A4 = 0; this.unk164 = 0; this.unk19C = 1;
        this.mactor = this.bodyModel;
    }
    getGravityY() { return this.spine!.current === BombHeiNerves.thrown ? this.PB.mSLThrownGravityY : this.gravity; }
    walkBehavior(kind: number, k: number) { this.world.sound(SE.EN_BOMBHEI_ZENMAI, this.pos); super.walkBehavior(kind, k); }
    moveObject() {
        super.moveObject();
        const c = this.spine!.current;
        // (TNerveSmallEnemyChange, the juice block's, isn't here)
        if (c !== BombHeiNerves.thrown && c !== BombHeiNerves.explosion && c !== BombHeiNerves.generate) {
            ++this.unk198;
            if (this.unk198 > this.PB.mSLBombTime) {
                this.unk164 = 0; this.unk198 = 0;
                if (this.spine!.current !== BombHeiNerves.waitExplosion) this.spine!.pushNerve(BombHeiNerves.walkExplosion);
            }
        }
    }
    isCollidMove(a: HitActor) {
        if (BombHei.mSerialBomb && a.isActorType(AT.BOMB_HEI) && (a as BombHei).isExplosion()) {
            if (this.spine!.current !== BombHeiNerves.explosion) this.spine!.pushNerve(BombHeiNerves.explosion);
        }
        if (a.isActorType(AT.BOSS_TELESA)) {
            if (this.spine!.current === BombHeiNerves.explosion) a.receiveMessage(this, MSG.TRAMPLE);
            if (this.spine!.current === BombHeiNerves.thrown) this.spine!.pushNerve(BombHeiNerves.explosion);
        }
        return true;
    }
    forceKill() {
        const g = this.groundPlane;
        if (g.isIllegal()) return;
        if (g.isDeathPlane() || g.isPool() || g.isWaterSurface()) {
            if (this.isAirborne()) return;
            if (this.checkLiveFlag(LF.UNK10)) return;
            if (this.spine!.current !== BombHeiNerves.explosion) {
                this.spine!.reset();
                this.spine!.setNext(BombHeiNerves.explosion);
                this.spine!.pushAfterCurrent(this.spine!.default);
                this.onLiveFlag(LF.UNK20000);
                this.hitPoints = 1;
            }
        }
    }
    isExplosion() { return this.spine!.current === BombHeiNerves.explosion; }
    isDamageToCannon() {
        const c = this.spine!.current;
        if (c === BombHeiNerves.thrown || c === BombHeiNerves.explosion) { this.onHitFilter(HF.NO_COLLISION); return true; }
        return false;
    }
    setAfterDeadEffect() { }
    doKeepDistance() { return this.unk19C !== 0; }
    /** (fabricated helper: TNerveBombHeiGenerate does this twice) the fuse: BTP 1, still */
    setGenerateModel() {
        this.mactor = this.bodyModel;
        this.setBckAnm(BCK_FALL);
        this.mactor!.setFromIndex(ANM_BTP, 1);
        this.mactor!.setFrameRate(0, ANM_BTP);
    }
}

type S = Spine<BombHei>;
export const BombHeiNerves: Record<string, any> = {};
BombHeiNerves.generate = nerve<BombHei>('TNerveBombHeiGenerate', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setGenerateModel();
    if (self.holder) self.mactor!.setFrameRate(0, ANM_BCK);
    if (!self.isAirborne() && !self.holder) {
        if (self.isBckAnm(BCK_FALL)) self.setBckAnm(BCK_LAND);
        else if (self.checkCurAnmEnd(ANM_BCK)) { spine.pushAfterCurrent(BombHeiNerves.attack); return true; }
    } else if (!self.isBckAnm(BCK_FALL)) self.setGenerateModel();
    return false;
});
BombHeiNerves.attack = nerve<BombHei>('TNerveBombHeiAttack', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.setWalkAnm(); self.unk164 = 0; self.setGoalPath(new PathNode(self.world.mario)); }
    self.walkBehavior(2, 1);
    return false;
});
BombHeiNerves.walkExplosion = nerve<BombHei>('TNerveBombHeiWalkExplosion', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.setBckAnm(BCK_WALK_EXPLOSION); self.mactor!.setFromIndex(ANM_BTP, 0); }
    else if (self.checkCurAnmEnd(ANM_BCK)) { spine.pushAfterCurrent(BombHeiNerves.explosion); return true; }
    const btp = self.mactor!.getFrameCtrl(ANM_BTP);
    if (btp && Math.trunc(btp.frame) % 40 === 0) self.world.sound(SE.EN_BOMBHEI_COUNT, self.pos);
    self.walkBehavior(2, 0.6);
    return false;
});
BombHeiNerves.waitExplosion = nerve<BombHei>('TNerveBombHeiWaitExplosion', (spine: S) => {
    const self = spine.body, a = self.mactor!;
    if (spine.time === 0) { self.setBckAnm(BCK_STOP_DOWN); self.unk164 = 1; }
    if (self.unk164) {
        const fc = a.getFrameCtrl(ANM_BCK)!;
        if (fc.checkPass(60)) a.setFrameRate(0, ANM_BCK);
        if (fc.checkPass(10)) {
            a.setFrameRate(ANM_FRAME_RATE, ANM_BTP);
            if (self.getCurAnmFrameNo(ANM_BTP) >= 1) a.setFrameRate(0, ANM_BTP);
        }
    } else {
        a.setFrameRate(ANM_FRAME_RATE, ANM_BCK);
        if (a.getCurAnmIdx(ANM_BTP) !== 0) a.setFromIndex(ANM_BTP, 0);
        if (self.checkCurAnmEnd(ANM_BCK) && spine.time > 150) { spine.pushAfterCurrent(BombHeiNerves.explosion); return true; }
        const btp = a.getFrameCtrl(ANM_BTP);
        if (btp && Math.trunc(btp.frame) % 40 === 0) self.world.sound(SE.EN_BOMBHEI_COUNT, self.pos);
    }
    return false;
});
BombHeiNerves.pickUp = nerve<BombHei>('TNerveBombHeiPickUp', (spine: S) => spine.time === 0 && spine.body.unk164 === 0);
BombHeiNerves.thrown = nerve<BombHei>('TNerveBombHeiThrown', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        const P = self.PB, power = marioThrowPower(self.world), rate = P.mSLThrownRateXZ;
        const ang = marioAngleY(self.world);
        const c = JMASCos(ang), s = JMASSin(ang);
        self.vel.set(fr(rate * fr(power * s)), P.mSLThrownVY, fr(rate * fr(power * c)));
        self.pos.y = fr(self.pos.y + 2);
        self.onLiveFlag(LF.AIRBORNE);
    }
    if (spine.time === 120) self.offHitFilter(HF.NO_COLLISION);
    if (!self.isAirborne()) { self.genEventCoin(); spine.pushAfterCurrent(BombHeiNerves.explosion); return true; }
    return false;
});
BombHeiNerves.explosion = nerve<BombHei>('TNerveBombHeiExplosion', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.unk1A0 = fr(fr(self.PB.mSLBombRange * self.bodyScale) / self.attackRadius);
        self.setDeadAnm();
        self.onLiveFlag(LF.UNK8);
        if (self.holder === (self.world.mario as unknown)) self.sendAttackMsgToMario();
        self.unk164 = 0;
        if (self.groundPlane.isWaterSurface()) {
            const e = self.world.conductor.makeOneEnemyAppear(self.pos, 'エフェクト爆発水柱マネージャー', 1) as any;
            if (e && e.generate) e.generate(self.pos, new V3(2, 2, 2));
        }
        if (isSand(self.groundPlane)) {
            const e = self.world.conductor.makeOneEnemyAppear(self.pos, 'エフェクト砂柱マネージャー', 1) as any;
            if (e && e.generate) e.generate(self.pos, new V3(0.7, 0.7, 0.7));
        }
    }
    if (self.unk190 < self.unk1A0) self.unk190 = fr(self.unk190 * 1.2);
    else if (self.checkCurAnmEnd(ANM_BCK)) {
        self.onHitFilter(HF.NO_COLLISION);
        self.onLiveFlag(LF.DEAD); self.onLiveFlag(LF.UNK8);
        self.offLiveFlag(LIVE_FLAG_MELT_ON_DEATH);
        self.holder = null;
        spine.reset();
        spine.setNext(spine.default);
        spine.pushAfterCurrent(spine.default);
        return true;
    }
    self.expandCollision();
    return false;
});

register('BombHeiManager', (w, n) => new BombHeiManager(w, n));
register('BombHei', (w, n) => new BombHei(w, n));
