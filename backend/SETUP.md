# Montaje del backend · paso a paso

Tiempo estimado: **45–60 minutos**, casi todo haciendo clic en consolas.

Al terminar tendrás la base de datos en la nube y la API funcionando, verificada
con ocho pruebas automáticas. Todavía sin login de Google ni push — eso es la
siguiente fase.

---

## Paso 1 · Subir la base de datos (5 min)

1. Sube **`PillTime-DB.xlsx`** a tu Google Drive.
2. Ábrelo y ve a *Archivo → Guardar como Hoja de cálculo de Google*.
   Esto crea una copia nativa; el `.xlsx` original puedes borrarlo.
3. En la pestaña **Usuarios**, fila 2: cambia el correo por la cuenta de Google
   que vas a usar como administrador.
4. Agrega a tu papá y a tu hermana como filas 3 y 4:

   | id | email | nombre | rol | activo | fecha_alta | push_token |
   |---|---|---|---|---|---|---|
   | `usr_papa` | correo-de-tu-papá@gmail.com | Papá | usuario | TRUE | 2026-09-25 | *(vacío)* |
   | `usr_hermana` | correo-de-tu-hermana@gmail.com | Hermana | usuario | TRUE | 2026-09-25 | *(vacío)* |

   Deja **Medicamentos** y **Dosis** vacías: las llena el sistema solo.

5. Copia el **ID del Sheet** de la URL:

   ```
   https://docs.google.com/spreadsheets/d/ 1A2B3C...XyZ /edit
                                           └─── esto ───┘
   ```

---

## Paso 2 · Crear el proyecto de Apps Script (10 min)

Desde el Sheet: *Extensiones → Apps Script*. Se abre el editor con un
`Codigo.gs` vacío.

**Crea cinco archivos** con el botón **+** junto a "Archivos" y pega el contenido
de cada uno. El nombre debe coincidir (Apps Script agrega el `.gs` solo):

| Archivo | Pega el contenido de |
|---|---|
| `Configuracion` | [Configuracion.gs](Configuracion.gs) |
| `Hojas` | [Hojas.gs](Hojas.gs) |
| `Api` | [Api.gs](Api.gs) |
| `Recordatorios` | [Recordatorios.gs](Recordatorios.gs) |
| `Pruebas` | [Pruebas.gs](Pruebas.gs) |

Borra el `Codigo.gs` que venía por defecto.

### Configura dos cosas

En **`Configuracion.gs`**, pega el ID del Sheet:

```javascript
const SHEET_ID = '1A2B3C...XyZ';
```

En **`Pruebas.gs`**, pon tu correo admin:

```javascript
const EMAIL_PRUEBA = 'tu-correo@gmail.com';
```

### ⚠️ La zona horaria

Es el error más común y el más molesto de diagnosticar.

*Configuración del proyecto* (el engrane de la izquierda) → **Zona horaria** →
`(GMT-05:00) Hora de Bogotá, Lima, Quito`.

Si queda en UTC, los recordatorios se dispararán con horas de diferencia y todo
parecerá roto sin motivo aparente.

---

## Paso 3 · Ejecutar las pruebas (15 min)

En el selector de función de la barra superior elige cada prueba y pulsa
**Ejecutar**. La primera vez Google te pedirá autorizar permisos: acepta.

> Verás una pantalla de *"Google no ha verificado esta aplicación"*. Es normal —
> la aplicación eres tú. Entra en *Configuración avanzada → Ir a (nombre del
> proyecto)*.

Ejecuta **en orden** y revisa el registro de ejecución:

