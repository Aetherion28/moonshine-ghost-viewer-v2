// Bianco Hills' own map objects (MoveBG/MapObjBianco.cpp, with TMapObjTurn of MapObjLib.cpp,
// TLeanBlock of MapObjBlock.cpp and TMapObjFloatOnSea of MapObjFloat.cpp they build on):
// the big windmill and the blocks riding its sails, the water mills (the big one turning on its
// own, the two vertical ones turned by spraying them and turning the bridges with them, the bell
// mill that climbs as it's sprayed and rings the three bells at the top), the small windmills
// that give a coin when sprayed fast, the leaf boats (Mario rides them, sprayed water pushes
// them, stream cubes carry them; the rotten ones fade away under him and come back), the logs
// floating on the lake, and Petey's roots' trembling.
//
// The windmill roof, the turn bridges and the normal block are plain map objects (TMapObjBase).

import { fr, V3, Mtx, mtx, MsWrap, MsClamp, MsSin, MsCos, MsRandF, MsMtxSetXYZRPH, mtxInverse, mtxMultVec, sinf, cosf, HALF_PI_F } from '../math.js';
import { MsSqrtf } from '../player/fmath.js';
import { fmadd as FMA, fmsub as FMS } from '../player/fmath.js';
import { World, Stream, HitActor, LF, HC, MSG, ANM_BCK, ANM_FRAME_RATE, CUE_CALC_ANIM } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { DONT_MOVE_XZ, WallCheck, BGCheckData } from '../collision.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { MapObjBase, STATE_NORMAL, mapObjGlobals, newAndRegisterObj } from './base.js';
import { HideObjBase } from './hide.js';
import type { ItemManager } from './item.js';
import {
    MsMtxSetRotX, MsMtxSetRotY, MsMtxSetRotZ, MTXConcat, MTXRotAxisRad, normalize, makeRootMtxRot, setRootMtx, setJointWorlds, restJointMtx,
    getWaterPlane, getWaterPos, getWaterSpeed, waterHitPlane, getVerticalVecToTargetXZ, marioGroundPlane, marioTouchGround4cm, marioHipDropping,
    marioSpeedY, marioGroundLevel, marioWaterGun, marioSwimming, sendToMario, inStreamCube, MapObjLibWave, vtxPosCount,
} from './lib.js';

/** marioIsOn (MapObjLib.cpp): Mario's ground is this object's collision and he's within 4cm of it */
export const marioIsOn = (o: MapObjBase) => marioGroundPlane(o.world).actor === o && marioTouchGround4cm(o.world);
/** marioHipAttack */
export const marioHipAttack = (o: MapObjBase) => marioGroundPlane(o.world).actor === o && marioHipDropping(o.world)
    && o.world.mario.pos.y + marioSpeedY(o.world) < marioGroundLevel(o.world);
const DEG = 0.017453294;

// ---------------------------------------------------------------- TBigWindmill
const sRadius = 2380, sSubZ = 150, sSpeed = fr(0.05), sAngleAdd = 0;
export class BigWindmill extends MapObjBase {
    blocks: MapObjBase[] = [];
    constructor(w: World, name = '巨大風車') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        for (let i = 0; i < 4; i++) {
            const b = newAndRegisterObj(this.world, 'bigWindmillBlock');
            if (!b) continue;
            b.appear();
            // getModel()->calc(): its root matrix as it stands (rotation from its rotation, at its place)
            b.calcRootMatrix();
            setRootMtx(b, b.rootMtx());
            this.blocks.push(b);
        }
    }
    control() {
        super.control();
        this.rot.z = fr(this.rot.z - sSpeed);
        this.rot.z = MsWrap(this.rot.z, 0, 360);
        setRootMtx(this, makeRootMtxRot(this, 'z'));
        this.world.sound(SE.OBJ_BI_WINDMILLTOWER, this.pos);
        let angle = fr(this.rot.z + sAngleAdd);
        for (const b of this.blocks) {
            const m = Float64Array.from(b.rootMtx());
            m[3] = fr(this.pos.x + fr(sRadius * fr(Math.cos(fr(DEG * angle)))));
            m[7] = fr(fr(this.pos.y + fr(sRadius * fr(Math.sin(fr(DEG * angle))))) - this.yOffset);
            m[11] = fr(this.pos.z - sSubZ);
            setRootMtx(b, m);
            b.pos.set(m[3], m[7], m[11]);
            angle = fr(angle + 90);
            if (angle > 360) angle = fr(angle - 360);
        }
    }
}

