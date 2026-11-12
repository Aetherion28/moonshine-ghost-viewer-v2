// TAmiNoko / TAmiHit / TAmiNokoManager (Enemy/amiNoko.cpp): the electric Koopas (アミノコ) that
// crawl along Pianta Village's fences. One creeps from graph node to node along its fence
// (TNerveAmiNokoWalkOnFence), turns at each (TNerveAmiNokoTurn), and lines its body up with the
// plane nearest it — a wall, the ground or a roof (calcRootMatrix: unk194 / unk198, the up
// vector unk19C turning towards its normal by mSLMtxRotSpeed a frame). Touching it, or its
// shell hit (TAmiHit, 100 units out along its up vector), shocks Mario (ELECTRIC_SHOCK) unless
// he is on the other side of its plane; then, or sprayed, it freezes (TNerveAmiNokoFreeze).
// Punched from behind (the side its up vector faces) or hip dropped, it is knocked off its fence
// (TNerveAmiNokoDie): flung along its up vector, gravity off, until it hits a wall, lands, or is
// 10000 away. Trampling it does nothing. Not here: the electric particles (MS_AMN_BIRI, the
// sparks), and Yoshi's juice (TNerveSmallEnemyChange).
//
// GMSJ01 / US code (the PAL version computes the direction in perform instead: VERSION_GMSP01).

import { fr, V3, mtx, Mtx, HALF_PI_F, jgNormalize, psMtxMultVec } from '../math.js';
import { vNorm, vLen } from '../vecops.js';
import { MTXRotAxisRad } from '../mapobj/lib.js';
import { V } from '../version.js';
import { World, HitActor, LF, HF, HC, MSG, nerve, Spine, Stream, CUE_MOVE, CUE_CALC_ANIM, SpineEnemy, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemyManager, SmallEnemyNerves, SE_LF } from './smallEnemy.js';
import { WalkerEnemy, walkerParams } from './walker.js';
import type { BGCheckData, WallCheck } from '../collision.js';
import { SE } from '../sound.js';
import { register } from '../scene.js';

/** TAmiNokoSaveLoadParams */
const AMINOKO_PARAMS = { mSLElecRange: ['f', 200], mSLMtxRotSpeed: ['f', 0.05] } satisfies PSchema;

/** TUtil<f32>::epsilon (TVec3::isZero) */
const EPS = 32 * 1.1920929e-7;
const isZero = (v: V3) => v.squared() <= EPS;
const velocityMinY = -40;

// BCKs (/scene/amiNoko, in the folder's order)
const BCK_FLYING_LOOP = 0, BCK_FLYING_START = 1, BCK_HIT = 2, BCK_RUN1_END = 3, BCK_RUN1_LOOP = 4, BCK_RUN1_START = 5,
    BCK_RUN2_END = 6, BCK_RUN2_LOOP = 7, BCK_RUN2_START = 8, BCK_TURN1_END = 9, BCK_TURN1_LOOP = 10, BCK_TURN1_START = 11,
    BCK_TURN2_END = 12, BCK_TURN2_LOOP = 13, BCK_TURN2_START = 14, BCK_WAIT = 15;

export const PLANE_GROUND = 0, PLANE_ROOF = 1, PLANE_WALL = 2;

export class AmiNokoManager extends SmallEnemyManager {
    constructor(w: World, name = 'アミノコマネージャー') { super(w, name); }
    load(s: Stream) {
        this.saveParams = walkerParams('/enemy/amiNoko.prm', this.world.files, AMINOKO_PARAMS);
        super.load(s);
    }
    createModelData() { this.createModelDataArray(['aminoko_model1.bmd']); }
    createEnemyInstance(): SpineEnemy | null { return null; }
}

