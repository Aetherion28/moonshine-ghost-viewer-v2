// Bowser Jr. in Corona Mountain's final fight (coronaBoss), riding his submarine around the
// bathtub and firing Bullet Bills at Mario (Enemy/koopajr.cpp): TKoopaJr (KoopaJr, in scene.bin)
// and its manager, TKoopaJrSubmarine (made by its manager, KoopaJrSubmarineManager) with its two
// TCallbackHitActor bodies, TDirectionCalc (the angle helper they use), and TBathtubBinder
// (Enemy/BathtubBinder.cpp: the submarine floats on the tub's water). This TU is the final fight's
// only: Bowser Jr. elsewhere (Pinna Park's TBossKoopaJr..., the Plaza's TLimitKoopaJr) is other code.
//
// The submarine circles the tub (makeRelativeAngle: away from Bowser's flames, else after Mario
// once he's traceMarioAngle off to the side; makeRoundVelocity: accelerates to that point of the
// mSLRoundDistance circle round the tub's centre), rocks when sprayed (moveSwing: the swing grows,
// and with it big enough Bowser Jr. is hurt: TNerveKoopaJrDamage) and bobs as it moves or fires.
// Bowser Jr. always faces Mario; every mSLLaunchKillerPeriod (mSLLaunchKillerPeriodFast for the
// burst) he asks the tub how many Bullet Bills it allows (getNumKillerLaunchable /
// getNumKillerBurstable), the submarine opens its cannons and fires them one by one from its four
// cannon joints (normal ones lobbed in front of Mario, fast ones up and fanned out toward him);
// the last of a volley may be a shining one (appearShineKiller). He cheers (TNerveKoopaJrYahoo)
// when one hits Mario.
//
// The bathtub (mapobj/bathtub.ts) and its Bullet Bills (TBathtubKiller) are ported separately:
// found by name and used through the small interfaces below. Bowser is enemies/koopa.ts.
//
// Not here: the particles and sound gate checks, the animation sounds (.bas), Bowser Jr.'s
// light type, and the flag manager's life count (see appearShineKiller).

