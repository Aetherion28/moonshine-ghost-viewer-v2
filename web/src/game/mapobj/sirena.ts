// Sirena Beach / Hotel Delfino / the casino's own map objects (MoveBG/MapObjSirena.cpp):
// - TRoulette / TCasinoRoulette: the roulette floor; its switch (TRouletteSw, a hit actor on joint 1)
//   ground-pounded stops it turning (in the boss Boo's room, stage 14 episode 1, it sinks instead);
// - TSirenaRollMapObj's subclasses, whose joints 1..n each roll by their own angle (partsRollCallback):
//   TSlotDrum (the casino's slot machine: spray its three drums, three 7s give the fanfare),
//   TItemSlotDrum (the hotel's one: sprayed, its drums spin and stop on their own, forecasting a result
//   that gives coins, a Boo or nothing), TCasinoPanelGate (the panel puzzle: spray the 16 panels until
//   all show their back, then it opens) and TCloset (four doors to turn to their front; then it opens);
// - TDonchou (the curtain that rises once both slot machines have hit), TSakuCasino (the fence that
//   sinks once the panel gate's open), TChestRevolve (sprayed, it revolves), TPanelRevolve (hit or
//   ground-pounded, it revolves), TPictureTelesa (the Boo painting: a TWaterHitPictureHideObj that
//   laughs when it's done and vanishes the Boo near it), TWarpAreaActor (the area that switches the
//   map's model as Mario goes up or down through it), TSirenabossWall / TSirenaCasinoRoof / TSirenaGate.
//
// Not here: the switch materials' and neon TEV colours (kept in the members, drawing only), TMultiBtk
// (the walls' and roof's BTKs), the anm sounds (closetopen.bas), the BGM (told as a 'bgm' event), the
// demo camera (a 'demoCamera' event), the pad lock while the roulette sinks (TMarioGamePad isn't in the
// sim) and the joints' rolls on top of a playing BCK (the viewer's joint locals replace the animated
// ones, so they're dropped while one plays).

import { mat4 } from 'gl-matrix';
import { fr, V3, Mtx, mtx, MsMtxSetRotRPH, MsMtxSetXYZRPH, MsRandF } from '../math.js';
import { World, Stream, HitActor, HC, HF, MSG, ANM_BCK, ANM_BRK, CUE_MOVE } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { Skeleton, jointMatrices } from '../skeleton.js';
import { MapObjBase, STATE_NORMAL, mapObjGlobals, newAndRegisterObj } from './base.js';
import type { ItemManager } from './item.js';
import { ObjCollision, KIND_WARP } from './objcol.js';
import { WaterHitPictureHideObj, PS } from './hide.js';
import { MsMtxSetRotY, normalize, restJointMtx, marioGroundLevel, marioSpeedY } from './lib.js';
import type { Telesa } from '../enemies/telesa.js';

/** TMsRange<f32>::rand */
const rangeF = (lo: number, hi: number) => fr(lo + fr(fr(hi - lo) * MsRandF()));
/** TMsRange<s32>::rand */
const rangeI = (lo: number, hi: number) => lo + Math.trunc(fr((hi - lo) * MsRandF()));
const bgm = (w: World, name: string, p: V3) => w.events.push({ t: w.tickCount, kind: 'bgm', data: { name, p: p.clone() } });
/** MTXMultVec with a rotation */
const rotVec = (m: Mtx, v: V3) => new V3(fr(m[0] * v.x + m[1] * v.y + m[2] * v.z + m[3]), fr(m[4] * v.x + m[5] * v.y + m[6] * v.z + m[7]), fr(m[8] * v.x + m[9] * v.y + m[10] * v.z + m[11]));
const dist = (a: V3, b: V3) => fr(Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2));
/** model->setBaseTRMtx(MsMtxSetXYZRPH(pos + (0, dy, 0), rot)) and setBaseScale(mScaling) */
const setBase = (o: MapObjBase, dy: number) => { MsMtxSetXYZRPH(o.baseTR, o.pos.x, fr(o.pos.y + dy), o.pos.z, o.rot.x, o.rot.y, o.rot.z); o.anmMtx0 = null; };