// ---------------------------------------------------------------- TMapObjRootPakkun
/** TTrembleModelEffect: the model's vertices shaken (drawing only; its random draws are the game's) */
class TrembleModelEffect {
    n = 0; on = false; timer = 0;
    constructor(public o: MapObjBase) {
        const a = o.mactor;
        this.n = a ? vtxPosCount(a.data.files.scene(a.model)) : 0;
    }
    tremble(_mag: number, _spring: number, _damp: number, dur: number) {
        this.on = true;
        for (let i = 0; i < this.n; i++) { MsRandF(); MsRandF(); MsRandF(); }
        this.timer = dur;
    }
    movement() {
        if (!this.on) return;
        if (--this.timer <= 0) { this.on = false; return; }
    }
}
export class MapObjRootPakkun extends MapObjBase {
    static mTremblePower = 15; static mTrembleAccel = fr(0.95); static mTrembleBrake = fr(0.98); static mTrembleTime = 360;
    tremble: TrembleModelEffect | null = null;
    constructor(w: World, name = 'ボスパックンの根') { super(w, name); }
    initMapObj() {
        super.initMapObj();
        this.tremble = new TrembleModelEffect(this);
        this.tremble.tremble(100, 1, 1, 12000);
    }
    /** drawObject (each drawn frame: here at its CalcAnim) */
    perform(cue: number) {
        super.perform(cue);
        if ((cue & CUE_CALC_ANIM) && this.drawn() && this.tremble) {
            if (Math.abs(this.world.mario.pos.z - this.pos.z) < 10000) {
                this.tremble.movement();
                if (!this.isStateTimerEngaged()) {
                    const R = MapObjRootPakkun;
                    this.tremble.tremble(R.mTremblePower, R.mTrembleAccel, R.mTrembleBrake, R.mTrembleTime);
                    this.stateTimer = R.mTrembleTime;
                }
            }
        }
    }
}

// ---------------------------------------------------------------- TBiancoWatermill (the big one)
export class BiancoWatermill extends MapObjBase {
    unk138 = fr(0.3);
    constructor(w: World, name = '水車（ビアンコ大）') { super(w, name); }
    initMapObj() {
        super.initMapObj();
        if (this.individualName === 'BiaWatermill01' || this.individualName === 'BiaWatermill00') this.bodyRadius = 1200;
    }
    control() {
        this.rot.z = fr(this.rot.z - this.unk138);
        this.world.sound(SE.OBJ_BI_BIGMILL, this.pos);
    }
    touchWater(_a: HitActor) { return 0; }
}

// ---------------------------------------------------------------- TBiancoWatermillVertical
export class BiancoWatermillVertical extends MapObjBase {
    static mRotAccel = fr(0.15); static mRotSpeedDownRate = fr(0.005); static mRotSpeedMax = 3; static mBridgeRotRate = fr(0.03);
    unk138 = 0; unk13C = 0; bridge: MapObjBase | null = null; unk144 = 0;
    constructor(w: World, name = '水車（ビアンコ垂直）') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.unk13C = fr(s.f32() / 1000);
        this.unk138 = this.unk13C;
    }
    loadAfter() {
        super.loadAfter();
        this.bridge = this.world.search(this.name === 'BiaWatermillVertical 0' ? 'BiaTurnBridge 0' : 'BiaTurnBridge 1') as MapObjBase | null;
        this.bodyRadius = 1000;
    }
    touchWater(a: HitActor) {
        const w = this.world;
        if (!getWaterPlane(w, a)) { this.unk144 = 1; return 0; }
        if (!waterHitPlane(w, a)) return 0;
        const wp = getWaterPos(w, a), ws = getWaterSpeed(w, a);
        const sp = new V3(ws.x, 0, ws.z);
        if (sp.x !== 0 || sp.z !== 0) normalize(sp);
        const t = normalize(getVerticalVecToTargetXZ(this, wp.x, wp.z));
        const r = this.bodyRadius;
        const k = fr(fr(r - this.getDistanceXZ(wp)) / r);
        const W = BiancoWatermillVertical;
        if (sp.dot(t) > 0) { if (this.unk138 < W.mRotSpeedMax) this.unk138 = fr(this.unk138 + fr(W.mRotAccel * k)); }
        else if (this.unk138 > -W.mRotSpeedMax) this.unk138 = fr(this.unk138 - fr(W.mRotAccel * k));
        return 1;
    }
    setGroundCollision() {
        if (this.unk144 || this.collisions.length) {
            const a = this.colMgr && this.colMgr.getActiveCollision();
            if (a) a.moveMtx(this.rootMtx());
            this.unk144 = 0;
        }
    }
    control() {
        const W = BiancoWatermillVertical;
        if (this.unk138 !== this.unk13C) {
            if (this.unk138 > this.unk13C) { this.unk138 = fr(this.unk138 - W.mRotSpeedDownRate); if (this.unk138 < this.unk13C) this.unk138 = this.unk13C; }
            else { this.unk138 = fr(this.unk138 + W.mRotSpeedDownRate); if (this.unk138 > this.unk13C) this.unk138 = this.unk13C; }
        }
        this.rot.y = fr(this.rot.y + this.unk138);
        this.rot.y = MsWrap(this.rot.y, 0, 360);
        const bs = fr(this.unk138 * W.mBridgeRotRate);
        const b = this.bridge;
        if (b) {
            b.rot.y = fr(b.rot.y + bs);
            b.rot.y = MsWrap(b.rot.y, 0, 360);
        }
        this.world.sound(SE.OBJ_BI_STEPMILL_WIND, this.pos);
        if (b) this.world.sound(SE.OBJ_BI_STEPMILL_MOVE, b.pos);
    }
}

