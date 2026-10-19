// TFireWanwan / TFireWanwanTailHit / TFireWanwanManager (Enemy/fireWanwan.cpp): Pianta Village's
// burning Chain Chomps (ファイアーわんわん, episode 1). One wanders its graph trailing a five-link
// burning tail (TTailRubber: a damped spring chain bound to the ground), burns Mario on touch
// (BURN, then mStopSearchTimerMax ticks before it looks for him again) and leaves goop
// behind it (a stamp every mPolluteTimerMax ticks, wider while charging). Seeing Mario it turns to
// him (TNerveFireWanwanFindMario: a slerp over its search animation) and charges
// (TNerveFireWanwanAttack) until it misses him or tires. Water cools it: every hit takes off hit
// points (mRecoverRate a tick gives them back while it burns); at 0 its fire goes out and it
// runs (TNerveFireWanwanEscape, black) — then Mario can grab its tail, swing it and let go
// (TNerveFireWanwanHungTail / Fly: it flies off at the swing's power, bouncing off walls,
// breaking wooden boxes) and it lies stunned (TNerveFireWanwanFreeze) before it relights
// (TNerveFireWanwanRecover). Thrown into the pond (checkInPond) it dies (TNerveFireWanwanDie:
// silver, sunk); with every one dead the manager makes the boss Shine appear.
//
// Not here: particles, camera shake and rumble (updateCameraShake / updateRumble: their timers
// only gate rumble), the help balloons (told to the viewer as 'balloon:<id>' effects, as
// bosspakkun does). MarioProxy never sends TAKE, so the tail is never grabbed from a ghost.
//
// From the binary (the decomp's NonMatching source has these wrong): checkHungTail is
// `canTakenByMario() && unk194->isTaken()`, doTurn's and the bounce's abs() are fabs().

import { fr, V3, Quat, Mtx, mtx, MsRandF, MsSin, MsCos, MsWrap, MsAngleDiff, MsGetRotFromZaxisY } from '../math.js';
import { World, HitActor, TakeActor, LiveActor, FrameCtrl, LF, HF, MSG, nerve, Spine, Stream, ANM_BCK, ANM_BTK, ANM_FRAME_RATE, CUE_MOVE, CUE_CALC_ANIM, FC_ONCE, PathNode, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemy, SmallEnemyManager, smallParams } from './smallEnemy.js';
import type { BGCheckData, WallCheck } from '../collision.js';
import { mapObjGlobals } from '../mapobj/base.js';
import type { ItemManager } from '../mapobj/item.js';
import { SE } from '../sound.js';
import { register } from '../scene.js';

/** TFireWanwanSaveLoadParams */
const FIREWANWAN_PARAMS = {
    mMarchSpeed: ['f', 3], mAttackSpeedRate: ['f', 2.6], mAttackTimerMax: ['i', 600], mEscapeSpeedRate: ['f', 1], mEscapeRecoverTime: ['i', 600],
    mSLFlySpeed: ['f', 30], mSLFlyGravityY: ['f', 5], mAirFric: ['f', 0.99], mFloorFric: ['f', 0.9], mRotateY: ['f', 1],
    mNoCollideTimerMax: ['i', 300], mStopSearchTimerMax: ['i', 600], mTailLengthToFly: ['f', 100], mCamShakeRange: ['f', 1000], mContShakeRange: ['f', 750],
    mPolluteTimerMax: ['i', 20], mFreezeTimeThreshold: ['f', 50], mSLFreezeWaitShort: ['i', 120], mRecoverRate: ['f', 0.1], mPolluteNormalRate: ['f', 0.7],
    mPolluteAttackRate: ['f', 1.5], mTailEndPowRate: ['f', 0.06], mRubberBoundRate: ['f', 0.25], mRubberDecay: ['f', 0.5], mRubberBoundRateHitting: ['f', 0.7],
    mRubberDecayHitting: ['f', 0.6], mTailEndColRange: ['f', 100], mTailApartPowRate: ['f', 0.1], mTailMaxLength: ['f', 300], mBoss22HelpRange: ['f', 2000],
    mBoss23TimerMax: ['i', 1200],
} satisfies PSchema;

/** the body's TEVREG0 (GXColorS10) */
export const cBodyColorOnFire = [400, -50, -100, 0], cBodyColorOnCool = [-50, -50, 50, 0], cBodyColorOnSilver = [260, 260, 270, 0];

const EPS = 3.81469727e-6;   // TUtil<f32>::epsilon
const PI = 3.1415927, HALF_PI = 1.5707964;
const velocityMinY = -40;
const isZero = (v: V3) => v.squared() <= EPS;
function setLength(v: V3, len: number) { const l = v.squared(); if (l <= EPS) return v.zero(); return v.scale(len / Math.sqrt(l)).fround(); }
const scaleAdd = (s: number, b: V3, c: V3) => new V3(fr(b.x + c.x * s), fr(b.y + c.y * s), fr(b.z + c.z * s));
const qEulerY = (a: number) => new Quat(0, fr(Math.sin(0.5 * a)), 0, fr(Math.cos(0.5 * a)));
function qRotate(q: Quat, v: V3) {
    const p = new Quat().mul(new Quat().mul(q, new Quat(v.x, v.y, v.z, 0)), new Quat(-q.x, -q.y, -q.z, q.w));
    return new V3(fr(p.x), fr(p.y), fr(p.z));
}
function isAntiparallel(a: V3, b: V3) { const k = fr(a.dot(b) - -1); return -EPS <= k && k <= EPS; }
const s16 = (v: number) => (Math.trunc(v) << 16) >> 16;

// BCKs (/scene/fireWanwan, in the folder's order: fireWanwan_bastable)
const BCK_DAMAGE = 0, BCK_HIT = 1, BCK_RETURN = 2, BCK_RUN = 3, BCK_RUN_END = 4, BCK_SEARCH = 5, BCK_WAIT = 6, BCK_WALK = 7;
void BCK_WAIT;

/** TLerpControl: a colour going from one to another over a J3DFrameCtrl's length. */
export class LerpControl {
    cur = cBodyColorOnFire.slice(); start = cBodyColorOnFire.slice(); end = cBodyColorOnFire.slice();
    fc = new FrameCtrl();
    init(to: number[], from: number[], len: number) {
        this.start = from.slice(); this.end = to.slice(); this.cur = from.slice();
        this.fc.init(len); this.fc.attr = FC_ONCE; this.fc.rate = ANM_FRAME_RATE;
    }
    setCurrent(c: number[]) { this.cur = c.slice(); }
    update() {
        this.fc.update();
        const t = this.fc.state & 1 ? 1 : fr(this.fc.frame / this.fc.end);
        for (let i = 0; i < 3; i++) this.cur[i] = s16(this.start[i] + (this.end[i] - this.start[i]) * t);
    }
}

