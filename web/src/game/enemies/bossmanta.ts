// TBossManta / TBossMantaManager / TBossMantaAdditionalCollision(Set) / TBossMantaParams
// (Enemy/bossManta.cpp): Phantamanta (ボスマンタ), the goop ray of Sirena Beach's "The Manta Storm"
// (sirena0). Scene names "BossManta" and "BossMantaManager" (MarNameRefGen_BossEnemy.cpp).
//
// Every manta of the fight is one of the manager's pool (mSLInstanceNum of them, all killed at
// init). Once MSF_MANTA_SPAWNED is set, the battle state (TMantaBattleState) starts the demo camera
// and makes manta 0 generation 0: the appear demo (TNerveMantaAppearDemo: from z =
// mSLAppearDemoInitialZ swimming toward -z for 0x690 ticks), then TNerveMantaMove. Moving, a manta
// heads along unk170 at unk190 a tick, unk170 turned toward unk164 by unk194 a tick; unk164 (the
// attractor, updateAttractor every 100 ticks) pulls toward a target (unk158: a random node of the
// "main" graph, pulled toward Mario by a per-generation amount, picked again when within 500 or
// every 150 ticks; unk1A4 flips every unk188 ticks between the two tables), pushes away from the
// other mantas' look points, away from Mario when he stands by a palm (sEscapeFromMario) or for
// generation 4, and back inside the graph's 13-node ring (getIntoGraphVec). It pollutes under
// itself (mSLPolluteRadius x its scale) and throws Mario (AttackMario) on contact.
//
// The split: each water hit (a drop whose particle flag has 0x40) while damageable (Move or
// HitWater, and its unk1A0 grace timer out) restarts TNerveMantaHitWater and counts unk19C; at
// 16 / 8 / 4 / 2 / 1 hits (generation 0..4) the next nerve is TNerveMantaSpawn (generations 0..3:
// it puffs up, shrinks, and at tick 0 the manager spawns 1 / 2 / 3 / 4 / 4 mantas of the next
// generation from dead pool entries, spread evenly round a random angle) or TNerveMantaDeath
// (generation 4+). Generations 0..2 are too big for one cylinder: their collision is a 0 radius
// and three extra cylinders (TBossMantaAdditionalCollisionSet: body and both wing tips, from the
// joints) forward water to it. When every living manta is generation 4, they all become
// generation 5 (the red ones, battle state 2); when those are all gone the hotel event sinks
// (TMapEventSirenaSink::unk64).
//
// For the viewer: the walk BCK (3) is motion-blended toward BCK 4 by the turn (updateAnimBlend);
// the joints are worked out here with that blend (`locals`), and the extra collisions read them.
//
// Not here: particles (the damage / split / death .jpa), the looped swim sounds (BS_MANTA_DRAW_LV
// and _DRAW_DEMO, started every tick), the BGM, the shadow / EFB alpha drawing and the manta color
// (getMantaColor, drawing only: its unk84 ramp too). Balloons and the demo camera are
// 'balloon:<id>' / 'demo:<name>' effects. MSF_MANTA_SPAWNED is read from world.flags: sirena0's event
// script (map/sp/appearmanta.sb, eventwatcher.ts) sets it once Mario's talk to モンテＡ ends, which
// needs the talk system the sim doesn't have yet (TODO), so for now the fight doesn't start.

import { fr, V3, MsRandF } from '../math.js';
import { World, Stream, HitActor, LiveActor, LiveManager, SpineEnemy, EnemyManager, LF, HF, HC, MSG, ANM_BCK, ANM_FRAME_RATE, CUE_MOVE,
    nerve, Spine, readParams, SPINE_PARAMS, PSchema, Nerve } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { mat4 } from 'gl-matrix';
import { Skeleton, parseBCK, jointMatricesBlend } from '../skeleton.js';
import { jNormalize } from './jgeom.js';
import { throwMario } from './koopa.js';
import type { WaterHitActor } from '../water.js';

/** TBossMantaParams (/enemy/bossmanta.prm) */
const MANTA_PARAMS = {
    ...SPINE_PARAMS,
    mSLPolluteRadius: ['f', 100], mSLDamageEffectNum: ['i', 3], mSLAppearDemoInitialZ: ['f', 7600], mSLAppearDemoWalkSpeed: ['f', 3],
    mSLMantaRed: ['i', 0xC4], mSLMantaGreen: ['i', 0x80], mSLMantaBlue: ['i', 0x5F], mSLMantaAlpha: ['i', 0x80],
    mSLAngryMantaRed: ['i', 0xD2], mSLAngryMantaGreen: ['i', 0x1E], mSLAngryMantaBlue: ['i', 0x5A], mSLAngryMantaAlpha: ['i', 0x80],
    mSLAttractorPower: ['f', 622], mSLPusherPower: ['f', 23559], mSLEscapeLookPoint: ['f', 1000], mSLEscapeLookedPoint: ['f', 1000],
    mSLEscapeRegion: ['f', 500],
} satisfies PSchema;
type MantaParams = { [K in keyof typeof MANTA_PARAMS]: number };

