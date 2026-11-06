// An MSTR trace (mstr.ts) as the viewer's ghost object, the shape legacy/ghost.js parseSmsGhost
// returns, so a trace plays through the same replay as a .smsghost: its controller inputs drive
// the simulation, its poses draw the recorded Mario, its camera is the recorded view.
//
// What a trace gives that SGHF does not, kept on ghost.trace: Mario's native state at every
// movement update (status, velocities, intended yaw, the camera's movement yaw unk258, the
// triangles he touched), every libc rand() call with its caller, and the console's refresh rate.
//
// Timeline: one QF is one world movement tick. The recorder's tick counts Mario's updates, so
// it stands still while the director stops the world (a Shine's appear demo); the QF here counts
// four ticks a frame from the frame records instead. The first tick is QF 0 (a trace starts where
// its capture started, not at a level timer).

import { replayMstr, readMstr, marioView, cameraView, padView, contactTriangle, MstrError, MstrSummary, MstrIdentity, MstrStageStart, MarioView, CameraView, CAMERA, K } from './mstr.js';

export interface TraceTick {
    qf: number; frame: number; scene: number;
    mario: MarioView | null; camera: CameraView | null;
    /** the TMarioGamePad / controller observation was available (validity bits 1 / 2) */
    inputValid: number;
    contacts: (ReturnType<typeof contactTriangle> | null)[];
    cameraMode: number;
}

export interface TraceGhost {
    header: any; segments: any[]; qf: Float64Array; pos: Float32Array; yaw: Int16Array; anim: Uint16Array; phase: Uint16Array;
    yoshi: Uint8Array; held: Uint8Array; attachments: any[]; segIndex: Uint8Array; inputs: any; splits: any[]; camera: any; rng: any;
    warnings: string[];
    trace: {
        summary: MstrSummary; identity: MstrIdentity | null;
        /** VI refresh measured from the frames' OS ticks: 60 or 50 */
        hz: number;
        ticks: TraceTick[];
        /** every libc rand() call: tick (QF), caller return address, post-seed, result */
        rng: { qf: Int32Array; caller: Uint32Array; seed: Uint32Array; result: Uint16Array; count: number };
        /** the actors' recorded state (see TraceActors) */
        actors: TraceActors;
        /** TMarDirector's state changes as the frames began (the world QF of the frame's first tick, the new state) */
        director: { qf: Int32Array; state: Int32Array; count: number };
        /** the stage-start record (kind 22), null without one */
        stageStart: MstrStageStart | null;
        /** the GPU results the game used (Feedback consumers), in the order it read them */
        feedback: TraceFeedback;
    };
}


/**
 * The stage's actors as the recorder saw them once a frame (ghost_trace.cpp roster(): every live
 * manager's objects, enemy managers first, then the conductor's lone actors, each a copy of the
 * object's first 0x150 or 0xF4 bytes, sent as the words that changed). Kept per record: the QF of
 * the tick it was taken at, the recorder's id for the object (one per object pointer), the
 * JDrama::TNameRef key code (+0x8), TPlacement's position (+0x10), TActor's scaling (+0x24) and
 * rotation (+0x30), and TLiveActor's velocity (+0xAC) and mLiveFlag (+0xF0).
 * ends: the QF where an object left the roster (deleted, or no longer in a manager).
 */
export interface TraceActors {
    count: number; qf: Int32Array; id: Uint32Array; key: Uint16Array; created: Uint8Array; extent: Uint16Array;
    pos: Float32Array; scale: Float32Array; rot: Float32Array; vel: Float32Array; liveFlag: Uint32Array;
    /** THitActor::mHitFilter (+0x64, word 25) */
    hitFilter: Uint32Array;
    ends: { qf: Int32Array; id: Uint32Array; count: number };
}

