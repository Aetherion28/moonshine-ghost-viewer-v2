// TFlagManager (src/System/FlagManager.cpp): the game's flags, keyed by MSFlag ids
// (include/System/FlagManagerFlags.hpp). An id's high 16 bits pick the bank, the low its index:
//   1 card bools, 2 card ints (the save file: shines, blue coins, M paintings, story...),
//   3 game bools, 4 game ints (since power-on: shine count, episode...),
//   5 stage bools, 6 stage ints (cleared by resetStage() each stage load: TMarDirector::setupObjects),
//   7/8 saved option, 9/10 option. Ids past a bank's *_END read 0 and ignore writes, as in the game.
//
// What the sim can know at a stage's start (setupStage below): the ghost file carries no save data
// (legacy/ghost.js parseSmsGhost: route area/episode/parentArea/flags/variant, run flags, times,
// names, samples only), so the save's flags are inferred from the stage being loaded:
// - the game's own setupObjects writes (resetStage, MSF_SHADOW_MARIO_EVENT = 1, the stage's
//   MSF_*_VISITED, Delfino's MSF_NOKI_AVAILABLE / Ricco/Gelato unlockables, Pianta 3's sunflowers);
// - Delfino Plaza's scenario: TMarDirector's scenario pick (MarDirectorDirect.cpp, the area-1 chain:
//   CORONA_VISITED -> 2, all Shadow Marios -> 9, BOWSER_BOAT_CUTSCENE_TRIGGERED -> 8, boathouse &&
//   lighthouse M -> 7 (>= 10 shines) / 6, statue M -> 5, BIANCO_POLLUTED_PIRANHA_DEFEATED -> 1, else 0)
//   proves that scenario's own condition; the earlier links are implied by the story order the
//   game's setup enforces (the boathouse/lighthouse M gates only open after scenario 5's
//   RICCO/GELATO_UNLOCKABLE demo, which needs the statue M, which needs the piranha) — see setupStage;
// - the secret stage's Shine (world.exShineGot, from the run's FLUDD: player.ts sawFludd).
// Everything else (shine count beyond the bounds above, lives, coins, records...) is unknown:
// left at the game's fresh-save values (TFlagManager::firstStart: zero, correctFlag's minimums).
// (save/load to the card and the option file are left out: the sim has no memory card.)
import { MSF } from './msflags.js';
import { V } from './version.js';
export { MSF };

/** SMS_getShineStage's table (StageUtil.cpp) */
const SHINE_STAGE = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x06, 0x07, 0x08, 0x09, 0x01, 0x01, 0x05, 0x06, 0x01,
    0x08, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x02, 0x01, 0x03, 0x08,
    0x04, 0x04, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x06, 0x05, 0x07, 0x07, 0x08, 0x08, 0x02, 0x02,
    0x03, 0x03, 0x05, 0x06, 0x09, 0x01, 0x01, 0x02, 0x06, 0x08, 0x05, 0x03, 0x09,
];
export const shineStage = (area: number) => SHINE_STAGE[area] ?? 0;

/** bank -> [the bank's *_END, whether it is bools] */
const BANKS: Record<number, [number, boolean]> = {
    1: [MSF.CARD_BOOL_END, true], 2: [MSF.CARD_INT_END, false],
    3: [MSF.GAME_BOOL_END, true], 4: [MSF.GAME_INT_END, false],
    5: [MSF.STAGE_BOOL_END, true], 6: [MSF.STAGE_INT_END, false],
    7: [MSF.SAVED_OPTION_BOOL_END, true], 8: [MSF.SAVED_OPTION_INT_END, false],
    9: [MSF.OPTION_BOOL_END, true], 10: [MSF.OPTION_INT_END, false],
};

export const SAVE_SIZE = 4 + 8 + 8 + 4 + 2 + 2 + 64 + 0x200 + 0x200;
const CARD_BOOLS = MSF.CARD_BOOL_END & 0xFFFF, CARD_INTS = MSF.CARD_INT_END & 0xFFFF;

