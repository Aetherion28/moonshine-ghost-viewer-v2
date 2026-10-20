// Ricco Harbor's own map objects (MoveBG/MapObjRicco.cpp): the cranes that swing round (CraneRotY)
// and the ones that nod (craneUpDown, carrying a cargo block on their tip), the watermill that
// raises the submarine as it's sprayed (giving a blue coin the first time it's up), the surfing
// Bloopers' models, and the fruit tank: a switch (two, one down at a time) Mario hip-drops to
// send a random fruit down into the tank.

import { fr, V3, mtx, MsRandF } from '../math.js';
import { World, Stream, HitActor, MSG, ANM_BCK, LF, HF } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { MapObjBase, MOF, mapObjGlobals, newAndRegisterObj, UNIQUE_MAKERS } from './base.js';
import { MsMtxSetRotX, MsMtxSetRotY, MTXConcat, makeRootMtxRot, setRootMtx } from './lib.js';
import { LeanBlock, MapObjFloatOnSea } from './bianco.js';
import type { ResetFruit } from './fruit.js';

const ST_ROTATE_TO_MAX = 1, ST_WAIT_AT_MAX = 2, ST_ROTATE_TO_MIN = 3, ST_WAIT_AT_MIN = 4;

// ---------------------------------------------------------------- TCraneRotY
export class CraneRotY extends MapObjBase {
    static mWaitTime = 120;
    /** unk138 its start yaw, unk13C / unk140 the swing's ends from it (unk13C is never read in: 0), unk144 its speed, unk148 its sound */
    unk138 = 0; unk13C = 0; unk140 = 0; unk144 = 0; unk148 = 0;
    constructor(w: World, name = 'クレーン') { super(w, name); }
    calc() { setRootMtx(this, makeRootMtxRot(this, 'y')); }
    control() {
        super.control();
        switch (this.state) {
            case ST_ROTATE_TO_MAX:
                this.rot.y = fr(this.rot.y + this.unk144);
                if (this.rot.y > fr(this.unk138 + this.unk140)) { this.stateTimer = CraneRotY.mWaitTime; this.state = ST_WAIT_AT_MAX; }
                break;
            case ST_WAIT_AT_MIN: if (!this.isStateTimerEngaged()) this.state = ST_ROTATE_TO_MAX; break;
            case ST_ROTATE_TO_MIN:
                this.rot.y = fr(this.rot.y - this.unk144);
                if (this.rot.y < fr(this.unk138 + this.unk13C)) { this.stateTimer = CraneRotY.mWaitTime; this.state = ST_WAIT_AT_MIN; }
                break;
            case ST_WAIT_AT_MAX: if (!this.isStateTimerEngaged()) this.state = ST_ROTATE_TO_MIN; break;
        }
        if (this.isState(ST_ROTATE_TO_MAX) || this.isState(ST_ROTATE_TO_MIN)) this.world.sound(this.unk148, this.pos);
    }
    load(s: Stream) {
        super.load(s);
        this.unk140 = s.f32();
        this.unk138 = this.rot.y;
        this.unk144 = fr(fr(MsRandF() * fr(0.1)) + fr(0.05));
        this.unk148 = this.name === 'crane90 0' ? SE.OBJ_CRANE_SIDEMOVE1 : SE.OBJ_CRANE_SIDEMOVE2;
        this.state = ST_ROTATE_TO_MAX;
    }
}