/** A view matrix's rotation (rows, world to view) as the camera's world orientation quaternion. */
function viewQuat(m: number[]): [number, number, number, number] {
    // camera orientation C = R^T; quaternion of C (x, y, z, w)
    const r00 = m[0], r01 = m[1], r02 = m[2], r10 = m[4], r11 = m[5], r12 = m[6], r20 = m[8], r21 = m[9], r22 = m[10];
    // C[i][j] = R[j][i]
    const c00 = r00, c01 = r10, c02 = r20, c10 = r01, c11 = r11, c12 = r21, c20 = r02, c21 = r12, c22 = r22;
    const tr = c00 + c11 + c22;
    let x, y, z, w;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (c21 - c12) / s; y = (c02 - c20) / s; z = (c10 - c01) / s; }
    else if (c00 > c11 && c00 > c22) { const s = Math.sqrt(1 + c00 - c11 - c22) * 2; w = (c21 - c12) / s; x = s / 4; y = (c01 + c10) / s; z = (c02 + c20) / s; }
    else if (c11 > c22) { const s = Math.sqrt(1 + c11 - c00 - c22) * 2; w = (c02 - c20) / s; x = (c01 + c10) / s; y = s / 4; z = (c12 + c21) / s; }
    else { const s = Math.sqrt(1 + c22 - c00 - c11) * 2; w = (c10 - c01) / s; x = (c02 + c20) / s; y = (c12 + c21) / s; z = s / 4; }
    const l = Math.hypot(x, y, z, w) || 1;
    return [x / l, y / l, z / l, w / l];
}

const AREA_NAMES_REGION: Record<string, string> = { GMSJ: 'JP', GMSE: 'US', GMSP: 'PAL' };

/** What a GPU-feedback observation fed (Moonshine's ghostRenderFeedback consumer numbers). */
export const enum Feedback { CAMERA = 0, SILHOUETTE = 1, WATER = 2 }
/**
 * The kind-15 records that are not MSL rand() calls but literal observations of a value the GPU gave the
 * game (ghost_render_feedback.hxx; their caller is the consumer's site + 4): Mario's occlusion flag where
 * CPolarSubCamera::ctrlNormalOrTowerCamera_ and TSilhouette::perform read it, and the height
 * TBathWaterManager::getWaterHeight returns (an IEEE-754 single's bits). Per game ID.
 */
const FEEDBACK_SITES: Record<string, [number, number, number]> = {
    GMSJ: [0x80359ca8, 0x800c2d10, 0x801fabf4],
    GMSE: [0x8002a120, 0x80227960, 0x801a90b0],
    GMSP: [0x8002a1d8, 0x8021f8b4, 0x801a1938],
};
/** A GPU-feedback observation: the world QF (the tick's label, as Mario's) and the value the game used. */
export interface TraceFeedback { count: number; qf: Int32Array; consumer: Uint8Array; value: Uint32Array; }

/**
 * Decode a trace into a ghost. Every tick is a pose sample (QF interval 1), every tick with an
 * observation an input, every tick with a camera block a camera key.
 */
