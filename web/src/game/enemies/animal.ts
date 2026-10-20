// Seagulls (Animal/AnimalBase.cpp, AnimalManager.cpp, AnimalNerve.cpp, AnimalSave.cpp: カモメ):
// TAnimalBase flies its graph (TNerveAnimalGraphWander), climbing to a random point around each
// node; one scene.bin entry is a flock (its count: the others start scattered around it). They
// move once a frame (the director's last movement tick). The first mSLSharedAnmNum birds play
// their own animation, the others copy one of theirs. Also the helpers the other animals share
// (SMS_Eular2Quat, TQuat4 rotate, CLBChaseGeneralConstantSpecifySpeed, items by event ID).

import { fr, V3, Quat, MsRandF, MsRandI, MsWrap, MsClamp, MsAngleDiff, MsGetRotFromZaxis, JMASSin, JMASCos, s16, Mtx } from '../math.js';
import { World, SpineEnemy, EnemyManager, LiveManager, LiveActor, PathNode, LF, HF, nerve, Spine, Stream, ANM_BCK, ANM_BTP, ANM_FRAME_RATE, readParams, PSchema, CUE_MOVE, CUE_CALC_ANIM, HitActor } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';

// ---------------------------------------------------------------- shared helpers
/** SMSGetAnmFrameRate (60 / 30 vsyncs) */
export const RATE = ANM_FRAME_RATE;
/** CLBPalFrame<int>: CLBRoundf(n / SMSGetAnmFrameRate()) */
export const palFrame = (n: number) => { const v = n * (1 / RATE); return Math.trunc(v + (v > 0 ? 0.5 : -0.5)); };
/** CLBChaseGeneralConstantSpecifySpeed: value moved toward desired by at most speed (returned). */
export function chase(value: number, desired: number, speed: number) {
    let d = desired - value;
    if (speed < 0) speed = -speed;
    if (d > 0) { d -= speed; return d > 0 ? desired - d : desired; }
    d += speed;
    return d < 0 ? desired - d : desired;
}
/** JGeometry::TUtil<f32>::clamp */
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** TUtil<f32>::epsilon */
export const EPS = 1.1920929e-7;
/** TVec3::setLength (zero when its length squared is within epsilon) */
export function setLength(v: V3, len: number) {
    const l = v.squared();
    if (l <= EPS) return v.zero();
    return v.scale(len / Math.sqrt(l));
}
/** TVec3::normalize */
export const jnormalize = (v: V3) => setLength(v, 1);
/** TQuat4::setEulerX/Y/Z (radians) */
export const quatEulerX = (a: number) => new Quat(fr(Math.sin(fr(0.5 * a))), 0, 0, fr(Math.cos(fr(0.5 * a))));
export const quatEulerY = (a: number) => new Quat(0, fr(Math.sin(fr(0.5 * a))), 0, fr(Math.cos(fr(0.5 * a))));
export const quatEulerZ = (a: number) => new Quat(0, 0, fr(Math.sin(fr(0.5 * a))), fr(Math.cos(fr(0.5 * a))));
/** SMS_Eular2Quat: the rotation (degrees) as Ry * (Rx * Rz). */
export function SMS_Eular2Quat(rot: V3) {
    const qz = quatEulerZ(0.017453294 * rot.z), qy = quatEulerY(0.017453294 * rot.y), qx = quatEulerX(0.017453294 * rot.x);
    const r2 = new Quat().mul(qx, qz);
    return new Quat().mul(qy, r2);
}
/** TQuat4::rotate(v, dst) */
export function quatRotate(t: Quat, v: V3, out = new V3()) {
    const qx = t.y * v.z - t.z * v.y + t.w * v.x, qy = -t.x * v.z + t.z * v.x + t.w * v.y;
    const qz = t.x * v.y - t.y * v.x + t.w * v.z, qw = -t.x * v.x - t.y * v.y - t.z * v.z;
    return out.set(qx * t.w + qy * -t.z - qz * -t.y + qw * -t.x, -qx * -t.z + qy * t.w + qz * -t.x + qw * -t.y, qx * -t.y - qy * -t.x + qz * t.w + qw * -t.z);
}
/** TRotation3::getQuat (m: 3x4 row-major) */
export function mtxGetQuat(m: Mtx, q = new Quat()) {
    const a = (r: number, c: number) => m[r * 4 + c];
    if (a(0, 0) + a(1, 1) + a(2, 2) >= 0) {
        const s = Math.sqrt(a(0, 0) + a(1, 1) + a(2, 2) + 1);
        return q.set4((0.5 / s) * (a(2, 1) - a(1, 2)), (0.5 / s) * (a(0, 2) - a(2, 0)), (0.5 / s) * (a(1, 0) - a(0, 1)), 0.5 * s);
    }
    const mx = Math.max(Math.max(a(0, 0), a(1, 1)), a(2, 2));
    if (mx === a(0, 0)) {
        const s = Math.sqrt(a(0, 0) - (a(1, 1) + a(2, 2)) + 1);
        return q.set4(0.5 * s, (0.5 / s) * (a(0, 1) + a(1, 0)), (0.5 / s) * (a(2, 0) + a(0, 2)), (0.5 / s) * (a(2, 1) - a(1, 2)));
    }
    if (mx === a(1, 1)) {
        const s = Math.sqrt(a(1, 1) - (a(2, 2) + a(0, 0)) + 1);
        return q.set4((0.5 / s) * (a(0, 1) + a(1, 0)), 0.5 * s, (0.5 / s) * (a(1, 2) + a(2, 1)), (0.5 / s) * (a(0, 2) - a(2, 0)));
    }
    const s = Math.sqrt(a(2, 2) - (a(0, 0) + a(1, 1)) + 1);
    return q.set4((0.5 / s) * (a(2, 0) + a(0, 2)), (0.5 / s) * (a(1, 2) + a(2, 1)), 0.5 * s, (0.5 / s) * (a(1, 0) - a(0, 1)));
}
/** TRotation3::setSQ (rows scaled) and the translation */
export function mtxSetSQT(m: Mtx, s: V3, q: Quat, t: V3) {
    const yy = 2 * q.y * q.y, zz = 2 * q.z * q.z, xx = 2 * q.x * q.x, xy = 2 * q.x * q.y, xz = 2 * q.x * q.z, yz = 2 * q.y * q.z, wz = 2 * q.w * q.z, wy = 2 * q.w * q.y, wx = 2 * q.w * q.x;
    m[0] = s.x * (1 - yy - zz); m[1] = s.x * (xy - wz); m[2] = s.x * (xz + wy); m[3] = t.x;
    m[4] = s.y * (xy + wz); m[5] = s.y * (1 - xx - zz); m[6] = s.y * (yz - wx); m[7] = t.y;
    m[8] = s.z * (xz - wy); m[9] = s.z * (yz + wx); m[10] = s.z * (1 - xx - yy); m[11] = t.z;
    return m;
}
/** CLBCalcRotateZXYTranslateMatrix (degrees) */
export function calcRotateZXYTranslate(m: Mtx, r: V3, t: V3) {
    const ax = s16(r.x * (65536 / 360)), ay = s16(r.y * (65536 / 360)), az = s16(r.z * (65536 / 360));
    const sx = JMASSin(ax), cx = JMASCos(ax), sy = JMASSin(ay), cy = JMASCos(ay), sz = JMASSin(az), cz = JMASCos(az);
    m[0] = cy * cz + sy * sx * sz; m[1] = -sz * cy + cz * sy * sx; m[2] = sy * cx; m[3] = t.x;
    m[4] = cx * sz; m[5] = cx * cz; m[6] = -sx; m[7] = t.y;
    m[8] = -sy * cz + sz * cy * sx; m[9] = sy * sz + cz * cy * sx; m[10] = cy * cx; m[11] = t.z;
    return m;
}
/** The director's last movement tick of the frame (TGraphics::unk0 & 2: DIRECTOR_FLAG_LAST_SIMULATION_TICK). */
export const isLastTick = (w: World) => (w.tickCount & 3) === 0;
/** SMS_IsInOtherFastCube: the cube manager isn't ported (nothing is in another "fast" cube). */
export const isInOtherFastCube = (_w: World, _p: V3) => false;

