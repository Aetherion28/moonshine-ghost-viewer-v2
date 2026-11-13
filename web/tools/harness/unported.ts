// unported <dir of unpacked scene arcs>: every scene.bin object type the sim has no class for, with its stages and a name
import { readFileSync, readdirSync } from 'fs';
import '../../src/game/runner.js';
import { CLASSES } from '../../src/game/scene.js';
import { parseSceneBin, SceneNode } from '../../src/game/engine.js';
const dir = process.argv[2];
const miss = new Map<string, { stages: Set<string>; name: string }>();
for (const f of readdirSync(dir).filter((x) => x.endsWith('.arc'))) {
    const d = readFileSync(dir + '/' + f);
    // scene.bin inside the RARC: find "scene.bin" file by its node data (the RARC's file table), simplest: scan for the root "MarScene"
    const k = d.indexOf(Buffer.from('MarScene'));
    if (k < 8) continue;
    // the object record starts 8 bytes before its type string (u32 size, u16 hash, u16 length)
    const start = k - 8;
    let root: SceneNode;
    try { root = parseSceneBin(new Uint8Array(d.buffer, d.byteOffset + start, d.length - start)); } catch { continue; }
    const walk = (n: SceneNode) => {
        if (n.children && n.children.length) { for (const c of n.children) walk(c); }
        if (!CLASSES.has(n.type) && !(n.children && n.children.length) && !['Mario', 'ObjChara', 'SmplChara'].includes(n.type)) {
            let m = miss.get(n.type); if (!m) { m = { stages: new Set(), name: n.name }; miss.set(n.type, m); }
            m.stages.add(f.replace('.szs.arc', ''));
        }
    };
    walk(root);
}
for (const [t, m] of [...miss].sort((a, b) => b[1].stages.size - a[1].stages.size)) console.log(t, m.stages.size, m.name, [...m.stages].slice(0, 4).join(','));
