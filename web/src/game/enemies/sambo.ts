// Pokeys and their flowers (Enemy/hanasambo.cpp): TSamboFlower, the flower that blooms when
// sprayed (a ring of them puts out coins once all are open: TSamboFlowerCoinUnit), and is where
// a TSamboHead (サンボヘッド, the hopping head) or a THanaSambo (the Pokey) hides; TSamboLeaf,
// the leaves a head throws off coming up.

import { fr, V3, MsClamp, MsMtxSetRotRPH, mtx, mtxMultVec, MsGetRotFromZaxis, MsSin, MsCos } from '../math.js';
import { Actor, World, SpineEnemy, EnemyManager, PathNode, LF, HF, HC, MSG, nerve, Spine, Stream, ANM_BCK, HitActor, LiveActor, MActor, readParams, SPINE_PARAMS, PSchema, CUE_MOVE, CUE_CALC_ANIM } from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemy, SmallEnemyManager, SmallEnemyNerves, smallParams, rangeRand } from './smallEnemy.js';
import { WalkerEnemy, walkerParams } from './walker.js';
import { register } from '../scene.js';

const FLOWER_PARAMS = {
    ...SPINE_PARAMS,
    mSLLeafVelocityXZ: ['f', 4], mSLLeafVelocityY: ['f', 6], mSLLeafGravity: ['f', 0.2], mSLBudDist: ['f', 2000], mSLBloomTimer: ['i', 300],
    mSLCoinCircleR: ['f', 100], mSLCoinVelocityXZ: ['f', 12], mSLCoinVelocityY: ['f', 10], mSLSeedShootRange: ['f', 500], mSLSeedShootInterval: ['i', 200],
    mSLSeedGravity: ['f', 0.1], mSLSeedSpeedXZ: ['f', 10], mSLSeedSpeedY: ['f', 10],
} satisfies PSchema;

/** TSamboFlowerCoinUnit: the flowers around one flower coin; all open, the coins come out. */
class FlowerCoinUnit {
    flowers: SamboFlower[] = []; pos = new V3(); coin: any = null; count: { n: number };
    constructor(public cap: number) { this.count = { n: cap }; }
    add(f: SamboFlower) { if (this.flowers.length < this.cap) { this.flowers.push(f); f.unk164 = this.count; } }
    checkGenCoin(w: World) {
        if (!this.coin) return;
        for (const f of this.flowers) if (!f.isBloomEnd()) return;
        let total = 0;
        for (const f of this.flowers) { if (f.unk168) total++; f.unk160 = false; }
        let spawned = 0;
        for (const f of this.flowers) {
            if (!f.unk168) continue;
            const rate = spawned / total;
            const m = mtx(); MsMtxSetRotRPH(m, 0, 360 * rate, 0);
            const off = mtxMultVec(m, new V3(0, 0, f.unk16C.mSLCoinCircleR));
            const p = this.pos.clone().add(off);
            const v = off.clone().normalize();
            w.events.push({ t: w.tickCount, kind: 'coin', data: { p, v: new V3(v.x * f.unk16C.mSLCoinVelocityXZ, 8 * rate + f.unk16C.mSLCoinVelocityY, v.z * f.unk16C.mSLCoinVelocityXZ) } });
            spawned++;
        }
        this.coin = null;
    }
}

/** TSamboLeaf: a falling leaf (an SDL model, not an actor). */
export class SamboLeaf extends LiveActor {
    unk44 = false; vel38 = new V3(); rot20 = new V3();
    constructor(w: World, public mgr: SamboFlowerManager) { super(w, 'サンボリーフ'); this.manager = mgr; this.mactor = this.createMActorByName('leaf.bmd'); this.manager = null; }
    generate(p: V3) { this.pos.set(p); this.pos.y += 10; this.unk44 = true; }
    perform(cue: number) {
        if (!this.unk44) return;
        if (cue & CUE_MOVE) {
            this.pos.add(this.vel38);
            if (this.vel38.y > -20) this.vel38.y -= this.mgr.saveParams.mSLLeafGravity;
            const [h] = this.world.checkGround(this.pos.x, 20 + this.pos.y, this.pos.z);
            if (this.pos.y < h) this.unk44 = false;
        }
        if (cue & CUE_CALC_ANIM) {
            const r = MsGetRotFromZaxis(this.vel38);
            this.rot.set(0, this.rot20.y, -r.x);
            this.calcRootMatrixBasic();
        }
    }
    drawn() { return this.unk44; }
}

