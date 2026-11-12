// The game's view-frustum clipping, as the DOL computes it (MarioUtil/DrawUtil.cpp):
//   SetViewFrustumClipCheckPerspective (JP 0x800C1414): tanf(fovy * pi/360) (MSL: sinf / cosf, fdivs), the near
//     plane's half height near * tan, half width that * aspect; kept while its four inputs stay the same.
//   SetViewFrustumClipCheck (JP 0x800C14BC): the frustum's eight corners (far ones scaled by far / near), each
//     side's normal by PSVECSubtract, PSVECCrossProduct and MsVECNormalize, its offset -(n . corner) as fmadds /
//     fnmadds.
//   ViewFrustumClipCheck (JP 0x800C12A4): the point into view space by PSMTXMultVec with the graphics' view matrix
//     (TGraphics +0xB4), out when -radius > nx x + ny y + nz z + offset (fmuls, fmadds, fmadds, fadds) for a side.
// The view matrix is C_MTXLookAt (JP 0x8009487C) of the camera's mPosition, mUp and mTarget, set when the
// camera performs in the frame's drawing (PerformList GX): the clip in the next frame's CalcAnim sees that one.

import { fr, mslSinf, mslCosf, psMtxMultVec, V3, Mtx } from './math.js';
import { fmadd } from './player/fmath.js';
import { psVecNormalize, msVecNormalize } from './camera/lib.js';

type Vec = { x: number; y: number; z: number };

/** PSVECCrossProduct (JP 0x80094F90): ps_mul / ps_muls0 products rounded, the differences by ps_msub (fused) */
export function psVecCross(a: Vec, b: Vec, out: Vec = { x: 0, y: 0, z: 0 }): Vec {
    const bxaz = fr(b.x * a.z), byaz = fr(b.y * a.z), byax = fr(b.y * a.x);
    const x = fmadd(a.y, b.z, -byaz);
    const y = -fmadd(a.x, b.z, -bxaz);
    const z = -fmadd(a.y, b.x, -byax);
    out.x = x; out.y = y; out.z = z;
    return out;
}
const sub = (a: Vec, b: Vec): Vec => ({ x: fr(a.x - b.x), y: fr(a.y - b.y), z: fr(a.z - b.z) });

/** C_MTXLookAt (JP 0x8009487C): the look direction normalized by PSVECNormalize, right = up x look, up' = look x right */
export function cMtxLookAt(eye: Vec, up: Vec, target: Vec, m: Mtx = new Float64Array(12)): Mtx {
    const look = psVecNormalize(sub(eye, target), { x: 0, y: 0, z: 0 });
    const right = psVecNormalize(psVecCross(up, look), { x: 0, y: 0, z: 0 });
    const u = psVecCross(look, right);
    const dot = (v: Vec) => -fr(fr(fr(eye.x * v.x) + fr(eye.y * v.y)) + fr(eye.z * v.z));
    m[0] = right.x; m[1] = right.y; m[2] = right.z; m[3] = dot(right);
    m[4] = u.x; m[5] = u.y; m[6] = u.z; m[7] = dot(u);
    m[8] = look.x; m[9] = look.y; m[10] = look.z; m[11] = dot(look);
    return m;
}

/** sViewPlane: nx, ny, nz, offset for the six sides */
const planes = new Float64Array(24);
const keep = { fovy: NaN, aspect: NaN, near: NaN, far: NaN };
/** f32(pi / 180 / 2): the constant at r2 - 0x73A8 (0x3C0EFA36) */
const HALF_DEG = fr(0.008726646);

function setPlane(i: number, a: Vec, b: Vec, p: Vec) {
    const n = msVecNormalize(psVecCross(a, b), { x: 0, y: 0, z: 0 });
    planes[i * 4] = n.x; planes[i * 4 + 1] = n.y; planes[i * 4 + 2] = n.z;
    planes[i * 4 + 3] = -fmadd(n.z, p.z, fmadd(n.x, p.x, fr(n.y * p.y)));
}
function setViewFrustumClipCheck(top: number, bottom: number, left: number, right: number, near: number, far: number) {
    const k = fr(far / near);
    const ft = fr(top * k), fb = fr(bottom * k), fl = fr(left * k), frr = fr(right * k);
    const nn = -near, nf = -far;
    const c: Vec[] = [
        { x: left, y: top, z: nn }, { x: fl, y: ft, z: nf }, { x: right, y: top, z: nn }, { x: frr, y: ft, z: nf },
        { x: left, y: bottom, z: nn }, { x: fl, y: fb, z: nf }, { x: right, y: bottom, z: nn }, { x: frr, y: fb, z: nf },
    ];
    setPlane(0, sub(c[1], c[0]), sub(c[2], c[0]), c[0]);
    setPlane(1, sub(c[6], c[4]), sub(c[5], c[4]), c[4]);
    setPlane(2, sub(c[4], c[0]), sub(c[1], c[0]), c[0]);
    setPlane(3, sub(c[3], c[2]), sub(c[6], c[2]), c[2]);
    setPlane(4, sub(c[2], c[0]), sub(c[4], c[0]), c[0]);
    setPlane(5, sub(c[3], c[7]), sub(c[5], c[7]), c[7]);
}
/** SetViewFrustumClipCheckPerspective */
export function setViewFrustumClipCheckPerspective(fovy: number, aspect: number, near: number, far: number) {
    fovy = fr(fovy); aspect = fr(aspect); near = fr(near); far = fr(far);
    if (fovy === keep.fovy && aspect === keep.aspect && near === keep.near && far === keep.far) return;
    keep.fovy = fovy; keep.aspect = aspect; keep.near = near; keep.far = far;
    const a = fr(HALF_DEG * fovy);
    const tan = fr(mslSinf(a) / mslCosf(a));
    const v = fr(near * tan), h = fr(v * aspect);
    setViewFrustumClipCheck(v, -v, -h, h, near, far);
}
/** ViewFrustumClipCheck(gfx, pos, radius) with the graphics' view matrix */
export function viewFrustumClipCheck(view: Mtx, p: Vec, radius: number): boolean {
    const q = psMtxMultVec(view, new V3(p.x, p.y, p.z));
    const r = -fr(radius);
    for (let i = 0; i < 6; i++) {
        const o = i * 4;
        const d = fr(planes[o + 3] + fmadd(q.z, planes[o + 2], fmadd(q.x, planes[o], fr(q.y * planes[o + 1]))));
        if (r > d) return false;
    }
    return true;
}
