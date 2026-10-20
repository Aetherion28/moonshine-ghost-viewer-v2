// Items (MoveBG/Item.cpp, ItemManager.cpp): coins (gold, red, blue), Shines, nozzles and nozzle
// boxes, bottles; the item manager with its pool of 20 gold coins and the spin every item shares.
// Mario takes an item by touching it (its hit check against him: TItem::touchPlayer -> taken).
//
// What the game keeps in its save (TFlagManager: coins counted, blue coins and Shines already
// got, nozzle unlocks) starts empty here: no blue coin or Shine is already collected, every
// nozzle box holds its nozzle as scene.bin says. Taking things is told as world events
// ('coinGet', 'redCoinGet', 'blueCoinGet', 'shineGet', 'nozzleGet'), with the counts on
// itemCounts(world).

import { fr, V3, Mtx, mtx, JMASSin, JMASCos, MsSin, MsWrap, MsMtxSetXYZRPH } from '../math.js';
import { World, Stream, HitActor, TakeActor, LF, HF, MSG, CUE_MOVE, CUE_CALC_ANIM, parseSceneBin, SceneNode } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { MapObjBase, MapObjBaseManager, MOF, STATE_NORMAL, OBJ_MAKERS, UNIQUE_MAKERS, mapObjGlobals, newAndRegisterObj } from './base.js';
import { MapObjGeneral, GS } from './general.js';
import { marioOnYoshi } from './lib.js';
import { SE } from '../soundids.js';
import '../sound.js';

export interface ItemCounts { gold: number; red: number; blue: number[]; shines: number[]; }
const COUNTS = new WeakMap<World, ItemCounts>();
/** The collectibles taken so far (TFlagManager's counters, from the stage's start). */
export function itemCounts(w: World): ItemCounts {
    let c = COUNTS.get(w);
    if (!c) { c = { gold: 0, red: 0, blue: [], shines: [] }; COUNTS.set(w, c); }
    return c;
}
const tell = (w: World, kind: string, o: MapObjBase, extra: any = {}) => w.events.push({ t: w.tickCount, kind, data: { p: o.pos.clone(), name: o.name, ...extra } });

/** tables.bin's CameraMapInfo: a demo camera's length (TCameraMapTool::mDemoLengthFrames), by name. */
const DEMO_LENGTHS = new WeakMap<World, Map<string, number>>();
export function demoLength(w: World, name: string): number {
    let m = DEMO_LENGTHS.get(w);
    if (!m) {
        m = new Map();
        const b = w.files.scene('map/tables.bin');
        if (b) {
            const walk = (n: SceneNode) => {
                if (n.type === 'CameraMapInfo' && n.data.length >= 36) {
                    const v = new DataView(n.data.buffer, n.data.byteOffset, n.data.byteLength);
                    m!.set(n.name, v.getUint32(32));
                }
                for (const c of n.children || []) walk(c);
            };
            try { walk(parseSceneBin(b)); } catch { }
        }
        DEMO_LENGTHS.set(w, m);
    }
    return m.get(name) ?? 0;
}

