// FLUDD: Player/WaterGun.cpp. TWaterGun (the tank, the nozzles, switching between them, the pump
// and nozzle models' animations, the emit points), TNozzleBase (the underwater nozzle; the shared
// emit / movement), TNozzleTrigger (rocket, hover, turbo, and the spray's spam-spray "bomb") and
// TNozzleDeform (the spray nozzle and Yoshi's mouth), with every parameter from params.szs
// (/Mario/WaterGun/*.prm, /Mario/WaterGun.prm, /Mario/GunEmit.prm). The water they emit goes
// through TModelWaterManager::emitRequest (water.ts), so what the drops hit reacts as in the game.
//
// Checked against the retail binary (GMSJ01 main.dol) function by function where the decomp is
// still nonmatching: the float operations (fmuls / fmadds / fnmsubs) are kept in the order and
// with the roundings the game uses: products of two f32 are exact in double, so a fused
// multiply-add is fr(a * b + c), and a separate multiply then add is fr(fr(a * b) + c).
//
// How a TMario (PlayerMario) drives it, as Player/MarioMain.cpp and MarioMove.cpp do:
//   construct:     this.mWaterGun = new TWaterGun(this); this.mWaterGun.init(); this.mWaterGun.setAmountToRate(rate)
//   playerControl: ... gunExec()  (marioGunExec(this, xHit) below is TMario::gunExec)
//   perform MOVE:  after playerControl and setPositions: this.mWaterGun.perform(CUE_MOVE)
//   calc anim:     after his calcAnim: this.mWaterGun.setBaseTRMtx(chest anm matrix); this.mWaterGun.perform(CUE_CALC_ANIM)
//                  (calcAnimFromMario() does both from mModel.anmMtx(mJointIdChest))
//
// Not simulated: the sounds and the rumble (they don't change the state), the water particles
// bound to the emit matrix (TMarioParticleManager 0x10D: drawing), Yoshi (no Yoshi in the sim:
// onYoshi() is false; the Yoshi nozzle's tongue matrix is null), the handle's TMultiMtxEffect
// and the mirror actor (drawing only).

import { VERSION } from '../version.js';
import type { mat4 } from 'gl-matrix';
import { fr, s16, JMASSin, JMASCos, V3, Mtx, mtx, MsMtxSetRotRPH } from '../math.js';
import { Params, PSchema, World, FrameCtrl, ANM_FRAME_RATE, CUE_MOVE, CUE_CALC_ANIM } from '../engine.js';
import { EmitInfo, emitInfo } from '../water.js';
import { Skeleton, parseBCK, jointMatrices } from '../skeleton.js';
import { marioFile, ControllerWork } from './base.js';
import { MF, S } from './tables.js';

import { fmadd as fma, fmsub as fms, fnmsub as fnms } from './fmath.js';
/** 360 / 65536 (SHORTANGLE2DEG; exact in f32) */
const S2D = 0.0054931640625;

// ---------------------------------------------------------------- the parameters
/** TNozzleBase's PARAM_INIT list (its .prm names, types and defaults). */
export const NOZZLE_PARAMS = {
    mRocketType: ['u8', 0], mNum: ['f', 1], mAttack: ['s16', 1], mDirTremble: ['f', 0.0099999998], mEmitPow: ['f', 40], mEmitCtrl: ['f', 1],
    mPowTremble: ['f', 1], mSize: ['f', 40], mSizeTremble: ['f', 16], mAmountMax: ['i', 0x834], mReactionPow: ['f', 0], mReactionY: ['f', 0],
    mDecRate: ['s16', 0], mTriggerRate: ['s16', 0x100], mDamageLoss: ['i', 0xfa], mSuckRate: ['f', 0.1], mHitRadius: ['f', 50], mHitHeight: ['f', 80],
    mLAngleBase: ['s16', 0x1000], mLAngleNormal: ['s16', 12000], mLAngleSquat: ['s16', 12000], mLAngleMin: ['s16', -0x2000], mLAngleMax: ['s16', 0x2000],
    mLAngleChase: ['f', 0.1], mSizeMinPressure: ['f', 0], mSizeMaxPressure: ['f', 1], mNumMin: ['f', 1], mAttackMin: ['s16', 1], mDirTrembleMin: ['f', 0.0099999998],
    mEmitPowMin: ['f', 40], mSizeMin: ['f', 40], mMotorPowMin: ['f', 5], mMotorPowMax: ['f', 25], mReactionPowMin: ['f', 0], mInsidePressureDec: ['f', 100],
    mInsidePressureMax: ['f', 4500], mTriggerTime: ['s16', 1], mType: ['s16', 0], mSideAngleMaxSide: ['s16', 0x4000], mSideAngleMaxFront: ['s16', 0x4000],
    mSideAngleMaxBack: ['s16', 0x2000], mRButtonMult: ['f', 10000], mEmitPowScale: ['f', 10],
} satisfies PSchema;
export type NozzleParams = { [K in keyof typeof NOZZLE_PARAMS]: number };
/**
 * TWaterGunParams (/Mario/WaterGun.prm). The hover height's name in the game (its rodata) is
 * mHHoverHeight: the decomp's mHoverHeight doesn't load from the file.
 */
export const WATERGUN_PARAMS = {
    mRocketHeight: ['f', 1500], mHHoverHeight: ['f', 160], mLAngleNormal: ['f', 60], mNozzleAngleYSpeed: ['f', 1], mNozzleAngleYBrake: ['f', 0.995],
    mNozzleAngleYSpeedMax: ['s16', 0x2000], mHoverRotMax: ['s16', 0x2000], mHoverSmooth: ['f', 0.05], mChangeSpeed: ['f', 0.1],
} satisfies PSchema;
export type WaterGunParams = { [K in keyof typeof WATERGUN_PARAMS]: number } & { /** (the decomp's name) */ mHoverHeight: number };

// ---------------------------------------------------------------- nozzleBmdData
/** TWaterGun::TNozzleType */
export const NOZZLE = { Spray: 0, Rocket: 1, Underwater: 2, Yoshi: 3, Hover: 4, Turbo: 5 } as const;
interface NozzleBmd { path: string; bmd: string; emitters: number; joints: [number, number][]; }
/** nozzleBmdData: each nozzle's model folder, its emitter count and its emit joints (flags: 0-2 a nozzle joint, 3 Yoshi's tongue, 4 none). */
export const NOZZLE_BMD: NozzleBmd[] = [
    { path: 'watergun2/normal_wg', bmd: 'watergun2/normal_wg/normal_wg.bmd', emitters: 1, joints: [[1, 0], [4, 0], [4, 0]] },
    { path: 'watergun2/rocket_wg', bmd: 'watergun2/rocket_wg/rocket_wg.bmd', emitters: 1, joints: [[2, 1], [4, 0], [4, 0]] },
    { path: 'watergun2/hover_wg', bmd: 'watergun2/hover_wg/hover_wg.bmd', emitters: 2, joints: [[1, 0], [1, 0], [4, 0]] },
    { path: 'watergun2/dummy_wg', bmd: 'watergun2/dummy_wg/dummy_wg.bmd', emitters: 1, joints: [[3, 0], [4, 0], [4, 0]] },
    { path: 'watergun2/hover_wg', bmd: 'watergun2/hover_wg/hover_wg.bmd', emitters: 2, joints: [[1, 0], [1, 0], [4, 0]] },
    { path: 'watergun2/back_wg', bmd: 'watergun2/back_wg/back_wg.bmd', emitters: 1, joints: [[1, 0], [4, 0], [4, 0]] },
];
/** the BCKs of each model folder, in data/mario.szs's archive order (MActorAnmData's indices) */
const FOLDER_BCKS: Record<string, string[]> = {
    'watergun2/body': ['wg_fepmp', 'wg_hgpmp', 'wg_house', 'wg_pump', 'wg_rspmp', 'wg_sqpmp', 'wg_swpmp'],
    'watergun2/normal_wg': ['house_wg_change_end', 'house_wg_change_start', 'normal_wg_change_end', 'normal_wg_change_start', 'normal_wg_house', 'normal_wg_shooting', 'normal_wg_shoot_end', 'normal_wg_shoot_start'],
    'watergun2/rocket_wg': ['rocket_wg_change_end', 'rocket_wg_change_start', 'rocket_wg_shooting', 'rocket_wg_shoot_end', 'rocket_wg_shoot_start'],
    'watergun2/hover_wg': ['hover_wg_change_end', 'hover_wg_change_start', 'hover_wg_shooting', 'hover_wg_shoot_end', 'hover_wg_shoot_start'],
    'watergun2/back_wg': ['back_wg_change_end', 'back_wg_change_start', 'back_wg_shooting', 'back_wg_shoot_end', 'back_wg_shoot_start'],
    'watergun2/dummy_wg': [],
};