import { MSF } from '../flags.js';
import { fr, V3, Mtx, mtx, Quat, MsMtxSetRotRPH, MsMtxSetXYZRPH, MsRandF, matan, jgInvSqrt } from '../math.js';
import { jgSqrt } from '../vecops.js';
import { World, Stream, HitActor, LiveActor, LiveManager, SpineEnemy, EnemyManager, LF, HF, MSG, ANM_BCK, CUE_MOVE, CUE_CALC_ANIM, nerve, Nerve, readParams, SPINE_PARAMS, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import type { mat4 } from 'gl-matrix';
import { MTXConcat } from '../mapobj/lib.js';
import { Koopa, KoopaBathtub, MsWrapFmodf, MsWrapMod, jnorm } from './koopa.js';

const PI = fr(Math.PI);

// ---------------------------------------------------------------- the other actors (ported elsewhere)
/**
 * The TBathtub members Bowser Jr. and his submarine use beyond Bowser's (MoveBG/MapObjCorona.cpp).
 * Matrices are the sim's row-major 3x4.
 */
export interface KoopaJrBathtub extends KoopaBathtub {
    getKoopaJrMtxInDemo(): Mtx;
    getSubmarineMtxInDemo(): Mtx;
    getNumKillerLaunchable(): number;
    getNumKillerBurstable(): number;
    /** mBathtubData (TBathtubData): its mPos, unk3C (radius), unk44 (depth) */
    getBathtubData(): { mPos: V3; unk3C: number; unk44: number };
}
/** The TBathtubKiller members used (Enemy/BathtubKiller.cpp): a Bullet Bill of バスタブキラーマネージャー. */
export interface BathtubKillerLike extends LiveActor {
    /** 0x194 */ mKillerType: number;
    /** 0x21C: hit Mario (1) */ mHitMario: number;
    mPersonality: { mInitialSpeed: number };
    reset(): void;
    getSaveParam2(): { mSLFlyingGravityY: number };
    makeInitialVelocity(v: V3): void;
}
/** TBathtubKillerManager: unk60 mInitialLifeCount (the life count when the fight started) */
type KillerManager = EnemyManager & { mInitialLifeCount?: number };
/** TBathWaterManager (バスタブの水) */
interface BathWater { getWaterHeight(x: number, z: number): number; }
export const KILLER_NORMAL = 0, KILLER_SHINE = 1, KILLER_FAST = 2;

// ---------------------------------------------------------------- params
const KJ_PARAMS = {
    ...SPINE_PARAMS,
    mSLLaunchKillerLimit: ['f', 10000], mSLDamageRadius: ['f', 1000], mSLDamageHeight: ['f', 4000], mSLKoopaJrScale: ['f', 1.6],
    mSLFastLaunchDistance: ['f', 10000], mSLDamagePeriod: ['i', 360], mSLLaunchKillerPeriod: ['i', 1200], mSLLaunchKillerPeriodFast: ['i', 360],
} satisfies PSchema;
type KJParams = { [K in keyof typeof KJ_PARAMS]: number };
const KJS_PARAMS = {
    ...SPINE_PARAMS,
    killerTargetDistanceMin: ['f', 500], killerTargetDistance: ['f', 500], bottomHeight: ['f', 0], centerZ: ['f', 0],
    aboidKoopaFlameAngle: ['f', fr(0.1 * PI)], traceMarioAngle: ['f', fr(0.1 * PI)], mSLWavePhaseVelocity: ['f', fr(0.1 * PI)],
    mSLWaveAmplitudeMin: ['f', fr(0.12 * PI)], mSLWaveAmplitudeMaxLaunch: ['f', fr(0.12 * PI)], mSLWaveAmplitudeMax: ['f', fr(0.12 * PI)],
    mSLSwingPhaseVelocity: ['f', fr(0.1 * PI)], mSLSwingAmplitudeMin: ['f', fr(0.12 * PI)], mSLSwingAmplitudeMax: ['f', fr(0.12 * PI)],
    mSLRoundAngleVelocity: ['f', 0.05], mSLRoundDistance: ['f', 1], mSLAcceleration: ['f', 1], mSLRotationSpeed: ['f', 1], mSLSpeedMax: ['f', 8],
    mSLKoopaJrSubmarineScale: ['f', 1.6], mSLDamageRadius: ['f', 1000], mSLDamageHeight: ['f', 4000], shineKillerProbability0: ['f', 0],
    shineKillerProbability1: ['f', 0], mSLKillerIntervalFast: ['i', 30], mSLKillerInterval: ['i', 30],
} satisfies PSchema;
type KJSParams = { [K in keyof typeof KJS_PARAMS]: number };

// ---------------------------------------------------------------- TDirectionCalc
/** fabricated nearerDirection: moves direction by a full turn if that brings it closer to current */
function nearerDirection(current: number, direction: number) {
    const TWO_PI = fr(2 * PI);
    if (direction >= current) { const d = fr(direction - current); if (fr(TWO_PI - d) < d) direction = fr(direction - TWO_PI); }
    else { const d = fr(current - direction); if (fr(TWO_PI - d) < d) direction = fr(direction + TWO_PI); }
    return direction;
}
/** TDirectionCalc: a direction (radians, from +Z toward +X) */
export class DirectionCalc {
    unk0 = 0;
    constructor(v?: number | V3) { if (v instanceof V3) this.makeDirection(v); else if (v !== undefined) this.unk0 = v; }
    normalize() { this.unk0 = MsWrapFmodf(this.unk0, 0, fr(2 * PI)); }
    calcNearerDirection(d: number) { this.normalize(); return nearerDirection(this.unk0, d); }
    sub(d: number) { this.unk0 = MsWrapMod(this.unk0, 0, fr(2 * PI)); const c = this.unk0; return fr(c - nearerDirection(c, d)); }
    calcTurnDirection(target: number, speed: number) {
        this.normalize();
        this.unk0 = MsWrapMod(this.unk0, 0, fr(2 * PI));
        const c = this.unk0;
        target = nearerDirection(c, target);
        let step = speed;
        if (target > c) { if (fr(target - c) < speed) step = fr(target - c); return fr(c + step); }
        if (fr(c - target) < speed) step = fr(c - target);
        return fr(c - step);
    }
    makeDirection(v: V3) { this.unk0 = fr(Math.atan2(v.x, v.z)); }
    calcDirectionVector() { return new V3(fr(Math.sin(this.unk0)), 0, fr(Math.cos(this.unk0))); }
    absDirection(d: number) { this.unk0 = MsWrapMod(this.unk0, 0, fr(2 * PI)); const c = this.unk0; return Math.abs(fr(c - nearerDirection(c, d))); }
    static d2r(deg: number) { return fr(fr(deg * PI) / 180); }
    static r2d(rad: number) { return fr(fr(180 * rad) / PI); }
}

// ---------------------------------------------------------------- TBathtubBinder (Enemy/BathtubBinder.cpp)
/** TBathtubBinder: keeps an actor floating on the tub's water and inside the tub. */
export class BathtubBinder {
    unk4: KoopaJrBathtub | null = null; unk8: BathWater | null = null;
    unkC = 0; unk10 = 0; unk14 = 0; unk18 = 0; unk1C = 0; unk20 = 0;
    init(w: World, p1: number, p2: number, p3: number, p4: number, p5: number) {
        this.unk4 = w.search('バスタブ') as unknown as KoopaJrBathtub | null;
        this.unk8 = w.search('バスタブの水') as unknown as BathWater | null;
        this.unk20 = p5; this.unkC = p1; this.unk10 = p2; this.unk14 = p3; this.unk18 = p4;
        this.unk1C = fr(this.unk18 / fr(this.unk10 + this.unk18));
        if (!this.unk4) this.unk8 = null;
        return !!this.unk4;
    }
    bind(a: LiveActor) { if (!this.unk4 || !this.unk4.unk29A) this.float_(a); }
    float_(a: LiveActor) {
        const W = this.unk8;
        if (!W || typeof W.getWaterHeight !== 'function') return;
        const m = mtx();
        MsMtxSetRotRPH(m, a.rot.x, a.rot.y, a.rot.z);
        const fx = m[2], fz = m[10];
        const front = new V3(fr(fr(fx * this.unkC) + a.pos.x), a.pos.y, fr(fr(fz * this.unkC) + a.pos.z));
        this.constrain_(front, this.unk10);
        front.y = fr(this.unk20 + W.getWaterHeight(front.x, front.z));
        const back = new V3(fr(fr(fx * -this.unk14) + a.pos.x), a.pos.y, fr(fr(fz * -this.unk14) + a.pos.z));
        this.constrain_(back, this.unk18);
        back.y = fr(this.unk20 + W.getWaterHeight(back.x, back.z));
        const d = V3.sub(front, back);
        a.pos.y = fr(a.pos.y + fr(0.2 * fr(fr(fr(this.unk1C * d.y) + back.y) - a.pos.y)));
        if (d.squared() <= 3.81469727e-6) return;
        const h = jgSqrt(fr(fr(d.x * d.x) + fr(d.z * d.z)));
        let ang = fr(matan(h, d.y) * (360 / 65536));
        ang = ang < -15 ? -15 : ang > 15 ? 15 : ang;
        a.rot.x = fr(a.rot.x + fr(0.1 * fr(ang - a.rot.x)));
        a.rot.z = 0;
        this.constrain_(a.pos, fr(0.5 * fr(this.unk10 + this.unk18)));
    }
    constrain_(p: V3, margin: number) {
        const t = this.unk4;
        if (!t) return;
        const data = t.getBathtubData();
        const c = new V3(data.mPos.x, fr(data.mPos.y - data.unk44), data.mPos.z);
        const radius = fr(jgSqrt(fr(fr(data.unk3C * data.unk3C) - fr(data.unk44 * data.unk44))) - margin);
        const dx = fr(p.x - c.x), dz = fr(p.z - c.z), dist = fr(fr(dx * dx) + fr(dz * dz));
        if (dist > fr(radius * radius)) {
            const k = fr(radius * jgInvSqrt(dist));
            p.set(fr(fr(k * dx) + c.x), p.y, fr(fr(k * dz) + c.z));
        }
        if (p.y < c.y) p.y = c.y;
    }
}

// ---------------------------------------------------------------- TCallbackHitActor
/** TCallbackHitActor: a hit shape passing what hits it to its owner (the submarine's front and rear bodies) */
export class CallbackHitActor extends HitActor {
    constructor(w: World, name: string, type: number, dr: number, dh: number, public mOwner: HitActor) {
        super(name);
        this.initHitActor(type, 0, 0, 0, 0, dr, dh);
        this.offHitFilter(HF.NO_COLLISION);
        w.addToGroup('敵グループ', this);
    }
    receiveMessage(sender: HitActor, msg: number) { return this.mOwner.receiveMessage(sender, msg); }
}

// joint 0 is where Bowser Jr. sits, 1-4 the four cannons
const TKoopaJr_jointNameTable = ['KoopaJr_null', 'killer_null00', 'killer_null03', 'killer_null01', 'killer_null04'];
const TKoopaJr_jointIndexTable = [0, 0, 0, 0, 0];
const TKoopaJr_getJointIndex = (i: number) => TKoopaJr_jointIndexTable[i];

const findTub = (w: World) => w.search('バスタブ') as unknown as KoopaJrBathtub | null;
const killerAt = (m: EnemyManager, i: number) => m.getObj(i) as unknown as BathtubKillerLike;
/** TEnemyManager::getDeadEnemy */
function getDeadEnemy(m: EnemyManager) { const n = m.getActiveObjNum(); for (let i = 0; i < n; i++) if ((m.getObj(i) as LiveActor).checkLiveFlag(LF.DEAD)) return m.getObj(i); return null; }

// ---------------------------------------------------------------- nerves
export const KoopaJrNerves: Record<string, Nerve<any>> = {};
const N = KoopaJrNerves;
N.wait = nerve<KoopaJr>('TNerveKoopaJrWait', (s) => {
    const k = s.body;
    if (s.getTime() === 0) { k.setAnimationIndex(2); k.mTimers[TIMER_LAUNCH] = k.getParam().mSLLaunchKillerPeriod; k.mTimers[TIMER_LAUNCH_FAST] = k.getParam().mSLLaunchKillerPeriodFast; }
    return false;
});
N.damage = nerve<KoopaJr>('TNerveKoopaJrDamage', (s) => {
    const k = s.body;
    if (s.getTime() === 0) k.setAnimationIndex(0);
    return k.mTimers[TIMER_DAMAGE] <= 0 && k.mactor!.isCurAnmAlreadyEnd(ANM_BCK);
});
N.demo = nerve<KoopaJr>('TNerveKoopaJrDemo', (s) => { if (s.getTime() === 0) s.body.setAnimationIndex(0); return false; });
N.launch = nerve<KoopaJr>('TNerveKoopaJrLaunch', (s) => { const k = s.body; if (s.getTime() === 0) k.setAnimationIndex(1); return k.mactor!.isCurAnmAlreadyEnd(ANM_BCK); });
N.yahoo = nerve<KoopaJr>('TNerveKoopaJrYahoo', (s) => { const k = s.body; if (s.getTime() === 0) k.setAnimationIndex(3); return k.mactor!.isCurAnmAlreadyEnd(ANM_BCK); });
N.subWait = nerve<KoopaJrSubmarine>('TNerveKoopaJrSubmarineWait', (s) => {
    const k = s.body;
    if (s.getTime() === 0) { k.setAnimationIndex(0); const c = k.mactor!.getFrameCtrl(ANM_BCK); if (c) c.rate = 0; }
    return false;
});
N.subCannon = nerve<KoopaJrSubmarine>('TNerveKoopaJrSubmarineCannonOpenClose', (s) => {
    const k = s.body;
    if (s.getTime() === 0) { k.setAnimationIndex(0); const c = k.mactor!.getFrameCtrl(ANM_BCK); if (c) c.rate = k.mAnmRate; }
    return k.mactor!.isCurAnmAlreadyEnd(ANM_BCK);
});
N.subLaunch = nerve<KoopaJrSubmarine>('TNerveKoopaJrSubmarineLaunchKiller', (s) => {
    const k = s.body;
    if (k.mKillerIndex === k.mKillerNum && k.mTimers[TIMER_KILLER] <= 0) { const c = k.mactor!.getFrameCtrl(ANM_BCK); if (c) c.rate = k.mAnmRate; return true; }
    return false;
});

// ---------------------------------------------------------------- TKoopaJr
const TIMER_DAMAGE = 0, TIMER_LAUNCH = 1, TIMER_LAUNCH_FAST = 2;
// BCKs (koopajr folder): 0 damage, 1 shoot, 2 (wait), 3 yahoo
export class KoopaJr extends SpineEnemy {
    mTimers = [0, 0, 0];
    mBathtub: KoopaJrBathtub | null = null;
    mKoopa: Koopa | null = null;
    mSubmarine: KoopaJrSubmarine | null = null;
    mSubmarineManager: KoopaJrSubmarineManager | null = null;
    mKillerManager: KillerManager | null = null;
    constructor(w: World, name = 'クッパジュニア') {
        super(w, name);
        this.onLiveFlag(LF.UNK10);
        this.offLiveFlag(LF.ENABLE_CLIPPING);
    }
    getParam(): KJParams { return this.getSaveParam() as KJParams; }
    init(m: LiveManager | null) {
        if (!m) { super.init(m); return; }
        this.manager = m;
        m.manageActor(this);
        this.mactor = this.createMActorByName('koopajr_model.bmd');
        const P = this.getParam();
        this.initHitActor(AT.LAST_KOOPA_JR, 1, 0, 0, 0, P.mSLDamageRadius, P.mSLDamageHeight);
        this.offHitFilter(HF.NO_COLLISION);
        this.spine!.initWith(N.wait);
        this.mKillerManager = this.world.search('バスタブキラーマネージャー') as KillerManager | null;
        if (!this.mSubmarineManager) this.mSubmarineManager = this.world.search('クッパジュニアサブマリンマネージャー') as KoopaJrSubmarineManager | null;
        const s = P.mSLKoopaJrScale;
        this.scale.set(s, s, s);
        this.resetKoopaJr();
    }
    reset() { super.reset(); this.resetKoopaJr(); }
    resetKoopaJr() {
        this.spine!.reset();
        this.mTimers.fill(0);
        this.mTimers[TIMER_LAUNCH] = this.getParam().mSLLaunchKillerPeriod;
        this.mTimers[TIMER_LAUNCH_FAST] = 0;
    }
    perform(cue: number) {
        if (!this.mSubmarine && this.mSubmarineManager && this.mSubmarineManager.getObjNum() > 0) {
            this.mSubmarine = this.mSubmarineManager.getObj(0) as KoopaJrSubmarine;
            this.mSubmarine.setKoopaJr(this);
        }
        if (!this.mKoopa) { const km = this.world.search('クッパマネージャー') as EnemyManager | null; this.mKoopa = km && km.getObjNum() > 0 ? km.getObj(0) as Koopa : null; }
        if (!this.mBathtub) this.mBathtub = findTub(this.world);
        // (the game would crash without them)
        if (!this.mSubmarine || !this.mBathtub) return;
        if (cue & CUE_CALC_ANIM) this.checkSubmarineSwing();
        if (cue & CUE_MOVE) { this.updateTimers(); this.checkNerve(); }
        super.perform(cue);
    }
    calcRootMatrix() {
        const tub = this.mBathtub!;
        if (tub.unk29A) this.baseTR.set(tub.getKoopaJrMtxInDemo());
        else {
            this.pos.set(this.mSubmarine!.getJointTrans(TKoopaJr_getJointIndex(0)));
            MsMtxSetXYZRPH(this.baseTR, this.pos.x, this.pos.y, this.pos.z, this.rot.x, this.rot.y, this.rot.z);
        }
        // (setBaseScale(mScaling): this.scale)
    }
    startKoopaJrMessage(_m: number) { }
    emitKoopaJrEffects() { }
    setAnimationIndex(i: number) { this.mactor?.setBckFromIndex(i); }
    updateTimers() { for (let i = 0; i < this.mTimers.length; i++) if (this.mTimers[i] > 0) this.mTimers[i]--; }
    receiveMessage(sender: HitActor, msg: number) {
        if (msg === MSG.SPRAYED_BY_WATER) {
            this.world.effect('ms_enm_wathit', sender.pos);
            this.world.sound(SE.EN_COMMON_W_HIT_OK, this.pos);
            this.damageKoopaJr();
            return true;
        }
        return false;
    }
    damageKoopaJr() { this.mTimers[TIMER_DAMAGE] = this.getParam().mSLDamagePeriod; this.startDamageNerve(); }
    /** checkSubmarineSwing: the submarine rocking hard enough also hurts him */
    checkSubmarineSwing() {
        const s = this.mSubmarine!;
        if (s.mSwingAmplitude < fr(0.5 * s.getParam().mSLSwingAmplitudeMax)) return;
        this.mTimers[TIMER_DAMAGE] = this.getParam().mSLDamagePeriod;
        this.startDamageNerve();
    }
    startDamageNerve() {
        const sp = this.spine!;
        if (sp.current === N.wait) sp.pushNerve(N.damage);
        if (sp.current === N.launch || sp.current === N.yahoo) sp.setNext(N.damage);
    }
    checkNerve() {
        const tub = this.mBathtub!, sp = this.spine!;
        if (tub.unk29A) return;
        // (then, unreachable: if (unk29A) push TNerveKoopaJrDemo)
        if (sp.current === N.wait) { this.checkNerveKillerLaunchNormal(); this.checkNerveKillerLaunchFast(); this.checkNerveKillerHit(); }
        // always face Mario
        const m = this.world.mario.pos;
        const d = new V3(fr(m.x - this.pos.x), 0, fr(m.z - this.pos.z));
        this.rot.y = DirectionCalc.r2d(new DirectionCalc(d).unk0);
    }
    checkNerveKillerLaunchNormal() {
        if (this.mTimers[TIMER_LAUNCH] > 0) return;
        const n = this.mBathtub!.getNumKillerLaunchable();
        if (n === 0) return;
        this.mSubmarine!.prepareKillerLaunch(n);
        this.spine!.pushNerve(N.launch);
        this.mSubmarine!.spine!.pushNerve(N.subCannon);
    }
    checkNerveKillerLaunchFast() {
        if (this.mTimers[TIMER_LAUNCH_FAST] > 0) return;
        const n = this.mBathtub!.getNumKillerBurstable();
        if (n === 0) return;
        this.mSubmarine!.prepareKillerLaunchFast(n);
        this.spine!.pushNerve(N.launch);
        this.mSubmarine!.spine!.pushNerve(N.subCannon);
    }
    /** checkNerveKillerHit: he cheers whenever one of his Bullet Bills hits Mario */
    checkNerveKillerHit() {
        const km = this.mKillerManager;
        if (!km) return;
        for (let i = 0; i < km.getActiveObjNum(); i++) if (killerAt(km, i).mHitMario === 1) { this.spine!.pushNerve(N.yahoo); return; }
    }
    getBathtubY() { const m = this.mBathtub!.getRootJointMtx(); return m ? m[7] : this.mBathtub!.pos.y; }
}

export class KoopaJrManager extends EnemyManager {
    constructor(w: World, name = 'クッパジュニアマネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        // (the constructor sets these over what the file says)
        this.saveParams = {
            ...readParams('/enemy/koopajr.prm', this.world.files, KJ_PARAMS),
            mSLLaunchKillerLimit: 4200, mSLDamageRadius: 100, mSLDamageHeight: 300, mSLKoopaJrScale: 2, mSLFastLaunchDistance: 4600,
            mSLDamagePeriod: 240, mSLLaunchKillerPeriodFast: 360, mSLLaunchKillerPeriod: 840,
        };
    }
    // loadAfter: the particle (ms_koopajr_killer) only
    createModelData() { this.createModelDataArray(['koopajr_model.bmd']); }
    createEnemyInstance(): SpineEnemy | null { return null; }
}

// ---------------------------------------------------------------- TKoopaJrSubmarine
const TIMER_KILLER = 0;
/** JGeometry::TQuat4::rotate(v) */
function quatRotate(q: Quat, v: V3) {
    const x = fr(fr(fr(q.y * v.z) - fr(q.z * v.y)) + fr(q.w * v.x)), y = fr(fr(fr(-q.x * v.z) + fr(q.z * v.x)) + fr(q.w * v.y));
    const z = fr(fr(fr(q.x * v.y) - fr(q.y * v.x)) + fr(q.w * v.z)), w = fr(fr(fr(-q.x * v.x) - fr(q.y * v.y)) - fr(q.z * v.z));
    return v.set(fr(x * q.w + y * -q.z - z * -q.y + w * -q.x), fr(-x * -q.z + y * q.w + z * -q.x + w * -q.y), fr(x * -q.y - y * -q.x + z * q.w + w * -q.z));
}
const quatEuler = (ax: 'x' | 'y' | 'z', a: number) => { const s = fr(Math.sin(fr(0.5 * a))), c = fr(Math.cos(fr(0.5 * a))); return new Quat(ax === 'x' ? s : 0, ax === 'y' ? s : 0, ax === 'z' ? s : 0, c); };
/** fabricated minOf: the counterpart of JGeometry::max with the bound first */
const minOf = (a: number, b: number) => (a >= b ? b : a);
const maxOf = (a: number, b: number) => (a > b ? a : b);

export class KoopaJrSubmarine extends SpineEnemy {
    mTimers = [0];
    unk154 = 0; unk158 = 0; unk15C = 0; unk160 = 1;
    mRoundAngle = new DirectionCalc(); mRoundDistance = 0; mDirection = new DirectionCalc();
    mIsNearRoundPos = false;
    mBathtubBinder = new BathtubBinder();
    mKillerTypes = [0, 0, 0, 0, 0, 0, 0, 0]; mKillerIndex = 0; mKillerNum = 0;
    mAnmRate = 0; mIsSprayed = false;
    mSwingAmplitude = 0; mSwingPhase = 0; mWaveAmplitude = 0; mWavePhase = 0;
    mKoopaJr: KoopaJr | null = null;
    mRearBody: CallbackHitActor | null = null; mFrontBody: CallbackHitActor | null = null;
    joints: mat4[] | null = null;
    constructor(w: World, name = 'クッパジュニアサブマリン') {
        super(w, name);
        this.offLiveFlag(LF.UNK10);
        this.offLiveFlag(LF.ENABLE_CLIPPING);
    }
    getParam(): KJSParams { return this.getSaveParam() as KJSParams; }
    init(m: LiveManager | null) {
        if (!m) { super.init(m); return; }
        this.manager = m;
        m.manageActor(this);
        const P = this.getParam();
        this.initHitActor(AT.LAST_KOOPA_JR_SUBMARINE, 0, 0, 0, 0, P.mSLDamageRadius, P.mSLDamageHeight);
        this.onHitFilter(HF.NO_COLLISION);
        this.mRearBody = new CallbackHitActor(this.world, 'サブマリンリアボディ', AT.LAST_KOOPA_JR_SUBMARINE_BODY, P.mSLDamageRadius, P.mSLDamageHeight, this);
        this.mFrontBody = new CallbackHitActor(this.world, 'サブマリンフロントボディ', AT.LAST_KOOPA_JR_SUBMARINE_BODY, P.mSLDamageRadius, P.mSLDamageHeight, this);
        this.mactor = this.createMActorByName('LastKoopaJrSubmarine.bmd');
        this.spine!.initWith(N.subWait);
        for (let i = 0; i < 5; i++) TKoopaJr_jointIndexTable[i] = this.mactor ? this.mactor.jointIndex(TKoopaJr_jointNameTable[i]) : -1;
        const s = P.mSLKoopaJrSubmarineScale;
        this.scale.set(s, s, s);
        this.resetKoopaJrSubmarine();
    }
    reset() { super.reset(); this.resetKoopaJrSubmarine(); }
    resetKoopaJrSubmarine() {
        this.spine!.reset();
        this.mTimers[TIMER_KILLER] = 0;
        this.setAnimationIndex(0);
        const c = this.mactor && this.mactor.getFrameCtrl(ANM_BCK);
        this.mAnmRate = c ? c.rate : 0;
        this.mKillerIndex = 0; this.mKillerNum = 0;
        this.mKillerTypes.fill(KILLER_NORMAL);
        this.unk154 = 0; this.unk158 = 0; this.unk15C = 0; this.unk160 = 1;
        this.mDirection.unk0 = 0; this.mRoundAngle.unk0 = 0;
        this.mIsNearRoundPos = false; this.mIsSprayed = false;
        this.mSwingAmplitude = 0; this.mSwingPhase = 0; this.mWaveAmplitude = 0; this.mWavePhase = 0;
        this.mBathtubBinder.init(this.world, 150, 100, 150, 100, this.getParam().bottomHeight);
    }
    setKoopaJr(k: KoopaJr) { this.mKoopaJr = k; }
    perform(cue: number) {
        // (Bowser Jr. hands himself over on his first perform; the game would crash before that)
        if (!this.mKoopaJr || !this.mKoopaJr.mBathtub) return;
        if (cue & CUE_CALC_ANIM) { this.checkKillerLaunch(); this.makeCollisionPositions(); this.moveSwing(); }
        if (cue & CUE_MOVE) { this.updateTimers(); this.checkNerve(); }
        super.perform(cue);
        this.mRearBody?.testPerform(cue);
        this.mFrontBody?.testPerform(cue);
    }
    /** getJointTransByIndex: joint i's place as the last calc left it */
    getJointTrans(i: number) { const m = this.joints && i >= 0 ? this.joints[i] : null; return m ? new V3(fr(m[12]), fr(m[13]), fr(m[14])) : this.pos.clone(); }
    makeCollisionPositions() {
        const rear = new V3();
        for (let i = 0; i < 2; i++) rear.add(this.getJointTrans(TKoopaJr_getJointIndex(i + 3)));
        rear.scale(0.5);
        this.mRearBody!.pos.set(rear);
        this.mFrontBody!.pos.set(this.getJointTrans(TKoopaJr_jointIndexTable[0]));
    }
    moveSwing() {
        const P = this.getParam(), TWO_PI = fr(2 * PI);
        if (this.mIsSprayed) {
            this.mIsSprayed = false;
            this.mSwingAmplitude = fr(this.mSwingAmplitude + fr(0.02 * PI));
            this.mSwingAmplitude = minOf(P.mSLSwingAmplitudeMax, this.mSwingAmplitude);
        }
        this.mSwingAmplitude = fr(this.mSwingAmplitude - fr(0.003 * PI));
        this.mSwingAmplitude = maxOf(P.mSLSwingAmplitudeMin, this.mSwingAmplitude);
        if (this.mSwingAmplitude <= 0) this.mSwingPhase = 0;
        this.mSwingPhase = MsWrapFmodf(fr(this.mSwingPhase + P.mSLSwingPhaseVelocity), 0, TWO_PI);
        const speedRate = fr(fr(this.vel.length()) / P.mSLSpeedMax);
        if (this.mTimers[TIMER_KILLER] > 0) {
            this.mWaveAmplitude = fr(this.mWaveAmplitude + fr(0.01 * PI));
            this.mWaveAmplitude = minOf(P.mSLWaveAmplitudeMaxLaunch, this.mWaveAmplitude);
        }
        if (speedRate > 0.5) {
            this.mWaveAmplitude = fr(this.mWaveAmplitude + fr(0.01 * PI));
            this.mWaveAmplitude = minOf(P.mSLWaveAmplitudeMax, this.mWaveAmplitude);
        }
        this.mWaveAmplitude = fr(this.mWaveAmplitude - fr(0.006 * PI));
        this.mWaveAmplitude = maxOf(P.mSLWaveAmplitudeMin, this.mWaveAmplitude);
        if (this.mWaveAmplitude <= 0) this.mWavePhase = 0;
        this.mWavePhase = MsWrapFmodf(fr(this.mWavePhase + P.mSLWavePhaseVelocity), 0, TWO_PI);
    }
    getSwingAngle() { return fr(this.mSwingAmplitude * fr(Math.sin(this.mSwingPhase))); }
    getWaveAngle() { return fr(this.mWaveAmplitude * fr(Math.sin(this.mWavePhase))); }
    bind() {
        const next = this.pos.clone().add(this.posDelta).add(this.vel);
        this.posDelta.set(V3.sub(next, this.pos));
        this.mBathtubBinder.bind(this);
    }
    calcRootMatrix() {
        const tub = this.mKoopaJr!.mBathtub!;
        if (tub.unk29A) this.baseTR.set(tub.getSubmarineMtxInDemo());
        else {
            const swing = quatEuler('z', this.getSwingAngle()), wave = quatEuler('x', this.getWaveAngle()), dir = quatEuler('y', this.mDirection.unk0);
            const rot = new Quat().mul(dir, swing);
            rot.mul(rot.clone(), wave);
            // rock around a point centerZ in front of the model's origin
            const cz = this.getParam().centerZ;
            const pivot = mtx(); pivot[11] = cz;
            const t = new V3(0, 0, -cz).add(this.pos);
            const m = rot.toMtx(mtx(), t);
            MTXConcat(m, pivot, m);
            this.baseTR.set(m);
        }
        const a = this.mactor;
        if (a) this.joints = a.anmMtxAll(this.baseTR, this.scale);
    }
    receiveMessage(sender: HitActor, msg: number) {
        if (msg === MSG.SPRAYED_BY_WATER) {
            this.world.effect('ms_enm_wathit', sender.pos);
            this.world.sound(SE.EN_COMMON_W_HIT_OK, this.pos);
            this.damageKoopaJrSubmarine();
            return true;
        }
        return false;
    }
    damageKoopaJrSubmarine() { this.mIsSprayed = true; }
    setAnimationIndex(i: number) { this.mactor?.setBckFromIndex(i); }
    prepareKillerLaunch(num: number) {
        if (num > 8) num = 8;
        this.mKillerIndex = 0; this.mKillerNum = num;
        for (let i = 0; i < num; i++) this.mKillerTypes[i] = KILLER_NORMAL;
        if (this.appearShineKiller(num)) this.mKillerTypes[num - 1] = KILLER_SHINE;
    }
    prepareKillerLaunchFast(num: number) {
        if (num > 8) num = 8;
        this.mKillerIndex = 0; this.mKillerNum = num;
        for (let i = 0; i < num; i++) this.mKillerTypes[i] = KILLER_FAST;
        if (this.appearShineKiller(num)) this.mKillerTypes[num - 1] = KILLER_SHINE;
    }
    /**
     * appearShineKiller: the last of a volley may shine (drops an item when destroyed). One half
     * with FLUDD's tank empty or no life lost since the fight began, else from
     * shineKillerProbability0 (empty tank) to shineKillerProbability1 (full).
     */
    appearShineKiller(_n: number) {
        const g = (this.world.mario as any).mWaterGun;
        const km = this.mKoopaJr && this.mKoopaJr.mKillerManager;
        // TFlagManager's MSF_LIFE_COUNT (TODO: the sim never changes it: no 1-up / death counting yet)
        const lives = this.world.flags.getFlag(MSF.LIFE_COUNT);
        let p: number;
        if (!g || g.mCurrentWater === 0) p = 0.5;
        else if (lives === undefined || !km || lives === km.mInitialLifeCount) p = 0.5;
        else {
            const max = g.getMaxWater(), water = g.mCurrentWater, P = this.getParam();
            const p0 = P.shineKillerProbability0, p1 = P.shineKillerProbability1;
            const rate = fr(water / max);
            p = fr(fr(rate * fr(p1 - p0)) + p0);
        }
        return MsRandF() < p;
    }
    checkKillerLaunch() {
        if (this.spine!.current !== N.subLaunch || this.mKillerIndex >= this.mKillerNum || this.mTimers[TIMER_KILLER] > 0) return;
        this.launchKiller();
        const P = this.getParam();
        this.mTimers[TIMER_KILLER] = this.mKillerTypes[this.mKillerIndex] === KILLER_FAST ? P.mSLKillerIntervalFast : P.mSLKillerInterval;
        this.mKillerIndex++;
    }
    launchKiller() {
        const cannon = this.mKillerIndex % 4;
        const km = this.mKoopaJr!.mKillerManager;
        const killer = km ? getDeadEnemy(km) as unknown as BathtubKillerLike | null : null;
        if (!killer) return;
        killer.mKillerType = this.mKillerTypes[this.mKillerIndex];
        killer.reset();
        const m = this.joints ? this.joints[TKoopaJr_getJointIndex(cannon + 1)] : null;
        if (m) killer.pos.set(fr(m[12]), fr(m[13]), fr(m[14])); else killer.pos.set(this.pos);
        const dir = m ? new V3(fr(m[8]), fr(m[9]), fr(m[10])) : new V3(0, 0, 1);
        this.makeKillerVelocity(killer, dir);
        this.world.sound(SE.EN_KILLER_FIRE, killer.pos);
    }
    makeKillerVelocity(killer: BathtubKillerLike, dir: V3) {
        if (this.mKillerTypes[this.mKillerIndex] === KILLER_FAST) {
            // fast ones go up first and then fan out toward Mario
            dir.set(0, 1, 0);
            const toMario = V3.sub(this.world.mario.pos, killer.pos);
            toMario.y = 0;
            jnorm(toMario);
            const axis = jnorm(new V3().cross(dir, toMario).fround());
            const rot = new Quat().setRotateAxis(axis, fr(0.2 * Math.PI));
            quatRotate(rot, dir);
            const small = fr(0.05 * PI), big = fr(0.1 * PI);
            const cannon = this.mKillerIndex % 4;
            const angle = cannon === 0 ? -small : cannon === 1 ? small : cannon === 2 ? -big : big;
            rot.setRotateAxis(toMario, angle);
            quatRotate(rot, dir);
            jnorm(dir);
            dir.scale(killer.mPersonality.mInitialSpeed);
        } else {
            // normal ones are lobbed so they come down a bit in front of Mario
            jnorm(dir);
            dir.scale(killer.mPersonality.mInitialSpeed);
            const target = this.world.mario.pos.clone();
            target.y = this.mKoopaJr!.getBathtubY();
            const diff = new V3(fr(target.x - killer.pos.x), 0, fr(target.z - killer.pos.z));
            const P = this.getParam();
            const dist = fr(fr(diff.length()) - P.killerTargetDistance);
            const reach = maxOf(dist, P.killerTargetDistanceMin);
            const off = jnorm(diff.clone()).scale(reach);
            const goal = V3.add(killer.pos, off);
            goal.y = target.y;
            // (the submarine's own calcVelocityToJumpToY: from its position)
            dir = this.calcVelocityToJumpToY(goal, dir.y, killer.getSaveParam2().mSLFlyingGravityY);
        }
        killer.makeInitialVelocity(dir);
    }
    emitKoopaJrSubmarineEffects() { }
    updateTimers() { for (let i = 0; i < this.mTimers.length; i++) if (this.mTimers[i] > 0) this.mTimers[i]--; }
    /** makeRelativeAngle: where round the tub to go — away from Bowser's flames, else after Mario once he's too far off to the side */
    makeRelativeAngle() {
        const kj = this.mKoopaJr!, koopa = kj.mKoopa, tub = kj.mBathtub!, P = this.getParam(), R = this.mRoundAngle;
        const flameDir = DirectionCalc.d2r(koopa ? koopa.getFlameDirDegree() : 0);
        // (TODO: whether unk0 is read before or after calcNearerDirection normalises it; after here)
        const nf = R.calcNearerDirection(flameDir);
        const flameDiff = Math.abs(fr(R.unk0 - nf));
        const toMario = V3.sub(this.world.mario.pos, tub.pos);
        toMario.y = 0;
        const marioDir = new DirectionCalc(toMario).unk0;
        let target = R.unk0;
        const marioDiff = Math.abs(fr(target - R.calcNearerDirection(marioDir)));
        if (koopa && koopa.isFlaming() && flameDiff <= P.aboidKoopaFlameAngle) target = fr(flameDir + PI);
        else if (marioDiff > P.traceMarioAngle) target = marioDir;
        let speed = fr(0.017453294 * P.mSLRoundAngleVelocity);
        R.unk0 = MsWrapMod(R.unk0, 0, fr(2 * PI));
        const nearer = R.calcNearerDirection(target), cur = R.unk0;
        if (nearer > cur) { if (fr(nearer - cur) < speed) speed = fr(nearer - cur); R.unk0 = fr(cur + speed); }
        else { if (fr(cur - nearer) < speed) speed = fr(cur - nearer); R.unk0 = fr(cur - speed); }
    }
    /** makeRoundVelocity: accelerate toward the point on the circle round the tub */
    makeRoundVelocity() {
        const off = this.mRoundAngle.calcDirectionVector().scale(this.mRoundDistance);
        const c = this.mKoopaJr!.mBathtub!.pos;
        const diff = new V3(fr(fr(c.x + off.x) - this.pos.x), 0, fr(fr(c.z + off.z) - this.pos.z));
        if (diff.length() < 100) { this.mIsNearRoundPos = true; return; }
        this.mIsNearRoundPos = false;
        const P = this.getParam();
        this.vel.add(jnorm(diff).scale(P.mSLAcceleration));
        if (this.vel.length() > P.mSLSpeedMax) { jnorm(this.vel); this.vel.scale(P.mSLSpeedMax); }
    }
    makeDirection() {
        const d = jnorm(this.vel.clone());
        const t = new DirectionCalc(d);
        this.mDirection.unk0 = this.mDirection.calcTurnDirection(t.unk0, DirectionCalc.d2r(this.getParam().mSLRotationSpeed));
    }
    checkNerve() {
        const kj = this.mKoopaJr!;
        if (kj.spine!.current === N.wait) {
            this.makeRelativeAngle();
            this.mRoundDistance = this.getParam().mSLRoundDistance;
            this.makeRoundVelocity();
        }
        this.vel.scale(0.95);
        if (!this.mIsNearRoundPos) this.makeDirection();
        const sp = this.spine!;
        if (sp.current === N.subCannon && this.mKillerIndex === 0) {
            const c = this.mactor && this.mactor.getFrameCtrl(ANM_BCK);
            if (c && c.checkPass(30)) { c.rate = 0; sp.pushNerve(N.subLaunch); }
        }
    }
}

export class KoopaJrSubmarineManager extends EnemyManager {
    constructor(w: World, name = 'クッパジュニアサブマリンマネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        // (the constructor sets these over what the file says)
        const T = PI;
        this.saveParams = {
            ...readParams('/enemy/koopajrsubmarine.prm', this.world.files, KJS_PARAMS),
            killerTargetDistanceMin: 500, killerTargetDistance: 700, bottomHeight: 0, centerZ: 200,
            aboidKoopaFlameAngle: fr(0.2 * T), traceMarioAngle: fr(0.1 * T), mSLWavePhaseVelocity: fr(0.03 * T), mSLWaveAmplitudeMin: fr(0.04 * T),
            mSLWaveAmplitudeMaxLaunch: fr(0.12 * T), mSLWaveAmplitudeMax: fr(0.1 * T), mSLSwingPhaseVelocity: fr(0.06 * T), mSLSwingAmplitudeMin: fr(0.04 * T),
            mSLSwingAmplitudeMax: fr(0.18 * T), mSLRoundAngleVelocity: fr(0.12), mSLRoundDistance: 2000, mSLAcceleration: 1, mSLRotationSpeed: 1, mSLSpeedMax: 5,
            mSLKoopaJrSubmarineScale: 2, mSLDamageRadius: 240, mSLDamageHeight: 120, shineKillerProbability0: 0.5, shineKillerProbability1: 0.125,
            mSLKillerInterval: 90, mSLKillerIntervalFast: 30,
        };
    }
    createModelData() { this.createModelDataArray(['LastKoopaJrSubmarine.bmd']); }
    createEnemyInstance(): SpineEnemy | null { return new KoopaJrSubmarine(this.world, 'クッパジュニアサブマリン'); }
}

register('KoopaJrManager', (w, n) => new KoopaJrManager(w, n));
register('KoopaJr', (w, n) => new KoopaJr(w, n));
register('KoopaJrSubmarineManager', (w, n) => new KoopaJrSubmarineManager(w, n));
register('KoopaJrSubmarine', (w, n) => new KoopaJrSubmarine(w, n));