/**
 * An item a scene.bin event ID names (TMapObjBaseManager::newAndRegisterObjByEventID, through
 * TItemManager::newAndRegisterCoin): the type of object it would be, null when none.
 */
export interface ItemRef { type: number; name: string; eventId: number; }
export function itemByEventID(w: World, id: number, name: string): ItemRef | null {
    id = id >>> 0;
    if (id < 0x32) return { type: AT.COIN_BLUE, name: 'coin_blue', eventId: id };
    if (id === 100) return { type: AT.COIN, name: 'coin', eventId: id };
    if (id === 200) return { type: AT.COIN_RED, name: 'coin_red', eventId: id };
    switch (id) {
        case 777: { const n = `シャイン（${name}）`; return w.search(n) ? { type: AT.SHINE, name: n, eventId: id } : null; }
        case 1000: return { type: (AT as any).FRUIT_BANANA ?? 0, name: 'FruitBanana', eventId: id };
        case 1001: return { type: (AT as any).FRUIT_DURIAN ?? 0, name: 'FruitDurian', eventId: id };
        case 1002: return { type: (AT as any).FRUIT_PAPAYA ?? 0, name: 'FruitPapaya', eventId: id };
        case 1003: return { type: (AT as any).FRUIT_PINE ?? 0, name: 'FruitPine', eventId: id };
        case 1004: return { type: (AT as any).FRUIT_COCONUT ?? 0, name: 'FruitCoconut', eventId: id };
        case 2000: return { type: (AT as any).MUSHROOM_1UP ?? 0, name: 'mushroom1up', eventId: id };
        case 2001: return { type: (AT as any).MUSHROOM_1UP_R ?? 0, name: 'mushroom1upR', eventId: id };
    }
    return null;
}
/** TMapObjBaseManager::newAndRegisterObj(name) */
export const itemByName = (name: string): ItemRef => ({ type: name === 'coin' ? AT.COIN : name === 'mushroom1upR' ? ((AT as any).MUSHROOM_1UP_R ?? 0) : 0, name, eventId: -1 });
/** An item appears (appear(); its position; its velocity): told to the viewer. */
export function appearItem(w: World, it: ItemRef, p: V3, v: V3) {
    const kind = it.type === AT.SHINE ? 'shine' : it.type === AT.COIN ? 'coin' : it.name.startsWith('mushroom1up') ? '1up' : 'item';
    w.events.push({ t: w.tickCount, kind, data: { p: p.clone(), v: v.clone(), type: it.type, name: it.name, eventId: it.eventId } });
}

