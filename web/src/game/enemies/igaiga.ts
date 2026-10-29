// Rolling enemies (Enemy/igaiga.cpp): TRollEnemy, a walker that rolls along its graph, bounces
// off the ground it falls onto and swells from FLUDD's water; TIgaiga (the spiky chestnut,
// graph "igaiga"); TGorogoro (Bianco Hills' rolling goop-covered Petey heads, ゴロゴロ: graphs
// gorogoro0 / gorogoro1, brought back while Mario is in ゴロゴロ発生マネージャー's cylinders, or
// spat out by the gatekeeper). Both leave goop marks where they land (TEnemyPolluteModel).
// Not modelled: the body's roll (RollEnemyBodyCallback: a visual joint turn), the mirror copy,
// the watermills a Gorogoro turns (BiaWatermill isn't simulated; its collision has no actor).

import { fr, V3, MsWrap, MsClamp, MsSin, MsRandF, MsGetRotFromZaxisY, MsIsInSight, MsMtxSetXYZRPH, MsMtxSetRotRPH, mtx, mtxMultVec, jgInvSqrt } from '../math.js';
import { World, LF, HC, MSG, nerve, Spine, Stream, ANM_BCK, HitActor, MActor, LiveActor, PathNode, CUE_CALC_ANIM, CUE_MOVE, SpineEnemy } from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemy, SmallEnemyManager, SmallEnemyNerves, LIVE_FLAG_MELT_ON_DEATH, rangeRand } from './smallEnemy.js';
import { WalkerEnemy, walkerParams } from './walker.js';
import { emitInfo, EmitInfo } from '../water.js';
import { register } from '../scene.js';
import type { AreaCylinderManager } from './bosspakkun.js';
import { SE } from '../soundids.js';
import { holdKey } from '../sound.js';

/** TRollEnemySaveLoadParams */
const ROLL_PARAMS = { mSLGenerateInterval: ['i', 300], mSLExpandRate: ['f', 1], mSLExpandMax: ['f', 1.5], mSLBoundVYMax: ['f', 15], mSLGroundOffsetY: ['f', 150] } as const;
const rollParams = (path: string, w: World) => walkerParams(path, w.files, ROLL_PARAMS as any);
/** TMsRange<s32>::rand */
const rangeRandI = (lo: number, hi: number) => lo + Math.trunc(fr((hi - lo) * MsRandF()));

// ---------------------------------------------------------------- the goop marks
/** gpPollution->stampModel: the model, posed at its frame, drawn into the goop from above. */
export function stampModel(w: World, a: MActor, baseTR: Float64Array, s: V3) {
    if (w.pollution) w.pollution.stampModel(a, baseTR, s);
}

/** TEnemyPolluteModel: a mark's model, playing its BCK while it goops the ground under it. */
class PolluteModel {
    mactor: MActor; pos = new V3(); scale = new V3(1, 1, 1);
    /** unk14: its base TR matrix (the translation to where it was made) */
    baseTR = mtx();
    /** unk5C: out of view (not drawn into the goop); unk5D: active */
    unk5C = 1; unk5D = 0;
    constructor(public w: World, public file: string, owner: LiveActor, public bck: number) {
        this.mactor = new MActor(file, owner.manager!.getMActorAnmData());
    }
    generate(p: V3, s: V3) {
        const [, d] = this.w.checkGround(p.x, p.y, p.z);
        if (d.isIllegal() || d.isWaterSurface()) return;
        this.pos.set(p); this.scale.set(s);
        this.baseTR = mtx(); this.baseTR[3] = p.x; this.baseTR[7] = p.y; this.baseTR[11] = p.z;
        this.unk5D = 1; this.unk5C = 0;
        this.mactor.setBckFromIndex(this.bck);
        this.mactor.getFrameCtrl(ANM_BCK)!.frame = 0;
    }
    perform(cue: number) {
        if (!this.unk5D || this.unk5C) return;
        if (cue & CUE_CALC_ANIM) {
            if (this.mactor.curAnmEndsNext(ANM_BCK)) { this.unk5D = 0; return; }
            this.mactor.frameUpdate();
            // CUE_ENTRY: gpPollution->stampModel
            stampModel(this.w, this.mactor, this.baseTR, this.scale);
        }
    }
}
/** TEnemyPolluteModelManager: 5 marks, used in turn. */
export class PolluteModelManager {
    models: PolluteModel[] = []; unk10 = 0;
    constructor(public w: World, file: string, owner: LiveActor, bck: number) { for (let i = 0; i < 5; i++) this.models.push(new PolluteModel(w, file, owner, bck)); }
    perform(cue: number) {
        if (cue & CUE_CALC_ANIM) {
            for (const m of this.models) if (m.unk5D) m.unk5C = this.w.inView(m.pos, 100, 5000) ? 0 : 1;
        }
        for (const m of this.models) m.perform(cue);
    }
    generatePolluteModel(p: V3, s: V3) {
        this.models[this.unk10].generate(p, s);
        if (++this.unk10 >= this.models.length) this.unk10 = 0;
    }
}

