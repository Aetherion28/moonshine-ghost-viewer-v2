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

/**
 * The trace's RNG records by state, for the game's uninitialised memory that a recorded roll gives away:
 * next() is the DOL return address of the roll the game made next from the RNG's current state (each
 * record carries the post-call seed), null without a trace or a matching record. Set by the runner
 * around a stage's frames like feedbackCtx.
 */
export const traceRngCtx: { next: ((state: number) => number | null) | null } = { next: null };
export function traceNextRollCaller(state: number): number | null { return traceRngCtx.next ? traceRngCtx.next(state) : null; }
export function traceRngByState(tape: { count: number; seed: Uint32Array; caller: Uint32Array }) {
    const at = new Map<number, number[]>();
    for (let i = 0; i < tape.count; i++) { const k = tape.seed[i] >>> 0; (at.get(k) || at.set(k, []).get(k)!).push(i); }
    let last = -1;
    return (state: number) => {
        const L = at.get(state >>> 0);
        if (!L) return null;
        // (the first record with this seed at or after the last one asked for: a seed can repeat over a long run)
        let i = L.find((j) => j >= last);
        if (i === undefined) i = L[L.length - 1];
        last = i;
        return i + 1 < tape.count ? tape.caller[i + 1] >>> 0 : null;
    };
}

/**
 * The trace's actor records by stage tick, for an actor whose uninitialised memory the game's recorded
 * positions give away (TTobiPuku's first unk1E0: enemies/tobipuku.ts). at(key, x, z, d) is the recorded
 * position of the actor with that key code nearest (x, z) (within 80) in the first record frame at or after
 * the sim's current tick + d (up to 4 later), null without a trace or a record. Set by the runner around a
 * stage's frames like feedbackCtx.
 */
export const traceActorCtx: { at: ((key: number, x: number, z: number, d: number) => [number, number, number] | null) | null } = { at: null };
export function traceActorPosAfter(key: number, x: number, z: number, d: number): [number, number, number] | null {
    return traceActorCtx.at ? traceActorCtx.at(key, x, z, d) : null;
}
export function traceActorsByTick(A: { count: number; qf: Int32Array; key: Uint16Array; pos: Float32Array }, base: number, qfNow: () => number) {
    const byQf = new Map<number, number[]>();
    for (let i = 0; i < A.count; i++) { const q = A.qf[i]; (byQf.get(q) || byQf.set(q, []).get(q)!).push(i); }
    return (key: number, x: number, z: number, d: number): [number, number, number] | null => {
        const q0 = base + qfNow() + d;
        for (let q = q0; q <= q0 + 4; q++) {
            const L = byQf.get(q);
            if (!L) continue;
            let best = -1, bd = 80;
            for (const i of L) {
                if (A.key[i] !== (key & 0xFFFF)) continue;
                const e = Math.hypot(A.pos[i * 3] - x, A.pos[i * 3 + 2] - z);
                if (e < bd) { bd = e; best = i; }
            }
            if (best >= 0) return [A.pos[best * 3], A.pos[best * 3 + 1], A.pos[best * 3 + 2]];
        }
        return null;
    };
}

// Moonshine's settings over a trace: the session record (GhostSimulation::Snapshot) comes again whenever
// the runner changes one in Moonshine's menu. Some change what the game does (RICCO_FRUIT_MACHINE:
// mapobj/ricco.ts); sessionCtx.at(field) gives the field's value in the snapshot in effect at this tick.

/** GhostSimulation::Field (ghost_simulation.hxx): the snapshot's byte for a setting */
export const enum SessionField { RESPAWN_SHINES = 13, PATTERN_SELECTOR = 27, PETEY_ROUTE = 33, RICCO_FRUIT_MACHINE = 35, GELATO_BLUE_BIRD_PATTERN = 37, PATTERN_0 = 41 }

/** The current stage's recorded settings, set by the runner around a stage's frames; null: none. */
export const sessionCtx: { at: ((field: SessionField) => number | null) | null } = { at: null };

/** A setting's recorded value at this tick (null without a trace). */
export function sessionSetting(field: SessionField): number | null {
    return sessionCtx.at ? sessionCtx.at(field) : null;
}

/** A setting as the stage loaded: the last session record at or before the stage's start (q0), else the first (null: none). */
export function traceSessionAtStart(S: { qf: number[]; bytes: Uint8Array[] } | undefined, q0: number, field: SessionField): number | null {
    if (!S || !S.qf.length) return null;
    let b = S.bytes[0];
    for (let i = 0; i < S.qf.length && S.qf[i] <= q0; i++) b = S.bytes[i];
    return field < b.length ? b[field] : null;
}

/** at(field): the field in the last session record that came at or before this tick (the label q0 + the stage's qf - 1) */
export function traceSessionByTick(S: { qf: number[]; bytes: Uint8Array[] } | undefined, q0: number, qfNow: () => number) {
    if (!S || !S.qf.length) return null;
    return (field: SessionField) => {
        const q = q0 + qfNow() - 1;
        let b: Uint8Array | null = null;
        for (let i = 0; i < S.qf.length && S.qf[i] <= q; i++) b = S.bytes[i];
        return b && field < b.length ? b[field] : null;
    };
}


