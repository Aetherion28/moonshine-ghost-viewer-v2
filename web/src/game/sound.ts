// Sounds the game code starts (SMSGetMSound()->startSoundActor / startSoundSystemSE): told to the
// viewer as world events of kind 'sound' ({ id, p }), which the audio player plays on the
// sound-effect sequence. Ports call world.sound(SE.NAME or 'NAME', position).

import { World } from './engine.js';
import type { V3 } from './math.js';
import { SE, SEName } from './soundids.js';

declare module './engine.js' {
    interface World {
        /** startSoundActor(id, pos) (no position: a system sound, heard as at the camera) */
        sound(id: number | SEName, p?: V3 | null): void;
    }
}
World.prototype.sound = function (this: World, id: number | SEName, p?: V3 | null) {
    const n = typeof id === 'string' ? SE[id] : id;
    if (n === undefined) return;
    this.events.push({ t: this.tickCount, kind: 'sound', data: { id: n, p: p ? p.clone() : null } });
};
export { SE };