interface RubberNode { pos: V3; vel: V3; }
/** TTailRubber: the tail's spring chain. */
export class TailRubber {
    nodes: RubberNode[] = [];
    fixHead = true; fixTail = true; boundRate = 0.25; decay = 0.5; maxLength = 0;
    constructor(public w: World, n: number) { for (let i = 0; i < n; i++) this.nodes.push({ pos: new V3(), vel: new V3() }); }
    reset(head: V3, tail: V3) {
        this.setHeadPos(head); this.setTailPos(tail);
        const d = V3.sub(tail, head), n = this.nodes.length;
        for (let i = 1; i < n - 1; ++i) { this.nodes[i].pos.set(scaleAdd(fr(i / n), head, d)); this.nodes[i].vel.zero(); }
    }
    setHeadPos(p: V3) { this.nodes[0].pos.set(p); this.nodes[0].vel.zero(); }
    setTailPos(p: V3) { const t = this.nodes[this.nodes.length - 1]; t.pos.set(p); t.vel.zero(); }
    movement() {
        this.adjust(); this.restrict(); this.bind();
        const N = this.nodes;
        for (let i = 1; i < N.length - 1; i++) N[i].pos.add(N[i].vel).fround();
        if (!this.fixHead) N[0].pos.add(N[0].vel).fround();
        if (!this.fixTail) N[N.length - 1].pos.add(N[N.length - 1].vel).fround();
    }
    bind() { for (let i = 1; i < this.nodes.length - 1; i++) this.bindOne(this.nodes[i]); }
    bindOne(n: RubberNode) {
        const next = V3.add(n.pos, n.vel);
        let [h] = this.w.checkGround(next.x, next.y + 40, next.z);
        h = fr(fr(h + 1) + 20);
        if (next.y <= 0.05 + h) { n.vel.zero(); next.y = h; }
        this.w.isTouchedOneWallAndMoveXZ(next, next.y + 40, 20);
        n.vel.set(V3.sub(next, n.pos)).fround();
    }
    adjust() {
        const N = this.nodes;
        for (let i = 1; i < N.length - 1; i++) this.adjustOne(N[i], N[i - 1], N[i + 1]);
        this.adjustOne(N[0], { pos: N[0].pos.clone(), vel: new V3() }, N[1]);
        const L = N.length - 1;
        this.adjustOne(N[L], N[L - 1], { pos: N[L].pos.clone(), vel: new V3() });
    }
    adjustOne(c: RubberNode, prev: RubberNode, next: RubberNode) {
        const a = V3.sub(prev.pos, c.pos).scale(this.boundRate), b = V3.sub(next.pos, c.pos).scale(this.boundRate);
        c.vel.add(a).add(b).scale(this.decay).fround();
    }
    restrict() {
        let avg = this.getLength();
        if (avg <= this.maxLength) return;
        const N = this.nodes;
        avg = fr(avg / (N.length - 1));
        if (this.fixTail) {
            for (let i = N.length - 2; i >= 0; --i) {
                const d = V3.sub(N[i + 1].pos, N[i].pos); d.y = 0;
                const l = d.length();
                if (avg < l) { setLength(d, l - avg); N[i].pos.add(d).fround(); }
            }
        } else {
            for (let i = 1; i < N.length; ++i) {
                const d = V3.sub(N[i - 1].pos, N[i].pos); d.y = 0;
                const l = d.length();
                if (avg < l) { setLength(d, l - avg); N[i].pos.add(d).fround(); }
            }
        }
    }
    getLength() {
        let t = 0;
        for (let i = 0; i < this.nodes.length - 1; i++) { const d = V3.sub(this.nodes[i].pos, this.nodes[i + 1].pos); d.y = 0; t = fr(t + d.length()); }
        return t;
    }
}

/** TFireWanwanTailNode: one link of the tail (wanwanTail.bmd), drawn by the viewer (world.extras). */
export class FireWanwanTailNode extends LiveActor {
    /** its tail_null1 joint's matrix (setBarAnmMtx: the next link's place, so the link stretches to it) */
    barMtx: Mtx = mtx();
    unk10 = 0;
    constructor(public owner: FireWanwan) {
        super(owner.world, 'wanwanTail.bmd');
        this.manager = owner.manager; this.mactor = this.createMActorByName('wanwanTail.bmd'); this.manager = null;
        this.offLiveFlag(LF.ENABLE_CLIPPING);
    }
    /** the link's TEVREG0 (the tail's colour, GXColorS10) */
    get tevColor0() { return this.owner.tail ? this.owner.tail.unkBC.cur : cBodyColorOnFire; }
    setBarAnmMtx(m: Mtx) { this.barMtx.set(m); }
    performNode(cue: number, p: V3, dir: V3) {
        if (cue & CUE_CALC_ANIM) {
            const x = setLength(new V3().cross(new V3(0, 1, 0), dir), 1);
            const y = setLength(new V3().cross(dir, x), 1);
            const m = this.baseTR;
            m[0] = x.x; m[4] = x.y; m[8] = x.z; m[1] = y.x; m[5] = y.y; m[9] = y.z; m[2] = dir.x; m[6] = dir.y; m[10] = dir.z;
            m[3] = p.x; m[7] = p.y; m[11] = p.z;
            this.pos.set(p);
        }
        if (!(this.unk10 & 4) && this.mactor && (cue & CUE_CALC_ANIM)) this.mactor.frameUpdate();
    }
    perform() { }
    drawn() { return !this.owner.checkLiveFlag(LF.DEAD) && !(this.unk10 & 4) && !this.owner.checkLiveFlag(LF.UNK200); }
}

