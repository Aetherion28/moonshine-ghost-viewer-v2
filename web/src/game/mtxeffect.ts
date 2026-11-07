// The joint matrix effects (MarioUtil/MtxUtil.cpp): TMtxEffectBase and its TMtxTimeLag (a joint
// that trails its animated position and orientation, sprung by accel / brake), TMtxSwingRZ (a
// pendulum hanging mL below the joint, swinging its X / Y axes about its Z) and
// TMtxSwingRZReverseXZ (the same, the axes negated), and TMultiMtxEffect, which hangs one on each
// of a model's bones as its J3DJoint callback (setup: "/<prm>/MtxEffect<bone>.prm"). Each calc
// runs on J3DSys::mCurrentMtx, the joint's matrix its children see (calcJoints' cb). Flag 2: the
// next calc resets from the matrix; flag 1: the result is written back.
// Rounding as the DOL: TMtxTimeLag::calc (0x800c7d80) fuses the accel steps and the quaternion
// dot (fmadds), MsSqrtf the column lengths; calcLocalXY (0x800c7ae8) is PSVEC calls.

import { fr, V3, MsSqrtfHW, type Mtx } from './math.js';
import { fmadd as FMA, fmsub as FMS } from './player/fmath.js';
import { psVecNormalize } from './camera/lib.js';
import { mtxQuat } from './j3dcalc.js';
import { Params, type Files, type PSchema } from './engine.js';

export const TMTX_EFFECT_TIME_LAG = 0, TMTX_EFFECT_SWING_RZ = 1, TMTX_EFFECT_SWING_RZ_REVERSE_XZ = 2;

/** MtxToQuat (0x800c8314) */
export function MtxToQuat(m: Mtx | number[], out: number[] = [0, 0, 0, 0]) {
    const M = (r: number, c: number) => m[r * 4 + c];
    const q = [0, 0, 0, 0];
    const s = fr(1 + fr(fr(M(0, 0) + M(1, 1)) + M(2, 2)));
    if (s >= 1) {
        const root = fr(2 * MsSqrtfHW(s));
        const inv = fr(1 / root);
        q[3] = fr(0.25 * root);
        q[0] = fr(fr(M(2, 1) - M(1, 2)) * inv);
        q[1] = fr(fr(M(0, 2) - M(2, 0)) * inv);
        q[2] = fr(fr(M(1, 0) - M(0, 1)) * inv);
    } else {
        let i = M(0, 0) > M(1, 1) ? 0 : 1;
        if (M(2, 2) > M(i, i)) i = 2;
        const j = (i + 1) % 3, k = (j + 1) % 3;
        const root = fr(2 * MsSqrtfHW(fr(1 + fr(fr(M(i, i) - M(j, j)) - M(k, k)))));
        const inv = fr(1 / root);
        q[i] = fr(0.25 * root);
        q[j] = fr(fr(M(i, j) + M(j, i)) * inv);
        q[k] = fr(fr(M(i, k) + M(k, i)) * inv);
        q[3] = fr(fr(M(k, j) - M(j, k)) * inv);
    }
    out[0] = q[0]; out[1] = q[1]; out[2] = q[2]; out[3] = q[3];
    return out;
}

/** PSVECCrossProduct (0x80094f90): its paired-single lanes */
function psVecCross(a: V3, b: V3, out: V3) {
    const x = FMS(a.y, b.z, fr(b.y * a.z));
    const y = -FMS(a.x, b.z, fr(b.x * a.z));
    const z = -FMS(a.y, b.x, fr(b.y * a.x));
    out.x = x; out.y = y; out.z = z; return out;
}

export class MtxEffectBase {
    mFlags = 0;
    getParams(): any { return null; }
    checkFlag(f: number) { return (this.mFlags & f) !== 0; }
    offFlag(f: number) { this.mFlags &= ~f; }
    onFlag(f: number) { this.mFlags |= f; }
    calc(_m: Mtx | number[]) { }
}

const TIME_LAG_PARAMS = { mPosAccel: ['f', 0], mPosBrake: ['f', 0], mPosLimit: ['f', 0], mQuatAccel: ['f', 0], mQuatBrake: ['f', 0] } satisfies PSchema;
const SWING_RZ_PARAMS = { mAcc: ['v3', [0, -4, 0]], mL: ['f', 50], mBrake: ['f', 0.7], mVelScale: ['f', 1] } satisfies PSchema;

