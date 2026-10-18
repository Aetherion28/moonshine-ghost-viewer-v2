// THamuKuri / THamuKuriManager (Enemy/hamukuri.cpp): the goop Goombas (ハムクリ) — walkers on the
// graph that chase Mario when they see him. Water knocks one over (jitabata: it kicks on its
// back for mSLJitabataTimer, then gets up); touched while kicking, or sprayed in the air, it is
// sent rolling (TNerveHamuKuriBoundFreeze: mSLBoundNum bounces, each mSLVelocityRate of the last)
// and dies against a wall (TNerveHamuKuriWallDie); a rolling one knocks others over too. A
// stomp kills one, and every other one kicking on its back with it (requestSerialKill: a 1-Up at
// mSLTrampleBonusNum); mSLCrashBonusNum wall deaths within mSLSerialCrashFrame give an item.
// Thrown out of a launcher (THamuKuriLauncher, or the CommonLauncher in Bianco Hills) it plays
// its "set" animation and lands. Its animations are the shared /scene/hamukurianm ones.
//
// Not here: the variants in the same file (はねハムクリ, ドロハネクリ, だんごハムクリ and the boss,
// ヤキグリ, どろハムクリ — none in Bianco Hills) and the cap stealing only どろハムクリ does
// (makeCapFly / selectCapHolder: Mario's cap isn't simulated); football chasing
// (setSearchHamuKuri) needs the map objects' footballs, which aren't simulated either (no
// footballs: the manager's list is empty, as in a stage without them).

import { fr, V3, MsMtxSetRotRPH, mtx, mtxMultVec, Mtx } from '../math.js';
import { World, PathNode, LF, HF, HC, MSG, nerve, Spine, Stream, HitActor, LiveActor, AnmData, LiveManager, CUE_MOVE, CUE_CALC_ANIM, ANM_BCK, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemyManager, SmallEnemyNerves, LIVE_FLAG_MELT_ON_DEATH } from './smallEnemy.js';
import { WalkerEnemy, WalkerNerves, walkerParams } from './walker.js';
import { Launcher, LauncherManager } from './launcher.js';
import { resetSRTV } from './generator.js';
import { register } from '../scene.js';

/** THamuKuriSaveLoadParams */
const HAMU_PARAMS = {
    mSLWaterCoeff: ['f', 6], mSLWaterAttackCoeff: ['f', 12], mSLFirstVelocityY: ['f', 5], mSLVelocityRate: ['f', 0.8], mSLBoundNum: ['i', 3],
    mSLSearchActorTimer: ['i', 500], mSLCanSearchDist: ['f', 800], mSLJitabataTimer: ['i', 200], mSLFirstKickVelocityY: ['f', 2], mSLFlyTimer: ['i', 500],
    mSLTrampleBonusNum: ['i', 3], mSLCrashBonusNum: ['i', 3], mSLSerialCrashFrame: ['i', 15], mSLKyoroTimer: ['i', 500],
} satisfies PSchema;

// THamuKuri's statics
export const mCapGravityY = 0.15, mCapSpeed = 12, mVGenerateGravityY = 0.15, mLandAnmFrameNum = 90;
let mSearchActSw = true;

// BCKs (/scene/hamukurianm, in the folder's order: hamukurianm_bastable)
const BCK_APPEAR = 0, BCK_CRASH = 1, BCK_DOWN = 2, BCK_JITABATA = 3, BCK_KYORO = 4, BCK_LAND = 5, BCK_RETURN = 6, BCK_ROLL = 7,
    BCK_RUN = 8, BCK_SET = 9, BCK_TURN_DOWN = 10, BCK_TURN_END = 11, BCK_TURN_START = 12, BCK_WAIT = 13, BCK_WALK = 14;
void BCK_APPEAR; void BCK_RETURN;

