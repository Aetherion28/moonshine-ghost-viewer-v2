// The player: gpMarioOriginal, a whole TMario (player/*.ts) driven by the ghost's controller inputs
// the way the game drives it: TMarioGamePad (pad.ts) read once a frame, TMario::perform's movement
// every tick (MarioMain.cpp), his own controller (MarioMove.cpp checkController: the stick against
// gpCamera->unk258), what he does to others and takes from them (MarioCheckCol.cpp checkCollision,
// MarioReceiveMsg.cpp receiveMessage, MarioCollision.cpp: damage, health, losing a life), the
// player-only parts of his tick (the goop under him, sinking, FLUDD's hooks, the upper body:
// MarioUpper.cpp), and the stage's opening as TMarDirector runs it (MarDirectorDirect.cpp:
// changeState, setMario; MarioAutodemo.cpp: rollingStart / waitingStart, warpOut).
//
// Everything the stage's other actors ask of Mario (MarioProxy's interface: pos, vel, faceAngle,
// groundPlane, isJumping, hipDrop, marioFlags...) is here too, so they work on either.

import { V3, s16, JMASSin, JMASCos, matan, IConverge, Mtx, mtx, MsMtxSetRotRPH } from '../math.js';
import { HitActor, TakeActor, LiveActor, MSG, HC, LF, Stream, CUE_MOVE, World, calcKeyCode, shineIDofExStage, FC_PINGPONG_LOOP, MActor, AnmData, ANM_BCK } from '../engine.js';
import { AT } from '../actortypes.js';
import { POLLUTION_TYPE } from '../pollution.js';
import { TMarioSim, j3dTRMtx } from './tmario.js';
import { S, A, MF, ControllerWork, bg, marioBckInfo } from './base.js';
import { ANIME_DATA } from './tables.js';
import { SE } from '../soundids.js';
import { EmitInfo, emitInfo } from '../water.js';
import { MarioGamePad, PadStatus, MEANING, PAD_FLAG } from './pad.js';
import * as P from './params.js';
import { Params } from '../engine.js';
import type { MarioTrack, MarioSample } from '../mario.js';
import type { StickCamera, SimCamera } from '../camera/types.js';
import { fr, fmul, fadd, fsub, fdiv, fmadd, fnmsub, MsSqrtf, sqrtf, s16f, s32f, u8f } from './fmath.js';
import { TWaterGun, marioGunExec } from './watergun.js';
import { makePlayerCamera, PolarSubCamera } from '../camera/index.js';
import { Yoshi } from './yoshi.js';
import { wallRecord } from './base.js';

const T = AT as Record<string, number>;
const types = (...names: string[]) => new Set(names.map((n) => T[n]).filter((v) => v !== undefined));

/** TMario's upper body states */
export const UPPER = { PUMPING: 0, HOLDING_PUMP: 1, HOLDING_OBJECT: 2, UNK3: 3, FIXED_ANIMATION: 4, IDLE: 5 };

// ---------------------------------------------------------------- the water gun's hook
/**
 * The TWaterGun the player carries (player/watergun.ts: `new WaterGun(mario)`), as TMario calls it.
 * It's made by the factory set here (the water gun's module sets it), so the player runs without it.
 */
export interface PlayerWaterGun {
    mCurrentNozzle: number; mSecondNozzle: number; mCurrentWater: number;
    init?(): void;
    setAmountToRate?(r: number): void;
    initInLoadAfter?(): void;
    perform(cue: number): void;
    calcAnimFromMario?(): void;
    setBaseTRMtx?(m: unknown): void;
    changeNozzle(type: number, animate: boolean): void;
    changeBackup(): void;
    getEmittedWaterCount(): number;
    getCurrentNozzle(): any;
    getCurrentNozzleType?(): number;
    getCurrentWater(): number;
    getMaxWater(): number;
    addWater(n: number): void;
    resetWaterToFull(): void;
    damage(): boolean;
    isEmitting(): boolean;
    canSpray?(): boolean;
    rotateProp?(v: number): void;
    onFlag?(f: number): void;
    isSwitchingToPrimaryNozzle(): boolean;
    isSwitchingToSecondaryNozzle(): boolean;
    checkCurrentNozzleRocketType(t: number): boolean;
    checkCurrentNozzleKind(k: number): boolean;
    checkCurrentNozzleTriggerSprayState(s: number): boolean;
    mEmitPos?: V3[];
    mWatergunParams?: { mHoverHeight?: number; mHHoverHeight?: number; mRocketHeight?: number };
    drawState?(): any;
}
/** TWaterGun::TNozzleType */
export const NOZZLE = { Spray: 0, Rocket: 1, Underwater: 2, Yoshi: 3, Hover: 4, Turbo: 5 } as const;
export const playerHooks: {
    /** new TWaterGun(mario) (+ init, setAmountToRate): set by the water gun's module */
    makeWaterGun: ((m: PlayerMario, rate: number) => PlayerWaterGun) | null;
    /** TMario::gunExec, if the water gun's module has its own (marioGunExec) */
    gunExec: ((m: PlayerMario, xHit: boolean) => void) | null;
    /** the simulated game camera (CPolarSubCamera), set by the camera's module */
    makeCamera: ((w: World, m: PlayerMario) => SimCamera) | null;
} = { makeWaterGun: null, gunExec: null, makeCamera: null };

// ---------------------------------------------------------------- the player
export class PlayerMario extends TMarioSim {
    /** this stage's Mario is the player (gpMarioOriginal) */
    isMario() { return true; }
    mGamePad = new MarioGamePad();
    mWaterGun: PlayerWaterGun | null = null;
    /** gpCamera, as the stick reads it */
    camera: StickCamera;
    /** the simulated game camera (CPolarSubCamera), updated after him every tick */
    simCamera: SimCamera | null = null;
    /** true while the stick's camera is a stand-in (Mario's back), not the game's */
    cameraApprox = true;
    mCoinCount = 0; unk144 = 0; unk148: HitActor | null = null; unk298 = 100;
    mDamagePos = new V3();
    mWarpInDir = new V3(); unk468 = 0;
    // TEParams (/Mario/Dmg*.prm)
    mDmgParamsEnemyCommon; mDmgParamsHamakuri; mDmgParamsNamekuri; mDmgParamsHinokuri; mDmgParamsFire; mDmgParamsBGTentacle;
    mDmgParamsBossEel; mDmgParamsHanachanBoss; mDmgParamsPoihana; mDmgParamsKiller; mDmgParamsLampTrapIron; mDmgParamsLampTrapSpike;
    mDmgParamsEnemyMario; mDmgParamsCannotBreath; mDmgParamsGraffitoFire; mDmgParamsGraffitoPoison; mDmgParamsGraffitoElec;
    mDmgParamsGraffitoLava; mDmgParamsWaterSurface;
    mAutoDemoParams;

    /** losing a life: the QF (stage tick) it happened, the run just goes on */
    lostLives: number[] = [];
    /** what the viewer and the other actors want, updated every tick */
    present = true;
    justEnteredWater = false;
    /** the ghost's samples (drift detection only) */
    track: MarioTrack | null = null;

    constructor(w: World) {
        super(w, 'マリオ');
        const L = (p: string) => new Params(p, w.files).read(P.EParams);
        this.mDmgParamsEnemyCommon = L('/Mario/DmgEnemyCommon.prm'); this.mDmgParamsHamakuri = L('/Mario/DmgHamukuri.prm');
        this.mDmgParamsNamekuri = L('/Mario/DmgNamekuri.prm'); this.mDmgParamsHinokuri = L('/Mario/DmgHinokuri.prm');
        this.mDmgParamsFire = L('/Mario/DmgFire.prm'); this.mDmgParamsBGTentacle = L('/Mario/DmgBGTentacle.prm');
        this.mDmgParamsBossEel = L('/Mario/DmgBossEel.prm'); this.mDmgParamsHanachanBoss = L('/Mario/DmgHanachanBoss.prm');
        this.mDmgParamsPoihana = L('/Mario/DmgPoihana.prm'); this.mDmgParamsKiller = L('/Mario/DmgKiller.prm');
        this.mDmgParamsLampTrapIron = L('/Mario/DmgLampTrapIron.prm'); this.mDmgParamsLampTrapSpike = L('/Mario/DmgLampTrapSpike.prm');
        this.mDmgParamsEnemyMario = L('/Mario/DmgEnemyMario.prm'); this.mDmgParamsCannotBreath = L('/Mario/DmgCannotBreath.prm');
        this.mDmgParamsGraffitoFire = L('/Mario/DmgGraffitoFire.prm'); this.mDmgParamsGraffitoPoison = L('/Mario/DmgGraffitoPoison.prm');
        this.mDmgParamsGraffitoElec = L('/Mario/DmgGraffitoElec.prm'); this.mDmgParamsGraffitoLava = L('/Mario/DmgGraffitoLava.prm');
        this.mDmgParamsWaterSurface = L('/Mario/DmgGraffitoWaterSurface.prm');
        this.mAutoDemoParams = new Params('/Mario/AutoDemo.prm', w.files).read(P.AutoDemoParams);
        // TMario::mHeldObject is TTakeActor::mHeldObject
        Object.defineProperty(this, 'mHeldObject', { get: () => this.held, set: (v) => { this.held = v; }, configurable: true });
        this.camera = { yaw: () => s16(this.mFaceAngle.y + 0x8000) };
        this.mGamePad.isLButtonCamera = () => !!(this.camera.isLButtonCamera && this.camera.isLButtonCamera());
        this.initValues();
    }

    // ---------------------------------------------------------------- MarioInit.cpp
    /** TMario::initValues (the player's: no models of its own but the body's frames) */
    initValues() {
        this.mHealth = this.mDeParams.mHPMax;
        this.mDirty = 0; this.mOilBrake = 1; this.mDirtyTimer = 0; this.unk140 = 0;
        this.unk108 = new ControllerWork();
        this.unk10C = 0; this.unk110 = 0;
        this.mPlayerType = 0;   // PLAYER_TYPE_MARIO
        this.mHolderHeightDiff = 0;
        this.initModel();
        this.initTorocco();
        this.unk414.set(0, 0, 1);
        this.unk530 = new Int16Array(60); this.unk534 = 0; this.unk536 = 0; this.unk538 = 0; this.unk53A = 0; this.unk53B = 0;
        this.initHitActor(AT.MARIO, 5, HC.PLAYER | HC.MAP_OBJECT | HC.ITEM | HC.ENEMY | HC.BOSS | HC.NPC,
            this.mDeParams.mTrampleRadius, this.mDeParams.mAttackHeight, this.mDeParams.mDamageRadius, this.mDeParams.mDamageHeight);
        this.mCoinCount = 0;
        this.unk55C = 50;
        // mYoshi = new TYoshi; mYoshi->init(this) (after the water gun's, before TMarioEffect)
        this.unk3E8 = 4; this.unk3EC = 0;
        try { this.mYoshi = new Yoshi(this as any); } catch (e) { console.warn('[player] yoshi', e); this.mYoshi = null; }
    }
    /** (SMS_GetYoshi() as other modules ask for it: enemies/egggen.ts, fruitsboat.ts) */
    get yoshi() { return this.mYoshi; }
    /** unk3E8 / unk3EC: FLUDD's second nozzle and fill rate when he got on Yoshi */
    unk3E8 = 4; unk3EC = 0;
    initModel() {
        this.initJointIds();
        this.mModel.changeAnm(0, 0x3e);
        this.mModel.changeAnm(1, 0x41);
        this.mModel.upperCalc = 1; this.mModel.upperJoint = this.mJointIdChest;   // setInfo[1]: { mJointIdChest, 2, 1, .., 1 }
        this.mModel.fc[1].rate = 0;
        this.setAnimation(A.WAIT, 1);
        j3dTRMtx(this.mModel.baseTR, this.mFaceAngle.x, this.mModelFaceAngle, this.mFaceAngle.z, this.pos.x, this.pos.y, this.pos.z);
        this.mModel.update();
        this.mModel.calc();
    }
    /** TMario::load: his place, his angle, FLUDD's water (percent) and whether he has FLUDD */
    load(s: Stream) {
        super.load(s);
        this.mFaceAngle.x = 0;
        this.mFaceAngle.y = s16f(fr(fr(this.rot.y * fr(1 / 360)) * 65536));
        this.mFaceAngle.z = 0;
        this.mModelFaceAngle = this.mFaceAngle.y; this.unk9C = this.mFaceAngle.y; this.unk9E = this.mFaceAngle.y;
        this.unk298 = s.left >= 4 ? s.u32() : 100;
        const fl = s.left >= 4 ? s.u32() : 0;
        this.mFlag = 0;
        if (fl & 1) this.offFlag(MF.HAS_FLUDD); else this.onFlag(MF.HAS_FLUDD);
        this.initValues();
        try {
            if (playerHooks.makeWaterGun) this.mWaterGun = playerHooks.makeWaterGun(this, fr(this.unk298 / 100));
            else {
                const G = new TWaterGun(this as any); G.init(); G.setAmountToRate(fr(this.unk298 / 100));
                G.cameraHook = { isLButtonCamera: () => !!(this.camera.isLButtonCamera && this.camera.isLButtonCamera()), isJetCoaster1stCamera: () => false, pitch: () => 0 };
                this.mWaterGun = G as unknown as PlayerWaterGun;
            }
        } catch (e) { console.warn('[player] water gun', e); this.mWaterGun = null; }
        this.pos.fround();
    }
    loadAfter() {
        if (this.checkFlag(MF.HAS_FLUDD) && this.mWaterGun && this.mWaterGun.initInLoadAfter) this.mWaterGun.initInLoadAfter();
        if (this.mYoshi) this.mYoshi.initInLoadAfter();
        try {
            const c = playerHooks.makeCamera ? playerHooks.makeCamera(this.world, this) : makePlayerCamera(this.world, this as any);
            this.simCamera = c; this.camera = c; this.cameraApprox = false;
            const G = this.mWaterGun as any;
            if (G && G.cameraHook && (c as any).isLButtonCamera) G.cameraHook = { isLButtonCamera: () => (c as any).isLButtonCamera(), isJetCoaster1stCamera: () => false, pitch: () => { const t = (c as any).cur; return t ? t.pitch | 0 : 0; } };   // (gpCamera->getCurrentTarget().mPitch: lha 0xa4 @0x8014c510)
            if ((c as any).setWaterGun && G) (c as any).setWaterGun(G);
        } catch (e) { console.warn('[player] camera', e); }
    }
    /** Use this camera for the stick (a recorded one, the simulated one). */
    setStickCamera(c: StickCamera, approximate: boolean) { this.camera = c; this.cameraApprox = approximate; }

    // ---------------------------------------------------------------- the camera
    cameraYaw() { return s16(this.camera.yaw()); }

