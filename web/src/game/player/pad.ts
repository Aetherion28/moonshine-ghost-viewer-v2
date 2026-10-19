// The player's pad: JUTGamePad's CStick / CButton (JUtility/JUTGamePad.cpp, read() after PADClamp)
// and TMarioGamePad (System/MarioGamePad.cpp) as TMarDirector::direct runs them: a fresh read on a
// frame's first movement tick, then on the other three resetButtons() (trigger / release cleared);
// updateMeaning on every tick. A ghost's input records are the post-PADClamp PADStatus of each
// frame (one per frame), so they go straight into read().

import { fr } from '../math.js';

/** PAD_BUTTON_* (PADStatus.button) */
export const PAD = { LEFT: 0x1, RIGHT: 0x2, DOWN: 0x4, UP: 0x8, Z: 0x10, R: 0x20, L: 0x40, A: 0x100, B: 0x200, X: 0x400, Y: 0x800, START: 0x1000 };
/** JUTGamePad::EButtons: the sticks' direction bits */
export const MAINSTICK = { LEFT: 0x1000000, RIGHT: 0x2000000, DOWN: 0x4000000, UP: 0x8000000 };

/** One frame's PADStatus (after PADClamp). */
export interface PadStatus {
    button: number; stickX: number; stickY: number; substickX: number; substickY: number;
    triggerLeft: number; triggerRight: number; analogA: number; analogB: number;
}
export const NO_PAD: PadStatus = { button: 0, stickX: 0, stickY: 0, substickX: 0, substickY: 0, triggerLeft: 0, triggerRight: 0, analogA: 0, analogB: 0 };

/** f32 division as the FPU does it (fdivs): both operands f32, the quotient rounded once. */
const fdiv = (a: number, b: number) => fr(a / b);

/** JUTGamePad::CStick (stick mode 1: clamped to the unit circle) */
export class CStick {
    mPosX = 0; mPosY = 0; mValue = 0; mAngle = 0;
    update(x: number, y: number, main: boolean) {
        const clamp = main ? 54 : 42;
        this.mPosX = fdiv(x, clamp);
        this.mPosY = fdiv(y, clamp);
        // fmuls, fmadds: one rounding for the sum of squares (-fp_contract on)
        this.mValue = fr(Math.sqrt(fr(this.mPosX * this.mPosX + this.mPosY * this.mPosY)));
        if (this.mValue > 1) {
            this.mPosX = fdiv(this.mPosX, this.mValue);
            this.mPosY = fdiv(this.mPosY, this.mValue);
            this.mValue = 1;
        }
        if (this.mValue > 0) {
            const rad = Math.atan2(this.mPosX, -this.mPosY);
            this.mAngle = Math.trunc((32768 * rad) / 3.1415926) << 16 >> 16;
        }
        return this.getButton();
    }
    getButton() {
        let b = 0;
        if (-0.25 < this.mPosX && this.mPosX < 0.25) b &= ~3;
        else if (this.mPosX <= -0.5) b |= 1;
        else if (this.mPosX >= 0.5) b |= 2;
        if (-0.25 < this.mPosY && this.mPosY < 0.25) b &= ~0xC;
        else if (this.mPosY <= -0.5) b |= 4;
        else if (this.mPosY >= 0.5) b |= 8;
        return b;
    }
}

/** JUTGamePad::CButton */
export class CButton {
    mButton = 0; mTrigger = 0; mRelease = 0; mRepeat = 0;
    mAnalogA = 0; mAnalogB = 0; mAnalogL = 0; mAnalogR = 0; mAnalogLf = 0; mAnalogRf = 0;
    mRepeatCount = 0; mRepeatStart = 0; mRepeatMask = 0; mRepeatDelay = 0; mRepeatRate = 0;
    update(p: PadStatus | null, stick: number) {
        const buttons = ((p ? p.button : 0) | stick) >>> 0;
        this.mRepeat = 0;
        if (this.mRepeatDelay !== 0 && this.mRepeatMask !== 0) {
            const rb = (buttons & this.mRepeatMask) >>> 0;
            this.mRepeat = 0;
            if (rb === 0) { this.mRepeatStart = 0; this.mRepeatCount = 0; }
            else if (this.mRepeatStart === rb) {
                this.mRepeatCount++;
                if (this.mRepeatCount === this.mRepeatDelay || (this.mRepeatCount > this.mRepeatDelay && (this.mRepeatCount - this.mRepeatDelay) % this.mRepeatRate === 0)) this.mRepeat = rb;
            } else { this.mRepeat = (rb & ~this.mRepeatStart) >>> 0; this.mRepeatStart = rb; this.mRepeatCount = 0; }
        }
        this.mTrigger = (buttons & (buttons ^ this.mButton)) >>> 0;
        this.mRelease = (this.mButton & (buttons ^ this.mButton)) >>> 0;
        this.mButton = buttons;
        this.mRepeat = (this.mRepeat | (~this.mRepeatMask & this.mTrigger)) >>> 0;
        this.mAnalogA = p ? p.analogA : 0; this.mAnalogB = p ? p.analogB : 0;
        this.mAnalogL = p ? p.triggerLeft : 0; this.mAnalogR = p ? p.triggerRight : 0;
        this.mAnalogLf = fdiv(this.mAnalogL, 150);
        this.mAnalogRf = fdiv(this.mAnalogR, 150);
    }
}

