/**
 * Push.gs — Envío de notificaciones vía Firebase Cloud Messaging.
 *
 * Por qué este archivo existe:
 *
 *   El protocolo Web Push exige firmar con ECDSA P-256 (VAPID) y cifrar con
 *   ECDH + AES-128-GCM. Apps Script no tiene ninguna de esas primitivas —su
 *   clase Utilities solo ofrece HMAC, RSA y digests— ni crypto.subtle. No
 *   puede hablar Web Push directamente.
 *
 *   FCM sí acepta un POST normal, autenticado con un token OAuth2. Y ese token
 *   se obtiene firmando un JWT con RS256, que es RSA: eso Apps Script SÍ puede
 *   hacerlo con Utilities.computeRsaSha256Signature. Por eso funciona.
 *
 * El OAuth2 va implementado aquí en lugar de usar una librería externa: son
 * cuarenta líneas, evita una dependencia y hace visible de dónde sale el token.
 */

/* ───────────────────── configuración ───────────────────── */

/**
 * Lee el JSON de la cuenta de servicio desde las Propiedades del script.
 *
 * NUNCA se escribe en el código: es una credencial real que daría acceso al
 * proyecto de Firebase. Se guarda en
 * Configuración del proyecto → Propiedades del script → FCM_SERVICE_ACCOUNT
 */
function cuentaServicio_() {
  const crudo = PropertiesService.getScriptProperties().getProperty('FCM_SERVICE_ACCOUNT');
  if (!crudo) {
    throw new Error(
      'Falta la propiedad FCM_SERVICE_ACCOUNT. Pega ahí el JSON completo que ' +
      'descargaste de Firebase → Configuración → Cuentas de servicio.'
    );
  }

  var cuenta;
  try {
    cuenta = JSON.parse(crudo);
  } catch (e) {
    throw new Error('FCM_SERVICE_ACCOUNT no es un JSON válido. Pégalo completo, con las llaves.');
  }

  if (!cuenta.client_email || !cuenta.private_key || !cuenta.project_id) {
    throw new Error('Al JSON le faltan client_email, private_key o project_id.');
  }

  // La clave viene con los saltos de línea escapados como \n literales.
  // Si no se deshacen, la firma RSA falla con un error poco descriptivo.
  cuenta.private_key = String(cuenta.private_key).replace(/\\n/g, '\n');

  return cuenta;
}

/* ───────────────────── OAuth2 ───────────────────── */

/**
 * Token de acceso para la API de FCM.
 *
 * Se cachea: dura una hora y pedir uno nuevo en cada aviso sumaría cientos de
 * llamadas al día, con el trigger corriendo cada 5 minutos.
 */
function tokenFCM_() {
  const cache = CacheService.getScriptCache();
  const guardado = cache.get('fcm_access_token');
  if (guardado) return guardado;

  const cuenta = cuentaServicio_();
  const ahora = Math.floor(Date.now() / 1000);

  const cabecera = { alg: 'RS256', typ: 'JWT' };
  const reclamo = {
    iss: cuenta.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: ahora,
    exp: ahora + 3600
  };

  const porFirmar = base64Url_(JSON.stringify(cabecera)) + '.' +
                    base64Url_(JSON.stringify(reclamo));

  const firma = Utilities.computeRsaSha256Signature(porFirmar, cuenta.private_key);
  const jwt = porFirmar + '.' + Utilities.base64EncodeWebSafe(firma).replace(/=+$/, '');

  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    },
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('No se pudo obtener el token de FCM: ' + res.getContentText());
  }

  const datos = JSON.parse(res.getContentText());

  // Cinco minutos de margen sobre la caducidad real.
  cache.put('fcm_access_token', datos.access_token, Math.max(60, (datos.expires_in || 3600) - 300));

  return datos.access_token;
}

/** Base64 sin relleno y seguro para URL, como exige el formato JWT. */
function base64Url_(texto) {
  return Utilities.base64EncodeWebSafe(Utilities.newBlob(texto).getBytes()).replace(/=+$/, '');
}

/* ───────────────────── envío ───────────────────── */

