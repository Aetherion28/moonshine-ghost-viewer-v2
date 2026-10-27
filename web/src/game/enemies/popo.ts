// TPopo / TPopoManager (Enemy/popo.cpp): the Swoopin' Stu-like goop blobs that hop along the
// graph (each hop a jump of mSLMoveDist), hop at Mario when they see him (he has FLUDD's spray
// nozzle and no other blob is on it), and stick to the nozzle when they touch him. Stuck on, the
// pump's pressure swells them (mSLPumpRate), and when Mario lets go they fly off the nozzle
// spraying water (popowater.prm) until they hit the ground or a wall, or mSLFlyLimitTime runs
// out, and burst (popoexpwater.prm). Stomping one bursts it too. TPopoCollision is the blob's
// second hit area at its centre joint (for its hits on Mario and enemies).

import { fr, V3, MsWrap, MsGetRotFromZaxisY, MsMtxSetRotRPH, mtx, Mtx } from '../math.js';
import { World, PathNode, LF, HF, HC, MSG, nerve, Spine, Stream, ANM_BCK, ANM_BTP, ANM_BRK, ANM_FRAME_RATE, HitActor, LiveManager } from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemyManager, SmallEnemyNerves, LIVE_FLAG_MELT_ON_DEATH, rangeRand } from './smallEnemy.js';
import { WalkerEnemy, WalkerNerves, walkerParams } from './walker.js';
import { emitInfo, EmitInfo } from '../water.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import { holdKey } from '../sound.js';
import type { WallCheck } from '../collision.js';

/** TPopoSaveLoadParams */
const POPO_PARAMS = {
    mSLMoveDist: ['f', 100], mSLMoveGravity: ['f', 0.1], mSLMoveJumpSp: ['f', 10], mSLAttackDist: ['f', 100], mSLAttackGravity: ['f', 0.1],
    mSLAttackJumpSp: ['f', 10], mSLReleaseSpeed: ['f', 10], mSLFlyGravity: ['f', 0], mSLFlyLimitTime: ['i', 300], mSLExplosionEmitTime: ['i', 60],
    mSLWaterScaleMax: ['f', 2], mSLThrownGravity: ['f', 0.5], mSLPumpRate: ['f', 0.0001], mSLLevelLimit: ['f', 1.2], mSLScaleRate: ['f', 0.99],
} as const;

// TPopo's statics
const mRollSw = 1, mTriggerSw = 1, mTestAng_x = 90, mTestAng_y = 90, mTestAng_z = 0, mNozzleOffsetZ = -15;
const mCenterJntIndex = 1, mMouthJntIndex = 2;
const mTestBodyScale = 35, mBrkFlag = 1, mColOffsetY = 20, mColMinVal = 0.6, mLevelShootSw = 1, mExplosionSw = 0;

/**
 * SMS_GetMarioWaterGun()->getEmitMtx(0): the nozzle's emit matrix, its X axis the spray's
 * direction. (Not in the ghost: made from its FLUDD record's direction and emit offset, or
 * Mario's facing without one.)
 */
