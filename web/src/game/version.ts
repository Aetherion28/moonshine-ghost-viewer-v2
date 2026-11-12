// The game version being simulated, mirroring the decomp's build macros.
//
// The decomp is one source tree shared by every regional repository (Aetherion28/SMS-Decomp-JP-1.0,
// -JP-1.1, -US, -KOR, -PAL, -3DAS): "every change between releases is behind a version check"
// (docs/REGIONAL_COMPARISON.md). Each build defines exactly one of VERSION_GMSJ01 (JP 1.0),
// VERSION_GMSJ01_01 (JP 1.1), VERSION_GMSE01 (US), VERSION_GMSP01 (PAL) or VERSION_GMSP01_NX
// (3D All-Stars), and the Korean image is built as GMSE01 plus VERSION_GMSE01_KR (its region.json).
// So a branch here is written exactly as the decomp writes it, with V.GMSJ01 for
// defined(VERSION_GMSJ01) and so on: `#if !defined(VERSION_GMSJ01)` is `if (!V.GMSJ01)`.
//
// The version follows the ghost being simulated (its game ID and disc revision), so a PAL ghost
// runs the PAL code whichever disc is loaded; with no ghost (live play) it is the disc's.

export type GameVersion = 'GMSJ01' | 'GMSJ01_01' | 'GMSE01' | 'GMSP01' | 'GMSP01_NX';

export const V = {
    id: 'GMSJ01' as GameVersion,
    GMSJ01: true, GMSJ01_01: false, GMSE01: false, GMSP01: false, GMSP01_NX: false,
    /** VERSION_GMSE01_KR: the Korean image (GMSE01, disc revision 48); only its strings differ */
    GMSE01_KR: false,
    /**
     * VIGetTvFormat() == VI_PAL: a PAL game running at 50 Hz. Only PAL and 3D All-Stars can; their
     * 60 Hz mode (and every other region) is VI_EURGB60 / VI_NTSC / VI_MPAL, 60 Hz.
     */
    pal50: false,
};

/**
 * TLiveActor's live flags (Strategic/LiveActor.hpp). From UNK4000 on, VERSION_SELECT gives the US / PAL values
 * and GMSJ01's are half of them (JP 1.0 has no CALC_INT_FRAME bit, so its later flags sit one bit lower):
 * setVersion sets them.
 */
const LF_US = {
    DEAD: 0x1, HIDDEN: 0x2, CLIPPED_OUT: 0x4, UNK8: 0x8, UNK10: 0x10, UNK20: 0x20, UNK40: 0x40, AIRBORNE: 0x80,
    ENABLE_CLIPPING: 0x100, UNK200: 0x200, FORCE_SHADOW: 0x400, UNK800: 0x800, UNK1000: 0x1000, UNK2000: 0x2000,
    UNK4000: 0x8000, UNK8000: 0x10000, UNK10000: 0x20000, UNK20000: 0x40000, UNK40000: 0x80000, UNK80000: 0x100000,
    UNK100000: 0x200000, UNK200000: 0x400000, UNK400000: 0x800000, UNK1000000: 0x2000000,
    /** LIVE_FLAG_CALC_INT_FRAME: only PAL, JP 1.1 and 3D All-Stars (LiveActor.hpp) have it, the bit the US / PAL table leaves free */
    CALC_INT_FRAME: 0x4000,
};
export const LF = { ...LF_US };
function setLiveFlags(jp10: boolean) {
    for (const k of Object.keys(LF_US) as (keyof typeof LF_US)[]) {
        const v = LF_US[k];
        (LF as any)[k] = jp10 && k !== 'CALC_INT_FRAME' && v >= 0x8000 ? v >>> 1 : v;
    }
}
setLiveFlags(true);

/** Kept for the existing PAL-only call sites; prefer V. */
export const VERSION = { id: 'GMSJ01', pal: false };

