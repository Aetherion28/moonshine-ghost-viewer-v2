// The game camera, CPolarSubCamera (gpCamera), ported from the decomp: Camera/cameragc.cpp
// (perform, ctrlGameCamera_, calcPosAndAt_, loadAfter), CameraNormal.cpp (the follow / tower
// camera), CameraMode.cpp (the mode predicates), CameraChange.cpp (mode changes: the camera cubes'
// kinds, Mario's state, the L / Y buttons), CameraCodeControl.cpp (the camera cubes),
// CameraBGCheck.cpp (wall / roof / ground collision, the in-house number), CameraHeightPan.cpp,
// CameraSecureView.cpp, CameraInbetween.cpp, CameraWarp.cpp, CameraNotice.cpp (the Y-button lock-on
// and the L-button camera), CameraDemo.cpp (demo cameras), CameraTalk.cpp, CameraMarioData.cpp.
// Float operations round where the DOL's code rounds (each function was checked against its
// instructions for fused multiply-adds); see lib.ts.
//
// What Mario's input replay needs is `yaw()` (gpCamera->unk258, the angle from the camera's
// target to its position, CLBCrossToPolar of mTarget -> mPosition after the tick's update) and
// isLButtonCamera / offsetAngleY, all as of the camera's last perform.
//
// ORDER (TMarDirector::direct): each movement tick (4 a frame) the pads' updateMeaning runs first
// (on all but a frame's first tick, after resetButtons), then the movement perform list — the map,
// the conductor, the managers, then the player group (TMario::perform: playerControl, which reads
// gpCamera->unk258 from the PREVIOUS tick's camera, then thinkCube), then the camera group
// (CPolarSubCamera::perform, CUE_MOVE). So: `camera.update(mario, pad, tick)` once per movement
// tick, right after Mario's perform, with tick bit 1 on the frame's first tick and bit 2 on its
// last (JDrama::TGraphics::unk0 as direct sets it). Mario reads camera.yaw() during his perform,
// before that tick's update.
//
// Stage start: new PolarSubCamera(world) when the stage is built, loadAfter(mario) once Mario is
// placed (TMarDirector::setupObjects's loadAfter pass); then the intro: startDemoCamera('startcamera')
// at the stage's first tick (TMarDirector::nextStateInitialize(STATE_UNK1)), endDemoCamera() when
// the director leaves the intro (currentStateFinalize(STATE_UNK1): the wipe closed, the ghost's
// first camera key / input record), and directorState = 4 once play starts (TMarDirector mState:
// the camera cubes and mode changes only run in state 4).

import { fr, s16, matan, JMASSin, JMASCos } from '../math.js';
import { World, LF } from '../engine.js';
import { BGCheckData, WallCheck } from '../collision.js';
import { AT } from '../actortypes.js';
import type { SimCamera } from './types.js';
import {
    Vec, vec, vcopy, vset, vadd, veq, CLBConstUpVec, MsSqrtf, CLBRoundfS16, CLBDegToShortAngle, lerpF, lerpS, ratioF, ratioI, easeInF, easeInS,
    clamp, chaseFrameF, chaseSpeedS, chaseSpeedF, chaseAngleDecrease, chaseDecrease, chaseSpecialDecrease, crossToPolar, crossToPolar2,
    polarToCross, revisionLookatByAngleX, msVecNormalize, vnormalize,
} from './lib.js';
import { KindParam, KindSave, ExSave, NoticeSave, loadKind, loadEx, loadNotice, KIND_FILES } from './params.js';
import { CameraTables, CameraMapTool } from './maptool.js';

// ---------------------------------------------------------------- ECameraMode
export const CM = {
    FOLLOW: 0x0, PARALLEL: 0x1, MULTI_PLAYER: 0x2, WALL_JUMP: 0x3, HIP_ATTACK: 0x4, ROCKET_JUMP: 0x5, WIRE: 0x6, L_NORMAL: 0x7,
    MARE_UNDER_GROUND: 0x8, DEFINITE_D2: 0x9, TALK_E: 0xA, LEAN_MIRROR: 0xB, TALK_A: 0xC, UNDER_GROUND: 0xD, INDOOR: 0xE, HANG: 0xF,
    WIRE_HANG: 0x10, SAND_BIRD: 0x11, HOVERING: 0x12, JUMP_CODE: 0x13, DELFINO: 0x14, CLIMB: 0x15, FIX_A: 0x16, FIX_B: 0x17, FIX_C: 0x18,
    FIX_D: 0x19, FIX_E: 0x1A, FIX_F: 0x1B, FIX_G: 0x1C, FIX_H: 0x1D, DEFINITE_A: 0x1E, DEFINITE_B: 0x1F, DEFINITE_C: 0x20, DEFINITE_D: 0x21,
    DEFINITE_E: 0x22, DEFINITE_F: 0x23, DEFINITE_G: 0x24, DEFINITE_H: 0x25, EX_MAP_0: 0x26, TOWER_A: 0x27, TOWER_B: 0x28, TOWER_C: 0x29,
    SLIDER: 0x2A, DIVING: 0x2B, TURBO: 0x2C, TALK_B: 0x2D, JET_COASTER: 0x2E, PARALLEL_B: 0x2F, SURFING: 0x30, SWIMMING: 0x31,
    CLIMB_JUMP: 0x32, LOOK_DOWN: 0x33, RAIL_FENCE: 0x34, FOLLOW_B: 0x35, FOLLOW_C: 0x36, TOWER_D: 0x37, DELFINO_ATTIC: 0x38, BOSS_GESO: 0x39,
    FIX_I: 0x3A, DEFINITE_I: 0x3B, FENCE: 0x3C, MONTE_FENCE: 0x3D, MONTE_HANG: 0x3E, TALK_C: 0x3F, TALK_D: 0x40, TOWER_E: 0x41,
    DELFINO_B: 0x42, CANCAN: 0x43, AQUATIC_TURBO: 0x44, FOLLOW_D: 0x45, FOLLOW_E: 0x46, PARALLEL_C: 0x47, PARALLEL_D: 0x48,
    REPRODUCE_DEMO: 0x49, INVALID: -1,
} as const;
/** CPolarSubCamera::unk64 */
const CF = {
    UNK1: 0x1, UNK2: 0x2, UNK4: 0x4, UNK8: 0x8, UNK10: 0x10, NOTICE_ACTIVE: 0x20, UNK40: 0x40, UNK80: 0x80, UNK100: 0x100, GATE_DEMO: 0x200,
    DEAD_DEMO: 0x400, HELL_DEAD_DEMO: 0x800, JET_COASTER_SCENE: 0x1000,
};
/** TMarioGamePad meanings the camera reads */
const MEANING = { R: 0x400, Y: 0x4000, CAM_L: 0x8000, CAM_AB: 0x10000 };
/** MARIO_STATUS_* and MARIO_FLAG_* the camera reads (player/tables.ts's S and MF) */
const ST = {
    HANGING: 0x3800034B, ASCEND: 0x3000054C, KICK_ROOF_ROLL_UP: 0x200345, HIP_DROP: 0x8008A9, DOOR_OPEN_R: 0x1320, DOOR_OPEN_L: 0x1321,
    ROCKET_LANDING: 0x88D, ROCKET: 0x88B, BAR_WAIT: 0x18100340, BAR_HANG: 0x10100341, BAR_UNK342: 0x10100342, BAR_CLIMB: 0x10100343,
    TOROCCO: 0x800447, WIRE_WAIT_TO_HANG: 0x10000554, WIRE_HANGING: 0x10000357, WIRE_ROLLING: 0x10000358, WIRE_JUMP: 0x892,
    FENCE_UNK569: 0x30000569, FENCE_MOVE: 0x38000368, FENCE_PUNCH: 0x3000036A, FENCE_CATCH: 0x3000036B, FENCE_JUMP_CATCH: 0x3000036C,
    FORCE_JUMP: 0x884, WALL_JUMP: 0x2000886, WALL_SLIDE: 0x8A7, SLEEPY: 0xC400202, SLEEP: 0xC000203,
    FLAG_SWIMMING: 0x2000, FLAG_JUMPING: 0x800, FLAG_UNK8000: 0x8000, FLAG_UNK10000: 0x10000, FLAG_UNK20000: 0x20000, FLAG_UNK200000: 0x200000,
    FLAG_UNK20000000: 0x20000000,
};
const MF = { OCCLUDED: 0x1, UNK2: 0x2, GAME_OVER: 0x400, HELMET_FLW_CAMERA: 0x1000, FLUDD_EMITTING: 0x4000, HAS_FLUDD: 0x8000 };

const isLButtonMode = (m: number) => m === CM.L_NORMAL;
const isTalkMode = (m: number) => m === CM.TALK_E || m === CM.TALK_A || m === CM.TALK_B || m === CM.TALK_C || m === CM.TALK_D;
const NORMAL = new Set<number>([CM.FOLLOW, CM.PARALLEL, CM.WALL_JUMP, CM.HIP_ATTACK, CM.ROCKET_JUMP, CM.WIRE, CM.MARE_UNDER_GROUND, CM.LEAN_MIRROR,
    CM.UNDER_GROUND, CM.INDOOR, CM.HANG, CM.WIRE_HANG, CM.SAND_BIRD, CM.HOVERING, CM.JUMP_CODE, CM.DELFINO, CM.CLIMB, CM.EX_MAP_0, CM.SLIDER,
    CM.DIVING, CM.TURBO, CM.PARALLEL_B, CM.SURFING, CM.SWIMMING, CM.CLIMB_JUMP, CM.LOOK_DOWN, CM.RAIL_FENCE, CM.FOLLOW_B, CM.FOLLOW_C,
    CM.DELFINO_ATTIC, CM.BOSS_GESO, CM.FENCE, CM.MONTE_FENCE, CM.MONTE_HANG, CM.DELFINO_B, CM.CANCAN, CM.AQUATIC_TURBO, CM.FOLLOW_D,
    CM.FOLLOW_E, CM.PARALLEL_C, CM.PARALLEL_D]);
const isNormalMode = (m: number) => NORMAL.has(m);
const isTowerMode = (m: number) => m === CM.TOWER_A || m === CM.TOWER_B || m === CM.TOWER_C || m === CM.TOWER_D || m === CM.TOWER_E;
const isFollowMode = (m: number) => m === CM.FOLLOW || m === CM.FOLLOW_B || m === CM.FOLLOW_C || m === CM.FOLLOW_D || m === CM.FOLLOW_E;
const isRailMode = (_m: number) => false;
const isFixMode = (m: number) => (m >= CM.FIX_A && m <= CM.FIX_H) || m === CM.FIX_I;
const isDefiniteMode = (m: number) => m === CM.DEFINITE_D2 || (m >= CM.DEFINITE_A && m <= CM.DEFINITE_H) || m === CM.DEFINITE_I;
const isFixOrDefinite = (m: number) => isFixMode(m) || isDefiniteMode(m);
const OVER_HIP = new Set<number>([CM.MARE_UNDER_GROUND, CM.LEAN_MIRROR, CM.UNDER_GROUND, CM.INDOOR, CM.SAND_BIRD, CM.DELFINO, CM.EX_MAP_0,
    CM.TOWER_A, CM.TOWER_B, CM.TOWER_C, CM.SLIDER, CM.PARALLEL_B, CM.LOOK_DOWN, CM.TOWER_D, CM.DELFINO_ATTIC, CM.BOSS_GESO, CM.TOWER_E,
    CM.DELFINO_B, CM.CANCAN, CM.PARALLEL_C, CM.PARALLEL_D]);
const isOverHipAttackMode = (m: number) => isFixOrDefinite(m) || OVER_HIP.has(m);
const SLOPE = new Set<number>([CM.FOLLOW, CM.PARALLEL, CM.HIP_ATTACK, CM.LEAN_MIRROR, CM.INDOOR, CM.DELFINO, CM.EX_MAP_0, CM.TOWER_A, CM.TOWER_B,
    CM.TOWER_C, CM.SLIDER, CM.TURBO, CM.PARALLEL_B, CM.FOLLOW_B, CM.FOLLOW_C, CM.TOWER_D, CM.DELFINO_ATTIC, CM.TOWER_E, CM.DELFINO_B,
    CM.FOLLOW_D, CM.FOLLOW_E, CM.PARALLEL_C, CM.PARALLEL_D]);

// ---------------------------------------------------------------- what the camera asks of Mario
/**
 * gpMarioOriginal as the camera reads it (the fields TMarioSim has under these names). Optional
 * parts read as absent / zero.
 */
export interface CameraMario {
    pos: Vec;
    /** getPrevPosition */
    mPrevPosition: Vec;
    mFaceAngle: { y: number };
    mStatus: number; mPrevStatus: number;
    /** mFlag (gpMarioFlag) */
    mFlag: number;
    /** SMS_GetMarioGrLevel: mFloorPosition.y */
    mFloorPosition: Vec;
    /** gpMarioGroundPlane */
    mGroundPlane?: BGCheckData | null;
    unk9C?: number;
    mHeldObject?: any; holder?: any; unk2C0?: any;
    isTouchGround4cm?(): boolean;
    isOnWire?(): boolean;
    /** TWaterGun: getCurrentNozzle() -> { mLAngleMin / getGunAngle() }, mCurrentNozzle, getNozzleMtx() */
    mWaterGun?: any;
}
/** TMarioGamePad as the camera reads it (player/pad.ts MarioGamePad) */
export interface CameraPad {
    mCompSPos: ArrayLike<number>;
    mSubStick: { mPosX: number; mPosY: number };
    checkMeaning(m: number): boolean;
    checkFrameMeaning(m: number): boolean;
    onNeutralMarioKey(): void;
}
const NO_PAD: CameraPad = { mCompSPos: new Float32Array(10), mSubStick: { mPosX: 0, mPosY: 0 }, checkMeaning: () => false, checkFrameMeaning: () => false, onNeutralMarioKey: () => { } };

