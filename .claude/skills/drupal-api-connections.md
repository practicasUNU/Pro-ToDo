# Habilidad: Conexiones e Integración con Drupal JSON:API (Madrid+D)

## 1. Propósito y Contexto
Esta guía operativa documenta los contratos de red, bundles, rutas de API y estrategias de mutación DOM requeridas por `DrupalHttpStrategy` (nodo `DESTINO_DRUPAL`) para interactuar con el CMS Drupal 9 de Madrid+D mediante el estándar JSON:API.

---

## 2. Autenticación y Credenciales Perimetrales
- **Tipo de Autenticación Oficial:** `BEARER` (validado y aprobado con HTTP 200).
- **Cabeceras Obligatorias:**
  - `Authorization: Bearer ${DRUPAL_API_TOKEN}`
  - `Accept: application/vnd.api+json`
  - `Content-Type: application/vnd.api+json`
- **Base URL:** `https://www.madrimasd.org/jsonapi`
- **Aislamiento:** Las credenciales operan exclusivamente en `backend/.env` vía `ConfigService`. Prohibido exponer tokens en frontend o en `pipeline_schema`.

---

## 3. Catálogo de Bundles Confirmados en Producción
A través de la inspección directa del índice JSON:API, los bundles activos para el proyecto son:

| Canal / Módulo | Bundle Drupal | Endpoint Base | Modelo de Publicación |
|---|---|---|---|
| **Licitaciones** | `node--page` | `/jsonapi/node/page` | Agregador HTML (Mutación `PATCH` con Cheerio) |
| **Notiweb** | `node--noticias` / `node--article` | `/jsonapi/node/noticias` | Creación de entidad independiente (`POST`) |
| **Paneles / Títulos** | `node--acreditacion_evaluacion_panel` | `/jsonapi/node/acreditacion_evaluacion_panel` | Procesamiento matricial desde `.xlsx` |

---

## 4. Resolución de NIDs y UUIDs (Sin Decoupled Router)
El endpoint `/router/translate-path` responde `404 Not Found` (módulo no instalado). La resolución de páginas estáticas se realiza directamente contra la colección `node--page`.

### Comando de Descubrimiento de NIDs y UUIDs
Para extraer los identificadores de `/prueba-licitaciones` y `/prueba-verificador-titulos`:
```bash
curl -s -H "Authorization: Bearer $DRUPAL_API_TOKEN" \
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
  - Operación: Procesamiento matricial de `.xlsx`

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

* **Flujo Operativo:**
1. `GET` a la página de abiertas (`uuid_abiertas`).
2. Cheerio: Aislar el bloque correspondiente mediante el selector de expediente (ej. `[data-expediente="S_2026_015"]` o búsqueda por texto), guardar su HTML y removerlo (`$(selector).remove()`).
3. `PATCH` a la página de abiertas con el HTML resultante.
4. `GET` a la página de cerradas (`uuid_cerradas`).
5. Cheerio: Prepend del bloque extraído en la página de cerradas.
6. `PATCH` a la página de cerradas con el HTML actualizado.

### Modo D: `UPLOAD_ATTACHMENT` (Archivos Binarios PDF/PPT)

Los adjuntos son activos descargables, no fuentes de extracción de texto.

* **Verbo:** `POST /jsonapi/node/page/{uuid}/field_adjuntos` (o endpoint REST de archivos)
* **Headers:**
* `Content-Type: application/octet-stream`
* `Content-Disposition: file; filename="expediente.pdf"`


* **Resultado:** Extraer la URL pública generada (`https://www.madrimasd.org/sites/default/files/...`) e inyectarla en el `<a href="...">` del bloque de licitación.

---

## 6. Manejo de Errores y Resiliencia en FSM

* **Timeouts:** 15.000 ms (`DRUPAL_TIMEOUT_MS`).
* **Nivel de Severidad:** Todo fallo HTTP (`4xx`, `5xx`) debe capturarse en la estrategia y reportarse como error `GRAVE` (`ERR_DRUPAL_HTTP_FAILURE`), congelando la FSM en `PAUSADO` para inspección forense en `contexto_acumulado` sin abortar el contenedor Docker.