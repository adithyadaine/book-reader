// Verso service worker: keeps the app shell and libraries cached so the installed app opens offline.
// Books themselves already live in IndexedDB, so nothing about them is cached here.
// Raise VERSION together with the ?v= numbers in index.html whenever app.js or style.css change.
const VERSION = 17;
const CACHE = 'verso-v' + VERSION;
const SHELL = [
  './',
  'index.html',
  `style.css?v=${VERSION}`,
  `app.js?v=${VERSION}`,
  'manifest.json',
  'vendor/page-flip.browser.js',
  'vendor/pdf.min.js',
  'vendor/pdf.worker.min.js',
  'vendor/jszip.min.js',
  'favicon-v4.ico',
  'favicon-v4.png',
  'touch-icon-v4.png',
  'icon-192-v4.png',
  'icon-512-v4.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('verso-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // pages and unversioned files: try the network first so updates arrive, fall back to the cache offline
  // versioned files (?v=) and vendor libraries never change at the same URL, so the cache is used first
  const cacheFirst = url.search.includes('v=') || url.pathname.includes('/vendor/');
  if (cacheFirst) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: req.mode === 'navigate' })
    .then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
