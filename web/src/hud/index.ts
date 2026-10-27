// The game's HUD over the game layer, drawn from the user's disc as Super Mario Sunshine draws it:
// TGCConsole2 on standard_1.blo (the life meter, the coin, Shine, blue coin and red coin
// counters, the FLUDD tank) and TConsoleStr on big_tx_1.blo / scenario_demo_1.blo (the stage and
// episode names, the opening wipe, "GO!"), with game_6.szs's textures, the system font and the
// BMG names. The page calls frame() every frame; the HUD runs its ticks (the game's 120 a second)
// from the segment's start, so seeking replays them, and draws on its own canvas in the game's 600 x
// 480 layout, scaled to the view's height.
//
// Values: the coins, red coins, blue coins and Shines come from the simulated stage's events
// (counted from the stage's start: the save's totals aren't in a ghost); Mario's health isn't
// recorded, so it stays full; his air goes down under water (the stage's water surfaces, as
// TMario::isUnderWater); FLUDD's tank is the simulated player's TWaterGun when the sim runs one
// (World.waterGunLog), else it follows the ghost's FLUDD record (its nozzle and what it sprays, at
// the nozzles' own rates from params.szs) and fills in water while R is held.

import * as RARC from '../../noclip/Common/JSYSTEM/JKRArchive.js';
import * as Yaz0 from '../../noclip/Common/Compression/Yaz0.js';
import ArrayBufferSlice from '../../noclip/ArrayBufferSlice.js';
import { parseBlo, Pane, Screen } from './blo.js';
import { Font, Tex, parseBTI, bmgMessage, parsePrm, prmF, prmI } from './gx.js';
import { Painter, M, mul, I } from './draw.js';
import { Console, ConsoleInput } from './console.js';
import { ConsoleStr, S } from './consolestr.js';
import { TalkView } from './talkview.js';
import { PauseMenu, GameOverMenu, SelectMenu } from './menus.js';
import { Wipe, HX_W, HX_H } from './wipe.js';
import { MovieScreen } from './moviescreen.js';
import { loadSlot } from '../game/savefile.js';

interface GameFS { has(p: string): boolean; read(p: string): Promise<ArrayBuffer>; }
const store = {
    get(k: string, d: boolean) { try { const v = localStorage.getItem('ghostViewer.' + k); return v === null ? d : v === '1'; } catch { return d; } },
    set(k: string, v: boolean) { try { localStorage.setItem('ghostViewer.' + k, v ? '1' : '0'); } catch { /* storage unavailable */ } },
};
function archive(buf: ArrayBuffer) {
    let b = new ArrayBufferSlice(buf);
    if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) === 'Yaz0') b = Yaz0.decompressSW(b);
    const arc = RARC.parse(b), files = new Map<string, Uint8Array>();
    const walk = (d: RARC.RARCDir, prefix: string) => {
        for (const f of d.files) files.set((prefix + f.name).toLowerCase(), f.buffer.createTypedArray(Uint8Array));
        for (const s of d.subdirs) if (s.name !== '.' && s.name !== '..') walk(s, prefix + s.name + '/');
    };
    walk(arc.root, '');
    return files;
}

/**
 * The opening's length in simulation ticks (QF: TMarDirector::direct runs four a frame, and the
 * console's movement runs on every one; its calc-anim part on a frame's last): the bars closing,
 * the dark between, the halves opening, measured by running TConsoleStr.
 */
export const INTRO_FRAMES = { close: 46, hold: 41, open: 31 };
const QF_PER_FRAME = 1;
/** TMarDirector::changeState: the stages whose opening shows their names (else the bars just close) */
const NAMED_STAGES = new Set([2, 3, 4, 5, 6, 8, 9, 0x34, 1]);
const DIVING_MAPS = new Set([0x39, 0x2C, 0x10]);
const COUNTED = new Set(['coinGet', 'redCoinGet', 'blueCoinGet', 'shineGet', 'waterRecover']);
/** TWaterGun's nozzles (Spray, Rocket, Underwater, Yoshi, Hover, Turbo): their .prm, emitters and kind */
const NOZZLES: [string, number, boolean][] = [['nozzledeform', 1, true], ['nozzletrgrocket', 1, false], ['nozzlediving', 2, true], ['nozzleyoshi', 1, true], ['nozzletrghover', 2, false], ['nozzletrgturbo', 1, false]];

export interface HudApi {
    ghostSampleAt(d: any, t: number): any; ghostAnimAt(d: any, t: number): any; ghostFluddAt(d: any, t: number): any;
}
export interface HudFrame {
    /** the time (QF from the ghost's start) and whether the game layer is drawn */
    t: number; on: boolean;
    /** the leading ghost and the viewer's ghost readers */
    ghost: any; api: HudApi;
    /** the simulated stage (GameLayer.sim) */
    sim: any;
    /** a demo camera at QF q (the Shine get demo) */
    demoAt?: (q: number) => boolean;
    /**
     * Live play: the stage's opening as its director runs it (stage ticks, -1 not yet / none): the
     * tick STATE_UNK1's demo started (startAppearScenario on a named stage), the console's close
     * wipe started (startCloseWipe) and the game began (STATE_UNK4: startAppearGo after a demo,
     * the console from there). key: the live stage.
     */
    live?: { key: string; demo: number; close: number; go: number };
}

