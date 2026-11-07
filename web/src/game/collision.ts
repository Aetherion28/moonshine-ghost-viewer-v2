// The game's map collision (TMapCollisionData), ported from the decomp (the public decomp, Aetherion28/SMS-Decomp-JP-1.0 and its regional repositories):
// Map/MapCollisionData.cpp (the grid), Map/MapMakeData.cpp (TBGCheckData::setVertex),
// Map/MapMakeList.cpp (which grid cells and lists a triangle goes in, in what order),
// Map/MapArea.cpp (polygonIsInGrid), Map/MapData.cpp (getPlaneType) and Map/MapCheck.cpp
// (checkGround / checkRoof / checkWalls / intersectLine). Floats are kept to f32 where the game
// stores them, so the same queries give the same answers.
//
// The grid is 1024-unit cells; each cell has a ground, a roof and a wall list. Static collision
// (map/map.col, map objects' own .col placed once) goes in the static grid (unk14), moving
// collision (lifts, rotating platforms) in the move grid (unk18), which the game clears and
// refills every frame (initMoveCollision, then each mover's setList).

const f = Math.fround;
import { fmadd as FMA, fnmsub as FNMS, fmsub as FMS } from './player/fmath.js';
import { frsqrte, mslAtan2f } from './math.js';
import { jgSqrt } from './vecops.js';
const f64 = new Float64Array(1), i64 = new BigUint64Array(f64.buffer);
/** Dolphin's Force25Bit (camera/lib.ts has the same): a single multiply's second operand */
function force25(d: number) { f64[0] = d; const b = i64[0]; i64[0] = (b & 0xFFFFFFFFF8000000n) + (b & 0x8000000n); return f64[0]; }
/** a paired multiply's lane 1 (camera/lib.ts trunc25) */
function trunc25(d: number) { f64[0] = d; i64[0] = i64[0] & 0xFFFFFFFFF0000000n; return f64[0]; }

export const enum BG {
    WATER = 0x100, DAMAGING_WATER = 0x101, SEA_WATER = 0x102, DAMAGING_SEA_WATER = 0x103, POOL = 0x104, INDOOR_POOL = 0x105,
    CLIMBABLE_FENCE = 0x10A, MAP_WARP_PHASE_THROUGH = 0x201, MAP_CHANGE_PHASE_THROUGH = 0x203,
    ONLY_MARIO_PHASES_THROUGH = 0x400, ONLY_WATER_PHASES_THROUGH = 0x401, ONLY_ENEMIES_PHASE_THROUGH = 0x402,
    DEATH_PLANE = 0x800, EVERYTHING_BUT_MAP_OBJECTS_PHASE_THROUGH = 0x801,
    SHADED_POOL = 0x4104, CAM_NOCLIP_ONLY_MARIO_PHASES_THROUGH = 0x8400,
}
const FLAG_X_FACING = 0x8, FLAG_ILLEGAL = 0x10;

export class BGCheckData {
    bgType = 0; data = 0; flags = 0; soundMaterial = 0; unk7 = 0;
    minY = 0; maxY = 0;
    p1 = [0, 0, 0]; p2 = [0, 0, 0]; p3 = [0, 0, 0];
    n = [0, 0, 0]; d = 0;
    /** The live actor whose collision this is (map objects), else null. */
    actor: any = null;

    /** TBGCheckData::setVertex */
    setVertex(a: number[], b: number[], c: number[]) {
        this.p1 = a.map(f); this.p2 = b.map(f); this.p3 = c.map(f);
        const [p1, p2, p3] = [this.p1, this.p2, this.p3];
        // (the DOL: each component a fmuls then a fused fmsubs)
        let nx = FMS(f(p2[1] - p1[1]), f(p3[2] - p2[2]), f(f(p2[2] - p1[2]) * f(p3[1] - p2[1])));
        let ny = FMS(f(p2[2] - p1[2]), f(p3[0] - p2[0]), f(f(p2[0] - p1[0]) * f(p3[2] - p2[2])));
        let nz = FMS(f(p2[0] - p1[0]), f(p3[1] - p2[1]), f(f(p2[1] - p1[1]) * f(p3[0] - p2[0])));
        if (nx !== 0 || ny !== 0 || nz !== 0) {
            // MsVECNormalize: the raw frsqrte estimate, no Newton step (so a flat floor's n.y is
            // rarely exactly 1: TMapObjGeneral::calcVelocity's n.y == 1 test relies on it)
            const s = f(FMA(nz, nz, f(nx * nx)) + f(ny * ny));
            const r = frsqrte(s), e = force25(r);
            // (ps_muls0 for x and y, lane 1 taking the estimate truncated: camera/lib.ts trunc25; fmuls for z)
            nx = f(nx * e); ny = f(ny * trunc25(r)); nz = f(nz * e);
            this.n = [nx, ny, nz];
            // (fmuls, fmadds, fnmadds)
            this.d = -FMA(nz, p1[2], FMA(nx, p1[0], f(ny * p1[1])));
            this.minY = Math.min(p1[1], p2[1], p3[1]);
            this.maxY = Math.max(p1[1], p2[1], p3[1]);
        }
    }