/** A camera demo's frame (TCameraBck::updateDemo: the bck's cam_position / cam_interest joints). */
export interface DemoView { pos: Vec; at: Vec; up: Vec; fovy: number; }
/**
 * A demo's .bck (TCameraBck): its length in camera ticks (getTotalDemoFrames) and the view at a
 * tick since its start. The viewer supplies it (it has the J3D animation code: layer.introCamera).
 */
export interface DemoBck { totalFrames: number; view(tick: number): DemoView | null; }

// ---------------------------------------------------------------- TTargetCamera
class Target {
    pos = vec(); target = vec(); unk18 = vec();
    pitch = 0; yaw = 0;
    /** unk28: the X rotation ratio (pitch and distance between the kind's min and max) */
    ratio = 0;
    unk2C = 0; unk30 = 0;
    copy(o: Target) {
        vset(this.pos, o.pos); vset(this.target, o.target); vset(this.unk18, o.unk18);
        this.pitch = o.pitch; this.yaw = o.yaw; this.ratio = o.ratio; this.unk2C = o.unk2C; this.unk30 = o.unk30;
        return this;
    }
}

// ---------------------------------------------------------------- TCameraInbetween
class Inbetween {
    unk0 = 1; frames = 0;
    unk8 = 0; unkC = 0; unkE = 0; unk10 = 0; unk14 = 0; unk16 = 0;
    pos = vec(); at = vec(); unk30 = vec();
    unk3C = 0; unk40 = 0; unk44 = 0;
    isThing() { return this.unk44 !== 0; }
    calcPolarData() {
        let p = crossToPolar(this.at, this.pos); this.unk8 = p.r; this.unkC = p.pitch; this.unkE = p.yaw;
        p = crossToPolar(this.unk30, this.at); this.unk10 = p.r; this.unk14 = p.pitch; this.unk16 = p.yaw;
    }
    warpPosAndAt(pos: Vec, at: Vec) { vset(this.pos, pos); vset(this.at, at); this.calcPolarData(); }
    addMove(v: Vec) { vadd(this.pos, v); vadd(this.at, v); vadd(this.unk30, v); this.calcPolarData(); }
    start(frames: number) { this.frames = frames; this.unk0 = frames; this.unk3C = 0; this.calcPolarData(); }
    init(pos: Vec, at: Vec, mario: Vec) { vset(this.pos, pos); vset(this.at, at); vset(this.unk30, mario); this.calcPolarData(); }
    exec(pos: Vec, at: Vec, mario: Vec) {
        vset(this.pos, pos); vset(this.at, at);
        if (this.frames > 0) {
            const rem = fr(this.frames);
            if (this.isThing()) this.unk44 = chaseFrameF(this.unk44, 0, rem);
            let p = crossToPolar(mario, at);
            this.unk10 = chaseFrameF(this.unk10, p.r, rem);
            this.unk14 = chaseFrameSA(this.unk14, p.pitch, rem);
            this.unk16 = chaseFrameSA(this.unk16, p.yaw, rem);
            if (Math.abs(fr(mario.x - at.x)) > fr(0.1) || Math.abs(fr(mario.z - at.z)) > fr(0.1)) {
                const t = polarToCross(mario, vec(), this.unk10, this.unk14, this.unk16);
                this.at.x = t.x; this.at.z = t.z;
            }
            p = crossToPolar(this.at, pos);
            this.unk8 = chaseFrameF(this.unk8, p.r, rem);
            this.unkC = chaseFrameSA(this.unkC, p.pitch, rem);
            if (this.unk3C === 0) this.unkE = chaseFrameSA(this.unkE, p.yaw, rem);
            else this.unkE = s16(this.unkE + this.unk40);
            polarToCross(this.at, this.pos, this.unk8, this.unkC, this.unkE);
            this.frames -= 1;
            if (this.frames === 0) this.unk3C = 0;
        }
        vset(this.unk30, mario);
    }
}
/** The s16 CLBChaseConstantSpecifyFrame (rounded fmuls, CLBRoundf) */
function chaseFrameSA(v: number, d: number, frames: number) {
    if (frames < fr(0.001)) return d;
    return s16(v + CLBRoundfS16(fr(fr(1 / frames) * s16(d - v))));
}

// ---------------------------------------------------------------- the camera
export class PolarSubCamera implements SimCamera {
    // JDrama::TLookAtCamera
    mPosition = vcopy(CLBConstUpVec); mUp = vcopy(CLBConstUpVec); mTarget = vcopy(CLBConstUpVec);
    mFovy = 0; mAspect = (640 * 0.9134614) / 448; mNear = 10; mFar = 300000;

    mMode = -1; mPrevMode = -1; mSavedModeBeforeTalk = -1; mInitialMode = -1;
    /** unk60: the modes to go back to (CameraUnk60Struct, 4 deep) */
    private stack = [0, 0, 0, 0]; private stackN = 0;
    unk64 = 0;
    P = new KindParam();
    inb = new Inbetween();
    unk70: CameraMapTool | null = null; unk74: CameraMapTool | null = null;
    mPosFreezeFrames = 0; mTargetFreezeFrames = 0;
    cur = new Target(); prev = new Target(); beforeFixed = new Target();
    unk11C = 0;
    pad: CameraPad = NO_PAD;
    unk124 = vec(); unk130 = vec(); unk13C = vec(); unk148 = vec(); unk154 = vec(); unk160 = vec();
    mHeightPanOffset = 0; unk250 = 0; unk254 = 0; unk256 = 0; unk258 = 0;
    unk25C = vec(); unk268 = 0; unk26C = 1; unk270 = 0;
    unk274 = 0; unk276 = 0; unk278 = 0; unk27A = 0;
    mDeadDemoCountdown = 0; mDeadDemoCountdownToFovZoom = 0; mDeadDemoFovZoomTimer = 0; unk282 = 0;
    unk284 = 0; unk288 = 1; unk28C = 0; unk28E = 0; unk290 = 0; unk294 = 0; unk298 = 0;
    private noticeActors: any[] = []; mNoticeActor: any = null; unk2A8: any = null;
    /** unk2AC: the gun-hold offsets */
    hold = { unk0: 0, unk4: 0, unk8: 0, unkC: 0 };
    /** mCameraDemo (TCameraDemo) */
    demo = { offset: null as Vec | null, angle: 0, tool: null as CameraMapTool | null, unkC: 0, total: 0, remaining: 0 };
    /** unk2B0 (TCameraBck): the running bck demo and its tick */
    private bck: DemoBck | null = null; private bckTick = 0;
    unk2C0 = 3; unk2C4 = 2; unk2C8 = -1; unk2CA = -1; unk2CC = 0;
    /** TCameraMarioData (gpCameraMario) */
    cmd = { unk0: vec(), H: 0, V: 0, lastStatus: 0, sinceStatus: 0, unk1C: 0 };
    /** TCameraShake's roll (gpCameraShake->mRollAccum): no shakes are simulated */
    shakeRoll = 0;

    save: KindSave[]; ex: ExSave; notice: NoticeSave;
    tables: CameraTables;
    /** TMarDirector::mState (the cubes and mode changes run in state 4, play) */
    directorState = 4;
    /** TMarDirector::isTalkModeNow / isTalkOrDemoModeNow */
    talkModeNow = false; demoModeNow = false;
    /** TMarDirector::unkD0 (the start position's number, for 開始後カメラ%d) */
    marioPosIdx = 0;
    /** The demo cameras' .bck files by name (TCameraBck::isFileExist / startDemo), e.g. 'startcamera'. */
    bckSource: ((name: string) => DemoBck | null) | null = null;
    /** The projection / view the game last set (unk16C perspective, unk1EC look-at), for the notice clip test */
    private proj = new Float64Array(16); private view = new Float64Array(12);
    private mario: CameraMario | null = null;

    constructor(public world: World) {
        const files = world.files;
        this.save = KIND_FILES.map((_, i) => loadKind(files, i));
        this.ex = loadEx(files); this.notice = loadNotice(files);
        this.tables = CameraTables.load(files.scene('map/tables.bin'));
    }

    // ------------------------------------------------------------ Mario access (MarioAccess.cpp)
    private get M(): CameraMario { return this.mario!; }
    private marioAngleY() { return s16(this.M.mFaceAngle.y); }
    private marioStatus() { return this.M.mStatus >>> 0; }
    private marioFlag(f: number) { return (this.M.mFlag & f) !== 0; }
    private touchGround4cm() { const m = this.M; return m.isTouchGround4cm ? !!m.isTouchGround4cm() : m.pos.y <= fr(m.mFloorPosition.y + 4); }
    private onWire() { const m = this.M; return m.isOnWire ? !!m.isOnWire() : !!(m.holder && m.holder.actorType === AT.MAP_WIRE_ACTOR); }
    private openingDoor() { const s = this.marioStatus(); return s === ST.DOOR_OPEN_R || s === ST.DOOR_OPEN_L; }
    private grPlane(): BGCheckData | null { return this.M.mGroundPlane || null; }
    private statusType(f: number) { return (this.M.mStatus & f) !== 0; }
    private nozzle(): any { const g = this.M.mWaterGun; return g && g.getCurrentNozzle ? g.getCurrentNozzle() : null; }
    private groundActorIs(t: number) { const p = this.grPlane(); const a = p && p.actor; return !!(a && a.actorType === (t | 0)); }

    // ------------------------------------------------------------ predicates
    isNowInbetween() { return this.inb.frames > 0; }
    isLButtonCamera() { return isLButtonMode(this.mMode); }
    isLButtonCameraInbetween() { return this.isNowInbetween() && (isLButtonMode(this.mMode) || isLButtonMode(this.mPrevMode)); }
    isTalkCameraInbetween() { return this.isNowInbetween() && (isTalkMode(this.mMode) || isTalkMode(this.mPrevMode)); }
    isNormalCameraCompletely() { return isNormalMode(this.mMode) && (!this.isNowInbetween() || isNormalMode(this.mPrevMode)); }
    isBckDemoCamera() { return this.mMode === CM.REPRODUCE_DEMO; }
    isSimpleDemoCamera() { return !this.isBckDemoCamera() && (this.demo.remaining > 0 || (this.demo.unkC & 1) !== 0); }
    isDemoCamera() { return this.isSimpleDemoCamera() || this.isBckDemoCamera(); }
    isHellDeadDemo() { return (this.unk64 & CF.DEAD_DEMO) !== 0 && (this.unk64 & CF.HELL_DEAD_DEMO) !== 0; }
    isNormalDeadDemo() { return (this.unk64 & CF.DEAD_DEMO) !== 0 && !(this.unk64 & CF.HELL_DEAD_DEMO); }
    getOffsetAngleX() { return this.P.mOffsetAngleX; }
    getOffsetAngleY() { return this.P.mOffsetAngleY; }
    getFinalAngleZ() { return s16(this.unk254 + this.shakeRoll); }
    getRestDemoFrames() { return this.demo.remaining; }
    getTotalDemoFrames() { return this.demo.total; }
    private isThing() { return isTalkMode(this.mMode) && !this.isNowInbetween(); }
    private isThing2() { return isLButtonMode(this.mMode) && !this.isNowInbetween(); }
    private isThing3() { return this.hold.unk8 > fr(0.3) || this.isThing() || this.isThing2(); }
    /** fabricatedInline3: not under ground (nor just left it) */
    private notUnderGround() {
        return !(this.mMode === CM.UNDER_GROUND || (this.mPrevMode === CM.UNDER_GROUND && (this.isNowInbetween() || this.mMode === CM.JUMP_CODE)));
    }
    private isMarioReadyGun() { return this.marioFlag(MF.HAS_FLUDD) && this.statusType(ST.FLAG_UNK8000); }
    private isMarioAimWithGun() { return this.isMarioReadyGun() && this.pad.checkMeaning(MEANING.R); }
    private isMarioCrabWalk() { return this.isMarioReadyGun() && this.pad.checkMeaning(MEANING.CAM_L); }
    private isMarioGoDown() { return this.cmd.V !== 0 && fr(this.M.pos.y - this.M.mPrevPosition.y) < 0; }
    private isMarioRocketing() { const s = this.marioStatus(); return s === ST.ROCKET_LANDING || s === ST.ROCKET; }
    private isMarioIndoor() { const p = this.grPlane(); return !!p && [0x106, 0x105, 0x108, 0x109].includes(p.bgType); }
    private isMarioSlider() { const p = this.grPlane(); return !!p && (p.bgType === 0xC || p.bgType === 0x800C || p.bgType === 0xA00C); }
    private isMarioLeanMirror() { return this.groundActorIs(AT.MIRROR_L); }
    private isMarioClimb(s: number) { return s === ST.BAR_WAIT || s === ST.BAR_HANG || s === ST.BAR_UNK342 || s === ST.BAR_CLIMB; }
    private isMarioSleeping() { const s = this.marioStatus(); return s === ST.SLEEPY || s === ST.SLEEP; }
    private isNotHeightPanCamMode() {
        if (isLButtonMode(this.mMode) || isRailMode(this.mMode)) return true;
        switch (this.mMode) {
            case CM.MARE_UNDER_GROUND: case CM.UNDER_GROUND: case CM.HANG: case CM.HOVERING: case CM.JUMP_CODE: case CM.DIVING: case CM.SWIMMING:
            case CM.LOOK_DOWN: case CM.MONTE_HANG: case CM.TOWER_E: return true;
        }
        return false;
    }
    private isMomentDefinite() {
        return !(this.unk64 & CF.UNK100) && this.isNormalCameraCompletely() && this.unk250 > fr(0.001)
            && lerpF(this.P.mCushionMin, this.P.mCushionMax, this.cur.ratio) > fr(0.001);
    }

