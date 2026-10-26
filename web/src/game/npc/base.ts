// The NPCs (NPC/: TBaseNPC and its helpers), ported from the decomp: NpcBase.cpp (perform,
// moveObject, the kind predicates), NpcInitPrg.cpp (init, setIndividualDifference_), NpcNerve.cpp
// (the nerves), NpcWalkTurn.cpp, NpcChange.cpp (what makes them change nerve: talk, water,
// trampling, the goop they sink into), NpcAnm.cpp (which animation kind plays), NpcCollision.cpp
// (pushing each other aside, bind), NpcTrample.cpp, NpcInbetween.cpp, NpcCoin.cpp, NpcThrow.cpp,
// NpcSave.cpp (the parameter files) and M3DUtil/LodAnm.cpp (animation kind -> BCK / BTP index).
//
// Not here: drawing (the parts, colours and joint callbacks are the viewer's: npc/look.ts), the
// sounds, the balloon messages and the talk itself (TMarDirector's talk mode isn't simulated:
// an NPC only goes into its talk nerve if something sets LF_N.UNK40000).

import { fr, V3, MsRandF, MsRandI, MsWrap, MsClamp, MsGetRotFromZaxis, MsGetRotFromZaxisY, MsIsInSight, JMASSin, JMASCos, matan, s16, IConverge } from '../math.js';
import { World, Stream, HitActor, TakeActor, LiveActor, LiveManager, SpineEnemy, Spine, Nerve, nerve, LF, HF, HC, MSG, ANM_BCK, ANM_BTP, CUE_MOVE, CUE_CALC_ANIM, CUE_ENTRY, CUE_CALC_VIEW, PSchema, PType, readParams } from '../engine.js';
import { AT } from '../actortypes.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { CLBDegToShortAngle, chaseSpeedF, chaseSpeedS, chaseFrameF } from '../camera/lib.js';
import { newAndRegisterObjByEventID } from '../mapobj/item.js';
import { mapObjGlobals, MapObjBase } from '../mapobj/base.js';
import type { ItemManager } from '../mapobj/item.js';
import { marioGroundLevel, marioTouchGround4cm } from '../mapobj/lib.js';
import { NPC_INIT, NPC_ANM } from './npcdata.js';

// ---------------------------------------------------------------- enums
/** EnumNpcAnmKind */
export const NK = {
    WALK: 0x0, UNK1: 0x1, UNK2: 0x2, UNK3: 0x3, UNK4: 0x4, UNK5: 0x5, UNK6: 0x6, UNK7: 0x7, RUN: 0x8, TAKEN: 0x9, MAD: 0xA, UNKB: 0xB,
    UNKC: 0xC, THROW: 0xD, UNKE: 0xE, DIRTY: 0xF, UNK10: 0x10, HAPPY: 0x11, UNK12: 0x12, UNK13: 0x13, UNK14: 0x14, UNK15: 0x15, DANCE: 0x16,
    UNK17: 0x17, UNK18: 0x18, WASH: 0x19, UNK1A: 0x1A, UNK1B: 0x1B, INVALID: -1,
};
/** TBaseNPC::mActionFlag */
export const NA = {
    UNK1: 0x1, UNK2: 0x2, DANCE: 0x4, RUN: 0x8, UNK10: 0x10, UNK20: 0x20, UNK40: 0x40, UNK80: 0x80, UNK100: 0x100, HAPPY: 0x200,
    UNK400: 0x400, UNK800: 0x800, UNK1000: 0x1000, UNK2000: 0x2000, BURNING: 0x4000,
};
/** The live flags NPC code uses past engine.ts's LF table (US / PAL values, as LF's are). */
export const LF_N = {
    UNK10000: LF.UNK10000, UNK20000: LF.UNK20000, UNK40000: LF.UNK40000, UNK80000: LF.UNK80000, UNK100000: LF.UNK100000,
    UNK200000: LF.UNK200000, UNK400000: LF.UNK400000, UNK1000000: LF.UNK1000000,
    UNK2000000: 0x4000000, UNK4000000: 0x8000000, UNK8000000: 0x10000000, UNK10000000: 0x20000000,
    /** TBaseNPC::LIVE_FLAG_DONT_TALK, LIVE_FLAG_SINK_BOTTOM, LIVE_FLAG_DONT_THROW */
    DONT_TALK: LF.UNK10000, SINK_BOTTOM: 0x1000000, DONT_THROW: 0x40000000,
};
const T = AT;
/** sinf of an f32 (the C library's, rounded) */
const MONTE_M = T.NPC_MONTE_M;

/** CLBPalFrame: frames at 30 a second (SMSGetAnmFrameRate 2): round(x / 2) */
export const palFrame = (x: number) => { const v = fr(x * 0.5); return Math.trunc(v + (v > 0 ? 0.5 : -0.5)); };

// ---------------------------------------------------------------- the parameter files (NpcSave.cpp)
const F = (v: number): [PType, number] => ['f', v], S = (v: number): [PType, number] => ['s16', v], I = (v: number): [PType, number] => ['i', v];
export const NPC_FAR_SCHEMA = {
    mSLFarAirport: F(15000), mSLFarDolpicTown: F(15000), mSLFarBiancoHills: F(15000), mSLFarRiccoHarbor: F(15000), mSLFarMammaBeach: F(15000),
    mSLFarPinnaBeach: F(15000), mSLFarPinnaParco: F(15000), mSLFarSirenaBeach: F(15000), mSLFarHotelDelfino: F(15000), mSLFarMareVillage: F(15000),
    mSLFarMonteVillage: F(15000), mSLFarCoronaMountain: F(15000), mSLFarOthers: F(15000),
} satisfies PSchema;
export const NPC_NORMAL_SCHEMA = {
    mSLMarioTalkAcceptDegree: F(150), mTalkAcceptDist: F(200), mTalkAcceptHeight: F(150), mTalkAcceptDegree: F(150), mSLSitTalkAcceptDegree: F(100),
    mSLSunflowerLTalkDist: F(600), mSLThrowTalkAcceptDist: F(200), mSLThrowTalkAcceptHeight: F(150), mSLThrowStartFrame: S(40), mSLTrampleShakeFrames: S(40),
    mSLTrampleAmplitude: F(0.75), mSLTrampleVelocity: S(1500), mSLTrampleToMadFrames: S(60), mSLHeadHeightNormal: F(100), mSLHeadHeightSandBomb: F(200),
    mSLBlownVelocity: F(30), mGravityY: F(0.3), mMoveWalkAnmRateChase: F(0.9), mStopWalkAnmRateChase: F(0.01), mStopWalkAnmRateFrame: I(10),
    mMotionBlendFrame: I(20), mSLDanceAnmOffDist: F(6500), mThrowSpeedXZ: F(3.5), mThrowSpeedY: F(2.5), mPosInbetweenFrame: I(6),
    mSLGraphWanderMinFrame: S(300), mSLGraphWanderMaxFrame: S(3000), mSLGraphWaitMinFrame: S(100), mSLGraphWaitMaxFrame: S(1200),
    mSLCleanEffectScale: F(3), mSLSmokeRunMagnif: F(1.5), mSLFireDecSpeed: F(0.002),
} satisfies PSchema;
export const NPC_INDIVIDUAL_SCHEMA = {
    mSLBodyHeight: F(200), mSLCursorHeight: F(30), mSLLookatHeight: F(40), mCircleShadowSize: F(60), mSLDamageRadiusSmall: F(10),
    mSLMinWalkAnmRate: F(0.1), mSLMaxWalkAnmRate: F(1.5), mSLMaxRunAnmRate: F(3), mSLMinMarchSpeed: F(0.2), mMaxMarchSpeed: F(3),
    mSLMaxRunSpeed: F(6), mSLRunAccel: F(0.08), mMarchAccel: F(0.02), mMarchDecrease: F(0.1), mWalkTurnSpeed: F(5), mWaitTurnSpeed: F(1),
    mTurnAnmMinRate: F(1), mTurnAnmMaxRate: F(1), mTurnAnmRate: F(1), mWaitAnmOffDist0: F(3500), mWaitAnmOffDist1: F(7500), mLodChangeDist: F(5500),
    mAllDLLockDist: F(2000), mNeckTurnSearchDist: F(500), mNeckTurnSearchHeight: F(600), mBodyTurnSearchDist: F(300), mBodyTurnSearchHeight: F(250),
    mBodyTurnSearchDegree: F(240), mBodyTurnSearchAware: F(160), mMadSearchDist: F(800), mMadSearchHeight: F(400), mMadSearchDegree: F(240),
    mMadSearchAware: F(500), mMadTurnSpeed: F(20), mFirstStateTurnSpeed: F(0.5), mUTurnSpeed: F(3), mSinkSpeed: F(0.3), mSinkHeight: F(220),
    mPollutionMax: ['u8', 150], mPollutionCleanSpeed: F(0.004), mNeckMinAngleX: S(-8192), mNeckMaxAngleX: S(0), mNeckMaxAngleY: S(15000),
    mNeckAngleXSpeed: S(500), mNeckAngleYSpeed: S(700),
} satisfies PSchema;
type Vals<S> = { [K in keyof S]: number };
export type NpcNormal = Vals<typeof NPC_NORMAL_SCHEMA>;
export type NpcIndividual = Vals<typeof NPC_INDIVIDUAL_SCHEMA>;
const SAVE_FILES = ['npcMonteM', 'npcMonteM', 'npcMonteM', 'npcMonteM', 'npcMonteM', 'npcMonteME', 'npcMonteMF', 'npcMonteMG', 'npcMonteMH',
    'npcMonteW', 'npcMonteW', 'npcMonteW', 'npcMonteWC', 'npcMareM', 'npcMareMA', 'npcMareMB', 'npcMareMC', 'npcMareMD', 'npcMareW', 'npcMareWA',
    'npcMareWB', 'npcKinopio', 'npcKinojii', 'npcPeach', 'npcRaccoonDog', 'npcSunflowerL', 'npcSunflowerS', 'npcDummy', 'npcBoard'];
/** TNpcParams (gpConductor->getNpcParams()): read once per stage */
export interface NpcParams { far: Vals<typeof NPC_FAR_SCHEMA>; normal: NpcNormal; individual: NpcIndividual[]; }
const PARAMS = new WeakMap<World, NpcParams>();
const f32All = (o: any, schema: PSchema) => { for (const k in schema) if (schema[k][0] === 'f') o[k] = fr(o[k]); return o; };
/** gpConductor's TCondParams (/conductor.prm): only mEnemyFarClip is read here */
const COND = new WeakMap<World, { mEnemyFarClip: number }>();
export function condParams(w: World) {
    let p = COND.get(w);
    if (!p) {
        const schema = { mEnemyFarClip: F(5000), mGenerateRadiusMax: F(1000), mGenerateRadiusMin: F(200), mGenerateTime: I(300), mGenerateProp: F(0.01) };
        p = f32All(readParams('/conductor.prm', w.files, schema), schema) as any;
        COND.set(w, p!);
    }
    return p!;
}
export function npcParams(w: World): NpcParams {
    let p = PARAMS.get(w);
    if (!p) {
        const read = <S extends PSchema>(path: string, s: S) => f32All(readParams(path, w.files, s), s);
        const ind: NpcIndividual[] = [];
        for (let i = 0; i < 29; i++) {
            if (i >= 1 && i <= 4) ind.push(ind[0]);
            else if (i === 10 || i === 11) ind.push(ind[9]);
            else ind.push(read(`/Npc/${SAVE_FILES[i]}.prm`, NPC_INDIVIDUAL_SCHEMA));
        }
        p = { far: read('/Npc/npcFarClip.prm', NPC_FAR_SCHEMA), normal: read('/Npc/npcNormal.prm', NPC_NORMAL_SCHEMA), individual: ind };
        PARAMS.set(w, p);
    }
    return p;
}