    /** TBGCheckData::updateTrans */
    updateTrans(t: number[]) {
        for (const p of [this.p1, this.p2, this.p3]) for (let i = 0; i < 3; i++) p[i] = f(p[i] + t[i]);
        this.minY = f(this.minY + t[1]); this.maxY = f(this.maxY + t[1]);
        this.d = -FMA(this.n[2], this.p1[2], FMA(this.n[0], this.p1[0], f(this.n[1] * this.p1[1])));   // (fmuls, fmadds, fnmadds)
    }

    /** TBGCheckData::getPlaneType: 0 ground, 1 roof, 2 wall. */
    planeType() {
        if (this.isEverythingButMapObjectsThrough()) return 0;
        if (this.n[1] > 0.2) return 0;
        if (this.n[1] < -0.2) return 1;
        if (this.n[0] < -0.707 || 0.707 < this.n[0]) this.flags |= FLAG_X_FACING;
        else this.flags &= ~FLAG_X_FACING;
        return 2;
    }

    /** isIllegalData */
    isIllegalData() { return !!(this.flags & FLAG_ILLEGAL); }
    isIllegal() { return this.isIllegalData(); }
    /** isUnk700 */
    isUnk700() { return this.bgType === 0x700; }
    isLegal() { return !this.isIllegal(); }
    isWaterSlip() { const t = this.bgType; return t === 0x500 || t === 0x4004 || t === 0x8004 || t === 0xC004; }
    isPool() { const t = this.bgType; return t === BG.POOL || t === BG.INDOOR_POOL || t === BG.SHADED_POOL; }
    isDeathPlane() { return this.bgType === BG.DEATH_PLANE; }
    isEverythingButMapObjectsThrough() { return this.bgType === BG.EVERYTHING_BUT_MAP_OBJECTS_PHASE_THROUGH; }
    isSea() { const t = this.bgType; return t === BG.SEA_WATER || t === BG.DAMAGING_SEA_WATER; }
    isWaterSurface() {
        const t = this.bgType;
        return t === BG.WATER || t === BG.DAMAGING_WATER || t === BG.SEA_WATER || t === BG.DAMAGING_SEA_WATER || t === BG.POOL || t === BG.INDOOR_POOL || t === BG.SHADED_POOL;
    }
    isWaterThrough() {
        const t = this.bgType;
        return t === BG.ONLY_WATER_PHASES_THROUGH || t === BG.EVERYTHING_BUT_MAP_OBJECTS_PHASE_THROUGH || t === BG.CLIMBABLE_FENCE || t === BG.CAM_NOCLIP_ONLY_MARIO_PHASES_THROUGH;
    }
    isMarioThrough() {
        const t = this.bgType;
        return t === BG.ONLY_MARIO_PHASES_THROUGH || t === BG.CAM_NOCLIP_ONLY_MARIO_PHASES_THROUGH || t === BG.WATER || t === BG.DAMAGING_WATER
            || t === BG.SEA_WATER || t === BG.DAMAGING_SEA_WATER || t === BG.DEATH_PLANE || t === BG.EVERYTHING_BUT_MAP_OBJECTS_PHASE_THROUGH
            || t === BG.MAP_WARP_PHASE_THROUGH || t === BG.MAP_CHANGE_PHASE_THROUGH;
    }
}

/** TBGCheckList: a grid list's node (a root's own node is the list's head sentinel, its data null). */
export class BGCheckList { next: BGCheckList | null = null; data: BGCheckData | null = null; preNode: BGCheckList | null = null; }
/** TBGCheckListWarp: a warp collision's node, which also keeps its previous node and its cell (unk10 x, unk12 z). */
export class BGCheckListWarp extends BGCheckList { unk10 = 0; unk12 = 0; }
/** TBGCheckListRoot: a cell's three list heads (ground, roof, wall). */
export class BGCheckListRoot { unk0 = [new BGCheckList(), new BGCheckList(), new BGCheckList()]; }
type Node = BGCheckList;
const KIND_STATIC = 0, KIND_MOVE = 1, KIND_WARP = 2;

