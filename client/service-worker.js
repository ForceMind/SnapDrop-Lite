var CACHE_NAME = 'snapdrop-cache-v2.0.2';

self.addEventListener('install', function(event) {
  console.log('[闪投] Service Worker 安装中...');
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  console.log('[闪投] Service Worker 激活，清除旧缓存');
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.map(function(cacheName) {
          console.log('[闪投] 删除缓存:', cacheName);
          return caches.delete(cacheName);
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event) {
  event.respondWith(fetch(event.request));
});
