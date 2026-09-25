# Migración a Google Apps Script

Guía del paso de local a producción. **No ejecutes esto todavía** — es el plan que
seguiremos cuando el prototipo local ya esté aprobado.

---

## Panorama

| Pieza | Dónde vive | Rol |
|---|---|---|
| `index.html`, `css/`, `js/`, `sw.js` | GitHub Pages | Interfaz + PWA |
| Hojas `Usuarios`, `Medicamentos`, `Dosis`, `Config` | Google Sheet privado | Base de datos |
| `Codigo.gs` | Apps Script | API + trigger de recordatorios |
| App de OneSignal | onesignal.com | Entrega del push al celular |

**El repositorio de GitHub es público, pero no contiene ningún dato.** Solo código de
interfaz. Los correos, medicamentos y horarios viven exclusivamente en el Sheet privado,
al que solo accede tu cuenta de Google.

---

## Paso 1 · Crear el Google Sheet

Crea una hoja de cálculo llamada `PillTime DB` con cuatro pestañas. Los encabezados
deben ir en la fila 1 **con estos nombres exactos**, porque el código los busca por
nombre de columna, no por posición.

| Pestaña | Encabezados (fila 1) |
|---|---|
| `Usuarios` | `id`, `email`, `nombre`, `rol`, `activo`, `fecha_alta` |
| `Medicamentos` | `id`, `usuario_email`, `nombre`, `dosis`, `unidad`, `veces_al_dia`, `horarios`, `fecha_inicio`, `fecha_fin`, `notas`, `activo` |
| `Dosis` | `id`, `medicamento_id`, `usuario_email`, `fecha`, `hora_programada`, `estado`, `hora_confirmada`, `recordatorios_enviados`, `ultimo_recordatorio`, `email_enviado` |
| `Config` | `clave`, `valor` |

Atajo: exporta los CSV desde *Ajustes → Datos* en la app local y usa
*Archivo → Importar → Reemplazar hoja actual* en cada pestaña.

En `Usuarios`, agrega tu correo con `rol = admin` y `activo = TRUE`.

> **Importante:** pon la zona horaria correcta del proyecto en
> *Extensiones → Apps Script → Configuración del proyecto → Zona horaria*.
> Si queda en UTC, los recordatorios se dispararán con horas de diferencia.

---

## Paso 2 · Publicar la API en Apps Script

Desde el Sheet: *Extensiones → Apps Script*. El backend expone cuatro operaciones:

| Acción | Qué hace |
|---|---|
| `listar` | Devuelve medicamentos y dosis del día del usuario |
| `guardarMedicamento` | Alta o edición |
| `marcarDosis` | Confirma, omite o pospone una toma |
| `guardarConfig` | Actualiza los parámetros de recordatorio |

Esqueleto del punto de entrada, con la verificación de identidad que protege el endpoint:

