// Gelato Beach's map objects (MoveBG/MapObjMamma.cpp; stages mamma0-7, mam_ex0/1):
// - TSandLeafBase / TSandLeaf: a sand sprout (すなやまの芽) on its flat base. Sprayed, the base
//   rises (unk138 a tick, collision switched to its grown one); TSandBase::withering takes it
//   back down, then the sprout comes back out after unk140 ticks.
// - TSandBombBase / TSandBomb: the sand bombs. Spraying the bomb (すなやま爆弾) runs its water BCK
//   on; at its end the bomb ignites (grow), the base waits unk148 ticks, explodes (the sand shape
//   shoots up, collision on, Mario thrown up by how near he is), holds its shape while the bomb's
//   "up" BCK plays back at unk150, then withers away and comes back after unk140 ticks. The base's
//   rise (its root matrix's Y scale) is what SMS_GetSandRiseUpRatio reads (watermelons, NPCs).
// - TSandCastle: Shine 1's sand castle: a sand bomb (砂の城爆発の芽) whose explosion runs the demo
//   (mamma1_sandcastle) and opens the stage change (ステージ切替（砂の城）) until it crumbles.
// - TLeanMirror / TShiningStone: the episode-2 mirrors (mirrorS/M/L): stood on, trampled or
//   ground-pounded they tilt (unk14C a tilt speed, damped by unk15C, bounced back past unk174);
//   when every Chuu Hana on one has let go (unk19C), it turns to face the Shine stone (太陽石) and
//   lights it; with all three lit, the sleeping Hanachan boss falls.
// - TMammaBlockRotate: the tower's turning block (太陽の塔ブロック): sprayed it turns, past mRotEnd
//   the map's two blocks sink (their collision with them) for mWaitTime and rise back.
// - TMammaYacht: bobs with the sea and carries its flag (MammaYacht00).
// - TSandBird: the big sand bird (TJointCoin over SandBirdRail.bmd) carrying its sand blocks.
// - TGoalWatermelon: the watermelon contest's goal: the watermelon (fruit.ts TBigWatermelon)
//   touching it shrinks and Shine (お化けスイカ用) appears. TSandEgg / MammaSurfboard: plain objects.
//
// Not here: particles (told as world effects), rumble, BGM changes, the help balloons, the demo
// cameras' callbacks (they are told as 'demoCamera' events), gpTargetArrow, the beam cone the
// mirrors draw, TMirrorModelObj / TMirrorActor (mirror drawing), TMammaMirrorMapOperator's work (it
// only shows / hides the in-mirror map's joint 2 for drawing, by the camera's distance to the
// mirror in use: registered as a plain object, MammaMirrorMapOperator below), the Shine stone's own models are
// kept (their BCKs set) but not drawn by the viewer.

import { fr, V3, Mtx, mtx, MsMtxSetXYZRPH } from '../math.js';
import { World, HitActor, LiveActor, Actor, Stream, MActor, AnmData, LF, HF, MSG, CUE_CALC_ANIM, ANM_FRAME_RATE, ANM_BPK, ANM_BTK, ANM_BRK } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { Skeleton } from '../skeleton.js';
import { MapObjBase, MOF, STATE_NORMAL, UNIQUE_MAKERS, newAndRegisterObj, mapObjGlobals } from './base.js';
import { ObjCollision, KIND_MOVE } from './objcol.js';
import { JointCoin } from './ex.js';
import { MapObjFlag } from './view.js';
import { MTXConcat, MTXRotAxisRad, setRootMtx, mapObjWave, marioGroundLevel, marioGroundPlane, marioTouchGround4cm, sendToMario } from './lib.js';
import './item.js';

const demoCamera = (w: World, name: string, p: V3 | null, frames = -1) => w.events.push({ t: w.tickCount, kind: 'demoCamera', data: { name, p: p ? p.clone() : null, frames } });
/** (fabricated) addAnmFrame: frame ctrl `type` of the actor's model moved on by speed */
function addAnmFrame(o: LiveActor, type: number, speed: number) {
    const fc = o.mactor && o.mactor.getFrameCtrl(type);
    if (fc) fc.frame = fr(speed + fc.frame);
}
const frameOf = (o: LiveActor, type: number) => { const fc = o.mactor && o.mactor.getFrameCtrl(type); return fc ? fc.frame : 0; };
const setFrame = (o: LiveActor, type: number, f: number) => { const fc = o.mactor && o.mactor.getFrameCtrl(type); if (fc) fc.frame = f; };
/** TMapObjBase::soundBas: the sound when the BCK passes `frame` this tick */
function soundBas(o: MapObjBase, id: number, frame: number, rate: number) {
    const cur = frameOf(o, 0);
    if (cur <= frame && frame < cur + rate) o.world.sound(id, o.pos);
}
/** TMapObjBase::concatOnlyRotFromLeft(a, b, out): a * b with b's translation kept */
function concatOnlyRotFromLeft(a: Mtx, b: Mtx, out: Mtx) {
    const t0 = b[3], t1 = b[7], t2 = b[11];
    b[3] = 0; b[7] = 0; b[11] = 0;
    MTXConcat(a, b, out);
    out[3] = t0; out[7] = t1; out[11] = t2;
}
/** TMapObjBase::makeMtxRotByAxis: TPosition3f::setRotate(axis, angle)'s rotation part */
function makeMtxRotByAxis(axis: V3, angle: number, out: Mtx) {
    const r = mtx();
    MTXRotAxisRad(r, axis, angle);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i * 4 + j] = r[i * 4 + j];
}
/** MsAngleBetween */
function MsAngleBetween(a: V3, b: V3) {
    const c = new V3().cross(a, b);
    return fr(Math.abs(Math.atan2(fr(c.length()), fr(a.dot(b)))));
}
/** JGeometry::TVec3::isZero */
const isZero = (v: V3) => v.squared() <= 32 * 1.1920929e-7;

