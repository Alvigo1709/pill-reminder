/**
 * auth.js — Sign in with Google.
 *
 * Envuelve la librería Google Identity Services. Lo único que nos interesa de
 * ella es el ID token (un JWT firmado por Google): lo mandamos a Apps Script
 * en cada petición y el backend lo valida contra los servidores de Google.
 *
 * Nunca manejamos contraseñas, y el CLIENT_ID es público por diseño: solo
 * identifica a la aplicación, no autoriza nada por sí mismo.
 *
 * En modo local este archivo no hace nada: la sesión la resuelve store.js
 * contra localStorage.
 */
(function (global) {
  'use strict';

  var token = null;           // el JWT crudo
  var perfil = null;          // { email, nombre, exp }
  var alIniciarSesion = null; // callback que dispara app.js

  const CLAVE_SESION = 'pilltime.token';

  const Auth = {

    /** Decodifica el payload del JWT. Solo para leer email y expiración. */
    decodificar: function (jwt) {
      try {
        const cuerpo = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const json = decodeURIComponent(
          atob(cuerpo).split('').map(function (c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
          }).join('')
        );
        return JSON.parse(json);
      } catch (e) {
        return null;
      }
    },

    /**
     * Arranca Google Identity Services y pinta el botón.
     * `alEntrar(perfil)` se llama cuando el usuario se autentica con éxito.
     */
    iniciar: function (contenedor, alEntrar) {
      alIniciarSesion = alEntrar;

      if (!global.google || !google.accounts || !google.accounts.id) {
        throw new Error('No cargó la librería de Google. ¿Hay conexión a internet?');
      }
      if (!CLIENT_ID || CLIENT_ID.indexOf('PEGA_AQUI') === 0) {
        throw new Error('Falta poner el CLIENT_ID en js/config.js.');
      }

      google.accounts.id.initialize({
        client_id: CLIENT_ID,
        callback: function (respuesta) { Auth._recibir(respuesta.credential); },
        auto_select: true,          // reentra solo si ya hay sesión de Google
        cancel_on_tap_outside: false
      });

      // El botón se renderiza con ancho fijo en píxeles, así que hay que
      // calcularlo: con un valor duro desborda la tarjeta en pantallas angostas.
      const disponible = contenedor.clientWidth || contenedor.offsetWidth || 280;
      const ancho = Math.round(Math.min(360, Math.max(200, disponible)));

      google.accounts.id.renderButton(contenedor, {
        theme: 'outline',
        size: 'large',
        width: ancho,
        text: 'signin_with',
        shape: 'pill',
        locale: 'es'
      });

      // Intenta reanudar sin pedir nada al usuario.
      const guardado = Auth._recuperarGuardado();
      if (guardado) {
        Auth._recibir(guardado, true);
        return true;
      }

      return false;
    },

    _recibir: function (jwt, silencioso) {
      const datos = Auth.decodificar(jwt);
      if (!datos || !datos.email) {
        console.warn('[auth] token ilegible');
        return;
      }

      token = jwt;
      perfil = {
        email: String(datos.email).toLowerCase(),
        nombre: datos.name || datos.given_name || String(datos.email).split('@')[0],
        exp: Number(datos.exp) * 1000
      };

      try {
        sessionStorage.setItem(CLAVE_SESION, jwt);
      } catch (e) { /* modo incógnito */ }

      if (alIniciarSesion) alIniciarSesion(perfil, silencioso);
    },

    /** Token de sessionStorage, solo si aún no expiró. */
    _recuperarGuardado: function () {
      try {
        const jwt = sessionStorage.getItem(CLAVE_SESION);
        if (!jwt) return null;
        const datos = Auth.decodificar(jwt);
        if (!datos || Number(datos.exp) * 1000 < Date.now() + 60000) {
          sessionStorage.removeItem(CLAVE_SESION);
          return null;
        }
        return jwt;
      } catch (e) {
        return null;
      }
    },

    /** El JWT para mandar a la API, o null si no hay sesión válida. */
    token: function () {
      if (!token) return null;
      // Un minuto de margen: evita mandar un token que expira en pleno vuelo.
      if (perfil && perfil.exp < Date.now() + 60000) return null;
      return token;
    },

    perfil: function () {
      return perfil;
    },

    /** true si había sesión pero el token ya caducó. */
    expirado: function () {
      return Boolean(token) && Boolean(perfil) && perfil.exp < Date.now() + 60000;
    },

    salir: function () {
      token = null;
      perfil = null;
      try {
        sessionStorage.removeItem(CLAVE_SESION);
        if (global.google && google.accounts && google.accounts.id) {
          google.accounts.id.disableAutoSelect();
        }
      } catch (e) { /* nada que limpiar */ }
    }
  };

  global.Auth = Auth;

})(window);
