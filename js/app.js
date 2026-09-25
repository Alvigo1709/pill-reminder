/**
 * app.js — Interfaz de usuario.
 *
 * Solo pinta y escucha eventos. Los datos vienen de Store, las decisiones de
 * recordatorio de Scheduler, y los avisos de Notify. Al migrar a Apps Script
 * este archivo no debería cambiar.
 */
(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  let usuario = null;
  let vistaActual = 'hoy';

  const ESTADOS = {
    pendiente: { etiqueta: 'Pendiente', clase: 'is-pendiente' },
    tomada:    { etiqueta: 'Tomada',    clase: 'is-tomada' },
    omitida:   { etiqueta: 'Omitida',   clase: 'is-omitida' },
    vencida:   { etiqueta: 'Sin marcar', clase: 'is-vencida' }
  };

  /* ═══════════════════════ arranque ═══════════════════════ */

  document.addEventListener('DOMContentLoaded', async () => {
    registrarServiceWorker();
    enlazarEventos();

    if (window.MODO_REMOTO) {
      await arrancarRemoto();
    } else {
      await arrancarLocal();
    }
  });

  /** Sin backend: la sesión es un correo guardado en localStorage. */
  async function arrancarLocal() {
    $('#loginLocal').hidden = false;
    $('#loginGoogle').hidden = true;

    const sesion = await Store.sesionActual();
    if (!sesion) return;

    try {
      usuario = await Store.login(sesion);
      await entrar();
    } catch (e) {
      await Store.logout();
    }
  }

  /** Con backend: la identidad la da Google y la valida Apps Script. */
  async function arrancarRemoto() {
    $('#loginLocal').hidden = true;
    $('#loginGoogle').hidden = false;

    try {
      await esperarGoogle();
    } catch (e) {
      return errorLogin('No cargó la librería de Google. Revisa tu conexión.');
    }

    try {
      Auth.iniciar($('#googleBtn'), async (perfil, silencioso) => {
        // Renovación automática del mismo usuario con la app ya abierta:
        // solo hay que refrescar datos, no rearrancar toda la pantalla.
        if (usuario && usuario.email === perfil.email) {
          try { await refrescar(); } catch (e) { /* el siguiente ciclo reintenta */ }
          return;
        }

        try {
          usuario = await Store.login();
          await entrar();
        } catch (err) {
          Auth.salir();
          errorLogin(err.message);
        }
      });
    } catch (e) {
      errorLogin(e.message);
    }
  }

  /** La librería de Google carga con `async defer`: hay que esperarla. */
  function esperarGoogle(msMax) {
    const limite = Date.now() + (msMax || 8000);
    return new Promise((resolver, rechazar) => {
      (function revisar() {
        if (window.google && google.accounts && google.accounts.id) return resolver();
        if (Date.now() > limite) return rechazar(new Error('timeout'));
        setTimeout(revisar, 120);
      })();
    });
  }

  function errorLogin(mensaje) {
    const hint = $('#loginHint');
    hint.textContent = mensaje;
    hint.classList.add('is-error');
  }

  function registrarServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') {
      console.warn('[app] abierto como file:// — sin Service Worker. Usa un servidor local.');
      return;
    }
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('[app] SW falló', e));

    // El SW reenvía aquí los clicks en los botones de la notificación.
    navigator.serviceWorker.addEventListener('message', async ev => {
      const { accion, dosisId } = ev.data || {};
      if (!dosisId) return;
      if (accion === 'tomada') await accionDosis(dosisId, 'tomada');
      if (accion === 'posponer') await accionPosponer(dosisId);
    });
  }

  /* ═══════════════════════ sesión ═══════════════════════ */

  async function entrar() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#userChip').textContent = usuario.nombre || usuario.email;

    await Scheduler.iniciar({
      email: usuario.email,
      onAlarma: mostrarAlarma,
      onCambio: refrescar
    });

    actualizarBotonNotif();
    await cargarConfigEnUI();
    await refrescar();
  }

  async function manejarLogin() {
    const email = $('#loginEmail').value;
    const hint = $('#loginHint');
    try {
      usuario = await Store.login(email);
      hint.textContent = 'Solo pueden entrar los correos autorizados.';
      hint.classList.remove('is-error');
      await entrar();
    } catch (e) {
      hint.textContent = e.message;
      hint.classList.add('is-error');
    }
  }

  /* ═══════════════════════ navegación ═══════════════════════ */

  function irA(vista) {
    vistaActual = vista;
    $$('.view').forEach(v => { v.hidden = v.dataset.view !== vista; });
    $$('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.goto === vista));
    refrescar();
  }

  /* ═══════════════════════ render ═══════════════════════ */

  async function refrescar() {
    if (!usuario) return;
    try {
      if (vistaActual === 'hoy') await pintarHoy();
      if (vistaActual === 'meds') await pintarMedicamentos();
      if (vistaActual === 'historial') await pintarHistorial();
      if (vistaActual === 'ajustes') await pintarAjustes();
    } catch (e) {
      if (e.sesionExpirada) return volverAlLogin(e.message);
      toast(e.message);
    }
  }

  /**
   * El ID token de Google dura una hora. Al caducar no podemos seguir
   * hablando con la API, así que devolvemos al usuario al login en vez de
   * dejar la pantalla con datos viejos que ya no se pueden guardar.
   */
  function volverAlLogin(mensaje) {
    Scheduler.detener();
    usuario = null;
    $('#app').hidden = true;
    $('#login').hidden = false;
    errorLogin(mensaje || 'Tu sesión expiró. Vuelve a entrar.');
  }

  async function pintarHoy() {
    const dosis = await Store.dosisDelDia(usuario.email);
    const cont = $('#listaHoy');

    $('#hoyFecha').textContent = new Date().toLocaleDateString('es-MX', {
      weekday: 'long', day: 'numeric', month: 'long'
    });

    const pct = Scheduler.adherencia(dosis);
    $('#adherenciaPct').textContent = pct === null ? '—' : pct + '%';
    $('#adherenciaRing').style.setProperty('--pct', (pct === null ? 0 : pct) + '%');

    // Tarjeta de próxima toma.
    const prox = Scheduler.proxima(dosis);
    const cajaProx = $('#proximaDosis');
    if (prox) {
      const faltan = Math.round((Fechas.aDate(prox.fecha, prox.hora_programada) - new Date()) / 60000);
      cajaProx.hidden = false;
      cajaProx.innerHTML = `
        <div class="next__label">Próxima toma</div>
        <div class="next__med">${esc(prox.medicamento.nombre)}</div>
        <div class="next__time">${prox.hora_programada} · ${textoFaltan(faltan)}</div>`;
    } else {
      cajaProx.hidden = true;
    }

    if (!dosis.length) {
      cont.innerHTML = vacio('🗓️', 'Nada programado para hoy',
        'Registra un medicamento para empezar a recibir recordatorios.',
        '<button class="btn btn--primary" data-goto="meds">Registrar medicamento</button>');
      return;
    }

    const ahora = new Date();
    cont.innerHTML = dosis.map(d => {
      const est = ESTADOS[d.estado];
      const pasada = Fechas.aDate(d.fecha, d.hora_programada) <= ahora;
      const atrasada = d.estado === 'pendiente' && pasada;

      return `
        <article class="dose ${est.clase} ${atrasada ? 'is-atrasada' : ''}">
          <div class="dose__time">
            <strong>${d.hora_programada}</strong>
            ${atrasada ? '<span class="dose__late">atrasada</span>' : ''}
          </div>
          <div class="dose__body">
            <h3>${esc(d.medicamento.nombre)}</h3>
            <p class="muted">${esc(descripcionDosis(d.medicamento))}</p>
            ${d.medicamento.notas ? `<p class="dose__note">📝 ${esc(d.medicamento.notas)}</p>` : ''}
            ${d.estado === 'tomada' && d.hora_confirmada
              ? `<p class="dose__ok">✓ Tomada a las ${d.hora_confirmada}</p>` : ''}
            ${d.recordatorios_enviados > 0 && d.estado === 'pendiente'
              ? `<p class="dose__nudges">🔔 ${d.recordatorios_enviados} recordatorio(s) enviado(s)</p>` : ''}
          </div>
          <div class="dose__actions">
            ${d.estado === 'pendiente' || d.estado === 'vencida' ? `
              <button class="btn btn--sm btn--primary" data-tomada="${d.id}">✓ Tomé</button>
              <button class="btn btn--sm btn--ghost" data-omitir="${d.id}">Omitir</button>
            ` : `<span class="badge ${est.clase}">${est.etiqueta}</span>`}
          </div>
        </article>`;
    }).join('');
  }

  async function pintarMedicamentos() {
    const meds = await Store.medicamentos(usuario.email);
    const cont = $('#listaMeds');

    if (!meds.length) {
      cont.innerHTML = vacio('💊', 'Aún no tienes medicamentos',
        'Registra el primero y define a qué horas lo tomas.',
        '<button class="btn btn--primary" id="vacioNuevoMed">+ Registrar medicamento</button>');
      $('#vacioNuevoMed').addEventListener('click', () => abrirModalMed());
      return;
    }

    cont.innerHTML = meds.map(m => `
      <article class="med">
        <div class="med__head">
          <h3>${esc(m.nombre)}</h3>
          <div class="med__tools">
            <button class="iconbtn" data-editar="${m.id}" title="Editar">✏️</button>
            <button class="iconbtn" data-borrar="${m.id}" title="Eliminar">🗑️</button>
          </div>
        </div>
        <p class="muted">${esc(descripcionDosis(m))} · ${m.veces_al_dia} ${m.veces_al_dia === 1 ? 'vez' : 'veces'} al día</p>
        <div class="med__horas">
          ${m.horarios.map(h => `<span class="hora">${h}</span>`).join('')}
        </div>
        ${m.notas ? `<p class="med__note">📝 ${esc(m.notas)}</p>` : ''}
        <p class="muted small">
          Desde ${m.fecha_inicio}${m.fecha_fin ? ` hasta ${m.fecha_fin}` : ' · sin fecha de fin'}
        </p>
      </article>`).join('');
  }

  async function pintarHistorial() {
    const dosis = await Store.historial(usuario.email, 30);
    const stats = $('#statsHistorial');
    const cont = $('#listaHistorial');

    const resueltas = dosis.filter(d => d.estado !== 'pendiente');
    const tomadas = resueltas.filter(d => d.estado === 'tomada').length;
    const perdidas = resueltas.filter(d => d.estado !== 'tomada').length;
    const pct = resueltas.length ? Math.round((tomadas / resueltas.length) * 100) : 0;

    stats.innerHTML = `
      <div class="stat"><strong>${pct}%</strong><span>Adherencia</span></div>
      <div class="stat"><strong>${tomadas}</strong><span>Tomadas</span></div>
      <div class="stat"><strong>${perdidas}</strong><span>No tomadas</span></div>`;

    if (!dosis.length) {
      cont.innerHTML = vacio('📊', 'Sin historial todavía', 'Aquí verás tus últimos 30 días.');
      return;
    }

    // Agrupado por día, más reciente primero.
    const porDia = dosis.reduce((acc, d) => {
      (acc[d.fecha] = acc[d.fecha] || []).push(d);
      return acc;
    }, {});

    cont.innerHTML = Object.keys(porDia).sort().reverse().map(fecha => `
      <div class="day">
        <h4>${etiquetaFecha(fecha)}</h4>
        ${porDia[fecha].sort((a, b) => a.hora_programada.localeCompare(b.hora_programada)).map(d => `
          <div class="hrow ${ESTADOS[d.estado].clase}">
            <span class="hrow__time">${d.hora_programada}</span>
            <span class="hrow__med">${esc(d.medicamento.nombre)}</span>
            <span class="badge ${ESTADOS[d.estado].clase}">${ESTADOS[d.estado].etiqueta}</span>
          </div>`).join('')}
      </div>`).join('');
  }

  async function pintarAjustes() {
    // La lista de usuarios es solo para el administrador; el backend la rechaza
    // para los demás, así que ni la pedimos.
    if (usuario.rol === 'admin') {
      try {
        const usuarios = await Store.usuarios();
        $('#listaUsuarios').innerHTML = usuarios
          .filter(u => u.activo !== false)
          .map(u => `
            <div class="user">
              <div>
                <strong>${esc(u.email)}</strong>
                <span class="badge ${u.rol === 'admin' ? 'is-admin' : ''}">${esc(u.rol)}</span>
              </div>
              ${u.email === usuario.email
                ? '<span class="muted small">tú</span>'
                : `<button class="iconbtn" data-quitar-usuario="${esc(u.email)}" title="Quitar acceso">✕</button>`}
            </div>`).join('');
      } catch (e) {
        $('#listaUsuarios').innerHTML = `<p class="muted small">No se pudo cargar: ${esc(e.message)}</p>`;
      }
    } else {
      $('#listaUsuarios').innerHTML =
        '<p class="muted small">Solo el administrador puede gestionar los accesos.</p>';
    }

    const perm = Notify.permiso;
    const etiquetaPerm = {
      granted: '✅ concedido', denied: '❌ bloqueado',
      default: '⏳ sin solicitar', unsupported: '🚫 no soportado'
    }[perm] || perm;

    $('#diagnostico').innerHTML = `
      <dt>Permiso de notificaciones</dt><dd>${etiquetaPerm}</dd>
      <dt>Service Worker</dt><dd>${'serviceWorker' in navigator
        ? (navigator.serviceWorker.controller ? '✅ activo' : '⏳ registrado, recarga la página')
        : '🚫 no soportado'}</dd>
      <dt>Origen</dt><dd><code>${location.origin || 'file://'}</code></dd>
      <dt>Motor de recordatorios</dt><dd>${Scheduler._timer ? '✅ corriendo' : '⏸ detenido'}</dd>`;
  }

  /* ═══════════════════════ alarma ═══════════════════════ */

  async function mostrarAlarma(dosis) {
    const cfg = await Store.config();
    const med = dosis.medicamento;
    const n = dosis.recordatorios_enviados || 1;

    $('#alarmKicker').textContent = n > 1
      ? `Recordatorio ${n} · aún no marcas esta toma`
      : 'Es hora de tu medicamento';
    $('#alarmMed').textContent = med.nombre;
    $('#alarmDosis').textContent = descripcionDosis(med);
    $('#alarmHora').textContent = 'Programada para las ' + dosis.hora_programada;
    $('#alarmNota').textContent = med.notas ? '📝 ' + med.notas : '';
    $('#alarmCount').textContent = n > 1
      ? `Seguiré avisando cada ${cfg.intervaloRecordatorioMin} min hasta que marques la toma.`
      : '';

    $('#alarmOverlay').dataset.dosisId = dosis.id;
    $('#alarmOverlay').hidden = false;

    if (cfg.sonido) Notify.sonar();
    Notify.iniciarFlash(`¡Toma ${med.nombre}!`);

    Notify.enviar({
      titulo: `💊 Hora de ${med.nombre}`,
      cuerpo: `${descripcionDosis(med)} · programada ${dosis.hora_programada}` +
              (n > 1 ? ` (recordatorio ${n})` : ''),
      tag: 'dosis-' + dosis.id,
      datos: { dosisId: dosis.id }
    });
  }

  function cerrarAlarma() {
    $('#alarmOverlay').hidden = true;
    Notify.detenerFlash();
  }

  async function accionDosis(dosisId, estado) {
    await Scheduler.confirmar(dosisId, estado);
    cerrarAlarma();
    toast(estado === 'tomada' ? '✓ Toma registrada' : 'Toma omitida');
  }

  async function accionPosponer(dosisId) {
    await Scheduler.posponer(dosisId, 10);
    cerrarAlarma();
    toast('⏱ Te aviso en 10 minutos');
  }

  /* ═══════════════════════ modal de medicamento ═══════════════════════ */

  async function abrirModalMed(id) {
    const form = $('#medForm');
    form.reset();
    $('#medId').value = '';
    $('#medInicio').value = Fechas.hoyISO();

    if (id) {
      const med = await Store.medicamento(id);
      if (!med) return;
      $('#medModalTitulo').textContent = 'Editar medicamento';
      $('#medId').value = med.id;
      $('#medNombre').value = med.nombre;
      $('#medDosis').value = med.dosis;
      $('#medUnidad').value = med.unidad || 'mg';
      $('#medVeces').value = med.veces_al_dia;
      $('#medInicio').value = med.fecha_inicio;
      $('#medFin').value = med.fecha_fin || '';
      $('#medNotas').value = med.notas || '';
      pintarHorarios(med.veces_al_dia, med.horarios);
    } else {
      $('#medModalTitulo').textContent = 'Nuevo medicamento';
      pintarHorarios(1);
    }

    $('#medModal').hidden = false;
    setTimeout(() => $('#medNombre').focus(), 50);
  }

  function cerrarModalMed() {
    $('#medModal').hidden = true;
  }

  /**
   * Genera un input de hora por cada toma diaria. Al cambiar el número de veces
   * conserva las horas ya capturadas y rellena las nuevas con la distribución
   * automática.
   */
  function pintarHorarios(veces, valores) {
    const n = Number(veces) || 1;
    const previos = valores || horariosActuales();
    const sugeridos = distribuir(n);
    const wrap = $('#horariosWrap');

    wrap.innerHTML = Array.from({ length: n }, (_, i) => `
      <label class="horario">
        <span>Toma ${i + 1}</span>
        <input type="time" required value="${previos[i] || sugeridos[i]}" data-horario>
      </label>`).join('');
  }

  function horariosActuales() {
    return $$('[data-horario]').map(i => i.value).filter(Boolean);
  }

  /**
   * Reparte N tomas entre las 8:00 y las 22:00, que es la franja despierta
   * habitual. Con 1 toma da 08:00; con 3, 08:00 / 15:00 / 22:00.
   */
  function distribuir(n) {
    const inicio = 8 * 60;
    const fin = 22 * 60;
    if (n === 1) return ['08:00'];

    const paso = (fin - inicio) / (n - 1);
    return Array.from({ length: n }, (_, i) => {
      const min = Math.round((inicio + paso * i) / 5) * 5;   // redondeo a 5 min
      return `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    });
  }

  async function guardarMedicamento(ev) {
    ev.preventDefault();

    const horarios = horariosActuales();
    const veces = Number($('#medVeces').value);

    if (horarios.length !== veces || horarios.some(h => !h)) {
      toast('Completa todas las horas de toma');
      return;
    }
    if (new Set(horarios).size !== horarios.length) {
      toast('Hay horas repetidas');
      return;
    }

    const inicio = $('#medInicio').value;
    const fin = $('#medFin').value;
    if (fin && inicio && fin < inicio) {
      toast('La fecha de fin es anterior a la de inicio');
      return;
    }

    await Store.guardarMedicamento({
      id: $('#medId').value || null,
      usuario_email: usuario.email,
      nombre: $('#medNombre').value.trim(),
      dosis: $('#medDosis').value.trim(),
      unidad: $('#medUnidad').value,
      veces_al_dia: veces,
      horarios: horarios.sort(),
      fecha_inicio: inicio,
      fecha_fin: fin,
      notas: $('#medNotas').value.trim()
    });

    await Store.generarDosisDelDia(usuario.email);
    cerrarModalMed();
    toast('✓ Medicamento guardado');
    await refrescar();
  }

  /* ═══════════════════════ ajustes ═══════════════════════ */

  async function cargarConfigEnUI() {
    const cfg = await Store.config();
    $('#cfgIntervalo').value = cfg.intervaloRecordatorioMin;
    $('#cfgAvisoPrevio').value = cfg.avisoPrevioMin;
    $('#cfgMaxRecordatorios').value = cfg.maxRecordatorios;
    $('#cfgSonido').checked = cfg.sonido;
    $('#cfgEscalarEmail').value = cfg.escalarEmailMin;
  }

  async function guardarConfigDesdeUI() {
    await Store.guardarConfig({
      intervaloRecordatorioMin: Number($('#cfgIntervalo').value),
      avisoPrevioMin: Number($('#cfgAvisoPrevio').value),
      maxRecordatorios: Number($('#cfgMaxRecordatorios').value),
      sonido: $('#cfgSonido').checked,
      escalarEmailMin: Number($('#cfgEscalarEmail').value)
    });
    await Scheduler.recargarConfig();
    toast('✓ Ajustes guardados');
  }

  function descargarCSV(tabla) {
    Store.exportarCSV(tabla).then(csv => {
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = tabla + '.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    }).catch(e => toast(e.message));
  }

  async function actualizarBotonNotif() {
    const btn = $('#notifBtn');
    const perm = Notify.permiso;
    btn.classList.toggle('is-on', perm === 'granted');
    btn.title = {
      granted: 'Notificaciones activas',
      denied: 'Notificaciones bloqueadas en el navegador',
      default: 'Clic para activar notificaciones',
      unsupported: 'Tu navegador no soporta notificaciones'
    }[perm];
  }

  /* ═══════════════════════ eventos ═══════════════════════ */

  function enlazarEventos() {
    $('#loginBtn').addEventListener('click', manejarLogin);
    $('#loginEmail').addEventListener('keydown', e => { if (e.key === 'Enter') manejarLogin(); });

    $('#userChip').addEventListener('click', async () => {
      if (!confirm('¿Cerrar sesión?')) return;
      await Store.logout();
      Scheduler.detener();
      location.reload();
    });

    $('#notifBtn').addEventListener('click', async () => {
      Notify.desbloquearAudio();
      const r = await Notify.pedirPermiso();
      actualizarBotonNotif();
      toast(r === 'granted'
        ? '🔔 Notificaciones activadas'
        : 'No se concedió el permiso. Actívalo desde el candado de la barra de direcciones.');
      if (vistaActual === 'ajustes') pintarAjustes();
    });

    $('#nuevoMedBtn').addEventListener('click', () => abrirModalMed());
    $('#medForm').addEventListener('submit', guardarMedicamento);
    $('#medVeces').addEventListener('change', e => pintarHorarios(e.target.value));
    $('#autoHorariosBtn').addEventListener('click', () => {
      pintarHorarios($('#medVeces').value, distribuir(Number($('#medVeces').value)));
    });

    $('#alarmTomada').addEventListener('click', () => accionDosis($('#alarmOverlay').dataset.dosisId, 'tomada'));
    $('#alarmOmitir').addEventListener('click', () => accionDosis($('#alarmOverlay').dataset.dosisId, 'omitida'));
    $('#alarmPosponer').addEventListener('click', () => accionPosponer($('#alarmOverlay').dataset.dosisId));

    ['#cfgIntervalo', '#cfgAvisoPrevio', '#cfgMaxRecordatorios', '#cfgSonido', '#cfgEscalarEmail']
      .forEach(sel => $(sel).addEventListener('change', guardarConfigDesdeUI));

    $('#agregarUsuarioBtn').addEventListener('click', async () => {
      try {
        await Store.agregarUsuario($('#nuevoUsuarioEmail').value);
        $('#nuevoUsuarioEmail').value = '';
        toast('✓ Acceso concedido');
        await pintarAjustes();
      } catch (e) { toast(e.message); }
    });

    $('#seedBtn').addEventListener('click', async () => {
      try {
        await Store.cargarEjemplo(usuario.email);
        await Store.generarDosisDelDia(usuario.email);
        toast('✓ Datos de ejemplo cargados');
        irA('hoy');
      } catch (e) { toast(e.message); }
    });

    $('#resetBtn').addEventListener('click', async () => {
      if (!confirm('Esto borra TODOS los datos locales. ¿Continuar?')) return;
      try {
        await Store.borrarTodo();
        location.reload();
      } catch (e) { toast(e.message); }
    });

    $('#testNotifBtn').addEventListener('click', async () => {
      Notify.desbloquearAudio();
      if (Notify.permiso !== 'granted') await Notify.pedirPermiso();
      Notify.sonar();
      const ok = await Notify.enviar({
        titulo: '💊 Prueba de PillTime',
        cuerpo: 'Si ves esto, las notificaciones funcionan correctamente.',
        tag: 'prueba',
        requiereInteraccion: false
      });
      toast(ok ? 'Notificación enviada' : 'No se pudo enviar. Revisa el permiso.');
      await pintarAjustes();
    });

    // Delegación: cubre botones que se crean dinámicamente al pintar.
    document.addEventListener('click', async e => {
      const t = e.target.closest('[data-goto], [data-tomada], [data-omitir], [data-editar], ' +
                                 '[data-borrar], [data-export], [data-quitar-usuario], [data-close-modal]');
      if (!t) return;

      if (t.dataset.goto)    return irA(t.dataset.goto);
      if (t.dataset.tomada)  return accionDosis(t.dataset.tomada, 'tomada');
      if (t.dataset.omitir)  return accionDosis(t.dataset.omitir, 'omitida');
      if (t.dataset.editar)  return abrirModalMed(t.dataset.editar);
      if (t.dataset.export)  return descargarCSV(t.dataset.export);
      if (t.hasAttribute('data-close-modal')) return cerrarModalMed();

      if (t.dataset.borrar) {
        if (!confirm('¿Eliminar este medicamento? El historial se conserva.')) return;
        await Store.eliminarMedicamento(t.dataset.borrar);
        toast('Medicamento eliminado');
        return refrescar();
      }

      if (t.dataset.quitarUsuario) {
        try {
          await Store.quitarUsuario(t.dataset.quitarUsuario);
          await pintarAjustes();
        } catch (err) { toast(err.message); }
      }
    });

    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (!$('#medModal').hidden) cerrarModalMed();
    });

    // Al volver a la pestaña, recalcula: pudo pasar tiempo con el equipo dormido.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && usuario) Scheduler.tick();
    });

    // Primer gesto de la sesión: desbloquea el audio para que la alarma suene.
    document.addEventListener('click', () => Notify.desbloquearAudio(), { once: true });
  }

  /* ═══════════════════════ helpers de presentación ═══════════════════════ */

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function descripcionDosis(med) {
    if (!med.dosis) return med.unidad || '';
    return `${med.dosis} ${med.unidad || ''}`.trim();
  }

  function textoFaltan(min) {
    if (min < 1) return 'ahora mismo';
    if (min < 60) return `en ${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `en ${h} h ${m} min` : `en ${h} h`;
  }

  function etiquetaFecha(fecha) {
    const hoy = Fechas.hoyISO();
    const ayer = new Date();
    ayer.setDate(ayer.getDate() - 1);

    if (fecha === hoy) return 'Hoy';
    if (fecha === Fechas.hoyISO(ayer)) return 'Ayer';
    return Fechas.aDate(fecha, '00:00').toLocaleDateString('es-MX', {
      weekday: 'long', day: 'numeric', month: 'long'
    });
  }

  function vacio(icono, titulo, texto, accionHTML) {
    return `<div class="empty">
      <div class="empty__icon">${icono}</div>
      <h3>${titulo}</h3>
      <p class="muted">${texto}</p>
      ${accionHTML || ''}
    </div>`;
  }

  let toastTimer = null;
  function toast(mensaje) {
    const el = $('#toast');
    el.textContent = mensaje;
    el.hidden = false;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('is-visible');
      setTimeout(() => { el.hidden = true; }, 250);
    }, 2600);
  }

})();
