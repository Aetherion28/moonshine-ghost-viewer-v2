// Goop (Map/Pollution*.cpp): TPollutionManager's layers, each an I8 texture over a stretch of
// the stage (TPollutionPos: texel size, a depth map of the ground under it), what's polluted
// (isPolluted: above the layer's threshold, at the depth there), and the stamps that clean or
// goop it. The game draws the stamps on the GPU once a frame (TPollutionCounterLayer::
// countTexDegree, in the frame's draw lists) and copies the result back over the texture; here
// the same TEV and blend maths run on the CPU over the same texel layout (GX I8 tiles).

import { MsRandF } from './math.js';
import type { Files } from './engine.js';

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
        this.stamps();
        this.dirty = true;
    }
    degree() { let n = 0; for (const v of this.map) if (v > this.threshold) n++; return n; }
}

/** TPollutionManager ("落書き管理") */
export class Pollution {
    layers: Layer[] = [];
    /** Stamp shapes by stamp type: 0 clean (common/map/clean.bti), 1 pollute (pollute.bti), 2+ registered by enemies. */
    stampTex: (Img | null)[] = [];
    private stampTypes: number[] = [0, 1];
    constructor(files: Files, map: number, stage: number, common: (p: string) => Uint8Array | null) {
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
    isPolluted(x: number, y: number, z: number) { for (const L of this.layers) if (L.isPolluted(x, y, z)) return true; return false; }
    getPollutionType(x: number, y: number, z: number) { for (const L of this.layers) if (L.isInArea(x, y, z)) return L.type; return POLLUTION_TYPE.UNK10; }
    getPollutionDegree() { let n = 0; for (const L of this.layers) n += L.degree(); return n; }
    /** The graffiti group's movement: each layer's action. */
    move(mario: { x: number, y: number, z: number }) { for (const L of this.layers) L.action(mario); }
    /** The frame's draw: fades, stamps, then the queues empty (resetTask). */
    draw() {
        for (const L of this.layers) L.countTexDegree();
        for (const L of this.layers) for (const q of L.tasks) q.length = 0;
    }
}
