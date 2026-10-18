// Petey Piranha (Enemy/bosspakkun.cpp). The light one (KBossPakkun, ボスパックン軽: Bianco
// Hills 1, on top of the windmill) waits, and while Mario is in the goop-ball area
// (ゲロエリアマネージャー's cylinders) and not in water, spits a goop ball (TBPPolDrop) that
// lands in front of him and leaves goop where it splats.
// TODO: the full boss (BossPakkun: the fight in Bianco Hills 2 and 8: vomit, tornadoes, flying,
// the navel) — its nerves are decompiled; not ported yet.

import { fr, V3, JMASSin, JMASCos, s16 } from '../math.js';
import { World, SpineEnemy, EnemyManager, LF, HF, HC, MSG, nerve, Spine, Stream, ANM_BCK, HitActor, MActor, readParams, SPINE_PARAMS, PSchema, CUE_MOVE, CUE_CALC_ANIM, NameRef } from '../engine.js';
import { AT } from '../actortypes.js';
import { Walker } from './walker.js';
import { register } from '../scene.js';

const BOSS_PARAMS = {
    ...SPINE_PARAMS,
    mSLWaitFrameStg0: ['i', 400], mSLWaterMarkLimit: ['i', 600], mSLSwingLength: ['f', 600], mSLPollBallStampScale: ['f', 1], mSLTumbleTime: ['i', 2400],
    mSLAnmBlendTime0: ['i', 60], mSLFlySpeed: ['f', 5], mSLPivotSpeed: ['f', 0.7], mSLPivotSpeedAware: ['f', 1.5], mSLVomitAnmRate: ['f', 0.6],
    mSLHeadHomingLimit: ['f', 30], mSLDamageAngle: ['f', 180], mSLTornadoProp: ['f', 0.4], mSLTornadoSpeed: ['f', 2], mSLTornadoRollSpeed: ['f', 0.06],
    mSLTornadoMoveInit: ['f', 10000], mSLTornadoMoveInc: ['f', 1], mSLTornadoMoveLimit: ['f', 10720], mSLWaterHitTimer: ['i', 20], mSLHoverTimer: ['i', 1200],
    mSLPollBallRange: ['f', 10000], mSLPollBallSpeed: ['f', 20], mSLPollBallFront: ['f', 1000],
} satisfies PSchema;

/** SMSCalcJumpVelocityXZ */
function calcJumpVelocityXZ(to: V3, from: V3, speed: number, g: number) {
    const h = new V3(to.x - from.x, 0, to.z - from.z);
    const mag = h.length();
    const t = Math.trunc(mag / speed), t3 = Math.trunc(((t + 1) * t) / 2);
    const k = fr(speed / mag), dy = to.y - from.y;
    return new V3(fr(h.x * k), fr(k * dy + t3 * g * k), fr(h.z * k));
}

// ---------------------------------------------------------------- area cylinders (Enemy/areacylinder.cpp)
export class AreaCylinderManager extends NameRef {
    list: AreaCylinder[] = [];
    contain(p: V3) { return this.list.some((c) => c.contain(p)); }
    getCylinderContains(p: V3) { return this.list.find((c) => c.contain(p)) || null; }
}
export class AreaCylinder extends NameRef {
    p = new V3(); radius = 0; height = 0; probability = 0;
    constructor(public w: World, name: string) { super(name); }
    load(s: Stream) {
        this.p.set(s.f32(), s.f32(), s.f32());
        s.f32(); s.f32(); s.f32();
        this.radius = fr(s.f32() * 50); this.height = fr(s.f32() * 50);
        s.f32();
        s.str();
        const n = s.s32();
        for (let i = 0; i < n; i++) { s.f32(); s.str(); }
        const mgrName = s.str();
        let m = this.w.search(mgrName) as AreaCylinderManager | null;
        if (!m) { m = new AreaCylinderManager(mgrName); this.w.register(m); }
        m.list.push(this);
        this.probability = s.s32() / 100;
    }
    contain(p: V3) {
        if (p.y < this.p.y || this.p.y + this.height < p.y) return false;
        return (p.x - this.p.x) ** 2 + (p.z - this.p.z) ** 2 <= this.radius * this.radius;
    }
}
register('AreaCylinder', (w, n) => new AreaCylinder(w, n));