| Función | Qué valida |
|---|---|
| `prueba1_conexion` | El SHEET_ID es correcto y no falta ninguna columna |
| `prueba2_usuario` | Tu usuario existe, está activo y es admin |
| `prueba3_crearMedicamento` | Se puede dar de alta un medicamento |
| `prueba4_generarDosis` | Las dosis se generan y **no se duplican** al repetir |
| `prueba5_motor` | Los 10 casos de la regla "cada 5 min hasta marcar" |
| `prueba6_email` | Llega el correo de recordatorio |
| `prueba7_cicloCompleto` | Un ciclo real del trigger |
| `prueba8_apiCompleta` | La API responde como la verá el frontend |

Si una falla, **no sigas**: el mensaje de error dice qué corregir.

En `prueba1` revisa que la zona horaria impresa sea la tuya.

Cuando todas pasen, ejecuta **`prueba9_limpiar`** para borrar los datos de prueba.

---

## Paso 4 · Instalar los activadores (2 min)

Ejecuta **una sola vez** la función `instalarTriggers`.

Crea los dos activadores y borra los previos, así que puedes re-ejecutarla sin
que se acumulen:

| Activador | Frecuencia | Qué hace |
|---|---|---|
| `generarDosisDelDia` | diario, 00:15 | Crea las tomas del día |
| `revisarRecordatorios` | **cada 5 minutos** | Avisa e insiste |

Verifícalo en *Activadores* (el reloj de la izquierda): deben aparecer los dos.

---

## Paso 5 · Publicar la API (5 min)

*Implementar → Nueva implementación → ⚙️ → Aplicación web*

| Campo | Valor |
|---|---|
| Descripción | `PillTime API v1` |
| Ejecutar como | **Yo** |
| Quién tiene acceso | **Solo yo** ← por ahora |

Copia la **URL del Web App** que te da al final. La necesito para conectar el frontend.

### Por qué "Solo yo" por ahora

`MODO_DESARROLLO = true` hace que la API acepte un correo directo, sin validar
token de Google. Es cómodo para probar, pero significa que cualquiera que
descubra la URL podría entrar.

Con acceso **"Solo yo"** eso es imposible: nadie más alcanza la URL. Cuando
montemos Sign in with Google (fase 2), pondré `MODO_DESARROLLO = false`, llenaremos
`CLIENT_ID`, y **entonces** cambiamos a "Cualquier usuario" para que entren tu papá
y tu hermana.

Comprobación rápida: abre la URL en el navegador. Deberías ver algo así:

```json
{"ok":true,"servicio":"PillTime API","zonaHoraria":"America/Bogota",
 "hoy":"2026-09-25","hora":"11:20","modoDesarrollo":true}
```

Verifica que `zonaHoraria` y `hora` sean correctas.

---

## Cuando termines

Mándame:

1. La **URL del Web App**.
2. Si alguna prueba falló, el mensaje del registro.

Con eso conecto el frontend al backend y pasamos a Sign in with Google.

---

## Problemas frecuentes

| Síntoma | Causa |
|---|---|
| `No existe la pestaña "Usuarios"` | El nombre no coincide exactamente, o quedó un espacio al final |
| `El correo X no está autorizado` | El correo del Sheet no es idéntico al de `EMAIL_PRUEBA` |
| Las horas salen corridas | Zona horaria del proyecto sin configurar |
| Sale `Sat Dec 30 1899` en vez de la hora | Google Sheets convirtió el texto en valor de hora. Pasa con medicamentos de **una sola toma**, porque la celda dice `16:03` y Sheets lo reconoce como hora. Ejecuta **`repararHorarios`** una vez: rescata las horas y marca las columnas como texto para que no se repita |
| Se duplican las dosis | Se instaló `generarDosisDelDia` dos veces. Ejecuta `instalarTriggers` otra vez |
| `Se superó la cuota máxima` | Límite de 100 emails al día en cuenta gratuita |

---

## Nota sobre la nueva URL al reimplementar

Cada *Nueva implementación* genera una URL distinta. Para conservar la misma al
actualizar el código usa:

*Implementar → Administrar implementaciones → ✏️ editar → Versión: Nueva*

Si generas una URL nueva, hay que cambiarla también en el frontend.
