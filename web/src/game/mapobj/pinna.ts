// Pinna Park's map objects (MoveBG/MapObjPinna.cpp; TBasketReverse is MapObjTown.cpp's):
// - TFerrisWheel: the Ferris wheel; its BCK frame is pushed on by unk140 each tick (fast in the
//   boss episode, stage 2, until TAmiKing falls: becomeCalmlyCallback slows it back down), and
//   each of its gondolas (FerrisGondola, made by name) is put on joint i + 1;
// - THorizontalViking / TViking: the pirate-ship swing: a pendulum of length unk138 about the
//   point above it (unk148 its angle, unk144 its angular speed); the Viking's roll() pumps it up
//   (unk154) until it goes over the top, then lets it settle (unk158);
// - TShellCup and its six TPinnaShell: the clam ride; spraying a shell opens it (unk6C, its X
//   rotation on its joint), opened it shows what's in it (shell 0 the blue coin, 2 and 4 coins) and
//   after a while it shuts again, its TDamageObj hurting Mario while it closes;
// - TMerrygoround: turns by mRotSpeed; its two eggs (merry_egg), nine poles (TMerryPole: Mario
//   climbs them) and the Yoshi warp (TChangeStageMerrygoround: on Yoshi, to stage 0x29) ride its joints;
// - TBalloonKoopaJr: the Bowser Jr. balloons: touched, they pop (MSF_BALLOON_COUNT goes up);
// - TPinnaEntrance (PinnaDoor / PinnaDoorOpen): puts the GateManta on itself;
// - TAmiKing: the big Electrokoopa of the runaway Ferris wheel episode: sleeping, it shocks Mario; when the revolving fence panel it sits on turns, it flies off,
//   falls into the water and gives the Shine (and the wheel calms down);
// - TPinnaCoaster: the roller coaster car, riding the root joint of CoasterRail.bmd's BCK;
// - TBasketReverse: the upside-down basket (MapObjTown.cpp): killed, it breaks.
//
// Not here: particles (told as effects), the BGM's volume and
// pitch (becomeCalmlyCallback's MSound unk80), the demo cameras (told as 'demoCamera' events; the
// demo's callback is called at once: TODO, the director calls it when the demo is done), the
// shells' joints rolling on top of the playing BCK (the viewer's joint locals replace the
// animated ones) and TMerrygoround::draw (it draws nothing itself: its model is still drawn here).

import { MSF } from '../flags.js';
import { mat4 } from 'gl-matrix';
import { fr, V3, Mtx, mtx, MsMtxSetXYZRPH, MsRandF } from '../math.js';
import { World, Stream, HitActor, LF, HF, HC, MSG, ANM_BCK, ANM_FRAME_RATE, CUE_MOVE, CUE_CALC_ANIM, MActor } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { Skeleton } from '../skeleton.js';
import { MapObjBase, STATE_NORMAL, MOF, mapObjGlobals, newAndRegisterObj, UNIQUE_MAKERS } from './base.js';
import { MapObjGeneral } from './general.js';
import { MapObjChangeStage } from './town.js';
import { ObjCollision, KIND_MOVE, KIND_STATIC } from './objcol.js';
import { MsMtxSetRotX, MTXConcat, setRootMtx, setJointWorlds, restJointMtx, marioOnYoshi, sendToMario } from './lib.js';
import { itemCounts } from './item.js';
import type { ItemManager, Coin } from './item.js';

const itemManager = (w: World) => mapObjGlobals(w).itemManager as ItemManager | null;
const demoCamera = (w: World, name: string, p: V3) => { w.events.push({ t: w.tickCount, kind: 'demoCamera', data: { name, p: p.clone() } }); if (w.talk) w.talk.fireStartDemoCamera(name, p.clone()); };
/** a J3D anm matrix (column-major 4x4) as the game's 3x4 */
function m4ToMtx(w: mat4): Mtx {
    const m = mtx();
    m[0] = w[0]; m[1] = w[4]; m[2] = w[8]; m[3] = w[12];
    m[4] = w[1]; m[5] = w[5]; m[6] = w[9]; m[7] = w[13];
    m[8] = w[2]; m[9] = w[6]; m[10] = w[10]; m[11] = w[14];
    return m;
}
/** getModel()->getAnmMtx(j) for every joint: as the model's last calc left them (its base matrix and BCK frame) */
function anmMtxs(o: MapObjBase): Mtx[] {
    const a = o.mactor;
    const all = a ? a.anmMtxAll(o.baseTR, o.scale) : null;
    return all ? all.map(m4ToMtx) : [];
}
/** TMapObjBase::concatOnlyRotFromRight(a, b, out): out = a (without its translation) x b, with a's translation */
function concatOnlyRotFromRight(a: Mtx, b: Mtx, out: Mtx) {
    const x = a[3], y = a[7], z = a[11];
    const t = Float64Array.from(a); t[3] = 0; t[7] = 0; t[11] = 0;
    MTXConcat(t, b, out);
    out[3] = x; out[7] = y; out[11] = z;
    return out;
}
/** SMS_GetYoshi()->mType (no Yoshi in the sim: what the stage's Mario says, else 0) */
const yoshiType = (w: World): number => { const y = (w.mario as any).mYoshi ?? (w.mario as any).yoshi; return y && typeof y.mType === 'number' ? y.mType : 0; };

