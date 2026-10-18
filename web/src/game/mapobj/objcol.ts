// A map object's own collision (Map/MapCollisionManager.cpp, MapCollisionEntry.cpp, MapMakeData.cpp):
// TMapCollisionManager holds a few .col files; the active one is put into the map's grid as its
// kind says — static (added to the static grid once, where setUp first puts it), warp (added to
// the static grid and taken out again: remove) or move (re-added to the move grid every tick it's
// moved; TMap::perform empties that grid each tick).

import { fr, V3, Mtx, mtx, MsSin, MsCos } from '../math.js';
import type { World, LiveActor } from '../engine.js';
import { BGCheckData } from '../collision.js';

export const KIND_STATIC = 0, KIND_MOVE = 1, KIND_WARP = 2;
export const COL_NEEDS_SETUP = 0x1, COL_UNK4000 = 0x4000, COL_UNK8000 = 0x8000;

/** MsMtxSetTRS (row-major 3x4) */
export function MsMtxSetTRS(m: Mtx, x: number, y: number, z: number, r: number, p: number, h: number, sx: number, sy: number, sz: number) {
    const sr = MsSin(r), sp = MsSin(p), sh = MsSin(h), cr = MsCos(r), cp = MsCos(p), ch = MsCos(h);
    m[0] = fr(fr(ch * cp) * sx); m[4] = fr(fr(sh * cp) * sx); m[8] = fr(-sp * sx);
    m[1] = fr(fr(sr * fr(ch * sp) - fr(sh * cr)) * sy); m[5] = fr(fr(sr * fr(sh * sp) + fr(ch * cr)) * sy); m[9] = fr(fr(cp * sr) * sy);
    m[2] = fr(fr(cr * fr(ch * sp) + fr(sh * sr)) * sz); m[6] = fr(fr(cr * fr(sh * sp) - fr(ch * sr)) * sz); m[10] = fr(fr(cp * cr) * sz);
    m[3] = x; m[7] = y; m[11] = z;
}

interface ColFile {
    verts: number[][];
    groups: { bgType: number; num: number; flags: number; io: number; so: number; uo: number; ao: number }[];
    v: DataView;
}
function readColFile(b: Uint8Array): ColFile {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const nv = v.getUint32(0), vo = v.getUint32(4), ng = v.getUint32(8), go = v.getUint32(12);
    const verts: number[][] = [];
    for (let i = 0; i < nv; i++) verts.push([v.getFloat32(vo + i * 12), v.getFloat32(vo + i * 12 + 4), v.getFloat32(vo + i * 12 + 8)]);
    const groups = [];
    for (let g = 0; g < ng; g++) {
        const o = go + g * 0x18;
        groups.push({ bgType: v.getUint16(o), num: v.getInt16(o + 2), flags: v.getUint16(o + 4), io: v.getUint32(o + 8), so: v.getUint32(o + 12), uo: v.getUint32(o + 16), ao: v.getUint32(o + 20) });
    }
    return { verts, groups, v };
}

