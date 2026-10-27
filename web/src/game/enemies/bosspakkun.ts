// Petey Piranha (Enemy/bosspakkun.cpp). The light one (KBossPakkun, ボスパックン軽: Bianco
// Hills 1, on top of the windmill) waits, and while Mario is in the goop-ball area
// (ゲロエリアマネージャー's cylinders) and not in water, spits a goop ball (TBPPolDrop) that
// lands in front of him and leaves goop where it splats.
// The full one (BossPakkun, Bianco Hills 2 / 8 and the boss scene): waits, swings his head at
// Mario close by, turns and vomits goop, swallows FLUDD water until he tumbles over showing his
// navel (a ground pound there hurts him), in episode 8 also throws tornadoes, takes off, flies
// the "bosspakkun" graph and hovers spitting goop balls until he's sprayed and falls.
// His joints (TBossPakkunMtxCalc) blend from one BCK to the next, his belly swells with the water
// in it and his head turns toward Mario. Approximation: checkMarioRiding's status bits are read
// from the ghost (landed on his body).

import { fr, V3, JMASSin, JMASCos, s16, rand, JMAHermiteInterpolation, MsSin, MsCos, MsGetRotFromZaxisY, MsAngleDiff, MsWrap } from '../math.js';
import { World, SpineEnemy, EnemyManager, LF, HF, HC, MSG, nerve, Spine, Stream, ANM_BCK, HitActor, MActor, readParams, SPINE_PARAMS, PSchema, CUE_MOVE, CUE_CALC_ANIM, NameRef, ANM_BRK, ANM_BTK, ANM_FRAME_RATE, MoveCollision, PathNode, LiveActor } from '../engine.js';
import { AT } from '../actortypes.js';
import { SE } from '../soundids.js';
import { holdKey } from '../sound.js';
import { Walker } from './walker.js';
import { mapObjGlobals } from '../mapobj/base.js';
import type { ItemManager } from '../mapobj/item.js';
import { register } from '../scene.js';
import { emitInfo, EmitInfo } from '../water.js';
import { mat4 } from 'gl-matrix';
import { Skeleton, parseBCK, jointMatricesBlend } from '../skeleton.js';

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
        this.owner.world.sound(SE.BS_BSPAKU_POLLUT_GND, this.pos);
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
                // (startSoundActorWithInfo, by its fall speed: not here)
                w.sound(SE.BS_BSPAKU_POLLUT_IMI, this.pos, { hold: holdKey(this, 'imi') });
                w.sound(SE.BS_BSPAKU_POLLUT_FLY, this.pos, { hold: holdKey(this, 'fly') });
            }
        } else if (this.unk80 === 2 && this.stamp.mactor!.curAnmEndsNext(ANM_BCK)) this.unk80 = 0;
        this.pos.set(n);
    }
    launch(p: V3, v: V3) {
        this.unk6C.set(v); this.pos.set(p); this.scale.set(1, 1, 1); this.rot.zero();
        this.unk80 = 1; this.unk84 = 0;
        this.ball.mactor!.setBck('pollut_ball');
        this.ball.mactor!.setAnimation('pollut_ball_01', ANM_BTK);
        this.ball.mactor!.setAnimation('pollut_ball_02', ANM_BTK);
        this.unk88 = p.y;
    }
    perform(cue: number) {
        if (this.unk80 === 0) return;
        if (cue & CUE_MOVE) {
            this.move(); ++this.unk84;
            for (const c of this.collisions) {
                if (!c.isActorType(AT.MARIO)) continue;
                c.receiveMessage(this, MSG.ATTACK);
                this.unk80 = !this.owner.world.mario.isJumping() ? 2 : 0;   // SMS_IsMarioTouchGround4cm
            }
        }
        if (cue & CUE_CALC_ANIM) {
            this.ball.place(this.pos, this.scale);
            if (this.unk80 === 2) { const s = this.owner.P.mSLPollBallStampScale; this.stamp.place(this.pos, new V3(s, s, s)); }
            if (this.unk80 === 1) this.ball.mactor!.frameUpdate();
            if (this.unk80 === 2) this.stamp.mactor!.frameUpdate();
        }
        // CUE_ENTRY: gpPollution->stampModel(the stamp model, posed at its frame): drawn into the goop from above
        if ((cue & CUE_CALC_ANIM) && this.unk80 === 2 && this.owner.world.pollution)
            this.owner.world.pollution.stampModel(this.stamp.mactor!, this.stamp.baseTR, this.stamp.scale);
    }
}
/** One of the goop ball's models (drawn while its state says). */
class PolModel extends SpineEnemy {
    constructor(owner: BossPakkun, file: string, public drop: PolDrop | null, public shown: (() => boolean) | null = null) {
        super(owner.world, file);
        this.manager = owner.manager; this.mactor = this.createMActorByName(file); this.manager = null;
    }
    place(p: V3, s: V3) { this.pos.set(p); this.scale.set(s); this.rot.zero(); this.calcRootMatrixBasic(); }
    perform() { }
    drawn() {
        if (this.shown) return this.shown();
        const d = this.drop!; return d.unk80 === 1 ? this === d.ball : d.unk80 === 2 ? this === d.stamp : false;
    }
}

/** rand() * (1 / 32768) */
const randF = () => fr(rand() * (1 / 32768));
const DEG2SHORT = (d: number) => s16(Math.trunc(d * (65536 / 360)));

