import { createRequire } from 'node:module';
const { chromium } = createRequire('/opt/npm-tools/node_modules/')('playwright');
import http from 'node:http'; import { readFileSync, existsSync, statSync } from 'node:fs'; import { extname, join } from 'node:path';
const site = process.argv[2];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const srv = http.createServer((q, s) => { let p = join(site, decodeURIComponent(q.url.split('?')[0])); if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html'); if (!existsSync(p)) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }); s.end(readFileSync(p)); });
await new Promise((r) => srv.listen(0, r));
const b = await chromium.launch();
for (const w of [1500, 1600, 1700, 1900, 2200]) {
  const pg = await b.newPage({ viewport: { width: w, height: 800 } });
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e))); pg.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await pg.goto(`http://127.0.0.1:${srv.address().port}/index.html`); await pg.waitForTimeout(1500);
  console.log(w, await pg.evaluate(() => { const p = document.querySelector('header .sp-palm'), h = document.querySelector('header'); return getComputedStyle(p).display + ' hdrH=' + h.offsetHeight; }), errs.filter(e => /Resize/.test(e)).join(';'));
  await pg.close();
}
await b.close(); srv.close();
