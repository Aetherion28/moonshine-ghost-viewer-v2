// v3: what Moonshine (the mod that records the traces) changes in the game, so that a replay runs the same
// code the recording console ran. From Moonshine's source (pr69: src/features.cpp, src/main.cpp,
// scripts/patches.py); addresses are (JP 1.0, US, PAL) as there.
//
//   - the mod is linked into the bottom of the arena: OSGetArenaLo reports the floor 0xC2000 higher, so every
//     heap address is that much higher than in the retail game;
//   - onSetup (in place of direct()'s setupObjects call) clears gpPollution first;
//   - the settings' instruction patches (gFeaturePatches), asm hooks (kAsmHooks, their caves run here as the
//     PowerPC code they are) and choice patches (applyChoices), switched as the session record changes.
//
//   - the controls written in C++ (Moonshine's main repository, Dogecyanide/susamune, the same files as
//     panther03/moonshine V2.3.3: src/pattern_selector.cpp, rng_control.cpp, ricco_fruit.cpp,
//     gelato_patterns.cpp, force_box_game.cpp; their sites in scripts/patches.py): ported as hooks at the same
//     sites (`installControls`). Each keeps the retail rand() call where Moonshine keeps it.
//
// Not reproduced: No Shine Get Animation, the gameplay speed, fast forward, the free camera, the level warps.
// `unsupported()` names the ones a session has on.
import type { Machine } from '../ppc/machine.js';

export type Region = 0 | 1 | 2 | -1;   // JP 1.0, US, PAL; -1: a version Moonshine has no build for
/** Moonshine's simulation settings: the session record's byte offsets (GhostSimulation::Field) */
export const F = {
    FAST_TEXT: 0, FLUDD_SECRETS: 1, AREA_LOCK: 2, INFINITE_LIVES: 3, DISABLE_BLUE_COIN: 4, FMV_SKIPS: 5, UNLOCK_YOSHI: 6, UNLOCK_NOZZLES: 7,
    FREE_PAUSE: 8, EXIT_AREA_EVERYWHERE: 9, ANY_FRUIT_YOSHI: 10, INFINITE_JUICE: 11, INTRO_SKIP: 12, RESPAWN_SHINES: 13, FAST_PIANTISSIMO: 14,
    SAVE_RNG_STATE: 15, NOZZLE_LOCK: 16, FORCE_PLAZA_EVENTS: 17, NEVER_PAUSE_IGT: 18, SHADOW_MARIO_HP: 19, STAGE_INTRO_SKIP: 20,
    DEATHLESS_BLOOPER: 21, NO_SHINE_ANIM: 22, FRUIT_NEVER_TIMEOUT: 23, DISABLE_Z_MENU: 24, DISABLE_WARPS: 25, DISABLE_THIRD_CHOMPLET_AGGRO: 26,
    PATTERN_SELECTOR: 27, FORCE_BOX_GAME: 28, YOSHI_NOZZLE_SAVE_PROMPT: 29, DISABLE_RETAIL_PAUSE: 30, KING_BOO_ALWAYS_FRUIT: 31,
    PETEY_NO_TORNADO: 32, PETEY_ROUTE: 33, RICCO_CRANE_SPEED: 34, RICCO_FRUIT_MACHINE: 35, GELATO_RED_COIN_FISH_PATTERN: 36,
    GELATO_BLUE_BIRD_PATTERN: 37, GAMEPLAY_SPEED: 38, SLOWDOWN_PRESET: 39, EFFECTIVE_FAST_TEXT: 40, PATTERN_0: 41, PATTERN_1: 42, PATTERN_2: 43,
    FAST_FORWARD_ACTIVE: 44, FREE_CAMERA_ACTIVE: 45, SIRENA_PINEAPPLE_REMOVED: 46,
} as const;

