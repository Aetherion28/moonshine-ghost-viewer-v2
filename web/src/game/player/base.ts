// TMario (Player/Mario.hpp): its fields, parameters, the map queries it makes and its animation model,
// as the rest of the port (move.ts ... mario.ts, one class per decomp source file, each extending the
// last) builds on. A simulated Mario: the game's own state machine run from a pad (TMarioControllerWork)
// that something else fills in (TEnemyMario's AI and its recorded pad replays).
//
// Floats: every f32 the game stores is rounded to f32 where it's stored (fr); intermediate products
// are kept in double, which the game (single-precision FPU, fused multiply-adds) doesn't always.
// s16 angles are wrapped with s16().

import { fr, V3, s16, JMASSin, JMASCos, matan, mtx, Mtx } from '../math.js';
import { World, TakeActor, HitActor, Params, PSchema, FrameCtrl, FC_LOOP } from '../engine.js';
import { BGCheckData, WallCheck, DONT_MOVE_XZ } from '../collision.js';
import { Skeleton, parseBCK, jointMatrices } from '../skeleton.js';
import type { mat4 } from 'gl-matrix';
import * as P from './params.js';
import { S, MF, A, ANIME_DATA, ANIME_FILES } from './tables.js';
import { AT } from '../actortypes.js';

export { S, MF, A };
export type Bg = BGCheckData;

// ---------------------------------------------------------------- TBGCheckData's predicates (Map/MapData.hpp)
const T = (d: Bg) => d.bgType;
export const bg = {
    isUnk1: (d: Bg) => [0x1, 0x4001, 0x8001, 0xC001].includes(T(d)),
    isUnk2: (d: Bg) => T(d) === 0x2 || T(d) === 0x8002,
    isUnk3: (d: Bg) => T(d) === 0x3 || T(d) === 0x8003,
    isSlider: (d: Bg) => T(d) === 0xC || T(d) === 0x800C || T(d) === 0xA00C,
    isWetGround: (d: Bg) => [0x4, 0x4004, 0x8004, 0xC004].includes(T(d)),
    isNoLedgeGrab: (d: Bg) => [0x6, 0x4006, 0x8006, 0xC006].includes(T(d)),
    isNoWallJump: (d: Bg) => T(d) === 0x5 || T(d) === 0x8005,
    isBounceOnLanding: (d: Bg) => T(d) === 0x7 || T(d) === 0x8007,
    isThing2: (d: Bg) => T(d) === 0x108 || T(d) === 0x8 || T(d) === 0x8008,
    isThing3: (d: Bg) => T(d) === 0x9 || T(d) === 0x8009,
    isThing5: (d: Bg) => T(d) === 0xB || T(d) === 0x800B || T(d) === 0x103 || T(d) === 0x101,
    isSand: (d: Bg) => [0x701, 0x4701, 0x8701, 0xC701].includes(T(d)),
    isUnderground: (d: Bg) => T(d) === 0x106 || T(d) === 0x108,
    isOob: (d: Bg) => T(d) === 0x600,
    isUnk300: (d: Bg) => T(d) === 0x300,
    isCamNoclipUnk10B: (d: Bg) => T(d) === 0x810B,
    isGroundPoundToPassThrough: (d: Bg) => T(d) === 0x107,
    isFence: (d: Bg) => T(d) === 0x10A,
    isShadow: (d: Bg) => (T(d) & 0x4000) !== 0,
    /** getActiveJumpPower (a banana tree's is TMapObjTree::mBananaTreeJumpPower) */
    activeJumpPower: (d: Bg) => (d.actor && d.actor.isActorType && d.actor.isActorType(AT.BANANA_TREE) ? 1000 : d.data),
};