// ---------------------------------------------------------------- TLodAnm (M3DUtil/LodAnm.cpp)
export class LodAnm {
    cur = -1; lod = 0;
    indBck: number[][] | null = null; indBtp: number[][] | null = null;
    constructor(public owner: LiveActor, public table: number[][] | null, lod: number, public changeDist: number) { this.lod = lod; }
    private remap(v: number, map: number[][] | null) { if (map) for (const [a, b] of map) { if (a < 0) break; if (v === a) return b; } return v; }
    private setBck(k: number) {
        const a = this.owner.mactor!;
        if (k < 0) { a.setBckFromIndex(-1); return true; }
        const now = a.getCurAnmIdx(ANM_BCK);
        const t = this.remap(this.table ? this.table[k][this.lod] : k, this.indBck);
        if (now !== t) { a.setBckFromIndex(t); return true; }
        return false;
    }
    private setBtp(k: number) {
        const a = this.owner.mactor!;
        if (k < 0) { a.setFromIndex(ANM_BTP, -1); return true; }
        const now = a.getCurAnmIdx(ANM_BTP);
        const t = this.remap(this.table![k][2 + this.lod], this.indBtp);
        if (now !== t) { a.setFromIndex(ANM_BTP, t); return true; }
        return false;
    }
    setBckAndBtpAnm(k: number) {
        const r = this.setBck(k);
        if (this.table) this.setBtp(k);
        this.cur = k;
        return r;
    }
}

// ---------------------------------------------------------------- the helpers
/** TNpcInbetween */
export class NpcInbetween {
    posTimer = 0; target = new V3(); current = new V3(); blendTimer = 0; forced = 0;
    constructor(public posFrames: number, public blendFrames: number) { }
    isMotionBlending() { return this.blendTimer > 0; }
    isForcedBlendRatio() { return this.forced > 0; }
    startPosBlend() { this.posTimer = this.posFrames; }
    startMotionBlend() { this.blendTimer = this.blendFrames; }
    stopMotionBlend() { this.blendTimer = 0; }
    applyPos(p: V3) { if (this.posTimer > 0) p.set(this.current); }
    reset() { this.blendTimer = 0; this.forced = 0; }
    execPosInbetween(p: V3) {
        this.current.set(p);
        if (this.posTimer >= 2) {
            this.posTimer -= 1;
            const k = fr(this.posTimer * fr(1 / this.posFrames));
            p.set(fr(this.current.x + fr(fr(this.target.x - this.current.x) * k)), fr(this.current.y + fr(fr(this.target.y - this.current.y) * k)),
                fr(this.current.z + fr(fr(this.target.z - this.current.z) * k)));
        } else { this.target.set(p); this.posTimer = 0; }
    }
    /** execMotionBlend: the blend's timer (the blend itself is drawing: the ratio is kept for the viewer) */
    ratio = 0;
    execMotionBlend() {
        let r = 0;
        if (this.isForcedBlendRatio()) { this.blendTimer = 0; r = this.forced; }
        else if (this.isMotionBlending()) {
            if (this.blendTimer > 0) this.blendTimer -= 1;
            if (this.blendTimer > 0) r = fr(this.blendTimer * fr(1 / this.blendFrames));
        }
        this.ratio = r;
    }
}
/** TNpcKeepAnm: an animation asked for while blending, played once the blend is done */
class NpcKeepAnm {
    kind = NK.INVALID; blend = false;
    reset() { this.kind = NK.INVALID; }
    keep(k: number, b: boolean) { this.kind = k; this.blend = b; }
}
/** TNpcTrample: squashed when stamped on, its Y scale shaking back */
class NpcTrample {
    static msAmpDecrease = 0;
    unk0 = 0; unk4 = 0; unk6 = 0;
    constructor(public P: NpcNormal) { NpcTrample.msAmpDecrease = 0; }
    startTrample() {
        this.unk0 = this.P.mSLTrampleAmplitude; this.unk4 = this.P.mSLTrampleShakeFrames; this.unk6 = 0;
        NpcTrample.msAmpDecrease = fr(this.unk0 * fr(1 / this.unk4));
    }
    /** [done, the Y scale] */
    updateTrample(base: number, cur: number): [boolean, number] {
        let r = false, y = cur;
        if (this.unk6 === 0 && this.unk4 === 0) y = base;
        else if (this.unk6 > 0) { y = base; this.unk4 = 0; this.unk6 -= 1; if (this.unk6 === 0) r = true; }
        else if (this.unk4 > 0) {
            this.unk4 -= 1;
            if (this.unk4 === 0) { y = base; this.unk6 = this.P.mSLTrampleToMadFrames; }
            else {
                this.unk0 = fr(this.unk0 - NpcTrample.msAmpDecrease);
                const ph = s16(this.P.mSLTrampleVelocity * (this.P.mSLTrampleShakeFrames - this.unk4));
                const amp = fr(this.unk0 * -JMASSin(ph));
                y = fr(base * fr(amp + 1));
            }
        }
        return [r, y];
    }
}
/** TNpcCoin: the coin (or blue coin, or 1-up) it gives once cleaned or talked to happy */
class NpcCoin {
    obj: MapObjBase | null; unk4 = 0; unk8 = new V3(); unk14 = new V3();
    constructor(public npc: BaseNPC, id: number) {
        this.obj = newAndRegisterObjByEventID(npc.world, id, '');
        if (this.obj) this.obj.kill();
    }
    private execAppearCoin() {
        const w = this.npc.world;
        if (this.obj) {
            this.obj.appear();
            this.obj.pos.set(this.unk8);
            this.obj.vel.set(this.unk14); this.obj.offLiveFlag(LF.UNK10);
            this.obj = null;
        } else {
            const im = mapObjGlobals(w).itemManager as ItemManager | null;
            const c = im ? im.makeObjAppearAt(this.unk8.x, this.unk8.y, this.unk8.z, AT.COIN, true) : null;
            if (c) { c.vel.set(this.unk14); c.offLiveFlag(LF.UNK10); }
        }
        w.sound(SE.NPC_APPEAR_ITEM, this.unk8);
    }
    requestAppearCoin(p: V3, yaw: number, delay: number) {
        this.unk4 = delay;
        this.unk8.set(p);
        const a = 75 * Math.trunc(65536 / 360);
        this.unk14.set(0, JMASSin(a), JMASCos(a));
        const s = CLBDegToShortAngle(yaw), x = this.unk14.x;
        this.unk14.x = fr(fr(x * JMASCos(s)) + fr(this.unk14.z * JMASSin(s)));
        this.unk14.z = fr(fr(-x * JMASSin(s)) + fr(this.unk14.z * JMASCos(s)));
        this.unk14.scale(15);
        if (this.unk4 === 0) { if (talkOrDemo(this.npc.world)) this.unk4 = 1; else this.execAppearCoin(); }
    }
    updateCoin() {
        if (this.unk4 > 0 && !talkOrDemo(this.npc.world)) { this.unk4 -= 1; if (this.unk4 === 0) this.execAppearCoin(); }
    }
}
/** TNpcThrow: the NPCs that throw Mario once talked to (the ones on the beach / at the village) */
class NpcThrow {
    constructor(public speed: number, public angle: number) { }
    throwMario(from: BaseNPC) {
        const v = new V3();
        if (this.angle >= 90) v.set(0, 1, 0);
        else if (this.angle <= 0) v.set(0, 0, -1);
        else { const a = CLBDegToShortAngle(this.angle); v.set(0, JMASSin(a), -JMASCos(a)); }
        const s = CLBDegToShortAngle(from.rot.y), x = v.x;
        v.x = fr(fr(x * JMASCos(s)) + fr(v.z * JMASSin(s)));
        v.z = fr(fr(-x * JMASSin(s)) + fr(v.z * JMASCos(s)));
        const m = from.world.mario as any;
        m.receiveMessage(from, MSG.THROWN);
        // SMS_ThrowMario(dir, speed)
        if (typeof m.throwMario === 'function') m.throwMario(v, this.speed);
    }
}
/** TMarDirector::isTalkOrDemoModeNow / isThing (talk, or the demo kind 4) */
const talkOrDemo = (w: World) => !!(w.talkMode || w.demoMode);
/** TMarDirector::isThing: isTalkModeNow() || unk124 == 4 (a demo from a talk) */
const directorIsThing = (w: World) => !!w.talkMode || (!!w.talk && w.talk.unk124 === 4);

/** TBaseNPC::TNpcUnk22CStruct: a countdown with a random length */
class NpcTimer {
    unk0 = 0; unk4 = 1;
    constructor(public P: NpcNormal) { }
    doThing() { this.unk0 = 0; this.unk4 = MsRandI(this.P.mSLGraphWanderMinFrame, this.P.mSLGraphWanderMaxFrame); }
    startGraphWait() { this.unk0 = 0; this.unk4 = MsRandI(this.P.mSLGraphWaitMinFrame, this.P.mSLGraphWaitMaxFrame); }
    doThing2() { this.unk0 += 1; if (this.unk0 >= this.unk4) { this.unk0 = this.unk4; return true; } return false; }
    doThing3(l: number, r: number) { if (this.unk0 === 0) { this.unk0 = 0; this.unk4 = MsRandI(l, r); } }
}
/** TNpcSink: how often a goop NPC checks the ground under it (30 frames, staggered) */
class NpcSink {
    constructor(public unk0: number, public unk4: number) { }
    doThing() { this.unk0 += 1; if (this.unk0 >= this.unk4) { this.unk0 = this.unk4; return true; } return false; }
}
/** initSinkNpc_'s static counter (one per stage) */
const SINK_COUNTER = new WeakMap<World, { n: number }>();

// sBaseActionFlagTable (NpcInitActionData.cpp)
const MONTE_ACTIONS = [0, 1, 2, 16, 32, 33, 0x80, 0x88, 0x40, 0, 0, 4, 0x1080, 0, 2, 16, 32, 8, 10, 0x18, 0x28, 0x80, 0, 0x0400, 0x4088];
const MARE_ACTIONS = [0, 1, 0x80, 0x88, 0x20, 0x21, 0, 4, 0x40, 0x2080, 0, 0, 8, 0, 0x20, 0, 2];
const KINO_ACTIONS = [0, 1, 0x88, 0x20, 0x21, 0x80, 0, 8, 0x100, 0x101, 0x188, 0x120, 0x121, 0x180, 0x100, 0x108];

