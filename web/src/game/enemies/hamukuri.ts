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
// THaneHamuKuri / THaneHamuKuri2 (はねハムクリ, the winged ones, /scene/hanekuri: below the launcher):
// flying on a sine bob over the ground; see their own comment.
//
// TDoroHaneKuri (ドロハネクリ, the goop-winged one of Pinna Park): a はねハムクリ that steals Mario's
// cap; see its own comment.
//
// Not here: the variants in the same file (だんごハムクリ and the boss,
// ヤキグリ, どろハムクリ — none in Bianco Hills) and the cap stealing only どろハムクリ does
// (makeCapFly / selectCapHolder: Mario's cap isn't simulated); football chasing
// (setSearchHamuKuri) needs the map objects' footballs, which aren't simulated either (no
// footballs: the manager's list is empty, as in a stage without them).

import { fr, V3, MsMtxSetRotRPH, mtx, mtxMultVec, Mtx, MsSin, MsClamp, MsGetRotFromZaxis } from '../math.js';
import { World, PathNode, LF, HF, HC, MSG, nerve, Spine, Stream, HitActor, LiveActor, AnmData, LiveManager, CUE_MOVE, CUE_CALC_ANIM, ANM_BCK, ANM_FRAME_RATE, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemy, SmallEnemyManager, SmallEnemyNerves, LIVE_FLAG_MELT_ON_DEATH } from './smallEnemy.js';
import { WalkerEnemy, WalkerNerves, walkerParams } from './walker.js';
import { Launcher, LauncherManager } from './launcher.js';
import { resetSRTV } from './generator.js';
import { register } from '../scene.js';
import { newAndRegisterObj } from '../mapobj/base.js';
import { isHideObj } from '../mapobj/fruit.js';

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

// ---------------------------------------------------------------- THaneHamuKuri / THaneHamuKuri2
// The winged goop Goombas (はねハムクリ). THaneHamuKuri flies over the ground at
// mSLFlyBaseHeight, bobbing mSLFlyBaseAmplitude on a sine wave of mSLFlyBaseFrequency ticks
// (unk230: the ground height it follows, eased over 120 ticks; unk234: its height over it;
// unk210: the bob). Above its goal while attacking, it rises (TNerveDoroHanePrepareAttack) and
// drops on it (unk21C: diving), squashing on landing; then it floats back up (UpWait). Water
// sends it rolling like a ハムクリ; it never lies kicking on its back.
// THaneHamuKuri2 (はねハムクリ2) only flies its graph (TNerveHaneHamuKuriMoveOnGraph): its base
// height is the line between the graph's two nodes it is between; it doesn't touch the map
// (LIVE_FLAG_UNK10: no bind), ignores water and can't be killed by it (isHitValid: anything).
// Not here: the dive's landing particle, rumble and sound; the attack sound.

/** THaneHamuKuriSaveLoadParams */
const HANE_PARAMS = {
    ...HAMU_PARAMS,
    mSLNormalJumpVy: ['f', 8], mSLAttackJumpVy: ['f', 4], mSLFlyBaseHeight: ['f', 100], mSLFlyBaseAmplitude: ['f', 50], mSLFlyBaseFrequency: ['f', 100],
} satisfies PSchema;

// hanekuri_bastable order
const HANE_BCK_CRASH = 0, HANE_BCK_DOWN = 1, HANE_BCK_ROLL = 2, HANE_BCK_WAIT = 3;

export class HaneHamuKuriManager extends HamuKuriManager {
    constructor(w: World, name = 'はねハムクリマネージャー') { super(w, name); }
    load(s: Stream) {
        this.saveParams = walkerParams('/enemy/hanehamukuri.prm', this.world.files, HANE_PARAMS);
        SmallEnemyManager.prototype.load.call(this, s);
    }
    createModelData() { this.createModelDataArray(['hanekuri.bmd']); }
    /** createAnmData: TObjManager's (its own folder's, /scene/hanekuri) */
    getMActorAnmData() { if (!this.anmData) this.anmData = new AnmData(this.folder(), this.world.files); return this.anmData; }
    createEnemyInstance() { return new HaneHamuKuri(this.world); }
}

