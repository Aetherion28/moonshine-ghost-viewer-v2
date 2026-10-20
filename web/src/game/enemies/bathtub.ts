// The bathtub side of the Corona Mountain boss fight (stage coronaBoss): Peach floating in the tub
// (TBathtubPeach, Enemy/BathtubPeach.cpp) on the tub's water (TBathtubBinder, Enemy/BathtubBinder.cpp)
// and the Bullet Bills Bowser Jr's submarine fires (TBathtubKiller, Enemy/BathtubKiller.cpp).
//
// Peach swims round the tub keeping `angle` degrees round from Mario, `radius` out from its centre
// (TNervePeachEscape: only every other 4 frames), facing him, and loses her balance while the
// water sloshes (TNervePeachStagger); her binder floats her on the bath water and keeps her inside
// the tub's rim. In the ending demo she rides the tub's "ahiru" joint.
//
// A Bullet Bill is launched by the submarine (TKoopaJrSubmarine::launchKiller sets mKillerType,
// calls reset(), puts it at a cannon and gives it makeInitialVelocity): it flies on a parabola
// (Wander) until it may chase (mLaunchTimer out, not too high), then homes in on Mario at a
// height band above the tub (Chase), and goes straight on (Straight; the shine one ChaseStraight
// then chases again) once Mario dodges it or the tub stops attacks (after a quake). Stomped or
// sprayed it breaks (Break: the shine one leaves a water bottle or a 1-up), hitting ground, a
// wall, another Bullet Bill (after noCollisionAmongKillers) or Bowser, or at the end of its life
// it explodes (Explosion); hitting Mario from above it explodes and throws him up (mHitMario).
//
// The tub (mapobj/bathtub.ts) is found by name ("バスタブ"), the bath water (TBathWaterManager,
// "バスタブの水", bathwater.ts) too: the binder's float_ floats on its getWaterHeight.
//
// Not here: the noses' and bodies' TEV colours (makeNoseColor, the GXColorS10s: drawing only), the
// smoke and fly sound, the particles of the items, the anm sounds; the life count (TFlagManager's
// MSF_LIFE_COUNT: not kept here, so it is taken as never changing).

import { MSF } from '../flags.js';
import { fr, V3, Quat, mtx, MsSin, MsCos, MsRandF, MsMtxSetRotRPH, matan } from '../math.js';
import { World, Stream, HitActor, SpineEnemy, EnemyManager, LF, HF, MSG, ANM_BCK, ANM_BTP, ANM_FRAME_RATE, MActor, nerve, Spine, PSchema, Params, SPINE_PARAMS } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SmallEnemy, SmallEnemyManager, smallParams } from './smallEnemy.js';
import { quatRotate } from './animal.js';
import { mapObjGlobals, newAndRegisterObj } from '../mapobj/base.js';
import { marioStatus } from '../mapobj/lib.js';
import type { Bathtub } from '../mapobj/bathtub.js';
import { MsWrapFmodf } from '../mapobj/bathtub.js';

const PI = 3.1415927;
const findBathtub = (w: World) => w.search('バスタブ') as unknown as Bathtub | null;

// ---------------------------------------------------------------- TBathtubBinder
/** TBathWaterManager ("バスタブの水"): what the binder asks. */
interface BathWaterLike { getWaterHeight(x: number, z: number): number; }