    // ---------------------------------------------------------------- MarioMove.cpp: checkController
    getLRLevel(level: number) {
        const C = this.mControllerParams;
        const zero = C.mAnalogLRToZeroVal, mid = C.mAnalogLRToMiddleVal, max = C.mAnalogLRToMaxVal, ml = C.mAnalogLRMiddleLevel;
        if (level < zero) return 0;
        if (level < mid) return fdiv(fmul(ml, level - zero), mid - zero);
        if (level < max) return fadd(ml, fdiv(fmul(fsub(1, ml), level - mid), max - mid));
        return 1;
    }
    getDizzyAngle() {
        const G = this.mGraffitoParams;
        const t = this.mDizzyTimer;
        const a = s16f(fmul(t, G.mDizzyAngleRate)) & 0xFFFF;
        return Math.trunc(fdiv(fmul(fmul(JMASSin(a), G.mDizzyAngleY), t), G.mDizzyWalkCtMax));
    }
    getDizzyPower() {
        const G = this.mGraffitoParams;
        const a = s16f(fmul(this.mDizzyTimer, G.mDizzyPowerRate)) & 0xFFFF;
        return fmul(JMASCos(a), G.mDizzyPower);
    }
    checkController() {
        const pad = this.mGamePad, C = this.unk108, cs = pad.mCompSPos;
        C.mStickHS16 = s16f(fmul(128, cs[0]));
        C.mStickVS16 = s16f(fmul(128, cs[1]));
        if (this.isSinking()) {
            const G = this.mGraffitoParams;
            const k = fmadd(fsub(G.mSinkMoveMax, G.mSinkMoveMin), fsub(1, fdiv(this.mSinkTimer, G.mSinkTime)), G.mSinkMoveMin);
            C.mStickHS16 = s16f(fmul(C.mStickHS16, k));
            C.mStickVS16 = s16f(fmul(C.mStickVS16, k));
        }
        C.mInput = 0; C.mFrameInput = 0;
        if (pad.checkMeaning(MEANING.A)) C.mInput |= ControllerWork.A;
        if (pad.checkFrameMeaning(MEANING.A)) C.mFrameInput |= ControllerWork.A;
        if (pad.checkMeaning(MEANING.B)) C.mInput |= ControllerWork.B;
        if (pad.checkFrameMeaning(MEANING.B)) C.mFrameInput |= ControllerWork.B;
        if (pad.checkMeaning(MEANING.R)) C.mInput |= ControllerWork.R;
        if (pad.checkFrameMeaning(MEANING.R)) C.mFrameInput |= ControllerWork.R;
        if (pad.checkFrameMeaning(MEANING.Z)) C.mFrameInput |= ControllerWork.UNK10;
        C.mAnalogRU8 = u8f(cs[3]);
        C.mAnalogLU8 = u8f(cs[2]);
        const aR = u8f(cs[3]), aL = u8f(cs[2]);
        C.mAnalogR = this.getLRLevel(aR);
        C.mAnalogL = this.getLRLevel(aL);
        this.unk10C = this.getLRLevel(aL);
        this.unk110 = this.getLRLevel(aR);
        C.mStickH = 0; C.mStickV = 0;
        if (C.mStickHS16 < -7) C.mStickH = C.mStickHS16 + 6;
        if (C.mStickHS16 > 7) C.mStickH = C.mStickHS16 - 6;
        if (C.mStickVS16 < -7) C.mStickV = C.mStickVS16 + 6;
        if (C.mStickVS16 > 7) C.mStickV = C.mStickVS16 - 6;
        let dist = MsSqrtf(fadd(fmul(C.mStickH, C.mStickH), fmul(C.mStickV, C.mStickV)));
        for (let i = 0; i < this.mControllerParams.mLengthMultTimes; i++) dist = fmul(dist, this.mControllerParams.mLengthMult);
        C.mStickDist = dist;
        if (C.mStickDist > 64) {
            C.mStickH = fmul(C.mStickH, fdiv(64, C.mStickDist));
            C.mStickV = fmul(C.mStickV, fdiv(64, C.mStickDist));
            C.mStickDist = 64;
        }
        { const n = fmul(0.015625, C.mStickDist); this.mIntendedMag = fmul(32, fmul(n, n)); }
        if (this.mDizzyTimer > 0) this.mDizzyTimer -= 1;
        let jitter = 0;
        if (this.mDizzyTimer > 0) {
            jitter = this.getDizzyAngle();
            this.mIntendedMag = fadd(this.mIntendedMag, this.getDizzyPower());
            if (this.mIntendedMag < 0) this.mIntendedMag = 0;
        }
        if (this.mIntendedMag > 0) this.mIntendedYaw = s16(matan(-C.mStickV, C.mStickH) + (this.cameraYaw() + jitter));
        else this.mIntendedYaw = this.mFaceAngle.y;
        const G = this.mWaterGun;
        if (G) {
            if (G.mCurrentNozzle === NOZZLE.Turbo && this.mUpperState === UPPER.PUMPING && cs[3] > 0 && G.getCurrentWater() > 0) {
                if (this.mIntendedMag === 0) this.mIntendedYaw = this.mFaceAngle.y;
                this.mDashSpeed = fadd(this.mDashSpeed, this.mDeParams.mDashAcc);
                if (this.mDashSpeed > 32) {
                    this.mDashSpeed = 32;
                    this.mDashTimer = s16(this.mDashTimer + 1);
                    if (this.mDashTimer > this.mDeParams.mDashStartTime) {
                        this.mDashTimer = this.mDeParams.mDashStartTime;
                        if (!this.checkFlag(MF.FLUDD_EMITTING) && G.getCurrentNozzle().mSprayState === 1) {
                            this.onFlag(MF.FLUDD_EMITTING);
                            if (this.checkStatusType(S.FLAG_SWIMMING)) this.changePlayerStatus(S.SWIM_PADDLE, 0, false);
                        }
                    }
                    if (((this.mStatus - 0x4000000) >>> 0) !== 0x440 && this.mStatus !== S.SWIM_PADDLE) { this.mDashTimer = 0; this.offFlag(MF.FLUDD_EMITTING); }
                } else { this.mDashTimer = 0; this.offFlag(MF.FLUDD_EMITTING); }
                this.mIntendedMag = this.mDashSpeed;
                if (G.rotateProp) G.rotateProp(this.mDashSpeed);
            } else {
                if (this.mDashSpeed > fr(0.1)) {
                    if (this.mIntendedMag === 0) this.mIntendedYaw = this.mFaceAngle.y;
                    this.mDashSpeed = fmul(this.mDashSpeed, this.mDeParams.mDashBrake);
                    this.mIntendedMag = this.mDashSpeed;
                } else this.mDashSpeed = 0;
                this.mDashTimer = 0;
                this.offFlag(MF.FLUDD_EMITTING);
            }
            if (G.mCurrentNozzle === NOZZLE.Turbo && (((this.mStatus - 0xC400000) >>> 0) === 0x201 || ((this.mStatus - 0x4000000) >>> 0) === 0x440)) {
                const n = G.getCurrentNozzle();
                // the DOL stores to the Turbo nozzle's float at +0x714 (stfs f31,0x714(r3) @0x801314b8; what it
                // is isn't known), not to TNozzleTrigger::mInsidePressure at 0x388: the charge is left alone
                if (n) (n as any).unk714 = fmul(this.mIntendedMag, 0.03125);
            }
        }
        if (this.mIntendedMag > 0) this.mInput |= 1;
        if (pad.checkFrameMeaning(MEANING.A)) this.mInput |= 2;
        if (pad.checkMeaning(MEANING.A)) this.mInput |= 0x80;
        if (C.mInput & 0x200) this.mInput |= 0x4000;
        if (!this.onYoshi() && (C.mFrameInput & 0x200)) { this.mInput |= 0x8000; this.mInput |= 0x2000; }
        if (pad.checkFrameMeaning(MEANING.L) || (C.mFrameInput & 0x40)) {
            if (this.checkStatusType(S.FLAG_JUMPING)) this.mInput |= 0x8000;
        }
        if (this.checkFlag(MF.HAS_FLUDD) && !this.checkFlag(MF.FLUDD_EMITTING)) {
            if (pad.checkMeaning(MEANING.R) || pad.checkMeaning(MEANING.L)) this.mInput |= 0x200;
            if (pad.checkFrameMeaning(MEANING.R)) this.mInput |= 0x100;
        }
    }
    /** checkFrameMeaning(MEANING_L) (the hip drop from a dive's L) */
    padFrameL() { return this.mGamePad.checkFrameMeaning(MEANING.L); }

    // ---------------------------------------------------------------- MarioMove.cpp: the player-only parts
    /** TMario::considerRotateStart (0x8013c118): the stick spun round while FLUDD sprays: the spin (checkStickRotate's direction is 2 or 3, so always ROTATE_L) */
    considerRotateStart() {
        const [ok, dir] = this.checkStickRotate();
        const G = this.mWaterGun;
        if (ok === 1 && G && G.isEmitting()) return this.changePlayerStatus(dir > 0 ? S.ROTATE_L : S.ROTATE_R, 0, false);
        return 0;
    }
    /** TMario::canSquat (0x80135390): FLUDD out, not a rocket-type nozzle (hover, rocket), not Turbo, R held (mInput 0x200) */
    canSquat() {
        const G = this.mWaterGun;
        return this.checkFlag(MF.HAS_FLUDD) && !!G && G.getCurrentNozzle().mRocketType !== 1 && G.mCurrentNozzle !== NOZZLE.Turbo && (this.mInput & 0x200) !== 0;
    }
    /** TMario::getSideWalkValues (0x801451a8): [type (0 none, 1 left, 2 right), the anim rate, the side speed] */
    getSideWalkValues(): [number, number, number] {
        const diff = s16(this.mIntendedYaw - this.mFaceAngle.y);
        const side = fmul(fmul(this.mIntendedMag, JMASSin(diff & 0xFFFF)), this.mRunParams.mPumpingSlideSp);
        if (side === 0) return [0, this.getMotionFrameCtrl().rate, side];
        let r = fmul(side, this.mRunParams.mPumpingSlideAnmSp);
        if (r < 0) r = -r;
        return [diff > 0 ? 1 : 2, r, side];
    }
    /**
     * TMario::squating (0x80144dec): spraying standing still. A with R held and the spray nozzle out: the
     * back jump; a rocket-type nozzle firing: the hover / rocket; L (MEANING_L): side-stepping; R: turning
     * on the spot with the stick (mSquatRotMid*), mWaitingRotSp at full.
     */
    squating() {
        if (this.mInput & 4) return this.changePlayerStatus(S.LANDING, 0, false);
        if (this.mInput & 8) return this.changePlayerStatus(S.SLIP, 0, false);
        if (this.mInput & 0x10) return this.changePlayerStatus(S.SQUAT_STANDUP, 0, false);
        if (!(this.mInput & 0x4000) && !(this.mInput & 0x200)) return this.changePlayerStatus(S.SQUAT_STANDUP, 0, false);
        const G = this.mWaterGun;
        if (!G || !this.checkFlag(MF.HAS_FLUDD)) return this.changePlayerStatus(S.SQUAT_STANDUP, 0, false);
        if ((this.mInput & 2) && this.mGamePad.checkMeaning(MEANING.R) && G.mCurrentNozzle === NOZZLE.Spray) {
            this.rumbleStart(0x15, this.mMotorParams.mMotorHipDrop);
            return this.changePlayerStatus(S.BACK_JUMP, 0, false);
        }
        if (G.getCurrentNozzle().mRocketType === 1 && G.isEmitting()) {
            this.unk314 = fadd(this.mFloorPosition.y, this.hoverHeight());
            return this.changePlayerStatus(S.ROCKET, 0, false);
        }
        if (this.mGamePad.checkMeaning(MEANING.L)) {
            const [type, rate, side] = this.getSideWalkValues();
            if (type === 0) this.setAnimation(A.SQWAT, 1);
            else if (type === 1) this.setAnimation(A.SWLKL, rate);
            else if (type === 2) this.setAnimation(A.SWLKR, rate);
            this.pos.x = fmadd(side, JMASCos(this.mFaceAngle.y & 0xFFFF), this.pos.x);
            this.pos.z = fnmsub(side, JMASSin(this.mFaceAngle.y & 0xFFFF), this.pos.z);
        } else if (this.mGamePad.checkMeaning(MEANING.R)) {
            const h = this.mGamePad.mCompSPos[0], absH = Math.abs(h);
            const mid = this.mControllerParams.mSquatRotMidAnalog, midVal = this.mControllerParams.mSquatRotMidValue;
            let rot = absH < mid ? fmul(midVal, fdiv(absH, mid)) : fmadd(fsub(1, midVal), fdiv(fsub(absH, mid), fsub(1, mid)), midVal);
            if (h < 0) rot = -rot;
            this.mFaceAngle.y = s16(this.mFaceAngle.y + s32f(fmul(rot, fr(-this.mDeParams.mWaitingRotSp))));
            this.setAnimation(A.SQWAT, 1);
        }
        this.waitProcess();
        return 0;
    }
    thinkSituation() {
        const hpBefore = this.mHealth;
        super.thinkSituation();
        // the player's part of it: a stage change plane (isUnk300: a warp; the segment ends there)
        if (bg.isUnk300(this.mGroundPlane)) { if (this.onYoshi()) this.getOffYoshi(false); this.world.setNextStage?.(this.mGroundPlane.data, null); this.offUnk114(2); this.offUnk114(0x400); }
        void hpBefore;
        // FLUDD's water on the ground under him: TModelWaterManager::askHitWaterParticleOnGround
        // (super's offFlag(RECENTLY_LEFT_WATER) came just before, as in the game)
        if (this.isTouchGround4cm() && this.askHitWaterParticleOnGround()) this.onFlag(MF.RECENTLY_LEFT_WATER);
    }
    /** TMarioCap::unk4 (E_CAP_MODEL: 1 the hat, 2 the helmet, 4 the sunglasses) */
    mCapModel = 1;
    /** TMario::isWearingCap */
    isWearingCap() { return (this.mCapModel & 1) !== 0; }
    /** TMario::setDivHelm (MarioDraw.cpp): the helmet model on (mCap->setModelActive(E_CAP_MODEL_HELMET); emitGetEffect, MSD_SE_MA_HELMET) */
    setDivHelm() { this.mCapModel |= 2; }
    /** TMario::isWearingHelm */
    isWearingHelm() { return (this.mCapModel & 2) !== 0; }
    /**
     * thinkParams (0x8012e324) out of the water: without his hat (taken by a Doro Hane / Hamu Kuri)
     * the sun takes 1 HP every mHotTimer ticks (and his invincibility for unk55C)
     */
    thinkHeat() {
        if (this.mCapModel & 1) return;
        this.mHotTimer = (this.mHotTimer + 1) & 0xFFFF;
        if (this.mHotTimer > this.mHotTimerMax) {
            this.decHP(1);
            this.mHotTimerMax = this.mDeParams.mHotTimer;
            this.mHotTimer = 0;
            this.rumbleStart(0x14, this.mMotorParams.mMotorWall);
            this.mInvincibilityFrames = s16f(this.unk55C);
            this.event('heatDamage', { hp: this.mHealth });
        }
    }
    /** TMario::checkGraffito: the goop under him */
    checkGraffito() {
        if (this.mGroundPlane.isIllegal()) return;
        if (this.onYoshi()) return;
        const Pl = this.world.pollution;
        if (!Pl) return;
        let dirty = 0;
        this.mPollutionTypeStandingOn = Pl.getPollutionType(this.pos.x, this.pos.y, this.pos.z);
        const p = { x: this.pos.x, y: this.pos.y, z: this.pos.z };
        const chk = () => { if (!Pl.isPolluted(p.x, p.y, p.z)) dirty = 0; };
        switch (this.mPollutionTypeStandingOn) {
            case POLLUTION_TYPE.SLIP: case POLLUTION_TYPE.INSTAKILL: case POLLUTION_TYPE.SAFE:
                p.x = fsub(p.x, 32); p.z = fsub(p.z, 32); dirty = 1;
                chk(); p.x = fadd(p.x, 32); chk(); p.x = fadd(p.x, 32); chk();
                p.z = fadd(p.z, 32); chk(); p.x = fsub(p.x, 32); chk(); p.x = fsub(p.x, 32); chk();
                p.z = fadd(p.z, 32); chk(); p.x = fadd(p.x, 32); chk(); p.x = fadd(p.x, 32); chk();
                break;
            case POLLUTION_TYPE.SINK: case POLLUTION_TYPE.FIRE: case POLLUTION_TYPE.GLASS_WALL: case POLLUTION_TYPE.UNK7:
                p.y = this.mFloorPosition.y; dirty = 1;
                p.z = fsub(p.z, 32); chk();
                p.x = fadd(p.x, 32); p.z = fadd(p.z, 32); chk();
                p.x = fsub(p.x, 32); chk();
                p.x = fsub(p.x, 32); chk();
                p.z = fadd(p.z, 32); p.x = fadd(p.x, 32); chk();
                break;
            case POLLUTION_TYPE.ELECTRIC:
                p.y = this.mFloorPosition.y;
                dirty = Pl.isPolluted(p.x, p.y, p.z) ? 1 : 0;
                break;
            default: dirty = 0; break;
        }
        switch (this.mPollutionTypeStandingOn) {
            case POLLUTION_TYPE.ELECTRIC: if (dirty) this.checkGraffitoElec(); break;
            case POLLUTION_TYPE.FIRE: case POLLUTION_TYPE.UNK7: if (dirty) this.checkGraffitoFire(); break;
            case POLLUTION_TYPE.SLIP: if (dirty) this.checkGraffitoSlip(); break;
            case POLLUTION_TYPE.GLASS_WALL: if (dirty) { this.pos.x = this.mPrevPosition.x; this.pos.z = this.mPrevPosition.z; } break;
        }
        if (dirty) this.onFlag(MF.DIRTY); else this.offFlag(MF.DIRTY);
        if (this.isTouchGround4cm()) {
            if (this.mFootPrintTimer <= 0) return;
            this.mFootPrintTimer -= 1;
            if (this.mFootPrintTimer <= Math.trunc(this.mDeParams.mFootPrintTimerMax / 2)) return;
            if (!this.mGroundPlane.isLegal()) return;
            if (this.checkFlag(MF.IN_ANY_WATER)) return;
            // emitDirtyFootPrint: the footprint stamps into the goop
            if (this.world.pollution) this.world.pollution.stamp(1, this.pos.x, this.pos.y, this.pos.z, this.mDirtyParams.mPolSizeFootPrint);
        }
    }
    askHitWaterParticleOnGround() {
        const W = this.world.water;
        if (!W) return false;
        const p = this.pos;
        for (let i = 0; i < W.count; i++) {
            if ((W.flag[i] & 0xF) !== 2) continue;
            const q = W.pos[i];
            if (fadd(fadd(Math.abs(fsub(p.x, q.x)), Math.abs(fsub(p.y, q.y))), Math.abs(fsub(p.z, q.z))) < 300) return true;
        }
        return false;
    }
    makeGraffitoDamage(p: { [k: string]: number }) {
        this.mFloorHitActor.pos.x = fadd(this.pos.x, JMASSin(this.mFaceAngle.y));
        this.mFloorHitActor.pos.z = fadd(this.pos.z, JMASCos(this.mFaceAngle.y));
        this.damageExec(this.mFloorHitActor, p.mDamage, p.mDownType, p.mWaterEmit, p.mMinSpeed, p.mMotor, p.mDirty, p.mInvincibleTime);
    }
    checkGraffitoFire() {
        if (this.isInvincible()) return;
        if (this.checkFlag(MF.GAME_OVER)) return;
        if (fsub(this.pos.y, this.mFloorPosition.y) > this.mGraffitoParams.mFireHeight) return;
        if (this.mStatus === S.FIRE_DOWN || this.mStatus === S.FIRE_JUMP_END) this.mFaceAngle.y = s16(this.mFaceAngle.y + 0x8000);
        const fv = this.mForwardVel, vy = this.mVel.y;
        this.makeGraffitoDamage(this.mDmgParamsGraffitoFire);
        if (this.unk55C > 0) { this.mVel.y = -vy; this.mForwardVel = fv; }
        this.mInvincibilityFrames = this.mGraffitoParams.mFireInvincibleTime;
        this.dropObject();
        this.changePlayerStatus(S.FIRE_DOWN, 1, false);
        this.event('burn');
    }
    checkGraffitoSlip() {
        const D = this.mDirtyParams;
        if (this.isTouchGround4cm()) {
            this.mFootPrintTimer = this.mDeParams.mFootPrintTimerMax;
            if (this.mStatus === S.OIL_SLIP || this.mStatus === S.OIL_SLOPE) { this.mOilBrake = D.mBrakeStartValSlip; this.mDirtyTimer = D.mDirtyTimeSlip; }
            if (this.mStatus === S.OIL_RUN || this.mStatus === S.OIL_PULLING) { this.mOilBrake = D.mBrakeStartValRun; this.mDirtyTimer = D.mDirtyTimeRun; }
            if (this.mGroundPlane.n[1] <= D.mSlopeAngle) {
                this.mOilBrake = D.mBrakeStartValSlip; this.mDirtyTimer = D.mDirtyTimeSlip;
                this.changePlayerStatus(S.OIL_SLOPE, 0, false);
                this.startVoice(SE.MV28_SPRISE_SMALL_01);
            } else if (this.mStatus === S.JUMP_CATCH || this.mStatus === S.CATCH || this.mStatus === S.OIL_SLIP || this.mStatus === S.OIL_SLOPE) {
                this.mOilBrake = D.mBrakeStartValSlip; this.mDirtyTimer = D.mDirtyTimeSlip;
                this.changePlayerStatus(S.OIL_SLIP, 0, false);
                if (this.mPrevStatus !== S.OIL_SLIP) this.startVoice(SE.MV28_SPRISE_SMALL_01);
            } else if (this.mStatus !== S.CATCH_LOST) {
                this.mOilBrake = D.mBrakeStartValRun; this.mDirtyTimer = D.mDirtyTimeRun;
                if (this.mStatus === S.PULLING) this.changePlayerStatus(S.OIL_PULLING, 0, false);
                else this.changePlayerStatus(S.OIL_RUN, 0, false);
            }
            if (!this.checkFlag(MF.DIRTY)) this.mStandingOnGraffitoTimer = D.mFogTimeYellow + D.mFogTimeRed;
            this.mStandingOnGraffitoTimer = s16(this.mStandingOnGraffitoTimer - 1);
            if (this.mStandingOnGraffitoTimer !== 0) {
                if (this.mStandingOnGraffitoTimer === D.mFogTimeRed) this.floorDamageExec(1, 3, 0, this.mMotorParams.mMotorReturn);
            } else this.mStandingOnGraffitoTimer = D.mFogTimeYellow + D.mFogTimeRed;
        } else if (this.mStatus === S.OIL_SLIP || this.mStatus === S.OIL_SLOPE) {
            this.mOilBrake = D.mBrakeSlipNoPollute; this.mDirtyTimer = D.mDirtyTimeSlip;
        }
    }
    checkGraffitoElec() {
        if (!this.checkFlag(MF.DIRTY)) this.mStandingOnGraffitoTimer = this.mDeParams.mGraffitoNoDmgTime;
        if (this.mStandingOnGraffitoTimer !== 0) { this.mStandingOnGraffitoTimer -= 1; return; }
        if (this.isInvincible()) return;
        const t = this.mStatus & 0x1C0;
        if ((t === 0 || t === 0x40) && this.mFootPrintTimer <= 0) this.changePlayerStatus(S.ELECTRIC_DAMAGE, 0, false);
    }
    /** TMario::checkSink: sinking into the goop, and the deadly goop */
    checkSink() {
        if (this.isInvincible()) return;
        if (this.mGroundPlane.isIllegal()) return;
        if (fadd(this.mFloorPosition.y, 100) < this.pos.y) { this.mSinkTimer = 0; return; }
        const G = this.mGraffitoParams;
        if (this.mPollutionTypeStandingOn === POLLUTION_TYPE.SINK && this.checkFlag(MF.DIRTY)) {
            this.mSinkTimer = fadd(this.mSinkTimer, 1);
            this.mFootPrintTimer = this.mDeParams.mFootPrintTimerMax;
            const lim = fmul(G.mSinkTime, G.mSinkDmgDepth);
            if (this.mHealth > 0 && this.mSinkTimer > lim) this.mSinkTimer = lim;
            if (this.world.moveTickCount % G.mSinkDmgTime === 0) this.floorDamageExec(1, 3, 0, this.mMotorParams.mMotorReturn);
            if (this.mSinkTimer > G.mSinkTime) { this.loserExec(); this.changePlayerStatus(S.SINK_LOSER, 0, false); }
            this.startVoice(SE.MV10A_CRY_SHORT_01);
            return;
        }
        if (this.mPollutionTypeStandingOn === POLLUTION_TYPE.INSTAKILL && this.checkFlag(MF.DIRTY)) {
            this.unk374 = fsub(this.unk374, this.mJumpParams.mGravity);
            this.unk378 = fadd(this.unk378, this.unk374);
            this.mVel.set(0, 0, 0); this.mForwardVel = 0; this.mSlideVelX = 0; this.mSlideVelZ = 0;
            this.loserExec();
            this.changePlayerStatus(S.SINK_LOSER, 0, false);
            return;
        }
        this.unk374 = 0; this.unk378 = 0; this.mSinkTimer = 0;
    }
    /**
     * TMario::checkWet: for 120 ticks after he leaves the water, a drop of water every 8th
     * (WetWaterEmit.prm) falls off him at his feet with 0.3 of his speed. They're FLUDD's kind of
     * water: landed, they wet the ground (a dive onto them slides wet) and clean goop.
     */
    private wetEmit: EmitInfo | null = null;
    checkWet() {
        if (!this.isMario() || this.onYoshi()) return;
        if (this.mWetWaterParticleTimer <= 0) return;
        this.mWetWaterParticleTimer -= 1;
        const [, floor] = this.checkGroundPlane(this.pos.x, fadd(this.pos.y, 320), this.pos.z);
        if (floor.isWaterSurface()) return;
        if (this.mFloorPosition.z > this.pos.y) return;
        if (this.checkStatusType(0x200)) return;
        if (this.mWetWaterParticleTimer & 7) return;
        const W = this.world.water;
        if (!W) return;
        const I = this.wetEmit || (this.wetEmit = emitInfo('/Mario/WetWaterEmit.prm', this.world.files));
        I.pos = [this.pos.x, fadd(this.pos.y, 5), this.pos.z];
        I.v = [fmul(this.mVel.x, fr(0.3)), fmul(this.mVel.y, fr(0.3)), fmul(this.mVel.z, fr(0.3))];
        W.emitRequest(I);
    }
    /** TMario::gunExec */
    gunExec() {
        const x = this.mGamePad.checkFrameMeaning(MEANING.X);
        if (playerHooks.gunExec) { playerHooks.gunExec(this, x); return; }
        marioGunExec(this as any, x);
    }
    thinkSound() { }
    /** TMario::thinkTorocco (inlined in playerControl @0x8012d4a8): the cart's seat turned by the stick */
    thinkTorocco() { this.mToroccoAngle = s16(Math.trunc(fmadd(this.unk108.mStickHS16, this.mDeParams.mToroccoRotSp, this.mToroccoAngle))); }

