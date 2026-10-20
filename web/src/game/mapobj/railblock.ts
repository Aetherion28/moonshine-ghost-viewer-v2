// The lifts that ride a rail (MoveBG/MapObjRailBlock.cpp): TNormalLift waits at nodes flagged
// 0x800 (the node's pitch: frames), takes the node's yaw / 100 as its speed from there, and on a
// node flagged 0x1000 goes away and comes back at its start after the node's roll in frames;
// TWoodBlock (Pianta Village's) fades its colour out instead of blinking before it starts over.
// TRailBlock (the Noki Bay / Sirena / Bianco moving boards, Ricco's EX cube) rides its rail too,
// turning on the way to each node towards the node's pitch / yaw / roll (its own rotation, kept in
// unk174, is folded in at each node), taking the node's speed / 100 as its speed; TRollBlock
// just spins round its Z axis at the scene's speed / 100 degrees a frame.
// TRailMapObj itself is in cloud.ts.
//
// Not here: the WoodBlock's disappearing particle's scale (told as an effect), the TEV colour
// packet (the colour is kept for the viewer).

import { fr, V3, Mtx, mtx, MsMtxSetRotRPH, MsMtxSetXYZRPH, MsWrap, MsAngleDiff } from '../math.js';
import { World, Stream, Actor, CUE_ENTRY, LF } from '../engine.js';
import { register } from '../scene.js';
import { MapObjBase } from './base.js';
import { RailMapObj } from './cloud.js';
import { MsMtxSetRotZ, MTXConcat } from './lib.js';

export class NormalLift extends RailMapObj {
    /** unk150 frames to wait, unk152 frames to stay away (u16) */
    unk150 = 0; unk152 = 0; unk154 = 0; unk158 = 0;
    constructor(w: World, name = 'ノーマルリフト') { super(w, name); this.unk144 = 1; }
    resetPosition() { super.resetPosition(); this.unk158 = 1; }
    load(s: Stream) {
        super.load(s);
        this.unk154 = s.f32();
        if (this.unk154 > 0 && this.colMgr) {
            const c = this.colMgr.getActiveCollision();
            if (c) {
                c.setAllBGType(7);
                for (const d of c.checks) d.actor = this;
                c.setAllData(Math.trunc(this.unk154) & 0xFFFF);
            }
        }
    }
    readRailFlag() {
        super.readRailFlag();
        const t = this.tracer;
        if (!t || !t.graph || t.graph.isDummy() || t.cur < 0) return;
        const n = t.graph.nodes[t.cur];
        if (n.flags & 0x800) this.unk150 = n.pitch & 0xFFFF;
        if (n.flags & 0x1000) { let r = n.roll & 0xFFFF; if (r === 0xFFFF) r = 0; this.unk152 = r; }
    }
    control() {
        MapObjBase.prototype.control.call(this);   // (TMapObjBase's, not TRailMapObj's)
        this.checkMarioRiding();
        if (this.unk158 !== 0 && this.unk152 !== 0) {
            this.unk152 = (this.unk152 - 1) & 0xFFFF;
            if (this.unk152 === 0) this.unk158 = 0;
        } else if (this.unk150 !== 0) this.unk150 = (this.unk150 - 1) & 0xFFFF;
        else if (!this.checkRailFlag(2) && !this.calcRecycle()) {
            if (this.moveToNextNode(this.unk144)) {
                this.readRailFlag();
                this.moveToShortestNext();
                const t = this.tracer!, yaw = t.graph!.nodes[t.cur].yaw & 0xFFFF;
                if (yaw !== 0xFFFF) this.unk144 = fr(yaw * fr(0.01));
                this.resetStep(this.unk144);
            }
        }
    }
    setGroundCollision() { if (this.unk158 === 0 || this.unk152 === 0) super.setGroundCollision(); }
    perform(cue: number) {
        if (this.unk158 && this.unk152 && (cue & CUE_ENTRY)) cue &= ~CUE_ENTRY;
        super.perform(cue);
    }
    drawn() { return super.drawn() && !(this.unk158 && this.unk152); }
}