export class HaneHamuKuri extends HamuKuri {
    /** mBoundFly (a static, never set: false) */
    static mBoundFly = false;
    unk20C = 0; unk210 = 0; unk214 = 0; unk218 = 0; unk21C = 0;
    unk220 = new V3();
    unk230 = 0; unk234 = 0;
    get unk22C(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'はねハムクリ') { super(w, name); }
    init(m: any) {
        super.init(m);
        this.spine!.initWith(WalkerNerves.graphWander);
        this.actorType = AT.HANE_HAMU_KURI;
        this.unk188 = 0;
    }
    moveObject() { WalkerEnemy.prototype.moveObject.call(this); }
    reset() {
        WalkerEnemy.prototype.reset.call(this);
        this.headHeight = 200;
        const [h, d] = this.world.checkGround(this.pos.x, this.pos.y + this.headHeight, this.pos.z);
        this.groundPlane = d;
        this.unk230 = this.groundHeight = h;
        this.resetFlyParam();
    }
    walkBehavior(kind: number, k: number) {
        const P = this.unk22C, c0 = this.spine!.current;
        const flyBaseHeight = P.mSLFlyBaseHeight;
        if (HaneHamuKuri.mBoundFly) {
            if (!this.isAirborne()) {
                const vy = kind === 2 ? P.mSLAttackJumpVy : P.mSLNormalJumpVy;
                this.pos.y = fr(this.pos.y + 10);
                this.onLiveFlag(LF.AIRBORNE);
                this.vel.set(0, vy, 0);
            }
        } else {
            if (!this.unk21C) {
                // TODO: abs() of a float (whether it's the int abs is unchecked)
                if (this.unk214 === 0 && Math.abs(fr(this.unk230 - this.groundHeight)) > 5) {
                    this.unk214 = fr(fr(this.groundHeight - this.unk230) / 120);
                    if (this.unk214 > 10) this.unk214 = 10;
                    if (this.unk214 < -10) this.unk214 = -10;
                }
                if (this.unk214 > 0) { this.unk230 = fr(this.unk230 + this.unk214); if (this.unk230 > this.groundHeight) this.unk214 = 0; }
                if (this.unk214 < 0) {
                    this.unk230 = fr(this.unk230 + this.unk214);
                    if (this.unk230 < this.groundHeight) { this.unk214 = 0; this.unk230 = fr(1 + this.groundHeight); }
                }
            }
            const freq = P.mSLFlyBaseFrequency, amp = P.mSLFlyBaseAmplitude;
            if (c0 === WalkerNerves.graphWander || c0 === WalkerNerves.attack || c0 === HaneNerves.doroHanePrepareAttack) {
                if (!this.unk21C) {
                    this.unk20C = fr(this.unk20C + 1);
                    if (this.unk20C > freq) this.unk20C = 0;
                    if (this.unk234 < flyBaseHeight) this.unk234 = fr(this.unk234 + 1);
                    if (this.unk234 > flyBaseHeight) this.unk234 = fr(this.unk234 - 1);
                }
                const c = this.spine!.current;
                if (c === WalkerNerves.attack || c === WalkerNerves.graphWander) {
                    if (this.unk21C) {
                        const [h, d] = this.world.checkGround(this.pos.x, this.pos.y + 2 * this.headHeight, this.pos.z);
                        this.groundPlane = d; this.groundHeight = h;
                        if (fr(fr(this.unk230 + this.unk234) + this.unk210) > this.groundHeight) {
                            this.unk234 = fr(this.unk234 - 15);
                            kind = 3;
                            this.unk230 = this.groundHeight;
                            this.unk210 = 0; this.unk214 = 0; this.unk20C = 0;
                            const bs = this.bodyScale;
                            if (fr(this.unk234 + this.unk210) > 200) this.scale.y = MsClamp(fr(1.1 * this.scale.y), 0, fr(1.3 * bs));
                            else this.scale.y = MsClamp(fr(0.8 * this.scale.x), fr(0.5 * bs), fr(1.3 * bs));
                        } else {
                            this.unk21C = 0; this.unk214 = 0; this.unk210 = 0; this.unk234 = 0; this.unk20C = 0;
                            // (PARTICLE_MS_HIPDROP_C, rumble, MSD_SE_MA_HIP_ATTACK)
                            this.setGoalPath(new PathNode(this.world.mario));
                            this.spine!.pushNerve(HaneNerves.upWait);
                        }
                    } else if (this.isReachedToGoal() && this.unk234 > fr(flyBaseHeight - 10)) {
                        this.unk21C = 1;
                        this.spine!.pushNerve(HaneNerves.doroHanePrepareAttack);
                    }
                }
            } else if (this.unk234 > 0) this.unk234 = fr(this.unk234 - 1);
            if (!this.unk21C) this.unk210 = fr(amp * MsSin(fr(fr(this.unk20C * 360) / freq)));
            this.pos.y = fr(fr(this.unk230 + this.unk234) + this.unk210);
        }
        if (this.spine!.current === HaneNerves.upWait && this.unk234 < flyBaseHeight) this.unk234 = fr(this.unk234 + 1);
        const diff = V3.sub(this.pos, this.unk220);
        if (this.spine!.current === HaneNerves.upWait) this.rot.x = fr(this.rot.x * 0.8);
        this.rot.z = MsGetRotFromZaxis(diff).z;
        if (!this.unk21C && !this.isBckAnm(4)) WalkerEnemy.prototype.walkBehavior.call(this, kind, k);
        this.unk220.set(this.pos);
        this.unk218 = this.rot.y;
        if (this.unk21C && this.pos.y < this.groundHeight) this.pos.y = this.groundHeight;
    }
    bind() {
        if (this.checkLiveFlag(LF.UNK10)) return;
        const n = this.pos.clone();
        n.y = fr(n.y - fr(this.unk234 + this.unk210));
        n.add(this.posDelta).add(this.vel).fround();
        this.vel.y = fr(this.vel.y - this.getGravityY());
        if (this.vel.y < -40) this.vel.y = -40;
        if (this.unk214 === 0) {
            const [h, d] = this.world.checkGround(n.x, n.y + this.headHeight + 200, n.z);
            this.groundPlane = d; this.groundHeight = fr(h + 1);
        }
        if (n.y <= this.groundHeight + 0.05) { this.offLiveFlag(LF.AIRBORNE); this.vel.set(0, 0, 0); }
        else this.onLiveFlag(LF.AIRBORNE);
        this.posDelta.set(V3.sub(n, this.pos));
        this.posDelta.y = fr(this.posDelta.y + fr(this.unk234 + this.unk210));
    }
    isReachedToGoal() { const t = V3.sub(this.goal104.point(), this.pos); t.y = 0; return t.squared() < 100; }
    attackToMario() { this.sendAttackMsgToMario(); /* (MSD_SE_EN_HANEKURI_ATTACK) */ }
    setMActorAndKeeper() { this.mactor = this.createMActorByName('hanekuri.bmd'); }
    setWaitAnm() { this.setBckAnm(HANE_BCK_WAIT); }
    setWalkAnm() { this.setBckAnm(HANE_BCK_WAIT); }
    setRunAnm() { this.setBckAnm(HANE_BCK_WAIT); }
    setRollAnm() { this.setBckAnm(HANE_BCK_ROLL); }
    behaveToWater(_a: HitActor) { this.forceRoll(this.world.mario.pos.clone(), true); }
    setCrashAnm() { this.setBckAnm(HANE_BCK_CRASH); }
    setDeadAnm() { if (this.unk198) this.releaseCap(); this.setBckAnm(HANE_BCK_DOWN); }
    setBehavior() { }
    setGenerateAnm() { }
    isCollidMove(a: HitActor): boolean { return SmallEnemy.prototype.isCollidMove.call(this, a); }
    isHitValid(_m: number) { return !this.checkLiveFlag(LF.HIDDEN); }
    canDoJitabata() { return false; }
    resetFlyParam() { this.unk214 = 0; this.unk210 = 0; this.unk234 = 0; this.unk20C = 0; this.unk21C = 0; }
}

