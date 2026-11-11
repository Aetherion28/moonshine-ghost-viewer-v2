// Writes game/addrs_gen.ts: the address tables of the other game versions, from the JP 1.0 tables in the code
// (`JP10` in game/replay.ts, the hooked names of game/syms_jp10.ts).
// An address is carried over as the decomp's symbol it lies in plus its place in that symbol:
//   - a function's start, a vtable, a variable: the symbol of the same name in the other version;
//   - an address inside a function: the function of the same name, and the instruction that lines up with the
//     JP one when the two functions' instructions are compared (branch targets, small-data offsets and address
//     halves left out of the comparison);
//   - an address inside a data symbol: the same offset in the symbol of the same name.
// Anything that can't be placed this way is listed and left out (the version then isn't set up).
//
// node v3/tools/gen_addrs.mjs            (from web/; the DOLs are the user's, see VERSIONS below)
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname), v3 = path.join(here, '..');
const DECOMP = process.env.DECOMP || '/home/claude/sms-ai-decomp/config';
const DOLS = process.env.DOLS || '/mnt/user-data/uploads/ghosts/dols';
/** [key, the decomp's config folder, game ID, revision, the DOL (the user's own), Moonshine's region (-1: it has no build for this version)] */
const VERSIONS = [
    ['JP11', 'GMSJ01_01', 'GMSJ01', 1, 'GMSJ01_01.dol', -1],
    ['US', 'GMSE01', 'GMSE01', 0, 'GMSE01.dol', 1],
    ['PAL', 'GMSP01', 'GMSP01', 0, 'GMSP01.dol', 2],
    ['PAL_3DAS', 'GMSP01_NX', 'GMSP01', 0, 'GMSP01_NX.dol', -1],   // (3D All-Stars: the PAL ID and revision; the DOL's size tells them apart)
];
const JP = ['JP10', 'GMSJ01', 'GMSJ01', 0, 'GMSJ01.dol'];

function readSymbols(dir) {
    const list = [], byName = new Map();
    for (const l of fs.readFileSync(path.join(DECOMP, dir, 'symbols.txt'), 'utf8').split('\n')) {
        const m = /^(\S+) = \.(\w+):0x([0-9A-F]+);(?: \/\/ (.*))?/.exec(l);
        if (!m) continue;
        const attrs = m[4] || '', size = /size:0x([0-9A-F]+)/.exec(attrs), type = /type:(\w+)/.exec(attrs);
        const s = { name: m[1], section: m[2], addr: parseInt(m[3], 16), size: size ? parseInt(size[1], 16) : 0, type: type ? type[1] : '' };
        list.push(s);
        if (byName.has(m[1])) byName.get(m[1]).push(s); else byName.set(m[1], [s]);
    }
    list.sort((a, b) => a.addr - b.addr);
    list.forEach((s, i) => { s.index = i; });
    const at = (a) => {
        let lo = 0, hi = list.length - 1;
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].addr <= a) lo = mid + 1; else hi = mid - 1; }
        // (several symbols can share an address: take the one that covers a and has a size)
        for (let k = hi; k >= 0 && k > hi - 6; k--) { const s = list[k]; if (a >= s.addr && (a < s.addr + s.size || (!s.size && a === s.addr))) return s; }
        return hi >= 0 ? list[hi] : null;
    };
    return { list, byName, at };
}
function readDol(file) {
    const b = fs.readFileSync(file), dv = new DataView(b.buffer, b.byteOffset, b.byteLength), secs = [];
    for (let i = 0; i < 18; i++) { const off = dv.getUint32(i * 4), addr = dv.getUint32(0x48 + i * 4), size = dv.getUint32(0x90 + i * 4); if (size) secs.push({ off, addr, size }); }
    return { r32: (a) => { for (const s of secs) if (a >= s.addr && a + 4 <= s.addr + s.size) return dv.getUint32(s.off + a - s.addr); return null; } };
}
/** an instruction without what moves between versions: branch targets, small-data offsets, address halves */
function shape(w) {
    const op = w >>> 26, ra = (w >>> 16) & 31;
    if (op === 18) return (w & 0xFC000003) >>> 0;
    if (op === 16) return (w & 0xFFFF0003) >>> 0;
    if (op === 15 && ra === 0) return (w & 0xFFFF0000) >>> 0;                       // lis
    if ((op === 14 || (op >= 32 && op <= 55)) && (ra === 13 || ra === 2)) return (w & 0xFFFF0000) >>> 0;   // small data
    if (op === 14 || op === 24 || (op >= 32 && op <= 55)) return (w & 0xFFFF0000) >>> 0 | 0;   // (an address's low half follows a lis: displacements out too)
    return w;
}
/** the index in b that lines up with index i of a (longest common subsequence of the two shapes), or -1 */
function lineUp(a, b, i) {
    if (a.length === b.length && a.every((x, k) => x === b[k])) return i;
    const n = a.length, m = b.length;
    if (n * m > 4e7) return -1;
    const L = new Uint16Array((n + 1) * (m + 1)), W = m + 1;
    for (let x = n - 1; x >= 0; x--) for (let y = m - 1; y >= 0; y--) L[x * W + y] = a[x] === b[y] ? L[(x + 1) * W + y + 1] + 1 : Math.max(L[(x + 1) * W + y], L[x * W + y + 1]);
    let x = 0, y = 0;
    while (x < n && y < m) {
        if (a[x] === b[y]) { if (x === i) return y; x++; y++; }
        else if (L[(x + 1) * W + y] >= L[x * W + y + 1]) { if (x === i) return -1; x++; } else y++;
    }
    return -1;
}

