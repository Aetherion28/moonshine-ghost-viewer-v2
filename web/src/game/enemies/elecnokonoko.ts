// TElecNokonoko / TElecCarapace / TElecNokonokoManager (Enemy/elecNokonoko.cpp): the electric
// Koopas (電気ノコノコ, /scene/dennoko) of Pinna Park, with their electrified shells (ノコノコ甲羅).
//
// One walks its graph; seeing Mario it turns to face him (TNerveElecNokonokoTurn), chases him
// (TNerveWalkerAttack) and, within mSLCarapaceShootRange, throws its shell at him
// (TNerveElecNokonokoShoot: the shell appears at frame 60, flies at 62). The shell (TElecCarapace,
// an enemy attachment) zigzags out mSLCarapaceFlyDist towards Mario's side (setZigParameter: a
// random cycle and angle, its phase by unk174), turns back (unk184) to its owner, bounces off
// walls and other actors (mReflectSw), shocks Mario on touch, and is caught back
// (TNerveElecNokonokoCollect / TNerveElecCarapaceReturn: it flies straight to the owner over 64
// ticks). Without its shell (unk1A4) the Koopa can be stomped (else a stomp shocks Mario).
// Sprayed it freezes (TNerveElecNokonokoFreeze); a frozen one its shell returns to within 200
// is electrocuted (isDeadByThunder: dies melting, leaving a coin where the shell is). After 800
// ticks without its shell, or once the shell is gone, it grows a new one
// (TNerveElecNokonokoRebirth).
//
// Not here: the sparks and shock particles, the spark / shock sounds, the shell's shadow; the
// material table (dennoko_model1.bmt) is the viewer's (MActor.bmt).

import { fr, V3, MsIsInSight, MsRandF } from '../math.js';
import { World, Stream, HitActor, SpineEnemy, PathNode, LF, HF, HC, MSG, ANM_BCK, ANM_FRAME_RATE, CUE_MOVE, nerve, Spine, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SmallEnemy, SmallEnemyManager, SmallEnemyNerves, LIVE_FLAG_MELT_ON_DEATH, rangeRand } from './smallEnemy.js';
import { WalkerEnemy, WalkerNerves, walkerParams } from './walker.js';
import { EnemyAttachment } from './gesso.js';
import { mapObjGlobals } from '../mapobj/base.js';
import type { BGCheckData } from '../collision.js';

/** TMsRange<s32>::rand */
const rangeRandI = (lo: number, hi: number) => lo + Math.trunc(fr((hi - lo) * MsRandF()));

/** TElecNokonokoSaveLoadParams */
const ELEC_PARAMS = {
    mSLReadyTime: ['i', 300], mSLCarapaceGravity: ['f', 0.01], mSLCarapaceSpeed: ['f', 5], mSLCarapaceTurnSpeed: ['f', 2], mSLCarapaceSpinSpeed: ['f', 2],
    mSLCarapaceShootRange: ['f', 500], mSLCarapaceFlyDist: ['f', 100],
} satisfies PSchema;

// dennoko_bastable order (the folder's BCKs; the unnamed ones have no .bas)
const BCK_CATCH = 0, BCK_DOWN = 1, BCK_ELEC_DOWN = 2, BCK_HIT = 3, BCK_MOGAKI_END = 5, BCK_MOGAKI = 6, BCK_MOGAKI_START = 7, BCK_UNK8 = 8,
    BCK_UNK9 = 9, BCK_RUN = 10, BCK_RUN_START = 11, BCK_SHOOT = 12, BCK_SUPPLY = 13, BCK_TURN_END = 14, BCK_TURN = 15, BCK_TURN_START = 16, BCK_WAIT = 17;

