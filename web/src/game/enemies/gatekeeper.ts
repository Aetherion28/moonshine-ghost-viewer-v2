// The gatekeeper (Enemy/gatekeeper.cpp): TBiancoGateKeeper, the giant goop Piranha Plant that
// blocks the way (Bianco Hills 1's ゲートキーパー; Delfino Plaza's three; the airport's). It
// sleeps in its goop, and in Bianco Hills spits rolling Petey heads (ゴロゴロ) every
// mSLLaunchTimerNormal ±120 frames; sprayed while asleep it stirs (16 frames of spray keep
// unk17C climbing to 255: then it comes up); up, it sways at Mario with its mouth open, and
// water in its mouth (the head hit, 頭ヒット) costs it a hit point: 3 and it dies.
// Not modelled: the appear / finish demo cameras (the demo mode they start), the motion
// blending, the damage fog, the hint balloons, particles and rumble. Its head's turn towards
// Mario (TBGKMtxCalc) is applied to the joints, for where the head hit is.

import { fr, V3, MsWrap, MsAngleDiff, MsGetRotFromZaxisY, MsRandF, JMASSin, JMASCos, MsMtxSetXYZRPH, mtx } from '../math.js';
import { World, SpineEnemy, EnemyManager, LF, HF, HC, MSG, nerve, Spine, Stream, ANM_BCK, ANM_BPK, HitActor, readParams, SPINE_PARAMS, PSchema, CUE_MOVE, CUE_CALC_ANIM, NameRef } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { stampModel } from './igaiga.js';
import type { Gorogoro } from './igaiga.js';
import { mat4 } from 'gl-matrix';

const GK_PARAMS = { ...SPINE_PARAMS, mSLDiveTimer: ['i', 480], mSLLoop2Dive: ['i', 5], mSLLaunchTimerNormal: ['i', 600], mSLLaunchTimerDamage: ['i', 600] } satisfies PSchema;

export class GateKeeperManager extends EnemyManager {
    constructor(w: World, name = 'ゲートキーパーマネージャー') { super(w, name); }
    load(s: Stream) { this.saveParams = readParams('/enemy/gatekeeper.prm', this.world.files, GK_PARAMS); super.load(s); }
    createModelData() { this.createModelDataArray(['gene_pakkun_model1.bmd', 'stamp_keeper_model1.bmd']); }
}

/** TGKHitObj: a hit actor on one of its joints (the head: water there is what hurts it). */
class GKHitObj extends HitActor {
    vulnerable = 0;
    constructor(public owner: GateKeeper, public joint: number, name: string) {
        super(name);
        this.initHitActor(AT.BIANCO_GATE_KEEPER, 1, HC.PLAYER, 0, 0, 150, 200);
        this.offHitFilter(HF.NO_COLLISION);
        owner.world.addToGroup('敵グループ', this);
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (sender.isActorType(AT.WATER) && msg === MSG.SPRAYED_BY_WATER) {
            if (this.vulnerable) this.owner.unk154++;
            this.owner.world.effect('enemyWaterHit', sender.pos);
            return true;
        }
        return this.owner.receiveMessage(sender, msg);
    }
    perform(cue: number) {
        const o = this.owner;
        if (o.checkLiveFlag(LF.DEAD)) return;
        if (cue & CUE_CALC_ANIM) {
            const m = !o.checkLiveFlag(LF.CLIPPED_OUT) && o.joints ? o.joints[this.joint] : null;
            if (m) this.pos.set(m[12], m[13], m[14]); else this.pos.set(o.pos);
        }
        super.perform(cue);
    }
}
/** TBGKObstacle: the big cylinder under it that keeps Mario off. */
class BGKObstacle extends HitActor {
    constructor(owner: GateKeeper, name: string) {
        super(name);
        this.pos.set(owner.pos); this.pos.y = fr(this.pos.y - 1000);
        this.initHitActor(AT.BIANCO_GATE_KEEPER, 1, HC.PLAYER, 800, 800, 800, 800);
        this.offHitFilter(HF.NO_COLLISION);
        owner.world.addToGroup('敵グループ', this);
    }
}

const VARIANT_AIRPORT = 0, VARIANT_GENERIC = 1, VARIANT_DOLPIC_TOWN = 2, VARIANT_RICO = 3, VARIANT_MAMMA = 4;

