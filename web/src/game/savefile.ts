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

import { FlagManager, MSF } from './flags.js';

export const SAVE_SIZE = 4 + 8 + 8 + 4 + 2 + 2 + 64 + 0x200 + 0x200;
const BOOLS = MSF.CARD_BOOL_END & 0xFFFF, INTS = MSF.CARD_INT_END & 0xFFFF;

/** TFlagManager::save (it counts the save first: MSF_SAVE_COUNT + 1) */
export function writeSave(f: FlagManager, time = Date.now()): Uint8Array {
    f.incFlag(MSF.SAVE_COUNT, 1);
    const b = new Uint8Array(SAVE_SIZE), dv = new DataView(b.buffer);
    dv.setUint32(0, 4);
    dv.setBigInt64(4, BigInt(Math.trunc(time)));
    dv.setInt32(20, f.getFlag(MSF.SAVE_COUNT));
    dv.setUint16(24, f.getFlag(MSF.SHINE_COUNT) & 0xFFFF);
    const bo = 28 + 64, io = bo + 0x200;
    for (let i = 0; i < BOOLS; i++) if (f.getFlag(0x10000 + i)) b[bo + (i >> 3)] |= 1 << (i & 7);
    for (let i = 0; i < INTS; i++) dv.setInt32(io + i * 4, f.getFlag(0x20000 + i));
    return b;
}
/** TFlagManager::load: a fresh save's flags with the card's read in (resetCard, then correctFlag); null: not a save */
export function readSave(b: Uint8Array): FlagManager | null {
    if (b.length < SAVE_SIZE) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (dv.getUint32(0) !== 4) return null;
    const f = new FlagManager();
    f.resetCard();
    const bo = 28 + 64, io = bo + 0x200;
    for (let i = 0; i < BOOLS; i++) f.setFlag(0x10000 + i, (b[bo + (i >> 3)] >> (i & 7)) & 1);
    for (let i = 0; i < INTS; i++) f.setFlag(0x20000 + i, dv.getInt32(io + i * 4));
    f.correctFlag();
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
export function eraseSlot(slot: number) { try { localStorage.removeItem(KEY(slot)); } catch { } }

/**
 * Where a file starts the game (TCardLoad then TApplication: a save with Shines to Delfino Plaza,
 * its scenario by the story flags; a new file to the airstrip, after the opening movie)
 */
export function startArea(f: FlagManager): { stage: number; scenario: number; movie?: number } {
    return f.getFlag(MSF.SHINE_COUNT) > 0 ? { stage: 1, scenario: 0xFF } : { stage: 0, scenario: 0, movie: f.getBool(MSF.FMV_OPENING_WATCHED) ? undefined : 1 };
}