// ---------------------------------------------------------------- TBaseNPC
export class BaseNPC extends SpineEnemy {
    static mAngleYDiffWhenTaken = 0;
    /** unk158: who carries it (to see it put down) */
    unk158: TakeActor | null = null;
    sink: NpcSink | null = null;
    neckJoint = -1;
    /** unk16C: the action data index (the scene's) */
    unk16C = 0;
    actionFlag = 0;
    /** unk174: KCOLOR0 (the goop amount in its alpha) */
    unk174 = [255, 255, 255, 0];
    pollution = 0;
    throwCtrl: NpcThrow | null = null; trample: NpcTrample | null = null; coin: NpcCoin | null = null;
    inbetween!: NpcInbetween; keepAnm: NpcKeepAnm | null = null;
    lodAnm!: LodAnm;
    /** unk194 / unk1A0: where it was placed and its rotation; its scale */
    unk194 = new V3(); unk1A0 = new V3(); initScale = new V3(1, 1, 1); unk1B8 = new V3();
    /** unk1C4: the height it sank from; unk1C8: the sand bomb's rise last tick */
    unk1C4 = 0; unk1C8 = 0;
    /** unk1CC / unk1D0: the walk animation slowing to a stop (frames, rate) */
    unk1CC = 0; unk1D0 = 0;
    /** mDummyConnectActor: set by the event scripts (evConnectDummyNpc), which the sim doesn't run */
    dummyConnect: LiveActor | null = null;
    unk1D8 = 0; unk1D9 = 0; unk1DA = 0; unk1DC = 0;
    talkForbid = 120; walkForbid = 0; damageParticleForbid = 0;
    burnStrength = 1;
    P!: NpcNormal; Q!: NpcIndividual;
    unk22C: NpcTimer | null = null;
    /** the scene's colour indices and parts flags (the viewer's look: npc/look.ts) */
    look = { c0: [0, 0, 0], c1: [0, 0, 0], parts: 0 };
    /** the material tables etc. the manager sets (the viewer's) */
    constructor(w: World, type: number, name = '?') {
        super(w, name);
        BaseNPC.mAngleYDiffWhenTaken = 0;
        this.actorType = type | 0;
        this.P = npcParams(w).normal;
        if (type !== T.NPC_DUMMY) {
            this.keepAnm = new NpcKeepAnm();
            if (this.isBeTrampledNpc()) this.trample = new NpcTrample(this.P);
        }
    }
    get kindIndex() { return this.actorType - MONTE_M; }
    // ------------------------------------------------------------ the kind predicates
    is(...types: number[]) { return types.includes(this.actorType); }
    isNormalMonteM() { return this.is(T.NPC_MONTE_M, T.NPC_MONTE_MA, T.NPC_MONTE_MB, T.NPC_MONTE_MC, T.NPC_MONTE_MD); }
    isNormalMonteW() { return this.is(T.NPC_MONTE_W, T.NPC_MONTE_WA, T.NPC_MONTE_WB); }
    isSpecialMonteM() { return this.is(T.NPC_MONTE_ME, T.NPC_MONTE_MF, T.NPC_MONTE_MG, T.NPC_MONTE_MH); }
    isSpecialMonteW() { return this.is(T.NPC_MONTE_WC); }
    isNormalMonte() { return this.isNormalMonteM() || this.isNormalMonteW(); }
    isSpecialMonte() { return this.isSpecialMonteM() || this.isSpecialMonteW(); }
    isMonte() { return this.isNormalMonte() || this.isSpecialMonte(); }
    isMonteM() { return this.isNormalMonteM() || this.isSpecialMonteM(); }
    isMonteW() { return this.isNormalMonteW() || this.isSpecialMonteW(); }
    isNormalMareM() { return this.is(T.NPC_MARE_M); }
    isNormalMareW() { return this.is(T.NPC_MARE_W); }
    isSpecialMareM() { return this.is(T.NPC_MARE_MA, T.NPC_MARE_MB, T.NPC_MARE_MC, T.NPC_MARE_MD); }
    isSpecialMareW() { return this.is(T.NPC_MARE_WA, T.NPC_MARE_WB); }
    isNormalMare() { return this.isNormalMareM() || this.isNormalMareW(); }
    isSpecialMare() { return this.isSpecialMareM() || this.isSpecialMareW(); }
    isMare() { return this.isNormalMare() || this.isSpecialMare(); }
    isMareM() { return this.isNormalMareM() || this.isSpecialMareM(); }
    isMareW() { return this.isNormalMareW() || this.isSpecialMareW(); }
    isJellyFishMare() { return this.is(T.NPC_MARE_WA, T.NPC_MARE_MA); }
    isSunflower() { return this.is(T.NPC_SUNFLOWER_L, T.NPC_SUNFLOWER_S); }
    isChild() { return this.scale.x < fr(0.7) && this.scale.y < fr(0.7) && this.scale.z < fr(0.7); }
    isSmallNpc() { return this.isChild() || this.isMare() || this.is(T.NPC_KINOPIO, T.NPC_KINOJII); }
    isPollutionNpc() { return this.is(T.NPC_MONTE_M, T.NPC_MONTE_MA, T.NPC_MONTE_MC, T.NPC_MONTE_W, T.NPC_MONTE_WA, T.NPC_MARE_M, T.NPC_MARE_W, T.NPC_KINOPIO); }
    isBeTrampledNpc() { return !this.isJellyFishMare() && (this.isMonte() || this.isMare() || this.is(T.NPC_KINOPIO, T.NPC_KINOJII)); }
    isMadNpc() { return this.isNormalMonte() || this.is(T.NPC_MONTE_ME, T.NPC_MONTE_MF, T.NPC_MONTE_WC); }
    isBehaveToWaterNpc() { return !this.is(T.NPC_MONTE_MF, T.NPC_MONTE_MG, T.NPC_MARE_MA, T.NPC_MARE_WA, T.NPC_DUMMY, T.NPC_BOARD); }
    isBehaveToHitNpc() { return this.isMadNpc() || this.is(T.NPC_MARE_M, T.NPC_MARE_MB, T.NPC_MARE_MC, T.NPC_MARE_W, T.NPC_MARE_WB, T.NPC_KINOPIO, T.NPC_KINOJII); }
    isPartsAnmNpc() { return this.isJellyFishMare() || this.is(T.NPC_MARE_MB, T.NPC_MARE_WB, T.NPC_PEACH); }
    isClean() { return this.pollution === 0; }
    checkActionFlag(f: number) { return (this.actionFlag & f) !== 0; }
    onActionFlag(f: number) { this.actionFlag |= f; }
    offActionFlag(f: number) { this.actionFlag &= ~f; }
    isSunflowerReviving() { return this.isSunflower() && (this.unk1D8 & 2) !== 0; }
    isPeachTired() { return this.actorType === T.NPC_PEACH && (this.unk1D8 & 2) !== 0; }
    isInBodyTurnSearchRange() {
        const m = this.world.mario.pos, Q = this.Q;
        return Math.abs(fr(m.y - this.pos.y)) < Q.mBodyTurnSearchHeight && this.isInSight(m, Q.mBodyTurnSearchDist, Q.mBodyTurnSearchDegree, Q.mBodyTurnSearchAware);
    }
    isInMadSearchRange() {
        const m = this.world.mario.pos, Q = this.Q;
        return Math.abs(fr(m.y - this.pos.y)) < Q.mMadSearchHeight && this.isInSight(m, Q.mMadSearchDist, Q.mMadSearchDegree, Q.mMadSearchAware);
    }
    getCursorPos() { return new V3(this.pos.x, fr(fr(this.pos.y + fr(this.initScale.y * this.Q.mSLBodyHeight)) + this.Q.mSLCursorHeight), this.pos.z); }
    getFocalPoint() { return new V3(this.pos.x, fr(this.pos.y + fr(this.initScale.y * fr(this.Q.mSLBodyHeight - this.Q.mSLLookatHeight))), this.pos.z); }
    // ------------------------------------------------------------ the nerve predicates (NpcChange.cpp)
    private latest() { return this.spine!.getLatestNerve(); }
    private top() { const s = this.spine!; return s.stack.length ? s.stack[s.stack.length - 1] : null; }
    isNerveWalk() { const n = this.latest(); return n === N.graphWander || n === N.uTurn || n === N.graphWait; }
    isNerveMaybeDontMovement() { const n = this.latest(); return n === N.waitContinue || n === N.waitMarioApproach || n === N.sink; }
    isNerveMaybeDontCalcAnim0() { const n = this.latest(); return n === N.waitContinue || n === N.waitMarioApproach; }
    isNerveMaybeDontCalcAnim1() { const n = this.latest(); return n === N.graphWait || n === N.waitContinue || n === N.waitMarioApproach; }
    isNerveCanGoToTalk() {
        const n = this.latest();
        if (n === N.graphWander || n === N.uTurn || n === N.graphWait || n === N.turnToMario || n === N.wet || n === N.recoverAfter || n === N.mad || n === N.mareStand)
            return !!this.spine!.current || (this.top() !== N.wet && this.top() !== N.talk);
        return false;
    }
    isNerveCanGoToWet() {
        const n = this.latest();
        if (n === N.graphWander || n === N.uTurn || n === N.graphWait || n === N.waitContinue || n === N.waitMarioApproach || n === N.turnToMario || n === N.talk)
            return !!this.spine!.current || (this.top() !== N.wet && this.top() !== N.talk);
        return false;
    }
    isNerveCanGoToSink() {
        const n = this.latest();
        if (n === N.graphWander || n === N.uTurn || n === N.graphWait || n === N.waitContinue || n === N.waitMarioApproach || n === N.turnToMario)
            return !!this.spine!.current || this.top() !== N.sink;
        return false;
    }
    isNerveCanGoToTaken() {
        const n = this.latest();
        return n === N.graphWander || n === N.uTurn || n === N.graphWait || n === N.waitContinue || n === N.waitMarioApproach || n === N.turnToMario
            || n === N.wet || n === N.sink || n === N.recoverFromSink || n === N.recoverAfter;
    }
    isNerveCanGoToMad() {
        const n = this.latest();
        return n === N.graphWander || n === N.uTurn || n === N.graphWait || n === N.waitContinue || n === N.waitMarioApproach || n === N.turnToMario || n === N.wet;
    }
    isNerveCanGoToBlown() {
        const n = this.latest();
        return (n === N.graphWander || n === N.uTurn || n === N.graphWait || n === N.waitContinue || n === N.waitMarioApproach || n === N.turnToMario
            || n === N.wet || n === N.mareStand) && !directorIsThing(this.world);
    }
    isNowCanTaken() {
        return this.checkLiveFlag(LF_N.UNK100000) && this.actorType !== T.NPC_DUMMY && !this.holder && !this.held
            && !this.checkLiveFlag(LF.DEAD | LF.HIDDEN | LF.CLIPPED_OUT | LF_N.UNK40000 | LF_N.SINK_BOTTOM)
            && !this.checkHitFilter(HF.NO_COLLISION) && this.isNerveCanGoToTaken();
    }
    isStateGoToMad() {
        return this.isMadNpc() && !this.checkActionFlag(NA.BURNING | NA.UNK400 | NA.HAPPY) && this.isClean() && this.isInMadSearchRange();
    }

