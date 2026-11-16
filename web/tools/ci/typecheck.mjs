// The lenient type-check (DEVELOPMENT.md section 3), against a baseline of the errors known to be noise
// (mixins, noclip's stubs, DOM typing). A new error fails: it is usually a real bug (a name used but
// never imported, a duplicate import, a function passed where its result belongs).
//   node tools/ci/typecheck.mjs            check (run from web/)
//   node tools/ci/typecheck.mjs --update   take the current errors as the baseline (after checking each new one)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const web = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const baselinePath = join(web, 'tools/ci/tsc-baseline.txt');
const cfg = join(mkdtempSync(join(tmpdir(), 'tsc-')), 'tsconfig.json');
writeFileSync(cfg, JSON.stringify({
    compilerOptions: {
        target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2023', 'DOM', 'DOM.Iterable'],
        strict: false, noImplicitAny: false, noFallthroughCasesInSwitch: true, noEmit: true, skipLibCheck: true,
        isolatedModules: true, useDefineForClassFields: false, experimentalDecorators: true, esModuleInterop: true,
        resolveJsonModule: true, allowJs: false, types: [], typeRoots: [join(web, 'node_modules/@types'), join(web, 'node_modules/@webgpu')],
    },
    include: [join(web, 'src/**/*.ts'), join(web, 'node_modules/@webgpu/types/dist/index.d.ts')],
}));
let out = '';
try { out = execFileSync(join(web, 'node_modules/.bin/tsc'), ['-p', cfg], { cwd: web, encoding: 'utf8', maxBuffer: 1 << 26 }); }
catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
// "file(line,col): error TSnnnn: message", keyed without the line so edits elsewhere don't move it
const now = out.split('\n').map((l) => l.match(/^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/)).filter(Boolean).map((m) => `${m[1].replace(/\\/g, '/')}: ${m[2]}: ${m[3]}`).sort();
if (!now.length && !/error/.test(out) && out.trim()) console.log(out.trim());
if (process.argv.includes('--update')) {
    writeFileSync(baselinePath, now.join('\n') + '\n');
    console.log(`baseline: ${now.length} errors`);
    process.exit(0);
}
const base = existsSync(baselinePath) ? readFileSync(baselinePath, 'utf8').split('\n').filter(Boolean) : [];
const left = new Map();
for (const k of base) left.set(k, (left.get(k) || 0) + 1);
const fresh = [];
for (const k of now) { const n = left.get(k) || 0; if (n) left.set(k, n - 1); else fresh.push(k); }
const gone = [...left.values()].reduce((a, b) => a + b, 0);
console.log(`${now.length} type errors, ${now.length - fresh.length} of them known noise${gone ? `; ${gone} known ones are gone (run with --update)` : ''}`);
if (fresh.length) {
    console.log(`\n${fresh.length} new:\n` + fresh.map((k) => '  ' + k).join('\n'));
    console.log('\nFix them, or if one is noise, run node tools/ci/typecheck.mjs --update and commit tools/ci/tsc-baseline.txt.');
    process.exit(1);
}