const R3 = (jp: number, us: number, pal: number) => [jp, us, pal] as [number, number, number];
type Row = [jp: number, us: number, pal: number, value: number | [number, number, number], mask?: number];
/** gFeaturePatches: a setting and the words it writes while on (mask 0xFFFF0000: only the high half) */
const PATCHES: { field: number; rows: Row[] }[] = [
    { field: F.INFINITE_LIVES, rows: [[0x800EBD80, 0x80298814, 0x802906AC, 0x60000000]] },
    { field: F.UNLOCK_NOZZLES, rows: [[0x800E79F8, 0x8029443C, 0x8028C254, 0x38600001], [0x800E79FC, 0x80294440, 0x8028C258, 0x4E800020]] },
    { field: F.UNLOCK_YOSHI, rows: [[0x80193F58, 0x801BBF70, 0x801B3E28, 0x48000034], [0x80193F9C, 0x801BBFB4, 0x801B3E6C, 0x4800001C]] },
    { field: F.ANY_FRUIT_YOSHI, rows: [[0x801948E8, 0x801BC900, 0x801B47B8, 0x60000000]] },
    { field: F.INFINITE_JUICE, rows: [[0x8014DB88, 0x8026E810, 0x8026659C, 0x60000000]] },
    { field: F.EXIT_AREA_EVERYWHERE, rows: [[0x80218054, 0x80156B78, 0x8014BB94, 0x4800000C]] },
    { field: F.FMV_SKIPS, rows: [[0x8010AF5C, 0x802B5EF4, 0x802ADE20, 0x38600001], [0x8010AFC0, 0x802B5E8C, 0x802ADE88, 0x38600001]] },
    { field: F.RESPAWN_SHINES, rows: [[0x801BF378, 0x801E792C, 0x801DF804, 0x48000050], [0x801BFA48, 0x801E7FFC, 0x801DFED4, 0x48000000, 0xFFFF0000], [0x801D72E8, 0x801FF85C, 0x801F7740, 0x48000000, 0xFFFF0000]] },
    { field: F.FRUIT_NEVER_TIMEOUT, rows: [[0x804091A8, 0x8040C918, 0x80404078, 0x7FFFFFFF]] },
    { field: F.SHADOW_MARIO_HP, rows: [[0x80253748, 0x8003FD94, 0x8003FBE4, 0x60000000]] },
    { field: F.FREE_PAUSE, rows: [[0x800EB06C, 0x80297AB0, 0x8028F948, 0x4800000C]] },
    { field: F.DISABLE_BLUE_COIN, rows: [[0x800E7B20, 0x80294564, 0x8028C37C, 0x60000000]] },
    { field: F.NEVER_PAUSE_IGT, rows: [[0x80092968, 0x80348048, 0x803402A4, 0x4E800020], [0x8020CA84, 0x8014B628, 0x801402B8, 0x4E800020]] },
    { field: F.FORCE_PLAZA_EVENTS, rows: [[0x8010C4C8, 0x802B7810, 0x802AF7E0, 0x48000018], [0x8010C514, 0x802B785C, 0x802AF82C, 0x48000018], [0x8010C57C, 0x802B78C4, 0x802AF894, 0x48000018], [0x8010C5A8, 0x802B78F0, 0x802AF8C0, 0x60000000], [0x8010C5F8, 0x802B7940, 0x802AF910, 0x60000000]] },
    { field: F.EFFECTIVE_FAST_TEXT, rows: [[0x80215290, 0x80153DA0, 0x80148D20, 0x38000000], [0x80214610, 0x8015317C, 0x80147F98, 0x38005000], [0x800E4888, 0x80291340, 0x802890CC, 0x60000000]] },
    { field: F.DISABLE_Z_MENU, rows: [[0x800EB020, 0x80297A64, 0x8028F8FC, 0x4800000C]] },
    // rng_control.cpp applyPeteyTornadoControl: the branch to the tornado attack never taken
    { field: F.PETEY_NO_TORNADO, rows: [[0x802A33AC, 0x80090590, 0x80089C30, 0x60000000]] },
];
// The settings Moonshine's session record doesn't carry (Mute BGM, Shine Outfit, Shiny Shines, the appearance
// choices, Replace Episode Names) only change sound and looks. But a look is a model, and a model is heap:
// Shiny Shines (every Shine drawn yellow: TShine skips its "already collected?" test) makes a collected Shine
// share the item manager's model instead of loading the blue one, and everything allocated after it sits lower.
// So it is an option here, chosen by the evidence: Mario's address in his first record (see Replay).
const SHINY_SHINES: Row = [0x80194E24, 0x801BCE3C, 0x801B4CF4, 0x4800004C];

