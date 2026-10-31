// minimal service worker so iPad treats this as an installable app; network-first, no caching of API
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());
self.addEventListener('fetch', e => { if (e.request.method !== 'GET' || e.request.url.includes('/api/')) return; e.respondWith(fetch(e.request).catch(() => caches.match(e.request))); });