// ---------------------------------------------------------------- TAnimalSaveIndividual
export const ANIMAL_SAVE = {
    mSLSharedAnmNum: ['i', 4], mSLViewClipNear: ['f', 100], mSLViewClipFar: ['f', 10000], mSLViewClipRadius: ['f', 75],
    mSLMaxMarchSpeed: ['f', 6], mSLMarchAccel: ['f', 0.04], mSLMarchDecrease: ['f', 0.2], mSLWalkTurnSpeed: ['f', 10], mSLWaitTurnSpeed: ['f', 2],
} satisfies PSchema;
export type AnimalSave = { [K in keyof typeof ANIMAL_SAVE]: number };

// ---------------------------------------------------------------- TAnimalManagerBase / TMewManager
export class AnimalManagerBase extends EnemyManager {
    viewClipNear = 250; viewClipFar = 10000; clipRadius = 300;
    animalSave: AnimalSave | null = null;
    /** clipEnemies: in the camera's view (near mViewClipNear, far mSLViewClipFar, radius unk3C). */
    clipActors() {
        for (const a of this.objs as LiveActor[]) {
            const p = a.pos.clone(); p.y += 75;
            if (a.checkLiveFlag(LF.UNK2000) && isInOtherFastCube(this.world, p)) a.onLiveFlag(LF.CLIPPED_OUT);
            else if (this.world.inView(a.pos, this.clipRadius, this.viewClipFar)) a.offLiveFlag(LF.CLIPPED_OUT);
            else a.onLiveFlag(LF.CLIPPED_OUT);
        }
    }
}
export class MewManager extends AnimalManagerBase {
    constructor(w: World, name = '?') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.animalSave = readParams('/Animal/mew.prm', this.world.files, ANIMAL_SAVE);
        this.viewClipNear = this.animalSave.mSLViewClipNear;
        this.viewClipFar = this.animalSave.mSLViewClipFar;
        this.clipRadius = this.animalSave.mSLViewClipRadius;
    }
    createModelData() { this.createModelDataArray(['kamome_high.bmd']); }
}

