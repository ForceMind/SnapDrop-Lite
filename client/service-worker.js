var CACHE_NAME = 'snapdrop-cache-v2.0.0';

self.addEventListener('install', function(event) {
  console.log('Service Worker 安装中...');
  // 跳过等待，立即激活
  self.skipWaiting();
});


self.addEventListener('fetch', function(event) {
  // 不缓存，直接从网络获取
  event.respondWith(fetch(event.request));
});


self.addEventListener('activate', function(event) {
  console.log('正在更新 Service Worker... 版本: 2.0.0')
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.filter(function(cacheName) {
          // 删除所有旧缓存
          return true
        }).map(function(cacheName) {
          console.log('删除缓存:', cacheName);
          return caches.delete(cacheName);
        })
      );
    })
  );
});
