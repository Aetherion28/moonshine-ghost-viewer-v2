// Player/MarioWait.cpp: standing, sleeping, squatting, the ends of jumps and slips, and waitMain.

import { fr, s16, JMASSin, JMASCos, IConverge } from '../math.js';
import { MarioJump } from './jump.js';
import { S, MF, A } from './base.js';

export abstract class MarioWait extends MarioJump {
    canSleep() {
        if (this.checkFlag(MF.IN_SHALLOW_WATER | MF.IN_WATER)) return false;
        const d = this.mDeParams.mSleepingCheckDist, h = this.mDeParams.mSleepingCheckHeight, y = fr(this.pos.y + 30), fy = this.mFloorPosition.y;
        for (const [ox, oz] of [[-d, 0], [d, 0], [0, -d], [0, d]]) {
            const [g] = this.checkGround(fr(this.pos.x + ox), y, fr(this.pos.z + oz));
            if (g < fy - h || fy + h < g) return false;
        }
        return !this.isTouchedOneWall(this.pos.x, y, this.pos.z, 80);
    }
    canPut() {
        const r = this.mHeldObject ? this.mHeldObject.damageRadius : 0;
        if (this.isTouchedOneWall(fr(this.pos.x + 100 * JMASSin(this.mFaceAngle.y)), fr(10 + this.pos.y), fr(this.pos.z + 100 * JMASCos(this.mFaceAngle.y)), r)) return false;
        return !this.isTouchedOneWall(this.pos.x, fr(10 + this.pos.y), this.pos.z, r);
    }
    waitingCommonEvents() {
        if (this.mInput & 2) { if (this.considerRotateJumpStart()) return 1; return this.changePlayerJumping(S.JUMP, 0); }
        if (this.mInput & 4) return this.changePlayerStatus(S.LANDING, 0, false);
        if (this.mInput & 8) return this.changePlayerStatus(S.SLIP, 0, false);
        if (this.mInput & 0x10) return this.changePlayerStatus(0xC000227, 0, false);
        if (this.mInput & 1) {
            const rot = this.mDeParams.mWaitingRotSp;
            this.mFaceAngle.y = s16(this.mIntendedYaw - IConverge(s16(this.mIntendedYaw - this.mFaceAngle.y), 0, rot, rot));
            if (this.mIntendedMag > this.mControllerParams.mStartToWalkLevel) return this.changePlayerStatus(S.RUN, 0, false);
        }
        if (this.checkFlag(MF.FLUDD_EMITTING)) return this.changePlayerStatus(S.RUN, 0, false);
        if (this.canSquat()) { this.mForwardVel = 0; return this.changePlayerStatus(S.SQUAT, 0, false); }
        if (this.mInput & 0x8000) return this.changePlayerStatus(S.TAKE_POSE, 0, false);
        if (this.rocketCheck()) { this.unk314 = fr(this.mFloorPosition.y + this.hoverHeight()); return this.changePlayerStatus(S.ROCKET, 0, false); }
        if (this.considerRotateStart()) return 1;
        return 0;
    }
    stopCommon(anim: number, onEnd: number) {
        this.waitProcess();
        this.setAnimation(anim, 1);
        // on Yoshi, his animation's end (curAnmEndsNext) ends it too
        if (this.onYoshi() && this.mYoshi!.curAnmEndsNext()) this.changePlayerStatus(onEnd, 0, false);
        else if (this.isLast1AnimeFrame()) this.changePlayerStatus(onEnd, 0, false);
    }
    changeMontemanWaitingAnim() { if (this.mStatus !== S.WAIT) return; this.mStatusState |= 2; }
    waiting() {
        if (this.waitingCommonEvents()) return 1;
        if (this.isMario() && this.mUpperState === 5 && this.canSleep() && this.mAnimationId === A.WAIT && this.isAnimeLoopOrStop() && this.mGroundPlane.n[1] > 0.99) {
            this.mStatusTimer += 1;
            if (this.mStatusTimer >= 10) return this.changePlayerStatus(S.SLEEPY, 0, false);
        }
        if (this.mStatusState & 2) this.setAnimation(A.MONTEMAN_WAIT, 1);
        else if (this.isSinking()) this.setAnimation(A.SINKING, 1);
        else if (this.mUpperState === 5 && (this.mPrevStatus === S.BRAKE_END || this.checkFlag(MF.UNK_20)) && !(this.mStatusState & 1)) {
            this.setAnimation(A.HOT_WAIT, 1);
            if (this.isLast1AnimeFrame()) this.mStatusState |= 1;
        } else if (this.mHealth <= 3) {
            if (this.mAnimationId !== A.DAMAGE_WAIT && this.mAnimationId !== A.DAMAGE_WAIT_START) this.setAnimation(A.DAMAGE_WAIT_START, 1);
            else if (this.mAnimationId === A.DAMAGE_WAIT_START && this.isLast1AnimeFrame()) this.setAnimation(A.DAMAGE_WAIT, 1);
        } else if (this.mIntendedMag === 0) this.setAnimation(A.WAIT, 1);
        else this.setAnimation(A.PIVOT, 1);
        this.waitProcess();
        return 0;
    }
    sleepily() {
        if (this.waitingCommonEvents()) return 1;
        if (this.unk108.mAnalogR > 0 || this.unk108.mAnalogL > 0) this.changePlayerStatus(S.WAIT, 0, false);
        if (this.mStatusState === 3) return this.changePlayerStatus(S.SLEEP, 0, false);
        if (this.mStatusState === 0) this.setAnimation(A.BELT_UP, 1);
        else if (this.mStatusState === 1) this.setAnimation(A.YAWN, 1);
        else if (this.mStatusState === 2) this.setAnimation(A.SIT, 1);
        if (this.isLast1AnimeFrame()) this.mStatusState += 1;
        this.waitProcess();
        return 0;
    }
    sleeping() {
        if ((this.mInput & 0xA41F) || this.unk108.mAnalogR > 0 || this.unk108.mAnalogL > 0) return this.changePlayerStatus(S.WAKEUP, this.mStatusState, false);
        this.waitProcess();
        switch (this.mStatusState) {
            case 0: this.setAnimation(A.SIT_WAIT, 1); if (this.isLast1AnimeFrame() && ++this.mStatusTimer > 0x28) this.mStatusState += 1; break;
            case 1: this.setAnimation(A.SLEEP, 1); if (this.isLast1AnimeFrame()) this.mStatusState += 1; break;
            case 2: this.setAnimation(A.SLEEP_WAIT, 1); break;
        }
        return 0;
    }
    wakeup() {
        if (this.mInput & 4) return this.changePlayerStatus(S.LANDING, 0, false);
        if (this.mInput & 8) return this.changePlayerStatus(S.SLIP, 0, false);
        if (this.waitingCommonEvents()) return 1;
        this.waitProcess();
        this.setAnimation(this.mStatusArg === 0 ? A.SIT_END : A.SLEEP_END, 1);
        if (this.isLast1AnimeFrame()) return this.changePlayerStatus(S.WAIT, 0, false);
        return 0;
    }
    squating() {
        if (this.mInput & 4) return this.changePlayerStatus(S.LANDING, 0, false);
        if (this.mInput & 8) return this.changePlayerStatus(S.SLIP, 0, false);
        if (this.mInput & 0x10) return this.changePlayerStatus(S.SQUAT_STANDUP, 0, false);
        if (!(this.mInput & 0x4000) && !(this.mInput & 0x200)) return this.changePlayerStatus(S.SQUAT_STANDUP, 0, false);
        return this.changePlayerStatus(S.SQUAT_STANDUP, 0, false);   // (no FLUDD)
    }
    squatStandup() {
        if (this.mInput & 4) return this.changePlayerStatus(S.LANDING, 0, false);
        if (this.mInput & 8) return this.changePlayerStatus(S.SLIP, 0, false);
        if (this.mInput & 2) return this.changePlayerStatus(S.JUMP, 0, false);
        if (this.mInput & 1) return this.changePlayerStatus(S.RUN, 0, false);
        this.waitProcess();
        this.setAnimation(this.mStatus === S.THROWN_END ? A.THROWN_END : A.SQEND, 1);
        if (this.isLast1AnimeFrame()) this.changePlayerStatus(S.WAIT, 0, false);
        return 0;
    }
    pullEnd() {
        if (this.mInput & 4) return this.changePlayerStatus(S.LANDING, 0, false);
        if (this.mInput & 8) return this.changePlayerStatus(S.SLIP, 0, false);
        this.waitProcess();
        this.setAnimation(A.HOLD_RETURN, 1);
        if (this.isLast1AnimeFrame()) this.changePlayerStatus(S.WAIT, 0, false);
        return 0;
    }
    jumpEndCommon(anim: number, st: number) {
        this.waitProcess();
        this.setAnimation(anim, 1);
        if (this.isLast1AnimeFrame()) return this.changePlayerStatus(st, 0, false);
        return 0;
    }
    jumpEndEvents(jump: number) {
        if (this.mInput & 0x10) return this.changePlayerStatus(S.WAIT, 0, false);
        if (this.mInput & 2) return jump === 0 ? this.changePlayerTriJump() : this.changePlayerJumping(jump, 0);
        if (this.mInput & 0xF) return this.checkAllMotions();
        return 0;
    }
    jumpEnd() { if (this.jumpEndEvents(0)) return 1; this.jumpEndCommon(A.JMPED, S.WAIT); return 0; }
    secJumpEnd() { if (this.jumpEndEvents(0)) return 1; this.jumpEndCommon(A['2JMED'], S.WAIT); return 0; }
    landEnd() { if (this.jumpEndEvents(0)) return 1; this.jumpEndCommon(A.LAEND, S.WAIT); return 0; }
    ultraJumpEnd() { if (this.jumpEndEvents(S.JUMP)) return 1; this.jumpEndCommon(A.LAEND, S.WAIT); return 0; }
    uTurnJumpEnd() {
        if (this.jumpEndEvents(0)) return 1;
        this.jumpEndCommon(A.TJMP2, S.WAIT);
        this.mFaceAngle.x = 0; this.mModelFaceAngle = s16(this.mModelFaceAngle + 0x8000);
        return 0;
    }
    jumpThrowEnd() { this.checkThrowObject(); this.jumpEndCommon(A.THROW, S.WAIT); return 0; }
    fireJumpEnd() { this.mInput &= ~0x2010; if (this.jumpEndEvents(0)) return 1; this.jumpEndCommon(A.FJPEND, S.WAIT); return 0; }
    broadJumpEnd() {
        this.mInput &= ~0x2000;
        if (this.jumpEndEvents(S.JUMP)) return this.mStatus === S.RUN ? this.changePlayerStatus(S.SQUAT_STANDUP, 0, false) : 1;
        this.jumpEndCommon(A.SQWAT, S.SQUAT_STANDUP);
        return 0;
    }
    hipAttackEnd() {
        this.mStatusState = 1;
        if (this.mInput & 4) return this.changePlayerStatus(S.LANDING, 0, false);
        if (this.mInput & 8) return this.changePlayerStatus(S.SLIP_FORE, 0, false);
        this.jumpEndCommon(A.HIPED, S.SLIP_END);
        return 0;
    }
    brakeEnd() { if (!(this.mInput & 0x10) && (this.mInput & 0xF)) return this.checkAllMotions(); this.stopCommon(0x10, S.WAIT); return 0; }
    slipEnd() { if (this.mInput & 0xF) return this.checkAllMotions(); this.stopCommon(A.SLPED, S.WAIT); return 0; }
    waitMain() {
        this.checkEnforceJump();
        this.checkReturn();
        this.setNormalAttackArea();
        if (this.mHeldObject && (this.mInput & 0x2000)) {
            if (this.mHeldObject.actorType === 0x80000001) this.changePlayerStatus(S.PITCHING, 0, false);
            else if (this.canPut()) this.changePlayerStatus(S.PUTTING, 0, false);
        }
        switch (this.mStatus) {
            case S.WAIT: return this.waiting();
            case S.SLEEPY: return this.sleepily();
            case S.SLEEP: return this.sleeping();
            case S.WAKEUP: return this.wakeup();
            case S.SQUAT: return this.squating();
            case S.SQUAT_START: return 0;
            case S.THROWN_END: case S.SQUAT_STANDUP: return this.squatStandup();
            case S.PULL_END: return this.pullEnd();
            case S.JUMP_END: return this.jumpEnd();
            case S.SEC_JUMP_END: return this.secJumpEnd();
            case S.LAND_END: return this.landEnd();
            case S.U_TURN_JUMP_END: return this.uTurnJumpEnd();
            case S.JUMP_THROW_END >>> 0: return this.jumpThrowEnd();
            case S.FIRE_JUMP_END: return this.fireJumpEnd();
            case S.ULTRA_JUMP_END: return this.ultraJumpEnd();
            case S.BROAD_JUMP_END: return this.broadJumpEnd();
            case S.HIP_ATTACK_END: return this.hipAttackEnd();
            case S.BRAKE_END: return this.brakeEnd();
            case S.SLIP_END: return this.slipEnd();
        }
        return 0;
    }
}
