// TChuuHana / TChuuHanaManager (Enemy/chuuhana.cpp): the small Wigglers (チュウハナ) on Gelato
// Beach's tilting mirror panels (kohana0..2 graphs; mapobj/mamma.ts's mirrors, which tip under
// them: the mirror reads unk1B0). Each walks its panel to random goals
// (TNerveChuuHanaWalkOnPanel, setGoal / setSafeGoal), turning back when it nears the edge
// (willFall); sprayed, it's pushed off along the spray and its group gets angry (the manager's
// shared flag, unk21C: TNerveChuuHanaAttack chases Mario on its panel); a ground pound that
// bounces it high enough (checkStretchType) knocks it into TNerveChuuHanaForceJumped / a roll,
// or off the panel altogether (JumpPrepare, Fall2: it drops away and dies). Touching a rolling
// one makes it roll too. Landing on anything but its panel kills it.
//
// Not here: particles (sweat, jump), sounds, the mirror-world copy (TMirrorActor) and drawing it
// in mirrors when clipped, the body callback's roll rotation and BCK motion blending (unk194 is
// kept), TChuuHanaAseParCallback.

import { fr, V3, MsClamp, MsMtxSetRotRPH, MsMtxSetXYZRPH, mtx, mtxMultVec, MsRandF } from '../math.js';
import { World, PathNode, LF, HC, MSG, nerve, Spine, Stream, ANM_BCK, ANM_FRAME_RATE, HitActor } from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemyManager } from './smallEnemy.js';
import { WalkerEnemy, walkerParams } from './walker.js';
import { register } from '../scene.js';
import { sendToMario, marioGroundPlane } from '../mapobj/lib.js';

/** TChuuHanaSaveLoadParams */
const CHUUHANA_PARAMS = {
    mSLGetWaterPow: ['f', 1], mSLGetGroundPow: ['f', 1], mSLKeepBalanceTime: ['i', 200], mSLCheckFrame: ['i', 5],
    mSLReverseHeightS: ['f', 15], mSLStretchHeightS: ['f', 10], mSLMediumStretchHeightS: ['f', 7], mSLSmallStretchHeightS: ['f', 3],
    mSLReverseHeightM: ['f', 15], mSLStretchHeightM: ['f', 10], mSLMediumStretchHeightM: ['f', 7], mSLSmallStretchHeightM: ['f', 3],
    mSLReverseHeightL: ['f', 15], mSLStretchHeightL: ['f', 10], mSLMediumStretchHeightL: ['f', 7], mSLSmallStretchHeightL: ['f', 3],
    mSLWalkGravity: ['f', 4], mSLWaterHitGravity: ['f', 0.2], mSLJumpGravity: ['f', 0.2], mSLJumpSp: ['f', 12], mSLJumpHeight: ['f', 300],
    mSLGetWaterPow2: ['f', 1], mSLTacklePow: ['f', 100], mSLDashRate: ['f', 2], mSLAttackTimer: ['i', 300], mSLHitWaterTimer: ['i', 60],
} as const;

// TChuuHana's statics
const mCheckOnPanelTimeRoll = 20, mCheckOnPanelTime = 400, mFootJntIndex = 5;
const mNewSw = 1, mCompareHeight = 1, mAttackVersion = 1, mDamageSw = 1;
const mSmallMirrorR = 650, mMediumMirrorR = 900, mLargeMirrorR = 1100;
const velocityMinY = -40;

/** TMsRange<s32>::rand */
const rangeRandI = (lo: number, hi: number) => lo + Math.trunc(fr((hi - lo) * MsRandF()));
/** TMsRange<f32>::rand */
const rangeRandF = (lo: number, hi: number) => fr(lo + fr(fr(hi - lo) * MsRandF()));

/** A byte of the manager's (unk60..62): a group's "attack Mario" flag. */
interface Flag { v: number; }

