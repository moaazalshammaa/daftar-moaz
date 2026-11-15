// يخلي التطبيق يشتغل بدون إنترنت بعد أول فتح.
// غيّر رقم النسخة عند كل تحديث للملفات.
const CACHE = 'ejad-mini-market-v12';
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/scanner.js', '/scanner-worker.js', '/lib/text.js',
  '/vendor/zxing-reader.js', '/vendor/zxing_reader.wasm',
  '/manifest.webmanifest', '/icon.svg', '/fonts/thmanyah-regular.woff2', '/fonts/thmanyah-bold.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// stale-while-revalidate: نعرض النسخة المحفوظة فوراً ونحدّثها بالخلفية
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return; // البيانات دايماً من الخادم
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      const net = fetch(e.request)
        .then((res) => {
          if (res.ok || res.type === 'opaque') cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});
