// Sounds the game code starts (SMSGetMSound()->startSoundActor / startSoundSystemSE): told to the
// viewer as world events of kind 'sound' ({ id, p }), which the audio player plays on the
// sound-effect sequence. Ports call world.sound(SE.NAME or 'NAME', position).

import { World } from './engine.js';
import type { V3 } from './math.js';
import { SE, SEName } from './soundids.js';

declare module './engine.js' {
    interface World {
        /** startSoundActor(id, pos) (no position: a system sound, heard as at the camera) */
        sound(id: number | SEName, p?: V3 | null, opt?: { vol?: number; pitch?: number; hold?: string }): void;
    }
}
World.prototype.sound = function (this: World, id: number | SEName, p?: V3 | null, opt?: { vol?: number; pitch?: number; hold?: string }) {
    const n = typeof id === 'string' ? SE[id] : id;
    if (n === undefined) return;
    this.events.push({ t: this.tickCount, kind: 'sound', data: opt ? { id: n, p: p ? p.clone() : null, ...opt } : { id: n, p: p ? p.clone() : null } });
};
export { SE };
const keys = new WeakMap<object, number>();
let nextHold = 1;
/** a held sound's key for this actor (a looping SE kept going while asked for each frame) */
export function holdKey(o: object, tag: string) { let k = keys.get(o); if (!k) { k = nextHold++; keys.set(o, k); } return 'h' + k + ':' + tag; }

// ---------------------------------------------------------------- MSoundSESystem::MSRandPlay
// (MSound/MSoundSE.cpp) Sounds played at random intervals, one wait-play-wait cycle per
// registered position: MSoundSE::construct makes one per sound id, a manager's loadAfter
// createRandPlayVec's as many slots as it has objects, each object's loadAfter registerTrans'es
// its position, and startSeRandPlay(id, slot) each frame steps that slot's cycle.

/** JALCalc::getRandom_0_1's oRandom (JMath::TRandom_fast_(0)) */
let jalRandom = 0;
function getRandom_0_1() {
    jalRandom = (Math.imul(jalRandom, 0x19660d) + 0x3c6ef35f) >>> 0;
    const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, ((jalRandom >>> 9) | 0x3f800000) >>> 0);
    return Math.fround(b.getFloat32(0) - 1);
}
/** JALCalc::getRandom */
function getRandom(amplitude: number, curveSlope: number, plusSlope: number) {
    const fr = Math.fround;
    const val0 = fr(2 * plusSlope), val1 = fr(-2 * fr(1 - plusSlope));
    const val2 = getRandom_0_1() < plusSlope ? val0 : val1;
    amplitude = fr(amplitude * val2);
    const val3 = fr(Math.pow(getRandom_0_1(), curveSlope));
    return fr(val3 * amplitude);
}
const RP_CALC_WAIT = 0, RP_WAIT = 1, RP_START = 2, RP_PLAYING = 3;
class MSRandPlayVec { mTrans: V3 | null = null; mState = 0; mWaitTime = 0; mWaitTimer = 0; mSound = false; }
export class MSRandPlay {
    mRandPlayVecs: MSRandPlayVec[] = []; mRandPlayVecMax = 0; mRandPlayVecNum = 0;
    constructor(public mSoundID: number, public mWaitMin: number, public mWaitMax: number, public mCurveSlope: number, public mPlusSlope: number) { }
    registerTransDynamic(trans: V3) { const v = this.mRandPlayVecs[this.mRandPlayVecNum]; if (v) v.mTrans = trans; return this.mRandPlayVecNum++; }
    createRandPlayVecDynamic(max: number) { this.mRandPlayVecs = Array.from({ length: max }, () => new MSRandPlayVec()); this.mRandPlayVecMax = max; this.mRandPlayVecNum = 0; }
    randPlay(w: World, idx: number) {
        const vec = this.mRandPlayVecs[idx];
        if (!vec) return;
        if (vec.mState === RP_CALC_WAIT) {
            const f = getRandom(Math.fround(this.mWaitMax / 2), this.mCurveSlope, this.mPlusSlope);
            vec.mWaitTime = Math.trunc(f) > this.mWaitMin ? Math.trunc(f) : this.mWaitMin;
            vec.mWaitTime = vec.mWaitTime < this.mWaitMax ? vec.mWaitTime : this.mWaitMax;
            if (vec.mWaitTime === 0) vec.mState = RP_START;
            else { vec.mWaitTimer = 0; vec.mState = RP_WAIT; return; }
        } else if (vec.mState === RP_WAIT) {
            if (vec.mWaitTime > vec.mWaitTimer) { vec.mWaitTimer += 1; return; }
            vec.mState = RP_START;
        }
        if (vec.mState === RP_START) {
            // (KAMOME_SOLO: startSoundSetGrp; the others startSoundActorInner on a JAIActor at mTrans)
            w.sound(this.mSoundID, vec.mTrans);
            vec.mState = RP_PLAYING; vec.mWaitTimer = 0;
            // (the handle: the sim doesn't follow a sound to its end, so it counts as ended by the next step)
            vec.mSound = false;
        } else if (vec.mState === RP_PLAYING) {
            if (!vec.mSound) vec.mState = RP_CALC_WAIT;
        }
    }
}
const RAND_PLAYS = new WeakMap<World, MSRandPlay[]>();
/** MSoundSE::construct's MSRandPlay::construct list (cEqualCSlope = cPlusPSlope = 1) */
function randPlays(w: World) {
    let l = RAND_PLAYS.get(w);
    if (!l) {
        RAND_PLAYS.set(w, l = ([
            [SE.OBJ_KAMOME_SOLO, 0x1e, 0xf0], [SE.MV10A_CRY_SHORT_01, 3, 0x14], [SE.MV16_EXERT_CONT_01, 3, 0x14], [SE.MA_WATER_WAIT, 5, 0x3c],
            [SE.OBJ_BIRD_DOL_FLYING1, 0x66, 0x181], [SE.OBJ_BIRD_MAH_A1, 0x66, 0x181], [SE.OBJ_BIRD_BIA_1, 0x66, 0x181], [SE.OBJ_MONTE_DAY_A1, 0x66, 0x181],
            [SE.OBJ_MONTE_NIGHT_A1, 0x66, 0x181], [SE.OBJ_BIRD_DOL_CHUN, 0x66, 0x181], [SE.OBJ_BIRD_BIA_1, 0x56, 0xf3], [SE.OBJ_MONTE_DAY_A1, 0x56, 0xf3],
            [SE.OBJ_MONTE_NIGHT_A1, 8, 0xd],
        ] as number[][]).map(([id, a, b]) => new MSRandPlay(id, a, b, 1, 1)));
    }
    return l;
}
/** MSRandPlay::registerTrans: the slot of the first rand play of that id */
export function registerTrans(w: World, id: number, trans: V3) { for (const r of randPlays(w)) if (r.mSoundID === id) return r.registerTransDynamic(trans); return -1; }
/** MSRandPlay::createRandPlayVec */
export function createRandPlayVec(w: World, id: number, max: number) { for (const r of randPlays(w)) if (r.mSoundID === id) { r.createRandPlayVecDynamic(max); break; } }
/** MSound::startSeRandPlay -> MSRandPlay::startSeRandPlay */
export function startSeRandPlay(w: World, id: number, idx: number) { for (const r of randPlays(w)) if (r.mSoundID === id) { r.randPlay(w, idx); break; } }
