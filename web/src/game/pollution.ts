// Goop (Map/Pollution*.cpp): TPollutionManager's layers, each an I8 texture over a stretch of
// the stage (TPollutionPos: texel size, a depth map of the ground under it), what's polluted
// (isPolluted: above the layer's threshold, at the depth there), and the stamps that clean or
// goop it. The game draws the stamps on the GPU once a frame (TPollutionCounterLayer::
// countTexDegree, in the frame's draw lists) and copies the result back over the texture; here
// the same TEV and blend maths run on the CPU over the same texel layout (GX I8 tiles).

import { MsRandF } from './math.js';
import type { Files, MActor } from './engine.js';
import type { Mtx } from './math.js';
import { mat4 } from 'gl-matrix';
import ArrayBufferSlice from '../../noclip/ArrayBufferSlice.js';
import { BMD, DRW1MatrixKind } from '../../noclip/Common/JSYSTEM/J3D/J3DLoader.js';
import { VertexAttributeInput } from '../../noclip/gx/gx_displaylist.js';
import { GfxFormat, FormatTypeFlags, getFormatTypeFlags, getFormatComponentCount, getFormatFlags, FormatFlags } from '../../noclip/gfx/platform/GfxPlatformFormat.js';

const fr = Math.fround;

export const POLLUTION_TYPE = { SINK: 0, FIRE: 1, SLIP: 2, GLASS_WALL: 3, ELECTRIC: 4, INSTAKILL: 5, SAFE: 6, UNK7: 7, UNK8: 8, UNK10: 10 };
export const FLAG_CAN_SPREAD = 0x1, FLAG_DECAY = 0x2;

/** A GX texture's texels as intensity + alpha (I4, I8, IA4, IA8), row-major. */
export interface Img { w: number; h: number; i: Uint8Array; a: Uint8Array; }
export function decodeGX(fmt: number, w: number, h: number, d: Uint8Array, o: number): Img | null {
    const I = new Uint8Array(w * h), A = new Uint8Array(w * h);
    const blocks = (bw: number, bh: number, px: (x: number, y: number) => void) => {
        for (let by = 0; by < h; by += bh) for (let bx = 0; bx < w; bx += bw)
            for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) px(bx + x, by + y);
    };
    const put = (x: number, y: number, i: number, a: number) => { if (x < w && y < h) { I[y * w + x] = i; A[y * w + x] = a; } };
    let k = o;
    switch (fmt) {
        case 0: { let n = 0; blocks(8, 8, (x, y) => { const b = d[k + (n >> 1)]; const v = (n & 1) ? b & 15 : b >> 4; n++; if ((n & 63) === 0) { k += 32; n = 0; } put(x, y, v * 17, v * 17); }); break; }
        case 1: blocks(8, 4, (x, y) => { const v = d[k++]; put(x, y, v, v); }); break;
        case 2: blocks(8, 4, (x, y) => { const b = d[k++]; put(x, y, (b & 15) * 17, (b >> 4) * 17); }); break;
        case 3: blocks(4, 4, (x, y) => { const a = d[k++], i = d[k++]; put(x, y, i, a); }); break;
        default: return null;
    }
    return { w, h, i: I, a: A };
}
export function parseBTI(b: Uint8Array): Img | null {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return decodeGX(b[0], v.getUint16(2), v.getUint16(4), b, v.getUint32(0x1C));
}

/** A BMD's TEX1 texture 0: its format, size and data (TPollutionLayer::getTexResource). */
function bmdTexture0(b: Uint8Array): { fmt: number; w: number; h: number; data: Uint8Array; off: number } | null {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let o = 0x20;
    while (o + 8 <= b.length) {
        const tag = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]), size = v.getUint32(o + 4);
        if (tag === 'TEX1') {
            const hdr = o + v.getUint32(o + 0x0C);
            return { fmt: b[hdr], w: v.getUint16(hdr + 2), h: v.getUint16(hdr + 4), data: b, off: hdr + v.getUint32(hdr + 0x1C) };
        }
        if (!size) break;
        o += size;
    }
    return null;
}

/** TPollutionPos */
class Pos {
    w = 0; h = 0; lw = 0; lh = 0; vofs = 0; texel = 0; inv = 0; depth!: Uint8Array;
    constructor(public owner: Layer) { }
    init(vofs: number, texel: number, depth: Uint8Array, lw: number, lh: number) {
        this.depth = depth; this.vofs = vofs; this.texel = texel; this.inv = fr(1 / texel);
        this.lw = lw; this.lh = lh; this.w = 1 << lw; this.h = 1 << lh;
    }
    index(x: number, z: number) { return (z & 3) * 8 + ((x >> 3) + ((z >> 2) << (this.lw - 3))) * 0x20 + (x & 7); }
    inArea(x: number, z: number) { return !(x < 0 || this.w <= x || z < 0 || this.h <= z); }
    getDepth(x: number, z: number) { return this.depth[this.index(x, z)]; }
    worldToDepth(v: number) { return Math.trunc(fr(fr(v - this.vofs) * 0.025)); }
    worldToTexSize(v: number) { return Math.trunc(fr(v * this.inv)); }
    depthToWorld(v: number) { return fr(this.vofs + fr(v * this.texel)); }
    getDepthWorld(x: number, z: number) { return this.getDepth(x, z) < 0xFF ? this.depthToWorld(this.getDepth(x, z)) : -9999; }
    isProhibit(x: number, z: number) { return x < 0 || this.w <= x || z < 0 || this.h <= z ? true : this.getDepth(x, z) >= 0xFF; }
    isSame(x: number, z: number, y: number) {
        if (!this.inArea(x, z)) return false;
        const d = this.getDepth(x, z);
        if (d < 0xFF) { const i = this.worldToDepth(y), u = this.owner.unk48; return d - u <= i && i <= d + u; }
        return false;
    }
    getEdgeDegree(x: number, y: number) {
        if (!this.inArea(x, y)) return 0;
        let n = 0;
        for (let dy = -1; dy <= 1; ++dy) for (let dx = -1; dx <= 1; ++dx) if ((dx || dy) && this.depth[this.index(x + dx, y + dy)] === 0xFF) n++;
        return n;
    }
}

