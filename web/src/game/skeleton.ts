// Joints for the game code: J3DModel::getAnmMtx (a joint's matrix at the model's BCK frame),
// worked out on the CPU from the model's JNT1 / INF1 and the BCK, the way J3DModel::calc does
// (each joint's matrix in its parent's, from the model's base TR matrix and scale).

import { mat4, vec3 } from 'gl-matrix';
import ArrayBufferSlice from '../../noclip/ArrayBufferSlice.js';
import { BCK, ANK1, JointTransformInfo, J3DLoadFlags } from '../../noclip/Common/JSYSTEM/J3D/J3DLoader.js';
import { calcANK1JointAnimationTransform, calcJointMatrixFromTransform } from '../../noclip/Common/JSYSTEM/J3D/J3DGraphAnimator.js';
import { quatFromEulerRadians } from '../../noclip/MathHelpers.js';
import type { Mtx } from './math.js';

const slice = (b: Uint8Array) => new ArrayBufferSlice(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength);

/** A BMD's joints: names, parents (hierarchy order), rest transforms, calc flags. */
export class Skeleton {
    names: string[] = []; parent: number[] = []; order: number[] = []; rest: JointTransformInfo[] = []; calcFlags: number[] = [];
    loadFlags = 0;
    static cache = new Map<Uint8Array, Skeleton | null>();
    static of(bmd: Uint8Array | null): Skeleton | null {
        if (!bmd) return null;
        if (!this.cache.has(bmd)) { let s: Skeleton | null = null; try { s = new Skeleton(bmd); } catch (e) { console.warn('[game] skeleton', e); } this.cache.set(bmd, s); }
        return this.cache.get(bmd)!;
    }
    constructor(b: Uint8Array) {
        const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
        let o = 0x20, inf1 = -1, jnt1 = -1;
        while (o + 8 <= b.length) {
            const tag = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]), size = v.getUint32(o + 4);
            if (tag === 'INF1') inf1 = o; else if (tag === 'JNT1') jnt1 = o;
            if (!size) break;
            o += size;
        }
        if (inf1 < 0 || jnt1 < 0) throw new Error('no INF1/JNT1');
        this.loadFlags = v.getUint16(inf1 + 8);
        // JNT1
        const n = v.getUint16(jnt1 + 8), dataOff = jnt1 + v.getUint32(jnt1 + 0xC), remap = jnt1 + v.getUint32(jnt1 + 0x10), names = jnt1 + v.getUint32(jnt1 + 0x14);
        const nameCount = v.getUint16(names);
        const nameAt: string[] = [];
        for (let i = 0; i < nameCount; i++) {
            let p = names + v.getUint16(names + 4 + i * 4 + 2), s = '';
            while (b[p]) s += String.fromCharCode(b[p++]);
            nameAt.push(s);
        }
        for (let i = 0; i < n; i++) {
            const d = dataOff + v.getUint16(remap + i * 2) * 0x40;
            const t = new JointTransformInfo();
            t.scale[0] = v.getFloat32(d + 4); t.scale[1] = v.getFloat32(d + 8); t.scale[2] = v.getFloat32(d + 0xC);
            quatFromEulerRadians(t.rotation, v.getInt16(d + 0x10) / 0x7FFF * Math.PI, v.getInt16(d + 0x12) / 0x7FFF * Math.PI, v.getInt16(d + 0x14) / 0x7FFF * Math.PI);
            t.translation[0] = v.getFloat32(d + 0x18); t.translation[1] = v.getFloat32(d + 0x1C); t.translation[2] = v.getFloat32(d + 0x20);
            this.rest.push(t); this.calcFlags.push(b[d + 2]); this.names.push(nameAt[i] || '');
            this.parent.push(-1);
        }
        // INF1's hierarchy: joints nest by Open / Close
        let h = inf1 + v.getUint32(inf1 + 0x14);
        const stack: number[] = [];
        let last = -1;
        for (; ;) {
            const type = v.getUint16(h), val = v.getUint16(h + 2);
            h += 4;
            if (type === 0x00) break;
            if (type === 0x01) stack.push(last);
            else if (type === 0x02) last = stack.pop()!;
            else if (type === 0x10) {
                let p = -1;
                for (let k = stack.length - 1; k >= 0; k--) if (stack[k] >= 0) { p = stack[k]; break; }
                if (val < n) { this.parent[val] = p; this.order.push(val); }
                last = val;
            }
        }
    }
    index(name: string) { return this.names.indexOf(name); }
}

const bckCache = new Map<Uint8Array, ANK1 | null>();
export function parseBCK(b: Uint8Array | null): ANK1 | null {
    if (!b) return null;
    if (!bckCache.has(b)) { let a: ANK1 | null = null; try { a = BCK.parse(slice(b)); } catch { } bckCache.set(b, a); }
    return bckCache.get(b)!;
}

