# Habilidad: Conexiones e Integración con Drupal JSON:API (Madrid+D)

## 1. Propósito y Contexto
Esta guía operativa documenta los contratos de red, bundles, rutas de API y estrategias de mutación DOM requeridas por `DrupalHttpStrategy` (nodo `DESTINO_DRUPAL`) para interactuar con el CMS Drupal 9 de Madrid+D mediante el estándar JSON:API.

---

## 2. Autenticación y Credenciales Perimetrales

- **Tipo de autenticación oficial:** `BASIC`. Esta instalación monta el módulo **`basic_auth`** del núcleo de Drupal, **no `simple_oauth`**.

> ⚠️ **El `Bearer` no da 401: da 200 y no escribe.** Una petición con `Authorization: Bearer …` contra este Drupal no se rechaza — se evalúa como **anónima**. Los `GET` de contenido público siguen respondiendo `200 OK`, de modo que toda comprobación de lectura parece confirmar que la credencial es buena, y solo revienta el `PATCH`. Si una escritura falla con 401 mientras las lecturas van finas, el sospechoso es el **esquema**, no el token.

- **Cabeceras obligatorias:**
  - `Authorization: Basic <base64(DRUPAL_API_USER:DRUPAL_API_TOKEN)>`
  - `Accept: application/vnd.api+json`
  - `Content-Type: application/vnd.api+json`

  La compone **un solo sitio**, el getter `DrupalApiConfig.authHeader`; `DrupalHttpStrategy.buildJsonApiHeaders()` la consume ya armada. Ni la estrategia ni el script E2E construyen la cabecera por su cuenta, para que un modo nuevo no pueda olvidarse del esquema.

- **Variables de entorno oficiales** (todas en `backend/.env`, leídas vía `ConfigService`; plantilla en `backend/.env.example`):

  | Variable | Valor de referencia | Notas |
  |---|---|---|
  | `DRUPAL_API_BASE_URL` | `https://www.madrimasd.org/jsonapi` | Incluye el sufijo `/jsonapi` a propósito: es la raíz sobre la que la estrategia concatena `/node/page/{uuid}`. |
  | `DRUPAL_AUTH_TYPE` | `BASIC` | `BASIC` o `BEARER`. Cualquier otro valor cae a `BASIC`; la comparación ignora mayúsculas. |
  | `DRUPAL_API_USER` | `editor_api` | Cuenta de servicio con permiso de edición. **Obligatoria bajo `BASIC`**; ignorada bajo `BEARER`. |
  | `DRUPAL_API_TOKEN` | *(contraseña de la cuenta)* | Bajo `BASIC` es la **contraseña** de `DRUPAL_API_USER`, no un token emitido. El nombre se conserva por compatibilidad con los `.env` ya desplegados. |
  | `DRUPAL_API_TIMEOUT_MS` | `15000` | Timeout por petición HTTP. |

- **Guarda previa (`DrupalApiConfig.isUsable`):** bajo `BASIC` exige usuario **y** contraseña. Con el usuario vacío la cabecera saldría como el Base64 de `:contraseña`, que Drupal procesa como anónima; detenerse antes con `ERR_DRUPAL_CONFIG` apunta al `.env`, mientras que dejar salir la petición devolvería `ERR_DRUPAL_AUTH`, que apunta al servidor y manda a buscar donde no es.

- **Aislamiento:** Las credenciales operan exclusivamente en `backend/.env` vía `ConfigService`. Prohibido exponer tokens en frontend o en `pipeline_schema`.

---

## 3. Catálogo de Bundles Confirmados en Producción
A través de la inspección directa del índice JSON:API, los bundles activos para el proyecto son:

| Canal / Módulo | Bundle Drupal | Endpoint Base | Modelo de Publicación |
|---|---|---|---|
| **Licitaciones** | `node--page` | `/jsonapi/node/page` | Agregador HTML (Mutación `PATCH` con Cheerio) |
| **Notiweb** | `node--noticias` / `node--article` | `/jsonapi/node/noticias` | Creación de entidad independiente (`POST`) |
| **Paneles / Títulos** | `node--acreditacion_evaluacion_panel` | `/jsonapi/node/acreditacion_evaluacion_panel` | Creación de entidad por panel (`CREATE_NODE`). El origen matricial `.xlsx` es el canal de entrada, no el modo de publicación. |

---

## 4. Resolución de NIDs y UUIDs (Sin Decoupled Router)
El endpoint `/router/translate-path` responde `404 Not Found` (módulo no instalado). La resolución de páginas estáticas se realiza directamente contra la colección `node--page`.

### Comando de Descubrimiento de NIDs y UUIDs
Para extraer los identificadores de `/prueba-licitaciones` y `/prueba-verificador-titulos`:
```bash
curl -s -u "$DRUPAL_API_USER:$DRUPAL_API_TOKEN" \
  -H "Accept: application/vnd.api+json" \
  "[https://www.madrimasd.org/jsonapi/node/page?fields](https://www.madrimasd.org/jsonapi/node/page?fields)[node--page]=title,path,drupal_internal__nid" \
  | jq '.data[] | {nid: .attributes.drupal_internal__nid, title: .attributes.title, path: .attributes.path.alias, id: .id}'

```