// ---------------------------------------------------------------- TFerrisWheel
export const FERRIS_STATE_UNK2 = 2;
export class FerrisWheel extends MapObjBase {
    unk138 = 0;
    unk13C: MapObjBase[] = [];
    unk140 = 0;
    constructor(w: World, name = '観覧車') { super(w, name); }
    /** becomeCalmlyCallback (the demo camera's: 0 when it's done) */
    static becomeCalmlyCallback(wheel: FerrisWheel, p2: number) {
        if (p2 === 0) {
            wheel.state = FERRIS_STATE_UNK2;
            // (the BGM's volume to 0 and pitch to 0.5 over 200 frames: not here)
            wheel.stateTimer = 120;
        }
        return 0;
    }
    control() {
        super.control();
        if (this.isState(FERRIS_STATE_UNK2) && !this.isStateTimerEngaged()) {
            if (this.unk140 > ANM_FRAME_RATE / 4) this.unk140 = fr(this.unk140 - fr(0.015));
            else this.state = STATE_NORMAL;
        }
        if (this.unk140 > ANM_FRAME_RATE / 4) this.world.sound(SE.OBJ_MAHRE_GATE_LIGHT, this.pos);
        // (the joints as the last calc left them: before the frame moves on)
        const J = anmMtxs(this);
        const fc = this.mactor ? this.mactor.getFrameCtrl(ANM_BCK) : null;
        if (fc) fc.frame = fr(fc.frame + this.unk140);
        for (let i = 0; i < this.unk138; ++i) {
            const g = this.unk13C[i], m = J[i + 1];
            if (!g || !m) continue;
            setRootMtx(g, m);
            g.pos.set(m[3], fr(m[7] + g.yOffset), m[11]);
        }
    }
    initMapObj() {
        super.initMapObj();
        const a = this.mactor;
        const sk = a ? Skeleton.of(a.data.files.scene(a.model)) : null;
        this.unk138 = sk ? sk.names.length - 1 : 0;
        this.unk13C = [];
        for (let i = 0; i < this.unk138; ++i) {
            const g = newAndRegisterObj(this.world, 'FerrisGondola');
            if (!g) continue;
            this.unk13C[i] = g;
            g.appear();
        }
        this.unk140 = this.world.stage === 2 ? 10 : ANM_FRAME_RATE / 4;
    }
}

