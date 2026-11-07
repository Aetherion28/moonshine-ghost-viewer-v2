// A save file as the game writes it (System/FlagManager.cpp TFlagManager::save / load): the
// stream CardManager puts in a file of the memory card, kept here in the browser (localStorage,
// one key a file A / B / C) for live play:
//
//   u32 4 (the version), s64 the save's time (OSGetTime), u64 0, s32 MSF_SAVE_COUNT, u16 the Shine
//   count, u16 0, 16 x u32 0, then the card's bools (119 bytes, a bit each, low bit first) padded
//   to 0x200, then the card's ints (21 x s32) padded to 0x200: 1116 bytes.
//
// The card file around it (the banner, the icon, the comment and the file's second copy) is
// CardManager's and isn't written: only the game's own save contents.

import { FlagManager, MSF, SAVE_SIZE } from './flags.js';

export { SAVE_SIZE };

/** TFlagManager::save */
export function writeSave(f: FlagManager, time = Date.now()): Uint8Array { return f.save(time); }
/** TFlagManager::load into a fresh manager; null: not a save */
export function readSave(b: Uint8Array): FlagManager | null {
    if (b.length < SAVE_SIZE || new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0) !== 4) return null;
    const f = new FlagManager();
    f.load(b);
    return f;
}
/** what the file select shows of a save: its Shines, its time */
export function saveSummary(b: Uint8Array) {
    const f = readSave(b);
    if (!f) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { shines: f.getFlag(MSF.SHINE_COUNT), blue: f.getFlag(MSF.BLUE_COIN_COUNT), time: Number(dv.getBigInt64(4)), count: dv.getInt32(20) };
}

const KEY = (slot: number) => 'ghostViewer.save.' + 'ABC'[slot];
/** the browser's copy of file A / B / C (null: empty, or storage unavailable) */
export function loadSlot(slot: number): Uint8Array | null {
    try {
        const s = localStorage.getItem(KEY(slot));
        if (!s) return null;
        const bin = atob(s), b = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
        return readSave(b) ? b : null;
    } catch { return null; }
}
export function storeSlot(slot: number, b: Uint8Array): boolean {
    try { let s = ''; for (const v of b) s += String.fromCharCode(v); localStorage.setItem(KEY(slot), btoa(s)); return true; } catch { return false; }
}
/** the card's option block (CardManager::writeOptionBlock / getOptionReadStream): one key */
const OPT_KEY = 'ghostViewer.option';
export function storeOption(b: Uint8Array): boolean { try { let s = ''; for (const v of b) s += String.fromCharCode(v); localStorage.setItem(OPT_KEY, btoa(s)); return true; } catch { return false; } }
export function loadOptionBlock(): Uint8Array | null {
    try { const s = localStorage.getItem(OPT_KEY); if (!s) return null; const bin = atob(s), b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; } catch { return null; }
}
export function eraseSlot(slot: number) { try { localStorage.removeItem(KEY(slot)); } catch { } }

/**
 * Where a file starts the game (TCardLoad then TApplication: a save with Shines to Delfino Plaza,
 * its scenario by the story flags; a new file to the airstrip, after the opening movie)
 */
export function startArea(f: FlagManager): { stage: number; scenario: number; movie?: number } {
    return f.getFlag(MSF.SHINE_COUNT) > 0 ? { stage: 1, scenario: 0xFF } : { stage: 0, scenario: 0, movie: f.getBool(MSF.FMV_OPENING_WATCHED) ? undefined : 1 };
}
