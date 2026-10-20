// Bowser in the hot tub (TKoopa, Enemy/Koopa.cpp), Corona Mountain's final fight (coronaBoss), with
// his manager (TKoopaManager), his parameters (TKoopaParams, /enemy/koopa.prm) and his hit volumes
// (TKoopaParts: TKoopaBody, TKoopaHead, TKoopaHand, TKoopaFlame).
//
// He stands on the bathtub (TBathtub, バスタブ): his root follows its root joint 1500 units down its
// up axis, turned by his own yaw. He opens with his taunt (TNerveKoopaProvoke), then waits
// (TNerveKoopaWait): Mario near one of the tub's grips (TBathtub::getNextGrip) and Bowser turns
// to it (TNerveKoopaTurnR / L) and, at a few points of his idle loop, may hip drop
// (TNerveKoopaTumble: tips the tub, TBathtub::tumble, between tumbleStartFrame and tumbleEndFrame);
// otherwise he turns toward the tub's juncture Mario is heading to and breathes fire
// (TNerveKoopaFlame: fire_start / fire_loop / fire_end), the flame hit actors fired from his
// head joint every few ticks along its X axis. A flame that burns Mario throws him up, Bowser
// laughs when the breath ends and ignores him for 240 ticks. Spraying his head (TKoopaHead)
// makes him flinch (TNerveKoopaGetShowered); a Bullet Bill (ACTOR_TYPE_BATHTUB_KILLER) hitting
// his head or body makes him stagger (TNerveKoopaStagger); the tub's grips breaking knocks him
// down (getDown: TNerveKoopaGetDown, longer the fewer grips are left); the last one, he falls
// (fall: TNerveKoopaFall). His neck follows Mario (KoopaNeckCallBack on the head joint) by
// getNeckFocus, and sideways while he breathes fire.
//
// The bathtub is ported separately (mapobj/bathtub.ts); it is found by name and used through the
// small KoopaBathtub interface below.
//
// Not here: the particles (fire, hip drop: effects by name), the camera shake, rumble, the
// animation sounds (.bas) and the BCK motion blend (initBckSimpleMotionBlend).

