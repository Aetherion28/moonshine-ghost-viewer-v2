// J3DModel::calc's joint matrices the way the GameCube works them out, bit for bit: the BCK's
// keys interpolated in f32 (JMAHermiteInterpolation; J3DHermiteInterpolationS's paired-single
// code for the s16 rotations, truncated to s16 << the BCK's shift), J3DGetTranslateRotateMtx's
// JMASSin / JMASCos table lookups and fused products, PSMTXConcat, and M3UMtxCalcBlendAux's
// quaternion blend (JMAEulerToQuat, JMAQuatLerp, PSMTXQuat). J3DMtxCalcBasic::recursiveCalc
// walks the joints: each one's calcIn (its matrix in mCurrentMtx, its anm matrix stored), then
// its callback (what its children see), its children, then its younger siblings from the
// parent's matrix again.

import { fr, fmul, fadd, fsub, fdiv, fmadd, fmsub, fnmsub, fres } from './player/fmath.js';
import { JMASSin, JMASCos, type Mtx } from './math.js';

/** J3DTransformInfo: scale, s16 rotation, translation */
export interface TI { sx: number; sy: number; sz: number; rx: number; ry: number; rz: number; tx: number; ty: number; tz: number; }
export const newTI = (): TI => ({ sx: 1, sy: 1, sz: 1, rx: 0, ry: 0, rz: 0, tx: 0, ty: 0, tz: 0 });
const s16 = (v: number) => (v << 16) >> 16;

// ---------------------------------------------------------------- the BCK (J3DAnmTransformKey)
interface KeyTab { n: number; off: number; type: number; }
/** ANK1 as J3DAnmTransformKey keeps it: per joint and axis the scale / rotation / translation key tables. */
export class RawAnk {
    shift = 0; joints = 0;
    tab: KeyTab[] = [];   // (joint * 3 + axis) * 3 + {0 scale, 1 rotation, 2 translation}
    sData!: Float32Array; rData!: Int16Array; tData!: Float32Array;
    static cache = new Map<Uint8Array, RawAnk | null>();
    static of(b: Uint8Array | null): RawAnk | null {
        if (!b) return null;
        if (!this.cache.has(b)) { let a: RawAnk | null = null; try { a = new RawAnk(b); } catch { } this.cache.set(b, a); }
        return this.cache.get(b)!;
    }
    constructor(b: Uint8Array) {
        const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
        let o = 0x20;
        while (o + 8 <= b.length && String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) !== 'ANK1') { const s = v.getUint32(o + 4); if (!s) throw new Error('no ANK1'); o += s; }
        if (o + 8 > b.length) throw new Error('no ANK1');
        this.shift = b[o + 9]; this.joints = v.getUint16(o + 0x0C);
        const ns = v.getUint16(o + 0x0E), nr = v.getUint16(o + 0x10), nt = v.getUint16(o + 0x12);
        const jt = o + v.getUint32(o + 0x14), st = o + v.getUint32(o + 0x18), rt = o + v.getUint32(o + 0x1C), tt = o + v.getUint32(o + 0x20);
        this.sData = new Float32Array(ns); for (let i = 0; i < ns; i++) this.sData[i] = v.getFloat32(st + i * 4);
        this.rData = new Int16Array(nr); for (let i = 0; i < nr; i++) this.rData[i] = v.getInt16(rt + i * 2);
        this.tData = new Float32Array(nt); for (let i = 0; i < nt; i++) this.tData[i] = v.getFloat32(tt + i * 4);
        for (let i = 0; i < this.joints * 9; i++) { const p = jt + i * 6; this.tab.push({ n: v.getUint16(p), off: v.getUint16(p + 2), type: v.getUint16(p + 4) }); }
    }
}