export function emitMtx(w: World): Mtx {
    const m = w.mario, f = m.fludd;
    const yaw = f ? f.yaw : (m.rot.y * Math.PI) / 180, pitch = f ? f.pitch : 0;
    const cp = Math.cos(pitch);
    const x = new V3(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
    const z = new V3().cross(x, new V3(0, 1, 0)).normalize();
    const y = new V3().cross(z, x).normalize();
    const off = f ? f.offset : [0, 100, 0];
    const r = mtx();
    r[0] = x.x; r[4] = x.y; r[8] = x.z;
    r[1] = y.x; r[5] = y.y; r[9] = y.z;
    r[2] = z.x; r[6] = z.y; r[10] = z.z;
    r[3] = m.pos.x + off[0]; r[7] = m.pos.y + off[1]; r[11] = m.pos.z + off[2];
    return r;
}
/** mGamePad->mCompSPos[3] (R's analog pressure, 0..255): from the ghost's spray power (not recorded itself). */
export function pumpPressure(w: World) {
    const f = w.mario.fludd;
    if (!f || !f.spraying || f.nozzle !== 0 || !w.fludd) return 0;
    const N: any = w.fludd.nozzles[0];
    const span = N.mEmitPow - N.mEmitPowMin;
    const u = Math.max(0, Math.min(1, span ? (f.power - N.mEmitPowMin) / span : 1));
    return Math.max(21, Math.round(u * 150));
}
function mtxMul(a: Mtx, b: Mtx, out: Mtx = mtx()) {
    const r = new Float64Array(12);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) {
        let s = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j];
        if (j === 3) s += a[i * 4 + 3];
        r[i * 4 + j] = s;
    }
    out.set(r);
    return out;
}
const translation = (x: number, y: number, z: number) => { const m = mtx(); m[3] = x; m[7] = y; m[11] = z; return m; };

export class PopoManager extends SmallEnemyManager {
    unk60 = 1;
    unk64: EmitInfo | null = null; unk68: EmitInfo | null = null;
    constructor(w: World, name = 'ポポマネージャー') { super(w, name); this.unk5C = 0; }
    load(s: Stream) {
        super.load(s);
        const f = this.world.files;
        this.saveParams = walkerParams('/enemy/popo.prm', f, POPO_PARAMS as any);
        this.unk64 = emitInfo('/enemy/popowater.prm', f);
        this.unk68 = emitInfo('/enemy/popoexpwater.prm', f);
    }
    createEnemyInstance() { return new Popo(this.world); }
    createModelData() { this.createModelDataArray(['popoH.bmd', 'popoL.bmd']); }
    perform(cue: number) {
        if (cue & 1) for (let i = 0; i < this.getActiveObjNum(); i++) {
            const p = this.objs[i] as Popo;
            if (p.unk1A4 && p.checkLiveFlag(LF.DEAD)) p.reset();
        }
        super.perform(cue);
    }
}

/** TPopoCollision */
export class PopoCollision extends HitActor {
    unk68!: Popo;
    constructor(name = 'ポポコリジョン') { super(name); }
    receiveMessage(sender: HitActor, msg: number) { return this.unk68.isRollJump() ? this.unk68.receiveMessage(sender, msg) : false; }
    checkHit() {
        for (const o of this.collisions.slice()) {
            if (o.isActorType(AT.MARIO)) this.unk68.attackToMario();
            else this.unk68.behaveToHitOthers(o);
        }
    }
    kill() { this.onHitFilter(HF.NO_COLLISION); }
}