import { fr, V3, Mtx, mtx, Quat, MsMtxSetRotRPH, matan } from '../math.js';
import { World, Stream, HitActor, LiveManager, SpineEnemy, EnemyManager, LF, HF, HC, MSG, ANM_BCK, ANM_BTP, ANM_FRAME_RATE, CUE_MOVE, CUE_CALC_ANIM, nerve, Nerve, Spine, readParams, SPINE_PARAMS, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import type { mat4 } from 'gl-matrix';
import { MTXConcat } from '../mapobj/lib.js';

// ---------------------------------------------------------------- params
export const KOOPA_PARAMS = {
    ...SPINE_PARAMS,
    turnSpeed: ['f', 1.6], turnAnim: ['f', 3.7], waitStep: ['f', 600], downStep: ['f', 1000], attackRadius: ['f', 800], attackHeight: ['f', 1000],
    focusRange: ['f', 2], waitRange: ['f', 12], fireSpeed: ['f', 3.5], tumbleWeight: ['f', 8.3], tumbleSpeed: ['f', 2], tumbleStartFrame: ['f', 95],
    tumbleEndFrame: ['f', 160], waitSpeed: ['f', 2], staggerSpeed: ['f', 2], downSpeed: ['f', 2], flameVelocity: ['f', 35], flameScale: ['f', 1],
    flameCount: ['i', 500], flameFocusStartStep: ['i', 25], flameFocusEndStep: ['i', 500], flameRadius: ['f', 300], flameHeight: ['f', 1000],
    headRadius: ['f', 400], waterhitSpeed: ['f', 2], flameOverStart: ['f', 1], flameNeckRange: ['f', 17], flameNeckDownRate: ['f', 0.3],
    flameJump: ['f', 80], fallSpeed: ['f', 2], marioEstimationFire: ['f', 20], marioEstimationWait: ['f', 10],
} satisfies PSchema;
export type KoopaParams = { [K in keyof typeof KOOPA_PARAMS]: number };

// Bowser's animations (koopa_model.bmd's folder, in archive order: koopa_bastable)
export const KOOPA_ANM_DOWN = 0, KOOPA_ANM_DOWN_LOOP = 1, KOOPA_ANM_FALL = 2, KOOPA_ANM_FIRE_END = 3, KOOPA_ANM_FIRE_LOOP = 4, KOOPA_ANM_FIRE_START = 5,
    KOOPA_ANM_FIRST = 6, KOOPA_ANM_GETUP = 7, KOOPA_ANM_HIPDROP = 8, KOOPA_ANM_STAGGER = 9, KOOPA_ANM_TURN_L = 10, KOOPA_ANM_TURN_R = 11,
    KOOPA_ANM_WAIT = 12, KOOPA_ANM_UNK13 = 13, KOOPA_ANM_WATERHIT = 14;

/**
 * The TBathtub members Bowser (and Bowser Jr.) use (MoveBG/MapObjCorona.cpp), the actor named
 * バスタブ. getRootJointMtx is the sim's row-major 3x4 (m[r * 4 + c]).
 */
export interface KoopaBathtub {
    pos: V3;
    /** unk29A: the ending demo is on */
    unk29A: number | boolean;
    getRootJointMtx(): Mtx | null;
    /** getNextGrip(pos, dir, maxDiff, f32* out): the grip angle within maxDiff (null: none; the decomp's bool and out) */
    getNextGrip(pos: V3, dir: V3, maxDiff: number): number | null;
    getNextJuncture(pos: V3, dir: V3): number;
    allowsTumble(): boolean;
    getNumGripsDead(): number;
    tumble(dir: number, weight: number): void;
}
export const findBathtub = (w: World) => w.search('バスタブ') as unknown as KoopaBathtub | null;

// ---------------------------------------------------------------- helpers
/** MsWrapFmodf: lo + std::fmodf((hi - lo) + (v - lo), hi - lo) */
export const MsWrapFmodf = (v: number, lo: number, hi: number) => { const d = fr(hi - lo); return fr(lo + fr(fr(d + fr(v - lo)) % d)); };
/** MsWrapMod: the same through JGeometry::TUtil<f32>::mod (value - modulus * (s64)(value / modulus)) */
export const MsWrapMod = (v: number, lo: number, hi: number) => {
    const d = fr(hi - lo), x = fr(d + fr(v - lo));
    const m = Math.abs(d) > Math.abs(x) ? x : fr(x - fr(d * Math.trunc(fr(x / d))));
    return fr(lo + m);
};
const EPS = 3.81469727e-6;
/** JGeometry::TVec3::normalize (setLength(1): zero when (nearly) zero) */
export const jnorm = (v: V3) => { const l2 = v.squared(); if (l2 <= EPS) return v.zero(); return v.scale(1 / Math.sqrt(l2)); };
/** SMS_GetMarioSpeedX/Y/Z */
export function marioVel(w: World): V3 { const m = w.mario as any; const v = typeof m.mStatus === 'number' ? m.mVel : m.vel; return v ? new V3(v.x, v.y, v.z) : new V3(); }
/** SMS_ThrowMario(dir, speed) */
export function throwMario(w: World, dir: V3, speed: number) { const m = w.mario as any; if (typeof m.throwMario === 'function') m.throwMario(dir, speed); }
/** a joint's world matrix (column-major mat4) entry at row r, column c (MtxPtr m[r][c]) */
const at = (m: mat4, r: number, c: number) => m[c * 4 + r];
/** TQuat4::setRotate(from, to, amount) */
function quatFromTo(q: Quat, from: V3, to: V3, amount: number) {
    const ax = new V3().cross(from, to), l = fr(ax.length());
    if (l <= EPS) return q.set4(0, 0, 0, 1);
    const h = fr(fr(0.5 * Math.atan2(l, from.dot(to))) * amount), k = fr(Math.sin(h) / l);
    return q.set4(fr(ax.x * k), fr(ax.y * k), fr(ax.z * k), fr(Math.cos(h)));
}
/** a mat4's 3x4 as a row-major Mtx, and back */
const toMtx = (m: mat4): Mtx => { const r = mtx(); for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) r[i * 4 + j] = at(m, i, j); return r; };
const fromMtx = (r: Mtx, m: mat4) => { for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) m[j * 4 + i] = r[i * 4 + j]; };

// ---------------------------------------------------------------- nerves
const P = (k: Koopa) => k.getParam();
/** TNerveKoopaTurn::turn (fabricated helper of the turn nerves) */
function turn(k: Koopa, step: number) {
    if (step > 0) k.changeAnm(KOOPA_ANM_TURN_R, 0, fr(step * P(k).turnAnim));
    else k.changeAnm(KOOPA_ANM_TURN_L, 0, fr(-step * P(k).turnAnim));
    k.rot.y = MsWrapMod(fr(k.rot.y + step), -180, 180);
}
/** checkTurnDir (Koopa.cpp's fabricated inline): which way to turn toward Mario's grip / juncture, and whether a grip is near */
function checkTurnDir(k: Koopa): [number, boolean] {
    const tub = k.bathtub()!, w = k.world, m = w.mario.pos;
    const est = marioVel(w).scale(P(k).marioEstimationWait);
    const a = tub.getNextGrip(m, est, P(k).waitRange), grip = a !== null;
    if (grip) k.mTargetDir = a;
    if (!grip) {
        const est2 = marioVel(w).scale(P(k).marioEstimationFire);
        k.mTargetDir = tub.getNextJuncture(m, est2);
    }
    const diff = MsWrapFmodf(fr(k.mTargetDir - k.rot.y), -180, 180), range = P(k).focusRange;
    if (diff < -range) return [-1, grip];
    if (diff > range) return [1, grip];
    return [0, grip];
}
const flameFlipped = (k: Koopa) => MsWrapFmodf(fr(k.getTargetDir(k.world.mario.pos) - k.mTargetDir), -180, 180) < 0;

