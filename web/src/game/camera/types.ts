// What Mario's stick processing asks of the game camera (CPolarSubCamera, gpCamera):
// TMario::checkController adds gpCamera->unk258 (mCurrentTarget.mYaw, the s16 angle from the
// target to the camera, sin = x, cos = z) to the stick's angle; TMarioGamePad::updateMeaning
// asks isLButtonCamera; TMario::playerControl uses getOffsetAngleY in L-button mode.

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
    update(mario: any, pad: any): void;
    pos?: unknown; quat?: unknown; fovy?: number;
}