    // ---------------------------------------------------------------- the Pinna coaster (map 58)
    /** the cart (map/map/Torocco), the track (Pinna_rail for stage 0, Koopa_rail for 1: joint 0 runs along it on BCK 0) */
    mTorocco: MActor | null = null; mPinaRail: MActor | null = null; mKoopaRail: MActor | null = null;
    mRailType = 0; mToroccoAngle = 0; mToroccoPos = new V3();
    private toroccoTR: Mtx = mtx(); private railTR: Mtx = mtx();
    private static readonly ONE = new V3(1, 1, 1);
    /** MActor::calcAnm: the frames on, then the joints (here: joint j's world matrix as a game Mtx) */
    private static calcAnmMtx(a: MActor, base: Mtx, j: number): Mtx | null {
        a.frameUpdate();
        const m = a.anmMtx(j, base, PlayerMario.ONE);
        if (!m) return null;
        const out = mtx();
        for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) out[r * 4 + c] = m[c * 4 + r];
        return out;
    }
    /**
     * TMario::initModel's coaster part (MarioDraw.cpp): on map 58, stage 0 or 1, the cart and its
     * track; FLUDD on; he starts at the cart's seat (joint 2), facing his way (mToroccoAngle).
     * TODO: the track's base is set from the cart's joint 0 before the cart is ever calculated
     * (identity assumed here).
     */
    initTorocco() {
        const w = this.world as any;
        this.mTorocco = this.mPinaRail = this.mKoopaRail = null;
        if (w.map !== 58 || (w.stage !== 0 && w.stage !== 1)) return;
        try {
            this.mTorocco = new MActor('map/map/Torocco/Torocco.bmd', new AnmData('map/map/Torocco', w.files));
            const rail = (name: string) => {
                const r = new MActor(`map/map/${name}/${name}.bmd`, new AnmData(`map/map/${name}`, w.files));
                const c = r.getFrameCtrl(ANM_BCK); if (c) c.rate = fr(0.5);
                PlayerMario.calcAnmMtx(r, mtx(), 0);
                return r;
            };
            if (w.stage === 0) { this.mRailType = 0; this.mPinaRail = rail('Pinna_rail'); }
            else { this.mRailType = 1; this.mKoopaRail = rail('Koopa_rail'); }
            this.railTR = mtx();
            this.onFlag(MF.HAS_FLUDD);
            const seat = PlayerMario.calcAnmMtx(this.mTorocco, this.toroccoTR, 2);
            if (seat) this.pos.set(fr(seat[3]), fr(seat[7]), fr(seat[11]));
            this.mToroccoAngle = this.mFaceAngle.y;
        } catch (e) { console.warn('[player] torocco', e); this.mTorocco = this.mPinaRail = this.mKoopaRail = null; }
    }
    /** TMario::toroccoStart (0x8011fbxx): TOROCCO, the track's BCK 0 from frame 0 at 0.5 */
    toroccoStart() {
        this.changePlayerStatus(S.TOROCCO, 0, true);
        this.onUnk114(2);
        for (const r of [this.mPinaRail, this.mKoopaRail]) {
            if (!r) continue;
            r.setBckFromIndex(0);
            const c = r.getFrameCtrl(ANM_BCK);
            if (c) { c.rate = fr(0.5); c.frame = 0; }
        }
        return true;
    }
    /**
     * calcBaseMtxTorocco (inlined in calcBaseMtx @0x8012469c): the track on a frame, the cart on
     * the track's joint 0, Mario on the cart's seat (joint 2) turned by mToroccoAngle; his position
     * is the seat's (mToroccoPos keeps the one before).
     */
    calcBaseMtxTorocco(m: Mtx) {
        const rail = this.mRailType === 0 ? this.mPinaRail : this.mRailType === 1 ? this.mKoopaRail : null;
        if (rail) { const r0 = PlayerMario.calcAnmMtx(rail, this.railTR, 0); if (r0) this.toroccoTR = r0; }
        const seat = this.mTorocco ? PlayerMario.calcAnmMtx(this.mTorocco, this.toroccoTR, 2) : null;
        const rot = mtx();
        MsMtxSetRotRPH(rot, 0, fr(0.0054931640625 * this.mToroccoAngle), 0);
        const a = seat || mtx();
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) m[i * 4 + j] = fr(a[i * 4] * rot[j] + a[i * 4 + 1] * rot[4 + j] + a[i * 4 + 2] * rot[8 + j]);
            m[i * 4 + 3] = a[i * 4 + 3];
        }
        this.mToroccoPos.set(this.pos);
        this.pos.set(fr(m[3]), fr(m[7]), fr(m[11]));
    }
    /** TMario::getOffYoshi: knocked off (fly: status 0x89C) or jumping off (X: a back jump of mGetOffYoshiY) */
    getOffYoshi(fly: boolean) {
        this.mInput &= ~0x8000;
        if (fly) { this.changePlayerStatus(0x89C, 0, false); this.mYoshi!.getOff(true); }
        else { this.changePlayerStatus(S.BACK_JUMP, 0, false); this.mVel.y = this.mJumpParams.mGetOffYoshiY; this.mYoshi!.getOff(false); }
        this.setAnimation(A.JUMP, 1);
        this.unk78 &= ~0x100;
        this.pos.y = fadd(this.pos.y, 100);
        this.mForwardVel = -8;
        const G = this.mWaterGun;
        if (G) { G.changeNozzle(NOZZLE.Hover, true); this.normalizeNozzle(); G.resetWaterToFull(); }
        this.event('yoshiOff', { fly });
    }
    checkYoshiGetOff() { if (this.onYoshi() && this.mGamePad.checkFrameMeaning(MEANING.X)) this.getOffYoshi(false); }
    /** TMario::thinkYoshiHeadCollision: Yoshi's head (mHeadFront ahead) kept out of the walls, Mario pushed back (at most 50) */
    thinkYoshiHeadCollision() {
        if (!this.onYoshi()) return;
        const Y = this.mYoshiParams, front = Y.mHeadFront;
        const hx = fmadd(front, JMASSin(this.mFaceAngle.y), this.pos.x), hz = fmadd(front, JMASCos(this.mFaceAngle.y), this.pos.z);
        const r = wallRecord(hx, fadd(this.pos.y, 100), hz, Y.mHeadRadius, 4, 0);
        if (this.isTouchedWallsAndMoveXZ(r)) {
            let dx = fsub(r.center[0], hx), dz = fsub(r.center[2], hz);
            const f4 = sqrtf(fadd(fmul(dx, dx), fmul(dz, dz)));
            let f2 = f4;
            if (f4 > 0) {
                const k = fdiv(1, f4);
                dx = fmul(dx, k); dz = fmul(dz, k);
                if (50 < f4) f2 = 50;
                dx = fmul(dx, f2); dz = fmul(dz, f2);
                this.pos.x = fadd(this.pos.x, dx); this.pos.z = fadd(this.pos.z, dz);
            }
        }
    }

    // ---------------------------------------------------------------- MarioJump.cpp: the rocket and hover nozzles
    hoverHeight() { const W = this.mWaterGun && this.mWaterGun.mWatergunParams; return W ? (W.mHHoverHeight ?? W.mHoverHeight ?? 160) : 160; }
    gunCanSpray() { return this.canSprayGun(); }
    canSprayGun() { const G = this.mWaterGun; return !!G && (G.canSpray ? G.canSpray() : G.isEmitting()); }
    rocketCheck() {
        let ok = true;
        if (this.mStatus === S.ROCKET) ok = false;
        if (this.mStatus === S.ROCKET_LANDING) ok = false;
        const G = this.mWaterGun;
        if (this.checkFlag(MF.HAS_FLUDD) && G) {
            if (G.getCurrentNozzle().mRocketType !== 1) ok = false;
            if (this.mUpperState !== UPPER.PUMPING) ok = false;
            if (!this.canSprayGun()) ok = false;
        } else ok = false;
        if (ok) { this.unk314 = fadd(this.pos.y, this.hoverHeight()); return this.changePlayerStatus(S.ROCKET, 0, false) !== 0; }
        return false;
    }
    rocketing() {
        const G = this.mWaterGun as any;
        if (!this.checkFlag(MF.HAS_FLUDD) || !G) return this.changePlayerStatus(S.ROCKET_LANDING, 0, false);
        const N = G.getCurrentNozzle();
        if (N.mRocketType !== 1) return this.changePlayerStatus(S.ROCKET_LANDING, 0, false);
        if (this.mUpperState !== UPPER.PUMPING || !this.canSprayGun()) return this.changePlayerStatus(S.ROCKET_LANDING, 0, false);
        if (this.mInput & 1) {
            if (G.mCurrentNozzle === NOZZLE.Hover) {
                const mag = this.mIntendedMag;
                const d = s16(this.mIntendedYaw - this.mFaceAngle.y);
                if ((d > -0x1555 && d < 0x1555) || d < -0x6AAA || d > 0x6AAA) {
                    const max = d >= -0x4000 && d <= 0x4000 ? N.getSideAngleMaxFront() : N.getSideAngleMaxBack();
                    const na = s16f(fmul(fmul(fmul(0.03125, -mag), max), JMASCos(d & 0xFFFF)));
                    G.unk1CC2 = na; G.unk1CC4 = na;
                    this.mForwardVel = fmadd(fmul(mag, JMASCos(d & 0xFFFF)), this.mDivingParams.mAccelControl, this.mForwardVel);
                } else {
                    const na = s16f(fmul(fmul(fmul(0.03125, -mag), N.getSideAngleMaxSide()), JMASSin(d & 0xFFFF)));
                    G.unk1CC2 = s16(-na); G.unk1CC4 = na;
                    const rot = this.mHoverParams.mRotSp;
                    this.mFaceAngle.y = s16(this.mIntendedYaw - IConverge(s16(this.mIntendedYaw - this.mFaceAngle.y), 0, rot, rot));
                }
            }
        } else { G.unk1CC2 = 0; G.unk1CC4 = 0; }
        this.mSlideVelX = fmul(this.mForwardVel, JMASSin(this.mFaceAngle.y));
        this.mSlideVelZ = fmul(this.mForwardVel, JMASCos(this.mFaceAngle.y));
        this.mVel.x = this.mSlideVelX; this.mVel.z = this.mSlideVelZ;
        if (G.mCurrentNozzle === NOZZLE.Hover) {
            this.mVel.y = fmul(fsub(this.unk314, this.pos.y), this.mHoverParams.mAccelRate);
            this.mForwardVel = fmul(this.mForwardVel, this.mHoverParams.mBrake);
        }
        if (this.jumpProcess(2) === 4) this.changePlayerStatus(S.HANG_ROOF, 0, false);
        if (this.mRoofPlane && fadd(160, this.pos.y) > this.mFloorPosition.x) this.pos.y = fsub(this.mFloorPosition.x, 160);
        this.setAnimation(A.LAND, 1);
        return 0;
    }

    // ---------------------------------------------------------------- MarioUpper.cpp
    checkPumping() {
        if (this.unk108.mAnalogR > 0 && this.mUpperState !== UPPER.PUMPING) { this.mUpperState = UPPER.PUMPING; this.mPumpCooldown = 0; return; }
        if (this.camera.isLButtonCamera && this.camera.isLButtonCamera() && this.checkPumpEnable()) { this.mUpperState = UPPER.HOLDING_PUMP; this.mPumpCooldown = 0; return; }
        if (this.mStatus === S.TOROCCO) { this.mUpperState = UPPER.HOLDING_PUMP; this.mPumpCooldown = 0; return; }
        if (this.mStatus === S.SQUAT && this.mUpperState === UPPER.IDLE) { this.mUpperState = UPPER.HOLDING_PUMP; this.mPumpCooldown = 0; return; }
        if (this.checkFlag(MF.FLUDD_EMITTING)) { this.mUpperState = UPPER.PUMPING; this.mPumpCooldown = 0; return; }
    }
    /**
     * TMario::addUpper: pumping (or holding the pump) puts the chest down on the animation's upper-body
     * BCK (gMarioAnimeData.unk2: the pump), holding an object on 0x4b, idle takes it off; pumping
     * ping-pongs it (its rate the R analog's only with the tank empty: else init's 1).
     */
    addUpper() {
        const fc = this.mModel.fc[1];
        if (this.mUpperState === UPPER.FIXED_ANIMATION) return;
        switch (this.mUpperState) {
            case UPPER.PUMPING: case UPPER.HOLDING_PUMP:
                if (this.onYoshi()) { this.mModel.upperCalc = -1; return; }
                if (ANIME_DATA[this.mAnimationId][1] !== 0xC8) { this.mModel.upperCalc = 1; this.mModel.changeAnm(1, ANIME_DATA[this.mAnimationId][1]); }
                break;
            case UPPER.HOLDING_OBJECT: this.mModel.upperCalc = 1; this.mModel.changeAnm(1, 0x4b); break;
            case UPPER.IDLE: this.mModel.upperCalc = -1; break;
        }
        if (this.mUpperState === UPPER.PUMPING) {
            fc.attr = FC_PINGPONG_LOOP;
            this.mPumpAnmRate = fmul(this.mGamePad.mCompSPos[3], this.mUpperBodyParams.mPumpAnmSpeed);
            if (this.mWaterGun && this.mWaterGun.mCurrentWater <= 0) {
                // (the pumping sounds at frames 8 and 13: the audio side's)
                fc.rate = fc.rate >= 0 ? this.mPumpAnmRate : -this.mPumpAnmRate;
            }
        }
    }
    checkPumpEnable() {
        const G = this.mWaterGun;
        const animOk = this.mAnimationId >= 0 && this.mAnimationId < ANIME_DATA.length && ANIME_DATA[this.mAnimationId][1] !== 200;
        if (G && this.checkFlag(MF.HAS_FLUDD) && animOk && !this.onYoshi()
            && (!this.isSinking() || !(fdiv(this.mSinkTimer, this.mGraffitoParams.mSinkTime) > this.mGraffitoParams.mSinkPumpLimit))
            && this.mUpperState !== UPPER.FIXED_ANIMATION && this.mUpperState !== UPPER.UNK3 && this.mUpperState !== UPPER.HOLDING_OBJECT
            && (this.mStatus !== S.ROCKET_LANDING || !G.checkCurrentNozzleRocketType(NOZZLE.Rocket))
            && (!G.checkCurrentNozzleKind(NOZZLE.Rocket) || !G.checkCurrentNozzleTriggerSprayState(2))
            && !G.isSwitchingToPrimaryNozzle() && !G.isSwitchingToSecondaryNozzle() && !this.checkStatusType(S.FLAG_UNK1000)) return true;
        this.mUpperState = UPPER.IDLE;
        this.mPumpCooldown = 0;
        return false;
    }
    stateMachineUpper() {
        switch (this.mUpperState) {
            case UPPER.PUMPING:
                if (!this.checkPumpEnable()) { this.mModel.fc[1].frame = 0; this.mUpperState = UPPER.IDLE; }
                if (this.unk108.mAnalogR === 0) { this.mUpperState = UPPER.HOLDING_PUMP; this.mPumpCooldown = this.mUpperBodyParams.mPumpWaitTime; }
                break;
            case UPPER.HOLDING_PUMP:
                if (!this.checkPumpEnable()) { this.mModel.fc[1].frame = 0; this.mUpperState = UPPER.IDLE; }
                if (this.mPumpCooldown !== 0) this.mPumpCooldown = (this.mPumpCooldown - 1) & 0xFFFF;
                else { this.mModel.fc[1].frame = 0; this.mUpperState = UPPER.IDLE; }
                this.checkPumping();
                break;
            case UPPER.HOLDING_OBJECT:
                if (this.mStatus === S.PUTTING) this.mUpperState = UPPER.IDLE;
                if (!this.mHeldObject) this.mUpperState = UPPER.IDLE;
                break;
            case UPPER.FIXED_ANIMATION:
                // someAnimationCompleted: the upper body's frame control completed or looped once
                if (this.mModel.fc[1].state & 3) this.mUpperState = UPPER.IDLE;
                break;
            default:
                if (this.checkPumpEnable()) this.checkPumping();
                break;
        }
    }

    /** TMario::setUpperDamageRun (0x80124238): the upper body's flinch (bck 0x4a) at half speed while he runs on */
    setUpperDamageRun() {
        const fc = this.mModel.fc[1];
        this.mModel.upperCalc = 1;
        this.mModel.changeAnm(1, 0x4a);
        fc.frame = fc.start;
        fc.rate = 1; fc.rate = fr(0.5);
        this.mUpperState = UPPER.FIXED_ANIMATION;
    }

    // ---------------------------------------------------------------- MarioCollision.cpp
    incHP(hp: number) {
        if (this.isUnderWater() || this.checkFlag(MF.HELMET_FLW_CAMERA)) {
            this.mAir = fadd(this.mAir, hp);
            if (this.mAir > this.mMaxAir) this.mAir = this.mMaxAir;
            return;
        }
        this.mHealth += hp;
        if (this.mHealth > this.mDeParams.mHPMax) this.mHealth = this.mDeParams.mHPMax;
    }
    decHP(hp: number) {
        if (this.isUnderWater() || this.checkFlag(MF.HELMET_FLW_CAMERA)) {
            this.mAir = fsub(this.mAir, hp);
            if (this.mAir < 1) { this.loserExec(); this.changePlayerStatus(S.SWIM_DOWN, 0, true); }
            return;
        }
        this.mHealth -= hp;
        if (0 >= this.mHealth) { this.mHealth = 0; this.loserExec(); }
    }
    getAttackAngle(o: HitActor) { return matan(fsub(o.pos.z, this.pos.z), fsub(o.pos.x, this.pos.x)); }
    isTakeSituation(o: HitActor) {
        if (this.mInvincibilityFrames > 0) return false;
        if (this.checkStatusType(S.FLAG_UNK80000000)) return false;
        if (this.checkStatusType(S.FLAG_UNK10000000)) return false;
        if (this.mStatus === S.CATCH) return false;
        if (this.onYoshi()) return false;
        if (this.mUpperState !== UPPER.IDLE) return false;
        if (this.mHeldObject) return false;
        if (this.holder) return false;
        const a = s16(this.getAttackAngle(o) - this.mFaceAngle.y);
        if (a <= -0x2aaa || a >= 0x2aaa) return false;
        const dx = fsub(o.pos.x, this.pos.x), dy = fsub(o.pos.y, this.pos.y), dz = fsub(o.pos.z, this.pos.z);
        const d = MsSqrtf(fadd(fadd(fmul(dx, dx), fmul(dy, dy)), fmul(dz, dz)));
        if (d > fadd(this.attackRadius, o.damageRadius)) return false;
        return true;
    }
    canTake(o: HitActor) { return this.mGamePad.checkMeaning(MEANING.B) && this.isTakeSituation(o); }
    trampleExec(a: HitActor) {
        if (!this.checkStatusType(S.FLAG_JUMPING)) return false;
        if (this.mStatus === S.DIVE) return false;
        if (!a.receiveMessage(this, MSG.TRAMPLE)) return false;
        if (this.mStatus === S.BROAD_JUMP) this.changePlayerStatus(S.BACK_JUMP, 0, false);
        else {
            switch (this.mAnimationId) {
                case A.STEP1: this.setAnimation(A.STEP2, 1); break;
                case A.STEP2: case A.STEP3: this.setAnimation(A.STEP3, 1); this.mModel.fc[0].frame = 0; break;
                default: this.setAnimation(A.STEP1, 1); break;
            }
            this.changePlayerStatus(S.TRAMPLE, 0, false);
            this.setStatusToJumping(S.TRAMPLE, 0);
        }
        this.unk78 &= ~0x100;
        this.mModel.fc[0].attr = 0;
        return true;
    }
    normalizeNozzle() {
        if (this.checkFlag(MF.HAS_FLUDD) && this.mWaterGun) { this.mWaterGun.changeNozzle(NOZZLE.Spray, true); this.unk144 = -1; this.unk148 = null; }
    }
    loserExec() {
        if (this.mStatus !== S.SWIM_DOWN && this.mStatus !== S.ELEC_DOWN && this.mStatus !== S.SWIM_P_DOWN && this.mStatus !== S.DOWN_LOSER) {
            this.onFlag(MF.GAME_OVER);
            this.mHealth = 0;
            this.lostLives.push(this.world.tickCount);
            this.event('loser');
            if (this.mYoshi) this.mYoshi.kill();
            if (this.checkStatusType(S.FLAG_SWIMMING)) { this.changePlayerStatus(this.mAir < 1 ? S.SWIM_DOWN : S.SWIM_P_DOWN, 0, true); return; }
            this.changePlayerStatus(this.mStatus === S.ELECTRIC_DAMAGE ? S.ELEC_DOWN : S.DOWN_LOSER, 0, true);
        }
    }
    floorDamageExec(damage: number, downType: number, waterEmit: number, motor: number) {
        if (this.isInvincible()) return;
        this.mFloorHitActor.pos.x = fadd(this.pos.x, JMASSin(this.mFaceAngle.y));
        this.mFloorHitActor.pos.z = fadd(this.pos.z, JMASCos(this.mFaceAngle.y));
        this.damageExec(this.mFloorHitActor, damage, downType, waterEmit, 16, motor, 0, 60);
    }
    floorDamageExecParams(p: { [k: string]: number }) {
        if (this.isInvincible()) return;
        this.mFloorHitActor.pos.x = fadd(this.pos.x, JMASSin(this.mFaceAngle.y));
        this.mFloorHitActor.pos.z = fadd(this.pos.z, JMASCos(this.mFaceAngle.y));
        this.damageExec(this.mFloorHitActor, p.mDamage, p.mDownType, p.mWaterEmit, p.mMinSpeed, p.mMotor, p.mDirty, p.mInvincibleTime);
    }
    calcDamagePos(p: V3) {
        const o = new V3(fsub(p.x, this.pos.x), fsub(p.y, this.pos.y), fsub(p.z, this.pos.z));
        if (o.x === 0 && o.y === 0 && o.z === 0) { this.mDamagePos.set(this.pos); return; }
        const l = MsSqrtf(fadd(fadd(fmul(o.x, o.x), fmul(o.y, o.y)), fmul(o.z, o.z)));
        const k = fdiv(1, l);
        this.mDamagePos.set(fmadd(fmul(o.x, k), 50, this.pos.x), fmadd(fmul(o.y, k), 50, this.pos.y), fmadd(fmul(o.z, k), 50, this.pos.z));
    }
    /** the damage's statuses: [front / back][ground / air][down type] */
    private static readonly DAMAGE_STATUS = [
        [[S.SAFE_BACK_DOWN, S.SHORT_BACK_DOWN, S.BACK_DOWN, S.WAIT], [S.JUMP_SHORT_BACK_DOWN, S.JUMP_SHORT_BACK_DOWN, S.JUMP_BACK_DOWN, S.WAIT]],
        [[S.SAFE_FORE_DOWN, S.SHORT_FORE_DOWN, S.FORE_DOWN, S.WAIT], [S.JUMP_SHORT_FORE_DOWN, S.JUMP_SHORT_FORE_DOWN, S.JUMP_FORE_DOWN, S.WAIT]],
    ];
    damageExec(hit: HitActor | null, damage: number, downType: number, waterEmit: number, speed: number, motor: number, dirty: number, invincible: number) {
        if (this.isInvincible()) return;
        if (this.checkFlag(MF.GAME_OVER)) return;
        if (this.mHealth === 0) return;
        if (this.onYoshi()) { this.getOffYoshi(true); return; }   // (MSD_SE_YV_DAMAGE)
        const air = this.checkStatusType(S.FLAG_JUMPING) ? 1 : 0;
        const from = hit || this.mFloorHitActor;
        if (downType === 3) {
            if (this.mStatus === S.RUN || this.mStatus === S.OIL_RUN) this.setUpperDamageRun();
        } else {
            const att = this.getAttackAngle(from);
            const prev = this.mFaceAngle.y;
            this.mFaceAngle.y = att;
            const diff = s16(att - prev);
            if (this.mForwardVel < speed) this.setPlayerVelocity(speed);
            let side = 0;
            if (diff >= -0x4000 && diff <= 0x4000) { side = 0; this.mForwardVel = fmul(this.mForwardVel, -1); }
            else { side = 1; this.mFaceAngle.y = s16(this.mFaceAngle.y + 0x8000); }
            let canAnim = true;
            if (this.mStatus === S.TOROCCO) canAnim = false;
            if (this.mStatus === S.DIVE) canAnim = false;
            if (this.checkStatusType(S.FLAG_SWIMMING)) canAnim = false;
            if (canAnim) {
                const st = PlayerMario.DAMAGE_STATUS[side][air][downType] >>> 0;
                if (this.holder && this.holder.actorType === AT.MAP_WIRE_ACTOR) this.changePlayerDropping(S.WIRE_HANG_LAND_SAFE_DOWN, 0);
                else this.changePlayerDropping(st, 0);
            }
        }
        this.mInvincibilityFrames = invincible;
        this.decHP(damage);
        if (this.checkFlag(MF.HAS_FLUDD) && this.mWaterGun) for (let i = 0; i < waterEmit; i++) this.mWaterGun.damage();
        if (downType !== 3) this.calcDamagePos(from.pos);
        if (this.mHealth > 0) this.startVoice(damage > 1 ? SE.MV01_DAMAGE_BIG_01 : downType === 0 ? SE.MV03_DAMAGE_LITLE_01 : SE.MV02_DAMAGE_MID_01);
        this.mDirty = fadd(this.mDirty, dirty);
        this.dirtyLimitCheck();
        this.event('damage', { damage, downType, hp: this.mHealth });
    }
    /** TMario::considerTake: let go of what he can't hold any more */
    considerTake() {
        let keep = false;
        if (this.mUpperState === UPPER.HOLDING_OBJECT) keep = true;
        if (this.mUpperState === UPPER.UNK3) keep = true;
        if (this.mStatus === S.TAKE || this.checkStatusType(S.FLAG_UNK80000000)) keep = true;
        if (this.mStatus === S.PULLING || this.mStatus === S.PULL_JUMP || this.mStatus === S.OIL_PULLING) keep = true;
        if (this.mHeldObject && this.mHeldObject.holder !== this) this.mHeldObject = null;
        if (this.holder && this.holder.held !== this) this.holder = null;
        if (this.mHeldObject && !keep) {
            const h = this.mHeldObject as HitActor;
            h.receiveMessage(this, MSG.THROWN);
            h.receiveMessage(this, MSG.DETACH);
            this.mHeldObject = null;
        }
        if (this.holder) {
            const t = this.mStatus & 0x1FF;
            const keep2 = (t >= 0x150 && t <= 0x15c) || (t >= 0x140 && t <= 0x143) || this.checkStatusType(S.FLAG_UNK1000) || this.mStatus === S.TAKEN;
            if (!keep2) {
                const h = this.holder;
                h.receiveMessage(this, MSG.DETACH);
                h.receiveMessage(this, MSG.THROWN);
                this.holder = null;
            }
        }
    }

    // ---------------------------------------------------------------- MarioReceiveMsg.cpp
    getNozzle(_sender: HitActor, type: number) {
        if (this.onYoshi()) return false;
        this.onFlag(MF.HAS_FLUDD);
        if (this.mWaterGun) this.mWaterGun.changeNozzle(type, true);
        this.unk144 = 3600;
        this.unk148 = _sender;
        if (this.mWaterGun) this.mWaterGun.resetWaterToFull();
        this.event('nozzleGet', { type });
        return true;
    }
    /**
     * TMario::getGesso (0x80164248): onto a surfing Blooper: facing its way, SURF, frozen for
     * mSurfStartFreezeTime (mStatusTimer), the Blooper's colour picks the surfing params (unk389).
     * (The condition is mStatus != 0x10000 in the DOL: always true.)
     */
    getGesso(sender: HitActor) {
        if (this.mStatus === 0x10000) return;
        this.mFaceAngle.y = s16(s32f(fmul(fr(182.04445), sender.rot.y)));
        this.mModelFaceAngle = this.mFaceAngle.y;
        this.changePlayerStatus(S.SURF, 0, false);
        this.mStatusTimer = this.mDeParams.mSurfStartFreezeTime & 0xFFFF;
        const t = sender.actorType;
        this.mSurfGessoType = t === T.SURF_GESO_RED ? 0 : t === T.SURF_GESO_YELLOW ? 1 : 2;
        // (mSurfGesso: gpMapObjManager's red / yellow / green surfgeso model, surfgeso_run1 at 0.5: drawn under him)
        this.mSurfGesso = sender;
        this.event('surfStart', { type: this.mSurfGessoType });
    }
    /** the Blooper he surfs (mSurfGesso: for drawing; the game draws gpMapObjManager's model of that colour) */
    mSurfGesso: HitActor | null = null;
    getCoin() { ++this.mCoinCount; this.incHP(1); }
    getCoinRed() { this.incHP(2); }
    getCoinBlue() { this.incHP(2); }
    private dmg(sender: HitActor, p: { [k: string]: number }) {
        this.damageExec(sender, p.mDamage, p.mDownType, p.mWaterEmit, p.mMinSpeed, p.mMotor, p.mDirty, p.mInvincibleTime);
    }
    private fireDamage(sender: HitActor, p: { [k: string]: number }) {
        this.dmg(sender, p);
        this.changePlayerStatus(S.FIRE_DOWN, 1, false);
        this.event('burn');
    }
    private static readonly ENEMY_COMMON = types('BOSS_PAKKUN', 'BOSS_PAKKUN_ATTACK', 'BOSS_PAKKUN_HEAD', 'BOSS_UNK12', 'PAKKUN', 'POLLUTE_OBJ', 'GESSO', 'MAME_GESSO',
        'ENEMY_UNK9', 'TELESA', 'DANGO_HAMU_KURI', 'PUKU_PUKU', 'LAUNCHER', 'CHUU_HANA', 'IGAIGA', 'TAMA_NOKO', 'GOROGORO', 'HANA_SAMBO', 'SAMBO_HEAD',
        'DPT_CANNON', 'ENEMY_UNK1D', 'EFFECT_OBJ', 'BIANCO_GATE_KEEPER', 'SEAL', 'HAUNT_LEG', 'KAZEKUN', 'YUMBO', 'KUMOKUN', 'AMENBO', 'KUKKU', 'BEE',
        'DEBU_TELESA', 'ENEMY_DAMAGE_OBJ');
    private static readonly FIRE_ENEMY = types('EFFECT_ENEMY', 'FIRE_WANWAN', 'FIRE_HAMU_KURI', 'BOMB_HEI', 'WIRE_TRAP');
    private static readonly TENTACLE = types('BOSS_EEL', 'BOSS_MANTA', 'BOSS_GESSO_TENTACLE', 'BOSS_GESSO_TAKE_HIT', 'BOSS_UNK8', 'COASTER_KILLER',
        'BOSS_EEL_TOOTH', 'BOSS_EEL_COLLISION', 'TIN_KOOPA_FLAME', 'HANE_HAMU_KURI', 'TABE_PUKU');
    private static readonly POLES = types('DPTLIGHT', 'TELEGRAPH_POLE_L', 'MAP_OBJECT_UNK32', 'PALM_NORMAL', 'PALM_OUGI', 'PALM_SAGO', 'PALM_NATUME',
        'BANANA_TREE', 'FRUIT_TREE', 'WOOD_BARREL');
    private static readonly NO_THUMP = types('COIN', 'COIN_RED', 'COIN_BLUE', 'HIDE_OBJ', 'SHINE', 'WATERGUN_ITEM', 'NORMAL_NOZZLE_ITEM', 'ROCKET_NOZZLE_ITEM', 'BACK_NOZZLE_ITEM');
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (this.checkFlag(MF.GAME_OVER)) return false;
        const t = sender.actorType;
        const inv = () => this.isInvincible();
        if (msg === MSG.THROWN) {
            if (t === T.POI_HANA) this.startVoice(SE.MV27_SPRISE_01);
            // (said unless that same line is what he's saying: the audio side checks)
            if (sender.isHitCategory(HC.MAP_OBJECT)) this.startVoice(SE.MV28_SPRISE_SMALL_01, { unlessId: SE.MV28_SPRISE_SMALL_01 });
            this.changePlayerStatus(S.THROWN_DOWN, 0, false);
            return true;
        }
        if (sender.isHitCategory(HC.ITEM)) {
            switch (t) {
                case T.BOTTLE_SHORT: if (msg === MSG.ATTACK) { if (this.checkFlag(MF.HAS_FLUDD) && this.mWaterGun) this.mWaterGun.addWater(Math.trunc(this.mWaterGun.getMaxWater() / 2)); this.event('waterRecover'); return true; } break;
                case T.BOTTLE_LARGE: if (msg === MSG.ATTACK) { if (this.checkFlag(MF.HAS_FLUDD) && this.mWaterGun) this.mWaterGun.addWater(this.mWaterGun.getMaxWater()); this.event('waterRecover'); return true; } break;
                case T.BOSS_EEL_TEARS: if (msg === MSG.ATTACK) { this.incHP(8); return true; } break;
                case T.ITEM_UNK3: if (msg === MSG.ATTACK) { this.incHP(4); if (this.checkFlag(MF.HAS_FLUDD) && this.mWaterGun) this.mWaterGun.addWater(this.mWaterGun.getMaxWater()); return true; } break;
                case T.ITEM_UNK4: if (msg === MSG.ATTACK) { this.incHP(1); return true; } break;
                case T.MUSHROOM1UP: case T.MUSHROOM1UP_R: case T.MUSHROOM1UP_X:
                    if (msg === MSG.ATTACK) {
                        const m = sender as any;
                        if (!((m.unk13A | 0) === 0 && (m.unk13C | 0) < 120)) {
                            this.mHealth = this.mDeParams.mHPMax;
                            if (this.checkFlag(MF.HAS_FLUDD) && this.mWaterGun) this.mWaterGun.addWater(this.mWaterGun.getMaxWater());
                            this.event('1up');
                            return true;
                        }
                        return false;
                    }
                    break;
                case T.ROCKET_NOZZLE_ITEM: return this.getNozzle(sender, NOZZLE.Rocket);
                case T.NORMAL_NOZZLE_ITEM: return this.getNozzle(sender, NOZZLE.Hover);
                case T.BACK_NOZZLE_ITEM: return this.getNozzle(sender, NOZZLE.Turbo);
                case T.ITEM_UNK2B: this.changePlayerStatus(S.DIVE, 0, false); return this.getNozzle(sender, NOZZLE.Underwater);
                case T.WATERGUN_ITEM: this.getNozzle(sender, NOZZLE.Spray); return true;
                case T.MARIO_CAP: this.mCapModel |= 1; this.mHealth = this.mDeParams.mHPMax; return true;
                case T.COIN: this.getCoin(); return true;
                case T.COIN_RED: this.getCoinRed(); return true;
                case T.COIN_BLUE: this.getCoinBlue(); return true;
                case T.SHINE:
                    if (msg === MSG.ATTACK && this.mStatus !== S.WIN_DEMO) {
                        this.unk384 = sender;
                        this.pos.x = sender.pos.x; this.pos.z = sender.pos.z;
                        const ir = (sender as any).mInitialRotation || (sender as any).initRot || sender.rot;
                        this.mFaceAngle.y = s16f(fr(fr(ir.y * fr(1 / 360)) * 65536));
                        this.mModelFaceAngle = this.mFaceAngle.y;
                        this.setPlayerVelocity(0);
                        this.mHealth = this.mDeParams.mHPMax;
                        this.mAir = this.mMaxAir;
                        this.changePlayerStatus(S.WIN_DEMO, 0, true);
                        this.event('shineGet');
                        return true;
                    }
                    break;
            }
        }
        if (sender.isHitCategory(HC.MAP_OBJECT)) {
            switch (t) {
                case T.LAMPTRAPIRON: if (msg === MSG.BURN && !inv()) { this.fireDamage(sender, this.mDmgParamsLampTrapIron); return true; } break;
                case T.LAMPTRAPSPIKE: if (msg === MSG.ATTACK && !inv()) { this.dmg(sender, this.mDmgParamsLampTrapSpike); return true; } break;
                case T.SURF_GESO_RED: case T.SURF_GESO_YELLOW: case T.SURF_GESO_GREEN: this.getGesso(sender); return true;
                case T.BATH: if (msg === MSG.TAKE) { this.holder = sender as TakeActor; this.changePlayerStatus(S.NOMOTION, 0, false); return true; } break;
                case T.BATH_WATER:
                    if (msg === MSG.BURN) {
                        if (!inv()) { this.dmg(sender, this.mDmgParamsFire); this.startVoice(SE.MV27_SPRISE_01); this.changePlayerStatus(S.THROWN_DOWN, 1, false); return true; }
                        return false;
                    }
                    break;
                case T.MAP_WIRE_ACTOR: {
                    // catching a tightrope (any message: the wire actor sends TAKE)
                    if (this.holder) return false;
                    if (this.mStatus === S.WIRE_JUMP && this.mVel.y > 0) return false;
                    if (this.mStatus === S.WIRE_ROLL_JUMP && this.mVel.y > 0) return false;
                    if (this.mStatus === S.WIRE_HANG_LAND_SAFE_DOWN) return false;
                    if (this.onYoshi()) return false;
                    this.holder = sender as TakeActor;
                    const wire = sender as any as { getTipPoints(a: V3, b: V3): void; getPosInWire(): number };
                    wire.getTipPoints(this.mWireStartPos, this.mWireEndPos);
                    this.mWirePosRatio = wire.getPosInWire();
                    this.wireMove(0);
                    this.offFlag(MF.UNK100);
                    const d = V3.sub(this.mWireEndPos, this.mWireStartPos);
                    const toEnd = s16(matan(d.z, d.x) - this.mFaceAngle.y);
                    this.mWireBounceVel = fr(fr(0.2) * -this.mVel.y);
                    this.mWireSag = 0;
                    // from below (rising, a roll jump, a dive): hanging, facing so the wire runs left to right
                    const hang = this.mStatus === S.WIRE_ROLL_JUMP || this.mStatus === S.JUMP_CATCH || !(this.mVel.y < 0);
                    if (hang) {
                        if (toEnd > 0) this.wireFlipEnds();
                        this.changeWireHanging();
                        return true;
                    }
                    // landing on it: walking towards the end he faces
                    if (toEnd <= -0x4000 || toEnd > 0x4000) this.wireFlipEnds();
                    this.changePlayerStatus(S.WIRE_WAIT, 0, false);
                    return true;
                }
            }
        }
        if (sender.isHitCategory(HC.ENEMY)) {
            switch (t) {
                case T.NAME_KURI: if (msg === MSG.ATTACK && !inv()) { this.dmg(sender, this.mDmgParamsNamekuri); return true; } break;
                case T.DORO_HANE_KURI: case T.DORO_HAMU_KURI: if (msg === MSG.ATTACK && !inv()) { this.mCapModel &= ~1; this.dmg(sender, this.mDmgParamsEnemyCommon); return true; } break;
                case T.SROTDRAM: case T.HAMU_KURI: if (msg === MSG.ATTACK && !inv()) { this.dmg(sender, this.mDmgParamsHamakuri); return true; } break;
                case T.ELEC_NOKONOKO:
                    if (msg === MSG.ATTACK && !inv()) { this.dmg(sender, this.mDmgParamsHamakuri); return true; }
                // fallthrough
                case T.ELEC_CARAPACE: case T.AMI_NOKO: case T.AMIKING:
                    if (msg === MSG.ELECTRIC_SHOCK && !inv()) { this.changePlayerStatus(S.ELECTRIC_DAMAGE, 0, false); return true; }
                    this.keepDistance(sender.pos, fadd(sender.damageRadius, 30), 0);
                    return true;
                case T.ENEMY_UNK1F:
                    if ((msg === MSG.BURN || msg === MSG.ATTACK) && !inv()) { this.fireDamage(sender, this.mDmgParamsKiller); return true; }
                    break;
                case T.DAMAGE_OBJ:
                    if (this.checkFlag(MF.IN_ANY_WATER) && msg === MSG.ATTACK && !inv()) { this.dmg(sender, this.mDmgParamsEnemyCommon); return true; }
                    break;
                case T.ROCKET: case T.POPO:
                    if (msg === MSG.ATTACH && this.checkFlag(MF.HAS_FLUDD) && this.mWaterGun && this.mWaterGun.onFlag) this.mWaterGun.onFlag(4);
                    break;
                case T.POI_HANA: if (!inv() && msg === MSG.ATTACK) { this.dmg(sender, this.mDmgParamsPoihana); return true; } break;
                default:
                    if (PlayerMario.ENEMY_COMMON.has(t)) {
                        if (msg === MSG.ATTACK && !inv()) { this.dmg(sender, this.mDmgParamsEnemyCommon); return true; }
                        this.keepDistance(sender.pos, fadd(sender.damageRadius, 30), 0);
                        return true;
                    }
                    if (PlayerMario.FIRE_ENEMY.has(t)) {
                        if (msg === MSG.ATTACK && !inv()) { this.dmg(sender, this.mDmgParamsFire); return true; }
                        if ((msg === MSG.ELECTRIC_SHOCK || msg === MSG.BURN) && !inv()) { this.fireDamage(sender, this.mDmgParamsFire); return true; }
                    }
                    break;
            }
        }
        switch (t) {
            case T.BOSS_UNK29:
                if (msg === MSG.BURN) { if (!inv()) this.fireDamage(sender, this.mDmgParamsFire); return true; }
                return false;
            case T.BOSS_UNK2A: case T.BOSS_UNK2C:
                if (msg === MSG.ATTACK && !inv()) { this.dmg(sender, this.mDmgParamsEnemyCommon); return true; }
            // fallthrough
            case T.HINOKURI2:
                if (msg === MSG.ATTACK && !inv()) { this.dmg(sender, this.mDmgParamsHinokuri); return true; }
                if (msg === MSG.SUPER_HIP_DROP && !inv()) { this.onFlag(MF.GROUND_POUND_SIT_UP); return true; }
                break;
            case T.BOSS_TELESA:
                if (msg === MSG.TAKE) { if (!this.mHeldObject && !this.holder) { this.holder = sender as TakeActor; this.changePlayerStatus(S.WAIT, 0, false); return true; } }
                else if (msg === MSG.ATTACK) { if (!inv()) { this.dmg(sender, this.mDmgParamsBGTentacle); return true; } }
                else if (msg === MSG.DETACH) { this.changePlayerStatus(this.checkFlag(MF.HELMET_FLW_CAMERA) ? S.DIVE : S.WAIT, 0, this.checkFlag(MF.HELMET_FLW_CAMERA)); this.holder = null; return true; }
                break;
            case T.BOSS_UNKB: case T.BOSS_UNKC: case T.BOSS_UNKD: case T.BOSS_UNKE:
                if (msg === MSG.BURN && !inv()) { this.fireDamage(sender, this.mDmgParamsFire); return true; }
                break;
            case T.BATHTUB_KILLER:
                if (!inv() && msg === MSG.ATTACK && (((this.mStatus - 0x800000) >>> 0) !== 0x8A9 || this.mStatusState !== 3)) {
                    this.dmg(sender, this.mDmgParamsBGTentacle);
                    this.changePlayerStatus(S.THROWN_DOWN, 0, false);
                    return true;
                }
            // fallthrough
            case T.BOSS_UNK14: case T.BOSS_UNK15:
                if (msg === MSG.ATTACK && !inv()) { this.dmg(sender, this.mDmgParamsHanachanBoss); return true; }
                break;
            case T.DOOR:
                // B (mInput 0x8000) facing the door (within 0x2000 of the way to it): from its front (its rot.y
                // within 0x2000 of his yaw) DOOR_OPEN_R, from behind (beyond 0x6000) DOOR_OPEN_L, which the
                // locked door (UNK12, not UNK11) only rattles (door_gacha_l, false) unless he holds something
                if (this.mInput & 0x8000) {
                    const prevYaw = this.mFaceAngle.y;
                    const toDoor = s16(this.getAttackAngle(sender) - prevYaw);
                    if (toDoor > -0x2000 && toDoor < 0x2000) {
                        const frontYaw = s16(s32f(fmul(65536, fmul(fr(1 / 360), sender.rot.y))));
                        const fd = s16(frontYaw - prevYaw);
                        const held = !!this.mHeldObject;
                        if (fd > -0x2000 && fd < 0x2000) {
                            this.pos.set(sender.pos); this.mFaceAngle.y = frontYaw;
                            this.changePlayerStatus(S.DOOR_OPEN_R, 0, false);
                            if (held) { this.mUpperState = UPPER.HOLDING_OBJECT; this.setAnimation(A.DOOR_KICK, 1); } else this.setAnimation(A.DOOR_OPENR, 1);
                            this.startVoice(SE.MV31_OPEN_DOOR_01);
                            return true;
                        }
                        if (fd < -0x6000 || fd > 0x6000) {
                            if (msg === MSG.UNK11) {
                                this.pos.set(sender.pos); this.mFaceAngle.y = s16(frontYaw + 0x8000);
                                this.changePlayerStatus(S.DOOR_OPEN_L, 0, false);
                                if (held) { this.mUpperState = UPPER.HOLDING_OBJECT; this.setAnimation(A.DOOR_KICK, 1); } else this.setAnimation(A.DOOR_OPENL, 1);
                                this.startVoice(SE.MV31_OPEN_DOOR_01);
                                return true;
                            }
                            if (!held) {
                                this.pos.set(sender.pos); this.mFaceAngle.y = s16(frontYaw + 0x8000);
                                this.changePlayerStatus(S.DOOR_OPEN_L, 0, false);
                                this.setAnimation(A.DOOR_GACHA_L, 1);
                                return false;
                            }
                        }
                    }
                }
                break;
            case T.E_MARIO: case T.MARIO:
                if (!inv()) {
                    if (msg === MSG.TAKE) { if (!this.mHeldObject && !this.holder) { this.holder = sender as TakeActor; this.changePlayerStatus(S.TAKEN, 0, false); return true; } }
                    else if (msg === MSG.PUT || msg === MSG.THROWN) {
                        this.holder = null; this.changePlayerStatus(S.JUMP, 0, false); this.setPlayerVelocity(40); this.mVel.y = 10; this.unk78 &= ~0x100; return true;
                    } else if (msg === MSG.ATTACK) { this.dmg(sender, this.mDmgParamsEnemyMario); return true; }
                }
                break;
            case T.MODEL_GATE:
                // the paint gate takes him (TModelGate: a jumping Mario in its box while charged): WARP_IN
                if (this.mStatus !== S.WARP_IN && msg === MSG.TAKE) {
                    this.holder = sender as TakeActor;
                    if (!this.checkStatusType(S.FLAG_JUMPING)) {
                        this.setAnimation(A.JUMP, 1);
                        const fc = this.getMotionFrameCtrl();
                        fc.frame = fr(fc.end | 0);
                    }
                    this.changePlayerDropping(S.WARP_IN, 0);
                    return true;
                }
                break;
            case T.LEAF_BOAT_ROTTEN: case T.LEAF_BOAT:
                if (msg === MSG.ATTACK) { this.keepDistance(sender.pos, fadd(sender.damageRadius, 30), 0); return true; }
                break;
            case T.FOOTBALL: case T.FRUIT_DURIAN:
                if (this.mFreezeImmunityTimer <= 0) { this.mFreezeTimer = this.mDeParams.mKickFreezeTime; this.calcDamagePos(sender.pos); return true; }
                break;
            default:
                if (PlayerMario.TENTACLE.has(t)) {
                    if (msg === MSG.TAKE) { if (!inv() && !this.mHeldObject && !this.holder) { this.holder = sender as TakeActor; this.changePlayerStatus(S.TAKEN, 0, false); return true; } }
                    else if (msg === MSG.ATTACK) { if (!inv()) { this.dmg(sender, this.mDmgParamsBGTentacle); return true; } }
                    else if (msg === MSG.DETACH) { this.changePlayerStatus(this.checkFlag(MF.HELMET_FLW_CAMERA) ? S.DIVE : S.WAIT, 0, this.checkFlag(MF.HELMET_FLW_CAMERA)); this.holder = null; return true; }
                } else if (PlayerMario.POLES.has(t)) {
                    if (msg === MSG.DETACH) { this.changePlayerStatus(S.WAIT, 0, false); this.mHeldObject = null; }
                }
                break;
        }
        return false;
    }

    // ---------------------------------------------------------------- MarioCheckCol.cpp
    hitNormal(a: HitActor) {
        if (this.checkStatusType(S.FLAG_JUMPING) && this.mVel.y < 0 && a.pos.y < this.pos.y) {
            if (this.mStatus === S.HIP_DROP) {
                if (a.receiveMessage(this, MSG.HIP_DROP) && a.isActorType(T.HINOKURI2)) { this.changePlayerTriJump(); this.unk78 &= ~0x100; }
                return;
            }
            if (this.trampleExec(a)) return;
        }
        if (this.checkFlag(MF.UNK200) && a.pos.y > this.pos.y) { a.receiveMessage(this, MSG.SUPER_HIP_DROP); return; }
        if (this.mStatus === S.CATCH || this.mStatus === S.OIL_SLIP || this.mStatus === S.JUMP_CATCH) {
            a.receiveMessage(this, MSG.PUNCH);
            a.receiveMessage(this, MSG.TRAMPLE);
        }
        const G = this.mWaterGun;
        if (G && G.mCurrentNozzle === NOZZLE.Spray && G.getEmittedWaterCount() !== 0 && this.world.water) {
            const wa = this.world.water.staticHitActor;
            wa.pos.set(this.pos); wa.pos.y = fadd(wa.pos.y, 80); wa.unk68 = 0;
            a.receiveMessage(wa, MSG.SPRAYED_BY_WATER);
        }
    }
    hitHipDrop(a: HitActor) { if (this.mStatus === S.HIP_DROP && this.mStatusState === 2 && a.pos.y < this.pos.y) a.receiveMessage(this, MSG.HIP_DROP); }
    hitPushup(a: HitActor) { if (this.checkStatusType(S.FLAG_JUMPING) && this.mVel.y > 0) a.receiveMessage(this, MSG.PUSH_UP); this.hitNormal(a); }
    keepDistanceA(a: HitActor) { this.keepDistance(a.pos, a.damageRadius, 0); }
    hitMario(a: HitActor) { if (this.mHeldObject !== a && this.holder !== a) this.keepDistanceA(a); this.wantToTakeActor(a); this.hitNormal(a); }
    hitNpc(a: HitActor) {
        const npc = a as any;
        if (!this.checkFlag(MF.HELMET_FLW_CAMERA) && !this.checkStatusType(MF.HELMET) && this.checkStatusType(S.FLAG_JUMPING) && this.mStatus !== S.HIP_DROP
            && this.mVel.y < 0 && a.pos.y < this.pos.y && (!npc.isBeTrampledNpc || npc.isBeTrampledNpc())) {
            if (this.trampleExec(a)) return;
        }
        this.keepDistanceA(a);
        if (a instanceof LiveActor && a.checkLiveFlag(LF.UNK100000)) this.wantToTakeActor(a);
    }
    wantToTakeActor(a: HitActor) { if (this.canTake(a)) { this.unk384 = a; this.changePlayerStatus(S.TAKE, 0, false); } }
    hitWantToTake(a: HitActor) { this.keepDistanceA(a); this.wantToTakeActor(a); }
    hitBarrel(a: HitActor) {
        this.hitWantToTake(a);
        if (this.checkStatusType(S.FLAG_JUMPING) && this.mVel.y < 0 && a.pos.y < this.pos.y && this.mStatus === S.HIP_DROP) {
            a.receiveMessage(this, MSG.HIP_DROP);
            if (this.checkFlag(MF.HAS_FLUDD) && this.mWaterGun) this.mWaterGun.mCurrentWater = this.mWaterGun.getMaxWater();
        }
    }
    hitJumpBase(a: HitActor) { this.keepDistanceA(a); if (((a as any).unk138 | 0) === 0) this.wantToTakeActor(a); }
    hitBrakable(a: HitActor) { if (this.checkStatusType(S.FLAG_JUMPING) && this.mVel.y < 0 && a.pos.y < this.pos.y && this.mStatus === S.HIP_DROP) a.receiveMessage(this, MSG.HIP_DROP); }
    hangPole(a: HitActor) {
        if (this.checkStatusType(S.FLAG_UNK100000)) return;
        const canHang = !this.mHeldObject && !this.onYoshi();
        let inHang = false;
        if (canHang) { const s = this.mStatus & 0x1FF; inHang = (s >= 0x80 && s <= 0x9F) || this.checkStatusType(S.FLAG_UNK200000); }
        if (inHang) {
            const dz = fsub(a.pos.z, this.pos.z), dx = fsub(a.pos.x, this.pos.x);
            let dist = sqrtf(fadd(fmul(dx, dx), fmul(dz, dz)));
            if (dist === 0) dist = 1;
            const c = fadd(fmul(JMASSin(this.mFaceAngle.y), fdiv(dx, dist)), fmul(JMASCos(this.mFaceAngle.y), fdiv(dz, dist)));
            const b = fadd(fadd(50, a.damageRadius), this.mBarParams.mCatchRadius);
            let can = true;
            if (this.mPrevStatus & S.FLAG_UNK100000) can = false;
            if (c < this.mBarParams.mCatchAngle) can = false;
            if (dist > b) can = false;
            if (this.pos.y < fadd(100, a.pos.y)) can = false;
            if (can) {
                this.dropObject();
                this.holder = a as TakeActor;
                this.mVel.y = 0; this.mForwardVel = 0;
                this.changePlayerStatus(S.BAR_HANG, 0, false);
                a.receiveMessage(this, MSG.ATTACH);
                this.mHolderHeightDiff = fsub(this.pos.y, a.pos.y);
                return;
            }
        }
        const r = (a as any).getRadiusAtY ? (a as any).getRadiusAtY(this.pos.y) : a.damageRadius;
        this.keepDistance(a.pos, r, 0);
    }
    hitPickUpEnemy(a: HitActor) {
        const e = a as any;
        if ((e.unk164 | 0) !== 0 && !this.checkStatusType(S.FLAG_JUMPING)) { this.hitWantToTake(a); return; }
        this.hitNormal(a);
        if (e.doKeepDistance && e.doKeepDistance()) this.keepDistanceA(a);
    }
    hitNoKeepPull(a: HitActor) {
        if (this.mStatus !== S.PULLING && this.mStatus !== S.PULL_JUMP && this.canTake(a) && a.receiveMessage(this, MSG.TAKE)) {
            this.changePlayerStatus(S.PULLING, 0, false);
            this.setAnimation(A.HOLD, 1);
            this.mHeldObject = a as TakeActor;
        } else this.hitNormal(a);
    }
    private static readonly COL_NORMAL = types('HINOKURI2', 'BOSS_EEL', 'BOSS_TELESA', 'BATHTUB_KILLER', 'ENEMY_UNK1', 'HAMU_KURI', 'NAME_KURI', 'PAKKUN', 'ELEC_NOKONOKO',
        'TELESA', 'POPO', 'HANE_HAMU_KURI', 'DANGO_HAMU_KURI', 'FIRE_HAMU_KURI', 'PUKU_PUKU', 'DORO_HAMU_KURI', 'IGAIGA', 'GOROGORO', 'HANA_SAMBO', 'SAMBO_HEAD',
        'DPT_CANNON', 'ENEMY_UNK1D', 'ENEMY_UNK1F', 'EFFECT_OBJ', 'HAUNT_LEG', 'KUKKU', 'BEE_HIVE', 'DORO_HANE_KURI', 'CASINORULET', 'ITEM_UNK8', 'ITEM_UNKA', 'ITEM_UNKC', 'CHUU_HANA');
    private static readonly COL_KEEP = types('BOSS_EEL_TOOTH', 'BOSS_EEL_COLLISION', 'DEBU_TELESA', 'SROT_RULET', 'BOSS_UNKB', 'BOSS_UNKC', 'BOSS_PAKKUN', 'BOSS_PAKKUN_ATTACK',
        'BOSS_UNK14', 'BOSS_UNK15', 'SAMBO_FLOWER', 'TABE_PUKU', 'E_MARIO', 'BOSS_GESSO', 'BOSS_GESSO_TAKE_HIT', 'BIANCO_GATE_KEEPER', 'EGG_YOSHI', 'MAP_OBJECT_UNK10',
        'ARROW_BOARD_LR', 'GENERAL_HIT_OBJ', 'MAP_OBJECT_UNK30', 'PLANT_FLOWER', 'DRUM_CAN', 'DPT_WEATHERCOCK', 'BIA_BELL', 'BIA_WATERMILL00', 'MINI_WINDMILL_L',
        'WATERMELON_STATIC', 'MERRY_POLE', 'COASTER', 'COGWHEEL_POT', 'EX_BOTTLE', 'MAP_OBJ_NAIL', 'FRUIT_COVER_PINE');
    private static readonly COL_NORMAL_KEEP = types('GESSO', 'FIRE_WANWAN', 'POI_HANA', 'YUMBO', 'AMENBO');
    private static readonly COL_PULL = types('BOSS_GESSO_TENTACLE', 'BOSS_UNK8', 'BOSS_UNKD', 'YOSHI_TONGUE', 'FIRE_WANWAN_TAIL_HIT');
    private static readonly COL_POLE = types('DPTLIGHT', 'TELEGRAPH_POLE_L', 'POLE_NORMAL', 'MAP_OBJECT_UNK32', 'PALM_NORMAL', 'PALM_OUGI', 'PALM_SAGO', 'PALM_NATUME',
        'BANANA_TREE', 'FRUIT_TREE', 'MOYASI', 'MAP_OBJECT_UNK47', 'FLUFF', 'ELASTIC_CODE', 'MONTE_ROOT', 'MONTE_GOAL_FLAG');
    private static readonly COL_TAKE = types('FRUIT_COCONUT', 'FRUIT_PAPAYA', 'FRUIT_PINE', 'FRUIT_BANANA', 'RED_PEPPER');
    checkCollision() {
        if (this.checkStatusType(S.FLAG_UNK1000)) return;
        // a free Yoshi (STATE_UNMOUNTED / hatching): landed on from above (within 180) he's ridden, else kept 80 away
        const Y = this.mYoshi;
        if (Y && (Y.mState === 6 || Y.mState === 2)) {
            const yt = Y.getTranslation();
            if (yt.y <= this.pos.y && this.pos.y < fadd(100, yt.y)) {
                const dz = fsub(yt.z, this.pos.z), dx = fsub(yt.x, this.pos.x);
                const dist = sqrtf(fadd(fmul(dx, dx), fmul(dz, dz)));
                if (this.checkStatusType(S.FLAG_JUMPING) && !this.mHeldObject && this.mVel.y < 0 && yt.y < this.pos.y && this.mStatus !== 0x89C
                    && this.mStatus !== S.THROWN_DOWN && this.mStatus !== S.BACK_JUMP && dist < 180) {
                    this.pos.set(Y.getTranslation());
                    this.mFaceAngle.y = Y.mEggRotSpeed;
                    this.mModelFaceAngle = this.mFaceAngle.y;
                    const G = this.mWaterGun;
                    if (this.checkFlag(MF.HAS_FLUDD) && G) {
                        this.unk3E8 = G.mSecondNozzle;
                        this.unk3EC = fr(G.mCurrentWater / G.getCurrentNozzle().P.mAmountMax);
                    }
                    Y.ride();
                    this.onFlag(MF.HAS_FLUDD);
                    if (this.checkFlag(MF.HAS_FLUDD) && G) G.changeNozzle(NOZZLE.Yoshi, true);
                    this.changePlayerStatus(S.WAIT, 0, false);
                    this.event('yoshiRide', {});
                    return;
                }
                this.keepDistance(yt, 80, 0);
            }
        }
        const P = PlayerMario;
        for (const a of this.collisions.slice()) {
            if (a.isHitCategory(HC.NPC)) { this.hitNpc(a); continue; }
            const t = a.actorType;
            const keepIf = () => { const e = a as any; if (e.doKeepDistance && e.doKeepDistance()) this.keepDistanceA(a); };
            if (t === AT.MARIO) { this.hitMario(a); this.keepDistanceA(a); }
            else if (P.COL_NORMAL.has(t)) this.hitNormal(a);
            else if (t === T.BOSS_PAKKUN_HEAD) this.hitHipDrop(a);
            else if (t === T.KUMOKUN || t === T.AMI_NOKO || t === T.AMIKING) {
                if (t === T.KUMOKUN) { this.hitNormal(a); keepIf(); }
                if (t !== T.AMIKING) this.hitHipDrop(a);
                const f = this.getMotionFrameCtrl().frame;
                if (this.mStatus === S.FENCE_PUNCH && 5 <= f && f < 9) a.receiveMessage(this, MSG.PUNCH);
                if (this.mStatus === S.KICK_ROOF && 9 <= f && f < 13) a.receiveMessage(this, MSG.PUNCH);
            }
            else if (t === T.TAMA_NOKO || t === T.BOMB_HEI) this.hitPickUpEnemy(a);
            else if (t === T.MAME_GESSO) { const e = a as any; if (e.doKeepDistance && e.doKeepDistance()) this.keepDistanceA(a); else this.hitPickUpEnemy(a); }
            else if (P.COL_KEEP.has(t)) this.keepDistanceA(a);
            else if (P.COL_NORMAL_KEEP.has(t)) { this.hitNormal(a); keepIf(); }
            else if (P.COL_PULL.has(t)) this.hitNoKeepPull(a);
            else if (t === T.NOZZLE_BOX) { this.hitNormal(a); this.keepDistanceA(a); }
            else if (t === T.FOOTBALL || t === T.FRUIT_DURIAN) this.hitPushup(a);
            else if (t === T.MAP_OBJECT_UNK2 || t === T.BREAKABLE_BLOCK) this.hitBrakable(a);
            else if (t === T.WOOD_BARREL || t === T.BARREL_OIL) this.hitBarrel(a);
            else if (P.COL_POLE.has(t)) this.hangPole(a);
            else if (t === T.JUMPBASE) this.hitJumpBase(a);
            else if (P.COL_TAKE.has(t)) this.hitWantToTake(a);
        }
    }

    // ---------------------------------------------------------------- MarioAutodemo.cpp: the stage's start
    startCommon(warp: V3 | null, rot: number) {
        this.offUnk114(2);
        if (warp) { this.warpRequest(warp, rot); this.mFaceAngle.x = 0; this.mFaceAngle.y = s16f(fr(fr(rot * fr(1 / 360)) * 65536)); this.mFaceAngle.z = 0; }
        const [h, g] = this.checkGroundPlane(this.pos.x, fadd(this.pos.y, 25), this.pos.z);
        this.mFloorPosition.y = h; this.mGroundPlane = g;
        this.unk2BC = this.mFloorPosition.y;
        this.setAnimation(A.WAIT, 1);
    }
    /**
     * TMario::isUnUsualStageStart (0x8011fbxx): the diving maps (SMS_isDivingMap: 0x39, 0x2C, 0x10) start
     * him in the helmet, diving (DIVE) with the underwater nozzle.
     * The Pinna coaster (map 0x3A stages 0 / 1): toroccoStart.
     */
    isUnUsualStageStart() {
        const map = (this.world as any).map, stage = (this.world as any).stage;
        if (map === 0x3A && (stage === 0 || stage === 1)) return this.toroccoStart();
        if (map === 0x39 || map === 0x2C || map === 0x10) {
            this.onUnk114(2);
            this.onFlag(MF.HELMET_FLW_CAMERA); this.onFlag(MF.HELMET); this.onFlag(MF.HAS_FLUDD);
            const G = this.mWaterGun;
            if (this.checkFlag(MF.HAS_FLUDD) && G) G.changeNozzle(NOZZLE.Underwater, true);
            if (this.checkFlag(MF.HAS_FLUDD) && G) G.changeNozzle(G.mSecondNozzle, true);
            this.mCapModel |= 2;
            this.changePlayerStatus(S.DIVE, 0, true);
            return true;
        }
        return false;
    }
    rollingStart(warp: V3 | null, rot: number) {
        if (this.isUnUsualStageStart()) return true;
        if (this.mStatus === S.DISAPPEAR) { this.startCommon(warp, rot); this.changePlayerStatus(S.WARP_OUT, 0x200, true); return true; }
        return false;
    }
    returnStart(warp: V3 | null, rot: number, got: boolean, kind: number) {
        if (this.mStatus === S.DISAPPEAR) {
            const k = kind << 8;
            if (got) { this.startCommon(warp, rot); this.changePlayerStatus(S.WARP_OUT, k | 2, true); }
            else { this.startCommon(warp, fadd(rot, 180)); this.changePlayerStatus(S.WARP_OUT, k | 1, true); }
            return true;
        }
        return false;
    }
    waitingStart(warp: V3 | null, rot: number) {
        if (this.isUnUsualStageStart()) return true;
        this.startCommon(warp, rot);
        this.onUnk114(2);
        this.changePlayerStatus(S.WAIT, 0, true);
        return true;
    }
    /**
     * (the viewer's, not the game's: live play from the sleeping Mario) waitingStart, but already asleep:
     * on the floor below his start, in TMario::sleeping's last state (sleep_wait looped at the given
     * phase), so the pad wakes him (wakeup: sleep_end) the way the game does.
     */
    sleepingStart(phase: number) {
        this.startCommon(null, 0);
        if (this.mGroundPlane && this.mFloorPosition.y > -1e8 && this.mFloorPosition.y <= this.pos.y + 25) this.pos.y = this.mFloorPosition.y;
        this.mVel.set(0, 0, 0); this.mForwardVel = 0;
        this.onUnk114(2);
        this.changePlayerStatus(S.SLEEP, 0, true);
        this.mStatusState = 2;
        this.setAnimation(A.SLEEP_WAIT, 1);
        const fc = this.mModel.fc[0];
        fc.frame = fr(Math.max(0, Math.min(0.9999, phase)) * fc.end);
        return true;
    }
    warpOut() {
        this.mStatusTimer += 1;
        this.onUnk114(2);
        switch (this.mStatusState) {
            case 0:
                this.setAnimation((this.mStatusArg & 0xFF) === 2 ? A.DEMO_GATE_OUT_APPEAR_GET : A.DEMO_GATE_OUT_APPEAR, 1);
                this.mStatusState = 1; this.mStatusTimer = 0;
                break;
            case 1: {
                const delay = (this.mStatusArg & 0x200) ? 0x70 : 0xb4;
                if (this.mStatusTimer >= delay) {
                    if (this.checkFlag(MF.HELMET_FLW_CAMERA)) { this.onUnk114(2); return this.changePlayerStatus(S.DIVE, 0, true); }
                    this.mStatusState = 2;
                }
                break;
            }
            case 2:
                this.setAnimation((this.mStatusArg & 0xFF) === 2 ? A.DEMO_GATE_OUT_ROLLING_GET : A.DEMO_GATE_OUT_ROLLING, 1);
                if (this.jumpProcess(0) === 1) this.mStatusState = 3;
                break;
            case 3:
                switch (this.mStatusArg & 0xFF) {
                    case 0: return this.changePlayerStatus(S.JUMP_END, 0, true);
                    case 1: this.setAnimation(A.DEMO_GATE_OUT, 1); if (this.isLast1AnimeFrame()) return this.changePlayerStatus(S.WAIT, 0, true); break;
                    case 2: this.setAnimation(A.DEMO_GATE_OUT_GET2, 1); if (this.isLast1AnimeFrame()) return this.changePlayerStatus(S.WAIT, 0, true); break;
                }
                break;
        }
        return 0;
    }
    /**
     * TMario::warpIn (0x8011fd5c): taken by a paint gate (mHolder, a TModelGate). The first tick: off
     * Yoshi, the stage change (setNextStage: 2 Bianco, 3 Ricco, 4 Gelato by the gate's unk71, others 2);
     * then drawn, frozen in his pose, drawn 2% of the way a tick to 80 below the gate's mouth (unkAC)
     * for 120 ticks; then the balls (hidden after mWarpInBallsDispTime), captured (mWarpInCapturedTime:
     * the gate gets ATTACK) and done (MARIO_FLAG_IS_PERFORMING: his perform stops).
     * (Not here: mWarpInDir and the light, the tremble (TTrembleModelEffect::clash), effects, rumble.)
     */
    warpIn() {
        this.mStatusTimer = (this.mStatusTimer + 1) & 0xFFFF;
        const gate = this.holder as any;
        if (!gate) return 0;
        const tgt = gate.unkAC as V3;
        const hx = tgt.x, hy = fsub(tgt.y, 80), hz = tgt.z;
        const D = this.mAutoDemoParams;
        switch (this.mStatusState) {
            case 0: {
                if (this.mStatusTimer <= 1) {
                    if (this.onYoshi()) this.getOffYoshi(true);
                    const dest = gate.unk71 | 0;
                    const next = dest === 1 ? 3 : dest === 2 ? 4 : 2;
                    this.world.setNextStage?.(next, gate);
                }
                this.onUnk114(2);
                this.getMotionFrameCtrl().rate = 0;
                const dx = fsub(hx, this.pos.x), dy = fsub(hy, this.pos.y), dz = fsub(hz, this.pos.z);
                this.pos.set(fadd(fmul(dx, fr(0.02)), this.pos.x), fadd(fmul(dy, fr(0.02)), this.pos.y), fadd(fmul(dz, fr(0.02)), this.pos.z));
                if (this.mStatusTimer > 0x78) {
                    this.mStatusTimer = 0;
                    this.unk468 = 0;
                    this.mStatusState = 1;
                    // (startVoice(-2), the warpInEffect)
                }
                break;
            }
            case 1:
                if (this.mStatusTimer > D.mWarpInBallsDispTime) this.offUnk114(2);
                if (this.mStatusTimer > D.mWarpInBallsTime) { this.mStatusTimer = 0; this.unk468 = D.mWarpInVecBase; this.mStatusState = 2; }
                break;
            case 2:
                this.offUnk114(2);
                if (this.mStatusTimer > D.mWarpInCapturedTime) {
                    this.offUnk114(2);
                    this.mStatusTimer = 0;
                    gate.receiveMessage(this, MSG.ATTACK);
                    this.mStatusState = 3;
                }
                break;
            case 3:
                this.onFlag(MF.IS_PERFORMING);
                break;
        }
        return 0;
    }
    winDemo() {
        switch (this.mStatusState) {
            case 0:
                if (this.mHeldObject) { (this.mHeldObject as HitActor).receiveMessage(this.mHeldObject, MSG.UNKD); this.mHeldObject = null; }
                if (this.jumpProcess(0) === 1) { if (this.world.talk) this.world.talk.fireGetStar(this.unk384); if (this.unk384) this.unk384.receiveMessage(this, MSG.TAKE); this.mStatusState = 1; }
                break;
            case 1: this.setAnimation(A.DEMO_SHINE_GET, 1); this.stopProcess(); break;
        }
        return 0;
    }
    downLoser() { this.setPlayerVelocity(0); this.setAnimation(A.LAND, 1); if (this.jumpProcess(0) === 1) this.changePlayerStatus(S.LOSER_DOWN, 0, true); return 0; }
    elecDowning() { this.setAnimation(A.SHOCK_DOWN, 1); return 0; }
    electricDamage() {
        if (this.mStatusState === 0) { this.startVoice(SE.MV04_DAMAGE_ELEC_01); this.setAnimation(A.SHOCK, 1); this.decHP(this.mDmgParamsGraffitoElec.mDamage); this.mStatusState = 1; }
        this.mStatusTimer += 1;
        if (this.mStatusTimer > 0x78) {
            this.getMotionFrameCtrl().frame = 0;
            this.mStatusTimer += 1;
            this.startVoice(SE.MV07_DAMAGE_REACT_01);
            this.mFloorHitActor.pos.x = fadd(this.pos.x, JMASSin(this.mFaceAngle.y));
            this.mFloorHitActor.pos.z = fadd(this.pos.z, JMASCos(this.mFaceAngle.y));
            const E = this.mDmgParamsGraffitoElec;
            this.damageExec(this.mFloorHitActor, 0, 3, E.mWaterEmit, E.mMinSpeed, E.mMotor, 0, 0x3C);
            return this.changePlayerStatus(S.WAIT, 0, true);
        }
        return 0;
    }
    /** TMario::readBillboard (MarioAutodemo.cpp): step back from the talking NPC, turn to it, then wait out the talk */
    readBillboard() {
        const T = this.world.talk;
        const npc: any = T ? T.unkA0 : null;
        switch (this.mStatusState) {
            case 0: {
                if (npc) {
                    let dx = fsub(this.pos.x, npc.pos.x);
                    const dz = fsub(this.pos.z, npc.pos.z);
                    if (dx === 0 && dz === 0) dx = fadd(dx, 1);
                    const dist = sqrtf(fmadd(dx, dx, fmul(dz, dz)));
                    if (dist < 100) {
                        const p = new V3(fmadd(2, fmul(50, fdiv(dx, dist)), npc.pos.x), this.mFloorPosition.y, fmadd(2, fmul(50, fdiv(dz, dist)), npc.pos.z));
                        this.moveRequest(p);
                    }
                }
                this.setAnimation(A.T_WAIT, 1);
                this.mStatusState = 1;
            }
            // fallthrough
            case 1: {
                if (!npc) break;
                const a = s16(this.getAttackAngle(npc));
                const sp = this.mAutoDemoParams.mReadRotSp;
                this.mFaceAngle.y = s16(a - IConverge(s16(a - this.mFaceAngle.y), 0, sp, sp));
                if (a === this.mFaceAngle.y) { if (T) T.unk126 = 2; this.mStatusState = 2; }
                break;
            }
            case 2:
                if (!T || T.unk124 === 0 || T.unk124 === 5) this.changePlayerStatus(S.WAIT, 0, true);
                break;
        }
        this.mFaceAngle.x = 0;
        this.mModelFaceAngle = this.mFaceAngle.y;
        return 0;
    }
    demoMain() {
        switch (this.mStatus) {
            case S.WIN_DEMO: return this.winDemo();
            case S.ELEC_DOWN: return this.elecDowning();
            case S.DOWN_LOSER: return this.downLoser();
            case S.WARP_OUT: return this.warpOut();
            case S.WARP_IN: return this.warpIn();
            case S.ELECTRIC_DAMAGE: return this.electricDamage();
            case S.READ_BILLBOARD: return this.readBillboard();
        }
        return super.demoMain();
    }

    // ---------------------------------------------------------------- the tick
    thinkFreeze() {
        if (this.mFreezeTimer > 0) { this.mFreezeTimer -= 1; if (this.mFreezeTimer <= 0) this.mFreezeImmunityTimer = this.mDeParams.mNoFreezeTime; }
        if (this.mFreezeImmunityTimer > 0) this.mFreezeImmunityTimer -= 1;
    }
    /** TMario::playerControl */
    playerControl() {
        this.unk9C = this.mFaceAngle.y;
        this.mPrevPosition.set(this.pos);
        this.offUnk114(8);
        // the director's talk start (unk124 1): Mario turns to the NPC (readBillboard)
        const T = this.world.talk;
        if (T && T.unk124 === 1 && this.mStatus !== S.READ_BILLBOARD) this.changePlayerStatus(S.READ_BILLBOARD, 0, false);
        if (this.camera.isLButtonCamera && this.camera.isLButtonCamera() && !(T && T.unk124 === 1)) {
            const s = this.mStatus & 0x1FF;
            if (!(s >= (S.HANGING & 0x1FF) && (S.HANG_JUMPING & 0x1FF) >= s)) {
                this.mFaceAngle.y = s16(this.cameraYaw() + 0x8000 - (this.camera.offsetAngleY ? this.camera.offsetAngleY() : 0));
            }
        }
        this.checkPlayerAction();
        this.checkCollision();
        this.considerTake();
        this.checkYoshiGetOff();
        this.thinkYoshiHeadCollision();
        this.thinkTorocco();
        this.stateMachine();
        this.stateMachineUpper();
        this.thinkSituation();
        this.thinkWaterSurface();
        this.thinkSand();
        this.thinkHeight();
        this.thinkParams();
        this.checkRideReCalc();
        this.checkWet();
        this.checkGraffito();
        this.thinkDirty();
        this.checkSink();
        this.gunExec();
        this.thinkSound();
    }
    /** TMario::perform (the movement and its calc anim, every tick) */
    perform(cue: number) {
        if (this.checkFlag(MF.IS_PERFORMING)) return;
        if (!(cue & CUE_MOVE)) return;
        const wasIn = this.checkFlag(MF.IN_ANY_WATER);
        this.thinkFreeze();
        if (this.mFreezeTimer <= 0) {
            this.playerControl();
            this.setPositions();
            if (this.mWaterGun) this.mWaterGun.perform(CUE_MOVE);
            if (this.mYoshi) this.mYoshi.movement();
        }
        if (this.mFreezeTimer <= 0) {
            this.calcAnim();
            if (this.mYoshi) this.mYoshi.marioCalcAnim(this.unk414.z);
            const G = this.mWaterGun;
            if (G) { if (G.calcAnimFromMario) G.calcAnimFromMario(); }
            if (this.mYoshi) this.mYoshi.calcAnim();
        }
        // CUE_ENTRY (the frame's draw): mYoshi->entry() when he's drawn (VISIBLE, not MARIO_FLAG_UNK4), else unless ridden
        if (this.mYoshi && ((this.checkUnk114(2) && !this.checkFlag(0x4)) || !this.onYoshi())) this.mYoshi.entry();
        this.justEnteredWater = !wasIn && this.checkFlag(MF.IN_ANY_WATER);
        this.present = this.checkUnk114(2);
        // the HUD's view of him: health and air when they change (World.playerLog)
        const w = this.world as any, L: { t: number; health: number; air: number; underWater: boolean }[] = w.playerLog || (w.playerLog = []);
        const uw = this.isUnderWater(), last = L.length ? L[L.length - 1] : null;
        if (!last || last.health !== this.mHealth || Math.trunc(last.air) !== Math.trunc(this.mAir) || last.underWater !== uw)
            L.push({ t: this.world.tickCount, health: this.mHealth, air: this.mAir, underWater: uw });
        if (this.track) this.checkDrift();
    }

    // ---------------------------------------------------------------- the pad (TMarDirector::direct, TApplication::gameLoop)
    /** a frame's PADStatus: JUTGamePad::read, then updateMeaning (gameLoop) */
    padRead(p: PadStatus | null) { this.mGamePad.read(p); this.mGamePad.updateMeaning(); }
    /** the other three ticks of a frame: resetButtons, updateMeaning */
    padTick() { this.mGamePad.resetButtons(); this.mGamePad.updateMeaning(); }
    /** the camera group after the player group: CPolarSubCamera::perform (tick: 1 the frame's first, 2 its last) */
    cameraTick(tick: number) { const C = this.simCamera as any; if (C && C.update) C.update(this, this.mGamePad, tick); }

    // ---------------------------------------------------------------- drift against the ghost
    /** the stage tick drift checks start after (the end of the opening demo) */
    driftFrom = 0;
    drift = { firstQf: -1, firstErr: 0, maxErr: 0, frames: 0, synced: 0, warned: false, corrections: 0 };
    /** put the input replay back on the ghost when it drifts (checkDrift) */
    static correctDrift = true;
    /** following the ghost (checkDrift's snap back), and the animation it shows meanwhile */
    following = false;
    followAnim: { anim: number; phase: number } | null = null;
    /** the ghost's sample at the end of each frame: how far the sim is from it */
    checkDrift() {
        const q = this.world.tickCount;
        if (q & 3) return;
        // (before setMario the ghost has no samples of its own: its first one is copied back to the segment's start)
        if (q <= this.driftFrom) return;
        const s = this.track!.at(q);
        if (!s) return;
        if (this.track!.closingCopyQf !== undefined && q >= this.track!.closingCopyQf) return;
        const d = this.drift;
        const e = Math.hypot(this.pos.x - s.x, this.pos.y - s.y, this.pos.z - s.z);
        d.frames++;
        // the ghost keeps 1/8 units, truncated: in sync while the sim's truncates to the same
        const same = Math.trunc(this.pos.x * 8) === Math.round(s.x * 8) && Math.trunc(this.pos.y * 8) === Math.round(s.y * 8) && Math.trunc(this.pos.z * 8) === Math.round(s.z * 8);
        if (same && d.firstQf < 0) d.synced++;
        if (e > d.maxErr) d.maxErr = e;
        if (d.firstQf < 0 && e > 1) {
            d.firstQf = q; d.firstErr = e;
            if (!d.warned) { d.warned = true; console.warn(`[player] input replay drifted from the ghost at stage QF ${q} (${(q / 120).toFixed(2)} s) by ${e.toFixed(2)} units`); }
        }
        // (a fit, not the game's: the input replay put back on the ghost.) More than a unit off, Mario
        // follows the ghost's own place, facing and animation; the next frame the ghost stands on the
        // floor (right on the ground under him, not rising or falling, not on Yoshi) the inputs take
        // him again from there, standing or running at the ghost's speed. Each takeover is counted in
        // drift.corrections.
        if (PlayerMario.correctDrift) {
            if (!this.following && e > 1) { this.following = true; d.corrections++; }
            if (this.following) {
                const p = this.track!.at(q - 4);
                this.pos.set(s.x, s.y, s.z);
                this.mFaceAngle.y = s.yaw; this.mModelFaceAngle = s.yaw;
                this.followAnim = { anim: s.anim, phase: s.phase };
                const [gy] = this.world.checkGround(s.x, s.y + 50, s.z);
                // (only from the ghost walking, running or standing: those are the statuses taken up here)
                const moving = s.anim === A.WALK || s.anim === A.RUN2 || s.anim === A.RUN1, standing = s.anim === A.WAIT;
                if (p && (moving || standing) && !s.yoshi && !p.yoshi && Math.abs(s.y - gy) < 1 && Math.abs(s.y - p.y) < 0.5) {
                    // the speed at the frame's end: he moves fv / 4 each of a frame's four ticks, his speed
                    // rising each tick, so a frame's step is 3/8 of a frame's speed-up behind it
                    const h = Math.hypot(s.x - p.x, s.z - p.z), p2 = this.track!.at(q - 8);
                    const h0 = p2 ? Math.hypot(p.x - p2.x, p.z - p2.z) : h;
                    this.mVel.set(0, 0, 0);
                    this.mForwardVel = h + 0.375 * (h - h0);
                    if (standing) this.mForwardVel = 0;
                    this.changePlayerStatus(moving ? S.RUN : S.WAIT, 0, true);
                    this.pos.set(s.x, s.y, s.z);
                    this.following = false; this.followAnim = null;
                }
            }
        }
    }

    // ---------------------------------------------------------------- what the rest of the stage asks (MarioProxy's interface)
    get vel() { return this.mVel; }
    get faceAngle() { return this.mFaceAngle.y; }
    get groundPlane() { return this.mGroundPlane; }
    get groundHeight() { return this.mFloorPosition.y; }
    isJumping() { return this.checkStatusType(S.FLAG_JUMPING); }
    get hipDrop() { return this.mStatus === S.HIP_DROP; }
    get diving() { return this.mStatus === S.JUMP_CATCH || this.mStatus === S.DIVE; }
    get marioFlags() { return this.mFlag; }
    get anim() { return this.mAnimationId; }
    /**
     * the motion's place in its BCK, 0..1 (the ghost's phase: x 4096, rounded). A once-mode BCK held
     * at its end sits at end - 0.001 (J3DFrameCtrl::update), which x 4096 rounds to 4096 and would
     * wrap to the first frame (a roll jump or the hip drop's turn stuck at their end drawn from
     * their start): capped at the last step.
     */
    get phase() { const f = this.getMotionFrameCtrl(); return f.end > 0 ? Math.min(f.frame / f.end, 4095 / 4096) : 0; }
    /**
     * the upper body's own motion as the model draws it (M3UModelMario unk24[1]: on while unk3 isn't
     * 0xff, the chest down on its BCK at fc[1]'s frame): the pump, a held object's, the run's damage
     * flinch (setUpperDamageRun). null: the body's BCK alone.
     */
    get upperAnim(): { bck: number; frame: number } | null {
        const M = this.mModel;
        return M.upperCalc !== -1 && M.anm[1] >= 0 && !this.onYoshi() ? { bck: M.anm[1], frame: M.fc[1].frame } : null;
    }
    /**
     * where the model is drawn: mPosition, but on a pole or tree (calcBaseMtxPole) the base TR's
     * translation, the holder's getRadiusAtY out from its axis toward him (mPosition stays on the axis).
     */
    get drawPos(): V3 {
        if (this.checkStatusType(S.FLAG_UNK100000) && this.mStatus !== S.TOROCCO) {
            const b = this.mModel.baseTR;
            return new V3(b[3], b[7], b[11]);
        }
        return this.pos;
    }
    get emitted() { return !!this.mWaterGun && this.mWaterGun.getEmittedWaterCount() > 0; }
    /** FLUDD as the ghost records it (for the viewer and the actors that read the proxy's) */
    get fludd(): MarioSample['fludd'] {
        const G = this.mWaterGun;
        if (!G || !this.checkFlag(MF.HAS_FLUDD)) return null;
        return { spraying: G.isEmitting(), nozzle: G.mCurrentNozzle, power: 0, offset: [0, 0, 0], yaw: (this.mFaceAngle.y * Math.PI * 2) / 65536, pitch: 0 };
    }
    getGroundPlane() { return this.mGroundPlane; }
    asLive(): LiveActor | null { return null; }
    /** health (TMario::mHealth) and air (mAir), as the HUD shows them */
    get health() { return this.mHealth; }
    get air() { return this.mAir; }
    update(_qf: number) { }

    private event(kind: string, data: any = {}) { this.world.events.push({ t: this.world.tickCount, kind: 'mario:' + kind, data: { ...data, pos: this.pos.clone() } }); }
}