/** addGroundNode / addRoofNode / addWallNode: the node to insert after. */
function addGroundNode(l: BGCheckList, d: BGCheckData) {
    while (l.next) { const n = l.next, o = n.data!; if (d.minY > o.minY || (d.minY === o.minY && d.maxY > o.maxY)) return l; l = n; }
    return l;
}
function addRoofNode(l: BGCheckList, d: BGCheckData) {
    while (l.next) { const n = l.next, o = n.data!; if (d.maxY < o.maxY || (d.maxY === o.maxY && d.minY < o.minY)) return l; l = n; }
    return l;
}
function addWallNode(l: BGCheckList, d: BGCheckData) {
    while (l.next) { const n = l.next, o = n.data!; if (d.maxY > o.maxY || (d.maxY === o.maxY && d.minY > o.minY)) return l; l = n; }
    return l;
}
/** addAfterPreNode */
function addAfterPreNode(x: number, z: number, pre: BGCheckList, node: BGCheckList, kind: number) {
    node.next = pre.next;
    if (kind === KIND_WARP) { const w = node as BGCheckListWarp; w.unk10 = x; w.unk12 = z; w.preNode = pre; }
    if (pre.next) pre.next.preNode = node;
    pre.next = node;
}

/** checkGround / checkWalls flags (TMapCollisionData, TBGWallCheckRecord). */
export const IGNORE_WATER_SURFACE = 0x1, DONT_MOVE_XZ = 0x2, IGNORE_WATER_THROUGH = 0x4;

export interface WallCheck {
    center: number[]; radius: number; maxResults: number; flags: number;
    results: BGCheckData[];
}

/** checkGroundList / checkRoofList's edge test: (a.z - z) * (b.x - a.x) - (a.x - x) * (b.z - a.z) (fmuls, then fmsubs) */
const edge = (a: number[], b: number[], x: number, z: number) => FMS(f(a[2] - z), f(b[0] - a[0]), f(f(a[0] - x) * f(b[2] - a[2])));
/** the plane's height at (x, z): -(x * nx + z * nz + d) / ny (fmuls, fmadds, fadds, fdivs) */
const planeY = (d: BGCheckData, x: number, z: number) => f(-f(d.d + FMA(x, d.n[0], f(z * d.n[2]))) / d.n[1]);

export class MapCollision {
    /** mGridExtentX / Y: half the grid's size. */
    ex = 0; ez = 0;
    nx = 0; nz = 0;
    /** mStaticGrid (static and warp lists), mMoveGrid */
    private stat: BGCheckListRoot[] = [];
    private move: BGCheckListRoot[] = [];
    /** each warp check data's nodes (its range of mWarpCheckListPool, which TMapCollisionWarp::remove takes out) */
    private warpNodes = new Map<BGCheckData, BGCheckListWarp[]>();
    readonly illegal = new BGCheckData();
    /** Ground planes (TMapCollisionPlane), checked with the static grid. */
    groundPlane: { checkPlaneGround(x: number, y: number, z: number): [number, BGCheckData] } | null = null;

    /** TMapCollisionData::init: the grid's cell counts from the scene's map object. */
    constructor(cellsX: number, cellsZ: number) {
        this.nx = cellsX; this.nz = cellsZ;
        this.ex = f(Math.trunc(cellsX / 2) * 1024); this.ez = f(Math.trunc(cellsZ / 2) * 1024);
        const n = cellsX * cellsZ;
        for (let i = 0; i < n; i++) { this.stat.push(new BGCheckListRoot()); this.move.push(new BGCheckListRoot()); }
        this.illegal.setVertex([-32767, -32767, -32767], [-32767, -32767, 32767], [32767, -32767, 32767]);
        this.illegal.flags |= FLAG_ILLEGAL;
    }

    /** initMoveCollision: the moving collision's grid starts each frame empty. */
    clearMove() { for (const c of this.move) { c.unk0[0].next = c.unk0[1].next = c.unk0[2].next = null; } }

    // ------------------------------------------------------------ building
    /** getGridArea: the cells a triangle's XZ box covers (walls widened by 80). */
    private gridArea(d: BGCheckData, type: number): [number, number, number, number] | null {
        let minX = Math.min(d.p1[0], d.p2[0], d.p3[0]), minZ = Math.min(d.p1[2], d.p2[2], d.p3[2]);
        let maxX = Math.max(d.p1[0], d.p2[0], d.p3[0]), maxZ = Math.max(d.p1[2], d.p2[2], d.p3[2]);
        if (maxX < -this.ex || maxZ < -this.ez || minX > this.ex || minZ > this.ez) return null;
        if (type === 2) { minX = f(minX - 80); minZ = f(minZ - 80); maxX = f(maxX + 80); maxZ = f(maxZ + 80); }
        const x0 = Math.max(0, this.toGridX(minX)), x1 = Math.min(this.nx - 1, this.toGridX(maxX));
        const z0 = Math.max(0, this.toGridZ(minZ)), z1 = Math.min(this.nz - 1, this.toGridZ(maxZ));
        return [x0, z0, x1, z1];
    }

