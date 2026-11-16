// Accessibility check of the viewer page: controls without a name, form fields without a label,
// text below WCAG AA contrast (in both themes), what Tab reaches and whether its focus shows, and the
// page basics (language, title, a live region for notices).
//   node tools/smoke/a11y.mjs <site> [disc] [recording]   (with a disc and a recording every panel shows)
import { createRequire } from 'node:module';
const { chromium } = createRequire('/opt/npm-tools/node_modules/')('playwright');
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
const [site, disc, rec] = process.argv.slice(2);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const srv = http.createServer((q, s) => { let p = join(site, decodeURIComponent(q.url.split('?')[0])); if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html'); if (!existsSync(p)) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }); s.end(readFileSync(p)); });
await new Promise((r) => srv.listen(0, r));
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const pg = await b.newPage({ viewport: { width: 1280, height: 800 } });
await pg.goto(`http://127.0.0.1:${srv.address().port}/index.html`);
await pg.waitForTimeout(1500);
if (disc) { await pg.setInputFiles(statSync(disc).isFile() ? '#isoFile' : '#folderFile', disc); await pg.waitForTimeout(8000); }
if (rec) { await pg.setInputFiles('#ghostFile', rec); await pg.waitForTimeout(12000); }

const audit = () => pg.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !e.closest('[hidden],[aria-hidden="true"]'); };
    const desc = (e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : ''}`;
    const name = (e) => {
        const l = e.getAttribute('aria-label'); if (l && l.trim()) return l.trim();
        const lb = e.getAttribute('aria-labelledby'); if (lb) { const t = lb.split(/\s+/).map((i) => document.getElementById(i)?.textContent || '').join(' ').trim(); if (t) return t; }
        if (e.id) { const f = document.querySelector(`label[for="${e.id}"]`); if (f && f.textContent.trim()) return f.textContent.trim(); }
        const wrap = e.closest('label'); if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
        if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(e.tagName) && e.textContent.trim()) return e.textContent.trim();
        if (e.getAttribute('title')) return e.getAttribute('title');
        if (e.getAttribute('alt')) return e.getAttribute('alt');
        if (e.getAttribute('placeholder')) return e.getAttribute('placeholder');
        return '';
    };
    const out = { unnamed: [], unlabelled: [], contrast: [], basics: {} };
    for (const e of document.querySelectorAll('button, a[href], input, select, textarea, [role=button], [tabindex], summary, canvas')) {
        if (e.type === 'hidden' || (e.tagName === 'INPUT' && e.hidden)) continue;
        if (!vis(e)) continue;
        const n = name(e);
        if (!n) (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.tagName) ? out.unlabelled : out.unnamed).push(desc(e) + (e.type ? `[${e.type}]` : ''));
    }
    // text contrast: each element with its own visible text against the first opaque background behind it
    const rgb = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bgOf = (e) => {
        const layers = [];
        for (let x = e; x; x = x.parentElement) { const c = rgb(getComputedStyle(x).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } if (getComputedStyle(x).backgroundImage !== 'none' && x !== e) return null; }
        let base = { r: 255, g: 255, b: 255 };
        for (let i = layers.length - 1; i >= 0; i--) { const c = layers[i]; base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) }; }
        return base;
    };
    const seen = new Set();
    for (const e of document.querySelectorAll('body *')) {
        if (!vis(e) || ['SCRIPT', 'STYLE', 'CANVAS', 'svg', 'SVG'].includes(e.tagName) || e.closest('svg')) continue;
        const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!own) continue;
        const s = getComputedStyle(e), fg = rgb(s.color), bg = bgOf(e);
        if (!fg || !bg) continue;
        const f = fg.a < 1 ? { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) } : fg;
        const L1 = lum(f), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        const px = parseFloat(s.fontSize), bold = +s.fontWeight >= 700, large = px >= 24 || (bold && px >= 18.66);
        const need = large ? 3 : 4.5;
        if (ratio < need) { const k = desc(e) + ' ' + s.color + ' on ' + `rgb(${bg.r | 0}, ${bg.g | 0}, ${bg.b | 0})`; if (!seen.has(k)) { seen.add(k); out.contrast.push(`${ratio.toFixed(2)} < ${need}: ${k} "${e.textContent.trim().slice(0, 40)}"`); } }
    }
    out.basics = { lang: document.documentElement.lang, title: document.title, main: !!document.querySelector('main, [role=main]'), h1: document.querySelectorAll('h1').length,
        notice: document.getElementById('notice')?.getAttribute('role') || document.getElementById('notice')?.getAttribute('aria-live') || null };
    return out;
});

// (no transitions: a colour read mid-transition isn't the one people see)
await pg.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
for (const theme of ['light', 'dark']) {
    await pg.evaluate((t) => { const bt = document.querySelector(`[data-theme-set="${t}"]`); if (bt) bt.click(); }, theme);
    await pg.mouse.move(640, 400);   // (off the header: hover colours aren't the resting ones)
    await pg.waitForTimeout(500);
    const r = await audit();
    console.log(`== ${theme} theme`);
    if (theme === 'light') { console.log('basics', JSON.stringify(r.basics)); console.log(`controls without a name (${r.unnamed.length}):`, r.unnamed.join(', ')); console.log(`fields without a label (${r.unlabelled.length}):`, r.unlabelled.join(', ')); }
    console.log(`text under AA contrast (${r.contrast.length}):`); for (const c of r.contrast) console.log('  ', c);
}

// keyboard: what Tab reaches, and whether the focus shows (an outline or a box shadow that isn't there unfocused)
await pg.evaluate(() => document.activeElement && document.activeElement.blur());
const stops = [];
for (let i = 0; i < 160; i++) {
    await pg.keyboard.press('Tab');
    const s = await pg.evaluate(() => {
        const e = document.activeElement;
        if (!e || e === document.body) return null;
        const f = getComputedStyle(e), shows = (f.outlineStyle !== 'none' && parseFloat(f.outlineWidth) > 0) || f.boxShadow !== 'none';
        return `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${shows ? '' : ' (NO FOCUS RING)'}`;
    });
    if (!s || (stops.length && s === stops[0])) break;
    stops.push(s);
}
console.log(`== Tab order (${stops.length} stops, ${stops.filter((s) => /NO FOCUS/.test(s)).length} without a visible focus):`);
console.log('  ' + stops.join(' > '));
// pointer-only controls: clickable-looking elements Tab can't reach
const ptr = await pg.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => { const s = getComputedStyle(e); return s.cursor === 'pointer' && e.tabIndex < 0 && !e.closest('a,button,label,summary,input,select') && e.getBoundingClientRect().width > 0 && !e.closest('[aria-hidden="true"]'); }).map((e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : ''}`));
console.log(`== clickable but not keyboard-reachable (${ptr.length}):`, [...new Set(ptr)].join(', '));
await b.close(); srv.close();