// ---------------------------------------------------------------- TRoulette
export class RouletteSw extends HitActor {
    unk6C = 0;
    constructor(public unk68: Roulette, name = 'ルーレットスイッチ') { super(name); }
    receiveMessage(_s: HitActor, msg: number) { if (msg === MSG.HIP_DROP) { this.unk6C = 1; return true; } return false; }
    perform(_cue: number) { this.unk68.switchStop(); }
}
export class Roulette extends MapObjBase {
    /** unk13C its turning speed, unk140 sinking, unk141 the boss room's (it sinks), unk142 it turns, unk148 the switch's colour */
    unk138 = 500; unk13C = 0; unk140 = 0; unk141 = 0; unk142 = 0; unk144 = fr(0.2);
    unk148 = { r: 0, g: 0, b: 0, a: 255 };
    unk150: RouletteSw | null = null;
    constructor(w: World, name = 'ルーレット') {
        super(w, name);
        if (w.map === 14 && w.stage === 1) { this.unk141 = 1; this.unk148.b = 255; }
        if (w.map === 56) { this.unk148.b = 255; this.unk142 = 1; }
    }
    initMapObj() {
        this.pos.y = fr(this.pos.y + 500);
        super.initMapObj();
        // (the "_switch" materials' TEV colour is unk148)
        const sw = this.unk150 = new RouletteSw(this, 'ルーレットスイッチ');
        this.world.addToGroup('オブジェクトグループ', sw);
        let r = 500, h = 100;
        if (this.world.map === 14) { r = 40; h = 80; }
        sw.initHitActor(AT.CASINORULET, 2, HC.PLAYER, r, h, r, h);
        sw.offHitFilter(HF.NO_COLLISION);
    }
    perform(cue: number) { super.perform(cue); if (this.unk150) this.unk150.perform(cue); }
    moveObject() {
        super.moveObject();
        if (this.unk142 !== 0) this.rot.y = fr(this.rot.y + this.unk13C);
        if (this.unk141 !== 0 && this.unk140 !== 0) {
            // TODO: gpMarioOriginal->mGamePad->onNeutralMarioKey(), mDisabledFrames = 5 (no pad in the sim)
            this.world.sound(SE.BS_TELESA_RLT_DOWN, this.pos);
            this.pos.y = fr(this.pos.y - 1);
        }
        const j = restJointMtx(this, 1);
        if (this.unk150) this.unk150.pos.set(j ? j[3] : this.pos.x, fr(this.pos.y - 100), j ? j[11] : this.pos.z);
    }
    calcRootMatrix() { setBase(this, 0); }
    setRollSp(sp: number) { this.unk13C = sp; this.unk148.r = 0; this.unk148.g = 0; this.unk148.b = 255; if (this.unk150) this.unk150.unk6C = 0; }
    switchStop() {
        const sw = this.unk150;
        if (!sw || sw.unk6C === 0) return;
        if (this.world.mario.pos.y < fr(20 + marioGroundLevel(this.world)) && this.unk13C !== 0) {
            sw.unk6C = 0; this.unk13C = 0;
            this.unk148.r = 0; this.unk148.g = 0; this.unk148.b = 0;
            this.world.sound(SE.BS_TELESA_RLT_STOP, this.pos);
        }
        if (sw.unk6C !== 0 && this.unk141 !== 0) {
            sw.unk6C = 0;
            this.unk148.r = 0; this.unk148.g = 0; this.unk148.b = 0;
            this.world.sound(SE.BS_TELESA_RLT_STOP, this.pos);
            this.unk140 = 1;
        }
    }
}
export class CasinoRoulette extends Roulette { constructor(w: World, name = 'カジノルーレット') { super(w, name); } }

// ---------------------------------------------------------------- TSirenaRollMapObj
const restLocalCache = new WeakMap<Skeleton, mat4[]>();
function restLocals(sk: Skeleton): mat4[] {
    let L = restLocalCache.get(sk);
    if (L) return L;
    const W = jointMatrices(sk, null, 0, mtx(), [1, 1, 1]), inv = mat4.create();
    L = [];
    for (const j of sk.order) {
        const p = sk.parent[j];
        if (p >= 0) mat4.invert(inv, W[p]); else mat4.identity(inv);
        L[j] = mat4.mul(mat4.create(), inv, W[j]);
    }
    restLocalCache.set(sk, L);
    return L;
}
export class SirenaRollMapObj extends MapObjBase {
    /** unk138 each joint's roll speed, unk13C its angle, unk140 / unk144 the hit's sizes, unk148 how many,
     * unk14C the model's Y offset, unk150 the start Y, unk154 a spray's push, unk158 the top speed, unk15C the slowing,
     * unk160 the speed it settles below, unk164 the push's sign */
    unk138: number[] = []; unk13C: number[] = []; unk140 = 0; unk144 = 0; unk148 = 0;
    unk14C = 0; unk150 = 0; unk154 = 1; unk158 = 10; unk15C = fr(0.1); unk160 = fr(0.2); unk164 = 1;
    constructor(w: World, name = 'SirenaRollMapObj') { super(w, name); }
    getRollAngX(_i: number) { return 0; }
    getRollAngY(_i: number) { return 0; }
    getRollAngZ(_i: number) { return 0; }
    protected initRollArrays(ang: (i: number) => number) {
        this.unk138 = []; this.unk13C = [];
        for (let i = 0; i < this.unk148; i++) { this.unk138[i] = 0; this.unk13C[i] = ang(i); }
    }
    /** partsRollCallback on joints 1..unk148: the joint times its roll (RPH) times the scale; for the viewer, as the joints' locals */
    protected rollJoints() {
        const a = this.mactor;
        if (!a) return;
        if (a.getCurAnmIdx(ANM_BCK) >= 0) { (this as any).locals = undefined; return; }
        const sk = Skeleton.of(a.data.files.scene(a.model));
        if (!sk) return;
        const R = restLocals(sk), L: mat4[] = [];
        for (let j = 1; j <= this.unk148 && j < sk.names.length; j++) {
            const i = j - 1, r = mtx();
            MsMtxSetRotRPH(r, this.getRollAngX(i), this.getRollAngY(i), this.getRollAngZ(i));
            const rm = mat4.fromValues(r[0], r[4], r[8], 0, r[1], r[5], r[9], 0, r[2], r[6], r[10], 0, 0, 0, 0, 1);
            L[j] = mat4.mul(mat4.create(), R[j], rm);
            mat4.scale(L[j], L[j], [this.scale.x, this.scale.y, this.scale.z]);
        }
        (this as any).locals = L;
    }
    /** a spray's push on joint idx */
    protected push(idx: number) {
        this.unk138[idx] = fr(this.unk138[idx] + fr(this.unk154 * this.unk164));
        if (Math.abs(this.unk138[idx]) > this.unk158) this.unk138[idx] = fr(this.unk158 * this.unk164);
    }
    /** the angle on by the speed, wrapped into (0, 360): whether it wrapped */
    protected turn(i: number) {
        this.unk13C[i] = fr(this.unk13C[i] + this.unk138[i]);
        let wrapped = false;
        if (this.unk13C[i] >= 360) { this.unk13C[i] = fr(this.unk13C[i] - 360); wrapped = true; }
        if (this.unk13C[i] <= 0) { this.unk13C[i] = fr(this.unk13C[i] + 360); wrapped = true; }
        return wrapped;
    }
    protected slow(i: number) { this.unk138[i] = this.unk138[i] > 0 ? fr(this.unk138[i] - this.unk15C) : fr(this.unk138[i] + this.unk15C); }
}