export class BathtubBinder {
    unk4: Bathtub | null = null; unk8: BathWaterLike | null = null;
    /** unkC / unk10 the front's reach and radius, unk14 / unk18 the back's, unk1C the back's share, unk20 the float height */
    unkC = 0; unk10 = 0; unk14 = 0; unk18 = 0; unk1C = 0; unk20 = 0;
    constructor(public w: World) { }
    init(p1: number, p2: number, p3: number, p4: number, p5: number) {
        this.unk4 = findBathtub(this.w);
        this.unk8 = this.w.search('バスタブの水') as unknown as BathWaterLike | null;
        this.unk20 = p5; this.unkC = p1; this.unk10 = p2; this.unk14 = p3; this.unk18 = p4;
        this.unk1C = fr(this.unk18 / fr(this.unk10 + this.unk18));
        if (!this.unk4) this.unk8 = null;
        return !!this.unk4;
    }
    bind(a: SpineEnemy) { if (!this.unk4 || !this.unk4.unk29A) this.float_(a); }
    /** float_: front and back points on the water: the height between them, pitched (at most 15 degrees) along it */
    float_(a: SpineEnemy) {
        if (!this.unk8) return;
        const m = mtx();
        MsMtxSetRotRPH(m, a.rot.x, a.rot.y, a.rot.z);
        const fx = m[2], fz = m[10];
        const front = new V3(fr(fx * this.unkC + a.pos.x), a.pos.y, fr(fz * this.unkC + a.pos.z));
        this.constrain_(front, this.unk10);
        front.y = fr(this.unk20 + this.unk8.getWaterHeight(front.x, front.z));
        const back = new V3(fr(fx * -this.unk14 + a.pos.x), a.pos.y, fr(fz * -this.unk14 + a.pos.z));
        this.constrain_(back, this.unk18);
        back.y = fr(this.unk20 + this.unk8.getWaterHeight(back.x, back.z));
        const d = V3.sub(front, back);
        a.pos.y = fr(a.pos.y + fr(0.2 * fr(fr(fr(this.unk1C * d.y) + back.y) - a.pos.y)));
        if (d.x === 0 && d.y === 0 && d.z === 0) return;
        const h = fr(Math.sqrt(fr(d.x * d.x + d.z * d.z)));
        let ang = fr(matan(h, d.y) * (360 / 65536));
        ang = ang < -15 ? -15 : ang > 15 ? 15 : ang;
        a.rot.x = fr(a.rot.x + fr(0.1 * fr(ang - a.rot.x)));
        a.rot.z = 0;
        this.constrain_(a.pos, fr(0.5 * fr(this.unk10 + this.unk18)));
    }
    /** constrain_: p kept r inside the water's rim, and not below the water's centre */
    constrain_(p: V3, r: number) {
        if (!this.unk4) return;
        const D = this.unk4.getBathtubData();
        const c = D.getThing();
        const radius = fr(fr(Math.sqrt(fr(fr(D.unk3C * D.unk3C) - fr(D.unk44 * D.unk44)))) - r);
        const dx = fr(p.x - c.x), dz = fr(p.z - c.z);
        const dist = fr(dx * dx + dz * dz);
        if (dist > radius * radius) {
            const k = fr(radius * fr(1 / Math.sqrt(dist)));
            p.set(fr(k * dx + c.x), p.y, fr(k * dz + c.z));
        }
        if (p.y < c.y) p.y = c.y;
    }
}

// ---------------------------------------------------------------- TBathtubPeach
const PEACH_PARAMS = { ...SPINE_PARAMS, turnSpeed: ['f', 8], turnSpeed2: ['f', 1], speed: ['f', 16], angle: ['f', 72], range: ['f', 100], radius: ['f', 2200] } satisfies PSchema;
type PeachParams = { [K in keyof typeof PEACH_PARAMS]: number };

export class BathtubPeachManager extends EnemyManager {
    constructor(w: World, name = 'バスタブピーチマネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.saveParams = new Params('/enemy/bathtubpeach.prm', this.world.files).read(PEACH_PARAMS);
    }
    createModelData() { this.createModelDataArray(['ahiru_peach.bmd']); }
    createEnemyInstance(): SpineEnemy | null { return null; }
}

type PS = Spine<BathtubPeach>;
const PeachNerves = {
    stagger: nerve<BathtubPeach>('TNervePeachStagger', (spine: PS) => {
        const p = spine.body;
        p.changeAnm(0, 0, 2);
        return p.mactor!.curAnmEndsNext(ANM_BCK);
    }),
    escape: nerve<BathtubPeach>('TNervePeachEscape', (spine: PS) => {
        const p = spine.body, tub = findBathtub(p.world);
        if (!tub || tub.unk29A) return false;
        if (!(spine.getTime() & 4)) {
            if (tub.getBathtubData().unk64) spine.pushNerve(PeachNerves.stagger);
            return false;
        }
        p.changeAnm(1, 1, 2);
        // the point on the circle round the tub `angle` degrees away from Mario, on Peach's side
        const t = tub.getRootJointMtx(), cx = t[3], cz = t[11], P = p.getParam();
        const mp = p.world.mario.pos;
        const marioDir = fr((360 / 65536) * matan(fr(mp.z - cz), fr(mp.x - cx)));
        const peachDir = fr((360 / 65536) * matan(fr(p.pos.z - cz), fr(p.pos.x - cx)));
        let dir: number;
        if (MsWrapFmodf(peachDir - marioDir, -180, 180) < 0) dir = MsWrapFmodf(marioDir - P.angle, -180, 180);
        else dir = MsWrapFmodf(marioDir + P.angle, -180, 180);
        const r = P.radius;
        p.goTo(new V3(fr(cx + fr(r * MsSin(dir))), 0, fr(cz + fr(r * MsCos(dir)))));
        p.faceTo(p.world.mario.pos, P.turnSpeed2);
        return false;
    }),
};

