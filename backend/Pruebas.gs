/**
 * Pruebas.gs — Verificación paso a paso.
 *
 * Ejecuta estas funciones EN ORDEN desde el editor de Apps Script
 * (selector de función arriba → Ejecutar) y mira la consola de ejecución.
 * Cada una valida una pieza distinta; si una falla, no sigas a la siguiente.
 *
 * Al terminar, prueba9_limpiar() borra todo lo que crearon las pruebas.
 */

// ⚠️ Pon aquí el correo que registraste como admin en la pestaña Usuarios.
// Se deja como marcador a propósito: este repositorio es público.
const EMAIL_PRUEBA = 'tu-correo@gmail.com';

/* ───────────────────────────────────────────────────────────── */

function prueba1_conexion() {
  console.log('── Prueba 1: conexión con el Sheet ──');

  if (SHEET_ID === 'PEGA_AQUI_EL_ID_DE_TU_SHEET') {
    throw new Error('Falta poner el SHEET_ID en Configuracion.gs.');
  }

  const libro = libro_();
  console.log('Sheet: "' + libro.getName() + '"');
  console.log('Zona horaria del script: ' + zonaHoraria_());
  console.log('Hoy según el script: ' + hoyISO_() + ' ' + horaISO_());

  const esperado = {
    Usuarios: ['id', 'email', 'nombre', 'rol', 'activo', 'fecha_alta', 'push_token'],
    Medicamentos: ['id', 'usuario_email', 'nombre', 'dosis', 'unidad', 'veces_al_dia',
                   'horarios', 'fecha_inicio', 'fecha_fin', 'notas', 'activo'],
    Dosis: ['id', 'medicamento_id', 'usuario_email', 'fecha', 'hora_programada', 'estado',
            'hora_confirmada', 'recordatorios_enviados', 'ultimo_recordatorio',
            'posponer_hasta', 'email_enviado'],
    Config: ['clave', 'valor', 'descripcion']
  };

  Object.keys(esperado).forEach(function (nombre) {
    const reales = encabezados_(nombre);
    const faltan = esperado[nombre].filter(function (c) { return reales.indexOf(c) === -1; });
    if (faltan.length) {
      throw new Error('A la pestaña "' + nombre + '" le faltan columnas: ' + faltan.join(', '));
    }
    console.log('✓ ' + nombre + ' — ' + reales.length + ' columnas');
  });

  console.log('');
  console.log('⚠️  Verifica que la zona horaria de arriba sea la tuya.');
  console.log('   Si dice UTC o GMT, cámbiala en Configuración del proyecto.');
  console.log('');
  console.log('RESULTADO: conexión correcta.');
}

/* ───────────────────────────────────────────────────────────── */

function prueba2_usuario() {
  console.log('── Prueba 2: lectura de usuarios ──');

  const usuario = leerUsuario_(EMAIL_PRUEBA);
  if (!usuario) {
    throw new Error('No encontré "' + EMAIL_PRUEBA + '" en la pestaña Usuarios. ' +
                    'Revisa que el correo coincida exactamente.');
  }

  console.log('Usuario: ' + usuario.nombre + ' <' + usuario.email + '>');
  console.log('Rol: ' + usuario.rol + '   Activo: ' + usuario.activo);

  if (!usuario.activo) throw new Error('El usuario está en FALSE. Ponlo en TRUE.');
  if (usuario.rol !== 'admin') console.log('⚠️  No es admin: no podrá administrar usuarios.');

  console.log('');
  console.log('Configuración leída:');
  const cfg = leerConfig_();
  Object.keys(cfg).forEach(function (k) { console.log('  ' + k + ' = ' + cfg[k]); });

  console.log('');
  console.log('RESULTADO: usuario y configuración correctos.');
}

/* ───────────────────────────────────────────────────────────── */