    // ------------------------------------------------------------ loading (NpcBase.cpp, NpcInitPrg.cpp)
    load(s: Stream) {
        super.load(s);
        this.unk194.set(this.pos); this.unk1A0.set(this.rot); this.initScale.set(this.scale);
        if (this.Q) this.unk1B8 = this.getFocalPoint();
        if ((this.actorType >= 0x400001E || this.actorType < T.NPC_DUMMY) && this.lodAnm) this.setIndividualDifference(s);
    }
    loadAfter() { super.loadAfter(); }
    init(m: LiveManager | null) {
        const k = this.kindIndex;
        this.Q = npcParams(this.world).individual[k];
        if (!m) {
            this.onLiveFlag(LF.DEAD);
            this.initHitActor(this.actorType, 0, 0, 0, 0, 0, 0);
            this.onHitFilter(HF.NO_COLLISION);
            this.spine!.initWith(N.waitMarioApproach);
            this.turnSpeed = this.Q.mWaitTurnSpeed;
            this.world.conductor.aloneActors.push(this);
            return;
        }
        const info = NPC_INIT[k]!;
        this.manager = m;
        m.manageActor(this);
        this.mactor = this.createMActor(0);
        this.bodyScale = 1; this.bodyRadius = 10; this.marchSpeed = 0;
        this.wallRadius = fr(info.hit[0] * this.scale.x);
        this.headHeight = this.P.mSLHeadHeightNormal;
        this.gravity = this.P.mGravityY;
        this.scaledBodyRadius = fr(this.scale.x * this.Q.mCircleShadowSize);
        if (this.actorType === T.NPC_BOARD) {
            this.onLiveFlag(LF.UNK2000 | LF.UNK10 | LF.UNK8);
            this.initNpcObjCollision(info.hit);
            this.spine!.initWith(N.waitMarioApproach);
            this.turnSpeed = 0;
            this.initNpcLight();
            return;
        }
        this.onLiveFlag(LF_N.UNK1000000); this.onLiveFlag(LF.AIRBORNE); this.onLiveFlag(LF.UNK1000);
        if (this.world.map !== 8 || (this.name !== 'モンテ26' && this.name !== 'モンテ27')) this.onLiveFlag(LF.UNK2000);
        if (this.actorType === T.NPC_MONTE_ME) this.onLiveFlag(LF.UNK10 | LF.UNK8);
        if (this.isJellyFishMare() || this.isSunflower() || this.actorType === T.NPC_MONTE_MF) this.onLiveFlag(LF.UNK10);
        if (this.isPollutionNpc()) {
            let c = SINK_COUNTER.get(this.world);
            if (!c) { c = { n: 0 }; SINK_COUNTER.set(this.world, c); }
            const f = palFrame(30);
            this.sink = new NpcSink(c.n, f);
            c.n += 1; if (c.n >= f) c.n = 0;
        }
        this.unk22C = new NpcTimer(this.P);
        if (this.tracer.graph && this.tracer.graph.isDummy()) this.spine!.initWith(N.waitMarioApproach);
        else {
            this.spine!.initWith(N.graphWander);
            this.tracer.reset();
            this.goToShortestNextGraphNode();
        }
        this.initNpcObjCollision(info.hit);
        if (this.mactor) this.neckJoint = this.mactor.jointIndex('kubi');
        this.inbetween = new NpcInbetween(palFrame(this.P.mPosInbetweenFrame), palFrame(this.P.mMotionBlendFrame));
        const anm = NPC_ANM[k];
        this.lodAnm = new LodAnm(this, anm.index, 0, this.Q.mLodChangeDist);
        this.initNpcLight();
    }
    private initNpcLight() {
        if (this.checkLiveFlag(LF.UNK10)) {
            const [h, d] = this.world.checkGroundIgnoreWaterSurface(this.pos.x, fr(this.pos.y + 10), this.pos.z);
            this.groundHeight = h; this.groundPlane = d;
        }
    }
    /** initNpcObjCollision_ */
    private initNpcObjCollision(hit: number[]) {
        let filter = HC.NPC, max = 2;
        if (this.is(T.NPC_MONTE_ME, T.NPC_SUNFLOWER_L, T.NPC_SUNFLOWER_S, T.NPC_BOARD)) { max = 0; filter = 0; }
        this.initHitActor(this.actorType, max, filter, fr(hit[0] * this.scale.x), fr(hit[1] * this.scale.y), fr(hit[2] * this.scale.x), fr(hit[3] * this.scale.y));
        this.offHitFilter(HF.NO_COLLISION);
        if (max === 0) this.onHitFilter(HF.NO_ATTACK);
    }
    /** setIndividualDifference_: its colours, parts, action, whether it throws Mario, its coin */
    private setIndividualDifference(s: Stream) {
        const c0 = [s.s32(), s.s32(), s.s32()], c1 = [s.s32(), s.s32(), s.s32()];
        if (this.isPollutionNpc()) {
            this.pollution = fr(c0[2] * fr(1 / 255));
            this.unk174[3] = Math.trunc(fr(this.pollution * this.Q.mPollutionMax)) & 0xFF;
        }
        let parts = s.s32();
        this.unk16C = s.s32();
        let thr = s.s32();
        const a0 = s.s32(), a4 = s.s32();
        let coin = s.u32() | 0;
        if (parts < 0) parts = 0;
        if (thr < 0) thr = 0;
        if (this.actorType === T.NPC_PEACH) {
            parts |= 0x6;
            if (parts & 0x10) { parts |= 0x60; this.peachParasolIn(); } else parts &= ~0x60;
        }
        // (sunflowers down while MSF_SUNFLOWERS_LEFT_TO_RESCUE: Pinna Park's; not simulated)
        this.look = { c0, c1, parts };
        const anm = NPC_ANM[this.kindIndex];
        if (anm.btp && this.lodAnm) this.lodAnm.indBtp = anm.btp;
        this.initBaseActionFlag();
        this.initIndividualAnm();
        if (thr & 1) this.throwCtrl = new NpcThrow(fr(a0), fr(a4));
        const burning = this.isNormalMonteM() && this.checkActionFlag(NA.BURNING);
        let b3 = true;
        if (coin === 2000 || coin === 200 || (coin >= 0 && coin < 50)) {
            // (a blue coin already got: TFlagManager's blue coin flags; none in the sim yet)
            const got = false;
            if (burning && got) { b3 = false; this.offActionFlag(NA.BURNING | NA.UNK80 | NA.RUN); }
            else { if (got) coin = 2000; this.coin = new NpcCoin(this, coin); }
        }
        void b3;
        this.npcWaitIn();
        this.randomizeBckAndBtpFrame();
        // (parts > 0: a TNpcParts; a jellyfish Mare's addJellyFishParts picks its jellyfish model
        // with MsRandF() * gpMareJellyFishManager's model count: the viewer's, but the roll is the game's)
        if (parts > 0 && this.isJellyFishMare()) MsRandF();
    }
    private initBaseActionFlag() {
        const pick = (t: number[]) => { if (this.unk16C > t.length - 1) this.unk16C = 0; this.actionFlag = t[this.unk16C]; };
        if (this.isMonte()) {
            pick(MONTE_ACTIONS);
            if (this.checkActionFlag(NA.UNK400)) this.lodAnm.indBck = [[14, 16], [-1, -1]];
        } else if (this.isMare()) pick(MARE_ACTIONS);
        else if (this.is(T.NPC_KINOPIO, T.NPC_KINOJII)) {
            pick(KINO_ACTIONS);
            if (this.checkActionFlag(NA.UNK100)) {
                if (this.actorType === T.NPC_KINOPIO) { this.lodAnm.indBck = [[15, 16], [6, 7], [4, 5], [14, 24], [9, 11], [19, 20], [-1, -1]]; this.lodAnm.indBtp = [[1, 2], [0, 5], [-1, -1]]; }
                else { this.lodAnm.indBck = [[11, 12], [2, 3], [10, 17], [5, 7], [13, 14], [-1, -1]]; this.lodAnm.indBtp = [[1, 2], [0, 5], [-1, -1]]; }
            }
        } else { this.unk16C = 0; this.actionFlag = 0; }
    }
    private initIndividualAnm() {
        switch (this.actorType) {
            case T.NPC_RACCOON_DOG:
                if (this.name === 'マニ屋親タヌキ') { this.onActionFlag(NA.UNK800); this.lodAnm.indBck = [[0, 1], [-1, -1]]; }
                else if (this.name === 'マニ屋子タヌキ') { this.onActionFlag(NA.UNK800); this.onLiveFlag(LF_N.DONT_TALK); this.lodAnm.indBck = [[0, 2], [-1, -1]]; }
                break;
            case T.NPC_MARE_MA:
                switch (Math.trunc(fr(MsRandF() * 3))) {
                    case 0: this.lodAnm.indBck = [[0, 3], [-1, -1]]; this.lodAnm.indBtp = [[2, 3], [-1, -1]]; break;
                    case 1: this.lodAnm.indBck = [[0, 4], [-1, -1]]; this.lodAnm.indBtp = [[2, 0], [-1, -1]]; break;
                }
                break;
            case T.NPC_MARE_WA:
                // (the game's table has no terminator: the next one in memory ends it)
                if (Math.trunc(fr(MsRandF() * 2)) === 0) this.lodAnm.indBck = [[0, 3], [-1, -1]];
                break;
        }
    }