/** MSF_MANTA_SPAWNED */
const MSF_MANTA_SPAWNED = 0x50007;
const PI_F = fr(Math.PI);

// manta.bmd's BCKs by index (as the code uses them)
const BCK_DEATH = 0, BCK_DAMAGE = 1, BCK_WALK = 3, BCK_WALK_BLEND = 4;

// TBossManta's statics
const sScale = [20, 10, 5, 2, 1, 1];
const sFrameRate = [0.3, 0.5, 1.2, 2.0, 5.0, 5.3].map(fr);
let sCenterJointIndex = 0, sBodyJointIndex = 0, sRwingJointIndex = 0, sLwingJointIndex = 0;
let sEscapeFromMario = 0;

const HIT_COUNTS = [16, 8, 4, 2, 1, 1];
const EPILOGUE = [
    0.0, 0.046, 0.107, 0.177, 0.227, 0.256, 0.273, 0.279, 0.274, 0.26, 0.237, 0.209, 0.175, 0.138, 0.1, 0.061,
    0.024, -0.011, -0.043, -0.07, -0.092, -0.108, -0.12, -0.126, -0.127, -0.123, -0.115, -0.104, -0.09, -0.074, -0.057, -0.04,
    -0.022, -0.005, 0.01, 0.024, 0.035, 0.045, 0.051, 0.056, 0.058, 0.057, 0.055, 0.051, 0.046, 0.039, 0.031, 0.023, 0.015, 0.007,
].map(fr);
const DAMAGE_SE = [SE.BS_MANTA_DAMAGE_1, SE.BS_MANTA_DAMAGE_2, SE.BS_MANTA_DAMAGE_3, SE.BS_MANTA_DAMAGE_4, SE.BS_MANTA_DAMAGE_5, SE.BS_MANTA_DAMAGE_5];
const SEGMENT_SE = [SE.BS_MANTA_SEGMENT_1, SE.BS_MANTA_SEGMENT_2, SE.BS_MANTA_SEGMENT_3, SE.BS_MANTA_SEGMENT_4];

const sendToMario = (w: World, from: HitActor, msg: number) => w.mario.receiveMessage(from, msg);

/** (anonymous namespace) AttackMario */
function attackMario(w: World, attacker: HitActor) {
    const dir = V3.sub(w.mario.pos, attacker.pos);
    jNormalize(dir);
    dir.scale(2);
    dir.y = fr(dir.y + 1);
    sendToMario(w, attacker, MSG.ATTACK);
    sendToMario(w, attacker, MSG.THROWN);
    throwMario(w, dir, 60);
}

/** lerp_hack: value += progress * (target - value) */
const lerp = (v: number, t: number, p: number) => fr(v + fr(p * fr(t - v)));
const lerpToMario = (w: World, pt: V3, p: number) => { const m = w.mario.pos; pt.x = lerp(pt.x, m.x, p); pt.y = lerp(pt.y, m.y, p); pt.z = lerp(pt.z, m.z, p); };
/** TVec3::length */
const len = (v: V3) => fr(Math.sqrt(v.squared()));

// ================================================================ nerves
type MS = Spine<BossManta>;
export const MantaNerves: Record<string, Nerve<BossManta>> = {};

MantaNerves.move = nerve<BossManta>('TNerveMantaMove', (spine: MS) => {
    const self = spine.body, w = self.world, time = spine.getTime(), graph = self.tracer.graph!;
    if (time === 0) {
        self.startWalkAnim();
        const pt = graph.point(Math.trunc(MsRandF() * graph.count));
        lerpToMario(w, pt, 1);
        self.unk158.set(pt);
    }
    // (gen < 3: BS_MANTA_DRAW_LV, a looped sound started every tick)
    if (self.mGeneration === 5 && time % 96 === self.instanceIndex) w.sound(SE.BS_MANTA_ATTACK, self.pos);   // (startSoundSet)
    if (Math.sqrt(sqd(self.pos, self.unk158)) < 500 || time % 150 === 0) {
        const pt = graph.point(Math.trunc(MsRandF() * graph.count));
        // (every case of the first table is 1.0)
        const p = self.unk1A4 ? 1 : [1, 0.8, 0.8, 0.6, 0.8, 1][self.mGeneration];
        if (self.mGeneration >= 0 && self.mGeneration <= 5) lerpToMario(w, pt, fr(p));
        self.unk158.set(pt);
    }
    if (time % self.unk188 === 0) self.unk1A4 ^= 1;
    if (time % 100 === 0) self.updateAttractor();
    const dir = self.unk164.clone();
    jNormalize(dir);
    dir.scale(self.unk194);
    self.unk170.add(dir);
    jNormalize(self.unk170);
    return false;
});
const sqd = (a: V3, b: V3) => fr(a.x - b.x) ** 2 + fr(a.y - b.y) ** 2 + fr(a.z - b.z) ** 2;

