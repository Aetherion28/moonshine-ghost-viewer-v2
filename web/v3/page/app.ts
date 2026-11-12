// The MSGT viewer's page: the user picks a disc and recordings, each recording is played in a worker
// (../web/worker.ts) and the page shows the game's state as it goes and the result.
import type { VerifyProgress, VerifyReport, VerifyIntro, LiveBatch } from '../web/worker.ts';
import type { GxFrame } from '../web/gxframe.ts';
import { GxRenderer } from './gx/renderer.ts';

type DiscSource = { iso: File } | { folder: { path: string; file: File }[] };
interface Sample { frame: number; tick: number; mario: Float32Array; camera: Float32Array; actors: Float32Array }
interface Job {
    id: number; file: File; state: 'queued' | 'running' | 'done';
    worker: Worker | null; progress: VerifyProgress | null; intro: VerifyIntro | null; report: VerifyReport | null;
    samples: Sample[]; attempt: number; cursor: number; follow: boolean; playing: boolean; playFrom: number; playAt: number;
    /** the GPU's frames so far (each builds on the ones before), their size, and whether the worker was asked for them */
    gx: GxFrame[]; gxBytes: number; gxAsked: boolean; gxFull: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
declare const __BUILD__: string;
const BUILD = __BUILD__;
const FPS = 30000 / 1001;

let disc: DiscSource | null = null;
const jobs: Job[] = [];
let selected: Job | null = null, nextId = 1, wanted = false, wide = false;

// ---------------------------------------------------------------- names
const AREAS: Record<string, string> = {
    airport: 'Delfino Airstrip', dolpic: 'Delfino Plaza', bianco: 'Bianco Hills', ricco: 'Ricco Harbor', mamma: 'Gelato Beach',
    pinnaBeach: 'Pinna Park beach', pinnaParco: 'Pinna Park', sirena: 'Sirena Beach', delfino: 'Hotel Delfino', casino: 'Casino Delfino',
    monte: 'Pianta Village', mare: 'Noki Bay', coro: 'Corona Mountain',
};
function stageLabel(name: string, area: number, episode: number): string {
    const m = /^([a-zA-Z]+?)(\d+)$/.exec(name);
    if (m && AREAS[m[1]]) return `${AREAS[m[1]]}, episode ${+m[2] + 1}`;
    const boss = /^([a-zA-Z]+?)Boss$/.exec(name);
    if (boss && AREAS[boss[1]]) return `${AREAS[boss[1]]}, boss`;
    return name || `Area ${area}, episode ${episode + 1}`;
}
const clock = (frames: number) => { const s = frames / FPS, m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`; };
const num = (v: number) => v.toLocaleString('en-US');

// ---------------------------------------------------------------- the disc
const IDS: Record<string, string> = { GMSJ01: 'Japanese', GMSE01: 'North American', GMSP01: 'PAL' };
async function setIso(file: File) {
    const h = new Uint8Array(await file.slice(0, 0x440).arrayBuffer()), v = new DataView(h.buffer);
    const info = $('discInfo'), hint = $('discHint');
    if (h.length < 0x440 || v.getUint32(0x1C) !== 0xC2339F3D) {
        disc = null;
        info.hidden = false; info.innerHTML = `<b>${esc(file.name)}</b><div class="sub">This isn't a plain GameCube disc image. In Dolphin, right-click the game, choose Convert File, and pick ISO.</div>`;
    } else {
        const id = String.fromCharCode(...h.subarray(0, 6));
        disc = { iso: file };
        info.hidden = false; info.innerHTML = `<b>${esc(file.name)}</b><div class="sub">${IDS[id] ? `${IDS[id]} version` : 'Not Super Mario Sunshine'} · ${esc(id)} revision ${h[7]} · ${(file.size / 2 ** 20).toFixed(0)} MB</div>`;
    }
    hint.hidden = true; refresh();
}
function setFolder(files: File[]) {
    const list = files.map((f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, file: f }));
    const hasDol = list.some((f) => /(^|\/)main\.dol$/i.test(f.path)), root = list.length ? list[0].path.split('/')[0] : '';
    const info = $('discInfo');
    disc = hasDol ? { folder: list } : null;
    info.hidden = false;
    info.innerHTML = `<b>${esc(root || 'Folder')}</b><div class="sub">${hasDol ? `${num(list.length)} files` : 'This folder has no sys/main.dol. Pick the folder that holds both "files" and "sys", as Dolphin extracts a whole disc.'}</div>`;
    $('discHint').hidden = true; refresh();
}

