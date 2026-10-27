// Piranha Plants (Enemy/pakkun.cpp): TPakkun grows from a seed it spits and shoots goop seeds at
// Mario; TStayPakkun (Bianco Hills' 固定パックン) stays in its goop puddle, hides when the goop
// under it is cleaned or it's stomped, comes up again when Mario is near and the goop's there,
// and dies swelling up from the water sprayed in its mouth (hit points: 255, -4 a hit above
// its head). TPakkunSeed is the seed / goop ball (TEnemyAttachment).

import { fr, V3, MsWrap, MsClamp, MsSin, MsCos, MsRandF, JMASSin, JMASCos, MsMtxSetRotRPH, mtx, mtxMultVec, MsGetRotFromZaxis } from '../math.js';
import {
    World, SpineEnemy, PathNode, LF, HF, HC, MSG, nerve, Spine, Stream, ANM_BCK, HitActor, LiveActor, IDX, CUE_MOVE, CUE_CALC_ANIM,
} from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemy, SmallEnemyManager, smallParams, SmallEnemyNerves, SmallParams } from './smallEnemy.js';
import { emitInfo, EmitInfo } from '../water.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import { holdKey } from '../sound.js';
import type { BGCheckData, WallCheck } from '../collision.js';

const SEED_HIDE = 0, SEED_APPEAR = 1, SEED_SET = 2, SEED_SHOOT = 3, SEED_CIRCLE = 4;
export const PAKKUN_ANM = { CRUSH_TO_HIDE: 0, DAMAGE: 1, DOWN: 2, HIDE: 3, HIT: 4, HIT_END: 5, HIT_START: 6, SET: 7, SHOOT: 8, WAIT: 9 };

const PAKKUN_PARAMS = {
    mSLReadyTime: ['i', 100], mSLShootRange: ['f', 1000], mSLSeedGravityS: ['f', 0.01], mSLSeedSpeedS: ['f', 5], mSLSeedGravityC: ['f', 0.01],
    mSLSeedSpeedC: ['f', 10], mSLMarioCircle: ['f', 400], mSLLimitMove: ['f', 1000], mSLMoveDist: ['f', 1200], mSLGenerateSeedTime: ['i', 300],
    mSLGenerateSeedDist: ['f', 300], mSLDamageHideTime: ['i', 300],
} as const;
type PakkunParams = SmallParams & { [K in keyof typeof PAKKUN_PARAMS]: number };

const mRootExplosionScaleRate = 2, mTestFlyAngX = 30, mIgnoreHitWaterY = 50;

export class PakkunManager extends SmallEnemyManager {
    unk60: PakkunParams | null = null;
    unk64: EmitInfo | null = null; unk68: EmitInfo | null = null;
    constructor(w: World, name = 'パックンマネージャー') { super(w, name); this.unk5C = 0; }
    load(s: Stream) {
        super.load(s);
        const f = this.world.files;
        this.saveParams = smallParams('/enemy/pakkun.prm', f, PAKKUN_PARAMS as any);
        this.unk60 = smallParams('/enemy/staypakkun.prm', f, PAKKUN_PARAMS as any) as any;
        this.unk64 = emitInfo('/enemy/pakkunwater.prm', f);
        this.unk68 = emitInfo('/enemy/pakkunhide.prm', f);
    }
    createModelData() { this.createModelDataArray(['pakun.bmd']); }
    createEnemyInstance() { return new Pakkun(this.world); }
    /** clipEnemies: a staying plant near Mario (within the far clip) keeps its last clipping. */
    clipActors() {
        const P = this.saveParams;
        const far = P ? P.mSLFarClip : 5000, r = P ? P.mSLClipRadius : 300;
        for (const p of this.objs as Pakkun[]) {
            if (p.unk199) { p.updateSquareToMario(); if (p.distToMarioSq < far * far) continue; }
            if (this.world.inView(p.pos, r, far)) p.offLiveFlag(LF.CLIPPED_OUT); else p.onLiveFlag(LF.CLIPPED_OUT);
            const seeds = [p.unk194, ...(p.unk199 && p.unk19C ? p.unk19C : [])];
            seeds.forEach((s, k) => {
                if (!s || s.isState(SEED_HIDE)) return;
                if (k > 0 && !p.unk199) return;
                if (this.world.inView(s.pos, r, far)) s.offLiveFlag(LF.CLIPPED_OUT); else s.onLiveFlag(LF.CLIPPED_OUT);
            });
        }
    }
}