// ---------------------------------------------------------------- THorizontalViking / TViking
export const VIKING = { STATE_UNK2: 2, STATE_UNK3: 3, STATE_UNK4: 4, MODE_UNK0: 0, MODE_UNK1: 1 };
export class HorizontalViking extends MapObjBase {
    /** the arm's length, the swing's pull, its starting speed, its speed, its angle */
    unk138 = 0; unk13C = 0; unk140 = 0; unk144 = 0; unk148 = 0;
    constructor(w: World, name = '') { super(w, name); }
    updateTrans() {
        const a = fr(3.14 * fr(this.unk148 / 180));
        const sin = fr(Math.sin(a));
        this.pos.x = fr(fr(this.unk138 * sin) + this.initialPos.x);
        const cos = fr(Math.cos(a));
        this.pos.y = fr(this.yOffset + fr(fr(this.unk138 * fr(1 - cos)) + this.initialPos.y));
    }
    moveNormal() {
        switch (this.state) {
            case STATE_NORMAL:
                this.unk144 = fr(this.unk144 - this.unk13C); this.unk148 = fr(this.unk148 + this.unk144);
                if (this.unk148 < 0) this.state = VIKING.STATE_UNK2;
                break;
            case VIKING.STATE_UNK2:
                this.unk144 = fr(this.unk144 + this.unk13C); this.unk148 = fr(this.unk148 + this.unk144);
                if (this.unk148 > 0) this.state = STATE_NORMAL;
                break;
        }
    }
    control() { super.control(); this.moveNormal(); this.updateTrans(); }
    reset() { this.unk144 = this.unk140; this.unk148 = 0; this.state = this.unk144 > 0 ? STATE_NORMAL : VIKING.STATE_UNK2; }
    initMapObj() { super.initMapObj(); this.unk138 = 2500; this.unk13C = fr(0.0008); this.unk140 = fr(0.23); this.reset(); }
}
export class Viking extends HorizontalViking {
    unk14C = VIKING.MODE_UNK0;
    /** the speed it settles back below, the pumping, the settling */
    unk150 = 0; unk154 = 0; unk158 = 0;
    constructor(w: World, name = 'バイキング') { super(w, name); }
    private wing() { this.world.sound(SE.OBJ_PIN_BIKING_WING, this.pos); }
    roll() {
        switch (this.state) {
            case STATE_NORMAL:
                this.unk144 = fr(this.unk144 * this.unk154); this.unk144 = fr(this.unk144 - this.unk13C); this.unk148 = fr(this.unk148 + this.unk144);
                if (this.unk148 < 0) { this.wing(); this.state = VIKING.STATE_UNK2; }
                if (this.unk148 > 180) { this.unk148 = fr(this.unk148 - 360); this.wing(); this.state = VIKING.STATE_UNK4; }
                break;
            case VIKING.STATE_UNK2:
                this.unk144 = fr(this.unk144 * this.unk154); this.unk144 = fr(this.unk144 + this.unk13C); this.unk148 = fr(this.unk148 + this.unk144);
                if (this.unk148 > 0) { this.wing(); this.state = STATE_NORMAL; }
                if (this.unk148 < -180) { this.unk148 = fr(this.unk148 + 360); this.wing(); this.state = VIKING.STATE_UNK3; }
                break;
            case VIKING.STATE_UNK3:
                this.unk144 = fr(this.unk144 * this.unk158); this.unk144 = fr(this.unk144 - this.unk13C); this.unk148 = fr(this.unk148 + this.unk144);
                if (this.unk148 < 0) { this.wing(); this.state = this.unk144 > -this.unk150 ? VIKING.STATE_UNK2 : VIKING.STATE_UNK4; }
                break;
            case VIKING.STATE_UNK4:
                this.unk144 = fr(this.unk144 * this.unk158); this.unk144 = fr(this.unk144 + this.unk13C); this.unk148 = fr(this.unk148 + this.unk144);
                if (this.unk148 > 0) { this.wing(); this.state = this.unk144 < this.unk150 ? STATE_NORMAL : VIKING.STATE_UNK3; }
                break;
        }
    }
    /** (no TMapObjBase::control: nothing touching it is told) */
    control() {
        switch (this.unk14C) {
            case VIKING.MODE_UNK0: this.moveNormal(); break;
            case VIKING.MODE_UNK1: this.roll(); break;
        }
        this.updateTrans();
        this.rot.z = this.unk148;
        // updateObjMtx: getAnmMtx(0) = XYZRPH(pos - yOffset, rot)
        const m = mtx(); MsMtxSetXYZRPH(m, this.pos.x, fr(this.pos.y - this.yOffset), this.pos.z, this.rot.x, this.rot.y, this.rot.z);
        setRootMtx(this, m);
    }
    reset() { this.unk144 = this.unk140; this.unk148 = 0; this.state = this.unk140 > 0 ? STATE_NORMAL : VIKING.STATE_UNK2; }
    loadAfter() { super.loadAfter(); this.reset(); }
    initMapObj() {
        this.unk14C = VIKING.MODE_UNK1;
        this.unk138 = 1400; this.unk13C = fr(0.001); this.unk154 = fr(1.001); this.unk158 = fr(0.999); this.unk150 = fr(0.3);
        this.unk140 = this.name === 'viking 0' ? fr(-0.3) : fr(0.3);
        this.pos.y = fr(this.pos.y - this.unk138);
        // TMapObjBase's (not THorizontalViking's)
        MapObjBase.prototype.initMapObj.call(this);
    }
}

