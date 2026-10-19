// Yumbo (Enemy/yunbo.cpp, ユンボ): the blue flower-headed Pokey heads of Bianco Hills. They dance
// facing Mario; once he's in sight they sink into the ground (sambohead_fhide), pop up as a
// flower and shoot seeds (TYumboSeed: 16 of them, flung out in random directions, falling with
// air drag, hurting Mario) until he's out of their reach, then come back up and dance again.
// Water freezes a dancing one (sambohead_turn); then a stomp kills it.

import { fr, V3, MsRandF, MsGetRotFromZaxisY } from '../math.js';
import { World, LF, HF, HC, MSG, nerve, Spine, Stream, ANM_BCK, ANM_FRAME_RATE, HitActor, LiveActor, PSchema, CUE_MOVE, CUE_CALC_ANIM, MActor } from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemy, SmallEnemyManager, SmallEnemyNerves, smallParams } from './smallEnemy.js';
import { register } from '../scene.js';
import { setLength, qRotate, qEulerX, qEulerY } from './jgeom.js';
import { Quat } from '../math.js';

/** TYumboParams */
const YUMBO_PARAMS = {
    mRecoverTimer: ['i', 600], mShootSpeed: ['f', 55], mShootAngleX: ['f', 0.2], mSeedLife: ['i', 80], mSeedAirFric: ['f', 0.94], mSeedGravityY: ['f', 0.9],
} satisfies PSchema;

export class YumboManager extends SmallEnemyManager {
    constructor(w: World, name = 'ユンボマネージャー') { super(w, name); }
    load(s: Stream) {
        const p = smallParams('/enemy/Yumbo.prm', this.world.files, YUMBO_PARAMS);
        this.saveParams = p;
        super.load(s);
        p.mSLAttackRadius = 97; p.mSLAttackHeight = 225; p.mSLDamageRadius = 90; p.mSLDamageHeight = 225;
        // loadMaterialTable(&unk60, "/scene/samboHead/flower_blue.bmt"): the flower's blue materials
    }
    createModelData() { this.createModelDataArray(['yumbo.bmd', 'flower.bmd']); }
}

/** The seed's model (an MActor of the Yumbo's keeper), drawn while the seed flies. */
class SeedModel extends LiveActor {
    constructor(owner: Yumbo, file: string, public seed: YumboSeed) {
        super(owner.world, file);
        this.manager = owner.manager; this.mactor = this.createMActorByName(file); this.manager = null;
    }
    perform() { }
    drawn() { return !(this.seed.unk70 & 1); }
}

/** TYumboSeed (ユンボ種) */
export class YumboSeed extends HitActor {
    unk70 = 1; unk74 = 0; unk78 = new V3();
    model: SeedModel;
    constructor(public owner: Yumbo) {
        super('ユンボ種');
        this.model = new SeedModel(owner, 'samboSeed.bmd', this);
        owner.world.extras.push(this.model);
    }
    init() {
        this.initHitActor(AT.YUMBO, 1, HC.PLAYER, 30, 30, 0, 0);
        this.owner.world.addToGroup('敵グループ', this);
    }
    perform(cue: number) {
        if (this.unk70 & 1) return;
        if (cue & CUE_CALC_ANIM) {
            const m = this.model;
            m.pos.set(this.pos); m.scale.set(this.scale); m.rot.zero();
            m.calcRootMatrixBasic();
        }
        if (cue & CUE_MOVE) {
            const P = this.owner.PY;
            this.unk78.y = fr(this.unk78.y - P.mSeedGravityY);
            this.pos.add(this.unk78).fround();
            this.unk78.scale(P.mSeedAirFric).fround();
            this.checkHitActors();
            if (--this.unk74 === 0) { this.unk70 |= 1; this.onHitFilter(HF.NO_COLLISION); }
        }
        if (!(this.unk70 & 4) && (cue & CUE_CALC_ANIM) && this.model.mactor) this.model.mactor.frameUpdate();
    }
    checkHitActors() {
        for (const c of this.collisions.slice()) {
            if (c.isActorType(AT.MARIO)) { this.owner.world.mario.receiveMessage(this, MSG.ATTACK); this.unk70 |= 1; }
        }
    }
    startToMove(p: V3, v: V3, life: number) {
        this.unk70 &= ~1;
        this.pos.set(p); this.unk78.set(v); this.unk74 = life;
        this.scale.set(2, 2, 2);
        this.offHitFilter(HF.NO_COLLISION);
        this.onHitFilter(HF.NO_DAMAGE);
    }
}