    // ------------------------------------------------------------ SimCamera
    /** gpCamera->unk258 */
    yaw() { return this.unk258; }
    offsetAngleY() { return this.getOffsetAngleY(); }
    /** The view the game renders: unk124 (eye), unk148 (look-at), mUp, mFovy (degrees). */
    get pos() { return this.unk124; }
    get at() { return this.unk148; }
    get up() { return this.mUp; }
    get fovy() { return this.mFovy; }
    /** The view as GameCamera wants it (scene.ts): eye, world-from-view rotation, fovy, aspect, near. */
    gameCamera() {
        const e = this.unk124, a = this.unk148, u = this.mUp;
        let fx = a.x - e.x, fy = a.y - e.y, fz = a.z - e.z;
        const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
        // right = forward x up, up' = right x forward; view looks down -Z
        let rx = fy * u.z - fz * u.y, ry = fz * u.x - fx * u.z, rz = fx * u.y - fy * u.x;
        const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
        const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
        // columns: right, up, -forward
        const m00 = rx, m01 = ux, m02 = -fx, m10 = ry, m11 = uy, m12 = -fy, m20 = rz, m21 = uz, m22 = -fz;
        const tr = m00 + m11 + m22;
        let qx, qy, qz, qw;
        if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; qw = 0.25 * s; qx = (m21 - m12) / s; qy = (m02 - m20) / s; qz = (m10 - m01) / s; }
        else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s; }
        else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s; }
        else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s; }
        return { pos: [e.x, e.y, e.z] as [number, number, number], quat: [qx, qy, qz, qw] as [number, number, number, number], fovy: this.mFovy, aspect: this.mAspect, near: this.mNear };
    }

    // ------------------------------------------------------------ setup (loadAfter)
    /** CPolarSubCamera::loadAfter, with Mario where the stage put him. */
    loadAfter(mario: CameraMario, pad?: CameraPad | null) {
        this.mario = mario;
        if (pad) this.pad = pad;
        const w = this.world;
        this.setNoticeInfo();
        this.mInitialMode = CM.FOLLOW;
        if (w.map === 7) this.mInitialMode = CM.DELFINO;
        else if (w.map > 0x14 && w.map < 0x35) this.mInitialMode = CM.EX_MAP_0;
        else if (w.map === 12 && w.stage === 0) this.mInitialMode = CM.MULTI_PLAYER;
        const tool = this.tables.tool('開始カメラ');
        if (tool) this.changeCamModeSpecifyCamMapToolAndFrame_(tool, 1);
        else this.changeCamModeSpecifyFrame_(this.mInitialMode, 1);
        this.P.copySaveParam(this.save[this.mMode]);
        this.mFovy = this.P.mFovy; this.mNear = this.P.mNearClip;
        const tool2 = this.tables.tool('開始後カメラ' + this.marioPosIdx);
        if (tool2) {
            this.cur.ratio = clamp(tool2.pos.y, this.unk268, this.unk26C);
            this.cur.yaw = s16(CLBDegToShortAngle(tool2.yaw) - 0x8000);
        } else {
            this.cur.ratio = clamp(this.ex.mXRotStart, this.unk268, this.unk26C);
            this.cur.yaw = s16(this.marioAngleY() - 0x8000);
        }
        this.unk270 = this.cur.ratio;
        this.cur.pitch = lerpS(this.P.mXAngleMin, this.P.mXAngleMax, this.cur.ratio);
        this.setMarioLookat_();
        if (this.unk70) this.toolPosAndAt(this.unk70, this.mPosition, this.mTarget);
        else {
            vset(this.mTarget, this.cmd.unk0);
            const d = lerpF(this.P.mDistMin, this.P.mDistMax, this.cur.ratio);
            polarToCross(this.mTarget, this.mPosition, d, this.cur.pitch, this.cur.yaw);
        }
        [this.unk294, this.unk298] = this.calcSecureViewTarget_(this.cur.yaw);
        this.mPosition.x = fr(this.mPosition.x + this.unk294); this.mPosition.z = fr(this.mPosition.z + this.unk298);
        this.mTarget.x = fr(this.mTarget.x + this.unk294); this.mTarget.z = fr(this.mTarget.z + this.unk298);
        vset(this.cur.pos, this.mPosition); vset(this.cur.unk18, this.mPosition); vset(this.cur.target, this.mTarget);
        this.unk256 = this.cur.pitch;
        this.unk258 = this.cur.yaw;
        this.prev.copy(this.cur); this.beforeFixed.copy(this.prev);
        vset(this.unk124, this.mPosition); vset(this.unk130, this.mPosition); vset(this.unk13C, this.mPosition);
        vset(this.unk148, this.mTarget); vset(this.unk154, this.mTarget); vset(this.unk160, this.mTarget);
        this.inb.init(this.mPosition, this.mTarget, mario.pos);
        this.calcMatrices();
        this.calcExternalData_();
        // (unk2B0->isFileExist("startcamera"): the stage's /scene/map/camera/startcamera.bck)
        if (!this.bckExists('startcamera') && !this.world.files.scene('map/camera/startcamera.bck')) this.calcInHouseNo_(true);
    }

    // ------------------------------------------------------------ perform (CUE_MOVE)
    /**
     * CPolarSubCamera::perform(CUE_MOVE): once per movement tick, after Mario's perform. tick: bit 1
     * the frame's first tick, bit 2 its last (TGraphics::unk0); default: a lone tick (both).
     */
    update(mario: CameraMario, pad?: CameraPad | null, tick = 3) {
        this.mario = mario;
        if (pad) this.pad = pad;
        if (tick & 1) { vset(this.unk13C, this.unk124); vset(this.unk160, this.unk148); }
        vset(this.mUp, CLBConstUpVec);
        this.unk254 = 0;
        if (this.mMode !== CM.REPRODUCE_DEMO) {
            this.ctrlGameCamera_();
            this.calcFinalPosAndAt_();
            this.calcExternalData_();
            this.calcMatrices();
        }
        const last = (tick & 2) !== 0;
        if (last) {
            if (this.mMode !== CM.REPRODUCE_DEMO && !(this.unk64 & CF.DEAD_DEMO) && (this.unk64 & CF.GATE_DEMO)) this.updateGateDemoCamera_();
            if (this.mMode !== CM.JET_COASTER && this.mMode !== CM.REPRODUCE_DEMO) this.calcInHouseNo_(false);
        }
        this.updateDemoCamera_(last);
    }

    private calcExternalData_() {
        const p = crossToPolar2(this.mTarget, this.mPosition);
        this.unk256 = p.pitch; this.unk258 = p.yaw;
        this.unk25C = vnormalize(vec(fr(this.unk148.x - this.unk124.x), fr(this.unk148.y - this.unk124.y), fr(this.unk148.z - this.unk124.z)));
        this.unk270 = clamp(ratioI(this.P.mXAngleMin, this.P.mXAngleMax, this.unk256), 0, 1);
    }

    private calcFinalPosAndAt_() {
        if (this.mMode !== CM.REPRODUCE_DEMO) {
            // gpCameraShake->execShake: no shakes are simulated
            if (this.mMode !== CM.JET_COASTER && (!isFixMode(this.mMode) || this.isNowInbetween())) {
                if (this.isHellDeadDemo()) {
                    if (this.unk256 > this.ex.mSLLimitMaxAngleX) { this.mTargetFreezeFrames = 1; this.unk64 |= CF.UNK40; }
                } else revisionLookatByAngleX(this.ex.mSLLimitMinAngleX, this.ex.mSLLimitMaxAngleX, this.unk124, this.unk148);
            }
        }
        if (veq(this.unk124, this.unk148)) { vset(this.unk124, this.unk130); vset(this.unk148, this.unk154); }
        else { vset(this.unk130, this.unk124); vset(this.unk154, this.unk148); }
    }

    private setMarioLookat_() {
        const p = vcopy(this.M.pos);
        let y: number;
        if (this.isNormalDeadDemo()) y = 35;
        else {
            y = fr(this.cur.ratio * this.P.mXRotRatioAtOffsetY + this.P.mAtOffsetY);
            if (this.marioStatus() === ST.KICK_ROOF_ROLL_UP) y = fr(y + 260);
            if (this.mMode === CM.DEFINITE_D2) y = fr(y + this.unk290);
        }
        p.y = fr(p.y + y);
        vset(this.cmd.unk0, p);
    }
    /** TCameraMarioData::calcAndSetMarioData */
    private calcAndSetMarioData() {
        const m = this.M, c = this.cmd, s = this.marioStatus();
        if (s === ST.HANGING || s === ST.ASCEND) { c.H = 0; c.V = 0; }
        else {
            const dx = fr(m.pos.x - m.mPrevPosition.x), dy = fr(m.pos.y - m.mPrevPosition.y), dz = fr(m.pos.z - m.mPrevPosition.z);
            c.H = fr(dx * dx + fr(dz * dz)); c.V = fr(dy * dy);
            if (c.H > 100) c.H = 100;
            if (c.V > 100) c.V = 100;
        }
        if (c.lastStatus !== s) { c.lastStatus = s; c.sinceStatus = 0; } else c.sinceStatus++;
        const nz = this.nozzle();
        const min = nz ? s16(nz.mLAngleMin ?? nz.params?.mLAngleMin ?? 0) : 0;
        const ang = nz && nz.getGunAngle ? s16(nz.getGunAngle()) : 0;
        c.unk1C = clamp(ratioI(0, min, ang), 0, 1);
    }

    private getUsualLookat(): Vec { return vcopy(this.demo.offset || this.cmd.unk0); }

    private ctrlGameCamera_() {
        if (!(this.unk64 & CF.DEAD_DEMO)) this.execDeadDemoProc_();
        if (!(this.unk64 & CF.UNK80) && this.unk284 > 0) this.unk284 -= 1;
        if (this.unk278 !== 0) this.unk278 -= 1;
        if (this.unk27A !== 0) this.unk27A -= 1;
        if (this.unk282 !== 0) this.unk282 -= 1;
        this.setMarioLookat_();
        this.calcAndSetMarioData();
        this.prev.copy(this.cur);
        if (this.directorState === 4 && !(this.unk64 & CF.DEAD_DEMO)) {
            if (isTalkMode(this.mMode)) { if (!this.talkModeNow) this.changeCamMode_(this.mInitialMode); }
            else if (!this.isSimpleDemoCamera()) {
                const code = this.controlByCameraCode_();
                if (code !== null) this.execCameraModeChangeProc_(code);
            }
        }
        const param = new KindParam().copySaveParam(this.save[this.mMode]);
        if (this.isNowInbetween()) this.P.inbetweenData(param, fr(this.inb.frames));
        else this.P.copy(param);
        if (this.unk284 > this.P.mAutoChaseCompleteFrame) this.unk284 = this.P.mAutoChaseCompleteFrame;
        if (!this.isNormalDeadDemo() && !(this.unk64 & (CF.JET_COASTER_SCENE | CF.GATE_DEMO))) this.mFovy = this.P.mFovy;
        this.mNear = this.P.mNearClip; this.mFar = 300000;
        if (this.isNormalDeadDemo()) this.ctrlNormalDeadDemo_();
        else if (this.mMode === CM.MULTI_PLAYER || this.mMode === CM.JET_COASTER) this.calcPosAndAt_();   // (not simulated: their own controls)
        else if (isFixOrDefinite(this.mMode)) this.calcPosAndAt_();
        else if (isLButtonMode(this.mMode)) this.ctrlLButtonCamera_();
        else if (isTalkMode(this.mMode)) this.ctrlTalkCamera_();
        else this.ctrlNormalOrTowerCamera_();
        vset(this.unk124, this.mPosition); vset(this.unk148, this.mTarget);
    }

    // ------------------------------------------------------------ CameraNormal.cpp
    private rotateX_ByStickY_(v: number) {
        if (this.openingDoor()) return;
        this.cur.ratio = fr(this.cur.ratio - v * this.P.mXRotRatioManualSpeed);
        this.cur.ratio = isLButtonMode(this.mMode) ? clamp(this.cur.ratio, 0, 1) : clamp(this.cur.ratio, this.unk268, this.unk26C);
    }
    private rotateY_ByStickX_(v: number) {
        if (this.openingDoor()) return;
        const sp = lerpS(this.P.mYAngleManualSpeedXMin, this.P.mYAngleManualSpeedXMax, this.cur.ratio);
        this.cur.yaw = s16(this.cur.yaw + Math.trunc(fr(v * sp)));
    }
    private execInvalidAutoChase_() { this.unk284 = this.P.mAutoChaseCompleteFrame; }
    private calcTowerCenterPos_(): Vec {
        const names: Record<number, string> = { [CM.TOWER_A]: '塔カメラＡ中心', [CM.TOWER_B]: '塔カメラＢ中心', [CM.TOWER_C]: '塔カメラＣ中心', [CM.TOWER_D]: '塔カメラＤ中心', [CM.TOWER_E]: '塔カメラＥ中心' };
        const n = names[this.mMode];
        const p = n ? this.tables.positions.get(n) : undefined;
        return p ? vcopy(p) : vec();
    }

    private ctrlNormalOrTowerCamera_() {
        const C = this.pad.mCompSPos;
        const sx = C[6], sy = C[7];
        this.unk250 = 0;
        if (this.mTargetFreezeFrames === 0) vset(this.cur.target, this.cmd.unk0);
        if (this.mPosFreezeFrames === 0) {
            if (this.unk64 & CF.UNK4) {
                const [v, more] = chaseAngleDecrease(this.cur.yaw, this.unk274, this.unk276);
                this.cur.yaw = v;
                if (!more) {
                    this.unk64 &= ~CF.UNK4;
                    if (this.unk64 & CF.UNK8) { this.unk64 &= ~CF.UNK8; this.unk64 |= CF.UNK10; }
                }
            } else if (isTowerMode(this.mMode)) {
                if (sx !== 0) { this.rotateY_ByStickX_(sx); this.execInvalidAutoChase_(); this.unk64 |= CF.UNK80; }
                else if (!(this.unk64 & CF.UNK80) && !this.isMarioCrabWalk()) this.calcNoticeTargetYrot_(this.calcTowerCenterPos_());
            } else if (sx !== 0) { this.rotateY_ByStickX_(sx); this.execInvalidAutoChase_(); }
            else if (this.mMode === CM.BOSS_GESO) {
                if (this.isChangeToBossGesoCamera_() && this.unk2A8) this.calcNoticeTargetYrot_(this.unk2A8.pos);
            } else if (this.mMode === CM.CANCAN) {
                const h = this.M.mHeldObject;
                if (this.isChangeToCancanCamera_() && h) this.calcNoticeTargetYrot_(h.getHostPos ? h.getHostPos() : h.pos);
            } else {
                this.unk250 = !this.touchGround4cm()
                    ? lerpF(this.P.mJumpFollowSpeedXmin, this.P.mJumpFollowSpeedXmax, this.cur.ratio)
                    : lerpF(this.P.mFollowSpeedXmin, this.P.mFollowSpeedXmax, this.cur.ratio);
                if (this.isMomentDefinite()) {
                    this.cur.yaw = matan(fr(this.prev.pos.z - this.cur.target.z), fr(this.prev.pos.x - this.cur.target.x));
                } else if (!(this.unk64 & CF.UNK80) && !this.isMarioCrabWalk()) {
                    if (this.isMarioAimWithGun() && !this.isChangeToParallelCameraByMoveBG_() && !this.isChangeToParallelCameraCByMoveBG_()) {
                        if (this.unk288 !== 0) {
                            const t = easeInF(0, 1, this.cur.ratio);
                            const sp = easeInS(this.ex.mSLAimAngleYChaseMin, this.ex.mSLAimAngleYChaseMax, t);
                            this.cur.yaw = chaseAngleDecrease(this.cur.yaw, s16(this.marioAngleY() - 0x8000), sp)[0];
                        }
                    } else {
                        const a = s16(this.marioAngleY() - 0x8000);
                        let f30: number;
                        if (this.mMode === CM.DIVING || this.mMode === CM.HOVERING) f30 = fr(fr(2 / 65536) * Math.abs(s16(a - this.unk258)));
                        else f30 = fr(0.5 * fr(1 - JMASCos((a - this.unk258) * 2)));
                        let f29 = 1;
                        if (this.unk2CA !== -1) f29 = lerpF(this.P.mInHouseMaginfXmin, this.P.mInHouseMaginfXmax, this.cur.ratio);
                        else if (this.marioFlag(MF.OCCLUDED)) f29 = lerpF(this.P.mObstructMaginfXmin, this.P.mObstructMaginfXmax, this.cur.ratio);
                        if (Math.trunc(C[2]) & 0xFF) f29 = fr(f29 * lerpF(this.P.mLFollowMaginfXmin, this.P.mLFollowMaginfXmax, this.cur.ratio));
                        const f4 = this.mMode === CM.DIVING || this.mMode === CM.HOVERING ? 100 : this.cmd.H;
                        let k = fr(this.unk288 * fr(f4 * fr(f29 * fr(this.unk250 * f30))));
                        if (k > fr(32766.998)) k = fr(32766.998);
                        this.cur.yaw = chaseSpeedS(this.cur.yaw, a, CLBRoundfS16(k))[0];
                    }
                }
            }
            this.rotateX_ByStickY_(sy);
        }
        this.calcPosAndAt_();
    }

    // ------------------------------------------------------------ calcPosAndAt_ (cameragc.cpp)
    private calcSlopeAngleX_(x: number): number {
        let result = 0;
        if (!this.isMarioReadyGun()) {
            const plane = this.grPlane();
            const groundOK = !!plane && (plane.bgType & 0xA000) !== 0;
            if (groundOK && SLOPE.has(this.mMode)) {
                const mp = this.M.pos;
                const diff = vec(fr(mp.x - this.mPosition.x), 0, fr(mp.z - this.mPosition.z));
                const l2 = fr(fr(fr(diff.x * diff.x) + fr(diff.y * diff.y)) + fr(diff.z * diff.z));
                if (!(l2 <= fr(3.814697265625e-06))) {
                    const grLevel = this.M.mFloorPosition.y;
                    const fwd = this.ex.mSLSlopeForwardDistXZ, maxAng = this.ex.mSLSlopeMaxAngleX;
                    const n = msVecNormalize(diff, vec());
                    n.x = fr(n.x * fwd); n.y = fr(n.y * fwd); n.z = fr(n.z * fwd);
                    const smp = vec(fr(mp.x + n.x), fr(mp.y + n.y), fr(mp.z + n.z));
                    const tan = fr(JMASSin(maxAng) * fr(1 / JMASCos(maxAng)));
                    const y = fr(fr(fwd * tan + 10) + mp.y);
                    const h = fr(this.world.col.checkGround(smp.x, y, smp.z, 1)[0] - grLevel);
                    let angle = 0;
                    if (h > 0) angle = matan(fwd, h);
                    result = angle > maxAng ? 0 : angle;
                }
            }
        }
        this.unk28C = chaseSpeedS(this.unk28C, result, this.ex.mSLSlopeSpeedAngleX)[0];
        x = s16(x - this.unk28C);
        const mx = this.ex.mSLLimitMaxAngleX, mn = this.ex.mSLLimitMinAngleX;
        return x > mx ? mx : x < mn ? mn : x;
    }

    /** execSecureView_'s inlined calcSecureViewTarget_ rounds the sum the other way round */
    private execSecureView_(angle: number, out: Vec) {
        const base = s16(this.marioAngleY() - 0x8000), diff = s16(angle - base);
        const first = lerpF(this.P.mSecureViewDistXMin, this.P.mSecureViewDistXMax, this.cur.ratio);
        const cd = JMASCos(diff);
        const second = cd >= 0 ? 0 : lerpF(this.P.mSecureViewDistZMin, this.P.mSecureViewDistZMax, this.cur.ratio);
        const sum = fr(first * JMASSin(diff) + fr(second * cd));
        const mag = -Math.abs(sum);
        const px = fr(mag * JMASSin(base)), pz = fr(mag * JMASCos(base));
        const d = s16(Math.abs(this.marioAngleY() - s16(this.M.unk9C || 0)));
        const ratio = fr(fr(0.0054931640625) * d);
        const inv = ratio <= 1 ? 1 : fr(1 / ratio);
        const v = clamp(fr(this.P.mSecureViewChase * inv), 0, 1);
        this.unk294 = chaseDecrease(this.unk294, px, v)[0];
        this.unk298 = chaseDecrease(this.unk298, pz, v)[0];
        out.x = fr(out.x + this.unk294); out.z = fr(out.z + this.unk298);
    }
    private calcSecureViewTarget_(angle: number): [number, number] {
        const base = s16(this.marioAngleY() - 0x8000), diff = s16(angle - base);
        const first = lerpF(this.P.mSecureViewDistXMin, this.P.mSecureViewDistXMax, this.cur.ratio);
        const cd = JMASCos(diff);
        const second = cd >= 0 ? 0 : lerpF(this.P.mSecureViewDistZMin, this.P.mSecureViewDistZMax, this.cur.ratio);
        const mag = -Math.abs(fr(second * cd + fr(first * JMASSin(diff))));
        return [fr(mag * JMASSin(base)), fr(mag * JMASCos(base))];
    }

    private calcPosAndAt_() {
        const P = this.P, cur = this.cur, cmd = this.cmd, ex = this.ex, M = this.M;
        if (cmd.H >= fr(0.05)) this.unk64 &= ~CF.UNK80;
        if (!(this.unk64 & CF.UNK80)) {
            if (this.unk284 > 0) {
                const acf = P.mAutoChaseCompleteFrame, acs = P.mAutoChaseStartFrame, d = acf - this.unk284 + 1;
                this.unk288 = d <= acs ? 0 : ratioI(acs, acf, d);
            } else this.unk288 = 1;
        }
        let holdAngleX = 0, holdDist = 0;
        const holdAngleXMax = lerpS(P.mHoldOffsetAngleXMin, P.mHoldOffsetAngleXMax, cur.ratio);
        const holdDistMax = lerpF(P.mHoldAddDistXZMin, P.mHoldAddDistXZMax, cur.ratio);
        if (isNormalMode(this.mMode) && this.isMarioReadyGun()) {
            const mag = cmd.unk1C;
            holdDist = fr(mag * holdDistMax);
            holdAngleX = Math.trunc(fr(mag * holdAngleXMax));
        }
        const h = this.hold;
        h.unk0 = chaseAngleDecrease(h.unk0, holdAngleX, ex.mSLHoldAngleXChase)[0];
        h.unk4 = chaseDecrease(h.unk4, holdDist, ex.mSLHoldDistChase)[0];
        if (holdDistMax < fr(0.001)) {
            if (holdAngleXMax !== 0) h.unkC = clamp(fr(Math.abs(s16(holdAngleX)) * fr(1 / Math.abs(holdAngleXMax))), 0, 1);
        } else h.unkC = clamp(fr(holdDist * fr(1 / holdDistMax)), 0, 1);
        h.unk8 = chaseDecrease(h.unk8, h.unkC, ex.mSLHoldDistChase)[0];

        this.unk64 &= ~CF.UNK100;
        if (this.mPosFreezeFrames !== 0) this.mPosFreezeFrames -= 1;
        if (this.mTargetFreezeFrames !== 0) this.mTargetFreezeFrames -= 1;
        const moving = cmd.H >= fr(0.05) || cmd.V >= fr(0.05);
        let inputActive = true;
        if (!this.isMarioReadyGun() && !(this.unk64 & CF.UNK4)) {
            const C = this.pad.mCompSPos;
            if (!(C[6] !== 0 || C[7] !== 0)) inputActive = false;
        }
        if (this.unk64 & CF.UNK40) {
            if (this.mPosFreezeFrames === 0) this.mPosFreezeFrames = 1;
            if (this.mTargetFreezeFrames === 0) this.mTargetFreezeFrames = 1;
        } else {
            if (moving || inputActive) { this.mTargetFreezeFrames = 0; this.mPosFreezeFrames = 0; }
            if ((this.unk64 & CF.DEAD_DEMO) && this.mPosFreezeFrames === 0) this.mPosFreezeFrames = 1;
        }

        if (this.mPosFreezeFrames === 0 || this.mTargetFreezeFrames === 0) {
            if (this.mPosFreezeFrames === 0 && this.mTargetFreezeFrames === 0) this.unk64 &= ~CF.UNK40;
            if (!this.inb.isThing() || moving || inputActive) {
                if (this.mTargetFreezeFrames === 0 && isDefiniteMode(this.mMode)) vset(cur.target, this.getUsualLookat());
                let finalAt: Vec;
                if (isFixOrDefinite(this.mMode)) { finalAt = vcopy(cur.target); this.unk28C = 0; }
                else {
                    cur.pitch = lerpS(P.mXAngleMin, P.mXAngleMax, cur.ratio);
                    let xAngle = s16(cur.pitch + P.mOffsetAngleX + h.unk0);
                    let yAngle = s16(cur.yaw + P.mOffsetAngleY);
                    if (cmd.H >= fr(0.05)) {
                        const mA = s16(this.marioAngleY() - 0x8000);
                        let m = fr(fr(P.mMaxAddAngleY) * fr(0.5 * fr(1 - JMASCos(s16(mA - this.unk258) * 2))));
                        m = clamp(m, fr(-32766.998), fr(32766.998));
                        if (s16(mA - yAngle) < 0) m = -m;
                        this.unk28E = chaseSpeedS(this.unk28E, CLBRoundfS16(m), ex.mSLAddAngleYSpeed)[0];
                    }
                    yAngle = s16(yAngle + this.unk28E);
                    xAngle = this.calcSlopeAngleX_(xAngle);
                    if (this.mMode === CM.TOWER_E) {
                        if (this.isMarioRocketing()) xAngle = s16(ex.mSLLimitMaxAngleX - 0x1770);
                        else if (this.marioStatus() === ST.HIP_DROP) xAngle = 0x3E8;
                    }
                    finalAt = vec(fr(cur.target.x - P.mOffsetLookatXZ * JMASSin(yAngle - 0x4000)), cur.target.y,
                        fr(cur.target.z - P.mOffsetLookatXZ * JMASCos(yAngle - 0x4000)));
                    if (this.mMode !== CM.MULTI_PLAYER) {
                        this.execSecureView_(yAngle, finalAt);
                        if (!isRailMode(this.mMode)) {
                            const saveAt = vcopy(finalAt);
                            const dist = lerpF(P.mDistMin, P.mDistMax, cur.ratio);
                            const cushion = JMASCos(lerpS(P.mXAngleMin, P.mXAngleMax, cur.ratio));
                            const newPos = polarToCross(saveAt, vec(), fr(dist + this.inb.unk44), xAngle, yAngle);
                            if (this.isNormalCameraCompletely()) {
                                const base = vcopy(this.prev.pos); base.y = this.prev.unk18.y;
                                let n = crossToPolar(saveAt, base);
                                const cushDist = fr(cushion * n.r);
                                if (cushDist > fr(cushion * dist)) { this.unk64 |= CF.UNK100; vset(cur.unk18, newPos); }
                                else {
                                    let minDist = fr(cushion * fr(dist - lerpF(P.mCushionMin, P.mCushionMax, cur.ratio)));
                                    if (minDist < ex.mSLMinCushionXZ) minDist = ex.mSLMinCushionXZ;
                                    if (this.notUnderGround() && cushDist < minDist) {
                                        const d = fr(minDist - cushDist);
                                        base.x = fr(d * JMASSin(n.yaw) + base.x);
                                        base.z = fr(d * JMASCos(n.yaw) + base.z);
                                        n = crossToPolar(saveAt, base);
                                    }
                                    if (this.isMomentDefinite()) vset(cur.unk18, base);
                                    else polarToCross(saveAt, cur.unk18, n.r, n.pitch, yAngle);
                                    cur.unk18.y = newPos.y;
                                }
                            } else vset(cur.unk18, newPos);
                            const sY = JMASSin(yAngle), cY = JMASCos(yAngle);
                            if (this.notUnderGround()) {
                                const dx = fr(M.pos.x - cur.unk18.x), dz = fr(M.pos.z - cur.unk18.z);
                                const d = MsSqrtf(fr(dx * dx + fr(dz * dz)));
                                let minD = ex.mSLMinCushionXZ;
                                const dc = fr(dist * cushion);
                                if (minD >= dc) minD = dc;
                                if (d < minD) {
                                    const add = fr(minD - d);
                                    cur.unk18.x = fr(sY * add + cur.unk18.x);
                                    cur.unk18.z = fr(cY * add + cur.unk18.z);
                                }
                            }
                            if (this.mMode !== CM.UNDER_GROUND && this.mMode !== CM.MARE_UNDER_GROUND) {
                                cur.unk18.x = fr(cur.unk18.x - h.unk4 * sY);
                                cur.unk18.z = fr(cur.unk18.z - h.unk4 * cY);
                            }
                            if (this.inb.isThing() && inputActive) {
                                const d = lerpF(P.mDistMin, P.mDistMax, cur.ratio);
                                const wp = polarToCross(this.inb.at, vec(), fr(d + this.inb.unk44), xAngle, yAngle);
                                this.inb.warpPosAndAt(wp, vcopy(this.inb.at));
                            }
                        }
                    }
                    cur.pos.x = cur.unk18.x; cur.pos.z = cur.unk18.z;
                    this.execHeightPan_();
                    finalAt.y = cur.target.y;
                    const posCpy = vcopy(cur.pos);
                    if (this.isNeedWallCheck_() && this.execWallCheck_(posCpy)) {
                        const p = crossToPolar2(cur.target, cur.pos);
                        cur.pitch = p.pitch; cur.yaw = p.yaw;
                        cur.ratio = this.prev.ratio;
                    }
                    if (this.isNeedRoofCheck_()) this.execRoofCheck_(vcopy(posCpy));
                    if (this.isNeedGroundCheck_()) this.execGroundCheck_(vcopy(posCpy));
                }
                this.inb.exec(cur.pos, vcopy(finalAt), M.pos);
            }
        }

        if (this.mPosFreezeFrames === 0) {
            let cXZ: number, cY: number;
            if (isRailMode(this.mPrevMode) && isRailMode(this.mMode) && this.isNowInbetween()) { cXZ = 1; cY = 1; }
            else {
                cXZ = P.mPosChaseRateXZ; cY = P.mPosChaseRateY;
                if (this.mMode === CM.TOWER_E && this.marioStatus() === ST.HIP_DROP) {
                    const v = cmd.sinceStatus >>> 0;
                    if (v < 120) cY = lerpF(P.mPosChaseRateY, 0, fr(fr(120 - v) / 120));
                }
                const SS = this.pad.mSubStick;
                if (this.unk64 & CF.UNK4) cXZ = 1;
                else if (SS.mPosY !== 0 || SS.mPosX !== 0) {
                    const v = cmd.H > 20 ? 20 : cmd.H;
                    cXZ = easeInF(P.mPosChaseRateXZ, P.mPosChaseRateXZ_C, ratioF(20, 0, v));
                }
                if (SS.mPosY !== 0) {
                    const v = cmd.V > 20 ? 20 : cmd.V;
                    cY = easeInF(P.mPosChaseRateY, P.mPosChaseRateY_C, ratioF(20, 0, v));
                }
            }
            const v = this.inb.pos;
            this.mPosition.x = chaseDecrease(this.mPosition.x, v.x, cXZ)[0];
            this.mPosition.y = chaseDecrease(this.mPosition.y, v.y, cY)[0];
            this.mPosition.z = chaseDecrease(this.mPosition.z, v.z, cXZ)[0];
        }
        if (this.mTargetFreezeFrames === 0) {
            const aXZ = P.mAtChaseRateXZ, aY = P.mAtChaseRateY, v = this.inb.at;
            this.mTarget.x = chaseDecrease(this.mTarget.x, v.x, aXZ)[0];
            this.mTarget.y = chaseDecrease(this.mTarget.y, v.y, aY)[0];
            this.mTarget.z = chaseDecrease(this.mTarget.z, v.z, aXZ)[0];
        }
    }

    // ------------------------------------------------------------ CameraHeightPan.cpp
    private killHeightPanWhenChangeCamMode_() {
        if (this.isNotHeightPanCamMode() || this.mPrevMode === CM.MONTE_HANG || this.mPrevMode === CM.HANG) this.killHeightPan_();
    }
    private killHeightPan_() {
        this.unk64 &= ~(CF.UNK1 | CF.UNK2);
        this.cur.pos.y = this.cur.unk18.y;
        this.mHeightPanOffset = 0;
    }
    private execHeightPan_() {
        const cur = this.cur, prev = this.prev, P = this.P;
        const airborne = !this.touchGround4cm();
        const off = airborne ? P.mTargetAtJumpOffsetY : 0;
        this.mHeightPanOffset = chaseSpeedF(this.mHeightPanOffset, off, P.mAtJumpOffsetSpeed)[0];
        cur.target.y = fr(cur.target.y + this.mHeightPanOffset);
        const dY = fr(cur.unk18.y - prev.unk18.y);
        const pan = !this.isNotHeightPanCamMode() && !this.touchGround4cm() && !this.isMarioGoDown() && !this.onWire()
            && this.marioStatus() !== ST.KICK_ROOF_ROLL_UP;
        if (pan) {
            this.unk64 |= CF.UNK1; this.unk64 &= ~CF.UNK2;
            cur.pos.y = prev.pos.y;
            cur.pos.y = chaseDecrease(cur.pos.y, cur.unk18.y, P.mHeightPanChaseRateY)[0];
            if (cur.ratio !== prev.ratio) cur.pos.y = fr(cur.pos.y + dY);
        } else if (this.unk64 & (CF.UNK1 | CF.UNK2)) {
            if (cur.ratio !== prev.ratio) cur.pos.y = fr(cur.pos.y + dY);
            if (this.unk64 & CF.UNK1) {
                this.unk64 &= ~CF.UNK1;
                const warp = (this.mMode === CM.JUMP_CODE || this.mMode === CM.ROCKET_JUMP) && this.unk256 < this.ex.mPanWarpAngleX;
                if (warp) { this.mPosition.y = cur.pos.y = cur.unk18.y; this.unk64 &= ~CF.UNK2; }
                else this.unk64 |= CF.UNK2;
            }
            if (cur.pos.y !== cur.unk18.y) {
                const [v, more] = chaseSpecialDecrease(cur.pos.y, cur.unk18.y, this.ex.mPanAfterMagnif, this.ex.mPanAfterMinHeight);
                cur.pos.y = v;
                if (!more && !airborne) this.unk64 &= ~CF.UNK2;
            } else if (!airborne) this.unk64 &= ~CF.UNK2;
        } else cur.pos.y = cur.unk18.y;
    }

    // ------------------------------------------------------------ CameraBGCheck.cpp
    private isNeedGroundCheck_() {
        const m = this.mMode;
        if (m === CM.REPRODUCE_DEMO || (isLButtonMode(m) && !this.isNowInbetween()) || isRailMode(m) || m === CM.MULTI_PLAYER || this.unk278 !== 0) return false;
        if (m !== CM.SLIDER && (isNormalMode(m) || isTowerMode(m))) {
            const a = fr(this.P.mDistMin * JMASSin(this.P.mXAngleMin));
            let b = fr(this.P.mDistMax * JMASSin(this.P.mXAngleMax));
            const dY = fr(this.mPosition.y - this.mTarget.y);
            if (a > b) b = a;
            if (dY > fr(1.25 * b)) { if (this.unk278 < 120) this.unk278 = 120; return false; }
        }
        return true;
    }
    private isNeedRoofCheck_() {
        const m = this.mMode;
        return !(m === CM.REPRODUCE_DEMO || (isLButtonMode(m) && !this.isNowInbetween()) || isRailMode(m) || m === CM.MULTI_PLAYER || this.unk27A !== 0);
    }
    private isNeedWallCheck_() {
        const m = this.mMode;
        return !(m === CM.REPRODUCE_DEMO || isLButtonMode(m) || this.isLButtonCameraInbetween() || isTalkMode(m) || this.isTalkCameraInbetween()
            || isRailMode(m) || m === CM.MULTI_PLAYER || m === CM.UNDER_GROUND || (this.unk64 & CF.UNK4));
    }
    /** should_clip: a legal plane the camera collides with (BG flag 0x8000) */
    private static clips(d: BGCheckData | null) { return !!d && d.isLegal() && (d.bgType & 0x8000) !== 0; }
    private execWallCheck_(out: Vec) {
        let moved = false;
        const radius = this.ex.mSLWallCheckRadius;
        if (radius > 0) {
            const cur = this.cur;
            const r: WallCheck = { center: [cur.pos.x, fr(this.prev.pos.y + 10), cur.pos.z], radius, maxResults: 4, flags: 0, results: [] };
            if (this.world.col.checkWalls(r) !== 0) {
                for (const wall of r.results) {
                    if (!PolarSubCamera.clips(wall)) continue;
                    const posArg = vcopy(cur.pos), posCam = vcopy(posArg);
                    const [nx, ny, nz] = wall.n;
                    const sd = fr(wall.d + fr(posCam.z * nz + fr(posCam.x * nx + fr(posCam.y * ny))));
                    if (Math.abs(sd) < radius) {
                        moved = true;
                        const push = fr(radius - sd);
                        const pushSd = fr(push * this.ex.mSLWallRevisionRatio);
                        posCam.x = fr(pushSd * nx + posCam.x); posCam.z = fr(pushSd * nz + posCam.z);
                        cur.pos.x = posCam.x; cur.pos.z = posCam.z;
                        posArg.x = fr(push * nx + posArg.x); posArg.z = fr(push * nz + posArg.z);
                        out.x = posArg.x; out.z = posArg.z;
                    }
                }
            }
        }
        return moved;
    }
    /** SMS_GetMonteVillageAreaInMario (gpCubeFastC's cube with Mario in it: TMario::thinkCube) */
    private monteVillageArea() {
        if (this.world.map !== 8) return 4;
        if (this.mMode === CM.LOOK_DOWN) return 1;
        const p = this.M.pos;
        const i = this.tables.fastC.getInCubeNo(vec(p.x, fr(p.y + 75), p.z));
        return i === 0 ? 2 : i === 1 ? 0 : 3;
    }
    private execRoofCheck_(p: Vec) {
        let moved = false, skip = false, roof: BGCheckData | null = null, roofH = 0;
        if (this.monteVillageArea() === 0 && this.mMode !== CM.MONTE_HANG) { roofH = -512.5; skip = true; }
        else [roofH, roof] = this.world.col.checkRoof(p.x, fr(this.prev.pos.y - this.ex.mSLRoofChangeY), p.z, 0);
        if (skip || PolarSubCamera.clips(roof)) {
            const lim = fr(roofH - this.ex.mSLRoofHeight);
            if (this.cur.pos.y > lim) { this.cur.pos.y = lim; moved = true; }
        }
        return moved;
    }
    private execGroundCheck_(p: Vec) {
        let moved = false;
        let chg = this.ex.mGroundChangeY;
        let off = lerpF(this.ex.mSLGroundHeightNormal, this.ex.mSLGroundHeightReadyGun, this.hold.unk8);
        if (this.mMode === CM.SLIDER) { chg = chg > 200 ? chg : 200; off = off > 400 ? off : 400; }
        const [gy, g] = this.world.col.checkGround(p.x, fr(this.prev.pos.y + chg), p.z, 1);
        if (PolarSubCamera.clips(g)) {
            const lim = fr(gy + off);
            if (this.cur.pos.y < lim) { this.cur.pos.y = lim; moved = true; }
        }
        return moved;
    }
    private calcInHouseNoSub_() {
        if (this.unk2CA !== -1) {
            this.unk2C8 = this.unk2CA;
            if (this.unk2CC < this.ex.mInHouseMinFrame) this.unk2CC = (this.unk2CC + 1) & 0xFF;
        } else if (this.unk2C8 !== -1) {
            if (this.unk2CC < this.ex.mInHouseMinFrame) this.unk2CC = (this.unk2CC + 1) & 0xFF;
            else { this.unk2C8 = -1; this.unk2CC = 0; }
        }
    }
    /**
     * calcInHouseNo_: the house (an OOB plane's data) the near plane is in, from nine points on it
     * and nine a little beyond. (CLBCalcNearNinePos is ported as its maths, not instruction for
     * instruction: a point within ~1e-4 of a house's edge may land differently.)
     */
    private calcInHouseNo_(force: boolean) {
        if (!force && veq(this.unk13C, this.unk124) && veq(this.unk160, this.unk148)) { this.calcInHouseNoSub_(); return; }
        if (this.isThing3()) { this.unk2CA = -1; this.calcInHouseNoSub_(); return; }
        const half = CLBRoundfS16(fr(fr(65536 / 360) * fr(0.5 * this.mFovy)));
        const tan = fr(JMASSin(half) * fr(1 / JMASCos(half)));
        const ny = fr(2 * fr(this.mNear * tan)), nx = fr(ny * this.mAspect);
        const pts = nearNinePos(this.unk124, this.unk148, this.getFinalAngleZ(), this.mNear, nx, ny);
        for (let i = 0; i < 9; i++) pts.push(vec(fr(this.unk25C.x * this.unk2C4 + pts[i].x), fr(this.unk25C.y * this.unk2C4 + pts[i].y), fr(this.unk25C.z * this.unk2C4 + pts[i].z)));
        for (let i = 0; i < 9; i++) for (let j = 0; j < 2; j++) {
            let dy = 0;
            for (let k = 0; k < 2; k++) {
                const p = pts[j * 9 + i];
                const [, g] = this.world.col.checkGround(p.x, fr(fr(p.y - dy) + -78), p.z, 1);
                if (g && g.bgType === 0x600) { this.unk2CA = s16(g.data); this.calcInHouseNoSub_(); return; }
                dy = fr(dy + this.unk2C0);
            }
        }
        this.unk2CA = -1;
        this.calcInHouseNoSub_();
    }

    // ------------------------------------------------------------ CameraNotice.cpp
    /** setNoticeInfo: the lock-on targets (the managers' actors), the boss Gesso */
    private setNoticeInfo() {
        this.noticeActors = [];
        for (const n of ['ヒノクリマネージャー', 'ヒノクリ２マネージャー', 'ボスパックンマネージャー']) {
            const m = this.world.conductor.getManagerByName(n) as any;
            if (m) for (let j = 0; j < m.getObjNum(); j++) this.noticeActors.push(m.getObj(j));
        }
        this.unk2A8 = null;
    }
    private inClip(p: Vec, ratio: number) {
        const c = calc2DFPos(this.proj, this.view, p);
        const mx = ratio, mn = -mx;
        return mn <= c[0] && c[0] <= mx && mn <= c[1] && c[1] <= mx;
    }
    private getNoticeActor_(): any {
        const N = this.notice, mp = this.M.pos;
        const sq = (a: Vec) => fr(fr(fr(fr(a.x - mp.x) * fr(a.x - mp.x)) + fr(fr(a.y - mp.y) * fr(a.y - mp.y))) + fr(fr(a.z - mp.z) * fr(a.z - mp.z)));
        const na = this.mNoticeActor;
        if (na && !(na.liveFlag & LF.DEAD) && !(na.liveFlag & LF.HIDDEN)) {
            if (sq(na.pos) < fr(N.mOffDist * N.mOffDist) && this.inClip(na.pos, N.mOffClipRatio)) return na;
        }
        let best: any = null, bestD = fr(N.mOnDist * N.mOnDist);
        for (const a of this.noticeActors) {
            if ((a.liveFlag & LF.DEAD) || (a.liveFlag & LF.HIDDEN)) continue;
            if (na && a === na) continue;
            const d2 = sq(a.pos);
            if (d2 >= bestD) continue;
            if (!this.inClip(a.pos, N.mOnClipRatio)) continue;
            // MsIsInSight(Mario, his facing in degrees, target, sqrt-free length d2, mOnDegree, -1)
            const dx = a.pos.x - mp.x, dz = a.pos.z - mp.z;
            const ang = Math.atan2(dx, dz) * 180 / Math.PI, face = this.marioAngleY() * (360 / 65536);
            let diff = ang - face; while (diff > 180) diff -= 360; while (diff < -180) diff += 360;
            if (!(Math.abs(diff) < N.mOnDegree * 0.5)) continue;
            bestD = d2; best = a;
        }
        return best;
    }
    private execNoticeOnOffProc_(mode: number) {
        if (mode === 0) { this.mNoticeActor = null; this.unk64 &= ~CF.NOTICE_ACTIVE; }
        else if (mode === 1) { const a = this.getNoticeActor_(); if (a !== this.mNoticeActor && a === null) { this.mNoticeActor = null; this.unk64 &= ~CF.NOTICE_ACTIVE; } }
        else if (mode === 2) { const a = this.getNoticeActor_(); if (a !== this.mNoticeActor && a !== null) { this.mNoticeActor = a; this.unk64 |= CF.NOTICE_ACTIVE; } }
    }
    private calcNoticeTargetYrot_(t: Vec) {
        const m = this.cmd.unk0, N = this.notice;
        const dist2 = fr(fr(fr(m.x - t.x) * fr(m.x - t.x)) + fr(fr(m.z - t.z) * fr(m.z - t.z)));
        const near2 = fr(N.mRotateMinDistXZ * N.mRotateMinDistXZ), far2 = fr(N.mRotateFastMinDistXZ * N.mRotateFastMinDistXZ);
        if (dist2 > near2) {
            const d = msVecNormalize(vec(fr(m.x - t.x), fr(m.y - t.y), fr(m.z - t.z)), vec());
            const dx = fr(d.x * 500 + m.x), dz = fr(d.z * 500 + m.z);
            const ang = matan(fr(dz - this.cur.target.z), fr(dx - this.cur.target.x));
            const ratio = fr(fr(2 / 65536) * Math.abs(s16(this.cur.yaw - ang)));
            const chase = dist2 > far2 ? 1 : ratioF(near2, far2, dist2);
            const base = lerpF(1, N.mRotateMagnifXmax, this.cur.ratio);
            let sp = fr(this.unk288 * fr(chase * fr(ratio * fr(fr(N.mRotateYSpeed) * base))));
            if (sp > fr(32766.998)) sp = fr(32766.998);
            this.cur.yaw = chaseSpeedS(this.cur.yaw, ang, CLBRoundfS16(sp))[0];
        }
    }
    private getNozzleTopPos_(out: Vec) {
        const g = this.M.mWaterGun, m = g && g.getNozzleMtx ? g.getNozzleMtx() : null;
        if (!m) { vset(out, this.cmd.unk0); return; }
        out.x = m[3]; out.y = m[7]; out.z = m[11];
        const d = vnormalize(vec(m[1], m[5], m[9]));
        out.x = fr(out.x + fr(d.x * 30)); out.y = fr(out.y + fr(d.y * 30)); out.z = fr(out.z + fr(d.z * 30));
    }
    private ctrlLButtonCamera_() {
        const C = this.pad.mCompSPos;
        const sx = -C[4], sy = -C[5];
        if (this.mTargetFreezeFrames === 0) {
            if (!this.marioFlag(MF.HAS_FLUDD)) vset(this.cur.target, this.cmd.unk0);
            else this.getNozzleTopPos_(this.cur.target);
        }
        if (this.mPosFreezeFrames === 0) {
            if (this.unk64 & CF.NOTICE_ACTIVE) {
                if (sx !== 0) this.rotateY_ByStickX_(sx);
                else if (this.mNoticeActor) this.calcNoticeTargetYrot_(this.mNoticeActor.pos);
            } else this.rotateY_ByStickX_(sx);
            this.rotateX_ByStickY_(sy);
        }
        this.calcPosAndAt_();
    }
    private ctrlTalkCamera_() {
        if (this.mTargetFreezeFrames === 0) vset(this.cur.target, this.cmd.unk0);
        this.calcPosAndAt_();
    }

    // ------------------------------------------------------------ CameraTalk.cpp
    /**
     * makeMtxForTalk: an NPC starts talking (TBaseNPC: the director's talk mode). kind: TALK_A for
     * most, TALK_B small NPCs, TALK_C / TALK_D the small / large sunflowers, TALK_E the Monte MF.
     * Set talkModeNow while the talk lasts (TMarDirector::isTalkModeNow).
     */
    makeMtxForTalk(kind: number = CM.TALK_A) {
        this.killHeightPan_();
        this.cur.unk2C = this.cur.yaw;
        this.cur.yaw = s16(this.marioAngleY() - 0x8000);
        this.mSavedModeBeforeTalk = this.mMode;
        this.changeCamMode_(kind);
    }
    /** makeMtxForPrevTalk: the talk is over (the NPCs' npcTalkOut is the caller's) */
    makeMtxForPrevTalk() {
        if (isTalkMode(this.mMode)) {
            this.cur.yaw = this.cur.unk2C;
            this.changeCamMode_(this.mSavedModeBeforeTalk);
            this.pad.onNeutralMarioKey();
        }
    }

    // ------------------------------------------------------------ CameraCodeControl.cpp
    /** controlByCameraCode_: the camera cube Mario is in (null: false, he's opening a door) */
    private controlByCameraCode_(): number | null {
        if (this.openingDoor()) {
            if (this.mMode === CM.DELFINO_B && this.cmd.sinceStatus === 120) {
                this.changeCamModeSpecifyFrame_(CM.DELFINO, 1);
                this.warpPosAndAtRatio(this.cur.ratio, s16(this.marioAngleY() + 0x9C4));
            }
            this.pad.onNeutralMarioKey();
            return null;
        }
        const cubes = this.tables.cubes, mp = this.M.pos;
        const p = vec(mp.x, fr(mp.y + 75), mp.z);
        for (let i = 0; i < cubes.list.length; i++) {
            if (!cubes.isInCube(p, i)) continue;
            const tool = cubes.list[i].tool;
            if (tool) {
                if (this.mMode !== tool.mode || tool !== this.unk70) this.changeCamModeSpecifyCamMapTool_(tool);
                return tool.mode;
            }
            return cubes.getDataNo(i);
        }
        return -1;
    }

    // ------------------------------------------------------------ CameraChange.cpp
    private getCameraInbetweenFrame_(mode: number) {
        if (mode === -1) mode = this.stackTop();
        if (this.mMode >= 0 && this.mMode < CM.REPRODUCE_DEMO && mode >= 0 && mode < CM.REPRODUCE_DEMO) return this.save[this.mMode].inbet[mode];
        return 1;
    }
    /** CameraUnk60Struct::getThing (an empty stack still answers its first slot) */
    private stackTop() { return this.stackN <= 0 ? this.stack[0] : this.stack[this.stackN - 1]; }
    private stackPop() { if (this.stackN > 0) this.stackN--; }
    /** CameraUnk60Struct::doStuff: push, the oldest falling out of the four */
    private stackPush(v: number) {
        if (this.stackN >= 4) { for (let i = 0; i < 3; i++) this.stack[i] = this.stack[i + 1]; this.stack[3] = v; }
        else this.stack[this.stackN++] = v;
    }
    private setUpToLButtonCamera_(mode: number) {
        this.cur.unk30 = this.cur.ratio;
        const p = new KindParam().copySaveParam(this.save[mode]);
        this.prev.ratio = this.cur.ratio = clamp(ratioI(p.mXAngleMin, p.mXAngleMax, s16(-p.mOffsetAngleX)), 0, 1);
    }
    private setUpFromLButtonCamera_() { this.prev.ratio = this.cur.ratio = this.cur.unk30; }
    private changeCamMode_(mode: number) { this.changeCamModeSpecifyFrame_(mode, this.getCameraInbetweenFrame_(mode)); }
    private changeCamModeSub_(mode: number, frames: number, force: boolean) {
        let pop = false;
        if (mode === -1) { mode = this.stackTop(); pop = true; }
        if (!force && this.mMode === mode) return;
        if (frames < 0) return;
        if (frames === 0) frames = 1;
        this.mPrevMode = this.mMode;
        if (pop) this.stackPop();
        else this.stackPush(this.mMode);
        if (mode < CM.REPRODUCE_DEMO) {
            if ((this.mMode === CM.DELFINO && mode === CM.DELFINO_B) || (this.mMode === CM.LOOK_DOWN && mode === CM.MONTE_HANG)) {
                this.cur.ratio = 1; this.prev.ratio = 1;
            } else if (!isLButtonMode(this.mMode)) {
                if (isLButtonMode(mode)) { this.setUpToLButtonCamera_(mode); this.pad.onNeutralMarioKey(); }
            } else if (!isLButtonMode(mode)) { this.setUpFromLButtonCamera_(); this.pad.onNeutralMarioKey(); }
            this.inb.start(frames);
        }
        this.mMode = mode;
        if (this.mMode < CM.REPRODUCE_DEMO && this.mPrevMode < CM.REPRODUCE_DEMO) {
            const willFix = isFixOrDefinite(this.mMode) && this.unk70 !== null;
            const wasFix = isFixOrDefinite(this.mPrevMode);
            if (!wasFix && willFix) { this.beforeFixed.copy(this.cur); this.unk11C = this.unk70!.unk28; }
            if (wasFix) {
                if (this.unk11C & 1) { this.cur.copy(this.beforeFixed); this.prev.copy(this.cur); this.killHeightPan_(); }
                else this.calcNowTargetFromPosAndAt_(this.mPosition, this.mTarget);
                switch (this.mPrevMode) {
                    case CM.DEFINITE_D2: case CM.FIX_B: case CM.FIX_D: case CM.DEFINITE_B: case CM.DEFINITE_D:
                        this.warpPosAndAtRatio(this.cur.ratio, this.cur.yaw); break;
                    case CM.FIX_H: case CM.DEFINITE_H: this.cur.yaw = s16(this.marioAngleY() - 0x8000); break;
                    case CM.FIX_I: case CM.DEFINITE_I:
                        this.cur.yaw = s16(this.marioAngleY() - 0x8000);
                        this.warpPosAndAtRatio(this.cur.ratio, this.cur.yaw); break;
                }
            }
            if (willFix) {
                const tool = this.unk70!, keep = (tool.unk28 & 2) !== 0;
                switch (this.mMode) {
                    case CM.FIX_A: case CM.FIX_B: case CM.DEFINITE_A: case CM.DEFINITE_B: {
                        const save = vcopy(this.cur.pos);
                        this.toolPosAndAt(tool, this.cur.pos, this.cur.target);
                        if (keep) vset(this.cur.pos, save);
                        break;
                    }
                    default: {
                        const save = vcopy(this.mPosition);
                        this.toolPosAndAt(tool, this.mPosition, this.mTarget);
                        if (keep) vset(this.mPosition, save);
                        this.warpPosAndAt(this.mPosition, this.mTarget);
                    }
                }
            }
            this.mPosFreezeFrames = 0; this.mTargetFreezeFrames = 0;
            if (this.mPrevMode === CM.DEFINITE_G || this.mPrevMode === CM.FIX_G) this.onMoveApproach_();
            else this.inb.unk44 = 0;
        }
        if (!isNormalMode(this.mMode) && !isTowerMode(this.mMode)) this.unk64 &= ~(CF.UNK10 | CF.UNK8 | CF.UNK4);
        if (this.mPrevMode === CM.LOOK_DOWN && this.mMode === CM.MONTE_HANG) { if (this.unk278 < 120) this.unk278 = 120; }
        else if (this.mPrevMode === CM.MONTE_HANG && this.mMode === CM.LOOK_DOWN) { if (this.unk27A < 120) this.unk27A = 120; }
        this.killHeightPanWhenChangeCamMode_();
        this.hold.unk0 = 0; this.hold.unk4 = 0; this.hold.unk8 = 0; this.hold.unkC = 0;
    }
    private changeCamModeSpecifyFrame_(mode: number, frames: number) {
        this.unk74 = this.unk70; this.unk70 = null;
        this.changeCamModeSub_(mode, frames, false);
    }
    private changeCamModeSpecifyCamMapTool_(tool: CameraMapTool) {
        if (this.mMode !== tool.mode || this.unk70 !== tool) {
            this.unk74 = this.unk70; this.unk70 = tool;
            this.changeCamModeSub_(tool.mode, this.getCameraInbetweenFrame_(tool.mode), true);
        }
    }
    private changeCamModeSpecifyCamMapToolAndFrame_(tool: CameraMapTool, frames: number) {
        if (this.mMode !== tool.mode || this.unk70 !== tool) {
            this.unk74 = this.unk70; this.unk70 = tool;
            this.changeCamModeSub_(tool.mode, frames, true);
        }
    }
    private onMoveApproach_() {
        const dx = fr(this.mPosition.x - this.mTarget.x), dy = fr(this.mPosition.y - this.mTarget.y), dz = fr(this.mPosition.z - this.mTarget.z);
        const d = MsSqrtf(fr(dz * dz + fr(dy * dy + fr(dx * dx))));
        this.inb.unk44 = fr(d - lerpF(this.P.mDistMin, this.P.mDistMax, this.cur.ratio));
    }
    /** TCameraMapTool::calcPosAndAt */
    private toolPosAndAt(t: CameraMapTool, pos: Vec, at: Vec) {
        vset(pos, t.pos);
        if (isFixMode(t.mode)) polarToCross(pos, at, 1000, CLBDegToShortAngle(-t.pitch), CLBDegToShortAngle(t.yaw));
        else vset(at, this.getUsualLookat());
    }
    private execFrontRotate_() {
        if (!isLButtonMode(this.mMode) && this.marioStatus() !== ST.HIP_DROP) {
            this.unk64 &= ~CF.UNK10; this.unk64 |= CF.UNK4;
            this.unk274 = s16(this.marioAngleY() - 0x8000);
            if (this.pad.checkFrameMeaning(MEANING.Y)) { this.unk276 = this.ex.mYButtonRotateChase; this.unk64 |= CF.UNK8; }
            else if (this.pad.checkFrameMeaning(MEANING.CAM_L)) { this.unk276 = this.ex.mLButtonRotateChase; this.unk64 &= ~CF.UNK8; }
        }
    }
    private doLButtonCameraOn_() {
        if (!isLButtonMode(this.mMode) && !this.isLButtonCameraInbetween()) { this.unk282 = 60; this.changeCamMode_(CM.L_NORMAL); }
    }
    private doLButtonCameraOff_(quick: boolean) {
        if (this.isThing2()) {
            this.unk282 = 60;
            if (quick) this.changeCamModeSpecifyFrame_(-1, 1);
            else this.changeCamMode_(-1);
            if (this.unk64 & CF.NOTICE_ACTIVE) this.execNoticeOnOffProc_(0);
        }
    }
    private isChangeToBossGesoCamera_() {
        const h = this.M.mHeldObject;
        if (!h || !(h.actorType === AT.BOSS_GESSO_TENTACLE || h.actorType === AT.BOSS_UNK8)) return false;
        const g = this.unk2A8;
        return !!(g && ((g.beakHeld && g.beakHeld()) || (g.tentacleHeld && g.tentacleHeld())));
    }
    private isChangeToCancanCamera_() { const h = this.M.mHeldObject; return !!h && h.actorType === AT.FIRE_WANWAN_TAIL_HIT; }
    private isChangeToParallelCameraByMoveBG_() {
        const holder = this.M.holder;
        if (holder && (holder.actorType === AT.ELASTIC_CODE || holder.actorType === AT.FLUFF)) return true;
        const p = this.grPlane(), a = p && p.actor;
        if (a) {
            switch (a.actorType) {
                case AT.FERRIS_GONDOLA: return true;
                case AT.LEAF_BOAT_ROTTEN: case AT.LEAF_BOAT: case AT.SWING_BOARD: case AT.MUDDY_BOAT: if (this.touchGround4cm()) return true;
            }
        }
        return false;
    }
    private isChangeToParallelCameraCByMoveBG_() { return this.groundActorIs(AT.VIKING); }
    private exMapNot1D1E() { const m = this.world.map; return m > 0x14 && m < 0x35 && m !== 0x1D && m !== 0x1E; }

    private execCameraModeChangeProc_(code: number) {
        const w = this.world;
        if (w.map === 12 && w.stage === 0) { this.changeCamMode_(CM.MULTI_PLAYER); return; }
        if (this.marioStatus() === ST.TOROCCO) { this.changeCamMode_(CM.JET_COASTER); return; }
        if (isFixOrDefinite(code)) return;
        if (this.unk64 & CF.NOTICE_ACTIVE) this.execNoticeOnOffProc_(1);
        const prevMode = this.mMode;
        const pad = this.pad;
        if (this.isMarioSleeping() || this.marioFlag(MF.UNK2) || this.statusType(ST.FLAG_UNK10000) || this.isMarioRocketing()
            || this.marioFlag(MF.FLUDD_EMITTING) || this.isMarioClimb(this.marioStatus())) {
            if (isLButtonMode(this.mMode)) this.doLButtonCameraOff_(true);
            if (pad.checkFrameMeaning(MEANING.CAM_L)) this.execFrontRotate_();
        } else if (isLButtonMode(this.mMode)) {
            if (this.statusType(ST.FLAG_UNK20000)) this.doLButtonCameraOff_(true);
            else if (!this.isLButtonCameraInbetween() && pad.checkFrameMeaning(MEANING.Y | MEANING.CAM_AB) && this.unk282 === 0) this.doLButtonCameraOff_(false);
        } else if (isNormalMode(this.mMode) || isTowerMode(this.mMode)) {
            if (this.unk64 & CF.UNK10) { this.unk64 &= ~CF.UNK10; this.doLButtonCameraOn_(); }
            else if (pad.checkFrameMeaning(MEANING.Y | MEANING.CAM_L)) {
                let check = true;
                if (pad.checkFrameMeaning(MEANING.Y)) { if (this.unk282 !== 0) check = false; else this.execNoticeOnOffProc_(2); }
                if (check) {
                    if (this.unk64 & CF.NOTICE_ACTIVE) this.doLButtonCameraOn_();
                    else if (!this.isLButtonCameraInbetween()) this.execFrontRotate_();
                }
            }
        }
        if (prevMode !== this.mMode) return;
        if (isLButtonMode(this.mMode)) return;
        const status = this.marioStatus(), prevStatus = this.M.mPrevStatus >>> 0, map = w.map;
        let mode: number;
        const has = (f: number) => (status & f) !== 0;
        if (this.marioFlag(MF.HELMET_FLW_CAMERA)) mode = CM.DIVING;
        else if (this.marioFlag(MF.UNK2)) mode = map === 9 ? CM.MARE_UNDER_GROUND : CM.UNDER_GROUND;
        else if (this.marioFlag(MF.FLUDD_EMITTING)) {
            mode = map !== 7 && (has(ST.FLAG_SWIMMING) || ((prevStatus & ST.FLAG_SWIMMING) && has(ST.FLAG_JUMPING))) ? CM.AQUATIC_TURBO : CM.TURBO;
        } else if (map !== 7 && has(ST.FLAG_SWIMMING)) mode = CM.SWIMMING;
        else if (this.onWire() && (status === ST.WIRE_WAIT_TO_HANG || status === ST.WIRE_HANGING || status === ST.WIRE_ROLLING)) mode = CM.WIRE_HANG;
        else if (this.onWire() || status === ST.WIRE_JUMP || (prevStatus === ST.WIRE_JUMP && status === ST.HIP_DROP)) mode = CM.WIRE;
        else if (has(ST.FLAG_UNK10000)) mode = CM.SURFING;
        else if (has(ST.FLAG_UNK20000000) && this.M.unk2C0 && this.M.unk2C0.actorType === AT.RAIL_FENCE) mode = CM.RAIL_FENCE;
        else if (status === ST.FENCE_UNK569 || status === ST.FENCE_MOVE || status === ST.FENCE_PUNCH || status === ST.FENCE_CATCH || status === ST.FENCE_JUMP_CATCH)
            mode = map === 8 ? CM.MONTE_FENCE : CM.FENCE;
        else if (this.isMarioSlider()) mode = CM.SLIDER;
        else if (this.isMarioLeanMirror()) mode = CM.LEAN_MIRROR;
        else if (this.isMarioIndoor()) mode = code >= 0 && code < CM.REPRODUCE_DEMO ? code : map === 7 ? CM.DELFINO : CM.INDOOR;
        else if (this.isMarioRocketing() && code !== CM.TOWER_E) {
            const g = this.M.mWaterGun;
            mode = g && g.mCurrentNozzle === 4 ? CM.HOVERING : CM.ROCKET_JUMP;
        } else if (has(ST.FLAG_UNK200000) && status !== ST.KICK_ROOF_ROLL_UP) mode = map === 8 ? CM.MONTE_HANG : CM.HANG;
        else if (this.isChangeToBossGesoCamera_()) mode = CM.BOSS_GESO;
        else if (this.isChangeToCancanCamera_()) mode = CM.CANCAN;
        else if (this.groundActorIs(AT.SAND_BIRD_BLOCK)) mode = CM.SAND_BIRD;
        else if (map !== 7 && status === ST.FORCE_JUMP) mode = CM.JUMP_CODE;
        else if (this.isChangeToParallelCameraByMoveBG_()) mode = CM.PARALLEL;
        else if (this.groundActorIs(AT.VIKING)) mode = CM.PARALLEL_C;
        else if (status === ST.HIP_DROP) mode = isOverHipAttackMode(code) ? code : this.exMapNot1D1E() ? CM.EX_MAP_0 : CM.HIP_ATTACK;
        else if (code >= 0 && code < CM.REPRODUCE_DEMO && !isFollowMode(code)) mode = code;
        else if (this.isMarioClimb(status)) mode = CM.CLIMB;
        else if (status === ST.WALL_JUMP || status === ST.WALL_SLIDE) {
            if (this.isMarioClimb(prevStatus) && (this.mMode === CM.CLIMB || this.mPrevMode === CM.CLIMB)) mode = CM.CLIMB_JUMP;
            else mode = this.exMapNot1D1E() ? CM.EX_MAP_0 : CM.WALL_JUMP;
        } else mode = this.exMapNot1D1E() ? CM.EX_MAP_0 : isFollowMode(code) ? code : CM.FOLLOW;
        this.changeCamMode_(mode);
    }

    // ------------------------------------------------------------ CameraWarp.cpp
    private calcNowTargetFromPosAndAt_(pos: Vec, at: Vec) {
        const p = crossToPolar(at, pos);
        this.cur.ratio = ratioI(this.P.mXAngleMin, this.P.mXAngleMax, p.pitch);
        this.cur.ratio = isLButtonMode(this.mMode) ? clamp(this.cur.ratio, 0, 1) : clamp(this.cur.ratio, this.unk268, this.unk26C);
        this.cur.pitch = lerpS(this.P.mXAngleMin, this.P.mXAngleMax, this.cur.ratio);
        this.cur.yaw = p.yaw;
        vset(this.cur.pos, pos); vset(this.cur.unk18, pos); vset(this.cur.target, at);
    }
    /** warpPosAndAt(const Vec&, const Vec&) */
    warpPosAndAt(pos: Vec, at: Vec) {
        if (this.mMode >= CM.REPRODUCE_DEMO) return;
        pos = vcopy(pos); at = vcopy(at);
        this.P.copySaveParam(this.save[this.mMode]);
        this.killHeightPan_();
        vset(this.mPosition, pos); vset(this.mTarget, at); vset(this.unk124, pos); vset(this.unk148, at);
        this.inb.warpPosAndAt(pos, at); this.inb.frames = 0;
        this.calcNowTargetFromPosAndAt_(pos, at);
        this.prev.copy(this.cur);
    }
    /** warpPosAndAt(f32 ratio, s16 yAngle) */
    warpPosAndAtRatio(ratio: number, yAngle: number) {
        if (this.mMode >= CM.REPRODUCE_DEMO) return;
        this.P.copySaveParam(this.save[this.mMode]);
        const look = this.getUsualLookat();
        this.cur.ratio = isLButtonMode(this.mMode) ? clamp(ratio, 0, 1) : clamp(ratio, this.unk268, this.unk26C);
        this.cur.pitch = lerpS(this.P.mXAngleMin, this.P.mXAngleMax, this.cur.ratio);
        this.cur.yaw = s16(yAngle);
        const pos = polarToCross(look, vec(), lerpF(this.P.mDistMin, this.P.mDistMax, this.cur.ratio), this.cur.pitch, this.cur.yaw);
        this.warpPosAndAt(pos, look);
    }
    /** addMoveCameraAndMario (a warp that carries the camera along) */
    addMoveCameraAndMario(v: Vec) {
        vadd(this.mPosition, v); vadd(this.mTarget, v); vadd(this.unk124, v); vadd(this.unk148, v);
        vadd(this.cmd.unk0, v);
        this.inb.addMove(v);
        vadd(this.cur.pos, v); vadd(this.cur.target, v); vadd(this.cur.unk18, v);
        vadd(this.prev.pos, v); vadd(this.prev.target, v); vadd(this.prev.unk18, v);
    }

    // ------------------------------------------------------------ CameraDemo.cpp
    private bckExists(name: string) { return !!(this.bckSource && this.bckSource(name)); }
    /** startDemoCamera(name, offset, frames, angle, timed): a bck demo (REPRODUCE_DEMO) or a map tool's camera */
    startDemoCamera(name: string | null, offset: Vec | null = null, frames = -1, angle = 0, timed = true) {
        this.demo.offset = offset; this.demo.angle = angle;
        if (name === null) return;
        const b = this.bckSource ? this.bckSource(name) : null;
        if (b) {
            this.bck = b; this.bckTick = 0;
            this.demo.total = this.demo.remaining = b.totalFrames;
            this.changeCamModeSpecifyFrame_(CM.REPRODUCE_DEMO, 1);
            this.mNear = this.ex.mSLReproduceDemoNearClip;
            return;
        }
        if (this.isBckDemoCamera()) return;
        const tool = this.tables.tool(name);
        if (tool) {
            if (!timed) { this.demo.total = this.demo.remaining = -1; this.demo.unkC |= 1; }
            else if (frames === -1) this.demo.total = this.demo.remaining = tool.demoLength | 0;
            else this.demo.total = this.demo.remaining = frames;
            this.changeCamModeSpecifyCamMapTool_(tool);
        }
    }
    /**
     * The stage intro's demo (startDemoCamera('startcamera')): REPRODUCE_DEMO even without a bck
     * to show (the gameplay camera stands still meanwhile, as the game's does).
     */
    startStageDemo(bck: DemoBck | null = null) {
        this.bck = bck || { totalFrames: -1, view: () => null }; this.bckTick = 0;
        this.demo.offset = null; this.demo.angle = 0;
        this.demo.total = this.demo.remaining = this.bck.totalFrames;
        this.changeCamModeSpecifyFrame_(CM.REPRODUCE_DEMO, 1);
        this.mNear = this.ex.mSLReproduceDemoNearClip;
    }
    endDemoCamera() {
        if (this.isBckDemoCamera()) {
            this.bck = null;
            this.demo.total = this.demo.remaining = 0;
            this.changeCamModeSpecifyFrame_(-1, 1);
            this.pad.onNeutralMarioKey();
        } else if (this.isSimpleDemoCamera()) {
            this.demo.total = this.demo.remaining = 0;
            this.demo.unkC &= ~1;
            this.pad.onNeutralMarioKey();
        }
        this.demo.offset = null;
    }
    private updateDemoCamera_(last: boolean) {
        if (last && this.isBckDemoCamera() && this.bck) {
            const v = this.bck.view(this.bckTick);
            if (v) {
                vset(this.unk124, v.pos); vset(this.unk148, v.at); vset(this.mUp, v.up); this.mFovy = v.fovy;
                if (this.demo.offset) { vadd(this.unk124, this.demo.offset); vadd(this.unk148, this.demo.offset); }
                this.calcFinalPosAndAt_();
                this.calcMatrices();
            }
        }
        if (this.isBckDemoCamera()) this.bckTick++;
        if (this.demo.remaining > 0) {
            this.demo.remaining -= 1;
            if (this.demo.remaining === 0) {
                this.pad.onNeutralMarioKey();
                this.demo.total = this.demo.remaining = 0;
                if (this.isBckDemoCamera()) return;
                this.demo.unkC |= 1;
            }
        }
    }
    private updateGateDemoCamera_() { /* gate demos (startGateDemoCamera) are not simulated */ }
    private execDeadDemoProc_() {
        if (this.mDeadDemoCountdown > 0) {
            this.mDeadDemoCountdown -= 1;
            if (this.mDeadDemoCountdown > 0) return;
            this.unk64 |= CF.DEAD_DEMO;
            this.mPosFreezeFrames = 1;
            if (this.unk64 & CF.HELL_DEAD_DEMO) return;
            this.mDeadDemoCountdownToFovZoom = 1;
            return;
        }
        if (this.marioFlag(MF.GAME_OVER) && !(this.talkModeNow || this.demoModeNow)) this.mDeadDemoCountdown = 16;
    }
    private ctrlNormalDeadDemo_() {
        vset(this.cur.target, this.cmd.unk0);
        this.inb.exec(this.mPosition, this.cur.target, this.M.pos);
        const a = this.inb.at;
        this.mTarget.x = chaseDecrease(this.mTarget.x, a.x, fr(0.03))[0];
        this.mTarget.y = chaseDecrease(this.mTarget.y, a.y, fr(0.03))[0];
        this.mTarget.z = chaseDecrease(this.mTarget.z, a.z, fr(0.03))[0];
        if (this.marioFlag(MF.HELMET_FLW_CAMERA)) return;
        if (this.mDeadDemoCountdownToFovZoom > 0) {
            this.mDeadDemoCountdownToFovZoom -= 1;
            if (this.mDeadDemoCountdownToFovZoom > 0) return;
            this.mDeadDemoFovZoomTimer = 343;
            return;
        }
        if (this.mDeadDemoFovZoomTimer > 0) {
            this.mDeadDemoFovZoomTimer -= 1;
            const dx = fr(this.mTarget.x - this.mPosition.x), dy = fr(this.mTarget.y - this.mPosition.y), dz = fr(this.mTarget.z - this.mPosition.z);
            const d = MsSqrtf(fr(fr(dx * dx + fr(dy * dy)) + fr(dz * dz)));
            if (d > fr(0.001)) this.mFovy = chaseFrameF(this.mFovy, clamp(fr(10500 * fr(1 / d)), 5, 80), fr(this.mDeadDemoFovZoomTimer));
        }
    }

    // ------------------------------------------------------------ matrices (C_MTXPerspective, C_MTXLookAt)
    private calcMatrices() {
        perspective(this.proj, this.mFovy, this.mAspect, this.mNear, this.mFar);
        lookAt(this.view, this.unk124, this.mUp, this.unk148);
    }
}

