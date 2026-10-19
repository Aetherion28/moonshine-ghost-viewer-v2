// TKumokun / TKumokunManager (Enemy/Kumokun.cpp): the spiders (クモくん) on Pianta Village's
// walls, roofs and floors. One sticks to the plane it was placed on (unk198: initAttachPlane
// tries a wall, then a roof, then the floor) and walks it with its quaternion (unk19C): it turns
// to a random new heading (TNerveKumokunSearch: slerp at mTorqueY a tick), walks mMarchTimer
// ticks or until it has been blocked 30 ticks (TNerveKumokunWalk), waits mWaitTimer
// (TNerveKumokunWait); seeing Mario on the same plane within mSearchRange it turns to him and
// walks faster (unk1D4: mAttackSpeed, turning 3x). A graph loop round it (TWallAtGraph) keeps
// it inside. Touching Mario while walking, waiting or searching hurts him. Water freezes it 30
// ticks (TNerveKumokunFreeze). Trampled or hip dropped on a floor it dies (kumo_down1); hip
// dropped on a roof (or punched off a wall or roof by a fencing / roofing Mario) it falls off
// (TNerveKumokunPreFly / Fly: flies along its plane's normal at mFlySpeed until it has hit a
// plane 30 ticks, then dies: kumo_flyingdown1).
//
// Not here: its animation sounds (initAnmSound / setCurAnmSound, the fence table), the smoke
// when flying (MS_KIL_SMOKE). MarioProxy has no fencing / roofing state or wall / roof planes:
// SMS_IsMarioFencing / SMS_IsMarioRoofing are taken as false (so punches do nothing, and only
// a floor spider sees Mario: on his ground plane).

import { fr, V3, Quat, MsRandF } from '../math.js';
import { World, HitActor, LF, HF, HC, MSG, nerve, Spine, ANM_BCK, ANM_FRAME_RATE, GraphWeb, Stream, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemy, SmallEnemyManager, SmallEnemyNerves, smallParams } from './smallEnemy.js';
import type { BGCheckData, WallCheck } from '../collision.js';
import { register } from '../scene.js';

/** TKumokunParams */
const KUMOKUN_PARAMS = {
    mTorqueY: ['f', 0.01], mMarchSpeed: ['f', 1], mAttackSpeed: ['f', 1.5], mMarchTimer: ['i', 600], mWaitTimer: ['i', 180],
    mSearchRange: ['f', 1000], mFlySpeed: ['f', 30],
} satisfies PSchema;

/** TUtil<f32>::epsilon */
const EPS = 3.81469727e-6;
const PI = 3.1415927;
const isZero = (v: V3) => v.squared() <= EPS;
/** TVec3::setLength (JGeometry's: zero when nearly zero) */
function setLength(v: V3, len: number) { const l = v.squared(); if (l <= EPS) return v.zero(); return v.scale(len / Math.sqrt(l)).fround(); }
/** TVec3::scaleAdd(s, b, c): b + c s */
const scaleAdd = (s: number, b: V3, c: V3) => new V3(fr(b.x + c.x * s), fr(b.y + c.y * s), fr(b.z + c.z * s));
const normalOf = (d: BGCheckData) => new V3(d.n[0], d.n[1], d.n[2]);
const qEulerY = (a: number) => new Quat(0, fr(Math.sin(0.5 * a)), 0, fr(Math.cos(0.5 * a)));
const qEulerZ = (a: number) => new Quat(0, 0, fr(Math.sin(0.5 * a)), fr(Math.cos(0.5 * a)));
/** TQuat4::rotate (q v q*) */
function qRotate(q: Quat, v: V3) {
    const p = new Quat().mul(new Quat().mul(q, new Quat(v.x, v.y, v.z, 0)), new Quat(-q.x, -q.y, -q.z, q.w));
    return new V3(fr(p.x), fr(p.y), fr(p.z));
}

