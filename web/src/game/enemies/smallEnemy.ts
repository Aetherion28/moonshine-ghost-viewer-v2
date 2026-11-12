// TSmallEnemy / TSmallEnemyManager (Enemy/smallEnemy.cpp): the common enemy — water freezes or
// hurts it, Mario's stomps kill it, it dies through TNerveSmallEnemyDie (its death animation,
// then its coins / items, then dead until the manager brings it back), juice turns it into a
// block (TNerveSmallEnemyChange: it rides the block, then comes out of it).

import { msVecNormalize } from '../camera/lib.js';
import { fr, V3, MsRandF, MsSin, MsCos, matan, MsClamp, mtx, MsMtxSetRotRPH, psMtxMultVec } from '../math.js';
import { fmadd } from '../player/fmath.js';
import { vNormMs } from '../vecops.js';
import {
    ANM_FRAME_RATE, World, SpineEnemy, EnemyManager, PathNode, LF, HF, HC, MSG, nerve, Spine, Stream, Params, PSchema, SPINE_PARAMS, HitActor, ANM_BCK, Files, TakeActor,
} from '../engine.js';
import { AT } from '../actortypes.js';
import type { WaterHitActor } from '../water.js';
import type { WallCheck } from '../collision.js';
import { parseBTI } from '../pollution.js';
import { SE } from '../soundids.js';
import { mapObjGlobals } from '../mapobj/base.js';
import type { JuiceBlock } from '../mapobj/block.js';
import '../sound.js';

/** TSmallEnemyParams */
export const SMALL_PARAMS = {
    ...SPINE_PARAMS,
    mSLJumpForce: ['f', 10], mSLSearchLength: ['f', 800], mSLSearchHeight: ['f', 600], mSLSearchAware: ['f', 400], mSLSearchAngle: ['f', 90],
    mSLGiveUpLength: ['f', 2000], mSLGiveUpHeight: ['f', 650], mSLAttackWait: ['i', 120], mSLFreezeWait: ['i', 300], mSLDamageRadius: ['i', 80],
    mSLDamageHeight: ['i', 60], mSLAttackRadius: ['i', 80], mSLAttackHeight: ['i', 60], mSLTurnSpeedLow: ['f', 3], mSLTurnSpeedHigh: ['f', 5],
    mSLBodyScaleLow: ['f', 0.108], mSLBodyScaleHigh: ['f', 0.11], mSLGenItemRate: ['f', 50], mSLGenEggRate: ['f', 10], mSLPolluteRange: ['u8', 5],
    mSLWaitTime: ['i', 100], mSLPolluteRMin: ['i', 1], mSLPolluteRMax: ['i', 3], mSLPolluteCycle: ['i', 300], mSLStampRange: ['u8', 5],
    mSLPolluteInterval: ['i', 60], mSLGenerateOnlyDead: ['u8', 0],
} satisfies PSchema;
export type SmallParams = { [K in keyof typeof SMALL_PARAMS]: number } & { turnLow: number; turnHigh: number; scaleLow: number; scaleHigh: number };
/** A TSmallEnemyParams subclass's parameters (its own list added): with its TMsRange's. */
export function smallParams<S extends PSchema>(path: string, files: Files, more?: S): SmallParams & { [K in keyof S]: any } {
    const p: any = new Params(path, files).read({ ...SMALL_PARAMS, ...(more || {}) });
    p.turnLow = p.mSLTurnSpeedLow; p.turnHigh = p.mSLTurnSpeedHigh; p.scaleLow = p.mSLBodyScaleLow; p.scaleHigh = p.mSLBodyScaleHigh;
    return p;
}
/** TMsRange<f32>::rand */
export const rangeRand = (lo: number, hi: number) => fr(lo + fr(fr(hi - lo) * MsRandF()));