// ---------------------------------------------------------------- TElecCarapace
export class ElecCarapace extends EnemyAttachment {
    unk16C: ElecNokonoko | null = null;
    unk170: HitActor | null = null;
    /** unk174 the zigzag's phase, unk175 straight (after a wall), unk176 bounced, unk180 the wall-bounce cooldown, unk184 coming back */
    unk174 = 1; unk175 = 0; unk176 = 0;
    /** unk178 / unk17C the zigzag's cycle and angle, unk188 its spin */
    unk178 = 0; unk17C = 0; unk180 = 0; unk184 = 0; unk188 = 0;
    unk18C = new V3(); unk198 = 0;
    constructor(w: World, name = 'ノコノコ甲羅') { super(w, name); }
    get host() { return this.unk16C!; }
    loadInit(host: SpineEnemy, file: string) {
        super.loadInit(host, file);
        this.unk16C = host as ElecNokonoko;
        this.world.addToGroup('敵グループ', this);
        this.initHitActor(AT.ELEC_CARAPACE, 3, HC.PLAYER | HC.ENEMY | HC.BOSS, 80, 80, 60, 60);
        this.offHitFilter(HF.NO_COLLISION);
        this.unk150 = 0;
        this.spine!.initWith(CarapaceNerves.move);
        if (rangeRandI(0, 300) < 150) this.unk174 = 0;
        this.headHeight = 80;
    }
    isState(s: number) { return this.unk150 === s; }
    perform(cue: number) {
        super.perform(cue);
        if ((cue & CUE_MOVE) && this.unk180 !== 0) { this.unk180++; if (this.unk180 > 5) this.unk180 = 0; }
        // (CUE_ENTRY: its shadow)
    }
    setBehavior() {
        if (this.host.checkLiveFlag(LF.DEAD)) this.kill();
        if (this.unk168) this.pos.y = this.groundHeight;
        this.unk168 = 0;
    }
    behaveToHitGround() {
        if (this.unk176 !== 0) this.unk184 = 1;
        if (this.groundPlane.isWaterSurface()) this.kill();
        this.unk176 = 0;
        this.unk168 = 1;
        this.offLiveFlag(LF.AIRBORNE);
        this.vel.set(0, 0, 0);
    }
    behaveToHitWall(d?: BGCheckData) {
        if (this.unk180 > 0 || !ElecNokonoko.mReflectSw || !d) return;
        this.unk180 = 1; this.unk184 = 0; this.unk176 = 1; this.unk175 = 1;
        const n = new V3(d.n[0], d.n[1], d.n[2]);
        const speed = fr(this.posDelta.dot(n));
        this.vel.x = fr(fr(-1.5 * speed) * n.x);
        this.vel.y = 3;
        this.vel.z = fr(fr(-1.5 * speed) * n.z);
        this.pos.y = fr(this.groundHeight + 2);
        this.setGoalPath(new PathNode(null, this.host.pos.clone()));
    }
    getNowGravity() { return this.host.unk1A0.mSLCarapaceGravity; }
    getPhaseShift() { return this.unk174 !== 0 ? 0 : 180; }
    appear() {
        if (this.unk150 !== 0) return;
        this.unk150 = 1;
        this.pos.set(this.host.pos);
        const s = this.host.scale.x;
        this.unk164 = s;
        this.scale.set(s, s, s);
        this.bodyRadius = 50;
        this.unk170 = null;
        this.onHitFilter(HF.NO_COLLISION);
    }
    rebirth() { }
    recoverScale() { }
    shoot() {
        this.unk180 = 0;
        if (this.unk150 === 2) return;
        const goal = V3.sub(this.world.mario.pos, this.pos).normalize().fround();
        const dist = this.host.unk1A0.mSLCarapaceFlyDist;
        goal.x = fr(goal.x * dist);
        goal.y = fr(goal.y * this.pos.y);   // (the game's: by its height)
        goal.z = fr(goal.z * dist);
        goal.add(this.pos).fround();
        this.unk174 = this.unk174 ? 0 : 1;
        this.unk188 = 0;
        this.unk150 = 2;
        this.unk176 = 0; this.unk168 = 0; this.unk184 = 0; this.unk175 = 0;
        this.offHitFilter(HF.NO_COLLISION);
        this.spine!.initWith(CarapaceNerves.move);
        this.setGoalPath(new PathNode(null, goal));
        this.setZigParameter();
    }
    setZigParameter() {
        const k = rangeRand(3, 5);
        this.unk178 = fr(k * fr(V3.sub(this.goal104.point(), this.pos).length()));
        this.unk17C = rangeRand(20, 30);
    }
    bind() { this.control(); super.bind(); }
    calcRootMatrix() {
        const r = this.rot;
        const saved = r.y;
        r.y = fr(r.y + this.unk188);
        super.calcRootMatrix();
        r.y = saved;
    }
    sendMessage() {
        for (const a of this.collisions.slice()) {
            if (a.isActorType(AT.MARIO)) {
                if (this.world.mario.receiveMessage(this, MSG.ELECTRIC_SHOCK)) {
                    this.onHitFilter(HF.NO_COLLISION);
                    if (this.spine!.current !== CarapaceNerves.wait) this.spine!.pushNerve(CarapaceNerves.wait);
                }
            } else if (a === this.unk16C) this.offHitFilter(HF.NO_COLLISION);
            else if (a.isActorType(AT.WATER)) {
                // (three random angles a time, never used: the RNG still turns)
                for (let j = 0; j < 5; ++j) { rangeRandI(0, 360); rangeRandI(0, 360); rangeRandI(0, 360); }
            } else if (ElecNokonoko.mReflectSw) this.reflect(a);
        }
    }
    receiveMessage(_s: HitActor, msg: number) {
        if (msg === MSG.UNKD) this.kill();
        if (msg === MSG.TRAMPLE) this.world.mario.receiveMessage(this, MSG.ELECTRIC_SHOCK);
        return msg === MSG.SPRAYED_BY_WATER;
    }
    /** reflect: bounced off another actor, along the nearer axis */
    reflect(a: HitActor) {
        if (this.unk170 === a) return;
        this.unk184 = 0; this.unk170 = a; this.unk176 = 1; this.unk175 = 0;
        const d = new V3(fr(a.pos.x - this.pos.x), 0, fr(a.pos.z - this.pos.z));
        if (d.x === 0 && d.y === 0 && d.z === 0) d.x += 1;
        d.normalize().fround();
        const n = new V3(0, 0, 0);
        if (Math.abs(fr(d.z / d.x)) > 1) n.z = a.pos.z > this.pos.z ? 1 : -1;
        else n.x = a.pos.x > this.pos.x ? 1 : -1;
        const speed = fr(-7 * fr(d.dot(n)));
        this.vel.x = fr(d.x * speed); this.vel.y = 2; this.vel.z = fr(d.z * speed);
        this.pos.y = fr(2 + this.groundHeight);
        this.unk174 = 0;
        if ((this.vel.x > 0 && this.vel.z > 0) || (this.vel.x < 0 && this.vel.z < 0)) this.unk174 = 1;
        this.setGoalPath(new PathNode(null, this.host.pos.clone()));
    }
    move() {
        const P = this.host.unk1A0;
        const spin = P.mSLCarapaceSpinSpeed, speed = P.mSLCarapaceSpeed, turn = P.mSLCarapaceTurnSpeed;
        if (this.unk175 !== 0) this.walkToCurPathNode(speed, turn, 0);
        else this.zigzagToCurPathNode(speed, turn, this.unk178, this.unk17C);
        this.unk188 = fr(this.unk188 + spin);
        if (this.unk188 > 360) this.unk188 = fr(this.unk188 - 360);
    }
    isMove() { return this.spine!.current !== CarapaceNerves.wait; }
}

