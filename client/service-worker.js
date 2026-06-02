var CACHE_NAME = 'snapdrop-cache-v2.0.6';

// 安装：跳过等待
self.addEventListener('install', function(event) {
  console.log('[闪投] Service Worker 安装中...');
  self.skipWaiting();
});

// 激活：清除旧缓存
self.addEventListener('activate', function(event) {
  console.log('[闪投] Service Worker 激活');
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.filter(function(cacheName) {
          return cacheName !== CACHE_NAME;
        }).map(function(cacheName) {
          console.log('[闪投] 删除旧缓存:', cacheName);
          return caches.delete(cacheName);
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// 请求拦截：缓存优先，网络回退
self.addEventListener('fetch', function(event) {
  // 跳过非 GET 请求
  if (event.request.method !== 'GET') return;

  // WebSocket 请求直接走网络
  if (event.request.url.includes('/server')) return;

  event.respondWith(
    caches.match(event.request)
      .then(function(response) {
        if (response) {
          return response;
        }
        return fetch(event.request).then(function(response) {
          // 缓存新的请求
          if (response && response.status === 200) {
            var responseClone = response.clone();
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        });
      })
  );
});
