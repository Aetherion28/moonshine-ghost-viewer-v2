// TMapObjGeneral (MoveBG/MapObjGeneral.cpp): a map object with a body — it falls, bounces and slides
// by its physical data, can be held and thrown, breaks, sinks into goop (and comes back up when the
// goop is cleaned), appears growing and, if it's a disappearing one, blinks out after its time.

import { fr, V3, MsClamp, JMASSin, JMASCos, MsMtxSetXYZRPH } from '../math.js';
import { World, HitActor, TakeActor, LF, HF, HC, MSG } from '../engine.js';
import { AT as AT_ } from '../actortypes.js';
import type { WallCheck } from '../collision.js';
import { MapObjBase, MOF, STATE_DEAD, STATE_NORMAL } from './base.js';
import { register } from '../scene.js';
import { marioThrowPower } from './lib.js';

export const GS = {
    APPEARING: 0x2, BREAKING: 0x3, TOUCHING_PLAYER: 0x4, TOUCHING_WATER: 0x5, HOLDING: 0x6, SINKING: 0x7, BURIED: 0x8, RECOVERING: 0x9,
    WAITING_TO_APPEAR: 0xA,
};
export const NORMAL_LIVING_TIME = 960, NORMAL_FLUSH_TIME = 360, NORMAL_FLUSH_INTERVAL = 10, NORMAL_WAIT_TO_APPEAR_TIME = 360;
export const NORMAL_APPEARING_SCALE_UP = fr(0.01), NORMAL_THROW_SPEED_RATE = 0.5;

export class MapObjGeneral extends MapObjBase {
    unk138: any = null; unk13C: any = null; unk140 = 0; unk144 = 0;
    constructor(w: World, name = '汎用地形オブジェ') { super(w, name); }
    /** the physical data's values: [gravity, bounce, wall bounce, stop speed, ground friction, unk14, air friction, wall check Y, ...] */
    phys(i: number) { return this.data.physical!.data[i]; }
    initPhysicalData() { if (this.data.physical) this.gravity = this.phys(0); }
    initMapObj() { super.initMapObj(); this.initPhysicalData(); }
    getLivingTime() { return NORMAL_LIVING_TIME; }
    getFlushTime() { return NORMAL_FLUSH_TIME; }

