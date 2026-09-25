/**
 * store.js — Capa de datos.
 *
 * TODA lectura y escritura de la app pasa por aquí. En local guarda en
 * localStorage; al migrar a Google Apps Script solo hay que reimplementar
 * los métodos de `Store` para que hagan fetch() contra el Web App. Ningún
 * otro archivo toca los datos directamente.
 *
 * El esquema replica 1:1 las hojas del Google Sheet:
 *
 *   Usuarios      → id | email | nombre | rol | activo | fecha_alta
 *   Medicamentos  → id | usuario_email | nombre | dosis | unidad | veces_al_dia |
 *                   horarios | fecha_inicio | fecha_fin | notas | activo
 *   Dosis         → id | medicamento_id | usuario_email | fecha | hora_programada |
 *                   estado | hora_confirmada | recordatorios_enviados |
 *                   ultimo_recordatorio | email_enviado
 *   Config        → clave | valor
 *
 * Todos los métodos son async a propósito: así la firma no cambia cuando
 * detrás haya una llamada de red a Apps Script.
 */
(function (global) {
  'use strict';

  const KEY = 'pilltime.v1';

  const CONFIG_DEFAULT = {
    intervaloRecordatorioMin: 5,
    avisoPrevioMin: 0,
    maxRecordatorios: 12,
    sonido: true,
    escalarEmailMin: 15
  };

  /* ───────────────────────── utilidades de fecha ───────────────────────── */

  /** "2026-09-25" en hora local (no UTC: toISOString desfasaría el día). */
  function hoyISO(d) {
    const f = d || new Date();
    const mm = String(f.getMonth() + 1).padStart(2, '0');
    const dd = String(f.getDate()).padStart(2, '0');
    return `${f.getFullYear()}-${mm}-${dd}`;
  }

  /** "08:05" a partir de un Date. */
  function horaISO(d) {
    const f = d || new Date();
    return `${String(f.getHours()).padStart(2, '0')}:${String(f.getMinutes()).padStart(2, '0')}`;
  }

  /** Combina "2026-09-25" + "08:00" en un Date local. */
  function aDate(fecha, hora) {
    const [a, m, d] = fecha.split('-').map(Number);
    const [h, min] = hora.split(':').map(Number);
    return new Date(a, m - 1, d, h, min, 0, 0);
  }

  function uid(prefijo) {
    return prefijo + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }

  /* ───────────────────────── persistencia cruda ───────────────────────── */

  function vacio() {
    return { usuarios: [], medicamentos: [], dosis: [], config: { ...CONFIG_DEFAULT }, sesion: null };
  }

  function leer() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return vacio();
      const db = JSON.parse(raw);
      // Config nueva sobre datos viejos: rellena claves faltantes.
      db.config = { ...CONFIG_DEFAULT, ...(db.config || {}) };
      db.usuarios = db.usuarios || [];
      db.medicamentos = db.medicamentos || [];
      db.dosis = db.dosis || [];
      return db;
    } catch (e) {
      console.error('[store] datos corruptos, reiniciando', e);
      return vacio();
    }
  }

  function escribir(db) {
    localStorage.setItem(KEY, JSON.stringify(db));
    return db;
  }

  /* ───────────────────────────── Store ───────────────────────────── */

  const Store = {

    /* ---- Sesión y usuarios ---- */

    async sesionActual() {
      return leer().sesion;
    },

    /**
     * Valida el correo contra la lista de autorizados.
     * En Apps Script esto se sustituye por la verificación del ID token de
     * Google + búsqueda en la hoja Usuarios.
     */
    async login(email) {
      const correo = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
        throw new Error('Ese correo no tiene un formato válido.');
      }

      const db = leer();

      // Arranque en frío: el primer correo que entra se vuelve administrador.
      if (db.usuarios.length === 0) {
        db.usuarios.push({
          id: uid('usr'),
          email: correo,
          nombre: correo.split('@')[0],
          rol: 'admin',
          activo: true,
          fecha_alta: hoyISO()
        });
      }

      const usuario = db.usuarios.find(u => u.email === correo);
      if (!usuario) throw new Error('Ese correo no está autorizado. Pide acceso al administrador.');
      if (!usuario.activo) throw new Error('Tu acceso está desactivado.');

      db.sesion = usuario.email;
      escribir(db);
      return usuario;
    },

    async logout() {
      const db = leer();
      db.sesion = null;
      escribir(db);
    },

    async usuarios() {
      return leer().usuarios;
    },

    async agregarUsuario(email, nombre) {
      const correo = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) throw new Error('Correo inválido.');

      const db = leer();
      if (db.usuarios.some(u => u.email === correo)) throw new Error('Ese correo ya está autorizado.');

      const usuario = {
        id: uid('usr'),
        email: correo,
        nombre: nombre || correo.split('@')[0],
        rol: 'usuario',
        activo: true,
        fecha_alta: hoyISO()
      };
      db.usuarios.push(usuario);
      escribir(db);
      return usuario;
    },

    async quitarUsuario(id) {
      const db = leer();
      const usuario = db.usuarios.find(u => u.id === id);
      if (!usuario) return;
      if (usuario.email === db.sesion) throw new Error('No puedes quitarte a ti mismo.');
      db.usuarios = db.usuarios.filter(u => u.id !== id);
      escribir(db);
    },

    /* ---- Medicamentos ---- */

    async medicamentos(email) {
      return leer().medicamentos.filter(m => m.usuario_email === email && m.activo);
    },

    async medicamento(id) {
      return leer().medicamentos.find(m => m.id === id) || null;
    },

    async guardarMedicamento(med) {
      const db = leer();

      if (med.id) {
        const i = db.medicamentos.findIndex(m => m.id === med.id);
        if (i === -1) throw new Error('Medicamento no encontrado.');
        db.medicamentos[i] = { ...db.medicamentos[i], ...med };
        // Cambió el horario: las dosis futuras aún no confirmadas quedan obsoletas.
        db.dosis = db.dosis.filter(
          d => !(d.medicamento_id === med.id && d.estado === 'pendiente' && d.fecha >= hoyISO())
        );
        escribir(db);
        return db.medicamentos[i];
      }

      const nuevo = {
        id: uid('med'),
        usuario_email: med.usuario_email,
        nombre: med.nombre,
        dosis: med.dosis || '',
        unidad: med.unidad || '',
        veces_al_dia: Number(med.veces_al_dia),
        horarios: med.horarios,           // array de "HH:MM"
        fecha_inicio: med.fecha_inicio || hoyISO(),
        fecha_fin: med.fecha_fin || '',
        notas: med.notas || '',
        activo: true
      };
      db.medicamentos.push(nuevo);
      escribir(db);
      return nuevo;
    },

    /** Baja lógica: conserva el historial de dosis ya tomadas. */
    async eliminarMedicamento(id) {
      const db = leer();
      const med = db.medicamentos.find(m => m.id === id);
      if (med) med.activo = false;
      db.dosis = db.dosis.filter(d => !(d.medicamento_id === id && d.estado === 'pendiente'));
      escribir(db);
    },

    /* ---- Dosis ---- */

    /**
     * Materializa en la tabla Dosis las tomas que le corresponden al día.
     * Idempotente: si ya existe la fila (medicamento + fecha + hora) no la duplica.
     * Es el equivalente exacto de lo que hará el trigger diario en Apps Script.
     */
    async generarDosisDelDia(email, fecha) {
      const dia = fecha || hoyISO();
      const db = leer();
      let creadas = 0;

      db.medicamentos
        .filter(m => m.usuario_email === email && m.activo)
        .filter(m => (!m.fecha_inicio || m.fecha_inicio <= dia) && (!m.fecha_fin || m.fecha_fin >= dia))
        .forEach(med => {
          (med.horarios || []).forEach(hora => {
            const existe = db.dosis.some(
              d => d.medicamento_id === med.id && d.fecha === dia && d.hora_programada === hora
            );
            if (existe) return;

            db.dosis.push({
              id: uid('dos'),
              medicamento_id: med.id,
              usuario_email: email,
              fecha: dia,
              hora_programada: hora,
              estado: 'pendiente',           // pendiente | tomada | omitida | vencida
              hora_confirmada: '',
              recordatorios_enviados: 0,
              ultimo_recordatorio: '',
              posponer_hasta: '',
              email_enviado: false
            });
            creadas++;
          });
        });

      if (creadas) escribir(db);
      return creadas;
    },

    async dosisDelDia(email, fecha) {
      const dia = fecha || hoyISO();
      const db = leer();
      return db.dosis
        .filter(d => d.usuario_email === email && d.fecha === dia)
        .map(d => ({ ...d, medicamento: db.medicamentos.find(m => m.id === d.medicamento_id) || null }))
        .filter(d => d.medicamento)
        .sort((a, b) => a.hora_programada.localeCompare(b.hora_programada));
    },

    async historial(email, dias) {
      const db = leer();
      const desde = new Date();
      desde.setDate(desde.getDate() - (dias || 30));
      const limite = hoyISO(desde);

      return db.dosis
        .filter(d => d.usuario_email === email && d.fecha >= limite)
        .map(d => ({ ...d, medicamento: db.medicamentos.find(m => m.id === d.medicamento_id) || null }))
        .filter(d => d.medicamento)
        .sort((a, b) => (b.fecha + b.hora_programada).localeCompare(a.fecha + a.hora_programada));
    },

    /** Cambia el estado de una dosis. `extra` permite fijar posponer_hasta, etc. */
    async marcarDosis(id, estado, extra) {
      const db = leer();
      const dosis = db.dosis.find(d => d.id === id);
      if (!dosis) throw new Error('Dosis no encontrada.');

      dosis.estado = estado;
      if (estado === 'tomada') dosis.hora_confirmada = horaISO();
      Object.assign(dosis, extra || {});
      escribir(db);
      return dosis;
    },

    /** Usado por el motor de recordatorios para llevar la cuenta de avisos. */
    async registrarRecordatorio(id) {
      const db = leer();
      const dosis = db.dosis.find(d => d.id === id);
      if (!dosis) return null;

      dosis.recordatorios_enviados = (dosis.recordatorios_enviados || 0) + 1;
      dosis.ultimo_recordatorio = new Date().toISOString();
      escribir(db);
      return dosis;
    },

    async marcarEmailEnviado(id) {
      const db = leer();
      const dosis = db.dosis.find(d => d.id === id);
      if (!dosis) return;
      dosis.email_enviado = true;
      escribir(db);
    },

    /* ---- Configuración ---- */

    async config() {
      return leer().config;
    },

    async guardarConfig(parcial) {
      const db = leer();
      db.config = { ...db.config, ...parcial };
      escribir(db);
      return db.config;
    },

    /* ---- Mantenimiento ---- */

    async exportarCSV(tabla) {
      const db = leer();
      const columnas = {
        usuarios: ['id', 'email', 'nombre', 'rol', 'activo', 'fecha_alta'],
        medicamentos: ['id', 'usuario_email', 'nombre', 'dosis', 'unidad', 'veces_al_dia',
                       'horarios', 'fecha_inicio', 'fecha_fin', 'notas', 'activo'],
        dosis: ['id', 'medicamento_id', 'usuario_email', 'fecha', 'hora_programada', 'estado',
                'hora_confirmada', 'recordatorios_enviados', 'ultimo_recordatorio', 'email_enviado']
      }[tabla];

      if (!columnas) throw new Error('Tabla desconocida: ' + tabla);

      const escapar = v => {
        const s = Array.isArray(v) ? v.join('|') : (v === undefined || v === null ? '' : String(v));
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };

      const filas = (db[tabla] || []).map(fila => columnas.map(c => escapar(fila[c])).join(','));
      return [columnas.join(','), ...filas].join('\n');
    },

    async borrarTodo() {
      localStorage.removeItem(KEY);
    },

    /** Datos de prueba para ver la app poblada sin capturar nada. */
    async cargarEjemplo(email) {
      const db = leer();
      const ahora = new Date();

      // Una dosis 2 minutos en el futuro, para que la alarma se dispare sola.
      const pronto = new Date(ahora.getTime() + 2 * 60000);

      const ejemplos = [
        {
          nombre: 'Paracetamol', dosis: '500', unidad: 'mg', veces_al_dia: 3,
          horarios: ['08:00', '14:00', '20:00'], notas: 'Tomar con alimentos'
        },
        {
          nombre: 'Vitamina D', dosis: '1', unidad: 'cápsula', veces_al_dia: 1,
          horarios: ['09:00'], notas: ''
        },
        {
          nombre: 'Prueba inmediata', dosis: '1', unidad: 'tableta', veces_al_dia: 1,
          horarios: [horaISO(pronto)], notas: 'Esta dispara la alarma en ~2 minutos'
        }
      ];

      ejemplos.forEach(e => {
        if (db.medicamentos.some(m => m.usuario_email === email && m.nombre === e.nombre)) return;
        db.medicamentos.push({
          id: uid('med'),
          usuario_email: email,
          fecha_inicio: hoyISO(),
          fecha_fin: '',
          activo: true,
          ...e
        });
      });

      escribir(db);
    }
  };

  global.Store = Store;
  global.Fechas = { hoyISO, horaISO, aDate, uid };

})(window);