/** TWaterGun's tank after a movement tick (player/watergun.ts's WaterGunRecord, in World.waterGunLog) */
interface WaterGunRecord { t: number; water: number; max: number; nozzle: number; fludd: boolean; }
/** the simulated player's tank at the stage's tick t (the latest record at or before it), or null */
function simWaterGunAt(w: any, t: number): WaterGunRecord | null {
    const L: WaterGunRecord[] | null | undefined = w && w.waterGunLog;
    if (!L || !L.length || L[0].t > t) return null;
    let lo = 0, hi = L.length - 1;
    while (lo < hi) { const k = (lo + hi + 1) >> 1; if (L[k].t <= t) lo = k; else hi = k - 1; }
    return L[lo];
}
/** the simulated player's health and air (player/player.ts's World.playerLog), at the stage's tick t, or null */
interface PlayerRecord { t: number; health: number; air: number; underWater: boolean; }
function playerStateAt(w: any, t: number): PlayerRecord | null {
    const L: PlayerRecord[] | null | undefined = w && w.playerLog;
    if (!L || !L.length || L[0].t > t) return null;
    let lo = 0, hi = L.length - 1;
    while (lo < hi) { const k = (lo + hi + 1) >> 1; if (L[k].t <= t) lo = k; else hi = k - 1; }
    return L[lo];
}

interface Seg { key: string; q0: number; qIn: number; area: number; episode: number; intro: boolean; }
interface Nozzle { max: number; dec: number; num: number; numMin: number; pow: number; powMin: number; suck: number; emitters: number; deform: boolean; acc: number; }

export class GameHud {
    /** the opening's frame counts, for the page's intro camera */
    static INTRO = INTRO_FRAMES;
    show = store.get('hud', true);
    canvas: HTMLCanvasElement;
    status = '';
    private fs: GameFS | null = null;
    private loading: Promise<void> | null = null;
    private ready = false;
    private tex = new Map<string, Tex | null>();
    private files = new Map<string, Uint8Array>();
    private common = new Map<string, Uint8Array>();
    private params = new Map<string, Uint8Array>();
    private font: Font | null = null;
    private painter: Painter | null = null;
    private nozzles: Nozzle[] = [];
    private airDec = 0.002; private airInc = 0.03; private breath = 50;
    // the running state: this segment's console and console string, and the frame they are at
    private seg: Seg | null = null;
    private con: Console | null = null; private str: ConsoleStr | null = null;
    private conF = -1; private strF = -1;
    private st: { evI: number; world: any; coins: number; red: number; blue: number; shines: number; water: number; nozzle: number; air: number; prevPos: number[] | null; still: number } | null = null;
    private closeF = 0; private goF = 0;
    private drawn = false;

    constructor() {
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'hudLayer';
        this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
        this.canvas.hidden = true;
        this.overlay = document.createElement('canvas');
        this.overlay.className = 'hudOverlay';
        this.overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:3';
        this.overlay.hidden = true;
        (globalThis as any).gameHudInstance = this;   // (for debugging from the console)
    }
    setShow(v: boolean) { this.show = v; store.set('hud', v); }
    setDisc(fs: GameFS) { this.fs = fs; this.ready = false; this.loading = null; this.reset(); }
    private reset() { this.seg = null; this.con = null; this.str = null; this.conF = this.strF = -1; this.st = null; }