/** TFireWanwanTailHit (ファイヤーワンワン尻尾当たり): the tail's end, which Mario grabs. */
export class FireWanwanTailHit extends TakeActor {
    unk74: Mtx = mtx();
    rubber!: TailRubber;
    links: FireWanwanTailNode[] = [];
    unkBC = new LerpControl();
    isOnFire = false;
    curTailLength = 0; prevTailLength = 0; throwPow = 0;
    constructor(public owner: FireWanwan) { super('ファイヤーワンワン尻尾当たり'); }
    get world() { return this.owner.world; }
    receiveMessage(sender: HitActor, msg: number) {
        if (sender.isActorType(AT.MARIO)) {
            if (msg === MSG.TAKE) { if (!this.owner.canTakenByMario()) return false; this.behaveTaken(sender); return true; }
            if (msg === MSG.THROWN || msg === MSG.DETACH) { this.behaveApart(); return true; }
        }
        return false;
    }
    behaveTaken(a: HitActor) {
        this.holder = a as TakeActor;
        this.rubber.fixTail = true;
        this.world.sound(SE.EN_WANWAN_HOLD, this.pos);
        (this.owner.manager as FireWanwanManager).unk64 = 1;
        this.curTailLength = this.rubber.getLength();
        this.prevTailLength = this.curTailLength;
        this.moveRequest(this.pos);
    }
    behaveApart() {
        this.rubber.fixTail = false;
        (this.owner.manager as FireWanwanManager).unk64 = 0;
        this.owner.startThrownSound();
        this.throwPow = this.calcApartPow();
        this.curTailLength = 0; this.prevTailLength = 0;
        this.holder = null;
    }
    init() {
        this.rubber = new TailRubber(this.world, 5);
        const p = this.owner.getTailPos();
        this.rubber.reset(p, p);
        this.rubber.fixHead = true; this.rubber.fixTail = false;
        this.unkBC.setCurrent(cBodyColorOnFire);
        for (let i = 0; i < 5; ++i) {
            const n = new FireWanwanTailNode(this.owner);
            const s = this.owner.bodyScale * (i === 4 ? 2 : 1);
            n.scale.set(s, s, s);
            const np = this.rubber.nodes[i].pos;
            n.baseTR[3] = np.x; n.baseTR[7] = np.y; n.baseTR[11] = np.z; n.pos.set(np);
            this.links.push(n);
            this.world.extras.push(n);
        }
        this.world.addToGroup('敵グループ', this);
        this.initHitActor(AT.FIRE_WANWAN_TAIL_HIT, 0, 0, 0, 0, 30, 200);
        this.offHitFilter(HF.NO_COLLISION);
        this.onHitFilter(HF.NO_ATTACK);
        this.isOnFire = false;
    }
    perform(cue: number) {
        const P = this.owner.PF;
        this.damageRadius = P.mTailEndColRange;
        if (cue & CUE_MOVE) this.movementBody(this.owner.getTailPos());
        this.performNodes(cue);
        {
            const m = this.links[4].baseTR;
            this.pos.set(m[3], fr(m[7] - this.damageHeight * 0.5), m[11]);
        }
        if ((cue & CUE_CALC_ANIM) && this.isOnFire) this.onFireEffect();
        if (cue & CUE_CALC_ANIM) this.unkBC.update();
        if (this.holder) {
            const d = V3.sub(this.rubber.nodes[4].pos, this.owner.pos);
            calcToDirMatrix(this.unk74, d, new V3(0, 1, 0));
            const v = this.rubber.nodes[4].vel.clone().scale(P.mTailEndPowRate);
            v.y = 0;
            this.pos.add(v).fround();
            this.moveRequest(this.pos);
            this.unk74[3] = this.pos.x; this.unk74[7] = this.pos.y; this.unk74[11] = this.pos.z;
            this.prevTailLength = this.curTailLength;
            this.curTailLength = this.rubber.getLength();
            if (0 < this.curTailLength - this.prevTailLength) this.world.sound(SE.EN_WANWAN_PULL, this.rubber.nodes[2].pos);
        }
    }
    performNodes(cue: number) {
        const N = this.rubber.nodes;
        for (let i = 0; i < 5; ++i) {
            const p = N[i].pos.clone();
            const d = i === 4 ? new V3(0, 0, 1) : setLength(V3.sub(N[i + 1].pos, p), 1);
            this.links[i].performNode(cue, p, d);
        }
        for (let i = 0; i < 5; ++i) {
            const m = this.links[i].baseTR.slice() as Mtx;
            // (getNode(i + 1): past the last node for the last link — the last node here)
            const q = N[Math.min(i + 1, 4)].pos;
            m[3] = q.x; m[7] = q.y; m[11] = q.z;
            this.links[i].setBarAnmMtx(m);
        }
    }
    movementBody(p: V3) {
        const o = this.owner, P = o.PF, r = this.rubber;
        if (o.isHungTailNerve() && !this.holder && !o.isReadyToFly()) { r.boundRate = P.mRubberBoundRateHitting; r.decay = P.mRubberDecayHitting; }
        else if (o.isAttacking()) { r.boundRate = 0.7; r.decay = 0.4; }
        else { r.boundRate = P.mRubberBoundRate; r.decay = P.mRubberDecay; }
        r.maxLength = o.isFlying() ? P.mTailMaxLength : 10000;
        r.nodes[0].pos.set(p);
        r.movement();
    }
    calcApartPow() {
        const P = this.owner.PF;
        const k = fr(P.mTailApartPowRate * this.rubber.getLength() / P.mSLFlySpeed);
        const c = k < 0 ? 0 : k > 1 ? 1 : k;
        return fr(c * c * P.mSLFlySpeed);
    }
    getTakingMtx() { return this.unk74; }
    moveRequest(p: V3) {
        const n = p.clone();
        const [h] = this.world.checkGround(n.x, n.y + 100, n.z);
        if (n.y <= 0.05 + h) n.y = fr(h + 1);
        n.y = fr(n.y + 50);
        this.world.isTouchedOneWallAndMoveXZ(n, n.y, 70);
        this.rubber.nodes[4].pos.set(n);
        this.pos.set(n);
        this.unk74.set(mtx()); this.unk74[3] = n.x; this.unk74[7] = n.y; this.unk74[11] = n.z;
        return true;
    }
    onFireEffect() {
        // (MS_MOE_FIRE_A..D on the last link, at bodyScale * hitPoints / max)
        this.world.sound(SE.EN_WANWAN_FLAME, this.pos);
    }
    offFireEffect() { this.world.effect('moeFireOff', new V3(this.links[4].baseTR[3], this.links[4].baseTR[7], this.links[4].baseTR[11]), new V3(this.owner.bodyScale, this.owner.bodyScale, this.owner.bodyScale)); }
    changeBodyToRed(t: number) { this.unkBC.init(cBodyColorOnFire, this.unkBC.cur, t); }
    changeBodyToBlack(t: number) { this.unkBC.init(cBodyColorOnCool, this.unkBC.cur, t); }
    changeBodyToSilver(t: number) { this.unkBC.init(cBodyColorOnSilver, this.unkBC.cur, t); }
    getHostPos() { return this.owner.pos; }
    isTaken() { return !!this.holder; }
}