// ---------------------------------------------------------------- TSlotDrum
export class SlotDrum extends SirenaRollMapObj {
    /** unk168 a face's angle, unk170 the neons' colours, unk188 each drum's angle since its last click, unk194 hit (three 7s) */
    unk168 = 90; unk16C = 0;
    unk170 = [0, 1, 2].map(() => ({ r: 120, g: 230, b: 255, a: 255 }));
    unk188 = [0, 0, 0]; unk194 = false;
    constructor(w: World, name = 'スロットマシーン') { super(w, name); }
    getRollAngX(i: number) { return this.unk13C[i]; }
    initMapObj() {
        this.unk148 = 3; this.unk14C = 400; this.unk150 = this.pos.y; this.unk194 = false;
        this.unk154 = 2; this.unk158 = 10; this.unk15C = fr(0.1); this.unk160 = 0.5; this.unk164 = 0; this.unk168 = 90;
        this.initRollArrays((i) => 90 * (i + 1));
        for (let i = 0; i < this.unk148; i++) this.unk188[i] = 0;
        super.initMapObj();
        this.unk140 = fr(this.damageRadius / 3);
        this.unk144 = this.damageHeight;
        this.initNeonMatColor();
    }
    /** initNeonMatColor: _NEON_C, _NEON_B, _NEON_A's TEV colour */
    initNeonMatColor() { for (let i = 0; i < 3; i++) this.unk170[i] = { r: 120, g: 230, b: 255, a: 255 }; }
    moveObject() {
        super.moveObject();
        this.pos.y = fr(this.unk150 + this.unk14C);
        const face = this.unk168;
        for (let i = 0; i < this.unk148; i++) {
            if (this.unk138[i] === 0) continue;
            this.unk188[i] = fr(this.unk188[i] + Math.abs(this.unk138[i]));
            if (this.unk188[i] > fr(360 / face)) {
                this.unk188[i] = 0;
                this.world.sound([SE.OBJ_SLOT_INC_L, SE.OBJ_SLOT_INC_C, SE.OBJ_SLOT_INC_R][i], this.pos);
            }
            if (Math.abs(this.unk138[i]) > this.unk160) {
                this.unk13C[i] = fr(this.unk13C[i] + this.unk138[i]);
                this.slow(i);
                if (this.unk13C[i] >= 360) this.unk13C[i] = fr(this.unk13C[i] - 360);
                if (this.unk13C[i] <= 0) this.unk13C[i] = fr(this.unk13C[i] + 360);
            } else {
                this.turn(i);
                if (Math.trunc(Math.abs(this.unk13C[i])) % face === 0) {
                    this.unk138[i] = 0;
                    if (this.unk13C[i] < face) {
                        this.unk170[i].r = 255; this.unk170[i].g = 255; this.unk170[i].b = 70;
                        this.world.sound(SE.SY_COLLECT_DELIGHT, this.pos);
                    } else { this.unk170[i].r = 120; this.unk170[i].g = 230; this.unk170[i].b = 255; }
                    if (this.unk13C[i] < face || this.unk13C[i] >= 360) {
                        for (let j = 0; j < this.unk148; j++) {
                            if (i === j) continue;
                            if (this.unk138[j] !== 0 || (this.unk13C[j] >= face && this.unk13C[j] < 360)) return;
                        }
                        bgm(this.world, 'MSD_BGM_FANFARE_RACE', this.pos);
                        this.unk194 = true;
                    }
                }
            }
        }
    }
    calcRootMatrix() { setBase(this, -this.unk14C); this.rollJoints(); }
    /** which drum the spray hit (by its Z across the machine), pushed */
    touchWater(a: HitActor): number {
        if (this.unk194) return 1;
        if (Math.abs(this.pos.x - a.pos.x) < 150) {
            const half = fr(0.6 * this.unk140);
            let idx: number;
            if (a.pos.z < fr(this.pos.z - half)) idx = this.rot.y < 0 ? 0 : 2;
            else if (a.pos.z > fr(this.pos.z + half)) idx = this.rot.y < 0 ? 2 : 0;
            else idx = 1;
            this.unk164 = 1;
            this.push(idx);
            return 1;
        }
        return 0;
    }
}

