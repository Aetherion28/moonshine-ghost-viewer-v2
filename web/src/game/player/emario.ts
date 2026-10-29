// Enemy/emario.cpp and Enemy/enemyMario.cpp: Shadow Mario (マリオモドキ). TEMario is the stage's
// actor (a TSpineEnemy on the conductor's own list): its hit area, the messages it takes, the model
// you see. TEnemyMario is a whole TMario (player/*.ts) with its own pad: an AI (consider) that,
// for the Bianco Hills chase, plays the recorded pads of map/map/pad (tutorial??.pad, TMarioInputReplay)
// from graph node to graph node, linked by linkdata.bin, and falls down when he's sprayed enough.

import { fmadd as fmaddF, sqrtf } from './fmath.js';
import { fr, s16, V3, matan, IConverge, MsRandF, rand, mtx, Mtx, MsMtxSetRotRPH, JMASSin, JMASCos } from '../math.js';
import {
    World, Stream, SpineEnemy, EnemyManager, LiveManager, LiveActor, HitActor, MActor, AnmData, ObjChara, Files, Params,
    LF, HF, HC, MSG, CUE_MOVE, CUE_CALC_ANIM, ANM_BCK, ANM_BTK, ANM_FRAME_RATE, readParams, SPINE_PARAMS,
} from '../engine.js';
import { register } from '../scene.js';
import { MSF } from '../msflags.js';
import { AT } from '../actortypes.js';
import { TMarioSim, j3dTRMtx } from './tmario.js';
import { S, A, MF, ControllerWork } from './base.js';
import type { mat4 } from 'gl-matrix';

// ---------------------------------------------------------------- Player/MarioRecord.cpp
/** TRecordValueManager<T>: run-length values (a duration table and a value table). */
class RecordValue {
    private dur = 0; private val = 0; private curDur = 0; private curVal = 0; private elapsed = 0;
    constructor(private v: DataView | null, durOff: number, valOff: number, private size: number, private read: (v: DataView, o: number) => number) {
        this.dur = durOff; this.val = valOff;
    }
    reset() { this.curDur = this.dur; this.curVal = this.val; this.elapsed = 0; }
    get(): number {
        const v = this.v!;
        const out = this.read(v, this.curVal);
        this.elapsed++;
        if (this.elapsed >= v.getUint32(this.curDur)) { this.curDur += 4; this.curVal += this.size; this.elapsed = 0; }
        return out;
    }
}

/** TMarioInputReplay */
export class MarioInputReplay {
    mCanPlay = 0; mPrevBtnMask = 0; mReplayPos = 0; mReplayLength = 0;
    mMag: RecordValue; mYaw: RecordValue; mBtnMask: RecordValue; mUnk64: RecordValue; mUnk80: RecordValue;
    constructor(data: Uint8Array | null) {
        const v = data ? new DataView(data.buffer, data.byteOffset, data.byteLength) : null;
        let o = 0x10;
        this.mReplayLength = v ? v.getInt32(o) : 0;
        const next = () => { o += 4; return v ? v.getInt32(o) : 0; };
        const rec = (size: number, read: (v: DataView, o: number) => number) => { const d = next(), x = next(); const r = new RecordValue(v, d, x, size, read); r.reset(); return r; };
        this.mMag = rec(4, (v, p) => v.getFloat32(p));
        this.mYaw = rec(2, (v, p) => v.getInt16(p));
        this.mBtnMask = rec(2, (v, p) => v.getUint16(p));
        this.mUnk64 = rec(1, (v, p) => v.getUint8(p));
        this.mUnk80 = rec(1, (v, p) => v.getUint8(p));
    }
    start() { this.mCanPlay = 1; }
    canPlay() { return this.mCanPlay === 1; }
    reset() {
        this.mCanPlay = 0; this.mPrevBtnMask = 0; this.mReplayPos = 0;
        this.mMag.reset(); this.mYaw.reset(); this.mBtnMask.reset(); this.mUnk64.reset(); this.mUnk80.reset();
    }
    /** play(&mag, &yaw, &input, &frameInput, &analogL, &analogR) */
    play(m: EnemyMario) {
        if (this.mCanPlay === 1) {
            if (this.mReplayPos < (this.mReplayLength >>> 0)) {
                m.mIntendedMag = this.mMag.get();
                m.mIntendedYaw = this.mYaw.get();
                const btn = this.mBtnMask.get();
                const just = btn & (btn ^ this.mPrevBtnMask);
                this.mPrevBtnMask = btn;
                const c = m.unk108;
                c.mInput = ((c.mInput & 0xFFFF0000) | btn) >>> 0;
                c.mFrameInput = (just | (c.mFrameInput & 0xFFFF0000)) >>> 0;
                c.mAnalogLU8 = this.mUnk64.get();
                c.mAnalogRU8 = this.mUnk80.get();
                this.mReplayPos++;
                return true;
            }
            this.mCanPlay = 0;
        }
        return false;
    }
}

// ---------------------------------------------------------------- TEnemyMario
export const EM_FLAG = { GOAL_REACHED: 0x1, DISP_PENCIL: 0x2, FORCE_WATER_HIT: 0x10, ENFORCE_TAKE: 0x20, DISP_HP_METER: 0x80 };
export const EM = {
    WAITING: 0x0, RUN_AWAY: 0x1, JUMPING: 0x2, GET_CLOSER: 0x3, TURNING: 0x4, WALK_AROUND: 0x5, WALK_GRAPH: 0x6, HIDE: 0x7, APPEAR: 0x8,
    DISAPPEAR: 0x9, DISAPPEAR_TO_GATE: 0xA, REPLAY: 0xB, REPLAY_WAITING: 0xC, REPLAY_JUMP_TO_NEAREST_NODE: 0xD, PRE_DOWN_ANIMATION: 0xE,
    DOWN_ANIMATION: 0xF, RUN_AWAY_TO_NEAREST_NODE: 0x10, REPLAY_RUN_AWAY: 0x11, UNK12: 0x12, UNK13: 0x13, WAITING_TO_INVITE_MARIO: 0x14,
    REPLAY_RUN_AWAY_TO_GATE: 0x15, WAITING_MARIO: 0x16, GATE_DRAWING: 0x17, UNK18: 0x18, REPLAY_TO_GOAL: 0x19, UNK1A: 0x1A, GET_PAD: 0x1B,
};

/** TEnemyMario::TSettingParams (map/map/pad/Setting.prm) */
export const SETTING_PARAMS = {
    mSearchDist: ['f', 1000], mSearchHeight: ['f', 300], mWaterCtMax: ['s16', 64], mStopFlag: ['u8', 1], mStampFlag: ['u8', 1],
    mRandomFlag: ['u8', 1], mCarryFlag: ['u8', 0], mInvincibleFlag: ['u8', 0], mRandomPow: ['f', 1], mDownTime: ['s16', 1200],
    mPolluteFlag: ['u8', 0], mPolluteSize: ['f', 160],
} as const;
type Setting = { [K in keyof typeof SETTING_PARAMS]: number };