export class ChuuHanaManager extends SmallEnemyManager {
    unk60: Flag = { v: 0 }; unk61: Flag = { v: 0 }; unk62: Flag = { v: 0 };
    constructor(w: World, name = 'チュウハナマネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.saveParams = walkerParams('/enemy/chuuhana.prm', this.world.files, CHUUHANA_PARAMS as any);
    }
    createEnemyInstance() { return new ChuuHana(this.world); }
    /** initSetEnemies: one on kohana0, two on kohana1, three on kohana2, each at a random node */
    initSetEnemies() {
        const graphlist = ['kohana0', 'kohana1', 'kohana1', 'kohana2', 'kohana2', 'kohana2'];
        for (let i = 0; i < this.capacity; i++) {
            const graph = this.world.graphByName(graphlist[i]);
            const e = this.objs[i] as ChuuHana | undefined;
            if (!e) continue;   // (the game reads past its enemies here)
            e.unk21C = i === 0 ? this.unk60 : i < 3 ? this.unk61 : this.unk62;
            const p = graph.point(rangeRandI(0, graph.count));
            e.pos.set(p);
            e.pos.y = fr(e.pos.y + 50);
            e.onLiveFlag(LF.AIRBORNE);
            e.tracer.init(graph);
            e.reset();
        }
    }
}

