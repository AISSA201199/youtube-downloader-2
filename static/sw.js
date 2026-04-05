// Service Worker — Video Downloader Pro PWA v2.0
const CACHE_NAME = 'vdp-v2';
const OFFLINE_URL = '/';

const ASSETS_TO_CACHE = [
    '/',
    '/static/style.css',
    '/static/app.js',
    'https://fonts.googleapis.com/css2?family=Tajawal:wght@300;400;500;700;800;900&display=swap',
];

// Install — pre-cache shell
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
    self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

// Fetch — network first, fallback to cache
self.addEventListener('fetch', event => {
    // Skip non-GET and API requests
    if (event.request.method !== 'GET') return;
    if (event.request.url.includes('/api/')) return;
    if (event.request.url.includes('/downloads/')) return;

    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Clone and cache successful responses
                if (response.status === 200) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseClone);
                    });
                }
                return response;
            })
            .catch(() => {
                return caches.match(event.request).then(cachedResponse => {
                    return cachedResponse || caches.match(OFFLINE_URL);
                });
            })
    );
});
