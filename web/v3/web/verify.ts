// v3: plays a trace in the game's own code (from the user's disc) and reports how far the game's state matches
// the recording. The driver is tests/replay.ts's: boot, play, boot again with the file table padded when the
// stage heap's size differs, and again with Shiny Shines when the heap is laid out differently.
// Used by the browser's worker (web/worker.ts) and by the Node check of a disc (tests/verify.ts).
import { readTrace, NO_NPC_PHASE, type Trace } from '../game/trace.ts';
import { nextScriptLocks, followsFurther, partedInArithmetic, Replay, type Issue, type LiveSample } from '../game/replay.ts';
export type { LiveSample } from '../game/replay.ts';
import { versionOf, symOf, VERSIONS } from '../game/versions.ts';
import type { OpenedDisc } from './discs.ts';
import type { GxFrame } from './gxframe.ts';

export interface VerifyProgress {
    type: 'progress';
    /** what the machine is doing, in words */
    phase: string;
    /** 1 the first boot, 2 again with the file table padded, 3 again with Shiny Shines */
    attempt: number;
    frames: number; totalFrames: number; ticks: number; totalTicks: number;
    /** millions of instructions so far in this attempt, seconds since the start */
    instructions: number; seconds: number;
}
export interface VerifyReport {
    /** done: the replay ended (the trace's end, or an issue stopped it) */
    result: 'done' | 'cancelled' | 'stalled' | 'error' | 'unsupported';
    /** the whole recording was reproduced with no issue */
    inStep: boolean;
    /** the replay followed the recording (the disc is another version than the recording's): what was put in from it, by kind */
    followed: boolean; taken: Record<string, number>;
    /** the result in plain words */
    summary: string;
    stageName: string; area: number; episode: number;
    frames: number; totalFrames: number; ticks: number; totalTicks: number;
    marioChecked: number; calls: number; literals: number; shimCalls: number; padCorrections: number;
    issues: Issue[];
    /** Moonshine settings on in the recording that v3 doesn't reproduce */
    unsupported: string[];
    shinyShines: boolean; fstPad: number; disc: string;
    /** the recording follows Dolphin's arithmetic (it was made in the emulator, not on a console) */
    dolphin: boolean;
    instructions: number; seconds: number;
    /** the replay's last log lines */
    log: string[];
    error?: string;
}

/** instructions without a new frame or tick after which the replay counts as stuck (about 40 s of game time) */
const STALL = 20e9;

function emptyReport(T: Trace | null, result: VerifyReport['result'], summary: string, t0: number): VerifyReport {
    const w = T ? T.stages[0].words[4] : 0;
    return {
        result, inStep: false, followed: false, taken: {}, summary, stageName: '', area: w >>> 24, episode: (w >>> 16) & 0xFF,
        frames: 0, totalFrames: T ? T.frames.length : 0, ticks: 0, totalTicks: T ? T.ticks.length : 0,
        marioChecked: 0, calls: 0, literals: 0, shimCalls: 0, padCorrections: 0, issues: [], unsupported: [],
        shinyShines: false, dolphin: false, fstPad: 0, disc: '', instructions: 0, seconds: (performance.now() - t0) / 1000, log: [],
    };
}

export interface VerifyHost {
    /** instructions a slice (between two slices the host may take messages) */
    slice: number;
    progress(p: VerifyProgress): void;
    /** asked between slices: stop now? */
    cancelled(): boolean;
    /** a breath between slices (the worker's way to receive a cancel) */
    breathe(): Promise<void>;
    /** what the recording is, once it and the disc are read (a page showing the replay) */
    intro?(i: VerifyIntro): void;
    /** the game's state at each frame of a stage, as the replay goes (`Replay.liveSample`) */
    live?(s: LiveSample, attempt: number): void;
    /** what the game sends its GPU, each video frame of a stage (gxframe.ts). An attempt that boots the game again starts over: its first frame carries the registers. */
    gx?(f: GxFrame): void;
}
export interface VerifyIntro {
    type: 'intro';
    recordingVersion: string; discVersion: string; otherVersion: boolean;
    area: number; episode: number; frames: number; ticks: number; stages: number;
    /** Mario's recorded position at every movement tick (x, y, z each), and the tick each stage of the recording starts at */
    path: Float32Array; stageTicks: number[];
}