// ---------------------------------------------------------------- TCraneUpDown
export class CraneUpDown extends MapObjBase {
    static mRotSpeed = fr(0.1); static mWaitTime = 120;
    /** unk138 the cargo, unk13C its sound, unk140 / unk144 the pitch's top and bottom */
    unk138: MapObjBase | null = null; unk13C = 0; unk140 = 0; unk144 = 0;
    constructor(w: World, name = 'クレーン（上下）') { super(w, name); }
    control() {
        super.control();
        switch (this.state) {
            case ST_WAIT_AT_MIN: if (!this.isStateTimerEngaged()) this.state = ST_ROTATE_TO_MAX; break;
            case ST_ROTATE_TO_MAX:
                this.rot.x = fr(this.rot.x + CraneUpDown.mRotSpeed);
                if (this.rot.x > this.unk140) { this.stateTimer = CraneUpDown.mWaitTime; this.state = ST_WAIT_AT_MAX; }
                break;
            case ST_WAIT_AT_MAX: if (!this.isStateTimerEngaged()) this.state = ST_ROTATE_TO_MIN; break;
            case ST_ROTATE_TO_MIN:
                this.rot.x = fr(this.rot.x - CraneUpDown.mRotSpeed);
                if (this.rot.x < this.unk144) { this.stateTimer = CraneUpDown.mWaitTime; this.state = ST_WAIT_AT_MIN; }
                break;
        }
        // the cargo: 1500 out along the arm (its root matrix: pitch then yaw, no place)
        const c = this.unk138;
        if (c) {
            const m = mtx(), ry = mtx();
            MsMtxSetRotX(m, this.rot.x);
            MsMtxSetRotY(ry, this.rot.y);
            MTXConcat(ry, m, m);
            const x = fr(m[2] * 1500), y = fr(m[6] * 1500), z = fr(m[10] * 1500);
            c.pos.set(fr(x + this.pos.x), fr(y + fr(fr(this.pos.y - this.yOffset) + c.yOffset)), fr(z + this.pos.z));
        }
        if (this.isState(ST_ROTATE_TO_MIN) || this.isState(ST_ROTATE_TO_MAX)) this.world.sound(this.unk13C, this.pos);
    }
    initMapObj() {
        super.initMapObj();
        const a = this.colMgr && this.colMgr.getActiveCollision();
        if (a) for (const d of a.checks) d.actor = null;
        this.unk138 = newAndRegisterObj(this.world, 'craneCargoUpDown');
        if (this.unk138) this.unk138.appear();
        if (this.name === 'craneUpDown 0') { this.unk144 = -25; this.unk140 = 45; this.unk13C = SE.OBJ_CRANE_UPDOWN1; }
        else { this.unk144 = -25; this.unk140 = 30; this.unk13C = SE.OBJ_CRANE_UPDOWN2; }
        this.rot.x = fr(fr(MsRandF() * fr(this.unk140 - this.unk144)) + this.unk144);
    }
}

/** TCraneCargo (newUniqueObjByName's crane_cargo; the nodding crane's craneCargoUpDown is a plain TMapObjBase): a TLeanBlock */
export class CraneCargo extends LeanBlock {
    constructor(w: World, name = 'クレーンの荷物') { super(w, name); }
    control() {
        this.unk158.zero();
        MapObjBase.prototype.control.call(this);
    }
    // calc: updateRootMtxTrans (which writes all three into one cell) then calcLeanMtx into joint 1: drawing only
}