export class BathtubPeach extends SpineEnemy {
    mBathtubBinder: BathtubBinder;
    constructor(w: World, name = 'バスタブピーチ') {
        super(w, name);
        this.mBathtubBinder = new BathtubBinder(w);
        this.onLiveFlag(LF.AIRBORNE);
        this.offLiveFlag(LF.ENABLE_CLIPPING);
        this.offLiveFlag(LF.UNK10);
    }
    getParam(): PeachParams { return this.getSaveParam(); }
    /** goTo: straight towards p, at most `speed` a frame */
    goTo(p: V3) {
        let dx = fr(p.x - this.pos.x), dz = fr(p.z - this.pos.z);
        const sp = this.getParam().speed;
        if (dx * dx + dz * dz > sp * sp) { const l = Math.sqrt(dx * dx + dz * dz); dx = fr(dx * (sp / l)); dz = fr(dz * (sp / l)); }
        this.pos.x = fr(this.pos.x + dx); this.pos.z = fr(this.pos.z + dz);
    }
    /** faceTo: turned towards p by at most speed degrees */
    faceTo(p: V3, speed: number) {
        const dx = fr(p.x - this.pos.x), dz = fr(p.z - this.pos.z);
        if (dx * dx + dz * dz <= 3.2e-5) return;
        const target = fr(fr((360 / 65536) * matan(dz, dx)) - 90);
        const diff = MsWrapFmodf(target - this.rot.y, -180, 180);
        if (diff < -speed) this.rot.y = MsWrapFmodf(this.rot.y - speed, -180, 180);
        else if (diff > speed) this.rot.y = MsWrapFmodf(this.rot.y + speed, -180, 180);
        else this.rot.y = target;
    }
    changeAnm(bck: number, btp: number, speed: number) {
        const a = this.mactor;
        if (!a) return;
        if (!a.checkCurBckFromIndex(bck)) a.setBckFromIndex(bck);
        if (btp !== a.getCurAnmIdx(ANM_BTP)) a.setFromIndex(ANM_BTP, btp);
        const c = a.getFrameCtrl(ANM_BCK);
        if (c) c.rate = fr(0.5 * fr(speed * ANM_FRAME_RATE));
    }
    init(m: any) {
        super.init(m);
        this.spine!.initWith(PeachNerves.escape);
        this.reset();
        this.scale.set(2, 2, 2);
    }
    reset() {
        // TODO: why the scene position is scaled down (the game's)
        this.pos.scale(0.21);
        this.mBathtubBinder.init(50, 50, 50, 50, 0);
        this.unk130 = 0;
        this.scale.set(1.5, 1.5, 1.5);
        this.binder = this.mBathtubBinder as any;
        super.reset();
        this.changeAnm(1, 1, 2);
    }
    getRootJointMtx() { return this.baseTR; }
    /** in the tub's demo she rides its "ahiru" joint */
    calcRootMatrix() {
        const tub = findBathtub(this.world);
        if (tub && tub.unk29A) { const m = tub.getPeachMtxInDemo(); if (m) { this.baseTR.set(m); return; } }
        this.calcRootMatrixBasic();
    }
}

// ---------------------------------------------------------------- TBathtubKiller
const KILLER_PARAMS = {
    fastAccelerationQuatRate: ['f', 0.05], fastChaseAcceleration: ['f', 0.2], fastChaseSpeed: ['f', 15], fastInitialSpeed: ['f', 50], fastDeadPeriod: ['i', 1800],
    shineAccelerationQuatRate: ['f', 0.05], shineChaseAcceleration: ['f', 0.2], shineChaseSpeed: ['f', 15], shineInitialSpeed: ['f', 50], shineDeadPeriod: ['i', 1800],
    mushroomProbability: ['f', 0.05], mSLColorChangeRateDelta: ['f', 0.05], mSLAccelerationQuatRate: ['f', 0.05], mSLChaseAcceleration: ['f', 0.2],
    mSLChaseSpeed: ['f', 15], mSLInitialSpeed: ['f', 20], mSLDeadPeriod: ['i', 1800], mSLStraightDistance: ['f', 50], mSLChaseMinY: ['f', 50],
    mSLChaseMaxY: ['f', 100], mSLAboidDistanceY: ['f', 0.05], mSLAboidDistance: ['f', 500], mSLChaseDistanceY: ['f', 200], mSLChaseDistance: ['f', 1000],
    mSLTrampleVelocity: ['f', 100], mSLFlyingSpeedMax: ['f', 200], mSLFlyingGravityY: ['f', 0.1], mSLBombRange: ['f', 300], aboidAngle: ['f', 10],
    mSLChaseStraightPeriod: ['i', 360], mSLSmokeInterval: ['i', 3], mSLLaunchingPeriod: ['i', 360], noCollisionAmongKillers: ['i', 360],
} satisfies PSchema;
type KillerParams = ReturnType<typeof smallParams<typeof KILLER_PARAMS>>;
/** TBathtubKillerParams: the .prm read, then (the game's constructor) most of it set over */
function killerParams(w: World): KillerParams {
    const p = smallParams('/enemy/bathtubkiller.prm', w.files, KILLER_PARAMS);
    Object.assign(p, {
        fastAccelerationQuatRate: fr(0.03), fastChaseAcceleration: fr(0.1), fastChaseSpeed: 10, fastInitialSpeed: 14, fastDeadPeriod: 720,
        shineAccelerationQuatRate: fr(0.03), shineChaseAcceleration: fr(0.03), shineChaseSpeed: 7, shineInitialSpeed: 12, shineDeadPeriod: 2400,
        mSLAccelerationQuatRate: fr(0.03), mSLChaseAcceleration: fr(0.1), mSLChaseSpeed: 8, mSLInitialSpeed: 12, mSLDeadPeriod: 1440,
        mSLColorChangeRateDelta: fr(0.16), mSLStraightDistance: 400, mSLChaseMinY: 50, mSLChaseMaxY: 100, mSLAboidDistanceY: 100, mSLAboidDistance: 100,
        mSLChaseDistanceY: 400, mSLDamageRadius: 120, mSLDamageHeight: 100, mSLAttackRadius: 100, mSLAttackHeight: 90, mSLTrampleVelocity: 500,
        mSLFlyingSpeedMax: 200, mSLFlyingGravityY: fr(0.06), mSLBombRange: 500, aboidAngle: 5, mSLChaseStraightPeriod: 420, mSLSmokeInterval: 4,
        mSLLaunchingPeriod: 240, noCollisionAmongKillers: 480, mushroomProbability: fr(0.3),
    });
    return p;
}