// ---------------------------------------------------------------- TItemSlotDrum
export class ItemSlotDrum extends SlotDrum {
    /** unk198 the result it's aiming for, unk19C a drum to try stopping, unk19F a drum that keeps its speed,
     * unk1A2 ready for a spray, unk1A4 frames since the spray (0: none), unk1A8 the 7s' chance */
    unk198 = 0; unk19C = [false, false, false]; unk19F = [true, true, true]; unk1A2 = true; unk1A4 = 0; unk1A8 = 5;
    constructor(w: World, name = 'スロットマシーン') { super(w, name); }
    loadAfter() {
        MapObjBase.prototype.loadAfter.call(this);
        for (let i = 0; i < 6; i++) newAndRegisterObj(this.world, 'coin');
    }
    moveObject() {
        MapObjBase.prototype.moveObject.call(this);
        this.pos.y = fr(this.unk150 + this.unk14C);
        if (this.unk1A4 > 0) {
            this.unk1A4++;
            if (this.unk1A4 > 160) {
                this.unk1A4 = 0;
                this.unk19C[rangeI(0, 2)] = true;
                const v = rangeF(0, 100);
                if (v < this.unk1A8 && this.unk1A8 > 10) this.unk198 = 0;
                else if (v < 30) this.unk198 = 2;
                else if (v < 60) this.unk198 = 3;
                else this.unk198 = 1;
                this.unk1A8 = fr(this.unk1A8 + 2);
            }
        }
        const face = this.unk168;
        for (let i = 0; i < this.unk148; i++) {
            if (this.unk19C[i] && this.unk198 === this.getForcastResult(i)) { this.unk19C[i] = false; this.unk19F[i] = false; }
            if (this.unk138[i] === 0) continue;
            if (Math.abs(this.unk138[i]) > this.unk160) {
                this.unk13C[i] = fr(this.unk13C[i] + this.unk138[i]);
                if (!this.unk19F[i]) this.slow(i);
                if (this.unk13C[i] >= 360) this.unk13C[i] = fr(this.unk13C[i] - 360);
                if (this.unk13C[i] <= 0) this.unk13C[i] = fr(this.unk13C[i] + 360);
            } else {
                this.turn(i);
                if (!this.unk19F[i] && Math.trunc(Math.abs(this.unk13C[i])) % face === 0) {
                    this.unk13C[i] = face * Math.trunc(fr(this.unk13C[i] / face));
                    this.unk138[i] = 0;
                    this.world.sound(SE.BS_TELESA_SLT_STOP, this.pos);
                    let allStopped = true;
                    for (let k = 0; k < 3; k++) if (this.unk138[k] !== 0) allStopped = false;
                    if (allStopped) { this.unk1A2 = true; this.generateItem(); }
                    for (let j = 0; j < this.unk148; j++) {
                        if (this.unk19F[j]) { if (rangeF(0, 1) <= fr(0.9)) this.unk19C[j] = true; else this.unk19F[j] = false; }
                    }
                    if (this.unk13C[i] < face) {
                        this.unk170[i].r = 255; this.unk170[i].g = 255; this.unk170[i].b = 70;
                        this.world.sound(SE.SY_COLLECT_DELIGHT, this.pos);
                    } else { this.unk170[i].r = 120; this.unk170[i].g = 230; this.unk170[i].b = 255; }
                }
            }
        }
    }
    calcRootMatrix() {
        let spinning = false;
        for (let i = 0; i < 3; i++) if (this.unk138[i] !== 0) spinning = true;
        if (spinning) this.world.sound(SE.OBJ_SLOT_SPIN, this.pos);
        setBase(this, -this.unk14C);
        this.rollJoints();
    }
    touchWater(_a: HitActor): number {
        if (this.unk194 || !this.unk1A2) return 1;
        this.unk1A4 = rangeI(100, 150);
        for (let i = 0; i < this.unk148; i++) {
            this.unk19F[i] = true; this.unk19C[i] = false;
            this.unk138[i] = fr(this.unk158 * rangeF(0.5, 0.8));
        }
        this.unk1A2 = false;
        return 1;
    }
    /** 0: three 7s (the fanfare), 1: a Boo comes out at Mario, 2: three coins, 3: one, -1 (no match): nothing */
    generateItem() {
        const res = this.getSlotResult();
        if (res === 0) { bgm(this.world, 'MSD_BGM_FANFARE_RACE', this.pos); this.unk194 = true; return; }
        if (res === 1) {
            const t = this.world.conductor.makeOneEnemyAppear(this.pos, 'テレサマネージャー', 1) as Telesa | null;
            if (t) {
                const m = mtx(); MsMtxSetRotY(m, this.rot.y);
                const off = rotVec(m, new V3(0, -350, 300));
                t.pos.set(fr(t.pos.x + off.x), fr(t.pos.y + off.y), fr(t.pos.z + off.z));
                t.initItemAttacker(this);
            }
            return;
        }
        if (res !== -1) {
            let count = 1, spread = 0;
            if (res === 2) { count = 3; spread = 20; }
            const im = mapObjGlobals(this.world).itemManager as ItemManager | null;
            for (let i = 0; i < count; i++) {
                const m = mtx(); MsMtxSetRotY(m, fr(spread * i + fr(this.rot.y - spread)));
                const off = rotVec(m, new V3(0, -350, 200));
                const o = im ? im.makeObjAppearAt(fr(this.pos.x + off.x), this.pos.y, fr(this.pos.z + off.z), AT.COIN, false) : null;
                if (o) {
                    o.pos.set(fr(o.pos.x + off.x), fr(o.pos.y + off.y), fr(o.pos.z + off.z));
                    normalize(off);
                    o.vel.set(fr(12 * off.x), rangeF(5, 10), fr(12 * off.z));
                    o.offLiveFlag(0x10);   // (setVelocityAndFlag10: LIVE_FLAG_UNK10)
                }
            }
        } else this.world.sound(SE.SY_NOT_COLLECT, this.pos);
    }
    getSlotResult() {
        const r = this.getDrumResult(0);
        for (let i = 1; i < 3; i++) if (r !== this.getDrumResult(i)) return -1;
        return r;
    }
    getDrumResult(i: number) { return this.getResultFromAng(this.unk13C[i]); }
    /** where drum idx will stop from its angle and speed now */
    getForcastResult(idx: number) {
        let ang = this.unk13C[idx], sp = this.unk138[idx];
        const face = this.unk168;
        for (; ;) {
            if (Math.abs(sp) > this.unk160) {
                ang = fr(ang + sp);
                sp = sp > 0 ? fr(sp - this.unk15C) : fr(sp + this.unk15C);
                if (ang >= 360) ang = fr(ang - 360);
                if (ang <= 0) ang = fr(ang + 360);
            } else {
                ang = fr(ang + sp);
                if (ang >= 360) ang = fr(ang - 360);
                if (ang <= 0) ang = fr(ang + 360);
                if (Math.trunc(Math.abs(ang)) % face === 0) break;
            }
        }
        ang = Math.trunc(fr(ang / face)) * face;
        return this.getResultFromAng(ang);
    }
    getResultFromAng(a: number) { return a < 89 ? 0 : a < 179 ? 1 : a < 269 ? 2 : 3; }
}