// ---------------------------------------------------------------- TAnimalBase
export class AnimalBase extends SpineEnemy {
    /** mFrameTimer (TAnimalBaseUnk150): counted up to [1], only reset */
    frameTimer = [0, 1];
    constructor(w: World, public type: number, name = '?') { super(w, name); this.actorType = type | 0; }
    get save(): AnimalSave { return (this.manager as AnimalManagerBase).animalSave || readParams('', this.world.files, ANIMAL_SAVE); }
    init(m: LiveManager | null) {
        if (!m) { this.world.conductor.aloneActors.push(this); return; }
        this.manager = m;
        m.manageActor(this);
        // TMActorKeeper::createMActorFromAllBmd(3), getMActor(0)
        this.mactor = this.createMActor(0);
        this.initHitActor(this.type, 0, 0, 0, 0, 0, 0);
        this.hitFilter |= HF.NO_COLLISION;
        this.bodyScale = 1; this.marchSpeed = 0; this.bodyRadius = 10; this.wallRadius = 20;
        this.liveFlag |= LF.UNK10 | LF.UNK20 | LF.UNK8;
        this.spine!.initWith(AnimalNerves.graphWander);
        this.tracer.reset();
        this.goToShortestNextGraphNode();
        this.frameTimer = [0, 1];
        const sv = this.save;
        if (this.mactor) this.mactor.setBckFromIndex(0);
        this.marchSpeed = 0;
        this.turnSpeed = fr(sv.mSLWalkTurnSpeed * RATE);
        const fc = this.mactor ? this.mactor.getFrameCtrl(ANM_BCK) : null;
        if (fc) {
            const n = sv.mSLSharedAnmNum;
            const phase = n === 0 ? MsRandF() : fr((1 / n) * (this.instanceIndex % n));
            fc.frame = fr(phase * fc.end);
        }
        const fc2 = this.mactor ? this.mactor.getFrameCtrl(ANM_BTP) : null;
        // (no getCurAnmIdx check in the game: any model with BTPs rolls here)
        if (fc2) fc2.frame = fr(fc2.end * MsRandF());
    }
    /** initNoLoad_: one more of the flock, scattered around this one. */
    initNoLoad(o: AnimalBase) {
        o.pos.x = fr(1000 * (MsRandF() - 0.5) + this.pos.x);
        o.pos.z = fr(1000 * (MsRandF() - 0.5) + this.pos.z);
        if (this.type === AT.ANIMAL_MEW) o.pos.y = fr(1000 * MsRandF() + this.pos.y);
        else o.pos.y = fr(this.pos.y - 250 * MsRandF());
        o.scale.set(this.scale);
        o.rot.x = 0;
        o.rot.y = MsWrap(fr(150 * (MsRandF() - 0.5) + this.rot.y), 0, 360);
        o.rot.z = 0;
        o.character = this.character;
        o.tracer.init(this.tracer.graph!);
        o.groundPlane = this.world.illegal;
        o.init(this.manager);
        // (the game puts this one, not the new one, into the enemy group again)
        this.world.addToGroup('敵グループ', this);
    }
    load(s: Stream) {
        super.load(s);
        const count = s.s32() - 1;
        for (let i = 0; i < count; i++) this.initNoLoad(new AnimalBase(this.world, this.type, this.name));
    }
    calcRootMatrix() { }
    receiveMessage(_s: HitActor, _m: number) { return false; }
    perform(cue: number) {
        if (cue & CUE_MOVE) {
            if (isLastTick(this.world)) {
                this.posDelta.zero();
                this.control();
                this.pos.add(this.posDelta).fround();
            }
            cue &= ~CUE_MOVE;
        }
        if ((cue & CUE_CALC_ANIM) && this.mactor) {
            this.updateAnmSound();
            this.mactor.frameUpdate();
            if (!(this.liveFlag & (LF.HIDDEN | LF.CLIPPED_OUT))) {
                this.calcRootMatrix();
                // (CUE_CALC_VIEW: the model's matrix is CLBCalcRotateZXYTranslateMatrix(rotation, position))
                calcRotateZXYTranslate(this.baseTR, this.rot, this.pos);
            }
            cue &= ~CUE_CALC_ANIM;
        }
    }
    /** resetRandomCurPathNode: a random point around the graph node for the goal. */
    resetRandomCurPathNode() {
        if (this.goal.actor) return;
        const p = this.goal.point().clone();
        p.x = fr(p.x + 1000 * (MsRandF() - 0.5));
        p.z = fr(p.z + 1000 * (MsRandF() - 0.5));
        if (this.type === AT.ANIMAL_MEW) p.y = fr(p.y + 1000 * (p.y <= 1000 ? MsRandF() : MsRandF() - 0.5));
        else p.y = fr(p.y - 250 * MsRandF());
        this.setGoalPath(new PathNode(null, p));
    }
    /** getRotationFlyToDir (static): turn cur toward the direction, banking into the turn. */
    static getRotationFlyToDir(cur: V3, diff: V3, speedX: number, speedY: number) {
        const r = MsGetRotFromZaxis(diff);
        r.y = MsWrap(r.y, 0, 360);
        const d = clamp(MsAngleDiff(r.y, cur.y), -speedY, speedY);
        cur.y = MsWrap(fr(cur.y + d), 0, 360);
        const roll = MsClamp(30 * -d, -45, 45);
        cur.z = fr(chase(cur.z, roll, 0.1 * speedX));
        r.x = MsWrap(r.x, -180, 180);
        cur.x = MsWrap(cur.x, -180, 180);
        cur.x = fr(chase(cur.x, r.x, 0.1 * speedX));
    }
    /** execWalk: speed up (or slow down) and fly toward the goal. */
    execWalk(moving: boolean) {
        const sv = this.save;
        if (moving) this.marchSpeed = fr(chase(this.marchSpeed, sv.mSLMaxMarchSpeed * RATE, sv.mSLMarchAccel * RATE * RATE));
        else this.marchSpeed = fr(chase(this.marchSpeed, 0, sv.mSLMarchDecrease * RATE * RATE));
        this.turnSpeed = fr((this.marchSpeed < 0.001 ? sv.mSLWaitTurnSpeed : sv.mSLWalkTurnSpeed) * RATE);
        let turn = this.turnSpeed;
        const march = this.marchSpeed;
        const diff = V3.sub(this.goal.point(), this.pos);
        const dist = diff.length();
        if (dist < 100) return;
        if (dist <= 2 * this.calcMinimumTurnRadius(march, turn)) turn = this.calcTurnSpeedToReach(march, 0.5 * dist);
        AnimalBase.getRotationFlyToDir(this.rot, diff, march, turn);
        const q = SMS_Eular2Quat(this.rot);
        this.posDelta.set(quatRotate(q, new V3(0, 0, march))).fround();
    }
}

