// Ricco Harbor's moving hooks (TRiccoHook, Enemy/riccohook.cpp): a hook that rides its graph at
// mSLMoveSpeed, waiting at nodes flagged 0x800 for the node's pitch in frames, with a rope
// (THookTake, an ELASTIC_CODE pole 900 below it) Mario climbs like a bar (TMario::barWait's
// elastic-code case: he slides down it unless he climbs).

import { fr, V3, MsSin, MsCos } from '../math.js';
import { World, Stream, HitActor, TakeActor, LF, HF, HC, MSG, CUE_MOVE, nerve, Spine, SpineEnemy, EnemyManager, readParams, SPINE_PARAMS, PSchema } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { psVecNormalize } from '../camera/lib.js';

const HOOK_PARAMS = { ...SPINE_PARAMS, mSLHitHeight: ['f', 900], mSLHitRadius: ['f', 120], mSLHangRadius: ['f', 30], mSLMoveSpeed: ['f', 4] } satisfies PSchema;

export class RiccoHookManager extends EnemyManager {
    constructor(w: World, name = 'フックマネージャ') { super(w, name); }
    load(s: Stream) {
        this.saveParams = readParams('/enemy/riccohook.prm', this.world.files, HOOK_PARAMS);
        super.load(s);
    }
    createModelData() { this.createModelDataArray(['riccohook.bmd']); }
    createEnemyInstance(): SpineEnemy | null { return null; }
}

/** THookTake: the rope Mario hangs from */
export class HookTake extends TakeActor {
    constructor(public owner: RiccoHook, name = 'フックつかみ') {
        super(name);
        const P = owner.H;
        this.initHitActor(AT.ELASTIC_CODE, 1, HC.PLAYER, P.mSLHitRadius, P.mSLHitHeight, P.mSLHitRadius, P.mSLHitHeight);
        owner.world.addToGroup('オブジェクトグループ', this);
    }
    getTakingMtx() { return null; }
    getRadiusAtY(_y: number) { return this.owner.H.mSLHangRadius; }
    receiveMessage(sender: HitActor, msg: number) {
        if (sender.actorType === AT.MARIO) {
            if (msg === MSG.ATTACH) { this.held = sender as TakeActor; return true; }
            if (msg === MSG.THROWN || msg === MSG.DETACH) { this.held = null; return true; }
        }
        return false;
    }
    perform(cue: number) {
        if (cue & CUE_MOVE) { this.pos.set(this.owner.pos); this.pos.y = fr(this.pos.y - 900); }
        if ((cue & CUE_MOVE) && this.held) {
            // moveHeldObject: Mario moved on by the hook's position delta
            const p = this.held.pos.clone().add(this.owner.posDelta).fround();
            const m = this.held as any;
            if (typeof m.moveRequest === 'function') m.moveRequest(p);
        }
    }
}

export class RiccoHook extends SpineEnemy {
    mHookTake: HookTake | null = null; mTimer = 0;
    get H(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'フック') { super(w, name); }
    init(m: any) {
        super.init(m);
        this.mactor = this.createMActor(0);
        this.spine!.initWith(HookNerves.graphWander);
        this.onHitFilter(HF.NO_COLLISION);
        this.mHookTake = new HookTake(this);
        this.tracer.reset();
        this.goToShortestNextGraphNode();
        this.marchSpeed = this.H.mSLMoveSpeed;
        this.turnSpeed = 10;
        this.onLiveFlag(LF.UNK10);
    }
    kill() { }
    receiveMessage(_s: HitActor, _m: number) { return false; }
    perform(cue: number) {
        super.perform(cue);
        if (this.mHookTake) this.mHookTake.perform(cue);
        if ((cue & CUE_MOVE) && this.mTimer > 0) this.mTimer--;
    }
}

type S = Spine<RiccoHook>;
export const HookNerves: Record<string, any> = {};
HookNerves.graphWander = nerve<RiccoHook>('TNerveRHGraphWander', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        const y = self.rot.y;
        self.goToDirectedNextGraphNode(new V3(fr(1 * MsSin(y)), 0, fr(1 * MsCos(y))));
    }
    if (V3.sub(self.goal104.point(), self.pos).length() < 10) {
        const t = self.tracer, n = t.graph && t.cur >= 0 ? t.graph.nodes[t.cur] : null;
        if (n && (n.flags & 0x800)) self.mTimer = n.pitch;
        spine.pushAfterCurrent(HookNerves.graphWander);
        return true;
    }
    if (!self.tracer.graph || self.tracer.graph.isDummy()) return false;
    if (self.mTimer > 0) return false;
    const d = V3.sub(self.goal.point(), self.pos);
    psVecNormalize(d, d);
    d.scale(self.marchSpeed).fround();
    self.pos.add(d).fround();
    return false;
});

register('RiccoHookManager', (w, n) => new RiccoHookManager(w, n));
register('RiccoHook', (w, n) => new RiccoHook(w, n));
