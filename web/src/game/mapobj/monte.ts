// Pianta Village's own map objects (MoveBG/MapObjMonte.cpp): the jump mushrooms, the hanging bridge
// under the village (its boards sag under Mario and pull their neighbours down with them), the
// swinging boards (spraying while standing on one rocks it), the goal flag of the race and the
// dandelion fluff (drifting down, blown along by the wind when the big one passes the trigger
// height, coming back somewhere random). Also the breakable hidden objects of MapObjHide.cpp
// these stages use: the wooden boxes (ground-pounding one breaks the ones beside it too) and the
// watermelon blocks.
//
// The ropes of the bridge and the swinging boards are GX strips the game draws itself (drawRopes,
// drawRopeBetweenBoards, TSwingBoard::draw); they aren't drawn here.

import { fr, V3, Mtx, mtx, MsRandF, MsMtxSetXYZRPH } from '../math.js';
import { World, Stream, NameRef, HitActor, LF, HF, MSG } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { MapObjBase, STATE_NORMAL, mapObjGlobals, newAndRegisterObj, UNIQUE_MAKERS } from './base.js';
import { HideObjBase } from './hide.js';
import { MsMtxSetRotY, MTXConcat, makeRootMtxRot, setRootMtx, getWaterPos, marioWaterGun } from './lib.js';
import { LeanBlock, marioIsOn, marioHipAttack } from './bianco.js';

const STATE_UNK2 = 2, STATE_UNK3 = 3, STATE_UNK4 = 4;
/** sinf / cosf of an f32, rounded to f32 (the game's calls of the C library) */
/** 3.14f */
const PI_314 = fr(3.14);
const sinf = (a: number) => fr(Math.sin(fr(a))), cosf = (a: number) => fr(Math.cos(fr(a)));

// ---------------------------------------------------------------- TMapObjMonteRoot
export class MapObjMonteRoot extends MapObjBase {
    initMapObj() {
        super.initMapObj();
        this.damageHeight = fr(1400 * this.scale.y);
        this.calcEntryRadius();
        this.pos.y = fr(this.initialPos.y + this.yOffset);
    }
}

// ---------------------------------------------------------------- TJumpMushroom
export class JumpMushroom extends MapObjBase {
    receiveMessage(_sender: HitActor, _msg: number) { this.startAnim(1); return true; }
    load(s: Stream) {
        super.load(s);
        const data = s.s32();
        const a = this.colMgr && this.colMgr.getActiveCollision();
        if (a) a.setAllData(data);
    }
}

// ---------------------------------------------------------------- THangingBridgeBoard
export class HangingBridgeBoard extends LeanBlock {
    static mMarioAccelY = fr(0.15); static mMarioHipDropAccelY = 2; static mReturnAccelRate = fr(0.005); static mSpeedDownRate = fr(0.98);
    bridge: HangingBridge | null = null;
    prev: HangingBridgeBoard | null = null; next: HangingBridgeBoard | null = null;
    prev2: HangingBridgeBoard | null = null; next2: HangingBridgeBoard | null = null;
    /** unk1A4: where its two ropes hang from */
    ropes = [new V3(), new V3()];
    constructor(w: World, name = 'つり橋の板') { super(w, name); }
    push(v: number) { this.vel.y = fr(this.vel.y - v); }
    pushNeighbor(v: number) {
        const B = this.bridge!;
        if (this.prev) { this.prev.push(fr(v * B.unk40)); if (this.prev2) this.prev2.push(fr(v * B.unk44)); }
        if (this.next) { this.next.push(fr(v * B.unk40)); if (this.next2) this.next2.push(fr(v * B.unk44)); }
    }
    control() {
        super.control();
        const H = HangingBridgeBoard;
        if (marioIsOn(this)) { this.push(H.mMarioAccelY); this.pushNeighbor(H.mMarioAccelY); }
        if (marioHipAttack(this)) { this.push(H.mMarioHipDropAccelY); this.pushNeighbor(H.mMarioHipDropAccelY); }
        this.pos.y = fr(this.pos.y + this.vel.y);
        this.vel.y = fr(this.vel.y + fr(H.mReturnAccelRate * fr(this.initialPos.y - this.pos.y)));
        this.vel.y = fr(this.vel.y * H.mSpeedDownRate);
        const m = this.rootMtx(), w = this.bridge ? this.bridge.unk3C : 0;
        this.ropes[0].set(fr(this.pos.x - fr(m[0] * w)), fr(70 + fr(this.pos.y - fr(m[4] * w))), fr(this.pos.z - fr(m[8] * w)));
        this.ropes[1].set(fr(this.pos.x + fr(m[0] * w)), fr(70 + fr(this.pos.y + fr(m[4] * w))), fr(this.pos.z + fr(m[8] * w)));
    }
    calcDefaultMtx() {
        const rx = makeRootMtxRot(this, 'x'), ry = makeRootMtxRot(this, 'y');
        MTXConcat(ry, rx, ry);
        this.defaultMtx = ry;
        this.vel.y = 0;
        this.pos.y = this.initialPos.y;
    }
    // setGroundCollision: with Yoshi hatched and over the board, the collision follows the board's
    // matrix (moveActiveCollisionMtx) instead.
    // TODO: Yoshi isn't in the sim; always TMapObjBase's.
    initMapObj() {
        super.initMapObj();
        this.unk140 = fr(0.01); this.unk144 = fr(0.02); this.unk148 = fr(0.08);
    }
}
UNIQUE_MAKERS.set('HangingBridgeBoard', (w) => new HangingBridgeBoard(w));
UNIQUE_MAKERS.set('PinnaHangingBridgeBoard', (w) => new HangingBridgeBoard(w));

