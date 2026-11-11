// v3: plays many traces (one process each) and prints a line per trace: how far it matched, what stopped it
// and what else differed.
// Run: node v3/tests/survey.mjs <replay bundle> <list file (trace paths, one a line)> [workers] [seconds a trace] > survey.tsv
// (env: LOGDIR=dir keeps each trace's whole output there)
// Columns: trace, scene, result, frames, ticks, issues, first issue, the other kinds of difference (an actor's as class+offset).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const [bundle, listFile, workersArg, wallArg] = process.argv.slice(2);
const list = readFileSync(listFile, 'utf8').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
const workers = +(workersArg || 2), wall = +(wallArg || 300), logDir = process.env.LOGDIR;
if (logDir) mkdirSync(logDir, { recursive: true });
let next = 0, running = 0;
const one = (trace) => new Promise((resolve) => {
    let out = '';
    const p = spawn('node', [bundle, trace, '200000'], { env: { ...process.env, QUIET: '1', WALL: String(wall), FSTPAD: process.env.FSTPAD || '480' } });
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', () => {
        if (logDir) writeFileSync(`${logDir}/${trace.replace(/[\/\\]/g, '_')}.log`, out);
        const lines = out.split('\n');
        const sum = lines.find((l) => /^(done|budget|time|error): /.test(l)) || '', scene = (lines.find((l) => l.startsWith('scene ')) || '').slice(6) || '?';
        // the run that counts is the last boot, unless that one went no further and the one before was kept
        const boots = [[]];
        for (const l of lines) { if (l.startsWith('... booting again')) boots.push([]); boots[boots.length - 1].push(l); }
        while (boots.length > 1 && boots[boots.length - 1].some((l) => l.includes('(no further: kept as it was)'))) boots.pop();
        const kept = boots[boots.length - 1];
        const issues = kept.filter((l) => /^\[(?!heap)\w+\] /.test(l));
        const issue = issues[0] || lines.find((l) => l.startsWith('STOP')) || lines.find((l) => /trace ended|this trace|only GMSJ01/.test(l)) || '';
        const kinds = new Set();
        for (const l of issues) {
            const k = /^\[(\w+)\]/.exec(l)[1], c = /\(class ([0-9a-f]+).*?differs at \+0x([0-9a-f]+)/.exec(l), d = /differs at \+0x([0-9a-f]+)/.exec(l);
            kinds.add(c ? `${k}:${c[1]}+${c[2]}` : d ? `${k}+${d[1]}` : k);
        }
        const m = /^(\w+): (\d+) of (\d+) frames, (\d+) of (\d+) movement ticks.*?(\d+) issue\(s\)/.exec(sum);
        console.log([trace, scene, m ? m[1] : 'crash', m ? `${m[2]}/${m[3]}` : '', m ? `${m[4]}/${m[5]}` : '', m ? m[6] : '', issue.slice(0, 260), [...kinds].slice(0, 24).join(' ')].join('\t'));
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
