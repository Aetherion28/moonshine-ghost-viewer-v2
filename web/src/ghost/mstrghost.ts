// An MSTR trace (mstr.ts) as the viewer's ghost object, the shape legacy/ghost.js parseSmsGhost
// returns, so a trace plays through the same replay as a .smsghost: its controller inputs drive
// the simulation, its poses draw the recorded Mario, its camera is the recorded view.
//
// What a trace gives that SGHF does not, kept on ghost.trace: Mario's native state at every
// movement update (status, velocities, intended yaw, the camera's movement yaw unk258, the
// triangles he touched), every libc rand() call with its caller, and the console's refresh rate.
//
// Timeline: one SGHF QF is one Mario movement update, so a trace's movement tick is its QF. The
// first tick is QF 0 (a trace starts where its capture started, not at a level timer).

import { replayMstr, readMstr, marioView, cameraView, padView, contactTriangle, MstrError, MstrSummary, MstrIdentity, MarioView, CameraView, CAMERA, K } from './mstr.js';

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
    };
}

/** OSGetTick's rate, bus clock / 4: GameCube 162 MHz / 4, Wii 243 MHz / 4. */
const OS_TICKS_PER_SEC = [40_500_000, 60_750_000];

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

/**
 * Decode a trace into a ghost. Every tick is a pose sample (QF interval 1), every tick with an
 * observation an input, every tick with a camera block a camera key.
 */
export function parseMstrGhost(buf: ArrayBuffer, name = 'trace'): TraceGhost {
    const warnings: string[] = [];
    let identity: MstrIdentity | null = null;
    const ticks: TraceTick[] = [];
    const inp = { qf: [] as number[], buttons: [] as number[], stick: [] as number[], cstick: [] as number[], trig: [] as number[], analogAB: [] as number[] };
    const cam = { qf: [] as number[], pos: [] as number[], quat: [] as number[], fov: [] as number[], tag: [] as number[] };
    const rq: number[] = [], rc: number[] = [], rs: number[] = [], rr: number[] = [];
    const frameTicks: { retrace: number; osTick: number }[] = [];
    const segs: { scene: number; first: number; startQf: number; endQf: number }[] = [];
    let firstSeed: number | null = null, lastCamKey = -1e9, segNow = -1;
    const summary = replayMstr(buf, {
        onIdentity: (id) => { identity = id; },
        onFrame: (s) => {
            frameTicks.push({ retrace: s.retrace, osTick: s.osTick });
            if (firstSeed === null) firstSeed = s.seed;
        },
        onRng: (c) => { rq.push(c.tick); rc.push(c.caller); rs.push(c.seed); rr.push(c.result); },
        onTick: (s) => {
            const qf = s.tick - 1;
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
                // a key every 15 QF as SGCA keeps them, sooner on a scene change
                if (qf - lastCamKey >= 15 || segs[segNow].first === ticks.length - 1) {
                    const d = new DataView(s.camera.data.buffer, s.camera.data.byteOffset, s.camera.data.byteLength);
                    const v: number[] = []; for (let i = 0; i < 12; i++) v.push(d.getFloat32(CAMERA.view + 4 * i));
                    const q = viewQuat(v);
                    cam.qf.push(qf); cam.pos.push(...c.eye); cam.quat.push(...q); cam.fov.push(c.fovy); cam.tag.push(segNow & 63);
                    lastCamKey = qf;
                }
            }
        },
    });
    if (!summary.complete) warnings.push(`The trace stopped early (producer error ${summary.producerError}); it plays up to where it ends.`);
    if (!ticks.length) throw new MstrError('The trace has no Mario movement updates.');

    // refresh rate: OS ticks per VI retrace over the trace (frames can lag; both counters move
    // together). The timer is bus / 4: 40.5 MHz on a GameCube, 60.75 MHz on a Wii (the r8 samples,
    // recorded on a Wii, give 1013509 = 60.75 MHz / 59.94 Hz). The four (clock, rate) pairs are far
    // apart, so the nearest one names both.
    let hz = 60;
    if (frameTicks.length > 2) {
        const a = frameTicks[0], b = frameTicks[frameTicks.length - 1];
        const per = ((b.osTick - a.osTick) >>> 0) / Math.max(1, (b.retrace - a.retrace) >>> 0);
        let best = Infinity;
        for (const clock of OS_TICKS_PER_SEC) for (const [rate, label] of [[60000 / 1001, 60], [50, 50]] as const) {
            const e = Math.abs(per - clock / rate) / (clock / rate);
            if (e < best) { best = e; hz = label; }
        }
        if (best > 0.01) warnings.push(`The trace's frame timing (${per.toFixed(0)} OS ticks a retrace) matches neither 50 nor 60 Hz; assuming ${hz} Hz.`);
    }

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
        tvFormat: (gameId === 'GMSP' && hz === 50) ? 'PAL50' : 'NTSC60', refreshHz: hz,
        route: route0, routeLabel: '', runFlags: 0, resultQf: lastQf, startQf: 0, endQf: lastQf, durationQf: lastQf, sampleCount: n,
        created: 0, author: '', name, profileName: '',
        initialRng: firstSeed === null ? undefined : (firstSeed as number) >>> 0,
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
    };
    const camera = cam.qf.length ? {
        count: cam.qf.length, truncated: !summary.complete, qf: Float64Array.from(cam.qf), pos: Float32Array.from(cam.pos),
        quat: Float32Array.from(cam.quat), fov: Float32Array.from(cam.fov), tag: Uint8Array.from(cam.tag),
    } : null;
    if (hz === 50) warnings.push('This run was played at 50 Hz.');
    return {
        header, segments, qf, pos, yaw, anim, phase: new Uint16Array(n), yoshi: new Uint8Array(n), held: new Uint8Array(n), attachments: [], segIndex,
        inputs, splits: [], camera, rng: null, warnings,
        trace: {
            summary, identity: id, hz, ticks,
            rng: { qf: Int32Array.from(rq), caller: Uint32Array.from(rc), seed: Uint32Array.from(rs), result: Uint16Array.from(rr), count: rq.length },
        },
    };
}

/** True when the bytes start like an MSTR trace. */
export function isMstr(buf: ArrayBuffer) {
    return buf.byteLength >= 64 && new DataView(buf).getUint32(0) === 0x4d535452;
}

export { readMstr, K };