export class FlagManager {
    /** each bank's values (bools as 0/1), by the id's low 16 bits */
    private banks: Record<number, Int32Array> = {};
    constructor() { for (const b in BANKS) this.banks[b] = new Int32Array(BANKS[b][0] & 0xFFFF); this.keepCard(); this.correctFlag(); this.correctOptFlag(); }
    /**
     * correctOptFlag's language (TFlagManager's constructor and loadOption; JP DOL 0x800E6D50: li r5, 0x100):
     * every version but PAL sets MSF_LANGUAGE to 0x100. PAL (and 3D All-Stars) take the saved language
     * or OSGetLanguage, which the sim can't know: left 0 (English).
     */
    correctOptFlag() {
        this.setBool(!this.getBool(MSF.SAVED_RUMBLE_OFF), MSF.RUMBLE);
        // OSGetSoundMode(): neither the ghost nor the trace (its flag image has no option banks) records it: stereo
        this.setFlag(MSF.SOUND_MODE, this.getBool(MSF.SAVED_SURROUND) ? 2 : 1);
        if (V.GMSP01 || V.GMSP01_NX) { const l = this.getFlag(MSF.SAVED_LANGUAGE); if (l !== 0) this.setFlag(MSF.LANGUAGE, l - 1); this.setBool(!this.getBool(MSF.SAVED_SUBTITLES_OFF), MSF.SUBTITLES); }
        if (!V.GMSP01 && !V.GMSP01_NX) this.setFlag(MSF.LANGUAGE, 0x100);
    }
    /** resetOpt */
    resetOpt() { this.banks[7].fill(0); this.banks[8].fill(0); }
    /** mLastSaveTime / mLastSaveTimeBackup / mSavedLastSaveTime (OSGetTime: here Date.now()) */
    lastSaveTime = 0; lastSaveTimeBackup = 0; savedLastSaveTime = 0;
    /** mSavedCardBools / mSavedCardInts: the card banks as last loaded or saved */
    private savedCard!: [Int32Array, Int32Array];
    private keepCard() { this.savedCard = [this.banks[1].slice(), this.banks[2].slice()]; this.savedLastSaveTime = this.lastSaveTime; }
    /** firstStart */
    firstStart() { this.resetCard(); this.keepCard(); this.correctFlag(); }
    /** restore: the card banks back as last loaded or saved */
    restore() { this.resetCard(); this.lastSaveTime = this.savedLastSaveTime; this.banks[1].set(this.savedCard[0]); this.banks[2].set(this.savedCard[1]); this.correctFlag(); }
    /**
     * save: u32 4, s64 the time, u64 0, s32 MSF_SAVE_COUNT (counted first), u16 the Shine count, u16 0,
     * 16 x u32 0, the card's bools (a bit each, low bit first) padded to 0x200, its ints padded to 0x200
     */
    save(time = Date.now()): Uint8Array {
        this.lastSaveTimeBackup = this.lastSaveTime;
        this.lastSaveTime = Math.trunc(time);
        this.incFlag(MSF.SAVE_COUNT, 1);
        const b = new Uint8Array(SAVE_SIZE), dv = new DataView(b.buffer);
        dv.setUint32(0, 4);
        dv.setBigInt64(4, BigInt(this.lastSaveTime));
        dv.setInt32(20, this.getFlag(MSF.SAVE_COUNT));
        dv.setUint16(24, this.getFlag(MSF.SHINE_COUNT) & 0xFFFF);
        const bo = 28 + 64, io = bo + 0x200;
        for (let i = 0; i < CARD_BOOLS; i++) if (this.getFlag(0x10000 + i)) b[bo + (i >> 3)] |= 1 << (i & 7);
        for (let i = 0; i < CARD_INTS; i++) dv.setInt32(io + i * 4, this.getFlag(0x20000 + i));
        return b;
    }
    /** load: resetCard, the card read in when the version is 4, kept as the saved copy, then correctFlag */
    load(b: Uint8Array) {
        this.resetCard();
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        if (b.length >= SAVE_SIZE && dv.getUint32(0) === 4) {
            this.lastSaveTime = Number(dv.getBigInt64(4));
            const bo = 28 + 64, io = bo + 0x200;
            for (let i = 0; i < CARD_BOOLS; i++) this.setFlag(0x10000 + i, (b[bo + (i >> 3)] >> (i & 7)) & 1);
            for (let i = 0; i < CARD_INTS; i++) this.setFlag(0x20000 + i, dv.getInt32(io + i * 4));
        }
        this.keepCard();
        this.correctFlag();
    }
    /** saveSuccess: the card as written becomes the saved copy */
    saveSuccess() { this.keepCard(); }
    /** saveFail: the time back, the save uncounted */
    saveFail() { this.lastSaveTime = this.lastSaveTimeBackup; this.incFlag(MSF.SAVE_COUNT, -1); }
    /** saveOption: u32 2, the saved option bools (u8[1]) and ints (s32[1]), set from the options first */
    saveOption(): Uint8Array {
        this.setBool(!this.getBool(MSF.RUMBLE), MSF.SAVED_RUMBLE_OFF);
        // (OSSetSoundMode: the console's, not kept here)
        const m = this.getFlag(MSF.SOUND_MODE);
        if (m === 0 || m === 1) this.setBool(false, MSF.SAVED_SURROUND); else if (m === 2) this.setBool(true, MSF.SAVED_SURROUND);
        if (V.GMSP01 || V.GMSP01_NX) { this.setFlag(MSF.SAVED_LANGUAGE, this.getFlag(MSF.LANGUAGE) + 1); this.setBool(!this.getBool(MSF.SUBTITLES), MSF.SAVED_SUBTITLES_OFF); }
        else this.setFlag(MSF.SAVED_LANGUAGE, 0);
        const b = new Uint8Array(9), dv = new DataView(b.buffer);
        dv.setUint32(0, 2);
        const n = this.banks[7].length;
        for (let i = 0; i < n; i++) if (this.banks[7][i]) b[4 + (i >> 3)] |= 1 << (i & 7);
        dv.setInt32(5, this.banks[8][0] | 0);
        return b;
    }
    /** loadOption: resetOpt, the saved options read in when the version is 2, then correctOptFlag */
    loadOption(b: Uint8Array) {
        this.resetOpt();
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        if (b.length >= 9 && dv.getUint32(0) === 2) {
            const n = this.banks[7].length;
            for (let i = 0; i < n; i++) this.banks[7][i] = (b[4 + (i >> 3)] >> (i & 7)) & 1;
            if (this.banks[8].length) this.banks[8][0] = dv.getInt32(5);
        }
        this.correctOptFlag();
    }

