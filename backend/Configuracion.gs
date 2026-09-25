/**
 * Configuracion.gs — Constantes del proyecto.
 *
 * Es el ÚNICO archivo que necesitas editar al montar el backend.
 * Los demás funcionan tal cual.
 */

/**
 * ID de tu Google Sheet. Sale de la URL, entre /d/ y /edit:
 *
 *   https://docs.google.com/spreadsheets/d/  1A2B3C...XyZ  /edit
 *                                            └──── esto ────┘
 */
const SHEET_ID = 'PEGA_AQUI_EL_ID_DE_TU_SHEET';

/**
 * Client ID de OAuth, para validar quién entra.
 * Déjalo vacío mientras trabajas en modo desarrollo (fase 1).
 * Lo llenarás en la fase 2, cuando conectemos Sign in with Google.
 */
const CLIENT_ID = '';

/**
 * ⚠️  MODO DESARROLLO
 *
 * En true, la API acepta el correo del usuario directamente, sin validar
 * token de Google. Sirve para probar el backend antes de montar el login.
 *
 * Mientras esto sea true, la implementación DEBE estar publicada con
 * "Quién tiene acceso: Solo yo". Así nadie más puede ni alcanzar la URL.
 *
 * Antes de cambiarla a "Cualquier usuario" —que es necesario para que entren
 * tu papá y tu hermana— pon esta constante en false y llena CLIENT_ID.
 */
const MODO_DESARROLLO = true;

/** Nombres de las pestañas. Deben coincidir con las del Sheet. */
const HOJA = {
  usuarios: 'Usuarios',
  medicamentos: 'Medicamentos',
  dosis: 'Dosis',
  config: 'Config'
};

/** Valores por defecto si la hoja Config viniera incompleta. */
const CONFIG_DEFAULT = {
  intervaloRecordatorioMin: 5,
  avisoPrevioMin: 0,
  maxRecordatorios: 12,
  escalarEmailMin: 15
};

/** Remitente visible en los emails de recordatorio. */
const NOMBRE_REMITENTE = 'PillTime';

/** URL de la app publicada. Se usa en el botón del email. Llénala en la fase 5. */
const URL_APP = 'https://alvigo1709.github.io/pill-reminder/';