export class SamboFlowerManager extends EnemyManager {
    units: FlowerCoinUnit[] = []; leaves: SamboLeaf[] = [];
    constructor(w: World, name = 'サンボフラワーマネージャー') { super(w, name); }
    load(s: Stream) { super.load(s); this.saveParams = readParams('/enemy/samboflower.prm', this.world.files, FLOWER_PARAMS); }
    createModelData() { this.createModelDataArray(['flower.bmd']); }
    createEnemyInstance() { return new SamboFlower(this.world); }
    loadAfter() {
        for (let i = 0; i < 0x12; i++) { const l = new SamboLeaf(this.world, this); this.leaves.push(l); this.world.extras.push(l); }
        // the flower coins (コイン（フラワー用）) and the flowers around each (the coin's unk158 / the flower's)
        const coins = this.world.flowerCoins || [];
        const counts = coins.map(() => 0);
        const flowers = (this.objs as SamboFlower[]).filter((f) => f.name.includes('フラワー（コイン用）'));
        for (const f of flowers) if (f.unk158 < coins.length) counts[f.unk158]++;
        this.units = counts.map((n) => new FlowerCoinUnit(n));
        for (const c of coins) if (c.unk158 < this.units.length) { const u = this.units[c.unk158]; u.coin = c; u.pos.set(c.pos); c.kill?.(); }
        for (const f of flowers) if (f.unk158 < this.units.length) this.units[f.unk158].add(f);
    }
    perform(cue: number) {
        if (this.units.length && (cue & CUE_CALC_ANIM)) for (const u of this.units) u.checkGenCoin(this.world);
        super.perform(cue);
        for (const l of this.leaves) l.perform(cue);
    }
    dropLeaf(p: V3, scale: V3) {
        const rotY = [0, 120, 240];
        let dropped = 0;
        for (let i = 0; i < this.leaves.length; i++) {
            const leaf = this.leaves[i];
            if (!leaf.unk44) {
                leaf.generate(p);
                const P = this.saveParams;
                // (TVec3(0, y.rand(), xz.rand()): the arguments right to left, xz's roll first)
                const vxz = rangeRand(P.mSLLeafVelocityXZ, 1.2 * P.mSLLeafVelocityXZ);
                const vy = rangeRand(P.mSLLeafVelocityY, 1.2 * P.mSLLeafVelocityY);
                const m = mtx(); MsMtxSetRotRPH(m, 0, rotY[i] ?? 0, 0);   // (rotY[i] past 3: the stack after it, 0 here)
                leaf.vel38.set(mtxMultVec(m, new V3(0, vy, vxz)));
                leaf.rot20.set(0, (rotY[i] ?? 0) - 90, 0);
                leaf.scale.set(scale);
                dropped++;
            }
            if (dropped >= 3) break;
        }
    }
}