// ---------------------------------------------------------------- TSandLeaf
export class SandLeaf extends MapObjBase {
    unk138: SandBase | null = null;
    constructor(w: World, name = 'すなやまの芽') { super(w, name); }
    touchWater(_a: HitActor) { this.unk138!.grow(); return 1; }
    control() {
        super.control();
        const [h, d] = this.world.checkGround(this.pos.x, fr(this.pos.y + 200), this.pos.z);
        this.groundHeight = h; this.groundPlane = d;
        this.pos.y = h;
    }
}

// ---------------------------------------------------------------- TSandBase
export const SAND = { WITHERING: 0x2, WITHERED: 0x3, GROWN: 0x4, SPROUTING: 0x5 };
export abstract class SandBase extends MapObjBase {
    static mWitherTime = 800;
    static mScaleMin = fr(0.00001);
    /** unk138 the rise a tick, unk13C the wither a tick, unk140 the time before it comes back, unk144 its sprout / bomb */
    unk138 = 0; unk13C = 0; unk140 = 0;
    unk144: MapObjBase | null = null;
    abstract grow(): void;
    isDown() { return false; }
    withering(): boolean {
        this.scale.y = fr(this.scale.y - this.unk13C);
        if (this.scale.y < SandBase.mScaleMin) this.scale.y = SandBase.mScaleMin;
        this.world.sound(SE.OBJ_SANDBUD_NORMAL, this.unk144!.pos);
        return this.scale.y <= SandBase.mScaleMin;
    }
}

// ---------------------------------------------------------------- TSandLeafBase
export class SandLeafBase extends SandBase {
    constructor(w: World, name = 'すなやまの芽の土台') { super(w, name); }
    grow() {
        if (this.state !== STATE_NORMAL && this.state !== SAND.GROWN) return;
        if (this.scale.y >= 1) return;
        this.scale.y = fr(this.scale.y + this.unk138);
        if (this.scale.y > 1) this.scale.y = 1;
        if (this.state === STATE_NORMAL) {
            this.colMgr!.changeCollision(1);
            this.colMgr!.setUpActiveCollisionTRS(this.pos, this.rot, this.scale);
            this.unk144!.startControlAnim(2);
            this.state = SAND.GROWN;
        }
        addAnmFrame(this.unk144!, 0, ANM_FRAME_RATE);
        this.world.sound(SE.OBJ_SANDBUD_NORMAL, this.unk144!.pos);
        this.stateTimer = SandBase.mWitherTime;
    }
    control() {
        super.control();
        const leaf = this.unk144!;
        switch (this.state) {
            case SAND.WITHERING:
                if (this.withering()) {
                    this.colMgr!.changeCollision(0);
                    this.colMgr!.setUpActiveCollisionTRS(this.pos, this.rot, this.scale);
                    this.stateTimer = this.unk140;
                    this.state = SAND.WITHERED;
                }
                break;
            case SAND.WITHERED:
                if (!this.isStateTimerEngaged() && leaf.animIsFinished()) {
                    leaf.awake();
                    leaf.startAnim(1);
                    this.world.sound(SE.IT_COMMON_APPEAR, leaf.pos);
                    this.state = SAND.SPROUTING;
                }
                break;
            case SAND.SPROUTING:
                if (leaf.animIsFinished()) { leaf.startAnim(0); this.state = STATE_NORMAL; }
                break;
            // TODO: the decomp has no SAND.GROWN case: nothing here starts the withering once mWitherTime runs out
        }
    }
    initMapObj() {
        this.unk138 = fr(0.003); this.unk13C = fr(0.001); this.unk140 = 0;
        this.scale.y = SandBase.mScaleMin;
        super.initMapObj();
        this.unk144 = newAndRegisterObj(this.world, 'SandLeaf', this.pos, this.rot, new V3(1, 1, 1));
        (this.unk144 as SandLeaf).unk138 = this;
        this.unk144!.appear();
    }
}

// ---------------------------------------------------------------- TSandBomb
export class SandBomb extends SandLeaf {
    unk13C = 0; unk140 = 0;
    constructor(w: World, name = 'すなやま爆弾') { super(w, name); }
    makeObjAppeared() {
        super.makeObjAppeared();
        this.startControlAnim(1);
        this.startControlAnim(2);
    }
    touchWater(_a: HitActor) {
        const r = SandBombBase.mFiringFrameSpeed;
        addAnmFrame(this, 0, r);
        addAnmFrame(this, 5, r);
        soundBas(this, SE.OBJ_SANDBOMB_WATER_1, 7, r);
        soundBas(this, SE.OBJ_SANDBOMB_WATER_2, 50, r);
        soundBas(this, SE.OBJ_SANDBOMB_WATER_3, 100, r);
        soundBas(this, SE.OBJ_SANDBOMB_WATER_4, 150, r);
        if (!this.mactor || this.mactor.curAnmEndsNext(0)) {
            this.unk138!.grow();
            this.startControlAnim(3);
            this.startControlAnim(4);
            this.startControlAnim(5);
            this.onHitFilter(HF.NO_COLLISION);
        }
        return 1;
    }
    getSDLModelFlag() { return 0; }
}