type CS = Spine<ElecCarapace>;
const CarapaceNerves: Record<string, any> = {};
CarapaceNerves.move = nerve<ElecCarapace>('TNerveElecCarapaceMove', (spine: CS) => {
    const self = spine.body;
    self.move();
    if (self.unk184 !== 0) {
        const range = fr(64 * self.host.unk1A0.mSLCarapaceSpeed);
        if (V3.sub(self.goal104.point(), self.pos).length() < range) {
            if (!self.host.isCatchReady()) self.host.forceCatchReady();
            spine.pushAfterCurrent(CarapaceNerves.ret);
            return true;
        }
    }
    const diff = V3.sub(self.goal104.point(), self.pos);
    diff.y = 0;
    if (self.unk176 === 0 && diff.squared() < 100) {
        if (self.unk184 !== 0) { spine.pushAfterCurrent(CarapaceNerves.ret); return true; }
        self.unk184 = 1;
        self.setGoalPath(new PathNode(null, self.host.pos.clone()));
    }
    return false;
});
CarapaceNerves.wait = nerve<ElecCarapace>('TNerveElecCarapaceWait', (spine: CS) => spine.time > 60);
CarapaceNerves.ret = nerve<ElecCarapace>('TNerveElecCarapaceReturn', (spine: CS) => {
    const self = spine.body, host = self.host;
    if (spine.time === 0) {
        const h = host.pos;
        self.unk18C.set(fr(fr(h.x - self.pos.x) * 0.015625), fr(fr(h.y - self.pos.y) * 0.015625), fr(fr(h.z - self.pos.z) * 0.015625));
        host.catchIn();
    }
    if (spine.time < 20) host.catchIn();
    if (host.isDeadByThunder()) { host.onLiveFlag(LIVE_FLAG_MELT_ON_DEATH); host.kill(); }
    self.unk188 = fr(self.unk188 + host.unk1A0.mSLCarapaceSpinSpeed);
    if (self.unk188 > 360) self.unk188 = fr(self.unk188 - 360);
    self.pos.add(self.unk18C).fround();
    const h = host.pos.clone();
    if (self.unk18C.x > 0) { if (self.pos.x > h.x) self.pos.x = h.x; } else if (self.pos.x < h.x) self.pos.x = h.x;
    if (self.unk18C.y > 0) { if (self.pos.y > h.y) self.pos.y = h.y; } else if (self.pos.y < h.y) self.pos.y = h.y;
    if (self.unk18C.z > 0) { if (self.pos.z > h.z) self.pos.z = h.z; } else if (self.pos.z < h.z) self.pos.z = h.z;
    if (host.checkLiveFlag(LF.DEAD)) {
        self.scale.y = fr(self.scale.y * 0.8);
        if (self.scale.y < 0.01) self.kill();
    }
    return false;
});