// ---------------------------------------------------------------- TItem
export const ITEM_APPEARED_SCALE_SPEED = fr(0.01);
export class Item extends MapObjGeneral {
    container: HitActor | null = null;
    unk14C = 0; unk150 = 0;
    constructor(w: World, name = 'アイテム') { super(w, name); }
    appeared() {
        if (this.checkMapObjFlag(MOF.DISAPPEARING) && !this.isStateTimerEngaged()) {
            if (this.container) this.container.receiveMessage(this, MSG.ATTACH);
            if (this.isActorType(AT.COIN_RED) || this.isActorType(AT.COIN_BLUE)) this.world.sound(SE.SY_COIN_DISAPPEAR, this.pos);
        }
        super.appeared();
    }
    taken(a: HitActor) {
        a.receiveMessage(this, MSG.ATTACK);
        this.kill();
        if (this.checkMapObjFlag(MOF.RESPAWNING)) { this.makeObjDefault(); this.appear(); }
    }
    touchPlayer(a: HitActor) {
        if ((a.isActorType(AT.MARIO) || a.isActorType(AT.YOSHI_TONGUE)) && !this.checkHitFilter(HF.NO_COLLISION)) this.taken(a);
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (msg === MSG.SPRAYED_BY_WATER) return false;
        if (msg === MSG.UNKB) { this.taken(sender); return true; }
        return super.receiveMessage(sender, msg);
    }
    calcRootMatrix() { if (!this.checkMapObjFlag(MOF.UNK8000000)) super.calcRootMatrix(); }
    /** calc: the items' shared spin (gpItemManager->unk40) at its place */
    calc() {
        if (!this.checkMapObjFlag(MOF.UNK4000000) && !this.isState(GS.HOLDING)) {
            const im = mapObjGlobals(this.world).itemManager as ItemManager | null;
            const src = im ? im.unk40 : mtx();
            const m = this.baseTR;
            m[0] = src[0]; m[1] = src[1]; m[2] = src[2]; m[3] = this.pos.x;
            m[4] = src[4]; m[5] = src[5]; m[6] = src[6]; m[7] = this.pos.y;
            m[8] = src[8]; m[9] = src[9]; m[10] = src[10]; m[11] = this.pos.z;
            this.anmMtx0 = null;
        }
        if (this.isState(GS.HOLDING) && this.checkMapObjFlag(MOF.NO_ANIMATIONS)) super.calcRootMatrix();
    }
    appearing() {
        if (this.checkMapObjFlag(MOF.UNK2000000)) {
            if (this.scale.x < 2) {
                const d = fr(ITEM_APPEARED_SCALE_SPEED * 2);
                this.scale.set(fr(this.scale.x + d), fr(this.scale.y + d), fr(this.scale.z + d));
            } else {
                this.makeObjAppeared();
                this.onHitFilter(HF.NO_COLLISION);
                this.offMapObjFlag(MOF.DISAPPEARING);
            }
        } else super.appearing();
    }
    killByTimer(t: number) {
        this.unk14C = t; this.stateTimer = this.unk150;
        this.offMapObjFlag(MOF.UNK10000000);
        this.onHitFilter(HF.NO_COLLISION);
        this.offMapObjFlag(MOF.DISAPPEARING);
    }
    appear() {
        super.appear();
        this.onHitFilter(HF.NO_COLLISION);
        this.stateTimer = this.unk150;
        this.offMapObjFlag(MOF.DISAPPEARING);
    }
    perform(cue: number) {
        if (this.checkLiveFlag(LF.DEAD)) return;
        if ((cue & CUE_MOVE) && this.checkHitFilter(HF.NO_COLLISION) && !this.isStateTimerEngaged()) {
            this.offHitFilter(HF.NO_COLLISION);
            if (!this.checkMapObjFlag(MOF.UNK10000000)) { this.onMapObjFlag(MOF.DISAPPEARING); this.stateTimer = this.unk14C; }
        }
        super.perform(cue);
    }
    initMapObj() { super.initMapObj(); this.unk14C = 480; this.unk150 = 120; }
    load(s: Stream) { super.load(s); this.onMapObjFlag(MOF.UNK10000000); }
}

