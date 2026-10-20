// TPoiHana / TPoiHanaRed / TSleepPoiHana / TPoiHanaManager (Enemy/poihana.cpp): the Cataquacks
// (ポイハナ). Walkers on the graph; one that sees Mario runs at him (TNerveWalkerAttack) and, when it
// touches him while running, scoops him up (TNervePoihanaThrow: the throw animation holds on frame
// 4 for 16 ticks, then Mario gets HIT_MESSAGE_THROWN and SMS_ThrowMario up and a little back, at
// mSLThrowSpeed). The red one (ポイハナ赤) also hurts him on that touch. Water knocks one over
// (TNervePoihanaFreeze: it lies dizzy for mSLFreezeWait, then gets up); a stomp while it lies there
// kills it (isHitValid: humi animation, genRandomItem). With mSleepVersion it dozes off after
// wandering mSLWakeFrame ticks (TNervePoihanaSleep) and wakes when touched or sprayed, or after
// mSLSleepFrame; 居眠りポイハナ (SleepPoiHana) starts asleep and only a touch / spray wakes it.
// Standing on a sand bomb base (ACTOR_TYPE_SAND_BOMB_BASE00) when it pops up throws it into the air
// (TNervePoihanaTrapped); it dies where it lands unless it lands on the trap again.
// A second hit actor (TPoiHanaCollision, ポイハナコリジョン) rides its body joint and does the
// touching (checkHit: attackToMario / behaveToHitOthers).
// The manager only makes its own instances in area 0x38 (createEnemyInstance).
//
// Not here: particles (kizetsu / zzz / sand / dead), rumble, the body's TEV colour
// (initSetEnemies / unk1C0: the viewer's), juice (changeByJuice).

