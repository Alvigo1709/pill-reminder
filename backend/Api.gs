/**
 * Api.gs — Punto de entrada HTTP.
 *
 * El frontend manda un POST con { accion, datos, idToken } y recibe
 * { ok: true, datos } o { ok: false, error }.
 *
 * Nota de CORS: Apps Script no responde a peticiones OPTIONS. Por eso el
 * frontend manda el body como texto plano, sin cabeceras personalizadas:
 * así el navegador no dispara el preflight y la llamada pasa directo.
 */

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('Petición vacía.');
    }

    const req = JSON.parse(e.postData.contents);
    const usuario = autenticar_(req);
    const datos = despachar_(req.accion, usuario, req.datos || {});

    return json_({ ok: true, datos: datos });

  } catch (err) {
    // El mensaje va al cliente; la traza queda en el registro de ejecuciones.
    console.error(err.stack || err);
    return json_({ ok: false, error: String(err.message || err) });
  }
}

/** Sonda de vida: abre la URL del Web App en el navegador y deberías ver ok:true. */
function doGet() {
  return json_({
    ok: true,
    servicio: 'PillTime API',
    zonaHoraria: zonaHoraria_(),
    hoy: hoyISO_(),
    hora: horaISO_(),
    modoDesarrollo: MODO_DESARROLLO
  });
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ───────────────────────── autenticación ───────────────────────── */

/**
 * Devuelve el usuario autorizado o lanza error.
 *
 * Dos caminos:
 *   - Producción: valida el ID token contra Google y comprueba la hoja Usuarios.
 *   - Desarrollo: acepta el correo tal cual, pero SOLO si la implementación
 *     está publicada como "Solo yo" (ver Configuracion.gs).
 */
function autenticar_(req) {
  var email;

  if (MODO_DESARROLLO) {
    email = String(req.email || '').trim().toLowerCase();
    if (!email) throw new Error('Modo desarrollo: falta el campo "email".');
  } else {
    email = verificarToken_(req.idToken);
  }

  const usuario = leerUsuario_(email);
  if (!usuario) throw new Error('El correo ' + email + ' no está autorizado.');
  if (!usuario.activo) throw new Error('Tu acceso está desactivado.');

  return usuario;
}

/**
 * Valida un ID token de Google contra el endpoint oficial.
 * Sin esto, el Web App quedaría abierto a cualquiera que descubra la URL.
 */
function verificarToken_(idToken) {
  if (!idToken) throw new Error('Falta el token de sesión.');
  if (!CLIENT_ID) throw new Error('CLIENT_ID no está configurado en Configuracion.gs.');

  const res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );

  if (res.getResponseCode() !== 200) throw new Error('Token inválido.');

  const info = JSON.parse(res.getContentText());

  if (info.aud !== CLIENT_ID) throw new Error('Token emitido para otra aplicación.');
  if (Number(info.exp) * 1000 < Date.now()) throw new Error('Token expirado.');
  if (info.email_verified !== 'true' && info.email_verified !== true) {
    throw new Error('El correo de esa cuenta no está verificado.');
  }

  return String(info.email).trim().toLowerCase();
}

/* ───────────────────────── enrutador ───────────────────────── */

function despachar_(accion, usuario, datos) {
  switch (accion) {
    case 'listar':               return accionListar_(usuario);
    case 'guardarMedicamento':   return accionGuardarMedicamento_(usuario, datos);
    case 'eliminarMedicamento':  return accionEliminarMedicamento_(usuario, datos);
    case 'marcarDosis':          return accionMarcarDosis_(usuario, datos);
    case 'guardarConfig':        return accionGuardarConfig_(usuario, datos);
    case 'guardarPushToken':     return accionGuardarPushToken_(usuario, datos);
    case 'listarUsuarios':       return accionListarUsuarios_(usuario);
    case 'agregarUsuario':       return accionAgregarUsuario_(usuario, datos);
    case 'quitarUsuario':        return accionQuitarUsuario_(usuario, datos);
    default: throw new Error('Acción desconocida: ' + accion);
  }
}