const tmpT = new JointTransformInfo();
const parentScale = { parentScale: vec3.fromValues(1, 1, 1) } as any;
/** Every joint's world matrix (J3D's anm matrices) for the base TR matrix (game layout, 3x4 row-major) and scale, at a BCK frame. */
export function jointMatrices(sk: Skeleton, anm: ANK1 | null, frame: number, base: Mtx, scale: [number, number, number], out: mat4[] = [], post?: (j: number, m: mat4) => void): mat4[] {
    const root = mat4.fromValues(base[0], base[4], base[8], 0, base[1], base[5], base[9], 0, base[2], base[6], base[10], 0, base[3], base[7], base[11], 1);
    mat4.scale(root, root, scale);
    const local = mat4.create();
    for (const j of sk.order) {
        let t = sk.rest[j];
        const e = anm && anm.jointAnimationEntries[j];
        if (e) { calcANK1JointAnimationTransform(tmpT, e, frame, frame + 1); t = tmpT; }
        calcJointMatrixFromTransform(local, t, sk.loadFlags as J3DLoadFlags, { calcFlags: sk.calcFlags[j] } as any, parentScale);
        const p = sk.parent[j];
        out[j] = out[j] || mat4.create();
        mat4.mul(out[j], p >= 0 ? out[p] : root, local);
        // a joint callback (J3DMtxCalc::calc / setJointCallback): what it does to the joint its children see
        if (post) post(j, out[j]);
    }
    return out;
}

const tmpOld = new JointTransformInfo(), tmpBlend = new JointTransformInfo();
/** A BCK in a motion blend: the animation and the frame it's at. */
export interface BlendAnm { anm: ANK1 | null; frame: number; }
/**
 * M3UMtxCalcSIAnmBlendQuat::calc for every joint: the new animation's pose blended toward the old
 * one's by ratio (M3UMtxCalcBlendAux: scale and translation lerped, the rotations' quaternions
 * JMAQuatLerp'd), the rest pose when neither applies; basic: J3DMtxCalcBasic's rules (else the
 * model's). post(j, world) may change a joint's world matrix (the owner's calc additions), and
 * what it leaves is what its children see. locals gets each joint's resulting matrix in its
 * parent's (for the viewer's joint callback).
 */
export function jointMatricesBlend(sk: Skeleton, nw: BlendAnm | null, old: BlendAnm | null, ratio: number, basic: boolean, base: Mtx, scale: [number, number, number],
    out: mat4[] = [], locals: mat4[] | null = null, post?: (j: number, m: mat4) => void,
    upper?: { joint: number; anm: BlendAnm | null } | null): mat4[] {
    const root = mat4.fromValues(base[0], base[4], base[8], 0, base[1], base[5], base[9], 0, base[2], base[6], base[10], 0, base[3], base[7], base[11], 1);
    mat4.scale(root, root, scale);
    const local = mat4.create(), inv = mat4.create();
    const flags = (basic ? 0 : sk.loadFlags) as J3DLoadFlags;
    const sample = (dst: JointTransformInfo, a: BlendAnm | null, j: number) => {
        const e = a && a.anm && a.anm.jointAnimationEntries[j];
        if (!e) return sk.rest[j];
        calcANK1JointAnimationTransform(dst, e, a!.frame, a!.frame + 1);
        return dst;
    };
    // a second motion set from one joint down (M3UModelMario's unk24[1]: J3DJoint::setMtxCalc on it,
    // its descendants inheriting the current calc), its new anm only (its blend ratio stays 0)
    const inUpper: boolean[] = [];
    for (const j of sk.order) {
        let t: JointTransformInfo;
        if (upper) { const p = sk.parent[j]; inUpper[j] = j === upper.joint || (p >= 0 && !!inUpper[p]); }
        if (upper && inUpper[j]) t = upper.anm ? sample(tmpT, upper.anm, j) : sk.rest[j];
        else if ((!nw && !old) || (!nw && ratio === 0) || (!old && ratio === 1)) t = sk.rest[j];
        else if (ratio === 0 || !old) t = sample(tmpT, nw, j);
        else if (ratio === 1 || !nw) t = sample(tmpT, old, j);
        else {
            const a = sample(tmpT, nw, j), b = sample(tmpOld, old, j), r = ratio, q = 1 - r;
            const B = tmpBlend;
            for (let k = 0; k < 3; k++) { B.scale[k] = a.scale[k] * q + b.scale[k] * r; B.translation[k] = a.translation[k] * q + b.translation[k] * r; }
            const qa = a.rotation, qb = b.rotation;
            const s = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3] < 0 ? -1 : 1;
            for (let k = 0; k < 4; k++) B.rotation[k] = q * qa[k] + r * s * qb[k];
            const n = Math.hypot(B.rotation[0], B.rotation[1], B.rotation[2], B.rotation[3]) || 1;   // (MTXQuat normalises)
            for (let k = 0; k < 4; k++) B.rotation[k] /= n;
            t = B;
        }
        calcJointMatrixFromTransform(local, t, flags, { calcFlags: sk.calcFlags[j] } as any, parentScale);
        const p = sk.parent[j], P = p >= 0 ? out[p] : root;
        out[j] = out[j] || mat4.create();
        mat4.mul(out[j], P, local);
        if (post) post(j, out[j]);
        if (locals) { locals[j] = locals[j] || mat4.create(); mat4.invert(inv, P); mat4.mul(locals[j], inv, out[j]); }
    }
    return out;
}
