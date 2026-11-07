// TCameraJetCoaster (Camera/CameraJetCoaster.cpp, CameraJetCoaster.hpp): the Pinna coaster's camera
// state (map 58, stages 0 and 1), gpCamera->unk2B8. Its TCamSaveJetCoaster (camerasave.cpp,
// /Camera/camera_jetCoaster.prm) limits and chases the C-stick offset angles of the third-person view;
// unk10 / unk1C / unk28 / unk34 are the coaster bck's view (TCameraBck::updateDemo on the frame's last
// tick: pinna2_camera for stage 0, tinkoopa_camera for stage 1 after its demo), mLButtonMode the Y
// toggle between it and the first-person view from the cart's seat (CPolarSubCamera::ctrlJetCoasterCamera_).

import { fnmsub as FNMS, fmadd as FMA } from '../player/fmath.js';
import { s16 } from '../math.js';
import { Files, PSchema, readParams } from '../engine.js';
import { Vec, vec, chaseAngleDecrease } from './lib.js';

/** TCamSaveJetCoaster (its PARAM_INIT list) */
export const JET_COASTER_SCHEMA = {
    mSLOffsetAngleXLimit: ['s16', 10000], mSLOffsetAngleYLimit: ['s16', 10000], mSLOffsetAngleXManualSpeed: ['s16', 250],
    mSLOffsetAngleYManualSpeed: ['s16', 250], mSLOffsetAngleXChase: ['s16', 25], mSLOffsetAngleYChase: ['s16', 25],
} satisfies PSchema;
export type CamSaveJetCoaster = { [K in keyof typeof JET_COASTER_SCHEMA]: number };
export const loadJetCoaster = (files: Files): CamSaveJetCoaster => readParams('/Camera/camera_jetCoaster.prm', files, JET_COASTER_SCHEMA) as any;

/** MsClamp<s16> as calcNowOffsetAngle has it (the lower bound -limit kept as a halfword) */
const clampS = (v: number, lim: number) => (v > lim ? lim : v < s16(-lim) ? s16(-lim) : v);

export class CameraJetCoaster {
    unk0: CamSaveJetCoaster;
    /** the offset angles (X, Y) and their goals */
    unk4 = 0; unk6 = 0; unk8 = 0; unkA = 0;
    mLButtonMode = 1;
    /** the coaster bck's eye, look-at, up and field of view */
    unk10: Vec = vec(0, 0, 500); unk1C: Vec = vec(0, 0, 0); unk28: Vec = vec(0, 1, 0); unk34 = 60;
    /** the balloon count's countdown (drawJetCoasterBalloonMessage_) */
    unk38 = 0;
    constructor(files: Files) { this.unk0 = loadJetCoaster(files); }

    toggleLButtonMode() { this.mLButtonMode ^= 1; }
    isLButtonMode() { return (this.mLButtonMode & 1) !== 0; }
    getOffsetAngleX() { return this.unk4; }
    getOffsetAngleY() { return this.unk6; }

    /** calcNowOffsetAngle(stick_y, stick_x): the goals moved by the C stick (fnmsubs / fmadds, fctiwz), kept in the limits, chased */
    calcNowOffsetAngle(stickY: number, stickX: number) {
        const P = this.unk0;
        this.unk8 = s16(Math.trunc(FNMS(stickY, P.mSLOffsetAngleXManualSpeed, this.unk8)));
        this.unkA = s16(Math.trunc(FMA(stickX, P.mSLOffsetAngleYManualSpeed, this.unkA)));
        this.unk8 = clampS(this.unk8, P.mSLOffsetAngleXLimit);
        this.unkA = clampS(this.unkA, P.mSLOffsetAngleYLimit);
        this.unk4 = chaseAngleDecrease(this.unk4, this.unk8, P.mSLOffsetAngleXChase)[0];
        this.unk6 = chaseAngleDecrease(this.unk6, this.unkA, P.mSLOffsetAngleYChase)[0];
    }
}