// ---------------------------------------------------------------- TShellCup / TPinnaShell
export const SHELL = { STATE_UNK0: 0, STATE_UNK1: 1, STATE_UNK2: 2, STATE_UNK3: 3 };
/** TDamageObj (MapObjTown.cpp) as init(type) makes it: touching it hurts Mario */
export class DamageObj extends HitActor {
    constructor(public world: World, name = 'ダメージオブジェ') { super(name); }
    init(type: number) {
        this.initHitActor(type, 1, HC.PLAYER, fr(50 * this.scale.x), fr(100 * this.scale.y), 0, 0);
        this.offHitFilter(HF.NO_COLLISION);
        this.world.addToGroup('マップグループ', this);
    }
    perform(_cue: number) { if (this.collisions.length) this.collisions[0].receiveMessage(this, MSG.ATTACK); }
}
export class PinnaShell extends HitActor {
    /** its state, its opening (X rotation), its closing speed, its joint's matrix, its joint, the open timer, what's in it, its collision, its damage, its cup */
    unk68 = 0; unk6C = 0; unk70 = 0; unk74: Mtx | null = null; unk78 = 0; unk7C = 0;
    unk80: MapObjBase | null = null; unk84: ObjCollision | null = null; unk88: DamageObj | null = null; unk8C: ShellCup | null = null;
    constructor(public world: World, name = 'シェル') {
        super(name);
        this.initHitActor(AT.PINNA_SHELL, 1, HC.PLAYER, 250, 400, 250, 200);
    }
    opened() {
        this.unk6C = fr(-ShellCup.mOpenRotMax);
        this.unk7C = 360;
        const w = this.world, c = this.unk80;
        if (c && !c.checkLiveFlag(LF.DEAD)) w.sound(c.isActorType(AT.COIN_BLUE) ? SE.SY_COLLECT_PRETTY : SE.SY_COIN_APPEAR);
        else w.sound(SE.SY_NOT_COLLECT);
        this.unk68 = SHELL.STATE_UNK2;
    }
    receiveMessage(s: HitActor, msg: number): boolean {
        if (msg === MSG.SPRAYED_BY_WATER) {
            this.world.effect('enmWathit', s.pos);
            this.world.sound(SE.EN_COMMON_W_HIT_OK, this.pos);
            if (this.unk68 === SHELL.STATE_UNK0) {
                this.unk6C = fr(this.unk6C - ShellCup.mWaterOpenAccel);
                if (this.unk6C < -ShellCup.mOpenRotMax) this.unk68 = SHELL.STATE_UNK1;
            }
            return true;
        }
        return false;
    }
    control() {
        if (this.unk7C > 0) this.unk7C--;
        switch (this.unk68) {
            case SHELL.STATE_UNK0:
                if (this.unk6C < 0) this.unk6C = fr(this.unk6C + fr(ShellCup.mCloseAccel * fr(fr(0.5 * MsRandF()) + 0.5)));
                else this.unk6C = 0;
                break;
            case SHELL.STATE_UNK1:
                this.unk6C = fr(this.unk6C - fr(0.8));
                if (this.unk6C < -ShellCup.mOpenRotMax) this.opened();
                break;
            case SHELL.STATE_UNK2:
                if (this.unk7C <= 0) { this.unk68 = SHELL.STATE_UNK3; this.world.sound(SE.OBJ_PIN_SHELL_CLOSE, this.pos); }
                break;
            case SHELL.STATE_UNK3:
                this.unk6C = fr(this.unk6C + this.unk70);
                if (this.unk6C >= -ShellCup.mShellDamageRot && this.unk88) this.unk88.offHitFilter(HF.NO_COLLISION);
                if (this.unk6C >= 0) { this.unk6C = 0; this.unk68 = SHELL.STATE_UNK0; if (this.unk88) this.unk88.onHitFilter(HF.NO_COLLISION); }
                break;
        }
        const j = this.unk74, c = this.unk8C!;
        if (!j) return;
        this.pos.set(fr(fr(0.7 * fr(j[3] - c.pos.x)) + c.pos.x), fr(j[7] - 100), fr(fr(0.7 * fr(j[11] - c.pos.z)) + c.pos.z));
        if (this.unk88) this.unk88.pos.set(this.pos);
        if (this.collisions.length !== 0 && this.unk84) {
            const m = mtx(); MsMtxSetRotX(m, this.unk6C);
            concatOnlyRotFromRight(j, m, m);
            this.unk84.moveMtx(m);
        }
    }
}
export class ShellCup extends MapObjBase {
    static mOpenRotMax = 90; static mShellDamageRot = 45; static mWaterOpenAccel = 5; static mCloseAccel = fr(3.5);
    unk138: PinnaShell[];
    unk498: Coin | null = null; unk49C: Coin | null = null; unk4A0: Coin | null = null;
    constructor(w: World, name = 'シェルカップ') {
        super(w, name);
        this.unk138 = [];
        for (let i = 0; i < 6; i++) this.unk138.push(new PinnaShell(w));
    }
    /** (mMActor->calc(): the shells' joints afresh, then each shell) */
    control() {
        const J = anmMtxs(this);
        for (let i = 0; i < this.unk138.length; ++i) {
            const s = this.unk138[i];
            s.unk74 = J[i + 1] || null;
            s.control();
        }
    }
    attachCoin(c: Coin | null, i: number) { if (c && !c.checkLiveFlag(LF.DEAD)) c.pos.set(this.unk138[i].pos); }
    calcAfter() {
        const w = this.world;
        if (w.talkMode && !w.demoMode) return;
        const J = anmMtxs(this), worlds = new Map<number, Mtx>();
        for (let i = 0; i < this.unk138.length; ++i) {
            const s = this.unk138[i], j = J[i + 1];
            if (!j) continue;
            const r = mtx(); MsMtxSetRotX(r, s.unk6C);
            concatOnlyRotFromRight(j, r, j);
            s.unk74 = j;
            worlds.set(i + 1, j);
        }
        setJointWorlds(this, worlds);
        this.attachCoin(this.unk498, 0);
        this.attachCoin(this.unk49C, 2);
        this.attachCoin(this.unk4A0, 4);
    }
    perform(cue: number) {
        super.perform(cue);
        if (cue & CUE_CALC_ANIM) this.calcAfter();
        // (the TDamageObjs are performed by the map group in the game: here once a movement tick)
        if (cue & CUE_MOVE) for (const s of this.unk138) if (s.unk88) s.unk88.perform(cue);
    }
    loadAfter() {
        super.loadAfter();
        const w = this.world;
        for (const s of this.unk138) if (s.unk88) w.addToGroup('オブジェクトグループ', s.unk88);
        this.unk498 = newAndRegisterObj(w, 'coin_blue') as Coin | null;
        const im = itemManager(w);
        this.unk49C = im ? im.newAndRegisterCoinReal() : null;
        this.unk4A0 = im ? im.newAndRegisterCoinReal() : null;
        if (this.unk498) {
            this.unk498.eventId = 2;
            // TFlagManager::getBlueCoinFlag(map, 2)
            if (!itemCounts(w).blue.includes(this.unk498.eventId)) { this.unk498.makeObjAppeared(); this.unk138[0].unk80 = this.unk498; }
        }
        for (const c of [this.unk49C, this.unk4A0]) if (c) { c.makeObjAppeared(); c.onMapObjFlag(MOF.UNK10000000); }
        this.unk138[2].unk80 = this.unk49C;
        this.unk138[4].unk80 = this.unk4A0;
    }
    initMapObj() {
        super.initMapObj();
        const w = this.world, J = anmMtxs(this);
        for (let i = 0; i < this.unk138.length; ++i) {
            const s = this.unk138[i];
            s.unk68 = SHELL.STATE_UNK0; s.unk6C = 0; s.unk70 = 8;
            s.unk74 = J[i + 1] || null; s.unk78 = i + 1;
            s.unk7C = Math.trunc(fr(MsRandF() * 1200));
            s.unk8C = this;
            w.addToGroup('オブジェクトグループ', s);
            s.unk84 = new ObjCollision(w, KIND_MOVE, this);
            s.unk84.init('mapObj/ShellCup', 0);
            s.unk84.setUp();
            const d = s.unk88 = new DamageObj(w);
            d.scale.set(2, fr(1.2), 2);
            d.init(AT.ENEMY_DAMAGE_OBJ);
            d.onHitFilter(HF.NO_COLLISION);
        }
        const rink = new ObjCollision(w, KIND_STATIC, this);
        rink.init('mapObj/ShellCup_rink', 2);
        rink.setUpMtx(this.rootMtx());
    }
}

