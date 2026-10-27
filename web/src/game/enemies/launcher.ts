// TLauncher / TCommonLauncher (Enemy/launcher.cpp): the goop generators (コモンランチャー) that
// throw out one of another manager's enemies every mLaunchPeriod movement ticks, on the
// launcher's own graph. Water hurts them (5 hit points, one back every 1200 ticks of quiet);
// at 0 they burst and stay dead. Touching one hurts Mario.
//
// TLauncher is the base (its own state machine, TLauncherParams' launch period); TCommonLauncher
// overrides its states with the model's animations (generator_model1.bmd: 0 launch, 1 damage,
// 2 dead, 3 wait).

import { fr, V3, MsRandF, MsWrap } from '../math.js';
import { World, SpineEnemy, EnemyManager, LF, HF, HC, MSG, Stream, HitActor, PSchema, Params, SPINE_PARAMS, CUE_MOVE, CUE_CALC_ANIM, ANM_BCK, nerve, LiveManager } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { getFarOutEnemy, throwOut } from './generator.js';
import { SE } from '../soundids.js';
import '../sound.js';

/** TLauncherParams */
export const LAUNCHER_PARAMS = { ...SPINE_PARAMS, mSLLaunchPeriod: ['i', 180] } satisfies PSchema;

const STATE_INITIAL = 0, STATE_HITBYWATER = 1, STATE_NORMAL = 2, STATE_LAUNCH = 3, STATE_DIE = 4;

/** TNerveWaitForever<TLiveActor> */
export const waitForever = nerve('TNerveWaitForever', () => false);

export class Launcher extends SpineEnemy {
    state = STATE_NORMAL; nextState = 0; ticksInState = 0; launchCooldown = 0; regenTimer = 0;
    constructor(w: World, name = '') { super(w, name); }
    init(m: LiveManager | null) {
        super.init(m);
        this.spine!.initWith(waitForever);
        const P = this.getSaveParam();
        if (P) this.launchCooldown = Math.trunc(fr(P.mSLLaunchPeriod * MsRandF()));
        this.actorType = AT.LAUNCHER;
        this.onHitFilter(HC.WATER);
        this.attackRadius = 0; this.attackHeight = 0; this.damageRadius = 100; this.damageHeight = 100;
        this.calcEntryRadius();
        this.offHitFilter(HF.NO_COLLISION);
    }
    receiveMessage(sender: HitActor, msg: number) {
        if (this.checkLiveFlag(LF.DEAD)) return false;
        if (this.state === STATE_DIE) return false;
        if (sender.actorType === AT.WATER && msg === MSG.SPRAYED_BY_WATER) {
            this.world.effect('enemyWaterHit', sender.pos);
            this.world.sound(SE.EN_COMMON_W_HIT_OK, this.pos);
            if (this.state === STATE_HITBYWATER) return true;
            this.changeState(STATE_HITBYWATER);
            return true;
        }
        return false;
    }
    bind() { }
    control() {
        switch (this.state) {
            case STATE_INITIAL: this.stateInitial(); break;
            case STATE_NORMAL: this.stateNormal(); break;
            case STATE_HITBYWATER: this.stateHitByWater(); break;
            case STATE_LAUNCH: this.stateLaunch(); break;
            case STATE_DIE: this.stateDie(); break;
        }
        if (this.state !== this.nextState) { this.state = this.nextState; this.ticksInState = 0; }
        else ++this.ticksInState;
    }
    resetLaunchTimer() { const P = this.getSaveParam(); this.launchCooldown = P ? P.mSLLaunchPeriod : 0; }
    getProperEnemy(name: string | null): SpineEnemy | null {
        const m = name ? (this.world.conductor.getManagerByName(name) as EnemyManager | null) : null;
        if (!m) return null;
        const e = getFarOutEnemy(m);
        if (!e) return null;
        e.tracer.init(this.tracer.graph!);
        return e;
    }
    changeState(s: number) { this.nextState = s; }
    stateInitial() { if (this.ticksInState > 12) this.changeState(STATE_NORMAL); }
    stateHitByWater() {
        if (this.ticksInState === 0) this.decHitPoints();
        if (this.ticksInState > 12) this.changeState(this.hitPoints === 0 ? STATE_DIE : STATE_NORMAL);
    }
    stateNormal() { --this.launchCooldown; if (this.launchCooldown <= 0) this.changeState(STATE_LAUNCH); }
    stateLaunch() { if (this.ticksInState > 12) { this.resetLaunchTimer(); this.changeState(STATE_NORMAL); } }
    stateDie() { if (this.ticksInState > 12) { this.kill(); this.resetLaunchTimer(); this.changeState(STATE_NORMAL); } }
    /** mMActor->curAnmEndsNext() (no model: as if it had ended). */
    anmEndsNext() { return this.mactor ? this.mactor.curAnmEndsNext(ANM_BCK) : true; }
}

