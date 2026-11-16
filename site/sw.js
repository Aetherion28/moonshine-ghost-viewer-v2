// Service worker: keeps the viewer's own files so the installed app opens offline. Made by build.mjs
// (the file list and version are filled in); it caches only this site's files, never the game or the
// shared ghosts, and the page's disc copy lives in the browser's own storage as before.
const VERSION = 'e4ed89ed88d7';
const CACHE = 'ghostViewer-' + VERSION;
const FILES = [
 "./",
 "LICENSE.txt",
 "apple-touch-icon.png",
 "audio-worklet.js",
 "audio.js",
 "favicon.png",
 "game.js",
 "gesso.js",
 "ghost.js",
 "hud.js",
 "icon-192.png",
 "icon-512.png",
 "icon-maskable-512.png",
 "index.html",
 "jpa.js",
 "legal.html",
 "manifest.webmanifest",
 "mario_anims.js",
 "mario_rig.js",
 "mp4-muxer.js",
 "social.png",
 "sprite-fish.png",
 "sprite-hand.png",
 "sprite-pad.png",
 "sprite-palm.png",
 "sprite-ship.png",
 "sprite-sun.png",
 "vendor/fonts/OFL-IBM-Plex-Mono.txt",
 "vendor/fonts/OFL-M-PLUS-Rounded-1c.txt",
 "vendor/fonts/fonts.css",
 "vendor/fonts/ibm-plex-mono-latin-400-normal.woff2",
 "vendor/fonts/ibm-plex-mono-latin-500-normal.woff2",
 "vendor/fonts/ibm-plex-mono-latin-ext-400-normal.woff2",
 "vendor/fonts/ibm-plex-mono-latin-ext-500-normal.woff2",
 "vendor/fonts/m-plus-rounded-1c-latin-500-normal.woff2",
 "vendor/fonts/m-plus-rounded-1c-latin-800-normal.woff2",
 "vendor/fonts/m-plus-rounded-1c-latin-ext-500-normal.woff2",
 "vendor/fonts/m-plus-rounded-1c-latin-ext-800-normal.woff2",
 "vendor/licenses/fzstd.txt",
 "vendor/licenses/gl-matrix.txt",
 "vendor/licenses/noclip.txt",
 "vendor/three/GLTFLoader.js",
 "vendor/three/LICENSE.txt",
 "vendor/three/OrbitControls.js",
 "vendor/three/SkeletonUtils.js",
 "vendor/three/three.min.js"
];
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