export class HaneHamuKuri2 extends HaneHamuKuri {
    constructor(w: World, name = 'はねハムクリ2') { super(w, name); }
    reset() {
        WalkerEnemy.prototype.reset.call(this);
        this.headHeight = 200;
        const [h, d] = this.world.checkGround(this.pos.x, this.pos.y + this.headHeight, this.pos.z);
        this.groundPlane = d;
        this.unk230 = this.groundHeight = h;
        this.resetFlyParam();
        this.onLiveFlag(LF.UNK10);
        this.unk230 = this.pos.y;
        this.spine!.initWith(HaneNerves.moveOnGraph);
    }
    behaveToWater(_a: HitActor) { }
    forceKill() { }
    isHitValid(_m: number) { return true; }
    sendAttackMsgToMario() { SmallEnemy.prototype.sendAttackMsgToMario.call(this); }
    walkBehavior(kind: number, k: number) {
        const P = this.unk22C;
        const freq = P.mSLFlyBaseFrequency, amp = P.mSLFlyBaseAmplitude;
        this.unk20C = fr(this.unk20C + 1);
        if (this.unk20C > freq) this.unk20C = 0;
        const flyBaseHeight = P.mSLFlyBaseHeight;
        if (this.unk234 < flyBaseHeight) this.unk234 = fr(this.unk234 + 1);
        if (this.unk234 > flyBaseHeight) this.unk234 = fr(this.unk234 - 1);
        this.unk210 = fr(MsSin(fr(fr(this.unk20C * 360) / freq)) * amp);
        this.pos.y = fr(fr(this.unk230 + this.unk234) + this.unk210);
        this.turnSpeed = P.mSLTurnSpeedLow;
        this.marchSpeed = P.mSLMarchSpeedLow;
        if (!this.isBckAnm(4)) WalkerEnemy.prototype.walkBehavior.call(this, kind, k);
    }
    isReachedToGoal() { const t = V3.sub(this.goal104.point(), this.pos); t.y = 0; return t.squared() < 20; }
}