// ---------------------------------------------------------------- TElecNokonoko
export class ElecNokonoko extends WalkerEnemy {
    static mReflectSw = true;
    static mCarapaceJntIndex = 0;
    unk194: ElecCarapace | null = null;
    unk198 = 0; unk19C = 0;
    /** unk1A4: its shell is thrown (it has none) */
    unk1A4 = 0;
    unk1A8 = new V3();
    get unk1A0(): any { return this.getSaveParam(); }
    constructor(w: World, name = '電気ノコノコ') { super(w, name); }
    get shell() { return this.unk194!; }
    hasCarapace() { return this.unk1A4 === 0; }
    init(m: any) {
        super.init(m);
        this.actorType = AT.ELEC_NOKONOKO;
        this.unk150 = 17;
        this.unk194 = new ElecCarapace(this.world);
        this.spine!.initWith(WalkerNerves.graphWander);
        this.unk194.loadInit(this, 'koura_model1.bmd');
        if (this.unk194.mactor) this.unk194.mactor.bmt = this.unk194.mactor.data.folder + '/dennoko_model1.bmt';
        this.unk19C = rangeRandI(0, 300);
        this.offHitFilter(HF.NO_COLLISION);
    }
    /** rest (sic: not reset, so never called) */
    rest() { WalkerEnemy.prototype.reset.call(this); this.scaledBodyRadius = 140; }
    load(s: Stream) { super.load(s); this.reset(); }
    setMActorAndKeeper() {
        this.mactor = this.createMActorByName('dennoko_model1.bmd');
        if (this.mactor) this.mactor.bmt = this.mactor.data.folder + '/dennoko_model1.bmt';
    }
    moveObject() {
        super.moveObject();
        if (this.isBckAnm(BCK_RUN_START) && this.checkCurAnmEnd(ANM_BCK)) this.setBckAnm(BCK_RUN);
    }
    attackToMario() {
        const c = this.spine!.current;
        if (c === SmallEnemyNerves.die) return;
        SmallEnemy.prototype.attackToMario.call(this);
        const c2 = this.spine!.current;
        if (c2 === ElecNerves.attack || c2 === ElecNerves.collect || c2 === ElecNerves.shoot) return;
        if (!this.hasCarapace()) return;
        this.spine!.pushNerve(ElecNerves.attack);
    }
    /** calcRootMatrix: TSpineEnemy's (the spark and shock particles aside) */
    calcRootMatrix() { SpineEnemy.prototype.calcRootMatrix.call(this); }
    sendAttackMsgToMario() { this.world.mario.receiveMessage(this, this.unk1A4 === 0 ? MSG.ELECTRIC_SHOCK : MSG.ATTACK); }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (msg === MSG.UNKD || msg === MSG.UNKB) { this.onLiveFlag(LF.DEAD); this.kill(); }
        if (msg === MSG.TAKE && !this.holder) { this.onHitFilter(HF.NO_COLLISION); this.holder = sender as any; return true; }
        if ((msg === MSG.PUT || msg === MSG.THROWN) && this.holder === sender) { this.holder = null; return true; }
        if (msg === MSG.TRAMPLE) {
            if (this.unk1A4 === 1) { this.hitPoints = 1; this.kill(); return true; }
            this.world.mario.receiveMessage(this, MSG.ELECTRIC_SHOCK);
            return false;
        }
        if (msg === MSG.SPRAYED_BY_WATER) {
            if (!this.changeByJuice()) this.behaveToWater(sender);
            else this.shell.kill();
            return true;
        }
        return false;
    }
    isResignationAttack() {
        const r = this.unk1A0.mSLCarapaceShootRange;
        if (!this.checkLiveFlag(LF.CLIPPED_OUT) && V3.sub(this.goal104.point(), this.pos).length() < r) {
            this.spine!.pushAfterCurrent(ElecNerves.shoot);
            return true;
        }
        return false;
    }
    behaveToFindMario() {
        const s = this.spine!;
        s.pushAfterCurrent(WalkerNerves.graphWander);
        s.pushAfterCurrent(WalkerNerves.attack);
        s.pushAfterCurrent(ElecNerves.turn);
        this.setGoalPath(new PathNode(this.world.mario));
    }
    behaveToWater(_a: HitActor) {
        if (this.isBckAnm(BCK_SHOOT) && this.getCurAnmFrameNo(ANM_BCK) > 58) return;
        if (this.spine!.current === SmallEnemyNerves.die || (this.isBckAnm(BCK_CATCH) && this.unk1A4 === 0)) return;
        this.unk165 = true;
        this.sprayCooldown = 0;
        if (this.spine!.current === ElecNerves.freeze) return;
        this.spine!.pushNerve(ElecNerves.freeze);
    }
    catchIn() { if (this.isBckAnm(BCK_UNK8)) this.setBckAnm(BCK_CATCH); }
    shootIn() { this.shell.shoot(); this.unk1A4 = 1; }
    setWaitAnm() { this.unk198 = 0; this.setBckAnm(BCK_WAIT); }
    setWalkAnm() { if (!this.isBckAnm(BCK_RUN)) this.setBckAnm(BCK_RUN_START); }
    setRunAnm() { if (!this.isBckAnm(BCK_RUN)) this.setBckAnm(BCK_RUN_START); }
    setDeadAnm() { this.setBckAnm(BCK_DOWN); }
    setMeltAnm() {
        this.setBckAnm(BCK_ELEC_DOWN);
        this.onLiveFlag(LF.UNK8);
        this.unk18C = 3;
        this.shell.vel.set(0, 0, 0);
    }
    genRandomItem() {
        this.shell.kill();
        super.genRandomItem();
        if (this.checkLiveFlag(LIVE_FLAG_MELT_ON_DEATH)) {
            const im = mapObjGlobals(this.world).itemManager as any, p = this.shell.pos;
            const o = im ? im.makeObjAppearAt(p.x, p.y, p.z, AT.COIN, true) : null;
            if (o) { o.vel.set(0, 20, 0); o.offLiveFlag(LF.UNK10); }
        }
    }
    isShootReady() { return false; }
    isCatchReady() { return this.spine!.current === ElecNerves.collect; }
    forceCatchReady() {
        const c = this.spine!.current;
        if (c !== SmallEnemyNerves.die && c !== ElecNerves.freeze && c !== ElecNerves.collect) this.spine!.setNext(ElecNerves.collect);
    }
    isDeadByThunder() {
        if (this.spine!.current === ElecNerves.freeze) return V3.sub(this.pos, this.shell.pos).length() < 200;
        return false;
    }
    recoverCarapace() { }
}

