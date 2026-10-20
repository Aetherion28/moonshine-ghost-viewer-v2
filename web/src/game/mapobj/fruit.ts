// Balls and fruit (MoveBG/MapObjBall.cpp's TMapObjBall, TResetFruit and Gelato's TBigWatermelon) and Yoshi's egg
// (MoveBG/Item.cpp's TEggYoshi). A ball rolls (its root matrix turned by how far it rolled),
// bounces off walls, ground and roofs, is bumped and kicked by Mario and knocked by enemies, can
// be carried, and pushed by water. The "infinite" fruit: picked up, thrown or sprayed it starts
// living (rots after 14400 ticks: a puff, then it grows back at its place); falling in water,
// goop or off the map it comes back at its place after 360 ticks.
//
// Yoshi's egg wants one fruit (shown in its bubble); fed that one it hatches Yoshi. It needs the
// save's flag (Yoshi freed in Pianta Village, Shine 0x21): the save starts empty here (as for the
// coins, see item.ts), so outside the egg event it is gone from the stage, as the game does then.
// TODO: TYoshi isn't simulated: the hatch is told as a 'yoshiHatch' event.

import { MSF } from '../flags.js';
import { fr, V3, Mtx, mtx, MsRandF, matan, MsMtxSetXYZRPH, sqDist } from '../math.js';
import { World, Stream, HitActor, TakeActor, LF, HF, MSG, ANM_BCK, ANM_BTP, MActor } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import type { WallCheck } from '../collision.js';
import { MapObjBase, MapObjBaseManager, MOF, STATE_DEAD, STATE_NORMAL, OBJ_MAKERS, mapObjGlobals } from './base.js';
import { MapObjGeneral, GS } from './general.js';
import './item.js';
import { MTXConcat, MTXRotAxisRad, setRootMtx, getWaterSpeed, getVerticalVecToTargetXZ, marioSpeedY, marioHeld } from './lib.js';

const ABS = Math.abs;
export const isHideObj = (a: HitActor) => [AT.HELP_ACTOR, AT.KOOPA_JR_SIGN_M, AT.CHIP_SHINE, AT.SIGN_CIRCLE, AT.SIGN_CROSS, AT.SIGN_TRIANGLE, AT.STAR_SIGN, AT.MAP_OBJ_TREE_SCALE]
    .some((t) => t !== undefined && a.isActorType(t));
const marioVel = (w: World) => { const m = w.mario as any; return typeof m.mStatus === 'number' ? m.mVel : m.vel; };