export const MEANING = {
    START: 0x1, MENU_UP: 0x2, MENU_DOWN: 0x4, MENU_LEFT: 0x8, MENU_RIGHT: 0x10, MENU_A: 0x20, MENU_B: 0x40, A: 0x80, B: 0x100, UNK200: 0x200,
    R: 0x400, TALK_B: 0x800, Z: 0x1000, L: 0x2000, Y: 0x4000, CAM_L: 0x8000, CAM_AB: 0x10000, SELECT_A: 0x20000, SELECT_B: 0x40000,
    SELECT_UP: 0x80000, SELECT_DOWN: 0x100000, X: 0x200000,
};
export const PAD_FLAG = { MENU_INPUT: 0x1, GAME_INPUT: 0x2, TALK_NPC: 0x4, TALK_SELECT: 0x8, NO_INPUT: 0x10, NO_B: 0x20, GUIDE_INPUT: 0x80 };

/** TMarioGamePad */
export class MarioGamePad {
    mMainStick = new CStick(); mSubStick = new CStick(); mButton = new CButton();
    mCompSPos = new Float32Array(10);
    mMeaning = 0; mEnabledFrameMeaning = 0; mDisabledFrameMeaning = 0;
    _DC = 0; _DE = 0; _E0 = 0;
    mFlags = 0; mNeutralKeyTimer = 0; mDisabledFrames = 0;
    /** gpCamera->isLButtonCamera() */
    isLButtonCamera: () => boolean = () => false;
    constructor() { this.reset(); }
    /** reset: the repeat (0xf00000f: the main stick's directions and the d-pad), 20 / 6 frames at 30 per second */
    reset() {
        this.mButton.mRepeatMask = 0xf00000f;
        // setButtonRepeat(mask, 20 / SMSGetAnmFrameRate(), 6 / SMSGetAnmFrameRate()) with the anm frame rate 0.5 (30 fps): 40 and 12
        this.mButton.mRepeatDelay = 40; this.mButton.mRepeatRate = 12;
        this.mButton.mRepeatCount = 0; this.mButton.mRepeatStart = 0; this.mRepeatReset();
        this.mNeutralKeyTimer = 0; this.mDisabledFrames = 0;
    }
    private mRepeatReset() { this.mButton.mRepeat = 0; }
    onFlag(f: number) { this.mFlags |= f; }
    offFlag(f: number) { this.mFlags &= ~f; }
    checkFlag(f: number) { return (this.mFlags & f) !== 0; }
    checkMeaning(m: number) { return (this.mMeaning & m) !== 0; }
    checkFrameMeaning(m: number) { return (this.mEnabledFrameMeaning & m) !== 0; }
    onNeutralMarioKey() { this.mNeutralKeyTimer = 0x3c; }
    invalidate(frames: number) { this.mDisabledFrames = frames; }

    /** JUTGamePad::read for this port: the frame's PADStatus (null: no controller). */
    read(p: PadStatus | null) {
        let stick = 0;
        if (p) {
            stick = (this.mMainStick.update(p.stickX, p.stickY, true) << 24) >>> 0;
            stick = (stick | (this.mSubStick.update(p.substickX, p.substickY, false) << 16)) >>> 0;
        } else { this.mMainStick.update(0, 0, true); this.mSubStick.update(0, 0, false); }
        this.mButton.update(p, stick);
    }
    resetButtons() { this.mButton.mTrigger = 0; this.mButton.mRelease = 0; }

