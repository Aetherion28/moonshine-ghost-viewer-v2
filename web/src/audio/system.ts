// The game's sound system as the viewer runs it (MSound / JAIBasic): the init data's banks and
// wave systems, the sequence archive, a music player (the stage's BGM sequence) and a sound
// effect player (the SE sequence, archive entry 0 as JAIBasic::startSeSequence starts it, played
// through its tracks' ports as JAIBasic::sendPlayingSeCommand does).

import { parseAAF, parseBank, InitData, SeqArchive, SoundTable, WaveSystem, Bank } from './formats.js';
import { Player, Mixer, Track, OuterParam, WaveStore } from './engine.js';

export interface SoundFiles {
    /** mSound.aaf */
    aaf: Uint8Array;
    /** the sequence archive (its file name is in the AAF's header) */
    seqArc: Uint8Array | null;
    /** the wave archives (.aw) by lower-case file name */
    aw: Map<string, Uint8Array>;
}
const UPD_ALL = 0x1F | 0x40;

export class SoundSystem {
    init: InitData;
    banks: (Bank | null)[] = [];
    arc: SeqArchive | null;
    se: SoundTable | null; seq: SoundTable | null;
    music: Player; sfx: Player;
    mixer: Mixer;
    bgm: Track | null = null; bgmId = -1;
    seSeq: Track | null = null;
    private slots = new Map<number, number>();
    /** held sounds (ID & 0xC00 clear: JAIBasic keeps them only while the game asks every frame): key -> slot track */
    private held = new Map<string, { tid: number; id: number }>();
    musicGain = 1; sfxGain = 1;
    constructor(public files: SoundFiles, rate: number) {
        this.init = parseAAF(files.aaf);
        const bankByVirtual = new Map<number, number>();
        this.init.banks.forEach((b, i) => {
            try { const bank = parseBank(b.data); this.banks[i] = bank; if (bank.virtualId !== 0xFFFF && !bankByVirtual.has(bank.virtualId)) bankByVirtual.set(bank.virtualId, i); }
            catch { this.banks[i] = null; }
        });
        const systems = this.init.waveBanks.map((w) => { try { return new WaveSystem(w.data); } catch { return { waves: new Map(), awFiles: [] } as any; } });
        const data = { banks: this.banks, bankByVirtual, waveBankOf: this.init.banks.map((b) => b.waveBank), waves: new WaveStore(systems, files.aw) };
        this.music = new Player(data); this.sfx = new Player(data);
        this.arc = this.init.seqArcHeader ? new SeqArchive(this.init.seqArcHeader) : null;
        this.se = this.init.seTable ? new SoundTable(this.init.seTable) : null;
        this.seq = this.init.separateTables && this.init.seqTable ? new SoundTable(this.init.seqTable) : this.se;
        this.mixer = new Mixer([{ player: this.music, gain: 1 }, { player: this.sfx, gain: 1 }], rate);
        this.startSe();
    }
    /** a sequence's data from the archive (sound ID & 0x3FF) */
    seqData(index: number): Uint8Array | null {
        const e = this.arc && this.arc.entry(index);
        if (!e || !this.files.seqArc) return null;
        return this.files.seqArc.subarray(e.offset, e.offset + e.size);
    }
    private outer() { const o = new OuterParam(); o.switch_ = UPD_ALL; return o; }
    private startSe() {
        const d = this.seqData(0x800 & 0x3FF);
        if (d) this.seSeq = this.sfx.start(d, this.outer());
    }
    /** MSBgm::startBGM: the stage's music; seek: seconds already played */
    playBgm(id: number, seek = 0) {
        this.stopBgm();
        if (id < 0 || ((id & 0xC0000000) >>> 0) !== 0x80000000) return;
        const d = this.seqData(id & 0x3FF);
        if (!d) return;
        this.bgm = this.music.start(d, this.outer());
        this.bgmId = id;
        const subs = Math.floor(seek * (32028.5 / 80));
        for (let i = 0; i < subs && this.bgm.seqState; i++) Mixer.skip(this.music);
    }
    stopBgm() {
        if (this.bgm) this.music.stop(this.bgm);
        this.bgm = null; this.bgmId = -1;
        for (const c of this.music.channels) c.alive = false;
        this.music.channels = [];
    }
    /**
     * startSoundActor: an SE on its category's next track (vol 0..1, pan 0..1). hold: the key of a
     * held sound (asked for again each frame: its volume and pan follow; it starts once).
     */
    playSe(id: number, vol = 1, pan = 0.5, pitch = 1, hold?: string): number {
        const t = this.seSeq, tbl = this.se;
        if (!t || !t.seqState || !tbl) return -1;
        if (hold !== undefined) {
            const h = this.held.get(hold);
            if (h && h.id === id) {
                const slot = t.routeTrack(route(h.tid));
                if (slot && slot.outer && t.readPortApp(route(h.tid) + 0x20000) !== 0) { this.setOuter(slot.outer, id, vol, pan, pitch); return h.tid; }
            }
            if (h) this.releaseSe(hold);
        }
        const info = tbl.info(id);
        if (!info) return -1;
        const cat = (id >>> 12) & 0xFF;
        if (cat >= tbl.categoryMax) return -1;
        const scene = this.init.soundScenes ? this.init.soundScenes[0] : null;
        const max = (c: number) => (scene ? scene[c].maxPlaying : 4);
        let base = 0;
        for (let c = 0; c < cat; c++) base += max(c);
        const n = max(cat);
        if (!n) return -1;
        // a free track (its port 2 reads 0) of the category, else the next in turn
        let j = (this.slots.get(cat) || 0) % n;
        for (let k = 0; k < n; k++) {
            const tid = base + ((j + k) % n), r = route(tid);
            if (t.readPortApp(r + 0x20000) === 0) { j = (j + k) % n; break; }
        }
        this.slots.set(cat, j + 1);
        const tid = base + j, r = route(tid);
        const slot = t.routeTrack(r);
        if (!slot) return -1;
        // the slot's last sound, if held, is over
        for (const [k, h] of this.held) if (h.tid === tid) this.held.delete(k);
        if (hold !== undefined) this.held.set(hold, { tid, id });
        const o = slot.outer || (slot.outer = new OuterParam());
        this.setOuter(o, id, vol, pan, pitch);
        t.writePortApp(r + 0x30000, 0);
        t.writePortApp(r + 0x60000, 0);
        t.writePortApp(r + 0x40000, id & 0x3FF);
        t.writePortApp(r, 1);
        return tid;
    }
    /** Mario's voice (MSound::unk8C[0]): its SE track and ID while it plays */
    private voice: { tid: number; id: number } | null = null;
    /** is Mario's last voice still playing (MSound::checkMarioVoicePlaying) */
    voicePlaying(): boolean {
        const v = this.voice, t = this.seSeq;
        if (!v || !t) return false;
        if (t.readPortApp(route(v.tid) + 0x20000) === 0) { this.voice = null; return false; }
        return true;
    }
    /**
     * MSound::startMarioVoice's play: the voice on Mario's one voice handle. A playing voice is
     * stopped for the new one unless it has the higher priority (JAIEntry::checkSoundHandle);
     * ifQuiet: the reaction voices, which don't start over a playing voice.
     */
    playVoice(id: number, vol = 1, pan = 0.5, ifQuiet = false, unlessId = -1) {
        const tbl = this.se, t = this.seSeq;
        if (!tbl || !t) return;
        const info = tbl.info(id);
        if (!info) return;
        // (getMarioVoiceID(0) != unlessId: not said over that same line)
        if (unlessId >= 0 && this.voicePlaying() && this.voice!.id === unlessId) return;
        if (this.voicePlaying()) {
            if (ifQuiet) return;
            const old = tbl.info(this.voice!.id);
            if (old && old.priority > info.priority) return;
            t.writePortApp(route(this.voice!.tid), 0);
            this.voice = null;
        }
        const tid = this.playSe(id, vol, pan, 1);
        if (tid >= 0) this.voice = { tid, id };
    }
    stopVoice() { if (this.voicePlaying() && this.seSeq) this.seSeq.writePortApp(route(this.voice!.tid), 0); this.voice = null; }
    private setOuter(o: OuterParam, id: number, vol: number, pan: number, pitch: number) {
        const tbl = this.se!, info = tbl.info(id), fmt = tbl.data[3];
        o.switch_ = 0x1F;
        o.volume = vol * (info && fmt & 4 ? info.volume / 127 : 1);
        o.pitch = pitch * (info && fmt & 2 ? info.pitch : 1);
        o.pan = pan; o.update = 0xFFFF;
    }
    /** JAIBasic::releaseSeRegist: a held sound no longer asked for (its track's port 0 to 0: the SE sequence stops it) */
    releaseSe(hold: string) {
        const h = this.held.get(hold);
        if (!h) return;
        this.held.delete(hold);
        if (this.seSeq) this.seSeq.writePortApp(route(h.tid), 0);
    }
    render(L: Float32Array, R: Float32Array, n: number) {
        this.mixer.players[0].gain = this.musicGain; this.mixer.players[1].gain = this.sfxGain;
        L.fill(0, 0, n); R.fill(0, 0, n);
        this.mixer.render(L, R, n);
    }
}
/** the SE track for a track number (sendPlayingSeCommand's port address) */
const route = (tid: number) => (0x20000000 + ((tid & 0xF) << 4) + ((tid >> 4) & 0xF)) >>> 0;

