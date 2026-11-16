// Leak hunt (the three-snapshot way): repeat an action, and list what was made during the middle
// rounds and is still alive after as many rounds again, with what holds it (shortest path from the
// GC roots). Things an action merely replaces (the current stage, the current sim) don't show: they
// die in the later rounds.
//   node tools/smoke/leak.mjs <site> <disc> <scenario> [files...]      ROUNDS=3 by default
// Scenarios: traces (add each file, play, remove), stages (walk the World list), options (toggle every
// checkbox, the themes and the camera modes with files[0] loaded), scrub (jump around files[0]),
// split (the comparison view on and off with files[0] and files[1]).
import { createRequire } from 'node:module';
const { chromium } = createRequire('/opt/npm-tools/node_modules/')('playwright');
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
const [site, disc, scenario, ...files] = process.argv.slice(2);
const ROUNDS = +(process.env.ROUNDS || 3);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.css': 'text/css' };
const srv = http.createServer((q, s) => { let p = join(site, decodeURIComponent(q.url.split('?')[0])); if (!existsSync(p) || statSync(p).isDirectory()) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }); s.end(readFileSync(p)); });
await new Promise((r) => srv.listen(0, r));
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const pg = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
pg.on('pageerror', (e) => errs.push(String(e.stack || e).slice(0, 300)));
await pg.goto(`http://127.0.0.1:${srv.address().port}/index.html`);
await pg.waitForTimeout(1500);
await pg.setInputFiles(statSync(disc).isFile() ? '#isoFile' : '#folderFile', disc);
await pg.waitForTimeout(8000);
const cdp = await pg.context().newCDPSession(pg);
const wait = (ms) => pg.waitForTimeout(ms);
const add = async (f) => { await pg.setInputFiles('#ghostFile', f); await wait(11000); };
const removeAll = async () => { await pg.evaluate(() => { document.querySelectorAll('#ghostList button').forEach((x) => { if (/remove/i.test(x.textContent)) x.click(); }); }); await wait(500); };
const play = () => pg.evaluate(() => { const p = document.getElementById('play'); if (p && /play/i.test(p.textContent)) p.click(); });

const rounds = {
    async traces() { for (const f of files) { await add(f); await play(); await wait(3000); await removeAll(); } },
    async stages() {
        const n = await pg.evaluate(() => document.getElementById('mapSelect').options.length);
        for (const i of [1, 3, 5, 2].filter((x) => x < n)) { await pg.evaluate((k) => { const s = document.getElementById('mapSelect'); s.selectedIndex = k; s.dispatchEvent(new Event('change', { bubbles: true })); }, i); await wait(9000); }
    },
    async options() {
        await pg.evaluate(async () => {
            const nap = (ms) => new Promise((r) => setTimeout(r, ms));
            for (const c of document.querySelectorAll('aside input[type=checkbox]')) { if (c.disabled || c.id === 'optSplit') continue; c.click(); await nap(400); c.click(); await nap(200); }
            for (const t of ['dark', 'light']) { document.querySelector(`[data-theme-set="${t}"]`).click(); await nap(300); }
            for (const id of ['camFixed', 'camFree', 'camTop', 'camFollow']) { document.getElementById(id).click(); await nap(500); }
            for (const s of document.querySelectorAll('aside select')) { const o = s.selectedIndex; for (let i = 0; i < s.options.length; i++) { s.selectedIndex = i; s.dispatchEvent(new Event('change', { bubbles: true })); await nap(700); } s.selectedIndex = o; s.dispatchEvent(new Event('change', { bubbles: true })); await nap(300); }
        });
    },
    async scrub() {
        await pg.evaluate(async () => {
            const nap = (ms) => new Promise((r) => setTimeout(r, ms));
            const s = document.getElementById('scrub');
            for (const f of [0.8, 0.1, 0.5, 0.95, 0.02, 0.6]) { s.value = String(+s.max * f); s.dispatchEvent(new Event('input', { bubbles: true })); await nap(1500); }
        });
    },
    async split() {
        await pg.evaluate(async () => { const nap = (ms) => new Promise((r) => setTimeout(r, ms)); const c = document.getElementById('optSplit'); if (c.disabled) return; c.click(); await nap(6000); c.click(); await nap(2000); });
    },
};
if (!rounds[scenario]) { console.log('scenarios:', Object.keys(rounds).join(', ')); process.exit(1); }
if (scenario === 'options' || scenario === 'scrub') { await add(files[0]); await play(); }
if (scenario === 'split') { await add(files[0]); await add(files[1]); await play(); }