    private um(button: number, meaning: number, prev: number) {
        if ((this.mButton.mTrigger & button) !== 0 || ((this.mButton.mButton & button) !== 0 && (prev & meaning) !== 0)) this.mMeaning |= meaning;
    }
    private resetMeaning() {
        const dc = this._DC;
        this._DC = 0;
        if (this.mButton.mButton & (PAD.UP | PAD.DOWN | PAD.LEFT | PAD.RIGHT)) this._DC |= 1;
        if (dc & 1) { if (this.mButton.mAnalogRf > 0.25) this._DC |= 1; }
        else if (this.mButton.mAnalogRf > 0.5) this._DC |= 1;
        this._DE = this._DC & ~dc;
        this._E0 = dc & ~this._DC;
        this.mCompSPos.fill(0);
        const prev = this.mMeaning;
        this.mMeaning = 0;
        return prev;
    }
    considerMarioStick() {
        let scale = 1, scaled = false;
        if (0 < this.mNeutralKeyTimer) this.mNeutralKeyTimer -= 1;
        if (0 < this.mNeutralKeyTimer) {
            const frame = (0x3d - this.mNeutralKeyTimer) << 16 >> 16;
            scaled = true;
            // CLBCalcRatio<s16>(0x28, 0x3c, frame): (frame - 0x28) / (0x3c - 0x28)
            scale = frame <= 0x28 ? 0 : fr((frame - 0x28) / (0x3c - 0x28));
        }
        const C = this.mCompSPos;
        if (scaled) { C[0] = fr(scale * this.mMainStick.mPosX); C[1] = fr(scale * this.mMainStick.mPosY); }
        else { C[0] = this.mMainStick.mPosX; C[1] = this.mMainStick.mPosY; }
    }
    updateMeaning() {
        if (this.mDisabledFrames > 0) this.mDisabledFrames -= 1;
        const prev = this.resetMeaning();
        const B = this.mButton, C = this.mCompSPos;
        this.um(PAD.START, MEANING.START, prev);
        const fin = () => { this.mEnabledFrameMeaning = (this.mMeaning & ~prev) >>> 0; this.mDisabledFrameMeaning = (prev & ~this.mMeaning) >>> 0; };
        if (this.checkFlag(PAD_FLAG.GUIDE_INPUT)) {
            this.um(PAD.A, MEANING.MENU_A, prev); this.um(PAD.B, MEANING.MENU_B, prev);
            C[8] = this.mMainStick.mPosX; C[9] = this.mMainStick.mPosY;
            return fin();
        }
        if (this.checkFlag(PAD_FLAG.MENU_INPUT)) {
            if (B.mRepeat & (MAINSTICK.UP | PAD.UP)) this.mMeaning |= MEANING.MENU_UP;
            if (B.mRepeat & (MAINSTICK.DOWN | PAD.DOWN)) this.mMeaning |= MEANING.MENU_DOWN;
            if (B.mRepeat & (MAINSTICK.LEFT | PAD.LEFT)) this.mMeaning |= MEANING.MENU_LEFT;
            if (B.mRepeat & (MAINSTICK.RIGHT | PAD.RIGHT)) this.mMeaning |= MEANING.MENU_RIGHT;
            this.um(PAD.A, MEANING.MENU_A, prev); this.um(PAD.B, MEANING.MENU_B, prev);
            return fin();
        }
        if (!this.checkFlag(PAD_FLAG.GAME_INPUT)) return fin();
        if (this.checkFlag(PAD_FLAG.TALK_SELECT)) {
            if (B.mRepeat & (MAINSTICK.UP | PAD.UP)) this.mMeaning |= MEANING.SELECT_UP;
            if (B.mRepeat & (MAINSTICK.DOWN | PAD.DOWN)) this.mMeaning |= MEANING.SELECT_DOWN;
            this.um(PAD.A, MEANING.SELECT_A, prev); this.um(PAD.B, MEANING.SELECT_B, prev);
            C[2] = B.mAnalogL; C[3] = B.mAnalogR;
            this.um(PAD.R, MEANING.R, prev); this.um(PAD.Z, MEANING.Z, prev); this.um(PAD.L, MEANING.L, prev);
            return fin();
        }
        if (this.checkFlag(PAD_FLAG.NO_INPUT)) return fin();
        if (this.mDisabledFrames <= 0) {
            if (this.isLButtonCamera()) {
                C[2] = B.mAnalogL; C[3] = B.mAnalogR;
                this.um(PAD.R, MEANING.R, prev); this.um(PAD.Z, MEANING.Z, prev); this.um(PAD.L, MEANING.L, prev);
                C[4] = this.mMainStick.mPosX; C[5] = this.mMainStick.mPosY;
                this.um(PAD.A, MEANING.CAM_AB, prev); this.um(PAD.B, MEANING.CAM_AB, prev); this.um(PAD.Y, MEANING.Y, prev);
            } else {
                this.considerMarioStick();
                C[2] = B.mAnalogL; C[3] = B.mAnalogR;
                this.um(PAD.A, MEANING.A, prev);
                if (this.checkFlag(PAD_FLAG.TALK_NPC)) this.um(PAD.B, MEANING.TALK_B, prev);
                else if (!this.checkFlag(PAD_FLAG.NO_B)) this.um(PAD.B, MEANING.B, prev);
                this.um(PAD.R, MEANING.R, prev); this.um(PAD.Z, MEANING.Z, prev); this.um(PAD.L, MEANING.L, prev);
                C[6] = this.mSubStick.mPosX; C[7] = this.mSubStick.mPosY;
                this.um(PAD.Y, MEANING.Y, prev); this.um(PAD.L, MEANING.CAM_L, prev);
            }
            if ((this._DE & 1) || ((this._DC & 1) && (prev & MEANING.UNK200))) this.mMeaning |= MEANING.UNK200;
            this.um(PAD.X, MEANING.X, prev);
        }
        fin();
    }
}
