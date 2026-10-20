// Corona Mountain's boss arena (stage coronaBoss): Bowser's hot tub (MoveBG/MapObjCorona.cpp's
// TBathtub, TBathtubGrip and the grip parts). The tub is a rigid body: its posture is a quaternion
// (unk1D8) turned by an angular velocity (unk1E8) that Bowser's weight (tumble), Mario's (liftMario,
// while the tub is "released" after a hip drop or a quake) and a spring back to upright (rebound,
// once the release count unk250 runs out, fading in over the recover count unk258 / unk25C) push,
// limited to maxAngle degrees. Its floor is 30 collision slices of a ring (bath_col_inside1..6, six
// shapes round the ring five times): only the two under Mario are put in, turned with the tub.
//
// Five grips (the "stand_break" platforms round the rim, 72 degrees apart) ride the tub: each has
// 17 unbreakable collision parts (c1..c17) and 5 weak spots (b1..b5), each part a TLiveActor of its
// own that passes Mario's hits on to the grip (a super hip drop on a hard part counts as a hip
// drop). A ground pound on a weak spot starts the grip breaking (startBreak: its stand_break BCK,
// slower or faster by how many are already gone) and quakes the tub (Bowser falls over, Mario is
// thrown up); with four gone, the last one starts the ending demo (startDemo: the tub overturns,
// Mario is taken, Bowser falls). The tub also answers Bowser and Bowser Jr: where its grips and
// junctures are (getNearGrip / getNextGrip / getNextJuncture), whether Bowser's tumble works
// (allowsTumble), how many Bullet Bills Jr may launch (getNumKillerLaunchable / Burstable).
//
// Bowser (TKoopa, "クッパ") and the Bullet Bill manager are found by name at run time and typed
// loosely here (KoopaLike, KillerManagerLike) so this file doesn't import their ports.
//
// Not here: the shine model the tub carries (unk29C: drawing only) and the grips' crack effect
// model (unk25C, stand_effect: drawing only; its end only stops its own perform), the particles
// (told as world events), the help balloons (showMessage / unk2A0), the rumble, the BGM, the demo
// camera and streaming movie, getModel()->calc() (the joints are worked out when asked).

import { fr, V3, Mtx, mtx, Quat, matan, MsMtxSetRotRPH, JMASSin, JMASCos, s16 } from '../math.js';
import { World, Stream, HitActor, LiveActor, TakeActor, LF, MSG, ANM_BCK, ANM_FRAME_RATE, readParams, PSchema } from '../engine.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import type { mat4 } from 'gl-matrix';
import { MapObjBase, MOF } from './base.js';
import { ObjCollision, KIND_MOVE } from './objcol.js';
import { MTXConcat, marioStatus } from './lib.js';
import { quatRotate } from '../enemies/animal.js';

const PI = 3.1415927;

/** TBathtubParams (/MapObj/bathtub.prm) */
export const BATHTUB_PARAMS = {
    resetGrip: ['u8', 0], trampleRelease: ['i', 10], trampleRecover: ['i', 10], quakeRelease: ['i', 500], quakeRecover: ['i', 500],
    hipdropRelease: ['i', 35], hipdropRecover: ['i', 35], breakCount0: ['i', 750], breakCount1: ['i', 710], breakCount2: ['i', 685],
    breakCount3: ['i', 655], launchStopCount: ['i', 1000], animSpeed0: ['f', 0.15], animSpeed1: ['f', 0.15], animSpeed2: ['f', 0.15],
    animSpeed3: ['f', 0.15], animSpeed4: ['f', 0.22], shake: ['f', 0], watermark: ['f', 0.3], maxAngle: ['f', 35], angleVelDamp: ['f', 0.93],
    rebound: ['f', 0.0005], shakeDamp: ['f', 0.93], marioWeight: ['f', 0.01], marioDropWeight: ['f', 5], outerHeight: ['f', 20],
} satisfies PSchema;
export type BathtubParams = { [K in keyof typeof BATHTUB_PARAMS]: number };

/** TKoopa (Bowser, "クッパ"): the members the tub calls. */
export interface KoopaLike {
    /** TKoopa::stagger(bool) */
    stagger(b: boolean): void;
    /** TKoopa::getDown() */
    getDown(): void;
    /** TKoopa::fall() */
    fall(): void;
    /** TKoopa::effectsTumble() const */
    effectsTumble(): boolean;
    /** TKoopa::allowsLaunch() const */
    allowsLaunch(): boolean;
}
/** TBathtubKillerManager ("バスタブキラーマネージャー"): what allowsTumble asks. */
export interface KillerManagerLike { countActiveKillers(): number; }