// ---------------------------------------------------------------- coins
export class Coin extends Item {
    constructor(w: World, name = 'コイン') { super(w, name); }
    taken(a: HitActor) {
        const c = itemCounts(this.world);
        c.gold++;
        this.world.sound(SE.SY_COIN, this.pos);
        tell(this.world, 'coinGet', this, { count: c.gold });
        if (this.container) this.container.receiveMessage(this, MSG.DETACH);
        if (c.gold === 100) {
            const im = mapObjGlobals(this.world).itemManager as ItemManager | null;
            if (im) im.makeShineAppearWithDemo('シャイン（１００枚コイン用）', 'シャイン（１００枚コイン用）カメラ', this.pos.x, this.pos.y, this.pos.z);
        }
        super.taken(a);
    }
    appearWithoutSound() {
        Item.prototype.appear.call(this);
        this.emit('watcoinKira');
        if (this.isActorType(AT.COIN)) this.offMapObjFlag(MOF.UNK10000000);
    }
    appear() {
        if (this.isActorType(AT.COIN_BLUE)) { if (!itemCounts(this.world).blue.includes(this.eventId)) this.world.sound(SE.SY_TIMECOIN_APPEAR); }
        else this.world.sound(SE.SY_COIN_APPEAR);
        this.appearWithoutSound();
    }
    perform(cue: number) {
        if (this.checkLiveFlag(LF.DEAD)) return;
        if ((cue & CUE_MOVE) && this.checkLiveFlag(LF.UNK10)) {
            if (this.world.talkMode && !this.world.demoMode) return;
            if (this.isStateTimerEngaged()) --this.stateTimer;
            else if (this.checkHitFilter(HF.NO_COLLISION)) {
                this.offHitFilter(HF.NO_COLLISION);
                if (!this.checkMapObjFlag(MOF.UNK10000000)) { this.onMapObjFlag(MOF.DISAPPEARING); this.stateTimer = this.unk14C; }
            } else if (!this.checkMapObjFlag(MOF.UNK10000000)) {
                if (this.container) this.container.receiveMessage(this, MSG.ATTACH);
                this.makeObjDead();
            }
            for (const c of this.collisions.slice()) this.touchActor(c);
        } else super.perform(cue);
    }
}
/** TCoinEmpty: the item manager's stand-in for "a coin" (hidden objects ask the pool for a real one). */
export class CoinEmpty extends Coin {
    constructor(w: World, name = '空コイン') { super(w, name); }
    kill() { }
    appear() { }
    makeObjAppeared() { }
}
export class CoinRed extends Coin {
    constructor(w: World, name = '赤コイン') { super(w, name); }
    taken(a: HitActor) {
        const c = itemCounts(this.world);
        c.red++;
        this.world.sound(SE.SY_RED_COIN_GET, this.pos);
        tell(this.world, 'redCoinGet', this, { count: c.red });
        if (this.container) this.container.receiveMessage(this, MSG.DETACH);
        Item.prototype.taken.call(this, a);
    }
}
export class CoinBlue extends Coin {
    constructor(w: World, name = '青コイン') { super(w, name); }
    loadBeforeInit(s: Stream) { let e = s.s32(); if (e === -1) e = 0; this.eventId = e; }
    makeObjAppeared() { if (itemCounts(this.world).blue.includes(this.eventId)) return; super.makeObjAppeared(); }
    taken(a: HitActor) {
        const c = itemCounts(this.world);
        c.blue.push(this.eventId);
        tell(this.world, 'blueCoinGet', this, { id: this.eventId });   // fireGetBlueCoin
        if (this.container) this.container.receiveMessage(this, MSG.DETACH);
        Item.prototype.taken.call(this, a);
    }
}