// ---------------------------------------------------------------- the recordings
function addTraces(files: File[]) {
    for (const file of files) {
        if (!/\.msgt$/i.test(file.name) || jobs.some((j) => j.file.name === file.name && j.file.size === file.size)) continue;
        jobs.push({ id: nextId++, file, state: 'queued', worker: null, progress: null, intro: null, report: null, samples: [], attempt: 0, cursor: 0, follow: true, playing: false, playFrom: 0, playAt: 0, gx: [], gxBytes: 0, gxAsked: false, gxFull: false });
    }
    if (!selected && jobs.length) selected = jobs[0];
    refresh();
}
function removeJob(job: Job) {
    if (job.worker) job.worker.terminate();
    jobs.splice(jobs.indexOf(job), 1);
    if (selected === job) selected = jobs[0] || null;
    refresh(); pump();
}

type Verdict = 'ok' | 'follow' | 'off' | 'skip';
function verdict(r: VerifyReport): Verdict {
    if (r.result === 'unsupported' || r.result === 'cancelled') return 'skip';
    if (r.result !== 'done') return 'off';
    if (r.inStep) return 'ok';
    return r.followed && !r.issues.length && r.frames >= r.totalFrames ? 'follow' : 'off';
}
function jobState(j: Job): [string, string] {
    if (j.state === 'queued') return ['', 'waiting'];
    if (j.state === 'running') {
        const p = j.progress;
        if (!p) return ['run', 'starting'];
        return ['run', p.frames ? `${Math.floor(100 * p.frames / Math.max(1, p.totalFrames))}%` : p.phase];
    }
    const r = j.report!, v = verdict(r);
    if (v === 'ok') return ['ok', 'in step'];
    if (v === 'follow') return ['follow', 'shown as recorded'];
    if (r.result === 'cancelled') return ['skip', 'stopped'];
    if (v === 'skip') return ['skip', "can't be played"];
    return ['off', r.issues.length ? `parts at frame ${r.issues[0].frame}` : 'stopped early'];
}

// ---------------------------------------------------------------- running
function startJob(job: Job) {
    job.state = 'running'; job.progress = null; job.report = null; job.intro = null; job.samples = []; job.attempt = 0; job.cursor = 0; job.follow = true; job.playing = false;
    job.gx = []; job.gxBytes = 0; job.gxFull = false;
    // (the GPU's frames are big: asked for the recording being watched, or for every one when they play one at a time)
    job.gxAsked = !!renderer && (job === selected || !selected || selected.state === 'done' || +($<HTMLSelectElement>('parallel').value) === 1);
    const w = job.worker = new Worker('worker.js?v=' + BUILD);
    const fail = (text: string) => {
        job.report = { result: 'error', inStep: false, followed: false, taken: {}, summary: text, stageName: '', area: 0, episode: 0, frames: 0, totalFrames: 0, ticks: 0, totalTicks: 0, marioChecked: 0, calls: 0, literals: 0, shimCalls: 0, padCorrections: 0, issues: [], unsupported: [], shinyShines: false, dolphin: false, fstPad: 0, disc: '', instructions: 0, seconds: 0, log: [] };
        finish();
    };
    const finish = () => { w.terminate(); job.worker = null; job.state = 'done'; refresh(); pump(); };
    w.onerror = (e) => fail(e.message || 'The replay could not start.');
    w.onmessage = (ev: MessageEvent) => {
        const m = ev.data as VerifyProgress | VerifyIntro | LiveBatch | GxFrame | { type: 'done'; report: VerifyReport };
        if (m.type === 'intro') job.intro = m;
        else if (m.type === 'live') {
            if (m.attempt !== job.attempt) { job.attempt = m.attempt; job.samples = []; job.cursor = 0; job.follow = true; }
            for (let k = 0; k < m.frames.length; k++) job.samples.push({ frame: m.frames[k], tick: m.ticks[k], mario: m.mario.subarray(k * 6, k * 6 + 6), camera: m.camera.subarray(k * 6, k * 6 + 6), actors: m.actors.subarray(m.actorAt[k], m.actorAt[k + 1]) });
        }
        else if (m.type === 'gxframe') {
            // (a frame with the registers starts over: the game was booted again)
            if (m.regs && job.gx.length) { job.gx = []; job.gxBytes = 0; job.gxFull = false; if (shown === job) shown = null; }
            if (job.gxFull) return;
            job.gx.push(m); job.gxBytes += m.fifo.length + m.patches.reduce((a, p) => a + p.data.length, 0);
            if (job.gxBytes > GX_BUDGET) job.gxFull = true;
        }
        else if (m.type === 'progress') { job.progress = m; refreshJobs(); }
        else if (m.type === 'done') { job.report = m.report; finish(); }
    };
    job.file.arrayBuffer().then((trace) => w.postMessage({ type: 'start', trace, disc, live: true, gx: job.gxAsked, slice: 16e6 }, [trace]), () => fail('The recording could not be read.'));
    refresh();
}
function pump() {
    if (!wanted || !disc) return;
    const limit = +($<HTMLSelectElement>('parallel').value) || 1;
    for (const j of jobs) {
        if (jobs.filter((x) => x.state === 'running').length >= limit) break;
        if (j.state === 'queued') { startJob(j); if (!selected || selected.state === 'done') selected = j; }
    }
    if (!jobs.some((j) => j.state !== 'done')) wanted = false;
    refresh();
}