// ---------------------------------------------------------------- a model and its BCK (MActor, for FLUDD's parts)
/** mat4 (column-major) to the game's 3x4 row-major Mtx */
export function mat4ToMtx(m: mat4 | Float32Array, out: Mtx = mtx()): Mtx {
    out[0] = m[0]; out[1] = m[4]; out[2] = m[8]; out[3] = m[12];
    out[4] = m[1]; out[5] = m[5]; out[6] = m[9]; out[7] = m[13];
    out[8] = m[2]; out[9] = m[6]; out[10] = m[10]; out[11] = m[14];
    return out;
}
/** post-multiply a joint's matrix (J3DSys::mCurrentMtx) by a 3x4 rotation: what its children see */
function concatRot(m: mat4, r: Mtx) {
    const a = Array.from(m);
    for (let c = 0; c < 3; c++) for (let row = 0; row < 3; row++) m[c * 4 + row] = a[row] * r[c] + a[4 + row] * r[4 + c] + a[8 + row] * r[8 + c];
}
/**
 * MActor for one of FLUDD's models: its BCKs (by index or name, MActorAnmBck: setting one starts
 * it from frame 0 at SMSGetAnmFrameRate), and J3DModel::calc's anm matrices with the joint
 * callbacks the game sets (J3DMtxCalcBasic::recursiveCalc: a callback changes what the joint's
 * children see, not the joint's own matrix).
 */
export class GunModel {
    bcks: string[]; bck = -1; fc = new FrameCtrl();
    baseTR: Mtx = mtx();
    /** J3DModel's anm matrices (game layout), from the last calc */
    anm: Mtx[] = [];
    callbacks = new Map<number, () => Mtx | null>();
    sk: Skeleton | null;
    constructor(public folder: string, public bmd: string) {
        this.bcks = FOLDER_BCKS[folder] || [];
        this.sk = Skeleton.of(marioFile(bmd));
        const n = this.sk ? this.sk.names.length : 0;
        for (let i = 0; i < n; i++) { const z = new Float64Array(12); this.anm.push(z); }
    }
    jointIndex(name: string) { return this.sk ? this.sk.index(name) : -1; }
    getFrameCtrl() { return this.fc; }
    checkCurBckFromIndex(i: number) { return this.bck === i; }
    /** MActorAnmBck::setAnmFromIndex (setFrameCtrl) */
    setBckFromIndex(i: number) {
        this.bck = i;
        if (i < 0 || i >= this.bcks.length) return;
        const b = marioFile(`${this.folder}/${this.bcks[i]}.bck`);
        const dv = b ? new DataView(b.buffer, b.byteOffset, b.byteLength) : null;
        this.fc.init(dv ? dv.getUint16(0x20 + 0x0A) : 0);
        if (b) this.fc.attr = b[0x20 + 0x08];
        this.fc.rate = ANM_FRAME_RATE;
    }
    /** MActor::setBck(name) (findName: the archive's name) */
    setBck(name: string) { this.setBckFromIndex(this.bcks.indexOf(name)); }
    bckName() { return this.bck >= 0 ? this.bcks[this.bck] || null : null; }
    /** MActor::perform: CALC_ANIM is calcAnm (frameUpdate, then the joints) */
    perform(cue: number) {
        if (cue & CUE_CALC_ANIM) { if (this.bck >= 0) this.fc.update(); this.calc(); }
    }
    calc() {
        if (!this.sk) return;
        const name = this.bckName();
        const anm = name ? parseBCK(marioFile(`${this.folder}/${name}.bck`)) : null;
        jointMatrices(this.sk, anm, this.fc.frame, this.baseTR, [1, 1, 1], [], (j, m) => {
            mat4ToMtx(m, this.anm[j]);
            for (let k = 0; k < 12; k++) this.anm[j][k] = fr(this.anm[j][k]);
            const cb = this.callbacks.get(j);
            const r = cb ? cb() : null;
            if (r) concatRot(m, r);
        });
    }
    getAnmMtx(j: number): Mtx | null { return j >= 0 && j < this.anm.length ? this.anm[j] : null; }
    /** MActor::isAnmEnd's test (TNozzleBase::isAnmEnd) */
    isAnmEnd() {
        const c = this.fc;
        return (c.state & 3) !== 0 || c.frame > fr(c.end - fr(0.1));
    }
}

// ---------------------------------------------------------------- what the water gun asks of Mario
/** The TMario fields and methods TWaterGun reads (TMarioSim / PlayerMario has them all). */
export interface WaterGunMario {
    world: World;
    pos: V3; mVel: V3; mFaceAngle: { x: number; y: number; z: number };
    mStatus: number; mUpperState: number; mAnimationId: number; mFloorPosition: V3;
    mModel: { fc: FrameCtrl[]; anmMtx(j: number): mat4 | null };
    mJointIdChest: number;
    addVelocity(v: number): void;
    checkFlag(f: number): boolean;
    isFencing(): boolean;
    onYoshi(): boolean;
    isMario(): boolean;
    /** TMarioGamePad::getCompSPos (the squatting aim: getCompSPos(0, 1)); 0 without a pad */
    mGamePad?: { mCompSPos?: ArrayLike<number>; getCompSPos?(input: number, axis: number): number } | null;
    /** TYoshi (unkD4: his juice, mType: 0 none): no Yoshi in the sim */
    mYoshi?: { mType: number; unkD4: number; getTongueMtx?(): Mtx | null } | null;
}

// ---------------------------------------------------------------- TNozzleBase
export class TNozzleBase {
    P: NozzleParams;
    /** 0x36C, 0x36E, 0x370, 0x372 (the trigger's pressure x 256), 0x374 (the last positive emit strength), 0x378 (this tick's), 0x37C (particles to emit, with the fraction) */
    mAnimationState = 2; mGunAngle = 0; mWaistAngle = 0; mTriggerPressure = 0; unk374 = 0; unk378 = 0; mEmitNum = 0;
    mMActor: GunModel | null = null;
    constructor(public name: string | null, public prm: string, public mFludd: TWaterGun) {
        this.P = new Params(prm, mFludd.mMario.world.files).read(NOZZLE_PARAMS);
        this.mAnimationState = 2; this.mGunAngle = 0; this.mTriggerPressure = 0; this.unk378 = 0; this.mEmitNum = 0;
    }
    init() { this.mAnimationState = 2; this.mGunAngle = 0; this.mTriggerPressure = 0; this.unk378 = 0; this.mEmitNum = 0; }
    getNozzleKind() { return 0; }
    getGunAngle() { return this.mGunAngle; }
    getWaistAngle() { return this.mWaistAngle; }
    getUnk378() { return this.unk378; }
    getMActor() { return this.mMActor; }
    getSideAngleMaxSide() { return this.P.mSideAngleMaxSide; }
    getSideAngleMaxFront() { return this.P.mSideAngleMaxFront; }
    getSideAngleMaxBack() { return this.P.mSideAngleMaxBack; }
    /** mRocketType (1: rocket and hover: Mario's rocketCheck / hover statuses) */
    get mRocketType() { return this.P.mRocketType; }
    get mAmountMax() { return this.P.mAmountMax; }