/**
 * Manda el aviso de una dosis al dispositivo del usuario.
 *
 * Se usa mensaje SOLO de datos, sin bloque "notification": así la notificación
 * la construye nuestro Service Worker, con los botones de "Ya la tomé" y
 * "Posponer". Con bloque de notificación la dibujaría el navegador, sin ellos.
 *
 * Nunca lanza excepción: un fallo de push no debe abortar el ciclo de
 * recordatorios ni impedir que salga el email de respaldo.
 */
function enviarPush_(dosis, med) {
  try {
    const usuario = leerUsuario_(dosis.usuario_email);

    if (!usuario) {
      console.log('[push] no existe el usuario ' + dosis.usuario_email);
      return false;
    }
    if (!usuario.push_token) {
      // Sin suscripción no hay a dónde enviar; queda el email de respaldo.
      console.log('[push] ' + usuario.email + ' no tiene push_token. ' +
                  'Debe pulsar 🔔 en la app desde ese dispositivo.');
      return false;
    }

    const cuenta = cuentaServicio_();
    const dosisTexto = [med.dosis, med.unidad].filter(Boolean).join(' ');
    const n = (dosis.recordatorios_enviados || 0) + 1;

    const mensaje = {
      message: {
        token: usuario.push_token,
        data: {
          titulo: '💊 Hora de ' + med.nombre,
          cuerpo: (dosisTexto ? dosisTexto + ' · ' : '') +
                  'programada ' + dosis.hora_programada +
                  (n > 1 ? ' · recordatorio ' + n : ''),
          tag: 'dosis-' + dosis.id,
          dosisId: String(dosis.id),
          url: URL_APP
        },
        webpush: {
          headers: { Urgency: 'high', TTL: '300' },   // caduca en 5 min: llega el siguiente
          fcmOptions: { link: URL_APP }
        }
      }
    };

    const res = UrlFetchApp.fetch(
      'https://fcm.googleapis.com/v1/projects/' + cuenta.project_id + '/messages:send',
      {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + tokenFCM_() },
        payload: JSON.stringify(mensaje),
        muteHttpExceptions: true
      }
    );

    const codigo = res.getResponseCode();
    if (codigo === 200) {
      console.log('[push] ✓ enviado a ' + usuario.email + ' · ' + med.nombre +
                  ' ' + dosis.hora_programada);
      return true;
    }

    // Token muerto: el usuario borró datos del navegador, reinstaló, o Google
    // lo rotó. Se limpia para no reintentar cada cinco minutos contra la nada.
    if (codigo === 404 || codigo === 400) {
      const cuerpo = res.getContentText();
      if (cuerpo.indexOf('UNREGISTERED') !== -1 || cuerpo.indexOf('INVALID_ARGUMENT') !== -1) {
        actualizarFila_(HOJA.usuarios, usuario._fila, { push_token: '' });
        console.log('Token de push inválido para ' + usuario.email + ', se limpió.');
        return false;
      }
    }

    console.log('FCM respondió ' + codigo + ': ' + res.getContentText());
    return false;

  } catch (e) {
    console.log('Fallo al enviar push: ' + (e.message || e));
    return false;
  }
}

/* ───────────────────── prueba ───────────────────── */

/**
 * DIAGNÓSTICO — por qué no llega el push con la app cerrada.
 *
 * Revisa la cadena completa de una vez: activadores instalados, usuarios
 * registrados, y qué decidiría el motor AHORA MISMO con cada dosis pendiente.
 * Así se ve si el problema es el disparador, la suscripción o la regla.
 */
