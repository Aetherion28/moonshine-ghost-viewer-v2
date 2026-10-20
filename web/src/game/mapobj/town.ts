// MoveBG/MapObjTown.cpp's stage switches and water sprays: TMapObjChangeStage (touching it
// takes Mario to another stage: told as a 'nextStage' event with the stage's number),
// TMapObjChangeStageHipDrop (ground-pounding it does) and TMapObjWaterSpray (a fountain's spray:
// its particle emitted each frame, told as an effect with its rate, size and colour).
// TMapObjSwitch (gpMapObjSwitch, Pinna Park / Sirena's blue switch): ground-pounded, it presses and
// every THideObjInfo of the stage (registered as each loads) throws out its coin, which lasts the
// switch's time; Mario's sounds for the timer and the switch's demo camera aren't here.

import { fr, V3 } from '../math.js';
import { World, Stream, HitActor, HF, MSG, LF, ANM_BCK, ANM_FRAME_RATE } from '../engine.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { Actor } from '../engine.js';
import { AT } from '../actortypes.js';
import { MapObjBase, MOF, STATE_NORMAL, mapObjGlobals, getActorTypeByEventID } from './base.js';
import type { Coin, ItemManager } from './item.js';
import { MapObjGeneral } from './general.js';
import { HideObjBase } from './hide.js';
import { MsWrap } from '../math.js';
import { ObjCollision, KIND_WARP } from './objcol.js';
import { JMASCos, s16 } from '../math.js';
import { marioHipDropping, marioSpeedY, marioGroundLevel, marioStatus, marioTouchGround4cm, marioHeld } from './lib.js';

export class MapObjChangeStage extends MapObjBase {
    unk138 = 0;
    constructor(w: World, name = 'ステージ切替オブジェ') { super(w, name); }
    protected setNextStage() { this.world.events.push({ t: this.world.tickCount, kind: 'nextStage', data: { stage: this.unk138, p: this.pos.clone(), name: this.name } }); }
    touchPlayer(_a: HitActor) {
        this.setNextStage();
        this.onHitFilter(HF.NO_COLLISION);
        this.collisions.length = 0;
        this.world.sound(SE.MA_WARP_EX, this.pos);
    }
    load(s: Stream) { super.load(s); this.unk138 = s.u32(); }
}
export class MapObjChangeStageHipDrop extends MapObjChangeStage {
    touchPlayer(_a: HitActor) {
        const w = this.world;
        if (marioHipDropping(w) && w.mario.pos.y + marioSpeedY(w) < marioGroundLevel(w)) {
            this.setNextStage();
            this.emit('exHahen');
        }
    }
}

export class MapObjWaterSpray extends MapObjBase {
    unk138 = 0x154; unk13C = 0; unk140 = new V3(); unk14C = { r: 0, g: 0, b: 0, a: 0 };
    constructor(w: World, name = '汎用水しぶき') { super(w, name); }
    /** calc: the emitter, each frame (its rotation, rate, particle size and colour are the members here) */
    calc() { this.world.effect(this.unk138 === 0x154 ? 'shibCyl1' : 'shibCub1', this.pos, this.scale); }
    load(s: Stream) {
        super.load(s);
        this.unk138 = this.individualName === 'WaterSprayCylinder' ? 0x154 : 0x155;
        this.unk13C = s.f32();
        this.unk13C = this.unk13C > 100 ? 0.5 : fr(this.unk13C / 100);
        let sc = s.f32();
        sc = sc === -1 ? 1 : fr(sc / 100);
        this.unk140.set(sc, sc, sc);
        this.unk14C = { r: s.u32() & 0xFF, g: s.u32() & 0xFF, b: s.u32() & 0xFF, a: s.u32() & 0xFF };
    }
}

// ---------------------------------------------------------------- TRedCoinSwitch
/**
 * Ground-pounding it starts its press, locks the pad for twice its animation plus 60 ticks
 * (TMarioGamePad::mDisabledFrames) and puts out the eight red coins' "pressed" flag once the
 * animation ends. The red coins (赤コイン 0..7) are hidden until then.
 */