    calcGunAngle(C: ControllerWork) {
        const F = this.mFludd, M = F.mMario;
        if (M.isMario() && F.cameraHook && (F.cameraHook.isLButtonCamera() || F.cameraHook.isJetCoaster1stCamera())) {
            this.mGunAngle = s16(F.cameraHook.pitch());
            return;
        }
        let target: number;
        if (M.mStatus === S.SQUAT) {
            const pad = M.mGamePad;
            const sp = pad ? (pad.getCompSPos ? pad.getCompSPos(0, 1) : pad.mCompSPos ? pad.mCompSPos[1] : 0) : 0;
            target = this.mGunAngle + Math.trunc(fr(sp * this.P.mRButtonMult));
        } else target = -this.P.mLAngleBase;
        if (s16(target) < this.P.mLAngleMin) target = this.P.mLAngleMin;
        if (s16(target) > this.P.mLAngleMax) target = this.P.mLAngleMax;
        this.mGunAngle = s16(Math.trunc(fma(s16(target) - this.mGunAngle, this.P.mLAngleChase, this.mGunAngle)));
    }
    /** TNozzleBase::movement: the trigger's pressure rises at mTriggerRate a tick; unk378 is how much it rose */
    movement(C: ControllerWork) {
        if (this.mFludd.mCurrentWater <= 0) return;
        const tp = Math.trunc(fr(256 * fr(150 * C.mAnalogR)));
        if (tp > this.mTriggerPressure) {
            this.unk378 = fr((tp - this.mTriggerPressure) * (1 / 65536));
            this.unk374 = this.unk378;
            this.mTriggerPressure = (this.mTriggerPressure + (this.P.mTriggerRate & 0xFFFF)) & 0xFFFF;
            if (tp < this.mTriggerPressure) this.mTriggerPressure = tp & 0xFFFF;
        } else {
            this.unk378 = 0;
            this.mTriggerPressure = tp & 0xFFFF;
        }
        this.calcGunAngle(C);
    }
    /** emitCommon: the particles' type, life, the emit point, direction and Mario's drift */
    emitCommon(i: number, I: EmitInfo) {
        const W = this.mFludd.water();
        const T = W ? W.types[this.P.mType] : null;
        I.alive = s16(Math.trunc(T ? T.mAlive : 255));
        const d = this.mFludd.getEmitPosDirSpeed(i);
        I.pos = d.pos; I.v = d.speed; I.dir = d.dir;
        I.dirTremble = this.P.mDirTremble; I.powTremble = this.P.mPowTremble; I.size = this.P.mSize; I.sizeTremble = this.P.mSizeTremble;
        I.type = this.P.mType; I.hitRadius = this.P.mHitRadius; I.hitHeight = this.P.mHitHeight;
    }
    protected flagOf() { return this.mFludd.hasFlag(TWaterGun.FLAG_UNK2) ? 0x40 | 0x80 : 0x40; }
    /** gpModelWaterManager->emitRequest, then the tank and the counts */
    protected request(I: EmitInfo) {
        const W = this.mFludd.water();
        const n = W ? W.emitRequest(I) & 0xFF : 0;
        this.mFludd.updateUnk1C88(n);
        if (n) this.mFludd.depleteWater(n * this.P.mDecRate);
        return n;
    }
    /** TNozzleBase::emit (the underwater nozzle's): mNum a tick while the trigger rises */
    emit(i: number) {
        const F = this.mFludd;
        if (!(F.mCurrentWater > 0 && this.unk378 !== 0)) return;
        const I = F.mEmitInfo, P = this.P;
        this.emitCommon(i, I);
        this.mEmitNum = fr(this.mEmitNum + P.mNum);
        const n = Math.trunc(this.mEmitNum);
        if (n === 0) return;
        this.mEmitNum = fr(this.mEmitNum - n);
        I.num = n;
        I.attack = P.mAttack;
        I.pow = fma(P.mEmitCtrl, fr(P.mEmitPow * this.unk378), fr(P.mEmitPow * fr(1 - P.mEmitCtrl)));
        I.flag = this.flagOf();
        if (this.request(I)) {
            const M = F.mMario, dir = I.dir, a = M.mFaceAngle.y;
            const back = fms(fr(-dir[0]), JMASSin(a), fr(dir[2] * JMASCos(a)));
            const rp = fr(I.pow * P.mReactionPow);
            M.addVelocity(fr(back * rp));
            M.mVel.x = fnms(dir[0], rp, M.mVel.x);
            M.mVel.z = fnms(dir[2], rp, M.mVel.z);
            M.mVel.y = fr(M.mVel.y + fr(fr(-dir[1] * I.pow) * P.mReactionY));
        }
    }
    isAnmEnd() { return this.mMActor ? this.mMActor.isAnmEnd() : true; }
    /** the shoot / change state machine (TNozzleBase::animation: the underwater nozzle; TNozzleTrigger's adds the particles) */
    protected animationStates(start: number, shooting: number, end: number, chStart: number, chEnd: number) {
        const F = this.mFludd, A = this.mMActor!;
        const c = A.getFrameCtrl();
        if (F.isSwitchingToSecondaryNozzle()) this.mAnimationState = 4;
        if (F.isSwitchingToPrimaryNozzle()) this.mAnimationState = 3;
        const set = (i: number) => { if (!A.checkCurBckFromIndex(i)) A.setBckFromIndex(i); };
        switch (this.mAnimationState) {
            case 0: set(start); if (this.isAnmEnd()) this.mAnimationState = 1; break;
            case 1: set(shooting); if (!F.isEmitting()) this.mAnimationState = 2; break;
            case 2: set(end); if (F.isEmitting()) this.mAnimationState = 0; break;
            case 3:
                set(chStart);
                c.frame = fr(fnms(2, fr(F.mSwitchToSecondNozzleProgress - 0.5), 1) * c.end); c.rate = 0;
                break;
            case 4:
                set(chEnd);
                c.frame = fr(fr(2 * fr(F.mSwitchToSecondNozzleProgress - 0.5)) * c.end); c.rate = 0;
                if (F.mSwitchToSecondNozzleProgress >= 1) this.mAnimationState = 0;
                break;
        }
    }
    animation(type: number) {
        if (type !== NOZZLE.Underwater || !this.mMActor) return;
        this.animationStates(4, 2, 3, 1, 0);
    }
}

// ---------------------------------------------------------------- TNozzleTrigger
export const SPRAY_STATE = { INACTIVE: 0, ACTIVE: 1, DEAD: 2 } as const;
export class TNozzleTrigger extends TNozzleBase {
    /** 0x384 (the spam spray: A while R is held fires it), 0x385, 0x386, 0x388 (the charge), 0x38C */
    mRumbleOnCharge = false; mSprayState: number = SPRAY_STATE.INACTIVE; mSprayTimer = 0; mInsidePressure = 0; mSoundId = -1;
    constructor(name: string | null, prm: string, fludd: TWaterGun) {
        super(name, prm, fludd);
        this.mSoundId = -1; this.mRumbleOnCharge = false; this.mSprayState = SPRAY_STATE.INACTIVE; this.mAnimationState = 0; this.mSprayTimer = 0; this.mInsidePressure = 0;
    }
    init() { this.mRumbleOnCharge = false; this.mSprayState = SPRAY_STATE.INACTIVE; this.mAnimationState = 0; this.mSprayTimer = 0; this.mInsidePressure = 0; }
    getNozzleKind() { return 1; }
    getSprayState() { return this.mSprayState; }
    /** TNozzleTrigger::movement: the charge (mInsidePressure) builds while pumping; full (or A for the spam spray) fires it for mTriggerTime ticks */
    movement(C: ControllerWork) {
        const F = this.mFludd, M = F.mMario, P = this.P;
        if (F.mCurrentWater <= 0) { this.mSprayState = SPRAY_STATE.INACTIVE; this.mSprayTimer = 0; this.mInsidePressure = 0; return; }
        if (this.mSprayState === SPRAY_STATE.ACTIVE) {
            this.mSprayTimer = s16(this.mSprayTimer - 1);
            if (M.mUpperState !== 0 || this.mSprayTimer <= 0) { this.mSprayState = SPRAY_STATE.DEAD; this.mInsidePressure = 0; this.mSprayTimer = 0; }
        }
        if (this.mRumbleOnCharge && (C.mFrameInput & ControllerWork.A) !== 0 && (C.mInput & ControllerWork.R) !== 0 && this.mSprayState === SPRAY_STATE.INACTIVE) {
            this.mSprayState = SPRAY_STATE.ACTIVE;
            // (the sound: MSD_SE_PO_WATER_LOW_TRG / HI_TRG)
            this.mSprayTimer = P.mTriggerTime;
        }
        let canSpray = M.mUpperState === 0;   // UPPER_STATE_PUMPING
        if (M.checkFlag(MF.IN_ANY_WATER) && F.mCurrentWater < P.mAmountMax) canSpray = false;
        if (canSpray) {
            this.mInsidePressure = fma(150, C.mAnalogR, this.mInsidePressure);
            // (the charging rumble and MSD_SE_SY_NEWP_AIR_TAME)
        }
        this.mInsidePressure = fr(this.mInsidePressure - P.mInsidePressureDec);
        if (this.mInsidePressure < 0) this.mInsidePressure = 0;
        if (this.mInsidePressure > P.mInsidePressureMax) {
            this.mInsidePressure = P.mInsidePressureMax;
            if (!this.mRumbleOnCharge && this.mSprayState === SPRAY_STATE.INACTIVE) {
                this.mSprayState = SPRAY_STATE.ACTIVE;
                this.mSprayTimer = P.mTriggerTime;
                // (mSoundId, and the rumble for the hover / rocket / turbo)
            }
        }
        if (this.mSprayState === SPRAY_STATE.DEAD) {
            this.mInsidePressure = 0;
            if (C.mAnalogR === 0) this.mSprayState = SPRAY_STATE.INACTIVE;
        }
        this.calcGunAngle(C);
    }
    /** TNozzleTrigger::emit: while firing, mNumMin..mNum particles a tick by the charge */
    emit(i: number) {
        const F = this.mFludd, P = this.P;
        if (!(F.mCurrentWater > 0 && (this.mSprayState & 0xFF) === SPRAY_STATE.ACTIVE)) return;
        const I = F.mEmitInfo;
        this.emitCommon(i, I);
        const p = fr(this.mInsidePressure / P.mInsidePressureMax);
        this.mEmitNum = fr(this.mEmitNum + fma(p, fr(P.mNum - P.mNumMin), P.mNumMin));
        const n = Math.trunc(this.mEmitNum);
        if (n === 0) return;
        this.mEmitNum = fr(this.mEmitNum - n);
        I.num = n;
        I.attack = s16(Math.trunc(fma(p, P.mAttack - P.mAttackMin, P.mAttackMin)));
        I.pow = fma(p, fr(P.mEmitPow - P.mEmitPowMin), P.mEmitPowMin);
        I.flag = this.flagOf();
        if (this.request(I)) {
            // (the hover's rumble every 8 ticks)
            const M = F.mMario, dir = I.dir, a = M.mFaceAngle.y;
            const rp = fma(p, fr(P.mReactionPow - P.mReactionPowMin), P.mReactionPowMin);
            const scale = fms(fr(-dir[0]), JMASSin(a), fr(dir[2] * JMASCos(a)));
            M.addVelocity(fr(scale * fr(rp * I.pow)));
            M.mVel.y = fr(M.mVel.y + fr(fr(-dir[1] * I.pow) * P.mReactionY));
        }
    }
    animation(type: number) {
        if ((type !== NOZZLE.Hover && type !== NOZZLE.Rocket && type !== NOZZLE.Turbo) || !this.mMActor) return;
        this.animationStates(4, 2, 3, 1, 0);
        // (each emitter's particle 0x10D bound to its emit matrix while water came out)
    }
}

// ---------------------------------------------------------------- TNozzleDeform
export class TNozzleDeform extends TNozzleBase {
    /** the spam spray (/Mario/WaterGun/NozzleDeformBomb.prm) */
    mBomb: TNozzleTrigger;
    constructor(name: string | null, prm: string, fludd: TWaterGun) {
        super(name, prm, fludd);
        this.mBomb = new TNozzleTrigger(name, '/Mario/WaterGun/NozzleDeformBomb.prm', fludd);
        this.init();
    }
    getNozzleKind() { return 3; }
    /** TNozzleDeform::movement: the base's, the strength scaled by mEmitPowScale (to 1), then the bomb's */
    movement(C: ControllerWork) {
        if (!this.mFludd.hasWater()) return;
        super.movement(C);
        this.unk378 = fr(this.unk378 * this.P.mEmitPowScale);
        if (this.unk378 > 1) this.unk378 = 1;
        this.mBomb.movement(C);
    }
    /** TNozzleDeform::emit: the spray, its spread, power and drop size by the strength; then the bomb's */
    emit(i: number) {
        const F = this.mFludd, P = this.P, M = F.mMario;
        if (i === NOZZLE.Yoshi && M.mYoshi && M.mYoshi.mType === 0) return;
        if (!(F.mCurrentWater > 0)) return;
        if (this.mBomb.mSprayState === SPRAY_STATE.INACTIVE && this.unk378 > 0) {
            const I = F.mEmitInfo;
            this.emitCommon(i, I);
            const u = this.unk378;
            this.mEmitNum = fr(this.mEmitNum + fma(u, fr(P.mNum - P.mNumMin), P.mNumMin));
            const n = Math.trunc(this.mEmitNum);
            if (n === 0) return;   // (the bomb waits too)
            this.mEmitNum = fr(this.mEmitNum - n);
            I.num = n;
            I.attack = s16(Math.trunc(fma(u, P.mAttack - P.mAttackMin, P.mAttackMin)));
            I.dirTremble = fma(u, fr(P.mDirTremble - P.mDirTrembleMin), P.mDirTrembleMin);
            I.pow = fma(u, fr(P.mEmitPow - P.mEmitPowMin), P.mEmitPowMin);
            I.flag = this.flagOf();
            let l: number;
            if (u < P.mSizeMinPressure) l = 0;
            else if (u < P.mSizeMaxPressure) l = fr(fr(u - P.mSizeMinPressure) / fr(P.mSizeMaxPressure - P.mSizeMinPressure));
            else l = 1;
            I.size = fma(l, fr(P.mSize - P.mSizeMin), P.mSizeMin);
            if (this.request(I)) {
                // (the rumble every 8 ticks)
                const dir = I.dir, a = M.mFaceAngle.y;
                const rp = fma(u, fr(P.mReactionPow - P.mReactionPowMin), P.mReactionPowMin);
                const dot = fms(fr(-dir[0]), JMASSin(a), fr(dir[2] * JMASCos(a)));
                M.addVelocity(fr(dot * fr(rp * I.pow)));
                M.mVel.y = fr(M.mVel.y + fr(fr(-dir[1] * I.pow) * P.mReactionY));
            }
        }
        this.mBomb.emit(i);
    }
    /** TNozzleDeform::animation: the spray nozzle's (folded into the house, shooting, changing) */
    animation(type: number) {
        if (type !== 0 && type !== 3) return;
        if (type === 3) return;
        const F = this.mFludd, A = this.mMActor;
        if (!A || F.directorState === 3) return;
        if (F.isSwitchingToSecondaryNozzle()) {
            if (this.mAnimationState !== 4 && this.mAnimationState !== 6) this.mAnimationState = F.unk1CEC > 0.5 ? 4 : 6;
        } else if (F.isSwitchingToPrimaryNozzle()) {
            if (this.mAnimationState !== 5 && this.mAnimationState !== 7) this.mAnimationState = F.unk1CEC > 0.5 ? 5 : 7;
        } else if (F.unk1CEC > 0) this.mAnimationState = 0;
        else if (this.mAnimationState === 0) this.mAnimationState = 2;
        const c = A.getFrameCtrl();
        const set = (i: number) => { if (!A.checkCurBckFromIndex(i)) A.setBckFromIndex(i); };
        const p = F.mSwitchToSecondNozzleProgress;
        switch (this.mAnimationState) {
            case 0: set(4); c.frame = fr(c.end * F.unk1CEC); break;
            case 1: break;
            case 2: set(7); if (A.isAnmEnd()) this.mAnimationState = 3; break;
            case 3: set(5); if (!F.isEmitting()) this.mAnimationState = 8; break;
            case 8: {
                set(6);
                if (F.isEmitting()) this.mAnimationState = 2;
                if (A.isAnmEnd() && F.unk1CEC !== 0) this.mAnimationState = 0;
                break;
            }
            case 4: set(1); c.frame = fr(fr(2 * p) * c.end); c.rate = 0; break;
            case 5:
                set(0); c.frame = fr(fnms(2, p, 1) * c.end); c.rate = 0;
                if (F.mSwitchToSecondNozzleProgress <= 0) { this.mAnimationState = 0; F.unk1CEC = 0; }
                break;
            case 6: set(3); c.frame = fr(fr(2 * p) * c.end); c.rate = 0; break;
            case 7:
                set(2); c.frame = fr(fnms(2, p, 1) * c.end); c.rate = 0;
                if (F.mSwitchToSecondNozzleProgress <= 0) { this.mAnimationState = 2; F.unk1CEC = 0; }
                break;
        }
        // (the particle 0x10D bound to the emit matrix while water came out)
    }
}

