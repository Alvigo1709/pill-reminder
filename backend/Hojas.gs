/**
 * Hojas.gs — Capa de acceso a datos.
 *
 * Traduce entre filas del Sheet y objetos de JavaScript. Todo se busca por
 * NOMBRE de columna, nunca por posición: así puedes reordenar o insertar
 * columnas en el Sheet sin romper el código.
 *
 * Es el equivalente en el servidor de js/store.js del frontend.
 */

/* ───────────────────────── acceso base ───────────────────────── */

function libro_() {
  return SpreadsheetApp.openById(SHEET_ID);
}

function hoja_(nombre) {
  const h = libro_().getSheetByName(nombre);
  if (!h) throw new Error('No existe la pestaña "' + nombre + '" en el Sheet.');
  return h;
}

/** Encabezados de la fila 1, normalizados. */
function encabezados_(nombreHoja) {
  const h = hoja_(nombreHoja);
  return h.getRange(1, 1, 1, h.getLastColumn())
    .getValues()[0]
    .map(function (v) { return String(v).trim(); });
}

/**
 * Lee la hoja completa como array de objetos.
 * Cada objeto lleva `_fila` con su número de fila real, para poder actualizarlo.
 */
function leerHoja_(nombreHoja) {
  const h = hoja_(nombreHoja);
  const ultimaFila = h.getLastRow();
  if (ultimaFila < 2) return [];

  const cols = encabezados_(nombreHoja);
  const valores = h.getRange(2, 1, ultimaFila - 1, cols.length).getValues();

  return valores.reduce(function (acc, fila, i) {
    // Ignora filas totalmente vacías (pasa al importar desde Excel).
    const vacia = fila.every(function (v) { return v === '' || v === null; });
    if (vacia) return acc;

    const obj = { _fila: i + 2 };
    cols.forEach(function (col, j) { obj[col] = fila[j]; });
    acc.push(obj);
    return acc;
  }, []);
}

/** Primera fila cuyo campo `columna` coincide con `valor`. */
function buscarFila_(nombreHoja, columna, valor) {
  const objetivo = String(valor).trim().toLowerCase();
  const filas = leerHoja_(nombreHoja);
  for (var i = 0; i < filas.length; i++) {
    if (String(filas[i][columna]).trim().toLowerCase() === objetivo) return filas[i];
  }
  return null;
}

/** Agrega una fila respetando el orden de los encabezados. */
function agregarFila_(nombreHoja, obj) {
  const cols = encabezados_(nombreHoja);
  const fila = cols.map(function (c) {
    return obj[c] === undefined || obj[c] === null ? '' : obj[c];
  });
  hoja_(nombreHoja).appendRow(fila);
  return obj;
}

/** Actualiza solo las columnas presentes en `cambios`. */
function actualizarFila_(nombreHoja, numeroFila, cambios) {
  const h = hoja_(nombreHoja);
  const cols = encabezados_(nombreHoja);

  Object.keys(cambios).forEach(function (clave) {
    const j = cols.indexOf(clave);
    if (j === -1) return;                       // columna inexistente: se ignora
    h.getRange(numeroFila, j + 1).setValue(cambios[clave]);
  });
}

/* ───────────────────── normalización de tipos ───────────────────── */

/*
 * Google Sheets convierte "08:00" en un objeto Date y "2026-09-25" en fecha.
 * Como el código compara cadenas, hay que devolverlas a texto al leer.
 * Las columnas ya vienen con formato de texto en la plantilla, pero esto
 * protege por si alguien escribe a mano y Sheets lo reinterpreta.
 */

/** Cualquier cosa → "HH:MM" */
function aHora_(valor) {
  if (valor === '' || valor === null || valor === undefined) return '';
  if (Object.prototype.toString.call(valor) === '[object Date]') {
    return Utilities.formatDate(valor, zonaHoraria_(), 'HH:mm');
  }
  const s = String(valor).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : s;
}

/**
 * La celda `horarios` → array de "HH:MM".
 *
 * Con varias tomas la celda dice "08:00|15:00|22:00", que Sheets no sabe
 * interpretar y deja como texto. Pero con UNA sola toma dice "16:03", y eso
 * Sheets sí lo reconoce: lo convierte en valor de hora y al leerlo devuelve
 * un Date del 30/12/1899, su fecha de origen.
 *
 * Por eso hay que descartar el caso Date ANTES de convertir a texto: si se
 * hace al revés, el Date se vuelve "Sat Dec 30 1899 16:03:44 GMT..." y ya no
 * hay forma de reconocerlo como hora.
 */
function aHorarios_(valor) {
  if (valor === '' || valor === null || valor === undefined) return [];

  if (Object.prototype.toString.call(valor) === '[object Date]') {
    return [aHora_(valor)];
  }

  return String(valor)
    .split('|')
    .map(function (h) { return aHora_(h); })
    .filter(function (h) { return /^\d{2}:\d{2}$/.test(h); });
}

/** Cualquier cosa → "YYYY-MM-DD" */
function aFecha_(valor) {
  if (valor === '' || valor === null || valor === undefined) return '';
  if (Object.prototype.toString.call(valor) === '[object Date]') {
    return Utilities.formatDate(valor, zonaHoraria_(), 'yyyy-MM-dd');
  }
  return String(valor).trim();
}

