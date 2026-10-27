// The Bullet Bills of Pinna Park's roller coaster fight (Enemy/coasterkiller.cpp): TCoasterEnemy
// (a TWalkerEnemy that flies along the "killer" graph — the coaster's track — node after node,
// forward (mPathDir 0, mSLCoasterSpeedInOrder) or backward (1, mSLCoasterSpeedReverse), turning
// its quaternion a tenth of the way toward where it heads each tick and righting itself),
// TCoasterKiller (コースターキラー: hits Mario and blows up; blown up too by water, another
// coaster Bullet Bill or a flying rocket) and TCoasterKillerManager (コースターキラーマネージャー).
// Mecha-Bowser (enemies/tinkoopa.ts) fires them from his killer_null joints; the manager's unk60
// is set when he's beaten (then they no longer hurt Mario).
//
// This TU doesn't derive from TKiller (Enemy/killer.cpp): only the model files and animations
// (the "killer" folder) are shared.
//
// Not here: the smoke particle and the flying sound (startSoundActorWithInfo every frame), the
// camera shake, the TEV colour packets (mBodyColor...: always black) and the animation sounds.

import { fr, V3, Quat, mtx } from '../math.js';
import { World, Stream, HitActor, LF, HF, MSG, ANM_BCK, nerve, Spine, Params, CUE_CALC_ANIM } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SmallEnemyManager, SmallEnemyNerves, LIVE_FLAG_MELT_ON_DEATH } from './smallEnemy.js';
import { WalkerEnemy, walkerParams } from './walker.js';
import { sendToMario } from '../mapobj/lib.js';
import type { Rocket } from './rocket.js';
import { SE } from '../soundids.js';
import { holdKey } from '../sound.js';

// ---------------------------------------------------------------- params
/** TCoasterEnemyParams + TCoasterKillerSaveLoadParams (/enemy/coasterkiller.prm) */
const COASTER_KILLER_PARAMS = { mSLCoasterSpeedInOrder: ['f', 20], mSLCoasterSpeedReverse: ['f', 20], mSLBombRange: ['f', 300] } as const;
function coasterKillerParams(path: string, w: World) {
    const p = walkerParams(path, w.files, COASTER_KILLER_PARAMS as any);
    // TCoasterEnemyParams sets the speeds to 20 / 16 after its load, then TCoasterKillerSaveLoadParams
    // loads the file again: the file's values win where it has them.
    const f = new Params(path, w.files);
    if (!f.has('mSLCoasterSpeedInOrder')) p.mSLCoasterSpeedInOrder = 20;
    if (!f.has('mSLCoasterSpeedReverse')) p.mSLCoasterSpeedReverse = 16;
    return p;
}

// killer_bastable's animations (the "killer" folder): downkiller_down1 is 0, killer_search1 3
export const COASTER_KILLER_ANM_DOWN = 0, COASTER_KILLER_ANM_FLY = 3;

// ---------------------------------------------------------------- quaternion helpers (JGeometry::TQuat4<f32>)
const EPS = 1.1920929e-7;
/** TQuat4::getYDir */
const quatYDir = (q: Quat) => new V3(fr(2 * q.x * q.y - 2 * q.w * q.z), fr(1 - 2 * q.x * q.x - 2 * q.z * q.z), fr(2 * q.y * q.z + 2 * q.w * q.x));
/** TQuat4::setRotate(from, to, amount): the rotation turning from to to, the amount of the way */
function quatFromTo(q: Quat, from: V3, to: V3, amount: number) {
    const ax = new V3().cross(from, to), l = fr(ax.length());
    if (l <= EPS) return q.set4(0, 0, 0, 1);
    const h = fr(fr(0.5 * Math.atan2(l, from.dot(to))) * amount), k = fr(Math.sin(h) / l);
    return q.set4(fr(ax.x * k), fr(ax.y * k), fr(ax.z * k), fr(Math.cos(h)));
}
/** TQuat4::rotate(v, out) */
function quatRotate(q: Quat, v: V3) {
    const m = q.toMtx(mtx(), new V3());
    return new V3(fr(m[0] * v.x + m[1] * v.y + m[2] * v.z), fr(m[4] * v.x + m[5] * v.y + m[6] * v.z), fr(m[8] * v.x + m[9] * v.y + m[10] * v.z));
}

