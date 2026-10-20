// Player/MarioSpecial.cpp: climbing bars (poles, trees, the fluff), hanging from ledges and roofs
// (fence ceilings), climbing fences, being carried, pulling, and specMain. Wires are kept as
// the let-go branches only.

import { fr, s16, JMASSin, JMASCos, matan, IConverge, V3, Mtx, mtxMultVec } from '../math.js';
import { HitActor, HF, MSG } from '../engine.js';
import { WallCheck } from '../collision.js';
import { MarioSwim } from './swim.js';
import { S, A, MF, bg, Bg, wallRecord, ControllerWork } from './base.js';
import { MsSqrtf } from './move.js';
import { AT } from '../actortypes.js';

export abstract class MarioSpecial extends MarioSwim {
    mWireBounceVel = 0; mWireBounceVelPrev = 0; mWireSag = 0;

    /** gpCamera->unk258 (the camera's yaw). Approximated: a simulated Mario has no camera of his own. */
    cameraYaw() { return this.mFaceAngle.y; }

    // ---------------------------------------------------------------- bars (poles, trees, the fluff)
    /** the most a bar lets him climb (bananas 500; the goal flag by map) */
    private barClamp() {
        const h = this.holder!;
        let max = -1;
        if (h.isActorType(AT.BANANA_TREE)) max = 500;
        if (h.isActorType(AT.MONTE_GOAL_FLAG)) { const m = this.world.map; max = m === 8 || m === 9 ? 750 : m === 4 ? 2500 : -1; }
        if (max >= 0 && this.mHolderHeightDiff > max) { this.mHolderHeightDiff = max; this.pos.y = fr(h.pos.y + this.mHolderHeightDiff); }
    }
    /** wall jumping off backwards (A) */
    private barKick() {
        this.pos.x = fr(this.pos.x - fr(200 * JMASSin(this.mFaceAngle.y)));
        this.pos.z = fr(this.pos.z - fr(200 * JMASCos(this.mFaceAngle.y)));
        this.mFaceAngle.y = s16(this.mFaceAngle.y + 0x8000);
        return this.changePlayerStatus(S.WALL_JUMP, 0, false);
    }
    /** barProcess (MarioPhysics.cpp): onto the bar unless a wall's in the way, under the roof, landing on the ground */
    barProcess() {
        const h = this.holder!;
        let result = 0;
        const p = new V3(h.pos.x, this.pos.y, h.pos.z);
        const w1 = this.checkWallPlane(p, 60, 43), w2 = this.checkWallPlane(p, 30, 24);
        if ((!w1 || w1.isMarioThrough()) && (!w2 || w2.isMarioThrough())) this.pos.set(h.pos.x, fr(h.pos.y + this.mHolderHeightDiff), h.pos.z);
        else this.pos.set(p);
        const [ceil] = this.checkRoof(this.pos.x, fr(this.pos.y + 80), this.pos.z);
        if (this.pos.y > fr(ceil - 160)) this.pos.y = fr(ceil - 160);
        const [floor] = this.checkGroundPlane(this.pos.x, this.pos.y, this.pos.z);
        if (this.pos.y < floor) { this.pos.y = floor; this.changePlayerStatus(S.WAIT, 0, false); result = 1; }
        this.setPlayerVelocity(0);
        this.mFaceAngle.x = 0;
        this.mModelFaceAngle = this.mFaceAngle.y;
        return result;
    }
    barWait() {
        const h = this.holder;
        if (!h) return this.changePlayerStatus(S.LAND_SAFE_DOWN, 0, false);
        if (this.mInput & 2) return this.barKick();
        this.pos.set(h.pos.x, fr(h.pos.y + this.mHolderHeightDiff), h.pos.z);
        const C = this.unk108;
        if ((this.mInput & 0x8000) || this.mHolderHeightDiff <= 100) {
            this.setPlayerVelocity(-2);
            this.pos.x = fr(this.pos.x - fr(200 * JMASSin(this.mFaceAngle.y)));
            this.pos.z = fr(this.pos.z - fr(200 * JMASCos(this.mFaceAngle.y)));
            return this.changePlayerStatus(S.LAND_SAFE_DOWN, 0, false);
        }
        if (C.mStickV > 16) return this.changePlayerStatus(S.BAR_CLIMB, 0, false);
        if (C.mStickV < -16) {
            this.mVel.y = fr(this.mVel.y + fr(C.mStickV / 512));
            this.pos.y = fr(this.pos.y + this.mVel.y);
            this.mHolderHeightDiff = fr(this.pos.y - h.pos.y);
            this.effect('treeSlip');   // (treeSlipEffect, MSD_SE_MA_SLIP_TREE)
        }
        if (h.isActorType(AT.ELASTIC_CODE)) {
            if (C.mStickV <= 0) { this.pos.y = fr(this.pos.y - 2); this.mHolderHeightDiff = fr(this.pos.y - h.pos.y); }
            if (this.pos.y < fr(h.pos.y + 200)) { this.pos.y = fr(h.pos.y + 200); this.mHolderHeightDiff = fr(this.pos.y - h.pos.y); }
        }
        this.barClamp();
        this.mFaceAngle.y = s16(this.mFaceAngle.y + s16(Math.trunc(fr(C.mStickH * this.mBarParams.mRotateSp))));
        this.mFaceAngle.x = 0;
        this.mModelFaceAngle = this.mFaceAngle.y;
        if (this.barProcess() === 0) {
            if (C.mStickH === 0) this.setAnimation(A.TREE_WAIT, 1);
            if (C.mStickH > 0) this.setAnimation(A.TREE_MOVE_R, 1);
            if (C.mStickH < 0) this.setAnimation(A.TREE_MOVE_L, 1);
        }
        return 0;
    }
    barClimb() {
        const h = this.holder;
        if (!h) return this.changePlayerStatus(S.LAND_SAFE_DOWN, 0, false);
        if (this.mInput & 2) return this.barKick();
        this.pos.set(h.pos.x, fr(h.pos.y + this.mHolderHeightDiff), h.pos.z);
        const C = this.unk108;
        if (C.mStickV < 8) return this.changePlayerStatus(S.BAR_WAIT, 0, false);
        this.mVel.y = 0;
        this.pos.y = fr(this.pos.y + fr(C.mStickV * this.mBarParams.mClimbSp));
        this.mHolderHeightDiff = fr(this.pos.y - h.pos.y);
        if (this.pos.y > fr(h.pos.y + h.damageHeight)) {
            this.setPlayerVelocity(0);
            this.changePlayerStatus(S.JUMP, 0, false);
            this.unk78 &= ~0x100;
        }
        if (this.barProcess() === 0) this.setAnimation(A.TREE_CLIMB, fr(C.mStickV * this.mBarParams.mClimbAnmRate + 1));
        this.barClamp();
        return 0;
    }
    barHang() {
        if (this.mStatusTimer === 0) this.mStatusTimer += 1;   // (rumbleStart)
        if (!this.holder) return this.changePlayerStatus(S.LAND_SAFE_DOWN, 0, false);
        this.mVel.y = 0;
        if (this.barProcess() === 0) {
            this.setAnimation(A.TREE_CATCH, 1);
            if (this.isLast1AnimeFrame()) this.changePlayerStatus(S.BAR_WAIT, 0, false);
        }
        this.mFaceAngle.x = 0;
        this.mModelFaceAngle = this.mFaceAngle.y;
        return 0;
    }