### Nodos de Sandbox Confirmados en Producción:
- **Prueba de Licitaciones:**
  - NID: `55937`
  - UUID: `7f1700bf-b54b-4c12-b71a-8a71f1f0ee38`
  - Bundle: `node--page`
  - Operación: `APPEND_HTML_BLOCK` (Cheerio + PATCH)
- **Prueba Verificador de Títulos:**
  - NID: `55938`
  - UUID: `b17d69d8-6998-4883-b8dc-153b55dbd9c5`
  - Bundle: `node--acreditacion_evaluacion_panel`
  - Operación: `CREATE_NODE` (una entidad por panel evaluado)

---

## 4.bis Matriz de casos de uso: de la intención al destino

Las tres combinaciones operativas confirmadas. Cada fila se corresponde con un botón de preset en el configurador del nodo `DESTINO_DRUPAL` (`DRUPAL_SANDBOX_PRESETS`, `frontend/src/types/nodes/drupal-http.types.ts`) y, cuando aplica, con una fila sembrada en `plantillas_html` por `db/migrations/028`.

| Intención del correo | Plantilla (`plantillas_html.nombre`) | Preset | NID / UUID | Modo | Selector |
|---|---|---|---|---|---|
| **Abrir licitación** | `Licitaciones · Convocatoria abierta (Madrid+D)` | `ABRIR_LICITACION` | 55937 / `7f1700bf…` | `APPEND_HTML_BLOCK`, `PREPEND` | — |
| **Cerrar licitación** | — (mueve marcado ya publicado) | `CERRAR_LICITACION` | origen 55937 / `7f1700bf…` · **destino por determinar** | `TRANSFER_HTML_BLOCK`, `APPEND` | `itemSelector: .licitacion-entry`, afinable a `div.licitacion-entry[data-expediente="…"]` |
| **Verificación de títulos** | `Verificación de Títulos · Panel de evaluación` | `VERIFICACION_TITULOS` | 55938 / `b17d69d8…` | `CREATE_NODE` | — |

### Las plantillas NO llevan marcadores, y es deliberado

Las dos filas sembradas son **esqueletos con ranuras vacías nombradas por clase**, no plantillas con `{{namespace.campo}}`. El `MAPEADOR_PLANTILLA` dejó de interpolar: entrega el marcado saneado para que lo rellene un `PROCESADOR_IA` posterior, y rechaza con `ERR_TEMPLATE_PENDING_VARS` cualquier plantilla cuya columna `variables_esperadas` no venga vacía. Añadir un marcador a una de estas plantillas deja el flujo `PAUSADO` en la primera ejecución.

Consecuencia práctica para quien redacte el prompt del `PROCESADOR_IA`: **la IA es quien escribe el `data-expediente`**, y de ese atributo depende que el cierre encuentre después el bloque que tiene que mover.

### ⚠️ El destino del cierre está sin determinar

`CERRAR_LICITACION` deja `destinationNodeUuid` en `null` a propósito: no hay UUID conocido para la página de licitaciones **cerradas**. Apuntarlo a la de abiertas «para poder probar» es destructivo — `runTransferHtmlBlock` lee origen y destino por separado y el segundo `PATCH` pisa al primero con un DOM ya obsoleto, de modo que el bloque se borra sin dejar copia **y el nodo devuelve éxito**. El paso queda inválido hasta que alguien escriba el destino real, que es el comportamiento buscado.

---

## 4.ter Directiva de escalamiento operativo

Ante un correo o requerimiento que **no case claramente** con una fila de la matriz anterior, no se improvisa destino ni marcado: un UUID inventado falla en ejecución con un 404 y el flujo ya `PAUSADO`, y un bloque con una estructura distinta de la esperada rompe el `itemSelector` de todos los cierres posteriores.

El procedimiento es detenerse y formular la consulta técnica a la tutora empresarial, pidiendo **las tres cosas a la vez** —por separado no bastan para configurar el nodo—:

1. **URL o NID de destino** en Madrid+D, del que se deriva el UUID por `/jsonapi/node/page?filter[drupal_internal__nid]=…`.
2. **Estructura HTML exacta** del bloque deseado, o la plantilla `.html` de referencia. Hace falta el marcado literal, no una descripción: de él salen las clases de las ranuras y los `requiredSelectors` que audita el `ESCUDO_POST_IA`.
3. **Criterio de colocación**: `PREPEND` (lo último publicado se lee arriba) o `APPEND` (orden cronológico), y si el bloque sustituye a uno existente o se acumula.

Mientras falte cualquiera de los tres, el nodo se deja sin configurar en vez de rellenarlo con un valor plausible: un paso inválido es visible en el asistente, y un UUID equivocado no lo es hasta que se ejecuta.

