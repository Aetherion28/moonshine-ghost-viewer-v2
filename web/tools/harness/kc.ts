import { calcKeyCode } from '../../src/game/engine.ts';
for (const n of process.argv.slice(2)) console.log(n, calcKeyCode(n).toString(16));
