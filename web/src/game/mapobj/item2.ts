// The 1-up mushroom (MoveBG/MapObjItem2.cpp's TMushroom1up): kind 0 walks towards Mario once it's
// landed, kind 1 (R) away from him, kind 2 (X) stays put and is there from the start. Touching it
// circles it round Mario's head for 180 frames, then it's gone; one that isn't taken goes after
// 1200 frames (blinking for the last 240).

import { fr, V3, MsCos, MsSin, MsWrap, MsAngleDiff, MsGetRotFromZaxisY } from '../math.js';
import { World, Stream, HitActor, LF, MSG, CUE_ENTRY, CUE_MOVE } from '../engine.js';
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

UNIQUE_MAKERS.set('mushroom1up', (w) => new Mushroom1up(w, 0));
UNIQUE_MAKERS.set('mushroom1upR', (w) => new Mushroom1up(w, 1));
UNIQUE_MAKERS.set('mushroom1upX', (w) => new Mushroom1up(w, 2));
register('Mushroom1up', (w, n) => new Mushroom1up(w, 0, n));
register('Mushroom1upR', (w, n) => new Mushroom1up(w, 1, n));
register('Mushroom1upX', (w, n) => new Mushroom1up(w, 2, n));