// ---------------------------------------------------------------- TSandBombBase
export const SBB = { GROW: 0x5, WAIT_BEFORE_EXPLODE: 0x6, EXPLODING: 0x7, EXPANDED: 0x8 };
export class SandBombBase extends SandBase {
    static mFiringFrameSpeed = 3;
    static mFiringFrameDownSpeed = fr(0.2);
    static mExplodeFrameSpeed = 1;
    static mMarioJumpRate = fr(0.12);
    static mExlodingRumbleTime = 20;
    /** unk148 the wait before exploding, unk14C the particle's scale, unk150 the bomb's way back speed, unk154 how far Mario is thrown from */
    unk148 = 0; unk14C = 1; unk150 = 0; unk154 = 0;
    constructor(w: World, name = 'すなやま爆弾の土台') { super(w, name); }
    isFootHandOrStairs() { return this.isActorType(AT.SAND_BOMB_BASE_FOOT); }
    withered() {
        this.stateTimer = this.unk140;
        this.state = SAND.WITHERED;
        this.unk144!.sleep();
    }
    expanded() {
        addAnmFrame(this.unk144!, 0, this.unk150);
        this.world.sound(SE.OBJ_SAMDBOMB_REVERSE, this.unk144!.pos);
        if (this.unk144!.animIsFinished()) this.state = SAND.WITHERING;
    }
    exploding() {
        const w = this.world, S = SandBombBase.mExplodeFrameSpeed;
        addAnmFrame(this, 0, S);
        addAnmFrame(this.unk144!, 0, S);
        const dist = this.getDistanceXZ(w.mario.pos);
        if (!this.isFootHandOrStairs() && frameOf(this, 0) < 80 && marioGroundLevel(w) > w.mario.pos.y - 30 && dist < this.unk154) {
            sendToMario(w, this, MSG.THROWN);
            const m = w.mario as any;
            if (typeof m.throwMario === 'function') m.throwMario(new V3(0, 1, 0), fr(SandBombBase.mMarioJumpRate * fr(this.unk154 - dist)));   // SMS_ThrowMario
        }
        if (this.animIsFinished()) { this.unk144!.startControlAnim(6); this.state = SBB.EXPANDED; }
    }
    /** (both explodes' shared start) */
    protected explodeBase() {
        const w = this.world;
        this.startControlAnim(1);
        this.scale.y = 1;
        this.colMgr!.changeCollision(1);
        this.colMgr!.getActiveCollision()!.setUp();
        this.colMgr!.moveActiveCollisionSRT(this.pos, this.rot, this.scale);
        w.effect('SandBomb', this.pos, new V3(this.unk14C, this.unk14C, this.unk14C));
        if (!w.demoMode) w.events.push({ t: w.tickCount, kind: 'cameraShake', data: { mode: 0xD, power: 1, p: this.pos.clone() } });
        w.sound(SE.OBJ_SANDBOMB_BANG, this.pos);
        this.state = SBB.EXPLODING;
    }
    explode() { this.explodeBase(); }
    waitBeforeExplode() { this.state = SBB.WAIT_BEFORE_EXPLODE; this.stateTimer = this.unk148; }
    grow() { this.state = SBB.GROW; }
    control() {
        super.control();
        const bomb = this.unk144 as SandBomb;
        switch (this.state) {
            case STATE_NORMAL: {
                const f = fr(frameOf(bomb, 0) - SandBombBase.mFiringFrameDownSpeed);
                if (f >= 0) { setFrame(bomb, 0, f); setFrame(bomb, 5, f); }
                break;
            }
            case SBB.GROW: {
                const S = SandBombBase.mExplodeFrameSpeed;
                addAnmFrame(bomb, 0, S);
                addAnmFrame(bomb, 5, S);
                addAnmFrame(bomb, 3, S);
                if (bomb.animIsFinished()) this.waitBeforeExplode();
                break;
            }
            case SBB.WAIT_BEFORE_EXPLODE: if (!this.isStateTimerEngaged()) this.explode(); break;
            case SBB.EXPLODING: this.exploding(); break;
            case SBB.EXPANDED: this.expanded(); break;
            case SAND.WITHERING: if (this.withering()) this.withered(); break;
            case SAND.WITHERED:
                if (!this.isStateTimerEngaged()) {
                    this.state = STATE_NORMAL;
                    bomb.awake();
                    bomb.startControlAnim(1);
                    bomb.startControlAnim(2);
                }
                break;
        }
        if (bomb.collisions.length === 0) bomb.unk140 = 0;
    }
    findTriggerActor(): MapObjBase | null { return newAndRegisterObj(this.world, 'SandBomb', this.pos, this.rot, new V3(1, 1, 1)); }
    loadAfter() {
        this.unk144 = this.findTriggerActor();
        if (!this.unk144) return;
        (this.unk144 as SandLeaf).unk138 = this;
        this.unk144.appear();
    }
    initMapObj() {
        this.unk138 = fr(0.006); this.unk13C = fr(0.005); this.unk140 = 0; this.unk148 = 60; this.unk154 = 1000;
        this.scale.y = SandBase.mScaleMin;
        super.initMapObj();
        this.unk150 = fr(0.5);
        switch (this.individualName) {
            case 'SandBombBasePyramid': this.unk14C = fr(1.3); this.unk154 = 1200; break;
            case 'SandBombBaseShit': this.unk14C = fr(1.3); this.unk154 = 1500; break;
            case 'SandBombBaseStar': case 'SandBombBaseTurtle': this.unk14C = fr(1.2); break;
        }
    }
}