type S = Spine<ElecNokonoko>;
const ElecNerves: Record<string, any> = {};
ElecNerves.shoot = nerve<ElecNokonoko>('TNerveElecNokonokoShoot', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(BCK_UNK9);
    if (self.isBckAnm(BCK_UNK9)) {
        if (self.checkCurAnmEnd(ANM_BCK)) { self.setBckAnm(BCK_SHOOT); self.unk198 = 0; }
    } else if (self.isBckAnm(BCK_SHOOT)) {
        const fc = self.mactor!.getFrameCtrl(ANM_BCK)!;
        if (fc.checkPass(60)) self.shell.appear();
        if (self.getCurAnmFrameNo(ANM_BCK) < 62) self.walkToCurPathNode(0, self.turnSpeed, 0);
        if (fc.checkPass(62)) self.shootIn();
        if (self.checkCurAnmEnd(ANM_BCK)) { spine.pushAfterCurrent(ElecNerves.collect); return true; }
    }
    return false;
});
ElecNerves.collect = nerve<ElecNokonoko>('TNerveElecNokonokoCollect', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        if (!self.isBckAnm(BCK_CATCH)) self.setBckAnm(BCK_UNK8);
        self.setGoalPath(new PathNode(self.shell));
    }
    self.mactor!.setFrameRate(self.shell.isMove() ? ANM_FRAME_RATE : 0, ANM_BCK);
    if (self.isBckAnm(BCK_CATCH)) {
        const frame = Math.trunc(self.getCurAnmFrameNo(ANM_BCK));
        if (frame > 20) self.shell.onHitFilter(HF.NO_COLLISION);
        if (frame > 32) { self.unk1A4 = 0; self.shell.kill(); }
        if (self.checkCurAnmEnd(ANM_BCK)) return true;
    } else if (spine.time > 800 || self.shell.checkLiveFlag(LF.DEAD)) {
        spine.pushAfterCurrent(ElecNerves.rebirth);
        return true;
    }
    self.walkToCurPathNode(0, self.turnSpeed, 0);
    return false;
});
ElecNerves.turn = nerve<ElecNokonoko>('TNerveElecNokonokoTurn', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.setBckAnm(BCK_TURN_START); self.setGoalPath(new PathNode(self.world.mario)); }
    if (self.isBckAnm(BCK_TURN) && MsIsInSight(self.pos, self.rot.y, self.world.mario.pos, self.P.mSLSearchLength, 60, 0)) self.setBckAnm(BCK_TURN_END);
    if (self.checkCurAnmEnd(ANM_BCK)) {
        if (self.isBckAnm(BCK_TURN_START)) self.setBckAnm(BCK_TURN);
        else if (self.isBckAnm(BCK_TURN_END)) return true;
    }
    if (fr(self.pos.x - self.shell.pos.x) === 0 && fr(self.pos.z - self.shell.pos.z) === 0) self.pos.x = fr(self.pos.x + 1);
    self.walkToCurPathNode(0, self.turnSpeed, 0);
    return spine.time > 500;
});
ElecNerves.freeze = nerve<ElecNokonoko>('TNerveElecNokonokoFreeze', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(self.hasCarapace() ? BCK_HIT : BCK_MOGAKI_START);
    // (BCK_HIT before frame 25: the spark particle at joint 8, unk1A8)
    if (self.checkCurAnmEnd(ANM_BCK)) {
        if (self.isBckAnm(BCK_MOGAKI_START)) self.setBckAnm(BCK_MOGAKI);
        else if (self.isBckAnm(BCK_MOGAKI)) {
            if (!self.unsetUnk165() && self.hasCarapace()) self.setBckAnm(BCK_MOGAKI_END);
            else self.setBckAnm(BCK_MOGAKI);
        } else return true;
    }
    if (spine.time > 400) {
        spine.reset();
        spine.setDefaultNext();
        spine.pushAfterCurrent(ElecNerves.rebirth);
        return true;
    }
    return false;
});
ElecNerves.rebirth = nerve<ElecNokonoko>('TNerveElecNokonokoRebirth', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.setBckAnm(BCK_SUPPLY); self.unk1A4 = 0; self.shell.kill(); }
    if (self.checkCurAnmEnd(ANM_BCK)) { spine.pushAfterCurrent(WalkerNerves.graphWander); return true; }
    return false;
});
ElecNerves.attack = nerve<ElecNokonoko>('TNerveElecNokonokoAttack', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0 || !self.isBckAnm(BCK_HIT)) self.setBckAnm(BCK_HIT);
    return self.checkCurAnmEnd(ANM_BCK);
});