---

## 5. Modos de Operación (`DrupalOperationMode`)

### Modo A: `CREATE_NODE` (Notiweb)

Crea una entidad independiente por cada noticia procesada.

* **Verbo:** `POST /jsonapi/node/noticias`
* **Payload:**

```json
{
  "data": {
    "type": "node--noticias",
    "attributes": {
      "title": "{{validated_drupal_json.headline}}",
      "field_resumen": "{{validated_drupal_json.summary}}",
      "body": {
        "value": "{{validated_drupal_json.compiled_markup}}",
        "format": "full_html"
      },
      "status": true
    }
  }
}

```

### Modo B: `APPEND_HTML_BLOCK` (Abrir Licitación)

Las licitaciones residen acumuladas en el campo `body.value` de una página agregadora (`node--page`). No son nodos individuales.

* **Flujo Operativo:**
1. `GET /jsonapi/node/page/{uuid_abiertas}` para obtener el HTML actual en `body.value`.
2. Parseo DOM en memoria: `const $ = cheerio.load(currentHtml, { xml: { xmlMode: false } }, false)`.
3. Prepend del bloque HTML generado por el pipeline (con el link al adjunto subido).
4. `PATCH /jsonapi/node/page/{uuid_abiertas}` enviando el HTML actualizado en `data.attributes.body.value`.

### Modo C: `TRANSFER_HTML_BLOCK` (Cerrar Licitación)

Mueve una licitación activa a la página de cerradas. No requiere inferencia de IA.

* **Parámetros obligatorios:** `targetNodeUuid` (abiertas, origen), `destinationNodeUuid` (cerradas, destino) e `itemSelector`. La ausencia de cualquiera corta la ejecución con `ERR_DRUPAL_MISSING_PAYLOAD`.

* **Flujo Operativo (orden invertido: se escribe PRIMERO en cerradas):**
1. `GET` a la página de **abiertas** (`targetNodeUuid`) y aislamiento del bloque con `itemSelector` (ej. `[data-expediente="S_2026_015"]`), guardando su HTML.
2. `GET` a la página de **cerradas** (`destinationNodeUuid`) con **guarda de idempotencia**: si el selector ya encuentra el bloque en destino, se salta por completo la escritura en cerradas. Si además el bloque ya no está en origen, el traslado se da por completado y se devuelve `success: true` sin emitir ningún `PATCH`. Si no aparece en ninguna de las dos páginas, se falla con `ERR_DRUPAL_DOM_TARGET` sin modificar nada.
3. `PATCH` a **cerradas** con el bloque inyectado (prepend sobre el `body.value` existente).
4. `PATCH` a **abiertas** con el bloque ya removido del DOM.

* **Por qué el orden invertido (garantía At-Least-Once + idempotencia):**
  JSON:API no ofrece transacción multi-entidad, así que la ventana de fallo entre las dos escrituras no se puede eliminar: solo se puede elegir de qué lado cae.
  - Orden «natural» (retirar de origen → escribir en destino): un fallo de red en la segunda escritura **pierde** el bloque. Como solo existía dentro del `body.value` de la agregadora —no es una entidad con revisiones—, la pérdida es silenciosa e irreversible.
  - Orden invertido (destino → origen): el único fallo posible deja el bloque **duplicado**, visible en ambas páginas. Es detectable, reparable a mano y, sobre todo, **autoconvergente**: el reintento ejecuta la guarda del paso 2, detecta que cerradas ya lo tiene, se salta esa escritura y solo retira de abiertas.
  - Ese fallo parcial no se oculta: la estrategia devuelve `success: false` **con `data`**, marcando `operationApplied: "TRANSFER_HTML_BLOCK_PARTIAL"`, de modo que el motor publique el namespace y copie los UUID en `error_context.partial_data` para que la alerta indique exactamente qué página hay que limpiar.

### Modo D: `UPLOAD_ATTACHMENT` (Archivos Binarios PDF/PPT)

Los adjuntos son activos descargables, no fuentes de extracción de texto.

* **Verbo:** `POST /jsonapi/node/page/{uuid}/field_adjuntos` (o endpoint REST de archivos)
* **Headers:**
* `Content-Type: application/octet-stream`
* `Content-Disposition: file; filename="expediente.pdf"`


* **Resultado:** Extraer la URL pública generada (`https://www.madrimasd.org/sites/default/files/...`) e inyectarla en el `<a href="...">` del bloque de licitación.

---

## 6. Manejo de Errores y Resiliencia en FSM

* **Timeouts:** 15.000 ms (`DRUPAL_API_TIMEOUT_MS`).
* **Nivel de Severidad:** Todo fallo HTTP (`4xx`, `5xx`) debe capturarse en la estrategia y reportarse como error `GRAVE` (`ERR_DRUPAL_HTTP_FAILURE`), congelando la FSM en `PAUSADO` para inspección forense en `contexto_acumulado` sin abortar el contenedor Docker.