    private async load() {
        const fs = this.fs!;
        const read = async (p: string) => (fs.has(p) ? archive(await fs.read(p)) : null);
        const g6 = await read('data/game_6.szs');
        if (!g6) throw new Error('no data/game_6.szs');
        this.files = g6;
        this.common = (await read('data/common.szs')) || new Map();
        this.params = (await read('data/params.szs')) || new Map();
        // the system font (nlogo.szs's /font/standard_fontEx.bfn; common.szs's test font, a copy of it, else)
        const nlogo = (await read('data/nintendo.szs').catch(() => null)) || (await read('data/nlogo.szs').catch(() => null));
        const fb = (nlogo && nlogo.get('font/standard_fontex.bfn')) || this.common.get('test_fontex.bfn') || null;
        try { this.font = fb ? new Font(fb) : null; } catch (e) { console.warn('[hud] font', e); }
        this.painter = new Painter((n) => this.texture(n), this.font);
        this.nozzles = NOZZLES.map(([n, emitters, deform]) => {
            const b = this.params.get(`mario/watergun/${n}.prm`), m = b ? parsePrm(b) : null;
            return { max: prmI(m, 'mAmountMax', 2100), dec: prmI(m, 'mDecRate', 0), num: prmF(m, 'mNum', 1), numMin: prmF(m, 'mNumMin', 1), pow: prmF(m, 'mEmitPow', 40),
                powMin: prmF(m, 'mEmitPowMin', 0), suck: prmF(m, 'mSuckRate', 0.1), emitters, deform, acc: 0 };
        });
        const sw = this.params.get('mario/swim.prm'), sm = sw ? parsePrm(sw) : null;
        this.airDec = prmF(sm, 'mAirDec', 0.002); this.airInc = prmF(sm, 'mAirInc', 0.03); this.breath = prmF(sm, 'mCanBreathDepth', 50);
        // the talk window (TTalk2D2: message_2.blo, message_board_1.blo, message_back_1.bti)
        try {
            if (this.font && this.files.has('scrn/message_2.blo') && this.files.has('scrn/message_board_1.blo'))
                this.talkView = new TalkView(this.screen('message_2.blo'), this.screen('message_board_1.blo'), this.font, this.texture('message_back_1.bti'), this.texture('message_back_0.bti'));
        } catch (e) { console.warn('[hud] talk window', e); this.talkView = null; }
        this.ready = true;
    }
    private talkView: TalkView | null = null;
    /** the full-screen 2D screens' canvas (over the page's fade): the fader's wipes, the menus, the movies */
    overlay: HTMLCanvasElement;
    private more = new Map<string, Map<string, Uint8Array> | null | Promise<void>>();
    /** another 2D archive (select.szs, subtitle.szs): its files, null when the disc has none, undefined while it loads */
    private archive2(name: string): Map<string, Uint8Array> | null | undefined {
        const v = this.more.get(name);
        if (v instanceof Promise) return undefined;
        const fs = this.fs;
        if (v !== undefined && (v !== null || !fs || !fs.has(`data/${name}`))) return v;
        if (!fs || !fs.has(`data/${name}`)) { this.more.set(name, null); return null; }
        this.more.set(name, fs.read(`data/${name}`).then((b) => { this.more.set(name, archive(b)); }, (e) => { console.warn('[hud]', name, e); this.more.set(name, null); }));
        return undefined;
    }
    private texFrom(files: Map<string, Uint8Array>, key: string) {
        return (name: string): Tex | null => {
            const k = key + name.toLowerCase();
            if (this.tex.has(k)) return this.tex.get(k)!;
            let t: Tex | null = null;
            const b = files.get('timg/' + name.toLowerCase());
            try { t = b ? parseBTI(b) : this.texture(name); } catch (e) { console.warn('[hud]', name, e); }
            this.tex.set(k, t);
            return t;
        };
    }
    private selectPainter: Painter | null = null;
    private subPainter: Painter | null = null;
    /**
     * The live runner's screen makers (game/runner.ts LiveScreens): the pause menu and the game
     * over's choice from game_6.szs, the episode select from select.szs, the movies from the disc's
     * THP files with subtitle.szs's subtitles.
     */
    screens = {
        pauseMenu: (o: { area: number; episode: number }) => {
            if (!this.ready || !this.files.has('scrn/pause_1.blo')) return null;
            const n = this.names(o.area, o.episode);
            const delfino = o.area <= 1;
            return new PauseMenu(this.screen('pause_1.blo'), { delfino, stageName: n.stage, scenarioName: n.shineStage === 0 || delfino ? '' : n.scenario });
        },
        gameOverMenu: () => (this.ready && this.files.has('scrn/save.blo') ? new GameOverMenu(this.screen('save.blo')) : null),
        selectMenu: (o: { stage: number; states: number[]; open: number; coins: number; coinShine: boolean; extra: number }) => {
            const a = this.archive2('select.szs');
            if (a === undefined) return undefined;
            if (!a || !a.has('scrn/scenario_select_1.blo') || !this.ready) return null;
            try {
                this.selectPainter = new Painter(this.texFrom(a, 'select:'), this.font);
                const seed = { v: (Date.now() & 0x7FFFFFFF) >>> 0 };
                const rand = () => { seed.v = (Math.imul(seed.v, 1103515245) + 12345) >>> 0; return (seed.v >>> 16) & 0x7FFF; };
                const m = new SelectMenu(parseBlo(a.get('scrn/scenario_select_1.blo')!), { ...o, stageName: this.names(o.stage, 0).stage, scenarioName: (e: number) => this.names(o.stage, e).scenario },
                    (i) => `sc_number_${i + 1}.bti`, rand);
                m.setStageColor(o.stage);
                return m;
            } catch (e) { console.warn('[hud] select', e); return null; }
        },
        movie: (id: number, flags: any) => {
            const fs = this.fs as any;
            if (!fs || typeof fs.list !== 'function') return null;
            const sub = this.archive2('subtitle.szs');
            if (sub === undefined) return undefined;
            const music = () => !(globalThis as any).gameAudioMuted;
            return new MovieScreen(fs, id, flags, (name, tall) => {
                if (!sub) return null;
                const blo = sub.get(tall ? 'scrn/demo_1.blo' : 'scrn/demo_2.blo');
                if (!blo) return null;
                // (me_a / me_b keep their blo font: the subtitle archive's own, else the system font)
                const scr = parseBlo(blo);
                this.subPainter = new Painter(this.texFrom(sub, 'subtitle:'), this.font);
                const walk = (p: Pane) => { if (p.kind === 'TBX1') p.fontOn = true; for (const c of p.children) walk(c); };
                walk(scr);
                return { scr, bmg: sub.get(name.toLowerCase().replace(/\.thp$/, '.bmg')) || null };
            }, music);
        },
    };
    private texture(name: string): Tex | null {
        const k = name.toLowerCase();
        if (this.tex.has(k)) return this.tex.get(k)!;
        let t: Tex | null = null;
        if (k.startsWith('#font')) t = this.font ? this.font.sheets[+k.slice(5)] || null : null;
        else { const b = this.files.get('timg/' + k); try { t = b ? parseBTI(b) : null; } catch (e) { console.warn('[hud]', name, e); } }
        this.tex.set(k, t);
        return t;
    }
    private screen(name: string): Screen { return parseBlo(this.files.get('scrn/' + name)!); }

    /** the segment the time is in: its stage's start, its first input (Mario's control: TMarDirector state 4), and whether it opened with a demo */
    private segAt(d: any, api: HudApi, t: number): Seg | null {
        const s = api.ghostSampleAt(d, t);
        if (!s || !d.segments) return null;
        const segI = d.segIndex[s.i], seg = d.segments[segI];
        if (!seg) return null;
        const q0 = seg.startQf - d.header.startQf;
        const I = d.inputs;
        let qIn = q0;
        if (I && I.count) {
            let lo = 0, hi = I.count;
            while (lo < hi) { const m = (lo + hi) >> 1; if (I.qf[m] < q0) lo = m + 1; else hi = m; }
            if (lo < I.count) qIn = I.qf[lo];
        }
        const total = (INTRO_FRAMES.close + INTRO_FRAMES.hold + INTRO_FRAMES.open) * QF_PER_FRAME;
        return { key: `${d.header && d.header.created}|${segI}|${q0}`, q0, qIn, area: seg.route.area, episode: seg.route.episode, intro: qIn - q0 >= total + 8 };
    }
    /** the opening's phases at time t, for the camera: the demo camera holds until the screen is covered */
    static introPhase(q0: number, qIn: number, t: number) {
        const F = INTRO_FRAMES, open = qIn - F.open * QF_PER_FRAME, hold = open - F.hold * QF_PER_FRAME, close = hold - F.close * QF_PER_FRAME;
        return { close, covered: hold, open, demo: t < hold };
    }