// ---------------------------------------------------------------- TWaterGun
/** the camera TNozzleBase::calcGunAngle asks about (gpCamera, for the player only) */
export interface GunCameraHook { isLButtonCamera(): boolean; isJetCoaster1stCamera(): boolean; pitch(): number; }

export class TWaterGun {
    static readonly FLAG_UNK2 = 0x2; static readonly FLAG_UNK4 = 0x4; static readonly FLAG_UNK10 = 0x10;
    static readonly Spray = 0; static readonly Rocket = 1; static readonly Underwater = 2; static readonly Yoshi = 3; static readonly Hover = 4; static readonly Turbo = 5;
    /** 0x4: WATER_GUN_FLAG_* (2: the drops get flag 0x80, 4: skip the next emit, 0x10: the tank is emptied every tick) */
    mFlags = 0;
    mNozzleDeform: TNozzleDeform; mNozzleRocket: TNozzleTrigger; mNozzleUnderWater: TNozzleBase;
    mNozzleYoshiDeform: TNozzleDeform; mNozzleHover: TNozzleTrigger; mNozzleTurbo: TNozzleTrigger;
    mNozzleList: TNozzleBase[] = [];
    /** 0x1C80: the water in the tank (of the current nozzle's mAmountMax) */
    mCurrentWater = 0;
    mCurrentNozzle = 0; mSecondNozzle = 4;
    /** 0x1C86: the particles emitted this tick (getEmittedWaterCount) */
    mEmittedWaterCount = 0; unk1C87 = 0;
    unk1C88 = 0;
    /** 0x1C8C: R's pressure (0..150) this tick; 0x1C8D its peak, falling 1 a tick */
    mCurrentPressure = 0; mPreviousPressure = 0;
    /** 0x1C90: the emit points (the muzzle joints' translations at the last calc anim; [3] init's Mario position) */
    mEmitPos: V3[] = [new V3(), new V3(), new V3(), new V3()];
    unk1CC0 = 0;
    /** 0x1CC2, 0x1CC4: the hover nozzles' target angles (Mario's hover / rocket statuses set them), 0x1CC8 / 0x1CCC: the angles (f32) */
    unk1CC2 = 0; unk1CC4 = 0; unk1CC6 = 0;
    mHoverAngleL = 0; mHoverAngleR = 0;
    /** 0x1CD0: the turbo's propeller angle, 0x1CD2 its speed */
    mPropellerAngle = 0; unk1CD2 = 0;
    mFluddModel: GunModel;
    /** 0x1CD8: the body's nozzle_center joint */
    unk1CD8 = 0;
    unk1CE0 = 0;
    /** 0x1CEC: how far the spray nozzle is folded into its house (1: housed, 0: out) */
    unk1CEC = 1; unk1CF0 = fr(0.1); unk1CF4 = fr(0.005);
    /** 0x1CF8 / 0x1CFA: how long the pump pose holds after pumping (360 ticks) */
    unk1CF8 = 0x168; unk1CFA = 0;
    /** 0x1CFC: 0 spray .. 1 the second nozzle; 0x1D00: the switch's speed (+/- mChangeSpeed) */
    mSwitchToSecondNozzleProgress = 0; mSwitchToSecondNozzleSpeed = 0;
    unk1D04 = 0; unk1D06 = -0x1800; unk1D08 = 0;
    mEmitInfo: EmitInfo;
    mWatergunParams: WaterGunParams;
    /** gpMarDirector->unk124 (3: TNozzleDeform::animation stops) */
    directorState = 0;
    cameraHook: GunCameraHook | null = null;

    constructor(public mMario: WaterGunMario) {
        this.mNozzleDeform = new TNozzleDeform('normal_wg', '/Mario/WaterGun/NozzleDeform.prm', this);
        this.mNozzleRocket = new TNozzleTrigger(null, '/Mario/WaterGun/NozzleTrgRocket.prm', this);
        this.mNozzleUnderWater = new TNozzleBase('hover_wg', '/Mario/WaterGun/NozzleDiving.prm', this);
        this.mNozzleYoshiDeform = new TNozzleDeform('dummy_wg', '/Mario/WaterGun/NozzleYoshiMouth.prm', this);
        this.mNozzleHover = new TNozzleTrigger('hover_wg', '/Mario/WaterGun/NozzleTrgHover.prm', this);
        this.mNozzleTurbo = new TNozzleTrigger('back_wg', '/Mario/WaterGun/NozzleTrgTurbo.prm', this);
        const w = new Params('/Mario/WaterGun.prm', mMario.world.files).read(WATERGUN_PARAMS) as WaterGunParams;
        Object.defineProperty(w, 'mHoverHeight', { get: () => w.mHHoverHeight, enumerable: false });
        this.mWatergunParams = w;
        this.mEmitInfo = emitInfo('/Mario/GunEmit.prm', mMario.world.files);
        this.mFluddModel = new GunModel('watergun2/body', 'watergun2/body/wg_mdl1.bmd');
    }

    water() { return this.mMario.world.water; }

    /** TWaterGun::init */
    init() {
        this.mFlags = 0;
        this.mNozzleList = [this.mNozzleDeform, this.mNozzleRocket, this.mNozzleUnderWater, this.mNozzleYoshiDeform, this.mNozzleHover, this.mNozzleTurbo];
        this.mCurrentNozzle = NOZZLE.Spray; this.mSecondNozzle = NOZZLE.Hover;
        this.mNozzleRocket.mSoundId = 0x81b; this.mNozzleDeform.mBomb.mSoundId = 0x813;
        this.mCurrentWater = this.mNozzleList[this.mCurrentNozzle].P.mAmountMax;
        this.mEmittedWaterCount = 0; this.unk1C88 = 0; this.mCurrentPressure = 0; this.mPreviousPressure = 0;
        this.unk1CEC = 1; this.unk1CF0 = fr(0.1); this.unk1CF4 = fr(0.005); this.unk1CF8 = 0x168; this.unk1CFA = 0;
        this.mSwitchToSecondNozzleProgress = 0; this.mSwitchToSecondNozzleSpeed = 0;
        this.unk1D04 = 0; this.unk1D06 = -0x1800; this.unk1D08 = 0;
        this.mNozzleDeform.mBomb.mRumbleOnCharge = true; this.mNozzleYoshiDeform.mBomb.mRumbleOnCharge = true;
        this.mEmitPos[3].set(this.mMario.pos);
        this.unk1CC0 = this.unk1CC2 = this.unk1CC4 = 0;
        this.mHoverAngleL = 0; this.mHoverAngleR = 0; this.mPropellerAngle = 0; this.unk1CD2 = 0;
        // the body on Mario's chest
        const chest = this.marioChestMtx();
        if (chest) this.mFluddModel.baseTR.set(chest);
        this.mFluddModel.calc();
        this.unk1CD8 = this.mFluddModel.jointIndex('nozzle_center');
        for (let i = 0; i < 6; i++) {
            const B = NOZZLE_BMD[i];
            const m = new GunModel(B.path, B.bmd);
            this.mNozzleList[i].mMActor = m;
            // nozzleBmdData's joint indices (null_G_muzzle, 2, 3)
            ['null_G_muzzle', 'null_G_muzzle2', 'null_G_muzzle3'].forEach((n, k) => { if (B.joints[k][0] !== 4) B.joints[k][1] = m.jointIndex(n) & 0xFF; });
        }
        // the joint callbacks (NozzleCtrl, WaterGunDivingCtrlL / R, RotateCtrl)
        const nozzleCtrl = () => {
            const a = s16(this.getCurrentNozzle().getGunAngle());
            if (a >= 0) return null;
            const r = mtx(); MsMtxSetRotRPH(r, 0, 0, fr(a * S2D)); return r;
        };
        const sp = this.mNozzleList[NOZZLE.Spray].mMActor!, hv = this.mNozzleList[NOZZLE.Hover].mMActor!, tb = this.mNozzleList[NOZZLE.Turbo].mMActor!;
        sp.callbacks.set(sp.jointIndex('chn_muzzle_1'), nozzleCtrl);
        hv.callbacks.set(hv.jointIndex('jnt_nozzle_L'), () => { const r = mtx(); MsMtxSetRotRPH(r, 0, 0, fr(s16(-Math.trunc(this.mHoverAngleL)) * S2D)); return r; });
        hv.callbacks.set(hv.jointIndex('jnt_nozzle_R'), () => { const r = mtx(); MsMtxSetRotRPH(r, 0, 0, fr(s16(-Math.trunc(this.mHoverAngleR)) * S2D)); return r; });
        tb.callbacks.set(tb.jointIndex('chn_back_nozzle_prop'), () => { const r = mtx(); MsMtxSetRotRPH(r, fr(this.mPropellerAngle * S2D), 0, 0); return r; });
        tb.callbacks.set(tb.jointIndex('jnt_back_nozzle_neck'), nozzleCtrl);
        if (chest) this.mFluddModel.baseTR.set(chest);
        this.mFluddModel.calc();
        // (the nozzle models haven't been calculated: their matrices are zero until the first calc anim)
        for (let i = 0; i < NOZZLE_BMD[this.mCurrentNozzle].emitters; i++) {
            const e = this.getEmitMtx(i);
            if (e) this.mEmitPos[i].set(e[3], e[7], e[11]);
        }
    }
    private marioChestMtx(): Mtx | null {
        const m = this.mMario.mModel.anmMtx(this.mMario.mJointIdChest);
        return m ? mat4ToMtx(m) : null;
    }