/** A joint's world matrix (gl-matrix column-major) as the game's row-major 3x4. */
function m4ToMtx(w: mat4): Mtx {
    const m = mtx();
    m[0] = w[0]; m[1] = w[4]; m[2] = w[8]; m[3] = w[12];
    m[4] = w[1]; m[5] = w[5]; m[6] = w[9]; m[7] = w[13];
    m[8] = w[2]; m[9] = w[6]; m[10] = w[10]; m[11] = w[14];
    return m;
}
/** MsWrapFmodf */
export const MsWrapFmodf = (v: number, lo: number, hi: number) => fr(lo + fr(fr(fr(hi - lo) + fr(v - lo)) % fr(hi - lo)));
/** TQuat4::getYDir */
const quatYDir = (q: Quat, out = new V3()) => out.set(fr(q.x * q.y * 2 - q.w * q.z * 2), fr(1 - q.x * q.x * 2 - q.z * q.z * 2), fr(q.y * q.z * 2 + q.w * q.x * 2));
/** TMatrix33::mult (r: a 3x4 whose rotation is the matrix) */
const mult33 = (r: Mtx, v: V3, out = new V3()) => out.set(fr(r[0] * v.x + r[1] * v.y + r[2] * v.z), fr(r[4] * v.x + r[5] * v.y + r[6] * v.z), fr(r[8] * v.x + r[9] * v.y + r[10] * v.z));
const isZero = (v: V3) => v.x * v.x + v.y * v.y + v.z * v.z <= 3.8146973e-6;

/** QuatRotate: q turned by the angular velocity w (q += 0.5 (w, 0) q, normalised). */
function QuatRotate(q: Quat, w: V3) {
    const dq = new Quat(fr(0.5 * w.x), fr(0.5 * w.y), fr(0.5 * w.z), 0);
    dq.mul(dq, q);
    q.x = fr(q.x + dq.x); q.y = fr(q.y + dq.y); q.z = fr(q.z + dq.z); q.w = fr(q.w + dq.w);
    q.normalize();
}
/** getDir(mtx, pos): the degrees round the matrix's Y axis to pos (from its Z axis). */
function getDir(m: Mtx, pos: V3) {
    const d = new V3(fr(pos.x - m[3]), fr(pos.y - m[7]), fr(pos.z - m[11]));
    const localZ = m[2] * d.x + m[6] * d.y + m[10] * d.z, localX = m[0] * d.x + m[4] * d.y + m[8] * d.z;
    return fr((360 / 65536) * matan(fr(localZ), fr(localX)));
}
/** getDir(mtx, pos, direction): the same for pos moved along direction's part tangent to the ring. */
function getDir2(m: Mtx, pos: V3, dir: V3) {
    const d = new V3(fr(pos.x - m[3]), fr(pos.y - m[7]), fr(pos.z - m[11]));
    const n = d.clone().normalize();
    const k = -n.dot(dir);
    const t = new V3(fr(dir.x + n.x * k), fr(dir.y + n.y * k), fr(dir.z + n.z * k));
    d.add(t);
    const localZ = m[2] * d.x + m[6] * d.y + m[10] * d.z, localX = m[0] * d.x + m[4] * d.y + m[8] * d.z;
    return fr((360 / 65536) * matan(fr(localZ), fr(localX)));
}

/** TBathtubData (Map/BathWaterManager.hpp): what the bath water and its riders read off the tub. */
export class BathtubData {
    mPos = new V3();
    /** the tub's up (tilted by maxAngle while Bowser tumbles it) */
    unk0C = new V3(0, 1, 0);
    /** the tub's rotation (a 3x4, translation unused) */
    unk18: Mtx = mtx();
    /** its radius, unk40, the water's depth below mPos, the outer height */
    unk3C = 0; unk40 = 0; unk44 = 0; unk48 = 0; unk4C = 0; unk50 = 0; unk54 = 0;
    unk58 = new V3();
    /** the water sloshes (released past half), the demo */
    unk64 = false; unk65 = 0;
    /** getThing (fabricated name): the water's centre */
    getThing() { return new V3(this.mPos.x, fr(this.mPos.y - this.unk44), this.mPos.z); }
}