// ---------------------------------------------------------------- TMarDirector: the stage's opening
/** TMarDirector's states (STATE_UNK0 ... STATE_UNK4: the game) */
export const DIR = { BOOT: 0, DEMO: 1, UNK2: 2, WIPE_OPEN: 3, GAME: 4, GAME_OVER: 7, MOVE_STAGE: 9 };
/** stages whose opening is always the camera demo (changeState STATE_UNK0) */
const DEMO_STAGES = new Set([2, 3, 4, 5, 6, 8, 9, 0x34]);
/** TConsoleStr: the open wipe's ticks (startOpenWipe to unk2BC 6) */
export const OPEN_WIPE_TICKS = 31;

export interface IntroTiming {
    /** the changeState (after this stage tick) that ends the camera demo (STATE_UNK1 to STATE_UNK3): the ghost's */
    demoEndTick: number;
    /** the ghost's first sample after the opening (its drift is checked from there) */
    firstSample?: number;
    /** a secret stage's Shine was got before the run (the ghost saw FLUDD on Mario): its red coin switch is there and he keeps FLUDD */
    exShineGot?: boolean;
    /** live play from the viewer's sleeping Mario: setMario lays him down asleep (sleepingStart) at this
     * phase (0..1) of sleep_wait instead of the stage's start; null: the stage's own start */
    sleepPhase?: number | null;
    /** setMario's start in place of the stage's own (stagechange.ts: the entrance decideMarioPosIdx picks) */
    start?: (m: PlayerMario) => void;
    /** Delfino Plaza opens with its camera demo (DEMO_FLAG_CAMERA_DEMO_ON_START), ending at demoEndTick */
    plazaDemo?: boolean;
}

