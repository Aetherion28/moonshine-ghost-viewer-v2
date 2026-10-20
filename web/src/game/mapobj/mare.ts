// Noki Bay's own map objects (MoveBG/MapObjMare.cpp): the balance (天秤, "Cogwheel": a wheel with a
// plate hanging on one side and a pot on the other; Mario's weight, the water sprayed into the pot
// and ground-pounding the plate tip it, the pans bouncing back off the ends of the ropes), the
// elastic cord (ゴムひも: a thing hanging off a spring that sags under what's held on it), the
// sprouting tree (もやしの木: sprayed it grows and becomes solid, then shrinks back), the purple bell
// riding a wire, the puncher (パンチャー: a hidden glove that throws Mario off when he walks into it,
// then winds back and disappears), the waterfall (MareFall: only its sounds and spray), the cork
// in the cannon at the top of the waterfall ("Uncork the Waterfall": once the cannon is open it
// pops, gives the boss shine at frame 250 and lets the water out) and the event points (sprayed
// from the front, they start the wall-depressing event of Map/MapEventMare.cpp).
//
// Not here: the ropes the balance and the bell draw themselves (GX strips), the sprout's BTP,
// particles (told as world effects where the game emits them), the BAS-driven sounds (soundBas,
// setAnmSound) and the cork's drawObject (only its sound and spray). MuddyBoat (also in this TU) is
// in corona.ts. MareGate isn't in this TU.

import { fr, V3, mtx, MsMtxSetRotRPH, mtxMultVec } from '../math.js';
import { World, Stream, Actor, HitActor, TakeActor, HF, MSG, ANM_BCK } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import '../mapwire.js';
import { MapObjBase, STATE_NORMAL, mapObjGlobals, newAndRegisterObj, UNIQUE_MAKERS } from './base.js';
import { MTXConcat, makeRootMtxRot, setRootMtx, restJointMtx, waterID, getWaterPlane, marioSpeedY, sendToMario } from './lib.js';
import { marioIsOn } from './bianco.js';
import { MsMtxSetTRS } from './objcol.js';
import type { ItemManager } from './item.js';

const STATE_UNK2 = 2;
const DEG = 0.017453294;
const sinf = (a: number) => fr(Math.sin(fr(a))), cosf = (a: number) => fr(Math.cos(fr(a)));

// ---------------------------------------------------------------- TCogwheelScale
/** One of the balance's two pans (cogwheel_plate / cogwheel_pot). */
export class CogwheelScale extends MapObjBase {
    static mWaterLeakSpeed = fr(0.01);
    /** unk138 its base weight, unk13C Mario's weight on it, unk140 the water in it (up to unk144), unk148 this tick's Mario weight,
     *  unk14C the head-attack rate, unk150 a hip drop's push, unk154 1 for the plate, unk158 the wheel */
    unk138 = 0; unk13C = 0; unk140 = 0; unk144 = 0; unk148 = 0; unk14C = fr(0.01); unk150 = 5; unk154 = 0;
    unk158: Cogwheel | null = null;
    constructor(w: World, name: string) { super(w, name); }
    touchWater(_a: HitActor) { if (this.unk140 < this.unk144) this.unk140 = fr(this.unk140 + 1); return 1; }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (msg === MSG.HIP_DROP) { const c = this.unk158!; c.unk138 = fr(c.unk138 + this.unk150); return true; }
        return super.receiveMessage(sender, msg);
    }
    touchPlayer(_a: HitActor) {
        if (marioIsOn(this)) this.unk148 = this.unk13C;
        const c = this.unk158!;
        if (fr(this.pos.y - this.yOffset) > fr(150 + this.world.mario.pos.y)) {
            if ((this.unk154 && c.unk138 > 0) || (!this.unk154 && c.unk138 < 0)) {
                c.rebound();
                if (this.marioHeadAttack()) c.unk138 = fr(this.unk14C * fr(c.unk138 * marioSpeedY(this.world)));
            }
        }
        this.unk140 = 0;
    }
    control() {
        this.unk148 = 0;
        super.control();
        if (this.unk140 > 0) {
            this.unk140 = fr(this.unk140 - CogwheelScale.mWaterLeakSpeed);
            this.world.sound(SE.OBJ_MR_TSUBO_WATER, this.pos);
            if (this.unk140 < 0) this.unk140 = 0;
        }
    }
}
UNIQUE_MAKERS.set('cogwheel_plate', (w) => new CogwheelScale(w, 'cogwheel_plate'));
UNIQUE_MAKERS.set('cogwheel_pot', (w) => new CogwheelScale(w, 'cogwheel_pot'));