function diagnosticarPush() {
  console.log('── Diagnóstico de notificaciones ──');
  console.log('');

  /* 1. Activadores */
  const triggers = ScriptApp.getProjectTriggers();
  console.log('ACTIVADORES INSTALADOS: ' + triggers.length);
  triggers.forEach(function (t) {
    console.log('  · ' + t.getHandlerFunction() + '  (' + t.getEventType() + ')');
  });

  const tieneCiclo = triggers.some(function (t) {
    return t.getHandlerFunction() === 'revisarRecordatorios';
  });

  if (!tieneCiclo) {
    console.log('');
    console.log('❌ Falta el activador revisarRecordatorios. Sin él nadie revisa');
    console.log('   las dosis con la app cerrada. Ejecuta instalarTriggers().');
  }

  /* 2. Suscripciones */
  console.log('');
  console.log('DISPOSITIVOS REGISTRADOS:');
  leerHoja_(HOJA.usuarios)
    .filter(function (u) { return aBool_(u.activo); })
    .forEach(function (u) {
      const token = String(u.push_token || '');
      console.log('  · ' + u.email + ' → ' +
        (token ? '✓ ' + token.slice(0, 22) + '…'
               : '✗ sin token (debe pulsar 🔔 en SU dispositivo)'));
    });

  /* 3. Qué pasaría ahora mismo */
  const cfg = leerConfig_();
  const ahora = new Date();
  const hoy = hoyISO_(ahora);
  const pendientes = leerPendientesDelDia_(hoy);

  console.log('');
  console.log('CONFIGURACIÓN: repetir cada ' + cfg.intervaloRecordatorioMin +
              ' min · rendirse tras ' + cfg.maxRecordatorios + ' avisos');
  console.log('AHORA: ' + hoy + ' ' + horaISO_(ahora) + ' (' + zonaHoraria_() + ')');
  console.log('');
  console.log('DOSIS PENDIENTES HOY: ' + pendientes.length);

  pendientes.forEach(function (d) {
    const dec = evaluar_(d, ahora, cfg);
    const programada = aDate_(d.fecha, d.hora_programada);
    const minutos = Math.round((ahora - programada) / 60000);

    console.log('');
    console.log('  ' + d.hora_programada + '  (' +
      (minutos >= 0 ? 'hace ' + minutos + ' min' : 'en ' + (-minutos) + ' min') + ')');
    console.log('    avisos enviados : ' + d.recordatorios_enviados);
    console.log('    último aviso    : ' + (d.ultimo_recordatorio || '—'));
    console.log('    pospuesta hasta : ' + (d.posponer_hasta || '—'));
    console.log('    → avisaría ahora: ' + (dec.avisar ? 'SÍ' : 'no') +
                (dec.marcarVencida ? '  (se marcaría vencida)' : '') +
                (dec.escalarEmail ? '  (+ email)' : ''));
  });

  if (!pendientes.length) {
    console.log('');
    console.log('No hay dosis pendientes, así que no habría nada que notificar.');
    console.log('Registra un medicamento con hora futura y vuelve a probar.');
  }

  console.log('');
  console.log('Si "avisaría ahora" dice SÍ pero no llega nada al celular, el');
  console.log('problema está en la entrega: revisa Ejecuciones para ver si');
  console.log('[push] ✓ enviado aparece en el registro del ciclo.');
}

/**
 * Manda una notificación de prueba a tu propio dispositivo.
 * Requiere haber activado las notificaciones antes desde la app.
 */
function probarPush() {
  console.log('── Prueba de push ──');

  const usuario = leerUsuario_(EMAIL_PRUEBA);
  if (!usuario) throw new Error('No encontré a ' + EMAIL_PRUEBA + ' en la hoja Usuarios.');

  if (!usuario.push_token) {
    throw new Error(
      'Ese usuario no tiene push_token. Abre la app, entra con ese correo y ' +
      'pulsa el botón 🔔 para activar las notificaciones.'
    );
  }

  console.log('Usuario  : ' + usuario.email);
  console.log('Token    : ' + usuario.push_token.slice(0, 28) + '…');

  const cuenta = cuentaServicio_();
  console.log('Proyecto : ' + cuenta.project_id);
  console.log('Cuenta   : ' + cuenta.client_email);

  console.log('');
  console.log('Pidiendo token de acceso…');
  const acceso = tokenFCM_();
  console.log('✓ Token OAuth2 obtenido (' + acceso.slice(0, 18) + '…)');

  const ok = enviarPush_(
    { id: 'prueba', usuario_email: usuario.email, hora_programada: horaISO_(),
      recordatorios_enviados: 0 },
    { nombre: 'Prueba de PillTime', dosis: '1', unidad: 'tableta' }
  );

  console.log('');
  console.log(ok
    ? 'RESULTADO: enviado. Debería aparecer en el dispositivo en segundos.'
    : 'RESULTADO: no se envió. Revisa los mensajes de arriba.');
}