// ---------------------------------------------------------------- TBiancoMiniWindmill
const sMessengerPosZ = 200, sMessengerPosY = 6400;
export class BiancoMiniWindmill extends HideObjBase {
    static mRotWaterAccel = fr(0.01); static mFriction = fr(0.01); static mRotSpeedMax = 10;
    unk150: number; unk154 = 0; unk158: number;
    /** unk15C: the TMapObjMessenger high on the pole (its place is where the coin comes out) */
    messenger = new HitActor('地形オブジェメッセンジャー');
    private joint1: Mtx | null = null;
    constructor(w: World, name = '風車（ビアンコ小）') {
        super(w, name);
        this.unk150 = fr(360 * MsRandF());
        this.unk158 = fr(1 + MsRandF());
    }
    initMapObj() {
        super.initMapObj();
        this.appearSpeed = 0;
        const m = this.messenger;
        m.initHitActor(0, 1, 0, 0, 0, 300, 500);
        m.pos.x = fr(this.pos.x + fr(sMessengerPosZ * MsSin(this.rot.y)));
        m.pos.y = fr(this.pos.y + sMessengerPosY);
        m.pos.z = fr(this.pos.z + fr(sMessengerPosZ * MsCos(this.rot.y)));
    }
    touchWater(a: HitActor) {
        const wp = getWaterPos(this.world, a);
        if (wp.y < this.pos.y + sMessengerPosY - 300) return 1;
        const ws = getWaterSpeed(this.world, a), m = this.rootMtx();
        if (ws.x * m[2] + ws.y * m[6] + ws.z * m[10] > 0) return 0;
        const W = BiancoMiniWindmill;
        this.unk154 = fr(this.unk154 + W.mRotWaterAccel);
        if (this.unk154 > W.mRotSpeedMax) {
            this.unk154 = W.mRotSpeedMax;
            const p = new V3(this.pos.x, fr(550 + this.messenger.pos.y), this.pos.z);
            this.appearSpeed = 0;
            this.appearObjFromPoint(p);
        }
        return 1;
    }
    /** calc: the sails (joint 1) turned by unk150 about the root's Z, at their own place */
    calc() {
        const r = mtx(); MsMtxSetRotZ(r, this.unk150);
        const m = MTXConcat(this.rootMtx(), r, mtx());
        // (getAnmMtx(1)'s place: the model isn't recalculated, so the rest pose's)
        const j1 = this.joint1 || (this.joint1 = restJointMtx(this, 1));
        if (j1) { m[3] = j1[3]; m[7] = j1[7]; m[11] = j1[11]; setJointWorlds(this, new Map([[1, m]])); }
        this.world.sound(SE.OBJ_BI_COINMILL, this.pos);
    }
    control() {
        if (this.unk154 > this.unk158) this.unk154 = fr(this.unk154 - BiancoMiniWindmill.mFriction);
        else this.unk154 = this.unk158;
        this.unk150 = fr(this.unk150 + this.unk154);
        this.unk150 = MsWrap(this.unk150, 0, 360);
    }
}

// ---------------------------------------------------------------- TBiancoBell
export class BiancoBell extends MapObjBase {
    unk138 = 0; unk13A = 0;
    constructor(w: World, name = 'ベル水車') { super(w, name); }
    initMapObj() {
        super.initMapObj();
        if (this.name === 'BiaBell 0') { this.unk138 = 1; this.unk13A = 0; }
        else if (this.name === 'BiaBell 1') { this.unk138 = 2; this.unk13A = 1; }
        else { this.unk138 = 3; this.unk13A = 0; }
    }
    private ready() {
        const fc = this.mactor ? this.mactor.getFrameCtrl(ANM_BCK) : null;
        return !fc || fc.frame === 0 || fc.frame + fc.rate >= fc.end - 1;
    }
    private setRate() { const fc = this.mactor ? this.mactor.getFrameCtrl(ANM_BCK) : null; if (fc) fc.rate = ANM_FRAME_RATE; }
    ring() {
        if (!this.ready()) return;
        this.startAnim(this.unk138);
        this.setRate();
        if (this.unk13A) this.world.sound(SE.OBJ_BI_BELL, this.pos);
    }
    ringSingle() {
        if (!this.ready()) return;
        this.startAnim(4);
        this.setRate();
        this.world.sound(SE.OBJ_BI_BELL, this.pos);
    }
    stopToRing() { }
    touchWater(_a: HitActor) { this.ringSingle(); return 1; }
    touchPlayer(_a: HitActor) { this.ringSingle(); }
}

