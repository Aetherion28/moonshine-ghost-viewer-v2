// TGenerator / TOneShotGenerator (Enemy/generator.cpp): spawn points for an enemy manager's
// enemies. TGenerator (ジェネレーター) puts one of its manager's far-out enemies at its place on
// its graph every mInterval movement ticks (the first after a random part of it); a
// TOneShotGenerator does it once, when water hits it. Both throw the enemy up at speed 4 along
// their rotation's Y axis (TSpineEnemy::resetSRTV).
//
// Also the TEnemyManager / TSpineEnemy helpers the spawners use (getFarOutEnemy, resetSRTV),
// which the engine doesn't have yet.

import { fr, V3, MsRandF, MsMtxSetRotRPH, mtx, mtxMultVec } from '../math.js';
import { World, NameRef, HitActor, Stream, EnemyManager, SpineEnemy, GraphWeb, LF, HF, HC, CUE_MOVE } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';

/** TEnemyManager::getFarOutEnemy: the first dead one, else the clipped-out reusable one nearest Mario. */
export function getFarOutEnemy(m: EnemyManager): SpineEnemy | null {
    let dist = -1, best: SpineEnemy | null = null;
    for (let i = 0; i < m.getActiveObjNum(); ++i) {
        const e = m.objs[i] as SpineEnemy;
        if (e.checkLiveFlag(LF.DEAD)) { best = e; break; }
        if (!e.checkLiveFlag(LF.CLIPPED_OUT) || !e.checkLiveFlag(LF.UNK800)) continue;
        if (!best || dist > e.distToMarioSq) { best = e; dist = e.distToMarioSq; }
    }
    return best;
}

/** TSpineEnemy::resetSRTV */
export function resetSRTV(e: SpineEnemy, p: V3, r: V3, s: V3, v: V3) {
    e.pos.set(p);
    e.offLiveFlag(LF.UNK8); e.offLiveFlag(LF.DEAD);
    e.reset();
    e.rot.set(r);
    if (s !== e.scale) e.scale.set(s);
    e.resetHitPoints();
    e.offHitFilter(HF.NO_COLLISION);
    e.vel.set(v);
    e.onLiveFlag(LF.UNK8000); e.onLiveFlag(LF.AIRBORNE);
    e.control();
}

/** The spawn the generators and launchers share: at p, thrown at 4 along rotation rot's Y axis. */
export function throwOut(e: SpineEnemy, p: V3, rot: V3) {
    const m = mtx();
    MsMtxSetRotRPH(m, rot.x, rot.y, rot.z);
    const vel = mtxMultVec(m, new V3(0, 4, 0));
    resetSRTV(e, p, new V3(0, 0, 0), e.scale, vel);
}

const managerByName = (w: World, name: string | null) => (name ? (w.conductor.getManagerByName(name) as EnemyManager | null) : null);

/** TConductor::registerGenerator: (the conductor performs its generators after its alone actors, before its other objects). */
function registerGenerator(w: World, g: NameRef) { w.conductor.generators.push(g); }

export class Generator extends NameRef {
    pos = new V3(); rot = new V3();
    managerName: string | null = null; manager: EnemyManager | null = null;
    graphName: string | null = null; graph: GraphWeb | null = null;
    interval = 1; timer = 0;
    constructor(public world: World, name = '<TGenerator>') { super(name); }
    load(s: Stream) {
        super.load(s);
        this.pos.set(s.f32(), s.f32(), s.f32());
        this.rot.set(s.f32(), s.f32(), s.f32());
        s.f32(); s.f32(); s.f32();
        s.str();
        const n = s.s32();
        for (let i = 0; i < n; i++) { s.s32(); s.str(); }
        this.graphName = s.str();
        this.managerName = s.str();
        this.interval = s.s32();
        this.timer = Math.trunc(fr(this.interval * MsRandF()));
        registerGenerator(this.world, this);
    }
    perform(cue: number) {
        if (!(cue & CUE_MOVE)) return;
        this.timer -= 1;
        if (this.timer < 0) this.timer = this.interval;
        if (this.timer !== 0) return;
        if (!this.manager) this.manager = managerByName(this.world, this.managerName);
        if (!this.manager) return;   // (the game would crash)
        const e = getFarOutEnemy(this.manager);
        if (!e) return;
        if (!this.graph) this.graph = this.world.graphByName(this.graphName);
        e.tracer.graph = this.graph;   // getTracer()->setGraph
        throwOut(e, this.pos, this.rot);
    }
}

export class OneShotGenerator extends HitActor {
    managerName: string | null = null; manager: EnemyManager | null = null;
    graphName: string | null = null; graph: GraphWeb | null = null;
    count = 1;
    private hitInit = false;
    constructor(public world: World, name = '<TOneShotGenerator>') { super(name); }
    load(s: Stream) {
        super.load(s);
        this.graphName = s.str();
        this.managerName = s.str();
    }
    loadAfter() {
        if (this.hitInit) return;   // (mCollisions == nullptr: initHitActor not run yet)
        this.hitInit = true;
        this.manager = managerByName(this.world, this.managerName);
        if (!this.graph) this.graph = this.world.graphByName(this.graphName);
        this.initHitActor(AT.GENERATOR, 1, HC.PLAYER, 80, 120, 80, 120);
        this.offHitFilter(HF.NO_COLLISION);
        this.world.addToGroup('敵グループ', this);
        this.world.conductor.generators.push(this);
    }
    receiveMessage(sender: HitActor, _msg: number) {
        if (!sender.isActorType(AT.WATER)) return false;
        if (this.count !== 0) {
            const e = this.manager ? getFarOutEnemy(this.manager) : null;
            if (e) { e.tracer.graph = this.graph; throwOut(e, this.pos, this.rot); }
            this.count = 0;
        }
        return true;
    }
}

register('Generator', (w, n) => new Generator(w, n));
register('OneShotGenerator', (w, n) => new OneShotGenerator(w, n));