/** kAsmHooks: a site that branches into a cave of PowerPC code, whose last word branches back to site + 4 */
const HOOKS: { field: number; site: [number, number, number]; cave: (number | [number, number, number])[]; mode?: number }[] = [
    // Il Piantissimo's replay: the fastest pattern (setting 2) or the slowest (setting 1)
    { field: F.FAST_PIANTISSIMO, mode: 2, site: R3(0x80256A14, 0x80043064, 0x80042EDC), cave: [0x8BFA007C, 0x23FF000C, 0x57FFFFBE, 0] },
    { field: F.FAST_PIANTISSIMO, mode: 1, site: R3(0x80256A14, 0x80043064, 0x80042EDC), cave: [0x8BFA007C, 0x1FFF0005, 0x57FFFFBE, 0] },
    // TFireWanwan::isFindMario: instance 1 (the far-right Chomplet) never finds Mario
    { field: F.DISABLE_THIRD_CHOMPLET_AGGRO, site: R3(0x8029E508, 0x8008B578, 0x80084C18), cave: [0xA183007C, 0x2C0C0001, 0x4082000C, 0x38600000, 0x4E800020, 0x7C0802A6, 0] },
    { field: F.NEVER_PAUSE_IGT, site: R3(0x8009292C, 0x8034800C, 0x80340268), cave: [0x80030030, 0x2C000000, 0x4C820020, 0x7C0802A6, 0] },
    {
        field: F.DEATHLESS_BLOOPER, site: R3(0x801397D0, 0x8025A340, 0x802520CC), cave: [R3(0x818D9A10, 0x818D9D48, 0x818D9C70), 0x812C0018, 0x814C0014, 0x554A103A,
        0x7D495214, 0x858AFFFC, 0x800C0000, 0x6C00803C, R3(0x280060C0, 0x2800E6C8, 0x28005EB8), 0x40A20010, 0xA00C00F2, 0x7000FFF6, 0xB00C00F2, 0x7C0A4840, 0x4181FFDC, 0],
    },
    { field: F.DISABLE_BLUE_COIN, site: R3(0x800FA12C, 0x802A6728, 0x8029E680), cave: [0x7CA00039, R3(0x80AD97D0, 0x80AD9FA0, 0x80AD9EC8), 0x38800000, 0x908500D4, 0] },
    {
        field: F.FREE_PAUSE, site: R3(0x800EAF90, 0x802979D4, 0x8028F86C), cave: [0x887F007C, 0x2803000F, 0x41820028, 0x807F0018, 0x80630000, 0x806300D4, 0x546307FF, 0x41820014,
        R3(0x3C60800E, 0x3C608029, 0x3C608028), R3(0x6063B038, 0x60637A7C, 0x6063F914), 0x7C6803A6, 0x4E800020, 0x881F0124, 0],
    },
    {
        field: F.FORCE_PLAZA_EVENTS, site: R3(0x8010C41C, 0x802B7764, 0x802AF734), cave: [R3(0x806D97D0, 0x806D9FA0, 0x806D9EC8), 0x899D0001, 0x558BF7BC, 0x7D8C5B78, 0x558C16FA, 0x3D60FFF3,
        0x616BFF01, 0x5D6B6636, 0x99630070, 0],
    },
    {
        // runs the stage's intro to its end inside one frame (direct + 0x158), and skips it without a button (changeState + 0x1CC)
        field: F.STAGE_INTRO_SKIP, site: R3(0x800ECF14, 0x80299990, 0x80291828), cave: [0x899A0064, 0x2C0C0001, 0x40A20040, 0x819A0074, 0x818C0094, R3(0x816C02BC, 0x816C02B8, 0x816C08DC), 0x2C0B0003,
        0x41A1002C, 0x41A00018, R3(0x3D80803E, 0x3D80803F, 0x3D80803E), R3(0x818C6034, 0x818C9734, 0x818C10F4), 0x39600000, 0x916C0018, 0x48000014, 0x3863000F, 0x907A0054, 0x3B800000, 0x48000008, 0xB01A004C, 0],
    },
    { field: F.STAGE_INTRO_SKIP, site: R3(0x800EC5D0, 0x8029904C, 0x80290EE4), cave: [0x807F0074, 0x80630094, R3(0x806302BC, 0x806302B8, 0x806308DC), 0x2C830000, 0x70000061, 0x4C423102, 0] },
];
/** applyChoices: the nozzle lock (li r31, id) and FLUDD in the secrets (two sites in TRedCoinSwitch::load / setMario) */
const NOZZLE_SITE = R3(0x801494D4, 0x80269F50, 0x80261CDC), NOZZLE_IDS = [1, 5, 4];
const FLUDD_SITES = [R3(0x80198784, 0x801C0910, 0x801B87C8), R3(0x800EC0F4, 0x80298B88, 0x80290A20)];

/** the settings not reproduced here: [field, what it changes] */
const UNSUPPORTED: [number, string][] = [
    [F.NO_SHINE_ANIM, 'No Shine Get Animation'], [F.GAMEPLAY_SPEED, 'gameplay speed'], [F.FAST_FORWARD_ACTIVE, 'fast forward'], [F.FREE_CAMERA_ACTIVE, 'free camera'],
];
/** settings that act only in some stages (by the stage archive's name), not reproduced here */
const UNSUPPORTED_IN: [number, RegExp, string][] = [];