// ---------------------------------------------------------------- TBathtub
export class Bathtub extends MapObjBase {
    /** unk13C the junctures' and unk150 the grips' angles round the tub (degrees) */
    unk13C: number[] = [0, 0, 0, 0, 0]; unk150: number[] = [0, 0, 0, 0, 0];
    /** unk164 the 30 floor slices, unk168 the five grips, unk16C the parameters */
    unk164: ObjCollision[] | null = null; unk168: BathtubGrip[] = []; unk16C: BathtubParams;
    mBathtubData = new BathtubData();
    /** unk1D8 the posture, unk1E8 its angular velocity, unk1F4 the water's centre, unk200 the shine's place */
    unk1D8 = new Quat(0, 0, 0, 1); unk1E8 = new V3(); unk1F4 = new V3(); unk200 = new V3();
    unk23C = 0; unk240 = 0; unk244 = 0;
    /** unk248 the frames Bullet Bills may not attack (after a quake), unk24C the frames the quake tilts it */
    unk248 = 0; unk24C = 0;
    /** unk250 the release count (Mario's weight tips it, no spring), unk254 its start, unk258 / unk25C the recover count and its start */
    unk250 = 0; unk254 = 1; unk258 = 0; unk25C = 1;
    mMarioJntIdx = -1; mStarJntIdx = -1; mShineBodyJntIdx = -1; mSubmarineJntIdx = -1; mDuckJntIdx = -1; mJuniorJntIdx = -1; mKoopaJntIdx = -1;
    mWaterJntIdx: number[] = [-1, -1, -1, -1, -1];
    unk290 = 0; unk294 = 0;
    unk298 = 0; unk299 = 0;
    /** the ending demo is on */
    unk29A = 0;
    unk2A0 = 0;
    private joints: mat4[] | null = null;

    constructor(w: World, name = 'バスタブ') {
        super(w, name);
        this.unk16C = readParams('/MapObj/bathtub.prm', w.files, BATHTUB_PARAMS);
    }
    private koopa() { return this.world.search('クッパ') as unknown as KoopaLike | null; }
    /** getModel()->getAnmMtx(j) */
    anmMtx(j: number): Mtx | null {
        if (!this.mactor || j < 0) return null;
        if (!this.joints) this.joints = this.mactor.anmMtxAll(this.baseTR, this.scale);
        return this.joints && this.joints[j] ? m4ToMtx(this.joints[j]) : null;
    }

    load(s: Stream) {
        this.unk24C = 0;
        super.load(s);
        this.pos.set(this.initialPos);
        this.unk164 = [];
        const inside = ['inside3', 'inside2', 'inside1', 'inside6', 'inside5', 'inside4'];
        for (let i = 0; i < 30; ++i) {
            const c = new ObjCollision(this.world, KIND_MOVE, this);
            c.init(`mapObj/bath_col_${inside[i % 6]}.col`, 0);
            c.setUp();
            this.unk164.push(c);
        }
        const D = this.mBathtubData;
        D.mPos.set(this.initialPos);
        D.unk18 = mtx();
        D.unk3C = 3000; D.unk40 = 3600;
        D.unk44 = fr(D.unk3C * fr(Math.sin(fr(0.27925268))));
        D.unk4C = D.unk50 = D.unk54 = 0;
        D.unk58.zero();
        D.unk48 = 100;
        D.unk64 = false;
        D.unk0C.set(0, 1, 0);
        this.unk168 = [];
        for (let i = 0; i < 5; ++i) {
            const offset = fr(fr(fr(360 * fr(0.5 + i)) / 5) - 180);
            const g = new BathtubGrip(this.world, this, offset);
            this.unk168[i % 5] = g;
            g.appear();
            this.unk13C[i] = fr(-180 + fr(fr(360 * fr(0.5 + i)) / 5));
            this.unk150[i] = fr(-180 + fr((360 * i) / 5));
        }
        const a = this.mactor;
        const j = (n: string) => (a ? a.jointIndex(n) : -1);
        this.mMarioJntIdx = j('mario'); this.mStarJntIdx = j('star');
        this.mWaterJntIdx = [j('water4'), j('water5'), j('water1'), j('water2'), j('water3')];
        this.mDuckJntIdx = j('ahiru'); this.mSubmarineJntIdx = j('submarin'); this.mJuniorJntIdx = j('Jr'); this.mKoopaJntIdx = j('koopa');
        this.unk298 = 1;
    }