const jpSyms = readSymbols(JP[1]), jpDol = readDol(path.join(DOLS, JP[4]));
const isAddr = (v) => typeof v === 'number' && v >= 0x80003000 && v < 0x81800000;
/** the other version's symbol for JP symbol s: the one of its name; of several (a file's static), the one between the same neighbours */
function counterpart(s, to) {
    const c = to.byName.get(s.name);
    if (!c) return undefined;
    if (c.length === 1) return c[0];
    const near = (list, i, d) => list[i + d] ? list[i + d].name : '';
    const fit = c.filter((t) => t.section === s.section && near(to.list, t.index, -1) === near(jpSyms.list, s.index, -1) && near(to.list, t.index, 1) === near(jpSyms.list, s.index, 1));
    return fit.length === 1 ? fit[0] : null;
}
function place(a, to, toDol, notes, what) {
    const s = jpSyms.at(a);
    if (!s) { notes.push(`${what}: 0x${a.toString(16)} is in no JP symbol`); return 0; }
    const t = counterpart(s, to);
    if (!t) { notes.push(`${what}: ${s.name} (0x${a.toString(16)}) ${t === null ? 'is not one symbol' : 'is not'} in this version`); return 0; }
    const off = a - s.addr;
    if (!off) return t.addr;
    if (s.type !== 'function') {
        if (t.size && s.size && t.size !== s.size) notes.push(`${what}: ${s.name} is 0x${s.size.toString(16)} bytes in JP, 0x${t.size.toString(16)} here (offset 0x${off.toString(16)} kept)`);
        return t.addr + off;
    }
    const words = (dol, f) => { const out = []; for (let p = f.addr; p < f.addr + f.size; p += 4) out.push(shape(dol.r32(p) ?? 0)); return out; };
    const k = lineUp(words(jpDol, s), words(toDol, t), off >>> 2);
    if (k < 0) { notes.push(`${what}: ${s.name}+0x${off.toString(16)} has no counterpart (the function differs there)`); return 0; }
    return t.addr + k * 4 + (off & 3);
}
function carry(v, to, toDol, notes, what) {
    if (Array.isArray(v)) {
        // [a function's start, its size]: the size is the other version's
        if (v.length === 2 && isAddr(v[0]) && !isAddr(v[1])) { const s = jpSyms.at(v[0]); if (s && s.addr === v[0] && s.size === v[1]) { const t = counterpart(s, to); if (t) return [t.addr, t.size]; } }
        return v.map((x, i) => carry(x, to, toDol, notes, `${what}[${i}]`));
    }
    return isAddr(v) ? place(v, to, toDol, notes, what) : v;
}

