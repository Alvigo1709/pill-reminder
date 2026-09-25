/**
 * Recordatorios.gs — Motor de recordatorios del lado servidor.
 *
 * Dos funciones se ejecutan solas mediante activadores (triggers):
 *
 *   generarDosisDelDia     → una vez al día, de madrugada.
 *   revisarRecordatorios   → cada 5 minutos, todo el día.
 *
 * La función evaluar_() es un port literal de Scheduler.evaluar() del
 * frontend (js/scheduler.js). Se escribió allá como función pura —sin DOM,
 * sin estado— precisamente para poder copiarla aquí sin cambios.
 */

/* ═══════════════════ trigger diario: materializar dosis ═══════════════════ */

/**
 * Crea en la hoja Dosis una fila por cada toma que corresponde hoy.
 * Configúrala como activador diario entre 00:00 y 01:00.
 */
function generarDosisDelDia() {
  const hoy = hoyISO_();
  const usuarios = leerHoja_(HOJA.usuarios).filter(function (u) { return aBool_(u.activo); });

  var total = 0;
  usuarios.forEach(function (u) {
    total += generarDosisDeUsuario_(String(u.email).trim().toLowerCase(), hoy);
  });

  console.log('Dosis generadas para ' + hoy + ': ' + total);
  return total;
}

/**
 * Idempotente: si la fila (medicamento + fecha + hora) ya existe, no la duplica.
 * Por eso se puede llamar cuantas veces haga falta sin ensuciar la hoja.
 */
function generarDosisDeUsuario_(email, fecha) {
  const dia = fecha || hoyISO_();
  const medicamentos = leerMedicamentos_(email).filter(function (m) {
    return (!m.fecha_inicio || m.fecha_inicio <= dia)
        && (!m.fecha_fin || m.fecha_fin >= dia);
  });

  if (!medicamentos.length) return 0;

  // Índice de lo ya existente, para no releer la hoja dentro del bucle.
  const existentes = {};
  leerHoja_(HOJA.dosis).map(normalizarDosis_).forEach(function (d) {
    if (d.fecha === dia) existentes[d.medicamento_id + '@' + d.hora_programada] = true;
  });

  const nuevas = [];
  medicamentos.forEach(function (med) {
    med.horarios.forEach(function (hora) {
      if (existentes[med.id + '@' + hora]) return;
      nuevas.push({
        id: uid_('dos'),
        medicamento_id: med.id,
        usuario_email: email,
        fecha: dia,
        hora_programada: hora,
        estado: 'pendiente',
        hora_confirmada: '',
        recordatorios_enviados: 0,
        ultimo_recordatorio: '',
        posponer_hasta: '',
        email_enviado: false
      });
    });
  });

  if (!nuevas.length) return 0;

  // Una sola escritura en bloque: mucho más rápido que appendRow por fila.
  const cols = encabezados_(HOJA.dosis);
  const matriz = nuevas.map(function (d) {
    return cols.map(function (c) { return d[c] === undefined ? '' : d[c]; });
  });

  const h = hoja_(HOJA.dosis);
  h.getRange(h.getLastRow() + 1, 1, matriz.length, cols.length).setValues(matriz);

  return nuevas.length;
}

/* ═══════════════════ trigger de 5 min: avisar ═══════════════════ */

/**
 * Revisa todas las dosis pendientes de hoy y decide a quién hay que avisar.
 * Configúrala como activador por minutos, cada 5 minutos.
 */
function revisarRecordatorios() {
  // Evita que dos ejecuciones solapadas manden el aviso por duplicado.
  const candado = LockService.getScriptLock();
  if (!candado.tryLock(10000)) {
    console.log('Otra ejecución en curso; se omite este ciclo.');
    return;
  }

  try {
    const cfg = leerConfig_();
    const ahora = new Date();
    const hoy = hoyISO_(ahora);

    const pendientes = leerPendientesDelDia_(hoy);
    if (!pendientes.length) return;

    // Caché de medicamentos y usuarios: evita releer la hoja por cada dosis.
    const medsPorId = {};
    leerHoja_(HOJA.medicamentos).map(normalizarMedicamento_).forEach(function (m) {
      medsPorId[m.id] = m;
    });

    var avisos = 0, emails = 0, vencidas = 0;

    pendientes.forEach(function (dosis) {
      const decision = evaluar_(dosis, ahora, cfg);

      if (decision.marcarVencida) {
        actualizarFila_(HOJA.dosis, dosis._fila, { estado: 'vencida' });
        vencidas++;
        return;
      }

      const med = medsPorId[dosis.medicamento_id];
      if (!med) return;                       // medicamento borrado: nada que avisar

      if (decision.escalarEmail && !dosis.email_enviado) {
        enviarEmail_(dosis, med);
        actualizarFila_(HOJA.dosis, dosis._fila, { email_enviado: true });
        emails++;
      }

      if (decision.avisar) {
        enviarPush_(dosis, med);              // hoy no hace nada; se activa en la fase 4
        actualizarFila_(HOJA.dosis, dosis._fila, {
          recordatorios_enviados: dosis.recordatorios_enviados + 1,
          ultimo_recordatorio: ahora.toISOString()
        });
        avisos++;
      }
    });

    console.log('Ciclo ' + horaISO_(ahora) +
                ' · pendientes=' + pendientes.length +
                ' avisos=' + avisos + ' emails=' + emails + ' vencidas=' + vencidas);

  } finally {
    candado.releaseLock();
  }
}