export class Pakkun extends SmallEnemy {
    unk194!: PakkunSeed; unk198 = 0; unk199 = 0; unk19C: PakkunSeed[] | null = null; unk1A0!: PakkunParams; unk1A4 = new V3();
    unk1B0 = 0; unk1B1 = 0; unk1B2a = 0; unk1B8 = 1; unk1BC = 0;
    static mHeadJntIndex = 0;
    constructor(w: World, name = 'パックン') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.reset();
        this.setGoalPath(new PathNode(this.world.mario));
    }
    init(m: any) {
        super.init(m);
        this.actorType = AT.PAKKUN;
        this.unk150 = 17;
        this.unk1A0 = this.getSaveParam();
        this.spine!.initWith(PakkunNerves.generate);
        this.setGoalPath(new PathNode(this.world.mario));
        if (this.instanceIndex === 0) { const j = this.mactor!.jointIndex('null_seed'); if (j >= 0) Pakkun.mHeadJntIndex = j; }
        this.unk194 = new PakkunSeed(this.world);
        this.unk194.loadInit(this, 'seed.bmd');
        this.unk194.unk164 = this.bodyScale;
    }
    setMActorAndKeeper() { this.mactor = this.createMActorByName('pakun.bmd'); }
    isInhibitedForceMove() { return true; }
    kill() { super.kill(); this.unk194.kill(); }
    setWaitAnm() { this.setBckAnm(PAKKUN_ANM.WAIT); }
    setFreezeAnm() { this.setBckAnm(PAKKUN_ANM.DAMAGE); }
    setDeadAnm() { if (!this.checkLiveFlag(LF.HIDDEN)) this.setBckAnm(PAKKUN_ANM.DOWN); }
    perform(cue: number) {
        if (this.checkLiveFlag(LF.UNK200)) return;
        this.unk194.perform(cue);
        if (this.checkLiveFlag(LF.DEAD)) return;
        if (cue & CUE_MOVE) {
            if (this.unk199) this.offLiveFlag(LF.CLIPPED_OUT);
            if (!this.world.isInArea(this.pos.x, this.pos.z)) this.kill();
            this.moveObject();
        }
        if (this.checkLiveFlag(LF.CLIPPED_OUT)) { if (cue & CUE_CALC_ANIM) this.mactor!.frameUpdate(); }
        else if (cue & CUE_CALC_ANIM) { this.calcRootMatrix(); this.mactor!.frameUpdate(); }
    }
    seedPollute(p: V3) {
        const m = this.manager as SmallEnemyManager;
        if (this.world.pollution) this.world.pollution.stamp(m.unk58, p.x, p.y, p.z, 32 * (m.saveParams as SmallParams).mSLStampRange * this.unk158);
    }
    createPakkunSmoke(p: V3) { this.world.sound(SE.EN_PAKKUN_SEED_SINK, p); this.world.effect('pakkunSmoke', p); }
    onShootLiner(dir: V3) {
        const goal = this.pos.clone();
        goal.x += 200 * dir.x; goal.z += 200 * dir.z;
        this.setGoalPath(new PathNode(null, goal));
        this.unk198 = 0;
        if (dir.x === 0 && dir.y === 0 && dir.z === 0) dir.x += 1;
        dir.normalize();
        const sp = this.unk1A0.mSLSeedSpeedS;
        dir.x *= sp; dir.y = -5; dir.z *= sp;
        this.unk194.vel.set(dir);
    }
    onShootCurve(goal: V3) {
        this.setGoalPath(new PathNode(null, goal.clone()));
        const v = this.calcVelocityToJumpToY(goal, this.unk1A0.mSLSeedSpeedC, this.unk1A0.mSLSeedGravityC);
        this.unk198 = 1;
        this.unk194.vel.set(v);
        this.unk194.rot.set(mTestFlyAngX, 0, 0);
    }
    behaveToWater(a: HitActor) {
        this.sprayCooldown = 0;
        if (a.pos.y > this.groundHeight + mIgnoreHitWaterY) {
            this.unk165 = true;
            if (this.hitPoints > 5) this.hitPoints -= 4;
            const c = this.spine!.current;
            if (c !== PakkunNerves.freeze && c !== PakkunNerves.stayAppear && c !== PakkunNerves.stayHide) {
                this.spine!.pushNerve(PakkunNerves.freeze);
                if (this.unk194.isState(SEED_HIDE)) this.unk194.kill();
            }
        }
    }
    reset() {
        super.reset();
        this.unk1B1 = 1; this.unk1B2a = 0; this.unk1B8 = 1;
    }
    shootIn() { this.unk194.appear(); this.unk194.set(); }
    shoot() { this.unk194.shoot(); }
    /** For the viewer: the root joint's swelling (PakkunRootCallback / 2). */
    rootScale() { return this.hitPoints === this.maxHitPoints() ? 1 : this.unk1B8; }
}