// ---- the controls written in C++ (see the header): their sites and tables, (JP 1.0, US, PAL)
/** TSpineEnemy::goToRandomNextGraphNode's call of TGraphWeb::getRandomNextIndex (the function + 0x50; Moonshine replaces the whole function) */
const GRAPH_NEXT_CALL = R3(0x8024F32C, 0x8003B6FC, 0x8003B54C);
const VT_FIRE_WANWAN = R3(0x803D87C0, 0x803B3F88, 0x803ABDA8), VT_BOSS_WANWAN = R3(0x803DA9C0, 0x803B6178, 0x803ADF98), VT_BOSS_PAKKUN = R3(0x803D8E0C, 0x803B45D4, 0x803AC3F4);
/** pattern_selector.cpp kChompletPaths: [current node << 8 | the name's digit, the next node for patterns 1..4 (0xFF: random)] */
const CHOMPLET_PATHS: [number, number[]][] = [
    [0x2132, [0x45, 0x20, 0x20, 0xFF]], [0x1D32, [0xFF, 0x62, 0x1C, 0xFF]], [0x2630, [0x50, 0x25, 0x25, 0x25]], [0x2130, [0xFF, 0x45, 0x20, 0x20]],
    [0x1D30, [0xFF, 0xFF, 0x62, 0x1C]], [0x0831, [0x51, 0x07, 0x07, 0xFF]], [0x0231, [0xFF, 0x36, 0x01, 0xFF]],
];
const BOSS_PATHS = [0x1E, 0x6E, 0x20];
const PETEY_PATH = [1, 2, 3, 10, 3, 4, 7, 8, 12, 10, 8, 4, 16, 3, 11, 12, 9, 3];
const TYPE_ANIMAL_BIRD = 0x00800001, TYPE_BLUE_COIN = 0x20000010;
/** gelato_patterns.cpp: the fish's call of getRandomNextIndex (the JP site is Moonshine's; the others are the same call, placed by tools/gen_addrs.mjs) */
const GELATO_FISH_CALL = R3(0x80363E48, 0x80005DDC, 0x80005DDC);
/** force_box_game.cpp: evGetSystemFlag's call of TFlagManager::getFlag */
const BOX_GAME_CALL = R3(0x800E64E8, 0x80292FA0, 0x8028AD2C);
/** rng_control.cpp: King Boo's call of forceStopSlot; the cranes' rand calls (the crane in r31 / r30), their control functions and vtable slots, the up-down speed */
const KING_BOO_CALL = R3(0x802D0F78, 0x800BE8E8, 0x800B7F88);
const CRANE_UPDOWN_RAND = R3(0x801A5ED0, 0x801CE318, 0x801C61D0), CRANE_ROTY_RAND = R3(0x801A625C, 0x801CE6A4, 0x801C655C);
const CRANE_UPDOWN_SLOT = R3(0x803C6638, 0x803CEC40, 0x803C6430), CRANE_ROTY_SLOT = R3(0x803C679C, 0x803CEDA4, 0x803C6594);
const CRANE_UPDOWN_CONTROL = R3(0x801A5F20, 0x801CE368, 0x801C6220), CRANE_ROTY_CONTROL = R3(0x801A62E0, 0x801CE728, 0x801C65E0);
const CRANE_UPDOWN_SPEED = R3(0x804090C4, 0x8040C834, 0x80403F94);
const CRANE_NAMES = ['crane90 0', 'crane90 1', 'crane90 2', 'craneUpDown 0', 'craneUpDown 1'], CRANE_KEYS = [0x5C04, 0x5C05, 0x5C06, 0x09CE, 0x09CF];
/** ricco_fruit.cpp: TFruitLauncher's fire function; its rand calls at +0x134, +0x250, +0x36C (the fruit's choice, three tries) and +0x4A0 (the first speed roll) */
const FRUIT_FIRE = R3(0x801A4FC4, 0x801CD40C, 0x801C52C4), DURIAN_ROLL = 0x6000;
const DIR_AREA = 0x7C, DIR_EPISODE = 0x7D;   // TMarDirector::mAreaID, mEpisodeID
const DIR_STATE = 0x64, DIR_SETUP_DONE = 0x260, STATE_GAME_STARTING = 2;   // TMarDirector::mCurState, _260
// actions.cpp's Regrab Last Held Object: TTakeActor::mHeldObject, TMario::mState and mGrabTarget, the status and the message it
// writes, THitActor::receiveMessage's vtable slot, the bind's default buttons (X and D-pad up) among the buttons a bind can have
const TAKE_HELD = 0x6C, MARIO_STATE = 0x7C, MARIO_GRAB_TARGET = 0x384, MARIO_STATUS_TAKE = 0x383, HIT_MESSAGE_TAKE = 4;
const VT_RECEIVE_MESSAGE = 0xA0, BIND_REGRAB = 0x0408, BIND_BUTTON_MASK = 0x1F7F;
// practice_session.cpp: direct()'s calls of TObjHitCheck::checkActorsHit and clearHitNum, the talk object's perform, TMarDirector::_11 (the talk object)
const HIT_CHECK_CALLS = [R3(0x800ED07C, 0x80299AF8, 0x80291990), R3(0x800ED088, 0x80299B04, 0x8029199C)];
const TALK_PERFORM = R3(0x802130A8, 0x80151C88, 0x80146AA4), DIR_TALK = 0xB0;

export const ARENA_RESERVE = 0xC2000;   // the mod's region (0xC0000) and the debug stack OSInit returns to the arena (0x2000)

export interface MoonshineAddrs { OSGetArenaLo: number; arenaLoVar: number; setupObjectsCall: number; gpPollution: number; fastTextCall: number; gpMarDirector: number; gpMarioAddress: number; padStatus: number }

export class Moonshine {
    private region: Region;
    private caveAt: number;
    private caves = new Map<number, number>();   // hook index -> its cave's address
    private orig = new Map<number, number>();   // address -> the retail word
    private on = new Set<number>();   // addresses now patched
    private session = new Uint8Array(64);
    private fastTextMsg = 0;
    /** where the mod sits: the reserved bottom of the arena (set when the game first asks for the arena) */
    base = 0;

    constructor(private m: Machine, region: Region, private A: MoonshineAddrs) { this.region = region; this.caveAt = 0; }
    private pick(v: number | [number, number, number]) { return typeof v === 'number' ? v : v[this.region]; }

    /** this frame's director call is one the practice session froze (PracticeSession::freezeRequested) */
    practiceFrozen = false;

    /** The parts that are always there: the raised arena floor, onSetup, the practice session's hooks. */
    install() {
        if (this.region < 0) return;
        const { m, A } = this, cpu = m.cpu;
        cpu.hook(A.OSGetArenaLo, (c) => {
            const lo = m.mem.r32(A.arenaLoVar);
            if (!this.base) { this.base = lo; this.caveAt = lo + 0x1000; this.fastTextMsg = lo + 0x800; m.mem.ram.set([0x81, 0x49, 0x81, 0x49, 0x81, 0x49, 0], this.fastTextMsg & 0x01FFFFFF); }
            c.gpr[3] = (lo + ARENA_RESERVE) >>> 0;
        });
        // onSetup: TPollutionManager's destructor never clears gpPollution; Moonshine does before setupObjects
        cpu.hook(A.setupObjectsCall, () => { m.mem.w32(A.gpPollution, 0); return false; });
        // The practice session (practice_session.cpp) calls the hit check and its clearing through functions of its own,
        // which do nothing while it holds the stage (susamunePracticeHitCheck / HitClear), and takes the two update
        // cues from the director's talk object then (susamunePracticeTalkPerform).
        for (const call of HIT_CHECK_CALLS) cpu.hook(call[this.region], (c) => { if (!this.practiceFrozen) return false; c.pc = call[this.region] + 4; return true; });
        cpu.hook(TALK_PERFORM[this.region], (c) => {
            if (this.practiceFrozen) { const d = m.mem.r32(A.gpMarDirector); if (d && c.gpr[3] === m.mem.r32(d + DIR_TALK)) c.gpr[4] = (c.gpr[4] & ~3) >>> 0; }
            return false;
        });
        // setupFastTextBox (in place of setMessageID's fallback call to setupTextBox): with Fast Text on, the message is "!!!"
        cpu.hook(A.fastTextCall, (c) => { if (this.session[F.EFFECTIVE_FAST_TEXT]) c.gpr[4] = (this.fastTextMsg - m.mem.r32(c.gpr[5])) >>> 0; return false; });
    }

