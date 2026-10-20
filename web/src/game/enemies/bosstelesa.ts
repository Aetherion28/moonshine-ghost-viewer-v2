// King Boo (Enemy/bosstelesa.cpp, ボステレサ): TBossTelesa, its three hit cylinders (TBossTelesaBody,
// TBossTelesaTongue, TBossTelesaKillSmallEnemy), its manager and parameters (/enemy/bosstelesa.prm),
// the slot machine on its belly (TTelesaSlot's own code: the drum base, TSlotDrum, is mapobj/sirena.ts),
// and the bubbles it spits (TBubble / TBubbleManager, バブルマネージャー, /enemy/bubble.prm).
// The stage is delfinoBoss (the casino's basement).
//
// The fight: the top roulette wheel (CasinoRoulette 0) sinks onto the one below it carrying Mario
// (TNerveBossTelesaFallDemo: rouletteFall, then slotFall while the wheels start turning), and King
// Boo hides (HideWait). After 400 ticks he appears (Appear: his slot back at scale 1, its drums at
// random faces), every mTelesaGenerateInterval + 100 x damage ticks spitting Boos (genAttacker: Boos
// thrown from joint 5, or while unk150 is 0 a fan of mSLNumGenBubble bubbles carrying items or
// enemies). Water on his tongue starts the slot (SlotStart: forceStopSlot rigs drum 1 at
// mSLSlotFirstHitCollectRate, and each drum that stops rigs the others at mSLSlotHitCollectRate):
// when the drums stop (checkSlot) he spits what they show (SpitSlotItem / generateSlotItem: 2 =
// fruit and two red peppers, 0 = coins, 1 / 3 / mixed = enemies). Fruit thrown into him while he
// waits (PrepareSlot) hurts him (TNerveBossTelesaDie): a pepper makes him spicy first (setSpicy), and
// only a spicy hit takes a hit point; otherwise he flinches and hides again. At 0 the boss Shine
// appears. The wheels turn at the speed rouletteStart gives them (faster as he is hurt).
//
// The roulettes and the slot are map objects (TRoulette / TTelesaSlot, ported in mapobj/sirena.ts):
// found at loadAfter by actor type in gpMapObjManager and used through RouletteLike / SlotLike below.
// The slot is scene class TelesaSlot (srotRulet): TelesaSlot below, a TSlotDrum whose initMapObj
// runs TSlotDrum's and then installTelesaSlot (TTelesaSlot's values, its three rand()s for
// the drums' faces, and its moveObject / calcRootMatrix / touchWater overrides). For a slot made
// some other way (a plain TSlotDrum), installTelesaSlot still puts them on at King Boo's
// loadAfter. Without the roulettes King Boo does nothing.
//
// Not here: particles (a few told as 'btelesa:*' effects), the bas animation sounds, BCK motion
// blending (unk168 is kept), the TEV colour packets (unk348 / unk34C kept for the viewer), the camera
// (its Y offset following Mario, the demo camera, shakes), rumble, BGM, balloons, the damage fog, the
// slot frame model (TSharedParts srot_waku.bmd), the slot's TMapCollisionMove, the game-over laugh,
// and the screen texture.

import { fr, V3, Mtx, mtx, MsRandF, MsMtxSetRotRPH, MsMtxSetXYZRPH, MsClamp, mtxMultVec } from '../math.js';
import { World, Stream, HitActor, TakeActor, LiveActor, LiveManager, SpineEnemy, EnemyManager, PathNode, LF, HF, HC, MSG, ANM_BCK, ANM_BTP, ANM_BRK,
    nerve, Spine, readParams, SPINE_PARAMS, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { mapObjGlobals, newAndRegisterObj } from '../mapobj/base.js';
import { SlotDrum } from '../mapobj/sirena.js';
import { normalize, sendToMario } from '../mapobj/lib.js';
import { SmallEnemy, SmallEnemyManager, SmallEnemyNerves, rangeRand } from './smallEnemy.js';
import { WalkerEnemy, walkerParams } from './walker.js';
import type { Telesa, TelesaManager } from './telesa.js';

/** TBossTelesaSaveLoadParams */
const BOSS_TELESA_PARAMS = {
    ...SPINE_PARAMS,
    mSLDamageRadius: ['i', 200], mSLDamageHeight: ['i', 100], mSLAttackRadius: ['i', 220], mSLAttackHeight: ['i', 120], mSLGenAttackerTime: ['i', 500],
    mSLGenBubbleTime: ['i', 600], mSLHitAngle: ['f', 20], mSLNumGenBubble: ['i', 5], mSL1stBubbleSp: ['f', 10], mSLHideAreaRadius: ['f', 500],
    mSLSlotItemNum: ['i', 5], mSLSlotFruitNum: ['i', 10], mSLSlotFirstHitCollectRate: ['f', 0.1], mSLSlotHitCollectRate: ['f', 0.1],
    mSLTransYOffset: ['f', 350], mSLStopSlotTime0: ['i', 3000], mSLStopSlotTime1: ['i', 2000], mSLStopSlotTime2: ['i', 1000], mSLSpicyTime: ['i', 2000],
} satisfies PSchema;
type BTParams = { [K in keyof typeof BOSS_TELESA_PARAMS]: number };

/** TBubbleSaveLoadParams (TWalkerEnemyParams + these) */
const BUBBLE_PARAMS = {
    mSLLiveTime: ['i', 200], mSLNumDivision: ['i', 5], mSLMaxScale: ['f', 1.5], mSLAddPosBase: ['f', 50], mSLRateExpand: ['f', 1.001], mSLDeadHeight: ['f', 300],
} satisfies PSchema;

/** TMsRange<s32>::rand */
const rangeRandI = (lo: number, hi: number) => lo + Math.trunc(fr((hi - lo) * MsRandF()));
/** SMS_GetMarioHP (MarioProxy has none: full) */
const marioHP = (w: World): number => { const h = (w.mario as any).mHealth; return typeof h === 'number' ? h : 8; };
/** A joint's world translation (getAnmMtx(j)[i][3]) */
function jointT(a: LiveActor, j: number): V3 {
    const m = a.mactor ? a.mactor.anmMtx(j, a.baseTR, a.scale) : null;
    return m ? new V3(m[12], m[13], m[14]) : a.pos.clone();
}
/** getAnmMtx(j) as a Mtx */
function jointMtx(a: LiveActor, j: number): Mtx {
    const out = mtx();
    const m = a.mactor ? a.mactor.anmMtx(j, a.baseTR, a.scale) : null;
    if (!m) { out.set(a.baseTR); return out; }
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) out[r * 4 + c] = m[c * 4 + r];
    return out;
}

// btelesa_bastable's BCK indices (/scene/btelesa)
const BCK_APPEAR = 0, BCK_BERO_HIT = 1, BCK_DAMAGE = 2, BCK_DOWN = 3, BCK_HIDE = 4, BCK_HIT = 5, BCK_RECOVER = 6, BCK_LICK = 7, BCK_ROLL = 11,
    BCK_SPICY = 12, BCK_SPICY_END = 13, BCK_SPIT = 14, BCK_WAIT = 15, BCK_WET = 16;
// (the names of 3-6, 13 and 14 aren't in the bas table: from how the code uses them)
// TBubble's BCKs
const BUBBLE_BCK_APPEAR = 8, BUBBLE_BCK_DIE = 9, BUBBLE_BCK_LIVE = 10;

/**
 * The roulette wheels (TRoulette / TCasinoRoulette, mapobj/sirena.ts) as King Boo uses them:
 * unk13C its roll speed, unk144 the speed rouletteStart gives it, unk150 its switch (TRouletteSw, a
 * HitActor), setRollSp(sp).
 */
export interface RouletteLike {
    pos: V3; rot: V3; scale: V3; baseTR: Mtx; mactor: LiveActor['mactor'];
    unk13C: number; unk144: number; unk150: HitActor | null;
    setRollSp(sp: number): void;
}
/**
 * The slot (TSlotDrum's fields, mapobj/sirena.ts) plus TTelesaSlot's own (installTelesaSlot adds them
 * when the object doesn't have them): unk138 the drums' speeds, unk13C their angles, unk148 the drum
 * count, unk15C the slow-down, unk160 the stop speed, unk168 the degrees per face.
 */
export interface SlotLike extends LiveActor {
    unk138: number[]; unk13C: number[]; unk140: number; unk144: number; unk148: number; unk14C: number; unk150: number; unk154: number;
    unk158: number; unk15C: number; unk160: number; unk164: number; unk168: number;
    unk198: boolean[]; unk19B: boolean; unk19C: boolean; unk1A0: BossTelesa | null; unk1A4: number; unk1A8: boolean[]; unk1E0: number; unk1E4: number[];
    moveStart(): void; randomReset(): void; forceStopSlot(i: number): void; isRollDrum(): boolean; getSlotResult(): number;
}