// ---------------------------------------------------------------- TCasinoPanelGate
export class CasinoPanelGate extends SirenaRollMapObj {
    /** mMapCollisionWarp (never made), unk16C its clear sound's played, unk16D open */
    mMapCollisionWarp: ObjCollision | null = null; unk16C = false; unk16D = false;
    constructor(w: World, name = 'カジノパネルゲート') { super(w, name); }
    getRollAngX(i: number) { return this.unk13C[i]; }
    initMapObj() {
        this.unk148 = 16; this.unk14C = 410; this.unk150 = this.pos.y;
        this.unk154 = 4; this.unk158 = 15; this.unk15C = fr(0.2); this.unk160 = 1; this.unk164 = 0;
        this.initRollArrays(() => 0);
        super.initMapObj();
    }
    moveObject() {
        super.moveObject();
        this.pos.y = fr(this.unk150 - this.unk14C);
        if (this.unk16D) {
            const fc = this.mactor && this.mactor.getFrameCtrl(ANM_BCK);
            if (!fc) return;
            if (fc.frame < fr(fc.end - 8)) this.world.sound(SE.SY_PANELPUZZLE_OPEN, null);
            if (!this.unk16C && fc.checkPass(fr(fc.end - 2))) { this.unk16C = true; this.world.sound(SE.SY_CLEAR_SIGN_BIG, null); }
            return;
        }
        let allOpen = true;
        for (let i = 0; i < this.unk148; i++) {
            if (this.unk138[i] === 0) { if (this.unk13C[i] < 180) allOpen = false; continue; }
            allOpen = false;
            if (Math.abs(this.unk138[i]) > this.unk160) {
                this.unk13C[i] = fr(this.unk13C[i] + this.unk138[i]);
                this.slow(i);
                let wrapped = false;
                if (this.unk13C[i] >= 360) { this.unk13C[i] = fr(this.unk13C[i] - 360); wrapped = true; }
                if (this.unk13C[i] <= 0) { this.unk13C[i] = fr(this.unk13C[i] + 360); wrapped = true; }
                if (wrapped) this.world.sound(SE.OBJ_PANELPUZZLE_WIND, this.pos);
            } else {
                if (this.turn(i)) this.world.sound(SE.OBJ_PANELPUZZLE_WIND, this.pos);
                if (Math.trunc(Math.abs(this.unk13C[i])) % 180 === 0) {
                    this.unk13C[i] = this.unk13C[i] < 180 || this.unk13C[i] >= 360 ? 0 : 180;
                    this.unk138[i] = 0;
                }
            }
        }
        if (allOpen) {
            this.unk16D = true;
            if (this.mactor) this.mactor.setBck('pazul');
            bgm(this.world, 'MSD_BGM_FANFARE_RACE', this.pos);
            this.world.sound(SE.SY_COLLECT_DELIGHT, this.pos);
            this.removeMapCollision();
        }
    }
    calcRootMatrix() {
        setBase(this, this.unk14C);
        this.rollJoints();
        this.unk140 = fr(0.25 * this.damageRadius);
        this.unk144 = fr(0.25 * this.damageHeight);
    }
    /** the panel the spray hit: four rows (by height) of four (by X); the lower half of a row turns it back */
    touchWater(a: HitActor) {
        if (this.unk16D) return 1;
        if (Math.abs(this.pos.z - a.pos.z) < 50) {
            this.unk164 = 1;
            const p = a.pos, x = this.pos.x, y = this.pos.y, h = this.unk144, w = this.unk140;
            const col = (base: number) => p.x < fr(x - w) ? base : p.x < x ? base + 1 : p.x > fr(x + w) ? base + 3 : base + 2;
            let idx: number;
            if (p.y > fr(y + fr(h * 3))) { idx = col(12); if (p.y < fr(y + fr(h * 3.5))) this.unk164 = -1; }
            else if (p.y > fr(y + fr(h * 2))) { idx = col(8); if (p.y < fr(y + fr(h * 2.5))) this.unk164 = -1; }
            else if (p.y > fr(y + h)) { idx = col(4); if (p.y < fr(y + fr(h * 1.5))) this.unk164 = -1; }
            else { idx = col(0); if (p.y < fr(y + fr(h * 0.5))) this.unk164 = -1; }
            this.push(idx);
            return 1;
        }
        return 0;
    }
}

