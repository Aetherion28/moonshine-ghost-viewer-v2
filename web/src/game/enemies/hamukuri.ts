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
// TDangoHamuKuri / TBossDangoHamuKuri (だんごハムクリ, Gelato's stacks), TFireHamuKuri (ヤキグリ) and
// TDoroHamuKuri (どろハムクリ, the cap stealer): see their own comments below.
//
// Not here: football chasing
// (setSearchHamuKuri) needs the map objects' footballs, which aren't simulated either (no
// footballs: the manager's list is empty, as in a stage without them). Mario's cap: どろハムクリ
// knocks it off (selectCapHolder / makeCapFly), ドロハネクリ takes it (attackToMario); whichever has
// it (unk198) drops it as the mario_cap item where it dies (THamuKuri::setAfterDeadEffect).

import { fr, V3, MsMtxSetRotRPH, mtx, mtxMultVec, Mtx, MsSin, MsCos, MsClamp, MsGetRotFromZaxis, MsRandF, JMASSin, s16 } from '../math.js';
import { frsqrte } from '../math.js';
import { World, PathNode, LF, HF, HC, MSG, nerve, Spine, Stream, HitActor, LiveActor, TakeActor, SpineEnemy, AnmData, LiveManager, CUE_MOVE, CUE_CALC_ANIM, ANM_BCK, ANM_FRAME_RATE, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemy, SmallEnemyManager, SmallEnemyNerves, LIVE_FLAG_MELT_ON_DEATH, rangeRand } from './smallEnemy.js';
import { WalkerEnemy, WalkerNerves, walkerParams } from './walker.js';
import { Launcher, LauncherManager } from './launcher.js';
import { resetSRTV } from './generator.js';
import { register } from '../scene.js';
import { newAndRegisterObj, mapObjGlobals } from '../mapobj/base.js';
import { MTXConcat } from '../mapobj/lib.js';
import { isHideObj } from '../mapobj/fruit.js';
import { SE } from '../soundids.js';
import '../sound.js';

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

