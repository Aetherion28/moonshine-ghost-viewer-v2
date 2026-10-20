// The baby Bloopers (TMameGesso, Enemy/mameGesso.cpp): they hop the graph (TNerveMameGessoGraph-
// JumpWander: a jump to the next node each landing), wait a while between hops, and come back
// mSLGenerateInterval frames after dying. Sprayed they're knocked down (TNerveMameGessoDamage):
// on the ground they kick about (Jitabata) and can be picked up and thrown; on the water they
// float as a little platform (TNerveMameGessoObject: two triangles of move collision on their
// back, entered each tick Mario isn't swimming) until mSLObjectRecoverTime. Hip-dropped while
// hopping they die; stepped on they're trampled.

import { fr, V3, JMASSin, JMASCos, MsMtxSetRotRPH, MsRandF, mtx } from '../math.js';
import { World, Stream, HitActor, LF, HF, MSG, ANM_BCK, CUE_MOVE, nerve, Spine, SpineEnemy, NameRef, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { BGCheckData } from '../collision.js';
import { SmallEnemyManager, SmallEnemyNerves } from './smallEnemy.js';
import { WalkerEnemy, walkerParams } from './walker.js';
import { msVecNormalize } from '../camera/lib.js';
import { marioSwimming, marioThrowPower, marioAngleY } from '../mapobj/lib.js';

/** TMameGessoSaveLoadParams */
const MAME_PARAMS = {
    mSLJumpWanderGravityY: ['f', 0.5], mSLJumpWanderSpeed: ['f', 15], mSLPickUpTime: ['i', 100], mSLThrownGravityY: ['f', 0.5],
    mSLThrownVY: ['f', 50], mSLThrownRateXZ: ['f', 0.5], mSLGenerateInterval: ['i', 300], mSLWaitTimeOnGround: ['i', 50],
    mSLWaitTimeInWater: ['i', 200], mSLObjectRecoverTime: ['i', 1000], mSLObjectScale: ['f', 2], mSLCollisionScale: ['f', 1],
    mSLReturnJumpDist: ['f', 200], mSLReturnJumpSp: ['f', 10],
} satisfies PSchema;

// BCKs (/scene/mameGesso, in the folder's order)
const BCK_FALL = 0, BCK_LAND1 = 1, BCK_LAND2 = 2, BCK_PRESS_DOWNSIDE = 3, BCK_PRESS_UPSIDE = 4, BCK_RETURN = 5, BCK_RUN1 = 6, BCK_RUN2 = 7,
    BCK_RUN_END1 = 8, BCK_RUN_END2 = 9, BCK_RUN_LOOP = 10, BCK_RUN_START1 = 11, BCK_RUN_START2 = 12, BCK_TURN = 13, BCK_WAIT1 = 14,
    BCK_WAIT2 = 15, BCK_WAIT3 = 16, BCK_WAIT4 = 17, BCK_WATER_RETURN = 18;

export class MameGessoManager extends SmallEnemyManager {
    constructor(w: World, name = 'まめゲッソーマネージャー') { super(w, name); }
    load(s: Stream) {
        this.saveParams = walkerParams('/enemy/MameGesso.prm', this.world.files, MAME_PARAMS);
        super.load(s);
    }
    /** (JDrama::TNameRef's: no goop stamp) */
    loadAfter() { NameRef.prototype.loadAfter.call(this); }
    createEnemyInstance(): SpineEnemy | null { return new MameGesso(this.world); }
    initSetEnemies() { }
    perform(cue: number) {
        if (cue & CUE_MOVE) {
            for (const o of this.objs as MameGesso[]) {
                if (o.checkLiveFlag(LF.DEAD) && o.unk1D2) {
                    o.unk1CC += 1;
                    if (o.unk1CC > o.M.mSLGenerateInterval) o.reset();
                }
            }
        }
        super.perform(cue);
    }
}

export class MameGesso extends WalkerEnemy {
    static mBaseHoseiTransY = -20;
    /** unk19C its back's four corners, unk1CC frames dead, unk1D0 hip-dropped, unk1D1 trampled (not hip-dropped), unk1D2 placed in the scene */
    unk19C = [new V3(), new V3(), new V3(), new V3()];
    unk1CC = 0; unk1D0 = 0; unk1D1 = 0; unk1D2 = 0;
    /** unk1D4 where it was placed, unk1E0 / unk1E8 how it bobs and floats, unk1E4 the water's height, unk1EC hopping to its graph node (0: back towards it) */
    unk1D4 = new V3(); unk1E0 = 0; unk1E4 = 0; unk1E8 = 0; unk1EC = 1;
    /** TMapCollisionMove(2): its back while it floats */
    tris = [new BGCheckData(), new BGCheckData()];
    get M(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'まめゲッソー') { super(w, name); }
    load(s: Stream) {
        SpineEnemy.prototype.load.call(this, s);
        this.unk1D2 = 1;
        this.reset();
    }
    init(m: any) {
        super.init(m);
        this.actorType = AT.MAME_GESSO;
        this.unk150 = 0x11;
        this.spine!.initWith(MameNerves.jumpWander);
        this.onHitFilter(HF.NO_COLLISION);
        this.unk1D4.set(this.pos);
    }
    moveObject() {
        super.moveObject();
        if (this.spine!.current === MameNerves.object) this.pos.y = fr(this.unk1E4 - this.unk1E8);
    }
    setMActorAndKeeper() { this.mactor = this.createMActorByName('default.bmd'); }
    attackToMario() {
        if (this.unk164 !== 0) return;
        if (this.spine!.current !== MameNerves.object) this.world.mario.receiveMessage(this, MSG.ATTACK);
    }
    calcRootMatrix() {
        if (this.spine!.current === MameNerves.object) {
            if (this.isEaten()) return;
            const m = this.baseTR;
            MsMtxSetRotRPH(m, this.rot.x, this.rot.y, this.rot.z);
            m[3] = this.pos.x; m[7] = fr(fr(this.pos.y + this.unk1E0) + this.unk1E8); m[11] = this.pos.z;
        } else super.calcRootMatrix();
    }
    reset() {
        super.reset();
        const M = this.M;
        this.unk1CC = M ? rangeRandI(0, M.mSLGenerateInterval) : 0;
        this.unk1D0 = 0; this.unk1E8 = 0; this.unk1EC = 1;
        this.pos.set(this.unk1D4);
        this.pos.y = fr(this.pos.y + 20);
    }
    isEatenByYosshi() { return false; }
    changeByJuice() { return false; }
    forceKill() { }
    isHitValid(msg: number) {
        this.unk1D1 = msg === MSG.HIP_DROP ? 0 : 1;
        if (this.spine!.current === MameNerves.jumpWander && msg === MSG.HIP_DROP) {
            this.unk1D0 = 1;
            this.spine!.pushNerve(SmallEnemyNerves.die);
            return false;
        }
        return true;
    }
    kill() {
        const s = this.spine!;
        if (this.unk184 && s.current === MameNerves.jumpWander) s.pushNerve(SmallEnemyNerves.die);
        if (s.current === MameNerves.jumpWander || s.current === MameNerves.wait) { s.pushNerve(MameNerves.damage); s.pushNerve(MameNerves.trample); }
        if (s.current === MameNerves.jitabata) s.pushNerve(MameNerves.trample);
    }
    getGravityY() {
        const c = this.spine!.current;
        let g = this.gravity;
        if (c === MameNerves.object) g = this.M.mSLJumpWanderGravityY;
        if (c === MameNerves.thrown) g = this.M.mSLThrownGravityY;
        return g;
    }
    setWaitAnm() { this.setBckAnm(!this.groundPlane.isWaterSurface() ? BCK_WAIT1 : BCK_WAIT4); this.headHeight = 150; }
    setFreezeAnm() { this.unk164 = 1; this.setBckAnm(BCK_WAIT2); }
    setDeadAnm() { this.unk164 = 1; }
    behaveToWater(_a: HitActor) {
        const c = this.spine!.current;
        if (c !== MameNerves.jumpWander && c !== MameNerves.wait) return;
        this.spine!.pushNerve(MameNerves.damage);
    }
    behaveToTaken(_a: HitActor) { if (this.spine!.current !== MameNerves.pickUp) this.spine!.pushNerve(MameNerves.pickUp); }
    behaveToRelease() { if (this.unk164 !== 0 && this.spine!.current !== MameNerves.thrown) this.spine!.pushNerve(MameNerves.thrown); }
    isCollidMove(_a: HitActor) { return !(this.spine!.current === MameNerves.jumpWander && !this.isAirborne()); }
    isInhibitedForceMove() { return true; }
    doKeepDistance() { return this.isBckAnm(BCK_WAIT3); }
    calcObjCollision() {
        this.headHeight = 50;
        const k = fr(fr(this.M.mSLCollisionScale * this.attackRadius) * this.bodyScale);
        const m = this.mactor ? this.mactor.anmMtx(1, this.baseTR, this.scale) : null;
        const p = m ? new V3(m[12], m[13], m[14]) : this.pos.clone();
        const xz = [1, -1, 1, 1, -1, 1, -1, -1];
        for (let i = 0; i < 4; i++) {
            const c = this.unk19C[i];
            c.set(p);
            c.y = fr(c.y + 90);
            c.x = fr(c.x + fr(k * xz[i * 2]));
            c.z = fr(c.z + fr(k * xz[i * 2 + 1]));
        }
    }
    /** setVertexData(0 / 1): into the move grid (TMap::perform empties it every tick) */
    entryObjCollision() {
        const c = this.unk19C, v = (p: V3) => [p.x, p.y, p.z];
        const set = (d: BGCheckData, a: V3, b: V3, e: V3) => { d.bgType = 0; d.data = 0; d.actor = null; d.setVertex(v(a), v(b), v(e)); this.world.col.add(d, 'move'); };
        set(this.tris[0], c[2], c[1], c[0]);
        set(this.tris[1], c[0], c[3], c[2]);
    }
}

/** TMsRange<s32>::rand */
const rangeRandI = (lo: number, hi: number) => lo + Math.trunc(fr((hi - lo) * MsRandF()));

type S = Spine<MameGesso>;
export const MameNerves: Record<string, any> = {};
MameNerves.jumpWander = nerve<MameGesso>('TNerveMameGessoGraphJumpWander', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(self.groundPlane.isWaterSurface() ? BCK_RUN_START2 : BCK_RUN_START1);
    if (self.isBckAnm(BCK_RUN_START1) || self.isBckAnm(BCK_RUN_START2)) {
        if (self.checkCurAnmEnd(ANM_BCK)) self.setBckAnm(BCK_RUN_LOOP);
        if (!self.isAirborne() && self.getCurAnmFrameNo(ANM_BCK) > 26) {
            if (self.groundPlane.isWaterSurface()) self.generateEffectColumWater();
            if (self.unk1EC) {
                self.goToShortestNextGraphNode();
                const v = self.calcVelocityToJumpToY(self.goal104.point(), self.M.mSLJumpWanderSpeed, self.getGravityY());
                self.pos.y = fr(self.pos.y + 10);
                self.vel.set(v);
                self.onLiveFlag(LF.AIRBORNE);
            } else {
                const g = self.goal104.point();
                const d = new V3(fr(g.x - self.pos.x), 0, fr(g.z - self.pos.z));
                if (d.x === 0 && d.y === 0 && d.z === 0) d.x += 1;
                msVecNormalize(d, d);
                const dist = self.M.mSLReturnJumpDist, sp = self.M.mSLReturnJumpSp;
                d.x = fr(d.x * dist + self.pos.x); d.z = fr(d.z * dist + self.pos.z); d.y = self.pos.y;
                const v = self.calcVelocityToJumpToY(d, sp, self.getGravityY());
                self.pos.y = fr(self.pos.y + 2);
                self.vel.set(v);
                self.onLiveFlag(LF.AIRBORNE);
            }
        }
    }
    if (self.unk1EC !== 0) {
        if (!self.isReachedToGoal() || self.isAirborne()) self.walkBehavior(!self.isAirborne() ? 2 : 3, 1);
    } else {
        if (self.isReachedToGoal()) self.unk1EC = 1;
        if (self.checkLiveFlag(LF.CLIPPED_OUT)) { self.onLiveFlag(LF.UNK20000); spine.setNext(SmallEnemyNerves.die); }
        self.walkBehavior(3, 1);
    }
    if (!self.isAirborne()) {
        if (self.isBckAnm(BCK_RUN_LOOP)) {
            if (self.groundPlane.isWaterSurface()) { self.setBckAnm(BCK_RUN_END2); self.generateEffectColumWater(); }
            else self.setBckAnm(BCK_RUN_END1);
        } else if (self.checkCurAnmEnd(ANM_BCK)) { spine.pushAfterCurrent(MameNerves.wait); return true; }
    }
    return false;
});
MameNerves.damage = nerve<MameGesso>('TNerveMameGessoDamage', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.vel.x = 0; self.vel.z = 0; self.setBckAnm(BCK_TURN); }
    if (!self.isAirborne() && self.groundPlane.isWaterSurface()) { spine.pushAfterCurrent(MameNerves.object); return true; }
    if (self.checkCurAnmEnd(ANM_BCK)) {
        if (self.isBckAnm(BCK_TURN) && self.isAirborne()) self.setBckAnm(BCK_FALL);
        if (!self.isAirborne()) { spine.pushAfterCurrent(self.groundPlane.isWaterSurface() ? MameNerves.object : MameNerves.jitabata); return true; }
    }
    return false;
});
MameNerves.jitabata = nerve<MameGesso>('TNerveMameGessoJitabata', (spine: S) => {
    const self = spine.body;
    if (spine.time <= 2) self.setFreezeAnm();
    else if (self.checkCurAnmEnd(ANM_BCK)) {
        if (self.isBckAnm(BCK_WAIT2)) { if (spine.time > self.M.mSLFreezeWait) self.setBckAnm(BCK_RETURN); }
        else if (self.isBckAnm(BCK_RETURN)) {
            if (V3.sub(self.goal104.point(), self.pos).length() > 300) self.unk1EC = 0;
            spine.pushAfterCurrent(MameNerves.wait);
            self.unk164 = 0;
            return true;
        }
    }
    return false;
});
MameNerves.trample = nerve<MameGesso>('TNerveMameGessoTrample', (spine: S) => {
    const self = spine.body;
    if (spine.time < 1) {
        if (self.unk1D1 !== 0) self.setBckAnm(self.isBckAnm(BCK_WAIT2) ? BCK_PRESS_DOWNSIDE : BCK_TURN);
        else self.setBckAnm(self.isBckAnm(BCK_WAIT2) ? BCK_PRESS_DOWNSIDE : BCK_PRESS_UPSIDE);
    } else if (self.checkCurAnmEnd(ANM_BCK)) return true;
    return false;
});
MameNerves.pickUp = nerve<MameGesso>('TNerveMameGessoPickUp', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0 && self.unk164 === 0) return true;
    if (self.checkCurAnmEnd(ANM_BCK) && spine.time > self.M.mSLPickUpTime) { self.unk164 = 0; self.attackToMario(); return true; }
    return false;
});
MameNerves.thrown = nerve<MameGesso>('TNerveMameGessoThrown', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        const M = self.M, w = self.world;
        const power = marioThrowPower(w), rate = M.mSLThrownRateXZ, a = marioAngleY(w);
        const c = JMASCos(a), s = JMASSin(a);
        self.vel.set(fr(rate * fr(power * s)), M.mSLThrownVY, fr(rate * fr(power * c)));
        self.pos.y = fr(self.pos.y + 2);
        self.onLiveFlag(LF.AIRBORNE);
    }
    if (!self.isAirborne()) {
        if (self.groundPlane.isWaterSurface()) { spine.pushAfterCurrent(MameNerves.object); self.unk164 = 0; return true; }
        if (!self.isBckAnm(BCK_LAND1)) self.setBckAnm(BCK_LAND1);
        if (self.checkCurAnmEnd(ANM_BCK) && self.isBckAnm(BCK_LAND1)) { self.unk164 = 0; return true; }
    }
    return false;
});
MameNerves.object = nerve<MameGesso>('TNerveMameGessoObject', (spine: S) => {
    const self = spine.body, swim = marioSwimming(self.world);
    if (swim) { self.offHitFilter(HF.NO_COLLISION); self.unk190 = fr(self.unk154 * 2.5); self.expandCollision(); }
    else self.onHitFilter(HF.NO_COLLISION);
    if (spine.time === 0) {
        self.setBckAnm(BCK_LAND2);
        self.onHitFilter(HF.NO_COLLISION);
        self.calcObjCollision(); self.entryObjCollision();
        self.generateEffectColumWater();
        self.unk1E0 = 0; self.unk1E4 = self.groundHeight; self.unk1E8 = 80;
    }
    if (self.checkCurAnmEnd(ANM_BCK) && self.isBckAnm(BCK_LAND2)) self.setBckAnm(BCK_WAIT3);
    if (spine.time > self.M.mSLObjectRecoverTime) {
        if (self.checkCurAnmEnd(ANM_BCK)) {
            if (self.isBckAnm(BCK_WAIT3)) self.setBckAnm(BCK_WATER_RETURN);
            else if (self.isBckAnm(BCK_WATER_RETURN)) {
                self.calcObjCollision(); self.entryObjCollision();
                self.offHitFilter(HF.NO_COLLISION);
                self.pos.y = self.unk1E4; self.unk1E8 = 0;
                spine.pushAfterCurrent(MameNerves.wait);
                return true;
            }
        }
        if (self.unk1E0 < 0) self.unk1E0 = fr(self.unk1E0 + 1);
    } else if (self.unk1E0 > MameGesso.mBaseHoseiTransY) self.unk1E0 = fr(self.unk1E0 - 1);
    if (!swim) { self.calcObjCollision(); self.entryObjCollision(); }
    return false;
});
MameNerves.wait = nerve<MameGesso>('TNerveMameGessoWait', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setWaitAnm();
    if (self.checkCurAnmEnd(ANM_BCK)) {
        const wait = self.groundPlane.isWaterSurface() ? self.M.mSLWaitTimeInWater : self.M.mSLWaitTimeOnGround;
        if (spine.time > wait + self.instanceIndex * 10) { spine.pushAfterCurrent(MameNerves.jumpWander); return true; }
    }
    return false;
});

register('MameGessoManager', (w, n) => new MameGessoManager(w, n));
register('MameGesso', (w, n) => new MameGesso(w, n));
export { mtx };
