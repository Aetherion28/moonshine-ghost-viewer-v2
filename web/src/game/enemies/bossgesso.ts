// Gooper Blooper (TBossGesso, Enemy/bossgesso.cpp) with its tentacles (TBGTentacle,
// Enemy/bgtentacle.cpp), its goop shots (TBGPolDrop, Enemy/bgpoldrop.cpp) and the spline its
// tentacles are drawn along (TSplinePath, Enemy/spline.cpp: spline.ts).
//
// The body turns after Mario and picks an attack mode each tick (doAttackSingle..Roll): single
// slaps with tentacles 1 and 3, both outer ones, all four in turn (unison), skipping rope while
// Mario holds the beak, goop shots once its cork is off, rolling (the second fight). A tentacle
// is a chain of six nodes pulled toward targets (the body's joints at rest, the attack guide
// model's joints while it slaps) with springy constraints; Mario grabs its tip (TBGTakeHit) and
// pulls (TMario::pulling): pulled past mTotalLenLimit it takes damage until it's torn off
// (TSTATE_AMPUTEE), and when both front tentacles are gone Mario can pull the beak
// (TBGBeakHit): past mSLBeakLengthDamage and let go, or past mSLBeakLengthLimit, it's a hit.
// Spraying the eyes stuns it. Three hits and it falls back into the sea.
//
// In Ricco Harbor's first episode (map 3, stage 0) it's only tentacle 0 gripping the container
// (ASTATE_UNK6) until the movie.
//
// Not here: the camera shakes, rumble, the balloons and streaming movie (told as events), the
// damage fog, the shadow, and the particles (effects by name).