export function parseMstrGhost(buf: ArrayBuffer, name = 'trace'): TraceGhost {
    const warnings: string[] = [];
    let identity: MstrIdentity | null = null;
    const ticks: TraceTick[] = [];
    const inp = { qf: [] as number[], buttons: [] as number[], stick: [] as number[], cstick: [] as number[], trig: [] as number[], analogAB: [] as number[] };
    const fp = { qf: [] as number[], buttons: [] as number[], stick: [] as number[], cstick: [] as number[], trig: [] as number[], analogAB: [] as number[] };
    const cam = { qf: [] as number[], pos: [] as number[], quat: [] as number[], fov: [] as number[], tag: [] as number[], at: [] as number[], up: [] as number[] };
    const rq: number[] = [], rc: number[] = [], rs: number[] = [], rr: number[] = [];
    const fb = { qf: [] as number[], consumer: [] as number[], value: [] as number[] };
    const ds = { qf: [] as number[], state: [] as number[] };
    let stageStart: MstrStageStart | null = null, runFlags = 0, provenance = false;
    const segs: { scene: number; first: number; startQf: number; endQf: number }[] = [];
    let firstSeed: number | null = null, lastCamKey = -1e9, segNow = -1;
    /** the world tick at the current frame's start, and the recorder's (Mario-update) tick there */
    let worldTick = 0, frameTick: number | null = null, lastMenu = false;
    const u32v = new Uint32Array(1), f32v = new Float32Array(u32v.buffer);
    const ac = { qf: [] as number[], id: [] as number[], key: [] as number[], created: [] as number[], extent: [] as number[], pos: [] as number[], scale: [] as number[], rot: [] as number[], vel: [] as number[], liveFlag: [] as number[], hitFilter: [] as number[] };
    const ae = { qf: [] as number[], id: [] as number[] };
    const worldQf = (t: number) => (frameTick === null ? t : worldTick + (t - frameTick)) - 1;
    const summary = replayMstr(buf, {
        onIdentity: (id) => { identity = id; },
        onFrame: (s) => {
            if (firstSeed === null) firstSeed = s.seed;
            // a frame is four world ticks however many of them moved Mario (none while the director
            // stops the world for a Shine's appear demo: the recorder's tick counts Mario's updates)
            // (Moonshine's menu can stop the game: a frame whose own record or the next one's has it shown
            // (words[7] bit 0) and that moved Mario on none of its ticks ran no world ticks, so the frame
            // after starts where it did. Shown over a running game (Mario moving), it's an ordinary frame.)
            if (frameTick === null) worldTick = s.tick;
            else if (!(lastMenu || s.menuShown) || s.tick !== frameTick) worldTick += 4;
            lastMenu = s.menuShown;
            frameTick = s.tick;
            // TMarDirector's state as the frame began: a change is listed at the world QF of the tick before it (the changeState after that tick, or one earlier in the frame before, made it)
            if (s.directorState !== -1 && (!ds.state.length || ds.state[ds.state.length - 1] !== s.directorState)) { ds.qf.push(worldQf(s.tick)); ds.state.push(s.directorState); }
        },
        onActor: (aid, _ptr, extent, words, created, _frame, tick) => {
            const fl = (n: number) => { u32v[0] = words[n]; return f32v[0]; };
            const at = worldQf(tick);
            ac.qf.push(at); ac.id.push(aid); ac.key.push(words[2] >>> 16); ac.created.push(created ? 1 : 0); ac.extent.push(extent);
            ac.pos.push(fl(4), fl(5), fl(6)); ac.scale.push(fl(9), fl(10), fl(11)); ac.rot.push(fl(12), fl(13), fl(14));
            if (extent >= 0xF4) { ac.vel.push(fl(43), fl(44), fl(45)); ac.liveFlag.push(words[60]); } else { ac.vel.push(0, 0, 0); ac.liveFlag.push(0); }
            ac.hitFilter.push(words[25] >>> 0);
        },
        onActorEnd: (aid, _frame, tick) => { ae.qf.push(worldQf(tick)); ae.id.push(aid); },
        onRng: (c) => {
            // (a literal record at a GPU-feedback site is an observation, not a roll)
            const sites = c.raw && FEEDBACK_SITES[(identity as MstrIdentity | null)?.gameId.slice(0, 4) || ''];
            const which = sites ? sites.indexOf(c.caller >>> 0) : -1;
            if (which >= 0) { fb.qf.push(worldQf(c.tick)); fb.consumer.push(which); fb.value.push(c.result >>> 0); return; }
            rq.push(worldQf(c.tick)); rc.push(c.caller); rs.push(c.seed); rr.push(c.result);
        },
        onStageStart: (s) => { if (!stageStart) stageStart = s; },
        onProvenance: (f) => { runFlags |= f; provenance = true; },
        onTick: (s) => {
            // v3: each frame also records the pad as the frame starts (cue 0, word 1's high bit), not a movement update
            // (kept apart: the pad of a frame Mario doesn't move in, a paused one's, labelled as its first tick would be)
            if (s.input && s.input.length >= 8 && (s.input[4] & 0x80)) {
                if (lastMenu) return;   // (the menu's frames: the game didn't read it)
                const p = padView(s.input);
                fp.qf.push(worldTick); fp.buttons.push(p.button); fp.stick.push(p.stickX, p.stickY); fp.cstick.push(p.substickX, p.substickY);
                fp.trig.push(p.triggerL, p.triggerR); fp.analogAB.push(p.analogA, p.analogB);
                return;
            }
            const qf = worldQf(s.tick);
            if (!segs.length || segs[segs.length - 1].scene !== s.scene) { segs.push({ scene: s.scene, first: ticks.length, startQf: qf, endQf: qf }); segNow = segs.length - 1; }
            segs[segNow].endQf = qf;
            const m = s.mario ? marioView(s.mario) : null, c = s.camera ? cameraView(s.camera) : null;
            ticks.push({
                qf, frame: s.frame, scene: s.scene, mario: m, camera: c,
                inputValid: s.input ? padView(s.input).valid : 0,
                contacts: s.contacts.map((x) => (x && x.valid ? contactTriangle(x) : null)),
                cameraMode: s.cameraMeta ? s.cameraMeta.mode : (c ? c.mode : -1),
            });
            if (s.input) {
                const p = padView(s.input);
                inp.qf.push(qf); inp.buttons.push(p.button); inp.stick.push(p.stickX, p.stickY); inp.cstick.push(p.substickX, p.substickY);
                inp.trig.push(p.triggerL, p.triggerR); inp.analogAB.push(p.analogA, p.analogB);
            }
            if (s.camera && c) {
                // a key every tick: the view the game rendered (its view matrix, +0x1EC: rows right, up,
                // back and the translation), so the viewer's Follow shows exactly the game's camera
                if (qf !== lastCamKey) {
                    const d = new DataView(s.camera.data.buffer, s.camera.data.byteOffset, s.camera.data.byteLength);
                    const v: number[] = []; for (let i = 0; i < 12; i++) v.push(d.getFloat32(CAMERA.view + 4 * i));
                    const q = viewQuat(v);
                    // eye = -R^T t; the forward is the back row negated, the up the up row
                    const ex = -(v[0] * v[3] + v[4] * v[7] + v[8] * v[11]), ey = -(v[1] * v[3] + v[5] * v[7] + v[9] * v[11]), ez = -(v[2] * v[3] + v[6] * v[7] + v[10] * v[11]);
                    cam.qf.push(qf); cam.pos.push(ex, ey, ez); cam.quat.push(...q); cam.fov.push(c.fovy); cam.tag.push(segNow & 63);
                    cam.at.push(ex - v[8], ey - v[9], ez - v[10]); cam.up.push(v[4], v[5], v[6]);
                    lastCamKey = qf;
                }
            }
        },
    });
    if (!summary.complete) warnings.push(`The replay stopped early (producer error ${summary.producerError}); it plays up to where it ends.`);
    if (!ticks.length) throw new MstrError('The replay has no Mario movement updates.');

    // Ghosts are taken to be 60 Hz: the game code always runs at the 60 Hz frame rate.
    const hz = 60;

    const id: MstrIdentity | null = identity;
    const gameId = id ? (id as MstrIdentity).gameId.slice(0, 4) : summary.header.gameCode;
    const discRevision = id ? (id as MstrIdentity).discRevision : 0;
    const route0 = { area: segs[0].scene >>> 8, episode: segs[0].scene & 0xff, parentArea: 0xff, flags: 0, variant: -1 };
    const n = ticks.length;
    const qf = new Float64Array(n), pos = new Float32Array(n * 3), yaw = new Int16Array(n), anim = new Uint16Array(n), segIndex = new Uint8Array(n);
    let k = 0;
    for (let si = 0; si < segs.length; si++) {
        const end = si + 1 < segs.length ? segs[si + 1].first : n;
        for (let i = segs[si].first; i < end; i++, k++) {
            const t = ticks[i];
            qf[k] = t.qf; segIndex[k] = si;
            if (t.mario) { pos.set(t.mario.pos, k * 3); yaw[k] = t.mario.faceAngle[1]; anim[k] = t.mario.animationId; }
            else if (k) { pos.set(pos.subarray((k - 1) * 3, k * 3), k * 3); yaw[k] = yaw[k - 1]; anim[k] = anim[k - 1]; }
        }
    }
    const lastQf = ticks[n - 1].qf;
    const header = {
        version: 'MSTR' + summary.header.version, format: 'mstr', region: AREA_NAMES_REGION[gameId] || '?', gameId, discRevision,
        tvFormat: 'NTSC60', refreshHz: hz,
        route: route0, routeLabel: '',
        // kind 28 (ghost_run_flags.h): 1 assisted, 2 a savestate used, 4 fast-forward, 8 incomplete, 16 a custom route, 32 TAS
        runFlags, runFlagsRecorded: provenance, resultQf: lastQf, startQf: 0, endQf: lastQf, durationQf: lastQf, sampleCount: n,
        created: 0, author: '', name, profileName: '',
        initialRng: firstSeed === null ? undefined : (firstSeed as number) >>> 0,
        // MSTR v3 starts recording before the stage loads: frames go by before Mario's first update, and
        // initialRng is then the seed the load itself rolls with (game/player/player.ts IntroTiming.fromLoad)
        fromLoad: summary.header.version >= 3 && segs.length > 0 && segs[0].startQf > 0,
    };
    const segments = segs.map((s, i) => ({
        firstSample: s.first, sampleCount: (i + 1 < segs.length ? segs[i + 1].first : n) - s.first, startQf: s.startQf, endQf: s.endQf,
        route: { area: s.scene >>> 8, episode: s.scene & 0xff, parentArea: 0xff, flags: 0, variant: -1 }, routeLabel: '',
    }));
    const m = inp.qf.length;
    const inputs = {
        count: m, hasFludd: false, fromTrace: true,
        qf: Float64Array.from(inp.qf), buttons: Uint16Array.from(inp.buttons), stick: Int8Array.from(inp.stick), cstick: Int8Array.from(inp.cstick),
        trig: Uint8Array.from(inp.trig), analogAB: Uint8Array.from(inp.analogAB), inputFlags: new Uint8Array(m),
        fluddMode: new Uint8Array(m), fluddOffset: new Float32Array(m * 3), fluddYaw: new Float32Array(m), fluddPitch: new Float32Array(m), fluddPower: new Uint8Array(m),
        // the pad as each frame began (TApplication's read before direct), at the frame's first tick's QF
        framePads: {
            count: fp.qf.length, qf: Float64Array.from(fp.qf), buttons: Uint16Array.from(fp.buttons), stick: Int8Array.from(fp.stick), cstick: Int8Array.from(fp.cstick),
            trig: Uint8Array.from(fp.trig), analogAB: Uint8Array.from(fp.analogAB),
        },
    };
    // A trace without kind-15 feedback records (before stage schema 3) still has Mario's flag word on every
    // tick, and its bit 0 (MARIO_FLAG_OCCLUDED, which TMario::drawSyncCallback sets from the Z buffer) is
    // what the camera and the silhouette read: in the traces that have both, each feedback record's value
    // equals that bit in the Mario record with the same label more often than any other label's (the
    // camera's reads: 2628 of 2628, 2584 of 2585 and 12980 of 13164 in three JP traces; one read a tick).
    // So those reads take the recorded bit.
    if (!fb.qf.length) {
        for (const t of ticks) {
            if (!t.mario) continue;
            const v = t.mario.flag & 1;
            fb.qf.push(t.qf, t.qf); fb.consumer.push(Feedback.CAMERA, Feedback.SILHOUETTE); fb.value.push(v, v);
        }
    }
    const camera = cam.qf.length ? {
        count: cam.qf.length, truncated: !summary.complete, qf: Float64Array.from(cam.qf), pos: Float32Array.from(cam.pos),
        quat: Float32Array.from(cam.quat), fov: Float32Array.from(cam.fov), tag: Uint8Array.from(cam.tag),
        // (a trace's keys: one a tick, the camera's own orientation in quat (not SGCA's view rotation), and
        // the view's look-at point one unit ahead and its up, for ghostCameraAt / the viewer's Follow)
        everyTick: true, orientation: true, at: Float32Array.from(cam.at), up: Float32Array.from(cam.up),
    } : null;
    return {
        header, segments, qf, pos, yaw, anim, phase: new Uint16Array(n), yoshi: new Uint8Array(n), held: new Uint8Array(n), attachments: [], segIndex,
        inputs, splits: [], camera, rng: null, warnings,
        trace: {
            summary, identity: id, hz, ticks,
            stageStart: stageStart as MstrStageStart | null,
            director: { qf: Int32Array.from(ds.qf), state: Int32Array.from(ds.state), count: ds.qf.length },
            feedback: { count: fb.qf.length, qf: Int32Array.from(fb.qf), consumer: Uint8Array.from(fb.consumer), value: Uint32Array.from(fb.value) } as TraceFeedback,
            rng: { qf: Int32Array.from(rq), caller: Uint32Array.from(rc), seed: Uint32Array.from(rs), result: Uint16Array.from(rr), count: rq.length },
            actors: {
                count: ac.qf.length, qf: Int32Array.from(ac.qf), id: Uint32Array.from(ac.id), key: Uint16Array.from(ac.key), created: Uint8Array.from(ac.created), extent: Uint16Array.from(ac.extent),
                pos: Float32Array.from(ac.pos), scale: Float32Array.from(ac.scale), rot: Float32Array.from(ac.rot), vel: Float32Array.from(ac.vel), liveFlag: Uint32Array.from(ac.liveFlag), hitFilter: Uint32Array.from(ac.hitFilter),
                ends: { qf: Int32Array.from(ae.qf), id: Uint32Array.from(ae.id), count: ae.qf.length },
            },
        },
    };
}

/** True when the bytes start like an MSTR trace. */
export function isMstr(buf: ArrayBuffer) {
    return buf.byteLength >= 64 && new DataView(buf).getUint32(0) === 0x4d535452;
}

export { readMstr, K };