// ---------------------------------------------------------------- TMerrygoround
/** TMerryPole: a climbable pole; its root joint matrix is the merry-go-round's joint it's on */
export class MerryPole extends MapObjBase {
    unk138: Mtx = mtx();
    constructor(w: World, name = 'メリーゴーランド用ポール') { super(w, name); }
    getRootJointMtx(): Mtx | null { return this.unk138; }
}
export class ChangeStageMerrygoround extends MapObjChangeStage {
    unk13C = 0;
    constructor(w: World, name = 'ステージ切り替え（メリーゴーランド用）') { super(w, name); }
    touchPlayer(a: HitActor) {
        if (this.isStateTimerEngaged()) return;
        if (yoshiType(this.world) === 1) {
            this.world.sound(SE.SY_COLLECT_YOSHI);
            super.touchPlayer(a);
            this.unk13C = 1;
        } else this.world.sound(SE.SY_NOT_COLLECT_YOSHI);
        this.stateTimer = 600;
    }
    calc() {
        if (this.unk13C) { this.world.effect('hikage1A', this.world.mario.pos); this.world.effect('hikage1B', this.world.mario.pos); }
    }
}
export class Merrygoround extends MapObjBase {
    static mRotSpeed = fr(0.1);
    unk138: (MapObjBase | null)[] = [null, null];
    unk140 = [0, 0];
    unk144: (MerryPole | null)[] = new Array(9).fill(null);
    unk168: (ObjCollision | null)[] = new Array(9).fill(null);
    unk18C = new Array(9).fill(0);
    unk1A0: ChangeStageMerrygoround | null = null;
    unk1A4 = 0;
    constructor(w: World, name = 'メリーゴーランド') { super(w, name); }
    control() {
        super.control();
        // (the joints as the last calc left them)
        const J = anmMtxs(this);
        this.rot.y = fr(this.rot.y + Merrygoround.mRotSpeed);
        if (this.rot.y > 360) this.rot.y = fr(this.rot.y - 360);
        for (let i = 0; i < 2; ++i) {
            const m = J[this.unk140[i]], e = this.unk138[i];
            if (!m || !e) continue;
            setRootMtx(e, m);   // setModelMtx
            e.pos.set(m[3], m[7], m[11]);
        }
        for (let i = 0; i < 9; ++i) {
            const m = J[this.unk18C[i]], p = this.unk144[i];
            if (!m || !p) continue;
            p.unk138.set(m);
            p.pos.set(m[3], fr(m[7] - 600), m[11]);
        }
        const c = this.unk1A0;
        if (!c) return;
        if (marioOnYoshi(this.world)) c.offHitFilter(HF.NO_COLLISION);
        else c.onHitFilter(HF.NO_COLLISION);
        const m = J[this.unk1A4];
        if (m) c.pos.set(m[3], fr(m[7] - 600), m[11]);
    }
    initMapObj() {
        super.initMapObj();
        const w = this.world, a = this.mactor;
        const sk = a ? Skeleton.of(a.data.files.scene(a.model)) : null;
        let eggs = 0, poles = 0;
        if (sk) for (let i = 1; i < sk.names.length; ++i) {
            const n = sk.names[i];
            if (n.includes('egg')) this.unk140[eggs++] = i;
            else if (n === 'yoshi_warp') this.unk1A4 = i;
            else if (n !== 'up' && n !== 'down' && n !== 'KAGE_2') this.unk18C[poles++] = i;
        }
        for (let i = 0; i < 2; ++i) { const e = this.unk138[i] = newAndRegisterObj(w, 'merry_egg'); if (e) e.appear(); }
        for (let i = 0; i < 9; ++i) {
            const p = this.unk144[i] = newAndRegisterObj(w, 'merry_pole') as MerryPole | null;
            if (p) p.appear();
            // (a move collision set up once where it is: the game's)
            const c = this.unk168[i] = new ObjCollision(w, KIND_MOVE, this);
            c.init('mapObj/merry_yoshi', 0);
            c.setUp();
        }
        const c = this.unk1A0 = newAndRegisterObj(w, 'ChangeStageMerrygoround') as ChangeStageMerrygoround | null;
        if (c) {
            c.unk138 = 0x29;
            c.scale.y = fr(c.scale.y * 1.5);
            c.makeObjAppeared();
            w.addToGroup('マップグループ', c);
        }
    }
}

