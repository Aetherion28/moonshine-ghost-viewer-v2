// Boos (Enemy/telesa.cpp, テレサ): TTelesa and its kinds (可視テレサ always visible, ループテレサ
// fading in and out on a timer, 箱テレサ the pink one that turns into a block, マリオモドキテレサ the
// one disguised as something else), their manager, and the shadow Mario (カゲマリオモドキ) that
// turns into a Boo when Mario finds it.
//
// A Boo floats over the ground (or its graph's nodes) at a random height, bobbing on a sine
// wave; it goes straight through walls (its own bind(): no wall check). It's invisible unless
// FLUDD's water hits it (it's pushed away from Mario, flinches, and fades in for
// mSLAppearTime ticks before fading out again). A visible Boo can be stomped (dies: its items
// and, every 5th Boo, a big water bottle).
//
// Bianco Hills has one: the マリオモドキテレサ in bianco0. Its imitation nerve only does its
// work in areas 7 and 14 (the hotel / casino): anywhere else it shows its disguise for 500 ticks
// and then is gone (TNerveTelesaImitate).

import { fr, V3, MsSin, MsCos, MsClamp, MsMtxSetXYZRPH } from '../math.js';
import { World, LiveActor, LF, HF, HC, nerve, Spine, Stream, PathNode, ANM_BCK, HitActor, PSchema, MActor, CUE_CALC_ANIM } from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemy, SmallEnemyManager, SmallEnemyNerves, LIVE_FLAG_MELT_ON_DEATH, rangeRand } from './smallEnemy.js';
import { WalkerEnemy, WalkerNerves, walkerParams } from './walker.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';

/** TTelesaSaveLoadParams (TWalkerEnemyParams + the Boo's own) */
const TELESA_PARAMS = {
    mSLFadeInTime: ['i', 60], mSLAppearTime: ['i', 60], mSLFadeOutTime: ['i', 60],
    mSLFlyHeightMax: ['f', 200], mSLFlyHeightMin: ['f', 100], mSLFlyAmplitudeMax: ['f', 100], mSLFlyAmplitudeMin: ['f', 100],
    mSLFlyFrequencyMax: ['f', 200], mSLFlyFrequencyMin: ['f', 100], mSLTelesaGravityY: ['f', 0.1], mSLGenAttackerTime: ['i', 500],
    mSLTelesaAttackGravityY: ['f', 0.01], mSLTelesaPowerByWater: ['f', 40], mSLLoopAppearTime: ['i', 100], mSLLoopHideTime: ['i', 100],
} satisfies PSchema;

/** cTelesaColor: the body's TEV colour (white, and the box Boo's pink) */
const TELESA_COLOR = [[350, 350, 350, 255], [600, 270, 220, 255]];

export const TELESA_TYPE_NORMAL = 0, TELESA_TYPE_LOOP = 1, TELESA_TYPE_CAN_SEE = 2;
export const FADE_STATE_INVISIBLE = 0, FADE_STATE_FADE_IN = 1, FADE_STATE_FADE_OUT = 2, FADE_STATE_VISIBLE = 3;
/** LIGHT_TYPE_INDIRECT / LIGHT_TYPE_OBJECT (MActor::setLightType): the invisible Boo is drawn as a refraction of the screen */
export const LIGHT_TYPE_INDIRECT = 2, LIGHT_TYPE_OBJECT = 0;

