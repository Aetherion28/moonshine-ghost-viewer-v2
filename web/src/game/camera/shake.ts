// TCameraShake (gpCameraShake, Camera/camerashake.cpp) and TCamSaveShake (Camera/camerasave.cpp),
// the shake files TCameraShake::mCamShakeNameSave (Camera/CamShakeDefine.cpp). CPolarSubCamera's
// constructor makes it (cameragc.cpp); its calcFinalPosAndAt_ runs execShake on the eye / look-at /
// up. Floats round as JP 0x8035BCE0 (execShake), 0x8035C4BC (startShake) and 0x8035C238 (keepShake).

import { fr, s16, JMASSin, jgInvSqrt } from '../math.js';
import { fmadd as FMA } from '../player/fmath.js';
import { Files, PSchema, readParams } from '../engine.js';
import { V3 } from '../math.js';
import { Vec, crossToPolar, polarToCross, setRotate33 } from './lib.js';

/** TCameraShake::mCamShakeNameSave, by EnumCamShakeMode */
export const CAM_SHAKE_FILES = [
    'shakeHipDrop', 'shakeWallJump', 'shakeDamage', 'shakeEnemy', 'shakeEnemy2', 'shakeBuildingAppear', 'shakeKiller', 'shakeTamanoko',
    'shakeBohaSandCrash', 'shakeBohaSlip', 'shakeBohaStep', 'shakeBohaRun', 'shakeBohaGetup', 'shakeSandBombAppear', 'shakeBopaDown',
    'shakeBopaPopo', 'shakeBopaGetup', 'shakeBopaDownLoop', 'shakeBogeBeakHit', 'shakeBogeTumble', 'shakeBogeLand', 'shakeBogeTeHit',
    'shakeBowaLand1', 'shakeBowaLand2', 'shakeBEelRoll', 'shakeBEelOut', 'shakeBEelHanukeIn', 'shakeBEelSuckOpen', 'shakeBEelSuckLoop',
    'shakeBEelSuckClose', 'shakeBEelDie', 'shakeBTelesaDamage', 'shakeBTelesaHit', 'shakeBTelesaDown', 'shakeBTelesaAppear',
    'shakeBTelesaRoll', 'shakeCannonDemo', 'shakeBathtubGripBreaking', 'shakeBathtubGripBreaking2', 'shakeKoopaHipdrop', 'shakeBathtubKiller',
].map((n) => `/Camera/${n}.prm`);

/** TCamSaveShake (its PARAM_INIT list) */
export const CAM_SAVE_SHAKE = {
    mShakeTime: ['s16', 40], mShakeAmpX: ['f', 500.0], mShakeVelX: ['s16', 5000], mShakeAmpY: ['f', 0.0], mShakeVelY: ['s16', 0],
    mShakeAmpZ: ['f', 0.0], mShakeVelZ: ['s16', 0],
} satisfies PSchema;
export type CamSaveShake = { [K in keyof typeof CAM_SAVE_SHAKE]: number };

/** TCameraShake::TCamShakeAngle */
class CamShakeAngle { mAmp = 0; mDec = 0; mVel = 0; }

/** TCameraShake::TCamShakeInfo */
class CamShakeInfo {
    mMode = 1; mIsKeep = 0; mIsDecreasing = 0; mDuration = 0; mFrame = 0;
    mAngleX = new CamShakeAngle(); mAngleY = new CamShakeAngle(); mAngleZ = new CamShakeAngle();
    isActive() { return this.mDuration !== 0; }
    reset() {
        this.mMode = 1; this.mIsKeep = 0; this.mIsDecreasing = 0; this.mFrame = 0; this.mDuration = 0;
        for (const a of [this.mAngleX, this.mAngleY, this.mAngleZ]) { a.mDec = 0; a.mAmp = 0; a.mVel = 0; }
    }
}

export class CameraShake {
    mRollAccum = 0;
    mShakeInfo: CamShakeInfo[] = [];
    mShakeData: CamSaveShake[];

    constructor(files: Files) {
        this.mShakeData = CAM_SHAKE_FILES.map((p) => {
            const o: any = readParams(p, files, CAM_SAVE_SHAKE);
            o.mShakeAmpX = fr(o.mShakeAmpX); o.mShakeAmpY = fr(o.mShakeAmpY); o.mShakeAmpZ = fr(o.mShakeAmpZ);
            return o as CamSaveShake;
        });
        for (let i = 0; i < 32; i++) { const s = new CamShakeInfo(); s.reset(); this.mShakeInfo.push(s); }
    }

    private getUseShakeData_() {
        for (const s of this.mShakeInfo) if (!s.isActive()) return s;
        let best = this.mShakeInfo[0], minRemaining = 0xFFFF;
        for (const s of this.mShakeInfo) {
            if (s.mIsDecreasing !== 0) {
                const remaining = (s.mDuration - s.mFrame) & 0xFFFF;
                if (remaining < minRemaining) { minRemaining = remaining; best = s; }
            }
        }
        return best;
    }

