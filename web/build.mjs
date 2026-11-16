// Builds the v2 viewer into ../site: the page (viewer.html, the v1 viewer with the game layer
// hooked in), the v1 scripts it uses (legacy/), and the game layer (src/layer.ts) as game.js.
// node build.mjs [--watch] [--dev]
import * as esbuild from 'esbuild';
import path from 'node:path';
import crypto from 'node:crypto';

const here = path.dirname(new URL(import.meta.url).pathname);
// noclip modules this viewer doesn't use, replaced by small stubs.
const STUB = { 'Studio.js': 'Studio.ts', 'DebugFloaters.js': 'DebugFloaters.ts', 'ui.js': 'ui.ts', 'SaveManager.js': 'SaveManager.ts' };
const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /(Studio|DebugFloaters|ui|SaveManager)\.js$/ }, (a) => {
      const base = path.basename(a.path);
      if (!a.importer.includes(`${path.sep}noclip${path.sep}`) || !STUB[base]) return;
      return { path: path.join(here, 'stubs', STUB[base]) };
    });
  },
};
// a hash of the converters' source (src/v1data): the key of their output kept in the browser (v1data/store.ts)
function v1dataVersion() {
  const h = crypto.createHash('sha1'), dir = path.join(here, 'src/v1data');
  const walk = (d) => { for (const f of fs.readdirSync(d).sort()) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else { h.update(f); h.update(fs.readFileSync(p)); } } };
  walk(dir); h.update(fs.readFileSync(path.join(here, 'src/game/engine.ts')));   // (v1data/objparts.ts uses its calcKeyCode)
  return h.digest('hex').slice(0, 12);
}
const opts = {
  entryPoints: [path.join(here, 'src/layer.ts')], bundle: true, format: 'iife', target: 'es2022',
  outfile: path.join(here, '../site/game.js'), sourcemap: true, minify: !process.argv.includes('--dev'),
  plugins: [stubs], keepNames: true, logLevel: 'warning', metafile: true, define: { 'process.env.NODE_ENV': '"production"', V1DATA_VERSION: JSON.stringify(v1dataVersion()) },
};
import fs from 'node:fs';
// (each build stamps its scripts' URLs, so a reload gets this build's scripts past the page cache; build.txt names it)
const stamp = String(Date.now());
fs.writeFileSync(path.join(here, '../site/index.html'), fs.readFileSync(path.join(here, 'viewer.html'), 'utf8').replace(/\.js"><\\\/script>'\);/g, `.js?v=${stamp}"><\\/script>');`).replace("const BUILD_STAMP = '';", `const BUILD_STAMP = '${stamp}';`));
fs.writeFileSync(path.join(here, '../site/build.txt'), stamp);
for (const f of fs.readdirSync(path.join(here, 'legacy'))) fs.copyFileSync(path.join(here, 'legacy', f), path.join(here, '../site', f));
// three.js r128 and the fonts, served from the site itself (vendor/: each with its licence)
fs.rmSync(path.join(here, '../site/vendor'), { recursive: true, force: true });
fs.cpSync(path.join(here, 'vendor'), path.join(here, '../site/vendor'), { recursive: true });
// the licences of the code bundled into game.js / hud.js / audio.js (the legal page links them)
fs.mkdirSync(path.join(here, '../site/vendor/licenses'), { recursive: true });
fs.copyFileSync(path.join(here, 'noclip/LICENSE'), path.join(here, '../site/vendor/licenses/noclip.txt'));
fs.copyFileSync(path.join(here, 'node_modules/gl-matrix/LICENSE.md'), path.join(here, '../site/vendor/licenses/gl-matrix.txt'));
fs.copyFileSync(path.join(here, 'node_modules/fzstd/LICENSE'), path.join(here, '../site/vendor/licenses/fzstd.txt'));
// the viewer's own licence (GPL-3.0-or-later), linked from the legal page
fs.copyFileSync(path.join(here, '../LICENSE'), path.join(here, '../site/LICENSE.txt'));
// the game audio: the page side (audio.js) and its worklet (audio-worklet.js); the HUD (hud.js)
const audio = [
  { ...opts, entryPoints: [path.join(here, 'src/audio/index.ts')], outfile: path.join(here, '../site/audio.js'), metafile: false },
  { ...opts, entryPoints: [path.join(here, 'src/audio/worklet.ts')], outfile: path.join(here, '../site/audio-worklet.js'), format: 'esm', metafile: false },
  // the game's HUD (hud.js)
  { ...opts, entryPoints: [path.join(here, 'src/hud/index.ts')], outfile: path.join(here, '../site/hud.js'), metafile: false },
];
// the service worker (sw.js): the site's files to keep for offline use, and a version that changes
// when any of them does (not with the build stamp, so an unchanged site builds the same sw.js)
function writeServiceWorker() {
  const site = path.join(here, '../site');
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d).sort()) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else files.push(path.relative(site, p).split(path.sep).join('/')); } };
  walk(site);
  const keep = files.filter((f) => !/\.map$/.test(f) && !['build.txt', 'sw.js', '.nojekyll'].includes(f));
  const h = crypto.createHash('sha1');
  for (const f of keep) { h.update(f); h.update(f === 'index.html' ? fs.readFileSync(path.join(here, 'viewer.html')) : fs.readFileSync(path.join(site, f))); }
  const list = ['./', ...keep];
  fs.writeFileSync(path.join(site, 'sw.js'), fs.readFileSync(path.join(here, 'sw.template.js'), 'utf8').replace('__VERSION__', h.digest('hex').slice(0, 12)).replace('__FILES__', JSON.stringify(list, null, 1)));
}
if (process.argv.includes('--watch')) { await (await esbuild.context(opts)).watch(); for (const a of audio) await (await esbuild.context(a)).watch(); }
else {
  const r = await esbuild.build(opts);
  for (const a of audio) await esbuild.build(a);
  if (process.argv.includes('--meta')) fs.writeFileSync(path.join(here, 'meta.json'), JSON.stringify(r.metafile));
  writeServiceWorker();
}