export class TelesaManager extends SmallEnemyManager {
    unk60 = 0;
    /** the Boos killed since the last big water bottle */
    unk61 = 0;
    /** mModokiTelesaModel: /scene/telesa/modoki.bmd */
    modokiModel = 'telesa/modoki.bmd';
    constructor(w: World, name = 'テレサマネージャー') { super(w, name); }
    load(s: Stream) {
        const p = walkerParams('/enemy/telesa.prm', this.world.files, TELESA_PARAMS);
        p.unk458 = [p.mSLFlyHeightMin, p.mSLFlyHeightMax];
        p.unk460 = [p.mSLFlyAmplitudeMin, p.mSLFlyAmplitudeMax];
        p.unk468 = [p.mSLFlyFrequencyMin, p.mSLFlyFrequencyMax];
        this.saveParams = p;
        super.load(s);
    }
    createModelData() { this.createModelDataArray(['telesa.bmd']); }
    createEnemyInstance() { return new Telesa(this.world); }
    createEnemies(n: number) {
        super.createEnemies(n);
        // (the TEV colour packets: each Boo's fade colour starts at {0,0,0,0})
        for (const o of this.objs as Telesa[]) o.fadeColor = [0, 0, 0, 0];
    }
    setFlagOutOfCube() {
        for (const t of this.objs as Telesa[]) {
            if (t.unk150 & 0x40) continue;
            const p = t.pos.clone(); p.y += 75;
            if (this.world.inAreaCube(p)) t.offLiveFlag(LF.UNK200); else t.onLiveFlag(LF.UNK200);
        }
    }
    telesaForceKill() {
        let any = false;
        for (const t of this.objs as Telesa[]) if (!t.checkLiveFlag(LF.DEAD)) { t.kill(); any = true; }
        if (any) this.world.sound(SE.EN_TELESA_DISAPPEAR, this.objs[0].pos);
    }
    generatePetBottle(t: Telesa) {
        this.unk61 += 1;
        if (this.unk61 >= 5) {
            this.unk61 = 0;
            // gpItemManager->makeObjAppear(x, y + 20, z, ACTOR_TYPE_BOTTLE_LARGE, true)
            this.world.events.push({ t: this.world.tickCount, kind: 'item', data: { p: new V3(t.pos.x, t.pos.y + 20, t.pos.z), type: AT.BOTTLE_LARGE } });
        }
    }
}

/** The model a disguised Boo shows instead of itself (TSharedParts; drawn standing on the ground under it). */
export class ImitatedParts extends LiveActor {
    constructor(w: World, public owner: Telesa, model: string) {
        super(w, owner.name + ' (imitated)');
        const m = owner.manager!;
        this.mactor = new MActor(model, m.getMActorAnmData());
    }
    init() { }
    perform() { }
    drawn() { return this.owner.imitated === this && !this.owner.checkLiveFlag(LF.UNK200 | LF.DEAD); }
}

export class Telesa extends WalkerEnemy {
    static flyAngMax = 35;
    curFlyHeight = 0; targetFlyHeight = 0; flyBobOffsetY = 50; flyBobAmplitude = 50; flyBobPhase = 0; flyBobFrequency = 0;
    dampenedGroundHeight = 0; groundHeightDampeningSpeed = 0;
    unk1B8 = 0;
    telesaType = TELESA_TYPE_NORMAL;
    fadeLoopTimer = 0;
    /** mImitatedBmd */
    imitated: ImitatedParts | null = null;
    unk1C8 = 0;
    /** mTelesaFadeColor (its alpha is how visible the Boo is) and mTelesaBaseColor */
    fadeColor = [0, 0, 0, 0]; baseColor = TELESA_COLOR[0];
    fadeTimer = 0; fadeState = FADE_STATE_INVISIBLE;
    lightType = LIGHT_TYPE_INDIRECT;
    get PT(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'テレサ') { super(w, name); this.setTypeNormal(); }
    load(s: Stream) {
        super.load(s);
        this.reset();
        this.dampenedGroundHeight = this.pos.y;
        this.setTypeNormal();
    }
    init(m: any) {
        super.init(m);
        this.actorType = AT.TELESA;
        this.unk150 = 18;
        this.offHitFilter(HC.ENEMY);
        this.onHitFilter(HC.BOSS);
        this.spine!.initWith(WalkerNerves.graphWander);
        this.onLiveFlag(LF.UNK8);
        this.setFlyParam(1);
        // (its skin deform and the screen texture on H_ma_rak_dummy: drawing only)
        this.lightType = LIGHT_TYPE_INDIRECT;
        this.unk188 = 0;
    }
    setMActorAndKeeper() { this.mactor = this.createMActorByName('telesa.bmd'); }
    reset() {
        super.reset();
        this.onLiveFlag(LF.UNK8);
        this.onLiveFlag(LF.HIDDEN);
        this.setFlyParam(1);
        this.unk1B8 = 0;
        this.headHeight = 100;
        this.offHitFilter(HC.ENEMY | HC.BOSS);
        if (this.unk150 & 0x1) this.spine!.initWith(TelesaNerves.attackMario);
        else this.spine!.initWith(WalkerNerves.graphWander);
        if (this.imitated) this.spine!.initWith(TelesaNerves.imitate);
        this.baseColor = TELESA_COLOR[0];
    }
    perform(cue: number) {
        super.perform(cue);
        if (this.checkLiveFlag(LF.UNK200 | LF.DEAD) || !this.imitated) return;
        const im = this.imitated;
        if (cue & CUE_CALC_ANIM) {
            const [g] = this.world.checkGround(this.pos.x, this.pos.y, this.pos.z);
            MsMtxSetXYZRPH(im.baseTR, this.pos.x, g, this.pos.z, this.rot.x, this.rot.y, this.rot.z);
            im.pos.set(this.pos.x, g, this.pos.z); im.rot.set(this.rot); im.scale.set(1, 1, 1);
            im.mactor!.frameUpdate();
        }
    }
    /** drawObject: not drawn while it's disguised; (the game draws the invisible Boo as a refraction: here, not at all) */
    drawn() { return super.drawn() && !this.imitated && this.fadeColor[3] > 0; }
    /** how opaque the Boo is (mTelesaFadeColor.a / 255) */
    get alpha() { return this.fadeColor[3] / 255; }