// ---------------------------------------------------------------- THangingBridge (a TViewObj)
const MONTE_BOARDS: [number, number, number, number][] = [
    [0, -130, 11965, 30], [0, -275, 12225, 29], [0, -415, 12490, 28], [0, -540, 12760, 26], [0, -660, 13035, 24], [0, -770, 13315, 22],
    [0, -875, 13595, 20], [0, -960, 13895, 12], [0, -1020, 14190, 8], [0, -1060, 14490, 4], [0, -1090, 14790, 2], [0, -1090, 15090, 0],
    [0, -1080, 15395, -4], [0, -1040, 15695, -6], [0, -995, 15990, -8], [0, -945, 16285, -8], [0, -900, 16580, -8], [0, -855, 16880, -8],
    [0, -800, 17175, -10], [-1, 0, 0, 0], [-99999, 0, 0, 0],
];
export class HangingBridge extends NameRef {
    static mRopeHeight = 0;
    boards: HangingBridgeBoard[] = [];
    unk18 = new V3(); unk24 = new V3(); unk30 = [0, 0];
    unk3C = 0; unk40 = 0; unk44 = 0;
    constructor(public world: World, name = 'つり橋') { super(name); }
    initMonte() {
        for (let i = 0; i < this.boards.length; i++) {
            const p = MONTE_BOARDS[i];
            if (p[0] === -1) break;
            const b = this.boards[i];
            b.initialPos.set(p[0], p[1], p[2]);
            b.pos.set(b.initialPos);
            b.rot.x = p[3];
            b.calcDefaultMtx();
        }
    }
    loadAfter() {
        const map = this.world.map;
        let rotY = 0, n = 0;
        if (map === 13) {
            n = 14; this.unk18.set(1550, 2980, -9410); this.unk24.set(3570, 2455, -9410);
            HangingBridge.mRopeHeight = 200; rotY = 90; this.unk40 = fr(0.8); this.unk44 = 0.5; this.unk3C = 150;
        } else if (map === 8) {
            n = 19; this.unk18.set(0, 0, 11356); this.unk24.set(0, -750, 17743);
            HangingBridge.mRopeHeight = 1000; this.unk40 = 1; this.unk44 = 0.5; this.unk3C = 315;
        }
        // (unk30: the bridge's direction across, for its ropes)
        let dx = fr(this.unk24.x - this.unk18.x), dz = fr(this.unk24.z - this.unk18.z);
        const l = Math.hypot(dx, dz) || 1; dx = fr(dx / l); dz = fr(dz / l);
        this.unk30 = [fr(-dz), dx];
        for (let i = 0; i < n; i++) {
            const t = fr(i / (n - 1));
            const pos = new V3(fr(fr(t * fr(this.unk24.x - this.unk18.x)) + this.unk18.x),
                fr(fr(fr(t * fr(this.unk24.y - this.unk18.y)) + this.unk18.y) - 0),
                fr(fr(t * fr(this.unk24.z - this.unk18.z)) + this.unk18.z));
            const b = newAndRegisterObj(this.world, map === 8 ? 'HangingBridgeBoard' : 'PinnaHangingBridgeBoard', pos, new V3(15, rotY, 0), new V3(1, 1, 1)) as HangingBridgeBoard | null;
            if (!b) continue;
            b.bridge = this;
            b.appear();
            this.boards.push(b);
        }
        if (map === 8) this.initMonte();
        if (map === 13) { this.unk18.set(1350, 2980, -9410); this.unk24.set(3650, 2455, -9410); }
        const B = this.boards;
        for (let i = 0; i < B.length; i++) {
            if (i > 0) B[i].prev = B[i - 1];
            if (i > 1) B[i].prev2 = B[i - 2];
            if (i < B.length - 1) B[i].next = B[i + 1];
            if (i < B.length - 2) B[i].next2 = B[i + 2];
        }
    }
}