/** TPartition3f: a plane (normal, distance). */
interface Partition { n: V3; d: number; }
/** TWallAtGraph: the walls of a closed graph loop (each edge's plane, facing the spider). */
export class WallAtGraph {
    walls: Partition[] | null = null;
    init(g: GraphWeb | null, pos: V3, planeNormal: V3) {
        if (!g || g.isDummy()) return false;
        const sz = g.count;
        // startIsEnd
        const first = g.nodes[0], last = g.nodes[sz - 1];
        if (first.conns.length > 2 || (first.conns[0] !== sz - 1 && first.conns[1] !== sz - 1)) return false;
        if (last.conns.length > 2 || (last.conns[0] !== 0 && last.conns[1] !== 0)) return false;
        this.walls = [];
        for (let i = 0; i < sz; ++i) {
            const p = g.point(i);
            const diff = g.point((i + 1) % sz).sub(p);
            const l54 = V3.sub(pos, p);
            const n = setLength(new V3().cross(planeNormal, diff), 1);
            if (n.dot(l54) < 0) n.scale(-1);
            this.walls.push({ n, d: fr(n.dot(p)) });
        }
        return true;
    }
    checkWalls(p: V3, r: number) {
        if (!this.walls) return false;
        let hit = false;
        for (const w of this.walls) {
            const dist = fr(w.n.dot(p) - w.d);
            if (r - dist > 0) { p.set(scaleAdd(r - dist, p, w.n)); hit = true; }
        }
        return hit;
    }
}

export class KumokunManager extends SmallEnemyManager {
    constructor(w: World, name = 'くもくんマネージャ') { super(w, name); }
    load(s: Stream) {
        const p = smallParams('/enemy/kumokun.prm', this.world.files, KUMOKUN_PARAMS);
        this.saveParams = p;
        p.mSLAttackRadius = 60; p.mSLAttackHeight = 50; p.mSLDamageRadius = 65; p.mSLDamageHeight = 70;
        super.load(s);
    }
    createModelData() { this.createModelDataArray(['kumo_model1.bmd']); }
}

