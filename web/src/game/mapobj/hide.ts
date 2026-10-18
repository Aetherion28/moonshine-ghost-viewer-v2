// Objects with something hidden in them (MoveBG/MapObjHide.cpp): spray it, ground-pound it, hit
// it from below and a coin (or blue coin, or Shine) comes out; the graffiti signs (Bowser Jr.'s M,
// the twin graffiti) fade as they're sprayed and give theirs when gone. Also TWaterRecoverObj
// (MapObjPinna.cpp), the water refill spot.

import { fr, V3, mtx, MsClamp, MsMtxSetRotRPH } from '../math.js';
import { World, Stream, HitActor, LF, HF, MSG } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { MapObjBase, STATE_NORMAL, mapObjGlobals } from './base.js';
import { Coin, Shine, ItemManager, newAndRegisterObjByEventID, itemCounts } from './item.js';

export class HideObjBase extends MapObjBase {
    hidden: MapObjBase | null = null;
    appearSpeed = 0; appearYSpeed = 0; shineDemoName = ''; unk148 = 0; allowReveal = true;
    constructor(w: World, name = '隠しオブジェ') { super(w, name); }
    appearObj(yOff: number) { this.appearObjFromPoint(new V3(this.pos.x, fr(this.pos.y + yOff), this.pos.z)); }
    appearObjFromPoint(p: V3) {
        if (!this.hidden || !this.allowReveal) return;
        if (this.hidden.isActorType(AT.SHINE)) {
            this.hidden.onLiveFlag(LF.UNK10);
            this.hidden.pos.set(this.pos);
            (this.hidden as Shine).appearWithDemo(this.shineDemoName);
        } else {
            let o: MapObjBase | null;
            if (this.hidden.isActorType(AT.COIN)) {
                const im = mapObjGlobals(this.world).itemManager as ItemManager | null;
                o = im ? im.makeObjAppear(AT.COIN) : null;
                if (!o) return;
            } else o = this.hidden;
            this.throwObjToFrontFromPoint(o, p, this.appearSpeed, this.appearYSpeed);
            if (MapObjBase.isCoin(o)) { (o as Coin).container = this; (o as Coin).unk14C = this.unk148; }
            // TODO: TResetFruit::makeObjLiving (fruit isn't ported)
        }
        this.emitEffect();
        this.allowReveal = false;
    }
    emitEffect() { this.emit('watcoinHit'); }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (msg === MSG.ATTACH && (sender.isActorType(AT.COIN) || sender.isActorType(AT.COIN_RED) || sender.isActorType(AT.COIN_BLUE))) this.allowReveal = true;
        return super.receiveMessage(sender, msg);
    }
    loadAfter() {
        super.loadAfter();
        this.hidden = newAndRegisterObjByEventID(this.world, this.eventId, this.name);
        if (this.hidden) {
            if (this.hidden.isActorType(AT.COIN_BLUE) && itemCounts(this.world).blue.includes(this.eventId)) this.allowReveal = false;
            if (this.hidden.isActorType(AT.SHINE)) this.shineDemoName = `シャイン（${this.name}）カメラ`;
        }
    }
    load(s: Stream) {
        super.load(s);
        const [ev, sp, ys, t] = MapObjBase.loadHideObjInfo(s);
        this.eventId = ev; this.appearSpeed = sp; this.appearYSpeed = ys; this.unk148 = t;
    }
}
/** THideObj: hit from below */
export class HideObj extends HideObjBase {
    touchPlayer(_a: HitActor) { if (this.marioHeadAttack() && this.hidden) { this.appearObj(100); this.makeObjDead(); } }
}
/** TWaterHitHideObj: sprayed */
export class WaterHitHideObj extends HideObjBase {
    constructor(w: World, name = '水ヒットオブジェ') { super(w, name); }
    touchWater(_a: HitActor) { if (this.hidden) { this.appearObj(50); this.makeObjDead(); } return 1; }
}
/** THipDropHideObj: ground-pounded */
export class HipDropHideObj extends HideObjBase {
    constructor(w: World, name = 'ヒップドロップオブジェ') { super(w, name); }
    touchPlayer(_a: HitActor) { if (this.world.mario.hipDrop) { this.appearObj(0); this.makeObjDead(); } }
}

