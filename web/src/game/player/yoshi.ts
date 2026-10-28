// Yoshi (Player/Yoshi.cpp's TYoshi) and his tongue (Player/Tongue.cpp's TYoshiTongue), as the
// player's code and the stage's objects see them.
//
// TMario::initValues makes one TYoshi for every stage (init: an egg, STATE_EGG); TEggYoshi's
// hatch (appearFromEgg) brings him out, he waits by the egg's place (STATE_UNMOUNTED: falls,
// rides moving ground, looks for fruit with the tongue — doSearch, 3 rand() calls) until Mario
// lands on him from above (TMario::checkCollision -> ride: STATE_MOUNTED, FLUDD's Yoshi nozzle).
// His juice timer (unkC, 21300 ticks from a fruit) runs out, deep water, Mario's death or a
// goop/void floor under a free Yoshi take him away (disappear: STATE_DROWNING / DYING -> UNK5 ->
// the egg again, its fruit chosen anew). Ridden, his animation follows Mario's status
// (thinkAnimation) and Mario's picks the yo_* counterpart (TMario::setAnimation); the flutter
// (thinkHoldOut) lifts Mario while A is held on the way down.
//
// Not here: the body colour's TEV write and the mirror / hand models (entry: the viewer's, from
// the history's colour), the particles and sounds, the shadow / question requests, the tongue's
// drawn arc (calcAnim: SMS_MakeJointsToArc — only its head is kept). The joint matrices are
// J3D's with the BCK, the walk/run motion blend, the eat motion on joint 18 and YoshiHeadCtrl
// on joint 21 (FLUDD's gun angle).

import { VERSION } from '../version.js';
import { fmadd as FMA, fnmsub as FNMS, fmsub as FMS } from './fmath.js';
import type { mat4 } from 'gl-matrix';
import { fr, s16, V3, Mtx, mtx, JMASSin, JMASCos, matan, MsRandF, mtxMultVec, mtxInverse, MsMtxSetXYZRPH } from '../math.js';
import { World, Files, AnmData, MActor, FrameCtrl, TakeActor, HitActor, MSG, HF, HC, ANM_BCK, FC_ONCE } from '../engine.js';
import { AT } from '../actortypes.js';
import { Skeleton, parseBCK, jointMatricesBlend } from '../skeleton.js';
import { fadd, fsub, fmul, fmadd, lengthJ } from './fmath.js';
import { j3dTRMtx } from './tmario.js';
import { S, MF } from './tables.js';

