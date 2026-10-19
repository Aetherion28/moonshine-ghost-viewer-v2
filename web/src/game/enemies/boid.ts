// Flocks (Animal/boid.cpp, fishoid.cpp's TRealoid / TRealoidActor) and butterflies
// (Animal/Butterfly.cpp: 蝶Ａ/Ｂ/Ｃ). TBoidLeader steers its boids each frame (separation,
// alignment, cohesion, a goal: a point moving along the graph, or a fixed point / an actor, and
// fleeing from Mario); TRealoid is the scene object holding the flock, TRealoidActor one of its
// members (a hit actor with its own model). A butterfly flock eaten whole (by Yoshi) puts out
// its item: a coin (A), its event's item (B) or a 1-Up (C).

import { fr, V3, MsRandF, MsAngleDiff, MsGetRotFromZaxisY, MsMtxSetRotRPH, mtx, Mtx } from '../math.js';
import { World, SpineEnemy, EnemyManager, LiveManager, LiveActor, PathNode, GraphTracer, GraphWeb, LF, HF, MSG, nerve, Stream, MActor, CUE_CALC_ANIM, HitActor, TakeActor } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { jnormalize, setLength, ItemRef, itemByEventID, itemByName, appearItem } from './animal.js';

/** TNerveWaitForever<TLiveActor> */
const waitForever = nerve('TNerveWaitForever', () => false);

// ---------------------------------------------------------------- TBoid / TBoidLeader
export class Boid {
    pos = new V3(); rot = new V3(); heading = new V3(0, 0, 1);
    sep = new V3(); ali = new V3(); coh = new V3();
    neighbors = 0;
    speed = 0;
    constructor() { this.speed = MsRandF(); }
}

export const BOID_SIMULATE = 1, BOID_USE_GRAPH_GOAL = 4;
export class BoidLeader {
    boids: Boid[];
    tracer: GraphTracer | null = null;
    flags = 0;
    baseSpeed = 6; neighborRadius = 150; yawSpeed = 2; pitchSpeed = 2; maxPitch = 10; alignmentStrength = 0.01;
    goal = new PathNode(null, new V3()); goalStrength = 1; goalOffset = new V3();
    unk58 = 0;
    fleeTarget = new PathNode(null, new V3()); fleeRadius = 0; fleeStrength = 1;
    graphGoal = new V3();
    constructor(num: number, public name = '') {
        this.boids = [];
        for (let i = 0; i < num; i++) this.boids.push(new Boid());
        this.flags |= BOID_SIMULATE;
    }
    get num() { return this.boids.length; }
    setGraph(web: GraphWeb | null, p: V3) {
        if (!web || web.isDummy()) return;
        if (!this.tracer) this.tracer = new GraphTracer();
        this.tracer.init(web);
        this.tracer.setTo(web.findNearestNodeIndex(p, -1));
        this.graphGoal.set(this.tracer.current());
        this.flags |= BOID_USE_GRAPH_GOAL;
    }
    perform(cue: number) { if (cue & CUE_CALC_ANIM) { this.updateGoal(); this.calcBoids(); } }
    updateGoal() {
        if (!(this.flags & BOID_USE_GRAPH_GOAL)) return;
        const t = this.tracer!;
        const d = V3.sub(t.current(), this.graphGoal);
        // (TGraphTracer::moveToRandomNext)
        if (d.squared() < 10000) t.moveTo(t.graph!.getRandomNextIndex(t.cur, t.prev, -1));
        else { d.normalize().scale(0.9 * this.baseSpeed); this.graphGoal.add(d).fround(); }
    }
    calcGoalForce(p: V3) {
        const f = new V3();
        if (this.flags & BOID_USE_GRAPH_GOAL) { f.set(this.graphGoal).sub(p); jnormalize(f); }
        else {
            f.set(this.goal.point()).add(this.goalOffset).sub(p);
            const l = f.length();
            if (0 < l) f.scale(1 / l).scale(this.goalStrength); else f.zero();
        }
        return f;
    }
    calcForces(b: Boid) {
        const f = b.sep.clone().add(b.ali.clone().scale(this.alignmentStrength)).add(b.coh).add(this.calcGoalForce(b.pos));
        if (f.squared() === 0) return new V3();
        f.scale(fr(fr(0.01) * fr(5 * MsRandF() + 95)));   // (fmadds, then fmuls by the f32 0.01)
        jnormalize(f);
        if (0 < this.fleeRadius) {
            const r = this.fleeRadius;
            const away = V3.sub(b.pos, this.fleeTarget.point());
            const d2 = away.squared();
            if (0 < d2 && d2 < r * r) { setLength(away, this.fleeStrength); f.set(away); }
        }
        return f;
    }
    calcBoids() {
        if (!(this.flags & BOID_SIMULATE)) return;
        const B = this.boids;
        for (const b of B) { b.sep.zero(); b.coh.zero(); b.ali.zero(); b.neighbors = 0; }
        for (let a = 0; a < B.length; a++) {
            const i = B[a];
            for (let c = a + 1; c < B.length; c++) {
                const j = B[c];
                const d = V3.sub(i.pos, j.pos);
                const d2 = d.squared();
                if (d2 < 0.001) continue;
                const r = this.neighborRadius;
                if (d2 < r * r) {
                    const s = d.clone().scale(1 / d2).scale(r);
                    i.sep.add(s); j.sep.sub(s);
                    i.ali.add(j.heading); j.ali.add(i.heading);
                    i.coh.add(j.pos); j.coh.add(i.pos);
                    i.neighbors++; j.neighbors++;
                }
            }
            if (i.neighbors > 0) {
                const inv = 1 / i.neighbors;
                i.coh.scale(inv).sub(i.pos); jnormalize(i.coh);
                i.ali.scale(inv);
                const mag = i.ali.length();
                if (mag > 0) { i.ali.scale(1 / mag).sub(i.heading); jnormalize(i.ali); }
            }
        }
        const m = mtx();
        for (const b of B) {
            const f = this.calcForces(b);
            if (!(f.squared() <= 1.1920929e-7)) {
                if (f.y < -0.01) { b.rot.x += this.pitchSpeed; if (b.rot.x > this.maxPitch) b.rot.x = this.maxPitch; }
                else if (f.y > 0.01) { b.rot.x -= this.pitchSpeed; if (b.rot.x < -this.maxPitch) b.rot.x = -this.maxPitch; }
                else b.rot.x = fr(b.rot.x * 0.98);
                const target = MsGetRotFromZaxisY(f);
                let diff = MsAngleDiff(target, b.rot.y);
                if (diff < -0.01) diff = -this.yawSpeed;
                else if (diff > 0.01) diff = this.yawSpeed;
                let y = fr(b.rot.y + diff);
                while (y >= 360) y -= 360;
                while (y < 0) y += 360;
                b.rot.y = y;
            }
            MsMtxSetRotRPH(m, b.rot.x, b.rot.y, b.rot.z);
            b.heading.set(m[2], m[6], m[10]).normalize().fround();
            b.pos.add(b.heading.clone().scale((this.baseSpeed + b.speed) * f.length())).fround();
        }
    }
}