// ---------------------------------------------------------------- TTelesaSlot
function tsRandomReset(s: SlotLike) {
    for (let i = 0; i < 3; ++i) { s.unk13C[i] = s.unk168 * rangeRandI(0, 8); s.unk198[i] = false; }
}
/** TTelesaSlot::getResultFromAng */
function tsResultFromAng(a: number) {
    if (a < 44) return 0; if (a < 89) return 1; if (a < 134) return 3; if (a < 179) return 2;
    if (a < 224) return 0; if (a < 269) return 1; if (a < 314) return 3; return 2;
}
function tsGetSlotResult(s: SlotLike) {
    const r = tsResultFromAng(s.unk13C[0]);
    for (let i = 1; i < 3; ++i) if (r !== tsResultFromAng(s.unk13C[i])) return -1;
    return r;
}
/** TTelesaSlot::getForcastResult: where drum i stops if left alone */
function tsForcast(s: SlotLike, i: number) {
    let ang = s.unk13C[i], cur = s.unk138[i];
    // (the game loops until it lands on a face; capped here so a stopped drum can't hang the page)
    for (let n = 0; n < 1000000; n++) {
        if (Math.abs(cur) > s.unk160) {
            ang = fr(ang + cur);
            cur = cur > 0 ? fr(cur - s.unk15C) : fr(cur + s.unk15C);
            if (ang >= 360) ang = fr(ang - 360);
            if (ang <= 0) ang = fr(ang + 360);
        } else {
            ang = fr(ang + cur);
            if (ang >= 360) ang = fr(ang - 360);
            if (ang <= 0) ang = fr(ang + 360);
            if (Math.trunc(Math.abs(ang)) % s.unk168 === 0) break;
        }
    }
    return tsResultFromAng(s.unk168 * Math.trunc(fr(ang / s.unk168)));
}
function tsMoveObject(s: SlotLike) {
    LiveActor.prototype.moveObject.call(s);
    for (let i = 0; i < s.unk148; ++i) {
        if (s.unk1A8[i] && tsForcast(s, i) === s.unk1A4) { s.unk198[i] = false; s.unk1A8[i] = false; }
        const sp = s.unk138[i];
        if (sp === 0) continue;
        if (Math.abs(sp) > s.unk160) {
            s.unk13C[i] = fr(s.unk13C[i] + sp);
            if (!s.unk198[i]) s.unk138[i] = s.unk138[i] > 0 ? fr(s.unk138[i] - s.unk15C) : fr(s.unk138[i] + s.unk15C);
            if (s.unk13C[i] >= 360) s.unk13C[i] = fr(s.unk13C[i] - 360);
            if (s.unk13C[i] <= 0) s.unk13C[i] = fr(s.unk13C[i] + 360);
        } else {
            s.unk13C[i] = fr(s.unk13C[i] + sp);
            if (s.unk13C[i] >= 360) s.unk13C[i] = fr(s.unk13C[i] - 360);
            if (s.unk13C[i] <= 0) s.unk13C[i] = fr(s.unk13C[i] + 360);
            if (s.unk198[i]) continue;
            if (Math.trunc(Math.abs(s.unk13C[i])) % s.unk168 !== 0) continue;
            s.unk13C[i] = s.unk168 * Math.trunc(fr(s.unk13C[i] / s.unk168));
            s.unk138[i] = 0;
            s.world.sound(SE.BS_TELESA_SLT_STOP, s.pos);
            for (let j = 0; j < s.unk148; ++j) {
                if (!s.unk198[j]) continue;
                const rate = s.unk1A0 ? s.unk1A0.P.mSLSlotHitCollectRate : 0.1;
                if (rangeRand(0, 1) <= rate) s.unk1A8[j] = true;
                else s.unk198[j] = false;
            }
            if (s.unk138[0] === 0 && s.unk138[1] === 0 && s.unk138[2] === 0 && s.unk1A0) s.unk1A0.fanfale();
        }
    }
}
/**
 * TTelesaSlot's overrides on a slot drum object: what its constructor and initMapObj set (after
 * TSlotDrum::initMapObj), and its moveObject / calcRootMatrix / touchWater. TelesaSlot calls it
 * from its initMapObj (so initMapObj's three rand()s, one a drum, come at the slot's load, as in
 * the game); an object it was already put on (moveStart set) is left as it is.
 */
export function installTelesaSlot(o: any): SlotLike {
    const s = o as SlotLike;
    if (typeof o.moveStart === 'function') return s;
    s.unk198 = [false, false, false]; s.unk19B = false; s.unk19C = true; s.unk1A0 = null; s.unk1A4 = 2; s.unk1A8 = [false, false, false]; s.unk1E0 = 0;
    s.unk1E4 = [0, 0, 0];
    if (!Array.isArray(s.unk138)) s.unk138 = [0, 0, 0];
    if (!Array.isArray(s.unk13C)) s.unk13C = [90, 180, 270];
    if (!s.unk148) s.unk148 = 3;
    s.onLiveFlag(LF.UNK10);
    s.unk14C = 160; s.unk150 = s.pos.y; s.unk154 = 2; s.unk158 = 2; s.unk15C = 0.01; s.unk160 = 0.5; s.unk164 = 0; s.unk168 = 45;
    s.unk140 = fr(s.damageRadius / 3); s.unk144 = s.damageHeight;
    tsRandomReset(s);
    const baseCalc = typeof o.calcRootMatrix === 'function' ? o.calcRootMatrix.bind(o) : () => { };
    o.moveObject = () => tsMoveObject(s);
    o.calcRootMatrix = () => {
        if (s.unk138[0] !== 0 || s.unk138[1] !== 0 || s.unk138[2] !== 0) {
            if (s.unk1E0) s.world.sound(SE.OBJ_SLOT_SPIN, s.pos);
            s.unk1E0 = 1 - s.unk1E0;
        }
        baseCalc();
    };
    o.touchWater = () => 0;
    o.randomReset = () => tsRandomReset(s);
    o.moveStart = () => {
        s.unk19C = true; s.unk19B = true;
        for (let i = 0; i < 3; ++i) {
            s.unk198[i] = true; s.unk1A8[i] = false;
            let sp = 1;
            if (i === 0) sp = -1;
            if (i === 1) sp = -0.8;
            s.unk138[i] = fr(sp * s.unk158);
        }
    };
    o.forceStopSlot = (idx: number) => {
        if (!s.unk19C) return;
        const b = s.unk1A0!;
        let rate = b.P.mSLSlotFirstHitCollectRate;
        if (marioHP(s.world) === 1) rate = 0.9;
        if (rangeRand(0, 1) <= rate) {
            s.unk1A4 = 2;
            if (marioHP(s.world) <= 3) s.unk1A4 = 0;
            s.unk1A8[idx] = true;
        } else { s.unk1A4 = tsForcast(s, idx); s.unk198[idx] = false; }
        if (s.unk1A4 === b.unk1A8) s.unk1A4 = 3;
        if (s.unk1A4 === 0) {
            if (b.unk370 === 0) s.unk1A4 = 1;
            else if (marioHP(s.world) >= 6) s.unk1A4 = 3;
        }
        s.unk19C = false;
    };
    o.isRollDrum = () => {
        if (s.unk198[0] || s.unk198[1] || s.unk198[2]) return true;
        s.unk19B = false;
        return false;
    };
    o.getSlotResult = () => tsGetSlotResult(s);
    o.getForcastResult = (i: number) => tsForcast(s, i);
    o.getResultFromAng = tsResultFromAng;
    return s;
}

// ---------------------------------------------------------------- the hit cylinders
/** TBossTelesaBody (ボステレサ体コリジョン): hurts Mario, takes fruit */
export class BossTelesaBody extends HitActor {
    unk6C = 0;
    constructor(public unk68: BossTelesa, name = 'ボステレサ体コリジョン') { super(name); }
    receiveMessage(sender: HitActor, msg: number) { return this.unk68.checkMessage(sender, msg); }
    checkHit() {
        this.unk6C = 0;
        for (const a of this.collisions.slice()) {
            if (a.isActorType(AT.MARIO)) sendToMario(this.unk68.world, this, MSG.ATTACK);
            else this.unk68.checkHitObject(a);
        }
    }
}
/** TBossTelesaTongue (ボステレサ舌コリジョン): hurts Mario, eats peppers and fruit from above; water on it starts the slot */
export class BossTelesaTongue extends HitActor {
    constructor(public unk68: BossTelesa, name = 'ボステレサ舌コリジョン') { super(name); }
    checkHit() {
        for (const a of this.collisions.slice()) {
            if (a.isActorType(AT.MARIO)) sendToMario(this.unk68.world, this, MSG.ATTACK);
            else if (a.isActorType(AT.RED_PEPPER)) this.unk68.setSpicy(a as LiveActor);
            else if (this.pos.y + 100 < a.pos.y) this.unk68.checkHitObject(a);
        }
    }
    receiveMessage(_s: HitActor, msg: number) { if (msg === MSG.SPRAYED_BY_WATER) this.unk68.tongueHitWater(); return true; }
}
/** TBossTelesaKillSmallEnemy (ボステレサ雑魚敵死コリジョン): kills enemies under him; Mario right under him makes him hide */
export class BossTelesaKillSmallEnemy extends HitActor {
    unk6C = 0;
    constructor(public unk68: BossTelesa, name = 'ボステレサ雑魚敵死コリジョン') { super(name); }
    checkHit() {
        this.unk6C = 0;
        for (const a of this.collisions.slice()) {
            if (!a.isHitCategory(HC.ENEMY)) continue;
            const e = a as any;
            if (a.actorType === AT.DORO_HAMU_KURI && typeof e.selectCapHolder === 'function') e.selectCapHolder();
            e.kill();
        }
        const m = this.unk68.world.mario.pos;
        const dx = m.x - this.pos.x, dz = m.z - this.pos.z;
        // (MsVECMag2: the squared distance, against 300)
        if (fr(dx * dx + dz * dz) < 300) { this.unk68.forceHide(); this.unk6C = 1; }
    }
}

