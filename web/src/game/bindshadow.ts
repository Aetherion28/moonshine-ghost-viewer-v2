// TMBindShadowBody (MarioUtil/ShadowUtil.cpp) for the actors other than Mario that make one (THanaSambo):
// a TMBindShadowParts per joint of kind 1 the actor uses, from it to its first child, sized by
// the actor's radii times the given scale. entryDrawShadow is the viewer's (marioshadow.ts addBody:
// TMBindShadowBody::calc, TMBindShadowParts::calc).

import { AT } from './actortypes.js';
import { Skeleton } from './skeleton.js';
import type { HitActor } from './engine.js';

export interface BindShadowPart { joint: number; child: number; isCircle: boolean; isBody: boolean; }
export class MBindShadowBody {
    parts: BindShadowPart[] = [];
    mCircleRadius = 0.01; mPartsRadius = 0.01; mBodyRadius = 50;
    constructor(public mActor: HitActor, sk: Skeleton | null, scale: number) {
        switch (mActor.actorType) {
            case AT.MARIO: case AT.E_MARIO: this.mCircleRadius = 38; this.mPartsRadius = 18; this.mBodyRadius = 25; break;
            case AT.HINOKURI2: this.mCircleRadius = 280; this.mPartsRadius = 50; break;
            default: this.mCircleRadius = 50; this.mPartsRadius = 50; break;
        }
        this.mCircleRadius = Math.fround(this.mCircleRadius * scale);
        this.mPartsRadius = Math.fround(this.mPartsRadius * scale);
        if (!sk) return;
        for (let i = 0; i < sk.kinds.length; i++) {
            if (sk.kinds[i] !== 1 || !this.isUseThisJoint(i)) continue;
            // (J3DJoint::getChild: its first child in INF1 order)
            const child = sk.order.find((j) => sk.parent[j] === i);
            this.parts.push({ joint: i, child: child === undefined ? -1 : child, isCircle: this.isCircleJoint(i), isBody: !this.isCircleJoint(i) && this.isBodyJoint(i) });
        }
    }
    isUseThisJoint(i: number) {
        switch (this.mActor.actorType) {
            case AT.MARIO: case AT.E_MARIO: return true;
            case AT.HINOKURI2: return i !== 0x17;
        }
        return true;
    }
    isCircleJoint(i: number) {
        switch (this.mActor.actorType) {
            case AT.MARIO: case AT.E_MARIO: return i === 0x1a;
            case AT.HINOKURI2: return i === 0x13 || i === 0x17;
        }
        return false;
    }
    isBodyJoint(i: number) {
        switch (this.mActor.actorType) {
            case AT.MARIO: case AT.E_MARIO: return i === 2 || i === 0xe;
        }
        return false;
    }
}
