/**
 * notify.js — Canales de aviso del lado del navegador.
 *
 * Tres capas, de menos a más intrusiva:
 *   1. Título de la pestaña parpadeando  → sirve aunque la pestaña esté en segundo plano.
 *   2. Notification API                  → aparece fuera del navegador (requiere permiso).
 *   3. Alarma a pantalla completa + sonido → cuando la pestaña está visible.
 *
 * Nota importante para la migración: la Notification API NO funciona dentro de
 * un iframe cross-origin, que es exactamente cómo Apps Script sirve sus Web Apps.
 * Por eso el frontend debe vivir en origen propio (localhost ahora, GitHub Pages
 * después) y Apps Script quedarse como API.
 */
(function (global) {
  'use strict';

  let audioCtx = null;
  let tituloOriginal = document.title;
  let flashTimer = null;

  const Notify = {

    /* ─────────────── permisos ─────────────── */

    get soportado() {
      return 'Notification' in global;
    },

    get permiso() {
      return this.soportado ? Notification.permission : 'unsupported';
    },

    /** Debe llamarse desde un gesto del usuario (click), o los navegadores lo ignoran. */
    async pedirPermiso() {
      if (!this.soportado) return 'unsupported';
      if (Notification.permission === 'granted') return 'granted';
      try {
        return await Notification.requestPermission();
      } catch (e) {
        console.warn('[notify] permiso rechazado', e);
        return 'denied';
      }
    },

    /* ─────────────── notificación del sistema ─────────────── */

    /**
     * Lanza la notificación. Usa el Service Worker si está disponible porque
     * en Android es la única vía que permite botones de acción.
     */
    async enviar({ titulo, cuerpo, tag, requiereInteraccion = true, datos = {} }) {
      if (this.permiso !== 'granted') return false;

      const opciones = {
        body: cuerpo,
        tag: tag || 'pilltime',
        renotify: true,               // vuelve a vibrar aunque reemplace a una anterior
        requireInteraction: requiereInteraccion,
        icon: 'icon.svg',
        badge: 'icon.svg',
        vibrate: [300, 120, 300, 120, 300],
        data: datos,
        actions: [
          { action: 'tomada', title: '✓ Ya la tomé' },
          { action: 'posponer', title: '⏱ Posponer' }
        ]
      };

      try {
        const reg = await (navigator.serviceWorker ? navigator.serviceWorker.ready : Promise.reject());
        await reg.showNotification(titulo, opciones);
        return true;
      } catch (e) {
        // Sin Service Worker (p. ej. abierto como file://): notificación simple.
        try {
          delete opciones.actions;
          delete opciones.vibrate;
          const n = new Notification(titulo, opciones);
          n.onclick = () => { global.focus(); n.close(); };
          return true;
        } catch (e2) {
          console.warn('[notify] no se pudo notificar', e2);
          return false;
        }
      }
    },

    /* ─────────────── sonido ─────────────── */

    /**
     * Tres pitidos sintetizados con WebAudio. Sin archivos externos: así la app
     * funciona offline y no depende de ningún CDN.
     */
    sonar() {
      try {
        audioCtx = audioCtx || new (global.AudioContext || global.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();

        [0, 0.45, 0.9].forEach(retraso => {
          const t = audioCtx.currentTime + retraso;
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();

          osc.type = 'sine';
          osc.frequency.setValueAtTime(880, t);
          osc.frequency.setValueAtTime(1174, t + 0.14);

          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(0.28, t + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.32);

          osc.connect(gain).connect(audioCtx.destination);
          osc.start(t);
          osc.stop(t + 0.34);
        });
      } catch (e) {
        console.warn('[notify] sin audio', e);
      }
    },

    /** El primer click de la sesión desbloquea el audio (política de autoplay). */
    desbloquearAudio() {
      try {
        audioCtx = audioCtx || new (global.AudioContext || global.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
      } catch (e) { /* navegador sin WebAudio */ }
    },

    /* ─────────────── título parpadeante ─────────────── */

    iniciarFlash(texto) {
      if (flashTimer) return;
      let alterna = false;
      flashTimer = setInterval(() => {
        document.title = alterna ? tituloOriginal : '💊 ' + texto;
        alterna = !alterna;
      }, 1000);
    },

    detenerFlash() {
      if (!flashTimer) return;
      clearInterval(flashTimer);
      flashTimer = null;
      document.title = tituloOriginal;
    }
  };

  global.Notify = Notify;

})(window);
