// Service Worker de Centro Tapping
// Estrategia:
// - El "cascarón" de la app (html, manifest, icono) se pide SIEMPRE a la red
//   primero, ignorando la caché HTTP del navegador, para que las
//   actualizaciones lleguen en la siguiente apertura sin reinstalar nada.
//   Si no hay conexión, se sirve la última copia guardada.
// - El resto (imágenes, audios) se sirve desde caché al instante si ya lo
//   tenemos, y se refresca en segundo plano — así el uso sin conexión sigue
//   siendo instantáneo para archivos pesados que casi nunca cambian.
//
// Nota: esto NO afecta al historial, favoritos ni racha de la persona.
// Esos datos viven en localStorage, no en esta caché, y no se tocan nunca
// desde aquí.

const CACHE_NAME = 'tapping-cache-v2';

const CORE_ASSETS = [
  './tapping.html',
  './manifest.webmanifest',
  './app-icon.png',
];

// Rutas que siempre van "red primero": el cascarón de la app.
function isCoreAsset(url) {
  return CORE_ASSETS.some((asset) => url.endsWith(asset.replace('./', '')));
}

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

  // Cascarón de la app: red primero (sin caché HTTP), caché como respaldo.
  if (isCoreAsset(request.url)) {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then((fresh) => {
          if (fresh && fresh.ok) {
            const copy = fresh.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return fresh;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Resto de recursos (imágenes, audios): caché primero, refresco en segundo plano.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        fetch(request).then((fresh) => {
          if (fresh && fresh.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, fresh));
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => {
        return new Response('', { status: 504, statusText: 'Sin conexión' });
      });
    })
  );
});
