// The last layer of TMario: Player/MarioAction.cpp (taking, putting, throwing), the part of
// MarioCollision.cpp a simulated Mario runs (decHP, dropObject, loserExec, floorDamageExec) and
// MarioDraw.cpp's model placement (calcBaseMtx, calcAnim's body, setPositions).

import { fr, s16, JMASSin, JMASCos, mtx, Mtx, V3 } from '../math.js';
import { HitActor, MSG } from '../engine.js';
import { MarioSpecial } from './special.js';
import { S, A, MF } from './base.js';

/** J3DGetTranslateRotateMtx (s16 angles: x, then y, then z, then the translation). */
export function j3dTRMtx(m: Mtx, rx: number, ry: number, rz: number, tx: number, ty: number, tz: number) {
    const sx = JMASSin(rx), cx = JMASCos(rx), sy = JMASSin(ry), cy = JMASCos(ry), sz = JMASSin(rz), cz = JMASCos(rz);
    m[0] = cy * cz; m[1] = sx * sy * cz - cx * sz; m[2] = cx * sy * cz + sx * sz; m[3] = tx;
    m[4] = cy * sz; m[5] = sx * sy * sz + cx * cz; m[6] = cx * sy * sz - sx * cz; m[7] = ty;
    m[8] = -sy; m[9] = sx * cy; m[10] = cx * cy; m[11] = tz;
}

export abstract class TMarioSim extends MarioSpecial {
    /** unk318: the sink / dive offset under the base matrix */
    unk318: Mtx = mtx();

    // ---------------------------------------------------------------- MarioAction.cpp
    taking() {
        if (this.mInput & 4) return this.changePlayerDropping(S.LANDING, 0);
        this.setAnimation(A.RAISE, 1);
        if (this.unk384 && this.mModel.fc[0].checkPass(11)) {
            if (this.unk384.receiveMessage(this, MSG.TAKE) === true) { this.startVoice(SE.MV15_EXERT_INST_01); this.mHeldObject = this.unk384; }
            else return this.changePlayerStatus(S.WAIT, 0, false);
            this.unk384 = null;
        }
        if (this.isLast1AnimeFrame()) {
            this.mUpperState = 2; // UPPER_STATE_HOLDING_OBJECT
            this.mPumpCooldown = 0;
            return this.changePlayerStatus(S.WAIT, 0, false);
        }
        this.waitProcess();
        return 0;
    }
    takePose() {
        if (this.mInput & 4) return this.changePlayerDropping(S.LANDING, 0);
        if (this.isLast1AnimeFrame()) { this.setAnimation(A.WAIT, 1); return this.changePlayerStatus(S.WAIT, 0, false); }
        this.stopCommon(A.GET_FAIL, S.WAIT);
        return 0;
    }
    catchLost() {
        if (this.mInput & 2) { if (this.considerRotateJumpStart()) return 1; return this.changePlayerJumping(S.JUMP, 0); }
        if (this.mInput & 4) return this.changePlayerStatus(S.LANDING, 0, false);
        if (this.mInput & 8) return this.changePlayerStatus(S.SLIP, 0, false);
        this.stopCommon(A.LOST, S.WAIT);
        return 0;
    }
    putting() {
        if (this.mInput & 4) return this.changePlayerDropping(S.LANDING, 0);
        this.stopCommon(A.PUT, S.WAIT);
        if (this.mHeldObject && this.mModel.fc[0].checkPass(20)) { this.mHeldObject.receiveMessage(this, MSG.PUT); this.mHeldObject = null; }
        return 0;
    }
    pitching() {
        if (this.mInput & 4) return this.changePlayerDropping(S.LANDING, 0);
        this.stopCommon(A.THROW, S.WAIT);
        this.checkThrowObject();
        return 0;
    }
    actnMain() {
        switch (this.mStatus) {
            case S.TAKE: return this.taking();
            case S.TAKE_POSE: return this.takePose();
            case S.CATCH_LOST: return this.catchLost();
            case S.PUTTING: return this.putting();
            case S.PITCHING: return this.pitching();
        }
        return 0;
    }