export class RedCoinSwitch extends MapObjBase {
    /** the red coins' time limit, in frames */
    unk138 = 0;
    constructor(w: World, name = '赤コインスイッチ') { super(w, name); }
    receiveMessage(_s: HitActor, msg: number) {
        if (msg === MSG.HIP_DROP) {
            this.startBck('redcoinswitch');
            const fc = this.mactor && this.mactor.getFrameCtrl(ANM_BCK);
            const pad = (this.world.mario as any).mGamePad;
            if (pad && fc) pad.invalidate(Math.trunc(fr(fr(fc.end * 2) + 60)));
            this.world.sound(SE.OBJ_AP_BUTTON, this.pos);
            this.removeMapCollision();
            this.onHitFilter(HF.NO_COLLISION);
            this.state = 2;
            return true;
        }
        return false;
    }
    control() {
        super.control();
        switch (this.state) {
            case 2:
                if (this.mactor && this.mactor.curAnmEndsNext(ANM_BCK)) {
                    this.stateTimer = 120; this.state = 3;
                    // TFlagManager MSF_RED_COIN_SWITCH_PRESSED
                    (this.world as any).redCoinSwitchPressed = true;
                }
                break;
            case 3: if (!this.isStateTimerEngaged()) this.state = 4; break;
        }
    }
    loadAfter() {
        super.loadAfter();
        for (let i = 0; i < 8; i++) { const c = this.world.search(`赤コイン ${i}`) as MapObjBase | null; if (c) c.makeObjDead(); }
    }
    load(s: Stream) {
        super.load(s);
        const t = s.u32() | 0;
        this.unk138 = t <= 0 ? 1200 : t * 10;
        // TODO: in a secret stage whose Shine isn't got yet it's gone (SMS_getShineIDofExStage and the
        // Shine flags: not in the sim)
    }
}

// ---------------------------------------------------------------- TMapObjSwitch / THideObjInfo
const SWITCHES = new WeakMap<World, MapObjSwitch>();
/** gpMapObjSwitch */
export const mapObjSwitch = (w: World) => SWITCHES.get(w) || null;

/** THideObjInfo: a point the switch throws an item out of (scene.bin's actor plus loadHideObjInfo) */
export class HideObjInfo extends Actor {
    /** unk44 the item's actor type, unk48 its speed, unk4C its Y speed */
    unk44 = 0; unk48 = 0; unk4C = 0;
    constructor(public world: World, name = 'オブジェ出現情報') { super(name); }
    load(s: Stream) {
        super.load(s);
        const [ev, sp, ys] = MapObjBase.loadHideObjInfo(s);
        this.unk48 = sp; this.unk4C = ys;
        this.unk44 = getActorTypeByEventID(ev);
        const sw = mapObjSwitch(this.world);
        if (sw) sw.registerObjInfo(this);
    }
    action(t: number) {
        const im = mapObjGlobals(this.world).itemManager as ItemManager | null;
        const o = im ? im.makeObjAppearAt(this.pos.x, this.pos.y, this.pos.z, this.unk44, true) : null;
        if (!o) return;
        MapObjBase.throwObjFromPointWithRot(o, this.pos, this.rot, this.unk48, this.unk4C);
        if (o.isActorType(AT.COIN)) (o as Coin).unk14C = t;
    }
}

export class MapObjSwitch extends MapObjBase {
    /** unk138 the capacity, unk13C how many, unk140 the time (frames), unk148 its colour */
    unk138 = 0; unk13C = 0; unk140 = 0;
    unk144: HideObjInfo[] = [];
    unk148 = { r: 0xFF, g: 0xFF, b: 0xFF, a: 0xFF };
    constructor(w: World, name = 'オブジェスイッチ') { super(w, name); SWITCHES.set(w, this); }
    control() { super.control(); /* (SMSGetMSound()->playTimer while the timer runs) */ }
    receiveMessage(_s: HitActor, msg: number) {
        if (msg === MSG.HIP_DROP) {
            this.startBck('objswitch');
            this.world.sound(SE.OBJ_AP_BUTTON, this.pos);
            this.removeMapCollision();
            for (let i = 0; i < this.unk13C; i++) this.unk144[i].action(this.unk140);
            // TODO: fireStartDemoCamera("オブジェスイッチ用カメラ"): the demo camera isn't driven from here
            this.stateTimer = this.unk140;
            this.onHitFilter(HF.NO_COLLISION);
            return true;
        }
        return false;
    }
    registerObjInfo(info: HideObjInfo) { if (this.unk13C < this.unk138) { this.unk144[this.unk13C] = info; this.unk13C++; } }
    load(s: Stream) {
        super.load(s);
        const t = s.s32();
        this.unk140 = t <= 0 ? 1200 : t * 10;
        const r = s.s32(), g = s.s32(), b = s.s32();
        this.unk148 = { r: r & 0xFF, g: g & 0xFF, b: b & 0xFF, a: this.unk148.a };
        this.unk138 = 100;
    }
}

// ---------------------------------------------------------------- TDoor
/**
 * A door: Mario touching it is told to open it (UNK11, or UNK12 for a locked one: unk138 from
 * scene.bin); if he takes it, the door's swing matches the side he opens it from (anim 2 / 1 for
 * DOOR_OPEN_R / L, 4 / 3 holding something).
 */
