// Builds the MSGT viewer's page: index.html, app.js (the page) and worker.js (the game's code against a recording).
// node v3/page/build.mjs <out folder>     (from web/)
// The output is the whole site: minified, with no source maps and no comments.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.resolve(process.argv[2] || path.join(here, 'dist'));
fs.mkdirSync(out, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const common = { bundle: true, minify: true, format: 'iife', target: 'es2022', legalComments: 'none', sourcemap: false, logLevel: 'warning' };
await esbuild.build({ ...common, entryPoints: [path.join(here, 'app.ts')], outfile: path.join(out, 'app.js'), define: { __BUILD__: JSON.stringify(stamp) } });
await esbuild.build({ ...common, entryPoints: [path.join(here, '../web/worker.ts')], outfile: path.join(out, 'worker.js') });
fs.writeFileSync(path.join(out, 'index.html'), fs.readFileSync(path.join(here, 'index.html'), 'utf8').replace('src="app.js"', `src="app.js?v=${stamp}"`));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
for (const f of ['index.html', 'app.js', 'worker.js']) console.log(`${f}  ${fs.statSync(path.join(out, f)).size} bytes`);