// ---------------------------------------------------------------- TSandCastle
export class SandCastle extends SandBombBase {
    static mCollisionRate = fr(1.7);
    /** unk158 the stage change into the castle */
    unk158: MapObjBase | null = null;
    unk15C = 0;
    constructor(w: World, name = '砂の城') { super(w, name); }
    withering() {
        addAnmFrame(this, 0, this.unk13C);
        addAnmFrame(this, 5, this.unk13C);
        const fc = this.mactor && this.mactor.getFrameCtrl(0);
        const f = fc ? fc.frame : 0, end = fc ? fc.end : 1;
        this.scale.y = fr(SandCastle.mCollisionRate * fr(fr(end - f) / end));
        if (f > 240 && this.unk158 && !this.unk158.checkLiveFlag(LF.DEAD)) this.unk158.kill();   // (gpTargetArrow->unk14 = 0)
        if (this.animIsFinished()) { this.sleep(); return true; }
        return false;
    }
    expanded() {
        super.expanded();
        if (this.unk144!.animIsFinished()) {
            this.state = SAND.WITHERING;
            this.startControlAnim(2);
            this.startControlAnim(3);
        }
    }
    explode() {
        this.explodeBase();
        this.awake();
        if (this.unk158) this.unk158.appear();
        this.startControlAnim(3);
    }
    waitBeforeExplode() {
        super.waitBeforeExplode();
        // (SandCastleCallBack: the target arrow at the castle, the camera warped)
        demoCamera(this.world, 'mamma1_sandcastle', null);
        this.unk15C = 1;
    }
    calcRootMatrix() { if (!this.isState(SAND.WITHERING)) super.calcRootMatrix(); }
    findTriggerActor() { return this.world.search('砂の城爆発の芽') as MapObjBase | null; }
    loadAfter() {
        super.loadAfter();
        this.unk158 = this.world.search('ステージ切替（砂の城）') as MapObjBase | null;
        if (this.unk158) this.unk158.makeObjDead();
    }
    initMapObj() {
        super.initMapObj();
        this.unk13C = fr(0.11);
        this.unk148 = 120;
        this.sleep();
    }
}

// ---------------------------------------------------------------- TShiningStone
export class ShiningStone extends HitActor {
    /** unk68 the green / blue / red / white stones, unk6C the stone; unk70-73 which are lit, unk74 how many */
    unk68: MActor[] = [];
    unk6C: MActor | null = null;
    unk70 = 0; unk71 = 0; unk72 = 0; unk73 = 0;
    unk74 = 0;
    unk7C = 0;
    /** the models' base matrix */
    baseMtx: Mtx = mtx();
    constructor(public world: World, name = '太陽石') { super(name); }
    endDemo() {
        // (unk74 < 3: the BGM's track back up; unk7C > 0: the glow emitter slowed to it)
    }
    putOnLight(mirror: LiveActor) {
        const n = mirror.name;
        if (n === 'mirrorS') { this.setAnm(0, 'shiningstonegreen'); this.unk70 = 1; }
        else if (n === 'mirrorM') { this.setAnm(1, 'shiningstoneblue'); this.unk71 = 1; }
        else if (n === 'mirrorL') { this.setAnm(2, 'shiningstonered'); this.unk72 = 1; }
        switch (this.unk74) {
            case 0: this.world.effect('ShiningStone1', this.pos); this.unk7C = fr(1.5); this.world.sound(SE.DM_REFLECTION_1, this.pos); break;
            case 1: this.world.effect('ShiningStone2', this.pos); this.unk7C = fr(0.2); this.world.sound(SE.DM_REFLECTION_2, this.pos); break;
            case 2: this.world.effect('ShiningStone3', this.pos); this.unk7C = 0; this.world.sound(SE.DM_REFLECTION_3, this.pos); break;
        }
        this.world.effect('ShiningStoneF', this.pos);
        ++this.unk74;
        if (this.unk74 === 3) { this.setAnm(3, 'shiningstonewhite'); this.unk73 = 1; }
    }
    private setAnm(i: number, name: string) { const a = this.unk68[i]; if (a) { a.setBck(name); a.setAnimation(name, ANM_BRK); } }   // setBck / setBrk
    perform(cue: number) {
        if (!(cue & CUE_CALC_ANIM)) return;
        for (const a of this.unk68) a.frameUpdate();
        if (this.unk6C) this.unk6C.frameUpdate();
    }
    load(s: Stream) {
        Actor.prototype.load.call(this, s);
        const g = mapObjGlobals(this.world).mapObjManager;
        const anm = g ? g.getMActorAnmData() : new AnmData('mapobj', this.world.files);
        MsMtxSetXYZRPH(this.baseMtx, this.pos.x, this.pos.y, this.pos.z, this.rot.x, this.rot.y, this.rot.z);
        for (const f of ['ShiningStoneGreen', 'ShiningStoneBlue', 'ShiningStoneRed', 'ShiningStoneWhite']) this.unk68.push(new MActor(`mapobj/${f.toLowerCase()}.bmd`, anm));
        this.unk6C = new MActor('mapobj/shiningstone.bmd', anm);
        this.unk6C.setAnimation('shiningstone', ANM_BPK); this.unk6C.setAnimation('shiningstone', ANM_BTK);
        this.world.conductor.others.push(this);
    }
}

