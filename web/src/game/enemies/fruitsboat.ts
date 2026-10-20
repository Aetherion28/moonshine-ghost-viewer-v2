// TFruitsBoat / TFruitsBoatManager (Enemy/fruitsboat.cpp): the fruit boats (フルーツの船) of Delfino
// Plaza, the Airstrip and Pinna — ShipDolpic 1-4 (the manager's type picks the model, its
// collision and its attack size). A boat rows along its graph (TNerveFruitsBoatGraphWander:
// walkToCurPathNode at mSLMoveSpeed, turning mSLRotSpeed, aiming on at each node; a node flagged
// 0x100 anchors it, a start node flagged 0x80 too, until Mario lands on it), or without a graph
// follows the BCK named like its graph (TNerveFruitsBoatBckTrace: joints 0 and 1's transforms,
// at mSLBckMoveSpeed). It pitches with the sea's waves under its bow and stern, rocks sideways
// when Mario lands on it (the axis turning towards him while he stands there), and bounces its
// sail on a bounce-on-landing floor (setJumpReaction). Its collision is only moved (so only
// there) while something touches it or Mario / Yoshi are within 1000.
//
// Not here: spline rails (rowToCurPathNode's traceSpline, init's start on the rail: TSplineRail
// isn't ported), the ponponsen sound's actor binding beyond the SE helper, the ship shadow
// (requestShadow) and the question manager's request.

import { fr, V3, mtx, Mtx, MsMtxSetRotRPH, MsSin, MsCos, MsAngleDiff, MsGetRotFromZaxis } from '../math.js';
import { World, Stream, Actor, HitActor, LiveManager, SpineEnemy, EnemyManager, MoveCollision, LF, HF, ANM_BCK, ANM_FRAME_RATE, FrameCtrl, nerve, Spine, PSchema, readParams, SPINE_PARAMS } from '../engine.js';
import { AT } from '../actortypes.js';
import { register } from '../scene.js';
import { SE } from '../soundids.js';
import '../sound.js';
import { parseBCK } from '../skeleton.js';
import { sampleAnimationData } from '../../../noclip/Common/JSYSTEM/J3D/J3DGraphAnimator.js';
import { MTXConcat, MTXRotAxisRad, mapObjWave, marioGroundPlane, marioTouchGround4cm } from '../mapobj/lib.js';
import type { mat4 } from 'gl-matrix';

/** TFruitsBoatParams */
const FRUITS_BOAT_PARAMS = { ...SPINE_PARAMS, mSLMoveSpeed: ['f', 4], mSLRotSpeed: ['f', 0.1], mSLBckMoveSpeed: ['f', 0.2] } satisfies PSchema;

const MODELS = ['ShipDolpic', 'ShipDolpic2', 'ShipDolpic3', 'ShipDolpic4'];
const FOLDERS = ['/scene/fruitsboat', '/scene/fruitsboatb', '/scene/fruitsboatc', '/scene/fruitsboatd'];
/** init's setAttackRadius / setAttackHeight per type */
const ATTACK = [[850, 600], [750, 480], [1000, 300], [760, 270]];

const toMtx = (m: mat4): Mtx => { const r = mtx(); r[0] = m[0]; r[1] = m[4]; r[2] = m[8]; r[3] = m[12]; r[4] = m[1]; r[5] = m[5]; r[6] = m[9]; r[7] = m[13]; r[8] = m[2]; r[9] = m[6]; r[10] = m[10]; r[11] = m[14]; return r; };
/** (the fake polarXZ inline: (r sin t, 0, r cos t)) */
const polarXZ = (t: number, r: number) => { const c = fr(r * MsCos(t)), s = fr(r * MsSin(t)); return new V3(s, 0, c); };

export class FruitsBoatManager extends EnemyManager {
    constructor(w: World, public mBoatType: number, name = 'フルーツの船マネージャー') { super(w, name); }
    load(s: Stream) {
        this.saveParams = readParams('/enemy/fruitsBoat.prm', this.world.files, FRUITS_BOAT_PARAMS);
        super.load(s);
    }
    createModelData() { this.createModelDataArray([(MODELS[this.mBoatType] ?? MODELS[3]) + '.bmd']); }
    createEnemyInstance() { return null; }
}

/** One joint's raw BCK transform (J3DAnmTransform::getTransform): translation, rotation (s16 units), scale. */
interface TransformInfo { t: V3; r: V3; s: V3; }