/**
 * Following the recorded actors (the user's direction, 2026-11-12: only Mario is simulated, everything else may come
 * from the recording). At each frame's start every sim actor of the conductor's managers takes its recorded place,
 * rotation, scale and speed: the recorder samples the roster once a frame, before the frame's ticks (ghost_trace.cpp),
 * so a record labelled L is the state after tick L - 1. An actor is paired once with a recorded object (the same name
 * key, the nearest within 80, each recorded object once) and keeps that object's records.
 */
export const traceFollowCtx: { apply: ((actors: Iterable<any>, keyOf: (a: any) => number) => void) | null } = { apply: null };
export function traceActorFollow(A: TraceActorsLike, base: number, qfNow: () => number) {
    const byQf = new Map<number, number[]>();
    for (let i = 0; i < A.count; i++) { const q = A.qf[i]; (byQf.get(q) || byQf.set(q, []).get(q)!).push(i); }
    const pairOf = new Map<any, number>(), taken = new Set<number>();
    return (actors: Iterable<any>, keyOf: (a: any) => number) => {
        const L = byQf.get(base + qfNow() - 1);
        if (!L) return;
        const byId = new Map<number, number>();
        for (const i of L) byId.set(A.id[i], i);
        for (const a of actors) {
            if (!a || !a.pos) continue;
            let i: number | undefined;
            const id = pairOf.get(a);
            if (id !== undefined) i = byId.get(id);
            else {
                const key = keyOf(a) & 0xFFFF;
                let best = -1, bd = 80;
                for (const j of L) {
                    if (A.key[j] !== key || taken.has(A.id[j])) continue;
                    const e = Math.hypot(A.pos[j * 3] - a.pos.x, A.pos[j * 3 + 2] - a.pos.z);
                    if (e < bd) { bd = e; best = j; }
                }
                if (best < 0) continue;
                pairOf.set(a, A.id[best]); taken.add(A.id[best]); i = best;
            }
            if (i === undefined) continue;
            a.pos.set(A.pos[i * 3], A.pos[i * 3 + 1], A.pos[i * 3 + 2]);
            if (a.rot) a.rot.set(A.rot[i * 3], A.rot[i * 3 + 1], A.rot[i * 3 + 2]);
            if (a.scale) a.scale.set(A.scale[i * 3], A.scale[i * 3 + 1], A.scale[i * 3 + 2]);
            if (A.extent[i] >= 0xF4 && a.vel) a.vel.set(A.vel[i * 3], A.vel[i * 3 + 1], A.vel[i * 3 + 2]);
        }
    };
}
interface TraceActorsLike { count: number; qf: Int32Array; id: Uint32Array; key: Uint16Array; extent: Uint16Array; pos: Float32Array; rot: Float32Array; scale: Float32Array; vel: Float32Array }
/**
 * Every recorded value the sim reads from a trace while it plays one (the GPU feedback, Mario's recorded
 * status, the rolls by RNG state, the actors by tick, Moonshine's settings), built for one stage and put
 * in their contexts around each frame. The viewer's runner and the test harness both play a trace
 * through this, so a new kind of recorded value is added here once. off: kinds to leave out (harness flags).
 */
export class TraceFeeds {
    feedback: FeedbackReplay | null = null;
    status: ((d: number) => number | null) | null = null;
    rng: ((state: number) => number | null) | null = null;
    actor: ((key: number, x: number, z: number, d: number) => [number, number, number] | null) | null = null;
    session: ((field: SessionField) => number | null) | null = null;
    follow: ((actors: Iterable<any>, keyOf: (a: any) => number) => void) | null = null;
    constructor(g: any, q0: number, qfNow: () => number, off: { feedback?: boolean; status?: boolean; rng?: boolean; actor?: boolean; session?: boolean; follow?: boolean } = {}) {
        const T = g && g.trace;
        if (!T) return;
        // the GPU results (the camera's read of Mario's occlusion, Bowser's bath-water height)
        if (!off.feedback && T.feedback && T.feedback.count) this.feedback = new FeedbackReplay(T.feedback, q0, qfNow);
        // Mario's recorded status after each tick (checkStickRotate's leftover stack flags: player/move.ts)
        if (!off.status && T.ticks.length) this.status = traceStatusByTick(T.ticks, q0 + g.header.startQf, qfNow);
        // the rolls by RNG state (uninitialised memory a recorded roll gives away: enemies/tobipuku.ts)
        if (!off.rng && T.rng && T.rng.count) this.rng = traceRngByState(T.rng);
        if (!off.actor && T.actors && T.actors.count) this.actor = traceActorsByTick(T.actors, q0 + g.header.startQf, qfNow);
        // the recorded actors' places at each frame's start (only Mario is simulated)
        if (!off.follow && T.actors && T.actors.count) this.follow = traceActorFollow(T.actors, q0 + g.header.startQf, qfNow);
        // Moonshine's settings as the runner changed them (the Ricco fruit machine: mapobj/ricco.ts)
        if (!off.session) this.session = traceSessionByTick(T.session, q0, qfNow);
    }
    install() {
        feedbackCtx.take = this.feedback ? this.feedback.take : null;
        traceStatusCtx.at = this.status; traceRngCtx.next = this.rng; traceActorCtx.at = this.actor; sessionCtx.at = this.session; traceFollowCtx.apply = this.follow;
    }
    static clear() {
        feedbackCtx.take = null;
        traceStatusCtx.at = null; traceRngCtx.next = null; traceActorCtx.at = null; sessionCtx.at = null; traceFollowCtx.apply = null;
    }
}