/** A path like "/../map/pad/Setting.prm" (TParams resolves it against the scene's map/params) */
function sceneParams(files: Files, path: string): Setting {
    const parts: string[] = [];
    for (const p of ('map/params/' + path.replace(/^\//, '')).toLowerCase().split('/')) { if (p === '..') parts.pop(); else if (p && p !== '.') parts.push(p); }
    const full = parts.join('/');
    const b = files.scene(full);
    const f: Files = { scene: (q: string) => (q === 'map/params/__setting' ? b : null), params: () => null, folder: () => [] } as any;
    return new Params('/__setting', f).read(SETTING_PARAMS as any) as any;
}

interface ReplayLink { node: number; replay: number; }

/** A model drawn along with him (his brush, the Bowser stamp), for the viewer. */
class EMarioPart extends LiveActor {
    show = false;
    constructor(w: World, name: string, model: string, data: AnmData) { super(w, name); this.mactor = new MActor(model, data); }
    drawn() { return this.show; }
    perform(_cue: number) { }
}

/**
 * MSF_SHADOW_MARIO_EVENT (TFlagManager): 0 he's gone, 1 the pad/ replays, 2 pad2/, 3 pad3/. Read
 * from the world's flags (setupStage sets it as setupObjects does); value: the fallback without them.
 */
export const shadowMarioEvent = { value: 1 };

export class EnemyMario extends TMarioSim {
    mEMario: TEMario;
    mEMFlags = 0; mEMDoing = EM.UNK1A; mWaterCounter = 0; mAngleToMario = 0; mTargetAngle = 0; mDistanceToMario = 0;
    mEMDoingTimer = 0; mReplayIndex = 0; mTrembleStrength = 2.5; mPadIndex = 0; mAttackRange = 120;
    mWaterEffectTimer = 0; mWaterEffectTimerMax = 120; mTrampleCount = 3; mWaterHitTimer = 0; mReplayJumpSpeed = 15;
    mRunAwayNodeIndex = 0; mRunAwaySpeed = 10;
    mDisappearPosition = new V3(); mReferencePosition = new V3();
    mSettingParams!: Setting;
    mReplayLinks: ReplayLink[][] = [];
    mInputReplays: (MarioInputReplay | null)[] | null = null;
    mRunAwayInputReplays: (MarioInputReplay | null)[] | null = null;
    mGateReplay: MarioInputReplay | null = null;
    /** mSpecialModel (Il Piantissimo's): null for Shadow Mario */
    mSpecialModel: string | null = null;
    mBrushModel: EMarioPart | null = null;
    mStampActor: EMarioPart | null = null;
    mBrushScaleupDuringDrawing = 3;
    /** the stamp's base matrix this tick (isDispStamp) */
    stampTR: Mtx = mtx();

    constructor(w: World, em: TEMario) { super(w, 'マリオ'); this.mEMario = em; }
    get graph() { return this.mEMario.tracer.graph || this.world.nullGraph; }
    marioPos() { return this.world.mario.pos; }
    padFrameL() { return false; }
    checkEMFlag(f: number) { return (this.mEMFlags & f) !== 0; }
    onEMFlag(f: number) { this.mEMFlags |= f; }
    offEMFlag(f: number) { this.mEMFlags &= ~f; }
    canControl() { return this.mEMDoing === EM.REPLAY || this.mEMDoing === EM.REPLAY_WAITING || this.mEMDoing === EM.REPLAY_RUN_AWAY; }
    isDispStamp() { return this.mEMDoing === EM.UNK13 && this.mSettingParams.mStampFlag === 1; }
    isReachedToGate() { return this.mEMDoing === EM.UNK18; }
    isDownWaitingToTalk() { return this.mEMDoing === EM.DOWN_ANIMATION; }
    sleepingEffectKill() { }
    emEffect(kind: string, p: V3) { this.world.effect('emario:' + kind, p); }

    initValues() {
        this.mHealth = this.mDeParams.mHPMax;
        this.mDirty = 0; this.mOilBrake = 1; this.mDirtyTimer = 0; this.unk140 = 0;
        this.unk108 = new ControllerWork();
        this.unk10C = 0; this.unk110 = 0;
        this.mPlayerType = 1; // PLAYER_TYPE_SHADOW_MARIO
        this.unk530 = new Int16Array(60); this.unk534 = 0; this.unk536 = 0; this.unk538 = 0; this.unk53A = 0; this.unk53B = 0;
        this.initModel();
        this.unk414.set(0, 0, 1);
    }
    initModel() {
        this.initJointIds();
        this.mModel.changeAnm(0, 0x3e);
        this.mModel.changeAnm(1, 0x41);
        this.mModel.fc[1].rate = 0;
        this.setAnimation(A.WAIT, 1);
        j3dTRMtx(this.mModel.baseTR, this.mFaceAngle.x, this.mModelFaceAngle, this.mFaceAngle.z, this.pos.x, this.pos.y, this.pos.z);
        this.mModel.update();
        this.mModel.calc();
    }
    canJumpToNode() { const i = this.graph.findNearestNodeIndex(this.pos, -1); return i >= 0 && this.graph.checkFlag(i, 2); }

    initEnemyValues() {
        const names = ['マリオモドキ_0', 'マリオモドキ_1', 'マリオモドキ_2', 'マリオモドキ_3', 'モンテマン'];
        this.mEMFlags = EM_FLAG.DISP_PENCIL; this.mEMDoing = EM.UNK1A; this.mWaterCounter = 0;
        this.mAngleToMario = 0; this.mTargetAngle = 0; this.mDistanceToMario = 0; this.mEMDoingTimer = 0; this.mReplayIndex = 0;
        this.mTrembleStrength = 2.5; this.mPadIndex = 0; this.mAttackRange = 120; this.mWaterEffectTimer = 0; this.mWaterEffectTimerMax = 120;
        this.mTrampleCount = 3; this.mWaterHitTimer = 0; this.mReplayJumpSpeed = 15; this.mRunAwayNodeIndex = 0; this.mRunAwaySpeed = 10;
        this.onHitFilter(HF.NO_COLLISION); this.mEMario.onHitFilter(HF.NO_COLLISION);
        let modelIndex = 6;
        for (let i = 0; i < 5; i++) if (names[i] === this.mEMario.name) { modelIndex = i; break; }
        const W = this.world;
        if (modelIndex === 4) { this.mPlayerType = 2; this.mSpecialModel = 'map/map/pad/monteman_model.bmd'; }
        else {
            this.mPlayerType = 1;
            const kd = new AnmData('kagemario', W.files);
            this.mBrushModel = new EMarioPart(W, 'kagemario_brush', 'kagemario/kagemario_brush.bmd', kd);
            this.mStampActor = new EMarioPart(W, 'stamp_koopa_sign', 'kagemario/stamp_koopa_sign/stamp_koopa_sign_model1.bmd', new AnmData('kagemario/stamp_koopa_sign', W.files));
            W.extras.push(this.mBrushModel, this.mStampActor);
        }
        this.mDisappearPosition.set(0, 0, 0);
        const ev = W.flags ? W.flags.getFlag(MSF.SHADOW_MARIO_EVENT) : shadowMarioEvent.value;
        if (ev === 0) { this.onHitFilter(HF.NO_COLLISION); this.mEMario.onHitFilter(HF.NO_COLLISION); }
        else { this.offHitFilter(HF.NO_COLLISION); this.mEMario.offHitFilter(HF.NO_COLLISION); }
        if (ev === 2) { this.mPadIndex = 1; this.mSettingParams = sceneParams(W.files, '/../map/pad2/Setting.prm'); }
        else if (ev === 3) { this.mPadIndex = 2; this.mSettingParams = sceneParams(W.files, '/../map/pad3/Setting.prm'); }
        else { this.mPadIndex = 0; this.mSettingParams = sceneParams(W.files, '/../map/pad/Setting.prm'); }
        this.mWaterCounter = this.mSettingParams.mWaterCtMax;
        const pad = this.mPadIndex === 0 ? 'map/map/pad' : `map/map/pad${this.mPadIndex}`;
        let replayNames: string[] = [];
        const ld = W.files.scene(pad + '/linkdata.bin');
        if (ld) {
            const s = new Stream(ld);
            s.skip(6); s.str(); s.skip(2); s.str();
            const nodeCount = s.u32();
            for (let node = 0; node < nodeCount; node++) {
                s.skip(6); s.str(); s.skip(2); s.str();
                const links: ReplayLink[] = [];
                for (let k = 0; k < 3; k++) {
                    s.skip(2);
                    const letter = s.u8();
                    if (letter === 0x2A) links.push({ node: 0xFF, replay: 0xFF });
                    else { replayNames.push(String.fromCharCode(node + 0x41, letter)); links.push({ node: (letter - 0x41) & 0xFF, replay: replayNames.length - 1 }); }
                }
                this.mReplayLinks.push(links);
            }
        }
        if (this.mPadIndex !== 0) this.mEMario.tracer.init(W.graphByName(`mariomodoki${this.mPadIndex}`));
        this.mTrembleStrength = 2.5;
        if (this.mPlayerType === 2) replayNames = ['AB0', 'AB1', 'AB2'];
        if (replayNames.length > 0) this.mInputReplays = replayNames.map((n) => new MarioInputReplay(W.files.scene(`${pad}/tutorial${n}.pad`)));
        this.mEMFlags = EM_FLAG.DISP_PENCIL;
        switch (this.mEMario.mInitialState) {
            case 0: this.mEMDoing = EM.REPLAY_WAITING; break;
            case 1: this.mEMDoing = EM.REPLAY; break;
            case 2: this.mEMDoing = EM.UNK12; break;
            case 3: this.mEMDoing = EM.WAITING_MARIO; break;
            default: this.mEMDoing = EM.DISAPPEAR; break;
        }
        if (ev === 0) this.mEMDoing = EM.DISAPPEAR;
        this.mReplayIndex = ev === 2 ? this.mEMario.unk15C : ev === 3 ? this.mEMario.unk160 : this.mEMario.unk158;
        if (this.graph.count > this.mReplayIndex) this.pos.set(this.graph.point(this.mReplayIndex));
        this.mEMario.pos.set(this.pos);
        if (this.mInputReplays) { this.mInputReplays[this.mReplayIndex]!.reset(); this.mInputReplays[this.mReplayIndex]!.start(); }
        if (W.map === 1 && W.stage === 1) {
            // (Delfino Plaza's chase: the run-away replays and the gate one)
            const rn = [null, 'BH', 'CH', 'DH', 'EH', 'FH', 'GH', null];
            this.mRunAwayInputReplays = rn.map((n) => (n ? new MarioInputReplay(W.files.scene(`map/map/pad/tutorial${n}.pad`)) : null));
            this.mGateReplay = new MarioInputReplay(W.files.scene('map/map/pad/tutorialhi.pad'));
        }
        this.onUnk114(2);
        this.mStatus = S.WAIT; this.mPrevStatus = S.WAIT;
        this.offFlag(MF.HAS_FLUDD);
    }

    setStickToAngle(angle: number, power: number) {
        this.unk108.mStickHS16 = Math.trunc(fr(fr(JMASSin(angle) * 64) * power));
        this.unk108.mStickVS16 = Math.trunc(fr(fr(-JMASCos(angle) * 64) * power));
    }
    resetReplayStatus() {
        this.mVel.set(0, 0, 0); this.mForwardVel = 0;
        this.resetHistory();
        this.changePlayerStatus(S.WAIT, 0, true);
    }
    resetHistory() { this.unk530.fill(0); this.unk534 = 0; this.unk536 = 0; this.unk538 = 0; this.unk53A = 0; this.unk53B = 0; }
    startMonteReplay(i: number) {
        const n = this.graph.findNearestNodeIndex(this.pos, -1);
        const cur = this.graph.point(n), nx = this.graph.point(n + 1);
        this.pos.set(cur);
        this.mFaceAngle.y = matan(fr(nx.z - cur.z), fr(nx.x - cur.x));
        this.resetReplayStatus();
        this.mReplayIndex = i;
        this.mInputReplays![i]!.reset(); this.mInputReplays![i]!.start();
        this.changeEMDoing(EM.REPLAY_TO_GOAL);
    }
    changeEMDoing(d: number) { this.mEMDoingTimer = 0; this.mEMDoing = d; }
    changeEMJumping() { this.unk108.mInput |= ControllerWork.A; this.changeEMDoing(EM.JUMPING); }
    changeEMWalkGraph() { this.mEMario.tracer.reset(); this.mEMario.goToShortestNextGraphNode(); this.changeEMDoing(EM.WALK_GRAPH); }
    tryTake() {
        if (this.mHeldObject && this.mStatus !== S.TAKE) return true;
        for (const a of this.mEMario.collisions) {
            const t = a.actorType;
            if (t === AT.NPC_PEACH || t === AT.BACK_NOZZLE_ITEM || t === AT.ROCKET_NOZZLE_ITEM || t === AT.EGG_YOSHI) {
                if (t === AT.NPC_PEACH) { (a as LiveActor).onLiveFlag(LF.UNK100000); this.onEMFlag(EM_FLAG.ENFORCE_TAKE); }
                this.unk384 = a;
                this.changePlayerStatus(S.TAKE, 0, false);
            }
        }
        return false;
    }

    // ---------------------------------------------------------------- the free AI (not the chase)
    emWaiting() {
        const d = s16(this.mAngleToMario - this.mFaceAngle.y);
        if (d < -0x1555 || d > 0x1555) this.setStickToAngle(this.mAngleToMario, fr(0.2));
        if (this.mDistanceToMario < 800) this.changeEMDoing(EM.RUN_AWAY);
        if (this.mDistanceToMario > 1500 || rand() < 0x88) this.changeEMWalkGraph();
    }
    emRunAway() {
        if (this.mDistanceToMario < 400) this.changeEMJumping();
        if (this.mDistanceToMario < 1300) {
            this.setStickToAngle(this.mAngleToMario, 1);
            this.unk108.mStickHS16 = -this.unk108.mStickHS16; this.unk108.mStickVS16 = -this.unk108.mStickVS16;
        } else this.mEMDoing = EM.WAITING;
    }
    emJumping() {
        if (this.mStatus & S.FLAG_JUMPING) {
            if (this.mStatus !== S.WALL_SLIDE || this.mStatusTimer >= 10) {
                this.setStickToAngle(this.mFaceAngle.y, 1);
                this.unk108.mInput |= ControllerWork.A;
                if (-1 < this.mVel.y && this.mVel.y < 1 && rand() < 0xFFF) this.unk108.mInput |= ControllerWork.B;
            }
        } else if (this.mStatus === S.HANGING) { if (this.mStatusTimer >= 10) this.unk108.mInput |= ControllerWork.A; }
        else if (this.mStatus & 0x600) {
            if (this.world.pollution) this.world.pollution.stamp(1, this.pos.x, this.pos.y, this.pos.z, 384);
            this.changeEMDoing(EM.WAITING);
        }
    }
    emGetCloser() { if (this.mDistanceToMario > 1500) this.setStickToAngle(this.mAngleToMario, 1); else this.changeEMDoing(EM.WAITING); }
    emWalkAround() {
        if (this.mDistanceToMario < 1500) { this.changeEMDoing(EM.WAITING); return; }
        if (rand() < 10) this.changeEMDoing(EM.GET_CLOSER);
        if (rand() < 100) { this.changeEMJumping(); return; }
        if (rand() < 100) { this.mTargetAngle = s16(rand()); this.changeEMDoing(EM.TURNING); return; }
        if (rand() < 50) { this.changeEMWalkGraph(); return; }
        if (rand() < 50) {
            if (this.world.pollution) this.world.pollution.stamp(1, this.pos.x, this.pos.y, this.pos.z, 384);
            this.changeEMDoing(EM.HIDE);
        }
        if (this.mWallPlane) { this.changeEMJumping(); return; }
        this.setStickToAngle(this.mFaceAngle.y, 0.5);
    }
    emWalkGraph() {
        const E = this.mEMario;
        if (V3.sub(E.goal104.point(), E.pos).length() < 100) {
            if (this.mDistanceToMario > 3000) E.goToRandomNextGraphNode(); else E.goToRandomEscapeGraphNode();
        }
        const g = E.goal.point();
        this.setStickToAngle(matan(fr(g.z - this.pos.z), fr(g.x - this.pos.x)) & 0xFFFF, 1);
        ++this.mEMDoingTimer;
        // (every 100: gpConductor->makeEnemyAppear(pos, "ハムクリマネージャー", 1, 0))
        if (this.mEMDoingTimer % 100 === 0) this.world.conductor.makeOneEnemyAppear(this.pos.clone(), 'ハムクリマネージャー', 1);
    }
    emTurning() {
        const d = s16(this.mTargetAngle - this.mFaceAngle.y);
        if (rand() < 100) this.changeEMJumping();
        else if (d < -0x1555 || d > 0x1555) this.setStickToAngle(this.mTargetAngle, fr(0.2));
        else this.changeEMDoing(EM.WAITING);
    }
    emHide() {
        this.onHitFilter(HF.NO_COLLISION); this.mEMario.onHitFilter(HF.NO_COLLISION);
        ++this.mEMDoingTimer;
        const P = this.world.pollution;
        if (!(P && P.isPolluted(this.pos.x, this.pos.y, this.pos.z)) || this.mEMDoingTimer > 7200) {
            this.mEMDoingTimer = 0; this.mInvincibilityFrames = 120; this.changeEMDoing(EM.APPEAR);
        }
    }
    emAppear() {
        if (this.mInvincibilityFrames === 0) { this.changeEMDoing(EM.WAITING); this.offHitFilter(HF.NO_COLLISION); this.mEMario.offHitFilter(HF.NO_COLLISION); }
    }
    startDisappear(d: number) {
        this.mDisappearPosition.set(this.pos);
        this.emEffect('kgm_change', this.mDisappearPosition);
        this.changeEMDoing(d);
    }
    emDisappear() {
        this.onHitFilter(HF.NO_COLLISION); this.mEMario.onHitFilter(HF.NO_COLLISION);
        this.offEMFlag(EM_FLAG.DISP_PENCIL);
        this.offUnk114(2);
        this.changePlayerStatus(S.NOMOTION, 0, false);
    }
    emDisappearToGate() {
        if (this.mEMDoingTimer >= 8) this.offEMFlag(EM_FLAG.DISP_PENCIL); else this.onEMFlag(EM_FLAG.DISP_PENCIL);
        this.onHitFilter(HF.NO_COLLISION); this.mEMario.onHitFilter(HF.NO_COLLISION);
        if (this.mEMDoingTimer === 0) { this.mDisappearPosition.set(this.mCenterPos); this.emEffect('kgm_change', this.mDisappearPosition); }
        if (this.mEMDoingTimer > 100) {
            this.mDisappearPosition.y = fr(this.mDisappearPosition.y + fr(fr(0.025) * this.mEMDoingTimer));
            this.mDisappearPosition.z = fr(this.mDisappearPosition.z - fr(fr(0.03) * this.mEMDoingTimer));
        }
        ++this.mEMDoingTimer;
    }

    // ---------------------------------------------------------------- the chase
    emReplay() {
        const R = this.mInputReplays![this.mReplayIndex]!;
        R.play(this);
        const P = this.world.pollution;
        if (this.mSettingParams.mPolluteFlag && P) P.stamp(1, this.pos.x, this.pos.y, this.pos.z, this.mSettingParams.mPolluteSize);
        if (R.canPlay()) return;
        if (this.mSettingParams.mCarryFlag === 1 && !this.mHeldObject) { this.changeEMDoing(EM.UNK12); return; }
        if (this.mStampActor && this.mSettingParams.mStampFlag === 1) {
            this.mStampActor.mactor!.setBck('stamp_koopa_sign_draw1');
            this.mStampActor.mactor!.setFrameRate(ANM_FRAME_RATE, ANM_BCK);
            this.changeEMDoing(EM.UNK13);
            this.world.events.push({ t: this.world.tickCount, kind: 'emario:stamp', data: { pos: this.pos.clone() } });
            return;
        }
        const n = this.graph.findNearestNodeIndex(this.pos, -1);
        if (n >= 0 && this.graph.checkFlag(n, 0x40)) { this.changeEMDoing(EM.WAITING_MARIO); return; }
        if (this.mSettingParams.mStopFlag === 1) { this.changeEMDoing(EM.REPLAY_WAITING); return; }
        this.emReplayWaitingToReplayJumpToNearestNode();
    }
    emReplayWaitingToReplayJumpToNearestNode() {
        if (this.canJumpToNode()) {
            this.mFaceAngle.y = this.mAngleToMario;
            this.unk108.mFrameInput |= ControllerWork.A;
            this.unk108.mInput |= ControllerWork.A;
        }
        this.changeEMDoing(EM.REPLAY_JUMP_TO_NEAREST_NODE);
    }
    emReplayWaiting() {
        const m = this.marioPos();
        const dist = fr(V3.sub(this.pos, m).length());
        if (dist < this.mSettingParams.mSearchDist && m.y < fr(this.pos.y + this.mSettingParams.mSearchHeight)) this.emReplayWaitingToReplayJumpToNearestNode();
    }
    emReplayJumpToNearestNode() {
        if (this.canJumpToNode()) {
            this.unk108.mFrameInput |= ControllerWork.A;
            this.unk108.mInput |= ControllerWork.A;
            if (this.mVel.y > this.mReplayJumpSpeed) this.mVel.y = this.mReplayJumpSpeed;
        }
        ++this.mEMDoingTimer;
        const G = this.graph;
        const ni = G.findNearestNodeIndex(this.pos, -1);
        const cur = G.point(ni);
        this.pos.x = fmaddF(fr(0.05), fr(cur.x - this.pos.x), this.pos.x);
        this.pos.z = fmaddF(fr(0.05), fr(cur.z - this.pos.z), this.pos.z);
        this.pos.y = fmaddF(fr(0.05), fr(cur.y - this.pos.y), this.pos.y);
        if (this.mStatus !== S.WAIT) if (this.canJumpToNode()) return;
        this.pos.set(cur);
        this.resetReplayStatus();
        this.pos.set(cur);
        const m = this.marioPos();
        const md = new V3(fr(m.x - cur.x), fr(m.y - cur.y), fr(m.z - cur.z)).normalize();
        let next: V3 | null = null;
        const links = this.mReplayLinks[ni] || [];
        if (this.mSettingParams.mRandomFlag === 0) {
            let smallest = 1;
            for (let i = 0; i < 3; i++) {
                const L = links[i];
                if (!L || L.node === 0xFF) continue;
                const cp = G.point(L.node);
                const cd = new V3(fr(cp.x - cur.x), fr(cp.y - cur.y), fr(cp.z - cur.z)).normalize();
                const dot = fr(md.dot(cd));
                if (dot < smallest) { smallest = dot; next = cp; this.mReplayIndex = L.replay; }
            }
        } else {
            const dots = [0, 0, 0], valid = [0, 0, 0];
            let n = 0;
            for (let i = 0; i < 3; i++) {
                dots[i] = 0;
                const L = links[i];
                if (!L || L.node === 0xFF) continue;
                const cp = G.point(L.node);
                const cd = new V3(fr(cp.x - cur.x), fr(cp.y - cur.y), fr(cp.z - cur.z)).normalize();
                dots[n] = fr(md.dot(cd));
                valid[n] = i;
                ++n;
            }
            const w = [0, 0, 0];
            let total = 0;
            for (let i = 0; i < n; i++) { w[i] = fr(1 - dots[i]); w[i] = fr(Math.pow(w[i], this.mSettingParams.mRandomPow)); total = fr(total + w[i]); }
            for (let i = 0; i < n; i++) w[i] = fr(w[i] / total);
            let choice = MsRandF(), sel = 0;
            for (let i = 0; i < n; i++) { choice = fr(choice - w[i]); if (choice <= 0) { sel = i; break; } }
            const L = links[valid[sel]];
            if (L) { this.mReplayIndex = L.replay; next = L.node === 0xFF ? null : G.point(L.node); }
        }
        // (the game leaves nextPoint uninitialized with no link: the node itself here)
        const np = next || cur;
        this.pos.set(cur);
        this.mFaceAngle.y = matan(fr(np.z - cur.z), fr(np.x - cur.x));
        this.resetReplayStatus();
        const R = this.mInputReplays && this.mInputReplays[this.mReplayIndex];
        if (R) { R.reset(); R.start(); }
        this.changeEMDoing(EM.REPLAY);
    }
    emPreDownAnimation() {
        this.changePlayerStatus(S.NOMOTION, 0, true);
        this.setAnimation(A.SDWNF, 1);
        if (this.getMotionFrameCtrl().frame > 25) { this.mEMDoingTimer = 0; this.mEMDoing = EM.DOWN_ANIMATION; }
    }
    emDownAnimation() {
        this.changePlayerStatus(S.NOMOTION, 0, true);
        this.setAnimation(A.FALL_DOWN_WAIT, 1);
        if (this.world.demoMode || this.world.talkMode) { this.mReferencePosition.set(this.pos); this.mDisappearPosition.set(this.mReferencePosition); return; }
        ++this.mEMDoingTimer;
        this.mReferencePosition.set(this.pos);
        this.mDisappearPosition.set(this.mReferencePosition);
        if (this.world.map !== 1 && this.mEMDoingTimer > this.mSettingParams.mDownTime) {
            this.mWaterCounter = this.mSettingParams.mWaterCtMax;
            this.changeEMDoing(EM.RUN_AWAY_TO_NEAREST_NODE);
        }
    }
    startRunAway() { this.changeEMDoing(EM.RUN_AWAY_TO_NEAREST_NODE); }
    findRunAwayNearestNode() {
        let ni = 0, si = 0, nd = 100000, sd = 100000;
        let np = new V3(), sp = new V3();
        const G = this.graph;
        for (let i = 0; i < G.count; i++) {
            const p = G.point(i);
            const d = fr(V3.sub(p, this.pos).length());
            if (d < nd) { sd = nd; si = ni; sp = np; nd = d; ni = i; np = p; }
            else if (d < sd) { sd = d; si = i; sp = p; }
        }
        this.mRunAwayNodeIndex = fr(V3.sub(this.pos, np).length()) < fr(V3.sub(this.pos, sp).length()) ? ni : si;
    }
    emRunAwayToNearestNode() {
        const G = this.graph;
        const target = G.point(this.mRunAwayNodeIndex);
        if (this.mEMDoingTimer >= 8 && this.mEMDoingTimer < 300) this.offEMFlag(EM_FLAG.DISP_PENCIL);
        else this.onEMFlag(EM_FLAG.DISP_PENCIL);
        switch (this.mEMDoingTimer) {
            case 0:
                this.findRunAwayNearestNode();
                this.mDisappearPosition.set(this.pos);
                this.mDisappearPosition.y = fr(this.mDisappearPosition.y + 80);
                this.emEffect('kgm_change', this.mDisappearPosition);
                break;
            case 8: break;
            case 100: {
                const d = V3.sub(target, this.mReferencePosition).normalize().scale(this.mRunAwaySpeed);
                this.mDisappearPosition.add(d);
                const dx = fr(target.x - this.mDisappearPosition.x), dz = fr(target.z - this.mDisappearPosition.z);
                if (fr(dx * dx + dz * dz) < fr(this.mRunAwaySpeed * this.mRunAwaySpeed)) this.mEMDoingTimer = 200;
                --this.mEMDoingTimer;
                break;
            }
            case 200:
                this.pos.set(target); this.pos.y = fr(this.pos.y + 5);
                break;
            case 220:
                this.emEffect('kgm_change', this.mDisappearPosition);
                break;
            case 300:
                if (this.world.map === 1 && this.mRunAwayInputReplays) {
                    const wp = G.point(7);
                    this.mFaceAngle.y = matan(fr(wp.z - target.z), fr(wp.x - target.x));
                    this.mModelFaceAngle = this.mFaceAngle.y;
                    this.pos.set(target); this.pos.y = fr(this.pos.y + 5);
                    this.changePlayerStatus(S.WAIT, 0, true);
                    this.mReplayIndex = this.mRunAwayNodeIndex;
                    this.mInputReplays = this.mRunAwayInputReplays;
                    const R = this.mInputReplays[this.mReplayIndex];
                    if (R) { R.reset(); R.start(); }
                    this.changeEMDoing(EM.REPLAY_RUN_AWAY);
                } else {
                    this.pos.set(target); this.pos.y = fr(this.pos.y + 5);
                    this.changePlayerStatus(S.WAIT, 0, true);
                    this.emReplayWaitingToReplayJumpToNearestNode();
                }
                break;
        }
        ++this.mEMDoingTimer;
    }
    emReplayRunAway() {
        const R = this.mInputReplays![this.mReplayIndex];
        if (R) R.play(this);
        if (!R || !R.canPlay()) {
            this.changePlayerStatus(S.NOMOTION, 0, true);
            this.setAnimation(A.MONTEMAN_WAIT, 1);
            this.changeEMDoing(EM.WAITING_TO_INVITE_MARIO);
        }
    }
    decideDoingAfterCarry() {
        if (this.checkEMFlag(EM_FLAG.ENFORCE_TAKE)) { this.offEMFlag(EM_FLAG.ENFORCE_TAKE); this.emReplayWaitingToReplayJumpToNearestNode(); return; }
        if (this.mSettingParams.mStopFlag === 1) { this.changeEMDoing(EM.REPLAY_WAITING); return; }
        this.emReplayWaitingToReplayJumpToNearestNode();
    }
    emEnforceTake() {
        if (this.tryTake()) {
            if (this.mStampActor && this.mSettingParams.mStampFlag === 1) { this.mStampActor.mactor!.setBck('stamp_koopa_sign_draw1'); this.changeEMDoing(EM.UNK13); }
            else this.decideDoingAfterCarry();
        }
    }
    emDrawStamp() { if (this.mStampActor!.mactor!.curAnmEndsNext(ANM_BCK)) this.decideDoingAfterCarry(); }
    emWaitingToInviteMario() {
        const G = this.graph;
        const wp = G.point(7);
        this.pos.set(wp);
        const d = s16(this.mAngleToMario - this.mFaceAngle.y);
        this.mFaceAngle.y = s16(this.mAngleToMario - IConverge(d, 0, 0x180, 0x180));
        this.changePlayerStatus(S.WAIT, 0, false);
        this.changeMontemanWaitingAnim();
        const m = this.marioPos();
        if (fr(V3.sub(this.pos, m).length()) < this.mSettingParams.mSearchDist && m.y < fr(this.pos.y + this.mSettingParams.mSearchHeight)) {
            const gp = G.point(8);
            this.mFaceAngle.y = matan(fr(gp.z - wp.z), fr(gp.x - wp.x));
            this.mModelFaceAngle = this.mFaceAngle.y;
            this.changePlayerStatus(S.WAIT, 0, true);
            this.mReplayIndex = 0;
            if (this.mGateReplay) { this.mGateReplay.reset(); this.mGateReplay.start(); }
            this.changeEMDoing(EM.REPLAY_RUN_AWAY_TO_GATE);
        }
    }
    emReplayRunAwayToGate() {
        if (this.mGateReplay) this.mGateReplay.play(this);
        if (!this.mGateReplay || !this.mGateReplay.canPlay()) {
            this.changePlayerStatus(S.NOMOTION, 0, true);
            this.setAnimation(A.MONTEMAN_WAIT, 1);
            this.changeEMDoing(EM.UNK18);
        }
    }
    emReplayToGoal() {
        const R = this.mInputReplays![this.mReplayIndex]!;
        R.play(this);
        if (!R.canPlay()) this.reachGoal();
    }
    emWaitingMario() { this.emKeepStay(); this.changePlayerStatus(S.WAIT, 0, false); this.changeMontemanWaitingAnim(); }
    emKeepStay() { const d = s16(this.mAngleToMario - this.mFaceAngle.y); this.mFaceAngle.y = s16(this.mAngleToMario - IConverge(d, 0, 0x180, 0x180)); }
    startGateDrawing() {
        this.changePlayerStatus(S.NOMOTION, 0, true);
        this.setAnimation(A.DRAW, 1);
        this.mEMDoingTimer = 0; this.mEMDoing = EM.GATE_DRAWING;
    }
    emGateDrawing() {
        this.pos.set(this.graph.point(8));
        this.mFaceAngle.y = -0x8000; this.mModelFaceAngle = -0x8000;
        if (this.isLast1AnimeFrame()) this.startDisappear(EM.DISAPPEAR_TO_GATE);
    }

    consider() {
        switch (this.mEMDoing) {
            case EM.WAITING: this.emWaiting(); break;
            case EM.RUN_AWAY: this.emRunAway(); break;
            case EM.JUMPING: this.emJumping(); break;
            case EM.GET_CLOSER: this.emGetCloser(); break;
            case EM.WALK_AROUND: this.emWalkAround(); break;
            case EM.WALK_GRAPH: this.emWalkGraph(); break;
            case EM.TURNING: this.emTurning(); break;
            case EM.HIDE: this.emHide(); break;
            case EM.APPEAR: this.emAppear(); break;
            case EM.DISAPPEAR: this.emDisappear(); break;
            case EM.DISAPPEAR_TO_GATE: this.emDisappearToGate(); break;
            case EM.REPLAY_WAITING: this.emReplayWaiting(); break;
            case EM.REPLAY_JUMP_TO_NEAREST_NODE: this.emReplayJumpToNearestNode(); break;
            case EM.PRE_DOWN_ANIMATION: this.emPreDownAnimation(); break;
            case EM.DOWN_ANIMATION: this.emDownAnimation(); break;
            case EM.RUN_AWAY_TO_NEAREST_NODE: this.emRunAwayToNearestNode(); break;
            case EM.WAITING_MARIO: this.emWaitingMario(); break;
            case EM.UNK12: this.emEnforceTake(); break;
            case EM.UNK13: this.emDrawStamp(); break;
            case EM.WAITING_TO_INVITE_MARIO: this.emWaitingToInviteMario(); break;
            case EM.UNK18: case EM.UNK1A: this.emKeepStay(); break;
            case EM.GATE_DRAWING: this.emGateDrawing(); break;
            // (GET_PAD: a 2P/3P/4P Mario reads its own pad (the multiplayer map): not simulated)
        }
    }
    considerAfter() {
        if (this.mEMDoing === EM.REPLAY) this.emReplay();
        if (this.mEMDoing === EM.REPLAY_RUN_AWAY) this.emReplayRunAway();
        if (this.mEMDoing === EM.REPLAY_RUN_AWAY_TO_GATE) this.emReplayRunAwayToGate();
        if (this.mEMDoing === EM.REPLAY_TO_GOAL) this.emReplayToGoal();
    }
    hitWater(sender: HitActor) {
        if (this.mSpecialModel) return;
        if (this.mSettingParams.mInvincibleFlag) return;
        switch (this.mEMDoing) {
            case EM.REPLAY: case EM.REPLAY_WAITING: case EM.REPLAY_JUMP_TO_NEAREST_NODE:
                this.mWaterHitTimer = 600;
                if (this.mWaterCounter > 0) {
                    --this.mWaterCounter;
                    this.emEffect('wathit', sender.pos);
                    this.mWaterEffectTimer = this.mWaterEffectTimerMax;
                    if (this.mEMDoing === EM.REPLAY_WAITING) { this.sleepingEffectKill(); this.emReplayWaitingToReplayJumpToNearestNode(); }
                    break;
                }
                if (this.mStatus === S.RUN && this.canSleep()) {
                    if (this.mHeldObject) { (this.mHeldObject as LiveActor).offLiveFlag(LF.UNK100000); this.dropObject(); }
                    this.changeEMDoing(EM.PRE_DOWN_ANIMATION);
                    this.world.events.push({ t: this.world.tickCount, kind: 'emario:down', data: { pos: this.pos.clone() } });
                }
                break;
        }
    }
    thinkTrample() {
        if (this.mSpecialModel) return false;
        if (this.mEMDoing === EM.DOWN_ANIMATION) {
            --this.mTrampleCount;
            if (this.mTrampleCount > 0) this.changeEMDoing(EM.REPLAY_JUMP_TO_NEAREST_NODE);
            return true;
        }
        return false;
    }
    reachGoal() { this.onEMFlag(EM_FLAG.GOAL_REACHED); this.changeEMDoing(EM.WAITING_MARIO); }
    checkReturn() {
        if (!this.mGroundPlane.isIllegal()) return;
        const G = this.graph;
        if (!G.count) return;
        let n = G.findNearestNodeIndex(this.pos, -1);
        // (the game loops until a node is over 1000 from Mario: one lap here)
        for (let k = 0; k < G.count; k++) {
            const p = G.point(n);
            if (fr(V3.sub(p, this.marioPos()).length()) > 1000) { this.pos.set(p); break; }
            n = (n + 1) % G.count;
        }
    }
    checkController() {
        const m = this.marioPos();
        const dx = fr(m.x - this.pos.x), dz = fr(m.z - this.pos.z);
        this.mAngleToMario = matan(dz, dx);
        // TEnemyMario::checkController: std::sqrtf (MSL math.h, three Newton steps), not Math.sqrt.
        this.mDistanceToMario = sqrtf(fr(dx * dx + dz * dz));
        const C = this.unk108;
        const prev = C.mInput;
        C.mStickHS16 = 0; C.mStickVS16 = 0; C.mInput = 0; C.mFrameInput = 0; C.mAnalogRU8 = 0; C.mAnalogLU8 = 0;
        this.consider();
        C.mStickHS16 = s16(C.mStickHS16); C.mStickVS16 = s16(C.mStickVS16);
        C.mStickH = 0; C.mStickV = 0;
        if (C.mStickHS16 < -7) C.mStickH = C.mStickHS16 + 6;
        if (C.mStickHS16 > 7) C.mStickH = C.mStickHS16 - 6;
        if (C.mStickVS16 < -7) C.mStickV = C.mStickVS16 + 6;
        if (C.mStickVS16 > 7) C.mStickV = C.mStickVS16 - 6;
        // std::sqrtf, same as above.
        C.mStickDist = sqrtf(fr(C.mStickH * C.mStickH + C.mStickV * C.mStickV));
        if (C.mStickDist > 64) { C.mStickH = fr(C.mStickH * fr(64 / C.mStickDist)); C.mStickV = fr(C.mStickV * fr(64 / C.mStickDist)); C.mStickDist = 64; }
        C.mFrameInput = (C.mInput & (C.mInput ^ prev)) >>> 0;
        const r = fr(C.mStickDist * (1 / 64));
        this.mIntendedMag = fr(fr(64 * fr(r * r)) * 0.5);
        this.mIntendedYaw = this.mIntendedMag > 0 ? matan(-C.mStickV, C.mStickH) : this.mFaceAngle.y;
        this.considerAfter();
        if (this.mIntendedMag > 0) this.mInput |= 1;
        if (C.isAHit()) this.mInput |= 2;
        if (C.isAPressed()) this.mInput |= 0x80;
        if (C.isBPressed()) this.mInput |= 0x4000;
        if (C.isBHit()) this.mInput |= 0x8000;
    }
    playerControl() {
        this.unk9C = this.mFaceAngle.y;
        this.mPrevPosition.set(this.pos);
        this.offUnk114(8);
        this.checkPlayerAction();
        this.stateMachine();
        this.stateMachineUpper();
        this.thinkSituation();
        this.thinkWaterSurface();
        this.thinkSand();
        this.thinkHeight();
        this.thinkParams();
        this.checkRideReCalc();
        this.checkWet();
    }
    damageExec() { }

    perform(cue: number) {
        if (this.mFreezeTimer > 0) --this.mFreezeTimer;
        if (this.mWaterHitTimer > 0) --this.mWaterHitTimer;
        if (cue & CUE_MOVE) {
            if (this.checkEMFlag(EM_FLAG.FORCE_WATER_HIT)) { this.mWaterCounter = 0; this.hitWater(this); }
            if (this.mStatus !== S.RUN || this.mFreezeTimer === 0) { this.playerControl(); this.setPositions(); }
            if (this.mStatus !== S.RUN || this.mFreezeTimer === 0) this.calcAnim();
            const E = this.mEMario;
            // emarioActor->calcAnm(): its scroll; its joints are his (setAnmMtx per joint)
            if (E.mactor) E.mactor.frameUpdate();
            E.baseTR.set(this.mModel.baseTR);
            if (this.mBrushModel) {
                const h = this.mModel.anmMtx(this.mJointIdHandL);
                if (h) { const b = this.mBrushModel.baseTR; b[0] = h[0]; b[1] = h[4]; b[2] = h[8]; b[3] = h[12]; b[4] = h[1]; b[5] = h[5]; b[6] = h[9]; b[7] = h[13]; b[8] = h[2]; b[9] = h[6]; b[10] = h[10]; b[11] = h[14]; }
            }
            if (this.isDispStamp() && this.mStampActor) {
                const sc = this.mBrushScaleupDuringDrawing, B = this.mModel.baseTR, T = this.stampTR;
                const rot = mtx(); MsMtxSetRotRPH(rot, 0, 180, 0);
                // baseTR * scale(sc) * rot
                for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
                    let v = 0; for (let k = 0; k < 3; k++) v += B[r * 4 + k] * sc * rot[k * 4 + c];
                    T[r * 4 + c] = v;
                }
                T[3] = B[3]; T[7] = B[7]; T[11] = B[11];
                this.mStampActor.baseTR.set(T);
                this.mStampActor.mactor!.frameUpdate();
            }
            this.attackRadius = 800; this.attackHeight = 150; this.damageRadius = 60; this.damageHeight = 40;
            this.calcEntryRadius();
            if (this.mWaterEffectTimer > 0) --this.mWaterEffectTimer; else this.mWaterEffectTimer = 0;
        }
        if (cue & CUE_CALC_ANIM) {
            // CUE_ENTRY's work, once a frame here: the stamp into the goop (gpPollution->stampModel)
            if (!this.mSpecialModel && this.isDispStamp() && this.mStampActor && this.world.pollution)
                this.world.pollution.stampModel(this.mStampActor.mactor!, this.stampTR, { x: 1, y: 1, z: 1 });
        }
        const disp = this.checkEMFlag(EM_FLAG.DISP_PENCIL);
        if (this.mBrushModel) this.mBrushModel.show = disp;
        if (this.mStampActor) this.mStampActor.show = this.isDispStamp();
    }
}

// ---------------------------------------------------------------- TEMario
export class TEMario extends SpineEnemy {
    mInitialState = 0; unk158 = 0; unk15C = 0; unk160 = 0;
    mEnemyMario!: EnemyMario;
    constructor(w: World, name = 'マリオモドキ') { super(w, name); }
    load(s: Stream) {
        super.load(s);
        this.mInitialState = s.u32(); this.unk158 = s.u32(); this.unk15C = s.u32(); this.unk160 = s.u32();
        s.u32(); s.u32();
        if (this.mInitialState === 0xFF) this.mInitialState = 0;
        if (this.unk158 === 0xFF) this.unk158 = 0;
        if (this.unk15C === 0xFF) this.unk15C = 0;
        if (this.unk160 === 0xFF) this.unk160 = 0;
        const em = this.mEnemyMario = new EnemyMario(this.world, this);
        em.initValues();
        em.pos.set(this.pos); em.rot.set(this.rot); em.scale.set(this.scale);
        em.mFaceAngle.y = s16(Math.trunc(fr(fr(this.rot.y * fr(0.0027777778)) * 65536)));
        em.initEnemyValues();
        em.onFlag(MF.NPC_TALKING);
    }
    init(m: LiveManager | null) {
        if (!m) {
            const c = this.world.search(this.character) as ObjChara | null;
            const folder = (c && c.folder ? c.folder : '/scene/kagemario').replace(/^\/?scene\//i, '').replace(/^\//, '').toLowerCase();
            this.mactor = new MActor(folder + '/default.bmd', new AnmData(folder, this.world.files));
            this.mactor.setAnimation('kagemario_scroll', ANM_BTK);
            this.world.conductor.aloneActors.push(this);
        } else {
            this.manager = m; m.manageActor(this);
            this.mactor = this.createMActor(0);
        }
        this.onHitFilter(HF.NO_COLLISION);
        this.offLiveFlag(LF.FORCE_SHADOW);
        this.initHitActor(AT.E_MARIO, 4, HC.PLAYER | HC.MAP_OBJECT | HC.ITEM | HC.NPC | HC.WATER, 70, 45, 60, 40);
        this.offHitFilter(HF.NO_COLLISION);
        this.onLiveFlag(LF.UNK10);
    }
    /** The viewer's joint callback: each joint in its parent's, from his Mario model's calc. */
    get locals(): mat4[] { return this.mEnemyMario ? this.mEnemyMario.mModel.locals : []; }
    /** CUE_ENTRY draws him while EM_FLAG_DISP_PENCIL is on (the rest of the draw checks are for the 2P rigs). */
    drawn() { return !!this.mEnemyMario && this.mEnemyMario.checkEMFlag(EM_FLAG.DISP_PENCIL); }
    /** SMS_AddDamageFogEffect while he's flashing from the water */
    get damageFog() { return !!this.mEnemyMario && this.mEnemyMario.mWaterEffectTimer > 0; }
    checkCollision() {
        for (const c of this.collisions) {
            if (c.actorType === AT.MARIO) {
                if (fr(V3.sub(this.pos, c.pos).length()) < this.mEnemyMario.mAttackRange) c.receiveMessage(this, MSG.ATTACK);
            }
            // (GESO_SURF_BOARD: he gets on a Blooper; not on this stage)
        }
    }
    receiveMessage(sender: HitActor, msg: number) {
        super.receiveMessage(sender, msg);
        if (msg === MSG.SPRAYED_BY_WATER) { this.mEnemyMario.hitWater(sender); return true; }
        else if (msg === MSG.TRAMPLE) return this.mEnemyMario.thinkTrample();
        else if (sender.actorType === AT.MONTE_GOAL_FLAG) this.mEnemyMario.reachGoal();
        return false;
    }
    kill() { }
    isGoal() { return this.mEnemyMario.checkEMFlag(EM_FLAG.GOAL_REACHED); }
    startRunAway() { this.mEnemyMario.startRunAway(); }
    startMonteReplay(i: number) { this.mEnemyMario.startMonteReplay(i); }
    startGateDrawing() { this.mEnemyMario.startGateDrawing(); }
    forceDisappear() { this.mEnemyMario.startDisappear(9); }
    perform(cue: number) {
        if (this.checkLiveFlag(LF.UNK40)) return;
        const em = this.mEnemyMario;
        if ((cue & CUE_MOVE) && em.canControl()) this.checkCollision();
        em.perform(cue);
        if (cue & CUE_MOVE) {
            this.pos.set(em.pos); this.rot.set(em.rot); this.scale.set(em.scale);
            this.attackRadius = em.attackRadius; this.attackHeight = em.attackHeight;
            this.damageRadius = em.damageRadius; this.damageHeight = em.damageHeight;
            this.calcEntryRadius();
        }
    }
}

export class TEMarioManager extends EnemyManager {
    load(s: Stream) {
        this.saveParams = readParams('/enemy/emario.prm', this.world.files, SPINE_PARAMS);
        super.load(s);
    }
    createEnemyInstance() { return new TEMario(this.world, 'マリオモドキ'); }
}

register('EMario', (w, n) => new TEMario(w, n));
register('EMarioManager', (w, n) => new TEMarioManager(w, n));