/**
 * TMarDirector::changeState and nextStateInitialize as far as Mario is concerned: when setMario
 * puts him on the stage, and when the pad's GAME_INPUT goes on (STATE_UNK4). Called after every
 * movement tick (direct calls it after each of a frame's ticks but the last, and that one at the
 * start of the next frame, after the pad is read: the same order here).
 */
export class PlayerDirector {
    state = DIR.BOOT;
    setMarioDone = false;
    wipeDoneTick = -1;
    /** the stage tick the pad got GAME_INPUT (Mario's control) */
    gameTick = -1;
    constructor(public mario: PlayerMario, public map: number, public hasStartCamera: boolean, public timing: IntroTiming) { }
    /** setMario: decideMarioPosIdx's start (unkD1): 1 the rolling start (the main stages), else waiting */
    setMario() {
        if (this.setMarioDone) return;
        this.setMarioDone = true;
        const m = this.mario;
        if (this.timing.start) this.timing.start(m);   // (stagechange.ts: decideMarioPosIdx's entrance)
        else if (this.timing.sleepPhase != null) m.sleepingStart(this.timing.sleepPhase);
        else if (DEMO_STAGES.has(this.map)) m.rollingStart(null, 0);
        else m.waitingStart(null, 0);
        if (m.checkFlag(MF.HAS_FLUDD) && m.mWaterGun) {
            switch (this.map) {
                case 1: case 2: case 3: case 4: case 5: case 6: case 8: case 9: case 0x10: case 0x2C: case 0x34: case 0x39: break;
                case 0x3C: m.mWaterGun.changeNozzle(NOZZLE.Rocket, true); break;
                default: m.mWaterGun.changeNozzle(NOZZLE.Spray, true); break;
            }
        }
        if (shineIDofExStage(this.map) !== 0xFF && !m.world.exShineGot) m.offFlag(MF.HAS_FLUDD);
    }
    private enter(next: number, tick: number) {
        const prev = this.state;
        // currentStateFinalize
        if (prev === DIR.DEMO) {
            this.mario.mGamePad.offFlag(PAD_FLAG.MENU_INPUT);
            // gpCamera->endDemoCamera (endReproduceDemoCamera_: onNeutralMarioKey, the stick eased in; the
            // simulated camera does it itself), the open wipe
            if (!this.mario.simCamera) this.mario.mGamePad.onNeutralMarioKey();
            this.wipeDoneTick = tick + OPEN_WIPE_TICKS;
        }
        // STATE_UNK4's finalize: the stopwatch stops (in mode 0) and the pad loses GAME_INPUT
        if (prev === DIR.GAME) {
            const T = this.mario.world.talk;
            if (T && T.unk124 === 0) T.stopwatchOn = false;
            this.mario.mGamePad.offFlag(PAD_FLAG.GAME_INPUT);
        }
        this.state = next;
        const C = this.mario.simCamera as any;
        if (C && C.setDirectorState) C.setDirectorState(next);
        // nextStateInitialize
        switch (next) {
            case DIR.DEMO: this.mario.mGamePad.onFlag(PAD_FLAG.MENU_INPUT); break;
            case DIR.WIPE_OPEN: case DIR.UNK2: this.setMario(); break;
            case DIR.GAME: this.setMario(); this.mario.mGamePad.onFlag(PAD_FLAG.GAME_INPUT); this.gameTick = tick; break;
        }
    }
    changeState(tick: number) {
        const m = this.mario;
        switch (this.state) {
            case DIR.BOOT:
                if (this.map === 0xF) this.enter(DIR.GAME, tick);
                else if (DEMO_STAGES.has(this.map)) this.enter(DIR.DEMO, tick);
                else if (this.map === 1) this.enter(this.timing.plazaDemo ? DIR.DEMO : DIR.UNK2, tick);
                else this.enter(this.hasStartCamera ? DIR.DEMO : DIR.GAME, tick);
                break;
            case DIR.DEMO:
                if (tick >= this.timing.demoEndTick) this.enter(DIR.WIPE_OPEN, tick);
                break;
            case DIR.WIPE_OPEN:
                if (this.map === 1) { if (tick >= this.wipeDoneTick) this.enter(DIR.UNK2, tick); }
                else if (tick >= this.wipeDoneTick && !m.checkStatusType(S.FLAG_UNK1000)) this.enter(DIR.GAME, tick);
                break;
            case DIR.UNK2:
                if (!m.checkStatusType(S.FLAG_UNK1000)) this.enter(DIR.GAME, tick);
                break;
            // STATE_UNK4: updateGameMode (its talk part: talk.ts)
            case DIR.GAME:
                if (m.world.talk) {
                    m.world.talk.updateGameMode();
                    // the states it asks for that are simulated: the stage change's fade (STATE_UNK9), the game over (STATE_UNK7)
                    const n = m.world.talk.nextState;
                    if (n === DIR.MOVE_STAGE || n === DIR.GAME_OVER) this.enter(n, tick);
                }
                break;
        }
    }
}