    isPollutedGround(v: V3) {
        const P = this.world.pollution, p = this.initialPos;
        if (!P) return false;
        // (the first one asks at the initial Y and Z: the game's)
        return P.isPolluted(v.x, p.y, p.z) || P.isPolluted(v.x - 32, v.y, v.z - 32) || P.isPolluted(v.x + 32, v.y, v.z - 32)
            || P.isPolluted(v.x - 32, v.y, v.z + 32) || P.isPolluted(v.x + 32, v.y, v.z + 32);
    }
    private distToMario(v: V3) { const m = this.world.mario.pos; return fr(Math.sqrt((v.x - m.x) ** 2 + (v.y - m.y) ** 2 + (v.z - m.z) ** 2)); }
    waitingToAppear() {
        if (this.isStateTimerEngaged()) return;
        const md = this.world.mario.damageRadius;
        const extra = this.isActorType(AT_.WOOD_BARREL) ? 100 : 0;
        if (this.distToMario(this.initialPos) > md + this.damageRadius + extra) this.appear();
    }
    waitingToRecover() { if (!this.isPollutedGround(this.initialPos)) this.recover(); }
    waitToAppear(t: number) { this.stateTimer = t === 0 ? NORMAL_WAIT_TO_APPEAR_TIME : t; this.state = GS.WAITING_TO_APPEAR; }
    sink() {
        this.vel.zero();
        this.onLiveFlag(LF.UNK10);
        this.state = GS.SINKING;
        this.unk144 = this.pos.y;
        this.setUpMapCollision(1);
        this.startSound(6);
    }
    put() {
        this.holder = null;
        const keep = this.stateTimer;
        this.makeObjAppeared();
        this.stateTimer = keep;
        const m = this.world.mario, a = m.faceAngle, r = fr(this.damageRadius + m.damageRadius + 10);
        this.pos.set(fr(JMASSin(a) * r + m.pos.x), m.pos.y, fr(JMASCos(a) * r + m.pos.z));
        this.offLiveFlag(LF.UNK10);
        const [h, d] = this.world.checkGround(this.pos.x, this.pos.y, this.pos.z);
        this.groundHeight = h; this.groundPlane = d;
    }
    thrown() {
        const m = this.world.mario;
        this.pos.set(m.pos);
        this.rot.set(0, m.rot.y, 0);
        const [h, d] = this.world.checkGround(this.pos.x, this.pos.y, this.pos.z);
        this.groundHeight = h; this.groundPlane = d;
        this.unk138 = null;
        this.holder = null;
        const power = marioThrowPower(this.world), a = m.faceAngle;
        this.vel.set(fr(power * (JMASSin(a) * this.phys(11)) + NORMAL_THROW_SPEED_RATE * m.vel.x), this.phys(12),
            fr(power * (JMASCos(a) * this.phys(11)) + NORMAL_THROW_SPEED_RATE * m.vel.z));
        this.offLiveFlag(LF.UNK10);
        this.pos.add(this.vel);
        this.onLiveFlag(LF.AIRBORNE);
        this.removeMapCollision();
        this.offHitFilter(HF.NO_COLLISION);
        this.startAnim(5);
        this.startSound(5);
        this.state = STATE_NORMAL;
    }
    touchingWater() { if (this.animIsFinished() && this.hasModelOrAnimData(4)) this.startAnim(0); }
    touchingPlayer() { if (this.animIsFinished() && this.hasModelOrAnimData(4)) this.startAnim(0); }
    holding() {
        this.pos.set(this.holder!.pos);
        const [h, d] = this.world.checkGround(this.pos.x, this.pos.y, this.pos.z);
        this.groundHeight = h; this.groundPlane = d;
    }
    recovering() {
        this.startSound(9);
        if (this.hasModelOrAnimData(6)) {
            const y = this.rootMtx()[7];
            const dy = fr(y - this.unk144);
            this.damageHeight = fr(this.damageHeight + dy);
            this.calcEntryRadius();
            if (this.held) this.held.pos.y = fr(this.held.pos.y + dy);
            this.unk144 = y;
            if (!this.animIsFinished()) return;
        } else if (this.pos.y < this.unk144) {
            const r = this.data.sink!.recover;
            this.pos.y = fr(this.pos.y + r);
            if (this.held) this.held.pos.y = fr(this.held.pos.y + r);
            return;
        }
        this.makeObjRecovered();
    }
    sinking() {
        this.pos.y = fr(this.pos.y - this.data.sink!.sink);
        for (const c of this.collisions) if (c.isHitCategory(HC.WATER)) { this.recover(); return; }
        if (this.pos.y + (this.data.hit!.entries[2] as number[])[1] < this.unk144) {
            if (this.pos.x !== this.initialPos.x || this.pos.z !== this.initialPos.z) { this.makeObjDefault(); this.makeObjAppeared(); }
            else this.makeObjBuried();
        }
    }
    breaking() {
        if (this.animIsFinished()) {
            this.makeObjDead();
            if (this.checkMapObjFlag(MOF.RESPAWNING)) { this.makeObjDefault(); this.waitToAppear(0); }
        }
    }
    appearing() {
        if (this.hasAnim(1)) {
            if (!this.animIsFinished()) return;
        } else {
            const u = NORMAL_APPEARING_SCALE_UP;
            this.scale.set(fr(this.scale.x + u), fr(this.scale.y + u), fr(this.scale.z + u));
            if (this.scale.x < this.initialScale.x) return;
            this.scale.set(this.initialScale);
        }
        if (!this.checkLiveFlag(LF.UNK10)) return;
        this.makeObjAppeared();
    }
    appeared() { if (this.checkMapObjFlag(MOF.DISAPPEARING) && !this.isStateTimerEngaged()) this.makeObjDead(); }
    makeObjRecovered() { this.makeObjDefault(); this.makeObjAppeared(); }
    makeObjBuried() {
        this.unk144 = this.pos.y;
        this.pos.y = fr(this.pos.y - (this.data.hit!.entries[2] as number[])[3]);
        this.onHitFilter(HF.NO_COLLISION);
        this.removeMapCollision();
        this.mactor = null;
        this.state = GS.BURIED;
    }
    receiveMessageFromPlayer() { this.startAnim(4); }
    touchWater(_w: HitActor) {
        if (this.checkMapObjFlag(MOF.KILLED_BY_WATER)) { this.kill(); return 1; }
        if (this.hasModelOrAnimData(3)) { this.startAnim(3); this.state = GS.TOUCHING_WATER; }
        return 1;
    }
    touchPlayer(p: HitActor) {
        super.touchPlayer(p);
        if (this.hasModelOrAnimData(4)) { this.startAnim(4); this.state = GS.TOUCHING_PLAYER; }
    }
    recover() {
        const P = this.world.pollution;
        if (P) P.clean(this.pos.x, this.unk144, this.pos.z, Math.trunc((this.data.hit!.entries[2] as number[])[0] / 6) & 0xFFFF, this.world.map);
        this.setUpMapCollision(1);
        this.startAnim(6);
        this.state = GS.RECOVERING;
        this.setObjHitData(0);
        this.startSound(8);
        this.damageHeight = 0;
        this.calcEntryRadius();
        this.offHitFilter(HF.NO_COLLISION);
        if (this.hasModelOrAnimData(6)) { const t = this.pos.y; this.pos.y = this.unk144; this.unk144 = t; }
    }
    hold(a: TakeActor) {
        if (this.colMgr) this.colMgr.removeActiveCollision();
        this.onHitFilter(HF.NO_COLLISION);
        this.holder = a;
        this.state = GS.HOLDING;
    }
    ensureTakeSituation() {
        super.ensureTakeSituation();
        if (this.isState(GS.HOLDING) && !this.holder) { this.state = STATE_NORMAL; this.offLiveFlag(LF.UNK10); }
    }
    kill() {
        this.onHitFilter(HF.NO_COLLISION);
        this.removeMapCollision();
        this.onLiveFlag(LF.UNK10 | LF.UNK8);
        this.stateTimer = -1;
        this.startAnim(2);
        this.state = GS.BREAKING;
        this.startSound(2);
        this.breaking();
    }
    appear() {
        this.makeObjAppeared();
        this.startAnim(1);
        if (this.checkMapObjFlag(MOF.UNK800000)) this.scale.setAll(NORMAL_APPEARING_SCALE_UP);
        this.startSound(1);
        this.appearing();
        if (this.checkMapObjFlag(MOF.DISAPPEARING)) this.stateTimer = this.getLivingTime();
        this.state = GS.APPEARING;
    }
    work() {
        switch (this.state) {
            case STATE_NORMAL: this.appeared(); break;
            case GS.APPEARING: this.appearing(); break;
            case GS.BREAKING: this.breaking(); break;
            case GS.SINKING: this.sinking(); break;
            case GS.RECOVERING: this.recovering(); break;
            case GS.TOUCHING_PLAYER: this.touchingPlayer(); break;
            case GS.TOUCHING_WATER: this.touchingWater(); break;
            case GS.HOLDING: this.holding(); break;
            case GS.BURIED: this.waitingToRecover(); break;
        }
    }
    // ------------------------------------------------------------ movement
    touchWall(p: V3, r: WallCheck) {
        p.x = r.center[0]; p.z = r.center[2];
        this.calcReflectingVelocity(r.results[0], this.phys(2), this.vel);
    }
    checkWallCollision(p: V3) {
        p.y = fr(p.y + this.phys(7));
        const r: WallCheck = { center: [p.x, p.y, p.z], radius: this.bodyRadius, maxResults: 4, flags: this.data.physical!.wall, results: [] };
        const touched = this.world.isTouchedWallsAndMoveXZ(r);
        p.y = fr(p.y - this.phys(7));
        if (touched) { this.unk138 = r.results[0]; this.touchWall(p, r); }
        else this.unk138 = null;
    }
    touchRoof(p: V3) { p.y = this.unk140; }
    checkRoofCollision(p: V3) {
        const [h, d] = this.world.checkRoof(p.x, fr(p.y + this.headHeight), p.z);
        this.unk140 = h; this.unk13C = d;
        if (p.y + this.headHeight >= this.unk140) this.touchRoof(p);
    }
    touchGround(p: V3) {
        const ph = !!this.data.physical;
        if (ph) { this.vel.x = fr(this.vel.x * this.phys(4)); this.vel.z = fr(this.vel.z * this.phys(4)); }
        if (ph && Math.abs(this.vel.y) > this.phys(3)) {
            p.y = fr(p.y - this.vel.y);
            this.vel.y = fr(this.vel.y * -this.phys(1));
            this.startSound(4);
        } else {
            this.offLiveFlag(LF.AIRBORNE);
            this.vel.zero();
            this.onLiveFlag(LF.UNK10);
            p.y = this.groundHeight;
        }
    }
    checkGroundCollision(p: V3) {
        const [h, d] = this.world.checkGround(p.x, fr(p.y + this.headHeight), p.z);
        this.groundPlane = d; this.groundHeight = fr(h + 1);
        if (p.y <= this.groundHeight) this.touchGround(p);
        else if (!this.groundActor) this.onLiveFlag(LF.AIRBORNE);
    }
    calcVelocity() {
        if (this.isAirborne()) {
            this.vel.y = fr(this.vel.y - this.getGravityY());
            this.vel.y = MsClamp(this.vel.y, -this.bodyRadius, this.bodyRadius);
        }
        if (this.data.physical) {
            this.vel.x = fr(this.vel.x * this.phys(6)); this.vel.z = fr(this.vel.z * this.phys(6));
            this.vel.x = MsClamp(this.vel.x, -this.bodyRadius, this.bodyRadius);
            this.vel.z = MsClamp(this.vel.z, -this.bodyRadius, this.bodyRadius);
            if (this.groundPlane.n[1] === 1) {
                if (Math.abs(this.vel.x) < this.phys(3)) this.vel.x = 0;
                if (Math.abs(this.vel.z) < this.phys(3)) this.vel.z = 0;
            }
        }
    }
    bind() {
        if (this.checkLiveFlag(LF.UNK10)) return;
        if (this.binder) { this.binder.bind(this); return; }
        this.calcVelocity();
        const v = this.pos.clone().add(this.posDelta).add(this.vel).fround();
        this.checkGroundCollision(v);
        if (this.checkMapObjFlag(MOF.ENABLE_WALL_COLLISION)) this.checkWallCollision(v);
        if (this.checkMapObjFlag(MOF.ENABLE_ROOF_COLLISION) && this.vel.y > 0) this.checkRoofCollision(v);
        if (this.groundPlane.isIllegal()) { this.kill(); return; }
        if (!this.isAirborne() && this.vel.x === 0 && this.vel.y === 0 && this.vel.z === 0) this.onLiveFlag(LF.UNK10);
        this.posDelta.set(V3.sub(v, this.pos));
    }
    control() {
        super.control();
        if (this.checkMapObjFlag(MOF.CAN_SINK) && this.isState(STATE_NORMAL) && !this.isAirborne() && this.isPollutedGround(this.pos)) this.sink();
        this.work();
    }
    calcRootMatrix() {
        if (this.isState(GS.HOLDING) && this.holder) {
            const m = this.holder.getTakingMtx();
            if (m) { this.baseTR.set(m); this.pos.set(m[3], m[7], m[11]); this.anmMtx0 = null; return; }
        }
        MsMtxSetXYZRPH(this.baseTR, this.pos.x, fr(this.pos.y - this.yOffset), this.pos.z, this.rot.x, this.rot.y, this.rot.z);
        this.anmMtx0 = null;
    }
    perform(cue: number) {
        if (cue & 0x1) { if (this.isState(GS.WAITING_TO_APPEAR)) this.waitingToAppear(); }
        else if (this.checkMapObjFlag(MOF.DISAPPEARING) && this.isStateTimerEngaged() && this.stateTimer < this.getFlushTime()
            && (Math.trunc(this.stateTimer / NORMAL_FLUSH_INTERVAL) & 1) !== 0) {
            // (blinking: not drawn this frame)
            this.blinkOff = true;
            return;
        }
        if (!(cue & 0x1)) this.blinkOff = false;
        super.perform(cue);
    }
    /** for the viewer: off while it blinks */
    blinkOff = false;
    drawn() { return super.drawn() && !this.blinkOff; }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (super.receiveMessage(sender, msg)) return true;
        const zero = this.vel.x === 0 && this.vel.y === 0 && this.vel.z === 0;
        const st = this.state;
        if (msg === MSG.TAKE && this.checkMapObjFlag(MOF.TAKEABLE) && zero
            && (st === GS.APPEARING || st === STATE_NORMAL || st === GS.TOUCHING_PLAYER || st === GS.TOUCHING_WATER)) { this.hold(sender as TakeActor); return true; }
        if (msg === MSG.TAKE && sender.isActorType(AT_.HAUNT_LEG) && (st === GS.APPEARING || st === STATE_NORMAL)) { this.hold(sender as TakeActor); return true; }
        if (msg === MSG.PUT && st === GS.HOLDING) { this.put(); return true; }
        if (msg === MSG.THROWN && st === GS.HOLDING && this.data.physical) { this.thrown(); return true; }
        if (msg === MSG.HIP_DROP && this.checkMapObjFlag(MOF.UNK200000)) { this.kill(); return true; }
        if (sender.isActorType(AT_.MARIO) && (msg === MSG.TRAMPLE || msg === MSG.HIP_DROP)) { this.receiveMessageFromPlayer(); return true; }
        if (msg === MSG.UNKB && this.checkMapObjFlag(MOF.UNK200000)) this.kill();
        return false;
    }
    loadAfter() {
        super.loadAfter();
        if (this.checkMapObjFlag(MOF.CAN_SINK) && this.isPollutedGround(this.pos)) this.makeObjBuried();
    }
}
export { STATE_DEAD };

register('MapObjGeneral', (w, n) => new MapObjGeneral(w, n));
// (MarNameRefGen_MapObj.cpp: these are plain TMapObjGenerals too)
register('GlassBreak', (w, n) => new MapObjGeneral(w, n));
register('PanelBreak', (w, n) => new MapObjGeneral(w, n));
