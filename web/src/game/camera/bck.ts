// TCameraBck (Camera/CameraBck.cpp): the demo cameras' views from a .bck on /common/camera/camera_model.bmd.
//
// The camera model has two joints, cam_interest (the look-at) and cam_position under it (the eye).
// startDemo(name) puts the bck on the model's MActor (MActorAnmBck: its J3DFrameCtrl at frame 0, the
// bck's own loop attribute, rate SMSGetAnmFrameRate() = 2); every updateDemo (the camera's
// perform on the frame's last tick: updateDemoCamera_(true)) is MActor::calcAnm: the frame control's
// update first (frame += 2; a once-only bck stops at end - 0.001), then the joints at that frame.
// The view: cam_position's matrix translation (the eye), cam_interest's (the look-at), cam_position's
// Y column (the up, scaled: C_MTXLookAt only uses its direction) and the bck's own Y scale of
// cam_position (getTransform: the vertical field of view, degrees). getTotalDemoFrames: a looping bck
// -1, else (end + 1) * 2 camera ticks.
//
// The bcks are the stage's /scene/map/camera/<name>.bck and, added to the same MActorAnmData,
// /common/camera/camera_demo_shine_get_inside / _outside / camera_demo_gate_in.bck.

import { mat4 } from 'gl-matrix';
import type { ANK1 } from '../../../noclip/Common/JSYSTEM/J3D/J3DLoader.js';
import { JointTransformInfo } from '../../../noclip/Common/JSYSTEM/J3D/J3DLoader.js';
import { calcANK1JointAnimationTransform } from '../../../noclip/Common/JSYSTEM/J3D/J3DGraphAnimator.js';
import { Skeleton, parseBCK, jointMatrices } from '../skeleton.js';
import type { World } from '../engine.js';
import type { DemoBck, DemoView } from './polar.js';

/** sAddBckFileNameTable: the common camera demos every stage has */
const COMMON_BCKS = new Set(['camera_demo_shine_get_inside', 'camera_demo_shine_get_outside', 'camera_demo_gate_in']);
/** SMSGetAnmFrameRate() */
const RATE = 2;
const IDENT = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);

/** the camera bck of that name (TCameraBck::isFileExist: the stage's, else the common ones), null if none */
export function cameraBckFile(w: World, name: string): Uint8Array | null {
    const n = name.toLowerCase();
    const f = w.files.scene('map/camera/' + n + '.bck');
    if (f) return f;
    const common = (w.files as any).common as ((p: string) => Uint8Array | null) | undefined;
    return COMMON_BCKS.has(n) && common ? common('camera/' + n + '.bck') : null;
}

/** TCameraBck::startDemo(name): the demo, or null when the stage has no such bck (or no camera model). */
export function cameraBck(w: World, name: string): DemoBck | null {
    const f = cameraBckFile(w, name);
    const anm = parseBCK(f);
    if (!anm) return null;
    const common = (w.files as any).common as ((p: string) => Uint8Array | null) | undefined;
    const sk = Skeleton.of(common ? common('camera/camera_model.bmd') : null);
    return new CameraBckDemo(anm, sk);
}

class CameraBckDemo implements DemoBck {
    totalFrames: number;
    private pos: number; private at: number;
    private mats: mat4[] = [];
    private tmp = new JointTransformInfo();
    constructor(private anm: ANK1, private sk: Skeleton | null) {
        // J3DFrameCtrl's attribute is the bck's loop mode (0: once)
        this.totalFrames = anm.loopMode !== 0 ? -1 : (anm.duration + 1) * 2;
        this.pos = sk ? sk.index('cam_position') : 1;
        this.at = sk ? sk.index('cam_interest') : 0;
        if (this.pos < 0) this.pos = 1;
        if (this.at < 0) this.at = 0;
    }
    /** J3DFrameCtrl::update after n calls from frame 0 at rate 2, the bck's attribute */
    frameAfter(n: number): number {
        const end = this.anm.duration;
        let f = n * RATE;
        switch (this.anm.loopMode) {
            case 0: if (f >= end) f = end - 0.001; break;          // ONCE
            case 1: if (f >= end) f = 0; break;                     // ONCE_AND_RESET
            case 2: if (end > 0) f = f % end; break;               // LOOP (start 0, loop 0)
            case 3: case 4: {                                       // PING_PONG (MIRROR / MIRROR_LOOP)
                if (end > 0) { const p = f % (2 * end); f = p < end ? p : 2 * end - p; if (this.anm.loopMode === 3 && n * RATE >= 2 * end) f = 0; }
                break;
            }
        }
        return f;
    }
    /**
     * TCameraBck::updateDemo on its n-th call since startDemo (1 the first): MActor::calcAnm advances
     * the frame first, so the first view is the bck's frame 2.
     */
    view(n: number): DemoView | null {
        const frame = this.frameAfter(Math.max(1, n));
        const A = this.anm;
        let posM: mat4, atM: mat4;
        if (this.sk) {
            jointMatrices(this.sk, A, frame, IDENT, [1, 1, 1], this.mats);
            posM = this.mats[this.pos]; atM = this.mats[this.at];
        } else {
            // (no camera model: cam_interest the root, cam_position its child)
            const e0 = A.jointAnimationEntries[0], e1 = A.jointAnimationEntries[1];
            if (!e0 || !e1) return null;
            const t0 = new JointTransformInfo(), t1 = new JointTransformInfo();
            calcANK1JointAnimationTransform(t0, e0, frame, frame + 1);
            calcANK1JointAnimationTransform(t1, e1, frame, frame + 1);
            atM = mat4.fromRotationTranslationScale(mat4.create(), t0.rotation, t0.translation, t0.scale);
            posM = mat4.mul(mat4.create(), atM, mat4.fromRotationTranslationScale(mat4.create(), t1.rotation, t1.translation, t1.scale));
        }
        if (!posM || !atM) return null;
        const e = A.jointAnimationEntries[this.pos];
        let fovy = 50;
        if (e) { calcANK1JointAnimationTransform(this.tmp, e, frame, frame + 1); fovy = this.tmp.scale[1]; }
        const f32 = Math.fround;
        return {
            pos: { x: f32(posM[12]), y: f32(posM[13]), z: f32(posM[14]) },
            at: { x: f32(atM[12]), y: f32(atM[13]), z: f32(atM[14]) },
            up: { x: f32(posM[4]), y: f32(posM[5]), z: f32(posM[6]) },
            fovy: f32(fovy),
        };
    }
}