const setTimer = (a: AnimalBase, lo: number, hi: number) => { a.frameTimer[0] = 0; a.frameTimer[1] = MsRandI(palFrame(lo), palFrame(hi)); };
export const AnimalNerves: Record<string, any> = {};
AnimalNerves.graphWander = nerve<AnimalBase>('TNerveAnimalGraphWander', (spine: Spine<AnimalBase>) => {
    const a = spine.body, m = a.mactor!, mgr = a.manager as AnimalManagerBase;
    const n = a.save.mSLSharedAnmNum;
    if (n !== 0 && a.instanceIndex >= n) {
        // the shared animation: one of the first n birds' (its BCK and frame)
        const o = mgr.getObj(a.instanceIndex % n) as LiveActor;
        m.setBckFromIndex(o.mactor!.getCurAnmIdx(ANM_BCK));
        const mc = m.getFrameCtrl(ANM_BCK), oc = o.mactor!.getFrameCtrl(ANM_BCK);
        if (mc && oc) mc.frame = oc.frame;
    } else if (a.type !== AT.ANIMAL_MEW) {
        // (only the gulls choose their own animation)
    } else {
        if (spine.getTime() === 0) setTimer(a, 150, 500);
        a.frameTimer[0] += 1;
        if (a.frameTimer[0] >= a.frameTimer[1]) a.frameTimer[0] = a.frameTimer[1];
        const ends = m.curAnmEndsNext(ANM_BCK);
        if (m.getCurAnmIdx(ANM_BCK) === 1 && ends) {
            if (!m.checkCurBckFromIndex(0)) m.setBckFromIndex(0);
            setTimer(a, 150, 500);
        }
    }
    a.execWalk(true);
    if (a.goalStack.length) {
        if (V3.sub(a.goal.point(), a.pos).length() < 200 && a.goalStack.length) a.goal = a.goalStack.pop()!;
    } else if (V3.sub(a.goal104.point(), a.pos).length() < 100) {
        a.goToRandomNextGraphNode();
        a.resetRandomCurPathNode();
        // climbing: the gliding animation (1); else flapping (0)
        if (a.pos.y <= a.goal.point().y) { if (!m.checkCurBckFromIndex(1)) m.setBckFromIndex(1); setTimer(a, 60, 180); }
        else { if (!m.checkCurBckFromIndex(0)) m.setBckFromIndex(0); setTimer(a, 150, 500); }
    }
    return false;
});

register('MewManager', (w, n) => new MewManager(w, n));
register('AnimalMew', (w, n) => new AnimalBase(w, AT.ANIMAL_MEW, n));
