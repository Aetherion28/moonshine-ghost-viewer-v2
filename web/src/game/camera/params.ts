// The camera's parameter files (Camera/camerasave.cpp: TCamSaveKindParam for each of the 73 camera
// kinds, TCamSaveEx camera_normal.prm, TCamSaveNotice camera_bossA.prm) and TCameraKindParam
// (Camera/CameraKindParam.cpp: the working copy of a kind's parameters, eased toward the next
// kind's over a mode change).

import { fr } from '../math.js';
import { Files, PSchema, readParams } from '../engine.js';
import { chaseFrameF, chaseFrameS } from './lib.js';

/** CPolarSubCamera::mCamKindNameSaveFile (CameraMode.cpp), by ECameraMode */
export const KIND_FILES = [
    'Follow', 'Parallel', 'MultiPlayer', 'WallJump', 'HipAttack', 'RocketJump', 'Wire', 'LNormal', 'MareUnderGround', 'DefiniteD2',
    'TalkE', 'LeanMirror', 'TalkA', 'UnderGround', 'Indoor', 'Hang', 'WireHang', 'SandBird', 'Hovering', 'JumpCode', 'Delfino', 'Climb',
    'FixA', 'FixB', 'FixC', 'FixD', 'FixE', 'FixF', 'FixG', 'FixH', 'DefiniteA', 'DefiniteB', 'DefiniteC', 'DefiniteD', 'DefiniteE',
    'DefiniteF', 'DefiniteG', 'DefiniteH', 'ExMap0', 'TowerA', 'TowerB', 'TowerC', 'Slider', 'Diving', 'Turbo', 'TalkB', 'JetCoaster',
    'ParallelB', 'Surfing', 'Swimming', 'ClimbJump', 'LookDown', 'RailFence', 'FollowB', 'FollowC', 'TowerD', 'DelfinoAttic', 'BossGeso',
    'FixI', 'DefiniteI', 'Fence', 'MonteFence', 'MonteHang', 'TalkC', 'TalkD', 'TowerE', 'DelfinoB', 'Cancan', 'AquaticTurbo', 'FollowD',
    'FollowE', 'ParallelC', 'ParallelD',
];

/** TCamSaveKindParam (its PARAM_INIT list) */
export const KIND_SCHEMA = {
    mSLFovy: ['f', 50.0], mSLNearClip: ['f', 10.0], mSLDistMin: ['f', 450.0], mSLDistMax: ['f', 2000.0], mSLCushionMin: ['f', 350.0], mSLCushionMax: ['f', 600.0],
    mSLXAngleMin: ['s16', 0x37E], mSLXAngleMax: ['s16', 10000], mSLXRotRatioManualSpeed: ['f', 0.01], mSLYAngleManualSpeedXMin: ['s16', 250], mSLYAngleManualSpeedXMax: ['s16', 250],
    mSLAtOffsetY: ['f', 133.398], mSLXRotRatioAtOffsetY: ['f', 0.0], mSLTargetAtJumpOffsetY: ['f', -100.0], mSLAtJumpOffsetSpeed: ['f', 20.0], mSLHeightPanChaseRateY: ['f', 0.0],
    mSLSecureViewChase: ['f', 0.01], mSLSecureViewDistXMin: ['f', 0.0], mSLSecureViewDistZMin: ['f', 0.0], mSLSecureViewDistXMax: ['f', 0.0], mSLSecureViewDistZMax: ['f', 0.0],
    mSLHoldAddDistXZMin: ['f', 350.0], mSLHoldAddDistXZMax: ['f', 0.0], mSLHoldOffsetAngleXMin: ['s16', 0], mSLHoldOffsetAngleXMax: ['s16', 0], mSLOffsetAngleX: ['s16', 0],
    mSLOffsetAngleY: ['s16', 0], mSLOffsetLookatXZ: ['f', 0.0], mSLMaxAddAngleY: ['s16', 0], mSLAutoChaseStartFrame: ['i', 0], mSLAutoChaseCompleteFrame: ['i', 0],
    mSLFollowSpeedXmin: ['f', 3.5], mSLFollowSpeedXmax: ['f', 1.0], mSLJumpFollowSpeedXmin: ['f', 2.0], mSLJumpFollowSpeedXmax: ['f', 0.0], mSLObstructMaginfXmin: ['f', 1.5],
    mSLObstructMaginfXmax: ['f', 1.2], mSLInHouseMaginfXmin: ['f', 1.7], mSLInHouseMaginfXmax: ['f', 1.3], mSLLFollowMaginfXmin: ['f', 4.0], mSLLFollowMaginfXmax: ['f', 1.5],
    mSLPosChaseRateXZ: ['f', 0.04], mSLPosChaseRateXZ_C: ['f', 0.3], mSLPosChaseRateY: ['f', 0.08], mSLPosChaseRateY_C: ['f', 0.3], mSLAtChaseRateXZ: ['f', 0.1], mSLAtChaseRateY: ['f', 0.03],
} satisfies PSchema;
/** The mode-change frame counts (mSLInbet<kind>): 16 for most, 1 for FixC..H and DefiniteC..H. */
const INBET_ONE = new Set(['FixC', 'FixD', 'FixE', 'FixF', 'FixG', 'FixH', 'DefiniteC', 'DefiniteD', 'DefiniteE', 'DefiniteF', 'DefiniteG', 'DefiniteH']);

