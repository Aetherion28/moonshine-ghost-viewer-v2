// v3 as an oracle for the v2 simulation: plays a trace in the game's own code and prints the game's memory at
// chosen movement ticks, for things a trace doesn't record (an object's every field, objects that aren't actors).
// Run: node oracle.mjs <trace.msgt> <from tick> <to tick> <what> [<what> ...]      (ticks are the trace's labels:
//   the state after that tick, as a Mario record of the same label)
//   what:  actors                    the conductor's actors at <from>: index, address, class, name, position
//          vt:<text>                 every object whose class (vtable symbol) has <text> in its name, at <from>
//          #<index>:<off>:<len>      <len> bytes at <off> of actor <index> (as `actors` numbers them), every tick
//          @<address>:<len>          <len> bytes of memory at a hex address, every tick; @<address>>74>4+20:<len> follows
//                                    pointers first (>off: the pointer at +off; +off: add)
//          vt:<text>:<off>:<len>     the same for every object of such a class (found at <from>)
//   Offsets and lengths are hex. Each word is printed as hex and, where it looks like one, as a float.
//   env: FSTPAD (default 480), EVERY=n print every nth tick, CHANGED=1 print a line only when it differs from the last
import { readFileSync } from 'node:fs';
import { readTrace } from '../game/trace.ts';
import { Replay } from '../game/replay.ts';
import { versionOf } from '../game/versions.ts';
import { symbols } from './syms.ts';
import { discOf, loadBytes } from './jpdisc.ts';

const [file, a1, a2, ...whats] = process.argv.slice(2);
if (!file || !whats.length) { console.log('usage: node oracle.mjs <trace.msgt> <from tick> <to tick> <what> ...'); process.exit(2); }
const from = +a1, to = +a2;
const b = readFileSync(file);
const T = readTrace(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
const V = versionOf(T.gameId, T.discRevision);
if (!V) { console.log('that version is not set up here'); process.exit(2); }
const symFile = `${process.env.DECOMP || '/home/claude/sms-ai-decomp/config'}/${V.decomp}/symbols.txt`;
const S = symbols(symFile), D = discOf(V.key);
// the classes' vtables by address
const vts = new Map<number, string>();
for (const l of readFileSync(symFile, 'utf8').split('\n')) { const m = /^(__vt__\S+) = \.\w+:0x([0-9A-F]+);/.exec(l); if (m) vts.set(parseInt(m[2], 16), m[1].replace(/^__vt__\d*/, '')); }
const R = new Replay(loadBytes(D.dol), D.disc(), T, V.addrs, (n) => S.byName.get(n), { log: () => {}, fstPad: +(process.env.FSTPAD ?? 480), maxIssues: 50 });
const mem = R.m.mem, sjis = new TextDecoder('shift_jis');
const F = new Float32Array(1), W = new Uint32Array(F.buffer);
const hex = (v: number, n = 8) => (v >>> 0).toString(16).padStart(n, '0');
const word = (v: number) => { W[0] = v; const f = F[0], e = (v >>> 23) & 0xFF; return v && e > 100 && e < 160 ? `${hex(v)}(${+f.toPrecision(9)})` : hex(v); };
const name = (p: number) => { const s = mem.r32(p + 4); if (s < 0x80003000 || s >= 0x81800000) return ''; const o: number[] = []; for (let i = 0; i < 64; i++) { const c = mem.r8(s + i); if (!c) break; o.push(c); } return sjis.decode(Uint8Array.from(o)); };
const cls = (p: number) => vts.get(mem.r32(p)) ?? hex(mem.r32(p));
const pos = (p: number) => [0x10, 0x14, 0x18].map((o) => { W[0] = mem.r32(p + o); return F[0].toFixed(3); }).join(', ');
const every = +(process.env.EVERY || 1), changed = !!process.env.CHANGED;
let watch: { label: string; addr: number; len: number; last: string; path?: [string, number][] }[] | null = null;
function setUp() {
    watch = [];
    const actors = R.roster();
    const byVt = (text: string) => { const out: number[] = []; const want = new Set([...vts].filter(([, n]) => n.includes(text)).map(([a]) => a)); for (let p = 0x80400000; p < 0x817FFFF0; p += 4) if (want.has(mem.r32(p))) out.push(p); return out; };
    for (const w of whats) {
        const q = w.split(':');
        if (w === 'actors') actors.forEach((p, i) => console.log(`#${i}  ${hex(p)}  ${cls(p)}  "${name(p)}"  (${pos(p)})`));
        else if (q[0] === 'vt' && q.length === 2) for (const p of byVt(q[1])) console.log(`${hex(p)}  ${cls(p)}  "${name(p)}"  (${pos(p)})`);
        else if (q[0] === 'vt') for (const p of byVt(q[1])) watch.push({ label: `${cls(p)} ${hex(p)}+${q[2]}`, addr: p + parseInt(q[2], 16), len: parseInt(q[3], 16), last: '' });
        else if (w[0] === '#') { const p = actors[+q[0].slice(1)]; if (!p) { console.log(`no actor ${q[0]}`); continue; } watch.push({ label: `${q[0]} ${cls(p)}+${q[1]}`, addr: p + parseInt(q[1], 16), len: parseInt(q[2], 16), last: '' }); }
        else if (w[0] === '@') {
            // @<address>[>off ...][+off]: each >off reads the pointer at (address + off) and goes on from there
            const parts = q[0].slice(1).split(/(?=[>+])/);
            // (@mario: the player's object)
            const addr = parts[0] === 'mario' ? mem.r32(V!.addrs.gpMarioOriginal) : parseInt(parts[0], 16);
            const path = parts.slice(1).map((t) => [t[0], parseInt(t.slice(1), 16)] as [string, number]);
            watch.push({ label: `${q[0]}`, addr, len: parseInt(q[1], 16), last: '', path });
        }
        else console.log(`? ${w}`);
    }
}
let done = false;
R.onTick = (tick) => {
    if (tick < from || done) return;
    if (!watch) setUp();
    if (tick > to || !watch!.length) { done = true; return; }
    if ((tick - from) % every) return;
    for (const w of watch!) {
        const parts: string[] = [];
        let base = w.addr;
        if (w.path) for (const [k, o] of w.path) base = k === '>' ? mem.r32(base + o) : base + o;
        for (let o = 0; o < w.len; o += 4) parts.push(word(mem.r32(base + o)));
        const line = parts.join(' ');
        if (changed && line === w.last) continue;
        w.last = line; console.log(`${tick}  ${w.label}  ${line}`);
    }
};
while (!done && R.run(200e6) !== 'done');
console.log(`the replay: tick ${R.ticks}, ${R.issues.length} issue(s)${R.issues.length ? ': ' + R.issues[0].text : ''}${R.heapDelta ? ` (the file table wants ${R.fstPadUsed + R.heapDelta} bytes of padding: FSTPAD)` : ''}`);