export class Yumbo extends SmallEnemy {
    seeds: YumboSeed[] = [];
    unk1D4 = -1; unk1D8 = 0;
    yumbo: MActor | null = null; flower: MActor | null = null;
    get PY(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'ユンボ') { super(w, name); this.onLiveFlag(LF.UNK10); }
    init(m: any) {
        this.manager = m; m.manageActor(this);
        this.initMActorAndKeeper();
        this.spine!.initWith(YumboNerves.dancing);
        for (let i = 0; i < 16; i++) { const s = new YumboSeed(this); s.init(); this.seeds.push(s); }
        this.initCollision();
        this.unk1D4 = this.mactor ? this.mactor.jointIndex('center') : -1;
    }
    reset() { }
    initMActorAndKeeper() {
        this.yumbo = this.createMActorByName('yumbo.bmd');
        this.flower = this.createMActorByName('flower.bmd');
        if (this.flower) this.flower.bmt = this.flower.data.folder + '/flower_blue.bmt';
        this.mactor = this.yumbo;
    }
    initCollision() {
        this.initHitActor(AT.YUMBO, 1, HC.PLAYER, 97.5, 225, 90, 225);
        this.offHitFilter(HF.NO_COLLISION);
        const [h, d] = this.world.checkGround(this.pos.x, this.pos.y + this.headHeight, this.pos.z);
        this.groundHeight = h; this.groundPlane = d;
        this.scaledBodyRadius = 75;
        this.scale.set(1.5, 1.5, 1.5);
    }
    receiveMessage(s: HitActor, m: number) {
        if (this.checkLiveFlag(LF.DEAD)) return false;
        if (m === MSG.TRAMPLE || m === MSG.HIP_DROP) {
            if (!this.isFreeze()) return false;
            this.behaveHitAttack();
            return true;
        }
        return super.receiveMessage(s, m);
    }
    moveObject() {
        this.updateEffect();
        this.updateCollision();
        this.updateSquareToMario();
        super.moveObject();
    }
    perform(cue: number) {
        super.perform(cue);
        for (const s of this.seeds) s.perform(cue);
    }
    behaveToWater(_a: HitActor) {
        if (!this.isWaterproof()) { this.spine!.reset(); this.spine!.setNext(YumboNerves.freeze); }
    }
    behaveHitAttack() { this.spine!.reset(); this.spine!.setNext(SmallEnemyNerves.die); }
    updateCollision() {
        if (this.isFreeze() || this.isDead()) this.onHitFilter(HF.NO_ATTACK);
        else this.offHitFilter(HF.NO_ATTACK);
    }
    /** (PARTICLE_MS_POI_KIZETSU while frozen, PARTICLE_MS_YNB_ONPU notes while dancing: bound emitters, not modelled.) */
    updateEffect() { }
    isFindOutMario() {
        const P = this.PY, m = this.world.mario.pos;
        if (Math.trunc(Math.abs(m.y - this.pos.y)) < P.mSLSearchHeight)   // (abs() of an int, as TSmallEnemy's)
            return this.isInSight(new V3(m.x, this.pos.y, m.z), P.mSLSearchLength, P.mSLSearchAngle, P.mSLSearchAware);
        return false;
    }
    isWantToAppear() {
        const P = this.PY, m = this.world.mario.pos;
        if (P.mSLGiveUpHeight <= Math.trunc(Math.abs(m.y - this.pos.y))) return true;
        const d = V3.sub(m, this.pos); d.y = 0;
        return P.mSLGiveUpLength * P.mSLGiveUpLength < d.squared();
    }
    isAllSeedBroken() { return this.seeds.every((s) => (s.unk70 & 1) !== 0); }
    shotSeeds() {
        const seed = this.getUnusedSeed();
        if (!seed) return;
        this.mactor!.setBckFromIndex(0);
        const P = this.PY;
        const dir = V3.sub(this.world.mario.pos, this.pos);
        dir.y = fr(dir.y + 200 * (0.5 + MsRandF()));
        setLength(dir, P.mShootSpeed);
        const angle = MsGetRotFromZaxisY(dir);
        qRotate(qEulerY(-(0.017453294 * angle)), dir, dir);
        const spin = qEulerY(fr(fr(6.2831855) * MsRandF()));   // (f32 2pi; qEulerY halves it exactly)
        const tilt = qEulerX(fr(fr(-Math.PI) * P.mShootAngleX));   // (f32 pi)
        qRotate(new Quat().mul(spin, tilt), dir, dir);
        seed.startToMove(this.pos, dir, P.mSeedLife);
    }
    lookatMario() { this.rot.y = MsGetRotFromZaxisY(V3.sub(this.world.mario.pos, this.pos)); }
    changeToFlower() { this.mactor = this.flower; }
    changeToYumbo() { this.mactor = this.yumbo; }
    isWaterproof() {
        const n = this.spine!.getLatestNerve();
        return n === YumboNerves.freeze || n === SmallEnemyNerves.die || n === YumboNerves.hiding || n === YumboNerves.attack;
    }
    isFreeze() { return this.spine!.getLatestNerve() === YumboNerves.freeze; }
    isDead() { return this.spine!.getLatestNerve() === SmallEnemyNerves.die; }
    getUnusedSeed() { return this.seeds.find((s) => (s.unk70 & 1) !== 0) || null; }
    setDeadAnm() { this.setBckAnm(3); }
    doKeepDistance() { return this.isFreeze(); }
    attackToMario() { if (!this.isFreeze()) this.sendAttackMsgToMario(); }
}

