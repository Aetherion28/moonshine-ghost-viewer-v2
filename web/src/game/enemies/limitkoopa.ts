// The cut-down Bowser and Bowser Jr. of Enemy/limitkoopa.cpp and Enemy/limitkoopajr.cpp:
// TLimitKoopa (クッパ, LimitKoopa in scene.bin) with his manager (TLimitKoopaManager,
// /enemy/limitkoopa.prm: rotationSpeed, bodyScale and the hip drop's speed and gravity always
// set by its constructor) and his hit volumes (TLimitKoopaParts: body, head, hands, flames); and
// TLimitKoopaJr (リミットクッパジュニア) with his manager (/enemy/limitkoopajr.prm, mostly set by
// its constructor too).
//
// Bowser uses the bathtub Bowser's model and animations (KOOPA_ANM_*, enemies/koopa.ts) but
// stands on a fixed floor (height 3500, no map collision): he turns toward Mario
// (TNerveLimitKoopaWait, rotationSpeed degrees a tick, 240 ticks at least), crouches for 30 ticks
// (TNerveLimitKoopaHipDropStart) and leaps at the spot under Mario (TNerveLimitKoopaHipDropJump:
// at most 200 a tick, under hipDropGravityY) until he lands, then turns again. Spraying his head
// makes him flinch (TNerveLimitKoopaGetShowered). While breathing fire (no linked code starts it)
// the flames line up in front of his head. His neck callback does nothing.
//
// Bowser Jr. circles a point (the bathtub's position, バスタブ) at mSLRoundRadius and
// mSLRoundHeight, keeping to the side away from Mario (TNerveLimitKoopaJrRun) until he's within
// 36 degrees of it, then faces Mario (TNerveLimitKoopaJrWait), cheers when Mario jumps
// (TNerveLimitKoopaJrYahoo) and every mSLShotDoodlePeriod plays his shooting animation
// (TNerveLimitKoopaJrLaunch: nothing is fired).
//
// The UNUSED nerves and functions whose bodies nothing linked shows (TNerveLimitKoopaFall,
// TNerveLimitKoopaFlame, the turn nerves, breathFlame, getFlameDir...) are left empty as the
// decomp has them.
//
// Not here: the fire particles (told to the viewer as an effect), the BCK motion blend, the
// animation sounds and Bowser Jr.'s light type.