export class Popo extends WalkerEnemy {
    unk194: any = null;
    /** how swollen (1: normal, mSLWaterScaleMax at most) */
    unk198 = 1;
    /** flying ticks */
    unk19C = 0;
    unk1A0 = 30;
    /** placed in scene.bin (waits at its place, comes back when dead) */
    unk1A4 = 0;
    unk1A8 = new V3();
    /** on the nozzle */
    unk1B4 = 0;
    /** roll angle */
    unk1B8 = 0;
    /** being pumped this tick */
    unk1BC = 0;
    unk1C0 = new V3();
    unk1CC = 0; unk1CD = 0;
    unk230 = new V3();
    unk23C!: PopoCollision;
    mactorH: any = null; mactorL: any = null;
    constructor(w: World, name = 'ポポ') { super(w, name); }
    get PP(): any { return this.unk194; }
    load(s: Stream) {
        super.load(s);
        this.unk1A8.set(this.pos);
        this.unk1A4 = 1;
        this.reset();
    }
    init(m: LiveManager | null) {
        super.init(m);
        this.actorType = AT.POPO;
        this.unk150 = 0x11;
        this.unk194 = this.getSaveParam();
        this.spine!.initWith(PopoNerves.graphWander);
        this.onHitFilter(HC.BOSS);
        // (the joint callbacks: the roll, the swelling and the limbs' scale, only drawn)
        this.unk188 = 0;
        this.unk23C = new PopoCollision();
        this.world.addToGroup('敵グループ', this.unk23C);
        this.unk23C.initHitActor(AT.POPO, 2, HC.PLAYER | HC.ENEMY | HC.BOSS, 80, 80, 80, 80);
        this.unk23C.kill();
        this.unk23C.unk68 = this;
    }
    perform(cue: number) {
        super.perform(cue);
        this.unk23C.perform(cue);
    }
    setMActorAndKeeper() {
        this.mactorH = this.createMActorByName('popoH.bmd');
        this.mactorL = this.createMActorByName('popoL.bmd');
        this.mactor = this.mactorH;
    }
    reset() {
        super.reset();
        this.unk165 = false;
        this.unk1B4 = 0;
        this.unk198 = 1;
        this.unk1B8 = 0;
        this.unk19C = 0;
        this.scaledBodyRadius = fr(15 * this.getBodyRadius());
        this.unk190 = 0.2;
        this.expandCollision();
        if (this.mactorL) this.mactor = this.mactorL;
        if (this.unk1A4) {
            this.onLiveFlag(LF.UNK10);
            this.spine!.initWith(PopoNerves.wait);
            this.pos.set(this.unk1A8);
            this.offLiveFlag(LF.UNK800);
        }
        if (this.unk23C) this.unk23C.kill();
        this.unk18C = 0;
    }
    checkTrigger() {
        const w = this.world, m = w.mario, P = this.PP;
        this.unk1BC = 0;
        if (m.onYoshi || (m.fludd ? m.fludd.nozzle : 0) !== 0) { this.kill(); return false; }
        m.receiveMessage(this, MSG.ATTACH);
        const maxScale = P.mSLWaterScaleMax;
        const pressure = pumpPressure(w);
        if (pressure > 20) {
            this.unk1BC = 1;
            w.sound(SE.EN_POPO_GROW, this.pos, { pitch: this.unk198 });
            this.sprayCooldown = 0;
            this.unk165 = true;
            this.unk198 = fr(this.unk198 + fr(pressure * P.mSLPumpRate));
            if (this.unk198 > maxScale) {
                this.unk198 = maxScale;
                if (!mBrkFlag) this.mactor!.setFrameRate(ANM_FRAME_RATE, ANM_BRK);
            }
            if (mBrkFlag) { const c = this.mactor!.getFrameCtrl(ANM_BRK); if (c) c.frame = fr((this.unk1A0 * this.unk198) / P.mSLWaterScaleMax); }
        }
        // (MEANING_R: R pressed: taken as spraying)
        const R = !!(m.fludd && m.fludd.spraying);
        if (R || !mTriggerSw) {
            if (mLevelShootSw) this.unk1CC = 1;
            else if (this.unk198 >= maxScale) this.unk1CC = 1;
        }
        if (mLevelShootSw && this.unk198 < maxScale - 0.1 && this.unk198 > 1) this.unk198 = fr(this.unk198 * P.mSLScaleRate);
        if (pressure < 20 && (this.unk1CC || this.unk198 > P.mSLLevelLimit)) {
            w.sound(SE.EN_POPO_POP, this.pos);
            w.effect('popoPop', this.pos);
            this.onHitFilter(HF.NO_COLLISION);
            this.unk23C.offHitFilter(HF.NO_COLLISION);
            return true;
        }
        this.scaledBodyRadius = fr((8 * this.unk198 + 8) * this.getBodyRadius());
        if (this.unk198 >= maxScale) { const c = this.mactor!.getFrameCtrl(ANM_BTP); if (c) c.frame = 5; }
        return false;
    }
    behaveToWater(_a: HitActor) {
        const c = this.spine!.current;
        if (c === PopoNerves.fly || c === PopoNerves.explosion || c === SmallEnemyNerves.die) return;
        if (c === PopoNerves.possessedNozzle) { this.sprayCooldown = 0; return; }
        if (this.isAirborne()) {
            const mp = this.world.mario.pos;
            const d = new V3(this.pos.x - mp.x, 0, this.pos.z - mp.z).normalize().scale(12);
            d.y = -1;
            d.add(this.vel);
            this.vel.set(d);
        } else if (c !== SmallEnemyNerves.freeze) this.spine!.pushNerve(SmallEnemyNerves.freeze);
    }
    getGravityY() {
        const c = this.spine!.current, P = this.PP;
        if (c === WalkerNerves.graphWander || c === WalkerNerves.escape || c === WalkerNerves.attack) return P.mSLMoveGravity;
        if (c === PopoNerves.attack) return P.mSLAttackGravity;
        if (c === PopoNerves.fly) return P.mSLFlyGravity;
        if (c === PopoNerves.thrown) return P.mSLThrownGravity;
        return this.gravity;
    }
    behaveToFindMario() {
        const m = this.world.mario, man = this.manager as PopoManager;
        if (m.checkFlag(0x8000) && man.unk60 && (m.fludd ? m.fludd.nozzle : 0) === 0 && !m.onYoshi) {
            this.setGoalPath(new PathNode(m));
            this.spine!.pushAfterCurrent(WalkerNerves.graphWander);
            this.spine!.pushAfterCurrent(PopoNerves.attack);
        } else this.spine!.pushAfterCurrent(WalkerNerves.graphWander);
    }
    walkBehavior(_kind: number, _k: number) {
        const P = this.PP, s = this.spine!;
        if (!this.isAirborne()) {
            const gp = this.goal104.point();
            const goal = new V3(gp.x - this.pos.x, 0, gp.z - this.pos.z);
            if (goal.x === 0 && goal.y === 0 && goal.z === 0) goal.x += 1;
            goal.normalize();
            let dist = P.mSLMoveDist, speed = P.mSLMoveJumpSp, rs = 1;
            if (s.current === PopoNerves.attack) { speed = P.mSLAttackJumpSp; dist = P.mSLAttackDist; rs = 10; this.setBckAnm(0); }
            goal.x = fr(this.pos.x + fr(goal.x * dist) + fr(rs * rangeRand(-20, 20)));
            goal.z = fr(this.pos.z + fr(goal.z * dist) + fr(rs * rangeRand(-20, 20)));
            goal.y = this.pos.y;
            let js = 1;
            if (s.current === WalkerNerves.escape) { js = 1.2; this.setBckAnm(5); }
            this.vel.set(this.calcVelocityToJumpToY(goal, fr(speed * js), this.getGravityY()));
            this.pos.y = fr(this.pos.y + 2);
            this.onLiveFlag(LF.AIRBORNE);
            if (s.current === WalkerNerves.graphWander) { this.setGoalPath(new PathNode(null, goal)); this.setBckAnm(5); }
        } else {
            if (this.vel.y > 1.5) this.pos.y = fr(this.pos.y + 0.5 * this.vel.y);
            if (this.vel.y < -1) this.pos.y = fr(this.pos.y + 0.2 * this.vel.y);
        }
        this.unk1B8 += 1;
        if (s.current === PopoNerves.attack) this.unk1B8 += 2;
        if (this.unk1B8 > 360) this.unk1B8 -= 360;
        if (!mRollSw) this.unk1B8 = 0;
        if (this.vel.y > 0) this.walkToCurPathNode(0, this.turnSpeed, 0);
    }
    attackToMario() {
        const c = this.spine!.current, man = this.manager as PopoManager;
        if ((c === PopoNerves.attack || c === PopoNerves.wait) && man.unk60) this.spine!.pushNerve(PopoNerves.possessedNozzle);
        else if (c === WalkerNerves.escape || c === WalkerNerves.graphWander) {
            this.sendAttackMsgToMario();
            const mp = this.world.mario.pos;
            const d = new V3(this.pos.x - mp.x, this.pos.y - mp.y, this.pos.z - mp.z).normalize();
            this.vel.x = d.x; this.vel.z = d.z;
            d.scale(this.getBodyRadius());
            this.posDelta.set(d);
        }
    }
    calcRootMatrix() {
        const cm = this.mactor ? this.mactor.anmMtx(mCenterJntIndex, this.baseTR, this.scale) : null;
        if (cm) this.unk23C.pos.set(cm[12], cm[13], cm[14]); else this.unk23C.pos.set(this.pos);
        if (this.unk1B4) {
            const P = this.PP;
            this.unk190 = fr((0.8 * this.unk198) / P.mSLWaterScaleMax);
            if (this.unk190 < mColMinVal) this.unk190 = mColMinVal;
            this.expandCollision();
            let m: Mtx;
            if (this.spine!.current === PopoNerves.fly) m = translation(this.pos.x, this.pos.y, this.pos.z);
            else {
                m = emitMtx(this.world);   // (orthonormal: the game's normalising of it does nothing)
                mtxMul(m, translation(7 * this.unk198 + mNozzleOffsetZ, 0, 0), m);
                const body = mtxMul(m, translation(mTestBodyScale * this.unk198, 0, 0));
                this.pos.set(fr(body[3]), fr(body[7] - mColOffsetY * this.unk198), fr(body[11]));
                if (this.unk1BC) this.world.effect('popoShuwa', new V3(body[3], body[7], body[11]));
            }
            const r = mtx();
            MsMtxSetRotRPH(r, mTestAng_x, mTestAng_y, mTestAng_z);
            mtxMul(m, r, m);
            this.baseTR.set(m);
        } else super.calcRootMatrix();
    }
    kill() { this.releaseNozzle(); super.kill(); }
    forceKill() {
        const g = this.groundPlane;
        if (!(g.isIllegal() || (!g.isDeathPlane() && !g.isPool() && !g.isWaterSurface()) || this.isAirborne() || this.checkLiveFlag(LF.UNK10)) || !this.world.isInArea(this.pos.x, this.pos.z)) {
            if (this.spine!.current !== PopoNerves.explosion) {
                this.spine!.reset();
                this.spine!.setNext(PopoNerves.explosion);
                this.spine!.pushAfterCurrent(this.spine!.default!);
                this.onLiveFlag(LF.UNK20000);
                this.hitPoints = 1;
            }
        }
    }
    bind() {
        this.unk23C.checkHit();
        if (this.checkLiveFlag(LF.UNK10)) return;
        const c = this.spine!.current;
        if ((c === PopoNerves.possessedNozzle && this.unk198 > 1.2 && mExplosionSw) || c === PopoNerves.fly) {
            const [h, d] = this.world.checkGround(this.pos.x, this.pos.y + this.headHeight, this.pos.z);
            this.groundHeight = h; this.groundPlane = d;
            if (this.pos.y <= this.groundHeight + 30 || (Math.abs(this.vel.x) < 1 && Math.abs(this.vel.z) < 1)) this.spine!.pushNerve(PopoNerves.explosion);
            const r: WallCheck = { center: [this.pos.x, this.pos.y, this.pos.z], radius: this.unk198 * this.wallRadius, maxResults: 1, flags: 0, results: [] };
            if (this.world.isTouchedWallsAndMoveXZ(r)) this.spine!.pushNerve(PopoNerves.explosion);
            else if (this.spine!.current === PopoNerves.fly) super.bind();
        } else super.bind();
    }
    isHitValid(msg: number) {
        if (msg === MSG.UNKB) return true;
        if (msg === MSG.TRAMPLE || msg === MSG.HIP_DROP) this.spine!.pushNerve(PopoNerves.explosion);
        return false;
    }
    isRollJump() { return this.spine!.current !== PopoNerves.fly; }
    isUseScaleCallBack() { const c = this.spine!.current; return c === PopoNerves.fly || c === PopoNerves.explosion || !!this.unk1B4; }
    isFindMario(k: number) {
        const m = this.world.mario;
        if (this.spine!.time > 100 && !m.checkFlag(0x2)) {
            const P = this.P;
            if (this.isInSight(m.pos.clone(), P.mSLSearchLength * k, P.mSLSearchAngle * k, P.mSLSearchAware * k)) return true;
        }
        return false;
    }
    isCollidMove(a: HitActor) {
        if (this.spine!.current === PopoNerves.fly && a.receiveMessage(this, MSG.TRAMPLE)) this.spine!.pushNerve(PopoNerves.explosion);
        return false;
    }
    releaseNozzle() { if (this.unk1B4) { (this.manager as PopoManager).unk60 = 1; this.unk1B4 = 0; } }
    flyBehavior() {
        const P = this.PP;
        this.unk19C++;
        if (this.unk19C > P.mSLFlyLimitTime) { this.unk19C = 0; this.spine!.pushNerve(PopoNerves.explosion); }
        if (this.unk198 > 1) this.unk198 = fr(this.unk198 * 0.999);
        let p = this.pos.clone();
        if (!this.checkLiveFlag(LF.CLIPPED_OUT) && this.mactor) {
            const m = this.mactor.anmMtx(mMouthJntIndex, this.baseTR, this.scale);
            if (m) p = new V3(m[12], m[13], m[14]);
        }
        const man = this.manager as PopoManager;
        if (man.unk64 && this.world.water) { man.unk64.pos = [p.x, p.y, p.z]; this.world.water.emitRequest(man.unk64); }
        this.world.sound(SE.EN_POPO_FLY, this.pos, { hold: holdKey(this, 'fly') });
    }
    explosion() {
        if (this.unk198 > 1) this.unk198 = fr(this.unk198 * 0.9);
        const man = this.manager as PopoManager, I = man.unk68;
        if (!I || !this.world.water) return;
        const p = this.pos.clone(); p.y += 100;
        // (the game flips the shared emit info's direction, and shrinks its count, for good)
        if (this.spine!.time % 2 === 0) I.dir = [I.dir[0], -I.dir[1], I.dir[2]];
        let num = fr(I.num * (this.unk198 / this.PP.mSLWaterScaleMax));
        if (num < 2) num = 2;
        I.num = Math.trunc(num);
        I.pos = [p.x, p.y, p.z];
        this.world.water.emitRequest(I);
    }
    possessedIn() {
        if (this.mactorH) this.mactor = this.mactorH;
        const a = this.mactor!;
        this.setBckAnm(3);
        a.setFromIndex(ANM_BTP, 0);
        a.setFrameRate(0, ANM_BTP);
        if (!mExplosionSw) this.onHitFilter(HF.NO_COLLISION);
        a.setFromIndex(ANM_BRK, 0);
        const c = a.getFrameCtrl(ANM_BRK); if (c) c.frame = 0;
        this.unk1A0 = 30;
        a.setFrameRate(0, ANM_BRK);
        this.offLiveFlag(LF.UNK10);
        this.unk1B8 = 90;
        this.unk1B4 = 1;
        this.world.sound(SE.EN_POPO_STUCK, this.pos);
        this.world.effect('popoStuck', this.pos);
        this.unk1CC = 0; this.unk1CD = 0;
    }
    explosionEffect() {
        const m = this.mactor ? this.mactor.anmMtx(mCenterJntIndex, this.baseTR, this.scale) : null;
        if (m) this.unk1C0.set(m[12], m[13], m[14]); else this.unk1C0.set(this.pos);
        this.world.effect('popoBomb', this.unk1C0);
    }
    thrownByChorobei() { this.spine!.initWith(PopoNerves.thrown); }
}

