/**
 * store.remote.js — Capa de datos contra Google Apps Script.
 *
 * Reemplaza a window.Store cuando config.js tiene API_URL. Expone exactamente
 * la misma superficie de métodos que js/store.js, así que ni app.js ni
 * scheduler.js se enteran de que los datos ahora viajan por red.
 *
 * Estrategia de caché: una sola llamada `listar` trae medicamentos, dosis,
 * historial y configuración. Las lecturas se sirven de ahí; las escrituras
 * van al servidor y luego refrescan. Sin esto, cada repintado de pantalla
 * dispararía media docena de peticiones.
 */
(function (global) {
  'use strict';

  if (!global.MODO_REMOTO) return;   // modo local: store.js se queda como está

  var cache = null;
  var refrescando = null;
  var ultimoRefresco = 0;

  /* ───────────────────────── transporte ───────────────────────── */

  /**
   * Una petición a la API.
   *
   * Sin cabeceras personalizadas y con el cuerpo como texto plano: así el
   * navegador lo trata como "petición simple" y no dispara el preflight
   * OPTIONS, al que Apps Script no sabe responder.
   */
  async function llamar(accion, datos) {
    const token = Auth.token();
    if (!token) {
      const err = new Error('Tu sesión expiró. Vuelve a entrar con Google.');
      err.sesionExpirada = true;
      throw err;
    }

    var res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        body: JSON.stringify({ accion: accion, datos: datos || {}, idToken: token })
      });
    } catch (e) {
      throw new Error('No se pudo conectar con el servidor. Revisa tu conexión.');
    }

    const texto = await res.text();

    var json;
    try {
      json = JSON.parse(texto);
    } catch (e) {
      // Apps Script devuelve HTML cuando la implementación no es pública.
      if (texto.indexOf('<!DOCTYPE') === 0 || texto.indexOf('<html') !== -1) {
        throw new Error(
          'El Web App no está publicado como "Cualquier usuario". ' +
          'Revísalo en Implementar → Administrar implementaciones.'
        );
      }
      throw new Error('El servidor respondió algo inesperado.');
    }

    if (!json.ok) {
      const err = new Error(json.error || 'Error del servidor.');
      if (/token|sesión|expirad/i.test(json.error || '')) err.sesionExpirada = true;
      throw err;
    }

    return json.datos;
  }

  /** Trae el estado completo del servidor. Concurrente-segura. */
  async function refrescar(forzar) {
    if (refrescando) return refrescando;

    if (!forzar && cache && (Date.now() - ultimoRefresco) < REFRESCO_SEGUNDOS * 1000) {
      return cache;
    }

    refrescando = llamar('listar')
      .then(function (datos) {
        cache = datos;
        ultimoRefresco = Date.now();
        return cache;
      })
      .finally(function () { refrescando = null; });

    return refrescando;
  }

  /** Lee de caché sin ir a la red; si no hay nada aún, la llena. */
  async function leer() {
    if (!cache) await refrescar(true);
    return cache;
  }

  /** Une cada dosis con su medicamento, como hace la versión local. */
  function conMedicamento(dosis, medicamentos) {
    const porId = {};
    medicamentos.forEach(function (m) { porId[m.id] = m; });

    return dosis
      .map(function (d) {
        const copia = {};
        Object.keys(d).forEach(function (k) { copia[k] = d[k]; });
        copia.medicamento = porId[d.medicamento_id] || null;
        return copia;
      })
      .filter(function (d) { return d.medicamento; });
  }

  /* ───────────────────────── Store remoto ───────────────────────── */

  const StoreRemoto = {

    /* ---- Sesión ---- */

    async sesionActual() {
      const p = Auth.perfil();
      return p ? p.email : null;
    },

    /**
     * En remoto la identidad la da Google, no un campo de texto.
     * Esta llamada sirve para confirmar que el correo está autorizado
     * en la hoja Usuarios: si no lo está, el backend rechaza.
     */
    async login() {
      const datos = await refrescar(true);
      return datos.usuario;
    },

    async logout() {
      cache = null;
      ultimoRefresco = 0;
      Auth.salir();
    },

    /* ---- Usuarios ---- */

    async usuarios() {
      return llamar('listarUsuarios');
    },

    async agregarUsuario(email, nombre) {
      return llamar('agregarUsuario', { email: email, nombre: nombre });
    },

    async quitarUsuario(idOEmail) {
      return llamar('quitarUsuario', { email: idOEmail });
    },

    /* ---- Medicamentos ---- */

    async medicamentos() {
      const d = await leer();
      return d.medicamentos;
    },

    async medicamento(id) {
      const d = await leer();
      return d.medicamentos.filter(function (m) { return m.id === id; })[0] || null;
    },

    async guardarMedicamento(med) {
      const res = await llamar('guardarMedicamento', med);
      await refrescar(true);
      return res;
    },

    async eliminarMedicamento(id) {
      await llamar('eliminarMedicamento', { id: id });
      await refrescar(true);
    },

    /* ---- Dosis ---- */

    /**
     * El servidor materializa las dosis en cada `listar` y en el trigger
     * diario, así que aquí basta con refrescar.
     */
    async generarDosisDelDia() {
      await refrescar(false);
      return 0;
    },

    async dosisDelDia() {
      const d = await leer();
      return conMedicamento(d.dosis, d.medicamentos);
    },

    async historial() {
      const d = await leer();
      return conMedicamento(d.historial, d.medicamentos);
    },

    async marcarDosis(id, estado, extra) {
      if (estado === 'pendiente' && extra && extra.posponer_hasta) {
        const minutos = Math.max(
          1, Math.round((new Date(extra.posponer_hasta) - Date.now()) / 60000)
        );
        await llamar('marcarDosis', { id: id, estado: 'posponer', minutos: minutos });
      } else {
        await llamar('marcarDosis', { id: id, estado: estado });
      }
      await refrescar(true);
      return { id: id, estado: estado };
    },

    /**
     * Solo toca la caché, a propósito.
     *
     * Quien lleva la cuenta real es el trigger de 5 minutos del servidor, que
     * es el que manda el email y el push. Si el cliente también incrementara
     * la hoja, los dos se pisarían y la dosis alcanzaría maxRecordatorios
     * antes de tiempo. Aquí solo mantenemos la cadencia de la alarma en
     * pantalla mientras la app está abierta.
     */
    async registrarRecordatorio(id) {
      if (!cache) return null;
      const dosis = cache.dosis.filter(function (d) { return d.id === id; })[0];
      if (!dosis) return null;

      dosis.recordatorios_enviados = (dosis.recordatorios_enviados || 0) + 1;
      dosis.ultimo_recordatorio = new Date().toISOString();
      return dosis;
    },

    /** El email lo manda el servidor. Aquí no hay nada que registrar. */
    async marcarEmailEnviado() {
      return;
    },

    /* ---- Configuración ---- */

    async config() {
      const d = await leer();
      return d.config;
    },

    async guardarConfig(parcial) {
      const cfg = await llamar('guardarConfig', parcial);
      if (cache) cache.config = cfg;
      return cfg;
    },

    /* ---- Push (fase 4) ---- */

    async guardarPushToken(token) {
      return llamar('guardarPushToken', { token: token });
    },

    /* ---- Mantenimiento ---- */

    async exportarCSV(tabla) {
      const d = await leer();

      const columnas = {
        medicamentos: ['id', 'usuario_email', 'nombre', 'dosis', 'unidad', 'veces_al_dia',
                       'horarios', 'fecha_inicio', 'fecha_fin', 'notas', 'activo'],
        dosis: ['id', 'medicamento_id', 'usuario_email', 'fecha', 'hora_programada', 'estado',
                'hora_confirmada', 'recordatorios_enviados', 'ultimo_recordatorio', 'email_enviado']
      }[tabla];

      if (!columnas) {
        throw new Error('En modo remoto los datos ya viven en tu Google Sheet: ' +
                        'exporta desde ahí con Archivo → Descargar.');
      }

      const filas = (tabla === 'dosis' ? d.historial : d.medicamentos).map(function (fila) {
        return columnas.map(function (c) {
          const v = Array.isArray(fila[c]) ? fila[c].join('|')
                  : (fila[c] === undefined || fila[c] === null ? '' : String(fila[c]));
          return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
        }).join(',');
      });

      return [columnas.join(','), ...filas].join('\n');
    },

    async borrarTodo() {
      throw new Error('En modo remoto los datos viven en tu Google Sheet. ' +
                      'Bórralos desde ahí si de verdad lo necesitas.');
    },

    async cargarEjemplo() {
      throw new Error('Los datos de ejemplo son solo del modo local. ' +
                      'Registra un medicamento real desde la pestaña Medicamentos.');
    },

    /** Para que app.js pueda forzar una recarga tras un cambio externo. */
    async sincronizar() {
      return refrescar(true);
    }
  };

  global.Store = StoreRemoto;

  // Relectura periódica: si el trigger del servidor marcó algo, la UI se entera.
  setInterval(function () {
    if (Auth.token()) refrescar(true).catch(function () { /* se reintenta al siguiente */ });
  }, REFRESCO_SEGUNDOS * 1000);

})(window);
