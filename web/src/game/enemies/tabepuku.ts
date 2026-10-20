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

import { fr, V3, Quat, MsRandF, MsGetRotFromZaxisY } from '../math.js';
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
const EPS = 3.81469727e-6;
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
        const up = qYDir(o.quat);
        let depth = fr(0.6666667 * this.attackHeight);
        this.height = this.attackHeight;
        this.radius = this.attackRadius;
        if (o.held) {
            depth = fr(depth + o.held.damageHeight);
            this.height = fr(this.height + o.held.damageHeight);
            this.radius = fr(this.radius + o.held.damageRadius);
        }
        const h = fr(0.5 * this.attackHeight);
        const c = new V3(fr(o.pos.x + fr(up.x * h)), fr(o.pos.y + fr(up.y * h)), fr(o.pos.z + fr(up.z * h)));
        const p = new V3(fr(c.x + fr(0 * depth)), fr(c.y + fr(-1 * depth)), fr(c.z + fr(0 * depth)));
        this.posDelta.set(V3.sub(p, this.pos));
        this.pos.set(p);
    }
    bind() {
        const o = this.owner;
        const next = this.pos.clone().add(this.posDelta).add(o.vel).add(o.posDelta);
        const [h, d] = o.world.checkGroundIgnoreWaterSurface(next.x, fr(next.y + this.height), next.z);
        this.groundPlane = d;
        this.groundHeight = fr(h + 1);
        if (next.y <= fr(0.05 + this.groundHeight)) {
            this.airborne = false;
            // push off steep ground along its normal
            const n = new V3(d.n[0], d.n[1], d.n[2]);
            const g = new V3(next.x, this.groundHeight, next.z);
            const push = fr(1 - fr(fr(n.dot(next)) - fr(n.dot(g))));
            if (push > 0) next.set(fr(next.x + fr(n.x * push)), fr(next.y + fr(n.y * push)), fr(next.z + fr(n.z * push)));
            next.y = this.groundHeight;
        } else this.airborne = true;
        // stay under the water surface
        if (0 <= fr(next.y + this.height)) next.y = -this.height;
        const r: WallCheck = { center: [next.x, next.y, next.z], radius: this.radius, maxResults: 1, flags: 0, results: [] };
        const touched = o.world.isTouchedWallsAndMoveXZ(r);
        next.x = r.center[0]; next.z = r.center[2];
        this.posDelta.set(V3.sub(next, this.pos));
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
        this.mactor!.setFrameRate(2 * ANM_FRAME_RATE, ANM_BCK);
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
    swimTo(target: V3) {
        const dir = target.clone();
        if (epsilonEquals(0, target.squared(), EPS)) { this.setMomentumFromQuat(); return; }
        dir.normalize();
        let rot: Quat;
        const cosAngle = dir.dot(new V3(0, 0, 1));
        if (epsilonEquals(-1, cosAngle, EPS)) rot = qEulerY(PI_F);
        else rot = new Quat().setRotateFromTo(new V3(0, 0, 1), dir, 1);
        this.quat.slerp(this.quat.clone(), rot, this.PT.mTurnSlerpRate);
        this.quat.normalize();
        this.setMomentumFromQuat();
    }
    /** setMomentumFromQuat: forwards, the water slowing it down */
    setMomentumFromQuat() {
        const f = this.quat.getZDir().scale(this.marchSpeed);
        const v = this.vel.clone().scale(this.PT.mWaterFric).add(f);
        this.vel.set(v);
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