    // ------------------------------------------------------------ animations (NpcAnm.cpp)
    isNowMotionBlend() { return this.inbetween.isMotionBlending() || this.inbetween.isForcedBlendRatio(); }
    setNpcAnm(k: number, blend: boolean) {
        if (this.actorType < 0x400001E && this.actorType >= T.NPC_DUMMY) return;
        this.keepAnm!.reset();
        if (k === this.lodAnm.cur) return;
        if (!this.lodAnm.setBckAndBtpAnm(k)) return;
        if (k === NK.HAPPY && this.unk1D9 <= 2) this.emitHappyEffect();
        // (the sunflowers' BRK and the parts' own animations: the viewer's)
        if (blend) this.inbetween.startMotionBlend(); else this.inbetween.stopMotionBlend();
    }
    requestNpcAnm(k: number, blend: boolean) {
        if (this.actorType < 0x400001E && this.actorType >= T.NPC_DUMMY) return;
        if (this.inbetween.isMotionBlending()) {
            if (k === this.lodAnm.cur) this.keepAnm!.reset(); else this.keepAnm!.keep(k, blend);
        } else this.setNpcAnm(k, blend);
    }
    private setKeepAnm() {
        const K = this.keepAnm!, k = K.kind, b = K.blend;
        K.reset();
        if (k !== NK.INVALID) { if (k === this.lodAnm.cur) K.reset(); else this.setNpcAnm(k, b); }
    }
    requestTalkAnm() {
        const k = this.checkActionFlag(NA.UNK400) ? NK.UNK1 : this.checkActionFlag(NA.UNK1) && !this.checkActionFlag(NA.DANCE) ? NK.UNK13 : NK.UNK6;
        this.requestNpcAnm(k, true);
    }
    randomizeBckAndBtpFrame() {
        const a = this.mactor!;
        let end = 0, fb = 0;
        const bc = a.getFrameCtrl(ANM_BCK);
        // (the game checks only that the frame controls exist, not that an animation is set)
        if (bc) { end = s16(bc.end); fb = s16(fr(end * MsRandF())); bc.frame = fb; }
        const tc = a.getFrameCtrl(ANM_BTP);
        if (tc) { const te = s16(tc.end); tc.frame = te === end ? fb : s16(fr(te * MsRandF())); }
    }
    private walkAnmRateChange() {
        const d = fr(Math.sqrt(fr(fr(this.posDelta.x * this.posDelta.x) + fr(this.posDelta.z * this.posDelta.z))));
        const a = this.mactor!, cur = this.lodAnm.cur;
        if (d < fr(0.001)) {
            if (cur === NK.WALK || cur === NK.RUN) {
                const n = palFrame(this.P.mStopWalkAnmRateFrame);
                const [v, more] = chaseDecreaseT(this.unk1D0, 0, this.P.mStopWalkAnmRateChase, fr(0.001));
                this.unk1D0 = v;
                if (this.unk1CC < n) this.unk1CC += 1;
                if (this.unk1CC >= n || !more) {
                    this.unk1CC = 0; this.unk1D0 = 0;
                    if (!this.isNowMotionBlend()) this.npcWaitIn();
                    else if (!this.inbetween.isMotionBlending()) a.setFrameRate(this.unk1D0, ANM_BCK);
                } else a.setFrameRate(this.unk1D0, ANM_BCK);
            } else this.npcWaitIn();
        } else {
            this.unk1CC = 0;
            if (cur === NK.WALK || cur === NK.RUN) {
                const Q = this.Q, rate = 2;
                const lo = fr(Q.mSLMinWalkAnmRate * rate);
                let hi: number, top: number;
                if (cur === NK.RUN) {
                    hi = fr(Q.mSLMaxRunAnmRate * rate); top = Q.mSLMaxRunSpeed;
                    if (this.checkActionFlag(NA.BURNING)) { const m = this.P.mSLSmokeRunMagnif; hi = fr(hi * m); top = fr(top * m); }
                } else { hi = fr(Q.mSLMaxWalkAnmRate * rate); top = Q.mMaxMarchSpeed; }
                const v = d > top ? top : d;
                const t = MsClamp(fr(fr(v - Q.mSLMinMarchSpeed) / fr(top - Q.mSLMinMarchSpeed)), 0, 1);
                let r = fr(lo + fr(t * fr(hi - lo)));
                if (this.collisions.length !== 0) r = hi;
                this.unk1D0 = chaseDecreaseT(this.unk1D0, r, this.P.mMoveWalkAnmRateChase, 0)[0];
                a.setFrameRate(this.unk1D0, ANM_BCK);
            } else {
                this.unk1D0 = 0;
                this.requestNpcAnm(this.checkActionFlag(NA.RUN) ? NK.RUN : NK.WALK, true);
            }
        }
    }
    private getNpcWaitAnmBase() {
        let k = NK.UNK1;
        if (this.walkForbid === 0) {
            if (this.checkActionFlag(NA.UNK2)) k = NK.UNKC;
            else if (this.checkActionFlag(NA.UNK10)) k = NK.UNK15;
            else if (this.checkActionFlag(NA.UNK20)) k = NK.UNK6;
            else if (this.checkActionFlag(NA.UNK40)) k = NK.UNK17;
            else if (this.checkActionFlag(NA.DANCE)) k = NK.DANCE;
        }
        return k;
    }
    private resetToWait() { this.marchSpeed = 0; this.turnSpeed = this.Q.mWaitTurnSpeed; this.unk1CC = 0; this.unk1D0 = 0; }
    private resetToTurn() { this.resetToWait(); if (this.unk22C) this.unk22C.unk0 = 0; }
    npcWaitIn() {
        let k = NK.UNK1;
        if (!this.checkActionFlag(NA.UNK400)) {
            if (!this.isClean()) k = NK.DIRTY;
            else if (this.checkActionFlag(NA.HAPPY)) k = NK.HAPPY;
            else if (this.checkActionFlag(NA.UNK1) && !this.checkActionFlag(NA.DANCE)) k = this.checkActionFlag(NA.UNK20) ? NK.UNK13 : NK.UNK12;
            else if (this.tracer.graph && !this.tracer.graph.isDummy()) {
                if (this.latest() === N.graphWait && !directorIsThing(this.world)) k = this.getNpcWaitAnmBase();
            } else k = this.getNpcWaitAnmBase();
        }
        this.requestNpcAnm(k, true);
        this.resetToWait();
    }
    npcFallIn() { this.requestNpcAnm(NK.UNK2, true); this.resetToWait(); }
    npcRecoverFromSinking() {
        const a = this.mactor!;
        if (!this.checkLiveFlag(LF_N.UNK8000000) && a.checkBckPass(32)) {
            this.onLiveFlag(LF_N.UNK8000000);
            this.vel.y = calcJumpVelocityY(fr(fr(this.unk1C4 - this.pos.y) + 150), this.getGravityY());
            if (this.vel.y < 5) this.vel.y = 5;
        }
        if (a.isCurAnmAlreadyEnd(ANM_BCK)) {
            this.offLiveFlag(LF.AIRBORNE);
            this.vel.set(0, 0, 0);
            this.pos.y = this.unk1C4;
            this.offLiveFlag(LF.UNK10 | LF_N.UNK400000 | LF_N.UNK8000000);
            return true;
        }
        if (this.checkLiveFlag(LF_N.UNK8000000)) {
            this.vel.y = fr(this.vel.y - this.getGravityY());
            if (this.vel.y < -40) this.vel.y = -40;
            this.pos.y = fr(this.pos.y + this.vel.y);
            if (this.vel.y <= 0 && this.pos.y < this.unk1C4) this.pos.y = this.unk1C4;
        }
        return false;
    }
    npcRecoverAfterIn() { this.requestNpcAnm(NK.UNK3, true); this.resetToWait(); }
    npcStepIn() { this.requestNpcAnm(NK.UNK4, true); this.resetToWait(); }
    npcTalkIn() {
        this.onLiveFlag(LF_N.UNK80000);
        if (!this.is(T.NPC_DUMMY, T.NPC_BOARD) && !this.isSunflowerReviving()) {
            if (this.isPeachTired()) this.requestNpcAnm(NK.UNK1A, true); else this.requestTalkAnm();
        }
        this.resetToWait();
    }
    npcTalking() {
        if (this.isSunflowerReviving()) { this.sunflowerReviving(); return; }
        if (this.isTurnToMarioWhenTalk()) {
            this.rot.y = SMS_GoRotate(this.pos, this.world.mario.pos, this.turnSpeed, this.rot.y);
            if (this.tracer.graph && !this.tracer.graph.isDummy()) this.unk1DA |= 1;
        }
        if (this.isPeachTired() && this.lodAnm.cur === NK.UNK1A && this.mactor!.isCurAnmAlreadyEnd(ANM_BCK)) this.peachTiredOut();
    }
    npcTalkOut() {
        this.talkForbid = 60;
        if (this.checkLiveFlag(LF_N.UNK80000)) {
            this.walkForbid = 120;
            if (this.isPeachTired()) this.peachTiredOut();
            if (this.checkActionFlag(NA.HAPPY)) {
                this.offActionFlag(NA.HAPPY);
                if (this.coin) { this.coin.requestAppearCoin(this.getCursorPos(), this.rot.y, 40); this.talkForbid = 360; this.walkForbid = 360; }
            }
            this.offLiveFlag(LF_N.UNK80000);
            this.changeNerveFromTalk();
            if (!this.throwCtrl && this.actorType === T.NPC_MONTE_ME) this.requestNpcAnm(NK.UNK4, true);
        }
    }
    npcTakenIn() { this.requestNpcAnm(NK.TAKEN, true); this.resetToWait(); }
    npcDanceIn() { this.onActionFlag(NA.DANCE); this.requestNpcAnm(NK.DANCE, true); this.resetToWait(); }
    npcHappyIn(k: number) { this.unk1D9 = k; this.onActionFlag(NA.HAPPY); this.requestNpcAnm(NK.HAPPY, true); this.resetToWait(); }
    npcWetIn() {
        if (!this.isSunflowerReviving()) {
            let k = NK.UNK5, blend = true;
            if (!this.isClean()) k = NK.WASH;
            else if (this.checkActionFlag(NA.UNK1)) { k = NK.UNK14; if (this.isNormalMonte()) blend = false; }
            else if (this.isNormalMonte() || this.actorType === T.NPC_MONTE_WC) {
                if (!this.checkLiveFlag(LF_N.UNK4000000) && MsRandF() < 0.5) k = NK.UNKB;
                else blend = false;
            } else if (this.isNormalMare() || this.actorType === T.NPC_MARE_MC) { if (MsRandF() < 0.5) k = NK.UNKB; }
            else if (this.actorType < T.NPC_PEACH && this.actorType >= T.NPC_KINOPIO) { if (!this.checkLiveFlag(LF_N.UNK4000000) && MsRandF() < 0.5) k = NK.UNKB; }
            this.requestNpcAnm(k, blend);
        }
        this.resetToTurn();
    }
    npcWetting() {
        const a = this.mactor!, cur = () => this.lodAnm.cur, end = () => a.isCurAnmAlreadyEnd(ANM_BCK);
        if (this.unk1DA & 2) { this.unk1DA &= ~2; this.npcHappyIn(0); this.npcWetOut(); return true; }
        if (cur() === NK.WASH) {
            if (this.isClean()) { this.npcHappyIn(0); this.npcWetOut(); return true; }
            if (end()) { this.npcWetOut(); return true; }
            return false;
        }
        if (this.isNormalMare() || this.actorType === T.NPC_MARE_MC) {
            switch (cur()) {
                case NK.UNK5: case NK.UNKB: case NK.UNK14:
                    if (end()) {
                        this.unk22C!.doThing3(240, 480);
                        if (this.unk22C!.doThing2()) this.requestNpcAnm(MsRandF() < 0.5 ? NK.UNK1B : NK.UNK7, false);
                    }
                    break;
                case NK.UNK7: case NK.UNK1B: if (end()) { this.npcWetOut(); return true; } break;
            }
            return false;
        }
        if (this.isMonte() && this.isMadNpc() && this.actorType !== T.NPC_MONTE_ME) {
            switch (cur()) {
                case NK.UNK5: case NK.UNK14:
                    if (end()) { if (this.isStateGoToMad()) this.npcMadIn(); else { this.npcWetOut(); return true; } }
                    break;
                case NK.UNK4: if (this.checkLiveFlag(LF_N.UNK2000000)) this.npcMadding(); break;
                case NK.MAD: case NK.UNKB:
                    if (this.checkLiveFlag(LF_N.UNK2000000)) { if (this.npcMadding()) { this.npcWetOut(); return true; } }
                    else if (end()) { this.npcWetOut(); return true; }
                    break;
            }
            return false;
        }
        if (this.isSunflowerReviving()) { if (this.sunflowerReviving()) { this.npcWetOut(); return true; } return false; }
        if (this.is(T.NPC_KINOPIO, T.NPC_KINOJII)) {
            if (end()) switch (cur()) {
                case NK.UNK5: this.requestNpcAnm(NK.UNK7, false); break;
                case NK.UNKB: this.requestNpcAnm(NK.MAD, true); break;
                case NK.UNK14: this.requestNpcAnm(NK.UNK18, true); break;
                case NK.UNK7: case NK.MAD: case NK.UNK18: this.npcWetOut(); return true;
            }
            return false;
        }
        if (end()) switch (cur()) { case NK.UNK5: case NK.UNKB: case NK.UNK14: case NK.WASH: this.npcWetOut(); return true; }
        return false;
    }
    npcWetOut() {
        this.offLiveFlag(LF_N.UNK2000000); this.offLiveFlag(LF_N.UNK4000000);
        if (this.top() === N.talk) this.requestTalkAnm();
        else if (this.actorType === T.NPC_MONTE_ME) this.requestNpcAnm(NK.UNK4, true);
    }
    npcSinking() {
        const target = fr(this.unk1C4 - this.Q.mSinkHeight);
        if (this.pos.y !== target) {
            const sp = this.Q.mSinkSpeed;
            if (this.isPollutionNpc()) this.pollution = chaseFrameF(this.pollution, 1, fr(fr(1 / sp) * fr(this.pos.y - target)));
            const [v, more] = chaseSpeedF(this.pos.y, target, sp);
            this.pos.y = v;
            if (!more) { this.onLiveFlag(LF_N.SINK_BOTTOM); this.onHitFilter(HF.NO_COLLISION); this.requestNpcAnm(NK.UNK10, true); }
        }
    }
    npcThrowIn() { this.requestNpcAnm(NK.THROW, true); this.resetToWait(); }
    npcThrowing() {
        const start = this.P.mSLThrowStartFrame, t = this.spine!.time;
        if ((t === 0 && start < 20) || t === start - 20) { this.onHitFilter(HF.NO_COLLISION); this.unk1DC = palFrame(30); }
        else if (t === start) this.throwCtrl!.throwMario(this);
        else if (this.mactor!.isCurAnmAlreadyEnd(ANM_BCK)) return true;
        return false;
    }
    npcMadIn() {
        this.onLiveFlag(LF_N.UNK2000000);
        if (this.actorType === T.NPC_MONTE_MF || this.checkActionFlag(NA.UNK1)) { this.requestNpcAnm(NK.MAD, true); return; }
        this.npcStepIn();
    }
    npcMadding() {
        if (!this.checkLiveFlag(LF_N.UNK2000000)) return true;
        switch (this.lodAnm.cur) {
            case NK.UNK4: {
                this.rot.y = SMS_GoRotate(this.pos, this.world.mario.pos, this.Q.mMadTurnSpeed, this.rot.y);
                if (this.facesMario() < fr(0.001)) this.requestNpcAnm(NK.MAD, false);
                if (this.tracer.graph && !this.tracer.graph.isDummy()) this.unk1DA |= 1;
                break;
            }
            case NK.MAD: case NK.UNKB:
                if (this.mactor!.isCurAnmAlreadyEnd(ANM_BCK)) { this.offLiveFlag(LF_N.UNK2000000); return true; }
                break;
        }
        return false;
    }
    /** MsWrap(|rot.y - the angle to Mario|, 0, 360) */
    facesMario() { return MsWrap(Math.abs(fr(this.rot.y - MsGetRotFromZaxisY(V3.sub(this.world.mario.pos, this.pos)))), 0, 360); }
    npcBlownIn() { this.requestNpcAnm(NK.UNKE, true); this.resetToTurn(); }
    npcBlowning() { return !this.isAirborne(); }
    npcMareStandIn() {
        if (this.lodAnm.cur === NK.UNKE || this.lodAnm.cur === NK.UNK5) this.unk22C!.doThing3(240, 360);
        else this.requestNpcAnm(NK.UNK7, true);
        this.resetToWait();
    }
    npcMareStanding() {
        switch (this.lodAnm.cur) {
            case NK.UNK5: case NK.UNKE: if (this.mactor!.isCurAnmAlreadyEnd(ANM_BCK) && this.unk22C!.doThing2()) this.requestNpcAnm(NK.UNK7, false); return false;
            case NK.UNK7: return this.mactor!.isCurAnmAlreadyEnd(ANM_BCK);
            default: return true;
        }
    }
    peachParasolIn() { this.unk1D8 |= 1; if (this.lodAnm) { this.lodAnm.indBck = [[21, 16], [22, 18], [-1, -1]]; this.lodAnm.indBtp = [[4, 2], [-1, -1]]; } }
    peachParasolOut() { if (!(this.unk1D8 & 1)) return; this.unk1D8 &= ~1; this.lodAnm.indBck = null; this.lodAnm.indBtp = null; }
    peachTiredIn() { if (this.unk1D8 & 2) return; this.unk1D8 |= 2; this.requestNpcAnm(NK.UNK10, true); }
    peachTiredOut() {
        if (!(this.unk1D8 & 2)) return;
        this.unk1D8 &= ~2; this.unk1D8 |= 4;
        this.lodAnm.indBck = [[21, 0], [-1, -1]]; this.lodAnm.indBtp = [[5, 0], [-1, -1]];
        this.requestNpcAnm(NK.UNK6, false);
    }
    sunflowerReviving() {
        if ((this.unk1D8 & 2) && this.lodAnm.cur === NK.UNK1A && this.mactor!.isCurAnmAlreadyEnd(ANM_BCK)) {
            this.unk1D8 &= ~2;
            if (this.checkLiveFlag(LF_N.UNK80000)) this.requestTalkAnm(); else this.npcWaitIn();
            return true;
        }
        return false;
    }
    monteMESetAnmWhenFar() {
        const a = this.mactor!;
        switch (this.lodAnm.cur) {
            case NK.UNK1: break;
            case NK.UNK2: if (a.isCurAnmAlreadyEnd(ANM_BCK)) this.requestNpcAnm(NK.UNK1, false); break;
            case NK.UNK3: if (a.isCurAnmAlreadyEnd(ANM_BCK)) this.requestNpcAnm(NK.UNK2, false); break;
            default: this.requestNpcAnm(NK.UNK2, true); break;
        }
    }
    monteMESetAnmWhenNear() {
        const a = this.mactor!;
        switch (this.lodAnm.cur) {
            case NK.UNK4: break;
            case NK.UNK3: case NK.MAD: if (a.isCurAnmAlreadyEnd(ANM_BCK)) this.requestNpcAnm(NK.UNK4, false); break;
            case NK.UNK2: if (a.isCurAnmAlreadyEnd(ANM_BCK)) this.requestNpcAnm(NK.UNK3, false); break;
            default: this.requestNpcAnm(NK.UNK3, false); break;
        }
    }
    private emitHappyEffect() { this.world.effect('npcHappy', this.pos); }

