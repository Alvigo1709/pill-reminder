/**
 * scheduler.js — Motor de recordatorios.
 *
 * Es el corazón de la app: decide QUÉ dosis toca avisar y CUÁNDO repetir.
 * La lógica está escrita a propósito sin tocar el DOM, porque este mismo
 * algoritmo se va a copiar tal cual al trigger de Apps Script que corre
 * cada 5 minutos del lado servidor.
 *
 * Regla de negocio:
 *   - Una dosis "vence" cuando llega su hora (menos el aviso previo).
 *   - Desde ese momento se avisa, y se vuelve a avisar cada N minutos.
 *   - Deja de avisar SOLO cuando el usuario marca tomada u omitida.
 *   - Tras `maxRecordatorios` avisos sin respuesta, la dosis pasa a 'vencida'
 *     y se detiene la insistencia.
 *   - Si pasan `escalarEmailMin` minutos sin respuesta, se escala a email
 *     (una sola vez por dosis). En local solo se registra en consola.
 */
(function (global) {
  'use strict';

  const TICK_MS = 20000;   // cada cuánto revisa el reloj. No es el intervalo de aviso.

  const Scheduler = {
    _timer: null,
    _email: null,
    _cfg: null,
    _onAlarma: null,       // callback(dosis) cuando toca avisar
    _onCambio: null,       // callback() cuando algo cambió y la UI debe repintar
    _dosisActiva: null,    // dosis que está sonando ahora mismo

    /* ─────────────── ciclo de vida ─────────────── */

    async iniciar({ email, onAlarma, onCambio }) {
      this._email = email;
      this._onAlarma = onAlarma;
      this._onCambio = onCambio;
      this._cfg = await Store.config();

      await Store.generarDosisDelDia(email);
      this.detener();
      this._timer = setInterval(() => this.tick(), TICK_MS);
      this.tick();
    },

    detener() {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
    },

    async recargarConfig() {
      this._cfg = await Store.config();
    },

    /* ─────────────── el latido ─────────────── */

    async tick() {
      if (!this._email) return;

      const ahora = new Date();
      const hoy = Fechas.hoyISO(ahora);

      // Cambio de día a medianoche: materializa las dosis del día nuevo.
      await Store.generarDosisDelDia(this._email, hoy);

      const dosisHoy = await Store.dosisDelDia(this._email, hoy);
      let huboCambios = false;

      for (const dosis of dosisHoy) {
        if (dosis.estado !== 'pendiente') continue;

        const decision = this.evaluar(dosis, ahora, this._cfg);

        if (decision.marcarVencida) {
          await Store.marcarDosis(dosis.id, 'vencida');
          huboCambios = true;
          continue;
        }

        if (decision.escalarEmail && !dosis.email_enviado) {
          await Store.marcarEmailEnviado(dosis.id);
          this.enviarEmail(dosis);
          huboCambios = true;
        }

        if (decision.avisar) {
          await Store.registrarRecordatorio(dosis.id);
          huboCambios = true;
          // Solo una alarma en pantalla a la vez; el resto espera al siguiente tick.
          if (!this._dosisActiva && this._onAlarma) {
            const fresca = (await Store.dosisDelDia(this._email, hoy)).find(d => d.id === dosis.id);
            this._dosisActiva = fresca;
            this._onAlarma(fresca);
          }
        }
      }

      if (huboCambios && this._onCambio) this._onCambio();
    },

    /**
     * Función pura: dado el estado de una dosis y el momento actual, decide qué hacer.
     * Sin efectos secundarios, para poder portarla a Apps Script sin cambios.
     */
    evaluar(dosis, ahora, cfg) {
      const resultado = { avisar: false, marcarVencida: false, escalarEmail: false };

      const programada = Fechas.aDate(dosis.fecha, dosis.hora_programada);
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

      const minutosDesdeUltimo = (ahora - ultimo) / 60000;
      if (minutosDesdeUltimo >= (cfg.intervaloRecordatorioMin || 5)) {
        resultado.avisar = true;
      }

      return resultado;
    },

    /* ─────────────── acciones del usuario ─────────────── */

    async confirmar(dosisId, estado) {
      await Store.marcarDosis(dosisId, estado);
      if (this._dosisActiva && this._dosisActiva.id === dosisId) this._dosisActiva = null;
      if (this._onCambio) this._onCambio();
    },

    async posponer(dosisId, minutos) {
      const hasta = new Date(Date.now() + (minutos || 10) * 60000).toISOString();
      await Store.marcarDosis(dosisId, 'pendiente', { posponer_hasta: hasta });
      if (this._dosisActiva && this._dosisActiva.id === dosisId) this._dosisActiva = null;
      if (this._onCambio) this._onCambio();
    },

    /** La alarma se cerró sin decidir: libera el turno para el siguiente tick. */
    liberar() {
      this._dosisActiva = null;
    },

    /**
     * Punto de extensión. En local solo deja rastro en consola; en Apps Script
     * este método se convierte en MailApp.sendEmail() del lado servidor.
     */
    enviarEmail(dosis) {
      const nombre = dosis.medicamento ? dosis.medicamento.nombre : 'tu medicamento';
      console.info(
        `[email] → ${dosis.usuario_email}: no has marcado "${nombre}" de las ${dosis.hora_programada}.`
      );
    },

    /* ─────────────── datos derivados para la UI ─────────────── */

    /** Próxima dosis pendiente del día, o null si ya no queda ninguna. */
    proxima(dosisHoy, ahora) {
      const t = ahora || new Date();
      return dosisHoy
        .filter(d => d.estado === 'pendiente' && Fechas.aDate(d.fecha, d.hora_programada) > t)
        .sort((a, b) => a.hora_programada.localeCompare(b.hora_programada))[0] || null;
    },

    /** % de dosis atendidas sobre las que ya deberían haberse tomado. */
    adherencia(dosis) {
      const resueltas = dosis.filter(d => d.estado !== 'pendiente');
      if (!resueltas.length) return null;
      const tomadas = resueltas.filter(d => d.estado === 'tomada').length;
      return Math.round((tomadas / resueltas.length) * 100);
    }
  };

  global.Scheduler = Scheduler;

})(window);