// ---------------------------------------------------------------- yoshi.szs (/yoshi/)
let yoshiArchive: { files: Map<string, Uint8Array>; dirs: Map<string, string[]> } | null = null;
/** data/yoshi.szs, set once from the disc (the files and folders by lower-case path, below the root). */
export function setYoshiArchive(a: { files: Map<string, Uint8Array>; dirs: Map<string, string[]> } | null) { yoshiArchive = a; }
/** The archive as a model folder ('yoshi/...'), for MActorAnmData. */
const yoshiFiles: Files = {
    scene: (p) => (yoshiArchive ? yoshiArchive.files.get(p.toLowerCase().replace(/^\/?yoshi\//, '')) || null : null),
    folder: (p) => (yoshiArchive ? yoshiArchive.dirs.get(p.toLowerCase() === 'yoshi' ? '' : p.toLowerCase().replace(/^yoshi\//, '')) || [] : []),
    params: () => null,
};

/** TYoshi::State */
export const YS = { EGG: 0, UNK1: 1, HATCHING: 2, DROWNING: 3, DYING: 4, UNK5: 5, UNMOUNTED: 6, UNK7: 7, MOUNTED: 8 } as const;
/** bodyColor[mType]: green, orange (papaya / pineapple), purple (durian / pepper), pink (banana / coconut) */
export const YOSHI_BODY_COLOR = [[0x40, 0xA1, 0x24], [0xFF, 0x8C, 0x1C], [0xAA, 0x4C, 0xFF], [0xFF, 0xA0, 0xBE]];
/** yoshi.szs's BCKs (MActorAnmData's indices: the archive's, alphabetical) */
export const YB = {
    BORN: 0, DAMAGE: 1, DEMO_SHINE_GET: 2, EAT: 3, EAT_END: 4, GOFF: 5, HIP_END: 6, HIP_POSE: 7, HIP_START: 8, HOLD_JUMP: 9, JUMP: 10, JUMP_END: 11,
    JUMP_FALL: 12, PIVOT: 13, RIDE: 14, RUN: 15, SIDEWALK_L: 16, SIDEWALK_R: 17, SLIDE_END: 18, SLIDE_POSE: 19, SLIDE_START: 20, TONGUE_EAT: 21,
    WAIT: 22, WAIT_ALONE: 23, WALK: 24, WATER_DIE: 25,
} as const;

// Mario's statuses and pad meanings Yoshi reads (player/tables.ts S, pad.ts MEANING)
const ST = S;
const M_A = 0x80, M_B = 0x100, M_L = 0x2000, M_R = 0x400;

/** The TMario Yoshi asks of (PlayerMario has all of it). */
export interface YoshiMario {
    world: World;
    pos: V3; mVel: V3; mForwardVel: number; mFaceAngle: { x: number; y: number; z: number };
    mStatus: number; mStatusState: number; mIntendedYaw: number; mIntendedMag: number;
    mJumpParams: { mGravity: number }; mRunParams: { mPumpingSlideSp: number; mPumpingSlideAnmSp: number };
    mModel: { baseTR: Mtx; fc: FrameCtrl[] };
    mGamePad: { checkMeaning(m: number): boolean; checkFrameMeaning(m: number): boolean };
    mWaterGun: any; mHeldObject: any; mFloorHitActor: HitActor;
    checkFlag(f: number): boolean; checkStatusType(f: number): boolean; onYoshi(): boolean; getOffYoshi(fly: boolean): void;
    getMotionFrameCtrl(): FrameCtrl;
}

// ---------------------------------------------------------------- TRidingInfo (MarioUtil/ModelUtil.cpp)
class RidingInfo { unk0: any = null; localPos = new V3(); unk10 = 0; }
function actorMtxOf(a: any): Mtx {
    const m = a.getRootJointMtx ? a.getRootJointMtx() : null;
    if (m) return m;
    const r = mtx(); MsMtxSetXYZRPH(r, a.pos.x, a.pos.y, a.pos.z, a.rot.x, a.rot.y, a.rot.z); return r;
}
function rideMoveCalcLocalPos(r: RidingInfo, p: V3) {
    if (!r.unk0) return;
    mtxMultVec(mtxInverse(actorMtxOf(r.unk0)), p, r.localPos);
    r.localPos.fround();
}
/** SMS_RideMoveByGroundActor: carried by the moving ground (an actor's) under p; rot (degrees) turned with it */
function rideMoveByGroundActor(w: World, r: RidingInfo, p: V3, rot: { v: number }) {
    const [gy, d] = w.checkGround(p.x, fr(100 + p.y), p.z);
    const a = (d as any).actor;
    if (a && fsub(p.y, gy) < 50) {
        if (!r.unk0 || r.unk0 !== a) { r.unk0 = a; rideMoveCalcLocalPos(r, p); }
        else {
            mtxMultVec(actorMtxOf(r.unk0), r.localPos, p); p.fround();
            rot.v = fr(fr(rot.v + r.unk0.rot.y) - r.unk10);
            r.unk10 = r.unk0.rot.y;
        }
    } else r.unk0 = null;
}

// ---------------------------------------------------------------- TYoshiTongue
export const TS = { IDLE: 0, EXTENDING: 1, GRABBED: 2, RETRACTING: 3, UNK4: 4, UNK5: 5, PULLING: 6, PULLING_SLOW: 7 } as const;
const isFruitType = (t: number) => t === AT.FRUIT_COCONUT || t === AT.FRUIT_PAPAYA || t === AT.FRUIT_PINE || t === AT.FRUIT_DURIAN
    || t === AT.FRUIT_BANANA || t === AT.RED_PEPPER || t === AT.FRUIT_COVER_PINE;

export class YoshiTongue extends TakeActor {
    mYoshi!: Yoshi;
    mState = 0; mProgress = 0; mMaxProgress = 60; unk82 = 600;
    mInitialSpeed = 10; mExtendAmount = fr(0.05); mRetractAmount = fr(0.7); mPullAmount = fr(0.01); mRetractedLength = 80; mMaxReach = 580; mElasticity = fr(0.8);
    mHeadPos = new V3(); mHeadDir = new V3(); mTipPos = new V3(); mInitialVelocity = new V3();
    mActorTypeInMouth = 0; unkD4 = 0; mSavedColCount = 0;
    /** the collisions kept for unkD4 more ticks (mColCount = mSavedColCount: the list itself is the hit check's, so its entries) */
    private saved: HitActor[] = [];
    constructor() { super('HitActor'); }
    init(y: Yoshi) {
        this.mYoshi = y;
        this.mState = TS.IDLE; this.mProgress = 0; this.mMaxProgress = 60; this.unk82 = 600;
        this.mInitialSpeed = 10; this.mExtendAmount = fr(0.05); this.mRetractAmount = fr(0.7); this.mPullAmount = fr(0.01);
        this.mRetractedLength = 80; this.mMaxReach = fr(500 + this.mRetractedLength); this.mElasticity = fr(0.8);
        this.mHeadPos.set(0, 0, 0); this.mTipPos.set(0, 0, 0); this.mInitialVelocity.set(0, 0, 0);
        this.mActorTypeInMouth = 0; this.unkD4 = 0;
        this.initHitActor(AT.YOSHI_TONGUE, 5, HC.MAP_OBJECT | HC.ITEM | HC.ENEMY, 1000, 500, 50, 500);
        this.offHitFilter(HF.NO_COLLISION);
    }
    /** initInLoadAfter: into 敵グループ (the enemy group's hit checks), at its end */
    initInLoadAfter(w: World) { (w as any).addToGroup('敵グループ', this); }
    getTakingMtx(): Mtx | null { return this.tipMtx; }
    private tipMtx: Mtx | null = null;
    emit(src: V3, dir: V3, vel: V3) {
        if (this.mState !== TS.IDLE) return;
        this.mProgress = 0; this.mState = TS.EXTENDING;
        this.mTipPos.set(src); this.pos.set(src);
        this.pos.y = fr(-fsub(fmul(0.5, this.attackHeight), this.pos.y));
        this.mHeadPos.set(src); this.mHeadDir.set(dir);
        const I = this.mInitialVelocity;
        I.set(fmul(dir.x, this.mInitialSpeed), fmul(dir.y, this.mInitialSpeed), fmul(dir.z, this.mInitialSpeed));
        I.set(fadd(I.x, fmul(vel.x, 0.5)), fadd(I.y, fmul(vel.y, 0.5)), fadd(I.z, fmul(vel.z, 0.5)));
        if (I.y < -50) I.y = -50;
        if (I.y > 50) I.y = 50;
    }
    canGo() {
        const T = this.mTipPos, H = this.mHeadPos, D = this.mHeadDir;
        const tx = fsub(T.x, H.x), ty = fsub(T.y, H.y), tz = fsub(T.z, H.z);
        if (fadd(fadd(fmul(tx, D.x), fmul(ty, D.y)), fmul(tz, D.z)) < 0) return false;
        const w = this.mYoshi.mMario.world;
        if (w.isTouchedOneWallAndMoveXZ(T, fadd(10, T.y), 50)) return false;
        const [gy] = w.checkGround(T.x, T.y, T.z);
        if (fadd(50, gy) > T.y) { T.y = fadd(50, gy); return true; }
        const [ry0] = w.checkRoof(T.x, T.y, T.z);
        const ry = fsub(ry0, 50);
        if (ry < T.y) { T.y = ry; return true; }
        return true;
    }
    private cols(): HitActor[] { return this.unkD4 !== 0 || this.usingSaved ? this.saved : this.collisions; }
    private usingSaved = false;
    findTarget(allowExtra: boolean, checkForward: boolean): HitActor | null {
        let best: HitActor | null = null, bestDist = 10000;
        const C = this.cols();
        // (GMSJ01: a seal or a reversing basket in reach ends the reach)
        if (!VERSION.pal) for (const a of C) if (a.actorType === AT.SEAL || a.actorType === AT.BASKET_REVERSE) { this.mState = TS.RETRACTING; return null; }
        for (const a of C) {
            const t = a.actorType;
            let ok = isFruitType(t);
            if (allowExtra) {
                if (t === AT.BOTTLE_SHORT || t === AT.BOTTLE_LARGE || t === AT.WOOD_BARREL) ok = true;
                // (PAL: not a seal, an effect enemy or a reversing basket)
                if (a.isHitCategory(HC.ENEMY) && !(VERSION.pal && (t === AT.SEAL || t === AT.EFFECT_ENEMY || t === AT.BASKET_REVERSE))) ok = true;
            }
            if (!ok) continue;
            const ty = fadd(a.pos.y, fmul(0.5, a.damageHeight));
            let dx = fsub(a.pos.x, this.mTipPos.x), dy = fsub(ty, this.mTipPos.y), dz = fsub(a.pos.z, this.mTipPos.z);
            if (dx === 0 && dy === 0 && dz === 0) continue;
            const dist = lengthJ(dx, dy, dz);
            const k = fr(1 / dist); dx = fmul(dx, k); dy = fmul(dy, k); dz = fmul(dz, k);
            const D = this.mHeadDir;
            if (checkForward && !(fadd(fadd(fmul(dx, D.x), fmul(dy, D.y)), fmul(dz, D.z)) > 0.5)) continue;
            if (dist < bestDist) { bestDist = dist; best = a; }
        }
        return best;
    }
    calcEntry(r: number) { this.attackRadius = r; this.calcEntryRadius(); }
    movement() {
        // the collisions held 3 ticks after they were seen (mColCount = mSavedColCount)
        this.usingSaved = false;
        if (this.unkD4 !== 0) { this.usingSaved = true; this.unkD4--; }
        else if (this.collisions.length !== 0) { this.saved = this.collisions.slice(); this.mSavedColCount = this.saved.length; this.unkD4 = 3; }
        const T = this.mTipPos, H = this.mHeadPos;
        switch (this.mState) {
            case TS.EXTENDING:
                this.calcEntry(1000);
                this.mProgress += 1;
                if (this.mProgress >= this.mMaxProgress) this.mState = TS.RETRACTING;
                else if (!this.canGo()) this.mState = TS.RETRACTING;
                break;
            case TS.RETRACTING: {
                this.calcEntry(10);
                const d = lengthJ(fsub(T.x, H.x), fsub(T.y, H.y), fsub(T.z, H.z));
                const h = this.held as any;
                if (h && d < this.mMaxReach) {
                    const s = h.scale as V3;
                    let x = fmul(s.x, this.mElasticity), y = fmul(s.y, this.mElasticity), z = fmul(s.z, this.mElasticity);
                    if (x < fr(0.01)) x = y = z = fr(0.01);
                    s.set(x, y, z);
                }
                if (d < this.mRetractedLength) {
                    if (h) {
                        this.mActorTypeInMouth = h.actorType;
                        h.receiveMessage(this, MSG.DETACH);
                        h.receiveMessage(this, MSG.UNKB);
                        this.held = null;
                    }
                    this.mState = TS.IDLE;
                }
                break;
            }
            case TS.UNK5:
                this.calcEntry(10);
                this.mProgress++;
                if (this.mProgress >= this.unk82) this.mState = TS.RETRACTING;
                break;
            case TS.PULLING: case TS.PULLING_SLOW: this.mProgress++; break;
            default:   // IDLE, GRABBED
                this.calcEntry(300);
                this.offHitFilter(HF.NO_ATTACK);
                break;
        }
        switch (this.mState) {
            case TS.EXTENDING: {
                const tg = this.findTarget(true, true);
                if (tg && !this.held) {
                    const tp = new V3(tg.pos.x, fadd(tg.pos.y, fmul(0.5, tg.damageHeight)), tg.pos.z);
                    const old = T.clone();
                    T.set(fadd(T.x, fmul(fsub(tp.x, T.x), this.mExtendAmount)), fadd(T.y, fmul(fsub(tp.y, T.y), this.mExtendAmount)), fadd(T.z, fmul(fsub(tp.z, T.z), this.mExtendAmount)));
                    this.mInitialVelocity.set(fsub(T.x, old.x), fsub(T.y, old.y), fsub(T.z, old.z));
                    if (lengthJ(fsub(tp.x, T.x), fsub(tp.y, T.y), fsub(tp.z, T.z)) < 200 && tg.receiveMessage(this, MSG.TAKE) === true) {
                        this.held = tg as TakeActor;
                        this.mProgress = 0; this.mState = TS.GRABBED;
                    }
                } else T.set(fadd(T.x, this.mInitialVelocity.x), fadd(T.y, this.mInitialVelocity.y), fadd(T.z, this.mInitialVelocity.z));
                break;
            }
            case TS.GRABBED: this.mProgress += 1; if (this.mProgress > 10) this.mState = TS.RETRACTING; break;
            case TS.RETRACTING: {
                const k = this.mRetractAmount;
                T.set(fadd(H.x, fmul(fsub(T.x, H.x), k)), fadd(H.y, fmul(fsub(T.y, H.y), k)), fadd(H.z, fmul(fsub(T.z, H.z), k)));
                break;
            }
            case TS.PULLING: case TS.PULLING_SLOW: {
                // (something holding the tongue pulls it: no such holder is simulated)
                const len = lengthJ(fsub(T.x, H.x), fsub(T.y, H.y), fsub(T.z, H.z));
                const m = this.getTakingMtx();
                if (m && this.holder && (this.holder as any).moveRequest) {
                    let a = fmul(len, this.mPullAmount);
                    if (this.mState === TS.PULLING_SLOW) a = fmul(a, 0.5);
                    const st = new V3(fmul(-m[0], a), fmul(-m[4], a), fmul(-m[8], a));
                    const nx = new V3(fadd(T.x, st.x), fadd(T.y, st.y), fadd(T.z, st.z));
                    if ((this.holder as any).moveRequest(nx) === true) T.set(nx);
                }
                break;
            }
            default: T.set(H); break;
        }
        this.pos.set(T);
        this.pos.y = fr(-fsub(fmul(0.5, this.attackHeight), this.pos.y));
    }
    /** calcAnim: the head (the tongue joint's place and its x axis); the tip's model faces along the arc's last segment (approximated: the head to the tip) */
    calcAnim(m: mat4) {
        this.mHeadPos.set(fr(m[12]), fr(m[13]), fr(m[14]));
        this.mHeadDir.set(fr(m[0]), fr(m[1]), fr(m[2]));
        if (this.mState === TS.IDLE) { this.tipMtx = null; return; }
        const tip = new V3(this.mTipPos.x, fadd(this.mTipPos.y, 50), this.mTipPos.z);
        let dx = tip.x - this.mHeadPos.x, dz = tip.z - this.mHeadPos.z;
        const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        // tmp = up x dir
        const r = mtx();
        r[0] = dz; r[1] = 0; r[2] = dx; r[3] = tip.x;
        r[4] = 0; r[5] = 1; r[6] = 0; r[7] = tip.y;
        r[8] = -dx; r[9] = 0; r[10] = dz; r[11] = tip.z;
        this.tipMtx = r;
    }
}

// ---------------------------------------------------------------- TYoshi
export class Yoshi {
    mState: number = YS.EGG; unk1 = 0; unk2 = 0; unk4 = 7200; unk6 = 7200; unk8 = 21300; unkC = 21300;
    mMario: YoshiMario;
    mLastTranslation = new V3(); mTranslation = new V3(); unk2C = 0;
    mActor: MActor | null = null;
    mTongue = new YoshiTongue();
    mJointIdxTongue = -1; mJointIdxFootL = -1; mJointIdxFootR = -1; mJointIdxCenter = -1;
    /** unk5C: the upper body's (joint 18's) eat / eat_end frames; unk54 / unk58 which is on (0 none, 1 eat, 2 eat_end) */
    unk5C = new FrameCtrl(); upperCalc = 0;
    mEggRotSpeed = 0; unk72 = 0x180;
    unk74 = new V3(); unk80 = fr(0.01);
    /** unk84: the body colour drawn (it eases to bodyColor[mType]) */
    unk84 = new V3(0x40, 0xA1, 0x24); unk90 = 160;
    unk94 = new RidingInfo();
    unk98 = 20; unk9C = 30; unkA0 = fr(0.1); unkA4 = fr(0.045);
    mFlutterState = 2; unkB9 = 0; mFlutterTimer = 0; mMaxFlutterTimer = 120; unkBE = 0;
    mMaxVSpdStartFlutter = -5; mFlutterAcceleration = fr(1.2);
    /** the juice he holds: 0 none (water), 1 orange, 2 purple, 3 pink */
    mType = 0; unkD1 = 0; unkD2 = 0;
    /** unkD4: FLUDD's tank with his juice (the Yoshi nozzle's mCurrentWater on changeNozzle) */
    unkD4 = 2000; unkD8 = 2000;
    unkDC = 0; unkDE = 0; unkE0 = 0; unkE4 = fr(0.1); unkE8 = 120; unkEA = 240; unkEC = 4;
    mEgg: any = null;
    mBtpIndex = 4; unkF6 = -1; unkF8 = -1;
    unkFC = new V3(); unk108 = new V3(); unk114 = 80;
    /** the walk/run motion blend (setBckMotionBlendRatio: the old (walk's) weight) */
    blendRatio = 0;
    private joints: mat4[] | null = null;
    private skel: Skeleton | null = null;

    constructor(m: YoshiMario) { this.mMario = m; this.init(m); }

    // ---------------------------------------------------------------- init
    init(m: YoshiMario) {
        this.mMario = m;
        this.mState = YS.EGG; this.unk1 = 0; this.unk2 = this.unk6; this.unk4 = 7200; this.unk6 = 7200; this.unk8 = 21300; this.unkC = this.unk8;
        this.mTranslation.set(0, 0, 0); this.unk2C = 0; this.mEggRotSpeed = 0; this.unk72 = 0x180;
        if (yoshiArchive) {
            this.mActor = new MActor('yoshi/yoshi_model.bmd', new AnmData('yoshi', yoshiFiles));
            this.skel = Skeleton.of(yoshiFiles.scene('yoshi/yoshi_model.bmd'));
            const j = (n: string) => (this.skel ? this.skel.index(n) : -1);
            this.mJointIdxTongue = j('null_tongue') & 0xFF; this.mJointIdxFootL = j('jnt_foot_L') & 0xFF; this.mJointIdxFootR = j('jnt_foot_R') & 0xFF; this.mJointIdxCenter = j('center') & 0xFF;
            this.unkF6 = j('jnt_mouth'); this.unkF8 = j('jnt_neck_2');
        }
        // unk5C: setFrame(start), rate 1, attribute 0 (once), rate 0.5
        this.unk5C.init(0); this.unk5C.attr = FC_ONCE; this.unk5C.rate = fr(0.5);
        this.mTongue.init(this);
        this.unk80 = fr(0.01); this.unk84.set(0x40, 0xA1, 0x24); this.unk90 = 160;
        this.unk98 = 20; this.unk9C = 30; this.unkA0 = fr(0.1); this.unkA4 = fr(0.045);
        this.mFlutterState = 2; this.mFlutterTimer = 0; this.mMaxFlutterTimer = 120; this.mMaxVSpdStartFlutter = -5; this.mFlutterAcceleration = fr(1.2);
        this.mType = 0; this.unkD8 = 2000; this.unkD4 = this.unkD8;
        this.unkDC = 0; this.unkDE = 0; this.unkE0 = 0; this.unkE4 = fr(0.1); this.unkE8 = 120; this.unkEA = 240; this.unkEC = 4;
        this.mBtpIndex = 4; this.mEgg = null;
        this.unkFC.set(0, 0, 0); this.unk108.set(0, 0, 0); this.unk114 = 80;
        const fc = this.getFrameCtrl(); if (fc) fc.rate = fr(0.5);
        this.changeAnimation(YB.WAIT_ALONE);
    }
    initInLoadAfter() { this.mTongue.initInLoadAfter(this.mMario.world); }

    // ---------------------------------------------------------------- accessors
    isHatched() { return this.mState !== YS.EGG; }
    /** (mTranslation, as the stage's objects ask an actor's place: enemies/fruitsboat.ts) */
    get pos() { return this.mTranslation; }
    onYoshi() { return this.mState === YS.MOUNTED; }
    getTranslation() { return this.mTranslation; }
    getFrameCtrl(): FrameCtrl | null { return this.mActor ? this.mActor.getFrameCtrl(ANM_BCK) : null; }
    curBck() { return this.mActor ? this.mActor.getCurAnmIdx(ANM_BCK) : -1; }
    curAnmEndsNext() { return this.mActor ? this.mActor.curAnmEndsNext(ANM_BCK) : true; }
    private setBck(i: number) { if (this.mActor) this.mActor.setBckFromIndex(i); }
    /** getAnmMtx(j) after the last calcAnim */
    anmMtx(j: number): mat4 | null { return this.joints && j >= 0 ? this.joints[j] || null : null; }
    /** the tongue joint's matrix as a 3x4 (TWaterGun's emit matrix for the Yoshi nozzle) */
    getTongueMtx(): Mtx | null {
        const m = this.anmMtx(this.mJointIdxTongue);
        if (!m) return null;
        const r = mtx();
        r[0] = m[0]; r[1] = m[4]; r[2] = m[8]; r[3] = m[12];
        r[4] = m[1]; r[5] = m[5]; r[6] = m[9]; r[7] = m[13];
        r[8] = m[2]; r[9] = m[6]; r[10] = m[10]; r[11] = m[14];
        return r;
    }
    getMtxPtrFootL() { return this.anmMtx(this.mJointIdxFootL); }
    getMtxPtrFootR() { return this.anmMtx(this.mJointIdxFootR); }
    /** getEmitPosDir: the tongue joint's place and its x axis */
    getEmitPosDir(pos: V3, dir: V3) {
        const m = this.anmMtx(this.mJointIdxTongue);
        if (!m) { pos.set(this.mTranslation); dir.set(JMASSin(this.mEggRotSpeed), 0, JMASCos(this.mEggRotSpeed)); return; }
        pos.set(fr(m[12]), fr(m[13]), fr(m[14]));
        dir.set(fr(m[0]), fr(m[1]), fr(m[2]));
    }
    setEggYoshiPtr(e: any) { this.mEgg = e; }

    // ---------------------------------------------------------------- animation
    thinkBtp(id: number) {
        let b = 4;
        if (id === 0) b = 0; else if (id === 1) b = 1; else if (id === 9) b = 2; else if (id === 25) b = 3;
        this.mBtpIndex = b;
    }
    changeAnimation(id: number) {
        if (id !== this.curBck()) { this.setBck(id); this.thinkBtp(id); }
    }
    appear() { }
    appearFromEgg(p: V3, yrotDeg: number, egg: any) {
        const M = this.mMario;
        this.mLastTranslation.set(p);
        this.mTranslation.set(p);
        this.mTranslation.y = fadd(this.mTranslation.y, 1);
        this.mEggRotSpeed = s16(Math.trunc(fmul(yrotDeg, fr(65536 / 360))));
        this.mState = YS.HATCHING;
        this.changeAnimation(YB.BORN);
        const fruit = egg.unk150 as HitActor | null;
        if (fruit) {
            if (M.mHeldObject === fruit) {
                const held = M.mHeldObject;
                held.receiveMessage(M.mFloorHitActor, MSG.DETACH);
                held.holder = null;
                M.mHeldObject = null;
            }
            fruit.receiveMessage(M.mFloorHitActor, MSG.UNKB);
            this.doEat(fruit.actorType);
        }
        this.unkC = this.unk8;
        this.mEgg = egg;
        this.unk2 = this.unk4;
        M.world.events.push({ t: M.world.tickCount, kind: 'yoshiHatch', data: { p: p.clone(), yaw: yrotDeg, fruit: fruit ? fruit.actorType : 0 } });
        return true;
    }
    disappear() {
        if (!this.isHatched()) return false;
        const M = this.mMario;
        if (this.mState === YS.MOUNTED) M.getOffYoshi(true);
        if (M.checkFlag(MF.IN_ANY_WATER)) { this.mState = YS.DROWNING; this.changeAnimation(YB.WATER_DIE); }   // MARIO_FLAG_IN_ANY_WATER
        else this.mState = YS.DYING;
        this.mType = 0;
        this.unk2 = 30;
        M.world.events.push({ t: M.world.tickCount, kind: 'yoshiGone', data: { p: this.mTranslation.clone(), drown: this.mState === YS.DROWNING } });
        return true;
    }
    kill() { this.disappear(); }
    ride() {
        this.mState = YS.MOUNTED;
        this.changeAnimation(YB.RIDE);
        const W = this.mMario.world.water as any;
        if (W) W.juice = this.mType;
        // (MSD_SE_YV_DELICIOUS, the Yoshi percussion, TMarDirector::fireRideYoshi: sound / demo side)
    }
    getOff(knockedOff: boolean) {
        if (this.mState !== YS.MOUNTED) return;
        this.unk2C = 0;
        this.mState = YS.UNMOUNTED;
        this.unk2 = this.unk4;
        this.changeAnimation(knockedOff ? YB.DAMAGE : YB.WAIT_ALONE);
        rideMoveCalcLocalPos(this.unk94, this.mTranslation);
        if (VERSION.pal) this.mTongue.mState = TS.IDLE;   // (PAL: the tongue back to idle)
    }
    /** PAL's movement: on through floors only Mario passes, down to real ground (at most five more probes) */
    private probeThrough(w: World, gy: number, g: any): [number, any] {
        for (let i = 0; i < 5; i++) {
            if (!g.isMarioThrough() || g.isWaterSurface()) break;
            [gy, g] = w.checkGround(this.mTranslation.x, fsub(gy, 1), this.mTranslation.z);
        }
        return [gy, g];
    }
    thinkJumpEnd(cur: number) { return cur === YB.JUMP_FALL ? YB.JUMP_END : -1; }
    /** TMario::getSideWalkValues: [type, the anim rate, the side speed] */
    private sideWalk(): [number, number] {
        const M = this.mMario;
        const diff = s16(M.mIntendedYaw - M.mFaceAngle.y);
        const side = fmul(fmul(M.mIntendedMag, JMASSin(diff)), M.mRunParams.mPumpingSlideSp);
        if (side === 0) return [0, M.getMotionFrameCtrl().rate];
        let r = fmul(side, M.mRunParams.mPumpingSlideAnmSp);
        if (r < 0) r = -r;
        return [diff > 0 ? 1 : 2, r];
    }
    thinkAnimation() {
        const M = this.mMario;
        let rate = M.getMotionFrameCtrl().rate;
        let cur = this.curBck();
        let nw = cur;
        const st = M.mStatus >>> 0;
        if (st & ST.FLAG_RUNNING) {
            const je = this.thinkJumpEnd(cur);
            if (je >= 0) nw = je;
            else {
                nw = YB.RUN;
                if (st === ST.CATCH || st === ST.OIL_SLIP || st === ST.OIL_SLOPE || (st & ST.FLAG_UNK40000)) nw = YB.SLIDE_POSE;
            }
        } else if (st & ST.FLAG_JUMPING) {
            const fb = () => (M.mVel.y > 0 ? YB.JUMP : YB.JUMP_FALL);
            if (this.mFlutterState === 1) nw = YB.HOLD_JUMP;
            else if (st === ST.HIP_DROP) {
                switch (M.mStatusState) { case 0: case 1: nw = YB.HIP_START; break; case 2: case 3: nw = YB.HIP_POSE; break; default: nw = fb(); }
            } else nw = fb();
        } else if ((st & ST.FLAG_UNK200) && (st === ST.CATCH_LOST || st === ST.BRAKE_END || st === ST.SLIP_END)) {
            nw = YB.SLIDE_END;
        } else {
            let done = false;
            if (st & ST.FLAG_UNK8000) {
                if (M.mGamePad.checkMeaning(M_L)) {
                    const [type, r] = this.sideWalk();
                    rate = r;
                    if (type === 0) { nw = YB.WAIT; done = true; } else if (type === 1) { nw = YB.SIDEWALK_L; done = true; } else if (type === 2) { nw = YB.SIDEWALK_R; done = true; }
                }
                if (!done && M.mGamePad.checkMeaning(M_R)) { nw = YB.PIVOT; done = true; }
            }
            if (!done) {
                if (st === ST.HIP_ATTACK_END) nw = YB.HIP_END;
                else if (st === ST.WIN_DEMO) nw = YB.DEMO_SHINE_GET;
                else nw = YB.WAIT;
            }
        }
        if (cur === YB.WALK) cur = YB.RUN;
        if (nw === YB.WALK) nw = YB.RUN;
        if (nw !== cur) {
            if (nw === YB.RUN) { this.setBck(YB.WALK); this.setBck(YB.RUN); }
            else this.setBck(nw);
            this.thinkBtp(nw);
        }
        if (nw === YB.RUN) {
            const base = this.unk98;
            let ratio = fr(fsub(M.mForwardVel, base) / fsub(this.unk9C, base));
            if (ratio < 0) ratio = 0;
            if (ratio > 1) ratio = 1;
            this.blendRatio = fsub(1, ratio);
            if ((M.mStatus >>> 0) === ST.OIL_RUN) rate = M.getMotionFrameCtrl().rate;
            else rate = fmadd(this.unkA4, M.mForwardVel, this.unkA0);
        } else this.blendRatio = 0;
        const fc = this.getFrameCtrl(); if (fc) fc.rate = rate;
    }
    thinkUpper() {
        if (this.mState !== YS.MOUNTED || !this.mActor) return;
        const fc = this.unk5C;
        fc.update();
        const eatLen = this.bckLen(YB.EAT), endLen = this.bckLen(YB.EAT_END);
        const G = this.mMario.mWaterGun;
        if (this.mTongue.mState !== TS.IDLE || (G && G.isEmitting && G.isEmitting())) {
            if (this.upperCalc !== 1) { fc.frame = fc.start; fc.rate = 1; fc.end = eatLen; fc.frame = 0; this.upperCalc = 1; }
        } else {
            if (this.upperCalc === 1) { fc.frame = fc.start; fc.rate = 1; fc.end = endLen; fc.frame = 0; this.upperCalc = 2; }
            else if (this.upperCalc === 2) { if (fc.state & 3) this.upperCalc = 0; }
        }
    }
    private bckLen(i: number) { const a = this.mActor && this.mActor.data.anms[ANM_BCK][i]; return a ? a.frameMax : 1; }
    emitTongue() {
        const pos = new V3(), dir = new V3();
        this.getEmitPosDir(pos, dir);
        const vel = this.mMario.mVel.clone();
        this.mTongue.emit(pos, dir, vel);
        let tries = 0;
        do {
            this.mTongue.movement();
            const T = this.mTongue.mTipPos;
            if (lengthJ(fsub(T.x, pos.x), fsub(T.y, pos.y), fsub(T.z, pos.z)) > this.unk90) break;
            ++tries;
        } while (tries < 10);
    }
    /** the next search's wait: (s16)((f32)(unkEA - unkE8) * MsRandF() + (f32)unkE8) (fmadds) */
    private searchWait() { return s16(Math.trunc(MsRandF(this.unkE8, this.unkEA))); }
    doSearch() {
        switch (this.unkDC) {
            case 0:
                this.unkDE = s16(this.unkDE - 1);
                if (this.unkDE <= 0) {
                    const t = this.mTongue.findTarget(false, false);
                    if (t) {
                        this.unkE0 = matan(fsub(t.pos.z, this.mTranslation.z), fsub(t.pos.x, this.mTranslation.x));
                        this.unkDC = 1;
                        return;
                    }
                    this.unkDE = this.searchWait();
                }
                return;
            case 1: {
                const prev = this.mEggRotSpeed;
                const delta = s16(Math.trunc(fmul(this.unkE4, s16(this.unkE0 - prev))));
                this.mEggRotSpeed = s16(prev + delta);
                if (delta > -256 && delta < 256) { this.emitTongue(); this.unkDC = 3; this.changeAnimation(YB.EAT); }
                break;
            }
            case 2:
                if (this.mTongue.findTarget(false, true)) { this.emitTongue(); this.unkDC = 3; }
                else { this.unkDE = this.searchWait(); this.unkDC = 0; }
                break;
            case 3:
                this.thinkEat();
                if (this.mTongue.mState === TS.IDLE) { this.unkDE = this.searchWait(); this.unkDC = 0; this.changeAnimation(YB.WAIT_ALONE); }
                break;
        }
    }
    doEat(type: number) {
        let t = -1;
        switch (type) {
            case AT.FRUIT_PAPAYA: case AT.FRUIT_PINE: t = 1; break;
            case AT.FRUIT_DURIAN: case AT.RED_PEPPER: t = 2; break;
            case AT.FRUIT_BANANA: case AT.FRUIT_COCONUT: t = 3; break;
        }
        if (t >= 0) {
            this.mType = t;
            this.unkC = this.unk8;
            this.mMario.world.events.push({ t: this.mMario.world.tickCount, kind: 'yoshiEat', data: { type, juice: t } });
        }
    }
    thinkEat() {
        if (this.mTongue.mActorTypeInMouth !== 0) {
            this.doEat(this.mTongue.mActorTypeInMouth);
            this.mTongue.mActorTypeInMouth = 0;
        }
    }
    /** thinkHoldOut: the flutter (MarioPhysics fallProcess, ridden) */
    thinkHoldOut() {
        const M = this.mMario;
        switch (this.mFlutterState) {
            case 0:
                if (M.mVel.y < this.mMaxVSpdStartFlutter && M.mGamePad.checkMeaning(M_A)) this.mFlutterState = 1;
                break;
            case 1:
                if (this.mFlutterTimer !== 0) { this.mFlutterTimer = (this.mFlutterTimer - 1) & 0xFFFF; M.mVel.y = fadd(M.mVel.y, this.mFlutterAcceleration); }
                else this.mFlutterState = 2;
                if (!M.mGamePad.checkMeaning(M_A)) this.mFlutterState = 2;
                break;
            case 2: this.mFlutterTimer = 0; break;
        }
    }

    // ---------------------------------------------------------------- the tick (TMario::perform: after the water gun's move)
    movement() {
        const M = this.mMario, w = M.world;
        if (!w.demoMode && !w.talkMode) {
            if (!M.checkStatusType(ST.FLAG_UNK1000) && this.unkC > 0) this.unkC -= 1;
        }
        this.thinkEat();
        switch (this.mState) {
            case YS.HATCHING:
                if (this.curAnmEndsNext()) { this.mState = YS.UNMOUNTED; this.changeAnimation(YB.WAIT_ALONE); }
                break;
            case YS.UNMOUNTED: {
                if (this.curAnmEndsNext()) this.setBck(YB.WAIT_ALONE);
                const rot = { v: fmul(this.mEggRotSpeed, fr(0.0054931640625)) };
                rideMoveByGroundActor(w, this.unk94, this.mTranslation, rot);
                this.mEggRotSpeed = s16(Math.trunc(fmul(fr(182.04444885253906), rot.v)));
                let [gy, g] = w.checkGround(this.mTranslation.x, fadd(200, this.mTranslation.y), this.mTranslation.z);
                if (VERSION.pal) [gy, g] = this.probeThrough(w, gy, g);
                this.unk2C = fsub(this.unk2C, M.mJumpParams.mGravity);
                this.mTranslation.y = fadd(this.mTranslation.y, this.unk2C);
                if (gy > this.mTranslation.y) {
                    if (g.isIllegal() || g.isWaterSurface() || g.isDeathPlane()) { this.disappear(); break; }
                    this.mTranslation.y = gy; this.unk2C = 0;
                }
                this.doSearch();
                if (this.unkC <= 0) this.disappear();
                break;
            }
            case YS.UNK7: {
                const prev = this.mEggRotSpeed;
                this.mEggRotSpeed = s16(Math.trunc(fmadd(this.unkE4, s16(M.mFaceAngle.y - prev), prev)));
                break;
            }
            case YS.MOUNTED:
                this.mTranslation.set(M.pos);
                this.mEggRotSpeed = M.mFaceAngle.y;
                if (M.mGamePad.checkFrameMeaning(M_B)) this.emitTongue();
                if (this.unkC <= 0) this.disappear();
                break;
            case YS.UNK1:
                this.unk2 -= 1;
                if (this.unk2 <= 0) { this.mState = YS.UNMOUNTED; this.changeAnimation(YB.WAIT_ALONE); this.unk2 = this.unk4; }
                break;
            case YS.DROWNING:
                if (this.curAnmEndsNext()) { this.mState = YS.UNK5; this.unk2 = 30; }
                break;
            case YS.DYING: this.mState = YS.UNK5; this.unk2 = 30; break;
            case YS.UNK5:
                this.mState = YS.EGG;
                if (this.mEgg && this.mEgg.startFruit) this.mEgg.startFruit();
                break;
        }
        if (this.isHatched()) {
            const C = YOSHI_BODY_COLOR[this.mType];
            this.unk84.x = fadd(this.unk84.x, fmul(this.unk80, fsub(C[0], this.unk84.x)));
            this.unk84.y = fadd(this.unk84.y, fmul(this.unk80, fsub(C[1], this.unk84.y)));
            this.unk84.z = fadd(this.unk84.z, fmul(this.unk80, fsub(C[2], this.unk84.z)));
            this.mTongue.movement();
            let [gy, g] = w.checkGround(this.mTranslation.x, fadd(200, this.mTranslation.y), this.mTranslation.z);
            if (VERSION.pal) [gy, g] = this.probeThrough(w, gy, g);
            if (this.mState === YS.UNMOUNTED && gy > this.mTranslation.y) {
                if (g.isWaterSurface()) this.disappear();
                else { this.mTranslation.y = gy; this.unk2C = 0; }
            }
        }
        if (M.onYoshi()) { const W = w.water as any; if (W) W.juice = this.mType; }
        const c = this.anmMtx(this.mJointIdxCenter);
        if (c) this.unk74.set(c[12], c[13], c[14]);
    }
    /** TMario::calcAnim's part (MarioDraw.cpp): the run's blend with Mario's, the rate his or 0.5 */
    marioCalcAnim(marioBlend: number) {
        const fc = this.getFrameCtrl();
        if (!fc) return;
        if (this.curBck() === YB.RUN) { this.blendRatio = marioBlend; fc.rate = this.mMario.getMotionFrameCtrl().rate; }
        else { this.blendRatio = 0; fc.rate = fr(0.5); }
    }
    calcAnim() {
        const M = this.mMario;
        const m = mtx();
        switch (this.mState) {
            case YS.HATCHING: case YS.DROWNING: case YS.UNMOUNTED: case YS.UNK7: case YS.UNK5:
                j3dTRMtx(m, 0, this.mEggRotSpeed, 0, this.mTranslation.x, this.mTranslation.y, this.mTranslation.z); break;
            case YS.MOUNTED: this.thinkAnimation(); m.set(M.mModel.baseTR); break;
            case YS.UNK1: j3dTRMtx(m, 0, this.mEggRotSpeed, 0, this.mTranslation.x, FMA(100, this.unk2, this.mTranslation.y), this.mTranslation.z); break;
        }
        if (!this.isHatched() || !this.mActor) return;
        this.thinkUpper();
        this.mActor.frameUpdate();
        this.baseTR = m;
        this.calcJoints(m);
        const t = this.anmMtx(this.mJointIdxTongue);
        if (t) this.mTongue.calcAnim(t);
        const a = this.anmMtx(this.unkF6), b = this.anmMtx(this.unkF8);
        if (a) this.unkFC.set(a[12], a[13], a[14]);
        if (b) this.unk108.set(b[12], b[13], b[14]);
    }
    baseTR: Mtx = mtx();
    /**
     * TYoshi::entry (the frame's draw cue, TMario::perform's CUE_ENTRY): the colour write, models and
     * shadow are the viewer's; what it does to the game is the juice running out — under 600 ticks
     * left (when the body starts blinking) mType goes back to 0.
     */
    entry() {
        if (!this.isHatched()) return;
        if (this.unkC < 600) this.mType = 0;
    }
    private calcJoints(base: Mtx) {
        const sk = this.skel, A = this.mActor!;
        if (!sk) { this.joints = null; return; }
        const bck = (i: number) => { const a = A.data.anms[ANM_BCK][i]; return a ? parseBCK(yoshiFiles.scene('yoshi/' + a.name + '.bck')) : null; };
        const cur = this.curBck(), f = this.getFrameCtrl()!.frame;
        const old = cur === YB.RUN && this.blendRatio > 0 ? { anm: bck(YB.WALK), frame: f } : null;
        const upper = this.upperCalc ? { joint: 18, anm: { anm: bck(this.upperCalc === 1 ? YB.EAT : YB.EAT_END), frame: this.unk5C.frame } } : null;
        const G = this.mMario.mWaterGun;
        const gun = G && G.getCurrentNozzle ? G.getCurrentNozzle().getGunAngle() : 0;
        const post = gun ? (j: number, mm: mat4) => { if (j === 21) rotZ(mm, gun * Math.PI / 32768); } : undefined;
        this.joints = jointMatricesBlend(sk, { anm: cur >= 0 ? bck(cur) : null, frame: f }, old, this.blendRatio, false, base, [1, 1, 1], this.joints || [], null, post, upper);
    }
    /** What the viewer draws: null while he's an egg. */
    viewState() {
        if (!this.isHatched() || !this.mActor) return null;
        const fc = this.getFrameCtrl();
        return { state: this.mState, x: this.mTranslation.x, y: this.mTranslation.y, z: this.mTranslation.z, yaw: this.mEggRotSpeed, bck: this.curBck(), frame: fc ? fc.frame : 0,
            blend: this.blendRatio, colour: [this.unk84.x, this.unk84.y, this.unk84.z], type: this.mType, timer: this.unkC };
    }
}
/** MTXConcat(m, RotZ(a), m) on a column-major world matrix */
function rotZ(m: mat4, a: number) {
    const c = Math.cos(a), s = Math.sin(a);
    for (let i = 0; i < 3; i++) { const x = m[i], y = m[4 + i]; m[i] = x * c + y * s; m[4 + i] = y * c - x * s; }
}