export class SamboFlower extends SpineEnemy {
    unk150 = false; unk154 = 0; unk158 = -1; unk15C = -1; unk160 = false; unk164: { n: number } | null = null; unk168: any = null; unk16C: any;
    constructor(w: World, name = 'サンボフラワー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.unk15C = s.s32(); this.unk158 = s.s32();
        this.unk160 = true;
        this.reset();
        this.offLiveFlag(LF.UNK800);
    }
    loadAfter() { if (this.unk15C < 0) return; this.unk168 = { kind: 'coin' }; }
    init(m: any) {
        this.manager = m; m.manageActor(this);
        this.mactor = this.createMActorByName('flower.bmd');
        if (this.mactor) this.mactor.bmt = this.mactor.data.folder + '/flower_orange.bmt';
        this.unk130 = 1;
        this.unk16C = this.getSaveParam();
        if (this.unk16C) { this.bodyRadius = this.unk16C.mSLBodyRadius; this.wallRadius = this.unk16C.mSLWallRadius; this.headHeight = this.unk16C.mSLHeadHeight; this.scaledBodyRadius = this.bodyScale * this.bodyRadius; }
        this.initHitActor(AT.SAMBO_FLOWER, 1, HC.PLAYER, this.bodyRadius, this.headHeight, this.bodyRadius, this.headHeight);
        this.onHitFilter(HF.NO_COLLISION);
        this.offLiveFlag(LF.FORCE_SHADOW);
        this.actorType = AT.SAMBO_FLOWER;
        this.unk150 = false;
        this.onLiveFlag(LF.DEAD);
    }
    receiveMessage(_s: HitActor, m: number) { if (m === MSG.SPRAYED_BY_WATER) { if (!this.unk150) this.bloom(); return true; } return false; }
    reset() {
        super.reset();
        this.mactor!.setBck('flower_wait');
        this.offHitFilter(HF.NO_COLLISION); this.offLiveFlag(LF.UNK800); this.offLiveFlag(LF.DEAD); this.offLiveFlag(LF.UNK10);
    }
    moveObject() {
        const a = this.mactor!;
        if (this.unk150) {
            if (this.checkCurAnmEnd(ANM_BCK) && a.checkCurAnm('flower_hit', ANM_BCK)) a.setBck('flower_fwait');
            if (this.unk160) {
                this.unk154++;
                if (this.unk154 > this.unk16C.mSLBloomTimer) {
                    if (a.checkCurAnm('flower_fwait', ANM_BCK)) {
                        this.unk150 = false;
                        if (this.unk164) this.unk164.n += 1;
                        a.setBck('flower_hit');
                        const fc = a.getFrameCtrl(ANM_BCK)!; fc.frame = fc.end;
                        a.setFrameRate(-2, ANM_BCK);
                    } else if (a.getFrameCtrl(ANM_BCK)!.frame < 1) { this.unk154 = 0; a.setBck('flower_wait'); }
                }
            }
        }
        if (!this.checkLiveFlag(LF.UNK10)) { const [h, d] = this.world.checkGround(this.pos.x, this.pos.y + 100, this.pos.z); this.pos.y = h; this.groundPlane = d; }
    }
    bloom() {
        this.unk150 = true; this.unk154 = 0;
        this.world.effect('samboKafun', this.pos);
        this.mactor!.setBck('flower_hit');
        if (this.unk160 && this.unk164) this.unk164.n -= 1;
    }
    isBloomEnd() { return this.mactor!.checkCurAnm('flower_fwait', ANM_BCK); }
    hide() { this.onHitFilter(HF.NO_COLLISION); this.mactor!.setBck('flower_fwait'); this.onLiveFlag(LF.DEAD); }
    perform(cue: number) {
        // TLiveActor::perform with TSpineEnemy's (an un-shared manager)
        if (this.liveFlag & (LF.UNK200 | LF.DEAD)) return;
        if (cue & CUE_MOVE) this.moveObject();
        if (cue & CUE_CALC_ANIM) { this.mactor!.frameUpdate(); if (!(this.liveFlag & (LF.HIDDEN | LF.CLIPPED_OUT))) this.calcRootMatrix(); }
    }
}

