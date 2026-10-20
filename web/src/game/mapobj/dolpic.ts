// Delfino Plaza's own map objects (MoveBG/MapObjDolpic.cpp): the Shine monument (sprayed, it turns
// the way the water pushes it and fades; 1000 hits and its Shine comes out with its demo, and the
// monument spins round a few times and settles back), the two bells (TBellDolpic: 0 on the police
// station, 1 on the TV station: touched they swing about an axis away from Mario, sprayed 1000
// times they give their Shine and then ring on their own every 6-11 minutes), the Monte fence
// broken by being thrown into it, the Mare gate (gone until Noki Bay's open), the airport's turbo
// nozzle doors (dashed into, both halves break: in the plaza it plays its break BCK) and the demo
// cannon (the one firing Mario to Pinna Park). Also TMapObjSmoke (黒煙, scene class MapObjSmoke, the
// MapSmoke model: the black smoke over the plaza in the first episodes): a THideObjBase that, once
// sprayed, gives its hidden object (appearObj 100 above it) and goes (makeObjDead).
//
// Not here: particles, rumble, camera shake, the KColor fade (drawing only: unk138's alpha is kept),
// the smoke's particle (emitAndRotateScale(0x152) each control), the demo cannon's shared parts (its dome and the flying
// Mario: TSharedParts) and the voice; TFlagManager's save flags (world fields, unset: none set yet).

import { fr, V3, mtx, MsSin, MsAngleDiff, rand } from '../math.js';
import { World, HitActor, HF, ANM_BCK, CUE_CALC_ANIM } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { MapObjBase, mapObjGlobals } from './base.js';
import { HideObjBase } from './hide.js';
import type { ItemManager } from './item.js';
import { MTXConcat, MTXRotAxisRad, normalize, marioStatus } from './lib.js';

const EPSILON = fr(3.81469727e-06);
const UP = new V3(0, 1, 0);
import { MSF } from '../flags.js';
const itemManager = (w: World) => mapObjGlobals(w).itemManager as ItemManager | null;
/** SMS_IsMarioStatusThrownDown: MARIO_STATUS_THROWN_DOWN (0x208B8; the ghost's proxy never is) */
const marioThrownDown = (w: World) => marioStatus(w) === 0x208B8;
/** SMS_IsMarioDashing: MARIO_FLAG_FLUDD_EMITTING (0x4000); the proxy: spraying with the turbo nozzle */
function marioDashing(w: World) {
    const m = w.mario as any;
    if (typeof m.mStatus === 'number') return typeof m.checkFlag === 'function' ? !!m.checkFlag(0x4000) : false;
    return !!(m.fludd && m.fludd.spraying && m.fludd.nozzle === 5);
}