/** TMapCollisionBase and its three kinds. */
export class ObjCollision {
    checks: BGCheckData[] = [];
    flags = 0;
    unk20: Mtx = mtx();
    prev = new V3();
    file: ColFile | null = null;
    constructor(public w: World, public kind: number, public owner: LiveActor | null) { }
    private gridKind() { return this.kind === KIND_MOVE ? 'move' : 'static'; }
    private add(d: BGCheckData) { this.w.col.add(d, this.gridKind()); }
    /** loadCollisionData: "/scene/<path>.col" */
    init(path: string, flags: number) {
        let p = path.replace(/^\//, '');
        if (!/\.col$/i.test(p)) p = p + '.col';
        const b = this.w.files.scene(p.toLowerCase());
        if (b) this.file = readColFile(b);
        if (flags & 0x8000) this.flags |= COL_UNK8000;
        if (this.kind === KIND_STATIC) {
            if (!(flags & 2)) this.initCheckData(-9999, flags);
            else this.flags |= COL_NEEDS_SETUP;
        } else {
            this.initCheckData(-9999, flags | 2);
            this.flags |= COL_NEEDS_SETUP;
        }
    }
    private xf(m: Mtx, p: number[]) {
        return [fr(m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3]), fr(m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7]), fr(m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11])];
    }
    /** updateVertexPos: MTXMultVecArray(unk20, the vertices) */
    private vertexPos(): number[][] { return this.file ? this.file.verts.map((p) => this.xf(this.unk20, p)) : []; }
    /** initCheckData / initAllCheckData: one check data per triangle of every group. */
    initCheckData(def: number, f: number) {
        this.prev.set(this.unk20[3], this.unk20[7], this.unk20[11]);
        const verts = f & 4 ? (this.file ? this.file.verts : []) : this.vertexPos();
        this.checks = [];
        if (!this.file) return;
        const v = this.file.v;
        for (const g of this.file.groups) {
            for (let j = 0; j < g.num; j++) {
                const d = new BGCheckData();
                d.bgType = g.bgType; d.actor = this.owner;
                const i0 = v.getInt16(g.io + j * 6), i1 = v.getInt16(g.io + j * 6 + 2), i2 = v.getInt16(g.io + j * 6 + 4);
                d.setVertex(verts[i0], verts[i1], verts[i2]);
                if (!(f & 2)) this.add(d);
                d.data = (g.flags & 1) && g.ao ? v.getInt16(g.ao + j * 2) : def;
                d.soundMaterial = v.getUint8(g.so + j); d.unk7 = v.getUint8(g.uo + j);
                this.checks.push(d);
            }
        }
    }
    /** update: the vertices by unk20, every check data from the first group's indices on (the game's: one group assumed). */
    update() {
        if (!this.file || !this.checks.length) return;
        const verts = this.vertexPos(), v = this.file.v, io = this.file.groups[0].io;
        for (let i = 0; i < this.checks.length; i++) {
            const d = this.checks[i];
            d.setVertex(verts[v.getInt16(io + i * 6)], verts[v.getInt16(io + i * 6 + 2)], verts[v.getInt16(io + i * 6 + 4)]);
            this.add(d);
        }
    }
    /** updateTrans: every check data moved by the change from the last translation. */
    updateTrans(t: V3) {
        const dx = fr(t.x - this.prev.x), dy = fr(t.y - this.prev.y), dz = fr(t.z - this.prev.z);
        for (const d of this.checks) {
            for (const p of [d.p1, d.p2, d.p3]) { p[0] = fr(p[0] + dx); p[1] = fr(p[1] + dy); p[2] = fr(p[2] + dz); }
            d.minY = fr(d.minY + dy); d.maxY = fr(d.maxY + dy);
            d.d = fr(-(d.n[0] * d.p1[0] + d.n[1] * d.p1[1] + d.n[2] * d.p1[2]));
            this.add(d);
        }
        this.prev.set(t);
    }
    /** setList: the check data as they are, into the grid again */
    setList() { for (const d of this.checks) this.add(d); }
    isSetUp() { return !(this.flags & COL_NEEDS_SETUP); }
    setUpMtx(m: Mtx) { this.unk20.set(m); this.setUp(); }
    setUp() {
        if (this.kind === KIND_STATIC) {
            if (this.checks.length) return;
            this.flags &= ~COL_NEEDS_SETUP;
            this.initCheckData(-9999, this.file && this.file.verts.length >= 350 ? 4 : 0);
        } else if (this.kind === KIND_WARP) {
            if (!(this.flags & COL_NEEDS_SETUP)) return;
            this.flags &= ~COL_NEEDS_SETUP;
            if (this.flags & COL_UNK8000) this.updateTrans(new V3(this.unk20[3], this.unk20[7], this.unk20[11]));
            else this.update();
        } else this.flags &= ~COL_NEEDS_SETUP;
    }
    remove() {
        if (this.kind === KIND_STATIC) return;
        if (this.kind === KIND_WARP) {
            if (!this.isSetUp()) return;
            this.flags |= COL_NEEDS_SETUP;
            for (const d of this.checks) this.w.col.remove(d);
            return;
        }
        this.flags |= COL_NEEDS_SETUP;
    }
    // TMapCollisionMove
    move() {
        if (this.flags & COL_NEEDS_SETUP) return;
        if (this.flags & COL_UNK4000) { this.setList(); return; }
        if (this.flags & COL_UNK8000) this.updateTrans(new V3(this.unk20[3], this.unk20[7], this.unk20[11]));
        else this.update();
    }
    moveTrans(t: V3) {
        if (this.kind !== KIND_MOVE) return;
        if (this.flags & COL_NEEDS_SETUP) return;
        if (this.flags & COL_UNK4000) { this.setList(); return; }
        this.updateTrans(t);
    }
    moveSRT(p: V3, r: V3, s: V3) {
        if (this.kind !== KIND_MOVE) return;
        MsMtxSetTRS(this.unk20, p.x, p.y, p.z, r.x, r.y, r.z, s.x, s.y, s.z);
        this.move();
    }
    moveMtx(m: Mtx) {
        if (this.kind !== KIND_MOVE) return;
        this.unk20.set(m);
        this.move();
    }
    setAllBGType(t: number) { for (const d of this.checks) d.bgType = t; }
}

/** TMapCollisionManager */
export class ObjCollisionManager {
    entries: ObjCollision[] = [];
    active: ObjCollision | null = null;
    constructor(public w: World, public max: number, public folder: string | null, public owner: LiveActor | null) { }
    /** init(col_file, flags, folder): "<folder>/<file>", its kind flags & 3 */
    init(file: string, flags: number, folder: string | null = null) {
        if (!this.folder) this.folder = folder;
        const kind = flags & 3;
        const c = new ObjCollision(this.w, kind, this.owner);
        const dir = this.folder ? (this.folder[0] !== '/' ? '/' + this.folder : this.folder) : '';
        const full = file[0] !== '/' ? dir + '/' + file : dir + file;
        c.init(full, (flags & 0xFFFC) | 2);
        this.active = this.entries.length === 0 ? c : null;
        if (kind === 0) this.active = c;
        this.entries.push(c);
    }
    changeCollision(i: number) {
        if (i < this.entries.length && this.active !== this.entries[i]) {
            if (this.active) this.active.remove();
            this.active = this.entries[i];
        }
    }
    getActiveCollision() { return this.active; }
    removeActiveCollision() { if (this.active) this.active.remove(); }
    moveActiveCollisionTrans(t: V3) { if (this.active) this.active.moveTrans(t); }
    moveActiveCollisionMtx(m: Mtx) { if (this.active) this.active.moveMtx(m); }
    moveActiveCollisionSRT(p: V3, r: V3, s: V3) { if (this.active) this.active.moveSRT(p, r, s); }
    setUpActiveCollisionTRS(p: V3, r: V3, s: V3) {
        const m = mtx();
        MsMtxSetTRS(m, p.x, p.y, p.z, r.x, r.y, r.z, s.x, s.y, s.z);
        this.active!.setUpMtx(m);
    }
    /** (LiveActor.mapCollision's shape: hasMapCollision) */
    moveSRT(p: V3, r: V3, s: V3) { this.moveActiveCollisionSRT(p, r, s); }
}
