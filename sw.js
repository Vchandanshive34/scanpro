/**
 * Service worker.
 *
 * The app shell is precached so ScanPro opens with no network at all. Language
 * packs are large and there are fifteen of them, so they are cached lazily —
 * the first time you use a language it is stored, and from then on that
 * language works offline too.
 */

/**
 * Bump VERSION on every deploy. The shell is served cache-first, so without a
 * new cache name returning visitors keep running the previous build no matter
 * what is on the server.
 */
const VERSION = 'v3';
const SHELL_CACHE = `scanpro-shell-${VERSION}`;

// Deliberately unversioned: language models are immutable and can be tens of
// megabytes, so a code deploy must not force users to download them again.
const DATA_CACHE = 'scanpro-data';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/core/db.js',
  './js/core/detect.js',
  './js/core/enhance.js',
  './js/core/geometry.js',
  './js/core/glyphless-font.js',
  './js/core/languages.js',
  './js/core/lens.js',
  './js/core/ocr.js',
  './js/core/pdf.js',
  './js/core/pipeline.js',
  './js/core/warp.js',
  './js/ui/camera.js',
  './js/ui/dom.js',
  './js/ui/editor.js',
  './js/ui/settings.js',
  './js/ui/textview.js',
  './js/workers/cv.worker.js',
  './vendor/tesseract.min.js',
  './vendor/worker.min.js',
  './icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Individually, so one missing optional file cannot fail the install.
    await Promise.all(SHELL.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n !== SHELL_CACHE && n !== DATA_CACHE)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Language models and the OCR core: cache on first use, then serve from
  // cache forever. These are immutable, so there is nothing to revalidate.
  const isBigAsset = url.pathname.includes('/tessdata/') ||
                     url.pathname.includes('/vendor/core/');

  if (isBigAsset) {
    event.respondWith((async () => {
      const cache = await caches.open(DATA_CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;

      try {
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      } catch (err) {
        return new Response('Language pack unavailable offline.', {
          status: 504, statusText: 'Offline',
        });
      }
    })());
    return;
  }

  // App shell: cache first, refresh in the background.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(request, { ignoreSearch: true });

    const network = fetch(request).then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    }).catch(() => null);

    if (hit) return hit;

    const response = await network;
    if (response) return response;

    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    return new Response('Offline', { status: 504 });
  })());
});