export class FruitsBoat extends SpineEnemy {
    unk150 = 0;
    mShadowRadiusX = 800; mShadowRadiusZ = 800;
    /** mBckTrack / mBckTrackCtrl: the BCK it follows without a graph, and its frame */
    mBckTrack: any = null;
    mBckTrackCtrl: FrameCtrl | null = null;
    mRockAxis = new V3(1, 0, 0); mRockAngle = 0; mRockSpeed = 0;
    declare mapCollision: MoveCollision | null;
    constructor(w: World, name = 'フルーツの船') {
        super(w, name);
        this.onLiveFlag(LF.UNK10);
    }
    get P(): any { return this.getSaveParam(); }
    getBoatType() { return (this.manager as FruitsBoatManager).mBoatType; }
    /** setBckTrack: the manager folder's BCK of that name (0), or none (-1) */
    setBckTrack(name: string) {
        const data = this.manager!.getMActorAnmData();
        const i = data.anms[ANM_BCK].findIndex((a) => a.name === name);
        if (i < 0) return -1;
        const a = data.anms[ANM_BCK][i];
        this.mBckTrack = parseBCK(this.world.files.scene(data.folder + '/' + a.name + '.bck'));
        const fc = new FrameCtrl();
        // (J3DFrameCtrl: init(frameMax), the BCK's loop mode, rate mSLBckMoveSpeed * SMSGetAnmFrameRate())
        fc.init(a.frameMax); fc.attr = a.attr;
        const rate = this.P.mSLBckMoveSpeed;
        fc.rate = fr(rate * ANM_FRAME_RATE);
        this.mBckTrackCtrl = fc;
        return 0;
    }
    /** setJumpReaction: the sail's bounce */
    setJumpReaction() {
        const t = this.getBoatType();
        if (t < 0 || t > 2) return;
        const name = ['shipdolpic', 'shipdolpic2', 'shipdolpic3'][t];
        const a = this.mactor!;
        if (!a.checkCurAnm(name, ANM_BCK) || a.curAnmEndsNext(ANM_BCK)) a.setBck(name);
    }
    private transform(j: number): TransformInfo {
        const e = this.mBckTrack && this.mBckTrack.jointAnimationEntries[j];
        const f = this.mBckTrackCtrl!.frame;
        if (!e) return { t: new V3(), r: new V3(), s: new V3(1, 1, 1) };
        const S = (tr: any) => sampleAnimationData(tr, f);
        // (noclip's rotations are radians, s16 * pi / 0x7FFF: back to the game's s16 units)
        const deg = (rad: number) => Math.round(rad / Math.PI * 0x7FFF);
        return {
            t: new V3(S(e.translationX), S(e.translationY), S(e.translationZ)),
            r: new V3(deg(S(e.rotationX)), deg(S(e.rotationY)), deg(S(e.rotationZ))),
            s: new V3(S(e.scaleX), S(e.scaleY), S(e.scaleZ)),
        };
    }
    /** traceBckTrack */
    traceBckTrack() {
        this.mBckTrackCtrl!.update();
        const i0 = this.transform(0), i1 = this.transform(1);
        this.pos.set(fr(i0.t.x + i1.t.x), fr(i0.t.y + i1.t.y), fr(i0.t.z + i1.t.z));
        const k = 360 / 65536;
        this.rot.set(fr(k * (i0.r.x + i1.r.x)), fr(k * (i0.r.y + i1.r.y)), fr(k * (i0.r.z + i1.r.z)));
        this.scale.set(fr(i0.s.x * i1.s.x), fr(i0.s.y * i1.s.y), fr(i0.s.z * i1.s.z));
    }
    /** getRootJointMtx: getAnmMtx(0) */
    getRootJointMtx(): Mtx {
        const m = this.mactor ? this.mactor.anmMtx(0, this.baseTR, this.scale) : null;
        return m ? toMtx(m) : this.baseTR.slice();
    }
    /** rowToCurPathNode (a spline rail's traceSpline isn't ported) */
    rowToCurPathNode(speed: number) {
        this.walkToCurPathNode(speed, this.turnSpeed, 0);
        this.world.sound(SE.OBJ_PONPONSEN, this.pos);
    }
    load(s: Stream) {
        Actor.prototype.load.call(this, s);
        const mgr = s.str();
        const graphName = s.str();
        const graph = this.world.graphByName(graphName);
        this.tracer.init(graph);
        this.groundPlane = this.world.illegal;
        this.init(this.world.search(mgr) as LiveManager | null);
        if ((!graph || graph.isDummy()) && this.setBckTrack(graphName) === 0) this.spine!.initWith(FruitsBoatNerves.bckTrace);
    }
    init(m: LiveManager | null) {
        if (!m) return;
        this.manager = m;
        m.manageActor(this);
        this.initHitActor(AT.FRUITS_BOAT, 1, 0xC0000000 | 0, 0, 0, 0, 0);
        this.offHitFilter(HF.NO_COLLISION);
        this.tracer.reset();
        this.goToShortestNextGraphNode();
        // TODO: on a spline rail it starts on the rail's current point (moveToShortestNext): not ported
        let t = this.getBoatType();
        if (t < 0 || t > 3) t = 3;
        this.mapCollision = new MoveCollision(this.world, (FOLDERS[t] + '/' + MODELS[t] + '.col').toLowerCase(), this);
        this.mactor = this.createMActorByName(MODELS[t] + '.bmd');
        this.attackRadius = ATTACK[t][0]; this.calcEntryRadius();
        this.attackHeight = ATTACK[t][1]; this.calcEntryRadius();
        this.mapCollision.moveSRT(this.pos, this.rot, this.scale);   // setUpActiveCollisionTRS
        this.spine!.initWith(FruitsBoatNerves.graphWander);
        const g = this.tracer.graph;
        if (!g) this.onLiveFlag(LF.UNK10000);
        else if (this.tracer.cur >= 0 && g.checkFlag(this.tracer.cur, 0x80)) this.onLiveFlag(LF.UNK10000);
        else this.offLiveFlag(LF.UNK10000);
        this.marchSpeed = this.P.mSLMoveSpeed;
        this.turnSpeed = this.P.mSLRotSpeed;
        this.offLiveFlag(LF.CLIPPED_OUT);
        this.onLiveFlag(LF.UNK20);
        this.offLiveFlag(LF.ENABLE_CLIPPING);
        this.calcRootMatrix();
    }
    receiveMessage(_sender: HitActor, _msg: number) { return false; }
    /** setGroundCollision: only while it can be stood on */
    setGroundCollision() {
        const w = this.world, d = V3.sub(this.pos, w.mario.pos);
        const y = (w.mario as any).yoshi;
        const yp: V3 | null = y && typeof y.isHatched === 'function' && y.isHatched() ? (y.pos ?? y.mPosition ?? null) : null;
        if (this.collisions.length !== 0 || d.length() < 1000
            || (yp && fr(this.pos.x - 1000) < yp.x && fr(this.pos.x + 1000) > yp.x && fr(this.pos.z - 1000) < yp.z && fr(this.pos.z + 1000) > yp.z)) {
            const m = this.mactor ? this.mactor.anmMtx(0, this.baseTR, this.scale) : null;
            if (m && this.mapCollision) this.mapCollision.moveMat4(m);
            else if (this.mapCollision) this.mapCollision.moveSRT(this.pos, this.rot, this.scale);
        }
    }
    calcRootMatrix() {
        const m = this.baseTR;
        MsMtxSetRotRPH(m, this.rot.x, this.rot.y, this.rot.z);
        const rock = mtx();
        MTXRotAxisRad(rock, this.mRockAxis, fr(0.017453292 * this.mRockAngle));
        MTXConcat(rock, m, m);
        m[3] = fr(m[3] + this.pos.x); m[7] = fr(m[7] + this.pos.y); m[11] = fr(m[11] + this.pos.z);   // MTXTransApply
        // (setBaseScale(mScaling): the viewer draws with this.scale)
    }
    moveObject() {
        const w = this.world, wave = mapObjWave(w);
        // pitch along the waves under its bow and stern
        const off = polarXZ(this.rot.y, 300);
        const bow = this.pos.clone().add(off).fround(), stern = this.pos.clone().sub(off).fround();
        bow.y = wave ? wave.getWaveHeight(bow.x, bow.z) : 0;
        stern.y = wave ? wave.getWaveHeight(stern.x, stern.z) : 0;
        const r = MsGetRotFromZaxis(V3.sub(bow, stern).fround());
        r.x = fr(r.x * 0.5);
        let step = MsAngleDiff(r.x, this.rot.x);
        step = step >= 0 ? Math.min(step, 1) : Math.max(step, -1);
        this.rot.x = fr(this.rot.x + step);
        // rock sideways when Mario lands on it
        const plane = marioGroundPlane(w);
        const on = () => !!plane && plane.actor === this && marioTouchGround4cm(w);
        const up = new V3(0, 1, 0);
        if (!this.checkLiveFlag(LF.UNK20000)) {
            if (on()) {
                const dir = V3.sub(w.mario.pos, this.pos).fround(); dir.y = 0;
                const dist = fr(dir.length());
                if (dist !== 0) {
                    dir.normalize().fround();
                    this.mRockAxis.cross(up, dir).fround();
                    this.mRockAxis.normalize().fround();
                    this.mRockSpeed = fr(this.mRockSpeed + fr(0.0003 * dist));
                }
                this.onLiveFlag(LF.UNK20000);
                this.offLiveFlag(LF.UNK10000);
                if (isBounceOnLanding(plane!.bgType)) { this.setJumpReaction(); this.offLiveFlag(LF.UNK20000); }
            }
        } else if (!on()) this.offLiveFlag(LF.UNK20000);
        // the rocking axis turns towards Mario while he stands on it
        if (this.checkLiveFlag(LF.UNK20000)) {
            const dir = V3.sub(w.mario.pos, this.pos).fround(); dir.y = 0;
            if (dir.length() !== 0) {
                dir.normalize().fround();
                const axis = new V3().cross(up, dir).fround();
                axis.normalize().fround();
                const A = this.mRockAxis;
                A.x = fr(A.x + fr(0.1 * fr(axis.x - A.x)));
                A.y = fr(A.y + fr(0.1 * fr(axis.y - A.y)));
                A.z = fr(A.z + fr(0.1 * fr(axis.z - A.z)));
            }
        }
        this.mRockSpeed = fr(this.mRockSpeed + fr(0.01 * -MsSin(this.mRockAngle)));
        this.mRockAngle = fr(this.mRockAngle + this.mRockSpeed);
        if (this.mRockAngle < -10 || this.mRockAngle > 10) this.mRockSpeed = -this.mRockSpeed;
        this.mRockSpeed = fr(this.mRockSpeed * 0.99);
        super.moveObject();
    }
}

