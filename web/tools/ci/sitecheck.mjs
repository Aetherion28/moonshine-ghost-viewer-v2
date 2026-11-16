// site/ must be what `node build.mjs` makes from the committed sources: a stale site/ is a stale
// website. Builds in place (run from web/ in a clean checkout), then compares with git, ignoring the
// build stamp (build.txt, and the ?v= stamps and BUILD_STAMP in index.html).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const web = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), root = resolve(web, '..');
execFileSync(process.execPath, ['build.mjs'], { cwd: web, stdio: 'inherit' });
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
const stamp = (s) => s.replace(/\b1\d{12}\b/g, 'STAMP');
const bad = [];
for (const l of git('status', '--porcelain', '--untracked-files=all', '--', 'site').split('\n').filter(Boolean)) {
    const p = l.slice(3);
    if (p === 'site/build.txt') continue;
    if (p === 'site/index.html' && l[1] === 'M' && stamp(git('show', 'HEAD:site/index.html')) === stamp(readFileSync(join(root, p), 'utf8'))) continue;
    bad.push(l);
}
if (bad.length) {
    console.log('site/ differs from a fresh build of the sources:\n' + bad.map((l) => '  ' + l).join('\n'));
    console.log('\nRun node build.mjs in web/ and commit site/ with the change.');
    process.exit(1);
}
console.log('site/ matches a fresh build');