// ---------------------------------------------------------------- TMapObjBall
export class MapObjBall extends MapObjGeneral {
    unk148 = 0; unk14C = 0; unk150 = 0; unk154 = 0; unk158 = 0; unk15C = 0; unk160 = 0; unk164 = 0; unk168 = 0; unk16C = 0;
    unk170 = 0; unk174 = 0; unk178 = 0; unk17C = 0; unk180 = 0; unk184 = 0; unk188 = 0; unk18C = 0; unk190 = 0; unk194 = 0;
    constructor(w: World, name = 'ボール') { super(w, name); }
    /** the physical data's floats by their offsets (unk4 bounce, unk8 wall bounce, unkC stop speed, unk10 ground friction) */
    protected ph(off: number) { return this.phys(off / 4); }
    private soundTable(i: number) { return (this.data as any).sound ? (this.data as any).sound[i] : -1; }
    getDepthAtFloating() { return this.unk18C; }
    /** getModel()->calc(): the root matrix from the base matrix again */
    protected modelCalc() { MapObjBase.prototype.calcRootMatrix.call(this); setRootMtx(this, this.rootMtx()); }
    /** (its root matrix is its own: kept as it was until it's set again) */
    calcRootMatrix() {
        if (this.isState(GS.HOLDING) || !this.anmMtx0) { super.calcRootMatrix(); return; }
    }
    touchRoof(p: V3) {
        if (p.y > this.unk140) p.y = this.unk140;
        if (this.unk13C) this.calcReflectingVelocity(this.unk13C, this.ph(4), this.vel);
    }
    touchWall(p: V3, r: WallCheck) {
        if (!this.isAirborne() && !this.isActorType(AT.WATERMELON)) {
            const sp = fr(Math.sqrt(this.vel.squared()));
            this.vel.y = fr(this.vel.y + fr(this.unk184 * sp));
        }
        for (const d of r.results) {
            const vd = fr(this.vel.x * d.n[0] + this.vel.y * d.n[1] + this.vel.z * d.n[2]);
            if (vd < 0) {
                const dist = fr(p.x * d.n[0] + p.y * d.n[1] + p.z * d.n[2] + d.d);
                p.x = fr(p.x + fr(this.bodyRadius - dist) * d.n[0]);
                p.z = fr(p.z + fr(this.bodyRadius - dist) * d.n[2]);
                const b = fr(vd * -(-1 + this.ph(8)));
                this.vel.x = fr(this.vel.x + b * d.n[0]);
                this.vel.z = fr(this.vel.z + b * d.n[2]);
                if (this.isActorType(AT.WATERMELON)) this.world.sound(this.scale.y >= 5 ? SE.OBJ_WATERMELON_BROLL : SE.OBJ_WATERMELON_SROLL, this.pos);
                else { const s = this.soundTable(4); if (s >= 0) this.world.sound(s, this.pos); }
            }
        }
    }
    touchPollution() { this.kill(); }
    touchWaterSurface() { this.kill(); }
    rebound(p: V3) {
        this.calcReflectingVelocity(this.groundPlane, this.ph(4), this.vel);
        p.y = this.groundHeight;
        this.onLiveFlag(LF.AIRBORNE);
        if (this.isActorType(AT.WATERMELON)) this.world.sound(this.scale.y >= 5 ? SE.OBJ_WATERMELON_BBUND : SE.OBJ_WATERMELON_SBUND, this.pos);
        else { const s = this.soundTable(4); if (s >= 0) this.world.sound(s, this.pos); }
    }
    touchGround(p: V3) {
        const sp = fr(Math.sqrt(this.vel.squared()));
        if (sp > 0.05 && this.isActorType(AT.WATERMELON)) this.world.sound(this.scale.y >= 5 ? SE.OBJ_WATERMELON_BROLL : SE.OBJ_WATERMELON_SROLL, this.pos);
        const P = this.world.pollution;
        if (this.groundPlane.isWaterSurface()) { this.touchWaterSurface(); p.set(this.pos); return; }
        if (P && P.isPolluted(p.x, p.y, p.z)) { this.touchPollution(); p.set(this.pos); return; }
        if (this.vel.y > -this.unk188) { this.offLiveFlag(LF.AIRBORNE); this.vel.y = 0; p.y = this.groundHeight; }
        else this.rebound(p);
        if (!this.isAirborne()) {
            this.vel.x = fr(this.vel.x + fr(this.unk180 * this.groundPlane.n[0]));
            this.vel.z = fr(this.vel.z + fr(this.unk180 * this.groundPlane.n[2]));
        }
        this.vel.x = fr(this.vel.x * this.ph(0x10));
        this.vel.z = fr(this.vel.z * this.ph(0x10));
        if (this.isActorType(AT.WATERMELON) && (ABS(this.vel.x) > this.ph(0xC) || ABS(this.vel.z) > this.ph(0xC))) this.world.sound(SE.MA_SLIP, this.pos);
    }
    put() { super.put(); this.calcCurrentMtx(); }
    hold(a: TakeActor) {
        if (Math.sqrt(this.vel.squared()) > 10) return;
        super.hold(a);
        this.vel.zero();
    }
    kicked() {
        const w = this.world, mv = marioVel(w);
        if (this.vel.y > 0) return;
        if (this.vel.y === 0) this.vel.y = this.unk178;
        else this.vel.y = fr(fr(this.unk174 * marioSpeedY(w)) - fr(this.unk160 * this.vel.y));
        this.vel.x = fr(this.vel.x + fr(this.unk170 * mv.x));
        this.vel.z = fr(this.vel.z + fr(this.unk170 * mv.z));
        const c = this.ph(0xC);
        if (ABS(this.vel.x) < c && ABS(this.vel.z) < c) { this.vel.x = fr(fr(MsRandF() * 2) - 1); this.vel.z = fr(fr(MsRandF() * 2) - 1); }
        this.unk194 = 10;
        this.offLiveFlag(LF.UNK10);
        this.onLiveFlag(LF.AIRBORNE);
        w.mario.receiveMessage(this, MSG.ATTACK);
        if (!this.isActorType(AT.WATERMELON)) w.sound(SE.MA_KICK_DRIAN, this.pos);
    }
    touchWater(a: HitActor) {
        if (this.isState(GS.HOLDING) || this.isState(GS.APPEARING)) return 1;
        const s = getWaterSpeed(this.world, a);
        this.vel.set(fr(this.vel.x + fr(this.unk17C * s.x)), fr(this.vel.y + fr(this.unk17C * s.y)), fr(this.vel.z + fr(this.unk17C * s.z)));
        this.offLiveFlag(LF.UNK10);
        return 1;
    }
    boundByActor(a: HitActor) {
        const w = this.world, mv = marioVel(w);
        const d = new V3(fr(a.pos.x - this.pos.x), 0, fr(a.pos.z - this.pos.z));
        const r = this.isActorType(AT.WATERMELON) ? fr(this.attackRadius + a.damageRadius) : this.damageRadius;
        if (r * r < d.x * d.x + d.z * d.z) return;
        if (d.x !== 0 && d.z !== 0) { const l = Math.sqrt(d.x * d.x + d.z * d.z); d.x = fr(d.x / l); d.z = fr(d.z / l); }
        const c = this.ph(0xC);
        if (a.isActorType(AT.MARIO)) {
            if (!this.checkMapObjFlag(MOF.UNK2000000)) {
                if (ABS(mv.x) > c || ABS(mv.z) > c) {
                    this.vel.y = fr(this.vel.y + this.unk150);
                    if (!this.isActorType(AT.WATERMELON)) w.sound(SE.MA_KICK_DRIAN, this.pos);
                } else this.vel.y = fr(this.vel.y + this.unk154);
                this.vel.x = fr(this.vel.x + fr(fr(this.unk148 * mv.x) - fr(d.x * this.unk14C)));
                this.vel.z = fr(this.vel.z + fr(fr(this.unk148 * mv.z) - fr(d.z * this.unk14C)));
                a.receiveMessage(this, MSG.ATTACK);
            }
        } else {
            const ap = fr(this.vel.dot(d));
            if (ap >= 0 && ABS(this.vel.x) > c && ABS(this.vel.z) > c) {
                this.vel.x = fr(this.vel.x - fr((1 + this.unk16C) * fr(d.x * ap)));
                this.vel.y = fr(this.vel.y + this.unk168);
                this.vel.z = fr(this.vel.z - fr((1 + this.unk16C) * fr(d.z * ap)));
                a.receiveMessage(this, MSG.UNK10);
                if (!this.isActorType(AT.WATERMELON)) w.sound(SE.IT_DRIAN_BOUND, this.pos);
            } else {
                this.vel.x = fr(this.vel.x - fr(d.x * this.unk164));
                this.vel.y = fr(this.vel.y + this.unk168);
                this.vel.z = fr(this.vel.z - fr(d.z * this.unk164));
            }
        }
        if (a.isActorType(AT.MARIO) && !this.checkMapObjFlag(MOF.UNK2000000) && this.vel.y < 0 && w.mario.pos.y + 130 < this.pos.y + this.bodyRadius) {
            this.vel.y = fr(-this.unk160 * this.vel.y);
            this.vel.x = fr(this.vel.x + fr(this.unk158 * mv.x));
            this.vel.y = fr(this.vel.y + fr(this.unk15C * marioSpeedY(w)));
            this.vel.z = fr(this.vel.z + fr(this.unk158 * mv.z));
            if (!this.isActorType(AT.WATERMELON)) w.sound(SE.MA_KICK_DRIAN, this.pos);
        }
        this.unk194 = 10;
        this.offLiveFlag(LF.UNK10);
        this.onLiveFlag(LF.AIRBORNE);
    }
    touchActor(a: HitActor) {
        if (this.unk194 !== 0 || this.isState(GS.HOLDING) || isHideObj(a) || a.isActorType(AT.YOSHI_TONGUE) || a.isActorType(AT.SAND_LEAF) || a.isActorType(AT.SAND_BOMB)) return;
        if (a.isActorType(AT.MARIO) && !this.isActorType(AT.WATERMELON) && marioSpeedY(this.world) !== 0) this.kicked();
        else this.boundByActor(a);
    }
    /** calcCurrentMtx: rolled by how far it went, at its place (raised by its radius) */
    calcCurrentMtx() {
        const c = this.ph(0xC);
        const rot = mtx();
        if (ABS(this.vel.x) < c && ABS(this.vel.z) < c && this.groundPlane.n[1] === 1) { this.vel.x = 0; this.vel.z = 0; }
        if (ABS(this.vel.x) > c || ABS(this.vel.z) > c) {
            const ax = getVerticalVecToTargetXZ(this, fr(this.pos.x + this.vel.x), fr(this.pos.z + this.vel.z));
            const dist = fr(Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z));
            MTXRotAxisRad(rot, ax, fr(fr(dist / this.bodyRadius) * 2));
        }
        const a = Float64Array.from(this.rootMtx());
        a[3] = a[7] = a[11] = 0;
        MTXConcat(rot, a, rot);
        rot[3] = this.pos.x; rot[7] = fr(this.pos.y + this.bodyRadius); rot[11] = this.pos.z;
        if (this.isActorType(AT.FRUIT_BANANA) && rot[5] > 0) rot[7] = fr(rot[7] - fr(50 * rot[5]));
        if (this.isActorType(AT.FRUIT_PINE)) rot[7] = fr(rot[7] - fr(10 * (1 - rot[5])));
        setRootMtx(this, rot);
    }
    checkWallCollision(p: V3) {
        const r: WallCheck = { center: [p.x, fr(p.y + this.bodyRadius), p.z], radius: this.bodyRadius, maxResults: 4, flags: this.data.physical!.wall, results: [] };
        if (this.world.isTouchedWallsAndMoveXZ(r)) {
            this.unk138 = r.results[0];
            p.x = r.center[0]; p.z = r.center[2];
            this.touchWall(p, r);
        } else this.unk138 = null;
    }
    /** the root matrix's translation put at the place (Y raised by the radius) */
    protected placeRoot(adjust: boolean) {
        const m = Float64Array.from(this.rootMtx());
        m[3] = this.pos.x; m[7] = fr(this.pos.y + this.bodyRadius); m[11] = this.pos.z;
        if (adjust) {
            if (this.isActorType(AT.FRUIT_BANANA) && m[5] > 0) m[7] = fr(m[7] - fr(50 * m[5]));
            if (this.isActorType(AT.FRUIT_PINE)) m[7] = fr(m[7] - fr(10 * (1 - m[5])));
        }
        setRootMtx(this, m);
    }
    makeObjDefault() { MapObjBase.prototype.makeObjDefault.call(this); this.placeRoot(false); }
    makeObjAppeared() {
        MapObjBase.prototype.makeObjAppeared.call(this);
        this.calcCurrentMtx();
        this.placeRoot(true);
        this.unkE8 = 0;
    }
    control() {
        super.control();
        if (this.unk194 !== 0) this.unk194 -= 1;
        if (this.isState(GS.HOLDING) && this.holder) {
            const t = this.holder.getTakingMtx();
            const m = t ? Float64Array.from(t) : mtx();
            if (!t) { m[3] = this.holder.pos.x; m[7] = this.holder.pos.y; m[11] = this.holder.pos.z; }
            m[7] = fr(m[7] + this.unk190);
            setRootMtx(this, m);
        } else if (!(this.vel.x === 0 && this.vel.y === 0 && this.vel.z === 0) || this.groundPlane.actor) this.calcCurrentMtx();
    }
    receiveMessage(a: HitActor, msg: number): boolean {
        if (super.receiveMessage(a, msg)) return true;
        if (msg === MSG.TAKE && this.checkMapObjFlag(MOF.TAKEABLE)) { this.hold(a as TakeActor); return true; }
        if (a.isActorType(AT.MARIO) && !this.isActorType(AT.WATERMELON) && msg !== MSG.TAKE) { this.kicked(); return true; }
        return false;
    }
    initMapObj() {
        super.initMapObj();
        this.initialScale.set(this.scale);
        const set = (v: number[]) => {
            const k = ['unk148', 'unk14C', 'unk150', 'unk154', 'unk158', 'unk15C', 'unk160', 'unk170', 'unk174', 'unk178', 'unk164', 'unk168', 'unk16C', 'unk17C', 'unk180', 'unk184', 'unk188'];
            k.forEach((n, i) => { if (v[i] !== undefined) (this as any)[n] = fr(v[i]); });
        };
        switch (this.actorType) {
            case AT.WATERMELON:
                set([this.unk148, 4, 0, 0, 0.15, 0, 0.9, 0.5, 0.2, 2.5, 0.06, 1.5, 0.5, 0.001, 0.3, 1.5, 1.5]);
                this.bodyRadius = fr(50 * this.scale.y); this.unk18C = fr(this.bodyRadius / 3); break;
            case AT.FOOTBALL:
                set([0.6, 2, 0.02, 0, 0.055, 0.02, 0.83, 0.9, 0.13, 20, 0.5, 0.02, 0.5, 1.2, 0.8, 1, 1.5]);
                this.bodyRadius = fr(50 * this.scale.y); this.unk18C = fr(this.bodyRadius / 3); break;
            case AT.FRUIT_DURIAN:
                set([0.6, 0.2, 1.3, 15, 0.5, 1.3, 1, 0.9, 0.13, 20, 2, 0.02, 0.3, 0.05, 0.5, 1, 1.5]);
                this.bodyRadius = fr(50 * this.scale.y); this.unk18C = 50; break;
            case AT.FRUIT_COCONUT: case AT.FRUIT_PAPAYA: case AT.FRUIT_PINE: case AT.RED_PEPPER:
                set([0.4, 0.2, 1.3, 0, 1.2, 0.8, 0.5, 0.9, 0.13, 20, 2, 0.02, 0.3, 0.05, 0.5, 1, 1.5]);
                this.bodyRadius = fr(50 * this.scale.y); this.unk18C = 50; break;
            case AT.FRUIT_BANANA:
                set([0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.05, 0.5, 1, 1.5]);
                this.bodyRadius = fr(50 * this.scale.y); this.unk18C = 50; break;
        }
        if (this.isActorType(AT.FRUIT_DURIAN)) { this.bodyRadius = fr(this.scale.y * 45); this.unk190 = this.bodyRadius; }
        if (this.isActorType(AT.FRUIT_COCONUT)) { this.bodyRadius = fr(this.scale.y * 40); this.unk190 = 20; }
        if (this.isActorType(AT.FRUIT_PAPAYA)) { this.bodyRadius = fr(this.scale.y * 40); this.unk190 = 20; }
        if (this.isActorType(AT.FRUIT_PINE)) this.unk190 = 10;
    }
}

