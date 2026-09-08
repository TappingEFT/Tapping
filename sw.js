// Service Worker de Centro Tapping
// Estrategia: cachea el "cascarón" de la app al instalar, y va guardando
// todo lo demás (imágenes, audios) la primera vez que se pide, para que
// la segunda vez ya funcione sin conexión.

const CACHE_NAME = 'tapping-cache-v1';

const CORE_ASSETS = [
  './tapping.html',
  './manifest.webmanifest',
  './app-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Solo nos ocupamos de peticiones GET del propio sitio (no las llamadas
  // al Worker de licencias, esas siempre van directas a la red).
  if (request.method !== 'GET') return;
  if (request.url.includes('/validate')) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        // Ya lo tenemos: lo servimos al instante, y de paso lo actualizamos
        // en segundo plano por si hay una versión más nueva.
        fetch(request).then((fresh) => {
          if (fresh && fresh.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, fresh));
          }
        }).catch(() => {});
        return cached;
      }
      // No lo teníamos: lo pedimos a la red y lo guardamos para la próxima vez.
      return fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => {
        // Sin red y sin caché: no hay nada que hacer con este recurso.
        return new Response('', { status: 504, statusText: 'Sin conexión' });
      });
    })
  );
});