// ---------------------------------------------------------------- THanaSambo
const HANA_PARAMS = {
    mSLAttackDist: ['f', 200], mSLAttackInterval: ['i', 200], mSLAppearDist: ['f', 800], mSLHideDist: ['f', 1000], mSLAttackingTime: ['i', 30],
    mSLHeadAttackRadius: ['f', 60], mSLHeadAttackHeight: ['f', 20], mSLHeadDamageRadius: ['f', 80], mSLHeadDamageHeight: ['f', 40],
} satisfies PSchema;
export class HanaSamboManager extends SmallEnemyManager {
    constructor(w: World, name = 'ハナサンボマネージャー') { super(w, name); }
    load(s: Stream) { super.load(s); this.saveParams = smallParams('/enemy/hanasambo.prm', this.world.files, HANA_PARAMS); }
    createModelData() { this.createModelDataArray(['sambo.bmd', 'samboD.bmd']); }
    createEnemyInstance() { return new HanaSambo(this.world); }
}
class HanaSamboHead extends HitActor {
    unk68!: HanaSambo;
    receiveMessage(_s: HitActor, m: number) {
        if (m === MSG.TRAMPLE || m === MSG.HIP_DROP) { this.unk68.kill(); return true; }
        if (m === MSG.SPRAYED_BY_WATER) { this.unk68.waterDamage(); return true; }
        return false;
    }
    checkHit() { for (const c of this.collisions) if (c.isActorType(AT.MARIO)) c.receiveMessage(this, MSG.ATTACK); }
    kill() { this.onHitFilter(HF.NO_COLLISION); }
}
export class HanaSambo extends SmallEnemy {
    unk194!: HanaSamboHead; unk198: any; unk19C = new V3(); unk1A8: SamboFlower | null = null; unk1B0 = 0;
    mactorD: MActor | null = null; mactorMain: MActor | null = null;
    static mHeadJntIndex = 3; static mPollenJntIndex = 6;
    constructor(w: World, name = 'ハナサンボ') { super(w, name); }
    load(s: Stream) { super.load(s); this.reset(); this.setGoalPath(new PathNode(this.world.mario)); }
    init(m: any) {
        super.init(m);
        this.actorType = AT.HANA_SAMBO; this.unk150 = 0x11;
        this.unk198 = this.getSaveParam();
        this.spine!.initWith(HanaNerves.hide);
        this.setGoalPath(new PathNode(this.world.mario));
        this.unk194 = new HanaSamboHead('ハナサンボヘッド');
        this.world.addToGroup('敵グループ', this.unk194);
        const s = this.bodyScale, P = this.unk198;
        this.unk194.initHitActor(AT.SAMBO_HEAD, 2, HC.PLAYER, P.mSLHeadAttackRadius * s, P.mSLHeadAttackHeight * s, P.mSLHeadDamageRadius * s, P.mSLHeadDamageHeight * s);
        this.unk194.unk68 = this;
    }
    setMActorAndKeeper() { this.mactor = this.mactorMain = this.createMActorByName('sambo.bmd'); this.mactorD = this.createMActorByName('samboD.bmd'); }
    moveObject() {
        super.moveObject();
        if (this.checkLiveFlag(LF.CLIPPED_OUT)) this.unk194.pos.set(this.pos);
        else { const m = this.mactor!.anmMtx(HanaSambo.mHeadJntIndex, this.baseTR, this.scale); if (m) this.unk194.pos.set(m[12], m[13], m[14]); }
        this.unk194.checkHit();
        this.pos.x = this.unk19C.x; this.pos.z = this.unk19C.z;
    }
    kill() {
        if (this.checkLiveFlag(LF.DEAD)) return;
        this.hitPoints = 1;
        if (this.isBckAnm(7)) this.unk18C = 3;
        if (this.spine!.current !== HanaNerves.die) { this.spine!.reset(); this.spine!.setNext(HanaNerves.die); this.spine!.pushAfterCurrent(HanaNerves.die); }
        this.unk194.kill();
        this.onLiveFlag(LF.UNK40);
    }
    reset() { super.reset(); this.unk165 = false; this.unk19C.set(this.pos); if (this.mactorMain) this.mactor = this.mactorMain; }
    setWaitAnm() { this.setBckAnm(7); this.unk1B0 = 0; }
    setDeadAnm() { this.mactor = this.mactorD; this.setBckAnm(this.unk1B0 ? 10 : 0); this.unk194.kill(); this.unk1B0 = 0; this.onLiveFlag(LF.UNK8); }
    setAttackAnm() { this.setBckAnm(3); this.unk1B0 = 1; }
    waterDamage() { this.unk165 = true; if (this.changeByJuice()) return; if (this.spine!.current !== HanaNerves.wait) return; this.spine!.pushNerve(HanaNerves.freeze); }
    createPollen() { this.world.effect('samboPollen', this.pos); }
    initFlower() {
        if (!this.unk1A8) { this.unk1A8 = this.world.conductor.makeOneEnemyAppear(this.pos, 'サンボフラワーマネージャー', 1) as SamboFlower; if (this.unk1A8) this.unk1A8.reset(); }
        if (!this.unk1A8) return;
        this.unk1A8.onLiveFlag(LF.UNK10); this.unk1A8.offLiveFlag(LF.DEAD);
        this.unk1A8.pos.set(this.pos); this.unk1A8.pos.y = this.groundHeight;
    }
}
type SH = Spine<HanaSambo>;
const HanaNerves: Record<string, any> = {};
HanaNerves.appear = nerve<HanaSambo>('TNerveHanaSamboAppear', (spine: SH) => {
    const self = spine.body, P = self.unk198;
    if (spine.time === 0) { self.offLiveFlag(LF.HIDDEN); self.offHitFilter(HF.NO_COLLISION); self.setBckAnm(6); self.world.effect('samboAppear', self.pos); self.unk1A8?.hide(); }
    if (self.checkCurAnmEnd(ANM_BCK)) {
        spine.pushAfterCurrent(HanaNerves.wait);
        self.setWaitAnm();
        if (self.world.mario.pos.y < 100 + self.pos.y) { self.updateSquareToMario(); if (self.distToMarioSq < P.mSLAttackDist * P.mSLAttackDist) spine.pushAfterCurrent(HanaNerves.attack); }
        return true;
    }
    self.walkToCurPathNode(0, self.turnSpeed * 3, 0);
    return false;
});
HanaNerves.wait = nerve<HanaSambo>('TNerveHanaSamboWait', (spine: SH) => {
    const self = spine.body, P = self.unk198;
    if (spine.time === 0) self.setWaitAnm();
    if (!self.checkLiveFlag(LF.CLIPPED_OUT) && self.mactor!.getFrameCtrl(ANM_BCK)!.checkPass(16)) self.createPollen();
    if (spine.time > P.mSLAttackInterval && self.world.mario.pos.y < 100 + self.pos.y) {
        self.updateSquareToMario();
        if (self.distToMarioSq < P.mSLAttackDist * P.mSLAttackDist) { spine.pushAfterCurrent(HanaNerves.attack); return true; }
    }
    self.updateSquareToMario();
    if (self.distToMarioSq > P.mSLHideDist * P.mSLHideDist) { spine.pushAfterCurrent(HanaNerves.hide); return true; }
    self.walkToCurPathNode(0, self.turnSpeed, 0);
    return false;
});
HanaNerves.attack = nerve<HanaSambo>('TNerveHanaSamboAttack', (spine: SH) => {
    const self = spine.body, P = self.unk198;
    if (spine.time === 0) self.setAttackAnm();
    else if (self.checkCurAnmEnd(ANM_BCK)) {
        if (self.isBckAnm(3)) { self.createPollen(); self.setBckAnm(1); }
        else if (self.isBckAnm(1)) { if (spine.time > P.mSLAttackingTime && !self.unsetUnk165()) self.setBckAnm(2); else self.setBckAnm(1); }
        else { spine.pushAfterCurrent(HanaNerves.wait); return true; }
    }
    return false;
});
HanaNerves.hide = nerve<HanaSambo>('TNerveHanaSamboHide', (spine: SH) => {
    const self = spine.body, P = self.unk198;
    if (spine.time === 0) { self.setBckAnm(4); self.world.effect('samboHide', self.pos); }
    if (spine.time === 75) self.initFlower();
    if (self.checkCurAnmEnd(ANM_BCK)) { self.initFlower(); self.onHitFilter(HF.NO_COLLISION); self.setBckAnm(6); self.mactor!.setFrameRate(0, ANM_BCK); self.onLiveFlag(LF.HIDDEN); }
    self.updateSquareToMario();
    if (self.distToMarioSq < P.mSLAppearDist * P.mSLAppearDist) { spine.pushAfterCurrent(HanaNerves.appear); return true; }
    return false;
});
HanaNerves.die = nerve<HanaSambo>('TNerveHanaSamboDie', (spine: SH) => {
    const self = spine.body;
    if (spine.time === 0) { self.onHitFilter(HF.NO_COLLISION); self.setDeadAnm(); }
    else if (self.checkCurAnmEnd(ANM_BCK) || spine.time > 300) {
        self.world.effect('enemyDisappear', self.pos, self.scale);
        self.onLiveFlag(LF.DEAD); self.onLiveFlag(LF.UNK8); self.offLiveFlag(LF.HIDDEN); self.offLiveFlag(LF.UNK10000);
        self.holder = null;
        self.onHitFilter(HF.NO_COLLISION);
        spine.reset(); spine.setNext(SmallEnemyNerves.die); spine.pushAfterCurrent(spine.default);
        self.genRandomItem();
    }
    return false;
});
HanaNerves.freeze = nerve<HanaSambo>('TNerveHanaSamboFreeze', (spine: SH) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(5);
    if (self.checkCurAnmEnd(ANM_BCK)) {
        if (self.isBckAnm(5)) { if (self.unsetUnk165()) self.setBckAnm(8); }
        else if (self.unsetUnk165()) self.setBckAnm(8);
        else return true;
    }
    return false;
});