export class WoodBlock extends NormalLift {
    /** unk15C its colour, unk164 the colour drawn (TEVREG0) */
    unk15C = [0, 0, 0, 0]; unk164 = [0, 0, 0, 0];
    tevColorMaterialIndex = 0;
    get tevColor0() { return this.unk164; }
    constructor(w: World, name = '木のブロック') { super(w, name); }
    calcRecycle() {
        switch (this.unk148) {
            case 0: this.unk14C = 1; this.unk164 = this.unk15C.slice(); return false;
            case 1:
                if (this.unk14A < 180) { ++this.unk14A; this.unk164 = this.unk15C.slice(); return true; }
                this.unk148 = 0; this.unk14A = 180; this.unk14C = 1;
                return false;
            case 2: {
                if (this.unk14A > 0) {
                    --this.unk14A;
                    const k = fr(this.unk14A / 180);
                    this.unk164 = this.unk15C.map((c) => Math.trunc(fr(c * k)) & 0xFF);
                    this.unk14C = 1;
                    return true;
                }
                this.emit('ms_ex_cube_disa');
                this.resetPosition();
                this.unk164 = this.unk15C.slice();
                return false;
            }
        }
        return false;
    }
    load(s: Stream) {
        super.load(s);
        const r = s.s32(), g = s.s32(), b = s.s32();
        s.s32();
        this.unk164 = [r & 0xFF, g & 0xFF, b & 0xFF, 0xFF];
        this.unk15C = this.unk164.slice();
    }
}

// ---------------------------------------------------------------- TRailBlock
export class RailBlock extends RailMapObj {
    /** unk150..158 the turn per frame (pitch, yaw, roll), unk15C the rotation it turns to, unk168 its turn since the last node */
    unk150 = 0; unk154 = 0; unk158 = 0;
    unk15C = new V3(); unk168 = new V3();
    /** the turns of the nodes before, folded in */
    unk174: Mtx = mtx();
    constructor(w: World, name = '移動板') { super(w, name); }
    initMapObj() {
        super.initMapObj();
        this.onLiveFlag(LF.FORCE_SHADOW);
        this.unk15C.set(this.rot); this.unk168.set(this.rot);
    }
    /** getRootJointMtx: getBaseTRMtx */
    getRootJointMtx(): Mtx | null { return this.baseTR; }
    calcRootMatrix() {
        const m = this.baseTR;
        MsMtxSetRotRPH(m, this.unk168.x, this.unk168.y, this.unk168.z);
        MTXConcat(m, this.unk174, m);
        m[3] = this.pos.x; m[7] = this.pos.y; m[11] = this.pos.z;
        this.anmMtx0 = null;
    }
    control() {
        MapObjBase.prototype.control.call(this);
        this.damageRadius = 300; this.damageHeight = 50;
        this.calcEntryRadius();
        this.checkMarioRiding();
        if (this.calcRecycle() || this.checkRailFlag(2)) return;
        const t = this.tracer!;
        if (this.moveToNextNode(this.unk144)) {
            if (t.graph!.nodes[t.cur].flags & 0x1000) { this.unk14A = 180; this.unk148 = 2; }
            this.moveToShortestNext();
            const speed = t.graph!.nodes[t.cur].speed & 0xFFFF;
            if (speed !== 0xFFFF) this.unk144 = fr(speed * fr(0.01));
            {
                const p = t.graph!.point(t.cur);
                this.unk13C = Math.trunc(fr(fr(Math.sqrt(V3.sub(p, this.pos).squared())) / this.unk144));
            }
            if (this.checkRailFlag(2)) {
                this.unk174 = mtx();
                this.unk168.set(0, 0, 0);
            } else {
                this.unk168.set(this.unk15C);
                const r = mtx();
                MsMtxSetRotRPH(r, this.unk168.x, this.unk168.y, this.unk168.z);
                MTXConcat(r, this.unk174, this.unk174);
                this.unk168.set(0, 0, 0);
                // snap it back to no turn when it's (nearly) back where it started
                const M = this.unk174, ax = [[M[0], M[4], M[8]], [M[1], M[5], M[9]], [M[2], M[6], M[10]]];
                let near = true;
                for (let i = 0; i < 3; i++) {
                    const v = ax[i], l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
                    const n = [fr(v[0] / l), fr(v[1] / l), fr(v[2] / l)];
                    n[i] = fr(n[i] - 1);
                    if (!(Math.abs(n[0]) < 0.02 && Math.abs(n[1]) < 0.02 && Math.abs(n[2]) < 0.02)) near = false;
                }
                if (near) this.unk174 = mtx();
            }
            const n = t.graph!.nodes[t.cur], p = t.graph!.point(t.cur);
            const step = fr(fr(Math.sqrt(V3.sub(this.pos, p).squared())) / this.unk144);
            this.unk15C.set(n.pitch & 0xFFFF, n.yaw & 0xFFFF, n.roll & 0xFFFF);
            this.unk150 = fr(fr(MsAngleDiff(this.unk15C.x, this.unk168.x)) / step);
            this.unk154 = fr(fr(MsAngleDiff(this.unk15C.y, this.unk168.y)) / step);
            this.unk158 = fr(fr(MsAngleDiff(this.unk15C.z, this.unk168.z)) / step);
        } else {
            this.rot.x = fr(this.rot.x + this.unk150); this.rot.y = fr(this.rot.y + this.unk154); this.rot.z = fr(this.rot.z + this.unk158);
            this.unk168.x = fr(this.unk168.x + this.unk150); this.unk168.y = fr(this.unk168.y + this.unk154); this.unk168.z = fr(this.unk168.z + this.unk158);
            this.rot.x = fr(MsWrap(this.rot.x, 0, 360)); this.rot.y = fr(MsWrap(this.rot.y, 0, 360)); this.rot.z = fr(MsWrap(this.rot.z, 0, 360));
        }
    }
}

