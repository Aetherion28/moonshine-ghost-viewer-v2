// Effect "enemies": the one-shot effect models of Enemy/effectObj.cpp (TEffectModel: a splash
// column when an enemy dies in water, エフェクト水柱; the bomb splash, the sand column, the
// explosion) that a manager hands out through makeOneEnemyAppear + generate(pos, scale), each
// playing its animation once and then dead until it's wanted again; and TEffectEnemy
// (Enemy/effectEnemy.cpp), the moving fire that burns Mario (its particles only, no model drawn).

import { V3 } from '../math.js';
import { World, SpineEnemy, EnemyManager, LF, HF, MSG, Stream, ANM_BCK, ANM_BPK, ANM_BTK, ANM_BRK, HitActor, SPINE_PARAMS, readParams, CUE_MOVE, CUE_CALC_ANIM } from '../engine.js';
import { AT } from '../actortypes.js';
import { SmallEnemy, SmallEnemyManager, rangeRand } from './smallEnemy.js';
import { WalkerEnemy, walkerParams } from './walker.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';

// ---------------------------------------------------------------- TEffectModel
export class EffectModel extends SpineEnemy {
    /** the animation name its bck / brk / btk (/ bpk) share */
    anm = ''; hasBpk = false;
    init(m: any) {
        super.init(m);
        this.onLiveFlag(LF.DEAD);
        this.scale.set(0, 0, 0);
        this.onHitFilter(HF.NO_COLLISION);
        this.actorType = AT.EFFECT_OBJ;
        this.rot.zero();
    }
    reset() {
        super.reset();
        this.rot.y = rangeRand(0, 360);
        this.onLiveFlag(LF.UNK8);
        this.onLiveFlag(LF.UNK10);
        this.offLiveFlag(LF.DEAD);
        this.offLiveFlag(LF.CLIPPED_OUT);
        this.onHitFilter(HF.NO_COLLISION);
    }
    control() { }
    /** dead once its animation has played */
    moveObject() {
        if (!this.checkLiveFlag(LF.DEAD) && this.mactor!.curAnmEndsNext(ANM_BCK)) {
            this.onLiveFlag(LF.DEAD);
            this.onLiveFlag(LF.CLIPPED_OUT);
        }
    }
    calcRootMatrix() { this.calcRootMatrixBasic(); }
    /** its init / reset: the animations set (frame 0) */
    setAnms() {
        const a = this.mactor!;
        a.setBck(this.anm);
        a.setAnimation(this.anm, ANM_BRK);
        a.setAnimation(this.anm, ANM_BTK);
        if (this.hasBpk) a.setAnimation(this.anm, ANM_BPK);
        for (const t of [ANM_BCK, ANM_BRK, ANM_BTK, ...(this.hasBpk ? [ANM_BPK] : [])]) { const c = a.getFrameCtrl(t); if (c) c.frame = 0; }
    }
    /** the particles it starts (told to the viewer) */
    particles: string[] = [];
    generate(p: V3, s: V3) {
        this.reset();
        this.scale.set(s);
        for (const k of this.particles) this.world.effect(k, p, this.scale);
        this.onHitFilter(HF.NO_COLLISION);
    }
}

export class EffectModelManager extends EnemyManager {
    prm = ''; model = '';
    load(s: Stream) {
        this.saveParams = readParams(this.prm, this.world.files, SPINE_PARAMS);
        super.load(s);
    }
    /** (its particles: SMS_LoadParticle) */
    loadAfter() { }
    createModelData() { this.createModelDataArray([this.model]); }
}

export class EffectColumWaterManager extends EffectModelManager {
    prm = '/enemy/watercolum.prm'; model = '06_enem_tobikomi.bmd';
    constructor(w: World, name = 'エフェクト水柱マネージャー') { super(w, name); }
    createEnemyInstance() { return new EffectColumWater(this.world); }
}
export class EffectColumWater extends EffectModel {
    anm = '06_enem_tobikomi'; hasBpk = true; particles = ['columWater:ms_enehamon_a', 'columWater:ms_enehamon_b'];
    constructor(w: World, name = 'エフェクト水柱') { super(w, name); }
    init(m: any) {
        super.init(m);
        this.onLiveFlag(LF.DEAD);
        this.scale.set(0, 0, 0);
        this.actorType = AT.EFFECT_OBJ;
        this.setAnms();
        this.onHitFilter(HF.NO_COLLISION);
    }
    reset() { super.reset(); this.setAnms(); }
    generate(p: V3, s: V3) {
        this.reset();
        this.scale.set(s).scale(1.3).fround();
        for (const k of this.particles) this.world.effect(k, p, this.scale);
        this.onHitFilter(HF.NO_COLLISION);
    }
}

export class EffectBombColumWaterManager extends EffectModelManager {
    prm = '/enemy/bombwatercolum.prm'; model = '04_tobikomi.bmd';
    constructor(w: World, name = 'エフェクト爆発水柱マネージャー') { super(w, name); }
    createEnemyInstance() { return new EffectBombColumWater(this.world); }
}
export class EffectBombColumWater extends EffectModel {
    anm = '04_tobikomi'; hasBpk = true; particles = ['ms_m_tobikomi_a', 'ms_m_tobikomi_b', 'ms_m_tobikomi_c'];
    constructor(w: World, name = 'エフェクト爆発水柱') { super(w, name); }
    init(m: any) { super.init(m); this.onLiveFlag(LF.DEAD); this.scale.set(0, 0, 0); this.actorType = AT.EFFECT_OBJ; this.setAnms(); this.onHitFilter(HF.NO_COLLISION); }
    reset() { super.reset(); this.setAnms(); }
}

