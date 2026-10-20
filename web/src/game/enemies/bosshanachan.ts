// TBossHanachan / TBossHanachanPartsHead / TBossHanachanPartsBody / TSphereLink / TBossHanachanManager
// (Enemy/BossHanachanMain.cpp, BossHanachanNerve.cpp, BossHanachanAnm.cpp, BossHanachanParts.cpp,
// BossHanachanSub.cpp, BossHanachanEffect.cpp, BossHanachanSave.cpp) and TSleepBossHanachan /
// TDemoBossHanachan (SleepBossHanachan.cpp, DemoBossHanachanBase.cpp): the giant Wiggler of
// Gelato Beach ("Wiggler Ahoy! Full Steam Ahead!", mamma2).
//
// The boss is its head (ボスハナチャンの頭, hanahead_model.bmd) and eight body segments
// (ボスハナチャンの体, hanabody_model.bmd) on a TSphereLink: the head walks the graph
// (TNerveBossHanachanGraphWander: accelerating to mSLMaxMarchSpeed, the BCK blending from walk
// to run), the segments follow as a chain 420 apart. Each segment leans (rotation z) with the
// centrifugal force of the turn, a wave equation along the body, and the slope it stands on: a
// sand bomb base (SAND_BOMB_BASE00 / SAND_LEAF_BASE00) under a segment pushes it over by its rise.
// Once a segment leans past mSLFallDecideRotateZ it tumbles (TNerveBossHanachanTumble: the sand
// pillar, all segments rolling to +-179) and lies on its back (Down) for mSLDownFrames; a ground
// pound on its weak segment (unk174, random; the one with the different BCKs) hurts it
// (execDamage -> Damage, onto the next graph bosshanachan1 / 2 and the next .prm), then it gets
// up (GetUp) and snorts (Snort) and walks on. Three hits: Dead, the collision removed, the boss
// Shine. While it walks every segment (and its feet) throws Mario (throwMario_); otherwise its
// segments are map collision Mario can stand on (TMapCollisionMove on joint "center").
// TSleepBossHanachan is the sleeping one of the earlier episode (demohanatyan_model.bmd), which
// startFall drops (TNerveSBH_Fall: its Shine once the fall BCK ends).
//
// For the viewer: the head and segments are world.extras (the boss's own MActor is the head's,
// so it is not drawn twice), each with its joints as the motion blend leaves them in `locals`
// (jointMatricesBlend between the BCK and the one before it: TNpcInbetween's ratio). The sand
// pillar (sunabashira.bmd) is an extra while UNK10000 is on.
//
// Not here: particles (emitParticle_'s MsRandF calls are kept for the RNG), the camera shake and
// rumble (emitCamShake_), the BGM (MSBgm start / stop / tempo / modBgm: the fade is taken as done),
// the target arrow, the circle shadows and damage fog, the manager's sand texture swap
// (loadAfter), the anm sounds, the mirror actor (寝てるボスハナチャンin鏡) and the
// MSF_WIGGLER_FALLING flag. The director's state 4 (the balloon timer) is taken as always on.

import { fr, V3, MsWrap, MsAngleDiff, MsAngleWrap, MsGetRotFromZaxisY, MsSin, MsCos, MsClamp, MsRandF, matan, JMASSin, JMASCos, s16, MsMtxSetXYZRPH } from '../math.js';
import { World, HitActor, LiveActor, SpineEnemy, EnemyManager, LiveManager, LF, HF, HC, MSG, nerve, Spine, Stream, Params, PSchema,
    ANM_BCK, ANM_BTP, ANM_BTK, ANM_BRK, ANM_FRAME_RATE, FC_ONCE, CUE_MOVE, CUE_CALC_ANIM, PathNode, FrameCtrl, MoveCollision } from '../engine.js';
import { AT } from '../actortypes.js';
import { Skeleton, parseBCK, jointMatricesBlend } from '../skeleton.js';
import { mapObjGlobals } from '../mapobj/base.js';
import { marioGroundPlane, marioTouchGround4cm } from '../mapobj/lib.js';
import type { ItemManager } from '../mapobj/item.js';
import type { BGCheckData } from '../collision.js';
import { NpcInbetween, palFrame } from '../npc/base.js';
import { calcRotateZXYTranslate, isLastTick } from './animal.js';
import { CLBDegToShortAngle, chaseSpeedF, chaseDecrease, chaseAngleDecrease, chaseFrameF, ratioF } from '../camera/lib.js';
import { SE } from '../sound.js';
import { register } from '../scene.js';
import type { mat4 } from 'gl-matrix';

/** TBossHanachanCommonSaveParams (/enemy/bosshanachanCommon.prm) */
const COMMON_PARAMS = {
    mSLViewClipFar: ['f', 25000], mSLViewClipRadius: ['f', 3500], mSLHeadHitOffsetY: ['f', 400], mSLHeadAttackRadius: ['f', 475], mSLHeadAttackHeight: ['f', 840],
    mSLHeadDamageRadius: ['f', 450], mSLHeadDamageHeight: ['f', 500], mSLBodyHitOffsetY: ['f', 200], mSLBodyAttackRadius: ['f', 325], mSLBodyAttackHeight: ['f', 515],
    mSLBodyDamageRadius: ['f', 300], mSLBodyDamageHeight: ['f', 300], mSLFootHitOffsetY: ['f', 75], mSLFootAttackRadius: ['f', 150], mSLFootAttackHeight: ['f', 200],
    mSLFootDamageRadius: ['f', 0], mSLFootDamageHeight: ['f', 0], mSLHeadLength: ['f', 470], mSLBodyLength: ['f', 420], mSLHeadShadowSize: ['f', 850],
    mSLBodyShadowSize: ['f', 525], mSLHeadPlusYByRotateZ: ['f', 6.5], mSLBodyPlusYByRotateZ: ['f', 3.5], mSLRecoverSearchDist: ['f', 1000], mSLRecoverSearchDegree: ['f', 90],
    mSLShineAppearOffsetY: ['f', 0], mSLCamShakeZeroDist: ['f', 4000], mSLCamShakeMaxDist: ['f', 500], mSLMotionBlendFrames: ['s16', 20],
} satisfies PSchema;
/** TBossHanachanChangeSaveParams (/enemy/bosshanachan0..2.prm: one per hit point lost) */
const CHANGE_PARAMS = {
    mSLWalkBckRateMagnif: ['f', 0.1], mSLWalkBckRateMin: ['f', 0.3], mSLWalkAnmMarchSpeed: ['f', 10], mSLRunAnmMarchSpeed: ['f', 24], mSLMaxMarchSpeed: ['f', 24],
    mSLMarchAccel: ['f', 0.02], mSLMarchDecrease: ['f', 0.05], mSLWalkTurnSpeed: ['f', 1], mSLFallDecideRotateZ: ['f', 90], mSLWaveFallDownSpeed: ['f', 1.1],
    mSLFallDecideMinSpeed: ['f', 1], mSLSandSlopeForce: ['f', 0.05], mSLMaxRotateZNotSand: ['f', 40], mSLRotateZLeanSpeed: ['f', 1], mSLRotateZRestorationSpeed: ['f', 0.3],
    mSLDiffMaxRotateZ: ['f', 60], mSLCentrifugalForce: ['f', 30], mSLCentrifugalSpeed: ['f', 1], mSLWaveVelocity: ['f', 200], mSLWaveDecrease: ['f', 100],
    mSLDownFrames: ['s16', 2000], mSLDamageFrames: ['s16', 500], mSLNotFallDownFrames: ['s16', 600], mSLNormalBckFrameDiff: ['u8', 10], mSLGetUpFrameDiff: ['u8', 17],
    mSLSnortFrameDiff: ['u8', 10], mSLDamageFrameDiff: ['u8', 10], mSLDeadFrameDiff: ['u8', 10], mSLParticleProbability: ['f', 0.2], mSLThrowTotalPower: ['f', 100],
    mSLThrowSpeedMin: ['f', 20], mSLThrowSpeedMax: ['f', 300], mSLThrowMoveDirPower: ['f', 20], mSLThrowVecY: ['f', 150],
} satisfies PSchema;
type CommonP = { [K in keyof typeof COMMON_PARAMS]: number };
type ChangeP = { [K in keyof typeof CHANGE_PARAMS]: number };
/** TDemoBossHanachanSaveParams (/enemy/sleepBossHanachan.prm) */
const DEMO_PARAMS = { mSLViewClipFar: ['f', 25000], mSLViewClipRadius: ['f', 3500] } satisfies PSchema;

const cHitPoint1_RailName = 'bosshanachan2', cHitPoint2_RailName = 'bosshanachan1';
const cBodyMapCollisionFileName = '/scene/bosshanachan/hanabody_col.col', cHeadMapCollisionFileName = '/scene/bosshanachan/hanahead_col.col';
const sEmitSandFrameFoot = [14, 34];