/** TBathtubKillerPersonality */
class KillerPersonality {
    mAccelerationQuatRate = 0; mChaseAcceleration = 0; mChaseSpeed = 0; mInitialSpeed = 0; mDeadPeriod = 0;
    makeFast(p: KillerParams) { this.mAccelerationQuatRate = p.fastAccelerationQuatRate; this.mChaseAcceleration = p.fastChaseAcceleration; this.mChaseSpeed = p.fastChaseSpeed; this.mInitialSpeed = p.fastInitialSpeed; this.mDeadPeriod = p.fastDeadPeriod; }
    makeShine(p: KillerParams) { this.mAccelerationQuatRate = p.shineAccelerationQuatRate; this.mChaseAcceleration = p.shineChaseAcceleration; this.mChaseSpeed = p.shineChaseSpeed; this.mInitialSpeed = p.shineInitialSpeed; this.mDeadPeriod = p.shineDeadPeriod; }
    makeNormal(p: KillerParams) { this.mAccelerationQuatRate = p.mSLAccelerationQuatRate; this.mChaseAcceleration = p.mSLChaseAcceleration; this.mChaseSpeed = p.mSLChaseSpeed; this.mInitialSpeed = p.mSLInitialSpeed; this.mDeadPeriod = p.mSLDeadPeriod; }
}

export const KILLER_NORMAL = 0, KILLER_SHINE = 1, KILLER_FAST = 2;
const MODEL_NORMAL = 'bathtubkiller_model1.bmd', MODEL_DOWN = 'bathtubdownkiller_model1.bmd';

const quatYDir = (q: Quat) => new V3(fr(q.x * q.y * 2 - q.w * q.z * 2), fr(1 - q.x * q.x * 2 - q.z * q.z * 2), fr(q.y * q.z * 2 + q.w * q.x * 2));
const quatZDir = (q: Quat) => new V3(fr(q.x * q.z * 2 + q.w * q.y * 2), fr(q.y * q.z * 2 - q.w * q.x * 2), fr(1 - q.x * q.x * 2 - q.y * q.y * 2));
/** MsWrapMod */
const MsWrapMod = (v: number, lo: number, hi: number) => fr(lo + fr(fr(fr(hi - lo) + fr(v - lo)) % fr(hi - lo)));
/** TDirectionCalc(dir).absDirection(target): the radians between the two yaws (atan2(x, z)) */
function absDirection(from: V3, target: number) {
    const cur = MsWrapMod(fr(Math.atan2(from.x, from.z)), 0, fr(2 * Math.PI));
    let d = target;
    if (d >= cur) { const df = d - cur; if (2 * Math.PI - df < df) d = fr(d - 2 * Math.PI); }
    else { const df = cur - d; if (2 * Math.PI - df < df) d = fr(d + 2 * Math.PI); }
    return Math.abs(fr(cur - d));
}