const snapshot = async () => {
    await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage');
    let chunks = []; const on = (e) => chunks.push(e.chunk); cdp.on('HeapProfiler.addHeapSnapshotChunk', on);
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }); cdp.off('HeapProfiler.addHeapSnapshotChunk', on);
    // (a big heap's snapshot is longer than a string can be: its number arrays are read from the bytes)
    const all = Buffer.concat(chunks.map((c) => Buffer.from(c))); chunks = null;
    const span = (key) => { const a = all.indexOf(`"${key}":[`) + key.length + 4; return [a, key === 'strings' ? all.lastIndexOf(']') : all.indexOf(']', a)]; };
    const nums = (key) => { const [a, e] = span(key), out = []; let v = 0, has = false; for (let i = a; i <= e; i++) { const c = all[i]; if (c >= 48 && c <= 57) { v = v * 10 + c - 48; has = true; } else if (has) { out.push(v); v = 0; has = false; } } return out; };
    const head = JSON.parse(all.subarray(0, all.indexOf(',"nodes":[')).toString() + '}');
    const [sa, se] = span('strings'), strings = JSON.parse('[' + all.subarray(sa, se).toString() + ']');
    return { snapshot: head.snapshot, nodes: nums('nodes'), edges: nums('edges'), strings };
};
const ids = (s) => { const f = s.snapshot.meta.node_fields, n = f.length, k = f.indexOf('id'), out = new Set(); for (let i = 0; i < s.nodes.length; i += n) out.add(s.nodes[i + k]); return out; };
const run = async () => { for (let i = 0; i < ROUNDS; i++) await rounds[scenario](); };

await run();   // (warm up: caches fill, code compiles)
const before = ids(await snapshot());
await run();
const mid = ids(await snapshot());
await run();
const s = await snapshot();
const F = s.snapshot.meta.node_fields, nf = F.length, ti = F.indexOf('type'), ni = F.indexOf('name'), si = F.indexOf('self_size'), eci = F.indexOf('edge_count'), idi = F.indexOf('id');
const T = s.snapshot.meta.node_types[0], EF = s.snapshot.meta.edge_fields, ef = EF.length, et = EF.indexOf('type'), en = EF.indexOf('name_or_index'), eto = EF.indexOf('to_node'), ET = s.snapshot.meta.edge_types[0];
const N = s.nodes.length / nf, parent = new Int32Array(N).fill(-1), pedge = new Int32Array(N), first = new Uint32Array(N + 1);
for (let i = 0, e = 0; i < N; i++) { first[i] = e; e += s.nodes[i * nf + eci]; first[i + 1] = e; }
const q = [0]; parent[0] = 0;
for (let h = 0; h < q.length; h++) { const i = q[h]; for (let e = first[i]; e < first[i + 1]; e++) { const ty = ET[s.edges[e * ef + et]]; if (ty === 'weak' || ty === 'shortcut') continue; const to = s.edges[e * ef + eto] / nf; if (parent[to] < 0) { parent[to] = i; pedge[to] = e; q.push(to); } } }
const nm = (i) => String(s.strings[s.nodes[i * nf + ni]]).slice(0, 32), ty = (i) => T[s.nodes[i * nf + ti]];
const path = (i) => { const out = []; for (let d = 0; i !== 0 && d < +(process.env.DEPTH || 9); d++) { const e = pedge[i], t = ET[s.edges[e * ef + et]]; const lab = t === 'element' || t === 'hidden' ? '[]' : String(s.strings[s.edges[e * ef + en]]).slice(0, 24); i = parent[i]; out.push(`${lab}@${['object', 'closure', 'native'].includes(ty(i)) ? nm(i) : ty(i)}`); } return out.join(' < '); };
const byKind = new Map(), byPath = new Map();
let total = 0, count = 0;
for (let i = 0; i < N; i++) {
    const id = s.nodes[i * nf + idi];
    if (before.has(id) || !mid.has(id) || parent[i] < 0) continue;
    const t = ty(i), z = s.nodes[i * nf + si];
    if (t === 'code' || t === 'synthetic') continue;   // (compiled code and the engine's own tables come and go)
    total += z; count++;
    const k = `${t}:${nm(i)}`, a = byKind.get(k) || [0, 0]; a[0]++; a[1] += z; byKind.set(k, a);
    if (z >= 2048 || ['object', 'closure'].includes(t)) { const pk = `${k} :: ${path(i)}`, p = byPath.get(pk) || [0, 0]; p[0]++; p[1] += z; byPath.set(pk, p); }
}
console.log(`${scenario}: made in rounds ${ROUNDS + 1}-${2 * ROUNDS}, still alive after ${ROUNDS} more: ${(total / 1024).toFixed(0)} KB in ${count} objects (${(total / 1024 / ROUNDS).toFixed(0)} KB a round)`);
console.log('by kind:'); for (const [k, [c, z]] of [...byKind].sort((a, b) => b[1][1] - a[1][1]).slice(0, 14)) console.log(`  ${(z / 1024).toFixed(0).padStart(7)} KB x${c} ${k}`);
console.log('by holder:'); for (const [k, [c, z]] of [...byPath].sort((a, b) => b[1][1] - a[1][1]).slice(0, +(process.env.TOP || 14))) console.log(`  ${(z / 1024).toFixed(0).padStart(7)} KB x${c} ${k.slice(0, +(process.env.WIDTH || 520))}`);
if (errs.length) { console.log('page errors:'); for (const e of [...new Set(errs)].slice(0, 6)) console.log('  ', e); }
await b.close(); srv.close();
