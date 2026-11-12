// The lockstep comparer (v2 against v3, tick by tick). pm_probe.ts starts it with LOCKSTEP=1: a worker plays the
// trace in v3 (lockstep_v3.ts) and sends each tick's game objects; after each of v2's ticks (the player's
// testPerform, at st.qf: the oracle's labels) the same objects of v2 are read field by field, by the decomp's
// class layouts (layouts.ts), and every field compared bit for bit as the game holds it (f32 as f32 bits, s16 as
// s16 ...). Objects pair by role (Mario, camera) and, for actors, by name and their place among actors of that name.
// It reports the first differing field (class, field, tick, both values), each object's first difference, and what
// it couldn't compare: game fields with no v2 property, game objects with no v2 object.
//   env: LS_TO=<tick> stop there, LS_FROM=<tick> start comparing there, LS_TOP=n rows to list (default 30),
//        LS_TOFF=n compare v2's tick t with v3's t + n (default 0), LS_ONLY=<text> only classes or names with <text>,
//        LS_JSON=<file> write the full result as JSON
import { Worker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { layoutOf, SIZE as SIZES, type Field } from './layouts.ts';

// v2's names for the decomp's base members
const ALIAS: Record<string, string> = {
    mPosition: 'pos', mRotation: 'rot', mScaling: 'scale', mActorType: 'actorType', mAttackRadius: 'attackRadius',
    mAttackHeight: 'attackHeight', mDamageRadius: 'damageRadius', mDamageHeight: 'damageHeight', mEntryRadius: 'entryRadius',
    mHitFilter: 'hitFilter', mPositionDelta: 'posDelta', mRotationDelta: 'rotDelta', mVelocity: 'vel',
    mScaledBodyRadius: 'scaledBodyRadius', mBodyRadius: 'bodyRadius', mHeadHeight: 'headHeight', mGroundHeight: 'groundHeight',
    mGravity: 'gravity', mRidePos: 'ridePos', mGroundActorYaw: 'groundActorYaw', mLiveFlag: 'liveFlag', mInstanceIndex: 'instanceIndex',
    mKeyCode: 'keyCode',
};
const SKIP = new Set(['mName', 'unk1C']);
// bits not compared, by class.field: Mario's occlusion bit (MARIO_FLAG_OCCLUDED) is the GPU's: v3 has no frame
// buffer to peek at, so its draw-sync callback writes a bit of its own between the recorded ones (v3 game/replay.ts)
const MASK: Record<string, number> = { 'TMario.mFlag': ~1 >>> 0, 'TMario.mPrevFlag': ~1 >>> 0 };

const F = new Float32Array(1), U = new Uint32Array(F.buffer), D = new Float64Array(1), DU = new Uint32Array(D.buffer);
const f32bits = (v: number) => { F[0] = v; return U[0]; };
/** the game's bytes of a field, as a list of words: f32 / s16 / ... each as the game holds it */
function gameVal(b: Buffer, f: Field): number[] {
    const o = f.off;
    switch (f.type) {
        case 'f32': case 'u32': case 's32': return [b.readUInt32BE(o)];
        case 'f64': return [b.readUInt32BE(o), b.readUInt32BE(o + 4)];
        case 's16': case 'u16': return [b.readUInt16BE(o)];
        case 's8': case 'u8': case 'bool': return [b[o]];
        case 'v3f': return [b.readUInt32BE(o), b.readUInt32BE(o + 4), b.readUInt32BE(o + 8)];
        case 'v3s16': return [b.readUInt16BE(o), b.readUInt16BE(o + 2), b.readUInt16BE(o + 4)];
        default: return [];
    }
}
/** v2's property in the same form, or null where it can't be read as that type; `unrounded`: an f32 field holding a double */
function simVal(v: any, f: Field): { w: number[]; unrounded: boolean } | null {
    const num = (x: any) => typeof x === 'number' ? x : typeof x === 'boolean' ? +x : null;
    const fl = (x: any) => { const n = num(x); return n === null ? null : n; };
    let unrounded = false;
    const f32 = (x: any) => { const n = fl(x); if (n === null) return null; if (Math.fround(n) !== n) unrounded = true; return f32bits(n); };
    const int = (x: any, bits: number) => { const n = num(x); return n === null ? null : bits === 32 ? n >>> 0 : bits === 16 ? n & 0xFFFF : n & 0xFF; };
    let w: (number | null)[];
    switch (f.type) {
        case 'f32': w = [f32(v)]; break;
        case 'f64': { const n = fl(v); if (n === null) return null; D[0] = n; w = [DU[1], DU[0]]; break; }
        case 'u32': case 's32': w = [int(v, 32)]; break;
        case 's16': case 'u16': w = [int(v, 16)]; break;
        case 's8': case 'u8': case 'bool': w = [int(v, 8)]; break;
        case 'v3f': if (!v || typeof v !== 'object') return null; w = [f32(v.x ?? v[0]), f32(v.y ?? v[1]), f32(v.z ?? v[2])]; break;
        case 'v3s16': if (!v || typeof v !== 'object') return null; w = [int(v.x ?? v[0], 16), int(v.y ?? v[1], 16), int(v.z ?? v[2], 16)]; break;
        default: return null;
    }
    if (w.some((x) => x === null)) return null;
    return { w: w as number[], unrounded };
}
function propOf(o: any, name: string): { has: boolean; v: any } {
    if (name in o) return { has: true, v: o[name] };
    const a = ALIAS[name]; if (a && a in o) return { has: true, v: o[a] };
    if (/^m[A-Z]/.test(name)) { const n = name[1].toLowerCase() + name.slice(2); if (n in o) return { has: true, v: o[n] }; }
    return { has: false, v: undefined };
}
const show = (f: Field, w: number[]) => w.map((x) => f.type === 'f32' || f.type === 'v3f' ? `${x.toString(16).padStart(8, '0')}(${(F[0] = 0, U[0] = x, +F[0].toPrecision(9))})` : `0x${x.toString(16)}`).join(',');

interface Diff { tick: number; key: string; cls: string; field: string; off: number; game: string; sim: string }
export function startLockstep(file: string, st: any, P: any, randState: () => number) {
    const size = 64 << 20, sab = new SharedArrayBuffer(16 + size), ctl = new Int32Array(sab, 0, 4), ring = new Uint8Array(sab, 16, size);
    const w = new Worker(process.env.LS_WORKER || '/tmp/claude-0/ct/lockstep_v3.mjs', { workerData: { file, sab, size }, env: process.env });
    w.on('error', (e) => { console.log('LOCKSTEP v3 worker failed:', e); });
    const dec = new TextDecoder();
    let rd = 0;
    const next = (): any => {
        for (;;) { const wr = Atomics.load(ctl, 0); if (wr - rd >= 4) break; Atomics.wait(ctl, 0, wr, 1000); }
        const at = (i: number) => ring[(rd + i) % size];
        const n = at(0) | (at(1) << 8) | (at(2) << 16) | (at(3) << 24);
        for (;;) { const wr = Atomics.load(ctl, 0); if (wr - rd >= 4 + n) break; Atomics.wait(ctl, 0, wr, 1000); }
        const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = ring[(rd + 4 + i) % size];
        rd += 4 + n; Atomics.store(ctl, 1, rd); Atomics.notify(ctl, 1);
        const msg = JSON.parse(dec.decode(b));
        if (msg.log !== undefined) { console.log(msg.log); return next(); }
        return msg;
    };
    // (from tick 2 by default: v3 takes the heap's leftovers from a recorded object's first record, during the first tick)
    const FROM = +(process.env.LS_FROM || 2), TO = +(process.env.LS_TO || 1e9), TOFF = +(process.env.LS_TOFF || 0), ONLY = process.env.LS_ONLY || '';
    let pending: any = null, ended = false;
    const firstByKey = new Map<string, Diff>(), firstByField = new Map<string, Diff>();
    const unmapped = new Map<string, Set<string>>(), unpaired = new Map<string, number>(), unrounded = new Map<string, number>();
    let first: Diff | null = null, ticks = 0, compared = 0, randFirst = -1, uninit = 0;
    const pairSim = () => {
        const out = new Map<string, any>();
        const W = st.world, count = new Map<string, number>();
        out.set('mario', P);
        if (P.simCamera) out.set('camera', P.simCamera);
        const seen = new Set<any>();
        const add = (a: any) => {
            if (!a || typeof a.name !== 'string' || seen.has(a)) return; seen.add(a);
            const k = count.get(a.name) || 0; count.set(a.name, k + 1);
            if (!out.has(`${a.name}#${k}`)) out.set(`${a.name}#${k}`, a);
        };
        // the conductor's managers, then its lone actors, then whatever else the world keeps by name
        for (const m of (W.conductor?.liveManagers || [])) for (const a of (m.objs || [])) add(a);
        for (const a of (W.conductor?.aloneActors || [])) add(a);
        for (const a of (W.extras || [])) add(a);
        for (const a of (W.byName?.values() || [])) if (a && 'pos' in a) add(a);
        return out;
    };
    const compareTick = (g: any, t: number) => {
        ticks++;
        const sims = pairSim(), count = new Map<string, number>();
        if (randFirst < 0 && (randState() >>> 0) !== g.rand) randFirst = t;
        for (const o of g.objs) {
            let key = o.role;
            if (o.role === 'actor') { const k = count.get(o.name) || 0; count.set(o.name, k + 1); key = `${o.name}#${k}`; }
            if (ONLY && !o.cls.includes(ONLY) && !o.name.includes(ONLY)) continue;
            const s = sims.get(key);
            if (!s) { unpaired.set(`${o.cls} ${key}`, (unpaired.get(`${o.cls} ${key}`) || 0) + 1); continue; }
            const b = Buffer.from(o.b, 'base64');
            // (bytes the game hasn't written since the object's allocation: what the session left there, lockstep_v3.ts)
            const u = o.u ? Buffer.from(o.u, 'base64') : null;
            const unsetField = (f: { off: number; type: string }) => { if (!u) return false; const n = SIZES[f.type] || 4; for (let i = f.off; i < f.off + n; i++) if (!(u[i >> 3] & (1 << (i & 7)))) return false; return true; };
            for (const f of layoutOf(o.cls)) {
                if (f.type === 'ptr' || SKIP.has(f.name) || f.off + 1 > b.length) continue;
                if (unsetField(f)) { uninit++; continue; }
                const p = propOf(s, f.name);
                if (!p.has) { let u = unmapped.get(o.cls); if (!u) unmapped.set(o.cls, u = new Set()); u.add(`${f.cls}.${f.name}`); continue; }
                const sv = simVal(p.v, f); if (!sv) { let u = unmapped.get(o.cls); if (!u) unmapped.set(o.cls, u = new Set()); u.add(`${f.cls}.${f.name}(type)`); continue; }
                const gv = gameVal(b, f); compared++;
                const mk = MASK[`${f.cls}.${f.name}`]; if (mk !== undefined) { gv[0] = (gv[0] & mk) >>> 0; sv.w[0] = (sv.w[0] & mk) >>> 0; }
                if (sv.unrounded) unrounded.set(`${o.cls}.${f.name}`, (unrounded.get(`${o.cls}.${f.name}`) || 0) + 1);
                if (gv.every((x, i) => x === sv.w[i])) continue;
                const d: Diff = { tick: t, key, cls: o.cls, field: `${f.cls}.${f.name}`, off: f.off, game: show(f, gv), sim: show(f, sv.w) };
                if (!first) first = d;
                if (!firstByKey.has(key)) firstByKey.set(key, d);
                const fk = `${o.cls}.${f.name}`; if (!firstByField.has(fk)) firstByField.set(fk, d);
            }
        }
    };
    const report = (why: string) => {
        const top = +(process.env.LS_TOP || 30);
        console.log(`LOCKSTEP ${why}: ${ticks} tick(s), ${compared} field comparisons (${uninit} left out: the game never wrote them); rand first differs at ${randFirst < 0 ? 'never' : randFirst}`);
        console.log(first ? `LOCKSTEP FIRST tick ${first.tick} ${first.cls} ${first.key} ${first.field} (+0x${first.off.toString(16)}) game ${first.game} v2 ${first.sim}` : 'LOCKSTEP FIRST none: every compared field is equal');
        const rows = [...firstByField.values()].sort((a, b) => a.tick - b.tick);
        console.log(`LOCKSTEP fields that differ: ${rows.length}; objects with a difference: ${firstByKey.size}`);
        for (const d of rows.slice(0, top)) console.log(`LS ${d.tick} ${d.cls} ${d.key} ${d.field}+0x${d.off.toString(16)} game ${d.game} v2 ${d.sim}`);
        console.log(`LOCKSTEP unpaired game objects: ${unpaired.size}` + (unpaired.size ? ' (' + [...unpaired.keys()].slice(0, 12).join('; ') + ')' : ''));
        for (const [c, s] of unmapped) console.log(`LS-UNMAPPED ${c}: ${s.size} field(s): ${[...s].slice(0, 20).join(' ')}`);
        if (unrounded.size) console.log(`LS-UNROUNDED (an f32 field holding a value an f32 can't): ${[...unrounded.entries()].slice(0, 12).map(([k, n]) => `${k} x${n}`).join(' ')}`);
        if (process.env.LS_JSON) writeFileSync(process.env.LS_JSON, JSON.stringify({ first, fields: rows, objects: [...firstByKey.values()], unpaired: [...unpaired.keys()], unmapped: Object.fromEntries([...unmapped].map(([c, s]) => [c, [...s]])), randFirst, ticks, compared }, null, 1));
    };
    // after each of v2's ticks: the v3 tick of the same label
    const o = P.testPerform.bind(P);
    let done = false, lastT = -1e9;
    // (at the entry of the player's first perform of each tick: where v3's tick hook reads the game)
    P.testPerform = (c: any) => {
        const r = (): any => o(c);
        if (done) return r();
        const t = st.qf;
        if (t === lastT) return r();
        lastT = t;
        if (t < FROM) return r();
        if (t > TO) { done = true; report('stopped at LS_TO'); w.terminate(); return r(); }
        while (!ended && (!pending || pending.t < t + TOFF)) { pending = next(); if (pending.end) { ended = true; if (process.env.LS_COV && pending.covered) writeFileSync(process.env.LS_COV, pending.covered.join('\n') + '\n'); report(`v3 ended (${pending.ticks} ticks${pending.issues.length ? ', ' + pending.issues[0] : ''})`); done = true; w.terminate(); return r(); } }
        if (pending && pending.t === t + TOFF) compareTick(pending, t);
        return r();
    };
    process.on('exit', () => { if (!done) report('v2 ended'); });
}