export class ElecNokonokoManager extends SmallEnemyManager {
    constructor(w: World, name = '電気ノコノコマネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.saveParams = walkerParams('/enemy/elecNokonoko.prm', this.world.files, ELEC_PARAMS);
    }
    initSetEnemies() { }
    createModelData() { this.createModelDataArray(['dennoko_model1.bmd']); }
    createEnemyInstance(): SpineEnemy | null { return new ElecNokonoko(this.world); }
    /** clipEnemies: every one (and its shell, when out) against the view, ENABLE_CLIPPING or not */
    clipActors() {
        const p = this.saveParams;
        const far = p ? p.mSLFarClip : 5000, r = p ? p.mSLClipRadius : 300;   // (TConductor's mEnemyFarClip without params)
        for (const o of this.objs as ElecNokonoko[]) {
            if (this.world.inView(o.pos, r, far)) o.offLiveFlag(LF.CLIPPED_OUT); else o.onLiveFlag(LF.CLIPPED_OUT);
            const c = o.unk194;
            if (c && !c.isState(0)) { if (this.world.inView(c.pos, r, far)) c.offLiveFlag(LF.CLIPPED_OUT); else c.onLiveFlag(LF.CLIPPED_OUT); }
        }
    }
    perform(cue: number) {
        super.perform(cue);
        for (let i = 0; i < this.getActiveObjNum(); ++i) { const c = (this.objs[i] as ElecNokonoko).unk194; if (c) c.testPerform(cue); }
    }
}

register('ElecNokonokoManager', (w, n) => new ElecNokonokoManager(w, n));
register('ElecNokonoko', (w, n) => new ElecNokonoko(w, n));