// ---------------------------------------------------------------- TMonumentShine
export class MonumentShine extends MapObjBase {
    /** the KColor's alpha (100 → 0 as it's sprayed) */
    unk138a = 0;
    /** water hits left */
    unk13C = 1000;
    /** spin speed */
    unk140 = 0;
    /** turns made after the Shine */
    unk144 = 0;
    /** the last spin direction (1 / -1) */
    unk148 = 1;
    /** already got (MSF_SHINE_SHINE_GATE): still */
    unk149 = 0;
    constructor(w: World, name = 'モニュメントシャイン') { super(w, name); }
    initMapObj() {
        super.initMapObj();
        if (this.world.flags.getBool(MSF.SHINE_SHINE_GATE)) { this.unk138a = 0; this.unk13C = 0; this.unk149 = 1; }
        else { this.unk138a = 100; this.unk13C = 1000; this.unk149 = 0; }
        this.offHitFilter(HF.NO_COLLISION);
    }
    hitByWater(a: HitActor) {
        const wd = new V3(fr(a.pos.x - this.pos.x), 0, fr(a.pos.z - this.pos.z));
        if (fr(wd.squared()) <= EPSILON) return;
        const m = this.world.mario.pos;
        const md = new V3(fr(m.x - this.pos.x), 0, fr(m.z - this.pos.z));
        if (fr(md.squared()) <= EPSILON) return;
        const c = new V3().cross(UP, md);
        if (fr(c.dot(wd)) > 0) this.unk140 = fr(this.unk140 + fr(0.004));
        else this.unk140 = fr(this.unk140 - fr(0.004));
    }
    receiveMessage(sender: HitActor, _msg: number): boolean {
        if (!sender.isActorType(AT.WATER)) return false;
        this.world.sound(SE.EN_COMMON_W_HIT_OK, sender.pos);
        if (this.unk13C === 0) return true;
        this.unk13C--;
        this.hitByWater(sender);
        this.unk138a = Math.trunc(this.unk13C * 100 / 1000) & 0xFF;
        if (this.unk13C === 0) {
            const im = itemManager(this.world);
            if (im) im.makeShineAppearWithDemo('シャイン（モニュメントシャイン用）', 'モニュメントシャインカメラ', this.pos.x, this.pos.y, this.pos.z);
            this.world.sound(SE.SY_CLEAR_SIGN);
        }
        return true;
    }
    control() {
        super.control();
        if (this.unk149) return;
        if (this.unk144 >= 3) return;
        this.unk140 = fr(this.unk140 * fr(0.9992));
        this.rotDelta.y = fr(this.rotDelta.y + this.unk140);
        if (this.unk13C > 0) { this.unk148 = this.unk140 > 0 ? 1 : -1; return; }
        if (Math.abs(this.unk140) < fr(0.1)) {
            if (this.unk144 === 2) {
                if (this.unk148 > 0) {
                    let d = fr(MsAngleDiff(fr(this.initialRot.y + 360), this.rot.y));
                    if (d > fr(0.1)) d = fr(0.1);
                    if (d === 0) this.unk144++;
                    this.rotDelta.y = fr(this.rotDelta.y + d);
                } else {
                    let d = fr(MsAngleDiff(fr(this.initialRot.y - 360), this.rot.y));
                    if (d < fr(-0.1)) d = fr(-0.1);
                    if (d === 0) this.unk144++;
                    this.rotDelta.y = fr(this.rotDelta.y + d);
                }
            } else if (this.unk148 > 0) {
                this.rotDelta.y = fr(this.rotDelta.y + fr(0.1));
                while (fr(this.rot.y + this.rotDelta.y) > 360) { this.rot.y = fr(this.rot.y - 360); this.unk144++; }
            } else {
                this.rotDelta.y = fr(this.rotDelta.y - fr(0.1));
                while (fr(this.rot.y + this.rotDelta.y) < 0) { this.rot.y = fr(this.rot.y + 360); this.unk144++; }
            }
        } else {
            let r = this.rot.y;
            while (r >= 360) r = fr(r - 360);
            while (r < 0) r = fr(r + 360);
            this.rot.y = r;
        }
    }
}

