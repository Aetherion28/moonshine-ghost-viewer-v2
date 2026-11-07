import { readFileSync } from 'node:fs';
import { parseMstrGhost } from '/home/claude/moonshine-ghost-viewer-v2/web/src/ghost/mstrghost.ts';
import { traceStageCarry } from '/home/claude/moonshine-ghost-viewer-v2/web/src/game/runner.ts';
const B = readFileSync(process.argv[2]); const g: any = parseMstrGhost(B.buffer.slice(B.byteOffset, B.byteOffset + B.length), 'x');
const c = traceStageCarry(g, 0); if (!c) { console.log('none'); process.exit(0); }
for (const id of process.argv.slice(3)) console.log(id, c.flags.getFlag(parseInt(id)));