export type KindSave = { [K in keyof typeof KIND_SCHEMA]: number } & { inbet: number[] };

/** TCamSaveEx (camera_normal.prm) */
export const EX_SCHEMA = {
    mXRotStart: ['f', 0.2], mPanAfterMagnif: ['f', 0.01], mPanAfterMinHeight: ['f', 1.5], mPanWarpAngleX: ['s16', -10000], mSLMinCushionXZ: ['f', 300.0],
    mSLWallCheckRadius: ['f', 80.0], mSLWallRevisionRatio: ['f', 1.0], mGroundChangeY: ['f', 20.0], mSLGroundHeightNormal: ['f', 144.0], mSLGroundHeightReadyGun: ['f', 30.0],
    mSLRoofChangeY: ['f', 20.0], mSLRoofHeight: ['f', 60.0], mInHouseMinFrame: ['u8', 24], mYButtonRotateChase: ['s16', 2], mLButtonRotateChase: ['s16', 10],
    mSLAddAngleYSpeed: ['s16', 50], mSLReproduceDemoNearClip: ['f', 30.0], mSLHoldAngleXChase: ['s16', 50], mSLHoldDistChase: ['f', 0.02], mSLAimAngleYChaseMin: ['s16', 60],
    mSLAimAngleYChaseMax: ['s16', 32767], mSLLimitMinAngleX: ['s16', -15872], mSLLimitMaxAngleX: ['s16', 15872], mSLSlopeMaxAngleX: ['s16', 8192], mSLSlopeSpeedAngleX: ['s16', 50],
    mSLSlopeForwardDistXZ: ['f', 50.0],
} satisfies PSchema;
export type ExSave = { [K in keyof typeof EX_SCHEMA]: number };

/** TCamSaveNotice (camera_bossA.prm) */
export const NOTICE_SCHEMA = {
    mOnDist: ['f', 2500.0], mOffDist: ['f', 4000.0], mOnClipRatio: ['f', 1.0], mOffClipRatio: ['f', 3.0], mOnDegree: ['f', 150.0], mRotateYSpeed: ['s16', 300],
    mRotateMinDistXZ: ['f', 20.0], mRotateFastMinDistXZ: ['f', 500.0], mRotateMagnifXmax: ['f', 1.0],
} satisfies PSchema;
export type NoticeSave = { [K in keyof typeof NOTICE_SCHEMA]: number };

function f32All<T extends Record<string, any>>(o: T, schema: PSchema): T {
    for (const k in schema) if (schema[k][0] === 'f') (o as any)[k] = fr(o[k]);
    return o;
}
export function loadKind(files: Files, i: number): KindSave {
    const path = `/Camera/kind${KIND_FILES[i]}.prm`;
    const schema: PSchema = { ...KIND_SCHEMA };
    for (const k of KIND_FILES) schema['mSLInbet' + k] = ['s16', INBET_ONE.has(k) ? 1 : 16];
    const o: any = f32All(readParams(path, files, schema), schema);
    o.inbet = KIND_FILES.map((k) => o['mSLInbet' + k]);
    return o;
}
export const loadEx = (files: Files): ExSave => f32All(readParams('/Camera/camera_normal.prm', files, EX_SCHEMA) as any, EX_SCHEMA);
export const loadNotice = (files: Files): NoticeSave => f32All(readParams('/Camera/camera_bossA.prm', files, NOTICE_SCHEMA) as any, NOTICE_SCHEMA);

