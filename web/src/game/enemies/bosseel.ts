// TBossEel / TBossEelManager / TBossEelTooth / TBossEelVortex / TBossEelEye / TBossEelHeartCoin /
// TBossEelCollision (body, barrier, bubble column) and the tears (TBEelTearsManager, TBEelTears,
// TBEelTearsDrop, TOilBall, TBossEelTearsRecoverCollision) (Enemy/bosseel.cpp): Eely-Mouth
// (めおとウナギ, "the married eels"), the boss of Noki Bay's underwater episode (mareBoss).
//
// The eel lies at the bottom of the pit (TNerveBossEelWaitAppear, meoto_in_loop) until Mario
// swims into the cube above its mouth (the mouth cube manager's cube 0: 7000 x 10000 x 7000 up
// from 9600 above it), then spins (TNerveBossEelFirstSpin: 360 ticks, accelerating by
// mSLSpinAccel up to mSLSpinMaxSpeed, either way round at random) and rises mSLAppearMoveDistY
// over its appear BCK (TNerveBossEelAppear). Out (TNerveBossEelOutWait) it keeps playing
// meoto_out_loop (or its tooth-damaged / tooth-broken variants); every mSLMouthOpenInterval
// ticks it opens its mouth (TNerveBossEelMouthOpenWait: open, then the breath-in BCK 14 with a
// vortex (TBossEelVortex) that pulls Mario toward it, eating him if he gets inside the mouth
// (canEatMario) after mSLMouthOpenFrame - mSLCanEatFrame ticks, closing at mSLMouthOpenFrame).
// Eating (TNerveBossEelEat) holds Mario (TAKE) through meoto_mogu, spits him out (DETACH +
// ATTACK) and dives back (TNerveBossEelQuickBack, which also heals every tooth still standing).
// After 3600 ticks out it dives back by itself (TNerveBossEelSlowBack); a broken bad tooth makes
// it dive and sleep a while (TNerveBossEelSleepOnBottom, shedding tears). Back at the bottom it
// spins again for a random 241..1200 ticks (TNerveBossEelSecondSpin) and comes up.
//
// Its eight teeth (TBossEelTooth on joints ha1..ha8: 1, 4, 7 bad, 6 gold) lose a point per water
// hit (mSLToothMaxHitPoint each); a bad tooth falls off at 1 (rising away as a bubble Mario can
// take), a clean one shines. All teeth at 1 or less and it dies (TNerveBossEelDie: the heart
// coins, the Shine from joint ha7). Bad teeth make it cry every 20 points, and while it waits its
// eyes cry tears (updateTearsCnt, every mSLGenTearsTime ticks, longer when Mario is far above):
// tears (TBEelTears) float up and hurt Mario; sprayed they burst into drops (TBEelTearsDrop) and
// a bubble (the recover collision) that refills Mario's air. Its body, the bubble column above
// its out pose and a barrier while it rises push Mario up (SMS_MarioMoveRequest), and its two
// jaw collisions (collideToMario) push him out of its mouth.
//
// For the viewer: the body's joints blend from one BCK to the next (initBckNormalMotionBlend:
// `locals`); the eyes, teeth, heart coin and tear drops are world.extras (their own baseTR).
// The animation moves on in the move ticks (MActor::calcAnm in TBossEel::perform's CUE_MOVE).
//
// Not here: particles, camera shakes, rumble, the BGM, the anm sounds (bas), the eyes' blend
// (drawing only), the 20 heart coins' items (gpItemManager->newAndRegisterCoinReal: the sim's
// coin hook returns null), the screen texture / indirect lighting, Mario's pad lock
// (onNeutralMarioKey) and the head map collisions (mUseMapCollision is false; meoto_out_loop's
// one-off setUpTrans). Balloons and demo cameras are 'balloon:<id>' / 'demo:<name>' effects.

import { fr, V3, Mtx, mtx, MsWrap, MsClamp, MsRandF, MsMtxSetXYZRPH, MsMtxSetRotRPH, JMASSin, s16 } from '../math.js';
import { World, Stream, HitActor, TakeActor, LiveActor, LiveManager, SpineEnemy, EnemyManager, MActor, LF, HF, HC, MSG, ANM_BCK, CUE_MOVE, CUE_CALC_ANIM,
    nerve, Spine, readParams, SPINE_PARAMS, PSchema, MoveCollision } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { mat4 } from 'gl-matrix';
import { Skeleton, parseBCK, jointMatricesBlend } from '../skeleton.js';
import { psVecNormalize } from '../camera/lib.js';
import { MTXConcat } from '../mapobj/lib.js';
import { mapObjGlobals } from '../mapobj/base.js';
import { CubeInfo, isPointInCube } from '../mapwire.js';
import { chase, jNormalize } from './jgeom.js';
import { rangeRand } from './smallEnemy.js';

/** TBEelTearsSaveLoadParams (/enemy/bossEelTears.prm) */
const TEARS_PARAMS = {
    ...SPINE_PARAMS,
    mSLTearsUpSpeed: ['f', 5], mSLTearsDamageUpSpeed: ['f', 1], mSLTearsLiveHeight: ['f', 2000], mSLTearsSplitNum: ['i', 2],
    mSLTearsDamageRadius: ['i', 600], mSLTearsDamageHeight: ['i', 400], mSLTearsAttackRadius: ['i', 500], mSLTearsAttackHeight: ['i', 300],
    mSLTearsDropDamageRadius: ['i', 600], mSLTearsDropDamageHeight: ['i', 400], mSLTearsDropAttackRadius: ['i', 500], mSLTearsDropAttackHeight: ['i', 300],
    mSLHighPolyDistY: ['f', 3000], mSLHitAnmFrameRate: ['f', 1], mSLBodyScaleLow: ['f', 1], mSLBodyScaleHigh: ['f', 1],
    mSLTearsDropScaleLow: ['f', 1], mSLTearsDropScaleHigh: ['f', 1],
} satisfies PSchema;
/** TBossEelSaveParams (/enemy/bosseel.prm) */
const EEL_PARAMS = {
    mSLInitTransYOffset: ['f', 0], mSLAppearMoveDistY: ['f', 6000], mSLBodyScale: ['f', 0.75], mSLViewClipFar: ['f', 25000], mSLViewClipRadius: ['f', 12000],
    mSLBodyToHeadDistance: ['f', 6000], mSLBodyAttackRadius: ['f', 2400], mSLBodyAttackHeight: ['f', 6300], mSLBodyDamageRadius: ['f', 2200],
    mSLBodyDamageHeight: ['f', 6100], mSLHeadAttackRadius: ['f', 3600], mSLHeadAttackHeight: ['f', 5600], mSLHeadDamageRadius: ['f', 3400],
    mSLHeadDamageHeight: ['f', 5400], mSLToothAttackRadius: ['f', 500], mSLToothAttackHeight: ['f', 300], mSLToothDamageRadius: ['f', 600],
    mSLToothDamageHeight: ['f', 400], mSLSpinAccel: ['f', 0.01], mSLSpinMaxSpeed: ['f', 10], mSLToothUpSpeed: ['f', 5], mSLToothLiveHeight: ['f', 2000],
    mSLToothMaxHitPoint: ['i', 50], mSLGenTearsTime: ['i', 100], mSLVortexAttackRadius: ['f', 500], mSLVortexAttackHeight: ['f', 300],
    mSLVortexDamageRadius: ['f', 600], mSLVortexDamageHeight: ['f', 400], mSLVortexLiveTimer: ['i', 300], mSLVortexScaleXZ: ['f', 1], mSLVortexScaleY: ['f', 1],
    mSLMouthOpenFrame: ['i', 500], mSLMouthOpenInterval: ['i', 2000], mSLCanEatFrame: ['i', 200], mSLBreathInPower: ['f', 10],
} satisfies PSchema;
type EelParams = { [K in keyof typeof EEL_PARAMS]: number };

// The body's BCKs by index (/scene/bosseel, folder order; the bas table names 10, 12, 16, 17).
const BCK_CLOSE = 2, BCK_DIE = 3, BCK_DIE_LOOP = 4, BCK_EAT_MISS = 5, BCK_BACK_BROKEN = 6, BCK_BACK = 9, BCK_IN_LOOP = 10, BCK_MOGU = 12,
    BCK_OPEN = 13, BCK_BREATH_IN = 14, BCK_APPEAR = 15, BCK_OUT_LOOP = 16, BCK_PAKU = 17, BCK_OUT_DAMAGED = 18, BCK_OUT_BROKEN = 19,
    BCK_TOOTH_FALL = 20, BCK_TOOTH_FALLEN = 21, BCK_TOOTH = 22;
/** TBossEel::LIVE_FLAG_UNK10000: spinning the other way round */
const LF_SPIN_REVERSE = LF.UNK10000;

// TBossEel's statics
const mOpenRollSpeed = 0.3, mUseObjCollision = true, mForcePow = 10, mUseMapCollision = false;