export class Kumokun extends SmallEnemy {
    hitPlaneCounter = 0;
    /** the plane it is on */
    unk198: BGCheckData | null = null;
    /** its orientation, and the turn it is making (from unk1AC to unk1BC, unk1CC of the way) */
    unk19C = new Quat(); unk1AC = new Quat(); unk1BC = new Quat(); unk1CC = 0;
    /** ticks left frozen */
    unk1D0 = 0;
    /** chasing Mario */
    unk1D4 = false;
    /** the animations to play in turn (TSolidStack<const char*>(3)) */
    unk1D8: string[] = [];
    unk1E8: WallAtGraph | null = null;
    /** how it died: 0 squashed, 1 fallen, 2 (none) */
    unk1EC = 2;
    get PK(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'くもくん') { super(w, name); }
    init(m: any) {
        this.manager = m;
        m.manageActor(this);
        this.mactor = this.createMActorByName('kumo_model1.bmd');
        this.spine!.initWith(KumokunNerves.search);
        this.initCollision();
        this.unk1D4 = false;
        if (this.tracer.graph) {
            this.tracer.reset();
            this.goToShortestNextGraphNode();
            this.unk1E8 = new WallAtGraph();
            if (!this.unk1E8.init(this.tracer.graph, this.pos, this.getPlaneNormal())) this.unk1E8 = null;
        }
    }
    initCollision() {
        this.initHitActor(AT.KUMOKUN, 2, HC.PLAYER | HC.ENEMY, 60, 50, 65, 70);
        this.offHitFilter(HF.NO_COLLISION);
        this.bodyRadius = 100; this.wallRadius = 100; this.headHeight = 75; this.scaledBodyRadius = 80;
        this.initAttachPlane();
    }
    initAttachPlane() {
        const up = new V3(0, 1, 0);
        let p = this.pos.clone();
        const wall = Kumokun.checkWallPlane(this.world, p, this.headHeight, 100);
        if (wall) { this.unk198 = wall; this.unk19C.setRotateFromTo(up, this.getPlaneNormal(), 1); return; }
        p = this.pos.clone();
        const roof = Kumokun.checkRoofPlane(this.world, p, this.headHeight);
        if (roof) { this.unk198 = roof; this.unk19C = qEulerZ(PI); return; }
        p = this.pos.clone();
        const floor = Kumokun.checkFloorPlane(this.world, p, this.headHeight, 0);
        if (floor) { this.unk198 = floor; this.unk19C.setRotateFromTo(up, this.getPlaneNormal(), 1); }
    }
    reset() { }
    bind() {
        if (this.checkLiveFlag(LF.UNK10)) return;
        if (this.isFlying()) { this.bindOnFlying(); return; }
        const d = V3.add(this.posDelta, this.vel);
        let hit: boolean;
        const a = new V3(), b = new V3();
        if (this.isOnFloor()) {
            const p = setLength(d.clone(), 50).add(this.pos);
            hit = this.checkOnMovingFloor(a, p, d);
            hit = this.checkOnMovingFloor(b, this.pos, d) || hit;
        } else if (this.isOnRoof()) {
            const p = setLength(d.clone(), 50).add(this.pos);
            hit = this.checkOnMovingRoof(a, p, d);
            hit = this.checkOnMovingRoof(b, this.pos, d) || hit;
        } else {
            const p = setLength(d.clone(), 0.5 * this.headHeight).add(this.pos);
            hit = this.checkOnMovingWall(a, p, d);
            hit = this.checkOnMovingWall(b, this.pos, d) || hit;
        }
        if (this.tracer.graph && this.unk1E8) {
            const q = this.pos.clone().add(b).add(a);
            const q2 = q.clone();
            hit = this.unk1E8.checkWalls(q2, this.wallRadius) || hit;
            b.add(V3.sub(q2, q));
        }
        if (hit) ++this.hitPlaneCounter; else this.resetHitPlaneCounter();
        this.posDelta.set(V3.add(b, a)).fround();
    }
    checkOnMovingWall(out: V3, start: V3, delta: V3) {
        let r = false;
        const N = this.getPlaneNormal(), w = this.world;
        const l30 = scaleAdd(100, start, N);
        const l3C = V3.add(l30, delta);
        const y = l3C.y;
        let [h] = w.checkGround(l3C.x, y + this.headHeight, l3C.z);
        h = fr(fr(h + 1) + this.headHeight);
        if (y <= h + 0.05) { r = true; l3C.y = h; }
        const l48 = scaleAdd(-10, l3C, N);
        const wall = Kumokun.checkWallPlane(w, l48, this.headHeight, 100);
        if (!wall) { r = true; l3C.set(l30); }
        else { l3C.x = l48.x; l3C.z = l48.z; }
        l3C.add(N.clone().scale(-100));
        out.set(V3.sub(l3C, start));
        return r;
    }
    checkOnMovingFloor(out: V3, start: V3, delta: V3) {
        let r = false;
        const w = this.world;
        const l98 = start.clone();
        const l8C = V3.add(l98, delta).add(normalOf(this.unk198!).scale(-10));
        const y = l8C.y;
        let [h] = w.checkGround(l8C.x, y + this.headHeight, l8C.z);
        h = fr(h + 1);
        if (y <= h + 0.05) {
            if (30 < h - y) { r = true; l8C.set(l98); }
            else l8C.y = h;
        } else { r = true; l8C.set(l98); }
        const l70 = l8C.clone();
        const wall = Kumokun.checkWallPlane(w, l70, this.headHeight, 100);
        if (wall) { r = true; l8C.x = l70.x; l8C.z = l70.z; }
        out.set(V3.sub(l8C, start));
        return r;
    }
    checkOnMovingRoof(out: V3, start: V3, delta: V3) {
        let r = false;
        const N = this.getPlaneNormal(), w = this.world;
        const lC0 = N.clone().scale(-this.headHeight / 2);
        const lb4 = V3.add(start, lC0);
        const lA8 = V3.add(lb4, delta).add(N.clone().scale(-10));
        const y = lA8.y;
        let [h] = w.checkRoof(lA8.x, y - this.headHeight, lA8.z);
        h = fr(h - 1);
        if (y > h - 0.05) lA8.y = h;
        else if (h - y < this.headHeight) lA8.y = h;
        else { r = true; lA8.set(lb4); }
        const l8C = lA8.clone();
        const wall = Kumokun.checkWallPlane(w, l8C, this.headHeight, 100);
        if (wall) { r = true; lA8.x = l8C.x; lA8.z = l8C.z; }
        lA8.sub(lC0);
        out.set(V3.sub(lA8, start));
        return r;
    }
    bindOnFlying() {
        let hit = false;
        const p = this.pos.clone().add(this.posDelta).add(this.vel);
        const roof = Kumokun.checkRoofPlane(this.world, p, this.headHeight);
        if (roof) { hit = true; this.vel.zero(); this.offLiveFlag(LF.AIRBORNE); }
        const floor = Kumokun.checkFloorPlane(this.world, p, this.headHeight, 0);
        if (floor) { hit = true; this.vel.zero(); this.offLiveFlag(LF.AIRBORNE); }
        else this.onLiveFlag(LF.AIRBORNE);
        const wall = Kumokun.checkWallPlane(this.world, p, this.headHeight, this.bodyRadius);
        if (wall) hit = true;
        if (hit) {
            this.hitPlaneCounter += 1;
            if (this.hitPlaneCounter > 30) this.unk198 = roof || floor || wall;
        } else this.resetHitPlaneCounter();
        this.posDelta.set(V3.sub(p, this.pos));
    }
    moveObject() {
        if (this.unk1D0 > 0) this.unk1D0 -= 1;
        this.updateAnimation();
        super.moveObject();
    }
    control() {
        if (this.spine) this.spine.update();
        // (TLiveActor::control, then the ground height under it — the plane it finds is dropped)
        const [h] = this.world.checkGround(this.pos.x, this.pos.y, this.pos.z);
        this.groundHeight = h;
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (this.checkLiveFlag(LF.DEAD)) return false;
        switch (msg) {
            case MSG.PUNCH: return this.behaveHitPunch();
            case MSG.HIP_DROP: return this.behaveHitHipdrop();
            case MSG.TRAMPLE: return this.behaveHitTrample();
            default: return super.receiveMessage(sender, msg);
        }
    }
    behaveToWater(_a: HitActor) { this.behaveHitWater(); }
    behaveHitWater() {
        if (this.unk1D0 > 0) return;
        this.unk1D0 = 30;
        this.spine!.reset();
        this.spine!.setNext(KumokunNerves.freeze);
    }
    behaveHitPunch() {
        // (!SMS_IsMarioFencing() || isSameNormal(SMS_GetMarioWlPlane(), unk198)) && (!SMS_IsMarioRoofing() || ...): neither here
        const fencing = false, roofing = false;
        if (!fencing && !roofing) return false;
        this.spine!.reset();
        this.spine!.setNext(KumokunNerves.preFly);
        return true;
    }
    behaveHitTrample() {
        if (this.isOnFloor()) { this.spine!.reset(); this.spine!.setNext(SmallEnemyNerves.die); this.unk1EC = 0; return true; }
        return false;
    }
    behaveHitHipdrop() {
        if (this.isOnFloor()) { this.spine!.reset(); this.spine!.setNext(SmallEnemyNerves.die); this.unk1EC = 0; return true; }
        if (this.isOnRoof()) { this.spine!.reset(); this.spine!.setNext(KumokunNerves.preFly); return true; }
        return false;
    }
    updateAnimation() {
        if (this.unk1D8.length > 0 && this.checkCurAnmEnd(ANM_BCK)) {
            const n = this.unk1D8.pop()!;
            if (this.mactor!.checkCurAnm(n, ANM_BCK) && this.unk1D8.length >= 1) this.changeBck(this.unk1D8[this.unk1D8.length - 1]);
            else this.unk1D8.length = 0;
        }
    }
    clearAnmStack() { this.unk1D8.length = 0; }
    pushNextAnm(name: string, start: boolean) {
        if (this.unk1D8.length < 3) this.unk1D8.push(name);
        if (start) this.changeBck(name);
    }
    changeBck(name: string) {
        this.mactor!.setBck(name);
        const latest = this.spine!.getLatestNerve();
        const k = latest !== SmallEnemyNerves.die && (this.unk1D4 || latest === KumokunNerves.preFly) ? 2 : 1;
        this.mactor!.setFrameRate(fr(ANM_FRAME_RATE * 0.5 * k), ANM_BCK);
    }
    setDeadAnm() {
        switch (this.unk1EC) {
            case 0: this.changeBck('kumo_down1'); break;
            case 1: this.changeBck('kumo_flyingdown1'); break;
            case 2: { const c = this.mactor!.getFrameCtrl(ANM_BCK); if (c) { c.init(1); c.frame = 0; } break; }
        }
    }
    checkSerialAnmEnd() { return this.unk1D8.length === 0 && this.checkCurAnmEnd(0); }
    calcRootMatrix() {
        if (this.holder && this.holder.held === this) { super.calcRootMatrix(); return; }
        const off = new V3();
        if (this.isOnWall() || this.isOnRoof()) off.set(this.getPlaneNormal().scale(-30));
        const p = V3.add(this.pos, off);
        this.unk19C.toMtx(this.baseTR, p);
        // (MS_KIL_SMOKE while flying)
    }
    attackToMario() { if (this.isAttack()) this.sendAttackMsgToMario(); }
    prepareWalk() { this.resetHitPlaneCounter(); this.changeBck('kumo_run1_loop'); }
    doWalk() {
        const f = this.unk19C.getZDir();
        const s = this.unk1D4 ? this.PK.mAttackSpeed : this.PK.mMarchSpeed;
        f.scale(s);
        this.posDelta.set(f).fround();
        return this.hitPlaneCounter > 30;
    }
    decideTarget() {
        const d = new V3();
        if (this.isFindOutMario(d)) this.decideTargetOnFindingMario(d);
        else this.decideTargetAtRandom();
    }
    decideTargetOnFindingMario(d: V3) { this.decideTargetAtDir(d); this.unk1D4 = true; }
    decideTargetAtDir(dir: V3) {
        const c4 = dir.clone();
        const b4 = this.unk19C.clone();
        c4.y = 0;
        setLength(c4, 1);
        const fwd = new V3(0, 0, 1);
        let a4: Quat;
        const k = fr(c4.dot(fwd) - -1);
        if (-EPS <= k && k <= EPS) a4 = qEulerY(PI);
        else a4 = new Quat().setRotateFromTo(fwd, c4, 1);
        b4.mul(b4.clone(), a4);
        this.unk1AC.set(this.unk19C);
        this.unk1BC.set(b4);
        this.unk1CC = 0;
    }
    decideTargetAtRandom() {
        const q = this.unk19C.clone();
        const p = new Quat().setRotateAxis(new V3(0, 1, 0), fr((MsRandF() + 0.5) * Math.PI));
        q.mul(q.clone(), p);
        this.unk1AC.set(this.unk19C);
        this.unk1BC.set(q);
        this.unk1CC = 0;
        this.unk1D4 = false;
    }
    decideTargetOnGraph() { }
    rotateGoalDirToLocal(t: V3) {
        const d = V3.sub(t, this.pos);
        const q = this.unk19C;
        return qRotate(new Quat(-q.x, -q.y, -q.z, q.w), d);
    }
    doAdjustTarget() {
        let r = false;
        const t = this.PK.mTorqueY * (this.unk1D4 ? 3 : 1);
        this.unk1CC = fr(this.unk1CC + t);
        if (1 <= this.unk1CC) { this.unk1CC = 1; r = true; }
        this.unk19C.slerp(this.unk1AC, this.unk1BC, this.unk1CC);
        this.unk19C.normalize();
        return r;
    }
    prepareFly() {
        this.vel.set(setLength(this.getPlaneNormal(), this.PK.mFlySpeed));
        this.resetHitPlaneCounter();
        this.pos.add(this.getPlaneNormal().scale(this.headHeight)).fround();
        this.doFly();
    }
    doFly() {
        if (this.hitPlaneCounter > 30 || (this.isHitPlane() && this.spine!.time > 30)) {
            this.unk19C.setRotateFromTo(new V3(0, 1, 0), this.getPlaneNormal(), 1);
            return true;
        }
        return false;
    }
    isOnSamePlaneWithMario() {
        if (!this.unk198) return false;
        // (fencing / roofing: never, see the top)
        return this.isOnFloor() && Kumokun.isSameNormal(this.world.mario.groundPlane, this.unk198);
    }
    isOnFloor() { return 0.7 < this.getPlaneNormal().y; }
    isOnRoof() { return this.getPlaneNormal().y < -0.7; }
    isOnWall() { return !this.isOnFloor() && !this.isOnRoof(); }
    isWalking() { return this.spine!.getLatestNerve() === KumokunNerves.walk; }
    isAttack() {
        const n = this.spine!.getLatestNerve();
        if (this.isOnRoof() && this.world.mario.pos.y + 5 > this.pos.y) return false;
        return n === KumokunNerves.walk || n === KumokunNerves.search || n === KumokunNerves.wait || n === KumokunNerves.preWalk || n === KumokunNerves.postWalk;
    }
    isFlying() { return this.spine!.getLatestNerve() === KumokunNerves.fly; }
    isHitPlane() { return this.hitPlaneCounter > 0; }
    isFindOutMario(out: V3) {
        if (!this.isOnSamePlaneWithMario()) return false;
        out.set(this.rotateGoalDirToLocal(this.world.mario.pos));
        const range = this.PK.mSearchRange;
        let h = this.headHeight;
        if (this.isOnRoof()) h *= 3;
        // (abs(): an int's)
        return Math.abs(Math.trunc(out.y)) < h && out.squared() < range * range;
    }
    doKeepDistance() { return this.isOnSamePlaneWithMario() && !this.isAttack(); }
    isCollidMove(_a: HitActor) { return false; }
    resetHitPlaneCounter() { this.hitPlaneCounter = 0; }
    getPlaneNormal() { return this.unk198 ? normalOf(this.unk198) : new V3(); }
    static checkWallPlane(w: World, p: V3, h: number, r: number): BGCheckData | null {
        const rec: WallCheck = { center: [p.x, p.y + h, p.z], radius: r, maxResults: 1, flags: 0, results: [] };
        let wall: BGCheckData | null = null;
        if (w.isTouchedWallsAndMoveXZ(rec)) wall = rec.results[0];
        p.x = rec.center[0]; p.z = rec.center[2];
        return wall;
    }
    static checkFloorPlane(w: World, p: V3, h: number, _k: number): BGCheckData | null {
        const y = p.y;
        let [g, floor] = w.checkGround(p.x, y + h, p.z);
        g = fr(g + 1);
        if (y <= g + 0.05) { p.y = g; return floor; }
        return null;
    }
    static checkRoofPlane(w: World, p: V3, h: number): BGCheckData | null {
        const y = p.y;
        let [r, roof] = w.checkRoof(p.x, y, p.z);
        r = fr(r - 1);
        const f = r - y;
        if (0 <= f && f < h) { p.y = r; return roof; }
        return null;
    }
    static isSameNormal(a: BGCheckData | null, b: BGCheckData | null) {
        if (!a || !b) return false;
        return 0.99 <= a.n[0] * b.n[0] + a.n[1] * b.n[1] + a.n[2] * b.n[2];
    }
}
void isZero;