    // ---------------------------------------------------------------- MarioCollision.cpp
    decHP(hp: number) {
        if (this.isUnderWater() || this.checkFlag(MF.HELMET_FLW_CAMERA)) {
            this.mAir -= hp;
            if (this.mAir < 1) { this.loserExec(); this.changePlayerStatus(S.SWIM_DOWN, 0, true); }
            return;
        }
        this.mHealth -= hp;
        if (0 >= this.mHealth) { this.mHealth = 0; this.loserExec(); }
    }
    dropObject() {
        if (this.mHeldObject) { (this.mHeldObject as HitActor).receiveMessage(this, MSG.THROWN); this.mHeldObject = null; }
    }
    loserExec() {
        if (this.mStatus !== S.SWIM_DOWN && this.mStatus !== S.ELEC_DOWN && this.mStatus !== S.SWIM_P_DOWN && this.mStatus !== S.DOWN_LOSER) {
            this.onFlag(MF.GAME_OVER);
            this.mHealth = 0;
            if (this.checkStatusType(S.FLAG_SWIMMING)) {
                this.changePlayerStatus(this.mAir < 1 ? S.SWIM_DOWN : S.SWIM_P_DOWN, 0, true);
                return;
            }
            this.changePlayerStatus(this.mStatus === S.ELECTRIC_DAMAGE ? S.ELEC_DOWN : S.DOWN_LOSER, 0, true);
        }
    }
    /** mFloorHitActor: the actor a floor's damage comes from (in front of him) */
    mFloorHitActor = new HitActor('床ダメージ');
    floorDamageExec(damage: number, downType: number, waterEmit: number, motor: number) {
        if (this.isInvincible()) return;
        this.mFloorHitActor.pos.x = fr(this.pos.x + JMASSin(this.mFaceAngle.y));
        this.mFloorHitActor.pos.z = fr(this.pos.z + JMASCos(this.mFaceAngle.y));
        this.damageExec(this.mFloorHitActor, damage, downType, waterEmit, 16, motor, 0, 60);
    }

