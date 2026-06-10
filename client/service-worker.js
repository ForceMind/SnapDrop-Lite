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

function cacheResponse(request, response) {
  if (response && response.status === 200) {
    var responseClone = response.clone();
    caches.open(CACHE_NAME).then(function(cache) {
      cache.put(request, responseClone);
    });
  }
  return response;
}

function networkFirst(request) {
  return fetch(request)
    .then(function(response) {
      return cacheResponse(request, response);
    })
    .catch(function() {
      return caches.match(request);
    });
}

function cacheFirst(request) {
  return caches.match(request)
    .then(function(response) {
      if (response) return response;
      return fetch(request).then(function(response) {
        return cacheResponse(request, response);
      });
    });
}

// 请求拦截：入口页面网络优先，静态资源缓存优先
self.addEventListener('fetch', function(event) {
  // 跳过非 GET 请求
  if (event.request.method !== 'GET') return;

  // WebSocket 请求直接走网络
  if (event.request.url.includes('/server')) return;

  var accept = event.request.headers.get('accept') || '';
  var isNavigation = event.request.mode === 'navigate' || accept.includes('text/html');
  var isManifest = event.request.url.includes('/manifest.json');

  event.respondWith(
    isNavigation || isManifest
      ? networkFirst(event.request)
      : cacheFirst(event.request)
  );
});