// ---------------------------------------------------------------- TCogwheel
const sRadius = 800;
export class Cogwheel extends MapObjBase {
    static mRopeWidthX = 10; static mRopeWidthZ = 7; static mTexPosRate = fr(0.01); static mMinSpeed = 3;
    /** unk138 the rope's speed, unk13C how far it has run (the plate's drop), unk140 the weight's pull, unk144 the damping,
     *  unk148 the bounce, unk14C the rope's length, unk160 / unk174 the plate's and pot's ends; unk150 / unk164 the plate and pot,
     *  unk154 / unk168 where their ropes hang */
    unk138 = 0; unk13C = 0; unk140 = 0; unk144 = 0; unk148 = 0; unk14C = 0;
    unk150: CogwheelScale | null = null; unk154 = new V3(); unk160 = 0;
    unk164: CogwheelScale | null = null; unk168 = new V3(); unk174 = 0;
    constructor(w: World, name = '天秤') { super(w, name); }
    /** rebound */
    rebound() {
        this.unk138 = fr(this.unk138 * -this.unk148);
        if (Math.abs(this.unk138) < Cogwheel.mMinSpeed) this.unk138 = 0;
    }
    calc() {
        const length = fr(fr(3.14) * fr(2 * sRadius));
        const rate = fr(-this.unk13C / length);
        this.rot.z = fr(360 * rate);
        const rz = makeRootMtxRot(this, 'z'); rz[3] = 0; rz[7] = 0; rz[11] = 0;
        const ry = makeRootMtxRot(this, 'y'); ry[3] = 0; ry[7] = 0; ry[11] = 0;
        const m = mtx();
        MTXConcat(ry, rz, m);
        m[3] = this.pos.x; m[7] = this.pos.y; m[11] = this.pos.z;
        setRootMtx(this, m);
    }
    control() {
        super.control();
        const L = this.unk150!, R = this.unk164!;
        this.unk13C = fr(this.unk13C + this.unk138);
        const panR = fr(fr(R.unk138 + R.unk140) + R.unk148);
        const panL = fr(fr(L.unk138 + L.unk140) + L.unk148);
        this.unk138 = fr(this.unk138 + fr(fr(panL - panR) * this.unk140));
        this.unk138 = fr(this.unk138 * this.unk144);
        if (this.unk13C < this.unk160 && this.unk138 < 0) this.rebound();
        if (this.unk13C > fr(this.unk14C - this.unk174) && this.unk138 > 0) this.rebound();
        L.pos.y = fr(fr(this.pos.y - this.unk13C) + L.yOffset);
        R.pos.y = fr(this.pos.y - fr(this.unk14C - this.unk13C));
        if (Math.abs(this.unk138) > Cogwheel.mMinSpeed) this.world.sound(SE.OBJ_MR_TSUBO_PULL, this.pos);
    }
    initMapObj() {
        super.initMapObj();
        // TVec2(sRadius, 0).rotate(rot.y in radians)
        const a = fr(DEG * this.rot.y), c = cosf(a), s = sinf(a);
        const dx = fr(fr(sRadius * c) - fr(0 * s)), dz = fr(fr(sRadius * s) + fr(0 * c));
        const pos = new V3(fr(this.pos.x + dx), this.pos.y, fr(this.pos.z - dz));
        const plate = newAndRegisterObj(this.world, 'cogwheel_plate', pos, this.rot, new V3(1, 1, 1)) as CogwheelScale;
        this.unk150 = plate; plate.unk154 = 1; plate.unk158 = this;
        plate.appear();
        this.unk154.set(pos.x, this.pos.y, pos.z);
        pos.set(fr(this.pos.x - dx), this.pos.y, fr(this.pos.z + dz));
        const pot = newAndRegisterObj(this.world, 'cogwheel_pot', pos, this.rot, new V3(1, 1, 1)) as CogwheelScale;
        this.unk164 = pot; pot.unk154 = 0; pot.unk158 = this;
        pot.appear();
        this.unk168.set(pos.x, this.pos.y, pos.z);
        if (this.name === '天秤上') {
            this.unk140 = fr(0.003); this.unk144 = fr(0.99); this.unk148 = fr(0.8); this.unk14C = 3800; this.unk160 = 1000; this.unk174 = 1800;
        } else {
            this.unk140 = fr(0.008); this.unk144 = fr(0.98); this.unk148 = fr(0.8); this.unk14C = 3950; this.unk160 = 1000; this.unk174 = 1900;
        }
        pot.unk138 = 0; pot.unk13C = 0; pot.unk144 = 14;
        plate.unk138 = 10; plate.unk13C = 0; plate.unk144 = 0;
        this.unk13C = fr(this.unk14C / 2);
    }
}