export class StayPakkun extends Pakkun {
    constructor(w: World, name = '固定パックン') { super(w, name); }
    load(s: Stream) { super.load(s); this.unk199 = 1; }
    init(m: any) {
        super.init(m);
        this.unk19C = [0, 1].map(() => { const s = new PakkunSeed(this.world); s.loadInit(this, 'seed.bmd'); return s; });
        this.spine!.initWith(PakkunNerves.stayHide);
    }
    reset() {
        super.reset();
        this.unk1B2a = 255;
        this.offLiveFlag(LF.UNK800);
        this.onLiveFlag(LF.HIDDEN);
    }
    setDeadAnm() { this.setBckAnm(PAKKUN_ANM.DOWN); }
    genRandomItem() {
        const m = this.manager as PakkunManager;
        this.unk1A4.set(this.pos); this.unk1A4.y += 100;
        if (m.unk64 && this.world.water) { m.unk64.pos = [this.unk1A4.x, this.unk1A4.y, this.unk1A4.z]; this.world.water.emitRequest(m.unk64); }
        // a big water bottle if FLUDD is under a quarter full, else 3 coins (the tank isn't recorded: coins)
        this.unk18C = 3;
        this.genEventCoin();
        this.world.effect('popoBomb', this.unk1A4);
    }
    calcRootMatrix() { SpineEnemy.prototype.calcRootMatrix.call(this); }
    setBehavior() {
        if (this.isBckAnm(PAKKUN_ANM.HIT)) --this.hitPoints;
        const max = this.maxHitPoints();
        this.unk1B2a = Math.trunc((this.hitPoints * 255) / max) & 0xFF;
        this.unk1B8 = fr(1 + (mRootExplosionScaleRate * (255 - this.unk1B2a)) / 255);
        if (this.hitPoints < 2) { this.world.sound(SE.EN_PAKKUN_RIP, this.pos); this.hitPoints = 1; this.kill(); }
    }
    isHitValid(msg: number) {
        if (msg === MSG.UNKB) { this.onLiveFlag(LF.DEAD); this.onLiveFlag(LF.UNK20000); return true; }
        const c = this.spine!.current;
        if (c !== PakkunNerves.stayAppear && c !== PakkunNerves.stayHide) {
            this.spine!.setNext(PakkunNerves.stayHide);
            this.unk1BC = 1;
            if (this.world.pollution) this.world.pollution.clean(this.pos.x, this.groundHeight, this.pos.z, 32 * this.getSaveParam().mSLPolluteRange, this.world.map);
            if (this.unk194.isState(SEED_HIDE)) this.unk194.kill();
            this.setBckAnm(PAKKUN_ANM.CRUSH_TO_HIDE);
        }
        return false;
    }
    shootIn() {
        super.shootIn();
        this.unk19C!.forEach((s, i) => {
            s.appear(); s.set();
            const v = this.unk194.vel.clone();
            const a = i !== 0 ? 10 : -10;
            const m = mtx(); MsMtxSetRotRPH(m, 0, a, 0);
            s.vel.set(mtxMultVec(m, v));
        });
    }
    kill() { SmallEnemy.prototype.kill.call(this); this.unk194.kill(); for (const s of this.unk19C!) s.kill(); }
    shoot() { this.unk194.shoot(); }
    getSaveParam(): any { return (this.manager as PakkunManager).unk60; }
    perform(cue: number) {
        if (!this.checkLiveFlag(LF.UNK200)) for (const s of this.unk19C || []) s.perform(cue);
        super.perform(cue);
    }
}

