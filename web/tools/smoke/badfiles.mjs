// Robustness sweep: a disc (folder or image file), then files that may be broken or wrong (ghosts,
// replays, disc images). For each: the notice it showed, how often the notice was set while it loaded
// (set on every frame means a retry loop), page errors, console errors, and whether the page still
// answers (a parser stuck in a loop doesn't).
//   node tools/smoke/badfiles.mjs <site> <disc> <outdir> <files...>
import { createRequire } from 'node:module';
const { chromium } = createRequire('/opt/npm-tools/node_modules/')('playwright');
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, basename } from 'node:path';
const [site, disc, out, ...files] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.map': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const srv = http.createServer((q, s) => { let p = join(site, decodeURIComponent(q.url.split('?')[0])); if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html'); if (!existsSync(p)) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }); s.end(readFileSync(p)); });
await new Promise((r) => srv.listen(0, r));
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const pg = await b.newPage({ viewport: { width: 1280, height: 800 } });
let log = [];
pg.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
pg.on('pageerror', (e) => log.push('[pageerror] ' + String(e.stack || e).slice(0, 500)));
await pg.goto(`http://127.0.0.1:${srv.address().port}/index.html`);
await pg.evaluate(() => { const n = document.getElementById('notice'); globalThis.__nset = 0; new MutationObserver(() => globalThis.__nset++).observe(n, { childList: true, characterData: true, subtree: true }); });
await pg.waitForTimeout(1500);
const isDisc = (f) => /\.(iso|gcm|rvz|gcz|ciso|wia)$/i.test(f);
const alive = () => Promise.race([pg.evaluate(() => 1).catch(() => 0), new Promise((r) => setTimeout(() => r(0), 5000))]);
const state = () => pg.evaluate(() => ({ notice: document.getElementById('notice')?.hidden ? '' : document.getElementById('notice')?.textContent?.slice(0, 240), set: globalThis.__nset,
    disc: document.getElementById('discInfo')?.textContent, list: document.getElementById('ghostList')?.innerText?.replace(/\s+/g, ' ').slice(0, 160) }));
const res = [];
for (const f of [disc, ...files]) {
    await pg.evaluate(() => { globalThis.__nset = 0; });
    const dir = existsSync(f) && statSync(f).isDirectory();
    try { await pg.setInputFiles(dir ? '#folderFile' : isDisc(f) ? '#isoFile' : '#ghostFile', f); } catch (e) { console.log('skip', f, String(e).slice(0, 100)); continue; }
    await pg.waitForTimeout(f === disc ? 8000 : 10000);
    const ok = await alive();
    const st = ok ? await state() : { hung: true };
    res.push({ file: basename(f), ok: !!ok, st, log });
    console.log(`${basename(f)}${ok ? '' : ' HUNG'} ${JSON.stringify(st)}${log.length ? ` ${log.length} msgs` : ''}`);
    for (const l of log.slice(0, 4)) console.log('   ', l);
    log = [];
    if (!ok) break;
    await pg.screenshot({ path: join(out, basename(f) + '.png') });
    await pg.evaluate(() => { document.querySelectorAll('#ghostList button').forEach((x) => { if (/remove|✕|×/i.test(x.textContent + (x.title || ''))) x.click(); }); });
    await pg.waitForTimeout(500);
}
writeFileSync(join(out, 'results.json'), JSON.stringify(res, null, 1));
await b.close(); srv.close();