// ---------------------------------------------------------------- TMapObjTurn (MapObjLib.cpp)
export class MapObjTurn extends HideObjBase {
    /** the axis turned about: 0 X, 1 Y, 2 Z */
    unk150 = 0; unk154 = 0; unk158 = 0; unk15C = 0; unk160 = 0; unk164 = 0; unk168 = 0;
    constructor(w: World, name = '水回転オブジェ') { super(w, name); }
    touchWater(_a: HitActor) {
        if (Math.abs(this.unk158) < this.unk164) this.unk158 = fr(this.unk158 + this.unk15C);
        else if (this.unk168 && this.hidden) {
            let o: MapObjBase | null;
            if (this.hidden.isActorType(AT.COIN)) {
                const im = mapObjGlobals(this.world).itemManager as ItemManager | null;
                o = im ? im.makeObjAppear(AT.COIN) : null;
            } else o = this.hidden;
            if (o) { this.throwObjToFront(o, 200, this.appearSpeed, this.appearYSpeed); this.unk168 = 0; }
        }
        return 1;
    }
    turn() {
        this.unk154 = fr(this.unk154 + this.unk158);
        this.unk154 = MsWrap(this.unk154, 0, 360);
        if (this.checkMapObjFlag(0x10000)) {
            if (Math.trunc(Math.abs(this.unk154)) % 180 === 0) this.unk158 = 0;
            else if (Math.abs(this.unk158) > Math.abs(this.unk160)) this.unk158 = fr(this.unk158 - this.unk160);
        } else {
            this.unk158 = fr(this.unk158 - this.unk160);
            if (Math.abs(this.unk158) < Math.abs(this.unk160)) this.unk158 = 0;
        }
    }
    /** the root matrix turned about the axis (the Y rotation applied after X or Z) */
    protected turnMtx(): Mtx {
        const m = mtx(), y = mtx();
        switch (this.unk150) {
            case 0:
                MsMtxSetRotX(m, this.rot.x);
                if (this.rot.y !== 0) { MsMtxSetRotY(y, this.rot.y); MTXConcat(y, m, m); }
                break;
            case 1: MsMtxSetRotY(m, this.rot.y); break;
            case 2:
                MsMtxSetRotZ(m, this.rot.z);
                if (this.rot.y !== 0) { MsMtxSetRotY(y, this.rot.y); MTXConcat(y, m, m); }
                break;
        }
        m[3] = this.pos.x; m[7] = fr(this.pos.y - this.yOffset); m[11] = this.pos.z;
        return m;
    }
    control() {
        MapObjBase.prototype.control.call(this);
        if (this.unk158 === 0) return;
        this.turn();
        switch (this.unk150) {
            case 0: this.rot.x = MsWrap(fr(this.unk154 + this.initialRot.x), 0, 360); break;
            case 1: this.rot.y = MsWrap(fr(this.unk154 + this.initialRot.y), 0, 360); break;
            case 2: this.rot.z = MsWrap(fr(this.unk154 + this.initialRot.z), 0, 360); break;
        }
        setRootMtx(this, this.turnMtx());
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (msg === MSG.ATTACH && (sender.isActorType(AT.COIN) || sender.isActorType(AT.COIN_RED) || sender.isActorType(AT.COIN_BLUE))) { this.unk168 = 1; return true; }
        // (the game's: TMapObjBase's, not THideObjBase's)
        return MapObjBase.prototype.receiveMessage.call(this, sender, msg);
    }
    loadAfter() { super.loadAfter(); if (this.hidden) this.unk168 = 1; }
    initMapObj() {
        super.initMapObj();
        if (this.isActorType(AT.DPT_WEATHERCOCK)) { this.unk150 = 1; this.unk15C = fr(0.5); this.unk164 = 10; this.unk160 = fr(0.01); }
    }
}

