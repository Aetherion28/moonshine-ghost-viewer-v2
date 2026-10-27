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