// ---------------------------------------------------------------- TBossTelesaManager
export class BossTelesaManager extends EnemyManager {
    constructor(w: World, name = 'ボステレサマネージャー') { super(w, name); }
    load(s: Stream) { this.saveParams = readParams('/enemy/bosstelesa.prm', this.world.files, BOSS_TELESA_PARAMS); super.load(s); }
    createModelData() { this.createModelDataArray(['btelesa.bmd']); }
    createEnemyInstance() { return new BossTelesa(this.world); }
    /** clipEnemies: none */
    clipActors() { }
}

// ---------------------------------------------------------------- TBossTelesa
export class BossTelesa extends SpineEnemy {
    static mEnemyGenRate = 0.5; static mItemGenRate = 0.1; static mNormalAlpha = 0x96; static mBaseHoseiPosY = -300; static mRouletteUpRate = 0.03;
    static mTelesaGenerateInterval = 400; static mCameraMoveLimit = 1000; static mCameraMoveSp = 0.02;
    /** 1: Boos from genAttacker, 0: bubbles */
    unk150 = 1;
    /** the BCK before the current one, the current one, and the motion blend ratio */
    unk160 = -1; unk164 = -1; unk168 = 0;
    body: BossTelesaBody | null = null; tongue: BossTelesaTongue | null = null; killSmall: BossTelesaKillSmallEnemy | null = null;
    roulettes: (RouletteLike | null)[] = [null, null, null];
    slot: SlotLike | null = null;
    /** the slot is rolling (slotStart) */
    unk18C = 0;
    /** the roulettes' sound position */
    unk19C = new V3();
    /** the slot's result */
    unk1A8 = 0;
    spitObjs: (LiveActor | null)[] = []; spitObjNum = 0;
    fruits: (any | null)[] = []; redPeppers: (any | null)[] = []; coins: (any | null)[] = [];
    /** the TEV colours: the body's flash (unk348) and the overall alpha (unk34C, a its alpha) */
    unk348 = [0xFF, 0xFF, 0xFF, 0xFF]; unk34C = [0x96, 0x96, 0x96, 0x96];
    isSpicy = 0;
    telesaManager: TelesaManager | null = null;
    marioHP = 0;
    unk35A = 1; unk35B = 1;
    fruitHitCount = 0;
    hoseiPosY = 0;
    /** ticks in PrepareSlot */
    unk368 = 0;
    spicyTimer = 0;
    /** coin results left before coins turn into enemies */
    unk370 = 3;
    fruitHitEffect = -1;
    /** the BGM has started */
    unk384 = 0;
    /** ticks since he went down */
    unk388 = 0;
    get P(): BTParams { return this.getSaveParam(); }
    constructor(w: World, name = 'ボステレサ') { super(w, name); }