    setFlyParam(k: number) {
        const P = this.PT;
        this.targetFlyHeight = fr(rangeRand(P.unk458[0], P.unk458[1]) * k);
        this.curFlyHeight = 0;
        this.flyBobAmplitude = fr(rangeRand(P.unk460[0], P.unk460[1]) * k);
        this.flyBobPhase = 0;
        this.flyBobFrequency = rangeRand(P.unk468[0], P.unk468[1]);
    }
    setBehavior() {
        const c = this.spine!.current;
        if (c !== WalkerNerves.graphWander && c !== SmallEnemyNerves.wait && c !== TelesaNerves.attackMario) return;
        this.flyBobPhase = fr(this.flyBobPhase + 1);
        if (this.flyBobPhase > this.flyBobFrequency) this.flyBobPhase = 0;
        const phase = fr(fr(this.flyBobPhase * 360) / this.flyBobFrequency);
        this.flyBobOffsetY = fr(this.flyBobAmplitude * MsSin(phase));
        const newRotX = fr(10 - Telesa.flyAngMax * MsCos(phase));
        // (the decomp: `mRotation.x == -newRotX;` when it's more than 5 off, a no-op; TODO check against the asm)
        if (!(Math.abs(newRotX - this.rot.x) > 5)) this.rot.x = newRotX;
    }
    attackToMario() {
        if (this.checkLiveFlag(LF.HIDDEN) || !(this.pos.y + this.attackHeight - 50 < this.world.mario.pos.y)) this.sendAttackMsgToMario();
    }
    behaveToWater(_a: HitActor) {
        this.unk165 = true;
        const c = this.spine!.current;
        if (c === TelesaNerves.freeze || c === TelesaNerves.imitate) return;
        const m = this.world.mario.pos;
        const d = new V3(this.pos.x - m.x, this.unk184 ? 30 : 2, this.pos.z - m.z);
        this.pos.y += 2;
        d.normalize();
        let k = 5;
        if (this.unk184) { k = this.PT.mSLTelesaPowerByWater; this.pos.y += 30; }
        this.vel.set(d.scale(k)).fround();
        this.onLiveFlag(LF.AIRBORNE);
        if (this.fadeState !== FADE_STATE_VISIBLE && this.fadeState !== FADE_STATE_FADE_IN) this.fadeState = FADE_STATE_FADE_IN;
        this.spine!.pushNerve(TelesaNerves.freeze);
        this.unk1C8 = 1;
        this.onHitFilter(HC.ENEMY);
    }
    walkBehavior(kind: number, k: number) {
        super.walkBehavior(kind, k);
        if (this.spine!.current !== TelesaNerves.die && this.curFlyHeight < this.targetFlyHeight) this.curFlyHeight += 1;
        const target = this.unk184 ? 500 : this.groundHeight;
        if (this.groundHeightDampeningSpeed === 0 && Math.abs(this.dampenedGroundHeight - target) > 5) {
            this.groundHeightDampeningSpeed = fr((this.groundHeight - target) / 120);
            if (this.unk184) this.groundHeightDampeningSpeed = MsClamp(this.groundHeightDampeningSpeed, -2, 2);
            else if (Math.abs(this.groundHeightDampeningSpeed) > 10) this.groundHeightDampeningSpeed = 0;
        }
        if (this.groundHeightDampeningSpeed > 0) {
            this.dampenedGroundHeight = fr(this.dampenedGroundHeight + this.groundHeightDampeningSpeed);
            if (this.dampenedGroundHeight > target) this.groundHeightDampeningSpeed = 0;
        }
        if (this.groundHeightDampeningSpeed < 0) {
            this.dampenedGroundHeight = fr(this.dampenedGroundHeight + this.groundHeightDampeningSpeed);
            if (this.dampenedGroundHeight < target) { this.groundHeightDampeningSpeed = 0; this.dampenedGroundHeight = fr(target + 1); }
        }
        this.pos.y = fr(this.dampenedGroundHeight + this.curFlyHeight + this.flyBobOffsetY);
    }
    /** (its slobber particles on joints 3 and 4 aside) */
    calcRootMatrix() { this.calcRootMatrixBasic(); }
    moveObject() {
        super.moveObject();
        this.changeTevKColor();
    }
    /** The Boo's own binder: gravity and the ground (its graph's node height when it has a graph), no walls. */
    bind() {
        if (this.checkLiveFlag(LF.UNK10)) return;
        const n = this.pos.clone();
        n.y -= this.curFlyHeight + this.flyBobOffsetY;
        n.add(this.posDelta).add(this.vel);
        this.vel.y = fr(this.vel.y - this.getGravityY());
        if (this.vel.y < -40) this.vel.y = -40;
        const dying = this.spine!.current === TelesaNerves.die;
        if (this.groundHeightDampeningSpeed === 0 || dying) {
            const [h, d] = this.world.checkGround(n.x, n.y + this.headHeight + 200, n.z);
            this.groundHeight = h; this.groundPlane = d;
            if (this.unk184 === 0 && !dying) {
                const g = this.tracer.graph;
                if (g && !g.isDummy() && this.tracer.cur >= 0) this.groundHeight = this.tracer.current().y;
            }
            this.groundHeight = fr(this.groundHeight + 1);
        }
        if (n.y <= this.groundHeight + 0.05) {
            this.offLiveFlag(LF.AIRBORNE);
            this.vel.set(0, 0, 0);
            if (dying) n.y = this.groundHeight;
        } else this.onLiveFlag(LF.AIRBORNE);
        this.posDelta.set(V3.sub(n, this.pos));
        this.posDelta.y += this.curFlyHeight + this.flyBobOffsetY;
    }
    isReachedToGoal() {
        const t = V3.sub(this.goal104.point(), this.pos); t.y = 0;
        if (t.x === 0 && t.z === 0) return true;
        return t.squared() < 200;   // (MsVECMag2: the squared distance)
    }
    /** (box Boos: a TelesaBlock map object, which the viewer doesn't have: the game returns false without one) */
    changeByJuice() {
        if (this.unk150 & 0x40) {
            if (this.juiceBlock) return true;
            return false;
        }
        return false;
    }
    getChangeBlockTime() { return 3000; }
    isInhibitedForceMove() { return true; }
    decHpByWater(_a: HitActor) { }
    isFindMario(_k: number) { return false; }
    setWalkAnm() {
        this.offHitFilter(HF.NO_COLLISION);
        if (!this.isBckAnm(6)) { this.setBckAnm(6); this.flyBobPhase = 0; }
    }
    setWaitAnm() { this.setBckAnm(6); }
    reduceFlyForce() {
        if (this.curFlyHeight > 0) this.curFlyHeight -= 4; else this.curFlyHeight = 0;
        if (this.flyBobOffsetY > 0) { this.flyBobOffsetY -= 4; if (this.flyBobOffsetY < 0) this.flyBobOffsetY = 0; }
        if (this.flyBobOffsetY < 0) { this.flyBobOffsetY += 4; if (this.flyBobOffsetY > 0) this.flyBobOffsetY = 0; }
        this.flyBobPhase = fr(this.flyBobPhase * 0.9);
        this.rot.x = fr(this.rot.x * 0.9);
    }
    getGravityY() { return this.unk184 ? this.PT.mSLTelesaAttackGravityY : this.PT.mSLTelesaGravityY; }
    isFlying() {
        if (this.curFlyHeight !== 0 || this.flyBobOffsetY !== 0 || this.isAirborne()) return true;
        this.dampenedGroundHeight = this.pos.y;
        return false;
    }
    /** (the decomp's body does nothing) */
    forceKill() { }
    kill() {
        if (this.checkLiveFlag(LF.DEAD)) return;
        this.offLiveFlag(LF.HIDDEN);
        if (this.spine!.current !== TelesaNerves.die) this.spine!.pushNerve(TelesaNerves.die);
        this.onLiveFlag(LF.UNK40);
    }
    /** initAttacker: thrown out of another actor's joint 5 (the boss Boo's) */
    initAttacker(a: HitActor) {
        this.reset();
        this.unk1B8 = 1;
        this.offLiveFlag(LF.HIDDEN);
        this.setTypeCanSee();
        this.unk184 = 1;
        this.spine!.initWith(TelesaNerves.attackMario);
        const la = a as LiveActor;
        const m = la.mactor ? la.mactor.anmMtx(5, la.baseTR, la.scale) : null;
        if (m) this.pos.set(m[12], m[13] - 150, m[14]); else this.pos.set(a.pos.x, a.pos.y - 150, a.pos.z);
        this.dampenedGroundHeight = this.pos.y;
        this.vel.set(0, 8, 0);
        this.rot.set(a.rot); this.rot.x = 0;
        this.setFlyParam(1);
        this.unk1C8 = 0;
        this.offHitFilter(HC.ENEMY);
        this.unk150 &= ~0x40;
        this.onLiveFlag(LF.HIDDEN);
        this.mactor!.getFrameCtrl(ANM_BCK)!.frame = 0;
        this.headHeight = 250;
        this.world.sound(SE.EN_TELESA_APPEAR, this.pos);
    }
    initItemAttacker(a: HitActor) {
        this.reset();
        this.offLiveFlag(LF.HIDDEN);
        this.unk1B8 = 1;
        this.setTypeNormal();
        this.spine!.initWith(TelesaNerves.attackMario);
        this.dampenedGroundHeight = fr(this.world.mario.groundHeight - 50);
        this.rot.set(a.rot);
        this.setFlyParam(1);
        this.unk150 &= ~0x40;
        this.mactor!.getFrameCtrl(ANM_BCK)!.frame = 0;
        this.headHeight = 250;
        this.world.sound(SE.EN_TELESA_APPEAR, this.pos);
    }
    setAttacker() {
        this.reset();
        this.unk1B8 = 1;
        this.offLiveFlag(LF.HIDDEN);
        this.unk184 = 1;
        this.setTypeCanSee();
        this.spine!.initWith(TelesaNerves.attackMario);
        this.setGoalPath(new PathNode(null, this.world.mario.pos.clone()));
        this.unk1C8 = 0;
        this.offHitFilter(HC.ENEMY);
        this.unk150 &= ~0x40;
        this.moveObject();
    }
    isCollidMove(a: HitActor) { return a.actorType !== AT.EFFECT_OBJ; }
    resetBaseGround() { const r = this.unk165; if (r) this.unk165 = false; return r; }
    setAttackPoint() {
        const p = this.pos.clone(), m = this.world.mario.pos;
        const dx = m.x - this.pos.x, dz = m.z - this.pos.z;
        const r = rangeRand(0.7, 1.6);
        p.x = fr(p.x + dx * r); p.z = fr(p.z + dz * r);
        this.setGoalPath(new PathNode(null, p));
    }
    setFirstAttackPoint() {
        if (this.unk184) this.rot.y = fr(180 - this.instanceIndex * 720);
        const p = this.pos.clone();
        p.x = fr(p.x + MsSin(this.rot.y) * 1000); p.z = fr(p.z + MsCos(this.rot.y) * 1000);
        this.setGoalPath(new PathNode(null, p));
    }
    setTypeNormal() { this.telesaType = TELESA_TYPE_NORMAL; this.fadeState = FADE_STATE_INVISIBLE; this.offLiveFlag(LF.HIDDEN); }
    setTypeLoop() { this.telesaType = TELESA_TYPE_LOOP; this.fadeState = FADE_STATE_FADE_IN; this.offLiveFlag(LF.HIDDEN); }
    setTypeCanSee() { this.telesaType = TELESA_TYPE_CAN_SEE; this.fadeState = FADE_STATE_VISIBLE; this.offLiveFlag(LF.HIDDEN); this.lightType = LIGHT_TYPE_OBJECT; }
    changeTevKColor() {
        const P = this.PT;
        switch (this.fadeState) {
            case FADE_STATE_VISIBLE:
                this.fadeColor[3] = 0xFF;
                this.fadeTimer = 0;
                // invisible-by-default and loop Boos stay visible a while, then fade out; visible ones stay
                if (this.telesaType !== TELESA_TYPE_CAN_SEE && this.spine!.current !== TelesaNerves.freeze) {
                    this.fadeLoopTimer += 1;
                    const t = this.telesaType === TELESA_TYPE_NORMAL ? P.mSLAppearTime : P.mSLLoopAppearTime;
                    if (this.fadeLoopTimer <= t) break;
                    this.lightType = LIGHT_TYPE_INDIRECT;
                    this.fadeState = FADE_STATE_FADE_OUT;
                    this.fadeLoopTimer = 0;
                    break;
                }
                this.fadeTimer = P.mSLFadeOutTime;
                this.fadeLoopTimer = 0;
                break;
            case FADE_STATE_INVISIBLE:
                this.fadeTimer = 0;
                this.fadeColor[3] = 0;
                if (this.telesaType === TELESA_TYPE_LOOP) {
                    this.fadeLoopTimer += 1;
                    if (this.fadeLoopTimer > P.mSLLoopHideTime) { this.fadeState = FADE_STATE_FADE_IN; this.fadeLoopTimer = 0; }
                }
                break;
            case FADE_STATE_FADE_IN: {
                ++this.fadeTimer;
                const pr = Math.trunc((this.fadeTimer * 0xFF) / P.mSLFadeInTime);
                if (pr >= 0xFF) { this.fadeState = FADE_STATE_VISIBLE; this.fadeTimer = 0; this.fadeColor[3] = 0xFF; this.lightType = LIGHT_TYPE_OBJECT; }
                else this.fadeColor[3] = pr & 0xFF;
                break;
            }
            case FADE_STATE_FADE_OUT: {
                ++this.fadeTimer;
                const pr = 0xFF - Math.trunc((this.fadeTimer * 0xFF) / P.mSLFadeOutTime);
                if (this.fadeColor[3] === 0) { this.fadeState = FADE_STATE_INVISIBLE; this.fadeColor[3] = 0; this.fadeTimer = 0; }
                else this.fadeColor[3] = pr & 0xFF;   // (u8)
                break;
            }
        }
    }
}