// ---------------------------------------------------------------- TMapObjElasticCode
export class MapObjElasticCode extends MapObjBase {
    /** unk138 the held thing's weight, unk13C the spring, unk140 the damping */
    unk138 = 0; unk13C = 0; unk140 = 0;
    constructor(w: World, name = 'ゴムひも') { super(w, name); }
    control() {
        super.control();
        this.vel.y = fr(this.vel.y * this.unk140);
        this.vel.y = fr(this.vel.y + fr(fr(this.unk13C * fr(this.initialPos.y - this.pos.y)) - this.getGravityY()));
        const h = this.held as any;
        if (h) {
            this.vel.y = fr(this.vel.y - this.unk138);
            const p = (h.pos as V3).clone();
            p.y = fr(p.y + this.vel.y);
            if (typeof h.moveRequest === 'function') h.moveRequest(p);
        }
        this.pos.y = fr(this.pos.y + this.vel.y);
    }
    initMapObj() {
        super.initMapObj();
        this.unk140 = fr(0.997); this.gravity = fr(0.01); this.unk138 = 2; this.unk13C = fr(0.0005);
    }
}

// ---------------------------------------------------------------- TMapObjGrowTree
const mGrowStartFrame = 90, mGrowEndFrame = 175;
export class MapObjGrowTree extends MapObjBase {
    /** unk138 its full height, unk13C the growth per spray, unk140 the shrink per tick, unk144 how long it stays grown, unk148 its first height */
    unk138 = 0; unk13C = 0; unk140 = 0; unk144 = 0; unk148 = 0;
    constructor(w: World, name = 'もやしの木') { super(w, name); }
    private fc() { return this.mactor ? this.mactor.getFrameCtrl(ANM_BCK) : null; }
    private frame() { const f = this.fc(); return f ? f.frame : 0; }
    private setFrame(v: number) { const f = this.fc(); if (f) f.frame = v; }
    private setDamageHeight(v: number) { this.damageHeight = v; this.calcEntryRadius(); }
    /** getGrowHeightFromRate */
    getGrowHeightFromRate(rate: number) {
        if (mGrowStartFrame < this.frame() && this.frame() < mGrowEndFrame) return fr(fr(rate * this.unk138) / (mGrowEndFrame - mGrowStartFrame));
        return 0;
    }
    /** updateHeight */
    updateHeight() {
        if (this.frame() > mGrowStartFrame) {
            if (this.frame() > mGrowEndFrame) this.setDamageHeight(this.unk138);
            else this.setDamageHeight(fr(this.unk148 + fr(fr(fr(this.unk138 - this.unk148) * fr(this.frame() - mGrowStartFrame)) / (mGrowEndFrame - mGrowStartFrame))));
        } else this.setDamageHeight(this.unk148);
    }
    private moveHeld(dy: number) {
        const h = this.held as any;
        if (!h) return;
        const p = (h.pos as V3).clone();
        p.y = fr(p.y + dy);
        if (typeof h.moveRequest === 'function') h.moveRequest(p);
    }
    touchWater(a: HitActor) {
        if (a.pos.y > fr(this.pos.y + this.unk148)) return 0;
        if (this.isState(STATE_NORMAL)) {
            this.startAnim(1);
            const f = this.fc(); if (f) f.rate = 0;
            this.state = STATE_UNK2;
        }
        const f = this.fc();
        if (f && f.frame < f.end) {
            this.setFrame(fr(this.unk13C + this.frame()));
            this.updateHeight();
            this.moveHeld(this.getGrowHeightFromRate(this.unk13C));
        }
        if (this.frame() > mGrowEndFrame) {
            this.setUpMapCollision(0);
            this.stateTimer = this.unk144;
        }
        return 1;
    }
    control() {
        super.control();
        if (this.isState(STATE_UNK2) && this.collisions.length === 0 && !this.isStateTimerEngaged() && this.frame() > 0) {
            if (this.frame() < mGrowEndFrame) this.removeMapCollision();
            this.setFrame(fr(this.frame() - this.unk140));
            if (this.frame() < 0) {
                this.startAnim(0);
                this.state = STATE_NORMAL;
            } else {
                const frame = this.frame();
                if (67 <= frame && frame <= 240) this.world.sound(SE.OBJ_SAMDBOMB_REVERSE, this.pos);
                this.updateHeight();
                this.moveHeld(-this.getGrowHeightFromRate(this.unk140));
            }
        }
    }
    loadAfter() { super.loadAfter(); this.removeMapCollision(); }
    initMapObj() {
        super.initMapObj();
        this.unk138 = 1000; this.unk13C = 0.5; this.unk140 = fr(0.1); this.unk144 = 360;
        this.unk148 = this.damageHeight;
        // (mMActor->setBtp("moyasi_wink"): drawing only)
    }
}

