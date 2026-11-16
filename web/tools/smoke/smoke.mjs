// smoke sweep of the viewer: a disc (folder or image file), then each recording; collects page errors, console errors, screenshots
import { createRequire } from 'node:module';
const pw = createRequire('/opt/npm-tools/node_modules/')('playwright');
// BROWSER=firefox|webkit runs the sweep there (Playwright's builds: `npx playwright install firefox webkit`;
// Firefox needs a display for WebGL: xvfb-run -a with LIBGL_ALWAYS_SOFTWARE=1)
const BROWSER = process.env.BROWSER || 'chromium';
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, basename } from 'node:path';
const [site, disc, out, ...files] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.map': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png' };
const srv = http.createServer((q, s) => { let p = join(site, decodeURIComponent(q.url.split('?')[0])); if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html'); if (!existsSync(p)) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }); s.end(readFileSync(p)); });
await new Promise((r) => srv.listen(0, r));
const url = `http://127.0.0.1:${srv.address().port}/index.html`;
// MEM=1: after each recording, the JS heap after a garbage collection and the browser's biggest
// processes' memory (to spot leaks across stage loads)
const MEM = !!process.env.MEM;
const b = await pw[BROWSER].launch(BROWSER === 'chromium' ? { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } : BROWSER === 'firefox' ? { firefoxUserPrefs: { 'webgl.force-enabled': true } } : {});
const pg = await b.newPage({ viewport: { width: 1280, height: 800 } });
let log = [];
pg.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || /\[mirror\]/.test(m.text())) log.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
pg.on('pageerror', (e) => log.push('[pageerror] ' + String(e.stack || e).slice(0, 500)));
await pg.goto(url); if (process.env.MIRCLEAR) await pg.evaluate(() => { globalThis.__mirClear = 1; }); if (process.env.NOMIR) await pg.evaluate(() => { globalThis.__noMirror = 1; });
await pg.waitForTimeout(1500);
// the disc: an extracted folder, or an image file (.iso, .rvz, ...) picked as a visitor would
const discFile = statSync(disc).isFile();
await pg.setInputFiles(discFile ? '#isoFile' : '#folderFile', disc);
await pg.waitForTimeout(discFile ? 8000 : 4000);
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
  if (MEM && BROWSER === 'chromium') {
    const cdp = await pg.context().newCDPSession(pg);
    await cdp.send('HeapProfiler.collectGarbage');
    st.heapMB = Math.round((await cdp.send('Runtime.getHeapUsage')).usedSize / 1048576);
    await cdp.detach();
    // the biggest browser processes' resident memory (the renderer, the GPU process)
    st.rssMB = (await import('node:child_process')).execSync("ps -eo rss,comm --sort=-rss | grep -m2 chrome").toString().trim().split('\n').map((l) => Math.round(+l.trim().split(/\s+/)[0] / 1024)).join('/');
  }
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