function prueba3_crearMedicamento() {
  console.log('── Prueba 3: alta de medicamento ──');

  const usuario = leerUsuario_(EMAIL_PRUEBA);

  // Una toma un minuto en el pasado, para que el motor la considere vencida.
  const hace1min = new Date(Date.now() - 60000);

  const res = accionGuardarMedicamento_(usuario, {
    nombre: 'PRUEBA Paracetamol',
    dosis: '500',
    unidad: 'mg',
    horarios: [horaISO_(hace1min), '15:00', '22:00'],
    notas: 'Medicamento de prueba, bórralo después'
  });

  console.log('Creado con id: ' + res.id);

  const meds = leerMedicamentos_(usuario.email);
  console.log('Medicamentos activos del usuario: ' + meds.length);
  meds.forEach(function (m) {
    console.log('  · ' + m.nombre + ' — ' + m.horarios.join(', ') +
                ' (' + m.veces_al_dia + ' al día)');
  });

  console.log('');
  console.log('RESULTADO: alta correcta. Revisa la pestaña Medicamentos en el Sheet.');
}

/* ───────────────────────────────────────────────────────────── */

function prueba4_generarDosis() {
  console.log('── Prueba 4: generación de dosis del día ──');

  const creadas = generarDosisDelDia();
  console.log('Dosis nuevas creadas: ' + creadas);

  // Segunda pasada: no debe crear nada (la función es idempotente).
  const repetidas = generarDosisDelDia();
  console.log('Al repetir la llamada se crearon: ' + repetidas + ' (debe ser 0)');

  if (repetidas !== 0) {
    throw new Error('Se están duplicando dosis. Revisa la hoja Dosis.');
  }

  const dosis = leerDosisDelDia_(EMAIL_PRUEBA);
  console.log('');
  console.log('Dosis de hoy (' + dosis.length + '):');
  dosis.forEach(function (d) {
    console.log('  ' + d.hora_programada + '  ' + d.estado +
                '  avisos=' + d.recordatorios_enviados);
  });

  console.log('');
  console.log('RESULTADO: generación correcta y sin duplicados.');
}

/* ───────────────────────────────────────────────────────────── */

/**
 * Valida la lógica de "insistir cada 5 minutos hasta que marque".
 * Son los mismos 10 casos que ya pasaron en el frontend; aquí comprobamos
 * que el port al servidor se comporta igual.
 */
function prueba5_motor() {
  console.log('── Prueba 5: motor de recordatorios ──');

  const cfg = { intervaloRecordatorioMin: 5, avisoPrevioMin: 0,
                maxRecordatorios: 12, escalarEmailMin: 15 };

  const base = {
    fecha: '2026-09-25', hora_programada: '08:00', recordatorios_enviados: 0,
    ultimo_recordatorio: '', posponer_hasta: '', email_enviado: false
  };

  // T(n) = las 08:00 más n minutos.
  function T(n) { return new Date(2026, 8, 25, 8, n, 0); }

  function iso(n) { return T(n).toISOString(); }

  const casos = [
    ['antes de la hora no avisa',        {},                                                      new Date(2026,8,25,7,59), {avisar:false}],
    ['a la hora exacta avisa',           {},                                                      T(0),  {avisar:true}],
    ['al minuto NO repite',              {recordatorios_enviados:1, ultimo_recordatorio:iso(0)},  T(1),  {avisar:false}],
    ['a los 4 min NO repite',            {recordatorios_enviados:1, ultimo_recordatorio:iso(0)},  T(4),  {avisar:false}],
    ['a los 5 min SÍ repite',            {recordatorios_enviados:1, ultimo_recordatorio:iso(0)},  T(5),  {avisar:true}],
    ['pospuesta no avisa',               {recordatorios_enviados:1, ultimo_recordatorio:iso(0), posponer_hasta:iso(10)}, T(6),  {avisar:false}],
    ['pasada la posposición sí avisa',   {recordatorios_enviados:1, ultimo_recordatorio:iso(0), posponer_hasta:iso(10)}, T(11), {avisar:true}],
    ['escala a email a los 15 min',      {recordatorios_enviados:3, ultimo_recordatorio:iso(9)},  T(15), {escalarEmail:true}],
    ['NO escala a los 14 min',           {recordatorios_enviados:3, ultimo_recordatorio:iso(9)},  T(14), {escalarEmail:false}],
    ['tras 12 avisos marca vencida',     {recordatorios_enviados:12, ultimo_recordatorio:iso(55)},T(60), {marcarVencida:true, avisar:false}]
  ];

  var fallos = 0;

  casos.forEach(function (caso) {
    const nombre = caso[0], extra = caso[1], ahora = caso[2], esperado = caso[3];

    const dosis = {};
    Object.keys(base).forEach(function (k) { dosis[k] = base[k]; });
    Object.keys(extra).forEach(function (k) { dosis[k] = extra[k]; });

    const got = evaluar_(dosis, ahora, cfg);
    const ok = Object.keys(esperado).every(function (k) { return got[k] === esperado[k]; });

    if (!ok) fallos++;
    console.log((ok ? '  PASA · ' : '  FALLA · ') + nombre +
                (ok ? '' : '  → ' + JSON.stringify(got)));
  });

  console.log('');
  if (fallos) throw new Error(fallos + ' caso(s) fallaron. No sigas hasta corregirlo.');
  console.log('RESULTADO: 10 de 10. El motor se comporta igual que en el frontend.');
}

