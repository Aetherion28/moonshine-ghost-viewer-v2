// MoveBG/MapObjTown.cpp's stage switches and water sprays: TMapObjChangeStage (touching it
// takes Mario to another stage: told as a 'nextStage' event with the stage's number),
// TMapObjChangeStageHipDrop (ground-pounding it does) and TMapObjWaterSpray (a fountain's spray:
// its particle emitted each frame, told as an effect with its rate, size and colour).

import { fr, V3 } from '../math.js';
import { World, Stream, HitActor, HF, MSG, ANM_BCK } from '../engine.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { MapObjBase } from './base.js';
import { marioHipDropping, marioSpeedY, marioGroundLevel } from './lib.js';

export class MapObjChangeStage extends MapObjBase {
    unk138 = 0;
    constructor(w: World, name = 'ステージ切替オブジェ') { super(w, name); }
    protected setNextStage() { this.world.events.push({ t: this.world.tickCount, kind: 'nextStage', data: { stage: this.unk138, p: this.pos.clone(), name: this.name } }); }
    touchPlayer(_a: HitActor) {
        this.setNextStage();
        this.onHitFilter(HF.NO_COLLISION);
        this.collisions.length = 0;
        this.world.sound(SE.MA_WARP_EX, this.pos);
    }
    load(s: Stream) { super.load(s); this.unk138 = s.u32(); }
}
export class MapObjChangeStageHipDrop extends MapObjChangeStage {
    touchPlayer(_a: HitActor) {
        const w = this.world;
        if (marioHipDropping(w) && w.mario.pos.y + marioSpeedY(w) < marioGroundLevel(w)) {
            this.setNextStage();
            this.emit('exHahen');
        }
    }
}

export class MapObjWaterSpray extends MapObjBase {
    unk138 = 0x154; unk13C = 0; unk140 = new V3(); unk14C = { r: 0, g: 0, b: 0, a: 0 };
    constructor(w: World, name = '汎用水しぶき') { super(w, name); }
    /** calc: the emitter, each frame (its rotation, rate, particle size and colour are the members here) */
    calc() { this.world.effect(this.unk138 === 0x154 ? 'shibCyl1' : 'shibCub1', this.pos, this.scale); }
    load(s: Stream) {
        super.load(s);
        this.unk138 = this.individualName === 'WaterSprayCylinder' ? 0x154 : 0x155;
        this.unk13C = s.f32();
        this.unk13C = this.unk13C > 100 ? 0.5 : fr(this.unk13C / 100);
        let sc = s.f32();
        sc = sc === -1 ? 1 : fr(sc / 100);
        this.unk140.set(sc, sc, sc);
        this.unk14C = { r: s.u32() & 0xFF, g: s.u32() & 0xFF, b: s.u32() & 0xFF, a: s.u32() & 0xFF };
    }
}

// ---------------------------------------------------------------- TRedCoinSwitch
/**
 * Ground-pounding it starts its press, locks the pad for twice its animation plus 60 ticks
 * (TMarioGamePad::mDisabledFrames) and puts out the eight red coins' "pressed" flag once the
 * animation ends. The red coins (赤コイン 0..7) are hidden until then.
 */
export class RedCoinSwitch extends MapObjBase {
    /** the red coins' time limit, in frames */
    unk138 = 0;
    constructor(w: World, name = '赤コインスイッチ') { super(w, name); }
    receiveMessage(_s: HitActor, msg: number) {
        if (msg === MSG.HIP_DROP) {
            this.startBck('redcoinswitch');
            const fc = this.mactor && this.mactor.getFrameCtrl(ANM_BCK);
            const pad = (this.world.mario as any).mGamePad;
            if (pad && fc) pad.invalidate(Math.trunc(fr(fr(fc.end * 2) + 60)));
            this.world.sound(SE.OBJ_AP_BUTTON, this.pos);
            this.removeMapCollision();
            this.onHitFilter(HF.NO_COLLISION);
            this.state = 2;
            return true;
        }
        return false;
    }
    control() {
        super.control();
        switch (this.state) {
            case 2:
                if (this.mactor && this.mactor.curAnmEndsNext(ANM_BCK)) {
                    this.stateTimer = 120; this.state = 3;
                    // TFlagManager MSF_RED_COIN_SWITCH_PRESSED
                    (this.world as any).redCoinSwitchPressed = true;
                }
                break;
            case 3: if (!this.isStateTimerEngaged()) this.state = 4; break;
        }
    }
    loadAfter() {
        super.loadAfter();
        for (let i = 0; i < 8; i++) { const c = this.world.search(`赤コイン ${i}`) as MapObjBase | null; if (c) c.makeObjDead(); }
    }
    load(s: Stream) {
        super.load(s);
        const t = s.u32() | 0;
        this.unk138 = t <= 0 ? 1200 : t * 10;
        // TODO: in a secret stage whose Shine isn't got yet it's gone (SMS_getShineIDofExStage and the
        // Shine flags: not in the sim)
    }
}

register('RedCoinSwitch', (w, n) => new RedCoinSwitch(w, n));
register('MapObjChangeStage', (w, n) => new MapObjChangeStage(w, n));
register('MapObjChangeStageHipDrop', (w, n) => new MapObjChangeStageHipDrop(w, n));
register('MapObjWaterSpray', (w, n) => new MapObjWaterSpray(w, n));
