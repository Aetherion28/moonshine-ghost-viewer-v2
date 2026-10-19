// What Mario's stick processing asks of the game camera (CPolarSubCamera, gpCamera):
// TMario::checkController adds gpCamera->unk258 (the s16 angle from the camera's target to its
// position, sin = x, cos = z: CLBCrossToPolar(mTarget, mPosition) after the camera's last perform)
// to the stick's angle; TMarioGamePad::updateMeaning asks isLButtonCamera; TMario::playerControl
// uses getOffsetAngleY in L-button mode.

/** The camera Mario's stick is read against. */
export interface StickCamera {
    /** gpCamera->unk258: s16 yaw (target to camera) */
    yaw(): number;
    /** CPolarSubCamera::isLButtonCamera (Y-camera "specify" mode). Absent: false. */
    isLButtonCamera?(): boolean;
    /** CPolarSubCamera::getOffsetAngleY. Absent: 0. */
    offsetAngleY?(): number;
}

/** What the player tick hands a simulated camera (PolarSubCamera.update(mario, pad)). */
export interface StickCameraMario {
    pos: { x: number; y: number; z: number };
    mFaceAngle: { x: number; y: number; z: number };
}

/** A simulated game camera (game/camera/polar.ts's PolarSubCamera). */
export interface SimCamera extends StickCamera {
    /**
     * CPolarSubCamera::perform(CUE_MOVE): once per movement tick, right after Mario's perform.
     * tick: bit 1 the frame's first movement tick, bit 2 its last (default 3).
     */
    update(mario: any, pad: any, tick?: number): void;
    /** The rendered view: eye, look-at, up, vertical FOV in degrees. */
    pos?: { x: number; y: number; z: number };
    at?: { x: number; y: number; z: number };
    up?: { x: number; y: number; z: number };
    fovy?: number;
    quat?: unknown;
}