// ---------------------------------------------------------------- TLeanMirror
export const LMS = { GO_TARGET: 0x2, LIGHT_DEMO: 0x3, DONE: 0x4 };
export class LeanMirror extends MapObjBase {
    static mGoTargetTime = 600;
    static mDemoWaitTime = -1;
    static mDemoLightTime = 360;
    /** unk138 / unk13C half its size (x 100), unk14C its tilt speed */
    unk138 = 0; unk13C = 0;
    unk140 = new V3(); unk14C = new V3();
    /** unk158 tilt per speed, unk15C damping, unk160-170 how hard Mario's standing, trampling, ground-pounding, a Chuu Hana, a super ground-pound push, unk174 the most it tilts (its up's Y), unk178 the bounce */
    unk158 = 0; unk15C = 0; unk160 = 0; unk164 = 0; unk168 = 0; unk16C = 0; unk170 = 0; unk174 = 0; unk178 = 0;
    unk17C: ShiningStone | null = null;
    /** unk180 the way to the stone, unk18C the axis it turns about to face it, unk198 the turn a tick */
    unk180 = new V3(); unk18C = new V3(); unk198 = 0;
    /** unk19C the Chuu Hanas still on it */
    unk19C = 0;
    /** unk1A0 where Mario is put when it turns */
    unk1A0 = new V3();
    unk1AC = 0; unk1AE = 0;
    /** getModel()->getBaseTRMtx(): the last root matrix set (its model's calc is off: the root matrix is its own) */
    private baseMtx: Mtx | null = null;
    constructor(w: World, name = 'ぐらぐら鏡') { super(w, name); }
    /** getModel()->getAnmMtx(0) */
    private anm(): Mtx {
        if (!this.anmMtx0) { this.anmMtx0 = Float64Array.from(this.rootMtx()); this.baseMtx = Float64Array.from(this.anmMtx0); }
        return this.anmMtx0;
    }
    private setBaseTRMtx(m: Mtx) { this.baseMtx = Float64Array.from(m); setRootMtx(this, m); }
    enemyIsOn() { return this.unk19C !== 0; }
    updateSpeedVec(p: V3, rate: number) {
        const m = this.anm();
        const dx = fr(fr(p.x - this.pos.x) / Math.abs(fr(this.unk138 * m[0])));
        const dz = fr(fr(p.z - this.pos.z) / Math.abs(fr(this.unk138 * m[10])));
        this.unk14C.x = fr(this.unk14C.x + fr(rate * fr(dx - m[1])));
        this.unk14C.z = fr(this.unk14C.z + fr(rate * fr(dz - m[9])));
    }
    /** sendMsg: to the colliding actors of that type */
    private sendMsg(t: number, msg: number) { for (const c of this.collisions.slice()) if (c.isActorType(t)) c.receiveMessage(this, msg); }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (msg === MSG.TRAMPLE) { this.sendMsg(AT.CHUU_HANA, msg); this.updateSpeedVec(sender.pos, this.unk164); return true; }
        if (msg === MSG.HIP_DROP) { this.sendMsg(AT.CHUU_HANA, msg); this.updateSpeedVec(sender.pos, this.unk168); return true; }
        if (msg === MSG.SUPER_HIP_DROP) { this.updateSpeedVec(sender.pos, this.unk170); return true; }
        if (msg === MSG.DETACH) { --this.unk19C; if (this.unk19C === 0) this.release(); return true; }
        return false;
    }
    touchPlayer(p: HitActor) {
        if (this.isState(STATE_NORMAL) && this.marioIsOn()) {
            this.updateSpeedVec(p.pos, this.unk160);
            if (!this.unk1AC) this.unk1AC = 1;   // (MSBgm: the extra BGM started)
        }
    }
    touchEnemy(e: HitActor) {
        if (e.isActorType(AT.CHUU_HANA) && (e as any).unk1B0) this.updateSpeedVec(e.pos, this.unk16C);
    }
    calcCurrentMtx(m: Mtx) {
        const v = new V3(this.unk14C.x, 0, this.unk14C.z);
        // rotateVecByAxisY(axis, pi/2)
        const s = fr(Math.sin(1.5707963)), c = fr(Math.cos(1.5707963));
        const axis = new V3(fr(c * v.x + s * v.z), 0, fr(-s * v.x + c * v.z));
        const len = fr(Math.sqrt(fr(this.unk14C.x * this.unk14C.x + this.unk14C.z * this.unk14C.z)));
        const speed = fr(len * this.unk158);
        const rot = mtx();
        makeMtxRotByAxis(axis, speed, rot);
        concatOnlyRotFromLeft(rot, m, m);
    }
    release() {
        const w = this.world, m = this.anm();
        const up = new V3(m[1], m[5], m[9]);
        this.unk18C.cross(up, this.unk180);
        this.unk198 = fr(MsAngleBetween(up, this.unk180) / LeanMirror.mGoTargetTime);
        this.stateTimer = LeanMirror.mGoTargetTime;
        this.state = LMS.GO_TARGET;
        this.offMapObjFlag(MOF.MOVE_COLLISION_ON_CONTACT);
        const mm = w.mario as any;
        if (typeof mm.moveRequest === 'function') mm.moveRequest(this.unk1A0.clone());   // SMS_MarioMoveRequest
        const cam = ({ mirrorS: 'ぐらぐら鏡Ｓカメラ', mirrorM: 'ぐらぐら鏡Ｍカメラ', mirrorL: 'ぐらぐら鏡Ｌカメラ' } as Record<string, string>)[this.individualName];
        if (cam && this.unk17C) demoCamera(w, cam, this.unk17C.pos, LeanMirror.mGoTargetTime + LeanMirror.mDemoWaitTime);
        // (MSBgm::stopTrackBGM)
    }
    controlGoTarget() {
        const w = this.world, m = this.anm();
        const rot = mtx();
        makeMtxRotByAxis(this.unk18C, this.unk198, rot);
        concatOnlyRotFromLeft(rot, m, m);
        setRootMtx(this, m);
        if (this.isStateTimerEngaged()) return;
        const st = this.unk17C!;
        st.putOnLight(this);
        if (st.unk73) {
            const h = w.search('居眠りボスハナチャン') as any;
            if (h && typeof h.startFall === 'function') h.startFall(st.pos.x, fr(st.pos.y + 1100), st.pos.z);
            demoCamera(w, 'demohanatyan_cam01', null);   // (startCameraShakeSE: OBJ_QUAKE at the mirror)
        } else demoCamera(w, '太陽石点灯カメラ', st.pos, LeanMirror.mDemoLightTime);
        this.stateTimer = LeanMirror.mDemoLightTime;
        this.state = LMS.LIGHT_DEMO;
    }
    controlShake() {
        const w = this.world;
        if (this.enemyIsOn() && this.unk1AC && marioTouchGround4cm(w) && marioGroundPlane(w).actor !== this) this.unk1AC = 0;   // (the BGM back)
        if (isZero(this.unk14C)) return;
        this.unk14C.scale(this.unk15C);
        const m = this.anm();
        this.calcCurrentMtx(m);
        if (m[5] < this.unk174 && fr(this.unk14C.x * m[1] + this.unk14C.z * m[9]) > 0) {
            w.sound(SE.OBJ_MA_MIRROR_IMPACT, this.pos);
            this.unk14C.scale(-this.unk178);
            m.set(this.baseMtx!);   // MTXCopy(getBaseTRMtx(), anm)
            setRootMtx(this, m);
            return;
        }
        this.setBaseTRMtx(m);
    }
    control() {
        super.control();
        switch (this.state) {
            case STATE_NORMAL: this.controlShake(); this.world.sound(SE.OBJ_MA_MIRROR_MOVE, this.pos); break;
            case LMS.GO_TARGET: this.controlGoTarget(); this.world.sound(SE.OBJ_MA_MIRROR_DEMOMV, this.pos); break;
            case LMS.LIGHT_DEMO:
                if (!this.isStateTimerEngaged()) { this.unk17C!.endDemo(); this.state = LMS.DONE; }
                break;
        }
    }
    loadAfter() {
        super.loadAfter();
        this.unk17C = this.world.search('ShiningStone') as ShiningStone | null;
        if (this.unk17C) this.unk180.set(V3.sub(this.unk17C.pos, this.pos)).normalize();
    }
    getSDLModelFlag() { return 0; }
    initMapObj() {
        super.initMapObj();
        this.unk158 = fr(0.03); this.unk15C = fr(0.999); this.unk160 = fr(0.0001); this.unk168 = 1; this.unk16C = fr(0.0002);
        this.unk170 = fr(0.0001); this.unk174 = fr(0.865); this.unk178 = fr(0.5);
        if (this.individualName === 'mirrorS') { this.unk164 = fr(0.002); this.unk168 = 1; this.unk174 = fr(0.87); this.unk19C = 1; }
        else if (this.individualName === 'mirrorM') { this.unk164 = fr(0.004); this.unk19C = 2; }
        else { this.unk164 = fr(0.006); this.unk19C = 3; }
    }
    load(s: Stream) {
        super.load(s);
        const size = s.f32();
        this.unk138 = fr(fr(100 * size) / 2);
        this.unk13C = this.unk138;
        if (this.world.stage === 1) { s.str(); this.unk1A0.set(s.f32(), s.f32(), s.f32()); }
        // (TMirrorModelObj "/scene/mapObj/<name>Top.bmd": the mirror's picture)
        if (this.world.stage !== 1) this.state = LMS.DONE;
    }
}

