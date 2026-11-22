// DueDates service worker — makes the app open and run with no internet.
// Bump VERSION on every deploy so installed devices download the new files.
const VERSION = 'dd-v13';
const SHELL = ['./', './index.html', './styles.css', './app.js', './offline.js', './ui.js', './effects.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png',
  './vendor/tailwind.css', './vendor/fonts.css', './vendor/chart.umd.js', './vendor/xlsx.full.min.js', './vendor/supabase.js',
  './vendor/fonts/inter-latin-400-normal.woff2', './vendor/fonts/inter-latin-500-normal.woff2', './vendor/fonts/inter-latin-600-normal.woff2', './vendor/fonts/inter-latin-700-normal.woff2',
  './vendor/fonts/plus-jakarta-sans-latin-600-normal.woff2', './vendor/fonts/plus-jakarta-sans-latin-700-normal.woff2', './vendor/fonts/plus-jakarta-sans-latin-800-normal.woff2',
  './vendor/fonts/jetbrains-mono-latin-400-normal.woff2', './vendor/fonts/jetbrains-mono-latin-500-normal.woff2', './vendor/fonts/jetbrains-mono-latin-600-normal.woff2', './vendor/fonts/jetbrains-mono-latin-700-normal.woff2'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // cache:'reload' bypasses the browser HTTP cache so a new deploy is really downloaded
    await Promise.all(SHELL.map(u => cache.add(new Request(u, { cache: 'reload' }))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co')) return; // the app's data layer handles its own offline cache

  // Page loads: network for up to 3s (to get updates), otherwise open instantly from cache.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      try {
        const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3000))]);
        if (res && res.ok) cache.put('./index.html', res.clone());
        return res;
      } catch (e) {
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req);
    const sameOrigin = url.origin === self.location.origin;
    const refresh = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; });
    if (hit) { if (sameOrigin) refresh.catch(() => {}); return hit; }   // own files: serve cache, refresh in background
    try { return await refresh; } catch (e) { return Response.error(); }
  })());
});