// ---------------------------------------------------------------- TResetFruit
export const RFS = { LIVING: 0xB, ROTTING: 0xC, WAIT_EFFECT: 0xD };
export class ResetFruit extends MapObjBall {
    static mFruitLivingTime = 14400; static mScaleUpSpeed = fr(1.05); static mBreakingScaleSpeed = fr(0.96); static mFruitWaitTimeToAppear = 360;
    unk198 = 0; unk1A4 = 0;
    /** the TEV colour (reg 0) it's drawn with */
    fruitColor = { r: 255, g: 255, b: 255, a: 255 };
    constructor(w: World, name = '無限フルーツ') { super(w, name); }
    getLivingTime() { return ResetFruit.mFruitLivingTime; }
    checkGroundCollision(p: V3) {
        const w = this.world;
        if (w.map !== 7 && w.map !== 4) { super.checkGroundCollision(p); return; }
        if (w.map === 4) {
            const [h, d] = w.checkGround(p.x, fr(p.y + 200), p.z);
            this.groundPlane = d; this.groundHeight = fr(h + 1);
        } else {
            let [h, d] = w.checkGround(p.x, fr(p.y + this.headHeight), p.z);
            if (d.bgType === 0x801 || d.bgType === 0x203) [h, d] = w.col.checkGround(p.x, fr(h - 200), p.z, 0);
            this.groundPlane = d; this.groundHeight = fr(h + 1);
        }
        if (p.y <= this.groundHeight) this.touchGround(p);
        else this.onLiveFlag(LF.AIRBORNE);
    }
    /** a 0.2 scale on the root matrix's rotation (concatOnlyRotFromLeft) */
    private scaleRoot(sx: number, sy: number, sz: number) {
        const m = Float64Array.from(this.rootMtx());
        for (let c = 0; c < 3; c++) { m[c] = fr(m[c] * sx); m[4 + c] = fr(m[4 + c] * sy); m[8 + c] = fr(m[8 + c] * sz); }
        return m;
    }
    waitingToAppear() {
        if (this.world.map === 3 && this.unk1A4 !== 0) this.makeObjDead();
        if (!this.checkMapObjFlag(MOF.UNK4000000) && !this.isStateTimerEngaged() && this.collisions.length === 0) {
            this.onMapObjFlag(MOF.DISAPPEARING);
            this.makeObjAppeared();
            setRootMtx(this, this.scaleRoot(0.2, 0.2, 0.2));
            this.scale.y = fr(0.2);
            this.onHitFilter(HF.NO_COLLISION);
            this.state = GS.APPEARING;
            this.world.sound(SE.IT_COMMON_APPEAR, this.pos);
        }
    }
    makeObjWaitingToAppear() {
        this.state = RFS.LIVING;
        this.makeObjDefault();
        this.makeObjDead();
        this.modelCalc();
        this.stateTimer = ResetFruit.mFruitWaitTimeToAppear;
        this.offMapObjFlag(MOF.DISAPPEARING);
        this.state = GS.WAITING_TO_APPEAR;
        if (this.world.map === 3 && this.unk1A4 !== 0) this.makeObjDead();
    }
    thrown() { super.thrown(); this.state = RFS.LIVING; }
    hold(a: TakeActor) {
        super.hold(a);
        this.vel.zero();
        this.onLiveFlag(LF.UNK10);
        if (!this.checkMapObjFlag(MOF.UNK4000000) && !this.isStateTimerEngaged()) { this.onMapObjFlag(MOF.DISAPPEARING); this.stateTimer = this.getLivingTime(); }
    }
    touchPollution() {
        this.emit('moeFireOff');
        this.world.sound(SE.OBJ_AWAY_INTO_GRAF, this.pos);
        this.makeObjDefault();
        this.makeObjWaitingToAppear();
    }
    touchWaterSurface() {
        this.emit('columnWater');
        this.world.sound(SE.OBJ_DRINA_TO_WATER, this.pos);
        this.makeObjWaitingToAppear();
    }
    touchWater(a: HitActor) { super.touchWater(a); this.makeObjLiving(); return 1; }
    touchActor(a: HitActor) { this.pick(a); }
    touchGround(p: V3) {
        if (this.groundPlane.bgType === 0x800) { this.makeObjWaitingToAppear(); p.set(this.pos); }
        else super.touchGround(p);
    }
    makeObjLiving() {
        if (!this.isStateTimerEngaged()) { this.onMapObjFlag(MOF.DISAPPEARING); this.stateTimer = this.getLivingTime(); }
        this.offLiveFlag(LF.UNK10);
        this.state = RFS.LIVING;
    }
    pick(a: HitActor) {
        if (this.isState(GS.APPEARING) || this.isState(GS.BREAKING) || this.isState(RFS.ROTTING) || this.isState(GS.WAITING_TO_APPEAR)) return;
        MapObjBall.prototype.touchActor.call(this, a);
        if (!this.checkMapObjFlag(MOF.UNK4000000) && this.isState(STATE_NORMAL) && !this.checkLiveFlag(LF.UNK10)) this.makeObjLiving();
    }
    kicked() {
        const w = this.world, mv = marioVel(w);
        if (this.checkMapObjFlag(MOF.UNK2000000) || this.isState(GS.HOLDING)) return;
        if (marioSpeedY(w) < 0) return;
        const tm = new V3(fr(w.mario.pos.x - this.pos.x), 0, fr(w.mario.pos.z - this.pos.z));
        if (this.vel.y <= 0 && !(this.isAirborne() && this.vel.dot(tm) > 0)) {
            if (this.vel.y === 0) this.vel.y = this.unk178;
            else this.vel.y = fr(fr(this.unk174 * marioSpeedY(w)) - fr(this.unk160 * this.vel.y));
            this.vel.x = fr(this.vel.x + fr(this.unk170 * mv.x));
            this.vel.z = fr(this.vel.z + fr(this.unk170 * mv.z));
            const c = this.ph(0xC);
            if (ABS(this.vel.x) < c && ABS(this.vel.z) < c) { this.vel.x = fr(fr(MsRandF() * 2) - 1); this.vel.z = fr(fr(MsRandF() * 2) - 1); }
            this.unk194 = 10;
            this.offLiveFlag(LF.UNK10);
            w.mario.receiveMessage(this, MSG.ATTACK);
            w.sound(SE.MA_KICK_DRIAN, this.pos);
        }
    }
    living() {
        MapObjBall.prototype.control.call(this);
        if (!this.checkMapObjFlag(MOF.UNK4000000) && !this.isStateTimerEngaged()) {
            if (this.holder) { this.holder.receiveMessage(this, MSG.DETACH); this.holder.held = null; this.holder = null; }
            this.vel.zero();
            this.state = RFS.ROTTING;
        }
    }
    waitEffect() {
        this.pos.y = fr(this.pos.y + fr(this.bodyRadius / 2));
        this.scale.set(this.initialScale);
        this.emit('enmDisapAW');
        this.world.sound(SE.SMOKE_EFFECT, this.pos);
        this.stateTimer = 240;
        this.sleep();
        this.state = RFS.WAIT_EFFECT;
    }
    rotting() { }
    breaking() {
        const S = ResetFruit.mBreakingScaleSpeed;
        const m = this.scaleRoot(1, S, 1);
        this.scale.y = fr(this.scale.y * S);
        m[7] = fr(fr(this.bodyRadius * this.scale.y) + this.pos.y);
        setRootMtx(this, m);
        if (this.scale.y < 0.2) this.waitEffect();
    }
    appearing() {
        const S = ResetFruit.mScaleUpSpeed;
        const m = this.scaleRoot(S, S, S);
        this.scale.y = fr(this.scale.y * S);
        this.scaledBodyRadius = fr(this.bodyRadius * this.scale.y);
        m[7] = fr(fr(this.bodyRadius * this.scale.y) + this.pos.y);
        setRootMtx(this, m);
        if (this.scale.y >= this.initialScale.y) {
            this.scale.set(this.initialScale);
            this.modelCalc();
            this.offHitFilter(HF.NO_COLLISION);
            this.makeObjAppeared();
            this.state = STATE_NORMAL;
        }
    }
    control() {
        switch (this.state) {
            case STATE_NORMAL:
                this.offHitFilter(HF.NO_COLLISION);
                for (const c of this.collisions.slice()) this.pick(c);
                if (this.groundPlane.actor) this.calcCurrentMtx();
                break;
            case RFS.LIVING:
                this.offHitFilter(HF.NO_COLLISION);
                if (this.world.map === 4 && this.checkLiveFlag(LF.UNK10)) this.offLiveFlag(LF.UNK10);
                if (this.groundPlane.actor) { if (this.checkLiveFlag(LF.UNK10)) this.offLiveFlag(LF.UNK10); }
                else this.unk198 = 0;
                this.living();
                break;
            case GS.HOLDING: this.living(); break;
            case GS.APPEARING: case GS.BREAKING: MapObjBall.prototype.control.call(this); break;
            case RFS.ROTTING: this.waitEffect(); break;
            case RFS.WAIT_EFFECT:
                if (!this.isStateTimerEngaged()) {
                    this.fruitColor.r = this.fruitColor.g = this.fruitColor.b = 0xFF;
                    this.awake();
                    this.makeObjWaitingToAppear();
                }
                break;
        }
    }
    // TODO: Delfino Plaza's (map 7) area-cube reset (TResetFruit::perform): not here
    killByTimer(t: number) { this.stateTimer = t; this.onMapObjFlag(MOF.DISAPPEARING); this.state = RFS.LIVING; }
    makeObjAppeared() {
        if (this.checkMapObjFlag(MOF.UNK4000000)) this.makeObjDefault();
        MapObjBase.prototype.makeObjAppeared.call(this);
        this.calcCurrentMtx();
        this.placeRoot(true);
        this.unkE8 = 0;
        if (this.checkMapObjFlag(MOF.UNK4000000)) this.state = RFS.LIVING;
    }
    receiveMessage(a: HitActor, msg: number): boolean {
        if (msg === MSG.UNKB) {
            if (this.isState(STATE_NORMAL) || this.isState(GS.HOLDING) || this.isState(RFS.LIVING)) { this.makeObjWaitingToAppear(); return true; }
            return false;
        }
        if (msg === MSG.UNKD) { this.kill(); return true; }
        if (!(this.isState(STATE_NORMAL) || this.isState(GS.HOLDING) || this.isState(RFS.LIVING))) return false;
        this.pick(a);
        let res: boolean;
        if (MapObjGeneral.prototype.receiveMessage.call(this, a, msg)) res = true;
        else if (msg === MSG.TAKE && this.checkMapObjFlag(MOF.TAKEABLE)) { this.hold(a as TakeActor); res = true; }
        else if (a.isActorType(AT.MARIO) && !this.isActorType(AT.WATERMELON) && msg !== MSG.TAKE) { this.kicked(); res = true; }
        else res = false;
        if (msg === MSG.PUT && this.isState(STATE_NORMAL)) this.state = RFS.LIVING;
        return res;
    }
}