// ---------------------------------------------------------------- graffiti signs
export const PS = { HIT_BY_BARREL: 2, FINISHED: 3 };
export class WaterHitPictureHideObj extends HideObjBase {
    reverse = true; sprayProgressSpeed = 0; barrelProgressSpeed = 0; unk15C = 0; progress = 0; minProgress = 0; maxProgress = 255;
    color = { r: 0, g: 0, b: 0, a: 0 };
    constructor(w: World, name = 'オブジェ出現の絵') { super(w, name); }
    getObjAppearPos(): V3 { return this.pos; }
    afterFinishedAnim() {
        this.removeMapCollision();
        this.onHitFilter(HF.NO_DAMAGE);
        this.appearObjFromPoint(this.getObjAppearPos());
        this.state = PS.FINISHED;
    }
    forward(d: number) {
        if (this.reverse) { this.progress = fr(this.progress - d); if (this.progress < this.minProgress) this.afterFinishedAnim(); }
        else { this.progress = fr(this.progress + d); if (this.progress > this.maxProgress) this.afterFinishedAnim(); }
        this.progress = MsClamp(this.progress, this.minProgress, this.maxProgress);
        this.color.a = Math.trunc(this.progress) & 0xFF;
    }
    touchWater(a: HitActor) {
        const v = this.getWaterSpeed(a), m = this.rootMtx();
        if (m[2] * v.x + m[6] * v.y + m[10] * v.z > 0) return 0;
        this.forward(this.sprayProgressSpeed);
        return 1;
    }
    touchActor(a: HitActor) { if (a.isActorType(AT.WOOD_BARREL)) this.state = PS.HIT_BY_BARREL; }
    control() {
        MapObjBase.prototype.control.call(this);
        switch (this.state) {
            case STATE_NORMAL:
                if (this.reverse) { this.progress = fr(this.progress + this.unk15C); if (this.progress > this.maxProgress) this.progress = this.maxProgress; }
                else { this.progress = fr(this.progress - this.unk15C); if (this.progress < this.minProgress) this.progress = this.minProgress; }
                this.color.a = Math.trunc(this.progress) & 0xFF;
                break;
            case PS.HIT_BY_BARREL: this.forward(this.barrelProgressSpeed); break;
        }
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (msg === MSG.ATTACH && (sender.isActorType(AT.COIN) || sender.isActorType(AT.COIN_RED) || sender.isActorType(AT.COIN_BLUE))) {
            this.offHitFilter(HF.NO_COLLISION); this.offHitFilter(HF.NO_DAMAGE); this.offHitFilter(HF.NO_ATTACK);
            this.state = STATE_NORMAL; this.allowReveal = true;
            return true;
        }
        if (this.isState(PS.FINISHED)) return false;
        if (sender.isActorType(AT.WOOD_BARREL)) { this.state = PS.HIT_BY_BARREL; return true; }
        return super.receiveMessage(sender, msg);
    }
    loadAfter() {
        super.loadAfter();
        if (this.hidden && this.hidden.isActorType(AT.COIN_BLUE) && itemCounts(this.world).blue.includes(this.eventId)) { this.makeObjDead(); return; }
        switch (this.actorType) {
            case AT.CHIP_SHINE:
                this.minProgress = 32; this.maxProgress = 100;
                this.sprayProgressSpeed = this.rootMtx()[6] > 0.7 ? 1.5 : fr(0.48);
                this.unk15C = fr(0.2); this.reverse = false;
                break;
            case AT.KOOPA_JR_SIGN_M: case AT.SIGN_CIRCLE: case AT.SIGN_CROSS: case AT.SIGN_TRIANGLE:
                this.minProgress = 20; this.reverse = true; break;
            case AT.STAR_SIGN: this.sprayProgressSpeed = fr(1.2); this.minProgress = 30; this.maxProgress = 170; this.reverse = false; break;
            case AT.PICTURE_TERESA: this.minProgress = 0; this.maxProgress = 200; this.sprayProgressSpeed = fr(0.4); this.reverse = false; break;
            case AT.POSTER_TERESA: this.minProgress = 0; this.maxProgress = 255; this.reverse = true; break;
        }
        this.progress = this.reverse ? this.maxProgress : this.minProgress;
        if (this.hidden) {
            if (MapObjBase.isCoin(this.hidden)) this.hidden.offMapObjFlag(0x10000000);
            // (a Shine already got: the save's; none here)
        }
    }
    load(s: Stream) {
        super.load(s);
        const r = s.u32(), g = s.u32(), b = s.u32();
        this.color = { r: r & 0xFF, g: g & 0xFF, b: b & 0xFF, a: 0xFF };
        this.sprayProgressSpeed = fr(1.8); this.barrelProgressSpeed = 1; this.unk15C = fr(0.4);
        const yAxisZ = this.rootMtx()[6];
        if (yAxisZ > 0.7) {
            this.yOffset = 0; this.damageHeight = 40; this.calcEntryRadius();
            this.pos.y = fr(this.initialPos.y + this.yOffset); this.sprayProgressSpeed = fr(2.8);
        } else if (yAxisZ < -0.7) {
            this.yOffset = fr(this.scale.y * -10); this.damageHeight = 30; this.calcEntryRadius();
            this.pos.y = fr(this.initialPos.y + this.yOffset); this.sprayProgressSpeed = fr(2.5);
        } else this.sprayProgressSpeed = fr(1.8);
    }
    /** for the viewer: how see-through the sign is now (its TEV colour's alpha, 0..255) */
    alpha() { return this.color.a; }
}
export class HideObjPictureTwin extends WaterHitPictureHideObj {
    twin: HideObjPictureTwin | null = null; camera = '';
    constructor(w: World, name = 'ふたご落書き') { super(w, name); }
    getObjAppearPos(): V3 { return this.twin ? this.twin.pos : this.pos; }
    afterFinishedAnim() {
        this.removeMapCollision();
        this.onHitFilter(HF.NO_COLLISION);
        if (this.hidden && this.allowReveal && this.twin) {
            let o: MapObjBase | null = this.hidden;
            if (MapObjBase.isCoin(o)) {
                if (o.isActorType(AT.COIN)) {
                    const im = mapObjGlobals(this.world).itemManager as ItemManager | null;
                    o = im ? im.makeObjAppear(AT.COIN) : null;
                    if (!o) return;
                }
                (o as Coin).appearWithoutSound();
            } else o.appear();
            o.pos.set(this.twin.pos);
            const m = mtx(); MsMtxSetRotRPH(m, this.twin.rot.x, this.twin.rot.y, this.twin.rot.z);
            o.vel.set(fr(m[2] * this.appearSpeed), fr(fr(m[6] * this.appearSpeed) + this.appearYSpeed), fr(m[10] * this.appearSpeed));
            o.offLiveFlag(LF.UNK10);
            if (MapObjBase.isCoin(o)) { (o as Coin).container = this; (o as Coin).unk14C = this.unk148; }
            this.world.events.push({ t: this.world.tickCount, kind: 'demoCamera', data: { name: this.camera, p: o.pos.clone() } });
        }
        this.state = 3;
    }
    loadAfter() {
        super.loadAfter();
        const A = 'ふたご落書きＡ';
        const i = this.name.indexOf(A);
        if (i >= 0) {
            const tail = this.name.slice(i + A.length, i + A.length + 2);
            const t = this.world.search('ふたご落書きＢ' + tail) as HideObjPictureTwin | null;
            if (t instanceof HideObjPictureTwin) { this.twin = t; t.twin = this; }
        }
    }
    initMapObj() { super.initMapObj(); this.camera = `${this.name}カメラ`; }
}

/** TWaterRecoverObj: Mario's tank filled (told as an event), once every 600 ticks */
export class WaterRecoverObj extends MapObjBase {
    constructor(w: World, name = '水回復オブジェ') { super(w, name); }
    touchPlayer(a: HitActor) {
        if (a.isActorType(AT.MARIO) && !this.isStateTimerEngaged()) {
            a.receiveMessage(this, MSG.ATTACK);
            this.stateTimer = 600;
            this.world.events.push({ t: this.world.tickCount, kind: 'waterRecover', data: { p: this.pos.clone() } });
        }
    }
}

register('HideObj', (w, n) => new HideObjBase(w, n));
register('WaterHitHideObj', (w, n) => new WaterHitHideObj(w, n));
register('WaterHitPictureHideObj', (w, n) => new WaterHitPictureHideObj(w, n));
register('HideObjPictureTwin', (w, n) => new HideObjPictureTwin(w, n));
register('WaterRecoverObj', (w, n) => new WaterRecoverObj(w, n));