// ---------------------------------------------------------------- the goop ball
/** TBPPolDrop: flies (state 1), splats leaving its goop (2), gone (0). */
export class PolDrop extends HitActor {
    unk6C = new V3(); unk80 = 0; unk84 = 0; unk88 = 0;
    ball: PolModel; stamp: PolModel;
    constructor(public owner: BossPakkun) {
        super('<TBPPolDrop>');
        this.initHitActor(AT.BOSS_PAKKUN, 1, HC.PLAYER, 0, 0, 100, 200);
        this.offHitFilter(HF.NO_COLLISION);
        owner.world.addToGroup('敵グループ', this);
        this.ball = new PolModel(owner, 'pollut_ball.bmd', this);
        this.stamp = new PolModel(owner, 'pollut_ball_stamp.bmd', this);
        owner.world.extras.push(this.ball, this.stamp);
    }
    drop() {
        this.unk80 = 2; this.unk6C.zero();
        this.stamp.mactor!.setBck('pollut_ball_stamp');
        this.owner.world.effect('osendan', this.pos);
    }
    move() {
        if (this.unk80 === 0) { this.onHitFilter(HF.NO_COLLISION); return; }
        const n = this.pos.clone().add(this.unk6C);
        if (this.unk80 === 1) {
            if (this.ball.mactor!.curAnmEndsNext(ANM_BCK)) this.ball.mactor!.setBck('pollut_ball');
            this.unk6C.y = fr(this.unk6C.y - 0.1);
            if (this.unk84 >= 60 || this.owner.is2ndFightNow()) {
                const w = this.owner.world;
                let [h, d] = w.checkGround(n.x, this.pos.y, n.z);
                h = fr(h + 1);
                if (d.isIllegal()) h = this.unk88;
                this.unk88 = h;
                if (n.y < h) { this.drop(); n.y = h; this.onHitFilter(HF.NO_COLLISION); return; }
                this.offHitFilter(HF.NO_COLLISION);
                const p = { x: n.x, z: n.z };
                if (w.isTouchedOneWallAndMoveXZ(p, n.y, 80)) this.unk80 = 0;
                n.x = p.x; n.z = p.z;
            }
        } else if (this.unk80 === 2 && this.stamp.mactor!.curAnmEndsNext(ANM_BCK)) this.unk80 = 0;
        this.pos.set(n);
    }
    launch(p: V3, v: V3) {
        this.unk6C.set(v); this.pos.set(p); this.scale.set(1, 1, 1); this.rot.zero();
        this.unk80 = 1; this.unk84 = 0;
        this.ball.mactor!.setBck('pollut_ball');
        this.ball.mactor!.setAnimation('pollut_ball_02', 3);
        this.unk88 = p.y;
    }
    perform(cue: number) {
        if (this.unk80 === 0) return;
        if (cue & CUE_MOVE) {
            this.move(); ++this.unk84;
            for (const c of this.collisions) {
                if (!c.isActorType(AT.MARIO)) continue;
                c.receiveMessage(this, MSG.ATTACK);
                this.unk80 = this.owner.world.mario.isJumping() ? 0 : 2;
            }
        }
        if (cue & CUE_CALC_ANIM) {
            this.ball.place(this.pos, this.scale);
            if (this.unk80 === 2) { const s = this.owner.P.mSLPollBallStampScale; this.stamp.place(this.pos, new V3(s, s, s)); }
            if (this.unk80 === 1) this.ball.mactor!.frameUpdate();
            if (this.unk80 === 2) this.stamp.mactor!.frameUpdate();
        }
        // CUE_ENTRY: gpPollution->stampModel(the stamp model): its top-down shadow goops the ground under it
        if ((cue & CUE_CALC_ANIM) && this.unk80 === 2 && this.owner.world.pollution) {
            const s = this.owner.P.mSLPollBallStampScale;
            this.owner.world.pollution.stampGround(1, this.pos.x, this.pos.y, this.pos.z, 700 * s);
        }
    }
}
/** One of the goop ball's models (drawn while its state says). */
class PolModel extends SpineEnemy {
    constructor(owner: BossPakkun, file: string, public drop: PolDrop) {
        super(owner.world, file);
        this.manager = owner.manager; this.mactor = this.createMActorByName(file); this.manager = null;
    }
    place(p: V3, s: V3) { this.pos.set(p); this.scale.set(s); this.rot.zero(); this.calcRootMatrixBasic(); }
    perform() { }
    drawn() { const d = this.drop; return d.unk80 === 1 ? this === d.ball : d.unk80 === 2 ? this === d.stamp : false; }
}

