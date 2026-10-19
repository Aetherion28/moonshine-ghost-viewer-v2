// Mario's voice (TMario::startVoice → MSound::startMarioVoice). The game says a voice line from
// the player code where Mario's status changes (setStatusToJumping, damageExec, hipAttacking, ...);
// the viewer has Mario's animation instead, so marioVoiceChange() maps "the animation went from A
// to B" onto those call sites. It takes the change and the little it needs (rising, FLUDD, health),
// so a simulated TMario can call it from its real status changes later (startMarioVoice() is the
// sound side, unchanged). Animation sounds (.bas) with a voice ID go through startMarioVoice too
// (MAnmSound::startAnimSound, category 7).

import { SE } from '../game/soundids.js';
import { A } from '../game/player/tables.js';

/** what a voice line needs besides the change: all optional */
export interface VoiceContext {
    /** Mario's health (TMario::mHealth, 0..8): at 2 or less the tired variants play. Default 8. */
    health?: number;
    /** TMario::getVoiceStatus: 0 Mario, 1 on Yoshi (silent), 2 Shadow Mario, 6 Monte man. Default 0. */
    voiceStatus?: number;
    /** Mario is going up at the change (a jump, not a fall into the same animation) */
    rising?: boolean;
    /** JALCalc::getRandom_0_1 */
    random?: () => number;
    /** FLUDD at the change: its nozzle (TWaterGun: 0 spray, 1 rocket, 2 underwater, 3 yoshi, 4 hover, 5 turbo) and whether it's spraying */
    fludd?: { nozzle: number; spraying: boolean } | null;
}
export interface VoiceLine {
    /** the ID startVoice is called with (before startMarioVoice's variants) */
    id: number;
    /** game frames after the change (e.g. kickRoofRollUp's 8) */
    delay?: number;
}

/** MSound::startMarioVoice's reaction voices: said only when no voice is playing */
const QUIET_ONLY = new Set<number>([SE.MV27_SPRISE_01, SE.MV20_JMP_PT_REACT_01, SE.MV10A_CRY_SHORT_01, SE.MV07_DAMAGE_REACT_01,
    SE.MV26_JUMP_REACT_01, SE.MV29_SPRISE_REACT_01, SE.MV28_SPRISE_SMALL_01, SE.MV30_FRIGHT_01]);

/**
 * MSound::startMarioVoice: the ID actually played for a startVoice ID (-1: nothing), and whether it
 * waits for silence. Health 2 or less swaps in the tired lines; some lines are swapped at random
 * for the older "MA_VO" takes.
 */
export function startMarioVoice(id: number, ctx: VoiceContext = {}): { id: number; ifQuiet: boolean } {
    const health = ctx.health ?? 8, status = ctx.voiceStatus ?? 0, rnd = ctx.random || Math.random;
    const no = { id: -1, ifQuiet: false };
    if (status & 1) return no;
    if (status === 6) {
        // Monte man: his own jump line for any jump
        return ([SE.MV21_JUMP_SMALL_01, SE.MV22_JUMP_MID_01, SE.MV23_JUMP_LARGE_01, SE.MV24_JUMP_SPECIAL_01, SE.MV25A_JUMP_HUGE_01] as number[]).includes(id)
            ? { id: SE.NPC_VA_MTMAN_JUMP1, ifQuiet: false } : no;
    }
    const ifQuiet = QUIET_ONLY.has(id);
    const r = (p: number) => status !== 2 && rnd() < p;
    switch (id) {
        case SE.MV01_DAMAGE_BIG_01: if (r(0.25)) id = SE.MA_VO_DAMAGE_BIG; break;
        case SE.MV02_DAMAGE_MID_01: case SE.MV03_DAMAGE_LITLE_01: if (r(0.25)) id = SE.MA_VO_DAMAGE_SMALL; break;
        case SE.MV07_DAMAGE_REACT_01: case SE.MV12_REACT_01: if (health <= 2) id = SE.MV33_T_01; break;
        case SE.MV08A_DOWN_01: if (r(0.15)) id = SE.MA_VO_DEAD; break;
        // (MV10A_CRY_SHORT_01 starts MSRandPlay's random cries in the game: here the first one)
        case SE.MV13_ACTION_SMALL_01: case SE.MV17_EXERT_REACT_01: if (health <= 2) id = SE.MV34_ACTION_T_01; break;
        case SE.MV15_EXERT_INST_01: if (health <= 2) id = SE.MV38_EXERT_INST_T_01; break;
        case SE.MV21_JUMP_SMALL_01: if (health <= 2) id = SE.MV41_JUMP_T_01; else if (r(0.3)) id = SE.MA_VO_JUMP_SMALL_0; break;
        case SE.MV22_JUMP_MID_01: if (health <= 2) id = SE.MV41_JUMP_T_01; else if (r(0.7)) id = SE.MA_VO_JUMP_MID_0; break;
        case SE.MV23_JUMP_LARGE_01: if (health <= 2) id = SE.MV41_JUMP_T_01; else if (r(0.5)) id = SE.MA_VO_JUMP_BIG_0; break;
        case SE.MV24_JUMP_SPECIAL_01: if (health <= 2) id = SE.MV41_JUMP_T_01; else if (r(0.5)) id = SE.MA_VO_JUMP_SPECIAL_0; break;
        case SE.MV25A_JUMP_HUGE_01: if (health <= 2) id = SE.MV42_JUMP_HUGE_T_01; break;
        case SE.MV26_JUMP_REACT_01:
            if (health <= 2) { id = SE.MV33_T_01; break; }
            if (r(0.5)) id = SE.MA_VO_LAND_HI_0;
            if (r(0.5)) id = SE.MA_VO_LAND_LOW_0;
            break;
        case SE.MV31_OPEN_DOOR_01: if (health <= 2) id = SE.MV46A_OPEN_DOOR_T_01; break;
        case 0xFFFFFFFE: case -2: id = health <= 2 ? SE.MV46B_NEXT_STG_T_01 : SE.MV31_OPEN_DOOR_01; break;
    }
    return { id, ifQuiet };
}