    private newState(seg: Seg) {
        this.seg = seg;
        this.con = null; this.conF = -1;
        this.str = new ConsoleStr(this.screen('big_tx_1.blo'), this.screen('scenario_demo_1.blo'));
        this.strF = -1;
        const named = NAMED_STAGES.has(seg.area);
        if (seg.intro && named) this.setNames(seg);
        const F = INTRO_FRAMES;
        this.goF = Math.floor((seg.qIn - seg.q0) / QF_PER_FRAME);
        this.closeF = this.goF - (F.close + F.hold + F.open);
        this.st = { evI: 0, world: null, coins: 0, red: 0, blue: 0, shines: 0, water: 1, nozzle: 0, air: 9 - 1e-5, prevPos: null, still: 0 };
    }
    /** TConsoleStr::load: the stage's name and the episode's from the BMGs */
    private setNames(seg: Seg) {
        const n = this.names(seg.area, seg.episode), str = this.str!;
        str.titles[0].text = n.stage;
        str.titles[1].text = seg.area !== 15 ? n.scenario : '';
    }
    /** the stage's name (stagename.bmg by SMS_getShineStage) and the episode's (scenarioname.bmg by SMS_getShineID / SMS_getNormalStage) */
    names(area: number, episode: number) {
        const SHINE_STAGE = [0, 1, 2, 3, 4, 5, 6, 6, 7, 8, 9, 1, 1, 5, 6, 1, 8, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 3, 8, 4, 4, 5, 5, 5, 5, 5, 5, 6, 5, 7, 7, 8, 8, 2, 2, 3, 3, 5, 6, 9, 1, 1, 2, 6, 8, 5, 3, 9];
        const SHINES: (number[] | null)[] = [[0x56], null, [0, 1, 2, 3, 4, 5, 6, 7], [10, 11, 12, 13, 14, 15, 16, 17], [20, 21, 22, 23, 24, 25, 26, 27], [30, 31, 32, 33, 34, 35, 36, 37],
            [40, 41, 42, 43, 44, 45, 46, 47], [60, 65, 62, 61, 64, 63, 66, 67], [50, 51, 52, 53, 54, 55, 56, 57], null];
        const NAMES = [0x0, 0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8, 0x9, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x3B, 0xA, 0xB, 0xC, 0xD, 0xE, 0xF, 0x10, 0x11, 0x12, 0x13, 0x28, 0x29,
            0x2A, 0x2B, 0x2C, 0x2D, 0x2E, 0x2F, 0x30, 0x31, 0x3C, 0x3D, 0x3E, 0x3F, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E, 0x21, 0x20, 0x23,
            0x22, 0x1F, 0x24, 0x25, 0x26, 0x27];
        const stage = SHINE_STAGE[area] ?? 1;
        const sn = this.common.get('2d/stagename.bmg'), sc = this.common.get('2d/scenarioname.bmg');
        const id = SHINES[stage] ? SHINES[stage]![episode] : undefined;
        return { stage: (sn && bmgMessage(sn, stage)) || '', scenario: sc && id !== undefined && NAMES[id] !== undefined ? bmgMessage(sc, NAMES[id]) || '' : '', shineStage: stage };
    }