/** EnumBossHanachanAnmKind (names guessed from the BCKs they pick) */
const ANM = {
    WALK: 0, RUN: 1, UNK2: 2, UNK3: 3, UNK4: 4, TRAMPLED: 5, DAMAGE: 6, UNK7: 7, UNK8: 8, UNK9: 9, UNK10: 10, UNK11: 11, UNK12: 12, HIP_DROPPED: 13,
    SNORT: 14, DEAD: 15, TUMBLE_L: 16, TUMBLE_R: 17, NONE: 18,
};
/** EnumBossHanachanNerveAnm */
const NA = { TUMBLE: 0, DOWN: 1, GET_UP: 2, DAMAGE: 3, SNORT: 4, DEAD: 5 };
const sBodyBckIndex = [19, 15, 10, 13, 0, 12, 9, 2, 3, 4, 5, 6, 7, 8, 16, 1, 17, 18];
const sHeadBckIndex = [36, 32, 29, 31, 20, 30, 28, 22, 23, 24, 25, 26, 27, 28, 33, 21, 34, 35];
const sHeadBtpIndex = [0, 0, 1, 2, 1, 2, 2, 0, 0, 0, 0, 0, 0, 2, 0, 0, 1, 1];
const sHeadBtkIndex = [0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/** TMarDirector::isThing (the talk mode, as npc/base.ts takes it) */
const isThing = (w: World) => !!w.talkMode;
const absF = (v: number) => (v >= 0 ? v : -v);
const isComplete = (z: number) => z === -179 || z === 179;
const norm = (v: V3) => { const l = v.length(); if (l > 0) v.scale(1 / l); return v.fround(); };
const chase = (v: number, d: number, s: number) => chaseSpeedF(v, d, s)[0];
/** SMS_GetGroundActor */
function groundActor(p: BGCheckData | null, type: number): LiveActor | null {
    if (!p) return null;
    const a = p.actor as LiveActor | null;
    return a && a.actorType === (type | 0) ? a : null;
}
/** SMS_GetSandRiseUpRatio: the sand base's root joint's Y scale ([1][1]), clamped to 0..1 */
function sandRiseUpRatio(a: LiveActor) {
    let r = 1;
    const m = a.mactor ? a.mactor.anmMtx(0, a.baseTR, a.scale) : null;
    if (m) r = m[5];
    return r > 1 ? 1 : r < 0 ? 0 : r;
}
/** mat4 translation as a TVec3 */
const mtxPos = (m: mat4 | null, fallback: V3) => (m ? new V3(fr(m[12]), fr(m[13]), fr(m[14])) : fallback.clone());

// ---------------------------------------------------------------- BossHanachanSub.cpp
/** BHSCalcCentrifugalForce */
export function BHSCalcCentrifugalForce(head: V3, cur: V3, prev: V3, dir: number) {
    const ho = new V3(fr(head.x - cur.x), 0, fr(head.z - cur.z));
    const dsq = fr(ho.x * ho.x + ho.z * ho.z);
    if (dsq < 0.001) return 0;
    const po = new V3(fr(cur.x - prev.x), 0, fr(cur.z - prev.z));
    if (fr(po.x * po.x + po.z * po.z) < 0.001) return 0;
    const hd = CLBDegToShortAngle(MsGetRotFromZaxisY(ho)), pd = CLBDegToShortAngle(MsGetRotFromZaxisY(po));
    if (hd === pd) return 0;
    const diff = hd - pd;
    const ratio = fr((1 / 32768) * Math.abs(s16(diff)));
    if (ratio >= 0.5) return 0;
    let force = fr(dsq * ratio);
    if (diff < 0) force = -force;
    return fr(force * JMASCos(hd - CLBDegToShortAngle(dir)));
}
/** BHSCalcRevisionDistXZByRotateZ: [x, z] */
export function BHSCalcRevisionDistXZByRotateZ(dir: number, degZ: number, scale: number): [number, number] {
    const ox = fr(scale * degZ), oy = 0;
    const a = CLBDegToShortAngle(dir), s = JMASSin(a), c = JMASCos(a);
    return [fr(ox * c + oy * s), fr(-ox * s + oy * c)];
}

interface SpherePoint { prev: V3; pos: V3; vel: V3; len: number; degZ: number; }
/** TSphereLink: the chain of points the segments stand on */
export class SphereLink {
    pts: SpherePoint[] = [];
    constructor(public w: World, n: number, p: V3, len: number, public radius: number, public damp: number, public grav: number, public revisionScale: number, public initialDir: number) {
        const dx = fr(MsSin(initialDir) * len), dz = fr(MsCos(initialDir) * len);
        for (let i = 0; i < n; i++) {
            const q = i === 0 ? p.clone() : this.pts[i - 1].pos.clone();
            if (i > 0) { q.x = fr(q.x - dx); q.z = fr(q.z - dz); }
            this.pts.push({ prev: q.clone(), pos: q, vel: new V3(), len, degZ: 0 });
        }
    }
    /** execMapCollision_ */
    private col(p: V3) {
        this.w.isTouchedOneWallAndMoveXZ(p, p.y, this.radius);
        const [h, g] = this.w.checkGroundIgnoreWaterSurface(p.x, p.y + this.radius, p.z);
        if (!g || g.isIllegal()) return;
        if (p.y < h) p.y = fr(h);
    }
    moveHead(h: V3) {
        for (const p of this.pts) { p.pos.y = fr(p.pos.y + this.grav); p.pos.add(p.vel); }
        this.pts[0].pos.set(h);
        this.col(this.pts[0].pos);
        for (let i = 1; i < this.pts.length; i++) {
            const c = this.pts[i], pr = this.pts[i - 1];
            const o = V3.sub(c.pos, pr.pos);
            if (o.x === 0 && o.y === 0 && o.z === 0) o.set(0, 1, 0); else norm(o);
            o.scale(c.len);
            c.pos.set(V3.add(pr.pos, o));
            this.col(c.pos);
        }
        for (const p of this.pts) { p.vel.set(V3.sub(p.pos, p.prev).scale(this.damp)); p.prev.set(p.pos); }
    }
    setDegreeZAndRevisionPosXZ(i: number, degZ: number) {
        const p = this.pts[i], old = p.degZ;
        if (old === degZ) return false;
        p.degZ = degZ;
        const dir = i === 0 ? this.initialDir : MsWrap(MsGetRotFromZaxisY(V3.sub(this.pts[i - 1].pos, p.pos)), 0, 360);
        const [dx, dz] = BHSCalcRevisionDistXZByRotateZ(dir, fr(degZ - old), this.revisionScale);
        p.pos.x = fr(p.pos.x + dx); p.pos.z = fr(p.pos.z + dz);
        return true;
    }
}

/** TWaterHitActor: a hit volume that remembers being sprayed (60 ticks) */
export class WaterHitActor extends HitActor {
    waterHitCounter = 0;
    /** TFootHitActor::unk6C: the joint it sits on */
    joint = -1;
    constructor(public w: World, name: string) { super(name); }
    onWaterHitCounter() { this.waterHitCounter = 0x3C; }
    receiveMessage(_s: HitActor, msg: number) {
        if (msg !== MSG.SPRAYED_BY_WATER) return false;
        if (isThing(this.w)) this.waterHitCounter = 0; else this.onWaterHitCounter();
        return true;
    }
}

/** TMapCollisionMove with FLAG_NEEDS_SETUP: moveTrans only while set up (the move grid is refilled every tick) */
class PartCollision {
    mc: MoveCollision; setUp = false;
    constructor(w: World, path: string, owner: LiveActor) { this.mc = new MoveCollision(w, path, owner); }
    private put(p: V3) { this.mc.moveMat4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p.x, p.y, p.z, 1]); }
    setUpTrans(p: V3) { if (this.setUp) return; this.setUp = true; this.put(p); }
    remove() { this.setUp = false; }
    moveTrans(p: V3) { if (this.setUp) this.put(p); }
}