/** TPakkunSeed (TEnemyAttachment): the seed a Piranha Plant grows from, and the goop ball it shoots. */
export class PakkunSeed extends SpineEnemy {
    unk150 = 0; unk154 = 0; unk158 = 0; unk160: SpineEnemy | null = null; unk164 = 1; unk168 = 0;
    unk16C: Pakkun | null = null; unk170 = 0;
    constructor(w: World, name = 'パックンの種') { super(w, name); }
    isState(s: number) { return this.unk150 === s; }
    loadInit(host: Pakkun, model: string) {
        this.unk160 = host;
        this.manager = host.manager;   // (TMActorKeeper(host's manager): the model's from its folder)
        this.mactor = this.createMActorByName(model);
        this.manager = null;
        this.unk16C = host;
        this.world.addToGroup('オブジェクトグループ', this);
        this.world.extras.push(this);
        this.initHitActor(AT.POLLUTE_OBJ, 1, HC.PLAYER, 20, 20, 20, 20);
        this.offHitFilter(HF.NO_COLLISION);
        this.unk150 = 0;
        this.groundPlane = this.world.illegal;
    }
    receiveMessage() { return false; }
    appear() { this.unk150 = SEED_APPEAR; this.unk16C!.unk1B0 = 0; this.scale.set(0.5, 0.5, 0.5); }
    shoot() {
        if (this.unk16C!.unk198 === 0) this.unk150 = SEED_SHOOT; else if (this.unk16C!.unk198 === 1) this.unk150 = SEED_CIRCLE;
        this.scale.set(0.1, 0.1, 0.1);
        this.unk168 = 0;
        this.offHitFilter(HF.NO_COLLISION);
    }
    kill() { this.unk150 = 0; this.unk158 = 0; this.onHitFilter(HF.NO_COLLISION); }
    set() {
        // TEnemyAttachment::set
        this.pos.set(this.unk160!.pos); this.rot.set(this.unk160!.rot);
        if (this.unk160!.checkLiveFlag(LF.CLIPPED_OUT)) { this.pos.set(this.unk160!.pos.x, this.unk160!.pos.y + 80, this.unk160!.pos.z); return; }
        const p = this.unk16C!;
        const m = p.mactor!.anmMtx(Pakkun.mHeadJntIndex, p.baseTR, p.scale);
        if (m) { this.pos.x = m[12]; this.pos.y = fr(m[13] - 50); this.pos.z = m[14]; }
    }
    seedSet() { this.pos.set(this.unk160!.pos); this.rot.set(this.unk160!.rot); this.scale.set(this.unk164, this.unk164, this.unk164); }
    rebirth() {
        const host = this.unk16C!;
        if (host.unk199) {
            this.unk150 = 0; this.unk158 = 0; this.onHitFilter(HF.NO_COLLISION);
            host.seedPollute(this.pos);
            this.world.sound(SE.EN_PAKKUN_SEED_SINK, this.pos);
            return;
        }
        ++this.unk158;
        if (this.unk158 > host.unk1A0.mSLGenerateSeedTime || host.unk1B1) { this.unk150 = 0; this.unk158 = 0; this.onHitFilter(HF.NO_COLLISION); }
        if (this.pos.y < this.groundHeight - 70) { this.vel.y = 0; this.onHitFilter(HF.NO_COLLISION); return; }
        if (!this.groundPlane.isWaterSurface()) { host.createPakkunSmoke(this.pos); return; }
        const e = this.world.conductor.makeOneEnemyAppear(this.pos, 'エフェクト水柱マネージャー', 0) as any;
        if (e && e.generate) e.generate(this.pos, this.scale);
    }
    behaveToHost() { if (!this.unk16C!.unk199) this.unk160!.offLiveFlag(LF.HIDDEN); }
    behaveToHitGround() {
        if (Math.abs(this.vel.y) < 1 || this.groundPlane.isWaterSurface()) {
            this.unk168 = 1; this.offLiveFlag(LF.AIRBORNE); this.vel.set(0, -0.3, 0); this.rebirth();
        } else if (this.unk150 === SEED_SHOOT) { this.vel.x *= 0.8; this.vel.z *= 0.8; this.vel.y = 0.1 * Math.abs(this.vel.y); }
        else { this.vel.x *= 0.4; this.vel.z *= 0.4; this.vel.y = 0.4 * Math.abs(this.vel.y); }
    }
    behaveToHitWall(g: BGCheckData) {
        const r = -(1.5 * (this.vel.x * g.n[0] + this.vel.y * g.n[1] + this.vel.z * g.n[2]));
        this.vel.x += r * g.n[0]; this.vel.y += r * g.n[1];
        if (this.unk150 === SEED_SHOOT) this.vel.y = -5;
        this.vel.z += r * g.n[2];
        this.unk16C!.unk1B0 = 1;
    }
    getNowGravity() {
        const P = this.unk16C!.getSaveParam();
        return this.unk150 === SEED_CIRCLE ? P.mSLSeedGravityC : P.mSLSeedGravityS;
    }
    forceKill() {
        if (!this.groundPlane.isPool() && !this.groundPlane.isIllegal() && this.world.isInArea(this.pos.x, this.pos.z)) return;
        this.kill();
        if (!this.unk16C!.unk199 && this.unk160!.checkLiveFlag(LF.HIDDEN)) { this.unk160!.kill(); this.unk160!.onLiveFlag(LF.UNK20000); }
    }
    recoverScale() { if (this.scale.x < this.unk164) this.scale.scale(2); else this.scale.set(this.unk164, this.unk164, this.unk164); }
    bind() {
        const n = this.pos.clone().add(this.posDelta).add(this.vel);
        this.recoverScale();
        this.vel.y -= this.getNowGravity();
        if (this.vel.y < -40) this.vel.y = -40;
        if (!this.unk168) { const [h, d] = this.world.checkGround(n.x, n.y + this.headHeight, n.z); this.groundHeight = h + 1; this.groundPlane = d; }
        if (n.y + this.vel.y <= this.groundHeight) this.behaveToHitGround(); else this.onLiveFlag(LF.AIRBORNE);
        const r: WallCheck = { center: [n.x, n.y + this.headHeight, n.z], radius: 2 * this.bodyRadius, maxResults: 1, flags: 0, results: [] };
        if (this.world.isTouchedWallsAndMoveXZ(r)) this.behaveToHitWall(r.results[0]);
        this.pos.set(n);
        this.posDelta.zero();
        this.forceKill();
    }
    sendMessage() {
        for (const c of this.collisions) {
            if (c.isActorType(AT.MARIO)) { this.world.mario.receiveMessage(this, MSG.ATTACK); continue; }
            if (c !== this.unk160) this.kill();
        }
    }
    moveObject() {
        // TEnemyAttachment::moveObject
        if (this.unk150 === 1) this.set();
        else { this.calcRideMomentum(); this.sendMessage(); this.bind(); this.calcRidePos(); }
        // TPakkunSeed::moveObject
        if (!this.unk168) {
            this.unk170 = MsWrap(this.unk170 + 5, 0, 360);
            if (this.pos.y > this.groundHeight + 20) this.rot.x = MsGetRotFromZaxis(this.vel).x;
        } else {
            this.unk170 = MsClamp(this.unk170 + 5, 0, 360);
            this.rot.x *= 0.8;
        }
    }
    calcRootMatrix() { this.world.sound(SE.EN_PAKKUN_SEED_FLY, this.pos, { hold: holdKey(this, 'fly') }); this.calcRootMatrixBasic(); }
    perform(cue: number) {
        if (this.unk150 === 0) { if (cue & CUE_CALC_ANIM) this.behaveToHost(); return; }
        if (cue & CUE_MOVE) this.moveObject();
        if (cue & CUE_CALC_ANIM) { this.calcRootMatrix(); this.mactor!.frameUpdate(); }
    }
    drawn() { return this.unk150 !== 0; }
}