    private lateEvent(stage: any, seg: Seg) {
        const st = this.st;
        if (!stage || !st || !this.con || st.world !== stage.world) return false;
        const ev = stage.world.events as { t: number; kind: string }[], done = seg.qIn + this.conF * QF_PER_FRAME;
        for (let i = st.evI; i < ev.length; i++) {
            const q = seg.q0 + ev[i].t * QF_PER_FRAME;
            if (q > done) return false;
            if (COUNTED.has(ev[i].kind)) return true;
        }
        return false;
    }
    /** the simulated stage, when it's this segment's */
    private simStage(sim: any, seg: Seg) {
        const st = sim && sim.stage;
        return st && st.world && Math.abs(sim.q0 - seg.q0) < 1 ? st : null;
    }
    private inputAt(d: any, q: number) {
        const I = d.inputs;
        if (!I || !I.count || q < I.qf[0]) return -1;
        let lo = 0, hi = I.count - 1;
        while (lo < hi) { const m = (lo + hi + 1) >> 1; if (I.qf[m] <= q) lo = m; else hi = m - 1; }
        return lo;
    }
    /** what TGCConsole2 reads from the game for its frame at QF q */
    private consoleInput(f: HudFrame, seg: Seg, q: number, stage: any): ConsoleInput {
        const st = this.st!, d = f.ghost, api = f.api;
        // the stage's events up to q: what's been collected
        const w = stage ? stage.world : null;
        if (w !== st.world) { st.world = w; st.evI = 0; st.coins = st.red = st.blue = st.shines = 0; }
        let shineTaken = st.shines > 0, recover = false;
        if (w) {
            const ev = w.events as { t: number; kind: string; data: any }[];
            while (st.evI < ev.length && seg.q0 + ev[st.evI].t * QF_PER_FRAME <= q) {
                const e = ev[st.evI++];
                if (e.kind === 'coinGet') st.coins = e.data && e.data.count ? e.data.count : st.coins + 1;
                else if (e.kind === 'redCoinGet') st.red = e.data && e.data.count ? e.data.count : st.red + 1;
                else if (e.kind === 'blueCoinGet') st.blue++;
                else if (e.kind === 'shineGet') { st.shines++; shineTaken = true; }
                else if (e.kind === 'waterRecover') recover = true;
            }
        }
        const s = api.ghostSampleAt(d, q);
        const pos = s && !s.gap ? [s.x, s.y, s.z] : null;
        // in the water: a water surface above him (TMario::thinkWaterSurface's check, from above)
        let surface = -Infinity;
        if (w && pos) for (const up of [200, 1500]) {
            try { const [h, pl] = w.checkGround(pos[0], pos[1] + up, pos[2]); if (pl && pl.isWaterSurface && pl.isWaterSurface() && h >= pos[1]) { surface = h; break; } } catch { break; }
        }
        const inWater = surface > -Infinity, underWater = inWater && pos !== null && pos[1] + 80 < surface - this.breath;
        // standing still (STATUS_WAIT): where he was a frame ago
        const s4 = api.ghostSampleAt(d, q - 4);
        if (pos && s4 && !s4.gap && Math.hypot(pos[0] - s4.x, pos[1] - s4.y, pos[2] - s4.z) < 0.05) st.still++; else st.still = 0;
        // air (TMario: mAirDec under water, mAirInc out of it)
        if (underWater) st.air = Math.max(0, st.air - this.airDec); else st.air = Math.min(9 - 1e-5, st.air + this.airInc);
        // FLUDD's tank: the simulated player's TWaterGun when the sim runs one (its log, player/watergun.ts),
        // else estimated from the ghost's FLUDD record
        const fl = api.ghostFluddAt(d, q);
        const wg = w ? simWaterGunAt(w, Math.floor((q - seg.q0) / QF_PER_FRAME)) : null;
        let fludd = !!(fl && fl.present);
        if (wg) {
            fludd = wg.fludd;
            st.nozzle = wg.nozzle in this.nozzles ? wg.nozzle : 0;
            st.water = wg.max > 0 ? Math.max(0, Math.min(1, wg.water / wg.max)) : 0;
        } else if (fludd) {
            const n = fl.nozzle in this.nozzles ? fl.nozzle : 0;
            if (n !== st.nozzle) st.nozzle = n;   // (setAmountToRate: the fill carries over)
            const N = this.nozzles[n];
            let water = st.water * N.max;
            if (fl.spraying || fl.burst) {   // TNozzle*::emit: emitNum particles a frame, each mDecRate of water
                const span = N.pow - N.powMin;
                const u = fl.burst ? 1 : Math.max(0, Math.min(1, span ? (fl.power - N.powMin) / span : 1));
                for (let e = 0; e < N.emitters && water > 0; e++) {
                    N.acc = Math.fround(N.acc + (u * (N.num - N.numMin) + N.numMin));
                    const k = Math.trunc(N.acc);
                    N.acc -= k;
                    water -= k * N.dec;
                }
            }
            const i = this.inputAt(d, q);
            const R = i >= 0 && d.inputs.trig ? Math.min(1, d.inputs.trig[i * 2 + 1] / 150) : 0;
            if (inWater && R > 0) water += Math.trunc(R * 150 * N.suck);   // TWaterGun::suck
            if (recover) water = N.max;
            st.water = Math.max(0, Math.min(1, water / N.max));
        }
        // the simulated player's health and air (TMario::mHealth / mAir), when the sim runs one from the inputs
        const ps = w ? playerStateAt(w, Math.floor((q - seg.q0) / QF_PER_FRAME)) : null;
        const air = ps ? Math.trunc(ps.air) : Math.trunc(st.air);
        return {
            coins: st.coins, red: st.red, blue: st.blue, shines: st.shines, health: ps ? ps.health : 8, air, underWater: ps ? ps.underWater : underWater,
            fludd, nozzle: st.nozzle, water: st.water, full: st.water >= 1, waiting: st.still > 0, demo: !!(f.demoAt && f.demoAt(q)), shineTaken,
            diving: DIVING_MAPS.has(seg.area),
        };
    }