/** TGateKeeperBase + TBiancoGateKeeper */
export class GateKeeper extends SpineEnemy {
    // TGateKeeperBase
    stampModel: string | null = null; unk154 = 0; unk158 = 0; stampEnabled = 1; vulnerable = 0; stampScale = new V3(1, 1, 1);
    // TBiancoGateKeeper
    head: GKHitObj | null = null; unk17C = 0; unk17E = 0; unk180 = 0; unk288 = 0; unk28A = 0;
    obstacle: BGKObstacle | null = null; unk290 = 0; variant = VARIANT_DOLPIC_TOWN; unk296 = 0; unk298 = 0;
    /** the joints' matrices from its last calc (J3DModel's anm matrices) */
    joints: mat4[] | null = null;
    get P(): any { return this.getSaveParam(); }
    constructor(w: World, name = 'ビアンコゲートキーパー') { super(w, name); this.onLiveFlag(LF.UNK10); }
    init(m: any) {
        this.manager = m;
        m.manageActor(this);
        this.mactor = this.createMActorByName('gene_pakkun_model1.bmd');
        const map = this.world.map;
        if (this.name === 'ゲートキーパー（リコ）') this.variant = VARIANT_RICO;        // TODO: dead until MSF_RICCO_UNLOCKABLE (the save's flags aren't known)
        else if (this.name === 'ゲートキーパー（マンマ）') this.variant = VARIANT_MAMMA; // TODO: likewise MSF_GELATO_UNLOCKABLE
        else this.variant = map === 0 ? VARIANT_AIRPORT : map === 1 ? VARIANT_DOLPIC_TOWN : VARIANT_GENERIC;
        if (map === 1) {
            this.stampModel = (this.mgr!.folder() + '/stamp_keeper_model1.bmd').toLowerCase();
            const k = this.variant === VARIANT_DOLPIC_TOWN ? 0.8 : this.variant === VARIANT_RICO ? 1.2 : this.variant === VARIANT_MAMMA ? 1.4 : 1;
            this.stampScale.scale(k);
        }
        this.initHitActor(AT.BIANCO_GATE_KEEPER, 5, HC.PLAYER | HC.WATER, 400, 150, 400, 150);
        this.world.addToGroup('敵グループ', this);
        this.offHitFilter(HF.NO_COLLISION);
        this.spine!.initWith(GKNerves.sleep);
        this.hitPoints = 3;
        this.obstacle = new BGKObstacle(this, 'TBGKObstacle');
        this.calcRootMatrix();
        this.head = new GKHitObj(this, 0xA, '頭ヒット');
        this.calcJoints();
        if (this.checkLiveFlag(LF.DEAD)) { this.onHitFilter(HF.NO_COLLISION); this.head.onHitFilter(HF.NO_COLLISION); this.obstacle.onHitFilter(HF.NO_COLLISION); }
    }
    /** J3DModel::calc with TBGKMtxCalc: joint 11 is put at its position, joint 0 turned by unk180 (the head following Mario). */
    calcJoints() {
        if (!this.mactor) return;
        const a = this.mactor, w = this.world;
        this.joints = a.anmMtxAll(this.baseTR, this.scale, (j, m) => {
            if (j === 11) {
                const r = mtx();
                MsMtxSetXYZRPH(r, this.pos.x, this.pos.y, this.pos.z, this.rot.x, this.rot.y, this.rot.z);
                mat4.set(m, r[0], r[4], r[8], 0, r[1], r[5], r[9], 0, r[2], r[6], r[10], 0, r[3], r[7], r[11], 1);
            } else if (j === 0) {
                if (!w.demoMode && !w.talkMode && [0xB, 0x12, 0xF, 0x10, 0xC].some((i) => a.checkCurBckFromIndex(i))) {
                    const d = V3.sub(w.mario.pos, this.pos);
                    const yaw = MsWrap(MsGetRotFromZaxisY(d), -180, 180);
                    const cur = MsWrap(fr(this.rot.y + this.unk180), -180, 180);
                    const delta = MsAngleDiff(yaw, cur);
                    const turn = delta > 0 ? Math.min(3, delta) : Math.max(-3, delta);
                    this.unk180 = MsWrap(fr(fr(turn + cur) - this.rot.y), 0, 360);
                }
                mat4.rotateY(m, m, this.unk180 * (Math.PI / 180));
            }
        });
    }
    kill() {
        this.onLiveFlag(LF.DEAD);
        this.onHitFilter(HF.NO_COLLISION);
        if (this.head) this.head.onHitFilter(HF.NO_COLLISION);
        if (this.obstacle) this.obstacle.onHitFilter(HF.NO_COLLISION);
    }
    /** TGateKeeperBase::receiveMessage: FLUDD water on the body counts (while it's vulnerable). */
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (sender.isActorType(AT.WATER)) {
            if (this.vulnerable && msg === MSG.SPRAYED_BY_WATER) this.unk154++;
            this.world.effect('enemyWaterHit', sender.pos);
            return true;
        }
        return false;
    }
    changeBck(i: number) {
        const a = this.mactor!, cur = a.getCurAnmIdx(ANM_BCK);
        const direct = (cur === 0x11 && i === 0xB) || (cur === 0x11 && i === 0x12) || (cur === 0xB && i === 0x12) || (cur === 0x12 && i === 0xB)
            || (cur === 7 && i === 7) || (cur === 7 && i === 0x12) || (cur === 0xF && i === 0x10) || (cur === 0x10 && i === 0xC);
        a.setBckFromIndex(i);
        if (direct) this.unk158 = 0;
        else {
            const fc = a.getFrameCtrl(ANM_BCK);
            if (fc) { const v = fr(0.25 * fc.end); this.unk158 = v < 1 ? 1 : fr(1 / v); } else this.unk158 = 1;
        }
    }
    launchGorogoro() {
        const g = this.world.conductor.makeOneEnemyAppear(this.pos, 'ゴロゴロマネージャー', 0) as Gorogoro | null;
        if (g) g.generateByGateKeeper(this.pos, this.rot);
    }
    launchNamekuri() {
        const mgr = (this.world.search('拡散ナメクリマネージャー') || this.world.search('ナメクリマネージャー')) as any;
        if (!mgr || !mgr.getFarOutEnemy) return;
        for (let i = 0; i < 10; i++) {
            const e = mgr.getFarOutEnemy();
            if (!e) break;
            const p = this.pos.clone(); p.y = fr(p.y + 100);
            const a = Math.trunc(fr(182.04445 * fr(36 * i)));
            e.reset();
            e.pos.set(p); e.rot.set(this.rot); e.scale.set(1, 1, 1);
            e.resetHitPoints();
            e.vel.set(fr(4 * JMASSin(a)), 12, fr(4 * JMASCos(a)));
            e.onLiveFlag(LF.AIRBORNE); e.offLiveFlag(LF.DEAD | LF.UNK8); e.onLiveFlag(LF.UNK8000);
            e.offHitFilter(HF.NO_COLLISION);
            // TNerveNameKuriDiffuse (the namekuri port's)
            if (e.diffuseNerve) e.spine.pushNerve(e.diffuseNerve());
        }
    }
    curBckFinished() { return this.mactor!.isCurAnmAlreadyEnd(ANM_BCK); }
    isHeadHitActive() {
        const a = this.mactor!, f = a.getFrameCtrl(ANM_BCK)!.frame;
        if (a.checkCurBckFromIndex(0x12)) return f > 50 && f < 160;
        if (a.checkCurBckFromIndex(0xF)) return f > 40;
        return a.checkCurBckFromIndex(0x10) || a.checkCurBckFromIndex(0xC);
    }
    controlCollision() {
        const a = this.mactor!, h = this.head!;
        const is = (i: number) => a.checkCurBckFromIndex(i);
        if (is(0xB) || is(7) || is(0x12)) { h.vulnerable = 1; this.vulnerable = 0; return; }
        if (is(0xA) || is(4)) { h.vulnerable = 0; this.vulnerable = 1; return; }
        if (is(0xF)) { h.vulnerable = a.getFrameCtrl(ANM_BCK)!.frame > 40 ? 1 : 0; this.vulnerable = 0; return; }
        if (is(0x10) || is(0xC)) { h.vulnerable = 1; this.vulnerable = 0; return; }
        h.vulnerable = 0; this.vulnerable = 0;
    }
    launchTimer(normal: boolean) { return (normal ? this.P.mSLLaunchTimerNormal : this.P.mSLLaunchTimerDamage) + Math.trunc(fr(240 * MsRandF())) - 120; }
    perform(cue: number) {
        if (this.checkLiveFlag(LF.DEAD)) return;
        if (!this.world.demoMode && this.world.talkMode) cue &= ~CUE_MOVE;
        if (cue & CUE_MOVE) {
            for (const c of this.collisions) if (c.isActorType(AT.MARIO)) this.world.mario.receiveMessage(this, MSG.ATTACK);
            if (this.unk154 > 0) this.unk17E = 0x10;
            if (this.unk17E > 0) this.unk17C = this.unk17C < 0xFF ? this.unk17C + 1 : 0xFF;
            else this.unk17C = this.unk17C > 0 ? this.unk17C - 1 : 0;
            if (this.unk17E > 0) this.unk17E--;
            this.controlCollision();
        }
        this.head!.perform(cue);
        this.obstacle!.perform(cue);
        // TGateKeeperBase::perform
        super.perform(cue);
        if ((cue & CUE_CALC_ANIM) && !this.checkLiveFlag(LF.HIDDEN | LF.CLIPPED_OUT)) this.calcJoints();
        if (this.stampEnabled && this.stampModel && (cue & CUE_CALC_ANIM)) {
            // CUE_ENTRY: gpPollution->stampModel (the stamp model at its root matrix)
            stampModel(this.world, this.stampModel, this.pos, this.stampScale);
        }
        if (cue & CUE_MOVE) this.unk154 = 0;
    }
}