// ---------------------------------------------------------------- the page
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
function refreshJobs() {
    const ul = $('jobs');
    while (ul.children.length > jobs.length) ul.lastChild!.remove();
    jobs.forEach((j, k) => {
        let li = ul.children[k] as HTMLLIElement | undefined;
        if (!li || +li.dataset.id! !== j.id) {
            li = document.createElement('li'); li.dataset.id = String(j.id);
            li.innerHTML = '<button class="job"><span class="dot"></span><span class="name"></span><span class="row" style="gap:8px;flex-wrap:nowrap"><span class="state"></span><span class="x" role="button" aria-label="Remove" title="Remove">×</span></span></button>';
            li.querySelector('.job')!.addEventListener('click', (e) => { if ((e.target as HTMLElement).classList.contains('x')) removeJob(j); else { selected = j; refresh(); } });
            if (ul.children[k]) ul.replaceChild(li, ul.children[k]); else ul.appendChild(li);
        }
        const [cls, text] = jobState(j), b = li.querySelector('.job') as HTMLElement;
        b.className = 'job ' + cls; b.setAttribute('aria-current', String(j === selected));
        (li.querySelector('.name') as HTMLElement).textContent = j.file.name.replace(/\.msgt$/i, '');
        (li.querySelector('.state') as HTMLElement).textContent = text;
    });
}
function refresh() {
    refreshJobs();
    const queued = jobs.some((j) => j.state === 'queued'), running = jobs.some((j) => j.state === 'running');
    $<HTMLButtonElement>('run').disabled = !disc || !(queued || jobs.some((j) => j.state === 'done')) || (running && !queued);
    $('run').textContent = !queued && jobs.length && !running ? 'Play again' : 'Play';
    $<HTMLButtonElement>('stop').disabled = !running;
    $('clearJobs').hidden = !jobs.length;
    $('runHint').textContent = !disc ? (jobs.length ? 'Choose a disc.' : 'Choose a disc and at least one recording.') : !jobs.length ? 'Add at least one recording.'
        : running ? `${jobs.filter((j) => j.state === 'done').length} of ${jobs.length} done.` : queued ? 'Ready.' : `${jobs.filter((j) => j.report && verdict(j.report) === 'ok').length} of ${jobs.length} in step to the end.`;
    $('empty').hidden = !!selected && selected.state !== 'queued'; $('live').hidden = !selected || selected.state === 'queued';
    showResult();
}