// ---------------------------------------------------------------- TDonchou
export class Donchou extends MapObjBase {
    /** unk138 its wall (Donchou.col), unk13C rising, unk140 (0), unk144 / unk148 the two slot machines, unk14C frames since both hit */
    unk138: ObjCollision | null = null; unk13C = 0; unk140 = 0;
    unk144: SlotDrum | null = null; unk148: ItemSlotDrum | null = null; unk14C = 0;
    constructor(w: World, name = 'パネルカーテン') { super(w, name); }
    initMapObj() {
        this.unk140 = 0; this.unk13C = 0; this.unk148 = null; this.unk144 = null;
        super.initMapObj();
        const m = mtx();
        MsMtxSetXYZRPH(m, this.pos.x, fr(2 * this.unk140 + this.pos.y), this.pos.z, this.rot.x, this.rot.y, this.rot.z);
        this.unk138 = new ObjCollision(this.world, KIND_WARP, this);
        this.unk138.init('/mapObj/Donchou', 0);
        this.unk138.setUpMtx(m);
    }
    loadAfter() {
        super.loadAfter();
        if (this.world.map === 14 && this.world.stage === 0) {
            this.unk144 = this.world.search('srotdram') as SlotDrum | null;
            this.unk148 = this.world.search('itemsrotdram') as ItemSlotDrum | null;
        }
    }
    calcRootMatrix() {
        setBase(this, this.unk140);
        if (this.unk144 && this.unk144.unk194 && this.unk148 && this.unk148.unk194) this.unk13C = 1;
        if (this.unk13C === 0) return;
        this.unk14C++;
        if (this.unk14C <= 100 || !this.mactor) return;
        if (this.mactor.checkCurAnm('donchou', ANM_BCK)) {
            if (this.mactor.curAnmEndsNext(ANM_BCK) && this.unk138) this.unk138.remove();
        } else {
            this.world.sound(SE.SY_DONCHO_OPEN, this.pos);
            this.mactor.setBck('donchou');
            this.world.events.push({ t: this.world.tickCount, kind: 'demoCamera', data: { name: 'どん帳カメラ', p: this.pos.clone() } });
            const fc = this.mactor.getFrameCtrl(ANM_BCK);
            if (fc) fc.rate = fr(0.5 * fc.rate);
        }
    }
    touchWater(a: HitActor) { return Math.abs(this.pos.z - a.pos.z) < 50 ? 1 : 0; }
}