// ---------------------------------------------------------------- TBellDolpic
export class BellDolpic extends MapObjBase {
    unk138a = 0;
    /** 0 the police station's, 1 the TV station's */
    unk13C: number;
    /** the swing axis */
    unk140 = new V3(1, 0, 0);
    /** swing angle (degrees), its speed */
    unk14C = 0; unk150 = 0;
    /** water hits left */
    unk154 = 1000;
    /** frames to the next ring of its own (after its Shine) */
    unk158 = 0;
    /** which note next */
    unk15C = 0;
    constructor(w: World, n: string, kind: number) { super(w, n || 'ドルピック鐘'); this.unk13C = kind; }
    initMapObj() {
        super.initMapObj();
        const w = this.world;
        if ((this.unk13C === 0 && w.flags.getBool(MSF.SHINE_RIGHT_BELL)) || (this.unk13C === 1 && w.flags.getBool(MSF.SHINE_LEFT_BELL))) { this.unk138a = 0; this.unk154 = 0; }
        else { this.unk138a = 100; this.unk154 = 1000; }
        this.offHitFilter(HF.NO_COLLISION);
    }
    calcRootMatrix() {
        super.calcRootMatrix();
        const t = mtx();
        MTXRotAxisRad(t, this.unk140, fr(this.unk14C * (Math.PI / 180)));
        MTXConcat(this.baseTR, t, this.baseTR);
    }
    ring(p: V3) {
        if (Math.abs(this.unk150) > fr(0.01)) return;
        const d = new V3(fr(this.pos.x - p.x), 0, fr(this.pos.z - p.z));
        this.unk140.set(fr(UP.y * d.z - UP.z * d.y), fr(UP.z * d.x - UP.x * d.z), fr(UP.x * d.y - UP.y * d.x));
        if (fr(this.unk140.squared()) <= EPSILON) this.unk140.set(1, 0, 0);
        else normalize(this.unk140);
        this.unk150 = fr(this.unk150 - 0.5);
        const tmp = fr(rand() * fr(0.000030517578));
        this.unk158 = Math.trunc(fr(tmp * 14400)) + 0x5460;
    }
    touchPlayer(a: HitActor) { this.ring(a.pos); }
    receiveMessage(sender: HitActor, _msg: number): boolean {
        if (sender.isActorType(AT.MARIO)) this.ring(sender.pos);
        if (!sender.isActorType(AT.WATER)) return false;
        if (this.unk154 === 0) return true;
        this.unk154--;
        this.unk138a = Math.trunc(this.unk154 * 100 / 1000) & 0xFF;
        if (this.unk154 === 0) {
            const im = itemManager(this.world);
            if (im) {
                if (this.unk13C === 0) im.makeShineAppearWithDemo('シャイン（ドルピック鐘警察署用）', 'ドルピック鐘警察署カメラ', this.pos.x, this.pos.y, this.pos.z);
                else im.makeShineAppearWithDemo('シャイン（ドルピック鐘テレビ局用）', 'ドルピック鐘テレビ局カメラ', this.pos.x, this.pos.y, this.pos.z);
            }
            this.world.sound(SE.SY_CLEAR_SIGN);
        }
        return true;
    }
    control() {
        if (this.unk154 === 0) {
            if (this.unk158 === 0) this.ring(new V3(this.pos.x, this.pos.y, fr(this.pos.z + 100)));
            else this.unk158--;
        }
        super.control();
        const s = fr(-MsSin(this.unk14C));
        this.unk150 = fr(fr(0.01) * s + this.unk150);
        this.unk14C = fr(this.unk14C + this.unk150);
        if (this.unk14C < -30 || this.unk14C > 30) {
            this.unk150 = -this.unk150;
            if (this.unk154 === 0) this.world.sound(this.unk15C ? SE.OBJ_DOL_BEL_GS4 : SE.OBJ_DOL_BEL_E4, this.pos);
            else this.world.sound(this.unk15C ? SE.OBJ_DOL_BEL_GS4_K : SE.OBJ_DOL_BEL_E4_K, this.pos);
            this.unk15C ^= 1;
        }
        this.unk150 = fr(this.unk150 * fr(0.9995));
    }
}

// ---------------------------------------------------------------- TDptMonteFence
export class DptMonteFence extends MapObjBase {
    constructor(w: World, name = '投げモンテフェンス') { super(w, name); }
    touchPlayer(_a: HitActor) {
        if (!marioThrownDown(this.world)) return;
        this.world.sound(SE.IT_BARREL_CRASH, this.pos);
        this.world.sound(SE.OBJ_GLASS_BREAK, this.pos);
        this.kill();
    }
}