export class BathtubKiller extends SmallEnemy {
    mKillerType = KILLER_NORMAL;
    mPersonality = new KillerPersonality();
    mQuat = new Quat(0, 0, 0, 1);
    mAcceleration = new V3();
    mBathtub: Bathtub | null = null;
    mSmokeCounter = 0;
    mColorChangeRate = 0; mColorPhase = 0;
    mMinChaseHeight = 0; mMaxChaseHeight = 0;
    mLifetimeTimer = 0; mLaunchTimer = 0; mChaseStraightTimer = 0; mNoKillerCollisionTimer = 0; mNoCollisionTimer = 0;
    /** it hit Mario (Bowser Jr's checkNerveKillerHit reads it) */
    mHitMario = 0;
    mactors: MActor[] = [];
    constructor(w: World, name = 'バスタブキラー') { super(w, name); }
    get KP(): KillerParams { return this.getSaveParam(); }
    init(m: any) {
        super.init(m);
        this.actorType = AT.BATHTUB_KILLER;
        this.unk150 = 0x11;
        this.onLiveFlag(LF.UNK10); this.onLiveFlag(LF.DEAD); this.onLiveFlag(LF.UNK8);
        this.onHitFilter(HF.NO_COLLISION);
        this.mKillerType = KILLER_NORMAL;
        this.resetBathtubKiller();
    }
    /** TMActorKeeper(2): the flying model and the broken one */
    setMActorAndKeeper() {
        this.mactors = [this.createMActorByName(MODEL_NORMAL), this.createMActorByName(MODEL_DOWN)].filter((a): a is MActor => !!a);
        this.mactor = this.getKeeperMActor(MODEL_NORMAL);
    }
    private getKeeperMActor(file: string) { return this.mactors.find((a) => a.model.endsWith('/' + file)) || this.mactor; }
    reset() {
        super.reset();
        this.offLiveFlag(LF.DEAD); this.offLiveFlag(LF.UNK8);
        this.offHitFilter(HF.NO_COLLISION); this.offHitFilter(HF.NO_ATTACK); this.offHitFilter(HF.NO_DAMAGE);
        this.resetBathtubKiller();
    }
    resetBathtubKiller() {
        const P = this.KP;
        this.spine!.initWith(KillerNerves.wander);
        this.onLiveFlag(LF.AIRBORNE);
        this.mLifetimeTimer = 0; this.mLaunchTimer = 0; this.mChaseStraightTimer = 0; this.mNoKillerCollisionTimer = 0; this.mNoCollisionTimer = 0;
        this.mQuat.set4(0, 0, 0, 1);
        this.vel.set(0, 0, 0);
        this.mAcceleration.set(0, 0, 0);
        this.mHitMario = 0; this.mSmokeCounter = 0;
        if (this.mKillerType === KILLER_SHINE) this.mPersonality.makeShine(P);
        else if (this.mKillerType === KILLER_FAST) this.mPersonality.makeFast(P);
        else this.mPersonality.makeNormal(P);
        this.mColorPhase = 0;
        this.mColorChangeRate = P.mSLColorChangeRateDelta;
        this.mLifetimeTimer = this.mPersonality.mDeadPeriod;
        this.mLaunchTimer = P.mSLLaunchingPeriod;
        this.mNoKillerCollisionTimer = P.noCollisionAmongKillers;
        this.mMinChaseHeight = P.mSLChaseMinY;
        this.mMaxChaseHeight = P.mSLChaseMaxY;
        if (this.mKillerType === KILLER_FAST) {
            const r = fr(4 * MsRandF());
            let off = 0;
            const ri = Math.trunc(r);
            if (ri === 0) off = 120; else if (ri === 1) off = 240;
            this.mMinChaseHeight = fr(this.mMinChaseHeight + off);
            this.mMaxChaseHeight = fr(this.mMaxChaseHeight + off);
        }
    }
    /** generateItemBathtubKiller: the shine one's item: a water bottle (tank empty), else a 1-up (early on / for the last grip) */
    generateItemBathtubKiller() {
        if (this.mKillerType !== KILLER_SHINE) return;
        const mgr = this.manager as BathtubKillerManager, im = mapObjGlobals(this.world).itemManager as any;
        // TFlagManager's MSF_LIFE_COUNT (TODO: the sim never changes it: no 1-up / death counting yet)
        const lives = this.world.flags.getFlag(MSF.LIFE_COUNT);
        const wg = (this.world.mario as any).mWaterGun;
        let item: any = null;
        const p = this.pos;
        if (wg && wg.mCurrentWater === 0) item = im ? im.makeObjAppearAt(p.x, p.y, p.z, AT.BOTTLE_LARGE, true) : null;
        else if (mgr.mInitialLifeCount === lives && mgr.mEarlyMushroomRequests < 7) { mgr.generateMushroom(p); mgr.mEarlyMushroomRequests += 1; }
        else if (lives <= mgr.mInitialLifeCount + 1) {
            if (this.mBathtub && this.mBathtub.getNumGripsDead() === 3 && mgr.mFinalMushroomRequested === 0) { mgr.generateMushroom(p); mgr.mFinalMushroomRequested = 1; }
        }
        if (!item) item = im ? im.makeObjAppearAt(p.x, p.y, p.z, AT.BOTTLE_LARGE, true) : null;
        if (!item) return;
        if (item.isActorType(AT.BOTTLE_LARGE)) { this.world.effect('ms_enm_disap_a_w', item.pos, item.scale); this.world.effect('ms_enm_disap_b', item.pos, item.scale); }
    }
    killBathtubKiller() { this.mHitMario = 0; this.onLiveFlag(LF.DEAD); }
    isDying() { const c = this.spine!.current; return c === KillerNerves.explosion || c === KillerNerves.brk; }
    breakBathtubKiller() { if (!this.isDying()) this.spine!.pushNerve(KillerNerves.brk); }
    explodeBathtubKiller() { if (!this.isDying()) this.spine!.pushNerve(KillerNerves.explosion); }
    bind() {
        const p = this.pos.clone().add(this.posDelta).add(this.vel);
        this.vel.add(this.mAcceleration);
        if (!this.isDying()) {
            const [h, d] = this.world.checkGround(p.x, fr(p.y + this.headHeight), p.z);
            this.groundPlane = d;
            this.groundHeight = fr(h + 1);
            if (p.y <= fr(0.05 + this.groundHeight)) {
                this.explodeBathtubKiller();
                this.mAcceleration.set(0, 0, 0);
                this.vel.set(this.mAcceleration);
                p.y = this.groundHeight;
            }
            if (this.world.isTouchedOneWallAndMoveXZ(p, fr(p.y + this.headHeight), this.bodyRadius)) this.explodeBathtubKiller();
        }
        this.posDelta.set(V3.sub(p, this.pos));
    }
    perform(cue: number) {
        super.perform(cue);
        if (!this.mBathtub) this.mBathtub = findBathtub(this.world);
        if ((cue & 0x1) && !this.checkLiveFlag(LF.DEAD)) {
            this.updateTimers();
            if (this.mLifetimeTimer <= 0) this.explodeBathtubKiller();
            if (!this.world.isInArea(this.pos.x, this.pos.z)) this.killBathtubKiller();
            if (this.mBathtub && this.mBathtub.unk29A) this.killBathtubKiller();
        }
        // (CUE_CALC_ANIM: the nose colour, the smoke every mSLSmokeInterval, the fly sound)
    }
    getBathtubY() { return this.mBathtub ? this.mBathtub.getRootJointMtx()[7] : 0; }
    /** makeInitialVelocity: launched along v (at most mSLFlyingSpeedMax), nose turned to it */
    makeInitialVelocity(v: V3) {
        v = v.clone();
        const speed = v.length(), max = this.KP.mSLFlyingSpeedMax;
        if (speed > max) { v.normalize(); v.scale(max); }
        this.vel.set(v);
        v.normalize();
        const fwd = quatZDir(this.mQuat);
        const r = new Quat().setRotateFromTo(fwd, v, 1);
        this.mQuat.mul(r, this.mQuat);
    }
    moveParabolic() { this.mAcceleration.set(0, -this.getGravityY(), 0); this.makeVelocityQuat(); }
    moveChasing() {
        const t = this.world.mario.pos.clone();
        const minY = fr(this.mMinChaseHeight + this.getBathtubY()), maxY = fr(this.mMaxChaseHeight + this.getBathtubY());
        t.y = fr(0.5 * fr(minY + maxY));
        const d = V3.sub(t, this.pos).normalize();
        const a = this.mPersonality.mChaseAcceleration;
        this.mAcceleration.set(fr(d.x * a), fr(d.y * a), fr(d.z * a));
        this.makeAccelerationQuat();
        const z = quatZDir(this.mQuat).normalize();
        if (this.pos.y > maxY) z.y = 0 >= z.y ? z.y : 0;
        if (this.pos.y < minY) z.y = 0 >= z.y ? 0 : z.y;
        const s = this.mPersonality.mChaseSpeed;
        this.vel.set(fr(z.x * s), fr(z.y * s), fr(z.z * s));
    }
    moveStraight() {
        const d = quatZDir(this.mQuat);
        d.y = 0;
        d.normalize().scale(this.mPersonality.mChaseSpeed);
        this.vel.set(d);
        this.makeQuat(this.vel, this.mPersonality.mAccelerationQuatRate, 0.1);
    }
    makeVelocityQuat() { this.makeQuat(this.vel, 1, 0.1); }
    makeAccelerationQuat() { this.makeQuat(this.mAcceleration, this.mPersonality.mAccelerationQuatRate, 0.1); }
    /** makeQuat: the nose turned (amtY of the way) to axis, then its up rolled (amtX of the way) to level */
    makeQuat(axis: V3, amtY: number, amtX: number) {
        const n = axis.clone().normalize();
        const fwd = quatZDir(this.mQuat), up = quatYDir(this.mQuat);
        const steer = new Quat().setRotateFromTo(fwd, n, amtY);
        this.mQuat.mul(steer, this.mQuat);
        const right = new V3().cross(fwd, new V3(0, 1, 0)).fround();
        if (right.length() > 0) {
            right.normalize();
            const tilt = new Quat().setRotateAxis(right, Math.PI / 2);
            const curUp = quatRotate(tilt, fwd).fround();
            steer.setRotateFromTo(up, curUp, amtX);
            this.mQuat.mul(steer, this.mQuat);
        }
        this.mQuat.normalize();
    }
    getGravityY() { return this.KP.mSLFlyingGravityY; }
    calcRootMatrix() { this.mQuat.toMtx(this.baseTR, this.pos); }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (msg === MSG.SUPER_HIP_DROP || msg === MSG.TRAMPLE || msg === MSG.HIP_DROP) { this.breakBathtubKiller(); return true; }
        if (msg === MSG.BURN) { this.explodeBathtubKiller(); return true; }
        if (msg === MSG.UNKD) { this.kill(); return true; }
        if (msg === MSG.SPRAYED_BY_WATER) { this.behaveToWater(sender); return true; }
        return false;
    }
    attackToMario() {
        const m = this.world.mario as any;
        if (!this.isDying() && m.pos.y < this.pos.y) {
            this.spine!.pushNerve(KillerNerves.explosion);
            m.receiveMessage(this, MSG.ATTACK);
            if (typeof m.throwMario === 'function') m.throwMario(new V3(0, 1, 0), 60);   // SMS_ThrowMario
            this.mHitMario = 1;
        }
    }
    isCollidMove(a: HitActor) {
        if (this.isDying()) return false;
        if (a.isActorType(AT.BOSS_UNK29)) { this.explodeBathtubKiller(); return true; }
        if (a.isActorType(AT.BOSS_UNK21) || a.isActorType(AT.BOSS_UNK2A) || a.isActorType(AT.BOSS_UNK2C)) {
            this.explodeBathtubKiller();
            a.receiveMessage(this, MSG.ATTACK);
            return true;
        }
        if (a.isActorType(AT.BATHTUB_KILLER) && this.mNoKillerCollisionTimer <= 0) { this.explodeBathtubKiller(); return true; }
        return true;
    }
    behaveToWater(_a: HitActor) { this.breakBathtubKiller(); }
    setNormalBathtubKillerAnm() { this.mactor = this.getKeeperMActor(MODEL_NORMAL); this.setBckAnm(1); }
    setChaseBathtubKillerAnm() { this.mactor = this.getKeeperMActor(MODEL_NORMAL); this.setBckAnm(1); }
    setStraightBathtubKillerAnm() { this.mactor = this.getKeeperMActor(MODEL_NORMAL); this.setBckAnm(2); }
    setDeadBathtubKillerAnm() {
        this.mactor = this.getKeeperMActor(MODEL_DOWN);
        this.setBckAnm(0);
        this.mQuat.set4(0, 0, 0, 1);
        this.mAcceleration.set(0, 0, 0);
        this.vel.set(0, 0, 0);
        this.onLiveFlag(LF.UNK8);
    }
    updateTimers() {
        if (this.mLifetimeTimer > 0) --this.mLifetimeTimer;
        if (this.mLaunchTimer > 0) --this.mLaunchTimer;
        if (this.mChaseStraightTimer > 0) --this.mChaseStraightTimer;
        if (this.mNoKillerCollisionTimer > 0) --this.mNoKillerCollisionTimer;
        if (this.mNoCollisionTimer > 0) --this.mNoCollisionTimer;
    }
    isAttackable() {
        if (this.mBathtub && !this.mBathtub.isKillerAttackable()) return false;
        if (this.mKillerType === KILLER_FAST && this.mBathtub) {
            const m = this.world.mario.pos, b = this.mBathtub.pos;
            const dXZ = (ax: number, az: number) => Math.sqrt((ax - b.x) ** 2 + (az - b.z) ** 2);
            if (dXZ(this.pos.x, this.pos.z) > 100 + dXZ(m.x, m.z)) return false;
        }
        return true;
    }
    /** isAboided: Mario dodged it (above or below it near, or it's past him heading off; hanging, it passes through him) */
    isAboided() {
        if (this.pos.y > fr(5 + fr(this.mMaxChaseHeight + this.getBathtubY()))) return false;
        const P = this.KP, m = this.world.mario.pos;
        const dy = Math.abs(fr(m.y - this.pos.y));
        const d = new V3(fr(m.x - this.pos.x), 0, fr(m.z - this.pos.z));
        const dist = d.length();
        if (dy > P.mSLAboidDistanceY && dist <= P.mSLAboidDistance) return true;
        if (dist > P.mSLStraightDistance) return false;
        if (marioStatus(this.world) === 0x3800034B) {   // (MARIO_STATUS_HANGING)
            this.mNoCollisionTimer = 240;
            this.onHitFilter(HF.NO_COLLISION);
            return true;
        }
        d.normalize();
        const target = fr(Math.atan2(d.x, d.z));
        const ang = absDirection(quatZDir(this.mQuat), target);
        if (ang > fr(fr(P.aboidAngle * PI) / 180)) return false;
        return true;
    }
    canChase() {
        if (this.mLaunchTimer > 0) return false;
        if (this.pos.y > this.mMinChaseHeight + this.getBathtubY() + this.KP.mSLChaseDistanceY) return false;
        return true;
    }
    generateExplosion() {
        const e = this.world.conductor.makeOneEnemyAppear(this.pos, 'エフェクト爆発マネージャー', 1) as any;
        if (e && e.generate) e.generate(this.pos, this.scale);
    }
}