// ---------------------------------------------------------------- TRollEnemy
export class RollEnemy extends WalkerEnemy {
    static mBoundVal = 80; static mTransYOffset = 0;
    unk194 = 0; unk198 = 0; unk19C = 0; unk1A0 = 0; unk1A4: any = null; unk1A8 = 0; unk1AC = 0; unk1B0 = 1;
    get PR(): any { return this.unk1A4 || this.getSaveParam(); }
    reset() {
        super.reset();
        this.unk194 = rangeRand(0, 360);
        this.unk158 = 1;
        const g = this.tracer.graph!;
        this.pos.set(g.point(0));
        this.pos.y = fr(this.pos.y + 10);
        const dir = V3.sub(g.point(1), this.pos);
        this.rot.y = MsWrap(MsGetRotFromZaxisY(dir), 0, 360);
        this.unk198 = fr(1.5 * this.marchSpeed);
        this.unk19C = this.marchSpeed;
        this.unk1A0 = 0;
        this.tracer.cur = 0;
    }
    walkBehavior(kind: number, k: number) {
        if (!this.unk1A8) super.walkBehavior(kind, k);
        if (this.isAirborne() && this.pos.y > this.groundHeight + 20) {
            const b = MsWrap(fr((this.pos.y - this.groundHeight) / RollEnemy.mBoundVal), 0, this.PR.mSLBoundVYMax);
            if (this.unk1A0 < b) this.unk1A0 = b;
        } else if (!this.groundPlane.isWaterSurface()) {
            this.unk1A8 = 0;
            if (this.unk1A0 > this.unk1B0) {
                this.bound();
                this.vel.set(0, this.unk1A0, 0);
                this.onLiveFlag(LF.AIRBORNE);
                this.pos.y = fr(this.pos.y + 5);
                this.unk1A0 = 0;
                this.boundSE();
            }
        }
        if (this.pos.y < this.groundHeight + 30) this.rollSE();
        if (this.unk128 > 300) { this.onLiveFlag(LF.UNK10000); this.kill(); }
    }
    behaveToWater(_a: HitActor) {
        this.sprayCooldown = 0;
        const P = this.PR;
        if (this.unk158 < P.mSLExpandMax) {
            const rate = P.mSLExpandRate;
            this.bodyScale = fr(this.bodyScale * rate);
            this.unk158 = fr(this.unk158 * rate);
            this.scaledBodyRadius = fr(this.scaledBodyRadius * rate);
            const z = fr(this.scale.z * rate);
            this.scale.set(z, z, z);
            const s = fr(this.bodyScale / this.unk154);
            this.setHitParams(P.mSLAttackRadius * s, P.mSLAttackHeight * s, P.mSLDamageRadius * s, P.mSLDamageHeight * s);
        }
    }
    attackToMario() { this.world.mario.receiveMessage(this, MSG.ATTACK); }
    flagJump() {
        const p = this.tracer.current();
        this.pos.y = fr(this.pos.y + 30);
        const v = this.calcVelocityToJumpToY(p, this.tracer.unkC, this.getGravityY());
        this.unk1A8 = 1;
        this.vel.set(v);
        this.onLiveFlag(LF.AIRBORNE);
    }
    isCollidMove(a: HitActor) {
        if (a.isActorType(AT.STOP_ROCK)) { this.kill(); return true; }
        a.receiveMessage(this, MSG.ATTACK);
        return false;
    }
    isReachedToGoalXZ() {
        const t = V3.sub(this.goal104.point(), this.pos);
        if (!this.unk1A8) t.y = 0;
        return t.squared() < 200;
    }
    setBehavior() {
        if (this.pos.y > this.groundHeight + 50) return;
        const P = this.P, sp = this.spine!;
        if (sp.time % P.mSLPolluteInterval !== 0) return;
        if (this.checkLiveFlag(LF.DEAD)) return;
        if (sp.current === SmallEnemyNerves.die) return;
        // (TSmallEnemy::mIsPolluter / mIsAmpPolluter: both true)
        let range = 2;
        if (!this.checkLiveFlag(LF.HIDDEN)) {
            const mn = P.mSLPolluteRMin, mx = P.mSLPolluteRMax, cyc = P.mSLPolluteCycle;
            const ang = fr(180 * fr(sp.time % cyc) / cyc);
            range = fr(mn + fr(this.bodyScale * fr((mx - mn) * MsSin(ang))));
        }
        if (this.world.pollution) this.world.pollution.stampGround(1, fr(this.pos.x + this.unk1AC * this.posDelta.x), this.pos.y, fr(this.pos.z + this.unk1AC * this.posDelta.z), 32 * range);
    }
    setAfterDeadEffect() { }
    bound() { }
    isRolling() { return false; }
    rollSE() { }
    boundSE() { }
}

