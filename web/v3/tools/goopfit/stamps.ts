// The goop stamps' textures (common.szs: map/pollute.bti, map/clean.bti) as text, for pixel.py.
// Run (from web/): node tools/harness/bpm.mjs v3/tools/goopfit/stamps.ts /tmp/claude-0/ct/x/stamps.mjs && node /tmp/claude-0/ct/x/stamps.mjs > $GOOPFIT/sim/bti_dump.txt
import { arc } from '../../../tools/harness/files.ts';
const c = arc(process.env.COMMON_SZS || '/mnt/user-data/uploads/Games/_ghostviewer_extract/data/common.szs');
for (const n of ['map/pollute.bti', 'map/clean.bti']) {
const b = c.files.get(n)!; const o = 32, w = 64;
const at = (x: number, y: number) => b[o + ((y >> 2) * (w >> 3) + (x >> 3)) * 32 + (y & 3) * 8 + (x & 7)];
console.log(n);
for (let y = 0; y < 64; y++) { let s = String(y).padStart(2) + ' '; for (let x = 0; x < 64; x++) s += at(x, y).toString(16).padStart(2, '0'); console.log(s); }
}