/** Sheets devuelve booleanos como true/false o como "TRUE"/"VERDADERO". */
function aBool_(valor) {
  if (valor === true) return true;
  if (valor === false || valor === '' || valor === null) return false;
  const s = String(valor).trim().toUpperCase();
  return s === 'TRUE' || s === 'VERDADERO' || s === 'SI' || s === 'SÍ' || s === '1';
}

/**
 * Pone en formato TEXTO las columnas de horas y fechas.
 *
 * Es la defensa de raíz contra la conversión automática: si la celda ya está
 * marcada como texto, Sheets guarda "16:03" tal cual en vez de volverlo un
 * valor de hora. Se ejecuta desde instalarTriggers() y desde repararHorarios().
 */
function forzarFormatoTexto_() {
  const porHoja = {
    'Usuarios': ['fecha_alta'],
    'Medicamentos': ['horarios', 'fecha_inicio', 'fecha_fin', 'dosis'],
    'Dosis': ['fecha', 'hora_programada', 'hora_confirmada',
              'ultimo_recordatorio', 'posponer_hasta']
  };

  Object.keys(porHoja).forEach(function (nombre) {
    const h = hoja_(nombre);
    const cols = encabezados_(nombre);

    porHoja[nombre].forEach(function (col) {
      const j = cols.indexOf(col);
      if (j === -1) return;
      h.getRange(1, j + 1, h.getMaxRows(), 1).setNumberFormat('@');
    });
  });
}

function zonaHoraria_() {
  return Session.getScriptTimeZone();
}

function hoyISO_(fecha) {
  return Utilities.formatDate(fecha || new Date(), zonaHoraria_(), 'yyyy-MM-dd');
}

function horaISO_(fecha) {
  return Utilities.formatDate(fecha || new Date(), zonaHoraria_(), 'HH:mm');
}

/** Combina "2026-09-25" + "08:00" en un Date en la zona del script. */
function aDate_(fecha, hora) {
  const p = String(fecha).split('-');
  const h = String(hora).split(':');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]),
                  Number(h[0]), Number(h[1]), 0, 0);
}

function uid_(prefijo) {
  return prefijo + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
}

/* ───────────────────── lectores de alto nivel ───────────────────── */

function leerUsuario_(email) {
  const u = buscarFila_(HOJA.usuarios, 'email', email);
  if (!u) return null;
  return {
    _fila: u._fila,
    id: u.id,
    email: String(u.email).trim().toLowerCase(),
    nombre: u.nombre || String(u.email).split('@')[0],
    rol: String(u.rol || 'usuario').trim().toLowerCase(),
    activo: aBool_(u.activo),
    push_token: u.push_token || ''
  };
}

function leerMedicamentos_(email) {
  return leerHoja_(HOJA.medicamentos)
    .filter(function (m) {
      return String(m.usuario_email).trim().toLowerCase() === String(email).toLowerCase()
        && aBool_(m.activo);
    })
    .map(normalizarMedicamento_);
}

function normalizarMedicamento_(m) {
  return {
    _fila: m._fila,
    id: m.id,
    usuario_email: String(m.usuario_email).trim().toLowerCase(),
    nombre: String(m.nombre || ''),
    dosis: m.dosis === null || m.dosis === undefined ? '' : String(m.dosis),
    unidad: m.unidad || '',
    veces_al_dia: Number(m.veces_al_dia) || 0,
    horarios: aHorarios_(m.horarios),
    fecha_inicio: aFecha_(m.fecha_inicio),
    fecha_fin: aFecha_(m.fecha_fin),
    notas: m.notas || '',
    activo: aBool_(m.activo)
  };
}

function normalizarDosis_(d) {
  return {
    _fila: d._fila,
    id: d.id,
    medicamento_id: d.medicamento_id,
    usuario_email: String(d.usuario_email).trim().toLowerCase(),
    fecha: aFecha_(d.fecha),
    hora_programada: aHora_(d.hora_programada),
    estado: String(d.estado || 'pendiente').trim().toLowerCase(),
    hora_confirmada: aHora_(d.hora_confirmada),
    recordatorios_enviados: Number(d.recordatorios_enviados) || 0,
    ultimo_recordatorio: d.ultimo_recordatorio ? String(d.ultimo_recordatorio) : '',
    posponer_hasta: d.posponer_hasta ? String(d.posponer_hasta) : '',
    email_enviado: aBool_(d.email_enviado)
  };
}

function leerDosisDelDia_(email, fecha) {
  const dia = fecha || hoyISO_();
  return leerHoja_(HOJA.dosis)
    .map(normalizarDosis_)
    .filter(function (d) {
      return d.usuario_email === String(email).toLowerCase() && d.fecha === dia;
    })
    .sort(function (a, b) { return a.hora_programada < b.hora_programada ? -1 : 1; });
}

/** Todas las dosis pendientes de un día, de TODOS los usuarios. Para el trigger. */
function leerPendientesDelDia_(fecha) {
  const dia = fecha || hoyISO_();
  return leerHoja_(HOJA.dosis)
    .map(normalizarDosis_)
    .filter(function (d) { return d.fecha === dia && d.estado === 'pendiente'; });
}

function leerConfig_() {
  const cfg = {};
  Object.keys(CONFIG_DEFAULT).forEach(function (k) { cfg[k] = CONFIG_DEFAULT[k]; });

  leerHoja_(HOJA.config).forEach(function (fila) {
    const clave = String(fila.clave).trim();
    if (!clave) return;
    const valor = fila.valor;
    cfg[clave] = isNaN(Number(valor)) || valor === '' ? valor : Number(valor);
  });

  return cfg;
}