    /** hipdrop: Mario ground-pounded it (not while released): released for hipdropRelease, Bowser staggers. */
    hipdrop(_p: V3) {
        if (this.unk29A !== 0) return;
        const P = this.unk16C;
        if (this.unk250 > P.hipdropRelease) return;
        // (the direction from the tub to p is worked out and not used)
        this.unk250 = P.hipdropRelease; this.unk258 = P.hipdropRecover; this.unk25C = P.hipdropRecover; this.unk254 = P.hipdropRelease;
        const k = this.koopa();
        if (k) k.stagger(false);
    }
    /** quake: a grip broke: tilted for 300 frames, released, no Bullet Bills for launchStopCount, Mario thrown up, Bowser down. */
    quake(_p: V3) {
        if (this.unk29A !== 0) return;
        const P = this.unk16C;
        this.unk24C = 300;
        this.unk250 = P.quakeRelease; this.unk258 = P.quakeRecover; this.unk25C = P.quakeRecover; this.unk254 = P.hipdropRelease;
        this.unk248 = P.launchStopCount;
        const k = this.koopa();
        this.world.events.push({ t: this.world.tickCount, kind: 'cameraShake', data: { mode: 25, power: 1, p: this.pos.clone() } });
        this.world.events.push({ t: this.world.tickCount, kind: 'cameraShake', data: { mode: 26, power: 1, p: this.pos.clone() } });
        const m = this.world.mario as any;
        if (typeof m.throwMario === 'function') m.throwMario(new V3(0, 1, 0), 10);   // SMS_ThrowMario
        if (k) k.getDown();
    }
    getNumGripsDead() { let n = 0; for (let i = 0; i < 5; i++) if (!this.unk168[i].unk249) n++; return n; }
    trample(_p: V3) {
        if (this.unk29A !== 0) return;
        const P = this.unk16C;
        if (this.unk250 <= P.trampleRelease) {
            this.unk250 = P.trampleRelease; this.unk258 = P.trampleRecover; this.unk25C = P.trampleRecover; this.unk254 = P.hipdropRelease;
        }
    }
    /** liftMario: Mario's weight at p tips the tub (more while released). */
    liftMario(p: V3) {
        const P = this.unk16C;
        let weight = P.marioWeight;
        if (this.unk250 > 0) weight = fr(weight + P.marioDropWeight);
        if (weight <= 1e-10) return;
        const lever = V3.sub(p, this.pos);
        const torque = new V3().cross(lever, new V3(0, -1, 0)).fround();
        torque.scale(fr(1e-8 * weight));
        this.unk1E8.add(torque);
    }
    /** tumble(yaw, weight): Bowser's stomp at his yaw tips it. */
    tumble(yaw: number, weight: number) {
        if (this.unk29A !== 0) return;
        const a = s16(fr(yaw * fr(65536 / 360)));
        weight = fr(weight * fr(0.0001));
        this.unk1E8.add(new V3(fr(weight * JMASCos(a)), 0, fr(weight * -JMASSin(a))));
    }
    getTakingMtx(): Mtx | null { return this.anmMtx(this.mMarioJntIdx); }
    getShineMtx() { return this.anmMtx(this.mStarJntIdx); }
    getWaterMtx(i: number) { return this.anmMtx(this.mWaterJntIdx[i]); }
    getSubmarineMtxInDemo() { return this.anmMtx(this.mSubmarineJntIdx); }
    getPeachMtxInDemo() { return this.anmMtx(this.mDuckJntIdx); }
    getKoopaMtxInDemo(): Mtx | null { return null; }
    getKoopaJrMtxInDemo() { return this.anmMtx(this.mJuniorJntIdx); }
    getBathtubData() { return this.mBathtubData; }