type HS = Spine<HaneHamuKuri>;
export const HaneNerves: Record<string, any> = {};
HaneNerves.upWait = nerve<HaneHamuKuri>('TNerveHaneHamuKuriUpWait', (spine: HS) => {
    const self = spine.body;
    if (spine.time < 1) { self.setWaitAnm(); self.setGoalPath(new PathNode(self.world.mario)); }
    const bs = self.bodyScale;
    self.scale.x = self.scale.z = MsClamp(fr(self.scale.x * 0.9), bs, fr(bs * 2));
    self.scale.y = MsClamp(fr(self.scale.y * 1.3), 0, bs);
    if (spine.time > 400) return true;
    self.unk234 = fr(self.unk234 + 1);
    self.walkBehavior(3, 0.5);
    return false;
});
HaneNerves.moveOnGraph = nerve<HaneHamuKuri>('TNerveHaneHamuKuriMoveOnGraph', (spine: HS) => {
    const self = spine.body, t = self.tracer;
    const nodeNum = () => (t.graph ? t.graph.nodes.length : 0);
    if (spine.time === 0) {
        self.setWalkAnm();
        self.initialGraphNode();
        if (nodeNum() === 1) self.setGoalPath(new PathNode(self.world.mario));
    }
    if (nodeNum() === 1) self.walkBehavior(3, 0.5);
    else {
        if (self.isReachedToGoal()) self.goToRandomNextGraphNode();
        if (t.prev >= 0) {
            const curPos = t.graph!.point(t.prev);
            const prevPos = t.graph!.point(t.cur);
            const distToCur = V3.sub(curPos, self.pos).length();
            const distToPrev = V3.sub(prevPos, self.pos).length();
            self.unk230 = fr(curPos.y + fr(fr(distToCur * fr(prevPos.y - curPos.y)) / fr(distToCur + distToPrev)));
            self.walkBehavior(2, 1);
        }
    }
    return false;
});
/** TNerveDoroHanePrepareAttack (ドロハネクリ's, which the はねハムクリ uses too): rise 50 ticks, then drop */
HaneNerves.doroHanePrepareAttack = nerve<HaneHamuKuri>('TNerveDoroHanePrepareAttack', (spine: HS) => {
    const self = spine.body;
    if (spine.time < 50) self.unk234 = fr(self.unk234 + 4);
    else self.unk234 = fr(self.unk234 - 15);
    if (spine.time > 100) return true;
    self.walkBehavior(0, 0.5);
    return false;
});
void HANE_BCK_CRASH;

