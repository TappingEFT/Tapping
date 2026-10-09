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

const CACHE_NAME = 'tapping-cache-v4';

const CORE_ASSETS = [
  './tapping.html',
  './manifest.webmanifest',
  './app-icon.png',
];

// Rutas que siempre van "red primero": el cascarón de la app.
function isCoreAsset(url) {
  const path = new URL(url).pathname;
  if (path.endsWith('/tapping')) return true; // Cloudflare sirve tapping.html como /tapping
  return CORE_ASSETS.some((asset) => path.endsWith(asset.replace('./', '')));
}

// Copia de respaldo sin conexión. Se reconstruye la respuesta para que el
// navegador la acepte aunque venga de una redirección (/tapping.html -> /tapping).
function respaldo(request) {
  return caches.match(request)
    .then((r) => r || caches.match('./tapping.html'))
    .then((r) => r ? new Response(r.body, { status: r.status, headers: r.headers }) : r);
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

  // Audios: el reproductor pide trozos del archivo (cabecera Range) para poder
  // saltar a otro punto. Si respondemos con el archivo entero, Safari/iPhone
  // vuelve el audio al principio. Por eso:
  // - si el audio ya está guardado, servimos exactamente el trozo pedido (206);
  // - si no, dejamos que vaya directo a la red y lo guardamos entero en
  //   segundo plano para poder usarlo sin conexión la próxima vez.
  const range = request.headers.get('range');
  if (range) {
    event.respondWith(
      caches.match(request.url).then((cached) => {
        if (cached) return trozoDeAudio(cached, range);
        event.waitUntil(guardarAudioEntero(request.url));
        return fetch(request);
      })
    );
    return;
  }

  // Páginas (landing, app, legal) y cascarón de la app: red primero
  // (sin caché HTTP), caché como respaldo. Así la landing nunca se queda
  // en una versión antigua para quien ya tiene la app instalada.
  const esPagina = request.mode === 'navigate';
  if (esPagina || isCoreAsset(request.url)) {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then((fresh) => {
          // Solo se guarda copia del cascarón de la app, no de cada visita
          // a la landing con enlaces distintos (?utm_source=...).
          if (fresh && fresh.ok && isCoreAsset(request.url)) {
            const copy = fresh.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return fresh;
        })
        .catch(() => respaldo(request))
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

// Devuelve solo el trozo del audio que pide el reproductor (respuesta 206).
function trozoDeAudio(cached, range) {
  return cached.arrayBuffer().then((buf) => {
    const total = buf.byteLength;
    const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (!m[1] && m[2]) { start = Math.max(0, total - parseInt(m[2], 10)); end = total - 1; }
    end = Math.min(end, total - 1);
    if (start >= total || start > end) {
      return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
    }
    return new Response(buf.slice(start, end + 1), {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Type': cached.headers.get('Content-Type') || 'audio/mpeg',
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
      },
    });
  });
}

// Guarda el audio completo (sin Range) para usarlo sin conexión.
function guardarAudioEntero(url) {
  return fetch(url, { cache: 'no-store' })
    .then((res) => {
      if (res && res.status === 200) {
        return caches.open(CACHE_NAME).then((cache) => cache.put(url, res));
      }
    })
    .catch(() => {});
}
