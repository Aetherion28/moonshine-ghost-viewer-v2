// The 1-up mushroom (MoveBG/MapObjItem2.cpp's TMushroom1up): kind 0 walks towards Mario once it's
// landed, kind 1 (R) away from him, kind 2 (X) stays put and is there from the start. Touching it
// circles it round Mario's head for 180 frames, then it's gone; one that isn't taken goes after
// 1200 frames (blinking for the last 240).
// TJumpBase (the same file): the carryable trampoline (Noki Bay, Pinna Park): Mario can pick it up
// once it's folded (spraying it set folds it), stamping on it bounces him (its collision's BG type
// 7, data 10000) and plays its jump; dropped it unfolds again, thrown it slides off in Mario's
// facing; landed in water or off the map it's back where it started.

import { fr, V3, Mtx, MsCos, MsSin, MsWrap, MsAngleDiff, MsGetRotFromZaxisY, JMASSin, JMASCos } from '../math.js';
import { World, Stream, HitActor, TakeActor, LF, HF, MSG, CUE_ENTRY, CUE_MOVE, ANM_BCK, ANM_FRAME_RATE } from '../engine.js';
import { AT } from '../actortypes.js';
import { marioAngleY, marioGroundPlane } from './lib.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { MapObjBase, UNIQUE_MAKERS } from './base.js';

export class Mushroom1up extends MapObjBase {
    /** unk138 landed, unk13A taken, unk13C frames since */
    unk138 = 0; unk13A = 0; unk13C = 0;
    constructor(w: World, public kind: number, name = '１ＵＰキノコ') { super(w, name); }
    touchPlayer(a: HitActor) {
        if (this.unk13A === 1) return;
        if (!a.receiveMessage(this, MSG.ATTACK)) return;
        this.unk13C = 0; this.unk13A = 1;
        this.world.sound(SE.SY_1UP, null);
        this.groundPlane = this.world.illegal;
    }
    makeObjAppeared() {
        super.makeObjAppeared();
        this.stateTimer = 1200; this.unk138 = 0; this.unk13A = 0;
        if (this.kind !== 2) this.world.sound(SE.SY_1UP_APPEAR, null);
        this.world.effect('ms_enm_disap_a_w', this.pos, this.scale);
        this.world.effect('ms_enm_disap_b', this.pos, this.scale);
    }
    initMapObj() {
        super.initMapObj();
        this.gravity = fr(0.35);
        this.offLiveFlag(LF.AIRBORNE | LF.UNK10 | LF.HIDDEN | LF.DEAD);
        if (this.kind === 2) { this.onLiveFlag(LF.UNK10); this.makeObjAppeared(); }
        this.scale.set(1.5, 1.5, 1.5);
    }
    load(s: Stream) { super.load(s); this.offLiveFlag(LF.AIRBORNE | LF.UNK10); }
    control() {
        super.control();
        if (this.unk13A === 1) {
            const t = 180 - this.unk13C;
            if (t < 0) { this.kill(); return; }
            const m = this.world.mario.pos;
            this.pos.set(fr(m.x + fr(1.5 * fr(50 * MsCos(5 * t)))), fr(m.y + 200), fr(m.z + fr(1.5 * fr(50 * MsSin(5 * t)))));
            this.scale.set(1.5, 1.5, 1.5);
            this.posDelta.zero(); this.vel.zero();
            this.unk13C++;
            return;
        }
        this.unk13C++;
        if (this.kind === 2) { this.posDelta.zero(); this.vel.zero(); return; }
        if (this.unk138 === 0) {
            if (this.isAirborne()) return;
            this.unk138 = 1;
        }
        const m = this.world.mario.pos;
        const d = new V3(fr(m.x - this.pos.x), 0, fr(m.z - this.pos.z));
        if (d.x === 0 && d.y === 0 && d.z === 0) d.x = 1;
        if (this.kind === 1) { d.x = -d.x; d.z = -d.z; }
        const angle = MsGetRotFromZaxisY(d);
        const delta = MsAngleDiff(angle, this.rot.y);
        const step = delta > 0 ? Math.min(delta, 1) : Math.max(delta, -1);
        this.rot.y = MsWrap(fr(this.rot.y + step), 0, 360);
        d.normalize().scale(fr(3.8));
        this.posDelta.add(d);
    }
    perform(cue: number) {
        if (this.kind !== 2 && this.stateTimer < 240 && (cue & CUE_ENTRY) && this.world.moveTickCount % 6 > 2) cue &= ~CUE_ENTRY;
        if ((cue & CUE_MOVE) && this.unk13A === 0 && this.kind !== 2 && this.stateTimer <= 0) this.kill();
        super.perform(cue);
    }
}