// ---------------------------------------------------------------- TCloset
export class Closet extends SirenaRollMapObj {
    /** mMapCollisionWarp its front (Closet.col), unk16C all four doors right, unk16D frames since */
    mMapCollisionWarp: ObjCollision | null = null; unk16C = false; unk16D = 0;
    constructor(w: World, name = 'クローゼット') { super(w, name); }
    getRollAngY(i: number) { return this.unk13C[i]; }
    initMapObj() {
        this.unk148 = 4; this.unk14C = 0; this.unk150 = this.pos.y;
        this.unk154 = 2.5; this.unk158 = 8; this.unk15C = fr(0.1); this.unk160 = 0.5; this.unk164 = 0;
        this.unk16C = false; this.unk16D = 0;
        this.initRollArrays(() => 180);
        super.initMapObj();
        this.unk140 = fr(0.25 * this.damageRadius);
        this.unk144 = this.damageHeight;
        const m = mtx();
        MsMtxSetXYZRPH(m, this.pos.x, fr(2 * this.unk14C + this.pos.y), this.pos.z, this.rot.x, this.rot.y, this.rot.z);
        this.mMapCollisionWarp = new ObjCollision(this.world, KIND_WARP, this);
        this.mMapCollisionWarp.init('/mapObj/Closet', 0);
        this.mMapCollisionWarp.setUpMtx(m);
        // (initAnmSound)
    }
    moveObject() {
        super.moveObject();
        if (this.unk16C && this.mactor && !this.mactor.checkCurAnm('closetopen', ANM_BCK)) {
            this.unk16D = (this.unk16D + 1) & 0xFF;
            if (this.unk16D === 60) this.mactor.setBck('closetopen');   // (setAnmSound closetopen.bas)
            return;
        }
        for (let i = 0; i < this.unk148; i++) {
            if (this.unk138[i] === 0) continue;
            if (Math.abs(this.unk138[i]) > this.unk160) {
                this.unk13C[i] = fr(this.unk13C[i] + this.unk138[i]);
                this.slow(i);
                let wrapped = false;
                if (this.unk13C[i] >= 360) { this.unk13C[i] = fr(this.unk13C[i] - 360); wrapped = true; }
                if (this.unk13C[i] <= 0) { this.unk13C[i] = fr(this.unk13C[i] + 360); wrapped = true; }
                if (wrapped) this.world.sound(SE.OBJ_TEL_CLOSET_ROLL, this.pos);
            } else {
                if (this.turn(i)) this.world.sound(SE.OBJ_TEL_CLOSET_ROLL, this.pos);
                if (Math.trunc(Math.abs(this.unk13C[i])) % 180 === 0) {
                    this.unk138[i] = 0;
                    if (this.unk13C[i] <= 180 || this.unk13C[i] >= 360) {
                        for (let j = 0; j < this.unk148; j++) {
                            if (i === j) continue;
                            if (this.unk138[j] !== 0 || (this.unk13C[j] >= 180 && this.unk13C[j] < 360)) return;
                        }
                        this.unk16C = true;
                        this.world.sound(SE.SY_CLEAR_SIGN_BIG, null);
                    }
                }
            }
        }
    }
    calcRootMatrix() {
        setBase(this, this.unk14C);
        this.rollJoints();
        if (this.unk16C && this.mactor && this.mactor.checkCurAnm('closetopen', ANM_BCK) && this.mactor.curAnmEndsNext(ANM_BCK) && this.mMapCollisionWarp)
            this.mMapCollisionWarp.remove();
    }
    /** which door the spray hit (by its Z across the closet), pushed */
    touchWater(a: HitActor) {
        if (this.unk16C) return 0;
        if (Math.abs(this.pos.x - a.pos.x) < 50) {
            const half = fr(1.1 * this.unk140), back = this.rot.y < 0;
            let idx: number;
            if (a.pos.z < fr(this.pos.z - half)) idx = back ? 3 : 0;
            else if (a.pos.z < this.pos.z) idx = back ? 2 : 1;
            else if (a.pos.z < fr(this.pos.z + half)) idx = back ? 1 : 2;
            else idx = back ? 0 : 3;
            this.unk164 = 1;
            this.push(idx);
            return 1;
        }
        return 0;
    }
}

// ---------------------------------------------------------------- TSakuCasino
export class SakuCasino extends MapObjBase {
    /** unk138 its wall (SakuCasino.col), unk13C sinking, unk140 how far, unk144 the panel gate ("pazul") */
    unk138: ObjCollision | null = null; unk13C = 0; unk140 = 0; unk144: CasinoPanelGate | null = null;
    constructor(w: World, name = 'パネル柵') { super(w, name); }
    initMapObj() {
        this.unk140 = 0; this.unk13C = 0;
        super.initMapObj();
        const m = mtx();
        MsMtxSetXYZRPH(m, this.pos.x, fr(2 * this.unk140 + this.pos.y), this.pos.z, this.rot.x, this.rot.y, this.rot.z);
        this.unk138 = new ObjCollision(this.world, KIND_WARP, this);
        this.unk138.init('/mapObj/SakuCasino', 0);
        this.unk138.setUpMtx(m);
    }
    loadAfter() { super.loadAfter(); this.unk144 = this.world.search('pazul') as CasinoPanelGate | null; }
    calcRootMatrix() {
        setBase(this, this.unk140);
        if (this.unk144 && this.unk144.unk16D) { this.unk13C = 1; if (this.unk138) this.unk138.remove(); }
        if (this.unk13C !== 0) { this.unk140 = fr(this.unk140 - 1); this.scale.y = fr(this.scale.y * fr(0.99)); }
    }
}

// ---------------------------------------------------------------- the walls and roof (TMultiBtk: drawing only)
export class SirenabossWall extends MapObjBase {
    constructor(w: World, name = 'ボステレサ部屋壁') { super(w, name); }
    getSDLModelFlag() { return 0; }
}
export class SirenaCasinoRoof extends MapObjBase {
    constructor(w: World, name = 'カジノ部屋天井') { super(w, name); }
    getSDLModelFlag() { return 0; }
    initMapObj() { super.initMapObj(); if (this.mactor) this.mactor.setAnimation('casino_lighting', ANM_BRK); }
}
export class SirenaGate extends MapObjBase { constructor(w: World, name = 'シレナゲート') { super(w, name); } }