// ---------------------------------------------------------------- TShine
const SHINE_CIRCLE_RATE_Y = 0.5, SHINE_SPEED_DOWN_RATE = fr(0.99);
export const SHS = { UNKB: 0xB, MOVING_UP: 0xC, MOVING_CIRCLE: 0xD, MOVING_DOWN: 0xE, UNKF: 0xF, UNK10: 0x10, UNK11: 0x11, UNK12: 0x12 };
export class Shine extends Item {
    unk154 = 0; unk158 = 0; unk15C = 0; unk160 = 0; unk164 = 0; unk168 = 0; unk16C = 2; unk170 = 0; unk174 = 0; unk178 = 0;
    unk17C = new V3(); unk188 = 0; unk18C = 0; unk190 = 0; unk1B4 = 0;
    upSpeed = 1;
    constructor(w: World, name = 'シャイン') { super(w, name); }
    loadBeforeInit(s: Stream) {
        const kind = s.str();
        this.unk154 = kind === 'normal' ? 0 : kind === 'quickly' ? 2 : 1;
        let e = s.s32(); if (e === -1) e = 120;
        this.eventId = e;
        const v = s.s32();
        let x = v; if (v + 1 >= 2) x = -1;
        this.unk190 = x + 1;
    }
    makeMActors() { this.mactor = this.initMActor('shine.bmd'); }
    initMapObj() { super.initMapObj(); this.unk170 = 240; this.unk174 = 0; this.unk178 = 240; }
    loadAfter() {
        MapObjGeneral.prototype.loadAfter.call(this);
        if (this.unk154 === 2) { this.stateTimer = 240; this.state = SHS.UNK12; }
        else if (this.unk154 === 1) this.makeObjDead();
    }
    kill() { super.kill(); this.unk154 = 1; }
    calc() { }
    movingCircle() {
        const prevY = this.pos.y;
        this.unk158 = fr(this.unk158 + 180 / this.unk168);
        const t = fr((this.unk168 - this.stateTimer) / this.unk168);
        this.pos.x = fr(this.pos.x + this.unk17C.x);
        this.pos.y = fr(this.unk160 * MsSin(this.unk158) + (t * (this.initialPos.y - this.unk164) + this.unk164));
        this.unk188 = fr(this.pos.y - prevY);
        this.pos.z = fr(this.pos.z + this.unk17C.z);
        this.rot.y = fr(this.rot.y + 7);
        if (!this.isStateTimerEngaged()) { this.unk16C = 7; this.stateTimer = this.unk178; this.state = SHS.UNKF; }
    }
    movingUp() {
        this.pos.y = fr(this.pos.y + this.upSpeed);
        if (this.isStateTimerEngaged()) return;
        if (this.unk154 === 3) { this.stateTimer = this.unk170; this.state = SHS.MOVING_DOWN; }
        else { this.unk164 = this.pos.y; this.stateTimer = this.unk168; this.state = SHS.MOVING_CIRCLE; }
    }
    movingDown() {
        this.pos.y = fr(this.pos.y - this.upSpeed);
        if (this.isStateTimerEngaged()) return;
        this.unk16C = 7; this.stateTimer = this.unk178; this.state = SHS.UNKF;
    }
    control() {
        if (!this.isState(SHS.UNK10)) super.control();
        if (this.isState(SHS.UNK10)) { this.pos.set(this.world.mario.pos); return; }
        switch (this.state) {
            case STATE_NORMAL: this.rot.y = fr(this.rot.y + this.unk16C); break;
            case SHS.UNKB:
                if (this.isStateTimerEngaged()) break;
                this.offMapObjFlag(MOF.UNK8000000 | MOF.NO_ANIMATIONS);
                this.stateTimer = this.unk170; this.state = SHS.MOVING_UP;
                break;
            case SHS.MOVING_UP: this.movingUp(); break;
            case SHS.MOVING_DOWN: this.movingDown(); break;
            case SHS.MOVING_CIRCLE: this.movingCircle(); break;
            case SHS.UNKF:
                if (this.pos.y > this.initialPos.y) { this.pos.y = fr(this.pos.y + this.unk188); this.unk188 = fr(this.unk188 * SHINE_SPEED_DOWN_RATE); }
                else this.pos.y = this.initialPos.y;
                this.unk16C = this.unk16C > 2 ? fr(this.unk16C - 0.1) : 2;
                this.rot.y = fr(this.rot.y + this.unk16C);
                if (this.isStateTimerEngaged()) break;
                this.offHitFilter(HF.NO_COLLISION);
                this.state = SHS.UNK11;
                break;
            case SHS.UNK11: this.rot.y = fr(this.rot.y + this.unk16C); break;
            case SHS.UNK12:
                if (this.isStateTimerEngaged()) break;
                this.appearWithDemo('シャイン（いきなり出現）カメラ');
                this.state = SHS.UNK11;
                break;
        }
    }
    perform(cue: number) {
        if ((cue & CUE_CALC_ANIM) && !this.checkLiveFlag(LF.DEAD) && !this.isState(STATE_NORMAL)) this.offLiveFlag(LF.UNK200);
        MapObjGeneral.prototype.perform.call(this, cue);
    }
    /** a Shine got (TShine::receiveMessage from Mario's shine-get): follows him */
    receiveMessage(_sender: HitActor, _msg: number): boolean {
        this.offMapObjFlag(MOF.UNK8000000);
        const m = this.world.mario;
        this.pos.set(m.pos);
        this.rot.y = fr(180 * ((m.faceAngle << 16) >> 16) / 32768);
        MsMtxSetXYZRPH(this.baseTR, this.pos.x, fr(this.pos.y - this.yOffset), this.pos.z, this.rot.x, this.rot.y, this.rot.z);
        if (this.mactor) this.mactor.setBck(marioOnYoshi(this.world) ? 'shine_demo_shine_get_yo' : 'shine_demo_shine_get');
        this.state = SHS.UNK10;
        return true;
    }
    touchPlayer(a: HitActor) {
        a.receiveMessage(this, MSG.ATTACK);
        this.world.sound(SE.SY_GET_SHINE, this.pos);
        if (this.mactor) this.mactor.setBck('shine_float');
        this.onHitFilter(HF.NO_COLLISION);
        const c = itemCounts(this.world);
        c.shines.push(this.eventId);
        tell(this.world, 'shineGet', this, { id: this.eventId });
        // (Mario's shine-get takes it: TMario sends it the message back)
        this.receiveMessage(a, MSG.ATTACK);
    }
    appearWithTime(total: number, a: number, b: number, c: number) {
        Item.prototype.appear.call(this);
        if (a >= 0) this.unk174 = a;
        if (b >= 0) this.unk170 = b;
        if (c >= 0) this.unk178 = c;
        this.unk168 = total - (this.unk174 + this.unk170 + this.unk178);
        this.unk158 = 0;
        const yDelta = fr(this.initialPos.y - (this.upSpeed * this.unk170 + this.pos.y));
        this.unk17C.set(fr((this.initialPos.x - this.pos.x) / this.unk168), fr(yDelta / this.unk168), fr((this.initialPos.z - this.pos.z) / this.unk168));
        this.unk15C = this.getDistanceXZ(this.initialPos);
        if (this.unk15C === 0) this.unk15C = 1000;
        if (yDelta > 0) this.unk15C = fr(this.unk15C + Math.abs(yDelta));
        this.unk160 = fr(this.unk15C * SHINE_CIRCLE_RATE_Y);
        this.emit('shineAppear');
        this.world.sound(SE.SHINE_APPEAR, this.pos);
        this.stateTimer = this.unk174;
        this.state = SHS.UNKB;
        this.onHitFilter(HF.NO_COLLISION);
    }
    appearSimple(t: number) {
        Item.prototype.appear.call(this);
        this.unk174 = 60; this.unk170 = t; this.unk178 = 60; this.unk154 = 3;
        this.unk158 = 0; this.unk15C = 0; this.unk160 = 0; this.upSpeed = 2;
        this.initialPos.set(this.pos);
        this.emit('shineAppear');
        this.world.sound(SE.SHINE_APPEAR, this.pos);
        this.stateTimer = this.unk174; this.state = SHS.UNKB;
        this.onHitFilter(HF.NO_COLLISION);
    }
    /** appearWithDemo: its demo camera starts (taken as at once) and it appears over the demo's length */
    appearWithDemo(camera: string) {
        this.unk18C = demoLength(this.world, camera);
        this.world.events.push({ t: this.world.tickCount, kind: 'demoCamera', data: { name: camera, p: this.pos.clone(), frames: this.unk18C } });
        this.appearWithTime(this.unk18C, -1, -1, -1);
    }
}

