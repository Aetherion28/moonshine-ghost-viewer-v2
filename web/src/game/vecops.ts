// The game's vector maths as it compiles (all singles), for code ported from the binary:
// JGeometry::TVec3<f32>::dot / squared as fmuls then fmadds (y first), cross as fmuls then fmsubs,
// VECNormalize / VECMag the SDK's paired-single PSVECNormalize / PSVECMag (frsqrte and one Newton
// step), MsVECNormalize / MsVECMag2 the raw frsqrte estimate.
import { fr, V3, frsqrte, JMASSin, JMASCos } from './math.js';
import { fmadd as FMA, fmsub as FMS, fnmsub as FNMS } from './player/fmath.js';
import { psVecNormalize, psVecMag, msVecNormalize, force25 } from './camera/lib.js';

/** VECNormalize (PSVECNormalize) in place */
export const vNorm = (v: V3) => psVecNormalize(v, v) as V3;
/** VECMag (PSVECMag) */
export const vMag = (v: V3) => psVecMag(v);
/** MsVECNormalize in place */
export const vNormMs = (v: V3) => msVecNormalize(v, v) as V3;
/** TVec3::squared as fmuls, fadds: (x² + y²) + z² */
export const vSq = (v: V3) => fr(fr(fr(v.x * v.x) + fr(v.y * v.y)) + fr(v.z * v.z));
/** a dot product as fmuls y·y, then fmadds x and z */
export const vDot = (a: V3, b: V3) => FMA(a.z, b.z, FMA(a.x, b.x, fr(a.y * b.y)));
/** TVec3::cross(a, b) into out (fmuls, fmsubs) */
export function vCross(out: V3, a: V3, b: V3) {
    const x = FMS(a.y, b.z, fr(a.z * b.y)), y = FMS(a.z, b.x, fr(a.x * b.z)), z = FMS(a.x, b.y, fr(a.y * b.x));
    out.x = x; out.y = y; out.z = z; return out;
}
/** MsVECMag2 (0x800c57d0, paired singles: z² + x², + y², times the raw frsqrte; 0 for 0) */
export function msVecMag2(v: V3) {
    const s = fr(FMA(v.z, v.z, fr(v.x * v.x)) + fr(v.y * v.y));
    if (!(s > 0)) return 0;
    return fr(s * force25(frsqrte(s)));
}
/** JGeometry::TUtil<f32>::sqrt (0x800d08b0): x times inv_sqrt (frsqrte to single, one Newton step); x itself for x <= 0 */
export function jgSqrt(x: number) {
    if (!(x > 0)) return x;
    const e = fr(frsqrte(x));
    return fr(x * fr(fr(0.5 * e) * FNMS(x, fr(e * e), 3)));
}
/** TVec3 length as the inline TUtil sqrt of (x² + y²) + z² */
export const vLen = (v: V3) => jgSqrt(vSq(v));
/** PSVECSquareDistance (paired singles: dx² + dy² fused, + dz²) */
export function psSqDist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
    const dx = fr(a.x - b.x), dy = fr(a.y - b.y), dz = fr(a.z - b.z);
    return fr(FMA(dx, dx, fr(dy * dy)) + fr(dz * dz));
}
/** the sine table at an angle in degrees, as the inlined fromPolar / MsSin do it: fmuls 182.04445, fctiwz */
export const sinDeg = (d: number) => JMASSin(Math.trunc(fr(fr(182.04444885253906) * d)));
export const cosDeg = (d: number) => JMASCos(Math.trunc(fr(fr(182.04444885253906) * d)));