```javascript
const SHEET_ID = 'pega-aquí-el-id-del-sheet';

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const email = verificarToken(req.idToken);      // ← nadie entra sin esto
    const datos = despachar(req.accion, email, req.datos);
    return json({ ok: true, datos: datos });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) });
  }
}

/**
 * Valida el ID token contra Google y comprueba que el correo esté autorizado.
 * Sin esto el Web App quedaría abierto a cualquiera que descubra la URL.
 */
function verificarToken(idToken) {
  if (!idToken) throw new Error('Falta el token de sesión.');

  const res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) throw new Error('Token inválido.');

  const info = JSON.parse(res.getContentText());
  if (info.aud !== CLIENT_ID) throw new Error('Token emitido para otra aplicación.');
  if (Number(info.exp) * 1000 < Date.now()) throw new Error('Token expirado.');

  const email = String(info.email).toLowerCase();
  const usuario = buscarFila('Usuarios', 'email', email);
  if (!usuario || String(usuario.activo).toUpperCase() !== 'TRUE') {
    throw new Error('Tu correo no está autorizado.');
  }
  return email;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

**Publicar:** *Implementar → Nueva implementación → Aplicación web*
- *Ejecutar como*: **Yo**
- *Quién tiene acceso*: **Cualquier usuario**

La combinación parece insegura pero es la correcta: "cualquier usuario" permite que el
navegador llegue al endpoint, y `verificarToken()` es quien filtra. Restringirlo a
"solo yo" rompería el acceso de los demás usuarios.

> La URL del Web App **cambia con cada nueva implementación**. Usa
> *Administrar implementaciones → editar → Versión nueva* para conservar la misma URL.

---

## Paso 3 · Los dos triggers

*Activadores → Añadir activador*:

| Función | Tipo | Frecuencia |
|---|---|---|
| `generarDosisDelDia` | Temporizador por día | 00:00 – 01:00 |
| `revisarRecordatorios` | Temporizador por minutos | **Cada 5 minutos** |

`revisarRecordatorios` es el port directo de `Scheduler.tick()`. La función
`Scheduler.evaluar()` de `js/scheduler.js` está escrita como función pura —sin DOM, sin
estado— precisamente para poder copiarla a `.gs` sin cambios.

```javascript
function revisarRecordatorios() {
  const cfg = leerConfig();
  const ahora = new Date();
  const hoy = Utilities.formatDate(ahora, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  leerDosisPendientes(hoy).forEach(function (dosis) {
    const decision = evaluar(dosis, ahora, cfg);      // ← idéntica a la del frontend

    if (decision.marcarVencida) return actualizarDosis(dosis.id, { estado: 'vencida' });

    if (decision.escalarEmail && !dosis.email_enviado) {
      MailApp.sendEmail({
        to: dosis.usuario_email,
        subject: '💊 No has marcado tu toma de ' + dosis.nombre,
        htmlBody: plantillaEmail(dosis)
      });
      actualizarDosis(dosis.id, { email_enviado: true });
    }

    if (decision.avisar) {
      enviarPush(dosis);
      actualizarDosis(dosis.id, {
        recordatorios_enviados: (dosis.recordatorios_enviados || 0) + 1,
        ultimo_recordatorio: ahora.toISOString()
      });
    }
  });
}
```

### Cuotas a tener presentes

| Recurso | Cuenta gratuita | Google Workspace |
|---|---|---|
| Emails por día | 100 | 1 500 |
| Tiempo de ejecución de triggers | 90 min/día | 6 h/día |
| `UrlFetchApp` por día | 20 000 | 100 000 |

Un trigger cada 5 minutos son 288 ejecuciones diarias. A ~2 segundos cada una da unos
10 minutos al día: cabe cómodamente incluso en la cuenta gratuita.

El cuello de botella real es el **email**: 100 diarios en cuenta gratuita. Por eso el
email es escalamiento y no canal principal.

---

## Paso 4 · Push al celular con OneSignal

1. Crea una app en [onesignal.com](https://onesignal.com) → plataforma *Web*.
2. Registra el dominio `https://tuusuario.github.io`.
3. OneSignal entrega un `APP_ID` y una `REST_API_KEY`.

En el frontend, sustituye el registro manual del Service Worker por el SDK de OneSignal
y guarda el `player_id` del usuario en la hoja `Usuarios` (columna nueva `push_id`).

Desde Apps Script, enviar el push son cinco líneas:

```javascript
function enviarPush(dosis) {
  const usuario = buscarFila('Usuarios', 'email', dosis.usuario_email);
  if (!usuario || !usuario.push_id) return;   // sin suscripción: queda el email

  UrlFetchApp.fetch('https://onesignal.com/api/v1/notifications', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Basic ' + REST_API_KEY },
    payload: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      include_player_ids: [usuario.push_id],
      headings: { es: '💊 Hora de ' + dosis.nombre },
      contents: { es: dosis.dosis + ' ' + dosis.unidad + ' · ' + dosis.hora_programada },
      buttons: [
        { id: 'tomada', text: '✓ Ya la tomé' },
        { id: 'posponer', text: '⏱ Posponer' }
      ]
    }),
    muteHttpExceptions: true
  });
}
```

Guarda las claves en *Configuración del proyecto → Propiedades del script*, nunca
escritas en el código.

> **iOS:** el Web Push solo funciona si el usuario abre la página en Safari y elige
> *Compartir → Agregar a pantalla de inicio* (iOS 16.4+). En Android y escritorio
> funciona sin instalar nada. Vale la pena poner un aviso en la app para usuarios iPhone.

---

## Paso 5 · Publicar el frontend

```bash
cd ~/Desktop/pill-reminder
git init && git add . && git commit -m "PillTime"
gh repo create pill-reminder --public --source=. --push
```

En *Settings → Pages* del repo, elige la rama `main` y la carpeta raíz. En unos minutos
queda en `https://tuusuario.github.io/pill-reminder/`.

**Antes de publicar**, reemplaza `js/store.js` por la versión que habla con Apps Script.
Es el único archivo que cambia: misma superficie de métodos, distinta implementación.

```javascript
const API = 'https://script.google.com/macros/s/XXXX/exec';

async function llamar(accion, datos) {
  const res = await fetch(API, {
    method: 'POST',
    body: JSON.stringify({ accion, datos, idToken: sesionGoogle.credential })
  });
  const r = await res.json();
  if (!r.ok) throw new Error(r.error);
  return r.datos;
}
```

> Apps Script no responde a peticiones `OPTIONS`, así que **no uses cabeceras
> personalizadas ni `Content-Type: application/json`** en el `fetch`. Con el `body`
> como texto plano el navegador evita el preflight de CORS y la llamada pasa.

---

## Paso 6 · Dar acceso a un usuario nuevo

1. Agrega su correo en la hoja `Usuarios` con `activo = TRUE`.
2. Mándale el enlace de GitHub Pages.
3. Entra con su cuenta de Google, acepta el permiso de notificaciones y —si usa
   iPhone— agrega la página a la pantalla de inicio.

Para revocar el acceso basta poner `activo = FALSE`. No hace falta tocar el código ni
volver a publicar.

---

## Orden recomendado

Cada paso deja algo funcionando; no hace falta completar todo para empezar a usarlo.

1. Sheet + API + `store.js` remoto → la app ya guarda en la nube.
2. Trigger de 5 minutos + email → los recordatorios ya funcionan con la app cerrada.
3. GitHub Pages + Sign in with Google → los demás usuarios ya pueden entrar.
4. OneSignal → el push reemplaza al email y el inbox queda limpio.
