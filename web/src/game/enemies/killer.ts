// TFlyEnemy / TKiller / TKillerManager (Enemy/killer.cpp): the Bullet Bills (キラー) of Pinna Park,
// fired by the cannons there (enemies/cannon.ts killerShoot: TConductor::makeOneEnemyAppear on
// "キラーマネージャー", then reset() and its own velocity, colour type and goal).
//
// A TFlyEnemy is a walker that flies: for mInvalidTime ticks after it appears (unk1A0), and
// while it chases, its bind is fly() (its velocity plus a share of Mario's, its own gravity
// unk194 added to its height, landing only once past mInvalidTime); otherwise it is a walker on
// the ground. NormalFly: it flies on (pitched to its velocity, growing to its body scale) until it
// sees Mario (or, unk1A4, after 500 ticks) within mSLChaseDist; ChaseFly: it heads for a point past
// Mario (calcChaseParam: unk198 2 the chase proper, flyMove turning towards the goal; 0 / 1 it
// climbs or drops to his height first). A Bullet Bill sinks faster the longer it chases
// (mSLChaseTimer, mSLWaterAddGravityY) and explodes (TNerveKillerExplosion: the blast grows to
// mSLBombRange) on the ground, at a wall, on another enemy while chasing (mSerialBomb), sprayed
// (giving its coins: 2, or 8 for the gold one, unk1A6, 1 in 20), or on Mario from above.
// A stomp only pushes it down (mTrampleDie: unk194 -= 12); Yoshi's tongue (HIT_MESSAGE_UNKB)
// eats it for its coins.
//
// Not here: the colours (nose, eyes, body: the GXColorS10 TEV registers, drawing only), the roll
// of its body joint (KillerBodyCallback: drawing only), the smoke particle, the fly sound, rumble,
// the juice block (changeOut); TMarDirector's flag 0xF check in calcRootMatrix (which kills every
// Bullet Bill) is taken as never set.

import { fr, V3, MsWrap, MsAngleDiff, MsGetRotFromZaxisY, MsGetRotFromZaxis, MsSin, MsCos, MsClamp, mtx, mtxMultVec } from '../math.js';
import { World, Stream, HitActor, LiveActor, SpineEnemy, PathNode, LF, HF, HC, MSG, ANM_BCK, MActor, nerve, Spine, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SmallEnemy, SmallEnemyManager, SmallEnemyNerves, LIVE_FLAG_MELT_ON_DEATH, rangeRand } from './smallEnemy.js';
import { WalkerEnemy, walkerParams } from './walker.js';
import { marioVel } from './koopa.js';
import { mapObjGlobals } from '../mapobj/base.js';
import { MsMtxSetRotY } from '../mapobj/lib.js';
import type { WallCheck } from '../collision.js';

/** TFlyEnemyParams */
export const FLY_PARAMS = {
    mSLNormalFlyGravityY: ['f', 0.2], mSLNormalFlySpeed: ['f', 10], mSLChaseFlyGravityY: ['f', 0.1], mSLChaseDist: ['f', 2000], mSLForceGravityY: ['f', 0.1],
} satisfies PSchema;
/** TKillerSaveLoadParams */
export const KILLER_PARAMS = { ...FLY_PARAMS, mSLWaterAddGravityY: ['f', 1], mSLChaseTimer: ['i', 1000], mSLBombRange: ['f', 300] } satisfies PSchema;

// killer_bastable order (the folder's BCKs)
export const BCK_DOWN = 0, BCK_ROLL = 1, BCK_FLY = 2, BCK_SEARCH = 3;
const MODEL_NORMAL = 'killer_model1.bmd', MODEL_DOWN = 'downkiller_model1.bmd';

const isSand = (d: { bgType: number }) => d.bgType === 0x701 || d.bgType === 0x4701 || d.bgType === 0x8701 || d.bgType === 0xC701;