interface Task { x: number; z: number; size: number; y: number; }

/** TPollutionLayer (plane types 0, 1: ground; 2-5 walls; 6 the sea's wave layer). */
export class Layer {
    type = 0; flags = 0; minX = 0; maxX = 0; minZ = 0; maxZ = 0; minY = 0; maxY = 0;
    unk48 = 0; spreadTimer = 0; threshold = 0; changeDelta = 8; changeThreshold = 0;
    effectTimer = 0; unkA8 = 0;
    pos = new Pos(this);
    /** mPollutionMap: the texture's texels (GX I8 tiles). */
    map!: Uint8Array;
    /** Changed since the viewer last took it. */
    dirty = true;
    /** The stamps waiting for the frame's draw (one queue per stamp type: TPollutionTexStamp). */
    tasks: Task[][] = [[], []];
    /** the frame's model stamps on this layer (mLayerModelStampTaskNum) */
    modelTasks: ModelTask[] = [];
    constructor(public mgr: Pollution, public index: number, public planeType: number, public name: string) { }

    // the plane type's mapping (PollutionLayer.hpp)
    texS(v: number) {
        switch (this.planeType) {
            case 2: return this.pos.worldToTexSize(this.maxZ - v);
            case 3: return this.pos.worldToTexSize(v - this.minZ);
            case 5: return this.pos.worldToTexSize(this.maxX - v);
            default: return this.pos.worldToTexSize(v - this.minX);
        }
    }
    texT(v: number) { return this.planeType >= 2 && this.planeType <= 5 ? this.pos.worldToTexSize(this.maxY - v) : this.pos.worldToTexSize(v - this.minZ); }
    isInArea(x: number, y: number, z: number) {
        if (this.planeType === 2 || this.planeType === 3) return !(z < this.minZ || this.maxZ < z || y < this.minY || this.maxY < y);
        if (this.planeType === 4 || this.planeType === 5) return !(x < this.minX || this.maxX < x || y < this.minY || this.maxY < y);
        return !(x < this.minX || this.maxX < x || z < this.minZ || this.maxZ < z);
    }
    isInAreaSize(x: number, y: number, z: number, s: number) {
        if (this.planeType === 2 || this.planeType === 3) return !(z < this.minZ - s || this.maxZ + s < z || y < this.minY - s || this.maxY + s < y);
        if (this.planeType === 4 || this.planeType === 5) return !(x < this.minX - s || this.maxX + s < x || y < this.minY - s || this.maxY + s < y);
        return !(x < this.minX - s || this.maxX + s < x || z < this.minZ - s || this.maxZ + s < z);
    }

    initLayerInfo(type: number, flags: number, l: number, t: number, r: number, b: number) {
        this.type = type; this.flags = flags; this.minX = l; this.minZ = t; this.maxX = r; this.maxZ = b; this.unk48 = 2;
        if (type === POLLUTION_TYPE.UNK7) { this.threshold = 200; this.changeThreshold = 160; }
        else if (type === POLLUTION_TYPE.FIRE) { this.threshold = 128; this.changeThreshold = 128; }
        else { this.threshold = 30; this.changeThreshold = 50; }
        if (this.planeType === 4 || this.planeType === 5) { this.minY = this.minZ; this.maxY = this.maxZ; this.unk48 = 20; }
        if (this.planeType === 2 || this.planeType === 3) { this.minY = this.minZ; this.maxY = this.maxZ; this.minZ = this.minX; this.maxZ = this.maxX; this.unk48 = 20; }
    }

    /** initTexImage: the starting goop from the layer's .bmp (8-bit, bottom-up rows), edges softened. */
    initTexImage(bmp: Uint8Array | null, mareEdge: boolean) {
        const P = this.pos, w = P.w, h = P.h;
        for (let y = 0; y < h; ++y) for (let x = 0; x < w; ++x) {
            const d = bmp ? bmp[0x436 + x + w * (h - 1 - y)] : 0;
            let v = 0;
            if ((!mareEdge || (x > 0 && x < w - 1 && y > 0 && y < h - 1)) && d && !P.isProhibit(x, y)) {
                const e = P.getEdgeDegree(x, y);
                v = e ? (d - e * 50) & 0xFF : d;
            }
            this.map[P.index(x, y)] = v;
        }
    }

    isPollutedST(s: number, t: number, y: number) { return this.pos.isSame(s, t, y) && this.map[this.pos.index(s, t)] > this.threshold; }
    /** (Walls take the same path as the ground here, as the game's does.) */
    isPolluted(x: number, y: number, z: number) {
        if (!this.isInArea(x, y, z)) return false;
        if (this.planeType === 6 && y > 1) return false;
        // (TPollutionLayer::isPolluted: the virtual getTexPosS(x) / getTexPosT(z), whatever the plane)
        return this.isPollutedST(this.texS(x), this.texT(z), y);
    }

