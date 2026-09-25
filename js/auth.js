/**
 * auth.js — Sign in with Google.
 *
 * Envuelve Google Identity Services. Lo único que nos interesa de ella es el
 * ID token (un JWT firmado por Google): lo mandamos a Apps Script en cada
 * petición y el backend lo valida contra los servidores de Google.
 *
 * Sobre la persistencia de sesión, que es lo delicado aquí:
 *
 *   Un ID token de Google dura UNA HORA y eso no se puede cambiar. La sesión
 *   larga no viene de guardar el token, sino de que Google mantiene su propia
 *   sesión (meses) y nos deja pedir tokens nuevos en silencio mediante One Tap.
 *
 *   Por eso hacemos tres cosas:
 *     1. Guardar el token en localStorage, no sessionStorage: sobrevive al
 *        cierre del navegador y evita pedir login dentro de la misma hora.
 *     2. Llamar a prompt() al arrancar. Con auto_select, si el usuario ya
 *        consintió antes, Google reemite sin que él toque nada.
 *     3. Renovar solo, cinco minutos antes de que el token caduque, para que
 *        nadie se quede fuera con la app abierta.
 *
 * Nunca manejamos contraseñas, y el CLIENT_ID es público por diseño.
 */
(function (global) {
  'use strict';

  var token = null;             // el JWT crudo
  var perfil = null;            // { email, nombre, exp }
  var alIniciarSesion = null;   // callback que dispara app.js
  var temporizador = null;      // renovación programada

  const CLAVE_SESION = 'pilltime.token';
  const MARGEN_MS = 5 * 60 * 1000;   // renovar 5 min antes de expirar

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
     * Arranca Google Identity Services.
     * `alEntrar(perfil, silencioso)` se llama en cada token nuevo, incluidos
     * los de renovación automática: app.js debe distinguirlos para no
     * reiniciar la pantalla a media sesión.
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
        auto_select: true,            // reentra sin preguntar si ya consintió
        cancel_on_tap_outside: false, // un clic fuera no debe cancelar el login
        use_fedcm_for_prompt: true,   // Chrome ya no permite One Tap sin esto
        itp_support: true             // Safari
      });

      // El botón es el plan B: si la reanudación silenciosa funciona, el
      // usuario nunca llega a verlo.
      const disponible = contenedor.clientWidth || contenedor.offsetWidth || 280;
      google.accounts.id.renderButton(contenedor, {
        theme: 'outline',
        size: 'large',
        width: Math.round(Math.min(360, Math.max(200, disponible))),
        text: 'signin_with',
        shape: 'pill',
        locale: 'es'
      });

      // 1. ¿Hay un token guardado que siga vigente? Entramos de inmediato.
      const guardado = Auth._recuperarGuardado();
      if (guardado) {
        Auth._recibir(guardado, true);
        return true;
      }

      // 2. Si no, pedimos a Google que reemita en silencio. Cuando lo logra,
      //    el callback entra solo; si no, queda el botón.
      Auth.renovar();
      return false;
    },

    /**
     * Pide un token nuevo. Con auto_select y consentimiento previo, Google lo
     * entrega sin interacción; si no puede, muestra One Tap o no hace nada y
     * el usuario usa el botón.
     */
    renovar: function () {
      try {
        google.accounts.id.prompt();
      } catch (e) {
        console.warn('[auth] no se pudo pedir renovación', e);
      }
    },

    _recibir: function (jwt, silencioso) {
      const datos = Auth.decodificar(jwt);
      if (!datos || !datos.email) {
        console.warn('[auth] token ilegible');
        return;
      }

      const eraMismoUsuario = perfil && perfil.email === String(datos.email).toLowerCase();

      token = jwt;
      perfil = {
        email: String(datos.email).toLowerCase(),
        nombre: datos.name || datos.given_name || String(datos.email).split('@')[0],
        exp: Number(datos.exp) * 1000
      };

      try {
        localStorage.setItem(CLAVE_SESION, jwt);
      } catch (e) { /* modo incógnito o almacenamiento lleno */ }

      Auth._programarRenovacion();

      // Una renovación del mismo usuario no es un login nuevo.
      if (alIniciarSesion) alIniciarSesion(perfil, silencioso || eraMismoUsuario);
    },

    /** Renueva sola antes de caducar: nadie se queda fuera con la app abierta. */
    _programarRenovacion: function () {
      clearTimeout(temporizador);
      if (!perfil) return;

      const faltan = perfil.exp - Date.now() - MARGEN_MS;
      temporizador = setTimeout(function () {
        Auth.renovar();
      }, Math.max(30000, faltan));
    },

    /** Token de localStorage, solo si aún le queda vida útil. */
    _recuperarGuardado: function () {
      try {
        const jwt = localStorage.getItem(CLAVE_SESION);
        if (!jwt) return null;

        const datos = Auth.decodificar(jwt);
        if (!datos || Number(datos.exp) * 1000 < Date.now() + 60000) {
          localStorage.removeItem(CLAVE_SESION);
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
      if (perfil && perfil.exp < Date.now() + 60000) {
        Auth.renovar();          // intenta recuperarse sin sacar al usuario
        return null;
      }
      return token;
    },

    perfil: function () {
      return perfil;
    },

    expirado: function () {
      return Boolean(token) && Boolean(perfil) && perfil.exp < Date.now() + 60000;
    },

    /** Cierre de sesión explícito: desactiva también la reentrada automática. */
    salir: function () {
      token = null;
      perfil = null;
      clearTimeout(temporizador);
      try {
        localStorage.removeItem(CLAVE_SESION);
        sessionStorage.removeItem(CLAVE_SESION);   // restos de la versión anterior
        if (global.google && google.accounts && google.accounts.id) {
          google.accounts.id.disableAutoSelect();
        }
      } catch (e) { /* nada que limpiar */ }
    }
  };

  global.Auth = Auth;

})(window);