    /** worldToGridX / Z: (int)((x + extent) * (1 / 1024)) (fadds, fmuls) */
    private toGridX(x: number) { return Math.trunc(f(x + this.ex) * 0.0009765625); }
    private toGridZ(z: number) { return Math.trunc(f(z + this.ez) * 0.0009765625); }
    /** gridToWorldX / Z: (int)(x * 1024.0f - extent) */
    private toWorldX(x: number) { return Math.trunc(f(f(x * 1024) - this.ex)); }
    private toWorldZ(z: number) { return Math.trunc(f(f(z * 1024) - this.ez)); }

    /** addCheckDataToGrid: kind 'static', 'move' or 'warp' (warp lists are in the static grid). */
    add(d: BGCheckData, kind: 'static' | 'move' | 'warp') {
        const k = kind === 'move' ? KIND_MOVE : kind === 'warp' ? KIND_WARP : KIND_STATIC;
        const type = d.planeType();
        const a = this.gridArea(d, type);
        if (!a) return;
        const [x0, z0, x1, z1] = a;
        for (let z = z0; z <= z1; z++)
            for (let x = x0; x <= x1; x++) {
                if (k === KIND_MOVE) this.addCheckDataToList(z, x, k, type, d);
                else if (type !== 2) {
                    const maxZ = this.toWorldZ(z + 1), maxX = this.toWorldX(x + 1), minZ = this.toWorldZ(z), minX = this.toWorldX(x);
                    if (polygonIsInGrid(minX, minZ, maxX, maxZ, d)) this.addCheckDataToList(z, x, k, type, d);
                } else {
                    const maxZ = this.toWorldZ(z + 1), maxX = this.toWorldX(x + 1), minZ = this.toWorldZ(z), minX = this.toWorldX(x);
                    if (polygonIsInGrid(minX - 80, minZ - 80, maxX + 80, maxZ + 80, d)) this.addCheckDataToList(z, x, k, type, d);
                }
            }
    }
    /** getListRoot */
    private listRoot(z: number, x: number, kind: number, type: number) {
        return (kind === KIND_MOVE ? this.move : this.stat)[x + z * this.nx].unk0[type];
    }
    /** addCheckDataToList (allocCheckList: a pool node, a warp node for a warp) */
    private addCheckDataToList(z: number, x: number, kind: number, type: number, d: BGCheckData) {
        const root = this.listRoot(z, x, kind, type);
        const pre = type === 0 ? addGroundNode(root, d) : type === 1 ? addRoofNode(root, d) : addWallNode(root, d);
        const node = kind === KIND_WARP ? new BGCheckListWarp() : new BGCheckList();
        node.data = d;
        if (kind === KIND_WARP) {
            let l = this.warpNodes.get(d);
            if (!l) this.warpNodes.set(d, l = []);
            l.push(node as BGCheckListWarp);
        }
        addAfterPreNode(x, z, pre, node, kind);
    }

    /** Takes a triangle out of every list it's in (TMapCollisionWarp::remove). */
    remove(d: BGCheckData) {
        const w = this.warpNodes.get(d);
        if (w) {   // removeCheckListNode: each node out through its previous node
            for (const n of w) { n.preNode!.next = n.next; if (n.next) n.next.preNode = n.preNode; n.data = null; }
            this.warpNodes.delete(d);
            return;
        }
        for (const grid of [this.stat, this.move]) for (const cell of grid) for (let t = 0; t < 3; t++) {
            let prev = cell.unk0[t], cur = prev.next;
            while (cur) { if (cur.data === d) { prev.next = cur.next; if (cur.next) cur.next.preNode = prev; } else prev = cur; cur = cur.next; }
        }
    }

    /** A collision file (map/map.col, a map object's .col) as check data, placed by mtx (column-major 4x4) if given. */
    static readCol(buf: ArrayBuffer, mtx?: ArrayLike<number> | null): BGCheckData[] {
        const v = new DataView(buf);
        const nv = v.getUint32(0), vo = v.getUint32(4), ng = v.getUint32(8), go = v.getUint32(12);
        const verts: number[][] = [];
        for (let i = 0; i < nv; i++) {
            let x = v.getFloat32(vo + i * 12), y = v.getFloat32(vo + i * 12 + 4), z = v.getFloat32(vo + i * 12 + 8);
            if (mtx) {
                const m = mtx;
                [x, y, z] = [f(m[0] * x + m[4] * y + m[8] * z + m[12]), f(m[1] * x + m[5] * y + m[9] * z + m[13]), f(m[2] * x + m[6] * y + m[10] * z + m[14])];
            }
            verts.push([x, y, z]);
        }
        const out: BGCheckData[] = [];
        for (let g = 0; g < ng; g++) {
            const o = go + g * 0x18;
            const bgType = v.getUint16(o), num = v.getInt16(o + 2), flags = v.getUint16(o + 4);
            const io = v.getUint32(o + 8), so = v.getUint32(o + 12), uo = v.getUint32(o + 16), ao = v.getUint32(o + 20);
            for (let t = 0; t < num; t++) {
                const d = new BGCheckData();
                d.bgType = bgType;
                const i0 = v.getInt16(io + t * 6), i1 = v.getInt16(io + t * 6 + 2), i2 = v.getInt16(io + t * 6 + 4);
                d.setVertex(verts[i0], verts[i1], verts[i2]);
                d.data = (flags & 1) && ao ? v.getInt16(ao + t * 2) : -9999;
                d.soundMaterial = v.getUint8(so + t);
                d.unk7 = v.getUint8(uo + t);
                out.push(d);
            }
        }
        return out;
    }