    stamp(type: number, x: number, y: number, z: number, size: number) {
        if (!this.isInAreaSize(x, y, z, size)) return;
        const P = this.pos;
        let s: number, t: number, d: number;
        switch (this.planeType) {
            case 2: case 3: s = this.texS(z); t = this.texT(y); d = P.worldToDepth(x); break;
            case 4: case 5: s = this.texS(x); t = this.texT(y); d = P.worldToDepth(z); break;
            default: s = this.texS(x); t = this.texT(z); d = P.worldToDepth(y); break;
        }
        this.mgr.pushStampTask(type, this, P.worldToTexSize(size), s, t, d);
        // (walls' stamp doesn't count what it cleaned)
        if (this.planeType <= 1 && this.mgr.stampIsCleanType(type)) this.cleaned(x, y, z, size);
    }
    cleaned(_x: number, _y: number, _z: number, _s: number) { /* effects and sounds: the counter's statics only */ }

    // ---------------------------------------------------------------- PollutionAction.cpp
    getPollutedPos(range: number, mario: { x: number, y: number, z: number }, out: { x: number, y: number, z: number }) {
        for (let i = 0; i < 5; ++i) {
            out.x = fr(range * fr(MsRandF() - 0.5) + mario.x);
            out.y = mario.y;
            out.z = fr(range * fr(MsRandF() - 0.5) + mario.z);
            if (this.isPolluted(out.x, out.y, out.z)) return true;
        }
        return false;
    }
    getPollutedPosNear(range: number, mario: { x: number, y: number, z: number }, out: { x: number, y: number, z: number }) {
        const P = this.pos;
        for (let i = 0; i < 5; ++i) {
            const a = fr(fr(MsRandF() - 0.5) * fr(0.7 + MsRandF()));
            out.x = fr(a * range + mario.x);
            const b = fr(fr(MsRandF() - 0.5) * fr(0.7 + MsRandF()));
            out.z = fr(b * range + mario.z);
            if (this.isInArea(out.x, 0, out.z)) {
                const tx = this.texS(out.x), tz = this.texS(out.z);
                if (P.inArea(tx, tz)) {
                    out.y = P.getDepthWorld(tx, tz);
                    if (out.y > mario.y) return false;
                    if (this.map[P.index(tx, tz)] !== 0) return true;
                }
            }
        }
        return false;
    }
    /** TPollutionLayer::action, every movement tick (on the graffiti group's CUE_MOVE). */
    action(mario: { x: number, y: number, z: number }) {
        if (this.planeType !== 0) return;
        const tmp = { x: 0, y: 0, z: 0 };
        switch (this.type) {
            case POLLUTION_TYPE.FIRE: if (this.getPollutedPosNear(1600, mario, tmp)) { if (++this.effectTimer > 20) this.effectTimer = 0; } break;
            case POLLUTION_TYPE.ELECTRIC: if (this.getPollutedPosNear(1000, mario, tmp)) { if (++this.effectTimer > 15) this.effectTimer = 0; } break;
            case POLLUTION_TYPE.GLASS_WALL: this.getPollutedPos(1000, mario, tmp); break;
        }
        if (this.getPollutedPos(2000, mario, tmp)) {
            if (this.type !== POLLUTION_TYPE.FIRE && this.type !== POLLUTION_TYPE.UNK7) {
                if (this.effectTimer > 15) this.effectTimer = 0;
                this.effectTimer += 1;
            }
            if (this.flags & FLAG_CAN_SPREAD) {
                if (this.spreadTimer < 3) this.spreadTimer += 1;
                else { this.spreadTimer = 0; const sp = { x: 0, y: 0, z: 0 }; if (this.getPollutedPosNear(2000, mario, sp)) this.mgr.stamp(1, sp.x, sp.y, sp.z, 128); }
            }
        }
    }

    // ---------------------------------------------------------------- the frame's GPU pass
    /** drawPollutionLayer: residue under the threshold fades by the step (UNK7: above it grows; decaying: all fades). */
    private fade() {
        const M = this.map, n = M.length;
        if (this.type === POLLUTION_TYPE.UNK7) {
            const th = this.changeThreshold, st = (this.flags & FLAG_DECAY) ? 2 : this.changeDelta;
            for (let k = 0; k < n; k++) { const c = M[k]; if (th > c) continue; const v = c + st; M[k] = v > 255 ? 255 : v; }
        } else if (this.flags & FLAG_DECAY) {
            for (let k = 0; k < n; k++) { const v = M[k] - 2; M[k] = v < 0 ? 0 : v; }
        } else {
            const th = this.changeThreshold, st = this.changeDelta;
            for (let k = 0; k < n; k++) { const c = M[k]; if (th > c) { const v = c - st; M[k] = v < 0 ? 0 : v; } }
        }
    }
    /** drawTexStamp / doTask: each stamp a quad of its shape, where the depth map is within unk48 of the stamp's. */
    private stamps() {
        const P = this.pos, M = this.map;
        for (let type = 0; type < this.tasks.length; type++) {
            const list = this.tasks[type], img = this.mgr.stampTex[type];
            if (!img || !list.length) continue;
            for (const t of list) {
                const lo = Math.max(0, t.y - this.unk48), hi = Math.min(255, t.y + this.unk48);
                const half = Math.trunc(t.size / 2), x1 = t.x - half, z1 = t.z - half, x2 = t.x + half, z2 = t.z + half;
                if (x2 <= x1 || z2 <= z1) continue;
                for (let z = Math.max(0, z1); z < Math.min(P.h, z2); z++) {
                    // texel centres across the quad: its stamp texture coordinate, nearest texel
                    const v = Math.min(img.h - 1, Math.floor(((z + 0.5 - z1) / (z2 - z1)) * img.h));
                    for (let x = Math.max(0, x1); x < Math.min(P.w, x2); x++) {
                        const k = P.index(x, z), hgt = P.depth[k];
                        if (!(hgt > lo && hi > hgt)) continue;
                        const u = Math.min(img.w - 1, Math.floor(((x + 0.5 - x1) / (x2 - x1)) * img.w));
                        const a = img.a[v * img.w + u];
                        if (!a) continue;
                        const c = this.mgr.stampKind(type) === 0 ? img.i[v * img.w + u] : 255;
                        // GX_BL_SRCALPHA / INVSRCALPHA in 8 bits
                        M[k] = (c * a + M[k] * (255 - a) + 127) / 255 | 0;
                    }
                }
            }
        }
    }
    countTexDegree() {
        this.fade();
        for (const t of this.modelTasks) drawModelStamp(this, t);
        this.stamps();
        if (this.modelTasks.length) this.cleanProhibitArea();
        this.dirty = true;
    }
    /** cleanProhibitArea: after model stamps, texels whose height map is over 200 (no ground) go clean. */
    cleanProhibitArea() { const d = this.pos.depth, M = this.map; for (let k = 0; k < M.length; k++) if (d[k] > 200) M[k] = 0; }
    degree() { let n = 0; for (const v of this.map) if (v > this.threshold) n++; return n; }
}