// ---------------------------------------------------------------- TMammaBlockRotate
/** A map BMD joint's bounding box (JNT1's min / max) and rest translation, and its TJointModel children (the joint hierarchy) */
function mapJoints(w: World) {
    const b = w.files.scene('map/map.bmd') || w.files.scene('map/map/map.bmd');
    const sk = Skeleton.of(b);
    if (!b || !sk) return null;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let o = 0x20, jnt1 = -1;
    while (o + 8 <= b.length) {
        const tag = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]), size = v.getUint32(o + 4);
        if (tag === 'JNT1') { jnt1 = o; break; }
        if (!size) break;
        o += size;
    }
    if (jnt1 < 0) return null;
    const dataOff = jnt1 + v.getUint32(jnt1 + 0xC), remap = jnt1 + v.getUint32(jnt1 + 0x10);
    const box = (j: number) => {
        const d = dataOff + v.getUint16(remap + j * 2) * 0x40;
        return { minY: v.getFloat32(d + 0x2C), maxY: v.getFloat32(d + 0x38), transY: v.getFloat32(d + 0x1C) };
    };
    const child = (j: number, i: number) => sk.order.filter((k) => sk.parent[k] === j)[i] ?? -1;
    const root = sk.order.find((k) => sk.parent[k] === -1) ?? -1;
    return { box, child, root };
}
export const MBR = { MAP_GO: 0x2, MAP_WAIT: 0x3, MAP_BACK: 0x4 };
export class MammaBlockRotate extends MapObjBase {
    static mRotSpeed = fr(0.1);
    static mRotReturnSpeed = fr(0.01);
    static mRotEnd = 130;
    static mMapGoSpeed = 1;
    static mMapBackSpeed = fr(0.1);
    static mWaitTime = 600;
    /** unk13C / unk140 the map's lower and upper block joints (their Y translation and box height here) */
    unk13C = { transY: 0, h: 0 }; unk140 = { transY: 0, h: 0 };
    unk144: ObjCollision | null = null; unk148: ObjCollision | null = null;
    constructor(w: World, name = '太陽の塔ブロック') { super(w, name); }
    touchWater(_a: HitActor) {
        if (this.isState(STATE_NORMAL)) {
            this.rot.y = fr(this.rot.y + MammaBlockRotate.mRotSpeed);
            if (this.rot.y > MammaBlockRotate.mRotEnd) this.state = MBR.MAP_GO;
        }
        return 1;
    }
    control() {
        super.control();
        switch (this.state) {
            case STATE_NORMAL:
                if (this.rot.y > 0) this.rot.y = fr(this.rot.y - MammaBlockRotate.mRotReturnSpeed);
                else this.rot.y = 0;
                break;
            case MBR.MAP_GO: {
                const s = MammaBlockRotate.mMapGoSpeed;
                this.unk140.transY = fr(this.unk140.transY - s); this.unk13C.transY = fr(this.unk13C.transY - s);   // moveJoint
                const t = new V3(0, this.unk140.transY, 0);
                if (this.unk144) this.unk144.moveTrans(t);
                if (this.unk148) this.unk148.moveTrans(t.clone());
                if (this.unk140.transY < 0) { this.stateTimer = MammaBlockRotate.mWaitTime; this.state = MBR.MAP_WAIT; }
                break;
            }
            case MBR.MAP_WAIT: if (!this.isStateTimerEngaged()) this.state = MBR.MAP_BACK; break;
            case MBR.MAP_BACK: {
                const s = MammaBlockRotate.mMapBackSpeed;
                this.unk140.transY = fr(this.unk140.transY + s); this.unk13C.transY = fr(this.unk13C.transY + s);
                const t = new V3(0, this.unk140.transY, 0);
                if (this.unk144) this.unk144.moveTrans(t);
                if (this.unk148) this.unk148.moveTrans(t.clone());
                if (this.unk140.transY > this.unk140.h) this.state = STATE_NORMAL;
                break;
            }
        }
        // TODO: the map model's two joints (moveJoint) aren't drawn moved: the viewer's map is static
    }
    initMapObj() {
        super.initMapObj();
        const J = mapJoints(this.world);
        // gpMap->getRootJointModel()->getChild(0)->getChild(0)->getChild(0)->getChild(1) / ->getChild(2)
        let base = -1;
        if (J) { base = J.root; for (let i = 0; i < 3 && base >= 0; i++) base = J.child(base, 0); }
        const at = (i: number) => {
            const j = J && base >= 0 ? J.child(base, i) : -1;
            if (!J || j < 0) return { transY: 0, h: 0 };   // TODO: the map's joint not found
            const b = J.box(j), h = fr(b.maxY - b.minY);
            return { transY: fr(b.transY + h), h };
        };
        this.unk13C = at(1);
        if (this.unk144) { this.unk144.setUp(); this.unk144.moveTrans(new V3(0, this.unk13C.h, 0)); }
        this.unk140 = at(2);
        if (this.unk148) { this.unk148.setUp(); this.unk148.moveTrans(new V3(0, this.unk140.h, 0)); }
    }
    load(s: Stream) {
        this.unk144 = new ObjCollision(this.world, KIND_MOVE, this);
        this.unk144.init('/mapObj/MammaBlockDown.col', 0);
        this.unk148 = new ObjCollision(this.world, KIND_MOVE, this);
        this.unk148.init('/mapObj/MammaBlockUp.col', 0);
        super.load(s);
    }
}

