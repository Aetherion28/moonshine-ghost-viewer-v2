// The blocks of MoveBG/MapObjBlock.cpp the remaining worlds use: TSandBlock (Gelato's sand
// blocks: stood on, they wait mWaitTimeToFall frames, then crumble away a little each frame and
// come back mSandWaitTime frames later once Mario is far enough off), TIceBlock (Bianco's / the
// secret stages' ice: sprayed, it melts by mMeltSpeedWater; once it's down to mAutoMeltScale of its
// size it melts on its own and is gone at 0.1) and TBrickBlock (hit from below, or by Gooper
// Blooper's attack, it breaks and gives what's hidden in it).
//
// Not here: particles (told as effects), the ice's effect texture matrix (calc: drawing only), rumble.

import { MSF } from '../flags.js';
import { fr, V3 } from '../math.js';
import { World, HitActor, HF, MSG, LF } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { MapObjBase, STATE_NORMAL, UNIQUE_MAKERS, CUE_MOVE } from './base.js';
import { HC } from '../engine.js';
import { V } from '../version.js';
import { HideObjBase } from './hide.js';
import { MapObjGeneral } from './general.js';
import { BreakHideObj } from './monte.js';

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
        this.damageRadius = fr(sc.x * 80); this.damageHeight = fr(sc.y * 250); this.calcEntryRadius();
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

// ---------------------------------------------------------------- TSuperHipDropBlock
/** TSuperHipDropBlock: a TBreakHideObj broken only by a super hip drop (Delfino Plaza's pipe slab to Pianta Village: モンテゲートブロック). */
export class SuperHipDropBlock extends BreakHideObj {
    mMonteBlockBroken = false;
    constructor(w: World, name = 'スーパーヒップドロップブロック') { super(w, name); }
    receiveMessage(_sender: HitActor, msg: number) {
        if (msg === MSG.SUPER_HIP_DROP) {
            this.kill();
            // TFlagManager MSF_PIANTA_PIPE_SLAB_DESTROYED
            if (this.mMonteBlockBroken) this.world.flags.setBool(true, MSF.PIANTA_PIPE_SLAB_DESTROYED);
            this.world.sound(SE.OBJ_SUPERBLOCK_BREAK, this.pos);
            return true;
        }
        return false;
    }
    loadAfter() {
        super.loadAfter();
        if (this.name === 'モンテゲートブロック') {
            this.mMonteBlockBroken = true;
            if ((this.world as any).piantaPipeSlabDestroyed) this.makeObjDead();
            this.onLiveFlag(LF.UNK8);
        }
    }
}

// ---------------------------------------------------------------- TBreakableBlock
/** TBreakableBlock: broken by Mario's hip drop on it */
export class BreakableBlock extends MapObjGeneral {
    constructor(w: World, name = '壊れるブロック') { super(w, name); }
    touchPlayer(_a: HitActor) {
        if (this.marioHipAttack()) {
            // (SMSRumbleMgr->start(0x15, 0x14, mPosition): rumble)
            this.kill();
        }
    }
}
UNIQUE_MAKERS.set('breakable_block', (w) => new BreakableBlock(w));

// ---------------------------------------------------------------- TJuiceBlock
/** TJuiceBlock: the block Yoshi's juice turns an enemy into (TSmallEnemy::changeByJuice drives it) */
export class JuiceBlock extends MapObjBase {
    /** unk138: its colour (GXColorS10, TEVREG0 of material 0) */
    // (alpha, 0x13E: never written by the ROM (ctor, initMapObj, changeByJuice): operator new's leftover)
    unk138 = [0, 0, 0, 0];
    /** unk140: its scale as it grows */
    unk140 = new V3(1, 1, 1);
    /** unk14C: the enemy in it */
    unk14C: any = null;
    tevColorMaterialIndex = 0;
    get tevColor0() { return this.unk138; }
    constructor(w: World, name = 'ジュースブロック') { super(w, name); }
    /** initMapObj (SMS_InitPacket_OneTevColor: tevColor0) */
    initMapObj() { super.initMapObj(); this.unk140.set(1, 1, 1); }
    /** moveObject: gone when its enemy is dead */
    moveObject() {
        super.moveObject();
        if (this.unk14C !== null && this.unk14C.checkLiveFlag(LF.DEAD)) this.kill();
    }
    kill() { this.unk14C = null; this.makeObjDead(); }
    /** touchActor (PAL only): another map object breaks it */
    touchActor(a: HitActor) {
        if (!(V.GMSP01 || V.GMSP01_NX)) { super.touchActor(a); return; }
        if (a.isHitCategory(HC.MAP_OBJECT) && !a.isActorType(AT.JUICE_BLOCK)) this.kill();
    }
}

// ---------------------------------------------------------------- TTelesaBlock
/** TTelesaBlock: a box Boo's block; its joints scaled by unk140 (perform) */
export class TelesaBlock extends JuiceBlock {
    constructor(w: World, name = 'テレサブロック') { super(w, name); }
    get tevColor0() { return undefined as any; }
    initMapObj() { MapObjBase.prototype.initMapObj.call(this); }
    perform(cue: number) {
        this.liveFlag &= ~LF.UNK200;
        if (!this.world.talkMode) super.perform(cue);
        else if (cue & CUE_MOVE) JuiceBlock.prototype.moveObject.call(this);   // (then mMActor->perform: drawing)
    }
    /** perform's CUE_CALC_ANIM: anmMtx(1) *= scale(unk140.x, y, z), anmMtx(0) *= scale(unk140.y, y, z) (the viewer applies them) */
    jointScales() { const u = this.unk140; return [[u.y, u.y, u.z], [u.x, u.y, u.z]]; }
    setGroundCollision() {
        if (!this.colMgr) return;
        this.colMgr.moveActiveCollisionSRT(this.pos, this.rot, this.unk140);
    }
}
UNIQUE_MAKERS.set('JuiceBlock', (w) => new JuiceBlock(w));
UNIQUE_MAKERS.set('TelesaBlock', (w) => new TelesaBlock(w));

register('SuperHipDropBlock', (w, n) => new SuperHipDropBlock(w, n));
register('SandBlock', (w, n) => new SandBlock(w, n));
register('IceBlock', (w, n) => new IceBlock(w, n));
register('BrickBlock', (w, n) => new BrickBlock(w, n));