// ---------------------------------------------------------------- model stamps
// TPollutionManager::stampModel -> TPollutionLayer::stampModel (ground layers whose box holds the
// model's base translation) -> TPollutionCounterLayer::pushModelStampTask (20 a frame). calcViewMtx
// draws each such model, posed as it was entered, with view matrix makeWorldToPollutionMtx (texel
// x = (x - minX) / texel, texel row = (z - minZ) / texel, depth 0) into the layer's pass, after
// the fade (drawPollutionLayer) and before the joint-object / texture / revival stamps, with the
// model's own materials (TEV, blend, alpha test, culling) over the layer's texels; a layer that
// had any then has its prohibited texels (height map > 200) cleared (cleanProhibitArea).

/** One vertex group of a shape: its vertices and the draw matrices its PNMTXIDX slots load. */
interface SGroup { pos: Float32Array; slot: Uint8Array; clr: Float32Array | null; uv: Float32Array | null; idx: Uint32Array; mtxTable: Uint16Array; }
interface SStage {
    c: number[]; cop: number; cbias: number; cscale: number; cclamp: boolean; creg: number;
    a: number[]; aop: number; abias: number; ascale: number; aclamp: boolean; areg: number;
    kc: number; ka: number; tex: boolean;
}
interface SMat {
    cull: number; stages: SStage[]; konst: number[][]; regs: number[][];
    chan: { csrc: number; asrc: number; light: boolean; mat: number[]; amb: number[]; asrcAmb: number; csrcAmb: number };
    tex: Img | null; wrapS: number; wrapT: number; texMtx: mat4 | null; texSrc: number;
    blend: { mode: number; src: number; dst: number }; atest: { ca: number; ra: number; op: number; cb: number; rb: number }; colorUpdate: boolean;
}
interface SModel { shapes: { mat: number; groups: SGroup[] }[]; mats: SMat[]; drw: { kind: number; joint: number; env: number }[]; env: { j: number; w: number }[][]; invBind: mat4[]; }
interface ModelTask { m: SModel; draw: mat4[]; }