    // ---- inlines (WaterGun.hpp)
    getCurrentNozzle() { return this.mNozzleList[this.mCurrentNozzle]; }
    getNozzle(i: number) { return this.mNozzleList[i]; }
    getCurrentNozzleType() { return this.mCurrentNozzle; }
    hasFlag(f: number) { return (this.mFlags & f) !== 0; }
    onFlag(f: number) { this.mFlags |= f; }
    offFlag(f: number) { this.mFlags &= ~f; }
    hasWater() { return this.mCurrentWater > 0; }
    getCurrentWater() { return this.mCurrentWater; }
    getMaxWater() { return this.getCurrentNozzle().P.mAmountMax; }
    depleteWater(n: number) { this.mCurrentWater = (this.mCurrentWater - n) | 0; if (this.mCurrentWater < 0) this.mCurrentWater = 0; }
    addWater(n: number) { this.mCurrentWater = (this.mCurrentWater + n) | 0; const m = this.getMaxWater(); if (this.mCurrentWater > m) this.mCurrentWater = m; }
    resetWaterToFull() { this.mCurrentWater = this.getMaxWater(); }
    getSuckRate() { return Math.trunc(fr(this.mCurrentPressure * this.getCurrentNozzle().P.mSuckRate)); }
    getEmittedWaterCount() { return this.mEmittedWaterCount; }
    getEmitInfo() { return this.mEmitInfo; }
    getSwitchProgress() { return this.mSwitchToSecondNozzleProgress; }
    getEmitPos0() { return this.mEmitPos[0]; }
    getPropellerAngle() { return this.mPropellerAngle; }
    getHoverAngleL() { return s16(Math.trunc(this.mHoverAngleL)); }
    getHoverAngleR() { return s16(Math.trunc(this.mHoverAngleR)); }
    getMario() { return this.mMario; }
    isSwitchingToPrimaryNozzle() { return this.mSwitchToSecondNozzleSpeed < 0; }
    isSwitchingToSecondaryNozzle() { return this.mSwitchToSecondNozzleSpeed > 0; }
    checkCurrentNozzleRocketType(t: number) { return this.getCurrentNozzle().P.mRocketType === t; }
    checkCurrentNozzleKind(k: number) { return this.getCurrentNozzle().getNozzleKind() === k; }
    checkCurrentNozzleTriggerSprayState(s: number) { return (this.getCurrentNozzle() as TNozzleTrigger).mSprayState === s; }
    /** updateUnk1C88 (an inline of the emits and gunExec): the particle count, and a running tally */
    updateUnk1C88(n: number) {
        this.mEmittedWaterCount = n & 0xFF;
        const max = this.mNozzleList[0].P.mAmountMax, dec = this.getCurrentNozzle().P.mDecRate;
        this.unk1C88 = fma(10, fr(fr(n * dec) / max), this.unk1C88);
    }
    /** isEmitting (canSpray): water, and the trigger nozzle firing or the others' trigger rising */
    isEmitting() {
        if (this.mCurrentWater === 0) return false;
        // (PAL: a real function in WaterGun.cpp, and no emitting during a camera demo or a talk)
        if (VERSION.pal) { const w = this.mMario.world; if (w.demoMode || w.talkMode) return false; }
        const n = this.getCurrentNozzle();
        if (n.getNozzleKind() === 1) return (n as TNozzleTrigger).getSprayState() === SPRAY_STATE.ACTIVE;
        return n.unk378 > 0;
    }
    canSpray() { return this.isEmitting(); }