// ---------------------------------------------------------------- TIgaiga
export class IgaigaManager extends SmallEnemyManager {
    unk60: PolluteModelManager | null = null; unk68: EmitInfo | null = null;
    constructor(w: World, name = 'イガイガマネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.saveParams = rollParams('/enemy/igaiga.prm', this.world);
        this.unk68 = emitInfo('/enemy/igaigawater.prm', this.world.files);
    }
    createModelData() { this.createModelDataArray(['igaiga_model1.bmd']); }
    createEnemyInstance() { return new Igaiga(this.world); }
    initSetEnemies() { if (this.objs[0]) this.unk60 = new PolluteModelManager(this.world, (this.folder() + '/stamp_igaiga_model1.bmd').toLowerCase(), this.objs[0] as LiveActor, 7); }
    perform(cue: number) { super.perform(cue); if (this.unk60) this.unk60.perform(cue); }
    requestPolluteModel(p: V3, s: V3) { if (this.unk60) this.unk60.generatePolluteModel(p, s); }
}

export class Igaiga extends RollEnemy {
    static mReachNodeDist = 300;
    unk1B4 = 0; unk1B8 = 0; unk1BC = 1; unk1C0 = new V3(); unk1CC = 1; unk1D8 = new V3(); unk1E4 = 1; unk1E8 = 0;
    constructor(w: World, name = 'イガイガ') { super(w, name); }
    init(m: any) {
        super.init(m);
        this.actorType = AT.IGAIGA;
        this.unk150 = 0x11;
        this.offHitFilter(HC.BOSS | HC.ENEMY);
        this.onHitFilter(HC.MAP_OBJECT);
        this.spine!.initWith(IgaigaNerves.rollOnGraph);
        this.unk1A4 = this.getSaveParam();
        if (this.mactor) this.mactor.setFromIndex(3 /* ANM_BTK */, 0);
        this.tracer.init(this.world.graphByName('igaiga'));
    }
    setMActorAndKeeper() { this.mactor = this.createMActorByName('igaiga_model1.bmd'); }
    isRolling() { const c = this.spine!.current; return c === IgaigaNerves.rollOnGraph || c === IgaigaNerves.shootFromCannon || c === IgaigaNerves.waterHit; }
    behaveToWater(_a: HitActor) {
        this.sprayCooldown = 0;
        const P = this.PR;
        if (this.unk1E4 < P.mSLExpandMax) this.unk1E4 = fr(this.unk1E4 * P.mSLExpandRate);
        this.unk165 = true;
        if (this.spine!.current !== IgaigaNerves.waterHit) this.spine!.pushNerve(IgaigaNerves.waterHit);
    }
    reset() {
        super.reset();
        this.initialGraphNode();
        this.offLiveFlag(LF.UNK10);
        this.unk1B4 = 0;
        this.unk1B8 = rangeRandI(50, 100) * 120;
        this.unk1BC = 1;
        this.pos.y = fr(this.pos.y + 20);
        const [, d] = this.world.checkGround(this.pos.x, this.pos.y + this.headHeight, this.pos.z);
        this.groundPlane = d;
        this.onLiveFlag(LF.AIRBORNE);
        this.unk1E4 = 1; this.unk1CC = 1; this.unk1AC = -30; this.unk1B0 = 2; this.unk1E8 = 0;
    }
    kill() { this.unk194 = 0; SmallEnemy.prototype.kill.call(this); }
    moveObject() {
        super.moveObject();
        this.unk1CC = MsClamp(fr(this.unk1CC - 0.0002), 0.5, 1);
        const P = this.PR;
        const base = fr(this.unk154 * this.unk1CC);
        this.bodyScale = MsClamp(fr(this.unk1E4 * base), base, fr(3 * this.bodyScale));
        const s = fr(this.bodyScale / this.unk154);
        this.scaledBodyRadius = fr(8 * this.getBodyRadius() * MsClamp(fr(this.unk1CC * this.unk1E4), 1, 1.2));
        this.scale.set(this.bodyScale, this.bodyScale, this.bodyScale);
        this.setHitParams(P.mSLAttackRadius * s, P.mSLAttackHeight * s, P.mSLDamageRadius * s, P.mSLDamageHeight * s);
        this.marchSpeed = P.mSLMarchSpeedLow;
        this.turnSpeed = P.mSLTurnSpeedLow;
        const t = this.tracer;
        if (t.graph && t.cur >= 0 && t.graph.checkFlag(t.cur, 0x40)) {
            if (this.pos.y < t.current().y + 50) { this.kill(); this.unk1BC = 1; }
        }
    }
    walkBehavior(kind: number, k: number) {
        super.walkBehavior(kind, k);
        let x = this.posDelta.x, z = this.posDelta.z;
        if (this.unk1A8) { x = this.vel.x; z = this.vel.z; }
        // TVec2<f32>::length(): TUtil<f32>::sqrt(squared()) -- x * inv_sqrt(x) (frsqrte + one
        // Newton step), not Math.hypot's full-precision sqrt.
        const sq = fr(fr(x * x) + fr(z * z));
        const speed = sq > 0 ? fr(sq * jgInvSqrt(sq)) : sq;
        this.unk194 = fr(this.unk194 + 4 * fr(speed / fr(this.bodyRadius * this.unk1CC * this.unk1E4)));
        if (this.unk1B4) { ++this.unk1B4; if (this.unk1B4 > this.unk1B8) this.unk1B4 = 0; }
        if (!this.isAirborne() && this.groundPlane && this.groundPlane.actor) (this.groundPlane.actor as HitActor).receiveMessage(this, MSG.ATTACK);
        if (this.unk138 && this.unk138.actor) (this.unk138.actor as HitActor).receiveMessage(this, MSG.ATTACK);
    }
    isReachedToGoalXZ() {
        const t = V3.sub(this.goal104.point(), this.pos);
        t.y = 0;
        return t.squared() < Igaiga.mReachNodeDist;
    }
    setWalkAnm() { this.setBckAnm(3); }
    private jointPos() {
        if (this.checkLiveFlag(LF.CLIPPED_OUT)) this.unk1C0.set(this.pos);
        else { const m = this.mactor!.anmMtx(0, this.baseTR, this.scale); if (m) this.unk1C0.set(m[12], m[13], m[14]); else this.unk1C0.set(this.pos); }
    }
    setDeadAnm() {
        this.jointPos();
        this.world.effect('igaFumiAir', this.unk1C0);
        this.setBckAnm(this.unk1BC ? 0 : 1);
        const sc = this.scale.clone().scale(fr(this.unk1CC * this.unk1E4));
        this.pos.y = this.groundHeight;
        const x = MsClamp(sc.x, 0.8, 1.5);
        (this.manager as IgaigaManager).requestPolluteModel(this.pos, new V3(x, x, x));
    }
    setMeltAnm() {
        this.jointPos();
        this.waterExplosion();
        this.world.effect('popoBomb', this.unk1C0, this.scale.clone().scale(0.5));
        this.setBckAnm(5);
        if (rangeRand(0, 1) < 0.2) this.world.effect('itemBottleLarge', new V3(this.pos.x, this.pos.y + 20, this.pos.z));
    }
    isHitValid(m: number) { this.unk1BC = m === MSG.HIP_DROP ? 0 : 1; return true; }
    rollMove() {
        if (this.checkCurAnmEnd(ANM_BCK) && this.isBckAnm(2)) this.setBckAnm(3);
        if (this.isReachedToGoalXZ()) {
            if (this.jumpToNextGraphNode() >= 0) this.flagJump();
            const t = this.tracer;
            if (t.cur >= 0 && t.graph!.checkFlag(t.cur, 0x40)) return;
            this.goToRandomNextGraphNode();
        }
        this.walkBehavior(2, 1);
    }
    bound() { if (this.unk1A0 > 5) this.setBckAnm(2); }
    /** (startSoundActorSpecial: its pitch / volume by its scale and march speed: not here) */
    rollSE() { this.world.sound(SE.EN_IGAIGA_ROLL, this.pos, { hold: holdKey(this, 'roll') }); }
    boundSE() { this.world.sound(SE.EN_IGAIGA_BOUND, this.pos); }
    waterExplosion() {
        const m = this.manager as IgaigaManager;
        if (!m.unk68 || !this.world.water) return;
        m.unk68.pos = [this.pos.x, this.pos.y, this.pos.z];
        this.world.water.emitRequest(m.unk68);
    }
    shoot(v: V3) { this.spine!.setNext(IgaigaNerves.shootFromCannon); this.unk1D8.set(v); this.offLiveFlag(LF.UNK10); this.unk1A8 = 1; }
}