// ---------------------------------------------------------------- TRealoidActor
export const RF_CLIPPED_OUT = 0x1, RF_UNK2 = 0x2, RF_UNK4 = 0x4, RF_UNK2_OR_UNK4 = 0x6;
/**
 * TRealoidActor (a TTakeActor in the game): a LiveActor here only so the viewer draws it (it's
 * in world.extras); its own perform is the game's.
 */
export abstract class RealoidActor extends LiveActor {
    rflags = 0;
    takingMtx: Mtx = mtx();
    constructor(w: World, mactor: MActor | null) {
        super(w, 'boid');
        this.mactor = mactor;
        w.extras.push(this);
    }
    onFlag(f: number) { this.rflags |= f; }
    offFlag(f: number) { this.rflags &= ~f; }
    checkFlag(f: number) { return (this.rflags & f) !== 0; }
    abstract initRealoid(): void;
    perform(cue: number) {
        if (this.rflags & RF_UNK2_OR_UNK4) return;
        // (THitActor::perform; MActor::perform: calcAnm)
        if (!(this.rflags & RF_CLIPPED_OUT) && this.mactor && (cue & CUE_CALC_ANIM)) this.mactor.frameUpdate();
    }
    getTakingMtx() { return this.takingMtx; }
    checkHitActors() {
        if (this.rflags & RF_UNK2_OR_UNK4) return;
        for (const c of this.collisions) if (c.actorType === AT.MARIO) this.world.mario.receiveMessage(this, MSG.ATTACK);
    }
    calcRootMatrixOnTaking() { const m = this.holder!.getTakingMtx(); if (m) this.baseTR.set(m); }
    calcBoidRootMatrix(b: Boid) {
        if (this.rflags & RF_UNK2_OR_UNK4) return;
        this.pos.set(b.pos);
        if (this.holder) {
            const hm = this.holder.getTakingMtx();
            if (hm) b.pos.set(hm[3], hm[7], hm[11]);
            this.calcRootMatrixOnTaking();
            return;
        }
        const t = b.pos.clone(), r = this.baseTR;
        const up = new V3(0, 1, 0), dir = b.heading.clone(), n = new V3();
        n.cross(up, dir).normalize();
        up.cross(dir, n).normalize();
        dir.cross(n, up).normalize();
        r[0] = -dir.x; r[4] = -dir.y; r[8] = -dir.z;
        r[1] = up.x; r[5] = up.y; r[9] = up.z;
        r[2] = n.x; r[6] = n.y; r[10] = n.z;
        r[3] = t.x; r[7] = t.y; r[11] = t.z;
    }
    /** For the viewer: hidden (eaten, not out yet) or clipped isn't drawn. */
    drawn() { return !(this.rflags & (RF_UNK2_OR_UNK4 | RF_CLIPPED_OUT)); }
    moveObject() { }
}

