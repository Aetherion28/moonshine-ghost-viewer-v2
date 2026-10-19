// The game's map collision (TMapCollisionData), ported from the decomp (aetherion28/sms-ai-decomp):
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
        let nx = f(f((p2[1] - p1[1]) * (p3[2] - p2[2])) - f((p2[2] - p1[2]) * (p3[1] - p2[1])));
        let ny = f(f((p2[2] - p1[2]) * (p3[0] - p2[0])) - f((p2[0] - p1[0]) * (p3[2] - p2[2])));
        let nz = f(f((p2[0] - p1[0]) * (p3[1] - p2[1])) - f((p2[1] - p1[1]) * (p3[0] - p2[0])));
        if (nx !== 0 || ny !== 0 || nz !== 0) {
            const l = f(Math.sqrt(nx * nx + ny * ny + nz * nz));   // MsVECNormalize
            nx = f(nx / l); ny = f(ny / l); nz = f(nz / l);
            this.n = [nx, ny, nz];
            this.d = f(-(nx * p1[0] + ny * p1[1] + nz * p1[2]));
            this.minY = Math.min(p1[1], p2[1], p3[1]);
            this.maxY = Math.max(p1[1], p2[1], p3[1]);
        }
    }

    /** TBGCheckData::updateTrans */
    updateTrans(t: number[]) {
        for (const p of [this.p1, this.p2, this.p3]) for (let i = 0; i < 3; i++) p[i] = f(p[i] + t[i]);
        this.minY = f(this.minY + t[1]); this.maxY = f(this.maxY + t[1]);
        this.d = f(-(this.n[0] * this.p1[0] + this.n[1] * this.p1[1] + this.n[2] * this.p1[2]));
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

    isIllegal() { return !!(this.flags & FLAG_ILLEGAL); }
    isLegal() { return !this.isIllegal(); }
    isWaterSlip() { const t = this.bgType; return t === 0x500 || t === 0x4004 || t === 0x8004 || t === 0xC004; }
    isPool() { const t = this.bgType; return t === BG.POOL || t === BG.INDOOR_POOL || t === BG.SHADED_POOL; }
    isDeathPlane() { return this.bgType === BG.DEATH_PLANE; }
    isEverythingButMapObjectsThrough() { return this.bgType === BG.EVERYTHING_BUT_MAP_OBJECTS_PHASE_THROUGH; }
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

/** A grid cell's list node (TBGCheckList): sorted as addGroundNode / addRoofNode / addWallNode keep them. */
interface Node { data: BGCheckData; next: Node | null; }
type Cell = [Node | null, Node | null, Node | null];   // ground, roof, wall

/** checkGround / checkWalls flags (TMapCollisionData, TBGWallCheckRecord). */
export const IGNORE_WATER_SURFACE = 0x1, DONT_MOVE_XZ = 0x2, IGNORE_WATER_THROUGH = 0x4;

export interface WallCheck {
    center: number[]; radius: number; maxResults: number; flags: number;
    results: BGCheckData[];
}

/** checkGroundList / checkRoofList's edge test: (a.z - z) * (b.x - a.x) - (a.x - x) * (b.z - a.z) (fmuls, then fmsubs) */
const edge = (a: number[], b: number[], x: number, z: number) => f(f(a[2] - z) * f(b[0] - a[0]) - f(f(a[0] - x) * f(b[2] - a[2])));
/** the plane's height at (x, z): -(x * nx + z * nz + d) / ny (fmuls, fmadds, fadds, fdivs) */
const planeY = (d: BGCheckData, x: number, z: number) => f(-f(d.d + f(x * d.n[0] + f(z * d.n[2]))) / d.n[1]);

export class MapCollision {
    /** mGridExtentX / Y: half the grid's size. */
    ex = 0; ez = 0;
    nx = 0; nz = 0;
    private stat: Cell[] = [];
    private move: Cell[] = [];
    readonly illegal = new BGCheckData();
    /** Ground planes (TMapCollisionPlane), checked with the static grid. */
    groundPlane: { checkPlaneGround(x: number, y: number, z: number): [number, BGCheckData] } | null = null;

    /** TMapCollisionData::init: the grid's cell counts from the scene's map object. */
    constructor(cellsX: number, cellsZ: number) {
        this.nx = cellsX; this.nz = cellsZ;
        this.ex = f(Math.trunc(cellsX / 2) * 1024); this.ez = f(Math.trunc(cellsZ / 2) * 1024);
        const n = cellsX * cellsZ;
        for (let i = 0; i < n; i++) { this.stat.push([null, null, null]); this.move.push([null, null, null]); }
        this.illegal.setVertex([-32767, -32767, -32767], [-32767, -32767, 32767], [32767, -32767, 32767]);
        this.illegal.flags |= FLAG_ILLEGAL;
    }

    /** initMoveCollision: the moving collision's grid starts each frame empty. */
    clearMove() { for (const c of this.move) { c[0] = c[1] = c[2] = null; } }

    // ------------------------------------------------------------ building
    /** getGridArea: the cells a triangle's XZ box covers (walls widened by 80). */
    private gridArea(d: BGCheckData, type: number): [number, number, number, number] | null {
        let minX = Math.min(d.p1[0], d.p2[0], d.p3[0]), minZ = Math.min(d.p1[2], d.p3[2], d.p2[2]);
        let maxX = Math.max(d.p1[0], d.p2[0], d.p3[0]), maxZ = Math.max(d.p1[2], d.p2[2], d.p3[2]);
        if (maxX < -this.ex || maxZ < -this.ez || minX > this.ex || minZ > this.ez) return null;
        if (type === 2) { minX -= 80; minZ -= 80; maxX += 80; maxZ += 80; }
        const x0 = Math.max(0, Math.trunc((minX + this.ex) * 0.0009765625)), x1 = Math.min(this.nx - 1, Math.trunc((maxX + this.ex) * 0.0009765625));
        const z0 = Math.max(0, Math.trunc((minZ + this.ez) * 0.0009765625)), z1 = Math.min(this.nz - 1, Math.trunc((maxZ + this.ez) * 0.0009765625));
        return [x0, z0, x1, z1];
    }

    /** addCheckDataToGrid: kind 'static' (and warp) or 'move'. */
    add(d: BGCheckData, kind: 'static' | 'move') {
        const type = d.planeType();
        const a = this.gridArea(d, type);
        if (!a) return;
        const [x0, z0, x1, z1] = a;
        for (let i = z0; i <= z1; i++)
            for (let j = x0; j <= x1; j++) {
                if (kind !== 'move') {
                    const zb = Math.trunc((i + 1) * 1024 - this.ez), za = Math.trunc(i * 1024 - this.ez);
                    const xb = Math.trunc((j + 1) * 1024 - this.ex), xa = Math.trunc(j * 1024 - this.ex);
                    const pad = type === 2 ? 80 : 0;
                    if (!polygonIsInGrid(xa - pad, za - pad, xb + pad, zb + pad, d)) continue;
                }
                this.addToList((kind === 'move' ? this.move : this.stat)[j + i * this.nx], type, d);
            }
    }

    /** Takes a triangle out of every list it's in (TMapCollisionWarp::remove). */
    remove(d: BGCheckData) {
        for (const grid of [this.stat, this.move]) for (const cell of grid) for (let t = 0; t < 3; t++) {
            let prev: Node | null = null, cur = cell[t];
            while (cur) { if (cur.data === d) { if (prev) prev.next = cur.next; else cell[t] = cur.next; } else prev = cur; cur = cur.next; }
        }
    }
    private addToList(cell: Cell, type: number, d: BGCheckData) {
        // Walk from the list's head to the node to insert after (addGroundNode etc.).
        let prev: Node | null = null, cur = cell[type];
        const before = (o: BGCheckData) => type === 0 ? (d.minY > o.minY || (d.minY === o.minY && d.maxY > o.maxY))
            : type === 1 ? (d.maxY < o.maxY || (d.maxY === o.maxY && d.minY < o.minY))
                : (d.maxY > o.maxY || (d.maxY === o.maxY && d.minY > o.minY));
        while (cur && !before(cur.data)) { prev = cur; cur = cur.next; }
        const node: Node = { data: d, next: cur };
        if (prev) prev.next = node; else cell[type] = node;
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
    private cell(grid: Cell[], x: number, z: number) {
        return grid[Math.trunc(f(x + this.ex) * (1 / 1024)) + Math.trunc(f(z + this.ez) * (1 / 1024)) * this.nx];
    }
    private outside(x: number, z: number) { return x < -this.ex || this.ex <= x || z < -this.ez || this.ez <= z; }

    /** checkGroundList (its float operations as the DOL has them: fsubs, fmuls, fmsubs; the height fmuls, fmadds, fadds, fdivs) */
    private static groundList(x: number, y: number, z: number, flags: number, head: Node | null): [number, BGCheckData | null] {
        for (let n = head; n; n = n.next) {
            const d = n.data;
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
            const d = n.data;
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
        const dist = f(d.d + f(cz * nz + f(cx * nx + f(cy * ny))));
        if (dist < -radius) return false;
        if (!(radius >= dist)) return false;
        const y1 = d.p1[1], y2 = d.p2[1], y3 = d.p3[1];
        // s = (ya - cy) * (b - a) - (a - c) * (yb - ya), over the wall's facing axis
        const side = (ya: number, yb: number, a: number, b: number, c: number) => f((f(ya - cy) * f(b - a)) - f(f(a - c) * f(yb - ya)));
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
            r.center[0] = f(push * nx + r.center[0]);
            r.center[2] = f(push * nz + r.center[2]);
        }
        return true;
    }

    private static wallList(head: Node | null, r: WallCheck) {
        let n = 0;
        const y = r.center[1];
        for (let node = head; node; node = node.next) {
            const d = node.data;
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
        const ci = Math.trunc(f(x + this.ex) * (1 / 1024)) + Math.trunc(f(z + this.ez) * (1 / 1024)) * this.nx;
        let n = MapCollision.wallList(this.move[ci][2], r);
        if (n >= r.maxResults) return n;
        n += MapCollision.wallList(this.stat[ci][2], r);
        return n;
    }

    /** intersectLine: the first static triangle the segment crosses (ground, then walls, then roofs, cell by cell). */
    intersectLine(a: number[], b: number[], frontOnly: boolean, hit?: number[]): BGCheckData | null {
        const minX = Math.min(Math.trunc(a[0]), Math.trunc(b[0])), maxX = Math.max(Math.trunc(a[0]), Math.trunc(b[0]));
        const minZ = Math.min(Math.trunc(a[2]), Math.trunc(b[2])), maxZ = Math.max(Math.trunc(a[2]), Math.trunc(b[2]));
        const gz0 = Math.trunc((minZ + this.ez) / 1024), gx0 = Math.trunc((minX + this.ex) / 1024);
        const gx1 = Math.trunc((maxX + this.ex) / 1024), gz1 = Math.trunc((maxZ + this.ez) / 1024);
        for (let gz = gz0; gz <= gz1; gz++)
            for (let gx = gx0; gx <= gx1; gx++) {
                if (gx < 0 || gz < 0 || gx >= this.nx || gz >= this.nz) continue;
                if (!(gx === gx0 && gz === gz0)) {
                    const x0 = Math.trunc(gx * 1024 - this.ex), z0 = Math.trunc(gz * 1024 - this.ez);
                    const x1 = Math.trunc((gx + 1) * 1024 - this.ex), z1 = Math.trunc((gz + 1) * 1024 - this.ez);
                    const A: [number, number] = [a[0], a[2]], B: [number, number] = [b[0], b[2]];
                    if (!lineInLineXZ(A, B, [x1, z0], [x0, z0]) && !lineInLineXZ(A, B, [x0, z1], [x0, z0])
                        && !lineInLineXZ(A, B, [x1, z1], [x0, z1]) && !lineInLineXZ(A, B, [x1, z0], [x1, z1])) continue;
                }
                const c = this.stat[gx + gz * this.nx];
                for (const k of [0, 2, 1]) for (let n = c[k]; n; n = n.next) if (bgIntersectLine(n.data, a, b, frontOnly, hit)) return n.data;
            }
        return null;
    }
}

function lineInLineXZ(a0: [number, number], a1: [number, number], b0: [number, number], b1: [number, number]) {
    const cr = (p: number[], q: number[]) => p[0] * q[1] - p[1] * q[0];
    const sub = (p: number[], q: number[]) => [p[0] - q[0], p[1] - q[1]];
    return cr(sub(b0, a0), sub(a1, a0)) * cr(sub(b1, a0), sub(a1, a0)) <= 0 && cr(sub(a0, b0), sub(b1, b0)) * cr(sub(a1, b0), sub(b1, b0)) <= 0;
}

function bgIntersectLine(d: BGCheckData, a: number[], b: number[], frontOnly: boolean, hit?: number[]) {
    if (d.isMarioThrough()) return false;
    const dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const nd = d.n[0] * dir[0] + d.n[1] * dir[1] + d.n[2] * dir[2];
    if (frontOnly && nd >= 0) return false;
    if (Math.abs(nd) < 0.00001) return false;
    const t = -(d.d + d.n[0] * a[0] + d.n[1] * a[1] + d.n[2] * a[2]) / nd;
    if (t < 0 || 1 < t) return false;
    const h = [a[0] + dir[0] * t, a[1] + dir[1] * t, a[2] + dir[2] * t];
    const ang = (p: number[], q: number[]) => {   // MsAngleBetween
        const c = [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
        return Math.abs(Math.atan2(Math.hypot(c[0], c[1], c[2]), p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
    };
    const A = [d.p1[0] - h[0], d.p1[1] - h[1], d.p1[2] - h[2]], B = [d.p2[0] - h[0], d.p2[1] - h[1], d.p2[2] - h[2]], C = [d.p3[0] - h[0], d.p3[1] - h[1], d.p3[2] - h[2]];
    if (Math.abs(6.2831855 - (ang(A, B) + ang(B, C) + ang(C, A))) > 0.001) return false;
    if (hit) { hit[0] = h[0]; hit[1] = h[1]; hit[2] = h[2]; }
    return true;
}

// MapArea.cpp
function linesCross(x0: number, z0: number, x1: number, z1: number, x2: number, z2: number, x3: number, z3: number) {
    const c0 = (z1 - z0) * (x2 - x1) - (x1 - x0) * (z2 - z1), c1 = (z1 - z0) * (x3 - x1) - (x1 - x0) * (z3 - z1);
    if ((c0 >= 0 && c1 >= 0) || (c0 < 0 && c1 < 0)) return false;
    const d0 = (z3 - z2) * (x0 - x3) - (x3 - x2) * (z0 - z3), d1 = (z3 - z2) * (x1 - x3) - (x3 - x2) * (z1 - z3);
    if ((d0 >= 0 && d1 >= 0) || (d0 < 0 && d1 < 0)) return false;
    return true;
}
function lineCrossesPolygon(x0: number, z0: number, x1: number, z1: number, d: BGCheckData) {
    return linesCross(x0, z0, x1, z1, d.p1[0], d.p1[2], d.p2[0], d.p2[2]) || linesCross(x0, z0, x1, z1, d.p2[0], d.p2[2], d.p3[0], d.p3[2])
        || linesCross(x0, z0, x1, z1, d.p3[0], d.p3[2], d.p1[0], d.p1[2]);
}
function pointInPolygon(x: number, z: number, d: BGCheckData) {
    const [p1, p2, p3] = [d.p1, d.p2, d.p3];
    return !((p1[2] - z) * (p2[0] - p1[0]) - (p1[0] - x) * (p2[2] - p1[2]) < 0 || (p2[2] - z) * (p3[0] - p2[0]) - (p2[0] - x) * (p3[2] - p2[2]) < 0
        || (p3[2] - z) * (p1[0] - p3[0]) - (p3[0] - x) * (p1[2] - p3[2]) < 0);
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
export function mapGridFromPayload(p: DataView): [number, number] | null {
    try {
        let o = 0;
        const groups = p.getInt32(o); o += 4;
        for (let i = 0; i < groups; i++) { const n = p.getInt32(o); o += 4 + n * 8; }
        return [p.getInt32(o), p.getInt32(o + 4)];
    } catch { return null; }
}
