import { readFileSync } from 'node:fs';
import { replayMstr } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
const B = readFileSync(process.argv[2]); const want = parseInt(process.argv[3], 16); const f = new Float32Array(1), u = new Uint32Array(f.buffer); const fl = (w: number) => { u[0] = w; return f[0]; }; let n = 0;
replayMstr(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), { onActor: (id: number, p: number, ext: number, w: number[]) => { if ((p >>> 0) === want && n++ < 3) console.log('ptr', p.toString(16), 'id', id, 'key', (w[2] >>> 16).toString(16), 'type', (w[0x4c / 4] >>> 0).toString(16), fl(w[4]), fl(w[5]), fl(w[6])); } });
