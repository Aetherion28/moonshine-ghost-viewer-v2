// The viewer's game audio: the stage's music and the sound effects, played from the user's disc
// by the game's own sound data through an audio worklet (worklet.ts → audio-worklet.js). The page
// calls frame() every frame with what's on screen (the time, the ghost's stage, the camera, Mario,
// the simulated stage's sound events); Music and Sound effects can each be turned off.
//
// Sound effects: the game code's startSoundActor calls (world.sound in the sim: kind 'sound'
// events) and Mario's animation sounds (/mario/bas/ma_<anim>.bas, JAIAnimeSound), heard from the
// camera as JAudio places them (louder within 1000, gone at 5000, panned across the view).

import * as RARC from '../../noclip/Common/JSYSTEM/JKRArchive.js';
import * as Yaz0 from '../../noclip/Common/Compression/Yaz0.js';
import ArrayBufferSlice from '../../noclip/ArrayBufferSlice.js';
import { parseAAF, WaveSystem, SeqArchive } from './formats.js';
import { stageBgm } from './system.js';
import { ANIME_DATA, ANIME_FILES } from '../game/player/tables.js';

interface GameFS { has(p: string): boolean; read(p: string): Promise<ArrayBuffer>; list(): string[]; }
export interface AudioFrame {
    playing: boolean; speed: number; t: number;
    /** the ghost's route here and the QF its stage started at */
    area: number; episode: number; segStart: number; segKey: string;
    /** the camera: its position and its view matrix (world → camera, column-major 4x4) */
    camPos: [number, number, number] | null; view: ArrayLike<number> | null;
    /** the leading ghost's Mario */
    mario: { x: number; y: number; z: number; anim: number; phase: number } | null;
    /** the simulated stage's events (world.events) and an identity for the stage */
    events: { t?: number; kind: string; data: any }[] | null; eventsKey: object | null;
    /** the simulated stage's tick now (events older than a few ticks are a catch-up's: silent) */
    tick?: number;
}
interface BasEntry { id: number; start: number; end: number; pitch: number; volume: number; }

const store = { get(k: string, d: boolean) { try { const v = localStorage.getItem('ghostViewer.' + k); return v === null ? d : v === '1'; } catch { return d; } },
    set(k: string, v: boolean) { try { localStorage.setItem('ghostViewer.' + k, v ? '1' : '0'); } catch { /* storage unavailable */ } } };

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

