// smoke sweep of the v2 viewer: disc folder, then each recording; collects page errors, console errors, screenshots
import { createRequire } from 'node:module';
const { chromium } = createRequire('/opt/npm-tools/node_modules/')('playwright');
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, basename } from 'node:path';
const [site, disc, out, ...files] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.map': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png' };
const srv = http.createServer((q, s) => { let p = join(site, decodeURIComponent(q.url.split('?')[0])); if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html'); if (!existsSync(p)) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }); s.end(readFileSync(p)); });
await new Promise((r) => srv.listen(0, r));
const url = `http://127.0.0.1:${srv.address().port}/index.html`;
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const pg = await b.newPage({ viewport: { width: 1280, height: 800 } });
let log = [];
pg.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || /\[mirror\]/.test(m.text())) log.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
pg.on('pageerror', (e) => log.push('[pageerror] ' + String(e.stack || e).slice(0, 500)));
await pg.goto(url); if (process.env.MIRCLEAR) await pg.evaluate(() => { globalThis.__mirClear = 1; }); if (process.env.NOMIR) await pg.evaluate(() => { globalThis.__noMirror = 1; });
await pg.waitForTimeout(1500);
await pg.setInputFiles('#folderFile', disc);
await pg.waitForTimeout(4000);
console.log('disc:', await pg.evaluate(() => document.getElementById('discInfo')?.textContent));
writeFileSync(join(out, '_start.txt'), log.join('\n')); log = [];
const res = [];
for (const f of files) {
  const name = basename(f);
  try { await pg.setInputFiles('#ghostFile', f); } catch (e) { console.log('skip', f, String(e).slice(0,100)); continue; }
  const t0 = Date.now();
  await pg.waitForTimeout(14000);
  await pg.screenshot({ path: join(out, name + '_a.png') });
  await pg.evaluate(() => { const p = document.getElementById('play'); if (p && /play|▶/i.test(p.textContent || p.title || '')) p.click(); });
  await pg.waitForTimeout(6000);
  await pg.screenshot({ path: join(out, name + '_b.png') });
  const st = await pg.evaluate(() => ({ mir: JSON.stringify(globalThis.__smsMirror), notice: document.getElementById('notice')?.textContent?.slice(0, 200), info: document.getElementById('replayInfo')?.textContent?.slice(0, 200), scrub: document.getElementById('scrub')?.value, list: document.getElementById('ghostList')?.innerText?.slice(0, 200) }));
  res.push({ name, errors: log, st });
  console.log(name, JSON.stringify(st), log.length + ' msgs');
  for (const l of log.slice(0, 6)) console.log('   ', l);
  log = [];
  // remove ghosts for the next file
  await pg.evaluate(() => { document.querySelectorAll('#ghostList button').forEach(b => { if (/remove|✕|×/i.test(b.textContent + (b.title || ''))) b.click(); }); });
  await pg.waitForTimeout(500);
}
writeFileSync(join(out, 'results.json'), JSON.stringify(res, null, 1));
await b.close(); srv.close();