    // ---------------------------------------------------------------- roofs
    hangingCheckRoof(p: V3) {
        const wall = this.checkWallPlane(p, 50, 50);
        if (wall && bg.isFence(wall)) {
            this.mFaceAngle.y = s16(matan(wall.n[2], wall.n[0]) + 0x8000);
            this.mModelFaceAngle = this.mFaceAngle.y;
            return 3;
        }
        const [groundY, ground] = this.checkGround(p.x, p.y, p.z);
        const [roofY, roof] = this.checkRoof(p.x, fr(groundY + 80), p.z);
        if (!ground) return 1;
        if (!roof || roof === this.world.illegal) return 2;
        if (!bg.isFence(roof)) return 2;
        if (fr(roofY - groundY) <= 160) return 1;
        const space = fr(roofY - fr(160 + p.y));
        if (space < -30) return 1;
        if (space > 30) return 2;
        p.y = fr(this.mFloorPosition.x - 160);
        this.mGroundPlane = ground; this.mFloorPosition.y = groundY;
        this.mRoofPlane = roof; this.mFloorPosition.x = roofY;
        return 0;
    }
    doRoofMovingProcess() {
        this.mForwardVel = fr(this.mForwardVel + 1);
        if (this.mForwardVel > 4) this.mForwardVel = 4;
        if (this.mIntendedMag > 0) {
            const diff = s16(this.mIntendedYaw - this.mFaceAngle.y);
            this.mFaceAngle.y = s16(this.mIntendedYaw - IConverge(diff, 0, 0x800, 0x800));
        }
        this.unk9E = this.mFaceAngle.y;
        this.mSlideVelX = fr(this.mForwardVel * JMASSin(this.mFaceAngle.y));
        this.mSlideVelZ = fr(this.mForwardVel * JMASCos(this.mFaceAngle.y));
        this.mVel.x = this.mSlideVelX; this.mVel.y = 0; this.mVel.z = this.mSlideVelZ;
        const np = new V3(fr(this.pos.x - this.mVel.x * this.mRoofPlane.n[1]), this.pos.y, fr(this.pos.z - this.mVel.z * this.mRoofPlane.n[1]));
        let code = this.hangingCheckRoof(np);
        if (code === 2) code = 0;
        else this.pos.set(np);
        this.mModelFaceAngle = this.mFaceAngle.y;
        return code;
    }
    doRoofWaitingProcess() {
        this.mForwardVel = 0; this.mSlideVelX = 0; this.mSlideVelZ = 0;
        this.pos.y = fr(this.mFloorPosition.x - 160);
        this.mVel.set(0, 0, 0);
    }
    roofCommonEvents() {
        if (this.mInput & 0x8000) { this.mInput &= ~0x8000; return this.changePlayerStatus(S.LANDING, 0, false); }
        if (this.mInput & 2) {
            const a = this.mRoofPlane.actor as any;
            if (a) {
                (a as HitActor).receiveMessage(this, MSG.SUPER_HIP_DROP);
                if (a.actorType === AT.FENCE_REVOLVE_INNER) {
                    this.rumbleStart(0x15, this.mMotorParams.mMotorWall);
                    return this.changePlayerStatus(S.KICK_ROOF_ROLL_UP, 0, false);
                }
            }
            return this.changePlayerStatus(S.KICK_ROOF, 0, false);
        }
        return 0;
    }
    hangRoof() {
        const [ry, rp] = this.checkRoof(this.pos.x, fr(80 + this.pos.y), this.pos.z);
        this.mFloorPosition.x = ry; this.mRoofPlane = rp;
        this.mStatusTimer += 1;
        if ((this.mInput & 1) && this.mStatusTimer > 120) return this.changePlayerStatus(S.WAIT_ROOF, 0, false);
        if (this.roofCommonEvents()) return 1;
        this.mModelFaceAngle = this.mFaceAngle.y;
        this.setAnimation(A.LADDER_HANG_CATCH, 1);
        this.doRoofWaitingProcess();
        if (this.isLast1AnimeFrame()) this.changePlayerStatus(S.WAIT_ROOF, 0, false);
        return 0;
    }
    waitRoof() {
        if (this.roofCommonEvents()) return 1;
        if (this.mInput & 1) return this.changePlayerStatus(S.MOVE_ROOF, this.mStatusArg, false);
        this.setAnimation(this.mStatusArg & 1 ? A.LADDER_HANG_WAIT_L : A.LADDER_HANG_WAIT_R, 1);
        this.doRoofWaitingProcess();
        return 0;
    }
    moveRoof() {
        if (this.roofCommonEvents()) return 1;
        if (this.mInput & 1) {
            switch (this.doRoofMovingProcess()) {
                case 2: return this.changePlayerStatus(S.LANDING, 0, false);
                case 3: this.changePlayerStatus(S.FENCE_CATCH, 0, false); break;
            }
        }
        if (this.mInput & 0x20) return this.changePlayerStatus(S.WAIT_ROOF, this.mStatusArg, false);
        const dx = this.pos.x - this.mPrevPosition.x, dy = this.pos.y - this.mPrevPosition.y, dz = this.pos.z - this.mPrevPosition.z;
        const dist = fr(fr(Math.sqrt(dx * dx + dy * dy + dz * dz)) * this.mHangRoofParams.mAnmMult);
        this.setAnimation(this.mStatusArg & 1 ? A.LADDER_HANG_MOVE_L : A.LADDER_HANG_MOVE_R, dist);
        if (this.isLast1AnimeFrame()) this.mStatusArg = 1 - this.mStatusArg;
        return 0;
    }
    kickRoof() {
        this.setAnimation(A.LADDER_HANG_KICK, 1);
        this.attackRadius = this.mAttackParamsKickRoof.mRadius;
        this.attackHeight = this.mAttackParamsKickRoof.mHeight;
        if (this.isLast1AnimeFrame()) { this.mInput &= ~2; return this.changePlayerStatus(S.WAIT_ROOF, 0, false); }
        return 0;
    }
    kickRoofRollUp() {
        this.setAnimation(A.LADDER_ROLL_UP, 1);
        this.mStatusTimer++;
        if (this.isLast1AnimeFrame()) {
            this.pos.y = fr(this.pos.y + 160);
            this.mFloorPosition.y = this.pos.y;
            this.mInput &= ~4;
            return this.changePlayerStatus(S.WAIT, 0, false);
        }
        return 0;
    }
    kickRoofRollDown() {
        this.setAnimation(A.LADDER_ROLL_DOWN, 1);
        if (this.isLast1AnimeFrame()) return this.changePlayerStatus(S.WAIT_ROOF, 0, false);
        return 0;
    }