type S = Spine<Popo>;
export const PopoNerves: Record<string, any> = {};
PopoNerves.graphWander = WalkerNerves.graphWander;
PopoNerves.possessedNozzle = nerve<Popo>('TNervePopoPossessedNozzle', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        const man = self.manager as PopoManager;
        if (man.unk60 === 0) { spine.pushAfterCurrent(WalkerNerves.graphWander); return true; }
        man.unk60 = 0;
        self.possessedIn();
    }
    if (self.checkCurAnmEnd(ANM_BCK)) {
        if (self.unsetUnk165()) { self.setBckAnm(3); self.mactor!.setFrameRate(ANM_FRAME_RATE, ANM_BTP); }
        else { self.setBckAnm(4); const c = self.mactor!.getFrameCtrl(ANM_BTP); if (c) c.frame = 0; self.mactor!.setFrameRate(0, ANM_BTP); }
    }
    if (self.checkTrigger()) { spine.pushAfterCurrent(PopoNerves.fly); return true; }
    return false;
});
PopoNerves.attack = nerve<Popo>('TNervePopoAttack', (spine: S) => {
    const self = spine.body, m = self.world.mario;
    if (spine.time === 0) self.setGoalPath(new PathNode(m));
    if (!self.isAirborne()) {
        if ((self.manager as PopoManager).unk60 === 0) return true;
        if (m.checkFlag(0x2)) return true;
        if (Math.trunc(Math.abs(m.pos.y - self.pos.y)) > self.PW.mSLGiveUpHeight) return true;
        if (self.isResignationAttack()) return true;
    }
    self.walkBehavior(0, 1);
    return false;
});
PopoNerves.fly = nerve<Popo>('TNervePopoFly', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.setBckAnm(2);
        const m = emitMtx(self.world), P = self.PP;
        const k = fr(P.mSLReleaseSpeed * (self.unk198 / P.mSLWaterScaleMax));
        const v = new V3(fr(k * m[0]), fr(k * m[4]), fr(k * m[8]));
        self.vel.set(v);
        self.onLiveFlag(LF.AIRBORNE);
        self.releaseNozzle();
        self.rot.set(0, MsWrap(MsGetRotFromZaxisY(v), 0, 360), 0);
        if (mExplosionSw) self.offHitFilter(HF.NO_COLLISION);
    } else if (!self.isAirborne()) { spine.pushAfterCurrent(PopoNerves.explosion); return true; }
    if (spine.time > 5) { self.offHitFilter(HF.NO_COLLISION); self.unk23C.offHitFilter(HF.NO_COLLISION); }
    self.flyBehavior();
    return false;
});
PopoNerves.explosion = nerve<Popo>('TNervePopoExplosion', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.vel.set(0, 0, 0);
        self.mactor!.setFrameRate(0, ANM_BCK);
        self.releaseNozzle();
        self.onHitFilter(HF.NO_COLLISION);
        self.onLiveFlag(LF.UNK8);
        self.explosionEffect();
    }
    if (spine.time > self.PP.mSLExplosionEmitTime) {
        self.onLiveFlag(LF.DEAD); self.onLiveFlag(LF.UNK8); self.offLiveFlag(LF.HIDDEN); self.offLiveFlag(LIVE_FLAG_MELT_ON_DEATH);
        self.holder = null;
        spine.reset();
        spine.setNext(SmallEnemyNerves.die);
        spine.pushAfterCurrent(spine.default!);
        return true;
    }
    self.explosion();
    return false;
});
PopoNerves.wait = nerve<Popo>('TNervePopoWait', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.onLiveFlag(LF.UNK10); self.setBckAnm(6); self.setGoalPath(new PathNode(self.world.mario)); }
    self.walkToCurPathNode(0, self.turnSpeed, 0);
    return false;
});
PopoNerves.thrown = nerve<Popo>('TNervePopoThrown', (spine: S) => {
    const self = spine.body;
    if (spine.time > 30 && !self.isAirborne()) { spine.pushAfterCurrent(WalkerNerves.graphWander); return true; }
    return false;
});

register('PopoManager', (w, n) => new PopoManager(w, n));
register('Popo', (w, n) => new Popo(w, n));