/* ───────────────────────── acciones ───────────────────────── */

/** Todo lo que la app necesita para pintar la pantalla, en una sola llamada. */
function accionListar_(usuario) {
  generarDosisDeUsuario_(usuario.email, hoyISO_());

  return {
    usuario: {
      email: usuario.email,
      nombre: usuario.nombre,
      rol: usuario.rol
    },
    medicamentos: leerMedicamentos_(usuario.email).map(limpiar_),
    dosis: leerDosisDelDia_(usuario.email).map(limpiar_),
    historial: leerHistorial_(usuario.email, 30).map(limpiar_),
    config: leerConfig_()
  };
}

/** Quita el campo interno `_fila` antes de mandar al cliente. */
function limpiar_(obj) {
  const copia = {};
  Object.keys(obj).forEach(function (k) {
    if (k !== '_fila') copia[k] = obj[k];
  });
  return copia;
}

function leerHistorial_(email, dias) {
  const desde = new Date();
  desde.setDate(desde.getDate() - (dias || 30));
  const limite = hoyISO_(desde);

  return leerHoja_(HOJA.dosis)
    .map(normalizarDosis_)
    .filter(function (d) {
      return d.usuario_email === String(email).toLowerCase() && d.fecha >= limite;
    })
    .sort(function (a, b) {
      return (b.fecha + b.hora_programada) < (a.fecha + a.hora_programada) ? -1 : 1;
    });
}

function accionGuardarMedicamento_(usuario, datos) {
  if (!datos.nombre) throw new Error('El medicamento necesita un nombre.');

  const horarios = (datos.horarios || []).map(aHora_).filter(Boolean);
  if (!horarios.length) throw new Error('Debes indicar al menos una hora de toma.');

  const fila = {
    usuario_email: usuario.email,
    nombre: String(datos.nombre).trim(),
    dosis: datos.dosis || '',
    unidad: datos.unidad || '',
    veces_al_dia: horarios.length,
    horarios: horarios.join('|'),
    fecha_inicio: datos.fecha_inicio || hoyISO_(),
    fecha_fin: datos.fecha_fin || '',
    notas: datos.notas || '',
    activo: true
  };

  if (datos.id) {
    const existente = buscarFila_(HOJA.medicamentos, 'id', datos.id);
    if (!existente) throw new Error('Medicamento no encontrado.');
    if (String(existente.usuario_email).toLowerCase() !== usuario.email) {
      throw new Error('Ese medicamento no es tuyo.');
    }

    actualizarFila_(HOJA.medicamentos, existente._fila, fila);
    // Cambió el horario: las dosis pendientes de hoy en adelante quedaron obsoletas.
    borrarDosisPendientes_(datos.id, hoyISO_());
    generarDosisDeUsuario_(usuario.email, hoyISO_());
    return { id: datos.id };
  }

  fila.id = uid_('med');
  agregarFila_(HOJA.medicamentos, fila);
  generarDosisDeUsuario_(usuario.email, hoyISO_());
  return { id: fila.id };
}

function accionEliminarMedicamento_(usuario, datos) {
  const med = buscarFila_(HOJA.medicamentos, 'id', datos.id);
  if (!med) throw new Error('Medicamento no encontrado.');
  if (String(med.usuario_email).toLowerCase() !== usuario.email) {
    throw new Error('Ese medicamento no es tuyo.');
  }

  // Baja lógica: conserva el historial de dosis ya tomadas.
  actualizarFila_(HOJA.medicamentos, med._fila, { activo: false });
  borrarDosisPendientes_(datos.id, hoyISO_());
  return { ok: true };
}

