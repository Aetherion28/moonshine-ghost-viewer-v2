// v3: plays every trace of a folder on this computer's cores, each in a process of its own, and writes a line a
// trace (survey.tsv, the columns of tests/survey.mjs) and each trace's report. The bundle needs only Node, so it
// can run where the disc and the traces are (tools/batch/run-batch.bat starts it on Windows).
// Run: node v3batch.mjs <disc image or extracted folder> <folder of traces, or a file listing them> [out folder] [workers]
//   (workers: by default all of the computer's threads but two, and no more than its memory holds at 0.9 GB each;
//    WALL=seconds: the most a trace may take, 3600)
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { availableParallelism, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, join, resolve } from 'node:path';
import { openDisc } from '../web/discs.ts';
import { source } from './nodedisc.ts';
import { verify, type VerifyReport } from '../web/verify.ts';

const MARK = '@@report ';
if (process.argv[2] === '--one') {
    // one trace, in a process of its own: the report as a line of JSON
    const [disc, trace] = process.argv.slice(3);
    const tb = readFileSync(trace);
    const report = await verify(tb.buffer.slice(tb.byteOffset, tb.byteOffset + tb.byteLength) as ArrayBuffer, () => openDisc(source(disc)), { slice: 200e6, cancelled: () => false, breathe: async () => { }, progress: () => { } });
    console.log(MARK + JSON.stringify(report));
    process.exit(0);
}

const [disc, where, outArg, workersArg] = process.argv.slice(2);
if (!disc || !where) { console.log('node v3batch.mjs <disc image or extracted folder> <folder of traces, or a file listing them> [out folder] [workers]'); process.exit(2); }
const out = resolve(outArg || 'v3batch-results'), wall = +(process.env.WALL || 3600) * 1000;
// (a replay takes about 0.7 GB: no more at a time than fit in 60 % of the memory)
const workers = Math.max(1, +(workersArg || 0) || Math.min(availableParallelism() - 2, Math.floor(totalmem() * 0.6 / 0.9e9)));
const traces: string[] = [];
const walk = (dir: string) => { for (const n of readdirSync(dir).sort()) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p); else if (/\.msgt$/i.test(n)) traces.push(p); } };
if (statSync(where).isDirectory()) walk(where);
else for (const l of readFileSync(where, 'utf8').split(/\r?\n/)) { const t = l.trim(); if (t && existsSync(t)) traces.push(t); }
mkdirSync(join(out, 'reports'), { recursive: true });
const tsv = join(out, 'survey.tsv'), self = fileURLToPath(import.meta.url), t0 = Date.now();
writeFileSync(tsv, '');
console.log(`${traces.length} traces, ${workers} at a time; results in ${out}`);

let next = 0, running = 0, finished = 0, clean = 0, off = 0, skipped = 0, frames = 0, totalFrames = 0;
const one = (trace: string) => new Promise<void>((done) => {
    let text = '';
    const p = spawn(process.execPath, [self, '--one', disc, trace], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => p.kill(), wall);
    p.stdout.on('data', (d) => { text += d; }); p.stderr.on('data', (d) => { text += d; });
    p.on('close', (code) => {
        clearTimeout(timer);
        const line = text.split('\n').find((l) => l.startsWith(MARK)), name = basename(trace);
        let row: string[];
        if (!line) { row = [trace, '?', code === null ? 'time' : 'crash', '', '', '', text.trim().split('\n').slice(-1)[0] || '', '']; off++; }
        else {
            const r = JSON.parse(line.slice(MARK.length)) as VerifyReport;
            writeFileSync(join(out, 'reports', name + '.json'), JSON.stringify(r, null, 1));
            const kinds = [...new Set(r.issues.map((i) => i.kind))].join(' '), first = r.issues[0];
            row = [trace, `${r.area},${r.episode} ${r.stageName}${r.shinyShines ? ' (Shiny Shines)' : ''}`, r.result, `${r.frames}/${r.totalFrames}`, `${r.ticks}/${r.totalTicks}`, String(r.issues.length),
                first ? `[${first.kind}] frame ${first.frame} tick ${first.tick}: ${first.text.split('\n')[0]}`.slice(0, 260) : r.result === 'done' ? '' : r.summary.slice(0, 260), kinds];
            if (r.result === 'unsupported') skipped++;
            else { frames += r.frames; totalFrames += r.totalFrames; if (r.inStep) clean++; else off++; }
        }
        appendFileSync(tsv, row.join('\t') + '\n');
        finished++;
        console.log(`${String(finished).padStart(3)}/${traces.length} ${((Date.now() - t0) / 60000).toFixed(1)} min  ${name}: ${row[2]} ${row[3]}${row[5] && row[5] !== '0' ? `, ${row[5]} issue(s)` : ''}`);
        done();
    });
});
await new Promise<void>((done) => {
    const pump = () => {
        while (running < workers && next < traces.length) { running++; one(traces[next++]).then(() => { running--; pump(); }); }
        if (!running && next >= traces.length) done();
    };
    pump();
});
const summary = `${clean} of ${clean + off} recordings replay to their end with nothing off (${skipped} not for this game version or from an older recorder); ${frames} of ${totalFrames} frames in step; ${((Date.now() - t0) / 60000).toFixed(1)} minutes on ${workers} threads`;
writeFileSync(join(out, 'summary.txt'), summary + '\n');
console.log(summary);