export const KoopaNerves: Record<string, Nerve<Koopa>> = {};
const N = KoopaNerves;
N.turnR = nerve<Koopa>('TNerveKoopaTurnR', (s) => {
    const k = s.body, diff = MsWrapFmodf(fr(k.mTargetDir - k.rot.y), -180, 180);
    let turning: boolean;
    if (diff > P(k).turnSpeed) { turn(k, P(k).turnSpeed); turning = true; }
    else if (diff > 0) { turn(k, diff); turning = true; }
    else turning = false;
    return !turning;
});
N.turnL = nerve<Koopa>('TNerveKoopaTurnL', (s) => {
    const k = s.body, diff = MsWrapFmodf(fr(k.mTargetDir - k.rot.y), -180, 180);
    let turning: boolean;
    if (diff < -P(k).turnSpeed) { turn(k, -P(k).turnSpeed); turning = true; }
    else if (diff < 0) { turn(k, diff); turning = true; }
    else turning = false;
    return !turning;
});
N.wait = nerve<Koopa>('TNerveKoopaWait', (s) => {
    const k = s.body;
    if (k.ignoresMario()) { k.changeAnm(KOOPA_ANM_WAIT, 1, P(k).waitSpeed); return false; }
    const [dir, grip] = checkTurnDir(k);
    if (grip) {
        if (dir === -1) s.pushNerve(N.turnL);
        else if (dir === 1) s.pushNerve(N.turnR);
        else {
            k.changeAnm(KOOPA_ANM_WAIT, 1, P(k).waitSpeed);
            if (k.canTumble() && k.bathtub()!.allowsTumble()) s.pushNerve(N.tumble);
        }
        return false;
    }
    if (dir === -1) s.pushNerve(N.turnL);
    else if (dir === 1) s.pushNerve(N.turnR);
    else { k.mFlameFlipped = flameFlipped(k); s.setNext(N.flame); }
    return false;
});
N.tumble = nerve<Koopa>('TNerveKoopaTumble', (s) => {
    const k = s.body;
    k.changeAnm(KOOPA_ANM_HIPDROP, 0, P(k).tumbleSpeed);
    if (s.getTime() === 190) {
        // (the camera shake, ms_kp_hipdrop on the tub's root joint, rumble when Mario's on the ground)
        k.world.effect('ms_kp_hipdrop', k.pos);
    }
    return k.endsAnm();
});
N.fall = nerve<Koopa>('TNerveKoopaFall', (s) => { const k = s.body; k.changeAnm(KOOPA_ANM_FALL, 0, P(k).fallSpeed); return false; });
N.flame = nerve<Koopa>('TNerveKoopaFlame', (s) => {
    const k = s.body;
    switch (k.getAnmIndex()) {
        case KOOPA_ANM_FIRE_START:
            if (k.endsAnm()) { k.changeAnm(KOOPA_ANM_FIRE_LOOP, 0, 2); s.setNext(N.flame); }
            else k.mWillLaugh = false;
            break;
        case KOOPA_ANM_FIRE_END:
            if (k.endsAnm()) {
                if (k.mWillLaugh) k.laugh();
                if (k.ignoresMario()) { s.setNext(N.wait); return false; }
                const [dir, grip] = checkTurnDir(k);
                if (grip) s.setNext(N.wait);
                else if (dir === -1) s.pushNerve(N.turnL);
                else if (dir === 1) s.pushNerve(N.turnR);
                else if (dir === 0) { k.mFlameFlipped = flameFlipped(k); k.changeAnm(KOOPA_ANM_FIRE_START, 0, P(k).fireSpeed); s.setNext(N.flame); }
            }
            break;
        case KOOPA_ANM_FIRE_LOOP:
            if (s.getTime() >= P(k).flameCount) {
                if ((s.getTime() & 7) === 0) {
                    const [dir, grip] = checkTurnDir(k);
                    if (grip || dir !== 0) k.changeAnm(KOOPA_ANM_FIRE_END, 0, P(k).fireSpeed);
                } else if (k.mactor!.curAnmEndsNext(ANM_BCK)) {
                    if (s.getTime() >= P(k).flameFocusEndStep) k.changeAnm(KOOPA_ANM_FIRE_END, 0, P(k).fireSpeed);
                }
            }
            break;
        default:
            k.changeAnm(KOOPA_ANM_FIRE_START, 0, P(k).fireSpeed);
            break;
    }
    return false;
});
N.provoke = nerve<Koopa>('TNerveKoopaProvoke', (s) => {
    const k = s.body;
    k.changeAnm(KOOPA_ANM_FIRST, 0, 2);
    if (k.endsAnm()) s.setNext(N.wait);
    return false;
});
N.stagger = nerve<Koopa>('TNerveKoopaStagger', (s) => { const k = s.body; k.changeAnm(KOOPA_ANM_STAGGER, 0, P(k).staggerSpeed); return k.endsAnm(); });
N.getShowered = nerve<Koopa>('TNerveKoopaGetShowered', (s) => { const k = s.body; k.changeAnm(KOOPA_ANM_WATERHIT, 0, P(k).waterhitSpeed); return k.endsAnm(); });
N.getDown = nerve<Koopa>('TNerveKoopaGetDown', (s) => {
    const k = s.body;
    switch (k.getAnmIndex()) {
        case KOOPA_ANM_DOWN:
            if (k.endsAnm()) k.changeAnm(KOOPA_ANM_DOWN_LOOP, 0, P(k).downSpeed);
            break;
        case KOOPA_ANM_DOWN_LOOP:
            // (s32 time * (grips dead + 2), compared as a float)
            if (!(Math.imul(s.getTime(), k.bathtub()!.getNumGripsDead() + 2) < P(k).downStep) && k.endsAnm()) k.changeAnm(KOOPA_ANM_GETUP, 0, P(k).downSpeed);
            break;
        case KOOPA_ANM_GETUP:
            if (k.endsAnm()) return true;
            break;
        default:
            k.changeAnm(KOOPA_ANM_DOWN, 0, P(k).downSpeed);
            k.world.effect('ms_kp_hipdrop', k.pos);   // (on the tub's root joint)
            break;
    }
    return false;
});

