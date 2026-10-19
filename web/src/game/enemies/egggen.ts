// TEggGenerator / TEggGenManager (Enemy/egggen.cpp): the egg generators (タマゴジェネレータ, scene
// classes EggGenerator / WickedEggGenerator). One is a model (gene_egg_model1.bmd) whose
// animation is held at its start while Mario is within 500 and Yoshi hasn't hatched. Pianta
// Village has the manager (episode 5) but no generator placed.
// (gpMarioOriginal->mYoshi->isHatched: no Yoshi in the sim, taken as not hatched.)

import { MsWrap, sqDist } from '../math.js';
import { World, SpineEnemy, EnemyManager, LF, HC, LiveManager, Stream, Params, SPINE_PARAMS } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';

export class EggGenManager extends EnemyManager {
    constructor(w: World, name = 'タマゴジェネレータマネージャ') { super(w, name); }
    createModelData() { this.createModelDataArray(['gene_egg_model1.bmd']); }
    load(s: Stream) {
        this.saveParams = new Params('/enemy/egggen.prm', this.world.files).read(SPINE_PARAMS);
        super.load(s);
    }
}

export class EggGenerator extends SpineEnemy {
    constructor(w: World, name = 'タマゴジェネレータ') {
        super(w, name);
        this.liveFlag |= LF.UNK10;
        this.liveFlag |= LF.UNK8;
    }
    init(m: LiveManager | null) {
        if (!m) return;
        this.manager = m;
        m.manageActor(this);
        this.mactor = this.createMActorByName('gene_egg_model1.bmd');
        this.initHitActor(AT.GENERATOR, 1, HC.PLAYER, 10, 10, 10, 10);
        this.mactor!.setBckFromIndex(0);
        this.rot.x = MsWrap(this.rot.x - 90, 0, 360);
    }
    control() {
        const m = this.world.mario as any;
        const hatched = !!(m.yoshi && typeof m.yoshi.isHatched === 'function' && m.yoshi.isHatched());
        if (sqDist(this.pos, this.world.mario.pos) < 250000 && !hatched) this.mactor!.setBckFromIndex(0);
    }
}

register('EggGenManager', (w, n) => new EggGenManager(w, n));
register('EggGenerator', (w, n) => new EggGenerator(w, n));
register('WickedEggGenerator', (w, n) => new EggGenerator(w, n));