import { fr, V3, Quat } from '../math.js';
import { World, Stream, HitActor, LiveActor, LiveManager, SpineEnemy, EnemyManager, LF, HF, HC, MSG, ANM_BCK, CUE_MOVE, CUE_CALC_ANIM, nerve, Spine, readParams, SPINE_PARAMS, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import type { mat4 } from 'gl-matrix';
import { marioStatus } from '../mapobj/lib.js';
import { KOOPA_ANM_DOWN, KOOPA_ANM_DOWN_LOOP, KOOPA_ANM_FIRE_END, KOOPA_ANM_FIRE_LOOP, KOOPA_ANM_FIRE_START, KOOPA_ANM_GETUP, KOOPA_ANM_HIPDROP, KOOPA_ANM_STAGGER, KOOPA_ANM_TURN_L, KOOPA_ANM_WAIT, KOOPA_ANM_WATERHIT, jnorm } from './koopa.js';
import { DirectionCalc } from './koopajr.js';

// ---------------------------------------------------------------- params
const LIMIT_KOOPA_PARAMS = {
    ...SPINE_PARAMS,
    rotationSpeed: ['f', 1], bodyScale: ['f', 1], hipDropInitialSpeedY: ['f', 1], hipDropGravityY: ['f', 1], turnSpeed: ['f', 1.6], turnAnim: ['f', 3.7],
    waitStep: ['f', 600], attackRadius: ['f', 800], attackHeight: ['f', 1000], focusRange: ['f', 2], waitRange: ['f', 12], fireSpeed: ['f', 4],
    tumbleSpeed: ['f', 2], waitSpeed: ['f', 2], staggerSpeed: ['f', 2], downSpeed: ['f', 1.8], tumbleWeight: ['f', 4.2], flameScale: ['f', 1],
    flameCount: ['i', 300], flameFocusStartStep: ['i', 100], flameFocusEndStep: ['i', 300], flameRadius: ['f', 200], flameHeight: ['f', 600],
    headRadius: ['f', 400], waterhitSpeed: ['f', 2], flameOverStart: ['f', 0.9], flameNeckRange: ['f', 16], flameNeckDownRate: ['f', 0.3],
    marioEstimationFire: ['f', 20], marioEstimationWait: ['f', 10],
} satisfies PSchema;
type LimitKoopaParams = { [K in keyof typeof LIMIT_KOOPA_PARAMS]: number };

const LIMIT_KOOPA_JR_PARAMS = {
    ...SPINE_PARAMS,
    mSLAcceleration: ['f', 1], mSLRotationSpeed: ['f', 1], mSLSpeedMax: ['f', 8], mSLRoundAngleVelocity: ['f', 0.05], mSLRoundRadius: ['f', 2000],
    mSLRoundHeight: ['f', 0], mSLDamageRadius: ['f', 1000], mSLDamageHeight: ['f', 4000], mSLKoopaJrScale: ['f', 1.6], mSLShotDoodlePeriod: ['i', 1200],
    mSLDamagePeriod: ['i', 360],
} satisfies PSchema;
type LimitKoopaJrParams = { [K in keyof typeof LIMIT_KOOPA_JR_PARAMS]: number };

const trans = (m: mat4 | null, out = new V3()) => (m ? out.set(fr(m[12]), fr(m[13]), fr(m[14])) : out);
/** gpMarioPos (a copy) */
const marioPos = (w: World) => w.mario.pos.clone();

// ---------------------------------------------------------------- nerves
type S = Spine<LimitKoopa>;
export const LimitKoopaNerves: Record<string, any> = {};
const N = LimitKoopaNerves;
N.hipDropJump = nerve<LimitKoopa>('TNerveLimitKoopaHipDropJump', (spine: S) => {
    const k = spine.body;
    k.moveHipDrop();
    if (k.mOnGround) { spine.pushAfterCurrent(N.wait); return true; }
    return false;
});
N.hipDropStart = nerve<LimitKoopa>('TNerveLimitKoopaHipDropStart', (spine: S) => {
    const k = spine.body;
    if (spine.time === 0) { k.changeBck(KOOPA_ANM_FIRE_START, 2); k.mTimers[1] = 30; }
    if (k.mTimers[1] <= 0) { k.startHipDrop(); k.mOnGround = false; spine.pushAfterCurrent(N.hipDropJump); return true; }
    return false;
});
N.fall = nerve<LimitKoopa>('TNerveLimitKoopaFall', () => false);   // (TODO: UNUSED, its body unknown)
N.flame = nerve<LimitKoopa>('TNerveLimitKoopaFlame', () => false);   // (TODO: UNUSED, its body unknown)
N.tumble = nerve<LimitKoopa>('TNerveLimitKoopaTumble', (spine: S) => { const k = spine.body; k.changeBck(KOOPA_ANM_HIPDROP, k.getParam().tumbleSpeed); return k.endsAnm(); });
N.wait = nerve<LimitKoopa>('TNerveLimitKoopaWait', (spine: S) => {
    const k = spine.body;
    if (spine.time === 0) { k.changeBck(KOOPA_ANM_TURN_L, 2); k.mTimers[0] = 240; }
    k.moveTurn();
    if (k.finishedTurn() && k.mactor!.isCurAnmAlreadyEnd(ANM_BCK)) { spine.pushAfterCurrent(N.hipDropStart); return true; }
    return false;
});
N.turnR = nerve<LimitKoopa>('TNerveLimitKoopaTurnR', () => false);   // (TODO: their bodies unknown)
N.getDown = nerve<LimitKoopa>('TNerveLimitKoopaGetDown', (spine: S) => {
    const k = spine.body, P = k.getParam();
    switch (k.getAnmIndex()) {
        case KOOPA_ANM_DOWN: if (k.endsAnm()) k.changeBck(KOOPA_ANM_DOWN_LOOP, P.downSpeed); break;
        case KOOPA_ANM_DOWN_LOOP: if (k.endsAnm()) k.changeBck(KOOPA_ANM_GETUP, P.downSpeed); break;
        case KOOPA_ANM_GETUP: if (k.endsAnm()) return true; break;
        default: k.changeBck(KOOPA_ANM_DOWN, P.downSpeed); break;
    }
    return false;
});
N.stagger = nerve<LimitKoopa>('TNerveLimitKoopaStagger', (spine: S) => { const k = spine.body; k.changeBck(KOOPA_ANM_STAGGER, k.getParam().staggerSpeed); return k.endsAnm(); });
N.turnL = nerve<LimitKoopa>('TNerveLimitKoopaTurnL', () => false);
N.getShowered = nerve<LimitKoopa>('TNerveLimitKoopaGetShowered', (spine: S) => { const k = spine.body; k.changeBck(KOOPA_ANM_WATERHIT, k.getParam().waterhitSpeed); return k.endsAnm(); });

// ---------------------------------------------------------------- the hit volumes
/** TLimitKoopaParts: one of his hit volumes, in the enemy group, performed by him. */
export abstract class LimitKoopaParts extends LiveActor {
    constructor(name: string, type: number, public mKoopa: LimitKoopa, radius: number) {
        super(mKoopa.world, name);
        mKoopa.world.addToGroup('敵グループ', this);
        this.initHitActor(type, 5, HC.PLAYER, radius, radius, radius, radius);
        this.onHitFilter(HF.NO_ATTACK); this.onHitFilter(HF.NO_DAMAGE); this.onHitFilter(HF.NO_COLLISION);
    }
    perform(cue: number) {
        super.perform(cue);
        if (cue & CUE_MOVE) for (const c of this.collisions.slice()) this.attack_(c);
    }
    abstract attack_(a: HitActor): void;
    set(p: V3, r: number, h: number) {
        this.pos.set(p);
        this.offHitFilter(HF.NO_ATTACK); this.offHitFilter(HF.NO_DAMAGE); this.offHitFilter(HF.NO_COLLISION);
        this.setHitParams(r, h, r, h);
    }
    remove() { this.onHitFilter(HF.NO_ATTACK); this.onHitFilter(HF.NO_DAMAGE); this.onHitFilter(HF.NO_COLLISION); }
}
export class LimitKoopaFlame extends LimitKoopaParts {
    constructor(k: LimitKoopa) { super('クッパの吐く炎', AT.LIMIT_KOOPA_FLAME, k, 100); }
    receiveMessage(_s: HitActor, msg: number) { return msg !== MSG.SPRAYED_BY_WATER; }
    attack_(a: HitActor) { if (a.receiveMessage(this, MSG.BURN)) this.mKoopa.stopFlame(); }
}
export class LimitKoopaHand extends LimitKoopaParts {
    constructor(k: LimitKoopa) { super('クッパの手', AT.LIMIT_KOOPA_HAND, k, 100); }
    receiveMessage() { return true; }
    attack_(a: HitActor) { a.receiveMessage(this, MSG.ATTACK); }
}
export class LimitKoopaHead extends LimitKoopaParts {
    constructor(k: LimitKoopa) { super('クッパの頭', AT.LIMIT_KOOPA_HEAD, k, 100); }
    receiveMessage(_s: HitActor, msg: number) { if (msg === MSG.SPRAYED_BY_WATER) this.mKoopa.getShowered(); return true; }
    attack_(a: HitActor) { a.receiveMessage(this, MSG.ATTACK); }
}
export class LimitKoopaBody extends LimitKoopaParts {
    constructor(k: LimitKoopa) { super('クッパの体', AT.LIMIT_KOOPA_BODY, k, 100); }
    receiveMessage() { return true; }
    attack_(a: HitActor) { a.receiveMessage(this, MSG.ATTACK); }
}

// ---------------------------------------------------------------- TLimitKoopaManager
export class LimitKoopaManager extends EnemyManager {
    constructor(w: World, name = 'クッパマネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        const p = readParams('/enemy/limitkoopa.prm', this.world.files, LIMIT_KOOPA_PARAMS) as LimitKoopaParams;
        // (these four always override the file)
        p.rotationSpeed = 0.25; p.bodyScale = 0.7; p.hipDropInitialSpeedY = 40; p.hipDropGravityY = 0.4;
        this.saveParams = p;
    }
    // loadAfter: the fire particles only
    createModelData() { this.createModelDataArray(['koopa_model.bmd']); }
    createEnemyInstance(): SpineEnemy | null { return null; }
}

// ---------------------------------------------------------------- TLimitKoopa
export class LimitKoopa extends SpineEnemy {
    mTimers = [0, 0, 0];
    mAcceleration = new V3();
    mOnGround = true;
    mDirection = new DirectionCalc();
    unk170 = 0; unk174 = 0;
    mFlames: LimitKoopaFlame[] = []; mHands: LimitKoopaHand[] = [];
    mHead: LimitKoopaHead | null = null; mBody: LimitKoopaBody | null = null;
    mHeadJoint = -1; mNeckJoint = -1; mJawJoint = -1;
    /** the joints' world matrices as the last calc left them */
    joints: mat4[] | null = null;
    constructor(w: World, name = 'クッパ') {
        super(w, name);
        this.onLiveFlag(LF.AIRBORNE);
        this.offLiveFlag(LF.ENABLE_CLIPPING);
        this.onLiveFlag(LF.UNK10);
        this.scaledBodyRadius = 1600;
    }
    getParam(): LimitKoopaParams { return this.getSaveParam() as LimitKoopaParams; }
    loadAfter() {
        for (let i = 0; i < 10; i++) this.mFlames.push(new LimitKoopaFlame(this));
        for (let i = 0; i < 2; i++) this.mHands.push(new LimitKoopaHand(this));
        this.mHead = new LimitKoopaHead(this);
        this.mBody = new LimitKoopaBody(this);
    }
    init(m: LiveManager | null) {
        this.bodyRadius = 800; this.headHeight = 2000;
        super.init(m);
        this.onHitFilter(HF.NO_COLLISION); this.onHitFilter(HF.NO_DAMAGE); this.offHitFilter(HF.NO_ATTACK);
        this.spine!.initWith(N.wait);
        this.unk170 = 0;
        this.reset();
        const a = this.mactor;
        if (a) { this.mJawJoint = a.jointIndex('ago'); this.mHeadJoint = a.jointIndex('head'); this.mNeckJoint = a.jointIndex('neck'); }
        // (KoopaNeckCallBack on the head joint: does nothing)
    }
    reset() {
        super.reset();
        this.changeBck(KOOPA_ANM_WAIT, this.getParam().waitSpeed);
        this.resetLimitKoopa();
    }
    resetLimitKoopa() {
        this.spine!.reset();
        this.mTimers = [0, 0, 0];
        this.mOnGround = true;
        this.mDirection.unk0 = 0;
    }
    perform(cue: number) {
        super.perform(cue);
        for (const f of this.mFlames) f.testPerform(cue);
        this.mHead?.testPerform(cue);
        this.mHands[0]?.testPerform(cue); this.mHands[1]?.testPerform(cue);
        this.mBody?.testPerform(cue);
        if (cue & CUE_MOVE) { if (this.mHead) this.setUpHitActors(); this.updateTimers(); }
        if ((cue & CUE_CALC_ANIM) && this.isBreathing()) this.world.effect('ms_kp_fire', trans(this.getHeadMtx(), this.pos.clone()));
    }
    /** bind: no map collision: he falls under mAcceleration to a fixed floor */
    bind() {
        const next = this.pos.clone().add(this.posDelta).add(this.vel);
        this.vel.add(this.mAcceleration);
        this.groundHeight = 3500;
        this.groundHeight = fr(this.groundHeight + 1);
        if (next.y <= fr(0.05 + this.groundHeight)) { next.y = this.groundHeight; this.mOnGround = true; this.moveStop(); }
        this.posDelta.set(V3.sub(next, this.pos));
    }
    moveStop() { this.mAcceleration.set(0, 0, 0); this.vel.set(0, 0, 0); }
    /** startHipDrop: a jump toward the spot below Mario */
    startHipDrop() {
        const P = this.getParam();
        let v = new V3(0, 1, 0).scale(P.hipDropInitialSpeedY);
        const target = marioPos(this.world);
        target.y = this.groundHeight;
        const diff = V3.sub(target, this.pos);
        const dest = V3.add(this.pos, diff);
        v = this.calcVelocityToJumpToY(dest, v.y, P.hipDropGravityY);
        if (v.length() > 200) { v.normalize(); v.scale(200); }
        this.vel.set(v);
    }
    moveHipDrop() { this.mAcceleration.set(0, -this.getGravityY(), 0); }
    moveTurn() { this.makeDirection(this.calcTargetDirection()); }
    finishedTurn() { return !(this.mDirection.absDirection(this.calcTargetDirection()) > 0.31415927); }
    calcTargetDirection() { const o = V3.sub(marioPos(this.world), this.pos); o.y = 0; return new DirectionCalc(o).unk0; }
    makeDirection(dir: number) { this.mDirection.unk0 = this.mDirection.calcTurnDirection(dir, DirectionCalc.d2r(this.getParam().rotationSpeed)); }
    getGravityY() { return this.getParam().hipDropGravityY; }
    calcRootMatrix() {
        const s = this.getParam().bodyScale;
        this.scale.set(s, s, s);
        this.rot.y = DirectionCalc.r2d(this.mDirection.unk0);
        super.calcRootMatrix();
        this.joints = this.mactor ? this.mactor.anmMtxAll(this.baseTR, this.scale) : null;
    }
    stopFlame() { this.changeBck(KOOPA_ANM_FIRE_END, this.getParam().fireSpeed); }
    breathFlame() { }   // (TODO: UNUSED, its body unknown)
    /** setUpHitActors: the flames in front of the head while breathing fire, the head's volume on the jaw */
    setUpHitActors() {
        const head = this.getHeadMtx(), P = this.getParam();
        if (this.isBreathing()) {
            let rate = 1;
            if (this.getAnmIndex() === KOOPA_ANM_FIRE_START) {
                const c = this.mactor!.getFrameCtrl(ANM_BCK)!;
                rate = fr(fr(c.frame - 125) / fr(c.end - 125));
            }
            for (let i = 0; i < this.mFlames.length; i++) {
                let height = P.flameHeight;
                const radius = P.flameRadius;
                const dist = fr(fr(0.8 * fr((2 + i * 2) * radius)) * rate);
                const pos = head ? new V3(fr(head[0] * dist + head[12]), fr(head[1] * dist + head[13]), fr(head[2] * dist + head[14])) : this.pos.clone();
                pos.y = this.pos.y;
                if (height <= 0) height = fr(2 * radius);
                this.mFlames[i].set(pos, radius, height);
            }
        } else for (const f of this.mFlames) f.remove();
        const jaw = this.joints && this.mJawJoint >= 0 ? this.joints[this.mJawJoint] : null;
        const r = P.headRadius;
        this.mHead!.set(jaw ? new V3(fr(jaw[12]), fr(fr(jaw[13]) - 200), fr(jaw[14])) : this.pos.clone(), r, fr(2 * r));
    }
    changeBck(i: number, rate: number) { const a = this.mactor; if (!a) return; a.setBckFromIndex(i); const c = a.getFrameCtrl(ANM_BCK); if (c) c.rate = rate; }
    getAnmIndex() { return this.mactor ? this.mactor.getCurAnmIdx(ANM_BCK) : -1; }
    endsAnm() { return !this.mactor || this.mactor.curAnmEndsNext(ANM_BCK); }
    isBreathing() { const a = this.getAnmIndex(); return a === KOOPA_ANM_FIRE_LOOP || (a === KOOPA_ANM_FIRE_START && this.getAnmFrame() >= 127); }
    getFlameDir() { return 0; }   // (TODO: UNUSED, its body unknown)
    isFlaming() { return false; }   // (TODO: UNUSED, its body unknown)
    getNeckFocus() { return 0; }   // (TODO: UNUSED, its body unknown)
    /** getDown (UNUSED: TKoopa::getDown without the nerves he lacks) */
    getDown() {
        const s = this.spine!, c = s.current;
        if (c === N.fall || c === N.tumble) return;
        if (c === N.stagger || c === N.getShowered) s.setNext(N.getDown);
        s.pushNerve(N.getDown);
    }
    getShowered() {
        const s = this.spine!, c = s.current;
        if (c === N.tumble || c === N.getDown) return;
        if (c === N.stagger) s.setNext(N.getShowered);
        s.pushNerve(N.getShowered);
    }
    /** stagger (UNUSED) */
    stagger(force: boolean) {
        const c = this.spine!.current;
        if (!force && c === N.flame) return;
        if (c === N.tumble || c === N.getDown || c === N.getShowered) return;
        this.spine!.pushNerve(N.stagger);
    }
    isTumbling() { return false; }
    getAnmFrame() { const c = this.mactor && this.mactor.getFrameCtrl(ANM_BCK); return c ? c.frame : 0; }
    /** fall (UNUSED) */
    fall() { this.spine!.setNext(N.fall); }
    getAnmEnd() { const c = this.mactor && this.mactor.getFrameCtrl(ANM_BCK); return c ? c.end : 0; }
    getHeadMtx(): mat4 | null { return this.joints && this.mHeadJoint >= 0 ? this.joints[this.mHeadJoint] : null; }
    checkMarioWhichSide() { }   // (TODO: UNUSED, its body unknown)
    updateTimers() { for (let i = 0; i < 3; i++) if (this.mTimers[i] > 0) this.mTimers[i]--; }
}

// ---------------------------------------------------------------- TLimitKoopaJrManager
export class LimitKoopaJrManager extends EnemyManager {
    constructor(w: World, name = 'リミットクッパジュニアマネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        const p = readParams('/enemy/limitkoopajr.prm', this.world.files, LIMIT_KOOPA_JR_PARAMS) as LimitKoopaJrParams;
        // (TLimitKoopaJrParams sets them all after the load, overriding the file)
        p.mSLAcceleration = 1; p.mSLRotationSpeed = 1; p.mSLSpeedMax = 15; p.mSLRoundAngleVelocity = 0.08; p.mSLRoundRadius = 3300;
        p.mSLRoundHeight = 5400; p.mSLDamageRadius = 100; p.mSLDamageHeight = 300; p.mSLKoopaJrScale = 2; p.mSLDamagePeriod = 120; p.mSLShotDoodlePeriod = 600;
        this.saveParams = p;
    }
    loadAfter() { }
    createModelData() { this.createModelDataArray(['koopajr_model.bmd']); }
    createEnemyInstance(): SpineEnemy | null { return null; }
}

// ---------------------------------------------------------------- TLimitKoopaJr
type SJ = Spine<LimitKoopaJr>;
export const LimitKoopaJrNerves: Record<string, any> = {};
const NJ = LimitKoopaJrNerves;
// koopajr_bastable's BCKs: 0 damage, 1 shoot, 2 (the run / wait loop), 3 yahoo
NJ.run = nerve<LimitKoopaJr>('TNerveLimitKoopaJrRun', (spine: SJ) => {
    const a = spine.body;
    if (spine.time === 0) a.setAnimationIndex(2);
    if (!a.canRun()) { spine.pushAfterCurrent(NJ.wait); return true; }
    a.moveRun();
    return false;
});
NJ.wait = nerve<LimitKoopaJr>('TNerveLimitKoopaJrWait', (spine: SJ) => {
    const a = spine.body;
    if (spine.time === 0) a.setAnimationIndex(2);
    if (a.canRun()) { spine.pushAfterCurrent(NJ.run); return true; }
    if (a.canYahoo()) { spine.pushAfterCurrent(NJ.yahoo); return true; }
    if (a.unk158[1] <= 0) { spine.pushAfterCurrent(NJ.launch); return true; }
    a.moveWait();
    return false;
});
NJ.launch = nerve<LimitKoopaJr>('TNerveLimitKoopaJrLaunch', (spine: SJ) => {
    const a = spine.body;
    if (spine.time === 0) { a.setAnimationIndex(1); a.unk158[1] = a.getParam().mSLShotDoodlePeriod; }
    if (a.mactor!.curAnmEndsNext(ANM_BCK)) { spine.pushAfterCurrent(NJ.wait); return true; }
    return false;
});
NJ.yahoo = nerve<LimitKoopaJr>('TNerveLimitKoopaJrYahoo', (spine: SJ) => {
    const a = spine.body;
    if (spine.time === 0) a.setAnimationIndex(3);
    if (a.mactor!.curAnmEndsNext(ANM_BCK)) { spine.pushAfterCurrent(NJ.wait); return true; }
    return false;
});

export class LimitKoopaJr extends SpineEnemy {
    /** 0x150: the bathtub (バスタブ): only its position is used */
    mBathtub: { pos: V3 } | null = null;
    /** 0x154: the first of クッパマネージャー's (unused) */
    mKoopa: SpineEnemy | null = null;
    unk158 = [0, 0];
    unk160 = 0; unk164 = 0; unk168 = 0; unk16C = 1;
    /** 0x170: his angle round the centre */
    unk170 = new DirectionCalc();
    mRoundRadius = 0;
    /** 0x178: his facing */
    unk178 = new DirectionCalc();
    constructor(w: World, name = 'リミットクッパジュニア') {
        super(w, name);
        this.onLiveFlag(LF.UNK10);
        this.offLiveFlag(LF.ENABLE_CLIPPING);
    }
    getParam(): LimitKoopaJrParams { return this.getSaveParam() as LimitKoopaJrParams; }
    init(m: LiveManager | null) {
        if (!m) return;
        this.manager = m;
        m.manageActor(this);
        this.mactor = this.createMActorByName('koopajr_model.bmd');
        const P = this.getParam();
        this.initHitActor(AT.LIMIT_KOOPA_JR, 1, 0, 0, 0, P.mSLDamageRadius, P.mSLDamageHeight);
        this.offHitFilter(HF.NO_COLLISION);
        this.spine!.initWith(NJ.run);
        const s = P.mSLKoopaJrScale;
        this.scale.set(s, s, s);
        this.resetLimitKoopaJr();
    }
    reset() { super.reset(); this.resetLimitKoopaJr(); }
    resetLimitKoopaJr() {
        this.spine!.reset();
        this.unk158 = [0, this.getParam().mSLShotDoodlePeriod];
        this.unk160 = 0; this.unk164 = 0; this.unk168 = 0; this.unk16C = 1;
        this.unk178.unk0 = 0; this.unk170.unk0 = 0;
    }
    perform(cue: number) {
        if (!this.mKoopa) { const m = this.world.search('クッパマネージャー') as EnemyManager | null; this.mKoopa = m && m.objs[0] ? m.objs[0] as SpineEnemy : null; }
        if (!this.mBathtub) this.mBathtub = this.world.search('バスタブ') as unknown as { pos: V3 } | null;
        if (cue & CUE_MOVE) { this.updateTimers(); /* (checkNerve: emitKoopaJrEffects, empty) */ }
        super.perform(cue);
    }
    bind() { }
    calcRootMatrix() {
        const h = fr(0.5 * this.unk178.unk0);
        new Quat(0, fr(Math.sin(h)), 0, fr(Math.cos(h))).toMtx(this.baseTR, this.pos);
    }
    setAnimationIndex(i: number) { if (this.mactor) this.mactor.setBckFromIndex(i); }
    updateTimers() { for (let i = 0; i < 2; i++) if (this.unk158[i] > 0) this.unk158[i]--; }
    receiveMessage(_s: HitActor, msg: number) { return msg === MSG.SPRAYED_BY_WATER; }
    /** the bathtub's position (TODO: the game has it; with none found, the origin here) */
    private centre() { return this.mBathtub ? this.mBathtub.pos : new V3(); }
    moveRun() {
        const P = this.getParam();
        const av = fr(0.017453294 * P.mSLRoundAngleVelocity);
        const d = new DirectionCalc(this.unk170.calcTurnDirection(this.calcTargetDirection(), av));
        const turn = d.sub(this.unk170.unk0);
        this.unk170.unk0 = d.unk0;
        this.mRoundRadius = P.mSLRoundRadius;
        const offset = this.unk170.calcDirectionVector().scale(this.mRoundRadius);
        this.pos.set(V3.add(this.centre(), offset));
        this.pos.y = P.mSLRoundHeight;
        jnorm(offset);
        const tangent = jnorm(new V3().cross(new V3(0, 1, 0), offset).fround());
        if (turn < 0) tangent.scale(-1);
        this.makeDirection(tangent);
    }
    canRun() { return !(this.unk170.absDirection(this.calcTargetDirection()) <= 0.62831855); }
    /** SMS_IsMarioStatusTypeJumping */
    canYahoo() { return (marioStatus(this.world) & 0x800) !== 0; }
    moveWait() { const o = V3.sub(marioPos(this.world), this.pos); o.y = 0; this.makeDirection(o); }
    calcTargetDirection() { const o = V3.sub(this.centre(), marioPos(this.world)); o.y = 0; return new DirectionCalc(o).unk0; }
    makeDirection(v: V3) {
        v = jnorm(v.clone());
        const d = new DirectionCalc(v);
        this.unk178.unk0 = this.unk178.calcTurnDirection(d.unk0, DirectionCalc.d2r(this.getParam().mSLRotationSpeed));
    }
}

register('LimitKoopaManager', (w, n) => new LimitKoopaManager(w, n));
register('LimitKoopa', (w, n) => new LimitKoopa(w, n));
register('LimitKoopaJrManager', (w, n) => new LimitKoopaJrManager(w, n));
register('LimitKoopaJr', (w, n) => new LimitKoopaJr(w, n));
