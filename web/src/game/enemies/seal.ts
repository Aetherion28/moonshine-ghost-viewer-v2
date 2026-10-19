// TSeal / TSealManager (Enemy/seal.cpp): the orange goop seals (オレンジシール) that block Pianta
// Village's passages. One is a static collision (gene_orange_col1.col, set up at its place) and
// a model that sleeps until Mario comes within 1000 units, then wakes and wobbles until he is
// 1500 away again; touching it hurts (ATTACK every movement tick). Water does nothing to it
// unless it is Yoshi's juice (gpModelWaterManager->unk5D5F, water.ts's juice): then it melts
// (TNerveSealDie), its collision taken out. The viewer has no Yoshi, so juice is always 0 and
// the seals stay — as they do for a Mario without Yoshi.

import { MsWrap } from '../math.js';
import { World, SpineEnemy, EnemyManager, LF, HF, HC, MSG, nerve, Spine, LiveManager, CUE_MOVE, CUE_CALC_ANIM, Stream } from '../engine.js';
import { AT } from '../actortypes.js';
import { ObjCollisionManager } from '../mapobj/objcol.js';
import { SE } from '../sound.js';
import { register } from '../scene.js';

export class SealManager extends EnemyManager {
    constructor(w: World, name = 'シールマネージャー') { super(w, name); }
    createModelData() { this.createModelDataArray(['gene_orange_model1.bmd']); }
    load(s: Stream) { super.load(s); }
}

export class Seal extends SpineEnemy {
    /** the water hits it took this tick (counted, never read) */
    unk150 = 0;
    colManager: ObjCollisionManager | null = null;
    constructor(w: World, name = '') {
        super(w, name);
        this.onLiveFlag(LF.UNK10);
    }
    init(m: LiveManager | null) {
        this.manager = m;
        if (m) m.manageActor(this);
        this.mactor = this.createMActorByName('gene_orange_model1.bmd');
        const s = 100 * this.scale.x;
        this.initHitActor(AT.SEAL, 1, HC.PLAYER | HC.WATER, s, s, s, s);
        this.offHitFilter(HF.NO_COLLISION);
        this.world.addToGroup('敵グループ', this);
        this.rot.x = MsWrap(this.rot.x + 270, 0, 360);
        this.colManager = new ObjCollisionManager(this.world, 1, '/scene/seal', this);
        this.colManager.init('gene_orange_col1.col', 2, null);
        this.colManager.setUpActiveCollisionTRS(this.pos, this.rot, this.scale);
        this.mapCollision = this.colManager;
        this.resetHitPoints();
        this.spine!.initWith(SealNerves.sleep);
    }
    receiveMessage(sender: any, msg: number) {
        if (sender.isActorType(AT.WATER) && msg === MSG.SPRAYED_BY_WATER) {
            this.world.effect('enemyWaterHit', sender.pos);
            this.world.sound(SE.EN_COMMON_W_HIT_OK, sender.pos);
            if (this.world.water && this.world.water.juice !== 0) {
                this.world.sound(SE.ERASE_SCRAWL, sender.pos);
                if (!this.spine!.isNerve(SealNerves.die)) {
                    const c = this.colManager!.getActiveCollision();
                    if (c) c.remove();
                    this.spine!.pushNerve(SealNerves.die);
                }
                this.unk150++;
                return true;
            }
            return true;
        }
        return false;
    }
    calcRootMatrix() { this.calcRootMatrixBasic(); }
    perform(cue: number) {
        if (!this.checkLiveFlag(LF.DEAD | LF.HIDDEN) && (cue & CUE_MOVE)) {
            for (const a of this.collisions.slice()) if (a.isActorType(AT.MARIO)) a.receiveMessage(this, MSG.ATTACK);
        }
        super.perform(cue);
        if (cue & CUE_MOVE) { this.updateSquareToMario(); this.unk150 = 0; }
        if ((cue & CUE_CALC_ANIM) && !this.checkLiveFlag(LF.DEAD | LF.HIDDEN) && this.distToMarioSq < 2250000) this.world.sound(SE.EN_ORANGESEAL_WAIT, this.pos);
    }
}

type S = Spine<Seal>;
export const SealNerves = {
    sleep: nerve<Seal>('TNerveSealSleep', (spine: S) => {
        const self = spine.body, a = self.mactor!;
        if (spine.time === 0 && !a.checkCurBckFromIndex(1)) a.setBckFromIndex(-1);
        if (self.distToMarioSq < 1000000) { spine.pushAfterCurrent(SealNerves.wait); return true; }
        if (a.curAnmEndsNext(0) && a.checkCurBckFromIndex(1)) a.setBckFromIndex(-1);
        return false;
    }),
    wait: nerve<Seal>('TNerveSealWait', (spine: S) => {
        const self = spine.body, a = self.mactor!;
        if (spine.time === 0) a.setBckFromIndex(3);
        if (a.curAnmEndsNext(0) && a.checkCurBckFromIndex(3)) a.setBckFromIndex(2);
        if (self.distToMarioSq > 2250000 && a.curAnmEndsNext(0)) {
            a.setBckFromIndex(1);
            spine.pushAfterCurrent(SealNerves.sleep);
            return true;
        }
        return false;
    }),
    die: nerve<Seal>('TNerveSealDie', (spine: S) => {
        const self = spine.body, a = self.mactor!;
        if (spine.time === 0) {
            a.setBckFromIndex(0);
            self.world.effect('sealMelt', self.pos, self.scale);
        }
        self.world.sound(SE.WT_BOSS_FADEAWAY, self.pos);
        if (a.curAnmEndsNext(0)) {
            self.onHitFilter(HF.NO_COLLISION);
            self.kill();
            spine.pushAfterCurrent(SealNerves.sleep);
            return true;
        }
        return false;
    }),
};

register('SealManager', (w, n) => new SealManager(w, n));
register('OrangeSeal', (w, n) => new Seal(w, n));