// node v3/tools/gen_addrs.mjs --place 0x80363E48 ...: where single JP addresses are in each version (nothing is written)
if (process.argv[2] === '--place') {
    for (const arg of process.argv.slice(3)) {
        const a = parseInt(arg, 16), s = jpSyms.at(a), row = [`0x${a.toString(16).toUpperCase()} ${s ? s.name + '+0x' + (a - s.addr).toString(16) : '?'}`];
        for (const [key, dir, , , dolName] of VERSIONS) { const notes = [], v = place(a, readSymbols(dir), readDol(path.join(DOLS, dolName)), notes, key); row.push(`${key} ${v ? '0x' + v.toString(16).toUpperCase() : '(' + notes.join('; ') + ')'}`); }
        console.log(row.join('  '));
    }
    process.exit(0);
}

// the JP tables, as they stand in the code
const replaySrc = fs.readFileSync(path.join(v3, 'game/replay.ts'), 'utf8');
const jp10 = new Function('return ' + /export const JP10: GameAddrs = (\{[\s\S]*?\n\});/.exec(replaySrc)[1])();
const symsSrc = fs.readFileSync(path.join(v3, 'game/syms_jp10.ts'), 'utf8');
const names = [...symsSrc.matchAll(/^\s+([A-Za-z_][A-Za-z0-9_]*): 0x/gm)].map((m) => m[1]);

const hex = (v) => Array.isArray(v) ? `[${v.map(hex).join(', ')}]` : typeof v === 'number' && v > 9 ? '0x' + v.toString(16).toUpperCase() : String(v);
const sizes = {};
let out = `// Generated by tools/gen_addrs.mjs from the JP 1.0 tables (game/replay.ts, game/syms_jp10.ts), the decomp's symbols.txt
// of each version and the versions' own DOLs: where the other versions have what the replay hooks and reads.
import type { GameAddrs } from './replay.js';
`;
let bad = 0;
for (const [key, dir, id, rev, dolName, region] of VERSIONS) {
    const dolPath = path.join(DOLS, dolName);
    if (!fs.existsSync(dolPath)) { console.log(`${key}: no DOL at ${dolPath}: left out`); continue; }
    const to = readSymbols(dir), toDol = readDol(dolPath), notes = [];
    const table = {};
    for (const [k, v] of Object.entries(jp10)) table[k] = k === 'region' ? region : k === 'liveFlagsShifted' ? true : carry(v, to, toDol, notes, k);
    const syms = {};
    for (const n of names) { const t = (to.byName.get(n) || []).filter((x) => x.type === 'function'); if (t.length === 1) syms[n] = t[0].addr; else notes.push(`name ${n}: not one function in this version`); }
    console.log(`${key} (${id} revision ${rev}): ${Object.keys(table).length} entries, ${notes.length} not placed`);
    for (const n of notes) console.log('    ' + n);
    bad += notes.length;
    out += `\n/** ${id} revision ${rev} (the DOL is ${fs.statSync(dolPath).size} bytes) */\nexport const ${key}: GameAddrs = {\n${Object.entries(table).map(([k, v]) => `    ${k}: ${hex(v)},`).join('\n')}\n};\n`;
    sizes[key] = fs.statSync(dolPath).size;
    out += `export const SYMS_${key}: Record<string, number> = {\n${Object.entries(syms).map(([k, v]) => `    ${k}: ${hex(v)},`).join('\n')}\n};\n`;
}
out += `\n/** each version's DOL size (two versions share the PAL ID and revision) */\nexport const DOL_SIZES = { JP10: ${fs.statSync(path.join(DOLS, JP[4])).size}, ${Object.entries(sizes).map(([k, v]) => `${k}: ${v}`).join(', ')} };\n`;
fs.writeFileSync(path.join(v3, 'game/addrs_gen.ts'), out);
console.log(`${bad} not placed in all -> game/addrs_gen.ts`);