    // ------------------------------------------------------------ walking (NpcWalkTurn.cpp)
    isCanWalk() { return !(V3.sub(this.goal.point(), this.pos).squared() < 100); }
    execWalk(wander: boolean) {
        if (this.walkForbid !== 0 || directorIsThing(this.world) || !this.isClean() || this.checkActionFlag(NA.HAPPY)) { this.marchSpeed = 0; this.turnSpeed = 0; return; }
        if (wander && (this.unk1DA & 1)) {
            const sp = this.checkActionFlag(NA.RUN) ? 6 : 4;
            this.rot.y = SMS_GoRotate(this.pos, this.goal.point(), sp, this.rot.y);
            const ang = MsGetRotFromZaxisY(V3.sub(this.goal.point(), this.pos));
            if (MsWrap(Math.abs(fr(this.rot.y - ang)), 0, 360) < fr(0.001)) this.unk1DA &= ~1;
            return;
        }
        const Q = this.Q;
        if (wander) {
            let top = Q.mSLMinMarchSpeed, acc = Q.mMarchAccel;
            switch (this.lodAnm.cur) {
                case NK.WALK: top = Q.mMaxMarchSpeed; break;
                case NK.RUN:
                    top = Q.mSLMaxRunSpeed; acc = Q.mSLRunAccel;
                    if (this.checkActionFlag(NA.BURNING)) { const m = this.P.mSLSmokeRunMagnif; top = fr(top * m); acc = fr(acc * m); }
                    break;
            }
            this.marchSpeed = chaseSpeedF(this.marchSpeed, top, acc)[0];
        } else this.marchSpeed = chaseSpeedF(this.marchSpeed, 0, Q.mMarchDecrease)[0];
        this.turnSpeed = this.marchSpeed < fr(0.001) ? Q.mWaitTurnSpeed : Q.mWalkTurnSpeed;
        if (this.isCanWalk()) this.walkToCurPathNode(this.marchSpeed, this.turnSpeed, 0);
    }
    execUTurn() {
        let target = MsGetRotFromZaxis(V3.sub(this.goal.point(), this.pos)).y;
        if (this.rot.y === target) return true;
        if (!this.isClean() || this.checkActionFlag(NA.HAPPY)) return false;
        target = MsWrap(target, 0, 360);
        this.rot.y = MsWrap(this.rot.y, 0, 360);
        if (this.checkLiveFlag(LF_N.UNK200000)) { if (this.rot.y > target) this.rot.y = fr(this.rot.y - 360); }
        else if (this.rot.y < target) this.rot.y = fr(this.rot.y + 360);
        const [v, more] = chaseSpeedF(this.rot.y, target, this.Q.mUTurnSpeed);
        this.rot.y = MsWrap(v, 0, 360);
        return !more;
    }
    execTurnToFirstState() {
        if (this.rot.y === this.unk1A0.y) return true;
        const a = CLBDegToShortAngle(this.rot.y), b = CLBDegToShortAngle(this.unk1A0.y), c = CLBDegToShortAngle(this.Q.mFirstStateTurnSpeed);
        const [v, more] = chaseSpeedS(a, b, c);
        if (!more) { this.rot.y = this.unk1A0.y; return true; }
        this.rot.y = fr(v * fr(360 / 65536));
        return false;
    }
    isNeedTurnToFirstState() {
        if (!this.isClean() || this.checkActionFlag(NA.HAPPY)) return false;
        if (this.is(T.NPC_DUMMY, T.NPC_BOARD, T.NPC_MONTE_MG)) return false;
        const n = this.latest();
        return (n === N.waitMarioApproach || n === N.turnToMario) && (this.actorType === T.NPC_MONTE_ME || !this.checkActionFlag(NA.UNK800 | NA.UNK400 | NA.UNK1));
    }
    isTurnToMarioWhenTalk() {
        if (this.is(T.NPC_MONTE_MF, T.NPC_MONTE_MG, T.NPC_SUNFLOWER_L, T.NPC_SUNFLOWER_S, T.NPC_BOARD)) return false;
        return !this.checkActionFlag(NA.UNK800 | NA.UNK400 | NA.UNK1);
    }
    isTurnToMarioWhenApproach() {
        if (!this.isClean() || this.checkActionFlag(NA.HAPPY)) return false;
        if (this.is(T.NPC_KINOPIO, T.NPC_KINOJII, T.NPC_PEACH)) return !this.checkActionFlag(0x7FFF & ~NA.UNK80 & ~NA.UNK100);
        return false;
    }

    // ------------------------------------------------------------ changes (NpcChange.cpp)
    private changeNerveFromTalk() {
        const sp = this.spine!, cur = sp.current, top = this.top();
        if (cur === N.wet) sp.skip();
        else if (!cur && top === N.talk) sp.skip();
        sp.setNext(null);
        if (this.throwCtrl) {
            if (this.checkLiveFlag(LF_N.DONT_THROW)) this.offLiveFlag(LF_N.DONT_THROW);
            else sp.setNext(N.throw);
        }
        this.offLiveFlag(LF_N.UNK2000000);
    }
    private changeNerveToMad() { const sp = this.spine!; if (sp.current === N.wet) sp.setNext(N.mad); else sp.pushNerve(N.mad); }
    private releaseTaken() {
        const sp = this.P.mThrowSpeedXZ, a = CLBDegToShortAngle(this.unk158!.rot.y);
        this.vel.set(fr(sp * JMASSin(a)), this.P.mThrowSpeedY, fr(sp * JMASCos(a)));
        this.onLiveFlag(LF_N.UNK10000000);
        this.unk1DC = palFrame(15);
        this.unk158 = null;
        if (this.actorType === T.NPC_PEACH) this.peachTiredIn();
        this.spine!.setNext(N.waitMarioApproach);
    }
    private behaveToBeTaken(by: HitActor) {
        BaseNPC.mAngleYDiffWhenTaken = s16(CLBDegToShortAngle(by.rot.y) - CLBDegToShortAngle(this.rot.y));
        this.inbetween.startPosBlend();
        this.onHitFilter(HF.NO_COLLISION);
        this.offLiveFlag(LF.UNK10 | LF_N.UNK20000 | LF_N.UNK400000);
        if (this.actorType === T.NPC_PEACH) this.peachParasolOut();
        this.spine!.setNext(N.waitContinue);
        this.holder = by as TakeActor; this.unk158 = by as TakeActor;
    }
    private behaveToBeTrampled() {
        const child = this.isChild();
        let se: number = SE.NPC_COMMON_PRESS;
        if (this.isMonteM()) se = child ? SE.NPC_VAS_CMONTM_PRESS : SE.NPC_VAS_MONTEM_PRESS;
        else if (this.isMonteW()) se = child ? SE.NPC_VAS_CMONTW_PRESS : SE.NPC_VAS_MONTEW_PRESS;
        else if (this.isMareM()) se = child ? SE.NPC_VAS_CMAREM_PRESS : this.is(T.NPC_MARE_MB, T.NPC_MARE_MC) ? SE.NPC_VAS_MAREJ_PRESS : SE.NPC_VAS_MAREM_PRESS;
        else if (this.isMareW()) se = child ? SE.NPC_VAS_CMAREW_PRESS : SE.NPC_VAS_MAREW_PRESS;
        else if (this.actorType === T.NPC_KINOPIO) se = SE.NPC_VAS_KINOPI_PRESS;
        else if (this.actorType === T.NPC_KINOJII) se = SE.NPC_VAS_KINOJI_PRESS;
        this.world.sound(se, this.pos);
        this.trample!.startTrample();
        if (!this.isMare() || !this.isBehaveToWaterNpc() || this.checkActionFlag(NA.BURNING | NA.HAPPY)) return;
        const sp = this.spine!;
        switch (this.lodAnm.cur) {
            case NK.UNK1B: case NK.UNK7:
                if (sp.current === N.wet) { sp.pushNerve(N.wet); sp.setNext(null); }
                else if (!sp.current && this.latest() === N.wet) sp.setNext(N.wet);
                break;
            default: if (this.isNerveCanGoToWet()) sp.pushNerve(N.wet); break;
        }
    }
    private behaveToHitObject(by: HitActor, kind: number) {
        const w = this.world, sp = this.spine!;
        if (this.checkActionFlag(NA.BURNING)) {
            if (kind !== 0 || talkOrDemo(w)) return;
            w.effect('enemyWaterHit', by.pos);
            w.sound(SE.EN_COMMON_W_HIT_OK, this.pos);
            w.sound(SE.NPC_FIRE_FIGHTING, this.pos);
            this.burnStrength = fr(this.burnStrength - this.P.mSLFireDecSpeed);
            if (this.burnStrength > 0) return;
            this.burnStrength = 0;
            this.offActionFlag(NA.BURNING | NA.UNK80 | NA.RUN);
            this.npcHappyIn(1);
            return;
        }
        if (kind === 0 && !talkOrDemo(w) && this.isPollutionNpc() && sp.current === N.wet && this.pollution > 0) {
            this.pollution = fr(this.pollution - this.Q.mPollutionCleanSpeed);
            if (this.pollution <= 0) { this.pollution = 0; this.talkForbid = 60; this.unk1DA |= 2; }
        }
        if (this.checkActionFlag(NA.UNK400 | NA.HAPPY)) return;
        if (this.isNerveCanGoToWet() && !this.checkActionFlag(NA.UNK800) && !this.isPeachTired() && !this.isSunflowerReviving()
            && (this.isClean() || kind !== 1)
            && (this.actorType !== T.NPC_MONTE_ME || this.lodAnm.cur === NK.UNK4 || this.lodAnm.cur === NK.UNK6)
            && (sp.current !== N.talk || sp.time >= 4)) {
            if (kind === 1) this.onLiveFlag(LF_N.UNK4000000);
            sp.pushNerve(N.wet);
        }
    }
    private behaveToSandBomb(_a: LiveActor) {
        // SMS_GetSandRiseUpRatio (Sirena's sand bomb bases): not ported
        this.unk1C8 = 0;
    }
    private changeNerveProc() {
        const sp = this.spine!, latest = this.latest(), w = this.world;
        let talking = false;
        if (latest === N.talk) { talking = true; this.onLiveFlag(LF_N.UNK20000); this.offLiveFlag(LF_N.UNK40000); }
        else if (this.isTalkable()) {
            this.onLiveFlag(LF_N.UNK20000);
            if (this.checkLiveFlag(LF_N.UNK40000)) {
                talking = true;
                this.offLiveFlag(LF_N.UNK40000);
                const cur = sp.current;
                if (cur === N.wet || cur === N.recoverAfter || cur === N.mad) sp.setNext(N.talk); else sp.pushNerve(N.talk);
                this.offLiveFlag(LF_N.UNK2000000);
            }
        } else { this.offLiveFlag(LF_N.UNK20000); this.offLiveFlag(LF_N.UNK40000); }
        if (talking || !this.isPollutionNpc() || this.checkActionFlag(NA.BURNING | NA.UNK400 | NA.HAPPY) || !this.sink || latest === N.setPosAfterSinkBottom) return;
        if (!this.sink.doThing()) return;
        this.sink.unk0 = 0;
        const P = w.pollution;
        if (latest === N.sink) {
            if (P && P.isPolluted(this.pos.x, this.unk1C4, this.pos.z)) return;
            sp.setNext(N.recoverFromSink);
            this.offHitFilter(HF.NO_COLLISION);
            this.offLiveFlag(LF_N.SINK_BOTTOM);
            this.requestNpcAnm(NK.UNK1A, true);
            w.sound(SE.NPC_APPEAR, this.pos);
            return;
        }
        if (this.checkLiveFlag(LF_N.UNK400000) || this.isAirborne()) return;
        if (!P || !P.isPolluted(this.pos.x, this.pos.y, this.pos.z)) return;
        if (this.isNerveCanGoToSink()) {
            this.unk1C4 = this.pos.y;
            this.vel.set(0, 0, 0);
            this.offLiveFlag(LF_N.UNK20000 | LF_N.UNK8000000);
            this.onLiveFlag(LF_N.UNK400000 | LF.UNK10);
            this.npcFallIn();
            sp.pushNerve(N.sink);
        }
    }
    setPosAndInitAfterSinkBottom() {
        const p = this.unk194.clone(), P = this.world.pollution, sp = this.spine!;
        const polluted = !!P && P.isPolluted(p.x, p.y, p.z);
        this.offLiveFlag(LF.DEAD | LF.HIDDEN | LF.CLIPPED_OUT | LF.UNK8 | LF.UNK10 | LF_N.UNK20000 | LF_N.UNK40000 | LF_N.UNK400000 | LF_N.SINK_BOTTOM | LF_N.UNK2000000 | LF_N.UNK8000000);
        this.onLiveFlag(LF_N.UNK1000000);
        this.held = null; this.holder = null;
        if (this.sink) this.sink.unk0 = 0;
        this.resetHitPoints();
        sp.reset();
        this.inbetween.reset();
        this.keepAnm!.reset();
        this.unk1CC = 0; this.unk1D0 = 0;
        if (polluted && this.isPollutionNpc() && !this.checkActionFlag(NA.UNK400)) {
            this.onHitFilter(HF.NO_COLLISION);
            sp.setDefaultNext();
            sp.pushNerve(N.sink); sp.pushNerve(N.sink);
            this.onLiveFlag(LF.UNK10 | LF_N.UNK400000 | LF_N.SINK_BOTTOM);
            const [h, d] = this.world.checkGroundIgnoreWaterSurface(p.x, fr(p.y + this.getHeadHeight()), p.z);
            this.groundHeight = h; this.groundPlane = d; this.unk1C4 = h;
            p.y = fr(this.unk1C4 - this.Q.mSinkHeight);
            this.vel.set(0, 0, 0);
        } else {
            this.offHitFilter(HF.NO_COLLISION);
            sp.setDefaultNext();
            sp.pushNerve(sp.default);
            p.y = fr(p.y + 2);
            this.vel.set(0, 5, 0);
            this.onLiveFlag(LF.UNK8000); this.onLiveFlag(LF.AIRBORNE);
        }
        this.pos.set(p); this.rot.set(this.unk1A0); this.posDelta.set(0, 0, 0);
        this.tracer.reset(); this.tracer.reset2();
        this.goToShortestNextGraphNode();
        this.npcWaitIn();
        this.randomizeBckAndBtpFrame();
    }
    /** isTalkable_ (the talk itself needs TMarDirector's talk mode: see the file's comment) */
    private isTalkable() {
        if (this.checkLiveFlag(LF_N.UNK40000)) return true;
        if (this.talkForbid !== 0 || this.isJellyFishMare() || this.holder) return false;
        if (this.checkLiveFlag(LF.DEAD | LF.HIDDEN | LF.CLIPPED_OUT | LF.UNK200 | LF_N.DONT_TALK | LF_N.SINK_BOTTOM | LF_N.UNK400000)) return false;
        if (this.checkActionFlag(NA.BURNING) || !this.isClean() || this.isSunflowerReviving() || !this.isNerveCanGoToTalk()) return false;
        if (this.actorType === T.NPC_MONTE_ME && this.lodAnm.cur !== NK.UNK4) return false;
        const P = this.P, m = this.world.mario.pos;
        let dist: number, height: number;
        if (this.throwCtrl) { dist = P.mSLThrowTalkAcceptDist; height = P.mSLThrowTalkAcceptHeight; }
        else { dist = this.actorType === T.NPC_SUNFLOWER_L ? P.mSLSunflowerLTalkDist : P.mTalkAcceptDist; height = P.mTalkAcceptHeight; }
        const deg = this.checkActionFlag(NA.UNK400 | NA.UNK1) || this.isSunflower() || this.actorType === T.NPC_BOARD ? P.mSLSitTalkAcceptDegree : P.mTalkAcceptDegree;
        const myaw = fr(s16((this.world.mario as any).mFaceAngle ? (this.world.mario as any).mFaceAngle.y : CLBDegToShortAngle(this.world.mario.rot.y)) * fr(360 / 65536));
        return Math.abs(fr(m.y - this.pos.y)) < height && this.isInSight(m, dist, deg, -1) && MsIsInSight(m, myaw, this.pos, dist, P.mSLMarioTalkAcceptDegree, 0);
    }