export class ChuuHana extends WalkerEnemy {
    unk194 = 0; unk198 = 0; unk19C = 0; unk1A0 = 0; unk1A4 = 0; unk1A8 = 0; unk1AC = 0;
    /** (always 1: the mirrors tip under the ones that have it) */
    unk1B0 = 1; unk1B1 = 0; unk1B2 = 0; unk1B8 = 0;
    unk1EC = new V3(); unk1F8 = new V3(); unk204 = new V3(); unk210 = 0; unk214 = 0; unk215 = 0;
    /** the panel it stands on */
    unk218: HitActor | null = null;
    unk21C: Flag = { v: 0 }; unk220 = 0; unk224 = 0;
    get PC(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'チュウハナ') { super(w, name); }
    init(m: any) {
        super.init(m);
        this.actorType = AT.CHUU_HANA;
        this.unk150 = 17;
        this.offHitFilter(HC.MAP_OBJECT);
        this.spine!.initWith(ChuuHanaNerves.walkOnPanel);
        this.unk130 = 1;
    }
    setMActorAndKeeper() { this.mactor = this.createMActorByName('default.bmd'); }
    reset() {
        super.reset();
        this.unk215 = 0; this.unk1A4 = 30; this.headHeight = 200;
        this.unk1F8.set(this.pos);
        this.unk19C = 0; this.unk198 = 0; this.unk1A0 = 0; this.unk224 = 0;
        this.setSafeGoal();
    }
    setBckAnm(i: number) { this.unk194 = 1; super.setBckAnm(i); }
    private awayFromMario(y: number) {
        const m = this.world.mario.pos;
        return new V3(fr(this.pos.x - m.x), y, fr(this.pos.z - m.z)).normalize();
    }
    behaveToWater(_a: HitActor) {
        this.unk165 = true;
        this.unk224 = 0;
        const s = this.spine!, c = s.current;
        if (c === ChuuHanaNerves.roll) {
            const v = this.awayFromMario(0).scale(this.PC.mSLGetWaterPow);
            this.margeVelocity(v);
            this.onLiveFlag(LF.AIRBORNE);
            this.pos.y = fr(this.pos.y + 10);
            return;
        }
        if (c === ChuuHanaNerves.walkOnPanel || c === ChuuHanaNerves.attack || c === ChuuHanaNerves.wait || (mNewSw && c === ChuuHanaNerves.stick)) {
            this.unk165 = true;
            if (mAttackVersion) this.unk21C.v = 1;
            const v = this.awayFromMario(0).scale(this.PC.mSLGetWaterPow2);
            if (!this.isAirborne()) this.pos.y = fr(this.pos.y + (mCompareHeight ? 2 : 1));
            this.vel.set(v);
            this.onLiveFlag(LF.AIRBORNE);
            if (s.current !== ChuuHanaNerves.stick) s.pushNerve(ChuuHanaNerves.stick);
            this.sprayCooldown = 0;
        } else if (!mNewSw && c === ChuuHanaNerves.keepBalance) {
            this.vel.set(this.awayFromMario(10).scale(fr(2 * this.PC.mSLGetWaterPow)));
            this.onLiveFlag(LF.AIRBORNE);
            this.pos.y = fr(this.pos.y + 20);
        }
    }
    attackToMario() {
        if (this.spine!.current !== ChuuHanaNerves.object) {
            // (mDamageSw is 1: the tackle that throws Mario off the panel (SMS_ThrowMario) is unused)
            if (mDamageSw) sendToMario(this.world, this, MSG.ATTACK);
        } else this.unk215 = 1;
    }
    moveObject() {
        super.moveObject();
        if (this.unk1A0 === 0) {
            this.unk198 = this.unk19C = this.pos.y;
            this.unk1A8 = 0;
        } else {
            this.unk1A0++;
            if (this.unk198 > this.pos.y) this.unk198 = this.pos.y;
            if (this.unk19C < this.pos.y) this.unk19C = this.pos.y;
            if (this.unk1A0 > this.PC.mSLCheckFrame) {
                const h = fr(this.unk19C - this.unk198);
                if (this.unk1A8 < h) this.unk1A8 = h;
                if (this.pos.y < this.unk19C) { this.unk1A8 = fr(this.unk1A8 / this.unk1A0); this.checkStretchType(); }
                else {
                    if (this.spine!.current === ChuuHanaNerves.keepBalance) this.setBckAnm(7);
                    this.unk1A0 = 1;
                    this.unk198 = this.unk19C = this.pos.y;
                }
            }
        }
        if (this.spine!.current === ChuuHanaNerves.roll && !this.isAirborne()) {
            const p = this.PC.mSLGetGroundPow, n = this.groundPlane.n;
            this.margeVelocity(new V3(fr(p * n[0]), 0, fr(p * n[2])));
            this.pos.y = fr(this.pos.y + 5);
            this.onLiveFlag(LF.AIRBORNE);
        }
        this.unk194 = MsClamp(fr(this.unk194 - 0.1), 0, 1);
        this.unk1EC.set(this.posDelta);
        if (!this.isAirborne() && (!this.groundPlane.actor || this.groundPlane.actor !== this.unk218)) this.kill();
    }
    isCollidMove(a: HitActor) {
        if (a.isActorType(AT.CHUU_HANA)) {
            const o = a as ChuuHana;
            if (o.isRolling()) { if (this.spine!.current === ChuuHanaNerves.walkOnPanel) this.forceRoll(); }
            else if (this.unk1B2 === 0) {
                if (this.spine!.current !== ChuuHanaNerves.attack && o.instanceIndex > this.instanceIndex) {
                    if (rangeRandI(0, 100) % 4 === 0) this.setSafeGoal();
                }
            }
        }
        return this.spine!.current !== ChuuHanaNerves.object;
    }
    isRolling() { return this.spine!.current === ChuuHanaNerves.roll; }
    forceRoll() { this.spine!.pushNerve(ChuuHanaNerves.roll); }
    calcRootMatrix() {
        const c = this.spine!.current;
        if (c === ChuuHanaNerves.jumpPrepare || c === ChuuHanaNerves.fall2) MsMtxSetXYZRPH(this.baseTR, this.pos.x, fr(this.pos.y + this.unk220), this.pos.z, this.rot.x, this.rot.y, this.rot.z);
        else super.calcRootMatrix();
    }
    bind() {
        const c = this.spine!.current;
        if (c !== ChuuHanaNerves.roll && c !== ChuuHanaNerves.fall2 && c !== ChuuHanaNerves.jumpPrepare) { super.bind(); return; }
        const next = this.pos.clone().add(this.posDelta).add(this.vel);
        this.vel.y = fr(this.vel.y - this.getGravityY());
        if (this.vel.y < velocityMinY) this.vel.y = velocityMinY;
        const [h, d] = this.world.checkGround(next.x, fr(next.y + this.headHeight), next.z);
        this.groundPlane = d; this.groundHeight = fr(h + 1);
        if (next.y <= this.groundHeight + 0.05 && !this.groundPlane.actor && this.pos.y < fr(this.unk1F8.y - 200)) {
            this.offLiveFlag(LF.AIRBORNE);
            next.y = this.groundHeight;
        } else this.onLiveFlag(LF.AIRBORNE);
        this.world.isTouchedOneWallAndMoveXZ(next, fr(next.y + this.headHeight), this.bodyRadius);
        this.posDelta.set(V3.sub(next, this.pos));
    }
    /** margeVelocity: v added to its XZ velocity, no Y */
    margeVelocity(v: V3) { const n = this.vel.clone().add(v); n.y = 0; this.vel.set(n); }
    receiveMessage(sender: HitActor, msg: number): boolean {
        const c = this.spine!.current;
        if (this.unk1A0 === 0 && (c === ChuuHanaNerves.walkOnPanel || c === ChuuHanaNerves.keepBalance) && msg === MSG.HIP_DROP) this.unk1A0 = 1;
        if (msg === MSG.SPRAYED_BY_WATER) {
            if (this.sprayCooldown === 0) { this.sprayCooldown = 1; this.behaveToWater(sender); }
            this.unk165 = true;
            this.world.effect('enemyWaterHit', sender.pos);
            return true;
        }
        return false;
    }
    setWalkAnm() {
        const first = this.currentBck < 0;
        this.setBckAnm(12);
        if (first) this.mactor!.getFrameCtrl(ANM_BCK)!.frame = fr(10 * this.instanceIndex);
    }
    kill() {
        if (this.checkLiveFlag(LF.DEAD)) return;
        this.onLiveFlag(LF.HIDDEN);
        if (this.unk218) { this.unk218.receiveMessage(this, MSG.DETACH); this.unk218 = null; }
        super.kill();
    }
    forceKill() {
        const g = this.groundPlane;
        if ((!g.isIllegal() && (g.isDeathPlane() || g.isPool() || g.isWaterSurface())) || !this.world.isInArea(this.pos.x, this.pos.z) || g.isIllegal()) this.kill();
    }
    getGravityY() {
        const c = this.spine!.current;
        if (c === ChuuHanaNerves.walkOnPanel || c === ChuuHanaNerves.keepBalance || c === ChuuHanaNerves.forceJumped) return this.PC.mSLWalkGravity;
        if (c === ChuuHanaNerves.stick) return this.PC.mSLWaterHitGravity;
        if (c === ChuuHanaNerves.fall2 || c === ChuuHanaNerves.jumpPrepare) return this.PC.mSLJumpGravity;
        return this.gravity;
    }
    checkOnPanel() {
        this.unk1A4++;
        if (this.unk1A4 > 20) {
            this.unk1A4 = 0;
            if (this.willFall(mCheckOnPanelTime)) this.unk1A4 = -100;
            if (!this.isAirborne() && !this.groundPlane.actor && fr(200 + this.pos.y) < this.unk1F8.y) this.spine!.pushNerve(ChuuHanaNerves.fall2);
        }
    }
    /** willFall: off its panel's mirror radius (setSafeGoal back) */
    willFall(t: number) {
        const i = this.instanceIndex;
        let r = mSmallMirrorR;
        if (i > 0) r = mMediumMirrorR;
        if (i > 2) r = mLargeMirrorR;
        if (t === mCheckOnPanelTimeRoll) r += 250;
        if (this.unk218) {
            if (V3.sub(this.pos, this.unk218.pos).length() > r) { this.setSafeGoal(); return true; }
        }
        this.unk1B2 = 0;
        return false;
    }
    /** setGoal: 1000 ahead, up to 30 degrees off its heading */
    setGoal() {
        const goal = this.pos.clone();
        const angle = rangeRandF(-30, 30);
        const m = mtx();
        MsMtxSetRotRPH(m, this.rot.x, fr(this.rot.y + angle), this.rot.z);
        const dir = mtxMultVec(m, new V3(0, 0, 1));
        goal.x = fr(1000 * dir.x + goal.x);
        goal.z = fr(1000 * dir.z + goal.z);
        this.setGoalPath(new PathNode(null, goal));
        this.unk1A4 = mCheckOnPanelTime;
        this.unk1B2 = 0;
    }
    /** setSafeGoal: a random node of its panel's graph */
    setSafeGoal() {
        this.unk1A4 = mCheckOnPanelTime;
        const g = this.tracer.graph!;
        this.setGoalPath(new PathNode(null, g.point(rangeRandI(0, g.count))));
        this.unk1B2 = 1;
    }
    rolling() {
        const v = this.vel;
        this.unk204.x = fr(this.unk204.x + fr(0.2 * fr(v.x - this.unk204.x)));
        this.unk204.z = fr(this.unk204.z + fr(0.2 * fr(v.z - this.unk204.z)));
        const sp = fr(Math.sqrt(this.unk204.x * this.unk204.x + this.unk204.z * this.unk204.z));
        this.unk1B8 = fr(2 * fr(sp / this.bodyRadius));
        this.unk210 = fr(this.unk210 + this.unk1B8);
        if (this.unk210 > 360) this.unk210 = fr(this.unk210 - 360);
        if (this.unk210 < 0) this.unk210 = fr(this.unk210 + 360);
    }
    rollStart() { this.unk210 = 0; this.unk204.zero(); }
    private byIndex(s: number, m: number, l: number) { const i = this.instanceIndex; let r = s; if (i > 0) r = m; if (i > 2) r = l; return r; }
    /** checkStretchType: how high the pound bounced it (unk1A8) */
    checkStretchType() {
        this.unk1A0 = 0;
        const st = this.unk1A8, P = this.PC, s = this.spine!;
        if (s.current === ChuuHanaNerves.keepBalance && st > this.byIndex(P.mSLReverseHeightS, P.mSLReverseHeightM, P.mSLReverseHeightL)) {
            this.unk1B1 = 1; this.unk214 = 1;
            s.pushNerve(ChuuHanaNerves.fall2);
            s.pushNerve(ChuuHanaNerves.jumpPrepare);
            return;
        }
        const jumped = (bck: number) => { this.unk1B1 = 0; this.unk214 = 0; this.setBckAnm(bck); s.pushNerve(ChuuHanaNerves.forceJumped); };
        if (st > this.byIndex(P.mSLStretchHeightS, P.mSLStretchHeightM, P.mSLStretchHeightL)) { jumped(8); return; }
        if (st > this.byIndex(P.mSLMediumStretchHeightS, P.mSLMediumStretchHeightM, P.mSLMediumStretchHeightL)) { jumped(9); return; }
        if (st > this.byIndex(P.mSLSmallStretchHeightS, P.mSLSmallStretchHeightM, P.mSLSmallStretchHeightL)) jumped(10);
    }
}