/** TCameraKindParam */
export class KindParam {
    mFovy = 0; mNearClip = 0; mDistMin = 0; mDistMax = 0; mCushionMin = 0; mCushionMax = 0; mXAngleMin = 0; mXAngleMax = 0;
    mXRotRatioManualSpeed = 0; mYAngleManualSpeedXMin = 0; mYAngleManualSpeedXMax = 0; mAtOffsetY = 0; mXRotRatioAtOffsetY = 0;
    mTargetAtJumpOffsetY = 0; mAtJumpOffsetSpeed = 0; mHeightPanChaseRateY = 0; mSecureViewChase = 0; mSecureViewDistXMin = 0;
    mSecureViewDistZMin = 0; mSecureViewDistXMax = 0; mSecureViewDistZMax = 0; mHoldAddDistXZMin = 0; mHoldAddDistXZMax = 0;
    mHoldOffsetAngleXMin = 0; mHoldOffsetAngleXMax = 0; mOffsetAngleX = 0; mOffsetAngleY = 0; mOffsetLookatXZ = 0; mMaxAddAngleY = 0;
    mAutoChaseStartFrame = 0; mAutoChaseCompleteFrame = 0; mFollowSpeedXmin = 0; mFollowSpeedXmax = 0; mJumpFollowSpeedXmin = 0;
    mJumpFollowSpeedXmax = 0; mObstructMaginfXmin = 0; mObstructMaginfXmax = 0; mInHouseMaginfXmin = 0; mInHouseMaginfXmax = 0;
    mLFollowMaginfXmin = 0; mLFollowMaginfXmax = 0; mPosChaseRateXZ = 0; mPosChaseRateXZ_C = 0; mPosChaseRateY = 0; mPosChaseRateY_C = 0;
    mAtChaseRateXZ = 0; mAtChaseRateY = 0;

    copySaveParam(s: KindSave) {
        for (const k in KIND_SCHEMA) (this as any)['m' + k.slice(3)] = (s as any)[k];
        return this;
    }
    copy(o: KindParam) { Object.assign(this, o); return this; }
    /** inbetweenData: each field eased toward o's over `ratio` frames */
    inbetweenData(o: KindParam, ratio: number) {
        const F = (k: keyof KindParam) => { (this as any)[k] = chaseFrameF(this[k] as number, o[k] as number, ratio); };
        const S = (k: keyof KindParam) => { (this as any)[k] = chaseFrameS(this[k] as number, o[k] as number, ratio); };
        F('mFovy'); F('mNearClip'); F('mDistMin'); F('mDistMax'); F('mCushionMin'); F('mCushionMax');
        S('mXAngleMin'); S('mXAngleMax');
        F('mXRotRatioManualSpeed');
        S('mYAngleManualSpeedXMin'); S('mYAngleManualSpeedXMax');
        F('mAtOffsetY'); F('mXRotRatioAtOffsetY'); F('mTargetAtJumpOffsetY'); F('mAtJumpOffsetSpeed'); F('mHeightPanChaseRateY');
        F('mSecureViewChase'); F('mSecureViewDistXMin'); F('mSecureViewDistZMin'); F('mSecureViewDistXMax'); F('mSecureViewDistZMax');
        F('mHoldAddDistXZMin'); F('mHoldAddDistXZMax');
        S('mHoldOffsetAngleXMin'); S('mHoldOffsetAngleXMax');
        this.mOffsetAngleX = o.mOffsetAngleX; this.mOffsetAngleY = o.mOffsetAngleY;
        F('mOffsetLookatXZ');
        S('mMaxAddAngleY');
        this.mAutoChaseStartFrame = o.mAutoChaseStartFrame; this.mAutoChaseCompleteFrame = o.mAutoChaseCompleteFrame;
        F('mFollowSpeedXmin'); F('mFollowSpeedXmax'); F('mJumpFollowSpeedXmin'); F('mJumpFollowSpeedXmax'); F('mObstructMaginfXmin');
        F('mObstructMaginfXmax'); F('mInHouseMaginfXmin'); F('mInHouseMaginfXmax'); F('mLFollowMaginfXmin'); F('mLFollowMaginfXmax');
        F('mPosChaseRateXZ'); F('mPosChaseRateXZ_C'); F('mPosChaseRateY'); F('mPosChaseRateY_C'); F('mAtChaseRateXZ'); F('mAtChaseRateY');
    }
}