// ---------------------------------------------------------------- BossHanachanParts.cpp
/** TBossHanachanPartsBase */
export abstract class BHPartsBase extends LiveActor {
    curAnm = ANM.NONE; prevAnm = ANM.NONE;
    unk100: WaterHitActor | null = null;
    unk104: PartCollision | null = null;
    /** joint "center" (unk108) */
    centerJoint = -1;
    unk10C = 0;
    unk110: NpcInbetween;
    /** the BCK before the current one and its frame (MActor's TMotionBlendCtrl), and the frame the old one is drawn at */
    oldBck = -1; oldBckFrame = 0; oldAnmFrame = 0;
    joints: mat4[] | null = null; locals: mat4[] = [];
    constructor(public owner: BossHanachan, type: number, modelIndex: number, name: string) {
        super(owner.world, name);
        this.manager = owner.manager; this.mactor = this.createMActor(modelIndex); this.manager = null;
        this.initHitActor(type, 0, 0, 0, 0, 0, 0);
        this.onHitFilter(HF.NO_COLLISION);
        if (type === (AT.BOSS_UNK15 | 0)) this.scaledBodyRadius = owner.P.mSLBodyShadowSize;
        else if (type === (AT.BOSS_UNK14 | 0)) this.scaledBodyRadius = owner.P.mSLHeadShadowSize;
        this.onLiveFlag(LF.UNK8);
        this.offLiveFlag(LF.ENABLE_CLIPPING);
        this.unk110 = new NpcInbetween(1, palFrame(owner.P.mSLMotionBlendFrames));
    }
    abstract setAnm_(anm: number, blend: boolean): boolean;
    perform() { }
    drawn() { return !this.owner.checkLiveFlag(LF.DEAD | LF.UNK200); }
    get isBody() { return this.actorType === (AT.BOSS_UNK15 | 0); }
    sk() { const a = this.mactor; return a ? Skeleton.of(a.data.files.scene(a.model)) : null; }
    jointIdx(name: string) { const s = this.sk(); return s ? s.index(name) : -1; }
    jointPos(j: number) { return mtxPos(this.joints && j >= 0 ? this.joints[j] || null : null, this.pos); }
    center() { return this.jointPos(this.centerJoint); }
    /** MActor::setBckFromIndex, keeping the old BCK for the blend */
    setBck(i: number) {
        const a = this.mactor!, c = a.getFrameCtrl(ANM_BCK);
        this.oldBck = a.getCurAnmIdx(ANM_BCK); this.oldBckFrame = c ? c.frame : 0; this.oldAnmFrame = this.oldBckFrame;
        a.setBckFromIndex(i);
    }
    /** MActor::calc: the joints, blended toward the old BCK by the inbetween's ratio */
    calc() {
        const a = this.mactor, sk = this.sk();
        if (!a || !sk) return;
        const bck = (i: number) => { const e = a.data.anms[ANM_BCK][i]; return e ? parseBCK(a.data.files.scene(a.data.folder + '/' + e.name + '.bck')) : null; };
        const fc = a.getFrameCtrl(ANM_BCK), cur = a.getCurAnmIdx(ANM_BCK);
        const nw = cur >= 0 ? { anm: bck(cur), frame: fc ? fc.frame : 0 } : null;
        const r = this.unk110.ratio;
        const old = r > 0 && this.oldBck >= 0 ? { anm: bck(this.oldBck), frame: this.oldAnmFrame } : null;
        this.joints = jointMatricesBlend(sk, nw, old, old ? r : 0, false, this.baseTR, [this.scale.x, this.scale.y, this.scale.z], this.joints || [], this.locals);
    }
    /** TNpcInbetween::execMotionBlend (the old BCK's frame: one frame on from the current when the ratio is forced) */
    execMotionBlend() {
        const inb = this.unk110;
        if (inb.isForcedBlendRatio() && this.oldBck >= 0) {
            const c = this.mactor!.getFrameCtrl(ANM_BCK);
            if (c) { const k = new FrameCtrl(); Object.assign(k, c); k.update(); this.oldAnmFrame = k.frame; }
        } else if (inb.isMotionBlending()) this.oldAnmFrame = this.oldBckFrame;
        inb.execMotionBlend();
    }
    initMapCollisionAndHitActor_() {
        const P = this.owner.P;
        let file = cBodyMapCollisionFileName, ar = P.mSLBodyAttackRadius, ah = P.mSLBodyAttackHeight, dr = P.mSLBodyDamageRadius, dh = P.mSLBodyDamageHeight, oy = P.mSLBodyHitOffsetY;
        if (!this.isBody) { file = cHeadMapCollisionFileName; ar = P.mSLHeadAttackRadius; ah = P.mSLHeadAttackHeight; dr = P.mSLHeadDamageRadius; dh = P.mSLHeadDamageHeight; oy = P.mSLHeadHitOffsetY; }
        this.centerJoint = this.jointIdx('center');
        this.unk104 = new PartCollision(this.world, file, this);
        const h = this.unk100 = new WaterHitActor(this.world, 'ボスハナチャンのパーツ');
        h.initHitActor(this.actorType, 1, HC.PLAYER, ar, ah, dr, dh);
        this.world.addToGroup('敵グループ', h);
        h.offHitFilter(HF.NO_COLLISION);
        const c = this.center();
        h.pos.set(c.x, fr(c.y - oy), c.z);
    }
    offNonstopMotionBlend_() { this.unk110.forced = 0; }
    setNonstopMotionBlendRatio_(r: number) { this.unk110.forced = r; }
    restartBck_() { const c = this.mactor!.getFrameCtrl(ANM_BCK); if (c) c.frame = 0; }
    changeTumbleAnmRate_() {
        const c = this.mactor!.getFrameCtrl(ANM_BCK);
        if (!c) return;
        if (this.curAnm === ANM.TUMBLE_L || this.curAnm === ANM.TUMBLE_R) {
            if (!(c.frame <= 40)) c.rate = chaseFrameF(c.rate, ANM_FRAME_RATE, fr(c.end - c.frame));
        } else c.rate = ANM_FRAME_RATE;
    }
    moveMapCollision_() { this.unk104!.moveTrans(this.center()); }
    isCurBckAlreadyEnd_() {
        const c = this.mactor ? this.mactor.getFrameCtrl(ANM_BCK) : null;
        if (!c) return true;
        return (c.state & 1) !== 0 || (c.state & 2) !== 0 || c.frame + 0.1 >= c.end;
    }
    copyFrameFromOldAnmToNewAnm_() {
        const c = this.mactor!.getFrameCtrl(ANM_BCK);
        if (c && this.mactor!.getCurAnmIdx(ANM_BCK) >= 0) c.frame = this.oldBckFrame;
    }
    getSandActor_() { return groundActor(this.groundPlane, AT.SAND_BOMB_BASE00) || groundActor(this.groundPlane, AT.SAND_LEAF_BASE00); }
    isMarioOn_() {
        if (!marioTouchGround4cm(this.world)) return false;
        const p = marioGroundPlane(this.world);
        return !!p && p.actor === this;
    }
    calcRotateZWhenGetUp_() {
        if (this.unk10C !== 0) return;
        if (this.curAnm === ANM.UNK8 || this.curAnm === ANM.UNK11) {
            const c = this.mactor!.getFrameCtrl(ANM_BCK)!;
            const frames = fr(2 * fr(c.end - c.frame));
            this.rot.z = frames < 0.001 ? 0 : chaseFrameF(this.rot.z, 0, frames);
        }
    }
    isReactToTrampleOrHipDrop_() {
        const n = this.owner.spine!.getLatestNerve();
        if (n !== BHNerves.tumble && n !== BHNerves.down) return false;
        return this.isBody ? isComplete(this.rot.z) : true;
    }
    considerSetAnm_(na: number) {
        const A = ANM, cur = this.curAnm;
        const fallen = cur === A.TRAMPLED || cur === A.DAMAGE || cur === A.HIP_DROPPED || cur === A.TUMBLE_L || cur === A.TUMBLE_R;
        if (na === NA.TUMBLE) {
            if (fallen && this.isCurBckAlreadyEnd_()) this.setAnm_(A.UNK3, false);
        } else if (na === NA.DOWN) {
            const on = this.isMarioOn_();
            if (fallen) {
                if (this.isCurBckAlreadyEnd_()) {
                    if (this.isBody && on) this.setAnm_(A.UNK2, true);
                    else this.setAnm_(A.UNK3, false);
                }
            } else if (this.isBody && !(this.unk110.isMotionBlending() || this.unk110.isForcedBlendRatio())) {
                if (cur === A.UNK2) { if (!on) this.setAnm_(A.UNK3, true); }
                else if (on) this.setAnm_(A.UNK2, true);
            }
        } else if (na === NA.GET_UP) {
            if (this.unk10C > 0) this.unk10C--;
            if (this.unk10C === 0) {
                const ended = this.isCurBckAlreadyEnd_();
                switch (cur) {
                    case A.UNK7: if (ended) this.setAnm_(A.UNK8, false); break;
                    case A.UNK8: if (ended) this.setAnm_(A.UNK9, false); break;
                    case A.UNK10: if (ended) this.setAnm_(A.UNK11, false); break;
                    case A.UNK11: if (ended) this.setAnm_(A.UNK12, false); break;
                    case A.UNK9: case A.UNK12: break;
                    default: this.setAnm_(this.rot.z < 0 ? A.UNK7 : A.UNK10, true); break;
                }
            }
        } else if (na === NA.DAMAGE) {
            if (this.unk10C > 0) { this.unk10C--; if (this.unk10C === 0) this.setAnm_(A.DAMAGE, false); }
            else if (cur === A.DAMAGE && this.isCurBckAlreadyEnd_()) this.setAnm_(A.UNK4, false);
        } else if (na === NA.SNORT) {
            if (this.unk10C > 0) this.unk10C--;
            if (this.unk10C === 0 && cur !== A.SNORT) this.setAnm_(A.SNORT, true);
        } else if (na === NA.DEAD) {
            if (this.unk10C > 0) this.unk10C--;
            if (this.unk10C === 0) this.setAnm_(A.DEAD, false);
        }
    }
    protected startBlend(blend: boolean) { if (blend) this.unk110.startMotionBlend(); else this.unk110.stopMotionBlend(); }
}