export class HamuKuriManager extends SmallEnemyManager {
    /** unk60: the map object type they go for (ACTOR_TYPE_FOOTBALL) */
    unk60 = 0;
    /** unk64 / unk68: the stage's footballs */
    footballs: LiveActor[] = [];
    /** unk6C: frames since a serial wall death began (0: none) */
    unk6C = 0;
    /** unk70: the one holding Mario's cap */
    unk70: HamuKuri | null = null;
    constructor(w: World, name = 'ハムクリマネージャー') { super(w, name); }
    get HP(): any { return this.saveParams; }
    load(s: Stream) {
        this.saveParams = walkerParams('/enemy/hamukuri.prm', this.world.files, HAMU_PARAMS);
        super.load(s);
    }
    loadAfter() {
        super.loadAfter();
        // (TMapObjBaseManager::newAndRegisterObj("mushroom1up"): items aren't simulated)
        this.unk60 = AT.FOOTBALL;
        // gpMapObjManager's objects of that type: none here (map objects aren't simulated)
        this.footballs = [];
    }
    createModelData() { this.createModelDataArray(['default.bmd']); }
    /** createAnmData: MActorAnmData::init("/scene/hamukurianm") */
    getMActorAnmData() { if (!this.anmData) this.anmData = new AnmData('hamukurianm', this.world.files); return this.anmData; }
    createEnemyInstance() { return new HamuKuri(this.world); }
    perform(cue: number) {
        if (this.footballs.length > 0 && mSearchActSw && (cue & CUE_CALC_ANIM)) this.setSearchHamuKuri();
        if (cue & CUE_MOVE) this.checkSerialKill();
        super.perform(cue);
    }
    setSearchHamuKuri() {
        const P = this.HP;
        for (let i = 0; i < this.getActiveObjNum(); ++i) {
            const k = this.objs[i] as HamuKuri;
            if (!k.canGoForSearchActor()) continue;
            if (k.checkLiveFlag(LF.DEAD | LF.HIDDEN | LF.CLIPPED_OUT)) continue;
            if (k.unk19C >= P.mSLSearchActorTimer) {
                let best: LiveActor | null = null, d2 = fr(P.mSLCanSearchDist * P.mSLCanSearchDist);
                for (const b of this.footballs) {
                    if (b.checkLiveFlag(LF.DEAD | LF.CLIPPED_OUT)) continue;
                    if (b.isAirborne()) continue;
                    const l = V3.sub(k.pos, b.pos).squared();
                    if (l < d2) { best = b; d2 = l; }
                }
                if (best) k.setSearchActor(best);
            }
        }
    }
    requestSerialKill(who: HamuKuri) {
        let trampled = 1;
        const n = this.HP.mSLTrampleBonusNum;
        for (let i = 0; i < this.getActiveObjNum(); ++i) {
            const o = this.objs[i] as HamuKuri;
            if (o !== who && o.isBckAnm(BCK_JITABATA)) { o.kill(); ++trampled; }
        }
        if (trampled >= n) this.world.events.push({ t: this.world.tickCount, kind: 'item', data: { type: AT.MUSHROOM1UP, p: who.pos.clone() } });
    }
    checkSerialKill() {
        if (this.unk6C === 0) return;
        let count = 0;
        const P = this.HP;
        ++this.unk6C;
        if (this.unk6C > P.mSLSerialCrashFrame) this.unk6C = 0;
        let rep: HamuKuri | null = null;
        for (let i = 0; i < this.getActiveObjNum(); ++i) { const o = this.objs[i] as HamuKuri; if (o.isSerialWallDie()) { ++count; rep = o; } }
        if (rep && count >= P.mSLCrashBonusNum) this.world.events.push({ t: this.world.tickCount, kind: 'item', data: { type: AT.ITEM_UNK3, p: rep.pos.clone() } });
    }
}