// ---------------------------------------------------------------- TBossPakkun
export class BossPakkunManager extends EnemyManager {
    constructor(w: World, name: string, public unk54: number) { super(w, name); }
    load(s: Stream) { this.saveParams = readParams('/enemy/bosspakkun.prm', this.world.files, BOSS_PARAMS); super.load(s); }
    createModelData() {
        this.createModelDataArray(this.unk54 ? ['bosspaku_model.bmd', 'pollut_ball.bmd', 'pollut_ball_stamp.bmd']
            : ['bosspaku_model.bmd', 'bosspaku_end.bmd', 'pollut_ball.bmd', 'pollut_ball_stamp.bmd', 'bosspakuPollut.bmd', 'bosspakuPollut_white.bmd', 'trunade.bmd']);
    }
}
export class BossPakkun extends SpineEnemy {
    polDrop: PolDrop | null = null; unk188: AreaCylinderManager | null = null; unk154 = 0;
    get P(): any { return this.getSaveParam(); }
    get light() { return (this.manager as BossPakkunManager).unk54 !== 0; }
    constructor(w: World, name = 'ボスパックン') { super(w, name); this.offLiveFlag(LF.ENABLE_CLIPPING); this.binder = new Walker(); }
    init(m: any) {
        this.manager = m; m.manageActor(this);
        this.mactor = this.createMActorByName('bosspaku_model.bmd');
        this.initHitActor(AT.BOSS_PAKKUN, 1, HC.PLAYER, 80, 300, 80, 300);
        this.offHitFilter(HF.NO_COLLISION);
        if (this.light) this.spine!.initWith(BPNerves.waitL);
        else this.spine!.initWith(BPNerves.waitL);   // TODO: the full fight's nerves (TNerveBPWait / Fall / Sleep)
        this.polDrop = new PolDrop(this);
        this.onLiveFlag(LF.FORCE_SHADOW);
        this.scaledBodyRadius = 400;
        this.tracer.init(this.world.graphByName('bosspakkun'));
        if (this.tracer.graph) { this.tracer.reset(); this.goToShortestNextGraphNode(); }
        this.resetHitPoints();
    }
    is2ndFightNow() { return this.world.map === 2 && this.world.stage === 4; }
    inArea(p: V3) {
        if (!this.unk188) this.unk188 = this.world.search('ゲロエリアマネージャー') as AreaCylinderManager | null;
        return this.unk188 ? this.unk188.contain(p) : false;
    }
    getJointTrans(i: number): V3 {
        if (!this.mactor || this.checkLiveFlag(LF.CLIPPED_OUT)) return this.pos.clone();
        const m = this.mactor.anmMtx(i, this.baseTR, this.scale);
        return m ? new V3(m[12], m[13], m[14]) : this.pos.clone();
    }
    launchPolDrop() {
        const d = this.polDrop!;
        if (d.unk80 !== 0) return;
        let p: V3;
        if (this.checkLiveFlag(LF.CLIPPED_OUT)) { p = this.pos.clone(); p.x += 1; } else p = this.getJointTrans(18);
        const m = this.world.mario;
        const a = s16(m.rot.y * (65536 / 360));
        const front = this.P.mSLPollBallFront;
        const target = new V3(front * JMASSin(a), 0, front * JMASCos(a)).add(m.pos);
        d.launch(p, calcJumpVelocityXZ(target, p, this.P.mSLPollBallSpeed, 0.1));
    }
    receiveMessage(_s: HitActor, _m: number) { return false; }
    kill() { super.kill(); this.onHitFilter(HF.NO_COLLISION); if (this.polDrop) this.polDrop.onHitFilter(HF.NO_COLLISION); }
    perform(cue: number) {
        if (this.polDrop) this.polDrop.perform(cue);
        if (this.checkLiveFlag(LF.DEAD)) return;
        super.perform(cue);
    }
}

type S = Spine<BossPakkun>;
export const BPNerves: Record<string, any> = {};
BPNerves.waitL = nerve<BossPakkun>('TNerveBPWaitL', (spine: S) => {
    const self = spine.body, a = self.mactor!;
    if (spine.time === 0) a.setBck('bosspaku_wait');
    if (spine.time >= self.P.mSLWaitFrameStg0) {
        if (self.inArea(self.world.mario.pos) && !self.world.mario.groundPlane.isWaterSurface()) { spine.pushAfterCurrent(BPNerves.cannonL); return true; }
        if (a.curAnmEndsNext(ANM_BCK)) { spine.pushAfterCurrent(BPNerves.waitL); return true; }
    }
    return false;
});
BPNerves.cannonL = nerve<BossPakkun>('TNerveBPCannonL', (spine: S) => {
    const self = spine.body, a = self.mactor!;
    if (spine.time === 0) a.setBck('bosspaku_pollut_start');
    if (a.curAnmEndsNext(ANM_BCK)) {
        if (a.checkCurAnm('bosspaku_pollut_start', ANM_BCK)) { a.setBck('bosspaku_ball_end'); self.launchPolDrop(); }
        else { spine.pushAfterCurrent(BPNerves.waitL); return true; }
    }
    return false;
});

register('KBossPakkunManager', (w, n) => new BossPakkunManager(w, n, 1));
register('KBossPakkun', (w, n) => new BossPakkun(w, n));
export { MActor };