    /** TBossTelesa::init (not TSpineEnemy's) */
    init(m: LiveManager | null) {
        this.manager = m;
        if (m) m.manageActor(this);
        this.mactor = this.createMActorByName('btelesa.bmd');
        this.onLiveFlag(LF.DEAD);
        this.onHitFilter(HF.NO_COLLISION);
        const P = this.P;
        if (P) {
            this.bodyRadius = P.mSLBodyRadius; this.wallRadius = P.mSLWallRadius; this.headHeight = P.mSLHeadHeight;
            this.scaledBodyRadius = fr(this.bodyScale * this.bodyRadius);
            this.hitPoints = this.maxHitPoints();
        }
        this.initHitActor(0, 5, HC.PLAYER | HC.ENEMY | HC.BOSS, this.bodyRadius, this.headHeight, this.bodyRadius, this.headHeight);
        this.groundPlane = this.world.illegal;
        this.setGoalPath(new PathNode(this.world.mario));
        this.actorType = AT.BOSS_TELESA;
        this.onHitFilter(HC.PLAYER | HC.MAP_OBJECT | HC.ENEMY);
        this.spine!.initWith(BossTelesaNerves.fallDemo);
        this.onLiveFlag(LF.UNK8);
        this.unk348 = [0xFF, 0xFF, 0xFF, 0xFF];
        const a = BossTelesa.mNormalAlpha; this.unk34C = [a, a, a, a];
        this.reset();
        const mom = mapObjGlobals(this.world).mapObjManager;
        if (mom) for (const o of mom.objs) if (o.isActorType(AT.CASINORULET)) this.pos.set(o.pos);
        const w = this.world;
        this.body = new BossTelesaBody(this);
        w.addToGroup('敵グループ', this.body);
        this.body.initHitActor(AT.BOSS_TELESA, 5, HC.PLAYER | HC.MAP_OBJECT | HC.ENEMY | HC.WATER, 350, 550, 300, 500);
        this.body.offHitFilter(HF.NO_COLLISION);
        this.tongue = new BossTelesaTongue(this);
        w.addToGroup('敵グループ', this.tongue);
        this.tongue.initHitActor(AT.BOSS_TELESA, 5, HC.PLAYER | HC.MAP_OBJECT, 180, 350, 180, 350);
        this.tongue.offHitFilter(HF.NO_COLLISION);
        this.killSmall = new BossTelesaKillSmallEnemy(this);
        w.addToGroup('敵グループ', this.killSmall);
        this.killSmall.initHitActor(AT.TELESA, 5, HC.ENEMY, 400, 300, 400, 300);
        this.killSmall.offHitFilter(HF.NO_COLLISION);
        this.marioHP = marioHP(w);
    }
    loadAfter() {
        const w = this.world, mom = mapObjGlobals(w).mapObjManager;
        if (mom) {
            let found = 0;
            for (const o of mom.objs) if (o.isActorType(AT.CASINORULET) && found < 3) this.roulettes[found++] = o as unknown as RouletteLike;
            for (const o of mom.objs) if (o.isActorType(AT.SROT_RULET)) { this.slot = installTelesaSlot(o); this.slot.unk1A0 = this; }
        }
        let fi = 0;
        const fruit = (n: string, k: number) => { for (let i = 0; i < k; i++) this.fruits[fi++] = newAndRegisterObj(w, n); };
        fruit('FruitCoconut', 6); fruit('FruitPapaya', 6); fruit('FruitPine', 2); fruit('FruitDurian', 6);
        for (const f of this.fruits) if (f) { f.onMapObjFlag(0x4000000); f.makeObjDead(); }
        for (let i = 0; i < 10; i++) { const o = w.search('唐辛子 ' + i) as any; this.redPeppers[i] = o; if (o && o.makeObjDead) o.makeObjDead(); }
        for (let i = 0; i < 10; i++) { const o = w.search('コイン ' + i) as any; this.coins[i] = o; if (o && o.makeObjDead) o.makeObjDead(); }
        if (this.slot) this.slot.unk1E4 = [0, 0, 0];
        this.telesaManager = w.search('テレサマネージャー') as TelesaManager | null;
        for (let i = 0; i < 5; i++) newAndRegisterObj(w, 'bottle_large');
        // (the particles, and the slot frame srot_waku.bmd as TSharedParts: drawing only)
        for (const n of ['ゲッソー 0', 'ゲッソー 1']) { const g = w.search(n) as LiveActor | null; if (g && g.onLiveFlag) g.onLiveFlag(LF.DEAD); }
    }
    reset() {
        super.reset();
        this.onHitFilter(HF.NO_COLLISION);
        this.onLiveFlag(LF.UNK8); this.onLiveFlag(LF.UNK10); this.onLiveFlag(LF.HIDDEN);
        this.unk18C = 0;
        const P = this.P;
        this.setHitParams(P.mSLAttackRadius, P.mSLAttackHeight, P.mSLDamageRadius, P.mSLDamageHeight);
        this.world.events.push({ t: this.world.tickCount, kind: 'demoCamera', data: { name: 'btelesa_roll_camera' } });
    }
    get ready() { return !!(this.roulettes[0] && this.roulettes[1] && this.roulettes[2] && this.slot); }
    moveObject() {
        if (this.checkLiveFlag(LF.DEAD) || !this.ready) return;
        const R = this.roulettes as RouletteLike[], w = this.world, a = this.mactor!;
        // (the camera's Y offset following Mario, and the game-over laugh: not here)
        const s = this.spine!;
        if (s.current === BossTelesaNerves.fallDemo && R[0].pos.y > R[1].pos.y + 5) { this.slot!.pos.set(R[0].pos); this.slot!.pos.y = fr(this.slot!.pos.y + 300); }
        if (s.current !== BossTelesaNerves.prepareSlot) { a.setFrameRate(0, ANM_BTP); const c = a.getFrameCtrl(ANM_BTP); if (c) c.frame = 0; }
        if (this.isInDamage()) {
            const target = MsClamp((BossTelesa.mNormalAlpha + (this.maxHitPoints() - this.hitPoints) * 30) & 0xFF, 0, 0xFE);
            if ((a.checkCurBckFromIndex(BCK_LICK) && a.getFrameCtrl(ANM_BCK)!.frame > 50) || a.checkCurBckFromIndex(BCK_RECOVER)) {
                if (this.unk34C[3] > target) --this.unk34C[3];
            } else if (this.unk34C[3] < 0xFF) ++this.unk34C[3];
        }
        // (cameraPos: the camera's position; the viewer's sim has none: Mario's, so the roulettes' sound sits on the wheel)
        this.unk19C.set(R[0].pos);
        let moving = 0;
        for (const r of R) if (r.unk13C !== 0) ++moving;
        if (moving === 1) w.sound(SE.BS_TELESA_RLT_MOVE1, this.unk19C);
        else if (moving === 2) w.sound(SE.BS_TELESA_RLT_MOVE2, this.unk19C);
        else if (moving === 3) w.sound(SE.BS_TELESA_RLT_MOVE3, this.unk19C);
        this.posDelta.zero(); this.rotDelta.zero();
        this.control();
        for (const c of this.collisions.slice()) if (c.isActorType(AT.MARIO)) sendToMario(w, this, MSG.ATTACK);
        this.bind();
        this.pos.add(this.posDelta).fround();
        this.rot.add(this.rotDelta).fround();
        this.pos.y = fr(this.groundHeight + 300);
        this.unk168 = MsClamp(fr(this.unk168 - 0.05), 0, 1);
        if (this.checkLiveFlag(LF.CLIPPED_OUT)) {
            this.body!.pos.set(this.pos); this.tongue!.pos.set(this.pos); this.killSmall!.pos.set(this.pos);
        } else {
            const all = a.anmMtxAll(this.baseTR, this.scale);
            const n1 = all && all[1], n7 = all && all[7];
            if (n1) {
                this.body!.pos.set(n1[12], fr(n1[13] - 200), n1[14]);
                this.killSmall!.pos.set(n1[12], fr(this.pos.y - 350), n1[14]);
            }
            if (n7) this.tongue!.pos.set(n7[12], fr(n7[13] - 350), n7[14]);
        }
        this.body!.checkHit();
        this.tongue!.checkHit();
        this.killSmall!.checkHit();
    }
    kill() { if (this.spine!.current !== BossTelesaNerves.die) this.spine!.pushNerve(BossTelesaNerves.die); }
    getTakingMtx(): Mtx | null {
        const r = this.roulettes[0];
        if (!r) return null;
        const m = jointMtx(r as unknown as LiveActor, 1);
        m[7] = fr(r.pos.y - 120);
        return m;
    }
    calcRootMatrix() {
        let off = this.hoseiPosY;
        if (off > 0) off = 0; else if (off < BossTelesa.mBaseHoseiPosY) off = BossTelesa.mBaseHoseiPosY;
        MsMtxSetXYZRPH(this.baseTR, this.pos.x, fr(fr(this.pos.y + this.P.mSLTransYOffset) + off), this.pos.z, this.rot.x, this.rot.y, this.rot.z);
        const a = this.mactor!;
        if (this.slot) {
            this.slot.rot.set(this.rot);
            let dy = -700, j = 0;
            if (a.checkCurBckFromIndex(BCK_HIDE) || a.checkCurBckFromIndex(BCK_APPEAR) || a.checkCurBckFromIndex(BCK_DAMAGE) || a.checkCurBckFromIndex(BCK_HIT)) {
                j = 1;
                if (!a.checkCurBckFromIndex(BCK_APPEAR)) dy = -2400;
            }
            const t = jointT(this, j);
            this.slot.pos.set(t.x, fr(fr(this.hoseiPosY + t.y) + dy), t.z);
        }
        // (the light effect matrices and the particles on joints 1, 5, 9 and 10: drawing only)
        if (a.checkCurBckFromIndex(BCK_SPICY)) this.world.sound(SE.BS_TELESA_FIRE, this.pos);
        if (a.checkCurBckFromIndex(BCK_SPIT) && a.checkBckPass(40)) {
            if (this.spine!.current === BossTelesaNerves.spitSlotItem) this.generateSlotItem();
            else this.genAttacker();
        }
    }
    perform(cue: number) {
        // (the damage fog of a spicy death: drawing only)
        this.offLiveFlag(LF.CLIPPED_OUT);
        super.perform(cue);
        // TODO: the decomp performs the slot here too (mSlot->testPerform) although the map object
        // manager performs it as well; kept as the decomp has it.
        if (this.slot) this.slot.testPerform(cue);
    }
    receiveMessage(_s: HitActor, _m: number) { return false; }
    checkMessage(a: HitActor, msg: number) {
        const s = this.spine!;
        if (msg === MSG.TRAMPLE && !a.isActorType(AT.MARIO) && s.current === BossTelesaNerves.prepareSlot) s.pushNerve(BossTelesaNerves.spit);
        if (msg === MSG.SPRAYED_BY_WATER && s.current === BossTelesaNerves.prepareSlot) s.pushNerve(BossTelesaNerves.freeze);
        return true;
    }
    checkHitObject(a: HitActor) {
        this.fruitHitEffect = -1;
        if (a.getHitCategory() !== (HC.MAP_OBJECT | 0)) return;
        if (this.spine!.current !== BossTelesaNerves.prepareSlot) return;
        const t = a.actorType;
        if (t === AT.FRUIT_COCONUT) { this.unk348[0] = 0xE6; this.unk348[1] = 0x64; this.unk348[2] = 0xB4; this.fruitHitEffect = 1; this.kill(); }
        else if (t === AT.FRUIT_PAPAYA || t === AT.FRUIT_PINE) { this.unk348[0] = 0xE6; this.unk348[1] = 0xB4; this.unk348[2] = 0; this.fruitHitEffect = 3; this.kill(); }
        else if (t === AT.FRUIT_DURIAN) { this.unk348[0] = 0x96; this.unk348[1] = 0x32; this.unk348[2] = 0xE6; this.fruitHitEffect = 2; this.kill(); }
        else if (t !== AT.RED_PEPPER) return;
        if (!this.isSpicy && t !== AT.RED_PEPPER) {
            if (this.unk35A) { this.unk35A = 0; this.world.events.push({ t: this.world.tickCount, kind: 'balloon', data: { id: 0xE000F } }); }
            this.fruitHitCount++;
            if (this.fruitHitCount > 2) this.world.events.push({ t: this.world.tickCount, kind: 'balloon', data: { id: 0xE0010 } });
        } else this.fruitHitCount = 0;
        this.world.effect('btelesa:fhit', a.pos);
        if (!this.isSpicy) this.world.sound(SE.BS_TELESA_FRUIT_HIT, this.pos);
        (a as any).makeObjDead();
    }
    setSpicy(a: LiveActor) {
        if (this.spine!.current === BossTelesaNerves.spitSlotItem) return;
        if (this.mactor!.checkCurBckFromIndex(BCK_BERO_HIT)) return;
        this.isSpicy = 1; this.spicyTimer = 0;
        this.setBckAnm(BCK_BERO_HIT);
        if (this.unk35B) { this.unk35B = 0; this.world.events.push({ t: this.world.tickCount, kind: 'balloon', data: { id: 0xE0011 } }); }
        a.kill();
    }
    private vanish(o: any, detachIfFree: boolean) {
        if (!o || o.checkLiveFlag(LF.DEAD)) return;
        if (detachIfFree && o.holder === null) sendToMario(this.world, o, MSG.DETACH);
        o.makeObjDead();
        this.world.effect('btelesa:tlsChange', o.pos);
        o.pos.set(0, 0, 0);
    }
    damageRecover() {
        for (let i = 0; i < 20; ++i) this.vanish(this.fruits[i], true);
        for (let i = 0; i < 10; ++i) { this.vanish(this.redPeppers[i], true); this.vanish(this.coins[i], false); }
        this.world.sound(this.isSpicy ? SE.BS_TELESA_ESCAPE : SE.BS_TELESA_DISAPPEAR, this.pos);
        this.spine!.pushAfterCurrent(BossTelesaNerves.hide);
        this.unk368 = 0;
    }
    tongueHitWater() { if (this.spine!.current === BossTelesaNerves.appear) this.spine!.pushNerve(BossTelesaNerves.slotStart); }
    rouletteFall() {
        const R = this.roulettes as RouletteLike[], w = this.world;
        if (R[0].pos.y > R[1].pos.y) {
            R[0].pos.y = fr(R[0].pos.y - 2);
            if (R[0].mactor) R[0].mactor.setBck('rulet00');
            if (R[0].pos.y > R[1].pos.y + 3) { if (sendToMario(w, this, MSG.TAKE)) this.held = w.mario as unknown as TakeActor; }
            else if (sendToMario(w, this, MSG.DETACH)) { w.sound(SE.BS_TELESA_RLT_SET, this.pos); this.held = null; }
            w.sound(SE.BS_TELESA_V_LAUGH1B, this.pos);
            w.sound(SE.BS_TELESA_RLT_DOWN, this.pos);
            // (gpMarioOriginal->mGamePad->onNeutralMarioKey: no pad here)
            return false;
        }
        R[0].pos.y = R[1].pos.y;
        return true;
    }
    slotFall() {
        const R = this.roulettes as RouletteLike[], s = this.slot!;
        if (s.pos.y > R[0].pos.y - 800) { s.pos.y = fr(s.pos.y - 5); return false; }
        s.pos.y = fr(s.pos.y - 1);
        if (s.pos.y < R[0].pos.y - 900) {
            let rolling = 0;
            for (const r of R) if (r.unk13C !== 0) rolling++;
            if (rolling !== 3) this.rouletteStart();
        }
        if (s.pos.y < R[0].pos.y - 1100) return true;
        if (R[0].unk150) R[0].unk150.setHitParams(280, 100, 280, 100);
        if (R[1].unk150) R[1].unk150.setHitParams(280, 100, 280, 100);
        return false;
    }
    flashItem(result: number) {
        const phase = result % 16;
        const flash = (o: any) => { if (phase < 8) o.onLiveFlag(LF.HIDDEN); else o.offLiveFlag(LF.HIDDEN); };
        for (let i = 0; i < 20; i++) { const f = this.fruits[i]; if (f && !f.checkLiveFlag(LF.DEAD) && f.holder === null) flash(f); }
        for (let i = 0; i < 10; ++i) {
            const p = this.redPeppers[i], c = this.coins[i];
            if (p && !p.checkLiveFlag(LF.DEAD) && p.holder === null) flash(p);
            if (c && !c.checkLiveFlag(LF.DEAD)) flash(c);
        }
    }
    onAllCollision() { this.offHitFilter(HF.NO_COLLISION); this.body!.offHitFilter(HF.NO_COLLISION); this.tongue!.offHitFilter(HF.NO_COLLISION); }
    offAllCollision() { this.onHitFilter(HF.NO_COLLISION); this.body!.onHitFilter(HF.NO_COLLISION); this.tongue!.onHitFilter(HF.NO_COLLISION); }
    genAttacker() {
        const w = this.world;
        if (this.unk150) {
            const t = w.conductor.makeOneEnemyAppear(this.pos, 'テレサマネージャー', 1) as Telesa | null;
            if (t) t.initAttacker(this);
            return;
        }
        const count = this.P.mSLNumGenBubble;
        const root = jointT(this, 5);
        const step = fr(180 / count), off = fr(fr(step * count) * 0.5);
        for (let i = 0; i < count; ++i) {
            const b = w.conductor.makeOneEnemyAppear(this.pos, 'バブルマネージャー', 1) as Bubble | null;
            if (!b) return;
            const rot = mtx();
            MsMtxSetRotRPH(rot, this.rot.x, fr(fr(this.rot.y - off) + fr(step * i)), this.rot.z);
            const v = normalize(mtxMultVec(rot, new V3(0, 0, -50)).fround());
            v.y = 2;
            const sp = this.P.mSL1stBubbleSp;
            v.x = fr(v.x * sp); v.z = fr(v.z * sp);
            b.pos.set(root.x, fr(root.y - 50), root.z);
            b.vel.set(v);
            b.pos.y = fr(b.pos.y + 10);
            b.onLiveFlag(LF.AIRBORNE);
            if (rangeRand(0, 1) < BossTelesa.mItemGenRate) b.appendItem();
            else if (rangeRand(0, 1) < BossTelesa.mEnemyGenRate) b.appendEnemy();
        }
    }
    setBckAnm(i: number) {
        const a = this.mactor!;
        this.unk164 = a.getCurAnmIdx(ANM_BCK);
        this.unk160 = i;
        this.unk168 = 1;
        a.setBckFromIndex(i);
    }
    isInDamage() { return this.spine!.current === BossTelesaNerves.die; }
    rouletteStart() {
        const R = this.roulettes as RouletteLike[], s = this.slot!;
        const dir = rangeRand(-1, 1);
        const hpSpeed = fr((this.maxHitPoints() - this.hitPoints) * BossTelesa.mRouletteUpRate);
        for (let i = 0; i < 3; ++i) {
            let d: number;
            if (dir > 0) { d = -1; if (i === 0 || i === 2) d = 1; }
            else { d = 1; if (i === 0 || i === 2) d = -1; }
            R[i].unk144 = fr(d * fr(hpSpeed + rangeRand(0.05, 0.1)));
            s.unk1E4[i] = fr(d * fr(hpSpeed + rangeRand(0.05, 0.1)));
        }
        this.rollRouletteCircle();
        // (rumble and the camera shake: not here)
    }
    slotStart() {
        this.unk18C = 1;
        this.slot!.moveStart();
        if (this.telesaManager) this.telesaManager.telesaForceKill();
    }
    slotStop() {
        const R = this.roulettes as RouletteLike[], s = this.slot!;
        for (let i = 0; i < 3; i++) { R[i].unk144 = 0; s.unk1E4[i] = 0; }
        this.rollRouletteCircle();
    }
    generateSlotItem() {
        const names = ['バブルマネージャー', 'ハムクリマネージャー', 'ヤキグリマネージャー', 'ボム兵マネージャー', 'ポイハナマネージャー', '電気ノコノコマネージャー',
            'ポポマネージャー', 'ゲッソーマネージャー', 'とびプクマネージャー'];
        const w = this.world, P = this.P;
        this.unk368 = 0; this.spitObjNum = 0;
        this.unk1A8 = this.slot!.getSlotResult();
        const itemNum = P.mSLSlotItemNum;
        const root = jointMtx(this, 5);
        const step = fr(120 / itemNum), off = fr(fr(step * itemNum) * 0.5);
        if (this.unk1A8 === 2) {
            let n = P.mSLSlotFruitNum;
            if (n > 20) n = 20;
            let ai = rangeRandI(0, n);
            for (let i = 0; i < n; ++i) {
                const f = this.fruits[i];
                if (f && f.holder) continue;
                const rot = mtx();
                const fstep = fr(160 / n);
                MsMtxSetRotRPH(rot, this.rot.x, fr(fr(this.rot.y - off) + fr(fstep * ai)), this.rot.z);
                if (n > 0) { ai += i; while (ai >= n) ai -= n; while (ai < 0) ai += n; } else ai = 0;
                const dir = mtxMultVec(rot, new V3(0, 0, 200)).fround();
                const nd = normalize(dir.clone());
                if (i === 0 || i === 4) {
                    const p = this.redPeppers[i];
                    if (p) {
                        p.makeObjAppeared();
                        p.offLiveFlag(LF.HIDDEN);
                        const vx = fr(nd.x * rangeRand(6, 10)); p.vel.set(vx, -2, fr(nd.z * rangeRand(6, 10)));
                        p.offLiveFlag(LF.UNK10);
                        if (i === 0) {
                            const vx2 = fr(fr(nd.x * rangeRand(6, 10)) * 2); p.vel.set(vx2, -2, fr(fr(nd.z * rangeRand(6, 10)) * 2));
                            p.offLiveFlag(LF.UNK10);
                        }
                        p.rot.set(0, 90, 0);
                    }
                    this.spitObjs[this.spitObjNum] = p;
                } else {
                    if (f) {
                        f.makeObjAppeared();
                        f.offLiveFlag(LF.HIDDEN);
                        const vx = fr(nd.x * rangeRand(6, 10)); f.vel.set(vx, -2, fr(nd.z * rangeRand(6, 10)));
                        f.offLiveFlag(LF.UNK10);
                    }
                    this.spitObjs[this.spitObjNum] = f;
                }
                // (the decomp indexes these two with i, not mSpitObjNum)
                const si = this.spitObjs[i];
                if (si) { si.onHitFilter(HF.NO_COLLISION); si.scale.set(1.5, 1.5, 1.5); }
                const so = this.spitObjs[this.spitObjNum];
                if (so) so.pos.set(fr(root[3] + dir.x), fr(root[7] - 50), fr(root[11] + dir.z));
                this.spitObjNum++;
            }
        } else if (this.unk1A8 === 0) {
            let n = P.mSLSlotFruitNum;
            if (n > 10) n = 10;
            const istep = fr(120 / n), ioff = fr(fr(istep * n) * 0.5);
            if (this.unk370) this.unk370--; else this.unk370 = 0;
            const im = mapObjGlobals(w).itemManager;
            for (let i = 0; i < n; ++i) {
                if (i >= 10) return;
                const rot = mtx();
                MsMtxSetRotRPH(rot, this.rot.x, fr(fr(this.rot.y - ioff) + fr(istep * i)), this.rot.z);
                const dir = normalize(mtxMultVec(rot, new V3(0, 0, 250)).fround());
                dir.y = 10;
                const sp = P.mSL1stBubbleSp;
                const vx = fr(fr(dir.x * sp) * rangeRand(0.8, 3.5));
                const vz = fr(fr(dir.z * sp) * rangeRand(0.8, 3.5));
                const item = im ? im.makeObjAppeared(AT.COIN) : null;
                if (item) {
                    item.pos.set(root[3], fr(root[7] - 250), root[11]);
                    item.vel.set(vx, dir.y, vz);
                    item.offLiveFlag(LF.UNK10);
                    item.scale.set(0, 0, 0);
                    if (item.killByTimer) item.killByTimer(0x3C0);
                }
                this.spitObjs[this.spitObjNum] = this.coins[i];
                if (this.coins[i]) this.coins[i].offLiveFlag(LF.HIDDEN);
                this.spitObjNum++;
            }
        } else {
            let count = itemNum, kind = 0;
            if (this.unk1A8 === -1) count *= 2;
            else if (this.unk1A8 === 1) kind = this.hitPoints > 2 ? 1 : 2;
            const maxKind = this.hitPoints === 1 ? 8 : 7;
            let rk = rangeRandI(1, maxKind);
            for (let i = 0; i < count; ++i) {
                if (this.unk1A8 === 3) {
                    if (i % 2 === 0) rk++;
                    if (rk > maxKind) rk = 1;
                    kind = rk;
                }
                const e = w.conductor.makeOneEnemyAppear(this.pos, names[kind], 2) as SmallEnemy | null;
                if (!e) continue;
                if (kind !== 0) this.spitObjs[this.spitObjNum++] = e;
                const rot = mtx();
                MsMtxSetRotRPH(rot, this.rot.x, fr(fr(this.rot.y - off) + fr(step * i)), this.rot.z);
                const dir = normalize(mtxMultVec(rot, new V3(0, 0, 200)).fround());
                dir.y = 2;
                const sp = P.mSL1stBubbleSp;
                const vx = fr(fr(dir.x * sp) * rangeRand(0.5, 1));
                const vy = fr(dir.y * fr(2 + rangeRand(0.5, 1)));
                const vz = fr(fr(dir.z * sp) * rangeRand(0.5, 1));
                e.pos.set(root[3], fr(root[7] - 250), root[11]);
                e.vel.set(vx, vy, vz);
                e.pos.y = fr(e.pos.y + 10);
                e.onLiveFlag(LF.AIRBORNE);
                e.baseTR.set(root);
                const ea = e as any;
                if (typeof ea.initAttacker === 'function') ea.initAttacker(this); else e.unk184 = 1;   // (TSmallEnemy::initAttacker)
            }
        }
    }
    fruitCollisionOn() {
        for (let i = 0; i < this.spitObjNum; ++i) {
            const o = this.spitObjs[i];
            if (o && !o.checkLiveFlag(LF.DEAD) && !o.isActorType(AT.COIN) && !o.isActorType(AT.BOTTLE_LARGE)) o.offHitFilter(HF.NO_COLLISION);
        }
    }
    checkSlot() {
        if (!this.slot!.isRollDrum() && this.unk18C) {
            this.unk18C = 0;
            this.spine!.pushAfterCurrent(BossTelesaNerves.spitSlotItem);
            return true;
        }
        return false;
    }
    checkAllItemDead() {
        if (this.unk1A8 === -1) return true;
        for (let i = 0; i < this.spitObjNum; ++i) { const o = this.spitObjs[i]; if (o && !o.checkLiveFlag(LF.DEAD)) return false; }
        return true;
    }
    forceAllItemKill() {
        for (let i = 0; i < this.spitObjNum; ++i) {
            const o = this.spitObjs[i];
            if (!o) continue;
            if (o.holder) { sendToMario(this.world, o, MSG.DETACH); o.holder = null; }
            o.pos.set(0, 0, 0);
            o.onHitFilter(HF.NO_COLLISION);
            if (!o.checkLiveFlag(LF.DEAD)) { o.kill(); this.world.effect('btelesa:tlsChange', o.pos); }
        }
    }
    rollRouletteCircle() { for (let i = 0; i < 3; ++i) this.roulettes[i]!.setRollSp(this.slot!.unk1E4[i]); }
    forceHide() {
        if (this.spine!.current === BossTelesaNerves.die) return;
        const a = this.mactor!;
        if (a.checkCurBckFromIndex(BCK_HIDE) || a.checkCurBckFromIndex(BCK_APPEAR)) return;
        this.forceAllItemKill();
        this.unk368 = 0;
        this.world.sound(this.isSpicy ? SE.BS_TELESA_ESCAPE : SE.BS_TELESA_DISAPPEAR, this.pos);
        this.spine!.reset();
        this.spine!.setNext(BossTelesaNerves.hide);
    }
    fanfale() {
        const r = this.slot!.getSlotResult();
        if (r === 2 || r === 0) {
            this.world.effect('btelesa:fubuki', this.pos);
            this.world.sound(r === 2 ? SE.BS_TELESA_FANFALE_1 : SE.BS_TELESA_FANFALE_2, this.pos);
        } else this.world.sound(0x294D, this.pos);   // MSD_SE_BS_TELESA_FANFALE_3 (not in soundids.ts)
    }
    /** the alpha for the damage taken: (u8)(mNormalAlpha + (max - hp) * 30), at most 0xFE */
    damageAlpha() { return MsClamp((BossTelesa.mNormalAlpha + (this.maxHitPoints() - this.hitPoints) * 30) & 0xFF, 0, 0xFE); }
}

