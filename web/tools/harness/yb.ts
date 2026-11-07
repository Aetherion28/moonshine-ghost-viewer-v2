import { readFileSync } from 'node:fs';
import { replayMstr, marioView } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstr.ts';
const B = readFileSync(process.argv[2]); const lo = +process.argv[3], hi = +process.argv[4];
replayMstr(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), { onTick: (s: any) => {
  if (s.tick < lo || s.tick > hi || !s.yoshi) return; const d = new DataView(s.yoshi.data.buffer, s.yoshi.data.byteOffset, s.yoshi.data.byteLength);
  const f = (o: number) => o + 4 <= d.byteLength ? d.getFloat32(o).toFixed(4) : '-';
  console.log(s.frame, s.tick, 'len', d.byteLength, 'state', d.getUint8(0), 'fc start', d.getInt16(0x62), 'end', d.getInt16(0x64), 'rate', f(0x68), 'frame', f(0x6C), 'type', d.getUint8(0xD0), 'unk2C', f(0x2C), 'unkE4', f(0xE4));
} } as any);