/** (game ID prefix, disc revision) as a ghost or a disc header has them, to the build they ran. */
export function versionFor(gameId: string, revision: number): { id: GameVersion; kr: boolean } | null {
    const g = gameId.slice(0, 4);
    if (g === 'GMSJ') return { id: revision === 1 ? 'GMSJ01_01' : 'GMSJ01', kr: false };
    if (g === 'GMSE') return { id: 'GMSE01', kr: revision === 48 };
    if (g === 'GMSP') return { id: 'GMSP01', kr: false };
    return null;
}

export function setVersion(id: GameVersion, o: { kr?: boolean; pal50?: boolean } = {}) {
    V.id = id;
    V.GMSJ01 = id === 'GMSJ01'; V.GMSJ01_01 = id === 'GMSJ01_01'; V.GMSE01 = id === 'GMSE01';
    V.GMSP01 = id === 'GMSP01'; V.GMSP01_NX = id === 'GMSP01_NX';
    V.GMSE01_KR = V.GMSE01 && !!o.kr;
    V.pal50 = (V.GMSP01 || V.GMSP01_NX) && !!o.pal50;
    VERSION.id = id; VERSION.pal = V.GMSP01;
    setLiveFlags(V.GMSJ01);
}

/** The disc's own version (the boot.bin game ID; revision byte 0x07). */
const disc = { id: 'GMSJ01' as GameVersion, kr: false };
export function setGameVersion(id: string, revision = 0) {
    const v = versionFor(id, revision);
    disc.id = v ? v.id : 'GMSJ01'; disc.kr = v ? v.kr : false;
    setVersion(disc.id, { kr: disc.kr });
}
/** Back to the disc's version (live play has no ghost to follow). */
export function useDiscVersion() {
    if (V.id !== disc.id || V.GMSE01_KR !== disc.kr || V.pal50) setVersion(disc.id, { kr: disc.kr });
}

/** A parsed ghost's version, or null when the ghost doesn't say. */
export function ghostVersion(g: any): { id: GameVersion; kr: boolean; pal50: boolean } | null {
    const h = g && g.header;
    if (!h || !h.gameId) return null;
    const v = versionFor(h.gameId, h.discRevision | 0);
    return v ? { ...v, pal50: false } : null;   // ghosts are always 60 Hz
}

/** Make the ghost's version current (no change when it doesn't say). */
export function useGhostVersion(g: any) {
    const v = ghostVersion(g);
    if (!v) { useDiscVersion(); return; }
    if (v.id !== V.id || v.kr !== V.GMSE01_KR || v.pal50 !== V.pal50) setVersion(v.id, v);
}

/**
 * VERSION_SELECT(default, GMSJ01(a), GMSE01(b), ...): the value listed for the current version, else
 * the default. Pass the per-version values as an object: select(0x8000, { GMSJ01: 0x4000, GMSE01: 0x4000 }).
 */
export function select<T>(def: T, per: Partial<Record<GameVersion, T>>): T {
    const v = per[V.id];
    return v === undefined ? def : v;
}

/**
 * SMSGetVSyncTimesPerSec(): the game's frames a second. Every build gives half the VI rate;
 * VIGetTvFormat() is VI_PAL (50 Hz) only for a PAL game set to 50 Hz.
 */
export function vsyncTimesPerSec() { return (V.pal50 ? 50 : 60) / 2; }
/** SMSGetAnmFrameRate(): 60 / SMSGetVSyncTimesPerSec(), 2 at 60 Hz and 2.4 at 50 Hz. */
export function anmFrameRate() { return Math.fround(60 / vsyncTimesPerSec()); }

/** A short label for the UI. */
export function versionLabel(id: GameVersion = V.id, kr = V.GMSE01_KR) {
    return ({ GMSJ01: 'JP 1.0', GMSJ01_01: 'JP 1.1', GMSE01: kr ? 'KOR' : 'US', GMSP01: 'PAL', GMSP01_NX: '3D All-Stars' } as const)[id];
}
