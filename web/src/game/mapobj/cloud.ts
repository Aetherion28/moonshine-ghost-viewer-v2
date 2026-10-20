// Things that ride a rail (MoveBG/MapObjRailBlock.cpp's TRailMapObj) and the clouds Mario can
// ride (MoveBG/MapObjCloud.cpp's TRideCloud): a cloud waits for him to stand on it, then follows
// its rail; it sinks a little under him, swells while sprayed, and lets him jump up through it.
// A node flagged 0x1000 makes it blink out and come back at its start. On a spline rail (a graph
// named "S_...") it slides along the curve, turned to face its way.

import { fr, V3, JMAHermiteInterpolation, MsClamp } from '../math.js';
import { World, Stream, Actor, HitActor, GraphTracer, GraphWeb, HF, CUE_ENTRY, CUE_CALC_VIEW } from '../engine.js';
import { register } from '../scene.js';
import { MapObjBase, MOF } from './base.js';
import { MsMtxSetTRS } from './objcol.js';
import { marioGroundPlane, marioTouchGround4cm, marioStatus, marioSpeedY } from './lib.js';

export class RailMapObj extends MapObjBase {
    tracer: GraphTracer | null = null;
    unk13C = 0;
    /** rail flags: 1 Mario rides it, 2 it waits */
    unk140 = 0;
    unk144 = 2;
    /** 0 moving, 1 coming back, 2 blinking out to its start */
    unk148 = 0; unk14A = 180;
    /** drawn (blinking) */
    unk14C = 1;
    constructor(w: World, name: string) { super(w, name); }
    onRailFlag(f: number) { this.unk140 |= f; }
    offRailFlag(f: number) { this.unk140 &= ~f; }
    checkRailFlag(f: number) { return (this.unk140 & f) !== 0; }
    private node(i = this.tracer!.cur) { return this.tracer!.graph!.nodes[i]; }
    load(s: Stream) {
        Actor.prototype.load.call(this, s);
        this.individualName = s.str();
        const graph = s.str();
        this.initialPos.set(this.pos); this.initialRot.set(this.rot); this.initialScale.set(this.scale);
        this.initGraphTracer(this.world.graphByName(graph));
        this.initMapObj();
        this.makeObjAppeared();
    }
    initGraphTracer(g: GraphWeb) {
        const t = this.tracer = new GraphTracer();
        t.graph = g;
        if (g && !g.isDummy()) {
            t.setTo(g.findNearestNodeIndex(this.pos, -1));
            if (g.spline) { this.pos.set(t.current()); this.moveToShortestNext(); }
            if (this.node().flags & 0x80) this.onRailFlag(2);
            this.resetStep(this.unk144);
        }
    }
    resetStep(sp: number) {
        const p = this.tracer!.current();
        this.unk13C = Math.trunc(fr(fr(Math.sqrt(V3.sub(p, this.pos).squared())) / sp));
    }
    moveToNextNode(sp: number) {
        const t = this.tracer!;
        if (!t.graph || t.graph.isDummy()) return false;
        if (t.graph.spline) {
            const result = t.traceSpline(t.calcSplineSpeed(sp));
            const [p, r] = t.graph.spline.getPosAndRot(t.unk14);
            this.posDelta.add(p.sub(this.pos));
            this.rot.set(r);
            if (result) this.readRailFlag();
            if (this.unk13C > 0) --this.unk13C;
            return result;
        }
        const target = t.graph.point(t.cur);
        const d = V3.sub(target, this.pos);
        if (d.squared() < sp * sp * 2 || this.unk13C === 0) {
            this.readRailFlag();
            this.pos.set(target);
            return true;
        }
        const l = Math.sqrt(d.squared());
        d.x = fr(fr(d.x / l) * sp); d.y = fr(fr(d.y / l) * sp); d.z = fr(fr(d.z / l) * sp);
        this.posDelta.add(d);
        if (this.unk13C > 0) --this.unk13C;
        return false;
    }
    checkMarioRiding() {
        const w = this.world, g = marioGroundPlane(w);
        if (!this.checkRailFlag(1)) {
            if (g && g.actor === this && marioTouchGround4cm(w)) {
                const st = marioStatus(w);
                if ((st & 0x200) && !(st & 0x200000)) { this.onRailFlag(1); this.offRailFlag(2); }
            }
        } else if (!g || g.actor !== this || !marioTouchGround4cm(w)) this.offRailFlag(1);
        return this.checkRailFlag(1);
    }
    calcRecycle() {
        switch (this.unk148) {
            case 0: return false;
            case 1:
                if (this.unk14A < 180) { ++this.unk14A; return true; }
                this.unk148 = 0; this.unk14A = 180; this.unk14C = 1;
                return false;
            case 2:
                if (this.unk14A > 0) {
                    --this.unk14A;
                    const k = Math.trunc(this.world.moveTickCount / 4);
                    if (this.unk14A < 90) this.unk14C = k % 2 > 0 ? 1 : 0;
                    else this.unk14C = k % 4 > 0 ? 1 : 0;
                    return true;
                }
                this.resetPosition();
                return false;
        }
        return false;
    }
    resetPosition() {
        this.pos.set(this.initialPos); this.rot.set(this.initialRot);
        this.unk148 = 0; this.unk14A = 180; this.unk14C = 1;
        const t = this.tracer!;
        if (t.graph) t.setTo(t.graph.findNearestNodeIndex(this.pos, -1));
        this.readRailFlag();
    }
    initMapObj() { super.initMapObj(); this.offHitFilter(HF.NO_COLLISION); }
    setGroundCollision() {
        if (!this.colMgr) return;
        if (this.unk14A !== 0 && (!this.checkMapObjFlag(MOF.MOVE_COLLISION_ON_CONTACT) || this.collisions.length !== 0)) this.colMgr.moveActiveCollisionMtx(this.rootMtx());
    }
    readRailFlag() {
        const t = this.tracer;
        if (!t || !t.graph || t.cur < 0) return;
        const f = this.node().flags;
        if (f & 0x100) this.onRailFlag(2);
        if (f & 0x1000) { this.unk14A = 180; this.unk148 = 2; }
    }
    control() {
        super.control();
        this.checkMarioRiding();
        if (!this.calcRecycle() && !this.checkRailFlag(2)) {
            if (this.moveToNextNode(this.unk144)) {
                this.readRailFlag();
                this.moveToShortestNext();
                this.resetStep(this.unk144);
            }
        }
    }
    moveToShortestNext() { const t = this.tracer!; if (t.graph) t.moveTo(t.graph.getShortestNextIndex(t.cur, t.prev, -1)); }
    perform(cue: number) {
        if ((cue & CUE_ENTRY) && this.unk14C === 0) cue &= ~CUE_ENTRY;
        super.perform(cue);
    }
    /** for the viewer: off while it blinks */
    drawn() { return super.drawn() && this.unk14C !== 0; }
}