type SI = Spine<Igaiga>;
export const IgaigaNerves: Record<string, any> = {};
IgaigaNerves.rollOnGraph = nerve<Igaiga>('TNerveIgaigaRollOnGraph', (spine: SI) => {
    const self = spine.body;
    if (spine.time === 0) self.setWalkAnm();
    self.rollMove();
    return false;
});
IgaigaNerves.waterHit = nerve<Igaiga>('TNerveIgaigaWaterHit', (spine: SI) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(6);
    if (self.unk1E4 >= self.PR.mSLExpandMax) {
        if (self.unk1E8 > 20) { self.onLiveFlag(LF.UNK10000); spine.pushAfterCurrent(SmallEnemyNerves.die); return true; }
        ++self.unk1E8;
    } else if (self.checkCurAnmEnd(ANM_BCK) && !self.unsetUnk165()) {
        self.setBckAnm(3);
        spine.pushAfterCurrent(IgaigaNerves.rollOnGraph);
        return true;
    }
    self.rollMove();
    return false;
});
IgaigaNerves.shootFromCannon = nerve<Igaiga>('TNerveIgaigaShootFromCannon', (spine: SI) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.setBckAnm(4);
        self.pos.y = fr(self.pos.y + 10);
        self.vel.set(self.unk1D8);
        self.onLiveFlag(LF.AIRBORNE);
    } else if (self.checkCurAnmEnd(ANM_BCK) && !self.isAirborne()) {
        self.bound();
        spine.pushAfterCurrent(IgaigaNerves.rollOnGraph);
        return true;
    }
    self.walkBehavior(2, 1);
    return false;
});

