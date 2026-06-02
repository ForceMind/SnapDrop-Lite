var CACHE_NAME = 'snapdrop-cache-v2.0.5';
var urlsToCache = [
  './',
  'index.html',
  'styles.css',
  'config.js',
  'scripts/network.js',
  'scripts/ui.js',
  'scripts/clipboard.js',
  'sounds/blop.mp3',
  'images/favicon-96x96.png',
  'images/logo_transparent_128x128.png'
];

// 安装：缓存核心资源
self.addEventListener('install', function(event) {
  console.log('[闪投] Service Worker 安装中...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        console.log('[闪投] 缓存已打开');
        return cache.addAll(urlsToCache);
      })
      .then(function() {
        return self.skipWaiting();
      })
  );
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