    // ------------------------------------------------------------ queries
    /** the cell's three list heads' first nodes (getStaticCheckList / getMoveCheckList, then getGroundList etc.) */
    private cell(grid: BGCheckListRoot[], x: number, z: number): [Node | null, Node | null, Node | null] {
        const r = grid[this.toGridX(x) + this.toGridZ(z) * this.nx].unk0;
        return [r[0].next, r[1].next, r[2].next];
    }
    /** TMap::isInArea */
    isInArea(x: number, z: number) { return !this.outside(x, z); }
    private outside(x: number, z: number) { return x < -this.ex || this.ex <= x || z < -this.ez || this.ez <= z; }

    /** checkGroundList (its float operations as the DOL has them: fsubs, fmuls, fmsubs; the height fmuls, fmadds, fadds, fdivs) */
    private static groundList(x: number, y: number, z: number, flags: number, head: Node | null): [number, BGCheckData | null] {
        for (let n = head; n; n = n.next) {
            const d = n.data!;
            if (d.minY > y) continue;
            if ((flags & IGNORE_WATER_THROUGH) && d.isWaterThrough()) continue;
            if ((flags & IGNORE_WATER_SURFACE) && d.isWaterSurface()) continue;
            if (edge(d.p1, d.p2, x, z) < -1) continue;
            if (edge(d.p2, d.p3, x, z) < -1) continue;
            if (edge(d.p3, d.p1, x, z) < -1) continue;
            const h = planeY(d, x, z);
            if (!(f(y - f(h + -78)) < 0)) return [h, d];
        }
        return [-32767, null];
    }

    /** checkGround: the ground's height under (x, y + 78, z), and its triangle (the illegal one if none). */
    checkGround(x: number, y: number, z: number, flags = 0): [number, BGCheckData] {
        if (this.outside(x, z)) return [-32767, this.illegal];
        let [h5, d5] = MapCollision.groundList(x, y, z, flags, this.cell(this.move, x, z)[0]);
        let [h6, d6] = MapCollision.groundList(x, y, z, flags, this.cell(this.stat, x, z)[0]);
        if (this.groundPlane) { const [h7, d7] = this.groundPlane.checkPlaneGround(x, y, z); if (h7 > h6) { h6 = h7; d6 = d7; } }
        return h5 > h6 ? [h5, d5 || this.illegal] : [h6, d6 || this.illegal];
    }

    /** checkRoofList */
    private static roofList(x: number, y: number, z: number, flags: number, head: Node | null): [number, BGCheckData | null] {
        for (let n = head; n; n = n.next) {
            const d = n.data!;
            if ((flags & 4) && d.isWaterThrough()) continue;
            if (edge(d.p1, d.p2, x, z) > 1) continue;
            if (edge(d.p2, d.p3, x, z) > 1) continue;
            if (edge(d.p3, d.p1, x, z) > 1) continue;
            const h = planeY(d, x, z);
            if (!(f(y - f(h - -78)) > 0)) return [h, d];
        }
        return [9999999, null];
    }

    /** checkRoof: the lowest roof above (x, y - 78, z). */
    checkRoof(x: number, y: number, z: number, flags = 0): [number, BGCheckData] {
        if (this.outside(x, z)) return [9999999, this.illegal];
        const [h5, d5] = MapCollision.roofList(x, y, z, flags, this.cell(this.move, x, z)[1]);
        const [h6, d6] = MapCollision.roofList(x, y, z, flags, this.cell(this.stat, x, z)[1]);
        return h5 < h6 ? [h5, d5 || this.illegal] : [h6, d6 || this.illegal];
    }

