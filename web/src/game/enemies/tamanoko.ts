// TTamaNoko / TTamaNokoManager / TTamaNokoFlower (Enemy/tamaNoko.cpp): the round Koopas (タマノコ,
// "ball Koopas") that sleep curled up in their shells. Sprayed while asleep one shakes (TNerveTamaNokoHitWater:
// mSLWakeUpTimer of waterhit, or straight on once it has woken once, unk1B9) and gets up; it
// wanders the graph, falling asleep again every 200 ticks if Mario is past mSLGiveUpLength
// (forceSleep). Seeing Mario (or sprayed while walking) it runs at him (TNerveTamaNokoAttack) and,
// within mSLJumpAttackDist, jumps at him: up on a parabola, a spin at the top (mRollOnAirAngle in
// mRollOnAirTimeMax ticks, hanging there mStopOnAirTimeMax: LIVE_FLAG_UNK10), then straight down
// at mDropVelocityY. Landing it lies stunned (TNerveTamaNokoDown, unk164) for mSLPickUpTime —
// on sand it sinks in instead (TNerveTamaNokoSink), for mSLSinkTime scaled by the share of them
// still alive, and only then can it be killed: a hip drop on its head while it is stuck
// (isHitValid). Asleep it is harmless and tramples what bumps it. Dead, it leaves a sunflower
// (TTamaNokoFlower) that blooms where it was and puts out 5 coins round it.
//
// Not here: the particles (zzz, blur, sand, rock), the shadow request, camera shake beyond an
// event, rumble, sounds but the landing one, the flower's anm sound; Mario's invincibility
// (gpMarioOriginal->isInvincible) isn't recorded, so taken as never; TNpcEvent::reviveOneSunflower
// (the stage's sunflowers' revival) is only told to the viewer (an event).