/** Plays a trace on the game from `open`'s disc and reports how far the game's state matches the recording. */
export async function verify(traceBuf: ArrayBuffer, open: () => OpenedDisc, host: VerifyHost): Promise<VerifyReport> {
    const slice = host.slice;
    const t0 = performance.now();
    let T: Trace | null = null;
    const finish = (r: VerifyReport) => { r.seconds = (performance.now() - t0) / 1000; return r; };
    const progress = (phase: string, attempt = 1, R: Replay | null = null) => host.progress({
        type: 'progress', phase, attempt, frames: R ? R.frames : 0, totalFrames: T ? T.frames.length : 0, ticks: R ? R.ticks : 0, totalTicks: T ? T.ticks.length : 0,
        instructions: R ? Math.round(R.m.cpu.count / 1e6) : 0, seconds: (performance.now() - t0) / 1000,
    });
    try {
        progress('reading the recording');
        try { T = readTrace(traceBuf); } catch (e) { return finish(emptyReport(null, 'unsupported', `This recording can't be verified: ${(e as Error).message}.`, t0)); }
        const VT = versionOf(T.gameId, T.discRevision);
        if (!VT) return finish(emptyReport(T, 'unsupported', `The recording is from ${T.gameId} revision ${T.discRevision}: that version of the game isn't set up.`, t0));
        progress('reading the disc');
        let D: OpenedDisc;
        try { D = open(); } catch (e) { return finish(emptyReport(T, 'unsupported', `The game's code couldn't be read from the disc: ${(e as Error).message}.`, t0)); }
        // (a folder without its boot.bin has no ID: the DOL's size still tells the version)
        const V = D.gameId ? versionOf(D.gameId, D.revision, D.dol.length) : VERSIONS.find((v) => v.dolSize === D.dol.length);
        if (!V) return finish(emptyReport(T, 'unsupported', `The disc is ${D.gameId || 'not named'} revision ${D.revision} (its program is ${D.dol.length} bytes): that version of the game isn't set up.`, t0));
        // (a disc of another version than the recording's: its code plays the recording, and the recorded state is put in where they part)
        const other = V.key !== VT.key;
        if (host.intro) {
            const path = new Float32Array(T.ticks.length * 3), w0 = T.stages[0].words[4];
            T.ticks.forEach((t, k) => { if (t.mario) { const dv = new DataView(t.mario.buffer, t.mario.byteOffset); path[k * 3] = dv.getFloat32(0x10); path[k * 3 + 1] = dv.getFloat32(0x14); path[k * 3 + 2] = dv.getFloat32(0x18); } else path[k * 3] = NaN; });
            const stageTicks = T.stages.map((s) => T.ticks.findIndex((t) => t.ev > s.ev)).map((k) => k < 0 ? T.ticks.length : k);
            host.intro({ type: 'intro', recordingVersion: VT.name, discVersion: V.name, otherVersion: other, area: w0 >>> 24, episode: (w0 >>> 16) & 0xFF, frames: T.frames.length, ticks: T.ticks.length, stages: T.stages.length, path, stageTicks });
        }

        const log: string[] = [];
        const tried = new Set<string>();
        let dolphin = false, npcPhase: number | undefined, stopOnActors = false;
        const make = (fstPad: number, shinyShines = false, scriptsLocked: string[] = [], whole = false, selectHold = 0) => new Replay(D.dol, D.make(), T!, V.addrs, symOf(V), {
            log: (s) => { log.push(s); if (log.length > 40) log.shift(); }, fstPad, shinyShines, scriptsLocked, selectHold, dolphin, npcPhase, stopOnActors, recorded: VT.addrs, tried: whole ? undefined : tried,
            onFrame: host.live ? () => { const s = R.liveSample(); if (s) host.live!(s, attempt); } : undefined,
            onGxFrame: host.gx ? (f) => host.gx!(f) : undefined,
        });
        let R = make(0), attempt = 1, shiny = false;
        // one attempt: slices of the machine's time, with a breath between them for messages (cancel)
        const go = async (): Promise<'done' | 'cancelled' | 'stalled'> => {
            let mark = -1, markAt = 0;
            for (;;) {
                const r = R.run(slice);
                const seen = R.frames + R.ticks + (R.phase === 'boot' ? 0 : 1);
                if (seen !== mark) { mark = seen; markAt = R.m.cpu.count; }
                progress(R.phase === 'boot' ? 'starting the game' : !R.countAtPlay ? 'loading the stage' : 'playing the recording', attempt, R);
                if (r === 'done') return 'done';
                await host.breathe();
                if (host.cancelled()) return 'cancelled';
                if (R.m.cpu.count - markAt > STALL) return 'stalled';
            }
        };
        let res = await go();
        if (res === 'done' && R.heapDelta) {
            // the arena's top: boot again with the file system table as big as the recording console's
            attempt = 2; R = make(R.fstPadUsed + R.heapDelta); res = await go();
        }
        if (res === 'done' && R.layoutDelta) {
            // the heap's layout: Moonshine's Shiny Shines isn't recorded; see whether it explains the recording's
            attempt = 3; shiny = true; R = make(R.fstPadUsed, true); res = await go();
        }
        if (res === 'done' && partedInArithmetic(R)) {
            // a number differs, not what the game did: the recording may be Dolphin's (one float rule differs from the console's)
            const R1 = R; attempt++; dolphin = true; R = make(R1.fstPadUsed, shiny, R1.scriptsLocked);
            const res2 = await go();
            if (res2 !== 'done') res = res2;
            else if (!followsFurther(R, R1)) { R = R1; dolphin = false; }
        }
        // an event script's lock word is the console's heap garbage: where it decided something before the replay parted, try it the other way
        for (let locks; res === 'done' && (locks = nextScriptLocks(R, tried));) {
            const R1 = R; attempt++; R = make(R1.fstPadUsed, shiny, locks);
            const res2 = await go();
            if (res2 === 'done' && followsFurther(R, R1)) continue;
            if (res2 !== 'done') { res = res2; break; }
            R = R1;
        }
        // (no doubt explains the difference the replay was stopped at: play it whole)
        if (res === 'done' && R.cutShort) { attempt++; R = make(R.fstPadUsed, shiny, R.scriptsLocked, true); res = await go(); }
        // (an older recording doesn't have the NPCs' goop-check counter: where an actor differs, the other 29 values are tried)
        if (res === 'done' && !other && T.stages[0].npcPhase === NO_NPC_PHASE && R.issues.some((i) => i.kind === 'actor')) {
            const R0 = R; stopOnActors = true;
            for (let p = 1; p < 30 && R === R0 && res === 'done'; p++) {
                attempt++; npcPhase = p; const R2 = make(R0.fstPadUsed, shiny, R0.scriptsLocked, true); R = R2;
                const res2 = await go();
                if (res2 !== 'done') { res = res2; break; }
                if (R2.issues.length || R2.frames < T.frames.length) { R = R0; npcPhase = undefined; }
            }
            stopOnActors = false;
        }
        // (the episode select screen between two stages ended early here: its loading took longer on the console)
        for (let n = 0; res === 'done' && R.selectDelta && n < 3; n++) {
            const R1 = R; attempt++; R = make(R1.fstPadUsed, shiny, R1.scriptsLocked, true, R1.selectDelta);
            const res2 = await go();
            if (res2 === 'done' && followsFurther(R, R1)) continue;
            if (res2 !== 'done') { res = res2; break; }
            R = R1; break;
        }
        const w = T.stages[0].words[4], n = R.issues.length, first = n ? R.issues[0] : null;
        const stage = R.stageName || `scene ${w >>> 24},${(w >>> 16) & 0xFF}`;
        const sofar = `${R.frames} of ${T.frames.length} frames (${R.ticks} of ${T.ticks.length} movement ticks)`;
        let summary: string;
        if (res === 'cancelled') summary = `Cancelled after ${sofar} of ${stage}${n ? '' : ', in step so far'}.`;
        else if (res === 'stalled') summary = `The game stopped making progress after ${sofar} of ${stage}.`;
        else if (other) {
            const took = Object.entries(R.taken).filter(([k]) => k !== 'rand').map(([k, c]) => `${{ mario: 'Mario', camera: 'the camera', actor: 'actor words', fludd: 'FLUDD', yoshi: 'Yoshi', seed: 'the RNG seed', water: 'water requests' }[k] || k} ${c}`).join(', ');
            summary = `The disc is ${V.name}, the recording is from ${VT.name}: the disc's code played ${R.frames >= T.frames.length && !n ? `all ${R.frames} frames` : sofar} of ${stage} on the recording's inputs, with the recorded state put in where the two versions part (${took || 'nowhere'}). This shows the recording as it was made; it doesn't check it, which needs a disc of its own version.`;
            if (n) summary += ` It stopped at frame ${first!.frame}: ${first!.text.split('\n')[0]}`;
        }
        else if (!n && R.frames >= T.frames.length) summary = `In step to the end: the game's own code reproduced all ${R.frames} frames and ${R.ticks} movement ticks of ${stage} (${R.calls} random-number calls and ${R.marioChecked} records of Mario bit for bit).`;
        else if (!n) summary = `In step for ${sofar} of ${stage}, where the replay ended${log.length ? ': ' + log[log.length - 1] : ''}.`;
        else summary = `In step for ${sofar} of ${stage}, then the game's code and the recording part (frame ${first!.frame}, tick ${first!.tick}): ${first!.text.split('\n')[0]}`;
        if (R.occlusionTaken || R.occlusionOpen) summary += ` The camera's reads of Mario's occlusion aren't in this recording: ${R.occlusionTaken} were found from what the camera did next${R.occlusionOpen ? `, ${R.occlusionOpen} camera ticks fit neither value` : ''}.`;
        if (R.npcPhaseTaken !== undefined) summary += ` The NPCs' goop-check counter isn't in this recording: it was taken as ${R.npcPhaseTaken}, the one of its 30 values under which nothing differs.`;
        if (R.dolphin) summary += ' The recording follows Dolphin\'s arithmetic, not the console\'s (one multiply rounds differently in the emulator): it was made in Dolphin.';
        if (shiny) summary += ' Shiny Shines was taken as on (the recording doesn\'t say; the heap\'s layout does).';
        const scripts = R.scriptsLocked.filter((k) => k.endsWith('.sb')), others = R.scriptsLocked.length - scripts.length;
        if (scripts.length) summary += ` The event script ${scripts.join(', ')} was taken as starting locked (its lock word is leftover memory the recording doesn't hold; what the script did shows it).`;
        if (others) summary += ` ${others} object${others > 1 ? 's were' : ' was'} taken as starting on leftover memory that wasn't zero (what it did shows it).`;
        if (R.bathDrawn) summary += ` The bath water's height isn't in this recording: it was read from the ${R.bathDrawn} depth maps the GPU model drew.`;
        if (R.unsupported.length) summary += ` Moonshine settings on in this recording that aren't reproduced yet: ${R.unsupported.join(', ')}.`;
        return finish({
            result: res, inStep: res === 'done' && !other && !n && R.frames >= T.frames.length, followed: R.follow, taken: R.taken, summary, stageName: R.stageName, area: w >>> 24, episode: (w >>> 16) & 0xFF,
            frames: R.frames, totalFrames: T.frames.length, ticks: R.ticks, totalTicks: T.ticks.length,
            marioChecked: R.marioChecked, calls: R.calls, literals: R.literals, shimCalls: R.shimCalls, padCorrections: R.padCorrections,
            issues: R.issues, unsupported: R.unsupported, shinyShines: shiny, dolphin: R.dolphin, fstPad: R.fstPadUsed, disc: D.kind,
            instructions: Math.round(R.m.cpu.count / 1e6), seconds: 0, log,
        });
    } catch (e) {
        const r = emptyReport(T, 'error', `The replay stopped on an error: ${(e as Error).message || String(e)}`, t0);
        r.error = String((e as Error).stack || e);
        return finish(r);
    }
}

