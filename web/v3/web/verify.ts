// v3: plays a trace in the game's own code (from the user's disc) and reports how far the game's state matches
// the recording. The driver is tests/replay.ts's: boot, play, boot again with the file table padded when the
// stage heap's size differs, and again with Shiny Shines when the heap is laid out differently.
// Used by the browser's worker (web/worker.ts) and by the Node check of a disc (tests/verify.ts).
import { readTrace, type Trace } from '../game/trace.ts';
import { Replay, JP10, type Issue } from '../game/replay.ts';
import { symJP10 } from '../game/syms_jp10.ts';
import type { OpenedDisc } from './discs.ts';

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
    /** the result in plain words */
    summary: string;
    stageName: string; area: number; episode: number;
    frames: number; totalFrames: number; ticks: number; totalTicks: number;
    marioChecked: number; calls: number; literals: number; shimCalls: number; padCorrections: number;
    issues: Issue[];
    /** Moonshine settings on in the recording that v3 doesn't reproduce */
    unsupported: string[];
    shinyShines: boolean; fstPad: number; disc: string;
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
        result, inStep: false, summary, stageName: '', area: w >>> 24, episode: (w >>> 16) & 0xFF,
        frames: 0, totalFrames: T ? T.frames.length : 0, ticks: 0, totalTicks: T ? T.ticks.length : 0,
        marioChecked: 0, calls: 0, literals: 0, shimCalls: 0, padCorrections: 0, issues: [], unsupported: [],
        shinyShines: false, fstPad: 0, disc: '', instructions: 0, seconds: (performance.now() - t0) / 1000, log: [],
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
        if (T.gameId !== 'GMSJ01' || T.discRevision !== 0) return finish(emptyReport(T, 'unsupported', `The recording is from ${T.gameId} revision ${T.discRevision}: only the Japanese version 1.0 (GMSJ01) is set up so far.`, t0));
        progress('reading the disc');
        let D: OpenedDisc;
        try { D = open(); } catch (e) { return finish(emptyReport(T, 'unsupported', `The game's code couldn't be read from the disc: ${(e as Error).message}.`, t0)); }
        if (D.gameId && (D.gameId !== T.gameId || D.revision !== T.discRevision))
            return finish(emptyReport(T, 'unsupported', `The disc is ${D.gameId} revision ${D.revision}, the recording is from ${T.gameId} revision ${T.discRevision}: the game's code must be the recording's.`, t0));

        const log: string[] = [];
        const make = (fstPad: number, shinyShines = false) => new Replay(D.dol, D.make(), T!, JP10, symJP10, {
            log: (s) => { log.push(s); if (log.length > 40) log.shift(); }, fstPad, shinyShines,
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
            attempt = 2; R = make(R.heapDelta); res = await go();
        }
        if (res === 'done' && R.layoutDelta) {
            // the heap's layout: Moonshine's Shiny Shines isn't recorded; see whether it explains the recording's
            attempt = 3; shiny = true; R = make(R.fstPadUsed, true); res = await go();
        }
        const w = T.stages[0].words[4], n = R.issues.length, first = n ? R.issues[0] : null;
        const stage = R.stageName || `scene ${w >>> 24},${(w >>> 16) & 0xFF}`;
        const sofar = `${R.frames} of ${T.frames.length} frames (${R.ticks} of ${T.ticks.length} movement ticks)`;
        let summary: string;
        if (res === 'cancelled') summary = `Cancelled after ${sofar} of ${stage}${n ? '' : ', in step so far'}.`;
        else if (res === 'stalled') summary = `The game stopped making progress after ${sofar} of ${stage}.`;
        else if (!n && R.frames >= T.frames.length) summary = `In step to the end: the game's own code reproduced all ${R.frames} frames and ${R.ticks} movement ticks of ${stage} (${R.calls} random-number calls and ${R.marioChecked} records of Mario bit for bit).`;
        else if (!n) summary = `In step for ${sofar} of ${stage}, where the replay ended${log.length ? ': ' + log[log.length - 1] : ''}.`;
        else summary = `In step for ${sofar} of ${stage}, then the game's code and the recording part (frame ${first!.frame}, tick ${first!.tick}): ${first!.text.split('\n')[0]}`;
        if (shiny) summary += ' Shiny Shines was taken as on (the recording doesn\'t say; the heap\'s layout does).';
        if (R.unsupported.length) summary += ` Moonshine settings on in this recording that aren't reproduced yet: ${R.unsupported.join(', ')}.`;
        return finish({
            result: res, inStep: res === 'done' && !n && R.frames >= T.frames.length, summary, stageName: R.stageName, area: w >>> 24, episode: (w >>> 16) & 0xFF,
            frames: R.frames, totalFrames: T.frames.length, ticks: R.ticks, totalTicks: T.ticks.length,
            marioChecked: R.marioChecked, calls: R.calls, literals: R.literals, shimCalls: R.shimCalls, padCorrections: R.padCorrections,
            issues: R.issues, unsupported: R.unsupported, shinyShines: shiny, fstPad: R.fstPadUsed, disc: D.kind,
            instructions: Math.round(R.m.cpu.count / 1e6), seconds: 0, log,
        });
    } catch (e) {
        const r = emptyReport(T, 'error', `The replay stopped on an error: ${(e as Error).message || String(e)}`, t0);
        r.error = String((e as Error).stack || e);
        return finish(r);
    }
}

