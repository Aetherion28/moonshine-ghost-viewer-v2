// The wooden barrels (MoveBG/WoodBarrel.cpp's TWoodBarrel, a TMapObjGeneral): thrown, they break
// on the first wall or ground they hit, letting out a splash of water (barrel.prm, the model
// water); a dive (SMS_IsMarioHeadSlideAttack) or anything it's thrown at breaks it too. Put down
// on a fruit boat it breaks. The oil barrels break after being held for mBreakTime.

import { fr, V3 } from '../math.js';
import { World, Stream, HitActor, TakeActor, LF, HC, MSG } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import type { WallCheck } from '../collision.js';
import { MOF } from './base.js';
import { MapObjGeneral, GS } from './general.js';
import { marioStatus, marioHipDropping } from './lib.js';

export class WoodBarrel extends MapObjGeneral {
    static mWaitAppearTime = 360; static mBreakTime = 7200; static mOilBarrelFlushTime = 600;
    constructor(w: World, name = '木樽') { super(w, name); }
    getFlushTime() { return WoodBarrel.mOilBarrelFlushTime; }
    put() {
        super.put();
        const a = this.groundPlane && this.groundPlane.actor;
        if (a && a.isActorType(AT.FRUITS_BOAT)) { this.kill(); return; }
        if (this.groundHeight < fr(this.pos.y - 50)) { this.onLiveFlag(LF.AIRBORNE); this.offLiveFlag(LF.UNK10); }
        else { this.offLiveFlag(LF.AIRBORNE); this.onLiveFlag(LF.UNK10); }
    }
    hold(a: TakeActor) {
        super.hold(a);
        if (this.isActorType(AT.BARREL_OIL)) this.stateTimer = WoodBarrel.mBreakTime;
    }
    breaking() {
        if (this.animIsFinished()) {
            this.makeObjDefault();
            this.makeObjDead();
            if (this.checkMapObjFlag(MOF.RESPAWNING)) this.waitToAppear(WoodBarrel.mWaitAppearTime);
        }
    }
    kill() {
        super.kill();
        // gpModelWaterManager->emitRequest(barrel.prm) a metre up
        this.world.effect('barrelWater', new V3(this.pos.x, fr(this.pos.y + 100), this.pos.z));
        if (this.holder) { this.holder.receiveMessage(this, MSG.DETACH); this.holder = null; }
    }
    appeared() {
        super.appeared();
        const e = this.data.hit!.entries[0] as number[];
        this.damageHeight = marioHipDropping(this.world) ? fr(e[3] + 90) : e[3];
        this.calcEntryRadius();
        const [h, d] = this.world.checkGround(this.pos.x, this.pos.y, this.pos.z);
        this.groundHeight = h; this.groundPlane = d;
        if (fr(this.pos.y - 50) > h) this.offLiveFlag(LF.UNK10);
    }
    appear() {
        this.makeObjAppeared();
        this.emit('ms_enm_disap_a_w');
        this.world.sound(SE.SMOKE_EFFECT, this.pos);
    }
    touchWall(_p: V3, _r: WallCheck) { this.kill(); }
    touchGround(_p: V3) {
        this.kill();
        if (this.groundPlane.isWaterSurface()) this.emit('columWater');
    }
    touchPlayer(a: HitActor) {
        super.touchPlayer(a);
        // SMS_IsMarioHeadSlideAttack: MARIO_STATUS_CATCH or MARIO_STATUS_JUMP_CATCH
        const st = marioStatus(this.world);
        if (st === 0x800456 || st === 0x80088A) this.kill();
    }
    touchActor(a: HitActor) {
        if (a.isHitCategory(HC.NPC) || a.isHitCategory(HC.MAP_OBJECT)) { a.receiveMessage(this, MSG.ATTACK); this.kill(); }
        else { a.receiveMessage(this, MSG.ATTACK); super.touchActor(a); }
    }
    receiveMessage(sender: HitActor, msg: number) {
        if (msg === MSG.UNKD) { this.kill(); return true; }
        return super.receiveMessage(sender, msg);
    }
    control() {
        super.control();
        if (this.isActorType(AT.BARREL_OIL) && this.isState(GS.HOLDING) && !this.isStateTimerEngaged()) this.kill();
    }
    loadAfter() {
        super.loadAfter();
        const [h, d] = this.world.checkGround(this.pos.x, this.pos.y, this.pos.z);
        this.groundHeight = h; this.groundPlane = d;
        this.pos.y = h;
        this.initialPos.set(this.pos);
        // TODO: checkOnManhole (TManhole isn't ported)
    }
    load(s: Stream) { super.load(s); }
}

register('WoodBarrel', (w, n) => new WoodBarrel(w, n));