// ---------------------------------------------------------------- the hit volumes
/** TKoopaParts: one of Bowser's hit volumes, in the enemy group, performed by Bowser. */
export abstract class KoopaParts extends HitActor {
    constructor(name: string, type: number, public mKoopa: Koopa, radius: number) {
        super(name);
        mKoopa.world.addToGroup('敵グループ', this);
        this.initHitActor(type, 5, HC.PLAYER | HC.BOSS, radius, radius, radius, radius);
        this.onHitFilter(HF.NO_ATTACK); this.onHitFilter(HF.NO_DAMAGE); this.onHitFilter(HF.NO_COLLISION);
        this.onHitFilter(HC.ENEMY); this.onHitFilter(HC.BOSS);
    }
    perform(cue: number) {
        if (cue & CUE_MOVE) {
            this.control();
            for (const c of this.collisions.slice()) this.attack_(c);
        }
    }
    control() { }
    abstract attack_(a: HitActor): void;
    set(p: V3, r: number, h: number) {
        this.pos.set(p);
        this.offHitFilter(HF.NO_ATTACK); this.offHitFilter(HF.NO_DAMAGE); this.offHitFilter(HF.NO_COLLISION);
        this.setHitParams(r, h, r, h);
    }
    remove() { this.onHitFilter(HF.NO_ATTACK); this.onHitFilter(HF.NO_DAMAGE); this.onHitFilter(HF.NO_COLLISION); }
}

/** TKoopaFlame: one puff of fire breath, travelling along a straight line from where it was fired. */
export class KoopaFlame extends KoopaParts {
    mOrigin = new V3(); mDir = new V3(); mSpeed = 0; mMaxLength = 0; mLength = 1; mRadius = 0; mHeight = 0;
    constructor(k: Koopa) { super('クッパの吐く炎', AT.BOSS_UNK29, k, 100); }
    isAlive() { return this.mLength < this.mMaxLength; }
    getLength() { return this.mLength; }
    resetFlame() { this.mMaxLength = 0; this.mLength = 1; }
    fire(origin: V3, dir: V3, speed: number, length: number, radius: number, height: number) {
        this.pos.set(origin); this.mDir.set(dir); this.mOrigin.set(origin);
        this.mSpeed = speed; this.mMaxLength = length; this.mLength = 0; this.mRadius = radius; this.mHeight = height;
    }
    control() {
        if (!this.isAlive()) { this.remove(); return; }
        this.mLength = fr(this.mLength + this.mSpeed);
        let h = this.mHeight;
        const p = new V3(fr(fr(this.mDir.x * this.mLength) + this.mOrigin.x), fr(fr(this.mDir.y * this.mLength) + this.mOrigin.y), fr(fr(this.mDir.z * this.mLength) + this.mOrigin.z));
        if (h <= 0) h = fr(2 * this.mRadius);
        this.set(p, this.mRadius, h);
    }
    receiveMessage(_s: HitActor, msg: number) { return msg !== MSG.SPRAYED_BY_WATER; }
    attack_(a: HitActor) {
        const k = this.mKoopa;
        if (a.receiveMessage(this, MSG.BURN) && a === (k.world.mario as unknown)) {
            throwMario(k.world, new V3(0, 1, 0), k.getParam().flameJump);
            k.mWillLaugh = true;
            k.stopFlame();
            k.setIgnoreMario(240);
        }
    }
}