    private slot(flag: number, bools: boolean | null): Int32Array | null {
        const bank = flag >>> 16, d = BANKS[bank];
        if (!d || flag >= d[0] || (bools !== null && d[1] !== bools)) return null;
        return this.banks[bank];
    }
    /** a copy (to ask decideMarioPosIdx, which clears flags, without touching these) */
    clone(): FlagManager { const f = new FlagManager(); for (const b in this.banks) f.banks[b] = this.banks[b].slice(); f.savedCard = [this.savedCard[0].slice(), this.savedCard[1].slice()]; f.lastSaveTime = this.lastSaveTime; f.lastSaveTimeBackup = this.lastSaveTimeBackup; f.savedLastSaveTime = this.savedLastSaveTime; return f; }
    getFlag(flag: number): number { const s = this.slot(flag, null); return s ? s[flag & 0xFFFF] : 0; }
    setFlag(flag: number, value: number) {
        const s = this.slot(flag, null); if (!s) return;
        s[flag & 0xFFFF] = BANKS[flag >>> 16][1] ? value & 1 : value | 0;
    }
    getBool(flag: number): boolean { const s = this.slot(flag, true); return !!s && s[flag & 0xFFFF] !== 0; }
    /** (the game's argument order) */
    setBool(value: boolean, flag: number) { if (this.slot(flag, true)) this.setFlag(flag, value ? 1 : 0); }
    incFlag(flag: number, amount: number) { const s = this.slot(flag, false); if (s) s[flag & 0xFFFF] = (s[flag & 0xFFFF] + amount) | 0; }
    decFlag(flag: number, amount: number) { this.incFlag(flag, -amount); }
    /** incGoldCoinFlag (FlagManager.cpp): the stage's coin count, and the area's record when it's beaten */
    incGoldCoinFlag(area: number, amount: number) {
        this.incFlag(MSF.GOLD_COIN_COUNT, amount);
        area &= 0xFF;   // (u8; JP DOL 0x800E7BCC: addis 2, addi 5 -> MSF_COIN_RECORD_BASE + area)
        if (this.getFlag(MSF.GOLD_COIN_COUNT) > this.getFlag(MSF.COIN_RECORD_BASE + area)) this.setFlag(MSF.COIN_RECORD_BASE + area, this.getFlag(MSF.GOLD_COIN_COUNT));
    }
    incMario(amount: number) { this.incFlag(MSF.LIFE_COUNT, amount); if (this.getFlag(MSF.LIFE_COUNT) > 99) this.setFlag(MSF.LIFE_COUNT, 99); }
    getShineFlag(shine: number) { if (shine >= 120) shine = 0; return this.getFlag(MSF.SHINE_BASE + shine) !== 0; }
    setShineFlag(shine: number) {
        if (shine >= 120) shine = 0;
        const f = MSF.SHINE_BASE + shine;
        if (this.getFlag(f) === 0) { this.incFlag(MSF.SHINE_COUNT, 1); this.setFlag(f, 1); }
    }
    resetStage() { this.banks[5].fill(0); this.banks[6].fill(0); }
    resetGame() { this.banks[3].fill(0); this.banks[4].fill(0); this.resetStage(); }
    resetCard() { this.banks[1].fill(0); this.banks[2].fill(0); this.resetGame(); }
    /** correctFlag: the fresh save's minimums */
    correctFlag() {
        if (this.getFlag(MSF.LIFE_COUNT) < 3) this.setFlag(MSF.LIFE_COUNT, 3);
        if (this.getFlag(MSF.RACE_RECORD_GELATO) === 0) this.setFlag(MSF.RACE_RECORD_GELATO, 3500);
        if (this.getFlag(MSF.RACE_RECORD_PIANTA) === 0) this.setFlag(MSF.RACE_RECORD_PIANTA, 3000);
        if (this.getFlag(MSF.RACE_RECORD_NOKI) === 0) this.setFlag(MSF.RACE_RECORD_NOKI, 4000);
        if (this.getFlag(MSF.BOX_GAME_RECORD) === 0) this.setFlag(MSF.BOX_GAME_RECORD, 3000);
        this.setBool(true, MSF.FMV_OPENING_WATCHED);
        this.setBool(true, MSF.AUTO_DEMO_WATCHED);
        // the counts are recounted from the flags
        let shines = 0; for (let f = MSF.SHINE_BASE; f <= MSF.SHINE_LAST; f++) if (this.getFlag(f) !== 0) shines++;
        this.setFlag(MSF.SHINE_COUNT, shines);
        let blues = 0; for (let f = MSF.BLUE_COIN_BASE; f <= MSF.BLUE_COIN_LAST; f++) if (this.getFlag(f) !== 0) blues++;
        this.setFlag(MSF.BLUE_COIN_COUNT, blues);
    }
    /** raise the shine count to at least n (an inferred lower bound) */
    private atLeastShines(n: number) { if (this.getFlag(MSF.SHINE_COUNT) < n) this.setFlag(MSF.SHINE_COUNT, n); }