// ---------------------------------------------------------------- TBPVomit
/** The goop he vomits: its model plays once from his root (index 0), its white twin stamps the goop (index 1). */
export class Vomit {
    a: PolModel; white: PolModel;
    constructor(public owner: BossPakkun) {
        this.a = new PolModel(owner, 'bosspakuPollut.bmd', null, () => this.a.mactor!.getCurAnmIdx(ANM_BCK) >= 0);
        this.white = new PolModel(owner, 'bosspakuPollut_white.bmd', null, () => false);
        owner.world.extras.push(this.a);
        this.a.mactor!.setBckFromIndex(-1); this.white.mactor!.setBckFromIndex(-1);
    }
    vomit() {
        const o = this.owner;
        this.a.mactor!.setBckFromIndex(0); this.white.mactor!.setBckFromIndex(1);
        for (const m of [this.a, this.white]) { m.baseTR.set(o.baseTR); m.pos.set(o.pos); m.rot.set(o.rot); m.scale.set(o.scale); }
    }
    vomitFinished() { this.a.mactor!.setBckFromIndex(-1); this.white.mactor!.setBckFromIndex(-1); }
    perform(cue: number) {
        const a = this.a.mactor!;
        if (a.getCurAnmIdx(ANM_BCK) < 0) return;
        if ((cue & CUE_CALC_ANIM) && a.curAnmEndsNext(ANM_BCK)) { this.vomitFinished(); return; }
        if (cue & CUE_CALC_ANIM) this.white.mactor!.frameUpdate();
        // CUE_ENTRY: gpPollution->stampModel(the white model, posed at its frame): the goop where it lies
        if ((cue & CUE_CALC_ANIM) && this.owner.world.pollution)
            this.owner.world.pollution.stampModel(this.white.mactor!, this.white.baseTR, this.white.scale);
        if (cue & CUE_CALC_ANIM) a.frameUpdate();
    }
}

// ---------------------------------------------------------------- TBPTornado
export class Tornado extends HitActor {
    model: PolModel; unk70 = new V3(); unk7C = new V3(); unk88 = new V3(); unk94 = 0; unk98 = 0;
    constructor(public owner: BossPakkun) {
        super('<TBPTornado>');
        this.model = new PolModel(owner, 'trunade.bmd', null, () => this.unk98 !== 0 && !owner.checkLiveFlag(LF.DEAD));
        owner.world.extras.push(this.model);
        this.initHitActor(AT.BOSS_PAKKUN_ATTACK, 5, HC.PLAYER | HC.WATER, 150, 600, 100, 600);
        this.onHitFilter(HF.NO_COLLISION);
        const m = this.model.mactor!;
        m.setFromIndex(ANM_BTK, 2); m.setBckFromIndex(29); m.setFromIndex(ANM_BRK, 1);
        this.scale.set(2, 2, 2);
    }
    vanish() {
        this.onHitFilter(HF.NO_COLLISION); this.unk98 = 2;
        const c = this.model.mactor!.getFrameCtrl(ANM_BRK);
        if (c) { c.frame = 0; c.rate = ANM_FRAME_RATE; }
    }
    launch(target: V3) {
        const o = this.owner;
        this.unk98 = 1; this.unk70.set(target); this.pos.set(o.pos); this.unk7C.set(o.pos);
        this.unk94 = o.P.mSLTornadoMoveInit;
        this.offHitFilter(HF.NO_COLLISION);
        const c = this.model.mactor!.getFrameCtrl(ANM_BRK);
        if (c) { c.frame = 0; c.rate = 0; }
    }
    perform(cue: number) {
        const o = this.owner, P = o.P;
        if (o.checkLiveFlag(LF.DEAD) || this.unk98 === 0) return;
        if (cue & CUE_CALC_ANIM) o.world.sound(SE.BS_BSPAKU_TORNADO, this.pos, { hold: holdKey(this, 'tornado') });   // (by its distance to Mario: not here)
        if (cue & CUE_MOVE) {
            if (this.unk98 === 2) {
                this.pos.add(this.unk88);
                if (this.model.mactor!.curAnmEndsNext(ANM_BRK)) { this.unk98 = 0; return; }
            } else {
                this.unk94 = fr(this.unk94 + P.mSLTornadoMoveInc);
                if (this.unk94 > P.mSLTornadoMoveLimit) { this.vanish(); return; }
                const angle = fr(360 - (Math.trunc(this.unk94) % 360));
                const radius = fr(this.unk94 * P.mSLTornadoRollSpeed);
                const dir = V3.sub(this.unk70, this.unk7C);
                if (dir.length() < 100) { this.vanish(); return; }
                dir.normalize().scale(P.mSLTornadoSpeed);
                this.unk7C.add(dir);
                const a = DEG2SHORT(angle);
                const n = new V3(fr(this.unk7C.x + radius * JMASCos(a)), this.unk7C.y, fr(this.unk7C.z + radius * JMASSin(a)));
                const [h, d] = o.world.checkGround(n.x, n.y + 200, n.z);
                if (!d.isIllegal()) n.y = h;
                const p = { x: n.x, z: n.z };
                const hitWall = o.world.isTouchedOneWallAndMoveXZ(p, n.y, 80);
                n.x = p.x; n.z = p.z;
                if (hitWall) this.vanish();
                this.unk88 = V3.sub(n, this.pos);
                this.pos.set(n);
                // Mario caught: attacked, thrown up (SMS_ThrowMario) — the ghost carries him
                for (const c of this.collisions) if (c.isActorType(AT.MARIO)) this.vanish();
            }
        }
        if (cue & CUE_CALC_ANIM) {
            this.model.place(this.pos, this.scale);
            this.model.mactor!.frameUpdate();
        }
    }
}