// ---------------------------------------------------------------- TGorogoro
/** TMapEventSink (イベント（地形沈むビアンコ）)'s buildings, as far as the enemies ask (isBuried). */
export interface SinkEvent { isBuried(i: number): boolean; }

export class GorogoroManager extends SmallEnemyManager {
    unk60 = 0; unk64: SinkEvent | null = null; unk68 = 1; unk6C: PolluteModelManager | null = null; unk70: AreaCylinderManager | null = null;
    constructor(w: World, name = 'ゴロゴロマネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.saveParams = rollParams('/enemy/gorogoro.prm', this.world);
        this.createSharedMActorSet(['bosspaku_head_move']);
    }
    loadAfter() {
        super.loadAfter();
        this.unk64 = this.world.search('イベント（地形沈むビアンコ）') as any as SinkEvent | null;
        this.unk70 = this.world.search('ゴロゴロ発生マネージャー') as any as AreaCylinderManager | null;
    }
    createModelData() { this.createModelDataArray(['bosspaku_head.bmd']); }
    createEnemyInstance() { return new Gorogoro(this.world); }
    initSetEnemies() {
        if (!this.objs[0]) return;
        this.unk6C = new PolluteModelManager(this.world, (this.folder() + '/bosspaku_head_stamp.bmd').toLowerCase(), this.objs[0] as LiveActor, 3);
        const names = ['gorogoro0', 'gorogoro1'];
        for (let i = 0; i < this.objs.length; i++) {
            let g = this.world.graphByName(names[i % 2]);
            if (g.isDummy()) g = this.world.graphByName(names[0]);
            if (!g.isDummy()) {
                const e = this.objs[i] as Gorogoro;
                e.tracer.init(g);
                e.pos.set(g.point(0));
                e.unk1E8 = g.count - 1;
            }
        }
    }
    inArea(p: V3) { return this.unk70 ? this.unk70.contain(p) : true; }
    perform(cue: number) {
        if (cue & CUE_MOVE) {
            ++this.unk60;
            const interval = this.saveParams.mSLGenerateInterval;
            if (this.unk60 > interval) {
                this.unk60 = 0;
                if (this.inArea(this.world.mario.pos)) {
                    for (let i = 0; i < this.getActiveObjNum(); ++i) {
                        const g = this.objs[i] as Gorogoro;
                        if (!g.checkLiveFlag(LF.DEAD)) continue;
                        if (this.unk64) {
                            if (!this.unk64.isBuried(1)) {
                                if (this.unk68) {
                                    this.unk68 = 0;
                                    g.reset(); g.setGenerateGraphIdx(10);
                                    const o = this.objs[1] as Gorogoro;
                                    o.reset(); o.setGenerateGraphIdx(16);
                                } else g.reset();
                            } else this.unk60 = interval;
                        } else g.reset();
                        break;
                    }
                }
            }
        }
        super.perform(cue);
        if (this.unk6C) this.unk6C.perform(cue);
    }
    requestPolluteModel(p: V3, s: V3) { if (this.unk6C) this.unk6C.generatePolluteModel(p, s); }
}