/** JMAHermiteInterpolation (its compiled order) */
function hermF(f: number, t0: number, v0: number, d0: number, t1: number, v1: number, d1: number) {
    const len = fsub(t1, t0), f11 = fsub(f, t0), sq = fmul(f11, f11), inv = fdiv(1, len);
    const f12 = fmul(inv, sq), f2 = fmul(f12, inv), f13 = fmul(f11, f2), f10 = fmul(3, f2), f31 = fmul(f13, inv);
    const a = fnmsub(2, f12, f13), b = fsub(f13, f12), c = fmsub(2, f31, f10), d = fmadd(-2, f31, f10);
    const e = fadd(f11, a), g = fadd(1, c);
    return fmadd(d1, b, fmadd(d0, e, fmadd(v0, g, fmul(v1, d))));
}
/** J3DHermiteInterpolationS (the s16 keys loaded as floats) */
function hermS(t: number, t0: number, v0: number, d0: number, t1: number, v1: number, d1: number) {
    const f4 = fsub(t1, t0);
    let f6 = fsub(t, t0), f5 = fsub(v1, v0);
    f6 = fdiv(f6, f4);
    let o = fmadd(d1, f4, v0);
    const f7 = fmul(f6, f6);
    f5 = fnmsub(f4, d0, f5);
    o = fsub(o, v1); o = fsub(o, f5);
    const f3 = fmul(f7, o);
    o = fmadd(f4, d0, f3); o = fmadd(o, f6, v0); o = fmadd(f5, f7, o);
    return fsub(o, f3);
}
/** J3DGetKeyFrameInterpolation(S): before the first key its value, from the last key its value, else the pair's Hermite */
function keyAt(frame: number, k: KeyTab, d: ArrayLike<number>, s: boolean) {
    const w = k.type === 0 ? 3 : 4;
    let o = k.off;
    if (frame < d[o]) return d[o + 1];
    if (d[o + w * (k.n - 1)] <= frame) return d[o + w * (k.n - 1) + 1];
    let num = k.n;
    while (num > 1) { const mid = num >> 1; if (frame >= d[o + w * mid]) { o += w * mid; num -= mid; } else num = mid; }
    const H = s ? hermS : hermF;
    return k.type === 0 ? H(frame, d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 5]) : H(frame, d[o], d[o + 1], d[o + 3], d[o + 4], d[o + 5], d[o + 6]);
}
/** J3DAnmTransformKey::calcTransform(frame, joint) */
export function keyTransform(a: RawAnk, frame: number, j: number, out: TI) {
    frame = fr(frame);
    for (let ax = 0; ax < 3; ax++) {
        const S = a.tab[(j * 3 + ax) * 3], R = a.tab[(j * 3 + ax) * 3 + 1], T = a.tab[(j * 3 + ax) * 3 + 2];
        const sc = S.n === 0 ? 1 : S.n === 1 ? a.sData[S.off] : keyAt(frame, S, a.sData, false);
        const ro = R.n === 0 ? 0 : R.n === 1 ? s16(a.rData[R.off] << a.shift) : s16(Math.trunc(keyAt(frame, R, a.rData, true)) << a.shift);
        const tr = T.n === 0 ? 0 : T.n === 1 ? a.tData[T.off] : keyAt(frame, T, a.tData, false);
        if (ax === 0) { out.sx = sc; out.rx = ro; out.tx = tr; } else if (ax === 1) { out.sy = sc; out.ry = ro; out.ty = tr; } else { out.sz = sc; out.rz = ro; out.tz = tr; }
    }
    return out;
}