    receiveMessage(_sender: HitActor, msg: number): boolean {
        switch (msg) {
            case MSG.HIP_DROP: this.hipdrop(this.world.mario.pos); return true;
            case MSG.SUPER_HIP_DROP: this.hipdrop(this.world.mario.pos); return true;
            case MSG.TRAMPLE: this.trample(this.world.mario.pos); return true;
        }
        return false;
    }
    getRootJointMtx(): Mtx {
        if (this.unk29A !== 0) return this.anmMtx(0) || this.baseTR;
        return this.baseTR;
    }
    perform(cue: number) {
        super.perform(cue);
        this.joints = null;
        // (the shine model, the help balloons by getNumGripsDead and mMoveTickCount: drawing / 2D only)
    }
    /** the ending demo: Mario held by the "mario" joint while the overturn BCKs play */
    private takeMario() {
        const m = this.world.mario as any;
        if (m.receiveMessage(this, MSG.TAKE)) this.held = m as TakeActor;
        if (m.mFaceAngle) m.mFaceAngle.y = 0x7FFF;
    }
    control() {
        if (this.unk29A !== 0) {
            if (this.mactor && this.mactor.curAnmEndsNext(ANM_BCK)) {
                switch (this.unk294++) {
                    case 0: this.startBck('bath_overturn2'); break;
                    case 1: this.startBck('bath_overturn3'); break;
                }
            }
            // (the shine's particles: PARTICLE_MS_SHINE_SENKO / KIRA)
            const sm = this.getShineMtx();
            if (sm) { this.unk200.set(sm[3], sm[7], sm[11]); this.world.sound(SE.SHINE_EXIST, this.unk200); }
            this.calcRootMatrix();
            this.calcBathtubData();
            this.removeCollisions_();
            this.takeMario();
            if (this.unk290 > 0) --this.unk290;
            return;
        }
        if (this.unk24C > 0) --this.unk24C;
        if (this.unk248 > 0) --this.unk248;
        if (this.unk250 > this.unk16C.hipdropRelease || (this.marioIsOn() && this.held === null)) this.liftMario(this.world.mario.pos);
        this.updatePosture_();
        this.calcRootMatrix();
        super.control();
        this.calcBathtubData();
        const D = this.mBathtubData;
        const up = new V3(D.unk18[4], D.unk18[5], D.unk18[6]);
        if (D.unk0C.dot(up) > 0.995) this.emit('ms_lkp_yuge1', this.unk1F4);
        for (let i = 0; i < 5; ++i) {
            if (this.unk168[i].unk248 !== 0) { const m = this.getWaterMtx(i); if (m) this.emit('ms_kp_funsui', new V3(m[3], m[7], m[11])); }
        }
        if (this.held === null) this.setupCollisions_();
        else this.removeCollisions_();
    }
    calcBathtubData() {
        const m = this.getRootJointMtx(), D = this.mBathtubData, P = this.unk16C;
        const R = D.unk18;
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) R[r * 4 + c] = m[r * 4 + c];
        D.mPos.set(m[3], m[7], m[11]);
        const upY = R[5];
        const tilt = fr(Math.sqrt(fr(1 - fr(upY * upY))));
        const depth = P.watermark >= tilt ? P.watermark : tilt;
        D.unk44 = fr(D.unk3C * depth);
        D.unk48 = P.outerHeight;
        D.unk0C.set(R[1], R[5], R[9]);
        D.unk58.zero();
        const k = this.koopa();
        if ((k && k.effectsTumble()) || this.unk24C > 0) {
            const axis = new V3().cross(new V3(0, 1, 0), D.unk0C).fround().normalize();
            if (!isZero(axis)) {
                const q = new Quat().setRotateAxis(axis, fr(fr(P.maxAngle * fr(2 * PI)) / 360));
                quatRotate(q, D.unk0C, D.unk0C).fround();
                D.unk58.set(0, P.shake, 0);
            }
        } else D.unk0C.set(0, 1, 0);
        D.unk64 = this.unk250 < Math.trunc(this.unk254 / 2) && this.unk258 > 0;
        D.unk65 = this.unk29A;
        this.unk1F4 = D.getThing();
    }
    /** setupCollisions_: the two floor slices under Mario put in (the others out); the grip on his side gets its collision. */
    setupCollisions_() {
        const D = this.mBathtubData, mp = this.world.mario.pos;
        const local = mult33(D.unk18, V3.sub(mp, D.mPos));
        if (mp.y < 300 || local.x * local.x + local.z * local.z < 0.01) {
            this.removeCollisions_();
            for (let i = 0; i < 5; ++i) this.unk168[i].unk24B = 0;
            return;
        }
        let angle = fr(Math.atan2(local.x, local.z));
        if (angle < 0) angle = fr(angle + fr(2 * PI));
        let segment = fr(angle * fr(30 / fr(2 * PI)));
        if (segment < 0) segment = fr(segment + 30);
        const first = (Math.trunc(fr(fr(segment + 0.5) - 1)) + 30) % 30;
        let i: number;
        for (i = 0; i < 2; ++i) {
            const index = (i + first) % 30;
            const a = fr(fr(fr((index + 1) * fr(2 * PI)) / 30) - PI);
            const s = fr(Math.sin(a)), c = fr(Math.cos(a));
            const rot = mtx(); rot[0] = c; rot[2] = s; rot[8] = -s; rot[10] = c;
            const m = MTXConcat(this.baseTR, rot, mtx());
            this.unk164![index].moveMtx(m);
            this.unk164![index].setUp();
        }
        for (; i < 30; ++i) this.unk164![(i + first) % 30].remove();
        for (let k = 0; k < 5; ++k) this.unk168[k].unk24B = 0;
        this.unk168[(Math.trunc(fr(fr(5 * angle) / fr(2 * PI))) + 10) % 5].unk24B = 1;
    }
    /** startDemo: the last grip broke: every grip gone (the middle one breaking again for show), the overturn, Mario taken, Bowser falls. */
    startDemo() {
        if (this.unk29A !== 0) return;
        this.unk290 = 10;
        for (let i = 0; i < 5; ++i) this.unk168[i].kill();
        this.unk168[2].reset();
        this.unk168[2].startBreak(0, 2, this.unk16C.animSpeed1);
        this.onMapObjFlag(MOF.UNK8);
        this.offMapObjFlag(MOF.NO_ANIMATIONS);
        this.startBck('bath_overturn1');
        this.takeMario();
        // (fireStartDemoCamera("koopa_last2"), fireStreamingMovie(14))
        const k = this.koopa();
        if (k) k.fall();
        this.unk29A = 1;
    }
    removeCollisions_() { if (this.unk164) for (let i = 0; i < 30; ++i) this.unk164[i].remove(); }
    /** allowsTumble: Bowser's tumble works on Mario near a grip, out at the rim, the tub level, Mario not pounding or rocketing, no Bullet Bills. */
    allowsTumble() {
        const mp = this.world.mario.pos.clone();
        if (this.getNearGrip(mp, 18) === null) return false;
        const D = this.mBathtubData;
        const local = mult33(D.unk18, V3.sub(mp, D.mPos));
        local.y = 0;
        const dist = fr(local.length());
        if (dist < 4200) return false;
        if (!(4700 < dist)) return true;
        if (!(D.unk18[5] > 0.99)) return false;
        const mgr = this.world.search('バスタブキラーマネージャー') as unknown as KillerManagerLike | null;
        const st = marioStatus(this.world);
        if (st === 0x8008A9 || st === 0x88B || st === 0x88D) return false;   // (HIP_DROP, ROCKET, ROCKET_LANDING)
        const g = (this.world.mario as any).mWaterGun;
        if (g) {
            const n = g.getCurrentNozzle ? g.getCurrentNozzle() : null;
            if (n && n.getNozzleKind() === 1 && n.mInsidePressure > 0) return false;   // (TWaterGun::Rocket)
        }
        return mgr ? mgr.countActiveKillers() === 0 : true;
    }
    calcRootMatrix() {
        if (this.unk29A !== 0) {
            MsMtxSetRotRPH(this.baseTR, 0, this.rot.y, 0);
            this.baseTR[3] = this.pos.x; this.baseTR[7] = this.pos.y; this.baseTR[11] = this.pos.z;
        } else this.unk1D8.toMtx(this.baseTR, this.pos);
        this.anmMtx0 = null;
        this.joints = null;
    }
    /** getNearGrip: the grip angle within maxDiff degrees of p (null: none) */
    getNearGrip(p: V3, maxDiff: number): number | null {
        const angle = getDir(this.getRootJointMtx(), p);
        let best = 360, index = 0;
        for (let i = 0; i < 5; i++) {
            const d = Math.abs(MsWrapFmodf(this.unk150[i] - angle, -180, 180));
            if (d < best) { index = i; best = d; }
        }
        return best < maxDiff ? this.unk150[index] : null;
    }
    getNearJuncture(_p: V3) { return 0; }
    getNextJuncture(p: V3, dir: V3) {
        const angle = getDir2(this.getRootJointMtx(), p, dir);
        let best = 360, index = 0;
        for (let i = 0; i < 5; ++i) {
            const d = Math.abs(MsWrapFmodf(this.unk13C[i] - angle, -180, 180));
            if (d < best) { index = i; best = d; }
        }
        return this.unk13C[index];
    }
    /** getNextGrip: the grip angle within maxDiff degrees of where p heads along dir (null: none) */
    getNextGrip(p: V3, dir: V3, maxDiff: number): number | null {
        const angle = getDir2(this.getRootJointMtx(), p, dir);
        let best = 360, index = 0;
        for (let i = 0; i < 5; ++i) {
            const d = Math.abs(MsWrapFmodf(this.unk150[i] - angle, -180, 180));
            if (d < best) { index = i; best = d; }
        }
        return best < maxDiff ? this.unk150[index] : null;
    }
    /** updatePosture_: the spring back to upright (once released no more), the turn, the tilt limit. */
    updatePosture_() {
        const y = new V3(0, 1, 0), P = this.unk16C;
        if (this.unk250 === 0) {
            let rate: number;
            if (this.unk258 === 0) rate = 1;
            else { this.unk258--; rate = fr(1 - fr(this.unk258 / this.unk25C)); }
            const up = quatYDir(this.unk1D8);
            const axis = new V3().cross(y, up).fround().normalize();
            axis.scale(fr(P.rebound * fr(rate * -fr(Math.acos(y.dot(up))))));
            const d = P.angleVelDamp, v = this.unk1E8;
            v.set(fr(axis.x + v.x * d), fr(axis.y + v.y * d), fr(axis.z + v.z * d));
        } else this.unk250--;
        QuatRotate(this.unk1D8, this.unk1E8);
        const up = quatYDir(this.unk1D8);
        const angle = fr(Math.acos(y.dot(up)));
        const maxAngle = fr(P.maxAngle * (Math.PI / fr(180)));
        const excess = fr(angle - maxAngle);
        if (excess > 0) {
            const limit = new Quat().setRotateFromTo(up, y, fr(excess / angle));
            this.unk1D8.mul(limit, this.unk1D8);
        }
        this.unk1D8.normalize();
    }
    isKillerLaunchable() {
        if (this.unk29A !== 0) return false;
        const k = this.koopa();
        if (k && !k.allowsLaunch()) return false;
        return this.isKillerAttackable();
    }
    getNumKillerLaunchable() {
        if (!this.isKillerLaunchable()) return 0;
        let n = this.getNumGripsDead() + 1;
        if (n < 2) n = 2;
        if (n > 4) n = 4;
        return n;
    }
    isKillerAttackable() { return this.unk248 <= 0; }
    isBreaking() { return false; }
    getNumKillerBurstable() {
        if (!this.isKillerLaunchable()) return 0;
        const n = this.getNumGripsDead();
        if (n >= 4) return 8;
        if (!this.allowsTumble() && this.unk250 === 0 && this.unk258 === 0) {
            switch (n) { case 1: return 4; case 2: return 6; case 3: return 8; case 4: return 8; }
        }
        return 0;
    }
}