// ---------------------------------------------------------------- TSwingBoard
export class SwingBoard extends MapObjBase {
    static mReturnAccelRate = fr(0.0001); static mSpeedDownRate = fr(0.998);
    /** unk138: the rope length; unk13C its angle (degrees), unk144 its speed, unk148 the speed past which it slows; unk140 how much a spray pushes */
    unk138 = 5000; unk13C = 0; unk140 = 0; unk144 = 0; unk148 = 0;
    unk14C: Mtx = mtx(); unk17C = new V3();
    constructor(w: World, name = 'ブランコ') { super(w, name); }
    swing() {
        const g = marioWaterGun(this.world);
        if (marioIsOn(this) && g.emitting) {
            const e = g.mtx, d = new V3(-e[0], 0, -e[8]);
            const m = this.rootMtx();
            this.unk144 = fr(this.unk144 + fr(this.unk140 * fr(fr(fr(m[2] * d.x) + fr(m[6] * d.y)) + fr(m[10] * d.z))));
        }
    }
    control() {
        super.control();
        if (marioIsOn(this)) this.swing();
        const S = SwingBoard;
        this.unk13C = fr(this.unk13C + this.unk144);
        const old = this.unk144;
        this.unk144 = fr(this.unk144 - fr(this.unk13C * S.mReturnAccelRate));
        if (Math.abs(this.unk144) > this.unk148) this.unk144 = fr(this.unk144 * S.mSpeedDownRate);
        if (fr(old * this.unk144) <= 0) this.world.sound(this.unk144 > 0 ? SE.OBJ_SWING1 : SE.OBJ_SWING2, this.pos);
        this.rot.x = -this.unk13C;
        const a = fr(PI_314 * fr(this.rot.x / 180)), sn = sinf(a), cs = cosf(a);
        const r = mtx();
        r[0] = 1; r[1] = 0; r[2] = 0; r[3] = 0;
        r[4] = 0; r[5] = cs; r[6] = -sn; r[7] = 0;
        r[8] = 0; r[9] = sn; r[10] = cs; r[11] = 0;
        const m = mtx();
        MTXConcat(this.unk14C, r, m);
        this.pos.x = fr(this.initialPos.x - fr(m[1] * this.unk138));
        this.pos.y = fr(fr(this.unk138 + this.initialPos.y) - fr(m[5] * this.unk138));
        this.pos.z = fr(this.initialPos.z - fr(m[9] * this.unk138));
        // (the model's root matrix: its scale stays as getAnmMtx(0) had it)
        m[3] = this.pos.x; m[7] = this.pos.y; m[11] = this.pos.z;
        setRootMtx(this, m);
    }
    load(s: Stream) {
        super.load(s);
        this.unk138 = s.f32();
        if (this.unk138 === -1) this.unk138 = 5000;
        this.unk140 = s.f32();
        if (this.unk140 > 10 || this.unk140 === 0) this.unk140 = fr(0.003);
        this.unk17C.set(this.pos.x, fr(this.pos.y + this.unk138), this.pos.z);
        this.unk148 = fr(fr(0.05) * fr(fr(1 + MsRandF()) / 2));
        this.unk13C = fr(20 * fr(MsRandF() - 0.5));
        if (this.unk13C > 0) this.unk144 = fr(this.unk148 * -MsRandF());
        else this.unk144 = fr(this.unk148 * MsRandF());
        MsMtxSetRotY(this.unk14C, this.rot.y);
    }
}

// ---------------------------------------------------------------- TGoalFlag
export class GoalFlag extends MapObjBase {
    touchActor(a: HitActor) {
        if (a.isActorType(AT.MARIO)) {
            // TFlagManager MSF_RACE_GOAL_REACHED
            (this.world as any).raceGoalReached = true;
            a.receiveMessage(this, MSG.ATTACK);
        } else if (a.isActorType(AT.E_MARIO)) a.receiveMessage(this, MSG.ATTACK);
    }
}