// ---------------------------------------------------------------- TBalloonKoopaJr
export class BalloonKoopaJr extends MapObjGeneral {
    unk148 = new V3();
    constructor(w: World, name = '風船（クッパＪｒ）') { super(w, name); }
    touchActor(_a: HitActor) { this.kill(); }
    kill() {
        super.kill();
        this.emit('balloonKoopaJr', this.unk148); this.emit('balloonKoopaJrA', this.unk148); this.emit('balloonKoopaJrB', this.unk148);
        // TFlagManager::incFlag(MSF_BALLOON_COUNT, 1)
        this.world.flags.incFlag(MSF.BALLOON_COUNT, 1);
        this.world.events.push({ t: this.world.tickCount, kind: 'incFlag', data: { flag: 'MSF_BALLOON_COUNT', value: this.world.flags.getFlag(MSF.BALLOON_COUNT) } });
        this.world.sound(SE.BS_BSPAKU_SLAP, this.pos);
    }
    /** TMapObjBase's load (not TMapObjGeneral's), then the "center" joint's place */
    load(s: Stream) {
        MapObjBase.prototype.load.call(this, s);
        const j = this.mactor ? this.mactor.jointIndex('center') : -1;
        const m = j >= 0 ? restJointMtx(this, j) : null;
        if (m) this.unk148.set(m[3], m[7], m[11]);
    }
}