const modelCache = new Map<Uint8Array, SModel | null>();
const col = (c: { r: number; g: number; b: number; a: number }) => [c.r, c.g, c.b, c.a].map((v) => Math.max(0, Math.min(255, Math.round(v * 255))));
function readAttr(layout: any, buffers: ArrayBufferLike[], input: number, n: number, comps: number): Float32Array | null {
    const L = layout.singleVertexInputLayouts.find((l: any) => l.attrInput === input);
    if (!L) return null;
    const stride = layout.vertexBufferStrides[L.bufferIndex], dv = new DataView(buffers[L.bufferIndex] as ArrayBuffer);
    const fmt: GfxFormat = L.format, type = getFormatTypeFlags(fmt), cc = getFormatComponentCount(fmt), norm = (getFormatFlags(fmt) & FormatFlags.Normalized) !== 0;
    const out = new Float32Array(n * comps);
    for (let i = 0; i < n; i++) for (let k = 0; k < comps && k < cc; k++) {
        const o = i * stride + L.bufferOffset;
        let v: number;
        if (type === FormatTypeFlags.F32) v = dv.getFloat32(o + k * 4, true);
        else if (type === FormatTypeFlags.U8) { v = dv.getUint8(o + k); if (norm) v /= 255; }
        else if (type === FormatTypeFlags.S8) { v = dv.getInt8(o + k); if (norm) v /= 127; }
        else if (type === FormatTypeFlags.U16) { v = dv.getUint16(o + k * 2, true); if (norm) v /= 65535; }
        else if (type === FormatTypeFlags.S16) { v = dv.getInt16(o + k * 2, true); if (norm) v /= 32767; }
        else v = 0;
        out[i * comps + k] = v;
    }
    return out;
}
function loadStampModel(b: Uint8Array): SModel | null {
    if (modelCache.has(b)) return modelCache.get(b)!;
    let r: SModel | null = null;
    try {
        const bmd = BMD.parse(new ArrayBufferSlice(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength));
        const mats: SMat[] = bmd.mat3.materialEntries.map((m) => {
            const g = m.gxMaterial;
            const lc = g.lightChannels[0];
            let tex: Img | null = null, wrapS = 0, wrapT = 0;
            const ti = m.textureIndexes[0];
            if (ti !== undefined && ti >= 0 && bmd.tex1.samplers[ti]) {
                const smp = bmd.tex1.samplers[ti], td = bmd.tex1.textureDatas[smp.textureDataIndex];
                if (td && td.data) tex = decodeGX(td.format, td.width, td.height, td.data.createTypedArray(Uint8Array), 0);
                wrapS = smp.wrapS; wrapT = smp.wrapT;
            }
            const tg = g.texGens[0];
            const tm = tg && tg.matrix !== 60 ? m.texMatrices[(tg.matrix - 30) / 3] : null;
            return {
                cull: g.cullMode,
                stages: g.tevStages.map((t) => ({
                    c: [t.colorInA, t.colorInB, t.colorInC, t.colorInD], cop: t.colorOp, cbias: t.colorBias, cscale: t.colorScale, cclamp: t.colorClamp, creg: t.colorRegId,
                    a: [t.alphaInA, t.alphaInB, t.alphaInC, t.alphaInD], aop: t.alphaOp, abias: t.alphaBias, ascale: t.alphaScale, aclamp: t.alphaClamp, areg: t.alphaRegId,
                    kc: t.konstColorSel, ka: t.konstAlphaSel, tex: t.texMap !== 255,
                })),
                konst: m.colorConstants.map(col), regs: m.colorRegisters.map(col),
                chan: lc ? { csrc: lc.colorChannel.matColorSource, asrc: lc.alphaChannel.matColorSource, light: lc.colorChannel.lightingEnabled,
                    csrcAmb: lc.colorChannel.ambColorSource, asrcAmb: lc.alphaChannel.ambColorSource,
                    mat: col(m.colorMatRegs[0]), amb: col(m.colorAmbRegs[0]) }
                    : { csrc: 0, asrc: 0, light: false, csrcAmb: 0, asrcAmb: 0, mat: [255, 255, 255, 255], amb: [0, 0, 0, 0] },
                tex, wrapS, wrapT, texMtx: tm ? tm.matrix : null, texSrc: tg ? tg.source : 4,
                blend: { mode: g.ropInfo.blendMode, src: g.ropInfo.blendSrcFactor, dst: g.ropInfo.blendDstFactor },
                atest: { ca: g.alphaTest.compareA, ra: g.alphaTest.referenceA, op: g.alphaTest.op, cb: g.alphaTest.compareB, rb: g.alphaTest.referenceB },
                colorUpdate: g.ropInfo.colorUpdate,
            } as SMat;
        });
        const shapes = bmd.shp1.shapes.map((sh) => ({
            mat: sh.materialIndex,
            groups: sh.mtxGroups.map((mg) => {
                const lvd = mg.loadedVertexData, n = lvd.totalVertexCount, lay = sh.loadedVertexLayout;
                const p4 = readAttr(lay, lvd.vertexBuffers, VertexAttributeInput.POS, n, 4)!;
                const pos = new Float32Array(n * 3), slot = new Uint8Array(n);
                for (let i = 0; i < n; i++) { pos[i * 3] = p4[i * 4]; pos[i * 3 + 1] = p4[i * 4 + 1]; pos[i * 3 + 2] = p4[i * 4 + 2]; slot[i] = Math.round(p4[i * 4 + 3]); }
                const ib = lay.indexFormat === GfxFormat.U32_R ? new Uint32Array(lvd.indexData as ArrayBuffer) : new Uint16Array(lvd.indexData as ArrayBuffer);
                const idx = new Uint32Array(lvd.totalIndexCount);
                // (the indices count from the shape's first vertex; vertexId is the next group's first)
                const base = lvd.vertexId - n;
                for (let i = 0; i < idx.length; i++) idx[i] = ib[i] - base;
                return { pos, slot, clr: readAttr(lay, lvd.vertexBuffers, VertexAttributeInput.CLR0, n, 4), uv: readAttr(lay, lvd.vertexBuffers, VertexAttributeInput.TEX01, n, 2), idx, mtxTable: mg.useMtxTable } as SGroup;
            }),
        }));
        r = {
            shapes, mats,
            drw: bmd.drw1.matrixDefinitions.map((d: any) => ({ kind: d.kind, joint: d.jointIndex ?? -1, env: d.envelopeIndex ?? -1 })),
            env: bmd.evp1.envelopes.map((e: any) => e.weightedBones.map((w: any) => ({ j: w.jointIndex, w: w.weight }))),
            invBind: bmd.evp1.inverseBinds,
        };
    } catch (e) { console.warn('[game] stamp model', e); r = null; }
    modelCache.set(b, r);
    return r;
}