type S = Spine<GateKeeper>;
export const GKNerves: Record<string, any> = {};
GKNerves.sleep = nerve<GateKeeper>('TNerveBGKSleep', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.changeBck(0xA);
        self.offHitFilter(HF.NO_COLLISION);
        self.mactor!.setFromIndex(ANM_BPK, 0);
        const fc = self.mactor!.getFrameCtrl(ANM_BPK);
        if (fc) { fc.frame = 0; fc.rate = 0; }
    }
    if (self.world.map === 2) {
        if (self.unk298 > 0) self.unk298--;
        if (self.unk298 === 0) {
            self.unk298 = self.launchTimer(true);
            spine.pushAfterCurrent(GKNerves.launchGoro);
            return true;
        }
    }
    if (self.unk17C >= 0xFF) { spine.pushAfterCurrent(GKNerves.appear); return true; }
    if (self.unk154 > 0) { spine.pushAfterCurrent(GKNerves.sleepDamage); return true; }
    return false;
});
GKNerves.appear = nerve<GateKeeper>('TNerveBGKAppear', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) {
        self.changeBck(0);
        // (unk28A === 0: the appear demo camera and BGM)
        if (self.unk28A < 0xFF) self.unk28A++;
    }
    if (self.mactor!.curAnmEndsNext(ANM_BCK)) {
        spine.pushAfterCurrent(self.world.map === 0 ? GKNerves.wait2 : GKNerves.wait);
        return true;
    }
    return false;
});
GKNerves.wait = nerve<GateKeeper>('TNerveBGKWait', (spine: S) => {
    const self = spine.body, a = self.mactor!;
    const is = (i: number) => a.checkCurBckFromIndex(i);
    if (spine.time === 0) self.changeBck(0x11);
    if (self.unk154 > 0 && is(0x12) && !self.isHeadHitActive()) { self.changeBck(7); return false; }
    if (self.unk154 > 0 && !is(0xB) && !is(7) && !is(0x11) && !is(0xD)) {
        self.decHitPoints();
        spine.pushAfterCurrent(self.hitPoints === 0 ? GKNerves.die : GKNerves.awakeDamage);
        return true;
    }
    if (self.unk154 > 0 && is(0xB)) { self.changeBck(7); return false; }
    if (self.unk154 > 0 && is(7)) self.unk290 = 0;
    if (spine.time > self.P.mSLDiveTimer && !is(0xD)) { if (self.curBckFinished()) self.changeBck(0xD); }
    if (self.curBckFinished()) {
        if (is(0x11) && self.unk28A === 1 && self.hitPoints === 3) self.changeBck(0xB);
        else if (is(0x11)) self.changeBck(0x12);
        else if (is(0xB)) self.changeBck(0x12);
        else if (is(0x12)) self.changeBck(0x12);
        else if (is(7)) {
            if (self.unk154 > 0) { self.unk290 = 0; self.changeBck(7); }
            else {
                self.unk17C = 0;
                if (self.unk290 >= 0) { self.unk290 = 0; self.changeBck(0x12); }
                else { self.unk290 += 1; self.changeBck(7); }
            }
        } else if (is(0xD)) { spine.pushAfterCurrent(GKNerves.dive); return true; }
    }
    return false;
});
GKNerves.wait2 = nerve<GateKeeper>('TNerveBGKWait2', (spine: S) => {
    const self = spine.body, a = self.mactor!;
    const is = (i: number) => a.checkCurBckFromIndex(i);
    if (spine.time === 0) self.changeBck(0x11);
    if (self.unk154 > 0) {
        self.decHitPoints();
        spine.pushAfterCurrent(self.hitPoints === 0 ? GKNerves.die : GKNerves.awakeDamage);
        return true;
    }
    if (self.curBckFinished()) {
        if (is(0x11)) self.changeBck(0xF);
        else if (is(0xF)) self.changeBck(0x10);
        else if (is(0x10)) { self.unk288++; if (self.unk288 > self.P.mSLLoop2Dive) { self.changeBck(0xC); self.unk288 = 0; } }
        else if (is(0xC)) self.changeBck(0xD);
        else if (is(0xD)) { spine.pushAfterCurrent(GKNerves.dive); return true; }
    }
    return false;
});
GKNerves.sleepDamage = nerve<GateKeeper>('TNerveBGKSleepDamage', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(4);
    if (self.variant === VARIANT_GENERIC) {
        if (self.unk298 > 0) self.unk298--;
        if (self.unk298 === 0) { self.unk298 = self.launchTimer(false); self.launchGorogoro(); }
    }
    if (self.mactor!.curAnmEndsNext(ANM_BCK)) { spine.pushAfterCurrent(GKNerves.sleep); return true; }
    return false;
});
GKNerves.awakeDamage = nerve<GateKeeper>('TNerveBGKAwakeDamage', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(3);
    if (self.curBckFinished()) { spine.pushAfterCurrent(self.world.map === 0 ? GKNerves.wait2 : GKNerves.wait); return true; }
    return false;
});
GKNerves.die = nerve<GateKeeper>('TNerveBGKDie', (spine: S) => {
    const self = spine.body;
    const twice = self.variant === VARIANT_RICO || self.variant === VARIANT_MAMMA;
    if (spine.time === 0) {
        self.changeBck(5);
        if (!twice || self.unk296 !== 0) {
            // (the finish demo camera, BGM stop)
            self.mactor!.setFromIndex(ANM_BPK, 0);
            const fc = self.mactor!.getFrameCtrl(ANM_BPK);
            if (fc) { fc.frame = 0; fc.rate = 2; }
            self.world.effect('gkpaDead', self.pos);
        }
    }
    if (self.mactor!.curAnmEndsNext(ANM_BCK)) {
        if (twice && self.unk296 === 0) {
            self.unk296 += 1;
            self.hitPoints = 3;
            spine.pushAfterCurrent(self.variant === VARIANT_MAMMA ? GKNerves.launchName : GKNerves.appear);
            return true;
        }
        self.stampEnabled = 0;
        self.kill();
        return true;
    }
    return false;
});
GKNerves.dive = nerve<GateKeeper>('TNerveBGKDive', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(6);
    if (self.mactor!.curAnmEndsNext(ANM_BCK)) {
        if (self.variant === VARIANT_GENERIC) { self.unk298 = self.launchTimer(true); self.launchGorogoro(); }
        spine.pushAfterCurrent(GKNerves.sleep);
        return true;
    }
    return false;
});
GKNerves.launchGoro = nerve<GateKeeper>('TNerveBGKLaunchGoro', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(8);
    if (spine.time === 0x34) self.launchGorogoro();
    if (self.unk17C >= 0xFF) { spine.pushAfterCurrent(GKNerves.appear); return true; }
    if (self.mactor!.curAnmEndsNext(ANM_BCK)) { spine.pushAfterCurrent(GKNerves.sleep); return true; }
    return false;
});
GKNerves.launchName = nerve<GateKeeper>('TNerveBGKLaunchName', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(8);
    if (spine.time === 0x34) self.launchNamekuri();
    if (self.mactor!.curAnmEndsNext(ANM_BCK)) { spine.pushAfterCurrent(GKNerves.appear); return true; }
    return false;
});

/**
 * TMapEventSinkBianco (イベント（地形沈むビアンコ）): Bianco Hills 1's slope (building 0, up once
 * the gatekeeper's dead) and building 1 (up once its goop is cleaned). The Petey heads only ask
 * isBuried(1). TODO: the pollution objects (TPollutionObj::isCleaned) aren't simulated, so
 * building 1 stays buried.
 */
class MapEventSinkBianco extends NameRef {
    recovered = [false, false];
    isBuried(i: number) { return !this.recovered[i]; }
}

register('GateKeeperManager', (w, n) => new GateKeeperManager(w, n));
register('GateKeeper', (w, n) => new GateKeeper(w, n));
register('MapEventSinkBianco', (_w, n) => new MapEventSinkBianco(n));