/** SMS_CalcToDirMatrix: a rotation whose z axis is dir (up as near y as it goes), no translation change. */
function calcToDirMatrix(m: Mtx, dir: V3, up: V3) {
    const z = setLength(dir.clone(), 1);
    if (isZero(z)) return;
    const x = setLength(new V3().cross(up, z), 1);
    const y = new V3().cross(z, x);
    m[0] = x.x; m[4] = x.y; m[8] = x.z; m[1] = y.x; m[5] = y.y; m[9] = y.z; m[2] = z.x; m[6] = z.y; m[10] = z.z;
}

export class FireWanwanManager extends SmallEnemyManager {
    mBoss22BalloonWasShown = false; mShineAppeared = false;
    /** set while Mario holds a tail (the 23rd balloon's timer counts up from 1) */
    unk64 = 0;
    mWanwanRecoversBeforeHelpBalloon = 3; mWanwansKilled = 0;
    mLastKillerWanwan: FireWanwan | null = null;
    constructor(w: World, name = 'ファイアーわんわんマネージャー') { super(w, name); }
    get PF(): any { return this.saveParams; }
    load(s: Stream) {
        super.load(s);
        this.saveParams = smallParams('/enemy/fireWanwan.prm', this.world.files, FIREWANWAN_PARAMS);
    }
    createModelData() { this.createModelDataArray(['wanwan.bmd']); }
    perform(cue: number) {
        super.perform(cue);
        for (const o of this.objs as FireWanwan[]) {
            if (!this.world.isInArea(o.pos.x, o.pos.z) || (o.groundPlane && o.groundPlane.isDeathPlane())) o.reset();
        }
        if (cue & CUE_MOVE) { this.checkBalloonHelpBoss22(); this.checkBalloonHelpBoss23(); this.checkBalloonHelpBoss24(); this.checkShineAppear(); }
    }
    balloon(id: number, p: V3) { this.world.effect('balloon:' + id.toString(16), p); }
    checkBalloonHelpBoss22() {
        if (this.mBoss22BalloonWasShown) return;
        const m = this.world.mario.pos;
        const w = this.getNearestEnemy(m);
        if (w) {
            const d = V3.sub(m, w.pos), r = this.PF.mBoss22HelpRange;
            if (d.squared() < r * r) { this.mBoss22BalloonWasShown = true; this.balloon(0xE0016, w.pos); }
        }
    }
    checkBalloonHelpBoss23() {
        const max = this.PF.mBoss23TimerMax;
        if (this.mWanwansKilled <= 0 && this.unk64 !== 0 && max > this.unk64) {
            if (++this.unk64 >= max) { this.unk64 = max; this.balloon(0xE0017, this.world.mario.pos); }
        }
    }
    checkBalloonHelpBoss24() {
        if (this.mWanwanRecoversBeforeHelpBalloon === 0) { this.balloon(0xE0018, this.world.mario.pos); this.mWanwanRecoversBeforeHelpBalloon = -1; }
    }
    checkShineAppear() {
        if (this.mShineAppeared) return;
        // (SMSGetMarDirector()->unk124 != 3 and no console balloon showing: taken as so)
        if (this.mWanwansKilled === this.getActiveObjNum() && this.mLastKillerWanwan) {
            this.mShineAppeared = true;
            const k = this.mLastKillerWanwan.pos;
            const im = mapObjGlobals(this.world).itemManager as ItemManager | null;
            if (im) im.makeShineAppearWithDemo('シャイン（ボス用）', 'ボスシャインカメラ', k.x, fr(k.y + 500), k.z);
        }
    }
    receiveMessageFromTail(_i: number) { }
    receiveMessageFromBody(_w: FireWanwan, msg: number) {
        if (msg === 0 && this.mWanwanRecoversBeforeHelpBalloon > 0) this.mWanwanRecoversBeforeHelpBalloon -= 1;
    }
}