// TEV maths in 8 bits (GX: d + lerp(a, b, c), bias, scale, clamp; the compare ops)
const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const KSEL_FRAC = [255, 223, 191, 159, 128, 96, 64, 32];
function tevLerp(a: number, b: number, c: number) { const cc = c + (c >> 7); return (a * (256 - cc) + b * cc) >> 8; }
function tevOut(a: number, b: number, c: number, d: number, op: number, bias: number, scale: number, clampOn: boolean, cmpA = a, cmpB = b) {
    if (op >= 8) {
        // the compare ops: d + ((a OP b) ? c : 0) (R8 / RGB8 per channel; the 16/24-bit ones as R8)
        const gt = (op & 1) === 0;
        return clamp8(d + ((gt ? cmpA > cmpB : cmpA === cmpB) ? c : 0));
    }
    let v = tevLerp(a, b, c);
    v = op === 1 ? d - v : d + v;
    v += bias === 1 ? 128 : bias === 2 ? -128 : 0;
    v = scale === 1 ? v * 2 : scale === 2 ? v * 4 : scale === 3 ? v >> 1 : v;
    return clampOn ? clamp8(v) : Math.max(-1024, Math.min(1023, v));
}
function alphaCmp(f: number, v: number, ref: number) {
    switch (f) { case 0: return false; case 1: return v < ref; case 2: return v === ref; case 3: return v <= ref; case 4: return v > ref; case 5: return v !== ref; case 6: return v >= ref; default: return true; }
}
function blendFactor(f: number, isDst: boolean, sa: number, sc: number, dc: number) {
    switch (f) {
        case 0: return 0; case 1: return 255;
        case 2: return isDst ? sc : dc; case 3: return 255 - (isDst ? sc : dc);
        case 4: return sa; case 5: return 255 - sa;
        case 6: return 255; case 7: return 0;   // (the pass has no destination alpha)
        default: return 255;
    }
}
function sampleTex(img: Img, s: number, t: number, wrapS: number, wrapT: number): [number, number] {
    // bilinear, with the sampler's wrap (0 clamp, 1 repeat, 2 mirror)
    const wrap = (v: number, n: number, m: number) => {
        if (m === 1) return ((v % n) + n) % n;
        if (m === 2) { const p = ((v % (2 * n)) + 2 * n) % (2 * n); return p < n ? p : 2 * n - 1 - p; }
        return v < 0 ? 0 : v >= n ? n - 1 : v;
    };
    const x = s * img.w - 0.5, y = t * img.h - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    let I = 0, A = 0;
    for (let k = 0; k < 4; k++) {
        const xx = wrap(x0 + (k & 1), img.w, wrapS), yy = wrap(y0 + (k >> 1), img.h, wrapT);
        const w = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy);
        I += img.i[yy * img.w + xx] * w; A += img.a[yy * img.w + xx] * w;
    }
    return [Math.round(I), Math.round(A)];
}