type KS = Spine<BathtubKiller>;
const KillerNerves = {
    wander: nerve<BathtubKiller>('TNerveBathtubKillerWander', (spine: KS) => {
        const k = spine.body;
        if (spine.getTime() === 0) k.setNormalBathtubKillerAnm();
        if (!k.isAttackable()) { spine.pushAfterCurrent(KillerNerves.straight); return true; }
        if (k.canChase()) { spine.pushAfterCurrent(KillerNerves.chase); return true; }
        k.moveParabolic();
        return false;
    }),
    chase: nerve<BathtubKiller>('TNerveBathtubKillerChase', (spine: KS) => {
        const k = spine.body;
        if (spine.getTime() === 0) k.setChaseBathtubKillerAnm();
        if (!k.isAttackable()) { spine.pushAfterCurrent(KillerNerves.straight); return true; }
        if (k.isAboided()) {
            spine.pushAfterCurrent(k.mKillerType === KILLER_SHINE ? KillerNerves.chaseStraight : KillerNerves.straight);
            return true;
        }
        k.moveChasing();
        return false;
    }),
    chaseStraight: nerve<BathtubKiller>('TNerveBathtubKillerChaseStraight', (spine: KS) => {
        const k = spine.body;
        if (spine.getTime() === 0) { k.setStraightBathtubKillerAnm(); k.mChaseStraightTimer = k.KP.mSLChaseStraightPeriod; }
        if (!k.isAttackable()) { spine.pushAfterCurrent(KillerNerves.straight); return true; }
        if (k.mNoCollisionTimer <= 0) k.offHitFilter(HF.NO_COLLISION);
        if (k.mChaseStraightTimer <= 0) { spine.pushAfterCurrent(KillerNerves.chase); return true; }
        k.moveStraight();
        return false;
    }),
    straight: nerve<BathtubKiller>('TNerveBathtubKillerStraight', (spine: KS) => {
        const k = spine.body;
        if (spine.getTime() === 0) k.setStraightBathtubKillerAnm();
        if (k.mNoCollisionTimer <= 0) k.offHitFilter(HF.NO_COLLISION);
        k.moveStraight();
        return false;
    }),
    brk: nerve<BathtubKiller>('TNerveBathtubKillerBreak', (spine: KS) => {
        const k = spine.body;
        if (spine.getTime() === 0) { k.setDeadBathtubKillerAnm(); k.generateItemBathtubKiller(); k.onHitFilter(HF.NO_COLLISION); }
        if (k.checkCurAnmEnd(ANM_BCK)) { k.killBathtubKiller(); return true; }
        return false;
    }),
    explosion: nerve<BathtubKiller>('TNerveBathtubKillerExplosion', (spine: KS) => {
        const k = spine.body;
        if (spine.getTime() === 0) { k.setDeadBathtubKillerAnm(); k.generateExplosion(); k.onHitFilter(HF.NO_COLLISION); }
        if (k.checkCurAnmEnd(ANM_BCK)) { k.killBathtubKiller(); return true; }
        return false;
    }),
};