    // ---------------------------------------------------------------- the controls written in C++
    private cranes = CRANE_NAMES.map(() => ({ actor: 0, retailSpeed: 0, roll: -1, speedCaptured: false }));
    private kingBooSlot = 0; private fruitPending = 0;
    private f32buf = new DataView(new ArrayBuffer(4));
    private rf(addr: number) { this.f32buf.setUint32(0, this.m.mem.r32(addr)); return this.f32buf.getFloat32(0); }
    private wf(addr: number, v: number) { this.f32buf.setFloat32(0, v); this.m.mem.w32(addr, this.f32buf.getUint32(0)); }
    private str(addr: number, max = 64) { const mem = this.m.mem; let t = ''; for (let k = 0; k < max && addr; k++) { const c = mem.r8(addr + k); if (!c) break; t += String.fromCharCode(c); } return t; }
    private area() { const d = this.m.mem.r32(this.A.gpMarDirector); return d ? this.m.mem.r8(d + DIR_AREA) : -1; }
    private episode() { const d = this.m.mem.r32(this.A.gpMarDirector); return d ? this.m.mem.r8(d + DIR_EPISODE) : -1; }
    /** rngControlBeforeStageSetup, riccoFruitControlBeforeStageSetup, actionsOnStageLoad: what the controls remember, forgotten as a stage starts */
    beforeStageSetup() {
        this.kingBooSlot = 0; this.fruitPending = 0; this.lastHeld = 0;
        for (const c of this.cranes) { c.actor = 0; c.retailSpeed = 0; c.roll = -1; c.speedCaptured = false; }
    }
    private craneIndex(crane: number, upDown: boolean) {
        if (!crane || this.area() !== 3) return -1;
        const mem = this.m.mem, name = this.str(mem.r32(crane + 4)), key = mem.r16(crane + 8);
        for (let i = upDown ? 3 : 0; i < (upDown ? 5 : 3); i++) if (key === CRANE_KEYS[i] && name === CRANE_NAMES[i]) return i;
        return -1;
    }
    private cranePercent(roll: number) {
        const choice = this.session[F.RICCO_CRANE_SPEED];
        if (choice < 1 || choice > 5) return 0;
        return (choice * 20 - 19 + ((roll * 20) >>> 15)) & 0xFF;
    }
    private findCrane(actor: number, upDown: boolean) {
        const i = this.craneIndex(actor, upDown);
        return i < 0 || this.cranes[i].actor !== actor || this.cranes[i].roll < 0 ? null : this.cranes[i];
    }
    private recordCrane(actor: number, retail: number, upDown: boolean) {
        const i = this.craneIndex(actor, upDown);
        if (i < 0) return;
        const c = this.cranes[i]; c.actor = actor; c.roll = retail & 0xFFFF; c.speedCaptured = false;
    }
    /** pattern_selector.cpp blueBirdSlot */
    private blueBirdSlot(name: number) {
        if (!name) return 0;
        const mem = this.m.mem; let hash = 0, digit = -1;
        for (let k = 0; k < 256; k++) { const c = mem.r8(name + k); if (!c) break; hash = (hash * 33 + c) & 0xFF; if (c >= 0x30 && c <= 0x39) digit = c - 0x30; }
        return digit >= 0 ? (digit !== 0 ? 1 : 0) : hash & 1;
    }
    /** a graph node with two neighbours: the one in `slot` (else -1) */
    private neighbour(graph: number, current: number, slot: number) {
        const mem = this.m.mem;
        if (current < 0 || current >= (mem.r32(graph + 8) | 0)) return -1;
        const node = mem.r32(mem.r32(graph) + current * 16);
        if (!node || ((mem.r16(node + 6) << 16) >> 16) !== 2) return -1;
        return (mem.r16(node + 0x14 + slot * 2) << 16) >> 16;
    }
    /** pattern_selector.cpp selectedBlueCoinBirdNode */
    private blueBirdNode(enemy: number, graph: number, current: number, previous: number) {
        const mem = this.m.mem, pattern = this.session[F.GELATO_BLUE_BIRD_PATTERN];
        if (pattern < 1 || pattern > 4 || previous !== -1 || !enemy || !graph || mem.r32(enemy + 0x4C) !== TYPE_ANIMAL_BIRD) return -1;
        if (current < 0 || current >= (mem.r32(graph + 8) | 0)) return -1;
        const coin = mem.r32(enemy + 0x150);
        if (!coin || mem.r32(coin + 0x4C) !== TYPE_BLUE_COIN) return -1;
        const actorIndex = this.blueBirdSlot(mem.r32(enemy + 4));
        return this.neighbour(graph, current, ((pattern - 1) >> (1 - actorIndex)) & 1);
    }
    /** pattern_selector.cpp selectedNode */
    private selectedNode(enemy: number, current: number, previous: number) {
        if (!this.session[F.PATTERN_SELECTOR]) return -1;
        const mem = this.m.mem, vt = mem.r32(enemy);
        if (vt === VT_BOSS_WANWAN[this.region]) {
            if (previous !== -1) return -1;
            const pattern = this.session[F.PATTERN_0];
            return pattern >= 1 && pattern <= 3 ? BOSS_PATHS[pattern - 1] : -1;
        }
        const name = mem.r32(enemy + 4);
        if (vt !== VT_FIRE_WANWAN[this.region] || !name) return -1;
        const digit = mem.r8(name + 19);
        if (digit < 0x30 || digit > 0x32) return -1;
        const pattern = this.session[F.PATTERN_0 + (digit === 0x32 ? 0 : digit === 0x30 ? 1 : 2)];
        if (pattern < 1 || pattern > 4) return -1;
        const key = ((current & 0xFF) << 8) | digit;
        for (const [k, next] of CHOMPLET_PATHS) if (k === key) return next[pattern - 1] === 0xFF ? -1 : next[pattern - 1];
        return -1;
    }
    private installControls() {
        const { m } = this, cpu = m.cpu, mem = m.mem, r = this.region;
        const s32 = (v: number) => v | 0;
        // susamuneGoToRandomNextGraphNode: the next node of an enemy's graph. Petey's route and the blue bird keep the
        // retail roll and replace its result; a selected Chomplet / Chain Chomp node is taken without the roll.
        let replaceNext = -1;
        cpu.hook(GRAPH_NEXT_CALL[r], (c) => {
            const enemy = c.gpr[31], graph = c.gpr[3], current = s32(c.gpr[4]), previous = s32(c.gpr[5]);
            replaceNext = -1;
            if (this.session[F.PETEY_ROUTE] && this.area() === 2 && this.episode() === 4 && mem.r32(enemy) === VT_BOSS_PAKKUN[r]) {
                if (current >= 0 && current < PETEY_PATH.length) replaceNext = PETEY_PATH[current];
                return false;
            }
            const bird = this.blueBirdNode(enemy, graph, current, previous);
            if (bird >= 0) { replaceNext = bird; return false; }
            const next = this.selectedNode(enemy, current, previous);
            if (next < 0) return false;
            c.gpr[3] = next; c.pc = GRAPH_NEXT_CALL[r] + 4; return true;
        });
        cpu.hook(GRAPH_NEXT_CALL[r] + 4, (c) => { if (replaceNext >= 0) { c.gpr[3] = replaceNext; replaceNext = -1; } return false; });
        // susamuneGelatoFishRandomNext: Gelato 6's two red-coin fish; the retail roll is kept
        if (GELATO_FISH_CALL[r]) {
            let fish = -1;
            cpu.hook(GELATO_FISH_CALL[r], (c) => {
                const graph = c.gpr[3], current = s32(c.gpr[4]), previous = s32(c.gpr[5]), pattern = this.session[F.GELATO_RED_COIN_FISH_PATTERN];
                fish = -1;
                if (this.area() !== 4 || this.episode() !== 5 || pattern < 1 || pattern > 4 || previous !== -1 || c.gpr[6] !== 0xFFFFFFFF) return false;
                const rail = this.str(mem.r32(graph + 0xC)), index = rail === 'kaiyu16' ? 0 : rail === 'kaiyu17' ? 1 : -1;
                if (index >= 0) fish = this.neighbour(graph, current, ((pattern - 1) >> (1 - index)) & 1);
                return false;
            });
            cpu.hook(GELATO_FISH_CALL[r] + 4, (c) => { if (fish >= 0) { c.gpr[3] = fish; fish = -1; } return false; });
        }
        // susamuneGetSystemFlag: the box game's two flags as the setting says, the save data untouched
        cpu.hook(BOX_GAME_CALL[r], (c) => {
            const game = this.session[F.FORCE_BOX_GAME], flag = c.gpr[4];
            if (game === 0 || (flag !== 0x1005E && flag !== 0x1005F)) return false;
            c.gpr[3] = game === 2 && flag === 0x1005E ? 1 : 0; c.pc = BOX_GAME_CALL[r] + 4; return true;
        });
        // susamuneForceKingBooFruit: after forceStopSlot, the reel's result alternates fruit / no fruit
        let kbSlot = 0, kbReel = 0;
        cpu.hook(KING_BOO_CALL[r], (c) => { kbSlot = c.gpr[3]; kbReel = s32(c.gpr[4]); return false; });
        cpu.hook(KING_BOO_CALL[r] + 4, () => {
            const slot = kbSlot, reel = kbReel;
            if (!this.session[F.KING_BOO_ALWAYS_FRUIT]) { this.kingBooSlot = 0; return false; }
            if (!slot || reel < 0 || reel >= 3) return false;
            const magic = slot + 0x19D, state = slot + 0x1AB;
            const marker = mem.r8(magic) === 0x4B && mem.r8(magic + 1) === 0x42 && mem.r8(magic + 2) === 0x52;
            if (this.kingBooSlot !== slot || !marker) { this.kingBooSlot = slot; mem.w8(magic, 0x4B); mem.w8(magic + 1, 0x42); mem.w8(magic + 2, 0x52); mem.w8(state, 0); }
            let st = mem.r8(state);
            if (st & 2) {
                const prior = st & 1 ? 3 : 2, boss = mem.r32(slot + 0x1A0);
                if (boss && s32(mem.r32(boss + 0x1A8)) === prior) st ^= 1;
            }
            const result = st & 1 ? 3 : 2;
            mem.w8(state, (st & 1) | 2);
            mem.w32(slot + 0x1A4, result); mem.w8(slot + 0x198 + reel, 1); mem.w8(slot + 0x1A8 + reel, 1);
            return false;
        });
        // the cranes: each rand() result is kept for its crane ...
        cpu.hook(CRANE_UPDOWN_RAND[r] + 4, (c) => { this.recordCrane(c.gpr[31], c.gpr[3], true); return false; });
        cpu.hook(CRANE_ROTY_RAND[r] + 4, (c) => { this.recordCrane(c.gpr[30], c.gpr[3], false); return false; });
        // ... and their control functions, reached through the vtable slots Moonshine replaces, run at a speed from it
        const wrap = (slot: number, retail: number, before: (crane: number) => (() => void) | null) => {
            if (mem.r32(slot) !== retail) return;
            const cave = this.caveAt; this.caveAt += 8;
            this.poke(cave, 0x60000000); this.poke(cave + 4, 0x60000000);
            let lr = 0, after: (() => void) | null = null;
            cpu.hook(cave, (c) => { after = before(c.gpr[3]); lr = c.lr; c.lr = cave + 4; c.pc = retail; return true; });
            cpu.hook(cave + 4, (c) => { if (after) after(); after = null; c.pc = lr; return true; });
            mem.w32(slot, cave);
        };
        wrap(CRANE_UPDOWN_SLOT[r], CRANE_UPDOWN_CONTROL[r], (crane) => {
            const speed = CRANE_UPDOWN_SPEED[r], retailBits = mem.r32(speed), retailSpeed = this.rf(speed);
            const rec = this.findCrane(crane, true), percent = rec ? this.cranePercent(rec.roll) : 0;
            if (!percent) return null;
            // (Moonshine's compiled code multiplies in this order: fmuls retail, 0.01f; fmuls that, percent)
            this.wf(speed, Math.fround(Math.fround(retailSpeed * Math.fround(0.01)) * percent));
            return () => mem.w32(speed, retailBits);
        });
        wrap(CRANE_ROTY_SLOT[r], CRANE_ROTY_CONTROL[r], (crane) => {
            const rec = this.findCrane(crane, false);
            if (rec) {
                if (!rec.speedCaptured) { rec.retailSpeed = this.rf(crane + 0x144); rec.speedCaptured = true; }
                const percent = this.cranePercent(rec.roll);
                this.wf(crane + 0x144, percent ? Math.fround(Math.fround(0.0015) * percent) : rec.retailSpeed);
            }
            return null;
        });
        // susamuneRiccoFruitRandImpl: "Durians only" replaces the fruit's choice (three tries), never the speed rolls
        const durians = (launcher: number) => launcher !== 0 && this.area() === 3 && this.session[F.RICCO_FRUIT_MACHINE] === 1;
        const fire = FRUIT_FIRE[r];
        cpu.hook(fire + 0x134 + 4, (c) => { const l = c.gpr[31]; this.fruitPending = durians(l) ? l : 0; if (this.fruitPending) c.gpr[3] = DURIAN_ROLL; return false; });
        cpu.hook(fire + 0x250 + 4, (c) => { const l = c.gpr[31]; if (this.fruitPending === l && durians(l)) c.gpr[3] = DURIAN_ROLL; else this.fruitPending = 0; return false; });
        cpu.hook(fire + 0x36C + 4, (c) => { const l = c.gpr[31], force = this.fruitPending === l && durians(l); this.fruitPending = 0; if (force) c.gpr[3] = DURIAN_ROLL; return false; });
        cpu.hook(fire + 0x4A0 + 4, (c) => { if (this.fruitPending === c.gpr[31]) this.fruitPending = 0; return false; });
        // regrabLastHeldObject's call of the object's receiveMessage comes back here
        const cave = this.actionCave = this.caveAt; this.caveAt += 4; this.poke(cave, 0x60000000);
        cpu.hook(cave, (c) => {
            const g = this.regrab!; this.regrab = null;
            if (c.gpr[3]) { mem.w32(g.mario + TAKE_HELD, g.obj); mem.w32(g.mario + MARIO_GRAB_TARGET, 0); }
            c.gpr[3] = g.r3; c.lr = g.lr; c.pc = g.back; this.regrabbed = true;
            return true;
        });
    }
    private controlsInstalled = false;