// ---------------------------------------------------------------- TWarpAreaActor
/** Mario in it going up: the map's model unk68; going down: unk6A (gpMap->changeModel: told as a 'changeModel' event) */
export class WarpAreaActor extends HitActor {
    unk68 = -1; unk6A = -1;
    constructor(public world: World, name = 'ワープエリア') { super(name); }
    load(s: Stream) {
        super.load(s);
        this.unk68 = (s.u32() << 16) >> 16;
        this.unk6A = (s.u32() << 16) >> 16;
        this.initHitActor(AT.WARP_AREA_ACTOR, 1, HC.PLAYER, fr(100 * this.scale.x), fr(100 * this.scale.y), 0, 0);
        this.offHitFilter(HF.NO_COLLISION);
        this.world.conductor.others.push(this);
    }
    perform(cue: number) {
        if (!(cue & CUE_MOVE) || this.collisions.length === 0) return;
        const w = this.world, vy = marioSpeedY(w);
        if (vy > 0 && this.unk68 !== -1) w.events.push({ t: w.tickCount, kind: 'changeModel', data: { model: this.unk68 } });
        if (vy < 0 && this.unk6A !== -1) w.events.push({ t: w.tickCount, kind: 'changeModel', data: { model: this.unk6A } });
    }
}

// ---------------------------------------------------------------- TChestRevolve / TPanelRevolve
const ST_REVOLVING = 2;
export class ChestRevolve extends MapObjBase {
    constructor(w: World, name = '回転棚') { super(w, name); }
    touchWater(_a: HitActor) {
        if (this.isState(STATE_NORMAL)) { this.state = ST_REVOLVING; this.startAnim(1); this.setUpMapCollision(1); }
        return 1;
    }
    control() {
        super.control();
        if (this.state === ST_REVOLVING && this.animIsFinished()) { this.state = STATE_NORMAL; this.setUpMapCollision(0); }
    }
}
export class PanelRevolve extends MapObjBase {
    constructor(w: World, name = '回転棚') { super(w, name); }
    private revolve() {
        this.world.sound(SE.OBJ_PANEL_ROLL, this.pos);
        this.state = ST_REVOLVING;
        this.startAnim(1);
        this.removeMapCollision();
    }
    /** (any message) */
    receiveMessage(_s: HitActor, _msg: number) { if (this.isState(STATE_NORMAL)) this.revolve(); return true; }
    touchPlayer(_a: HitActor) { if (this.marioHipAttack() && this.isState(STATE_NORMAL)) this.revolve(); }
    control() {
        super.control();
        if (this.state === ST_REVOLVING && this.animIsFinished()) { this.state = STATE_NORMAL; this.setUpCurrentMapCollision(); }
    }
}

// ---------------------------------------------------------------- TPictureTelesa
export class PictureTelesa extends WaterHitPictureHideObj {
    /** something near it once it's done: its Boo has vanished */
    unk174 = false;
    constructor(w: World, name = 'テルサの絵') { super(w, name); }
    afterFinishedAnim() {
        super.afterFinishedAnim();
        if (this.isActorType(AT.PICTURE_TERESA)) { this.world.sound(SE.SY_CLEAR_SIGN_BIG, null); this.world.sound(SE.BS_TELESA_V_LAUGH2, this.pos); }
    }
    touchActor(a: HitActor) {
        super.touchActor(a);
        if (this.isActorType(AT.PICTURE_TERESA) && !this.unk174 && this.isState(PS.FINISHED) && !this.isStateTimerEngaged()) {
            if (dist(a.pos, this.pos) < 200) {
                this.stateTimer = 60;
                this.world.sound(SE.BS_TELESA_DISAPPEAR, this.pos);
                this.unk174 = true;
            }
        }
    }
    control() { super.control(); if (this.unk174 && this.collisions.length === 0) this.unk174 = false; }
}

register('CasinoRoulette', (w, n) => new CasinoRoulette(w, n));
register('Roulette', (w, n) => new Roulette(w, n));
register('SlotDrum', (w, n) => new SlotDrum(w, n));
register('ItemSlotDrum', (w, n) => new ItemSlotDrum(w, n));
register('CasinoPanelGate', (w, n) => new CasinoPanelGate(w, n));
register('WarpArea', (w, n) => new WarpAreaActor(w, n));
register('Closet', (w, n) => new Closet(w, n));
register('Donchou', (w, n) => new Donchou(w, n));
register('SakuCasino', (w, n) => new SakuCasino(w, n));
register('SirenabossWall', (w, n) => new SirenabossWall(w, n));
register('SirenaCasinoRoof', (w, n) => new SirenaCasinoRoof(w, n));
register('ChestRevolve', (w, n) => new ChestRevolve(w, n));
register('PictureTeresa', (w, n) => new PictureTelesa(w, n));
register('PanelRevolve', (w, n) => new PanelRevolve(w, n));
register('SirenaGate', (w, n) => new SirenaGate(w, n));
