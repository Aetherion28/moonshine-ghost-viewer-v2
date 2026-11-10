// v3 in a real browser: loads the built viewer (site/) in headless Chromium, gives it a disc image and a trace,
// clicks "Verify with the game's code" and prints the report.
// Run: node v3/tests/browser.mjs <site folder> <disc image> <trace.msgt>   (needs Playwright with Chromium)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
const [site, iso, trace] = process.argv.slice(2);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.map': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png' };
const srv = http.createServer((q, s) => { let p = join(site, decodeURIComponent(q.url.split('?')[0])); if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html'); if (!existsSync(p)) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }); s.end(readFileSync(p)); });
await new Promise((r) => srv.listen(0, r));
const url = `http://127.0.0.1:${srv.address().port}/index.html`;
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const pg = await b.newPage();
pg.on('console', (m) => { const t = m.text(); if (/\[v3\]|error/i.test(t)) console.log('[page]', t.slice(0, 300)); });
pg.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await pg.goto(url);
await pg.setInputFiles('#isoFile', iso);
console.log('disc given');
await pg.waitForTimeout(3000);
await pg.setInputFiles('#ghostFile', trace);
console.log('trace given');
await pg.waitForFunction(() => !document.getElementById('v3VerifyRow').hidden, null, { timeout: 120000 });
console.log('verify row shown');
await pg.evaluate(() => document.getElementById('v3Verify').click());
const t0 = Date.now();
let last = '';
for (;;) {
    const r = await pg.evaluate(() => window.__v3Report ? JSON.stringify({ result: window.__v3Report.result, inStep: window.__v3Report.inStep, summary: window.__v3Report.summary, disc: window.__v3Report.disc, fstPad: window.__v3Report.fstPad, seconds: window.__v3Report.seconds, error: window.__v3Report.error }) : null);
    if (r) { console.log(r); break; }
    const info = await pg.evaluate(() => document.getElementById('v3VerifyInfo').textContent);
    if (info !== last && Date.now() - t0 > 0) { last = info; if (/frame \d+0 /.test(info) || !/frame/.test(info)) console.log('  ' + info); }
    if (Date.now() - t0 > 400000) { console.log('timeout', info); break; }
    await pg.waitForTimeout(1000);
}
await b.close(); srv.close();