// ---------------------------------------------------------------- TJumpBase
/** unk138's states: 0 folded (takeable), 1 folding, 2 unfolding, 3 set, 4 jumped on, 5 thrown */
export const JB = { FOLDED: 0, FOLDING: 1, UNFOLDING: 2, SET: 3, JUMP: 4, THROWN: 5 };
export class JumpBase extends MapObjBase {
    /** unk138 its state, unk13C frames in it */
    unk138 = JB.UNFOLDING; unk13C = 0;
    constructor(w: World, name = '移動ジャンプ台') { super(w, name); }
    initMapObj() {
        super.initMapObj();
        const c = this.colMgr && this.colMgr.getActiveCollision();
        if (c) { c.setAllBGType(7); for (const d of c.checks) d.actor = this; c.setAllData(0x2710); }
        this.unkE8 = 0;
    }
    ensureTakeSituation() {
        if (this.held && this.held.holder !== this) this.held = null;
        if (this.holder && this.holder.held !== this) this.holder = null;
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (sender.isActorType(AT.MARIO)) {
            if (msg === MSG.TAKE) {
                if (this.unk138 === JB.FOLDED) {
                    this.holder = sender as TakeActor;
                    this.onHitFilter(HF.NO_COLLISION);
                    if (this.colMgr) this.colMgr.removeActiveCollision();
                    return true;
                }
            } else if (msg === MSG.DETACH || msg === MSG.PUT) { this.holder = null; this.unk13C = 0; this.unk138 = JB.UNFOLDING; return true; }
            else if (msg === MSG.THROWN) { this.holder = null; this.unk13C = 0; this.unk138 = JB.THROWN; return true; }
            else if (msg === MSG.TRAMPLE) { this.unk13C = 0; this.unk138 = JB.JUMP; return true; }
        }
        if (sender.isActorType(AT.WATER) && this.unk138 === JB.SET) { this.unk13C = 0; this.unk138 = JB.FOLDING; return true; }
        return false;
    }
    getRootJointMtx(): Mtx | null { return this.rootMtx(); }
    calcRootMatrix() {
        const h = this.holder, m = h ? h.getTakingMtx() : null;
        if (h && m) {
            this.baseTR.set(m);
            this.pos.set(m[3], m[7], m[11]);
            this.anmMtx0 = null;
            return;
        }
        super.calcRootMatrix();
    }
    private setBck(name: string, frame: 'start' | 'end') {
        const a = this.mactor;
        if (!a) return;
        a.setBck(name);
        const fc = a.getFrameCtrl(ANM_BCK);
        if (fc) {
            if (frame === 'end') { fc.frame = fc.end; fc.rate = 0; }
            else { fc.frame = 0; fc.rate = ANM_FRAME_RATE; }
        }
    }
    private bckEnds() { return !this.mactor || this.mactor.curAnmEndsNext(ANM_BCK); }
    control() {
        const prev = this.unk138;
        if (!this.isAirborne()) this.onLiveFlag(LF.UNK10);
        switch (this.unk138) {
            case JB.FOLDED:
                if (this.unk13C === 0) { this.setBck('jumpbase_shrink', 'end'); this.scaledBodyRadius = 50; }
                break;
            case JB.SET:
                if (this.unk13C === 0) {
                    this.offHitFilter(HF.NO_COLLISION);
                    if (this.colMgr) { const c = this.colMgr.getActiveCollision(); if (c) c.setUp(); }
                    this.setBck('jumpbase_set', 'end');
                }
                break;
            case JB.UNFOLDING:
                if (this.unk13C === 0) {
                    this.setBck('jumpbase_set', 'start');
                    this.offLiveFlag(LF.UNK10);
                    this.scaledBodyRadius = 100;
                }
                if (this.bckEnds()) { this.unk13C = 0; this.unk138 = JB.SET; }
                break;
            case JB.FOLDING:
                if (this.unk13C === 0) {
                    const c = this.colMgr && this.colMgr.getActiveCollision();
                    if (c) c.remove();
                    this.setBck('jumpbase_shrink', 'start');
                }
                if (this.bckEnds()) { this.unk13C = 0; this.unk138 = JB.FOLDED; }
                break;
            case JB.JUMP:
                if (this.unk13C === 0) this.setBck('jumpbase_jump', 'start');
                if (this.bckEnds()) { this.unk13C = 0; this.unk138 = JB.SET; }
                break;
            case JB.THROWN:
                if (this.unk13C === 0) {
                    this.onLiveFlag(LF.AIRBORNE);
                    const a = marioAngleY(this.world);
                    this.vel.set(JMASSin(a), 0, JMASCos(a));
                    this.pos.add(this.vel);
                    this.offLiveFlag(LF.UNK10);
                }
                if (!this.isAirborne()) { this.unk13C = 0; this.unk138 = JB.UNFOLDING; }
                break;
        }
        if (this.unk138 === prev) {
            this.unk13C = (this.unk13C + 1) >>> 0;
            if (this.unk13C === 0) this.unk13C = 1;
        }
        super.control();
        const g = this.groundPlane;
        if (g && (g.isIllegal() || g.isWaterSurface())) { this.makeObjDead(); this.makeObjDefault(); this.makeObjAppeared(); }
        if (this.holder) { this.groundPlane = marioGroundPlane(this.world); this.groundHeight = this.world.mario.pos.y; }
    }
}

register('JumpBase', (w, n) => new JumpBase(w, n));
UNIQUE_MAKERS.set('mushroom1up', (w) => new Mushroom1up(w, 0));
UNIQUE_MAKERS.set('mushroom1upR', (w) => new Mushroom1up(w, 1));
UNIQUE_MAKERS.set('mushroom1upX', (w) => new Mushroom1up(w, 2));
register('Mushroom1up', (w, n) => new Mushroom1up(w, 0, n));
register('Mushroom1upR', (w, n) => new Mushroom1up(w, 1, n));
register('Mushroom1upX', (w, n) => new Mushroom1up(w, 2, n));