const rowMajor = (m: mat4): Mtx => { const r = mtx(); r[0] = m[0]; r[1] = m[4]; r[2] = m[8]; r[3] = m[12]; r[4] = m[1]; r[5] = m[5]; r[6] = m[9]; r[7] = m[13]; r[8] = m[2]; r[9] = m[6]; r[10] = m[10]; r[11] = m[14]; return r; };
const transMtx = (x: number, y: number, z: number) => { const m = mtx(); m[3] = x; m[7] = y; m[11] = z; return m; };
const sendToMario = (w: World, from: HitActor, msg: number) => w.mario.receiveMessage(from, msg);
/** SMS_MarioMoveRequest */
const marioMoveRequest = (w: World, p: V3) => { const m = w.mario as any; return m.moveRequest ? m.moveRequest(p) : false; };

/** A TSharedParts model (or a drop's) the viewer draws: world.extras, at the baseTR its owner sets. */
class PartModel extends LiveActor {
    constructor(owner: LiveActor, file: string, public visible: () => boolean) {
        super(owner.world, file);
        this.manager = owner.manager; this.mactor = this.createMActorByName(file); this.manager = null;
        this.offLiveFlag(LF.ENABLE_CLIPPING);
    }
    perform() { }
    drawn() { return this.visible(); }
}

// ================================================================ tears
/** TBEelTearsDrop (涙粒): a drop a burst tear leaves, rising away. */
export class BEelTearsDrop extends HitActor {
    active = false; riseSpeed = 0;
    model: PartModel;
    constructor(public owner: BEelTears, name = '涙粒') {
        super(name);
        const P = owner.TP;
        this.initHitActor(AT.BOSS_EEL_TEARS, 3, HC.PLAYER, P.mSLTearsDropAttackRadius, P.mSLTearsDropAttackHeight, P.mSLTearsDropDamageRadius, P.mSLTearsDropDamageHeight);
        owner.world.addToGroup('敵グループ', this);
        this.model = new PartModel(owner, 'tears_drop.bmd', () => this.active);
        this.model.mactor?.setBckFromIndex(0);
        owner.world.extras.push(this.model);
    }
    perform(cue: number) {
        if (cue & CUE_MOVE) {
            this.pos.y = fr(this.pos.y + this.riseSpeed);
            if (this.pos.y > this.owner.world.mario.pos.y + 2000) this.active = false;
        }
        if (cue & CUE_CALC_ANIM) {
            MsMtxSetXYZRPH(this.model.baseTR, this.pos.x, this.pos.y, this.pos.z, this.rot.x, this.rot.y, this.rot.z);
            const s = this.owner.TP.mSLTearsDropScaleLow;
            this.scale.set(s, s, s);
            this.model.scale.set(this.scale); this.model.pos.set(this.pos);
            this.model.mactor?.frameUpdate();
        }
    }
    generate(p: V3) {
        this.offHitFilter(HF.NO_COLLISION);
        this.active = true;
        this.riseSpeed = rangeRand(4, 6);
        this.pos.set(p);
        rangeRand(1, 1.5);   // (unused)
        const P = this.owner.TP;
        const s = rangeRand(P.mSLTearsDropScaleLow, P.mSLTearsDropScaleHigh);
        this.scale.set(s, s, s);
    }
}

export class BEelTearsManager extends EnemyManager {
    drops: BEelTearsDrop[] = [];
    constructor(w: World, name = 'めおとウナギ涙マネージャー') { super(w, name); }
    load(s: Stream) { this.saveParams = readParams('/enemy/bossEelTears.prm', this.world.files, TEARS_PARAMS); super.load(s); }
    createModelData() { this.createModelDataArray(['tears.bmd', 'tears_waterhit.bmd']); }
    createEnemyInstance(): SpineEnemy | null { return new BEelTears(this.world, 'めおとウナギ涙'); }
    createEnemies(count: number) {
        super.createEnemies(count);
        const owner = this.objs[0] as BEelTears | undefined;
        if (!owner) return;
        for (let i = 0; i < 30; ++i) this.drops.push(new BEelTearsDrop(owner));
    }
    perform(cue: number) {
        if (cue & CUE_CALC_ANIM) this.clipActors();
        const n = this.getActiveObjNum();
        for (let i = 0; i < n; ++i) this.objs[i].testPerform(cue);
        for (const d of this.drops) if (d.active) d.testPerform(cue);
    }
    /** splitTears: mSLTearsSplitNum + 1 drops around the burst */
    splitTears(p: V3) {
        let left = this.saveParams.mSLTearsSplitNum;
        p.y = fr(p.y + 600);
        for (const d of this.drops) {
            if (d.active) continue;
            const q = p.clone();
            q.x = fr(q.x + rangeRand(-250, 250));
            q.y = fr(q.y + rangeRand(-250, 250));
            q.z = fr(q.z + rangeRand(-250, 250));
            --left;
            d.generate(q);
            if (left < 0) break;
        }
    }
}

/** TBossEelTearsRecoverCollision (回復コリジョン): the bubble a tear leaves (Mario takes it: air). */
export class TearsRecoverCollision extends HitActor {
    recovering = false; colliding = false;
    constructor(public world: World, name = '回復コリジョン') { super(name); }
    initCollision() { this.initHitActor(AT.BOSS_EEL_TEARS, 3, HC.PLAYER, 400, 400, 400, 400); }
    behaveToMario() { sendToMario(this.world, this, MSG.ATTACK); this.recovering = false; this.onHitFilter(HF.NO_COLLISION); }
    perform(cue: number) {
        if (cue & CUE_MOVE) {
            this.calcEntryRadius();
            for (const c of this.collisions.slice()) if (c.isActorType(AT.MARIO)) this.behaveToMario();
        }
    }
}