    // ---------------------------------------------------------------- ledges
    startHangLanding(st: number) {
        this.mVel.y = 0; this.mForwardVel = 0;
        this.pos.x = fr(this.pos.x - 60 * JMASSin(this.mFaceAngle.y));
        this.pos.z = fr(this.pos.z - 60 * JMASCos(this.mFaceAngle.y));
        const [gy] = this.checkGround(this.pos.x, this.pos.y, this.pos.z);
        if (gy < fr(this.pos.y - 100)) this.pos.y = fr(this.pos.y - 100);
        else this.pos.y = gy;
        return this.changePlayerStatus(st, 0, false);
    }
    findNearestWall(r: WallCheck): Bg | null {
        let found: Bg | null = null;
        for (const w of r.results) {
            const ang = s16(matan(w.n[2], w.n[0]) - (this.mFaceAngle.y + 0x8000));
            if (ang > -0x2000 && ang < 0x2000) {
                const d = fr(w.n[0] * this.pos.x + w.n[1] * this.pos.y + w.n[2] * this.pos.z + w.d);
                if (d < 50) found = w;
            }
        }
        return found;
    }
    hanging() {
        let pulledUp = false;
        const yawDiff = s16(this.mIntendedYaw - this.mFaceAngle.y);
        const onCeil = fr(this.mFloorPosition.x - this.mFloorPosition.y) >= 160;
        const H = this.mHangingParams;
        if (this.mStatusTimer === 0) this.unkF6 = 0;
        if (this.mStatusTimer < H.mLimitTime) this.mStatusTimer += 1;
        if ((this.mInput & 0x8004) || bg.isUnk1(this.mGroundPlane) || bg.isNoLedgeGrab(this.mGroundPlane)) {
            this.mInput &= ~4; this.mInput &= ~0x8000;
            return this.startHangLanding(S.WALL_SLIDE);
        }
        if ((this.mInput & 2) && onCeil) return this.changePlayerStatus(S.HANG_JUMPING, 0, false);
        const rec = wallRecord(this.pos.x, fr(this.pos.y - 10), this.pos.z, 30, 4, 0);
        this.isTouchedWallsAndMoveXZ(rec);
        const wall = this.findNearestWall(rec);
        if (!wall) this.changePlayerStatus(S.LANDING, 0, false);
        if (wall && bg.isFence(wall)) {
            this.pos.x = fr(this.pos.x - 40 * JMASSin(this.mFaceAngle.y));
            this.pos.y = fr(this.pos.y - 160);
            this.pos.z = fr(this.pos.z - 40 * JMASCos(this.mFaceAngle.y));
            return this.changePlayerStatus(S.FENCE_CATCH, 0, false);
        }
        const rec2 = wallRecord(this.pos.x, fr(10 + this.pos.y), this.pos.z, 50, 1, 0);
        this.isTouchedWallsAndMoveXZ(rec2);
        // mPosition = record2.mCenter (the center's y is the +10 one)
        this.pos.set(fr(rec2.center[0]), fr(rec2.center[1]), fr(rec2.center[2]));
        if (this.mStatusTimer >= 0x28 && (this.mInput & 1)) {
            if (yawDiff >= -0x400 && yawDiff <= 0x400 && onCeil) {
                this.setAnimation(A.HGUP, 1);
                return this.changePlayerStatus(S.ASCEND, 0, false);
            }
            if (yawDiff <= -0x71c7 || yawDiff >= 0x71c7) return this.startHangLanding(S.LAND_SAFE_DOWN);
            if (this.mStatusTimer < H.mRapidTime && rec.results.length > 0 && wall) {
                const sp = H.mMoveSp;
                // (newPos is left uninitialized by the game when neither branch applies: the position here)
                const np = new V3(this.pos.x, this.pos.y, this.pos.z);
                if (yawDiff > 0x400 && yawDiff < 0x71c7) {
                    np.x = fr(this.pos.x - sp * (this.mIntendedMag * wall.n[2])); np.y = this.pos.y; np.z = fr(this.pos.z + sp * (this.mIntendedMag * wall.n[0]));
                }
                if (yawDiff > -0x71c7 && yawDiff < -0x400) {
                    np.x = fr(this.pos.x + sp * (this.mIntendedMag * wall.n[2])); np.y = this.pos.y; np.z = fr(this.pos.z - sp * (this.mIntendedMag * wall.n[0]));
                }
                const rec3 = wallRecord(np.x, fr(10 + np.y), np.z, 50, 1, 0);
                this.isTouchedWallsAndMoveXZ(rec3);
                np.set(fr(rec3.center[0]), fr(rec3.center[1]), fr(rec3.center[2]));
                const [gy] = this.checkGround(np.x, fr(50 + np.y), np.z);
                if (fr(this.pos.y - 100) < gy && gy < fr(50 + this.pos.y)) {
                    const rec4 = wallRecord(fr(np.x - 30 * JMASSin(this.mFaceAngle.y)), fr(gy - 20), fr(np.z - 30 * JMASCos(this.mFaceAngle.y)), 30, 4, 0);
                    this.isTouchedWallsAndMoveXZ(rec4);
                    const w2 = this.findNearestWall(rec4);
                    if (w2 && this.mDeParams.mHangWallMovableAngle < wall.n[0] * w2.n[0] + wall.n[1] * w2.n[1] + wall.n[2] * w2.n[2]) {
                        this.mFaceAngle.y = s16(matan(w2.n[2], w2.n[0]) + 0x8000);
                        this.pos.x = fr(rec4.center[0] - 40 * w2.n[0]);
                        this.pos.z = fr(rec4.center[2] - 40 * w2.n[2]);
                        this.pos.y = this.checkGround(this.pos.x, fr(160 + this.pos.y), this.pos.z)[0];
                        pulledUp = true;
                    }
                }
            }
        }
        if (this.mStatusTimer >= H.mLimitTime) return this.startHangLanding(S.LAND_SAFE_DOWN);
        const below = fr(this.pos.y - this.checkPlayerAround(-0x8000, 30));
        if (onCeil && below < 100) return this.changePlayerStatus(S.HANG_JUMPING, 0, false);
        this.setPlayerVelocity(0);
        this.mVel.y = 0;
        this.pos.y = this.mFloorPosition.y;
        this.mModelFaceAngle = this.mFaceAngle.y;
        if (pulledUp) {
            const dx = fr(this.pos.x - this.mPrevPosition.x), dz = fr(this.pos.z - this.mPrevPosition.z);
            const rate = fr(MsSqrtf(fr(dx * dx + dz * dz)) * H.mAnmRate);
            this.setAnimation(yawDiff < 0 ? A.HMOV_L : A.HMOV_R, rate);
        } else if (this.mStatusTimer < H.mRapidTime) this.setAnimation(A.HANG, 1);
        else this.setAnimation(A.HANG, H.mAnmRapid);
        return 0;
    }
    ascend() {
        if (this.mInput & 4) return this.startHangLanding(S.LAND_SAFE_DOWN);
        this.waitProcess(); this.setAnimation(A.HGUP, 1);
        if (this.isLast1AnimeFrame()) this.changePlayerStatus(S.WAIT, 0, false);
        return 0;
    }
    descend() {
        if (this.mInput & 4) return this.startHangLanding(S.LAND_SAFE_DOWN);
        this.waitProcess(); this.setAnimation(A.HGDWN, 1);
        if (this.isLast1AnimeFrame()) this.changePlayerStatus(S.HANGING, 0, false);
        return 0;
    }
    hangJumping() {
        if (this.mInput & 4) return this.startHangLanding(S.LAND_SAFE_DOWN);
        this.waitProcess(); this.setAnimation(A.HGJMP, 1);
        if (this.isLast1AnimeFrame()) this.changePlayerStatus(S.WAIT, 0, false);
        return 0;
    }
    taken() {
        const h = this.holder as any;
        const m = h && h.getTakingMtx ? h.getTakingMtx() : null;
        if (m) { this.pos.set(fr(m[3]), fr(m[7]), fr(m[11])); }
        this.mFaceAngle.x = 0;
        this.mModelFaceAngle = this.mFaceAngle.y;
        this.setAnimation(A.THROWN, 1);
        return 0;
    }