import { fr, V3, MsWrap, MsAngleDiff, MsGetRotFromZaxisY, MsSin, MsCos, JMASSin, JMASCos, mtx, mtxMultVec } from '../math.js';
import { World, Stream, HitActor, LiveActor, SpineEnemy, PathNode, LF, HF, MSG, ANM_BCK, ANM_FRAME_RATE, CUE_MOVE, CUE_CALC_ANIM, nerve, Spine, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { SmallEnemyManager } from './smallEnemy.js';
import { WalkerEnemy, WalkerNerves, walkerParams } from './walker.js';
import { mapObjGlobals } from '../mapobj/base.js';
import { MsMtxSetRotY, marioThrowPower, marioAngleY, marioSwimming } from '../mapobj/lib.js';

/** TTamaNokoSaveLoadParams */
const TAMA_PARAMS = {
    mSLPickUpTime: ['i', 60], mSLJumpAttackDist: ['f', 200], mSLThrownVY: ['f', 50], mSLThrownRateXZ: ['f', 0.5], mSLThrownGravityY: ['f', 1.5],
    mSLJumpAttackSp: ['f', 10], mSLAttackGravityY: ['f', 0.2], mSLSinkTime: ['i', 500], mSLWakeUpTimer: ['i', 100],
} satisfies PSchema;

// tamaNoko_bastable order (the folder's BCKs; the unnamed ones have no .bas)
const BCK_FLOWER_GROW = 0, BCK_APPEAR = 1, BCK_ATTACK = 2, BCK_DOWN = 3, BCK_LAND = 4, BCK_MOGAKI = 5, BCK_MUDLAND = 6, BCK_RETURN = 7,
    BCK_RUN_START = 8, BCK_RUN = 9, BCK_WALK = 10, BCK_SLEEP = 11, BCK_WAIT_END = 12, BCK_WAIT = 13, BCK_WAIT_START = 14, BCK_WATERHIT = 15, BCK_WATERHIT_LOOP = 16;

const isSand = (d: { bgType: number }) => d.bgType === 0x701 || d.bgType === 0x4701 || d.bgType === 0x8701 || d.bgType === 0xC701;
const shake = (w: World, p: V3, mode: number) => w.events.push({ t: w.tickCount, kind: 'cameraShake', data: { mode, power: 1, p: p.clone() } });

// ---------------------------------------------------------------- TTamaNokoFlower
/** TTamaNokoFlower (a TSharedParts: tamaflower_model1.bmd on its TamaNoko's position): drawn once it has died (unk34) */
export class TamaNokoFlower extends LiveActor {
    unk1C = 0; unk34 = 0; unk35 = 0;
    constructor(w: World, public unk10: TamaNoko) {
        super(w, 'タマノコフラワー');
        this.manager = unk10.manager;
        this.mactor = this.createMActorByName('tamaflower_model1.bmd');
        this.manager = null;
        w.extras.push(this);
    }
    perform(cue: number) {
        const w = this.world, a = this.mactor;
        if (cue & CUE_MOVE) {
            if (!w.talkMode) {
                if (this.unk35 !== 0 && this.unk1C === 0 && !w.demoMode) {
                    this.unk1C = 1;
                    const im = mapObjGlobals(w).itemManager as any;
                    for (let i = 0; i < 5; ++i) {
                        const r = mtx();
                        MsMtxSetRotY(r, (i + 1) * 72);
                        const off = mtxMultVec(r, new V3(0, 0, 350));
                        const p = this.unk10.pos.clone();
                        const o = im ? im.makeObjAppearAt(fr(p.x + off.x), p.y, fr(p.z + off.z), AT.COIN, true) : null;
                        if (o) {
                            o.pos.y = p.y;
                            off.normalize().fround();
                            o.vel.set(fr(off.x * 4), 20, fr(off.z * 4));
                            o.offLiveFlag(LF.UNK10);
                        }
                    }
                }
                if (this.unk35 === 0 && a && a.checkCurBckFromIndex(BCK_FLOWER_GROW) && a.curAnmEndsNext(ANM_BCK)) {
                    this.unk35 = 1;
                    w.events.push({ t: w.tickCount, kind: 'reviveOneSunflower', data: { p: this.unk10.pos.clone() } });   // TNpcEvent::reviveOneSunflower
                }
            }
        }
        if (cue & CUE_CALC_ANIM) {
            this.pos.set(this.unk10.pos);
            this.baseTR = mtx(); this.baseTR[3] = this.pos.x; this.baseTR[7] = this.pos.y; this.baseTR[11] = this.pos.z;
        }
        if (!(!w.demoMode && w.talkMode) && a && (cue & CUE_CALC_ANIM)) a.frameUpdate();
    }
    setBckAnm(i: number) { if (this.mactor) this.mactor.setBckFromIndex(i); }
    drawn() { return this.unk34 !== 0; }
}

// ---------------------------------------------------------------- TTamaNoko
export class TamaNoko extends WalkerEnemy {
    static mStopOnAirTimeMax = 40;
    static mRollOnAirTimeMax = 20;
    static mRollOnAirAngle = 360;
    static mDropVelocityY = -30;
    mIsDoingJumpAttack = false; mIsSunkInGround = false;
    unk19C: TamaNokoFlower | null = null;
    unk1A0 = new V3(); unk1AC = new V3();
    unk1B8 = false; unk1B9 = true;
    mAirAttackTimer = 0; mWakeUpTimer = 0;
    get unk198(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'タマノコ') { super(w, name); }
    load(s: Stream) { super.load(s); this.reset(); }
    init(m: any) {
        super.init(m);
        this.actorType = AT.TAMA_NOKO;
        this.unk150 = 0x11;
        this.spine!.initWith(TamaNerves.sleep);
    }
    setMActorAndKeeper() { this.mactor = this.createMActorByName('tamanoko_model1.bmd'); }
    reset() {
        super.reset();
        this.mIsDoingJumpAttack = false; this.mIsSunkInGround = false;
        this.unk1B8 = false; this.unk1B9 = true;
        this.scaledBodyRadius = 280;
        this.onLiveFlag(LF.UNK1000);
    }
    perform(cue: number) {
        super.perform(cue);
        if (this.unk19C && this.unk19C.unk34) this.unk19C.perform(cue);
    }
    moveObject() {
        super.moveObject();
        if (this.spine!.current === WalkerNerves.graphWander && this.isBckAnm(BCK_WALK) && this.checkCurAnmEnd(ANM_BCK)) this.setBckAnm(BCK_RUN);
    }
    behaveToFindMario() { this.spine!.pushAfterCurrent(TamaNerves.attack); }
    behaveToWater(_a: HitActor) {
        this.sprayCooldown = 0;
        this.unk165 = true;
        const c = this.spine!.current;
        if (c === TamaNerves.sleep) { this.spine!.pushNerve(TamaNerves.hitWater); return; }
        if (c === WalkerNerves.graphWander) { this.spine!.pushNerve(TamaNerves.attack); return; }
    }
    walkBehavior(kind: number, k: number) {
        const P = this.unk198;
        this.turnSpeed = P.mSLTurnSpeedLow;
        this.marchSpeed = P.mSLMarchSpeedLow;
        const t = V3.sub(this.goal.point(), this.pos);
        const rot = MsWrap(MsGetRotFromZaxisY(t), 0, 360);
        const diff = MsAngleDiff(rot, this.rot.y);
        const r = diff > 0 ? Math.min(diff, fr(this.turnSpeed * k)) : Math.max(diff, fr(-this.turnSpeed * k));
        this.rot.y = MsWrap(fr(this.rot.y + r), 0, 360);
        if (kind !== 5 && kind !== 3) {
            const s = fr(this.marchSpeed * k);
            this.posDelta.set(fr(this.posDelta.x + fr(s * MsSin(this.rot.y))), this.posDelta.y, fr(this.posDelta.z + fr(s * MsCos(this.rot.y))));
        }
        if (this.spine!.current === WalkerNerves.graphWander && this.spine!.time % 200 === 1) this.forceSleep();
        if (this.mWakeUpTimer > 0 && this.spine!.current === TamaNerves.sleep) {
            ++this.mWakeUpTimer;
            if (this.mWakeUpTimer > 400) { this.mWakeUpTimer = 0; this.spine!.reset(); this.spine!.setNext(TamaNerves.hitWater); }
        }
    }
    behaveToTaken(_a: HitActor) { if (this.spine!.current !== TamaNerves.pickUp) this.spine!.pushNerve(TamaNerves.pickUp); }
    behaveToRelease() { if (this.unk164 !== 0 && this.spine!.current !== TamaNerves.thrown) this.spine!.pushNerve(TamaNerves.thrown); }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (msg === MSG.TRAMPLE || msg === MSG.HIP_DROP) {
            if (this.isHitValid(msg)) { this.unk184 = 0; this.kill(); }
            return true;
        }
        if (msg === MSG.UNKD) { this.hitPoints = 0; this.onLiveFlag(LF.DEAD); this.onHitFilter(HF.NO_COLLISION); }
        if (msg === MSG.SPRAYED_BY_WATER) {
            this.world.effect('enemyWaterHit', sender.pos);
            if (this.sprayCooldown === 0) {
                this.sprayCooldown = 1;
                if (!this.changeByJuice()) { this.decHpByWater(sender); this.behaveToWater(sender); }
            }
            return true;
        }
        return false;
    }
    isHitValid(m: number) {
        if (m === MSG.UNKB) return false;
        if (!this.mIsSunkInGround || (this.isBckAnm(BCK_RETURN) && this.getCurAnmFrameNo(ANM_BCK) > 80)) return false;
        return m === MSG.HIP_DROP;
    }
    attackToMario() {
        if (this.unk164 === 0 && this.spine!.current !== TamaNerves.sleep && (!this.mIsSunkInGround || !(this.world.mario.pos.y > fr(this.pos.y + 10))))
            this.world.mario.receiveMessage(this, MSG.ATTACK);
    }
    doKeepDistance() { return this.spine!.current === TamaNerves.sleep; }
    forceKill() { }
    /** calcRootMatrix: TSpineEnemy's (the particles aside); the appear animation's landing shakes */
    calcRootMatrix() {
        const a = this.mactor;
        if (a && this.isBckAnm(BCK_APPEAR)) {
            const fc = a.getFrameCtrl(ANM_BCK)!;
            if (fc.checkPass(25)) { if (isSand(this.groundPlane)) this.landEffect(); else shake(this.world, this.pos, 7); }
        }
        if (a && this.isBckAnm(BCK_RETURN) && a.getFrameCtrl(ANM_BCK)!.checkPass(110)) this.landEffect();
        SpineEnemy.prototype.calcRootMatrix.call(this);
    }
    landEffect() {
        if (!isSand(this.groundPlane)) {
            const [, d] = this.world.checkGround(this.pos.x, fr(this.pos.y + 500), this.pos.z);
            if (d && d.isWaterSurface()) this.generateEffectColumWater();
        }
        shake(this.world, this.pos, 7);
    }
    forceWakeUp() { }
    forceSleep() {
        this.updateSquareToMario();
        const g = this.unk198.mSLGiveUpLength;
        if (this.distToMarioSq > g * g) { this.setBckAnm(BCK_SLEEP); this.spine!.reset(); this.spine!.setNext(this.spine!.default); }
    }
    setAfterDeadEffect() {
        super.setAfterDeadEffect();
        if (this.unk19C) { this.unk19C.unk34 = 1; this.unk19C.setBckAnm(BCK_FLOWER_GROW); }
    }
    getGravityY() {
        const c = this.spine!.current;
        if (c === TamaNerves.attack) return this.unk198.mSLAttackGravityY;
        if (c === TamaNerves.thrown) return this.unk198.mSLThrownGravityY;
        return this.gravity;
    }
    setWalkAnm() { this.setBckAnm(BCK_WALK); }
    setDeadAnm() { this.setBckAnm(BCK_DOWN); }
    isReachedToGoal() {
        const p = V3.sub(this.goal104.point(), this.pos);
        p.y = 0;
        if (p.x === 0 && p.z === 0) return true;
        return p.squared() < 200;
    }
    isCollidMove(a: HitActor) {
        if (a.actorType === this.actorType) return true;
        if (this.spine!.current === TamaNerves.sleep) { a.receiveMessage(this, MSG.TRAMPLE); return true; }
        return false;
    }
}