    /** the page's frame: bring the HUD to time t and draw it */
    frame(f: HudFrame) {
        this.frameMain(f);
        try { this.overlayFrame(f); } catch (e) { console.warn('[hud] overlay', e); }
    }
    private frameMain(f: HudFrame) {
        if (!f.on || !this.fs || !f.ghost) { this.clear(); return; }
        if (!this.ready) {
            if (!this.loading) this.loading = this.load().catch((e) => { this.status = 'HUD: ' + (e && e.message ? e.message : e); console.warn('[hud]', e); });
            this.clear(); return;
        }
        if (f.live) { this.liveFrame(f, f.live); return; }
        const seg = this.segAt(f.ghost, f.api, f.t);
        if (!seg) { this.clear(); return; }
        if (!this.seg || this.seg.key !== seg.key) this.newState(seg);
        const stage = this.simStage(f.sim, seg);
        // TConsoleStr from the stage's start: the names, the wipes, GO!
        const sf = Math.floor((f.t - seg.q0) / QF_PER_FRAME);
        const cf = Math.floor((f.t - seg.qIn) / QF_PER_FRAME);
        // (back in time, or the simulated stage, catching up, told of a pickup the HUD had already
        // gone past: start the segment over)
        if (sf < this.strF || (this.con && cf < this.conF) || this.lateEvent(stage, seg)) this.newState(seg);
        const named = NAMED_STAGES.has(seg.area), str = this.str!;
        while (this.strF < sf && this.strF < this.goF + 400) {
            const k = ++this.strF;
            if (seg.intro) {
                if (k === 0 && named) str.startAppearScenario();
                if (k === this.closeF) { if (named && str.unk2BC !== S.UNK1) { str.unk2BC = S.UNK1; } str.startCloseWipe(!named); }
                if (k === this.goF) str.startAppearGo();
            }
            str.frame();
            if (str.unk2BC === S.UNK4) str.startOpenWipe();
        }
        // TGCConsole2 from Mario's first frame (TMarDirector state 4)
        if (cf >= 0) {
            if (!this.con) {
                this.con = new Console(this.screen('standard_1.blo'), this.consoleInput(f, seg, seg.qIn, stage));
                this.conF = -1;
                for (const n of this.nozzles) n.acc = 0;
            }
            const t0 = performance.now();
            while (this.conF < cf && performance.now() - t0 < 30) { this.conF++; const q = seg.qIn + this.conF * QF_PER_FRAME; this.con.frame(this.consoleInput(f, seg, q, stage), (q - seg.q0) % 4 === 3); }
        }
        // (still replaying the segment after a seek: the console shows once it has caught up)
        this.drawTalk = stage && stage.world ? stage.world.talk : null;
        this.draw(seg, !this.con || cf - this.conF <= 8);
    }
    /**
     * Live play: TConsoleStr and TGCConsole2 driven by the live director (TMarDirector's
     * changeState / nextStateInitialize, MarDirectorDirect.cpp): entering STATE_UNK1 shows a named
     * stage's names between their bars (startAppearScenario), the demo's end closes the bars
     * (startCloseWipe, without the names on a stage whose demo only has the opening wipe), their
     * hold done the halves open (startOpenWipe), and STATE_UNK4 starts GO! and the console.
     * Live play only moves forward: the HUD carries on a tick at a time.
     */
    private liveFlags = { named: false };
    private missAt = -1;
    private strNow = -1; private strClock = 0;
    private liveFrame(f: HudFrame, L: { key: string; demo: number; close: number; go: number }) {
        const r = f.ghost.segments[0].route, named = NAMED_STAGES.has(r.area);
        const seg: Seg = { key: L.key, q0: 0, qIn: L.go >= 0 ? L.go : Infinity, area: r.area, episode: r.episode, intro: L.demo >= 0 };
        if (!this.seg || this.seg.key !== seg.key || f.t < this.strF) { this.newState(seg); this.liveFlags.named = false; this.missAt = -1; this.strClock = f.t < 24 ? 0 : f.t; }
        const S0 = this.seg!;
        S0.qIn = seg.qIn; S0.intro = seg.intro;
        const str = this.str!;
        if (L.demo >= 0 && named && !this.liveFlags.named) { this.setNames(S0); this.liveFlags.named = true; }
        // (a stage without a demo has no opening: its console string stays idle)
        if (L.demo < 0) this.strF = f.t;
        // the director's miss (STATE_UNK7: startAppearMiss)
        const D0 = f.sim && f.sim.stage ? f.sim.stage.director : null;
        const missAt = D0 && D0.state === 7 ? D0.enteredTick : -1;
        if (missAt >= 0 && this.missAt !== missAt && f.t >= missAt) { this.missAt = missAt; str.startAppearMiss(); }
        // (the console string's ticks paced by the display clock, 120 a second as the game runs them, up
        // to the sim's tick: the sim hands its ticks over 4 at a time, more when it catches up, which
        // stepped the bars unevenly; it is never more than 24 ticks behind)
        const now = performance.now(), dt = this.strNow >= 0 ? Math.min(0.1, (now - this.strNow) / 1000) : 0;
        this.strNow = now;
        this.strClock = Math.min(f.t, Math.max(this.strClock + dt * 120, f.t - 24, this.strF));
        const tT = Math.floor(this.strClock);
        while (this.strF < tT && (this.strF < (L.go >= 0 ? L.go + 400 : Infinity) || str.unk2B8 !== 0)) {
            const k = ++this.strF;
            if (k === L.demo && named) str.startAppearScenario();
            if (k === L.close) { if (named && str.unk2BC !== S.UNK1) str.unk2BC = S.UNK1; str.startCloseWipe(!named); }
            if (k === L.go && L.demo >= 0) str.startAppearGo();
            str.frame();
            if (str.unk2BC === S.UNK4) str.startOpenWipe();
        }
        if (this.strF < tT) this.strF = tT;
        const stage = this.simStage(f.sim, S0);
        const cf = L.go >= 0 ? f.t - L.go : -1;
        if (cf >= 0) {
            if (!this.con) {
                this.con = new Console(this.screen('standard_1.blo'), this.consoleInput(f, S0, L.go, stage));
                this.conF = -1;
                for (const n of this.nozzles) n.acc = 0;
            }
            const t0 = performance.now();
            while (this.conF < cf && performance.now() - t0 < 30) { this.conF++; const q = L.go + this.conF; this.con.frame(this.consoleInput(f, S0, q, stage), q % 4 === 3); }
        }
        this.drawTalk = stage && stage.world ? stage.world.talk : null;
        this.draw(S0, !this.con || cf - this.conF <= 8);
    }
    private clear() {
        if (!this.drawn) return;
        const cx = this.canvas.getContext('2d');
        if (cx) { cx.setTransform(1, 0, 0, 1, 0, 0); cx.clearRect(0, 0, this.canvas.width, this.canvas.height); }
        this.canvas.hidden = true; this.drawn = false;
    }
    /** whether the HUD draws the opening's wipe now (the page's own fade stays off then) */
    get drawsWipe() { return this.ready; }