type S = Spine<Yumbo>;
export const YumboNerves: Record<string, any> = {};
YumboNerves.dancing = nerve<Yumbo>('TNerveYumboDancing', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(2);
    self.lookatMario();
    if (self.isFindOutMario()) { spine.pushAfterCurrent(YumboNerves.hiding); return true; }
    return false;
});
YumboNerves.hiding = nerve<Yumbo>('TNerveYumboHiding', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.setBckAnm(4);
        self.mactor!.setFrameRate(3 * ANM_FRAME_RATE, ANM_BCK);
        self.unk1D8 = 0;
    }
    if (!self.unk1D8 && self.mactor!.getFrameCtrl(ANM_BCK)!.checkPass(34)) {
        self.world.effect('smbApRock', self.pos); self.world.effect('smbApSmoke', self.pos);
        self.unk1D8 = 1;
    }
    if (self.checkCurAnmEnd(ANM_BCK)) { spine.pushAfterCurrent(YumboNerves.attack); return true; }
    return false;
});
YumboNerves.appearing = nerve<Yumbo>('TNerveYumboAppearing', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.changeToYumbo();
        self.setBckAnm(10);
        self.world.effect('smbApRock', self.pos); self.world.effect('smbApSmoke', self.pos);
    }
    self.lookatMario();
    if (self.checkCurAnmEnd(ANM_BCK)) { spine.pushAfterCurrent(YumboNerves.dancing); return true; }
    return false;
});
YumboNerves.attack = nerve<Yumbo>('TNerveYumboAttack', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.changeToFlower(); self.shotSeeds(); }
    if (self.isWantToAppear()) { spine.pushAfterCurrent(YumboNerves.appearing); return true; }
    if (Math.trunc(self.PY.mSeedLife / 16) < spine.time) { spine.pushAfterCurrent(YumboNerves.attack); return true; }
    return false;
});
YumboNerves.freeze = nerve<Yumbo>('TNerveYumboFreeze', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(11);
    if (self.PY.mRecoverTimer < spine.time) { spine.pushAfterCurrent(YumboNerves.dancing); return true; }
    return false;
});

register('YumboManager', (w, n) => new YumboManager(w, n));
register('Yumbo', (w, n) => new Yumbo(w, n));