/** TBossHanachanPartsBody (ボスハナチャンの体) */
export class BHPartsBody extends BHPartsBase {
    unk114 = 0;
    unk118: WaterHitActor[] = [];
    unk120 = 0; unk124 = new V3(); unk130 = new V3(); unk13C = 0; unk140 = 0; unk144 = 0; unk148 = 0;
    /** leg_L3 / leg_R3 (unk14C) */
    legJoints: number[];
    unk154 = new V3();
    constructor(owner: BossHanachan, name = 'ボスハナチャンの体') {
        super(owner, AT.BOSS_UNK15, 0, name);
        this.legJoints = [this.jointIdx('leg_L3'), this.jointIdx('leg_R3')];
    }
    initFootHitActor_() {
        const P = this.owner.P;
        for (const jn of ['foot_L', 'foot_R']) {
            const f = new WaterHitActor(this.world, 'ボスハナチャンの足');
            f.initHitActor(this.actorType, 1, HC.PLAYER, P.mSLFootAttackRadius, P.mSLFootAttackHeight, P.mSLFootDamageRadius, P.mSLFootDamageHeight);
            this.world.addToGroup('敵グループ', f);
            f.offHitFilter(HF.NO_COLLISION);
            f.joint = this.jointIdx(jn);
            f.pos.set(this.jointPos(f.joint));
            this.unk118.push(f);
        }
    }
    setAnm_(anm: number, blend: boolean) {
        let r = false;
        if (this.curAnm === anm) return r;
        this.prevAnm = this.curAnm; this.curAnm = anm;
        const a = this.mactor!;
        if (sBodyBckIndex[anm] !== a.getCurAnmIdx(ANM_BCK)) {
            let idx = sBodyBckIndex[anm];
            // (the weak segment's own lying BCKs)
            if (this.unk114 === this.owner.unk174) { if (anm === ANM.UNK2) idx = 11; else if (anm === ANM.UNK3) idx = 14; }
            this.setBck(idx);
            r = true;
            this.startBlend(blend);
        }
        if (anm === ANM.DEAD) { a.setFromIndex(ANM_BRK, 0); const c = a.getFrameCtrl(ANM_BRK); if (c) c.attr = FC_ONCE; }
        return r;
    }
    receiveMessage(_s: HitActor, msg: number) {
        if (isThing(this.world)) return false;
        if (!this.isReactToTrampleOrHipDrop_()) return false;
        if (msg === MSG.TRAMPLE) {
            if (this.curAnm === ANM.TRAMPLED) this.restartBck_(); else this.setAnm_(ANM.TRAMPLED, false);
            return true;
        }
        if (msg === MSG.HIP_DROP) {
            const weak = this.unk114 === this.owner.unk174;
            switch (this.curAnm) {
                case ANM.UNK2: case ANM.UNK3: case ANM.TRAMPLED: case ANM.HIP_DROPPED: case ANM.TUMBLE_L: case ANM.TUMBLE_R:
                    if (weak) { this.setAnm_(ANM.DAMAGE, false); this.owner.execDamage(); }
                    else if (this.curAnm === ANM.HIP_DROPPED) this.restartBck_();
                    else this.setAnm_(ANM.HIP_DROPPED, false);
                    return true;
            }
        }
        return false;
    }
}

/** TBossHanachanPartsHead (ボスハナチャンの頭) */
export class BHPartsHead extends BHPartsBase {
    /** L_hall / R_hall (unk114: the nostrils) */
    noseJoints: number[];
    constructor(owner: BossHanachan, name = 'ボスハナチャンの頭') {
        super(owner, AT.BOSS_UNK14, 1, name);
        this.noseJoints = [this.jointIdx('L_hall'), this.jointIdx('R_hall')];
    }
    setAnm_(anm: number, blend: boolean) {
        let r = false;
        if (this.curAnm === anm) return r;
        this.prevAnm = this.curAnm; this.curAnm = anm;
        const a = this.mactor!;
        if (sHeadBckIndex[anm] !== a.getCurAnmIdx(ANM_BCK)) { this.setBck(sHeadBckIndex[anm]); r = true; this.startBlend(blend); }
        if (sHeadBtpIndex[anm] !== a.getCurAnmIdx(ANM_BTP)) a.setFromIndex(ANM_BTP, sHeadBtpIndex[anm]);
        if (sHeadBtkIndex[anm] !== a.getCurAnmIdx(ANM_BTK)) a.setFromIndex(ANM_BTK, sHeadBtkIndex[anm]);
        if (anm === ANM.DEAD) { a.setFromIndex(ANM_BRK, 1); const c = a.getFrameCtrl(ANM_BRK); if (c) c.attr = FC_ONCE; }
        return r;
    }
    receiveMessage(_s: HitActor, msg: number) {
        if (isThing(this.world)) return false;
        if (!this.isReactToTrampleOrHipDrop_()) return false;
        if (msg === MSG.TRAMPLE) { if (this.curAnm === ANM.TRAMPLED) this.restartBck_(); else this.setAnm_(ANM.TRAMPLED, false); return true; }
        if (msg === MSG.HIP_DROP) { this.setAnm_(ANM.DAMAGE, false); this.unk100!.onWaterHitCounter(); return true; }
        return false;
    }
}

/** unk19C: the sand pillar a tumble throws up (sunabashira.bmd), shown while the boss has UNK10000 */
class BHSandPillar extends LiveActor {
    constructor(public owner: BossHanachan) {
        super(owner.world, 'sunabashira');
        this.manager = owner.manager; this.mactor = this.createMActorByName('sunabashira.bmd'); this.manager = null;
        this.offLiveFlag(LF.ENABLE_CLIPPING);
    }
    perform() { }
    drawn() { return this.owner.checkLiveFlag(LF.UNK10000) && !this.owner.checkLiveFlag(LF.DEAD); }
}

// ---------------------------------------------------------------- the manager and the boss
export class BossHanachanManager extends EnemyManager {
    unk54!: CommonP;
    unk58: ChangeP[] = [];
    constructor(w: World, name = '?') { super(w, name); }
    load(s: Stream) {
        this.unk54 = new Params('/enemy/bosshanachanCommon.prm', this.world.files).read(COMMON_PARAMS);
        for (const f of ['/enemy/bosshanachan0.prm', '/enemy/bosshanachan1.prm', '/enemy/bosshanachan2.prm']) this.unk58.push(new Params(f, this.world.files).read(CHANGE_PARAMS));
        super.load(s);
    }
    createModelData() { this.createModelDataArray(['hanabody_model.bmd', 'hanahead_model.bmd', 'sunabashira.bmd']); }
    hasMapCollision() { return true; }
    /** clipEnemies */
    clipActors() { this.clipActorsAux(this.unk54.mSLViewClipFar, this.unk54.mSLViewClipRadius); }
    getChangeSaveParams(i: number) { return this.unk58[i]; }
}