import { fr, V3, MsMtxSetRotRPH, mtx, mtxMultVec, MsRandF } from '../math.js';
import { World, Stream, HitActor, LiveActor, LiveManager, LF, HF, HC, MSG, ANM_BCK, ANM_FRAME_RATE, nerve, Spine, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { SmallEnemyManager, SmallEnemyNerves } from './smallEnemy.js';
import { WalkerEnemy, WalkerNerves, walkerParams } from './walker.js';
import { isHideObj } from '../mapobj/fruit.js';
import { marioTouchGround4cm, sendToMario } from '../mapobj/lib.js';

/** TPoihanaSaveLoadParams */
const POIHANA_PARAMS = {
    mSLThrowSpeed: ['f', 100], mSLBackThrowVal: ['f', 0.5], mSLSleepFrame: ['i', 1000], mSLWakeFrame: ['i', 2000],
    mSLTrapJumpMaxSpY: ['f', 10], mSLTrapJumpMinSpY: ['f', 10], mSLTrapJumpMaxSpXZ: ['f', 8], mSLTrapJumpMinSpXZ: ['f', 8], mSLTrapJumpGravity: ['f', 1],
} satisfies PSchema;

/** TMsRange<f32>::rand */
const rangeF = (lo: number, hi: number) => fr(lo + fr(fr(hi - lo) * MsRandF()));
/** TMsRange<s32>::rand */
const rangeI = (lo: number, hi: number) => lo + Math.trunc(fr((hi - lo) * MsRandF()));

// BCKs (/scene/poihana, poihana_bastable's order)
const BCK_DASH = 0, BCK_DEATH = 1, BCK_GETUP = 2, BCK_HUMI = 3, BCK_KIZETSU = 4, BCK_SLEEP = 5, BCK_SLEEP_START = 6, BCK_TRAPPED = 7,
    BCK_THROW = 8, BCK_WAIT = 9, BCK_WAKEN = 10, BCK_WALK = 11, BCK_WATERHIT = 12, BCK_WATERHIT2 = 13;

// TPoiHana's statics
const mMouthJntIndex: number = 6, mSleepVersion: number = 1, mBodyJntIndex: number = 0;
void mMouthJntIndex;
const velocityMinY = -40;

export class PoiHanaManager extends SmallEnemyManager {
    constructor(w: World, name = 'ポイハナマネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.saveParams = walkerParams('/enemy/poihana.prm', this.world.files, POIHANA_PARAMS);
    }
    createEnemyInstance() { return this.world.map === 0x38 ? new PoiHana(this.world) : null; }
    // (initSetEnemies: the body material's TEV colour, the viewer's)
}

/** TPoiHanaCollision: the hit actor on its body joint */
export class PoiHanaCollision extends HitActor {
    unk68!: PoiHana;
    constructor(name = 'ポイハナコリジョン') { super(name); }
    receiveMessage(sender: HitActor, msg: number) { return this.unk68.receiveMessage(sender, msg); }
    checkHit() {
        for (const col of this.collisions.slice()) {
            if (col.isActorType(AT.MARIO)) this.unk68.attackToMario();
            else this.unk68.behaveToHitOthers(col);
        }
    }
    kill() { this.onHitFilter(HF.NO_COLLISION); }
}

export class PoiHana extends WalkerEnemy {
    unk194 = false; unk195 = true; unk198 = 0;
    unk19C: any = null;
    /** unk1A0: wakes up by itself (false: 居眠りポイハナ) */
    unk1A0 = true;
    mGoToSleepTimer = 0;
    unk1A8 = true; mIsTrapped = false; mThrowTimer = 0;
    mCurrentFlungVelocity = new V3();
    unk1BC: PoiHanaCollision | null = null;
    /** unk1C8: sleeps at all (the red one doesn't) */
    unk1C8 = true;
    constructor(w: World, name = 'ポイハナ') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.reset();
    }
    init(m: any) {
        super.init(m);
        this.actorType = AT.POI_HANA;
        this.unk150 = 17;
        this.onHitFilter(HC.MAP_OBJECT);
        this.mGoToSleepTimer = this.instanceIndex * -250;
        if (mSleepVersion !== 0 && !this.unk1A0) this.spine!.initWith(PoiHanaNerves.sleep);
        else this.spine!.initWith(WalkerNerves.graphWander);
        this.unk19C = this.getSaveParam();
        const c = this.unk1BC = new PoiHanaCollision();
        this.world.addToGroup('敵グループ', c);
        const P = this.unk19C, s = this.bodyScale;
        c.initHitActor(0, 2, HC.PLAYER, P.mSLAttackRadius * s, P.mSLAttackHeight * s, P.mSLDamageRadius * s, P.mSLDamageHeight * s);
        c.unk68 = this;
    }
    setMActorAndKeeper() { this.mactor = this.createMActorByName('default.bmd'); }
    reset() {
        super.reset();
        this.unk198 = this.groundHeight;
        this.unk194 = false; this.unk195 = false;
        this.mGoToSleepTimer = 0;
        this.unk1A8 = true; this.mIsTrapped = false;
    }
    moveObject() {
        const c = this.unk1BC!;
        if (this.checkLiveFlag(LF.CLIPPED_OUT)) c.pos.set(this.pos);
        else {
            const m = this.mactor ? this.mactor.anmMtx(mBodyJntIndex, this.baseTR, this.scale) : null;
            if (m) c.pos.set(m[12], m[13], m[14]);
            else c.pos.set(this.baseTR[3], this.baseTR[7], this.baseTR[11]);
        }
        c.checkHit();
        super.moveObject();
        if (this.isAirborne()) return;
        if (this.mIsTrapped) return;
        const cur = this.spine!.current;
        if (cur !== PoiHanaNerves.trapped && cur !== SmallEnemyNerves.die && this.isOnTrap()) this.spine!.pushNerve(PoiHanaNerves.trapped);
    }
    perform(cue: number) {
        super.perform(cue);
        // (unk1BC->THitActor::perform: nothing)
    }
    bind() {
        if (this.spine!.current === PoiHanaNerves.trapped && this.isAirborne() && this.vel.y > 0) {
            this.pos.add(this.vel);
            this.vel.y -= this.getGravityY();
            if (this.vel.y < velocityMinY) this.vel.y = velocityMinY;
            return;
        }
        super.bind();
    }
    /** isOnTrap: on a sand bomb base that has risen (its root joint's Y axis up) */
    isOnTrap() {
        const ga = this.groundPlane.actor as LiveActor | null;
        if (!ga) this.unk198 = this.groundHeight;
        else if (ga.isActorType(AT.SAND_BOMB_BASE00)) {
            const m = ga.mactor ? ga.mactor.anmMtx(0, ga.baseTR, ga.scale) : null;
            const m11 = m ? m[5] : ga.baseTR[5];
            if (m11 >= 0.1) {
                if (!this.mIsTrapped) {
                    this.unk1A8 = false;
                    if (this.groundHeight > this.unk198) { this.unk1A8 = true; this.headHeight = 350; }
                }
                return true;
            }
        }
        return false;
    }
    behaveToWater(_a: HitActor) {
        this.unk165 = true;
        const c = this.spine!.current;
        if (c === WalkerNerves.graphWander || c === WalkerNerves.attack || c === SmallEnemyNerves.jump) this.spine!.pushNerve(PoiHanaNerves.freeze);
    }
    attackToMario() {
        const c = this.spine!.current;
        if (c === PoiHanaNerves.sleep) { this.unk1A0 = true; this.unk194 = true; this.offLiveFlag(LF.UNK10); return; }
        if (c === WalkerNerves.attack) { this.spine!.pushNerve(PoiHanaNerves.throw); return; }
        if (c !== PoiHanaNerves.throw && c !== PoiHanaNerves.freeze) sendToMario(this.world, this, MSG.ATTACK);
    }
    setWalkAnm() { this.setBckAnm(BCK_WALK); }
    setWaitAnm() { this.setBckAnm(BCK_WAIT); }
    setRunAnm() { this.setBckAnm(BCK_DASH); }
    setFreezeAnm() { this.setBckAnm(BCK_WATERHIT); }
    setDeadAnm() {
        this.unk1BC!.kill();
        this.onHitFilter(HF.NO_COLLISION);
        this.hitPoints = 1;
        if (!this.unk184) this.unk18C = 3;
        this.setBckAnm(BCK_DEATH);
        // (particles: ms_poi_dead, and the jump / sand ones)
    }
    isHitValid(msg: number) {
        if (msg === MSG.UNKB) return true;
        if (this.spine!.current === PoiHanaNerves.freeze) { this.setBckAnm(BCK_HUMI); this.genRandomItem(); }
        return false;
    }
    isCollidMove(a: HitActor) {
        if (a.getHitCategory() === (HC.MAP_OBJECT | 0)) {
            if (isHideObj(a)) return false;
            if (a.isActorType(AT.CASINORULET) || a.isActorType(AT.WATERMELON)) return false;
            if (this.spine!.current === WalkerNerves.attack) {
                this.spine!.pushNerve(PoiHanaNerves.freeze);
                const v = this.posDelta.clone();
                v.x = fr(v.x * -2); v.y = fr(v.y * 5); v.z = fr(v.z * -2);
                this.vel.set(v);
                this.pos.y = fr(this.pos.y + 10);
                this.onLiveFlag(LF.AIRBORNE);
            }
            return true;
        }
        if (!(a as any).isAirborne?.() && !this.isAirborne()) return true;
        return false;
    }
    walkBehavior(kind: number, k: number) {
        super.walkBehavior(kind, k);
        if (mSleepVersion && kind === 0) {
            this.mGoToSleepTimer += 1;
            if (this.checkCurAnmEnd(ANM_BCK) && this.mGoToSleepTimer > this.unk19C.mSLWakeFrame + this.instanceIndex * 100) {
                this.mGoToSleepTimer = 0;
                this.mGoToSleepTimer = rangeI(-500, 500);
                this.spine!.setNext(PoiHanaNerves.sleep);
                this.unk195 = true;
            }
        }
    }
    isInhibitedForceMove() { return this.checkLiveFlag(LF.UNK10); }
    doKeepDistance() { return marioTouchGround4cm(this.world); }
    // calcRootMatrix: TSpineEnemy's (the rest is particles)
    generateItem() { if (this.unk195) this.unk195 = false; }
    getGravityY() {
        let g = super.getGravityY();
        if (this.spine && this.spine.current === PoiHanaNerves.trapped) g = this.unk19C.mSLTrapJumpGravity;
        return g;
    }
    resetHeadHeight() { this.headHeight = this.getSaveParam().mSLHeadHeight; }
    isMoving() { const c = this.spine!.current; return !(c === PoiHanaNerves.sleep || c === PoiHanaNerves.freeze); }
    /** genEventCoin: its coin flies away from Mario */
    genEventCoin() {
        if (!this.coin) return;
        // (a plain coin comes from gpItemManager->makeObjAppear(ACTOR_TYPE_COIN), else it's the coin itself)
        const c = this.world.makeCoinAppear(this.coin);
        if (!c) return;
        c.pos.set(this.pos);
        const v = V3.sub(this.pos, this.world.mario.pos);
        const l = v.length();
        if (l > 0) v.scale(1 / l);
        c.vel.set(fr(v.x * 10), 18, fr(v.z * 10));
        c.offLiveFlag(LF.UNK10);
        this.coin = null;
    }
    changeByJuice() { if (super.changeByJuice()) { this.unk1BC!.kill(); return true; } return false; }
}