/** TBEelTears (めおとウナギ涙): a tear, floating up from an eye. */
export class BEelTears extends SpineEnemy {
    initialPos = new V3();
    highPoly = true;
    stateTimer = 0;
    /** the eye's joint matrix it came out of (the live pointer: read when used) */
    spawnMtx: (() => Mtx) | null = null;
    recover!: TearsRecoverCollision;
    keeper = new Map<string, MActor>();
    get TP(): any { return this.getSaveParam(); }
    init(m: LiveManager | null) {
        super.init(m);
        this.actorType = AT.BOSS_EEL;
        this.onHitFilter(HC.PLAYER);
        this.setMActorAndKeeper();
        this.spine!.initWith(TearsNerves.generate);
        this.onLiveFlag(LF.DEAD);
        const P = this.TP;
        this.bodyScale = P ? rangeRand(P.mSLBodyScaleLow, P.mSLBodyScaleHigh) : 1;
        this.recover = new TearsRecoverCollision(this.world);
        this.recover.initCollision();
        this.world.addToGroup('敵グループ', this.recover);
        this.recover.onHitFilter(HF.NO_COLLISION);
    }
    setMActorAndKeeper() {
        for (const f of ['tears.bmd', 'tears_waterhit.bmd']) { const a = this.createMActorByName(f); if (a) this.keeper.set(f, a); }
        this.mactor = this.keeper.get('tears.bmd') || null;
    }
    changeMActor(name: string, bck: number) { const a = this.keeper.get(name); if (a) { this.mactor = a; a.setBckFromIndex(bck); } }
    moveObject() {
        const P = this.TP;
        this.vel.x = fr(this.vel.x * 0.9); this.vel.z = fr(this.vel.z * 0.9);
        this.pos.x = fr(this.pos.x + this.vel.x); this.pos.z = fr(this.pos.z + this.vel.z);
        if (!this.recover.colliding && this.spawnMtx && (this.pos.y > this.world.mario.pos.y + 3000 || this.pos.y > fr(this.spawnMtx()[7] + P.mSLTearsLiveHeight))) { this.kill(); return; }
        this.hitAndPush(false);
        super.moveObject();
    }
    /** the collision loop of moveObject: Mario is hit (and it bursts), anything else pushes it away */
    protected hitAndPush(stayToo: boolean) {
        const P = this.TP, s = this.scale.x;
        this.setHitParams(fr(P.mSLTearsAttackRadius * s), fr(P.mSLTearsAttackHeight * s), fr(P.mSLTearsDamageRadius * s), fr(P.mSLTearsDamageHeight * s));
        for (const c of this.collisions.slice()) {
            if (c.isActorType(AT.MARIO)) {
                const n = this.spine!.current;
                if (n === TearsNerves.moveUp || (stayToo && n === TearsNerves.oilBallStay)) {
                    sendToMario(this.world, this, MSG.ATTACK);
                    this.spine!.pushNerve(TearsNerves.split);
                }
            } else {
                const push = V3.sub(this.pos, c.pos).fround();
                if (push.x === 0 && push.y === 0 && push.z === 0) push.x = fr(push.x + 1);
                psVecNormalize(push, push);
                push.scale(5).fround();
                // (TLiveActor::moveObject zeroes it again)
                this.posDelta.set(push);
            }
        }
    }
    calcRootMatrix() {
        if (this.spawnMtx) {
            const sm = this.spawnMtx();
            if (this.pos.y < sm[7]) this.pos.y = sm[7];
            super.calcRootMatrix();
            if (this.spine!.current === TearsNerves.generate) {
                const t = transMtx(this.pos.x, this.pos.y, this.pos.z);
                t[3] = fr(t[3] + fr(sm[3] - t[3]) * 0.1);
                t[11] = fr(t[11] + fr(sm[11] - t[11]) * 0.1);
                this.scale.setAll(this.TP.mSLBodyScaleLow);
                this.baseTR.set(t);
            }
        } else super.calcRootMatrix();
    }
    perform(cue: number) {
        this.recover.perform(cue);
        if (this.checkLiveFlag(LF.DEAD)) return;
        if (cue & CUE_MOVE) this.moveObject();
        if ((cue & CUE_CALC_ANIM) && this.mactor) this.mactor.frameUpdate();
        if (this.checkLiveFlag(LF.HIDDEN | LF.CLIPPED_OUT)) return;
        if (cue & CUE_CALC_ANIM) this.calcRootMatrix();
    }
    receiveMessage(_sender: HitActor, msg: number) {
        if (msg !== MSG.SPRAYED_BY_WATER) return false;
        this.stateTimer = 60;
        const s = this.spine!;
        if (s.current === TearsNerves.moveUp || s.current === TearsNerves.oilBallStay) s.pushNerve(TearsNerves.waterHit);
        if (s.current === TearsNerves.waterHit) this.mactor?.setFrameRate(2, ANM_BCK);
        return true;
    }
    kill() { this.onHitFilter(HF.NO_COLLISION); this.recover.onHitFilter(HF.NO_COLLISION); this.onLiveFlag(LF.DEAD); }
    reset() {
        this.actorType = AT.BOSS_EEL;
        super.reset();
        this.spine!.initWith(TearsNerves.generate);
        this.onLiveFlag(LF.UNK10);
        this.offLiveFlag(LF.DEAD); this.offLiveFlag(LF.CLIPPED_OUT); this.offLiveFlag(LF.UNK200); this.offLiveFlag(LF.HIDDEN);
        this.groundPlane = this.world.illegal;
        this.offHitFilter(HF.NO_COLLISION);
    }
    /** setBubble: a bubble straight away (a fallen tooth's, the one after the fight) */
    setBubble() {
        this.setRecoverTears();
        this.recover.pos.set(this.pos);
        this.spine!.initWith(TearsNerves.marioRecover);
        this.onLiveFlag(LF.HIDDEN);
        this.recover.colliding = true;
    }
    setRecoverTears() { this.recover.colliding = false; this.recover.offHitFilter(HF.NO_COLLISION); this.recover.recovering = true; this.recover.pos.set(this.pos); }
    deadEffect() {
        this.setRecoverTears();
        this.recover.pos.set(this.pos);
        (this.manager as BEelTearsManager).splitTears(this.pos.clone());
        this.world.sound(SE.BS_UNG_TEAR_CLASH, this.pos);
        this.onLiveFlag(LF.HIDDEN);
    }
}

/** TOilBall (油ダマ): a tear that stays where scene.bin put it. */
export class OilBall extends BEelTears {
    constructor(w: World, name = '油ダマ') { super(w, name); }
    load(s: Stream) {
        this.highPoly = false;
        super.load(s);
        this.initialPos.set(this.pos);
        this.reset();
    }
    reset() {
        super.reset();
        this.pos.set(this.initialPos);
        this.spine!.initWith(TearsNerves.oilBallStay);
        this.mactor = this.keeper.get('tears.bmd') || this.mactor;
        this.mactor?.setBckFromIndex(2);
        this.highPoly = false;
    }
    moveObject() { this.hitAndPush(true); LiveActor.prototype.moveObject.call(this); }
    calcRootMatrix() { SpineEnemy.prototype.calcRootMatrix.call(this); }
}

type TS = Spine<BEelTears>;
export const TearsNerves: Record<string, any> = {};
TearsNerves.generate = nerve<BEelTears>('TNerveBEelTearsGenerate', (spine: TS) => {
    const t = spine.body;
    if (spine.time === 0) t.changeMActor('tears.bmd', 2);
    if (t.checkCurAnmEnd(0)) { spine.pushAfterCurrent(TearsNerves.moveUp); return true; }
    return false;
});
TearsNerves.moveUp = nerve<BEelTears>('TNerveBEelTearsMoveUp', (spine: TS) => {
    const t = spine.body;
    if (spine.time === 0) t.changeMActor('tears.bmd', 1);
    t.pos.y = fr(t.pos.y + t.TP.mSLTearsUpSpeed);
    return false;
});
TearsNerves.waterHit = nerve<BEelTears>('TNerveBEelTearsWaterHit', (spine: TS) => {
    const t = spine.body;
    if (spine.time === 0) { t.world.sound(SE.BS_UNG_TEAR_TREMBLE, t.pos); t.changeMActor('tears_waterhit.bmd', 3); }
    --t.stateTimer;
    const rate = t.TP.mSLHitAnmFrameRate;
    if (t.stateTimer < 0) {
        // (left alone, it shrinks back)
        t.mactor!.setFrameRate(fr(-rate * 2), ANM_BCK);
        if (t.getCurAnmFrameNo(ANM_BCK) < 1) return true;
    } else t.mactor!.setFrameRate(fr(rate * 2), ANM_BCK);
    if (t.checkCurAnmEnd(ANM_BCK)) { spine.pushAfterCurrent(TearsNerves.marioRecover); t.deadEffect(); return true; }
    if (t.highPoly) t.pos.y = fr(t.pos.y + t.TP.mSLTearsDamageUpSpeed);
    return false;
});
TearsNerves.marioRecover = nerve<BEelTears>('TNerveBEelTearsMarioRecover', (spine: TS) => {
    const t = spine.body;
    if (!t.recover.recovering) { t.kill(); return true; }
    if (spine.time > 1000) { t.kill(); return true; }
    if (t.recover.colliding) { t.pos.y = fr(t.pos.y + t.TP.mSLTearsUpSpeed); t.recover.pos.y = t.pos.y; }
    return false;
});
TearsNerves.split = nerve<BEelTears>('TNerveBEelTearsSplit', (spine: TS) => {
    const t = spine.body;
    if (spine.time === 0) {
        t.world.sound(SE.BS_UNG_TEAR_TREMBLE, t.pos);
        t.changeMActor('tears_waterhit.bmd', 3);
        t.mactor!.setFrameRate(fr(t.TP.mSLHitAnmFrameRate * 2), ANM_BCK);
    }
    if (t.checkCurAnmEnd(ANM_BCK)) { t.deadEffect(); spine.pushAfterCurrent(TearsNerves.marioRecover); return true; }
    return false;
});
TearsNerves.oilBallStay = nerve<BEelTears>('TNerveOilBallStay', (spine: TS) => {
    const t = spine.body, a = t.mactor!;
    if (a.checkCurBckFromIndex(3) || (t.checkCurAnmEnd(0) && !a.checkCurBckFromIndex(1))) t.changeMActor('tears.bmd', 1);
    return false;
});