/**
 * Decide qué hacer con una dosis. Función pura: mismas entradas, misma salida.
 * Idéntica a Scheduler.evaluar() del frontend — si cambias una, cambia la otra.
 */
function evaluar_(dosis, ahora, cfg) {
  const resultado = { avisar: false, marcarVencida: false, escalarEmail: false };

  const programada = aDate_(dosis.fecha, dosis.hora_programada);
  const disparo = new Date(programada.getTime() - (cfg.avisoPrevioMin || 0) * 60000);

  // Todavía no es hora.
  if (ahora < disparo) return resultado;

  // Pospuesta explícitamente por el usuario.
  if (dosis.posponer_hasta && ahora < new Date(dosis.posponer_hasta)) return resultado;

  const enviados = dosis.recordatorios_enviados || 0;

  if (enviados >= (cfg.maxRecordatorios || 12)) {
    resultado.marcarVencida = true;
    return resultado;
  }

  const minutosDeRetraso = (ahora - programada) / 60000;
  if (cfg.escalarEmailMin > 0 && minutosDeRetraso >= cfg.escalarEmailMin) {
    resultado.escalarEmail = true;
  }

  // Primer aviso: en cuanto llega la hora.
  if (enviados === 0) {
    resultado.avisar = true;
    return resultado;
  }

  // Avisos siguientes: cada `intervaloRecordatorioMin` minutos.
  const ultimo = dosis.ultimo_recordatorio ? new Date(dosis.ultimo_recordatorio) : null;
  if (!ultimo) {
    resultado.avisar = true;
    return resultado;
  }

  if ((ahora - ultimo) / 60000 >= (cfg.intervaloRecordatorioMin || 5)) {
    resultado.avisar = true;
  }

  return resultado;
}

/* ═══════════════════ canales de aviso ═══════════════════ */

function enviarEmail_(dosis, med) {
  const dosisTexto = [med.dosis, med.unidad].filter(Boolean).join(' ');

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:460px;margin:0 auto">' +
      '<div style="background:linear-gradient(135deg,#0f766e,#14b8a6);color:#fff;' +
                  'padding:26px;border-radius:14px 14px 0 0;text-align:center">' +
        '<div style="font-size:42px;line-height:1">💊</div>' +
        '<h1 style="margin:8px 0 0;font-size:22px">No has marcado tu toma</h1>' +
      '</div>' +
      '<div style="border:1px solid #e2e8f0;border-top:0;border-radius:0 0 14px 14px;padding:26px">' +
        '<p style="font-size:19px;font-weight:bold;margin:0 0 4px;color:#0f172a">' +
          escapar_(med.nombre) + '</p>' +
        (dosisTexto ? '<p style="margin:0 0 10px;color:#64748b">' + escapar_(dosisTexto) + '</p>' : '') +
        '<p style="margin:0 0 6px;color:#334155">Estaba programada para las <b>' +
          dosis.hora_programada + '</b>.</p>' +
        (med.notas ? '<p style="color:#64748b;font-size:14px">📝 ' + escapar_(med.notas) + '</p>' : '') +
        '<p style="text-align:center;margin:24px 0 10px">' +
          '<a href="' + URL_APP + '" style="background:#0d9488;color:#fff;text-decoration:none;' +
             'padding:13px 28px;border-radius:10px;font-weight:bold;display:inline-block">' +
             'Abrir PillTime</a>' +
        '</p>' +
        '<p style="color:#94a3b8;font-size:12px;text-align:center;margin:16px 0 0">' +
          'Marca la toma en la app para dejar de recibir recordatorios.</p>' +
      '</div>' +
    '</div>';

  MailApp.sendEmail({
    to: dosis.usuario_email,
    subject: '💊 No has marcado tu toma de ' + med.nombre,
    htmlBody: html,
    name: NOMBRE_REMITENTE
  });
}

/**
 * Envío de push. Se implementa en la fase 4, con Firebase.
 * Hasta entonces no hace nada y el email es el único canal.
 */
function enviarPush_(dosis, med) {
  // Fase 4:
  //   const usuario = leerUsuario_(dosis.usuario_email);
  //   if (!usuario || !usuario.push_token) return;
  //   UrlFetchApp.fetch('https://fcm.googleapis.com/v1/projects/' + PROJECT_ID + '/messages:send', {...});
  return;
}

function escapar_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ═══════════════════ instalación de los triggers ═══════════════════ */

/**
 * Ejecuta esta función UNA VEZ desde el editor para crear los dos activadores.
 * Es más confiable que crearlos a mano y evita duplicarlos por accidente.
 */
function instalarTriggers() {
  // Limpia los que ya existan, para poder re-ejecutar sin acumular.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const f = t.getHandlerFunction();
    if (f === 'generarDosisDelDia' || f === 'revisarRecordatorios') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('generarDosisDelDia')
    .timeBased().atHour(0).nearMinute(15).everyDays(1)
    .inTimezone(zonaHoraria_())
    .create();

  ScriptApp.newTrigger('revisarRecordatorios')
    .timeBased().everyMinutes(5)
    .create();

  const instalados = ScriptApp.getProjectTriggers().map(function (t) {
    return t.getHandlerFunction();
  });

  console.log('Activadores instalados: ' + instalados.join(', '));
  console.log('Zona horaria del proyecto: ' + zonaHoraria_());
  return instalados;
}