// ---------------------------------------------------------------- TBellWatermill
export class BellWatermill extends MapObjTurn {
    unk16C = 0; unk170 = 0; unk174 = 0; unk178 = 0; unk17C = 0; unk180 = 0; unk184 = 0; unk188 = 0; unk18C = 0; unk190 = 0;
    bells: (BiancoBell | null)[] = [null, null, null];
    unk1A0 = 0;
    constructor(w: World, name = 'ベル水車') { super(w, name); }
    touchWater(_a: HitActor) {
        this.unk190 = 1;
        if (Math.abs(this.unk158) > this.unk16C) { this.unk178 = fr(this.unk178 + this.unk180); this.unk158 = fr(this.unk158 + this.unk15C); }
        else this.unk158 = fr(this.unk158 + this.unk15C);
        if (this.unk158 > this.unk164) this.unk158 = this.unk164;
        return 1;
    }
    control() {
        MapObjBase.prototype.control.call(this);
        if (this.unk158 === 0 && this.unk178 === 0 && this.unk170 === 0) return;
        this.unk154 = fr(this.unk154 + MsClamp(this.unk158, -this.unk16C, this.unk16C));
        this.unk154 = MsWrap(this.unk154, 0, 360);
        this.world.sound(SE.OBJ_BI_UPDOWNMILL, this.pos);
        if (Math.abs(this.unk158) < Math.abs(this.unk160)) this.unk158 = 0;
        if (!this.unk190 && this.unk158 !== 0) this.unk158 = fr(this.unk158 - this.unk160);
        if (this.unk170 < 0) {
            if (Math.abs(this.unk178) < this.unk17C) { this.unk170 = 0; this.unk178 = 0; }
            else { this.unk170 = fr(this.unk170 - this.unk178); this.unk178 = fr(this.unk178 * -this.unk188); }
        } else if (!this.unk190 && this.unk170 !== 0) this.unk178 = fr(this.unk178 - this.unk184);
        this.unk170 = fr(this.unk170 + this.unk178);
        if (this.unk170 > this.unk174) {
            for (const b of this.bells) if (b) b.ring();
            this.unk170 = this.unk174;
            if (this.unk1A0) {
                const im = mapObjGlobals(this.world).itemManager as ItemManager | null;
                for (let i = 0; i < 5; i++) {
                    const it = im ? im.makeObjAppeared(AT.COIN) : null;
                    if (it) {
                        it.pos.set(this.pos);
                        // (the arguments' random draws in order: Z's, then Y's — control__14TBellWatermillFv
                        // 0x8019CFE4: the first roll goes into fmsubs 10 * r - 5, the second into fmadds 100 * r + 10)
                        const vz = fr(10 * MsRandF() - 5), vy = fr(100 * MsRandF() + 10);
                        it.vel.set(10, vy, vz);
                        it.offLiveFlag(LF.UNK10);
                    }
                }
                this.unk1A0 = 0;
            }
        }
        this.pos.y = fr(fr(this.unk170 + this.initialPos.y) + this.yOffset);
        this.unk190 = 0;
        this.rot.z = this.unk154;
        const m = mtx(), y = mtx();
        MsMtxSetRotZ(m, this.rot.z);
        if (this.rot.y !== 0) { MsMtxSetRotY(y, this.rot.y); MTXConcat(y, m, m); }
        m[3] = this.pos.x; m[7] = fr(this.pos.y - this.yOffset); m[11] = this.pos.z;
        setRootMtx(this, m);
    }
    loadAfter() {
        super.loadAfter();
        this.unk150 = 2; this.unk15C = fr(-0.02); this.unk160 = fr(-0.008); this.unk164 = 10; this.unk18C = 10; this.unk174 = 1000;
        this.unk180 = fr(0.15); this.unk184 = fr(0.1); this.unk16C = 4; this.unk188 = 0.5; this.unk17C = 1;
        this.bells = ['BiaBell 0', 'BiaBell 1', 'BiaBell 2'].map((n) => this.world.search(n) as BiancoBell | null);
        this.unk1A0 = 1;
    }
}