export class Door extends MapObjBase {
    unk138 = false;
    constructor(w: World, name = 'ドア') { super(w, name); }
    touchPlayer(a: HitActor) {
        if (!a.isActorType(AT.MARIO)) return;
        const msg = this.unk138 ? MSG.UNK12 : MSG.UNK11;
        if (!a.receiveMessage(this, msg)) return;
        const st = marioStatus(this.world), held = !!marioHeld(this.world);
        if (st === 0x1320) this.startAnim(held ? 4 : 2);        // MARIO_STATUS_DOOR_OPEN_R
        else if (st === 0x1321) this.startAnim(held ? 3 : 1);   // MARIO_STATUS_DOOR_OPEN_L
    }
    load(s: Stream) { super.load(s); if (s.s32()) this.unk138 = true; }
}

// ---------------------------------------------------------------- TManhole
/**
 * A manhole: Mario standing on it presses it down a little (it bobs back up when he's off), a
 * hip drop from above or a jump from below flips it open (its BCK to frame 79, then on round
 * to its end). Something put on it (a box or barrel: makeManholeUnuseful) seals it with
 * manholeRoof.col until that's gone.
 */
export class Manhole extends MapObjGeneral {
    static mDownHeight = 12; static mDownSpeed = fr(1.5); static mVibrationSpeed = fr(0.05);
    static mVibrationEndHeight = fr(0.001); static mVibrationDecreaseRate = fr(0.07);
    /** unk148 the bob's phase, unk14C its height, unk150 opened from below, unk151 its rest collision's up, unk152 pressed, unk154 what's on it, unk158 the roof */
    unk148 = 0; unk14C = 0; unk150 = 0; unk151 = 1; unk152 = 0;
    unk154: MapObjBase | null = null; unk158: ObjCollision | null = null;
    constructor(w: World, name = 'マンホール') { super(w, name); }
    private fc() { return this.mactor ? this.mactor.getFrameCtrl(ANM_BCK) : null; }
    private open() {
        const fc = this.fc();
        if (fc) { fc.rate = ANM_FRAME_RATE; fc.frame = fr(fc.frame + ANM_FRAME_RATE); }
        this.world.sound(SE.OBJ_MANHOLE_OPEN, this.pos);
        this.offMapObjFlag(MOF.NO_ANIMATIONS);
    }
    touchPlayer(_a: HitActor) {
        const w = this.world, m = w.mario;
        this.state = STATE_NORMAL;
        if (!this.animationFinished()) { this.pos.y = this.initialPos.y; return; }
        if (marioStatus(w) === 0x8008A9 && m.pos.y < this.pos.y) { this.open(); return; }
        if (m.pos.y < this.pos.y && marioSpeedY(w) > 0) {
            this.open();
            const a = this.colMgr && this.colMgr.getActiveCollision();
            if (a) a.setAllBGType(0x400);
            this.unk150 = 1;
            return;
        }
        if (marioTouchGround4cm(w)) {
            if (this.unk151) { this.setUpMapCollision(1); this.unk151 = 0; }
            if (!this.unk152) { this.unk152 = 1; w.sound(SE.OBJ_MANHOLE_DOWN, this.pos); }
            if (this.pos.y > fr(this.initialPos.y - Manhole.mDownHeight)) this.pos.y = fr(this.pos.y - Manhole.mDownSpeed);
            else this.pos.y = fr(this.initialPos.y - Manhole.mDownHeight);
            this.unk148 = 1;
            this.unk14C = fr(this.initialPos.y - this.pos.y);
            this.offMapObjFlag(MOF.NO_ANIMATIONS);
            return;
        }
        if (this.unk152) { this.unk152 = 0; w.sound(SE.OBJ_MANHOLE_UP, this.pos); }
        this.appeared();
    }
    animationFinished() {
        const fc = this.fc();
        if (!fc || fc.rate === 0) return true;
        const next = fr(fc.frame + fc.rate);
        if (fc.frame < 79 && next >= 79) {
            fc.frame = 79; fc.rate = 0;
            this.calcRootMatrix();
            this.onMapObjFlag(MOF.NO_ANIMATIONS);
            return true;
        }
        if (fc.frame < fc.end && next >= fc.end) {
            fc.frame = 0; fc.rate = 0;
            this.calcRootMatrix();
            this.onMapObjFlag(MOF.NO_ANIMATIONS);
            return true;
        }
        return false;
    }
    appeared() {
        const on = this.unk154;
        if (on) {
            if (!on.checkLiveFlag(LF.DEAD)) return;
            if (this.unk158) this.unk158.remove();
            this.unk154 = null;
        }
        if (this.unk150 && marioSpeedY(this.world) <= 0) {
            const a = this.colMgr && this.colMgr.getActiveCollision();
            if (a) a.setAllBGType(0x107);   // (BG_TYPE_GROUND_POUND_TO_PASS_THROUGH)
            this.unk150 = 0;
        }
        if (this.animationFinished()) {
            if (this.unk152 === 1 && this.collisions.length === 0) { this.unk152 = 0; this.world.sound(SE.OBJ_MANHOLE_UP, this.pos); }
            if (this.unk14C > Manhole.mVibrationEndHeight) {
                this.pos.y = fr(fr(this.unk14C * JMASCos(s16(Math.trunc(fr(this.unk148 * 32768))))) + this.initialPos.y);
                this.unk148 = fr(this.unk148 + Manhole.mVibrationSpeed);
                if (this.unk148 >= 2) this.unk148 = fr(this.unk148 - 2);
                this.unk14C = fr(this.unk14C - Manhole.mVibrationDecreaseRate);
                return;
            }
            if (!this.unk151) { this.setUpMapCollision(0); this.unk151 = 1; }
            this.onMapObjFlag(MOF.NO_ANIMATIONS);
            this.pos.y = this.initialPos.y;
        }
    }
    calc() {
        const fc = this.fc();
        if (!fc) return;
        const next = fr(fc.frame + fc.rate);
        if ((fc.frame <= 45 && 45 < next) || (fc.frame <= 125 && 125 < next)) this.world.sound(SE.OBJ_MANHOLE_CLOSE, this.pos);
    }
    // setGroundCollision: with a hatched Yoshi over it, only moved (TODO: Yoshi isn't simulated, so always TMapObjBase's)
    makeManholeUnuseful(o: MapObjBase) {
        if (this.unk154) return;
        this.unk154 = o;
        if (this.unk158) this.unk158.setUpMtx(this.rootMtx());
    }
    loadAfter() {
        super.loadAfter();
        const fc = this.fc();
        if (fc) fc.rate = 0;
    }
    initMapObj() {
        super.initMapObj();
        this.unk158 = new ObjCollision(this.world, KIND_WARP, this);
        this.unk158.init('/mapObj/manholeRoof.col', 0);
    }
}

