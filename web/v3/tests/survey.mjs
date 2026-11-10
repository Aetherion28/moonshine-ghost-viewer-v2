// v3: plays many traces (one process each) and prints a line per trace: how far it matched and what stopped it.
// Run: node v3/tests/survey.mjs <replay bundle> <list file (trace paths, one a line)> [workers] [seconds a trace] > survey.tsv
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const [bundle, listFile, workersArg, wallArg] = process.argv.slice(2);
const list = readFileSync(listFile, 'utf8').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
const workers = +(workersArg || 2), wall = +(wallArg || 300);
let next = 0, running = 0;
const one = (trace) => new Promise((resolve) => {
    let out = '';
    const p = spawn('node', [bundle, trace, '200000'], { env: { ...process.env, QUIET: '1', WALL: String(wall), FSTPAD: process.env.FSTPAD || '480' } });
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', () => {
        const lines = out.split('\n');
        const sum = lines.find((l) => /^(done|budget|time|error): /.test(l)) || '', scene = (lines.find((l) => l.startsWith('scene ')) || '').slice(6) || '?';
        const issue = lines.find((l) => /^\[(?!heap)\w+\] /.test(l)) || lines.find((l) => l.startsWith('STOP')) || lines.find((l) => /trace ended|this trace|only GMSJ01/.test(l)) || '';
        const m = /^(\w+): (\d+) of (\d+) frames, (\d+) of (\d+) movement ticks/.exec(sum);
        console.log([trace, scene, m ? m[1] : 'crash', m ? `${m[2]}/${m[3]}` : '', m ? `${m[4]}/${m[5]}` : '', issue.slice(0, 260)].join('\t'));
        resolve();
    });
});
await new Promise((done) => {
    const pump = () => {
        while (running < workers && next < list.length) { running++; one(list[next++]).then(() => { running--; pump(); }); }
        if (!running && next >= list.length) done();
    };
    pump();
});