export class BossHanachan extends SpineEnemy {
    mBodyParts: BHPartsBody[] = [];
    mHead!: BHPartsHead;
    /** the weak segment */
    unk174 = 0;
    unk178!: SphereLink;
    unk17C = new V3();
    /** the last tick's movement */
    unk188 = new V3();
    /** the tumble's target rotation z (+-179) and speed */
    unk194 = 0; unk198 = 0;
    unk19C: BHSandPillar | null = null;
    unk1A0 = new V3(); unk1AC = new V3();
    /** the "keep pounding" balloon's timer */
    unk1B8 = -1;
    unk1BC!: CommonP;
    unk1C0!: ChangeP;
    get P() { return this.unk1BC; }
    constructor(w: World, name = '?') {
        super(w, name);
        this.setRandomWeakBodyIndex();
    }
    setRandomWeakBodyIndex() { this.unk174 = Math.trunc(fr(8 * MsRandF())); }
    hasMapCollision() { return true; }
    /** (drawn as world.extras: the head and the segments) */
    drawn() { return false; }
    init(m: LiveManager | null) {
        if (!m) return;
        const M = m as BossHanachanManager;
        this.manager = m;
        m.manageActor(this);
        this.unk1BC = M.unk54; this.unk1C0 = M.unk58[0];
        this.unk19C = new BHSandPillar(this);
        this.world.extras.push(this.unk19C);
        this.bodyScale = 1; this.bodyRadius = 350; this.wallRadius = this.bodyRadius; this.headHeight = 500;
        this.marchSpeed = 0; this.gravity = 2; this.hitPoints = 3; this.scaledBodyRadius = 0;
        this.onLiveFlag(LF.UNK1000 | LF.UNK8);
        this.spine!.initWith(BHNerves.graphWander);
        this.tracer.reset();
        this.goToShortestNextGraphNode();
        this.initHitActor(AT.BOSS_UNK14, 0, 0, 0, 0, 0, 0);
        this.onHitFilter(HF.NO_COLLISION);
        for (let i = 0; i < 8; i++) { const b = new BHPartsBody(this); b.unk114 = i; this.mBodyParts.push(b); }
        this.mHead = new BHPartsHead(this);
        this.mactor = this.mHead.mactor;
        this.world.extras.push(this.mHead, ...this.mBodyParts);
        this.unk17C.set(this.pos);
        const p = this.unk17C.clone();
        const dir = s16(this.rot.y * (65536 / 360));
        p.x = fr(p.x - fr(JMASSin(dir) * this.P.mSLHeadLength));
        p.z = fr(p.z - fr(JMASCos(dir) * this.P.mSLHeadLength));
        this.unk178 = new SphereLink(this.world, 8, p, this.P.mSLBodyLength, this.P.mSLBodyAttackRadius, 0.2, -2, -3.5, this.rot.y);
        const H = this.mHead;
        H.pos.set(this.pos); H.rot.set(this.rot); H.groundPlane = this.groundPlane;
        for (let i = 0; i < 8; i++) {
            const b = this.mBodyParts[i];
            b.pos.set(this.unk178.pts[i].pos); b.unk124.set(b.pos); b.unk130.set(b.unk124); b.rot.set(this.rot);
        }
        this.setHeadAndBodyAnm(ANM.WALK, false);
        this.execHeadCalcAnim_();
        this.execBodyCalcAnim_();
        H.initMapCollisionAndHitActor_();
        for (const b of this.mBodyParts) { b.initMapCollisionAndHitActor_(); b.initFootHitActor_(); }
    }
    throwMario_(h: HitActor) {
        const C = this.unk1C0, m = this.world.mario as any;
        const dir = V3.sub(this.world.mario.pos, h.pos);
        let power: number;
        if (dir.x === 0 && dir.y === 0 && dir.z === 0) {
            dir.set(0, 1, 0);
            power = fr(this.marchSpeed * C.mSLThrowTotalPower);
        } else {
            const ma = CLBDegToShortAngle(MsGetRotFromZaxisY(this.unk188)), a = CLBDegToShortAngle(MsGetRotFromZaxisY(dir));
            let ratio = fr((1 / 32768) * Math.abs(s16(ma - a)));
            ratio = fr(1 - ratio);
            power = fr(ratio * fr(this.marchSpeed * C.mSLThrowTotalPower));
            const mv = this.unk188.clone().scale(fr(ratio * C.mSLThrowMoveDirPower));
            dir.add(mv);
            dir.y = C.mSLThrowVecY;
        }
        power = MsClamp(power, C.mSLThrowSpeedMin, C.mSLThrowSpeedMax);
        m.receiveMessage(this.mHead, MSG.ATTACK);
        m.receiveMessage(this.mHead, MSG.THROWN);
        // SMS_ThrowMario
        if (typeof m.throwMario === 'function') m.throwMario(dir, power);
        this.mHead.unk100!.onWaterHitCounter();
    }
    /** CalcRevisionPosByRotateZ: lifted by |z| and, past 90, pushed sideways */
    private static revisionPos(r: V3, hs: number, p: V3) {
        const ang = absF(r.z);
        p.y = fr(p.y + fr(hs * ang));
        if (ang > 90) {
            let ox = fr(7 * fr(ang - 90));
            const oy = 0;
            if (r.z > 0) ox = -ox;
            const d = CLBDegToShortAngle(r.y), c = JMASCos(d), s = JMASSin(d);
            p.x = fr(p.x + fr(ox * c + oy * s));
            p.z = fr(p.z + fr(-ox * s + oy * c));
        }
    }
    execHeadCalcAnim_() {
        const p = this.pos.clone();
        BossHanachan.revisionPos(this.rot, this.P.mSLHeadPlusYByRotateZ, p);
        calcRotateZXYTranslate(this.mHead.baseTR, this.rot, p);
        this.mHead.calc();
    }
    execBodyCalcAnim_() {
        for (const b of this.mBodyParts) {
            const p = b.pos.clone();
            BossHanachan.revisionPos(b.rot, this.P.mSLBodyPlusYByRotateZ, p);
            calcRotateZXYTranslate(b.baseTR, b.rot, p);
            b.calc();
        }
    }
    kill() { }
    bind() {
        if (this.checkLiveFlag(LF.UNK10)) return;
        const next = this.pos.clone().add(this.posDelta).add(this.vel);
        this.vel.y = fr(this.vel.y - this.getGravityY());
        if (this.vel.y < -40) this.vel.y = -40;
        const u = this.unk17C;
        u.set(next);
        const [x, z] = BHSCalcRevisionDistXZByRotateZ(this.rot.y, this.rot.z, this.unk178.revisionScale);
        u.x = fr(u.x + x); u.z = fr(u.z + z);
        const old = u.clone();
        const [h, g] = this.world.checkGroundIgnoreWaterSurface(u.x, u.y + this.headHeight, u.z);
        this.groundPlane = g; this.groundHeight = fr(h + 1);
        if (u.y <= 0.05 + this.groundHeight) {
            if (g && !g.isIllegal()) { this.offLiveFlag(LF.AIRBORNE); this.vel.zero(); u.y = this.groundHeight; }
        } else this.onLiveFlag(LF.AIRBORNE);
        this.world.isTouchedOneWallAndMoveXZ(u, u.y + this.headHeight, this.bodyRadius);
        const corr = V3.sub(u, old);
        this.posDelta.set(V3.sub(next, this.pos).add(corr));
    }
    moveObject() {
        this.updateSquareToMario();
        this.unk188.set(this.posDelta);
        super.moveObject();
        if (this.spine!.getLatestNerve() !== BHNerves.getUp) this.rot.z = chaseDecrease(this.rot.z, this.mBodyParts[0].rot.z, 0.04, 0)[0];
        this.mHead.pos.set(this.pos); this.mHead.rot.set(this.rot); this.mHead.groundPlane = this.groundPlane;
    }
    perform(cue: number) {
        const w = this.world, s = this.spine!, B = this.mBodyParts, H = this.mHead, C = () => this.unk1C0, P = this.P;
        if (this.checkLiveFlag(LF.DEAD | LF.UNK200)) return;
        if (this.checkLiveFlag(LF.UNK40000)) {
            if ((cue & CUE_MOVE) && isLastTick(w)) {
                w.sound(SE.WT_BOSS_FADEAWAY, this.pos);
                // (gpMSound->unk98->modBgm(1, 1) == 0: the BGM fade, taken as done)
                if (!isThing(w)) {
                    this.onLiveFlag(LF.UNK40 | LF.DEAD);
                    const im = mapObjGlobals(w).itemManager as ItemManager | null;
                    if (im) im.makeShineAppearWithDemo('シャイン（ボス用）', 'ボスシャインカメラ', this.unk17C.x, fr(this.unk17C.y + P.mSLShineAppearOffsetY), this.unk17C.z);
                }
            }
            return;
        }
        if (cue & CUE_MOVE) {
            if (isThing(w)) {
                this.posDelta.zero(); this.rotDelta.zero();
                if (isLastTick(w) && s.getLatestNerve() === BHNerves.dead && !this.checkLiveFlag(LF.UNK100000)) this.onLiveFlag(LF.UNK100000);
            } else {
                // (still at full health and walking: "pound its weak segment" every 7200 ticks)
                if (!this.checkLiveFlag(LF.UNK80000) && this.hitPoints === 3 && this.marchSpeed !== 0 && s.getLatestNerve() !== BHNerves.tumble) {
                    if (this.unk1B8 === -1) this.unk1B8 = 7200;
                    else if (this.unk1B8 > 0) { this.unk1B8--; if (this.unk1B8 === 0) { this.unk1B8 = 7200; w.effect('balloon:e0006', this.pos); } }
                }
                this.moveObject();
                const nerveNow = s.getLatestNerve();
                for (const b of B) { b.unk130.set(b.unk124); b.unk124.set(b.pos); b.unk140 = b.unk13C; b.unk13C = b.rot.z; b.unk148 = b.unk144; }
                // (the first segment turns after the head, the rest along the chain)
                const ang = chaseAngleDecrease(CLBDegToShortAngle(B[0].rot.y), CLBDegToShortAngle(this.rot.y), 20)[0];
                B[0].rot.y = fr((360 / 65536) * ang);
                const L = this.unk178;
                for (let i = 1; i < 8; i++) B[i].rot.y = MsAngleWrap(MsGetRotFromZaxisY(V3.sub(L.pts[i - 1].pos, L.pts[i].pos)));
                L.initialDir = B[0].rot.y;
                for (let i = 0; i < 8; i++) L.setDegreeZAndRevisionPosXZ(i, B[i].rot.z);
                const hp = this.pos.clone();
                hp.x = fr(hp.x - fr(MsSin(this.rot.y) * P.mSLHeadLength));
                hp.z = fr(hp.z - fr(MsCos(this.rot.y) * P.mSLHeadLength));
                let [x, z] = BHSCalcRevisionDistXZByRotateZ(this.rot.y, this.rot.z, L.revisionScale);
                hp.x = fr(hp.x + x); hp.z = fr(hp.z + z);
                L.moveHead(hp);
                for (let i = 0; i < 8; i++) {
                    const b = B[i];
                    [x, z] = BHSCalcRevisionDistXZByRotateZ(b.rot.y, b.rot.z, L.revisionScale);
                    b.pos.set(L.pts[i].pos);
                    b.pos.x = fr(b.pos.x - x); b.pos.z = fr(b.pos.z - z);
                }
                // (the lean the turn gives each segment)
                const tumble = s.getLatestNerve() === BHNerves.tumble;
                let force = tumble ? this.getBodyMaxRotateZ() : 0;
                for (const b of B) {
                    if (!tumble) force = fr(BHSCalcCentrifugalForce(b.pos, b.unk124, b.unk130, b.rot.y) * C().mSLCentrifugalForce);
                    b.unk144 = MsClamp(chase(b.unk144, force, C().mSLCentrifugalSpeed), -179, 179);
                }
                if (nerveNow !== BHNerves.down) {
                    // (the slope under each segment: the sand base it's on, else the ground 200 to either side)
                    for (const b of B) {
                        const [ground, gp] = w.checkGroundIgnoreWaterSurface(b.pos.x, 500 + b.pos.y, b.pos.z);
                        b.groundPlane = gp;
                        const sand = b.getSandActor_();
                        if (sand) {
                            const d = V3.sub(sand.pos, this.pos);
                            if (fr(d.x * d.x + d.z * d.z) <= 2500) b.unk120 = 0;
                            else {
                                const rel = MsAngleDiff(MsGetRotFromZaxisY(d), this.rot.y), ar = absF(rel);
                                if (ar <= 15 || ar >= 165) b.unk120 = 0;
                                else { const rise = sandRiseUpRatio(sand); b.unk120 = rel > 15 ? fr(70 * rise) : fr(-70 * rise); }
                            }
                        } else {
                            const a = CLBDegToShortAngle(b.rot.y), sy = JMASSin(a), cy = JMASCos(a);
                            const side = new V3(fr(200 * cy + 0 * sy), 0, fr(-200 * sy + 0 * cy));
                            const rp = V3.add(side, b.pos), lp = new V3(fr(-side.x + b.pos.x), fr(-side.y + b.pos.y), fr(-side.z + b.pos.z));
                            const right = w.checkGroundIgnoreWaterSurface(rp.x, 500 + rp.y, rp.z)[0];
                            const left = w.checkGroundIgnoreWaterSurface(lp.x, 500 + lp.y, lp.z)[0];
                            const rd = fr(right - ground), ld = fr(left - ground);
                            if (Math.abs(rd) < 0.001 && Math.abs(ld) < 0.001) b.unk120 = 0;
                            else if (Math.abs(rd) > Math.abs(ld)) b.unk120 = fr((360 / 65536) * matan(200, rd));
                            else b.unk120 = -fr((360 / 65536) * matan(200, ld));
                        }
                    }
                    if (nerveNow === BHNerves.getUp) {
                        H.calcRotateZWhenGetUp_();
                        this.rot.z = H.rot.z;
                        for (const b of B) b.calcRotateZWhenGetUp_();
                    } else {
                        // (a wave along the body: each segment's lean pulled toward its neighbours')
                        const maxRot = this.getBodyMaxRotateZ(), cur = s.getLatestNerve();
                        const spacing = P.mSLBodyLength, damping = fr(C().mSLWaveDecrease * (1 / 120)), vel = C().mSLWaveVelocity;
                        const invSpacing = fr(1 / fr(spacing * spacing)), invDamping = fr(1 / fr(1 + damping)), oldDamping = fr(1 - damping);
                        const wave = fr((1 / 120) * fr((1 / 120) * fr(vel * vel)));
                        for (let i = 0; i < 8; i++) {
                            const b = B[i];
                            if (isComplete(b.rot.z) && b.rot.z === maxRot) continue;
                            const prev = i === 0 ? B[i + 1].unk13C : B[i - 1].unk13C;
                            const next = i === 7 ? B[i - 1].unk13C : B[i + 1].unk13C;
                            const twice = fr(2 * b.unk13C);
                            let target = fr(fr(fr(twice * invDamping) + fr(invDamping * fr(wave * fr(fr(invSpacing * fr(fr(next + prev) - twice)) + b.unk148)))) - fr(invDamping * fr(b.unk140 * oldDamping)));
                            target = MsClamp(target, -179, 179);
                            b.rot.z = chase(b.rot.z, target, C().mSLRotateZLeanSpeed);
                            let onSand = false;
                            if (cur === BHNerves.graphWander) {
                                if (b.getSandActor_()) {
                                    onSand = true;
                                    if (b.unk120 !== 0) b.rot.z = chase(b.rot.z, b.unk120 < 0 ? -179 : 179, fr(fr(b.unk120 * this.marchSpeed) * C().mSLSandSlopeForce));
                                } else b.rot.z = chase(b.rot.z, b.unk120, C().mSLRotateZRestorationSpeed);
                            } else if (cur === BHNerves.tumble) b.rot.z = chase(b.rot.z, this.unk194, this.unk198);
                            b.rot.z = MsClamp(b.rot.z, -179, 179);
                            if (cur === BHNerves.graphWander && (s.getTime() < C().mSLNotFallDownFrames || !onSand)) {
                                const lim = C().mSLMaxRotateZNotSand;
                                if (b.rot.z < -lim) b.rot.z = chase(b.rot.z, -lim, 15);
                                else if (b.rot.z > lim) b.rot.z = chase(b.rot.z, lim, 15);
                            }
                        }
                        const lim = C().mSLDiffMaxRotateZ;
                        for (let i = 1; i < 8; i++) {
                            const pz = B[i - 1].rot.z, b = B[i];
                            if (Math.abs(fr(pz - b.rot.z)) > lim) b.rot.z = b.rot.z < pz ? fr(pz - lim) : fr(pz + lim);
                        }
                    }
                }
                // (touching Mario throws him: the head first, then each segment and its feet)
                let thrown = false;
                const tryThrow = (h: WaterHitActor) => {
                    if (h.waterHitCounter >= 1) h.waterHitCounter--;
                    if (thrown) return;
                    for (const c of h.collisions.slice()) if (c.isActorType(AT.MARIO)) { this.throwMario_(h); thrown = true; break; }
                };
                tryThrow(H.unk100!);
                for (const b of B) { tryThrow(b.unk100!); for (const f of b.unk118) tryThrow(f); }
                if (isLastTick(w) && nerveNow === BHNerves.dead) w.sound(SE.WT_BOSS_FADEAWAY, this.pos);
            }
            H.moveMapCollision_();
            for (const b of B) b.moveMapCollision_();
        }
        if (cue & CUE_CALC_ANIM) {
            if (!isThing(w)) {
                const walking = s.getLatestNerve() === BHNerves.graphWander && this.marchSpeed > 0.001;
                const head = H.center();
                H.unk100!.pos.set(head.x, fr(head.y - P.mSLHeadHitOffsetY), head.z);
                // (walking it hurts; standing still it is ground)
                const toggle = (h: WaterHitActor, c: PartCollision, at: V3) => {
                    if (walking) { if (!h.checkHitFilter(HC.PLAYER)) { h.onHitFilter(HC.PLAYER); c.remove(); } }
                    else if (h.checkHitFilter(HC.PLAYER)) { h.offHitFilter(HC.PLAYER); c.setUpTrans(at); }
                };
                toggle(H.unk100!, H.unk104!, head);
                const fo = P.mSLFootHitOffsetY, bo = P.mSLBodyHitOffsetY;
                for (const b of B) {
                    b.unk154.set(b.center());
                    b.unk100!.pos.set(b.unk154.x, fr(b.unk154.y - bo), b.unk154.z);
                    toggle(b.unk100!, b.unk104!, b.unk154);
                    for (const f of b.unk118) {
                        const fp = b.jointPos(f.joint);
                        f.pos.set(fp.x, fr(fp.y - fo), fp.z);
                        if (walking) f.onHitFilter(HC.PLAYER); else f.offHitFilter(HC.PLAYER);
                    }
                }
                this.emitParticle_();
            }
            const pil = this.unk19C!;
            if (this.checkLiveFlag(LF.UNK10000) && pil.mactor && pil.mactor.curAnmEndsNext(ANM_BCK)) this.offLiveFlag(LF.UNK10000);
            if (!isThing(w)) this.changeAnmRateAndFrameUpdate_();
            H.execMotionBlend();
            for (const b of B) b.execMotionBlend();
            this.execHeadCalcAnim_();
            this.execBodyCalcAnim_();
            if (this.checkLiveFlag(LF.UNK10000) && pil.mactor) pil.mactor.frameUpdate();
        }
    }
    /** emitParticle_: only its MsRandF calls (one per foot step pass in GraphWander) and the steps, as effects */
    emitParticle_() {
        if (this.spine!.getLatestNerve() !== BHNerves.graphWander) return;
        for (const b of this.mBodyParts) {
            const c = b.mactor!.getFrameCtrl(ANM_BCK);
            if (!c) continue;
            for (let j = 0; j < sEmitSandFrameFoot.length; j++) {
                if (!c.checkPass(sEmitSandFrameFoot[j])) continue;
                // (the sand / ripple particles; which one depends on gpSunMgr's sea height)
                if (MsRandF() < this.unk1C0.mSLParticleProbability) this.world.effect('boha:sand', b.jointPos(b.unk118[j] ? b.unk118[j].joint : -1));
            }
        }
    }
    emitOneTimeSandPillar_(b: BHPartsBody) {
        this.onLiveFlag(LF.UNK10000);
        const c = b.center();
        this.unk1A0.set(c.x, this.pos.y, c.z);
        const sand = b.getSandActor_();
        if (sand) {
            this.unk1A0.x = fr(0.5 * fr(this.unk1A0.x + sand.pos.x));
            this.unk1A0.z = fr(0.5 * fr(this.unk1A0.z + sand.pos.z));
            this.unk1A0.y = sand.pos.y;
        }
        this.world.effect('boha:crash', this.unk1A0);
        const p = this.unk19C!;
        p.baseTR[3] = this.unk1A0.x; p.baseTR[7] = this.unk1A0.y; p.baseTR[11] = this.unk1A0.z;
        p.pos.set(this.unk1A0);
        const a = p.mactor;
        if (a) { a.setBckFromIndex(37); a.setFromIndex(ANM_BTK, 2); a.setFromIndex(ANM_BRK, 2); }
        this.world.sound(SE.BS_HANA_TUMBLE, this.unk1A0);
    }
    isTumbleCompletelyAllBody() {
        const z = this.mBodyParts[0].rot.z;
        if (!isComplete(z)) return false;
        for (let i = 1; i < 8; i++) if (this.mBodyParts[i].rot.z !== z) return false;
        return true;
    }
    checkFallDecideAndSetup() {
        const C = this.unk1C0;
        for (const b of this.mBodyParts) {
            if (absF(b.rot.z) > C.mSLFallDecideRotateZ) {
                this.emitOneTimeSandPillar_(b);
                this.unk194 = b.rot.z > 0 ? 179 : -179;
                const speed = absF(fr(b.unk13C - b.rot.z));
                this.unk198 = fr(C.mSLWaveFallDownSpeed * speed);
                if (this.unk198 < C.mSLFallDecideMinSpeed) this.unk198 = C.mSLFallDecideMinSpeed;
                return true;
            }
        }
        return false;
    }
    getBodyMaxRotateZ() {
        let r = 0;
        for (const b of this.mBodyParts) if (Math.abs(b.rot.z) > Math.abs(r)) r = b.rot.z;
        return r;
    }
    isCanWalk() {
        const g = this.goal.point();
        const dx = fr(g.x - this.pos.x), dz = fr(g.z - this.pos.z);
        return !(fr(dx * dx + dz * dz) < 100);
    }
    execWalk(accelerate: boolean) {
        const C = this.unk1C0;
        this.marchSpeed = accelerate ? chase(this.marchSpeed, C.mSLMaxMarchSpeed, C.mSLMarchAccel) : chase(this.marchSpeed, 0, C.mSLMarchDecrease);
        this.turnSpeed = C.mSLWalkTurnSpeed;
        if (this.isCanWalk()) this.walkToCurPathNode(this.marchSpeed, this.turnSpeed, 0);
        const g = this.goal.point();
        const dx = fr(g.x - this.pos.x), dz = fr(g.z - this.pos.z);
        if (fr(dx * dx + dz * dz) < 10000) {
            if (this.goalStack.length) this.switchNextGoalPath();
            else this.goToDirLimitedNextGraphNode(90);
        }
    }
    execSlip() {
        this.marchSpeed = chase(this.marchSpeed, 0, this.unk1C0.mSLMarchDecrease);
        this.turnSpeed = 0.1;
        if (!(this.marchSpeed > 0.001)) return;
        const d = this.unk188.clone();
        if (this.marchSpeed > 4) {
            // (sliding off sideways, away from the lean)
            let sx = 1;
            if (this.getBodyMaxRotateZ() > 0) sx = -1;
            const a = CLBDegToShortAngle(this.rot.y), sy = JMASSin(a), cy = JMASCos(a);
            const r = new V3(fr(sx * cy), 0, fr(-sx * sy)).scale(fr(0.005 * this.marchSpeed));
            d.add(r);
        }
        if (!(d.x === 0 && d.y === 0 && d.z === 0)) {
            norm(d).scale(500);
            this.setGoalPath(new PathNode(null, V3.add(this.pos, d)));
            this.walkToCurPathNode(this.marchSpeed, this.turnSpeed, 0);
        }
    }
    goToInitialRecoverGraphNode() {
        const t = this.tracer;
        t.reset(); t.reset2();
        const idx = t.graph!.findNearestVisibleIndex(this.pos, this.rot.y, this.P.mSLRecoverSearchDist, this.P.mSLRecoverSearchDegree, -1);
        if (idx < 0) { this.goToShortestNextGraphNode(); return; }
        t.setTo(idx);
        this.setGoalPathFromGraph();
        this.unk128 = 0; this.unk12C = 0;
    }
    execDamage() {
        const s = this.spine!;
        s.reset();
        this.decHitPoints();
        if (this.hitPoints === 0) {
            this.mHead.unk100!.onHitFilter(HF.NO_COLLISION);
            for (const b of this.mBodyParts) { b.unk100!.onHitFilter(HF.NO_COLLISION); for (const f of b.unk118) f.onHitFilter(HF.NO_COLLISION); }
            s.setNext(BHNerves.dead);
            this.setAnmTimerWhenDead();
            this.unk1AC.set(this.world.mario.pos);
            this.world.sound(SE.BS_HANA_DOWN, this.unk1AC);
        } else {
            s.setNext(BHNerves.damage);
            this.setAnmTimerWhenDamage();
            this.unk1C0 = (this.manager as BossHanachanManager).getChangeSaveParams(3 - this.hitPoints);
            const rail = this.hitPoints === 2 ? cHitPoint2_RailName : cHitPoint1_RailName;
            this.tracer.init(this.world.graphByName(rail));
            this.onLiveFlag(LF.UNK20000);
            this.world.sound(SE.BS_DAMAGE_SYMBL, this.mBodyParts[this.unk174].unk154);
        }
    }
    removeAllMapCollision() { this.mHead.unk104!.remove(); for (const b of this.mBodyParts) b.unk104!.remove(); }