// ---------------------------------------------------------------- TFluff / TFluffManager
/** gpMapObjManager->unkD0: the wind the big fluff starts */
const WIND = new WeakMap<World, V3>();
export const mapObjWind = (w: World) => { let v = WIND.get(w); if (!v) { v = new V3(); WIND.set(w, v); } return v; };

export class Fluff extends MapObjBase {
    static mScaleUpSpeed = fr(0.05); static mScaleDownSpeed = fr(0.01);
    unk138 = 0; unk13C = 0; unk140 = 0; unk144 = 0; unk148 = 0; unk14C = 0; unk150 = 0;
    unk154 = 0; unk158 = 0; unk15C = 0; unk160 = 1; unk164 = fr(0.95);
    mgr: FluffManager | null = null; unk16C = 0;
    constructor(w: World, name = 'わた毛') { super(w, name); }
    touchWater(a: HitActor) {
        const p = getWaterPos(this.world, a);
        // getNormalVecFromTarget: the unit vector from the target to this
        let nx = fr(this.pos.x - p.x), ny = fr(this.pos.y - p.y), nz = fr(this.pos.z - p.z);
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (l > 0) { nx = fr(nx / l); ny = fr(ny / l); nz = fr(nz / l); }
        this.vel.x = fr(this.vel.x - fr(nx * this.unk160));
        this.vel.y = fr(this.vel.y - fr(ny * this.unk160));
        this.vel.z = fr(this.vel.z - fr(nz * this.unk160));
        return 1;
    }
    move() {
        const W = mapObjWind(this.world);
        this.pos.y = fr(this.pos.y - this.unk13C);
        if (this.pos.y < 0) this.pos.y = 5000;
        this.unk154 = fr(this.unk154 + fr(this.unk150 * W.x));
        this.unk15C = fr(this.unk15C + fr(this.unk150 * W.z));
        this.unk154 = fr(this.unk154 + this.vel.x);
        this.unk158 = fr(this.unk158 + this.vel.y);
        this.unk15C = fr(this.unk15C + this.vel.z);
        this.vel.scale(this.unk164);
        const wave = fr(this.unk138 * sinf(fr(fr(PI_314 * this.unk148) / 180)));
        this.pos.x = fr(fr(this.initialPos.x + fr(wave * fr(this.unk144 + this.unk140))) + this.unk154);
        this.pos.y = fr(this.pos.y + fr(this.unk150 * W.y));
        this.pos.z = fr(fr(this.initialPos.z + fr(wave * fr(this.unk140 - this.unk144))) + this.unk15C);
        if (W.x === 0 && W.y === 0 && W.z === 0) {
            this.unk148 = fr(this.unk148 + this.unk14C);
            if (this.unk148 > 360) this.unk148 = fr(this.unk148 - 360);
        }
        if (this.held && this.held.isActorType(AT.MARIO)) this.world.mario.pos.y = fr(this.world.mario.pos.y - this.unk13C);
    }
    kill() {
        if (this.held) { this.held.receiveMessage(this, MSG.DETACH); this.held = null; }
        this.state = STATE_UNK3;
    }
    control() {
        super.control();
        this.move();
        switch (this.state) {
            case STATE_UNK2: {
                const v = Fluff.mScaleUpSpeed;
                this.scale.set(fr(this.scale.x + v), fr(this.scale.y + v), fr(this.scale.z + v));
                if (this.scale.x > 1) { this.scale.setAll(1); this.setObjHitData(0); this.state = STATE_NORMAL; }
                break;
            }
            case STATE_NORMAL: {
                const [h, d] = this.world.checkGround(this.pos.x, this.pos.y, this.pos.z);
                this.groundHeight = h; this.groundPlane = d;
                if (this.vel.y < 0 && (h > fr(this.pos.y - this.unk13C) || this.pos.y < -1000)) this.kill();
                if (this.world.col.checkWalls({ center: [this.pos.x, this.pos.y, this.pos.z], radius: 100, maxResults: 1, flags: 0, results: [] }) !== 0) this.kill();
                if (this.pos.x < -14848 || 14848 < this.pos.x || this.pos.z < -19968 || 19968 < this.pos.z) this.kill();
                break;
            }
            case STATE_UNK3: {
                const v = Fluff.mScaleDownSpeed;
                this.scale.set(fr(this.scale.x - v), fr(this.scale.y - v), fr(this.scale.z - v));
                if (this.scale.x < fr(0.1)) {
                    this.emit('ms_enm_disap_a_w');
                    this.world.sound(SE.SMOKE_EFFECT, this.pos);
                    this.scale.setAll(fr(0.0001));
                    this.stateTimer = 240;
                    this.state = STATE_UNK4;
                }
                break;
            }
            case STATE_UNK4:
                if (!this.isStateTimerEngaged()) {
                    this.appear();
                    this.rot.set(0, fr(360 * MsRandF()), 0);
                    this.initialRot.set(this.rot);
                    this.unk16C = 0;
                    this.mgr!.registerNextFluff(this);
                }
                break;
        }
    }
    appear() {
        this.makeObjAppeared();
        const M = this.mgr!;
        // (the arguments are evaluated last first: z, then y, then x, as the DOL calls them)
        const z = M.getRandomZ(), y = fr(M.pos.y * MsRandF()), x = M.getRandomX();
        this.pos.set(x, y, z);
        this.initialPos.set(this.pos);
        this.scale.setAll(fr(0.0001));
        this.unk15C = 0; this.unk158 = 0; this.unk154 = 0; this.unk148 = 0;
        this.unk150 = fr(fr(0.8) * MsRandF() + fr(0.2));   // (fmadds)
        this.unk140 = sinf(fr(fr(PI_314 * this.rot.y) / 180));
        this.unk144 = cosf(fr(fr(PI_314 * this.rot.y) / 180));
        this.unk148 = fr(360 * MsRandF());
        this.unk14C = fr(0.3);
        this.state = STATE_UNK2;
    }
    initMapObj() { super.initMapObj(); this.unk138 = 300; this.unk13C = 0.5; }
}