MantaNerves.hitWater = nerve<BossManta>('TNerveMantaHitWater', (spine: MS) => {
    const self = spine.body;
    if (spine.getTime() === 0) {
        self.startDamageAnim();
        self.world.sound(DAMAGE_SE[self.mGeneration], self.pos);
    }
    // (the hit particles: mSLDamageEffectNum of each of the generation's)
    if (self.checkCurAnmEnd(0)) { self.startDamageAnimEpilogue(); return true; }
    return false;
});

MantaNerves.spawn = nerve<BossManta>('TNerveMantaSpawn', (spine: MS) => {
    const self = spine.body, s = self.scale;
    const k = spine.getTime() < 5 ? 1.01 : 0.9;
    s.x = fr(s.x * fr(k)); s.y = fr(s.y * fr(k)); s.z = fr(s.z * fr(k));
    if (spine.getTime() === 0) {
        // (the split particle ms_man_div*)
        self.world.sound(SEGMENT_SE[self.mGeneration], self.pos);
        self.mantaManager.spawn(self.mGeneration + 1, self.pos);
    }
    if (spine.getTime() === 0x1E) { self.kill(); return true; }
    return false;
});

MantaNerves.death = nerve<BossManta>('TNerveMantaDeath', (spine: MS) => {
    const self = spine.body, a = self.mactor;
    if (spine.getTime() === 0 && a) {
        a.setBckFromIndex(BCK_DEATH);
        a.setFrameRate(ANM_FRAME_RATE, ANM_BCK);
        self.setBckMotionBlendRatio(0);
    }
    if (self.checkCurAnmEnd(0)) {
        // (ms_man_dead)
        self.world.sound(SE.BS_MANTA_VANISH, self.pos);
        self.kill();
    }
    return false;
});

MantaNerves.appearDemo = nerve<BossManta>('TNerveMantaAppearDemo', (spine: MS) => {
    const time = spine.getTime(), self = spine.body;
    if (time === 0) {
        self.pos.set(0, 0, self.MP.mSLAppearDemoInitialZ);
        self.unk170.set(0, 0, -1);
        self.unk158.set(0, 0, -10000);
        self.startWalkAnim();
    }
    // (time 0x2D0: MSBgm::startBGM(0x8001002B))
    if (time === 0x690) return true;
    // (BS_MANTA_DRAW_DEMO every tick)
    self.unk190 = self.MP.mSLAppearDemoWalkSpeed;
    return false;
});

// ================================================================ TBossManta
export class BossManta extends SpineEnemy {
    unk150 = 0; unk154 = 0;
    unk158 = new V3(0, 0, 0); unk164 = new V3(0, 0, 0); unk170 = new V3(0, 0, 1); unk17C = new V3(0, 0, 0);
    unk188 = 0; mGeneration = 0; unk190 = 0; unk194 = 0; unk198 = 0; unk19C = 0; unk1A0 = 0; unk1A4 = 0;
    /** the motion blend: the BCK it blends toward (setBckOldMotionBlendAnmPtr), the old frame (keepCurAnm), the ratio */
    mc = { oldIdx: -1, oldFrame: 0, ratio: 0 };
    joints: mat4[] | null = null;
    /** each joint's matrix in its parent's (the viewer draws these) */
    locals: mat4[] = [];
    constructor(w: World, name = 'ボスマンタ') { super(w, name); }
    get mantaManager() { return this.manager as BossMantaManager; }
    get MP(): MantaParams { return this.getSaveParam(); }

