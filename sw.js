const CACHE_NAME = 'weneed-cache-v1';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './js/supabase-cliente.js', // Estes continuam na pasta js/
  './js/auth.js',
  './js/utils.js',
  './app.js',                 // ✅ AGORA ESTÁ NA RAIZ (sem o js/)
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      const results = await Promise.allSettled(
        ASSETS_TO_CACHE.map(url => cache.add(url))
      );
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.warn(`⚠️ Falha ao cachear: ${ASSETS_TO_CACHE[index]}`, result.reason);
        }
      });
      console.log('✅ Service Worker instalado!');
    })
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
});