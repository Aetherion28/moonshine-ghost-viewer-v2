import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
for (const f of process.argv.slice(2)) { const B = readFileSync(f); try { const g: any = parseMstrGhost(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), 'x'); if (g.header.runFlags & 32) console.log(f.split('/').slice(-2).join('/'), 'flags', g.header.runFlags, (g.header.tasReasons || []).join(',')); } catch (e) { console.log(f, 'ERR', String(e).slice(0, 80)); } }
