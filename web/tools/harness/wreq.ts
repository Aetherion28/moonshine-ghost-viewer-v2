import { readFileSync } from 'node:fs';
import { readMstr } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const buf = B.buffer.slice(B.byteOffset, B.byteOffset + B.length);
const g: any = parseMstrGhost(buf, 'x'); const q0 = g.segments[0].startQf; const a = +process.argv[3], b = +process.argv[4];
// tick -> world qf as mstrghost does: track frames
let worldTick = 0, frameTick: number | null = null;
readMstr(buf, (r: any) => {
  if (r.kind === 2) { if (frameTick === null) worldTick = r.tick; else worldTick += 4; frameTick = r.tick; return; }
  if (r.kind !== 16) return;
  const qf = (frameTick === null ? r.tick : worldTick + (r.tick - frameTick)) - 1 - q0;
  if (qf < a || qf > b) return;
  const dv = new DataView(r.body.buffer, r.body.byteOffset + 8, r.body.byteLength - 8), f = (o: number) => dv.getFloat32(o).toFixed(3);
  const acc = new DataView(r.body.buffer, r.body.byteOffset).getUint32(0);
  console.log('REC', qf, 'src', new DataView(r.body.buffer, r.body.byteOffset).getUint32(4).toString(16), 'acc', acc, 'num', dv.getInt32(0x18), 'pos', [f(0x70), f(0x74), f(0x78)].join(','), 'v', [f(0x8C), f(0x90), f(0x94)].join(','), 'dir', [f(0x54), f(0x58), f(0x5C)].join(','), 'pow', f(0xBC), 'size', f(0xE4), 'type', dv.getInt16(0x148), 'X alive', dv.getInt16(0x2C), 'atk', dv.getInt16(0x40), 'dirT', f(0xA8), 'powT', f(0xD0), 'sizeT', f(0xF8), 'flag', dv.getInt32(0x134).toString(16));
});