// ---------------------------------------------------------------- TEggYoshi
export class EggYoshi extends MapObjGeneral {
    /** unk148: the bubble showing the fruit it wants */
    bubble: MActor | null = null;
    /** unk14C: the fruit it wants (its actor type) */
    unk14C = 0;
    unk150: HitActor | null = null;
    constructor(w: World, name = 'ヨッシーの卵') { super(w, name); }
    getHitObjNumMax() { return 10; }
    decideRandomLoveFruit() {
        const w = this.world;
        if (w.map === 7 && (w as any).unk7D === 1) { this.unk14C = AT.FRUIT_PINE; return; }
        if (w.map === 3) { this.unk14C = AT.FRUIT_DURIAN; return; }
        if (w.map === 1 && this.name === 'ヨッシーの卵（影マリオ用）') { this.unk14C = AT.FRUIT_BANANA; return; }
        const r = Math.trunc(fr(4 * MsRandF()));
        this.unk14C = r === 0 ? AT.FRUIT_BANANA : r === 1 ? AT.FRUIT_PAPAYA : r === 2 ? AT.FRUIT_PINE : AT.FRUIT_COCONUT;
    }
    private btp(f: number) { const fc = this.bubble ? this.bubble.getFrameCtrl(ANM_BTP) : null; if (fc) fc.frame = f; }
    startBalloonAnim() {
        switch (this.unk14C) {
            case AT.FRUIT_BANANA: this.btp(1); break;
            case AT.FRUIT_DURIAN: this.btp(3); break;
            case AT.FRUIT_PAPAYA: this.btp(5); break;
            case AT.FRUIT_PINE: this.btp(7); break;
            case AT.FRUIT_COCONUT: this.btp(9); break;
        }
    }
    touchFruit(f: HitActor) {
        if (this.isState(0xE) || this.isState(GS.HOLDING)) return;
        if (this.unk14C === f.actorType) {
            this.startAnim(1);
            this.btp(11);
            this.rot.y = fr((360 / 65536) * matan(fr(f.pos.z - this.pos.z), fr(f.pos.x - this.pos.x)));
            this.state = 0xB;
            this.unk150 = f;
            this.world.sound(SE.SY_COLLECT_PRETTY);
        } else if (this.animIsFinished()) {
            this.startAnim(2);
            this.btp(12);
            this.world.sound(SE.SY_NOT_COLLECT_YOSHI);
            this.state = 0xD;
        }
    }
    touchActor(a: HitActor) {
        if (!this.isState(STATE_NORMAL) && !this.isState(0xD)) return;
        if (a.isActorType(AT.MARIO)) { const h = marioHeld(this.world); if (h && MapObjBase.isFruit(h)) this.touchFruit(h); }
        if (MapObjBase.isFruit(a)) this.touchFruit(a);
    }
    control() {
        MapObjBase.prototype.control.call(this);
        switch (this.state) {
            case 0xD: if (this.animIsFinished()) { this.startAnim(0); this.startBalloonAnim(); this.state = STATE_NORMAL; } break;
            case 0xB:
                if (this.animIsFinished()) {
                    this.startAnim(3);
                    // SMS_GetYoshi()->appearFromEgg(pos, rot.y, this): Yoshi isn't simulated
                    this.world.events.push({ t: this.world.tickCount, kind: 'yoshiHatch', data: { p: this.pos.clone(), yaw: this.rot.y, fruit: this.unk14C } });
                    this.state = 0xC;
                }
                break;
            case 0xC: if (this.animIsFinished()) { this.makeObjDead(); this.state = STATE_DEAD; } break;
            case 0xF: if (this.vel.y === 0) this.state = 0x10; break;
        }
    }
    perform(cue: number) {
        super.perform(cue);
        if (![0xC, STATE_DEAD, GS.HOLDING, GS.APPEARING, 0xE, 0xF, 0x10].includes(this.state) && this.bubble && (cue & 0x2)) this.bubble.frameUpdate();
    }
    startFruit() {
        this.receiveMessage(this, MSG.UNK10);
        if (this.isState(0) || this.isState(0xE) || this.isState(0xF) || this.isState(0x10)) this.receiveMessage(this, MSG.UNK10);
    }
    receiveMessage(a: HitActor, msg: number): boolean {
        if (msg === MSG.TAKE) { this.hold(a as TakeActor); return true; }
        if (msg === MSG.THROWN || msg === MSG.DETACH) { this.vel.y = 10; this.offLiveFlag(LF.UNK10); this.state = 0xF; return true; }
        if (msg === MSG.UNK10) {
            const vy = this.vel.y;
            this.makeObjAppeared();
            this.vel.y = vy;
            this.offLiveFlag(LF.UNK10);
            this.decideRandomLoveFruit();
            this.startBalloonAnim();
            this.state = STATE_NORMAL;
            return true;
        }
        if (msg === MSG.PUT) { this.makeObjAppeared(); this.decideRandomLoveFruit(); this.startBalloonAnim(); }
        return false;
    }
    load(s: Stream) {
        MapObjBase.prototype.load.call(this, s);
        // the save's flags: none set (see the file's head)
        const shadowMarioEvent = false, yoshiUnlocked = false, shine21 = false;
        if (this.individualName === 'eggYoshiEvent') {
            if (shadowMarioEvent) this.state = 0xE; else { this.makeObjDead(); return; }
        } else if (this.world.map === 1) { if (!yoshiUnlocked) { this.makeObjDead(); return; } }
        else if (!shine21) { this.makeObjDead(); return; }
        if (this.manager) {
            this.bubble = new MActor((this.manager.folder() + '/eggyoshi_fukidashi.bmd').toLowerCase(), this.manager.getMActorAnmData());
            this.bubble.setBck('eggyoshi_fukidashi_wait');
            this.bubble.setAnimation('eggyoshi_fukidashi', ANM_BTP);
            const fc = this.bubble.getFrameCtrl(ANM_BTP); if (fc) fc.rate = 0;
        }
        this.decideRandomLoveFruit();
        if (!this.isState(0xE)) this.startBalloonAnim();
    }
}