/** TKoopaHand (never placed: TKoopa::setUpHitActors doesn't set them) */
export class KoopaHand extends KoopaParts {
    constructor(k: Koopa) { super('クッパの手', HC.BOSS | 0x2B, k, 100); }
    receiveMessage() { return true; }
    attack_(a: HitActor) { a.receiveMessage(this, MSG.ATTACK); }
}

/** TKoopaHead: sprayed, Bowser flinches; a Bullet Bill staggers him; touching it throws Mario. */
export class KoopaHead extends KoopaParts {
    constructor(k: Koopa) { super('クッパの頭', AT.BOSS_UNK2A, k, 100); }
    receiveMessage(sender: HitActor, msg: number) {
        const k = this.mKoopa;
        if (msg === MSG.SPRAYED_BY_WATER) {
            if (k.getShowered()) { k.world.effect('ms_enm_wathit', sender.pos); k.world.sound(SE.EN_COMMON_W_HIT_OK, k.pos); }
        } else if (msg === MSG.ATTACK) {
            if (sender.isActorType(AT.BATHTUB_KILLER)) k.stagger(false);
        }
        return true;
    }
    attack_(a: HitActor) {
        const w = this.mKoopa.world;
        if (a.receiveMessage(this, MSG.ATTACK) && a === (w.mario as unknown)) throwMario(w, new V3(0, 1, 0), 60);
    }
}

/** TKoopaBody */
export class KoopaBody extends KoopaParts {
    constructor(k: Koopa) { super('クッパの体', AT.BOSS_UNK2A, k, 100); }
    receiveMessage(sender: HitActor, msg: number) {
        if (msg === MSG.ATTACK && sender.isActorType(AT.BATHTUB_KILLER)) this.mKoopa.stagger(false);
        return true;
    }
    attack_(a: HitActor) {
        const w = this.mKoopa.world;
        if (a.receiveMessage(this, MSG.ATTACK) && a === (w.mario as unknown)) throwMario(w, new V3(0, 1, 0), 60);
    }
}

// ---------------------------------------------------------------- TKoopaManager
export class KoopaManager extends EnemyManager {
    constructor(w: World, name = 'クッパマネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.saveParams = readParams('/enemy/koopa.prm', this.world.files, KOOPA_PARAMS);
    }
    // loadAfter: the particles only (ms_kp_fire_a..e, ms_kp_hipdrop)
    createModelData() { this.createModelDataArray(['koopa_model.bmd']); }
    createEnemyInstance(): SpineEnemy | null { return null; }
}