type S = Spine<BossTelesa>;
export const BossTelesaNerves: Record<string, any> = {};
BossTelesaNerves.die = nerve<BossTelesa>('TNerveBossTelesaDie', (spine: S) => {
    const b = spine.body, a = b.mactor!, w = b.world;
    if (spine.time === 0) {
        b.unk388 = 0;
        if (b.isSpicy && b.hitPoints !== 0) --b.hitPoints;
        b.offAllCollision();
        if (b.hitPoints !== 0) {
            if (b.isSpicy) { a.setFromIndex(ANM_BRK, 1); b.setBckAnm(BCK_DAMAGE); }
            else { b.setBckAnm(BCK_HIT); a.setFromIndex(ANM_BRK, 0); }
        } else {
            b.setBckAnm(BCK_DOWN);
            a.setFromIndex(ANM_BRK, 1);
            if (b.slot) b.slot.scale.set(0, 0, 0);
            w.sound(SE.BS_TELESA_DOWN, b.pos);
        }
    }
    if (b.hitPoints === 0) {
        if (b.checkCurAnmEnd(ANM_BCK)) {
            if (b.unk388 === 0) {
                w.effect('btelesa:down', jointT(b, 1));
                b.forceAllItemKill();
                b.slotStop();
            }
            if (b.unk388 > 240) {
                b.unk388 = 0;
                const im = mapObjGlobals(w).itemManager;
                if (im) im.makeShineAppearWithDemo('シャイン（ボス用）', 'ボスシャインカメラ', b.pos.x, b.pos.y, b.pos.z);
                b.onLiveFlag(LF.DEAD); b.onLiveFlag(LF.UNK8); b.offLiveFlag(LF.UNK10000);
                b.holder = null;
                b.offAllCollision();
                spine.reset();
                return true;
            }
            b.unk388++;
        }
        return false;
    }
    if (b.checkCurAnmEnd(ANM_BCK)) {
        if (a.checkCurBckFromIndex(BCK_HIT)) { a.setFromIndex(ANM_BRK, 2); b.setBckAnm(BCK_LICK); }
        else if (a.checkCurBckFromIndex(BCK_LICK)) b.setBckAnm(BCK_RECOVER);
        else {
            if (a.checkCurBckFromIndex(BCK_RECOVER)) {
                b.onAllCollision();
                b.setBckAnm(BCK_WAIT);
                a.setFromIndex(ANM_BTP, 2);
                spine.pushAfterCurrent(BossTelesaNerves.prepareSlot);
            } else b.damageRecover();
            return true;
        }
    }
    return false;
});
BossTelesaNerves.spit = nerve<BossTelesa>('TNerveBossTelesaSpit', (spine: S) => {
    const b = spine.body, a = b.mactor!;
    if (spine.time === 0 || !a.checkCurBckFromIndex(BCK_SPIT)) b.setBckAnm(BCK_SPIT);
    else if (a.checkBckPass(40)) b.genAttacker();
    return b.checkCurAnmEnd(ANM_BCK);
});
BossTelesaNerves.hide = nerve<BossTelesa>('TNerveBossTelesaHide', (spine: S) => {
    const b = spine.body, a = b.mactor!;
    if (!a.checkCurBckFromIndex(BCK_HIDE)) { b.setBckAnm(BCK_HIDE); a.setFromIndex(ANM_BTP, 2); }
    if (b.checkCurAnmEnd(ANM_BCK)) {
        b.offAllCollision();
        b.rouletteStart();
        spine.pushAfterCurrent(BossTelesaNerves.hideWait);
        return true;
    }
    return false;
});
BossTelesaNerves.hideWait = nerve<BossTelesa>('TNerveBossTelesaHideWait', (spine: S) => {
    const b = spine.body, a = b.mactor!;
    if (spine.time === 0) {
        b.onLiveFlag(LF.HIDDEN);
        b.isSpicy = 0;
        b.unk34C[3] = b.damageAlpha();
        if (b.slot) b.slot.scale.set(0, 0, 0);
        a.setFromIndex(ANM_BRK, 2);
        const c = a.getFrameCtrl(ANM_BRK);
        if (c) c.frame = (Math.trunc(c.end) << 16) >> 16;
    } else if (spine.time > 400 && b.killSmall!.unk6C === 0) {
        spine.pushAfterCurrent(BossTelesaNerves.appear);
        b.offLiveFlag(LF.HIDDEN);
        return true;
    }
    return false;
});
BossTelesaNerves.appear = nerve<BossTelesa>('TNerveBossTelesaAppear', (spine: S) => {
    const b = spine.body, a = b.mactor!, w = b.world;
    if (spine.time === 0) {
        if (!a.checkCurBckFromIndex(BCK_APPEAR)) {
            b.setBckAnm(BCK_APPEAR);
            if (!b.unk384) b.unk384 = 1;   // (MSBgm::startBGM)
            if (b.slot) { b.slot.scale.set(1, 1, 1); b.slot.randomReset(); }
            b.onAllCollision();
        }
    } else if (b.checkCurAnmEnd(ANM_BCK) && !a.checkCurBckFromIndex(BCK_WAIT)) { b.setBckAnm(BCK_WAIT); a.setFromIndex(ANM_BTP, 2); }
    if (a.checkCurBckFromIndex(BCK_APPEAR) && a.checkBckPass(40)) w.sound(SE.BS_TELESA_SLT_LAND, b.pos);
    if (spine.time > 800) {
        const interval = BossTelesa.mTelesaGenerateInterval + (b.maxHitPoints() - b.hitPoints) * 100;
        if (spine.time % interval === 1) b.setBckAnm(BCK_SPIT);
    }
    b.hoseiPosY = fr(b.hoseiPosY * 0.9);
    return false;
});
BossTelesaNerves.slotStart = nerve<BossTelesa>('TNerveBossTelesaSlotStart', (spine: S) => {
    const b = spine.body, a = b.mactor!;
    if (spine.time === 0) b.setBckAnm(BCK_ROLL);
    if (a.checkCurBckFromIndex(BCK_ROLL)) {
        if (a.checkBckPass(53)) b.slotStart();
        if (b.checkCurAnmEnd(ANM_BCK)) { b.setBckAnm(BCK_WAIT); a.setFromIndex(ANM_BTP, 2); b.slot!.forceStopSlot(1); }
    }
    if (b.checkSlot()) return true;
    b.hoseiPosY = fr(b.hoseiPosY * 0.99);
    return false;
});
BossTelesaNerves.spitSlotItem = nerve<BossTelesa>('TNerveBossTelesaSpitSlotItem', (spine: S) => {
    const b = spine.body, a = b.mactor!;
    if (!a.checkCurBckFromIndex(BCK_SPIT) && b.hoseiPosY < BossTelesa.mBaseHoseiPosY - 300) b.setBckAnm(BCK_SPIT);
    else if (b.checkCurAnmEnd(ANM_BCK) && spine.time > 600) {
        spine.pushAfterCurrent(BossTelesaNerves.prepareSlot);
        b.unk368 = 0;
        b.fruitCollisionOn();
        return true;
    } else if (spine.time > 200) b.hoseiPosY = fr(b.hoseiPosY - 2);
    return false;
});
BossTelesaNerves.prepareSlot = nerve<BossTelesa>('TNerveBossTelesaPrepareSlot', (spine: S) => {
    const b = spine.body, a = b.mactor!, P = b.P;
    if (spine.time === 0) { b.setBckAnm(BCK_WAIT); a.setFromIndex(ANM_BTP, 2); }
    if (b.isSpicy) {
        b.spicyTimer++;
        if (b.checkCurAnmEnd(ANM_BCK)) {
            if (a.checkCurBckFromIndex(BCK_BERO_HIT)) { b.setBckAnm(BCK_SPICY); a.setFromIndex(ANM_BTP, 1); }
            else if (a.checkCurBckFromIndex(BCK_SPICY)) { if (b.spicyTimer > P.mSLSpicyTime) b.setBckAnm(BCK_SPICY_END); }
            else {
                b.spicyTimer = 0; b.isSpicy = 0;
                let alpha = (BossTelesa.mNormalAlpha + (b.maxHitPoints() - b.hitPoints) * 30) & 0xFF;
                if (alpha > 0xFE) alpha = 0xFE;
                b.unk34C[3] = alpha;
                b.setBckAnm(BCK_WAIT); a.setFromIndex(ANM_BTP, 2);
            }
        }
    }
    b.unk368++;
    let wait = P.mSLStopSlotTime0;
    if (b.hitPoints === 2) wait = P.mSLStopSlotTime1;
    if (b.hitPoints === 1) wait = P.mSLStopSlotTime2;
    if (b.slot!.getSlotResult() === 0) wait = Math.trunc(fr(wait * 0.5));
    if (b.unk368 > wait - 120) b.flashItem(wait - b.unk368);
    if (a.checkCurBckFromIndex(BCK_WAIT) && (b.checkAllItemDead() || b.unk368 > wait)) {
        b.unk368 = 0;
        b.forceAllItemKill();
        b.world.sound(b.isSpicy ? SE.BS_TELESA_ESCAPE : SE.BS_TELESA_DISAPPEAR, b.pos);
        spine.setNext(BossTelesaNerves.hide);
        spine.pushAfterCurrent(BossTelesaNerves.hide);
        return true;
    }
    return false;
});
BossTelesaNerves.freeze = nerve<BossTelesa>('TNerveBossTelesaFreeze', (spine: S) => {
    const b = spine.body, a = b.mactor!;
    if (a.checkCurBckFromIndex(BCK_WET)) {
        if (b.checkCurAnmEnd(ANM_BCK)) { b.isSpicy = 0; b.unk34C[3] = b.damageAlpha(); return true; }
    } else {
        b.setBckAnm(BCK_WET);
        b.world.sound(SE.BS_TELESA_THANKYOU, b.pos);
    }
    return false;
});
BossTelesaNerves.fallDemo = nerve<BossTelesa>('TNerveBossTelesaFallDemo', (spine: S) => {
    const b = spine.body, w = b.world;
    if (spine.time === 0) {
        b.onLiveFlag(LF.HIDDEN);
        if (sendToMario(w, b, MSG.TAKE)) b.held = w.mario as unknown as TakeActor;
        b.mactor!.setFrameRate(0, ANM_BCK);
        if (b.slot) b.slot.scale.set(0, 0, 0);
    }
    if (b.rouletteFall() && b.slotFall()) {
        b.onAllCollision();
        spine.reset();
        spine.setNext(BossTelesaNerves.hideWait);
        spine.pushAfterCurrent(BossTelesaNerves.hideWait);
        return true;
    }
    return false;
});
void BCK_SPICY_END;

