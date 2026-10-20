// TTypicalEnemy / TTypicalManager (Enemy/typicalenemy.cpp): the "typical enemy" (典型敵), the
// simplest TSpineEnemy: it walks the conductor's graph "main" at random (TNerveTypicalGraphWander:
// on its first tick goToRandomNextGraphNode, then walkToCurPathNode at its march / turn speed and
// doShortCut until it reaches the goal, then again), bound by a TWalker. Pinna Park's scenes have a
// TypicalManager (典型敵マネージャー, capacity 1) but place no typical enemy: the one there is made by
// the conductor's createEnemies at the start (at the origin; its graph walk is the one place it can
// call rand(), getRandomNextIndex, once it is on a node).
//
// RNG: goToRandomNextGraphNode (TGraphWeb::getRandomNextIndex) on each goal reached.
//
// Not here: its model (the manager's default TObjManager::createModelData, default.bmd from its
// folder: none in the sim); its parameters file /enemy/typical.prm (not in params.szs: the
// TSpineEnemyParams defaults and mSLMoveSpeed 4, unused by its code).

import { World, Stream, SpineEnemy, EnemyManager, LiveManager, nerve, Spine, PSchema, readParams, SPINE_PARAMS } from '../engine.js';
import { register } from '../scene.js';
import { Walker } from './walker.js';

/** TTypicalParams */
const TYPICAL_PARAMS = { ...SPINE_PARAMS, mSLMoveSpeed: ['f', 4] } satisfies PSchema;

export class TypicalManager extends EnemyManager {
    constructor(w: World, name = '典型敵マネージャ') { super(w, name); }
    load(s: Stream) {
        this.saveParams = readParams('/enemy/typical.prm', this.world.files, TYPICAL_PARAMS);
        super.load(s);
    }
    createEnemyInstance() { return new TypicalEnemy(this.world); }
}

export class TypicalEnemy extends SpineEnemy {
    constructor(w: World, name = '典型敵') { super(w, name); this.binder = new Walker(); }
    init(m: LiveManager | null) {
        super.init(m);
        this.tracer.init(this.world.graphByName('main'));   // gpConductor->getGraphByName("main")
        this.spine!.initWith(TypicalNerves.graphWander);
        this.tracer.reset();
        this.goToShortestNextGraphNode();
    }
}

type S = Spine<TypicalEnemy>;
export const TypicalNerves: Record<string, any> = {};
TypicalNerves.graphWander = nerve<TypicalEnemy>('TNerveTypicalGraphWander', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.goToRandomNextGraphNode();
    if (self.isReachedToGoal()) { spine.pushAfterCurrent(TypicalNerves.graphWander); return true; }
    self.walkToCurPathNode(self.marchSpeed, self.turnSpeed, 0);
    self.doShortCut();
    return false;
});

register('TypicalManager', (w, n) => new TypicalManager(w, n));