    /** checkWallList's test of one wall (its float operations as the DOL has them) */
    private static wallHit(d: BGCheckData, r: WallCheck): boolean {
        const radius = r.radius, flags = r.flags;
        if ((flags & IGNORE_WATER_THROUGH) && d.isWaterThrough()) return false;
        if ((flags & IGNORE_WATER_SURFACE) && d.isWaterSurface()) return false;
        const cx = r.center[0], cy = r.center[1], cz = r.center[2];
        const [nx, ny, nz] = d.n;
        const dist = f(d.d + FMA(cz, nz, FMA(cx, nx, f(cy * ny))));
        if (dist < -radius) return false;
        if (!(radius >= dist)) return false;
        const y1 = d.p1[1], y2 = d.p2[1], y3 = d.p3[1];
        // s = (ya - cy) * (b - a) - (a - c) * (yb - ya), over the wall's facing axis
        const side = (ya: number, yb: number, a: number, b: number, c: number) => FMS(f(ya - cy), f(b - a), f(f(a - c) * f(yb - ya)));
        if (d.flags & FLAG_X_FACING) {
            const c = -cz, z1 = -d.p1[2], z2 = -d.p2[2], z3 = -d.p3[2];
            const s1 = side(y1, y2, z1, z2, c), s2 = side(y2, y3, z2, z3, c), s3 = side(y3, y1, z3, z1, c);
            if (nx > 0) { if (s1 > 1 || s2 > 1 || s3 > 1) return false; }
            else if (s1 < -1 || s2 < -1 || s3 < -1) return false;
        } else {
            const x1 = d.p1[0], x2 = d.p2[0], x3 = d.p3[0];
            const s1 = side(y1, y2, x1, x2, cx), s2 = side(y2, y3, x2, x3, cx), s3 = side(y3, y1, x3, x1, cx);
            if (nz > 0) { if (s1 > 1 || s2 > 1 || s3 > 1) return false; }
            else if (s1 < -1 || s2 < -1 || s3 < -1) return false;
        }
        if (!(flags & DONT_MOVE_XZ)) {
            const push = f(radius - dist);
            r.center[0] = FMA(push, nx, r.center[0]);
            r.center[2] = FMA(push, nz, r.center[2]);
        }
        return true;
    }

    private static wallList(head: Node | null, r: WallCheck) {
        let n = 0;
        const y = r.center[1];
        for (let node = head; node; node = node.next) {
            const d = node.data!;
            if (d.minY > y) continue;
            if (d.maxY < y) return n;
            if (!MapCollision.wallHit(d, r)) continue;
            n++;
            r.results.push(d);
            if (r.results.length >= r.maxResults) return n;
        }
        return n;
    }

    /** checkWalls: up to maxResults walls the sphere touches; pushes its centre out of each unless DONT_MOVE_XZ. */
    checkWalls(r: WallCheck): number {
        r.results.length = 0;
        const [x, , z] = r.center;
        if (this.outside(x, z)) return 0;
        let n = MapCollision.wallList(this.cell(this.move, x, z)[2], r);
        if (n >= r.maxResults) return n;
        n += MapCollision.wallList(this.cell(this.stat, x, z)[2], r);
        return n;
    }

    /** intersectLine: the first static triangle the segment crosses (ground, then walls, then roofs, cell by cell). */
    intersectLine(a: number[], b: number[], frontOnly: boolean, hit?: number[]): BGCheckData | null {
        const minX = Math.min(Math.trunc(a[0]), Math.trunc(b[0])), maxX = Math.max(Math.trunc(a[0]), Math.trunc(b[0]));
        const minZ = Math.min(Math.trunc(a[2]), Math.trunc(b[2])), maxZ = Math.max(Math.trunc(a[2]), Math.trunc(b[2]));
        const gx0 = this.toGridX(minX), gz0 = this.toGridZ(minZ), gx1 = this.toGridX(maxX), gz1 = this.toGridZ(maxZ);
        for (let gz = gz0; gz <= gz1; gz++)
            for (let gx = gx0; gx <= gx1; gx++) {
                if (gx < 0 || gz < 0 || gx >= this.nx || gz >= this.nz) continue;
                if (!(gx === gx0 && gz === gz0)) {
                    const x0 = this.toWorldX(gx), z0 = this.toWorldZ(gz), x1 = this.toWorldX(gx + 1), z1 = this.toWorldZ(gz + 1);
                    const A: [number, number] = [a[0], a[2]], B: [number, number] = [b[0], b[2]];
                    if (!lineInLineXZ(A, B, [x1, z0], [x0, z0]) && !lineInLineXZ(A, B, [x0, z1], [x0, z0])
                        && !lineInLineXZ(A, B, [x1, z1], [x0, z1]) && !lineInLineXZ(A, B, [x1, z0], [x1, z1])) continue;
                }
                const c = this.stat[gx + gz * this.nx].unk0;
                for (const k of [0, 2, 1]) for (let n = c[k].next; n; n = n.next) if (bgIntersectLine(n.data, a, b, frontOnly, hit)) return n.data;
            }
        return null;
    }
}

