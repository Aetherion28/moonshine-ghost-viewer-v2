// A THP movie played in the browser from the player's disc (THPPlayer's job): the frames read one
// after another (each frame's header gives the next one's size), each JPEG decoded by the browser
// (createImageBitmap) a little ahead of when it shows, the audio decoded (THPAudioDecode) and queued
// on a Web Audio clock that the pictures follow; without audio (or before the page may play
// sound) the pictures follow the frame rate on the page's clock.

import { parseThpHeader, splitThpFrame, thpJpeg, thpAudioDecode, ThpInfo } from './thp.js';

export interface MovieFS { read(p: string): Promise<ArrayBuffer>; readRange?(p: string, off: number, len: number): Promise<ArrayBuffer>; size?(p: string): number; }

const AHEAD = 24;        // frames decoded ahead of the one showing
const START_LEAD = 0.15; // seconds between the first frames being ready and the clock starting

export class ThpPlayer {
    info: ThpInfo | null = null;
    error = '';
    /** 'loading' (reading the first frames), 'playing', 'ended' (past the last frame: THPPlayerGetState 3), 'stopped' */
    state: 'loading' | 'playing' | 'ended' | 'stopped' = 'loading';
    private frames: (ImageBitmap | null | Promise<void>)[] = [];
    private shown: ImageBitmap | null = null;
    private released = 0;
    private readNext = 0;
    private nextOff = 0; private nextSize = 0;
    private reading = false;
    private ctx: AudioContext | null = null;
    private gain: GainNode | null = null;
    private audioAt = 0;
    private t0 = -1;     // the clock's start (ctx.currentTime, or performance.now() / 1000)
    private useAudio = false;
    private whole: Uint8Array | null = null;
    private volume = 1;
    constructor(private fs: MovieFS, private path: string, private opts: { audio: boolean; track?: number } = { audio: true }) { }
    async open() {
        try {
            const head = new Uint8Array(await this.range(0, 0x100));
            const info = this.info = parseThpHeader(head);
            if (!info.width || !info.frames) throw new Error('no video in the movie');
            this.nextOff = info.firstFrameOffset; this.nextSize = info.firstFrameSize;
            if (info.audio && this.opts.audio) {
                try {
                    const AC: typeof AudioContext = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
                    this.ctx = new AC();
                    this.gain = this.ctx.createGain(); this.gain.connect(this.ctx.destination); this.gain.gain.value = this.volume;
                    if (this.ctx.state === 'suspended') await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 300))]);
                    this.useAudio = this.ctx.state === 'running';
                    // (the page may not play sound yet: the pictures keep the frame rate, silent)
                    if (!this.useAudio) { void this.ctx.close().catch(() => { }); this.ctx = null; this.gain = null; }
                } catch { this.ctx = null; this.useAudio = false; }
            }
            await this.fill();
            // (the first frames ready: start)
            const first = this.frames[0];
            if (first instanceof Promise) await first;
            this.t0 = this.now() + START_LEAD;
            this.audioAt = this.t0;
            this.scheduleAudio();
            this.state = 'playing';
        } catch (e: any) { this.error = String(e && e.message ? e.message : e); this.state = 'ended'; }
    }
    private now() { return this.useAudio && this.ctx ? this.ctx.currentTime : performance.now() / 1000; }
    private async range(off: number, len: number): Promise<ArrayBuffer> {
        if (this.fs.readRange) return this.fs.readRange(this.path, off, len);
        if (!this.whole) this.whole = new Uint8Array(await this.fs.read(this.path));
        return this.whole.slice(off, off + len).buffer;
    }
    private pendingAudio: { left: Float32Array; right: Float32Array }[] = [];
    /** read and decode frames up to AHEAD past the one showing */
    private async fill() {
        if (this.reading || !this.info) return;
        this.reading = true;
        try {
            const info = this.info, cur = Math.max(0, this.frameNumber());
            while (this.readNext < info.frames && this.readNext < cur + AHEAD && this.state !== 'stopped') {
                const i = this.readNext++;
                const buf = new Uint8Array(await this.range(this.nextOff, this.nextSize));
                const fr = splitThpFrame(info, buf, this.opts.track || 0);
                this.nextOff += this.nextSize; this.nextSize = fr.next;
                if (fr.audio && this.ctx) { try { this.pendingAudio.push(thpAudioDecode(fr.audio)); } catch (e) { console.warn('[movie] audio', e); } }
                if (fr.video) {
                    const jpg = thpJpeg(fr.video);
                    this.frames[i] = createImageBitmap(new Blob([jpg as any], { type: 'image/jpeg' }))
                        .then((b) => { if (i < this.released || this.state === 'stopped') b.close(); else this.frames[i] = b; }, (e) => { this.frames[i] = null; if (!this.error) this.error = 'a frame did not decode: ' + (e && e.message ? e.message : e); });
                } else this.frames[i] = null;
                if (this.state === 'playing') this.scheduleAudio();
                if (!fr.next) { info.frames = Math.min(info.frames, i + 1); break; }
            }
        } catch (e: any) { if (!this.error) this.error = String(e && e.message ? e.message : e); if (this.info) this.info.frames = Math.min(this.info.frames, this.readNext); }
        this.reading = false;
    }
    private scheduleAudio() {
        const ctx = this.ctx, g = this.gain, A = this.info && this.info.audio;
        if (!ctx || !g || !A) { this.pendingAudio.length = 0; return; }
        for (const a of this.pendingAudio) {
            if (!a.left.length) continue;
            const b = ctx.createBuffer(2, a.left.length, A.frequency);
            b.copyToChannel(a.left as any, 0); b.copyToChannel(a.right as any, 1);
            const s = ctx.createBufferSource();
            s.buffer = b; s.connect(g);
            const at = Math.max(this.audioAt, ctx.currentTime);
            if (this.state !== 'stopped') s.start(at);
            this.audioAt = at + a.left.length / A.frequency;
        }
        this.pendingAudio.length = 0;
    }
    /** the frame showing now (TTHPRender::getFrameNumber), -1 before the start */
    frameNumber() {
        if (!this.info || this.t0 < 0) return -1;
        return Math.max(-1, Math.floor((this.now() - this.t0) * this.info.fps));
    }
    /** the picture to draw now (the latest decoded frame at or before the clock's) */
    picture(): ImageBitmap | null {
        if (!this.info) return null;
        const n = this.frameNumber();
        if (this.state === 'playing') {
            if (n >= this.info.frames) this.state = 'ended';
            else void this.fill();
        }
        for (let i = Math.min(n, this.frames.length - 1); i >= 0; i--) {
            const f = this.frames[i];
            if (f && !(f instanceof Promise)) {
                if (f !== this.shown) {
                    // (frames shown are let go)
                    for (let k = this.released; k < i; k++) { const o = this.frames[k]; if (o && !(o instanceof Promise)) { o.close(); this.frames[k] = null; } }
                    this.released = Math.max(this.released, i);
                    this.shown = f;
                }
                return f;
            }
        }
        return this.shown;
    }
    /** THPPlayerSetVolume: 0..1 over seconds */
    setVolume(v: number, seconds = 0) {
        this.volume = v;
        if (this.gain && this.ctx) { const t = this.ctx.currentTime; this.gain.gain.cancelScheduledValues(t); this.gain.gain.setValueAtTime(this.gain.gain.value, t); this.gain.gain.linearRampToValueAtTime(v, t + Math.max(0.001, seconds)); }
    }
    stop() {
        this.state = 'stopped';
        try { if (this.ctx) void this.ctx.close(); } catch { }
        this.ctx = null;
        for (const f of this.frames) if (f && !(f instanceof Promise)) f.close();
        this.frames = [];
    }
}
