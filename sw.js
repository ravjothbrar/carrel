// Service worker: makes carrel installable and usable offline.
//
// It precaches the app shell (pages, scripts, fonts, vendored libraries) from precache.json, and
// serves same-origin GET requests cache-first. It deliberately ignores every cross-origin request:
// model files from Hugging Face are stored by Transformers.js in its own Cache Storage bucket, and
// this worker must never see or alter them. No analytics, no remote config.

const VERSION = 'da57f8f34b68'; // rewritten by tools/build-sw-manifest.mjs
const CACHE = `carrel-shell-${VERSION}`;
const scope = self.registration.scope;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const res = await fetch(new URL('precache.json', scope), { cache: 'no-store' });
      if (!res.ok) throw new Error('precache.json missing');
      const { files } = await res.json();
      const cache = await caches.open(CACHE);
      await cache.addAll(files.map((f) => new Request(new URL(f, scope), { cache: 'reload' })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('carrel-shell-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch Hugging Face or anything else
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (req.mode === 'navigate') {
        const shell = await cache.match(new URL('index.html', scope));
        try {
          return await fetch(req);
        } catch {
          if (shell) return shell;
          throw new Error('offline and not cached');
        }
      }
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      return fetch(req);
    })(),
  );
});