    // ---------------------------------------------------------------- fences
    fenceFootCheck() {
        const f = new V3(fr(this.pos.x + 0.8 * fr(50 * JMASSin(this.mFaceAngle.y))), this.pos.y, fr(this.pos.z + 0.8 * fr(50 * JMASCos(this.mFaceAngle.y))));
        if (!this.checkWallPlane(f, 20, 50)) {
            this.mFaceAngle.y = s16(this.mFaceAngle.y + 0x8000);
            this.setPlayerVelocity(0); this.mVel.y = 0;
            this.changePlayerStatus(S.LAND_SAFE_DOWN, 0, false);
        }
    }
    fenceCatch() {
        this.setAnimation(A.FENCE_CATCH, 1);
        this.fenceFootCheck();
        if (this.isLast1AnimeFrame()) {
            if (fr(5 + this.mFloorPosition.y) > this.pos.y) this.pos.y = fr(this.pos.y + 5);
            if (fr(this.mFloorPosition.x - 5) < this.pos.y) this.pos.y = fr(this.pos.y - 5);
            return this.changePlayerStatus(S.FENCE_MOVE, 0, false);
        }
        return 0;
    }
    fenceJumpCatch() {
        this.setAnimation(A.FENCE_JCATCH, 1);
        this.fenceFootCheck();
        if (this.isLast1AnimeFrame()) return this.changePlayerStatus(S.FENCE_MOVE, 0, false);
        return 0;
    }
    fenceMove() {
        const front = new V3(fr(this.pos.x + 0.5 * fr(50 * JMASSin(this.mFaceAngle.y))), this.pos.y, fr(this.pos.z + 0.5 * fr(50 * JMASCos(this.mFaceAngle.y))));
        const wall = this.checkWallPlane(front, 80, 50);
        const sp = this.mJumpParams.mFenceSpeed;
        if (wall) {
            if (this.mInput & 1) {
                const np = new V3(this.pos.x, fr(this.pos.y + 0.015625 * this.unk108.mStickV * sp), this.pos.z);
                const camDelta = s16(this.mFaceAngle.y - this.cameraYaw());
                let nx: number, nz: number;
                if (camDelta > -0x4000 && camDelta < 0x4000) { nz = wall.n[0]; nx = -wall.n[2]; }
                else { nx = wall.n[2]; nz = -wall.n[0]; }
                const sh = fr(0.015625 * this.unk108.mStickH);
                np.x = fr(np.x + nx * sh * sp); np.z = fr(np.z + nz * sh * sp);
                const sf = new V3(fr(np.x + 0.5 * fr(50 * JMASSin(this.mFaceAngle.y))), np.y, fr(np.z + 0.5 * fr(50 * JMASCos(this.mFaceAngle.y))));
                const sf2 = new V3(sf.x, sf.y, sf.z);
                const w1 = this.checkWallPlane(sf, 20, 50);
                const w2 = this.checkWallPlane(sf2, 140, 50);
                if (w1 && bg.isFence(w1) && w2 && bg.isFence(w2)) {
                    if (this.mStatus === S.FENCE_MOVE) this.changePlayerStatus(0x30000569, 0, false);
                    this.pos.set(np);
                }
            } else {
                this.setAnimation(A.FENCE_WAIT, 1);
                this.changePlayerStatus(S.FENCE_MOVE, 0, false);
            }
            this.mFaceAngle.y = s16(matan(wall.n[2], wall.n[0]) + 0x8000);
        } else {
            this.mFaceAngle.y = s16(this.mFaceAngle.y + 0x8000);
            this.mModelFaceAngle = this.mFaceAngle.y;
            this.setPlayerVelocity(0);
            return this.changePlayerStatus(S.LANDING, 0, false);
        }
        this.mModelFaceAngle = this.mFaceAngle.y;
        this.pos.x = fr(this.pos.x + 0.5 * fr(50 * JMASSin(this.mFaceAngle.y)));
        this.pos.z = fr(this.pos.z + 0.5 * fr(50 * JMASCos(this.mFaceAngle.y)));
        this.mVel.set(0, 0, 0);
        switch (this.jumpProcess(1)) {
            case 1:
                this.mFaceAngle.y = s16(this.mFaceAngle.y + 0x8000);
                return this.changePlayerStatus(S.LANDING, 0, false);
            case 3:
                this.pos.x = fr(this.pos.x + 50 * JMASSin(this.mFaceAngle.y));
                this.pos.y = fr(1 + this.mFloorPosition.y);
                this.pos.z = fr(this.pos.z + 50 * JMASCos(this.mFaceAngle.y));
                this.setAnimation(A.HGUP, 1);
                this.mInput &= ~4;
                return this.changePlayerDropping(S.ASCEND, 0);
            default: {
                if (this.mRoofPlane) {
                    const roofY = this.mFloorPosition.x;
                    if (roofY < fr(160 + this.pos.y)) { this.pos.y = fr(roofY - 160); this.changePlayerStatus(S.FENCE_MOVE, 0, false); }
                }
                if (this.mInput & 2) { this.rumbleStart(0x15, this.mMotorParams.mMotorWall); return this.startJumpWall(); }
                if (this.mInput & 0x8000) { this.mInput &= ~0x8000; return this.changePlayerStatus(S.FENCE_PUNCH, 0, false); }
                if (this.mIntendedMag > 0) {
                    let hDot: number, vDiff: number, dist: number;
                    if (!this.unk2C0) {
                        vDiff = fr(this.pos.y - this.mPrevPosition.y);
                        const fx = JMASSin(this.mFaceAngle.y), fz = JMASCos(this.mFaceAngle.y);
                        // side = (0,1,0) x front = (fz, 0, -fx)
                        const dx = this.pos.x - this.mPrevPosition.x, dy = this.pos.y - this.mPrevPosition.y, dz = this.pos.z - this.mPrevPosition.z;
                        hDot = fr(fz * dx - fx * dz);
                        dist = fr(Math.sqrt(dx * dx + dy * dy + dz * dz));
                    } else {
                        vDiff = fr(this.unk2F4.y - this.unk300.y);
                        hDot = fr(this.unk2F4.x - this.unk300.x);
                        if (s16(Math.trunc(fr(182.04445 * this.unk30C) - this.mFaceAngle.y)) !== 0) hDot = -hDot;
                        const dx = this.unk2F4.x - this.unk300.x, dy = this.unk2F4.y - this.unk300.y, dz = this.unk2F4.z - this.unk300.z;
                        dist = fr(Math.sqrt(dx * dx + dy * dy + dz * dz));
                    }
                    const absH = Math.abs(hDot), absV = Math.abs(vDiff);
                    if (absV > 5 * absH) this.setAnimation(vDiff > 0 ? A.FENCE_MOVE_UP : A.FENCE_MOVE_DOWN, dist);
                    else if (hDot > 0) this.setAnimation(A.FENCE_MOVE_L, dist);
                    else this.setAnimation(A.FENCE_MOVE_R, dist);
                }
                return 0;
            }
        }
    }
    fencePunch() {
        const p = new V3(fr(this.pos.x + 0.5 * fr(50 * JMASSin(this.mFaceAngle.y))), this.pos.y, fr(this.pos.z + 0.5 * fr(50 * JMASCos(this.mFaceAngle.y))));
        const wall = this.checkWallPlane(p, 80, 50);
        if (this.mInput & 2) { this.rumbleStart(0x15, this.mMotorParams.mMotorWall); return this.startJumpWall(); }
        if (wall) this.pos.set(p);
        else {
            this.mFaceAngle.y = s16(this.mFaceAngle.y + 0x8000);
            this.mModelFaceAngle = this.mFaceAngle.y;
            this.setPlayerVelocity(0);
            return this.changePlayerStatus(S.LANDING, 0, false);
        }
        this.setAnimation(A.FENCE_PUNCH, 1);
        this.attackRadius = this.mAttackParamsFencePunch.mRadius;
        this.attackHeight = this.mAttackParamsFencePunch.mHeight;
        this.offHitFilter(HF.NO_ATTACK);
        this.mModelFaceAngle = this.mFaceAngle.y;
        if (this.getMotionFrameCtrl().checkPass(5)) {
            this.rumbleStart(0x15, this.mMotorParams.mMotorWall);
            const a = this.unk2C0;
            if (a) {
                (a as HitActor).receiveMessage(this, MSG.SUPER_HIP_DROP);
                if (a.actorType === AT.FENCE_REVOLVE_INNER) {
                    let x = this.unk2F4.x, z = this.unk2F4.y;
                    if (x < -120) x = -120; if (120 < x) x = 120;
                    if (z < -190) z = -190; if (60 < z) z = 60;
                    this.unk2F4.x = x; this.unk2F4.y = z;
                    mtxMultVec(this.getRidingMtx(), this.unk2F4, this.pos);
                }
            }
        }
        if (this.isLast1AnimeFrame()) { this.changePlayerStatus(S.FENCE_MOVE, 0, false); return 1; }
        return 0;
    }

