import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
const B = readFileSync(process.argv[2]); const g: any = parseMstrGhost(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), 'x');
const q0 = g.segments[0].startQf;
console.log('header', JSON.stringify({ flags: g.header.flags, runFlags: g.header.runFlags, fromLoad: g.header.fromLoad }));
for (const s of g.segments) console.log('seg', s.startQf - q0, s.endQf - q0, JSON.stringify(s.route));
console.log(Object.keys(g.trace || {}).join(','));