// ---------------------------------------------------------------- TPinnaEntrance
export class PinnaEntrance extends MapObjBase {
    constructor(w: World, name = 'ピンナ入り口') { super(w, name); }
    loadAfter() {
        super.loadAfter();
        newAndRegisterObj(this.world, 'GateManta', this.pos.clone(), new V3(90, 0, 0), new V3(1, 1, 1));
    }
}

// ---------------------------------------------------------------- TAmiKing
export class AmiKing extends MapObjBase {
    /** flying off */
    unk138 = 0;
    unk13C = new V3();
    constructor(w: World, name = 'アミキング') { super(w, name); }
    initMapObj() {
        super.initMapObj();
        if (this.mactor) this.mactor.setBck('amiking_sleep1');
        this.setAnmSound('/scene/mapObj/amiking_sleep1.bas');
        this.offLiveFlag(LF.UNK10);
    }
    moveObject() {
        super.moveObject();
        const w = this.world, a = this.mactor;
        if (this.unk138) {
            if (a && a.checkCurAnm('amiking_flying1_start', ANM_BCK)) {
                if (a.curAnmEndsNext(ANM_BCK)) a.setBck('amiking_flying1_loop');
                return;
            }
            if (!this.groundPlane.isWaterSurface()) return;
            if (this.isAirborne()) return;
            w.sound(SE.EN_AMIKING_DIVE, this.pos);
            this.emit('dnkShibireB');
            const e = w.conductor.makeOneEnemyAppear(this.pos, 'エフェクト水柱マネージャー', 1) as any;
            if (e && e.generate) e.generate(this.pos, new V3(4, 4, 4));
            const im = itemManager(w);
            if (im) im.makeShineAppearWithDemo('シャイン（観覧車シャイン用）', '観覧車シャインカメラ', this.pos.x, this.pos.y, this.pos.z);
            const wheel = w.search('FerrisWheel') as FerrisWheel | null;
            if (wheel instanceof FerrisWheel) {
                demoCamera(w, '観覧車正常化カメラ', wheel.pos);
                // TODO: the director calls this when the demo camera is done; at once here
                FerrisWheel.becomeCalmlyCallback(wheel, 0);
            }
            this.kill();
        } else {
            const o = this.groundPlane.actor as any;
            if (o && o instanceof MapObjBase && o.isActorType(AT.FENCE_REVOLVE_INNER) && (o.isState(3) || o.isState(5) || o.isState(4) || o.isState(6))) {
                this.unk138 = 1;
                this.vel.set(5, 10, -10); this.offLiveFlag(LF.UNK10);   // setVelocityAndFlag10
                if (a) a.setBck('amiking_flying1_start');
                this.setAnmSound(null);
                demoCamera(w, '観覧車ボス撃沈カメラ', this.pos);
            }
        }
    }
    calcRootMatrix() {
        super.calcRootMatrix();
        if (!this.mactor) return;
        this.emit('amiking');
        if (!this.unk138) {
            const j = this.mactor.anmMtx(6, this.baseTR, this.scale);
            if (j) this.unk13C.set(j[12], j[13], j[14]);
            // offset (0, 0, 200) turned by rot.y (MsMtxSetRotRPH(0, rot.y, 0))
            const r = fr(this.rot.y * (Math.PI / 180));
            this.unk13C.x = fr(this.unk13C.x + fr(200 * fr(Math.sin(r))));
            this.unk13C.z = fr(this.unk13C.z + fr(200 * fr(Math.cos(r))));
            this.emit('poiZzz', this.unk13C);
            this.world.sound(SE.EN_AMIKING_SPARK, this.pos);
        } else this.world.sound(SE.EN_AMIKING_FLY, this.pos);
    }
    bind() {
        if (this.checkLiveFlag(LF.UNK10)) {
            const [, d] = this.world.checkGround(this.pos.x, fr(this.pos.y + this.headHeight), this.pos.z);
            this.groundPlane = d;
        } else super.bind();
    }
    touchPlayer(_a: HitActor) { sendToMario(this.world, this, MSG.ELECTRIC_SHOCK); }
    touchWater(_a: HitActor) { return 1; }
}

