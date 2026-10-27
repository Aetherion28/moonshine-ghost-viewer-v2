// THinokuri2 / THinokuri2Manager (Enemy/hinokuri2.cpp): the giant goop-spilling chestnut boss
// (ヒノクリ２, scene.bin "HinoKuri2"; its level follows the map and episode). It walks the "hinokuri" graph (TWalker binds it), jumps between
// nodes flagged for it, and every mSLPolIntervalMin..Max ticks stops (TNerveHino2PrePol) to
// stamp the ground (TNerveHino2Stamp: Mario near is knocked down, SUPER_HIP_DROP) or to open up
// and spill goop (TNerveHino2Pollute), when its open body takes water (level 1, TNerveHino2Damage)
// until its hit points run out: it squats, bursts and goes down a level. Level 2 wears a mask
// that three hits (water or a barrel) knock off; level 0 is frozen by water and dies to a stomp.
// Every 600 movement ticks it makes a Namekuri or Hamukuri appear (generateEnemy).
// Its four hit objects (THino2Hit: head, body, two feet) follow joints and forward what hits them;
// the feet trample Mario and goop blobs while it walks.
//
// Not here: particles (goop / water), sounds, camera shakes, the shadow, the question manager,
// THino2Mask's drawing (only its hit count is kept), THino2MtxCalc's animation blending and foot
// IK and the head callback's scaling (the joints are the plain BCK's).

import { fr, V3, MsWrap, MsAngleDiff, MsGetRotFromZaxisY, MsClamp, MsRandF } from '../math.js';
import { World, SpineEnemy, EnemyManager, HitActor, LF, HF, HC, MSG, ANM_BCK, nerve, Spine, Stream, Params, PSchema, SPINE_PARAMS, LiveManager } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { Walker } from './walker.js';
import { mapObjGlobals } from '../mapobj/base.js';
import { sendToMario } from '../mapobj/lib.js';
import type { WaterHitActor } from '../water.js';
import type { mat4 } from 'gl-matrix';
import { SE } from '../soundids.js';
import { holdKey } from '../sound.js';

/** THino2Params */
const HINO2_PARAMS = {
    ...SPINE_PARAMS,
    mSLMarchSpeedLv0: ['f', 6], mSLMarchSpeedLv1: ['f', 4], mSLMarchSpeedLv2: ['f', 4], mSLTurnSpeedLv0: ['f', 1.5], mSLTurnSpeedLv1: ['f', 1.5],
    mSLTurnSpeedLv2: ['f', 1.5], mSLBodyScale: ['f', 1.9], mSLWalkShake: ['f', 4000], mSLJumpShake: ['f', 4000], mSLGravityY: ['f', 0.4],
    mSLPrePolWait: ['i', 2], mSLPolWaitCount: ['i', 2], mSLPolIntervalMin: ['i', 2000], mSLPolIntervalMax: ['i', 3000], mSLDamageHeadScale: ['f', 1.3],
    mSLDamageTimer: ['i', 1800], mSLHeadHitR: ['f', 50], mSLHeadHitH: ['f', 20], mSLBodyHitR: ['f', 175], mSLBodyHitH: ['f', 180],
    mSLBodyHitR0: ['f', 200], mSLBodyHitH0: ['f', 0.5], mSLBankProp: ['f', 10], mSLBankLimit: ['f', 10], mSLJumpQuakeLen: ['f', 2000],
    mSLStampProb: ['f', 0.5], mSLStampCount: ['i', 10], mSLStampQuakeLen: ['f', 2000], mSLWaterEmitPos: ['f', 1000], mSLHitPointMaxLv0: ['u8', 1],
    mSLHitPointMaxLv1: ['u8', 150], mSLHitPointMaxLv2: ['u8', 100], mSLFreezeTimerLv0: ['i', 1800], mSLInvincibleTimer: ['i', 300], mSLWalkSpeedRateLv0: ['f', 1.2],
} satisfies PSchema;
type Hino2Params = { [K in keyof typeof HINO2_PARAMS]: number };