// ---------------------------------------------------------------- TWireBell
export class WireBell extends MapObjBase {
    /** unk138 its wire, unk13C how far below the wire it hangs, unk140 - unk148 its rope's drawing, unk14C its point on the wire */
    unk138 = -1; unk13C = 200; unk140 = 10; unk144 = 5; unk148 = fr(0.01); unk14C = new V3();
    constructor(w: World, name = 'ワイヤー鈴（紫）') { super(w, name); }
    control() {
        const wm = this.world.mapWires;
        if (wm) this.unk14C.set(wm.getPointOnWire(this.unk138, this.pos));
        this.pos.set(this.unk14C.x, fr(this.unk14C.y - this.unk13C), this.unk14C.z);
        const m = mtx();
        MsMtxSetTRS(m, this.pos.x, this.pos.y, this.pos.z, this.rot.x, this.rot.y, this.rot.z, this.scale.x, this.scale.y, this.scale.z);
        setRootMtx(this, m);
    }
    loadAfter() {
        super.loadAfter();
        const wm = this.world.mapWires;
        this.unk138 = wm ? wm.getWireNo(this.pos) : -1;
    }
}

// ---------------------------------------------------------------- TMapObjPuncher
export class MapObjPuncher extends MapObjBase {
    /** unk138 how hard it throws Mario (from scene.bin) */
    unk138 = 0;
    constructor(w: World, name = 'パンチャー') { super(w, name); }
    /** makeVecToLocalZ */
    private localZ(len: number) { const m = mtx(); MsMtxSetRotRPH(m, this.rot.x, this.rot.y, this.rot.z); return mtxMultVec(m, new V3(0, 0, len)); }
    touchPlayer(_a: HitActor) {
        this.awake();
        this.startAnim(1);
        const z = this.localZ(1);
        const mp = this.world.mario.pos.clone();
        mp.set(fr(mp.x + fr(z.x * 100)), fr(mp.y + fr(z.y * 100)), fr(mp.z + fr(z.z * 100)));
        const m = this.world.mario as any;
        // SMS_MarioMoveRequest / SMS_ThrowMario: the Mario the stage has, if it can
        if (typeof m.moveRequest === 'function') m.moveRequest(mp);
        sendToMario(this.world, this, MSG.THROWN);
        if (typeof m.throwMario === 'function') m.throwMario(z, this.unk138);
        this.onHitFilter(HF.NO_COLLISION);
        this.emit('ms_enm_disap', this.pos);
        this.world.sound(SE.SMOKE_EFFECT, this.pos);
        this.state = STATE_UNK2;
    }
    control() {
        super.control();
        switch (this.state) {
            case STATE_NORMAL: break;
            case STATE_UNK2:
                // (soundBas(OBJ_PUNCHER_RETURN, 101, rate))
                if (this.animIsFinished()) {
                    this.emit('ms_enm_disap', this.pos);
                    this.world.sound(SE.SMOKE_EFFECT, this.pos);
                    this.kill();
                }
                break;
        }
    }
    load(s: Stream) {
        super.load(s);
        this.unk138 = s.s32();
        this.sleep();
        this.offHitFilter(HF.NO_COLLISION);
    }
}

// ---------------------------------------------------------------- TMareFall
const fall_upper_pos = new V3(2827, 8604, 7202);
export class MareFall extends MapObjBase {
    constructor(w: World, name = 'マーレ滝') { super(w, name); }
    calc() {
        this.world.sound(SE.GE_FALL, this.pos);
        this.world.sound(SE.GE_FALL_UPPER, fall_upper_pos);
        // (mareFallSplash / mareFallSmoke: emitted every frame)
    }
}