// ---------------------------------------------------------------- the grip parts
/** TBathtubGripParts: one of a grip's collision parts (its joint's matrix), passing hits on. */
export class BathtubGripParts extends LiveActor {
    constructor(w: World, name: string, public unkF4: BathtubGrip, public unkF8: number) { super(w, name); }
    getRootJointMtx(): Mtx | null { return this.unkF4.anmMtx(this.unkF4.unk200[this.unkF8]); }
}
/** TBathtubGripPartsFragile: a weak spot (b1..b5) */
export class BathtubGripPartsFragile extends BathtubGripParts {
    constructor(w: World, i: number, g: BathtubGrip) { super(w, 'バスタブの足場の一部（弱点）', g, i); }
    receiveMessage(sender: HitActor, msg: number) { return this.unkF4.receiveMessage(sender, msg); }
}
/** TBathtubGripPartsHard: an unbreakable part (c1..c17): a super hip drop is a hip drop there */
export class BathtubGripPartsHard extends BathtubGripParts {
    constructor(w: World, i: number, g: BathtubGrip) { super(w, 'バスタブの足場の一部（壊れない）', g, i); }
    receiveMessage(sender: HitActor, msg: number) {
        if (msg === MSG.SUPER_HIP_DROP) msg = MSG.HIP_DROP;
        return this.unkF4.receiveMessage(sender, msg);
    }
}

