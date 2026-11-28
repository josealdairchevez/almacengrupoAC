'use strict';

/**
 * Service Worker PWA - Gestión de Almacén & Reverso AC
 * ----------------------------------------------------
 * - Pre-cachea el shell local y librerías CDN para abrir sin señal en piso.
 * - index.html: red primero (para recibir actualizaciones de GitHub Pages). Si la
 *   red falla o tarda más de NAV_TIMEOUT_MS, abre la copia guardada.
 * - Solo guarda archivos propios y las librerías de la lista. Firestore, Auth y
 *   las pruebas de red del SDK pasan directo a la red.
 * - Sube CACHE_VERSION cuando cambies la lista de archivos o este archivo.
 */

const CACHE_PREFIX = 'almacen-ac-';           // solo se borran cachés con este prefijo
const CACHE_VERSION = CACHE_PREFIX + 'v2';
const NAV_TIMEOUT_MS = 3000;

const APP_PAGE = './index.html';
const APP_PATHS = ['./', APP_PAGE].map((path) => new URL(path, self.location).pathname);

// Sin estos la app NO abre sin señal: si uno falla, la instalación se cancela
// y se conserva la versión anterior completa.
const REQUIRED_ASSETS = [
  APP_PAGE,
  'https://cdn.tailwindcss.com',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js'
];

// Deseables: si fallan, la app igual funciona
const OPTIONAL_ASSETS = [
  './manifest.json',
  './icon.svg',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700;800&display=swap'
];

// Únicos dominios externos que se guardan en caché
const CACHEABLE_HOSTS = ['cdn.tailwindcss.com', 'www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

async function precache(cache, url) {
  const isLocal = url.startsWith('./');
  let response;
  try {
    response = await fetch(url, isLocal ? { cache: 'reload' } : { mode: 'cors' });
  } catch (err) {
    if (isLocal) throw err;
    response = await fetch(url, { mode: 'no-cors' }); // CDN sin CORS: respuesta opaca
  }
  if (!response.ok && response.type !== 'opaque') {
    throw new Error(`[SW] ${response.status} al pre-cachear ${url}`);
  }
  await cache.put(url, response);
}

// 1. INSTALACIÓN
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await Promise.all(REQUIRED_ASSETS.map((url) => precache(cache, url)));
    await Promise.allSettled(OPTIONAL_ASSETS.map((url) => precache(cache, url)));
    await self.skipWaiting();
  })());
});

// 2. ACTIVACIÓN: borra solo las versiones anteriores de ESTA app
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

// Página de la app: red primero, con límite de espera
function appPage(event) {
  const network = fetch(event.request);
  const update = network.then(async (response) => {
    if (!response.ok) return;
    const copy = response.clone();
    const cache = await caches.open(CACHE_VERSION);
    await cache.put(APP_PAGE, copy);
  });
  event.waitUntil(update.catch(() => {}));

  return caches.match(APP_PAGE, { cacheName: CACHE_VERSION }).then((cached) => {
    if (!cached) return network;
    return Promise.race([
      network.then(
        (response) => (response.ok || response.type === 'opaqueredirect' ? response : cached),
        () => cached
      ),
      new Promise((resolve) => setTimeout(resolve, NAV_TIMEOUT_MS, cached))
    ]);
  });
}

// 3. INTERCEPTOR DE RED (FETCH)
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Estrategia A: solo la página principal. Otras navegaciones van directo a la red.
  if (request.mode === 'navigate') {
    if (sameOrigin && APP_PATHS.includes(url.pathname)) event.respondWith(appPage(event));
    return;
  }

  // Estrategia B: copia guardada primero y actualización por detrás
  const cacheable = sameOrigin || (
    CACHEABLE_HOSTS.includes(url.hostname) &&
    (url.hostname !== 'www.gstatic.com' || url.pathname.startsWith('/firebasejs/'))
  );
  if (!cacheable) return;

  const network = fetch(request);
  const update = network.then(async (response) => {
    const copy = response.clone();
    const cache = await caches.open(CACHE_VERSION);
    // Una respuesta opaca puede ser un error: nunca reemplaza una copia que ya existe
    if (copy.ok || (copy.type === 'opaque' && !(await cache.match(request)))) {
      await cache.put(request, copy);
    }
  });
  event.waitUntil(update.catch(() => {}));
  event.respondWith(
    caches.match(request, { cacheName: CACHE_VERSION }).then((cached) => cached || network)
  );
});