// ---------------------------------------------------------------- TLeafBoat
export class LeafBoat extends MapObjBase {
    unk138 = 0; unk13C = 0; unk140 = 0; unk144 = fr(0.03); unk148 = 0; unk14C = fr(1.2); unk150 = fr(0.03); unk154 = 2;
    unk158 = fr(0.005); unk15C = fr(0.98); unk160 = 0; unk164 = new V3();
    constructor(w: World, name = 'リーフボート') { super(w, name); }
    initMapObj() { super.initMapObj(); this.unk138 = 1; this.unk13C = 0.5; this.unk140 = 0.5; this.unk148 = fr(0.998); }
    touchActor(a: HitActor) {
        if (a.isActorType(AT.MARIO)) return;
        const d = new V3(fr(a.pos.x - this.pos.x), 0, fr(a.pos.z - this.pos.z));
        if (d.dot(this.vel) < 0) return;
        if (d.x !== 0 || d.z !== 0) normalize(d);
        const dot = fr(d.dot(this.vel));
        const k = a.isHitCategory(HC.ENEMY) ? this.unk138 : this.unk13C;
        this.vel.x = fr(this.vel.x - fr((1 + k) * fr(d.x * dot)));
        this.vel.z = fr(this.vel.z - fr((1 + k) * fr(d.z * dot)));
    }
    touchWall(p: V3, r: WallCheck) {
        for (const d of r.results) {
            if (this.vel.x * d.n[0] + this.vel.y * d.n[1] + this.vel.z * d.n[2] < 0) {
                const dist = fr(p.x * d.n[0] + p.y * d.n[1] + p.z * d.n[2] + d.d);
                p.x = fr(p.x + fr(this.bodyRadius - dist) * d.n[0]);
                p.z = fr(p.z + fr(this.bodyRadius - dist) * d.n[2]);
                const rf = this.vel.clone();
                this.calcReflectingVelocity(d, 1, rf);
                this.vel.x = fr(rf.x * this.unk140);
                this.vel.z = fr(rf.z * this.unk140);
                break;
            }
        }
    }
    bind() {
        let p = this.pos.clone();
        p.x = fr(p.x + this.vel.x); p.z = fr(p.z + this.vel.z);
        const [h, g] = this.world.checkGroundIgnoreWaterSurface(p.x, fr(this.pos.y - this.yOffset), p.z);
        if (h > this.pos.y - this.yOffset - 50) {
            const rf = this.vel.clone();
            this.calcReflectingVelocity(g, 1, rf);
            this.vel.x = fr(this.vel.x * -1); this.vel.z = fr(this.vel.z * -1);
            p = this.pos.clone();
        }
        const r: WallCheck = { center: [p.x, fr(p.y - this.yOffset), p.z], radius: this.bodyRadius, maxResults: 4, flags: DONT_MOVE_XZ, results: [] };
        if (this.world.isTouchedWallsAndMoveXZ(r)) this.touchWall(p, r);
        this.posDelta.set(V3.sub(p, this.pos));
        const m = this.world.mario.pos, dx = fr(m.x - this.pos.x), dz = fr(m.z - this.pos.z), rr = this.bodyRadius;
        if (m.y <= this.pos.y - this.yOffset && this.pos.y - this.yOffset - 100 < m.y && dx * dx + dz * dz < rr * rr) sendToMario(this.world, this, MSG.ATTACK);
    }
    control() {
        super.control();
        if (marioHipAttack(this)) this.vel.y = fr(this.vel.y - this.unk154);
        if (marioIsOn(this)) {
            this.vel.y = fr(this.vel.y - this.unk150);
            const g = marioWaterGun(this.world);
            if (g.emitting) {
                this.vel.x = fr(this.vel.x - fr(g.mtx[0] * this.unk144));
                this.vel.z = fr(this.vel.z - fr(g.mtx[8] * this.unk144));
            }
        }
        const c = inStreamCube(this.world, this.pos);
        if (c) {
            const m = mtx(); MsMtxSetXYZRPH(m, 0, 0, 0, c.r.x, c.r.y, c.r.z);
            const sp = fr(0.0001 * c.unk40);
            this.vel.x = fr(this.vel.x + fr(m[2] * sp));
            this.vel.z = fr(this.vel.z + fr(m[10] * sp));
        }
        this.pos.y = fr(this.pos.y + this.vel.y);
        this.vel.y = fr(this.vel.y + fr(this.unk158 * fr(this.initialPos.y - fr(this.pos.y - this.yOffset))));
        this.vel.y = fr(this.vel.y * this.unk15C);
        this.vel.x = fr(this.vel.x * this.unk148);
        this.vel.z = fr(this.vel.z * this.unk148);
    }
    /** calc: the ripples as it moves (every 9th frame) */
    calc() {
        if (this.unk144 === 0) return;
        if (this.unk160 > 8) {
            if (Math.abs(this.vel.x) + Math.abs(this.vel.z) > 0.1) {
                this.unk164.set(this.pos.x, fr(this.pos.y - this.yOffset), this.pos.z);
                this.world.effect('hamonB', this.unk164, new V3(2, 2, 2));
                this.world.effect('hamonA', this.unk164, new V3(2, 2, 2));
            }
            this.unk160 = 0;
        } else ++this.unk160;
    }
}

// ---------------------------------------------------------------- TLeafBoatRotten
export class LeafBoatRotten extends LeafBoat {
    static mAlphaDownSpeed = 0.5; static mCollisionRemoveAlpha = 100; static mRottenColor = { r: 100, g: 100, b: 180, a: 255 };
    unk170 = 0; unk174 = 0;
    /** unk178: the TEV colour (reg 0) it's drawn with: whiter to bluer as it rots, then fading out */
    tevColor = { r: 255, g: 255, b: 255, a: 255 };
    constructor(w: World, name = '腐ったリーフボート') { super(w, name); }
    load(s: Stream) { super.load(s); this.unk170 = Math.imul(s.s32(), 10); }
    control() {
        super.control();
        if (marioIsOn(this) && this.isState(STATE_NORMAL)) { this.stateTimer = this.unk170; this.state = 2; }
        const C = LeafBoatRotten.mRottenColor, t = this.tevColor;
        switch (this.state) {
            case 2: {
                const k = fr(this.stateTimer / this.unk170);
                t.r = Math.trunc(fr(fr((255 - C.r) * k) + C.r)) & 0xFF;
                t.g = Math.trunc(fr(fr((255 - C.g) * k) + C.g)) & 0xFF;
                t.b = Math.trunc(fr(fr((255 - C.b) * k) + C.b)) & 0xFF;
                if (!this.isStateTimerEngaged()) { this.unk174 = 255; this.state = 3; }
                break;
            }
            case 3: {
                this.unk174 = fr(this.unk174 - LeafBoatRotten.mAlphaDownSpeed);
                t.a = Math.trunc(this.unk174) & 0xFF;
                const a = this.colMgr && this.colMgr.getActiveCollision();
                if (this.unk174 < LeafBoatRotten.mCollisionRemoveAlpha && a && a.isSetUp()) this.removeMapCollision();
                if (this.unk174 <= 0) {
                    this.scale.set(1, 1, 1);
                    this.makeObjDefault();
                    this.makeObjAppeared();
                    t.r = t.g = t.b = t.a = 255;
                    this.state = STATE_NORMAL;
                }
                break;
            }
        }
    }
}

