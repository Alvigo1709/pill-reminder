/**
 * push.js — Notificaciones con la app cerrada, vía Firebase Cloud Messaging.
 *
 * Por qué hace falta un intermediario:
 *
 *   El protocolo Web Push exige firmar cada envío con ECDSA sobre la curva
 *   P-256 (VAPID) y cifrar el contenido con ECDH + AES-128-GCM. Apps Script
 *   ofrece HMAC, RSA y digests, pero nada de curva elíptica ni AES-GCM, y no
 *   tiene crypto.subtle. No puede construir un envío válido por sí solo.
 *
 *   FCM resuelve eso: aquí el SDK obtiene un token de suscripción, y Apps
 *   Script solo manda un POST normal a la API de FCM, autenticado con un token
 *   OAuth2 que sí puede firmar (RS256, que es RSA). Google se encarga del
 *   resto.
 *
 * Reutilizamos el Service Worker que ya existe (sw.js) en vez del
 * firebase-messaging-sw.js por defecto: ese se busca en la raíz del dominio,
 * y en GitHub Pages la app vive en un subdirectorio.
 */
(function (global) {
  'use strict';

  var messaging = null;
  var tokenActual = null;

  const Push = {

    get soportado() {
      return 'serviceWorker' in navigator && 'PushManager' in global && global.PUSH_ACTIVO;
    },

    get configurado() {
      return Boolean(tokenActual);
    },

    /**
     * Pide permiso, obtiene el token de FCM y lo guarda en la hoja Usuarios.
     * Debe llamarse desde un gesto del usuario: los navegadores ignoran las
     * peticiones de permiso que no vienen de un clic.
     */
    async activar() {
      if (!this.soportado) {
        throw new Error('Este navegador no soporta notificaciones push.');
      }
      if (!global.firebase || !firebase.messaging) {
        throw new Error('No cargó el SDK de Firebase. Revisa tu conexión.');
      }

      const permiso = await Notify.pedirPermiso();
      if (permiso !== 'granted') {
        throw new Error(
          'No diste permiso de notificaciones. Actívalo desde el candado ' +
          'de la barra de direcciones.'
        );
      }

      if (!firebase.apps.length) firebase.initializeApp(global.FIREBASE_CONFIG);
      messaging = messaging || firebase.messaging();

      // Nuestro propio Service Worker, no el que Firebase busca por defecto.
      const registro = await navigator.serviceWorker.ready;

      const token = await messaging.getToken({
        vapidKey: global.VAPID_KEY,
        serviceWorkerRegistration: registro
      });

      if (!token) throw new Error('Firebase no devolvió un token de push.');

      tokenActual = token;
      await Store.guardarPushToken(token);

      this._escucharPrimerPlano();
      return token;
    },

    /**
     * Revalida el token en cada arranque.
     *
     * Los tokens de FCM caducan solos: cambio de navegador, limpieza de datos,
     * o simple rotación de Google. Si no se reenvía el nuevo a la hoja, los
     * avisos dejan de llegar sin ningún error visible.
     */
    async revalidar() {
      if (!this.soportado) return null;
      if (Notify.permiso !== 'granted') return null;
      if (!global.firebase || !firebase.messaging) return null;

      try {
        if (!firebase.apps.length) firebase.initializeApp(global.FIREBASE_CONFIG);
        messaging = messaging || firebase.messaging();

        const registro = await navigator.serviceWorker.ready;
        const token = await messaging.getToken({
          vapidKey: global.VAPID_KEY,
          serviceWorkerRegistration: registro
        });

        if (token && token !== tokenActual) {
          tokenActual = token;
          await Store.guardarPushToken(token);
          console.info('[push] token renovado');
        }

        this._escucharPrimerPlano();
        return token;
      } catch (e) {
        console.warn('[push] no se pudo revalidar el token', e);
        return null;
      }
    },

    /** Deja de recibir avisos en este dispositivo. */
    async desactivar() {
      try {
        if (messaging) await messaging.deleteToken();
      } catch (e) { /* puede que ya no existiera */ }
      tokenActual = null;
      await Store.guardarPushToken('');
    },

    /**
     * Mensajes que llegan con la app abierta. FCM no muestra notificación en
     * ese caso, y está bien: el Scheduler ya enseña su propia alarma. Lo que
     * sí conviene es refrescar, porque el servidor acaba de tocar los datos.
     */
    _escucharPrimerPlano() {
      if (!messaging || messaging._pilltimeEscuchando) return;
      messaging._pilltimeEscuchando = true;

      messaging.onMessage(function (payload) {
        console.info('[push] mensaje en primer plano', payload);
        if (global.Store && Store.sincronizar) {
          Store.sincronizar().catch(function () { /* el ciclo siguiente reintenta */ });
        }
        if (global.Scheduler && Scheduler.tick) Scheduler.tick();
      });
    }
  };

  global.Push = Push;

})(window);