export class HamuKuri extends WalkerEnemy {
    /** unk194: how far it chases before giving up */
    unk194 = 0;
    /** unk198: has Mario's cap */
    unk198 = false;
    /** unk19C: ticks it could have gone for a football */
    unk19C = 0;
    unk1A0 = false; unk1A1 = false; unk1A2 = false; unk1A3 = false; unk1A4 = false;
    /** unk1A8: the kyoro (look around) timer */
    unk1A8 = 0;
    unk1AC = 3;
    unk1B0: Mtx = mtx();
    /** unk1E0: bounces so far */
    unk1E0 = 0;
    unk1E4 = new V3();
    /** unk1F0: fell from high up (lands with its land animation) */
    unk1F0 = false;
    unk1F8: LiveActor | null = null;
    unk200 = new V3();
    get H(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'ハムクリ') { super(w, name); }
    get hmgr() { return this.manager as HamuKuriManager; }
    init(m: any) {
        super.init(m);
        this.actorType = AT.HAMU_KURI;
        this.unk150 = 17;
        this.onHitFilter(HC.MAP_OBJECT);
        this.spine!.initWith(WalkerNerves.generate);
    }
    /** setMActorAndKeeper: default.bmd (its _mat_body_top1 goop colour and texture are the viewer's) */
    setMActorAndKeeper() { this.mactor = this.createMActorByName('default.bmd'); }
    reset() {
        super.reset();
        this.offLiveFlag(LF.HIDDEN);
        this.unk194 = this.H.mSLGiveUpLength;
        this.unk1F0 = false; this.unk1A3 = false; this.unk1A4 = false;
    }
    bind() {
        if (!this.unk1A4) { LiveActor.prototype.bind.call(this); return; }
        // kicked: it slides along the ground (TLiveActor::bind's ground, no gravity)
        if (this.spine!.time > this.H.mSLFlyTimer || this.groundPlane.isWaterSurface()) this.unk1A4 = false;
        this.vel.y = 0;
        const n = this.pos.clone().add(this.posDelta).add(this.vel);
        const [h, d] = this.checkLiveFlag(LF.UNK1000) ? this.world.checkGroundIgnoreWaterSurface(n.x, n.y + this.headHeight, n.z) : this.world.checkGround(n.x, n.y + this.headHeight, n.z);
        this.groundPlane = d; this.groundHeight = fr(h + 1);
        if (n.y <= this.groundHeight + 0.05) {
            if (this.groundPlane.isIllegal()) this.kill();
            n.y = fr(this.groundHeight + 1);
        } else this.onLiveFlag(LF.AIRBORNE);
        const p = { x: n.x, z: n.z };
        this.world.isTouchedOneWallAndMoveXZ(p, n.y + this.headHeight, this.bodyRadius);
        n.x = p.x; n.z = p.z;
        this.posDelta.set(V3.sub(n, this.pos));
    }
    releaseCap() {
        // (only one holding Mario's cap: not simulated)
        this.unk198 = false;
    }
    behaveToWater(_a: HitActor) {
        const c = this.spine!.current;
        if (c === HamuNerves.boundFreeze || c === HamuNerves.wallDie) return;
        if (c === HamuNerves.jitabata) { this.unk165 = true; return; }
        if (this.canDoJitabata()) { this.spine!.pushNerve(HamuNerves.jitabata); return; }
        if (this.vel.y < 0) this.forceRoll(this.world.mario.pos.clone(), true);
    }
    canDoJitabata() { return !this.isAirborne(); }
    isFindMario(k: number) {
        this.unk1A2 = false;
        if (this.unk198) return false;
        // (Mario pumping with an empty tank sees them chase from 5 times as far: the ghost doesn't
        // record his tank, so never)
        return super.isFindMario(k);
    }
    setSearchActor(a: LiveActor) {
        this.unk19C = 0; this.unk1A0 = false;
        this.spine!.pushNerve(HamuNerves.goForSearchActor);
        this.unk1F8 = a;
        this.setGoalPath(new PathNode(null, a.pos.clone()));
    }
    isGiveUpSearchActor() {
        const a = this.unk1F8;
        if (this.unk128 > 100 || (a && Math.abs(this.groundHeight - a.groundHeight) > 100)) {
            this.unk1A0 = true; this.unk1F8 = null; this.unk19C = 0;
            return true;
        }
        return false;
    }
    jumpToSearchActor() {
        const a = this.unk1F8;
        if (!a) return;
        if (V3.sub(this.pos, a.pos).squared() > 40000) {
            const t = a.pos.clone(); t.y = a.groundHeight;
            this.setGoalPath(new PathNode(null, t));
            return;
        }
        this.vel.set(this.calcVelocityToJumpToY(a.pos, 1, this.getGravityY()));
        this.onLiveFlag(LF.AIRBORNE);
    }
    canGoForSearchActor() { const c = this.spine!.current; return c === WalkerNerves.attack || c === WalkerNerves.graphWander; }
    behaveToFindMario() { super.behaveToFindMario(); }
    attackToMario() {
        if (this.spine!.current === HamuNerves.jitabata) {
            if (this.pos.y + 10 > this.world.mario.pos.y) this.forceRoll(this.world.mario.pos.clone(), false);
        } else super.attackToMario();
    }
    moveObject() {
        if (this.unk198) {
            this.offLiveFlag(LF.CLIPPED_OUT);
            if (!this.isAirborne()) {
                if (this.checkLiveFlag(LF.HIDDEN)) { this.spine!.reset(); this.spine!.setNext(WalkerNerves.generate); }
                this.offLiveFlag(LF.HIDDEN);
                this.offHitFilter(HF.NO_COLLISION);
            }
        }
        if (this.canGoForSearchActor()) this.unk19C += 1;
        if (this.spine!.current === WalkerNerves.graphWander) {
            this.unk1A8 += 1;
            if (this.unk1A8 > this.H.mSLKyoroTimer) { this.unk1A8 = 0; this.setBckAnm(BCK_KYORO); }
            if (this.isBckAnm(BCK_KYORO) && this.checkCurAnmEnd(ANM_BCK)) this.setBckAnm(BCK_WALK);
        }
        super.moveObject();
    }
    setBehavior() {
        const c = this.spine!.current;
        if (this.isAirborne() && this.pos.y > this.groundHeight + 250 && c !== WalkerNerves.generate) this.unk1F0 = true;
        if (!this.isAirborne() && this.unk1F0 && (c === WalkerNerves.graphWander || c === WalkerNerves.attack)) this.spine!.pushNerve(HamuNerves.land);
    }
    getGravityY() {
        if (this.checkLiveFlag(LF.HIDDEN)) return mCapGravityY;
        if (this.spine!.current === WalkerNerves.generate && this.unk1A1) return mVGenerateGravityY;
        return this.gravity;
    }
    setAfterDeadEffect() {
        if (this.unk198) { this.unk198 = false; this.hmgr.unk70 = null; }
        this.world.effect(this.isBckAnm(BCK_CRASH) ? 'enemyDisappearW' : 'enemyDisappear', this.pos, this.scale);
    }
    endHitWaterJump() { if (!this.isFindMario(1.3)) this.unk1A2 = true; }
    setGenerateAnm() { this.setBckAnm(BCK_SET); }
    setWalkAnm() { this.setBckAnm(BCK_KYORO); }
    setDeadAnm() {
        if (this.unk198) this.releaseCap();
        if (this.unk184) { this.onLiveFlag(LF.UNK20000); this.world.effect('enemyDisappear', this.pos); }
        else this.setBckAnm(this.isBckAnm(BCK_JITABATA) ? BCK_TURN_DOWN : BCK_DOWN);
        this.unk19C = 0;
    }
    setWaitAnm() { this.setBckAnm(BCK_WAIT); }
    setRunAnm() { this.setBckAnm(BCK_RUN); }
    setRollAnm() { this.setBckAnm(BCK_ROLL); }
    setCrashAnm() {
        if (this.unk198) this.releaseCap();
        this.unk1A4 = false;
        this.setBckAnm(BCK_CRASH);
        if (this.unk1A3 && this.hmgr.unk6C === 0) this.hmgr.unk6C = 1;
    }
    setWallDeadEffect() { this.world.effect('enemyWallHit', this.pos, this.scale); }
    walkBehavior(kind: number, k: number) { if (!this.isBckAnm(BCK_KYORO)) super.walkBehavior(kind, k); }
    /** TWalkerEnemy::initAttacker (Boss Boo's), then it chases Mario */
    initAttacker(a: HitActor) { this.rot.set(a.rot); this.unk184 = 1; this.spine!.pushNerve(WalkerNerves.traceMario); }
    getTakingMtx(): Mtx {
        const [h, d] = this.world.checkGround(this.pos.x, this.pos.y + this.headHeight, this.pos.z);
        this.groundPlane = d;
        if (this.held) this.held.onHitFilter(HF.NO_COLLISION);
        const m = this.unk1B0;
        m.set([1, 0, 0, this.pos.x, 0, 1, 0, h, 0, 0, 1, this.pos.z]);
        return m;
    }
    isResignationAttack() {
        if (V3.sub(this.goal104.point(), this.pos).length() > this.unk194) { this.unk194 = this.H.mSLGiveUpLength; return true; }
        if (this.unk1A2) { this.unk1A2 = false; return true; }
        return false;
    }
    isHitValid(_m: number) {
        if (this.isBckAnm(BCK_JITABATA)) { this.hmgr.requestSerialKill(this); return true; }
        return !this.checkLiveFlag(LF.HIDDEN);
    }
    isCollidMove(a: HitActor): boolean {
        const c = this.spine!.current;
        if (a.isActorType(AT.BOSS_TELESA) && c === HamuNerves.boundFreeze) a.receiveMessage(this, MSG.TRAMPLE);
        if (a.isActorType(AT.HAMU_KURI) || a.isActorType(AT.HANE_HAMU_KURI) || a.isActorType(AT.DORO_HAMU_KURI) || a.isActorType(AT.FIRE_HAMU_KURI)) {
            const h = a as HamuKuri;
            if (h.isAttackToHam() && c !== SmallEnemyNerves.die && c !== HamuNerves.boundFreeze && c !== HamuNerves.wallDie) {
                if (!this.isHitWallInBound()) { this.unk1A3 = true; this.forceRoll(h.pos.clone(), false); return false; }
            }
        }
        const t = a.actorType;
        if ((t & (0xFFFF0000 | 0)) === (HC.MAP_OBJECT | 0) && t >= AT.FRUIT_COCONUT && t <= AT.FRUIT_BANANA) {
            const v = (a as LiveActor).vel;
            if (v && Math.abs(v.y) > 2 && (Math.abs(v.x) > 2 || Math.abs(v.z) > 2)) {
                if (c !== HamuNerves.jitabata && !this.isAirborne()) this.spine!.pushNerve(HamuNerves.jitabata);
            }
        }
        if (!super.isCollidMove(a)) return false;
        if (!a.isActorType(this.hmgr.unk60)) return true;
        this.unk1A0 = true; this.unk1F8 = null;
        return false;
    }
    isAttackToHam() { return this.spine!.current === HamuNerves.boundFreeze; }
    isSerialWallDie() { return this.unk1A3 && this.spine!.current === HamuNerves.wallDie; }
    forceRoll(from: V3, sprayed: boolean) {
        const d = new V3(fr(this.pos.x - from.x), 10, fr(this.pos.z - from.z)).normalize();
        d.scale(this.spine!.current === WalkerNerves.attack ? this.H.mSLWaterAttackCoeff : this.H.mSLWaterCoeff);
        this.onLiveFlag(LF.AIRBORNE);
        this.pos.y = fr(this.pos.y + 10);
        if (sprayed) d.y = this.H.mSLFirstVelocityY;
        else { d.y = this.H.mSLFirstKickVelocityY; this.unk1A4 = true; }
        this.vel.set(d);
        this.spine!.pushNerve(HamuNerves.boundFreeze);
    }
}