// ================================================================ the eel's parts
/** TBossEelTooth (めおとウナギの歯): one tooth on joint ha1..ha8 (type 0 clean, 1 bad, 2 gold). */
export class BossEelTooth extends HitActor {
    model: PartModel;
    hitPoints: number;
    trembleRotation = new V3();
    damageCooldown = 0;
    detachedMtx: Mtx = mtx();
    /** mColor.a (the viewer's tooth alpha) */
    alpha = 0xFF;
    canShedTears = true;
    joint: number;
    constructor(public toothType: number, public owner: BossEel, jointName: string, file: string, name = 'めおとウナギの歯') {
        super(name);
        this.joint = owner.mactor!.jointIndex(jointName);
        this.model = new PartModel(owner, file, () => !owner.checkLiveFlag(LF.DEAD | LF.HIDDEN) && this.hitPoints !== 0 && this.alpha !== 0);
        const a = this.model.mactor;
        if (a) { a.setBckFromIndex(BCK_TOOTH); a.setFrameRate(0, ANM_BCK); }
        owner.world.extras.push(this.model);
        const P = owner.EP;
        this.hitPoints = P.mSLToothMaxHitPoint;
        this.initHitActor(AT.BOSS_EEL_TOOTH, 5, HC.PLAYER | HC.WATER, P.mSLToothAttackRadius, P.mSLToothAttackHeight, P.mSLToothDamageRadius, P.mSLToothDamageHeight);
        owner.world.addToGroup('オブジェクトグループ', this);
        this.offHitFilter(HF.NO_COLLISION);
    }
    connectedMtx(): Mtx { return this.owner.anmMtx(this.joint); }
    receiveMessage(_sender: HitActor, msg: number) {
        if (msg !== MSG.SPRAYED_BY_WATER) return false;
        const o = this.owner, w = o.world;
        if (this.damageCooldown === 0 && !o.toothBroken && this.hitPoints > 1) {
            this.damageCooldown = 2;
            --this.hitPoints;
            this.model.mactor?.setFrameRate(2, ANM_BCK);
            o.toothDamaged = true;
            this.alpha = Math.trunc(fr(fr(this.hitPoints * 0xFF) / fr(o.EP.mSLToothMaxHitPoint))) & 0xFF;
            if (this.toothType === 1 && this.hitPoints % 20 === 1) o.forceShedTears(this.canShedTears);
            if (this.hitPoints === 1) {
                this.alpha = 0;
                this.detachedMtx = this.connectedMtx();
                if (this.toothType === 1) {
                    w.sound(SE.BS_UNG_TEATH_COMEOFF, this.pos);
                    w.sound(this.canShedTears ? SE.BS_UNG_VOICE_M_CRY : SE.BS_UNG_VOICE_W_CRY, o.pos);
                    o.toothBroken = true;
                } else {
                    w.sound(SE.BS_UNG_TEATH_FLASH, this.pos);
                    w.sound(this.canShedTears ? SE.BS_UNG_VOICE_M_JOY : SE.BS_UNG_VOICE_W_JOY, o.pos);
                }
            }
        }
        return true;
    }
    perform(cue: number) {
        const o = this.owner, P = o.EP;
        if (o.checkLiveFlag(LF.CLIPPED_OUT) || this.hitPoints === 0) return;
        const a = this.model.mactor;
        if (cue & CUE_MOVE) {
            const s = o.scale.x;
            this.setHitParams(fr(P.mSLToothAttackRadius * s), fr(P.mSLToothAttackHeight * s), fr(P.mSLToothDamageRadius * s), fr(P.mSLToothDamageHeight * s));
            for (const c of this.collisions.slice()) if (o.isValidToothDamage() && c.isActorType(AT.MARIO) && this.hitPoints > 1) sendToMario(o.world, this, MSG.ATTACK);
            if (this.damageCooldown > 0) --this.damageCooldown;
            else {
                // (the wash BCK plays a stretch per hit)
                if (a && a.checkCurBckFromIndex(BCK_TOOTH) && a.curAnmEndsNext(ANM_BCK)) a.setFrameRate(0, ANM_BCK);
                if (this.hitPoints === 1) {
                    if (this.toothType === 1 && a) {
                        if (a.checkCurBckFromIndex(BCK_TOOTH)) {
                            a.setBckFromIndex(BCK_TOOTH_FALL);
                            const d = this.detachedMtx;
                            o.generateBubble(new V3(d[3], fr(this.trembleRotation.y + d[7]), d[11]));
                            a.setFrameRate(2, ANM_BCK);
                        }
                        if (a.checkCurBckFromIndex(BCK_TOOTH_FALL) && a.curAnmEndsNext(ANM_BCK)) a.setBckFromIndex(BCK_TOOTH_FALLEN);
                    }
                    if (this.toothType === 1) {
                        // (a fallen bad tooth floats away)
                        this.trembleRotation.y = fr(this.trembleRotation.y + P.mSLToothUpSpeed);
                        if (this.trembleRotation.y > P.mSLToothLiveHeight || this.pos.y > o.world.mario.pos.y + 2000) { this.hitPoints = 0; this.onHitFilter(HF.NO_COLLISION); }
                    }
                }
            }
        }
        if (cue & CUE_CALC_ANIM) {
            let m = this.hitPoints > 1 || this.toothType === 0 || this.toothType === 2 ? this.connectedMtx() : this.detachedMtx.slice();
            MTXConcat(m, transMtx(0, 0, this.trembleRotation.x), m);
            const r = mtx(); MsMtxSetRotRPH(r, this.trembleRotation.z, this.trembleRotation.z, 0);
            MTXConcat(m, r, m);
            m[7] = fr(m[7] + this.trembleRotation.y);
            this.pos.set(m[3], m[7], m[11]);
            this.model.baseTR.set(m); this.model.pos.set(this.pos);
            a?.frameUpdate();
        }
    }
}

/** TBossEelVortex (めおとウナギ渦): the breath-in that pulls Mario toward the mouth. */
export class BossEelVortex extends HitActor {
    inactive = true; timer = 0;
    constructor(public owner: BossEel, name = 'めおとウナギ渦') {
        super(name);
        const P = owner.EP;
        this.initHitActor(AT.BOSS_EEL, 3, HC.PLAYER, P.mSLVortexAttackRadius, P.mSLVortexAttackHeight, P.mSLVortexDamageRadius, P.mSLVortexDamageHeight);
        owner.world.addToGroup('敵グループ', this);
        this.offHitFilter(HF.NO_COLLISION);
    }
    perform(cue: number) {
        if (this.inactive) return;
        const o = this.owner, P = o.EP, a = o.mactor!, w = o.world;
        if (cue & CUE_MOVE) {
            const s = o.scale.x;
            this.attackRadius = fr(P.mSLVortexAttackRadius * s); this.attackHeight = fr(P.mSLVortexAttackHeight * s);
            this.damageRadius = fr(P.mSLVortexDamageRadius * s); this.damageHeight = fr(P.mSLVortexDamageHeight * s);
            this.calcEntryRadius();
            ++this.timer;
            if (this.timer > 30) {
                if (a.checkCurBckFromIndex(BCK_BREATH_IN) || a.checkCurBckFromIndex(BCK_PAKU)) {
                    for (const c of this.collisions.slice()) {
                        if (!c.isActorType(AT.MARIO)) continue;
                        const mp = w.mario.pos;
                        const t = new V3(fr(o.pos.x - mp.x), fr(o.pos.y - mp.y), fr(o.pos.z - mp.z));
                        psVecNormalize(t, t);
                        let power = P.mSLBreathInPower;
                        let wave = Math.abs(JMASSin(s16(fr(182.04445 * fr(0.9 * this.timer)))));
                        if (wave > 1) wave = 1; else if (wave < 0.1) wave = 0.1;
                        power = fr(power * wave);
                        if (a.checkCurBckFromIndex(BCK_PAKU)) power = fr(power * 0.5);
                        t.scale(power).fround().add(mp).fround();
                        marioMoveRequest(w, t);
                    }
                } else this.onHitFilter(HF.NO_COLLISION);
            }
        }
        if (cue & CUE_CALC_ANIM) {
            const m = o.anmMtx(o.mapCollisionJoints[2]);
            this.pos.set(m[3], fr(m[7] + 1000), m[11]);
        }
    }
    reset() { this.offHitFilter(HF.NO_COLLISION); this.onHitFilter(HC.PLAYER); this.timer = 0; }
}

/** TBossEelEye (めおとウナギ目): an eye on joint eye1..eye4; it blinks / cries (BCK 1) 4 loops, both of a pair. */
export class BossEelEye {
    model: PartModel;
    copyConnectedMtx = -1;
    animationMode = 0; previousBckIndex = -1; blendRatio = 1;
    pairedEye: BossEelEye | null = null;
    animationLoopCount = 0;
    constructor(public owner: BossEel, public joint: number) {
        this.model = new PartModel(owner, 'eye.bmd', () => !owner.checkLiveFlag(LF.DEAD | LF.HIDDEN | LF.CLIPPED_OUT));
        owner.world.extras.push(this.model);
        const a = this.model.mactor;
        this.previousBckIndex = a ? a.getCurAnmIdx(ANM_BCK) : -1;
        a?.setBckFromIndex(0);
    }
    get mactor() { return this.model.mactor; }
    connectedMtx(): Mtx { return this.owner.anmMtx(this.joint); }
    private toBck(i: number, mode: number) {
        const a = this.mactor;
        this.previousBckIndex = a ? a.getCurAnmIdx(ANM_BCK) : -1;
        this.animationMode = mode; this.blendRatio = 1;
        a?.setBckFromIndex(i);
    }
    setBckAnm(i: number) { this.toBck(i, 1); }
    testPerform(cue: number) {
        if (this.owner.checkLiveFlag(LF.DEAD | LF.HIDDEN | LF.CLIPPED_OUT)) return;
        const a = this.mactor;
        if (cue & CUE_CALC_ANIM) {
            this.model.baseTR.set(this.connectedMtx());
            this.model.pos.set(this.model.baseTR[3], this.model.baseTR[7], this.model.baseTR[11]);
            this.blendRatio = MsClamp(fr(this.blendRatio - 0.01), 0, 1);
            if (this.animationMode === 1 && a && a.curAnmEndsNext(ANM_BCK)) {
                ++this.animationLoopCount;
                if (this.animationLoopCount > 3) { this.toBck(0, 0); this.pairedEye?.toBck(0, 0); }
            }
            a?.frameUpdate();
        }
        this.copyConnectedMtx = -1;
    }
}