// ---------------------------------------------------------------- TRollBlock
export class RollBlock extends MapObjBase {
    /** unk138 its spin (degrees), unk13C its speed */
    unk138 = 0; unk13C = 0;
    constructor(w: World, name = '回転板') { super(w, name); }
    load(s: Stream) {
        Actor.prototype.load.call(this, s);
        this.individualName = s.str();
        this.unk13C = fr(s.s32() * fr(0.01));
        this.initMapObj();
        this.makeObjAppeared();
    }
    setGroundCollision() { if (this.colMgr) this.colMgr.moveActiveCollisionMtx(this.rootMtx()); }
    getRootJointMtx(): Mtx | null { return this.rootMtx(); }
    calcRootMatrix() {
        const m = this.baseTR;
        MsMtxSetXYZRPH(m, this.pos.x, fr(this.pos.y - this.yOffset), this.pos.z, this.rot.x, this.rot.y, this.rot.z);
        const r = mtx();
        MsMtxSetRotZ(r, this.unk138);
        MTXConcat(m, r, m);
        this.anmMtx0 = null;
    }
    control() {
        super.control();
        let a = fr(this.unk138 + this.unk13C);
        while (a >= 360) a = fr(a - 360);
        while (a < 0) a = fr(a + 360);
        this.unk138 = a;
    }
}

register('NormalLift', (w, n) => new NormalLift(w, n));
register('WoodBlock', (w, n) => new WoodBlock(w, n));
register('EXKickBoard', (w, n) => new NormalLift(w, n));
register('Kamaboko', (w, n) => new NormalLift(w, n));
register('Uirou', (w, n) => new NormalLift(w, n));
register('Castella', (w, n) => new NormalLift(w, n));
register('Hikidashi', (w, n) => new NormalLift(w, n));
register('YoshiBlock', (w, n) => new WoodBlock(w, n));
for (const k of ['EXRollCube', 'RailBlock', 'RailBlockR', 'RailBlockY', 'RailBlockB']) register(k, (w, n) => new RailBlock(w, n));
for (const k of ['Umaibou', 'GetaGreen', 'GetaOrange', 'RollBlock', 'RollBlockR', 'RollBlockY', 'RollBlockB']) register(k, (w, n) => new RollBlock(w, n));