type S = Spine<HamuKuri>;
export const HamuNerves: Record<string, any> = {};
HamuNerves.goForSearchActor = nerve<HamuKuri>('TNerveHamuKuriGoForSearchActor', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setRunAnm();
    if (!self.isAirborne() && V3.sub(self.goal104.point(), self.pos).length() < 200) self.jumpToSearchActor();
    if (self.unk1A0 || self.isGiveUpSearchActor()) {
        spine.reset(); spine.setNext(WalkerNerves.graphWander); spine.pushAfterCurrent(WalkerNerves.graphWander);
        return true;
    }
    self.walkBehavior(0, 2.5);
    return false;
});
HamuNerves.boundFreeze = nerve<HamuKuri>('TNerveHamuKuriBoundFreeze', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.setRollAnm();
        self.unk1E4.set(self.vel);
        self.setGoalPath(new PathNode(self.world.mario));
        self.unk1E0 = 1;
    }
    if (self.isHitWallInBound()) { spine.pushAfterCurrent(HamuNerves.wallDie); return true; }
    if (!self.unk1A4 && !self.isAirborne()) {
        const P = self.H;
        if (self.unk1E0 >= P.mSLBoundNum) {
            self.rot.x = 0;
            spine.reset(); spine.setNext(WalkerNerves.graphWander); spine.pushAfterCurrent(WalkerNerves.graphWander);
            return true;
        }
        self.unk1E0 += 1;
        self.pos.y = fr(self.pos.y + 5);
        const v = self.unk1E4.clone().scale(P.mSLVelocityRate).fround();
        self.unk1E4.set(v);
        self.vel.set(v);
    }
    if (!self.isBckAnm(BCK_KYORO)) WalkerEnemy.prototype.walkBehavior.call(self, 3, 1000);
    return false;
});
HamuNerves.wallDie = nerve<HamuKuri>('TNerveHamuKuriWallDie', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.setCrashAnm();
        self.setWallDeadEffect();
        self.onHitFilter(HF.NO_COLLISION);
        self.hitPoints = 0;
    } else {
        const wait = self.hmgr.unk5C;
        if (self.checkCurAnmEnd(ANM_BCK) && spine.time > wait + self.mactor!.getFrameCtrl(ANM_BCK)!.end) {
            self.onLiveFlag(LF.DEAD); self.onLiveFlag(LF.UNK8); self.onLiveFlag(LF.UNK20000); self.offLiveFlag(LIVE_FLAG_MELT_ON_DEATH);
            self.holder = null;
            spine.reset(); spine.setNext(SmallEnemyNerves.die); spine.pushAfterCurrent(spine.default);
            self.genRandomItem();
            return true;
        }
    }
    return false;
});
HamuNerves.land = nerve<HamuKuri>('TNerveHamuKuriLand', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(BCK_LAND);
    if (self.checkCurAnmEnd(ANM_BCK)) { self.offHitFilter(HF.NO_COLLISION); self.unk1F0 = false; return true; }
    return false;
});
HamuNerves.jitabata = nerve<HamuKuri>('TNerveHamuKuriJitabata', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(BCK_TURN_START);
    if (self.checkCurAnmEnd(ANM_BCK)) {
        const timer = self.H.mSLJitabataTimer;
        if (self.isBckAnm(BCK_TURN_START)) self.setBckAnm(BCK_JITABATA);
        else {
            if (self.isBckAnm(BCK_TURN_END)) { spine.pushAfterCurrent(SmallEnemyNerves.wait); return true; }
            if (spine.time > timer) self.setBckAnm(BCK_TURN_END);
        }
    }
    return false;
});