// ---------------------------------------------------------------- TDoroHaneKuri
// The goop-winged Goomba (ドロハネクリ, /scene/hanekuri's dorohane.bmd): a はねハムクリ that, hitting
// Mario while he wears his cap, takes it (onHaveCap: unk198, its moustache TDoroHige then shows
// the cap) and rises up to 800 over the ground with it (TNerveDoroHaneRise) — no longer chasing him
// (isFindMario) — until it loses it (releaseCap, on dying). Sprayed it drops to the ground and
// spins for 300 ticks (TNerveDoroHaneHitWater). Pushed by a map object while attacking, it is
// thrown back 5 times its step.
// Not here: the moustache / cap model (TDoroHige, a TSharedParts: drawing), the particle and the
// attack sound. Mario's cap isn't simulated: he is taken as wearing it unless one of these holds it.

export class DoroHaneKuriManager extends HaneHamuKuriManager {
    constructor(w: World, name = 'ドロハネクリマネージャー') { super(w, name); }
    load(s: Stream) {
        this.saveParams = walkerParams('/enemy/dorohanekuri.prm', this.world.files, HANE_PARAMS);
        SmallEnemyManager.prototype.load.call(this, s);
    }
    loadAfter() {
        super.loadAfter();
        newAndRegisterObj(this.world, 'mario_cap');
    }
    createModelData() { this.createModelDataArray(['dorohane.bmd']); }
    createEnemyInstance() { return new DoroHaneKuri(this.world); }
    /** (gpMarioOriginal->isWearingCap: the cap isn't simulated; worn unless one of these has it) */
    isMarioWearingCap() { return !(this.objs as DoroHaneKuri[]).some((o) => o.unk198); }
}

export class DoroHaneKuri extends HaneHamuKuri {
    constructor(w: World, name = 'ドロハネクリ') { super(w, name); this.unk1AC = 5; }
    get unk238(): any { return this.getSaveParam(); }
    init(m: any) {
        super.init(m);
        this.spine!.initWith(WalkerNerves.graphWander);
        this.actorType = AT.DORO_HANE_KURI;
        this.unk188 = 0;
        // (instance 0: TDoroHaneKuriManager::createHige, the moustache model: drawing)
    }
    reset() {
        this.unk18C = 5;
        super.reset();
        this.unk198 = false;
        this.onLiveFlag(LF.FORCE_SHADOW);
    }
    attackToMario() {
        const mgr = this.manager as DoroHaneKuriManager;
        if (!mgr.isMarioWearingCap()) { this.world.mario.receiveMessage(this, MSG.ATTACK); return; }
        if (this.world.mario.receiveMessage(this, MSG.ATTACK)) {
            this.spine!.pushNerve(DoroNerves.rise);
            this.unk198 = true;   // onHaveCap (and the moustache's owner)
            // (unk200: joint unk1AC's place, for the particle)
        }
    }
    setMActorAndKeeper() { this.mactor = this.createMActorByName('dorohane.bmd'); }
    behaveToWater(_a: HitActor) {
        this.unk21C = 1;
        if (this.spine!.current !== DoroNerves.hitWater) this.spine!.pushNerve(DoroNerves.hitWater);
    }
    setBehavior() { if (this.spine!.current === SmallEnemyNerves.die) this.releaseCap(); }
    isCollidMove(a: HitActor): boolean {
        if (a.getHitCategory() === (HC.MAP_OBJECT | 0)) {
            if (isHideObj(a)) return false;
            if (this.spine!.current === WalkerNerves.attack) {
                this.pos.x = fr(this.pos.x + fr(this.posDelta.x * -5));
                this.pos.z = fr(this.pos.z + fr(this.posDelta.z * -5));
            }
        }
        return true;
    }
}