// ---------------------------------------------------------------- TRealoid
export abstract class Realoid extends SpineEnemy {
    leader!: BoidLeader;
    actors: RealoidActor[] = [];
    constructor(w: World, name = '') { super(w, name); this.liveFlag |= LF.UNK10 | LF.UNK20 | LF.UNK8; }
    abstract createRealoidActor(m: MActor | null): RealoidActor;
    getRealoid(i: number) { return this.actors[i]; }
    /** loadDefault: the scene object, its count, the flock (each 10 above the last), on the graph. */
    loadDefault(s: Stream, model: string, _extra: number) {
        SpineEnemy.prototype.load.call(this, s);
        const count = s.s32();
        this.leader = new BoidLeader(count, 'コントローラ');
        this.leader.goal = new PathNode(null, this.pos.clone());
        this.leader.setGraph(this.tracer.graph, this.pos);
        this.actors = [];
        const p = this.pos.clone();
        for (let i = 0; i < count; i++) {
            const m = this.createMActorByName(model);
            this.leader.boids[i].pos.set(p);
            this.actors.push(this.createRealoidActor(m));
            p.y += 10;
        }
    }
    clipBoids() {
        for (let i = 0; i < this.leader.num; i++) {
            if (this.world.inView(this.leader.boids[i].pos, 100, 10000)) this.actors[i].offFlag(RF_CLIPPED_OUT);
            else this.actors[i].onFlag(RF_CLIPPED_OUT);
        }
    }
    perform(cue: number) {
        this.leader.perform(cue);
        if (cue & CUE_CALC_ANIM) {
            this.clipBoids();
            for (let i = 0; i < this.leader.num; i++) this.actors[i].calcBoidRootMatrix(this.leader.boids[i]);
        }
        for (let i = 0; i < this.leader.num; i++) this.actors[i].perform(cue);
    }
}

// ---------------------------------------------------------------- butterflies
const BUTTERFLY_MODELS = ['butterflyA.bmd', 'butterflyB.bmd', 'butterflyC.bmd'];

export class Butterfly extends RealoidActor {
    constructor(w: World, m: MActor | null, public flock: Butterfloid) { super(w, m); }
    initRealoid() {
        this.initHitActor(AT.BUTTERFLY, 0, 0, 0, 0, 50, 50);
        this.offHitFilter(HF.NO_COLLISION);
        this.onHitFilter(HF.NO_ATTACK);
        this.world.addToGroup('敵グループ', this);
    }
    receiveMessage(sender: HitActor, msg: number) {
        switch (msg) {
            case MSG.TAKE: if (!this.holder) { this.holder = sender as TakeActor; this.world.effect('ms_enm_wathit', this.pos); return true; } break;
            case MSG.DETACH: if (this.holder) { this.holder = null; return true; } break;
            case MSG.UNKB: this.flock.receiveMessageFromChild(this); return true;
        }
        return false;
    }
}

export class Butterfloid extends Realoid {
    item: ItemRef | null = null;
    numEaten = 0;
    constructor(w: World, public type: number, name = '') { super(w, name); }
    init(m: LiveManager | null) {
        this.manager = m;
        if (m) m.manageActor(this);
        this.spine!.initWith(waitForever);
        this.initHitActor(0, 1, 0, 0, 0, 0, 0);
        this.onHitFilter(HF.NO_COLLISION);
    }
    initBoids() { for (let i = 0; i < this.leader.num; i++) this.actors[i].initRealoid(); }
    receiveMessageFromChild(c: Butterfly) {
        c.onFlag(RF_UNK4);
        c.onHitFilter(HF.NO_COLLISION);
        if (++this.numEaten === this.leader.num && this.item) appearItem(this.world, this.item, c.pos, new V3(0, 15, 0));
    }
    load(s: Stream) {
        this.loadDefault(s, BUTTERFLY_MODELS[this.type], 0);
        this.loadItem(s);
        const L = this.leader;
        L.neighborRadius = 100; L.baseSpeed = 6; L.yawSpeed = 25; L.pitchSpeed = 8; L.maxPitch = 16; L.alignmentStrength = 0.7;
        L.fleeTarget = new PathNode(this.world.mario);
        L.fleeRadius = 500; L.fleeStrength = 2;
        L.flags |= 2;
        for (const a of this.actors) if (a.mactor) a.mactor.setBck('butterfly_fly');
        this.initBoids();
    }
    loadItem(s: Stream) {
        const id = s.u32();
        switch (this.type) {
            case 0: this.item = itemByName('coin'); break;
            case 1: this.item = itemByEventID(this.world, id, ''); break;
            case 2: this.item = itemByName('mushroom1upR'); break;
        }
    }
    createRealoidActor(m: MActor | null) { return new Butterfly(this.world, m, this); }
}

export class ButterfloidManager extends EnemyManager {
    createModelData() { this.createModelDataArray(BUTTERFLY_MODELS); }
}

register('ButterflyManager', (w, n) => new ButterfloidManager(w, n));
register('Butterfly', (w, n) => new Butterfloid(w, 0, n));
register('ButterflyB', (w, n) => new Butterfloid(w, 1, n));
register('ButterflyC', (w, n) => new Butterfloid(w, 2, n));