// ---------------------------------------------------------------- THamuKuriLauncher
/** THamuKuriLauncher: a TLauncher that throws out one of ハムクリマネージャー's, landing mLandAnmFrameNum ticks later. */
export class HamuKuriLauncher extends Launcher {
    constructor(w: World, name = 'ハムクリランチャー') { super(w, name); }
    stateLaunch() {
        if (this.ticksInState === 0) {
            const h = this.getProperEnemy('ハムクリマネージャー') as HamuKuri | null;
            if (h) {
                const m = mtx(); MsMtxSetRotRPH(m, this.rot.x, this.rot.y, this.rot.z);
                let v = new V3(0, 4, 4);
                const r = new V3(0, this.rot.y, 0);
                h.unk1A1 = false;
                if (Math.trunc(this.rot.x) % 180 !== 0) {
                    h.unk1A1 = true;
                    const n = mLandAnmFrameNum;
                    const [g] = this.world.checkGround(this.pos.x, this.pos.y + 10, this.pos.z);
                    v.set(0, fr(fr(fr(n * fr(n * h.getGravityY())) * 0.5 + fr(g - this.pos.y)) / n), fr(200 / n));
                } else v.set(0, 0, 0);
                v = mtxMultVec(m, v);
                resetSRTV(h, this.pos, r, h.scale, v);
            }
        }
        if (this.anmEndsNext()) { this.resetLaunchTimer(); this.changeState(2 /* STATE_NORMAL */); }
    }
}
export class HamuKuriLauncherManager extends LauncherManager {
    constructor(w: World, name = 'ハムクリランチャーマネージャー') { super(w, name); }
    /** (TObjManager::createModelData's default.bmd) */
    createModelData() { this.createModelDataArray(['default.bmd']); }
}

register('HamuKuriManager', (w, n) => new HamuKuriManager(w, n));
register('HamuKuri', (w, n) => new HamuKuri(w, n));
register('HamukuriLauncher', (w, n) => new HamuKuriLauncher(w, n));
register('HamukuriLauncherManager', (w, n) => new HamuKuriLauncherManager(w, n));
export type { LiveManager };