    /** init */
    init(m: LiveManager | null) {
        if (!m) return;
        this.manager = m; m.manageActor(this);
        this.mactor = this.createMActorByName('manta.bmd');
        this.tracer.init(this.world.graphByName('main'));   // (gpConductor->getGraphByName)
        this.hitPoints = this.maxHitPoints();
        this.headHeight = 5000;
        this.initHitActor(AT.BOSS_MANTA, 1, HC.PLAYER, 0, 0, 0, 0);
        this.unk170.set(0, 0, 1);
        this.calcRootMatrix();
        this.kill();
        this.world.addToGroup('オブジェクトグループ', this);
        if (this.instanceIndex === 0 && this.mactor) {
            sCenterJointIndex = this.mactor.jointIndex('center');
            sBodyJointIndex = this.mactor.jointIndex('jnt_body');
            sRwingJointIndex = this.mactor.jointIndex('jnt_Rwing2');
            sLwingJointIndex = this.mactor.jointIndex('jnt_Lwing2');
            this.mantaManager.initAdditionalCollision();
        }
        this.onLiveFlag(LF.UNK8);
        this.offLiveFlag(LF.ENABLE_CLIPPING);
        this.unk1A4 = 0;
        this.unk150 = 0.5;
    }
    getTailAnimSpeed() { return fr([0.005, 0.008, 0.01, 0.03, 0.05, 0.05][this.mGeneration]); }
    setCollision() {
        if (this.mGeneration <= 2) this.setHitParams(0, 0, 0, 0);
        else { const r = fr(80 * this.scale.x); this.setHitParams(r, 100, r, 100); }
        this.offHitFilter(HF.NO_COLLISION);
    }
    setBckMotionBlendRatio(r: number) { this.mc.ratio = r; }
    startWalkAnim() {
        const a = this.mactor;
        if (!a) return;
        // initBckNormalMotionBlend; setBckFromIndex keeps the BCK it leaves at its frame
        const fc = a.getFrameCtrl(ANM_BCK);
        this.mc.oldFrame = fc ? fc.frame : 0;
        a.setBckFromIndex(BCK_WALK);
        this.mc.oldIdx = BCK_WALK_BLEND;   // (setBckOldMotionBlendAnmPtr(anm 4))
        this.setBckMotionBlendRatio(0.5);
        a.setFrameRate(fr(sFrameRate[this.mGeneration] * ANM_FRAME_RATE), ANM_BCK);
    }
    startDamageAnim() {
        const a = this.mactor;
        if (!a) return;
        a.setBckFromIndex(BCK_DAMAGE);
        a.setFrameRate(fr(sFrameRate[this.mGeneration] * ANM_FRAME_RATE), ANM_BCK);
        this.setBckMotionBlendRatio(0);
    }
    updateAnimBlend() {
        if (this.mactor && this.mactor.checkCurBckFromIndex(BCK_WALK)) {
            const d = this.unk164.clone();
            jNormalize(d);
            const b = this.getTailAnimSpeed();
            const c = new V3().cross(this.unk170, d);
            const turn = fr(0.5 - fr(0.4 * fr(c.y)));
            this.unk150 = fr(fr(fr(1 - b) * this.unk150) + fr(b * turn));
            const r = fr(this.unk150 + this.getEpilogueValue());
            this.setBckMotionBlendRatio(r < 0 ? 0 : r > 1 ? 1 : r);
        } else this.setBckMotionBlendRatio(0);
    }
    /** getIntoGraphVec: the inward normal of the first edge of the 13-node ring it is outside of */
    getIntoGraphVec(out: V3) {
        const g = this.tracer.graph!;
        const edge = (i: number, j: number) => {
            const a = V3.sub(g.point(i), this.pos); a.y = 0;
            const d = V3.sub(g.point(i), g.point(j)); d.y = 0;
            if (fr(fr(a.z * d.x) - fr(a.x * d.z)) < 0) { out.cross(new V3(0, 1, 0), d).fround(); jNormalize(out); return true; }
            return false;
        };
        for (let idx = 0; idx < 12; ++idx) if (edge(idx, idx + 1)) return true;
        return edge(12, 0);
    }
    /** moveObject */
    moveObject() {
        super.moveObject();
        const P = this.world.pollution;
        if (this.isPolluting() && P) P.stamp(1, this.pos.x, this.pos.y, this.pos.z, this.getPolluteRadius());   // (TPollutionManager::pollute)
        for (const c of this.collisions.slice()) if (c.isActorType(AT.MARIO)) attackMario(this.world, this);
    }
    isSpawnState() { return this.spine!.getLatestNerve() === MantaNerves.spawn; }
    collidedWithWater() {
        if (!this.isDamageable()) return false;
        const s = this.spine!, n = s.getLatestNerve();
        const isHitWater = n === MantaNerves.move ? false : n === MantaNerves.hitWater;
        if (this.unk19C < HIT_COUNTS[this.mGeneration]) {
            this.unk1A0 = 0x1E;
            if (!isHitWater) { s.reset(); s.setNext(MantaNerves.hitWater); }
            this.unk19C++;
            if (this.unk19C === HIT_COUNTS[this.mGeneration]) s.pushAfterCurrent(this.mGeneration >= 4 ? MantaNerves.death : MantaNerves.spawn);
            else if (s.stack.length < 7) s.pushAfterCurrent(MantaNerves.move);
        }
        return true;
    }
    receiveMessage(sender: HitActor, msg: number) {
        if (msg !== MSG.SPRAYED_BY_WATER) return false;
        const wt = this.world.water, slot = (sender as WaterHitActor).unk68;
        // (mParticleFlagSOA[unk68] & 0x40)
        if (wt && slot !== undefined && slot >= 0 && (wt.flag[slot] & 0x40)) return this.collidedWithWater();
        return false;
    }
    /** initNthGeneration */
    initNthGeneration(gen: number) {
        const heights = [10, 5, 1, 0.42, 0.42, 0.42];
        this.mGeneration = gen;
        const sc = sScale[gen];
        this.scale.z = sc; this.scale.x = sc; this.scale.y = fr(heights[gen]);
        this.unk19C = 0;
        this.resetDamageAnimEpilogue();
        const s = this.spine!;
        switch (gen) {
            case 0:
                s.initWith(MantaNerves.appearDemo); s.pushAfterCurrent(MantaNerves.move);
                this.unk188 = 0x258; this.unk190 = 2; this.unk194 = fr(0.009); this.unk198 = 1000; this.unk1A0 = 0;
                break;
            case 1:
                s.initWith(MantaNerves.move);
                this.unk188 = Math.trunc(fr(100 * MsRandF())) + 0x258; this.unk190 = 2; this.unk194 = fr(0.009); this.unk198 = 1000; this.unk1A0 = 0x78;
                break;
            case 2:
                s.initWith(MantaNerves.move);
                this.unk188 = Math.trunc(fr(100 * MsRandF())) + 0xC8; this.unk190 = 3; this.unk194 = fr(0.009); this.unk198 = 1000; this.unk1A0 = 0x78;
                break;
            case 3:
                s.initWith(MantaNerves.move);
                this.unk188 = Math.trunc(fr(100 * MsRandF())) + 0x64; this.unk190 = 4; this.unk194 = fr(0.019); this.unk198 = 700; this.unk1A0 = 0x78;
                break;
            case 4:
                s.initWith(MantaNerves.move);
                this.unk188 = Math.trunc(fr(100 * MsRandF())) + 0x64; this.unk190 = 7; this.unk194 = fr(0.03); this.unk198 = 400; this.unk1A0 = 0x168;
                break;
            case 5:
                s.initWith(MantaNerves.move);
                this.unk188 = Math.trunc(fr(100 * MsRandF())) + 0x64; this.unk190 = 3; this.unk194 = fr(0.03); this.unk198 = 200; this.unk1A0 = 0;
                break;
        }
        this.setCollision();
        this.offLiveFlag(LF.DEAD);
        if (gen <= 2) this.mantaManager.adaptAdditionalCollision(this);
    }
    control() {
        if (this.unk1A0 > 0) this.unk1A0 -= 1;
        this.updateAnimBlend();
        const v = this.unk170.clone().scale(this.unk190);
        v.y = this.vel.y;
        this.vel.set(v);
        super.control();
    }
    startDamageAnimEpilogue() { this.unk150 = 0.5; this.unk154 = 0; }
    resetDamageAnimEpilogue() { this.unk150 = 0.5; this.unk154 = 49; }
    getEpilogueValue() { return EPILOGUE[this.unk154]; }
    updateEpilogueFrame() { if (this.unk154 < 49) this.unk154++; }
    /** getAnmMtx(j)'s translation (the last calc's), or its position without a skeleton */
    jointTrans(j: number) { const m = this.joints && j >= 0 ? this.joints[j] : null; return m ? new V3(fr(m[12]), fr(m[13]), fr(m[14])) : this.pos.clone(); }
    calcRootMatrix() {
        this.updateEpilogueFrame();
        const m = this.baseTR, z = this.unk170;
        const side = new V3().cross(new V3(0, 1, 0), z).fround();   // (cross2)
        m[0] = side.x; m[4] = side.y; m[8] = side.z;
        m[1] = 0; m[5] = 1; m[9] = 0;
        m[2] = z.x; m[6] = z.y; m[10] = z.z;
        m[3] = this.pos.x; m[7] = this.pos.y; m[11] = this.pos.z;
        const c = this.jointTrans(sCenterJointIndex);
        this.unk17C.set(c.x, this.pos.y, c.z);
        this.calcJoints();   // (the model's calc after it: setBaseScale / setBaseTRMtx)
    }
    /** J3DModel::calc with the walk's motion blend */
    calcJoints() {
        const a = this.mactor;
        if (!a) return;
        const sk = Skeleton.of(a.data.files.scene(a.model));
        if (!sk) return;
        const bck = (i: number) => { const e = a.data.anms[ANM_BCK][i]; return e ? parseBCK(a.data.files.scene(a.data.folder + '/' + e.name + '.bck')) : null; };
        const fc = a.getFrameCtrl(ANM_BCK), cur = a.getCurAnmIdx(ANM_BCK);
        const nw = cur >= 0 ? { anm: bck(cur), frame: fc ? fc.frame : 0 } : null;
        // TODO: TMotionBlendCtrl::execSimpleMotionBlend also takes its step (unk4) off the ratio before the calc; not known here
        const old = this.mc.oldIdx >= 0 && this.mc.ratio > 0 ? { anm: bck(this.mc.oldIdx), frame: this.mc.oldFrame } : null;
        this.joints = jointMatricesBlend(sk, nw, old, old ? this.mc.ratio : 0, false, this.baseTR, [this.scale.x, this.scale.y, this.scale.z], this.joints || [], this.locals);
    }
    isDamageable() {
        if (this.unk1A0 > 0) return false;
        const n = this.spine!.getLatestNerve();
        return n === MantaNerves.move || n === MantaNerves.hitWater;
    }
    isPolluting() { return true; }   // (every generation's entry is true)
    getPolluteRadius() {
        switch (this.mGeneration) {
            case 0: case 1: case 2: case 3: return fr(this.MP.mSLPolluteRadius * this.scale.x);
            case 4: case 5: return 100;
        }
        return 0;
    }
    /** updateAttractor: unk164 */
    updateAttractor() {
        const P = this.MP, mgr = this.mantaManager;
        const a = V3.sub(this.unk158, this.pos); a.y = 0;
        jNormalize(a); a.scale(P.mSLAttractorPower);
        const selfPos = this.pos.clone().add(this.unk170.clone().scale(P.mSLEscapeLookPoint)); selfPos.y = 0;
        for (let i = 0; i < mgr.getActiveObjNum(); ++i) {
            const o = mgr.getObj(i) as BossManta;
            if (this.checkLiveFlag(LF.DEAD) || o.checkLiveFlag(LF.DEAD) || o.instanceIndex === this.instanceIndex) continue;
            const otherPos = o.pos.clone().add(o.unk170.clone().scale(P.mSLEscapeLookedPoint));
            const d = selfPos.clone().sub(otherPos); d.y = 0;
            if (0.1 < len(d) && len(d) < P.mSLEscapeRegion) {
                jNormalize(d);
                d.scale(fr(P.mSLPusherPower / len(d)));
                a.add(d);
            }
        }
        const fromMario = V3.sub(this.pos, this.world.mario.pos); fromMario.y = 0;
        if ((sEscapeFromMario !== 0 || this.mGeneration === 4) && len(fromMario) < 6000) a.add(fromMario);
        a.y = 0;
        const g = new V3();
        if (this.getIntoGraphVec(g)) { g.y = 0; g.scale(10000); a.add(g); }
        this.unk164.set(a);
    }
    drawn() { return !this.checkLiveFlag(LF.DEAD); }
    /** (drawing: TBossManta::drawObject is empty; the manager draws each manta only as its ground shadow, drawMantaShadow) */
    readonly shadowOnly = true;
}

