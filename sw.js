/**
 * sw.js — Service Worker.
 *
 * Hace dos cosas:
 *   1. Cachea el app shell para que la PWA abra sin conexión.
 *   2. Atiende los clicks en los botones de la notificación ("Ya la tomé" /
 *      "Posponer") y se los reenvía a la página abierta.
 *
 * Cuando la app se despliegue con Web Push real (vía OneSignal o FCM), aquí
 * se agrega el listener 'push' — el resto de la lógica ya está lista.
 */

// Subir este número al cambiar SHELL: fuerza a descartar la caché anterior.
const CACHE = 'pilltime-v4';

// config.js queda FUERA a propósito: es el archivo que decide si la app habla
// con el backend o con localStorage. Una versión vieja no rompe nada visible,
// solo hace que la app se comporte distinto a lo que dice el código — el peor
// tipo de fallo. GitHub Pages lo sirve con max-age=600, así que además se
// pide con cache:'no-store' más abajo.
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/auth.js',
  './js/store.js',
  './js/store.remote.js',
  './js/notify.js',
  './js/scheduler.js',
  './js/app.js',
  './manifest.json',
  './icon.svg'
];

self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(claves => Promise.all(claves.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** Network-first: si hay red usamos la versión fresca; si no, la cacheada. */
self.addEventListener('fetch', ev => {
  if (ev.request.method !== 'GET') return;

  // config.js siempre desde la red, saltándose incluso la caché HTTP del
  // navegador. Sin esto, tras cambiar API_URL o CLIENT_ID la app seguiría
  // usando los valores anteriores hasta diez minutos, sin ninguna señal.
  if (ev.request.url.indexOf('/js/config.js') !== -1) {
    ev.respondWith(
      fetch(ev.request, { cache: 'no-store' })
        .catch(() => caches.match(ev.request))
    );
    return;
  }

  ev.respondWith(
    fetch(ev.request)
      .then(res => {
        const copia = res.clone();
        caches.open(CACHE).then(c => c.put(ev.request, copia)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(ev.request).then(r => r || caches.match('./index.html')))
  );
});

/** Click en la notificación o en uno de sus botones. */
self.addEventListener('notificationclick', ev => {
  const accion = ev.action || 'abrir';
  const dosisId = (ev.notification.data || {}).dosisId;
  ev.notification.close();

  ev.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientes => {
      // Con la app abierta: le pasamos la acción y la enfocamos.
      for (const c of clientes) {
        c.postMessage({ accion, dosisId });
        if ('focus' in c) return c.focus();
      }
      // Cerrada: la abrimos.
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});

/**
 * Listener de Web Push. Hoy no se dispara porque en local no hay servidor de
 * push; queda cableado para el despliegue.
 */
self.addEventListener('push', ev => {
  let datos = { titulo: '💊 PillTime', cuerpo: 'Tienes una toma pendiente.' };
  try { datos = { ...datos, ...ev.data.json() }; } catch (e) { /* payload vacío */ }

  ev.waitUntil(
    self.registration.showNotification(datos.titulo, {
      body: datos.cuerpo,
      tag: datos.tag || 'pilltime-push',
      renotify: true,
      requireInteraction: true,
      icon: './icon.svg',
      badge: './icon.svg',
      vibrate: [300, 120, 300, 120, 300],
      data: datos,
      actions: [
        { action: 'tomada', title: '✓ Ya la tomé' },
        { action: 'posponer', title: '⏱ Posponer' }
      ]
    })
  );
});