// ---------------------------------------------------------------- TLeanBlock (MapObjBlock.cpp)
export class LeanBlock extends MapObjBase {
    unk138 = 0; unk13C = 0; unk140 = 0; unk144 = 0; unk148 = 0;
    unk14C = new V3(0, 1, 0); unk158 = new V3();
    defaultMtx: Mtx = mtx();
    constructor(w: World, name = '傾くブロック') { super(w, name); }
    touchPlayer(_a: HitActor) {
        if (marioIsOn(this)) {
            const m = this.world.mario.pos;
            this.unk158.x = fr(this.unk158.x + fr(this.unk140 * fr(fr(m.x - this.pos.x) / this.unk138)));
            this.unk158.z = fr(this.unk158.z + fr(this.unk140 * fr(fr(m.z - this.pos.z) / this.unk13C)));
            this.unk158.y = fr(this.unk158.y - this.unk144);
        }
    }
    control() {
        super.control();
        const m = mtx();
        this.calcLeanMtx(m);
        setRootMtx(this, m);
        this.unk158.zero();
    }
    calcLeanMtx(out: Mtx) {
        const v = this.unk14C, d = this.unk158;
        if (d.x === 0 && d.y === 0 && d.z === 0) v.y = fr(v.y + this.unk144);
        else { v.x = fr(v.x + d.x); v.y = fr(v.y + d.y); v.z = fr(v.z + d.z); }
        normalize(v);
        // rotateVecByAxisY(axis, pi/2): TRotation3::setEular(0, a, 0).mult33 -- real
        // sinf/cosf(1.5707963705062866) rounded to f32, not Math.sin/cos of the 7-digit spelling.
        const s = sinf(HALF_PI_F), c = cosf(HALF_PI_F);
        const ax = new V3(FMA(s, v.z, fr(c * v.x)), 0, FMS(c, v.z, fr(s * v.x)));
        // length = MsSqrtf(...) (frsqrte + one Newton step in double), not Math.sqrt.
        const len = MsSqrtf(fr(fr(v.x * v.x) + fr(v.z * v.z)));
        const rot = fr(len * this.unk148);
        // makeObjMtxRotByAxis: the rotation, by the scale, at the place
        MTXRotAxisRad(out, ax, rot);
        const S = this.scale;
        for (let r = 0; r < 3; r++) { out[r * 4] = fr(out[r * 4] * S.x); out[r * 4 + 1] = fr(out[r * 4 + 1] * S.y); out[r * 4 + 2] = fr(out[r * 4 + 2] * S.z); }
        out[3] = this.pos.x; out[7] = fr(this.pos.y - this.yOffset); out[11] = this.pos.z;
        // concatOnlyRotFromRight(out, default, out)
        const t = [out[3], out[7], out[11]];
        out[3] = out[7] = out[11] = 0;
        MTXConcat(out, this.defaultMtx, out);
        out[3] = t[0]; out[7] = t[1]; out[11] = t[2];
    }
    calcDefaultMtx() { this.defaultMtx = Float64Array.from(this.rootMtx()); }
    initMapObj() {
        super.initMapObj();
        this.unk140 = fr(0.01); this.unk144 = fr(0.005); this.unk148 = 1;
        this.unk138 = fr(fr(this.scale.x * 100) / 2); this.unk13C = fr(fr(this.scale.z * 100) / 2);
        this.calcDefaultMtx();
    }
}

