// The Bloopers that stick to walls and posts (TGesso, Enemy/gesso.cpp), with their land (TLandGesso)
// and surfing (TSurfGesso) kinds. A stuck one (STATE_BEAM_CHILLING) faces one of four ways
// (its yaw from scene.bin: unk1A1 / unk1C4, mStayYaw), leans its body after Mario
// (GessoBodyCallback: mBodyTrackingAngle about joint 12), rolls round its post when Mario comes
// close above or below it (TNerveGessoRolling: upside down, unk1A0), turns round to face him
// when he's close behind (TNerveGessoTurn), and spits a ball of goop at him every
// mSLPollutionInterval frames (TGessoPolluteObj: lands, stamps the goop, leaves a mark model).
// Sprayed it drops off (TNerveGessoFall) and walks the graph like any walker (STATE_WANDERING);
// sprayed again it's stunned (TNerveGessoFreeze).
//
// Not here: the goop ball's particles and the stunned stars (effects only).

import { fr, V3, Mtx, mtx, MsClamp, MsIsInSight, MsGetRotFromZaxisY, MsMtxSetRotRPH, MsMtxSetXYZRPH, mtxMultVec, MsAtan2 } from '../math.js';
import { World, Stream, HitActor, LF, HF, HC, MSG, ANM_BCK, CUE_MOVE, CUE_CALC_ANIM, nerve, Spine, PathNode, SpineEnemy, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { mat4 } from 'gl-matrix';
import { SmallEnemyManager, SmallEnemyNerves, rangeRand } from './smallEnemy.js';
import { WalkerEnemy, WalkerNerves, walkerParams } from './walker.js';
import { PolluteModelManager } from './igaiga.js';
import { msVecNormalize, force25 } from '../camera/lib.js';
import { frsqrte } from '../math.js';
import { MsMtxSetRotX, MsMtxSetRotY, MTXConcat } from '../mapobj/lib.js';
import type { WallCheck } from '../collision.js';
import { mapObjGlobals } from '../mapobj/base.js';

/** TGessoSaveLoadParams */
const GESSO_PARAMS = {
    mSLSearchLengthOnObj: ['f', 500], mSLSearchAngleOnObj: ['f', 180], mSLSearchAwareOnObj: ['f', 500], mSLPollutionLength: ['f', 200],
    mSLPollutionInterval: ['i', 300], mSLPolluteObjGravity: ['f', 0.01], mSLPolluteObjSpeed: ['f', 5], mSLPolluteObjLinerSp: ['f', 5],
    mSLPolluteObjLinerG: ['f', 0.01], mSLDropGravityY: ['f', 0.1], mSLBodyAngMax: ['f', 40], mSLPolluteModelScale: ['f', 2],
    mSLTurnLength: ['f', 300], mSLHitWaterSpXZ: ['f', 12], mSLHitWaterSpY: ['f', 5],
} satisfies PSchema;

/** MsVECMag2: the length from the raw frsqrte estimate (paired singles) */
function msVecMag2(v: V3) {
    const s = fr(fr(v.z * v.z + fr(v.x * v.x)) + fr(v.y * v.y));
    if (s <= 0) return 0;
    return fr(s * force25(frsqrte(s)));
}
const vnorm = (v: V3) => msVecNormalize(v, v) as V3;

// BCKs (/scene/rikuGesso, in the folder's order)
const BCK_180TURN = 2, BCK_DOWN = 3, BCK_FALL = 4, BCK_GERO = 5, BCK_HIT = 6, BCK_LAND = 7, BCK_MAHI_END = 8, BCK_MAHI_LOOP = 9,
    BCK_MAHI_START = 10, BCK_PUNCH = 11, BCK_RUN = 12, BCK_SEARCH = 13, BCK_STAIRLAND = 14, BCK_SURF = 15, BCK_TURN_DOWN = 16,
    BCK_TURN_GERO = 17, BCK_TURN_HIT = 18, BCK_TURN_UP = 19, BCK_TURN_WAIT = 20, BCK_WAIT = 21, BCK_STAMP = 0x16;

export const GS_BEAM_CHILLING = 0, GS_WANDERING = 1, GS_ROLLING = 2, GS_FALLING = 3;
const TYPE_REGULAR = 0, TYPE_LAND = 1, TYPE_SURF = 2;

// ---------------------------------------------------------------- TGessoManager
export class GessoManager extends SmallEnemyManager {
    unk60: PolluteModelManager | null = null;
    constructor(w: World, name = 'ゲッソーマネージャー') { super(w, name); }
    load(s: Stream) {
        this.saveParams = walkerParams('/enemy/gesso.prm', this.world.files, GESSO_PARAMS);
        super.load(s);
    }
    createModelData() { this.createModelDataArray(['geso_model1.bmd']); }
    createEnemyInstance(): SpineEnemy | null { return new Gesso(this.world); }
    initSetEnemies() {
        const o = this.objs[0] as Gesso | undefined;
        if (o) this.unk60 = new PolluteModelManager(this.world, 'rikugesso/stamp_gero_model1.bmd', o, BCK_STAMP);
    }
    /** clipEnemies: the frustum at the camera's near plane (no LIVE_FLAG_ENABLE_CLIPPING check), the goop balls too */
    clipActors() {
        const p = this.saveParams, far = p ? p.mSLFarClip : 5000, r = p ? p.mSLClipRadius : 300;
        for (const o of this.objs as Gesso[]) {
            if (this.world.inView(o.pos, r, far)) o.offLiveFlag(LF.CLIPPED_OUT); else o.onLiveFlag(LF.CLIPPED_OUT);
            const po = o.mPolluteObj;
            if (po && po.unk150 !== 0) { if (this.world.inView(po.pos, r, far)) po.offLiveFlag(LF.CLIPPED_OUT); else po.onLiveFlag(LF.CLIPPED_OUT); }
        }
    }
    perform(cue: number) {
        super.perform(cue);
        const n = this.getActiveObjNum();
        for (let i = 0; i < n; i++) { const po = (this.objs[i] as Gesso).mPolluteObj; if (po) po.perform(cue); }
        if (this.unk60) this.unk60.perform(cue);
    }
    requestPolluteModel(p: V3, s: V3) { if (this.unk60) this.unk60.generatePolluteModel(p, s); }
}

// ---------------------------------------------------------------- TGesso
export class Gesso extends WalkerEnemy {
    static mBodyJntIndex = 12; static mMouthJntIndex = 13; static mBodyRotSpeed = 0.5; static mPollRange = 8;
    static mThroughHoseiDistY = 200; static mAngTestY = fr(0.15);
    mAttackCooldown = 0; mPollutionTimer = 0; mState = GS_BEAM_CHILLING; mIsRightSideUp = true;
    /** unk1A1 facing along X (1) or Z (0), unk1A4 the height it's stuck at */
    unk1A1 = 1; unk1A4 = 0;
    mPolluteObj: GessoPolluteObj | null = null;
    mGessoType = TYPE_REGULAR; mTurnAngle = 0; unk1B4 = 0;
    mPolluteVelocity = new V3();
    /** unk1C4 facing the positive way */
    unk1C4 = 1; mStayYaw = 0; mBodyTrackingAngle = 90;
    /** unk1D0 how far it hangs below its post (upside down: its damage height) */
    unk1D0 = 0; unk1D8 = 0; mNeedsLanding = false;
    unk1DC = new V3();
    get G(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'ゲッソー') { super(w, name); }
    /** TSpineEnemy::getSaveParam: unk1E8 is the same */
    init(m: any) {
        super.init(m);
        this.actorType = AT.GESSO;
        this.unk150 = 17;
        this.mPolluteObj = new GessoPolluteObj(this.world);
        this.mPolluteObj.loadInit(this, 'gero_model1.bmd');
        this.setBckAnm(BCK_WAIT);
        const fc = this.mactor!.getFrameCtrl(ANM_BCK)!;
        const inv = fr(1 / this.manager!.capacity);
        fc.frame = fr(fr(fc.end * this.instanceIndex) * inv);
    }
    reset() {
        super.reset();
        if (this.mGessoType !== TYPE_REGULAR) { this.mState = GS_WANDERING; this.spine!.initWith(WalkerNerves.graphWander); this.unk158 = 1; }
        else { this.mState = GS_BEAM_CHILLING; this.spine!.initWith(GessoNerves.stay); this.unk158 = 0; }
        this.offLiveFlag(LF.UNK1000);
        this.mNeedsLanding = false; this.mIsRightSideUp = true;
        this.unk1A4 = this.pos.y; this.unk1D0 = 0;
        this.setBckAnm(BCK_WAIT);
        const fc = this.mactor!.getFrameCtrl(ANM_BCK)!;
        const inv = fr(1 / this.manager!.getObjNum());
        fc.frame = fr(fr(fc.end * this.instanceIndex) * inv);
    }
    load(s: Stream) {
        super.load(s);
        this.unk1C4 = this.rot.y < 0 ? 0 : 1;
        if (this.rot.y === 0 || this.rot.y === 180) { this.unk1A1 = 1; this.mStayYaw = this.unk1C4 === 0 ? 180 : 0; }
        else { this.unk1A1 = 0; this.mStayYaw = this.unk1C4 === 0 ? 270 : 90; }
        this.reset();
        this.rot.set(0, 0, 0);
    }
    getSightDirection() {
        if (this.mState === GS_WANDERING) return 0;
        if (this.unk1A1 !== 0) return this.unk1C4 !== 0 ? 0 : 180;
        return this.unk1C4 !== 0 ? 90 : 270;
    }
    isWandering() { return this.mState === GS_WANDERING; }
    behaveToWater(_a: HitActor) {
        const s = this.spine!, c = s.current;
        this.unk165 = c === GessoNerves.freeze;
        this.sprayCooldown = 0;
        if (c === SmallEnemyNerves.die || c === GessoNerves.fall || c === GessoNerves.freeze || this.mState === GS_ROLLING) return;
        if (this.mState === GS_BEAM_CHILLING) {
            if (this.mIsRightSideUp) {
                const m = this.world.mario.pos;
                const v = new V3(fr(this.pos.x - m.x), 0, fr(this.pos.z - m.z));
                if (v.x === 0 && v.z === 0) v.x = 1;
                vnorm(v);
                const G = this.G, xz = G.mSLHitWaterSpXZ, y = G.mSLHitWaterSpY;
                v.x = fr(v.x * xz);
                if (Math.abs(v.x) < 5) v.x = v.x > 0 ? 5 : -5;
                v.z = fr(v.z * xz);
                if (Math.abs(v.z) < 5) v.z = v.z > 0 ? 5 : -5;
                v.y = fr(v.y * y);
                this.vel.set(v);
                this.pos.y = fr(this.pos.y + 2);
                this.onLiveFlag(LF.AIRBORNE);
            }
            s.pushNerve(GessoNerves.fall);
        } else s.pushNerve(GessoNerves.freeze);
    }
    walkBehavior(kind: number, k: number) {
        if (this.getCurAnmFrameNo(ANM_BCK) > 20) super.walkBehavior(kind, k);
        if (kind === 2) this.polluteBehavior();
        if (0 < this.unk1B4 && this.unk1B4 < 300) this.unk1B4 += 1; else this.unk1B4 = 0;
    }
    doKeepDistance() { return this.isBckAnm(BCK_MAHI_LOOP) && !(this.world.mario.pos.y > fr(this.pos.y + 50)); }
    attackToMario() {
        const s = this.spine!, m = this.world.mario;
        if (this.mState !== GS_WANDERING) { m.receiveMessage(this, MSG.ATTACK); this.mAttackCooldown = 1; return; }
        let c = s.current;
        if (c !== GessoNerves.punch && c !== GessoNerves.freeze && c !== SmallEnemyNerves.die) {
            this.mAttackCooldown = 1;
            s.pushNerve(WalkerNerves.postAttack);
            s.pushNerve(GessoNerves.punch);
        }
        c = s.current;
        if (c === GessoNerves.punch) { if (this.mactor!.getFrameCtrl(ANM_BCK)!.checkPass(10)) m.receiveMessage(this, MSG.ATTACK); return; }
        if (!this.isBckAnm(BCK_MAHI_LOOP)) m.receiveMessage(this, MSG.ATTACK);
    }
    setBehavior() {
        if (this.mAttackCooldown > 0) this.mAttackCooldown += 1;
        if (this.mAttackCooldown > 200) this.mAttackCooldown = 0;
        const c = this.spine!.current;
        if (this.isAirborne() && this.pos.y > fr(this.groundHeight + 250) && c !== WalkerNerves.generate) this.mNeedsLanding = true;
        if (!this.isAirborne() && this.mNeedsLanding && (c === WalkerNerves.graphWander || c === WalkerNerves.attack)) this.spine!.pushNerve(GessoNerves.land);
        if (!this.isAirborne()) this.mNeedsLanding = false;
    }
    polluteBehavior() {
        this.mPollutionTimer += 1;
        if (!this.checkCurAnmEnd(ANM_BCK)) return;
        if (this.spine!.current === GessoNerves.pollute) return;
        const G = this.G;
        if (this.mPollutionTimer <= G.mSLPollutionInterval) return;
        if (!MsIsInSight(this.pos, this.getSightDirection(), this.world.mario.pos, G.mSLPollutionLength, G.mSLSearchAngleOnObj, 0)) return;
        this.mPollutionTimer = 0;
        this.mPolluteObj!.kill();
        this.spine!.pushNerve(GessoNerves.pollute);
    }
    setPolluteGoal() {
        const G = this.G, m = this.world.mario.pos;
        const g = G.mSLPolluteObjGravity;
        const sp = this.mIsRightSideUp ? G.mSLPolluteObjSpeed : 0;
        if (this.unk1D8 === 0) {
            // (the arguments right to left: z's roll first)
            const z = fr(m.z + rangeRand(-100, 100));
            const x = fr(m.x + rangeRand(-100, 100));
            this.mPolluteVelocity.set(x, m.y, z);
            this.mPolluteVelocity = this.calcVelocityToJumpToY(this.mPolluteVelocity, sp, g);
        } else {
            const v = new V3(fr(m.x - this.pos.x), 0, fr(m.z - this.pos.z));
            vnorm(v);
            const ls = G.mSLPolluteObjLinerSp;
            this.mPolluteVelocity.set(fr(v.x * ls), 0, fr(v.z * ls));
        }
    }
    /** joint 13 (the mouth) as the model was last posed (with its body leaning: GessoBodyCallback) */
    mouthPos() {
        const m = this.mactor ? this.mactor.anmMtx(Gesso.mMouthJntIndex, this.baseTR, this.scale, (j, w) => this.bodyCallback(j, w)) : null;
        return m ? new V3(m[12], m[13], m[14]) : this.pos.clone();
    }
    pollute() {
        const po = this.mPolluteObj!;
        if (this.mState !== GS_WANDERING && !this.mIsRightSideUp) this.mPolluteVelocity.y = -3;
        po.vel.set(this.mPolluteVelocity);
        po.pollute();
        const t = V3.sub(this.mPolluteVelocity, this.pos); t.y = 0;
        po.rot.y = MsGetRotFromZaxisY(t);
        const mouth = this.mouthPos();
        const r = mtx();
        MsMtxSetRotRPH(r, 0, this.mState === GS_WANDERING ? this.rot.y : fr(this.rot.y + this.mStayYaw), 0);
        const off = mtxMultVec(r, new V3(0, 0, 100));
        po.pos.set(fr(mouth.x + off.x), mouth.y, fr(mouth.z + off.z));
    }
    isUseBodyCallBack() { return this.mState !== GS_WANDERING; }
    /** GessoBodyCallback: joint 12 turned about X by the tracking angle and scaled by the body scale */
    bodyCallback(j: number, w: mat4) {
        if (j !== Gesso.mBodyJntIndex || !this.isUseBodyCallBack()) return;
        const max = this.G.mSLBodyAngMax;
        const a = MsClamp(fr(this.mBodyTrackingAngle - 90), -max, max);
        const r = mtx();
        MsMtxSetRotX(r, a);
        const R = mat4.fromValues(r[0], r[4], r[8], 0, r[1], r[5], r[9], 0, r[2], r[6], r[10], 0, 0, 0, 0, 1);
        mat4.mul(w, w, R);
        const s = this.bodyScale;
        mat4.scale(w, w, [s, s, s]);
    }
    setAfterDeadEffect() { this.mPolluteObj!.kill(); super.setAfterDeadEffect(); }
    setDeadAnm() {
        if (this.groundPlane.isWaterSurface()) this.onLiveFlag(LF.HIDDEN);
        else if (this.groundPlane.isIllegal() || this.mGessoType !== TYPE_SURF) this.setBckAnm(BCK_DOWN);
        else this.setBckAnm(BCK_SURF);
    }
    getGravityY() {
        if (this.mState !== GS_WANDERING) {
            const g = this.G.mSLDropGravityY;
            return !this.mIsRightSideUp ? g : fr(g / 2);
        }
        return this.gravity;
    }
    setWalkAnm() { this.setBckAnm(BCK_RUN); }
    setRunAnm() { this.setWalkAnm(); }
    setWaitAnm() {
        if (this.mState === GS_WANDERING || this.mIsRightSideUp) { this.setBckAnm(BCK_WAIT); this.unk1D0 = 0; }
        else { this.setBckAnm(BCK_TURN_WAIT); this.unk1D0 = this.damageHeight; }
    }
    bind() {
        switch (this.mState) {
            case GS_WANDERING: case 4: super.bind(); break;
            case GS_FALLING:
                this.pos.add(this.vel).fround();
                this.vel.y = fr(this.vel.y - this.getGravityY());
                if (this.vel.y < -40) this.vel.y = -40;
                if (this.isBckAnm(BCK_TURN_HIT)) this.mState = 4;
                else if (fr(Gesso.mThroughHoseiDistY * 0.5 + this.pos.y) < this.unk1A4) this.mState = 4;
                break;
            case GS_ROLLING: this.unk1D0 = 0; this.pos.y = fr(this.unk1A4 - this.unk1D0); break;
            case GS_BEAM_CHILLING: this.pos.y = fr(this.unk1A4 - this.unk1D0); break;
        }
        if (this.mState !== GS_WANDERING) {
            const f1 = this.mIsRightSideUp ? 1 : -1;
            const v1 = this.unk1A1 === 0 ? (this.unk1C4 !== 0 ? new V3(0, 0, f1) : new V3(0, 0, -f1)) : (this.unk1C4 !== 0 ? new V3(-f1, 0, 0) : new V3(f1, 0, 0));
            const m = this.world.mario.pos;
            const v2 = new V3(fr(m.x - this.pos.x), 0, fr(m.z - this.pos.z));
            const c = new V3().cross(v1, v2).fround();
            const cos = fr(v1.dot(v2));
            const angle = MsAtan2(cos, msVecMag2(c));
            if (this.mBodyTrackingAngle !== angle) {
                if (this.mBodyTrackingAngle < angle) { this.mBodyTrackingAngle = fr(this.mBodyTrackingAngle + Gesso.mBodyRotSpeed); if (this.mBodyTrackingAngle > angle) this.mBodyTrackingAngle = angle; }
                else { this.mBodyTrackingAngle = fr(this.mBodyTrackingAngle - Gesso.mBodyRotSpeed); if (this.mBodyTrackingAngle < angle) this.mBodyTrackingAngle = angle; }
            }
        }
    }
    kill() {
        if (!this.mIsRightSideUp) return;
        super.kill();
        this.mPolluteObj!.kill();
    }
    calcRootMatrix() {
        if (this.mState === GS_WANDERING) { super.calcRootMatrix(); return; }
        if (this.isEaten()) return;
        const m = this.baseTR;
        MsMtxSetXYZRPH(m, this.pos.x, fr(this.pos.y + this.unk1D0), this.pos.z, this.rot.x, this.rot.y, this.rot.z);
        const ry = mtx();
        MsMtxSetRotY(ry, this.mStayYaw);
        MTXConcat(m, ry, m);
    }
    genRandomItem() {
        if (this.isBckAnm(BCK_SURF)) {
            const im = mapObjGlobals(this.world).itemManager;
            if (im) im.makeObjAppearAt(this.pos.x, this.pos.y, this.pos.z, AT.GESO_SURF_BOARD, true);
            return;
        }
        super.genRandomItem();
    }
    behaveToFindMario() {
        const s = this.spine!;
        if (this.unk150 & 2) { s.pushAfterCurrent(WalkerNerves.graphWander); s.pushAfterCurrent(WalkerNerves.escape); s.pushAfterCurrent(SmallEnemyNerves.jump); }
        else {
            this.setGoalPath(new PathNode(this.world.mario));
            s.pushAfterCurrent(WalkerNerves.graphWander);
            s.pushAfterCurrent(WalkerNerves.attack);
            if (this.unk1B4 === 0) { s.pushAfterCurrent(GessoNerves.findMario); this.unk1B4 = 1; }
        }
    }
    rollCheck() {
        if (this.mAttackCooldown !== 0) return;
        const G = this.G, m = this.world.mario.pos;
        if (MsIsInSight(this.pos, this.getSightDirection(), m, G.mSLSearchLengthOnObj, G.mSLSearchAngleOnObj, G.mSLSearchAwareOnObj)) {
            if ((this.mIsRightSideUp && this.pos.y > fr(m.y + 10)) || (!this.mIsRightSideUp && this.pos.y < fr(m.y - 10))) {
                this.onHitFilter(HF.NO_COLLISION);
                this.mState = GS_ROLLING;
                this.spine!.pushNerve(GessoNerves.rolling);
                if (this.mIsRightSideUp) this.onLiveFlag(LF.UNK8);
                this.mAttackCooldown = 0;
            }
        }
        const tl = G.mSLTurnLength;
        this.updateSquareToMario();
        if (this.distToMarioSq < fr(tl * tl) && this.mIsRightSideUp && !MsIsInSight(this.pos, this.getSightDirection(), m, G.mSLSearchLengthOnObj, G.mSLSearchAngleOnObj, 0))
            this.spine!.pushNerve(GessoNerves.turn);
    }
    rollEnd() {
        this.offHitFilter(HF.NO_COLLISION);
        this.mState = GS_BEAM_CHILLING;
        this.mIsRightSideUp = !this.mIsRightSideUp;
        if (this.mIsRightSideUp) this.offLiveFlag(LF.UNK8);
    }
    modifyRotate() { this.mStayYaw = fr(this.mStayYaw * fr(0.8)); this.rot.scale(fr(0.8)).fround(); }
    fallEnd() {
        this.mState = GS_WANDERING; this.unk158 = 1;
        this.offLiveFlag(LF.UNK8);
        this.rot.set(0, 0, 0);
        this.mIsRightSideUp = true;
    }
    turnIn() { this.setBckAnm(BCK_180TURN); this.mTurnAngle = 0; this.onHitFilter(HF.NO_COLLISION); }
    turning() {
        if (fr(this.mTurnAngle + fr(7.2)) <= 180) {
            this.mBodyTrackingAngle = 90;
            this.rot.y = fr(this.rot.y + fr(7.2));
            this.mTurnAngle = fr(this.mTurnAngle + fr(7.2));
            return false;
        }
        this.mTurnAngle = 180;
        return this.checkCurAnmEnd(ANM_BCK);
    }
    turnOut() { this.mTurnAngle = 0; this.unk1C4 = this.unk1C4 ? 0 : 1; this.offHitFilter(HF.NO_COLLISION); }
    checkDropInWater() {
        const p = this.pos.clone(), v = this.vel.clone();
        for (let i = 0; i < 50; ++i) {
            p.add(v).fround();
            v.y = fr(v.y - this.getGravityY());
            if (p.y < this.groundHeight) break;
        }
        const [, d] = this.world.checkGround(p.x, fr(fr(this.headHeight * 2) + p.y), p.z);
        return d.isWaterSurface();
    }
    initAttacker(a: HitActor) { this.rot.set(a.rot); this.unk184 = 1; this.mGessoType = TYPE_LAND; this.reset(); }
}

export class SurfGesso extends Gesso {
    constructor(w: World, name = 'サーフゲッソー') { super(w, name); }
    load(s: Stream) { super.load(s); this.mGessoType = TYPE_SURF; this.reset(); }
    perform(cue: number) { if (cue & CUE_CALC_ANIM) this.offLiveFlag(LF.CLIPPED_OUT); super.perform(cue); }
    isFindMario(_k: number) { return false; }
}
export class LandGesso extends Gesso {
    constructor(w: World, name = '平地ゲッソー') { super(w, name); }
    load(s: Stream) { super.load(s); this.mGessoType = TYPE_LAND; this.reset(); }
}

// ---------------------------------------------------------------- TEnemyAttachment / TGessoPolluteObj
/**
 * TEnemyAttachment: something an enemy throws (its host unk160): unk150 0 put away, 1 held
 * (following the host: set), 2 flying (its own gravity and ground and wall checks, attacking
 * Mario on contact). Its model is one of the host manager's (TMActorKeeper of the host's manager).
 */
export class EnemyAttachment extends SpineEnemy {
    unk150 = 0; unk154 = 0; unk158 = 0; unk160: SpineEnemy | null = null; unk164 = 1; unk168 = 0;
    constructor(w: World, name = '') { super(w, name); }
    loadInit(host: SpineEnemy, file: string) {
        this.unk160 = host;
        this.manager = host.manager;   // (only for its model: it isn't one of the manager's)
        this.mactor = this.createMActorByName(file);
        this.world.extras.push(this);
    }
    receiveMessage(_s: HitActor, _m: number) { return false; }
    appear() { this.unk150 = 1; this.scale.set(fr(0.01), fr(0.01), fr(0.01)); }
    behaveToHitGround() {
        this.unk168 = 1;
        this.offLiveFlag(LF.AIRBORNE);
        this.vel.set(0, fr(-0.3), 0);
        this.rebirth();
    }
    behaveToHitWall() { this.rebirth(); }
    forceKill() {
        if (!this.groundPlane.isPool() && this.world.isInArea(this.pos.x, this.pos.z)) return;
        this.kill();
        const h = this.unk160!;
        if (h.checkLiveFlag(LF.HIDDEN)) { h.kill(); h.onLiveFlag(LF.UNK20000); }
    }
    recoverScale() {
        if (this.scale.x < this.unk164) this.scale.scale(2).fround();
        else this.scale.set(this.unk164, this.unk164, this.unk164);
    }
    getNowGravity() { return this.gravity; }
    bind() {
        const n = this.pos.clone().add(this.posDelta).add(this.vel).fround();
        this.recoverScale();
        this.vel.y = fr(this.vel.y - this.getNowGravity());
        if (this.vel.y < -40) this.vel.y = -40;
        if (!this.unk168) {
            const [h, d] = this.world.checkGround(n.x, fr(n.y + this.headHeight), n.z);
            this.groundHeight = fr(h + 1); this.groundPlane = d;
        }
        if (fr(n.y + this.vel.y) <= this.groundHeight) this.behaveToHitGround();
        else this.onLiveFlag(LF.AIRBORNE);
        const r: WallCheck = { center: [n.x, fr(n.y + this.headHeight), n.z], radius: fr(2 * this.bodyRadius), maxResults: 1, flags: 0, results: [] };
        if (this.world.isTouchedWallsAndMoveXZ(r)) { n.x = r.center[0]; n.z = r.center[2]; this.behaveToHitWall(); }
        this.pos.set(n);
        this.posDelta.zero();
        this.setBehavior();
        this.forceKill();
        this.pos.add(this.posDelta).fround();
    }
    setBehavior() { }
    rebirth() { this.unk150 = 0; this.unk158 = 0; this.onHitFilter(HF.NO_COLLISION); this.vel.y = 0; }
    kill() { this.unk150 = 0; this.unk158 = 0; this.onHitFilter(HF.NO_COLLISION); }
    set() { this.pos.set(this.unk160!.pos); this.rot.set(this.unk160!.rot); }
    moveObject() {
        if (this.unk150 === 1) this.set();
        else { this.calcRideMomentum(); this.sendMessage(); this.bind(); this.calcRidePos(); }
    }
    sendMessage() {
        for (const c of this.collisions.slice()) {
            if (c.isActorType(AT.MARIO)) { this.world.mario.receiveMessage(this, MSG.ATTACK); continue; }
            if (c !== this.unk160) this.kill();
        }
    }
    calcRootMatrix() { MsMtxSetXYZRPH(this.baseTR, this.pos.x, this.pos.y, this.pos.z, this.rot.x, this.rot.y, this.rot.z); }
    perform(cue: number) {
        if (this.unk150 === 0) return;   // (CUE_CALC_ANIM: behaveToHost, which does nothing)
        const w = this.world;
        if (!w.demoMode && w.talkMode) { this.performOnlyDraw(cue); return; }
        if (cue & CUE_MOVE) this.moveObject();
        if (cue & CUE_CALC_ANIM) { this.calcRootMatrix(); if (this.mactor) this.mactor.frameUpdate(); }
    }
    drawn() { return this.unk150 !== 0 && super.drawn(); }
}

/** TGessoPolluteObj: the Blooper's ball of goop */
export class GessoPolluteObj extends EnemyAttachment {
    unk16C: Gesso | null = null;
    constructor(w: World, name = 'ゲッソー汚染物') { super(w, name); this.unk164 = fr(1.4); }
    loadInit(host: SpineEnemy, file: string) {
        super.loadInit(host, file);
        this.unk16C = host as Gesso;
        this.world.addToGroup('敵グループ', this);
        this.initHitActor(AT.POLLUTE_OBJ, 1, HC.PLAYER, 10, 10, 10, 10);
        this.offHitFilter(HF.NO_COLLISION);
        this.unk150 = 0;
        this.groundPlane = this.world.illegal;
    }
    getNowGravity() { const G = this.unk16C!.G; return this.unk16C!.unk1D8 === 0 ? G.mSLPolluteObjGravity : G.mSLPolluteObjLinerG; }
    pollute() {
        this.unk150 = 2; this.unk168 = 0;
        this.mactor!.setBck('gero_run1');
        this.mactor!.setBck('gero_run_loop1');
        this.offHitFilter(HF.NO_COLLISION);
        this.scale.set(this.unk164, this.unk164, this.unk164);
    }
    rebirth() {
        if (this.unk158 === 0) {
            this.world.effect('ms_geso_osenhit_a', this.pos);
            this.world.effect('ms_geso_osenhit_b', this.pos);
            this.world.sound(SE.EN_GESO_GERO_LAND, this.pos);
        }
        this.unk158 += 1;
        if (this.unk158 === 10) {
            this.vel.y = -15;
            if (this.world.pollution) this.world.pollution.stamp(1, this.pos.x, this.pos.y, this.pos.z, fr(Gesso.mPollRange * 32 * 0.5));
            (this.unk16C!.manager as GessoManager).requestPolluteModel(this.pos, this.scale);
        }
        if (this.unk158 > 20) { this.unk150 = 0; this.unk158 = 0; this.onHitFilter(HF.NO_COLLISION); }
        if (this.pos.y < fr(this.groundHeight - 30)) { this.vel.y = 0; this.onHitFilter(HF.NO_COLLISION); }
    }
    set() {
        super.set();
        const h = this.unk160!;
        if (h.checkLiveFlag(LF.CLIPPED_OUT)) this.pos.set(h.pos.x, fr(h.pos.y + 200), h.pos.z);
        else {
            const mouth = this.unk16C!.mouthPos();
            const v = this.vel.clone();
            if (v.x !== 0 || v.z !== 0) vnorm(v);
            this.pos.set(fr(v.x * 100 + mouth.x), mouth.y, fr(v.z * 100 + mouth.z));
        }
        this.mactor!.setBck('gero_run_loop1');
    }
    calcRootMatrix() {
        super.calcRootMatrix();
        if (this.unk168 !== 0) return;
        this.world.sound(SE.EN_GESO_GERO_FLY, this.pos);
        this.world.effect('ms_geso_kiseki', this.pos);
    }
    sendMessage() {
        for (const c of this.collisions.slice()) if (c.isActorType(AT.MARIO)) { this.world.mario.receiveMessage(this, MSG.ATTACK); this.kill(); }
    }
}

// ---------------------------------------------------------------- nerves
type S = Spine<Gesso>;
export const GessoNerves: Record<string, any> = {};
GessoNerves.stay = nerve<Gesso>('TNerveGessoStay', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setWaitAnm();
    self.rollCheck();
    self.polluteBehavior();
    return false;
});
GessoNerves.freeze = nerve<Gesso>('TNerveGessoFreeze', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        const v = V3.sub(self.pos, self.world.mario.pos);
        vnorm(v);
        v.y = 5; v.x = fr(v.x * 4); v.z = fr(v.z * 4);
        self.vel.set(v);
        self.pos.y = fr(self.pos.y + 2);
        self.onLiveFlag(LF.AIRBORNE);
        self.unk1DC.set(v);
        if (self.checkDropInWater()) { spine.pushAfterCurrent(GessoNerves.fall); return true; }
        self.setBckAnm(BCK_MAHI_START);
    }
    if (self.checkCurAnmEnd(ANM_BCK)) {
        if (self.isBckAnm(BCK_MAHI_START)) self.setBckAnm(BCK_MAHI_LOOP);
        else if (self.isBckAnm(BCK_MAHI_LOOP)) {
            if (spine.time > self.G.mSLFreezeWait && !self.unsetUnk165()) self.setBckAnm(BCK_MAHI_END);
            else self.mactor!.getFrameCtrl(ANM_BCK)!.frame = 0;
        } else if (self.isBckAnm(BCK_MAHI_END)) return true;
    }
    if (!self.isAirborne()) {
        if (self.unk1DC.y < 1.5) {
            if (self.isBckAnm(BCK_MAHI_LOOP)) self.world.effect('ms_poi_kizetsu', self.pos);
        } else {
            self.unk1DC.y = fr(self.unk1DC.y * fr(0.3));
            self.pos.y = fr(self.pos.y + 2);
            self.onLiveFlag(LF.AIRBORNE);
            self.vel.set(self.unk1DC);
        }
    } else if (self.goal.actor === self.world.mario) self.walkToCurPathNode(0, self.turnSpeed, 0);
    return false;
});
GessoNerves.punch = nerve<Gesso>('TNerveGessoPunch', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(BCK_PUNCH);
    return self.checkCurAnmEnd(ANM_BCK);
});
GessoNerves.pollute = nerve<Gesso>('TNerveGessoPollute', (spine: S) => {
    const self = spine.body;
    if (spine.time < 2) self.setPolluteGoal();
    if (self.isBckAnm(BCK_GERO) || self.isBckAnm(BCK_TURN_GERO)) {
        if (self.mactor!.getFrameCtrl(ANM_BCK)!.checkPass(50)) self.pollute();
        if (self.checkCurAnmEnd(ANM_BCK)) return true;
    } else {
        self.setBckAnm(self.isWandering() || self.mIsRightSideUp ? BCK_GERO : BCK_TURN_GERO);
        self.world.effect('gesso_gero', self.pos);   // (particle 0xBB on the mouth)
        self.mPolluteObj!.appear();
    }
    return false;
});
GessoNerves.fall = nerve<Gesso>('TNerveGessoFall', (spine: S) => {
    const self = spine.body, m = self.world.mario.pos;
    const away = (k: number) => {
        const v = V3.sub(self.pos, m); v.y = 0;
        if (v.x === 0 && v.z === 0) v.z = 1;
        vnorm(v);
        v.x = fr(v.x * k); v.z = fr(v.z * k);
        return v;
    };
    if (spine.time === 0) {
        self.setGoalPath(new PathNode(null, m.clone()));
        if (self.isWandering()) {
            self.vel.set(away(4));
            self.onLiveFlag(LF.AIRBORNE);
            self.setBckAnm(BCK_HIT);
        } else {
            if (self.mIsRightSideUp) self.setBckAnm(BCK_HIT);
            else { self.setBckAnm(BCK_TURN_HIT); self.pos.y = fr(self.pos.y - Gesso.mThroughHoseiDistY); }
            self.mState = GS_FALLING;
        }
        self.onLiveFlag(LF.UNK8);
    } else if (self.isWandering()) {
        if (self.checkCurAnmEnd(ANM_BCK)) {
            if (self.isBckAnm(BCK_HIT)) {
                const v = away(6); v.y = 5;
                self.vel.set(v);
                self.onLiveFlag(LF.AIRBORNE);
                self.setBckAnm(BCK_FALL);
            } else if (!self.isAirborne()) {
                if (self.groundPlane.isWaterSurface()) { self.generateEffectColumWater(); spine.pushAfterCurrent(SmallEnemyNerves.die); return true; }
                else if (self.isBckAnm(BCK_FALL)) self.setBckAnm(BCK_LAND);
                else if (self.isBckAnm(BCK_LAND)) { spine.pushAfterCurrent(WalkerNerves.graphWander); return true; }
            }
        }
    } else {
        if (self.isBckAnm(BCK_HIT) || self.isBckAnm(BCK_TURN_HIT)) {
            self.unk1D0 = fr(self.unk1D0 * fr(0.8));
            if (self.checkCurAnmEnd(ANM_BCK)) { self.mState = 4; self.setBckAnm(BCK_FALL); }
        } else if (self.isBckAnm(BCK_FALL)) {
            self.unk1D0 = fr(self.unk1D0 * fr(0.8));
            if (!self.isAirborne()) {
                if (self.groundPlane.isWaterSurface()) { self.generateEffectColumWater(); spine.pushAfterCurrent(SmallEnemyNerves.die); return true; }
                if (self.checkCurAnmEnd(ANM_BCK)) self.setBckAnm(BCK_LAND);
            }
        } else if (self.isBckAnm(BCK_LAND)) {
            self.offLiveFlag(LF.UNK8);
            self.modifyRotate();
            if (self.checkCurAnmEnd(ANM_BCK)) { self.fallEnd(); spine.pushAfterCurrent(WalkerNerves.graphWander); return true; }
        }
    }
    self.vel.x = fr(self.vel.x * fr(0.99)); self.vel.z = fr(self.vel.z * fr(0.99));
    return false;
});
GessoNerves.rolling = nerve<Gesso>('TNerveGessoRolling', (spine: S) => {
    const self = spine.body;
    if (spine.time < 2) self.setBckAnm(self.mIsRightSideUp ? BCK_TURN_DOWN : BCK_TURN_UP);
    else if (self.checkCurAnmEnd(ANM_BCK)) { self.rollEnd(); return true; }
    return false;
});
GessoNerves.findMario = nerve<Gesso>('TNerveGessoFindMario', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(BCK_SEARCH);
    return self.checkCurAnmEnd(ANM_BCK);
});
GessoNerves.land = nerve<Gesso>('TNerveGessoLand', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(BCK_STAIRLAND);
    if (self.checkCurAnmEnd(ANM_BCK)) { self.mNeedsLanding = false; return true; }
    return false;
});
GessoNerves.turn = nerve<Gesso>('TNerveGessoTurn', (spine: S) => {
    const self = spine.body;
    if (spine.time < 2) self.turnIn();
    else if (self.turning()) { self.turnOut(); return true; }
    return false;
});

register('GessoManager', (w, n) => new GessoManager(w, n));
register('Gesso', (w, n) => new Gesso(w, n));
register('SurfGesso', (w, n) => new SurfGesso(w, n));
register('LandGesso', (w, n) => new LandGesso(w, n));
export type { Mtx };
