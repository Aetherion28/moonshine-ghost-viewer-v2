// Player/MarioRun.cpp: running, turning, braking, sliding and slipping, the down statuses, landing
// slips, and moveMain.

import { fr, s16, JMASSin, JMASCos, matan, IConverge, FConverge } from '../math.js';
import { MarioPhysics } from './physics.js';
import { MsSqrtf } from './move.js';
import { fmul, fadd, fsub, fdiv, fmadd, fnmsub, sqrtf } from './fmath.js';
import { S, MF, A, bg } from './base.js';
import { SE } from '../soundids.js';

type JumpSlipRecord = { max: number; end: number; jump: number; c: number; d: number };
const iconv = (v: number, t: number, inc: number, dec: number) => IConverge(Math.trunc(v), t, Math.trunc(inc), Math.trunc(dec));

export abstract class MarioRun extends MarioPhysics {
    considerRotateStart() { return 0; /* only while FLUDD sprays */ }
    /** unknown_inline_10: the dive from a run */
    private diveFromRun() {
        if ((this.mInput & 0x8000) && this.mForwardVel > this.mRunParams.mDoJumpCatchSp && this.mIntendedMag > 0.75) {
            this.mVel.y = 20;
            return this.changePlayerStatus(S.JUMP_CATCH, 1, false);
        }
        return 0;
    }
    isThrowStart() {
        if (this.mHeldObject && (this.mInput & 0x2000)) {
            if (this.mHeldObject.isHitCategory(0x10000000)) return this.changePlayerStatus(S.PITCHING, 0, false);
            if (this.mForwardVel > 16) return this.changePlayerStatus(S.PITCHING, 0, false);
            if (this.canPut()) return this.changePlayerStatus(S.PUTTING, 0, false);
        }
        return 0;
    }
    isRunningSlipStart() { return (this.mInput & 8) !== 0 && (this.mForwardVel <= 0.1 || this.isFrontSlip(0)); }
    isRunningTurnning() {
        if (this.isUpperPumpingStyle()) return false;
        if (this.onYoshi()) return false;
        const d = s16(this.mIntendedYaw - this.mFaceAngle.y);
        return !(-0x471C <= d && d <= 0x471C);
    }
    isRunningInWater() { return this.checkFlag(MF.IN_ANY_WATER) && this.mFloorPosition.z < this.pos.y + this.mRunParams.mSwimDepth; }
    getRunningInWaterBrake() { return fnmsub(fdiv(fsub(this.mFloorPosition.z, this.pos.y), this.mRunParams.mSwimDepth), fsub(1, this.mRunParams.mInWaterBrake), 1); }
    doRunningAnimation() {
        const R = this.mRunParams;
        let sp = this.mIntendedMag > this.mForwardVel ? this.mIntendedMag : this.mForwardVel;
        if (sp < 4) sp = 4;
        for (let loop = true; loop;) {
            switch (this.mAnimationId) {
                default: case A.RUN2:
                    if (this.mForwardVel >= this.mDeParams.mDashMax - 1) { this.setAnimation(A.TURBO_DASH, 1); loop = false; }
                    else if (sp < R.mWalk2Soft) { this.setAnimation(A.SSTEP, 1); loop = false; }
                    else {
                        let rate = fr(sp * R.mRunAnmSpeedMult + R.mRunAnmSpeedBase);
                        if (this.isRunningInWater()) rate = fr(rate * (this.getRunningInWaterBrake() * R.mInWaterAnmBrake));
                        this.setAnimation(A.RUN2, rate);
                        const lo = R.mMotBlendWalkSp, hi = R.mMotBlendRunSp;
                        let mix = 0;
                        if (rate < lo) mix = 0;
                        if (hi < rate) mix = 1;
                        if (lo <= rate && rate <= hi) mix = fr((rate - lo) / (hi - lo));
                        this.unk414.z = fr(1 - mix);
                        this.mModel.blendRatio = this.onYoshi() ? 0 : this.unk414.z;
                        loop = false;
                    }
                    break;
                case A.SSTEP:
                    if (sp > R.mSoft2Walk) { this.setAnimation(A.RUN2, 1); loop = false; }
                    else { let r2 = sp; if (r2 < 0.1) r2 = 0.1; this.setAnimation(A.SSTEP, fr(r2 * R.mSoftStepAnmMult)); loop = false; }
                    break;
                case A.TURBO_DASH:
                    if (this.mForwardVel < this.mDeParams.mDashMax - 1) { this.setAnimation(A.RUN2, 1); loop = false; }
                    else { this.setAnimation(A.TURBO_DASH, fr(sp * R.mRunAnmSpeedMult + R.mRunAnmSpeedBase)); loop = false; }
                    break;
            }
        }
        return 1;
    }
    private slipParamsFor(): any {
        const g = this.mGroundPlane;
        if (this.isForceSlip()) return this.mSlipParamsAll;
        if (bg.isSlider(g)) return this.mSlipParamsAllSlider;
        if (bg.isUnk2(g)) return this.mSlipParams45;
        if (bg.isWetGround(g)) return g.n[1] > 0.99 ? this.mSlipParamsWaterGround : this.mSlipParamsWaterSlope;
        return this.mSlipParamsNormal;
    }
    getSlopeNormalAccele(): [number, number] { const p = this.slipParamsFor(); return [p.mSlopeAcceleUp, p.mSlopeAcceleDown]; }
    getSlopeSlideAccele(): [number, number] { const p = this.slipParamsFor(); return [p.mSlideAcceleUp, p.mSlideAcceleDown]; }
    getChangeAngleSpeed() { return fr(0.03125 * (this.slipParamsFor().mSlideAngleYSp * this.mForwardVel)); }
    getSlideStickMult() {
        const g = this.mGroundPlane;
        if (this.isForceSlip()) return this.mSlipParamsAll.mStickSlideMult;
        if (bg.isSlider(g)) return this.mSlipParamsAllSlider.mStickSlideMult;
        if (bg.isUnk2(g)) return this.mSlipParams45.mStickSlideMult;
        return this.mSlipParamsNormal.mStickSlideMult;
    }
    /** slideProcess (its float operations as the DOL has them) */
    slideProcess(acc: number, friction: number) {
        const g = this.mGroundPlane;
        const dirAng = matan(g.n[2], g.n[0]);
        const mag = MsSqrtf(fadd(fmul(g.n[0], g.n[0]), fmul(g.n[2], g.n[2])));
        const d = s16(this.mSlopeAngle - this.mFaceAngle.y);
        const [up, down] = this.getSlopeSlideAccele();
        acc = fmadd(d > -0x4000 && d < 0x4000 ? up : down, mag, acc);
        this.mSlideVelX = fmadd(acc, JMASSin(dirAng), this.mSlideVelX);
        this.mSlideVelZ = fmadd(acc, JMASCos(dirAng), this.mSlideVelZ);
        this.mSlideVelX = fmul(this.mSlideVelX, friction);
        this.mSlideVelZ = fmul(this.mSlideVelZ, friction);
        this.unk9E = matan(this.mSlideVelZ, this.mSlideVelX);
        let turn = 0;
        if (!(fr(-0.1) < this.mSlideVelX && this.mSlideVelX < fr(0.1) && fr(-0.1) < this.mSlideVelZ && this.mSlideVelZ < fr(0.1))) {
            turn = s16(this.mFaceAngle.y - this.unk9E);
            if (turn > 0 && turn <= 0x4000) { turn = Math.trunc(fsub(turn, this.getChangeAngleSpeed())); if (turn < 0) turn = 0; }
            else if (turn > -0x4000 && turn < 0) { turn = Math.trunc(fadd(turn, this.getChangeAngleSpeed())); if (turn > 0) turn = 0; }
            else if (turn > 0x4000 && turn < 0x8000) { turn = Math.trunc(fadd(turn, this.getChangeAngleSpeed())); if (turn > 0x8000) turn = 0x8000; }
            else if (turn > -0x8000 && turn < -0x4000) { turn = Math.trunc(fsub(turn, this.getChangeAngleSpeed())); if (turn < -0x8000) turn = -0x8000; }
            this.mFaceAngle.y = s16(this.unk9E + turn);
        }
        this.mVel.x = this.mSlideVelX; this.mVel.y = 0; this.mVel.z = this.mSlideVelZ;
        this.mForwardVel = MsSqrtf(fadd(fmul(this.mSlideVelX, this.mSlideVelX), fmul(this.mSlideVelZ, this.mSlideVelZ)));
        if (this.mForwardVel > 100) {
            this.mSlideVelX = fdiv(fmul(100, this.mSlideVelX), this.mForwardVel);
            this.mSlideVelZ = fdiv(fmul(100, this.mSlideVelZ), this.mForwardVel);
        }
        if (turn < -0x4000 || turn > 0x4000) this.mForwardVel = fmul(this.mForwardVel, -1);
    }
    /** doSliding (the DOL's float operations; its in-water friction test reads mStatusState's bits 0x30000, never set) */
    doSliding(stop: number) {
        let stopped = false;
        let cs = JMASCos(s16(this.mIntendedYaw - this.unk9E));
        const sn = JMASSin(s16(this.mIntendedYaw - this.unk9E));
        if (cs < 0 && this.mForwardVel >= 0) cs = fmul(cs, fmadd(fr(0.01), fmul(0.5, this.mForwardVel), 0.5));
        let fric: number;
        const g = this.mGroundPlane;
        if (this.mStatus === S.OIL_SLIP) fric = this.mSlipParamsOil.mSlipFriction;
        else if (this.isForceSlip()) fric = this.mSlipParamsAll.mSlipFriction;
        else if (bg.isSlider(g)) fric = this.mSlipParamsAllSlider.mSlipFriction;
        else if (bg.isUnk2(g)) fric = this.mSlipParams45.mSlipFriction;
        else if (bg.isWetGround(g)) fric = g.n[1] > fr(0.99) ? this.mSlipParamsWaterGround.mSlipFriction : this.mSlipParamsWaterSlope.mSlipFriction;
        else if (this.onYoshi()) fric = this.mSlipParamsYoshi.mSlipFriction;
        else {
            fric = this.mSlipParamsNormal.mSlipFriction;
            if (this.mStatus === S.CATCH && this.mStatusState === 1) fric = this.mDeParams.mWasOnWaterSlip;
        }
        const old = MsSqrtf(fadd(fmul(this.mSlideVelX, this.mSlideVelX), fmul(this.mSlideVelZ, this.mSlideVelZ)));
        const mult = fmadd(fr(0.02), fmul(fmul(this.mIntendedMag, 0.03125), cs), fric);
        const sm = this.getSlideStickMult();
        this.mSlideVelX = fmadd(fmul(sn, fmul(this.mSlideVelZ, fmul(this.mIntendedMag, 0.03125))), sm, this.mSlideVelX);
        this.mSlideVelZ = fnmsub(fmul(sn, fmul(this.mSlideVelX, fmul(this.mIntendedMag, 0.03125))), sm, this.mSlideVelZ);
        const nm = MsSqrtf(fadd(fmul(this.mSlideVelX, this.mSlideVelX), fmul(this.mSlideVelZ, this.mSlideVelZ)));
        if (old > 0 && nm > 0) { this.mSlideVelX = fdiv(fmul(this.mSlideVelX, old), nm); this.mSlideVelZ = fdiv(fmul(this.mSlideVelZ, old), nm); }
        this.slideProcess(0, mult);
        if (!bg.isUnk1(g) && !bg.isSlider(g) && fmul(this.mForwardVel, this.mForwardVel) < fmul(stop, stop)) { this.setPlayerVelocity(0); stopped = true; this.mInput &= ~8; }
        return stopped;
    }
    slopeProcess() {
        const g = this.mGroundPlane;
        const mag = sqrtf(fmadd(g.n[2], g.n[2], fmul(g.n[0], g.n[0])));
        const d = s16(this.mSlopeAngle - this.mFaceAngle.y);
        const [up, down] = this.getSlopeNormalAccele();
        if (d > -0x4000 && d < 0x4000) this.mForwardVel = fr(this.mForwardVel + up * mag);
        else this.mForwardVel = fr(-(down * mag - this.mForwardVel));
        if (this.mForwardVel > this.mDeParams.mRunningMax) this.mForwardVel = this.mDeParams.mRunningMax;
        this.unk9E = this.mFaceAngle.y;
        this.mSlideVelX = fr(this.mForwardVel * JMASSin(this.mFaceAngle.y)); this.mSlideVelZ = fr(this.mForwardVel * JMASCos(this.mFaceAngle.y));
        this.mVel.x = this.mSlideVelX; this.mVel.y = 0; this.mVel.z = this.mSlideVelZ;
    }
    doStopping() {
        const v = FConverge(this.mForwardVel, 0, 1, 1);
        this.mForwardVel = fr(v);
        this.setPlayerVelocity(this.mForwardVel);
        return v === 0;
    }
    doRunning() {
        const R = this.mRunParams, D = this.mDeParams;
        let sp = this.mIntendedMag < R.mMaxSpeed ? this.mIntendedMag : R.mMaxSpeed;
        if (this.onYoshi()) sp = fmul(sp, this.mYoshiParams.mRunYoshiMult);
        if (this.mForwardVel <= 0) this.mForwardVel = fadd(this.mForwardVel, R.mVelMinusBrake);
        else if (this.mForwardVel <= sp) this.mForwardVel = fadd(this.mForwardVel, fnmsub(this.mForwardVel, R.mAddVelDiv, R.mAddBase));
        else if (this.mGroundPlane.n[1] >= R.mDecStartNrmY) { this.mForwardVel = fsub(this.mForwardVel, R.mDecBrake); this.mForwardVel = fsub(this.mForwardVel, this.mYoshiParams.mDecBrake); }
        if (this.mForwardVel < 0) this.mForwardVel = 0;
        let rot: number;
        if (this.isUpperPumpingStyle()) { const b = D.mPumpingRotSpMin; rot = s16(fmadd(0.03125, fmul(this.mForwardVel, D.mPumpingRotSpMax - b), b)); }
        else { const b = D.mRunningRotSpMin; rot = s16(fmadd(0.03125, fmul(this.mForwardVel, D.mRunningRotSpMax - b), b)); }
        if (this.onYoshi()) rot = s16(fmul(rot, this.mYoshiParams.mRotYoshiMult));
        if (this.checkFlag(MF.FLUDD_EMITTING)) rot = R.mDashRotSp;
        if (this.isRunningInWater()) this.mForwardVel = fmul(this.mForwardVel, this.getRunningInWaterBrake());
        this.mFaceAngle.y = s16(this.mIntendedYaw - iconv(s16(this.mIntendedYaw - this.mFaceAngle.y), 0, rot, rot));
        this.slopeProcess();
    }
    doPushingAnimation(v: { x: number; z: number }) {
        const dx = fr(this.pos.x - v.x), dz = fr(this.pos.z - v.z);
        if (this.mForwardVel > 6) this.setPlayerVelocity(6);
        let wa = 0, d = 0;
        if (this.mWallPlane) { wa = this.getWallAngle(); d = s16(wa - this.mFaceAngle.y); }
        if (!this.mWallPlane || d < -0x71C7 || d > 0x71C7) { this.setAnimation(A.PUSH, 1); this.startVoice(SE.MV16_EXERT_CONT_01); return; }
        const rate = fr(2 * MsSqrtf(dx * dx + dz * dz));
        this.setAnimation(d < 0 ? A.SWLKR : A.SWLKL, rate);
        this.mFaceAngle.x = 0;
        this.mModelFaceAngle = s16(wa + 0x8000);
    }
    running() {
        this.mStatusTimer++;
        if (this.isThrowStart()) return 1;
        if (this.isRunningSlipStart()) return this.changePlayerStatus(S.SLIP, 0, false);
        const stopping = () => {
            if (this.mStatusState === 1) { this.mFaceAngle.y = s16(this.mStatusArg); return this.changePlayerStatus(0xC400209, 0, false); }
            if (this.mStatusTimer > 0xF0 && this.mForwardVel >= 16 && this.mGroundPlane.n[1] >= 0.17364818) return this.changePlayerStatus(S.BRAKE, 0, false);
            return this.changePlayerStatus(S.WALK_END, 0, false);
        };
        if (this.mInput & 0x10) return stopping();
        if (this.checkFlag(MF.FLUDD_EMITTING) && (this.mInput & 2) && this.mForwardVel > this.mDeParams.mDashMax - 1) return this.changePlayerJumping(S.BROAD_JUMP, 0);
        if (this.mInput & 2) return this.changePlayerTriJump();
        if (!this.onYoshi() && (this.mInput & 0x8000)) { if (this.diveFromRun()) return 1; this.changePlayerStatus(S.TAKE_POSE, 0, false); }
        if (this.mInput & 0x20) return stopping();
        if (this.isRunningTurnning() && this.mForwardVel >= this.mRunParams.mTurnNeedSp) return this.changePlayerStatus(S.TURN, 0, false);
        if (this.canSquat()) { this.setPlayerVelocity(0); return this.changePlayerStatus(S.SQUAT, 0, false); }
        if (this.rocketCheck()) { this.unk314 = fr(this.mFloorPosition.y + this.hoverHeight()); return this.changePlayerStatus(S.ROCKET, 0, false); }
        let pushed = false;
        this.mStatusState = 0;
        const prev = this.pos.clone();
        this.doRunning();
        this.setNormalAttackArea();
        switch (this.walkProcess()) {
            case 0: this.changePlayerStatus(S.LANDING, 0, false); this.setAnimation(A.LAND, 1); break;
            case 1: this.doRunningAnimation(); break;
            case 2:
                if (this.onYoshi()) { this.setPlayerVelocity(0); break; }
                if (this.mFlag & MF.VISIBLE) pushed = true;
                if (!pushed) {
                    if (this.mForwardVel > this.mDeParams.mClashSpeed) return this.changePlayerDropping(S.JUMP_SHORT_BACK_DOWN, 0);
                    if ((this.mInput & 2) && this.isTouchedOneWall(this.pos.x, fr(this.pos.y + this.mDeParams.mJumpWallHeight), this.pos.z, 50)) {
                        this.mVel.y = 52;
                        this.mFaceAngle.y = s16(this.mFaceAngle.y + 0x8000);
                        this.setPlayerVelocity(50);
                        return this.changePlayerStatus(S.WALL_JUMP, 0, false);
                    }
                    if (this.mWallPlane && bg.isFence(this.mWallPlane)) {
                        this.mFaceAngle.y = s16(matan(this.mWallPlane.n[2], this.mWallPlane.n[0]) + 0x8000);
                        this.mModelFaceAngle = this.mFaceAngle.y;
                        return this.changePlayerStatus(S.FENCE_CATCH, 0, false);
                    }
                    this.doPushingAnimation(prev);
                    this.mDashTimer = 0;
                    this.offFlag(MF.FLUDD_EMITTING);
                }
                break;
        }
        this.checkDescent();
        if (this.checkFlag(MF.FLUDD_EMITTING)) this.setPlayerVelocity(this.mDeParams.mDashMax);
        return 0;
    }
    rotating() {
        if (this.mInput & 2) return this.changePlayerStatus(this.mStatus === S.ROTATE_L ? S.RIGHT_ROTATE_JUMP : S.LEFT_ROTATE_JUMP, 0, false);
        this.setAnimation(A.SPIN_P, 1);
        this.mStatusTimer++;
        if (this.mStatusTimer > 0x78) return this.changePlayerStatus(S.WAIT, 0, false);
        this.doRunning();
        if (this.walkProcess() === 0) this.changePlayerStatus(S.LANDING, 0, false);
        this.mModelFaceAngle = s16(this.mStatus === S.ROTATE_L ? this.mStatusTimer * 4096 : this.mStatusTimer * -4096);
        return 0;
    }
    turnning() {
        if (this.isThrowStart()) return 1;
        if (this.mInput & 8) return this.changePlayerStatus(S.SLIP, 0, false);
        if (this.mInput & 2) return this.changePlayerJumping(S.U_TURN_JUMP, 0);
        if (this.considerRotateStart()) return 1;
        if (this.mInput & 0x20) return this.changePlayerStatus(S.BRAKE, 0, false);
        if (!this.isRunningTurnning()) return this.changePlayerStatus(S.RUN, 0, false);
        const v = FConverge(this.mForwardVel, 0, 4, 4);
        this.mForwardVel = fr(v);
        this.slopeProcess();
        if (v === 0) { this.mFaceAngle.y = this.mIntendedYaw; this.setPlayerVelocity(8); return this.changePlayerStatus(S.TURN_END, 0, false); }
        if (this.walkProcess() === 0) this.changePlayerStatus(S.LANDING, 0, false);
        if (this.mForwardVel >= 18) this.setAnimation(A.TURN, 1);
        else {
            this.setAnimation(A.TRNED, 1);
            if (this.isLast1AnimeFrame()) {
                const vel = this.mForwardVel;
                this.mFaceAngle.y = this.mIntendedYaw;
                this.setPlayerVelocity(vel > 0 ? -vel : 8);
                this.changePlayerStatus(S.RUN, 0, false);
            }
        }
        return 0;
    }
    turnEnd() {
        if (this.isThrowStart()) return 1;
        if (this.mInput & 8) return this.changePlayerStatus(S.SLIP, 0, false);
        if (this.mInput & 2) return this.changePlayerJumping(S.U_TURN_JUMP, 0);
        if (this.considerRotateStart()) return 1;
        this.doRunning();
        this.setAnimation(A.TRNED, 1);
        if (!this.walkProcess()) this.changePlayerStatus(S.LANDING, 0, false);
        if (this.isLast1AnimeFrame()) this.changePlayerStatus(S.RUN, 0, false);
        this.mFaceAngle.x = 0;
        this.mModelFaceAngle = s16(this.mModelFaceAngle + 0x8000);
        return 0;
    }
    braking() {
        if (!(this.mInput & 0x10) && (this.mInput & 0xF)) return this.checkAllMotions();
        const v = FConverge(this.mForwardVel, 0, 4, 4);
        this.mForwardVel = fr(v);
        this.slopeProcess();
        if (v === 0) return this.changePlayerStatus(S.BRAKE_END, 0, false);
        switch (this.walkProcess()) {
            case 0: this.changePlayerStatus(S.LANDING, 0, false); break;
            case 2:
                if (this.mForwardVel > 16) { this.playerRefrection(1); this.changePlayerDropping(S.SHORT_BACK_DOWN, 0); }
                else { this.setPlayerVelocity(0); this.changePlayerStatus(S.BRAKE_END, 0, false); }
                break;
        }
        this.setAnimation(A.BRAKE, 1);
        return 0;
    }
    walkEnd() {
        if (!(this.mInput & 0x10)) {
            if (this.isRunningSlipStart()) return this.changePlayerStatus(S.SLIP, 0, false);
            if (this.mInput & 2) return this.changePlayerTriJump();
            if (this.mInput & 1) return this.changePlayerStatus(S.RUN, 0, false);
            if (this.mInput & 0x8000) return this.changePlayerStatus(S.TAKE_POSE, 0, false);
        }
        if (this.considerRotateStart()) return 1;
        if (this.doStopping()) return this.changePlayerStatus(S.WAIT, 0, false);
        switch (this.walkProcess()) {
            case 0: this.changePlayerStatus(S.LANDING, 0, false); break;
            case 2: this.setPlayerVelocity(0); break;
        }
        let rate = fr(this.mForwardVel / 4);
        if (rate < 0.1) rate = 0.1;
        this.setAnimation(A.RUN1, rate);
        return 0;
    }
    speedSliding() {
        const saved = this.mFaceAngle.y;
        if (this.doSliding(this.getSlideStopNormal())) return this.changePlayerStatus(S.SLIP_END, 0, false);
        this.slippingBasic(S.SLIP_END, S.SLIP_FALL, 0xF);
        this.mFaceAngle.y = saved;
        return 0;
    }
    fireDashing() {
        if (this.mInput & 2) return this.changePlayerStatus(S.FIRE_JUMP, 0, false);
        if (this.mStatusTimer++ > 0xA0) return this.changePlayerStatus(S.RUN, 0, false);
        if (this.checkFlag(MF.IN_ANY_WATER)) return this.changePlayerStatus(S.RUN, 0, false);
        if (this.mForwardVel < 8) this.mForwardVel = 8;
        if (this.mForwardVel > 48) this.mForwardVel = 48;
        this.mForwardVel = fr(FConverge(this.mForwardVel, 32, 4, 1));
        if (this.mInput & 1) this.mFaceAngle.y = s16(this.mIntendedYaw - iconv(s16(this.mIntendedYaw - this.mFaceAngle.y), 0, 0x600, 0x600));
        this.slopeProcess();
        if (!this.walkProcess()) this.changePlayerStatus(S.FIRE_LAND, 0, false);
        this.setAnimation(A.FIREJMP, fr(0.1 * (0.5 * this.mForwardVel)));
        return 0;
    }
    slippingBasic(onStop: number, onFall: number, anim: number) {
        this.isForceSlip();
        if ((this.mInput & 2) && this.canSlipJump() === 1) { this.changePlayerStatus(S.JUMP, 0, false); return; }
        if (this.mInput & 0x8000) { this.mVel.y = 20; this.changePlayerStatus(S.JUMP_CATCH, 1, false); return; }
        switch (this.walkProcess()) {
            case 0: this.changePlayerStatus(onFall, 0, false); return;
            case 1: this.setAnimation(anim, 1); this.onUnk114(8); this.frontSlipEffect(); return;
            case 2:
                if (this.onYoshi()) { this.setPlayerVelocity(0); return; }
                if (this.isSlipStart()) {
                    if (this.mWallPlane) {
                        const wa = matan(this.mWallPlane.n[2], this.mWallPlane.n[0]);
                        let m = MsSqrtf(this.mSlideVelX * this.mSlideVelX + this.mSlideVelZ * this.mSlideVelZ);
                        m = fr(m * 0.9);
                        if (m < 4) m = 4;
                        this.unk9E = s16(wa - s16(this.unk9E - wa) + 0x8000);
                        this.mVel.x = this.mSlideVelX = fr(m * JMASSin(this.unk9E));
                        this.mVel.z = this.mSlideVelZ = fr(m * JMASCos(this.unk9E));
                    }
                } else if (this.mForwardVel > 16) { this.playerRefrection(1); this.changePlayerDropping(S.CATCH_DOWN, 0); }
                else { this.setPlayerVelocity(0); this.changePlayerStatus(onStop, 0, false); }
                this.onUnk114(8);
                return;
        }
    }
    /** MarioParticle.cpp frontSlipEffect: only which emitters it picks (the viewer draws them) */
    frontSlipEffect() {
        if (bg.isWetGround(this.mGroundPlane) || (this.mStatus === S.CATCH && this.mStatusState === 1)) { this.slipFx = 1; return; }
        if (!(this.pos.y < this.mFloorPosition.z)) this.slipFx = this.checkFlag(MF.ON_SAND) ? 3 : 2;
    }
    slipForeCommon(a0: number, a1: number, a2: number, a3: number) {
        if (this.mStatusTimer > 20 && this.canSlipJump()) { if (this.mInput & 2) return this.changePlayerJumping(a1, 0); }
        else this.mStatusTimer++;
        if (this.doSliding(this.getSlideStopNormal())) return this.changePlayerStatus(a0, 0, false);
        this.slippingBasic(a0, a2, a3);
        return 0;
    }
    slipFore() { return this.slipForeCommon(S.SLIP_END, S.JUMP, S.SLIP_FALL, 0x91); }
    slipBackCommon(a0: number, a1: number, a2: number) {
        if (this.mStatusTimer > 20) { if (!(this.mInput & 8) && (this.mInput & 2) && this.canSlipJump()) return this.changePlayerDropping(S.CATCH_STOP, 0); }
        else this.mStatusTimer++;
        if (this.doSliding(this.getSlideStopNormal())) return this.changePlayerStatus(a0, 0, false);
        this.slippingBasic(a0, a1, a2);
        return 0;
    }
    slipBack() { return this.slipBackCommon(S.CATCH_LOST, S.LANDING, 0x89); }
    catching() {
        if (!(this.mInput & 8) && (this.mInput & 2)) {
            if (this.mForwardVel > this.mJumpParams.mRotBroadEnableV) return this.changePlayerStatus(S.ROTATE_BROAD_JUMP, 0, false);
            return this.changePlayerStatus(S.CATCH_STOP, 0, false);
        }
        if (this.checkFlag(MF.RECENTLY_LEFT_WATER)) this.mStatusState = 1;
        if (this.doSliding(this.getSlideStopCatch())) { this.setPlayerVelocity(0); return this.changePlayerStatus(S.CATCH_LOST, 0, false); }
        this.slippingBasic(S.CATCH_LOST, S.LANDING, 0x88);
        if (this.getMotionFrameCtrl().frame > 50) this.getMotionFrameCtrl().frame = 50;
        return 0;
    }
    squatSlipping() {
        this.setNormalAttackArea();
        if (this.mInput & 8) return this.changePlayerStatus(S.SLIP_FORE, 0, false);
        if (this.mInput & 2) return this.changePlayerJumping(S.JUMP, 0);
        if (this.mInput & 0x10) return this.changePlayerStatus(S.BRAKE, 0, false);
        return this.slipForeCommon(S.SQUAT, S.JUMP, S.LANDING, 0x97);
    }
    oilRun() {
        const D = this.mDirtyParams;
        if (this.mInput & 2) { this.setPlayerVelocity(0); return this.changePlayerJumping(S.JUMP, 0); }
        if (this.mInput & 0x8000) { this.mVel.y = 20; return this.changePlayerStatus(S.JUMP_CATCH, 1, false); }
        if (-1 < this.mVel.x && this.mVel.x < 1 && -1 < this.mVel.z && this.mVel.z < 1) { this.setPlayerVelocity(0); return this.changePlayerStatus(S.WAIT, 0, false); }
        if (this.world.pollution) this.world.pollution.stamp(1, this.pos.x, this.pos.y, this.pos.z, D.mPolSizeRun);
        { const r = s16(D.mSlipRotate); this.mFaceAngle.y = s16(this.mIntendedYaw - iconv(s16(this.mIntendedYaw - this.mFaceAngle.y), 0, r, r)); }
        this.mVel.x = fr(this.mVel.x + this.mIntendedMag * JMASSin(this.mFaceAngle.y) * D.mSlipRunSp);
        this.mVel.z = fr(this.mVel.z + this.mIntendedMag * JMASCos(this.mFaceAngle.y) * D.mSlipRunSp);
        this.mDirtyTimer--;
        if (this.mDirtyTimer <= 0) { this.mDirtyTimer = 0; this.mOilBrake = 0; }
        this.mVel.x = fr(this.mVel.x * this.mOilBrake); this.mVel.z = fr(this.mVel.z * this.mOilBrake);
        this.mForwardVel = 0; this.mSlideVelX = 0; this.mSlideVelZ = 0;
        if (this.mIntendedMag === 0) this.setAnimation(this.mInput & 0x4000 ? A.SQWAT : A.WAIT, 0.5);
        else { this.setAnimation(A.RUN2, fr(0.5 * this.mIntendedMag * D.mSlipAnmSpeed)); this.startVoiceIfNoVoice(SE.MV28_SPRISE_SMALL_01); }
        if (this.walkProcess() === 0) return this.changePlayerStatus(S.LANDING, 0, false);
        return 0;
    }
    oilSlip() {
        const D = this.mDirtyParams;
        if (this.mInput & 2) { this.setPlayerVelocity(0); return this.changePlayerJumping(S.JUMP, 0); }
        { const r = s16(D.mSlipCatchRotate); this.mFaceAngle.y = s16(this.mIntendedYaw - iconv(s16(this.mIntendedYaw - this.mFaceAngle.y), 0, r, r)); }
        this.mDirtyTimer--;
        if (this.mDirtyTimer <= 0) { this.mDirtyTimer = 0; this.mOilBrake = 0; this.changePlayerStatus(S.CATCH, 0, false); }
        if (this.world.pollution) this.world.pollution.stamp(1, this.pos.x, this.pos.y, this.pos.z, D.mPolSizeSlip);
        this.mForwardVel = fr(this.mForwardVel + this.mIntendedMag * JMASCos(s16(this.mFaceAngle.y - this.mIntendedYaw)) * D.mSlipCatchSp);
        this.mForwardVel = fr(this.mForwardVel * this.mOilBrake);
        this.setPlayerVelocity(this.mForwardVel);
        if (-1 < this.mForwardVel && this.mForwardVel < 1) { this.setPlayerVelocity(0); return this.changePlayerStatus(S.CATCH_LOST, 0, false); }
        if (this.walkProcess() === 0) return this.changePlayerStatus(S.LANDING, 0, false);
        if (this.getMotionFrameCtrl().frame > 50) this.getMotionFrameCtrl().frame = 50;
        return 0;
    }
    oilSlope() {
        this.mDirtyTimer--;
        if (this.mDirtyTimer <= 0) { this.mDirtyTimer = 0; this.mOilBrake = 0; this.changePlayerStatus(S.CATCH, 0, false); }
        if (this.world.pollution) this.world.pollution.stamp(1, this.pos.x, this.pos.y, this.pos.z, this.mDirtyParams.mPolSizeSlip);
        return this.slipBackCommon(S.CATCH_LOST, S.LANDING, 0x89);
    }
    downingCommon(anim: number, limit: number, arg: number) {
        const f = this.setAnimation(anim, 1);
        if (f < limit) {
            this.slopeProcess();
            this.mForwardVel = fr(this.mForwardVel * 0.96);
            if (this.mForwardVel * this.mForwardVel < 1) this.setPlayerVelocity(0);
        } else this.setPlayerVelocity(this.mForwardVel >= 0 ? 0.1 : -0.1);
        if (!this.walkProcess()) this.changePlayerStatus(this.mForwardVel >= 0 ? S.JUMP_SHORT_FORE_DOWN : S.JUMP_SHORT_BACK_DOWN, arg, false);
        else if (this.isLast1AnimeFrame()) this.changePlayerStatus(S.WAIT, 0, false);
        return f;
    }
    private downOnce() { if (this.mStatusTimer === 0) this.mStatusTimer++; }
    backDown() { this.downOnce(); this.downingCommon(1, 86, this.mStatusArg); return 0; }
    foreDown() { this.downOnce(); this.downingCommon(A.SDWNF, 42, this.mStatusArg); return 0; }
    shortBackDown() { this.downOnce(); this.downingCommon(A.SDOWN, 88, this.mStatusArg); return 0; }
    shortForeDown() { this.downOnce(); this.downingCommon(A.SHFDN, 80, this.mStatusArg); return 0; }
    safeBackDown() { this.downOnce(); this.downingCommon(A.SFBDN, 200, this.mStatusArg); return 0; }
    safeForeDown() { this.downOnce(); this.downingCommon(A.SFFDN, 100, this.mStatusArg); return 0; }
    catchDown() { this.downOnce(); this.downingCommon(A.SLDWN, 128, this.mStatusArg); return 0; }
    loserDown() {
        this.slopeProcess();
        this.mForwardVel = fr(this.mForwardVel * 0.9);
        if (this.mForwardVel * this.mForwardVel < 1) this.setPlayerVelocity(0);
        this.setAnimation(A.DIE, 1);
        switch (this.mStatusState) {
            case 0: this.startVoice(SE.MV08A_DOWN_01); this.mStatusState++; break;
            case 1: if (!this.marioVoicePlaying()) { this.mStatusTimer = 0; this.mStatusState++; } break;
            case 2: if (this.mStatusTimer++ > 60) this.mStatusState++; break;
            case 3: this.startVoice(SE.MV08B_DOWN_REACT_01); this.mStatusState++; break;
        }
        return 0;
    }
    jumpSlipCommon(anim: number, status: number) {
        if (this.mInput & 1) { this.slopeProcess(); this.mForwardVel = fr(this.mForwardVel * 0.98); if (this.mForwardVel * this.mForwardVel < 1) this.setPlayerVelocity(0); }
        else if (this.mForwardVel >= 16) { this.mForwardVel = fr(FConverge(this.mForwardVel, 0, 4, 4)); this.slopeProcess(); }
        else this.mVel.y = 0;
        const wp = this.walkProcess();
        switch (wp) {
            case 0: this.changePlayerStatus(status, 0, false); break;
            case 2: this.setAnimation(A.PUSH, 1); break;
        }
        this.setAnimation(anim, 1);
        return wp;
    }
    jumpSlipEvents(r: JumpSlipRecord) {
        if (this.mInput & 0x10) return this.changePlayerStatus(r.end, 0, false);
        this.mStatusTimer++;
        if (this.mStatusTimer >= r.max) return this.changePlayerStatus(r.end, 0, false);
        if (this.mInput & 2) {
            if (r.jump === S.SECOND_JUMP && this.mForwardVel >= this.mJumpParams.mSecJumpEnableSp) return this.changePlayerJumping(S.SECOND_JUMP, 0);
            if (r.jump === S.ULTRA_JUMP && this.mForwardVel >= this.mJumpParams.mTriJumpEnableSp) return this.changePlayerJumping(S.ULTRA_JUMP, 0);
            return this.changePlayerJumping(S.JUMP, 0);
        }
        if (this.mInput & 0x8000) { this.mVel.y = 20; return this.changePlayerStatus(S.JUMP_CATCH, 1, false); }
        if (this.mInput & 4) return this.changePlayerStatus(r.c, 0, false);
        return 0;
    }
    jumpSlip() { if (this.jumpSlipEvents({ max: 0x10, end: S.JUMP_END, jump: S.SECOND_JUMP, c: S.LANDING, d: S.SLIP })) return 1; this.jumpSlipCommon(A.JMPED, S.LANDING); return 0; }
    landSlip() { if (this.jumpSlipEvents({ max: 0x10, end: S.LAND_END, jump: S.SECOND_JUMP, c: S.LANDING, d: S.SLIP })) return 1; this.jumpSlipCommon(A.LAEND, S.LANDING); return 0; }
    secJumpSlip() { if (this.jumpSlipEvents({ max: 0x10, end: S.SEC_JUMP_END, jump: S.ULTRA_JUMP, c: S.LANDING, d: S.SLIP })) return 1; this.jumpSlipCommon(A['2JMED'], S.LANDING); return 0; }
    uTurnJumpSlip() {
        if (this.jumpSlipEvents({ max: 0x10, end: S.U_TURN_JUMP_END, jump: S.JUMP, c: S.LANDING, d: S.SLIP })) return 1;
        if (this.jumpSlipCommon(A.TJMP2, S.LANDING) !== 2) { this.mFaceAngle.x = 0; this.mModelFaceAngle = s16(this.mModelFaceAngle + 0x8000); }
        return 0;
    }
    ultraJumpSlip() { if (this.jumpSlipEvents({ max: 0x04, end: S.ULTRA_JUMP_END, jump: S.JUMP, c: S.LANDING, d: S.SLIP })) return 1; this.jumpSlipCommon(0xC0, S.LANDING); return 0; }
    broadJumpSlip() {
        if (!(this.mInput & 0x4000)) this.mInput &= ~2;
        if (this.jumpSlipEvents({ max: 0x18, end: S.BROAD_JUMP_END, jump: S.BROAD_JUMP, c: S.LANDING, d: S.SLIP })) return 1;
        this.jumpSlipCommon(A.SQWAT, S.LANDING);
        return 0;
    }
    /** unk389: the surfing Blooper's colour (0 red, 1 yellow, 2 green) */
    mSurfGessoType = 0;
    /** getSurfingParamsWater / getSurfingParamsGround (0x80139xxx): the params by the Blooper's colour */
    getSurfingParamsWater() { return this.mSurfGessoType === 1 ? this.mSurfingParamsWaterYellow : this.mSurfGessoType === 2 ? this.mSurfingParamsWaterGreen : this.mSurfingParamsWaterRed; }
    getSurfingParamsGround() { return this.mSurfGessoType === 1 ? this.mSurfingParamsGroundYellow : this.mSurfGessoType === 2 ? this.mSurfingParamsGroundGreen : this.mSurfingParamsGroundRed; }
    /**
     * doSurfing (0x8013a890): the speed toward 2x the stick (clamped to mPowMin..mPowMax), the turn
     * rate from mRotMin to mRotMax by that, then slopeProcess. Water or ground params by the plane
     * under where he was (y - vel.y); the acceleration's by the ground plane.
     */
    doSurfing() {
        const [, below] = this.checkGround(this.pos.x, fsub(this.pos.y, this.mVel.y), this.pos.z);
        const P = below.isWaterSurface() ? this.getSurfingParamsWater() : this.getSurfingParamsGround();
        const rotMin = P.mRotMin, rotMax = P.mRotMax, powMin = P.mPowMin, powMax = P.mPowMax;
        let want = fmul(2, this.mIntendedMag);
        if (want > powMax) want = powMax;
        if (want < powMin) want = powMin;
        const fv = this.mForwardVel;
        if (fv <= 0) this.mForwardVel = fadd(fv, fr(1.1));
        else if (fv <= want) {
            const accel = (this.mGroundPlane.isWaterSurface() ? this.getSurfingParamsWater() : this.getSurfingParamsGround()).mAccel;
            this.mForwardVel = fadd(fv, fsub(fr(1.1), fdiv(fv, accel)));
        } else if (this.mGroundPlane.n[1] >= fr(0.95)) this.mForwardVel = fsub(fv, 1);
        if (this.mForwardVel > powMax) this.mForwardVel = powMax;
        const rotSp = s16(Math.trunc(fmadd(fdiv(fsub(want, powMin), fsub(powMax, powMin)), fsub(rotMax, rotMin), rotMin)));
        this.mFaceAngle.y = s16(this.mIntendedYaw - IConverge(s16(this.mIntendedYaw - this.mFaceAngle.y), 0, rotSp, rotSp));
        this.slopeProcess();
        // (surfingEffect on the water)
    }
    /**
     * surfing (0x80139588): frozen for mStatusTimer at the start, A: the board jump (0x281089A), else
     * doSurfing and walkProcess (twice, as the DOL does): off an edge the board falls (0x81089B); a
     * wall head-on (beyond mClashAngle) faster than mClashSpeed knocks him off (all his HP, JUMP_BACK_DOWN).
     */
    surfing() {
        this.setAnimation(A.RIDE_SHELL, 1);
        if (this.mStatusTimer !== 0) { this.mStatusTimer = (this.mStatusTimer - 1) & 0xFFFF; return 0; }
        if (this.mInput & 2) { this.pos.y = fadd(this.pos.y, 1); return this.changePlayerStatus(0x281089A, 0, false); }
        this.doSurfing();
        this.walkProcess();
        switch (this.walkProcess()) {
            case 0: this.changePlayerStatus(0x81089B, 0, false); break;
            case 2: {
                if (!this.mWallPlane) { this.setPlayerVelocity(0); this.loserExec(); break; }
                const d = s16(matan(this.mWallPlane.n[2], this.mWallPlane.n[0]) - this.mFaceAngle.y);
                const P = this.mGroundPlane.isWaterSurface() ? this.getSurfingParamsWater() : this.getSurfingParamsGround();
                const max = P.mClashAngle;
                if ((d < -max || max < d) && this.mForwardVel > P.mClashSpeed) {
                    this.decHP(this.mDeParams.mHPMax);
                    const r = this.changePlayerStatus(S.JUMP_BACK_DOWN, 0, true);
                    this.mForwardVel = fmul(fr(0.8), -this.mForwardVel);
                    this.mVel.y = 50;
                    return r;
                }
                this.setPlayerVelocity(0);
                break;
            }
        }
        return 0;
    }
    /** toroccoing (inlined in moveMain): only the cart's sound and effects (calcBaseMtx moves him) */
    toroccoing() { return 0; }
    moveMain() {
        this.checkEnforceJump();
        this.checkReturn();
        switch (this.mStatus) {
            case S.RUN: return this.running();
            case S.ROTATE_L: case S.ROTATE_R: return this.rotating();
            case S.TURN: return this.turnning();
            case S.TURN_END: return this.turnEnd();
            case S.BRAKE: return this.braking();
            case S.SURF: return this.surfing();
            case S.WALK_END: return this.walkEnd();
            case S.SPEED_SLIDING: return this.speedSliding();
            case S.FIRE_DASH: return this.fireDashing();
            case S.SLIP_FORE: return this.slipFore();
            case S.SLIP_BACK: return this.slipBack();
            case S.CATCH: return this.catching();
            case S.SQUAT_SLIP: return this.squatSlipping();
            case S.OIL_RUN: return this.oilRun();
            case S.OIL_SLIP: return this.oilSlip();
            case S.OIL_SLOPE: return this.oilSlope();
            case S.BACK_DOWN: return this.backDown();
            case S.FORE_DOWN: return this.foreDown();
            case S.SHORT_BACK_DOWN: return this.shortBackDown();
            case S.SHORT_FORE_DOWN: return this.shortForeDown();
            case S.SAFE_BACK_DOWN: return this.safeBackDown();
            case S.SAFE_FORE_DOWN: return this.safeForeDown();
            case S.CATCH_DOWN: return this.catchDown();
            case S.LOSER_DOWN: return this.loserDown();
            case S.JUMP_SLIP: return this.jumpSlip();
            case S.LAND_SLIP: return this.landSlip();
            case S.SEC_JUMP_SLIP: return this.secJumpSlip();
            case S.U_TURN_JUMP_SLIP: return this.uTurnJumpSlip();
            case S.ULTRA_JUMP_SLIP: return this.ultraJumpSlip();
            case S.BROAD_JUMP_SLIP: return this.broadJumpSlip();
            case S.TOROCCO: return this.toroccoing();
        }
        return 0;
    }
}
