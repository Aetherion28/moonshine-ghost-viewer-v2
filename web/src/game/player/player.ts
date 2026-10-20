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

import { V3, s16, JMASSin, JMASCos, matan, IConverge } from '../math.js';
import { HitActor, TakeActor, LiveActor, MSG, HC, LF, Stream, CUE_MOVE, World, calcKeyCode } from '../engine.js';
import { AT } from '../actortypes.js';
import { POLLUTION_TYPE } from '../pollution.js';
import { TMarioSim, j3dTRMtx } from './tmario.js';
import { S, A, MF, ControllerWork, bg, marioBckInfo } from './base.js';
import { ANIME_DATA } from './tables.js';
import { MarioGamePad, PadStatus, MEANING, PAD_FLAG } from './pad.js';
import * as P from './params.js';
import { Params } from '../engine.js';
import type { MarioTrack, MarioSample } from '../mario.js';
import type { StickCamera, SimCamera } from '../camera/types.js';
import { fr, fmul, fadd, fsub, fdiv, fmadd, MsSqrtf, sqrtf, s16f, u8f } from './fmath.js';
import { TWaterGun, marioGunExec } from './watergun.js';
import { makePlayerCamera, PolarSubCamera } from '../camera/index.js';

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
        this.unk414.set(0, 0, 1);
        this.unk530 = new Int16Array(60); this.unk534 = 0; this.unk536 = 0; this.unk538 = 0; this.unk53A = 0; this.unk53B = 0;
        this.initHitActor(AT.MARIO, 5, HC.PLAYER | HC.MAP_OBJECT | HC.ITEM | HC.ENEMY | HC.BOSS | HC.NPC,
            this.mDeParams.mTrampleRadius, this.mDeParams.mAttackHeight, this.mDeParams.mDamageRadius, this.mDeParams.mDamageHeight);
        this.mCoinCount = 0;
        this.unk55C = 50;
    }
    initModel() {
        this.initJointIds();
        this.mModel.changeAnm(0, 0x3e);
        this.mModel.changeAnm(1, 0x41);
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
        try {
            const c = playerHooks.makeCamera ? playerHooks.makeCamera(this.world, this) : makePlayerCamera(this.world, this as any);
            this.simCamera = c; this.camera = c; this.cameraApprox = false;
            const G = this.mWaterGun as any;
            if (G && G.cameraHook && (c as any).isLButtonCamera) G.cameraHook = { isLButtonCamera: () => (c as any).isLButtonCamera(), isJetCoaster1stCamera: () => false, pitch: () => ((c as any).unk256 | 0) };
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
                if (n) n.mInsidePressure = fmul(this.mIntendedMag, 0.03125);
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
    /** canSquat: FLUDD out, R held, standing still enough */
    canSquat() {
        if (!this.checkFlag(MF.HAS_FLUDD) || !this.mWaterGun) return false;
        // (TMario::canSquat: needs the water gun's squat nozzle; the spray / hover nozzles only)
        return false;
    }
    thinkSituation() {
        const hpBefore = this.mHealth;
        super.thinkSituation();
        // the player's part of it: a stage change plane (isUnk300: a warp; the segment ends there)
        if (bg.isUnk300(this.mGroundPlane)) { this.offUnk114(2); this.offUnk114(0x400); }
        void hpBefore;
        // FLUDD's water on the ground under him: TModelWaterManager::askHitWaterParticleOnGround
        // (super's offFlag(RECENTLY_LEFT_WATER) came just before, as in the game)
        if (this.isTouchGround4cm() && this.askHitWaterParticleOnGround()) this.onFlag(MF.RECENTLY_LEFT_WATER);
    }
    thinkParams() {
        super.thinkParams();
        // (the cap's heat: TMarioCap unk4 & 1 is the cap on in the heat; no heat damage without it)
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
            } else if (this.mStatus === S.JUMP_CATCH || this.mStatus === S.CATCH || this.mStatus === S.OIL_SLIP || this.mStatus === S.OIL_SLOPE) {
                this.mOilBrake = D.mBrakeStartValSlip; this.mDirtyTimer = D.mDirtyTimeSlip;
                this.changePlayerStatus(S.OIL_SLIP, 0, false);
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
    /** TMario::checkWet: the drops off him after the water (effects only) */
    checkWet() { if (this.mWetWaterParticleTimer > 0) this.mWetWaterParticleTimer -= 1; }
    /** TMario::gunExec */
    gunExec() {
        const x = this.mGamePad.checkFrameMeaning(MEANING.X);
        if (playerHooks.gunExec) { playerHooks.gunExec(this, x); return; }
        marioGunExec(this as any, x);
    }
    thinkSound() { }
    /** TMario::thinkTorocco */
    thinkTorocco() { }
    checkYoshiGetOff() { }
    thinkYoshiHeadCollision() { }

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
                // (someAnimationCompleted: the upper body's fixed animation done)
                this.mUpperState = UPPER.IDLE;
                break;
            default:
                if (this.checkPumpEnable()) this.checkPumping();
                break;
        }
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
        const air = this.checkStatusType(S.FLAG_JUMPING) ? 1 : 0;
        const from = hit || this.mFloorHitActor;
        if (downType === 3) {
            // (setUpperDamageRun: the upper body's flinch while running)
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
        if (msg === MSG.THROWN) { this.changePlayerStatus(S.THROWN_DOWN, 0, false); return true; }
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
                case T.MARIO_CAP: this.mHealth = this.mDeParams.mHPMax; return true;
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
                case T.SURF_GESO_RED: case T.SURF_GESO_YELLOW: case T.SURF_GESO_GREEN: return true;   // (getGesso: surfing isn't simulated)
                case T.BATH: if (msg === MSG.TAKE) { this.holder = sender as TakeActor; this.changePlayerStatus(S.NOMOTION, 0, false); return true; } break;
                case T.BATH_WATER:
                    if (msg === MSG.BURN) {
                        if (!inv()) { this.dmg(sender, this.mDmgParamsFire); this.changePlayerStatus(S.THROWN_DOWN, 1, false); return true; }
                        return false;
                    }
                    break;
                case T.MAP_WIRE_ACTOR:
                    // (hanging from a wire: the wire statuses aren't simulated, so he doesn't catch it)
                    return false;
            }
        }
        if (sender.isHitCategory(HC.ENEMY)) {
            switch (t) {
                case T.NAME_KURI: if (msg === MSG.ATTACK && !inv()) { this.dmg(sender, this.mDmgParamsNamekuri); return true; } break;
                case T.DORO_HANE_KURI: case T.DORO_HAMU_KURI: if (msg === MSG.ATTACK && !inv()) { this.dmg(sender, this.mDmgParamsEnemyCommon); return true; } break;
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
                // (doors: opening them isn't simulated)
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
                // (the warp gate's capture: the segment ends there)
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
        // (pulling a tail / tentacle: the pulling statuses aren't simulated)
        this.hitNormal(a);
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
    rollingStart(warp: V3 | null, rot: number) {
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
        this.startCommon(warp, rot);
        this.onUnk114(2);
        this.changePlayerStatus(S.WAIT, 0, true);
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
    winDemo() {
        switch (this.mStatusState) {
            case 0:
                if (this.mHeldObject) { (this.mHeldObject as HitActor).receiveMessage(this.mHeldObject, MSG.UNKD); this.mHeldObject = null; }
                if (this.jumpProcess(0) === 1) { if (this.unk384) this.unk384.receiveMessage(this, MSG.TAKE); this.mStatusState = 1; }
                break;
            case 1: this.setAnimation(A.DEMO_SHINE_GET, 1); this.stopProcess(); break;
        }
        return 0;
    }
    downLoser() { this.setPlayerVelocity(0); this.setAnimation(A.LAND, 1); if (this.jumpProcess(0) === 1) this.changePlayerStatus(S.LOSER_DOWN, 0, true); return 0; }
    elecDowning() { this.setAnimation(A.SHOCK_DOWN, 1); return 0; }
    electricDamage() {
        if (this.mStatusState === 0) { this.setAnimation(A.SHOCK, 1); this.decHP(this.mDmgParamsGraffitoElec.mDamage); this.mStatusState = 1; }
        this.mStatusTimer += 1;
        if (this.mStatusTimer > 0x78) {
            this.getMotionFrameCtrl().frame = 0;
            this.mStatusTimer += 1;
            this.mFloorHitActor.pos.x = fadd(this.pos.x, JMASSin(this.mFaceAngle.y));
            this.mFloorHitActor.pos.z = fadd(this.pos.z, JMASCos(this.mFaceAngle.y));
            const E = this.mDmgParamsGraffitoElec;
            this.damageExec(this.mFloorHitActor, 0, 3, E.mWaterEmit, E.mMinSpeed, E.mMotor, 0, 0x3C);
            return this.changePlayerStatus(S.WAIT, 0, true);
        }
        return 0;
    }
    demoMain() {
        switch (this.mStatus) {
            case S.WIN_DEMO: return this.winDemo();
            case S.ELEC_DOWN: return this.elecDowning();
            case S.DOWN_LOSER: return this.downLoser();
            case S.WARP_OUT: return this.warpOut();
            case S.ELECTRIC_DAMAGE: return this.electricDamage();
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
        if (this.camera.isLButtonCamera && this.camera.isLButtonCamera()) {
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
        }
        if (this.mFreezeTimer <= 0) {
            this.calcAnim();
            const G = this.mWaterGun;
            if (G) { if (G.calcAnimFromMario) G.calcAnimFromMario(); }
        }
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
    drift = { firstQf: -1, firstErr: 0, maxErr: 0, frames: 0, synced: 0, warned: false };
    /** the ghost's sample at the end of each frame: how far the sim is from it */
    checkDrift() {
        const q = this.world.tickCount;
        if (q & 3) return;
        // (before setMario the ghost has no samples of its own: its first one is copied back to the segment's start)
        if (q <= this.driftFrom) return;
        const s = this.track!.at(q);
        if (!s) return;
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
    get phase() { const f = this.getMotionFrameCtrl(); return f.end > 0 ? f.frame / f.end : 0; }
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
export const DIR = { BOOT: 0, DEMO: 1, UNK2: 2, WIPE_OPEN: 3, GAME: 4 };
/** stages whose opening is always the camera demo (changeState STATE_UNK0) */
const DEMO_STAGES = new Set([2, 3, 4, 5, 6, 8, 9, 0x34]);
/** TConsoleStr: the open wipe's ticks (startOpenWipe to unk2BC 6) */
export const OPEN_WIPE_TICKS = 31;

export interface IntroTiming {
    /** the changeState (after this stage tick) that ends the camera demo (STATE_UNK1 to STATE_UNK3): the ghost's */
    demoEndTick: number;
    /** the ghost's first sample after the opening (its drift is checked from there) */
    firstSample?: number;
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
        if (DEMO_STAGES.has(this.map)) m.rollingStart(null, 0);
        else m.waitingStart(null, 0);
        if (m.checkFlag(MF.HAS_FLUDD) && m.mWaterGun) {
            switch (this.map) {
                case 1: case 2: case 3: case 4: case 5: case 6: case 8: case 9: case 0x10: case 0x2C: case 0x34: case 0x39: break;
                case 0x3C: m.mWaterGun.changeNozzle(NOZZLE.Rocket, true); break;
                default: m.mWaterGun.changeNozzle(NOZZLE.Spray, true); break;
            }
        }
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
                else if (this.map === 1) this.enter(DIR.UNK2, tick);
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
        }
    }
}

/**
 * The tick the camera demo ended, from a ghost: its first samples after the opening (Mario's
 * rolling start: the APPEAR animation's frame, 0.5 a tick from the tick after setMario), else
 * six ticks before the first of them (as the rolling-start ghosts have it).
 */
export function introTiming(samples: { qf: number; anim: number; phase: number }[]): IntroTiming {
    return { demoEndTick: introDemoEnd(samples), firstSample: samples.length ? samples[0].qf : 0 };
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