/**
 * The tick the camera demo ended, from a ghost: its first samples after the opening (Mario's
 * rolling start: the APPEAR animation's frame, 0.5 a tick from the tick after setMario), else
 * six ticks before the first of them (as the rolling-start ghosts have it).
 */
export function introTiming(samples: { qf: number; anim: number; phase: number }[], inputs: any = null, q0 = 0, q1 = Infinity): IntroTiming {
    return { demoEndTick: introDemoEnd(samples), firstSample: samples.length ? samples[0].qf : 0, exShineGot: sawFludd(inputs, q0, q1) };
}
/**
 * The ghost saw FLUDD on Mario in the segment (its V6+ FLUDD observations: a mode other than 0,
 * not Yoshi's pose): in a secret stage, its Shine was got before (else he goes in without him).
 */
export function sawFludd(I: any, q0: number, q1: number) {
    if (!I || !I.fluddMode || !I.hasFludd) return false;
    for (let i = 0; i < I.count; i++) {
        const q = I.qf[i];
        if (q < q0 || q > q1) continue;
        const m = I.fluddMode[i];
        if (m && !(m & 0x80)) return true;
    }
    return false;
}
export function introDemoEnd(samples: { qf: number; anim: number; phase: number }[]): number {
    const ap = samples.filter((s) => s.anim === A.DEMO_GATE_OUT_APPEAR || s.anim === A.DEMO_GATE_OUT_APPEAR_GET).slice(0, 12);
    if (ap.length >= 2) {
        const end = marioBckInfo(ANIME_DATA[ap[0].anim][0])[0];
        let best = ap[0].qf - 6, bestBad = Infinity;
        for (let t = ap[0].qf - 40; t < ap[0].qf; t++) {
            let bad = 0;
            for (const s of ap) {
                const frame = 0.5 * (s.qf - t);
                const p12 = Math.min(4095, Math.trunc(frame * 4096 / end + 0.5));
                const p8 = Math.trunc((p12 * 255 + 2047) / 4095);
                const rec = Math.round(s.phase * 255 / 4095);
                bad += Math.abs(p8 - rec);
            }
            if (bad < bestBad) { bestBad = bad; best = t; }
        }
        return best;
    }
    // Moonshine's first sample is the end of the frame after setMario's: the tick within the frame
    // depends on the console's wipe (not simulated); the Bianco 3 secret's is its third (coro_ex1: QF 92, 87)
    return samples.length ? samples[0].qf - 5 : 0;
}
export { calcKeyCode, IConverge };