// ---------------------------------------------------------------- nozzles
export class ItemNozzle extends Item {
    constructor(w: World) { super(w, 'ノズル'); }
    load(s: Stream) {
        MapObjBase.prototype.load.call(this, s);
        this.onMapObjFlag(MOF.UNK10000000);
        // (rocket / back nozzle items out in the open: dead unless the Shadow Mario event says; TODO: the save's event state)
        if (this.individualName === 'rocket_nozzle_item' || this.individualName === 'back_nozzle_item') this.makeObjDead();
    }
    touchPlayer(a: HitActor) {
        if (this.isState(GS.HOLDING)) return;
        if (marioOnYoshi(this.world)) return;
        if ((a.isActorType(AT.MARIO) || a.isActorType(AT.YOSHI_TONGUE)) && !this.checkHitFilter(HF.NO_COLLISION)) this.taken(a);
        let kind = 4;
        if (this.isActorType(AT.ROCKET_NOZZLE_ITEM)) kind = 1; else if (this.isActorType(AT.BACK_NOZZLE_ITEM)) kind = 5;
        this.world.sound(SE.SY_GET_NOZZLE, this.pos);
        const im = mapObjGlobals(this.world).itemManager as ItemManager | null;
        if (im) im.resetNozzleBoxesModel(kind);
        tell(this.world, 'nozzleGet', this, { item: this.individualName });
    }
    put() { this.offHitFilter(HF.NO_COLLISION); this.state = STATE_NORMAL; }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (msg === MSG.TAKE) { this.hold(sender as TakeActor); return true; }
        if (msg === MSG.THROWN) { this.vel.set(0, 20, 0); this.offLiveFlag(LF.UNK10); this.onHitFilter(HF.NO_COLLISION); this.state = 0xB; return true; }
        return super.receiveMessage(sender, msg);
    }
    appearing() { if (!this.checkLiveFlag(LF.UNK10)) return; this.state = STATE_NORMAL; this.offHitFilter(HF.NO_COLLISION); }
    initMapObj() { super.initMapObj(); this.unk14C = 7200; }
}
/** TWaterGun's nozzle kinds */
const HOVER = 0, ROCKET = 1, TURBO = 5;
export class NozzleBox extends MapObjGeneral {
    nozzleType = 0; item: ItemNozzle | null = null; unk150 = 0; unk154 = 0; nozzleName = ''; unk15C = true; unk166 = false;
    constructor(w: World, name = 'ノズルボックス') { super(w, name); }
    makeModelValid() {
        if (this.item && !this.item.checkLiveFlag(LF.DEAD)) { this.item.kill(); this.appear(); }
        this.makeObjAppeared();
        this.offHitFilter(HF.NO_DAMAGE);
        this.unk15C = true;
    }
    makeModelInvalid() {
        if (this.item && !this.item.checkLiveFlag(LF.DEAD)) { this.item.kill(); this.appear(); }
        this.onHitFilter(HF.NO_DAMAGE);
        this.startAnim(3);
        this.unk15C = false;
    }
    breaking() { if (this.animIsFinished()) this.makeObjDead(); }
    receiveMessage(sender: HitActor, msg: number): boolean {
        // (SMS_IsMarioHeadSlideAttack: his dive — the ghost's dive animations)
        if (this.unk15C && sender.isActorType(AT.MARIO) && msg === MSG.TRAMPLE && !this.world.mario.diving) {
            sender.receiveMessage(this, MSG.ATTACK);
            if (this.item) this.throwObjToFront(this.item, 50, this.unk150, this.unk154);
            this.kill();
            return true;
        }
        if (msg === MSG.ATTACH) this.makeModelValid();
        return false;
    }
    touchPlayer(_a: HitActor) {
        if (!this.unk15C && !this.unk166) { this.world.effect('balloon:e0056', this.pos); this.unk166 = true; }
    }
    control() {
        super.control();
        if (this.nozzleType !== HOVER && this.unk166 && this.collisions.length === 0) this.unk166 = false;
    }
    loadAfter() {
        super.loadAfter();
        this.item = newAndRegisterObj(this.world, this.nozzleName) as ItemNozzle | null;
        if (this.item) this.item.container = this;
        if (this.nozzleType === HOVER) this.makeModelValid();
        else if (this.unk15C) this.makeModelValid(); else this.makeModelInvalid();
    }
    load(s: Stream) {
        MapObjBase.prototype.load.call(this, s);
        this.nozzleName = s.str();
        this.unk15C = s.str() === 'valid';
        if (this.nozzleName === 'normal_nozzle_item') this.nozzleType = HOVER;
        else if (this.nozzleName === 'rocket_nozzle_item') this.nozzleType = ROCKET;
        else if (this.nozzleName === 'back_nozzle_item') this.nozzleType = TURBO;
        this.unk150 = fr(s.f32() * 0.02);
        this.unk154 = s.f32();
        if (this.unk154 < 0) this.unk154 = 20;
        this.startAnim(3); this.startAnim(2); this.startAnim(0);
    }
}

