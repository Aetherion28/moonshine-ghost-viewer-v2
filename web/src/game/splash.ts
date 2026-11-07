// TSplashManager and its TWaterSplash pool (Player/SplashManager.cpp, SplashManager.hpp): the
// little water splashes FLUDD's drops leave where they land (TModelWaterManager's newSplash calls,
// game/water.ts). load: 64 splashes on the free list (unk124); newSplash takes the free list's first
// onto the live list (unk118, at its end) with its size and a 16-tick life (none on the diving maps);
// move (CUE_CALC_ANIM, unk10 & 2): each live splash falls (unkC += unk638, y += unkC), its life
// counts down, at 0 it goes back to the free list's end. makeDL (CUE_CALC_VIEW): each one as a view-
// space quad, half-size ((16 - life) / 16) * 100 + 50, alpha life * 255 / 16; one nearer than 250 or
// farther than 3000 is ended (its life 0). The viewer draws the quads (wavedraw.ts SplashDraw).
// Viewer only: nothing in the game reads the splashes back.

import { fr, Mtx } from './math.js';
import { anmFrameRate } from './version.js';
import { NameRef, Stream, World, CUE_CALC_ANIM } from './engine.js';
import { register } from './scene.js';

/** TWaterSplash */
export class WaterSplash {
    /** unk0: the position; unkC: the fall speed */
    unk0 = { x: 0, y: 0, z: 0 }; unkC = 0;
    /** unk10: the life left (ticks); unk11: its slot (the display list's quad) */
    unk10 = 0; unk11 = 0;
}

/** a splash's quad for the viewer: view-space corners (x, y, z four times), its slot, its alpha */
export interface SplashQuad { v: number[]; slot: number; alpha: number; }

export class SplashManager extends NameRef {
    unk10 = 0;
    /** unk118 the live list, unk124 the free list (JSUList: in order) */
    unk118: WaterSplash[] = []; unk124: WaterSplash[] = [];
    unk130: WaterSplash[] = [];
    unk630 = 0; unk634 = 0; unk638 = 0;
    /** unk63C: the TEV's C0 */
    unk63C = [168, 203, 227, 255];
    unk644 = 0; unk648 = 0;

    constructor(public world: World, name = 'SplashManager') { super(name); }

    load(s: Stream) {
        super.load(s);
        this.unk10 = 3;
        this.unk630 = 50;
        this.unk634 = 100;
        const rate = anmFrameRate();
        this.unk638 = fr(fr(rate * -0.5) * rate);
        this.unk118 = []; this.unk124 = []; this.unk130 = [];
        for (let i = 0; i < 64; i++) {
            const sp = new WaterSplash();
            sp.unk11 = i;
            this.unk130.push(sp);
            this.unk124.push(sp);
        }
        this.unk644 = 3000;
        this.unk648 = 16;
        this.world.splashManager = this;
    }

    /** newSplash(pos, size) */
    newSplash(x: number, y: number, z: number, size: number) {
        const m = this.world.map;
        if (this.unk124.length !== 0 && !(m === 0x39 || m === 0x2C || m === 0x10)) {
            const sp = this.unk124.shift()!;
            this.unk118.push(sp);
            sp.unk0.x = x; sp.unk0.y = y; sp.unk0.z = z;
            sp.unkC = size;
            sp.unk10 = this.unk648;
        }
    }

    move() {
        if (!(this.unk10 & 2)) return;
        for (let i = 0; i < this.unk118.length;) {
            const sp = this.unk118[i];
            sp.unkC = fr(sp.unkC + this.unk638);
            sp.unk0.y = fr(sp.unk0.y + sp.unkC);
            if (sp.unk10 !== 0) sp.unk10--;
            if (sp.unk10 === 0) { this.unk118.splice(i, 1); this.unk124.push(sp); }
            else i++;
        }
    }

    perform(cue: number) {
        if (cue & CUE_CALC_ANIM) this.move();
    }

    /**
     * makeDL (CUE_CALC_VIEW, unk10 & 1): the live splashes as view-space quads under the view matrix
     * (game Mtx, row-major 3x4); the ones out of the depth range end here.
     */
    makeDL(view: ArrayLike<number> | Mtx): SplashQuad[] {
        const out: SplashQuad[] = [];
        if (!(this.unk10 & 1)) return out;
        for (const sp of this.unk118) {
            const p = sp.unk0;
            const x = fr(view[0] * p.x + view[1] * p.y + view[2] * p.z + view[3]);
            const y = fr(view[4] * p.x + view[5] * p.y + view[6] * p.z + view[7]);
            const z = fr(view[8] * p.x + view[9] * p.y + view[10] * p.z + view[11]);
            if (z < -this.unk644 || -250 < z) { sp.unk10 = 0; continue; }
            const h = fr(fr(fr(fr(this.unk648 - sp.unk10) / this.unk648) * this.unk634) + this.unk630);
            const alpha = Math.trunc((sp.unk10 * 255) / this.unk648) & 0xFF;
            out.push({ v: [fr(x - h), fr(y + h), z, fr(x + h), fr(y + h), z, fr(x + h), fr(y - h), z, fr(x - h), fr(y - h), z], slot: sp.unk11, alpha });
        }
        return out;
    }
}

declare module './engine.js' {
    interface World {
        /** gpSplashManager */
        splashManager: SplashManager | null;
    }
}
World.prototype.splashManager = null;

register('SplashManager', (w, n) => new SplashManager(w, n));