// ---------------------------------------------------------------- TBubble / TBubbleManager
export class BubbleManager extends SmallEnemyManager {
    constructor(w: World, name = 'バブルマネージャー') { super(w, name); }
    load(s: Stream) { this.saveParams = walkerParams('/enemy/bubble.prm', this.world.files, BUBBLE_PARAMS); super.load(s); }
    createModelData() { this.createModelDataArray(['btelesa_osenbubbles_ind.bmd']); }
    createEnemyInstance() { return new Bubble(this.world); }
}

/** TBubble (バブル): rises off the ground growing, carrying an item or an enemy; splits into small ones that chase Mario */
export class Bubble extends WalkerEnemy {
    /** what it carries */
    unk198: LiveActor | null = null;
    /** its height over the ground (the drawn height: calcRootMatrix) */
    unk1CC = 0;
    /** a split-off small one */
    unk1D0 = 0;
    /** still drifting (small ones) */
    unk1D1 = 0;
    /** throw what it carries instead of killing it */
    unk1D2 = 0;
    get PB(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'バブル') { super(w, name); }
    init(m: any) {
        super.init(m);
        this.actorType = AT.EFFECT_OBJ;
        this.unk150 = 0x11;
        this.spine!.initWith(BubbleNerves.live);
        // (light type 3 and the screen texture on H_ma_rak_dummy: drawing only)
    }
    reset() {
        super.reset();
        this.onLiveFlag(LF.UNK8);
        this.unk1CC = rangeRand(50, 150);
        this.unk1D0 = 0; this.unk1D1 = 1; this.unk1D2 = 0;
        this.unk198 = null;
        this.spine!.initWith(BubbleNerves.live);
    }
    split() {
        const n = this.PB.mSLNumDivision;
        for (let i = 0; i < n; ++i) {
            const b = this.world.conductor.makeOneEnemyAppear(this.pos, 'バブルマネージャー', 1) as Bubble | null;
            if (!b) break;
            b.reset();
            b.pos.set(this.pos);
            b.pos.y = fr(b.pos.y + this.unk1CC);
            b.unk1CC = 0;
            b.unk1D0 = 1;
            const vx = rangeRand(-2, 2), vy = rangeRand(-2, 2), vz = rangeRand(-2, 2);
            b.vel.set(vx, vy, vz);
        }
    }
    getGravityY() { if (this.unk1D0) return this.unk1D1 ? 0.001 : 0; return this.gravity; }
    kill() {
        if (this.checkLiveFlag(LF.DEAD)) return;
        if (this.unk198) {
            if (this.unk1D2) this.unk198.receiveMessage(this, MSG.THROWN);
            else this.unk198.kill();
            this.unk198 = null;
        }
        this.hitPoints = 1;
        const s = this.spine!;
        if (s.current !== SmallEnemyNerves.die) {
            s.reset();
            s.setNext(SmallEnemyNerves.die);
            s.pushAfterCurrent(s.default);
            this.onLiveFlag(LF.UNK20000);
        }
        this.onLiveFlag(LF.UNK40);
    }
    behaveToWater(_a: HitActor) {
        if (this.spine!.current === BubbleNerves.live && this.mactor!.checkCurBckFromIndex(BUBBLE_BCK_LIVE)) {
            this.kill();
            const im = mapObjGlobals(this.world).itemManager;
            const it = im ? im.makeObjAppearAt(this.pos.x, fr(this.pos.y + 20), this.pos.z, AT.BOTTLE_LARGE, true) : null;
            if (it && it.killByTimer) it.killByTimer(0x4B0);
        }
    }
    attackToMario() { this.sendAttackMsgToMario(); this.kill(); }
    calcRootMatrix() {
        if (this.isEaten()) return;
        this.pos.y = fr(fr(this.groundHeight + this.unk1CC) + 150);
        MsMtxSetXYZRPH(this.baseTR, this.pos.x, this.pos.y, this.pos.z, this.rot.x, this.rot.y, this.rot.z);
    }
    setDeadAnm() { this.setBckAnm(BUBBLE_BCK_DIE); }
    getTakingMtx(): Mtx | null { return this.baseTR; }
    appendItem() {
        this.unk198 = null;
        const im = mapObjGlobals(this.world).itemManager;
        const it = im ? im.makeObjAppearAt(this.pos.x, this.pos.y, this.pos.z, AT.ITEM_UNK8, true) : null;
        if (it && it.receiveMessage(this, MSG.TAKE)) {
            it.appear();
            it.pos.set(this.pos);
            it.vel.set(0, 15, 0);
            it.offLiveFlag(LF.UNK10);
            this.held = it; this.unk198 = it;
        }
    }
    appendEnemy() {
        this.unk198 = null;
        const r = rangeRand(0, 100), c = this.world.conductor;
        let e: SmallEnemy | null;
        if (r < 50) { e = c.makeOneEnemyAppear(this.pos, 'ポポマネージャー', 1) as SmallEnemy | null; if (!e) return; e.unk154 = 0.6; e.reset(); }   // (the game doesn't check these for null)
        else if (r < 100) { e = c.makeOneEnemyAppear(this.pos, 'ボム兵マネージャー', 1) as SmallEnemy | null; if (!e) return; e.unk154 = 0.3; e.reset(); }
        else if (r < 150) {
            e = c.makeOneEnemyAppear(this.pos, 'テレサマネージャー', 1) as SmallEnemy | null;
            if (!e) return;
            e.unk154 = 0.6; e.reset();
            (e as unknown as Telesa).setAttacker();
        } else { e = c.makeOneEnemyAppear(this.pos, 'パックンマネージャー', 1) as SmallEnemy | null; if (!e) return; e.unk154 = 0.6; e.reset(); }
        if (e.receiveMessage(this, MSG.TAKE)) {
            e.onHitFilter(HC.BOSS);
            this.held = e;
            e.vel.set(0, 2, 10);
            e.onLiveFlag(LF.AIRBORNE);
            this.unk198 = e;
        }
    }
}