// fruit made by name (newUniqueObjByName / newAndRegisterObjByEventID 1000-1004)
const prevUnique = OBJ_MAKERS.unique;
OBJ_MAKERS.unique = (w, name) => {
    if (name === 'FruitCoconut' || name === 'FruitPine' || name === 'FruitDurian' || name === 'FruitPapaya' || name === 'FruitBanana') return new ResetFruit(w);
    return prevUnique ? prevUnique(w, name) : null;
};

// ---------------------------------------------------------------- TRandomFruit (MapObjBall.cpp)
/** One of the fruit at random: MsRandF() x 5 picks coconut, durian, papaya or pineapple (4: pineapple too). */
export class RandomFruit extends ResetFruit {
    constructor(w: World, name = 'ランダムフルーツ') { super(w, name); }
    initMapObj() {
        const n = Math.trunc(fr(MsRandF() * 5));
        this.individualName = ['FruitCoconut', 'FruitDurian', 'FruitPapaya', 'FruitPine'][n] || 'FruitPine';
        MapObjBall.prototype.initMapObj.call(this);   // (TMapObjBall's, not TResetFruit's)
    }
}
// ---------------------------------------------------------------- TCoverFruit
/** TCoverFruit: the pineapple lid on Sirena's pipe; Yoshi's tongue takes it and eating it (UNKB) clears the pipe. */
export class CoverFruit extends MapObjBase {
    constructor(w: World, name = 'フタのフルーツ') { super(w, name); }
    calcRootMatrix() {
        const t = this.holder ? this.holder.getTakingMtx() : null;
        if (t) {
            this.baseTR.set(t);
            this.pos.set(t[3], t[7], t[11]);
        } else MsMtxSetXYZRPH(this.baseTR, this.pos.x, fr(this.pos.y - this.yOffset), this.pos.z, this.rot.x, this.rot.y, this.rot.z);
        this.anmMtx0 = null;
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (sender.isActorType(AT.YOSHI_TONGUE) && msg === MSG.TAKE) { this.onHitFilter(HF.NO_COLLISION); this.holder = sender as TakeActor; return true; }
        if (msg === MSG.UNKB) {
            this.kill();
            // TFlagManager MSF_SIRENA_PIPE_PINEAPPLE_EATEN
            this.world.flags.setBool(true, MSF.SIRENA_PIPE_PINEAPPLE_EATEN);
            return true;
        }
        return false;
    }
    loadAfter() { super.loadAfter(); if ((this.world as any).sirenaPipePineappleEaten) this.makeObjDead(); }
}