export class MtxTimeLag extends MtxEffectBase {
    mParams: { mPosAccel: number; mPosBrake: number; mPosLimit: number; mQuatAccel: number; mQuatBrake: number };
    unk08 = new V3(); unk14 = new V3();
    unk20 = [0, 0, 0, 0]; unk30 = [0, 0, 0, 0];
    constructor(prm: string, files: Files) { super(); this.mParams = new Params(prm, files).read(TIME_LAG_PARAMS) as any; }
    getParams() { return this.mParams; }
    calc(m: Mtx | number[]) {
        if (this.checkFlag(2)) {
            this.offFlag(2);
            this.unk08.set(0, 0, 0);
            this.unk14.set(m[3], m[7], m[11]);
            this.unk20 = [0, 0, 0, 0];
            this.unk30 = MtxToQuat(m);
            return;
        }
        const P = this.mParams;
        const tx = m[3], ty = m[7], tz = m[11];
        const a = P.mPosAccel, b = P.mPosBrake;
        const v = this.unk08, p = this.unk14;
        v.x = FMA(a, fr(tx - p.x), v.x);
        v.y = FMA(a, fr(ty - p.y), v.y);
        v.z = FMA(a, fr(tz - p.z), v.z);
        v.x = fr(v.x * b); v.y = fr(v.y * b); v.z = fr(v.z * b);
        p.x = fr(p.x + v.x); p.y = fr(p.y + v.y); p.z = fr(p.z + v.z);
        const L = P.mPosLimit;
        let lo = fr(tx - L), hi = fr(tx + L);
        if (p.x < lo) p.x = lo; if (p.x > hi) p.x = hi;
        lo = fr(ty - L); hi = fr(ty + L);
        if (p.y < lo) p.y = lo; if (p.y > hi) p.y = hi;
        lo = fr(tz - L); hi = fr(tz + L);
        if (p.z < lo) p.z = lo; if (p.z > hi) p.z = hi;
        const col = (c: number) => MsSqrtfHW(fr(fr(fr(m[c] * m[c]) + fr(m[4 + c] * m[4 + c])) + fr(m[8 + c] * m[8 + c])));
        const len0 = col(0), len1 = col(1), len2 = col(2);
        const i0 = fr(1 / len0), i1 = fr(1 / len1), i2 = fr(1 / len2);
        const rot = [
            fr(m[0] * i0), fr(m[1] * i1), fr(m[2] * i2), 0,
            fr(m[4] * i0), fr(m[5] * i1), fr(m[6] * i2), 0,
            fr(m[8] * i0), fr(m[9] * i1), fr(m[10] * i2), 0,
        ];
        const nq = MtxToQuat(rot);
        const q = this.unk30, dq = this.unk20;
        const dot = FMA(q[3], nq[3], FMA(q[2], nq[2], FMA(q[0], nq[0], fr(q[1] * nq[1]))));
        if (dot < 0) for (let k = 0; k < 4; k++) nq[k] = -nq[k];
        const qa = P.mQuatAccel, qb = P.mQuatBrake;
        for (let k = 0; k < 4; k++) dq[k] = FMA(qa, fr(nq[k] - q[k]), dq[k]);
        for (let k = 0; k < 4; k++) dq[k] = fr(dq[k] * qb);
        for (let k = 0; k < 4; k++) q[k] = fr(q[k] + dq[k]);
        if (this.mFlags & 1) mtxQuat(q, m);
        if (this.mFlags & 1) {
            m[0] = fr(m[0] * len0); m[4] = fr(m[4] * len0); m[8] = fr(m[8] * len0);
            m[1] = fr(m[1] * len1); m[5] = fr(m[5] * len1); m[9] = fr(m[9] * len1);
            m[2] = fr(m[2] * len2); m[6] = fr(m[6] * len2); m[10] = fr(m[10] * len2);
            m[3] = p.x; m[7] = p.y; m[11] = p.z;
        }
    }
}

