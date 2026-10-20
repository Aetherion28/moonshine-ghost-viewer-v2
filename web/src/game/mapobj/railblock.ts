// The lifts that ride a rail (MoveBG/MapObjRailBlock.cpp): TNormalLift waits at nodes flagged
// 0x800 (the node's pitch: frames), takes the node's yaw / 100 as its speed from there, and on a
// node flagged 0x1000 goes away and comes back at its start after the node's roll in frames;
// TWoodBlock (Pianta Village's) fades its colour out instead of blinking before it starts over.
// TRailMapObj itself is in cloud.ts.

import { fr } from '../math.js';
import { World, Stream, CUE_ENTRY } from '../engine.js';
import { register } from '../scene.js';
import { MapObjBase } from './base.js';
import { RailMapObj } from './cloud.js';

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

register('NormalLift', (w, n) => new NormalLift(w, n));
register('WoodBlock', (w, n) => new WoodBlock(w, n));