/** TAmiHit: its shell's hit actor (アミノコ当り判定), in the enemy group. */
export class AmiHit extends HitActor {
    constructor(public body: AmiNoko, name = 'アミノコ当り判定') {
        super(name);
        body.world.addToGroup('敵グループ', this);
        this.initHitActor(AT.AMI_NOKO, 1, HC.PLAYER, 120, 240, 120, 240);
        this.offHitFilter(HF.NO_COLLISION);
    }
    receiveMessage(sender: HitActor, msg: number) { return this.body.receiveMessage(sender, msg); }
    perform(cue: number) {
        if (cue & CUE_MOVE) {
            const b = this.body;
            const v = b.unk19C.clone().normalize().scale(100);
            this.pos.set(b.pos).add(v);
            this.pos.y = fr(this.pos.y - 0.5 * this.attackHeight);
            if (!b.checkLiveFlag(LF.DEAD)) for (const c of this.collisions.slice()) if (c.isActorType(AT.MARIO)) b.attackToMario();
        }
    }
}

const converge = (v: number, t: number, step: number) => (v < t ? Math.min(fr(v + step), t) : Math.max(fr(v - step), t));

export class AmiNoko extends WalkerEnemy {
    /** the plane it is on (the nearest), and which kind (PLANE_*) */
    unk194: BGCheckData | null = null; unk198 = PLANE_GROUND;
    /** its up vector and its facing (and the last pair that weren't parallel) */
    unk19C = new V3(0, 1, 0); unk1A8 = new V3(0, 0, 1); unk1B4 = new V3(0, 1, 0); unk1C0 = new V3(0, 0, 1);
    /** the last root matrix (kept while it flies off: BCK 0) */
    unk1CC: Mtx = mtx();
    unk1FC = new V3();
    hit: AmiHit | null = null;
    /** 1: the run1 / turn1 animations, 0 (Pianta Village): run2 / turn2 */
    unk210 = 1;
    get PA(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'アミノコ') { super(w, name); }
    load(s: Stream) {
        SpineEnemy.prototype.load.call(this, s);
        this.coinId = s.s32(this.coinId);
    }
    setMActorAndKeeper() { this.mactor = this.createMActorByName('aminoko_model1.bmd'); }
    init(m: any) {
        super.init(m);
        this.actorType = AT.AMI_NOKO;
        this.unk150 = 0x11;
        this.spine!.initWith(AmiNokoNerves.walkOnFence);
        this.reset();
        this.setWalkAnm();
        this.onLiveFlag(LF.UNK10);
        this.initialGraphNode();
        if (this.world.map === 8) this.unk210 = 0;
        if (!V.GMSJ01) this.unkE8 = 0; // no riding the ground actor
        this.hit = new AmiHit(this);
    }
    reset() { super.reset(); }
    behaveToWater(_a: HitActor) {
        if (this.spine!.current !== AmiNokoNerves.freeze) { this.spine!.pushNerve(AmiNokoNerves.freeze); this.sprayCooldown = 0; }
    }
    attackToMario() {
        // (TNerveSmallEnemyChange: Yoshi's juice, never here)
        if (!this.unk194) return;
        const m = this.world.mario;
        let check = true;
        switch (this.unk198) {
            // SMS_GetMarioRfPlane / GrPlane are never null (the illegal plane at worst)
            case PLANE_GROUND: if (m.pos.y < this.pos.y) check = false; break;
            case PLANE_ROOF: if (5 + m.pos.y > this.pos.y) check = false; break;
            // SMS_GetMarioWlPlane (gpMarioOriginal->mWallPlane): no shock through a wall facing away from its fence
            case PLANE_WALL: {
                const wl = (m as any).mWallPlane as BGCheckData | null | undefined, n = this.unk194.n;
                if (wl && fr(fr(fr(wl.n[0] * n[0]) + fr(wl.n[1] * n[1])) + fr(wl.n[2] * n[2])) < 0) check = false;
                break;
            }
        }
        if (check && m.receiveMessage(this, MSG.ELECTRIC_SHOCK)) {
            if (this.spine!.current !== AmiNokoNerves.freeze) this.spine!.pushNerve(AmiNokoNerves.freeze);
        }
    }
    setWalkAnm() { this.setBckAnm(this.unk210 ? BCK_RUN1_START : BCK_RUN2_START); }
    isHitValid(msg: number) {
        if (msg === MSG.PUNCH || msg === MSG.HIP_DROP) {
            const m = this.world.mario.pos;
            const diff = new V3(fr(this.pos.x - m.x), 0, fr(this.pos.z - m.z));
            if (diff.dot(this.unk19C) > 0 || msg === MSG.HIP_DROP) this.spine!.pushNerve(AmiNokoNerves.die);
        }
        return msg === MSG.UNKB;
    }
    isCollidMove(_a: HitActor) { return false; }
    /**
     * The facing update. JP 1.0 does it inside calcRootMatrix; the later builds moved it to
     * calcDirection (amiNoko.cpp:225), run from perform on the animation cue, before moveObject.
     */
    calcDirection() {
        const w = this.world, P = this.pos;
        const pos = V3.sub(this.goal.point(), P);
        if (V.GMSJ01) {
            if (pos.x === 0 && pos.y === 0 && pos.z === 0) pos.x = 1;
            vNorm(pos);
        } else if (isZero(pos)) pos.set(1, 0, 0);
        else jgNormalize(pos);
        const rec: WallCheck = { center: [P.x, P.y, P.z], radius: 10, maxResults: 4, flags: 0, results: [] };
        const n = w.col.checkWalls(rec);
        const planeDist = (d: BGCheckData) => d.n[0] * P.x + d.n[1] * P.y + d.n[2] * P.z + d.d;
        let minDist = -1, bestIdx = -1;
        for (let i = 0; i < n; ++i) {
            const dist = Math.abs(planeDist(rec.results[i]));
            if (bestIdx < 0 || minDist > dist || minDist < 0) { minDist = dist; this.unk198 = PLANE_WALL; bestIdx = i; }
        }
        // (mResultWalls[-1] with no walls: the record's wall count before it, 0: null)
        let best: BGCheckData | null = bestIdx >= 0 ? rec.results[bestIdx] : null;
        const [, g] = w.checkGround(P.x, P.y + this.getHeadHeight(), P.z);
        this.groundPlane = g;
        {
            const dist = planeDist(g);
            if (dist >= 0 && (minDist > dist || minDist < 0)) { minDist = dist; best = g; this.unk198 = PLANE_GROUND; }
        }
        const [, r] = w.checkRoof(P.x, P.y, P.z);
        {
            const dist = planeDist(r);
            if (dist >= 0 && (minDist > dist || minDist < 0)) { best = r; this.unk198 = PLANE_ROOF; }
        }
        if (best) this.unk194 = best;
        const step = this.PA.mSLMtxRotSpeed;
        const normal = this.unk194 ? new V3(this.unk194.n[0], this.unk194.n[1], this.unk194.n[2]) : new V3(0, 1, 0);
        const u = this.unk19C;
        if (!V.GMSJ01 && normal.dot(u) <= -1) u.set(normal);
        else {
            u.x = converge(u.x, normal.x, step); u.y = converge(u.y, normal.y, step); u.z = converge(u.z, normal.z, step);
            if (!V.GMSJ01) vNorm(u);
        }
        if (this.unk1A8.dot(pos) < -0.1) {
            const rot = mtx();
            MTXRotAxisRad(rot, normal, HALF_PI_F);
            psMtxMultVec(rot, pos, pos);
        }
        const f = this.unk1A8;
        f.x = converge(f.x, pos.x, step); f.y = converge(f.y, pos.y, step); f.z = converge(f.z, pos.z, step);
        vNorm(f);
        if (V.GMSJ01) return;
        const axis = new V3().cross(u, f).fround();
        if (!isZero(axis)) { this.unk1B4.set(u); this.unk1C0.set(f); }
        pos.cross(axis, u).fround();
        if (!isZero(pos)) f.set(pos);
    }
    calcRootMatrix() {
        this.world.sound(SE.EN_AMINOKO_SPARK, this.pos);
        const m = this.baseTR, P = this.pos, u = this.unk19C;
        if (this.isBckAnm(BCK_FLYING_LOOP)) {
            this.unk1CC[3] = P.x; this.unk1CC[7] = P.y; this.unk1CC[11] = P.z;
            m.set(this.unk1CC);
            return;
        }
        if (V.GMSJ01) this.calcDirection();
        let nrm = u.clone(), fwd = this.unk1A8.clone();
        const axis = new V3().cross(nrm, fwd).fround();
        if (isZero(axis)) {
            nrm = this.unk1B4.clone(); fwd = this.unk1C0.clone();
            axis.cross(nrm, fwd).fround();
            if (isZero(axis)) axis.set(1, 0, 0);
        } else if (V.GMSJ01) { this.unk1B4.set(u); this.unk1C0.set(this.unk1A8); }
        vNorm(axis);
        if (V.GMSJ01) {
            fwd.cross(axis, nrm).fround();
            if (isZero(fwd)) fwd.set(0, 0, 1); else vNorm(fwd);
            nrm.cross(fwd, axis).fround();
            if (isZero(nrm)) nrm.set(0, 1, 0); else vNorm(nrm);
        }
        m[0] = axis.x; m[4] = axis.y; m[8] = axis.z;
        m[1] = nrm.x; m[5] = nrm.y; m[9] = nrm.z;
        m[2] = fwd.x; m[6] = fwd.y; m[10] = fwd.z;
        m[3] = fr(P.x - fr(30 * u.x)); m[7] = fr(P.y - fr(30 * u.y)); m[11] = fr(P.z - fr(30 * u.z));
        this.unk1CC.set(m);
    }
    bind() {
        if (this.isBckAnm(BCK_FLYING_LOOP)) {
            const v = this.pos.clone().add(this.posDelta).add(this.vel);
            this.vel.y = fr(this.vel.y - this.getGravityY());
            if (this.vel.y < velocityMinY) this.vel.y = velocityMinY;
            const [h, d] = this.checkLiveFlag(LF.UNK1000) ? this.world.checkGroundIgnoreWaterSurface(v.x, v.y + this.headHeight, v.z) : this.world.checkGround(v.x, v.y + this.headHeight, v.z);
            this.groundPlane = d; this.groundHeight = fr(h + 1);
            if (v.y <= this.groundHeight + 0.05) {
                if (this.groundPlane.isIllegal()) this.kill();
                this.offLiveFlag(LF.AIRBORNE);
                this.vel.set(0, 0, 0);
                v.y = this.groundHeight;
            } else this.onLiveFlag(LF.AIRBORNE);
            this.posDelta.set(v.sub(this.pos));
        } else super.bind();
    }
    perform(cue: number) {
        if (!V.GMSJ01 && (cue & CUE_CALC_ANIM)) this.calcDirection();
        super.perform(cue);
        this.hit!.perform(cue);
    }
    getGravityY() { return this.spine!.current === AmiNokoNerves.die ? 0 : this.gravity; }
    creepToCurPathNode(s: number) {
        if (!V.GMSJ01) {
            const d = V3.sub(this.goal.point(), this.pos);
            if (!isZero(d)) {
                const speed = Math.min(s, vLen(d));
                jgNormalize(d).scale(speed).fround();
                this.posDelta.add(d).fround();
            }
            return;
        }
        if (this.isBckAnm(BCK_RUN1_LOOP) || this.isBckAnm(BCK_RUN2_LOOP) || this.isBckAnm(BCK_TURN1_LOOP) || this.isBckAnm(BCK_TURN2_LOOP)) {
            const d = V3.sub(this.goal.point(), this.pos);
            if (d.x === 0 && d.y === 0 && d.z === 0) d.x = 1;
            vNorm(d).scale(s);
            this.posDelta.add(d);
        }
    }
    isDeadByWall() {
        if (this.world.isTouchedOneWallAndMoveXZ(this.pos, this.pos.y, 3 * this.bodyRadius)) {
            this.vel.set(0, 0, 0);
            this.world.effect('enemyWallHit', this.pos, this.scale);
            return true;
        }
        return false;
    }
}

