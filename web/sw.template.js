// Service worker: keeps the viewer's own files so the installed app opens offline. Made by build.mjs
// (the file list and version are filled in); it caches only this site's files, never the game or the
// shared ghosts, and the page's disc copy lives in the browser's own storage as before.
const VERSION = '__VERSION__';
const CACHE = 'ghostViewer-' + VERSION;
const FILES = __FILES__;
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('ghostViewer-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin || u.pathname.endsWith('/build.txt') || u.pathname.endsWith('/sw.js')) return;
  e.respondWith((async () => {
    const hit = await caches.match(r.mode === 'navigate' ? new URL('index.html', location.href).href : r, { cacheName: CACHE, ignoreSearch: true });
    if (hit) return hit;
    try { return await fetch(r); } catch (err) { return new Response('Offline, and this file is not saved.', { status: 503, headers: { 'content-type': 'text/plain' } }); }
  })());
});