// ---------------------------------------------------------------- the stage's music (MSMainProc::setMSoundEnterStage)
/**
 * The BGM for a stage (area, episode): MSoundMainSide.cpp's table. (The decomp's BGM enum names
 * are guesses; the IDs are the game's.) -1: none.
 */
export function stageBgm(area: number, ep: number): number {
    const M = (n: number) => (0x80010000 | n) >>> 0;
    switch (area) {
        case 0: return M(0x1A);
        case 1: return M(0x01);
        case 2: return M(0x02);
        case 3: return M(0x09);
        case 4: return ep !== 2 ? M(0x03) : M(0x0D);
        case 5: return M(0x04);
        case 6: return M(0x08);
        case 7: return M(0x13);
        case 8: return ep === 5 ? M(0x22) : M(0x07);
        case 9: return M(0x14);
        case 13: return M(0x05);
        case 14: return M(0x1E);
        case 15: return M(0x10);
        case 16: return M(0x06);
        case 20: return M(0x01);
        case 21: case 22: case 23: case 24: return M(0x21);
        case 28: case 30: case 31: case 32: return M(0x12);
        case 29: case 33: return M(0x21);
        case 34: case 35: case 40: case 41: case 42: case 43: return M(0x12);
        case 44: return M(0x21);
        case 45: case 46: case 47: case 48: case 49: case 50: case 51: return M(0x12);
        case 52: return M(0x15);
        case 55: case 57: return M(0x0D);
        case 58: return ep === 0 ? M(0x1F) : M(0x19);
        case 59: return M(0x09);
        case 60: return M(0x2E);
    }
    return -1;
}