export class FireWanwan extends SmallEnemy {
    static mTailJntIndex = 5;
    tail: FireWanwanTailHit | null = null;
    mTurnTargetAngle = 0; mNoCollideTimer = 0; mStopSearchTimer = 0; mApproachRumbleTimer = 0; mHungTailRumbleTimer = 0;
    mPolluteTimer = 0; mFreezeWait = 0; mRecoverTimer = 0;
    unk1BC = new Quat(); unk1CC = new Quat();
    mInitialPosition = new V3();
    unk238 = new LerpControl();
    get PF(): any { return this.getSaveParam(); }
    /** the body's TEVREG0 (_mat_body, GXColorS10: red burning, black cooled, silver dead) */
    get tevColor0() { return this.unk238.cur; }
    tevColorMaterial = '_mat_body';
    constructor(w: World, name = 'ファイアーわんわん') { super(w, name); }
    setMActorAndKeeper() { this.mactor = this.createMActorByName('wanwan.bmd'); }
    init(m: any) {
        super.init(m);
        this.actorType = AT.FIRE_WANWAN;
        this.unk150 = 1;
        this.spine!.initWith(FireWanwanNerves.graphWander);
        this.baseTR.set(mtx()); this.baseTR[3] = this.pos.x; this.baseTR[7] = this.pos.y; this.baseTR[11] = this.pos.z;
        this.tail = new FireWanwanTailHit(this);
        this.tail.init();
        this.unk238 = new LerpControl();
        this.mInitialPosition = this.pos.clone();
        this.reset();
    }
    reset() {
        if (!this.tail) { super.reset(); return; }
        this.pos.set(this.mInitialPosition);
        this.tail.isOnFire = true;
        this.tracer.reset();
        this.goToShortestNextGraphNode();
        super.reset();
        this.mPolluteTimer = 0; this.mRecoverTimer = 0;
        this.marchSpeed = this.PF.mMarchSpeed;
        this.spine!.reset();
        this.spine!.setDefaultNext();
        this.unk238.setCurrent(cBodyColorOnFire);
        this.unk238.init(cBodyColorOnFire, this.unk238.cur, 1);
        this.tail.unkBC.init(cBodyColorOnFire, this.tail.unkBC.cur, 1);
    }
    /** getTailMtx's place: joint 5's world matrix */
    getTailPos() {
        const m = this.mactor ? this.mactor.anmMtx(FireWanwan.mTailJntIndex, this.baseTR, this.scale) : null;
        return m ? new V3(m[12], m[13], m[14]) : this.pos.clone();
    }
    /** the "inline" in doWalk / doEscape / doAttack: the hit animation while sprayed */
    private sprayedAnm() {
        if (this.sprayCooldown !== 0) { const a = this.mactor!; if (!a.checkCurBckFromIndex(BCK_HIT)) a.setBckFromIndex(BCK_HIT); }
    }
    doWalk() {
        this.sprayedAnm();
        if (this.checkCurAnmEnd(0)) this.setBckAnm(BCK_WALK);
        this.walkToCurPathNode(this.marchSpeed, this.turnSpeed, 0);
    }
    doEscape() {
        this.sprayedAnm();
        if (this.checkCurAnmEnd(0)) this.setBckAnm(BCK_DAMAGE);
        this.walkToCurPathNode(this.marchSpeed * this.PF.mEscapeSpeedRate, this.turnSpeed, 0);
    }
    doAttack() {
        if (this.sprayCooldown !== 0) { const a = this.mactor!; if (!a.checkCurBckFromIndex(BCK_HIT)) a.setBckFromIndex(BCK_HIT); }
        else this.walkToCurPathNode(this.marchSpeed * this.PF.mAttackSpeedRate, this.turnSpeed, 0);
        if (this.checkCurAnmEnd(0)) this.setBckAnm(BCK_RUN);
        return this.isMissMario();
    }
    decideTarget(p: V3) {
        const l54 = V3.sub(p, this.pos);
        const l2C = l54.clone();
        l54.y = 0;
        setLength(l54, 1);
        if (isAntiparallel(l2C, new V3(0, 0, 1))) this.unk1CC = qEulerY(PI);
        else this.unk1CC.setRotateFromTo(new V3(0, 0, 1), l54, 1);
        this.unk1BC = qEulerY(fr(this.rot.y * (PI / 180)));
    }
    doAdjustTarget() {
        const c = this.mactor!.getFrameCtrl(ANM_BCK)!;
        let t = fr(c.frame / c.end);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const q = new Quat().slerp(this.unk1BC, this.unk1CC, t).normalize();
        const v = qRotate(q, new V3(0, 0, 1));
        this.rot.y = MsWrap(MsGetRotFromZaxisY(v), 0, 360);
    }
    getFreezeTime() { return this.mFreezeWait + 75; }
    isFindMario(k: number) {
        if (this.mStopSearchTimer > 0) return false;
        if (this.isMarioInWater()) return false;
        return this.isFindMarioFromParam(k);
    }
    isMissMario() {
        if (this.isMarioInWater()) return true;
        const P = this.PF;
        if (Math.abs(this.world.mario.pos.y - this.pos.y) > P.mSLGiveUpHeight) return true;
        if (V3.sub(this.goal104.point(), this.pos).length() > P.mSLGiveUpLength) return true;
        return false;
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        switch (msg) {
            case MSG.TRAMPLE: case MSG.HIP_DROP: return false;
            case MSG.SPRAYED_BY_WATER: {
                this.world.effect('enemyWaterHit', sender.pos);
                if (this.maxHitPoints() === this.hitPoints) this.world.sound(SE.EN_WANWAN_1ST_WATER, this.pos);
                this.decHpByWater(sender);
                this.behaveToWater(sender);
                if (this.sprayCooldown === 0) this.sprayCooldown = 1;
                return true;
            }
            default: return super.receiveMessage(sender, msg);
        }
    }
    behaveToWater(_a: HitActor) {
        const t = this.tail!;
        if (!t.isOnFire) {
            if (this.sprayCooldown === 0) this.world.sound(SE.BS_WANWAN_COOL_MORE, this.pos);   // (MS_CHO_ASE unless recovering)
            return;
        }
        if (this.hitPoints !== 0) {
            if (this.sprayCooldown === 0) this.world.sound(SE.EN_WANWAN_TO_COOL, this.pos);
            if (this.isWandering()) { this.spine!.reset(); this.spine!.setNext(FireWanwanNerves.findMario); }
            return;
        }
        this.world.sound(SE.EN_WANWAN_COOL, this.pos);
        this.spine!.reset();
        this.spine!.setNext(FireWanwanNerves.escape);
        t.offFireEffect();
        t.isOnFire = false;
        this.sprayCooldown = 20;
    }
    behaveHitComrades() {
        if (!this.isWalking() || this.mNoCollideTimer > 0) return;
        this.mNoCollideTimer = this.PF.mNoCollideTimerMax;
        this.spine!.reset();
        this.spine!.setNext(FireWanwanNerves.turn);
    }
    changeBodyToRed(t: number) { this.unk238.init(cBodyColorOnFire, this.unk238.cur, t); this.tail!.changeBodyToRed(t); }
    changeBodyToBlack(t: number) { this.unk238.init(cBodyColorOnCool, this.unk238.cur, t); this.tail!.changeBodyToBlack(t); }
    changeBodyToSilver(t: number) { this.unk238.init(cBodyColorOnSilver, this.unk238.cur, t); this.tail!.changeBodyToSilver(t); }
    startThrownSound() { this.world.sound(SE.EN_WANWAN_THROWN, this.pos); }
    stopTriggerSound() { }
    checkInPond() {
        const g = this.groundPlane;
        if (!this.checkLiveFlag(LF.AIRBORNE) && !g.isIllegal() && (g.isPool() || g.isWaterSurface()) && this.pos.y - this.groundHeight < this.headHeight) this.kill();
    }
    kill() {
        if (this.checkLiveFlag(LF.DEAD)) return;
        if (this.isDefeat()) return;
        this.spine!.reset();
        this.spine!.setNext(FireWanwanNerves.die);
    }
    isHitValid(_m: number) { return false; }
    perform(cue: number) {
        super.perform(cue);
        if (!(cue & CUE_CALC_ANIM)) this.calcRootMatrix();
        if (cue & CUE_CALC_ANIM) this.unk238.update();   // (emitEffects: particles only)
        if (!this.checkLiveFlag(LF.DEAD)) this.tail!.perform(cue);
    }
    calcRootMatrix() {
        super.calcRootMatrix();
        if (this.spine!.getLatestNerve() !== FireWanwanNerves.die) return;
        const m = this.baseTR;
        const v2 = setLength(new V3(m[2], m[6], m[10]), 1).scale(-160);
        m[3] = fr(m[3] + v2.x); m[7] = fr(m[7] + v2.y); m[11] = fr(m[11] + v2.z);
    }
    moveObject() {
        if (this.checkLiveFlag(LF.DEAD)) return;
        if (this.mNoCollideTimer > 0) this.mNoCollideTimer -= 1;
        if (this.mStopSearchTimer > 0) this.mStopSearchTimer -= 1;
        this.updateSquareToMario();
        this.updateCollisionFromParam();
        this.updatePollute();
        this.updateHitPoint();
        this.checkHungTail();
        this.posDelta.zero(); this.rotDelta.zero();
        this.control();
        if (!this.isInhibitedForceMove()) this.calcRideMomentum();
        this.checkHitActors();
        this.bind();
        const [h, d] = this.world.checkGround(this.pos.x, this.pos.y + this.headHeight, this.pos.z);
        this.groundHeight = h; this.groundPlane = d;
        this.checkInPond();
        this.setBehavior();
        this.pos.add(this.posDelta).fround();
        this.rot.add(this.rotDelta).fround();
        if (this.sprayCooldown > 0) this.sprayCooldown += 1;
        if (this.sprayCooldown > 30) this.sprayCooldown = 0;
        if (this.mapCollision) this.mapCollision.moveSRT(this.pos, this.rot, this.scale);
        if (!this.isInhibitedForceMove()) this.calcRidePos();
    }
    updateCollisionFromParam() {
        if (this.isDefeat()) return;
        const P = this.PF;
        this.setHitParams(P.mSLAttackRadius, P.mSLAttackHeight, P.mSLDamageRadius, P.mSLDamageHeight);
    }
    updatePollute() {
        if (!this.tail!.isOnFire) return;
        if (this.mPolluteTimer !== 0) { this.mPolluteTimer -= 1; return; }
        const P = this.PF;
        this.mPolluteTimer = P.mPolluteTimerMax;
        const m = this.baseTR;
        const v = scaleAdd(fr(fr(fr(MsRandF() - 0.5) * 2) * this.attackRadius), this.pos, new V3(m[0], m[4], m[8]));
        let r = 375;
        r = fr(r * (this.isAttacking() ? P.mPolluteAttackRate : P.mPolluteNormalRate));
        if (this.world.pollution) this.world.pollution.stamp(1, v.x, v.y, v.z, r);
    }
    updateHitPoint() {
        if (this.tail!.isOnFire) {
            this.mRecoverTimer = fr(this.mRecoverTimer + this.PF.mRecoverRate);
            if (1 <= this.mRecoverTimer) {
                this.mRecoverTimer = fr(this.mRecoverTimer - 1);
                const n = (this.hitPoints + 1) & 0xFF, max = this.maxHitPoints();
                this.hitPoints = n > max ? max : n;
            }
        }
        this.ensureTakeSituation();
    }
    checkHitActors() {
        for (const c of this.collisions.slice()) {
            if (c === this) continue;
            if (c.isActorType(AT.MARIO)) { this.attackToMario(); continue; }
            if (c.isActorType(AT.FIRE_WANWAN_TAIL_HIT)) continue;
            if (c.isActorType(AT.FIRE_WANWAN)) { this.behaveToHitOthers(c); this.behaveHitComrades(); (c as FireWanwan).behaveHitComrades(); continue; }
            this.behaveToHitOthers(c);
        }
    }
    checkHungTail() {
        if (this.canTakenByMario() && this.tail!.isTaken()) { this.spine!.reset(); this.spine!.setNext(FireWanwanNerves.hungTail); }
    }
    initTurnNextGraphNode() {
        // (TGraphTracer::popCurr: back the way it came)
        const t = this.tracer;
        const back = t.prev === -1 ? t.cur : t.prev;
        t.prev = t.cur; t.cur = back;
        this.setGoalPathFromGraph();
        this.unk128 = 0; this.unk12C = 0;
    }
    initEscapeNextGraphNode() {
        const g = this.tracer.graph!, m = this.world.mario.pos;
        const u1 = g.findNearestNodeIndex(this.pos, -1);
        const u2 = g.getEscapeFromMarioIndex(u1, -1, this.pos, m, -1);
        const p1 = V3.sub(m, this.pos);
        const p2 = u1 >= 0 ? g.point(u1).sub(this.pos) : new V3();
        const p3 = u2 >= 0 ? g.point(u2).sub(this.pos) : new V3();
        this.tracer.prev = -1;
        this.tracer.cur = 0 <= p1.dot(p2) && p1.dot(p3) < 0 ? u2 : u1;
        this.setGoalPathFromGraph();
        this.unk128 = 0; this.unk12C = 0;
    }
    recoverFire() { this.resetHitPoints(); this.tail!.isOnFire = true; }
    isDefeat() { return this.spine!.getLatestNerve() === FireWanwanNerves.die; }
    canTakenByMario() { const n = this.spine!.getLatestNerve(); return n === FireWanwanNerves.escape || n === FireWanwanNerves.freeze; }
    isTurning() { return this.spine!.getLatestNerve() === FireWanwanNerves.turn; }
    isFlying() { return this.spine!.getLatestNerve() === FireWanwanNerves.fly; }
    isWalking() { return this.spine!.getLatestNerve() === FireWanwanNerves.graphWander; }
    isWandering() { const n = this.spine!.getLatestNerve(); return n === FireWanwanNerves.recoverGraph || n === FireWanwanNerves.turn || this.isWalking(); }
    isAttacking() { return this.spine!.getLatestNerve() === FireWanwanNerves.attack; }
    isFreeze() { return this.spine!.getLatestNerve() === FireWanwanNerves.freeze; }
    isReadyToFly() { return !this.tail!.isTaken() && this.tail!.rubber.getLength() <= this.PF.mTailLengthToFly; }
    isRecovering() { return this.spine!.getLatestNerve() === FireWanwanNerves.recover; }
    isHungTailNerve() { return this.spine!.getLatestNerve() === FireWanwanNerves.hungTail; }
    prepareTurn() { this.mTurnTargetAngle = MsWrap(this.rot.y + 180, 0, 360); }
    doTurn() {
        const r = this.PF.mRotateY;
        const d = MsAngleDiff(this.mTurnTargetAngle, this.rot.y);
        this.rot.y = fr(this.rot.y + (d < -r ? -r : d > r ? r : d));
        this.rot.y = MsWrap(this.rot.y, 0, 360);
        return Math.abs(this.rot.y - this.mTurnTargetAngle) < 1;
    }
    sendAttackMsgToMario() { }
    attackToMario() {
        if (!this.tail!.isOnFire) return;
        const n = this.spine!.getLatestNerve();
        if (n !== FireWanwanNerves.fly && n !== FireWanwanNerves.escape && n !== FireWanwanNerves.recover) {
            if (!this.isFreeze()) {
                this.world.mario.receiveMessage(this, MSG.BURN);
                this.mStopSearchTimer = this.PF.mStopSearchTimerMax;
            }
        }
    }
    bind() {
        const P = this.PF, v = this.vel;
        v.y = fr(v.y - this.getGravityY());
        if (v.y < velocityMinY) v.y = velocityMinY;
        if (v.x < -100) v.x = -100; if (v.y < -100) v.y = -100; if (v.z < -100) v.z = -100;
        if (v.x > 100) v.x = 100; if (v.y > 100) v.y = 100; if (v.z > 100) v.z = 100;
        v.scale(P.mAirFric).fround();
        const step = V3.add(this.posDelta, v);
        const n = Math.trunc(step.length() / 25) + 1;
        step.scale(fr(1 / n)).fround();
        const total = new V3();
        let hits = 0, air = true;
        for (let i = 0; i < n; ++i) {
            const bs = new V3(), sn = new V3();
            hits += this.bindBody(bs, sn, step);
            air = air && this.isAirborne();
            this.pos.add(bs).fround();
            total.add(sn);
        }
        this.posDelta.zero();
        if (air) this.onLiveFlag(LF.AIRBORNE); else this.offLiveFlag(LF.AIRBORNE);
        if (this.isFlying() && hits > 0 && !isZero(total)) {
            setLength(total, 1);
            const f = this.vel.dot(total);
            if (f < 0) this.vel.set(scaleAdd(Math.abs(fr(f * 2)), this.vel, total));
            this.rot.set(0, MsWrap(MsGetRotFromZaxisY(this.vel), 0, 360), 0);
            this.world.effect('wallKick', this.pos, this.scale);
            this.stopTriggerSound();
            this.world.sound(SE.EN_WANWAN_REFLECT, this.pos);
        }
        if (this.isFlying() && !this.checkLiveFlag(LF.AIRBORNE)) {
            this.vel.scale(P.mAirFric);
            this.vel.y = fr(this.vel.y * -0.05);
            this.vel.fround();
        }
    }
    bindBody(out: V3, normals: V3, step: V3) {
        let num = 0;
        const r = fr(this.wallRadius * 0.27676865);
        out.zero(); normals.zero();
        const cur = this.pos.clone();
        let air = true;
        for (let i = 0; i < 8; ++i) {
            const off = qRotate(qEulerY(fr(i * HALF_PI)), new V3(0, 0, fr(this.wallRadius - r)));
            const point = V3.add(cur, off);
            const rec: WallCheck = { center: [0, 0, 0], radius: 0, maxResults: 4, flags: 0, results: [] };
            const bps = this.bindPoint(point, step, r, rec);
            air = air && this.isAirborne();
            cur.add(V3.sub(bps, step)).fround();
            for (const w of rec.results) normals.add(new V3(w.n[0], w.n[1], w.n[2]));
            num += rec.results.length;
        }
        out.set(V3.sub(cur, this.pos).add(step)).fround();
        if (air) this.onLiveFlag(LF.AIRBORNE); else this.offLiveFlag(LF.AIRBORNE);
        return num;
    }
    bindPoint(point: V3, step: V3, radius: number, rec: WallCheck): V3 {
        const a = V3.add(point, step);
        const w = this.world;
        const ground = (x: number, y: number, z: number) => this.checkLiveFlag(LF.UNK1000) ? w.checkGroundIgnoreWaterSurface(x, y, z) : w.checkGround(x, y, z);
        let [gh, g] = ground(a.x, a.y + this.headHeight, a.z) as [number, BGCheckData];
        gh = fr(gh + 1);
        if (point.y > a.y && !g.isIllegal() && !(g.bgType === 0x801 || g.bgType === 0x402)) {
            let [h2, g2] = ground(a.x, a.y + this.headHeight, a.z) as [number, BGCheckData];
            h2 = fr(h2 + 1);
            if (h2 > gh) { gh = h2; g = g2; }
        }
        this.groundHeight = gh;
        this.groundPlane = g;
        if (a.y <= gh + 0.05) {
            if (g.isIllegal()) { this.reset(); return step.clone(); }
            this.offLiveFlag(LF.AIRBORNE);
            if (this.isFlying() || this.isDefeat()) {
                const n = new V3(g.n[0], g.n[1], g.n[2]);
                const f = fr(1 - (n.dot(a) - n.dot(new V3(a.x, gh, a.z))));
                if (f > 0) a.set(scaleAdd(f, a, n));
            } else a.y = fr(gh + 1);
        } else this.onLiveFlag(LF.AIRBORNE);
        this.checkWalls(a, rec, radius);
        return V3.sub(a, point);
    }
    checkWalls(p: V3, out: WallCheck, radius: number): boolean {
        const r: WallCheck = { center: [p.x, p.y + radius, p.z], radius, maxResults: 4, flags: 0, results: [] };
        const hit = this.world.isTouchedWallsAndMoveXZ(r);
        out.center = r.center; out.radius = r.radius; out.results = r.results;
        if (!hit) return false;
        if (!this.isFlying()) { p.x = r.center[0]; p.z = r.center[2]; return true; }
        let b = false;
        for (const wd of r.results) b = this.behaveHitWallOnFlying(wd) || b;
        if (b) this.checkWalls(p, out, radius);
        else { p.x = r.center[0]; p.z = r.center[2]; }
        return true;
    }
    behaveHitWallOnFlying(d: BGCheckData) {
        const a = d.actor as LiveActor | null;
        if (a && a.isActorType(AT.WOOD_BOX)) { a.receiveMessage(this, MSG.HIP_DROP); return true; }
        return false;
    }
    getGravityY() { return this.isFlying() || this.isDefeat() ? this.PF.mSLFlyGravityY : this.gravity; }
    doKeepDistance() { return !this.tail!.isOnFire; }
    isCollidMove(_a: HitActor) { return true; }
}
void BCK_RETURN; void BCK_RUN_END; void PathNode; void MsSin; void MsCos;

