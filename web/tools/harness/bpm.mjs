// node bpm.mjs [entry.ts] [out.mjs]: bundle a harness script with the viewer's noclip stubs
import * as esbuild from '../../node_modules/esbuild/lib/main.js';
import path from 'node:path';
const here = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const STUB = { 'Studio.js': 'Studio.ts', 'DebugFloaters.js': 'DebugFloaters.ts', 'ui.js': 'ui.ts', 'SaveManager.js': 'SaveManager.ts' };
const stubs = { name: 'stubs', setup(b) { b.onResolve({ filter: /(Studio|DebugFloaters|ui|SaveManager)\.js$/ }, (a) => { const base = path.basename(a.path); if (!a.importer.includes('/noclip/') || !STUB[base]) return; return { path: path.join(here, 'stubs', STUB[base]) }; }); } };
const [entry = path.join(here, 'tools/harness/pm.ts'), out = '/tmp/gv/ct/pmr.mjs'] = process.argv.slice(2);
await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, plugins: [stubs], logLevel: 'error', define: { __WEB__: JSON.stringify(here) }, banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } });
