// Camera/cameralib.cpp and include/Camera/cameralib.hpp (CLB*), f32-exact: every float operation
// rounds where the compiled code rounds it (checked against the DOL's instructions: fmadds /
// fnmsubs are one rounding of a*b+c, fmuls + fadds two), s16 angles wrap like the halfwords they
// are stored in, and the Gekko's estimates (fres in matan, frsqrte in MsSqrtf / MsVECNormalize)
// are the hardware's (math.ts).

import { fmadd as FMA, fnmsub as FNMS, fmsub as FMS } from '../player/fmath.js';
import { fr, s16, matan, JMASSin, JMASCos, frsqrte, MsSqrtfHW, jgNormalize } from '../math.js';

/** A TVec3<f32> / Vec */
export interface Vec { x: number; y: number; z: number; }
export const vec = (x = 0, y = 0, z = 0): Vec => ({ x, y, z });
export const vcopy = (v: Vec): Vec => ({ x: v.x, y: v.y, z: v.z });
export const vset = (d: Vec, s: Vec) => { d.x = s.x; d.y = s.y; d.z = s.z; return d; };
export const vadd = (d: Vec, s: Vec) => { d.x = fr(d.x + s.x); d.y = fr(d.y + s.y); d.z = fr(d.z + s.z); return d; };
export const veq = (a: Vec, b: Vec) => a.x === b.x && a.y === b.y && a.z === b.z;

export const CLBConstUpVec: Readonly<Vec> = { x: 0, y: 1, z: 0 };
export const MsSqrtf = MsSqrtfHW;

/** CLBRoundf<s16>: fadds of +-0.5, fctiwz, the halfword. */
export const CLBRoundfS16 = (v: number) => s16(fr(v + (v > 0 ? 0.5 : -0.5)));
/** CLBRoundf<int> */
export const CLBRoundfInt = (v: number) => Math.trunc(fr(v + (v > 0 ? 0.5 : -0.5))) | 0;
/** CLBDegToShortAngle: CLBRoundf<s16>(deg * 65536 / 360) */
export const CLBDegToShortAngle = (deg: number) => CLBRoundfS16(fr(deg * fr(65536 / 360)));

/** CLBLinearInbetween<f32>: fsubs, fmadds */
export const lerpF = (a: number, b: number, f: number) => FMA(f, fr(b - a), a);
/** CLBLinearInbetween<s16>: fmadds over the converted halfwords, fctiwz */
export const lerpS = (a: number, b: number, f: number) => s16(FMA(f, (b - a), a));
/** CLBCalcRatio<f32> */
export const ratioF = (a: number, b: number, c: number) => (a !== b ? fr(fr(c - a) * fr(1 / fr(b - a))) : 0);
/** CLBCalcRatio<s16> / <s32> (integer differences, converted exactly) */
export const ratioI = (a: number, b: number, c: number) => (a !== b ? fr(fr(c - a) * fr(1 / fr(b - a))) : 0);
/** CLBTwoDegreeGeneralInbetween<f32>(a, b, t, k): fadds(a, fmadds(t, k*t, t*((b-a)-k))) */
export const twoDegF = (a: number, b: number, t: number, k: number) => fr(a + FMA(t, fr(k * t), fr(t * fr(fr(b - a) - k))));
/** CLBEaseInInbetween<f32> */
export const easeInF = (a: number, b: number, t: number) => twoDegF(a, b, t, fr(b - a));
/** CLBTwoDegreeGeneralInbetween<s16> (the integers converted exactly) */
export const twoDegS = (a: number, b: number, t: number, k: number) => s16(fr(a + FMA(t, fr(k * t), fr(t * fr((b - a) - k)))));
/** CLBEaseInInbetween<s16> */
export const easeInS = (a: number, b: number, t: number) => twoDegS(a, b, t, b - a);

export const clamp = (v: number, l: number, r: number) => (v > r ? r : v < l ? l : v);

