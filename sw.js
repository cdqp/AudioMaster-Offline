// Service worker for the hosted version (GitHub Pages or any HTTPS server): keeps the app available offline
// once it has been opened. Cached files are served immediately and refreshed in the background, so a new
// release is picked up on the next visit. Opening the HTML file directly (file://) does not use it.
const CACHE = 'audiomaster-1.2.0';
const SHELL = [
  './',
  './index.html',
  './CDQP.Offline.Audio.Master.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('audiomaster-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then(res => {
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    });
    if (cached) {
      event.waitUntil(fresh.catch(() => {}));
      return cached;
    }
    try {
      return await fresh;
    } catch (err) {
      if (req.mode === 'navigate') return (await cache.match('./CDQP.Offline.Audio.Master.html')) || Response.error();
      throw err;
    }
  }));
});
