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
window.CLIENT_ID = '154074108464-26fga9ti0m62d1hp7luoklrf9o3hc4ct.apps.googleusercontent.com';

/**
 * Firebase Cloud Messaging — notificaciones con la app cerrada.
 *
 * Todos estos valores son PÚBLICOS por diseño, igual que el CLIENT_ID: sirven
 * para identificar la app ante Google, no para autorizar nada. Lo que sí es
 * secreto es el JSON de la cuenta de servicio, y ese vive solo en las
 * Propiedades del script de Apps Script, nunca en este repositorio.
 *
 * Sale de: Firebase Console → Configuración del proyecto → General → Tus apps.
 */
window.FIREBASE_CONFIG = {
  apiKey: 'PEGA_AQUI_apiKey',
  authDomain: 'PEGA_AQUI_authDomain',
  projectId: 'PEGA_AQUI_projectId',
  messagingSenderId: 'PEGA_AQUI_messagingSenderId',
  appId: 'PEGA_AQUI_appId'
};

/**
 * Clave VAPID pública.
 * Firebase Console → Configuración del proyecto → Cloud Messaging →
 * Certificados push web → Generar par de claves.
 */
window.VAPID_KEY = 'PEGA_AQUI_LA_CLAVE_VAPID';

/** true cuando el push está configurado. */
window.PUSH_ACTIVO = Boolean(window.VAPID_KEY) &&
                     window.VAPID_KEY.indexOf('PEGA_AQUI') !== 0;

/** Cada cuántos segundos el modo remoto vuelve a leer el Sheet. */
window.REFRESCO_SEGUNDOS = 60;

/** true cuando hay backend configurado. */
window.MODO_REMOTO = Boolean(window.API_URL) &&
                     window.API_URL.indexOf('script.google.com') !== -1;