// ---------------------------------------------------------------- TFlyEnemy
export class FlyEnemy extends WalkerEnemy {
    static mTestSp = 2.5;
    static mInvalidTime = 200;
    static mTestMarioSpMax = 12;
    /** unk194 the gravity it flies with, unk198 the chase state (0, 1 or 2), unk1A0 ticks since reset */
    unk194 = 0; unk198 = 0; unk1A0 = 0;
    unk1A4 = 0; unk1A5 = 1; unk1A6 = 0;
    unk1A8 = new V3();
    get unk19C(): any { return this.getSaveParam(); }
    constructor(w: World, name = '') { super(w, name); }
    getGravityY() {
        if (this.spine!.current === FlyNerves.chaseFly) return this.unk194;
        return this.unk19C.mSLNormalFlyGravityY;
    }
    reset() {
        super.reset();
        this.unk1A0 = 0; this.unk198 = 1; this.unk1A4 = 0;
        this.unk194 = this.unk19C.mSLNormalFlyGravityY;
        this.unk1A5 = 0;
    }
    fly() {
        const p = this.pos.clone().add(this.posDelta);
        const v = this.vel.clone();
        const mv = marioVel(this.world);
        v.x = fr(v.x + fr(mv.x / FlyEnemy.mTestMarioSpMax));
        v.z = fr(v.z + fr(mv.z / FlyEnemy.mTestMarioSpMax));
        p.add(v).fround();
        p.y = fr(p.y + this.unk194);
        const [h, d] = this.world.checkGround(p.x, fr(p.y + this.headHeight), p.z);
        this.groundPlane = d;
        this.groundHeight = fr(h + 1);
        if (p.y <= this.groundHeight) {
            if (this.unk1A0 > FlyEnemy.mInvalidTime) {
                this.offLiveFlag(LF.AIRBORNE);
                this.vel.set(0, 0, 0);
                p.y = this.groundHeight;
            }
            const ga = d.actor as LiveActor | null;
            if (ga && ga.isActorType(AT.BASKET_REVERSE)) ga.kill();
            if (d.isIllegal()) this.kill();   // (checkFlag(0x10))
        } else this.onLiveFlag(LF.AIRBORNE);
        this.posDelta.set(V3.sub(p, this.pos));
    }
    calcChaseParam() {
        const m = this.world.mario.pos;
        const toMario = new V3(fr(m.x - this.pos.x), fr(m.y - this.pos.y), fr(m.z - this.pos.z));
        toMario.x = fr(toMario.x * 1.1); toMario.z = fr(toMario.z * 1.1);
        const goal = new V3(fr(this.pos.x + toMario.x), fr(this.pos.y + toMario.y), fr(this.pos.z + toMario.z));
        if (this.unk1A5) this.setGoalPath(new PathNode(null, goal));
        // (abs(): the int one)
        if (toMario.y > 100 || Math.trunc(Math.abs(toMario.y)) < 100) {
            if (this.unk1A5) {
                if (this.unk198 !== 2 && this.sprayCooldown === 0) this.unk194 = this.unk19C.mSLChaseFlyGravityY;
                this.unk198 = 2;
            } else this.pos.y = fr(this.pos.y - 1);
            return;
        }
        this.unk194 = this.unk19C.mSLNormalFlyGravityY;
        const v = new V3(0, 0, 0);
        if (this.unk198 !== 2 || toMario.y > 150) {
            this.unk198 = 0;
            toMario.normalize().fround();
            const sp = this.unk19C.mSLNormalFlySpeed;
            v.x = fr(toMario.x * sp); v.z = fr(toMario.z * sp);
            this.unk194 = this.unk19C.mSLForceGravityY;
        } else this.pos.y = fr(this.pos.y - 3);
        v.z = 0; v.x = 0;
        this.vel.set(v);
    }
    bind() {
        if (this.spine!.current === FlyNerves.chaseFly || this.unk1A0 < FlyEnemy.mInvalidTime) this.fly();
        else LiveActor.prototype.bind.call(this);
    }
    flyMove() {
        this.vel.scale(0.9).fround();
        const toGoal = V3.sub(this.goal.point(), this.pos);
        const target = MsWrap(MsGetRotFromZaxisY(toGoal), 0, 360);
        const diff = fr(target - MsWrap(this.rot.y, fr(target - 180), fr(target + 180)));
        const t = this.turnSpeed;
        this.rot.y = MsWrap(fr(this.rot.y + (diff > 0 ? (diff > t ? t : diff) : (diff > -t ? diff : -t))), 0, 360);
        const ms = this.marchSpeed;
        this.posDelta.set(fr(this.posDelta.x + fr(ms * MsSin(this.rot.y))), this.posDelta.y, fr(this.posDelta.z + fr(ms * MsCos(this.rot.y))));
    }
    setAfterDeadEffect() { }
    flyBehavior() { }
    setChaseFlyAnm() { }
    setNormalFlyAnm() { }
}

