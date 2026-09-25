# PillTime · Recordatorio de pastillas

Aplicación de recordatorios de medicamentos que **insiste cada 5 minutos hasta que el
usuario confirma la toma**. Versión local en HTML/CSS/JS, lista para migrar a Google
Apps Script + Google Sheets.

---

## Cómo correrlo en local

La app **necesita un servidor**: abrirla con doble clic (`file://`) deshabilita el
Service Worker y las notificaciones.

```bash
cd ~/Desktop/pill-reminder
python3 -m http.server 8080
```

Abre <http://localhost:8080> y entra con tu correo.

> El **primer correo que entra queda como administrador** automáticamente. A partir de
> ahí, solo los correos que autorices en *Ajustes → Usuarios autorizados* pueden entrar.

### Primeros pasos

1. Pulsa el **🔔** en la barra superior para conceder el permiso de notificaciones.
2. *Medicamentos → + Nuevo*: nombre, dosis, cuántas veces al día y a qué horas.
   El botón **Distribuir automáticamente** reparte las tomas entre 8:00 y 22:00.
3. *Ajustes → Cargar datos de ejemplo* crea tres medicamentos de prueba; uno de ellos
   dispara la alarma a los ~2 minutos para que veas el flujo completo.

### Probar la insistencia sin esperar

En *Ajustes* pon **Repetir aviso cada → 1 minuto (pruebas)** y registra un medicamento
con una hora ya pasada. La alarma volverá cada minuto hasta que marques "Ya la tomé".

---

## Cómo funciona el recordatorio

```
        hora programada
              │
   ┌──────────┴──────────────────────────────────────────┐
   │ aviso 1   aviso 2   aviso 3   ...                    │
   │   │─5min────│─5min────│─5min────►                    │
   │                                                      │
   │   a los 15 min sin marcar ──► email de respaldo      │
   │   tras 12 avisos ────────────► dosis "sin marcar"    │
   └──────────────────────────────────────────────────────┘
              ▲
     "Ya la tomé" corta la cadena en cualquier punto
```

Tres canales de aviso simultáneos, de menos a más intrusivo:

| Canal | Cuándo sirve |
|---|---|
| Título de la pestaña parpadeando | La pestaña está en segundo plano |
| Notificación del sistema | Aunque el navegador no esté al frente |
| Alarma a pantalla completa + sonido | La pestaña está visible |

Los tres parámetros —intervalo, aviso previo y límite de insistencia— se configuran
en *Ajustes* y viven en la tabla `Config`.

---

## Estructura

```
pill-reminder/
├── index.html            Estructura de todas las vistas
├── manifest.json         Metadatos PWA (instalable en el celular)
├── sw.js                 Service Worker: caché offline + botones de la notificación
├── icon.svg              Ícono (icon-maskable.svg para Android)
├── css/styles.css        Estilos, mobile-first
└── js/
    ├── store.js          ► Capa de datos. LO ÚNICO que cambia al migrar.
    ├── notify.js         Permisos, notificaciones, sonido, flash del título
    ├── scheduler.js      Motor de recordatorios (lógica de negocio pura)
    └── app.js            Interfaz: pinta y escucha eventos
```

La separación es deliberada: **`store.js` es la única frontera con los datos**.
Ningún otro archivo toca `localStorage`. Al migrar, se reimplementan sus métodos para
que hagan `fetch()` contra el Web App de Apps Script y el resto de la app no se entera.

Todos los métodos de `Store` ya son `async`, justamente para que la firma no cambie
cuando detrás haya una llamada de red.

---

## Esquema de datos

Replica 1:1 las hojas que tendrá el Google Sheet. Desde *Ajustes → Datos* puedes
exportar cada tabla en CSV con estas columnas exactas e importarla directamente.

**Usuarios**
| id | email | nombre | rol | activo | fecha_alta |
|---|---|---|---|---|---|

**Medicamentos**
| id | usuario_email | nombre | dosis | unidad | veces_al_dia | horarios | fecha_inicio | fecha_fin | notas | activo |
|---|---|---|---|---|---|---|---|---|---|---|

`horarios` se guarda como `08:00|15:00|22:00` (separado por pipe) para que quepa en una celda.

**Dosis**
| id | medicamento_id | usuario_email | fecha | hora_programada | estado | hora_confirmada | recordatorios_enviados | ultimo_recordatorio | email_enviado |
|---|---|---|---|---|---|---|---|---|---|

`estado` ∈ `pendiente` · `tomada` · `omitida` · `vencida`

**Config**
| clave | valor |
|---|---|

---

## Migración a Apps Script

Ver [MIGRACION.md](MIGRACION.md) para el paso a paso.

Resumen de la arquitectura destino:

```
   Frontend (GitHub Pages)          Backend (Apps Script)
   ┌─────────────────────┐          ┌──────────────────────┐
   │ index.html + PWA    │  fetch   │ doGet / doPost       │
   │ Service Worker      │ ───────► │ valida ID token      │
   │ Sign in with Google │  + JWT   │ lee/escribe Sheets   │
   └─────────────────────┘          └──────────┬───────────┘
            ▲                                  │
            │  push                    trigger cada 5 min
            │                                  │
      ┌─────┴──────┐                  ┌────────▼─────────┐
      │ OneSignal  │ ◄────────────────│ busca pendientes │
      └────────────┘                  └──────────────────┘
```

**Dos restricciones que condicionan el diseño** y conviene tener presentes:

1. **La Notification API no funciona dentro de Apps Script.** Sus Web Apps se sirven en
   un iframe cross-origin (`googleusercontent.com`) y los navegadores bloquean ahí tanto
   el permiso de notificaciones como el registro de Service Workers. Por eso el frontend
   debe vivir en origen propio.
2. **Apps Script no puede enviar Web Push por sí solo.** El protocolo exige firmar con
   ECDSA P-256 y Apps Script no tiene esa criptografía nativa. Se necesita un
   intermediario (OneSignal es el camino más corto: un `UrlFetchApp` de cinco líneas).

---

## Estado actual

| Funciona hoy en local | Pendiente para producción |
|---|---|
| Registro de medicamentos con N tomas diarias | Backend en Apps Script + Sheets |
| Horarios manuales o autodistribuidos | Sign in with Google |
| Alarma que insiste cada 5 min hasta confirmar | Trigger de 5 min del lado servidor |
| Notificación del sistema con botones de acción | Web Push vía OneSignal |
| Posponer 10 min · Omitir · Marcar tomada | Envío real de email (hoy solo consola) |
| Historial de 30 días y % de adherencia | |
| Control de acceso por correo | |
| Export CSV con el esquema de las hojas | |
| Instalable como PWA · funciona offline | |