// ---------------------------------------------------------------- TMapObjBillboard
/** TMapObjBillboard (Delfino Plaza's signboards): touched or sprayed it swings away (anim 1 or 2 by the side hit); sprayed, it throws out what it hides. */
export class MapObjBillboard extends HideObjBase {
    constructor(w: World, name = '看板') { super(w, name); }
    swing(a: HitActor) {
        const fc = this.mactor ? this.mactor.getFrameCtrl(ANM_BCK) : null;
        if (this.animIsFinished() || !(fc && fc.frame < 33)) {
            // getRotYFromAxisX: atan2f(dz, dx)
            const tmp = fr(fr(57.295776) * fr(Math.atan2(fr(a.pos.z - this.pos.z), fr(a.pos.x - this.pos.x))));
            const angle = MsWrap(fr(this.rot.y + tmp), 0, 360);
            if (angle < 0 || 180 < angle) this.startAnim(2);
            else this.startAnim(1);
            this.world.sound(SE.OBJ_BILLBOARD_MOVE, this.pos);
        }
    }
    touchActor(a: HitActor) { this.swing(a); }
    touchWater(a: HitActor) {
        this.swing(a);
        if (this.hidden && this.allowReveal) {
            const rot = this.rot.clone(), pos = this.pos.clone();
            rot.y = fr(rot.y - 90);
            pos.y = fr(pos.y + this.yOffset);
            let o: MapObjBase | null = this.hidden;
            if (o.isActorType(AT.COIN)) { const im = mapObjGlobals(this.world).itemManager as ItemManager | null; o = im ? im.makeObjAppear(AT.COIN) : null; }
            if (o) {
                MapObjBase.throwObjFromPointWithRot(o, pos, rot, this.appearSpeed, this.appearYSpeed);
                this.emitEffect();
                this.allowReveal = false;
            }
        }
        return 1;
    }
}

register('Billboard', (w, n) => new MapObjBillboard(w, n));
register('Door', (w, n) => new Door(w, n));
register('Manhole', (w, n) => new Manhole(w, n));
register('RedCoinSwitch', (w, n) => new RedCoinSwitch(w, n));
register('MapObjChangeStage', (w, n) => new MapObjChangeStage(w, n));
register('MapObjChangeStageHipDrop', (w, n) => new MapObjChangeStageHipDrop(w, n));
register('MapObjWaterSpray', (w, n) => new MapObjWaterSpray(w, n));
register('MapObjSwitch', (w, n) => new MapObjSwitch(w, n));
register('HideObjInfo', (w, n) => new HideObjInfo(w, n));