type FS = Spine<FlyEnemy>;
export const FlyNerves: Record<string, any> = {};
FlyNerves.normalFly = nerve<FlyEnemy>('TNerveFlyEnemyNormalFly', (spine: FS) => {
    const self = spine.body, P = self.unk19C;
    if (spine.time === 0) self.setNormalFlyAnm();
    if (self.unk1A4 && self.unk1A0 > 500) {
        self.updateSquareToMario();
        if (self.distToMarioSq < P.mSLChaseDist * P.mSLChaseDist) { spine.pushAfterCurrent(FlyNerves.chaseFly); return true; }
    } else if (!self.unk1A6 && self.isFindMario(1) && self.unk1A0 > 100) {
        self.updateSquareToMario();
        if (self.distToMarioSq < P.mSLChaseDist * P.mSLChaseDist) { spine.pushAfterCurrent(FlyNerves.chaseFly); return true; }
    }
    self.rot.x = fr(MsGetRotFromZaxis(self.vel).x);
    const s = MsClamp(fr(1.05 * self.scale.x), 0, self.bodyScale);
    self.scale.set(s, s, s);
    return false;
});
FlyNerves.chaseFly = nerve<FlyEnemy>('TNerveFlyEnemyChaseFly', (spine: FS) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.unk1A8.set(self.vel);
        self.calcChaseParam();
        self.setChaseFlyAnm();
    }
    let walkRate = 1;
    if (!self.unk1A5) {
        const march2 = fr(self.marchSpeed * self.marchSpeed);
        self.unk1A8.y = fr(0.1);
        walkRate = fr(fr(fr(self.unk1A8.length()) / march2) * FlyEnemy.mTestSp);
    } else if (self.unk198 === 0) walkRate = 2;
    self.walkBehavior(2, walkRate);
    if ((self.unk1A5 && self.isReachedToGoalXZ()) || (self.unk198 === 0 && self.pos.y < fr(100 + self.groundHeight))) self.calcChaseParam();
    switch (self.unk198) {
        case 0: case 1: self.walkBehavior(3, 1); break;
        case 2: self.flyMove(); break;
    }
    if (self.unk198 !== 2 && self.pos.y > fr(200 + self.groundHeight)) {
        const dir = new V3(self.marchSpeed, fr(-40 * self.getGravityY()), self.marchSpeed);
        self.rot.x = fr(MsGetRotFromZaxis(dir).x);
        const delta = self.posDelta.clone();
        delta.y = self.getGravityY();
        self.rot.x = fr(MsGetRotFromZaxis(delta).x);
    } else self.rot.x = fr(self.rot.x * 0.99);
    self.flyBehavior();
    const s = MsClamp(fr(1.1 * self.scale.x), 0, self.bodyScale);
    self.scale.set(s, s, s);
    return false;
});