    // ---- WaterGun.cpp
    getEmitMtx(j: number): Mtx | null {
        if (this.mMario.onYoshi()) return this.yoshiTongue();
        const [flag, idx] = NOZZLE_BMD[this.mCurrentNozzle].joints[j] || [4, 0];
        if (flag === 0 || flag === 1 || flag === 2) { const A = this.getCurrentNozzle().mMActor; return A ? A.getAnmMtx(idx) : null; }
        if (flag === 3) return this.yoshiTongue();
        return null;
    }
    private yoshiTongue(): Mtx | null { const y = this.mMario.mYoshi; return y && y.getTongueMtx ? y.getTongueMtx() : null; }
    getNozzleMtx() { return this.mFluddModel.getAnmMtx(this.unk1CD8); }
    /** changeNozzle: the tank keeps its fill rate (Yoshi's: his juice) */
    changeNozzle(type: number, animate: boolean) {
        const used = fr(this.mCurrentWater / this.mNozzleList[this.mCurrentNozzle].P.mAmountMax);
        if (type === NOZZLE.Spray) { if (animate) this.mSwitchToSecondNozzleProgress = 0; }
        else { this.mSecondNozzle = type; if (animate) this.mSwitchToSecondNozzleProgress = 1; }
        this.mCurrentNozzle = type;
        this.mNozzleList[this.mCurrentNozzle].init();
        if (type === NOZZLE.Yoshi) this.mCurrentWater = this.mMario.mYoshi ? this.mMario.mYoshi.unkD4 : 0;
        else this.mCurrentWater = Math.trunc(fr(used * this.mNozzleList[this.mCurrentNozzle].P.mAmountMax));
    }
    /** rotateProp: the turbo's propeller spins up with v (Mario's dash speed, or the trigger) */
    rotateProp(v: number) {
        const W = this.mWatergunParams;
        if (this.mCurrentNozzle === NOZZLE.Turbo) {
            this.unk1CD2 = s16(Math.trunc(fma(v, W.mNozzleAngleYSpeed, this.unk1CD2)));
            this.unk1CD2 = s16(Math.trunc(fr(this.unk1CD2 * W.mNozzleAngleYBrake)));
            if (W.mNozzleAngleYSpeedMax < this.unk1CD2) this.unk1CD2 = W.mNozzleAngleYSpeedMax;
            this.mPropellerAngle = s16(this.mPropellerAngle + this.unk1CD2);
        } else { this.unk1CD2 = 0; this.mPropellerAngle = 0; }
    }
    /** SMS_isDivingMap */
    isDivingMap() { const m = this.mMario.world.map; return m === 0x39 || m === 0x2C || m === 0x10; }
    /** TWaterGun::movement (CUE_MOVE) */
    movement() {
        if (!this.isEmitting()) { this.unk1CC2 = 0; this.unk1CC4 = 0; }
        const W = this.mWatergunParams;
        this.mHoverAngleL = fma(fr(this.unk1CC2 - this.mHoverAngleL), W.mHoverSmooth, this.mHoverAngleL);
        this.mHoverAngleR = fma(fr(this.unk1CC4 - this.mHoverAngleR), W.mHoverSmooth, this.mHoverAngleR);
        // rotateProp(unk378), and the same again (the game does both)
        this.rotateProp(this.getCurrentNozzle().unk378);
        this.rotateProp(this.mNozzleList[this.mCurrentNozzle].unk378);
        if (this.mCurrentNozzle === NOZZLE.Yoshi) this.mCurrentWater = this.getCurrentNozzle().P.mAmountMax;
        if (this.isDivingMap()) this.mCurrentWater = this.getCurrentNozzle().P.mAmountMax;
        if (this.mCurrentNozzle === NOZZLE.Yoshi) this.unk1CEC = 0;
        // the nozzle switch: the nozzle changes halfway
        if (this.mSwitchToSecondNozzleSpeed !== 0) {
            const before = this.mSwitchToSecondNozzleProgress, after = fr(before + this.mSwitchToSecondNozzleSpeed);
            this.mSwitchToSecondNozzleProgress = after;
            if (before < 0.5 && 0.5 <= after) this.changeNozzle(this.mSecondNozzle, false);
            if (after < 0.5 && 0.5 <= before) this.changeNozzle(NOZZLE.Spray, false);
            if (this.mSwitchToSecondNozzleProgress < 0) { this.mSwitchToSecondNozzleProgress = 0; this.mSwitchToSecondNozzleSpeed = 0; }
            if (1 < this.mSwitchToSecondNozzleProgress) { this.mSwitchToSecondNozzleProgress = 1; this.mSwitchToSecondNozzleSpeed = 0; }
        }
        this.getCurrentNozzle().animation(this.mCurrentNozzle);
    }
    /** setBaseTRMtx: the body on Mario's chest, tilted by how upright the chest is */
    setBaseTRMtx(m: Mtx) {
        let up = m[4];
        if (up < 0) up = -up;
        const a = s16(Math.trunc(fma(up, this.unk1D04 - this.unk1D06, this.unk1D06)));
        const r = mtx(); MsMtxSetRotRPH(r, 0, 0, fr(a * S2D));
        const out = this.mFluddModel.baseTR;
        for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) {
            let v = m[i * 4] * r[j] + m[i * 4 + 1] * r[4 + j] + m[i * 4 + 2] * r[8 + j];
            if (j === 3) v += m[i * 4 + 3];
            out[i * 4 + j] = fr(v);
        }
    }
    /** TMario::getPumpFrame: the upper body's frame */
    private pumpFrame() { const f = this.mMario.mModel.fc[1]; return f ? f.frame : 0; }
    /** calcAnimation (CUE_CALC_ANIM): the body's pump / house pose */
    calcAnimation() {
        const M = this.mMario, B = this.mFluddModel, c = B.getFrameCtrl();
        const st = (M.mUpperState & 0x8000) !== 0 ? 0 : M.mUpperState;
        if (st === 0 || st === 1) {   // UPPER_STATE_PUMPING, UPPER_STATE_HOLDING_PUMP
            if (this.unk1CEC === 0) {
                if (M.isFencing()) B.setBck('wg_fepmp');
                else if (M.checkFlag(MF.IN_SHALLOW_WATER | MF.IN_WATER)) B.setBck('wg_swpmp');
                else if (M.mAnimationId === 0x33) B.setBck('wg_hgpmp');   // ANIM_HANG
                else B.setBck('wg_pump');
                c.rate = 0;
                c.frame = this.pumpFrame();
                this.unk1CFA = this.unk1CF8;
            } else {
                B.setBck('wg_house');
                if (this.unk1CEC > 0) { this.unk1CEC = fr(this.unk1CEC - fr(0.1)); if (this.unk1CEC <= 0) this.unk1CEC = 0; }
                c.rate = 0;
                c.frame = fr(this.unk1CEC * c.end);
            }
        } else if (this.unk1CFA === 0) {
            if (this.unk1CEC < 1) this.unk1CEC = fr(this.unk1CEC + this.unk1CF4);
            else this.unk1CEC = 1;
            B.setBck('wg_house');
            c.rate = 0;
            c.frame = fr(this.unk1CEC * c.end);
        } else this.unk1CFA = (this.unk1CFA - 1) & 0xFFFF;
    }
    /** TWaterGun::perform */
    perform(cue: number) {
        if (cue & CUE_MOVE) {
            if (this.mFlags & TWaterGun.FLAG_UNK10) this.mCurrentWater = 0;
            this.movement();
        }
        if (cue & CUE_CALC_ANIM) this.calcAnimation();
        this.mFluddModel.perform(cue);
        if (cue & CUE_CALC_ANIM) {
            const A = this.getCurrentNozzle().mMActor, N = this.mFluddModel.getAnmMtx(this.unk1CD8);
            if (A && N) A.baseTR.set(N);
            // (the nozzle's own matrices are last tick's here: it calculates below)
            for (let i = 0; i < NOZZLE_BMD[this.mCurrentNozzle].emitters; i++) {
                const e = this.getEmitMtx(i);
                if (e) this.mEmitPos[i].set(e[3], e[7], e[11]);
            }
        }
        const A = this.getCurrentNozzle().mMActor;
        if (A) A.perform(cue);
        if (cue & CUE_MOVE) this.record();
    }
    /** MarioMain's calc anim part: setBaseTRMtx(his chest's anm matrix), then perform(CUE_CALC_ANIM) */
    calcAnimFromMario() {
        const c = this.marioChestMtx();
        if (c) this.setBaseTRMtx(c);
        this.perform(CUE_CALC_ANIM);
    }
    /** setAmountToRate: the tank at a fill rate (Yoshi's always full) */
    setAmountToRate(rate: number) {
        if (this.mCurrentNozzle === NOZZLE.Yoshi) this.mCurrentWater = this.getCurrentNozzle().P.mAmountMax;
        else this.mCurrentWater = Math.trunc(fr(rate * this.getCurrentNozzle().P.mAmountMax));
    }
    isPressureOn() { const n = this.getCurrentNozzle(); return n.getNozzleKind() === 1 && (n as TNozzleTrigger).mInsidePressure > 0; }
    getPressure() { const n = this.getCurrentNozzle(); return n.getNozzleKind() === 1 ? (n as TNozzleTrigger).mInsidePressure : 0; }
    getPressureMax() { const n = this.getCurrentNozzle(); return n.getNozzleKind() === 1 ? n.P.mInsidePressureMax : 0; }
    /** getEmitPosDirSpeed: the emit point (last calc anim's), the muzzle's x axis, Mario's drift / 8 */
    getEmitPosDirSpeed(i: number) {
        const e = this.getEmitMtx(i), p = this.mEmitPos[i] || this.mEmitPos[0];
        const pos = [p.x, p.y, p.z];
        const dir = e ? [e[0], e[4], e[8]] : [0, 0, 1];
        const M = this.mMario;
        const speed = [fr(0.125 * M.mVel.x), 0, fr(0.125 * M.mVel.z)];
        return { pos, dir, speed };
    }
    /** triggerPressureMovement: R's pressure, the nozzle's movement, the falling peak */
    triggerPressureMovement(C: ControllerWork) {
        this.mCurrentPressure = Math.trunc(fr(C.mAnalogR * 150)) & 0xFF;
        this.getCurrentNozzle().movement(C);
        if (this.mCurrentPressure > this.mPreviousPressure) this.mPreviousPressure = this.mCurrentPressure;
        else if (this.mPreviousPressure !== 0) this.mPreviousPressure = (this.mPreviousPressure - 1) & 0xFF;
        else this.mPreviousPressure = 0;
    }
    /** TWaterGun::emit: not with the muzzle under the water surface (bar the diving helmet), nor housed; each emitter's emit */
    emit() {
        const M = this.mMario;
        if (!M.checkFlag(MF.HELMET_FLW_CAMERA) && M.checkFlag(MF.IN_SHALLOW_WATER | MF.IN_WATER)) {
            const e = this.getEmitMtx(0);
            if (e && e[7] < fr(20 + M.mFloorPosition.z)) return;
        }
        if (!M.onYoshi() && this.unk1CEC > 0) return;
        if (this.hasFlag(TWaterGun.FLAG_UNK4)) { this.offFlag(TWaterGun.FLAG_UNK4); return; }
        const t = this.mCurrentNozzle, n = this.mNozzleList[t];
        for (let i = 0; i < NOZZLE_BMD[t].emitters; i++) n.emit(i);
        // (the nozzle sounds)
    }
    /** suck: R in water fills the tank (mCurrentPressure x mSuckRate a tick) */
    suck() {
        if (this.mCurrentNozzle === NOZZLE.Yoshi) return false;
        const r = this.getSuckRate();
        if (r > 0) {
            this.mCurrentWater = (this.mCurrentWater + r) | 0;
            const max = this.getCurrentNozzle().P.mAmountMax;
            if (this.mCurrentWater > max) this.mCurrentWater = max;
            // (MSD_SE_PO_SUCK_WATER_B while not full)
            return true;
        }
        return false;
    }
    /** damage: a hit spills mDamageLoss */
    damage() {
        if (!this.hasWater()) return false;
        this.mCurrentWater = (this.mCurrentWater - this.getCurrentNozzle().P.mDamageLoss) | 0;
        if (this.mCurrentWater < 0) this.mCurrentWater = 0;
        return true;
    }
    /** changeBackup (X): start switching to the second nozzle, or back to the spray */
    changeBackup() {
        if (this.mSwitchToSecondNozzleProgress === 0) this.mSwitchToSecondNozzleSpeed = this.mWatergunParams.mChangeSpeed;
        if (this.mSwitchToSecondNozzleProgress === 1) this.mSwitchToSecondNozzleSpeed = fr(-this.mWatergunParams.mChangeSpeed);
    }

    // ---- for the HUD and the viewer
    /** the tank's fill rate (0..1), as TGCConsole2 shows it */
    fillRate() { const m = this.getMaxWater(); return m > 0 ? Math.max(0, Math.min(1, this.mCurrentWater / m)) : 0; }
    private record() {
        const M = this.mMario;
        if (!M.isMario()) return;
        const w = M.world;
        const log = w.waterGunLog || (w.waterGunLog = []);
        const r: WaterGunRecord = { t: w.tickCount, water: this.mCurrentWater, max: this.getMaxWater(), nozzle: this.mCurrentNozzle, fludd: M.checkFlag(MF.HAS_FLUDD) };
        const l = log.length ? log[log.length - 1] : null;
        if (l && l.t > r.t) log.length = 0;   // (the stage restarted)
        const p = log.length ? log[log.length - 1] : null;
        if (!p || p.water !== r.water || p.max !== r.max || p.nozzle !== r.nozzle || p.fludd !== r.fludd) log.push(r);
    }
    /**
     * What the viewer draws FLUDD with: the body's BCK and frame and its base matrix, the current
     * nozzle's model, BCK and frame, its base (the body's nozzle_center), the joint angles the
     * callbacks apply (gun angle on the spray's chn_muzzle_1 / turbo's neck when negative, the
     * hover nozzles' L / R, the turbo's propeller), and the emit points.
     */
    drawState() {
        const n = this.getCurrentNozzle(), A = n.mMActor, B = this.mFluddModel;
        return {
            nozzle: this.mCurrentNozzle, secondNozzle: this.mSecondNozzle, nozzleModel: NOZZLE_BMD[this.mCurrentNozzle].bmd,
            body: { bck: B.bckName(), frame: B.fc.frame, baseTR: B.baseTR, anm: B.anm },
            nozzleAnm: A ? { bck: A.bckName(), frame: A.fc.frame, baseTR: A.baseTR, anm: A.anm } : null,
            gunAngle: n.getGunAngle(), hoverAngleL: this.getHoverAngleL(), hoverAngleR: this.getHoverAngleR(), propellerAngle: this.mPropellerAngle,
            housed: this.unk1CEC, switchProgress: this.mSwitchToSecondNozzleProgress,
            emitting: this.isEmitting(), emitted: this.mEmittedWaterCount, emitPos: this.mEmitPos.slice(0, NOZZLE_BMD[this.mCurrentNozzle].emitters).map((v) => v.clone()),
            water: this.mCurrentWater, max: this.getMaxWater(), pressure: this.getPressure(), pressureMax: this.getPressureMax(),
        };
    }
}
export { TWaterGun as WaterGun };

