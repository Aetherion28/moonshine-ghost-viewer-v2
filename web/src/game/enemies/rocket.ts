// The rockets of Pinna Park's Mecha-Bowser fight (Enemy/rocket.cpp): TRocket (ロケット), a
// TSmallEnemy that waits where it stands (TNerveRocketWait) until Mario touches or sprays it, then
// sticks to FLUDD's nozzle (TNerveRocketPossessedNozzle: only one at a time, the manager's unk60),
// riding the nozzle's emit matrix; pressing R fires it (TNerveRocketFly) along the nozzle's X
// axis at mSLReleaseSpeed, under mSLFlyGravity. It blows up on the first wall or floor it touches
// (telling that collision's actor — Mecha-Bowser's parts — it hit them, HIT_MESSAGE_ATTACK), on
// anything it tramples in flight, or after mSLFlyLimitTime, splashing rocketexpwater.prm. A dead
// one placed in scene.bin comes back where it was placed; TRocketManager (ロケットマネージャー)
// puts the others on random nodes of the "main" graph.
//
// The nozzle's emit matrix and R's pressure come from the ghost's FLUDD record (popo.ts' helpers,
// as for TPopo, the goop blobs that ride the nozzle the same way).
//
// Not here: the particles (smoke, bomb), rumble, the looping flying sound and the animation sounds.

import { fr, V3, mtx, Mtx, MsRandF, MsMtxSetRotRPH, MsGetRotFromZaxis, MsGetRotFromZaxisY, MsAngleWrap } from '../math.js';
import { World, SpineEnemy, Stream, HitActor, LiveActor, LiveManager, LF, HF, HC, MSG, nerve, Spine } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { SmallEnemy, SmallEnemyManager, smallParams } from './smallEnemy.js';
import { emitMtx, pumpPressure } from './popo.js';
import { emitInfo, EmitInfo } from '../water.js';
import { MTXConcat, sendToMario } from '../mapobj/lib.js';
import type { WallCheck } from '../collision.js';

/** TRocketSaveLoadParams (/enemy/rocket.prm) */
const ROCKET_PARAMS = { mSLReleaseSpeed: ['f', 10], mSLFlyGravity: ['f', 0], mSLFlyLimitTime: ['i', 300] } as const;

// TRocket's statics
const mTestAng_x = 0, mTestAng_y = 90, mTestAng_z = 0, mNozzleOffsetZ = 25, mColOffsetY = 20;
// rocket_bastable's BCKs (all without sounds): 0 on the nozzle, 1 flying, 2 full, 3 waiting
export const ROCKET_ANM_POSSESSED = 0, ROCKET_ANM_FLY = 1, ROCKET_ANM_FULL = 2, ROCKET_ANM_WAIT = 3;

/** TMsRange<s32>::rand */
const rangeI = (lo: number, hi: number) => lo + Math.trunc(fr((hi - lo) * MsRandF()));
const translation = (x: number, y: number, z: number) => { const m = mtx(); m[3] = x; m[7] = y; m[11] = z; return m; };

// ---------------------------------------------------------------- TRocketManager
export class RocketManager extends SmallEnemyManager {
    /** 0x60: no rocket is on the nozzle */
    unk60 = 1;
    unk64 = 0;
    /** 0x68: the splash it blows up in */
    unk68: EmitInfo | null = null;
    constructor(w: World, name = 'ロケットマネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.saveParams = smallParams('/enemy/rocket.prm', this.world.files, ROCKET_PARAMS as any);
        this.unk68 = emitInfo('/enemy/rocketexpwater.prm', this.world.files);
    }
    /** JDrama::TNameRef::loadAfter (not the small-enemy one) */
    loadAfter() { }
    createEnemyInstance(): SpineEnemy { return new Rocket(this.world); }
    createModelData() { this.createModelDataArray(['rocket.bmd']); }
    /** clipEnemies: none */
    clipActors() { }
    initSetEnemies() {
        for (let i = 0; i < this.getObjNum(); ++i) {
            const graph = this.world.graphByName('main');
            const r = this.objs[i] as Rocket;
            if (r.checkLiveFlag(LF.DEAD) && !graph.isDummy()) {
                const p = graph.point(rangeI(0, graph.count));
                r.pos.set(p);
                r.pos.y = fr(r.pos.y + 5);
                r.onLiveFlag(LF.AIRBORNE);
                r.reset();
            }
        }
    }
    perform(cue: number) {
        if (cue & 1) for (let i = 0; i < this.getActiveObjNum(); ++i) { const r = this.objs[i] as Rocket; if (r.checkLiveFlag(LF.DEAD)) r.reset(); }
        super.perform(cue);
    }
}