    // ------------------------------------------------------------ messages, movement (NpcBase.cpp)
    receiveMessage(sender: HitActor, msg: number) {
        if (this.actorType === T.NPC_DUMMY) return false;
        if (msg === MSG.TAKE && this.checkLiveFlag(LF_N.UNK100000) && !this.holder) { this.behaveToBeTaken(sender); return true; }
        if (msg === MSG.TRAMPLE) { this.behaveToBeTrampled(); return true; }
        if (msg === MSG.SPRAYED_BY_WATER) { if (this.isBehaveToWaterNpc()) this.behaveToHitObject(sender, 0); return true; }
        if (msg === MSG.UNK10 || (msg === MSG.ATTACK && sender.isActorType(AT.WOOD_BARREL))) {
            if (this.damageParticleForbid === 0) { this.world.effect('ms_dmg_a', sender.pos); this.damageParticleForbid = 16; }
            if (this.isBehaveToHitNpc()) this.behaveToHitObject(sender, msg === MSG.UNK10 ? 1 : 2);
            return true;
        }
        return false;
    }
    private updateForbidCount() {
        if (this.talkForbid !== 0) this.talkForbid -= 1;
        if (this.walkForbid !== 0) this.walkForbid -= 1;
        if (this.damageParticleForbid !== 0) this.damageParticleForbid -= 1;
    }
    moveObject() {
        if (this.checkLiveFlag(LF.DEAD)) return;
        this.ensureTakeSituation();
        if (this.unk158 && this.unk158.held !== this) this.releaseTaken();
        if (this.trample) {
            const [done, y] = this.trample.updateTrample(this.initScale.y, this.scale.y);
            this.scale.y = y;
            if (done && this.isNerveCanGoToMad() && this.isStateGoToMad()) this.changeNerveToMad();
        }
        this.inbetween.applyPos(this.pos);
        if (this.coin) this.coin.updateCoin();
        this.updateForbidCount();
        this.updateSquareToMario();
        this.posDelta.zero(); this.rotDelta.zero();
        const ga = this.groundPlane && this.groundPlane.actor;
        if (ga && ga.isActorType && ga.isActorType(AT.SAND_BOMB_BASE00)) { this.headHeight = this.P.mSLHeadHeightSandBomb; this.behaveToSandBomb(ga); }
        else { this.headHeight = this.P.mSLHeadHeightNormal; this.unk1C8 = 0; }
        this.control();
        if (!this.checkLiveFlag(LF_N.UNK400000)) this.calcRideMomentum();
        if (this.latest() !== N.setPosAfterSinkBottom) {
            this.execNpcObjCollision();
            if (!this.checkLiveFlag(LF.UNK10)) this.bind();
            if (this.holder) {
                const m = this.holder.getTakingMtx();
                if (m) this.pos.set(m[3], m[7], m[11]);
                this.rot.y = fr(s16(CLBDegToShortAngle(this.holder.rot.y) - BaseNPC.mAngleYDiffWhenTaken) * fr(360 / 65536));
            } else {
                if (!this.checkLiveFlag(LF.UNK10) && this.isNerveWalk() && !this.belongToGround() && this.posDelta.y > 5) this.posDelta.y = 5;
                this.pos.add(this.posDelta);
                this.rot.add(this.rotDelta);
            }
            this.calcRidePos();
        }
    }
    /** execNpcObjCollision_: pushed out of other NPCs (a walking one pushes the one it walks into) */
    private execNpcObjCollision() {
        for (const c of this.collisions) {
            let push: boolean;
            if (this.isNerveWalk()) push = false;
            else {
                if (!c.isHitCategory(HC.NPC)) continue;
                if (!(c as BaseNPC).isNerveWalk || !(c as BaseNPC).isNerveWalk()) continue;
                push = true;
            }
            const d = new V3(fr(this.pos.x - c.pos.x), 0, fr(this.pos.z - c.pos.z));
            if (push) { d.x = -d.x; d.z = -d.z; }
            if (d.squared() <= 1.1920929e-7) {
                const dy = fr(this.pos.y - c.pos.y);
                if (Math.abs(dy) < fr(0.001)) d.set(1, 10, 0); else d.set(0, dy, 0);
            } else {
                const mag = fr(Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z));
                let k = fr(fr(this.attackRadius + c.damageRadius) - mag);
                if (k < 0) k = -k;
                if (k < fr(0.001)) k = fr(0.001);
                const l = Math.sqrt(d.squared());
                d.x = fr(d.x * fr(k / l)); d.y = fr(d.y * fr(k / l)); d.z = fr(d.z * fr(k / l));
            }
            if (push) c.pos.add(d); else this.posDelta.add(d);
        }
    }
    private setVariableDamageRadius() {
        const info = NPC_INIT[this.kindIndex]!;
        const base = fr(info.hit[2] * this.scale.x);
        let r = base;
        const m = this.world.mario.pos;
        if (this.isBeTrampledNpc() && !marioTouchGround4cm(this.world) && m.y > this.pos.y) {
            const dx = fr(m.x - this.pos.x), dz = fr(m.z - this.pos.z), b3 = fr(base * 3);
            if (dx * dx + dz * dz < b3 * b3) r = this.Q.mSLDamageRadiusSmall;
        }
        this.damageRadius = r;
        this.calcEntryRadius();
    }
    bind() {
        const next = this.pos.clone().add(this.posDelta).add(this.vel);
        this.vel.y = fr(this.vel.y - this.getGravityY());
        if (this.vel.y < -40) this.vel.y = -40;
        const [h, d] = this.world.checkGroundIgnoreWaterSurface(next.x, fr(next.y + this.headHeight), next.z);
        this.groundPlane = d; this.groundHeight = fr(h + 1);
        if (next.y <= fr(this.groundHeight + 0.05)) {
            if (d && d.isLegal()) { this.offLiveFlag(LF.AIRBORNE); this.vel.set(0, 0, 0); next.y = this.groundHeight; }
        } else this.onLiveFlag(LF.AIRBORNE);
        if (this.checkLiveFlag(LF_N.UNK10000000)) this.world.isTouchedOneWallAndMoveXZ(next, fr(next.y + this.headHeight), 150);
        this.posDelta.set(V3.sub(next, this.pos));
    }
    /** movement_ (the director's last tick of the frame: TGraphics::unk0 & 2) */
    private movement() {
        this.moveObject();
        if ((this.world.tickCount & 3) !== 0) return;
        this.changeNerveProc();
        if (!this.holder) {
            if (this.isNerveWalk()) this.walkAnmRateChange();
            if (this.lodAnm.cur === NK.UNK4) {
                const Q = this.Q, rate = 2;
                this.mactor!.setFrameRate(MsClamp(fr(fr(this.turnSpeed * Q.mTurnAnmRate) * rate), fr(Q.mTurnAnmMinRate * rate), fr(Q.mTurnAnmMaxRate * rate)), ANM_BCK);
            }
        }
        this.inbetween.execPosInbetween(this.pos);
        if (this.unk1DC > 0) {
            this.unk1DC -= 1;
            if (this.unk1DC === 0 && !this.holder) { this.offHitFilter(HF.NO_COLLISION); this.offLiveFlag(LF_N.UNK10000000); }
        }
        if (!this.isJellyFishMare() && this.actorType !== T.NPC_MONTE_MF) this.setVariableDamageRadius();
        if (this.isPollutionNpc()) this.unk174[3] = Math.trunc(fr(this.pollution * this.Q.mPollutionMax)) & 0xFF;
    }
    private movementOnlyTalk() {
        if (this.checkLiveFlag(LF.DEAD)) return;
        this.updateForbidCount();
        this.updateSquareToMario();
        this.control();
        if ((this.world.tickCount & 3) === 0) this.changeNerveProc();
    }
    private execMotionBlend() {
        if (!this.inbetween.isMotionBlending()) this.setKeepAnm();
        this.inbetween.execMotionBlend();
        if (this.inbetween.isForcedBlendRatio()) this.keepAnm!.reset();
    }
    calcRootMatrix() {
        if (this.actorType === T.NPC_BOARD) { this.calcRootMatrixBasic(); return; }
        this.execMotionBlend();
        this.calcRootMatrixBasic();
        if (this.holder) { const m = this.holder.getTakingMtx(); if (m) this.baseTR.set(m); }
    }
    /** checkAnmOff_: whether its animation stands still this frame (out of view, or a far-off waiting one) */
    private checkAnmOff() {
        let off = false;
        const a = this.mactor!;
        const hidden = this.checkLiveFlag(LF.HIDDEN | LF.CLIPPED_OUT | LF.DEAD), fresh = this.checkLiveFlag(LF_N.UNK1000000);
        if (hidden) { off = true; this.execMotionBlend(); a.frameUpdate(); }
        else if (!this.holder && !this.isAirborne() && !this.belongToGround() && (this.isNerveMaybeDontCalcAnim0() || this.isNerveMaybeDontCalcAnim1())) {
            const d = this.getAnmOffDist(), cam = this.world.clipCamera;
            const e = cam ? cam.pos : null;
            if (e) {
                const dx = this.pos.x - e[0], dy = this.pos.y - e[1], dz = this.pos.z - e[2];
                if (dx * dx + dy * dy + dz * dz > d * d && !fresh && this.spine!.time > 2) { off = true; this.execMotionBlend(); }
            }
        }
        return off;
    }
    private getAnmOffDist() {
        const P = this.P, Q = this.Q, k = this.lodAnm.cur;
        let d = 300000;
        const dance = this.checkActionFlag(NA.HAPPY | NA.DANCE) || this.actorType === 0x400000D || k === NK.MAD || k === NK.UNK17;
        if (this.isNerveMaybeDontCalcAnim0()) { d = Q.mWaitAnmOffDist0; if (dance) d = Math.max(P.mSLDanceAnmOffDist, d); }
        else if (this.isNerveMaybeDontCalcAnim1()) { d = Q.mWaitAnmOffDist1; if (dance) d = Math.max(P.mSLDanceAnmOffDist, d); }
        return d;
    }
    perform(cue: number) {
        const w = this.world;
        if (this.actorType === T.NPC_DUMMY) {
            if (!(cue & CUE_MOVE)) return;
            if (this.dummyConnect) { this.pos.set(this.dummyConnect.pos); this.rot.set(this.dummyConnect.rot); }
            this.movementOnlyTalk();
            return;
        }
        if (this.actorType === T.NPC_BOARD) {
            if (this.checkLiveFlag(LF.UNK200 | LF.DEAD)) return;
            if (cue & CUE_MOVE) this.movementOnlyTalk();
            this.performOnlyDraw(cue);
            return;
        }
        let run = true;
        if (this.checkLiveFlag(LF.DEAD) || this.checkLiveFlag(LF.UNK200)) run = false;
        else if ((cue & (CUE_CALC_VIEW | CUE_ENTRY)) && this.checkLiveFlag(LF.CLIPPED_OUT | LF.HIDDEN)) run = false;
        else if ((cue & CUE_MOVE) && !this.holder && !this.isAirborne() && !this.belongToGround() && this.spine!.time !== 0
            && this.actorType !== T.NPC_PEACH && this.isNerveMaybeDontMovement() && !this.checkLiveFlag(LF_N.SINK_BOTTOM)) {
            // standing still out of the camera's sight: it doesn't move at all
            const M = this.manager as NPCManagerLike | null;
            const far = M && M.farClip !== undefined ? M.farClip : condParams(w).mEnemyFarClip;   // (gpConductor's mEnemyFarClip without a manager)
            const cam = w.clipCamera;
            if (cam) {
                // the angle from gpCamera's eye (unk124) to its target (unk148): the view's forward
                const e = new V3(cam.pos[0], cam.pos[1], cam.pos[2]), [qx, qy, qz, qw] = cam.quat;
                const fx = -2 * (qx * qz + qw * qy), fz = -(1 - 2 * (qx * qx + qy * qy));
                const yaw = fr(s16(matan(fz, fx)) * fr(360 / 65536));
                if (!MsIsInSight(e, yaw, this.pos, fr(far + 500), 120, 800)) { this.updateSquareToMario(); run = false; }
            }
        }
        if (!run) { this.offLiveFlag(LF_N.UNK20000 | LF_N.UNK40000); return; }
        if (cue & CUE_MOVE) { this.movement(); cue &= ~CUE_MOVE; }
        if ((cue & CUE_CALC_ANIM) && this.checkAnmOff()) cue &= ~CUE_CALC_ANIM;
        if (cue & CUE_ENTRY) this.offLiveFlag(LF_N.UNK1000000);
        super.perform(cue);
    }
    kill() { }
    /** (perform skips the entry of one the manager clipped out, so the game doesn't draw it; one never in view has no root matrix yet) */
    drawn() { return super.drawn() && this.actorType !== T.NPC_DUMMY && !this.checkLiveFlag(LF.CLIPPED_OUT); }
}

