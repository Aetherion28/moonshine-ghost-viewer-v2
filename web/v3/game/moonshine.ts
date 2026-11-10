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
// Not reproduced (their source is not in the snapshot): the pattern selector, the Ricco crane and fruit
// controls, King Boo's reel, Petey's route and tornado, the Gelato patterns, the box game, the level warps.
// `unsupported()` names the ones a session has on.
import type { Machine } from '../ppc/machine.js';

export type Region = 0 | 1 | 2;   // JP, US, PAL
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
];
// The settings Moonshine's session record doesn't carry (Mute BGM, Shine Outfit, Shiny Shines, the appearance
// choices, Replace Episode Names) only change sound and looks. But a look is a model, and a model is heap:
// Shiny Shines (every Shine drawn yellow: TShine skips its "already collected?" test) makes a collected Shine
// share the item manager's model instead of loading the blue one, and everything allocated after it sits lower.
// So it is an option here, chosen by the evidence: Mario's address in his first record (see Replay).
const SHINY_SHINES: Row = [0x80194E24, 0x801BCE3C, 0x801B4CF4, 0x4800004C];

const R3 = (jp: number, us: number, pal: number) => [jp, us, pal] as [number, number, number];
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

/** the settings whose code is not in the source snapshot: [field, what it changes] */
const UNSUPPORTED: [number, string][] = [
    [F.NO_SHINE_ANIM, 'No Shine Get Animation'], [F.PATTERN_SELECTOR, 'Pattern Selector'], [F.FORCE_BOX_GAME, 'Force Box Game'],
    [F.KING_BOO_ALWAYS_FRUIT, "King Boo's reel"], [F.GELATO_RED_COIN_FISH_PATTERN, 'Gelato red-coin fish pattern'], [F.GELATO_BLUE_BIRD_PATTERN, 'Gelato blue bird pattern'],
    [F.GAMEPLAY_SPEED, 'gameplay speed'], [F.FAST_FORWARD_ACTIVE, 'fast forward'], [F.FREE_CAMERA_ACTIVE, 'free camera'],
];
/** settings that act only in some stages (by the stage archive's name), also without source */
const UNSUPPORTED_IN: [number, RegExp, string][] = [
    [F.RICCO_CRANE_SPEED, /^ricco/, 'Ricco crane speed'], [F.RICCO_FRUIT_MACHINE, /^ricco/, 'Ricco fruit machine'],
    [F.PETEY_NO_TORNADO, /^bianco(1|4|Boss)/, 'Petey: no tornado'], [F.PETEY_ROUTE, /^bianco(1|4|Boss)/, "Petey's route"],
];

export const ARENA_RESERVE = 0xC2000;   // the mod's region (0xC0000) and the debug stack OSInit returns to the arena (0x2000)

export interface MoonshineAddrs { OSGetArenaLo: number; arenaLoVar: number; setupObjectsCall: number; gpPollution: number; fastTextCall: number }

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

    /** The parts that are always there: the raised arena floor, onSetup. */
    install() {
        const { m, A } = this, cpu = m.cpu;
        cpu.hook(A.OSGetArenaLo, (c) => {
            const lo = m.mem.r32(A.arenaLoVar);
            if (!this.base) { this.base = lo; this.caveAt = lo + 0x1000; this.fastTextMsg = lo + 0x800; m.mem.ram.set([0x81, 0x49, 0x81, 0x49, 0x81, 0x49, 0], this.fastTextMsg & 0x01FFFFFF); }
            c.gpr[3] = (lo + ARENA_RESERVE) >>> 0;
        });
        // onSetup: TPollutionManager's destructor never clears gpPollution; Moonshine does before setupObjects
        cpu.hook(A.setupObjectsCall, () => { m.mem.w32(A.gpPollution, 0); return false; });
        // setupFastTextBox (in place of setMessageID's fallback call to setupTextBox): with Fast Text on, the message is "!!!"
        cpu.hook(A.fastTextCall, (c) => { if (this.session[F.EFFECTIVE_FAST_TEXT]) c.gpr[4] = (this.fastTextMsg - m.mem.r32(c.gpr[5])) >>> 0; return false; });
    }

    private write(addr: number, word: number, mask = 0xFFFFFFFF) {
        const mem = this.m.mem;
        if (!this.orig.has(addr)) this.orig.set(addr, mem.r32(addr));
        mem.w32(addr, ((this.orig.get(addr)! & ~mask) | (word & mask)) >>> 0); this.on.add(addr);
    }
    private restore(addr: number) { if (this.on.delete(addr)) this.m.mem.w32(addr, this.orig.get(addr)!); }
    private branch(from: number, to: number) { return (0x48000000 | ((to - from) & 0x03FFFFFC)) >>> 0; }

    /** Shiny Shines (not in the session record): on or off for the whole replay */
    shinyShines = false;

    /** featuresApply: makes the game's code what the settings in `session` (a session record) make it. */
    apply(session: Uint8Array) {
        this.session = session;
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
                h.cave.forEach((w, k) => this.m.mem.w32(cave! + k * 4, k === h.cave.length - 1 ? this.branch(cave! + k * 4, site + 4) : this.pick(w)));
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