// ---------------------------------------------------------------- TKoopa
export class Koopa extends SpineEnemy {
    /** 0x150: the direction he turns to (degrees around the tub) */
    mTargetDir = 0;
    mFlameFlipped = false; mWillLaugh = false;
    mFlames: KoopaFlame[] = []; mHands: KoopaHand[] = [];
    mHead: KoopaHead | null = null; mBody: KoopaBody | null = null;
    mIgnoreMarioTimer = 0;
    mHeadJoint = -1; mNeckJoint = -1; mJawJoint = -1;
    mNeckFocus = 1;
    /** the joints' world matrices as the last calc left them (with the neck callback) */
    joints: mat4[] | null = null;
    private tubRef: KoopaBathtub | null = null;
    constructor(w: World, name = 'クッパ') {
        super(w, name);
        this.onLiveFlag(LF.AIRBORNE);
        this.offLiveFlag(LF.ENABLE_CLIPPING);
        this.onLiveFlag(LF.UNK10);
    }
    /** (JDrama::TNameRefGen::search("バスタブ")) */
    bathtub() { if (!this.tubRef) this.tubRef = findBathtub(this.world); return this.tubRef; }
    getParam(): KoopaParams { return this.getSaveParam() as KoopaParams; }
    loadAfter() {
        super.loadAfter();
        for (let i = 0; i < 10; i++) this.mFlames.push(new KoopaFlame(this));
        for (let i = 0; i < 2; i++) this.mHands.push(new KoopaHand(this));
        this.mHead = new KoopaHead(this);
        this.mBody = new KoopaBody(this);
    }
    init(m: LiveManager | null) {
        this.bodyRadius = 800; this.headHeight = 2000;
        super.init(m);
        this.onHitFilter(HF.NO_COLLISION); this.onHitFilter(HF.NO_DAMAGE); this.offHitFilter(HF.NO_ATTACK);
        this.spine!.initWith(N.provoke);
        this.changeAnm(KOOPA_ANM_WAIT, 1, 2);
        this.changeAnm(KOOPA_ANM_FIRST, 0, 2);
        this.mTargetDir = this.getTargetDir(this.world.mario.pos);
        this.reset();
        const a = this.mactor;
        if (a) { this.mJawJoint = a.jointIndex('ago'); this.mHeadJoint = a.jointIndex('head'); this.mNeckJoint = a.jointIndex('neck'); }
        this.mNeckFocus = 1;
        this.mWillLaugh = false;
    }
    reset() {
        super.reset();
        this.changeAnm(KOOPA_ANM_WAIT, 1, this.getParam().waitSpeed);
        this.mIgnoreMarioTimer = 600;
    }
    // ------------------------------------------------ animation
    changeAnm(bck: number, btp: number, speed: number) {
        const a = this.mactor;
        if (!a) return;
        if (!a.checkCurBckFromIndex(bck)) a.setBckFromIndex(bck);
        if (btp !== a.getCurAnmIdx(ANM_BTP)) a.setFromIndex(ANM_BTP, btp);
        const c = a.getFrameCtrl(ANM_BCK);
        if (c) c.rate = fr(0.5 * fr(speed * ANM_FRAME_RATE));
    }
    getAnmIndex() { return this.mactor ? this.mactor.getCurAnmIdx(ANM_BCK) : -1; }
    endsAnm() { return !this.mactor || this.mactor.curAnmEndsNext(ANM_BCK); }
    getAnmFrame() { const c = this.mactor && this.mactor.getFrameCtrl(ANM_BCK); return c ? c.frame : 0; }
    getAnmFrameNext() { const c = this.mactor && this.mactor.getFrameCtrl(ANM_BCK); return c ? fr(c.frame + c.rate) : 0; }
    getAnmEnd() { const c = this.mactor && this.mactor.getFrameCtrl(ANM_BCK); return c ? c.end : 0; }
    passesAnmFrame(f: number) { return this.getAnmFrame() <= f && f <= fr(0.005 + this.getAnmFrameNext()); }
    /** canTumble: only at a few points of his idle loop */
    canTumble() {
        if (this.getAnmIndex() !== KOOPA_ANM_WAIT) return false;
        if (this.mactor!.curAnmEndsNext(ANM_BCK)) return true;
        return this.passesAnmFrame(2) || this.passesAnmFrame(400) || this.passesAnmFrame(700);
    }
    laugh() { this.world.sound(SE.BS_KOOPA_VO_LAUGH, this.headPos()); this.mWillLaugh = false; }
    isBreathing() {
        if (this.getAnmIndex() === KOOPA_ANM_FIRE_LOOP) return true;
        return this.getAnmIndex() === KOOPA_ANM_FIRE_START && this.getAnmFrame() >= 85;
    }
    ignoresMario() { return this.mIgnoreMarioTimer > 0; }
    setIgnoreMario(t: number) { this.mIgnoreMarioTimer = t; }
    getFlameDirRate() {
        const frame = this.getAnmFrame(), end = this.getAnmEnd(), P = this.getParam();
        const over = P.flameOverStart, start = P.flameFocusStartStep, finish = P.flameFocusEndStep, time = this.spine!.getTime();
        const anm = this.getAnmIndex();
        switch (anm) {
            case KOOPA_ANM_FIRE_START: return -fr(fr(frame * over) / end);
            case KOOPA_ANM_FIRE_END: case KOOPA_ANM_FIRE_LOOP: {
                let rate: number;
                if (time <= start) rate = -over;
                else if (time <= finish) rate = fr(fr(fr(fr(1 + over) * (time - start)) / (finish - start)) - over);
                else rate = 1;
                if (anm === KOOPA_ANM_FIRE_END) return fr(rate * fr(1 - fr(frame / end)));
                return rate;
            }
            default: return 0;
        }
    }
    getFlameDirDegree() { const r = fr(this.getFlameDirRate() * this.getParam().flameNeckRange); return fr(this.rot.y + (this.mFlameFlipped ? -r : r)); }
    isFlaming() { const a = this.getAnmIndex(); return a === KOOPA_ANM_FIRE_END || a === KOOPA_ANM_FIRE_LOOP || a === KOOPA_ANM_FIRE_START; }
    isProvoking() { if (this.getAnmIndex() !== KOOPA_ANM_FIRST) return false; const f = this.getAnmFrame(); return 68 <= f && f <= 164; }
    /** getNeckFocus: how strongly the neck follows Mario (0..1), a curve over each animation */
    getNeckFocus() {
        const anm = this.getAnmIndex(), end = this.getAnmEnd(), f = this.getAnmFrame();
        let focus = 1;
        const up = (a: number) => fr(fr(f - a) / fr(end - a)), down = (a: number) => fr(1 - fr(f / a));
        switch (anm) {
            case KOOPA_ANM_FIRST: focus = f >= 164 ? up(164) : 0; break;
            case KOOPA_ANM_FALL: focus = 0; break;
            case KOOPA_ANM_DOWN: focus = f <= 40 ? down(40) : 0; break;
            case KOOPA_ANM_DOWN_LOOP: focus = 0; break;
            case KOOPA_ANM_GETUP: focus = f <= 125 ? 0 : up(125); break;
            case KOOPA_ANM_STAGGER: focus = f <= 30 ? down(30) : f <= 65 ? 0 : up(65); break;
            case KOOPA_ANM_HIPDROP: focus = f <= 30 ? down(30) : f <= 170 ? 0 : up(170); break;
            case KOOPA_ANM_WATERHIT: focus = f <= 20 ? down(20) : f <= 40 ? 0 : up(40); break;
            case KOOPA_ANM_FIRE_LOOP: focus = 0; break;
            case KOOPA_ANM_FIRE_START: focus = f <= 103 ? down(103) : 0; break;
            case KOOPA_ANM_FIRE_END: focus = fr(f / end); break;
            case KOOPA_ANM_WAIT:
                // (looks away from Mario twice during the idle loop)
                if (f <= 200) focus = 1;
                else if (f <= 255) focus = fr(1 - fr(fr(f - 200) / 55));
                else if (f <= 330) focus = 0;
                else if (f <= 390) focus = fr(fr(f - 330) / 60);
                else if (f <= 440) focus = 1;
                else if (f <= 480) focus = fr(1 - fr(fr(f - 440) / 40));
                else if (f <= 555) focus = 0;
                else if (f <= 615) focus = fr(fr(f - 555) / 60);
                break;
        }
        return focus;
    }
    // ------------------------------------------------ what the nerves are doing (asked by the tub, Bowser Jr., the hit volumes)
    private cur() { return this.spine!.current; }
    allowsLaunch() { return this.cur() !== N.tumble; }
    getDown() {
        const c = this.cur(), s = this.spine!;
        if (c === N.fall || c === N.provoke || c === N.tumble) return;
        if (c === N.stagger) s.setNext(N.getDown);
        if (s.current === N.getShowered) s.setNext(N.getDown);
        s.pushNerve(N.getDown);
    }
    effectsTumble() { const s = this.spine!; return s.current === N.tumble && s.getTime() < 900 && s.getTime() > 190; }
    getShowered() {
        const c = this.cur(), s = this.spine!;
        if (c === N.fall || c === N.provoke || c === N.tumble || c === N.getDown) return false;
        if (c === N.getShowered) return true;
        if (c === N.stagger) { s.setNext(N.getShowered); return true; }
        if (c === N.flame) { s.setNext(N.wait); return false; }
        s.pushNerve(N.getShowered);
        return true;
    }
    stagger(force: boolean) {
        const c = this.cur();
        if (c === N.fall || c === N.provoke) return;
        if (!force && c === N.flame) return;
        if (c === N.tumble || c === N.getDown || c === N.getShowered) return;
        this.spine!.pushNerve(N.stagger);
    }
    isTumbling() {
        const f = this.getAnmFrame(), P = this.getParam();
        return this.cur() === N.tumble && f >= P.tumbleStartFrame && f <= P.tumbleEndFrame;
    }
    fall() { this.rot.y = 180; this.spine!.setNext(N.fall); }
    stopFlame() { this.changeAnm(KOOPA_ANM_FIRE_END, 0, this.getParam().fireSpeed); }
    /** getTargetDir: the direction of p around the bathtub, in degrees */
    getTargetDir(p: V3) {
        const tub = this.bathtub(), m = tub && tub.getRootJointMtx();
        if (!m) return 0;
        const d = new V3(fr(p.x - m[3]), fr(p.y - m[7]), fr(p.z - m[11]));
        const x = new V3(m[0], m[4], m[8]), z = new V3(m[2], m[6], m[10]);
        return fr((360 / 65536) * matan(fr(z.dot(d)), fr(x.dot(d))));
    }
    // ------------------------------------------------ joints
    getHeadMtx(): mat4 | null { return this.joints && this.mHeadJoint >= 0 ? this.joints[this.mHeadJoint] : null; }
    headPos() { const m = this.getHeadMtx(); return m ? new V3(fr(m[12]), fr(m[13]), fr(m[14])) : this.pos.clone(); }
    /** KoopaNeckCallBack (on the head joint): turns it toward Mario, and sideways while he breathes fire */
    neckCallback(w: mat4) {
        const P = this.getParam(), mp = this.world.mario.pos;
        let m = toMtx(w);
        const toMario = new V3(fr(mp.x - m[3]), fr(fr(mp.y + 85) - m[7]), fr(mp.z - m[11]));
        if (this.isFlaming()) {
            let yaw = fr(fr(fr(fr(this.getFlameDirRate() * fr(6.2831855)) * P.flameNeckRange)) / 360);
            let pitch = fr(yaw * P.flameNeckDownRate);
            if (pitch > 0) pitch = -pitch;
            if (this.mFlameFlipped) yaw = -yaw;
            let s = fr(Math.sin(yaw)), c = fr(Math.cos(yaw));
            const rotY = new Float64Array([c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0]);
            MTXConcat(rotY, m, m);
            s = fr(Math.sin(pitch)); c = fr(Math.cos(pitch));
            const rotZ = new Float64Array([c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0]);
            MTXConcat(m, rotZ, m);
        }
        let focus = this.getNeckFocus();
        const xAxis = new V3(m[0], m[4], m[8]), yAxis = new V3(m[1], m[5], m[9]);
        // Mario's direction, flattened onto the neck's turning plane
        const k = fr(-yAxis.dot(toMario));
        const flat = new V3(fr(toMario.x + fr(yAxis.x * k)), fr(toMario.y + fr(yAxis.y * k)), fr(toMario.z + fr(yAxis.z * k)));
        jnorm(flat); jnorm(toMario);
        const dot = fr(xAxis.dot(flat));
        if (dot < 0.5) focus = fr(focus * fr(fr(1 + dot) / 1.5));
        const rot = quatFromTo(new Quat(), xAxis, flat, focus);
        rot.normalize();
        if (!this.isFlaming()) {
            const axis = new V3().cross(flat, toMario);
            let angle = fr(Math.abs(Math.atan2(axis.length(), flat.dot(toMario))));
            if (toMario.dot(yAxis) < 0) angle = -angle;
            const zDir = rot.getZDir();
            const tilt = new Quat().setRotateAxis(zDir, fr(angle * focus));
            tilt.normalize();
            rot.mul(tilt, rot);
        }
        const rm = rot.toMtx(mtx(), new V3());
        m = MTXConcat(m, rm, m);
        fromMtx(m, w);
    }
    /** calcRootMatrix: on the bathtub, its root joint 1500 units down its up axis, turned by his yaw */
    calcRootMatrix() {
        const tub = this.bathtub(), t = tub && tub.getRootJointMtx();
        if (!t) { this.calcRootMatrixBasic(); this.calcJoints(); return; }
        const off = new V3(t[1], t[5], t[9]).scale(-1500);
        const r = mtx();
        MsMtxSetRotRPH(r, 0, this.rot.y, 0);
        MTXConcat(t, r, r);
        this.pos.set(r[3], r[7], r[11]).add(off);
        r[3] = this.pos.x; r[7] = this.pos.y; r[11] = this.pos.z;
        this.baseTR.set(r);
        this.scale.set(1, 1, 1);
        this.calcJoints();
    }
    calcJoints() {
        const a = this.mactor;
        if (!a) return;
        this.joints = a.anmMtxAll(this.baseTR, this.scale, (j, w) => { if (j === this.mHeadJoint) this.neckCallback(w); });
    }
    // ------------------------------------------------ the hit volumes
    /** breathFlame: the next flame from his mouth, unless the last one is still too near */
    breathFlame() {
        const P = this.getParam();
        let free = -1, tooNear = false;
        for (let i = 0; i < this.mFlames.length; i++) {
            if (!this.mFlames[i].isAlive()) free = i;
            else if (this.mFlames[i].getLength() < fr(2 * P.flameRadius)) tooNear = true;
        }
        if (tooNear || free < 0) return;
        const h = this.getHeadMtx();
        const origin = h ? new V3(fr(h[12]), fr(fr(h[13]) - 500), fr(h[14])) : this.pos.clone();
        const dir = h ? jnorm(new V3(fr(h[0]), 0, fr(h[2]))) : new V3(0, 0, 1);
        this.mFlames[free].fire(origin, dir, P.flameVelocity, 4000, P.flameRadius, P.flameHeight);
    }
    resetFlame_() { for (const f of this.mFlames) f.resetFlame(); }
    setUpHitActors() {
        if (this.isBreathing()) this.breathFlame();
        else this.resetFlame_();
        const jaw = this.joints && this.mJawJoint >= 0 ? this.joints[this.mJawJoint] : null;
        const r = this.getParam().headRadius;
        const jp = jaw ? new V3(fr(jaw[12]), fr(fr(jaw[13]) - 200), fr(jaw[14])) : this.pos.clone();
        this.mHead!.set(jp, r, fr(2 * r));
        this.mBody!.set(this.pos, 800, 2000);
    }
    // ------------------------------------------------ the frame
    perform(cue: number) {
        if (cue & CUE_MOVE) {
            this.mNeckFocus = this.getNeckFocus();
            if (this.mIgnoreMarioTimer > 0) this.mIgnoreMarioTimer--;
        }
        super.perform(cue);
        for (const f of this.mFlames) f.testPerform(cue);
        this.mHead?.testPerform(cue);
        this.mHands[0]?.testPerform(cue); this.mHands[1]?.testPerform(cue);
        this.mBody?.testPerform(cue);
        if (cue & CUE_MOVE) {
            if (this.isTumbling()) this.bathtub()?.tumble(this.rot.y, this.getParam().tumbleWeight);
            if (this.mHead) this.setUpHitActors();
        }
        if ((cue & CUE_CALC_ANIM) && (this.isBreathing() || this.isProvoking())) this.world.effect('ms_kp_fire', this.headPos());
    }
    receiveMessage(sender: HitActor, msg: number) { return super.receiveMessage(sender, msg); }
}

// (Spine is the nerves' argument type)
export type KoopaSpine = Spine<Koopa>;

register('KoopaManager', (w, n) => new KoopaManager(w, n));
register('Koopa', (w, n) => new Koopa(w, n));