type BS = Spine<Bubble>;
export const BubbleNerves: Record<string, any> = {};
BubbleNerves.live = nerve<Bubble>('TNerveBubbleLive', (spine: BS) => {
    const b = spine.body, P = b.PB;
    if (spine.time === 0) {
        b.offHitFilter(HF.NO_COLLISION);
        if (!b.unk1D0) b.setBckAnm(BUBBLE_BCK_APPEAR);
        else { b.setBckAnm(BUBBLE_BCK_LIVE); b.setGoalPath(new PathNode(b.world.mario)); }
        const fc = b.mactor!.getFrameCtrl(ANM_BCK);
        const f = rangeRand(0, 20);
        if (fc) fc.frame = f;
        b.onLiveFlag(LF.UNK8);
    } else if (b.checkCurAnmEnd(ANM_BCK)) { b.offHitFilter(HF.NO_COLLISION); b.setBckAnm(BUBBLE_BCK_LIVE); }
    const base = P.mSLAddPosBase;
    if (!b.unk1D0) { if (b.unk1CC < base) b.unk1CC = fr(b.unk1CC + 2); }
    else {
        if (spine.time > 40 && b.unk1D1) b.vel.scale(0.98);
        else b.walkBehavior(0, 1);
        if (spine.time === 80) { b.unk1D1 = 0; b.vel.set(0, 0, 0); }
    }
    b.unk1CC = fr(b.unk1CC + 0.001);
    if (b.unk1CC > b.pos.y + P.mSLDeadHeight) { b.unk1D2 = 0; b.kill(); }
    if (b.scale.x < P.mSLMaxScale) { const s = fr(b.scale.z * P.mSLRateExpand); b.scale.set(s, s, s); }
    if (spine.time > P.mSLLiveTime) { spine.pushAfterCurrent(BubbleNerves.split); return true; }
    return false;
});
BubbleNerves.split = nerve<Bubble>('TNerveBubbleSplit', (spine: BS) => {
    const b = spine.body;
    if (spine.time === 0) { b.onHitFilter(HF.NO_COLLISION); b.split(); }
    if (spine.time === 10) b.setBckAnm(BUBBLE_BCK_DIE);
    if (b.checkCurAnmEnd(ANM_BCK) && b.mactor!.checkCurBckFromIndex(BUBBLE_BCK_DIE)) { b.unk1D2 = 0; b.kill(); }
    return false;
});

/**
 * TTelesaSlot (btelesaSlot; scene class TelesaSlot, the srotRulet model): the slot on King Boo's
 * belly. initMapObj: TSlotDrum::initMapObj (its own initNeonMatColor does nothing: the neons'
 * colours are only drawing), then TTelesaSlot's values and drum faces (installTelesaSlot).
 * TODO: its TMapCollisionMove (unk1DC, entryObjCollision / calcObjCollision) isn't ported.
 */
export class TelesaSlot extends SlotDrum {
    constructor(w: World, name = 'btelesaSlot') { super(w, name); }
    initMapObj() { super.initMapObj(); installTelesaSlot(this); }
    initNeonMatColor() { }
}

register('TelesaSlot', (w, n) => new TelesaSlot(w, n));
register('BossTelesaManager', (w, n) => new BossTelesaManager(w, n));
register('BossTelesa', (w, n) => new BossTelesa(w, n));
register('BubbleManager', (w, n) => new BubbleManager(w, n));