export class GameAudio {
    music = store.get('audioMusic', true);
    sfx = store.get('audioSfx', true);
    status = '';
    onStatus: ((s: string) => void) | null = null;
    private fs: GameFS | null = null;
    private ctx: AudioContext | null = null;
    private node: AudioWorkletNode | null = null;
    private loading: Promise<void> | null = null;
    private ready = false;
    private gestured = false;
    private bgmKey = ''; private bgmStartedAt = 0; private bgmSeek = 0; private bgmRunning = false;
    private lastT = -1; private lastMove = 0; private paused = true;
    private evKey: object | null = null; private evDone = 0;
    private bas: (BasEntry[] | null)[] = []; private bckFrames: number[] = [];
    private marioPrev: { anim: number; frame: number } | null = null;
    constructor(public base = '') { }
    setDisc(fs: GameFS) { this.fs = fs; this.ready = false; this.loading = null; this.bgmKey = ''; if (this.node) { this.node.disconnect(); this.node = null; } if (this.gestured) this.gesture(); }
    setMusic(on: boolean) { this.music = on; store.set('audioMusic', on); this.sendGain(); this.gesture(); }
    setSfx(on: boolean) { this.sfx = on; store.set('audioSfx', on); this.sendGain(); this.gesture(); }
    private say(s: string) { this.status = s; if (this.onStatus) this.onStatus(s); }
    /** a user gesture: browsers let audio start only from one */
    gesture() {
        this.gestured = true;
        if (!this.music && !this.sfx) return;
        if (!this.ctx && this.fs) {
            // made inside the gesture, so the browser lets it run
            try { const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext; this.ctx = new AC(); }
            catch (e) { this.say('Sound: this browser has no Web Audio'); return; }
        }
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => { });
        if (this.fs && !this.loading) this.loading = this.load().catch((e) => { console.warn('[audio]', e); this.say('Sound: ' + (e && e.message ? e.message : e)); });
    }
    private find(name: string): string | null {
        const fs = this.fs!, want = name.toLowerCase().replace(/^\//, '');
        if (fs.has(want)) return want;
        for (const p of fs.list()) if (p.toLowerCase() === want) return p;
        return null;
    }
    private async load() {
        const fs = this.fs!;
        this.say('Loading the game\'s sound…');
        // mSound.aaf: in /data/nintendo.arc (TApplication::initialize_bootAfter: its /audi folder)
        const narc = this.find('data/nintendo.szs') || this.find('data/nintendo.arc');
        let aaf: Uint8Array | null = null;
        if (narc) {
            const files = archive(await fs.read(narc));
            for (const [k, v] of files) if (k.endsWith('msound.aaf')) { aaf = v; break; }
        }
        if (!aaf) { const p = this.find('AudioRes/mSound.aaf'); if (p) aaf = new Uint8Array(await fs.read(p)); }
        if (!aaf) throw new Error('this disc has no sound data (data/nintendo.szs, AudioRes/)');
        const init = parseAAF(aaf);
        let seqArc: ArrayBuffer | null = null;
        if (init.seqArcHeader) {
            const name = new SeqArchive(init.seqArcHeader).fileName;
            const p = this.find('AudioRes/Seqs/' + name);
            if (p) seqArc = await fs.read(p);
        }
        const aw: Record<string, ArrayBuffer> = {};
        const names = new Set<string>();
        for (const w of init.waveBanks) { try { for (const n of new WaveSystem(w.data).awFiles) names.add(n); } catch { /* skip */ } }
        for (const n of names) { const p = this.find('AudioRes/Banks/' + n); if (p) aw[n.toLowerCase()] = await fs.read(p); }
        // Mario's animation sounds
        const mp = this.find('data/mario.szs') || this.find('data/mario.arc');
        if (mp) {
            const mf = archive(await fs.read(mp));
            ANIME_FILES.forEach((n, i) => {
                const b = mf.get(('bas/ma_' + n + '.bas').toLowerCase()) || mf.get(('mario/bas/ma_' + n + '.bas').toLowerCase());
                this.bas[i] = b ? parseBas(b) : null;
                const k = mf.get(('bck/ma_' + n + '.bck').toLowerCase()) || mf.get(('mario/bck/ma_' + n + '.bck').toLowerCase());
                this.bckFrames[i] = k ? bckFrames(k) : 0;
            });
        }
        // the worklet
        if (!this.ctx) { const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext; this.ctx = new AC(); }
        if (!this.ctx.audioWorklet) throw new Error('this browser can\'t run the sound player (no AudioWorklet)');
        await this.ctx.audioWorklet.addModule(this.base + 'audio-worklet.js');
        this.node = new AudioWorkletNode(this.ctx, 'game-audio', { outputChannelCount: [2] });
        this.node.connect(this.ctx.destination);
        const ready = new Promise<any>((res, rej) => {
            this.node!.port.onmessage = (e) => {
                if (e.data.type === 'ready') res(e.data);
                else if (e.data.type === 'error') { console.warn('[audio worklet]', e.data.message); rej(new Error(e.data.message)); }
            };
        });
        const transfer = [aaf.slice().buffer, ...(seqArc ? [seqArc] : []), ...Object.values(aw)];
        this.node.port.postMessage({ type: 'init', aaf: transfer[0], seqArc, aw }, transfer as Transferable[]);
        const info = await ready;
        this.node.port.onmessage = (e) => { if (e.data.type === 'error') console.warn('[audio worklet]', e.data.message); };
        this.ready = true;
        this.sendGain();
        if (this.ctx.state === 'suspended' && this.gestured) this.ctx.resume().catch(() => { });
        this.say(info.seqs ? '' : 'Sound: no sequences found');
    }
    private sendGain() { if (this.node) this.node.port.postMessage({ type: 'gain', music: this.music ? 1 : 0, sfx: this.sfx ? 1 : 0 }); }
    private post(m: any) { if (this.node && this.ready) this.node.port.postMessage(m); }

    /** Every viewer frame. */
    frame(f: AudioFrame) {
        if (!this.ready || !this.node) return;
        const now = performance.now() / 1000;
        const scrubbing = Math.abs(f.t - this.lastT) > 0 && !f.playing;
        if (f.t !== this.lastT) this.lastMove = now;
        // sound plays only at 1x while playing
        const audible = f.playing && Math.abs(f.speed - 1) < 1e-3;
        if (audible === this.paused) { this.paused = !audible; this.post({ type: 'pause', on: this.paused }); if (!this.paused) this.bgmRunning = false; }
        // the stage's music: started from the stage's start, re-synced when the time jumps
        const id = this.music ? stageBgm(f.area, f.episode) : -1;
        const key = f.segKey + '|' + id;
        const musicT = Math.max(0, (f.t - f.segStart) / (120000 / 1001));
        if (key !== this.bgmKey) {
            this.bgmKey = key; this.bgmRunning = false;
            if (id < 0) this.post({ type: 'stopBgm' });
        }
        if (id >= 0 && audible) {
            const expect = this.bgmSeek + (now - this.bgmStartedAt);
            if (!this.bgmRunning || Math.abs(expect - musicT) > 0.35) {
                this.post({ type: 'bgm', id, seek: musicT });
                this.bgmRunning = true; this.bgmSeek = musicT; this.bgmStartedAt = now;
            }
        }
        // sound effects
        if (f.eventsKey !== this.evKey) { this.evKey = f.eventsKey; this.evDone = f.events ? f.events.length : 0; }
        if (f.events) {
            if (f.events.length < this.evDone) this.evDone = 0;
            if (audible && this.sfx) for (let i = this.evDone; i < f.events.length; i++) {
                const e = f.events[i];
                if (e.kind !== 'sound') continue;
                if (f.tick !== undefined && e.t !== undefined && e.t < f.tick - 3) continue;
                this.playAt(e.data.id, e.data.p, f);
            }
            this.evDone = f.events.length;
        }
        if (f.mario && this.sfx) this.marioSounds(f, audible && !scrubbing);
        this.lastT = f.t;
    }
    /** an SE heard from the camera (JAISound distance volume and pan, simplified) */
    private playAt(id: number, p: { x: number; y: number; z: number } | null, f: AudioFrame, vol = 1, pitch = 1) {
        if (id & 0xC00) return;   // looping sounds: they need the game to stop them
        let pan = 0.5;
        if (p && f.camPos && f.view) {
            const V = f.view;
            const x = V[0] * p.x + V[4] * p.y + V[8] * p.z + V[12], y = V[1] * p.x + V[5] * p.y + V[9] * p.z + V[13], z = V[2] * p.x + V[6] * p.y + V[10] * p.z + V[14];
            const d = Math.hypot(x, y, z);
            // JAIGlobalParameter: full volume within maxVolumeDistance (1000), none past distanceMax (5000)
            vol *= d <= 1000 ? 1 : d >= 5000 ? 0 : 1 - (d - 1000) / 4000;
            if (vol <= 0) return;
            // panDistanceMax (500): sideways over the distance
            pan = 0.5 + 0.5 * Math.max(-1, Math.min(1, x / Math.max(500, d)));
        }
        this.post({ type: 'se', id, vol, pan, pitch });
    }
    /** JAIAnimeSound::setAnimSoundActor for the ghost's Mario: the animation's sounds as its frame passes them */
    private marioSounds(f: AudioFrame, on: boolean) {
        const m = f.mario!;
        const row = ANIME_DATA[m.anim];
        const bck = row ? row[0] : -1;
        const frames = bck >= 0 ? this.bckFrames[bck] || 0 : 0;
        const frame = m.phase * frames;
        const prev = this.marioPrev;
        this.marioPrev = { anim: m.anim, frame };
        if (!on || bck < 0) return;
        const list = this.bas[bck];
        if (!list) return;
        const P = { x: m.x, y: m.y, z: m.z };
        const fire = (lo: number, hi: number) => { for (const e of list) if (e.start > lo && e.start <= hi) this.playAt(e.id, P, f, e.volume, e.pitch); };
        if (!prev || prev.anim !== m.anim) fire(-1, frame);
        else if (frame < prev.frame) { fire(prev.frame, Infinity); fire(-1, frame); }
        else fire(prev.frame, frame);
    }
}

/** a .bas: JAIAnimeSoundData (u16 count, then 0x20-byte JAIAnimeFrameSoundData entries) */
function parseBas(b: Uint8Array): BasEntry[] {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength), n = v.getUint16(0), out: BasEntry[] = [];
    for (let i = 0; i < n && 8 + i * 0x20 + 0x20 <= b.length; i++) {
        const o = 8 + i * 0x20;
        const vol = b[o + 0x14];
        out.push({ id: v.getUint32(o), start: v.getFloat32(o + 4), end: v.getFloat32(o + 8), pitch: v.getFloat32(o + 0xC) || 1, volume: vol ? vol / 127 : 1 });
    }
    return out;
}
/** a BCK's length in frames (ANK1's duration) */
function bckFrames(b: Uint8Array) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return b.length > 0x2C ? v.getUint16(0x20 + 0xA) : 0;
}

(window as any).GameAudio = GameAudio;