// ---------------------------------------------------------------- TBPHeadHit / TBPNavel
export class HeadHit extends HitActor {
    constructor(public owner: BossPakkun, name: string) {
        super(name);
        this.initHitActor(AT.BOSS_PAKKUN_ATTACK, 5, HC.PLAYER | HC.WATER, 300, 500, 300, 500);
        this.offHitFilter(HF.NO_COLLISION);
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        const o = this.owner;
        if (o.spine!.getLatestNerve() === BPNerves.sleep) return o.receiveMessage(sender, msg);
        if (o.weakPoint === WEAK_FLY && (sender.actorType === AT.POPO || sender.actorType === AT.WATER)) { o.gotFlyingDamage(); return true; }
        if (o.weakPoint !== WEAK_MOUTH) {
            o.showFlyMessage();
            return sender.actorType === AT.WATER;
        }
        if (sender.actorType === AT.WATER && msg === MSG.SPRAYED_BY_WATER) {
            const t = V3.sub(o.world.mario.pos, this.pos);
            const ang = MsAngleDiff(MsGetRotFromZaxisY(t), o.rot.y);
            if (Math.abs(ang) < 0.5 * o.P.mSLDamageAngle) o.gotWaterDamage();
            return true;
        }
        return true;
    }
    perform(cue: number) {
        // (Mario touching his head while it swings is thrown: the ghost carries him)
        if (cue & CUE_CALC_ANIM) this.pos.set(this.owner.getJointTrans(1));
    }
}
export class Navel extends HitActor {
    constructor(public owner: BossPakkun, name: string) {
        super(name);
        this.initHitActor(AT.BOSS_PAKKUN_HEAD, 1, HC.PLAYER, 200, 300, 200, 300);
        this.offHitFilter(HF.NO_COLLISION);
    }
    receiveMessage(sender: HitActor, msg: number): boolean {
        const o = this.owner;
        if (o.spine!.getLatestNerve() === BPNerves.sleep) return o.receiveMessage(sender, msg);
        if (sender.actorType === AT.WATER) return false;
        if (o.weakPoint !== WEAK_NAVEL) return true;
        if (sender.actorType === AT.MARIO) {
            if (msg === MSG.HIP_DROP) o.gotHipDropDamage();
            else if (msg === MSG.TRAMPLE) o.gotTrampleDamage();
        }
        return true;
    }
    perform(cue: number) { if (cue & CUE_CALC_ANIM) this.pos.set(this.owner.getJointTrans(6)); }
}

// ---------------------------------------------------------------- TBossPakkun
const WEAK_NONE = 0, WEAK_NAVEL = 1, WEAK_MOUTH = 2, WEAK_FLY = 3;

