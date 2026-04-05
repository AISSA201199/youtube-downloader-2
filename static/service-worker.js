const CACHE_NAME = 'video-dl-pwa-v17';
const urlsToCache = [
  '/',
  '/static/style.css',
  '/static/app.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .catch(err => console.warn('Cache failed during install:', err))
  );
});

self.addEventListener('fetch', event => {
  // Only cache GET requests and ignore API calls
  if (event.request.method !== 'GET' || event.request.url.includes('/api/')) return;
  
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Return cached version if found
        if (response) return response;
        // Else fetch from network
        return fetch(event.request).then(
          function(response) {
            // Check if we received a valid response
            if(!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }
            var responseToCache = response.clone();
            caches.open(CACHE_NAME)
              .then(function(cache) {
                cache.put(event.request, responseToCache);
              });
            return response;
          }
        );
      }).catch(() => {
          // Fallback if offline and not in cache
      })
  );
});
