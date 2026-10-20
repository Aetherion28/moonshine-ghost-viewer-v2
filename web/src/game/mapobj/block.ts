// The blocks of MoveBG/MapObjBlock.cpp the remaining worlds use: TSandBlock (Gelato's sand
// blocks: stood on, they wait mWaitTimeToFall frames, then crumble away a little each frame and
// come back mSandWaitTime frames later once Mario is far enough off), TIceBlock (Bianco's / the
// secret stages' ice: sprayed, it melts by mMeltSpeedWater; once it's down to mAutoMeltScale of its
// size it melts on its own and is gone at 0.1) and TBrickBlock (hit from below, or by Gooper
// Blooper's attack, it breaks and gives what's hidden in it).
//
// Not here: particles (told as effects), the ice's effect texture matrix (calc: drawing only), rumble.

import { fr, V3 } from '../math.js';
import { World, HitActor, HF, MSG } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { MapObjBase, STATE_NORMAL } from './base.js';
import { HideObjBase } from './hide.js';

// ---------------------------------------------------------------- TSandBlock
const SB = { RESTORING: 2, TOUCHED: 3, FALLING: 4, GONE: 5 };
export class SandBlock extends MapObjBase {
    static mSandScaleUp = fr(0.075); static mSandScaleDown = fr(0.0074999998); static mSandScaleMin = fr(0.05);
    static mWaitTimeToFall = 0x28; static mSandWaitTime = 0x190;
    constructor(w: World, name = '砂ブロック') { super(w, name); }
    touchPlayer(_a: HitActor) {
        if (this.marioIsOn() && this.state === STATE_NORMAL) { this.stateTimer = SandBlock.mWaitTimeToFall; this.state = SB.TOUCHED; }
    }
    control() {
        super.control();
        const C = SandBlock, sc = this.scale;
        switch (this.state) {
            case SB.RESTORING:
                sc.x = fr(sc.x + C.mSandScaleUp); sc.y = fr(sc.y + C.mSandScaleUp); sc.z = fr(sc.z + C.mSandScaleUp);
                if (sc.y >= this.initialScale.x) { sc.set(this.initialScale); this.state = STATE_NORMAL; }
                break;
            case SB.TOUCHED:
                if (!this.isStateTimerEngaged()) { this.setUpMapCollision(1); this.state = SB.FALLING; }
                break;
            case SB.FALLING: {
                sc.y = fr(sc.y - C.mSandScaleDown);
                this.world.sound(SE.OBJ_SANDBLOCK_BREAK, this.pos);
                this.emit('SandBlockBreakA'); this.emit('SandBlockBreakB');
                if (sc.y < C.mSandScaleMin) {
                    sc.x = sc.y; sc.z = sc.y;
                    this.sleep();
                    this.stateTimer = C.mSandWaitTime;
                    this.state = SB.GONE;
                }
                break;
            }
            case SB.GONE: {
                const m = this.world.mario.pos;
                const d = fr(Math.sqrt(V3.sub(m, this.pos).squared()));
                if (!this.isStateTimerEngaged() && d > fr(sc.x * 100)) {
                    this.awake();
                    const keep = sc.clone();
                    sc.set(this.initialScale);
                    this.setUpMapCollision(0);
                    sc.set(keep);
                    this.state = SB.RESTORING;
                }
                break;
            }
        }
    }
    initMapObj() { super.initMapObj(); this.initialScale.set(this.scale); }
}

// ---------------------------------------------------------------- TIceBlock
export class IceBlock extends MapObjBase {
    static mMeltSpeedWater = fr(0.003); static mMeltSpeedAuto = fr(0.004); static mAutoMeltScale = fr(0.2);
    constructor(w: World, name = 'アイスブロック') { super(w, name); }
    getSDLModelFlag() { return 0; }
    touchWater(a: HitActor) {
        const w = this.world, id = MapObjBase.getWaterID(a);
        if (w.water && id >= 0 && (w.water.flag[id] & 0xF) === 1) {
            this.emit('ms_enm_wathit', a.pos);
            w.sound(SE.EN_COMMON_W_HIT_OK, this.pos);
            w.sound(SE.OBJ_ICE_BLOCK_MELT, this.pos);
            const sc = this.scale, k = IceBlock.mMeltSpeedWater;
            sc.x = fr(sc.x - k); sc.y = fr(sc.y - k); sc.z = fr(sc.z - k);
            this.scaledBodyRadius = fr(sc.x * this.data.unk30);
            sc.y = sc.y < 0.01 ? fr(0.01) : sc.y > this.initialScale.y ? this.initialScale.y : sc.y;
            if (sc.x < 0) this.makeObjDead();
            this.collisions.length = 0;
            return 1;
        }
        return 0;
    }
    // (not TMapObjBase::control: it touches nothing)
    control() {
        this.emit('IceBlockA'); this.emit('IceBlockB');
        this.offHitFilter(HF.NO_COLLISION);
        const sc = this.scale;
        this.damageRadius = fr(sc.x * 80); this.damageHeight = fr(sc.y * 250);
        if (sc.y < fr(IceBlock.mAutoMeltScale * this.initialScale.y)) {
            const k = IceBlock.mMeltSpeedAuto;
            sc.x = fr(sc.x - k); sc.y = fr(sc.y - k); sc.z = fr(sc.z - k);
            sc.y = sc.y < 0.01 ? fr(0.01) : sc.y > this.initialScale.y ? this.initialScale.y : sc.y;
            this.scaledBodyRadius = fr(sc.x * this.data.unk30);
            this.world.sound(SE.OBJ_ICE_BLOCK_MELT, this.pos);
            this.setObjHitData(0);
            this.onHitFilter(HF.NO_COLLISION);
            this.removeMapCollision();
            if (sc.x < 0.1) this.makeObjDead();
        }
    }
}

// ---------------------------------------------------------------- TBrickBlock
export class BrickBlock extends HideObjBase {
    constructor(w: World, name = 'レンガブロック') { super(w, name); }
    kill() {
        this.makeObjDead();
        this.emit('BrickBlockA'); this.emit('BrickBlockB'); this.emit('BrickBlockC');
        this.world.sound(SE.OBJ_CLASSIC_BLOCK_B, this.pos);
        this.appearObj(100);
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (sender.isActorType(AT.MARIO) && this.marioHeadAttack()) { this.kill(); return true; }
        if (sender.isActorType(AT.BOSS_GESSO) && msg === MSG.ATTACK) { this.kill(); return true; }
        return false;
    }
}

register('SandBlock', (w, n) => new SandBlock(w, n));
register('IceBlock', (w, n) => new IceBlock(w, n));
register('BrickBlock', (w, n) => new BrickBlock(w, n));