export class FluffManager extends MapObjBase {
    static mWindMin = 1;
    unk138 = 0; unk13C = 0; unk140 = 0; unk144 = 0; unk148 = new V3(); unk154 = 0;
    /** unk158 the big fluff, unk15C the next one */
    unk158: Fluff | null = null; unk15C: Fluff | null = null;
    fluffs: Fluff[] = [];
    constructor(w: World, name = 'わた毛管理') { super(w, name); }
    findNextFluff() {
        const m = this.world.mario.pos;
        for (let i = 3; i < this.fluffs.length; i++) {
            const f = this.fluffs[i];
            if (f.unk16C === 0 && !f.held && Math.hypot(f.pos.x - m.x, f.pos.y - m.y, f.pos.z - m.z) > 3000) { this.unk15C = f; f.kill(); break; }
        }
    }
    control() {
        const W = mapObjWind(this.world), big = this.unk158!;
        switch (this.state) {
            case STATE_NORMAL:
                if (!this.unk15C && fr(big.pos.y - 100) < fr(this.pos.y - this.unk140)) this.findNextFluff();
                if (big.pos.y < fr(this.pos.y - this.unk140)) {
                    this.world.sound(SE.OBJ_WATAGE_WIND, big.pos);
                    this.stateTimer = this.unk144;
                    this.state = STATE_UNK2;
                }
                break;
            case STATE_UNK2:
                W.set(fr(W.x + this.unk148.x), fr(W.y + this.unk148.y), fr(W.z + this.unk148.z));
                if (!this.isStateTimerEngaged()) this.state = STATE_UNK3;
                break;
            case STATE_UNK3: {
                const v = new V3(W.x, W.y, W.z).scale(this.unk154);
                const n = FluffManager.mWindMin;
                if (Math.abs(v.x) < n && Math.abs(v.y) < n && Math.abs(v.z) < n) { v.setAll(0); this.setUpNextFluff(); this.state = STATE_NORMAL; }
                W.set(v);
                break;
            }
        }
    }
    registerNextFluff(f: Fluff) { if (!this.unk15C) { this.unk15C = f; f.makeObjDead(); } }
    setUpNextFluff() {
        const f = this.unk15C!;
        this.unk158 = f;
        f.rot.set(this.rot); f.initialRot.set(this.rot);
        f.appear();
        f.pos.set(this.pos); f.initialPos.set(this.pos);
        f.rot.setAll(0); f.initialRot.set(f.rot);
        f.unk148 = 0; f.unk150 = 1; f.unk16C = 1;
        this.unk15C = null;
    }
    newFluff(name: string) {
        const f = new Fluff(this.world, name);
        f.initAndRegister('Fluff');
        f.mgr = this;
        return f;
    }
    getRandomX() { return fr(this.unk138 * fr(fr(2 * MsRandF()) - 1)); }
    getRandomZ() { return fr(this.unk13C * fr(fr(2 * MsRandF()) - 1)); }
    loadAfter() {
        const a = this.newFluff('１つ目のわた毛');
        this.unk158 = a; a.unk16C = 1;
        a.appear();
        a.pos.set(this.pos); a.rot.set(this.rot);
        { const z = this.getRandomZ(), y = fr(this.pos.y * MsRandF()), x = this.getRandomX(); a.initialPos.set(x, y, z); }
        this.fluffs.push(a);
        const b = this.newFluff('２つ目のわた毛');
        this.unk15C = b;
        b.pos.set(this.pos); b.rot.set(this.rot);
        { const z = this.getRandomZ(), y = fr(this.pos.y * MsRandF()), x = this.getRandomX(); b.initialPos.set(x, y, z); }
        b.makeObjDead();
        this.fluffs.push(b);
        for (let i = 2; i < 32; i++) { const f = this.newFluff('わた毛'); f.appear(); this.fluffs.push(f); }
    }
    load(s: Stream) {
        super.load(s);
        this.unk140 = s.f32();
        const scale = fr(s.f32() * fr(0.01));
        this.unk144 = s.s32();
        this.unk138 = 5000; this.unk13C = 5000; this.unk154 = fr(0.998);
        const m = mtx();
        MsMtxSetXYZRPH(m, 0, 0, 0, this.rot.x, this.rot.y, this.rot.z);
        // unk148 = m * (0, 0, 1), by the scale
        this.unk148.set(fr(m[2] * scale), fr(m[6] * scale), fr(m[10] * scale));
    }
}