// ---------------------------------------------------------------- TMapObjFloatOnSea (MapObjFloat.cpp)
const FLOAT_PARAMS: [string, number, number, number, number, number, number, number, number, number, number][] = [
    ['riccoShip', 0.01, 0.01, 0.5, 150, 400, 40, 80, 3, 1, 0], ['ukisima', 0.01, 0.01, 0.1, 150, 400, 40, 80, 3, 1, 6.25],
    ['Buoy', 0.01, 0.01, 0.2, 100, 100, 40, 40, 2, 1, 3.2], ['riccoLog', 0.01, 0.01, 0.25, 100, 100, 40, 90, 3, 1, 4.5],
    ['riccoYachtL', 0.001, 0.005, 0.1, 250, 400, 40, 40, 3, 1, 0], ['riccoYachtS', 0.001, 0.005, 0.15, 250, 400, 40, 40, 3, 1, 0],
    ['riccoBoatL', 0.001, 0.005, 0.08, 250, 400, 40, 40, 3, 1, 0], ['riccoBoatS', 0.001, 0.005, 0.05, 250, 400, 40, 40, 3, 1, 0],
    ['riccoShipLog', 0, 0, 0, 1000, 500, 100, 0, 1, 0.5, 0], ['riccoShipDol', 0, 0, 0, 1000, 500, 100, 0, 1, 0.5, 0],
    ['mareWaterJump', 0.01, 0.01, 0.3, 150, 400, 40, 80, 3, 1, 6.5],
];
export class MapObjFloatOnSea extends LeanBlock {
    wave: MapObjLibWave | null = null; unk198 = 0; unk19C = 0; unk1A0 = new V3(); unk1AC = 0;
    constructor(w: World, name = '海に浮くオブジェ') { super(w, name); }
    touchPlayer(a: HitActor) { super.touchPlayer(a); if (marioIsOn(this) && this.wave) this.wave.push(); }
    control() {
        super.control();
        if (!this.wave) return;
        this.wave.movement();
        const m = Float64Array.from(this.rootMtx());
        m[7] = fr(m[7] + this.wave.getCurrentHeight(this.pos.x, this.pos.z));
        setRootMtx(this, m);
    }
    calc() {
        this.unk1A0.set(this.pos.x, 0, this.pos.z);
        if (this.unk19C > this.unk198) {
            const s = new V3(this.unk1AC, this.unk1AC, this.unk1AC);
            this.world.effect('hamonB', this.unk1A0, s);
            this.world.effect('hamonA', this.unk1A0, s);
            this.unk19C = 0;
        } else this.unk19C += 1;
    }
    initMapObj() {
        super.initMapObj();
        // (the game looks for the individual name and runs off the table's end without it)
        const p = FLOAT_PARAMS.find((e) => e[0] === this.individualName) || FLOAT_PARAMS[3];
        this.unk140 = fr(p[1]); this.unk144 = fr(p[2]); this.unk148 = fr(p[3]); this.unk138 = p[4]; this.unk13C = p[5];
        this.unk198 = 0xF; this.unk1AC = fr(p[10]);
        this.wave = new MapObjLibWave(this.world, p[6], p[7], p[8], p[9]);
    }
}

/** TWoodLog (RiccoLog): a swimming Mario is kept out of it (pushed to its side) */
export class WoodLog extends MapObjFloatOnSea {
    constructor(w: World, name = '丸太') { super(w, name); }
    control() {
        super.control();
        const R = this.rootMtx(), inv = mtxInverse(R);
        const l = mtxMultVec(inv, this.world.mario.pos);
        if (marioSwimming(this.world) && -232 < l.y && -141 < l.x && l.x < 141 && -441 < l.z && l.z < 441) {
            l.x = l.x > 0 ? 141 : -141;
            const wp = mtxMultVec(R, l);
            // SMS_MarioMoveRequest: the Mario the stage has moves there, if it can
            const m = this.world.mario as any;
            if (typeof m.moveRequest === 'function') m.moveRequest(wp);
        }
    }
}

// ---------------------------------------------------------------- registry
register('BigWindmill', (w, n) => new BigWindmill(w, n));
register('WindmillRoof', (w, n) => new MapObjBase(w, n));
register('BiaTurnBridge', (w, n) => new MapObjBase(w, n));
register('NormalBlock', (w, n) => new MapObjBase(w, n));
register('MapObjRootPakkun', (w, n) => new MapObjRootPakkun(w, n));
register('BiaWatermill', (w, n) => new BiancoWatermill(w, n));
register('BiaWatermillVertical', (w, n) => new BiancoWatermillVertical(w, n));
register('MiniWindmill', (w, n) => new BiancoMiniWindmill(w, n));
register('BiaBell', (w, n) => new BiancoBell(w, n));
register('BellWatermill', (w, n) => new BellWatermill(w, n));
// (MarNameRefGen_MapObj.cpp: Delfino Plaza's weathercock, a TMapObjTurn: its initMapObj sets the Y axis for DPT_WEATHERCOCK)
register('DolWeathercock', (w, n) => new MapObjTurn(w, n));
register('LeafBoat', (w, n) => new LeafBoat(w, n));
register('LeafBoatRotten', (w, n) => new LeafBoatRotten(w, n));
register('RiccoLog', (w, n) => new WoodLog(w, n));
export type { BGCheckData };