export class BossPakkunManager extends EnemyManager {
    constructor(w: World, name: string, public unk54: number) { super(w, name); }
    load(s: Stream) { this.saveParams = readParams('/enemy/bosspakkun.prm', this.world.files, BOSS_PARAMS); super.load(s); }
    createModelData() {
        this.createModelDataArray(this.unk54 ? ['bosspaku_model.bmd', 'pollut_ball.bmd', 'pollut_ball_stamp.bmd']
            : ['bosspaku_model.bmd', 'bosspaku_end.bmd', 'pollut_ball.bmd', 'pollut_ball_stamp.bmd', 'bosspakuPollut.bmd', 'bosspakuPollut_white.bmd', 'trunade.bmd']);
    }
}
export class BossPakkun extends SpineEnemy {
    unk154 = 0; polDrop: PolDrop | null = null; vomit: Vomit | null = null; tornado: Tornado | null = null;
    headHit: HeadHit | null = null; navel: Navel | null = null;
    weakPoint = WEAK_NONE; unk170 = 0; unk174 = 0; unk178 = 0; unk17C = 0;
    endModel: PolModel | null = null; unk184 = 0; unk188: AreaCylinderManager | null = null; unk18C: EmitInfo | null = null;
    unk190 = 0; unk1B8 = 0; unk1BC = 0; unk1C0 = 0; unk1C4 = 0; unk1CC = 0;
    body: MoveCollision | null = null;
    /** the model's joint matrices at its last calc (J3DModel::getAnmMtx) */
    joints: mat4[] | null = null;
    get P(): any { return this.getSaveParam(); }
    get light() { return (this.manager as BossPakkunManager).unk54 !== 0; }
    constructor(w: World, name = 'ボスパックン') { super(w, name); this.offLiveFlag(LF.ENABLE_CLIPPING); this.binder = new Walker(); }
    init(m: any) {
        this.manager = m; m.manageActor(this);
        this.mactor = this.createMActorByName('bosspaku_model.bmd');
        if (!this.light) {
            this.endModel = new PolModel(this, 'bosspaku_end.bmd', null, () => !this.checkLiveFlag(LF.DEAD) && this.spine!.isNerve(BPNerves.die));
            this.endModel.mactor!.setBckFromIndex(7); this.endModel.mactor!.setFromIndex(ANM_BRK, 0);
            this.world.extras.push(this.endModel);
        }
        this.initHitActor(AT.BOSS_PAKKUN, 1, HC.PLAYER, 80, 300, 80, 300);
        this.offHitFilter(HF.NO_COLLISION);
        if (!this.light) {
            this.headHit = new HeadHit(this, 'ボスパックン頭部');
            this.navel = new Navel(this, 'ボスパックンへそ');
            this.world.addToGroup('敵グループ', this.headHit);
            this.world.addToGroup('敵グループ', this.navel);
            this.body = new MoveCollision(this.world, '/scene/bosspakkun/col_body.col', this);
            this.calcRootMatrixBasic(); this.calcJoints();
        }
        const w = this.world;
        if (this.light) this.spine!.initWith(BPNerves.waitL);
        else if (w.map === 0x37) this.spine!.initWith(BPNerves.fall);
        else if (w.stage === 4) this.spine!.initWith(BPNerves.sleep);
        else this.spine!.initWith(BPNerves.wait);
        this.polDrop = new PolDrop(this);
        if (!this.light) {
            this.vomit = new Vomit(this);
            this.tornado = new Tornado(this);
            this.world.addToGroup('敵グループ', this.tornado);
            try { this.unk18C = emitInfo('/enemy/bosspakuwater.prm', this.world.files); } catch { this.unk18C = null; }
        }
        this.onLiveFlag(LF.FORCE_SHADOW);
        this.scaledBodyRadius = 400;
        this.tracer.init(this.world.graphByName('bosspakkun'));
        if (this.tracer.graph) { this.tracer.reset(); this.goToShortestNextGraphNode(); }
        this.resetHitPoints();
    }
    /** TBossPakkunMtxCalc (M3UMtxCalcSIAnmBlendQuat, basic): the BCKs it blends between and how far */
    mc = { newIdx: -1, oldIdx: -1, oldFrame: 0, ratio: 0 };
    /** each joint's matrix in its parent's, as the calc left it (the viewer draws these) */
    locals: mat4[] = [];
    private calcJoints() {
        const a = this.mactor;
        if (!a) return;
        if (this.light) { this.joints = a.anmMtxAll(this.baseTR, this.scale); return; }
        const sk = Skeleton.of(a.data.files.scene(a.model));
        if (!sk) return;
        const bck = (i: number) => { const e = a.data.anms[ANM_BCK][i]; return e ? parseBCK(a.data.files.scene(a.data.folder + '/' + e.name + '.bck')) : null; };
        const mc = this.mc, fc = a.getFrameCtrl(ANM_BCK);
        const nw = mc.newIdx >= 0 ? { anm: bck(mc.newIdx), frame: fc ? fc.frame : 0 } : null;
        const old = mc.oldIdx >= 0 ? { anm: bck(mc.oldIdx), frame: mc.oldFrame } : null;
        this.joints = jointMatricesBlend(sk, nw, old, mc.ratio, true, this.baseTR, [this.scale.x, this.scale.y, this.scale.z], this.joints || [], this.locals, (j, m) => {
            this.calcBellyScale(j, m);
            this.calcHeadDir(j, m);
        });
    }
    /** TBossPakkunMtxCalc::calcBellyScale: the belly (joints 4 and 36) swells with the water mark */
    private calcBellyScale(j: number, m: mat4) {
        if (j !== 4 && j !== 36) return;
        let t: number;
        if (this.unk17C !== 0) t = fr(this.unk1B8 / 50);
        else { const lim = this.P.mSLWaterMarkLimit; t = fr(Math.min(this.unk178, lim) / lim); }
        const b = JMAHermiteInterpolation(t, 0, 0, 10, 1, 1, 0);
        const [g, s0] = j === 36 ? [[1.4, 1.4, 1.6], [1, 0.8, 0.8]] : [[1.3, 1.7, 1.7], [1, 0.9, 0.9]];
        mat4.scale(m, m, [0, 1, 2].map((k) => fr(b * fr(fr(g[k]) - fr(s0[k])) + fr(s0[k]))) as [number, number, number]);
    }
    /** TBossPakkunMtxCalc::calcHeadDir: the head (joint 18) turns toward Mario while he waits, 1° a calc, at most mSLHeadHomingLimit */
    private calcHeadDir(j: number, m: mat4) {
        if (j !== 18) return;
        const mario = this.world.mario.pos;
        const toMario = new V3(fr(mario.x - m[12]), fr(mario.y - m[13]), fr(mario.z - m[14]));
        const axis = new V3(m[4], 0, m[6]);
        let hr = this.unk184;
        const headAngle = MsGetRotFromZaxisY(axis);
        const desired = this.mactor!.checkCurBckFromIndex(25) ? MsWrap(fr(hr + MsGetRotFromZaxisY(toMario)), 0, 360) : headAngle;
        const delta = MsAngleDiff(desired, headAngle), lim = this.P.mSLHeadHomingLimit;
        const ld = delta > 0 ? Math.min(delta, lim) : Math.max(delta, -lim);
        const turn = MsAngleDiff(ld, hr);
        hr = fr(hr + (turn > 0 ? Math.min(turn, 1) : Math.max(turn, -1)));
        this.unk184 = hr;
        const sn = MsSin(hr), c = MsCos(hr);
        mat4.mul(m, m, mat4.fromValues(1, 0, 0, 0, 0, c, sn, 0, 0, -sn, c, 0, 0, 0, 0, 1));
    }
    /** getJointTransByIndex */
    getJointTrans(i: number): V3 {
        if (this.light) {
            if (!this.mactor || this.checkLiveFlag(LF.CLIPPED_OUT)) return this.pos.clone();
            if (!this.joints) this.calcJoints();
        }
        const m = this.joints && this.joints[i];
        return m ? new V3(m[12], m[13], m[14]) : this.pos.clone();
    }
    is2ndFightNow() { return this.world.map === 2 && this.world.stage === 4; }
    inArea(p: V3) {
        if (!this.unk188) this.unk188 = this.world.search('ゲロエリアマネージャー') as AreaCylinderManager | null;
        return this.unk188 ? this.unk188.contain(p) : false;
    }
    /** SMS_GetMarioGrPlane is his body, he touched down on it (status UNK200 and not UNK200000): once per landing. */
    checkMarioRiding() {
        const m = this.world.mario, g = m.groundPlane;
        const on = !!g && g.actor === this && !m.isJumping();
        if (this.unk190 === 0) { if (on) { this.unk190 = 1; return true; } }
        else if (!on) this.unk190 = 0;
        return false;
    }
    startBGM() { if (this.unk1CC === 0) this.unk1CC = 1; }
    showMessage(msg: number) {
        const i = msg - 0xe0000, mask = i === 1 ? 0 : 1 << i;
        if (!(this.unk1C0 & mask)) this.world.effect('balloon:' + msg.toString(16), this.pos);
        this.unk1C0 |= mask;
    }
    showFlyMessage() { if (this.is2ndFightNow() && this.spine!.isNerve(BPNerves.fly)) this.showMessage(0xe0002); }
    resetWaterMark() {
        if (this.unk17C !== 0) return;
        this.unk17C = 1; this.unk174 = 0; this.unk170 = 0; this.unk1B8 = 50;
        if (this.unk18C && this.world.water) {
            const p = this.getJointTrans(18); p.y = fr(p.y + 250);
            this.unk18C.pos = [p.x, p.y, p.z];
            this.world.water.emitRequest(this.unk18C);
        }
    }
    gotFlyingDamage() {
        this.weakPoint = WEAK_NONE;
        this.spine!.reset(); this.spine!.setNext(BPNerves.fall);
        this.world.sound(SE.BS_BSPAKU_FALL, this.pos);
    }
    gotWaterDamage() {
        if (this.unk17C !== 0) return;
        this.unk170 += 1;
        if (this.unk178 < this.P.mSLWaterMarkLimit) this.unk178 += 1;
        this.unk174 = this.P.mSLWaterHitTimer;
        if (!this.spine!.isNerve(BPNerves.swallow)) { this.spine!.reset(); this.spine!.setNext(BPNerves.swallow); }
    }
    gotHipDropDamage() {
        const sp = this.spine!;
        this.decHitPoints();
        this.weakPoint = WEAK_NONE;
        if (this.hitPoints === 0) {
            if (!sp.isNerve(BPNerves.preDie) && !sp.isNerve(BPNerves.die)) { sp.setNext(BPNerves.preDie); this.world.sound(SE.BS_BSPAKU_DOWN, this.pos); }
        } else if (!sp.isNerve(BPNerves.tumbleOut)) {
            this.world.sound(SE.BS_BSPAKU_DAMAGE, this.pos);
            sp.reset();
            sp.setNext(this.world.stage === 4 ? BPNerves.takeOff : BPNerves.wait);
            sp.pushNerve(BPNerves.getUp);
            sp.pushNerve(BPNerves.stompReact);
        }
    }
    gotTrampleDamage() { }
    launchPolDrop() {
        const d = this.polDrop!;
        if (d.unk80 !== 0) return;
        let p: V3;
        if (this.checkLiveFlag(LF.CLIPPED_OUT)) { p = this.pos.clone(); p.x = fr(p.x + 1); } else p = this.getJointTrans(18);
        const m = this.world.mario;
        const a = DEG2SHORT(m.rot.y);
        const front = this.P.mSLPollBallFront;
        const target = new V3(fr(front * JMASSin(a)), 0, fr(front * JMASCos(a))).add(m.pos);
        d.launch(p, calcJumpVelocityXZ(target, p, this.P.mSLPollBallSpeed, 0.1));
    }
    launchTornado() { this.tornado!.launch(this.world.mario.pos); }
    killSmallEnemies() {
        const m = this.world.search('ナメクリマネージャー') as any;
        if (m && m.killChildren) m.killChildren();
    }
    /** changeBck: the BCK, joined into the motion blend for its blend time */
    changeBck(i: number) {
        const a = this.mactor!, P = this.P;
        if (a.checkCurBckFromIndex(i) && !a.curAnmEndsNext(ANM_BCK)) return;
        const prev = a.getCurAnmIdx(ANM_BCK), c0 = a.getFrameCtrl(ANM_BCK);
        // TBossPakkunMtxCalc::joinAnm: the old animation stays where it was
        const mc = this.mc;
        if (mc.newIdx !== i) { mc.oldIdx = mc.newIdx; mc.oldFrame = c0 ? c0.frame : 0; mc.newIdx = i; mc.ratio = 1; }
        a.setBckFromIndex(i);
        if (i === 21) a.getFrameCtrl(ANM_BCK)!.rate = P.mSLVomitAnmRate;
        let bt = -1;
        if (prev === 25) { if (i === 21 || i === 26) bt = P.mSLAnmBlendTime0; }
        else if (prev === 18 || prev === 2 || prev === 20) { if (i === 25) bt = P.mSLAnmBlendTime0; }
        else if (prev === 26) { if (i === 22) bt = P.mSLAnmBlendTime0; }
        if (bt < 0) { const c = a.getFrameCtrl(ANM_BCK); if (c) bt = fr(0.1 * c.end); }
        this.unk154 = bt === 0 ? 1 : fr(1 / bt);
    }
    flyToCurPathNode(speed: number, turn: number) {
        this.turnToCurPathNode(turn);
        const v = V3.sub(this.goal.point(), this.pos).normalize().scale(speed);
        this.posDelta.add(v);
    }
    hasMapCollision() { return !!this.body; }
    /** unk114.push(unkF4); unkF4 = TPathNode(p) */
    pushGoalTo(p: V3) { this.pushGoal(this.goal); this.goal = new PathNode(null, p.clone()); }
    setGroundCollision() {
        if (!this.spine!.isNerve(BPNerves.die) && this.body && this.joints && this.joints[2]) this.body.moveMat4(this.joints[2]);
    }
    kill() {
        LiveActor.prototype.kill.call(this);
        this.onHitFilter(HF.NO_COLLISION);
        if (this.headHit) this.headHit.onHitFilter(HF.NO_COLLISION);
        if (this.navel) this.navel.onHitFilter(HF.NO_COLLISION);
        if (this.polDrop) this.polDrop.onHitFilter(HF.NO_COLLISION);
    }
    receiveMessage(sender: HitActor, _m: number): boolean {
        if (this.light) return false;
        if (this.spine!.isNerve(BPNerves.sleep) && sender.actorType === AT.POPO) { this.spine!.reset(); this.spine!.setNext(BPNerves.breakSleep); return true; }
        if (this.weakPoint === WEAK_FLY && (sender.actorType === AT.POPO || sender.actorType === AT.WATER)) {
            if (this.pos.y - 300 > sender.pos.y) return true;
            if (this.pos.y + 1500 < sender.pos.y) return true;
            this.gotFlyingDamage();
            return true;
        }
        return false;
    }
    drawn() { return super.drawn() && !(this.endModel && this.spine!.isNerve(BPNerves.die)); }
    perform(cue: number) {
        if (this.polDrop) this.polDrop.perform(cue);
        if (this.vomit) this.vomit.perform(cue);
        if (this.tornado) this.tornado.perform(cue);
        if (this.checkLiveFlag(LF.DEAD)) return;
        if (this.headHit) this.headHit.perform(cue);
        if (this.navel) this.navel.perform(cue);
        const full = !this.light;
        if (full && (cue & CUE_MOVE)) {
            // mMtxCalc->advanceMotionBlend(-unk154)
            this.mc.ratio = Math.min(1, Math.max(0, fr(this.mc.ratio - this.unk154)));
            if (this.unk17C) {
                if (this.unk178 <= 0) { this.unk17C = 0; this.unk178 = 0; }
                else {
                    let step = Math.trunc(this.P.mSLWaterMarkLimit / 100);
                    if (step === 0) step = 1;
                    this.unk178 -= step;
                    if (this.unk178 < 0) this.unk178 = 0;
                }
            }
            if (this.unk17C === 0 && this.unk174 > 0) { this.unk174--; this.unk170++; }
            if (this.unk1BC) { if (this.unk1B8 <= 0) { this.unk1BC = 0; this.unk1B8 = 0; } else this.unk1B8--; }
            if (this.weakPoint === WEAK_NAVEL && this.checkMarioRiding() && !this.spine!.isNerve(BPNerves.jumpReact)) this.spine!.pushNerve(BPNerves.jumpReact);
        }
        if (full && this.spine!.isNerve(BPNerves.die)) {
            // the dying model takes the main one's place
            const orig = this.mactor;
            this.mactor = this.endModel!.mactor;
            SpineEnemy.prototype.perform.call(this, cue);
            this.mactor = orig;
            if (cue & CUE_CALC_ANIM) { this.endModel!.baseTR.set(this.baseTR); this.endModel!.scale.set(this.scale); }
            return;
        }
        if (full && (cue & CUE_CALC_ANIM)) this.updateSquareToMario();
        super.perform(cue);
        if (full && (cue & CUE_CALC_ANIM)) this.calcJoints();
    }
}