    // ---------------------------------------------------------------- MarioDraw.cpp
    /** initModel's joint indices (from the body model, ma_mdl1.bmd) */
    initJointIds() {
        const j = (n: string) => this.mModel.jointIndex(n);
        this.mJointIdCenter = j('center'); this.mJointIdChnChest = j('chn_chest'); this.mJointIdChest = j('jnt_chest');
        this.mJointIdArmR1 = j('jnt_arm_R1'); this.mJointIdArmL1 = j('jnt_arm_L1'); this.mJointIdHandR = j('jnt_hand_R'); this.mJointIdHandL = j('jnt_hand_L');
        this.mJointIdChnFootR = j('chn_foot_R'); this.mJointIdFootR = j('jnt_foot_R'); this.mJointIdChnFootL = j('chn_foot_L'); this.mJointIdFootL = j('jnt_foot_L');
        this.mJointIdHead = j('jnt_head'); this.mJointIdMHead = j('M_head');
    }
    private static trans(m: Float32Array | number[] | null, out: V3) { if (m) out.set(m[12], m[13], m[14]); }
    setPositions() {
        TMarioSim.trans(this.mModel.anmMtx(1) as any, this.unk160);
        this.mHeadPos.set(this.mHeadMtx[3], this.mHeadMtx[7], this.mHeadMtx[11]);
        TMarioSim.trans(this.mModel.anmMtx(this.mJointIdCenter) as any, this.mCenterPos);
        TMarioSim.trans(this.mModel.anmMtx(this.mJointIdHandR) as any, this.mRightHandPos);
    }
    getTakingMtx(): Mtx | null {
        const m = this.mModel.anmMtx(this.mJointIdHandR);
        if (!m) return null;
        const r = mtx();
        r[0] = m[0]; r[1] = m[4]; r[2] = m[8]; r[3] = m[12];
        r[4] = m[1]; r[5] = m[5]; r[6] = m[9]; r[7] = m[13];
        r[8] = m[2]; r[9] = m[6]; r[10] = m[10]; r[11] = m[14];
        return r;
    }
    calcBaseMtxSwim(m: Mtx) {
        // + gpMapObjWave->getHeight(x, water, z) - water: the waves aren't simulated (no offset)
        j3dTRMtx(m, 0, this.mModelFaceAngle, 0, this.pos.x, this.pos.y, this.pos.z);
    }
    calcBaseMtx(m: Mtx) {
        // (TOROCCO and the pole statuses (0x100000): a simulated Mario doesn't reach them)
        if (this.checkStatusType(S.FLAG_SWIMMING)) { this.calcBaseMtxSwim(m); return; }
        else {
            const h = this.holder as any;
            const hm = h && h.getTakingMtx ? h.getTakingMtx() : null;
            if (hm) { m.set(hm); return; }
            if (this.mStatus !== S.JUMP_CATCH && this.mStatus !== S.WIRE_ROLLING) this.mFaceAngle.x = 0;
            if (this.checkUnk114(8)) {
                const P = [0x2AAA, 0x8000, 0xD555].map((o) => {
                    const a = s16(this.mFaceAngle.y + o);
                    const x = fr(fr(JMASSin(a) * 40) + this.pos.x), z = fr(fr(JMASCos(a) * 40) + this.pos.z);
                    let [y] = this.checkGroundPlane(x, fr(this.pos.y + 160), z);
                    if (fr(y - this.pos.y) < -120) y = this.pos.y;
                    return new V3(x, y, z);
                });
                const [p1, p2, p3] = P;
                const avgY = fr((p1.y + p2.y + p3.y) / 3);
                const fwd = new V3(JMASSin(this.mFaceAngle.y), 0, JMASCos(this.mFaceAngle.y));
                const v1 = V3.sub(p2, p1), v2 = V3.sub(p3, p2);
                // cross2(v2, v1): v1 x v2
                const c = new V3(v1.y * v2.z - v1.z * v2.y, v1.z * v2.x - v1.x * v2.z, v1.x * v2.y - v1.y * v2.x).normalize();
                const nc = new V3(-c.x, -c.y, -c.z);
                const axis = new V3().cross(nc, fwd).normalize();
                const bin = new V3().cross(axis, nc);
                nc.normalize();
                m[0] = axis.x; m[1] = nc.x; m[2] = bin.x; m[3] = this.pos.x;
                m[4] = axis.y; m[5] = nc.y; m[6] = bin.y; m[7] = avgY < this.pos.y ? this.pos.y : avgY;
                m[8] = axis.z; m[9] = nc.z; m[10] = bin.z; m[11] = this.pos.z;
            } else j3dTRMtx(m, this.mFaceAngle.x, this.mModelFaceAngle, this.mFaceAngle.z, this.pos.x, this.pos.y, this.pos.z);
            // (surfing's pitch and roll (0x10000): not reached)
        }
        // unk318: sinking into goop, the dive offset
        let ty = 0;
        if (this.isSinking()) ty = fr(-(this.mSinkTimer / this.mGraffitoParams.mSinkTime) * this.mGraffitoParams.mSinkHeight);
        if (this.unk378 < 0) ty = this.unk378;
        const U = this.unk318; U.set(mtx()); U[7] = ty;
        // MTXConcat(m, unk318, m): a translation in the base's frame
        m[3] += m[1] * ty; m[7] += m[5] * ty; m[11] += m[9] * ty;
    }
    /** calcAnim's body: calcBaseMtx into the model's base TR, then M3UModelMario::perform(CALC_ANIM) (frames, then the joints). */
    calcAnim() {
        this.calcBaseMtx(this.mModel.baseTR);
        this.mModel.update();
        this.mModel.calc();
        this.mModel.fc[2].update();
    }
}