export class SeeTelesa extends Telesa {
    constructor(w: World, name = '可視テレサ') { super(w, name); }
    load(s: Stream) { super.load(s); this.setTypeCanSee(); }
}
export class LoopTelesa extends Telesa {
    constructor(w: World, name = 'ループテレサ') { super(w, name); }
    load(s: Stream) { super.load(s); this.setTypeLoop(); }
}
export class BoxTelesa extends Telesa {
    constructor(w: World, name = '箱テレサ') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.setTypeCanSee();
        this.unk150 = 0x40;
        // (gpMapObjManager->newAndRegisterObj("TelesaBlock"): the block it turns into; no map objects here)
    }
    reset() { super.reset(); this.baseColor = TELESA_COLOR[1]; }
    isEatenByYosshi() { return false; }
    isHitValid(_m: number) {
        if (this.spine!.current !== TelesaNerves.trample) this.spine!.pushNerve(TelesaNerves.trample);
        else this.setBckAnm(1);
        return false;
    }
}

/** What a マリオモドキテレサ disguises itself as (its scene.bin index) */
const IMITATIONS: Record<number, string> = {
    1: 'mapobj/coin.bmd', 2: 'mapobj/coin_red.bmd', 3: 'mapobj/coin_blue.bmd', 4: 'mapobj/fruitbanana.bmd', 5: 'mapobj/fruitdurian.bmd',
    6: 'mapobj/fruitpapaya.bmd', 7: 'mapobj/fruitpine.bmd', 8: 'mapobj/fruitcoconut.bmd', 9: 'mapobj/mashroom1up.bmd', 10: 'mapobj/kibako.bmd',
    11: 'mapobj/woodbarrel.bmd', 12: 'montem/mom_model.bmd',
};
export class MarioModokiTelesa extends Telesa {
    imitationIndex = 0;
    constructor(w: World, name = 'マリオモドキテレサ') { super(w, name); }
    load(s: Stream) {
        SmallEnemy.prototype.load.call(this, s);
        this.imitationIndex = s.s32();
        let model = (this.manager as TelesaManager).modokiModel;
        const alt = IMITATIONS[this.imitationIndex];
        if (alt && this.world.files.scene(alt)) model = alt;
        this.imitated = new ImitatedParts(this.world, this, model);
        this.world.extras.push(this.imitated);
        this.reset();
        this.dampenedGroundHeight = this.pos.y;
        this.setTypeNormal();
    }
    init(m: any) {
        super.init(m);
        this.spine!.initWith(TelesaNerves.imitate);
        this.unk184 = 0;
    }
    imitateAnm() { if (this.imitationIndex === 0) this.imitated!.mactor!.setBckFromIndex(0); }
}

