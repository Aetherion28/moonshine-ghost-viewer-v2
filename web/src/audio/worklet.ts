// The audio worklet: the game's sound system (system.ts) rendering into the page's audio output.
// Messages from the page: init (the sound files), bgm / stopBgm, se, gain, pause.

import { SoundSystem } from './system.js';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: any): void;
declare class AudioWorkletProcessor { port: MessagePort; constructor(); }

class GameAudioProcessor extends AudioWorkletProcessor {
    sys: SoundSystem | null = null;
    paused = true;
    L = new Float32Array(128); R = new Float32Array(128);
    constructor() {
        super();
        this.port.onmessage = (e: MessageEvent) => {
            const m = e.data;
            try {
                switch (m.type) {
                    case 'init': {
                        const aw = new Map<string, Uint8Array>();
                        for (const [k, v] of Object.entries(m.aw as Record<string, ArrayBuffer>)) aw.set(k, new Uint8Array(v));
                        this.sys = new SoundSystem({ aaf: new Uint8Array(m.aaf), seqArc: m.seqArc ? new Uint8Array(m.seqArc) : null, aw }, sampleRate);
                        this.port.postMessage({ type: 'ready', banks: this.sys.banks.filter(Boolean).length, seqs: this.sys.arc ? this.sys.arc.count : 0, se: !!this.sys.seSeq });
                        break;
                    }
                    case 'bgm': if (this.sys) this.sys.playBgm(m.id, m.seek || 0); break;
                    case 'stopBgm': if (this.sys) this.sys.stopBgm(); break;
                    case 'se': if (this.sys && !this.paused) this.sys.playSe(m.id, m.vol, m.pan, m.pitch); break;
                    case 'gain': if (this.sys) { this.sys.musicGain = m.music; this.sys.sfxGain = m.sfx; } break;
                    case 'pause': this.paused = !!m.on; break;
                }
            } catch (err) { this.port.postMessage({ type: 'error', message: String((err as any) && (err as any).stack || err) }); }
        };
    }
    process(_in: Float32Array[][], out: Float32Array[][]) {
        const o = out[0], n = o[0].length;
        if (!this.sys || this.paused) { for (const ch of o) ch.fill(0); return true; }
        if (this.L.length < n) { this.L = new Float32Array(n); this.R = new Float32Array(n); }
        try { this.sys.render(this.L, this.R, n); } catch (err) { this.port.postMessage({ type: 'error', message: String(err) }); this.paused = true; return true; }
        const l = o[0], r = o[1] || o[0];
        // a soft limit over the mix
        for (let i = 0; i < n; i++) { l[i] = Math.tanh(this.L[i]); if (r !== l) r[i] = Math.tanh(this.R[i]); }
        return true;
    }
}
registerProcessor('game-audio', GameAudioProcessor);