function cell(k: string, v: string) { return `<div class="cell"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`; }
function showResult() {
    const panel = $('resultPanel'), j = selected;
    if (!j || !j.report) { panel.hidden = true; return; }
    const r = j.report, v = verdict(r);
    const head = v === 'ok' ? 'In step to the end' : v === 'follow' ? 'Shown as recorded' : r.result === 'cancelled' ? 'Stopped' : v === 'skip' ? "This recording can't be played" : r.result === 'error' ? 'The replay stopped on an error' : 'The game and the recording part';
    const taken = Object.entries(r.taken || {}).filter(([k]) => k !== 'rand');
    let html = `<div class="verdict ${v}"><span class="mark">${v === 'ok' ? '✓' : v === 'follow' ? '≈' : v === 'skip' ? '–' : '!'}</span>${head}</div><p class="summary">${esc(r.summary)}</p>`;
    if (r.totalFrames) {
        html += '<div class="stats">' + cell('Frames', `${num(r.frames)} / ${num(r.totalFrames)}`) + cell('Movement ticks', `${num(r.ticks)} / ${num(r.totalTicks)}`) + cell('Random calls in step', num(r.calls))
            + cell('Mario records', num(r.marioChecked)) + (r.literals ? cell('GPU reads', num(r.literals)) : '') + cell('Instructions', `${num(r.instructions)} M`) + cell('Time', `${r.seconds.toFixed(1)} s`) + '</div>';
    }
    const lines: string[] = [];
    if (r.issues.length) lines.push(`Differences (${r.issues.length}):`, ...r.issues.slice(0, 20).map((i) => `  frame ${i.frame}, tick ${i.tick} [${i.kind}] ${i.text}`), '');
    if (taken.length) lines.push('Taken from the recording: ' + taken.map(([k, c]) => `${k} ${num(c)}`).join(', '), '');
    if (r.unsupported.length) lines.push('Moonshine settings not reproduced: ' + r.unsupported.join(', '), '');
    if (r.log.length) lines.push('Log:', ...r.log.map((l) => '  ' + l));
    if (lines.length) html += `<details><summary>Details</summary><pre>${esc(lines.join('\n'))}</pre></details>`;
    html += '<div class="row" style="margin-top:12px"><button class="btn small" id="save">Save report</button></div>';
    const box = $('result');
    if (box.dataset.for !== `${j.id}:${r.seconds}`) {
        box.dataset.for = `${j.id}:${r.seconds}`; box.innerHTML = html;
        $('save').onclick = () => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([JSON.stringify({ recording: j.file.name, ...r }, null, 1)], { type: 'application/json' }));
            a.download = j.file.name.replace(/\.msgt$/i, '') + '.report.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        };
    }
    panel.hidden = false;
}

// ---------------------------------------------------------------- the game's picture
// The GPU's frames build on each other, so the renderer has played a job's frames from its first up to `fed`;
// showing an earlier frame, or another job, starts it over.
const GX_BUDGET = 1200 * 2 ** 20;
let renderer: GxRenderer | null = null, shown: Job | null = null, fed = 0, view: 'game' | 'map' = 'map';
function drawGame(j: Job, s: Sample | undefined) {
    if (!renderer || view !== 'game') return;
    if (shown !== j) { renderer.reset(); shown = j; fed = 0; }
    // the last GPU frame that belongs to the frame the slider is on
    let want = j.gx.length - 1;
    if (s && !(j.follow && !j.playing)) { want = -1; for (let k = Math.min(j.gx.length - 1, fed + 4000); k >= 0; k--) if (j.gx[k].frame <= s.frame) { want = k; break; } }
    if (want < fed - 1) { renderer.reset(); fed = 0; }
    const t0 = performance.now();
    while (fed <= want && performance.now() - t0 < 24) renderer.frame(j.gx[fed++]);
    const note = $('gameNote');
    const text = !j.gxAsked ? 'The picture is drawn for the recording that was selected when Play was pressed.' : !j.gx.length ? (j.state === 'running' ? 'Waiting for the stage…' : '') : fed <= want ? `Catching up: frame ${fed} of ${want + 1}` : j.gxFull ? 'The picture stops here: this recording is longer than the page keeps.' : '';
    if (note.textContent !== text) note.textContent = text;
}

