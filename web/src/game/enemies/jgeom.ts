// JGeometry helpers the ported enemies use that math.ts doesn't have (TQuat4::rotate / setEuler*,
// TVec3::setLength, TRotation3::getQuat, SMS_Eular2Quat, CLBChaseGeneralConstantSpecifySpeed).

import { fr, V3, Quat, Mtx, jgInvSqrt } from '../math.js';
import { vSq, jgSqrt } from '../vecops.js';

/** TUtil<f32>::epsilon (2^-18), the threshold TVec3::setLength/normalize/isZero use */
const EPS = 3.814697265625e-6;

/** TVec3::setLength (0x801251d0): scale by len * inv_sqrt(squared()) (frsqrte + one Newton
 * step); zero when squared() is at most TUtil<f32>::epsilon. Confirmed against the disassembly. */
export function setLength(v: V3, len: number) {
    const l = vSq(v);
    if (l <= EPS) return v.zero();
    return v.scale(fr(len * jgInvSqrt(l)));
}
/** TVec3::normalize (JGeometry's: zero when nearly zero) */
export const jNormalize = (v: V3) => setLength(v, 1);
/** TVec3::isZero */
export const isZero = (v: V3) => vSq(v) <= EPS;

/** TQuat4::rotate(v, dest): q v q* (q assumed unit). */
export function qRotate(q: Quat, v: V3, out = new V3()) {
    const x = q.y * v.z - q.z * v.y + q.w * v.x;
    const y = -q.x * v.z + q.z * v.x + q.w * v.y;
    const z = q.x * v.y - q.y * v.x + q.w * v.z;
    const w = -q.x * v.x - q.y * v.y - q.z * v.z;
    return out.set(
        fr(x * q.w + y * -q.z - z * -q.y + w * -q.x),
        fr(-x * -q.z + y * q.w + z * -q.x + w * -q.y),
        fr(x * -q.y - y * -q.x + z * q.w + w * -q.z));
}
export const qEulerX = (a: number) => new Quat(fr(Math.sin(0.5 * a)), 0, 0, fr(Math.cos(0.5 * a)));
export const qEulerY = (a: number) => new Quat(0, fr(Math.sin(0.5 * a)), 0, fr(Math.cos(0.5 * a)));
export const qEulerZ = (a: number) => new Quat(0, 0, fr(Math.sin(0.5 * a)), fr(Math.cos(0.5 * a)));
/** TQuat4::getYDir */
export const qYDir = (q: Quat, out = new V3()) => out.set(q.x * q.y * 2 - q.w * q.z * 2, 1 - q.x * q.x * 2 - q.z * q.z * 2, q.y * q.z * 2 + q.w * q.x * 2);

const DEG = 0.017453294;
/** SMS_Eular2Quat (Animal/AnimalBase.cpp): qy * (qx * qz) */
export function eulerToQuat(r: V3) {
    const qz = qEulerZ(DEG * r.z), qy = qEulerY(DEG * r.y), qx = qEulerX(DEG * r.x);
    return new Quat().mul(qy, new Quat().mul(qx, qz));
}

/** TRotation3::getQuat (m: 3x4 row-major) */
export function mtxToQuat(m: Mtx, q = new Quat()) {
    const a = (r: number, c: number) => m[r * 4 + c];
    if (a(0, 0) + a(1, 1) + a(2, 2) >= 0) {
        const s = jgSqrt(a(0, 0) + a(1, 1) + a(2, 2) + 1);
        return q.set4(0.5 / s * (a(2, 1) - a(1, 2)), 0.5 / s * (a(0, 2) - a(2, 0)), 0.5 / s * (a(1, 0) - a(0, 1)), 0.5 * s);
    }
    const mx = Math.max(Math.max(a(0, 0), a(1, 1)), a(2, 2));
    if (mx === a(0, 0)) {
        const s = jgSqrt(a(0, 0) - (a(1, 1) + a(2, 2)) + 1);
        return q.set4(0.5 * s, 0.5 / s * (a(0, 1) + a(1, 0)), 0.5 / s * (a(2, 0) + a(0, 2)), 0.5 / s * (a(2, 1) - a(1, 2)));
    }
    if (mx === a(1, 1)) {
        const s = jgSqrt(a(1, 1) - (a(2, 2) + a(0, 0)) + 1);
        return q.set4(0.5 / s * (a(0, 1) + a(1, 0)), 0.5 * s, 0.5 / s * (a(1, 2) + a(2, 1)), 0.5 / s * (a(0, 2) - a(2, 0)));
    }
    const s = jgSqrt(a(2, 2) - (a(0, 0) + a(1, 1)) + 1);
    return q.set4(0.5 / s * (a(2, 0) + a(0, 2)), 0.5 / s * (a(1, 2) + a(2, 1)), 0.5 * s, 0.5 / s * (a(1, 0) - a(0, 1)));
}

/** CLBChaseGeneralConstantSpecifySpeed: returns the new value. */
export function chase(value: number, desired: number, speed: number) {
    let d = desired - value;
    if (speed < 0) speed = -speed;
    if (d > 0) { d -= speed; return d > 0 ? desired - d : desired; }
    d += speed;
    return d < 0 ? desired - d : desired;
}

/**
 * JSUMemoryInputStream past its end: a read there fails without touching the variable it reads
 * into (so TSmallEnemy's mCoinId keeps its -1, a string comes out empty). Some placements' data
 * ends early (Kukku has no coin id, Kazekun no graph or coin id); Stream throws there.
 */
export function tolerantStream<T extends object>(s: T): T {
    return new Proxy(s, {
        get(o: any, k) {
            const f = o[k];
            if (typeof f !== 'function') return f;
            return (...a: any[]) => {
                try { return f.apply(o, a); } catch (e) {
                    if (!(e instanceof RangeError)) throw e;
                    return k === 'str' ? '' : -1;
                }
            };
        },
    });
}