export class EffectColumSandManager extends EffectModelManager {
    prm = '/enemy/sandcolum.prm'; model = '08_sunabashira.bmd';
    constructor(w: World, name = 'エフェクト砂柱マネージャー') { super(w, name); }
    createEnemyInstance() { return new EffectColumSand(this.world); }
}
export class EffectColumSand extends EffectModel {
    anm = '08_sunabashira'; particles = ['columSand:ms_boha_crash_a'];
    constructor(w: World, name = 'エフェクト砂柱') { super(w, name); }
    init(m: any) { super.init(m); this.onLiveFlag(LF.DEAD); this.scale.set(0, 0, 0); this.actorType = AT.EFFECT_OBJ; this.setAnms(); this.onHitFilter(HF.NO_COLLISION); }
    reset() { super.reset(); this.setAnms(); }
    generate(p: V3, s: V3) {
        this.reset();
        this.scale.set(s);
        this.world.effect(this.particles[0], p, new V3(s.x, s.x, s.x));
        this.onHitFilter(HF.NO_COLLISION);
    }
}

export class EffectExplosionManager extends EffectModelManager {
    prm = '/enemy/explosion.prm'; model = '10_bomb.bmd';
    constructor(w: World, name = 'エフェクト爆発マネージャー') { super(w, name); }
    createEnemyInstance() { return new EffectExplosion(this.world); }
}
export class EffectExplosion extends EffectModel {
    anm = '10_bomb'; particles = ['explosion:ms_bomb_smoke', 'explosion:ms_bomb_bomb', 'explosion:ms_bomb_hahen', 'ms_popo_bomb_b'];
    constructor(w: World, name = 'エフェクト爆発') { super(w, name); }
    init(m: any) { super.init(m); this.onLiveFlag(LF.DEAD); this.scale.set(0, 0, 0); this.actorType = AT.EFFECT_OBJ; this.setAnms(); this.onHitFilter(HF.NO_COLLISION); }
    reset() { super.reset(); this.setAnms(); }
    generate(p: V3, s: V3) {
        this.reset();
        this.scale.set(s);
        const k = new V3(s.x, s.x, s.x);
        for (const n of this.particles) this.world.effect(n, p, k);
        this.onHitFilter(HF.NO_COLLISION);
    }
}

// ---------------------------------------------------------------- TEffectEnemy (effectEnemy.cpp)
export class EffectEnemyManager extends SmallEnemyManager {
    constructor(w: World, name = 'エフェクト敵マネージャー') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.saveParams = walkerParams('/enemy/moveFireEffect.prm', this.world.files);
    }
    /** JDrama::TNameRef::loadAfter: not the small-enemy one */
    loadAfter() { }
    createEnemyInstance() { return new EffectEnemy(this.world); }
    initSetEnemies() { }
}
export class EffectEnemy extends WalkerEnemy {
    /** what it does to Mario: 0 burns (and goes out), 1 shocks, else attacks */
    unk194 = 0;
    constructor(w: World, name = 'エフェクト敵') { super(w, name); }
    init(m: any) { super.init(m); this.actorType = AT.EFFECT_ENEMY; }
    setMActorAndKeeper() { this.mactor = this.createMActorByName('default.bmd'); }
    kill() {
        this.setDeadAnm();
        this.onLiveFlag(LF.DEAD);
        this.onHitFilter(HF.NO_COLLISION);
    }
    forceKill() {
        const g = this.groundPlane;
        if (!(g.isIllegal() || (!g.isDeathPlane() && !g.isPool() && !g.isWaterSurface()) || this.isAirborne() || this.checkLiveFlag(LF.UNK10)) || !this.world.isInArea(this.pos.x, this.pos.z)) this.kill();
    }
    perform(cue: number) {
        if (this.checkLiveFlag(LF.DEAD)) return;
        if (cue & CUE_MOVE) WalkerEnemy.prototype.moveObject.call(this);
        if ((cue & CUE_CALC_ANIM) && !this.checkLiveFlag(LF.CLIPPED_OUT)) this.emitEffect();
    }
    /** only its fire particles: no model drawn */
    drawn() { return false; }
    behaveToWater(a: HitActor) { if (this.hitPoints > 1) SmallEnemy.prototype.behaveToWater.call(this, a); else this.kill(); }
    sendAttackMsgToMario() {
        const m = this.world.mario;
        switch (this.unk194) {
            case 0: m.receiveMessage(this, MSG.BURN); this.kill(); break;
            case 1: m.receiveMessage(this, MSG.ELECTRIC_SHOCK); break;
            default: m.receiveMessage(this, MSG.ATTACK); break;
        }
    }
    setDeadAnm() {
        this.world.effect('ms_moe_fire_off', this.pos);
        this.world.sound(SE.BS_WANWAN_TO_COOL, this.pos);
        this.onLiveFlag(LF.UNK20000);
    }
    emitEffect() {
        // (the scale it computes, scaling * (hp / maxHp) in integers, isn't passed to the emitters)
        this.world.effect('moeFire', this.pos);
    }
}

register('EffectColumWaterManager', (w, n) => new EffectColumWaterManager(w, n));
register('EffectBombColumWaterManager', (w, n) => new EffectBombColumWaterManager(w, n));
register('EffectColumSandManager', (w, n) => new EffectColumSandManager(w, n));
register('EffectExplosionManager', (w, n) => new EffectExplosionManager(w, n));
register('EffectEnemyManager', (w, n) => new EffectEnemyManager(w, n));
register('EffectEnemy', (w, n) => new EffectEnemy(w, n));