// ---------------------------------------------------------------- TCoasterEnemy
export class CoasterEnemy extends WalkerEnemy {
    /** 0x194: the graph node it heads for */
    mPathIdx = 0;
    /** 0x198: 0 along the track's order, 1 against it */
    mPathDir = 0;
    /** 0x19C */
    mQuat = new Quat();
    constructor(w: World, name = '') { super(w, name); }
    get PC(): any { return this.getSaveParam(); }
    init(m: any) {
        super.init(m);
        this.tracer.init(this.world.graphByName('killer'));
        this.tracer.reset();
        this.goToShortestNextGraphNode();
        this.spine!.initWith(CoasterKillerNerves.wander);
        this.onLiveFlag(LF.DEAD);
        this.onLiveFlag(LF.UNK10);
        this.mQuat.set4(0, 0, 0, 1);
    }
    getPathIdx() { return this.mPathIdx; }
    getPathDir() { return this.mPathDir; }
    /** bind: no ground or walls, it just moves */
    bind() {
        const next = this.pos.clone().add(this.posDelta).add(this.vel);
        this.posDelta.set(V3.sub(next, this.pos));
    }
    reset() {
        super.reset();
        this.offLiveFlag(LF.DEAD);
        this.onLiveFlag(LF.AIRBORNE);
        this.mPathDir = 0;
        this.mPathIdx = 0;
    }
    getGravityY() { return 0; }
    makeCoasterGoalPath() { this.setGoalPathFromGraph(); this.unk128 = 0; this.unk12C = 0; }
    /** moveCoaster: toward the current node at the direction's speed, the nose turned a tenth of the way to it, then righted */
    moveCoaster() {
        const delta = this.tracer.current().sub(this.pos);
        delta.normalize();
        const t = this.getPathDir() === 0 ? this.PC.mSLCoasterSpeedInOrder : this.PC.mSLCoasterSpeedReverse;
        this.vel.set(delta);
        this.vel.scale(t);
        const forward = this.mQuat.getZDir(new V3()).fround();
        const up = quatYDir(this.mQuat);
        const steer = quatFromTo(new Quat(), forward, delta, 0.1);
        this.mQuat.mul(steer, this.mQuat);
        // (the Y-axis rotation: its up axis turned toward the vertical of its old heading)
        const right = new V3().cross(forward, new V3(0, 1, 0)).fround();
        if (right.length() > 0) {
            right.normalize();
            const tilt = new Quat().setRotateAxis(right, fr(Math.PI / 2));
            const curUp = quatRotate(tilt, forward);
            quatFromTo(steer, up, curUp, 0.1);
            this.mQuat.mul(steer, this.mQuat);
        }
        this.mQuat.normalize();
    }
    calcRootMatrix() { this.mQuat.toMtx(this.baseTR, this.pos); }
    setWalkAnm() { this.setNormalFlyAnm(); }
    setNormalFlyAnm() { }
}

// ---------------------------------------------------------------- TCoasterKiller
export class CoasterKiller extends CoasterEnemy {
    /** 0x1AC: how far its collision grows when it blows up */
    unk1AC = 0;
    mKillerModel: any = null; mDownModel: any = null;
    constructor(w: World, name = 'コースターキラー') { super(w, name); }
    get mgrCK() { return this.manager as CoasterKillerManager; }
    init(m: any) {
        super.init(m);
        this.actorType = AT.COASTER_KILLER;
        this.unk150 = 17;
        this.onLiveFlag(LF.FORCE_SHADOW);
        this.offLiveFlag(LF.UNK800);
        // (mBodyColor, mNoseColor, mEyesColor, mBaseColor: black)
    }
    // perform: TCoasterEnemy's, plus the smoke (not here) and the flying sound
    perform(cue: number) {
        super.perform(cue);
        if ((cue & CUE_CALC_ANIM) && !this.checkLiveFlag(LF.DEAD) && this.spine!.current !== CoasterKillerNerves.explosion)
            this.world.sound(SE.EN_KILLER_FLY_KUPPA, this.pos, { hold: holdKey(this, 'fly') });   // (startSoundActorWithInfo: by its distance to Mario)
    }
    setMActorAndKeeper() {
        this.mKillerModel = this.createMActorByName('killer_model1.bmd');
        this.mDownModel = this.createMActorByName('downkiller_model1.bmd');
        this.mactor = this.mKillerModel;
    }
    attackToMario() {
        const s = this.spine!;
        if (s.current !== CoasterKillerNerves.explosion) {
            s.pushNerve(CoasterKillerNerves.explosion);
            if (this.mgrCK.unk60 === 0) sendToMario(this.world, this, MSG.ATTACK);
        }
    }
    isCollidMove(a: HitActor) {
        const s = this.spine!;
        if (s.current === CoasterKillerNerves.explosion) return false;
        if (a.isActorType(AT.COASTER_KILLER)) s.pushNerve(CoasterKillerNerves.explosion);
        if (a.isActorType(AT.ROCKET) && typeof (a as Rocket).isAttack === 'function' && (a as Rocket).isAttack()) s.pushNerve(CoasterKillerNerves.explosion);
        return true;
    }
    behaveToWater(_a: HitActor) { if (this.spine!.current !== CoasterKillerNerves.explosion) this.spine!.pushNerve(CoasterKillerNerves.explosion); }
    setNormalFlyAnm() { this.mactor = this.mKillerModel; this.setBckAnm(COASTER_KILLER_ANM_FLY); }
    setDeadAnm() {
        this.mactor = this.mDownModel;
        this.setBckAnm(COASTER_KILLER_ANM_DOWN);
        const e = this.world.conductor.makeOneEnemyAppear(this.pos, 'エフェクト爆発マネージャー', 1) as any;
        if (e) { e.generate(this.pos, this.scale); e.scale.scale(0.6); }
    }
}