// ---------------------------------------------------------------- TKiller
export class Killer extends FlyEnemy {
    static mSerialBomb = 1;
    static mTrampleDie = 1;
    static mRollSw = 0;
    /** unk1B8 the roll angle (drawing), unk20C the blast's scale to grow to */
    unk1B8 = 0; unk20C = 0;
    mactors: MActor[] = [];
    get unk1B4(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'キラー') { super(w, name); }
    init(m: any) {
        WalkerEnemy.prototype.init.call(this, m);
        this.actorType = AT.ENEMY_UNK1F;
        this.unk150 = 17;
        this.spine!.initWith(FlyNerves.normalFly);
        this.onLiveFlag(LF.FORCE_SHADOW);
        this.offLiveFlag(LF.UNK800);
        this.onHitFilter(HC.MAP_OBJECT);
        this.unk188 = 0;
    }
    /** TMActorKeeper(2): the flying model and the broken one */
    setMActorAndKeeper() {
        this.mactors = [this.createMActorByName(MODEL_NORMAL), this.createMActorByName(MODEL_DOWN)].filter((a): a is MActor => !!a);
        this.mactor = this.getKeeperMActor(MODEL_NORMAL);
    }
    getKeeperMActor(file: string) { return this.mactors.find((a) => a.model.endsWith('/' + file)) || this.mactor; }
    behaveToWater(_a: HitActor) {
        const c = this.spine!.current;
        if (c === FlyNerves.normalFly || c === FlyNerves.chaseFly) this.genEventCoin();
        if (c !== KillerNerves.explosion) {
            this.spine!.pushNerve(KillerNerves.explosion);
            this.onHitFilter(HF.NO_COLLISION);
            this.vel.set(0, 0, 0);
        }
    }
    /** genEventCoin: 2 coins (8 for the gold one) round it */
    genEventCoin() {
        const num = this.unk1A6 ? 8 : 2;
        const im = mapObjGlobals(this.world).itemManager as any;
        for (let i = 0; i < num; i++) {
            const r = mtx();
            MsMtxSetRotY(r, fr(fr(360 * fr(1 / num)) * (i + 1)));
            const off = mtxMultVec(r, new V3(0, 0, 30));
            const coin = im ? im.makeObjAppearAt(fr(this.pos.x + off.x), this.pos.y, fr(this.pos.z + off.z), AT.COIN, true) : null;
            if (coin) {
                coin.pos.y = this.pos.y;
                off.normalize().fround();
                coin.vel.set(fr(3 * off.x), 20, fr(3 * off.z));
                coin.offLiveFlag(LF.UNK10);
            }
        }
    }
    isHitValid(m: number) {
        if (m === MSG.UNKB) { this.onLiveFlag(LF.DEAD); this.onHitFilter(HF.NO_COLLISION); this.genEventCoin(); return false; }
        if (Killer.mTrampleDie) this.unk194 = fr(this.unk194 - 12);
        return false;
    }
    setDeadAnm() {
        this.mactor = this.getKeeperMActor(MODEL_DOWN);
        this.setBckAnm(BCK_DOWN);
        const e = this.world.conductor.makeOneEnemyAppear(this.pos, 'エフェクト爆発マネージャー', 1) as any;
        if (e && e.generate) e.generate(this.pos, this.scale);
        this.world.events.push({ t: this.world.tickCount, kind: 'cameraShake', data: { mode: 6, power: 1, p: this.pos.clone() } });
    }
    attackToMario() {
        if (this.world.mario.pos.y < this.pos.y) {
            if (this.spine!.current !== KillerNerves.explosion) { this.spine!.pushNerve(KillerNerves.explosion); this.sendAttackMsgToMario(); }
            else this.world.mario.receiveMessage(this, MSG.BURN);
        }
    }
    forceKill() { }
    setNormalFlyAnm() { this.mactor = this.getKeeperMActor(MODEL_NORMAL); this.setBckAnm(BCK_FLY); this.unk1B8 = 0; this.unk1A0 = 0; }
    setChaseFlyAnm() { this.setBckAnm(BCK_SEARCH); }
    isRollFly() { return this.spine!.current === FlyNerves.chaseFly && this.isBckAnm(BCK_ROLL); }
    isCollidMove(a: HitActor) {
        if (a.isActorType(AT.BASKET_REVERSE)) (a as LiveActor).kill();
        if (Killer.mSerialBomb && this.spine!.current === FlyNerves.chaseFly) this.spine!.pushNerve(KillerNerves.explosion);
        return true;
    }
    flyBehavior() {
        const P = this.unk1B4;
        this.turnSpeed = P.mSLTurnSpeedLow;
        if (this.spine!.time > P.mSLChaseTimer) this.unk194 = fr(this.unk194 - P.mSLWaterAddGravityY);
        if (this.checkCurAnmEnd(ANM_BCK) && this.isBckAnm(BCK_SEARCH)) this.setBckAnm(BCK_ROLL);
        this.unk1B8 = fr(this.unk1B8 + 2.5);
    }
    reset() {
        WalkerEnemy.prototype.reset.call(this);
        this.unk1A0 = 0; this.unk198 = 1; this.unk1A4 = 0;
        this.unk194 = this.unk19C.mSLNormalFlyGravityY;
        this.unk1A5 = 0;
        this.unk1A6 = 0;
        if (rangeRand(0, 1) < fr(0.05)) this.unk1A6 = 1;   // (the gold one's colours)
    }
    /** setColorType: the gold one never homes (unk1A5); a homing one is purple (colours: drawing only) */
    setColorType() { if (this.unk1A6) this.unk1A5 = 0; }
    bind() {
        super.bind();
        this.unk1A0++;
        if (this.spine!.current !== KillerNerves.explosion) {
            if (!this.isAirborne() && this.unk1A0 > FlyEnemy.mInvalidTime) this.spine!.pushNerve(KillerNerves.explosion);
            else if (this.unk1A0 > FlyEnemy.mInvalidTime) {
                const r: WallCheck = { center: [this.pos.x, fr(this.pos.y + this.headHeight), this.pos.z], radius: fr(2 * this.bodyRadius), maxResults: 1, flags: 0, results: [] };
                if (this.world.isTouchedWallsAndMoveXZ(r)) {
                    const wa = r.results[0] && (r.results[0].actor as LiveActor | null);
                    if (wa && wa.isActorType(AT.BASKET_REVERSE)) wa.kill();
                    this.spine!.pushNerve(KillerNerves.explosion);
                }
            }
        }
        // (airborne: the fly sound and the smoke particle)
        if (this.isAirborne()) this.rot.x = MsClamp(this.rot.x, -25, 90);
    }
    calcRootMatrix() {
        // (TMarDirector flag 0xF: taken as never set; the colours: drawing only)
        this.rot.x = MsClamp(this.rot.x, -25, 90);
        SpineEnemy.prototype.calcRootMatrix.call(this);
    }
    isFindMario(k: number) {
        const P = this.P, m = this.world.mario.pos;
        if (Math.trunc(Math.abs(m.y - this.pos.y)) < P.mSLSearchHeight)   // (abs(): the int one)
            return this.isInSight(m.clone(), P.mSLSearchLength * k, P.mSLSearchAngle * k, P.mSLSearchAware * k);
        return false;
    }
}

