// The page's own script (viewer.html's inline <script>s and legacy/*.js) is in no bundle, so nothing
// else checks it: a name used but never defined there is a ReferenceError only when that line runs.
// This type-checks it as loose JavaScript and fails on any undefined name that isn't one of the
// globals the other scripts provide (the list below).   node tools/ci/pagescript.mjs   (from web/)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const web = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// three.js; the bundles (game.js, hud.js, audio.js); legacy/ghost.js, gesso.js; the data V1Data.globals() sets
const PROVIDED = new Set(['THREE', 'GameDisc', 'GameHud', 'GameAudio', 'GameLayer', 'V1Data', 'GessoSim', 'V2',
    'parseSmsGhost', 'ghostFormatTime', 'ghostRouteLabel', 'ghostYoshiAt', 'ghostCameraAt', 'ghostRngRolls', 'FLUDD_NOZZLES',
    'JPA_RES', 'WATER_TEX', 'SHINE_BCK', 'CAM_BCK', 'SG_LETTERS']);
const dir = mkdtempSync(join(tmpdir(), 'pagescript-'));
const html = readFileSync(join(web, 'viewer.html'), 'utf8');
let n = 0;
for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    if (m[1].length < 200) continue;
    const line = html.slice(0, m.index + m[0].indexOf(m[1])).split('\n').length - 1;
    writeFileSync(join(dir, `viewer_html_${n++}.js`), '\n'.repeat(line) + m[1]);   // (padded: its lines are viewer.html's)
}
const legacy = readdirSync(join(web, 'legacy')).filter((f) => f.endsWith('.js') && f !== 'mp4-muxer.js').map((f) => join(web, 'legacy', f));
writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { allowJs: true, checkJs: true, noEmit: true, target: 'ES2022', lib: ['ES2023', 'DOM', 'DOM.Iterable'], strict: false, noImplicitAny: false, skipLibCheck: true, types: [] },
    include: [join(dir, '*.js'), ...legacy],
}));
let out = '';
try { out = execFileSync(join(web, 'node_modules/.bin/tsc'), ['-p', join(dir, 'tsconfig.json')], { encoding: 'utf8', maxBuffer: 1 << 26 }); }
catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
const bad = [];
for (const l of out.split('\n')) {
    const m = l.match(/^(.*?)\((\d+),\d+\): error TS(?:2304|2552): Cannot find name '([^']+)'/);
    if (m && !PROVIDED.has(m[3])) bad.push(`${m[1].replace(/^.*viewer_html_\d+\.js$/, 'viewer.html').replace(web + '/', '')}:${m[2]}: ${m[3]} is not defined`);
}
if (bad.length) { console.log(bad.join('\n')); console.log('\nDefine it, or add it to PROVIDED in tools/ci/pagescript.mjs if another script provides it.'); process.exit(1); }
console.log(`page script: ${n} inline scripts and ${legacy.length} legacy files, no undefined names`);