/** TBossEelHeartCoin (めおとウナギハートコイン): the heart of coins it leaves (meoto_heartcoin.bmd, from ha7). */
export class BossEelHeartCoin {
    active = false;
    position = new V3();
    model: PartModel;
    constructor(public owner: BossEel) {
        this.model = new PartModel(owner, 'meoto_heartcoin.bmd', () => this.active);
        owner.world.extras.push(this.model);
        // TODO: its 20 coins (newAndRegisterCoinReal, killed until generate, then on joints 2..21)
    }
    perform(cue: number) {
        if (!this.active) return;
        const o = this.owner, a = o.mactor!;
        if (cue & CUE_CALC_ANIM) {
            const m = o.anmMtx(a.jointIndex('ha7'));
            const fc = a.getFrameCtrl(ANM_BCK);
            if (a.checkCurBckFromIndex(BCK_DIE) && fc && fc.frame < 700) this.position.set(m[3], m[7], m[11]);
            this.position.y = m[7];
            this.model.baseTR.set(transMtx(this.position.x, this.position.y, this.position.z));
            this.model.pos.set(this.position);
            this.model.mactor?.frameUpdate();
        }
    }
    generate(p: V3) { this.position.set(p); this.active = true; }
}

/** TBossEelCollision: a cylinder on one of the eel's matrices that pushes Mario up (and lets it eat him). */
export class BossEelCollision extends HitActor {
    baseAttackRadius = 0; baseAttackHeight = 0; baseDamageRadius = 0; baseDamageHeight = 0;
    owner: BossEel | null = null;
    constructor(public world: World, public mtxOf: () => Mtx, name: string) { super(name); }
    initCollision() { this.initHitActor(AT.BOSS_EEL_COLLISION, 5, HC.PLAYER, this.baseAttackRadius, this.baseAttackHeight, this.baseDamageRadius, this.baseDamageHeight); }
    behaveToMario() {
        const t = new V3(0, mForcePow, 0).add(this.world.mario.pos).fround();
        marioMoveRequest(this.world, t);
        if (this.owner && this.owner.canEatMario()) this.owner.forceEat();
    }
    perform(cue: number) {
        if (cue & CUE_MOVE) {
            this.calcEntryRadius();
            for (const c of this.collisions.slice()) if (c.isActorType(AT.MARIO)) this.behaveToMario();
        }
        if (cue & CUE_CALC_ANIM) { const m = this.mtxOf(); this.pos.set(m[3], m[7], m[11]); }
    }
}
/** TBossEelBodyCollision (体コリジョン) */
export class BossEelBodyCollision extends BossEelCollision {
    initCollision() { this.baseAttackRadius = 2000; this.baseDamageRadius = 2000; this.baseAttackHeight = 5800; this.baseDamageHeight = 5000; super.initCollision(); }
}
/** TBossEelAwaCollision (泡コリジョン): the bubble column over its dying pose (BCK 4) that lifts Mario out. */
export class BossEelAwaCollision extends BossEelCollision {
    state = 0; timer = 0;
    initCollision() {
        this.baseDamageRadius = 2000; this.baseAttackRadius = 2000; this.baseDamageHeight = 2000; this.baseAttackHeight = 2000;
        this.initHitActor(AT.BOSS_EEL, 2, HC.PLAYER, this.baseAttackRadius, this.baseAttackHeight, this.baseDamageRadius, this.baseDamageHeight);
    }
    behaveToMario() {
        const t = new V3(0, 15, 0);
        const m = this.world.mario as any;
        if (m.mVel) m.mVel.y = 0;   // (*gpMarioSpeedY = 0)
        t.add(this.world.mario.pos).fround();
        marioMoveRequest(this.world, t);
    }
    perform(cue: number) {
        const mp = this.world.mario.pos;
        if (cue & CUE_MOVE) {
            this.calcEntryRadius();
            if (mp.y < this.pos.y + 500) this.offHitFilter(HF.NO_COLLISION);
            if (mp.y > this.pos.y + this.attackHeight) this.onHitFilter(HF.NO_COLLISION);
            for (const c of this.collisions.slice()) if (c.isActorType(AT.MARIO)) this.behaveToMario();
        }
        if (cue & CUE_CALC_ANIM) { const m = this.mtxOf(); this.pos.set(m[3], fr(m[7] + 11000), m[11]); }
    }
}
/** TBossEelBarrierCollision (障害コリジョン): on joint 7 while it rises (zero sized). */
export class BossEelBarrierCollision extends BossEelCollision {
    initCollision() { this.baseDamageRadius = 0; this.baseAttackRadius = 0; this.baseDamageHeight = 0; this.baseAttackHeight = 0; super.initCollision(); }
    behaveToMario() { marioMoveRequest(this.world, new V3(0, mForcePow, 0).add(this.world.mario.pos).fround()); }
}

// ================================================================ the eel
export class BossEelManager extends EnemyManager {
    eelParams!: EelParams;
    constructor(w: World, name = '?') { super(w, name); }
    load(s: Stream) { this.eelParams = readParams('/enemy/bosseel.prm', this.world.files, EEL_PARAMS); super.load(s); }
    createModelData() { this.createModelDataArray(['meoto_model.bmd']); }
    clipActors() { this.clipActorsAux(this.eelParams.mSLViewClipFar, this.eelParams.mSLViewClipRadius); }
}

