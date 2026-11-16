import { arc } from './files.ts';
const a = arc('/tmp/gv/extract/data/scene/' + process.argv[2] + '.szs');
for (const [k, v] of a.files) if (k.endsWith(process.argv[3])) { const s = Buffer.from(v).toString('latin1'); const m = s.match(/[\x20-\x7e]{4,}/g); console.log(k, v.length, (m || []).join(' | ')); }
