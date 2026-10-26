// Player/MarioJump.cpp: the jumps, the air control, landing on things, wall kicks, dives, the down
// statuses in the air, and jumpMain.

import { fr, s16, JMASSin, JMASCos, matan, FConverge } from '../math.js';
import { HitActor, MSG } from '../engine.js';
import { MarioRun } from './run.js';
import { fmul, fadd, fsub, fmadd } from './fmath.js';
import { S, MF, A, bg } from './base.js';
import { SE } from '../soundids.js';
import { AT } from '../actortypes.js';

/** s16 += f32 (the game converts the sum) */
const addAngle = (a: number, f: number) => s16(Math.trunc(a + f));

export abstract class MarioJump extends MarioRun {
    /** the L trigger (checkFrameMeaning(MEANING_L)) on his pad */
    abstract padFrameL(): boolean;
    startJumpWall() {
        this.mVel.y = 52;
        this.mFaceAngle.y = s16(this.mFaceAngle.y + 0x8000);
        if (this.mVel.y + (160 + this.pos.y) >= this.mFloorPosition.x) this.mVel.y = 1;
        return this.changePlayerStatus(S.WALL_JUMP, 0, false);
    }
    checkJumpingThrowStart() { if (this.mHeldObject && (this.mInput & 0x2000)) this.changePlayerStatus(S.JUMP_THROW, 0, false); }
    doSlipJumping() {
        this.mForwardVel = fr(this.mForwardVel * this.mJumpParams.mJumpSpeedBrake);
        if (this.mInput & 1) {
            const d = (this.mIntendedYaw - this.mFaceAngle.y) & 0xFFFF, inc = fr(0.03125 * this.mIntendedMag);
            this.mForwardVel = fr(this.mForwardVel + inc * JMASCos(d) * this.getJumpAccelControl());
            this.mFaceAngle.y = addAngle(this.mFaceAngle.y, fr(inc * JMASSin(d) * this.getJumpSlideControl()));
        }
        if (this.mForwardVel > 32) this.mForwardVel = fr(this.mForwardVel - 0.2);
        if (this.mForwardVel < -16) this.mForwardVel = fr(this.mForwardVel + 0.4);
        this.mVel.x = this.mSlideVelX = fr(this.mForwardVel * JMASSin(this.mFaceAngle.y));
        this.mVel.z = this.mSlideVelZ = fr(this.mForwardVel * JMASCos(this.mFaceAngle.y));
    }
    setJumpingAttackArea() {
        if (this.mVel.y < 0) { this.attackRadius = this.mDeParams.mTrampleRadius; this.attackHeight = this.mDeParams.mAttackHeight; }
        else { this.attackRadius = this.mDeParams.mPushupRadius; this.attackHeight = this.mDeParams.mPushupHeight; }
    }
    /** canSpray for doJumping's rocket boost (no water gun: false) */
    gunCanSpray() { return false; }
    /** doJumping (the DOL's float operations) */
    doJumping() {
        let side = 0;
        this.mForwardVel = fmul(this.mForwardVel, this.mJumpParams.mJumpSpeedBrake);
        if (this.mInput & 1) {
            let mag = this.mIntendedMag;
            const d = s16(this.mIntendedYaw - this.mFaceAngle.y);
            if (this.mStatus === S.ROCKET && this.checkFlag(MF.HAS_FLUDD) && this.gunCanSpray()) mag = fmul(2.5, this.mIntendedMag);
            if (this.mStatus === S.WALL_JUMP && this.mVel.y > 0 && (d < -0x4000 || d > 0x4000)) mag = 0;
            // Yoshi's flutter (mFlutterState 1): mYoshiParams' hold-out controls, forward or back
            let acc: number;
            if (this.onYoshi() && this.mYoshi!.mFlutterState === 1) acc = d > -0x4000 && d < 0x4000 ? this.mYoshiParams.mHoldOutAccCtrlF : this.mYoshiParams.mHoldOutAccCtrlB;
            else acc = this.getJumpAccelControl();
            this.mForwardVel = fmadd(acc, fmul(mag, JMASCos(d)), this.mForwardVel);
            side = fmul(fmul(mag, JMASSin(d)), this.getJumpSlideControl());
        }
        if (this.mForwardVel > 32) this.mForwardVel = fsub(this.mForwardVel, fr(0.2));
        if (this.mForwardVel < -16) this.mForwardVel = fadd(this.mForwardVel, fr(0.4));
        this.mSlideVelX = fmul(this.mForwardVel, JMASSin(this.mFaceAngle.y));
        this.mSlideVelZ = fmul(this.mForwardVel, JMASCos(this.mFaceAngle.y));
        this.mSlideVelX = fmadd(side, JMASSin(this.mFaceAngle.y + 0x4000), this.mSlideVelX);
        this.mSlideVelZ = fmadd(side, JMASCos(this.mFaceAngle.y + 0x4000), this.mSlideVelZ);
        this.mVel.x = this.mSlideVelX; this.mVel.z = this.mSlideVelZ;
        this.setJumpingAttackArea();
    }
    askStrongGroundTouch() {
        let strong = true;
        if (this.checkUnk114(0x100)) strong = false;
        if (this.unk2A8.y - this.pos.y <= this.mDeParams.mDamageFallHeight) strong = false;
        if (this.onYoshi()) strong = false;
        const g = this.mGroundPlane;
        if (g.bgType === 0xA || g.bgType === 0x800A || g.bgType === 0x108 || bg.isBounceOnLanding(g) || bg.isThing2(g) || bg.isThing3(g)) strong = false;
        if (this.mVel.y > -70) strong = false;
        return strong;
    }
    jumpingBasic(onGround: number, anim: number, flags: number) {
        this.doJumping();
        const r = this.jumpProcess(flags);
        switch (r) {
            case 0: this.setAnimation(anim, 1); break;
            case 1: {
                if (this.mGroundPlane.actor) (this.mGroundPlane.actor as HitActor).receiveMessage(this, MSG.TRAMPLE);
                let trampled = false;
                if (this.askStrongGroundTouch()) {
                    if (this.checkFlag(MF.ON_SAND)) return this.changePlayerStatus(S.FOOT_DOWN, 0, false);
                    // the hard landing with FLUDD on (not the hover nozzle): BROAD_JUMP_SLIP, then the floor damage
                    // (MarioJump.cpp jumpingBasic; the tremble, rumble and effects are drawing only)
                    if (this.checkFlag(MF.HAS_FLUDD) && this.fluddNozzle() !== 2) {
                        this.changePlayerStatus(S.BROAD_JUMP_SLIP, 0, false);
                        trampled = true;
                        this.startVoice(0x789E);
                        this.floorDamageExec(1, 3, 0, this.mMotorParams.mMotorReturn);
                    }
                }
                this.unk2A8.y = this.pos.y;
                this.changePlayerStatus(onGround, 0, false);
                // stopVoice: a plain landing cuts his line short
                if (!trampled) this.startVoice(-1, { stop: true });
                break;
            }
            case 2:
                if (this.mStatus !== S.WIRE_ROLL_JUMP && this.mForwardVel > this.mDeParams.mClashSpeed) { this.changePlayerDropping(S.JUMP_SHORT_BACK_DOWN, 0); return r; }
                this.setAnimation(anim, 1);
                if (this.onYoshi()) { this.setPlayerVelocity(0); break; }
                if (this.mWallPlane && bg.isNoWallJump(this.mWallPlane)) { this.changePlayerStatus(S.ROCKET_LANDING, 0, false); this.setPlayerVelocity(0); break; }
                if (this.mWallPlane && bg.isFence(this.mWallPlane)) {
                    this.mFaceAngle.y = s16(matan(this.mWallPlane.n[2], this.mWallPlane.n[0]) + 0x8000);
                    this.mModelFaceAngle = this.mFaceAngle.y;
                    if (this.mStatus === S.U_TURN_JUMP) this.mModelFaceAngle = s16(this.mModelFaceAngle - 0x8000);
                    return this.changePlayerStatus(S.FENCE_JUMP_CATCH, 0, false);
                }
                if (this.mForwardVel > 16 && this.mStatus !== S.ROCKET_LANDING) {
                    this.playerRefrection(0);
                    this.mFaceAngle.y = s16(this.mFaceAngle.y + 0x8000);
                    if (this.mWallPlane) { this.changePlayerStatus(S.WALL_SLIDE, 0, false); break; }
                    if (this.mVel.y > 0) this.mVel.y = 0;
                    if (this.mForwardVel >= 38) { this.changePlayerStatus(S.JUMP_SHORT_BACK_DOWN, 0, false); break; }
                    if (this.mForwardVel > 8) this.setPlayerVelocity(-8);
                    return this.changePlayerStatus(S.LAND_SAFE_DOWN, 0, false);
                }
                this.setPlayerVelocity(0);
                break;
            case 3: this.setAnimation(A.HANG, 1); this.changePlayerDropping(S.HANGING, 0); break;
            case 4: this.changePlayerStatus(S.HANG_ROOF, 0, false); break;
        }
        return r;
    }
    considerJumpRotate() {
        const [ok, dir] = this.checkStickRotate();
        if (ok) { if (dir === 2) this.mStatus = S.RIGHT_ROTATE_JUMP; else if (dir === 3) this.mStatus = S.LEFT_ROTATE_JUMP; return 1; }
        return 0;
    }
    checkBackTrig() {
        if (this.mInput & 0x8000) {
            if (this.padFrameL()) return this.changePlayerStatus(S.HIP_DROP, 0, false);
            if (!this.onYoshi()) { this.setPlayerVelocity(this.mJumpParams.mJumpJumpCatchSp); return this.changePlayerStatus(S.JUMP_CATCH, 0, false); }
        }
        return 0;
    }
    jumpingCommonEvents() { return this.checkBackTrig() || this.rocketCheck() || this.considerJumpRotate() ? 1 : 0; }
    jumping() {
        if (this.jumpingCommonEvents()) return 1;
        switch (this.mStatus) {
            case 0x89C: this.jumpingBasic(S.THROWN_DOWN, A.THROWN, 0); break;
            case S.FORCE_JUMP: this.jumpingBasic(S.JUMP_SLIP, this.mVel.y >= 0 ? A['2JMP1'] : A['2JMP2'], 3); break;
            default: this.jumpingBasic(S.JUMP_SLIP, A.JUMP, 3); break;
        }
        return 0;
    }
    secJumping() {
        if (this.mStatusTimer === 0) this.mStatusTimer += 1;
        const anim = this.mVel.y >= 0 ? A['2JMP1'] : A['2JMP2'];
        if (this.jumpingCommonEvents()) return 1;
        this.jumpingBasic(S.SEC_JUMP_SLIP, anim, 3);
        return 0;
    }
    ultraJumping() {
        if (this.mStatusTimer === 0) this.mStatusTimer += 1;
        if (this.checkBackTrig()) return 1;
        if (this.rocketCheck()) return 1;
        this.jumpingBasic(S.ULTRA_JUMP_SLIP, A.ROLL, 0);
        return 0;
    }
    backJumping() {
        if (this.checkBackTrig()) return 1;
        if (this.rocketCheck()) return 1;
        if (this.mStatusState === 0 && this.isLast1AnimeFrame()) this.mStatusState = 1;
        this.jumpingBasic(S.SEC_JUMP_SLIP, this.mStatusState === 0 ? 0xF7 : A.LAND, 0);
        return 0;
    }
    landing() {
        if (this.mVel.y < 0 && this.mStatusTimer++ > 240) { this.mStatusTimer = 240; this.mStatusArg = 3; }
        if (this.checkBackTrig()) return 1;
        if (this.rocketCheck()) return 1;
        const anim = this.mStatusArg === 1 ? A.SLPLA : this.mStatusArg === 3 ? A.THROWN : A.LAND;
        this.jumpingBasic(S.LAND_SLIP, anim, 3);
        return 0;
    }
    uTurnJumping() {
        if (this.jumpingCommonEvents()) return 1;
        if (this.checkBackTrig()) return 1;
        if (this.jumpingBasic(S.U_TURN_JUMP_SLIP, A.TJMP1, 1) !== 3) { this.mFaceAngle.x = 0; this.mModelFaceAngle = s16(this.mModelFaceAngle + 0x8000); }
        return 0;
    }
    jumpWall() {
        if (this.checkBackTrig()) return 1;
        if (this.considerJumpRotate()) return 1;
        if (this.rocketCheck()) return 1;
        this.jumpingBasic(S.JUMP_SLIP, A.WJMP, 3);
        return 0;
    }
    jumpCatch() {
        if ((this.mInput & 0x8000) && this.padFrameL()) return this.changePlayerStatus(S.HIP_DROP, 0, false);
        this.setAnimation(A.SLDCT, 1);
        this.doJumping();
        switch (this.jumpProcess(0)) {
            case 1:
                if (this.askStrongGroundTouch() && this.checkFlag(MF.ON_SAND)) this.changePlayerStatus(S.FOOT_DOWN, 1, false);
                else this.changePlayerStatus(S.CATCH, 0, false);
                break;
            case 2:
                if (this.mWallPlane && bg.isFence(this.mWallPlane)) return this.changePlayerDropping(S.FENCE_JUMP_CATCH, 0);
                this.playerRefrection(1);
                if (this.mVel.y > 0) this.mVel.y = 0;
                this.changePlayerDropping(S.JUMP_SHORT_BACK_DOWN, 0);
                break;
        }
        return 0;
    }
    jumpingThrow() {
        this.setAnimation(A.THROW, 1);
        this.checkThrowObject();
        this.doJumping();
        switch (this.jumpProcess(0)) {
            case 1: this.mStatus = S.JUMP_THROW_END >>> 0; break;
            case 2: this.setPlayerVelocity(0); break;
        }
        return 0;
    }
    jumpDownCommon(st: number, anim: number, vel: number) {
        this.setPlayerVelocity(vel);
        const r = this.jumpProcess(0);
        switch (r) {
            case 0: this.setAnimation(anim, 1); break;
            case 1: this.changePlayerStatus(st, this.mStatusArg, false); break;
            case 2:
                this.setAnimation(A.BKDWN, 1);
                this.playerRefrection(0);
                if (this.mVel.y > 0) this.mVel.y = 0;
                this.setPlayerVelocity(-vel);
                break;
        }
        return r;
    }
    jumpShortBackDown() { if (this.mStatusTimer === 0) this.mStatusTimer += 1; this.jumpDownCommon(S.SHORT_BACK_DOWN, A.BKDWN, -16); return 0; }
    jumpShortForeDown() { if (this.mStatusTimer === 0) this.mStatusTimer += 1; this.jumpDownCommon(S.SHORT_FORE_DOWN, A.JFDWN, 16); return 0; }
    jumpBackDown() { if (this.mStatusTimer === 0) this.mStatusTimer += 1; this.jumpDownCommon(S.BACK_DOWN, A.BKDWN, -16); return 0; }
    jumpForeDown() { if (this.mStatusTimer === 0) this.mStatusTimer += 1; this.jumpDownCommon(S.FORE_DOWN, A.JFDWN, 16); return 0; }
    landSafeDown() { this.jumpDownCommon(S.LAND_SLIP, A.LAND, this.mForwardVel); return 0; }
    stayWall() {
        this.mStatusTimer += 1;
        if (this.mStatusTimer > 60) this.mStatusTimer = 60;
        if (this.mInput & 2) return this.startJumpWall();
        if (this.checkBackTrig()) return 1;
        if (this.mStatusTimer < 20) { this.mStatusTimer += 1; this.mVel.set(0, 0, 0); }
        else this.mVel.y = fr(-this.mStatusTimer * 0.5);
        if (this.mWallPlane) { this.pos.x = fr(this.pos.x - this.mWallPlane.n[0]); this.pos.z = fr(this.pos.z - this.mWallPlane.n[2]); }
        if (this.jumpProcess(0) === 1) { this.mFaceAngle.y = s16(this.mFaceAngle.y + 0x8000); return this.changePlayerStatus(S.LANDING, 0, false); }
        if (!this.mWallPlane) {
            this.mFaceAngle.y = s16(this.mFaceAngle.y + 0x8000);
            this.setPlayerVelocity(0); this.mVel.y = 0;
            return this.changePlayerStatus(S.LANDING, 0, false);
        }
        this.setAnimation(A.WSLD, 1);
        return 0;
    }
    catchStop() {
        if (this.mStatusState === 0) { this.mVel.y = 30; this.mStatusState = 1; }
        this.doJumping();
        switch (this.jumpProcess(0)) {
            case 0: this.setAnimation(this.mStatusState === 1 ? A.ROLL : A.LAND, 1); break;
            case 1: this.changePlayerStatus(S.LAND_END, 0, false); break;
            case 2: this.setPlayerVelocity(0); break;
        }
        if (this.mStatusState === 1 && this.isLast1AnimeFrame()) this.mStatusState = 2;
        return 0;
    }
    slipFalling() {
        this.mStatusTimer += 1;
        if (this.mStatusTimer > 120 && this.pos.y - this.mFloorPosition.y > 500) return this.changePlayerStatus(S.LANDING, 1, false);
        this.doSlipJumping();
        switch (this.jumpProcess(0)) {
            case 1:
                if (this.mStatusState === 0 && this.mVel.y < 0 && this.mGroundPlane.n[1] >= 0.9848077) { this.mVel.y = fr(-this.mVel.y / 2); this.mStatusState = 1; }
                else this.changePlayerStatus(S.SLIP_FORE, 0, false);
                break;
            case 2:
                if (this.mVel.y > 0) this.mVel.y = 0;
                this.changePlayerStatus(S.JUMP_SHORT_BACK_DOWN, 0, false);
                break;
        }
        this.setAnimation(A.SLIP, 1);
        return 0;
    }
    fireDowning() {
        if (this.mStatusTimer === 1) this.startVoice(SE.MV05_DAMAGE_FIRE_01);
        this.mStatusTimer += 1;
        if (!(this.mInput & 1)) this.mForwardVel = fr(FConverge(this.mForwardVel, 0, 0.35, 0.35));
        if (this.mInput & 1) {
            const d = (this.mIntendedYaw - this.mFaceAngle.y) & 0xFFFF;
            const inc = fr(0.03125 * this.mIntendedMag * this.mJumpParams.mFireDownControl);
            this.mForwardVel = fr(this.mForwardVel + inc * JMASCos(d));
            this.mFaceAngle.y = addAngle(this.mFaceAngle.y, fr(1024 * (inc * JMASSin(d))));
            if (this.mForwardVel < 0) { this.mFaceAngle.y = s16(this.mFaceAngle.y + 0x8000); this.mForwardVel = fr(this.mForwardVel * -1); }
            if (this.mForwardVel > 32) this.mForwardVel = fr(this.mForwardVel - 2);
        }
        this.mVel.x = this.mSlideVelX = fr(this.mForwardVel * JMASSin(this.mFaceAngle.y));
        this.mVel.z = this.mSlideVelZ = fr(this.mForwardVel * JMASCos(this.mFaceAngle.y));
        switch (this.jumpProcess(0)) {
            case 1:
                if (this.mStatusState < 2 && this.mVel.y < 0) { this.mVel.y = fr(0.4 * -this.mVel.y); this.setPlayerVelocity(fr(0.5 * this.mForwardVel)); this.mStatusState += 1; }
                else { this.startVoice(SE.MV07_DAMAGE_REACT_01); this.changePlayerStatus(S.FIRE_JUMP_END, 0, false); }
                break;
            case 2: this.playerRefrection(0); break;
        }
        this.setAnimation(A.FIREJMP, 1);
        return 0;
    }
    thrownDowning() {
        const d = (this.mIntendedYaw - this.mFaceAngle.y) & 0xFFFF, inc = fr(0.03125 * this.mIntendedMag);
        this.mForwardVel = fr(this.mForwardVel + inc * JMASCos(d) * this.mJumpParams.mThrownAccel);
        this.mFaceAngle.y = addAngle(this.mFaceAngle.y, fr(inc * JMASSin(d) * this.mJumpParams.mThrownSlide));
        this.mForwardVel = fr(this.mForwardVel * this.mJumpParams.mThrownBrake);
        this.mVel.x = this.mSlideVelX = fr(this.mForwardVel * JMASSin(this.mFaceAngle.y));
        this.mVel.z = this.mSlideVelZ = fr(this.mForwardVel * JMASCos(this.mFaceAngle.y));
        switch (this.jumpProcess(0)) {
            case 1:
                if (this.mStatusState < 2 && this.mVel.y < 0) { this.mVel.y = fr(0.4 * -this.mVel.y); this.setPlayerVelocity(fr(0.5 * this.mForwardVel)); this.mStatusState += 1; }
                else return this.changePlayerStatus(S.THROWN_END, 0, false);
                break;
            case 2: this.playerRefrection(0); break;
        }
        this.setAnimation(A.THROWN, 1);
        return 0;
    }
    trample() { if (this.jumpingCommonEvents()) return 1; this.jumpingBasic(S.SEC_JUMP_SLIP, this.mAnimationId, 3); return 0; }
    missJumping() {
        if (this.mInput & 0x8000) return this.changePlayerStatus(S.JUMP_CATCH, 0, false);
        this.setPlayerVelocity(fr(0.98 * this.mForwardVel));
        switch (this.jumpProcess(0)) {
            case 1: this.changePlayerStatus(this.mForwardVel < 0 ? S.SLIP : S.JUMP_SLIP, 0, false); break;
            case 2: this.setPlayerVelocity(0); break;
        }
        this.setAnimation(A.JUMP, 1);
        return 0;
    }
    fireJumping() {
        if (this.mStatusTimer === 1) this.startVoice(SE.MV05_DAMAGE_FIRE_01);
        this.mStatusTimer += 1;
        this.setPlayerVelocity(this.mForwardVel);
        if (this.jumpProcess(0) === 1) this.changePlayerStatus(S.FIRE_DASH, 0, false);
        this.setAnimation(this.mStatusArg === 0 ? A.JUMP : A.FIREJMP, 1);
        return 0;
    }
    fireLanding() { this.setPlayerVelocity(this.mForwardVel); if (this.jumpProcess(0) === 1) this.changePlayerStatus(S.FIRE_DASH, 0, false); this.setAnimation(A.LAND, 1); return 0; }
    broadJumping() { this.jumpingBasic(S.RUN, A.BROAD_JUMP, 1); this.onFlag(MF.FLUDD_EMITTING); return 0; }
    rotateBroadJumping() { this.jumpingBasic(S.RUN, A.ROLL_JUMP, 1); return 0; }
    /** rocketCheck: only with FLUDD's rocket or hover nozzle */
    rocketCheck() { return false; }
    /** rocketing: the rocket and hover nozzles' status (the player's: PlayerMario) */
    rocketing() { return this.changePlayerStatus(S.ROCKET_LANDING, 0, false); }
    rotateJumping() {
        if (this.checkBackTrig()) return 1;
        if (this.rocketCheck()) return 1;
        this.setAnimation(A.SPIN_P, 1);
        this.jumpingBasic(S.SEC_JUMP_SLIP, this.mAnimationId, 0);
        this.mStatusTimer += 1;
        this.mModelFaceAngle = s16(this.mStatus === S.RIGHT_ROTATE_JUMP ? this.mStatusTimer * 4096 : this.mStatusTimer * -4096);
        return 0;
    }
    wireJumping() {
        if (this.mPrevStatus === S.WIRE_ROLLING) this.setAnimation(this.mStatusArg === 0 ? A.GIANT_ROLLING : A.ROLL, 1);
        else this.setAnimation(A.JUMP, 1);
        if (this.jumpingCommonEvents()) return 1;
        this.jumpingBasic(S.SEC_JUMP_SLIP, this.mAnimationId, 3);
        return 0;
    }
    hipAttacking() {
        switch (this.mStatusState) {
            case 0: this.startVoice(SE.MV15_EXERT_INST_01); this.mStatusState = 1;
            // fallthrough
            case 1: {
                if (this.mFloorPosition.y > this.pos.y) { this.pos.y = fr(1 + this.mFloorPosition.y); this.changePlayerStatus(S.HIP_ATTACK_END, 0, false); }
                if (this.mStatusTimer < 0x28) {
                    const lift = fr((0x28 - this.mStatusTimer) / 2);
                    if (160 + (this.pos.y + lift) < this.mFloorPosition.x) { this.pos.y = fr(this.pos.y + lift / 4); this.unk104 = this.pos.y; }
                }
                this.setPlayerVelocity(0);
                this.attackRadius = 0;
                this.setAnimation(A.HIPSR, 1);
                this.mStatusTimer += 1;
                if (this.mStatusTimer >= 60) { this.mStatusTimer = 0; this.mStatusState = 2; }
                this.mVel.y = 0;
                const r = this.jumpProcess(0);
                if (r === 1) return this.changePlayerStatus(S.JUMP_END, 0, false);
                if (r === 2) { this.setPlayerVelocity(-16); if (this.mVel.y > 0) this.mVel.y = 0; return this.changePlayerStatus(S.JUMP_SHORT_BACK_DOWN, 0, false); }
                break;
            }
            case 2: case 3: {
                this.setAnimation(A.HIPAT, 1);
                this.mStatusTimer += 1;
                if (this.mStatusTimer > this.mJumpParams.mSuperHipAttackCt) this.mStatusState = 3;
                this.mVel.y = this.mStatusState === 2 ? this.mJumpParams.mHipAttackSpeedY : this.mJumpParams.mSuperHipAttackSpeedY;
                this.attackRadius = this.mDeParams.mHipdropRadius; this.attackHeight = this.mDeParams.mAttackHeight;
                const r = this.jumpProcess(0);
                if (r === 1) {
                    const a = this.mGroundPlane.actor as HitActor | null;
                    if (a) {
                        // the revolving fence's inner panel: he drops through it, flipping it
                        if (!this.onYoshi() && a.actorType === AT.FENCE_REVOLVE_INNER) {
                            this.effect('amiAttack');
                            this.pos.y = fr(this.pos.y - 160);
                            a.receiveMessage(this, MSG.SUPER_HIP_DROP);
                            this.startVoice(SE.MV28_SPRISE_SMALL_01);
                            return this.changePlayerStatus(S.KICK_ROOF_ROLL_DOWN, 0, false);
                        }
                        if (this.mStatusState === 2) a.receiveMessage(this, MSG.HIP_DROP);
                        else { a.receiveMessage(this, MSG.SUPER_HIP_DROP); a.receiveMessage(this, MSG.HIP_DROP); }
                    }
                    this.changePlayerStatus(S.HIP_ATTACK_END, 0, false);
                } else if (r === 2) {
                    this.setPlayerVelocity(-16);
                    if (this.mVel.y > 0) this.mVel.y = 0;
                    this.changePlayerStatus(S.JUMP_SHORT_BACK_DOWN, 0, false);
                }
                break;
            }
        }
        this.mModelFaceAngle = this.mFaceAngle.y;
        return 0;
    }
    fallDead() { this.jumpProcess(0); return 0; }
    /** pullJumping: a hop while holding on, landing back into PULLING */
    pullJumping() {
        if (this.mAnimationId === A.HOLD_TO_HANG && this.isLast1AnimeFrame()) this.setAnimation(A.HOLD_HANG, 1);
        this.mForwardVel = 0; this.mIntendedMag = 0;
        this.jumpingBasic(S.PULLING, this.mAnimationId, 3);
        if (this.mStatus === S.PULLING) this.setAnimation(A.HANG_TO_HOLD, 1);
        const p = this.pos.clone(), h = this.mHeldObject as any;
        if (h && h.moveRequest && h.moveRequest(p) === true) this.pos.set(p);
        return 0;
    }
    jumpMain() {
        this.checkJumpingThrowStart();
        switch (this.mStatus) {
            case S.FORCE_JUMP: case 0x89C: case S.JUMP: return this.jumping();
            case S.SECOND_JUMP: return this.secJumping();
            case S.LANDING: case S.ROCKET_LANDING: return this.landing();
            case S.ULTRA_JUMP: return this.ultraJumping();
            case S.BACK_JUMP: return this.backJumping();
            case S.U_TURN_JUMP: return this.uTurnJumping();
            case S.WALL_JUMP: return this.jumpWall();
            case S.MISS_JUMP: return this.missJumping();
            case S.FIRE_JUMP: return this.fireJumping();
            case S.FIRE_LAND: return this.fireLanding();
            case S.BROAD_JUMP: return this.broadJumping();
            case S.ROTATE_BROAD_JUMP: return this.rotateBroadJumping();
            case S.LEFT_ROTATE_JUMP: case S.RIGHT_ROTATE_JUMP: return this.rotateJumping();
            case S.WIRE_JUMP: case S.WIRE_ROLL_JUMP: return this.wireJumping();
            case S.JUMP_CATCH: return this.jumpCatch();
            case S.JUMP_THROW >>> 0: return this.jumpingThrow();
            case S.JUMP_SHORT_BACK_DOWN: return this.jumpShortBackDown();
            case S.JUMP_SHORT_FORE_DOWN: return this.jumpShortForeDown();
            case S.JUMP_FORE_DOWN: return this.jumpForeDown();
            case S.JUMP_BACK_DOWN: return this.jumpBackDown();
            case S.LAND_SAFE_DOWN: case S.WIRE_HANG_LAND_SAFE_DOWN: return this.landSafeDown();
            case S.WALL_SLIDE: return this.stayWall();
            case S.CATCH_STOP: return this.catchStop();
            case S.SLIP_FALL: return this.slipFalling();
            case S.FIRE_DOWN: return this.fireDowning();
            case S.THROWN_DOWN: return this.thrownDowning();
            case S.TRAMPLE: return this.trample();
            case S.HIP_DROP: return this.hipAttacking();
            case S.FALL_DEAD: return this.fallDead();
            case S.ROCKET: return this.rocketing();
            case S.PULL_JUMP: return this.pullJumping();
            // (surfing, diving: not his)
        }
        return 0;
    }
}