// ---------------------------------------------------------------- MapObjHide.cpp: the breakable ones
export class BreakHideObj extends HideObjBase {
    constructor(w: World, name = '壊れる隠しオブジェ') { super(w, name); }
    kill() {
        this.startAnim(2);
        this.removeMapCollision();
        this.onHitFilter(HF.NO_COLLISION);
        this.onLiveFlag(LF.UNK10 | LF.UNK8);
        this.stateTimer = -1;
        this.state = 2;
    }
    receiveMessage(_sender: HitActor, msg: number) {
        if (msg === MSG.HIP_DROP) {
            if (this.isActorType(AT.WATER_MELON_BLOCK)) {
                this.emit('WaterMelonBlockA'); this.emit('WaterMelonBlockB');
                this.world.sound(SE.OBJ_WATERMELON_BLOCK, this.pos);
            }
            this.kill();
            return true;
        }
        return false;
    }
    control() {
        MapObjBase.prototype.control.call(this);
        if (this.state === 2 && this.animIsFinished()) { this.appearObj(0); this.makeObjDead(); }
    }
}
export class WoodBox extends BreakHideObj {
    constructor(w: World, name = '木箱') { super(w, name); }
    killNearWoodBox(dx: number, dz: number) {
        const m = this.world.mario.pos;
        const [y, d] = this.world.checkGround(fr(dx + m.x), fr(m.y + 1000), fr(dz + m.z));
        if (fr(y + 10) > m.y) {
            const a = d && d.actor;
            if (a && a !== this && a.isActorType(AT.WOOD_BOX)) (a as WoodBox).kill();
        }
    }
    kill() {
        super.kill();
        this.world.sound(SE.IT_BARREL_CRASH, this.pos);
        this.killNearWoodBox(-50, -50); this.killNearWoodBox(50, -50);
        this.killNearWoodBox(-50, 50); this.killNearWoodBox(50, 50);
    }
    // loadAfter's checkOnManhole: a box on a manhole (Delfino Plaza's) rides it.
    // TODO: TManhole isn't ported.
}

// ---------------------------------------------------------------- registry
register('MonteRoot', (w, n) => new MapObjMonteRoot(w, n));
register('JumpMushroom', (w, n) => new JumpMushroom(w, n));
register('HangingBridge', (w, n) => new HangingBridge(w, n));
register('SwingBoard', (w, n) => new SwingBoard(w, n));
register('GoalFlag', (w, n) => new GoalFlag(w, n));
register('FluffManager', (w, n) => new FluffManager(w, n));
register('FruitTree', (w, n) => new MapObjBase(w, n));
register('WatermelonBlock', (w, n) => new BreakHideObj(w, n));
register('WoodBox', (w, n) => new WoodBox(w, n));
export { STATE_UNK2, STATE_UNK3, mapObjGlobals };