// ---------------------------------------------------------------- TMammaYacht
export class MammaYacht extends MapObjBase {
    unk138: MapObjFlag | null = null;
    constructor(w: World, name = '砂の城') { super(w, name); }
    control() {
        super.control();
        if (this.groundPlane && this.groundPlane.isWaterSurface()) {
            const wv = mapObjWave(this.world);
            this.pos.y = fr(this.initialPos.y + (wv ? wv.getWaveHeight(this.pos.x, this.pos.z) : 0));
            if (this.unk138) this.unk138.pos.y = fr(this.pos.y - 50);
        }
    }
    initMapObj() {
        super.initMapObj();
        const f = new MapObjFlag(this.world);
        f.pos.set(fr(this.pos.x + 2), fr(fr(this.pos.y + 1315) - 190), fr(this.pos.z - 15));
        f.rot.set(0, 180, 0);
        f.scale.set(1, fr(2.5), fr(3.8));
        f.init('MammaYacht00');
        this.unk138 = f;
    }
}

// ---------------------------------------------------------------- TSandBird
export class SandBird extends JointCoin {
    unk148 = 0; unk14C = 0; unk150 = 0; unk151 = 0;
    constructor(w: World, name = 'おおすな鳥') { super(w, name); }
    control() {
        super.control();
        const w = this.world;
        w.sound(SE.EN_SANDBIRD_CRY, this.pos);
        w.sound(SE.ENV_SANDBIRD_WIND);
        // (the sand dust particles on its coins and dust joints: ms_sunadori_a / _b)
        // TODO: gpCamera->isDemoCamera(): taken as the director's demo mode
        if (!w.demoMode && !this.unk150) {
            const a = marioGroundPlane(w).actor as any;
            if (a && a.isActorType && a.isActorType(AT.SAND_BIRD_BLOCK)) {
                // (startAppearBalloon(0xE002F): the help balloon)
                this.stateTimer = 2400;
                this.unk150 = 1;
            }
        }
        if (!this.unk151 && this.unk150 && !this.isStateTimerEngaged()) this.unk151 = 1;   // (startDisappearBalloon)
    }
    makeObjFromJointName(name: string, i: number) {
        const o = super.makeObjFromJointName(name, i);
        if (o) return o;
        if (!name.includes('none')) return this.makeObj('SandBirdBlock', i);
        return null;
    }
    nameIsObj(name: string) { return !name.includes('none'); }
}

