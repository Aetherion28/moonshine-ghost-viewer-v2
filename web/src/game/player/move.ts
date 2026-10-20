// Player/MarioMove.cpp: statuses and their entry speeds, the controller, the planes he stands in,
// the per-tick thinking (situation, water surface, height), and playerControl.

import { V3, fr, s16, JMASSin, JMASCos, matan, mtxMultVec, mtxInverse, mtx, MsMtxSetXYZRPH } from '../math.js';
import { HitActor, MSG } from '../engine.js';
import { DONT_MOVE_XZ } from '../collision.js';
import { AT } from '../actortypes.js';
import { MarioBase, S, MF, A, bg, Bg, wallRecord } from './base.js';
import { SE } from '../soundids.js';

const sqrtf = (v: number) => fr(Math.sqrt(v));
/** MsSqrtf */
import { MsSqrtf } from './fmath.js';
export { MsSqrtf };

export abstract class MarioMove extends MarioBase {
    getJumpAccelControl() { return this.mStatus === S.WIRE_JUMP ? this.mWireParams.mWireJumpAccelControl : this.mJumpParams.mJumpAccelControl; }
    getJumpSlideControl() {
        if (this.mStatus === S.WIRE_JUMP) return this.mWireParams.mWireJumpSlideControl;
        if (this.onYoshi() && this.mYoshi!.mFlutterState === 1) return this.mYoshiParams.mHoldOutSldCtrl;
        return this.mJumpParams.mJumpSlideControl;
    }
    /** canSquat: FLUDD's nozzle out and R held (no FLUDD here) */
    canSquat() { return false; }
    /** mWaterGun->mWatergunParams.mHoverHeight (no water gun: 0) */
    hoverHeight() { return 0; }
    isUnderWater() { return this.checkFlag(MF.IN_ANY_WATER) && this.mHeadPos.y < this.mFloorPosition.z - this.mSwimParams.mCanBreathDepth; }
    isInvincible() {
        if (this.mInvincibilityFrames > 0) return true;
        if (this.checkFlag(MF.NPC_TALKING)) return true;
        if (this.mStatus === 0x89C) return true;
        if (this.checkStatusType(0x1000)) return true;
        return false;
    }
    isWallInFront() {
        if (this.mWallPlane) { const d = s16(this.getWallAngle() - this.mFaceAngle.y); if (d < -0x71C7 || d > 0x71C7) return true; }
        return false;
    }
    getRidingMtx() {
        const a = this.unk2C0;
        const m = a.getRootJointMtx ? a.getRootJointMtx() : null;
        if (m) return m;
        const r = mtx(); MsMtxSetXYZRPH(r, a.pos.x, a.pos.y, a.pos.z, a.rot.x, a.rot.y, a.rot.z); return r;
    }
    isForceSlip() {
        if (bg.isUnk1(this.mGroundPlane)) return true;
        if (this.mPollutionTypeStandingOn === 1 && this.checkFlag(MF.DIRTY) && this.mGroundPlane.n[1] < this.mDirtyParams.mSlopeAngle) return true;
        return this.mGroundPlane.n[1] < this.mDeParams.mForceSlipAngle;
    }
    moveRequest(p: V3) {
        const o = V3.sub(p, this.pos);
        this.pos.set(p);
        this.unk160.add(o); this.mPrevPosition.add(o); this.unk2A8.add(o); this.unk2BC = fr(this.unk2BC + o.y);
        this.mHeadMtx[3] += o.x; this.mHeadMtx[7] += o.y; this.mHeadMtx[11] += o.z;
        this.checkRideReCalc();
        return true;
    }
    warpRequest(p: V3, angle: number) { this.moveRequest(p); this.mFaceAngle.y = s16(angle * (65536 / 360)); this.mModelFaceAngle = this.mFaceAngle.y; this.changePlayerStatus(S.WAIT, 0, true); }
    flowMove(f: V3) { if (this.checkStatusType(0x2000)) this.pos.add(f); }
    windMove(f: V3) { this.pos.add(f); }
    getGroundJumpPower() { return this.mGroundPlane ? fr(0.01 * bg.activeJumpPower(this.mGroundPlane)) : 0; }
    addVelocity(v: number) { this.mForwardVel = fr(this.mForwardVel + v); if (this.mForwardVel > 99) this.mForwardVel = 99; }
    considerRotateJumpStart() {
        const r = this.checkStickRotate();
        if (r[0]) {
            if (r[1] === 2) this.changePlayerStatus(S.RIGHT_ROTATE_JUMP, 0, false);
            else if (r[1] === 3) this.changePlayerStatus(S.LEFT_ROTATE_JUMP, 0, false);
            return 1;
        }
        return 0;
    }
    canBendBody() { const a = this.mStatus & 0x1FF; return !((a >= 0x14B && a <= 0x14F) || (a >= 0x140 && a <= 0x143)); }
    setNormalAttackArea() { this.attackRadius = this.mDeParams.mHoldRadius; this.attackHeight = this.mDeParams.mAttackHeight; }
    setPlayerVelocity(v: number) {
        this.mForwardVel = fr(v);
        this.mSlideVelX = fr(this.mForwardVel * JMASSin(this.mFaceAngle.y));
        this.mSlideVelZ = fr(this.mForwardVel * JMASCos(this.mFaceAngle.y));
        this.mVel.x = this.mSlideVelX; this.mVel.z = this.mSlideVelZ;
    }
    /** checkWallPlane: the wall his body touches (the one he rides first, else the nearest); pos pushed out of them. */
    checkWallPlane(p: { x: number; y: number; z: number }, yOff: number, radius: number): Bg | null {
        let result: Bg | null = null, best = radius;
        const r = wallRecord(p.x, fr(p.y + yOff), p.z, radius, 4, 0);
        if (this.isTouchedWallsAndMoveXZ(r)) {
            for (const w of r.results) {
                if (w.actor && w.actor === this.unk2C0) { result = w; break; }
                let d = fr(fr(w.n[2] * p.z + fr(w.n[0] * p.x + fr(w.n[1] * p.y))) + w.d);
                if (d < 0) d = -d;
                if (d < best) { result = w; best = d; }
            }
        }
        p.x = fr(r.center[0]); p.z = fr(r.center[2]);
        return result;
    }
    checkRoofPlane(p: { x: number; z: number }, yOff: number): [number, Bg] { return this.checkRoof(p.x, fr(80 + yOff), p.z); }
    isFrontSlip(back: number) {
        let a = this.mFaceAngle.y;
        if (back !== 0 && this.mForwardVel < 0) a += 0x8000;
        const d = s16(this.mSlopeAngle - a);
        return d > -0x4000 && d < 0x4000;
    }
    isSlipStart() {
        const g = this.mGroundPlane;
        if (this.isForceSlip()) return true;
        if (bg.isSlider(g)) return true;
        if (bg.isUnk2(g) && g.n[1] < 0.8660254) return true;
        if (bg.isUnk3(g)) return false;
        return g.n[1] < this.mDeParams.mSlipStart;
    }
    canSlipJump(): number {
        const g = this.mGroundPlane;
        if (this.isForceSlip()) return this.mSlipParamsAll.mJumpEnable;
        if (bg.isSlider(g)) return this.mSlipParamsAllSlider.mJumpEnable;
        if (bg.isUnk2(g)) return this.mSlipParams45.mJumpEnable;
        if (bg.isWetGround(g)) return g.n[1] > 0.99 ? this.mSlipParamsWaterGround.mJumpEnable : this.mSlipParamsWaterSlope.mJumpEnable;
        return 1;
    }
    getSlideStopNormal() {
        const g = this.mGroundPlane;
        if (this.isForceSlip()) return this.mSlipParamsAll.mSlideStopNormal;
        if (bg.isSlider(g)) return this.mSlipParamsAllSlider.mSlideStopNormal;
        if (bg.isUnk2(g) && g.n[1] < 0.8660254) return this.mSlipParams45.mSlideStopNormal;
        if (bg.isWetGround(g) && g.n[1] > 0.99) return this.mSlipParamsWaterGround.mSlideStopNormal;
        return this.mSlipParamsWaterSlope.mSlideStopNormal;
    }
    getSlideStopCatch() {
        const g = this.mGroundPlane;
        if (this.isForceSlip()) return this.mSlipParamsAll.mSlideStopCatch;
        if (bg.isSlider(g)) return this.mSlipParamsAllSlider.mSlideStopCatch;
        if (bg.isUnk2(g) && g.n[1] < 0.8660254) return this.mSlipParams45.mSlideStopCatch;
        if (bg.isWetGround(g)) return g.n[1] > 0.99 ? this.mSlipParamsWaterGround.mSlideStopCatch : this.mSlipParamsWaterSlope.mSlideStopCatch;
        return this.mSlipParamsNormal.mSlideStopCatch;
    }
    isJumpMiss(): number {
        const g = this.mGroundPlane;
        if (this.isForceSlip()) return this.mSlipParamsAll.mMissJump;
        if (bg.isSlider(g)) return this.mSlipParamsAllSlider.mMissJump;
        if (bg.isUnk2(g) && g.n[1] < 0.8660254) return this.mSlipParams45.mMissJump;
        if (bg.isWetGround(g)) return g.n[1] > 0.99 ? this.mSlipParamsWaterGround.mMissJump : this.mSlipParamsWaterSlope.mMissJump;
        return this.mSlipParamsNormal.mMissJump;
    }
    checkPlayerAround(off: number, dist: number) {
        const ox = fr(dist * JMASSin(this.mFaceAngle.y + off)), oz = fr(dist * JMASCos(this.mFaceAngle.y + off));
        return this.checkGround(fr(this.pos.x + ox), fr(100 + this.pos.y), fr(this.pos.z + oz))[0];
    }
    setMissJumping() {
        this.mFaceAngle.x = 0;
        this.mModelFaceAngle = this.mFaceAngle.y;
        if (this.mForwardVel > 0) {
            const slope = s16(this.mSlopeAngle + 0x8000);
            const a = s16(this.mFaceAngle.y - slope);
            const x = fr(this.mForwardVel * JMASSin(a)), z = fr(this.mForwardVel * JMASCos(a) * 0.75);
            this.setPlayerVelocity(MsSqrtf(x * x + z * z));
            this.mFaceAngle.y = s16(slope + matan(z, x));
        }
        this.dropObject();
        this.changePlayerStatus(S.MISS_JUMP, 0, false);
    }
    setPlayerJumpSpeed(mult: number, force: number) { this.mVel.y = fr(this.mForwardVel * mult + force); }
    setStatusToJumping(status: number, arg: number) {
        let next = status;
        this.unk2BC = this.pos.y;
        if (this.mFootPrintTimer > Math.trunc(this.mDeParams.mFootPrintTimerMax / 2) && this.world.pollution)
            this.world.pollution.stamp(1, this.pos.x, this.pos.y, this.pos.z, this.mDirtyParams.mPolSizeJump);
        const J = this.mJumpParams, g = this.mGroundPlane;
        switch (status) {
            case S.JUMP: case 0x89C:
                this.setPlayerJumpSpeed(0.25, 42);
                this.mForwardVel = fr(this.mForwardVel * 0.8);
                if (!g.isIllegal()) {
                    if (bg.isThing2(g)) { this.mVel.y = fr(0.01 * bg.activeJumpPower(g)); next = S.FORCE_JUMP; break; }
                    else if (bg.isThing3(g)) {
                        this.mVel.y = fr(this.mVel.y + (-this.unkBC + this.getGroundJumpPower()));
                        if (g.actor) (g.actor as HitActor).receiveMessage(this, MSG.TRAMPLE);
                        this.startVoice(SE.MV24_JUMP_SPECIAL_01);
                        next = S.FORCE_JUMP; break;
                    }
                }
                this.startVoice(this.isFeelDeep() ? SE.MV19_JMP_PT_01 : SE.MV21_JUMP_SMALL_01);
                break;
            case S.SECOND_JUMP: this.setPlayerJumpSpeed(J.mSecJumpSpeedMult, J.mSecJumpForce); this.mForwardVel = fr(this.mForwardVel * J.mSecJumpXZMult); this.startVoice(SE.MV22_JUMP_MID_01); break;
            case S.ULTRA_JUMP: this.setPlayerJumpSpeed(J.mUltraJumpSpeedMult, J.mUltraJumpForce); this.mForwardVel = fr(this.mForwardVel * J.mUltraJumpXZMult); this.startVoice(SE.MV23_JUMP_LARGE_01); break;
            case S.FORCE_JUMP: this.mVel.y = this.getGroundJumpPower(); this.startVoice(SE.MV22_JUMP_MID_01); break;
            case S.LEFT_ROTATE_JUMP: case S.RIGHT_ROTATE_JUMP: this.setPlayerJumpSpeed(0.25, J.mRotateJumpForceY); this.mForwardVel = fr(this.mForwardVel * 0.8); this.startVoice(SE.MV23_JUMP_LARGE_01); break;
            case S.FIRE_JUMP: this.mVel.y = 31.5; this.mForwardVel = 8; break;
            case 0x281089A: {
                this.startVoice(SE.MV21_JUMP_SMALL_01);
                const [, d] = this.checkGround(this.pos.x, this.pos.y, this.pos.z);
                if (d.isWaterSurface()) this.setPlayerJumpSpeed(this.mSurfingParamsWaterRed.mJumpXZRatio, this.mSurfingParamsWaterRed.mJumpPow);
                else this.setPlayerJumpSpeed(this.mSurfingParamsGroundRed.mJumpXZRatio, this.mSurfingParamsGroundRed.mJumpPow);
                break;
            }
            case S.BACK_JUMP: this.mForwardVel = J.mBackJumpForce; this.setPlayerJumpSpeed(0, J.mBackJumpForceY); this.startVoice(SE.MV23_JUMP_LARGE_01); break;
            case S.WALL_JUMP: this.setPlayerJumpSpeed(0, 62); this.mForwardVel = 24; this.startVoice(SE.MV22_JUMP_MID_01); break;
            case S.U_TURN_JUMP: this.setPlayerJumpSpeed(0, J.mTurnJumpForce); this.mForwardVel = 8; this.mFaceAngle.y = this.mIntendedYaw; this.startVoice(SE.MV23_JUMP_LARGE_01); break;
            case S.MISS_JUMP: this.startVoice(SE.MV21_JUMP_SMALL_01); this.setPlayerJumpSpeed(0.25, 42); break;
            case S.THROWN_DOWN: break;
            case S.FIRE_DOWN:
                if (this.mStatusArg !== 2) { this.mVel.y = J.mFireDownForce; if (this.mStatusArg === 0) this.mForwardVel = -J.mFireBackVelocity; }
                break;
            case S.JUMP_CATCH: {
                this.startVoice(SE.MV13_ACTION_SMALL_01);
                let sp = fr(15 + this.mForwardVel);
                if (sp > 48) sp = 48;
                this.mForwardVel = sp;
                this.mSlideVelX = fr(this.mForwardVel * JMASSin(this.mFaceAngle.y)); this.mSlideVelZ = fr(this.mForwardVel * JMASCos(this.mFaceAngle.y));
                this.mVel.x = this.mSlideVelX; this.mVel.z = this.mSlideVelZ;
                break;
            }
            case S.BROAD_JUMP: this.startVoice(SE.MV22_JUMP_MID_01); this.mForwardVel = J.mBroadJumpForce; this.mVel.y = J.mBroadJumpForceY; break;
            case S.ROTATE_BROAD_JUMP: this.startVoice(SE.MV22_JUMP_MID_01); this.mForwardVel = J.mRotBroadJumpForce; this.mVel.y = J.mRotBroadJumpForceY; break;
            case S.ROCKET: {
                // the nozzle's line (the jump speed and rocketEffectStart are not simulated here)
                const G = (this as any).mWaterGun as { mCurrentNozzle: number } | null;
                if (G) {
                    if (G.mCurrentNozzle === 1) this.startVoice(SE.MV24_JUMP_SPECIAL_01);
                    if (G.mCurrentNozzle === 5) this.startVoice(SE.MV15_EXERT_INST_01);
                    if (G.mCurrentNozzle === 4) this.startVoice(SE.MV21_JUMP_SMALL_01);
                }
                break;
            }
            case S.TRAMPLE:
                switch (this.mAnimationId) {
                    default: this.startVoice(SE.MV21_JUMP_SMALL_01); this.setPlayerJumpSpeed(0.25, this.mDeParams.mTramplePowStep1); break;
                    case A.STEP2: this.startVoice(SE.MV22_JUMP_MID_01); this.setPlayerJumpSpeed(0.25, this.mDeParams.mTramplePowStep2); break;
                    case A.STEP3: this.startVoice(SE.MV23_JUMP_LARGE_01); this.setPlayerJumpSpeed(0.25, this.mDeParams.mTramplePowStep3); break;
                }
                this.mForwardVel = fr(this.mForwardVel * 0.8);
                break;
            case S.WIRE_JUMP: case S.PULL_JUMP:
                this.setPlayerJumpSpeed(status === S.WIRE_JUMP ? 0.25 : 0, 42);
                this.mForwardVel = 0; this.mSlideVelX = 0; this.mSlideVelZ = 0; this.mVel.x = 0; this.mVel.z = 0;
                this.startVoice(status === S.WIRE_JUMP ? SE.MV23_JUMP_LARGE_01 : SE.MV21_JUMP_SMALL_01);
                break;
            case S.WIRE_ROLL_JUMP: {
                const p = fr(this.unkF6 * this.mWireParams.mJumpRate * 1);
                const a = arg === 0 ? 0xE000 : 0x6000;
                this.mVel.y = fr(p * JMASSin(a));
                this.setPlayerVelocity(fr(p * -JMASCos(a)));
                this.startVoice(SE.MV24_JUMP_SPECIAL_01);
                break;
            }
        }
        if (this.isSinking()) {
            const G = this.mGraffitoParams;
            const k = fr(1 - this.mSinkTimer / G.mSinkTime);
            const sc = fr((G.mSinkJumpRateMax - G.mSinkJumpRateMin) * k + G.mSinkJumpRateMin);
            this.mVel.y = fr(this.mVel.y * sc); this.mForwardVel = fr(this.mForwardVel * sc);
            this.mSinkTimer = fr(this.mSinkTimer - k * (G.mSinkTime * G.mSinkRecover));
            if (this.mSinkTimer < 0) this.mSinkTimer = 0;
        }
        // on Yoshi: mJumpYoshiMult, and the flutter made ready (TYoshi::thinkHoldOut)
        if (this.onYoshi()) {
            const Y = this.mYoshi!;
            this.mVel.y = fr(this.mVel.y * this.mYoshiParams.mJumpYoshiMult);
            Y.mFlutterState = 0;
            Y.mFlutterTimer = Y.mMaxFlutterTimer;
        }
        this.unk104 = this.pos.y;
        if (next & 0x2000000) this.unk78 |= 0x100; else this.unk78 &= ~0x100;
        return next;
    }
    setStatusToRunning(status: number, _arg: number) {
        const mag = this.mIntendedMag <= 8 ? this.mIntendedMag : 8;
        switch (status) {
            case S.RUN: if (0 <= this.mForwardVel && this.mForwardVel < mag) this.mForwardVel = mag; break;
            case S.SLIP: status = this.isFrontSlip(0) ? S.SLIP_FORE : S.SLIP_BACK; this.startVoice(SE.MV27_SPRISE_01); break;
        }
        return status;
    }
    throwMario(v: V3, power: number) {
        const t = v.clone();
        if (t.squared() <= 3.8146973e-6) t.y = 1;
        t.normalize();
        this.mFaceAngle.y = s16(matan(t.z, t.x) + 0x8000);
        this.mModelFaceAngle = this.mFaceAngle.y;
        this.mForwardVel = fr(power * -sqrtf(t.x * t.x + t.z * t.z));
        this.mVel.y = fr(t.y * power);
    }
    changePlayerStatus(status: number, arg: number, force: boolean): number {
        status = status >>> 0;
        if (!force) {
            if (status === this.mStatus) return 0;
            if (this.checkStatusType(0x1000)) return 0;
        }
        if (this.mStatus === S.LOSER_DOWN) return 0;
        switch (status & 0x1C0) {
            case 0x40: status = this.setStatusToRunning(status, arg) >>> 0; break;
            case 0x80: status = this.setStatusToJumping(status, arg) >>> 0; break;
        }
        this.mPrevStatus = this.mStatus;
        this.mStatus = status;
        this.mStatusArg = arg;
        this.mStatusState = 0;
        this.mStatusTimer = 0;
        return 1;
    }
    changePlayerTriJump() {
        if (this.isJumpMiss()) this.setMissJumping();
        else { if (this.considerRotateJumpStart()) return 1; this.changePlayerStatus(S.JUMP, 0, false); }
        return 1;
    }
    changePlayerJumping(st: number, arg: number) {
        if (this.isJumpMiss()) this.setMissJumping();
        else { if (this.considerRotateJumpStart()) return 1; this.changePlayerStatus(st, arg, false); }
        return 1;
    }
    changePlayerDropping(st: number, arg: number) { this.dropObject(); return this.changePlayerStatus(st, arg, false); }
    checkAllMotions() {
        if (this.mInput & 2) { if (this.considerRotateJumpStart()) return 1; return this.changePlayerStatus(S.JUMP, 0, false); }
        if (this.mInput & 4) return this.changePlayerStatus(S.LANDING, 0, false);
        if (this.mInput & 1) return this.changePlayerStatus(S.RUN, 0, false);
        if (this.mInput & 8) return this.changePlayerStatus(S.SLIP, 0, false);
        return 0;
    }
    /** checkGraffito: Shadow Mario and Il Piantissimo skip it (and so this port, for now: the player is the ghost) */
    checkGraffito() {
        if (this.mGroundPlane.isIllegal()) return;
        if (this.mPlayerType === 1 || this.mPlayerType === 2) return;
    }
    dirtyLimitCheck() { if (this.mDirty < 0) this.mDirty = 0; if (this.mDirtyParams.mDirtyMax < this.mDirty) this.mDirty = this.mDirtyParams.mDirtyMax; }
    thinkDirty() {
        const D = this.mDirtyParams;
        if (this.checkFlag(MF.DIRTY)) {
            if (this.mStatus === S.RUN || this.mStatus === S.OIL_RUN) this.mDirty = fr(this.mDirty + D.mIncRunning);
            if (this.mStatus === S.CATCH || this.mStatus === S.OIL_SLIP || this.mStatus === S.OIL_SLOPE) this.mDirty = fr(this.mDirty + D.mIncCatching);
            if (this.mStatus === S.SLIP) this.mDirty = fr(this.mDirty + D.mIncSlipping);
        }
        if (this.checkFlag(MF.IN_ANY_WATER)) { this.mFootPrintTimer = 0; this.mDirty = fr(this.mDirty - D.mDecSwimming); }
        if (this.mStatus === S.LEFT_ROTATE_JUMP || this.mStatus === S.RIGHT_ROTATE_JUMP) { this.mDirty = fr(this.mDirty - D.mDecRotJump); this.mFootPrintTimer = 0; }
        if (this.checkFlag(MF.RECENTLY_LEFT_WATER)) { this.mDirty = fr(this.mDirty - D.mDecWaterHit); this.mFootPrintTimer = 0; }
        this.dirtyLimitCheck();
    }
    thinkHeight() {
        if (this.checkStatusType(0x800)) { const h = fr(this.pos.y - this.mFloorPosition.y); if (this.unk36C < h) this.unk36C = h; }
        else this.unk36C = 0;
        const p = { x: fr(this.pos.x + this.unk15C * JMASSin(this.mFaceAngle.y)), y: this.pos.y, z: fr(this.pos.z + this.unk15C * JMASCos(this.mFaceAngle.y)) };
        if (!this.checkWallPlane(p, 80, this.unk15C)) this.unk370 = fr(this.pos.y - this.checkPlayerAround(0, 100));
        else this.unk370 = 0;
    }
    checkSink() {
        if (this.isInvincible()) return;
        if (this.mGroundPlane.isIllegal()) return;
        if (this.mFloorPosition.y + 100 < this.pos.y) { this.mSinkTimer = 0; return; }
        // (the sinking and deadly goop: graffito, which Shadow Mario doesn't read)
        this.unk374 = 0; this.unk378 = 0; this.mSinkTimer = 0;
    }
    checkEnforceJump() {
        const g = this.mGroundPlane;
        if (g.isLegal() && bg.isBounceOnLanding(g) && this.isTouchGround4cm() && (this.mPrevStatus & 0x800)) {
            this.startVoice(SE.MV24_JUMP_SPECIAL_01);
            this.changePlayerStatus(S.FORCE_JUMP, 0, false);
            if (g.actor) (g.actor as HitActor).receiveMessage(this, MSG.TRAMPLE);
        }
    }
    checkReturn() {
        if (this.isInvincible()) return;
        if (!this.mGroundPlane.isLegal()) return;
        this.unk2A8.set(this.pos);
        this.unk2B4 = { ...this.mFaceAngle };
    }
    checkThrowObject() { if (this.mModel.fc[0].checkPass(4)) { this.startVoice(SE.MV15_EXERT_INST_01); this.dropObject(); } }
    getLRLevel(level: number) {
        const C = this.mControllerParams;
        const zero = C.mAnalogLRToZeroVal, mid = C.mAnalogLRToMiddleVal, max = C.mAnalogLRToMaxVal, ml = C.mAnalogLRMiddleLevel;
        if (level < zero) return 0;
        if (level < mid) return fr(ml * (level - zero) / (mid - zero));
        if (level < max) return fr(ml + (1 - ml) * (level - mid) / (max - mid));
        return 1;
    }
    /** checkController: the player's pad. (TEnemyMario has its own.) */
    checkController() { }
    /** checkStickRotate: [rotated, direction (2 left, 3 right, 4 none)]. The quadrant flags start uninitialised in the game. */
    checkStickRotate(): [number, number] {
        let inc = 0, dec = 0;
        const q = [0, 0, 0, 0];
        for (let i = 0; i < this.unk534 - 1; i++) {
            const a = this.unk530[i];
            if (a < -24576 || a > 24576) q[0] = 1;
            if (-24576 <= a && a <= -8192) q[1] = 1;
            if (-8192 < a && a < 8192) q[2] = 1;
            if (8192 <= a && a <= 24576) q[3] = 1;
            if (a < this.unk530[i + 1]) inc++; else dec++;
        }
        if (q[0] + q[1] + q[2] + q[3] >= 4) return [1, inc > dec ? 2 : 3];
        return [0, 4];
    }
    makeHistory() {
        const n = this.mControllerParams.mStickRotateTime;
        if (this.mIntendedMag > 0) {
            if (this.unk534 === 0) this.unk536 = this.mFaceAngle.y;
            this.unk530[this.unk534] = this.mIntendedYaw;
            this.unk534 += 1;
            if (this.unk534 >= n) {
                for (let i = 0; i < n; i++) this.unk530[i] = this.unk530[i + 1];
                this.unk534 = n - 1;
            }
            const d = s16(this.mIntendedYaw - this.mFaceAngle.y);
            if (d >= -0x2000 && d <= 0x2000) { this.unk538 += 1; if (this.unk538 > 0x78) { this.unk53B = 6; this.unk538 = 0x78; } }
            else this.unk538 = 0;
        } else { this.unk534 = 0; this.unk538 = 0; }
        if (this.unk53B !== 0) { this.unk53A = 1; this.unk53B -= 1; } else { this.unk53A = 0; this.unk53B = 0; }
    }
    /** checkGroundPlane: [height, plane, legal]; a plane Mario goes through is looked under. */
    checkGroundPlane(x: number, y: number, z: number): [number, Bg, boolean] {
        let [h, d] = this.checkGround(x, y, z);
        if (d.isMarioThrough()) [h, d] = this.checkGround(x, fr(h - 1), z);
        return [h, d, d.isLegal()];
    }
    checkCurrentPlane() {
        if (this.checkStatusType(0x1000)) return;
        this.unk15C = this.onYoshi() ? 80 : 50;
        const r = wallRecord(this.pos.x, fr(this.pos.y + 60), this.pos.z, this.unk15C, 2, 0);
        this.isTouchedWallsAndMoveXZ(r);
        if (!this.isInvincible()) {
            for (const w of r.results) if (bg.isThing5(w)) this.damageExecCode(w.data);
            if (r.results.length === 2 && r.results[0].n[0] * r.results[1].n[0] + r.results[0].n[1] * r.results[1].n[1] + r.results[0].n[2] * r.results[1].n[2] < -0.9) {
                const dist = (w: Bg) => fr(w.n[0] * this.pos.x + w.n[1] * this.pos.y + w.n[2] * this.pos.z + w.d);
                const d1 = dist(r.results[0]), d2 = dist(r.results[1]);
                const mb = (w: Bg) => w.actor && w.actor.actorType === AT.MOVE_BLOCK;
                if ((mb(r.results[0]) || mb(r.results[1])) && (d1 < 10 || d2 < 10)) this.floorDamageExec(this.mDeParams.mHPMax, 3, 0, this.mMotorParams.mMotorReturn);
            }
        }
        const r2 = wallRecord(this.pos.x, fr(this.pos.y + 30), this.pos.z, fr(this.unk15C * 0.5), 1, 0);
        this.isTouchedWallsAndMoveXZ(r2);
        if (!this.isInvincible()) for (const w of r2.results) if (bg.isThing5(w)) this.damageExecCode(w.data);
        const [h, d] = this.checkGroundPlane(this.pos.x, fr(this.pos.y + 25), this.pos.z);
        this.mFloorPosition.y = h; this.mGroundPlane = d;
        const [rh, rd] = this.checkRoof(this.pos.x, fr(this.pos.y + 80), this.pos.z);
        this.mFloorPosition.x = rh; this.mRoofPlane = rd;
        if (!this.isInvincible()) {
            if (this.isTouchGround4cm() && bg.isThing5(this.mGroundPlane) && !this.checkStatusType(0x10000)) this.damageExecCode(this.mGroundPlane.data);
            if (this.pos.y + 160 > this.mFloorPosition.x && bg.isThing5(this.mRoofPlane)) this.damageExecCode(this.mRoofPlane.data);
        }
        if (this.mGroundPlane.isLegal()) {
            this.mSlopeAngle = matan(this.mGroundPlane.n[2], this.mGroundPlane.n[0]);
            if (this.isSlipStart() || this.checkFlag(MF.GROUND_POUND_SIT_UP)) this.mInput |= 8;
            if (this.pos.y > this.mFloorPosition.y + 100) this.mInput |= 4;
        }
        this.offFlag(MF.GROUND_POUND_SIT_UP);
    }
    /** damageExec(hittingActor, code): the map damage of a plane (its data) */
    damageExecCode(code: number) {
        const p = this.getDmgMapCode(code);
        this.damageExec(null, p.mDamage, p.mDownType, p.mWaterEmit, p.mMinSpeed, p.mMotor, p.mDirty, p.mInvincibleTime);
    }
    checkRideMovement() {
        let actor: any = null;
        const p = { x: fr(this.pos.x + 0.8 * fr(50 * JMASSin(this.mFaceAngle.y))), y: this.pos.y, z: fr(this.pos.z + 0.8 * fr(50 * JMASCos(this.mFaceAngle.y))) };
        const wall = this.checkWallPlane(p, 50, this.unk15C);
        const ga = this.mGroundPlane.actor;
        if (ga && !this.checkStatusType(0x800) && this.isTouchGround4cm()) actor = ga;
        if (ga && this.mStatus === S.HIP_DROP && (this.mStatusState === 2 || this.mStatusState === 3)) actor = ga;
        if (this.checkStatusType(0x20000000) && wall && wall.actor) actor = wall.actor;
        if (actor) {
            if (!this.unk2C0 || this.unk2C0 !== actor) { this.unk2C0 = actor; this.unk30C = actor.rot.y; this.checkRideReCalc(); }
            else {
                mtxMultVec(this.getRidingMtx(), this.unk2F4, this.pos);
                this.mFaceAngle.y = s16(this.mFaceAngle.y + s16(fr((this.unk2C0.rot.y - this.unk30C) * 32768 / 180)));
                this.unk30C = this.unk2C0.rot.y;
            }
        } else this.unk2C0 = null;
    }
    checkRideReCalc() {
        if (!this.unk2C0) return;
        const inv = mtxInverse(this.getRidingMtx());
        this.unk300.set(this.unk2F4);
        mtxMultVec(inv, this.pos, this.unk2F4);
    }
    checkPlayerAction() {
        this.mInput = 0;
        this.checkController();
        this.makeHistory();
        this.checkCurrentPlane();
        this.checkRideMovement();
        if (!(this.mInput & 3)) this.mInput |= 0x20;
    }
    stateMachine() {
        let r = 1;
        for (let guard = 0; r !== 0 && guard < 64; guard++) {
            switch (this.mStatus & 0x1C0) {
                case 0x000: r = this.waitMain(); break;
                case 0x040: r = this.moveMain(); break;
                case 0x080: r = this.jumpMain(); break;
                case 0x0C0: r = this.swimMain(); break;
                case 0x100: r = this.demoMain(); break;
                case 0x140: r = this.specMain(); break;
                case 0x180: r = this.actnMain(); break;
                default: r = 0;
            }
        }
    }
    thinkSituation() {
        this.mPrevFlag = this.mFlag;
        if (this.unkBC < 0) this.unkBC = fr(this.unkBC + this.mJumpParams.mTrampolineDec); else this.unkBC = 0;
        const h = this.holder as any;
        const hm = h && h.getTakingMtx ? h.getTakingMtx() : null;
        if (hm) this.pos.set(hm[3], hm[7], hm[11]);
        this.offFlag(MF.VISIBLE); this.offFlag(MF.UNK_20);
        if (bg.isUnderground(this.mGroundPlane)) this.onFlag(MF.VISIBLE);
        if (this.isMario() && this.isTouchGround4cm() && this.mStatus !== S.DISAPPEAR && (this.mGroundPlane.isIllegal() || bg.isOob(this.mGroundPlane))) {
            this.mOobKillTimer += this.mDeParams.mIllegalPlaneCtInc;
            if (this.mOobKillTimer > this.mDeParams.mIllegalPlaneTime) this.decHP(this.mDeParams.mHPMax);
        } else { this.mOobKillTimer -= 1; if (this.mOobKillTimer < 0) this.mOobKillTimer = 0; }
        const [dy, d] = this.checkGround(this.pos.x, fr(this.pos.y - this.mVel.y), this.pos.z);
        if (d.isDeathPlane() && dy > this.pos.y) {
            this.onFlag(MF.GAME_OVER); this.mHealth = 0;
            if (this.mYoshi) this.mYoshi.kill();
            this.changePlayerStatus(S.FALL_DEAD, 0, true);
            return;
        }
        this.mLightID = 0;
        if (bg.isShadow(this.mGroundPlane) && this.mFloorPosition.y + 200 > this.pos.y) { this.mLightID = this.mGroundPlane.data; if (this.mLightID === 1) this.onFlag(MF.UNK_20); }
        this.offFlag(MF.RECENTLY_LEFT_WATER);
        if (!this.checkStatusType(0x800)) this.unk2BC = this.pos.y;
        if (this.checkStatusType(0x1000)) this.onFlag(MF.NPC_TALKING); else this.offFlag(MF.NPC_TALKING);
    }
    thinkWaterSurface() {
        if (this.checkStatusType(0x10000)) return;
        const wasIn = this.checkFlag(MF.IN_ANY_WATER);
        let isIn = false;
        if (this.checkFlag(MF.IN_ANY_WATER)) isIn = true; else this.mFloorPosition.z = this.pos.y;
        this.offFlag(MF.IN_SHALLOW_WATER); this.offFlag(MF.IN_WATER);
        const g = this.mGroundPlane;
        if (g.isPool()) {
            const a = g.actor as any;
            this.mFloorPosition.z = a && a.getWaterLevel ? a.getWaterLevel() : fr(g.minY + 100);
            if (this.mFloorPosition.z > this.pos.y) { isIn = true; this.onFlag(MF.IN_SHALLOW_WATER); }
        }
        let dy = fr(this.pos.y - this.mPrevPosition.y);
        if (dy > 0) dy = 0;
        const [wy, wf] = this.checkGround(this.pos.x, fr(this.mFloorPosition.z - dy + this.mSwimParams.mWaterLevelCheckHeight), this.pos.z);
        this.mWaterFloor = wf;
        if (wf.isWaterSurface()) {
            this.mFloorPosition.z = wy;
            if (this.mFloorPosition.z >= this.pos.y) { isIn = true; this.onFlag(MF.IN_WATER); }
        } else {
            const [, l] = this.checkGround(this.pos.x, this.pos.y, this.pos.z);
            if (bg.isCamNoclipUnk10B(l)) { isIn = true; this.onFlag(MF.IN_WATER); }
        }
        if (isIn && this.pos.y < this.mFloorPosition.z) {
            if (this.mFloorPosition.z > this.pos.y + this.mRunParams.mSwimDepth) {
                // deep water: Yoshi goes (TYoshi::disappear), FLUDD back to the hover nozzle
                if (this.onYoshi()) {
                    this.mYoshi!.disappear();
                    const G = (this as any).mWaterGun;
                    if (G) { G.changeNozzle(4, true); (this as any).normalizeNozzle?.(); }
                }
                const id = this.mStatus & 0x1FF;
                let can = true;
                if (this.checkStatusType(0x2000)) can = false;
                if (this.isFencing()) can = false;
                if (id >= 0x145 && id <= 0x14A) can = false;
                if (id >= 0x140 && id <= 0x143) can = false;
                if (this.isTaken()) can = false;
                if (can) {
                    this.mForwardVel = fr(this.mForwardVel * this.mSwimParams.mStartVMult);
                    this.mVel.y = fr(this.mVel.y * this.mSwimParams.mStartVYMult);
                    // (the game asks checkStatusType(MARIO_FLAG_IN_WATER): a status bit 0x20000, the "down" statuses)
                    if (this.checkStatusType(MF.IN_WATER)) this.changePlayerStatus(S.SWIM_P_DAMAGE, 0, true);
                    else if (this.checkFlag(MF.FLUDD_EMITTING)) { this.changePlayerStatus(S.SWIM_PADDLE, 0, true); this.mVel.y = 0; this.pos.y = this.mFloorPosition.z; }
                    else this.changePlayerStatus(S.SWIM_START, 0, true);
                }
            }
        }
        const head = this.mModel.anmMtx(this.mJointIdHead);
        if (head) for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) this.mHeadMtx[i * 4 + j] = head[j * 4 + i];
        this.mWaterRipplePos.set(this.pos.x, this.mFloorPosition.z, this.pos.z);
        const nowIn = this.checkFlag(MF.IN_ANY_WATER);
        if (nowIn !== wasIn) { if (wasIn && !nowIn) this.mWetWaterParticleTimer = 120; this.effect(nowIn ? 'intoWater' : 'outOfWater'); }
        if (this.isUnderWater()) {
            const prev = this.mAir;
            this.mAir = fr(this.mAir - this.mSwimParams.mAirDec);
            if (Math.trunc(prev) !== Math.trunc(this.mAir)) this.mInvincibilityFrames = s16(this.unk55C);
            if (this.mAir < 1) { this.mAir = 0; this.loserExec(); this.changePlayerStatus(S.SWIM_DOWN, 0, false); }
        } else { this.mAir = fr(this.mAir + this.mSwimParams.mAirInc); if (this.mAir >= this.mMaxAir) this.mAir = this.mMaxAir; }
    }
    thinkSand() { if (!this.checkFlag(MF.IN_ANY_WATER) && bg.isSand(this.mGroundPlane)) this.onFlag(MF.ON_SAND); else this.offFlag(MF.ON_SAND); }
    thinkParams() {
        this.rot.y = fr(this.mFaceAngle.y * (360 / 65536));
        if (this.mInvincibilityFrames > 0) this.mInvincibilityFrames -= 1;
        if (!this.checkFlag(MF.GAME_OVER)) {
            if (this.checkFlag(MF.IN_ANY_WATER)) {
                if (!this.isUnderWater() && bg.isThing5(this.mWaterFloor) && !this.checkStatusType(0x10000)) {
                    const p = this.getDmgMapCode(this.mWaterFloor.data);
                    this.floorDamageExec(p.mDamage, p.mDownType, p.mWaterEmit, p.mMotor);
                }
                this.mHotTimer = 0; this.mHotTimerMax = this.mDeParams.mHotTimer;
            } else this.unk122 = 0;   // (no cap: no heat)
        }
    }
    checkWet() { /* the player's only (isMario) */ }
    gunExec() { /* no FLUDD */ }
    thinkSound() { }
    stateMachineUpper() { }
}
export { S, MF, A, bg, DONT_MOVE_XZ };
