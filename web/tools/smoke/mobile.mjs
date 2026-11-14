import { createRequire } from 'node:module';
const { chromium, devices } = createRequire('/opt/npm-tools/node_modules/')('playwright');
import http from 'node:http'; import { readFileSync, existsSync, statSync } from 'node:fs'; import { extname, join } from 'node:path';
const [site, disc, file] = process.argv.slice(2);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
const srv = http.createServer((q, s) => { let p = join(site, decodeURIComponent(q.url.split('?')[0])); if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html'); if (!existsSync(p)) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }); s.end(readFileSync(p)); });
await new Promise((r) => srv.listen(0, r));
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ ...devices['iPhone 13'] });
const pg = await ctx.newPage();
pg.on('pageerror', (e) => console.log('[pe]', String(e).slice(0, 300)));
await pg.goto(`http://127.0.0.1:${srv.address().port}/index.html`); await pg.waitForTimeout(2000);
await pg.screenshot({ path: 'mob1.png' });
await pg.setInputFiles('#folderFile', disc); await pg.waitForTimeout(5000);
if (file) { await pg.setInputFiles('#ghostFile', file); await pg.waitForTimeout(15000); }
await pg.screenshot({ path: 'mob2.png' });
console.log(await pg.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })));
await pg.screenshot({ path: 'mob3.png', fullPage: true });
await b.close(); srv.close();