type KS = Spine<Killer>;
export const KillerNerves: Record<string, any> = {};
KillerNerves.explosion = nerve<Killer>('TNerveKillerExplosion', (spine: KS) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.unk20C = fr(fr(self.unk1B4.mSLBombRange * self.bodyScale) / self.attackRadius);
        self.rot.x = 0;
        self.setDeadAnm();
        if (!self.isAirborne()) {
            if (self.groundPlane.isWaterSurface()) {
                const e = self.world.conductor.makeOneEnemyAppear(self.pos, 'エフェクト爆発水柱マネージャー', 1) as any;
                if (e && e.generate) e.generate(self.pos, new V3(2, 2, 2));
            }
            if (isSand(self.groundPlane)) {
                const e = self.world.conductor.makeOneEnemyAppear(self.pos, 'エフェクト砂柱マネージャー', 1) as any;
                if (e && e.generate) e.generate(self.pos, new V3(0.6, 0.9, 0.6));
            }
        }
    }
    if (self.unk190 < self.unk20C) self.unk190 = fr(self.unk190 * 1.3);
    else {
        self.onHitFilter(HF.NO_COLLISION);
        if (self.checkCurAnmEnd(ANM_BCK)) {
            self.onLiveFlag(LF.DEAD); self.onLiveFlag(LF.UNK8); self.offLiveFlag(LIVE_FLAG_MELT_ON_DEATH);
            self.holder = null;
            spine.reset();
            spine.setNext(SmallEnemyNerves.die);
            spine.pushAfterCurrent(spine.default);
            self.pos.y = fr(self.pos.y - 200);
            return true;
        }
    }
    self.expandCollision();
    return false;
});

/** KillerParams (walker's + TFlyEnemyParams + TKillerSaveLoadParams) */
export function killerParams(w: World, path = '/enemy/killer.prm') { return walkerParams(path, w.files, KILLER_PARAMS); }

export class KillerManager extends SmallEnemyManager {
    constructor(w: World, name = 'キラーマネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.saveParams = killerParams(this.world);
    }
    createModelData() { this.createModelDataArray([MODEL_NORMAL, MODEL_DOWN]); }
    createEnemyInstance(): SpineEnemy | null { return new Killer(this.world); }
}
void SmallEnemy;

register('KillerManager', (w, n) => new KillerManager(w, n));
register('Killer', (w, n) => new Killer(w, n));