    // ---------------------------------------------------------------- wires: not reachable (see the top)
    wireStub() { if (!this.holder) return this.changePlayerStatus(S.LANDING, 0, false); return 0; }

    // ---------------------------------------------------------------- pulling (a tentacle, the beak, a Fire Chomp's tail)
    /** getCurrentPullParams: [rate V, rate H] by what he holds (the oil rates while oil-pulling) */
    getCurrentPullParams(): [number, number] | null {
        const h = this.mHeldObject;
        if (!h) return null;
        let P: any = null;
        if (h.isActorType(AT.BOSS_UNK8)) P = this.mPullParamsBGBeak;
        else if (h.isActorType(AT.BOSS_GESSO_TENTACLE)) P = this.mPullParamsBGTentacle;
        else if (h.isActorType(AT.BOSS_UNKD)) P = this.mPullParamsBGFireWanWanBossTail;
        else if (h.isActorType(AT.FIRE_WANWAN_TAIL_HIT)) P = this.mPullParamsFireWanWanTail;
        if (!P) return null;
        return this.mStatus === S.PULLING ? [P.mPullRateV, P.mPullRateH] : [P.mOilPullRateV, P.mOilPullRateH];
    }
    pulling() {
        const h = this.mHeldObject as any;
        if (!h) return this.changePlayerStatus(S.LANDING, 0, false);
        if (this.mInput & 4) { h.receiveMessage(this, MSG.DETACH); this.mHeldObject = null; return this.changePlayerStatus(S.LANDING, 0, false); }
        if (!(this.unk108.mInput & ControllerWork.B)) { h.receiveMessage(this, MSG.DETACH); this.mHeldObject = null; return this.changePlayerStatus(S.PULL_END, 0, false); }
        if (this.mInput & 2) { this.setAnimation(A.HOLD_TO_HANG, 1); return this.changePlayerJumping(S.PULL_JUMP, 0); }
        if (this.mStatus === S.OIL_PULLING && !this.checkFlag(MF.DIRTY)) this.changePlayerStatus(S.PULLING, 0, false);
        const m = h.getTakingMtx() as Mtx | null;
        if (m) { this.mFaceAngle.y = matan(-m[10], -m[2]); this.mModelFaceAngle = this.mFaceAngle.y; }
        const pos = this.pos.clone();
        const back = s16(this.mFaceAngle.y + 0x8000), diff = s16(back - this.mIntendedYaw);
        let c = JMASCos(diff);
        if (c < 0) c = 0;
        let sn = JMASSin(diff);
        c = fr(c * this.mIntendedMag); sn = fr(sn * this.mIntendedMag);
        const r = this.getCurrentPullParams();
        const rv = r ? r[0] : 0, rh = r ? r[1] : 0;
        pos.x = fr(pos.x + fr(fr(rv * fr(c * JMASSin(back))) - fr(rh * fr(sn * JMASCos(back)))));
        pos.z = fr(pos.z + fr(fr(rv * fr(c * JMASCos(back))) + fr(rh * fr(sn * JMASSin(back)))));
        if (h.moveRequest && h.moveRequest(pos) === true) this.pos.set(pos);
        this.stopProcess();
        const rate = this.mStatus === S.OIL_PULLING ? 5 : 1;
        switch (this.mAnimationId) {
            case A.HOLD: case A.HANG_TO_HOLD:
                if (this.isLast1AnimeFrame()) this.setAnimation(A.HOLD_WAIT, 1);
                break;
            default: {
                const d = (h.isActorType(AT.BOSS_GESSO_TENTACLE) || h.isActorType(AT.BOSS_UNK8)) ? V3.sub(pos, this.mPrevPosition) : V3.sub(this.pos, this.mPrevPosition);
                const len = fr(d.length());
                if (len < 1) this.setAnimation(A.HOLD_WAIT, rate);
                else {
                    const ad = s16(matan(d.z, d.x) - this.mFaceAngle.y);
                    if (ad >= -0x2000 && ad <= 0x2000) this.setAnimation(A.HOLD_DRAG, rate);
                    if (ad <= -0x6000 || ad >= 0x6000) this.setAnimation(A.HOLD_BACK, rate);
                    if (ad > -0x6000 && ad < -0x2000) this.setAnimation(A.HOLD_MOVE_R, rate);
                    if (ad > 0x2000 && ad < 0x6000) this.setAnimation(A.HOLD_MOVE_L, rate);
                }
                break;
            }
        }
        return 0;
    }