/** The model's draw matrices (DRW1): a joint's matrix, or an envelope's weighted joints x inverse binds. */
function drawMatrices(m: SModel, joints: mat4[]): mat4[] {
    const tmp = mat4.create();
    return m.drw.map((d) => {
        if (d.kind === DRW1MatrixKind.Joint) return joints[d.joint] || mat4.create();
        const out = new Float32Array(16) as unknown as mat4;
        for (const w of m.env[d.env] || []) { mat4.mul(tmp, joints[w.j], m.invBind[w.j]); mat4.multiplyScalarAndAdd(out, out, tmp, w.w); }
        return out;
    });
}
/** The model drawn into one layer's texels: its triangles rasterised at texel centres, each pixel through its material. */
function drawModelStamp(L: Layer, task: ModelTask) {
    const P = L.pos, M = L.map, inv = P.inv, minX = L.minX, minZ = L.minZ;
    const { m, draw } = task;
    const slots: mat4[] = [];
    for (const sh of m.shapes) {
        const mat = m.mats[sh.mat];
        if (!mat || !mat.colorUpdate) continue;
        for (const g of sh.groups) {
            for (let i = 0; i < g.mtxTable.length; i++) if (g.mtxTable[i] !== 0xFFFF) slots[i] = draw[g.mtxTable[i]];
            const n = g.pos.length / 3, X = new Float32Array(n), Y = new Float32Array(n), WX = new Float32Array(n), WZ = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const d = slots[g.slot[i]] || slots[0];
                if (!d) continue;
                const px = g.pos[i * 3], py = g.pos[i * 3 + 1], pz = g.pos[i * 3 + 2];
                // (the view matrix drops world y: depth 0)
                const wx = d[0] * px + d[4] * py + d[8] * pz + d[12], wz = d[2] * px + d[6] * py + d[10] * pz + d[14];
                WX[i] = wx; WZ[i] = wz;
                X[i] = (wx - minX) * inv; Y[i] = (wz - minZ) * inv;
            }
            for (let t = 0; t + 2 < g.idx.length; t += 3) {
                const i0 = g.idx[t], i1 = g.idx[t + 1], i2 = g.idx[t + 2];
                // culling as seen from above (the pass looks down the world's y axis, x right and z down the
                // texture's rows): GX's front faces wind clockwise on screen, so their normal (right-handed)
                // points down
                const ny = (WZ[i1] - WZ[i0]) * (WX[i2] - WX[i0]) - (WX[i1] - WX[i0]) * (WZ[i2] - WZ[i0]);
                if (mat.cull === 3 || (mat.cull === 2 && ny > 0) || (mat.cull === 1 && ny < 0)) continue;
                rasterTri(L, mat, g, i0, i1, i2, X, Y, P.w, P.h, M);
            }
        }
    }
}
function rasterTri(L: Layer, mat: SMat, g: SGroup, i0: number, i1: number, i2: number, X: Float32Array, Y: Float32Array, W: number, H: number, M: Uint8Array) {
    const x0 = X[i0], y0 = Y[i0], x1 = X[i1], y1 = Y[i1], x2 = X[i2], y2 = Y[i2];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area === 0 || !isFinite(area)) return;
    const minx = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxx = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
    const miny = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxy = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
    const P = L.pos;
    for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
        const px = x + 0.5, py = y + 0.5;
        let b0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
        let b1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
        let b2 = 1 - b0 - b1;
        if (b0 < 0 || b1 < 0 || b2 < 0) continue;
        const k = P.index(x, y);
        M[k] = shadePixel(mat, g, i0, i1, i2, b0, b1, b2, M[k]);
    }
}
function shadePixel(mat: SMat, g: SGroup, i0: number, i1: number, i2: number, b0: number, b1: number, b2: number, dst: number): number {
    // the rasterised channel: material / ambient colour from the register or the vertex colour
    const vc = (c: number) => g.clr ? clamp8(Math.round((g.clr[i0 * 4 + c] * b0 + g.clr[i1 * 4 + c] * b1 + g.clr[i2 * 4 + c] * b2) * 255)) : 255;
    const ch = mat.chan;
    const mc = [0, 1, 2].map((c) => (ch.csrc === 1 ? vc(c) : ch.mat[c]));
    let ma = ch.asrc === 1 ? vc(3) : ch.mat[3];
    let ras = mc;
    if (ch.light) {
        // (no lights in the pass: material x ambient)
        const ac = [0, 1, 2].map((c) => (ch.csrcAmb === 1 ? vc(c) : ch.amb[c]));
        ras = mc.map((v, c) => (v * clamp8(ac[c])) / 255 | 0);
    }
    const rasA = ma;
    // the texture
    let tc = [255, 255, 255], ta = 255;
    if (mat.tex && g.uv) {
        let s = g.uv[i0 * 2] * b0 + g.uv[i1 * 2] * b1 + g.uv[i2 * 2] * b2, t = g.uv[i0 * 2 + 1] * b0 + g.uv[i1 * 2 + 1] * b1 + g.uv[i2 * 2 + 1] * b2;
        if (mat.texMtx) { const T = mat.texMtx; const s2 = T[0] * s + T[4] * t + T[12], t2 = T[1] * s + T[5] * t + T[13]; s = s2; t = t2; }
        const [I, A] = sampleTex(mat.tex, s, t, mat.wrapS, mat.wrapT);
        tc = [I, I, I]; ta = A;
    }
    // the TEV stages
    const reg = mat.regs.map((r) => r.slice());   // [C0, C1, C2, PREV]
    const prev = () => reg[3];
    for (const st of mat.stages) {
        const kc = st.kc <= 7 ? [KSEL_FRAC[st.kc], KSEL_FRAC[st.kc], KSEL_FRAC[st.kc]]
            : st.kc >= 0x0C && st.kc <= 0x0F ? mat.konst[st.kc - 0x0C].slice(0, 3)
            : st.kc >= 0x10 ? (() => { const kk = mat.konst[(st.kc - 0x10) & 3][((st.kc - 0x10) >> 2)]; return [kk, kk, kk]; })() : [255, 255, 255];
        const ka = st.ka <= 7 ? KSEL_FRAC[st.ka] : st.ka >= 0x10 ? mat.konst[(st.ka - 0x10) & 3][(st.ka - 0x10) >> 2] : 255;
        const T = st.tex ? tc : [255, 255, 255], TA = st.tex ? ta : 255;
        const cin = (sel: number, c: number) => {
            switch (sel) {
                case 0: return prev()[c]; case 1: return prev()[3]; case 2: return reg[0][c]; case 3: return reg[0][3];
                case 4: return reg[1][c]; case 5: return reg[1][3]; case 6: return reg[2][c]; case 7: return reg[2][3];
                case 8: return T[c]; case 9: return TA; case 10: return ras[c]; case 11: return rasA;
                case 12: return 255; case 13: return 128; case 14: return kc[c]; default: return 0;
            }
        };
        const ain = (sel: number) => {
            switch (sel) { case 0: return prev()[3]; case 1: return reg[0][3]; case 2: return reg[1][3]; case 3: return reg[2][3]; case 4: return TA; case 5: return rasA; case 6: return ka; default: return 0; }
        };
        const outC = [0, 1, 2].map((c) => {
            const a = cin(st.c[0], c) & 255, b = cin(st.c[1], c) & 255, cc = cin(st.c[2], c) & 255, d = cin(st.c[3], c);
            return tevOut(a, b, cc, d, st.cop, st.cbias, st.cscale, st.cclamp);
        });
        const aa = ain(st.a[0]) & 255, ab = ain(st.a[1]) & 255, ac = ain(st.a[2]) & 255, ad = ain(st.a[3]);
        const outA = tevOut(aa, ab, ac, ad, st.aop, st.abias, st.ascale, st.aclamp);
        const cr = st.creg === 0 ? 3 : st.creg - 1, ar = st.areg === 0 ? 3 : st.areg - 1;
        reg[cr][0] = outC[0]; reg[cr][1] = outC[1]; reg[cr][2] = outC[2];
        reg[ar][3] = outA;
    }
    const out = reg[3].map(clamp8);
    // the alpha test
    const at = mat.atest, pa = alphaCmp(at.ca, out[3], at.ra), pb = alphaCmp(at.cb, out[3], at.rb);
    const pass = at.op === 0 ? pa && pb : at.op === 1 ? pa || pb : at.op === 2 ? pa !== pb : pa === pb;
    if (!pass) return dst;
    // the colour written: its intensity (the pass copies the layer back as I8)
    const src = (out[0] * 77 + out[1] * 150 + out[2] * 29 + 128) >> 8;
    const b = mat.blend;
    if (b.mode === 1) {
        const sf = blendFactor(b.src, false, out[3], src, dst), df = blendFactor(b.dst, true, out[3], src, dst);
        return clamp8(Math.round((src * sf + dst * df) / 255));
    }
    if (b.mode === 3) return clamp8(dst - src);
    return src;
}