export class SmallEnemyManager extends EnemyManager {
    static mBlockWaitTime = 400;
    static mBlockMoveSpeed = 2;
    static mBlockWaitMoveY = 200;
    static mChangeBlockTime = 2500;
    static mBlockXZScale = 1.5;
    static mBlockYScale = fr(0.6);
    static mTestJuiceType = 0;
    unk58 = 0;
    /** the frames a dead enemy lies before it goes (TNerveSmallEnemyDie) */
    unk5C = 0x3C;
    constructor(w: World, name = 'エフェクト敵マネージャー') { super(w, name); }
    createModelData() { this.createModelDataArray(['default.bmd']); }
    loadAfter() {
        super.loadAfter();
        // /common/timg/down_osen.bti: the mark a squashed enemy leaves
        const f = (this.world.files as any).common as ((p: string) => Uint8Array | null) | undefined;
        const b = f ? f('timg/down_osen.bti') : null;
        if (this.world.pollution) this.unk58 = this.world.pollution.registerTexStamp(1, b ? parseBTI(b) : this.world.pollution.stampTex[1]);
    }
    createEnemies(n: number) { super.createEnemies(n); this.initSetEnemies(); }
    initSetEnemies() { }
    getHolder(i: number) { for (let k = 0; k < this.getActiveObjNum(); ++k) if (k !== i && (this.objs[k] as SmallEnemy).checkLiveFlag(LF.CLIPPED_OUT)) return this.objs[k] as SmallEnemy; return null; }
}

/** TSmallEnemy::SE_LF.MELT_ON_DEATH: VERSION_SELECT(0x20000, GMSJ01(0x10000)), LF.UNK10000's bit */
export const SE_LF = { get MELT_ON_DEATH() { return LF.UNK10000; } };