// animations that are the damage statuses' (damageExec → changePlayerDropping(animationTypes[..]))
const DAMAGE_LITTLE = new Set<number>([A.SFBDN, A.SFFDN]);   // safe back/fore down: damage type 0
const DAMAGE_MID = new Set<number>([A.SDOWN, A.SHFDN, A.BDWN, A.SDWNF, A.BKDWN, A.JFDWN]);   // short / full downs, in the air and on the ground
const BACK_JUMP = 0xF7;   // backJumping's animation (no name in the table)

/**
 * The voice line for Mario's animation going from `from` to `to` (null: none). The table follows
 * the decomp's startVoice calls:
 *  - setStatusToJumping: jump MV21, second jump / wall jump / long jump / dive rollout MV22,
 *    triple jump / backflip / side flip / spin jump MV23, dive (jump catch) MV13
 *  - hipAttacking MV15, hanging → hang jump MV15, checkThrowObject MV15, kickRoofRollUp MV15_02
 *  - damageExec MV03 / MV02, fireJumping MV05, fireDowning's end MV07, the electric shock MV04
 *  - setStatusToJumping's rocket (FLUDD spraying as the jump turns into ANIM_LAND): rocket MV24,
 *    turbo MV15, hover MV21
 *  - setStatusToRunning (slip) MV27, loserDown MV08A (MV08B follows), the door MV31
 */
export function marioVoiceChange(from: number, to: number, ctx: VoiceContext = {}): VoiceLine | null {
    if (from === to) return null;
    const up = ctx.rising !== false;
    switch (to) {
        case A.JUMP: return up ? { id: SE.MV21_JUMP_SMALL_01 } : null;
        case A['2JMP1']: return up ? { id: SE.MV22_JUMP_MID_01 } : null;
        case A.WJMP: return { id: SE.MV22_JUMP_MID_01 };
        case A.BROAD_JUMP: return { id: SE.MV22_JUMP_MID_01 };
        case A.ROLL_JUMP: return { id: SE.MV22_JUMP_MID_01 };
        case A.ROLL: return up ? { id: SE.MV23_JUMP_LARGE_01 } : null;
        case BACK_JUMP: return { id: SE.MV23_JUMP_LARGE_01 };
        case A.TJMP1: return { id: SE.MV23_JUMP_LARGE_01 };
        case A.SPIN_P: return up ? { id: SE.MV23_JUMP_LARGE_01 } : null;
        case A.SLDCT: return { id: SE.MV13_ACTION_SMALL_01 };
        // rocketCheck → MARIO_STATUS_ROCKET (rocketing shows ANIM_LAND): the nozzle's line
        case A.LAND: {
            const w = ctx.fludd;
            if (!w || !w.spraying || ctx.rising !== true) return null;
            return w.nozzle === 1 ? { id: SE.MV24_JUMP_SPECIAL_01 } : w.nozzle === 5 ? { id: SE.MV15_EXERT_INST_01 } : w.nozzle === 4 ? { id: SE.MV21_JUMP_SMALL_01 } : null;
        }
        case A.HIPSR: return { id: SE.MV15_EXERT_INST_01 };
        case A.HGJMP: return from === A.HANG ? { id: SE.MV15_EXERT_INST_01 } : null;
        case A.THROW: return { id: SE.MV15_EXERT_INST_01 };
        case A.LADDER_ROLL_UP: return { id: SE.MV15_EXERT_INST_02, delay: 8 };
        case A.FIREJMP: return { id: SE.MV05_DAMAGE_FIRE_01 };
        case A.FJPEND: return { id: SE.MV07_DAMAGE_REACT_01 };
        case A.SHOCK: return { id: SE.MV04_DAMAGE_ELEC_01 };
        case A.SLIP: return { id: SE.MV27_SPRISE_01 };
        case A.DIE: return { id: SE.MV08A_DOWN_01 };
        case A.DOOR_OPENR: case A.DOOR_OPENL: return { id: SE.MV31_OPEN_DOOR_01 };
    }
    if ((DAMAGE_LITTLE.has(to) || DAMAGE_MID.has(to)) && !DAMAGE_LITTLE.has(from) && !DAMAGE_MID.has(from))
        return { id: DAMAGE_LITTLE.has(to) ? SE.MV03_DAMAGE_LITLE_01 : SE.MV02_DAMAGE_MID_01 };
    return null;
}

/** a .bas entry's ID that MAnmSound::startAnimSound sends to startMarioVoice (get_thing() == 7) */
export function isAnimVoice(id: number) { return (id >>> 30) === 0 && ((id >>> 12) & 0xF) === 7; }