/** TMarioControllerWork */
export class ControllerWork {
    static readonly UNK10 = 0x10; static readonly R = 0x20; static readonly A = 0x100; static readonly B = 0x200; static readonly L = 0x4000;
    mStickHS16 = 0; mStickVS16 = 0; mInput = 0; mFrameInput = 0; mAnalogRU8 = 0; mAnalogLU8 = 0;
    mStickH = 0; mStickV = 0; mStickDist = 0; mAnalogR = 0; mAnalogL = 0;
    isAHit() { return (this.mFrameInput & ControllerWork.A) !== 0; }
    isBHit() { return (this.mFrameInput & ControllerWork.B) !== 0; }
    isAPressed() { return (this.mInput & ControllerWork.A) !== 0; }
    isBPressed() { return (this.mInput & ControllerWork.B) !== 0; }
}

/** Mario's files (data/mario.szs: bck/, bas/, bmd/...): set once from the disc. */
let marioArchive: ((path: string) => Uint8Array | null) | null = null;
export function setMarioArchive(f: ((path: string) => Uint8Array | null) | null) { marioArchive = f; }
export function marioFile(path: string) { return marioArchive ? marioArchive(path.replace(/^\/?mario\//i, '').toLowerCase()) : null; }

/** A BCK's frame count and loop mode (J3DAnmTransform::getFrameMax / getAttribute). */
const bckInfo = new Map<number, [number, number]>();
export function marioBckInfo(i: number): [number, number] {
    let r = bckInfo.get(i);
    if (!r) {
        const b = marioFile(`bck/ma_${ANIME_FILES[i]}.bck`);
        r = b ? [new DataView(b.buffer, b.byteOffset).getUint16(0x20 + 0x0A), b[0x20 + 0x08]] : [1, FC_LOOP];
        bckInfo.set(i, r);
    }
    return r;
}

/**
 * M3UModelMario as Mario's movement reads it: its three frame controls (0 the body's motion, 1 the
 * upper body's, 2 the texture patterns) and the BCK on the body and upper-body slots.
 */
export class MarioModel {
    fc = [new FrameCtrl(), new FrameCtrl(), new FrameCtrl()];
    /** unk24[i].unk4[0]: the BCK index on the body (0) and upper body (1) */
    anm = [-1, -1];
    /** unk24[1].unk3 (0xff / -1: no upper-body animation) */
    upperCalc = -1;
    blendRatio = 0;
    baseTR: Mtx = mtx();
    private joints: mat4[] | null = null;
    private jointsKey = '';
    /** changeMtxCalcSIAnmBQAnmTransform(slot, 0, bck) */
    changeAnm(slot: number, bck: number) {
        if (this.anm[slot] === bck) return;
        this.anm[slot] = bck;
        this.fc[slot === 0 ? 0 : 1].init(marioBckInfo(bck)[0]);
    }
    /** updateInMotion: each slot's frame control */
    update() {
        this.fc[0].update();
        this.fc[1].update();
        this.joints = null;
    }
    /** getAnmMtx(j): joint j's world matrix after the last calc (the body's BCK only: the motion blend isn't applied). */
    anmMtx(j: number): mat4 | null {
        const key = this.anm[0] + '|' + this.fc[0].frame + '|' + Array.from(this.baseTR).join(',');
        if (!this.joints || key !== this.jointsKey) {
            const sk = Skeleton.of(marioFile('bmd/ma_mdl1.bmd'));
            if (!sk) return null;
            const b = this.anm[0] >= 0 ? marioFile(`bck/ma_${ANIME_FILES[this.anm[0]]}.bck`) : null;
            this.joints = jointMatrices(sk, b ? parseBCK(b) : null, this.fc[0].frame, this.baseTR, [1, 1, 1]);
            this.jointsKey = key;
        }
        return this.joints[j] || null;
    }
    jointIndex(name: string) { const sk = Skeleton.of(marioFile('bmd/ma_mdl1.bmd')); return sk ? sk.index(name) : -1; }
}

function load<S extends PSchema>(w: World, path: string, schema: S) { return new Params(path, w.files).read(schema); }

/** TBGWallCheckRecord */
export function wallRecord(x: number, y: number, z: number, r: number, max: number, flags: number): WallCheck {
    return { center: [x, y, z], radius: r, maxResults: max, flags, results: [] };
}

export abstract class MarioBase extends TakeActor {
    world: World;
    // ---- 0x74.. (Mario.hpp's field order)
    mInput = 0; unk78 = 0;
    mStatus = 0; mPrevStatus = 0; mStatusState = 0; mStatusTimer = 0; mStatusArg = 0;
    mIntendedMag = 0; mIntendedYaw = 0;
    mFaceAngle = { x: 0, y: 0, z: 0 }; mModelFaceAngle = 0; unk9C = 0; unk9E = 0; mDizzyTimer = 0;
    mVel = new V3(); mForwardVel = 0; mSlideVelX = 0; mSlideVelZ = 0;
    unkBC = 0; mDashSpeed = 0; mDashTimer = 0;
    mWallPlane: Bg | null = null; mRoofPlane!: Bg; mGroundPlane!: Bg; mWaterFloor!: Bg;
    /** x: the roof's height, y: the ground's, z: the water surface's */
    mFloorPosition = new V3();
    mSlopeAngle = 0; unkF6 = 0; mLightID = 0; mAnimationId = 0xFFFF;
    unk104 = 0;
    unk108 = new ControllerWork(); unk10C = 0; unk110 = 0;
    unk114 = 0; mFlag = 0; mPrevFlag = 0;
    mHealth = 8; mHotTimer = 0; mHotTimerMax = 0; unk122 = 0;
    mAir = 0; mMaxAir = 0; mDirty = 0; mOilBrake = 1; mDirtyTimer = 0; unk140 = 0;
    mInvincibilityFrames = 0; mFreezeTimer = 0; mFreezeImmunityTimer = 0;
    unk15C = 50;
    unk160 = new V3(); mHeadPos = new V3(); mCenterPos = new V3(); mRightHandPos = new V3(); mWaterRipplePos = new V3();
    mHeadMtx: Mtx = mtx();
    mPrevPosition = new V3(); unk2A8 = new V3(); unk2B4 = { x: 0, y: 0, z: 0 }; mOobKillTimer = 0; unk2BC = 0;
    /** unk2C0: the live actor he rides */
    unk2C0: any = null; unk2F4 = new V3(); unk300 = new V3(); unk30C = 0;
    unk314 = 0;
    mPumpAnmRate = 0; mStandingOnGraffitoTimer = 0; mPollutionTypeStandingOn = 0;
    mFootPrintTimer = 0; mWetWaterParticleTimer = 0;
    mSinkTimer = 0; unk36C = 0; unk370 = 0; unk374 = 0; unk378 = 0; mPumpCooldown = 0;
    mUpperState = 5;
    /** unk384: the last receiveMessage sender (what he takes) */
    unk384: HitActor | null = null;
    mPlayerType = 0; mHolderHeightDiff = 0;
    mModel = new MarioModel();
    mJointIdCenter = 0; mJointIdChest = 0; mJointIdChnChest = 0; mJointIdArmR1 = 0; mJointIdArmL1 = 0; mJointIdHandR = 0; mJointIdHandL = 0;
    mJointIdChnFootR = 0; mJointIdFootR = 0; mJointIdChnFootL = 0; mJointIdFootL = 0; mJointIdHead = 0; mJointIdMHead = 0;
    unk414 = new V3(0, 0, 1);
    /** unk530 (60): the stick angle history, unk534 its count */
    unk530 = new Int16Array(60); unk534 = 0; unk536 = 0; unk538 = 0; unk53A = 0; unk53B = 0;
    unk55C = 0;
    mHeldObject: any = null;
    /** mHolder (TTakeActor::mHolder) is `holder` */
    // ---- parameters
    mDeParams; mBodyAngleParamsFree; mBodyAngleParamsWaterGun; mAttackParamsFencePunch; mAttackParamsKickRoof;
    mJumpParams; mRunParams; mSwimParams; mHangingParams; mHangRoofParams; mWireParams;
    mPullParamsBGBeak; mPullParamsBGTentacle; mPullParamsBGFireWanWanBossTail; mPullParamsFireWanWanTail; mBarParams;
    mSurfingParamsWaterRed; mSurfingParamsGroundRed; mSurfingParamsWaterYellow; mSurfingParamsGroundYellow; mSurfingParamsWaterGreen; mSurfingParamsGroundGreen;
    mHoverParams; mDivingParams; mYoshiParams; mWaterEffectParams; mControllerParams; mGraffitoParams; mDirtyParams; mMotorParams;
    mSlipParamsNormal; mSlipParamsOil; mSlipParamsAll; mSlipParamsAllSlider; mSlipParams45; mSlipParamsWaterSlope; mSlipParamsWaterGround; mSlipParamsYoshi;
    mUpperBodyParams; mDmgMapParams: { [k: string]: number }[];

    constructor(w: World, name = 'マリオ') {
        super(name);
        this.world = w;
        this.mGroundPlane = this.mRoofPlane = this.mWaterFloor = w.illegal;
        this.mDeParams = load(w, '/Mario/Mario.prm', P.DeParams);
        this.mBodyAngleParamsFree = load(w, '/Mario/BodyAngleFree.prm', P.BodyAngleParams);
        this.mBodyAngleParamsWaterGun = load(w, '/Mario/BodyAngleWaterGun.prm', P.BodyAngleParams);
        this.mAttackParamsFencePunch = load(w, '/Mario/AttackFencePunch.prm', P.AttackParams);
        this.mAttackParamsKickRoof = load(w, '/Mario/AttackKickRoof.prm', P.AttackParams);
        this.mJumpParams = load(w, '/Mario/Jump.prm', P.JumpParams);
        this.mRunParams = load(w, '/Mario/Run.prm', P.RunParams);
        this.mSwimParams = load(w, '/Mario/Swim.prm', P.SwimParams);
        this.mHangingParams = load(w, '/Mario/Hanging.prm', P.HangingParams);
        this.mHangRoofParams = load(w, '/Mario/HangRoof.prm', P.HangRoofParams);
        this.mWireParams = load(w, '/Mario/Wire.prm', P.WireParams);
        this.mPullParamsBGBeak = load(w, '/Mario/PullParamBGBeak.prm', P.PullParams);
        this.mPullParamsBGTentacle = load(w, '/Mario/PullParamBGTentacle.prm', P.PullParams);
        this.mPullParamsBGFireWanWanBossTail = load(w, '/Mario/PullParamBGFireWanWanBossTail.prm', P.PullParams);
        this.mPullParamsFireWanWanTail = load(w, '/Mario/PullParamFireWanWanTail.prm', P.PullParams);
        this.mBarParams = load(w, '/Mario/Bar.prm', P.BarParams);
        this.mSurfingParamsWaterRed = load(w, '/Mario/SurfingWaterRed.prm', P.SurfingParams);
        this.mSurfingParamsGroundRed = load(w, '/Mario/SurfingGroundRed.prm', P.SurfingParams);
        this.mSurfingParamsWaterYellow = load(w, '/Mario/SurfingWaterYellow.prm', P.SurfingParams);
        this.mSurfingParamsGroundYellow = load(w, '/Mario/SurfingGroundYellow.prm', P.SurfingParams);
        this.mSurfingParamsWaterGreen = load(w, '/Mario/SurfingWaterGreen.prm', P.SurfingParams);
        this.mSurfingParamsGroundGreen = load(w, '/Mario/SurfingGroundGreen.prm', P.SurfingParams);
        this.mHoverParams = load(w, '/Mario/HHover.prm', P.HHoverParams);
        this.mDivingParams = load(w, '/Mario/Diving.prm', P.DivingParams);
        this.mYoshiParams = load(w, '/Mario/Yoshi.prm', P.YoshiParams);
        this.mWaterEffectParams = load(w, '/Mario/WaterEffect.prm', P.WaterEffectParams);
        this.mControllerParams = load(w, '/Mario/Controller.prm', P.ControllerParams);
        this.mGraffitoParams = load(w, '/Mario/Graffito.prm', P.GraffitoParams);
        this.mDirtyParams = load(w, '/Mario/Dirty.prm', P.DirtyParams);
        this.mMotorParams = load(w, '/Mario/MarioMotor.prm', P.MotorParams);
        this.mSlipParamsNormal = load(w, '/Mario/SlipParamNormal.prm', P.SlipParams);
        this.mSlipParamsOil = load(w, '/Mario/SlipParamOil.prm', P.SlipParams);
        this.mSlipParamsAll = load(w, '/Mario/SlipParamAll.prm', P.SlipParams);
        this.mSlipParamsAllSlider = load(w, '/Mario/SlipParamAll_Slider.prm', P.SlipParams);
        this.mSlipParams45 = load(w, '/Mario/SlipParam45.prm', P.SlipParams);
        this.mSlipParamsWaterSlope = load(w, '/Mario/SlipParamWaterSlope.prm', P.SlipParams);
        this.mSlipParamsWaterGround = load(w, '/Mario/SlipParamWaterGround.prm', P.SlipParams);
        this.mSlipParamsYoshi = load(w, '/Mario/SlipParamYoshi.prm', P.SlipParams);
        this.mUpperBodyParams = load(w, '/Mario/UpperBody.prm', P.UpperParams);
        this.mDmgMapParams = [];
        for (let i = 0; i < 10; i++) this.mDmgMapParams.push(load(w, `/Mario/DmgMapCode${i}.prm`, P.EParams));
    }

    // ---------------------------------------------------------------- small accessors (Mario.hpp's inlines)
    checkStatusType(f: number) { return (this.mStatus & f) !== 0; }
    checkFlag(f: number) { return (this.mFlag & f) !== 0; }
    checkPrevFlag(f: number) { return (this.mPrevFlag & f) !== 0; }
    onFlag(f: number) { this.mFlag |= f; }
    offFlag(f: number) { this.mFlag &= ~f; }
    checkUnk114(f: number) { return (this.unk114 & f) !== 0; }
    onUnk114(f: number) { this.unk114 |= f; }
    offUnk114(f: number) { this.unk114 &= ~f; }
    isTouchGround4cm() { return this.pos.y <= this.mFloorPosition.y + 4; }
    isUpperPumpingStyle() { return this.mUpperState === 0 || this.mUpperState === 1; }
    isSinking() { return this.mSinkTimer > 0; }
    isFeelDeep() { return this.unk370 > this.mDeParams.mFeelDeep; }
    canHang() { return !this.mHeldObject && !this.onYoshi(); }
    isFencing() { const a = this.mStatus & 0x1FF; return a >= (S.FENCE_MOVE & 0x1FF) && (S.FENCE_JUMP_CATCH & 0x1FF) >= a; }
    isRoofing() { const a = this.mStatus & 0x1FF; return a >= (S.KICK_ROOF & 0x1FF) && a <= (S.MOVE_ROOF & 0x1FF); }
    /** isOnWire: held by a wire actor */
    isOnWire() { return !!this.holder && this.holder.actorType === AT.MAP_WIRE_ACTOR; }
    isTaken() { return this.mStatus === S.TAKEN; }
    getDmgMapCode(i: number) { return this.mDmgMapParams[i >= 0 && i <= 9 ? i : 0]; }
    /** no Yoshi */
    onYoshi() { return false; }
    /** isMario: the player (gpMarioOriginal) */
    isMario() { return false; }

    // ---------------------------------------------------------------- the map (gpMap)
    checkGround(x: number, y: number, z: number): [number, Bg] { return this.world.col.checkGround(x, y, z, 0); }
    checkRoof(x: number, y: number, z: number): [number, Bg] { return this.world.col.checkRoof(x, y, z, 0); }
    isTouchedWallsAndMoveXZ(r: WallCheck) { return this.world.col.checkWalls(r) !== 0; }
    /** gpMap->isTouchedOneWall: a wall the sphere touches (nothing pushed) */
    isTouchedOneWall(x: number, y: number, z: number, r: number) { return this.world.col.checkWalls(wallRecord(x, y, z, r, 1, DONT_MOVE_XZ)) !== 0; }

    // ---------------------------------------------------------------- the model (MarioDraw.cpp)
    getMotionFrameCtrl() { return this.mModel.fc[0]; }
    getCurrentFrame(i: number) { return this.mModel.fc[i].frame; }
    isLast1AnimeFrame() { const f = this.getMotionFrameCtrl(); return f.frame >= f.end - 1; }
    isAnimeLoopOrStop() { return (this.getMotionFrameCtrl().state & 3) !== 0; }
    getWallAngle() { return matan(this.mWallPlane!.n[2], this.mWallPlane!.n[0]); }
    /** setAnimation (no Yoshi): the BCK, its loop mode, and its rate (half the asked: per movement tick). */
    setAnimation(id: number, rate: number) {
        if (id !== this.mAnimationId) {
            this.mAnimationId = id;
            const bck = ANIME_DATA[id][0];
            this.mModel.changeAnm(0, bck);
            this.mModel.blendRatio = 0;
            this.getMotionFrameCtrl().attr = marioBckInfo(bck)[1];
        }
        this.getMotionFrameCtrl().rate = fr(rate * 0.5);
        this.mModel.fc[2].rate = fr(rate * 0.5);
        return this.getCurrentFrame(0);
    }
    setReverseAnimation(id: number, rate: number) {
        if (id !== this.mAnimationId) {
            this.setAnimation(id, rate);
            const f0 = this.mModel.fc[0], f2 = this.mModel.fc[2];
            f0.rate = fr(rate * -0.5); f0.frame = fr(f0.end - 0.1);
            f2.rate = fr(rate * -0.5); f2.frame = fr(f2.end - 0.1);
        }
        return this.getCurrentFrame(0);
    }
    /** getTrampleCt */
    getTrampleCt() { return this.mAnimationId === A.STEP1 ? 1 : this.mAnimationId === A.STEP2 ? 2 : this.mAnimationId === A.STEP3 ? 3 : 0; }
    // effects and sounds: told to the viewer
    effect(kind: string) { this.world.effect('mario:' + kind, this.pos); }
    startVoice(_id: number) { return 0; }
    startVoiceIfNoVoice(_id: number) { return 0; }
    startSoundActor(_id: number) { }
    rumbleStart(_a: number, _b: number) { }
    emitParticle(_id: number, _a?: number) { return false; }
    // the joint positions: f32-stored as setPositions does
    protected jointTrans(j: number, out: V3) { const m = this.mModel.anmMtx(j); if (m) out.set(fr(m[12]), fr(m[13]), fr(m[14])); }

    // ---------------------------------------------------------------- implemented by the later layers
    abstract changePlayerStatus(status: number, arg: number, force: boolean): number;
    abstract checkGroundPlane(x: number, y: number, z: number): [number, Bg, boolean];
    abstract setPlayerVelocity(v: number): void;
    abstract dropObject(): void;
    abstract waitMain(): number; abstract moveMain(): number; abstract jumpMain(): number; abstract swimMain(): number;
    abstract demoMain(): number; abstract specMain(): number; abstract actnMain(): number;
    abstract damageExec(hit: HitActor | null, damage: number, downType: number, waterEmit: number, speed: number, motor: number, dirty: number, invincible: number): void;
    abstract floorDamageExec(damage: number, downType: number, waterEmit: number, motor: number): void;
    abstract loserExec(): void;
    abstract decHP(n: number): void;
    abstract rocketCheck(): boolean;
    abstract canPut(): boolean;
}
export { s16, fr, JMASSin, JMASCos, matan };