    private draw(seg: Seg, consoleReady: boolean) {
        const c = this.canvas, r = c.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
        const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
        if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
        const cx = c.getContext('2d')!;
        cx.setTransform(1, 0, 0, 1, 0, 0); cx.clearRect(0, 0, W, H);
        c.hidden = false; this.drawn = true;
        cx.imageSmoothingEnabled = true;
        const sc = Math.min(H / 480, W / 600), ox = (W - 600 * sc) / 2, oy = (H - 480 * sc) / 2;
        const base: M = [sc, 0, 0, sc, ox, oy];
        // the layout's edges on the canvas (the wipes reach past the 600 x 480 frame to cover the view)
        const ext = { x1: -ox / sc, x2: (W - ox) / sc, y1: -oy / sc, y2: (H - oy) / sc };
        const P = this.painter!, con = this.con, str = this.str!;
        if (con && this.show && consoleReady) {
            // TGCConsole2::perform's draw: the tank's back, the screen, the water
            const tankUp = con.unk46 || con.unk45;
            if (tankUp && con.wBack.pane.visible) {
                const p = con.wBack.pane, b = p.bounds, saved = [p.black, p.white];
                p.black = 0x0000FF00; p.white = 0x0000FF78;
                P.picture(cx, p, mul(base, [1, 0, 0, 1, b.x1, b.y1]), 255);
                [p.black, p.white] = saved;
            }
            P.drawScreen(cx, con.scr, base);
            if (con.wRoot.pane.visible) this.drawWater(cx, base, con);
        }
        if (str.unk2B8 !== 0) {
            const wipe = new Set(['msk1', 'msk2', 'wp_l', 'wp_r']);
            const tg = (p: Pane) => { let s = ''; for (let i = 3; i >= 0; i--) { const ch = (p.tag >>> (i * 8)) & 255; if (ch) s += String.fromCharCode(ch); } return s; };
            if (str.unk2B8 === 4) {
                P.drawScreen(cx, str.demo, base, (p) => {
                    const t = tg(p);
                    if (t === 'map' || t === 'stry') return !this.show;
                    if (!wipe.has(t)) return false;
                    // the bars and halves, stretched to the view's edges
                    const g = p.global, at = { x1: 0, y1: 0, x2: p.width, y2: p.height };
                    if (g.x1 <= 0) at.x1 = ext.x1 - g.x1;
                    if (g.x2 >= 600) at.x2 = ext.x2 - g.x1;
                    if (t === 'msk1' || t.startsWith('wp')) at.y1 = Math.min(0, ext.y1 - g.y1);
                    if ((t === 'msk2' && g.y2 >= 464) || t.startsWith('wp') || (t === 'msk1' && g.y2 >= 464)) at.y2 = Math.max(p.height, ext.y2 - g.y1);
                    P.picture(cx, p, mul(base, (p as any)._m), p.colorAlpha, at);
                    return true;
                });
            } else if (this.show) {
                if (str.unk2B8 === 1 && str.unk18 > 60) this.drawGoTrails(cx, base, str);
                P.drawScreen(cx, str.big, base);
            }
        }
        // TTalk2D2 (its CUE_DRAW in the director's talk mode)
        if (this.talkView && this.show && this.drawTalk) {
            const T = this.drawTalk;
            this.drawTalk = null;
            try { this.talkView.draw(cx, P, base, T); } catch (e) { console.warn('[hud] talk', e); }
        }
        void seg;
    }
    /** the talk director to draw this frame (set by frame from the simulated stage) */
    private drawTalk: any = null;
    private overlayOn = false;
    private wipe: Wipe | null = null;
    /** the overlay: the fader's miss wipes, then the screen the live runner shows (a menu, a movie) */
    private overlayFrame(f: HudFrame) {
        const R: any = f.sim, c = this.overlay;
        let scr = R && R.screen ? R.screen : null;
        const st = f.on && R && R.stage ? R.stage : null, D = st ? st.director : null;
        const mw = f.live && D && D.missWipe ? D.missWipe : null;
        if (!this.ready || (!scr && !mw)) {
            if (this.overlayOn) { const g = c.getContext('2d'); if (g) { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height); } c.hidden = true; this.overlayOn = false; }
            this.wipe = null;
            return;
        }
        const r = c.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
        const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
        if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
        const cx = c.getContext('2d')!;
        cx.setTransform(1, 0, 0, 1, 0, 0); cx.clearRect(0, 0, W, H);
        c.hidden = false; this.overlayOn = true;
        cx.imageSmoothingEnabled = true;
        const sc = Math.min(H / 480, W / 600), base: M = [sc, 0, 0, sc, (W - 600 * sc) / 2, (H - 480 * sc) / 2];
        // the wipe: frames of 4 ticks from its start, over the whole view
        const leaving = !!(R && (R.pending || R.leaving || (scr && scr.kind !== 'pause')));
        if (mw || (leaving && this.wipe)) {
            if (mw && (!this.wipe || this.wipe.type !== mw.type || this.wipe.start !== mw.tick)) this.wipe = new Wipe(mw.type, mw.tick);
            const w = this.wipe!;
            const t = st ? st.qf : 0;
            const n = Math.floor((t - w.start) / 4) + w.start;
            cx.setTransform(W / HX_W, 0, 0, H / HX_H, 0, 0);
            w.draw(cx, mw ? n : w.start + 100000, this.common.has('2d/wipe_gameover.bti') ? this.gameOverTex() : null);
        } else this.wipe = null;
        if (!scr) return;
        const m = scr.menu;
        if (scr.kind === 'movie') { m.draw(cx, this.subPainter || this.painter!, W, H, base); return; }
        if (scr.kind === 'select') { m.draw(cx, this.selectPainter || this.painter!, base, (g: CanvasRenderingContext2D, x: number, y: number, size: number, alpha: number, empty: boolean, spin: number) => this.shineSprite(g, x, y, size, alpha, empty, spin)); return; }
        m.draw(cx, this.painter!, base);
    }
    private goTex: Tex | null | undefined = undefined;
    private gameOverTex() {
        if (this.goTex === undefined) { const b = this.common.get('2d/wipe_gameover.bti'); try { this.goTex = b ? parseBTI(b) : null; } catch { this.goTex = null; } }
        return this.goTex;
    }
    /** a Shine of the episode select (shine_menu.bmd stood in for by the HUD's Shine icon): its place, size, fade and spin */
    private shineSprite(cx: CanvasRenderingContext2D, x: number, y: number, size: number, alpha: number, empty: boolean, spin: number) {
        const img = this.painter!.image('shine_icon.bti', 0, empty ? 0xFFFFFF60 : 0xFFFFFFFF);
        if (!img || alpha <= 0) return;
        const t = this.texture('shine_icon.bti');
        if (!t) return;
        const w = size * Math.max(0.15, Math.abs(Math.cos((spin * Math.PI) / 180))), h = size * (t.h / t.w);
        cx.globalAlpha = alpha * (empty ? 0.8 : 1);
        cx.drawImage(img as any, x - w / 2, y - h / 2, w, h);
    }
    /** TConsoleStr::perform: GO!'s fading copies where the letters were */
    private drawGoTrails(cx: CanvasRenderingContext2D, base: M, str: ConsoleStr) {
        const P = this.painter!;
        for (let i = 0; i < 3; i++) {
            const p = str.go[i].pane;
            if (!p.visible) continue;
            let a = p.alpha;
            const w = p.width, h = p.height;
            for (const j of [4, 10, 20]) {
                const pt = str.trail[i][j];
                if (!pt || pt.x === 0) continue;
                a = Math.trunc(0.7 * a);
                const ww = w - j * 3, hh = h - j * 3;
                if (ww <= 0 || hh <= 0) continue;
                P.picture(cx, p, mul(base, Painter.local(p, pt.x, pt.y)), a, { x1: 0, y1: 0, x2: ww, y2: hh });
            }
        }
    }
    /** TGCConsole2::drawWater: the two water layers (each masked by its shape moved up as the tank empties), the surface, the label and the nozzle */
    private drawWater(cx: CanvasRenderingContext2D, base: M, con: Console) {
        const P = this.painter!;
        const ratio = con.unk2B8, top0 = con.wT0.pane.global.y1;
        const HEIGHT = [0.161, 0.13], TOP = [7, 10], COLOR = [[0x64, 0xDC, 0xFF], [0x00, 0xB4, 0xF0]];
        cx.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]);
        for (let layer = 2; layer > 0; layer--) {
            const tp = con.wT[layer], tm = con.wM[layer];
            const t = tp.tex ? this.texture(tp.tex) : null, m = tm.tex ? this.texture(tm.tex) : null;
            if (!t || !m) continue;
            const shift = ratio * (1 - HEIGHT[layer - 1]);
            const img = this.waterLayer(t, m, shift, COLOR[layer - 1]);
            const r = con.wLayer[layer], top = top0 + TOP[layer - 1];
            cx.globalAlpha = 1;
            cx.drawImage(img, r.x1, top, r.x2 - r.x1, tp.height);
        }
        const draw = (p: Pane, x: number, y: number) => {
            const t = p.tex ? this.texture(p.tex) : null;
            if (!t || !p.visible) return;
            P.picture(cx, p, mul(base, Painter.local(p, x, y)), p.alpha, { x1: 0, y1: 0, x2: t.w, y2: t.h });
        };
        const surf = con.wT[0];
        let y = top0 + Math.trunc(47 * (1 - ratio) - 0.5) + 1;
        if (y < 0) y = 0;
        draw(surf, surf.bounds.x1, y);
        draw(con.wText.pane, con.wText.pane.bounds.x1, con.wText.pane.bounds.y1);
        const nz = con.nozzle.pane;
        draw(nz, nz.bounds.x1, nz.bounds.y1);
        draw(con.xb, nz.bounds.x1 + con.xb.bounds.x1, nz.bounds.y1 + con.xb.bounds.y1);
    }
    private wl = new Map<string, any>();
    private waterLayer(t: Tex, m: Tex, shift: number, color: number[]) {
        const key = `${t.w}x${t.h}|${Math.round(shift * 1000)}|${color}`;
        let c = this.wl.get(key);
        if (c) return c;
        if (this.wl.size > 64) this.wl.clear();
        c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(t.w, t.h) : Object.assign(document.createElement('canvas'), { width: t.w, height: t.h });
        const cx = c.getContext('2d'), img = cx.createImageData(t.w, t.h), d = img.data;
        for (let y = 0; y < t.h; y++) {
            // the mask's texel row at v + shift (clamped to its edge)
            const my = Math.min(m.h - 1, Math.max(0, Math.floor(((y + 0.5) / t.h + shift) * m.h)));
            for (let x = 0; x < t.w; x++) {
                const mx = Math.min(m.w - 1, Math.floor(((x + 0.5) / t.w) * m.w));
                const ma = m.alpha ? m.rgba[(my * m.w + mx) * 4 + 3] : 255, ta = t.alpha ? t.rgba[(y * t.w + x) * 4 + 3] : 255;
                const i = (y * t.w + x) * 4;
                d[i] = color[0]; d[i + 1] = color[1]; d[i + 2] = color[2]; d[i + 3] = ((255 - ma) * ta) / 255;
            }
        }
        cx.putImageData(img, 0, 0);
        this.wl.set(key, c);
        return c;
    }
}
void I;
(globalThis as any).GameHud = GameHud;
