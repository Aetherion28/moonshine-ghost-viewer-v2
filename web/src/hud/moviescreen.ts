// TMovieDirector (System/MovieDirector.cpp) in live play: the streaming movie getStreamMovieName
// names, played from the player's disc (movie/player.ts), with TMovieSubTitle's subtitles
// (subtitle.szs: /subtitle/<movie>.bmg, each message's INF1 entry its first and last frame, on
// demo_1.blo for the tall movies 9 and 20, else demo_2.blo, me_a / me_b), the fader's 1 s fade in
// and out, the skip (Start / A / B, once the movie has been watched: MSF_FMV_WATCHED_BASE + id) and
// decideNextMode's chain (2 -> 18, 3 -> 19 -> 13, 14 -> 15 -> 16 / 17; the card saves between are
// left out). A game frame at a time with the pad, like the other menus; the picture follows the
// movie's own clock.

import { Pane, Screen } from './blo.js';
import { Painter, M } from './draw.js';
import { ThpPlayer, MovieFS } from '../movie/player.js';
import { MenuPad } from './menus.js';
import { MEANING, PadStatus } from '../game/player/pad.js';
import { sjisDecode } from './gx.js';

/** TMessageLoader's view of a BMG: INF1's entries (offset, first and last frame) and DAT1 */
class MessageLoader {
    entries: { off: number; unk4: number; unk6: number }[] = []; data: Uint8Array | null = null;
    constructor(b: Uint8Array | null) {
        if (!b || b.length < 0x20) return;
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        let p = 0x20;
        for (let i = 0; i < dv.getUint32(12) && p + 8 <= b.length; i++) {
            const tag = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]), size = dv.getUint32(p + 4);
            if (tag === 'INF1') { const n = dv.getUint16(p + 8), es = dv.getUint16(p + 10) || 12; for (let k = 0; k < n; k++) { const e = p + 16 + k * es; this.entries.push({ off: dv.getUint32(e), unk4: dv.getInt16(e + 4), unk6: dv.getInt16(e + 6) }); } }
            else if (tag === 'DAT1') this.data = b.subarray(p + 8, p + size);
            if (!size) break;
            p += size;
        }
    }
}
export const MOVIES = ['stolenpeach.thp', 'openingA.thp', 'NozuruA.thp', 'openingBA.thp', 'kagemario.thp', 'stolennozuru.thp', 'pakkun.thp', 'MechaKuppa.thp',
    'KuppaJr.thp', 'Entrance.thp', 'demogeso.thp', 'bath.thp', 'autodemoA.thp', 'openingBC.thp', 'epilogue.thp', 'staffroll.thp', 'omakeA.thp', 'omakeB.thp', 'NozuruB.thp', 'openingBB.thp'];
const MSF_FMV_WATCHED_BASE = 0x10391, MSF_SHINE_COUNT = 0x40000;

export interface MovieFlags { getBool(f: number): boolean; setBool(v: boolean, f: number): void; getFlag(f: number): number; getShineFlag?(i: number): boolean; setShineFlag?(i: number): void; }

/** the disc's path of a movie by its file name (anywhere on the disc, any case), else null */
export function findMovie(list: string[], name: string): string | null {
    const n = name.toLowerCase();
    return list.find((p) => p === n || p.endsWith('/' + n)) || null;
}