/** BCK indices (hinokuri2's archive order) */
const BCK = {
    APPEAR: 0x0, CLOSE: 0x1, C_OPEN: 0x2, C_OPEN_WAIT: 0x3, C_TO_WAIT: 0x4, DAMAGE: 0x5, DIVE: 0x8, JUMP_IN: 0x9, BURST: 0xA, JIDANDA: 0xB, JUMP: 0xC,
    DIE: 0xD, LANDING: 0xE, MASK_DAMAGE: 0xF, OPEN: 0x10, OPEN_WAIT: 0x11, SQUAT: 0x13, SQUAT_END: 0x14, TURN: 0x15, WAIT: 0x16, WALK: 0x18,
};

export class Hinokuri2Manager extends EnemyManager {
    constructor(w: World, name = 'ヒノクリ２マネージャ') { super(w, name); }
    load(s: Stream) {
        this.saveParams = new Params('/enemy/hinokuri2.prm', this.world.files).read(HINO2_PARAMS);
        super.load(s);
    }
    createModelData() { this.createModelDataArray(['hinokuri2_model.bmd', 'hinokuri2_mask_model.bmd', 'hinokuri2_mask_model_l.bmd', 'hinokuri2_mask_model_r.bmd']); }
    createEnemyInstance() { return new Hinokuri2(this.world, 'ヒノクリ２'); }
}

/** THino2Hit: a hit object at one of its joints, passing on what hits it */
export class Hino2Hit extends HitActor {
    constructor(public owner: Hinokuri2, public jointIdx: number, name: string) { super(name); }
    perform(cue: number) {
        if (!(cue & 0x1)) return;
        const o = this.owner;
        if (o.checkLiveFlag(LF.CLIPPED_OUT)) { this.pos.set(o.pos); return; }
        this.pos.set(o.getJointTrans(this.jointIdx));
        if (this.jointIdx === 0x19) this.pos.y = fr(this.pos.y - 140);
        if (!o.unk188) return;
        for (const col of this.collisions.slice()) {
            if (this.jointIdx !== 0x10 && this.jointIdx !== 0x9) continue;
            if (col.isActorType(AT.MARIO)) col.receiveMessage(this, MSG.ATTACK);
            else if ((col.isActorType(AT.NAME_KURI) || col.isActorType(AT.HAMU_KURI)) && o.mactor!.checkCurBckFromIndex(BCK.LANDING)) col.receiveMessage(this, MSG.HIP_DROP);
        }
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        const o = this.owner;
        if (this.jointIdx === 0x19) {
            if (sender.isActorType(AT.MARIO) || (sender.isActorType(AT.WATER) && msg === MSG.SPRAYED_BY_WATER) || sender.isActorType(AT.WOOD_BARREL)) {
                o.jointIdxMessageCameFrom = this.jointIdx; return o.receiveMessage(sender, msg);
            }
        }
        if (this.jointIdx === 0x13) {
            if ((sender.isActorType(AT.WATER) && msg === MSG.SPRAYED_BY_WATER) || sender.isActorType(AT.WOOD_BARREL)) {
                o.jointIdxMessageCameFrom = this.jointIdx; return o.receiveMessage(sender, msg);
            }
        }
        return false;
    }
}

/** THino2Mask: level 2's mask (unk4: 1 worn, 2 flying off, 0 gone; unkC its hits, the BTP frame) */
class Hino2Mask {
    unk4 = 1; unk8 = 0; unkC = 0;
    constructor(public unk0: Hinokuri2) { }
    reset() { this.unk4 = 2; this.unk8 = 0; }
    /** perform's CUE_CALC_ANIM count of the flying pieces (their matrices aren't kept) */
    perform(cue: number) {
        if (this.unk4 === 0 || this.unk4 === 1) return;
        if (cue & 0x2) { if (this.unk8 > 240) { this.unk4 = 0; return; } ++this.unk8; }
    }
}