// ---------------------------------------------------------------- TRiccoWatermill
const WM_NORMAL = 1, WM_RISE = 2, WM_SINK_TO_SURFACE = 3, WM_SINK_TO_BOTTOM = 4, WM_STAY_AT_SURFACE = 5;
export class RiccoWatermill extends MapObjBase {
    static mRotAccel = 1; static mRotSpeedMaxUp = 3; static mRotSpeedMaxDown = 1; static mRotDown = fr(0.05);
    static mSubmarineMoveRate = 0.5; static mSubmarineMaxTransY = 750; static mSubmarineBottomTransY = -950; static mWaitTime = 600;
    /** (never set: 0) */
    static mSubmarineSurfaceTransY = 0;
    /** unk138 its turning speed, unk13C the submarine, unk140 frames it keeps its speed, unk144 the coin's been given, unk148 the blue coin */
    unk138 = 0; unk13C: MapObjBase | null = null; unk140 = 0; unk144 = false; unk148: MapObjBase | null = null;
    constructor(w: World, name = '水車（リコ）') { super(w, name); }
    touchWater(_a: HitActor) {
        if (this.isState(WM_STAY_AT_SURFACE)) return 1;
        const sub = this.unk13C!;
        this.unk140 = 5;
        if (this.isState(WM_NORMAL)) sub.setUpMapCollision(1);
        this.offMapObjFlag(MOF.NO_ANIMATIONS);
        sub.offMapObjFlag(MOF.NO_ANIMATIONS);
        if (sub.pos.y < RiccoWatermill.mSubmarineMaxTransY) {
            this.unk138 = fr(this.unk138 + RiccoWatermill.mRotAccel);
            if (this.unk138 > RiccoWatermill.mRotSpeedMaxUp) this.unk138 = RiccoWatermill.mRotSpeedMaxUp;
            this.state = WM_RISE;
        } else this.unk138 = 0;
        return 1;
    }
    control() {
        super.control();
        const sub = this.unk13C;
        if (!sub) return;
        if (this.isState(WM_RISE) || this.isState(WM_SINK_TO_SURFACE) || this.isState(WM_SINK_TO_BOTTOM)) {
            if (this.unk138 !== 0) {
                this.rot.z = fr(this.rot.z - this.unk138);
                this.world.sound(SE.OBJ_SUBMARINE_MILL, this.pos);
                const move = fr(this.unk138 * RiccoWatermill.mSubmarineMoveRate);
                sub.pos.y = fr(sub.pos.y + move);
                this.world.sound(SE.OBJ_SUBMARINE_CRANE, new V3(1956, 1000, 6425));
                this.world.sound(SE.OBJ_SUBMARINE_SINK, new V3(1956, 1000, 6425));
            }
            if (this.unk140 === 0) {
                this.unk138 = fr(this.unk138 - RiccoWatermill.mRotDown);
                if (this.unk138 < -RiccoWatermill.mRotSpeedMaxDown) this.unk138 = -RiccoWatermill.mRotSpeedMaxDown;
            } else --this.unk140;
        }
        switch (this.state) {
            case WM_RISE:
                if (sub.pos.y > RiccoWatermill.mSubmarineMaxTransY) {
                    sub.pos.y = RiccoWatermill.mSubmarineMaxTransY;
                    if (!this.isStateTimerEngaged()) {
                        this.world.sound(SE.OBJ_SUBMARINE_SET, sub.pos);
                        if (!this.unk144 && this.unk148) this.throwObjToFrontFromPoint(this.unk148, new V3(2008, RiccoWatermill.mSubmarineMaxTransY + 500, 7066), 20, 20);
                        this.unk144 = true;
                    }
                }
                if (this.unk138 < 0) this.state = this.unk144 ? WM_SINK_TO_SURFACE : WM_SINK_TO_BOTTOM;
                break;
            case WM_SINK_TO_SURFACE:
                if (sub.pos.y <= RiccoWatermill.mSubmarineSurfaceTransY) {
                    sub.pos.y = RiccoWatermill.mSubmarineSurfaceTransY;
                    sub.setUpMapCollision(0);
                    this.unk138 = 0;
                    this.world.sound(SE.OBJ_SUBMARINE_SET, sub.pos);
                    this.stateTimer = RiccoWatermill.mWaitTime;
                    this.state = WM_STAY_AT_SURFACE;
                }
                break;
            case WM_SINK_TO_BOTTOM:
                if (sub.pos.y <= RiccoWatermill.mSubmarineBottomTransY) {
                    sub.pos.y = RiccoWatermill.mSubmarineBottomTransY;
                    sub.setUpMapCollision(0);
                    this.unk138 = 0;
                    sub.onMapObjFlag(MOF.NO_ANIMATIONS);
                    this.onMapObjFlag(MOF.NO_ANIMATIONS);
                    this.world.sound(0x3833, sub.pos);   // (SMD_SE_OBJ_SUBMARINE_SET_WT)
                    this.state = WM_NORMAL;
                }
                break;
        }
    }
    calc() { setRootMtx(this, makeRootMtxRot(this, 'z')); }
    loadAfter() {
        super.loadAfter();
        this.unk13C = this.world.search('submarine') as MapObjBase | null;
        this.unk148 = this.world.search('青コイン（潜水艦用）') as MapObjBase | null;
        if (this.unk148) this.unk148.makeObjDead();
        const sub = this.unk13C;
        if (sub) {
            sub.pos.y = RiccoWatermill.mSubmarineBottomTransY;
            sub.removeMapCollision();
            sub.setUpCurrentMapCollision();
        }
    }
}

// ---------------------------------------------------------------- TSurfGesoObj
/** The surfing Bloopers' models (their TEVREG1 by colour, running surfgeso_run1): what Mario rides is TItem's GesoSurfBoard */
export class SurfGesoObj extends MapObjBase {
    unk154 = [255, 255, 255, 255];
    tevColorMaterialIndex = 0;
    constructor(w: World, name = 'サーフゲッソー') { super(w, name); }
    initMapObj() {
        super.initMapObj();
        if (this.individualName === 'SurfGesoRed') this.unk154 = [0xFF, 0xB4, 0xFF, 0xFF];
        else if (this.individualName === 'SurfGesoYellow') this.unk154 = [0xFF, 0xFF, 0x7D, 0xFF];
        else if (this.individualName === 'SurfGesoGreen') this.unk154 = [0xB4, 0xFF, 0xB4, 0xFF];
        // (SMS_MakeMActorFromSDLModelData(gpMapObjManager's surfgeso model): mapObj/surfgeso.bmd)
        this.mactor = this.initMActor('surfgeso.bmd');
        if (this.mactor) this.mactor.setBck('surfgeso_run1');
    }
}

