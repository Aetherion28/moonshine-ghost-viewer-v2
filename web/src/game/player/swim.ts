// Player/MarioSwim.cpp: swimming on and under the water, and swimMain. (And the few demo statuses
// from MarioAutodemo.cpp a simulated Mario uses: no motion, disappearing, sand.)

import { fr, s16, matan, IConverge, JMASSin, JMASCos } from '../math.js';
import { SE } from '../soundids.js';
import { MarioWait } from './wait.js';
import { S, MF, A, bg } from './base.js';

export abstract class MarioSwim extends MarioWait {
    unk366 = 0;
    doSwimming() {
        const W = this.mSwimParams;
        if (this.mInput & 0x8000) { this.changePlayerStatus(S.SWIM_DIVE, 0, false); return; }
        if (this.mFloorPosition.y + W.mEndDepth > this.mFloorPosition.z) { this.changePlayerStatus(S.WAIT, 0, false); return; }
        this.mForwardVel = fr(this.mForwardVel + this.mIntendedMag * W.mMoveSp * 0.03125);
        this.mForwardVel = fr(this.mForwardVel * W.mMoveBrake);
        const [mn, mx] = this.isUpperPumpingStyle() ? [W.mPumpingRotSpMin, W.mPumpingRotSpMax] : [W.mSwimmingRotSpMin, W.mSwimmingRotSpMax];
        const rot = s16(fr(this.mForwardVel * (mx - mn) * (1 / 32) + mn));
        this.mFaceAngle.y = s16(this.mIntendedYaw - IConverge(s16(this.mIntendedYaw - this.mFaceAngle.y), 0, rot, rot));
        this.setPlayerVelocity(this.mForwardVel);
        this.mVel.y = fr(this.mVel.y - W.mGravity);
        let k = fr((this.mFloorPosition.z - this.pos.y) / W.mFloatHeight);
        if (k < 0) k = 0;
        if (k > 1) k = 1;
        k = fr(k * (this.mAnimationId === A.SWIM_WAIT || this.mAnimationId === A.SWIM_START || this.mStatus === S.SWIM_WAIT ? W.mWaitBouyancy : W.mMoveBouyancy));
        this.mVel.y = fr(fr(this.mVel.y + k) * W.mUpDownBrake);
        switch (this.jumpProcess(1)) {
            case 2:
                if (this.checkFlag(MF.FLUDD_EMITTING)) {
                    if (this.isUnderWater()) { this.mForwardVel = fr(0.8 * -this.mForwardVel); this.changePlayerStatus(S.SWIM_P_DAMAGE, 0, true); }
                    else { this.changePlayerStatus(S.JUMP_BACK_DOWN, 0, true); this.mForwardVel = fr(0.8 * -this.mForwardVel); this.mVel.y = 50; }
                } else { this.setPlayerVelocity(0); this.mVel.y = 0; }
                break;
        }
        if (this.pos.y < this.mFloorPosition.y + 35) this.pos.y = fr(this.mFloorPosition.y + 35);
    }
    checkSwimJump() {
        if (this.mInput & 2) {
            if (this.checkFlag(MF.FLUDD_EMITTING) && !this.isUnderWater()) { this.pos.y = fr(1 + this.mFloorPosition.z); return this.changePlayerJumping(S.BROAD_JUMP, 0); }
            if (this.mFloorPosition.z - this.mSwimParams.mCanJumpDepth < this.pos.y) {
                let jump = false;
                if (this.mIntendedMag === 0) jump = true;
                if (this.mWallPlane) jump = true;
                const d = s16(this.mModelFaceAngle - this.mIntendedYaw);
                if (d < -0x5555 || d > 0x5555) jump = true;
                if (jump) { this.changePlayerStatus(S.JUMP, 0, false); return 1; }
            }
            return this.changePlayerStatus(this.mIntendedMag === 0 ? S.SWIM_UP : S.SWIM_PADDLE_START, 0, false);
        }
        return 0;
    }
    checkSwimToHangFence() {
        if (this.mIntendedMag > 0 && this.mWallPlane && bg.isFence(this.mWallPlane)) {
            const wa = matan(this.mWallPlane.n[2], this.mWallPlane.n[0]);
            const d = s16(this.mFaceAngle.y - wa);
            if (d < -0x5555 || d > 0x5555) {
                this.mFaceAngle.y = s16(wa + 0x8000); this.mModelFaceAngle = this.mFaceAngle.y;
                this.pos.y = fr(this.pos.y + 100);
                return this.changePlayerStatus(S.FENCE_CATCH, 0, false);
            }
        }
        return 0;
    }
    private swimmingStill() { return this.checkStatusType(0x2000); }
    swimStart() { this.doSwimming(); if (!this.swimmingStill()) return 1; this.setAnimation(A.PADDLE_SWIM_START, 1); if (this.isLast1AnimeFrame()) this.changePlayerStatus(S.SWIM_WAIT, 0, false); return 0; }
    swimWait() {
        this.setAnimation(A.PADDLE_SWIM_WAIT, 1);
        if (this.mInput & 1) return this.changePlayerStatus(S.SWIM_WAIT_TO_PADDLE, 0, false);
        this.doSwimming(); if (!this.swimmingStill()) return 1;
        this.setAnimation(A.PADDLE_SWIM_WAIT, 1);
        return 0;
    }
    swimWaitToPaddle() { this.setAnimation(A.WAIT_TO_PADDLE, 1); if (this.isLast1AnimeFrame()) this.changePlayerStatus(S.SWIM_PADDLE_START, 0, false); this.doSwimming(); return this.swimmingStill() ? 0 : 1; }
    swimPaddleStart() {
        this.setAnimation(A.PADDLE_START, 1);
        this.mForwardVel = fr(this.mForwardVel + this.mSwimParams.mPaddleSpeedUp);
        this.mVel.y = fr(this.mVel.y + this.mSwimParams.mPaddleJumpUp);
        if (this.isLast1AnimeFrame()) this.changePlayerStatus(S.SWIM_PADDLE, 0, false);
        this.doSwimming(); return this.swimmingStill() ? 0 : 1;
    }
    swimPaddle() {
        this.setAnimation(A.PADDLE_SWIM, this.checkFlag(MF.FLUDD_EMITTING) ? 5 : 0.5);
        if (this.checkFlag(MF.FLUDD_EMITTING)) this.setPlayerVelocity(this.mDeParams.mDashMax);
        if (this.mIntendedMag === 0) this.changePlayerStatus(S.SWIM_PADDLE_END, 0, false);
        this.doSwimming();
        if (!this.swimmingStill()) return 1;
        if (this.checkFlag(MF.FLUDD_EMITTING) && !this.isUnderWater()) this.surfingEffect();   // (the Turbo's dash over the water)
        return 0;
    }
    swimPaddleEnd() { this.setAnimation(A.PADDLE_END, 1); if (this.isLast1AnimeFrame()) return this.changePlayerStatus(S.SWIM_PADDLE_END_TO_WAIT, 0, false); this.doSwimming(); return this.swimmingStill() ? 0 : 1; }
    swimPaddleEndToWait() { this.setAnimation(A.PADDLE_TO_WAIT, 1); if (this.isLast1AnimeFrame()) return this.changePlayerStatus(S.SWIM_WAIT, 0, false); this.doSwimming(); return this.swimmingStill() ? 0 : 1; }
    swimUp() {
        this.setAnimation(A.FLOAT, 1);
        this.mVel.y = fr(this.mVel.y + this.mSwimParams.mFloatUp);
        if (this.isLast1AnimeFrame()) { this.setAnimation(A.PADDLE_SWIM_WAIT, 1); return this.changePlayerStatus(S.SWIM_WAIT, 0, false); }
        this.doSwimming(); return this.swimmingStill() ? 0 : 1;
    }
    swimDive() {
        this.setAnimation(A.SWIM_DIVE, 1);
        if (this.getMotionFrameCtrl().checkPass(16)) this.unk366 = this.mSwimParams.mWaitSinkTime;
        if (this.unk366 > 0) { this.unk366 -= 1; this.mVel.y = fr(this.mVel.y - this.mSwimParams.mWaitSinkSpeed); }
        if (this.isLast1AnimeFrame()) { this.setAnimation(A.PADDLE_SWIM_WAIT, 1); return this.changePlayerStatus(S.SWIM_PADDLE_END, 0, false); }
        this.doSwimming(); return this.swimmingStill() ? 0 : 1;
    }
    jumpingDemoCommon(st: number, anim: number, vel: number) {
        this.setPlayerVelocity(vel);
        this.setAnimation(anim, 1);
        if (this.jumpProcess(0) === 1) { this.changePlayerStatus(st, 0, true); return 1; }
        return 0;
    }
    swimPDamage() { this.doSwimming(); this.jumpingDemoCommon(S.SWIM_P_DAMAGE, A.SWIM_P_DAMAGE, 0); if (this.isLast1AnimeFrame()) this.changePlayerStatus(S.SWIM_WAIT, 0, false); return 0; }
    swimDown() { this.doSwimming(); this.jumpingDemoCommon(S.SWIM_DOWN, A.SWIM_DOWN, 0); return 0; }
    swimPDown() { this.doSwimming(); this.jumpingDemoCommon(S.SWIM_P_DOWN, A.SWIM_P_DOWN, 0); return 0; }
    swimMain() {
        if (this.checkFlag(MF.GAME_OVER)) this.changePlayerStatus(S.SWIM_P_DOWN, 0, false);
        if (this.checkSwimJump() === 1) return 0;
        const result = this.checkSwimToHangFence();
        const lim = fr(this.mFloorPosition.z - this.mSwimParams.mFloatHeight);
        if (this.pos.y >= lim) this.pos.y = lim;
        this.unk2A8.y = this.mFloorPosition.z;
        if (this.checkFlag(MF.FLUDD_EMITTING) && this.mStatus !== S.SWIM_PADDLE_START && this.mStatus !== S.SWIM_PADDLE) return this.changePlayerStatus(S.SWIM_PADDLE_START, 0, false);
        switch (this.mStatus) {
            case S.SWIM_START: return this.swimStart();
            case S.SWIM_WAIT: return this.swimWait();
            case S.SWIM_WAIT_TO_PADDLE: return this.swimWaitToPaddle();
            case S.SWIM_PADDLE_START: return this.swimPaddleStart();
            case S.SWIM_PADDLE: return this.swimPaddle();
            case S.SWIM_PADDLE_END: return this.swimPaddleEnd();
            case S.SWIM_PADDLE_END_TO_WAIT: return this.swimPaddleEndToWait();
            case S.SWIM_UP: return this.swimUp();
            case S.SWIM_DIVE: return this.swimDive();
            case S.SWIM_P_DAMAGE: return this.swimPDamage();
            case S.SWIM_DOWN: return this.swimDown();
            case S.SWIM_P_DOWN: return this.swimPDown();
        }
        return result;
    }
    // ---------------------------------------------------------------- MarioAutodemo.cpp (the statuses he can be put in)
    sinkLoser() { this.setPlayerVelocity(0); this.setAnimation(A.SINK_DOWN, 1); if (this.jumpProcess(0) === 1) this.changePlayerStatus(S.LOSER_DOWN, 0, true); return 0; }
    footDowning() {
        switch (this.mStatusArg) {
            case 0: this.setAnimation(A.SANDFILL_LEG, 1); if (this.mInput & 2) this.mStatusArg = 2; break;
            case 1: this.setAnimation(A.SAND_FILL_HEAD, 1); if (this.mInput & 2) this.mStatusArg = 3; break;
            case 2: this.setAnimation(A.SANDFILL_LEG_END, 1); if (this.isLast1AnimeFrame()) return this.changePlayerStatus(S.WAIT, 0, false); break;
            case 3: this.setAnimation(A.SAND_FILL_HEAD_END, 1); if (this.isLast1AnimeFrame()) return this.changePlayerStatus(S.WAIT, 0, false); break;
        }
        this.stopProcess();
        return 0;
    }
    /** bottleIn (inlined in demoMain @0x8011ef68): the bottle_in animation, nothing else */
    bottleIn() { this.setAnimation(A.BOTTLE_IN, 1); return 0; }
    /**
     * openDoor (inlined in demoMain @0x8011ef98): the door's animation standing still, then 150 on
     * through it (open_r / open_l / kick) or back from it (door_gacha_l, the locked door) and WAIT
     */
    openDoor() {
        if (this.mStatusState === 0) { this.startVoice(SE.MV13_ACTION_SMALL_01); this.mStatusState = 1; }
        this.stopProcess();
        if (this.isLast1AnimeFrame()) {
            const y = this.mFaceAngle.y & 0xFFFF;
            if (this.mAnimationId === A.DOOR_OPENR || this.mAnimationId === A.DOOR_OPENL || this.mAnimationId === A.DOOR_KICK) {
                this.pos.x = fr(150 * JMASSin(y) + this.pos.x); this.pos.z = fr(150 * JMASCos(y) + this.pos.z);
            } else {
                this.pos.x = fr(this.pos.x - 150 * JMASSin(y)); this.pos.z = fr(this.pos.z - 150 * JMASCos(y));
            }
            return this.changePlayerStatus(S.WAIT, 0, true);
        }
        return 0;
    }
    nomotion() { this.stopProcess(); return 0; }
    disappear() { this.offUnk114(2); return 0; }
    demoMain() {
        switch (this.mStatus) {
            case S.BOTTLE_IN: return this.bottleIn();
            case S.DOOR_OPEN_R: case S.DOOR_OPEN_L: return this.openDoor();
            case S.SINK_LOSER: return this.sinkLoser();
            case S.FOOT_DOWN: return this.footDowning();
            case S.NOMOTION: return this.nomotion();
            case S.DISAPPEAR: return this.disappear();
        }
        // (the other demos: the player's, from the director)
        return 0;
    }
}