// ---------------------------------------------------------------- TItemManager
export class ItemManager extends MapObjBaseManager {
    unk40: Mtx = mtx(); unk70 = 2; unk74 = 0; unk78: CoinEmpty | null = null;
    constructor(w: World, name = 'アイテムマネージャー') { super(w, name); mapObjGlobals(w).itemManager = this; }
    hasMapCollision() { return false; }
    load(s: Stream) {
        super.load(s);
        this.unk78 = new CoinEmpty(this.world);
        this.unk78.initHitActor(AT.COIN, 0, 0, 0, 0, 0, 0);
    }
    loadAfter() {
        for (let i = 0; i < 20; i++) this.newAndRegisterCoinReal();
        for (let i = 0; i < 2; i++) newAndRegisterObj(this.world, 'bottle_large');
    }
    newAndRegisterCoinReal() { const c = new Coin(this.world, 'コイン'); c.initAndRegister('coin'); return c; }
    /** newAndRegisterCoin: a blue coin (event < 50), the pool's stand-in (100) or a red coin (200) */
    newAndRegisterCoin(id: number): Coin | null {
        let r: Coin | null;
        if (id < 0x32) r = newAndRegisterObj(this.world, 'coin_blue') as Coin;
        else if (id === 100) r = this.unk78;
        else if (id === 200) r = newAndRegisterObj(this.world, 'coin_red') as Coin;
        else return null;
        if (r) r.eventId = id;
        return r;
    }
    perform(cue: number) {
        if (cue & CUE_MOVE) {
            this.unk74 = fr(this.unk74 + this.unk70);
            if (this.unk74 > 360) this.unk74 = fr(this.unk74 - 360);
            const a = Math.trunc(fr(this.unk74 * (65536 / 360)));
            const s = JMASSin(a), c = JMASCos(a), m = this.unk40;
            m[0] = c; m[1] = 0; m[2] = s; m[3] = 0;
            m[4] = 0; m[5] = 1; m[6] = 0; m[7] = 0;
            m[8] = -s; m[9] = 0; m[10] = c; m[11] = 0;
        }
        super.perform(cue);
    }
    resetNozzleBoxesModel(kind: number) {
        for (const o of this.objs) {
            if (!o.isActorType(AT.NOZZLE_BOX)) continue;
            const b = o as NozzleBox;
            if (kind !== b.nozzleType) continue;
            if (b.checkLiveFlag(LF.DEAD)) b.emit('enmDisapA');
            b.makeModelValid();
        }
    }
    makeShineAppearWithDemo(shine: string, demo: string, x: number, y: number, z: number): Shine | null {
        const s = this.world.search(shine) as Shine | null;
        if (!(s instanceof Shine)) return null;
        s.pos.set(x, y, z);
        s.appearWithDemo(demo);
        return s;
    }
    makeShineAppearWithDemoOffset(shine: string, demo: string, dx: number, dy: number, dz: number): Shine | null {
        const s = this.world.search(shine) as Shine | null;
        if (!(s instanceof Shine)) return null;
        s.pos.set(fr(s.pos.x + dx), fr(s.pos.y + dy), fr(s.pos.z + dz));
        s.appearWithDemo(demo);
        return s;
    }
    makeShineAppearWithTime(shine: string, t: number, x: number, y: number, z: number, a: number, b: number, c: number): Shine | null {
        const s = this.world.search(shine) as Shine | null;
        if (!(s instanceof Shine)) return null;
        s.pos.set(x, y, z);
        s.appearWithTime(t, a, b, c);
        return s;
    }
}