/** Marca las dosis pendientes de un medicamento como canceladas, de `desde` en adelante. */
function borrarDosisPendientes_(medicamentoId, desde) {
  leerHoja_(HOJA.dosis)
    .map(normalizarDosis_)
    .filter(function (d) {
      return d.medicamento_id === medicamentoId && d.estado === 'pendiente' && d.fecha >= desde;
    })
    .forEach(function (d) {
      actualizarFila_(HOJA.dosis, d._fila, { estado: 'cancelada' });
    });
}

function accionMarcarDosis_(usuario, datos) {
  const dosis = buscarFila_(HOJA.dosis, 'id', datos.id);
  if (!dosis) throw new Error('Dosis no encontrada.');
  if (String(dosis.usuario_email).toLowerCase() !== usuario.email) {
    throw new Error('Esa toma no es tuya.');
  }

  const cambios = {};

  if (datos.estado === 'posponer') {
    const minutos = Number(datos.minutos) || 10;
    cambios.estado = 'pendiente';
    cambios.posponer_hasta = new Date(Date.now() + minutos * 60000).toISOString();
  } else {
    if (['tomada', 'omitida', 'pendiente'].indexOf(datos.estado) === -1) {
      throw new Error('Estado inválido: ' + datos.estado);
    }
    cambios.estado = datos.estado;
    if (datos.estado === 'tomada') cambios.hora_confirmada = horaISO_();
  }

  actualizarFila_(HOJA.dosis, dosis._fila, cambios);
  return { id: datos.id, estado: cambios.estado };
}

function accionGuardarConfig_(usuario, datos) {
  if (usuario.rol !== 'admin') throw new Error('Solo el administrador cambia la configuración.');

  const h = hoja_(HOJA.config);
  const filas = leerHoja_(HOJA.config);

  Object.keys(datos).forEach(function (clave) {
    const existente = filas.filter(function (f) { return String(f.clave).trim() === clave; })[0];
    if (existente) {
      actualizarFila_(HOJA.config, existente._fila, { valor: datos[clave] });
    } else {
      agregarFila_(HOJA.config, { clave: clave, valor: datos[clave], descripcion: '' });
    }
  });

  return leerConfig_();
}

/** Guarda el token de FCM del navegador. Se usará en la fase de push. */
function accionGuardarPushToken_(usuario, datos) {
  actualizarFila_(HOJA.usuarios, usuario._fila, { push_token: datos.token || '' });
  return { ok: true };
}

/* ───────────────────── administración de usuarios ───────────────────── */

function accionListarUsuarios_(usuario) {
  if (usuario.rol !== 'admin') throw new Error('Solo el administrador ve la lista de usuarios.');

  return leerHoja_(HOJA.usuarios).map(function (u) {
    return {
      id: u.id,
      email: String(u.email).trim().toLowerCase(),
      nombre: u.nombre,
      rol: u.rol,
      activo: aBool_(u.activo)
    };
  });
}

function accionAgregarUsuario_(usuario, datos) {
  if (usuario.rol !== 'admin') throw new Error('Solo el administrador autoriza correos.');

  const email = String(datos.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Correo inválido.');
  if (leerUsuario_(email)) throw new Error('Ese correo ya está autorizado.');

  const fila = {
    id: uid_('usr'),
    email: email,
    nombre: datos.nombre || email.split('@')[0],
    rol: 'usuario',
    activo: true,
    fecha_alta: hoyISO_(),
    push_token: ''
  };

  agregarFila_(HOJA.usuarios, fila);
  return fila;
}

function accionQuitarUsuario_(usuario, datos) {
  if (usuario.rol !== 'admin') throw new Error('Solo el administrador revoca accesos.');

  const objetivo = leerUsuario_(String(datos.email || '').trim().toLowerCase());
  if (!objetivo) throw new Error('Usuario no encontrado.');
  if (objetivo.email === usuario.email) throw new Error('No puedes revocarte a ti mismo.');

  // Baja lógica: conserva su historial.
  actualizarFila_(HOJA.usuarios, objetivo._fila, { activo: false });
  return { ok: true };
}