type S = Spine<FireWanwan>;
export const FireWanwanNerves: Record<string, any> = {};
FireWanwanNerves.graphWander = nerve<FireWanwan>('TNerveFireWanwanGraphWander', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(BCK_WALK);
    if (self.isReachedToGoal()) self.goToRandomNextGraphNode();
    if (self.isFindMario(1)) { spine.pushAfterCurrent(FireWanwanNerves.findMario); return true; }
    self.doWalk();
    return false;
});
FireWanwanNerves.turn = nerve<FireWanwan>('TNerveFireWanwanTurn', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.prepareTurn(); self.setBckAnm(BCK_SEARCH); }
    if (self.checkCurAnmEnd(0)) self.setBckAnm(BCK_WALK);
    if (self.doTurn()) { spine.pushAfterCurrent(FireWanwanNerves.graphWander); self.initTurnNextGraphNode(); return true; }
    return false;
});
FireWanwanNerves.findMario = nerve<FireWanwan>('TNerveFireWanwanFindMario', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.setBckAnm(BCK_SEARCH); self.decideTarget(self.world.mario.pos); }
    self.doAdjustTarget();
    if (self.checkCurAnmEnd(0)) { spine.pushAfterCurrent(FireWanwanNerves.attack); return true; }
    return false;
});
FireWanwanNerves.attack = nerve<FireWanwan>('TNerveFireWanwanAttack', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.setBckAnm(BCK_RUN); self.setGoalPath(new PathNode(self.world.mario)); }
    if (self.doAttack()) { spine.pushAfterCurrent(FireWanwanNerves.recoverGraph); return true; }
    if (self.PF.mAttackTimerMax < spine.time) { spine.pushAfterCurrent(FireWanwanNerves.tired); return true; }
    return false;
});
FireWanwanNerves.tired = nerve<FireWanwan>('TNerveFireWanwanTired', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(BCK_RUN_END);
    if (self.checkCurAnmEnd(0)) {
        self.setBckAnm(BCK_RUN_END);
        if (self.PF.mSLAttackWait < spine.time) {
            spine.pushAfterCurrent(self.isFindMario(1) ? FireWanwanNerves.findMario : FireWanwanNerves.recoverGraph);
            return true;
        }
    }
    return false;
});
FireWanwanNerves.recoverGraph = nerve<FireWanwan>('TNerveFireWanwanRecoverGraph', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.setBckAnm(BCK_SEARCH);
        self.tracer.prev = -1; self.tracer.cur = -1;
        self.goToShortestNextGraphNode();
        self.decideTarget(self.goal104.point());
    }
    if (self.mactor!.checkCurBckFromIndex(BCK_WALK)) self.doAdjustTarget();
    else if (self.checkCurAnmEnd(0)) self.setBckAnm(BCK_WALK);
    if (self.checkCurAnmEnd(0)) { spine.pushAfterCurrent(FireWanwanNerves.graphWander); return true; }
    return false;
});
FireWanwanNerves.recover = nerve<FireWanwan>('TNerveFireWanwanRecover', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.setBckAnm(BCK_RETURN);
        self.mactor!.setFrameRate(0, ANM_BTK);
        const b = self.mactor!.getFrameCtrl(ANM_BTK); if (b) b.frame = 0;
        (self.manager as FireWanwanManager).receiveMessageFromBody(self, 0);
        self.world.sound(SE.EN_WANWAN_RECOVER, self.pos);
        self.changeBodyToRed(self.mactor!.getFrameCtrl(ANM_BCK)!.end);
    }
    if (self.checkCurAnmEnd(0)) { self.recoverFire(); spine.pushAfterCurrent(spine.default); return true; }
    return false;
});
FireWanwanNerves.die = nerve<FireWanwan>('TNerveFireWanwanDie', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.setBckAnm(BCK_DAMAGE);
        self.tail!.isOnFire = false;
        self.rot.x = 90;
        const m = self.manager as FireWanwanManager;
        m.mLastKillerWanwan = self;
        m.mWanwanRecoversBeforeHelpBalloon = -1;
        if (++m.mWanwansKilled === m.getActiveObjNum()) m.balloon(0xE0019, self.pos);
        self.stopTriggerSound();
        self.world.sound(SE.EN_WANWAN_DOWN, self.pos);
        self.changeBodyToSilver(40);
        self.generateEffectColumWater();
        self.onLiveFlag(LF.UNK1000);
        self.offLiveFlag(LF.AIRBORNE);
        self.hitPoints = 0;
        self.damageHeight = fr(self.damageHeight - 250);
        self.calcEntryRadius();
    }
    self.vel.x = fr(self.vel.x * 0.9); self.vel.z = fr(self.vel.z * 0.9);
    self.world.sound(SE.EN_WANWAN_AFTER, self.pos);
    return false;
});
FireWanwanNerves.hungTail = nerve<FireWanwan>('TNerveFireWanwanHungTail', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.setBckAnm(BCK_DAMAGE); self.mactor!.setFromIndex(ANM_BTK, 0); self.mactor!.setFrameRate(ANM_FRAME_RATE, ANM_BTK); }
    self.rot.y = MsGetRotFromZaxisY(V3.sub(self.pos, self.world.mario.pos));
    if (self.isReadyToFly()) { spine.pushAfterCurrent(FireWanwanNerves.fly); return true; }
    return false;
});
FireWanwanNerves.fly = nerve<FireWanwan>('TNerveFireWanwanFly', (spine: S) => {
    const self = spine.body, P = self.PF;
    if (spine.time === 0) {
        self.setBckAnm(BCK_DAMAGE); self.mactor!.setFromIndex(ANM_BTK, 0); self.mactor!.setFrameRate(ANM_FRAME_RATE, ANM_BTK);
        const r = self.tail!.throwPow;
        self.vel.set(fr(r * MsSin(self.rot.y)), 0, fr(r * MsCos(self.rot.y)));
        const k = P.mFreezeTimeThreshold;
        self.mFreezeWait = k * k < self.vel.squared() ? P.mSLFreezeWait : P.mSLFreezeWaitShort;
    }
    self.vel.scale(P.mAirFric).fround();
    const v = self.vel.clone(); v.y = 0;
    if (v.squared() < 1) { spine.pushAfterCurrent(FireWanwanNerves.freeze); return true; }
    return false;
});
FireWanwanNerves.freeze = nerve<FireWanwan>('TNerveFireWanwanFreeze', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.setBckAnm(BCK_DAMAGE); self.mactor!.setFromIndex(ANM_BTK, 0); self.mactor!.setFrameRate(ANM_FRAME_RATE, ANM_BTK);
        self.world.sound(SE.EN_COMMON_TWINKLE, self.pos);
    }
    self.vel.zero();
    if (self.getFreezeTime() < spine.time) { spine.pushAfterCurrent(FireWanwanNerves.recover); return true; }
    return false;
});
FireWanwanNerves.escape = nerve<FireWanwan>('TNerveFireWanwanEscape', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.initEscapeNextGraphNode();
        self.setBckAnm(BCK_DAMAGE); self.mactor!.setFromIndex(ANM_BTK, 0); self.mactor!.setFrameRate(ANM_FRAME_RATE, ANM_BTK);
        self.changeBodyToBlack(40);
    }
    if (self.PF.mEscapeRecoverTime < spine.time) { spine.pushAfterCurrent(FireWanwanNerves.recover); return true; }
    if (self.isReachedToGoal()) self.goToRandomEscapeGraphNode();
    self.doEscape();
    self.world.sound(SE.EN_WANWAN_BARK2, self.pos);
    return false;
});

register('FireWanwanManager', (w, n) => new FireWanwanManager(w, n));
register('FireWanwan', (w, n) => new FireWanwan(w, n));