export class Hinokuri2 extends SpineEnemy {
    unk158 = 0; mCurrentBck = -1; mWaitTimer = 0; unk164 = 0; unk168 = 0;
    /** THinokuri2::updateAnmSound: its own, and while unk158 > 0 the seed level loop */
    updateAnmSound() { super.updateAnmSound(); if (this.unk158 > 0) this.world.sound(SE.BS_HINO_SEED_LQ_LEV, this.pos, { hold: holdKey(this, 'seed') }); }
    mHead: Hino2Hit; mBody: Hino2Hit; unk174: Hino2Hit; unk178: Hino2Hit;
    jointIdxMessageCameFrom = 0; unk180 = 0; unk184 = 0; unk188 = 0; unk18C = 0; unk190 = 0; unk194 = 1; unk198 = 0;
    unk1A4: Hino2Mask | null = null; mLevel = 0;
    /** the model's joints as the last calc left them */
    joints: mat4[] | null = null;
    get P(): Hino2Params { return this.getSaveParam(); }
    constructor(w: World, name = 'ヒノクリ２') {
        super(w, name);
        this.binder = new Walker();
        this.mHead = new Hino2Hit(this, 25, 'ヒノクリ２ヒットオブジェクト');
        this.mBody = new Hino2Hit(this, 19, 'ヒノクリ２ヒットオブジェクト');
        this.unk174 = new Hino2Hit(this, 9, 'ヒノクリ２ヒットオブジェクト');
        this.unk178 = new Hino2Hit(this, 16, 'ヒノクリ２ヒットオブジェクト');
    }
    init(m: LiveManager | null) {
        if (!m) return;
        this.manager = m;
        m.manageActor(this);
        this.mactor = this.createMActorByName('hinokuri2_model.bmd');
        this.unk1A4 = new Hino2Mask(this);
        this.tracer.init(this.world.graphByName('hinokuri'));
        this.spine!.initWith(Hino2Nerves.appear);
        this.reset();
        this.gravity = this.P.mSLGravityY;
        this.initHitActor(AT.HINOKURI2, 5, 0, this.bodyRadius, this.headHeight, this.bodyRadius, this.headHeight);
        for (const h of [this.mHead, this.mBody, this.unk178, this.unk174]) this.world.addToGroup('敵グループ', h);
        const H = this.mHead;
        this.mHead.initHitActor(AT.HINOKURI2, 5, HC.MAP_OBJECT | HC.WATER, H.attackRadius, H.attackHeight, H.damageRadius, H.damageHeight);
        this.mBody.initHitActor(AT.HINOKURI2, 5, HC.PLAYER | HC.MAP_OBJECT | HC.WATER, H.attackRadius, H.attackHeight, H.damageRadius, H.damageHeight);
        this.unk174.initHitActor(AT.HINOKURI2, 5, HC.PLAYER | HC.ENEMY, 70, 120, 70, 120);
        this.unk178.initHitActor(AT.HINOKURI2, 5, HC.PLAYER | HC.ENEMY, 70, 120, 70, 120);
        this.validateCollisionAll();
        const w = this.world;
        if (w.map === 1) this.setLevel(w.stage === 4 ? 2 : 1);
        else if (w.map === 0) this.setLevel(w.stage === 7 ? 2 : 1);
        else this.setLevel(this.instanceIndex);
        this.hitPoints = this.calcHitPoints();
    }
    calcHitPoints() {
        const P = this.P;
        switch (this.mLevel) {
            case 0: return P.mSLHitPointMaxLv0;
            case 1: return P.mSLHitPointMaxLv1;
            case 2: return P.mSLHitPointMaxLv2;
            default: return P ? P.mSLHitPointMax : 1;
        }
    }
    reset() {
        super.reset();
        this.onLiveFlag(LF.UNK8);
        this.resetPolInterval();
        this.hitPoints = this.calcHitPoints();
        this.validateCollisionAll();
        this.unk190 = 0;
    }
    kill() { this.invalidateCollisionAll(); super.kill(); }
    /** resetPolInterval: min + (int)((max - min) * MsRandF()) */
    resetPolInterval() {
        const l = this.P.mSLPolIntervalMin, r = this.P.mSLPolIntervalMax;
        this.unk164 = l + Math.trunc(fr(MsRandF() * (r - l)));
    }
    invalidateCollisionAll() { this.onHitFilter(HF.NO_COLLISION); for (const h of [this.mHead, this.mBody, this.unk174, this.unk178]) h.onHitFilter(HF.NO_COLLISION); }
    // (the game's "validate" also turns the body's own collision off: only the hit objects collide)
    validateCollisionAll() { this.onHitFilter(HF.NO_COLLISION); for (const h of [this.mHead, this.mBody, this.unk174, this.unk178]) h.offHitFilter(HF.NO_COLLISION); }
    setLevel(level: number) {
        if (level < 0) level = 0; else if (level >= 3) level = 2;
        this.mLevel = level;
        const P = this.P;
        if (P) {
            switch (this.mLevel) {
                case 0: this.marchSpeed = P.mSLMarchSpeedLv0; this.turnSpeed = P.mSLTurnSpeedLv0; break;
                case 1: this.marchSpeed = P.mSLMarchSpeedLv1; this.turnSpeed = P.mSLTurnSpeedLv1; break;
                default: this.marchSpeed = P.mSLMarchSpeedLv2; this.turnSpeed = P.mSLTurnSpeedLv2; break;
            }
            this.bodyScale = P.mSLBodyScale;
            this.scale.set(this.bodyScale, this.bodyScale, this.bodyScale);
        }
        const g = this.world.graphs.get('hinokuri');
        if (g) { this.tracer.init(g); this.tracer.reset(); this.goToShortestNextGraphNode(); }
    }
    /** getJointTransByIndex */
    getJointTrans(i: number) {
        const m = this.joints && this.joints[i];
        return m ? new V3(fr(m[12]), fr(m[13]), fr(m[14])) : this.pos.clone();
    }
    generateEnemy() {
        const p = this.checkLiveFlag(LF.CLIPPED_OUT) ? new V3(this.pos.x, fr(this.pos.y + 100), this.pos.z) : this.getJointTrans(0x14);
        const name = MsRandF() > 0.5 ? 'ナメクリマネージャー' : 'ハムクリマネージャー';
        // (TConductor::makeEnemyAppear(p, name, 1, 0): the first dead one)
        this.world.conductor.makeOneEnemyAppear(p, name, 0);
    }
    /** changeBck (the blend into the new animation, THino2MtxCalc, isn't modelled) */
    changeBck(i: number) {
        if (i < 0) return;
        const a = this.mactor!;
        if (i !== a.getCurAnmIdx(ANM_BCK)) a.setBckFromIndex(i);
        this.mCurrentBck = i;
        const fc = a.getFrameCtrl(ANM_BCK);
        if (fc) fc.rate = this.mLevel === 0 && (i === 23 || i === 24 || i === 26 || i === 27) ? this.P.mSLWalkSpeedRateLv0 : 1;
    }
    receiveMessageLv0(sender: HitActor, msg: number) {
        const water = sender.isActorType(AT.WATER) && msg === MSG.SPRAYED_BY_WATER;
        if (this.jointIdxMessageCameFrom === 0x13 && water) return true;
        if (water) {
            if (this.jointIdxMessageCameFrom !== 0x19) return true;
            if (this.spine!.current !== Hino2Nerves.freeze) this.spine!.pushNerve(Hino2Nerves.freeze);
        }
        if (sender.isActorType(AT.MARIO) && msg === MSG.TRAMPLE) {
            if (this.jointIdxMessageCameFrom !== 0x19) return true;
            this.hitPoints = 0;
            if (this.spine!.current !== Hino2Nerves.die) { this.spine!.reset(); this.spine!.setNext(Hino2Nerves.die); }
        }
        return false;
    }
    receiveMessageLv1(sender: HitActor, msg: number) {
        const water = sender.isActorType(AT.WATER) && msg === MSG.SPRAYED_BY_WATER;
        if (this.jointIdxMessageCameFrom === 0x13 && water) return true;
        if (this.unk180 && water) {
            if (this.jointIdxMessageCameFrom !== 0x19) return true;
            const dmg = this.world.water ? this.world.water.getParticleAttack(sender as WaterHitActor) : 0;
            if (dmg <= 0) return true;
            if (dmg >= this.hitPoints) this.hitPoints = 0; else this.hitPoints -= dmg;
            ++this.unk18C;
            if (this.spine!.current !== Hino2Nerves.damage) this.spine!.setNext(Hino2Nerves.damage);
            return true;
        }
        if (this.unk180 && sender.isActorType(AT.WOOD_BARREL)) {
            if (this.jointIdxMessageCameFrom !== 0x19) return true;
            this.hitPoints = 0;
            if (this.spine!.current !== Hino2Nerves.damage) this.spine!.setNext(Hino2Nerves.damage);
            return true;
        }
        return false;
    }
    private maskHit() {
        this.unk190 += 1;
        this.unk1A4!.unkC += 1;
        this.unk168 = this.P.mSLInvincibleTimer;
        if (this.unk190 > 2) {
            this.unk190 = 0;
            this.setLevel(this.mLevel - 1);
            this.unk1A4!.reset();
            this.hitPoints = this.calcHitPoints();
            return true;
        }
        return false;
    }
    receiveMessageLv2(sender: HitActor, msg: number) {
        if (sender.isActorType(AT.WATER) && msg === MSG.SPRAYED_BY_WATER) {
            if (this.jointIdxMessageCameFrom !== 0x13) return true;
            const dmg = this.world.water ? this.world.water.getParticleAttack(sender as WaterHitActor) : 0;
            if (dmg <= 1) return true;
            this.maskHit();
            return true;
        }
        if (sender.isActorType(AT.WOOD_BARREL)) {
            if (this.jointIdxMessageCameFrom !== 0x13) return true;
            this.maskHit();   // (else the mask plays its damage BCK, 0xF)
            return true;
        }
        return false;
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (this.unk168) return false;
        switch (this.mLevel) {
            case 0: return this.receiveMessageLv0(sender, msg);
            case 1: return this.receiveMessageLv1(sender, msg);
            case 2: return this.receiveMessageLv2(sender, msg);
        }
        return false;
    }
    private setDamage(h: HitActor, r: number, ht: number) { h.damageRadius = r; h.calcEntryRadius(); h.damageHeight = ht; h.calcEntryRadius(); }
    moveObject() {
        if (this.checkLiveFlag(LF.DEAD)) return;
        if (this.unk164 > 0) --this.unk164;
        if (this.mLevel === 1) {
            const max = this.calcHitPoints();
            const dhp = max - this.hitPoints;
            const f12 = fr(fr(1 + fr(fr(this.P.mSLDamageHeadScale - 1) * fr(dhp / max))) - this.unk194);
            this.unk194 = fr(this.unk194 + (f12 > 0 ? Math.min(f12, fr(0.004)) : Math.max(f12, fr(-0.004))));
        } else this.unk194 = 1;
        if (this.world.moveTickCount % 600 === 0) this.generateEnemy();
        this.doShortCut();
        this.posDelta.zero(); this.rotDelta.zero();
        const P = this.P, s = this.bodyScale, k = this.unk194;
        this.setDamage(this.mHead, fr(k * fr(P.mSLHeadHitR * s)), fr(k * fr(P.mSLHeadHitH * s)));
        if (this.mLevel === 0) this.setDamage(this.mBody, fr(k * fr(P.mSLBodyHitR0 * s)), fr(k * fr(P.mSLBodyHitH0 * s)));
        else this.setDamage(this.mBody, fr(k * fr(P.mSLBodyHitR * s)), fr(k * fr(P.mSLBodyHitH * s)));
        this.updateSquareToMario();
        const oldRot = this.rot.y;
        this.control();
        this.bind();
        this.pos.add(this.posDelta);
        this.rot.add(this.rotDelta);
        this.unk198 = fr(this.unk198 + fr(-MsClamp(MsWrap(MsAngleDiff(this.rot.y, oldRot), -180, 180), -30, 30) * P.mSLBankProp));
        this.unk198 = MsWrap(this.unk198, -180, 180);
        const lim = P.mSLBankLimit;
        this.unk198 = MsClamp(this.unk198, -lim, lim);
        if (this.unk198 < 0) { let f = fr(0.1 + this.unk198); if (f > 0) f = 0; this.unk198 = f; }
        else { let f = fr(this.unk198 - 0.1); if (f < 0) f = 0; this.unk198 = f; }
        if (this.unk168 > 0) --this.unk168;
    }
    perform(cue: number) {
        this.mHead.perform(cue); this.mBody.perform(cue); this.unk174.perform(cue); this.unk178.perform(cue);
        if (cue & 0x2) {
            this.calcRootMatrix();
            this.mactor!.frameUpdate();
            if (!this.checkLiveFlag(LF.DEAD | LF.CLIPPED_OUT)) this.joints = this.mactor!.anmMtxAll(this.baseTR, this.scale);
        } else super.perform(cue);
        if (!this.checkLiveFlag(LF.DEAD | LF.CLIPPED_OUT)) {
            if (this.mLevel === 2 || this.unk1A4!.unk4 === 2) this.unk1A4!.perform(cue);
        }
    }
}

