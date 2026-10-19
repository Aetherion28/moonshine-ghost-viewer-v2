// TEffectObjBase / TEffectObjManager (Enemy/effectObj.cpp): the fires (炎, scene class
// EffectFire) on Pianta Village's ground. Each is a hit actor that burns Mario (BURN) while it
// burns (unk68 == 2) and is put out by mostly spraying it: every water hit takes 1 off unk70
// (200 of unk6C), and one at 0 puts it out (BS_WANWAN_TO_COOL, MOE_FIRE_OFF) for good. The fire
// particles are drawn at mScaling * unk70 / unk6C every tick it burns (they shrink as it's
// sprayed): the viewer reads that from fireScale(). The manager (エフェクト炎マネージャー) is one of
// the conductor's other objects and performs every fire, then its own five spare ones (made but
// never loaded or placed: they never burn).

import { V3 } from '../math.js';
import { World, NameRef, HitActor, HF, HC, MSG, Stream, Actor, CUE_MOVE } from '../engine.js';
import { AT } from '../actortypes.js';
import { SE } from '../sound.js';
import { register } from '../scene.js';

const COOL_EFFECT_OBJ_NUM = 5;
/** CUE_DRAW (JDrama's drawing cue: the sim has none) */
const CUE_DRAW = 0x8;

export const EFFECT_OBJ_OFF = 0, EFFECT_OBJ_START = 1, EFFECT_OBJ_BURNING = 2, EFFECT_OBJ_PUT_OUT = 3;

export class EffectObjBase extends HitActor {
    /** its state (EFFECT_OBJ_*) */
    unk68 = 0;
    /** the water it takes (unk6C) and has left to take (unk70) */
    unk6C = 0; unk70 = 0;
    /** the ticks it has burnt */
    unk74 = 0;
    constructor(public world: World, name = '') { super(name); }
    load(s: Stream) {
        Actor.prototype.load.call(this, s);
        this.init();
        const m = effectObjManager(this.world);
        if (m) m.addListEffectObj(this);
    }
    init() {
        this.initHitActor(AT.EFFECT_ENEMY, 5, HC.PLAYER, 30, 150, 30, 150);
        this.reset();
    }
    reset() {
        this.unk68 = EFFECT_OBJ_START;
        this.unk6C = 200; this.unk70 = 200;
        this.offHitFilter(HF.NO_COLLISION);
        this.unk74 = 0;
    }
    perform(cue: number) {
        if (cue & CUE_MOVE) {
            if (this.unk68 === EFFECT_OBJ_START) { this.unk74 = 0; this.unk68 = EFFECT_OBJ_BURNING; }
            this.moveObject();
        }
    }
    receiveMessage(sender: HitActor, msg: number) {
        if (msg === MSG.SPRAYED_BY_WATER) { this.behaveToWater(sender); return true; }
        return false;
    }
    /** The fire particles' scale while it burns (VECScale(mScaling, unk70 / unk6C)), else null. */
    fireScale(): V3 | null { return this.unk68 === EFFECT_OBJ_BURNING ? this.scale.clone().scale(this.unk70 / this.unk6C) : null; }
    moveObject() {
        if (this.unk68 === EFFECT_OBJ_BURNING) {
            this.unk74 += 1;
            // (MS_MAP_FIRE_C / _A / _B at fireScale(): drawn by the viewer from the state)
            this.world.sound(SE.OBJ_CALM_FLAME, this.pos);
        }
        if (this.unk68 === EFFECT_OBJ_PUT_OUT) this.unk68 = EFFECT_OBJ_OFF;
        for (const c of this.collisions.slice()) if (c.isActorType(AT.MARIO)) this.world.mario.receiveMessage(this, MSG.BURN);
    }
    behaveToWater(_a: HitActor) {
        if (this.unk68 !== EFFECT_OBJ_BURNING) return;
        if (this.unk70 > 0) { this.unk70 -= 1; return; }
        this.world.sound(SE.BS_WANWAN_TO_COOL, this.pos);
        this.unk68 = EFFECT_OBJ_PUT_OUT;
        this.onHitFilter(HF.NO_COLLISION);
        this.world.effect('moeFireOff', this.pos, this.scale);
    }
    forceKill() { }
}

/** gpEffectObjManager */
export function effectObjManager(w: World): EffectObjManager | null { return ((w as any).effectObjManager as EffectObjManager) || null; }

export class EffectObjManager extends NameRef {
    unk10 = 0;
    /** unk14: the fires loaded */
    list: EffectObjBase[] = [];
    /** unk24 */
    spares: EffectObjBase[] = [];
    constructor(public world: World, name = 'エフェクト炎マネージャー') {
        super(name);
        world.conductor.others.push(this);
        (world as any).effectObjManager = this;
        for (let i = 0; i < COOL_EFFECT_OBJ_NUM; ++i) this.spares.push(new EffectObjBase(world));
    }
    generateEffect(_p: V3) { }
    perform(cue: number) {
        if (cue & (CUE_DRAW | CUE_MOVE)) {
            for (const o of this.list) o.perform(cue);
            for (const o of this.spares) o.perform(cue);
        }
    }
    addListEffectObj(o: EffectObjBase) { this.list.push(o); ++this.unk10; }
}

register('EffectObjManager', (w, n) => new EffectObjManager(w, n));
register('EffectFire', (w, n) => new EffectObjBase(w, n));
