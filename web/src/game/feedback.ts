// GPU feedback: values the game reads back from what the GPU drew, which a simulation cannot
// reproduce exactly. A Moonshine trace (MSGT stage schema 3) records each one where the game used it
// (ghost_render_feedback.cpp: a literal kind-15 record at the consumer's site): Mario's occlusion flag
// (MARIO_FLAG_OCCLUDED, set from the Z buffer) as CPolarSubCamera::ctrlNormalOrTowerCamera_ and
// TSilhouette::perform read it, and the height TBathWaterManager::getWaterHeight returns (the bath water's
// mesh renderer reads it from a Z-buffer copy). Playing such a trace, those consumers take the recorded
// value instead of their own approximation (feedbackCtx.take), in the order the game read them in each tick.

export const enum FeedbackConsumer { CAMERA = 0, SILHOUETTE = 1, WATER = 2 }

/** The current stage's recorded GPU feedback, set by the runner around a stage's frames; null: none. */
export const feedbackCtx: { take: ((consumer: FeedbackConsumer) => number | null) | null } = { take: null };

/** The recorded value for this read of a consumer (the raw word), null when there is none. */
export function takeFeedback(consumer: FeedbackConsumer): number | null {
    return feedbackCtx.take ? feedbackCtx.take(consumer) : null;
}

const u32 = new Uint32Array(1), f32 = new Float32Array(u32.buffer);
/** An observation word as the IEEE-754 single it holds. */
export function feedbackFloat(bits: number): number { u32[0] = bits >>> 0; return f32[0]; }

interface FeedbackTape { count: number; qf: Int32Array; consumer: Uint8Array; value: Uint32Array; }

/**
 * A trace's observations by tick: take(c) at a tick hands out that tick's recorded reads of c in order
 * (the tick's label is the world QF Mario's record there has: q0 + the stage's qf); null past them.
 */
export class FeedbackReplay {
    private byQf = new Map<number, number[]>();
    private used = new Map<number, number>();
    /** reads that found no recorded value (the sim read where the game didn't, or more often) */
    misses = 0;
    /** reads answered from the recording */
    hits = 0;
    constructor(private tape: FeedbackTape, private q0: number, private qfNow: () => number) {
        for (let i = 0; i < tape.count; i++) (this.byQf.get(tape.qf[i]) || this.byQf.set(tape.qf[i], []).get(tape.qf[i])!).push(i);
    }
    get size() { return this.tape.count; }
    take = (consumer: FeedbackConsumer): number | null => {
        // (a read in the sim's tick n is the one labelled q0 + n - 1: frame W's ticks W+1..W+4 are labelled W..W+3)
        const q = this.q0 + this.qfNow() - 1, L = this.byQf.get(q);
        const key = q * 4 + consumer;
        let k = this.used.get(key) || 0;
        if (L) {
            for (const i of L) {
                if (this.tape.consumer[i] !== consumer) continue;
                if (k-- > 0) continue;
                this.used.set(key, (this.used.get(key) || 0) + 1);
                this.hits++;
                return this.tape.value[i];
            }
        }
        this.misses++;
        return null;
    };
}

/**
 * Mario's recorded status after each tick of a trace, for the state the game leaves in uninitialised
 * stack that no input decides: TMario::checkStickRotate's quadrant flags (move.ts). Set by the runner
 * around a stage's frames like feedbackCtx; at() is the status the game had after the sim's current
 * tick, null without a trace or a record.
 */
export const traceStatusCtx: { at: ((d: number) => number | null) | null } = { at: null };
/** the recorded status after the sim's current tick (d = 0) or the tick d ticks from it */
export function traceStatusAfterTick(d = 0): number | null { return traceStatusCtx.at ? traceStatusCtx.at(d) : null; }
/** A trace's Mario status by stage tick: the record with qf = base + the stage's qf. */
export function traceStatusByTick(ticks: { qf: number; mario: { status: number } | null }[], base: number, qfNow: () => number) {
    const m = new Map<number, number>();
    for (const t of ticks) if (t.mario) m.set(t.qf, t.mario.status >>> 0);
    return (d: number) => { const v = m.get(base + qfNow() + d); return v === undefined ? null : v; };
}
