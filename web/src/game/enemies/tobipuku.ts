// The flying Cheep Cheeps (TTobiPuku, Enemy/tobiPuku.cpp) and their launch pads, with the plain
// swimming ones (TPukuPuku) and the fire ones (TMoePuku). A pad (TTobiPukuLaunchPad) under the
// sea throws one up whenever the last is dead (mReturnLaunchSw): it rises 300 below its pad
// (TNerveTobiPukuGenerate), leaps along the pad's yaw and pitch (forceLaunch: unk1D0) under
// mSLFlyGravityY, bounces mSLBoundNum times on land and flops about until mSLLifeTimer
// (PitiPiti), or dives back into the sea, swims back to its pad and is launched again
// (ReturnLaunch, PrepareFly). Touching Mario in flight it bites and drops (Attack, Fall);
// sprayed it's knocked back (HitWater).
//
// Not here: the Yoshi juice change (changeOut / scalingChangeActor) and the particles.

import { fr, V3, MsSin, MsCos, MsClamp, MsWrap, MsGetRotFromZaxis, MsMtxSetXYZRPH, JMASSin, JMASCos, s16 } from '../math.js';
import { World, Stream, HitActor, LF, HF, MSG, ANM_BCK, CUE_MOVE, nerve, Spine, PathNode, SpineEnemy, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import type { WallCheck } from '../collision.js';
import { SmallEnemy, SmallEnemyManager, SmallEnemyNerves, smallParams } from './smallEnemy.js';
import { WalkerEnemy, walkerParams } from './walker.js';
import { msVecNormalize, force25 } from '../camera/lib.js';
import { frsqrte } from '../math.js';
import { marioAngleY } from '../mapobj/lib.js';

const TOBI_PARAMS = { mSLBoundNum: ['i', 3], mSLBoundVal: ['f', 0.8], mSLLifeTimer: ['i', 200], mSLFlyGravityY: ['f', 0.2], mSLPowerFromWater: ['f', 1] } satisfies PSchema;
const PAD_PARAMS = { mSLLaunchInterval: ['i', 300], mSLLaunchVelocityY: ['f', 12], mSLFlyDist: ['f', 1000], mSLFlySpeed: ['f', 30], mSLLaunchAngle: ['f', 45] } satisfies PSchema;

const vnorm = (v: V3) => msVecNormalize(v, v) as V3;
/** MsVECMag2 (the raw frsqrte estimate) */
function msVecMag2(v: V3) {
    const s = fr(fr(v.z * v.z + fr(v.x * v.x)) + fr(v.y * v.y));
    if (s <= 0) return 0;
    return fr(s * force25(frsqrte(s)));
}

// BCKs (/scene/pukupuku and /scene/moepuku, in the folders' order)
const BCK_ATTACK = 0, BCK_DEATH = 1, BCK_DOWN_AIR = 2, BCK_DOWN_LAND = 3, BCK_FALL = 4, BCK_FALL_END_LAND = 5, BCK_JUMP = 6,
    BCK_JUMP_START = 7, BCK_PITIPITI = 8, BCK_SWIM = 9;

// ---------------------------------------------------------------- managers
export class TobiPukuLaunchPadManager extends SmallEnemyManager {
    unk60 = 0;
    constructor(w: World, name = 'とびプク発射台マネージャー') { super(w, name); }
    load(s: Stream) {
        this.saveParams = smallParams('/enemy/tobipukulaunch.prm', this.world.files, PAD_PARAMS);
        super.load(s);
    }
    createEnemyInstance(): SpineEnemy | null { return new TobiPukuLaunchPad(this.world); }
    perform(cue: number) { const n = this.getActiveObjNum(); for (let i = 0; i < n; ++i) this.objs[i].perform(cue); }
}
export class MoePukuLaunchPadManager extends TobiPukuLaunchPadManager {
    constructor(w: World, name = 'モエプク発射台マネージャー') { super(w, name); }
    createEnemyInstance(): SpineEnemy | null { return new MoePukuLaunchPad(this.world); }
}
export class TobiPukuManager extends SmallEnemyManager {
    constructor(w: World, name = 'とびプクマネージャー') { super(w, name); }
    load(s: Stream) {
        this.saveParams = walkerParams('/enemy/tobipuku.prm', this.world.files, TOBI_PARAMS);
        super.load(s);
    }
    createEnemyInstance(): SpineEnemy | null { return new TobiPuku(this.world); }
}
export class MoePukuManager extends TobiPukuManager {
    constructor(w: World, name = 'モエプクマネージャー') { super(w, name); }
    createEnemyInstance(): SpineEnemy | null { return new MoePuku(this.world); }
}

// ---------------------------------------------------------------- the pads
export class TobiPukuLaunchPad extends SmallEnemy {
    /** unk194 frames since the last launch, unk19C its launch power, unk1A8 the last it launched */
    unk194 = 0; unk19C = 0; unk1A8: TobiPuku | null = null;
    protected managerName = 'とびプクマネージャー';
    get PP(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'とびプク発射台') { super(w, name); }
    perform(cue: number) {
        if (this.checkLiveFlag(LF.UNK200) || this.checkLiveFlag(LF.DEAD) || !(cue & CUE_MOVE)) return;
        if (TobiPuku.mReturnLaunchSw) {
            if (!this.unk1A8 || this.unk1A8.checkLiveFlag(LF.DEAD)) this.launch();
        } else if (++this.unk194 > this.PP.mSLLaunchInterval) { this.unk194 = 0; this.launch(); }
    }
    init(m: any) { super.init(m); this.actorType = AT.PUKU_PUKU; }
    load(s: Stream) {
        super.load(s);
        this.unk19C = s.s32();
        this.reset();
    }
    reset() { super.reset(); this.unk194 = 0; this.unk1A8 = null; }
    launch() {
        const p = this.world.conductor.makeOneEnemyAppear(this.pos, this.managerName, 1) as TobiPuku | null;
        if (p) { this.forceLaunch(p); this.unk1A8 = p; }
    }
    forceLaunch(p: TobiPuku) {
        const pos = this.pos.clone();
        const yaw = s16(Math.trunc(fr(fr(this.rot.y * 16384) / 90)));
        const sy = JMASSin(yaw), cy = JMASCos(yaw);
        let v: V3;
        if ((this.manager as TobiPukuLaunchPadManager).unk60) {
            const d = this.PP.mSLFlyDist;
            pos.x = fr(pos.x + fr(sy * d)); pos.z = fr(pos.z + fr(cy * d));
            v = this.calcVelocityToJumpToY(pos, this.PP.mSLLaunchVelocityY, p.T.mSLFlyGravityY);
        } else {
            const dir = new V3(fr(sy * this.unk19C), this.unk19C, fr(cy * this.unk19C));
            const pitch = s16(Math.trunc(fr(fr(this.rot.x * 16384) / 90)));
            const cx = JMASCos(pitch);
            v = new V3(fr(dir.x * cx), fr(dir.y * JMASSin(pitch)), fr(dir.z * cx));
        }
        p.reset();
        p.pos.set(this.pos); p.rot.set(this.rot);
        p.unk1D0.set(v);
        p.unk1B0 = this.pos.y;
        p.unk1DC = this;
        p.unk1B4 = MsGetRotFromZaxis(this.vel.clone()).x;
    }
}
export class MoePukuLaunchPad extends TobiPukuLaunchPad {
    protected managerName = 'モエプクマネージャー';
    constructor(w: World, name = 'モエプク発射台') { super(w, name); }
}

// ---------------------------------------------------------------- TTobiPuku
export class TobiPuku extends WalkerEnemy {
    static mLandAngle = 90; static mBoundSw = true; static mBoundVelocityY = fr(0.8); static mReturnLaunchSw = true;
    /** unk194 flying (its gravity), unk198 bounces, unk1A0 its effects' place, unk1AC (0: a TPukuPuku), unk1AD dies on land, unk1AE bouncing */
    unk194 = 0; unk198 = 0; unk1A0 = new V3(); unk1AC = 1; unk1AD = 1; unk1AE = 0;
    /** unk1B0 the height it was launched from (its bounce), unk1B4 the launch pitch */
    unk1B0 = 0; unk1B4 = 0; unk1B8 = [new V3(), new V3()];
    /** unk1D0 its launch velocity, unk1DC its pad, unk1E0 its swimming height, unk1E4 its last vertical speed, unk1E8 its pitch's turn, unk1EC its roll (joint 1), unk1F0 */
    unk1D0 = new V3(); unk1DC: TobiPukuLaunchPad | null = null; unk1E0 = 0; unk1E4 = 0; unk1E8 = 0; unk1EC = 0; unk1F0 = 0;
    get T(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'とびプク') { super(w, name); }
    init(m: any) {
        super.init(m);
        this.actorType = AT.PUKU_PUKU;
        this.unk150 = 0x31;
        // (TobiPukuRollCallback on joint 1: the roll unk1EC while it swims home; drawing only)
    }
    reset() {
        super.reset();
        this.spine!.initWith(TobiNerves.generate);
        this.unk1AD = 1; this.unk194 = 0;
        this.unk1B8[1].set(this.pos); this.unk1B8[0].set(this.pos);
        this.unk1E0 = this.pos.y;
    }
    isInhibitedForceMove() { return this.checkLiveFlag(LF.AIRBORNE); }
    moveObject() {
        this.turnSpeed = this.T.mSLTurnSpeedLow;
        if (TobiPuku.mBoundSw && TobiPuku.prototype.isInhibitedForceMove.call(this)) this.hitWall();
        super.moveObject();
    }
    hitWall() {
        const r: WallCheck = { center: [this.pos.x, fr(this.pos.y + this.headHeight), this.pos.z], radius: fr(1.1 * fr(this.bodyScale * this.wallRadius)), maxResults: 1, flags: 0, results: [] };
        if (this.world.isTouchedWallsAndMoveXZ(r)) {
            const n = r.results[0].n;
            const dot = fr(fr(fr(this.vel.x * n[0]) + fr(this.vel.y * n[1])) + fr(this.vel.z * n[2]));
            const b = fr(-fr(2 * dot));
            this.vel.x = fr(this.vel.x + fr(b * n[0]));
            this.vel.y = fr(this.vel.y * 0.5);
            this.vel.z = fr(this.vel.z + fr(b * n[2]));
            this.unk1D0.set(this.vel);
            this.unk1B0 = this.pos.y;
        } else {
            const [, roof] = this.world.col.checkRoof(this.pos.x, fr(this.pos.y + this.headHeight), this.pos.z, 0);
            if (roof && roof.actor && this.vel.y > 0) this.vel.y = 0;
        }
    }
    bound() {
        this.unk1AE = 1;
        if (this.unk198 < this.T.mSLBoundNum) {
            this.unk198++;
            const k = this.T.mSLBoundVal;
            const v = this.unk1D0.clone();
            v.x = fr(v.x * k); v.z = fr(v.z * k);
            v.y = fr(fr(fr(fr(TobiPuku.mBoundVelocityY * k) * fr(this.unk1B0 - this.groundHeight))) / 30);
            this.unk1D0.set(v); this.vel.set(v);
            this.onLiveFlag(LF.AIRBORNE);
        }
    }
    calcRootMatrix() {
        super.calcRootMatrix();
        if (this.rot.x !== 0) {
            if (this.isEaten()) return;
            MsMtxSetXYZRPH(this.baseTR, this.pos.x, fr(this.pos.y + fr(fr(70 * this.rot.x) / TobiPuku.mLandAngle)), this.pos.z, this.rot.x, this.rot.y, this.rot.z);
        }
        if (this.isPichiEffect()) this.world.effect('ms_puku_pichi', this.pos);
    }
    isPichiEffect() { return this.isBckAnm(BCK_PITIPITI); }
    isJumpBck() { return this.isBckAnm(BCK_JUMP); }
    isDeadBck() { return this.isBckAnm(BCK_DEATH); }
    isAttackBck() { return this.isBckAnm(BCK_ATTACK); }
    isFallEndLandBck() { return this.isBckAnm(BCK_FALL_END_LAND); }
    isJumpStartBck() { return this.isBckAnm(BCK_JUMP_START); }
    setJumpAnm() { this.setBckAnm(BCK_JUMP); }
    setSwimAnm() { this.setBckAnm(BCK_SWIM); }
    setAttackAnm() { this.setBckAnm(BCK_ATTACK); }
    setPichiAnm() { this.setBckAnm(BCK_PITIPITI); }
    setFallAnm() { this.setBckAnm(BCK_FALL); }
    setDownAirAnm() { this.setBckAnm(BCK_DOWN_AIR); }
    setDownLandAnm() { this.setBckAnm(BCK_DOWN_LAND); }
    setDeadAnm() { this.setBckAnm(BCK_DEATH); }
    setFallEndLandAnm() { this.setBckAnm(BCK_FALL_END_LAND); }
    /** (only when it's already playing: the game's) */
    setJumpStartAnm() { if (this.isBckAnm(BCK_JUMP_START)) this.setBckAnm(BCK_JUMP_START); }
    canBound() { if (this.unk198 < this.T.mSLBoundNum) return true; this.unk1AE = 0; return false; }
    isRoll() { const c = this.spine!.current; return c === TobiNerves.land || c === TobiNerves.prepareFly || c === TobiNerves.returnLaunch; }
    behaveToWater(_a: HitActor) {
        if (this.spine!.current !== TobiNerves.hitWater) { this.world.sound(SE.EN_COMMON_FLY, this.pos); this.spine!.pushNerve(TobiNerves.hitWater); }
    }
    walkBehavior(kind: number, k: number) {
        super.walkBehavior(kind, k);
        const prevY = this.pos.y;
        this.pos.y = fr(this.unk1E0 + fr(10 * MsSin(fr(2 * this.spine!.time))));
        const v = this.posDelta.clone(); v.y = fr(prevY - this.pos.y);
        this.rot.x = MsGetRotFromZaxis(v).x;
    }
    swimEffect() { if (!this.checkLiveFlag(LF.CLIPPED_OUT)) this.world.effect('ms_puku_awa', this.pos); }
    isReachedToGoalXZ() {
        const t = V3.sub(this.goal104.point(), this.pos); t.y = 0;
        if (t.x === 0 && t.z === 0) return true;
        return msVecMag2(t) < 200;
    }
    generateEffectColumWater() {
        if (this.checkLiveFlag(LF.CLIPPED_OUT)) return;
        const e = this.world.conductor.makeOneEnemyAppear(this.pos, 'エフェクト水柱マネージャー', 0) as any;
        if (e && e.generate) e.generate(this.pos, this.scale);
        this.world.sound(this.spine!.current !== TobiNerves.generate ? SE.EN_TOBIPUKU_TOWATER : SE.EN_TOBIPUKU_FRWATER, this.pos);
    }
    attackToMario() {
        const m = this.world.mario;
        m.receiveMessage(this, MSG.ATTACK);
        if (this.spine!.current !== TobiNerves.attack && !this.unk1AE && !m.checkFlag(0x20000)) {
            this.unk1D0.set(0, 0, 0);
            this.spine!.pushNerve(TobiNerves.attack);
        }
    }
    getGravityY() { return this.unk194 ? this.T.mSLFlyGravityY : this.gravity; }
    flyStart() {
        this.unk198 = 0; this.unk194 = 1;
        this.vel.set(this.unk1D0);
        this.unk1B4 = MsGetRotFromZaxis(this.unk1D0.clone()).x;
        this.generateEffectColumWater();
        this.onLiveFlag(LF.AIRBORNE);
        this.offLiveFlag(LF.UNK10);
    }
    fallStart() {
        this.unk194 = 0;
        this.vel.set(0, this.vel.y, 0);
        this.pos.y = fr(this.pos.y + 2);
        this.onLiveFlag(LF.AIRBORNE);
    }
    hitWater() {
        const m = this.world.mario.pos;
        const d = new V3(fr(this.pos.x - m.x), fr(this.pos.y - m.y), fr(this.pos.z - m.z));
        if (d.x === 0 && d.y === 0 && d.z === 0) d.x += 1;
        vnorm(d);
        const k = this.T.mSLPowerFromWater;
        const v = new V3(fr(d.x * k), fr(2 * fr(d.y * k)), fr(d.z * k));
        this.vel.set(v); this.unk1D0.set(v);
        this.unk1B0 = this.pos.y;
        this.rot.y = fr(180 - fr(fr(0.005493164) * marioAngleY(this.world)));
    }
    kill() {
        if (this.checkLiveFlag(LF.DEAD) || this.groundPlane.isIllegal()) return;
        this.hitPoints = 1;
        if (this.spine!.current === TobiNerves.die && this.unk1AD) return;
        this.unk1AD = 1;
        this.spine!.reset();
        this.spine!.setNext(TobiNerves.die);
        this.spine!.pushAfterCurrent(this.spine!.default);
    }
    /** (nothing follows its guard in the game) */
    forceKill() { }
    genEventCoin() { }
    initAttacker(a: HitActor) { this.rot.set(a.rot); this.spine!.pushNerve(TobiNerves.fly); this.unk184 = 1; }
}

export class PukuPuku extends TobiPuku {
    constructor(w: World, name = 'プクプク') { super(w, name); }
    load(s: Stream) { SmallEnemy.prototype.load.call(this, s); this.reset(); this.unk1AC = 0; }
    init(m: any) {
        WalkerEnemy.prototype.init.call(this, m);
        this.actorType = AT.PUKU_PUKU;
        this.unk150 = 0x31;
        this.spine!.initWith(TobiNerves.swimWander);
    }
    reset() { super.reset(); this.spine!.initWith(TobiNerves.swimWander); }
}

export class MoePuku extends TobiPuku {
    constructor(w: World, name = 'モエプク') { super(w, name); }
    calcRootMatrix() {
        super.calcRootMatrix();
        if (this.spine!.current === TobiNerves.fly) { this.world.sound(SE.EN_MOEKURI_FLAME, this.pos); this.world.effect('ms_mpk_fire', this.pos); }
    }
    hitWater() {
        super.hitWater();
        this.world.effect('ms_moe_fire_off', this.pos);
        this.world.sound(SE.BS_WANWAN_TO_COOL, this.pos);
    }
    generateEffectColumWater() {
        if (this.checkLiveFlag(LF.CLIPPED_OUT)) return;
        const e = this.world.conductor.makeOneEnemyAppear(this.pos, 'エフェクト水柱マネージャー', 0) as any;
        if (e && e.generate) e.generate(this.pos, this.scale);
        this.world.sound(this.spine!.current !== TobiNerves.generate ? SE.EN_MOEPUKU_TOWATER : SE.EN_PAKKUN_SHOOT_IMI, this.pos);
        this.world.effect('ms_m_tobikomi_c', this.pos, this.scale);
    }
    swimEffect() { }
}

// ---------------------------------------------------------------- nerves
type S = Spine<TobiPuku>;
export const TobiNerves: Record<string, any> = {};
TobiNerves.generate = nerve<TobiPuku>('TNerveTobiPukuGenerate', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.onLiveFlag(LF.UNK10);
        self.pos.y = fr(self.pos.y - 300);
        self.rot.x = MsGetRotFromZaxis(self.vel.clone()).x;
        self.setJumpAnm();
    }
    self.pos.y = fr(self.pos.y + self.unk1D0.y);
    if (self.pos.y > self.unk1B0) { self.flyStart(); spine.pushAfterCurrent(TobiNerves.fly); return true; }
    return false;
});
TobiNerves.fly = nerve<TobiPuku>('TNerveTobiPukuFly', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.setJumpStartAnm(); self.offLiveFlag(LF.UNK10); }
    if (self.checkCurAnmEnd(ANM_BCK) && self.isJumpStartBck()) self.setJumpAnm();
    if (!self.isAirborne()) { spine.pushAfterCurrent(TobiNerves.land); return true; }
    self.unk1E4 = self.vel.y;
    self.rot.x = MsGetRotFromZaxis(self.vel.clone()).x;
    return false;
});
TobiNerves.attack = nerve<TobiPuku>('TNerveTobiPukuAttack', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setAttackAnm();
    if (!self.isAirborne()) return true;
    if (self.getCurAnmFrameNo(ANM_BCK) >= 6) self.fallStart();
    if (self.checkCurAnmEnd(ANM_BCK)) { spine.pushAfterCurrent(TobiNerves.fall); return true; }
    return false;
});
TobiNerves.hitWater = nerve<TobiPuku>('TNerveTobiPukuHitWater', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        if (self.isAirborne()) { if (fr(self.pos.y - self.groundHeight) > 50) { self.setAttackAnm(); self.hitWater(); } }
        else if (self.unk1AE) self.setPichiAnm();
    }
    if (!self.isAirborne()) {
        const m = self.world.mario.pos;
        const d = new V3(fr(self.pos.x - m.x), 0, fr(self.pos.z - m.z));
        if (d.x === 0 && d.y === 0 && d.z === 0) d.x += 1;
        vnorm(d);
        d.y = 5; d.x = fr(d.x * 5); d.z = fr(d.z * 5);
        self.vel.set(d);
        self.onLiveFlag(LF.AIRBORNE);
        self.pos.y = fr(self.pos.y + 5);
    }
    if (self.checkCurAnmEnd(ANM_BCK)) { if (self.isAttackBck()) spine.pushAfterCurrent(TobiNerves.fall); return true; }
    return false;
});
TobiNerves.fall = nerve<TobiPuku>('TNerveTobiPukuFall', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.rot.x = 0; self.setFallAnm(); }
    if (!self.isAirborne()) {
        spine.pushAfterCurrent(TobiNerves.die);
        if (self.groundPlane.isWaterSurface()) self.generateEffectColumWater();
        self.onLiveFlag(LF.UNK20000);
        return true;
    }
    return false;
});
TobiNerves.pitiPiti = nerve<TobiPuku>('TNerveTobiPukuPitiPiti', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setPichiAnm();
    if (self.checkCurAnmEnd(ANM_BCK) && spine.time > self.T.mSLLifeTimer) { self.unk1AD = 0; spine.pushAfterCurrent(TobiNerves.die); return true; }
    return false;
});
TobiNerves.die = nerve<TobiPuku>('TNerveTobiPukuDie', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        if (self.isAirborne()) { self.onHitFilter(HF.NO_COLLISION); self.vel.set(0, self.vel.y, 0); self.setDownAirAnm(); }
        else if (self.unk1AD) { self.onHitFilter(HF.NO_COLLISION); self.setDownLandAnm(); }
        else { self.onLiveFlag(LF.UNK20000); self.setDeadAnm(); }
    }
    if (self.checkCurAnmEnd(ANM_BCK)) {
        self.onLiveFlag(LF.DEAD); self.onLiveFlag(LF.UNK8);
        self.offLiveFlag(LF.HIDDEN); self.offLiveFlag(LF.UNK10000);
        self.holder = null;
        spine.reset();
        spine.setNext(SmallEnemyNerves.die);
        spine.pushAfterCurrent(spine.default);
        self.onHitFilter(HF.NO_COLLISION);
        self.genRandomItem();
        return true;
    }
    return false;
});
TobiNerves.land = nerve<TobiPuku>('TNerveTobiPukuLand', (spine: S) => {
    const self = spine.body, t = spine.time;
    if (t < 2) {
        if (self.groundPlane.isWaterSurface()) {
            self.pos.y = fr(self.pos.y - 10);
            self.onLiveFlag(LF.UNK10);
            self.generateEffectColumWater();
            if (TobiPuku.mReturnLaunchSw) {
                self.unk1E4 = fr(self.unk1E4 * fr(0.8));
                self.unk1E8 = fr(fr(180 - self.rot.x) / Math.abs(fr(600 / self.unk1E4)));
            }
        } else {
            if (TobiPuku.mBoundSw && self.canBound()) { spine.pushAfterCurrent(TobiNerves.bound); return true; }
            self.unk1B8[0].set(self.pos);
            self.setFallEndLandAnm();
            self.rot.x = 0;
        }
    } else if (self.isFallEndLandBck()) {
        if (t === 1) self.unk1B8[1].set(fr(self.pos.x - self.unk1B8[0].x), fr(self.pos.y - self.unk1B8[0].y), fr(self.pos.z - self.unk1B8[0].z));
        if (t < 20) {
            const r = fr(0.05 * t);
            self.pos.set(self.unk1B8[0]);
            self.pos.x = fr(self.pos.x + fr(self.unk1B8[1].x * r));
            self.pos.y = fr(self.pos.y + fr(self.unk1B8[1].y * r));
            self.pos.z = fr(self.pos.z + fr(self.unk1B8[1].z * r));
        }
        if (self.checkCurAnmEnd(ANM_BCK)) { spine.pushAfterCurrent(TobiNerves.pitiPiti); return true; }
    } else if (TobiPuku.mReturnLaunchSw) {
        const dy = fr(self.unk1E0 - self.pos.y);
        // (unk1D0's y halved into the x: the game's)
        self.unk1D0.y = fr(self.unk1D0.y * 0.5);
        self.unk1D0.z = fr(self.unk1D0.z * 0.5);
        const v = new V3(self.unk1D0.y, 0, self.unk1D0.z);
        self.rot.x = MsClamp(fr(self.rot.x + self.unk1E8), 0, 180);
        const c = MsCos(self.rot.x);
        v.x = fr(v.x * c); v.z = fr(v.z * c);
        v.y = self.unk1E4;
        self.pos.x = fr(self.pos.x + v.x); self.pos.y = fr(self.pos.y + v.y); self.pos.z = fr(self.pos.z + v.z);
        if (Math.abs(dy) > 120) self.unk1EC = MsClamp(fr(self.unk1EC + 3), 0, 180);
        if (Math.abs(dy) > 600) { spine.pushAfterCurrent(TobiNerves.returnLaunch); return true; }
    } else {
        self.pos.y = fr(self.pos.y - 12);
        if (self.isJumpBck() && self.rot.x < TobiPuku.mLandAngle) self.rot.x = fr(self.rot.x + fr(1.2));
        if (t > 100) { self.onLiveFlag(LF.DEAD); return true; }
    }
    return false;
});
TobiNerves.bound = nerve<TobiPuku>('TNerveTobiPukuBound', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.bound();
    if (self.vel.y > 0) self.unk1B0 = self.pos.y;
    if (!self.isAirborne()) { spine.pushAfterCurrent(TobiNerves.land); return true; }
    return false;
});
TobiNerves.prepareFly = nerve<TobiPuku>('TNerveTobiPukuPrepareFly', (spine: S) => {
    const self = spine.body, pad = self.unk1DC!;
    if (spine.time === 0) self.unk1F0 = fr(fr(MsWrap(self.unk1B4, 0, 360) - self.rot.x) / 60);
    const k = fr(0.016666668);
    self.pos.x = fr(self.pos.x + fr(k * fr(pad.pos.x - self.pos.x)));
    self.pos.y = fr(self.pos.y + fr(k * fr(pad.pos.y - self.pos.y)));
    self.pos.z = fr(self.pos.z + fr(k * fr(pad.pos.z - self.pos.z)));
    self.unk1EC = MsClamp(fr(self.unk1EC - 3), 0, 180);
    self.rot.x = fr(self.rot.x + self.unk1F0);
    if (spine.time === 50) self.setJumpStartAnm();
    if (spine.time > 60) { pad.forceLaunch(self); self.reset(); }
    return false;
});
TobiNerves.returnLaunch = nerve<TobiPuku>('TNerveTobiPukuReturnLaunch', (spine: S) => {
    const self = spine.body, pad = self.unk1DC!;
    if (spine.time === 0) {
        self.setGoalPath(new PathNode(null, pad.pos.clone()));
        self.setSwimAnm();
        self.unk1E0 = self.pos.y;
    }
    self.swimEffect();
    if (self.isReachedToGoalXZ()) { spine.pushAfterCurrent(TobiNerves.prepareFly); return true; }
    const d = V3.sub(pad.pos, self.pos); d.y = 0;
    vnorm(d);
    self.unk1D0.x = fr(self.unk1D0.x * fr(0.99)); self.unk1D0.z = fr(self.unk1D0.z * fr(0.99));
    self.pos.x = fr(self.pos.x + fr(fr(d.x * self.marchSpeed) - self.unk1D0.x));
    self.pos.z = fr(self.pos.z + fr(fr(d.z * self.marchSpeed) - self.unk1D0.z));
    self.unk1EC = MsClamp(fr(self.unk1EC + 1), 0, 180);
    return false;
});
TobiNerves.swimWander = nerve<TobiPuku>('TNerveTobiPukuSwimWander', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.unk1E0 = self.pos.y; self.setSwimAnm(); self.initialGraphNode(); self.onLiveFlag(LF.UNK10); }
    if (self.isReachedToGoalXZ()) self.goToRandomNextGraphNode();
    self.walkBehavior(0, 1.5);
    return false;
});

register('TobiPukuLaunchPadManager', (w, n) => new TobiPukuLaunchPadManager(w, n));
register('TobiPukuLaunchPad', (w, n) => new TobiPukuLaunchPad(w, n));
register('MoePukuLaunchPadManager', (w, n) => new MoePukuLaunchPadManager(w, n));
register('MoePukuLaunchPad', (w, n) => new MoePukuLaunchPad(w, n));
register('TobiPukuManager', (w, n) => new TobiPukuManager(w, n));
register('MoePukuManager', (w, n) => new MoePukuManager(w, n));
register('PukuPuku', (w, n) => new PukuPuku(w, n));
register('MoePuku', (w, n) => new MoePuku(w, n));