// ---------------------------------------------------------------- TMario::gunExec (Player/MarioMove.cpp)
/** The TMario part gunExec reads besides WaterGunMario. */
export interface GunExecMario extends WaterGunMario {
    mWaterGun: TWaterGun | null;
    unk108: ControllerWork; unk114: number; mFlag: number;
    mGroundPlane: { bgType: number };
    mGraffitoParams: { mFootEraseTimes: number; mFootEraseSize: number; mFootEraseFront: number };
    onFlag(f: number): void; offFlag(f: number): void;
}
/**
 * TMario::gunExec: R's pressure into the nozzle, sucking water in water (and the pool's level),
 * the emit while pumping, the tank refilled by unk114 0x80, X's nozzle switch (xHit: the pad's
 * MEANING_X this frame), and the spray cleaning the goop in front of his feet.
 */
export function marioGunExec(m: GunExecMario, xHit: boolean) {
    const W = m.world.water;
    if (!m.onYoshi() && W) W.juice = 0;
    if (!m.checkFlag(MF.HAS_FLUDD) && !m.onYoshi()) return;
    const G = m.mWaterGun;
    if (!G) return;
    G.updateUnk1C88(0);
    G.triggerPressureMovement(m.unk108);
    m.offFlag(MF.UNK_80);
    if (m.checkFlag(MF.IN_ANY_WATER)) {
        if (!m.onYoshi() && G.suck()) {
            m.onFlag(MF.UNK_80);
            const t = m.mGroundPlane.bgType;
            if (m.checkFlag(MF.IN_SHALLOW_WATER) && (t === 0x104 || t === 0x105 || t === 0x4104)) { /* gpPoolManager->subWaterLevel: no pools in the sim */ }
        }
        if (G.mCurrentWater === G.getMaxWater() && m.mUpperState === 0) { G.emit(); G.resetWaterToFull(); }
    } else if (m.mUpperState === 0) G.emit();
    if (m.onYoshi() && m.unk108.mAnalogR > 0) G.emit();
    if (m.unk114 & 0x80) G.resetWaterToFull();
    if (m.mStatus !== S.BACK_JUMP && m.mStatus !== S.THROWN_DOWN && xHit && !m.onYoshi() && m.mStatus !== S.TOROCCO) G.changeBackup();
    if (G.mCurrentNozzle === NOZZLE.Spray && G.mEmittedWaterCount !== 0) {
        const pol = m.world.pollution;
        const fx = JMASSin(m.mFaceAngle.y), fz = JMASCos(m.mFaceAngle.y), Gp = m.mGraffitoParams;
        for (let i = 0; i < Gp.mFootEraseTimes; i++) {
            const x = fr(m.pos.x + fr(fx * Gp.mFootEraseFront)), y = fr(m.pos.y + 0), z = fr(m.pos.z + fr(fz * Gp.mFootEraseFront));
            if (pol) pol.clean(x, y, z, Gp.mFootEraseSize, m.world.map);
        }
    }
}

// ---------------------------------------------------------------- the HUD's view of the tank
/** The player's tank after a movement tick (TWaterGun::perform CUE_MOVE), logged when it changes. */
export interface WaterGunRecord { t: number; water: number; max: number; nozzle: number; fludd: boolean; }
declare module '../engine.js' { interface World { waterGunLog: WaterGunRecord[] | null; } }
World.prototype.waterGunLog = null;
/** The player's water gun at tick t (World.tickCount), or null when the sim has no player water gun. */
export function waterGunStateAt(w: World | null, t: number): WaterGunRecord | null {
    const L = w && w.waterGunLog;
    if (!L || !L.length || L[0].t > t) return null;
    let lo = 0, hi = L.length - 1;
    while (lo < hi) { const k = (lo + hi + 1) >> 1; if (L[k].t <= t) lo = k; else hi = k - 1; }
    return L[lo];
}