// ---------------------------------------------------------------- TPinnaCoaster
const SWITCH_SND = new WeakMap<World, number>();
export class PinnaCoaster extends MapObjBase {
    /** CoasterRail.bmd: its BCK carries the car on its root joint */
    unk138: MActor | null = null;
    unk138TR: Mtx = mtx();
    unk13C = 0;
    unk140 = new V3();
    constructor(w: World, name = 'コースター') { super(w, name); }
    control() {
        super.control();
        const r = this.unk138;
        if (r) {
            r.frameUpdate();
            const m = r.anmMtx(0, this.unk138TR, new V3(1, 1, 1));
            if (m) { this.baseTR.set(m4ToMtx(m)); this.anmMtx0 = null; }   // setBaseTRMtx
        }
        if (this.mactor) this.mactor.frameUpdate();
        const m = this.rootMtx();
        const j = this.mactor ? this.mactor.anmMtx(0, this.baseTR, this.scale) : null;
        if (j) this.pos.set(j[12], j[13], j[14]); else this.pos.set(m[3], m[7], m[11]);
        const d = V3.sub(this.pos, this.unk140);
        const speed = fr(Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z));
        const sw = SWITCH_SND.get(this.world) || 0;
        // (startSoundActorWithInfo: `speed` is the sound's info, which the sim's sounds don't take)
        if (sw) this.world.sound(SE.OBJ_JET_COASTER, this.pos);
        SWITCH_SND.set(this.world, sw ^ 1);
        this.unk140.set(this.pos);
    }
    /** its base matrix is the rail's root joint (set in control) */
    calcRootMatrix() { if (!this.unk138) super.calcRootMatrix(); }
    initMapObj() {
        super.initMapObj();
        const m = this.manager;
        const r = this.unk138 = m ? new MActor('mapobj/coasterrail.bmd', m.getMActorAnmData()) : null;
        if (r) {
            r.setBck('coasterrail');
            MsMtxSetXYZRPH(this.unk138TR, this.pos.x, this.pos.y, this.pos.z, this.rot.x, this.rot.y, this.rot.z);
            const fc = r.getFrameCtrl(ANM_BCK);
            if (fc) fc.rate = ANM_FRAME_RATE / 4;
        }
        this.unk140.set(this.pos);
    }
}

// ---------------------------------------------------------------- TBasketReverse (MapObjTown.cpp)
export class BasketReverse extends MapObjBase {
    constructor(w: World, name = 'さかさバスケット') { super(w, name); }
    kill() {
        this.emit('enmDisapAW'); this.emit('enmDisapB');
        this.world.sound(SE.IT_BARREL_CRASH, this.pos);
        this.world.sound(SE.SY_COLLECT_DELIGHT);
        this.makeObjDead();
    }
    initMapObj() { this.pos.y = fr(this.pos.y + 200); super.initMapObj(); }
}

// newUniqueObjByName's
UNIQUE_MAKERS.set('FerrisGondola', (w) => new MapObjBase(w, '観覧車ゴンドラ'));
UNIQUE_MAKERS.set('merry_pole', (w) => new MerryPole(w));
UNIQUE_MAKERS.set('GateManta', (w) => new MapObjBase(w, 'GateManta'));
UNIQUE_MAKERS.set('merry_egg', (w) => new MapObjBase(w, 'メリーゴーランド用たまご'));
UNIQUE_MAKERS.set('ChangeStageMerrygoround', (w) => new ChangeStageMerrygoround(w));

register('BasketReverse', (w, n) => new BasketReverse(w, n));
register('Merrygoround', (w, n) => new Merrygoround(w, n));
register('FerrisWheel', (w, n) => new FerrisWheel(w, n));
register('Viking', (w, n) => new Viking(w, n));
register('PinnaDoor', (w, n) => new PinnaEntrance(w, n));
register('PinnaDoorOpen', (w, n) => new PinnaEntrance(w, n));
register('BalloonKoopaJr', (w, n) => new BalloonKoopaJr(w, n));
register('ShellCup', (w, n) => new ShellCup(w, n));
register('AmiKing', (w, n) => new AmiKing(w, n));
register('PinnaCoaster', (w, n) => new PinnaCoaster(w, n));