type S = Spine<TamaNoko>;
export const TamaNerves: Record<string, any> = {};
/** TNerveTamaNokoSleep: curled up in its shell (the waterhit pose, frozen) */
TamaNerves.sleep = nerve<TamaNoko>('TNerveTamaNokoSleep', (spine: S) => {
    const self = spine.body;
    if (!self.isBckAnm(BCK_WATERHIT) && self.checkCurAnmEnd(ANM_BCK)) { self.setBckAnm(BCK_WATERHIT); self.mactor!.setFrameRate(0, ANM_BCK); }
    self.walkBehavior(5, 0);
    return false;
});
/** TNerveTamaNokoAttack: run at Mario, jump at him in reach, spin at the top and drop */
TamaNerves.attack = nerve<TamaNoko>('TNerveTamaNokoAttack', (spine: S) => {
    const self = spine.body, P = self.unk198;
    if (spine.time === 0) {
        if (!self.isBckAnm(BCK_RUN)) self.setBckAnm(BCK_WALK);
        self.setGoalPath(new PathNode(self.world.mario));
    }
    // (vel.y < -1: the blur particle)
    if (self.mIsDoingJumpAttack) {
        if (!self.isAirborne()) {
            self.landEffect();
            self.mIsDoingJumpAttack = false;
            spine.pushAfterCurrent(TamaNerves.down);
            return true;
        }
        if (self.vel.y < 0) {
            // (unk1AC: the blur particle's place under its body joint)
            if (self.mAirAttackTimer < TamaNoko.mStopOnAirTimeMax) {
                self.onLiveFlag(LF.UNK10);
                const delta = fr(TamaNoko.mRollOnAirAngle / TamaNoko.mRollOnAirTimeMax);
                if (self.mAirAttackTimer < TamaNoko.mRollOnAirTimeMax) self.rot.y = fr(self.rot.y + delta);
                ++self.mAirAttackTimer;
            } else {
                self.vel.set(0, TamaNoko.mDropVelocityY, 0);
                self.offLiveFlag(LF.UNK10);
            }
        }
    } else {
        if (self.checkCurAnmEnd(ANM_BCK)) {
            if (self.isBckAnm(BCK_WALK)) self.setBckAnm(BCK_RUN);
            else if (self.isBckAnm(BCK_RUN)) {
                self.updateSquareToMario();
                const sl = P.mSLSearchLength;
                if (sl * sl < self.distToMarioSq) { self.unk1B8 = true; self.setBckAnm(BCK_RUN_START); }
                else {
                    const jd = P.mSLJumpAttackDist;
                    if (!self.checkLiveFlag(LF.CLIPPED_OUT) && self.distToMarioSq < jd * jd) self.setBckAnm(BCK_RUN_START);
                }
            } else if (self.isBckAnm(BCK_RUN_START)) {
                if (self.unk1B8) { self.unk1B8 = false; spine.pushAfterCurrent(WalkerNerves.graphWander); return true; }
                const m = self.world.mario;
                if (m.checkFlag(0x10000) || marioSwimming(self.world) || m.groundPlane.isWaterSurface()) { spine.pushAfterCurrent(WalkerNerves.graphWander); return true; }
                // (gpMarioOriginal->isInvincible(): pushNerve(TNerveTamaNokoWait); not recorded, taken as never)
                self.setBckAnm(BCK_ATTACK);
            }
        }
        if (self.isBckAnm(BCK_ATTACK)) {
            if (self.mactor!.getFrameCtrl(ANM_BCK)!.checkPass(63)) {
                self.unk1A0 = self.calcVelocityToJumpToY(self.world.mario.pos.clone(), P.mSLJumpAttackSp, self.getGravityY());
                self.unk1A0.x = fr(self.unk1A0.x * 2); self.unk1A0.z = fr(self.unk1A0.z * 2);
                self.pos.y = fr(self.pos.y + 30);
                self.vel.set(self.unk1A0);
                self.onLiveFlag(LF.AIRBORNE);
                self.mIsDoingJumpAttack = true;
                self.mAirAttackTimer = 0;
            }
            self.walkBehavior(3, 0.5);
        } else self.walkBehavior(2, 1);
    }
    return false;
});
/** TNerveTamaNokoDown: landed from the jump attack: stunned for mSLPickUpTime, or stuck on sand */
TamaNerves.down = nerve<TamaNoko>('TNerveTamaNokoDown', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        if (isSand(self.groundPlane)) {
            spine.pushAfterCurrent(TamaNerves.sink);
            const e = self.world.conductor.makeOneEnemyAppear(self.pos, 'エフェクト砂柱マネージャー', 1) as any;
            if (e && e.generate) e.generate(self.pos, new V3(1.2, 0.5, 1.2));
            return true;
        }
        self.world.sound(SE.EN_TAMANOKO_DROPOK, self.pos);
        self.unk164 = 1;
        shake(self.world, self.pos, 7);
        self.setBckAnm(BCK_LAND);
    }
    if (self.checkCurAnmEnd(ANM_BCK) && spine.time > self.unk198.mSLPickUpTime) { self.unk164 = 0; spine.pushAfterCurrent(TamaNerves.wait); return true; }
    return false;
});
TamaNerves.pickUp = nerve<TamaNoko>('TNerveTamaNokoPickUp', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0 && self.unk164 === 0) return true;
    if (self.checkCurAnmEnd(ANM_BCK) && spine.time > self.unk198.mSLPickUpTime) { self.unk164 = 0; self.attackToMario(); return true; }
    return false;
});
TamaNerves.thrown = nerve<TamaNoko>('TNerveTamaNokoThrown', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        const P = self.unk198, power = marioThrowPower(self.world), rate = P.mSLThrownRateXZ;
        const a = marioAngleY(self.world);
        const c = JMASCos(a), s = JMASSin(a);
        self.vel.set(fr(rate * fr(power * s)), P.mSLThrownVY, fr(rate * fr(power * c)));
        self.pos.y = fr(self.pos.y + 2);
        self.onLiveFlag(LF.AIRBORNE);
    }
    if (!self.isAirborne()) { self.unk164 = 0; return true; }
    return false;
});
/** TNerveTamaNokoSink: stuck in the sand; the fewer of them alive, the sooner it gets out */
TamaNerves.sink = nerve<TamaNoko>('TNerveTamaNokoSink', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.mIsSunkInGround = true; self.setBckAnm(BCK_MUDLAND); }
    if (self.checkCurAnmEnd(ANM_BCK)) {
        if (self.isBckAnm(BCK_MUDLAND)) self.setBckAnm(BCK_MOGAKI);
        let sinkTime = self.unk198.mSLSinkTime;
        const man = self.manager!;
        let alive = 0;
        for (let i = 0; i < man.getObjNum(); ++i) if (!(man.getObj(i) as LiveActor).checkLiveFlag(LF.DEAD)) alive = fr(alive + 1);
        alive = fr(alive / man.getObjNum());
        sinkTime = Math.trunc(fr(sinkTime * alive));
        if (spine.time > sinkTime) {
            if (self.isBckAnm(BCK_RETURN)) { self.mIsSunkInGround = false; spine.pushAfterCurrent(TamaNerves.wait); return true; }
            self.setBckAnm(BCK_RETURN);
        }
    }
    return false;
});
/** TNerveTamaNokoHitWater: sprayed asleep: it shakes, and (after mSLWakeUpTimer, or once woken before) gets up */
TamaNerves.hitWater = nerve<TamaNoko>('TNerveTamaNokoHitWater', (spine: S) => {
    const self = spine.body;
    if (spine.time < 2) { self.setBckAnm(BCK_WATERHIT); self.mactor!.setFrameRate(ANM_FRAME_RATE, ANM_BCK); }
    if (self.checkCurAnmEnd(ANM_BCK)) {
        if (self.isBckAnm(BCK_WATERHIT)) self.setBckAnm(BCK_WATERHIT_LOOP);
        else if (self.isBckAnm(BCK_WATERHIT_LOOP)) {
            if (spine.time > self.unk198.mSLWakeUpTimer || !self.unk1B9) {
                self.unk1B9 = false;
                if (!self.isBckAnm(BCK_APPEAR)) self.setBckAnm(BCK_APPEAR);
            } else if (self.unsetUnk165()) self.setBckAnm(BCK_WATERHIT_LOOP);
            else {
                spine.reset();
                spine.setNext(TamaNerves.sleep);
                spine.pushAfterCurrent(TamaNerves.sleep);
                return true;
            }
        } else if (self.isBckAnm(BCK_APPEAR)) {
            spine.pushAfterCurrent(WalkerNerves.graphWander);
            spine.pushAfterCurrent(TamaNerves.wait);
            return true;
        }
    }
    return false;
});
TamaNerves.wait = nerve<TamaNoko>('TNerveTamaNokoWait', (spine: S) => {
    const self = spine.body;
    if (spine.time < 2) { self.setBckAnm(BCK_WAIT_START); self.mactor!.setFrameRate(ANM_FRAME_RATE, ANM_BCK); }
    if (self.checkCurAnmEnd(ANM_BCK)) {
        if (self.isBckAnm(BCK_WAIT_START)) self.setBckAnm(BCK_WAIT);
        else if (self.isBckAnm(BCK_WAIT)) { if (spine.time > self.unk198.mSLWaitTime && self.isBckAnm(BCK_WAIT)) self.setBckAnm(BCK_WAIT_END); }
        else if (self.isBckAnm(BCK_WAIT_END)) { spine.pushAfterCurrent(WalkerNerves.graphWander); return true; }
    }
    return false;
});

export class TamaNokoManager extends SmallEnemyManager {
    constructor(w: World, name = 'タマノコマネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.saveParams = walkerParams('/enemy/tamanoko.prm', this.world.files, TAMA_PARAMS);
    }
    createModelData() { this.createModelDataArray(['tamanoko_model1.bmd']); }
    createEnemyInstance(): SpineEnemy | null { return new TamaNoko(this.world); }
    initSetEnemies() { for (const o of this.objs as TamaNoko[]) o.unk19C = new TamaNokoFlower(this.world, o); }
}

register('TamaNokoManager', (w, n) => new TamaNokoManager(w, n));
register('TamaNoko', (w, n) => new TamaNoko(w, n));
