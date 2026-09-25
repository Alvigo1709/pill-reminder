/**
 * config.js — Configuración del despliegue.
 *
 * Es el ÚNICO archivo que cambias para pasar de local a producción.
 *
 *   API_URL vacío  → modo local: los datos viven en localStorage del navegador.
 *   API_URL lleno  → modo remoto: los datos viven en tu Google Sheet.
 *
 * Todo se asigna explícitamente a `window`. NO uses `const` aquí: en el ámbito
 * global, `const` crea un binding léxico que NO aparece como propiedad de
 * window, así que `window.MODO_REMOTO` daría undefined y los demás archivos
 * creerían que no hay backend configurado.
 */

/**
 * URL del Web App de Apps Script.
 * Déjala vacía ('') para trabajar en local sin backend.
 */
window.API_URL = 'https://script.google.com/macros/s/AKfycbxHVZfBFDSK7-WFidV1KuVi2Hq3HKyeGOEQ9gy7GEdC0JhP5b0XbRqZa2MJdRC_alZ0eQ/exec';

/**
 * ID de cliente de OAuth, de Google Cloud Console.
 * Debe terminar en .apps.googleusercontent.com
 *
 * Los orígenes autorizados de ese cliente deben incluir:
 *   https://alvigo1709.github.io
 *   http://localhost:8080
 */
window.CLIENT_ID = 'PEGA_AQUI_TU_CLIENT_ID.apps.googleusercontent.com';

/** Cada cuántos segundos el modo remoto vuelve a leer el Sheet. */
window.REFRESCO_SEGUNDOS = 60;

/** true cuando hay backend configurado. */
window.MODO_REMOTO = Boolean(window.API_URL) &&
                     window.API_URL.indexOf('script.google.com') !== -1;
