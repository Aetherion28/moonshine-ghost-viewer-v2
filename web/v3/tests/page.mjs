// The MSGT viewer's page in a real browser: serves a built page (v3/page/build.mjs), gives it a disc image and
// recordings, presses Play and prints each result; with a folder as the last argument, saves screenshots there.
// Run: node v3/tests/page.mjs <built page folder> <disc image> <trace.msgt>[,<trace.msgt>...] [screenshot folder]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
const [site, iso, traces, shots] = process.argv.slice(2);
const types = { '.html': 'text/html', '.js': 'text/javascript' };
const srv = http.createServer((q, s) => {
    let p = join(site, decodeURIComponent(q.url.split('?')[0]));
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
    if (!existsSync(p)) { s.writeHead(404); s.end(); return; }
    s.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }); s.end(readFileSync(p));
});
await new Promise((r) => srv.listen(0, r));
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const pg = await b.newPage({ viewport: { width: 1320, height: 900 }, deviceScaleFactor: shots ? 2 : 1, colorScheme: process.env.LIGHT ? 'light' : 'dark' });
pg.on('console', (m) => { if (m.type() === 'error') console.log('[page error]', m.text().slice(0, 300)); });
pg.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await pg.goto(`http://127.0.0.1:${srv.address().port}/`);
if (shots) { mkdirSync(shots, { recursive: true }); await pg.screenshot({ path: join(shots, '0-empty.png') }); }
await pg.setInputFiles('#isoFile', iso);
await pg.setInputFiles('#traceFile', traces.split(','));
await pg.waitForFunction(() => !document.getElementById('run').disabled, null, { timeout: 30000 });
console.log('disc:', (await pg.textContent('#discInfo')).trim());
await pg.click('#run');
const t0 = Date.now();
let shot = 0, last = '';
for (;;) {
    const st = await pg.evaluate(() => ({ jobs: [...document.querySelectorAll('.job')].map((j) => j.querySelector('.name').textContent + ': ' + j.querySelector('.state').textContent), running: !document.getElementById('stop').disabled, frame: document.querySelector('#readout .v')?.textContent || '' }));
    const line = st.jobs.join(' | ');
    if (line !== last) { last = line; console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)} s  ${line}  (${st.frame})`); }
    if (shots && !shot && /\d\d%/.test(line) && Date.now() - t0 > 12000) { shot = 1; await pg.screenshot({ path: join(shots, '1-playing.png') }); }
    if (!st.running && Date.now() - t0 > 3000) break;
    if (Date.now() - t0 > 1800000) { console.log('timeout'); break; }
    await pg.waitForTimeout(1000);
}
console.log('result:', (await pg.textContent('#result .verdict')).trim(), '-', (await pg.textContent('#result .summary')).trim().slice(0, 400));
if (shots) await pg.screenshot({ path: join(shots, '2-done.png'), fullPage: true });
await b.close(); srv.close();
