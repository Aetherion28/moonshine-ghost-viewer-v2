import { readFileSync } from 'node:fs';
import { readMstr } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
const B = readFileSync(process.argv[2]); const buf = B.buffer.slice(B.byteOffset, B.byteOffset + B.length);
const X = +process.argv[3], Z = +process.argv[4], R = +process.argv[5];
readMstr(buf as ArrayBuffer, (r: any) => { if (r.kind !== 11 && r.kind !== 10) return; const d = new DataView(r.body.buffer, r.body.byteOffset, r.body.byteLength); const type = d.getUint32(0), caller = d.getUint32(4); const args = [0,1,2,3,4,5,6,7].map((i) => d.getUint32(8 + 4 * i)); const valid = d.getUint32(40); const p = [0,1,2].map((i) => d.getFloat32(44 + 4 * i)); if (!(valid & 1)) return; if (Math.hypot(p[0] - X, p[2] - Z) > R) return; console.log('frame', r.frame, 'tick', r.tick, 'kind', r.kind, 'type', type, 'caller', caller.toString(16), 'id', args[0].toString(16), 'pos', p.map((v) => v.toFixed(2)).join(',')); });