type S = Spine<Telesa>;
export const TelesaNerves: Record<string, any> = {};
TelesaNerves.imitate = nerve<Telesa>('TNerveTelesaImitate', (spine: S) => {
    const self = spine.body, im = self.imitated;
    // (its disguise only works in the hotel and the casino: elsewhere it's gone after 500 ticks)
    if (self.world.map !== 7 && self.world.map !== 14) {
        if (spine.time === 0 && im) { (self as MarioModokiTelesa).imitateAnm(); im.mactor!.setBckFromIndex(0); }
        if (spine.time > 500) { self.onHitFilter(HF.NO_COLLISION); self.onLiveFlag(LF.DEAD); }
        return false;
    }
    self.walkBehavior(3, 1);
    if (spine.time === 10) {
        self.setGoalPath(new PathNode(self.world.mario));
        if (im) { (self as MarioModokiTelesa).imitateAnm(); im.mactor!.setBckFromIndex(0); }
        else return true;
    }
    const aware = self.PT.mSLSearchAware;
    if (!self.checkLiveFlag(LF.DEAD)) {
        if (self.resetBaseGround() || self.isInSight(self.world.mario.pos, 0, 0, aware)) {
            self.world.effect('telesaChange', self.pos);
            self.imitated = null;
            self.setFlyParam(1);
            spine.pushAfterCurrent(WalkerNerves.graphWander);
            self.world.sound(SE.EN_KM_TELSA_REVEAL, self.pos);
            return true;
        }
    }
    return false;
});
TelesaNerves.die = nerve<Telesa>('TNerveTelesaDie', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.decHitPoints();
        if (self.hitPoints === 0) {
            if (self.fadeState === FADE_STATE_INVISIBLE || self.fadeState === FADE_STATE_FADE_OUT) self.fadeState = FADE_STATE_FADE_IN;
            self.onHitFilter(HF.NO_COLLISION);
        }
        if (self.unk184) self.world.effect('telesaChange', self.pos);
        else self.setBckAnm(2);
    }
    self.reduceFlyForce();
    if (self.checkCurAnmEnd(ANM_BCK) || self.unk184) {
        self.onLiveFlag(LF.DEAD); self.onLiveFlag(LF.UNK8); self.offLiveFlag(LIVE_FLAG_MELT_ON_DEATH);
        self.holder = null;
        self.onHitFilter(HF.NO_COLLISION);
        spine.reset();
        spine.setNext(TelesaNerves.die);
        spine.pushAfterCurrent(spine.default);
        if (!self.unk184) {
            self.genRandomItem();
            (self.manager as TelesaManager).generatePetBottle(self);
            self.world.effect('telesaDie', self.pos);   // (particle 0xCE)
        }
        return true;
    }
    return false;
});
TelesaNerves.freeze = nerve<Telesa>('TNerveTelesaFreeze', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.setBckAnm(5);
        self.setGoalPath(new PathNode(self.world.mario));
    } else if (self.checkCurAnmEnd(ANM_BCK)) {
        if (self.isBckAnm(4)) {
            if (!self.isFlying()) { self.unk1C8 = 0; self.offHitFilter(HC.ENEMY); return true; }
        } else if (self.resetBaseGround() || self.isBckAnm(5)) self.setBckAnm(3);
        else self.setBckAnm(4);
    }
    self.reduceFlyForce();
    self.walkToCurPathNode(0, self.turnSpeed * 0.2, 0);
    return false;
});
TelesaNerves.attackMario = nerve<Telesa>('TNerveTelesaAttackMario', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.setBckAnm(6); self.setFirstAttackPoint(); }
    if (spine.time === 10) self.offLiveFlag(LF.HIDDEN);
    if (self.isReachedToGoalXZ()) self.setAttackPoint();
    self.walkBehavior(2, 2);
    return false;
});
TelesaNerves.trample = nerve<Telesa>('TNerveTelesaTrample', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.setBckAnm(1);
    else if (self.checkCurAnmEnd(ANM_BCK)) return true;
    return false;
});