type S = Spine<Hinokuri2>;
const ends = (h: Hinokuri2) => h.mactor!.curAnmEndsNext(ANM_BCK);
const frameNo = (h: Hinokuri2) => Math.trunc(h.mactor!.getFrameCtrl(ANM_BCK)!.frame);
export const Hino2Nerves: Record<string, any> = {};
Hino2Nerves.appear = nerve<Hinokuri2>('TNerveHino2Appear', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(BCK.APPEAR);
    if (ends(self)) { self.goToExclusiveNextGraphNode(); spine.pushAfterCurrent(Hino2Nerves.graphWander); return true; }
    return false;
});
Hino2Nerves.graphWander = nerve<Hinokuri2>('TNerveHino2GraphWander', (spine: S) => {
    const self = spine.body;
    self.unk188 = 1;
    if (self.isReachedToGoal()) {
        if (self.jumpToNextGraphNode() >= 0) {
            spine.pushAfterCurrent(Hino2Nerves.graphWander); spine.pushAfterCurrent(Hino2Nerves.jumpIn); spine.pushAfterCurrent(Hino2Nerves.turn);
            return true;
        }
        self.goToExclusiveNextGraphNode();
        spine.pushAfterCurrent(Hino2Nerves.graphWander);
        return true;
    }
    if (self.world.stage >= 2 && self.unk164 <= 0) {
        if (self.mLevel >= 1) { spine.pushAfterCurrent(Hino2Nerves.prePol); return true; }
        self.resetPolInterval();   // (after emitPolParticle)
    }
    if (spine.time === 0) self.changeBck(BCK.WALK);
    if (self.mCurrentBck === BCK.WALK) self.walkToCurPathNode(self.marchSpeed, self.turnSpeed, 0);
    // (frames 0x24 / 0x55 of the walk shake the camera)
    return false;
});
Hino2Nerves.fly = nerve<Hinokuri2>('TNerveHino2Fly', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(BCK.JUMP);
    if (ends(self) && self.mCurrentBck !== BCK.DIVE) self.changeBck(BCK.DIVE);
    if (self.isReachedToGoal() || (spine.time > 0 && !self.isAirborne())) { spine.pushAfterCurrent(Hino2Nerves.landing); return true; }
    return false;
});
Hino2Nerves.jumpIn = nerve<Hinokuri2>('TNerveHino2JumpIn', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(BCK.JUMP_IN);
    if (ends(self)) {
        self.vel.set(self.calcVelocityToJumpToY(self.goal104.point(), self.tracer.unkC, self.getGravityY()));
        self.onLiveFlag(LF.AIRBORNE);
        spine.pushAfterCurrent(Hino2Nerves.fly);
        return true;
    }
    return false;
});
Hino2Nerves.landing = nerve<Hinokuri2>('TNerveHino2Landing', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(BCK.LANDING);
    return ends(self);
});
Hino2Nerves.turn = nerve<Hinokuri2>('TNerveHino2Turn', (spine: S) => {
    const self = spine.body;
    const d = V3.sub(self.goal.point(), self.pos);
    const diff = MsAngleDiff(MsWrap(MsGetRotFromZaxisY(d), 0, 360), self.rot.y);
    if (spine.time === 0 && Math.abs(diff) > 15 && self.mCurrentBck !== BCK.TURN) self.changeBck(BCK.TURN);
    const ts = self.turnSpeed;
    const t = diff > 0 ? Math.min(diff, ts) : Math.max(diff, -ts);
    self.rot.y = MsWrap(fr(self.rot.y + t), 0, 360);
    return Math.abs(t) < fr(ts * 0.5);
});
Hino2Nerves.prePol = nerve<Hinokuri2>('TNerveHino2PrePol', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(BCK.WAIT);
    if (self.mCurrentBck === BCK.WAIT && ends(self)) {
        const n = self.mWaitTimer + 1;
        if (n > self.P.mSLPrePolWait) {
            if (MsRandF() < self.P.mSLStampProb) spine.pushAfterCurrent(Hino2Nerves.stamp);
            else spine.pushAfterCurrent(Hino2Nerves.pollute);
            self.mWaitTimer = 0;
            return true;
        }
        self.mWaitTimer = n;
    }
    return false;
});
Hino2Nerves.pollute = nerve<Hinokuri2>('TNerveHino2Pollute', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.changeBck(BCK.C_OPEN); return false; }
    const b = self.mCurrentBck;
    if (b === BCK.C_OPEN) { if (ends(self)) { self.changeBck(BCK.C_OPEN_WAIT); self.unk180 = 1; } return false; }
    if (b === BCK.C_OPEN_WAIT) {
        if (ends(self)) {
            let n = self.mWaitTimer + 1;
            if (n > self.P.mSLPolWaitCount) { self.unk180 = 0; self.changeBck(BCK.OPEN); n = 0; }
            self.mWaitTimer = n;
        }
        return false;
    }
    if (b === BCK.OPEN) { if (ends(self)) self.changeBck(BCK.OPEN_WAIT); return false; }   // (and emitPolParticle)
    if (b === BCK.OPEN_WAIT) { if (ends(self)) self.changeBck(BCK.CLOSE); return false; }
    if (b === BCK.CLOSE && ends(self)) {
        self.hitPoints = self.calcHitPoints();
        self.resetPolInterval();
        spine.pushAfterCurrent(Hino2Nerves.graphWander);
        return true;
    }
    return false;
});
Hino2Nerves.damage = nerve<Hinokuri2>('TNerveHino2Damage', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.unk180 = 1; self.changeBck(BCK.DAMAGE); }
    if (ends(self)) {
        if (self.mCurrentBck === BCK.DAMAGE) self.changeBck(BCK.C_OPEN);
        if (self.mCurrentBck === BCK.C_OPEN) self.changeBck(BCK.C_OPEN_WAIT);
    }
    if (self.unk18C > 0) {
        if (self.mCurrentBck !== BCK.DAMAGE) self.changeBck(BCK.DAMAGE);
        self.unk18C = 0;
        if (self.hitPoints === 0) { self.unk180 = 0; spine.pushAfterCurrent(Hino2Nerves.squat); return true; }
    }
    if (spine.time >= self.P.mSLDamageTimer) {
        self.unk180 = 0;
        if (self.hitPoints === 0) { spine.pushAfterCurrent(Hino2Nerves.squat); return true; }
        if (self.mCurrentBck !== BCK.C_TO_WAIT) self.changeBck(BCK.C_TO_WAIT);
        if (ends(self) && self.mCurrentBck === BCK.C_TO_WAIT) {
            self.tracer.reset();
            self.goToShortestNextGraphNode();
            spine.reset();
            spine.pushAfterCurrent(Hino2Nerves.graphWander);
            self.hitPoints = self.calcHitPoints();
            self.resetPolInterval();
            return true;
        }
    }
    return false;
});
Hino2Nerves.squat = nerve<Hinokuri2>('TNerveHino2Squat', (spine: S) => {
    const self = spine.body;
    self.unk188 = 0;
    if (spine.time === 0) self.changeBck(BCK.SQUAT);
    if (ends(self)) {
        if (self.mCurrentBck === BCK.SQUAT) self.changeBck(BCK.SQUAT_END);
        if (self.mCurrentBck === BCK.SQUAT_END) { spine.pushAfterCurrent(Hino2Nerves.burst); return true; }
    }
    return false;
});
Hino2Nerves.burst = nerve<Hinokuri2>('TNerveHino2Burst', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(BCK.BURST);   // (and emitWaterParticle)
    if (ends(self)) {
        self.setLevel(self.mLevel - 1);
        self.hitPoints = self.calcHitPoints();
        self.tracer.reset();
        self.goToShortestNextGraphNode();
        spine.reset();
        spine.pushAfterCurrent(Hino2Nerves.graphWander);
        return true;
    }
    return false;
});
Hino2Nerves.die = nerve<Hinokuri2>('TNerveHino2Die', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.changeBck(BCK.DIE);
        const im = mapObjGlobals(self.world).itemManager as any;
        if (im) im.makeObjAppearAt(self.pos.x, self.pos.y, self.pos.z, AT.COIN, false);
        self.invalidateCollisionAll();
    }
    if (ends(self)) {
        self.tracer.reset();
        self.goToShortestNextGraphNode();
        spine.reset();
        spine.pushAfterCurrent(Hino2Nerves.graphWander);
        self.kill();
        return true;
    }
    return false;
});
Hino2Nerves.stamp = nerve<Hinokuri2>('TNerveHino2Stamp', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.changeBck(BCK.JIDANDA); self.mWaitTimer = 0; }
    if (ends(self)) {
        const n = self.mWaitTimer + 1;
        if (n > self.P.mSLStampCount) { self.mWaitTimer = 0; self.resetPolInterval(); spine.pushAfterCurrent(Hino2Nerves.graphWander); return true; }
        self.mWaitTimer = n;
    }
    const f = frameNo(self);
    if (!self.isAirborne() && (f === 0x1C || f === 0x3E)) {
        const q = self.P.mSLStampQuakeLen;
        if (self.distToMarioSq < fr(q * q)) sendToMario(self.world, self, MSG.SUPER_HIP_DROP);
    }
    return false;
});
Hino2Nerves.freeze = nerve<Hinokuri2>('TNerveHino2Freeze', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.changeBck(BCK.WAIT); self.unk184 = 1; }
    if (spine.time >= self.P.mSLFreezeTimerLv0) { self.unk184 = 0; return true; }
    return false;
});
Hino2Nerves.waitAnm = nerve<Hinokuri2>('TNerveHino2WaitAnm', (spine: S) => ends(spine.body));

register('HinoKuri2', (w, n) => new Hinokuri2(w, n));
register('HinoKuri2Manager', (w, n) => new Hinokuri2Manager(w, n));