/* ───────────────────────────────────────────────────────────── */

function prueba6_email() {
  console.log('── Prueba 6: envío de email ──');
  console.log('Cuota restante hoy: ' + MailApp.getRemainingDailyQuota() + ' emails');

  const dosis = { usuario_email: EMAIL_PRUEBA, hora_programada: '08:00' };
  const med = { nombre: 'PRUEBA Paracetamol', dosis: '500', unidad: 'mg',
                notas: 'Este es un correo de prueba' };

  enviarEmail_(dosis, med);

  console.log('');
  console.log('RESULTADO: email enviado a ' + EMAIL_PRUEBA + '. Revisa tu bandeja.');
}

/* ───────────────────────────────────────────────────────────── */

function prueba7_cicloCompleto() {
  console.log('── Prueba 7: un ciclo real del trigger ──');
  console.log('Esto es exactamente lo que correrá cada 5 minutos.');
  console.log('');

  revisarRecordatorios();

  console.log('');
  console.log('Estado de las dosis tras el ciclo:');
  leerDosisDelDia_(EMAIL_PRUEBA).forEach(function (d) {
    console.log('  ' + d.hora_programada + '  ' + d.estado +
                '  avisos=' + d.recordatorios_enviados +
                '  email=' + d.email_enviado);
  });

  console.log('');
  console.log('RESULTADO: la toma vencida debe tener avisos=1.');
  console.log('Si vuelves a ejecutar antes de 5 min, debe seguir en 1.');
}

/* ───────────────────────────────────────────────────────────── */

function prueba8_apiCompleta() {
  console.log('── Prueba 8: la API como la verá el frontend ──');

  const respuesta = doPost({
    postData: {
      contents: JSON.stringify({
        accion: 'listar',
        email: EMAIL_PRUEBA          // solo válido en MODO_DESARROLLO
      })
    }
  });

  const datos = JSON.parse(respuesta.getContent());

  if (!datos.ok) throw new Error('La API respondió con error: ' + datos.error);

  console.log('Usuario: ' + datos.datos.usuario.nombre + ' (' + datos.datos.usuario.rol + ')');
  console.log('Medicamentos: ' + datos.datos.medicamentos.length);
  console.log('Dosis de hoy: ' + datos.datos.dosis.length);
  console.log('Historial: ' + datos.datos.historial.length);
  console.log('');
  console.log('Respuesta completa:');
  console.log(JSON.stringify(datos.datos, null, 2).slice(0, 1500));

  console.log('');
  console.log('RESULTADO: la API responde correctamente.');
}

/* ───────────────────────────────────────────────────────────── */

