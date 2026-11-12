// The rail-patrolling Cheep Cheeps (TTabePuku, Enemy/TabePuku.cpp, プクプク(レール巡回)) of Noki
// Bay and Gelato Beach: they swim their graph underwater (GraphWander), and when Mario comes in
// sight they stop (Found), charge at him (Attack), bite him (Bite: TAKE), dive to the sea floor
// with him (Dive) and drag him off in a random direction until he gets away (Drag: DETACH), then
// swim back to the graph (RecoverGraph). They turn by slerping a quaternion toward where they
// swim (swimTo) and move along its Z axis with the water's friction (setMomentumFromQuat). Their
// collision is a separate THitActor (TTPHitActor, タベプク用当たり) hung below the fish (and below
// Mario too while it carries him) that does the map collision for it and keeps it under the
// water surface (y < 0).
//
// Not here: the bubble particles (emitEffects), the anm sounds (pukupuku_*.bas).

import { fr, V3, Quat, MsRandF, MsGetRotFromZaxisY, jgInvSqrt, frsqrte, sinf, cosf, mslAtan2f, mslAcosf } from '../math.js';
import { fmadd as FMA, fmsub as FMS, fnmsub as FNMS } from '../player/fmath.js';
import { World, Stream, HitActor, TakeActor, LF, HF, MSG, ANM_BCK, ANM_FRAME_RATE, nerve, Spine, PathNode, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import type { WallCheck } from '../collision.js';
import { SmallEnemy, SmallEnemyManager, smallParams } from './smallEnemy.js';
import { eulerToQuat, qEulerY, qRotate, qYDir } from './jgeom.js';

/** TTabePukuParams */
const TABEPUKU_PARAMS = {
    mMarchSpeed: ['f', 0.15], mAttackSpeed: ['f', 0.22], mDiveSpeed: ['f', 0.4], mWaterFric: ['f', 0.95], mTurnSlerpRate: ['f', 0.05],
    mApartHeight: ['f', 500], mCorrectY: ['f', -40], mCorrectZ: ['f', 150], mTerritoryRange: ['f', 1000], mDragLength: ['f', 2500],
} satisfies PSchema;

/** JGeometry::TUtil<f32>::epsilon / epsilonEquals */
const EPS = fr(3.81469727e-6);
const epsilonEquals = (a: number, b: number, e: number) => -e <= b - a && b - a <= e;
const PI_F = fr(Math.PI);

// BCKs (/scene/tabepuku, in the folder's order)
const BCK_ATTACK = 0, BCK_FOUND = 1, BCK_SWIM = 2;

export class TabePukuManager extends SmallEnemyManager {
    constructor(w: World, name = 'プクプク(レール巡回)マネージャー') { super(w, name); }
    load(s: Stream) {
        this.saveParams = smallParams('/enemy/tabepuku.prm', this.world.files, TABEPUKU_PARAMS);
        super.load(s);
    }
    createModelData() { this.createModelDataArray(['tabepuku.bmd']); }
}

/** TTPHitActor: the fish's collision. */
export class TPHitActor extends HitActor {
    posDelta = new V3();
    height = 0; radius = 0; groundHeight = 0;
    groundPlane: any; airborne = false; touchedWall = false;
    constructor(public owner: TabePuku) { super('タベプク用当たり'); this.groundPlane = owner.world.illegal; }
    init() {
        this.initHitActor(AT.TABE_PUKU, 1, 0x80000000 | 0, 10, 10, 10, 10);
        this.offHitFilter(HF.NO_COLLISION);
        this.onHitFilter(HF.NO_DAMAGE);
        this.owner.world.addToGroup('敵グループ', this);
    }
    receiveMessage(sender: HitActor, msg: number) { return this.owner.receiveMessage(sender, msg); }
    /** updateObjCollision: sized after the fish's parameters */
    updateObjCollision() {
        const P = this.owner.PT;
        this.attackRadius = P.mSLAttackRadius; this.attackHeight = P.mSLAttackHeight;
        this.damageRadius = P.mSLDamageRadius; this.damageHeight = P.mSLDamageHeight;
        this.calcEntryRadius();
    }
    /** updateTerrainCollsion: hung below the fish (and below Mario while it carries him) */
    updateTerrainCollsion() {
        const o = this.owner;
        // (JP 0x8034AC18: getYDir fused, the centre fmadds, then + 0 * depth or the fused -1 * depth)
        const { x: qx, y: qy, z: qz, w: qw } = o.quat;
        const up = new V3(FMS(2, fr(qx * qy), fr(2 * fr(qw * qz))), FNMS(2, fr(qz * qz), FNMS(2, fr(qx * qx), 1)), FMA(2, fr(qy * qz), fr(2 * fr(qw * qx))));
        let depth = fr(0.6666667 * this.attackHeight);
        this.height = this.attackHeight;
        this.radius = this.attackRadius;
        if (o.held) {
            depth = fr(depth + o.held.damageHeight);
            this.height = fr(this.height + o.held.damageHeight);
            this.radius = fr(this.radius + o.held.damageRadius);
        }
        const h = fr(0.5 * this.attackHeight);
        const z0 = fr(0 * depth);
        const p = new V3(fr(FMA(up.x, h, o.pos.x) + z0), FMA(-1, depth, FMA(up.y, h, o.pos.y)), fr(FMA(up.z, h, o.pos.z) + z0));
        this.posDelta.set(V3.sub(p, this.pos).fround());
        this.pos.set(p);
    }
    bind() {
        const o = this.owner;
        const next = this.pos.clone().add(this.posDelta).fround().add(o.vel).fround().add(o.posDelta).fround();
        const [h, d] = o.world.checkGroundIgnoreWaterSurface(next.x, fr(next.y + this.height), next.z);
        this.groundPlane = d;
        this.groundHeight = fr(h + 1);
        if (next.y <= fr(0.05 + this.groundHeight)) {
            this.airborne = false;
            // push off steep ground along its normal
            const n = new V3(d.n[0], d.n[1], d.n[2]);
            const g = new V3(next.x, this.groundHeight, next.z);
            const d1 = FMA(n.z, next.z, FMA(n.x, next.x, fr(n.y * next.y))), d2 = FMA(n.z, next.z, FMA(n.x, next.x, fr(n.y * g.y)));
            const push = fr(1 - fr(d1 - d2));
            if (push > 0) next.set(FMA(n.x, push, next.x), FMA(n.y, push, next.y), FMA(n.z, push, next.z));
            next.y = this.groundHeight;
        } else this.airborne = true;
        // stay under the water surface
        if (0 <= fr(next.y + this.height)) next.y = -this.height;
        const r: WallCheck = { center: [next.x, next.y, next.z], radius: this.radius, maxResults: 1, flags: 0, results: [] };
        const touched = o.world.isTouchedWallsAndMoveXZ(r);
        next.x = r.center[0]; next.z = r.center[2];
        this.posDelta.set(V3.sub(next, this.pos).fround());
        this.touchedWall = touched;
        this.pos.set(next);
    }
    checkHitActors() { for (const c of this.collisions.slice()) if (c.isActorType(AT.MARIO)) this.owner.attackToMario(); }
}

export class TabePuku extends SmallEnemy {
    hit!: TPHitActor;
    quat = new Quat();
    takingMtx = new Float64Array(12);
    mouthJoint = -1;
    touchedWall = false;
    diveStartY = 0;
    dragDir = new V3();
    get PT(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'プクプク(レール巡回)') { super(w, name); this.onLiveFlag(LF.UNK1000); }
    init(m: any) {
        this.manager = m;
        m.manageActor(this);
        this.setMActorAndKeeper();
        this.spine!.initWith(TabePukuNerves.graphWander);
        this.initCollision();
        this.initParams();
    }
    reset() { this.scaledBodyRadius = 130; }
    initCollision() {
        this.initHitActor(AT.TABE_PUKU, 0, 0, 0, 0, 0, 0);
        this.onHitFilter(HF.NO_COLLISION);
        this.hit = new TPHitActor(this);
        this.hit.init();
        this.hit.pos.set(this.pos);
    }
    initParams() {
        this.quat.set(eulerToQuat(this.rot));
        this.mouthJoint = this.mactor ? this.mactor.jointIndex('jnt_mouth_up') : -1;
    }
    perform(cue: number) { this.hit.perform(cue); super.perform(cue); }
    control() {
        if (this.spine) this.spine.update();
        this.hit.checkHitActors();
        this.updateSound();
    }
    updateSound() { if (this.isBiting()) this.world.sound(SE.EN_TOBIPUKU_CHEW, this.pos); }
    bind() {
        const h = this.hit;
        h.updateObjCollision();
        h.updateTerrainCollsion();
        h.bind();
        this.posDelta.set(h.posDelta);
        this.touchedWall = h.touchedWall;
        if (h.airborne) this.onLiveFlag(LF.AIRBORNE); else this.offLiveFlag(LF.AIRBORNE);
        this.groundPlane = h.groundPlane;
        this.groundHeight = h.groundHeight;
    }
    calcRootMatrix() {
        if (this.holder) { super.calcRootMatrix(); return; }
        this.quat.toMtx(this.baseTR, this.pos);
        // (emitEffects: the bubbles from its mouth)
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (msg === MSG.TRAMPLE || msg === MSG.HIP_DROP) return false;
        return super.receiveMessage(sender, msg);
    }
    /** getTakingMtx: where Mario hangs while it carries him, in front of and below the mouth */
    getTakingMtx() {
        const m = this.takingMtx;
        this.quat.toMtx(m, new V3());
        const zx = m[2], zy = m[6], zz = m[10], yx = m[1], yy = m[5], yz = m[9];
        const cz = this.PT.mCorrectZ, cy = this.PT.mCorrectY;
        const p = new V3(fr(this.pos.x + fr(zx * cz)), fr(this.pos.y + fr(zy * cz)), fr(this.pos.z + fr(zz * cz)));
        m[3] = fr(p.x + fr(yx * cy)); m[7] = fr(p.y + fr(yy * cy)); m[11] = fr(p.z + fr(yz * cy));
        return m;
    }
    attackToMario() {
        if (this.isBiting()) return;
        if (!this.isGraphWander() && this.world.mario.receiveMessage(this, MSG.TAKE)) {
            this.held = this.world.mario as unknown as TakeActor;
            this.spine!.reset();
            this.spine!.setNext(TabePukuNerves.bite);
        }
    }
    behaveToWater(_a: HitActor) { }
    forceKill() { }
    isFindMario(k: number) { return this.isFindMarioFromParam(k); }
    doKeepDistance() { return !this.isAttacking(); }
    /** isMissMario: Mario too far above / below, too far from the goal, or out of the territory round the graph */
    isMissMario() {
        const P = this.PT;
        if (Math.abs(this.world.mario.pos.y - this.pos.y) > P.mSLGiveUpHeight) return true;
        if (V3.sub(this.goal104.point(), this.pos).length() > P.mSLGiveUpLength) return true;
        const n = this.tracer.graph!.getNearestPosOnGraphLink(this.pos).sub(this.pos);
        const r = P.mTerritoryRange;
        return r * r <= n.squared();
    }
    isTouchedPlane() { return !this.checkLiveFlag(LF.AIRBORNE); }
    isGraphWander() { const n = this.spine!.getLatestNerve(); return n === TabePukuNerves.graphWander || n === TabePukuNerves.recoverGraph; }
    isAttacking() { return this.spine!.getLatestNerve() === TabePukuNerves.attack || this.isBiting(); }
    isBiting() { const n = this.spine!.getLatestNerve(); return n === TabePukuNerves.bite || n === TabePukuNerves.dive || n === TabePukuNerves.drag; }
    swimToCurPathNode(offset: V3) { this.swimTo(V3.sub(this.goal104.point(), this.pos).add(offset)); }
    prepareDive() {
        this.diveStartY = this.pos.y;
        this.setBckAnm(BCK_SWIM);
        this.mactor!.setFrameRate(2 * ANM_FRAME_RATE(), ANM_BCK);
        this.marchSpeed = this.PT.mDiveSpeed;
    }
    /** doDive: straight down to the floor, then the drag */
    doDive() {
        this.swimTo(new V3(0, fr(this.groundHeight - this.pos.y), 0));
        return fr(this.pos.y - this.diveStartY) < -this.PT.mApartHeight || fr(this.pos.y - this.groundHeight) < 200 || this.isTouchedPlane();
    }
    prepareDrag() {
        this.dragDir.set(0, 0, 1);
        const q = qEulerY(fr(MsRandF() * 6.2831855));
        qRotate(q, this.dragDir, this.dragDir);
        this.setGoalPath(new PathNode(null, this.pos.clone()));
        this.marchSpeed = this.PT.mDiveSpeed;
    }
    /** doDrag: along the floor until Mario gets away */
    doDrag() {
        this.swimTo(this.dragDir);
        if (this.touchedWall || this.isTouchedPlane() || this.PT.mDragLength < V3.sub(this.goal104.point(), this.pos).length()) { this.detach(); return true; }
        return false;
    }
    /** swimTo (JP 0x80349564), in the ROM's order: the direction normalized, TQuat4::setRotate from (0, 0, 1), the slerp
     *  (both quaternions normalized, the dot fused y, x, z, w, MSL acosf / sinf) and the result normalized */
    swimTo(target: V3) {
        const tx = target.x, ty = target.y, tz = target.z;
        const sq = fr(fr(fr(tx * tx) + fr(ty * ty)) + fr(tz * tz));
        if (epsilonEquals(0, sq, EPS)) { this.setMomentumFromQuat(); return; }
        let nx = 0, ny = 0, nz = 0;
        if (sq > EPS) { const k = fr(1 * jgInvSqrt(sq)); nx = fr(tx * k); ny = fr(ty * k); nz = fr(tz * k); }
        const c = FMA(nz, 1, FMA(nx, 0, fr(ny * 0)));
        let rx: number, ry: number, rz: number, rw: number;
        if (epsilonEquals(-1, c, EPS)) { const h = fr(0.5 * PI_F); rx = 0; ry = sinf(h); rz = 0; rw = cosf(h); }
        else {
            const f2 = fr(0 * nz), f6 = fr(0 * ny), f7 = fr(0 * nx);
            const cy = FMS(1, nx, f2), cx = FNMS(1, ny, f2), cz = fr(f6 - f7);
            const l2 = FMA(cz, cz, FMA(cx, cx, fr(cy * cy)));
            let len = l2;
            if (l2 > 0) { const g = fr(frsqrte(l2)); len = fr(l2 * fr(fr(0.5 * g) * FNMS(l2, fr(g * g), 3))); }
            if (len <= EPS) { rx = 0; ry = 0; rz = 0; rw = 1; }
            else {
                const ang = mslAtan2f(len, FMA(1, nz, fr(f7 + f6))), h = fr(1 * fr(0.5 * ang)), k = fr(sinf(h) / len);
                rx = fr(cx * k); ry = fr(cy * k); rz = fr(cz * k); rw = cosf(h);
            }
        }
        const t = this.PT.mTurnSlerpRate, q = this.quat;
        const unit = (x: number, y: number, z: number, w: number): number[] => {
            const d = FMA(w, w, FMA(z, z, FMA(x, x, fr(y * y))));
            if (d <= EPS) return [0, 0, 0, 0];
            const k = fr(1 * jgInvSqrt(d)); return [fr(x * k), fr(y * k), fr(z * k), fr(w * k)];
        };
        const A = unit(q.x, q.y, q.z, q.w), B = unit(rx, ry, rz, rw);
        let d = FMA(A[3], B[3], FMA(A[2], B[2], FMA(A[0], B[0], fr(A[1] * B[1])))), flip = false;
        if (d < 0) { d = -d; flip = true; }
        let k0: number, k1: number;
        if (fr(1 - d) <= EPS) { k0 = fr(1 - t); k1 = t; }
        else { const th = mslAcosf(d), st = sinf(th); k0 = fr(sinf(fr(fr(1 - t) * th)) / st); k1 = fr(sinf(fr(t * th)) / st); }
        if (flip) k1 = -k1;
        let x = FMA(k0, A[0], fr(k1 * B[0])), y = FMA(k0, A[1], fr(k1 * B[1])), z = FMA(k0, A[2], fr(k1 * B[2])), w = FMA(k0, A[3], fr(k1 * B[3]));
        const n = fr(fr(fr(fr(x * x) + fr(y * y)) + fr(z * z)) + fr(w * w));
        if (n <= EPS) { x = y = z = w = 0; }
        else { const k = fr(1 * jgInvSqrt(n)); x = fr(x * k); y = fr(y * k); z = fr(z * k); w = fr(w * k); }
        q.x = x; q.y = y; q.z = z; q.w = w;
        this.setMomentumFromQuat();
    }
    /** setMomentumFromQuat (inlined in swimTo): the quaternion's Z axis (fused) times the march speed, plus the speed times the water's friction */
    setMomentumFromQuat() {
        const { x, y, z, w } = this.quat, m = this.marchSpeed;
        const zx = FMA(2, fr(x * z), fr(2 * fr(w * y))), zy = FMS(2, fr(y * z), fr(2 * fr(w * x))), zz = FNMS(2, fr(y * y), FNMS(2, fr(x * x), 1));
        const fx = fr(zx * m), fy = fr(zy * m), fz = fr(zz * m), k = this.PT.mWaterFric, v = this.vel;
        v.set(fr(fr(v.x * k) + fx), fr(fr(v.y * k) + fy), fr(fr(v.z * k) + fz));
        this.rot.y = MsGetRotFromZaxisY(v);
    }
    detach() { this.world.mario.receiveMessage(this, MSG.DETACH); this.held = null; }
}

type S = Spine<TabePuku>;
export const TabePukuNerves: Record<string, any> = {};
TabePukuNerves.graphWander = nerve<TabePuku>('TNerveTabePukuGraphWander', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.tracer.reset();
        self.goToShortestNextGraphNode();
        self.setBckAnm(BCK_SWIM);
        self.marchSpeed = self.PT.mMarchSpeed;
    }
    if (self.isReachedToGoal()) self.goToRandomNextGraphNode();
    if (self.isFindMario(1)) { spine.pushAfterCurrent(TabePukuNerves.found); return true; }
    self.swimToCurPathNode(new V3());
    return false;
});
TabePukuNerves.found = nerve<TabePuku>('TNerveTabePukuFound', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.setBckAnm(BCK_FOUND); self.marchSpeed = 0; }
    self.setMomentumFromQuat();
    if (self.checkCurAnmEnd(ANM_BCK)) { spine.pushAfterCurrent(TabePukuNerves.attack); return true; }
    return false;
});
TabePukuNerves.recoverGraph = nerve<TabePuku>('TNerveTabePukuRecoverGraph', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.tracer.reset(); self.tracer.reset2();
        self.goToShortestNextGraphNode();
        self.marchSpeed = self.PT.mMarchSpeed;
    }
    if (self.isReachedToGoal()) { spine.pushAfterCurrent(TabePukuNerves.graphWander); return true; }
    // rise first when stuck on the floor or a wall
    const rise = self.isTouchedPlane() || self.touchedWall;
    self.swimToCurPathNode(rise ? new V3(0, 10000, 0) : new V3());
    return false;
});
TabePukuNerves.attack = nerve<TabePuku>('TNerveTabePukuAttack', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.setBckAnm(BCK_ATTACK);
        self.setGoalPath(new PathNode(self.world.mario));
        self.marchSpeed = self.PT.mAttackSpeed;
    }
    if (self.isMissMario() || self.touchedWall) { spine.pushAfterCurrent(TabePukuNerves.recoverGraph); return true; }
    self.swimToCurPathNode(new V3(0, 150, 0));
    return false;
});
TabePukuNerves.bite = nerve<TabePuku>('TNerveTabePukuBite', (spine: S) => {
    const self = spine.body;
    self.setBckAnm(BCK_SWIM);
    self.world.sound(SE.EN_TOBIPUKU_BITE, self.pos);
    spine.pushAfterCurrent(TabePukuNerves.dive);
    return true;
});
TabePukuNerves.dive = nerve<TabePuku>('TNerveTabePukuDive', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.prepareDive();
    if (self.doDive()) { spine.pushAfterCurrent(TabePukuNerves.drag); return true; }
    return false;
});
TabePukuNerves.drag = nerve<TabePuku>('TNerveTabePukuDrag', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.prepareDrag();
    if (self.doDrag()) { spine.pushAfterCurrent(TabePukuNerves.recoverGraph); return true; }
    return false;
});

register('TabePukuManager', (w, n) => new TabePukuManager(w, n));
register('TabePuku', (w, n) => new TabePuku(w, n));