// ---------------------------------------------------------------- TBigWatermelon
// Gelato Beach's watermelons ("WaterMelon": お化けスイカ; the big one is スイカ（大）, Shine 6's,
// rolled to TGoalWatermelon in mamma.ts). It bursts (ten coins at most from each, a puff of
// water) on falling in water, on falling onto something after a Pokey launched it, or when
// Mario walks into its middle; a sand bomb base rising under it throws it up.
// TODO: the burst's water (gpModelWaterManager->emitRequest of /watermelon.prm's TWaterEmitInfo) isn't simulated.
export const BWS = { LAUNCHED: 0xB, LANDED: 0xC, GOAL: 0xD };
/** SMS_GetSandRiseUpRatio: the sand's root matrix's Y scale, 0 to 1 */
export function sandRiseUpRatio(a: any): number {
    const m: Mtx | null = a && typeof a.rootMtx === 'function' ? a.rootMtx() : null;
    let v = m ? m[5] : 0;
    if (v > 1) v = 1; else if (v < 0) v = 0;
    return v;
}
export class BigWatermelon extends MapObjBall {
    unk19C = 0;
    unk1A0 = 0;
    constructor(w: World, name = 'お化けスイカ') { super(w, name); }
    touchWaterSurface() {
        this.emit('columWater');   // emitColumnWater
        this.world.sound(SE.OBJ_DRINA_TO_WATER, this.pos);
        this.kill();
    }
    rebound(p: V3) {
        if (this.isState(BWS.LANDED)) { this.kill(); p.set(this.pos); }
        else {
            super.rebound(p);
            if (this.isState(BWS.LAUNCHED)) this.state = BWS.LANDED;
        }
    }
    touchActor(a: HitActor) {
        if (this.isState(GS.APPEARING)) return;
        if (!this.isState(STATE_NORMAL) && this.vel.y < 0) { this.kill(); return; }
        if (a.isActorType(AT.MARIO) && fr(Math.sqrt(sqDist(this.pos, a.pos))) < fr(this.bodyRadius * 0.6)) { this.kill(); return; }
        if (a.isActorType(AT.POI_HANA) && typeof (a as any).isMoving === 'function' && (a as any).isMoving()) {
            if (!(Math.abs(Math.trunc(this.vel.y)) < this.ph(0xC))) return;   // abs(int)
            this.vel.y = fr(this.vel.y + 30);
            this.state = BWS.LAUNCHED;
            return;
        }
        super.touchActor(a);
    }
    kill() {
        this.emit('watermelon_bomb'); this.emit('watermelon_bomb_a'); this.emit('watermelon_bomb_b');
        this.emit('watermelon_shrink_a'); this.emit('watermelon_shrink_b');
        this.world.sound(SE.OBJ_WATERMELON_BLOCK, this.pos);
        if (this.unk19C < 10) {
            const im = mapObjGlobals(this.world).itemManager as MapObjBaseManager | null;
            const o = im ? im.makeObjAppearAt(this.pos.x, this.pos.y, this.pos.z, AT.COIN, true) : null;
            if (o) { o.vel.set(0, 25, 0); o.offLiveFlag(LF.UNK10); ++this.unk19C; }
        }
        super.kill();
    }
    appearing() {
        super.appearing();
        // calcRootMatrix(), getModel()->calc(), then the root's Y raised by the (scaled) radius
        this.calcRootMatrix();
        this.anmMtx0 = null;
        const m = Float64Array.from(this.rootMtx());
        m[7] = fr(fr(this.bodyRadius * fr(this.scale.y / this.initialScale.y)) + this.pos.y);
        setRootMtx(this, m);
        this.scaledBodyRadius = fr(this.scale.x * 50);
        this.damageRadius = fr(this.scale.x * 50);
        this.calcEntryRadius();
        if (this.isState(STATE_NORMAL)) { this.actorType = AT.WATERMELON; this.attackRadius = fr(this.scale.x * 50); }
        else { this.actorType = AT.WATERMELON_STATIC; this.attackRadius = 0; }
        this.calcEntryRadius();
    }
    control() {
        super.control();
        switch (this.state) {
            case STATE_NORMAL: {
                if (this.checkLiveFlag(LF.UNK10)) this.offLiveFlag(LF.UNK10);
                const g = this.groundPlane.actor as any;
                if (this.pos.y < this.groundHeight + 200 && g && g.isActorType(AT.SAND_BOMB_BASE00)) {
                    const prev = this.unk1A0;
                    this.unk1A0 = sandRiseUpRatio(g);
                    if (this.unk1A0 > 0.05 && this.unk1A0 > prev) this.vel.y = fr(this.vel.y + 20);
                }
                break;
            }
            case BWS.GOAL:
                if (!this.isStateTimerEngaged()) {
                    this.emit('watermelon_shrink_a'); this.emit('watermelon_shrink_b');
                    this.stateTimer = 30;
                }
                if (this.animIsFinished()) this.makeObjDead();
                break;
        }
    }
    /** startEvent (EventWatcher's): the big one goes to the goal with its Shine's demo; any other one leaves ten coins at Mario */
    startEvent() {
        const w = this.world;
        if (this.name === 'スイカ（大）') {
            this.pos.set(-4660, 1300, 13600);
            this.offMapObjFlag(MOF.NO_ANIMATIONS);
            this.onLiveFlag(LF.UNK10);
            this.vel.zero();
            this.onLiveFlag(LF.UNK10);
            this.startAnim(7);
            w.events.push({ t: w.tickCount, kind: 'demoCamera', data: { name: 'スイカゴールカメラ', p: this.pos.clone() } });
            const im = mapObjGlobals(w).itemManager as any;
            if (im && im.makeShineAppearWithDemoOffset) im.makeShineAppearWithDemoOffset('シャイン（お化けスイカ用）', 'スイカシャインカメラ', 0, 0, 0);
            this.stateTimer = 380;
            this.state = BWS.GOAL;
        } else {
            const im = mapObjGlobals(w).itemManager as MapObjBaseManager | null;
            for (let i = 0; i < 10; i++) {
                const m = w.mario.pos;
                const it = im ? im.makeObjAppearAt(m.x, m.y, m.z, AT.COIN, true) : null;
                if (it) {
                    const rz = fr(20 * fr(MsRandF() - 0.5));
                    const ry = fr(fr(20 * MsRandF()) + 20);
                    it.vel.x = fr(20 * fr(MsRandF() - 0.5));
                    it.vel.y = ry;
                    it.vel.z = rz;
                    it.offLiveFlag(LF.UNK10);
                    (it as any).unk14C = 960;
                }
            }
            this.makeObjDead();
        }
    }
    checkWallCollision(p: V3) { MapObjGeneral.prototype.checkWallCollision.call(this, p); }
    receiveMessage(a: HitActor, msg: number): boolean {
        if (a.isActorType(AT.MARIO)) { this.boundByActor(a); return true; }
        return super.receiveMessage(a, msg);
    }
    loadAfter() {
        MapObjGeneral.prototype.loadAfter.call(this);
        const s = this.world.search('シャイン（お化けスイカ用）') as any;
        if (s && s.pos) s.pos.set(-4659, 460, 13620);
    }
}

register('CoverFruit', (w, n) => new CoverFruit(w, n));
register('RandomFruit', (w, n) => new RandomFruit(w, n));
register('Fruit', (w, n) => new ResetFruit(w, n));
register('ResetFruit', (w, n) => new ResetFruit(w, n));
register('EggYoshi', (w, n) => new EggYoshi(w, n));
register('WaterMelon', (w, n) => new BigWatermelon(w, n));
export type { Mtx };