// ================================================================ the extra collisions
/** TBossMantaAdditionalCollision (マンタ追加コリジョン): a cylinder of a big manta's, passing water on to it. */
export class BossMantaAdditionalCollision extends HitActor {
    unk68: BossManta | null = null;
    constructor(public world: World, name = 'マンタ追加コリジョン') {
        super(name);
        this.initHitActor(AT.BOSS_MANTA, 1, HC.PLAYER, 0, 0, 0, 0);
        this.offHitFilter(HF.NO_COLLISION);
        world.addToGroup('オブジェクトグループ', this);
    }
    receiveMessage(sender: HitActor, msg: number) { return this.unk68 ? this.unk68.receiveMessage(sender, msg) : false; }
    setManta(m: BossManta) { this.unk68 = m; }
    perform(cue: number) {
        if (cue & CUE_MOVE) for (const c of this.collisions.slice()) if (c.isActorType(AT.MARIO)) attackMario(this.world, this);
    }
}

/** TBossMantaAdditionalCollisionSet: the body and wing-tip cylinders of one manta. */
export class BossMantaAdditionalCollisionSet {
    unk0: BossMantaAdditionalCollision[] = [];
    unkC: BossManta | null = null;
    constructor(w: World) { for (let i = 0; i < 3; ++i) this.unk0.push(new BossMantaAdditionalCollision(w)); }
    adapt(m: BossManta) {
        this.unkC = m;
        const s = m.scale.x;
        this.unk0[0].setHitParams(fr(54 * s), 100, fr(54 * s), 100);
        this.unk0[1].setHitParams(fr(26 * s), 100, fr(26 * s), 100);
        this.unk0[2].setHitParams(fr(26 * s), 100, fr(26 * s), 100);
        for (const c of this.unk0) c.setManta(m);
    }
    isUsed() { return !!this.unkC && !this.unkC.checkLiveFlag(LF.DEAD); }
    update(cue: number) {
        const m = this.unkC;
        if (!m) return;
        if (m.checkLiveFlag(LF.DEAD)) { this.unkC = null; return; }
        for (const c of this.unk0) c.perform(cue);
        const c = m.jointTrans(sCenterJointIndex), b = m.jointTrans(sBodyJointIndex), r = m.jointTrans(sRwingJointIndex), l = m.jointTrans(sLwingJointIndex);
        const at = (p: V3, k: number) => new V3(fr(fr(k * fr(p.x - c.x)) + c.x), fr(fr(k * fr(p.y - c.y)) + c.y), fr(fr(k * fr(p.z - c.z)) + c.z));
        this.unk0[0].pos.set(at(b, fr(-0.15)));
        this.unk0[1].pos.set(at(r, 0.75));
        this.unk0[2].pos.set(at(l, 0.75));
    }
}