/** crossFrom(o, p, q): (p - o) and (q - o), then u.x * v.y - u.y * v.x (fmuls, fmsubs) */
function crossFrom(o: number[], p: number[], q: number[]) {
    const ux = f(p[0] - o[0]), uy = f(p[1] - o[1]), vx = f(q[0] - o[0]), vy = f(q[1] - o[1]);
    return FMS(ux, vy, f(uy * vx));
}
/** LineInLineXZ (as intersectLine inlines it) */
function lineInLineXZ(a0: [number, number], a1: [number, number], b0: [number, number], b1: [number, number]) {
    return f(crossFrom(a0, a1, b0) * crossFrom(a0, a1, b1)) <= 0 && f(crossFrom(b0, b1, a0) * crossFrom(b0, b1, a1)) <= 0;
}

/** bgIntersectLine (its float operations as the DOL has them, 0x801DDCD0) */
function bgIntersectLine(d: BGCheckData | null, a: number[], b: number[], frontOnly: boolean, hit?: number[]) {
    if (!d) return false;
    if (d.isMarioThrough()) return false;
    const [nx, ny, nz] = d.n;
    const dir = [f(b[0] - a[0]), f(b[1] - a[1]), f(b[2] - a[2])];
    const nd = FMA(nz, dir[2], FMA(nx, dir[0], f(ny * dir[1])));
    if (frontOnly && nd >= 0) return false;
    if (Math.abs(nd) < f(0.00001)) return false;
    const t = f(-f(d.d + FMA(nz, a[2], FMA(nx, a[0], f(ny * a[1])))) / nd);
    if (t < 0 || 1 < t) return false;
    const h = [f(a[0] + f(dir[0] * t)), f(a[1] + f(dir[1] * t)), f(a[2] + f(dir[2] * t))];
    const ang = (p: number[], q: number[]) => {   // MsAngleBetween: cross (fmuls, fmsubs), TUtil<f32>::sqrt, dot, atan2f
        const cx = FMS(p[1], q[2], f(p[2] * q[1])), cy = FMS(p[2], q[0], f(p[0] * q[2])), cz = FMS(p[0], q[1], f(p[1] * q[0]));
        const len = jgSqrt(FMA(cz, cz, FMA(cx, cx, f(cy * cy))));
        return Math.abs(mslAtan2f(len, FMA(p[2], q[2], FMA(p[0], q[0], f(p[1] * q[1])))));
    };
    const sub = (p: number[]) => [f(p[0] - h[0]), f(p[1] - h[1]), f(p[2] - h[2])];
    const A = sub(d.p1), B = sub(d.p2), C = sub(d.p3);
    let sum = f(0 + ang(A, B)); sum = f(sum + ang(B, C)); sum = f(sum + ang(C, A));
    if (Math.abs(f(f(6.2831855) - sum)) > f(0.001)) return false;
    if (hit) { hit[0] = h[0]; hit[1] = h[1]; hit[2] = h[2]; }
    return true;
}