    // ---------------------------------------------------------------- BossHanachanAnm.cpp
    setHeadAndBodyAnm(anm: number, blend: boolean) {
        this.mHead.setAnm_(anm, blend);
        for (let i = 0; i < 8; i++) {
            const part = this.mBodyParts[i];
            if (!part.setAnm_(anm, blend)) continue;
            // (each segment a few frames behind the one before)
            const a = part.mactor!, c = a.getFrameCtrl(ANM_BCK)!;
            const f = c.end ? (i * this.unk1C0.mSLNormalBckFrameDiff) % c.end : 0;
            c.frame = f;
            const p = a.getFrameCtrl(ANM_BTP); if (p) p.frame = f;
            const k = a.getFrameCtrl(ANM_BTK); if (k) k.frame = f;
        }
    }
    setTumbleBckRate_(part: BHPartsBase) {
        const c = part.mactor!.getFrameCtrl(ANM_BCK);
        if (!c) return;
        const duration = fr(fr(1 / this.unk198) * absF(fr(this.unk194 - part.rot.z)));
        c.rate = fr(fr(1 / duration) * fr(2 * fr(40 * ANM_FRAME_RATE)));
    }
    setTumbleAnm(blend: boolean) {
        let anm: number;
        if (this.unk194 === 179) anm = ANM.TUMBLE_R;
        else if (this.unk194 === -179) anm = ANM.TUMBLE_L;
        else return;
        this.mHead.setAnm_(anm, blend);
        this.setTumbleBckRate_(this.mHead);
        for (const b of this.mBodyParts) { b.setAnm_(anm, blend); this.setTumbleBckRate_(b); }
    }
    setAnmTimerWhenGetUp() {
        const d = this.unk1C0.mSLGetUpFrameDiff;
        for (let i = 0; i < 8; i++) this.mBodyParts[7 - i].unk10C = d * i;
        this.mHead.unk10C = d * 8;
    }
    setAnmTimerWhenSnort() {
        const d = this.unk1C0.mSLSnortFrameDiff;
        this.mHead.unk10C = 0;
        for (let i = 0; i < 8; i++) this.mBodyParts[i].unk10C = d * (i + 1);
    }
    /** (rippling out from the weak segment) */
    private setAnmTimerFromWeak(d: number) {
        for (let i = 0; i < 8; i++) this.mBodyParts[i].unk10C = d * Math.abs(this.unk174 - i);
        this.mHead.unk10C = d * Math.abs(this.unk174 + 1);
    }
    setAnmTimerWhenDamage() { this.setAnmTimerFromWeak(this.unk1C0.mSLDamageFrameDiff); }
    setAnmTimerWhenDead() { this.setAnmTimerFromWeak(this.unk1C0.mSLDeadFrameDiff); }
    considerSetAnm(na: number) { this.mHead.considerSetAnm_(na); for (const b of this.mBodyParts) b.considerSetAnm_(na); }
    isFinishedGetUp() { const c = this.mHead.curAnm; return (c === ANM.UNK9 || c === ANM.UNK12) && this.mHead.isCurBckAlreadyEnd_(); }
    isAllBckAlreadyEnd(anm: number) {
        if (!(this.mHead.curAnm === anm && this.mHead.isCurBckAlreadyEnd_())) return false;
        for (const b of this.mBodyParts) if (!(b.curAnm === anm && b.isCurBckAlreadyEnd_())) return false;
        return true;
    }
    private allParts(): BHPartsBase[] { return [this.mHead, ...this.mBodyParts]; }
    offHeadAndBodyNonstopMotionBlend_() { for (const p of this.allParts()) p.offNonstopMotionBlend_(); }
    setHeadAndBodyNonstopMotionBlendRatio_(r: number) { for (const p of this.allParts()) p.setNonstopMotionBlendRatio_(r); }
    copyFrameFromOldAnmToNewAnm_() { for (const p of this.allParts()) p.copyFrameFromOldAnmToNewAnm_(); }
    changeAnmRateAndFrameUpdate_() {
        let doRate = true, rate = ANM_FRAME_RATE;
        const C = this.unk1C0, H = this.mHead;
        if (this.spine!.getLatestNerve() === BHNerves.tumble) {
            this.offHeadAndBodyNonstopMotionBlend_();
            for (const p of this.allParts()) p.changeTumbleAnmRate_();
            doRate = false;
        } else if (H.curAnm === ANM.WALK || H.curAnm === ANM.RUN) {
            // (walk below mSLWalkAnmMarchSpeed, run above mSLRunAnmMarchSpeed, the two blended between)
            if (this.marchSpeed <= C.mSLWalkAnmMarchSpeed) {
                this.offHeadAndBodyNonstopMotionBlend_();
                if (H.curAnm === ANM.RUN) { this.setHeadAndBodyAnm(ANM.WALK, false); this.copyFrameFromOldAnmToNewAnm_(); }
            } else if (this.marchSpeed >= C.mSLRunAnmMarchSpeed) {
                this.offHeadAndBodyNonstopMotionBlend_();
                if (H.curAnm === ANM.WALK) { this.setHeadAndBodyAnm(ANM.RUN, false); this.copyFrameFromOldAnmToNewAnm_(); }
            } else {
                rate = ratioF(C.mSLWalkAnmMarchSpeed, C.mSLRunAnmMarchSpeed, this.marchSpeed);
                if (H.curAnm === ANM.WALK) {
                    if (H.prevAnm !== ANM.RUN) { this.setHeadAndBodyAnm(ANM.RUN, false); this.copyFrameFromOldAnmToNewAnm_(); rate = fr(1 - rate); }
                } else {
                    if (H.prevAnm === ANM.WALK) rate = fr(1 - rate);
                    else { this.setHeadAndBodyAnm(ANM.WALK, false); this.copyFrameFromOldAnmToNewAnm_(); }
                }
                this.setHeadAndBodyNonstopMotionBlendRatio_(rate);
            }
            rate = fr(fr(this.marchSpeed * ANM_FRAME_RATE) * C.mSLWalkBckRateMagnif);
            if (rate < C.mSLWalkBckRateMin) rate = C.mSLWalkBckRateMin;
        } else {
            this.offHeadAndBodyNonstopMotionBlend_();
            rate = ANM_FRAME_RATE;
        }
        for (const p of this.allParts()) {
            const a = p.mactor!;
            if (doRate) a.setFrameRate(rate, ANM_BCK);
            a.frameUpdate();
        }
    }
}