    // ---------------------------------------------------------------- the actions bound to buttons (actions.cpp)
    private lastHeld = 0; private actionCave = 0; private regrabbed = false;
    private regrab: { obj: number; mario: number; r3: number; lr: number; back: number } | null = null;
    /**
     * regrabLastHeldObject, which actionsApply runs after the director's frame. It remembers the object Mario
     * holds; while he holds nothing and the pad's buttons (sampled before the frame, as Binds::update does) are
     * exactly the bind's, his status becomes TAKE and the remembered object is sent the take message, and holds
     * if it accepts. The bind is the default one: binds aren't recorded.
     * `back` is where the processor is (the instruction after the director's call). Returns true when it was
     * sent into the object's receiveMessage instead: it comes back to `back`, and this is then called again.
     */
    afterDirect(c: { gpr: Uint32Array; lr: number; pc: number }, back: number): boolean {
        if (this.region < 0) return false;
        if (this.regrabbed) { this.regrabbed = false; return false; }
        // (no binds while the practice session owns the gameplay input: PracticeSession::ownsGameplayInput)
        if (this.practiceFrozen) return false;
        const mem = this.m.mem, d = mem.r32(this.A.gpMarDirector);
        if (!this.actionCave || !d || !mem.r8(d + DIR_SETUP_DONE) || mem.r8(d + DIR_STATE) < STATE_GAME_STARTING) return false;
        const mario = mem.r32(this.A.gpMarioAddress);
        if (!mario) return false;
        const held = mem.r32(mario + TAKE_HELD);
        if (held) { this.lastHeld = held; return false; }
        if (!this.lastHeld || (mem.r16(this.A.padStatus) & BIND_BUTTON_MASK) !== BIND_REGRAB) return false;
        const obj = this.lastHeld;
        mem.w32(mario + MARIO_GRAB_TARGET, obj); mem.w32(mario + MARIO_STATE, MARIO_STATUS_TAKE);
        this.regrab = { obj, mario, r3: c.gpr[3], lr: c.lr, back };
        c.gpr[3] = obj; c.gpr[4] = mario; c.gpr[5] = HIT_MESSAGE_TAKE; c.lr = this.actionCave; c.pc = mem.r32(mem.r32(obj) + VT_RECEIVE_MESSAGE);
        this.regrabs++;
        return true;
    }
    /** how often the regrab action ran */
    regrabs = 0;