type S = Spine<Kumokun>;
export const KumokunNerves: Record<string, any> = {};
KumokunNerves.preWalk = nerve<Kumokun>('TNerveKumokunPreWalk', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck('kumo_run1_start');
    if (self.checkSerialAnmEnd()) { spine.pushAfterCurrent(KumokunNerves.walk); return true; }
    return false;
});
KumokunNerves.walk = nerve<Kumokun>('TNerveKumokunWalk', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.prepareWalk();
    if ((self.doWalk() || self.PK.mMarchTimer < spine.time) && self.checkCurAnmEnd(0)) { spine.pushAfterCurrent(KumokunNerves.postWalk); return true; }
    return false;
});
KumokunNerves.postWalk = nerve<Kumokun>('TNerveKumokunPostWalk', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck('kumo_run1_end');
    if (self.checkCurAnmEnd(0)) { spine.pushAfterCurrent(KumokunNerves.wait); return true; }
    return false;
});
KumokunNerves.search = nerve<Kumokun>('TNerveKumokunSearch', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.decideTarget();
        if (self.unk1D4) self.pushNextAnm('kumo_turn1_loop', true);
        else { self.pushNextAnm('kumo_turn1_loop', false); self.pushNextAnm('kumo_turn1_start', true); }
    }
    if (self.doAdjustTarget() && self.checkCurAnmEnd(ANM_BCK)) {
        if (self.mactor!.checkCurAnm('kumo_turn1_loop', ANM_BCK)) self.changeBck('kumo_turn1_end');
        else { spine.pushAfterCurrent(KumokunNerves.preWalk); return true; }
    }
    return false;
});
KumokunNerves.wait = nerve<Kumokun>('TNerveKumokunWait', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.unk1D4 = false; self.changeBck('kumo_wait1'); }
    if (self.isFindOutMario(new V3())) { spine.pushAfterCurrent(KumokunNerves.search); return true; }
    if (self.checkCurAnmEnd(0) && self.PK.mWaitTimer < spine.time) { spine.pushAfterCurrent(KumokunNerves.search); return true; }
    return false;
});
KumokunNerves.freeze = nerve<Kumokun>('TNerveKumokunFreeze', (spine: S) => {
    const self = spine.body, a = self.mactor!;
    if (spine.time === 0) {
        self.clearAnmStack();
        if (a.checkCurAnm('kumo_hit_end', ANM_BCK) || a.checkCurAnm('kumo_hit_start', ANM_BCK)) self.changeBck('kumo_hit_loop');
        else if (!a.checkCurAnm('kumo_hit_loop', ANM_BCK)) { self.pushNextAnm('kumo_hit_loop', false); self.pushNextAnm('kumo_hit_start', true); }
    }
    if (self.unk1D0 <= 0) { spine.pushAfterCurrent(KumokunNerves.postFreeze); return true; }
    return false;
});
KumokunNerves.postFreeze = nerve<Kumokun>('TNerveKumokunPostFreeze', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck('kumo_hit_end');
    if (self.checkCurAnmEnd(0)) { spine.pushAfterCurrent(KumokunNerves.search); return true; }
    return false;
});
KumokunNerves.fly = nerve<Kumokun>('TNerveKumokunFly', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.changeBck('kumo_flying1_loop'); self.prepareFly(); }
    if (self.doFly() || spine.time > 1800) { spine.pushAfterCurrent(SmallEnemyNerves.die); self.unk1EC = 1; return true; }
    return false;
});
KumokunNerves.preFly = nerve<Kumokun>('TNerveKumokunPreFly', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.clearAnmStack(); self.pushNextAnm('kumo_hit_start', true); }
    if (self.checkSerialAnmEnd()) { spine.pushAfterCurrent(KumokunNerves.fly); return true; }
    return false;
});

register('KumokunManager', (w, n) => new KumokunManager(w, n));
register('Kumokun', (w, n) => new Kumokun(w, n));
