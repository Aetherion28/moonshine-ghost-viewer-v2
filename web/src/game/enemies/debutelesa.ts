// TDebuTelesa / TDebuTelesaManager (Enemy/DebuTelesa.cpp, デブテルサ): the big fat Boos asleep in
// Hotel Delfino's corridors, blocking the way until Yoshi eats them. One does nothing but play its
// wait (snoring) animation: it isn't knocked over by stomps, hip drops or punches (those messages
// are refused), water does nothing to it, and it never moves (it doesn't touch the map either:
// LIVE_FLAG_UNK10 skips its bind). Touching it hurts Mario. Only being eaten (HIT_MESSAGE_UNKB)
// kills it, through TSmallEnemy::receiveMessage.
//
// It is a TSmallEnemy, not a TTelesa (nothing of telesa.ts is used): its init() does its own
// setup (no random body scale or turn speed: the manager's prm range is 1..1 anyway) and its
// reset() is empty.
//
// Not here: its ZZZ and drool particles (emitEffects), the "eaten" sound
// (MSD_SE_EN_DB_TELSA_EATEN), its animation sounds.

import { World, LF, HF, HC, MSG, nerve, Spine, Stream, HitActor, ANM_BCK } from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemy, SmallEnemyManager, SmallEnemyNerves, smallParams } from './smallEnemy.js';
import { isInOtherFastCube } from './animal.js';
import { register } from '../scene.js';

export class DebuTelesaManager extends SmallEnemyManager {
    constructor(w: World, name = 'デブテルサマネージャー') { super(w, name); }
    load(s: Stream) {
        const p: any = smallParams('/enemy/debuTelesa.prm', this.world.files);
        // (set after the .prm is read: these override it)
        p.mSLAttackRadius = 240; p.mSLAttackHeight = 330; p.mSLDamageRadius = 220; p.mSLDamageHeight = 300;
        p.mSLBodyScaleLow = p.scaleLow = 1; p.mSLBodyScaleHigh = p.scaleHigh = 1;
        this.saveParams = p;
        super.load(s);
        this.unk5C = 0;
    }
    createModelData() { this.createModelDataArray(['debuTelesa.bmd']); }
    createEnemyInstance() { return new DebuTelesa(this.world); }
    /** clipEnemies: the frustum from near 350 to mSLFarClip (radius unk3C); one in another fast cube is clipped */
    clipActors() {
        const p = this.saveParams, far = p ? p.mSLFarClip : 5000, r = p ? p.mSLClipRadius : 300;
        for (const o of this.objs as DebuTelesa[]) {
            if (o.checkLiveFlag(LF.UNK2000) && isInOtherFastCube(this.world, o.pos)) o.onLiveFlag(LF.CLIPPED_OUT);
            else if (this.world.inView(o.pos, r, far, 350)) o.offLiveFlag(LF.CLIPPED_OUT);
            else o.onLiveFlag(LF.CLIPPED_OUT);
        }
    }
}

export class DebuTelesa extends SmallEnemy {
    unk194 = 0;
    constructor(w: World, name = 'デブテルサ') { super(w, name); this.onLiveFlag(LF.UNK10); }
    init(m: any) {
        this.manager = m;
        m.manageActor(this);
        this.setMActorAndKeeper();
        this.spine!.initWith(DebuTelesaNerves.wait);
        this.initCollision();
        // (initAnmSound; the null_yodare / jnt_Rhand joints are for its particles)
        this.groundPlane = this.world.illegal;
    }
    reset() { }
    initCollision() {
        this.initHitActor(AT.DEBU_TELESA, 1, HC.PLAYER, 10, 10, 10, 10);
        this.offHitFilter(HF.NO_COLLISION);
    }
    // calcRootMatrix: TSpineEnemy's (then emitEffects: particles)
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (msg === MSG.TRAMPLE || msg === MSG.HIP_DROP || msg === MSG.PUNCH) return false;
        // (MSG.UNKB, eaten: its sound)
        return super.receiveMessage(sender, msg);
    }
    behaveToWater(_a: HitActor) { }
    attackToMario() { this.sendAttackMsgToMario(); }
    isCollidMove(_a: HitActor) { return false; }
    doKeepDistance() { return true; }
    setDeadAnm() { this.mactor!.getFrameCtrl(ANM_BCK)!.init(1); }
    isDying() { return this.spine!.getLatestNerve() === SmallEnemyNerves.die; }
}

type S = Spine<DebuTelesa>;
export const DebuTelesaNerves: Record<string, any> = {};
DebuTelesaNerves.wait = nerve<DebuTelesa>('TNerveDebuTelesaWait', (spine: S) => {
    if (spine.time === 0) spine.body.mactor!.setBck('debutelesa_wait');
    return false;
});

register('DebuTelesaManager', (w, n) => new DebuTelesaManager(w, n));
register('DebuTelesa', (w, n) => new DebuTelesa(w, n));