// ---------------------------------------------------------------- matrices
/** J3DGetTranslateRotateMtx(rx, ry, rz, tx, ty, tz) */
export function trMtx(rx: number, ry: number, rz: number, tx: number, ty: number, tz: number, m: Mtx | number[]) {
    const sx = JMASSin(rx), cx = JMASCos(rx), sy = JMASSin(ry), cy = JMASCos(ry), sz = JMASSin(rz), cz = JMASCos(rz);
    m[8] = -sy; m[0] = fmul(cz, cy); m[4] = fmul(sz, cy); m[9] = fmul(cy, sx); m[10] = fmul(cy, cx);
    const cxsz = fmul(cx, sz), sxcz = fmul(sx, cz), sxsz = fmul(sx, sz), cxcz = fmul(cx, cz);
    m[1] = fmsub(sxcz, sy, cxsz); m[6] = fmsub(cxsz, sy, sxcz);
    m[2] = fmadd(cxcz, sy, sxsz); m[5] = fmadd(sxsz, sy, cxcz);
    m[3] = tx; m[7] = ty; m[11] = tz;
    return m;
}
/** whether ps_madd rounds once (as the Gekko's fused multiply-add) */
export let PS_FUSED = true;
export function setPsFused(v: boolean) { PS_FUSED = v; }
const psmadd = (a: number, b: number, c: number) => PS_FUSED ? fmadd(a, b, c) : fr(fr(a * b) + c);
/** PSMTXConcat(a, b) into out (out may be a or b) */
export function concat(a: ArrayLike<number>, b: ArrayLike<number>, out: Mtx | number[]) {
    const r = tmpC;
    for (let i = 0; i < 3; i++) {
        const a0 = a[i * 4], a1 = a[i * 4 + 1], a2 = a[i * 4 + 2], a3 = a[i * 4 + 3];
        for (let j = 0; j < 4; j++) {
            let v = psmadd(b[8 + j], a2, psmadd(b[4 + j], a1, fmul(b[j], a0)));
            if (j === 3) v = psmadd(1, a3, v);
            r[i * 4 + j] = v;
        }
    }
    for (let k = 0; k < 12; k++) out[k] = r[k];
    return out;
}
const tmpC = new Array<number>(12).fill(0);

/** JMAEulerToQuat (each angle halved toward zero) -> [x, y, z, w] */
function eulerToQuat(x: number, y: number, z: number, q: number[]) {
    const hx = Math.trunc(s16(x) / 2), hy = Math.trunc(s16(y) / 2), hz = Math.trunc(s16(z) / 2);
    const sx = JMASSin(hx), cx = JMASCos(hx), sy = JMASSin(hy), cy = JMASCos(hy), sz = JMASSin(hz), cz = JMASCos(hz);
    const sysz = fmul(sy, sz), cycz = fmul(cy, cz);
    q[3] = fmadd(cx, cycz, fmul(sx, sysz));
    q[0] = fmsub(sx, cycz, fmul(cx, sysz));
    q[1] = fmadd(cz, fmul(cx, sy), fmul(sz, fmul(sx, cy)));
    q[2] = fmsub(sz, fmul(cx, cy), fmul(cz, fmul(sx, sy)));
    return q;
}
/** JMAQuatLerp(a, b, t): the shorter way, in double, each part rounded to f32 */
function quatLerp(a: number[], b: number[], t: number, out: number[]) {
    const dot = fmadd(a[3], b[3], fmadd(a[2], b[2], fmadd(a[0], b[0], fmul(a[1], b[1]))));
    const sg = dot < 0 ? -1 : 1, u = 1.0 - t;
    for (let k = 0; k < 4; k++) out[k] = fr(u * a[k] + t * (sg * b[k]));
    return out;
}
/** PSMTXQuat(q): its paired-single code lane by lane */
function mtxQuat(q: number[], m: Mtx | number[]) {
    const [x, y, z, w] = q;
    const x2 = fmul(x, x), y2 = fmul(y, y);
    const t4a = psmadd(z, z, x2), t4b = psmadd(w, w, y2);
    const z2 = fmul(z, z);
    const S = fadd(t4a, t4b);
    const yw = fmul(y, w), xw = fmul(x, w);
    const e = fres(S);
    const t4ps1 = fadd(z2, y2);   // ps_sum1: z2 + y2 (ps0 stays t4a)
    let sc = fr(-PS_NMSUB(S, e, 2));
    sc = fmul(e, sc);
    sc = fmul(sc, 2);
    const zw = fmul(z, w), ww = fmul(w, w);
    const xy2 = fadd(x2, y2);
    const t8a = psmadd(x, y, zw), t6a = PS_MSUB(x, y, zw);
    m[3] = 0;
    const m22 = fr(-PS_NMSUB(xy2, sc, 1)), t4a2 = fr(-PS_NMSUB(t4a, sc, 1)), t4b2 = fr(-PS_NMSUB(t4ps1, sc, 1));
    m[11] = 0;
    const t8 = fmul(t8a, sc), t6 = fmul(t6a, sc);
    m[10] = m22;
    const t5a = psmadd(x, z, yw), t5b = psmadd(y, z, xw);
    m[4] = t8; m[5] = t4a2;
    const t7a = fr(-PS_NMSUB(yw, 2, t5a)), t7b = fr(-PS_NMSUB(xw, 2, t5b));
    m[0] = t4b2; m[1] = t6;
    const t5 = fmul(t5a, sc), t5bs = fmul(t5b, sc), t7 = fmul(t7a, sc), t7bs = fmul(t7b, sc);
    m[2] = t5;
    m[6] = t7bs; m[7] = 0;
    m[8] = t7; m[9] = t5bs;
    return m;
}
/** ps_nmsub's inner a * c - b (negated by the caller), ps_msub a * c - b */
const PS_NMSUB = (a: number, c: number, b: number) => PS_FUSED ? fmsub(a, c, b) : fr(fr(a * c) - b);
const PS_MSUB = (a: number, c: number, b: number) => PS_FUSED ? fmsub(a, c, b) : fr(fr(a * c) - b);