export class MovieScreen {
    id: number;
    player: ThpPlayer | null = null;
    /** FADE_IN, PLAYING, FADE_OUT, then done: 'next' (the next area), 'title' */
    state: 'in' | 'play' | 'out' | 'done' = 'in';
    result: 'next' | 'title' = 'next';
    note = '';
    private fade = 30;     // frames left of the fade (in or out), a 1 s wipe
    private pad = new MenuPad();
    private sub: { scr: Screen; a: Pane; b: Pane; msgs: MessageLoader; i: number; on: boolean } | null = null;
    constructor(private fs: MovieFS & { list(): string[] }, id: number, private flags: MovieFlags, private subtitles: (name: string, tall: boolean) => { scr: Screen; bmg: Uint8Array | null } | null, private music: () => boolean) {
        this.id = id;
        this.open();
    }
    private open() {
        const name = MOVIES[this.id] || 'EX128x144_q0.thp';
        let path = findMovie(this.fs.list(), name);
        if (!path) path = findMovie(this.fs.list(), 'EX128x144_q0.thp');
        if (!path) { this.note = `the movie ${name} isn't on the disc`; this.player = null; this.state = 'done'; this.decide(); return; }
        this.player = new ThpPlayer(this.fs, path, { audio: this.music() });
        void this.player.open();
        this.state = 'in'; this.fade = 30;
        this.sub = null;
        const s = this.subtitles(name, this.id === 9 || this.id === 20);
        if (s) {
            try {
                const a = s.scr.find('me_a'), b = s.scr.find('me_b');
                this.sub = { scr: s.scr, a, b, msgs: new MessageLoader(s.bmg), i: 0, on: false };
                s.scr.hide();
            } catch { this.sub = null; }
        }
    }
    private watched() { return this.flags.getBool(MSF_FMV_WATCHED_BASE + this.id); }
    /** decideNextMode: the watched flag, the next movie of the chain or the end */
    private decide() {
        const id = this.id;
        if (id !== 14 && id !== 15 && id !== 16 && id !== 17) this.flags.setBool(true, MSF_FMV_WATCHED_BASE + id);
        let next = -1;
        if (id === 2) next = 18;
        else if (id === 3) next = 19;
        else if (id === 19) next = 13;
        else if (id === 14) { if (this.flags.setShineFlag && this.flags.getShineFlag && !this.flags.getShineFlag(0x77)) this.flags.setShineFlag(0x77); next = 15; }
        else if (id === 15) next = this.flags.getFlag(MSF_SHINE_COUNT) < 120 ? 16 : 17;
        else if (id === 12 || id === 16 || id === 17) this.result = 'title';
        if (this.player) this.player.stop();
        if (next >= 0) { this.id = next; this.open(); return; }
        this.state = 'done';
    }
    frame(p: PadStatus | null) {
        if (this.state === 'done') return;
        this.pad.tick(p, true);
        const P = this.player;
        const skip = this.watched() && this.pad.frame(MEANING.START | MEANING.MENU_A | MEANING.MENU_B);
        if (this.state === 'in') {
            if (skip) { this.state = 'out'; this.fade = 30; if (P) P.setVolume(0, 1); }
            else if (P && P.state !== 'loading' && --this.fade <= 0) this.state = 'play';
        } else if (this.state === 'play') {
            if (skip) { this.state = 'out'; this.fade = 30; if (P) P.setVolume(0, 1); }
            else if (!P || P.state === 'ended') { if (P && P.error) this.note = 'movie: ' + P.error; this.decide(); }
        } else if (this.state === 'out') { if (--this.fade <= 0) this.decide(); }
        // TMovieSubTitle::movement
        const S = this.sub;
        if (S && P) {
            const f = P.frameNumber(), e = S.i < S.msgs.entries.length ? S.msgs.entries[S.i] : null;
            if (S.on) { if (e && e.unk6 <= f) { S.on = false; S.scr.hide(); S.i++; } }
            else if (e && e.unk4 <= f) {
                S.on = true; S.scr.show();
                const d = S.msgs.data, out: number[] = [];
                if (d) for (let k = e.off; k < d.length && d[k]; k++) { if (d[k] === 0x1A) { k += d[k + 1] - 1; continue; } out.push(d[k]); }
                S.a.text = S.b.text = sjisDecode(new Uint8Array(out));
            }
        }
    }
    get done() { return this.state === 'done'; }
    stop() { if (this.player) this.player.stop(); this.state = 'done'; }
    /** the picture, the subtitles and the fade, over the whole view (W x H device pixels) */
    draw(cx: CanvasRenderingContext2D, Pn: Painter, W: number, H: number, base: M) {
        cx.setTransform(1, 0, 0, 1, 0, 0);
        cx.globalAlpha = 1; cx.fillStyle = '#000'; cx.fillRect(0, 0, W, H);
        const P = this.player, img = P ? P.picture() : null;
        if (img && P && P.info) {
            // (TTHPRender: the movie centred on the 640 x 448 picture, here scaled to the view's height)
            const sc = Math.min(H / 448, W / 640), w = P.info.width * sc, h = P.info.height * sc;
            cx.imageSmoothingEnabled = true;
            cx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
        }
        if (this.sub && this.sub.on) Pn.drawScreen(cx, this.sub.scr, base);
        const a = this.state === 'in' ? this.fade / 30 : this.state === 'out' ? 1 - this.fade / 30 : this.state === 'done' ? 1 : 0;
        if (a > 0) { cx.setTransform(1, 0, 0, 1, 0, 0); cx.globalAlpha = Math.min(1, a); cx.fillStyle = '#000'; cx.fillRect(0, 0, W, H); }
    }
}