// ---------------------------------------------------------------- the shadow Mario (カゲマリオモドキ)
export class KageMarioModokiManager extends SmallEnemyManager {
    constructor(w: World, name = 'カゲマリオモドキマネージャー') { super(w, name); }
    load(s: Stream) { this.saveParams = walkerParams('/enemy/kagemariomodoki.prm', this.world.files); super.load(s); }
    createModelData() { this.createModelDataArray(['default.bmd']); }
    createEnemyInstance() { return new KageMarioModoki(this.world); }
}
export class KageMarioModoki extends WalkerEnemy {
    constructor(w: World, name = 'カゲマリオモドキ') { super(w, name); }
    load(s: Stream) { super.load(s); this.reset(); }
    init(m: any) {
        super.init(m);
        this.spine!.initWith(KageMarioModokiWait);
        // (resetDL, indirect light, the screen texture on H_kagemario_dummy: drawing only)
    }
}
const KageMarioModokiWait = nerve<KageMarioModoki>('TNerveKageMarioModokiWait', (spine: Spine<KageMarioModoki>) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.mactor!.setBck('ma_wait');
        self.setGoalPath(new PathNode(null, self.world.mario.pos.clone()));
    }
    if (!self.checkLiveFlag(LF.DEAD) && self.isFindMario(1)) {
        self.world.effect('telesaChange', self.pos, new V3(2, 2, 2));
        self.onLiveFlag(LF.DEAD);
        self.onHitFilter(HF.NO_COLLISION);
        const t = self.world.conductor.makeOneEnemyAppear(self.pos, 'テレサマネージャー', 1) as Telesa | null;
        if (t) { t.reset(); t.tracer.graph = self.tracer.graph; }
        return true;
    }
    self.walkBehavior(3, 1);
    return false;
});

register('TelesaManager', (w, n) => new TelesaManager(w, n));
register('Telesa', (w, n) => new Telesa(w, n));
register('SeeTelesa', (w, n) => new SeeTelesa(w, n));
register('LoopTelesa', (w, n) => new LoopTelesa(w, n));
register('BoxTelesa', (w, n) => new BoxTelesa(w, n));
register('MarioModokiTelesa', (w, n) => new MarioModokiTelesa(w, n));
register('KageMarioModokiManager', (w, n) => new KageMarioModokiManager(w, n));
register('KageMarioModoki', (w, n) => new KageMarioModoki(w, n));
