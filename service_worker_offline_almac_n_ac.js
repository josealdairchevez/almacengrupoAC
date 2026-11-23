'use strict';

/**
 * Service Worker PWA - Gestión de Almacén & Reverso AC
 * ----------------------------------------------------
 * - Pre-cachea el shell local y librerías CDN para abrir sin señal en piso.
 * - Usa Network-First en index.html para recibir actualizaciones de GitHub Pages.
 * - Excluye peticiones de Firestore/Firebase Auth para no interferir con la
 *   persistencia offline nativa ni el tiempo real de Firebase.
 */

const CACHE_VERSION = 'almacen-ac-v1';

// Archivos propios del repositorio (GitHub Pages)
const LOCAL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg'
];

// Librerías externas necesarias para que la app abra con estilos y motor offline
const EXTERNAL_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js'
];

// Dominios de API en tiempo real que NO deben ser cacheados por el Service Worker
const BYPASS_HOSTS = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'www.google-analytics.com',
  'analytics.google.com'
];

// 1. INSTALACIÓN: Guarda recursos base de forma tolerante a fallos individuales
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async (cache) => {
      // Cachear archivos locales uno por uno para evitar abortar por un recurso opcional
      await Promise.allSettled(
        LOCAL_ASSETS.map(async (url) => {
          try {
            const response = await fetch(url, { cache: 'reload' });
            if (response && response.ok) {
              await cache.put(url, response);
            }
          } catch (err) {
            console.warn('[SW] No se pudo pre-cachear local:', url);
          }
        })
      );

      // Cachear CDN externos (acepta respuestas opacas no-cors si es necesario)
      await Promise.allSettled(
        EXTERNAL_ASSETS.map(async (url) => {
          try {
            const req = new Request(url, { mode: 'cors' });
            const res = await fetch(req);
            if (res && (res.ok || res.type === 'opaque')) {
              await cache.put(url, res);
            }
          } catch (_) {
            try {
              const opaqueRes = await fetch(new Request(url, { mode: 'no-cors' }));
              if (opaqueRes) {
                await cache.put(url, opaqueRes);
              }
            } catch (err2) {
              console.warn('[SW] No se pudo pre-cachear CDN:', url);
            }
          }
        })
      );
    }).then(() => self.skipWaiting())
  );
});

// 2. ACTIVACIÓN: Elimina cachés de versiones anteriores y toma el control inmediato
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((oldKey) => caches.delete(oldKey))
      )
    ).then(() => self.clients.claim())
  );
});

// 3. INTERCEPTOR DE RED (FETCH)
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Solo manejamos peticiones GET HTTP/HTTPS
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Dejar pasar libremente el tráfico en vivo de Firebase / Firestore
  if (BYPASS_HOSTS.some((host) => url.hostname.includes(host))) {
    return;
  }

  const isNavigation =
    request.mode === 'navigate' ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('/index.html');

  // Estrategia A: Network-First para la página principal (siempre actualizada si hay red)
  if (isNavigation) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const copy = networkResponse.clone();
            caches.open(CACHE_VERSION).then((cache) => {
              cache.put(request, copy.clone());
              cache.put('./index.html', copy);
            });
          }
          return networkResponse;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_VERSION);
          return (
            (await cache.match(request)) ||
            (await cache.match('./index.html')) ||
            (await cache.match('./'))
          );
        })
    );
    return;
  }

  // Estrategia B: Stale-While-Revalidate para scripts, estilos, fuentes e íconos
  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const cachedResponse = await cache.match(request);

      const networkFetch = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        })
        .catch(() => null);

      return cachedResponse || networkFetch;
    })
  );
});