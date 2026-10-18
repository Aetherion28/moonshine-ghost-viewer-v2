// Player/MarioPhysics.cpp: walking and jumping against the map (walls, ground, roof), ledge grabs,
// gravity.

import { V3, fr, s16, JMASSin, JMASCos, matan } from '../math.js';
import { HitActor, MSG } from '../engine.js';
import { MarioMove, MsSqrtf } from './move.js';
import { S, MF, A, bg, Bg, wallRecord } from './base.js';

type P3 = { x: number; y: number; z: number };

export abstract class MarioPhysics extends MarioMove {
    playerRefrection(back: number) {
        if (this.mWallPlane) { const a = matan(this.mWallPlane.n[2], this.mWallPlane.n[0]); this.mFaceAngle.y = s16(a - s16(this.mFaceAngle.y - a)); }
        if (back !== 0) this.setPlayerVelocity(-this.mForwardVel);
        else this.mFaceAngle.y = s16(this.mFaceAngle.y + 0x8000);
    }
    keepDistance(t: V3, r2: number, r3: number) {
        const dz = fr(this.pos.z - t.z);
        let dx = fr(this.pos.x - t.x);
        const thresh = fr(r3 + fr(r2 + this.unk15C));
        let dist = MsSqrtf(dx * dx + dz * dz);
        if (dist === 0) dist = dx = 1;
        if (!(dist < thresh)) return;
        if (!this.onYoshi()) {
            let burst = this.mForwardVel > this.mDeParams.mClashSpeed;
            if (fr(Math.sqrt(this.mVel.x * this.mVel.x + this.mVel.z * this.mVel.z)) > this.mDeParams.mClashSpeed) burst = true;
            if (burst) { this.changePlayerDropping(S.JUMP_SHORT_BACK_DOWN, 0); return; }
        }
        const ang = dist === 0 ? this.mFaceAngle.y : matan(dz, dx);
        const np = { x: fr(t.x + thresh * JMASSin(ang)), y: this.pos.y, z: fr(t.z + thresh * JMASCos(ang)) };
        this.checkWallPlane(np, 60, this.unk15C);
        const [, g, legal] = this.checkGroundPlane(np.x, np.y, np.z);
        if (!legal) return;
        const d = new V3(np.x - this.pos.x, np.y - this.pos.y, np.z - this.pos.z);
        let step = fr(d.length());
        if (step > 0) { if (50 < step) step = 50; d.normalize(); this.pos.set(fr(this.pos.x + d.x * step), fr(this.pos.y + d.y * step), fr(this.pos.z + d.z * step)); }
        void g;
    }
    keepDistanceActor(a: HitActor, r: number) { this.keepDistance(a.pos, a.damageRadius, r); }
    checkDescent() {
        const sp = this.mHangingParams.mDescentSp;
        if (!this.canHang()) return;
        if (!(this.mForwardVel < sp)) return;
        const r = wallRecord(this.pos.x, fr(this.pos.y - 10), this.pos.z, sp, 1, 0);
        if (!this.isTouchedWallsAndMoveXZ(r)) return;
        const [fy, g] = this.checkGroundPlane(r.center[0], fr(this.pos.y + 30), r.center[2]);
        if (g.isIllegal()) return;
        if (!(this.pos.y - fy > 160)) return;
        const w = r.results[0];
        const wa = matan(w.n[2], w.n[0]);
        const d = s16(wa - this.mFaceAngle.y);
        if (d > -0x4000 && d < 0x4000) {
            const dist = fr(20 + sp);
            this.pos.x = fr(r.center[0] - dist * w.n[0]);
            this.pos.z = fr(r.center[2] - dist * w.n[2]);
            this.mFaceAngle.y = s16(wa + 0x8000);
            this.changePlayerStatus(S.DESCEND, 0, false);
            this.setAnimation(A.HGDWN, 1);
        }
    }
    checkGroundAtWalking(v: P3) {
        this.checkWallPlane(v, 30, fr(0.5 * this.unk15C));
        const wall = this.checkWallPlane(v, 60, this.unk15C);
        let fy: number, g: Bg;
        if (this.checkStatusType(0x10000)) [fy, g] = this.checkGround(v.x, fr(v.y + 30), v.z);
        else [fy, g] = this.checkGroundPlane(v.x, fr(v.y + 30), v.z);
        const [ry] = this.checkRoof(v.x, fr(this.pos.y + 80), v.z);
        this.mWallPlane = wall;
        if (g.isIllegal()) return 2;
        if (v.y + 160 >= ry) return 2;
        if (v.y > fy + 100) { this.pos.set(v.x, v.y, v.z); this.mGroundPlane = g; this.mFloorPosition.y = fy; return 0; }
        if (Math.abs(this.pos.y - fy) > 100000) this.pos.set(this.mPrevPosition);
        else { this.pos.set(v.x, fy, v.z); this.mGroundPlane = g; this.mFloorPosition.y = fy; }
        if (wall && !wall.isMarioThrough()) {
            const d = s16(matan(wall.n[2], wall.n[0]) - this.mFaceAngle.y);
            if (d >= 0x2AAA && d <= 0x5555) return 1;
            if (d <= -0x2AAA && d >= -0x5555) return 1;
            return 3;
        }
        return 1;
    }
    stopProcess() { this.setPlayerVelocity(0); this.mVel.y = 0; this.pos.y = this.mFloorPosition.y; this.mFaceAngle.x = 0; this.mModelFaceAngle = this.mFaceAngle.y; }
    waitProcess() {
        this.setPlayerVelocity(0);
        if (Math.abs(this.pos.y - this.mFloorPosition.y) > 100000) { this.pos.set(this.mPrevPosition); this.changePlayerStatus(S.ROCKET_LANDING, 0, false); }
        else this.pos.y = this.mFloorPosition.y;
        this.mFaceAngle.x = 0; this.mModelFaceAngle = this.mFaceAngle.y;
        return this.walkProcess();
    }
    walkProcess() {
        if (this.mGroundPlane.isIllegal()) return 2;
        const ny = this.mGroundPlane ? this.mGroundPlane.n[1] : 0;
        const next = { x: fr(this.pos.x + fr(this.mVel.x / 4) * ny), y: this.pos.y, z: fr(this.pos.z + fr(this.mVel.z / 4) * ny) };
        const r = this.checkGroundAtWalking(next);
        this.mFaceAngle.x = 0; this.mModelFaceAngle = this.mFaceAngle.y;
        return r === 3 ? 2 : r;
    }
    barProcess() {
        let result = 0;
        const h = this.holder!;
        const p = { x: h.pos.x, y: this.pos.y, z: h.pos.z };
        const w1 = this.checkWallPlane(p, 60, 43), w2 = this.checkWallPlane(p, 30, 24);
        const ok1 = !w1 || w1.isMarioThrough(), ok2 = !w2 || w2.isMarioThrough();
        if (ok1 && ok2) this.pos.set(h.pos.x, fr(h.pos.y + this.mHolderHeightDiff), h.pos.z);
        else this.pos.set(p.x, p.y, p.z);
        const [cy] = this.checkRoof(this.pos.x, fr(this.pos.y + 80), this.pos.z);
        if (this.pos.y > cy - 160) this.pos.y = fr(cy - 160);
        const [fy] = this.checkGroundPlane(this.pos.x, this.pos.y, this.pos.z);
        if (this.pos.y < fy) { this.pos.y = fy; this.changePlayerStatus(S.WAIT, 0, false); result = 1; }
        this.setPlayerVelocity(0); this.mFaceAngle.x = 0; this.mModelFaceAngle = this.mFaceAngle.y;
        return result;
    }
    hangonCheck(wall: Bg, prev: P3, curr: P3) {
        if (this.mVel.y > 0) return false;
        if ((curr.x - prev.x) * this.mVel.x + (curr.z - prev.z) * this.mVel.z > 0) return false;
        const nx = fr(curr.x - 60 * wall.n[0]), nz = fr(curr.z - 60 * wall.n[2]);
        const [ny, g] = this.checkGroundPlane(nx, fr(curr.y + 160), nz);
        if (ny - curr.y <= 100) return false;
        if (this.mFloorPosition.x < ny + 160) return false;
        if (bg.isUnk1(g)) return false;
        if (bg.isNoLedgeGrab(g)) return false;
        this.pos.set(nx, ny, nz);
        this.mGroundPlane = g; this.mFloorPosition.y = ny;
        this.mSlopeAngle = matan(g.n[2], g.n[0]);
        this.mFaceAngle.y = s16(matan(wall.n[2], wall.n[0]) + 0x8000);
        return true;
    }
    checkGroundAtJumping(target: P3, flags: number) {
        const p = { x: target.x, y: target.y, z: target.z };
        const w1 = this.checkWallPlane(p, 150, this.unk15C);
        const w2 = this.checkWallPlane(p, 30, this.unk15C);
        if (this.checkStatusType(0x10000)) { const [h, g] = this.checkGround(p.x, fr(p.y + 30), p.z); this.mFloorPosition.y = h; this.mGroundPlane = g; }
        else { const [h, g] = this.checkGroundPlane(p.x, fr(p.y + 30), p.z); this.mFloorPosition.y = h; this.mGroundPlane = g; }
        { const [h, r] = this.checkRoofPlane(p, this.pos.y + 80); this.mFloorPosition.x = h; this.mRoofPlane = r; }
        let gc = 7, wc = 7, rc = 7;
        this.pos.set(p.x, p.y, p.z);
        if (this.mGroundPlane.isIllegal()) { this.pos.set(this.mPrevPosition); gc = 2; }
        else {
            let pass = this.mGroundPlane.isMarioThrough();
            if (this.mStatus === S.HIP_DROP && bg.isGroundPoundToPassThrough(this.mGroundPlane)) pass = true;
            if (this.checkStatusType(0x10000) && this.mGroundPlane.isWaterSurface()) pass = false;
            if (!pass && p.y <= this.mFloorPosition.y) { this.pos.y = this.mFloorPosition.y; gc = 1; }
        }
        if (gc === 1) this.unkBC = this.mVel.y;
        if (this.mRoofPlane && !this.mRoofPlane.isMarioThrough()) {
            if (160 + p.y > this.mFloorPosition.x) {
                this.pos.y = fr(this.mFloorPosition.x - 160);
                if (this.mRoofPlane.actor) (this.mRoofPlane.actor as HitActor).receiveMessage(this, MSG.PUSH_UP);
                this.setPlayerVelocity(0);
                if (this.mVel.y >= 0) {
                    this.mVel.y = 0;
                    if (this.checkFlag(MF.VISIBLE)) this.onFlag(MF.UNK200);
                    rc = (flags & 2) && this.canHang() && bg.isFence(this.mRoofPlane) ? 4 : 0;
                }
            }
        }
        this.mWallPlane = null;
        const ok1 = !w1 || w1.isMarioThrough(), ok2 = !w2 || w2.isMarioThrough();
        if ((flags & 1) && ok1 && !ok2 && this.canHang()) {
            this.mWallPlane = w2;
            wc = this.hangonCheck(w2!, target, p) ? 3 : 0;
        } else if (!ok1 || !ok2) {
            this.mWallPlane = w1 ? w1 : w2;
            const d = s16(matan(this.mWallPlane!.n[2], this.mWallPlane!.n[0]) - (this.mFaceAngle.y + 0x8000));
            const m = this.mJumpParams.mClashAngle;
            if (-m < d && d < m) wc = 2;
        }
        if (gc !== 7) return gc;
        if (rc !== 7) return rc;
        if (wc !== 7) return wc;
        return 0;
    }
    isFallCancel() {
        if (!(this.unk78 & 0x100)) return false;
        if (this.mStatus & 0x21000) return false;
        return !(this.mInput & 0x80) && this.mVel.y > 20;
    }
    fallProcess() {
        if (this.mStatus === S.DIVE) { this.mVel.y = fr(this.mVel.y - this.mDivingParams.mGravity); if (this.mVel.y < -75) this.mVel.y = -75; }
        else {
            if (this.isFallCancel()) this.mVel.y = fr(this.mVel.y * 0.75);
            else if ((this.mStatus === S.LEFT_ROTATE_JUMP || this.mStatus === S.RIGHT_ROTATE_JUMP) && this.mVel.y < 0) this.mVel.y = fr(this.mVel.y - this.mJumpParams.mSpinJumpGravity);
            else this.mVel.y = fr(this.mVel.y - this.mJumpParams.mGravity);
        }
        if (this.mVel.y < -75) this.mVel.y = -75;
    }
    jumpProcess(flags: number) {
        let result = 0;
        const sp = fr(Math.sqrt(this.mVel.x * this.mVel.x + this.mVel.z * this.mVel.z));
        const max = this.mJumpParams.mJumpingMax;
        if (sp > max) { this.mVel.x = fr(this.mVel.x * fr(max / sp)); this.mVel.z = fr(this.mVel.z * fr(max / sp)); }
        const next = { x: fr(this.pos.x + 0.25 * this.mVel.x), y: fr(this.pos.y + 0.25 * this.mVel.y), z: fr(this.pos.z + 0.25 * this.mVel.z) };
        const r = this.checkGroundAtJumping(next, flags);
        if (r !== 0) result = r;
        if (this.mVel.y >= 0) this.unk104 = this.pos.y;
        this.fallProcess();
        if (this.mStatus !== S.JUMP_CATCH) this.mFaceAngle.x = 0;
        this.mModelFaceAngle = this.mFaceAngle.y;
        return result;
    }
}
export { JMASSin, JMASCos };