export class PoiHanaRed extends PoiHana {
    constructor(w: World, name = 'ポイハナ赤') { super(w, name); }
    init(m: any) {
        super.init(m);
        // (unk1C0: its red TEV colour, the viewer's)
        this.unk1C8 = false;
    }
    attackToMario() {
        if (this.spine!.current === WalkerNerves.attack) sendToMario(this.world, this, MSG.ATTACK);
        super.attackToMario();
    }
}

export class SleepPoiHana extends PoiHana {
    constructor(w: World, name = '居眠りポイハナ') { super(w, name); }
    load(s: Stream) {
        this.unk1A0 = false;
        super.load(s);
    }
}

type S = Spine<PoiHana>;
const wakeToWander = (self: PoiHana, spine: S) => {
    self.mGoToSleepTimer = 0;
    spine.pushAfterCurrent(WalkerNerves.graphWander);
    self.offLiveFlag(LF.UNK10);
    return true;
};
export const PoiHanaNerves: Record<string, any> = {};
PoiHanaNerves.sleep = nerve<PoiHana>('TNervePoihanaSleep', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        if (!self.unk1C8) return wakeToWander(self, spine);
        self.setBckAnm(BCK_SLEEP_START);
        self.onLiveFlag(LF.AIRBORNE);
    }
    if (!self.unk1A0 && !self.isAirborne()) self.onLiveFlag(LF.UNK10);
    self.mGoToSleepTimer += 1;
    if ((self.unk194 || self.unsetUnk165()) && !self.isBckAnm(BCK_WAKEN)) {
        self.world.sound(SE.EN_KOHANA_WAKEUP3, self.pos);
        self.setBckAnm(BCK_WAKEN);
        self.mactor!.getFrameCtrl(ANM_BCK)!.frame = 148;
    }
    if (self.checkCurAnmEnd(ANM_BCK)) {
        if (self.isBckAnm(BCK_SLEEP_START)) self.setBckAnm(BCK_SLEEP);
        else if (self.isBckAnm(BCK_SLEEP)) {
            if (self.unk1A0 && self.mGoToSleepTimer > self.unk19C.mSLSleepFrame) self.setBckAnm(BCK_WAKEN);
        } else {
            if (self.isBckAnm(BCK_WAKEN)) return wakeToWander(self, spine);
            if (!self.unk1C8) return wakeToWander(self, spine);
            self.setBckAnm(BCK_SLEEP_START);
        }
    }
    return false;
});
PoiHanaNerves.freeze = nerve<PoiHana>('TNervePoihanaFreeze', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.setBckAnm(isSand(self.groundPlane.bgType) ? BCK_WATERHIT : BCK_WATERHIT2);
        self.unk1BC!.kill();
    }
    if (self.checkCurAnmEnd(ANM_BCK)) {
        if (self.isBckAnm(BCK_WATERHIT) || self.isBckAnm(BCK_HUMI)) { self.setBckAnm(BCK_KIZETSU); self.mIsTrapped = false; }
        else if (self.isBckAnm(BCK_KIZETSU)) self.setBckAnm(spine.time > self.getSaveParam().mSLFreezeWait ? BCK_GETUP : BCK_KIZETSU);
        else if (self.isBckAnm(BCK_GETUP) || self.isBckAnm(BCK_WATERHIT2)) { self.unk1BC!.offHitFilter(HF.NO_COLLISION); return true; }
    }
    return false;
});
PoiHanaNerves.throw = nerve<PoiHana>('TNervePoihanaThrow', (spine: S) => {
    const self = spine.body, a = self.mactor!;
    if (spine.time === 0) { self.setBckAnm(BCK_THROW); self.mThrowTimer = 1; }
    if (a.checkBckPass(4) && self.mThrowTimer > 0) a.setFrameRate(0, ANM_BCK);
    if (self.mThrowTimer > 0) {
        self.mThrowTimer += 1;
        if (self.mThrowTimer > 16) {
            sendToMario(self.world, self, MSG.THROWN);
            const back = self.unk19C.mSLBackThrowVal;
            const m = mtx();
            MsMtxSetRotRPH(m, self.rot.x, self.rot.y, self.rot.z);
            const v = mtxMultVec(m, new V3(0, 1, -back)).fround();
            const mario = self.world.mario as any;
            if (typeof mario.throwMario === 'function') mario.throwMario(v, self.unk19C.mSLThrowSpeed);   // SMS_ThrowMario
            self.mThrowTimer = 0;
            a.setFrameRate(ANM_FRAME_RATE, ANM_BCK);
            self.mThrowTimer = 0;
        }
    }
    // (mThrowTimer == 4: rumble and the mouth's ms_dmg_b / ms_m_amiattack particles)
    return self.checkCurAnmEnd(ANM_BCK);
});
PoiHanaNerves.trapped = nerve<PoiHana>('TNervePoihanaTrapped', (spine: S) => {
    const self = spine.body, P = self.unk19C;
    if (spine.time < 60) {
        if (!self.isAirborne() || spine.time < 2) {
            self.mIsTrapped = true;
            self.pos.y = fr(self.pos.y + 150);
            self.onLiveFlag(LF.AIRBORNE);
            if (self.unk1A8) {
                const ga = self.groundPlane.actor;
                const d = ga ? V3.sub(self.pos, ga.pos) : V3.sub(self.pos, self.world.mario.pos);
                d.fround();
                if (((d.x === d.y) ? 1 : 0) === d.z) d.x = 1;   // (the game's x == y == z)
                d.normalize().fround();
                d.x = fr(d.x * rangeF(P.mSLTrapJumpMinSpXZ, P.mSLTrapJumpMaxSpXZ));
                d.y = rangeF(P.mSLTrapJumpMinSpY, P.mSLTrapJumpMaxSpY);
                d.z = fr(d.z * rangeF(P.mSLTrapJumpMinSpXZ, P.mSLTrapJumpMaxSpXZ));
                self.vel.set(d);
                self.mCurrentFlungVelocity.set(d);
                self.setBckAnm(BCK_TRAPPED);
            } else self.setFreezeAnm();
        }
    } else if (!self.isAirborne()) {
        if (self.unk1A8) {
            if (!self.groundPlane.actor || !self.isOnTrap()) { spine.pushAfterCurrent(SmallEnemyNerves.die); return true; }
            self.mCurrentFlungVelocity.scale(0.7).fround();
            self.vel.set(self.mCurrentFlungVelocity);
            self.pos.y = fr(self.pos.y + 50);
            self.onLiveFlag(LF.AIRBORNE);
        } else {
            self.resetHeadHeight();
            spine.pushAfterCurrent(PoiHanaNerves.freeze);
            return true;
        }
    }
    return false;
});

/** TBGCheckData::isSand (BG_TYPE_SAND 0x701 and its shaded / no-camera-clip forms) */
function isSand(t: number) { return t === 0x701 || t === 0x4701 || t === 0x8701 || t === 0xC701; }

register('PoiHanaManager', (w, n) => new PoiHanaManager(w, n));
register('PoiHana', (w, n) => new PoiHana(w, n));
register('PoiHanaRed', (w, n) => new PoiHanaRed(w, n));
register('SleepPoiHana', (w, n) => new SleepPoiHana(w, n));
export type { LiveManager };