/**
 * DIAGNÓSTICO — ejecútala si las horas no coinciden con lo que registraste.
 *
 * Imprime las DOS zonas horarias (la del script y la de la hoja, que son
 * ajustes distintos) y el valor crudo de cada celda de horarios con su tipo
 * real. Si las zonas no coinciden, cada hora se desplaza al leerla y aparecen
 * segundos raros como :03:44, que es la diferencia con la hora solar de Bogotá.
 */
function diagnosticarHorarios() {
  console.log('── Diagnóstico de horas ──');
  console.log('');

  const zonaScript = Session.getScriptTimeZone();
  const zonaHoja = libro_().getSpreadsheetTimeZone();

  console.log('Zona del proyecto Apps Script : ' + zonaScript);
  console.log('Zona de la hoja de cálculo    : ' + zonaHoja);

  if (zonaScript !== zonaHoja) {
    console.log('');
    console.log('❌ NO COINCIDEN. Esta es la causa de que las horas salgan corridas.');
    console.log('   Arréglalo en el Sheet: Archivo → Configuración → Zona horaria,');
    console.log('   y ponla igual que la del script (' + zonaScript + ').');
  } else {
    console.log('✓ Coinciden.');
  }

  console.log('');
  console.log('Hora actual según el script: ' + hoyISO_() + ' ' + horaISO_());
  console.log('');
  console.log('── Celdas de horarios ──');

  leerHoja_(HOJA.medicamentos).forEach(function (m) {
    const crudo = m.horarios;
    const tipo = Object.prototype.toString.call(crudo).replace('[object ', '').replace(']', '');
    const interpretado = aHorarios_(crudo);

    console.log('');
    console.log('  ' + m.nombre);
    console.log('    valor crudo  : ' + String(crudo));
    console.log('    tipo real    : ' + tipo + (tipo === 'Date' ? '  ← Sheets lo convirtió en hora' : ''));
    console.log('    interpretado : ' + JSON.stringify(interpretado));
  });

  console.log('');
  console.log('── Dosis de hoy (lo que ve la app) ──');

  const hoy = hoyISO_();
  leerHoja_(HOJA.dosis)
    .filter(function (d) { return aFecha_(d.fecha) === hoy; })
    .forEach(function (d) {
      const crudo = d.hora_programada;
      const tipo = Object.prototype.toString.call(crudo).replace('[object ', '').replace(']', '');
      console.log('  ' + aHora_(crudo) + '  estado=' + d.estado +
                  '  [crudo: ' + String(crudo) + '  tipo: ' + tipo + ']');
    });

  console.log('');
  console.log('Si el tipo real dice Date, ejecuta repararHorarios().');
  console.log('Si dice String y la hora ya está mal, el problema viene del');
  console.log('formulario y no de la hoja: mándame esta salida completa.');
}

/**
 * REPARACIÓN — ejecútala una vez si ves fechas de 1899 en la app.
 *
 * Arregla los medicamentos cuyos horarios Google Sheets convirtió en valor de
 * hora. Pasa cuando el medicamento tiene UNA sola toma al día: la celda dice
 * "16:03" y Sheets la reconoce como hora en vez de dejarla como texto.
 *
 * Reconstruye la hora, la reescribe como texto, borra las dosis pendientes
 * que quedaron con basura y las vuelve a generar.
 */