// ---------------------------------------------------------------- TMareCork
/** The cannon (TCannon, Enemy/cannon.cpp) it plugs. TODO: TCannon isn't in the sim; this is what the cork uses of it. */
interface CannonLike extends TakeActor { isObject?(): boolean; startChorobeiShout?(): void; }
export class MareCork extends MapObjBase {
    /** unk138 the cannon, unk13C the spray's place (bound: stays 0), unk148 the jet's place, unk154 popped */
    unk138: CannonLike | null = null; unk13C = new V3(); unk148 = new V3(); unk154 = 0;
    constructor(w: World, name = 'マーレコルク') { super(w, name); }
    loadAfter() {
        this.unk138 = this.world.search('砲台') as CannonLike | null;
        if (this.unk138 && this.unk138.receiveMessage(this, MSG.TAKE)) this.held = this.unk138;
        super.loadAfter();
        this.unk13C.set(0, 0, 0);
    }
    moveObject() {
        const c = this.unk138;
        if (c && typeof c.isObject === 'function' && c.isObject() && !this.unk154) {
            if (this.mactor) this.mactor.setBck('marecork');
            this.removeMapCollision();
            this.unk154 = 1;
        }
    }
    calcRootMatrix() {
        if (this.unk154 && this.mactor) {
            const fc = this.mactor.getFrameCtrl(ANM_BCK);
            if (fc && fc.checkPass(250)) {
                if (this.unk138 && this.unk138.startChorobeiShout) this.unk138.startChorobeiShout();
                const im = mapObjGlobals(this.world).itemManager as ItemManager | null;
                if (im) im.makeShineAppearWithDemo('シャイン（ボス用）', 'ボスシャインカメラ', this.pos.x, this.pos.y, this.pos.z);
                this.unk148.set(2773, 8618, 7006);
                this.emit('ms_m_sphipd_hit_b', this.unk148);
            }
        }
        super.calcRootMatrix();
    }
    /** getTakingMtx: its joint 2. TODO: the rest pose's (the BCK's pose isn't applied). */
    getTakingMtx() { return restJointMtx(this, 2); }
}

// ---------------------------------------------------------------- TMareEventPoint
/** TMareEventDepressWall (Map/MapEventMare.cpp): what the point starts. */
interface DepressWallLike { startEvent(): boolean; }
export class MareEventPoint extends HitActor {
    /** unk68 the wall event. TODO: set by MapEventMare.cpp's TMareEventDepressWall, which isn't in the sim. */
    unk68: DepressWallLike | null = null;
    constructor(public world: World, name = 'イベントポイント') { super(name); }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (msg === MSG.SPRAYED_BY_WATER) {
            const wm = this.world.water as any;
            const id = waterID(sender);
            // TODO: gpModelWaterManager->checkFlagBottom4Bits(id, 1): the drop's flags; taken as unset when the sim has none.
            const flagged = wm && typeof wm.checkFlagBottom4Bits === 'function' ? !!wm.checkFlagBottom4Bits(id, 1) : false;
            const plane = getWaterPlane(this.world, sender);
            if (!flagged && plane) {
                if (plane.n[1] < 0.1) {
                    if (this.unk68 && this.unk68.startEvent()) {
                        this.world.effect('ms_enm_wathit', sender.pos);
                        this.world.sound(SE.EN_COMMON_W_HIT_OK, this.pos);
                    }
                    return true;
                }
            }
        }
        return false;
    }
    load(s: Stream) {
        Actor.prototype.load.call(this, s);
        this.initHitActor(AT.MARE_EVENT_POINT, 0, 0, 0, 0, 300, 600);
    }
}

// ---------------------------------------------------------------- registry
register('Cogwheel', (w, n) => new Cogwheel(w, n));
register('MapObjElasticCode', (w, n) => new MapObjElasticCode(w, n));
register('MapObjGrowTree', (w, n) => new MapObjGrowTree(w, n));
register('WireBell', (w, n) => new WireBell(w, n));
register('Puncher', (w, n) => new MapObjPuncher(w, n));
register('MareFall', (w, n) => new MareFall(w, n));
register('MareCork', (w, n) => new MareCork(w, n));
register('MareEventPoint', (w, n) => new MareEventPoint(w, n));