/** TNerveHaneHamuKuriMoveOnGraph's distances: (x² + y²) + z² unfused, then TUtil<f32>::sqrt (0 for s <= 0) */
function hhkDist(d: V3) {
    const s = fr(fr(fr(d.x * d.x) + fr(d.y * d.y)) + fr(d.z * d.z));
    if (s <= 0) return 0;
    const e = fr(frsqrte(s)), ee = fr(e * e);
    return fr(s * fr(fr(0.5 * e) * fr(3 - s * ee)));
}

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
    /**
     * THamuKuri::releaseCap: a held cap (どろハムクリ's) is put down where it stands, dead
     * (setAfterDeadEffect brings it back); unk198 stays (a ドロハネクリ holds none, only unk198)
     */
    releaseCap() {
        const h = this.held as LiveActor | null;
        if (h && h.receiveMessage(this, MSG.PUT)) {
            h.holder = null;
            h.offLiveFlag(LF.HIDDEN);
            h.pos.set(this.pos); h.pos.y = this.groundHeight;
            h.offHitFilter(HF.NO_COLLISION);
            (h as any).makeObjDead();
            this.held = null;
        }
    }
    behaveToWater(_a: HitActor) {
        const c = this.spine!.current;
        if (c === HamuNerves.boundFreeze || c === HamuNerves.wallDie) return;
        if (c === HamuNerves.jitabata) { this.unk165 = true; return; }
        if (this.canDoJitabata()) { this.spine!.pushNerve(HamuNerves.jitabata); return; }
        if (this.vel.y < 0) this.forceRoll(this.world.mario.pos.clone(), true);
    }
    canDoJitabata() { return !this.isAirborne(); }
    onHaveCap() { this.unk198 = true; }
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
        this.world.sound(SE.EN_DOROKURI_JUMP, this.pos);
    }
    canGoForSearchActor() { const c = this.spine!.current; return c === WalkerNerves.attack || c === WalkerNerves.graphWander; }
    behaveToFindMario() { super.behaveToFindMario(); this.world.sound(SE.EN_HMKRI_VO_ATTACK, this.pos); }
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
    /** THamuKuri::setAfterDeadEffect: with Mario's cap, the cap appears on the ground there */
    setAfterDeadEffect() {
        if (this.unk198) {
            const im = itemManager(this.world);
            const obj = im ? im.makeObjAppearAt(this.pos.x, this.pos.y, this.pos.z, AT.MARIO_CAP, true) : null;
            if (obj) { this.unk200.set(this.pos.x, this.groundHeight, this.pos.z); this.world.effect('capDrop', this.unk200); }
            this.unk198 = false;
            this.hmgr.unk70 = null;
        }
        this.world.effect(this.isBckAnm(BCK_CRASH) ? 'enemyDisappearW' : 'enemyDisappear', this.pos, this.scale);
        this.world.sound(SE.EN_COMMON_SMOKE, this.pos);
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
        self.world.sound(SE.EN_HAMUKURI_CRUSHED, self.pos);
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
                            // (PARTICLE_MS_HIPDROP_C, rumble)
                            this.world.sound(SE.MA_HIP_ATTACK, this.pos);
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
    attackToMario() { this.world.sound(SE.EN_HANEKURI_ATTACK, this.pos); this.sendAttackMsgToMario(); }
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
            // (each distance as the DOL has it: unfused squares, then TUtil<f32>::sqrt's single-precision frsqrte step)
            const distToCur = hhkDist(V3.sub(curPos, self.pos));
            const distToPrev = hhkDist(V3.sub(prevPos, self.pos));
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
// (isFindMario) — until it dies, dropping it (setAfterDeadEffect: the mario_cap item, which gives
// it back to Mario when he touches it). Sprayed it drops to the ground and
// spins for 300 ticks (TNerveDoroHaneHitWater). Pushed by a map object while attacking, it is
// thrown back 5 times its step.
// Not here: the moustache / cap model (TDoroHige, a TSharedParts: drawing), the particle and the
// attack sound.

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
    /** gpMarioOriginal->isWearingCap (a ghost replay's Mario: worn unless one of these has it) */
    isMarioWearingCap() {
        const m = this.world.mario as any;
        if (typeof m.isWearingCap === 'function') return m.isWearingCap() as boolean;
        return !(this.objs as DoroHaneKuri[]).some((o) => o.unk198);
    }
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
        if (!mgr.isMarioWearingCap()) { if (this.world.mario.receiveMessage(this, MSG.ATTACK)) this.world.sound(SE.EN_HANEKURI_ATTACK, this.pos); return; }
        if (this.world.mario.receiveMessage(this, MSG.ATTACK)) {
            this.world.sound(SE.EN_HANEKURI_ATTACK, this.pos);
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

// ---------------------------------------------------------------- Mario's cap (どろハムクリ)
/** TMsRange<s32>::rand */
const rangeI = (lo: number, hi: number) => lo + Math.trunc(fr((hi - lo) * MsRandF()));
/** gpItemManager */
const itemManager = (w: World) => mapObjGlobals(w).itemManager as { makeObjAppearAt(x: number, y: number, z: number, t: number, onGround: boolean): any; objs: HitActor[] } | null;
/**
 * gpMarioOriginal->isWearingCap: the player Mario's (live play). A ghost replay's Mario has no cap
 * state: he is taken as wearing it while no mario_cap item is out (knocked off, flying or held:
 * it's alive until he touches it again, TItem::taken).
 */
function isMarioWearingCap(w: World) {
    const m = w.mario as any;
    if (typeof m.isWearingCap === 'function') return m.isWearingCap() as boolean;
    const im = itemManager(w);
    return !im || !im.objs.some((o) => o.isActorType(AT.MARIO_CAP) && !(o as LiveActor).checkLiveFlag(LF.DEAD));
}
/** THamuKuri::selectCapHolder (only どろハムクリ's attackToMario calls it): hitting Mario knocks his cap off to one of them */
function selectCapHolder(self: HamuKuri) {
    if (!isMarioWearingCap(self.world)) { self.sendAttackMsgToMario(); return; }
    self.sendAttackMsgToMario();
    if (self.hmgr.unk70 === null) {
        const im = itemManager(self.world);
        const obj = im ? im.makeObjAppearAt(self.pos.x, self.pos.y, self.pos.z, AT.MARIO_CAP, false) : null;
        if (obj) { self.offLiveFlag(LF.CLIPPED_OUT); makeCapFly(self, obj); }
    }
}
/**
 * THamuKuri::makeCapFly: a clipped-out one of the manager (getHolder), or this one, takes the cap
 * 100 above a point behind it and jumps (mCapSpeed) to the node 2-3 random steps along its graph.
 */
function makeCapFly(self: HamuKuri, cap: LiveActor) {
    const p = self.pos.clone();
    p.x = fr(p.x + fr(-self.vel.x * 20));
    p.z = fr(p.z + fr(-self.vel.z * 20));
    let holder = self.hmgr.getHolder(self.instanceIndex) as HamuKuri | null;
    if (!holder) {
        const g = self.groundPlane;
        if (!g.isIllegal() && !g.isPool() && !g.isWaterSurface()) holder = self;
        else { cap.pos.set(self.world.mario.pos); cap.vel.set(0, 10, 0); cap.offLiveFlag(LF.UNK10); return; }
    }
    holder.pos.set(p);
    holder.pos.y = fr(holder.pos.y + 100);
    cap.pos.y = holder.pos.y;
    if (cap.receiveMessage(holder, MSG.TAKE)) {
        holder.reset();
        holder.onHaveCap();
        holder.held = cap as TakeActor;
        holder.onLiveFlag(LF.HIDDEN); holder.offLiveFlag(LF.DEAD); holder.offLiveFlag(LF.CLIPPED_OUT);
        holder.onHitFilter(HF.NO_COLLISION);
        self.hmgr.unk70 = holder;
        const t = self.tracer;
        let cur = t.cur, prev = -1;
        const count = rangeI(2, 3);
        for (let i = 0; i < count; ++i) { const next = t.graph!.getRandomNextIndex(cur, prev, -1); prev = cur; cur = next; }
        if (cur < 0) cur = 0;
        const goal = t.graph!.point(cur).clone();
        const v = self.calcVelocityToJumpToY(goal, mCapSpeed, holder.getGravityY());
        holder.onLiveFlag(LF.AIRBORNE);
        holder.vel.set(v);
    } else holder.onLiveFlag(LF.DEAD);
}

// ---------------------------------------------------------------- TDangoHamuKuri / TBossDangoHamuKuri
// The Dango stacks (だんごハムクリ, Gelato Beach): a ボスだんごハムクリ (the bottom one, from scene.bin)
// that, on generating (setGenerateAnm), pulls mSLNumArray だんごハムクリ out of だんごハムクリマネージャー
// (generateBody) and stacks them: each one is held (HIT_MESSAGE_TAKE) by the one below it (mPrev;
// mNext the one above), and drawn at its holder's joint unk1AC (getTakingMtx, turned with the
// boss), swinging round on a circle (swingBody: unk20C, wider while the boss attacks). Only the
// stack's top one can be stomped (isHitValid); sprayed, the top one falls off (and goes its own
// way on the graph), the bottom one jumps, the others spin round once (unk230 / unk210). The
// body ones only move while the boss is there and not generating; the boss dying kills them all
// (forceKill). The managers share ハムクリマネージャー's model when there is one, and never clip.
// Not here: the water hit particle and sounds (the turn sound).

export class DangoHamuKuriManager extends HamuKuriManager {
    constructor(w: World, name = 'だんごハムクリマネージャー') { super(w, name); }
    load(s: Stream) {
        this.saveParams = walkerParams('/enemy/dangohamukuri.prm', this.world.files, HAMU_PARAMS);
        SmallEnemyManager.prototype.load.call(this, s);
    }
    /** createModelDataArray: ハムクリマネージャー's models when it is there */
    createModelDataArray(entries: string[]) {
        const m = this.world.conductor.getManagerByName('ハムクリマネージャー');
        if (m) this.modelFiles = m.modelFiles;
        else super.createModelDataArray(entries);
    }
    createEnemyInstance() { return new DangoHamuKuri(this.world); }
    /** clipEnemies: none */
    clipActors() { }
}

export class BossDangoHamuKuriManager extends DangoHamuKuriManager {
    constructor(w: World, name = 'ボスだんごハムクリマネージャー') {
        super(w, name);
        mSearchActSw = false;
    }
    load(s: Stream) {
        this.saveParams = walkerParams('/enemy/bossdangohamukuri.prm', this.world.files, { ...HAMU_PARAMS, mSLNumArray: ['i', 3] } satisfies PSchema);
        SmallEnemyManager.prototype.load.call(this, s);
    }
    createEnemyInstance() { return new BossDangoHamuKuri(this.world); }
}

/** J3D's column-major joint matrix as a game Mtx */
const m4ToMtx = (j: ArrayLike<number>): Mtx => Float64Array.from([j[0], j[4], j[8], j[12], j[1], j[5], j[9], j[13], j[2], j[6], j[10], j[14]]);

export class DangoHamuKuri extends HamuKuri {
    /** mAttackSw (a static, never set: false) */
    static mAttackSw = false;
    /** unk20C: the swing's phase (0..1) */
    unk20C = 0;
    /** unk210 / unk214: its turn (yaw, roll) on its holder */
    unk210 = 0; unk214 = 0;
    unk218 = 0;
    /** unk21C / unk220 / unk224: the swing's offset */
    unk21C = 0; unk220 = 0; unk224 = 0;
    mNext: DangoHamuKuri | null = null;
    mPrev: DangoHamuKuri | null = null;
    /** unk230: spinning round once */
    unk230 = false;
    mBoss: BossDangoHamuKuri | null = null;
    constructor(w: World, name = 'だんごハムクリ') { super(w, name); }
    init(m: any) {
        super.init(m);
        this.spine!.initWith(DangoNerves.wait);
        this.actorType = AT.DANGO_HAMU_KURI;
    }
    /** setMActorAndKeeper: the manager's (maybe ハムクリマネージャー's) default.bmd */
    setMActorAndKeeper() { this.mactor = this.createMActor(0); }
    perform(cue: number) { if (this.mBoss && !this.mBoss.isNowGenerate()) super.perform(cue); }
    changeByJuice() { return this.mPrev === null ? SmallEnemy.prototype.changeByJuice.call(this) : false; }
    moveObject() {
        super.moveObject();
        this.swingBody();
        if (this.mBoss && !this.mBoss.checkLiveFlag(LF.CLIPPED_OUT)) this.offLiveFlag(LF.CLIPPED_OUT);
    }
    updateAnmSound() {
        super.updateAnmSound();
        if (this.mBoss) this.offLiveFlag(LF.CLIPPED_OUT);
    }
    isCollidMove(a: HitActor): boolean { return SmallEnemy.prototype.isCollidMove.call(this, a); }
    attackToMario() {
        if (this.mPrev !== null || this.pos.y + 20 > this.world.mario.pos.y) super.attackToMario();
        else if (this.mBoss && this.mBoss.isNowAttack()) this.sendAttackMsgToMario();
    }
    /** getTakingMtx: joint unk1AC's place (40 higher on the boss), turned with the boss */
    getTakingMtx(): Mtx {
        const j = this.mactor ? this.mactor.anmMtx(this.unk1AC, this.baseTR, this.scale) : null;
        const t = j ? m4ToMtx(j) : this.baseTR;
        const k = (this.mBoss as DangoHamuKuri | null) === this ? 40 : 0;
        const pos = mtx();
        pos[3] = t[3]; pos[7] = fr(t[7] + k); pos[11] = t[11];
        const r = mtx();
        MsMtxSetRotRPH(r, 0, this.mBoss ? this.mBoss.rot.y : 0, 0);
        MTXConcat(pos, r, this.unk1B0);
        return this.unk1B0;
    }
    setRunAnm() { this.setBckAnm(this.mNext === null ? BCK_RUN : BCK_WALK); }
    calcRootMatrix() {
        if (this.holder && this.holder.held === this) {
            const m = this.holder.getTakingMtx();
            if (m) {
                if (this.unk230) {
                    this.unk210 = fr(this.unk210 + 40);
                    if (this.unk210 > 360) { this.unk210 = -rangeRand(10, 20); this.unk230 = false; }
                }
                const h = this.holder as unknown as DangoHamuKuri;
                if (h.unk230) this.unk210 = -h.unk210;
                m[3] = fr(m[3] + this.unk21C); m[7] = fr(m[7] + this.unk220); m[11] = fr(m[11] + this.unk224);
                const r = mtx();
                MsMtxSetRotRPH(r, 0, this.unk210, this.unk214);
                MTXConcat(m, r, m);
                this.baseTR.set(m);
                this.pos.set(m[3], m[7], m[11]);
                return;
            }
        }
        SpineEnemy.prototype.calcRootMatrix.call(this);
    }
    reset() {
        super.reset();
        this.mPrev = null; this.mNext = null; this.mBoss = null;
        this.unk20C = rangeRand(0, 1);
        // (mMActor->calc)
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (msg === MSG.TAKE && this.holder === null && (this.mBoss as DangoHamuKuri | null) !== this) {
            this.onHitFilter(HF.NO_COLLISION);
            this.holder = sender as TakeActor;
            this.behaveToTaken(sender);
            return true;
        }
        if ((msg === MSG.PUT || msg === MSG.THROWN) && this.holder === sender) {
            this.holder = null; this.behaveToRelease(); this.offHitFilter(HF.NO_COLLISION); return true;
        }
        if (msg === MSG.TRAMPLE || msg === MSG.HIP_DROP || msg === MSG.SUPER_HIP_DROP || msg === MSG.UNKB) {
            if (this.isHitValid(msg)) { this.unk184 = 0; this.kill(); }
            return true;
        }
        if (msg === MSG.UNKD) { this.hitPoints = 0; this.onLiveFlag(LF.DEAD); this.onHitFilter(HF.NO_COLLISION); }
        if (msg === MSG.SPRAYED_BY_WATER) {
            this.world.effect('enemyWaterHit', sender.pos);
            this.world.sound(SE.EN_COMMON_W_HIT_OK, this.pos);
            if (this.sprayCooldown === 0) {
                this.sprayCooldown = 1;
                if (!this.changeByJuice()) { this.decHpByWater(sender); this.behaveToWater(sender); }
            }
            return true;
        }
        return false;
    }
    isHitValid(_m: number) { return !(this.mPrev !== null || this.mNext !== null); }
    forceKill() {
        if (this.mPrev === null) SmallEnemy.prototype.forceKill.call(this);
        if (this.mBoss === null) return;
        if (this.mBoss.isDead() && this.spine!.current !== SmallEnemyNerves.die) {
            this.spine!.reset(); this.spine!.setNext(SmallEnemyNerves.die); this.spine!.pushAfterCurrent(this.spine!.default);
            this.onLiveFlag(LF.UNK20000);
        }
    }
    nerveInit() { }
    behaveToWater(a: HitActor) {
        if (!this.mNext) {
            if (!this.mPrev) super.behaveToWater(a);
            else if (this.sprayCooldown <= 1 && this.receiveMessage(this.mPrev, MSG.PUT)) {
                // the top one falls off
                this.holder = null;
                this.mPrev.held = null;
                this.mPrev.mNext = null;
                this.mPrev.sprayCooldown = 1;
                this.mPrev = null; this.mNext = null;
                this.spine!.setNext(WalkerNerves.graphWander);
                this.unk210 = 0; this.unk214 = 0;
                const d = V3.sub(this.pos, this.world.mario.pos).normalize();
                d.x = fr(d.x * 5); d.y = 1; d.z = fr(d.z * 5);
                this.vel.set(d);
                this.pos.y = fr(this.pos.y + 20);
                this.onLiveFlag(LF.AIRBORNE);
                this.unk230 = false;
            }
        } else if (this.mPrev === null) {
            if (!this.isAirborne()) {
                this.pos.y = fr(this.pos.y + 10);
                this.onLiveFlag(LF.AIRBORNE);
                this.vel.set(0, 2, 0);
                this.spine!.pushNerve(SmallEnemyNerves.hitWaterJump);
            }
        } else if (!this.mPrev.unk230) {
            this.unk230 = true;
            this.unk210 = 1;
            this.world.sound(SE.EN_DANGOKURI_TURN, this.pos);
        }
    }
    swingBody() {
        if (this.unk20C > 1) this.unk20C = fr(this.unk20C - 1);
        this.unk20C = fr(this.unk20C + fr(0.01));
        let k = 10;
        const boss = this.mBoss!;
        if (boss.isNowAttack()) {
            if (DangoHamuKuri.mAttackSw) {
                if (this.mPrev !== null) {
                    if (this.mPrev === boss) { this.rot.set(boss.rot); this.unk210 = fr(this.unk210 + 10); }
                    if (this.mPrev.mPrev === boss) {
                        this.unk218 = fr(this.unk218 + 1000);
                        this.unk214 = fr(fr(JMASSin(s16(this.unk218)) * 30) + 90);
                    }
                }
                // (else if (mPrev && mPrev->mPrev == mBoss) unk214 = 0: unreachable)
            }
            k = 16;
        }
        this.unk21C = fr(k * MsCos(fr(this.unk20C * 360)));
        this.unk224 = fr(k * MsSin(fr(this.unk20C * 360)));
    }
}

export class BossDangoHamuKuri extends DangoHamuKuri {
    /** unk238: bodies stacked so far */
    unk238 = 0;
    get unk23C(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'ボスだんごハムクリ') { super(w, name); }
    init(m: any) {
        super.init(m);
        this.spine!.initWith(WalkerNerves.generate);
        this.mBoss = this;
    }
    perform(cue: number) { HamuKuri.prototype.perform.call(this, cue); }
    reset() {
        super.reset();
        this.mBoss = this;
        this.unk238 = 0;
    }
    changeByJuice() { return false; }
    isFindMario(_k: number) { return false; }
    isDead() { const c = this.spine!.current; return c === SmallEnemyNerves.die || c === HamuNerves.wallDie; }
    setGenerateAnm() {
        this.setBckAnm(BCK_SET);
        const n = this.unk23C.mSLNumArray;
        for (let i = 0; i < n; ++i) this.generateBody();
    }
    moveObject() { super.moveObject(); }
    genEventCoin() {
        if (!this.coin) return;
        const c = this.world.makeCoinAppear(this.coin);
        if (c) { c.pos.set(this.pos); c.vel.set(0, 20, 0); c.offLiveFlag(LF.UNK10); --this.unk18C; }
    }
    /** generateBody: one more だんごハムクリ on top of the stack */
    generateBody() {
        const num = this.unk23C.mSLNumArray;
        if (this.unk238 >= num) return;
        const h = this.world.conductor.makeOneEnemyAppear(this.pos, 'だんごハムクリマネージャー', 0) as DangoHamuKuri | null;
        let cur: DangoHamuKuri = this;
        if (!h) return;
        h.reset();
        h.spine!.reset();
        h.spine!.setNext(DangoNerves.wait);
        h.pos.set(0, 0, 0);
        h.tracer.graph = this.tracer.graph;
        ++this.unk238;
        for (let i = 0; i < num; ++i) {
            if (!cur.mNext) {
                cur.mNext = h;
                h.mPrev = cur;
                if (h.receiveMessage(cur, MSG.TAKE)) cur.held = h;
                h.mBoss = this;
                break;
            }
            cur = cur.mNext;
        }
        h.offHitFilter(HF.NO_COLLISION);
    }
    isNowAttack() { return this.spine!.current === WalkerNerves.attack; }
    isNowGenerate() { return this.spine!.current === WalkerNerves.generate; }
}

type DGS = Spine<DangoHamuKuri>;
export const DangoNerves: Record<string, any> = {};
/** TNerveDangoHamuKuriWait: its wait animation from a random frame (set on its first two ticks) */
DangoNerves.wait = nerve<DangoHamuKuri>('TNerveDangoHamuKuriWait', (spine: DGS) => {
    const self = spine.body;
    if (spine.time < 2) {
        self.setWaitAnm();
        const v = rangeRand(0, 30);
        const fc = self.mactor ? self.mactor.getFrameCtrl(ANM_BCK) : null;
        if (fc) fc.frame = v;
    }
    return false;
});
DangoNerves.attack = nerve<DangoHamuKuri>('TNerveDangoHamuKuriAttack', () => false);

// ---------------------------------------------------------------- TFireHamuKuri
// ヤキグリ (the burning Goomba of the volcano): a ハムクリ on fire (unk210) — it burns Mario
// (HIT_MESSAGE_BURN) and can't be stomped; spraying pushes it away and takes its hit points, at 0
// the fire goes out (dieFire) and it's a plain ハムクリ for mSLRecoverTimer ticks, then it
// relights (TNerveFireHamuKuriRecover). unk218 eases its colours over 30 ticks.
// Not here: the fire particles, the colours themselves (TEV registers: drawing), sounds; the lava
// texture (H_ma_rak.bti).

export class FireHamuKuriManager extends HamuKuriManager {
    constructor(w: World, name = 'ヤキグリマネージャー') { super(w, name); }
    load(s: Stream) {
        this.saveParams = walkerParams('/enemy/firehamukuri.prm', this.world.files, { ...HAMU_PARAMS, mSLRecoverTimer: ['i', 500] } satisfies PSchema);
        SmallEnemyManager.prototype.load.call(this, s);
    }
    createModelData() { this.createModelDataArray(['default.bmd']); }
    createEnemyInstance() { return new FireHamuKuri(this.world); }
    /** initSetEnemies: their TEV colour packets (drawing) */
    initSetEnemies() { }
}

export class FireHamuKuri extends HamuKuri {
    get unk20C(): any { return this.getSaveParam(); }
    /** unk210: on fire */
    unk210 = false;
    /** unk214: ticks since the fire went out (0: burning) */
    unk214 = 0;
    /** unk218: the colour fade (0: burning .. 30: out) */
    unk218 = 0;
    constructor(w: World, name = 'ヤキグリ') { super(w, name); }
    init(m: any) {
        super.init(m);
        this.spine!.initWith(WalkerNerves.generate);
        this.actorType = AT.FIRE_HAMU_KURI;
    }
    behaveToWater(a: HitActor) {
        if (this.unk210) {
            const d = new V3(fr(this.pos.x - this.world.mario.pos.x), 0, fr(this.pos.z - this.world.mario.pos.z));
            if (d.x === 0 && d.y === 0 && d.z === 0) d.x += 1;
            d.normalize().scale(8).fround();
            this.vel.set(d);
            this.onLiveFlag(LF.AIRBORNE);
            this.pos.y = fr(this.pos.y + 5);
            if (this.hitPoints === 0) this.dieFire();
            this.sprayCooldown = 20;
            return;
        }
        super.behaveToWater(a);
    }
    reset() { super.reset(); this.recoverFire(); }
    setMActorAndKeeper() { this.mactor = this.createMActorByName('default.bmd'); }
    moveObject() { super.moveObject(); this.changeTevColor(); }
    walkBehavior(kind: number, k: number) {
        if (!this.isBckAnm(BCK_KYORO)) WalkerEnemy.prototype.walkBehavior.call(this, kind, k);
        const t = this.unk20C.mSLRecoverTimer;
        if (this.unk214 > 0) this.unk214 += 1;
        if (this.unk214 === 0 && !this.unk210) this.unk210 = true;
        if (this.unk214 > t) {
            this.spine!.reset(); this.spine!.setNext(WalkerNerves.graphWander); this.spine!.pushNerve(FireNerves.recover);
            this.setBckAnm(BCK_WAIT);
        }
    }
    isHitValid(m: number) {
        if (m === MSG.UNKB) return true;
        if (this.unk210) return false;
        return super.isHitValid(m);
    }
    recoverFire() { this.resetHitPoints(); this.unk150 &= ~2; this.unk150 |= 1; this.unk214 = 0; this.unk210 = false; }
    setWalkAnm() { this.setBckAnm(BCK_WALK); }
    genFire() { }
    dieFire() {
        this.unk210 = false; this.unk1A2 = true;
        this.unk150 |= 2; this.unk150 &= ~1;
        this.unk214 = 1;
        this.world.sound(SE.EN_MOEKURI_COOL, this.pos);   // (PARTICLE_MS_MOE_FIRE_OFF)
    }
    sendAttackMsgToMario() { this.world.mario.receiveMessage(this, this.unk210 ? MSG.BURN : MSG.ATTACK); }
    /** changeTevColor: only its fade counter (the colours are drawing) */
    changeTevColor() {
        if (!this.unk210) { if (this.unk218 < 30) this.unk218 += 1; }
        else { this.world.sound(SE.EN_MOEKURI_FLAME, this.pos); if (this.unk218 > 0) this.unk218 -= 1; }
    }
}

type FS = Spine<FireHamuKuri>;
export const FireNerves: Record<string, any> = {};
FireNerves.recover = nerve<FireHamuKuri>('TNerveFireHamuKuriRecover', (spine: FS) => {
    const self = spine.body;
    if (self.checkCurAnmEnd(ANM_BCK)) {
        if (self.isBckAnm(BCK_RETURN)) { self.recoverFire(); return true; }
        self.setBckAnm(BCK_RETURN);
    }
    return false;
});

// ---------------------------------------------------------------- TDoroHamuKuri
// どろハムクリ (/scene/dorokuri): a ハムクリ that knocks Mario's cap off when it hits him
// (selectCapHolder): a clipped-out one of them (or itself) takes it and jumps off with it
// (makeCapFly); the others then go for it (TNerveDoroHamuKuriRobCap) and, jumping on the holder,
// take it over (isCollidMove). It drops the cap where it dies (releaseCap / setAfterDeadEffect).
// Not here: the moustache that shows the cap (TDoroHige, a TSharedParts: drawing), the particle
// and rumble.

export class DoroHamuKuriManager extends HamuKuriManager {
    constructor(w: World, name = 'どろハムクリマネージャー') { super(w, name); }
    load(s: Stream) {
        this.saveParams = walkerParams('/enemy/dorohamukuri.prm', this.world.files, HAMU_PARAMS);
        SmallEnemyManager.prototype.load.call(this, s);
    }
    loadAfter() {
        super.loadAfter();
        newAndRegisterObj(this.world, 'mario_cap');
    }
    createModelData() { this.createModelDataArray(['dorokuri_model.bmd']); }
    createEnemyInstance() { return new DoroHamuKuri(this.world); }
}

export class DoroHamuKuri extends HamuKuri {
    constructor(w: World, name = 'どろハムクリ') { super(w, name); }
    init(m: any) {
        super.init(m);
        this.actorType = AT.DORO_HAMU_KURI;
        this.spine!.initWith(WalkerNerves.generate);
        // (instance 0: TDoroHamuKuriManager::createHige, the moustache: drawing)
    }
    reset() { super.reset(); this.spine!.initWith(WalkerNerves.generate); }
    setMActorAndKeeper() { this.mactor = this.createMActorByName('dorokuri_model.bmd'); }
    onHaveCap() { this.unk198 = true; this.hmgr.unk70 = this; }
    attackToMario() {
        if (this.spine!.current === HamuNerves.jitabata) {
            if (this.pos.y + 10 > this.world.mario.pos.y) this.forceRoll(this.world.mario.pos.clone(), false);
        } else selectCapHolder(this);
    }
    setBehavior() {
        const man = this.hmgr;
        if (!this.unk198 && man.unk70) {
            if (this.spine!.current === WalkerNerves.graphWander && !this.isAirborne()) {
                this.spine!.pushNerve(DoroNerves.robCap);
                this.unk1F8 = man.unk70;
            }
        } else super.setBehavior();
    }
    isCollidMove(a: HitActor): boolean {
        if (this.unk198) return false;
        if (a.isActorType(AT.DORO_HAMU_KURI)) {
            const o = a as DoroHamuKuri;
            if (o.unk198 && !o.isAirborne()) {
                o.vel.set(0, 3, 0);
                o.pos.y = fr(o.pos.y + 2);
                o.onLiveFlag(LF.AIRBORNE);
                if (!this.isAirborne()) {
                    this.vel.set(this.calcVelocityToJumpToY(o.pos.clone(), 6, this.getGravityY()));
                    this.pos.y = fr(this.pos.y + 2);
                    this.onLiveFlag(LF.AIRBORNE);
                }
                if (!this.unk198 && this.isAirborne() && this.pos.y > o.pos.y + 10) {
                    const cap = o.held as LiveActor | null;
                    if (cap === null) { o.unk198 = false; o.held = null; return true; }
                    if (cap.receiveMessage(o, MSG.PUT)) {
                        cap.pos.set(o.pos);
                        if (cap.receiveMessage(this, MSG.TAKE)) {
                            o.unk198 = false; o.held = null;
                            this.onHaveCap();
                            this.held = cap as TakeActor;
                            const t = o.tracer;
                            let prev = -1, cur = t.cur;
                            const count = rangeI(2, 3);
                            for (let i = 0; i < count; ++i) { const next = t.graph!.getRandomNextIndex(cur, prev, -1); prev = cur; cur = next; }
                            const goal = t.graph!.point(cur).clone();
                            const v = this.calcVelocityToJumpToY(goal, mCapSpeed, this.getGravityY());
                            this.onLiveFlag(LF.AIRBORNE);
                            this.vel.set(v);
                            return false;
                        }
                    }
                }
            }
            return true;
        }
        return super.isCollidMove(a);
    }
}

type DRS = Spine<DoroHamuKuri>;
/** TNerveDoroHamuKuriRobCap: go for the one with the cap, until another has it */
DoroNerves.robCap = nerve<DoroHamuKuri>('TNerveDoroHamuKuriRobCap', (spine: DRS) => {
    const self = spine.body, man = self.hmgr;
    if (spine.time === 0 || self.unk1F8 === null) {
        self.unk1F8 = man.unk70;
        self.setRunAnm();
        self.setGoalPath(new PathNode(man.unk70));
    } else if (self.unk1F8 !== man.unk70) {
        self.setGoalPath(new PathNode(self.world.mario));
        return true;
    }
    self.walkBehavior(0, 2.5);
    return false;
});

register('DangoHamuKuriManager', (w, n) => new DangoHamuKuriManager(w, n));
register('BossDangoHamuKuriManager', (w, n) => new BossDangoHamuKuriManager(w, n));
register('BossDangoHamuKuri', (w, n) => new BossDangoHamuKuri(w, n));
register('FireHamuKuriManager', (w, n) => new FireHamuKuriManager(w, n));
register('FireHamuKuri', (w, n) => new FireHamuKuri(w, n));
register('DoroHamuKuriManager', (w, n) => new DoroHamuKuriManager(w, n));
register('DoroHamuKuri', (w, n) => new DoroHamuKuri(w, n));
export type { LiveManager };