export class BossEel extends SpineEnemy {
    initialPos = new V3();
    eyes: BossEelEye[] = [];
    teeth: BossEelTooth[] = [];
    vortex: BossEelVortex | null = null;
    /** mMapCollisions[2] (meoto_camera, on sebone5) */
    mapCollisions: (MoveCollision | null)[] = [];
    mapCollisionJoints: number[] = [];
    headCollision: HitActor | null = null;
    /** mMouthCubeManager's two cubes (0: the appear trigger; 1: the bite cube) */
    mouthCubes: CubeInfo[] = [new CubeInfo(), new CubeInfo()];
    bodyCollision: BossEelBodyCollision | null = null;
    currentBckIndex = -1; previousBckIndex = -1; bckBlendRatio = 1;
    tearEyeIndex = 0; tearCycleTimer = 0;
    forceEat_ = false;
    spinAngle = 500;
    tearEyeToggle = true;
    mouthOpenAmount = 2350; mouthOpenSpeed = 0.75;
    spinTimer = { x: 0, y: 1 };
    inDemo = false;
    appearOffset = 0; appearAcceleration = 0;
    toothDamaged = false; toothBroken = false; isBiting = false;
    battleTimer = 0;
    barrierCollision: BossEelBarrierCollision | null = null;
    awaCollision: BossEelAwaCollision | null = null;
    heartCoin: BossEelHeartCoin | null = null;
    moguCameraActive = false;
    collisionEnabled = true;
    /** the motion blend (initBckNormalMotionBlend): the BCK it blends from, its frame then */
    mc = { newIdx: -1, oldIdx: -1, oldFrame: 0 };
    joints: mat4[] | null = null;
    /** each joint's matrix in its parent's, as the calc leaves them (the viewer draws these) */
    locals: mat4[] = [];
    get EP(): EelParams { return (this.manager as BossEelManager).eelParams; }
    constructor(w: World, name = '?') { super(w, name); }
    hasMapCollision() { return true; }
    receiveMessage() { return false; }
    init(m: LiveManager | null) {
        if (!m) return;
        this.manager = m; m.manageActor(this);
        this.mactor = this.createMActor(0);
        const P = this.EP, w = this.world;
        this.initialPos.set(this.pos);
        this.onLiveFlag(LF.UNK8 | LF.UNK10);
        [this.groundHeight, this.groundPlane] = w.checkGround(this.pos.x, this.pos.y + this.getHeadHeight(), this.pos.z);
        this.spine!.initWith(EelNerves.waitAppear);
        this.initHitActor(AT.BOSS_EEL, 1, HC.PLAYER, P.mSLBodyAttackRadius, P.mSLBodyAttackHeight, P.mSLBodyDamageRadius, P.mSLBodyDamageHeight);
        this.offHitFilter(HF.NO_COLLISION);
        this.calcRootMatrixBasic();
        this.calcJoints();
        const head = this.headCollision = new HitActor('めおとウナギの頭部');
        head.initHitActor(AT.BOSS_EEL, 2, HC.PLAYER, P.mSLHeadAttackRadius, P.mSLHeadAttackHeight, P.mSLHeadDamageRadius, P.mSLHeadDamageHeight);
        w.addToGroup('敵グループ', head); head.offHitFilter(HF.NO_COLLISION);
        const body = this.bodyCollision = new BossEelBodyCollision(w, () => this.baseTR, '体コリジョン');
        body.initCollision(); body.owner = this;
        w.addToGroup('敵グループ', body); body.offHitFilter(HF.NO_COLLISION);
        const bar = this.barrierCollision = new BossEelBarrierCollision(w, () => this.anmMtx(7), '障害コリジョン');
        bar.initCollision();
        w.addToGroup('敵グループ', bar); bar.offHitFilter(HF.NO_COLLISION);
        const a = this.mactor!;
        this.eyes = ['eye1', 'eye2', 'eye3', 'eye4'].map((j) => new BossEelEye(this, a.jointIndex(j)));
        this.eyes[0].pairedEye = this.eyes[1]; this.eyes[1].pairedEye = this.eyes[0];
        this.eyes[2].pairedEye = this.eyes[3]; this.eyes[3].pairedEye = this.eyes[2];
        for (const e of [this.eyes[2], this.eyes[3]]) { const c = e.mactor?.getFrameCtrl(ANM_BCK); if (c) c.frame = 100; }
        const toothFiles = ['tooth.bmd', 'bad_tooth.bmd', 'gold_tooth.bmd'];
        for (let i = 0; i < 8; ++i) {
            let type = 0;
            if (i === 1 || i === 4 || i === 7) type = 1;
            if (i === 6) type = 2;
            const t = new BossEelTooth(type, this, 'ha' + (i + 1), toothFiles[type]);
            t.canShedTears = i === 0 || i === 1 || i === 2 || i === 7;
            this.teeth.push(t);
        }
        this.heartCoin = new BossEelHeartCoin(this);
        const colJoints = ['headcol1', 'headcol2', 'sebone5', 'sebone5'];
        const colFiles = ['/bosseel/meoto_head', '/bosseel/meoto_head2', '/bosseel/meoto_camera', '/bosseel/meoto_out_loop'];
        for (let i = 0; i < 4; ++i) {
            this.mapCollisionJoints[i] = a.jointIndex(colJoints[i]);
            // (only meoto_camera is moved every tick; the heads only with mUseMapCollision)
            this.mapCollisions[i] = i === 2 || (mUseMapCollision && i < 2) ? new MoveCollision(w, colFiles[i] + '.col', this) : null;
        }
        const awa = this.awaCollision = new BossEelAwaCollision(w, () => this.anmMtx(this.mapCollisionJoints[2]), '泡コリジョン');
        awa.initCollision();
        w.addToGroup('敵グループ', awa); awa.onHitFilter(HF.NO_COLLISION);
        this.vortex = new BossEelVortex(this);
        const c0 = this.mouthCubes[0];
        c0.c.set(this.pos.x, fr(this.pos.y + 9600), this.pos.z);
        c0.s.set(7000, 10000, 7000);
        this.calcJoints();
    }
    /** getAnmMtx(i) as a row-major matrix (the base TR without a skeleton) */
    anmMtx(i: number): Mtx { const m = this.joints && i >= 0 ? this.joints[i] : null; return m ? rowMajor(m) : this.baseTR.slice(); }
    getJointTrans(i: number) { const m = this.anmMtx(i); return new V3(m[3], m[7], m[11]); }
    getTakingMtx() { return this.anmMtx(7); }
    /** J3DModel::calc with the normal motion blend */
    calcJoints() {
        const a = this.mactor;
        if (!a) return;
        const sk = Skeleton.of(a.data.files.scene(a.model));
        if (!sk) return;
        const bck = (i: number) => { const e = a.data.anms[ANM_BCK][i]; return e ? parseBCK(a.data.files.scene(a.data.folder + '/' + e.name + '.bck')) : null; };
        const mc = this.mc, fc = a.getFrameCtrl(ANM_BCK);
        const nw = mc.newIdx >= 0 ? { anm: bck(mc.newIdx), frame: fc ? fc.frame : 0 } : null;
        const old = mc.oldIdx >= 0 ? { anm: bck(mc.oldIdx), frame: mc.oldFrame } : null;
        this.joints = jointMatricesBlend(sk, nw, old, this.bckBlendRatio, false, this.baseTR, [this.scale.x, this.scale.y, this.scale.z], this.joints || [], this.locals);
    }
    setBckAnm(i: number) {
        const a = this.mactor!, fc0 = a.getFrameCtrl(ANM_BCK);
        this.previousBckIndex = a.getCurAnmIdx(ANM_BCK);
        this.currentBckIndex = i;
        this.bckBlendRatio = 1;
        this.mc.oldIdx = this.previousBckIndex; this.mc.oldFrame = fc0 ? fc0.frame : 0; this.mc.newIdx = i;
        a.setBckFromIndex(i);
        a.setFrameRate(0.25 * 2, ANM_BCK);
    }
    calcAndSetCollisionCubeBite_() {
        const c = this.mouthCubes[1], s = this.scale;
        c.r.set(this.rot);
        c.c.set(this.pos.x, fr(this.pos.y + 1900), this.pos.z);
        c.s.set(1100, 1000, 1100);
        c.c.set(this.pos.x, fr(this.pos.y + fr(9600 * s.y)), this.pos.z);
        c.s.set(fr(7000 * s.x), fr(10000 * s.y), fr(7000 * s.z));
    }
    isInMouthCube(p: V3, i: number) { const c = this.mouthCubes[i]; return !!c && isPointInCube(p, c.c, c.r, c.s); }
    /** updateTearsCnt: every mSLGenTearsTime ticks (x2..x4 with Mario far above / below) an eye pair cries a tear */
    updateTearsCnt() {
        const eyeTable = [0, 2, 1, 3];
        ++this.tearCycleTimer;
        let interval = this.EP.mSLGenTearsTime;
        const h = Math.abs(fr(this.pos.y - this.world.mario.pos.y));
        if (h > 30000) interval *= 4; else if (h > 15000) interval *= 3; else if (h > 6000) interval *= 2;
        if (this.tearCycleTimer === interval - 100) { const e = this.eyes[eyeTable[this.tearEyeIndex]]; e.setBckAnm(1); e.pairedEye!.setBckAnm(1); }
        if (this.tearCycleTimer > interval) {
            this.tearCycleTimer = 0;
            const e = this.eyes[eyeTable[this.tearEyeIndex]];
            e.setBckAnm(1); e.animationLoopCount = 0;
            this.shedTears(() => e.connectedMtx());
            this.tearEyeIndex += 1;
            if (this.tearEyeIndex >= 4) this.tearEyeIndex = 0;
        }
    }
    forceEat() { if (this.spine!.current !== EelNerves.eat) this.spine!.pushNerve(EelNerves.eat); }
    canEatMario() {
        if (this.forceEat_) return true;
        const m = this.anmMtx(this.mapCollisionJoints[0]), mp = this.world.mario.pos;
        const d = new V3(fr(mp.x - m[3]), fr(mp.y - m[7]), fr(mp.z - m[11]));
        // (the squared distance against open amount x speed, as the game has it)
        return fr(d.squared()) < fr(this.mouthOpenAmount * this.mouthOpenSpeed);
    }
    generateBubble(p: V3) {
        const t = this.world.conductor.makeOneEnemyAppear(p, 'めおとウナギ涙マネージャー', 0) as BEelTears | null;
        if (t) t.setBubble();
    }
    shedTears(spawn: () => Mtx) {
        const sm = spawn();
        const t = this.world.conductor.makeOneEnemyAppear(new V3(sm[3], sm[7], sm[11]), 'めおとウナギ涙マネージャー', 0) as BEelTears | null;
        if (!t) return;
        t.spawnMtx = spawn;
        t.reset();
        const r = mtx(); MsMtxSetRotRPH(r, 0, rangeRand(0, 360), 0);
        // (MTXMultVec of (0, 0, 100))
        const d = new V3(fr(r[2] * 100), fr(r[6] * 100), fr(r[10] * 100));
        t.pos.x = fr(t.pos.x + d.x); t.pos.z = fr(t.pos.z + d.z);
        psVecNormalize(d, d);
        d.x = fr(d.x * 10); d.z = fr(d.z * 10);
        t.vel.set(d);
    }
    /** forceShedTears: a bad tooth's hit; the rear eyes (2, 3) or the front ones, alternately */
    forceShedTears(rear: boolean) {
        this.tearEyeToggle = !this.tearEyeToggle;
        const i = rear ? (this.tearEyeToggle ? 3 : 2) : (this.tearEyeToggle ? 1 : 0);
        const e = this.eyes[i];
        e.setBckAnm(1); e.animationLoopCount = 0;
        this.shedTears(() => e.connectedMtx());
    }
    generateVortex() {
        const v = this.vortex!, P = this.EP;
        v.reset();
        const m = this.anmMtx(this.mapCollisionJoints[2]);
        v.pos.set(m[3], m[7], m[11]);
        v.inactive = false;
        v.scale.set(P.mSLVortexScaleXZ, P.mSLVortexScaleY, P.mSLVortexScaleXZ);
        this.offHitFilter(HF.NO_COLLISION);
    }
    invalidateAllCollision() {
        this.bodyCollision!.onHitFilter(HF.NO_COLLISION); this.barrierCollision!.onHitFilter(HF.NO_COLLISION);
        this.vortex!.onHitFilter(HF.NO_COLLISION); this.headCollision!.onHitFilter(HF.NO_COLLISION);
        this.awaCollision!.offHitFilter(HF.NO_COLLISION);
    }
    /** collideToMario: the two jaws (headcol1 / headcol2, along their Y axes) push Mario out of the mouth */
    collideToMario() {
        const target = this.world.mario.pos.clone();
        const corr = new V3();
        for (let i = 0; i < 2; ++i) {
            const m = this.anmMtx(this.mapCollisionJoints[i]);
            const center = new V3(m[3], m[7], m[11]);
            const axis = new V3(m[1], m[5], m[9]);
            if (i === 0) axis.scale(-1);
            jNormalize(axis);
            const d = V3.sub(target, center).fround();
            const l = fr(d.length());
            if (l === 0 || l >= this.mouthOpenAmount) continue;
            const pen = fr(this.mouthOpenAmount - l);
            const ax = fr(d.dot(axis));
            if (ax >= 0) continue;
            let push: V3;
            if (-ax < pen) push = axis.clone().scale(-ax).fround();
            else push = jNormalize(d.clone()).scale(pen).fround();
            corr.add(push).fround();
        }
        target.add(corr).fround();
        marioMoveRequest(this.world, target);
    }
    deadCheck() {
        for (const t of this.teeth) if (t.hitPoints > 1) return;
        if (this.spine!.current !== EelNerves.die) { this.spine!.setNext(EelNerves.die); this.headCollision!.onHitFilter(HF.NO_COLLISION); }
    }
    isValidToothDamage() { return this.spine!.current !== EelNerves.eat; }
    /** quickBack: the teeth still standing heal */
    quickBack() { for (const t of this.teeth) if (t.hitPoints > 1) { t.hitPoints = this.EP.mSLToothMaxHitPoint; t.alpha = 0xFF; } }
    isInBossEelMoguDemo() { const a = this.mactor!; return a.checkCurBckFromIndex(BCK_MOGU) || a.checkCurBckFromIndex(BCK_DIE); }
    startMoguCamera() {
        if (this.moguCameraActive) return;
        this.world.effect('balloon:e0015', this.pos);
        // (hoseiDiveCameraCallback warps the camera to 12300 above it, looking at Mario)
        this.world.effect('demo:meoto_mogu_camera', this.pos);
        this.moguCameraActive = true;
    }
    /** SMS_SendMessageToMario(this, TAKE): Mario held */
    takeMario() { if (sendToMario(this.world, this, MSG.TAKE)) { this.held = this.world.mario as unknown as TakeActor; return true; } return false; }
    releaseMario() { if (sendToMario(this.world, this, MSG.DETACH)) { this.held = null; sendToMario(this.world, this, MSG.ATTACK); return true; } return false; }
    perform(cue: number) {
        const a = this.mactor!, P = this.EP, s = this.spine!;
        if (a.checkCurBckFromIndex(BCK_DIE_LOOP)) this.awaCollision!.perform(cue);
        if (this.checkLiveFlag(LF.UNK200)) return;
        if (cue & CUE_MOVE) {
            this.scale.setAll(P.mSLBodyScale);
            this.pos.y = fr(this.appearOffset + fr(this.initialPos.y + P.mSLInitTransYOffset));
            const sc = this.scale, c0 = this.mouthCubes[0];
            c0.c.set(this.pos.x, fr(this.pos.y + fr(9600 * sc.y)), this.pos.z);
            c0.s.set(fr(7000 * sc.x), fr(10000 * sc.y), fr(7000 * sc.z));
            this.moveObject();
            // (MActor::calcAnm: the frame moves on and the joints are calculated, from the last root matrix)
            a.frameUpdate();
            this.calcJoints();
            this.calcRootMatrix();
            this.collideToMario();
            const mc2 = this.mapCollisions[2];
            if (mc2 && this.joints && this.joints[this.mapCollisionJoints[2]]) mc2.moveMat4(this.joints[this.mapCollisionJoints[2]]);
            if (mUseMapCollision) for (let i = 0; i < 2; ++i) { const c = this.mapCollisions[i]; if (c && this.joints) c.moveMat4(this.joints[this.mapCollisionJoints[i]]); }
            if (mUseObjCollision && s.current !== EelNerves.die) this.bodyCollision!.offHitFilter(HF.NO_COLLISION);
            else this.bodyCollision!.onHitFilter(HF.NO_COLLISION);
            const head = this.headCollision!;
            head.pos.set(this.pos);
            head.pos.y = fr(head.pos.y + fr(P.mSLBodyToHeadDistance * sc.y));
            head.setHitParams(fr(P.mSLHeadAttackRadius * sc.x), fr(P.mSLHeadAttackHeight * sc.x), fr(P.mSLHeadDamageRadius * sc.x), fr(P.mSLHeadDamageHeight * sc.x));
            this.setHitParams(fr(P.mSLBodyAttackRadius * sc.x), fr(P.mSLBodyAttackHeight * sc.x), fr(P.mSLBodyDamageRadius * sc.x), fr(P.mSLBodyDamageHeight * sc.x));
            this.calcAndSetCollisionCubeBite_();
            if (this.hitPoints !== 0) {
                this.forceEat_ = false;
                for (const c of head.collisions) if (c.isActorType(AT.MARIO)) this.forceEat_ = true;
                if (s.current !== EelNerves.firstSpin && s.current !== EelNerves.secondSpin && s.current !== EelNerves.mouthOpenWait
                    && (a.checkCurBckFromIndex(BCK_IN_LOOP) || a.checkCurBckFromIndex(BCK_OUT_LOOP) || a.checkCurBckFromIndex(BCK_OUT_DAMAGED) || a.checkCurBckFromIndex(BCK_OUT_BROKEN)))
                    this.updateTearsCnt();
                this.bckBlendRatio = MsClamp(fr(this.bckBlendRatio - 0.01), 0, 1);
            }
            this.deadCheck();
        }
        if (cue & CUE_CALC_ANIM) {
            this.offLiveFlag(LF.CLIPPED_OUT);
            if (a.checkCurBckFromIndex(BCK_BREATH_IN)) this.world.sound(SE.BS_UNG_VACUUM, this.pos);
        }
        for (const e of this.eyes) e.testPerform(cue);
        for (const t of this.teeth) t.testPerform(cue);
        this.heartCoin!.perform(cue);
        this.vortex!.perform(cue);
        this.bodyCollision!.perform(cue);
        this.barrierCollision!.perform(cue);
    }
}