// ---------------------------------------------------------------- TRideCloud
export class RideCloud extends RailMapObj {
    static mMoveSpeedDefault = 2; static mCushionLen = 80; static mCushionSpeed = fr(0.015); static mScaleSpeed = fr(0.005);
    /** how far it has sunk under Mario (0..1) */
    unk150 = 0; unk154 = 0;
    /** spray time left (ticks, up to 600) */
    unk158 = 0;
    unk15C = RideCloud.mMoveSpeedDefault;
    /** its X / Y / Z swell */
    unk160 = 1; unk164 = 1; unk168 = 1;
    /** its wait at a node (ticks) */
    unk16C = 0;
    /** the TEV colours (reg 0 and 1) it's drawn with */
    color0 = { r: 0, g: 0, b: 0, a: 0 }; color1 = { r: 0, g: 0, b: 0, a: 0 };
    constructor(w: World, name = '乗れる雲') { super(w, name); }
    touchWater(_a: HitActor) { this.unk158 += 10; if (this.unk158 > 600) this.unk158 = 600; return 1; }
    setGroundCollision() { if (this.colMgr) this.colMgr.moveActiveCollisionMtx(this.rootMtx()); }
    calcRootMatrix() {
        const y = JMAHermiteInterpolation(this.unk150, 0, 0, 0, 1, -RideCloud.mCushionLen, 0);
        MsMtxSetTRS(this.baseTR, this.pos.x, fr(this.pos.y + y), this.pos.z, this.rot.x, this.rot.y, this.rot.z,
            fr(this.scale.x * this.unk160), fr(this.scale.y * this.unk164), fr(this.scale.z * this.unk168));
        this.anmMtx0 = null;
    }
    initMapObj() { super.initMapObj(); this.unk154 = this.scaledBodyRadius; }
    load(s: Stream) {
        super.load(s);
        const rd = () => s.u32() & 0xFF;
        this.color0 = { r: rd(), g: rd(), b: rd(), a: 0xFF }; s.u32();
        this.color1 = { r: rd(), g: rd(), b: rd(), a: 0xFF }; s.u32();
    }
    control() {
        MapObjBase.prototype.control.call(this);
        const col = this.colMgr && this.colMgr.getActiveCollision();
        // Mario jumps up through it
        if (col) col.setAllBGType(marioSpeedY(this.world) > 0 ? 0x400 : 0);
        this.checkMarioRiding();
        const C = RideCloud;
        this.unk150 = MsClamp(fr(this.unk150 + (this.checkRailFlag(1) ? C.mCushionSpeed : -C.mCushionSpeed)), 0, 1);
        let d: number;
        if (this.unk158 > 0) { d = C.mScaleSpeed; --this.unk158; }
        else d = -C.mScaleSpeed;
        this.unk160 = MsClamp(fr(this.unk160 + d), 1, 3);
        this.unk168 = MsClamp(fr(this.unk168 + d), 1, 3);
        this.damageRadius = fr(fr(this.scale.x * 300) * this.unk160);
        this.damageHeight = 50;
        this.calcEntryRadius();
        if (!this.calcRecycle() && !this.checkRailFlag(2)) {
            if (this.unk16C !== 0) { --this.unk16C; return; }
            const t = this.tracer!;
            if (!t.graph || t.graph.isDummy()) return;
            if (this.moveToNextNode(this.unk15C)) {
                const n = t.graph.nodes[t.cur];
                if (n.flags & 0x1000) { this.unk14A = 180; this.unk148 = 2; }
                this.moveToShortestNext();
                if (n.flags & 0x800) this.unk16C = n.pitch;
                const n2 = t.graph.nodes[t.cur];
                if (n2.yaw !== 0xFFFF) this.unk15C = fr(n2.yaw * 0.01);
                this.resetStep(this.unk15C);
            }
        }
    }
    perform(cue: number) {
        if (cue & CUE_CALC_VIEW) this.scaledBodyRadius = fr(this.unk154 * this.scale.x);
        super.perform(cue);
    }
}

register('RideCloud', (w, n) => new RideCloud(w, n));