// ---------------------------------------------------------------- the fruit tank
/** TFruitSwitch (RiccoSwitch): hip-dropped, it goes down and the tank (its launcher) fires; the other comes up */
export class FruitSwitch extends MapObjBase {
    unk138: FruitLauncher | null = null;
    constructor(w: World, name = 'フルーツスイッチ') { super(w, name); }
    pullUp() {
        const fc = this.mactor && this.mactor.getFrameCtrl(ANM_BCK);
        if (fc) fc.frame = 0;
        this.offHitFilter(HF.NO_COLLISION);
        const a = this.colMgr && this.colMgr.getActiveCollision();
        if (a) { this.calcRootMatrix(); a.setUpMtx(this.rootMtx()); }
    }
    pushDown() {
        this.startBck('riccoswitch');
        this.onHitFilter(HF.NO_COLLISION);
        if (this.colMgr) this.colMgr.removeActiveCollision();
    }
    receiveMessage(_s: HitActor, msg: number) {
        if (msg === MSG.HIP_DROP) { this.pushDown(); if (this.unk138) this.unk138.fireObj(); return true; }
        return false;
    }
}

/** TFruitLauncher (RiccoSwitchShine): drops a random fruit into the tank */
export class FruitLauncher extends MapObjBase {
    static mObjSpeedXZ = 1; static mObjSpeedY = 20; static mFruitLiveTime = 4800;
    unk138: (FruitSwitch | null)[] = [null, null]; unk140 = 0;
    constructor(w: World, name = 'フルーツ発射台') { super(w, name); }
    private appearFruit(): MapObjBase | null {
        const im = mapObjGlobals(this.world).itemManager;
        if (!im) return null;
        const rnd = fr(100 * MsRandF());
        const t = rnd < 20 ? AT.FRUIT_COCONUT : rnd < 40 ? AT.FRUIT_PAPAYA : rnd < 60 ? AT.FRUIT_PINE : rnd < 80 ? AT.FRUIT_DURIAN : AT.FRUIT_BANANA;
        return im.makeObjAppearAt(this.pos.x, this.pos.y, this.pos.z, t, false);
    }
    fireObj() {
        this.emit('ms_jump_ed_b');
        this.world.sound(SE.OBJ_AP_BUTTON, this.pos);
        this.world.sound(SE.SMOKE_EFFECT, this.pos);
        this.unk140 = this.unk140 === 0 ? 1 : 0;
        const sw = this.unk138[this.unk140];
        if (sw) sw.pullUp();
        const fruit = this.appearFruit() || this.appearFruit() || this.appearFruit();
        if (fruit) {
            fruit.pos.set(this.pos);
            // (MWCC evaluates the arguments right to left: z's roll first)
            const z = fr(FruitLauncher.mObjSpeedXZ * fr(MsRandF() - 0.5));
            const x = fr(FruitLauncher.mObjSpeedXZ * fr(MsRandF() - 0.5));
            fruit.vel.set(x, -FruitLauncher.mObjSpeedY, z);
            fruit.offLiveFlag(LF.UNK10);
            this.world.events.push({ t: this.world.tickCount, kind: 'demoCamera', data: { name: 'フルーツタンクカメラカメラ', p: fruit.pos.clone() } });
            this.world.sound(SE.SY_COLLECT_DELIGHT, null);
            if (MapObjBase.isFruit(fruit)) (fruit as ResetFruit).killByTimer(FruitLauncher.mFruitLiveTime);
        }
    }
    loadAfter() {
        super.loadAfter();
        for (const n of ['FruitCoconut', 'FruitDurian', 'FruitPapaya', 'FruitPine', 'FruitBanana']) {
            const f = newAndRegisterObj(this.world, n) as ResetFruit | null;
            if (f) f.unk1A4 = 1;
        }
        const a = this.world.search('タンクスイッチＡ') as FruitSwitch | null, b = this.world.search('タンクスイッチＢ') as FruitSwitch | null;
        this.unk138 = [a, b];
        if (a) a.unk138 = this;
        if (b) b.unk138 = this;
        this.unk140 = 1;
        if (a) a.pushDown();
    }
}

UNIQUE_MAKERS.set('crane_cargo', (w) => new CraneCargo(w));
UNIQUE_MAKERS.set('craneCargoUpDown', (w) => new MapObjBase(w, 'craneCargoUpDown'));
register('CraneRotY', (w, n) => new CraneRotY(w, n));
register('craneUpDown', (w, n) => new CraneUpDown(w, n));
register('riccoWatermill', (w, n) => new RiccoWatermill(w, n));
register('SurfGesoRed', (w, n) => new SurfGesoObj(w, n));
register('SurfGesoYellow', (w, n) => new SurfGesoObj(w, n));
register('SurfGesoGreen', (w, n) => new SurfGesoObj(w, n));
register('RiccoSwitch', (w, n) => new FruitSwitch(w, n));
register('RiccoSwitchShine', (w, n) => new FruitLauncher(w, n));
register('MapObjFloatOnSea', (w, n) => new MapObjFloatOnSea(w, n));