// ---------------------------------------------------------------- the joints
export type CalcMode = 'basic' | 'softimage';
/** the joint hierarchy J3DModel::calc walks */
export interface ExactSkeleton { parent: number[]; order: number[]; restTI: TI[]; }
export interface ExactAnm { anm: RawAnk | null; frame: number; }
interface State { cur: number[]; S: [number, number, number]; }

/**
 * J3DModel::calc for every joint: anm matrices (game layout, 3x4 row-major f32). calc(j) gives
 * joint j's transform source (the blend, an animation, or the rest pose); cb(j, cur) may change
 * mCurrentMtx after the joint's anm matrix is stored (its children see it).
 */
export function calcJoints(sk: ExactSkeleton, init: CalcMode, base: ArrayLike<number>, scale: [number, number, number],
    jointCalc: (j: number) => { mode: CalcMode; nw: ExactAnm | null; old: ExactAnm | null; ratio: number; blend: boolean },
    cb?: ((j: number, cur: number[]) => void) | null, out: number[][] = []): number[][] {
    const st: State[] = [];
    const rootCur = new Array<number>(12);
    if (init === 'basic') {
        for (let r = 0; r < 3; r++) { rootCur[r * 4] = fmul(base[r * 4], scale[0]); rootCur[r * 4 + 1] = fmul(base[r * 4 + 1], scale[1]); rootCur[r * 4 + 2] = fmul(base[r * 4 + 2], scale[2]); rootCur[r * 4 + 3] = base[r * 4 + 3]; }
    } else for (let k = 0; k < 12; k++) rootCur[k] = base[k];
    const rootS: [number, number, number] = [scale[0], scale[1], scale[2]];
    const ti = newTI(), tiOld = newTI(), local = new Array<number>(12).fill(0);
    const q0 = [0, 0, 0, 0], q1 = [0, 0, 0, 0], q2 = [0, 0, 0, 0];
    for (const j of sk.order) {
        const p = sk.parent[j];
        const cur = (p >= 0 && st[p] ? st[p].cur : rootCur).slice();
        const S: [number, number, number] = p >= 0 && st[p] ? [st[p].S[0], st[p].S[1], st[p].S[2]] : [rootS[0], rootS[1], rootS[2]];
        const c = jointCalc(j);
        const A = (out[j] ||= new Array<number>(12).fill(0));
        const transformOf = (a: ExactAnm | null, dst: TI) => a && a.anm && j < a.anm.joints ? keyTransform(a.anm, a.frame, j, dst) : copyTI(sk.restTI[j], dst);
        if (!c.blend) {
            const t = transformOf(c.nw, ti);
            if (c.mode === 'softimage') {
                trMtx(t.rx, t.ry, t.rz, fmul(t.tx, S[0]), fmul(t.ty, S[1]), fmul(t.tz, S[2]), local);
                concat(cur, local, cur);
                S[0] = fmul(S[0], t.sx); S[1] = fmul(S[1], t.sy); S[2] = fmul(S[2], t.sz);
                if (S[0] === 1 && S[1] === 1 && S[2] === 1) copyM(cur, A);
                else scaleCols(cur, S, A);
            } else {
                S[0] = fmul(S[0], t.sx); S[1] = fmul(S[1], t.sy); S[2] = fmul(S[2], t.sz);
                const one = S[0] === 1 && S[1] === 1 && S[2] === 1;
                trMtx(t.rx, t.ry, t.rz, t.tx, t.ty, t.tz, local);
                if (!one) scaleCols(local, [t.sx, t.sy, t.sz], local);
                concat(cur, local, cur);
                copyM(cur, A);
            }
        } else {
            // M3UMtxCalcBlendAux(j, new, old, ratio, basic)
            const a = transformOf(c.nw, ti), b = transformOf(c.old, tiOld), r = fr(c.ratio), f = fsub(1, r);
            const basic = c.mode === 'basic';
            const ls: [number, number, number] = basic ? [1, 1, 1] : [S[0], S[1], S[2]];
            const bs: [number, number, number] = [fmadd(a.sx, f, fmul(b.sx, r)), fmadd(a.sy, f, fmul(b.sy, r)), fmadd(a.sz, f, fmul(b.sz, r))];
            S[0] = fmul(S[0], bs[0]); S[1] = fmul(S[1], bs[1]); S[2] = fmul(S[2], bs[2]);
            const one = S[0] === 1 && S[1] === 1 && S[2] === 1;
            eulerToQuat(a.rx, a.ry, a.rz, q0); eulerToQuat(b.rx, b.ry, b.rz, q1);
            quatLerp(q0, q1, r, q2);
            mtxQuat(q2, local);
            local[3] = fmul(ls[0], fmadd(a.tx, f, fmul(b.tx, r)));
            local[7] = fmul(ls[1], fmadd(a.ty, f, fmul(b.ty, r)));
            local[11] = fmul(ls[2], fmadd(a.tz, f, fmul(b.tz, r)));
            if (basic) {
                if (!one) scaleCols(local, bs, local);
                concat(cur, local, cur);
                copyM(cur, A);
            } else {
                concat(cur, local, cur);
                if (one) copyM(cur, A); else scaleCols(cur, S, A);
            }
        }
        if (cb) cb(j, cur);
        st[j] = { cur, S };
    }
    return out;
}
function copyTI(s: TI, d: TI) { d.sx = s.sx; d.sy = s.sy; d.sz = s.sz; d.rx = s.rx; d.ry = s.ry; d.rz = s.rz; d.tx = s.tx; d.ty = s.ty; d.tz = s.tz; return d; }
function copyM(s: ArrayLike<number>, d: number[]) { for (let k = 0; k < 12; k++) d[k] = s[k]; }
function scaleCols(m: ArrayLike<number>, s: number[], d: number[]) {
    for (let r = 0; r < 3; r++) { d[r * 4] = fmul(m[r * 4], s[0]); d[r * 4 + 1] = fmul(m[r * 4 + 1], s[1]); d[r * 4 + 2] = fmul(m[r * 4 + 2], s[2]); d[r * 4 + 3] = m[r * 4 + 3]; }
}