// ---------------------------------------------------------------- BossHanachanNerve.cpp
type S = Spine<BossHanachan>;
export const BHNerves: Record<string, any> = {};
BHNerves.graphWander = nerve<BossHanachan>('TNerveBossHanachanGraphWander', (spine: S) => {
    const h = spine.body;
    if (spine.time === 0) h.setHeadAndBodyAnm(ANM.WALK, true);
    h.execWalk(true);
    if (h.checkFallDecideAndSetup()) { spine.pushAfterCurrent(BHNerves.tumble); return true; }
    return false;
});
BHNerves.tumble = nerve<BossHanachan>('TNerveBossHanachanTumble', (spine: S) => {
    const h = spine.body;
    if (spine.time === 0) h.setTumbleAnm(true); else h.considerSetAnm(NA.TUMBLE);
    h.execSlip();
    if (h.marchSpeed === 0 && h.isTumbleCompletelyAllBody()) {
        h.world.effect('balloon:e0007', h.pos);
        spine.pushAfterCurrent(BHNerves.down);
        return true;
    }
    return false;
});
BHNerves.down = nerve<BossHanachan>('TNerveBossHanachanDown', (spine: S) => {
    const h = spine.body;
    h.considerSetAnm(NA.DOWN);
    if (spine.time >= h.unk1C0.mSLDownFrames) { h.setAnmTimerWhenGetUp(); spine.pushAfterCurrent(BHNerves.getUp); return true; }
    return false;
});
BHNerves.getUp = nerve<BossHanachan>('TNerveBossHanachanGetUp', (spine: S) => {
    const h = spine.body;
    h.considerSetAnm(NA.GET_UP);
    if (h.isFinishedGetUp()) { h.setRandomWeakBodyIndex(); h.setAnmTimerWhenSnort(); spine.pushAfterCurrent(BHNerves.snort); return true; }
    return false;
});
BHNerves.damage = nerve<BossHanachan>('TNerveBossHanachanDamage', (spine: S) => {
    const h = spine.body;
    h.considerSetAnm(NA.DAMAGE);
    h.execSlip();
    if (h.marchSpeed === 0 && spine.time >= h.unk1C0.mSLDamageFrames) { h.setAnmTimerWhenGetUp(); spine.pushAfterCurrent(BHNerves.getUp); return true; }
    return false;
});
BHNerves.snort = nerve<BossHanachan>('TNerveBossHanachanSnort', (spine: S) => {
    const h = spine.body;
    // (the BGM restarts, faster each hit: not here)
    if (spine.time === 0xC8 && h.checkLiveFlag(LF.UNK20000)) h.offLiveFlag(LF.UNK20000);
    h.considerSetAnm(NA.SNORT);
    if (h.isAllBckAlreadyEnd(ANM.SNORT)) { h.goToInitialRecoverGraphNode(); spine.pushAfterCurrent(BHNerves.graphWander); return true; }
    return false;
});
BHNerves.dead = nerve<BossHanachan>('TNerveBossHanachanDead', (spine: S) => {
    const h = spine.body;
    h.considerSetAnm(NA.DEAD);
    if (!h.checkLiveFlag(LF.UNK40000) && h.isAllBckAlreadyEnd(ANM.DEAD)) { h.onLiveFlag(LF.UNK40000); h.removeAllMapCollision(); }
    return false;
});