// ---------------------------------------------------------------- newAndRegisterObj's classes
const ITEM_NAMES = ['mario_cap', 'bottle_large', 'bottle_short', 'GesoSurfBoardStatic', 'GesoSurfBoard'];
OBJ_MAKERS.item = (w, name) => (ITEM_NAMES.includes(name) ? new Item(w, name) : null);
OBJ_MAKERS.unique = (w, name) => {
    switch (name) {
        case 'coin': { const im = mapObjGlobals(w).itemManager as ItemManager | null; return im ? im.unk78 : null; }
        case 'coin_red': return new CoinRed(w, '赤コイン');
        case 'coin_blue': return new CoinBlue(w, '青コイン');
        case 'normal_nozzle_item': case 'back_nozzle_item': case 'rocket_nozzle_item': case 'yoshi_whistle_item': return new ItemNozzle(w);
        case 'joint_coin': return new Coin(w, 'コイン');
        case 'sand_bird_test': return new Item(w, 'アイテム');
        // TODO: TJuiceBlock (MapObjBlock.cpp) and the other unique classes; a plain map object for now
        case 'NormalBlock': case 'JuiceBlock': case 'no_data': case 'maregate': case 'SandBirdBlock': return new MapObjBase(w, '地形オブジェ基底');
        case 'bigWindmillBlock': return new MapObjBase(w, '風車の台');
    }
    const make = UNIQUE_MAKERS.get(name);
    return make ? make(w) : null;
};
/** newAndRegisterObjByEventID: what a hidden object holds (coins by event id, a Shine by name: 777). */
export function newAndRegisterObjByEventID(w: World, id: number, name: string): MapObjBase | null {
    const im = mapObjGlobals(w).itemManager as ItemManager | null;
    const c = im ? im.newAndRegisterCoin(id) : null;
    if (c) return c;
    switch (id) {
        case 777: return w.search(`シャイン（${name}）`) as MapObjBase | null;
        // the fruit (fruit.ts makes them by name)
        case 1000: return newAndRegisterObj(w, 'FruitBanana');
        case 1001: return newAndRegisterObj(w, 'FruitDurian');
        case 1002: return newAndRegisterObj(w, 'FruitPapaya');
        case 1003: return newAndRegisterObj(w, 'FruitPine');
        case 1004: return newAndRegisterObj(w, 'FruitCoconut');
        case 2000: return newAndRegisterObj(w, 'mushroom1up');
        case 2001: return newAndRegisterObj(w, 'mushroom1upR');
    }
    return null;
}

register('Item', (w, n) => new Item(w, n));
register('Coin', (w, n) => new Coin(w, n));
register('CoinRed', (w, n) => new CoinRed(w, n));
register('CoinBlue', (w, n) => new CoinBlue(w, n));
register('Shine', (w, n) => new Shine(w, n));
register('NozzleBox', (w, n) => new NozzleBox(w, n));
register('ItemNozzle', (w) => new ItemNozzle(w));
register('ItemManager', (w, n) => new ItemManager(w, n));
export { MsWrap };