export class LauncherManager extends EnemyManager {
    constructor(w: World, name = '') { super(w, name); }
    load(s: Stream) {
        this.saveParams = new Params('/enemy/launcher.prm', this.world.files).read(LAUNCHER_PARAMS);
        super.load(s);
    }
}

export class CommonLauncher extends Launcher {
    unk164: string | null = null;
    launchPeriod = 120;
    constructor(w: World, name = 'コモンランチャー') { super(w, name); }
    init(m: LiveManager | null) {
        // (no TSpineEnemy::init: its own model and hit area)
        if (m) { this.manager = m; m.manageActor(this); this.mactor = this.createMActorByName('generator_model1.bmd'); }
        else this.world.conductor.aloneActors.push(this);
        this.spine!.initWith(waitForever);
        // (load hasn't read mLaunchPeriod yet: the constructor's 120)
        this.launchCooldown = Math.trunc(fr(this.launchPeriod * MsRandF()));
        this.initHitActor(AT.LAUNCHER, 1, HC.PLAYER | HC.WATER, 150, 100, 150, 100);
        this.offHitFilter(HF.NO_COLLISION);
        this.world.addToGroup('敵グループ', this);
        this.onLiveFlag(LF.UNK8); this.onLiveFlag(LF.UNK10);
        this.resetHitPoints();
        this.hitPoints = 5;
        this.rot.x = MsWrap(this.rot.x + 270, 0, 360);
    }
    load(s: Stream) {
        super.load(s);
        this.unk164 = s.str();
        this.launchPeriod = s.s32();
    }
    changeBck(i: number) { if (this.mactor) this.mactor.setBckFromIndex(i); }
    stateInitial() { this.changeState(STATE_NORMAL); }
    stateHitByWater() {
        if (this.ticksInState === 0) { this.changeBck(1); this.decHitPoints(); }
        if (this.anmEndsNext()) this.changeState(this.hitPoints === 0 ? STATE_DIE : STATE_NORMAL);
    }
    stateNormal() {
        if (this.ticksInState === 0) this.changeBck(3);
        if (this.launchCooldown > 0) --this.launchCooldown;
        if (this.launchCooldown > 0) return;
        this.launchCooldown = this.launchPeriod;
        const m = this.unk164 ? (this.world.conductor.getManagerByName(this.unk164) as EnemyManager | null) : null;
        if (!m) return;
        if (!getFarOutEnemy(m)) return;
        this.changeState(STATE_LAUNCH);
    }
    stateLaunch() {
        if (this.ticksInState === 0) this.changeBck(0);
        if (this.ticksInState === 0x3E) {
            const e = this.getProperEnemy(this.unk164);
            if (e) {
                const r = this.rot.clone();
                r.x = MsWrap(r.x - 270, 0, 360);
                throwOut(e, this.pos, r);
            }
        }
        if (this.anmEndsNext()) { this.launchCooldown = this.launchPeriod; this.changeState(STATE_NORMAL); }
    }
    stateDie() {
        if (this.ticksInState === 0) this.changeBck(2);
        if (this.anmEndsNext() && (!this.mactor || this.mactor.checkCurBckFromIndex(2))) {
            this.world.effect('launcherDead', this.pos, this.scale);
            this.kill();
            this.onHitFilter(HF.NO_COLLISION);
            this.resetLaunchTimer();
            this.changeState(STATE_NORMAL);
        }
    }
    perform(cue: number) {
        super.perform(cue);
        if ((cue & CUE_CALC_ANIM) && this.mactor && this.mactor.checkCurBckFromIndex(1)) this.world.effect('launcherHit', this.pos, this.scale);
        if ((cue & CUE_MOVE) && this.state === STATE_NORMAL && this.hitPoints < 5) {
            this.regenTimer += 1;
            if (this.regenTimer > 1200) { this.regenTimer = 0; this.hitPoints += 1; }
        }
        if (cue & CUE_MOVE) for (const c of this.collisions) if (c.isActorType(AT.MARIO)) this.world.mario.receiveMessage(this, MSG.ATTACK);
    }
}

export class CommonLauncherManager extends LauncherManager {
    constructor(w: World, name = 'コモンランチャーマネージャー') { super(w, name); }
    /** (TEnemyManager::load: no TLauncherParams) */
    load(s: Stream) { EnemyManager.prototype.load.call(this, s); }
    createModelData() { this.createModelDataArray(['generator_model1.bmd']); }
}

register('CommonLauncher', (w, n) => new CommonLauncher(w, n));
register('CommonLauncherManager', (w, n) => new CommonLauncherManager(w, n));
export { V3 };
