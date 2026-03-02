const CACHE_NAME = 'ar-scanner-v1';

// We explicitly cache essential assets for offline PWA startup.
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './ar-viewer.js',
    './ar-scanner-app.js',
    './signal-scanner.js',
    './editor.js',
    './manifest.json',
    './icon-192.svg',
    './icon-512.svg'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keyList) => {
            return Promise.all(
                keyList.map((key) => {
                    if (key !== CACHE_NAME) {
                        return caches.delete(key);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Network First, Cache Fallback strategy
self.addEventListener('fetch', (event) => {
    // Ignore non-GET requests and cross-origin requests
    if (event.request.method !== 'GET') return;

    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                // Since Transformers.js downloads large files from unpkg/HF, we might want to cache them if possible,
                // but for now, we just cache local assets dynamically as well.
                if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                }
                return networkResponse;
            })
            .catch(() => {
                // If network fails, try the cache
                return caches.match(event.request).then((cachedResponse) => {
                    return cachedResponse || new Response('Offline and not in cache', { status: 503 });
                });
            })
    );
});