    private setShakeAngleOne_(angle: CamShakeAngle, amp: number, vel: number, duration: number, scale: number) {
        amp = fr(amp * scale);
        if (scale < 0) { amp = -amp; vel = s16(-vel); }
        angle.mAmp = amp;
        angle.mDec = fr(amp * fr(1 / duration));
        angle.mVel = vel;
    }

    private setShakeAngleAll_(info: CamShakeInfo, save: CamSaveShake, duration: number, scale: number) {
        this.setShakeAngleOne_(info.mAngleX, save.mShakeAmpX, save.mShakeVelX, duration, scale);
        this.setShakeAngleOne_(info.mAngleY, save.mShakeAmpY, save.mShakeVelY, duration, scale);
        this.setShakeAngleOne_(info.mAngleZ, save.mShakeAmpZ, save.mShakeVelZ, duration, scale);
    }

    startShake(mode: number, scale: number) {
        const save = this.mShakeData[mode];
        const duration = save.mShakeTime & 0xFFFF;
        if (duration !== 0) {
            const info = this.getUseShakeData_();
            info.mMode = mode; info.mIsKeep = 0; info.mIsDecreasing = 0; info.mDuration = duration; info.mFrame = 0;
            this.setShakeAngleAll_(info, save, duration, fr(scale));
        }
    }

    keepShake(mode: number, scale: number) {
        const save = this.mShakeData[mode];
        const duration = save.mShakeTime & 0xFFFF;
        if (duration !== 0) {
            for (const it of this.mShakeInfo) if (it.mMode === mode && it.mIsDecreasing === 0) { it.mIsKeep = 1; return; }
            const info = this.getUseShakeData_();
            info.mMode = mode; info.mIsKeep = 1; info.mIsDecreasing = 0; info.mDuration = duration; info.mFrame = 0;
            this.setShakeAngleAll_(info, save, duration, fr(scale));
        }
    }

    execShake(origin: Vec, pos: Vec, up: Vec) {
        const ox = pos.x, oy = pos.y, oz = pos.z;
        this.mRollAccum = 0;
        if (this.mShakeInfo.some((s) => s.isActive())) {
            const p = crossToPolar(origin, pos);
            let vAngle = p.pitch, hAngle = p.yaw;
            for (const it of this.mShakeInfo) {
                if (!it.isActive()) continue;
                vAngle = s16(vAngle + s16(Math.trunc(fr(it.mAngleX.mAmp * JMASSin(s16(it.mAngleX.mVel * it.mFrame))))));
                hAngle = s16(hAngle + s16(Math.trunc(fr(it.mAngleY.mAmp * JMASSin(s16(it.mAngleY.mVel * it.mFrame))))));
                this.mRollAccum = s16(this.mRollAccum + s16(Math.trunc(fr(it.mAngleZ.mAmp * JMASSin(s16(it.mAngleZ.mVel * it.mFrame))))));
                it.mFrame = (it.mFrame + 1) & 0xFFFF;
                let finished = false;
                if (it.mIsKeep !== 0) {
                    it.mDuration = (it.mDuration + 1) & 0xFFFF;
                    it.mIsKeep = 0;
                } else {
                    it.mIsDecreasing = 1;
                    it.mAngleX.mAmp = fr(it.mAngleX.mAmp - it.mAngleX.mDec);
                    it.mAngleY.mAmp = fr(it.mAngleY.mAmp - it.mAngleY.mDec);
                    it.mAngleZ.mAmp = fr(it.mAngleZ.mAmp - it.mAngleZ.mDec);
                    if (it.mFrame >= it.mDuration) finished = true;
                }
                if (finished) it.reset();
            }
            polarToCross(origin, pos, p.r, vAngle, hAngle);
        }
        // unitVecTo: TVec3::normalize with TVec3::dot (fmadds) as the squared length
        const dir = new V3(fr(ox - origin.x), fr(oy - origin.y), fr(oz - origin.z));
        const sq = FMA(dir.z, dir.z, FMA(dir.x, dir.x, fr(dir.y * dir.y)));
        if (sq <= fr(3.8146973e-6)) dir.set(0, 0, 0);
        else {
            const k = jgInvSqrtLocal(sq);
            dir.set(fr(dir.x * k), fr(dir.y * k), fr(dir.z * k));
        }
        const m = setRotate33(dir, -fr(fr(0.017453294) * fr(fr(0.005493164) * this.mRollAccum)));
        const ux = up.x, uy = up.y, uz = up.z;
        up.x = FMA(uz, m[6], FMA(ux, m[0], fr(uy * m[3])));
        up.y = FMA(uz, m[7], FMA(ux, m[1], fr(uy * m[4])));
        up.z = FMA(uz, m[8], FMA(ux, m[2], fr(uy * m[5])));
    }
}

/** JGeometry::TUtil<f32>::inv_sqrt, times 1.0f (the fmuls after it) */
const jgInvSqrtLocal = (x: number) => fr(1 * jgInvSqrt(x));