type S = Spine<ChuuHana>;
const groundActor = (e: ChuuHana) => e.groundPlane.actor as HitActor | null;
export const ChuuHanaNerves: Record<string, any> = {};
ChuuHanaNerves.walkOnPanel = nerve<ChuuHana>('TNerveChuuHanaWalkOnPanel', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.setWalkAnm(); self.unk21C.v = 0; }
    if (!self.unk218) {
        const a = groundActor(self);
        if (a) { self.unk1F8.set(a.pos); self.unk218 = a; }
    } else self.walkBehavior(2, 1);
    self.checkOnPanel();
    if (self.isReachedToGoalXZ()) self.setGoal();
    if (self.unk21C.v) { spine.pushAfterCurrent(ChuuHanaNerves.attack); return true; }
    return false;
});
ChuuHanaNerves.forceJumped = nerve<ChuuHana>('TNerveChuuHanaForceJumped', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setSafeGoal();
    if (self.unk214 && self.getCurAnmFrameNo(ANM_BCK) > 80) {
        const a = groundActor(self);
        if (a) a.receiveMessage(self, MSG.SUPER_HIP_DROP);
        self.unk214 = 0;
    }
    if (self.checkCurAnmEnd(ANM_BCK)) {
        if (self.unk1B1) spine.pushAfterCurrent(ChuuHanaNerves.roll);
        else { spine.reset(); spine.setDefaultNext(); spine.pushAfterCurrent(spine.default); }
        return true;
    }
    return false;
});
ChuuHanaNerves.keepBalance = nerve<ChuuHana>('TNerveChuuHanaKeepBalance', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.setBckAnm(2);
        self.pos.x = fr(self.pos.x - fr(10 * self.unk1EC.x));
        self.pos.z = fr(self.pos.z - fr(10 * self.unk1EC.z));
    } else if (self.checkCurAnmEnd(ANM_BCK)) {
        if (self.isBckAnm(2)) self.setBckAnm(1);
        else if (self.isBckAnm(1)) self.setBckAnm(spine.time > self.PC.mSLKeepBalanceTime ? 0 : 1);
        else if (self.isBckAnm(0) || self.isBckAnm(7)) {
            spine.reset();
            spine.setNext(ChuuHanaNerves.keepBalance);
            spine.pushAfterCurrent(spine.default);
            self.setSafeGoal();
            return true;
        }
    }
    if (mAttackVersion) self.unk21C.v = 1;
    if (!mNewSw && !groundActor(self)) { spine.pushAfterCurrent(ChuuHanaNerves.fall); return true; }
    return false;
});
ChuuHanaNerves.stick = nerve<ChuuHana>('TNerveChuuHanaStick', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0 || !self.isBckAnm(4)) {
        self.setBckAnm(4);
        self.setGoalPath(new PathNode(null, self.world.mario.pos.clone()));
        if (mAttackVersion) self.unk21C.v = 1;
    } else {
        self.unk224++;
        if (self.unk224 > self.PC.mSLHitWaterTimer) {
            if (self.checkCurAnmEnd(ANM_BCK)) { self.unk21C.v = 0; spine.pushAfterCurrent(ChuuHanaNerves.wait); return true; }
        } else if (self.checkCurAnmEnd(ANM_BCK)) self.setBckAnm(4);
    }
    if (mNewSw && self.willFall(mCheckOnPanelTimeRoll)) { spine.pushAfterCurrent(ChuuHanaNerves.keepBalance); return true; }
    self.walkBehavior(3, 0.2);
    return false;
});
ChuuHanaNerves.roll = nerve<ChuuHana>('TNerveChuuHanaRoll', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.rollStart();
    if (self.unk1B0) {
        if (self.willFall(mCheckOnPanelTimeRoll)) { spine.pushAfterCurrent(ChuuHanaNerves.keepBalance); return true; }
    } else if (spine.time > 5000) return true;
    self.rolling();
    return false;
});
ChuuHanaNerves.fall = nerve<ChuuHana>('TNerveChuuHanaFall', () => false);
ChuuHanaNerves.fall2 = nerve<ChuuHana>('TNerveChuuHanaFall2', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(6);
    self.unk220 = fr(self.unk220 * 0.98);
    if (!self.isAirborne() || spine.time > 800) { spine.pushAfterCurrent(ChuuHanaNerves.object); self.kill(); return true; }
    return false;
});
ChuuHanaNerves.object = nerve<ChuuHana>('TNerveChuuHanaObject', () => false);
ChuuHanaNerves.attack = nerve<ChuuHana>('TNerveChuuHanaAttack', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.setBckAnm(12);
        self.mactor!.setFrameRate(2 * ANM_FRAME_RATE, ANM_BCK);
        self.setGoalPath(new PathNode(self.world.mario));
    }
    if (marioGroundPlane(self.world).actor !== self.unk218) self.unk21C.v = 0;
    if (spine.time > self.PC.mSLAttackTimer) { spine.pushAfterCurrent(ChuuHanaNerves.walkOnPanel); spine.pushAfterCurrent(ChuuHanaNerves.wait); return true; }
    self.checkOnPanel();
    if (self.isReachedToGoalXZ()) self.setGoalPath(new PathNode(self.world.mario));
    self.walkBehavior(2, self.PC.mSLDashRate);
    return false;
});
ChuuHanaNerves.jumpPrepare = nerve<ChuuHana>('TNerveChuuHanaJumpPrepare', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(3);
    // (the foot joint's height as the last calc left it: the BCK's pose now)
    const foot = self.mactor!.anmMtx(mFootJntIndex, self.baseTR, self.scale);
    self.unk220 = fr(self.pos.y - (foot ? fr(foot[13]) : self.pos.y));
    if (self.mactor!.getFrameCtrl(ANM_BCK)!.checkPass(10)) {
        const t = new V3(fr(2 * self.unk1F8.x - self.pos.x), fr(2 * self.unk1F8.y - self.pos.y), fr(2 * self.unk1F8.z - self.pos.z));
        self.unk21C.v = 0;
        t.y = fr(t.y + self.PC.mSLJumpHeight);
        const v = self.calcVelocityToJumpToY(t, self.PC.mSLJumpSp, self.getGravityY());
        v.y = fr(v.y + 10);
        self.pos.y = fr(self.pos.y + 10);
        self.vel.set(v);
        self.onLiveFlag(LF.AIRBORNE);
        self.unk130 = 0;
    }
    return self.checkCurAnmEnd(ANM_BCK);
});
ChuuHanaNerves.wait = nerve<ChuuHana>('TNerveChuuHanaWait', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(11);
    return self.checkCurAnmEnd(ANM_BCK);
});

register('ChuuHanaManager', (w, n) => new ChuuHanaManager(w, n));
// (the ChuuHana themselves are the manager's: createEnemyInstance)