// ================================================================ TBossMantaManager
export class BossMantaManager extends EnemyManager {
    mCollisionSets: BossMantaAdditionalCollisionSet[] = [];
    /** the palms' places (palmOugi 0..6) and the two other spots Mario is safe at */
    unk74: V3[] = []; unk78: V3[] = [];
    unk84 = 0;
    /** TMantaBattleState::mState / TMantaMessageState::unk4 */
    battleState = 0; messageState = 0;
    /** sDefeatSE (TODO: the sim can't tell when the all-death sound ends: taken as ended the tick after) */
    private defeatSE = false;
    constructor(w: World, name = 'ボスマンタマネージャ') { super(w, name); }
    get MP(): MantaParams { return this.saveParams; }
    load(s: Stream) { this.saveParams = readParams('/enemy/bossmanta.prm', this.world.files, MANTA_PARAMS); super.load(s); }
    loadAfter() {
        // (loadEffects: the particles)
        this.unk74 = [];
        for (let i = 0; i < 7; ++i) {
            const palm = this.world.search('palmOugi ' + i) as LiveActor | null;
            this.unk74.push(palm ? new V3(palm.pos.x, 0, palm.pos.z) : new V3(0, 0, 0));   // (the game takes them as there)
        }
        this.unk78 = [new V3(1549, 0, -435), new V3(-1457, 0, -533)];
        this.battleState = 0; this.messageState = 0; this.unk84 = 0;
        sEscapeFromMario = 0;
    }
    createModelData() { this.createModelDataArray(['manta.bmd']); }
    createEnemyInstance(): SpineEnemy | null { return new BossManta(this.world); }
    createEnemies(num: number) {
        if (num + this.getObjNum() > this.capacity) num = this.capacity - this.getObjNum();
        if (this.saveParams) { const limit = this.MP.mSLInstanceNum & 0xFF; if (num + this.getObjNum() > limit) num = limit - this.getObjNum(); }
        if (num >= 0) for (let i = 0; i < num; ++i) this.createEnemy();
    }
    createEnemy() {
        const e = this.createEnemyInstance();
        if (!e) return;
        this.world.addToGroup('オブジェクトグループ', e);
        e.init(this);
    }
    initAdditionalCollision() { this.mCollisionSets = []; for (let i = 0; i < 8; ++i) this.mCollisionSets.push(new BossMantaAdditionalCollisionSet(this.world)); }
    adaptAdditionalCollision(m: BossManta) { for (const s of this.mCollisionSets) if (!s.isUsed()) { s.adapt(m); return; } }
    getDeadEnemy() { const n = this.getActiveObjNum(); for (let i = 0; i < n; i++) if ((this.getObj(i) as LiveActor).checkLiveFlag(LF.DEAD)) return this.getObj(i) as BossManta; return null; }
    /** spawn: generation gen's mantas round pos, spread evenly from a random angle */
    spawn(gen: number, pos: V3) {
        const count = [1, 2, 3, 4, 4][gen];
        const p = pos.clone();
        const baseAngle = fr(PI_F * fr(2 * MsRandF()));
        for (let i = 0; i < count; ++i) {
            const m = this.getDeadEnemy();
            if (!m) return;
            const angle = fr(baseAngle + fr(fr(fr(2 * i) * PI_F) / count));
            // TODO: the game's mult() adds an unset matrix translation (whatever was on the stack); taken as 0
            m.unk170.set(fr(Math.sin(angle)), 0, fr(Math.cos(angle)));
            m.pos.set(p);
            m.initNthGeneration(gen);
        }
    }
    flagMantaSpawned() { return this.world.flags.getBool(MSF_MANTA_SPAWNED); }
    /** TMantaBattleState::update */
    updateBattle() {
        switch (this.battleState) {
            case 0:
                if (this.flagMantaSpawned()) {
                    this.world.effect('demo:sirena_manta', this.world.mario.pos);
                    if (this.world.talk) this.world.talk.fireStartDemoCamera('sirena_manta');
                    (this.getObj(0) as BossManta | undefined)?.initNthGeneration(0);
                    // (MSBgm::stopTrackBGMs)
                    this.battleState++;
                }
                break;
            case 1: {
                let allMaxGen = true;
                for (let i = 0; i < this.getActiveObjNum(); ++i) {
                    const m = this.getObj(i) as BossManta;
                    if (m.checkLiveFlag(LF.DEAD)) continue;
                    if (m.mGeneration !== 4) { allMaxGen = false; break; }
                }
                if (allMaxGen) {
                    for (let i = 0; i < this.getActiveObjNum(); ++i) { const m = this.getObj(i) as BossManta; if (!m.checkLiveFlag(LF.DEAD)) m.initNthGeneration(5); }
                    this.battleState++;
                }
                break;
            }
            case 2: {
                let victory = true;
                for (let i = 0; i < this.getActiveObjNum(); ++i) {
                    const m = this.getObj(i) as BossManta;
                    if (m.mGeneration !== 5 || m.checkLiveFlag(LF.DEAD)) continue;
                    victory = false; break;
                }
                if (victory) {
                    this.defeatSE = true;
                    this.world.sound(SE.BS_MANTA_ALL_DEATH, null);
                    this.battleState++;
                }
                break;
            }
            case 3:
                if (!this.defeatSE) {
                    const sink = this.world.search('イベント（ホテル沈む）') as any;
                    if (sink) sink.unk64 = true;   // (TMapEventSirenaSink)
                    this.battleState++;
                }
                this.defeatSE = false;
                break;
        }
    }
    /** TMantaMessageState::update */
    updateMessage() {
        switch (this.messageState) {
            case 0: { const m = this.getObj(0) as BossManta | undefined; if (m && m.isSpawnState()) { this.world.effect('balloon:e000c', this.world.mario.pos); this.messageState++; } break; }
            case 1: {
                let alive = 0;
                for (let i = 0; i < this.getActiveObjNum(); ++i) if (!(this.getObj(i) as LiveActor).checkLiveFlag(LF.DEAD)) alive++;
                if (alive > 50) { this.world.effect('balloon:e000d', this.world.mario.pos); this.messageState++; }
                break;
            }
            case 2: if (this.battleState === 2) { this.world.effect('balloon:e000e', this.world.mario.pos); this.messageState++; } break;
        }
    }
    updateMantaEscape() {
        sEscapeFromMario = 0;
        const mp = this.world.mario.pos.clone(); mp.y = 0;
        for (const p of this.unk74) if (Math.sqrt(sqd(p, mp)) < 350) sEscapeFromMario = 1;
        for (const p of this.unk78) if (Math.sqrt(sqd(p, mp)) < 820) sEscapeFromMario = 1;
    }
    perform(cue: number) {
        super.perform(cue);
        // (CUE_DRAW: drawMantaShadow)
        if (cue & CUE_MOVE) { this.updateBattle(); this.updateMessage(); this.updateMantaEscape(); }
        for (const s of this.mCollisionSets) s.update(cue);
    }
}

register('BossManta', (w, n) => new BossManta(w, n));
register('BossMantaManager', (w, n) => new BossMantaManager(w, n));