/** TPollutionManager ("落書き管理") */
export class Pollution {
    layers: Layer[] = [];
    /** Stamp shapes by stamp type: 0 clean (common/map/clean.bti), 1 pollute (pollute.bti), 2+ registered by enemies. */
    stampTex: (Img | null)[] = [];
    private stampTypes: number[] = [0, 1];
    private modelTaskNum = 0;
    constructor(public files: Files, map: number, stage: number, common: (p: string) => Uint8Array | null) {
        const ymp = files.scene('map/ymap.ymp');
        if (!ymp) return;
        const v = new DataView(ymp.buffer, ymp.byteOffset, ymp.byteLength);
        const n = v.getUint16(0), infos = v.getUint32(4);
        const names = map === 9 && stage !== 7
            ? ['pollution00', 'pollution01', 'pollution02', 'pollution03', 'pollution04', 'pollution05', 'pollution06', 'pollutionA', 'pollutionB']
            : Array.from({ length: 20 }, (_, i) => 'pollution' + String(i).padStart(2, '0'));
        for (let i = 0; i < n && i < names.length; i++) {
            const o = infos + i * 0x2C;
            const plane = v.getUint16(o + 4);
            if (plane > 6) continue;
            const L = new Layer(this, this.layers.length, plane, names[i]);
            L.initLayerInfo(v.getUint16(o), v.getUint16(o + 2), v.getFloat32(o + 0x10), v.getFloat32(o + 0x14), v.getFloat32(o + 0x18), v.getFloat32(o + 0x1C));
            const lw = v.getUint16(o + 0x20), lh = v.getUint16(o + 0x22);
            const hm = v.getUint32(o + 0x28);
            L.pos.init(v.getFloat32(o + 8), v.getFloat32(o + 0xC), ymp.subarray(hm, hm + (1 << lw) * (1 << lh)), lw, lh);
            // the texture: the layer model's texture 0 (the wave layer: its own .bti); I8 in the same tiles
            const tex = plane === 6 ? null : bmdTexture0(files.scene(`map/pollution/${names[i]}.bmd`) || new Uint8Array(0));
            L.map = new Uint8Array((1 << lw) * (1 << lh));
            if (tex && tex.fmt === 1) L.map.set(tex.data.subarray(tex.off, tex.off + L.map.length));
            L.initTexImage(files.scene(`map/pollution/${names[i]}.bmp`), map === 9);
            this.layers.push(L);
        }
        const bti = (p: string) => { const b = common(p); return b ? parseBTI(b) : null; };
        this.stampTex[0] = bti('map/clean.bti');
        this.stampTex[1] = bti('map/pollute.bti');
    }
    /** TPollutionCounterLayer::registerTexStamp: another stamp shape (an enemy's mark). Its stamp type. */
    registerTexStamp(kind: number, img: Img | null) { this.stampTypes.push(kind); this.stampTex.push(img); for (const L of this.layers) L.tasks.push([]); return this.stampTypes.length - 1; }
    stampIsCleanType(type: number) { return this.stampTypes[type] === 0; }
    stampKind(type: number) { return this.stampTypes[type]; }
    pushStampTask(type: number, L: Layer, size: number, x: number, z: number, y: number) {
        const q = L.tasks[type];
        if (!q || q.length >= 0xFF) return;
        q.push({ x: x & 0xFFFF, z: z & 0xFFFF, size: size & 0xFFFF, y: (y << 16) >> 16 });
    }
    stamp(type: number, x: number, y: number, z: number, size: number) { for (const L of this.layers) L.stamp(type, x, y, z, size); }
    clean(x: number, y: number, z: number, size: number, map: number) { if (map === 1 && y < -10) return; this.stamp(0, x, y, z, size); }
    stampGround(type: number, x: number, y: number, z: number, size: number) { for (const L of this.layers) if (L.planeType === 0) L.stamp(type, x, y, z, size); }
    /**
     * stampModel(J3DModel*): the model (its MActor, posed now: base TR matrix and scale, the BCK at
     * its frame) drawn into the ground layers whose box holds its base translation.
     */
    stampModel(a: MActor, baseTR: Mtx, scale: { x: number; y: number; z: number }) {
        const x = baseTR[3], z = baseTR[11];
        let joints: mat4[] | null = null, m: SModel | null = null;
        for (const L of this.layers) {
            if (L.planeType !== 0) continue;
            if (x < L.minX || z < L.minZ || x >= L.maxX || z >= L.maxZ) continue;
            // pushModelStampTask: 20 a frame
            if (this.modelTaskNum >= 20) return;
            if (!m) {
                const b = this.files.scene(a.model);
                m = b ? loadStampModel(b) : null;
                if (!m) return;
                joints = a.anmMtxAll(baseTR, scale as any);
                if (!joints) return;
            }
            this.modelTaskNum++;
            L.modelTasks.push({ m, draw: drawMatrices(m, joints!) });
        }
    }
    isPolluted(x: number, y: number, z: number) { for (const L of this.layers) if (L.isPolluted(x, y, z)) return true; return false; }
    getPollutionType(x: number, y: number, z: number) { for (const L of this.layers) if (L.isInArea(x, y, z)) return L.type; return POLLUTION_TYPE.UNK10; }
    getPollutionDegree() { let n = 0; for (const L of this.layers) n += L.degree(); return n; }
    /** The graffiti group's movement: each layer's action. */
    move(mario: { x: number, y: number, z: number }) { for (const L of this.layers) L.action(mario); }
    /** The frame's draw: fades, stamps, then the queues empty (resetTask). */
    draw() {
        for (const L of this.layers) L.countTexDegree();
        for (const L of this.layers) { for (const q of L.tasks) q.length = 0; L.modelTasks.length = 0; }
        this.modelTaskNum = 0;
    }
}