import { fr, V3, Mtx, mtx, MsWrap, MsClamp, MsAngleDiff, MsGetRotFromZaxis, MsGetRotFromZaxisY, MsMtxSetXYZRPH, MsSin, MsCos, MsRandF, matan, frsqrte, JMASSin, JMASCos } from '../math.js';
import { World, Stream, NameRef, HitActor, TakeActor, LiveActor, LiveManager, SpineEnemy, EnemyManager, PathNode, MActor, LF, HF, HC, MSG, ANM_BCK, ANM_BTP, ANM_BTK, CUE_MOVE, CUE_CALC_ANIM, CUE_ENTRY, nerve, Spine, readParams, SPINE_PARAMS, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { mat4 } from 'gl-matrix';
import { Skeleton, parseBCK, jointMatricesBlend } from '../skeleton.js';
import { psVecNormalize, psVecMag, force25 } from '../camera/lib.js';
import { SplinePath } from '../spline.js';
import { MsMtxSetRotX, MsMtxSetRotY, MsMtxSetRotZ, MTXConcat } from '../mapobj/lib.js';
import { MsMtxSetTRS } from '../mapobj/objcol.js';
import { mapObjGlobals } from '../mapobj/base.js';
import { stampModel } from './igaiga.js';

const BG_PARAMS = {
    ...SPINE_PARAMS,
    mSLUnisonInter: ['i', 2000], mSLUnisonHoming: ['i', 200], mSLSingleHoming: ['i', 200], mSLBeakHoming: ['i', 200], mSLRegenFoot: ['i', 4800],
    mSLAmputeeTime: ['i', 1200], mSLRestTime: ['i', 360], mSLStunTime: ['i', 1200], mSLBeakDamageHeight: ['f', 150], mSLBeakDamageRadius: ['f', 150],
    mSLBeakLengthLimit: ['f', 1200], mSLBeakLengthDamage: ['f', 600], mSLBeakLengthPollute: ['f', 500], mSLUnisonAttackSpeed: ['f', 2],
    mSLDoubleAttackSpeed: ['f', 1.2], mSLSkipRopeAttackSpeed: ['f', 1], mSLSingleAttackLen: ['f', 2200], mSLDoubleAttackLen: ['f', 1900],
    mSLUnisonAttackLen: ['f', 1900], mSLForceUnisonLen: ['f', 800], mSLGuardLen: ['f', 500], mSLTentacleStretch: ['f', 0.1], mSLBeakStretch: ['f', 0.07],
    mSLEyeDamageRadius: ['f', 100], mSLEyeDamageHeight: ['f', 150], mSLShootRadius: ['f', 8000], mSLBlurJoint: ['i', 10], mSLBlurScale: ['f', 1],
    mSLColumnScale: ['f', 3], mSLSightAngle: ['f', 120], mSLAmputeeWait: ['i', 720],
} satisfies PSchema;
const TENT_PARAMS = {
    mNodeLength: ['f', 130], mNodeLenLimit: ['f', 1000], mTotalLenLimit: ['f', 800], mSpeedProp: ['f', 1.4], mInertiaProp: ['f', 0.6],
    mReflectProp: ['f', 0.1], mSpeedMax: ['f', 50], mVibrationForce: ['f', 6], mVibrationSpeed: ['f', 3], mDamagePropF: ['f', 4],
    mDamagePropS: ['f', 2], mDamageCountMax: ['i', 256], mDamageReflectProp: ['f', 1.5], mDamageNodeLength: ['f', 100], mAttackRadius: ['f', 80],
    mAttackHeight: ['f', 120], mDamageRadius: ['f', 150], mDamageHeight: ['f', 200], mAtkSoundTime: ['f', 120],
} satisfies PSchema;

// BCKs (/scene/bgeso, in the folder's order: all the keeper's models share them)
const BCK_CANNON = 1, BCK_CRUSH = 2, BCK_DAMAGE = 3, BCK_DIRTY_OSEN = 4, BCK_EYEDAMAGE = 5, BCK_FLY = 6, BCK_HIT = 7, BCK_KOLK_BREAK = 8,
    BCK_LIMIT = 9, BCK_OSEN = 10, BCK_OSENBALL_FLY = 11, BCK_OSENBALL_OSEN = 12, BCK_OSENBALL_WHITE_OSEN = 13, BCK_ROLL = 14, BCK_ROLL_ALL = 15,
    BCK_ROLL_ALL_END = 16, BCK_ROLL_ALL_START = 17, BCK_ROLL_END = 18, BCK_ROLL_START = 19, BCK_SHAND_ATTACK = 20, BCK_SHAND_FLY = 21,
    BCK_SHAND_GUARD = 22, BCK_SHAND_ISSEI = 23, BCK_SHAND_JUMP = 24, BCK_WAIT = 25, BCK_WAIT2 = 26, BCK_WAIT3 = 27;
const BTP_TEYEDAMAGE = 1, BTP_TWAIT = 2;

const ASTATE_SINGLE = 0, ASTATE_DOUBLE = 1, ASTATE_UNISON = 2, ASTATE_GUARD = 3, ASTATE_SKIP_ROPE = 4, ASTATE_SHOOT = 5, ASTATE_UNK6 = 6, ASTATE_ROLL = 7;
const TS_WAIT = 0, TS_ATTACK = 1, TS_REST = 2, TS_HELD = 3, TS_AMPUTEE = 4, TS_STUN = 5, TS_HIDE = 6, TS_FOLLOWBODY = 7, TS_SYNCBODY = 8, TS_GUARD = 9, TS_UNKA = 10;
const EPS = 32 * 1.1920929e-7;
const isZero = (v: V3) => v.squared() <= EPS;
const vnorm = (v: V3) => psVecNormalize(v, v) as V3;
/** JGeometry::TVec3::normalize: setLength(1) (a plain one) */
const jnorm = (v: V3) => { const l2 = fr(fr(v.x * v.x + fr(v.y * v.y)) + fr(v.z * v.z)); if (l2 > EPS) { const k = fr(1 / Math.sqrt(l2)); v.x = fr(v.x * k); v.y = fr(v.y * k); v.z = fr(v.z * k); } return v; };
const len = (v: V3) => fr(Math.sqrt(fr(fr(v.x * v.x + fr(v.y * v.y)) + fr(v.z * v.z))));
const trans = (m: Mtx) => new V3(m[3], m[7], m[11]);
const fromPolar = (theta: number, r: number) => new V3(fr(r * JMASSin(Math.trunc(fr(theta * fr(65536 / 360))))), 0, fr(r * JMASCos(Math.trunc(fr(theta * fr(65536 / 360))))));
/** a row-major 3x4 from a world mat4 (column-major) */
const rowMajor = (m: mat4): Mtx => { const r = mtx(); r[0] = m[0]; r[1] = m[4]; r[2] = m[8]; r[3] = m[12]; r[4] = m[1]; r[5] = m[5]; r[6] = m[9]; r[7] = m[13]; r[8] = m[2]; r[9] = m[6]; r[10] = m[10]; r[11] = m[14]; return r; };
const colMajor = (r: Mtx) => mat4.fromValues(r[0], r[4], r[8], 0, r[1], r[5], r[9], 0, r[2], r[6], r[10], 0, r[3], r[7], r[11], 1);

/** SMSCalcJumpVelocityXZ */
function calcJumpVelocityXZ(to: V3, from: V3, sp: number, g: number) {
    const h = new V3(fr(to.x - from.x), 0, fr(to.z - from.z));
    const m = psVecMag(h);
    const t = Math.trunc(fr(m / sp)), t3 = Math.trunc(((t + 1) * t) / 2);
    const k = fr(sp / m), dy = fr(to.y - from.y);
    return new V3(fr(h.x * k), fr(fr(k * dy) + fr(fr(t3 * g) * k)), fr(h.z * k));
}

/** A model of the boss's keeper the viewer draws (the tentacles, the cork, the shots): its own matrices */
export class BGModel extends LiveActor {
    shown = false;
    joints: mat4[] | null = null;
    locals: mat4[] = [];
    constructor(w: World, m: MActor | null) { super(w, 'bgeso'); this.mactor = m; w.extras.push(this); }
    drawn() { return this.shown; }
    perform(_cue: number) { }
    /** the world matrices given: each one in its parent's for the viewer */
    setJoints(world: mat4[]) {
        this.joints = world;
        const sk = this.mactor ? Skeleton.of(this.mactor.data.files.scene(this.mactor.model)) : null;
        if (!sk) return;
        const root = colMajor(this.baseTR), inv = mat4.create();
        for (const j of sk.order) {
            const p = sk.parent[j];
            mat4.invert(inv, p >= 0 ? world[p] : root);
            this.locals[j] = this.locals[j] || mat4.create();
            mat4.mul(this.locals[j], inv, world[j]);
        }
    }
}

// ---------------------------------------------------------------- TBGPolDrop
export class BGPolDrop extends NameRef {
    pos = new V3(); rot = new V3(); scale = new V3(1, 1, 1); unk44 = new V3(); unk58 = 0;
    m50: BGModel; m54: MActor | null;
    constructor(public w: World, a: MActor | null, b: MActor | null) { super('<TBGPolDrop>'); this.m50 = new BGModel(w, a); this.m54 = b; }
    move() {
        if (!this.unk58) return;
        const n = this.pos.clone().add(this.unk44).fround();
        const a = this.m50.mactor!;
        if (this.unk58 === 1) {
            this.unk44.y = fr(this.unk44.y - fr(0.2));
            const [h, d] = this.w.checkGround(n.x, this.pos.y, n.z);
            const g = fr(h + 1);
            if (d.isIllegal()) { this.unk58 = 0; return; }
            if (n.y < g) {
                this.unk58 = 2; n.y = g; this.unk44.zero();
                if (!a.checkCurBckFromIndex(BCK_OSENBALL_OSEN)) { a.setBckFromIndex(BCK_OSENBALL_OSEN); if (this.m54) this.m54.setBckFromIndex(BCK_OSENBALL_WHITE_OSEN); }
                this.w.effect('ms_boge_odanhit', n);
                this.w.sound(SE.BS_GESO_GERO_LAND, this.pos);
            } else if (!a.checkCurBckFromIndex(BCK_OSENBALL_FLY) || a.curAnmEndsNext(ANM_BCK)) a.setBckFromIndex(BCK_OSENBALL_FLY);
            const xz = { x: n.x, z: n.z };
            if (this.w.isTouchedOneWallAndMoveXZ(xz, n.y, 80)) this.unk58 = 0;
            n.x = xz.x; n.z = xz.z;
        } else if (this.unk58 === 2 && a.curAnmEndsNext(ANM_BCK)) this.unk58 = 0;
        this.pos.set(n);
    }
    launch(p: V3, v: V3) { this.unk44.set(v); this.pos.set(p); this.scale.set(1, 1, 1); this.rot.zero(); this.unk58 = 1; }
    perform(cue: number) {
        this.m50.shown = this.unk58 !== 0;
        if (!this.unk58) return;
        if (cue & CUE_MOVE) this.move();
        const M = this.m50;
        if (cue & CUE_CALC_ANIM) {
            const m = M.baseTR;
            if (this.unk58 === 1) {
                const rx = mtx(); MsMtxSetRotX(rx, -90);
                this.rot.set(MsGetRotFromZaxis(this.unk44.clone()));
                MsMtxSetXYZRPH(m, this.pos.x, this.pos.y, this.pos.z, this.rot.x, this.rot.y, this.rot.z);
                MTXConcat(m, rx, m);
                this.w.effect('ms_boge_kiseki', this.pos);
            } else { m.set(mtx()); m[3] = this.pos.x; m[7] = this.pos.y; m[11] = this.pos.z; }
            M.scale.set(this.scale);
            if (M.mactor) M.mactor.frameUpdate();
            if (this.unk58 === 2 && this.m54) { this.m54.frameUpdate(); stampModel(this.w, this.m54, m, this.scale); }
        }
        this.m50.shown = this.unk58 !== 0;
    }
}

// ---------------------------------------------------------------- the boss's hits
/** TBGBeakHit: the beak Mario grabs (when both front tentacles are gone) */
export class BGBeakHit extends TakeActor {
    unk74: Mtx = mtx(); unkA4 = new V3();
    constructor(public owner: BossGesso, name = 'クチバシ（つかみ）') {
        super(name);
        owner.world.addToGroup('敵グループ', this);
        const P = owner.BP;
        this.initHitActor(AT.BOSS_UNK8, 1, HC.PLAYER, 0, 0, P.mSLBeakDamageRadius, P.mSLBeakDamageHeight);
        this.offHitFilter(HF.NO_COLLISION);
    }
    getTakingMtx() { return this.unk74; }
    isTaken() { return !!this.holder; }
    moveRequest(to: V3) {
        const P = this.owner.BP, m = this.owner.world.mario as any;
        // fromPolar(getIntendedYaw(), getIntendedMag() * mSLBeakStretch): the yaw goes through degrees
        // (s16 * (360 / 65536), then * (65536 / 360) truncated to the s16 JMASSin takes)
        this.unkA4 = fromPolar(m.mIntendedYaw !== undefined ? fr(m.mIntendedYaw * (360 / 65536)) : 0, fr((m.mIntendedMag || 0) * P.mSLBeakStretch));
        const d = V3.sub(this.owner.pos, to).scale(fr(0.001)).fround();
        this.unkA4.add(d).fround();
        this.pos.set(to);
        return false;
    }
    receiveMessage(sender: HitActor, msg: number) {
        const o = this.owner;
        if (sender.isActorType(AT.WATER)) {
            if (!isNozzleWater(sender)) return true;
            o.gotEyeDamage();
            o.world.effect('enemyWaterHit', sender.pos);
            return true;
        }
        if (o.mAttackMode === ASTATE_GUARD) return false;
        const l = o.spine!.getLatestNerve();
        if (l === BGNerves.pollute || l === BGNerves.polDrop || l === BGNerves.beakDamage) return false;
        if (sender.isActorType(AT.MARIO)) {
            if (msg === MSG.TAKE) {
                const a = sender as TakeActor;
                if (a.held && a.held !== this) return false;
                this.holder = a;
                if (o.unk190[3] !== 0) o.showMessage(0xE0028);
                return true;
            }
            if (msg === MSG.THROWN || msg === MSG.DETACH) {
                if (len(V3.sub(this.pos, o.pos)) >= o.BP.mSLBeakLengthDamage) o.gotBeakDamage();
                this.holder = null;
                return true;
            }
        }
        return false;
    }
    perform(cue: number) {
        if (!(cue & CUE_MOVE)) return;
        const o = this.owner;
        this.pos.set(o.getJointTrans(26));
        this.pos.y = fr(this.pos.y - fr(this.damageHeight * 0.5));
        this.ensureTakeSituation();
        if (this.holder && !isZero(this.unkA4)) {
            this.pos.add(this.unkA4).fround();
            const d = this.holder.pos.clone().add(this.unkA4).fround();
            (this.holder as any).moveRequest?.(d);
            this.unkA4.zero();
        }
        if (this.holder) {
            const u = V3.sub(o.world.mario.pos, o.pos);
            if (!isZero(u)) vnorm(u); else u.set(0, 0, 1);
            const perp = new V3().cross(u, new V3(0, 1, 1)).fround();
            if (!isZero(perp)) vnorm(perp); else perp.set(1, 0, 0);
            const m = this.unk74;
            m[0] = perp.x; m[4] = perp.y; m[8] = perp.z;
            m[1] = 0; m[5] = 1; m[9] = 0;
            m[2] = u.x; m[6] = u.y; m[10] = u.z;
            const off = u.clone().scale(this.damageRadius).add(this.pos).fround();
            m[3] = off.x; m[7] = off.y; m[11] = off.z;
            const pull = len(V3.sub(this.pos, o.pos));
            if (o.unk190[3] !== 0 && pull >= o.BP.mSLBeakLengthPollute) this.holder.receiveMessage(this, MSG.DETACH);
            if (pull >= o.BP.mSLBeakLengthLimit && this.holder) { this.holder.receiveMessage(this, MSG.DETACH); o.gotBeakDamage(); }
        }
    }
}
function isNozzleWater(a: HitActor) {
    if (!a.isActorType(AT.WATER)) return false;
    const w = (a as any).world?.water;
    return w && w.checkParticleFlag ? w.checkParticleFlag(a, 0x40) : false;
}
/** TBGEyeHit: an eye (spray it: eye damage) */
export class BGEyeHit extends HitActor {
    constructor(public owner: BossGesso, public joint: number, name = '目') {
        super(name);
        owner.world.addToGroup('敵グループ', this);
        this.initHitActor(AT.BOSS_GESSO_BEAK, 1, HC.WATER, 0, 0, owner.BP.mSLEyeDamageRadius, owner.BP.mSLEyeDamageHeight);
        this.offHitFilter(HF.NO_COLLISION);
    }
    receiveMessage(sender: HitActor, msg: number) {
        const o = this.owner;
        if (o.mAttackMode === ASTATE_GUARD) return false;
        if (sender.actorType === AT.WATER && msg === MSG.SPRAYED_BY_WATER) { o.gotEyeDamage(); o.world.effect('enemyWaterHit', sender.pos); return true; }
        return o.receiveMessage(sender, msg);
    }
    perform(cue: number) { if (cue & CUE_CALC_ANIM) this.pos.set(this.owner.getJointTrans(this.joint)); }
}
/** TBGBodyHit */
export class BGBodyHit extends HitActor {
    constructor(public owner: BossGesso, public joint: number, name = '胴体') {
        super(name);
        owner.world.addToGroup('敵グループ', this);
        this.initHitActor(AT.BOSS_GESSO, 1, HC.PLAYER | HC.WATER, 300, 300, 300, 300);
        this.offHitFilter(HF.NO_COLLISION);
    }
    receiveMessage(sender: HitActor, msg: number) {
        if (sender.actorType === AT.WATER && msg === MSG.SPRAYED_BY_WATER) { this.owner.world.effect('enemyWaterHit', sender.pos); return true; }
        return this.owner.receiveMessage(sender, msg);
    }
    perform(cue: number) { if (cue & CUE_CALC_ANIM) this.pos.set(this.owner.getJointTrans(this.joint)); }
}

// ---------------------------------------------------------------- TBGTentacle
class TNode {
    pos = new V3(); vel = new V3(); unk18 = new V3(); unk24 = false;
    calcVelocity(t: BGTentacle, o: TNode, k: number) {
        const P = t.TP;
        const a8 = o.pos.clone().add(o.vel).fround();
        const d = V3.sub(this.pos, a8).fround();
        const nodeLen = t.getNodeLen(), lim = P.mNodeLenLimit;
        let dir = d.clone(), l: number;
        if (isZero(d)) { l = 0; dir.zero(); } else { l = psVecMag(d); vnorm(dir); }
        if (l > lim) {
            if (this.unk24) { if (!o.unk24) { dir.scale(lim).fround(); o.pos.add(dir).fround(); } }
            else { dir.scale(lim).fround(); this.pos.set(a8).add(dir).fround(); }
        } else {
            if (l < nodeLen) { let m = fr(nodeLen - l); if (m > P.mSpeedMax) m = P.mSpeedMax; l = fr(l + m); }
            else { let m = fr(l - nodeLen); if (m > P.mSpeedMax) m = P.mSpeedMax; l = fr(l - m); }
            dir.scale(l).fround();
            const goal = a8.clone().add(dir).fround();
            const v = V3.sub(goal, this.pos).fround().scale(k).fround();
            this.vel.scale(P.mInertiaProp).fround().add(v).fround();
        }
    }
    calcPosition(t: BGTentacle) {
        if (this.unk24) return;
        const s = t.mState;
        if (s === TS_STUN || s === TS_AMPUTEE || s === TS_FOLLOWBODY || s === TS_HELD) { this.pos.add(this.vel).fround(); return; }
        const d = V3.sub(this.unk18, this.pos).fround();
        const l2 = d.squared();
        if (l2 > fr(0.01)) {
            let k: number;
            if (l2 > 100000000) k = 1;
            else if (s === TS_SYNCBODY) k = t.mTime < 60 ? fr(fr(t.mTime * 0.5) / 60) : 0.5;
            else if (s === TS_ATTACK || s === TS_UNKA) k = t.mTime < 180 ? fr(fr(t.mTime * fr(0.4)) / 180) : fr(0.4);
            else if (s === TS_REST) k = t.mTime < 120 ? fr(fr(t.mTime * fr(0.05)) / 120) : fr(0.05);
            else { k = fr(psVecMag(d) * fr(0.00025)); k = fr(k * k); }
            if (k > 1) k = 1;
            d.scale(k).fround();
            this.vel.add(d).fround();
        }
        this.pos.add(this.vel).fround();
    }
}

/** TBGTakeHit: the tentacle's tip Mario grabs */
export class BGTakeHit extends TakeActor {
    unk74 = new V3(); unk80: Mtx = mtx();
    constructor(public owner: BGTentacle, name = 'イカ足（つかみ）') {
        super(name);
        const w = owner.owner.world, P = owner.TP;
        w.addToGroup('敵グループ', this);
        this.initHitActor(AT.BOSS_GESSO_TENTACLE, 1, HC.PLAYER, P.mAttackRadius, P.mAttackHeight, P.mDamageRadius, P.mDamageHeight);
        this.offHitFilter(HF.NO_COLLISION);
    }
    enableAttackCheck() { this.offHitFilter(HF.NO_ATTACK); }
    disableAttackCheck() { this.onHitFilter(HF.NO_ATTACK); }
    getTakingMtx() { return this.unk80; }
    moveRequest(to: V3) {
        const t = this.owner, w = t.owner.world;
        const n = to.clone();
        const xz = { x: n.x, z: n.z };
        w.isTouchedOneWallAndMoveXZ(xz, n.y, 150);
        n.x = xz.x; n.z = xz.z;
        const d = V3.sub(n, t.owner.pos).fround();
        if (len(d) > t.TP.mTotalLenLimit) {
            const m = w.mario as any, yaw = m.mIntendedYaw || 0, mag = m.mIntendedMag || 0;
            const r = fr(mag * t.owner.BP.mSLTentacleStretch);
            this.unk74 = new V3(fr(r * JMASSin(Math.trunc(fr(yaw * fr(65536 / 360))))), 0, fr(r * JMASCos(Math.trunc(fr(yaw * fr(65536 / 360))))));
            const back = V3.sub(t.owner.pos, n).fround();
            if (back.dot(this.unk74) < 0) t.incDamage();
            t.lastNode().pos.set(n);
            return false;
        }
        t.lastNode().pos.set(n);
        return true;
    }
    receiveMessage(sender: HitActor, msg: number) {
        const t = this.owner;
        if (sender.actorType !== AT.MARIO) return false;
        if (msg === MSG.TAKE) {
            const a = sender as TakeActor;
            if (a.held && a.held !== this) return false;
            if (t.canTake()) { this.holder = a; t.changeStateAndFixNodes(TS_HELD); return true; }
        }
        if (msg === MSG.THROWN || msg === MSG.DETACH) {
            this.holder = null;
            if (t.mState !== TS_AMPUTEE) t.returnToDefaultState();
            return true;
        }
        if (msg === MSG.TRAMPLE || msg === MSG.HIP_DROP) {
            const s = t.mState;
            if (s !== TS_AMPUTEE && s !== TS_STUN && s !== TS_HELD && s !== TS_HIDE && s !== TS_UNKA) { t.changeStateAndFixNodes(TS_STUN); return true; }
        }
        return false;
    }
    perform(cue: number) {
        if (!(cue & CUE_MOVE)) return;
        const t = this.owner, w = t.owner.world;
        this.pos.set(t.spline.getPoint(1));
        this.pos.y = fr(this.pos.y - fr(this.damageHeight * 0.5));
        this.ensureTakeSituation();
        if (this.holder) {
            const J = t.handJoints, m = J[J.length - 1];
            const v1 = new V3(m[0], m[4], m[8]);
            const v2 = jnorm(new V3().cross(new V3(0, 1, 0), v1).fround());
            const v3 = jnorm(new V3().cross(v2, new V3(0, 1, 0)).fround());
            const M = this.unk80;
            M[0] = v2.x; M[4] = v2.y; M[8] = v2.z;
            M[1] = 0; M[5] = 1; M[9] = 0;
            M[2] = v3.x; M[6] = v3.y; M[10] = v3.z;
            v3.scale(this.damageRadius).fround();
            const tip = new V3(m[3], m[7], m[11]).add(v3).fround();
            M[3] = tip.x; M[7] = tip.y; M[11] = tip.z;
            const p = t.lastNode().vel.clone(); p.y = 0; p.scale(fr(0.1)).fround();
            if (!isZero(this.unk74)) { t.lastNode().vel.add(this.unk74).fround(); p.add(this.unk74).fround(); }
            p.add(this.holder.pos).fround();
            const xz = { x: p.x, z: p.z };
            w.isTouchedOneWallAndMoveXZ(xz, p.y, 150);
            p.x = xz.x; p.z = xz.z;
            (this.holder as any).moveRequest?.(p);
            this.unk74.zero();
        }
        if (t.isAttacking()) t.attackCollisions(this);
        if (t.mState !== TS_HELD && t.mState !== TS_AMPUTEE && this.holder) this.holder.receiveMessage(this, MSG.DETACH);
    }
}
/** TBGAttackHit: one of five hits sliding along the tentacle */
export class BGAttackHit extends HitActor {
    constructor(public owner: BGTentacle, public posOnSpline: number, name = 'イカ足（当たり）') {
        super(name);
        owner.owner.world.addToGroup('敵グループ', this);
        this.initHitActor(AT.BOSS_GESSO_TAKE_HIT, 1, HC.PLAYER, 50, 50, 50, 50);
        this.offHitFilter(HF.NO_COLLISION);
    }
    perform(cue: number) {
        if (!(cue & CUE_MOVE)) return;
        this.pos.set(this.owner.spline.getPoint(this.posOnSpline));
        if (this.owner.isAttacking()) this.owner.attackCollisions(this);
    }
}

export class BGTentacle extends NameRef {
    mState = TS_WAIT; mTime = 0; mDamageCount = 0;
    nodes: TNode[] = [];
    spline: SplinePath;
    /** unk2C the tentacle drawn, unk80 the attack guide (its BCK's joints are the slap's targets) */
    hand: BGModel; shand: MActor | null;
    TP: any;
    takeHit: BGTakeHit;
    attackHits: BGAttackHit[] = [];
    unk40 = 0; unk44 = 0; unk48 = 0; unk4C = 0;
    /** the attack guide's base matrix and its joints as last calculated */
    shandBase: Mtx = mtx(); shandJoints: Mtx[] = [];
    /** the drawn tentacle's joints (TBGTentacleMtxCalc), as last calculated */
    handJoints: Mtx[] = [];
    unk84 = new V3();
    constructor(public owner: BossGesso, public nodeNum: number, public index: number) {
        super('あし');
        for (let i = 0; i < nodeNum; i++) this.nodes.push(new TNode());
        this.TP = readParams('/enemy/tentacle.prm', owner.world.files, TENT_PARAMS);
        this.spline = new SplinePath(nodeNum);
        this.unk40 = Math.trunc(fr(MsRandF() * 360));
        this.unk44 = Math.trunc(fr(MsRandF() * 360));
        this.hand = new BGModel(owner.world, owner.createMActorByName('bgeso_hand.bmd'));
        this.shand = owner.createMActorByName('bgeso_shand.bmd');
        const nj = this.handJointNum();
        for (let i = 0; i < nj; i++) this.handJoints.push(mtx());
        this.takeHit = new BGTakeHit(this);
        for (let i = 0; i < 5; i++) this.attackHits.push(new BGAttackHit(this, fr(i / 5)));
    }
    handJointNum() { const a = this.hand.mactor; const sk = a ? Skeleton.of(a.data.files.scene(a.model)) : null; return sk ? sk.names.length : 1; }
    firstNode() { return this.nodes[0]; }
    lastNode() { return this.nodes[this.nodeNum - 1]; }
    isThing() { return this.mState === TS_AMPUTEE || this.mState === TS_HIDE || this.mState === TS_HELD; }
    isThing2() { return this.mState === TS_AMPUTEE || this.mState === TS_HIDE; }
    /** what touches an attacking tentacle: thrown (rolling, skipping rope) or attacked */
    attackCollisions(h: HitActor) {
        const o = this.owner, m = o.world.mario as any;
        for (const c of h.collisions.slice()) {
            if (h === this.takeHit && !c.isActorType(AT.MARIO)) continue;
            if (typeof m.isRoofing === 'function' && m.isRoofing()) continue;
            if (o.mAttackMode === ASTATE_ROLL) this.throwMario(c, h);
            else if (o.mAttackMode === ASTATE_SKIP_ROPE) this.throwMario(c, o);
            else c.receiveMessage(h, MSG.ATTACK);
        }
    }
    incDamage() {
        if (this.mState !== TS_AMPUTEE) this.changeStateAndFixNodes(TS_HELD);
        if (this.mDamageCount < this.TP.mDamageCountMax) this.mDamageCount += 1;
    }
    throwMario(c: HitActor, from: HitActor) {
        const d = V3.sub(c.pos, from.pos).fround();
        jnorm(d); d.scale(2).fround(); d.y = fr(d.y + 1);
        const m = this.owner.world.mario as any;
        m.receiveMessage(from, MSG.ATTACK);
        m.receiveMessage(from, MSG.THROWN);
        if (typeof m.throwMario === 'function') m.throwMario(d, 60);
        this.owner.showMessage(0xE0005);
        this.owner.stopIfRoll();
    }
    isAttacking() {
        if (this.takeHit.checkHitFilter(HF.NO_ATTACK)) return false;
        const s = this.mState;
        if (s === TS_UNKA || s === TS_AMPUTEE || s === TS_HIDE) return false;
        return s === TS_ATTACK || this.owner.mAttackMode === ASTATE_ROLL;
    }
    canTake() { const s = this.mState; return !(s === TS_UNKA || s === TS_AMPUTEE || s === TS_HIDE); }
    getNodeLen() { return this.mState === TS_AMPUTEE ? this.TP.mDamageNodeLength : this.TP.mNodeLength; }
    beatNode(i: number, v: V3) {
        this.nodes[i].vel.set(v);
        const k = this.mState === TS_AMPUTEE ? this.TP.mDamageReflectProp : this.TP.mReflectProp;
        const N = this.nodeNum, n = this.nodes;
        for (let a = i + 1; a < N; ++a) {
            n[a].calcVelocity(this, n[a - 1], k);
            if (n[a].unk24) { for (let b = a - 1; b >= 0; --b) n[b].calcVelocity(this, n[b + 1], k); break; }
        }
        for (let a = i - 1; a >= 0; --a) {
            n[a].calcVelocity(this, n[a + 1], k);
            if (n[a].unk24) { for (let b = a + 1; b < N; ++b) n[b].calcVelocity(this, n[b - 1], k); break; }
        }
    }
    setAttackTarget() {
        const o = this.owner, w = o.world, m = w.mario as any;
        this.unk84.set(w.mario.pos);
        if (o.mAttackMode === ASTATE_UNISON) {
            const k = [-2, -1, 2, 1][this.index] ?? 0;
            const d = V3.sub(this.unk84, o.pos).fround();
            const side = jnorm(new V3().cross(new V3(0, 1, 0), d).fround());
            this.unk84.add(side.scale(fr(k * 80))).fround();
        }
        if (o.is2ndFightNow() && this.unk84.y < fr(o.pos.y + 20)) this.unk84.y = fr(o.pos.y + 20);
        const onGround = (typeof m.isTouchGround4cm === 'function' ? m.isTouchGround4cm() : w.mario.pos.y <= w.mario.groundHeight + 4) || (typeof m.isRoofing === 'function' && m.isRoofing());
        const s = this.shand!;
        if (o.mAttackMode === ASTATE_UNISON) s.setBckFromIndex(onGround ? BCK_SHAND_ISSEI : BCK_SHAND_FLY);
        else if (o.mAttackMode === ASTATE_DOUBLE) s.setBckFromIndex(BCK_SHAND_ISSEI);
        else if (o.mAttackMode === ASTATE_SKIP_ROPE) s.setBckFromIndex(BCK_SHAND_JUMP);
        else s.setBckFromIndex(onGround ? BCK_SHAND_ATTACK : BCK_SHAND_FLY);
        const c = s.getFrameCtrl(ANM_BCK);
        if (c) c.rate = fr(o.getAttackSpeed() * 2);   // (SMSGetAnmFrameRate)
        this.unk4C = 0;
    }
    changeStateAndFixNodes(s: number) {
        if (this.mState === s) return;
        this.mState = s; this.mTime = 0;
        const n = this.nodes, N = this.nodeNum, o = this.owner;
        for (const x of n) x.unk24 = false;
        switch (s) {
            case TS_ATTACK: n[0].unk24 = true; this.setAttackTarget(); break;
            case TS_AMPUTEE:
                n[N - 1].unk24 = true;
                if (this.unk48) break;
                o.gotTentacleDamage();
                this.unk48 = 1; this.mDamageCount = 0;
                o.world.effect('ms_boge_damage', o.getJointTrans([8, 14, 28, 34][this.index]));
                break;
            case TS_STUN:
                n[0].unk24 = true;
                if (o.mAttackMode === ASTATE_UNK6) n[1].unk24 = true;
                for (const x of n) x.vel.zero();
                break;
            case TS_HELD: n[0].unk24 = true; n[N - 1].unk24 = true; break;
            case TS_UNKA: n[0].unk24 = true; this.shand!.setBckFromIndex(BCK_SHAND_GUARD); break;
            case TS_WAIT: case TS_REST: case TS_FOLLOWBODY: case TS_SYNCBODY: n[0].unk24 = true; break;
            case TS_GUARD: n[0].unk24 = true; n[1].unk24 = true; break;
            case TS_HIDE: n[0].unk24 = true; this.mDamageCount = 0; this.unk48 = 0; break;
        }
        if (s === TS_HIDE) this.takeHit.onHitFilter(HF.NO_COLLISION); else this.takeHit.offHitFilter(HF.NO_COLLISION);
        if (s === TS_GUARD) this.takeHit.disableAttackCheck();
        this.takeHit.offHitFilter(HF.NO_DAMAGE);
    }
    returnToDefaultState() { this.changeStateAndFixNodes(this.owner.mAttackMode === ASTATE_UNK6 ? TS_GUARD : TS_WAIT); }
    moveNode() {
        const P = this.TP, o = this.owner, w = o.world;
        let f = P.mVibrationForce, sp = P.mVibrationSpeed;
        if (this.mState === TS_AMPUTEE) { f = fr(f * P.mDamagePropF); sp = fr(sp * P.mDamagePropS); }
        this.unk40 = MsWrap(fr(this.unk40 + sp), 0, 360);
        this.unk44 = MsWrap(fr(this.unk44 + fr(sp * fr(1.3))), 0, 360);
        const s40 = MsSin(this.unk40), s44 = MsSin(this.unk44), c44 = MsCos(this.unk44);
        let v: V3;
        switch (this.index) {
            case 0: v = new V3(fr(fr(s40 * fr(-1.9)) * f), fr(fr(s40 * 1) * f), fr(fr(c44 * fr(1.8)) * f)); break;
            case 1: v = new V3(fr(fr(s40 * -1) * f), fr(fr(s44 * fr(0.8)) * f), fr(fr(c44 * fr(1.1)) * f)); break;
            case 3: v = new V3(fr(fr(s40 * 1) * f), fr(fr(s44 * fr(0.8)) * f), fr(fr(c44 * fr(1.1)) * f)); break;
            default: v = new V3(fr(fr(s40 * fr(1.9)) * f), fr(fr(s40 * 1) * f), fr(fr(c44 * fr(1.8)) * f)); break;
        }
        const N = this.nodeNum;
        if (this.mState === TS_STUN) {
            for (const x of this.nodes) { x.vel.x = 0; x.vel.z = 0; x.vel.y = fr(x.vel.y - o.getGravityY()); }
        } else if (this.mState === TS_HELD) this.beatNode(N - 1, v);
        else { this.beatNode(N - 1, v); v.scale(-1); this.beatNode(N - 3, v); }
        for (let i = 0; i < N; i++) {
            const node = this.nodes[i];
            node.calcPosition(this);
            if ((i === 0 || i === 1) && o.mAttackMode === ASTATE_UNK6) continue;
            const p = node.pos.clone();
            const xz = { x: p.x, z: p.z };
            w.isTouchedOneWallAndMoveXZ(xz, p.y, 150);
            p.x = xz.x; p.z = xz.z;
            let g: number;
            if ((w.map === 3 && w.stage === 0) || w.map === 59) g = w.checkGround(p.x, fr(p.y + 200), p.z)[0];
            else if (o.is2ndFightNow()) g = o.pos.y;
            else if (w.map === 9 && w.stage === 1) { g = w.checkGround(p.x, fr(o.pos.y + 500), p.z)[0]; if (g < o.pos.y) g = o.pos.y; }
            else g = w.checkGround(p.x, fr(o.pos.y + 500), p.z)[0];
            g = fr(g + 20);
            if (p.y < g) { node.vel.zero(); p.y = g; }
            if (this.mState === TS_STUN && p.y < o.pos.y) p.y = fr(o.pos.y + 10);
            const c8 = o.pos.clone();
            if (c8.y < p.y) {
                c8.sub(p).fround();
                const thing = fr(o.bodyScale * o.bodyRadius);
                if (len(c8) < thing) { jnorm(c8); c8.scale(thing).fround(); p.add(c8).fround(); }
            }
            node.pos.set(p);
        }
        for (let i = 0; i < N; i++) this.spline.setPoint(i, this.nodes[i].pos);
    }
    moveConstraint() {
        const o = this.owner, w = o.world, n = this.nodes, N = this.nodeNum;
        switch (this.mState) {
            case TS_ATTACK: {
                for (let i = 0; i < N; i++) if (this.shandJoints[i]) n[i].unk18.set(trans(this.shandJoints[i]));
                const B = o.BP;
                const k = o.beakHeld() ? B.mSLBeakHoming : o.mAttackMode === ASTATE_UNISON ? B.mSLUnisonHoming : B.mSLSingleHoming;
                if (this.mTime < k && o.mAttackMode !== ASTATE_UNISON) { this.unk84.x = w.mario.pos.x; this.unk84.z = w.mario.pos.z; }
                break;
            }
            case TS_UNKA: for (let i = 0; i < N; i++) if (this.shandJoints[i]) n[i].unk18.set(trans(this.shandJoints[i])); break;
            case TS_STUN: if (o.mAttackMode === ASTATE_UNK6) return;
            // fallthrough
            case TS_WAIT: case TS_REST: case TS_SYNCBODY:
                if (o.checkLiveFlag(LF.CLIPPED_OUT)) {
                    const p = o.pos.clone();
                    for (let i = 0; i < N; i++) { n[i].unk18.set(p); p.y = fr(p.y + this.getNodeLen()); }
                } else {
                    const j0 = [8, 14, 28, 34][this.index];
                    for (let i = 0; i < N; i++) n[i].unk18.set(o.getJointTrans(i + j0));
                }
                break;
            case TS_GUARD: {
                const p = n[0].pos.clone();
                n[0].unk18.set(p);
                for (let i = 1; i < N; i++) { p.x = fr(p.x - fr(this.getNodeLen() * fr(1.3))); p.y = fr(p.y - fr(this.getNodeLen() * 1.5)); n[i].unk18.set(p); }
                break;
            }
            case TS_HIDE: {
                const p = o.pos.clone();
                for (let i = 0; i < N; i++) { n[i].unk18.set(p); p.y = fr(p.y + fr(0.5 * this.getNodeLen())); }
                break;
            }
        }
    }
    decideOwnState() {
        const o = this.owner, B = o.BP;
        switch (this.mState) {
            case TS_ATTACK: if (this.shand!.curAnmEndsNext(ANM_BCK)) this.changeStateAndFixNodes(TS_REST); break;
            case TS_STUN: {
                const d = V3.sub(this.lastNode().pos, o.pos);
                const r = MsGetRotFromZaxisY(d);
                if (Math.abs(MsAngleDiff(o.rot.y, r)) > 45) this.changeStateAndFixNodes(TS_REST);
                if (this.mState === TS_STUN && this.mTime >= B.mSLStunTime) this.returnToDefaultState();
            }
            // fallthrough
            case TS_WAIT: case TS_REST:
                if (this.mState === TS_REST && this.mTime >= B.mSLRestTime) this.returnToDefaultState();
                break;
            case TS_AMPUTEE: {
                const t = B.mSLAmputeeTime;
                if (this.mTime >= t) { this.changeStateAndFixNodes(TS_HIDE); break; }
                if (this.mTime >= t - 240 && this.takeHit.holder) this.takeHit.holder.receiveMessage(this.takeHit, MSG.DETACH);
                break;
            }
        }
    }
    checkDamage() {
        if (this.mDamageCount >= this.TP.mDamageCountMax) {
            const o = this.owner;
            if (o.mAttackMode === ASTATE_UNK6) o.world.events.push({ t: o.world.tickCount, kind: 'streamingMovie', data: { id: 10 } });
            o.unk1A8 = o.BP.mSLAmputeeWait;
            this.changeStateAndFixNodes(TS_AMPUTEE);
        }
    }
    calcAtkParticleAndSE() {
        const s = this.shand!, o = this.owner, w = o.world;
        const fc = s.getFrameCtrl(ANM_BCK);
        const f = fc ? fc.frame : 0;
        if ((s.checkCurBckFromIndex(BCK_SHAND_ATTACK) || s.checkCurBckFromIndex(BCK_SHAND_ISSEI)) && this.unk4C === 0) {
            if ((s.checkCurBckFromIndex(BCK_SHAND_ATTACK) && 118 <= f && f <= 160) || (s.checkCurBckFromIndex(BCK_SHAND_ISSEI) && 75 <= f && f <= 110)) {
                const p = this.lastNode().pos.clone();
                const [g] = w.checkGround(p.x, fr(p.y + 500), p.z);
                if (p.y < fr(g + 100)) {
                    p.y = fr(g + 5);
                    w.effect('ms_boge_attack', p);
                    this.unk4C = 1;
                    w.sound(SE.BS_GESO_ATK_IMPACT, this.takeHit.pos);
                }
            }
        }
        if (fc && s.checkBckPass(fr(fc.end - this.TP.mAtkSoundTime)) && this.mState !== TS_UNKA) {
            w.sound(SE.BS_GESO_ATK, this.takeHit.pos);
            if (!o.unk1AC) { o.unk1AC = 0xF0; w.sound(SE.BS_GESO_VO_ATTACK, o.pos); }
        }
    }
    decideAtkColExists() {
        this.takeHit.disableAttackCheck();
        const s = this.shand!, fc = s.getFrameCtrl(ANM_BCK), f = fc ? fc.frame : 0;
        let on = false;
        if (this.mState === TS_UNKA) on = true;
        else if (this.owner.mAttackMode === ASTATE_ROLL) on = true;
        else if (s.checkCurBckFromIndex(BCK_SHAND_FLY)) on = 75 <= f && f <= 130;
        else if (s.checkCurBckFromIndex(BCK_SHAND_ISSEI)) on = 75 <= f && f <= 110;
        else if (s.checkCurBckFromIndex(BCK_SHAND_ATTACK)) on = 75 <= f && f <= 130;
        else if (s.checkCurBckFromIndex(BCK_SHAND_JUMP)) on = 80 <= f && f <= 220;
        if (on) this.takeHit.enableAttackCheck(); else this.takeHit.disableAttackCheck();
    }
    calcShandJoints() {
        const s = this.shand!;
        const all = s.anmMtxAll(this.shandBase, new V3(1, 1, 1));
        this.shandJoints = all ? all.map(rowMajor) : [];
    }
    calcAttackGuideAnm() {
        const s = this.mState;
        if (s !== TS_ATTACK && s !== TS_SYNCBODY && s !== TS_UNKA) return;
        const o = this.owner, sh = this.shand!;
        const p0 = this.firstNode().pos.clone();
        const d = V3.sub(this.unk84, p0).fround();
        const r = MsGetRotFromZaxis(d.clone());
        let zs: number;
        if (s === TS_UNKA) zs = 1;
        else if (sh.checkCurBckFromIndex(BCK_SHAND_ATTACK)) zs = fr(len(d) * fr(1 / 1500));
        else zs = fr(len(d) * fr(1 / 1200));
        if (zs > 2) zs = 2;
        const m = mtx();
        MsMtxSetTRS(m, p0.x, p0.y, p0.z, r.x, r.y, r.z, 1, 1, zs);
        const z = mtx();
        const table = s === TS_UNKA ? [80, 60, -80, -60] : (o.mAttackMode === ASTATE_UNISON || o.mAttackMode === ASTATE_DOUBLE) ? [65, 40, -65, -40] : o.mAttackMode === ASTATE_SKIP_ROPE ? [80, 70, -80, -70] : [20, 7.5, -20, -7.5];
        MsMtxSetRotZ(z, table[this.index]);
        MTXConcat(m, z, m);
        this.shandBase = m;
        sh.frameUpdate();
        this.calcShandJoints();
        this.calcAtkParticleAndSE();
    }
    resetAllNodes(p: V3) {
        const q = p.clone();
        this.firstNode().unk24 = true;
        for (const n of this.nodes) { n.pos.set(q); n.unk18.set(q); n.vel.zero(); q.y = fr(q.y + this.getNodeLen()); }
        this.hand.scale.set(1, 1, 1);
        this.shand!.setBckFromIndex(BCK_SHAND_ATTACK);
        const m = mtx(); m[3] = p.x; m[7] = p.y; m[11] = p.z;
        this.shandBase = m;
        this.calcShandJoints();
    }
    /** TBGTentacleMtxCalc: each drawn joint on the spline, facing the next (the next joint's last place), scaled with its stretch */
    calcHandJoints() {
        const N = this.handJoints.length, last = N - 1;
        const prev = this.handJoints.map((m) => Float64Array.from(m));
        const cur = this.handJoints;
        for (let i = 0; i < N; i++) {
            const p = this.spline.getPoint(fr(i / last));
            let x: V3;
            if (i === last) {
                const d = V3.sub(trans(cur[i - 1]), trans(cur[i - 2])).fround();
                x = !isZero(d) ? vnorm(d) : new V3(1, 0, 0);
            } else {
                const d = V3.sub(trans(prev[i + 1]), p).fround();
                x = !isZero(d) ? vnorm(d) : new V3(1, 0, 0);
            }
            let k = 1;
            let y: V3;
            if (i === 0) y = new V3(0, 1, 0);
            else {
                const m1 = cur[i - 1];
                const z1 = new V3(m1[2], m1[6], m1[10]);
                y = new V3().cross(x, z1).fround();
                if (y.squared() < fr(0.01)) y = new V3(m1[1], m1[5], m1[9]);
                vnorm(y);
                const dd = V3.sub(trans(m1), p).fround();
                const l = psVecMag(dd);
                k = l === 0 ? 1 : fr(this.getNodeLen() / fr(l * 3));
                const t1 = new V3(m1[0], m1[4], m1[8]), t2 = new V3(m1[1], m1[5], m1[9]);
                if (i < last && t1.dot(x) > 0 && t2.dot(y) < 0) y.scale(-1);
            }
            let z = new V3().cross(x, y).fround();
            if (!isZero(z)) vnorm(z); else z = new V3(0, 0, 1);
            if ((i === last || i === N - 2) && k < 1) k = 1;
            if (Math.abs(k) > fr(0.01)) k = fr(k * force25(frsqrte(k)));
            k = MsClamp(k, fr(0.7), fr(1.2));
            x.scale(k).fround(); y.scale(k).fround(); z.scale(k).fround();
            if (this.mState === TS_STUN && (i === last || i === N - 2)) {
                y = new V3(0, fr(0.3), 0);
                x = vnorm(new V3().cross(y, z).fround());
                z = vnorm(new V3().cross(x, y).fround()).scale(2).fround();
            }
            const m = cur[i];
            m[0] = x.x; m[4] = x.y; m[8] = x.z;
            m[1] = y.x; m[5] = y.y; m[9] = y.z;
            m[2] = z.x; m[6] = z.y; m[10] = z.z;
            m[3] = p.x; m[7] = p.y; m[11] = p.z;
        }
        this.hand.setJoints(cur.map(colMajor));
    }
    perform(cue: number) {
        this.takeHit.perform(cue);
        if (cue & CUE_MOVE) for (const h of this.attackHits) { let p = fr(h.posOnSpline + fr(0.05)); if (p > fr(0.8)) p = fr(p - fr(0.8)); h.posOnSpline = p; }
        for (const h of this.attackHits) h.perform(cue);
        if (cue & CUE_CALC_ANIM) this.calcAttackGuideAnm();
        if (cue & CUE_MOVE) {
            this.decideAtkColExists();
            this.moveConstraint();
            this.moveNode();
            this.decideOwnState();
            this.checkDamage();
            ++this.mTime;
        }
        const o = this.owner;
        if ((cue & CUE_MOVE) && this.mState === TS_AMPUTEE && this.mTime < o.BP.mSLAmputeeTime - 240) o.world.sound(SE.BS_GESO_TAKEN_HAND, this.takeHit.pos);
        // (drawn but for the blinking end of TSTATE_AMPUTEE; not at all hidden)
        const blink = this.mState === TS_AMPUTEE && this.mTime >= o.BP.mSLAmputeeTime - 240 && this.mTime % 6 >= 3;
        this.hand.shown = this.mState !== TS_HIDE && !blink && !o.checkLiveFlag(LF.DEAD);
        if (this.mState !== TS_HIDE && (cue & CUE_CALC_ANIM)) { if (this.hand.mactor) this.hand.mactor.frameUpdate(); this.calcHandJoints(); }
    }
}

// ---------------------------------------------------------------- TBGCork
class BGCork {
    kolk: BGModel; brk: BGModel; unkC = 0;
    constructor(public owner: BossGesso) {
        this.kolk = new BGModel(owner.world, owner.createMActorByName('bgeso_kolk.bmd'));
        this.brk = new BGModel(owner.world, owner.createMActorByName('bgeso_kolk_break.bmd'));
    }
    crush() {
        if (this.unkC) return;
        if (this.brk.mactor) this.brk.mactor.setBckFromIndex(BCK_KOLK_BREAK);
        this.kolk.baseTR.set(this.brk.baseTR);
        this.unkC = 1;
    }
    perform(cue: number) {
        const o = this.owner, alive = !o.checkLiveFlag(LF.DEAD);
        this.kolk.shown = alive && this.unkC === 0;
        this.brk.shown = alive && this.unkC !== 0;
        const c = this.unkC === 0 ? this.kolk : this.brk;
        if ((cue & CUE_CALC_ANIM) && this.unkC === 0 && o.joints && o.joints[27]) this.kolk.baseTR.set(rowMajor(o.joints[27]));
        if ((cue & CUE_CALC_ANIM) && c.mactor) c.mactor.frameUpdate();
    }
}

// ---------------------------------------------------------------- TBossGesso
export class BossGessoManager extends EnemyManager {
    constructor(w: World, name = 'ボスゲッソーマネージャ') { super(w, name); }
    load(s: Stream) {
        this.saveParams = readParams('/enemy/bossgesso.prm', this.world.files, BG_PARAMS);
        super.load(s);
    }
    createModelData() {
        this.createModelDataArray(['bgeso_body.bmd', 'bgeso_hand.bmd', 'bgeso_shand.bmd', 'bgeso_dirty_white.bmd', 'bgeso_osenball.bmd', 'bgeso_osenball_white.bmd', 'bgeso_kolk.bmd', 'bgeso_kolk_break.bmd']);
    }
    createEnemyInstance(): SpineEnemy | null { return null; }
}

export class BossGesso extends SpineEnemy {
    tentacles: BGTentacle[] = [];
    mBeak: BGBeakHit | null = null;
    mAttackMode = 0; mTimeInCurrentAttackMode = 0;
    mLeftEye: BGEyeHit | null = null; mRightEye: BGEyeHit | null = null;
    /** unk178 the goop stamp model (bgeso_dirty_white), unk17C stamping */
    unk178: MActor | null = null; unk17C = 0;
    mPolDrop: BGPolDrop | null = null; mBody: BGBodyHit | null = null;
    /** unk188 the motion blend's speed, unk190 its KCOLOR0 (the goop: alpha 230 while it's dirty) */
    unk188 = 0; mCork: BGCork | null = null; unk190 = [0, 0, 0, 0xE6];
    /** unk194 wash effect frames, unk195 shots since, unk196 rolls, unk198 balloons shown, unk19C ticks near (hint), unk1A0 hint shown, unk1A1 rolling all */
    unk194 = 0; unk195 = 0; unk196 = 0; unk198 = 0; unk19C = 0; unk1A0 = 0; unk1A1 = 0;
    unk1A4 = 0; unk1A8 = 0; unk1AC = 0; unk1AE = 0;
    /** TBossGessoMtxCalc (M3UMtxCalcSIAnmBlendQuat, basic) */
    mc = { newIdx: -1, oldIdx: -1, oldFrame: 0, ratio: 0 };
    joints: mat4[] | null = null;
    locals: mat4[] = [];
    get BP(): any { return this.getSaveParam(); }
    get tevColor0() { return null; }
    constructor(w: World, name = 'ボスゲッソー') {
        super(w, name);
        this.binder = { bind: (a: LiveActor) => bgBind(a as BossGesso) } as any;
        this.turnSpeed = fr(0.2);
    }
    init(m: LiveManager | null) {
        if (!m) return;
        this.manager = m;
        m.manageActor(this);
        this.mactor = this.createMActorByName('bgeso_body.bmd');
        for (let i = 0; i < 4; i++) this.tentacles.push(new BGTentacle(this, 6, i));
        this.mBeak = new BGBeakHit(this);
        this.mLeftEye = new BGEyeHit(this, 7);
        this.mRightEye = new BGEyeHit(this, 4);
        this.mBody = new BGBodyHit(this, 0);
        this.initHitActor(AT.BOSS_GESSO, 5, HC.PLAYER | HC.WATER, 300, 300, 300, 300);
        this.onHitFilter(HF.NO_COLLISION);
        this.spine!.initWith(BGNerves.wait);
        this.calcJoints();
        this.unk178 = this.createMActorByName('bgeso_dirty_white.bmd');
        this.mPolDrop = new BGPolDrop(this.world, this.createMActorByName('bgeso_osenball_white.bmd'), this.createMActorByName('bgeso_osenball.bmd'));
        this.mCork = new BGCork(this);
        this.reset();
        this.hitPoints = this.BP ? this.BP.mSLHitPointMax : 1;
        this.offLiveFlag(LF.ENABLE_CLIPPING);
        this.onLiveFlag(LF.UNK8);
        this.scaledBodyRadius = 330;
        this.unk190 = [0, 0, 0, 0xE6];
    }
    getJointTrans(i: number) {
        const m = this.joints && this.joints[i];
        return m ? new V3(fr(m[12]), fr(m[13]), fr(m[14])) : this.pos.clone();
    }
    /** MActor::calc with TBossGessoMtxCalc: the beak (joint 26) follows Mario's pull */
    calcJoints() {
        const a = this.mactor;
        if (!a) return;
        const sk = Skeleton.of(a.data.files.scene(a.model));
        if (!sk) return;
        const bck = (i: number) => { const e = a.data.anms[ANM_BCK][i]; return e ? parseBCK(a.data.files.scene(a.data.folder + '/' + e.name + '.bck')) : null; };
        const mc = this.mc, fc = a.getFrameCtrl(ANM_BCK);
        const nw = mc.newIdx >= 0 ? { anm: bck(mc.newIdx), frame: fc ? fc.frame : 0 } : null;
        const old = mc.oldIdx >= 0 ? { anm: bck(mc.oldIdx), frame: mc.oldFrame } : null;
        let beakScale = 1;
        this.joints = jointMatricesBlend(sk, nw, old, mc.ratio, true, this.baseTR, [this.scale.x, this.scale.y, this.scale.z], this.joints || [], this.locals, (j, m) => {
            if (j !== 26) return;
            const b = this.mBeak;
            if (b && b.isTaken()) {
                m[12] = b.pos.x; m[13] = fr(b.pos.y + 50); m[14] = b.pos.z;
                const d = V3.sub(b.pos, this.pos).fround();
                let k = psVecMag(d);
                k = k > 0 ? fr(300 / k) : 1;
                if (k > 1) k = 1;
                beakScale = k;   // (its X and Z columns: the joint only, after its children took it)
            } else if (this.mAttackMode === ASTATE_GUARD) {
                m[0] = fr(m[0] * fr(0.02)); m[1] = fr(m[1] * fr(0.02)); m[2] = fr(m[2] * fr(0.02));
            }
        });
        if (beakScale !== 1 && this.joints[26]) { const m = this.joints[26]; for (const i of [0, 1, 2, 8, 9, 10]) m[i] = fr(m[i] * beakScale); }
    }
    rumblePad(_k: number, _p: V3) { }
    lenFromToeToMario() {
        let min = 100000;
        for (const t of this.tentacles) { if (t.isThing2()) continue; const l = len(t.lastNode().pos); if (l < min) min = l; }
        return min;
    }
    showMessage(msg: number) {
        const idx = msg === 0xE0028 ? 3 : msg - 0xE0003;
        const flag = msg === 0xE0003 ? 0 : 1 << idx;
        if ((this.unk198 & flag) === 0) this.world.effect('balloon:' + msg.toString(16), this.pos);
        this.unk198 |= flag;
    }
    checkTakeMsg() {
        if (!this.unk1A0 && !this.is2ndFightNow() && this.mAttackMode === ASTATE_UNK6) {
            if (V3.sub(this.world.mario.pos, this.pos).squared() < 4000000) {
                this.unk19C++;
                if (this.unk19C >= 1200) { this.showMessage(0xE0004); this.unk1A0 = 1; }
            }
        }
    }
    changeBck(i: number) {
        const a = this.mactor!, mc = this.mc, c0 = a.getFrameCtrl(ANM_BCK);
        if (mc.newIdx !== i) { mc.oldIdx = mc.newIdx; mc.oldFrame = c0 ? c0.frame : 0; mc.newIdx = i; mc.ratio = 1; }
        a.setBckFromIndex(i);
        const c = a.getFrameCtrl(ANM_BCK);
        if (c) this.unk188 = fr(10 / c.end);
    }
    inSightAngle(angle: number) {
        const r = MsGetRotFromZaxisY(V3.sub(this.world.mario.pos, this.pos));
        return Math.abs(MsAngleDiff(r, this.rot.y)) < fr(0.5 * angle);
    }
    inSight() { return this.inSightAngle(this.BP.mSLSightAngle); }
    is2ndFightNow() { return this.world.stage === 4; }
    stopIfRoll() {
        if (this.mAttackMode !== ASTATE_ROLL) return;
        this.changeAttackMode(ASTATE_SINGLE);
        this.spine!.reset(); this.spine!.setNext(BGNerves.wait);
        this.changeAllTentacleState(TS_WAIT);
    }
    changeAttackMode(m: number) {
        this.mAttackMode = m; this.mTimeInCurrentAttackMode = 0;
        const s = this.spine!;
        switch (m) {
            case ASTATE_GUARD: this.changeAllTentacleState(TS_UNKA); break;
            case ASTATE_UNISON: this.changeAllTentacleState(TS_WAIT); break;
            case ASTATE_ROLL:
                this.unk1A1 = Math.trunc(fr(MsRandF() * 100)) < 0x28 ? 1 : 0;
                this.changeAllTentacleState(TS_SYNCBODY);
                s.reset(); s.setNext(BGNerves.roll); s.pushAfterCurrent(BGNerves.wait);
                break;
            case ASTATE_SHOOT: {
                const l = s.getLatestNerve();
                if (l !== BGNerves.polDrop && l !== BGNerves.pollute && l !== BGNerves.tentacleDamage && l !== BGNerves.eyeDamage && l !== BGNerves.beakDamage) {
                    s.reset(); s.setNext(BGNerves.polDrop); s.pushAfterCurrent(BGNerves.wait);
                    this.changeAllTentacleState(TS_SYNCBODY);
                }
                break;
            }
            case ASTATE_UNK6: this.tentacles[0].changeStateAndFixNodes(TS_GUARD); break;
        }
    }
    gotTentacleDamage() {
        const s = this.spine!;
        if (s.getLatestNerve() === BGNerves.beakDamage) return;
        s.reset(); s.setNext(BGNerves.tentacleDamage); s.pushAfterCurrent(BGNerves.wait);
    }
    gotEyeDamage() {
        const s = this.spine!, l = s.getLatestNerve();
        if (l === BGNerves.eyeDamage || l === BGNerves.beakDamage || l === BGNerves.pollute) return;
        s.reset(); s.setNext(BGNerves.eyeDamage); s.pushAfterCurrent(BGNerves.wait);
    }
    gotBeakDamage() {
        const s = this.spine!;
        if (s.getLatestNerve() === BGNerves.tentacleDamage) return;
        if (this.hitPoints > 0) --this.hitPoints;
        if (this.hitPoints === 0) s.setNext(BGNerves.die);
        else { s.setNext(BGNerves.beakDamage); s.pushAfterCurrent(BGNerves.wait); }
    }
    changeAllTentacleState(st: number) { for (const t of this.tentacles) if (t.mState !== TS_STUN && !t.isThing()) t.changeStateAndFixNodes(st); }
    forceAllTentacleState(st: number) { for (const t of this.tentacles) t.changeStateAndFixNodes(st); }
    launchPolDrop() {
        const d = this.mPolDrop!;
        if (d.unk58) return;
        let p: V3;
        if (this.checkLiveFlag(LF.CLIPPED_OUT)) { p = this.pos.clone(); p.x = fr(p.x + 1); }
        else p = this.getJointTrans(26);
        d.launch(p, calcJumpVelocityXZ(this.world.mario.pos, p, 32, fr(0.2)));
        this.world.effect('ms_boge_canon', this.getJointTrans(27));
        this.unk195 += 1;
    }
    tentacleHeld() { return this.tentacles.some((t) => t.mState === TS_HELD); }
    tentacleAttack() { return this.tentacles.some((t) => t.mState === TS_ATTACK); }
    beakHeld() { return !!this.mBeak!.holder; }
    getAttackSpeed() {
        const B = this.BP;
        if (this.mAttackMode === ASTATE_UNISON) return B.mSLUnisonAttackSpeed;
        if (this.mAttackMode === ASTATE_DOUBLE) return B.mSLDoubleAttackSpeed;
        if (this.mAttackMode === ASTATE_SKIP_ROPE) return B.mSLSkipRopeAttackSpeed;
        return 1;
    }
    receiveMessage(sender: HitActor, msg: number) {
        if (sender.actorType === AT.WATER && msg === MSG.SPRAYED_BY_WATER) { this.world.effect('enemyWaterHit', sender.pos); return true; }
        return false;
    }
    private marioOnGround() { const m = this.world.mario as any; return typeof m.isTouchGround4cm === 'function' ? m.isTouchGround4cm() : this.world.mario.pos.y <= this.world.mario.groundHeight + 4; }
    doAttackSingle() {
        const s = this.spine!, w = this.world, B = this.BP, T = this.tentacles;
        if (s.getLatestNerve() !== BGNerves.pollute) { if (this.unk178) this.unk178.setBckFromIndex(-1); this.unk17C = 0; }
        if (w.moveTickCount < 0x1E0 || w.talkMode || w.demoMode) return;
        if (this.unk1A8 > 0) { this.unk1A8 -= 1; return; }
        if (this.is2ndFightNow()) {
            const d = w.mario.pos.clone();
            if (fr(d.y + 20) < this.pos.y) return;
            if (V3.sub(d, this.pos).squared() > 3610000) return;
        }
        for (const i of [1, 3]) {
            const t = T[i];
            if (this.inSight() && t.mState === TS_WAIT) {
                const d = V3.sub(w.mario.pos, t.firstNode().pos);
                const L = B.mSLSingleAttackLen;
                if (d.squared() < fr(L * L)) { t.changeStateAndFixNodes(TS_ATTACK); break; }
            }
        }
        if (T[3].isThing2() && T[1].isThing2() && (!T[2].isThing2() || !T[0].isThing2())) {
            if (this.mTimeInCurrentAttackMode > B.mSLUnisonInter && this.is2ndFightNow()) this.changeAttackMode(ASTATE_ROLL);
            return;
        }
        if (this.tentacleHeld()) return;
        const uni = fr(B.mSLUnisonAttackLen * B.mSLUnisonAttackLen), force = fr(B.mSLForceUnisonLen * B.mSLForceUnisonLen);
        const d = V3.sub(w.mario.pos, this.pos);
        if (this.mBeak!.holder && (!T[3].isThing2() || !T[1].isThing2())) {
            for (const i of [1, 3]) {
                const t = T[i], st = t.mState;
                if (st !== TS_ATTACK && st !== TS_AMPUTEE && st !== TS_STUN && st !== TS_HELD && st !== TS_HIDE) t.changeStateAndFixNodes(TS_ATTACK);
            }
            return;
        }
        const d2 = d.squared();
        if (d2 < force && this.marioOnGround()) { this.changeAttackMode(ASTATE_UNISON); return; }
        if (d2 < uni && this.marioOnGround()) {
            if (this.mTimeInCurrentAttackMode <= B.mSLUnisonInter) return;
            this.changeAttackMode(this.is2ndFightNow() ? ASTATE_ROLL : ASTATE_UNISON);
            return;
        }
        if (this.tentacleAttack()) return;
        if (this.mCork!.unkC !== 0 && this.unk195 < 3) {
            const sr = fr(B.mSLShootRadius * B.mSLShootRadius);
            if (this.mTimeInCurrentAttackMode > B.mSLUnisonInter && d2 < sr && this.inSightAngle(60)) this.changeAttackMode(ASTATE_SHOOT);
        } else if (this.is2ndFightNow()) {
            if (this.inSight() && this.mTimeInCurrentAttackMode > B.mSLUnisonInter) { this.changeAttackMode(ASTATE_ROLL); this.unk195 = 0; }
        }
    }
    doAttackDouble() {
        const T = this.tentacles, B = this.BP;
        if (this.mBeak!.holder || this.tentacleHeld()) { this.changeAttackMode(ASTATE_SKIP_ROPE); return; }
        const d = V3.sub(this.world.mario.pos, this.pos);
        if (this.inSight() && d.squared() < fr(B.mSLDoubleAttackLen * B.mSLDoubleAttackLen)) for (const i of [0, 2]) if (T[i].mState === TS_WAIT) T[i].changeStateAndFixNodes(TS_ATTACK);
        if (this.mBeak!.holder) return;
        if (!T[3].isThing2() || !T[1].isThing2()) this.changeAttackMode(ASTATE_SINGLE);
    }
    doAttackSkipRope() {
        const T = this.tentacles;
        if (this.mBeak!.holder) { this.changeAttackMode(ASTATE_SKIP_ROPE); return; }
        if (!this.mBeak!.holder && !this.tentacleHeld()) { this.changeAttackMode(ASTATE_SINGLE); return; }
        if (this.inSight()) for (const i of [0, 2]) {
            const st = T[i].mState;
            if (st !== TS_REST && st !== TS_ATTACK && st !== TS_AMPUTEE && st !== TS_STUN && st !== TS_HELD && st !== TS_HIDE) T[i].changeStateAndFixNodes(TS_ATTACK);
        }
    }
    doAttackUnison() {
        const T = this.tentacles, B = this.BP;
        if (this.mBeak!.holder) { this.changeAttackMode(ASTATE_SKIP_ROPE); return; }
        const d = V3.sub(this.world.mario.pos, this.pos);
        if (this.inSight() && this.marioOnGround() && d.squared() < fr(B.mSLUnisonAttackLen * B.mSLUnisonAttackLen)) {
            let none = true;
            for (let i = 0; i < 4; i++) if (i === Math.trunc(this.mTimeInCurrentAttackMode / 8) && T[i].mState === TS_WAIT) { T[i].changeStateAndFixNodes(TS_ATTACK); none = false; }
            if (none && this.mTimeInCurrentAttackMode > 300) this.changeAttackMode(ASTATE_SINGLE);
        } else {
            for (const t of T) {
                if (t.mState === TS_ATTACK) return;
                if (!t.isThing2() && t.mState !== TS_WAIT && t.mState !== TS_REST && t.mState !== TS_STUN) t.changeStateAndFixNodes(TS_REST);
            }
            this.changeAttackMode(ASTATE_SINGLE);
        }
    }
    doAttackShoot() {
        const B = this.BP;
        if (this.mBeak!.holder) { this.changeAttackMode(ASTATE_SINGLE); return; }
        if (this.mTimeInCurrentAttackMode > 120 && this.spine!.getLatestNerve() !== BGNerves.polDrop) { this.changeAttackMode(ASTATE_SINGLE); return; }
        if (!this.inSight()) return;
        if (V3.sub(this.world.mario.pos, this.pos).squared() < fr(B.mSLSingleAttackLen * B.mSLSingleAttackLen)) this.changeAttackMode(ASTATE_SINGLE);
    }
    doAttackGuard() {
        const T = this.tentacles, B = this.BP;
        if (this.mBeak!.holder) { this.changeAttackMode(ASTATE_SKIP_ROPE); return; }
        if (this.inSight()) {
            const d = V3.sub(this.world.mario.pos, this.pos);
            if (!(fr(B.mSLGuardLen * B.mSLGuardLen) < d.squared())) { if (!T[3].isThing2()) return; if (!T[1].isThing2()) return; }
            this.changeAllTentacleState(TS_WAIT);
            this.changeAttackMode(ASTATE_SINGLE);
        }
    }
    doAttackRoll() {
        if (this.spine!.getLatestNerve() === BGNerves.roll) return;
        this.changeAllTentacleState(TS_WAIT);
        this.changeAttackMode(ASTATE_SINGLE);
    }
    moveObject() {
        LiveActor.prototype.moveObject.call(this);
        const s = this.spine!, l = s.getLatestNerve();
        if (l === BGNerves.die || l === BGNerves.polDrop || l === BGNerves.pollute || l === BGNerves.beakDamage) return;
        switch (this.mAttackMode) {
            case ASTATE_SINGLE: this.doAttackSingle(); break;
            case ASTATE_DOUBLE: this.doAttackDouble(); break;
            case ASTATE_SKIP_ROPE: this.doAttackSkipRope(); break;
            case ASTATE_UNISON: this.doAttackUnison(); break;
            case ASTATE_SHOOT: this.doAttackShoot(); break;
            case ASTATE_GUARD: this.doAttackGuard(); break;
            case ASTATE_ROLL: this.doAttackRoll(); break;
        }
        const l2 = s.getLatestNerve();
        if (l2 !== BGNerves.tentacleDamage && l2 !== BGNerves.beakDamage && l2 !== BGNerves.tug) {
            if (this.tentacleHeld() || this.mBeak!.holder) s.pushNerve(BGNerves.tug);
        }
        this.mTimeInCurrentAttackMode += 1;
    }
    reset() {
        for (const t of this.tentacles) { t.resetAllNodes(this.pos); t.firstNode().unk24 = true; }
        if (this.world.map === 3 && this.world.stage === 0) this.changeAttackMode(ASTATE_UNK6);
        else this.changeAttackMode(ASTATE_SINGLE);
        this.calcRootMatrix();
        this.calcJoints();
    }
    calcRootMatrix() {
        if (this.spine!.getLatestNerve() === BGNerves.die && this.mactor && this.mactor.checkCurBckFromIndex(BCK_FLY)) {
            this.rot.set(MsGetRotFromZaxis(this.vel.clone()));
            const m = this.baseTR;
            MsMtxSetXYZRPH(m, this.pos.x, this.pos.y, this.pos.z, this.rot.x, this.rot.y, this.rot.z);
            const rx = mtx(); MsMtxSetRotX(rx, 90);
            MTXConcat(m, rx, m);
            return;
        }
        super.calcRootMatrix();
    }
    perform(cue: number) {
        const w = this.world, T = this.tentacles, s = this.spine!;
        if ((cue & CUE_CALC_ANIM) && (this.mBeak!.holder || this.tentacleHeld()) && ((w.mario as any).mIntendedMag || 0) > fr(0.1)) w.sound(SE.BS_GESO_PULL, this.pos);
        if (cue & CUE_MOVE) {
            this.checkTakeMsg();
            if (this.unk1AC > 0) this.unk1AC--;
            if (this.unk1AE > 0) this.unk1AE--;
        }
        if (this.mAttackMode === ASTATE_UNK6) {
            if (cue & CUE_CALC_ANIM) {
                if (!w.search('container')) this.changeAttackMode(ASTATE_SINGLE);
                else if (T[0].mState !== TS_AMPUTEE) {
                    T[0].nodes[0].pos.set(11603, 2114.3, 2411.4).fround();
                    T[0].nodes[1].pos.set(11510, 2114.3, 2411.4).fround();
                }
            }
            T[0].testPerform(cue);
            for (let i = 1; i < 4; i++) T[i].hand.shown = false;
            return;
        }
        super.perform(cue);
        if ((cue & CUE_CALC_ANIM) && !this.checkLiveFlag(LF.DEAD)) this.calcJoints();
        this.mPolDrop!.testPerform(cue);
        if (this.checkLiveFlag(LF.DEAD)) { for (const t of T) t.hand.shown = false; this.mCork!.perform(cue); return; }
        if ((cue & CUE_CALC_ANIM) && this.unk194 > 0) { w.effect('ms_boge_wash', this.getJointTrans(0)); this.unk194--; }
        this.mCork!.perform(cue);
        this.mBeak!.testPerform(cue);
        this.mLeftEye!.testPerform(cue);
        this.mRightEye!.testPerform(cue);
        this.mBody!.testPerform(cue);
        if (cue & CUE_MOVE) this.mc.ratio = Math.min(1, Math.max(0, fr(this.mc.ratio - this.unk188)));
        if (this.unk17C && (cue & CUE_CALC_ANIM) && this.unk178) { this.unk178.frameUpdate(); stampModel(w, this.unk178, this.baseTR, this.scale); }
        if (cue & CUE_CALC_ANIM) {
            if (this.checkLiveFlag(LF.CLIPPED_OUT)) { for (const t of T) if (t.mState !== TS_AMPUTEE) t.nodes[0].pos.set(this.pos); }
            else {
                const roots = [2, 3, 5, 6];
                for (let i = 0; i < 4; i++) if (T[i].mState !== TS_AMPUTEE) T[i].nodes[0].pos.set(this.getJointTrans(roots[i]));
            }
        }
        for (const t of T) t.testPerform(cue);
        if ((cue & CUE_CALC_ANIM) && this.mactor && (this.mactor.checkCurBckFromIndex(BCK_ROLL) || this.mactor.checkCurBckFromIndex(BCK_ROLL_ALL))) w.sound(SE.BS_GESO_ROLL, this.pos);
        if ((cue & CUE_MOVE) && this.mBeak!.holder && this.unk190[3] === 0) {
            if (!T[1].isThing() || !T[3].isThing()) this.world.effect('balloon:e0003', this.pos);
        }
    }
    kill() { this.onLiveFlag(LF.DEAD); }
}

/** TBGBinder::bind: onto the ground (the higher of below and the old height), falling into the sea when it dies */
function bgBind(g: BossGesso) {
    const w = g.world;
    const n = g.pos.clone().add(g.posDelta).fround();
    if (g.isAirborne()) {
        const v = g.vel.clone();
        n.add(v).fround();
        v.y = fr(v.y - g.getGravityY());
        if (v.y < -40) v.y = -40;
        g.vel.set(v);
    }
    if (g.spine!.getLatestNerve() === BGNerves.die && g.mactor!.checkCurBckFromIndex(BCK_FLY)) {
        g.posDelta.set(V3.sub(n, g.pos).fround());
        if (w.map !== 9 && fr(g.pos.y - n.y) > 0) {
            const h1 = fr(w.checkGround(n.x, fr(n.y + g.getHeadHeight()), n.z)[0] + 1);
            const h2 = fr(w.checkGround(n.x, fr(g.pos.y + g.getHeadHeight()), n.z)[0] + 1);
            if (h2 > h1) {
                const e = w.conductor.makeOneEnemyAppear(g.pos, 'エフェクト水柱マネージャー', 1) as any;
                const k = g.BP.mSLColumnScale;
                if (e && e.generate) e.generate(g.pos, new V3(k, k, k));
                w.sound(SE.BS_GESO_DOWN_DIVE, g.pos);
            }
        }
        return;
    }
    let [h, d] = w.checkGround(n.x, fr(n.y + g.getHeadHeight()), n.z);
    h = fr(h + 1);
    if (fr(g.pos.y - n.y) > 0) {
        let [h2, d2] = w.checkGround(n.x, fr(g.pos.y + g.getHeadHeight()), n.z);
        h2 = fr(h2 + 1);
        if (h2 > h) { d = d2; h = h2; }
    }
    if (n.y <= h) { n.y = h; g.vel.zero(); g.offLiveFlag(LF.AIRBORNE); }
    else g.onLiveFlag(LF.AIRBORNE);
    g.groundHeight = h; g.groundPlane = d;
    g.posDelta.set(V3.sub(n, g.pos).fround());
}

// ---------------------------------------------------------------- nerves
type S = Spine<BossGesso>;
const marioDist = (self: BossGesso) => len(V3.sub(self.world.mario.pos, self.pos));
const btp = (self: BossGesso, i: number, frame: number, rate?: number) => {
    const a = self.mactor!;
    a.setFromIndex(ANM_BTP, i);
    const c = a.getFrameCtrl(ANM_BTP);
    if (c) { c.frame = frame; if (rate !== undefined) c.rate = rate; }
};
export const BGNerves: Record<string, any> = {};
BGNerves.wait = nerve<BossGesso>('TNerveBGWait', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.changeBck(self.hitPoints === 1 ? BCK_WAIT3 : self.hitPoints === 2 ? BCK_WAIT2 : BCK_WAIT);
        self.setGoalPath(new PathNode(self.world.mario));
        btp(self, BTP_TWAIT, 0);
    }
    const l = marioDist(self);
    const k = l > 800 ? 1 : fr(3000 / l);
    self.walkToCurPathNode(0, fr(k * self.turnSpeed), 0);
    return false;
});
BGNerves.eyeDamage = nerve<BossGesso>('TNerveBGEyeDamage', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.changeBck(BCK_EYEDAMAGE);
        if (!self.mBeak!.holder && self.mAttackMode !== ASTATE_UNISON) { self.changeAttackMode(ASTATE_UNISON); self.changeAllTentacleState(TS_ATTACK); }
        btp(self, BTP_TEYEDAMAGE, 1.5, 0);
    }
    if (self.mactor!.curAnmEndsNext(ANM_BCK)) { btp(self, BTP_TWAIT, 0); return true; }
    self.world.effect('ms_boge_namida', self.getJointTrans(7));
    self.world.effect('ms_boge_namida', self.getJointTrans(4));
    if (self.unk1AE === 0) { self.unk1AE = 0x78; self.world.sound(SE.BS_GESO_WATER_HIT, self.pos); }
    if (self.unk190[3] !== 0) { self.unk190[3] -= 1; self.unk194 = 5; }
    return false;
});
BGNerves.beakDamage = nerve<BossGesso>('TNerveBGBeakDamage', (spine: S) => {
    const self = spine.body, a = self.mactor!, t = spine.time;
    if (t === 0) {
        self.changeBck(BCK_HIT);
        a.setFromIndex(ANM_BTK, 0);
        self.changeAllTentacleState(TS_SYNCBODY);
        const c4 = a.getFrameCtrl(ANM_BTK);
        if (c4) { c4.rate = 1; c4.frame = 0; }
        btp(self, BTP_TEYEDAMAGE, 1.5, 0);
    }
    if (t === 1) self.mCork!.crush();
    if (t === 12) self.world.effect('ms_boge_hit', self.getJointTrans(27));
    if (t === 510 || t === 236) {
        const p = self.getJointTrans(47);
        p.y = self.world.checkGround(p.x, fr(p.y + 500), p.z)[0];
        self.world.effect('ms_boge_hitdown', p);
    }
    if (t === 40) self.world.effect('ms_boge_kizetsu', self.getJointTrans(7));
    if (a.curAnmEndsNext(ANM_BCK)) {
        self.forceAllTentacleState(TS_WAIT);
        const c4 = a.getFrameCtrl(ANM_BTK);
        if (c4) { c4.rate = 0; c4.frame = 0; }
        spine.pushAfterCurrent(BGNerves.pollute);
        return true;
    }
    return false;
});
BGNerves.tentacleDamage = nerve<BossGesso>('TNerveBGTentacleDamage', (spine: S) => {
    const self = spine.body, t = spine.time;
    if (t === 0) self.changeBck(BCK_DAMAGE);
    if (t === 30 || t === 304) {
        const p = self.getJointTrans(47);
        p.y = self.world.checkGround(p.x, fr(p.y + 500), p.z)[0];
        self.world.effect('ms_boge_hitdown', p);
    }
    if (self.mactor!.curAnmEndsNext(ANM_BCK)) {
        if (!self.tentacleHeld()) return true;
        spine.pushAfterCurrent(BGNerves.tentacleDamage);
        return true;
    }
    return false;
});
BGNerves.tug = nerve<BossGesso>('TNerveBGTug', (spine: S) => {
    const self = spine.body, a = self.mactor!;
    if (spine.time === 0) self.changeBck(BCK_EYEDAMAGE);
    self.world.effect('ms_boge_ase', self.getJointTrans(47));
    if (self.mBeak!.holder) {
        if (marioDist(self) >= self.BP.mSLBeakLengthDamage) {
            btp(self, BTP_TEYEDAMAGE, 1.5, 0);
            if (!a.checkCurBckFromIndex(BCK_LIMIT)) self.changeBck(BCK_LIMIT);
        }
    }
    if (a.curAnmEndsNext(ANM_BCK)) {
        if (self.tentacleHeld()) self.changeBck(BCK_EYEDAMAGE);
        else return true;
    }
    self.walkToCurPathNode(0, fr(self.turnSpeed * 10), 0);
    return false;
});
BGNerves.die = nerve<BossGesso>('TNerveBGDie', (spine: S) => {
    const self = spine.body, a = self.mactor!, w = self.world, t = spine.time;
    if (t === 0) {
        self.changeBck(BCK_CRUSH);
        btp(self, BTP_TEYEDAMAGE, 1.5, 0);
        const cam = w.map === 9 ? 'bgeso_fall_camera3' : !self.is2ndFightNow() ? 'bgeso_fall_camera' : 'bgeso_fall_camera2';
        w.events.push({ t: w.tickCount, kind: 'demoCamera', data: { name: cam, p: self.pos.clone() } });
        if (w.map === 3 || w.map === 59) {
            const im = mapObjGlobals(w).itemManager;
            if (im) im.makeShineAppearWithDemo('シャイン（ボス用）', 'ボスシャインカメラ', self.pos.x, fr(self.pos.y + 6000), self.pos.z);
        }
        const nk = w.search('ナメクリマネージャー') as any;
        if (nk && nk.killChildren) nk.killChildren();
        w.sound(SE.BS_GESO_MHIT_NOBOICE, self.pos);
    }
    if (w.map === 9 && t >= 740 && t <= 750) w.sound(SE.OBJ_QUAKE, self.pos);
    if (a.checkCurBckFromIndex(BCK_CRUSH) && a.curAnmEndsNext(ANM_BCK)) {
        self.changeBck(BCK_FLY);
        self.changeAllTentacleState(TS_SYNCBODY);
        const goal = new V3(self.pos.x, -5000, fr(self.pos.z + 7000));
        self.setGoalPath(new PathNode(null, goal));
        self.vel.set(self.calcVelocityToJumpToY(goal, 50, self.getGravityY()));
        self.onLiveFlag(LF.AIRBORNE);
        return false;
    }
    if (self.isReachedToGoal()) { self.vel.zero(); self.posDelta.zero(); self.onLiveFlag(LF.UNK10); }
    if (self.isReachedToGoal() && !w.demoMode) {
        self.changeAllTentacleState(TS_WAIT);
        self.kill();
        const b = w.search('マーレボスゲッソー用ブロック') as HitActor | null;
        if (b) b.receiveMessage(self, MSG.ATTACK);
        return true;
    }
    return false;
});
BGNerves.pollute = nerve<BossGesso>('TNerveBGPollute', (spine: S) => {
    const self = spine.body, t = spine.time;
    if (t === 0) {
        self.changeBck(BCK_OSEN);
        if (self.unk178) self.unk178.setBckFromIndex(BCK_DIRTY_OSEN);
        self.unk17C = 1;
        self.changeAllTentacleState(TS_WAIT);
        btp(self, BTP_TWAIT, 0);
    }
    if (t === 90) self.world.effect('ms_boge_osen', self.getJointTrans(27));
    if (t === 226) { self.world.effect('ms_boge_jump', self.getJointTrans(1)); self.unk190[3] = 230; }
    if (self.mactor!.curAnmEndsNext(ANM_BCK)) { if (self.unk178) self.unk178.setBckFromIndex(-1); self.unk17C = 0; return true; }
    return false;
});
BGNerves.polDrop = nerve<BossGesso>('TNerveBGPolDrop', (spine: S) => {
    const self = spine.body, a = self.mactor!;
    if (spine.time === 0) { self.changeBck(BCK_CANNON); self.changeAllTentacleState(TS_WAIT); btp(self, BTP_TWAIT, 0); }
    const c = a.getFrameCtrl(ANM_BCK);
    if (c && 83 < c.frame && c.frame < 87) self.launchPolDrop();
    if (a.curAnmEndsNext(ANM_BCK)) {
        const d2 = V3.sub(self.world.mario.pos, self.pos).squared(), B = self.BP;
        const sr = fr(B.mSLShootRadius * B.mSLShootRadius), sl = fr(B.mSLSingleAttackLen * B.mSLSingleAttackLen);
        if (self.unk195 < 3 && sl <= d2 && d2 < sr) spine.pushAfterCurrent(BGNerves.polDrop);
        return true;
    }
    self.walkToCurPathNode(0, self.turnSpeed, 0);
    return false;
});
BGNerves.roll = nerve<BossGesso>('TNerveBGRoll', (spine: S) => {
    const self = spine.body, a = self.mactor!;
    if (self.unk1A1 === 0) {
        if (spine.time === 0) self.changeBck(BCK_ROLL_START);
        if (a.curAnmEndsNext(ANM_BCK)) {
            if (a.checkCurBckFromIndex(BCK_ROLL)) {
                if (self.unk196 < 3) { self.changeBck(BCK_ROLL); self.unk196 += 1; }
                else { self.changeBck(BCK_ROLL_END); self.unk196 = 0; }
            } else if (a.checkCurBckFromIndex(BCK_ROLL_START)) self.changeBck(BCK_ROLL);
            else return true;
            return false;
        }
    } else {
        if (spine.time === 0) self.changeBck(BCK_ROLL_ALL_START);
        if (a.curAnmEndsNext(ANM_BCK)) {
            if (a.checkCurBckFromIndex(BCK_ROLL_ALL)) {
                if (self.unk196 < 3) { self.changeBck(BCK_ROLL_ALL); self.unk196 += 1; }
                else { self.changeBck(BCK_ROLL_ALL_END); self.unk196 = 0; }
            } else if (a.checkCurBckFromIndex(BCK_ROLL_ALL_START)) self.changeBck(BCK_ROLL_ALL);
            else return true;
        }
    }
    return false;
});

register('BossGessoManager', (w, n) => new BossGessoManager(w, n));
register('BossGesso', (w, n) => new BossGesso(w, n));
export { ASTATE_SINGLE, BCK_ROLL_ALL_END };