// ---------------------------------------------------------------- TGoalWatermelon
export const GWS = { SHRINK: 0x2, SHINE: 0x3 };
export class GoalWatermelon extends MapObjBase {
    /** unk138 its Shine, unk13C the watermelon that came, unk140 where the Shine is */
    unk138: MapObjBase | null = null;
    unk13C: MapObjBase | null = null;
    unk140 = new V3();
    constructor(w: World, name = 'スイカゴール') { super(w, name); }
    touchActor(a: HitActor) {
        if (!this.isState(STATE_NORMAL) || !a.isActorType(AT.WATERMELON)) return;
        const m = a as MapObjBase;
        this.unk13C = m;
        if (m.mactor) m.mactor.setBck('watermelon_shrink');
        m.offMapObjFlag(MOF.NO_ANIMATIONS);
        m.vel.set(0, 0, 0);
        demoCamera(this.world, 'スイカゴールカメラ', m.pos);
        this.state = GWS.SHRINK;
    }
    control() {
        super.control();
        if (this.state === GWS.SHRINK && this.unk13C!.animIsFinished()) {
            const im = mapObjGlobals(this.world).itemManager as any;
            if (im && im.makeShineAppearWithDemoOffset) im.makeShineAppearWithDemoOffset('シャイン（お化けスイカ用）', 'スイカシャインカメラ', 0, 0, 0);
            this.state = GWS.SHINE;
        }
    }
    loadAfter() {
        super.loadAfter();
        this.onHitFilter(HF.NO_DAMAGE);
        this.unk138 = this.world.search('シャイン（お化けスイカ用）') as MapObjBase | null;
        if (this.unk138) { this.unk138.pos.set(this.unk140); this.unk138.appear(); }
    }
    load(s: Stream) {
        super.load(s);
        s.str();
        this.unk140.set(s.f32(), s.f32(), s.f32());
    }
}

// ---------------------------------------------------------------- TSandEgg
export class SandEgg extends MapObjBase {
    constructor(w: World, name = 'すなのたまご') { super(w, name); }
    getSDLModelFlag() { return 0; }
}

UNIQUE_MAKERS.set('SandLeaf', (w) => new SandLeaf(w));
UNIQUE_MAKERS.set('SandBomb', (w) => new SandBomb(w));
/**
 * TMammaMirrorMapOperator (鏡内地形操作, scene class MirrorMapOperator): a TViewObj whose perform
 * (CUE_CALC_ANIM) only shows or hides 鏡内地形's joint 2 (SMS_ShowJoint) by the game camera's
 * distance to it and to the mirror the mirror model manager is using. Drawing only, no rand():
 * minimal here (its scene.bin data, an actor's, is read and kept).
 */
export class MammaMirrorMapOperator extends Actor {
    constructor(_w: World, name = '鏡内地形操作') { super(name); }
}
register('MirrorMapOperator', (w, n) => new MammaMirrorMapOperator(w, n));
register('SandLeafBase', (w, n) => new SandLeafBase(w, n));
register('SandBombBase', (w, n) => new SandBombBase(w, n));
register('SandBomb', (w, n) => new SandBomb(w, n));
register('SandCastle', (w, n) => new SandCastle(w, n));
register('LeanMirror', (w, n) => new LeanMirror(w, n));
register('ShiningStone', (w, n) => new ShiningStone(w, n));
register('MammaBlockRotate', (w, n) => new MammaBlockRotate(w, n));
register('MammaSurfboard', (w, n) => new MapObjBase(w, n));
register('MammaYacht', (w, n) => new MammaYacht(w, n));
register('SandBird', (w, n) => new SandBird(w, n));
register('GoalWatermelon', (w, n) => new GoalWatermelon(w, n));
register('SandEgg', (w, n) => new SandEgg(w, n));