// MapArea.cpp
/** checkLinesCollision (fsubs; a fmuls, then fmsubs: 0x801DD098) */
function linesCross(x0: number, z0: number, x1: number, z1: number, x2: number, z2: number, x3: number, z3: number) {
    const a = f(z1 - z0), b = f(x1 - x0);
    const c0 = FMS(a, f(x2 - x1), f(b * f(z2 - z1))), c1 = FMS(a, f(x3 - x1), f(b * f(z3 - z1)));
    if ((c0 >= 0 && c1 >= 0) || (c0 < 0 && c1 < 0)) return false;
    const c = f(z3 - z2), e = f(x3 - x2);
    const d0 = FMS(c, f(x0 - x3), f(e * f(z0 - z3))), d1 = FMS(c, f(x1 - x3), f(e * f(z1 - z3)));
    if ((d0 >= 0 && d1 >= 0) || (d0 < 0 && d1 < 0)) return false;
    return true;
}
function lineCrossesPolygon(x0: number, z0: number, x1: number, z1: number, d: BGCheckData) {
    return linesCross(x0, z0, x1, z1, d.p1[0], d.p1[2], d.p2[0], d.p2[2]) || linesCross(x0, z0, x1, z1, d.p2[0], d.p2[2], d.p3[0], d.p3[2])
        || linesCross(x0, z0, x1, z1, d.p3[0], d.p3[2], d.p1[0], d.p1[2]);
}
/** pointIsInPolygon as polygonIsInGrid inlines it (0x801DCBAC): the first edge's two fmuls and a fsubs, the others fmuls, fmsubs */
function pointInPolygon(x: number, z: number, d: BGCheckData) {
    const [p1, p2, p3] = [d.p1, d.p2, d.p3];
    if (f(f(f(p1[2] - z) * f(p2[0] - p1[0])) - f(f(p1[0] - x) * f(p2[2] - p1[2]))) < 0) return false;
    if (FMS(f(p2[2] - z), f(p3[0] - p2[0]), f(f(p2[0] - x) * f(p3[2] - p2[2]))) < 0) return false;
    if (FMS(f(p3[2] - z), f(p1[0] - p3[0]), f(f(p3[0] - x) * f(p1[2] - p3[2]))) < 0) return false;
    return true;
}
function polygonIsInGrid(minX: number, minZ: number, maxX: number, maxZ: number, d: BGCheckData) {
    if (d.n[1] < 0) return true;
    const inBox = (x: number, z: number) => minX <= x && x <= maxX && minZ <= z && z <= maxZ;
    if (inBox(d.p1[0], d.p1[2]) || inBox(d.p2[0], d.p2[2]) || inBox(d.p3[0], d.p3[2])) return true;
    if (pointInPolygon(minX, minZ, d) || pointInPolygon(maxX, minZ, d) || pointInPolygon(minX, maxZ, d) || pointInPolygon(maxX, maxZ, d)) return true;
    return lineCrossesPolygon(minX, minZ, maxX, minZ, d) || lineCrossesPolygon(minX, maxZ, maxX, maxZ, d)
        || lineCrossesPolygon(minX, minZ, minX, maxZ, d) || lineCrossesPolygon(maxX, minZ, maxX, maxZ, d);
}

/**
 * TMap::load's part of the scene's Map object payload: after the transparency groups (TMapXlu::init),
 * the collision grid's five counts (cells X, cells Z, check data, list nodes, warp nodes).
 */
/** TMapWarp's table (TMapWarp::init, after TMapCollisionData::init's five counts): unk8 the map model
 * shown at the start, infos[n] (two a pair) the model each warp ground shows (unk0) and Mario's move (unk8) */
export interface MapWarpTable { unk8: number; infos: { unk0: number; unk4: number; unk8: [number, number, number] }[] }
const WARP_POINT_NAMES = ['warpA1', 'warpA0', 'warpB1', 'warpB0', 'warpC1', 'warpC0', 'warpD1', 'warpD0', 'warpE1', 'warpE0', 'warpF1', 'warpF0', 'warpG1', 'warpG0', 'warpH1', 'warpH0', 'warpI1', 'warpI0'];
export function mapWarpFromPayload(p: DataView): MapWarpTable | null {
    try {
        let o = 0;
        const groups = p.getInt32(o); o += 4;
        for (let i = 0; i < groups; i++) { const n = p.getInt32(o); o += 4 + n * 8; }
        o += 5 * 4;
        const n = p.getUint32(o); o += 4;
        if (!n) return null;
        const unk8 = p.getUint32(o); o += 4;
        const a: number[] = [], b: number[] = [];
        for (let i = 0; i < n; i++) { a.push(p.getUint32(o)); b.push(p.getUint32(o + 4)); o += 8; }
        const pts: [number, number, number][] = [];
        for (let i = 0; i < 2 * n; i++) {
            const len = p.getUint16(o); o += 2;
            let name = ''; for (let k = 0; k < len; k++) name += String.fromCharCode(p.getUint8(o + k)); o += len;
            const idx = WARP_POINT_NAMES.indexOf(name);
            const v: [number, number, number] = [p.getFloat32(o), p.getFloat32(o + 4), p.getFloat32(o + 8)]; o += 12 + 24;
            if (idx >= 0) pts[idx] = v;
        }
        const infos: MapWarpTable['infos'] = [];
        const fr = Math.fround;
        for (let i = 0; i < n; i++) {
            const p0 = pts[2 * i] || [0, 0, 0], p1 = pts[2 * i + 1] || [0, 0, 0];
            const d: [number, number, number] = [fr(p0[0] - p1[0]), fr(p0[1] - p1[1]), fr(p0[2] - p1[2])];
            infos[2 * i] = { unk0: b[i], unk4: a[i], unk8: d };
            infos[2 * i + 1] = { unk0: a[i], unk4: b[i], unk8: [-d[0], -d[1], -d[2]] };
        }
        return { unk8, infos };
    } catch { return null; }
}

export function mapGridFromPayload(p: DataView): [number, number] | null {
    try {
        let o = 0;
        const groups = p.getInt32(o); o += 4;
        for (let i = 0; i < groups; i++) { const n = p.getInt32(o); o += 4 + n * 8; }
        return [p.getInt32(o), p.getInt32(o + 4)];
    } catch { return null; }
}