// ---------------------------------------------------------------- the live view
let colors: Record<string, string> = {};
function readColors() { const cs = getComputedStyle(document.documentElement); for (const k of ['mario', 'camera', 'actor', 'path', 'grid', 'muted', 'text', 'accent', 'line']) colors[k] = cs.getPropertyValue('--' + k).trim(); }
function fit(c: HTMLCanvasElement) {
    const r = c.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1), w = Math.round(r.width * d), h = Math.round(r.height * d);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d')!; g.setTransform(d, 0, 0, d, 0, 0);
    return { g, w: r.width, h: r.height };
}
/** the ticks of the recording's stage that tick `t` is in */
function segment(i: VerifyIntro, t: number): [number, number] {
    let a = 0, b = i.ticks;
    for (let k = 0; k < i.stageTicks.length; k++) { if (i.stageTicks[k] <= t) a = i.stageTicks[k]; else { b = i.stageTicks[k]; break; } }
    return [a, b];
}
const boundsOf = new WeakMap<VerifyIntro, Map<number, number[]>>();
function bounds(i: VerifyIntro, a: number, b: number) {
    let m = boundsOf.get(i); if (!m) boundsOf.set(i, m = new Map());
    let v = m.get(a);
    if (!v) {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (let k = a; k < b; k++) { const x = i.path[k * 3], y = i.path[k * 3 + 1], z = i.path[k * 3 + 2]; if (x !== x) continue; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z; }
        if (x0 > x1) { x0 = z0 = y0 = -1000; x1 = z1 = y1 = 1000; }
        m.set(a, v = [x0, x1, y0, y1, z0, z1]);
    }
    return v;
}
function draw() {
    requestAnimationFrame(draw);
    const j = selected;
    if (!j || j.state === 'queued' || $('live').hidden) return;
    const n = j.samples.length, scrub = $<HTMLInputElement>('scrub');
    if (j.playing) {
        const k = j.playFrom + Math.floor((performance.now() - j.playAt) / 1000 * FPS);
        if (k >= n - 1) { j.playing = false; j.cursor = Math.max(0, n - 1); j.follow = true; } else j.cursor = k;
    } else if (j.follow) j.cursor = Math.max(0, n - 1);
    scrub.max = String(Math.max(0, n - 1)); if (document.activeElement !== scrub || j.playing) scrub.value = String(j.cursor);
    const s = j.samples[j.cursor], i = j.intro, p = j.progress, r = j.report;
    $('stageTitle').textContent = r && r.stageName ? stageLabel(r.stageName, r.area, r.episode) : i ? `Area ${i.area}, episode ${i.episode + 1}` : j.file.name;
    $('stageMeta').textContent = i ? (i.otherVersion ? `recorded on ${i.recordingVersion}, played on ${i.discVersion}` : i.discVersion.replace(/^the /, '')) + (i.stages > 1 ? ` · ${i.stages} stages` : '') : '';
    $<HTMLButtonElement>('playback').disabled = n < 2; $('playback').textContent = j.playing ? 'Pause' : j.state === 'done' ? 'Replay' : 'Rewind';
    $('clock').textContent = s ? clock(s.frame) : '0:00.00';
    const done = r ? r.frames / Math.max(1, r.totalFrames) : p && p.totalFrames ? p.frames / p.totalFrames : 0;
    $('progress').style.width = `${(100 * done).toFixed(1)}%`;
    const speed = p && p.seconds > 0 && p.frames ? p.frames / FPS / p.seconds : 0;
    $('readout').innerHTML = cell('Frame', `${num(s ? s.frame : p ? p.frames : 0)} / ${num(i ? i.frames : p ? p.totalFrames : 0)}`)
        + cell('State', j.state === 'done' ? jobState(j)[1] : p ? p.phase + (p.attempt > 1 ? ` (start ${p.attempt})` : '') : 'starting')
        + cell('Mario X', s ? s.mario[0].toFixed(2) : '–') + cell('Mario Y', s ? s.mario[1].toFixed(2) : '–') + cell('Mario Z', s ? s.mario[2].toFixed(2) : '–')
        + cell('Speed', s ? s.mario[4].toFixed(3) : '–') + cell('Status', s ? '0x' + (s.mario[5] >>> 0).toString(16).toUpperCase().padStart(8, '0') : '–')
        + cell('Actors', s ? num(s.actors.length / 3) : '–') + (j.state === 'running' && speed ? cell('Pace', `${speed.toFixed(2)}× real time`) : '');
    drawGame(j, s);
    if (view === 'map') { drawMap(j, s); drawHeight(j, s); }
}
function drawMap(j: Job, s: Sample | undefined) {
    const { g, w, h } = fit($<HTMLCanvasElement>('map')), i = j.intro;
    g.clearRect(0, 0, w, h);
    if (!i) return;
    const [a, b] = segment(i, s ? s.tick : 0), B = bounds(i, a, b);
    let x0 = B[0], x1 = B[1], z0 = B[4], z1 = B[5];
    if (wide && s) for (let o = 0; o < s.actors.length; o += 3) { const x = s.actors[o], z = s.actors[o + 2]; if (Math.abs(x) > 60000 || Math.abs(z) > 60000) continue; if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, span = Math.max(x1 - x0, (z1 - z0) * w / h, 1500) * 1.18, k = w / span;
    const X = (x: number) => w / 2 + (x - cx) * k, Y = (z: number) => h / 2 + (z - cz) * k;
    const step = [250, 500, 1000, 2500, 5000, 10000].find((v) => v * k >= 44) || 20000;
    g.lineWidth = 1; g.strokeStyle = colors.grid; g.beginPath();
    for (let x = Math.ceil((cx - w / 2 / k) / step) * step; X(x) < w; x += step) { g.moveTo(Math.round(X(x)) + 0.5, 0); g.lineTo(Math.round(X(x)) + 0.5, h); }
    for (let z = Math.ceil((cz - h / 2 / k) / step) * step; Y(z) < h; z += step) { g.moveTo(0, Math.round(Y(z)) + 0.5); g.lineTo(w, Math.round(Y(z)) + 0.5); }
    g.stroke();
    g.fillStyle = colors.muted; g.font = '11px ui-monospace, Menlo, Consolas, monospace'; g.fillText(`${num(step)} units a square`, 8, h - 8);
    // the recorded path
    g.strokeStyle = colors.path; g.lineWidth = 2.5; g.lineJoin = g.lineCap = 'round'; g.beginPath();
    let pen = false;
    for (let t = a; t < b; t++) { const x = i.path[t * 3], z = i.path[t * 3 + 2]; if (x !== x) { pen = false; continue; } if (pen) g.lineTo(X(x), Y(z)); else { g.moveTo(X(x), Y(z)); pen = true; } }
    g.stroke();
    if (!s) return;
    // actors
    g.fillStyle = colors.actor;
    for (let o = 0; o < s.actors.length; o += 3) { const x = X(s.actors[o]), y = Y(s.actors[o + 2]); if (x < -4 || y < -4 || x > w + 4 || y > h + 4) continue; g.beginPath(); g.arc(x, y, 2.2, 0, 6.2832); g.fill(); }
    // the game's Mario so far
    g.strokeStyle = colors.mario; g.lineWidth = 1.6; g.globalAlpha = 0.9; g.beginPath(); pen = false;
    for (let q = Math.max(0, j.cursor - 5000); q <= j.cursor; q++) { const m = j.samples[q]; if (!m || m.tick < a || m.tick >= b) { pen = false; continue; } if (pen) g.lineTo(X(m.mario[0]), Y(m.mario[2])); else { g.moveTo(X(m.mario[0]), Y(m.mario[2])); pen = true; } }
    g.stroke(); g.globalAlpha = 1;
    // the camera: its eye, and the way it looks
    const ex = X(s.camera[0]), ey = Y(s.camera[2]), tx = X(s.camera[3]), ty = Y(s.camera[5]);
    g.strokeStyle = colors.camera; g.fillStyle = colors.camera; g.lineWidth = 1.2; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(ex, ey); g.lineTo(tx, ty); g.stroke(); g.setLineDash([]);
    g.beginPath(); g.arc(ex, ey, 4, 0, 6.2832); g.fill();
    // Mario
    const mx = X(s.mario[0]), my = Y(s.mario[2]), yaw = s.mario[3] / 65536 * 6.2832, dx = Math.sin(yaw), dy = Math.cos(yaw);
    g.fillStyle = colors.mario; g.beginPath(); g.moveTo(mx + dx * 11, my + dy * 11); g.lineTo(mx - dx * 6 + dy * 6, my - dy * 6 - dx * 6); g.lineTo(mx - dx * 6 - dy * 6, my - dy * 6 + dx * 6); g.closePath(); g.fill();
    g.strokeStyle = colors.text; g.lineWidth = 1; g.stroke();
}
function drawHeight(j: Job, s: Sample | undefined) {
    const { g, w, h } = fit($<HTMLCanvasElement>('height')), i = j.intro;
    g.clearRect(0, 0, w, h);
    if (!i) return;
    const [a, b] = segment(i, s ? s.tick : 0), B = bounds(i, a, b), lo = B[2] - 40, hi = Math.max(B[3] + 40, lo + 400);
    const X = (t: number) => 6 + (t - a) / Math.max(1, b - a) * (w - 12), Y = (y: number) => h - 6 - (y - lo) / (hi - lo) * (h - 12);
    g.strokeStyle = colors.path; g.lineWidth = 2; g.lineJoin = 'round'; g.beginPath();
    let pen = false;
    for (let t = a; t < b; t++) { const y = i.path[t * 3 + 1]; if (i.path[t * 3] !== i.path[t * 3]) { pen = false; continue; } if (pen) g.lineTo(X(t), Y(y)); else { g.moveTo(X(t), Y(y)); pen = true; } }
    g.stroke();
    g.strokeStyle = colors.mario; g.lineWidth = 1.4; g.beginPath(); pen = false;
    for (let q = 0; q <= j.cursor; q++) { const m = j.samples[q]; if (!m || m.tick < a || m.tick >= b) { pen = false; continue; } if (pen) g.lineTo(X(m.tick), Y(m.mario[1])); else { g.moveTo(X(m.tick), Y(m.mario[1])); pen = true; } }
    g.stroke();
    if (s) { g.strokeStyle = colors.accent; g.lineWidth = 1; g.beginPath(); g.moveTo(Math.round(X(s.tick)) + 0.5, 0); g.lineTo(Math.round(X(s.tick)) + 0.5, h); g.stroke(); }
    g.fillStyle = colors.muted; g.font = '11px ui-monospace, Menlo, Consolas, monospace'; g.fillText('height', 8, 14);
}

// ---------------------------------------------------------------- wiring
function init() {
    readColors();
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', readColors);
    const cores = navigator.hardwareConcurrency || 2, max = Math.max(1, Math.min(6, cores - 1)), sel = $<HTMLSelectElement>('parallel');
    for (let n = 1; n <= max; n++) sel.add(new Option(String(n), String(n)));
    $('pickIso').onclick = () => $('isoFile').click();
    $('pickFolder').onclick = () => $('folderFile').click();
    $('pickTraces').onclick = () => $('traceFile').click();
    $<HTMLInputElement>('isoFile').onchange = (e) => { const f = (e.target as HTMLInputElement).files; if (f && f[0]) setIso(f[0]); };
    $<HTMLInputElement>('folderFile').onchange = (e) => { const f = (e.target as HTMLInputElement).files; if (f && f.length) setFolder([...f]); };
    $<HTMLInputElement>('traceFile').onchange = (e) => { const t = e.target as HTMLInputElement; if (t.files) addTraces([...t.files]); t.value = ''; };
    $('clearJobs').onclick = () => { for (const j of jobs) if (j.worker) j.worker.terminate(); jobs.length = 0; selected = null; wanted = false; refresh(); };
    $('run').onclick = () => {
        if (!jobs.some((j) => j.state === 'queued')) for (const j of jobs) if (j.state === 'done') j.state = 'queued';
        wanted = true; if (selected && selected.state === 'done') selected = null; pump();
    };
    $('stop').onclick = () => { wanted = false; for (const j of jobs) if (j.worker) j.worker.postMessage({ type: 'cancel' }); refresh(); };
    $<HTMLInputElement>('scrub').oninput = (e) => { const j = selected; if (!j) return; const v = +(e.target as HTMLInputElement).value; j.playing = false; j.cursor = v; j.follow = v >= j.samples.length - 1; };
    const setView = (v: 'game' | 'map') => {
        view = v;
        $('gameWrap').hidden = v !== 'game'; $('mapWrap').hidden = v !== 'map';
        $('tabGame').setAttribute('aria-pressed', String(v === 'game')); $('tabMap').setAttribute('aria-pressed', String(v === 'map'));
    };
    try { renderer = new GxRenderer($<HTMLCanvasElement>('game')); } catch { renderer = null; }
    if (renderer) setView('game'); else { $('tabGame').hidden = true; setView('map'); }
    $('tabGame').onclick = () => setView('game');
    $('tabMap').onclick = () => setView('map');
    $('wide').onclick = () => { wide = !wide; $('wide').textContent = wide ? 'Follow the path' : 'Whole stage'; };
    $('playback').onclick = () => {
        const j = selected; if (!j) return;
        if (j.playing) { j.playing = false; j.follow = false; return; }
        j.playFrom = j.cursor >= j.samples.length - 1 ? 0 : j.cursor; j.playAt = performance.now(); j.playing = true; j.follow = false;
    };
    let depth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); if (++depth === 1) document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
        e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
        const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
        const iso = files.find((f) => /\.(iso|gcm)$/i.test(f.name)); if (iso) setIso(iso);
        addTraces(files);
    });
    refresh(); requestAnimationFrame(draw);
}
init();