function repararHorarios() {
  console.log('── Reparación de horarios ──');

  forzarFormatoTexto_();
  console.log('✓ Columnas de hora y fecha puestas en formato texto');

  const hojaMed = hoja_(HOJA.medicamentos);
  const cols = encabezados_(HOJA.medicamentos);
  const colHorarios = cols.indexOf('horarios') + 1;
  var arreglados = 0;

  leerHoja_(HOJA.medicamentos).forEach(function (m) {
    const crudo = m.horarios;
    const esFecha = Object.prototype.toString.call(crudo) === '[object Date]';
    const texto = String(crudo || '');

    // Sano: ya son horas separadas por barra.
    if (!esFecha && /^(\d{1,2}:\d{2})(\|\d{1,2}:\d{2})*$/.test(texto.trim())) return;

    var horas;
    if (esFecha) {
      horas = [aHora_(crudo)];
    } else {
      // Rescata "16:03" de dentro de "Sat Dec 30 1899 16:03:44 GMT-0456...".
      horas = (texto.match(/\d{1,2}:\d{2}/g) || []).map(function (h) {
        return ('0' + h).slice(-5);
      });
    }

    if (!horas.length) {
      console.log('⚠️  "' + m.nombre + '" no tiene horas recuperables: ' + texto);
      return;
    }

    hojaMed.getRange(m._fila, colHorarios)
      .setNumberFormat('@')
      .setValue(horas.join('|'));

    actualizarFila_(HOJA.medicamentos, m._fila, { veces_al_dia: horas.length });

    console.log('✓ "' + m.nombre + '" → ' + horas.join('|'));
    arreglados++;
  });

  // Dosis con hora corrupta. Hay que tratarlas distinto según su estado:
  //
  //   pendientes → se borran y se regeneran limpias.
  //   el resto   → se reparan EN SITIO. Son historial: si las borro, pierdo
  //                el registro de que esa toma ocurrió.
  const hojaDosis = hoja_(HOJA.dosis);
  const colHora = encabezados_(HOJA.dosis).indexOf('hora_programada') + 1;

  const corruptas = leerHoja_(HOJA.dosis)
    .map(normalizarDosis_)
    .filter(function (d) { return !/^\d{2}:\d{2}$/.test(d.hora_programada); });

  var reparadas = 0;
  corruptas
    .filter(function (d) { return d.estado !== 'pendiente'; })
    .forEach(function (d) {
      const rescatada = (String(d.hora_programada).match(/\d{1,2}:\d{2}/) || [])[0];
      if (!rescatada) return;
      hojaDosis.getRange(d._fila, colHora)
        .setNumberFormat('@')
        .setValue(('0' + rescatada).slice(-5));
      reparadas++;
    });

  const aBorrar = corruptas
    .filter(function (d) { return d.estado === 'pendiente'; })
    .sort(function (a, b) { return b._fila - a._fila; });

  aBorrar.forEach(function (d) { hojaDosis.deleteRow(d._fila); });

  console.log('Dosis del historial reparadas: ' + reparadas);
  console.log('Dosis pendientes borradas (se regeneran): ' + aBorrar.length);

  const creadas = generarDosisDelDia();
  console.log('Dosis regeneradas: ' + creadas);

  console.log('');
  console.log('RESULTADO: ' + arreglados + ' medicamento(s) reparado(s).');
  console.log('Zona horaria del script: ' + zonaHoraria_());
}

function prueba9_limpiar() {
  console.log('── Limpieza de datos de prueba ──');

  const meds = leerHoja_(HOJA.medicamentos)
    .map(normalizarMedicamento_)
    .filter(function (m) { return m.nombre.indexOf('PRUEBA') === 0; });

  const ids = {};
  meds.forEach(function (m) { ids[m.id] = true; });

  // Se borran de abajo hacia arriba: borrar una fila recorre las de abajo.
  const dosisHoja = hoja_(HOJA.dosis);
  const dosisBorrar = leerHoja_(HOJA.dosis)
    .map(normalizarDosis_)
    .filter(function (d) { return ids[d.medicamento_id]; })
    .sort(function (a, b) { return b._fila - a._fila; });

  dosisBorrar.forEach(function (d) { dosisHoja.deleteRow(d._fila); });

  const medHoja = hoja_(HOJA.medicamentos);
  meds.sort(function (a, b) { return b._fila - a._fila; })
      .forEach(function (m) { medHoja.deleteRow(m._fila); });

  console.log('Medicamentos borrados: ' + meds.length);
  console.log('Dosis borradas: ' + dosisBorrar.length);
  console.log('');
  console.log('RESULTADO: limpieza completa.');
}