/** CLBChaseConstantSpecifyFrame<f32>: returns the new value */
export function chaseFrameF(v: number, d: number, frames: number) {
    if (frames < fr(0.001)) return d;
    return FMA(fr(1 / frames), fr(d - v), v);
}
/** CLBChaseConstantSpecifyFrame(s16*, s16, f32) */
export function chaseFrameS(v: number, d: number, frames: number) {
    if (frames < fr(0.001)) return d;
    return s16(v + CLBRoundfS16(fr(fr(1 / frames) * s16(d - v))));
}
/** CLBChaseGeneralConstantSpecifySpeed<s16>: [new value, more to go] */
export function chaseSpeedS(v: number, d: number, speed: number): [number, boolean] {
    let delta = s16(d - v);
    if (speed < 0) speed = -speed;
    if (delta > 0) { delta = s16(delta - speed); v = delta > 0 ? s16(d - delta) : s16(d); }
    else { delta = s16(delta + speed); v = delta < 0 ? s16(d - delta) : s16(d); }
    return [v, v !== s16(d)];
}
/** CLBChaseGeneralConstantSpecifySpeed<f32> */
export function chaseSpeedF(v: number, d: number, speed: number): [number, boolean] {
    let delta = fr(d - v);
    if (speed < 0) speed = -speed;
    if (delta > 0) { delta = fr(delta - speed); v = delta > 0 ? fr(d - delta) : d; }
    else { delta = fr(delta + speed); v = delta < 0 ? fr(d - delta) : d; }
    return [v, v !== d];
}
/** CLBChaseAngleDecrease: [new value, more to go] */
export function chaseAngleDecrease(v: number, d: number, ratio: number): [number, boolean] {
    if (ratio === 0) v = s16(d);
    else {
        let n = s16(v - d);
        n = s16(n - Math.trunc(n / ratio) + d);
        if (n === v) return [v, false];
        v = n;
    }
    return [v, v !== s16(d)];
}
/** CLBChaseDecrease: [new value, still outside the threshold] */
export function chaseDecrease(v: number, d: number, ratio: number, threshold = 0): [number, boolean] {
    if (ratio > 1) ratio = 1;
    v = FMA(ratio, fr(d - v), v);
    const a = fr(v - d);
    return [v, !(Math.abs(a) <= Math.abs(threshold))];
}
/** CLBChaseSpecialDecrease */
export function chaseSpecialDecrease(v: number, d: number, ratio: number, speed: number): [number, boolean] {
    if (ratio > 1) ratio = 1;
    let s = fr(ratio * fr(d - v));
    if (Math.abs(s) < Math.abs(speed)) s = speed;
    return chaseSpeedF(v, d, s);
}

/** CLBCrossToPolar(origin, in, &radius, &pitch, &yaw) */
export function crossToPolar(o: Vec, p: Vec): { r: number; pitch: number; yaw: number } {
    const dx = fr(p.x - o.x), dy = fr(p.y - o.y), dz = fr(p.z - o.z);
    const xx = fr(dx * dx), zz = fr(dz * dz);
    const r = MsSqrtf(fr(zz + FMA(dy, dy, xx)));
    const pitch = matan(MsSqrtf(fr(xx + zz)), dy);
    return { r, pitch, yaw: matan(dz, dx) };
}
/** The inline CLBCrossToPolar(origin, in, &pitch, &yaw) (an fmadds for the XZ distance, MsSqrtf called) */
export function crossToPolar2(o: Vec, p: Vec): { pitch: number; yaw: number } {
    const dx = fr(p.x - o.x), dz = fr(p.z - o.z);
    const pitch = matan(MsSqrtf(FMA(dx, dx, fr(dz * dz))), fr(p.y - o.y));
    return { pitch, yaw: matan(dz, dx) };
}
/** CLBPolarToCross */
export function polarToCross(o: Vec, out: Vec, radius: number, v: number, h: number) {
    const cv = JMASCos(v), sh = JMASSin(h), ch = JMASCos(h), sv = JMASSin(v);
    const ox = o.x, oy = o.y, oz = o.z;
    out.x = fr(ox + fr(fr(radius * cv) * sh));
    out.y = FMA(radius, sv, oy);
    out.z = fr(oz + fr(fr(radius * cv) * ch));
    return out;
}
/** CLBRevisionLookatByAngleX */
export function revisionLookatByAngleX(vMin: number, vMax: number, o: Vec, io: Vec) {
    const p = crossToPolar(o, io);
    const v = clamp(p.pitch, vMin, vMax);
    polarToCross(o, io, p.r, v, p.yaw);
}

