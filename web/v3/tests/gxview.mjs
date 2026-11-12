// The page's GPU (v3/page/gx) in a real browser: feeds it dumped frames of the game's GPU commands, in order, in
// headless Chromium, and saves the canvas as PNGs.
// Run (from web/): node v3/tests/gxview.mjs <folder of dumped frames> <screenshot folder> [frame indices, comma separated]
//   The frames are f_000000.gxf, f_000001.gxf, ... (web/gxframe.ts's encodeGxFrame); every one is fed, since each
//   builds on the ones before. Without indices the last frame is saved.
//   Frames after the last one asked for are not fed (ALL=1 feeds them, for timing).
//   SCALE=2 draws at twice the console's size; QUIET=1 prints only the saved frames and the summary; COPIES=1 lists
//   each saved frame's frame buffer copies; COPYSHOTS=1 saves the copies' textures too (colour, then alpha).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import * as esbuild from 'esbuild';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const [frames, shots, which] = process.argv.slice(2);
if (!frames || !shots) { console.log('node v3/tests/gxview.mjs <folder of dumped frames> <screenshot folder> [frame indices]'); process.exit(1); }
const here = path.dirname(new URL(import.meta.url).pathname), web = path.join(here, '../..');
const names = readdirSync(frames).filter((n) => /^f_\d+\.gxf$/.test(n)).sort();
if (!names.length) { console.log('no frames (f_000000.gxf, ...) in ' + frames); process.exit(1); }
const want = new Set(which ? which.split(',').map(Number) : [names.length - 1]);
mkdirSync(shots, { recursive: true });

// the page's script: the entry bundled, with the noclip modules this project doesn't use replaced by its stubs (as build.mjs does)
const STUB = { 'Studio.js': 'Studio.ts', 'DebugFloaters.js': 'DebugFloaters.ts', 'ui.js': 'ui.ts', 'SaveManager.js': 'SaveManager.ts' };
const stubs = {
    name: 'stubs',
    setup(b) {
        b.onResolve({ filter: /(Studio|DebugFloaters|ui|SaveManager)\.js$/ }, (a) => {
            const base = path.basename(a.path);
            if (!a.importer.includes(`${path.sep}noclip${path.sep}`) || !STUB[base]) return;
            return { path: path.join(web, 'stubs', STUB[base]) };
        });
    },
};
const tmp = mkdtempSync(path.join(os.tmpdir(), 'gxview-'));
await esbuild.build({ entryPoints: [path.join(here, 'gxview_page.ts')], bundle: true, format: 'iife', target: 'es2022', outfile: path.join(tmp, 'page.js'), plugins: [stubs], logLevel: 'warning', sourcemap: 'inline' });
const script = readFileSync(path.join(tmp, 'page.js'));
rmSync(tmp, { recursive: true, force: true });
const html = '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#222"><canvas id="gx"></canvas><script src="/page.js"></script>';

const srv = http.createServer((q, s) => {
    const url = decodeURIComponent(q.url.split('?')[0]);
    if (url === '/') { s.writeHead(200, { 'content-type': 'text/html' }); s.end(html); return; }
    if (url === '/page.js') { s.writeHead(200, { 'content-type': 'text/javascript' }); s.end(script); return; }
    const m = /^\/frames\/(f_\d+\.gxf)$/.exec(url), p = m && path.join(frames, m[1]);
    if (!p || !existsSync(p)) { s.writeHead(404); s.end(); return; }
    s.writeHead(200, { 'content-type': 'application/octet-stream' }); s.end(readFileSync(p));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const pg = await browser.newPage({ viewport: { width: 1320, height: 1100 } });
const quiet = !!process.env.QUIET;
let errors = 0;
pg.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warning') { errors++; if (errors <= 40) console.log(`[page ${t}]`, m.text().slice(0, 600)); } });
pg.on('pageerror', (e) => { errors++; console.log('[pageerror]', String(e.stack || e).slice(0, 800)); });
await pg.goto(`http://127.0.0.1:${srv.address().port}/`);
await pg.evaluate((scale) => window.gxview.start(scale), Number(process.env.SCALE || 1));

const FORMATS = ['R4', 'R8', 'RA4', 'RA8', 'RGB565', 'RGB5A3', 'RGBA8', 'A8', 'R8', 'G8', 'B8', 'RG8', 'GB8'];
const times = [], js = [];
const count = process.env.ALL ? names.length : Math.min(names.length, Math.max(...want) + 1);
for (let i = 0; i < count; i++) {
    const st = await pg.evaluate((n) => window.gxview.feed(n), names[i]);
    if (!st) { console.log('frame ' + names[i] + ' could not be read'); break; }
    times.push(st.total); js.push(st.ms);
    if (!quiet || want.has(i)) console.log(`${names[i]}  frame ${st.frame}  ${st.fifo} bytes of commands, ${st.patches} patches (${st.patchBytes} bytes)  ${st.draws} draws (${st.decodedKept} lists and ${st.decodedStream} stream runs decoded, ${st.vertices} vertices)  ${st.programs} programs, ${st.textures} textures made  ${st.copies.length} copies  ${st.lines ? st.lines + ' lines/points skipped  ' : ''}${st.failed ? st.failed + ' not drawable  ' : ''}${st.ms.toFixed(1)} ms to send, ${st.total.toFixed(1)} ms drawn`);
    if (want.has(i)) {
        const png = await pg.evaluate(() => window.gxview.shot());
        const out = path.join(shots, names[i].replace('.gxf', '.png'));
        writeFileSync(out, Buffer.from(png.split(',')[1], 'base64'));
        console.log('  saved ' + out);
        if (process.env.COPYSHOTS) for (const c of await pg.evaluate(() => window.gxview.copies())) writeFileSync(out.replace('.png', `_copy_${c.addr.toString(16)}.png`), Buffer.from(c.png.split(',')[1], 'base64'));
        if (process.env.COPIES) for (const c of st.copies) console.log(`  copy ${c.x},${c.y} ${c.w}x${c.h}${c.half ? ' halved' : ''} ${c.depth ? 'depth ' : ''}${c.intensity && (c.format < 4 || c.format === 8) ? 'brightness ' : ''}${FORMATS[c.format] ?? c.format} -> 0x${c.dst.toString(16)}${c.clear ? ' (then cleared)' : ''}${c.kept ? '' : ' (RAM has it)'}`);
    }
}
if (times.length) {
    const sorted = times.slice(Math.min(10, times.length - 1)).sort((a, b) => a - b), sj = js.slice(Math.min(10, js.length - 1)).sort((a, b) => a - b);
    console.log(`${times.length} frames; after the first ten: median ${sj[sj.length >> 1].toFixed(1)} ms to send the frame's GL commands, ${sorted[sorted.length >> 1].toFixed(1)} ms until drawn (worst ${sorted[sorted.length - 1].toFixed(1)} ms); ${errors} page errors or warnings`);
}
await browser.close(); srv.close();