// ---------------------------------------------------------------- TBathtubGrip
export class BathtubGrip extends MapObjBase {
    /** unk138 the sounds' places, unk150 / unk164 the weak and hard collisions, unk1A8 / unk1BC their parts, unk200 the hard parts' joints */
    unk138 = [new V3(), new V3()];
    unk150: ObjCollision[] = []; unk164: ObjCollision[] = [];
    unk1A8: BathtubGripPartsFragile[] = []; unk1BC: BathtubGripPartsHard[] = [];
    unk200: number[] = [];
    /** unk248 breaking, unk249 whole, unk24A killed, unk24B its collision is in (Mario's side) */
    unk248 = 0; unk249 = 1; unk24A = 0; unk24B = 0;
    /** unk24C its angle round the tub, unk250 its break BCK's speed, unk254 the crack's frames, unk258 the frames the crack lasts */
    unk24C = 0; unk250 = 1; unk254 = 0; unk258 = 100;
    unk260 = 0;
    private joints: mat4[] | null = null;
    constructor(w: World, public unk244: Bathtub, angle: number, name = '壊れかけのバスタブの取っ手') {
        super(w, name);
        this.unk254 = 0;
        this.unk24C = angle;
        this.initAndRegister('stand_break');
        this.calcRootMatrix();
        const a = this.mactor;
        for (let i = 0; i < 17; ++i) {
            const joint = `c${i + 1}`;
            this.unk200[i] = a ? a.jointIndex(joint) : -1;
            this.unk1BC[i] = new BathtubGripPartsHard(w, i, this);
            this.unk164[i] = new ObjCollision(w, KIND_MOVE, this.unk1BC[i]);
            this.unk164[i].init(`mapObj/stand_break_${joint}.col`, 0);
            if (i < 5) {
                const jb = `b${i + 1}`;
                this.unk1A8[i] = new BathtubGripPartsFragile(w, i, this);
                this.unk150[i] = new ObjCollision(w, KIND_MOVE, this.unk1A8[i]);
                this.unk150[i].init(`mapObj/stand_break_${jb}.col`, 0);
            }
        }
        this.reset();
    }
    /** getModel()->getAnmMtx(j) */
    anmMtx(j: number): Mtx | null {
        if (!this.mactor || j < 0) return null;
        if (!this.joints) this.joints = this.mactor.anmMtxAll(this.baseTR, this.scale);
        return this.joints && this.joints[j] ? m4ToMtx(this.joints[j]) : null;
    }
    kill() { this.unk24A = 1; this.makeObjDead(); this.removeCollisions_(); }
    reset() {
        this.offLiveFlag(LF.DEAD);
        this.unk248 = 0; this.unk24A = 0; this.unk249 = 1; this.unk24B = 0;
        this.startAnim(0);
        const c = this.mactor ? this.mactor.getFrameCtrl(ANM_BCK) : null;
        if (c) { c.frame = 0; c.rate = 0; }
        this.unk250 = 1; this.unk258 = 100; this.unk260 = 0;
        this.joints = null;
    }
    perform(cue: number) {
        super.perform(cue);
        this.joints = null;
        // (the crack effect model unk25C: drawing only)
    }
    isCracking() { return this.unk254 > 0 || this.unk248 !== 0; }
    /** startCrack (the effect model's stand_effect animations: drawing only) */
    startCrack() { this.unk254 = 1; }
    /** startBreak(animation, count, speed): the stand_break BCK (the first two swapped) */
    startBreak(animation: number, count: number, speed: number) {
        this.unk258 = count; this.unk250 = speed;
        this.startCrack();
        this.unk248 = 1; this.unk249 = 0;
        if (animation === 0) animation = 1;
        else if (animation === 1) animation = 0;
        this.startAnim(animation);
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        const tub = this.unk244, P = tub.unk16C;
        switch (msg) {
            case MSG.SUPER_HIP_DROP: {
                if (this.unk248 !== 0) return false;
                if (this.unk249 === 0) return false;
                this.unk138[0].set(this.world.mario.pos);
                this.world.sound(SE.OBJ_SUPERBLOCK_BREAK, this.unk138[0]);
                const dead = tub.getNumGripsDead() & 0xFFFF;
                if (dead === 4) { tub.startDemo(); return true; }
                tub.quake(sender.pos);
                let count: number, speed: number;
                switch (dead) {
                    case 1: count = P.breakCount0; speed = P.animSpeed1; break;
                    case 2: count = P.breakCount1; speed = P.animSpeed2; break;
                    case 3: count = P.breakCount2; speed = P.animSpeed3; break;
                    case 4: count = P.breakCount3; speed = P.animSpeed4; break;
                    default: count = P.breakCount0; speed = P.animSpeed0; break;
                }
                this.startBreak(dead, count, speed);
                return true;
            }
            case MSG.HIP_DROP: tub.hipdrop(sender.pos); return true;
            case MSG.TRAMPLE: tub.trample(sender.pos); return true;
        }
        return false;
    }
    getRootJointMtx(): Mtx { return this.baseTR; }
    /** calcRootMatrix: the tub's root matrix turned by its angle round it */
    calcRootMatrix() {
        const rot = mtx();
        MsMtxSetRotRPH(rot, 0, this.unk24C, 0);
        rot[3] = rot[7] = rot[11] = 0;
        MTXConcat(this.unk244.getRootJointMtx(), rot, this.baseTR);
        this.anmMtx0 = null;
        this.joints = null;
    }
    marioIsOn() { return false; }
    removeCollisions_() { for (const c of this.unk164) c.remove(); for (const c of this.unk150) c.remove(); }
    setupCollisions_() {
        for (let i = 0; i < 17; ++i) { const m = this.unk1BC[i].getRootJointMtx(); if (m) this.unk164[i].moveMtx(m); this.unk164[i].setUp(); }
        for (let i = 0; i < 5; ++i) { const m = this.unk1A8[i].getRootJointMtx(); if (m) this.unk150[i].moveMtx(m); this.unk150[i].setUp(); }
    }
    control() {
        this.calcRootMatrix();
        super.control();
        if (this.unk24A !== 0) { this.removeCollisions_(); return; }
        // MActor::calcAnm
        if (this.mactor) this.mactor.frameUpdate();
        this.joints = null;
        if (this.unk24B !== 0) this.setupCollisions_();
        const ctrl = this.mactor ? this.mactor.getFrameCtrl(ANM_BCK) : null;
        if (this.unk248 !== 0) {
            if (this.animIsFinished()) {
                if (this.unk244.unk16C.resetGrip !== 0) this.reset();
                else this.kill();
            } else {
                if (ctrl) ctrl.rate = fr(fr(ANM_FRAME_RATE * this.unk250) * 0.5);
                const m = this.unk1A8[0].getRootJointMtx();
                if (m) this.unk138[1].set(m[3], m[7], m[11]);
                this.world.sound(SE.OBJ_STAND_BREAK, this.unk138[1]);
            }
        } else if (ctrl) {
            ctrl.rate = 0;
            if (this.unk254 > 0) {
                ctrl.frame = 1;
                if (++this.unk254 > this.unk258) {
                    this.unk248 = 1; this.unk254 = 0;
                    this.emit('ms_kp_break_a'); this.emit('ms_kp_break_b');
                }
            } else ctrl.frame = 0;
        }
    }
}

register('Bathtub', (w, n) => new Bathtub(w, n));