// ---------------------------------------------------------------- TRocket
export class Rocket extends SmallEnemy {
    /** 0x194: where scene.bin placed it */
    unk194 = new V3();
    /** 0x1A0: on the nozzle (or flying off it) */
    unk1A0 = 0;
    /** 0x1A1: placed in scene.bin */
    unk1A1 = 0;
    unk1A4: any = null;
    constructor(w: World, name = 'ロケット') { super(w, name); }
    get mgrR() { return this.manager as RocketManager; }
    load(s: Stream) {
        super.load(s);
        this.unk194.set(this.pos);
        this.unk1A1 = 1;
        this.reset();
    }
    init(m: LiveManager | null) {
        super.init(m);
        this.actorType = AT.ROCKET;
        this.unk150 = 0x11;
        this.unk1A4 = this.getSaveParam();
        this.spine!.initWith(RocketNerves.wait);
        this.onHitFilter(HC.BOSS);
    }
    calcRootMatrix() {
        if (this.unk1A0) {
            let m: Mtx;
            if (this.spine!.current === RocketNerves.fly) m = translation(this.pos.x, this.pos.y, this.pos.z);
            else {
                // (the game divides each axis by its length — with the lengths' tests mixed up — orthonormal here: nothing)
                m = emitMtx(this.world);
                MTXConcat(m, translation(mNozzleOffsetZ, 0, 0), m);
                this.pos.set(fr(m[3]), fr(fr(m[7]) - mColOffsetY), fr(m[11]));
            }
            const r = mtx();
            MsMtxSetRotRPH(r, mTestAng_x, mTestAng_y, mTestAng_z);
            MTXConcat(m, r, m);
            this.baseTR.set(m);
        } else SpineEnemy.prototype.calcRootMatrix.call(this);
        // (isBckAnm(1): the flying sound)
    }
    setMActorAndKeeper() { this.mactor = this.createMActorByName('rocket.bmd'); }
    reset() {
        this.unk1A0 = 0;
        super.reset();
        if (this.unk1A1) this.pos.set(this.unk194);
        this.onLiveFlag(LF.UNK10);
        this.offLiveFlag(LF.UNK800);
        this.onLiveFlag(LF.UNK8);
        this.spine!.initWith(RocketNerves.wait);
    }
    attackToMario() {
        if (this.spine!.current === RocketNerves.wait && this.mgrR.unk60) this.spine!.pushNerve(RocketNerves.possessedNozzle);
    }
    behaveToWater(_a: HitActor) { this.attackToMario(); }
    getWallRadius() { return this.bodyScale * this.wallRadius; }
    bind() {
        if (this.checkLiveFlag(LF.UNK10)) return;
        const c = this.spine!.current;
        if (c === RocketNerves.possessedNozzle || c === RocketNerves.fly) {
            const r: WallCheck = { center: [this.pos.x, this.pos.y, this.pos.z], radius: this.getWallRadius(), maxResults: 1, flags: 0, results: [] };
            if (this.world.isTouchedWallsAndMoveXZ(r)) {
                const a = r.results[0].actor as LiveActor | null;
                if (a) a.receiveMessage(this, MSG.ATTACK);
                this.kill();
                return;
            }
            if (c === RocketNerves.fly) {
                LiveActor.prototype.bind.call(this);
                if (!this.isAirborne()) {
                    const a = this.groundPlane.actor as LiveActor | null;
                    if (a) a.receiveMessage(this, MSG.ATTACK);
                    this.kill();
                }
            }
        } else LiveActor.prototype.bind.call(this);
    }
    setDeadAnm() {
        const man = this.mgrR, I = man.unk68;
        if (I && this.world.water) { I.pos = [this.pos.x, this.pos.y, this.pos.z]; this.world.water.emitRequest(I); }
        if (this.unk1A0) this.releaseNozzle();
        this.onLiveFlag(LF.UNK20000);
        this.world.effect('ms_petbtl_bomb', this.pos);
    }
    getGravityY() { return this.spine!.current === RocketNerves.fly ? this.unk1A4.mSLFlyGravity : this.gravity; }
    isCollidMove(a: HitActor) {
        if (this.spine!.current === RocketNerves.fly && a.receiveMessage(this, MSG.TRAMPLE)) this.kill();
        return false;
    }
    possessedNozzle() { this.mgrR.unk60 = 0; this.offLiveFlag(LF.UNK10); this.unk1A0 = 1; }
    releaseNozzle() { this.mgrR.unk60 = 1; this.unk1A0 = 0; }
    /** checkTrigger: held on the nozzle; R fires it */
    checkTrigger() {
        const w = this.world;
        sendToMario(w, this, MSG.ATTACH);
        if (pumpPressure(w) > 20 && this.hitPoints > 1) --this.hitPoints;
        if (!this.isBckAnm(ROCKET_ANM_FULL)) { w.sound(SE.SY_PO_WATER_FULL); this.setBckAnm(ROCKET_ANM_FULL); }
        // (MEANING_R: R pressed: taken as spraying)
        const m = w.mario;
        if (m.fludd && m.fludd.spraying) {
            this.unk190 = 2;
            this.expandCollision();
            w.sound(SE.PO_PETBOTTLE_FLY, this.pos);
            return true;
        }
        return false;
    }
    flyBehavior() {
        // (the smoke particle)
        if (this.spine!.time > this.unk1A4.mSLFlyLimitTime) this.kill();
    }
    isAttack() { return this.spine!.current === RocketNerves.fly; }
}

