// v3: the game versions the replay is set up for: where each has what the replay hooks and reads.
// JP 1.0's tables are written by hand (`JP10` in replay.ts, syms_jp10.ts); the others' are carried over from
// them by tools/gen_addrs.mjs (addrs_gen.ts). A version is told by its disc's ID and revision, and, where two
// share those (PAL and 3D All-Stars), by the size of its DOL.
import { JP10, type GameAddrs } from './replay.js';
import { SYMS_JP10 } from './syms_jp10.js';
import { JP11, SYMS_JP11, US, SYMS_US, PAL, SYMS_PAL, PAL_3DAS, SYMS_PAL_3DAS, DOL_SIZES } from './addrs_gen.js';
import type { Sym } from '../ppc/hle.js';

export interface GameVersion {
    key: string;
    /** in plain words */
    name: string;
    gameId: string; revision: number; dolSize: number;
    addrs: GameAddrs; syms: Record<string, number>;
    /** the decomp's config folder (the Node tests read its symbols.txt for names) */
    decomp: string;
}
export const VERSIONS: GameVersion[] = [
    { key: 'JP10', name: 'the Japanese version 1.0', gameId: 'GMSJ01', revision: 0, dolSize: DOL_SIZES.JP10, addrs: JP10, syms: SYMS_JP10, decomp: 'GMSJ01' },
    { key: 'JP11', name: 'the Japanese version 1.1', gameId: 'GMSJ01', revision: 1, dolSize: DOL_SIZES.JP11, addrs: JP11, syms: SYMS_JP11, decomp: 'GMSJ01_01' },
    { key: 'US', name: 'the North American version', gameId: 'GMSE01', revision: 0, dolSize: DOL_SIZES.US, addrs: US, syms: SYMS_US, decomp: 'GMSE01' },
    { key: 'PAL', name: 'the PAL version', gameId: 'GMSP01', revision: 0, dolSize: DOL_SIZES.PAL, addrs: PAL, syms: SYMS_PAL, decomp: 'GMSP01' },
    { key: 'PAL_3DAS', name: 'the 3D All-Stars version', gameId: 'GMSP01', revision: 0, dolSize: DOL_SIZES.PAL_3DAS, addrs: PAL_3DAS, syms: SYMS_PAL_3DAS, decomp: 'GMSP01_NX' },
];
/** The version of a disc (or of a recording, which has no DOL: then the first with that ID and revision, the retail one). */
export function versionOf(gameId: string, revision: number, dolSize = 0): GameVersion | undefined {
    const same = VERSIONS.filter((v) => v.gameId === gameId && v.revision === revision);
    return dolSize ? same.find((v) => v.dolSize === dolSize) : same[0];
}
export const symOf = (v: GameVersion): Sym => (name) => v.syms[name];