export class Gorogoro extends RollEnemy {
    unk1E4 = 0; unk1E8 = 0; unk1EC = 0;
    /** mTevKColor.a: its goop fades as it's washed */
    tevAlpha = 0xFF;
    constructor(w: World, name = 'ゴロゴロ') { super(w, name); }
    init(m: any) {
        super.init(m);
        this.actorType = AT.GOROGORO;
        this.unk150 = 0x31;
        this.offHitFilter(HC.BOSS | HC.ENEMY | HC.MAP_OBJECT);
        this.spine!.initWith(GorogoroNerves.rollOnGraph);
        this.unk1A4 = this.getSaveParam();
        this.tevAlpha = 0xFF;
        this.unk130 = 1;
    }
    setMActorAndKeeper() { this.mactor = this.createMActorByName('bosspaku_head.bmd'); }
    calcRootMatrix() {
        if (this.spine!.current === GorogoroNerves.die) { SpineEnemy.prototype.calcRootMatrix.call(this); return; }
        if (this.isEaten()) return;
        // (on the ground: its mud trail, PARTICLE_MS_PKH_DORO, bound to it)
        MsMtxSetXYZRPH(this.baseTR, this.pos.x, fr(this.pos.y + this.PR.mSLGroundOffsetY * this.unk158), this.pos.z, this.rot.x, this.rot.y, this.rot.z);
    }
    reset() {
        this.unk130 = 1;
        super.reset();
        this.offLiveFlag(LF.UNK1000);
        this.tevAlpha = 0xFF;
        this.unk1AC = -10; this.unk1B0 = 1;
    }
    kill() {
        this.unk194 = 0;
        const s = this.spine!, c = s.current;
        if (c === SmallEnemyNerves.die || c === GorogoroNerves.die) return;
        s.reset(); s.setNext(GorogoroNerves.die); s.pushAfterCurrent(s.default);
        this.onLiveFlag(LF.UNK8);
    }
    forceKill() {
        const g = this.groundPlane;
        if (g.isIllegal()) return;
        if (!g.isPool() && !g.isWaterSurface()) return;
        if (this.isAirborne()) return;
        const s = this.spine!;
        if (s.current === GorogoroNerves.die) return;
        s.reset(); s.setNext(GorogoroNerves.die); s.pushAfterCurrent(s.default);
        this.onLiveFlag(LF.UNK20000); this.onLiveFlag(LIVE_FLAG_MELT_ON_DEATH);
    }
    behaveToWater(a: HitActor) {
        super.behaveToWater(a);
        const max = this.maxHitPoints() & 0xFF;
        this.tevAlpha = Math.trunc((this.hitPoints * 255) / max) & 0xFF;
        if (this.hitPoints < 2) this.hitPoints = 1;
    }
    walkBehavior(kind: number, k: number) {
        if (this.pos.y > this.groundHeight) this.onLiveFlag(LF.AIRBORNE);
        if (!this.checkLiveFlag(LF.CLIPPED_OUT)) {
            const isMill = (a: any) => !!a && a.actorType === AT.BIA_WATERMILL01;
            // (the watermill turns: TBiancoWatermill::turnByEnemy — not simulated)
            if (this.groundPlane && isMill(this.groundPlane.actor)) { super.walkBehavior(kind, fr(0.2 * k)); return; }
            const [, roof] = this.world.checkRoof(this.pos.x, this.pos.y + this.headHeight, this.pos.z);
            if (roof && isMill(roof.actor)) { super.walkBehavior(kind, fr(0.3 * k)); return; }
            if (this.unk138 && this.unk138.actor) {
                const r = { center: [this.pos.x, this.pos.y + this.headHeight, this.pos.z] as [number, number, number], radius: this.wallRadius, maxResults: 4, flags: 0, results: [] as any[] };
                if (this.world.isTouchedWallsAndMoveXZ(r)) { super.walkBehavior(kind, fr(0.2 * k)); return; }
            }
        }
        this.turnSpeed = this.PR.mSLTurnSpeedLow;
        super.walkBehavior(kind, k);
        this.unk194 = fr(this.unk194 + 0.4 * this.marchSpeed);
        if (this.spine!.current !== GorogoroNerves.die && this.pos.y < this.groundHeight + 10 && this.groundPlane.isWaterSurface()) {
            this.onLiveFlag(LF.UNK10000); this.onLiveFlag(LF.UNK20000);
            this.kill();
        }
    }
    setDeadAnm() { this.world.effect('pkhFumi', this.pos, this.scale); this.setBckAnm(0); this.world.sound(SE.BS_KRPAKU_DOWN, this.pos); }
    setMeltAnm() {
        this.setBckAnm(1);
        this.unk130 = 0;
        this.onLiveFlag(LF.UNK1000);
        this.world.effect('pkhToke', new V3(this.pos.x, this.groundHeight, this.pos.z), this.scale);
        this.world.sound(SE.BS_KRPAKU_SINK, this.pos);
    }
    bound() { (this.manager as GorogoroManager).requestPolluteModel(this.pos, this.scale); }
    rollSE() { this.world.sound(SE.BS_KRPAKU_ROLL, this.pos, { hold: holdKey(this, 'roll') }); }
    boundSE() { this.world.sound(SE.BS_KRPAKU_GND, this.pos); }
    isRolling() { return this.spine!.current === GorogoroNerves.rollOnGraph || this.isBckAnm(1); }
    setGenerateGraphIdx(i: number) {
        const g = this.tracer.graph!;
        this.pos.set(g.point(i));
        this.tracer.cur = i; this.tracer.prev = i - 1;
        const p = g.point(i + 1);
        this.rot.y = MsWrap(MsGetRotFromZaxisY(V3.sub(p, this.pos)), 0, 360);
        this.setGoalPath(new PathNode(null, p));
    }
    generateByGateKeeper(p: V3, r: V3) {
        this.reset();
        const g = this.tracer.graph!;
        const idx = g.findNearestNodeIndex(p, -1);
        this.tracer.cur = idx; this.tracer.prev = idx - 1;
        const m = this.world.mario.pos;
        let toMario: boolean, dir: V3;
        if (MsIsInSight(p, r.y, m, 2000, 360, -1)) { toMario = true; dir = m.clone(); }
        else { dir = g.point(idx); toMario = false; }
        dir.sub(p);
        this.pos.set(p);
        if (dir.x !== 0 || dir.y !== 0 || dir.z !== 0) {
            dir.normalize();
            const rm = mtx();
            MsMtxSetRotRPH(rm, 0, fr(fr(MsRandF() * 30) - 15), 0);
            mtxMultVec(rm, dir, dir);
            this.rot.y = MsWrap(MsGetRotFromZaxisY(dir), 0, 360);
            dir.scale(fr(1500 * MsRandF())).add(p);
            this.vel.set(this.calcVelocityToJumpToY(dir, 15, this.getGravityY()));
        } else {
            this.vel.set(this.calcVelocityToJumpToY(p, 15, this.getGravityY()));
            this.rot.y = MsWrap(MsGetRotFromZaxisY(dir), 0, 360);
        }
        if (toMario) { this.pushGoal(this.goal); this.goal = new PathNode(null, m.clone()); }
        this.unk1A8 = 1;
    }
}