type ES = Spine<BossEel>;
export const EelNerves: Record<string, any> = {};
EelNerves.waitAppear = nerve<BossEel>('TNerveBossEelWaitAppear', (spine: ES) => {
    const e = spine.body;
    if (spine.time === 0) e.setBckAnm(BCK_IN_LOOP);
    if (spine.time === 2500) e.world.effect('balloon:e0012', e.pos);
    const p = e.world.mario.pos.clone(); p.y = fr(p.y + 75);
    if (e.isInMouthCube(p, 0)) { spine.pushAfterCurrent(EelNerves.firstSpin); return true; }
    return false;
});
/** ExecSpinNerve_Sub */
function execSpin(e: BossEel) {
    const P = e.EP;
    const sp = chase(e.turnSpeed, P.mSLSpinMaxSpeed, P.mSLSpinAccel);
    e.turnSpeed = fr(sp);
    if (e.checkLiveFlag(LF_SPIN_REVERSE)) {
        e.rot.y = fr(e.rot.y - e.turnSpeed);
        if (e.rot.y <= 0) e.world.sound(SE.BS_UNG_ROLL, e.pos);
    } else {
        e.rot.y = fr(e.rot.y + e.turnSpeed);
        if (e.rot.y >= 360) e.world.sound(SE.BS_UNG_ROLL, e.pos);
    }
    e.rot.y = MsWrap(e.rot.y, 0, 360);
}
const pickSpinDir = (e: BossEel) => { if (MsRandF() < 0.5) e.onLiveFlag(LF_SPIN_REVERSE); else e.offLiveFlag(LF_SPIN_REVERSE); };
EelNerves.firstSpin = nerve<BossEel>('TNerveBossEelFirstSpin', (spine: ES) => {
    const e = spine.body;
    if (spine.time === 0) { e.turnSpeed = 0; e.world.sound(SE.BS_UNG_ROLL, e.pos); e.setBckAnm(BCK_IN_LOOP); pickSpinDir(e); }
    execSpin(e);
    if (spine.time >= 360) { spine.pushAfterCurrent(EelNerves.appear); return true; }
    return false;
});
EelNerves.secondSpin = nerve<BossEel>('TNerveBossEelSecondSpin', (spine: ES) => {
    const e = spine.body;
    if (spine.time === 0) {
        e.setBckAnm(BCK_IN_LOOP);
        e.spinTimer.x = 0;
        e.spinTimer.y = Math.trunc(fr(MsRandF() * 960)) + 241;
        e.turnSpeed = 0;
        e.world.sound(SE.BS_UNG_ROLL, e.pos);
        pickSpinDir(e);
    }
    execSpin(e);
    let atLimit = false;
    ++e.spinTimer.x;
    if (e.spinTimer.x >= e.spinTimer.y) { e.spinTimer.x = e.spinTimer.y; atLimit = true; }
    if (atLimit) { spine.pushAfterCurrent(EelNerves.appear); return true; }
    return false;
});
EelNerves.appear = nerve<BossEel>('TNerveBossEelAppear', (spine: ES) => {
    const e = spine.body, P = e.EP, fc = () => e.mactor!.getFrameCtrl(ANM_BCK)!;
    if (spine.time === 0) {
        e.world.sound(SE.BS_UNG_UP, e.pos);
        e.barrierCollision!.offHitFilter(HF.NO_COLLISION);
        e.setBckAnm(BCK_APPEAR);
        e.inDemo = true;
        const d = fr(fc().end * 2);
        e.appearAcceleration = fr(fr(P.mSLAppearMoveDistY / d) / d);
    }
    const duration = Math.trunc(fc().end * 2);
    if (spine.time < duration) {
        e.appearOffset = fr(e.appearOffset + fr(P.mSLAppearMoveDistY / duration));
        const sp = fr(e.turnSpeed * 0.98);
        e.turnSpeed = sp;
        e.rot.y = fr(e.checkLiveFlag(LF_SPIN_REVERSE) ? e.rot.y - sp : e.rot.y + sp);
        e.rot.y = MsWrap(e.rot.y, 0, 360);
    } else if (e.checkCurAnmEnd(0)) {
        spine.pushAfterCurrent(EelNerves.outWait);
        e.barrierCollision!.onHitFilter(HF.NO_COLLISION);
        if (e.collisionEnabled) { e.collisionEnabled = false; e.world.effect('balloon:e0013', e.pos); }
        return true;
    }
    return false;
});
EelNerves.outWait = nerve<BossEel>('TNerveBossEelOutWait', (spine: ES) => {
    const e = spine.body;
    ++e.battleTimer;
    if (spine.time === 0) { e.toothDamaged = false; e.setBckAnm(BCK_OUT_LOOP); }
    if (e.checkCurAnmEnd(0)) {
        const interval = e.EP.mSLMouthOpenInterval;
        if (e.mactor!.checkCurBckFromIndex(BCK_OUT_BROKEN)) spine.setNext(EelNerves.quickBack);
        else {
            if (e.battleTimer >= 3600) { spine.pushAfterCurrent(EelNerves.slowBack); e.battleTimer = 0; return true; }
            if (spine.time > interval) { spine.pushAfterCurrent(EelNerves.outWait); spine.pushAfterCurrent(EelNerves.mouthOpenWait); return true; }
            if (e.toothBroken) e.setBckAnm(BCK_OUT_BROKEN);
            else if (e.toothDamaged) { e.toothDamaged = false; e.setBckAnm(BCK_OUT_DAMAGED); }
            else e.setBckAnm(BCK_OUT_LOOP);
        }
    }
    return false;
});
/** ExecBackNerve_Sub (its speed argument is unused) */
function execBack(spine: ES) {
    const e = spine.body;
    if (spine.time === 1) {
        e.world.sound(SE.BS_UNG_DOWN, e.pos);
        if (e.toothBroken) { e.toothBroken = false; e.setBckAnm(BCK_BACK_BROKEN); }
        else e.setBckAnm(BCK_BACK);
    }
    e.appearOffset = fr(e.appearOffset - fr(e.EP.mSLAppearMoveDistY / fr(e.mactor!.getFrameCtrl(ANM_BCK)!.end * 2)));
    if (e.appearOffset < 0) {
        e.appearOffset = 0;
        if (e.checkCurAnmEnd(0)) {
            e.inDemo = false;
            spine.pushAfterCurrent(EelNerves.secondSpin);
            if (e.mactor!.checkCurBckFromIndex(BCK_BACK_BROKEN)) spine.pushAfterCurrent(EelNerves.sleepOnBottom);
            return true;
        }
    }
    return false;
}
EelNerves.slowBack = nerve<BossEel>('TNerveBossEelSlowBack', (spine: ES) => execBack(spine));
EelNerves.quickBack = nerve<BossEel>('TNerveBossEelQuickBack', (spine: ES) => { if (execBack(spine)) { spine.body.quickBack(); return true; } return false; });
EelNerves.eat = nerve<BossEel>('TNerveBossEelEat', (spine: ES) => {
    const e = spine.body, a = e.mactor!;
    if (spine.time === 0) e.setBckAnm(BCK_PAKU);
    if (e.checkCurAnmEnd(0)) {
        if (a.checkCurBckFromIndex(BCK_PAKU)) {
            if (e.canEatMario()) { e.setBckAnm(BCK_MOGU); if (e.takeMario()) e.startMoguCamera(); }
            else e.setBckAnm(BCK_EAT_MISS);
        } else {
            if (a.checkCurBckFromIndex(BCK_MOGU)) {
                if (e.releaseMario()) { e.world.effect('demo:end', e.pos); e.moguCameraActive = false; }
                spine.reset();
                spine.setDefaultNext();
                spine.pushAfterCurrent(EelNerves.quickBack);
            }
            return true;
        }
    }
    if (a.checkCurBckFromIndex(BCK_MOGU)) { if (e.takeMario()) e.startMoguCamera(); }
    return false;
});
EelNerves.die = nerve<BossEel>('TNerveBossEelDie', (spine: ES) => {
    const e = spine.body, a = e.mactor!;
    if (spine.time === 0) {
        e.world.sound(SE.BS_UNG_VOICE_LAST, e.pos);
        e.world.effect('balloon:e0014', e.pos);
        e.setBckAnm(BCK_DIE);
        e.invalidateAllCollision();
        e.heartCoin!.generate(e.pos);
        if (e.takeMario()) e.world.effect('demo:meoto_end_camera', e.pos);
    }
    if (a.checkCurBckFromIndex(BCK_DIE)) {
        if (a.checkBckPass(650)) e.heartCoin!.model.mactor?.setBckFromIndex(8);
        if (e.checkCurAnmEnd(0)) {
            if (e.releaseMario()) e.world.effect('demo:end', e.pos);
            e.generateBubble(e.world.mario.pos.clone());
            const m = e.anmMtx(a.jointIndex('ha7'));
            const im = mapObjGlobals(e.world).itemManager;
            if (im) im.makeShineAppearWithDemo('シャイン（ボス用）', 'めおとウナギシャインカメラ', m[3], m[7], m[11]);
            e.teeth[6].hitPoints = 0;
            e.teeth[6].onHitFilter(HF.NO_COLLISION);
            e.setBckAnm(BCK_DIE_LOOP);
        }
    }
    return false;
});
EelNerves.mouthOpenWait = nerve<BossEel>('TNerveBossEelMouthOpenWait', (spine: ES) => {
    const e = spine.body, a = e.mactor!, P = e.EP;
    if (spine.time === 0) {
        if (e.toothBroken) e.toothBroken = false;
        e.setBckAnm(BCK_OPEN);
    } else if (e.checkCurAnmEnd(0)) {
        if (a.checkCurBckFromIndex(BCK_OPEN)) { e.setBckAnm(BCK_BREATH_IN); e.generateVortex(); }
        else {
            const open = P.mSLMouthOpenFrame;
            if (spine.time > open - P.mSLCanEatFrame && e.canEatMario()) { spine.pushAfterCurrent(EelNerves.eat); return true; }
            if (spine.time > open) {
                if (a.checkCurBckFromIndex(BCK_CLOSE)) return true;
                e.setBckAnm(BCK_CLOSE);
            }
        }
    }
    if (a.checkCurBckFromIndex(BCK_BREATH_IN)) e.rot.y = fr(e.rot.y + mOpenRollSpeed);
    return false;
});
EelNerves.sleepOnBottom = nerve<BossEel>('TNerveBossEelSleepOnBottom', (spine: ES) => {
    const e = spine.body;
    if (spine.time === 0) { e.battleTimer = 0; e.setBckAnm(BCK_IN_LOOP); }
    if (spine.time % 100 === 1) e.forceShedTears(spine.time % 2 !== 0);
    if (spine.time > 1000 && e.checkCurAnmEnd(0)) return true;
    return false;
});

register('BossEelManager', (w, n) => new BossEelManager(w, n));
register('BossEel', (w, n) => new BossEel(w, n));
register('BEelTearsManager', (w, n) => new BEelTearsManager(w, n));
register('OilBall', (w, n) => new OilBall(w, n));