/**
 * MsVECNormalize (paired singles): ps_mul, ps_madd, ps_sum0 for the squared length, the raw
 * frsqrte estimate (no Newton step), the products rounded with the estimate cut to 25 bits as the
 * Gekko's single multiplies take their second operand.
 */
export function msVecNormalize(v: Vec, out: Vec) {
    const xx = fr(v.x * v.x), yy = fr(v.y * v.y);
    const s = fr(FMA(v.z, v.z, xx) + yy);
    const e = force25(frsqrte(s));
    out.x = fr(v.x * e); out.y = fr(v.y * e); out.z = fr(v.z * e);
    return out;
}
/**
 * PSVECNormalize (the SDK's): the frsqrte estimate with one Newton step in singles
 * (0.5 * e * (3 - s * e * e)), zero in: NaN out as on the Gekko.
 */
export function psVecNormalize(v: Vec, out: Vec) {
    const xx = fr(v.x * v.x), yy = fr(v.y * v.y);
    const s = fr(FMA(v.z, v.z, xx) + yy);
    const e = frsqrte(s);
    const n0 = fr(e * force25(e)), n1 = fr(e * 0.5);
    const n2 = FNMS(n0, s, 3);
    const r = fr(n2 * n1);
    out.x = fr(v.x * r); out.y = fr(v.y * r); out.z = fr(v.z * r);
    return out;
}
/** PSVECMag (the SDK's): the squared length times its refined reciprocal square root; 0 for 0 */
export function psVecMag(v: Vec) {
    const s = fr(FMA(v.z, v.z, fr(v.x * v.x)) + fr(v.y * v.y));
    if (!(s > 0)) return 0;
    const e = frsqrte(s);
    const n0 = fr(e * force25(e)), n1 = fr(e * 0.5);
    const n2 = FNMS(n0, s, 3);
    const r = fr(n2 * n1);
    return fr(s * r);
}
const f64 = new Float64Array(1), i64 = new BigUint64Array(f64.buffer);
/** Dolphin's Force25Bit: the multiplier's mantissa rounded to 24 fraction bits */
export function force25(d: number) { f64[0] = d; const b = i64[0]; i64[0] = (b & 0xFFFFFFFFF8000000n) + (b & 0x8000000n); return f64[0]; }

/** TVec3<f32>::normalize (JGeometry::TUtil<f32>::inv_sqrt: frsqrte + one Newton step, zero-guarded
 * at epsilon() = 2^-18, not 1/Math.sqrt with a l2 <= 0 guard) as the camera uses it for unk25C. */
export function vnormalize(v: Vec) {
    return jgNormalize(v);
}

/** CLBIsPointInCube (the decomp's order; mapwire.ts's isPointInCube is the same code) */
export function isPointInCube(p: Vec, c: Vec, r: Vec, s: Vec) {
    let dx = fr(p.x - c.x), dy = fr(p.y - c.y), dz = fr(p.z - c.z);
    if (r.y !== 0 || r.x !== 0 || r.z !== 0) {
        if (r.z !== 0) {
            const a = CLBDegToShortAngle(-r.z), cz = JMASCos(a), sz = JMASSin(a);
            const t = fr(dy * sz);
            dy = FMA(dx, sz, fr(dy * cz)); dx = FMS(dx, cz, t);
        }
        if (r.y !== 0) {
            const a = CLBDegToShortAngle(-r.y), cy = JMASCos(a), sy = JMASSin(a);
            const t = fr(dz * sy);
            dz = FMA(-dx, sy, fr(dz * cy)); dx = FMA(dx, cy, t);
        }
        if (r.x !== 0) {
            const a = CLBDegToShortAngle(-r.x), cx = JMASCos(a), sx = JMASSin(a);
            const t = fr(dz * sx);
            dz = FMA(dy, sx, fr(dz * cx)); dy = FMS(dy, cx, t);
        }
    }
    return fr(-s.x * 0.5) < dx && dx < fr(s.x * 0.5) && 0 < dy && dy < s.y && fr(-s.z * 0.5) < dz && dz < fr(s.z * 0.5);
}