    specMain() {
        let result = 0;
        const W = this.mWireParams;
        this.mWireBounceVelPrev = this.mWireBounceVel;
        this.mWireBounceVel = fr(this.mWireBounceVel - this.mWireSag * W.mSwingRate);
        this.mWireSag = fr(this.mWireSag + this.mWireBounceVel);
        this.mWireSag = fr(this.mWireSag * W.mWireSwingBrake);
        if (this.mWireSag < -W.mWireSwingMax) this.mWireSag = -W.mWireSwingMax;
        if (W.mWireSwingMax < this.mWireSag) this.mWireSag = W.mWireSwingMax;
        switch (this.mStatus) {
            case S.BAR_WAIT: result = this.barWait(); break;
            case S.BAR_HANG: result = this.barHang(); break;
            case S.BAR_CLIMB: result = this.barClimb(); break;
            case S.KICK_ROOF_ROLL_UP: result = this.kickRoofRollUp(); break;
            case S.KICK_ROOF_ROLL_DOWN: result = this.kickRoofRollDown(); break;
            case S.KICK_ROOF: result = this.kickRoof(); break;
            case S.HANG_ROOF: result = this.hangRoof(); break;
            case S.WAIT_ROOF: result = this.waitRoof(); break;
            case S.MOVE_ROOF: result = this.moveRoof(); break;
            case S.HANGING: result = this.hanging(); break;
            case S.ASCEND: result = this.ascend(); break;
            case S.DESCEND: result = this.descend(); break;
            case S.HANG_JUMPING: result = this.hangJumping(); break;
            case S.TAKEN: result = this.taken(); break;
            case S.WIRE_WAIT: case S.WIRE_S_WAIT: case S.WIRE_WAIT_TO_S_WAIT_L: case S.WIRE_WAIT_TO_S_WAIT_R:
            case S.WIRE_WAIT_TO_HANG: case S.WIRE_S_WAIT_TO_HANG: case S.WIRE_RETURN: case S.WIRE_HANGING:
            case S.WIRE_ROLLING: case S.WIRE_S_WAIT_TO_WAIT_R: case S.WIRE_S_WAIT_TO_WAIT_L:
                result = this.wireStub(); break;
            case S.PULLING: case S.OIL_PULLING: result = this.pulling(); break;
            case S.FENCE_CATCH: result = this.fenceCatch(); break;
            case S.FENCE_JUMP_CATCH: result = this.fenceJumpCatch(); break;
            case 0x30000569: case S.FENCE_MOVE: result = this.fenceMove(); break;
            case S.FENCE_PUNCH: result = this.fencePunch(); break;
        }
        return result;
    }
}
