import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const g: any = parseMstrGhost(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), 'x');
const f = g.trace.feedback; const fl = new Map<number, number>();
for (const t of g.trace.ticks) if (t.mario) fl.set(t.qf, t.mario.flag & 1);
const res: any = {};
const per = new Map<string, number>();
for (let i = 0; i < f.count; i++) { if (f.consumer[i] > 1) continue; const q = f.qf[i], v = f.value[i] ? 1 : 0; const k = q + ':' + f.consumer[i]; per.set(k, (per.get(k) || 0) + 1);
  for (const d of [-2, -1, 0, 1]) { const m = fl.get(q + d); if (m === undefined) continue; const key = 'c' + f.consumer[i] + ' d' + d; res[key] ??= [0, 0]; res[key][m === v ? 0 : 1]++; } }
console.log(JSON.stringify(res)); const cnt = new Map<number, number>(); for (const v of per.values()) cnt.set(v, (cnt.get(v) || 0) + 1); console.log('reads per tick', [...cnt]);
let ones = 0; for (let i = 0; i < f.count; i++) if (f.consumer[i] === 0 && f.value[i]) ones++; console.log('cam occluded reads', ones);