/** TBGCheckData::isBounceOnLanding (BG_TYPE_BOUNCE_ON_LANDING and its no-camera-clip form) */
function isBounceOnLanding(t: number) { return t === 0x7 || t === 0x8007; }

type S = Spine<FruitsBoat>;
export const FruitsBoatNerves: Record<string, any> = {};
FruitsBoatNerves.graphWander = nerve<FruitsBoat>('TNerveFruitsBoatGraphWander', (spine: S) => {
    const self = spine.body, g = self.tracer.graph;
    if (!g || g.isDummy()) return false;
    if (self.isReachedToGoal()) {
        const i = self.tracer.cur;
        if (i >= 0 && g.checkFlag(i, 0x100)) self.onLiveFlag(LF.UNK10000);
        if (i >= 0 && g.checkFlag(i, 0x400)) self.unk150 ^= 1;
        self.goToDirectedNextGraphNode(polarXZ(self.rot.y, 1));
        if (!self.checkLiveFlag(LF.UNK10000)) self.rowToCurPathNode(self.marchSpeed);
        spine.pushAfterCurrent(FruitsBoatNerves.graphWander);
        return true;
    }
    if (self.checkLiveFlag(LF.UNK10000)) return false;
    self.rowToCurPathNode(self.marchSpeed);
    return false;
});
FruitsBoatNerves.bckTrace = nerve<FruitsBoat>('TNerveFruitsBoatBckTrace', (spine: S) => {
    spine.body.traceBckTrack();
    return false;
});

register('FruitsBoat', (w, n) => new FruitsBoat(w, n));
register('FruitsBoatG', (w, n) => new FruitsBoat(w, n));
register('FruitsBoatP', (w, n) => new FruitsBoat(w, n));
register('FruitsBoatY', (w, n) => new FruitsBoat(w, n));
register('FruitsBoatManager', (w, n) => new FruitsBoatManager(w, 0, n));
register('FruitsBoatGManager', (w, n) => new FruitsBoatManager(w, 1, n));
register('FruitsBoatPManager', (w, n) => new FruitsBoatManager(w, 2, n));
register('FruitsBoatYManager', (w, n) => new FruitsBoatManager(w, 3, n));