type S = Spine<AmiNoko>;
export const AmiNokoNerves: Record<string, any> = {};
AmiNokoNerves.walkOnFence = nerve<AmiNoko>('TNerveAmiNokoWalkOnFence', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setWalkAnm();
    if (self.isBckAnm(BCK_RUN1_START) || self.isBckAnm(BCK_RUN2_START)) {
        if (self.checkCurAnmEnd(0)) self.setBckAnm(self.unk210 !== 0 ? BCK_RUN1_LOOP : BCK_RUN2_LOOP);
    }
    const d = V3.sub(self.goal.point(), self.pos);
    if (d.length() < 1.5 && self.checkCurAnmEnd(0)) {
        if (self.isBckAnm(BCK_RUN1_END) || self.isBckAnm(BCK_RUN2_END)) {
            self.goToRandomNextGraphNode();
            spine.pushAfterCurrent(AmiNokoNerves.turn);
            return true;
        }
        if (self.isBckAnm(BCK_RUN1_LOOP)) self.setBckAnm(BCK_RUN1_END);
        else if (self.isBckAnm(BCK_RUN2_LOOP)) self.setBckAnm(BCK_RUN2_END);
    }
    self.creepToCurPathNode(3);
    return false;
});
AmiNokoNerves.turn = nerve<AmiNoko>('TNerveAmiNokoTurn', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(self.unk210 !== 0 ? BCK_TURN1_START : BCK_TURN2_START);
    if (self.isBckAnm(BCK_TURN1_START) || self.isBckAnm(BCK_TURN2_START)) {
        if (self.checkCurAnmEnd(0)) self.setBckAnm(self.unk210 !== 0 ? BCK_TURN1_LOOP : BCK_TURN2_LOOP);
    }
    const d = V3.sub(self.goal.point(), self.pos);
    if (d.x === 0 && d.y === 0 && d.z === 0) d.x = 1;
    d.normalize();
    if (d.dot(self.unk1A8) > 0.8 && self.checkCurAnmEnd(0)) {
        if (self.isBckAnm(BCK_TURN1_END) || self.isBckAnm(BCK_TURN2_END)) self.setBckAnm(BCK_WAIT);
        else if (self.isBckAnm(BCK_WAIT)) { spine.pushAfterCurrent(AmiNokoNerves.walkOnFence); return true; }
        else self.setBckAnm(self.unk210 !== 0 ? BCK_TURN1_END : BCK_TURN2_END);
    }
    self.creepToCurPathNode(0);
    return false;
});
AmiNokoNerves.attack = nerve<AmiNoko>('TNerveAmiNokoAttack', () => false);
AmiNokoNerves.die = nerve<AmiNoko>('TNerveAmiNokoDie', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.setBckAnm(BCK_FLYING_START); self.onHitFilter(HF.NO_COLLISION); if (!V.GMSJ01) self.hit!.onHitFilter(HF.NO_COLLISION); }
    if (self.checkCurAnmEnd(0) && self.isBckAnm(BCK_FLYING_START)) {
        // (the direction away from Mario is worked out and thrown away: its up vector instead)
        const m = self.baseTR;
        const d = new V3(m[1], m[5], m[9]).normalize().scale(20);
        self.pos.y = fr(self.pos.y + 10);
        self.vel.set(d);
        self.onLiveFlag(LF.AIRBORNE);
        self.setBckAnm(BCK_FLYING_LOOP);
    }
    // (MS_KIL_SMOKE on its root matrix)
    if (self.isBckAnm(BCK_FLYING_LOOP) && spine.time > 30) {
        const d = V3.sub(self.pos, self.world.mario.pos);
        if (self.isDeadByWall() || !self.isAirborne() || d.length() > 10000) {
            self.onHitFilter(HF.NO_COLLISION);
            self.onLiveFlag(LF.DEAD); self.onLiveFlag(LF.UNK8); self.offLiveFlag(LF.HIDDEN); self.offLiveFlag(SE_LF.MELT_ON_DEATH);
            self.holder = null;
            self.stopAnmSound();
            spine.reset();
            spine.setNext(SmallEnemyNerves.die);
            spine.pushAfterCurrent(spine.default);
            self.genRandomItem();
            return true;
        }
    }
    return false;
});
AmiNokoNerves.freeze = nerve<AmiNoko>('TNerveAmiNokoFreeze', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(BCK_HIT);   // (MS_DNK_SHIBIRE_B)
    if (self.checkCurAnmEnd(0)) {
        if (self.isBckAnm(BCK_HIT)) self.setBckAnm(BCK_WAIT);
        else if (spine.time > self.P.mSLFreezeWait) return true;
    }
    return false;
});
void BCK_FLYING_START;

register('AmiNokoManager', (w, n) => new AmiNokoManager(w, n));
register('AmiNoko', (w, n) => new AmiNoko(w, n));
