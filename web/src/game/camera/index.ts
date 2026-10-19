// The game camera for the input-driven Mario (player/player.ts): what playerHooks.makeCamera
// wants, plus the director's hand-over points.
//
//   playerHooks.makeCamera = makePlayerCamera;     // once, where the player module is set up
//
// Then, per stage tick (TMarDirector::direct's movement loop):
//   1. the pad (read on the frame's first tick, resetButtons on the others; updateMeaning)
//   2. ... the conductor, the managers, Mario's perform (he reads camera.yaw(): the previous
//      tick's camera) ...
//   3. camera.update(mario, mario.mGamePad, tick)   // tick: 1 = the frame's first, 2 = its last
//   4. the director's changeState: on each state change call camera.setDirectorState(next)
//      (entering STATE_UNK1 starts the intro's camera demo, leaving it ends it).

import type { World } from '../engine.js';
import { PolarSubCamera, CameraMario, CameraPad, DemoBck } from './polar.js';

export { PolarSubCamera, CM } from './polar.js';
export type { CameraMario, CameraPad, DemoBck, DemoView } from './polar.js';

/** playerHooks.makeCamera: the camera built and loadAfter'd with Mario where the stage put him. */
export function makePlayerCamera(w: World, m: CameraMario & { mGamePad?: CameraPad }): PolarSubCamera {
    const c = new PolarSubCamera(w);
    c.loadAfter(m, m.mGamePad || null);
    // TMarDirector starts in STATE_UNK0 (the director tells the camera each change: setDirectorState)
    c.directorState = 0;
    return c;
}

declare module './polar.js' {
    interface PolarSubCamera {
        /**
         * TMarDirector's state changed (changeState: currentStateFinalize, nextStateInitialize):
         * STATE_UNK1 starts the stage intro's demo camera (gpCamera->startDemoCamera("startcamera"):
         * REPRODUCE_DEMO, the view from bck when given), leaving it ends it (endDemoCamera);
         * the camera cubes and mode changes run in STATE_UNK4.
         */
        setDirectorState(next: number, bck?: DemoBck | null): void;
    }
}
PolarSubCamera.prototype.setDirectorState = function (this: PolarSubCamera, next: number, bck: DemoBck | null = null) {
    const prev = this.directorState;
    if (prev === next) return;
    if (prev === 1) this.endDemoCamera();
    this.directorState = next;
    if (next === 1) this.startStageDemo(bck || (this.bckSource ? this.bckSource('startcamera') : null));
};