export class MtxSwingRZ extends MtxEffectBase {
    mParams: { mAcc: number[]; mL: number; mBrake: number; mVelScale: number };
    unk08 = new V3(); unk14 = new V3();
    constructor(prm: string, files: Files) { super(); this.mParams = new Params(prm, files).read(SWING_RZ_PARAMS) as any; }
    getParams() { return this.mParams; }
    calcLocalXY(m: Mtx | number[], X: V3, Y: V3) {
        const P = this.mParams;
        if (this.checkFlag(2)) {
            this.offFlag(2);
            this.unk14.set(0, 0, 0);
            this.unk08.set(m[3], fr(m[7] - P.mL), m[11]);
            X.set(m[0], m[4], m[8]);
            Y.set(m[1], m[5], m[9]);
            return;
        }
        const v = this.unk14, p = this.unk08;
        v.x = fr(v.x + P.mAcc[0]); v.y = fr(v.y + P.mAcc[1]); v.z = fr(v.z + P.mAcc[2]);
        v.x = fr(v.x * P.mBrake); v.y = fr(v.y * P.mBrake); v.z = fr(v.z * P.mBrake);
        p.x = fr(v.x + p.x); p.y = fr(v.y + p.y); p.z = fr(v.z + p.z);
        const tx = m[3], ty = m[7], tz = m[11];
        const d = new V3(fr(p.x - tx), fr(p.y - ty), fr(p.z - tz));
        psVecNormalize(d, d);
        d.x = fr(d.x * P.mL); d.y = fr(d.y * P.mL); d.z = fr(d.z * P.mL);
        const pt = new V3(fr(tx + d.x), fr(ty + d.y), fr(tz + d.z));
        v.x = fr(v.x + fr(pt.x - p.x)); v.y = fr(v.y + fr(pt.y - p.y)); v.z = fr(v.z + fr(pt.z - p.z));
        p.set(pt);
        const Z = new V3(m[2], m[6], m[10]);
        X.set(fr(p.x - tx), fr(p.y - ty), fr(p.z - tz));
        psVecNormalize(X, X);
        psVecCross(Z, X, Y);
        psVecNormalize(X, X);
        psVecNormalize(Y, Y);
        psVecCross(Y, Z, X);
    }
    calc(m: Mtx | number[]) {
        const X = new V3(), Y = new V3();
        this.calcLocalXY(m, X, Y);
        if (this.mFlags & 1) { m[0] = X.x; m[4] = X.y; m[8] = X.z; m[1] = Y.x; m[5] = Y.y; m[9] = Y.z; }
    }
}

export class MtxSwingRZReverseXZ extends MtxSwingRZ {
    calc(m: Mtx | number[]) {
        const X = new V3(), Y = new V3();
        this.calcLocalXY(m, X, Y);
        if (this.mFlags & 1) { m[0] = -X.x; m[4] = -X.y; m[8] = -X.z; m[1] = -Y.x; m[5] = -Y.y; m[9] = -Y.z; }
    }
}

export class MultiMtxEffect {
    mNumBones = 0;
    mMtxEffectType: number[] = [];
    mBoneIDs: number[] = [];
    mMtxEffectTbl: MtxEffectBase[] = [];
    /** each bone's joint callback (J3DJoint::setCallBack + setCallBackUserData) */
    callbacks = new Map<number, MtxEffectBase>();
    setup(_model: unknown, prmLocation: string, files: Files) {
        this.mMtxEffectTbl = [];
        for (let i = 0; i < this.mNumBones; ++i) {
            const path = `/${prmLocation}/MtxEffect${this.mBoneIDs[i]}.prm`;
            let e: MtxEffectBase | null = null;
            switch (this.mMtxEffectType[i]) {
                case TMTX_EFFECT_TIME_LAG: e = new MtxTimeLag(path, files); break;
                case TMTX_EFFECT_SWING_RZ: e = new MtxSwingRZ(path, files); break;
                case TMTX_EFFECT_SWING_RZ_REVERSE_XZ: e = new MtxSwingRZReverseXZ(path, files); break;
            }
            if (e) { this.callbacks.set(this.mBoneIDs[i], e); this.mMtxEffectTbl[i] = e; }
        }
        for (let i = 0; i < this.mNumBones; ++i) this.mMtxEffectTbl[i].onFlag(2);
    }
    setUserArea() { for (let i = 0; i < this.mNumBones; i++) this.callbacks.set(this.mBoneIDs[i], this.mMtxEffectTbl[i]); }
    add() { }
    remove() { }
    flagOn(f: number) { for (let i = 0; i < this.mNumBones; ++i) this.mMtxEffectTbl[i].onFlag(f); }
    flagOff(f: number) { for (let i = 0; i < this.mNumBones; ++i) this.mMtxEffectTbl[i].offFlag(f); }
    /** the joint callbacks' J3DSys::mCurrentMtx step (TMtx*CallBack with param 0): for calcJoints' cb */
    jointCallback(j: number, cur: Mtx | number[]) { const e = this.callbacks.get(j); if (e) e.calc(cur); }
}