type DS = Spine<DoroHaneKuri>;
export const DoroNerves: Record<string, any> = {};
/** TNerveDoroHaneRise: up with the cap (to 800 over the ground), springing back into shape */
DoroNerves.rise = nerve<DoroHaneKuri>('TNerveDoroHaneRise', (spine: DS) => {
    const self = spine.body;
    if (self.pos.y < fr(self.groundHeight + 800)) self.unk234 = fr(self.unk234 + MsClamp(fr(self.spine!.time * 0.01), fr(0.01), 5));
    const bs = self.bodyScale;
    self.scale.x = self.scale.z = MsClamp(fr(self.scale.x * 0.9), bs, fr(bs * 2));
    self.scale.y = MsClamp(fr(self.scale.y * 1.3), 0, bs);
    if (!self.unk198) { spine.pushAfterCurrent(WalkerNerves.graphWander); return true; }
    self.rot.x = fr(self.rot.x * 0.9);
    self.pos.y = fr(self.unk230 + self.unk234);
    self.walkToCurPathNode(0, 2, 0);
    return false;
});
/** TNerveDoroHaneHitWater: sprayed: down to the ground, spinning (its animation at 1.5 times) for 300 ticks */
DoroNerves.hitWater = nerve<DoroHaneKuri>('TNerveDoroHaneHitWater', (spine: DS) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.setGoalPath(new PathNode(null, self.world.mario.pos.clone()));
        self.mactor!.setFrameRate(fr(ANM_FRAME_RATE * 1.5), ANM_BCK);
    }
    if (self.pos.y > fr(self.groundHeight + 50)) self.unk234 = fr(self.unk234 - 4);
    self.unk210 = 0; self.unk214 = 0; self.unk20C = 0;
    self.unk230 = self.groundHeight;
    if (spine.time > 300) { self.mactor!.setFrameRate(ANM_FRAME_RATE, ANM_BCK); return true; }
    self.rot.y = fr(self.rot.y + 10);
    if (!self.isBckAnm(4)) WalkerEnemy.prototype.walkBehavior.call(self, 0, 0.5);
    return false;
});

register('HamuKuriManager', (w, n) => new HamuKuriManager(w, n));
register('HamuKuri', (w, n) => new HamuKuri(w, n));
register('HamukuriLauncher', (w, n) => new HamuKuriLauncher(w, n));
register('HamukuriLauncherManager', (w, n) => new HamuKuriLauncherManager(w, n));
register('HaneHamuKuriManager', (w, n) => new HaneHamuKuriManager(w, n));
register('HaneHamuKuri', (w, n) => new HaneHamuKuri(w, n));
register('HaneHamuKuri2', (w, n) => new HaneHamuKuri2(w, n));
register('DoroHaneKuriManager', (w, n) => new DoroHaneKuriManager(w, n));
register('DoroHaneKuri', (w, n) => new DoroHaneKuri(w, n));
export type { LiveManager };