// ---------------------------------------------------------------- TMareGate
export class MareGate extends MapObjBase {
    constructor(w: World, name = 'マーレゲート') { super(w, name); }
    control() { super.control(); this.world.sound(SE.OBJ_MAHRE_GATE_LIGHT, this.pos); }
    loadAfter() {
        super.loadAfter();
        // MSF_NOKI_AVAILABLE: set by setupObjects in Delfino's scenarios 2 / 8 with >= 20 Shines (flags.ts)
        if (!this.world.flags.getBool(MSF.NOKI_AVAILABLE)) this.makeObjDead();
    }
}

// ---------------------------------------------------------------- TDemoCannon
export class DemoCannon extends MapObjBase {
    unk14C = 0;
    constructor(w: World, name = 'デモ砲台') { super(w, name); }
    /** loadAfter: only its particles (not here); not TMapObjBase's */
    loadAfter() { }
    initMapObj() {
        super.initMapObj();
        if (!this.mactor) return;
        this.mactor.setBck('democannon_dpt');
        const fc = this.mactor.getFrameCtrl(ANM_BCK);
        if (fc) fc.frame = fc.end;
    }
    /** startDemo (TMarDirector's demo to Pinna Park) */
    startDemo() {
        this.unk14C = 1;
        if (this.mactor) this.mactor.setBck('democannon_dpt');
        // TODO: the dome's and the flying Mario's BCKs (TSharedParts), Mario's voice
    }
    perform(cue: number) {
        super.perform(cue);
        if (!this.unk14C || !(cue & CUE_CALC_ANIM)) return;
        // TODO: the shared parts' frame (the flying Mario's: < 174 cannon move sound, 174 fire) isn't simulated
    }
}

// ---------------------------------------------------------------- TTurboNozzleDoor
export class TurboNozzleDoor extends MapObjBase {
    unk138 = new V3();
    /** the other half */
    unk144: MapObjBase | null = null;
    constructor(w: World, name = 'ターボノズルドア') { super(w, name); }
    /** loadAfter: the other half, by name (not TMapObjBase's) */
    loadAfter() {
        const pair: Record<string, string> = { '空港ドアＡ０': '空港ドアＡ１', '空港ドアＡ１': '空港ドアＡ０', '空港ドアＢ０': '空港ドアＢ１', '空港ドアＢ１': '空港ドアＢ０' };
        const other = pair[this.name];
        if (other) this.unk144 = this.world.search(other) as MapObjBase | null;
    }
    touchPlayer(_a: HitActor) {
        if (!marioDashing(this.world)) return;
        if (this.world.map === 1) this.startBck('nozzledoor');
        else { this.makeObjDead(); if (this.unk144) this.unk144.makeObjDead(); }
        this.world.sound(SE.IT_BARREL_CRASH, this.pos);
        this.world.sound(SE.OBJ_GLASS_BREAK, this.pos);
        this.unk138.set(this.pos.x, fr(this.pos.y + 100), this.pos.z);
        this.removeMapCollision();
        this.onHitFilter(HF.NO_COLLISION);
    }
}

// ---------------------------------------------------------------- TMapObjSmoke
export class MapObjSmoke extends HideObjBase {
    constructor(w: World, name = '黒煙') { super(w, name); }
    touchWater(_a: HitActor) { this.appearObj(100); this.makeObjDead(); return 1; }
    /** control: only emitAndRotateScale(0x152, 1, &mPosition) (the smoke particle: drawing), not TMapObjBase's touchActor */
    control() { }
}

register('MapObjSmoke', (w, n) => new MapObjSmoke(w, n));
register('MonumentShine', (w, n) => new MonumentShine(w, n));
register('BellDolpicTV', (w, n) => new BellDolpic(w, n, 1));
register('BellDolpicPolice', (w, n) => new BellDolpic(w, n, 0));
register('DptMonteFence', (w, n) => new DptMonteFence(w, n));
register('MareGate', (w, n) => new MareGate(w, n));
register('GateShell', (w, n) => new MareGate(w, n));
register('DemoCannon', (w, n) => new DemoCannon(w, n));
register('TurboNozzleDoor', (w, n) => new TurboNozzleDoor(w, n));
