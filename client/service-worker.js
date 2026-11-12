'use strict';
const CACHE = 'zeydrop-shell-__REVISION__';
const ASSETS = /*__ASSETS__*/ [];
self.addEventListener('install', event => {
    // A failed shell install never replaces the last complete version.
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('activate', event => event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE && /^(snapdrop-cache|zeydrop-shell)/.test(key)).map(key => caches.delete(key)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || event.request.method !== 'GET' || url.pathname.startsWith('/server') || url.pathname.endsWith('/config.js') || url.pathname.endsWith('/build.json')) return;
    if (event.request.mode === 'navigate') {
        // Always cache a canonical shell; invitation tokens must never enter cache keys.
        event.respondWith(fetch(event.request).catch(() => caches.match('/'))); return;
    }
    event.respondWith(caches.match(event.request).then(response => response || fetch(event.request)));
});