// ---------------------------------------------------------------- helpers (cameralib.cpp, mtx.c)
/** CLBCalcNearNinePos (with CLBCalcNearClipAngle): the near plane's 3x3 grid, row-major from the top left */
function nearNinePos(o: Vec, at: Vec, roll: number, near: number, w: number, h: number): Vec[] {
    const g: Vec[] = [];
    for (let i = 0; i < 9; i++) g.push(vec());
    const dir = vnormalize(vec(fr(at.x - o.x), fr(at.y - o.y), fr(at.z - o.z)));
    g[4] = vec(fr(dir.x * near + o.x), fr(dir.y * near + o.y), fr(dir.z * near + o.z));
    const dx = fr(o.x - at.x), dz = fr(o.z - at.z);
    const ex = s16(-matan(MsSqrtf(fr(dx * dx + fr(dz * dz))), fr(o.y - at.y))), ey = matan(dz, dx);
    const sX = JMASSin(ex), cX = JMASCos(ex), sY = JMASSin(ey), cY = JMASCos(ey);
    const rot = (v: Vec) => {
        const t = fr(v.y * sX + fr(v.z * cX));
        return vec(fr(v.x * cY + fr(t * sY)), fr(v.y * cX - fr(v.z * sX)), fr(-v.x * sY + fr(t * cY)));
    };
    let up = rot(vec(0, 1, 0)), right = rot(vec(1, 0, 0));
    if (roll !== 0) {
        const a = roll * fr(0.0054931640625) * fr(0.017453294);
        up = rotateAbout(dir, -a, up); right = rotateAbout(dir, -a, right);
    }
    const hy = fr(h * 0.5), hx = fr(w * 0.5);
    const sa = (s: number, b: Vec, d: Vec) => vec(fr(d.x * s + b.x), fr(d.y * s + b.y), fr(d.z * s + b.z));
    g[1] = sa(hy, g[4], up); g[7] = sa(-hy, g[4], up); g[3] = sa(-hx, g[4], right); g[5] = sa(hx, g[4], right);
    const diag = MsSqrtf(fr(hy * hy + fr(hx * hx)));
    const r = vec(fr(right.x * hx), fr(right.y * hx), fr(right.z * hx)), u = vec(fr(up.x * hy), fr(up.y * hy), fr(up.z * hy));
    let d = vnormalize(vec(fr(u.x - r.x), fr(u.y - r.y), fr(u.z - r.z)));
    g[0] = sa(diag, g[4], d); g[8] = sa(-diag, g[4], d);
    d = vnormalize(vec(fr(r.x + u.x), fr(r.y + u.y), fr(r.z + u.z)));
    g[2] = sa(diag, g[4], d); g[6] = sa(-diag, g[4], d);
    return g;
}
function rotateAbout(axis: Vec, a: number, v: Vec): Vec {
    const c = Math.cos(a), s = Math.sin(a), t = 1 - c, { x, y, z } = axis;
    // TRotation3::setRotate, then the transposed product (CLBMultTranspose33)
    const m = [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
    return vec(fr(v.x * m[0] + v.y * m[3] + v.z * m[6]), fr(v.x * m[1] + v.y * m[4] + v.z * m[7]), fr(v.x * m[2] + v.y * m[5] + v.z * m[8]));
}
/** C_MTXPerspective (row-major 4x4) */
function perspective(m: Float64Array, fovy: number, aspect: number, n: number, f: number) {
    const a = fr(0.5 * fovy * (Math.PI / 180)), cot = fr(1 / Math.tan(a)), tmp = fr(1 / (f - n));
    m.fill(0);
    m[0] = fr(cot / aspect); m[5] = cot; m[10] = fr(-n * tmp); m[11] = fr(-(f * n) * tmp); m[14] = -1;
}
/** C_MTXLookAt (row-major 3x4) */
function lookAt(m: Float64Array, eye: Vec, up: Vec, at: Vec) {
    let lx = eye.x - at.x, ly = eye.y - at.y, lz = eye.z - at.z;
    let l = Math.hypot(lx, ly, lz) || 1; lx /= l; ly /= l; lz /= l;
    let rx = up.y * lz - up.z * ly, ry = up.z * lx - up.x * lz, rz = up.x * ly - up.y * lx;
    l = Math.hypot(rx, ry, rz) || 1; rx /= l; ry /= l; rz /= l;
    const ux = ly * rz - lz * ry, uy = lz * rx - lx * rz, uz = lx * ry - ly * rx;
    m[0] = rx; m[1] = ry; m[2] = rz; m[3] = -(eye.x * rx + eye.y * ry + eye.z * rz);
    m[4] = ux; m[5] = uy; m[6] = uz; m[7] = -(eye.x * ux + eye.y * uy + eye.z * uz);
    m[8] = lx; m[9] = ly; m[10] = lz; m[11] = -(eye.x * lx + eye.y * ly + eye.z * lz);
}
/** CLBCalc2DFPos (no depth): the NDC position, 10000 off screen */
function calc2DFPos(proj: Float64Array, view: Float64Array, p: Vec): [number, number] {
    const x = view[0] * p.x + view[1] * p.y + view[2] * p.z + view[3];
    const y = view[4] * p.x + view[5] * p.y + view[6] * p.z + view[7];
    const z = view[8] * p.x + view[9] * p.y + view[10] * p.z + view[11];
    if (z === 0) return [10000, 10000];
    const k = 1 / -z;
    const zz = (proj[10] * z + proj[11]) * k;
    if (zz > 0 || zz < -1) return [10000, 10000];
    return [(proj[0] * x + proj[2] * z) * k, (proj[5] * y + proj[6] * z) * k];
}