type S = Spine<Pakkun>;
export const PakkunNerves: Record<string, any> = {};
PakkunNerves.generate = nerve<Pakkun>('TNervePakkunGenerate', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.onHitFilter(HF.NO_COLLISION); self.onLiveFlag(LF.HIDDEN); self.unk194.appear(); }
    if (self.holder) return false;
    const seed = self.unk194;
    if (seed.isState(SEED_APPEAR)) {
        seed.seedSet();
        if (spine.time % 5 === 0) {
            self.updateSquareToMario();
            const d = self.unk1A0.mSLGenerateSeedDist;
            if (self.distToMarioSq < d * d) self.unk194.unk150 = SEED_SET;
        }
    }
    if (self.unk194.isState(SEED_HIDE)) {
        self.pos.set(self.unk194.pos); self.pos.y = self.unk194.groundHeight;
        spine.pushAfterCurrent(PakkunNerves.appear);
        self.setBckAnm(PAKKUN_ANM.SET);
        return true;
    }
    return false;
});
PakkunNerves.stay = nerve<Pakkun>('TNervePakkunStay', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setWaitAnm();
    const P = self.getSaveParam() as PakkunParams;
    const wait = P.mSLWaitTime, ready = self.unk1A0.mSLReadyTime;
    if (self.unk194.isState(SEED_HIDE) && self.checkCurAnmEnd(ANM_BCK) && (spine.time >= ready || spine.time >= wait || self.unk1B1)) {
        const goalDist = V3.sub(self.goal104.point(), self.pos).length();
        const range = self.unk1A0.mSLShootRange, k = self.unk199 ? 3 : 1;
        const mario = self.world.mario.pos;
        if (goalDist < range * k || self.unk199) {
            if (Math.abs(mario.y - self.pos.y) < P.mSLSearchHeight * k && self.isInSight(mario, P.mSLSearchLength * k, P.mSLSearchAngle * k, P.mSLSearchAware * k)) {
                spine.pushAfterCurrent(PakkunNerves.stay);
                spine.pushAfterCurrent(PakkunNerves.shoot);
                self.unk1B1 = 0;
                if (!self.unk1B0 || self.unk199) self.onShootLiner(new V3(mario.x - self.pos.x, mario.y - self.pos.y, mario.z - self.pos.z));
                else { self.unk1B0 = 0; self.onShootCurve(self.goal104.point().clone()); }
                return true;
            }
        } else if (spine.time >= wait) {
            spine.pushAfterCurrent(PakkunNerves.hide);
            spine.pushAfterCurrent(PakkunNerves.shoot);
            const angle = Math.trunc(MsRandF(0, 36000));
            const goal = self.goal104.point().clone();
            if (V3.sub(goal, self.pos).length() > self.unk1A0.mSLLimitMove) {
                goal.set(mario.x - self.pos.x, 0, mario.z - self.pos.z);
                if (goal.x === 0 && goal.y === 0 && goal.z === 0) goal.x += 1;
                goal.normalize();
                const md = self.unk1A0.mSLMoveDist;
                goal.x = goal.x * md + self.pos.x; goal.z = goal.z * md + self.pos.z;
                self.onShootCurve(goal);
            } else {
                const c = self.unk1A0.mSLMarioCircle;
                goal.x += c * JMASCos(angle); goal.z += c * JMASSin(angle);
                self.onShootCurve(goal);
            }
            return true;
        }
    }
    self.walkToCurPathNode(0, self.turnSpeed, 0);
    if (self.unk199 && !self.isFindMario(1)) {
        if (V3.sub(self.goal104.point(), self.pos).length() > P.mSLGiveUpLength) { spine.pushAfterCurrent(PakkunNerves.stayHide); return true; }
    }
    return false;
});
PakkunNerves.appear = nerve<Pakkun>('TNervePakkunAppear', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.setBckAnm(PAKKUN_ANM.SET); self.offHitFilter(HF.NO_COLLISION); }
    if (self.checkCurAnmEnd(ANM_BCK)) { spine.pushAfterCurrent(PakkunNerves.stay); return true; }
    return false;
});
PakkunNerves.hide = nerve<Pakkun>('TNervePakkunHide', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(PAKKUN_ANM.HIDE);
    if (self.checkCurAnmEnd(ANM_BCK)) { self.onHitFilter(HF.NO_COLLISION); self.onLiveFlag(LF.HIDDEN); }
    if (self.unk194.isState(SEED_HIDE)) {
        self.pos.set(self.unk194.pos); self.pos.y = self.unk194.groundHeight;
        spine.pushAfterCurrent(PakkunNerves.appear);
        self.setBckAnm(PAKKUN_ANM.SET);
        return true;
    }
    return false;
});
PakkunNerves.shoot = nerve<Pakkun>('TNervePakkunShoot', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(PAKKUN_ANM.SHOOT);
    const fc = self.mactor!.getFrameCtrl(ANM_BCK)!;
    if (fc.checkPass(60)) self.shootIn();
    if (fc.checkPass(70)) self.shoot();
    self.walkToCurPathNode(0, self.turnSpeed, 0);
    if (self.checkCurAnmEnd(ANM_BCK)) { self.setGoalPath(new PathNode(self.world.mario)); return true; }
    return false;
});
PakkunNerves.freeze = nerve<Pakkun>('TNervePakkunFreeze', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(PAKKUN_ANM.HIT_START);
    if (self.checkCurAnmEnd(ANM_BCK)) {
        if (self.isBckAnm(PAKKUN_ANM.HIT_START)) { if (self.unsetUnk165()) self.setBckAnm(PAKKUN_ANM.HIT); }
        else if (self.unsetUnk165()) self.setBckAnm(PAKKUN_ANM.HIT);
        else if (self.isBckAnm(PAKKUN_ANM.HIT)) self.setBckAnm(PAKKUN_ANM.HIT_END);
        else return true;
    }
    return false;
});
PakkunNerves.stayHide = nerve<StayPakkun>('TNerveStayPakkunHide', (spine: Spine<StayPakkun>) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.onHitFilter(HF.NO_COLLISION);
        if (!self.isBckAnm(PAKKUN_ANM.CRUSH_TO_HIDE)) self.setBckAnm(PAKKUN_ANM.HIDE);
        self.unk194.kill();
    } else {
        if (self.unk1BC && spine.time > self.unk1A0.mSLDamageHideTime) self.unk1BC = 0;
        if (self.checkCurAnmEnd(ANM_BCK)) {
            self.onLiveFlag(LF.HIDDEN);
            const pol = self.world.pollution;
            if (!self.unk1BC && pol && pol.isPolluted(self.pos.x, self.pos.y, self.pos.z) && self.isFindMario(0.9)) {
                self.resetHitPoints();
                spine.pushAfterCurrent(PakkunNerves.stayAppear);
                return true;
            }
        }
    }
    self.walkToCurPathNode(0, self.turnSpeed * 3, 0);
    return false;
});
PakkunNerves.stayAppear = nerve<StayPakkun>('TNerveStayPakkunAppear', (spine: Spine<StayPakkun>) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.offLiveFlag(LF.HIDDEN);
        self.setBckAnm(PAKKUN_ANM.SET);
        self.offHitFilter(HF.NO_COLLISION);
        self.unk1B1 = 1;
        self.unk194.kill();
    }
    if (self.checkCurAnmEnd(ANM_BCK)) { spine.pushAfterCurrent(PakkunNerves.stay); return true; }
    return false;
});

register('PakkunManager', (w, n) => new PakkunManager(w, n));
register('StayPakkun', (w, n) => new StayPakkun(w, n));
register('Pakkun', (w, n) => new Pakkun(w, n));
export { SmallEnemyNerves, IDX, LiveActor };