// ---------------------------------------------------------------- nerves
type S = Spine<CoasterKiller>;
export const CoasterKillerNerves: Record<string, any> = {};
CoasterKillerNerves.wander = nerve<CoasterEnemy>('TNerveCoasterEnemyWander', (spine: Spine<CoasterEnemy>) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.setWalkAnm();
        self.initialGraphNode();
        self.tracer.setTo(self.getPathIdx());
        self.makeCoasterGoalPath();
    }
    if (self.isReachedToGoal()) {
        const n = self.tracer.graph!.count;
        if (self.getPathDir() === 0) { self.mPathIdx++; if (self.mPathIdx >= n) self.mPathIdx = 0; }
        else { self.mPathIdx--; if (self.mPathIdx < 0) self.mPathIdx = n - 1; }
        self.tracer.setTo(self.getPathIdx());
        self.makeCoasterGoalPath();
    }
    self.moveCoaster();
    return false;
});
CoasterKillerNerves.explosion = nerve<CoasterKiller>('TNerveCoasterKillerExplosion', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.unk1AC = fr(fr(self.PC.mSLBombRange * self.bodyScale) / self.attackRadius);
        self.rot.x = 0;
        self.setDeadAnm();
        // (the camera shake)
    }
    if (self.unk190 < self.unk1AC) self.unk190 = fr(self.unk190 * 1.3);
    else {
        self.onHitFilter(HF.NO_COLLISION);
        if (self.checkCurAnmEnd(ANM_BCK)) {
            self.onLiveFlag(LF.DEAD); self.onLiveFlag(LF.UNK8); self.offLiveFlag(LIVE_FLAG_MELT_ON_DEATH);
            self.holder = null;
            spine.reset();
            spine.setNext(SmallEnemyNerves.die);
            spine.pushAfterCurrent(spine.default);
            return true;
        }
    }
    self.expandCollision();
    return false;
});

// ---------------------------------------------------------------- TCoasterKillerManager
export class CoasterKillerManager extends SmallEnemyManager {
    /** 0x60: set when Mecha-Bowser is beaten (his last TNerveTinKoopaBreak): they stop hurting Mario */
    unk60 = 0;
    constructor(w: World, name = 'コースターキラーマネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.saveParams = coasterKillerParams('/enemy/coasterkiller.prm', this.world);
    }
    createModelData() { this.createModelDataArray(['killer_model1.bmd', 'downkiller_model1.bmd']); }
    createEnemyInstance() { return new CoasterKiller(this.world); }
    /** TEnemyManager::getDeadEnemy */
    getDeadEnemy(): CoasterKiller | null {
        const n = this.getActiveObjNum();
        for (let i = 0; i < n; i++) if ((this.objs[i] as CoasterKiller).checkLiveFlag(LF.DEAD)) return this.objs[i] as CoasterKiller;
        return null;
    }
}

register('CoasterKillerManager', (w, n) => new CoasterKillerManager(w, n));
register('CoasterKiller', (w, n) => new CoasterKiller(w, n));