type SG = Spine<Gorogoro>;
export const GorogoroNerves: Record<string, any> = {};
GorogoroNerves.rollOnGraph = nerve<Gorogoro>('TNerveGorogoroRollOnGraph', (spine: SG) => {
    const self = spine.body;
    if (spine.time === 0) { self.goToShortestNextGraphNode(); self.setBckAnm(2); }
    if (self.isReachedToGoalXZ()) {
        if (self.jumpToNextGraphNode() >= 0) self.flagJump();
        else self.goToShortestNextGraphNode();
    }
    self.walkBehavior(2, 1);
    return false;
});
GorogoroNerves.die = nerve<Gorogoro>('TNerveGorogoroDie', (spine: SG) => {
    const self = spine.body;
    if (spine.time < 2) {
        self.onHitFilter(0x1);
        if (self.groundPlane.isWaterSurface() && !self.isAirborne()) self.generateEffectColumWater();
        if (self.checkLiveFlag(LIVE_FLAG_MELT_ON_DEATH)) self.setMeltAnm();
        else {
            (self.manager as GorogoroManager).requestPolluteModel(self.pos, self.scale);
            self.setDeadAnm();
            self.setDeadEffect();
        }
    } else if (self.checkCurAnmEnd(ANM_BCK) || spine.time > 360) {
        self.onHitFilter(0x1);
        self.onLiveFlag(LF.DEAD); self.onLiveFlag(LF.UNK8); self.offLiveFlag(LF.HIDDEN); self.offLiveFlag(LIVE_FLAG_MELT_ON_DEATH);
        self.holder = null;
        spine.reset();
        spine.setNext(SmallEnemyNerves.die);
        spine.pushAfterCurrent(spine.default);
        self.genRandomItem();
        return true;
    }
    if (self.checkLiveFlag(LIVE_FLAG_MELT_ON_DEATH)) self.walkBehavior(2, 0.5);
    return false;
});

register('IgaigaManager', (w, n) => new IgaigaManager(w, n));
register('GorogoroManager', (w, n) => new GorogoroManager(w, n));