export class SmallEnemy extends SpineEnemy {
    unk150 = 0; unk154 = 1; unk158 = 1; currentBck = -1; sprayCooldown = 0; unk164 = 0; unk165 = false;
    juiceBlock: any = null; coinId = -1; coin: any = null; unk184 = 0; unk185 = 0; unk188 = 1; unk18C = 0;
    /** unk190: the constructor leaves it (the heap's: zeros, as v3 has them; reset() sets it) */
    unk190 = 0;
    get P(): SmallParams { return this.getSaveParam(); }
    constructor(w: World, name = '') { super(w, name); }
    setMActorAndKeeper() { this.mactor = this.createMActor(0); }
    init(m: any) {
        this.manager = m;
        m.manageActor(this);
        this.setMActorAndKeeper();
        this.onLiveFlag(LF.DEAD);
        if (this.world.map === 2 && this.world.stage === 0) this.onLiveFlag(LF.UNK2000);
        this.onHitFilter(HF.NO_COLLISION);
        this.unk158 = 1;
        const P = this.P;
        this.turnSpeed = rangeRand(P.turnLow, P.turnHigh);
        this.bodyScale = rangeRand(P.scaleLow, P.scaleHigh);
        this.unk154 = this.bodyScale;
        this.bodyRadius = P.mSLBodyRadius; this.wallRadius = P.mSLWallRadius; this.headHeight = P.mSLHeadHeight;
        this.scaledBodyRadius = fr(this.bodyScale * this.bodyRadius * 15);
        const s = this.bodyScale;
        this.initHitActor(0, 5, HC.PLAYER | HC.ENEMY | HC.BOSS, P.mSLAttackRadius * s, P.mSLAttackHeight * s, P.mSLDamageRadius * s, P.mSLDamageHeight * s);
        this.groundPlane = this.world.illegal;
        if (!this.tracer.graph || this.tracer.graph.isDummy()) this.tracer.init(this.world.graphByName('main'));
        this.setGoalPath(this.marioNode());
    }
    marioNode() { return new PathNode(this.world.mario); }
    load(s: Stream) {
        super.load(s);
        this.coinId = s.s32(-1);
        if (this.coinId !== 0x65) this.unk18C = 1;
        this.reset();
    }
    loadAfter() { this.coin = this.world.newAndRegisterCoin(this.coinId); }
    behaveToWater(_a: HitActor) {
        const c = this.spine!.current;
        if (c !== SmallEnemyNerves.freeze && c !== SmallEnemyNerves.die) this.spine!.pushNerve(SmallEnemyNerves.freeze);
    }
    sendAttackMsgToMario() { this.world.mario.receiveMessage(this, MSG.ATTACK); }
    attackToMario() {
        this.sendAttackMsgToMario();
        const d = V3.sub(this.pos, this.world.mario.pos).normalize();
        this.vel.x = d.x; this.vel.z = d.z;
        d.scale(this.bodyScale * this.bodyRadius);
        this.posDelta.set(d);
    }
    reset() {
        super.reset();
        this.unk158 = 1;
        const P = this.P;
        this.turnSpeed = rangeRand(P.turnLow, P.turnHigh);
        this.bodyScale = rangeRand(P.scaleLow, P.scaleHigh);
        this.unk190 = this.unk154 = this.bodyScale;
        this.bodyRadius = P.mSLBodyRadius; this.wallRadius = P.mSLWallRadius; this.headHeight = P.mSLHeadHeight;
        this.scaledBodyRadius = fr(this.bodyScale * this.bodyRadius * 15);
        this.resetHitPoints();
        this.offLiveFlag(LF.DEAD); this.offLiveFlag(LF.UNK20000); this.offLiveFlag(SE_LF.MELT_ON_DEATH); this.offLiveFlag(LF.HIDDEN);
        if (P.mSLGenerateOnlyDead) this.offLiveFlag(LF.UNK800); else this.onLiveFlag(LF.UNK800);
        this.tracer.prev = -1;
        this.goToShortestNextGraphNode();
        this.offHitFilter(HF.NO_COLLISION);
        this.spine!.reset();
        this.spine!.pushAfterCurrent(this.spine!.default);
        this.scale.set(this.bodyScale, this.bodyScale, this.bodyScale);
        this.sprayCooldown = 0; this.unk165 = false; this.unk184 = 0;
        const s = this.bodyScale;
        this.setHitParams(P.mSLAttackRadius * s, P.mSLAttackHeight * s, P.mSLDamageRadius * s, P.mSLDamageHeight * s);
        this.unk164 = 0;
        this.calcEnemyRootMatrixBasic();
    }
    /** MsMtxSetXYZRPH(getModel()->getBaseTRMtx(), ...) */
    calcEnemyRootMatrixBasic() { this.calcRootMatrixBasic(); }
    forceKill() {
        const g = this.groundPlane;
        if (!(g.isIllegal() || (!g.isDeathPlane() && !g.isPool() && !g.isWaterSurface()) || this.isAirborne() || this.checkLiveFlag(LF.UNK10)) || !this.world.isInArea(this.pos.x, this.pos.z)) {
            if (this.spine!.current !== SmallEnemyNerves.die) {
                this.spine!.reset();
                this.spine!.setNext(SmallEnemyNerves.die);
                this.spine!.pushAfterCurrent(this.spine!.default);
                this.onLiveFlag(LF.UNK20000);
                this.hitPoints = 1;
            }
        }
    }
    genRandomItem() {
        if (!this.getSaveParam()) return;
        this.setAfterDeadEffect();
        this.genEventCoin();
        if (!this.checkLiveFlag(LF.UNK20000 | LF.DEAD)) this.generateItem();
    }
    genEventCoin() {
        if (this.checkLiveFlag(LF.UNK20000)) return;
        if (this.coin) {
            const c = this.world.makeCoinAppear(this.coin);
            if (c) { c.pos.set(this.pos); c.vel.set(0, 20, 0); c.offLiveFlag(LF.UNK10); --this.unk18C; }
        }
        for (let i = 0; i < this.unk18C; ++i) {
            const a = fr((360 / this.unk18C) * i + this.rot.y);
            const lz = this.unk18C === 1 ? 1 : 100;
            const dx = fr(MsSin(a) * lz), dz = fr(MsCos(a) * lz);
            const c = this.world.makeCoinAt(this.pos.x + dx, this.pos.y, this.pos.z + dz);
            if (c) {
                c.pos.y = this.pos.y;
                // genEventCoin: MsVECNormalize(&local_d0, &local_d0) -- the raw frsqrte estimate,
                // no Newton step, no zero guard -- not a Math.hypot-based normalize.
                const n = vNormMs(new V3(dx, 0, dz));
                c.vel.set(fr(n.x * 4), rangeRand(8, 16), fr(n.z * 4));
                c.offLiveFlag(LF.UNK10);
            }
        }
    }
    setAfterDeadEffect() { this.world.effect('enemyDisappear', this.pos, this.scale); this.world.sound(SE.EN_COMMON_SMOKE, this.pos); }
    generateItem() {
        const r = rangeRand(0, 100);
        const P = this.P;
        if (r < P.mSLGenEggRate + P.mSLGenItemRate && !this.groundPlane.isIllegal()) this.world.effect('itemWater', new V3(this.pos.x, this.groundHeight, this.pos.z));
    }
    isCollidMove(a: HitActor) {
        if (a.getHitCategory() === (HC.MAP_OBJECT | 0)) return false;
        return !(a as any).isAirborne?.() && !this.isAirborne();
    }
    isInhibitedForceMove() { return false; }
    setBehavior() { }
    moveObject() {
        if (this.checkLiveFlag(LF.DEAD)) return;
        const P = this.P, s = this.bodyScale;
        this.attackRadius = fr(P.mSLAttackRadius * s); this.attackHeight = fr(P.mSLAttackHeight * s);
        this.damageRadius = fr(P.mSLDamageRadius * s); this.damageHeight = fr(P.mSLDamageHeight * s);
        this.calcEntryRadius();
        this.ensureTakeSituation();
        this.posDelta.zero(); this.rotDelta.zero();
        this.control();
        if (!this.isInhibitedForceMove()) this.calcRideMomentum();
        for (const col of this.collisions.slice()) {
            if (col.isActorType(AT.MARIO)) { this.attackToMario(); continue; }
            if (!this.isCollidMove(col)) continue;
            const d = V3.sub(this.pos, col.pos);
            if (d.x === 0 && d.y === 0 && d.z === 0) d.x += 1;
            msVecNormalize(d, d); d.scale(fr(fr(this.marchSpeed * 3) * this.unk158));   // (MsVECNormalize; f32 products)
            this.posDelta.set(d);
        }
        this.bind();
        this.forceKill();
        this.setBehavior();
        this.pos.add(this.posDelta).fround();
        this.rot.add(this.rotDelta).fround();
        if (this.sprayCooldown > 0) ++this.sprayCooldown;
        if (this.sprayCooldown > 30) this.sprayCooldown = 0;
        if (this.mapCollision) this.mapCollision.moveSRT(this.pos, this.rot, this.scale);
        if (!this.isInhibitedForceMove()) this.calcRidePos();
    }
    isEatenByYosshi() { return true; }
    behaveToTaken(_a: HitActor) { }
    behaveToRelease() { }
    isHitValid(_m: number) { return !this.checkLiveFlag(LF.HIDDEN); }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (this.isEatenByYosshi() && msg === MSG.TAKE && !this.holder) {
            this.onHitFilter(HF.NO_COLLISION);
            this.holder = sender as TakeActor;
            this.behaveToTaken(sender);
            return true;
        }
        if ((msg === MSG.PUT || msg === MSG.THROWN) && this.holder === sender) {
            this.holder = null; this.behaveToRelease(); this.offHitFilter(HF.NO_COLLISION); return true;
        }
        if (msg === MSG.TRAMPLE || msg === MSG.HIP_DROP || msg === MSG.SUPER_HIP_DROP || msg === MSG.UNKB || (this.actorType === AT.AMI_NOKO && msg === MSG.PUNCH)) {
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
    /** changeByJuice: Yoshi's juice (unk5D5F 1-3) turns it into a JuiceBlock */
    changeByJuice() {
        const W = this.world.water as any, juice = W ? W.juice : 0;
        if (juice === 1 || juice === 2 || juice === 3 || SmallEnemyManager.mTestJuiceType !== 0) {
            if (this.juiceBlock) return true;
            const mom = mapObjGlobals(this.world).mapObjManager;
            const block = (mom ? mom.makeObjAppearAt(this.pos.x, this.pos.y, this.pos.z, AT.JUICE_BLOCK, true) : null) as JuiceBlock | null;
            this.juiceBlock = block;
            if (!this.juiceBlock) return false;
            block!.scale.set(0.1, 0.1, 0.1);
            block!.unk140.set(0, 0, 0);
            block!.rot.set(0, this.rot.y, 0);
            block!.unk14C = this;
            block!.offLiveFlag(LF.HIDDEN);
            this.onHitFilter(HF.NO_COLLISION);
            this.onLiveFlag(LF.HIDDEN);
            this.onLiveFlag(LF.UNK10);
            this.spine!.pushNerve(SmallEnemyNerves.change);
            this.unk185 = juice;
            if (SmallEnemyManager.mTestJuiceType !== 0) this.unk185 = SmallEnemyManager.mTestJuiceType;
            const c = block!.unk138;
            switch (this.unk185) {
                case 1: c[0] = 0x1C2; c[1] = 0xDC; c[2] = 0x50; break;
                case 2: c[0] = 0x118; c[1] = 0x6E; c[2] = 0x154; break;
                case 3: c[0] = 0x1E0; c[1] = 0xFA; c[2] = 0x154; break;
            }
            this.offLiveFlag(LF.UNK800);
            return true;
        }
        return false;
    }
    getChangeBlockTime() { return SmallEnemyManager.mChangeBlockTime; }
    /** changeMove: the block bobs up and spins, then (juice 2) slides ahead or (juice 3) rises; true when it's stopped */
    changeMove() {
        const C = SmallEnemyManager, b = this.juiceBlock as JuiceBlock, t = this.spine!.time;
        const time = fr(0.2 * C.mBlockWaitTime);
        if (t <= time) {
            b.pos.y = fmadd(this.unk188, fr(fr(C.mBlockWaitMoveY * 2) * MsSin(fr(fr(t * 130) / time))), this.pos.y);
            b.rot.y = fr(this.rot.y + fr(fr(t * 1080) / time));
        } else if (t > C.mBlockWaitTime) {
            if (t > this.getChangeBlockTime() - 200) {
                if (t % 20 < 10) b.onLiveFlag(LF.HIDDEN); else b.offLiveFlag(LF.HIDDEN);
            }
            switch (this.unk185) {
                case 1: return false;
                case 2: {
                    const m = mtx(); MsMtxSetRotRPH(m, 0, this.rot.y, 0);
                    const v = psMtxMultVec(m, new V3(0, 0, 1));
                    b.pos.x = fmadd(v.x, C.mBlockMoveSpeed, b.pos.x);
                    b.pos.z = fmadd(v.z, C.mBlockMoveSpeed, b.pos.z);
                    if (this.world.isTouchedOneWallAndMoveXZ(b.pos, b.pos.y, fr(20 * this.bodyRadius))) return true;
                    const x = fmadd(300, v.x, b.pos.x), z = fmadd(300, v.z, b.pos.z);
                    const [d] = this.world.checkGround(x, fr(b.pos.y + this.headHeight), z);
                    if (d > b.pos.y) return true;
                    break;
                }
                case 3: {
                    b.pos.y = fr(b.pos.y + C.mBlockMoveSpeed);
                    const [d, pl] = this.world.checkRoof(b.pos.x, fr(b.pos.y + this.headHeight), b.pos.z);
                    if (pl && fr(b.pos.y + this.headHeight) > d && pl.actor !== b) return true;
                    break;
                }
                default: return false;
            }
            const m = mtx(); MsMtxSetRotRPH(m, 0, this.rot.y, 0);
            const v = psMtxMultVec(m, new V3(fr(0.2), 0, 0));
            if (t % 30 > 15) { b.pos.y = fr(b.pos.y + 0.5); b.pos.x = fr(b.pos.x + v.x); b.pos.z = fr(b.pos.z + v.z); }
            else { b.pos.y = fr(b.pos.y - 0.5); b.pos.x = fr(b.pos.x - v.x); b.pos.z = fr(b.pos.z - v.z); }
        }
        return false;
    }
    /** scalingChangeActor: the block grows to mBlockXZScale x mBlockYScale */
    scalingChangeActor() {
        const C = SmallEnemyManager, b = this.juiceBlock as JuiceBlock;
        const xz = MsClamp(fr(b.unk140.x + fr(0.02)), 0, C.mBlockXZScale);
        b.unk140.x = b.unk140.z = xz; b.scale.x = b.scale.z = xz;
        const y = MsClamp(fr(b.unk140.y + fr(0.01)), 0, C.mBlockYScale);
        b.unk140.y = y; b.scale.y = y;
    }
    /** changeOut: out of the block, dead (kill), where the block was */
    changeOut() {
        this.world.sound(SE.EN_TELSA_RECOVER, this.pos);
        this.kill();
        this.pos.set(this.juiceBlock.pos);
        this.mactor!.setFrameRate(ANM_FRAME_RATE, ANM_BCK);
        this.juiceBlock.kill();
        this.juiceBlock = null;
    }
    decHpByWater(a: HitActor) {
        let n = this.world.water ? this.world.water.getParticleAttack(a as WaterHitActor) : 1;
        if (n < 1) n = 1;
        if (this.hitPoints < n) { this.hitPoints = 0; return; }
        this.hitPoints -= n;
    }
    kill() {
        if (this.checkLiveFlag(LF.DEAD)) return;
        this.hitPoints = 1;
        if (this.spine!.current !== SmallEnemyNerves.die) {
            this.spine!.reset();
            this.spine!.setNext(SmallEnemyNerves.die);
            this.spine!.pushAfterCurrent(SmallEnemyNerves.die);
        }
        this.onLiveFlag(LF.UNK40);
    }
    isFindMario(k: number) {
        if (this.world.demoMode) return false;
        if (this.isAirborne()) return false;
        return !this.isMarioInWater() && this.isFindMarioFromParam(k);
    }
    isMarioInWater() {
        const m = this.world.mario;
        return m.checkFlag(0x2) || m.checkFlag(0x10000) || m.groundPlane.isWaterSurface() || m.checkFlag(0x20000);
    }
    isFindMarioFromParam(k: number) {
        const P = this.P, m = this.world.mario.pos;
        if (Math.trunc(Math.abs(m.y - this.pos.y)) < P.mSLSearchHeight)   // (abs() of an int: the game's)
            return this.isInSight(m, P.mSLSearchLength * k, P.mSLSearchAngle * k, P.mSLSearchAware * k);
        return false;
    }
    generateEffectColumWater() {
        if (this.checkLiveFlag(LF.CLIPPED_OUT)) return;
        const e = this.world.conductor.makeOneEnemyAppear(this.pos, 'エフェクト水柱マネージャー', 0) as any;
        if (!e || !e.generate) return;
        e.generate(this.pos, this.scale);
        this.world.sound(SE.EN_TOBIPUKU_TOWATER, this.pos);
    }
    setBckAnm(i: number) { this.currentBck = i; this.mactor!.setBckFromIndex(i); this.setCurAnmSound(); }   // (setAnmSound(getBas(index)))
    isBckAnm(i: number) { return this.currentBck === i; }
    unsetUnk165() { const r = this.unk165; if (r) this.unk165 = false; return r; }
    expandCollision() {
        const P = this.P, k = this.unk190 / this.unk154;
        this.setHitParams(P.mSLAttackRadius * k, P.mSLAttackHeight * k, P.mSLDamageRadius * k, P.mSLDamageHeight * k);
    }
    isEaten() {
        if (this.holder && this.holder.held === this) {
            const m = this.holder.getTakingMtx();
            if (m) { this.baseTR.set(m); this.pos.set(m[3], m[7], m[11]); return true; }
        }
        return false;
    }
    isHitWallInBound() {
        this.wallRadius = 25;
        const r: WallCheck = { center: [this.pos.x, this.pos.y + this.headHeight, this.pos.z], radius: this.wallRadius * this.bodyScale * 1.1, maxResults: 1, flags: 0, results: [] };
        if (this.world.isTouchedWallsAndMoveXZ(r)) {
            const w = r.results[0];
            const a = matan(w.n[2], w.n[0]) * (360 / 65536);
            if (this.vel.x * w.n[0] + this.vel.z * w.n[2] > 0) return false;
            this.pos.x = r.center[0]; this.pos.z = r.center[2];
            this.rot.y = a;
            this.onLiveFlag(LF.UNK10);
            this.onHitFilter(HF.NO_COLLISION);
            return true;
        }
        return false;
    }
    behaveToHitOthers(a: HitActor) {
        if (!this.isCollidMove(a)) return;
        const d = V3.sub(this.pos, a.pos);
        if (d.x === 0 && d.y === 0 && d.z === 0) d.x += 1;
        msVecNormalize(d, d); d.scale(fr(fr(this.marchSpeed * 3) * this.unk158));   // (MsVECNormalize; f32 products)
        this.posDelta.set(d);
    }
    perform(cue: number) {
        if (!this.world.demoMode && this.world.talkMode) { this.performOnlyDraw(cue); return; }
        super.perform(cue);
    }
    // the animations a subclass names (setWaitAnm...)
    setGenerateAnm() { } setWalkAnm() { } setDeadAnm() { } setFreezeAnm() { } setMeltAnm() { } setWaitAnm() { } setRunAnm() { } setDeadEffect() { }
    jumpBehavior() { } endHitWaterJump() { } doKeepDistance() { return false; }
}

type S = Spine<SmallEnemy>;
export const SmallEnemyNerves = {
    die: nerve<SmallEnemy>('TNerveSmallEnemyDie', (spine: S) => {
        const self = spine.body;
        if (spine.time === 0) {
            self.decHitPoints();
            if (self.hitPoints === 0) {
                self.onHitFilter(HF.NO_COLLISION);
                if (self.groundPlane.isWaterSurface() && !self.isAirborne()) self.generateEffectColumWater();
            }
            if (self.checkLiveFlag(SE_LF.MELT_ON_DEATH)) self.setMeltAnm();
            else {
                if (self.unk150 & 0x20) {
                    const man = self.manager as SmallEnemyManager;
                    if (self.world.pollution) self.world.pollution.stamp(man.unk58, self.pos.x, self.pos.y, self.pos.z, self.P.mSLStampRange * 32 * self.unk158);
                }
                if (self.hitPoints === 0) { self.onLiveFlag(LF.UNK8); self.setDeadAnm(); self.setDeadEffect(); }
                else return true;
            }
        }
        let wait = (self.manager as SmallEnemyManager).unk5C;
        if (self.groundPlane.isWaterSurface()) wait = 0;
        if ((self.checkCurAnmEnd(ANM_BCK) && spine.time > wait + self.mactor!.getFrameCtrl(ANM_BCK)!.end) || spine.time > 360 || self.unk184 !== 0) {
            self.genRandomItem();
            self.onHitFilter(HF.NO_COLLISION);
            self.onLiveFlag(LF.DEAD); self.onLiveFlag(LF.UNK8); self.offLiveFlag(LF.HIDDEN); self.offLiveFlag(SE_LF.MELT_ON_DEATH);
            self.holder = null;
            spine.reset();
            spine.setNext(SmallEnemyNerves.die);
            spine.pushAfterCurrent(spine.default);
            return true;
        }
        return false;
    }),
    freeze: nerve<SmallEnemy>('TNerveSmallEnemyFreeze', (spine: S) => {
        const self = spine.body;
        if (spine.time === 0) self.setFreezeAnm();
        return self.checkCurAnmEnd(ANM_BCK) && spine.time >= self.P.mSLFreezeWait;
    }),
    jump: nerve<SmallEnemy>('TNerveSmallEnemyJump', (spine: S) => {
        const self = spine.body;
        if (spine.time === 0) {
            if (self.checkLiveFlag(LF.UNK8000) || self.checkLiveFlag(LF.UNK40000)) return true;
            self.jumpBehavior();
            self.vel.y = fr(self.P.mSLJumpForce * self.bodyScale);
            self.onLiveFlag(LF.UNK8000); self.onLiveFlag(LF.AIRBORNE);
        }
        return !self.isAirborne();
    }),
    hitWaterJump: nerve<SmallEnemy>('TNerveSmallEnemyHitWaterJump', (spine: S) => {
        const self = spine.body;
        if (spine.time === 0) {
            if (self.checkLiveFlag(LF.UNK8000) || self.checkLiveFlag(LF.UNK40000)) return true;
            self.setWaitAnm(); self.jumpBehavior();
            self.vel.y = self.P.mSLJumpForce;
            self.onLiveFlag(LF.UNK8000); self.onLiveFlag(LF.AIRBORNE);
            self.rot.y = fr(self.rot.y + rangeRand(30, 100));
        }
        self.rot.y = fr(self.rot.y + rangeRand(4, 10));
        if (!self.isAirborne() || spine.time > 360) { self.endHitWaterJump(); return true; }
        return false;
    }),
    change: nerve<SmallEnemy>('TNerveSmallEnemyChange', (spine: S) => {
        const self = spine.body;
        const changeTime = self.getChangeBlockTime();
        if (spine.time === 0) self.mactor!.setFrameRate(0, ANM_BCK);
        self.scalingChangeActor();
        if (self.changeMove() || spine.time > changeTime) { self.changeOut(); return true; }
        return false;
    }),
    wait: nerve<SmallEnemy>('TNerveSmallEnemyWait', (spine: S) => {
        const self = spine.body;
        if (spine.time === 0) self.setWaitAnm();
        return self.checkCurAnmEnd(ANM_BCK) && spine.time > self.P.mSLWaitTime;
    }),
};
