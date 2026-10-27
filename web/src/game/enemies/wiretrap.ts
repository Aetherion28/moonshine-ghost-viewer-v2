// TWireTrap / TWireTrapManager (Enemy/wireTrap.cpp): the electric balls that slide along
// Bianco's tightrope wires (TMapWire) and shock Mario. Each moves at its speed (scene.bin /10)
// in one of three modes: RETURN (to an end, wait mWaitTime, back), ONEWAY (to the far end, shrink
// away, reappear at the start, grow, wait mGoTimerMax, go again) or SEARCH (only while Mario is on
// a wire, towards him). Water pushes it along its wire away from Mario for 30 ticks
// (mInWaterPowerRate); two RETURN traps that bump bounce apart. It rides the wire's current shape
// (TWireBinder, Enemy/wireBinder.cpp), so it dips with the wire when Mario hangs on it.

import { fr, V3, MsSin, MsCos, MsWrap, mtx } from '../math.js';
import { World, SpineEnemy, EnemyManager, LiveActor, LF, HF, MSG, nerve, Spine, Stream, HitActor, TakeActor, readParams, SPINE_PARAMS, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { waitForever } from './launcher.js';
import { calcToDirMatrix } from './kazekun.js';
import { installMapWires, MapWireManager, MapWire } from '../mapwire.js';
import { SE } from '../soundids.js';
import { holdKey } from '../sound.js';

/** TWireTrapParams */
const WIRE_TRAP_PARAMS = { ...SPINE_PARAMS, mInWaterPowerRate: ['f', 0.9], mScaleTimerMax: ['i', 60], mGoTimerMax: ['i', 90] } satisfies PSchema;

export const WIRE_TRAP_MODE_RETURN = 0, WIRE_TRAP_MODE_ONEWAY = 1, WIRE_TRAP_MODE_SEARCH = 2;

// ---------------------------------------------------------------- TWireBinder
/** TWireBinder: binds its actor to its wire's current shape. */
export class WireBinder {
    no = -1; dir = new V3();
    constructor(public mgr: MapWireManager) { }
    init(p: V3) { return this.reset(p); }
    reset(p: V3) {
        this.no = this.mgr.getWireNo(p);
        if (this.no === -1) return false;
        const w = this.getWire()!;
        const d = V3.sub(w.end, w.start);
        const l = d.length();
        this.dir.set(fr(d.x / l), fr(d.y / l), fr(d.z / l));
        return true;
    }
    getWire(): MapWire | null { return this.mgr.getWire(this.no); }
    bind(a: LiveActor) {
        const next = a.pos.clone().add(a.posDelta).add(a.vel);   // getNextFramePosition
        let q = this.getPointAt(next);
        if (isNaN(q.x) || isNaN(q.y) || isNaN(q.z)) q = a.pos.clone();
        if (next.y <= fr(0.05 + q.y)) a.offLiveFlag(LF.AIRBORNE); else a.onLiveFlag(LF.AIRBORNE);
        a.posDelta.set(V3.sub(q, a.pos));
    }
    getDirAtPos(p: V3, d: number) {
        const r = this.getRangePos(p);
        let a: number, b: number;
        if ((r <= 0.01 && d < 0) || (0.99 <= r && 0 < d)) { a = fr(r - 0.01 * d); b = r; }
        else { a = r; b = fr(r + 0.01 * d); }
        return V3.sub(this.getPoint(b), this.getPoint(a));
    }
    getPoint(pos: number) { const w = this.getWire(); return w ? w.getPointPosOnWire(pos, new V3()) : new V3(NaN, NaN, NaN); }
    getPointAt(p: V3) { return this.getPoint(this.getRangePos(p)); }
    getRangePos(p: V3) { const w = this.getWire(); return w ? w.getPosInWire(p) : NaN; }
    isEndWire(p: V3, d: number) { return Math.abs(fr(this.getRangePos(p) - (0 < d ? 1 : 0))) < 0.015; }
    /** (UNUSED: nothing linked shows its body) */
    isStartWire(_p: V3, _d: number) { return false; }
}

// ---------------------------------------------------------------- TWireTrap
export class WireTrapManager extends EnemyManager {
    constructor(w: World, name = '電線トラップマネージャー') { super(w, name); }
    load(s: Stream) { this.saveParams = readParams('/enemy/wiretrap.prm', this.world.files, WIRE_TRAP_PARAMS); super.load(s); }
    createModelData() { this.createModelDataArray(['wire_trap.bmd']); }
}

export class WireTrap extends SpineEnemy {
    unk160 = 0; waterTimer = 0; waterPow = 0; hitTimer = 0;
    moveDir = 1; waitTime = 0; appearScale = 1; moveSpeed = 0; moveMode = 0;
    /** cRedColor (-1) / cBlueColor: its _mat_1 TEV colour, for the viewer */
    color: [number, number, number] = [0xD2, 0x14, 0x0F];
    wb!: WireBinder;
    get P(): any { return this.getSaveParam(); }
    constructor(w: World, name = '電線トラップ') { super(w, name); }
    init(m: any) {
        this.manager = m; m.manageActor(this);
        this.mactor = this.createMActorByName('wire_trap.bmd');
        this.wb = new WireBinder(installMapWires(this.world));
        this.binder = this.wb;
        this.spine!.initWith(waitForever);
        this.initHitActor(AT.WIRE_TRAP, 2, 0x90000000 | 0, 20, 30, 40, 40);
        this.offHitFilter(HF.NO_COLLISION);
    }
    load(s: Stream) {
        super.load(s);
        const speed = s.s32();
        let mode = s.s32();
        this.waitTime = s.s32();
        const color = s.s32();
        this.moveSpeed = fr(speed / 10);
        if (mode === -1) mode = 0;
        this.moveMode = mode;
        this.color = color === -1 ? [0xD2, 0x14, 0x0F] : [0x0F, 0x14, 0xD2];
        this.initWire();
    }
    initWire() {
        this.wb.init(this.pos);
        this.setMoveMode(this.moveMode);
        // the way it faces in the scene file
        const f = new V3(MsSin(this.rot.y), 0, MsCos(this.rot.y));
        this.moveDir = 0 <= f.dot(this.getWireDir()) ? 1 : -1;
        this.appearScale = 1;
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        switch (msg) {
            case MSG.SPRAYED_BY_WATER: this.behaveHitWater(sender); return true;
            case MSG.TAKE: if (!this.holder) { this.onHitFilter(HF.NO_COLLISION); this.holder = sender as TakeActor; return true; } break;
            case MSG.THROWN: case MSG.DETACH: if (this.holder) { this.holder = null; return true; } break;
            case MSG.UNKB: this.kill(); return true;
        }
        return super.receiveMessage(sender, msg);
    }
    behaveHitWater(_sender: HitActor) {
        this.world.effect('enemyWaterHit', this.pos);
        this.world.sound(SE.EN_COMMON_W_HIT_OK, this.pos);
        this.waterTimer = 30;
        const fromMario = V3.sub(this.pos, this.world.mario.pos);
        const dir = this.getWireDir().clone().scale(this.moveDir);
        this.waterPow = 0 <= fromMario.dot(dir) ? this.P.mInWaterPowerRate : -this.P.mInWaterPowerRate;
    }
    kill() {
        if (this.checkLiveFlag(LF.DEAD)) return;
        this.onLiveFlag(LF.DEAD);
        this.onHitFilter(HF.NO_COLLISION);
        this.spine!.reset();
        this.spine!.setNext(waitForever);
        this.world.effect('enemyDisappear', this.pos);
    }
    behaveHitWireTrap(_other: WireTrap, mom: V3, otherMom: V3) {
        if (this.hitTimer <= 0 && this.isReflect()) {
            this.hitTimer = 30;
            if (mom.dot(otherMom) < 0) this.moveDir *= -1;
            this.spine!.pushNerve(WireTrapNerves.wait);
        }
    }
    calcRootMatrix() {
        if (this.holder) { super.calcRootMatrix(); return; }
        // (emitEffects: its sparks, bound to it)
        const dir = this.getDirAtWirePos().scale(this.moveDir);
        const m = mtx();
        calcToDirMatrix(m, dir, new V3(0, 1, 0));
        // spinning around that direction (the quaternion product as a matrix: R · Rz)
        this.rot.z = fr(this.rot.z + -17.75);
        this.rot.z = MsWrap(this.rot.z, 0, 360);
        const a = fr(0.017453294 * this.rot.z), c = Math.cos(a), s = Math.sin(a);
        const B = this.baseTR, k = this.appearScale;
        for (let r = 0; r < 3; r++) {
            const x = m[r * 4], y = m[r * 4 + 1];
            // (the appear scale is baked into the matrix: the viewer draws baseTR · scale)
            B[r * 4] = (x * c + y * s) * k; B[r * 4 + 1] = (-x * s + y * c) * k; B[r * 4 + 2] = m[r * 4 + 2] * k;
        }
        B[3] = this.pos.x; B[7] = this.pos.y; B[11] = this.pos.z;
    }
    moveObject() {
        if (this.waterTimer > 0) { --this.waterTimer; if (this.waterTimer <= 0) this.waterPow = 0; }
        this.updateCollision();
        this.checkHitActors();
        LiveActor.prototype.moveObject.call(this);
        this.world.sound(SE.EN_WIRETRAP_WAIT, this.pos, { hold: holdKey(this, 'wait') });
    }
    calcMomentum() {
        const m = this.getWireDir().clone();
        m.scale(fr(this.moveDir * (this.waterTimer > 0 ? fr(1 + fr(fr(this.waterPow * this.waterTimer) / 30)) : 1)));
        m.scale(this.moveSpeed);
        return m;
    }
    getWaterPow() { return fr(fr(this.waterPow * this.waterTimer) / 30); }
    doReturnMove() {
        if (this.hitTimer > 0) --this.hitTimer;
        if (this.wb.isEndWire(this.pos, this.moveDir)) { this.moveDir *= -1; return true; }
        this.posDelta.set(this.calcMomentum());
        return false;
    }
    doOnewayMove() {
        if (this.hitTimer > 0) --this.hitTimer;
        if (this.wb.isEndWire(this.pos, this.moveDir)) return true;
        this.posDelta.set(this.calcMomentum());
        return false;
    }
    doSearchMove() {
        const mw = this.world.mapWires;
        if (!mw || !mw.isMarioOnWire()) return false;
        if (this.hitTimer > 0) --this.hitTimer;
        const d = V3.sub(this.world.mario.pos, this.pos).dot(this.wb.dir);
        this.moveDir = d > 0 ? 1 : d < 0 ? -1 : 0;
        this.posDelta.set(this.calcMomentum());
        return false;
    }
    doScaleUp() {
        this.onHitFilter(HF.NO_COLLISION);
        this.appearScale = fr(this.appearScale + fr(1 / this.P.mScaleTimerMax));
        if (1 <= this.appearScale) { this.appearScale = 1; this.offHitFilter(HF.NO_COLLISION); return true; }
        return false;
    }
    doScaleDown() {
        this.onHitFilter(HF.NO_COLLISION);
        this.appearScale = fr(this.appearScale - fr(1 / this.P.mScaleTimerMax));
        if (this.appearScale <= 0) { this.appearScale = 0; this.offHitFilter(HF.NO_COLLISION); return true; }
        return false;
    }
    doResetToEdge() {
        const edge = 0 < this.moveDir ? 0 : 1;
        this.pos.set(this.wb.getPoint(fr(edge + 0.01 * this.moveDir)));
    }
    checkHitActors() {
        for (const a of this.collisions.slice()) {
            if (a.actorType === AT.MARIO) a.receiveMessage(this, MSG.ELECTRIC_SHOCK);
            else if (a.actorType === AT.WIRE_TRAP && a !== this) {
                const o = a as WireTrap;
                const mom = this.calcMomentum(), om = o.calcMomentum();
                this.behaveHitWireTrap(o, mom, om);
                // (the game passes `other` again here: only its debug output reads it)
                o.behaveHitWireTrap(o, om, mom);
            }
        }
    }
    updateCollision() { this.setHitParams(fr(20 * this.scale.x), fr(30 * this.scale.y), fr(40 * this.scale.x), fr(40 * this.scale.y)); }
    setMoveMode(mode: number) { this.moveMode = mode; this.spine!.reset(); this.spine!.setNext(getNerveFromMode(mode)); }
    getDirAtWirePos() { return this.wb.getDirAtPos(this.pos, this.moveDir); }
    getWireDir() { return this.wb.dir; }
    isReflect() { return this.moveMode === WIRE_TRAP_MODE_RETURN; }
    getRangePosInWire() { return this.wb.getRangePos(this.pos); }
    isEndWire() { return this.wb.isEndWire(this.pos, this.moveDir); }
    isStartWire() { return this.wb.isStartWire(this.pos, this.moveDir); }
}

type S = Spine<WireTrap>;
export const WireTrapNerves: Record<string, any> = {};
function getNerveFromMode(mode: number) {
    switch (mode) {
        case WIRE_TRAP_MODE_RETURN: return WireTrapNerves.returnMove;
        case WIRE_TRAP_MODE_ONEWAY: return WireTrapNerves.onewayMove;
        case WIRE_TRAP_MODE_SEARCH: return WireTrapNerves.search;
    }
    return null;
}
WireTrapNerves.returnMove = nerve<WireTrap>('TNerveWireTrapReturnMove', (spine: S) => {
    if (spine.body.doReturnMove()) { spine.pushAfterCurrent(WireTrapNerves.returnMove); spine.pushAfterCurrent(WireTrapNerves.wait); return true; }
    return false;
});
WireTrapNerves.onewayMoveStart = nerve<WireTrap>('TNerveWireTrapOnewayMoveStart', (spine: S) => spine.body.doScaleUp());
WireTrapNerves.onewayMove = nerve<WireTrap>('TNerveWireTrapOnewayMove', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0 && self.appearScale < 1) {
        spine.pushAfterCurrent(WireTrapNerves.onewayMove); spine.pushAfterCurrent(WireTrapNerves.goWait); spine.pushAfterCurrent(WireTrapNerves.onewayMoveStart);
        return true;
    }
    if (self.doOnewayMove()) {
        spine.pushAfterCurrent(WireTrapNerves.onewayMove); spine.pushAfterCurrent(WireTrapNerves.wait); spine.pushAfterCurrent(WireTrapNerves.onewayMoveEnd);
        return true;
    }
    return false;
});
WireTrapNerves.onewayMoveEnd = nerve<WireTrap>('TNerveWireTrapOnewayMoveEnd', (spine: S) => {
    if (spine.body.doScaleDown()) { spine.body.doResetToEdge(); return true; }
    return false;
});
WireTrapNerves.search = nerve<WireTrap>('TNerveWireTrapSearch', (spine: S) => {
    if (spine.body.doSearchMove()) { spine.pushAfterCurrent(WireTrapNerves.search); spine.pushAfterCurrent(WireTrapNerves.wait); return true; }
    return false;
});
WireTrapNerves.wait = nerve<WireTrap>('TNerveWireTrapWait', (spine: S) => spine.body.waitTime < spine.time);
WireTrapNerves.goWait = nerve<WireTrap>('TNerveWireTrapGoWait', (spine: S) => spine.body.P.mGoTimerMax < spine.time);

register('WireTrapManager', (w, n) => new WireTrapManager(w, n));
register('WireTrap', (w, n) => new WireTrap(w, n));
// gpMapWireManager (its scene.bin node: drawing parameters; the wires come from tables.bin)
register('MapWireManager', (w) => installMapWires(w));