// ---------------------------------------------------------------- nerves
type S = Spine<Rocket>;
export const RocketNerves: Record<string, any> = {};
RocketNerves.possessedNozzle = nerve<Rocket>('TNerveRocketPossessedNozzle', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.world.sound(SE.MA_GET_ITEM, self.pos);
        self.world.sound(SE.PO_GET_PETBOTTLE, self.pos);
        self.possessedNozzle();
        self.setBckAnm(ROCKET_ANM_POSSESSED);
    }
    if (self.checkTrigger()) { spine.pushAfterCurrent(RocketNerves.fly); return true; }
    return false;
});
RocketNerves.fly = nerve<Rocket>('TNerveRocketFly', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.setBckAnm(ROCKET_ANM_FLY);
        const m = emitMtx(self.world), speed = self.unk1A4.mSLReleaseSpeed;
        const v = new V3(fr(speed * m[0]), fr(speed * m[4]), fr(speed * m[8]));
        self.vel.set(v);
        self.onLiveFlag(LF.AIRBORNE);
        self.releaseNozzle();
        self.rot.set(0, MsAngleWrap(MsGetRotFromZaxisY(v)), 0);
        self.offHitFilter(HF.NO_COLLISION);
    }
    if (!self.isBckAnm(ROCKET_ANM_FLY)) self.setBckAnm(ROCKET_ANM_FLY);
    self.rot.x = fr(MsGetRotFromZaxis(self.vel).x);
    self.flyBehavior();
    return false;
});
RocketNerves.wait = nerve<Rocket>('TNerveRocketWait', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.onLiveFlag(LF.UNK10); self.setBckAnm(ROCKET_ANM_WAIT); }
    return false;
});

register('RocketManager', (w, n) => new RocketManager(w, n));
register('Rocket', (w, n) => new Rocket(w, n));