/** What perform reads off the NPC's manager (TNPCManager::unk58: the stage's far clip) */
interface NPCManagerLike { farClip?: number; }

// ---------------------------------------------------------------- helpers
/** CLBChaseDecrease (f32): [value, more to go] */
function chaseDecreaseT(v: number, d: number, ratio: number, threshold: number): [number, boolean] {
    if (ratio > 1) ratio = 1;
    v = fr(ratio * fr(d - v) + v);
    return [v, !(Math.abs(fr(v - d)) <= Math.abs(threshold))];
}
/** CalcJumpVelocityY (NpcAnm.cpp) */
function calcJumpVelocityY(height: number, g: number) {
    if (g <= 0) return 0;
    return fr(fr(g * 0.5) * fr(fr(Math.sqrt(fr(fr(fr(height * fr(1 / g)) * 8) + 1))) + 1));
}
/** SMS_GoRotate (MarioUtil/MathUtil.cpp): turns *rot (degrees) towards the target by at most speed degrees */
export function SMS_GoRotate(from: V3, to: V3, speed: number, rot: number) {
    const a = matan(fr(to.z - from.z), fr(to.x - from.x));
    const sp = s16(Math.trunc(fr(speed * fr(65536 / 360))));
    const d = IConverge(s16(a - Math.trunc(fr(rot * fr(65536 / 360)))), 0, sp, sp);
    return fr(s16(a - d) * fr(360 / 65536));
}

// ---------------------------------------------------------------- the nerves (NpcNerve.cpp)
type S = Spine<BaseNPC>;
const n = (name: string, f: (sp: S, self: BaseNPC) => boolean) => nerve<BaseNPC>(name, (sp: S) => f(sp, sp.body));
export const N: Record<string, Nerve<BaseNPC>> = {};
N.graphWander = n('TNerveNPCGraphWander', (sp, self) => {
    if (sp.time === 0) self.unk22C!.doThing();
    self.execWalk(true);
    const g = self.goal.point();
    const dx = fr(g.x - self.pos.x), dz = fr(g.z - self.pos.z), d2 = fr(fr(dx * dx) + fr(dz * dz));
    if (self.goalStack.length) { if (d2 < 10000 && self.goalStack.length) self.goal = self.goalStack.pop()!; return false; }
    const t = self.tracer, gr = t.graph!;
    let one = false, flat = false;
    if (t.cur >= 0 && gr.nodes[t.cur].conns.length === 1) { one = true; if (t.unk10 === 0) flat = true; }
    const timeUp = self.unk22C!.doThing2();
    if ((one && d2 < 2500) || (!one && d2 < 10000)) {
        if (!self.checkActionFlag(NA.UNK80) && timeUp) { sp.pushAfterCurrent(N.graphWait); return true; }
        self.goToShortestNextGraphNode();
        if (one) { sp.pushAfterCurrent(N.uTurn); if (flat) self.onLiveFlag(LF_N.UNK200000); return true; }
    }
    return false;
});
N.uTurn = n('TNerveNPCUTurn', (sp, self) => {
    if (self.execUTurn()) { self.marchSpeed = 0; self.offLiveFlag(LF_N.UNK200000); sp.pushAfterCurrent(N.graphWander); return true; }
    return false;
});
N.graphWait = n('TNerveNPCGraphWait', (sp, self) => {
    if (sp.time === 0) self.unk22C!.startGraphWait();
    if (self.marchSpeed < fr(0.001)) { if (self.unk22C!.doThing2()) { sp.pushAfterCurrent(N.graphWander); return true; } }
    else self.execWalk(false);
    return false;
});
N.waitContinue = n('TNerveNPCWaitContinue', (sp, self) => {
    if (sp.time === 0) { if (self.holder) self.npcTakenIn(); else self.npcWaitIn(); }
    return false;
});
N.waitMarioApproach = n('TNerveNPCWaitMarioApproach', (sp, self) => {
    if (self.isInBodyTurnSearchRange() && self.isClean()) { sp.pushAfterCurrent(N.turnToMario); return true; }
    const t = self.actorType;
    if ((t - T.NPC_DUMMY) >>> 0 > 1 && !self.isPeachTired()) {
        if (self.isSunflowerReviving()) self.sunflowerReviving();
        else if (t === T.NPC_MONTE_ME) { self.monteMESetAnmWhenFar(); self.execTurnToFirstState(); }
        else if (self.isNeedTurnToFirstState()) { if (self.execTurnToFirstState()) self.npcWaitIn(); else self.npcStepIn(); }
        else if (sp.time === 0) self.npcWaitIn();
    }
    return false;
});
N.turnToMario = n('TNerveNPCTurnToMario', (sp, self) => {
    if (!self.isInBodyTurnSearchRange() || self.pollution !== 0) { sp.pushAfterCurrent(N.waitMarioApproach); return true; }
    const t = self.actorType;
    if ((t - T.NPC_DUMMY) >>> 0 > 1 && !self.isPeachTired()) {
        if (self.isSunflowerReviving()) self.sunflowerReviving();
        else if (t === T.NPC_MONTE_ME) { self.monteMESetAnmWhenNear(); self.execTurnToFirstState(); }
        else if (self.isTurnToMarioWhenApproach()) {
            self.rot.y = SMS_GoRotate(self.pos, self.world.mario.pos, self.turnSpeed, self.rot.y);
            if (self.facesMario() < fr(0.001)) self.npcWaitIn(); else self.npcStepIn();
        } else if (self.isNeedTurnToFirstState()) { if (self.execTurnToFirstState()) self.npcWaitIn(); else self.npcStepIn(); }
        else if (sp.time === 0) self.npcWaitIn();
    }
    return false;
});
N.wet = n('TNerveNPCWet', (sp, self) => { if (sp.time === 0) self.npcWetIn(); return self.npcWetting(); });
N.sink = n('TNerveNPCSink', (_sp, self) => { self.npcSinking(); return false; });
N.recoverFromSink = n('TNerveNPCRecoverFromSink', (sp, self) => { if (self.npcRecoverFromSinking()) { sp.pushAfterCurrent(N.recoverAfter); return true; } return false; });
N.recoverAfter = n('TNerveNPCRecoverAfter', (sp, self) => {
    if (sp.time === 0) self.npcRecoverAfterIn();
    return self.lodAnm.cur === NK.UNK3 && self.mactor!.isCurAnmAlreadyEnd(ANM_BCK);
});
N.setPosAfterSinkBottom = n('TNerveNPCSetPosAfterSinkBottom', (_sp, self) => { self.setPosAndInitAfterSinkBottom(); return true; });
N.talk = n('TNerveNPCTalk', (sp, self) => {
    if (directorIsThing(self.world)) { if (sp.time === 0) self.npcTalkIn(); self.npcTalking(); }
    else { if (self.actorType === T.NPC_DUMMY) return true; self.npcTalkOut(); }
    return false;
});
N.throw = n('TNerveNPCThrow', (sp, self) => { if (sp.time === 0) self.npcThrowIn(); return self.npcThrowing(); });
N.mad = n('TNerveNPCMad', (sp, self) => { if (sp.time === 0) self.npcMadIn(); return self.npcMadding(); });
N.blown = n('TNerveNPCBlown', (sp, self) => {
    if (sp.time === 0) self.npcBlownIn();
    if (self.npcBlowning()) { if (self.isNormalMare()) sp.pushAfterCurrent(N.mareStand); return true; }
    return false;
});
N.mareStand = n('TNerveNPCMareStand', (sp, self) => { if (sp.time === 0) self.npcMareStandIn(); return self.npcMareStanding(); });

export { marioGroundLevel };