// ---------------------------------------------------------------- DemoBossHanachanBase.cpp / SleepBossHanachan.cpp
/** TDemoBossHanachanManager (its TDemoBossHanachanSaveParams from /enemy/sleepBossHanachan.prm) */
export class SleepBossHanachanManager extends EnemyManager {
    demoParams!: { mSLViewClipFar: number; mSLViewClipRadius: number };
    constructor(w: World, name = '?') { super(w, name); }
    load(s: Stream) {
        this.demoParams = new Params('/enemy/sleepBossHanachan.prm', this.world.files).read(DEMO_PARAMS);
        super.load(s);
    }
    createModelData() { this.createModelDataArray(['demohanatyan_model.bmd']); }
    clipActors() { this.clipActorsAux(this.demoParams.mSLViewClipFar, this.demoParams.mSLViewClipRadius); }
}

/** TSleepBossHanachan (TDemoBossHanachan): the sleeping Wiggler, which startFall drops */
export class SleepBossHanachan extends SpineEnemy {
    mShinePosition = new V3();
    constructor(w: World, name = '?') { super(w, name); }
    /** TDemoBossHanachan::initBase */
    initBase(m: LiveManager) {
        this.manager = m;
        m.manageActor(this);
        this.mactor = this.createMActor(0);
        this.bodyScale = 1; this.bodyRadius = 280; this.wallRadius = this.bodyRadius; this.headHeight = 200; this.marchSpeed = 0; this.scaledBodyRadius = 1000;
        this.onLiveFlag(LF.UNK8 | LF.UNK10);
        const [h, g] = this.world.checkGroundIgnoreWaterSurface(this.pos.x, this.pos.y + this.getHeadHeight(), this.pos.z);
        this.groundHeight = h; this.groundPlane = g;
    }
    init(m: LiveManager | null) {
        if (!m) return;
        this.initBase(m);
        this.spine!.initWith(SBHNerves.sleepContinue);
        this.initHitActor(AT.SLEEP_BOSS_HANACHAN, 0, 0, 0, 0, 0, 0);
        this.onHitFilter(HF.NO_COLLISION);
        if (this.mactor) this.mactor.setBckFromIndex(1);
        MsMtxSetXYZRPH(this.baseTR, this.pos.x, this.pos.y, this.pos.z, this.rot.x, this.rot.y, this.rot.z);
    }
    receiveMessage() { return false; }
    calcRootMatrix() { }
    startFall(x: number, y: number, z: number) {
        this.mShinePosition.set(x, y, z);
        if (this.mactor) this.mactor.setBckFromIndex(0);
        this.spine!.setNext(SBHNerves.fall);
    }
}
type SS = Spine<SleepBossHanachan>;
export const SBHNerves: Record<string, any> = {};
SBHNerves.sleepContinue = nerve<SleepBossHanachan>('TNerveSBH_SleepContinue', () => false);
SBHNerves.fall = nerve<SleepBossHanachan>('TNerveSBH_Fall', (spine: SS) => {
    const self = spine.body;
    if (self.mactor && self.mactor.curAnmEndsNext(ANM_BCK)) {
        const p = self.mShinePosition;
        const im = mapObjGlobals(self.world).itemManager as ItemManager | null;
        const shine = im ? im.makeShineAppearWithDemo('シャイン（ボス用）', 'ボスシャインカメラ', p.x, p.y, p.z) as any : null;
        if (shine && shine.onMapObjFlag) shine.onMapObjFlag(0x20000000);
        self.onLiveFlag(LF.DEAD);
        spine.pushAfterCurrent(SBHNerves.sleepContinue);
        return true;
    }
    return false;
});

register('BossHanachanManager', (w, n) => new BossHanachanManager(w, n));
register('BossHanachan', (w, n) => new BossHanachan(w, n));
register('SleepBossHanachanManager', (w, n) => new SleepBossHanachanManager(w, n));
register('SleepBossHanachan', (w, n) => new SleepBossHanachan(w, n));


