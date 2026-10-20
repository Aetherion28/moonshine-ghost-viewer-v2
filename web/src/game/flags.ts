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
// Not here: save/load to the card, options, blue coin / nozzle per-area flags (SMS_getShineStage only for VISITED).
import { MSF } from './msflags.js';
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

export class FlagManager {
    /** each bank's values (bools as 0/1), by the id's low 16 bits */
    private banks: Record<number, Int32Array> = {};
    constructor() { for (const b in BANKS) this.banks[b] = new Int32Array(BANKS[b][0] & 0xFFFF); this.correctFlag(); }

    private slot(flag: number, bools: boolean | null): Int32Array | null {
        const bank = flag >>> 16, d = BANKS[bank];
        if (!d || flag >= d[0] || (bools !== null && d[1] !== bools)) return null;
        return this.banks[bank];
    }
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
    }
    /** raise the shine count to at least n (an inferred lower bound) */
    private atLeastShines(n: number) { if (this.getFlag(MSF.SHINE_COUNT) < n) this.setFlag(MSF.SHINE_COUNT, n); }

    /**
     * The save as far as the stage proves it (see the file's head), then TMarDirector::setupObjects'
     * flag writes for (area, scenario).
     */
    setupStage(area: number, scenario: number, exShineGot: boolean, exShineId: number) {
        // -- inferences from the loaded scene
        if (exShineId !== 0xFF && exShineGot) this.setShineFlag(exShineId);
        if (area === 1) {
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
    /** getNozzleRight(area, nozzle) */
    nozzleRight(area: number, nozzle: number) {
        let st = shineStage(area); if (st === 0 || st >= 10) st = 1;
        if (nozzle >= 2) nozzle = 0;
        return this.getFlag(MSF.NOZZLE_BASE + (st - 1) * 2 + nozzle) !== 0;
    }
}
