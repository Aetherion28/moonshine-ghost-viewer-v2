// The live actors' animation sounds (Strategic/liveactor.cpp: initAnmSound, setAnmSound,
// setCurAnmSound, updateAnmSound; MSound/MAnmSound.cpp: MAnmSound::animeLoop, which hands JAudio's
// JAIAnimeSound the BCK's frame and rate each frame). A .bas (JAIAnimeSoundData) lists sounds by
// BCK frame: one with 0xC00 in its ID starts once as the frame passes its start; one without is held
// while the frame is inside [start, end) (or at start == end, always) and let go once out. Each is
// told to the audio as a 'sound' event at the actor's position (world.sound), held ones under the
// actor's own key so they last while asked for each frame.
//
// Not here: MAnmSoundNPC's per-entry repeat / random gates and Mario-distance volume (unk10),
// MAnmSound::startAnimSound's ground-type skip, setSpeedModifySound (the BCK rate's pitch).

import type { World } from './engine.js';
import type { V3 } from './math.js';

export interface BasEntry { id: number; start: number; end: number; pitch: number; volume: number; }

/** a .bas: u16 count, then 0x20-byte JAIAnimeFrameSoundData entries from 8 */
export function parseBas(b: Uint8Array): BasEntry[] {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength), n = b.length >= 2 ? v.getUint16(0) : 0, out: BasEntry[] = [];
    for (let i = 0; i < n && 8 + i * 0x20 + 0x20 <= b.length; i++) {
        const o = 8 + i * 0x20, vol = b[o + 0x14];
        out.push({ id: v.getUint32(o), start: v.getFloat32(o + 4), end: v.getFloat32(o + 8), pitch: v.getFloat32(o + 0xC) || 1, volume: vol ? vol / 127 : 1 });
    }
    return out;
}

const cache = new WeakMap<object, Map<string, BasEntry[] | null>>();
/** JKRFileLoader::getGlbResource(path) for a .bas: the stage's archive (/scene/...) or the common one */
export function loadBas(w: World, path: string): BasEntry[] | null {
    const files: any = (w as any).files;
    if (!files) return null;
    let c = cache.get(files);
    if (!c) { c = new Map(); cache.set(files, c); }
    if (c.has(path)) return c.get(path)!;
    let b: Uint8Array | null = null;
    try {
        const p = path.replace(/^\//, '');
        if (/^scene\//i.test(p) && files.scene) b = files.scene(p.replace(/^scene\//i, ''));
        else if (files.common) b = files.common(p.replace(/^common\//i, ''));
    } catch { b = null; }
    const r = b ? parseBas(b) : null;
    c.set(path, r);
    return r;
}

let nextKey = 1;
/** MAnmSound: one actor's current .bas and where its BCK was last frame */
export class AnmSound {
    private prev = NaN;
    private key = 'anm' + nextKey++ + ':';
    constructor(public list: BasEntry[] | null) { }
    /** animeLoop(pos, frame, rate): the entries the BCK passed since last frame, and the held ones it's inside */
    loop(w: World, p: V3, frame: number, rate: number) {
        const L = this.list, prev = this.prev;
        this.prev = frame;
        if (!L || !L.length) return;
        const pass = (lo: number, hi: number) => { for (const e of L) if (e.id & 0xC00 && e.start > lo && e.start <= hi) w.sound(e.id >>> 0, p, { vol: e.volume, pitch: e.pitch }); };
        if (Number.isNaN(prev)) pass(-Infinity, frame);
        else if (rate >= 0) {
            if (frame >= prev) { if (frame > prev) pass(prev, frame); }
            else { pass(prev, Infinity); pass(-Infinity, frame); }   // (looped round)
        } else if (frame < prev) pass(frame - 1e-6, prev - 1e-6);   // (backwards: what it went back over)
        L.forEach((e, i) => {
            if (e.id & 0xC00) return;
            const inside = e.start === e.end || (e.start < e.end ? frame >= e.start && frame < e.end : frame < e.end || frame > e.start);
            if (inside) w.sound(e.id >>> 0, p, { vol: e.volume, pitch: e.pitch, hold: this.key + i });
        });
    }
}