    /**
     * The save as far as the stage proves it (see the file's head), then TMarDirector::setupObjects'
     * flag writes for (area, scenario).
     */
    setupStage(area: number, scenario: number, exShineGot: boolean, exShineId: number, infer = true) {
        // -- inferences from the loaded scene (not for live play's carried-over flags: they are the save)
        if (infer && exShineId !== 0xFF && exShineGot) this.setShineFlag(exShineId);
        if (infer && area === 1) {
            const s = scenario;
            // the scenario-pick chain (MarDirectorDirect.cpp): each scenario proves its own test...
            if (s === 2) this.setBool(true, MSF.CORONA_VISITED);
            if (s === 8) this.setBool(true, MSF.BOWSER_BOAT_CUTSCENE_TRIGGERED);
            // ...and the story order its predecessors (scenario 9 / 2 need every world's Shadow Mario
            // beaten: checkDefeatShadowMarioAll; not tracked as flags here, but they come after the boat)
            const order = [0, 1, 5, 6, 8, 9, 2];
            const rank = s === 7 ? order.indexOf(6) : order.indexOf(s);
            if (rank >= 1) this.setBool(true, MSF.BIANCO_POLLUTED_PIRANHA_DEFEATED);
            if (rank >= 2) this.setBool(true, MSF.M_PAINTED_ON_STATUE);
            if (rank >= 3) { this.setBool(true, MSF.M_PAINTED_ON_BOATHOUSE); this.setBool(true, MSF.M_PAINTED_ON_LIGHTHOUSE); this.atLeastShines(5); }
            if (s === 7 || rank >= 4) this.atLeastShines(10);
            if (rank >= 4 && s !== 8) this.setBool(true, MSF.BOWSER_BOAT_CUTSCENE_TRIGGERED);
            // scenario 9/2: each of the 7 worlds' episodes 1-7 done (the Shadow Mario chases) -> >= 49
            if (rank >= 5) this.atLeastShines(49);
        }
        // -- TMarDirector::setupObjects
        this.resetStage();
        this.setFlag(MSF.SHADOW_MARIO_EVENT, 1);
        if (area === 1) {
            this.setBool(false, MSF.FLUDD_THEFT_SCENARIO_WATCHED);
            this.setBool(false, MSF.POPPED_ALL_BALLOONS_IN_PREV_STAGE);
            if (!this.getBool(MSF.PLAZA_DEMO_WATCHED_SINCE_RESET)) this.setBool(true, MSF.PLAZA_DEMO_WATCHED_SINCE_RESET);
            else this.setBool(true, MSF.COURT_FMV_WATCHED_SINCE_RESET);
            switch (scenario) {
                case 5:
                    if (!this.getBool(MSF.M_PAINTED_ON_BOATHOUSE) && this.getFlag(MSF.SHINE_COUNT) >= 3) this.setBool(true, MSF.RICCO_UNLOCKABLE);
                    if (!this.getBool(MSF.M_PAINTED_ON_LIGHTHOUSE) && this.getFlag(MSF.SHINE_COUNT) >= 5) this.setBool(true, MSF.GELATO_UNLOCKABLE);
                    break;
                case 8: {
                    const shines = this.getFlag(MSF.SHINE_COUNT);
                    let ev = 0;
                    if (!this.getBool(MSF.YOSHI_UNLOCKED) && this.getShineFlag(33)) ev = 1;
                    if (ev === 0 && !this.nozzleRight(1, 1) && this.getBool(MSF.YOSHI_UNLOCKED) && shines >= 25) ev = 2;
                    if (ev === 0 && !this.nozzleRight(1, 0) && this.nozzleRight(1, 1) && shines >= 30) ev = 3;
                    this.setFlag(MSF.SHADOW_MARIO_EVENT, ev);
                }
                // fallthrough
                case 2:
                    if (this.getFlag(MSF.SHINE_COUNT) >= 20) this.setBool(true, MSF.NOKI_AVAILABLE);
                    break;
            }
        } else if (area === 5 && scenario === 3) this.setBool(true, MSF.SUNFLOWERS_LEFT_TO_RESCUE);
        this.setBool(true, shineStage(area) + MSF.VISITED_BASE);
        // (MSF_MANTA_SPAWNED: no game code sets it; sirena0's event script appearmanta.sb does, run by
        // eventwatcher.ts)
    }
    private static stageOf(area: number) { const st = shineStage(area & 0xFF); return st === 0 || st >= 10 ? 1 : st; }
    /** getNozzleRight(area, nozzle) */
    nozzleRight(area: number, nozzle: number) {
        const st = FlagManager.stageOf(area); nozzle &= 0xFF; if (nozzle >= 2) nozzle = 0;
        return this.getFlag(MSF.NOZZLE_BASE + (st - 1) * 2 + nozzle) !== 0;
    }
    getNozzleRight(area: number, nozzle: number) { return this.nozzleRight(area, nozzle); }
    /** setNozzleRight(area, nozzle) */
    setNozzleRight(area: number, nozzle: number) {
        const st = FlagManager.stageOf(area); nozzle &= 0xFF; if (nozzle >= 2) nozzle = 0;
        const f = MSF.NOZZLE_BASE + (st - 1) * 2 + nozzle;
        if (this.getFlag(f) === 0) this.setFlag(f, 1);
    }
    /** getBlueCoinFlag(area, blueCoin) */
    getBlueCoinFlag(area: number, blueCoin: number) {
        const st = FlagManager.stageOf(area); blueCoin &= 0xFF; if (blueCoin >= 50) blueCoin = 0;
        return this.getFlag(MSF.BLUE_COIN_BASE + (st - 1) * 50 + blueCoin) !== 0;
    }
    /** setBlueCoinFlag(area, blueCoin) */
    setBlueCoinFlag(area: number, blueCoin: number) {
        const st = FlagManager.stageOf(area); blueCoin &= 0xFF; if (blueCoin >= 50) blueCoin = 0;
        const f = MSF.BLUE_COIN_BASE + (st - 1) * 50 + blueCoin;
        if (this.getFlag(f) === 0) { this.incFlag(MSF.BLUE_COIN_COUNT, 1); this.setFlag(f, 1); }
    }
}

/**
 * A FlagManager holding a trace's initial flags (MSGT stage-start record, Moonshine
 * GhostTraceInitialFlags::decode/restore): the card, game and stage banks' bools and ints as the stage's
 * setup began. The option banks keep FlagManager's defaults. null when the image isn't 896 bytes.
 */
export function flagsFromTraceImage(img: Uint8Array): FlagManager | null {
    if (img.length !== 896) return null;
    const f = new FlagManager(), dv = new DataView(img.buffer, img.byteOffset, img.byteLength);
    const bools = (off: number, n: number, bank: number) => { for (let i = 0; i < n; i++) f.setFlag((bank << 16) + i, (img[off + (i >> 3)] >> (i & 7)) & 1); };
    const ints = (off: number, n: number, bank: number) => { for (let i = 0; i < n; i++) f.setFlag((bank << 16) + i, dv.getInt32(off + 4 * i)); };
    bools(0x000, 948, 1); ints(0x078, 21, 2);
    bools(0x0CC, 29, 3); ints(0x0D0, 5, 4);
    bools(0x0E4, 100, 5); ints(0x0F4, 100, 6);
    return f;
}