export class BathtubKillerManager extends SmallEnemyManager {
    mInitialLifeCount = 0;
    mMushroom: any = null;
    mFinalMushroomRequested = 0; mEarlyMushroomRequests = 0;
    constructor(w: World, name = 'バスタブキラーマネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.saveParams = killerParams(this.world);
    }
    loadAfter() {
        super.loadAfter();
        newAndRegisterObj(this.world, 'mushroom1up');
        newAndRegisterObj(this.world, 'mushroom1up');
        this.mInitialLifeCount = this.world.flags.getFlag(MSF.LIFE_COUNT);
        this.mMushroom = null;
        this.mFinalMushroomRequested = 0; this.mEarlyMushroomRequests = 0;
    }
    createModelData() { this.createModelDataArray([MODEL_NORMAL, MODEL_DOWN]); }
    createEnemyInstance(): SpineEnemy | null { return new BathtubKiller(this.world); }
    generateMushroom(p: V3) {
        if (!this.mMushroom || this.mMushroom.checkLiveFlag(LF.DEAD)) {
            const im = mapObjGlobals(this.world).itemManager as any;
            this.mMushroom = im ? im.makeObjAppearAt(p.x, p.y, p.z, AT.MUSHROOM1UP, true) : null;
        }
    }
    countActiveKillers() { let n = 0; for (let i = 0; i < this.getActiveObjNum(); ++i) if (!(this.objs[i] as BathtubKiller).checkLiveFlag(LF.DEAD)) n++; return n; }
    countActiveShineKillers() {
        let n = 0;
        for (let i = 0; i < this.getActiveObjNum(); ++i) { const k = this.objs[i] as BathtubKiller; if (!k.checkLiveFlag(LF.DEAD) && k.mKillerType === KILLER_SHINE) ++n; }
        return n;
    }
}

register('BathtubPeachManager', (w, n) => new BathtubPeachManager(w, n));
register('BathtubPeach', (w, n) => new BathtubPeach(w, n));
register('BathtubKillerManager', (w, n) => new BathtubKillerManager(w, n));
register('BathtubKiller', (w, n) => new BathtubKiller(w, n));