    private write(addr: number, word: number, mask = 0xFFFFFFFF) {
        const mem = this.m.mem;
        if (!this.orig.has(addr)) this.orig.set(addr, mem.r32(addr));
        this.poke(addr, ((this.orig.get(addr)! & ~mask) | (word & mask)) >>> 0); this.on.add(addr);
    }
    private restore(addr: number) { if (this.on.delete(addr)) this.poke(addr, this.orig.get(addr)!); }
    /** an instruction word written: the CPU's compiled blocks over it are dropped */
    private poke(addr: number, word: number) {
        const mem = this.m.mem;
        if (mem.r32(addr) === word >>> 0) return;
        mem.w32(addr, word); this.m.cpu.invalidateCode(addr, 4);
    }
    private branch(from: number, to: number) { return (0x48000000 | ((to - from) & 0x03FFFFFC)) >>> 0; }

    /** Shiny Shines (not in the session record): on or off for the whole replay */
    shinyShines = false;

    /** featuresApply: makes the game's code what the settings in `session` (a session record) make it. */
    apply(session: Uint8Array) {
        this.session = session;
        if (this.region < 0) return;
        if (!this.controlsInstalled && this.caveAt) { this.controlsInstalled = true; this.installControls(); }
        if (this.shinyShines) this.write(SHINY_SHINES[this.region], this.pick(SHINY_SHINES[3])); else this.restore(SHINY_SHINES[this.region]);
        for (const p of PATCHES) for (const r of p.rows) {
            const addr = r[this.region];
            if (session[p.field]) this.write(addr, this.pick(r[3]), r[4]); else this.restore(addr);
        }
        HOOKS.forEach((h, i) => {
            const site = h.site[this.region], want = h.mode === undefined ? session[h.field] !== 0 : session[h.field] === h.mode;
            if (!want) {
                // (two caves share Il Piantissimo's site: leave it to the one that is on)
                if (h.mode !== undefined && session[h.field] !== 0) return;
                this.restore(site); return;
            }
            let cave = this.caves.get(i);
            if (cave === undefined) {
                if (!this.caveAt) throw new Error('Moonshine: the arena is not set up yet');
                cave = this.caveAt; this.caves.set(i, cave);
                h.cave.forEach((w, k) => this.poke(cave! + k * 4, k === h.cave.length - 1 ? this.branch(cave! + k * 4, site + 4) : this.pick(w)));
                this.caveAt += h.cave.length * 4;
            }
            this.write(site, this.branch(site, cave));
        });
        const nozzle = session[F.NOZZLE_LOCK];
        if (nozzle >= 1 && nozzle <= 3) this.write(NOZZLE_SITE[this.region], 0x3BE00000 | NOZZLE_IDS[nozzle - 1]); else this.restore(NOZZLE_SITE[this.region]);
        const fludd = session[F.FLUDD_SECRETS];
        FLUDD_SITES.forEach((s, k) => {
            const i = k + 1;
            if (fludd === 1) this.write(s[this.region], 0x60000000); else if (fludd === 2) this.write(s[this.region], 0x4800001C - i * 4); else this.restore(s[this.region]);
        });
    }

    /** The settings on in `session` that this can't reproduce in the stage whose archive is `stage` (e.g. bianco0). */
    unsupported(session: Uint8Array, stage: string): string[] {
        const out: string[] = [];
        for (const [f, name] of UNSUPPORTED) if (session[f]) out.push(name);
        for (const [f, where, name] of UNSUPPORTED_IN) if (session[f] && where.test(stage)) out.push(name);
        return out;
    }
}