// ---------------------------------------------------------------- TSamboHead
const HEAD_PARAMS = {
    mSLAppearDist: ['f', 800], mSLHideDist: ['f', 1000], mSLMoveDist: ['f', 100], mSLMoveGravity: ['f', 0.1], mSLJumpSp: ['f', 10], mSLJumpPrepareTime: ['i', 20],
    mSLHitJumpSpXZ: ['f', 12], mSLHitJumpSpY: ['f', 10], mSLHitJumpGravity: ['f', 1], mSLHitJumpSpRateXZ: ['f', 0.3], mSLHitJumpSpRateY: ['f', 0.3], mSLJumpAngY: ['f', 30],
} satisfies PSchema;
export class SamboHeadManager extends SmallEnemyManager {
    constructor(w: World, name = 'サンボヘッドマネージャー') { super(w, name); }
    load(s: Stream) { super.load(s); this.saveParams = walkerParams('/enemy/sambohead.prm', this.world.files, HEAD_PARAMS); }
    createModelData() { this.createModelDataArray(['samboHead.bmd']); }
    createEnemyInstance() { return new SamboHead(this.world); }
}
export class SamboHead extends WalkerEnemy {
    unk194: any = null; unk198: SamboFlower | null = null; unk19C = 0; unk1A0 = new V3(); unk1AC = 0; unk1B0 = 0;
    static mBodyJntIndex = 0;
    constructor(w: World, name = 'サンボヘッド') { super(w, name); }
    load(s: Stream) { SmallEnemy.prototype.load.call(this, s); this.reset(); this.setGoalPath(new PathNode(this.world.mario)); }
    init(m: any) {
        super.init(m);
        this.actorType = AT.SAMBO_HEAD; this.unk150 = 0x11;
        this.unk194 = this.getSaveParam();
        this.spine!.initWith(HeadNerves.hide);
        this.setGoalPath(new PathNode(this.world.mario));
    }
    setMActorAndKeeper() { this.mactor = this.createMActorByName('samboHead.bmd'); }
    reset() { super.reset(); this.unk165 = false; this.unk1B0 = 0; this.unk19C = 0; this.unk1AC = 0; this.offLiveFlag(LF.UNK8); }
    kill() {
        this.hitPoints = 1;
        if (this.spine!.current !== SmallEnemyNerves.die) { this.spine!.reset(); this.spine!.setNext(SmallEnemyNerves.die); this.spine!.pushAfterCurrent(SmallEnemyNerves.die); }
        this.onLiveFlag(LF.UNK40);
    }
    behaveToWater(_a: HitActor) {
        const c = this.spine!.current;
        if (c === HeadNerves.hide || c === HeadNerves.appear || c === HeadNerves.hitWall || c === SmallEnemyNerves.die) return;
        const v = this.vel.clone(); v.y = 0;
        const m = this.world.mario.pos;
        const j = new V3(this.pos.x - m.x, 0, this.pos.z - m.z).normalize().scale(this.unk194.mSLHitJumpSpXZ);
        j.y = this.unk194.mSLHitJumpSpY;
        if (c !== HeadNerves.hitWater) this.spine!.pushNerve(HeadNerves.hitWater); else j.add(v);
        this.vel.set(j);
        this.pos.y += 2;
        this.onLiveFlag(LF.AIRBORNE);
    }
    attackToMario() {
        this.sendAttackMsgToMario();
        if (this.isAirborne()) { const m = this.world.mario.pos; this.vel.set(new V3(this.pos.x - m.x, 10, this.pos.z - m.z).normalize().scale(8)); }
        else if (this.spine!.current === HeadNerves.attack) this.spine!.pushNerve(SmallEnemyNerves.freeze);
    }
    getGravityY() {
        let g = this.gravity;
        const c = this.spine ? this.spine.current : null;
        if (c === HeadNerves.attack) g = this.unk194.mSLMoveGravity;
        if (c === HeadNerves.hitWater) g = this.unk194.mSLHitJumpGravity;
        return g;
    }
    initFlower() {
        if (!this.unk198) { this.unk198 = this.world.conductor.makeOneEnemyAppear(this.pos, 'サンボフラワーマネージャー', 1) as SamboFlower; if (this.unk198) this.unk198.reset(); }
        if (!this.unk198) return;
        this.unk198.offHitFilter(HF.NO_COLLISION); this.unk198.onLiveFlag(LF.UNK10); this.unk198.offLiveFlag(LF.DEAD);
        this.unk198.pos.y = this.groundHeight;
        this.unk198.pos.set(this.pos);
    }
    setDeadAnm() { this.setBckAnm(3); }
    setAfterDeadEffect() { this.world.effect('enemyDisappear', this.pos, new V3(1.5, 1.5, 1.5)); }
    setCrashAnm() { this.setBckAnm(1); this.world.effect('enemyWallHit', this.pos); }
    calcRootMatrix() { SpineEnemy.prototype.calcRootMatrix.call(this); }
    genEventCoin() {
        if (this.isBckAnm(1)) {
            for (let i = 0; i < 3; ++i) {
                const a = this.rot.y - 60 + 60 * i;
                const off = new V3(MsSin(a) * 100, 0, MsCos(a) * 100);
                const d = off.clone().normalize();
                this.world.events.push({ t: this.world.tickCount, kind: 'coin', data: { p: i === 1 ? this.pos.clone() : new V3(this.pos.x + off.x, this.pos.y, this.pos.z + off.z), v: new V3(d.x * 4, rangeRand(8, 16), d.z * 4) } });
            }
        } else super.genEventCoin();
    }
    /** SamboHeadRollCallback: the body joint rolls toward its velocity while it hops (for the viewer). */
    isUseCallBack() { const c = this.spine!.current; return c === HeadNerves.attack || c === HeadNerves.hitWater || c === HeadNerves.recoverWater; }
}
type SS = Spine<SamboHead>;
const HeadNerves: Record<string, any> = {};
HeadNerves.appear = nerve<SamboHead>('TNerveSamboHeadAppear', (spine: SS) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.offLiveFlag(LF.HIDDEN); self.offHitFilter(HF.NO_COLLISION);
        if (self.unk198 && self.unk198.unk150) self.unk198.bloom();
        self.setBckAnm(10);
        self.world.effect('samboAppear', self.pos);
        self.unk198?.hide();
    }
    if (spine.time === 20 && self.unk198) (self.unk198.manager as SamboFlowerManager).dropLeaf(self.pos, self.scale);
    if (self.checkCurAnmEnd(ANM_BCK)) { self.setBckAnm(12); spine.pushAfterCurrent(HeadNerves.attack); return true; }
    return false;
});
HeadNerves.attack = nerve<SamboHead>('TNerveSamboHeadAttack', (spine: SS) => {
    const self = spine.body, P = self.unk194;
    if (!self.isAirborne()) {
        if (self.unk19C > P.mSLJumpPrepareTime && self.checkCurAnmEnd(ANM_BCK)) {
            self.unk19C = 0;
            self.updateSquareToMario();
            const m = self.world.mario.pos;
            const goal = new V3(m.x - self.pos.x, 0, m.z - self.pos.z);
            if (goal.x === 0 && goal.y === 0 && goal.z === 0) goal.x += 1;
            goal.normalize();
            goal.x = goal.x * P.mSLMoveDist + self.pos.x; goal.z = goal.z * P.mSLMoveDist + self.pos.z; goal.y = self.pos.y;
            self.vel.set(self.calcVelocityToJumpToY(goal, P.mSLJumpSp, self.getGravityY()));
            self.pos.y += 2;
            self.onLiveFlag(LF.AIRBORNE);
            self.setBckAnm(8);
        } else self.unk19C++;
        if (self.checkCurAnmEnd(ANM_BCK) && self.isBckAnm(7)) self.setBckAnm(12);
        self.mactor!.setFrameRate(2, ANM_BCK);
    } else if (self.vel.y < 0 && self.isBckAnm(8)) { self.setBckAnm(7); self.mactor!.setFrameRate(0, ANM_BCK); }
    if (self.pos.y > 30 + self.groundHeight) { const lim = P.mSLJumpAngY; self.unk1AC = MsClamp(MsGetRotFromZaxis(self.vel).x, -lim, lim); }
    else self.unk1AC *= 0.8;
    self.walkToCurPathNode(0, self.isAirborne() ? 5 : self.turnSpeed, 0);
    return false;
});
HeadNerves.hide = nerve<SamboHead>('TNerveSamboHeadHide', (spine: SS) => {
    const self = spine.body, P = self.unk194;
    if (spine.time === 0) { self.setBckAnm(4); self.onHitFilter(HF.NO_COLLISION); self.world.effect('samboHide', self.pos); }
    else if (self.checkCurAnmEnd(ANM_BCK)) { self.onLiveFlag(LF.HIDDEN); self.setBckAnm(12); self.initFlower(); }
    else if (self.isFindMario(1)) {
        self.updateSquareToMario();
        if (self.distToMarioSq < P.mSLAppearDist * P.mSLAppearDist) { spine.pushAfterCurrent(HeadNerves.appear); return true; }
    }
    self.walkToCurPathNode(0, self.turnSpeed, 0);
    return false;
});
HeadNerves.hitWater = nerve<SamboHead>('TNerveSamboHeadHitWater', (spine: SS) => {
    const self = spine.body, P = self.unk194;
    if (spine.time === 0) { self.setBckAnm(5); self.unk1A0.set(self.vel); }
    if (self.isHitWallInBound()) {
        self.unk1AC = 0;
        if (self.unk1B0) self.rot.y += 180;
        spine.reset(); spine.setNext(HeadNerves.hitWall); spine.pushAfterCurrent(HeadNerves.hitWall);
        return true;
    }
    const lim = P.mSLJumpAngY;
    if (self.isBckAnm(6)) self.unk1AC = spine.time < 100 ? MsClamp(self.unk1AC - 3, -lim, lim) : MsClamp(3 + self.unk1AC, -lim, 0);
    else self.unk1AC = MsClamp(3 + self.unk1AC, -lim, lim);
    if (self.isBckAnm(5) && !self.isAirborne()) self.setBckAnm(7);
    if (self.isBckAnm(6)) { self.onLiveFlag(LF.AIRBORNE); self.pos.y = 1 + self.groundHeight; self.vel.set(self.unk1A0); }
    if (!self.isAirborne()) self.setBckAnm(6);
    if (self.checkCurAnmEnd(ANM_BCK) && self.isBckAnm(6)) {
        const r = P.mSLHitJumpSpRateXZ;
        self.setBckAnm(6);
        self.unk1A0.x *= r; self.unk1A0.z *= r; self.unk1A0.y = 0;
        self.vel.set(self.unk1A0);
        self.pos.y = self.groundHeight;
        self.offLiveFlag(LF.AIRBORNE);
        self.setBckAnm(12);
        spine.setNext(HeadNerves.attack);
        spine.pushAfterCurrent(HeadNerves.recoverWater);
        return true;
    }
    self.walkToCurPathNode(0, self.turnSpeed, 0);
    return false;
});
HeadNerves.recoverWater = nerve<SamboHead>('TNerveSamboHeadRecoverWater', (spine: SS) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(12);
    self.unk1AC *= 0.99;
    return self.checkCurAnmEnd(ANM_BCK) && self.unk1AC < 1;
});
HeadNerves.hitWall = nerve<SamboHead>('TNerveSamboHeadHitWall', (spine: SS) => {
    const self = spine.body;
    if (spine.time === 0) self.setCrashAnm();
    const wait = (self.manager as SmallEnemyManager).unk5C;
    if (self.checkCurAnmEnd(ANM_BCK) && spine.time > wait + self.mactor!.getFrameCtrl(ANM_BCK)!.end) {
        self.onLiveFlag(LF.DEAD); self.onLiveFlag(LF.UNK8); self.onLiveFlag(LF.UNK20000); self.offLiveFlag(LF.UNK10000);
        self.holder = null;
        spine.reset(); spine.setNext(SmallEnemyNerves.die); spine.pushAfterCurrent(SmallEnemyNerves.die);
        self.genRandomItem();
        return true;
    }
    return false;
});

register('SamboFlowerManager', (w, n) => new SamboFlowerManager(w, n));
register('SamboFlower', (w, n) => new SamboFlower(w, n));
register('SamboHeadManager', (w, n) => new SamboHeadManager(w, n));
register('SamboHead', (w, n) => new SamboHead(w, n));
register('HanaSamboManager', (w, n) => new HanaSamboManager(w, n));
register('HanaSambo', (w, n) => new HanaSambo(w, n));

/** TFlowerCoin (コイン（フラワー用）): only its unit index (the s32 its load ends with) and place matter here. */
class FlowerCoinRef extends Actor {
    unk158 = -1; killed = false;
    constructor(public w: World, name: string) { super(name); }
    load(s: Stream) { super.load(s); this.unk158 = new DataView(s.b.buffer, s.b.byteOffset, s.b.byteLength).getInt32(s.b.length - 4); this.w.flowerCoins.push(this); }
    kill() { this.killed = true; }
}
register('FlowerCoin', (w, n) => new FlowerCoinRef(w, n));