type S = Spine<BossPakkun>;
export const BPNerves: Record<string, any> = {};
/** the episode-8 choice after a wait or a fall: vomit then take off, a tornado, or wait */
function chooseSecondFight(spine: S, self: BossPakkun) {
    if (self.tornado!.unk98 !== 0 || randF() < self.P.mSLTornadoProp) { spine.pushAfterCurrent(BPNerves.takeOff); spine.pushAfterCurrent(BPNerves.vomit); }
    else if (self.tornado!.unk98 === 0) { spine.pushAfterCurrent(BPNerves.wait); spine.pushAfterCurrent(BPNerves.tornado); }
    else spine.pushAfterCurrent(BPNerves.wait);
}
BPNerves.wait = nerve<BossPakkun>('TNerveBPWait', (spine: S) => {
    const self = spine.body, w = self.world, mario = w.mario.pos;
    const t = V3.sub(self.pos, mario), sw = self.P.mSLSwingLength;
    if (t.squared() < sw * sw) {
        const yaw = MsGetRotFromZaxisY(new V3(-t.x, -t.y, -t.z));
        if (Math.abs(MsAngleDiff(yaw, self.rot.y)) < 60) { spine.pushAfterCurrent(BPNerves.wait); spine.pushAfterCurrent(BPNerves.swing); return true; }
        spine.pushAfterCurrent(BPNerves.wait); spine.pushAfterCurrent(BPNerves.vomit);
        self.pushGoalTo(mario);
        spine.pushAfterCurrent(BPNerves.pivot);
        return true;
    }
    if (spine.time === 0) self.changeBck(25);
    if (spine.time >= self.P.mSLWaitFrameStg0 && self.mactor!.isCurAnmAlreadyEnd(ANM_BCK)) {
        if (w.map === 2 && (w.stage === 0 || w.stage === 1)) {
            if (self.inArea(mario) && !w.mario.groundPlane.isWaterSurface()) { spine.pushAfterCurrent(BPNerves.cannon); return true; }
            spine.pushAfterCurrent(BPNerves.wait); return true;
        }
        if (w.stage === 4) { chooseSecondFight(spine, self); return true; }
        spine.pushAfterCurrent(BPNerves.wait); spine.pushAfterCurrent(BPNerves.vomit);
        const g = self.pos.clone();
        g.x = fr(g.x + 10000 * (randF() - 0.5));
        g.z = fr(g.z + 10000 * (randF() - 0.5));
        self.pushGoalTo(g);
        spine.pushAfterCurrent(BPNerves.pivot);
        return true;
    }
    return false;
});
BPNerves.cannon = nerve<BossPakkun>('TNerveBPCannon', (spine: S) => {
    const self = spine.body, a = self.mactor!;
    if (spine.time === 0) self.changeBck(21);
    if (a.curAnmEndsNext(ANM_BCK)) {
        if (a.checkCurBckFromIndex(21)) { self.changeBck(2); self.launchPolDrop(); }
        else { spine.pushAfterCurrent(BPNerves.wait); return true; }
    }
    return false;
});
BPNerves.vomit = nerve<BossPakkun>('TNerveBPVomit', (spine: S) => {
    const self = spine.body, a = self.mactor!;
    if (spine.time === 0) self.changeBck(21);
    if (a.checkCurBckFromIndex(21)) {
        const f = a.getFrameCtrl(ANM_BCK)!.frame;
        self.weakPoint = 25 < f && f < 165 ? WEAK_MOUTH : WEAK_NONE;
    }
    if (a.checkCurBckFromIndex(20) && randF() < 0.2 && spine.time === 500) {
        const ang = DEG2SHORT(self.rot.y);
        self.world.events.push({ t: self.world.tickCount, kind: 'item', data: { type: AT.BOTTLE_LARGE, p: new V3(fr(self.pos.x + 700 * JMASSin(ang)), fr(self.pos.y + 1), fr(self.pos.z + 700 * JMASCos(ang))) } });
    }
    if (a.curAnmEndsNext(ANM_BCK)) {
        if (a.checkCurBckFromIndex(21)) { self.weakPoint = WEAK_NONE; self.changeBck(20); self.vomit!.vomit(); }
        else {
            if (!self.is2ndFightNow()) { if (!(self.unk1C0 & 1)) self.world.effect('balloon:e0000', self.pos); self.unk1C0 |= 1; }
            return true;
        }
    }
    if (a.checkCurBckFromIndex(20) && self.world.water) self.world.water.wind(new V3(MsSin(self.rot.y), 0, MsCos(self.rot.y)));
    return false;
});
BPNerves.tornado = nerve<BossPakkun>('TNerveBPTornado', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(24);
    if (spine.time === 150) self.launchTornado();
    return self.mactor!.isCurAnmAlreadyEnd(ANM_BCK);
});
BPNerves.pivot = nerve<BossPakkun>('TNerveBPPivot', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(25);
    const d = V3.sub(self.pos, self.world.mario.pos), sw = self.P.mSLSwingLength;
    const sp = d.squared() < sw * sw ? self.P.mSLPivotSpeedAware : self.P.mSLPivotSpeed;
    if (self.turnToCurPathNode(sp)) { self.switchNextGoalPath(); return true; }
    return false;
});
BPNerves.swallow = nerve<BossPakkun>('TNerveBPSwallow', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(26);
    if (self.unk178 >= self.P.mSLWaterMarkLimit) { spine.pushAfterCurrent(BPNerves.tumbleIn); self.weakPoint = WEAK_NONE; self.unk170 = 0; return true; }
    if (self.unk170 !== 0) { self.changeBck(26); self.unk170 = 0; return false; }
    self.weakPoint = WEAK_NONE;
    spine.pushAfterCurrent(BPNerves.wait);
    return true;
});
BPNerves.tumbleIn = nerve<BossPakkun>('TNerveBPTumbleIn', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(3);
    if (self.mactor!.curAnmEndsNext(ANM_BCK)) { spine.pushAfterCurrent(BPNerves.tumble); return true; }
    return false;
});
BPNerves.tumble = nerve<BossPakkun>('TNerveBPTumble', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.changeBck(6); self.weakPoint = WEAK_NAVEL; }
    if (spine.time >= self.P.mSLTumbleTime) { self.weakPoint = WEAK_NONE; spine.pushAfterCurrent(BPNerves.tumbleOut); return true; }
    return false;
});
BPNerves.tumbleOut = nerve<BossPakkun>('TNerveBPTumbleOut', (spine: S) => {
    const self = spine.body, a = self.mactor!;
    if (spine.time === 0) self.changeBck(14);
    if (a.curAnmEndsNext(ANM_BCK)) {
        if (a.checkCurBckFromIndex(14)) {
            self.changeBck(22);
            if (!self.is2ndFightNow()) { self.unk1C4 += 1; if (self.unk1C4 >= 3) { self.world.effect('balloon:e0001', self.pos); self.unk1C4 = 0; } }
        } else { spine.pushAfterCurrent(BPNerves.wait); return true; }
    }
    if (a.checkCurBckFromIndex(22)) {
        const f = a.getFrameCtrl(ANM_BCK)!.frame;
        if (140 < f && f < 160) self.resetWaterMark();
        if (35 < f) self.unk1BC = 1;
    }
    return false;
});
BPNerves.getUp = nerve<BossPakkun>('TNerveBPGetUp', (spine: S) => {
    const self = spine.body, a = self.mactor!;
    if (spine.time === 0) self.changeBck(14);
    if (a.curAnmEndsNext(ANM_BCK)) { if (a.checkCurBckFromIndex(14)) self.changeBck(19); else return true; }
    return false;
});
BPNerves.swing = nerve<BossPakkun>('TNerveBPSwing', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(15);
    return self.mactor!.curAnmEndsNext(ANM_BCK);
});
BPNerves.stompReact = nerve<BossPakkun>('TNerveBPStompReact', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.changeBck(5); self.headHit!.onHitFilter(HF.NO_COLLISION); }
    if (spine.time === 30) self.resetWaterMark();
    if (spine.time === 50) self.unk1BC = 1;
    if (self.mactor!.curAnmEndsNext(ANM_BCK)) { self.headHit!.offHitFilter(HF.NO_COLLISION); return true; }
    return false;
});
BPNerves.jumpReact = nerve<BossPakkun>('TNerveBPJumpReact', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(17);
    return self.mactor!.curAnmEndsNext(ANM_BCK);
});
BPNerves.preDie = nerve<BossPakkun>('TNerveBPPreDie', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.changeBck(5); self.headHit!.onHitFilter(HF.NO_COLLISION); self.resetWaterMark(); self.killSmallEnemies(); }
    if (self.mactor!.curAnmEndsNext(ANM_BCK)) { spine.pushAfterCurrent(BPNerves.die); return true; }
    return false;
});
BPNerves.die = nerve<BossPakkun>('TNerveBPDie', (spine: S) => {
    // (runs with the dying model as its MActor: TBossPakkun::perform)
    const self = spine.body, a = self.mactor!;
    if (a.checkCurBckFromIndex(7) && spine.time === 680) self.onLiveFlag(LF.UNK8);
    if (a.curAnmEndsNext(ANM_BCK) && a.checkCurBckFromIndex(7)) {
        self.kill();
        const im = mapObjGlobals(self.world).itemManager as ItemManager | null;
        if (im) im.makeShineAppearWithDemo('シャイン（ボス用）', 'ボスシャインカメラ', self.pos.x, self.pos.y, self.pos.z);
        return true;
    }
    return false;
});
BPNerves.takeOff = nerve<BossPakkun>('TNerveBPTakeOff', (spine: S) => {
    const self = spine.body, a = self.mactor!;
    if (spine.time === 0) { self.onLiveFlag(LF.UNK10); self.onLiveFlag(LF.AIRBORNE); self.changeBck(13); }
    if (a.checkCurBckFromIndex(13) && a.curAnmEndsNext(ANM_BCK)) self.changeBck(11);
    if (a.checkCurBckFromIndex(11)) {
        self.pos.y = fr(self.pos.y + 5);
        const g = self.goal104.point();
        if (g.y < self.pos.y) {
            self.pos.y = g.y;
            spine.pushAfterCurrent(self.tracer.graph ? BPNerves.fly : BPNerves.touchDown);
            return true;
        }
    }
    return false;
});
BPNerves.fly = nerve<BossPakkun>('TNerveBPFly', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) { self.changeBck(11); self.goToRandomNextGraphNode(); self.startBGM(); }
    const t = V3.sub(self.goal104.point(), self.pos); t.y = 0;
    if (t.length() < 100) {
        const tr = self.tracer;
        if (!tr.graph!.checkFlag(tr.cur, 0x800)) self.goToRandomNextGraphNode();
        else { spine.pushAfterCurrent(BPNerves.hover); return true; }
    }
    self.flyToCurPathNode(self.P.mSLFlySpeed, self.turnSpeed);
    return false;
});
BPNerves.touchDown = nerve<BossPakkun>('TNerveBPTouchDown', (spine: S) => {
    const self = spine.body, a = self.mactor!;
    if (spine.time === 0) self.changeBck(11);
    if (a.checkCurBckFromIndex(11)) {
        self.pos.y = fr(self.pos.y - 5);
        const g = self.goal104.point();
        if (g.y > self.pos.y) { self.pos.y = g.y; self.changeBck(18); self.offLiveFlag(LF.UNK10); }
    }
    if (a.checkCurBckFromIndex(18) && a.curAnmEndsNext(ANM_BCK)) { spine.pushAfterCurrent(BPNerves.wait); return true; }
    return false;
});
BPNerves.flyCannon = nerve<BossPakkun>('TNerveBPFlyCannon', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(12);
    if (spine.time === 168) self.launchPolDrop();
    return self.mactor!.curAnmEndsNext(ANM_BCK);
});
BPNerves.flyPivot = nerve<BossPakkun>('TNerveBPFlyPivot', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(11);
    if (self.turnToCurPathNode(self.P.mSLPivotSpeed)) { self.switchNextGoalPath(); return true; }
    return false;
});
BPNerves.hover = nerve<BossPakkun>('TNerveBPHover', (spine: S) => {
    const self = spine.body, mario = self.world.mario.pos;
    if (spine.time === 0) { self.changeBck(16); self.weakPoint = WEAK_FLY; }
    const r = self.P.mSLPollBallRange;
    if (self.inArea(mario) && self.distToMarioSq < r * r) {
        spine.pushAfterCurrent(BPNerves.hover); spine.pushAfterCurrent(BPNerves.flyCannon);
        self.pushGoalTo(mario);
        spine.pushAfterCurrent(BPNerves.flyPivot);
        return true;
    }
    if (spine.time >= self.P.mSLHoverTimer) { spine.pushAfterCurrent(BPNerves.fly); self.weakPoint = WEAK_NONE; return true; }
    return false;
});
BPNerves.fall = nerve<BossPakkun>('TNerveBPFall', (spine: S) => {
    const self = spine.body, a = self.mactor!;
    if (spine.time === 0) { self.offLiveFlag(LF.UNK10); self.onLiveFlag(LF.AIRBORNE); self.changeBck(10); }
    if (a.checkCurBckFromIndex(10)) { if (a.curAnmEndsNext(ANM_BCK)) self.changeBck(9); }
    else if (a.checkCurBckFromIndex(9)) { if (!self.isAirborne()) self.changeBck(8); }
    else if (a.checkCurBckFromIndex(8)) { if (a.curAnmEndsNext(ANM_BCK)) self.changeBck(14); }
    else if (a.checkCurBckFromIndex(14) && a.curAnmEndsNext(ANM_BCK)) {
        if (self.is2ndFightNow()) chooseSecondFight(spine, self);
        else spine.pushAfterCurrent(BPNerves.wait);
        return true;
    }
    return false;
});
BPNerves.sleep = nerve<BossPakkun>('TNerveBPSleep', (spine: S) => {
    if (spine.time === 0) spine.body.changeBck(23);
    return false;
});
BPNerves.breakSleep = nerve<BossPakkun>('TNerveBPBreakSleep', (spine: S) => {
    const self = spine.body;
    if (spine.time === 0) self.changeBck(14);
    if (self.mactor!.curAnmEndsNext(ANM_BCK)) { spine.pushAfterCurrent(BPNerves.takeOff); return true; }
    return false;
});
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
register('BossPakkunManager', (w, n) => new BossPakkunManager(w, n, 0));
register('BossPakkun', (w, n) => new BossPakkun(w, n));
export { MActor };
