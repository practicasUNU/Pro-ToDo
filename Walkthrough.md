# Walkthrough · Bitácora de Desarrollo Proto-Do

Registro técnico del "por qué" de cada decisión de implementación. Los estados de la FSM se documentan aquí a medida que se implementan.

---

## 2026-09-26 · Nodo `PROCESADOR_IA`, cliente HTTP base y retirada de `ui_schema` — rama `feat/llm-extractor-node`

### El eslabón que faltaba, y por qué no se podía añadir sin frenos

`PROCESADOR_IA` llevaba declarado en el enum `NodeType` desde la migración 011 sin ninguna
`INodeStrategy` registrada: un `pipeline_schema` que lo incluyera se guardaba sin protestar y
reventaba en la primera ejecución con `StrategyNotFoundException`. Entre `EXTRACTOR_WEB` /
`PARSER_PRE_IA`, que ya publican texto limpio, y `MAPEADOR_PLANTILLA`, que ya interpola variables,
no había nada.

Lo que hacía el hueco incómodo de rellenar no era la inferencia, sino el dinero. El motor reintenta
los fallos `GRAVE` con backoff y checkpoint, y un cliente HTTP razonable reintenta también la
petición. Las dos capas se **multiplican**, y en este nodo cada vuelta se factura. Un proveedor
intermitente podía convertir una sola ejecución de un flujo en decenas de inferencias que nadie
autorizó. De ahí que el nodo llegue con tres piezas que no son accesorias:

- **`HttpClientService` (`@core/http/`)**, primer consumidor de `@nestjs/axios` en el proyecto.
  Centraliza timeout (15 s por defecto), backoff exponencial y la traducción del error de Axios a
  `NodeErrorDetail`. Reintenta timeouts, errores de red, `429` y `5xx`; **nunca** un `4xx` de
  cliente, que es determinista y solo gastaría tiempo. Devuelve una unión discriminada en lugar de
  lanzar: una excepción la clasificaría `toDomainFailure` como catastrófica y marcaría la ejecución
  `FALLIDO`, cuando un portal caído es exactamente lo que el operador reintenta con el flujo
  `PAUSADO` (CU-09).
- **Freno de emergencia**, indexado por `${executionId}:${cursor}` en un `Map`. **No** es un contador
  de instancia, y ese detalle es el que importa: la estrategia es un singleton de Nest compartido por
  todas las ejecuciones concurrentes, así que un único número habría hecho que un flujo agotara el
  umbral y pausara el nodo de IA de otro flujo sano que entrara después. El operador vería una
  ejecución pausada sin un solo fallo propio que lo explique (`testing-standards.md` §4).
  Al alcanzar el umbral devuelve `URGENTE` —que `canRetry` rechaza— **devolviéndolo, no lanzándolo**:
  lanzar daría `FALLIDO` terminal y obligaría a relanzar el flujo desde cero, tirando el trabajo
  válido de los nodos anteriores.
- **Simulación de coste cero** (`MockLlmProvider`), determinista. Se activa con `dryRun: true`, con
  `provider: MOCK` —que es el **defecto**, para que un nodo recién creado no pueda gastar por
  omisión— y cuando `GEMINI_API_KEY` falta en el entorno. En ese último caso `GeminiLlmProvider`
  degrada con un aviso en el log en vez de fallar: la ausencia de la clave es un estado normal en
  desarrollo, y lo contrario obligaría a repartir credenciales de pago para probar una topología.

### Lo que NO se hizo: caer al simulador cuando el proveedor no existe

`ANTHROPIC` y `OPENAI` están en el enum pero no tienen cliente. La tentación era delegar en el mock
—«al menos el flujo termina»— y es justo lo que no puede pasar: esa salida simulada seguiría hasta
el `MAPEADOR_PLANTILLA`, que la publicaría en Drupal como si fuera una redacción real. Devuelven
`ERR_LLM_PROVIDER_UNSUPPORTED` en `GRAVE`. Un fallo ruidoso es preferible a una noticia inventada en
producción.

Tampoco se construyó un rescatador de JSON a base de expresiones regulares sobre texto libre: se le
pide el JSON al propio modelo con `responseMimeType: 'application/json'`. Lo otro es un parser de
formato ad hoc, que `security-and-scope.md` §3 prohíbe.

### El nodo no escribe en el contexto, y el `outputNamespace` no es suyo

`outputNamespace` ya es campo de `PipelineNodeConfigDto`, validado contra `NODE_OUTPUT_NAMESPACES`
—que incluye `llm_response`— y único por flujo, y `FsmEngineService` ya hace
`context.setNamespace(node.outputNamespace, result.data)`. Declararlo también en el DTO del nodo
habría creado una segunda fuente de verdad invisible para el validador de topología, y dos
escrituras que divergen en cuanto los dos valores no coinciden. La estrategia devuelve `data` y
punto, como las otras cinco.

Detalle del reparto de los dos textos: el **contenido** viaja como `prompt` y la **instrucción** como
`systemPrompt`, no al revés. Así el texto llega al modelo aunque la instrucción del operador no
interpole ningún marcador —«resume esto en tres párrafos» es un prompt perfectamente válido y no
menciona ningún namespace—. Con el reparto contrario, ese prompt facturaría una inferencia sobre
ningún contenido.

### `ui_schema`: retirada completa, no columna vacía

La columna nació en la 011 prometiendo ser el contrato declarativo del formulario del frontend. Las
nueve filas siguen con `'{}'` y el formulario lo resuelve `node-config-registry.ts` con componentes
tipados. Quedaba como deuda registrada en la entrada del 2026-09-08 de esta bitácora.

Se borra en lugar de dejarla vacía porque una columna que dice ser la fuente de verdad de la UI y no
lo es acaba siendo usada por alguien, y desde ahí el formulario de un nodo queda definido en dos
sitios que se desincronizan en la primera modificación. El mismo argumento por el que los contratos
de **salida** viven en `outputFields` de la `INodeStrategy` y no en un jsonb.

La retirada es en cascada —migración 020, `init.sql` (incluido el `UPDATE` que la 013 sembró para
`TRIGGER_CRON`), entidad, `NodeCatalogResponseDto`, `NodeCatalogService`, el tipo del frontend y los
seis specs que lo construían— porque dejar el DTO prometiendo un campo que la entidad ya no tiene
devolvería `undefined` por `GET /api/nodos` con el tipo afirmando lo contrario.

### Estado de la verificación

- `npx tsc --noEmit`: 45 errores, los mismos 45 preexistentes de la rama base (todos en specs, fuera
  de `tsconfig.build.json`). Cero nuevos.
- Backend: 50 suites, 1172 pruebas en verde, incluidas las 24 nuevas de la estrategia y las 11 del
  cliente HTTP.
- Frontend: 23 archivos, 461 pruebas en verde; `vue-tsc --noEmit` limpio.
- **`npm run test:e2e` falla, y ya fallaba antes de esta rama**: las dos suites revientan al importar
  `sanitize-html` (problema de transformación ESM en `jest-e2e.json`). Verificado con `git stash`
  contra la rama base. Queda como deuda ajena a este trabajo.

### Pendiente

- Aplicar la migración 020 contra el contenedor (la ejecuta el usuario):
  ```bash
  sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
    < db/migrations/020-eliminar-ui-schema-nodos.sql
  ```
- Unificar el nombre de la credencial de Anthropic: el `.env` real declara `ANTHROPIC_API_KEY` y
  `.env.example` `CLAUDE_API_KEY`. Ninguno se lee todavía —no hay proveedor Anthropic—, así que se
  resuelve cuando se escriba.
- `ESCUDO_POST_IA` sigue sin estrategia. Es el validador natural de la salida de este nodo antes de
  que el mapeador la propague.

---

## 2026-09-19 · `extracted_urls` deja de salir vacío: enlaces para el pipeline Notiweb — rama `feat/enlaces-parser`

### Dos causas, y arreglar una sola no servía de nada

`EXTRACTOR_WEB` recibía `parsed_email.extracted_urls` vacío y no tenía nada que escrapear antes de
que la IA redactase. El diagnóstico de partida apuntaba al orden de recolección, y era cierto a
medias: había **dos** causas independientes y corregir solo una dejaba el arreglo igual de vacío.

**La primera, y la que de verdad mordía: la cascada del cuerpo.** Un correo de Gmail trae parte de
texto y parte HTML. `extractEmailBody` prefiere el texto plano —es más barato que montar el DOM— y
esa rama devolvía `urls: []` **sin llegar a abrir el marcado**. Mientras eso siguiera así, cambiar
cuándo se podan las firmas era irrelevante: nadie miraba el HTML. Ahora los enlaces se leen siempre
del marcado, gane quien gane el cuerpo, vía una `extractEmailUrls` nueva que se salta el aplanado a
texto porque aquí no hace falta.

Del texto plano se sigue sin rescatar nada, y esa parte de la decisión original se mantiene: ese
texto parte las URLs a 78 columnas (RFC 5322) y un `https?://\S+` produciría direcciones truncadas.
El marcado del mismo correo las declara enteras.

**La segunda: el momento de la recolección.** Se recogían después de retirar citas y firmas, para que
`clean_body` y `extracted_urls` describieran el mismo documento. Buena regla para un boletín y mala
para un recorte de prensa: en un correo **reenviado** el contenido entero —y con él las referencias
bibliográficas— vive dentro del `<blockquote>` que la poda elimina. Se perdían todas.

### Lo que se rompe a cambio, dicho sin adornos

Recoger antes de podar significa que un enlace de una firma entra en `extracted_urls` aunque su texto
ya no aparezca en el cuerpo. **Los enlaces dejan de describir el mismo documento que `clean_body`.**
Es una pérdida real de una invariante que existía a propósito, y se acepta porque la alternativa
—perder las referencias de todo correo reenviado— es peor para lo que este pipeline hace.

Lo que acota el ruido es que **los diez filtros de `collectUrls` no se tocaron**. La especificación
recibida pedía filtrar solo vacías, `mailto:` y `tel:`; leída al pie de la letra habría dejado pasar
desuscripciones, redes sociales, redirectores de campaña y duplicados, sin tope. `EXTRACTOR_WEB`
descarga cada URL con Playwright: mandarle la baja del boletín o el LinkedIn del remitente es gasto
puro y ruido en la redacción.

Tres pruebas afirmaban el comportamiento anterior y se **invirtieron**, no se borraron: 7.1 y 7.6 de
la estrategia y 5.12 del saneador. Cada una lleva escrito en su `Arrange` por qué dice ahora lo
contrario.

### El aviso que faltaba

Un `extracted_urls: []` era mudo: no distinguía «este correo no traía enlaces» de «algo va mal». Se
añade `onNoUrlsFound`, cuarto hook de la serie, que emite un LEVE no bloqueante cuando **había
marcado** y aun así no salió ni un enlace. La condición importa: en un correo `text/plain` puro no
hay ningún `<a>` que recoger, y avisar ahí convertiría la señal en ruido constante. La estrategia lo
manda a `logger.warn('LEVE | …')` y el asistente a `warnings[]`, que es lo que lo hace visible en el
banco de pruebas.

### Lo que este cambio NO arregla

El correo que originó el encargo guarda en `raw_email.html` literalmente
`href="[https://www.youtube.com/](https://www.youtube.com/)"`, con sintaxis Markdown dentro del
atributo. Ese valor muere en `parseAbsoluteUrl` porque `new URL()` lanza —un esquema URI debe empezar
por letra ASCII— y **el descarte es correcto**: `[https://…` no es navegable y el extractor fallaría
al intentar descargarlo. Ese correo seguirá dando `[]`.

Queda **pendiente, fuera de este cambio**: averiguar qué escribe esos `href`. `ImapTriggerStrategy`
usa `simpleParser` de `mailparser`, que no markdowniza nada. Se dejó constancia del descarte en dos
pruebas (7.10 y 5.15) para que la próxima persona que lo vea no lo confunda con un fallo del parser.

### Normalización del texto documental (RNF-01)

Arrastrado del mismo encargo: el texto que se saca de los adjuntos se normaliza antes de recortarlo.
El orden no es indiferente —recortar primero gastaría parte del presupuesto de 100 000 caracteres en
saltos de línea que iban a colapsarse igualmente— y se reutiliza `normalizeWhitespace`, ya exportada
y probada, en vez de escribir un `\n{3,}` nuevo: hace un superconjunto de lo pedido (CRLF, espacios
duros, rachas de espacio horizontal) y todo ello es exactamente economía de tokens. Cada lector pasa
a devolver texto crudo y la normalización vive en un único sitio, para que un lector futuro no pueda
olvidarse de aplicarla.

### Lo que NO se implementó de la especificación

- **`context.setNamespace('parsed_email', …)` desde la estrategia.** El contrato lo prohíbe, y no
  habría fallado de forma ruidosa: `setNamespace` *fusiona*, así que habría dejado un `parsed_email`
  de dos claves en lugar de trece, en silencio, perdiendo `clean_body` y
  `requires_multimodal_fallback` —las dos que el motor lee para decidir la purga del base64—. La
  inmutabilidad ya estaba garantizada: la estrategia devuelve `data` y el motor la deposita.
- **`validator.normalizeEmail` sobre las URLs.** Normaliza direcciones de correo, no URLs. La
  normalización real ya la hacían `parseAbsoluteUrl` y `withoutTrackingParams`.
- **`extracted_urls` como propiedad nueva.** Ya existía: es la clave 8 de las 13.

### Verificación

**41 suites / 950 pruebas** (antes 936), `tsc --noEmit` limpio. Frontend **15 ficheros / 321
pruebas**.

Lo que **no** está cubierto: ninguna prueba ejecuta la cadena completa
`TRIGGER_IMAP → PARSER_PRE_IA → EXTRACTOR_WEB`. Que el extractor reciba de verdad la lista solo se ha
verificado por partes.

---

## 2026-09-19 · `npm audit` a cero sin tocar el major de NestJS — rama `feat/auditoria-dependencias`

### Diecisiete avisos, cuatro causas

El informe daba 17 vulnerabilidades y a primera vista parecía que el monolito entero estaba podrido:
once de las entradas eran paquetes `@nestjs/*`. No lo estaban. Al leer el campo `via` de cada aviso,
las once colgaban de una sola raíz — `@nestjs/platform-express` depende de `multer`, y `multer`
arrastraba cuatro CVE de denegación de servicio— y el resto se agrupaba en tres más: `fast-uri`,
`js-yaml`/`qs` y `nodemailer` (que a su vez marcaba `mailparser`).

Cuatro arreglos, no diecisiete. Y ninguno exigía subir de major.

### Por qué `--force` habría sido un desastre

`npm audit fix --force` proponía `@nestjs/core@12.0.3`, `@nestjs/platform-express@12.0.3`,
`@nestjs/swagger@12.0.1`, `@nestjs/typeorm@12.0.1` y cinco más: el salto de la 11 a la 12 en todo el
monolito, y todo ello **para arreglar `multer`**, que este proyecto ni siquiera importa
(`grep FileInterceptor` no da un solo resultado). Habría sido cambiar diecisiete avisos por una
migración de framework no pedida.

### El reparto: `audit fix` primero, override solo donde hacía falta

`npm audit fix` sin `--force` resolvió por sí solo `fast-uri` (3.1.5 → 3.1.8), `js-yaml` (4.3.1 →
4.3.2, y la copia 3.15.1 del árbol de cobertura a 3.15.2) y `qs` (6.15.3 → 6.16.0). De 17 a 13.

Las dos que quedaban se trataron de forma distinta **a propósito**:

- **`nodemailer` es dependencia DIRECTA.** Lo correcto ahí es corregir el rango declarado en
  `dependencies` (`^9.0.5` → `^9.1.1`), no añadir un override. Un override sobre una dependencia
  propia esconde el rango real: el `package.json` seguiría anunciando que acepta una versión
  vulnerable y el arreglo viviría en otro sitio. Esto además cerró `mailparser`, que solo estaba
  marcada por arrastrarla.
- **`multer` sí necesitaba un override**, y es el único caso legítimo: `@nestjs/platform-express`
  la fija en `"multer": "2.2.0"` **exacto**, sin caret, de modo que `audit fix` no tiene margen
  para moverla por mucho que exista la 2.4.0. El override es la única vía, y es un salto *menor*
  dentro de la 2.x.

Todos los parches existían **dentro del major vigente**. Eso se comprobó versión a versión antes de
escribir nada, precisamente para no acabar justificando un major a posteriori.

### Verificación de que el override de `multer` no rompe nada

Que la suite pase no demuestra que `platform-express` siga hablándose con un `multer` que no es el
que declaró. El punto de contacto real es `FileInterceptor`, así que se comprobó directamente: se
carga, se instancia y el `multer` efectivo es el 2.4.0. `nest build` compila y `@nestjs/*` se queda
íntegro en 11.x, sin un solo major movido.

### Un efecto lateral que resultó ser una mejora

`npm audit fix` también movió `pdf-parse` de 1.1.1 a **1.1.4**, y conviene decir que fue a mejor:
pierde la dependencia `debug` y elimina el bloque `isDebugMode = !module.parent` de su `index.js`
—el cebo que obligó a montar una prueba de humo al introducir la librería el día anterior—. La
entrada del 2026-09-18 afirmaba que la línea 1.x estaba «sin mantenimiento desde 2019»; era cierto
al escribirla y ha dejado de serlo. Queda corregida allí con su fecha.

### Estado final

`npm audit` → **found 0 vulnerabilities**. `npx tsc --noEmit -p tsconfig.build.json` limpio,
`nest build` en verde, **41 suites / 936 pruebas**.

Lo que **no** se ha hecho: arrancar la aplicación contra la base de datos. La comprobación de
`multer` es de integración de módulos, no de una subida de fichero real — algo que hoy no existe en
el proyecto, pero que habría que ejercitar de verdad si algún día se añade un endpoint de carga.

---

## 2026-09-18 · Extracción nativa de texto de adjuntos en `PARSER_PRE_IA` — rama `feat/extractor-adjuntos`

### El problema: pagar visión por un PDF que ya traía su texto

El corpus del proyecto son notas de prensa institucionales, y su forma más habitual es un correo
con un `Ver adjunto.` por cuerpo y el comunicado entero dentro de un PDF. Hasta ahora el nodo solo
sabía leer el cuerpo del correo: `clean_body` salía con doce caracteres, `requires_multimodal_fallback`
se levantaba y el flujo acababa mandando el binario a un modelo con visión — la llamada más cara
del pipeline — para leer un documento cuyo texto estaba ahí, seleccionable, sin necesidad de mirarlo.

Ahora ese texto se extrae en local. La bandera multimodal deja de ser la primera respuesta y pasa a
ser la última: solo se levanta cuando de un adjunto de imagen o PDF no se sacó **ni un carácter**.

### Cero OCR, y no por falta de ganas

La extracción es estrictamente nativa. Una imagen devuelve cadena vacía sin que nadie toque el
búfer, y esa ausencia es *informativa*: es justo lo que convierte al adjunto en candidato a visión.
Meter un motor de OCR aquí habría hecho lo contrario de lo que el nodo persigue —gastar CPU para
adivinar un texto que luego habría que mandar igualmente a revisar— además de arrastrar
`tesseract.js`, que descarga ~10 MB de datos de idioma desde un CDN de terceros en la primera
ejecución.

### Tres decisiones de dependencia que no son de gusto

**`xlsx` se descartó por seguridad, no por preferencia.** Es la librería obvia para hojas de
cálculo, pero quedó congelada en npm en la 0.18.5 (2022) y `npm audit` la marca **high, sin parche
disponible**: prototype pollution (GHSA-4r6h-8v6p-xvw6) y ReDoS (GHSA-5pgg-2g8v-p4x9). SheetJS
publicó las correcciones solo en su CDN y nunca las devolvió a npm. Esta ruta analiza ficheros que
manda cualquiera que sepa la dirección del buzón; una vulnerabilidad permanente ahí no es una deuda,
es una puerta. Se usa `exceljs`, que trae un aviso **moderado** transitivo por `uuid@8` —no
alcanzable desde aquí, porque ExcelJS llama a `uuid.v4()` sin búfer y en la ruta de *escritura*—
cerrado de todos modos con un `overrides`. Los tres paquetes nuevos aportan **cero** avisos al
proyecto; los 17 que `npm audit` sigue reportando son los preexistentes de la cadena de NestJS.

**`pdf-parse` en la línea 1.x y no en la 2.x.** La 2.x arrastra `pdfjs-dist` y `@napi-rs/canvas`, un
módulo NAPI nativo que existe para rasterizar páginas. Sin OCR no hay nada que rasterizar. La 1.x
depende solo de `node-ensure`: JS puro. Queda anotado: si un PDF real rompe la 1.x, la salida es la
2.x con su API de clase, ya verificada bajo este `tsconfig`.

> **Corregido el 2026-09-19.** Esta entrada decía que la 1.x llevaba «sin mantenimiento desde 2019».
> Era cierto al escribirla y dejó de serlo: la línea revivió en octubre de 2025 y la instalada es la
> **1.1.4**, del mismo mantenedor y el mismo día que la 2.4.5. Mejora en lo que aquí importaba:
> pierde la dependencia `debug` y elimina el bloque `isDebugMode = !module.parent` de `index.js`
> —el cebo que motivó la prueba de humo del paso 0— que intentaba leer un PDF del propio paquete.

**Un CSV no pasa por el analizador de hojas de cálculo.** Ya es texto. Leerlo con `exceljs` para
volver a serializarlo como CSV es un viaje de ida y vuelta que solo puede perder información, y de
paso expone la ruta al analizador con el ReDoS conocido.

### La composición se volvió asíncrona, y eso se notó en cuatro sitios

`buildParsedEmail` era síncrona y pura. Leer un PDF no lo es. La onda llegó exactamente donde se
esperaba: la estrategia (ya `async`, solo añadió el `await`), el controlador del asistente, y
`WizardService.checkParser`, que era **el único método del servicio sin `async`** y cuyo TSDoc lo
justificaba explícitamente. Esa nota se reescribió: ahora sí hay algo que esperar.

`extractEmailBody` se quedó síncrona a propósito. No toca adjuntos, y volverla asíncrona por simetría
habría obligado a todo lector a buscar una espera que no existe.

### Lo que el banco de pruebas puede y no puede demostrar

`POST /wizard/check-parser` sigue **rechazando `contentBase64`**, con su tope de 50 kB. Una ruta del
asistente no debe tragarse megabytes, y ese límite está calibrado por debajo del defecto de 100 kB de
`express.json()` para que un cuerpo excesivo dé un 400 en castellano y no un 413 crudo de Express.

La consecuencia es que ahí la extracción documental **no puede ocurrir**. Se resolvió diciéndolo, no
disimulándolo: si la petición declara adjuntos, la respuesta trae un aviso explícito de que los
binarios no se simulan. Lo que **no** se hizo fue forzar `requires_multimodal_fallback` a `false`
desde el asistente. Una rama «estoy en el banco de pruebas» dentro de `buildParsedEmail` habría
destruido su única razón de ser —ser la misma implementación que corre en producción— y habría
metido en el núcleo un concepto que el núcleo no debe conocer. No hizo falta: sin `contentBase64` no
hay candidatos visuales, y la bandera sale `false` por construcción. El aviso dice la verdad y el
cálculo no miente.

### Un adjunto ya purgado no es un adjunto sin texto

La condición «trae `contentBase64` utilizable» de la regla multimodal parece defensiva y no lo es.
El motor pone `contentBase64: null` en cuanto un nodo anterior emite texto útil, así que el parser
puede encontrarse perfectamente con adjuntos ya liberados. Contarlos como «sin texto» los habría
convertido en candidatos a visión, es decir, en una petición a un modelo multimodal sobre bytes que
ya no existen: condenada a fallar. Queda fijado en la prueba 7.6.

Esto obligó a recalibrar los *fixtures*, no la regla: `PDF_ATTACHMENT` modelaba un adjunto sin
`contentBase64`, una forma que `ImapTriggerStrategy` no produce nunca. Se añadió `SCANNED_PDF`, que
es el adjunto tal y como sale del disparador.

### El motor tenía que enterarse

`extracted_documents_text` se sumó a `EXTRACTED_TEXT_KEYS`. La nota de arquitectura del encargo daba
por hecho que con la bandera en `false` el motor purgaría el Base64, y **no era cierto**: el motor
decide con un vocabulario cerrado de claves, y sin la nueva en la lista el correo de cuerpo vacío con
todo su contenido en un PDF dejaba `clean_body` vacío, `hasUsefulText` devolvía `false` y los
megabytes se quedaban en `contexto_acumulado` para siempre, aun habiéndose extraído ya todo su texto.
Una línea, y la nota pasa a ser verdad. (Matiz: el motor no hace `delete`; sustituye el valor por
`null` y conserva `filename`, `contentType` y `size`, para que el inventario siga siendo legible en
la traza forense.)

### Por qué hay un PDF versionado en `test/fixtures/`

La primera versión de la prueba generaba el PDF dentro del propio test, para no meter un binario
opaco en el repositorio. No funcionó, y el motivo merece quedar escrito: `pdf-parse@1.1.1` empaqueta
pdf.js **v1.10**, cuya recuperación de una tabla `xref` imperfecta es heurística. El fixture hecho a
mano tenía entradas de 19 bytes donde la norma exige 20, pdf.js descartaba la tabla, la reconstruía
por su cuenta, y **el resultado dependía de la cadena concreta del fixture**: `'Nota de prensa
institucional'` extraía bien y `'UNUWARE'` devolvía vacío. Corregido el `xref`, seguía fallando de
forma distinta según el texto.

Se dejó de pelear con ello: hay un PDF real generado con Ghostscript, y su fuente PostScript de
cuatro líneas se versiona al lado (`nota-nativa.ps`) para que el binario no sea opaco en una revisión.
Dos conmutadores quedaron anotados como prohibidos al regenerarlo, comprobados variante a variante:
`-dOmitID` deja a pdf.js sin extraer texto, y `-dOmitXMP` falla **solo bajo Jest**.

Por ese mismo motivo, las suites del nodo y del asistente **doblan `pdf-parse`**. Examinan la regla
—qué texto cuenta y cuándo sube la bandera—, no la capacidad de pdf.js de leer un fichero;
ejercitarlo de verdad allí ataba el resultado a una versión concreta de pdf.js y dejaba su worker
vivo tras el *teardown* de Jest, lo que tumbaba el proceso hijo. La extracción real se prueba donde
corresponde, en `document-extractor.util.spec.ts`, contra ficheros de verdad.

### Verificación

Backend **41 suites / 936 pruebas** (antes 40/913), `tsc --noEmit` limpio y `npm audit` sin aportar
un solo aviso nuevo. Frontend **15 ficheros / 321 pruebas**, `vue-tsc` limpio y `quasar build` en
verde.

Lo que **no** está cubierto: no hay ninguna prueba que ejecute un flujo completo con un correo real
con adjunto. La extracción documental de punta a punta —disparador IMAP, parser, purga del motor—
solo se ha verificado por partes, y conviene ejercitarla sobre un buzón de verdad antes de darla por
buena en producción.

---

## 2026-09-10 · Parada inmediata del sondeo IMAP y saneado de ejecuciones huérfanas — rama `feat/trigger-imap`

### Dos premisas del encargo que la auditoría matizó

El diagnóstico de partida hablaba de un ciclo infinito que "sigue corriendo" al desactivar o
**eliminar** un flujo. Al abrir el código, dos cosas no encajaban.

**No existe borrado de flujos.** `WorkflowsController` lo documenta explícitamente: no hay
`@Delete` porque un borrado físico arrastraría el histórico de ejecuciones por el
`ON DELETE CASCADE` de `init.sql:155`. Retirar un flujo es `PATCH { "active": false }`. El
trabajo se acotó, por tanto, a la desactivación, que es el único camino real.

**La fuga estaba acotada, no era indefinida.** `refreshSchedules()` ya hacía diffing en tres
fases, y su fase de bajas retira el intervalo de todo flujo que `findImapTriggerNodes()` —que
filtra `active: true`— deja de devolver. Es decir: el temporizador del flujo desactivado **sí**
moría, pero en el siguiente ciclo de reconciliación. Con los valores por defecto, hasta 60
segundos abriendo sockets IMAP contra un buzón que ya nadie debería consultar. Lo que faltaba
era la parada inmediata, no la parada.

Lo que sí era exactamente como decía el encargo: las ejecuciones huérfanas. Nada las tocaba, y
una fila `EN_PROCESO` no es solo ruido en la trazabilidad — reserva el índice único parcial
`idx_flujo_activo`, así que si el flujo se reactivaba **nunca** podría arrancar otra ejecución.

### `NodesModule` ya importaba `WorkflowsModule`, así que la flecha obvia estaba prohibida

`ImapPollingService` inyecta `WorkflowsService` para despachar el flujo cuando detecta correo.
Inyectar el sondeo dentro de `WorkflowsService` para pararlo habría cerrado el ciclo que el
TSDoc de ambos módulos evita a propósito — y que de hecho `createWorkflow` documentaba como la
razón de conformarse con la reconciliación periódica.

Se descartó `forwardRef`: resuelve el ciclo en el contenedor pero lo deja en el diseño, y este
código lo había evitado deliberadamente. En su lugar, un puerto: `FlowPollingCoordinator` en
`CommonModule`, que ya es `@Global()` y ya alojaba `HybridLoggerService` por el mismo criterio
—infraestructura transversal que no pertenece al dominio de ningún módulo—. El sondeo se
inscribe hacia arriba en su `onModuleInit`; el dominio habla contra una interfaz que no sabe
nada de IMAP ni de `SchedulerRegistry`. El grafo sigue siendo acíclico.

El registro va **después** de la guarda de `IMAP_POLLING_ENABLED`, no antes. Sin sondeo no hay
nada que parar, y sobre todo un `refreshPolling()` disparado desde fuera empezaría a inscribir
temporizadores que ningún ciclo de reconciliación mantiene, saltándose la decisión de que el
fallo por omisión sea *no* sondear.

### Limpiar el `Map` no era opcional, y el test que lo demuestra tarda 60 segundos simulados

`stopPollingForFlow` tiene que hacer dos cosas: borrar el intervalo **y** limpiar la entrada de
`scheduled`, el registro paralelo que sostiene el diffing. Omitir lo segundo parece inofensivo
—el siguiente reconcile se autocura si el flujo sigue desactivado— hasta que el operador
reactiva el flujo antes de ese ciclo:

| Momento | Estado |
|---|---|
| t=0 · desactivar | Intervalo borrado; `scheduled` conserva `flowId → configA` |
| t=10 s · reactivar | La tabla vuelve a devolver el flujo |
| t=60 s · reconcile | `desired` lo tiene → no entra en bajas. `scheduled.get()` devuelve `configA` → no es alta. `hasConfigChanged` es `false` → **no se reinscribe** |

Resultado: flujo activo y mudo, para siempre, y el log reportando `intactos=1`. Es el mismo modo
de fallo que el comentario de `clearSchedules` ya prevenía, reintroducido por la puerta de
atrás. Por eso el `scheduled.delete` va en un `finally`, no dentro del bloque protegido: el Map
es la fuente de verdad, y dejarlo sucio es peor que un intervalo huérfano.

De paso se endureció la fase de altas de `refreshSchedules`, que ahora comprueba también
`doesExist('interval', ...)`. Desde que existe un segundo escritor del par
`scheduled` ↔ `SchedulerRegistry`, dar la invariante por supuesta es una apuesta; ahora el
reconcile la repara en lugar de confiar en ella.

### El `UPDATE` masivo era cosmético mientras el bucle siguiera vivo

Marcar `EN_PROCESO → FALLIDO` por SQL no basta: el `while` de `executeWorkflow` puede seguir
corriendo en este mismo proceso, y su próximo `saveCheckpoint` —un `UPDATE ... WHERE
id_ejecucion = $1` incondicional, sin columna de versión— resucitaría la fila. Peor: si
entretanto arrancó otra ejecución del flujo, esa escritura violaría `idx_flujo_activo` con un
23505 que `saveCheckpoint` no filtra, acabando en volcado forense por algo que no es un fallo.

De ahí la segunda mitad: un `Map` en memoria de `executionId → motivo` que el bucle consulta.
Y hacía falta consultarlo en **dos** puntos, no en uno:

- **Primera sentencia del `while`**, antes del circuit breaker: captura el aborto llegado
  mientras se escribía el checkpoint anterior.
- **Tras el `for(;;)` de reintentos, antes de `outcome.catastrophic`**: captura el caso
  frecuente, el aborto llegado *mientras el nodo corría*, que es donde el bucle pasa casi todo
  su tiempo. Comprobar solo arriba habría dejado que la rama de éxito escribiera `EN_PROCESO`
  antes de salir, devolviendo la fila al mutex.

En ambos se hace `break`, no `throw`: una excepción la atraparía el `catch` externo, que escribe
volcado forense y vuelve a marcar `FALLIDO`, generando justo el ruido que se quiere evitar. Y
como el cursor no es nulo al abortar, el `break` esquiva también el checkpoint `EXITOSO`.

Solo se marcan las `EN_PROCESO`. Una `PAUSADO` es, por definición, una ejecución cuyo bucle ya
terminó: no hay a quien avisar, y su identificador se quedaría en el mapa para siempre. Las que
sí se marcan se limpian en el `finally` de `executeWorkflow` —que hubo que añadir, porque el
`try` externo no tenía— y, además, al **entrar** en `executeWorkflow`: una marca superviviente
envenenaría el reintento manual de CU-09, que reutiliza el mismo `executionId`.

### El motivo no cabía en ninguna columna existente

`ejecuciones_flujo` sabía *qué* había fallado y dónde estaba la autopsia (`ruta_archivo_log`),
pero no *por qué* en términos legibles. Hasta ahora no hacía falta: todo `FALLIDO` lo decidía el
motor tras agotar reintentos, y el detalle vivía en el volcado. Una desactivación es un fallo de
otra naturaleza — no lo provoca ningún nodo y no hay stack trace que volcar.

Se descartó `alertas_error`: esa tabla registra incidencias con severidad que alguien debe
resolver (`resuelto BOOLEAN`), y una desactivación deliberada no es una incidencia pendiente. El
motivo pertenece a la fila de la ejecución. Migración `012` + `failureReason` en la entidad, con
truncado en código a 255: el texto puede interpolar el nombre de un flujo, que lo escribe un
usuario, y sin recorte una desactivación legítima moriría con `value too long`.

**Es un prerrequisito duro, no un extra.** Con `synchronize: false`, en cuanto la entidad declara
la propiedad TypeORM enumera `motivo_fallo` en todo `SELECT` de `FsmExecution`, incluido el
`findOne` de `executeWorkflow`. Entidad y migración se despliegan juntas o el motor no arranca.

### Por qué la limpieza va después del `save`, y no antes

`refreshSchedules` lee `flujos WHERE activo = true` y `runAutomaticWorkflow` relee la columna. Si
paráramos el temporizador antes de comprometer el cambio, una reconciliación que se colara en
esa ventana vería el flujo todavía activo, no lo encontraría en `scheduled` y **lo reinscribiría**
— deshaciendo nuestra propia parada, esta vez sin nadie que la repita. Con `activo = false` ya
persistido, cualquier ciclo posterior está de acuerdo con la parada y como mucho la repite.

Entre las dos operaciones, primero parar y luego abortar: al revés, el intervalo podría disparar
un tick más y crear una ejecución fresca justo después del barrido.

Y ninguna de las dos propaga. La desactivación ya está comprometida cuando se ejecutan;
convertir un fallo de limpieza en un 500 le diría al cliente que la operación falló cuando sí
ocurrió, y su reintento sería un no-op que jamás volvería a intentar la limpieza.

### La reactivación no aborta nada, pero sí adelanta la reinscripción

Simétricamente, `false → true` **no** cierra ejecuciones: las `PAUSADO` conservan su
`activeCursor` precisamente para el reintento de CU-09, y el operador que desactiva para
arreglar algo y reactiva después esperaría encontrarlas. Lo que sí hace es un `refreshPolling()`
inmediato: sin él, pulsar "Activar" y no ver actividad durante un minuto es el síntoma más
visible que quedaba.

### Un tick en vuelo acusaba al buzón de algo que no había pasado

Parar el intervalo no cancela un `pollInbox` ya suspendido en la red. Al reanudar, llega a
`dispatchFlow` y `runAutomaticWorkflow` lo rechaza con un `BadRequestException` — que se
relanzaba y acababa en el `catch` de `pollInbox` registrado como *"[Worker] Falla critica de
conexion IMAP"*, a nivel `error` y con stack. Cada desactivación con un tick en vuelo generaba
una falsa alerta.

Ahora `dispatchFlow` trata cualquier `HttpException` del motor como condición normal, junto al
409 que ya contemplaba, **conservando el mensaje real**: por esa misma vía llega también el
esquema corrupto, y ese sí debe quedar legible en la traza aunque deje de disfrazarse de caída
IMAP. Un fallo que no sea `HttpException` sigue subiendo como `error`, y hay un test para cada
mitad para que la degradación no se coma las averías de verdad.

No se toca `inFlight`: tiene un único dueño, el `try/finally` de `pollInbox`, y borrarlo desde
fuera podría habilitar dos conexiones concurrentes al mismo buzón — literalmente lo que esa
guarda existe para impedir.

### Las filas en PAUSADO no eran una cola de reintento, eran residuo de reinicios

La migración 012 acabó llevando también un `UPDATE`: todo lo que quedaba en `PAUSADO` pasa a
`INACTIVO`. La justificación no es cosmética. `PAUSADO` promete "se detuvo conservando el cursor
culpable, para reintentar desde ahí", pero las filas acumuladas hasta hoy no cumplen esa
promesa: casi todas proceden de la reconciliación de arranque de `FsmModule`, que pasa a
`PAUSADO` cuanto encuentra `EN_PROCESO` al levantar el proceso. Como CU-09 todavía no tiene
endpoint, nadie las ha reintentado nunca. Mientras figuren así, la trazabilidad afirma que hay
trabajo pendiente que no existe.

Lo que no era obvio al escribir la sentencia: **hacía falta anular también `paso_actual`**. El
motor arranca con `execution.activeCursor ?? schema.entrypoint`, así que una fila `INACTIVO` que
conservara su cursor reanudaría a media topología en vez de empezar por el entrypoint — es decir,
exactamente lo contrario de lo que `INACTIVO` significa según el TSDoc de la propia entidad ("el
motor todavía no ha tomado el primer paso"). Habría sido un saneado a medias: el estado diciendo
"nueva" y el comportamiento siendo "reanudada". `contexto_acumulado` sí se conserva: es la única
evidencia que queda de lo que esas ejecuciones llegaron a hacer, y no estorba.

La idempotencia sale gratis porque el predicado es la guarda: tras la primera pasada no queda
ninguna fila en `PAUSADO`, así que reejecutar afecta a 0 filas y sale con éxito. No hizo falta
`IF EXISTS` ni envolverlo en un bloque `DO`. Tampoco se añadió `BEGIN`/`COMMIT`: el directorio
entero se apoya en el autocommit de psql —la 006 lo documenta explícitamente, porque envolverla
habría roto el uso de un valor de enum recién añadido— y las dos sentencias de la 012 son
independientes entre sí, así que no hay atomicidad que preservar.

### Deuda anotada y no corregida

1. **El barrido cierra también las `PAUSADO`.** Son la cola de reintento de CU-09, que todavía no
   tiene endpoint, así que hoy no destruye nada usable. Cuando exista, conviene decidir
   explícitamente si desactivar un flujo debe vaciar su cola.
2. **La cancelación cooperativa es memoria de proceso.** El `UPDATE` es global; el `Map` solo
   corta bucles de *este* proceso. Cuando entre BullMQ, un worker de otro proceso seguiría
   corriendo la ejecución abortada y la resucitaría. El arreglo eventual es un `UPDATE`
   condicional (`estado <> 'FALLIDO'`) comprobando `affected`, que convierte la cooperación en
   garantía.
3. **`motivo_fallo` queda `NULL` en el resto de los `FALLIDO`.** Solo lo rellena el aborto. Si la
   trazabilidad va a mostrarlo, conviene poblarlo también desde `failCatastrophically`.

### Archivos

**Nuevos:**
- `backend/src/common/services/flow-polling.coordinator.ts`
- `backend/src/common/services/flow-polling.coordinator.spec.ts`
- `db/migrations/012-motivo-fallo-ejecucion.sql` (columna `motivo_fallo` + saneado `PAUSADO → INACTIVO`)

**Modificados:**
- `backend/src/common/common.module.ts`
- `backend/src/core/fsm/entities/fsm-execution.entity.ts`
- `backend/src/core/fsm/services/fsm-engine.service.ts` (+ spec)
- `backend/src/modules/nodes/services/imap-polling.service.ts` (+ spec)
- `backend/src/modules/workflows/workflows.service.ts` (+ spec)
- `init.sql`

### Estado de las pruebas

```
backend · npx jest        → 32 suites, 568 tests, 0 fallos  (antes: 31 / 537)
backend · npx nest build  → limpio
backend · eslint          → 18 errores preexistentes; 0 nuevos (antes: 25)
```

**Pendiente de verificación manual contra el contenedor** (Docker lo levanta el usuario; el
socket no es accesible desde la sesión de trabajo). Aplicar la migración **dos veces** para
comprobar la idempotencia: la primera pasada debe reportar `UPDATE <n>`, la segunda `UPDATE 0`,
y ambas terminar con código de salida 0.

```bash
docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
  < db/migrations/012-motivo-fallo-ejecucion.sql
```

---

## 2026-09-09 · Homologación del marcado de errores en CodeMirror — rama `feat/trigger-imap`

### Tres premisas del encargo que la auditoría desmintió

El encargo pedía replicar de `TemplateCodeEditor.vue` la configuración de `basicSetup`, los
«compartimientos de temas» y «la instancia del linter de `@codemirror/lint`». **Nada de eso existe**:
`grep -rn "linter(\|basicSetup\|Compartment" src/` devuelve cero resultados en todo el frontend. El
patrón real del proyecto es una lista manual de extensiones más `lintGutter()` y despacho manual de
`setDiagnostics`.

Y la paridad visual **ya existía**: `unuwareTheme` era idéntico *byte a byte* en los dos componentes
—se verificó comparando los dos bloques extraídos—, `.cm-lintRange-error` y `.cm-lint-marker-error`
incluidos, ambos sobre `var(--pd-negative)`. No había nada que corregir ahí.

Lo que sí estaba roto era otra cosa, y no la que el encargo señalaba.

### El `changeListener` borraba los diagnósticos en cada pulsación

Esa línea —`clearDiagnostics(update.view)`— es la razón por la que un lint de sintaxis local no
podía existir: habría desaparecido con la tecla siguiente. El cambio central de la entrega es que
pase de **limpiar** a **recalcular**.

La distinción entre los dos orígenes se resuelve en el propio recálculo: el error de sintaxis se
recomputa sobre el texto que acaba de quedar, y los `issues` del backend **no** se reinyectan, porque
describen un documento anterior.

### Un solo punto de despacho, porque `setDiagnostics` reemplaza la lista entera

Es la restricción que obliga a fundir los dos orígenes en `refreshDiagnostics` en vez de tener una
función por origen: dos llamadas separadas se pisarían y la segunda borraría lo que pintó la primera.

La precedencia también es una decisión: **si el documento no parsea, los `issues` del backend se
descartan**. Sus rutas no se pueden resolver sobre un JSON roto —`locateJsonPaths` las tiraría de
todas formas— y además el mensaje correcto para el operador es uno solo: arregla la sintaxis primero.

El conjunto se ordena por `from` antes de despachar. Cada localizador ordena lo suyo, pero la unión
de los dos no queda ordenada por construcción, y CodeMirror lo exige.

### V8 emite cuatro formas de `SyntaxError` y solo dos llevan posición

Es el hallazgo que condicionó el diseño del helper. Se comprobó ejecutando `JSON.parse` sobre casos
reales en Node 24:

| Entrada | Mensaje |
|---|---|
| `{\n  "a": 1\n  "b": 2\n}` | `Expected ',' or '}' ... at position 13 (line 3 column 3)` |
| `{\n  "a": 1,\n}` | `Expected double-quoted property name ... (line 3 column 1)` |
| `{\n  "a": ,\n}` | `Unexpected token ',', "{...}" is not valid JSON` ← **sin posición** |
| `   ` | `Unexpected end of JSON input` ← **sin posición** |

El tercer caso es de los errores de tecleo más frecuentes, y V8 dejó de dar su offset: incrusta un
fragmento del texto en su lugar. Así que parsear `(line X column Y)` cubre la mitad de los casos y la
política de reserva no es un detalle. Sin posición se subraya el **documento entero**, que es la
misma convención que `json-path-locator` aplica al centinela `(root)`: honesto —"hay un fallo y no se
sabe dónde"— en lugar de señalar una línea al azar.

### El rango de anchura cero era un bug silencioso, y lo encontró la prueba

La primera versión mapeaba `to = Math.min(line.to, from + 1)` con reserva a `line.to`. Falla justo en
el caso más común: V8 señala la coma que falta **después** del último carácter de la línea, así que
`from` cae exactamente en `line.to` y el rango queda de anchura cero — ni subrayado ni marcador, un
error que el editor simplemente no pinta.

La corrección es subrayar la **línea entera** cuando eso ocurre: "el fallo está en esta línea" es la
información útil. Lo destapó el caso 2.3 del spec, no la revisión visual.

### El helper recibe `DocumentLines`, no un `EditorView`

Se declara la forma estructural mínima (`lines`, `length`, `line(n)`) en vez de importar `Text` de
`@codemirror/state`. `view.state.doc` la cumple tal cual, y a cambio la prueba construye un doble de
tres propiedades sin arrastrar CodeMirror a una suite que corre con `environment: 'node'`. Es el
mismo motivo por el que `violation-matcher` y `json-path-locator` viven en `src/utils/`: la lógica
cuyo fallo es silencioso tiene que ser probable de forma aislada.

### El tema se extrajo porque la paridad era por copia

`unuwareEditorTheme` pasa a `src/utils/codemirror-theme.ts` y lo importan los dos editores. La
paridad existía, pero la próxima corrección de estilo se habría aplicado a uno solo y el marcado de
errores habría divergido entre el CRUD de plantillas y el editor de pipelines — que es exactamente lo
que no puede pasar: el operador tiene que reconocer un error como «un error» en cualquiera de las dos
pantallas.

`unuwareHighlight` **no** se comparte: los tags de HTML (`tagName`, `attributeName`) y los de JSON
(`propertyName`, `number`) son legítimamente distintos.

### El despacho se difiere con `queueMicrotask`

Despachar desde dentro de un `updateListener` es reentrante y CodeMirror lo desaconseja. El código ya
lo hacía, pero limpiar era barato y recalcular más volver a pintar no lo es. El microtask corre antes
del siguiente repintado, así que no hay latencia perceptible.

### Los anfitriones no cambian

La etiqueta de texto de `WorkflowTemplateDialog` (`schemaSyntaxError`) y la de `NodeSequenceBuilder`
(`paramsErrorFor`) se conservan: cumplen el papel de resumen, igual que el panel «Errores del
esquema» para los issues del backend, porque un error puede quedar fuera de la parte visible del
documento. Dejan de ser el único indicio. El sub-editor de `params` de cada nodo hereda el marcado
sin tocar una línea de su componente.

`workflow-templates.store.ts` tampoco se toca: `schemaSyntaxError` sigue gobernando `isDraftValid`,
`saveDraft` y `validateDraftSchema`. El editor calcula su propio rango a partir del texto que ya
tiene; acoplar el store a las posiciones del documento habría sido peor.

### Deuda anotada y no corregida

`props.readonly` se aplica una sola vez en el montaje (`EditorView.editable.of(!props.readonly)`),
sin `Compartment` ni `watch`, así que **cambiarlo en caliente no tiene efecto**. Hoy no se manifiesta
porque los dos anfitriones pasan un literal estático.

### Archivos

**Nuevos:** `src/utils/json-syntax-locator.ts` (+ spec), `src/utils/codemirror-theme.ts`.
**Modificados:** `src/components/JsonPipelinePreview.vue`, `src/components/templates/TemplateCodeEditor.vue`.

### Estado de las pruebas

```
frontend · npx vue-tsc --noEmit  → limpio
frontend · npx vitest run        → 12 archivos, 219 tests, 0 fallos  (antes: 11 / 210)
frontend · eslint + prettier     → limpios en los archivos tocados
```

---

## 2026-09-09 · Periodo de sondeo por entorno y errores catastróficos URGENTE → FALLIDO — rama `feat/trigger-imap`

### Dos de las tres piezas del encargo ya existían

El encargo pedía retirar un decorador `@Interval()` estático e inyectar `ConfigService` y
`SchedulerRegistry`. Nada de eso hacía falta: `ImapPollingService` usa intervalos dinámicos desde la
entrega del diffing, y ambos servicios ya estaban inyectados. El decorador nunca habría servido —
`pollIntervalMs` es un parámetro POR NODO y un decorador se evalúa una sola vez en tiempo de clase.

Lo que sí faltaba era el valor de **instalación**: el default vivía en un literal de módulo
(`DEFAULT_POLL_INTERVAL_MS`) y no había forma de mover el ritmo de todos los buzones sin editar el
esquema de cada flujo. `IMAP_POLLING_INTERVAL_MS` es ahora ese valor de reserva, y solo se aplica
cuando el nodo NO declara el suyo: el periodo sigue siendo por nodo.

Se le pone el **mismo suelo de 30 s que valida el DTO**. No es purismo: un `0` escrito por error en
el `.env` martillearía el servidor IMAP hasta que el proveedor cortase la cuenta, y en silencio. El
DTO ya impone ese suelo a los nodos; la variable de entorno no puede ser la puerta trasera que lo
evita. De paso se documentó `IMAP_RECONCILE_INTERVAL_MS`, que estaba en `.env` pero no en la
plantilla versionada.

### `HybridLoggerService` no existía; Winston llevaba instalado sin usarse

`winston` y `winston-daily-rotate-file` estaban en `package.json` y **cero importaciones** en todo
`src/`. Las variables `LOG_DIR`, `LOG_MAX_FILES` y `LOG_MAX_SIZE` llevaban en `.env.example` desde el
principio esperando a este servicio. Hubo que construirlo entero.

**Híbrido** son dos destinos con dos propósitos, y por eso es un servicio y no un `logger.error`:
el archivo guarda el material forense (stack trace, payload, metadatos) y PostgreSQL guarda la
severidad y la RUTA de ese archivo. De ahí que `logCatastrophicFailure` **devuelva la ruta**: es el
único eslabón entre ambos. Sin ese valor de retorno la fila sabría que hubo un fallo pero no dónde
mirar, y el archivo sería un volcado huérfano.

Dos decisiones que parecen detalles y no lo son:

- **Nivel fijo `error`, no `LOG_LEVEL`.** Atarlo al nivel general significaría que subir la
  aplicación a `warn` haría desaparecer en silencio la traza de los fallos catastróficos, que es
  justo la que nunca puede faltar.
- **No lanza nunca.** Se invoca desde el manejador de errores del motor: una excepción aquí
  sustituiría el fallo real por uno de registro y dejaría la ejecución sin marcar. Si el disco falla
  devuelve `null`, y el motor lo persiste tal cual — "hubo fallo, no hay archivo" es información
  honesta.

### La frontera es LANZAR frente a DEVOLVER, no el `level`

Es la decisión de diseño de la entrega. El encargo hablaba de "error del dominio de los nodos" contra
"excepción no controlada", y la tentación era discriminar por `result.error.level === 'URGENTE'`.
Habría sido un error: una estrategia que **devuelve** `URGENTE` está diciendo "esto es grave y no
tiene sentido reintentar", pero controlaba la situación. Una que **lanza** se ha roto, y el motor no
sabe qué dejó a medias.

Fundir ambos casos habría convertido en terminal un flujo que hoy se pausa y se reanuda con CU-09.
De ahí el tipo `NodeOutcome`, cuyo `catastrophic` es explícito y no derivado.

| Origen | Clasificación | Estado |
|---|---|---|
| `NodeResult{success:false}` devuelto, cualquier `level` | Dominio | `PAUSADO` |
| `StrategyNotFoundException` lanzada | Dominio (configuración) | `PAUSADO` |
| `HttpException` lanzada (timeout, validación) | Dominio | `PAUSADO` |
| Cualquier otro `throw` | Catastrófico | `FALLIDO` |

`StrategyNotFoundException` se queda del lado del dominio a propósito, contra la lectura literal del
encargo: falta la estrategia de un tipo de nodo, que es un error de configuración del esquema. Marcar
FALLIDO obligaría a relanzar el flujo desde cero después de corregirlo, cuando el trabajo de los
nodos anteriores sigue siendo válido. El criterio es *"¿puede un operador arreglar esto sin tocar
código?"*.

### El desenlace catastrófico ni reintenta ni sigue `onErrorStep`

Son dos cortes deliberados, ambos con prueba:

- **Sin reintento**, aunque el nodo declare `retryPolicy`. No se sabe qué dejó a medias la estrategia
  rota, así que volver a invocarla es apostar sobre un estado desconocido.
- **Sin `onErrorStep`.** Esa ruta es una decisión del diseñador del flujo sobre fallos PREVISTOS.
  Aquí se rompió el propio ejecutor, y encaminar a otro nodo prolongaría el bucle sobre un proceso en
  estado desconocido — lo contrario de "proteger el hilo".

### El orden disco → base de datos es la propiedad de corrección

En `failCatastrophically` y en el catch externo, el volcado se escribe ANTES de tocar PostgreSQL. El
escenario típico de un fallo catastrófico es precisamente que la base de datos no responda; al revés,
un fallo de BD se llevaría por delante también el stack trace y no quedaría rastro del incidente en
ninguna parte. El cursor se CONSERVA aunque el estado sea terminal: saber en qué nodo se rompió es la
mitad del diagnóstico.

### Cambio de contrato en una prueba existente

La prueba 7 afirmaba que una excepción no controlada dejaba el flujo en `PAUSADO`. Es exactamente el
comportamiento que el encargo cambia, así que se reescribió a `FALLIDO` y se acompañó de cinco casos
nuevos que fijan la frontera en ambos sentidos. Las pruebas 6, 8 y 9 (URGENTE devuelto,
`StrategyNotFoundException`, circuit breaker) pasan sin tocarlas, que era la señal de que la
clasificación estaba bien puesta.

### Sin migración SQL

`ejecuciones_flujo.ruta_archivo_log VARCHAR(255)` ya estaba en `init.sql` desde el principio; la
entidad `FsmExecution` simplemente no la mapeaba. Verificado contra la base real antes de asumirlo.

### Archivos

**Nuevos:** `src/common/services/hybrid-logger.service.ts` (+ spec).

**Modificados:** `.env.example`, `src/common/common.module.ts`,
`src/core/fsm/services/fsm-engine.service.ts` (+ spec),
`src/core/fsm/entities/fsm-execution.entity.ts`,
`src/modules/nodes/services/imap-polling.service.ts` (+ spec).

### Estado de las pruebas

```
backend · npm test      → 31 suites, 537 tests, 0 fallos  (antes: 30 / 517)
backend · npm run build → OK
backend · eslint        → limpio en los archivos tocados
```

La suite NO escribe en disco: tanto el spec del logger como el del motor simulan el volcado. Se
verificó borrando `logs/` y relanzando la suite completa; no se recrea.

---

## 2026-09-09 · Catálogo de nodos, visibilidad de plantillas retiradas y ensamblador secuencial — rama `feat/trigger-imap`

Cuatro frentes independientes. Los tres primeros son correcciones acotadas; el cuarto abre el camino
para componer una topología sin escribir JSON a mano.

### La migración 011 podía destruir el catálogo, y eso solo se vio ejecutándola

Es el hallazgo importante de la sesión. La 011 (sin commitear, ya aplicada a la base local) hacía un
`DROP TABLE IF EXISTS nodos` incondicional antes de renombrar `tipos_nodo` a `nodos`. En la PRIMERA
pasada es correcto: `nodos` es todavía la tabla de instancias. En la segunda, `nodos` ya es el
catálogo — y el `DROP` se lo lleva con sus nueve filas, tras lo cual el renombrado no encuentra
`tipos_nodo` y la migración muere a mitad.

La migración se anunciaba idempotente y **no lo era**. Lo mismo ocurría con la columna de
`logs_nodo`: el guard `IF EXISTS (column_name='id_nodo') THEN DROP COLUMN id_nodo` borraba en la
segunda pasada la columna que la primera acababa de crear, porque `id_nodo` es a la vez el nombre
viejo y el nuevo.

Los dos casos tienen la misma forma —un nombre que significa dos cosas distintas según el estado— y
la misma solución: **discriminar por contenido, no por nombre**.

| Guard | Discriminante |
|---|---|
| `logs_nodo.id_nodo` | `data_type = 'uuid'` ⇒ es el puntero viejo, se suelta |
| `DROP TABLE nodos` | existe la columna `id_flujo` ⇒ es la tabla de instancias, se borra |

Ninguna revisión estática lo habría encontrado: el SQL era sintácticamente impecable. Se validó
canalizando el archivo a `psql` dentro de `BEGIN … ROLLBACK`, primero una vez y luego dos veces
seguidas en la misma transacción. El DDL de PostgreSQL es transaccional, así que la comprobación no
deja rastro; se verificó después que la base seguía con `id_tipo_nodo` y sus nueve filas.

### Las constraints se nombran con la columna, sin prefijos

Convención fijada en esta entrega: `id_nodo`, `id_log_nodo`, `id_ejecucion`. Prohibidos `pk_`, `fk_`
y `uq_`.

La única excepción es la unicidad de `codigo`, que se llama **`nodos_codigo`** y no `codigo` a secas.
No es estilo: una `UNIQUE` —y una `PRIMARY KEY`— crea un índice con su mismo nombre, y los índices
comparten un único espacio de nombres por esquema. `codigo` es una columna que aparece en varias
tablas, así que reservar ese nombre de índice para `nodos` bloquearía a la siguiente que lo pidiera.

Los guards del renombrado se acotan con `conrelid`. Los nombres de constraint son únicos **por
tabla**, no por esquema, así que un `conname = 'id_ejecucion'` global encontraría la de cualquier
otra tabla y saltaría el renombrado que toca — `alertas_error` tiene precisamente una clave ajena
homóloga.

### `logs_nodo.id_nodo` NO es clave ajena, y el comentario existe para decirlo

`nodos` es el catálogo de TIPOS; `logs_nodo.id_nodo` guarda el `nodeId` de la INSTANCIA del pipeline
(`nodo_parser`), texto libre del JSONB que no existe como fila del catálogo. Una FK ahí rechazaría
todos los inserts.

El problema es que antes de la 011 ese par de nombres **sí** era una clave ajena. Un lector futuro lo
dará por supuesto salvo que algo se lo desmienta, y por eso el comentario va en las dos tablas. Es la
deuda que deja escoger nomenclatura por convención en vez de por semántica; asumida a conciencia.

### Plantillas HTML: mostrar las inactivas exigía poder reactivarlas

El encargo pedía el query param. Al implementarlo apareció que `CreateTemplateDto` no declara
`active` y que `TemplatesService.update()` nunca lo toca: `softDelete` sabe apagar una plantilla y
**nada** sabía encenderla. Listar las retiradas sin más habría llenado la tabla de filas visibles e
irrecuperables.

Se añadió `active?: boolean` al DTO y su rama en `update()`. `create()` no cambia —construye el
objeto campo a campo, así que `active` se ignora en el alta y toda plantilla nace activa.

El filtro sigue siendo del backend, con `onlyActive = true` por defecto: la tabla administrativa pasa
`?includeInactive=true` y el selector Poka-Yoke del nodo `MAPEADOR_PLANTILLA` usa el default. Se
exige el literal `"true"` y no una conversión laxa, porque `Boolean("false")` es `true` y un
parámetro mal escrito debe caer del lado seguro.

### `exact` en `/flujos`, o dos entradas del menú resaltadas a la vez

Añadir «Nuevo Flujo» al drawer revirtió una decisión documentada (el comentario decía que el
asistente se alcanzaba desde el botón de `/flujos`), y el comentario se actualizó para que el código
no se contradiga.

Efecto secundario que el enlace destapó: sin `exact`, vue-router marca `/flujos` como activa también
en `/flujos/nuevo` y `/flujos/:id/editar`. Con las dos entradas en el menú eso se ve. `exact` en la
primera lo resuelve; la segunda no lo necesita, porque no es padre de ninguna ruta.

### El ensamblador escribe sobre el JSON en UNA dirección

`NodeSequenceBuilder.vue` compone la topología y regenera `activeDraft.schemaText`. La sincronización
inversa se descartó: un `watch` sobre el texto que reconstruyera la secuencia pelearía con el editor
en cada pulsación —el JSON pasa por estados intermedios que no parsean— y el cursor saltaría solo.

Lo que se conserva al reordenar son los `params`, indexados por `nodeId`; lo que se pierde es la
topología escrita a mano. `rebuildSchemaFromSequence` respeta además `flowId`, `name` y `version` del
documento vigente: el selector es dueño de la topología, no de los metadatos.

`initDraft` deriva la secuencia recorriendo el grafo desde `entrypoint`. Sin eso, editar una
plantilla existente mostraría el selector vacío junto a un JSON lleno, y el primer clic borraría la
topología guardada.

### El recorrido inverso se protege de los ciclos

`disassemblePipelineSchema` lleva un conjunto de visitados. No es defensa teórica: el JSON es
editable a mano, así que puede llegar con un `nextStep` que apunte hacia atrás, y un bucle infinito
colgaría la pestaña sin ningún mensaje. Un puntero huérfano trunca el recorrido, que es la misma
política que `buildOrderedTopology` aplica en el backend.

### El encadenado se extrajo porque ya tenía dos dueños

`flujo-draft.store.ts` construía `entrypoint` y la cadena de `nextStep` en una closure privada. El
editor de plantillas necesitaba exactamente lo mismo desde otra entrada, y dos copias divergirían en
cuanto una de las dos vistas cambiara —con el síntoma peor posible: un grafo que el validador rechaza
solo desde una de ellas.

`@/utils/pipeline-assembler.ts` es puro y no resuelve stores: recibe los `params` ya resueltos. Quien
conoce el contrato de cada nodo es su propio store (§3.1), así que el anfitrión pregunta con
`toNodeParams()` antes de llamar. Los 59 tests de `flujo-draft.store.spec.ts` verifican que el
comportamiento no cambió.

### `implemented` en vez de filtrar el catálogo

La tabla `nodos` tiene nueve filas y el enum `NodeType` declara siete: `TRIGGER_CRON` y
`DESTINO_ACENS` siguen sin estrategia y `@IsEnum(NodeType)` los rechazaría.

`GET /api/nodos` los devuelve marcados con `implemented: false` en lugar de ocultarlos. Filtrarlos en
el servidor haría que el endpoint mintiera sobre el contenido del catálogo, y ocultarlos en la UI
convertiría una limitación conocida en una ausencia inexplicable. El selector los muestra
deshabilitados: el operador ve que el tipo existe y que todavía no se puede usar.

La autoridad es el enum del backend, no la tabla. El frontend estrecha con `isImplementedNodeType`,
que se apoya en la marca del servidor y no en un `includes` propio: duplicar esa decisión crearía una
segunda fuente de verdad que se desincronizaría con la octava estrategia.

### El editor de `params` no propaga JSON a medio escribir

Para los cinco tipos sin configurador dedicado, el sub-editor JSON solo emite cuando el texto parsea
**y** es un objeto. Propagar un objeto incompleto regeneraría el grafo entero en cada pulsación y
borraría lo tecleado. Mientras no parsee, el texto vive en el estado local del componente y el nodo
muestra su error.

---

### Archivos de la sesión

**Backend — nuevos**
- `src/modules/nodes/entities/node-catalog.entity.ts`, `enums/node-category.enum.ts`
- `src/modules/nodes/dto/node-catalog-response.dto.ts`
- `src/modules/nodes/services/node-catalog.service.ts` (+ spec)
- `src/modules/nodes/node-catalog.controller.ts`
- `src/modules/templates/templates.controller.spec.ts`

**Backend — modificados**
- `src/modules/nodes/nodes.module.ts` (primer controlador del módulo)
- `src/modules/templates/templates.controller.ts`, `templates.service.ts`, `dto/create-template.dto.ts`, `templates.service.spec.ts`
- `src/core/fsm/types/pipeline-schema.types.ts` (TSDoc: `tipos_nodo` → `nodos`)

**Frontend — nuevos**
- `src/types/node-catalog.ts`, `src/services/node-catalog.service.ts`, `src/stores/node-catalog.store.ts` (+ spec)
- `src/utils/pipeline-assembler.ts` (+ spec)
- `src/components/workflow-templates/NodeSequenceBuilder.vue`

**Frontend — modificados**
- `src/stores/workflow-templates.store.ts` (secuencia + reconstrucción), `flujo-draft.store.ts` (delega en el helper)
- `src/services/templates.service.ts`, `src/stores/templates.store.ts`, `src/components/templates/TemplatesManager.vue`
- `src/layouts/MainLayout.vue`, `src/components/workflow-templates/WorkflowTemplateDialog.vue`
- `src/types/html-template.ts`, `src/types/pipeline.ts`, `src/services/nodes/template-mapper.service.ts`

**SQL**
- `init.sql`, `db/migrations/011-catalogo-nodos.sql`

### Estado de las pruebas

```
backend  · npm test              → 30 suites, 517 tests, 0 fallos
backend  · npm run build         → OK
frontend · npx vue-tsc --noEmit  → sin salida (limpio)
frontend · npx vitest run        → 11 archivos, 210 tests, 0 fallos
frontend · eslint + prettier     → limpio en los archivos tocados
```

Deuda de lint **preexistente**, en archivos que esta sesión no tocó: ~30 avisos de `prettier/prettier`
más un `require-await` en `workflows.service.spec.ts:201` y tres `no-unsafe-assignment` en
`imap-polling.service.spec.ts`. Se dejan como estaban para no mezclar reformateos con el cambio
funcional; `npm run lint` los arregla en su mayoría.

### Siguiente paso y reanudación

Rama activa: `feat/trigger-imap`. Nada commiteado todavía.

1. **Aplicar la migración** (la ejecuta el usuario):
   ```bash
   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
     < db/migrations/011-catalogo-nodos.sql
   ```
   La base local está en el estado "una pasada previa de la 011": `nodos` tiene `id_tipo_nodo` y
   `ui_schema`, `logs_nodo` tiene `node_id`, `tipos_nodo` ya no existe. Es la rama (b) de los guards.
   Sin aplicarla, `GET /api/nodos` devuelve 500: la entidad mapea `id_nodo` y la columna todavía se
   llama `id_tipo_nodo`.

2. **Comprobación manual end-to-end**, ya con la migración aplicada:
   ```bash
   cd backend && npm run start:dev
   cd frontend && quasar dev
   ```
   «Plantillas de Flujo» → «Nueva Plantilla»: añadir dos o tres nodos y comprobar que el JSON se
   regenera con `entrypoint` y la cadena de `nextStep`; reordenar y ver que los punteros cambian;
   desplegar un `TRIGGER_IMAP` (formulario dedicado) y un `PROCESADOR_IA` (editor JSON); pulsar
   «Validar» y forzar un error —dos nodos con el mismo `outputNamespace`— para ver el subrayado.
   En «Plantillas»: desactivar una y confirmar que sigue en la tabla con el badge «Inactiva» y que
   «Activar» la recupera.

3. **Commit** cuando la comprobación manual pase:
   ```bash
   git add -A
   git commit -m "feat(trigger-imap): catalogo de nodos, plantillas inactivas y ensamblador secuencial"
   ```
   El hook `commit-msg` exige que el ámbito coincida con el sufijo de la rama.

4. **Pendiente de fondo, no abordado**: `nodos.ui_schema` sigue vacío (`'{}'`) en las nueve filas y
   nadie lo lee. El editor polimórfico resuelve hoy por registro de componentes con respaldo JSON; el
   renderizador dirigido por `ui_schema` es lo que permitiría retirar ese respaldo.

---

## 2026-08-27 · Revocación de sesiones aislada por dispositivo + sincronización multi-pestaña — rama `feat/auth-otp`

Cierra el pendiente que dejó la entrega anterior (*"el backend no persiste `deviceId`"*) y, con él, la deuda multi-pestaña que arrastraba la entrega del endurecimiento del JWT. Las dos mitades van juntas a propósito: la primera, sola, convertiría una pestaña desincronizada en un cierre de sesión global.

### Lo que cambia de comportamiento

`refresh_tokens` gana `id_dispositivo UUID NOT NULL` (migración 004), y `issue()` pasa a recibir el dispositivo. Emitir un token ahora revoca el token vivo anterior **de ese mismo dispositivo** y deja intactos los de los demás equipos del usuario. Volver a entrar desde el portátil ya no deja dos sesiones vivas en él, y no expulsa al móvil.

### El orden dentro de la transacción es la propiedad de corrección

Son tres pasos con tres motivos distintos, y dos de ellos tiran en direcciones opuestas:

| Paso | Por qué ahí |
|---|---|
| 1. Revocar `{userId, deviceId, isRevoked: false}` | **Antes** de insertar. Después, el filtro `isRevoked: false` alcanzaría al token recién creado y lo revocaría al nacer. |
| 2. Insertar el token nuevo | — |
| 3. Podar los inservibles | **Después** de insertar. El token nuevo nace vigente, así que no es candidato (razonamiento ya documentado en la entrega de la poda). |

### Desviación deliberada del encargo: el repositorio transaccional

La especificación pedía `this.refreshTokenRepository.update(...)`. Se usa el `repository` que entrega `manager.transaction`, no el inyectado: `this.refreshTokenRepository` opera **fuera** de la transacción de `issue()`, así que si la inserción fallara después, la revocación quedaría confirmada y el usuario perdería su sesión en ese dispositivo sin recibir reemplazo. La invariante que ya declaraba el comentario del método —*"nunca se borra nada sin que su reemplazo exista"*— exige el repositorio transaccional. Hay una prueba que fija el orden vía `mock.invocationCallOrder`.

### `rotate()` devuelve `RotatedSession`, no `User`

Devolvía solo el usuario y **descartaba la fila**, que es donde vive el `deviceId`. Ahora devuelve `{ user, deviceId }`, y `refreshSession` lo pasa a `buildTokenResponse`.

La alternativa era que el cliente reenviara el `deviceId` en `/auth/refresh`. Se descartó: el dispositivo se fija en el login y lo transporta la cadena de tokens, de modo que un token en rotación no puede cambiar de etiqueta de dispositivo a mitad de sesión. `RefreshTokenDto` no se tocó.

### El falso positivo de reutilización se acepta: es comportamiento esperado del servidor

Un login nuevo en el dispositivo D revoca el token vivo anterior de D. Si algún cliente todavía conserva ese token y lo presenta, `rotate()` lo ve revocado, lo interpreta como robo y ejecuta `revokeAllForUser()`: **caen todas las sesiones del usuario**.

Es una decisión, no un descuido. La detección de reutilización **no puede distinguir** un token robado de uno que un cliente desincronizado conservaba: ambos son la misma observación (una credencial revocada que reaparece). Resolver la ambigüedad en el backend exigiría una columna de motivo de revocación —`ROTACION` vs `SUPERSEDIDO`— y ramificar `rotate()`; se descartó explícitamente para no ampliar el esquema, y ante la duda el servidor elige el lado seguro: asumir robo.

**Por tanto la sincronización es responsabilidad del frontend**, y de ahí la segunda mitad de esta entrega.

### Nota de seguridad sobre el `deviceId`

Lo elige el cliente y **no está autenticado**: cualquiera puede enviar el UUID que quiera. Solo se usa acotado a `userId`, así que un usuario únicamente puede afectar a sus propias filas — no hay vector cruzado. Jamás debe usarse como entrada de autorización.

### Frontend: el evento `storage` cierra el agujero

`session.store.ts` escucha `storage`, que **solo se dispara en las otras pestañas**, nunca en la que escribió — así que adoptar el estado no puede realimentarse.

- **Se relee el trío completo, no solo el access token.** Adoptar únicamente el access token dejaría el `refreshToken` viejo en memoria, que es *exactamente* la credencial que dispara la detección de reutilización descrita arriba. Adoptar los tres es lo que cierra el agujero.
- **`writeSession` escribe tres claves**, así que un login ajeno llega como tres eventos. Reaccionar a cualquiera releyendo el estado completo converge al valor correcto; los intermedios son transitorios.
- **Sin token en disco se propaga el cierre**: cerrar sesión en una pestaña desloguea las demás.
- **El temporizador se reinicia solo.** No hace falta tocar el monitor: `useSessionMonitor` ya tiene `watch(() => sessionStore.accessToken, scheduleWarning)`, y `scheduleWarning` limpia el intervalo y vuelve a sondear desde cero. Actualizar el ref **es** reiniciar el temporizador, y así el store sigue sin conocer Quasar ni `$q.dialog` (`frontend-architecture.md` §2.1).
- **Las claves salen de `session-storage.ts`** mediante un `isSessionStorageKey` nuevo: el store no hardcodea `'proto-do:access-token'`, el módulo hoja sigue siendo el único dueño de los nombres.

### Desviación deliberada: el listener NO se retira en `clear()`

El encargo lo pedía. Sería un bug: `clear()` corre en cada cierre de sesión, y una pestaña sin listener no volvería a enterarse de un login posterior en otra — la desincronización regresaría en cuanto el usuario cierre y vuelva a entrar. El listener vive tanto como el store, que es un singleton de la aplicación.

Se expone `stopCrossTabSync()` para pruebas y desmontaje, y el módulo guarda la referencia al listener activo porque en HMR se reevalúa y cada recarga en caliente apilaría un listener más.

### Verificación

93 pruebas en verde (9 suites): las 87 previas más 6 nuevas —revoca el token del mismo dispositivo, no alcanza a otros dispositivos, revoca antes de insertar, persiste el `deviceId`, `rotate` devuelve el dispositivo, y el arrastre en la renovación—. `npx tsc --noEmit` **en cero errores**: de paso se cerró el TS2741 preexistente de `refresh-token.service.spec.ts:13` (`ACTIVE_USER` sin `otpSecret`), que era el único del proyecto. `eslint` y `nest build` limpios. En frontend, `vue-tsc --noEmit`, `eslint` y `npm run build` limpios; sin pruebas automatizadas porque el frontend aún no tiene arnés.

Pendiente de verificación manual contra el backend real: los puntos 6-12 del plan de esta entrega, en particular que un login desde otro navegador **no** cierre la sesión del primero, y que dos pestañas se mantengan sincronizadas al renovar.

### Checklist de dependencias restantes

- [ ] **Aplicar la migración 004** — es requisito de arranque: hasta entonces cualquier login falla con `column RefreshToken.id_dispositivo does not exist`. Borra las sesiones abiertas.
- [ ] **La ventana de detección de reutilización es por usuario, no por dispositivo:** `RETAINED_DEAD_TOKENS = 5` cuenta sobre todos los tokens muertos del usuario, así que con varios equipos la ventana efectiva **por dispositivo** se estrecha (~5/N rotaciones). Hacer la poda por `(userId, deviceId)` la restauraría y acotaría el crecimiento a `sesiones_vivas + 5 × dispositivos`.
- [ ] **Diálogo de expiración obsoleto:** si una pestaña tiene el aviso abierto y adopta un token fresco de otra, el diálogo no se cierra solo (`scheduleWarning` reprograma el sondeo pero no toca `dialogHandle`). Queda con una cuenta regresiva vieja; "Mantener sesión" renueva con el token nuevo, sin daño. El arreglo es un `closeExpiryDialog()` dentro del `watch` de `useSessionMonitor.ts` cuando el token nuevo tenga holgura — fuera del alcance "solo `session.store.ts`" de esta entrega.
- [ ] **`@Cron` sobre `purgeExpired()`:** sigue pendiente desde la entrega de la poda.

---

## 2026-08-27 · `deviceId` en `verifyOtp` (solo frontend) — rama `feat/auth-otp`

El frontend genera y persiste un identificador de dispositivo (`crypto.randomUUID()`, vía el plugin nativo `LocalStorage` de Quasar) y lo adjunta al `POST /auth/otp/validate`. Alcance acotado a propósito a esta capa.

- **`frontend/src/utils/device-id.ts`** (nuevo): `getOrCreateDeviceId()` lee `proto-do:device-id` de `LocalStorage`, genera un UUID si no existe y lo persiste. Sigue el mismo criterio de `session-storage.ts` — es un helper que hace I/O de almacenamiento, no de red, así que se aparta de la regla "helpers puros, sin I/O" de `frontend-architecture.md` §2.1 por el mismo motivo ya documentado ahí.
- **`quasar.config.ts`**: se añadió `'LocalStorage'` a `framework.plugins`. No estaba registrado — solo `Notify` y `Dialog` — y sin registrarlo el plugin no funciona (mismo tropiezo que tuvo `Dialog` en la entrega del 26).
- **`auth.service.ts`**: `verifyOtp` gana un tercer parámetro `deviceId` y lo incluye en el body.
- **`session.store.ts`**: la acción `verifyOtp` llama a `getOrCreateDeviceId()` internamente; su firma pública `(email, code)` no cambió, así que `LoginPage.vue` no se tocó.

### El backend todavía no hace nada con este campo

`VerifyOtpDto` solo declara `email` y `code`. El `ValidationPipe` global usa `whitelist: true` sin `forbidNonWhitelisted` (`main.ts:29`), así que el `deviceId` que llega en el body se **descarta en silencio**: la petición no falla, pero el dato se pierde antes de llegar a `AuthService.verifyOtp`. No hay columna en `refresh_tokens` ni en ningún otro sitio para persistirlo.

Es una decisión de alcance, no un olvido: esta entrega es deliberadamente frontend-only. Para que el `deviceId` sirva para algo (p. ej. distinguir sesiones por dispositivo, o mostrarlas en un futuro "cerrar sesión en otros dispositivos") hace falta una entrega aparte que extienda `VerifyOtpDto`, añada la columna a `refresh_tokens` (migración) y la hidrate en `RefreshTokenService.issue()`.

### Checklist de dependencias restantes

- [x] **Wiring de backend** — *resuelto el 2026-08-27* (ver la entrada de revocación por dispositivo, arriba): `VerifyOtpDto.deviceId` pasa a ser obligatorio, `refresh_tokens` gana `id_dispositivo` (migración 004) y `issue()` lo persiste. El campo ya no se descarta.

---

## 2026-08-26 · Cierre del oráculo de enumeración en la solicitud de OTP — rama `feat/auth-otp`

Revierte la tarea 1 de la entrega anterior, que había hecho que una cuenta registrada pero inactiva respondiera `401 Cuenta inactiva` mientras un correo desconocido seguía devolviendo `202`. Esa diferencia bastaba para recorrer una lista de correos corporativos y deducir cuáles estaban dados de alta.

Los tres caminos vuelven a ser indistinguibles desde fuera:

| Situación | Respuesta |
|---|---|
| Código enviado | `202` + mensaje genérico |
| Correo no registrado | `202` + **el mismo** mensaje |
| Cuenta desactivada | `202` + **el mismo** mensaje |

El motivo real del descarte viaja solo al `Logger.warn` del servidor, que distingue "correo inexistente" de "cuenta desactivada" para quien lee los logs.

### El coste que se acepta a cambio

Un usuario cuya cuenta fue desactivada no recibe ninguna pista: pide el código, ve un mensaje de éxito y espera un correo que no llega. Es incómodo a propósito. La alternativa era la vulnerabilidad, y el canal correcto para avisarle es el administrador que lo dio de baja, no un endpoint público sin autenticar.

### La prueba cambió de bando

`DOCUMENTA EL ORACULO DE ENUMERACION`, que verificaba que los caminos **diferían**, se sustituyó por `ANTI-ENUMERACION: cuenta inexistente, inactiva y valida son indistinguibles`, que compara el desenlace de los tres y exige que sean idénticos. Falla si alguien vuelve a abrir el oráculo.

### Limpieza derivada en el frontend

`LoginPage.sendOtp` inspeccionaba el `401` para mostrar "Tu cuenta esta desactivada". Ese 401 ya no puede ocurrir — el guard de IP da 403 y el throttler 429 —, así que era código muerto y se retiró. El `catch` queda para fallo de red, 429 y 5xx.

### Nota para el futuro

El controlador **no** lleva `try/catch` alrededor de `requestOtp` porque el servicio no lanza. Si algún día lanzara (por ejemplo, un fallo de SMTP que hoy sube como 500), envolverlo pasa a ser obligatorio: un 500 que solo ocurre con correos existentes reabre el oráculo por la puerta de atrás. Queda anotado en el propio controlador.

---

## 2026-08-26 · Correcciones de UX del login, pool SMTP y RBAC en el router — rama `feat/auth-otp`

### ⚠️ Se abrió un oráculo de enumeración en `POST /auth/otp/generate` — **CERRADO el 2026-08-26**

> **Resuelto.** Duró una entrega. `requestOtp` volvió al `return` silencioso para
> ambos casos y el controlador homologa los tres caminos con el mismo `202`. Lo que
> sigue se conserva como registro de por qué existió y por qué se revirtió.


`requestOtp` ahora distingue dos casos que antes eran indistinguibles:

| Situación | Antes | Ahora |
|---|---|---|
| Correo no registrado | `202` silencioso | `202` silencioso |
| Cuenta registrada pero inactiva | `202` silencioso | **`401 Cuenta inactiva`** |

Esa diferencia es explotable: un atacante recorre una lista de correos corporativos y **deduce cuáles están dados de alta** por el código de respuesta. Es exactamente lo que la regla anti-enumeración de la entrega PROT-04.1 existía para impedir, y contradice el requisito original ("si no encuentra el email o está inactivo, retorna `void`; NUNCA arrojes 404").

Se implementa así por decisión de producto: se quiere que el frontend pueda decirle al usuario que su cuenta está desactivada en lugar de dejarlo esperando un correo que nunca llega. Cerrarlo es volver al `return` silencioso en `AuthService.requestOtp`; hay una prueba (`DOCUMENTA EL ORACULO DE ENUMERACION`) que falla en cuanto ambos caminos vuelvan a comportarse igual, para que el cambio no pase inadvertido.

Nota: `POST /auth/otp/validate` **sí** sigue devolviendo el mismo 401 genérico para cuenta inexistente, inactiva, sin inscribir y código erróneo. El oráculo está solo en `generate`.

### Pool SMTP: por qué el segundo correo tardaba

Sin `pool`, NodeMailer abre una conexión nueva por envío: saludo SMTP, handshake TLS y autenticación otra vez. Ahí estaban los segundos de latencia. Con `pool: true` la conexión queda abierta y el siguiente envío la reutiliza.

`maxConnections: 1` porque el volumen real es un OTP por inicio de sesión, y abrir varios canales en paralelo solo invita al proveedor a aplicar límites. `maxMessages: 100` recicla la conexión antes de que el servidor la corte por su cuenta.

Efecto secundario que obligó a añadir `onModuleDestroy`: un pool con conexiones abiertas mantiene vivo el bucle de eventos y el proceso de Node no termina. `transporter.close()` al apagar lo resuelve.

### La plantilla del correo es la única excepción a la regla de tokens CSS

`frontend-quasar.md` prohíbe hexadecimales inline, pero un cliente de correo no tiene `var(--pd-*)`: Gmail y Outlook descartan las hojas externas y el `<style>` del `<head>`. La paleta se replica como constantes en `email.service.ts` y todo el CSS va inline, con maquetación en `<table>` porque el soporte de flex/grid en Outlook es irregular.

### Casillas de OTP: por qué el avance escucha `update:model-value` y no `keyup`

`OtpCodeInput.vue` mantiene seis casillas internas pero expone al padre la cadena completa por `v-model`. El avance automático se dispara en `update:model-value` en lugar de en `keyup`, que era lo pedido: el autorrelleno del código desde el gestor de contraseñas o desde la notificación del correo **no genera pulsaciones de tecla**, así que con `keyup` el foco se quedaría clavado en la primera casilla. Pegar el código entero en cualquier casilla lo reparte por las siguientes.

Al completarse las seis emite `complete` y el login valida solo, sin pulsar el botón.

### `q-toggle` del tema: no se ata a `$q.dark.isActive`

`$q.dark.isActive` es de solo lectura — escribirlo no conmuta nada, hay que llamar a `Dark.set()`. Y aunque funcionara, saltarse `useThemeStore` perdería la persistencia en `localStorage` y el tema se olvidaría al recargar. El toggle usa un `computed` con `get`/`set` que delega en el store.

### Guarda RBAC: se redirige, no se cancela

La tarea pedía `next(false)` **y** redirigir a `/`. Son excluyentes en vue-router 4: se devuelve una ubicación o `false`, no ambas. Se devuelve `{ path: '/' }`, que además es lo correcto — `next(false)` deja la barra de direcciones mostrando la URL prohibida, porque el navegador ya la había escrito.

El diálogo usa `Dialog.create()` importado del paquete, no `useQuasar()`: dentro de una guarda no hay componente montado del que obtener la instancia.

`meta.requiresAdmin` va en `/users`, espejando el `@Roles(UserRole.ADMIN)` del `UsersController`. **No es control de acceso**: solo evita pintar una vista que el backend contestaría con 403. La autoridad sigue siendo el `RolesGuard` de NestJS.

### Monitor de expiración: de `setTimeout` a `setInterval`

Un `setTimeout` programado a 59 minutos vista no sobrevive de forma fiable a una suspensión del equipo ni a un salto del reloj del sistema. El sondeo de 1 s recalcula `exp * 1000 - Date.now()` en cada vuelta y se autocorrige solo.

Se conserva el `visibilitychange` de la entrega anterior porque sigue haciendo falta por otro motivo: los navegadores frenan los temporizadores de pestañas en segundo plano hasta ~1 vuelta por minuto, así que al volver podría pasar casi un minuto hasta el siguiente tick.

### Tareas que no tenían dónde aplicarse

- **Formateo de fechas:** no existe ningún componente de trazabilidad, y el CRUD de usuarios no muestra **ninguna** fecha (`User` es `id`, `email`, `role`, `isActive`). Se creó `@/utils/date-format.ts` listo para usar, sin consumidores todavía. Usa `Intl.DateTimeFormat` y **no** `date.formatDate` de Quasar: `formatDate` da formato pero no convierte husos, así que por sí solo no resolvería el problema. Añade la `Z` a las cadenas ISO sin sufijo de zona, porque el navegador las interpretaría como hora local en lugar de UTC.
- **`localStorage`:** ya estaba limpio. Tres claves (`proto-do:access-token`, `proto-do:refresh-token`, `proto-do:user`), sin hashes inventados y sin ningún `setItem` fuera de `session-storage.ts` y `theme.store.ts`. Sin cambios.
- **`mdi-v7` estaba comentado** en `extras` de `quasar.config.ts`, así que `mdi-shield-crown` no habría renderizado. Habilitado; la fuente se empaqueta (`materialdesignicons-webfont-*.woff2`).

---

## 2026-08-26 · Secreto TOTP persistido por cuenta y blindaje de la serialización — rama `feat/auth-otp`

### Qué cambió

El secreto TOTP pasa de **derivarse** (`base32(HMAC-SHA256(OTP_SECRET, correo))`) a ser **aleatorio y persistido** en `usuarios.secreto_otp`. La entrada del 25 documenta el diseño anterior; se conserva como registro histórico.

### Por qué, y qué se pierde

**Se gana:** poder rotar o revocar la inscripción de **un** usuario sin tocar a nadie más. Con una semilla maestra, cambiar `OTP_SECRET` invalidaba los códigos de todas las cuentas a la vez, así que en la práctica no se podía rotar nunca.

**Se pierde, y hay que decirlo:** el secreto se muda a la base de datos. Con la derivación, un volcado de `usuarios` **no** permitía forjar códigos — hacía falta además conocer `OTP_SECRET`, que vive en el entorno del proceso. Ahora un lector de la tabla puede generar códigos válidos para cualquier cuenta. Es exactamente lo contrario del razonamiento que justificó hashear los refresh tokens, y es una regresión consciente aceptada a cambio de la rotación por usuario.

Si esa exposición no resulta aceptable, la salida es cifrar `secreto_otp` en reposo (AES-256-GCM con clave en el entorno): conserva la rotación por usuario y devuelve la propiedad de que el volcado por sí solo no basta. No está implementado.

### La inscripción es perezosa, y por qué el UPDATE es condicional

Las cuentas existentes y las que crea el CRUD no traen secreto. En lugar de una migración de datos, se genera en la primera solicitud de código. Eso deja `secreto_otp` como `NULL`able, que es lo correcto: refleja el estado real "aún no inscrita".

El `UPDATE` de `ensureOtpSecret` filtra por `otpSecret IS NULL` y vuelve a leer el valor persistido. Sin esa condición, dos solicitudes concurrentes sobre la misma cuenta nueva escribirían secretos distintos y el segundo invalidaría el código que el primero ya envió por correo. Con ella, el perdedor de la carrera adopta el secreto ganador y emite un código válido. Hay una prueba AAA para ese caso.

### `verifyOtp` no inscribe

Solo `requestOtp` genera secretos. Si `verifyOtp` recibe una cuenta sin secreto, devuelve el 401 genérico y no inscribe: no existe código legítimo que validar, e inscribir ahí convertiría la ruta de validación en un canal de alta silencioso.

### Doble barrera contra la fuga del secreto

Las dos capas cubren casos distintos y por eso están las dos:

- **`select: false`** en la columna: ningún `find` la trae, así que el secreto ni llega a memoria en el CRUD. Sacarlo exige `addSelect` explícito, que vive en un único método (`findByEmailWithOtpSecret`).
- **`@Exclude()`** de `class-transformer`: actúa cuando el secreto **sí** se ha cargado, que es justo el flujo de autenticación.

Encima, el CRUD responde con `UserResponseDto`, que lleva `@Exclude()` **de clase** en vez de `@Exclude()` campo a campo. La diferencia importa: invierte la política por defecto, de modo que un campo nuevo en la entidad no aparece en la respuesta hasta que alguien lo exponga a propósito. La alternativa —excluir lo sensible— falla en silencio la próxima vez que alguien añada una columna.

`ClassSerializerInterceptor` está en `UsersController` y en `AuthController`. En el de autenticación es defensa en profundidad y hoy no hace nada: `AuthTokenResponse.user` se construye campo a campo como objeto plano, y el interceptor solo transforma instancias de clase. Sirve para el día en que alguien devuelva la entidad desde una ruta de auth.

La prueba de `UsersController` carga el secreto **a propósito** en el doble del servicio y verifica que no aparece en ninguno de los cinco verbos. Al hacerlo saltó una aserción antigua que comparaba la respuesta contra la entidad completa: buena señal, el filtrado funcionaba.

### Lo que la tarea daba por hecho y no existía

- No había **CRON job** ni uso de `@nestjs/schedule` que eliminar; el paquete está instalado pero sin usar.
- No había **tabla de códigos temporales**, sino dos columnas huérfanas en `usuarios` (`codigo_otp`, `expiracion_otp`) que ningún código leía. La migración 003 las retira.
- Los nombres `AuthOtpController` / `AuthOtpService` no existen: son `AuthController` / `AuthService`.
- La columna se llama `secreto_otp`, no `otpSecret`, por coherencia con el resto de `init.sql`; la entidad la mapea con `@Column({ name })` como ya hacía `User`.

### Consecuencia operativa

`OTP_SECRET` dejó de leerse y se retiró de `backend/.env.example`. En `backend/.env` queda como resto inofensivo.

**La migración 003 es requisito de arranque:** hasta aplicarla, `findByEmailWithOtpSecret` falla con `column user.secreto_otp does not exist` y el login entero queda roto. El CRUD sigue funcionando porque `select: false` mantiene la columna fuera del `SELECT` por defecto.

---

## 2026-08-25 · Autenticación OTP y ciclo de sesión con rotación de refresh tokens (PROT-04.1 / PROT-06.4) — rama `feat/auth-otp`

### Punto de partida

PROT-04.2 dejó el `AuthModule` capaz de **verificar** un JWT pero incapaz de emitirlo: no había forma de iniciar sesión. Además, `grep -rni refresh` no devolvía **ninguna** coincidencia en todo el repositorio: cuando el token caducaba, la única salida era volver a pedir un OTP.

### Por qué el secreto TOTP se deriva por usuario

`otplib` trabaja sobre un secreto. La tentación es usar `OTP_SECRET` directamente, y es un fallo grave: el TOTP depende **solo** del secreto y del instante, así que con una semilla compartida el mismo código de 6 dígitos sería válido para **todas** las cuentas en la misma ventana. Cualquiera podría pedir su propio código y entrar como otro.

La derivación es `base32( HMAC-SHA256( OTP_SECRET, email.toLowerCase() ) )`. Al ser determinista no hay nada que persistir: el secreto se recalcula en cada operación. El correo se normaliza (`trim` + minúsculas) para que `ADMIN@UNUWARE.COM` y `admin@unuware.com` no deriven secretos distintos.

**Nota sobre `otplib` v13:** la API `authenticator` de la v12 **ya no existe**. La v13 es modular y hay que inyectar los plugins a mano (`NobleCryptoPlugin`, `ScureBase32Plugin`) en un `new TOTP({...})`, y sus métodos son asíncronos.

### Por qué en la base de datos solo vive el hash del refresh token

El refresh token es una credencial portadora: quien lo tenga renueva la sesión. Guardarlo en claro significa que **una lectura de la tabla** — un volcado, una copia de seguridad extraviada, una inyección SQL de solo lectura — entrega sesiones utilizables de todos los usuarios durante 7 días. Con SHA-256 hexadecimal en `hash_token`, lo que se filtra no sirve para autenticarse: el servicio hashea lo que recibe y compara.

Es exactamente el mismo razonamiento que se aplica a las contraseñas, con **una diferencia deliberada**: aquí no hay sal ni derivación lenta (bcrypt/argon2). Esas defensas existen porque una contraseña humana tiene poca entropía y admite diccionarios precomputados. El token son 256 bits de `randomBytes`, así que no hay nada que precomputar y una función rápida es la elección correcta; encadenar argon2 en cada renovación solo añadiría latencia.

**El token es opaco, no un JWT.** Un JWT sería autovalidable y por tanto irrevocable hasta su caducidad. Que la validez viva en la tabla es justo lo que permite cerrarlo antes de tiempo.

### Rotación y detección de reutilización

Cada `POST /auth/refresh` **revoca** el token presentado y emite uno nuevo. La consecuencia útil es que un refresh token válido solo puede aparecer una vez: si reaparece uno ya revocado, hay dos copias en circulación y una de ellas es de un atacante.

No se puede saber cuál, así que `rotate()` responde revocando **toda la familia** del usuario (`revokeAllForUser`) y devolviendo 401. El legítimo y el ladrón quedan fuera, y recuperar el acceso exige un OTP nuevo al correo corporativo — un canal que el atacante no controla. El coste es que un usuario legítimo puede verse desconectado por una condición de carrera entre pestañas; se acepta a cambio de cerrar el robo de sesión.

Los cinco modos de fallo de `rotate()` (inexistente, revocado, caducado, dueño inexistente, cuenta desactivada) devuelven **el mismo mensaje**: distinguirlos le diría a un atacante en qué estado está la credencial que tiene en la mano. Hay una prueba AAA que verifica esa igualdad literal.

### Decisiones que no son obvias

- **El access token bajó de 8 h a 1 h.** Un JWT es autocontenido: el backend no puede invalidarlo, así que `logout` revoca el refresh pero el access sigue vivo hasta caducar. Ocho horas de ventana para un token robado era demasiado; con refresh tokens la sesión ya no depende de que el access dure mucho. Efecto secundario: el diálogo de expiración del frontend se vuelve verificable a los 59 minutos en lugar de a las 7 h 59 m.
- **`POST /auth/logout` no estaba en el encargo.** Se añadió porque sin él "Cerrar sesión" solo limpiaría el navegador, dejando un refresh token válido **7 días** en la base de datos. Es idempotente: cerrar una sesión ya cerrada no es un error.
- **`generate` devuelve `expiresInSeconds`.** El frontend necesita el tiempo real para su cuenta regresiva y la alternativa era codificar 120 s a ciegas. No rompe la regla anti-enumeración porque es configuración global, idéntica para toda cuenta, exista o no.
- **La respuesta de `generate` es constante.** Correo inexistente y cuenta desactivada devuelven el mismo `202` con el mismo mensaje que un envío real. Sin eso, el endpoint sería un validador de cuentas corporativas.
- **El `ThrottlerGuard` no es global.** Se aplica solo en `AuthController`: el resto de la API no debe pagar un límite calibrado contra la fuerza bruta del OTP. Dentro del controlador, `refresh` y `logout` suben a 10/60 s con `@Throttle` porque tres pestañas abiertas agotarían el cupo de 3.
- **El controlador pasó de `@Controller('auth/otp')` a `@Controller('auth')`** con el prefijo `otp/` bajado a cada handler. `/auth/refresh` no podía colgar de un prefijo de OTP. Las dos URLs existentes no cambiaron.
- **El código OTP nunca sale del correo.** No se retorna, no se registra en logs y hay pruebas que verifican que no aparece en el JSON de respuesta. `EmailService` registra el destinatario y el fallo, jamás el código.

### Esquema y migración

`refresh_tokens` sigue la convención en español de `init.sql` (`id_usuario`, `expiracion`, `revocado`, `fecha_creacion`) y la entidad la mapea a propiedades inglesas con `@Column({ name })`, igual que `User`.

TypeORM corre con `synchronize: false` — y debe seguir así: activarlo dejaría que TypeORM alterase o borrase columnas de las nueve tablas del esquema. Como `init.sql` solo se ejecuta con el volumen `pgdata_protodo` vacío, el DDL vive **duplicado a propósito** en dos sitios: `init.sql` para clonados nuevos y `db/migrations/001-refresh-tokens.sql`, idempotente, para las bases ya pobladas.

**Nota operativa:** el `.env` de este equipo tiene finales de línea **CRLF**, así que un `source backend/.env` deja cada valor con un `\r` pegado. De ahí que los comandos de `psql` documentados lleven usuario y base literales en lugar de `$DB_USER` / `$DB_NAME`.

### El arranque en frío del RBAC (migración 002)

El CRUD de usuarios exige `ADMIN`, pero **crear** un usuario pasa por ese mismo CRUD. Con la tabla `usuarios` sin ningún `ADMIN`, nadie puede crear el primero: un bloqueo circular que la API no puede romper por definición. La verificación en vivo lo destapó — la única cuenta de la base era `EDITOR`, y `GET /api/users` con un token válido devolvía **403** correctamente.

`db/migrations/002-bootstrap-admin.sql` lo rompe desde fuera, y solo eso: promueve la cuenta activa más antigua **si y solo si** no existe ya ningún `ADMIN` activo. Con uno presente no toca nada, porque a partir de ahí gestionar roles es competencia del CRUD y no de una migración.

No se versiona ningún correo concreto: el caso de instalación desde cero queda como un `INSERT` comentado al final del archivo para rellenar con el correo real. La cuenta debe existir en un buzón accesible de verdad — la autenticación es por OTP contra ese correo y no hay contraseña que definir.

### Frontend: por qué el interceptor no lee el token de Pinia

La cadena natural sería `boot/axios → session.store → auth.service → boot/axios`: un ciclo de imports. Se rompe con `src/utils/session-storage.ts`, un módulo **hoja** que no importa nada; tanto el store como el interceptor dependen de él y él de nadie.

Eso lo aparta de la regla "helpers puros, sin I/O" de `frontend-architecture.md` §2.1. Es deliberado y acotado: solo toca `localStorage`, nunca la red, y toda lectura y escritura va con `try/catch` porque en modo incógnito o con las cookies bloqueadas el acceso lanza excepción.

### Dos instancias de Axios, no una

`api` lleva los interceptores; `authApi` es su hermana **sin ninguno**. Sin esa separación, un 401 de `POST /auth/refresh` dispararía el manejador que limpia la sesión y redirige — el propio intento de renovar la sesión la cerraría — y un 401 del login se comería el mensaje de error antes de que `LoginPage.vue` pudiera mostrarlo.

El interceptor de respuesta **no reintenta ni renueva en silencio**: un 401 purga y sale. Renovar es tarea del monitor proactivo, que avisa al usuario; hacerlo también aquí crearía dos caminos compitiendo por el mismo refresh token, y el segundo en llegar activaría la detección de reutilización y tumbaría todas las sesiones.

### El monitor es un composable, no un componente

`useSessionMonitor()` no pinta nada, así que como componente *renderless* incumplía `vue/valid-template-root` (un SFC exige nodo raíz). Se invoca desde `MainLayout.vue`, que envuelve todas las rutas autenticadas: su ciclo de vida coincide con el de la sesión y se desmonta solo al salir a `/login`. El `$q.dialog` sigue viviendo en la capa de componentes; el store nunca conoce Quasar.

### Resiliencia ante suspensión del sistema operativo

`setTimeout` no sobrevive de forma fiable a una suspensión: al despertar puede dispararse tarde, o no haberse disparado mientras el token ya caducaba, dejando al usuario dentro de una sesión muerta hasta que una petición fallara con 401.

Por eso hay un `visibilitychange`: cada vez que la pestaña vuelve a ser visible se **recalcula** `exp * 1000 - Date.now()` contra el reloj real en lugar de confiar en el temporizador. Si el resultado es ≤ 0 no se ofrece renovación — se purga la sesión, se notifica y se redirige de inmediato.

### Otros detalles del frontend

- **`meta: { requiresAuth: true }` va en la ruta padre**, no en cada hijo: una vista nueva bajo `MainLayout` nace protegida sin depender de que alguien recuerde marcarla (Poka-Yoke, mismo criterio que los guards a nivel de clase en `UsersController`).
- **La guarda del router solo mira el estado local.** La autoridad real es el backend, que responde 401. Sirve para no pintar vistas privadas que acabarían vacías, no como control de seguridad.
- **El plugin `Dialog` no estaba registrado** en `quasar.config.ts` (solo `Notify`): sin añadirlo, `$q.dialog` es `undefined`.
- **`isCorporateEmail` subió a `@/utils/corporate-email`.** Vivía dentro de `UserDialog.vue`; al necesitarla también el login se aplicó el criterio de la §3: si otra vista necesita el mismo resultado, sube.
- **El contador del login lee `expiresInSeconds` del backend** y solo cae a 120 s si no llega. Con `OTP_EXPIRATION_MINUTES=5` mostrará 300 s; para el estándar literal de 120 s basta poner `OTP_EXPIRATION_MINUTES=2`.
- **`decodeJwtClaims` decodifica, no verifica.** El navegador no tiene el secreto y cualquier validación de firma en cliente sería teatro; solo sirve para saber *cuándo* caduca. Devuelve `null` ante cualquier anomalía en vez de lanzar.

### Checklist de dependencias restantes

- [ ] **Purga de tokens caducados:** `purgeExpired()` existe pero nadie la llama. Falta engancharla a un `@Cron` de `@nestjs/schedule` (ya instalado); mientras tanto, la tabla solo crece.
- [ ] **`SMTP_HOST=smtp.example.com`:** hasta poner credenciales reales, `requestOtp` responde 500 y el recorrido de extremo a extremo exige leer el código de otra forma.
- [ ] **Columnas `codigo_otp` / `expiracion_otp` de `usuarios`:** quedaron huérfanas en `init.sql`. El diseño TOTP no persiste códigos, así que deberían eliminarse en una migración futura.
- [ ] **`test/app.e2e-spec.ts`:** sigue siendo el boilerplate de `nest new` y falla al exigir Postgres. No se tocó.
- [ ] **Credenciales SMTP reales:** con `SMTP_HOST=smtp.example.com` el login por navegador no se puede completar. La verificación se hizo derivando el código OTP con la misma función del backend.

---

## 2026-08-25 · Perímetro de red local y RBAC del CRUD de usuarios (PROT-04.2 / PROT-05) — rama `feat/Middleware-IP`

### Punto de partida

El backend era un CRUD abierto: sin `src/common/`, sin módulo `auth`, sin guards. `JWT_SECRET` y la variable de subred existían en `.env` pero **ningún código las leía**. Cualquiera con acceso al puerto podía listar y desactivar usuarios.

### Por qué el perímetro se implementa en DOS piezas y no en una

La tarea pedía un `RedLocalMiddleware`; el requisito de eximir rutas con un decorador `@PublicIp()` exige un `Reflector`, que solo existe dentro de un `ExecutionContext` — es decir, en un `CanActivate`. Pero un guard **no puede** proteger Swagger: `SwaggerModule.setup()` registra sus rutas directamente contra el adaptador Express, fuera del router de Nest, así que ningún guard llega a ejecutarse sobre `/api/docs`.

De ahí la separación por *alcance*, no por duplicación:

- **`IpWhitelistGuard`** (`APP_GUARD`, con `Reflector`) → todas las rutas del router de Nest.
- **`RedLocalMiddleware`** (Express puro) → solo las rutas de Swagger.
- Ambos delegan en **`IpAccessService`**, único lugar donde vive la política. Cambiar la regla es cambiar un archivo.

**Hallazgo de la verificación en vivo:** montar el middleware sobre el prefijo `/api/docs` dejaba `/api/docs-json` respondiendo **200 desde una IP externa**. Swagger registra el documento JSON/YAML como rutas **hermanas** (`api/docs-json`), no anidadas: se filtraba el inventario completo de endpoints fuera del perímetro. El middleware se monta ahora sobre las tres rutas (`SWAGGER_PERIMETER_PATHS` en `main.ts`). No lo detectó ningún test unitario; solo el `curl` contra el proceso real.

### Decisiones que no son obvias

- **Fail-closed sin excepción de entorno.** Si `ALLOWED_IP_RANGES` falta, está vacía o solo trae separadores, se rechaza con 403 — también en desarrollo. Un fallback permisivo en `NODE_ENV !== 'production'` es exactamente el tipo de configuración que acaba desplegada.
- **El motivo técnico del rechazo solo viaja al log.** `IpAccessService.buildDenial()` registra IP + método + URL + causa, pero al cliente le llega siempre el mismo `ACCESS_DENIED_MESSAGE`: no se le confirma si el problema fue la lista, su IP o la ausencia de cabeceras.
- **`x-forwarded-for` es falsificable.** El orden de prioridad (XFF → `x-real-ip` → `socket.remoteAddress` → `req.ip`) lo fija la especificación de la tarea, y es correcto **solo detrás de un proxy inverso de confianza**. Expuesto directamente, cualquiera envía la cabecera que quiera. Al desplegar, el proxy debe sobrescribir XFF, no anexarla.
- **`403` para rol insuficiente, `401` para token inválido.** Un EDITOR autenticado no es un anónimo: su token es válido, lo que le falta es autorización. `RolesGuard` nunca devuelve 401.
- **Guards a nivel de clase en `UsersController`** (Poka-Yoke): un endpoint nuevo nace protegido; no depende de que alguien recuerde decorarlo.
- **Se reutilizó el enum `UserRole` existente** en lugar de crear el `Role` que pedía el enunciado: ya está respaldado por el tipo Postgres `enum_rol_usuario` de `init.sql`. Un segundo enum sería una fuente de verdad duplicada.
- **`AuthModule` sin controlador, a propósito.** Aquí solo se **verifica** el JWT; emitirlo (OTP + throttler) es PROT-04.1. El módulo queda listo para recibir ese controlador.
- **Alias absolutos sin herramientas nuevas.** `@nestjs/cli@11` incluye un transformer (`lib/compiler/hooks/tsconfig-paths.hook.js`) que reescribe `@common/...` a rutas relativas en el JS emitido, tanto en `nest build` como en `nest start --watch`. Bastaron `baseUrl` + `paths` en `tsconfig.json`; **no** hicieron falta `tsc-alias` ni `module-alias`, y `start:prod` sigue funcionando. Jest sí necesitó su propio `moduleNameMapper`.
- **`noImplicitAny` pasó a `true`.** Estaba desactivado pese a que las reglas prohíben el `any` implícito; el código existente ya cumplía, así que el cambio no costó nada.

### Normalización de variables de entorno

Había **tres** nombres para la misma idea y ninguno se leía: `ALLOWED_IP_SUBNETS` (`.env`), `ALLOWED_SUBNET_CIDR` (`.env.example`). Canonizado a `ALLOWED_IP_RANGES` en ambos, con `::1/128` añadido (sin él, el loopback IPv6 quedaba fuera). También se alineó `JWT_EXPIRATION` → `JWT_EXPIRES_IN` en la plantilla.

### Verificación

`npm run build` limpio, `npm run lint` con 0 errores y **36 pruebas AAA en verde** (6 suites). Contra el proceso real: `/api/health` responde 200 desde cualquier IP; `/api`, `/api/users` y las tres rutas de Swagger devuelven 403 desde `8.8.8.8`; desde la VPN `10.20.30.40` el perímetro se supera y queda el 401 por falta de token. Con tokens firmados: EDITOR → 403 en los cinco endpoints, ADMIN → 200, token expirado o mal firmado → 401, y **ADMIN desde IP externa → 403**, confirmando que el perímetro se evalúa antes que las credenciales.

### Checklist de dependencias restantes

- [ ] **PROT-04.1**: endpoints de OTP (`otplib`), emisión del JWT y `@nestjs/throttler` sobre esas rutas.
- [ ] **`test/app.e2e-spec.ts`**: sigue siendo el boilerplate de `nest new` y falla porque levanta `AppModule` completo exigiendo Postgres. Ya fallaba antes de este cambio; no se tocó.
- [ ] **`trust proxy`**: decidir la configuración de Express al definir el proxy inverso de despliegue.
- [ ] **Winston**: instalado y con variables `LOG_*` en `.env`, pero sin usar. `IpAccessService` registra con el `Logger` nativo de Nest; migrará al servicio de trazabilidad cuando exista.

---

## 2026-08-25 · Refactor del módulo Gestión de Usuarios (CU-02) — rama `feat/CRUD-Users`

### Capas: extracción de `src/services/`

**Por qué.** `users.store.ts` llamaba a `api.get/post/patch/delete` directamente, violando `frontend-architecture.md` §1. La cadena obligatoria `Componente → acción de Pinia → Servicio → HTTP` estaba rota en su eslabón central: el store conocía rutas del backend y el tipo `AxiosResponse`, dos motivos de cambio ajenos a la lógica de negocio.

- Nuevo `frontend/src/services/users.service.ts`: única capa que conoce `/users` y `/users/:id`. Cuatro funciones puras (`fetchUsers`, `createUser`, `updateUser`, `deactivateUser`) que retornan `data` desestructurada. No capturan errores: los propagan.
- `users.store.ts` conserva firmas, el `try/finally` de `isLoading` y las mutaciones inmutables (`[...users.value, created]`, `.map(...)`); solo delega el I/O. Los componentes no se enteraron del cambio.
- Alias `@services` añadido a `build.alias` en `quasar.config.ts` (`quasar prepare` lo propaga a `.quasar/tsconfig.json`). Recordatorio: `@types` sigue inviable por TS6137.
- Se amplió `.claude/rules/frontend-architecture.md` con la **§2.1 Responsabilidad por Capa**: la regla prohibía HTTP en stores pero no decía dónde vive la lógica propia de un formulario o diálogo. Ahora la tabla lo fija: validación de campos, apertura de diálogo y temporizadores viven en el componente; el negocio y el estado compartido en el store; los helpers puros de formato en `src/utils/`.

**Consecuencia práctica:** la validación de dominio corporativo (`isCorporateEmail`) se quedó deliberadamente en `UserDialog.vue`. Es una regla del formulario, no un invariante de dominio, y muere con el componente.

### Presentación: sincronización con la paleta institucional

**Por qué.** `frontend-quasar.md` fue actualizado a la paleta **navy + degradado azul**, pero `app.scss` seguía implementando el briefing anterior (papel blanco, `#2e75b6`, shell `#1e1e1e`). Los tokens que el refactor visual necesitaba (`--pd-primary`, `--pd-primary-light`, `--pd-negative`, `--pd-disabled-bg`, `--pd-panel-solid`, …) simplemente no existían: nada podía consumirlos en runtime.

- `quasar.variables.scss`: brand vars alineadas (`$primary #2C4FC7`, `$dark #12142E`, `$dark-page #0D0F26`, tríada semántica) + nuevo `$heading-font-family` (Poppins → Montserrat → Inter).
- `app.scss`: los 20 tokens de la tabla de reglas, separados en tres bloques por **motivo de cambio**: los que conmutan con `body--dark`, los de marca que NO conmutan (azules, acentos, severidad) y el shell. Se **consolidaron** cinco tokens fuera de la lista cerrada (`--pd-input-bg`, `--pd-text-disabled`, `--pd-border-soft`, `--pd-primary-tint`, `--pd-shell-hover`) tras verificar por grep que ningún `.vue` los consumía.
- Los `--pd-row-*` se conservan como tokens derivados (no son colores nuevos: son la tríada de severidad a baja opacidad) porque las reglas exigen las clases `.row-urgente/-grave/-exitoso`; faltaba `--pd-row-exitoso`.
- Poppins se instaló vía `@fontsource/poppins` con importación de pesos explícita (500/600/700) en `App.vue`: **no tiene eje variable** en fontsource, a diferencia de Inter y JetBrains Mono. Sin CDN, coherente con el aislamiento perimetral.

### Detalles de implementación que no son obvios

- **Columna "Nombre"**: la entidad `usuarios` del backend no persiste un nombre propio (solo `id`, `correo`, `rol`, `activo`). Se creó el helper puro `src/utils/user-display.ts` con `deriveDisplayName(email)`: `mmolina@` → `M. Molina`, `victor.garcia@` → `Victor Garcia`. El umbral `MIN_SURNAME_LENGTH = 5` existe para evitar el falso positivo `admin` → `A. Dmin`; por debajo del umbral cae a capitalización simple. Decisión de presentación, cero cambios en BD.
- **UUID sin columna propia**: rompía la legibilidad de la tabla. Pasó a un `QTooltip` con `.pd-mono` sobre la celda del nombre — el dato técnico sigue accesible sin ocupar ancho.
- **`--pd-accent` vs `--pd-accent-text`**: `#5B8CE8` da ~3:1 de contraste, insuficiente para texto pequeño en modo claro (WCAG AA). Los badges de rol y los hovers de icono consumen `--pd-accent-text` (`#3D6BD9` en claro), no `--pd-accent`.
- **Estado "Inactivo" ya no es rojo**: usaba `color="negative"`, que semánticamente comunica *error*. Una cuenta desactivada es un estado neutro válido, de ahí `--pd-disabled-bg` / `--pd-disabled-text`.
- **Borde de los botones outline**: QBtn pinta su borde en `::before` con `currentColor`, así que el trazo seguía al color del texto. `.pd-btn-icon` fuerza `border-color` al token en `&.q-btn--outline::before` para que el borde sea `--pd-border` en reposo y `--pd-accent` en hover, independientemente del texto.
- **Estado deshabilitado**: Quasar aplica `opacity` a los botones deshabilitados, lo que atenuaría el degradado en lugar de sustituirlo. `.pd-btn-primary.disabled` fuerza `opacity: 1` y reemplaza el fondo por `--pd-disabled-bg`, cumpliendo la regla de que el texto nunca comparta tono con el fondo.
- **Countdown de 5 s**: `SafeDeleteModal.vue` ya lo implementaba correctamente (`COUNTDOWN_SECONDS = 5`, `:disable`, guarda en `onConfirm`, `clearInterval` en `onBeforeUnmount`). **No se tocó esa lógica**; solo pasó a `.pd-btn-danger` sólido y ganó la franja roja de 3 px vía `.pd-card--accent.pd-accent-urgente`.

### Checklist de dependencias restantes

- [ ] **Dark-first**: `theme.store.ts` y `quasar.config.ts` usan `dark: 'auto'`; las reglas piden arrancar en oscuro (`true`) con toggle persistido. Pendiente de decisión.
- [ ] **`ErrorNotFound.vue`**: aún usa `bg-dark`, `text-h4` y `style` inline (`font-size: 30vh`).
- [ ] **Iconografía outline**: `@quasar/extras` no trae el set `material-icons-outlined` en esta instalación, así que los iconos de navegación siguen siendo del set filled. Habría que añadir el paquete para cumplir la regla de trazo lineal en todos los glifos.
- [ ] **Tests**: falta el test AAA de `deriveDisplayName` y el de `users.store` con `users.service` mockeado.

---

## 2026-08-27 · Endurecimiento del ciclo de vida del JWT (PROT-06.4) — rama `feat/auth-otp`

Auditoría de la coordinación entre el interceptor de Axios, `session.store.ts` y `useSessionMonitor.ts`. La funcionalidad ya estaba completa (decodificación de `exp`, aviso a 60 s, renovar / cerrar, limpieza de temporizadores); lo que fallaba era el reparto de responsabilidades entre las tres piezas. Cuatro defectos, ninguno visible en la ruta feliz.

**Se descartó mover el temporizador al store.** Un `setTimeout` calculado a `timeRemaining - 60000` se programa, con un JWT de 60 minutos, a 59 minutos vista: no sobrevive a una suspensión del equipo ni a un salto del reloj del sistema, y el usuario recibiría un 401 seco en vez del aviso. El sondeo de 1 s recalcula contra `Date.now()` en cada vuelta y se autocorrige. Además, un `$q.dialog` dentro del store rompe `frontend-architecture.md` §2.1 y obliga a `useQuasar()` fuera de un `setup()`.

### Defecto 1 — El interceptor 401 desincronizaba el store (crítico)

`boot/axios.ts` llamaba a `clearSession()`, el helper de `localStorage`, **no** a `sessionStore.clear()`. Los refs de Pinia quedaban vivos con el token muerto, y como la guarda del router lee `isAuthenticated`, la redirección a `/login` rebotaba a `/` (`router/index.ts:78`): el usuario quedaba atrapado en un dashboard sin tokens, con cada petición dando 401 y **sin poder alcanzar el login**. Peor: `refreshToken.value` seguía en memoria, así que "Mantener sesión" podía resucitar una sesión ya rechazada por el backend.

El arreglo purga el store. El import de `@stores/session.store` es **diferido dentro del manejador**, no en el nivel de módulo: ahí cerraría el ciclo `boot → store → service → boot` que documenta `session-storage.ts`. La instancia de Pinia sale del parámetro `store` que `defineBoot` ya recibía sin usarse. `clear()` invoca `clearSession()` por dentro, así que el helper dejó de importarse en `axios.ts`.

### Defecto 2 — Carrera entre `refreshTokens()` y el sondeo

`.onOk()` bajaba `isDialogOpen` **antes** de que la renovación resolviera, y el sondeo seguía corriendo sobre el token viejo. Al tick siguiente el aviso se reabría encima de la renovación en curso; y si la petición tardaba más que el tiempo restante, `millisecondsUntilExpiry <= 0` disparaba `logout()` **con el refresh en vuelo** — la renovación resolvía después y `applyTokens()` reescribía `localStorage`, dejando una sesión zombi con el usuario ya en `/login`.

Se añadió el flag `isRefreshing`, levantado *antes* de lanzar la petición (el siguiente tick llega en 1 s) y bajado en el `finally`. Lo respetan como guarda temprana tanto `checkExpiry()` como `onVisibilityChange()`: volver a la pestaña durante una renovación tampoco debe cerrar la sesión mirando el token que está a punto de morir.

### Defecto 3 — Diálogo huérfano al expirar

`terminateSession()` no cerraba un diálogo abierto. Al ser `persistent` y montarse fuera del árbol de `MainLayout`, quedaba flotando sobre la vista de login. Se conserva el `DialogChainObject` que devuelve `$q.dialog()` y se llama a `.hide()` desde `closeExpiryDialog()`. La cuenta regresiva interna de `SessionExpiryDialog.vue` se mantiene como respaldo visual, pero la autoridad sobre la terminación pasa a ser sólo el monitor.

### Defecto 4 — Sondeo residual tras `clear()`

`clear()` pone `accessToken = null`, lo que dispara el `watch` → `scheduleWarning()`, que reinstalaba un `setInterval` de 1 s aunque `checkExpiry` saliera de inmediato por `millisecondsUntilExpiry === null`. Ahora `scheduleWarning()` sale sin reinstalar el intervalo cuando no hay token legible.

### Deuda técnica conocida: multi-pestaña — **RESUELTA el 2026-08-27**

> **Resuelto.** El listener de `storage` en `session.store.ts` propaga el par nuevo entre pestañas (ver la entrada de revocación por dispositivo, al principio del archivo). Lo que sigue se conserva como registro del problema.

Cada pestaña corre su propio monitor **sin sincronización**. Si la pestaña A renueva, el backend rota el refresh token; la pestaña B conserva el viejo en memoria y al pulsar "Mantener sesión" lo presenta de nuevo — lo que según `auth.service.ts` **derribaría todas las sesiones del usuario** por detección de reuso. No se abordó aquí: el arreglo (listener de `storage` para propagar el par nuevo, o un lock de renovación en `localStorage`) es un cambio de mayor calado.

### Verificación

`npx vue-tsc --noEmit` sin errores, `eslint` sobre los dos archivos tocados con salida limpia y `npm run build` correcto (SPA, Quasar v2.25.1). `session.store.ts`, `jwt.ts` y `SessionExpiryDialog.vue` no se tocaron: su lógica ya era correcta.

### Checklist de dependencias restantes

- [x] **Multi-pestaña** — *resuelto el 2026-08-27* con el listener de `storage` en `session.store.ts`.
- [ ] **Tests**: faltan las pruebas AAA de `decodeJwtClaims` (base64url con relleno, token corrupto, `exp` ausente) y del monitor con temporizadores falsos de Jest — en particular la carrera del Defecto 2.
- [ ] **`trust proxy`**: sigue pendiente de la definición del proxy inverso de despliegue.

---

## 2026-08-27 · Poda transaccional de refresh tokens (PROT-06.4) — rama `feat/auth-otp`

Cierra la mitad del punto pendiente *"la tabla solo crece"*: cada emisión de token limpia ahora las filas muertas de ese usuario. La poda vive en `RefreshTokenService.issue()`, **no** en `AuthService` — este último no inyecta repositorio, y `RefreshTokenService` es el único punto del backend que conoce la tabla (`code-conventions.md` §2).

### Por qué no se poda "por los 2 más recientes"

La regla intuitiva —conservar los N tokens más recientes por `createdAt`— **borra tokens activos de otros dispositivos**. Con dos sesiones abiertas:

| Paso | Filas del usuario (`createdAt` desc) | Poda "top 2" |
|---|---|---|
| Portátil inicia sesión | `A(activo)` | — |
| Móvil inicia sesión | `B(activo)`, `A(activo)` | conserva B, A |
| Móvil refresca: `rotate(B)` revoca B, `issue()` inserta D | `D(activo)`, `B(revocado)`, `A(activo)` | conserva D, B → **borra A** |

El refresco rutinario de un equipo expulsa al otro, porque el token revocado `B` ocupa una de las dos plazas. De facto limita a un solo dispositivo, y la expulsión es silenciosa: la víctima recibe un 401 genérico. Con tres dispositivos, el tercer login mata al primero directamente.

### Regla adoptada

> Borrar los tokens **ya inservibles** (revocados **o** caducados) del usuario, **excepto los `RETAINED_DEAD_TOKENS = 5` más recientes**. Un token vigente no se toca jamás, sea cual sea su antigüedad.

Los 5 supervivientes no son decorativos: son la ventana de detección de reutilización de `rotate()`. Un token robado que reaparece dentro de esas últimas rotaciones todavía encuentra su fila y dispara `revokeAllForUser()`; sin ella daría un 401 plano, la familia no caería y la brecha pasaría desapercibida. Es el control que la FSM de `PLAN.md:202` dibuja como `rotate() de nuevo ⇒ REUTILIZACIÓN`.

El crecimiento queda acotado a `sesiones_vivas + 5` filas por usuario.

### Detalles de implementación

- **Transacción sin `DataSource`.** Se usa `this.refreshTokenRepository.manager.transaction()`, que llega gratis con el repositorio ya inyectado. Evita un provider nuevo y deja `auth.module.ts` intacto. Si la poda falla, el token nuevo tampoco se persiste.
- **El orden insertar → podar es la propiedad de seguridad.** El token recién creado nace `isRevoked: false` con `expiresAt` futuro, así que nunca entra en el filtro de candidatos. No hace falta excluirlo explícitamente.
- **Dos pasos (`find` + `delete`) en vez de un `DELETE ... NOT IN (subquery)`.** Dentro de la transacción es igual de seguro, se expresa con nombres de propiedad de la entidad en lugar de columnas crudas (`id_usuario`, `revocado`, `expiracion`) y es trivial de mockear. El `where` en forma de array es el OR revocado/caducado.
- **Sin migración.** El índice `idx_refresh_tokens_id_usuario` ya cubre el filtro; ordenar unas pocas filas por usuario es trivial. Relevante porque `app.module.ts:35` fija `synchronize: false`.
- **El doble de repositorio del spec se devuelve a sí mismo** como repositorio transaccional (`manager.transaction` ejecuta el callback en el acto con un `getRepository` que retorna el mock). Sin ese puente, las tres pruebas previas de `issue` rompían al no encontrar `manager`.

### Verificación

85 pruebas en verde (9 suites), 5 nuevas sobre la poda: transacción única, criterio con `skip`/`order`/`where` de dos ramas, retorno temprano sin candidatos, borrado por ids exactos y regresión de la sesión vigente ajena. `eslint` limpio y `nest build` correcto. Nota: `refresh-token.service.spec.ts:13` arrastra un error de `tsc` preexistente (`otpSecret` ausente en el literal `ACTIVE_USER`), anterior a este cambio y no introducido aquí.

### Checklist de dependencias restantes

- [ ] **`@Cron` sobre `purgeExpired()`:** la poda de `issue()` solo actúa cuando el usuario emite un token; una cuenta que deja de entrar conserva sus 5 filas muertas indefinidamente. El barrido periódico con `@nestjs/schedule` (ya instalado) sigue pendiente.
- [ ] **`rotate()` e `issue()` no comparten transacción:** la revocación se confirma antes de que `AuthService.buildTokenResponse` llame a `issue()`. Si la emisión fallara, el usuario queda sin token y debe reentrar por OTP. Comportamiento **preexistente**; unificarlo exige propagar un `EntityManager` a través de `buildTokenResponse`.
- [ ] **`ACTIVE_USER` sin `otpSecret`** en `refresh-token.service.spec.ts`: error de `tsc` pendiente desde la incorporación de TOTP.

---

## 2026-08-27 · Bloqueo de auto-modificación/eliminación en el CRUD de usuarios (MOD-01) — rama `feat/auth-otp`

Un ADMIN autenticado podía ejecutar `PATCH /users/:id` o `DELETE /users/:id` sobre su propio `id`: desactivarse o degradar su propio rol lo dejaría fuera del único módulo que gestiona cuentas, sin otro ADMIN activo que lo revirtiera.

- **Nuevo `@common/decorators/current-user.decorator.ts`.** No existía forma de extraer `req.user` fuera de un guard; los guards acceden directo a `context.switchToHttp().getRequest<RequestWithUser>()` (`roles.guard.ts:29`). El decorador reutiliza ese mismo contrato — mismo patrón que `public-ip.decorator.ts` para un concepto transversal — y no repite la comprobación de "sin usuario": para cuando se evalúa, `RolesGuard` ya lanzó `ForbiddenException` si `req.user` faltaba.
- `UsersController.update()` y `.remove()` reciben `@CurrentUser() currentUser: AuthenticatedUser` y abren con `assertNotOperatingOnSelf()`, extraído como método privado en vez de duplicar el `if` en los dos endpoints.
- `@ApiForbiddenResponse` de clase actualizado para reflejar la causa nueva del 403.

### Verificación

87 pruebas en verde (85 previas + 2 nuevas: PATCH y DELETE contra el propio `ADMIN_USER.id` → 403, servicio no invocado), reutilizando el arnés existente de `users.controller.spec.ts` (app real con `RolesGuard` auténtico). `eslint` limpio, `nest build` correcto. El error de `tsc` en `refresh-token.service.spec.ts:13` sigue siendo el mismo preexistente, ajeno a este cambio.

---

## 2026-08-27 · El CRUD de usuarios muestra el motivo real del error (no un texto genérico) — rama `feat/auth-otp`

Tras MOD-01, un ADMIN que intenta modificar o eliminar su propia cuenta recibía un toast
genérico ("No se pudo guardar el usuario") en vez del mensaje real del backend
("Operación denegada: No puedes modificar ni eliminar tu propio usuario."). La causa no era
específica de MOD-01: los cuatro `catch` del CRUD de usuarios (`UserDialog.vue` `onSubmit`,
`UsersManager.vue` `confirmDeactivation`/`activateUser`/`loadUsers`) usaban `catch {}` **sin
parámetro**, así que era estructuralmente imposible que leyeran el error real.

- Nuevo helper puro `frontend/src/utils/api-error.ts`: `extractApiErrorMessage(error, fallback)`
  lee `error.response.data.message` con el mismo patrón de detección que
  `boot/axios.ts:47` (`axios.isAxiosError`). Normaliza tanto el `string` de un
  `ForbiddenException(...)` como el `string[]` de un error de validación de `class-validator`.
  `fallback` conserva exactamente el texto que cada sitio mostraba antes, para errores de red o
  respuestas sin este formato.
- Los cuatro `catch` pasaron a recibir el error y usar el helper con su fallback original. No se
  tocó `users.store.ts` ni `users.service.ts`: las excepciones ya se propagaban sin capturar
  (`frontend-architecture.md` §2.1), que es justo lo que este cambio necesitaba.
- `SafeDeleteModal.vue` no se tocó: es un componente genérico de confirmación ajeno al resultado
  de la operación; el `$q.notify` con el mensaje correcto sigue apareciendo después de cerrarse.

### Verificación

`eslint --fix` limpio, `vue-tsc --noEmit` sin errores, `npm run build` correcto. Sin pruebas
automatizadas: el frontend no tiene arnés de tests todavía (deuda ya anotada en este archivo).
Verificación manual pendiente para quien pruebe contra el backend real: editar/desactivar la
propia cuenta ADMIN debe mostrar el mensaje de MOD-01 textual, no el genérico.

---

## 2026-08-29 · Contratos y validación topológica del `pipeline_schema` (PROT-07) — rama `feat/fsm-contracts`

Primera pieza del motor FSM. Antes de escribir una sola estrategia hacía falta el contrato del grafo
que el `FsmEngineService` va a recorrer: sin él, un `configuracion_pipeline` mal formado —un
`nextStep` colgando, dos nodos escribiendo el mismo namespace, un camino que nunca termina— solo se
descubriría en runtime, con la ejecución a medias y el `StatePayloadContext` ya corrompido. Este
cambio mueve ese fallo al momento de guardar el flujo.

### `@ValidateNested({ each: true })` no funciona sobre un `Record`

El diseño de partida ponía `@ValidateNested({ each: true })` + `@Type(() => PipelineNodeConfigDto)`
sobre `nodes: Record<string, PipelineNodeConfigDto>`. No valida nada. En class-validator 0.15.1
(`node_modules/class-validator/cjs/validation/ValidationExecutor.js:272`) la rama `each` solo se
activa para `Array`, `Set` y `Map`:

```js
if (Array.isArray(value) || value instanceof Set || value instanceof Map) { /* itera */ }
else if (value instanceof Object) { this.execute(value, targetSchema, error.children); }
```

Un objeto plano cae a la segunda rama y valida el **mapa entero** como si fuera un único
`PipelineNodeConfigDto`; `@Type` lo empeora convirtiendo el `Record` completo en una sola instancia.
Sumado a `forbidNonWhitelisted: true`, el resultado habría sido un error `property nodo_trigger
should not exist` por cada nodo, sin llegar a validar un solo campo real.

La iteración se hace a mano en `PipelineValidatorService.validateNodes()`. No es solo un parche: al
recorrer `Object.entries(nodes)` se conserva la clave del nodo en la ruta del error
(`nodes.nodo_ia.retryPolicy.maxRetries`), que es exactamente lo que el wizard del frontend necesita
para señalar el paso culpable. Con el decorador nunca se habría tenido esa ruta.

### Por qué `onErrorStep` sí puede apuntar hacia atrás

El recorrido de detección de ciclos sigue **solo** `nextStep`. Un `onErrorStep` que vuelve a un nodo
anterior no es un defecto sino el patrón de reintento o recuperación; prohibirlo habría impedido
modelar declarativamente lo que el protocolo de resiliencia (`architecture-patterns.md` §4) ya
contempla. El grafo de `nextStep` es funcional —un sucesor como máximo por nodo—, así que basta un
recorrido lineal con un `Set` de visitados: no hace falta DFS ni componentes fuertemente conexas.

### Por qué los nodos huérfanos no invalidan el esquema

Un nodo inalcanzable desde el `entrypoint` se ignora en silencio. Un flujo en construcción puede
tener ramas todavía sin conectar, y rechazar el esquema entero por eso convertiría el validador en
un estorbo durante la edición. Lo que sí es innegociable es que el camino activo **termine**: si
`nextStep` cierra un ciclo, no hay nodo terminal y la ejecución no pararía nunca.

### Detalles de implementación

- `NodeType` es un `enum` de TypeScript y no un union type: `@IsEnum()` necesita un objeto
  disponible en runtime.
- `nextStep` / `onErrorStep` usan `@ValidateIf((_, value) => value !== null)` y no `@IsOptional()`.
  `null` es un valor legítimo (nodo terminal), `undefined` no: `@IsOptional()` habría dejado pasar
  un campo ausente. Comprobado que esto no rompe el whitelist —`ValidationExecutor.whitelist()` solo
  descarta propiedades sin metadata alguna, y estas la tienen.
- La topología se ejecuta **solo** si forma y tipos ya son válidos. Sobre un `nextStep` numérico o un
  `nodes` que no es objeto, esas comprobaciones solo añadirían ruido sobre el error real.
- `Object.hasOwn()` en lugar de `Object.prototype.hasOwnProperty.call()`: lo segundo devuelve `any` y
  disparaba `@typescript-eslint/no-unsafe-return`.
- El validador topológico es una función pura sin DI ni estado, testeable al margen de Nest.
- `db/migrations/005-tipos-nodo-fsm.sql` alinea `tipos_nodo` con el enum: `NODO_PARSER_CORREO` →
  `PARSER_PRE_IA`, `NODO_VALIDACION` → `ESCUDO_POST_IA`, `DESTINO_DRUPAL` → `DESTINO_HTTP`. Como
  `codigo` es `VARCHAR(50) UNIQUE` y no un `ENUM` de PostgreSQL, basta un `UPDATE`. **No se borra
  ninguna fila**: `nodos.id_tipo_nodo` es FK contra esta tabla, así que `TRIGGER_CRON` y
  `DESTINO_ACENS` se quedan en el catálogo aunque hoy no sean declarables en un `pipeline_schema`.

### Verificación

16 pruebas nuevas en verde (109 en total en el backend), cubriendo los 5 casos obligatorios —Notiweb
completo de 7 nodos, huérfano aceptado, ciclo rechazado, namespace duplicado, clave ≠ `nodeId`— más
`entrypoint` inexistente, punteros colgantes, `nodeType` fuera del enum, `maxRetries > 5`,
`onErrorStep` hacia atrás aceptado, propiedad desconocida, `outputNamespace` no snake_case, `version`
no SemVer, nodo que no es objeto y payload que no es JSON. `npx tsc --noEmit` sin errores,
`eslint "src/core/**/*.ts"` limpio.

La migración `005` **no se pudo aplicar** en esta sesión: el demonio de Docker exige `sudo` con
contraseña interactiva. Queda pendiente de ejecutar contra el contenedor.

### Checklist de dependencias restantes

- [ ] **Aplicar `db/migrations/005-tipos-nodo-fsm.sql`** contra `protodo_postgres` y comprobar el
      `SELECT` final (7 códigos del enum + `TRIGGER_CRON` + `DESTINO_ACENS`).
- [ ] **`FsmModule`**: `PipelineValidatorService` está `@Injectable()` pero no lo declara ningún
      módulo. Se registrará cuando exista su primer consumidor (el CRUD de flujos).
- [ ] **Entidad TypeORM `Flujo`** que mapee `flujos.configuracion_pipeline` a `PipelineSchema`, para
      invocar el validador antes de persistir.
- [ ] **`StatePayloadContext`, `INodeStrategy`, `NodeStrategyFactory`**: el resto del contrato del
      motor sigue sin implementar (`architecture-patterns.md` §2 y §3).
- [ ] **Ampliar `NodeType`** con `TRIGGER_CRON` y un destino Acens cuando se escriban sus
      estrategias; hasta entonces esas dos filas del catálogo son inalcanzables desde un pipeline.
- [ ] **`test/jest-e2e.json` sin `moduleNameMapper`**: los alias no resuelven en e2e, así que la
      suite e2e sigue rota (deuda previa, ajena a PROT-07).

---

## 2026-08-29 · Contexto inmutable, mutex de ejecución y limpieza en arranque (PROT-08) — rama `feat/fsm-payload-context`

PROT-07 dejó el contrato del grafo, pero el motor seguía sin poder ejecutar nada: faltaba la
estructura que transporta los resultados entre nodos y la fila donde se persiste el checkpoint.
Además `PipelineValidatorService` había quedado `@Injectable()` sin módulo que lo declarara — código
inalcanzable desde el contenedor de Nest.

### `structuredClone` en ambas direcciones, no *spread*

El enunciado pedía inmutabilidad estricta y la implementación de referencia de
`architecture-patterns.md` §3 la resuelve con *spread*. No basta: el *spread* copia superficialmente,
así que `context.getNamespace('ia').meta.titulo = 'otro'` alcanza el objeto interno a través del
segundo nivel y corrompe un checkpoint que quizá ya se había dado por bueno. `StatePayloadContext`
clona en profundidad la entrada de `setNamespace`, su salida, y la de `getAllContext`. Hay tres
pruebas que fuerzan exactamente esa fuga —mutando la salida en dos niveles, y mutando el objeto de
entrada *después* de haberlo escrito— para que la garantía no dependa de que nadie toque el código.

`setNamespace` además **fusiona** con el namespace existente en vez de reemplazarlo, de modo que un
nodo pueda escribir en dos tandas sin perder lo anterior.

### El mutex necesita la reconciliación, o se autobloquea

`idx_flujo_activo` es un índice único **parcial**: `UNIQUE (id_flujo) WHERE estado = 'EN_PROCESO'`.
La garantía la da PostgreSQL, no un bloqueo en memoria que se perdería al escalar a varios procesos,
y al ser parcial deja fuera los estados terminales: un flujo puede acumular todo el histórico de
ejecuciones que haga falta, pero solo una viva.

Ese diseño tiene un fallo latente que obliga a la segunda mitad del cambio. Una fila `EN_PROCESO`
afirma "hay un bucle atendiendo este flujo ahora mismo". Tras un reinicio esa afirmación es falsa:
no queda ningún bucle, pero la fila **sigue reservando el mutex** y el flujo no podría volver a
arrancar nunca. De ahí el `onModuleInit` de `FsmModule`, que las pasa a `PAUSADO` al levantar: libera
el índice y las deja donde el protocolo de resiliencia (`architecture-patterns.md` §4) espera
encontrarlas para el reintento de CU-09.

El error de esa reconciliación **no se captura** a propósito: arrancar el motor sobre un estado que
no se ha podido reconciliar es peor que no arrancar. Se registra con `Logger.warn` cuántas filas se
reconciliaron, y silencio cuando son cero.

La clase del módulo inyecta el repositorio directamente por constructor —Nest lo permite igual que en
cualquier provider— en vez de crear un servicio intermedio que hoy no tendría más responsabilidad.

### La interpolación falla en vez de callar

`getInterpolatedValue` lanza `MissingContextVariableException` ante una variable ausente o nula, en
lugar de resolverla como `''` como hace la implementación de referencia. Interpolar en silencio
publicaría en Drupal un artículo con el título vacío, y el fallo aparecería aguas abajo, lejos de su
causa. La excepción lleva el nombre de la variable culpable (`ia_result.titulo`) para que el mensaje
sea accionable.

Por el mismo motivo, un valor no escalar **no** se convierte con `String()`. El linter lo detectó
(`@typescript-eslint/no-base-to-string`) y tenía razón: un objeto mapeado por error habría acabado
como el literal `[object Object]` dentro del artículo publicado. Ahora las cadenas se insertan tal
cual y todo lo demás pasa por `JSON.stringify`, que además resuelve números y booleanos sin añadir
comillas (`42` → `42`).

### Detalles de implementación

- **`FsmExecution` mapea `ejecuciones_flujo`**, la tabla que ya existía, en vez de crear una
  `fsm_executions` paralela. `logs_nodo` y `alertas_error` tienen FK apuntándole; duplicarla habría
  dejado dos fuentes de verdad para el mismo concepto. Propiedades en inglés, columnas en español
  vía `@Column({ name })`, igual que `User` y `RefreshToken`. Es la primera entidad del proyecto con
  columnas `jsonb`.
- `ruta_archivo_log` y `fecha_fin` quedan sin mapear, como `User` no mapea `fecha_creacion`; entran
  con el protocolo de resiliencia.
- **El decorador `@Index` no crea nada** con `synchronize: false`. Es declarativo; el índice real lo
  crea la migración. Va dicho en un comentario de la entidad para que nadie lo dé por aplicado.
- `StatePayloadContext` **no** es `@Injectable()`: se instancia una por ejecución. Un provider sería
  un singleton compartido entre ejecuciones concurrentes, justo lo contrario de lo que necesita ser.
- `db/migrations/006-fsm-execution-mutex.sql` añade `INACTIVO` al tipo `enum_estado` con
  `BEFORE 'EN_PROCESO'` (orden natural del ciclo de vida), crea `retry_state` y
  `fecha_actualizacion`, normaliza `contexto_acumulado` a `NOT NULL DEFAULT '{}'` y crea el mutex.
  La cabecera avisa de dos cosas: es **requisito de arranque** (sin ella el `onModuleInit` falla por
  la columna `fecha_actualizacion` que añade `@UpdateDateColumn` al `SET`), y **no debe envolverse en
  `BEGIN`/`COMMIT`** porque PostgreSQL prohíbe usar un valor de enum en la misma transacción en que
  se añade.
- El endpoint `POST /api/fsm/validate-schema` lleva `@PublicIp()` y **queda sin ninguna protección**:
  es el único guard global, `JwtAuthGuard` no lo es, y `RedLocalMiddleware` solo cubre las rutas de
  Swagger. Es temporal y para Postman; va marcado con `TODO(PROT-08)` en el propio controlador.
  Mitigación mientras tanto: no lee ni escribe en base de datos, solo valida un JSON en memoria.
- Comprobado que el `ValidationPipe` global no interfiere con `@Body() rawJson: unknown`: `unknown`
  emite `Object` como metatipo y `ValidationPipe.toValidate()` descarta ese tipo
  (`validation.pipe.js:119`), así que el cuerpo llega intacto — imprescindible, porque el servicio
  necesita ver las propiedades no declaradas para rechazarlas.

### Verificación

17 pruebas nuevas en verde (126 en total en el backend), cubriendo los 3 casos obligatorios —copias
profundas, aislamiento entre namespaces, interpolación múltiple y excepción ante nulos— más fusión
sin pérdida, clonado del objeto de entrada, `getAllContext`, namespace ausente, cursor e
identificadores, espacios dentro de las llaves, plantilla sin variables, namespace inexistente,
`null` explícito, el nombre de la variable en la excepción, y la serialización de números, booleanos
y objetos. `npx tsc --noEmit` sin errores, `npm run lint` limpio (queda el warning preexistente de
`main.ts:59`, ajeno a este cambio), `nest build` correcto.

**Sin verificación contra la base de datos**: las migraciones las aplica el usuario. Ni el mutex ni
la reconciliación de arranque se han ejercitado todavía contra PostgreSQL.

### Checklist de dependencias restantes

- [ ] **Aplicar `db/migrations/005-tipos-nodo-fsm.sql` y `006-fsm-execution-mutex.sql`**. La 006 es
      requisito de arranque: sin ella el backend no levanta.
- [ ] **Verificar el mutex** con dos `INSERT` `EN_PROCESO` del mismo `id_flujo` (debe violar
      `idx_flujo_activo`) y la reconciliación reiniciando el backend con una fila viva.
- [ ] **Proteger o retirar `POST /api/fsm/validate-schema`** antes de cualquier despliegue: quitar
      `@PublicIp()` y añadir `@UseGuards(JwtAuthGuard, RolesGuard)`.
- [ ] **Entidad `Flujo`** que mapee `flujos.configuracion_pipeline` a `PipelineSchema` e invoque el
      validador antes de persistir.
- [ ] **`FsmEngineService`, `INodeStrategy`, `NodeStrategyFactory`**: el bucle de ejecución que
      consumirá `StatePayloadContext` y escribirá los checkpoints sigue sin implementar.
- [ ] **Servicio de dominio sobre `FsmExecution`**: la entidad se declara y se reconcilia, pero
      ninguna lógica de negocio la consulta todavía.
- [ ] **Ampliar `NodeType`** con `TRIGGER_CRON` y un destino Acens cuando se escriban sus estrategias.
- [ ] **`test/jest-e2e.json` sin `moduleNameMapper`**: los alias no resuelven en e2e (deuda previa).

---

## 2026-08-31 · Motor FSM, bucle de ejecución y factoría de estrategias (PROT-09) — rama `feat/fsm-engine`

PROT-07 definió el grafo y PROT-08 la memoria inmutable con su checkpoint, pero nada los recorría:
`StatePayloadContext` no lo consumía ningún servicio y `ejecuciones_flujo` solo se tocaba en la
reconciliación de arranque. Este cambio pone el orquestador.

### Resiliencia de dos niveles

El motor tiene dos `try` con responsabilidades distintas, y confundirlos sería el error clásico:

- **Interno (`runNode`)**: aísla el fallo de *un nodo*. Cualquier excepción no controlada de una
  estrategia —incluida `StrategyNotFoundException`— se normaliza a un `NodeResult` con nivel
  `URGENTE` en vez de propagarse. Un nodo defectuoso no puede tumbar la ejecución entera, y mucho
  menos el proceso de Node.
- **Externo**: atrapa el fallo catastrófico, típicamente que PostgreSQL deje de responder. Registra,
  intenta marcar `FALLIDO` y **re-lanza**, porque quien invocó el motor tiene que enterarse.

El intento de marcar `FALLIDO` va envuelto en su propio `try/catch`: si lo que falló fue justamente
la base de datos, ese guardado también fallará, y no debe enmascarar el error original.

### La validación previa queda fuera del `try` externo

Buscar la ejecución, comprobar que no esté ya `EN_PROCESO` y marcarla se hacen **antes** de abrir el
`try`. No es un descuido. Si marcar `EN_PROCESO` choca contra el mutex `idx_flujo_activo` —porque
otra ejecución del mismo flujo está viva—, la excepción debe propagarse **sin** marcar `FALLIDO`: no
ha fallado el flujo, simplemente no le tocaba el turno. Meterlo dentro del `try` habría convertido
una colisión de concurrencia perfectamente normal en una ejecución marcada como rota.

### Defensa en dos capas contra ciclos, y por qué los reintentos van anidados

PROT-07 permite **a propósito** que `onErrorStep` apunte hacia atrás: es el patrón de recuperación.
El precio es que `A → falla → B → A` es un esquema topológicamente válido que, con un
`while (cursor !== null)` desnudo, colgaría el worker para siempre. De ahí las dos capas:

| Capa | Mecanismo | Qué acota | Al agotarse |
|---|---|---|---|
| 1 | `@Max(5)` en `RetryPolicyDto` (ya existía, de PROT-07) | Reintentos intra-nodo, sin mover el cursor | Fallback a `onErrorStep` o `PAUSADO` |
| 2 | `MAX_TRANSITIONS = 100` | Saltos entre nodos | Log `URGENTE` + `PAUSADO` |

La decisión de diseño que las mantiene separadas: **los reintentos viven en un bucle anidado**, no en
un `continue` del bucle externo. Reintentar con `continue` habría hecho que cada reintento consumiera
presupuesto de transiciones, mezclando dos conceptos que no tienen nada que ver — un nodo con
`maxRetries: 5` habría gastado cinco saltos de grafo sin moverse del sitio. Anidándolo, el contador
cuenta saltos reales *por construcción*, sin excepciones que recordar al leer el código. Hay una
prueba dedicada a eso: tres ejecuciones del mismo nodo producen una sola transición.

### Otras decisiones que no son obvias

- **Solo `GRAVE` reintenta.** `URGENTE` es irrecuperable (contrato roto, credenciales, dato corrupto)
  y `LEVE` no justifica insistir; ambos van directos a `onErrorStep` o a `PAUSADO`. La severidad
  gobierna el control de flujo, no solo la traza.
- **El contador de reintentos no se limpia al tener éxito.** Es por ejecución, no por visita: si un
  `onErrorStep` hacia atrás devuelve el flujo a un nodo que ya agotó intentos, no vuelve a
  reintentar. Acota el trabajo total y complementa el circuit breaker.
- **`initialPayload` aterriza en el namespace reservado `trigger`**, de modo que las plantillas lo
  interpolan como `{{trigger.campo}}` con independencia de qué nodo dispare el flujo.
- **Al terminar no se escribe un `EN_PROCESO` con cursor nulo.** La primera versión persistía ese
  estado intermedio y acto seguido `EXITOSO`: dos `UPDATE` para el mismo instante lógico, y un estado
  sin significado en la tabla. Lo detectó una aserción de la prueba del flujo lineal al contar los
  checkpoints. Ahora el nodo terminal rompe el bucle y la finalización escribe `EXITOSO` directamente.
- **`checkpoint()` hace `Object.assign` sobre la entidad en memoria** además del `update`, así la
  instancia devuelta refleja el estado final sin un `findOne` extra.
- **`QueryDeepPartialEntity` no admite un `Record` con firma de índice**: intenta hacerlo parcial
  recursivamente y no cuadra con `Record<string, unknown>`. Hizo falta un cast acotado en el `update`,
  documentado en el propio archivo; es seguro porque `CheckpointPatch` solo declara columnas reales.
- **El registro de estrategias es explícito**, no por descubrimiento automático: una estrategia solo
  entra en juego si alguien la declara, lo que evita que un archivo suelto en `src/strategies/` se
  active sin querer. `NodeStrategyFactory` se exporta desde `FsmModule` para que los módulos de nodos
  registren contra la misma instancia que consume el motor.

### Verificación

18 pruebas nuevas en verde (144 en total en el backend). Cubren los casos obligatorios —flujo lineal
de 3 nodos, reintento intra-nodo sin alterar la ruta, límite del DTO, fallo con `onErrorStep`, fallo
sin fallback, aislamiento de excepción, estrategia inexistente, circuit breaker cortando en
exactamente 100 visitas, y reanudación desde el cursor persistido— más `LEVE` sin reintentar, el
backoff exponencial con temporizadores falsos, el namespace `trigger` interpolable, y las
precondiciones (`NotFoundException`, `ConflictException`) junto al fallo catastrófico.

Las pruebas usan la **factoría real** con estrategias falsas registradas, no un doble de la factoría:
así se ejercita de verdad el camino de registro y resolución, y el caso de estrategia inexistente
sale gratis con no registrar nada.

`npx tsc --noEmit` sin errores, `npm run lint` con 0 errores (queda el warning preexistente de
`main.ts:59`), `nest build` correcto.

**Sin verificación contra la base de datos**: el repositorio va mockeado y las migraciones siguen
pendientes de aplicar.

### Checklist de dependencias restantes

- [ ] **Aplicar `db/migrations/005-tipos-nodo-fsm.sql` y `006-fsm-execution-mutex.sql`**. La 006 es
      requisito de arranque: sin ella el backend no levanta.
- [ ] **Estrategias concretas** en `src/strategies/` y su registro en `NodeStrategyFactory`
      (PROT-10). Hoy la factoría arranca vacía y cualquier flujo pausaría en el primer nodo.
- [ ] **Quién invoca `executeWorkflow`**: no hay endpoint, disparador ni consumidor de cola todavía.
- [ ] **Volcado a `.log` físico con Winston** y fila en `alertas_error` ante un fallo
      (`architecture-patterns.md` §4, pasos 1 y 2). Hoy el motor solo escribe en el `Logger` de Nest.
- [ ] **Notificación WebSocket** (`node_started`, `node_completed`, `flow_finished`, `flow_failed`) a
      la sala `flow_${flowId}` (§4 paso 4 y §5).
- [ ] **Cola BullMQ**: «asíncrono» aquí es `async/await`; el bucle corre en el proceso que lo invoca
      y el backoff duerme ese hilo. Las ejecuciones pesadas deben pasar a productor-consumidor (§5).
- [ ] **Proteger o retirar `POST /api/fsm/validate-schema`**: sigue con `@PublicIp()` temporal.
- [ ] **Entidad `Flujo`** que mapee `flujos.configuracion_pipeline` a `PipelineSchema`.
- [ ] **`test/jest-e2e.json` sin `moduleNameMapper`**: los alias no resuelven en e2e (deuda previa).

---

## 2026-08-31 · Motor de interpolación funcional (PROT-10) — Épica 3 finalizada

`getInterpolatedValue` solo sabía resolver rutas de **dos segmentos**: la regex capturaba
`(nodo)\.(campo)` y hacía un acceso plano `namespaces[nodo]?.[campo]`. Basta para
`{{parsed_email.subject}}`, pero se queda corto en cuanto llegan los datos reales — un correo trae
cabeceras anidadas, el extractor devuelve arreglos de URLs y el nodo de IA responde con listas de
artículos. `{{ llm_response.articles[1].title }}` ni siquiera casaba con el patrón: se habría
quedado literal dentro del artículo publicado.

### El algoritmo: normalizar y reducir

Dos decisiones lo mantienen en veinte líneas sin `eval` ni parser de expresiones, ambos prohibidos
por `security-and-scope.md` §3:

1. **Normalizar los corchetes a puntos** (`urls[0]` → `urls.0`) antes de trocear. Así solo hay *una*
   gramática que recorrer, y como efecto secundario `{{ node.items[0].id }}` y `{{ node.items.0.id }}`
   resultan equivalentes gratis, sin código que los reconcilie.
2. **Navegar por reducción** sobre los segmentos, con tres cortes de seguridad en cada salto: clave
   bloqueada, nodo intermedio no navegable, propiedad no propia. Cualquiera de los tres devuelve
   `undefined` y el fail-safe final lo convierte en `MissingContextVariableException`.

`resolvePath` es una función **pura exportada**: no toca estado ni hace I/O, así que se prueba al
margen de la clase y podrá reutilizarla el nodo `MAPEADOR_PLANTILLA` cuando llegue.

La excepción cita siempre la ruta **literal** que escribió el autor
(`parsed_email.extracted_urls[99]`), no la normalizada. El mensaje debe mencionar lo que esa persona
puede buscar en su plantilla, no una forma interna que no reconocería.

### Las dos barreras de seguridad, y por qué ninguna sobra

Aquí está el hallazgo del ticket. El enunciado pedía una lista de bloqueo con `__proto__`,
`constructor` y `prototype`. Al añadir además `Object.hasOwn` en cada salto, comprobé por mutación
si cada guarda era portante — y la primera pasada dijo que **la lista de bloqueo era redundante**:
retirarla no rompía ninguna prueba, porque esas tres claves son heredadas y `Object.hasOwn` ya las
detenía.

Esa conclusión era incompleta. `JSON.parse('{"__proto__":{"polluted":"si"}}')` crea `__proto__` como
propiedad **propia** — no invoca el setter—, y comprobado en Node: sobrevive intacta a
`structuredClone` y al spread de `setNamespace`. Es decir, `Object.hasOwn` devuelve `true` y sin la
lista de bloqueo el interpolador leería datos controlados por el atacante. Y no es un vector
hipotético: es exactamente el camino de la respuesta del nodo de IA, que llega como texto y se
parsea.

Con la prueba 5.13 escrita para ese caso concreto, ambas guardas quedan verificadas por mutación:

| Barrera | Detiene | Prueba que falla si se retira |
|---|---|---|
| `BLOCKED_KEYS` | `__proto__` / `constructor` / `prototype` aunque sean **propias** | 5.13 (`__proto__` inyectado vía JSON) |
| `Object.hasOwn` | Todo lo **heredado** (`toString`, `valueOf`, `hasOwnProperty`) | 5.10 (propiedades heredadas no listadas) |

Sin `Object.hasOwn`, `{{ ns.dato.toString }}` devolvería una función; `JSON.stringify` de una función
es `undefined`, así que la plantilla acabaría con ese literal dentro del artículo.

Matiz sobre los índices fuera de rango: `{{ urls[99] }}` lo detiene el fail-safe final por sí solo,
no `Object.hasOwn`. La guarda no le añade nada ahí; su aportación real es la cadena heredada.

### Serialización estricta por tipo

Las ramas se escriben con `typeof` explícito en vez de un `String(value)` sobre `unknown`, que
volvería a disparar `no-base-to-string` como en PROT-08. El `bigint` acompaña a los números porque
`structuredClone` lo preserva y `JSON.stringify(1n)` lanza `TypeError`.

### Cierre del endpoint público

Se retiró el `@PublicIp()` que PROT-08 dejó marcado con `TODO(PROT-08)` en `FsmController`, aplicando
lo que el propio comentario prescribía: `@UseGuards(JwtAuthGuard, RolesGuard)` más `@ApiBearerAuth()`.
Sin `@Roles(...)`, porque `RolesGuard` deja pasar cuando no hay metadata de roles y configurar flujos
es competencia del rol EDITOR, no solo del ADMIN (`security-and-scope.md` §2). Al quitar `@PublicIp()`
la ruta vuelve además bajo el `IpWhitelistGuard` global: doble barrera, igual que `AuthController`.

### Verificación

17 pruebas nuevas en verde (161 en total en el backend). La red de seguridad real fue la
retrocompatibilidad: las 8 pruebas de interpolación de PROT-08 y las 2 del spec del motor pasaron
**sin tocar una sola línea**, lo que confirma que el patrón nuevo —que exige al menos un segmento
tras el namespace— sigue casando con `{{ns.campo}}` exactamente igual que el anterior.

`npx tsc --noEmit` sin errores, `npm run lint` con 0 errores (queda el warning preexistente de
`main.ts:59`), `nest build` correcto.

---

## Balance de cierre de la Épica 3

| Ticket | Entregado | Verificado |
|---|---|---|
| PROT-07 · Contratos y validación topológica | `PipelineSchemaDto`, `validatePipelineTopology`, `PipelineValidatorService` | 16 pruebas unitarias |
| PROT-08 · Contexto inmutable y persistencia | `StatePayloadContext`, `FsmExecution`, mutex `idx_flujo_activo`, reconciliación en arranque | 17 pruebas; **mutex y reconciliación sin ejercitar contra PostgreSQL** |
| PROT-09 · Motor y bucle de ejecución | `FsmEngineService`, `NodeStrategyFactory`, resiliencia de dos niveles, circuit breaker | 18 pruebas con repositorio mockeado |
| PROT-10 · Interpolación funcional | `resolvePath`, serialización por tipo, blindaje de prototipos | 17 pruebas, dos de ellas validadas por mutación |

**Lo que la épica NO ha demostrado todavía**, y conviene tener presente antes de darla por buena:

- **Nada se ha ejecutado contra PostgreSQL.** Las migraciones 005 y 006 siguen sin aplicar; toda la
  persistencia está verificada con dobles. El mutex, la reconciliación de arranque y los checkpoints
  no han tocado una base de datos real ni una vez.
- **El motor no tiene nada que ejecutar.** `NodeStrategyFactory` arranca vacía: cualquier flujo real
  pausaría en el primer nodo con `StrategyNotFoundException`. Las estrategias concretas son PROT-11+.
- **Nadie invoca `executeWorkflow`.** No hay endpoint, disparador ni consumidor de cola.

### Checklist de dependencias restantes

- [ ] **Aplicar `db/migrations/005-tipos-nodo-fsm.sql` y `006-fsm-execution-mutex.sql`**. La 006 es
      requisito de arranque: sin ella el backend no levanta.
- [ ] **Verificar el mutex y la reconciliación** contra la base de datos real.
- [x] **Proteger `POST /api/fsm/validate-schema`** — resuelto el 2026-08-31 en PROT-10.
- [ ] **Estrategias concretas** en `src/strategies/` y su registro en la factoría.
- [ ] **Quién invoca `executeWorkflow`**: endpoint, disparador IMAP/Cron o consumidor de cola.
- [ ] **Volcado a `.log` físico con Winston** y fila en `alertas_error` (`architecture-patterns.md` §4).
- [ ] **Notificación WebSocket** a la sala `flow_${flowId}` (§4 paso 4 y §5).
- [ ] **Cola BullMQ**: hoy el bucle corre en el proceso que lo invoca y el backoff duerme ese hilo.
- [ ] **Entidad `Flujo`** que mapee `flujos.configuracion_pipeline` a `PipelineSchema`.
- [ ] **`test/jest-e2e.json` sin `moduleNameMapper`**: los alias no resuelven en e2e (deuda previa).

---

## 2026-08-31 · Primera ejecución real del motor contra PostgreSQL (runner E2E) — rama `feat/fsm-e2e`

El balance de cierre de la Épica 3 dejaba una afirmación incómoda por escrito: **nada se había
ejecutado contra PostgreSQL**. 161 pruebas, todas con dobles; el repositorio mockeado; la factoría
vacía. El motor nunca había recorrido un pipeline de verdad ni escrito un checkpoint real, y el
cableado de Nest jamás se había arrancado. Esta entrada cierra esa brecha.

### El bloqueo que el enunciado no contemplaba

La FASE 2 pedía insertar la ejecución con «`id_flujo`: UUID aleatorio (`v4()`)». Eso habría fallado
en el primer intento: `ejecuciones_flujo.id_flujo` es **clave foránea a `flujos`**, y esa tabla
estaba vacía. Y `flujos.id_usuario_creador` es a su vez FK contra `usuarios`. La siembra necesita la
cadena entera: localizar un ADMIN activo → crear el flujo → crear la ejecución. Se reutiliza uno de
los tres ADMIN que ya existen en lugar de inventar usuarios de prueba, y `flujos` se inserta con SQL
directo porque todavía no tiene entidad TypeORM.

### Estrategias dummy con tipos reales, no inventados

El enunciado proponía `'DUMMY_INPUT' as any`. Se descartó: las tres dummy se registran bajo
`TRIGGER_IMAP`, `MAPEADOR_PLANTILLA` y `DESTINO_HTTP`, que son exactamente los roles que representan
y los huecos que ocuparán las estrategias definitivas. Cero casts, y una ventaja que no es cosmética:
**el esquema dummy pasa el `PipelineValidatorService`**, así que el e2e asevera de paso que sigue
siendo un pipeline legítimo según el contrato de PROT-07. Con un tipo inventado eso era imposible.

### El andamiaje no puede cablearse en un módulo

Las dummy y el runner viven en `src/` (donde los pedía el enunciado) pero se excluyen de
`tsconfig.build.json` con `**/dummies/**` y `**/scripts/**`, para que no viajen a `dist/`. Eso tiene
una consecuencia que condiciona el diseño: **si `FsmModule` los declarara en `providers`,
`nest build` fallaría**, porque el módulo referenciaría archivos que la compilación deja fuera. Por
eso no se cablean en ningún módulo; el runner y el spec los instancian con `new` y los pasan a
`NodeStrategyFactory.registerStrategy()`, que es justo el punto de extensión que PROT-09 preparó.

De ahí también que `DummyLogDispatcherStrategy` cree su `Logger` con `new` en lugar de inyectarlo:
vive fuera del contenedor, no hay inyección que resolver.

### Reparar la suite e2e costó tres pasadas

`test/jest-e2e.json` llevaba roto desde que se introdujeron los alias, y arreglarlo tuvo más aristas
de las esperadas:

1. Faltaba el `moduleNameMapper`. Al añadirlo con `<rootDir>/src/...` **seguía fallando**: `rootDir`
   es `"."` **relativo al propio archivo de configuración**, es decir `backend/test/`, no `backend/`.
   Las rutas correctas son `<rootDir>/../src/...`.
2. Después falló al resolver `otplib`, que publica fuentes TS/ESM. El jest principal ya lo
   contemplaba con `transformIgnorePatterns` y `allowJs` en el transform; hubo que replicar ambos.

Con eso, `app.e2e-spec.ts` —que estaba roto desde hacía tickets— **pasa por primera vez**.

### Resultado de la primera ejecución real

```
[NodeStrategyFactory] Estrategia registrada para el nodo "TRIGGER_IMAP".
[NodeStrategyFactory] Estrategia registrada para el nodo "MAPEADOR_PLANTILLA".
[NodeStrategyFactory] Estrategia registrada para el nodo "DESTINO_HTTP".
[RunDummyE2E] El esquema dummy supera PipelineValidatorService.
[DummyLogDispatcherStrategy] [PROTO-DO MOTOR FSM] -> Salida generada:
    Noticia: Innovacion en Madrid | remitente: prensa@unuware.com

estado = EXITOSO | paso_actual = null
namespaces = input_data, rendered_message, dispatch_result
```

La plantilla del nodo mapeador combina a propósito una ruta compuesta con índice de arreglo
(`{{ input_data.articulos[0].titulo }}`) y otra simple, de modo que la corrida certifica que el
resolutor funcional de PROT-10 opera sobre datos que ya pasaron por `structuredClone`, por el
checkpoint y por una columna `jsonb` de PostgreSQL. Que la interpolación resuelva ahí es la prueba
que ninguna suite con dobles podía dar.

### Verificación

- `npm run test:fsm:manual` — el runner completa el pipeline e imprime el checkpoint releído de la base.
- `npm run test:e2e` — **7 pruebas en verde**: 1 de `app.e2e-spec.ts` (reparada) + 6 de
  `fsm-engine.e2e-spec.ts`.
- `npm test` — **161 unitarias**, que siguen sin necesitar base de datos: la suite unitaria no quedó
  acoplada a Docker.
- `npx tsc --noEmit` sin errores, `npm run lint` con 0 errores, `nest build` correcto y **`dist/`
  verificado sin rastro** de `dummies/` ni `scripts/`.
- Comprobado en la base: dos ejecuciones persistidas (runner + e2e), ambas `EXITOSO`, `paso_actual`
  nulo y los tres namespaces en `contexto_acumulado`.

La prueba que más valor aporta es la que lee con SQL directo, al margen del mapeo de TypeORM:
comprueba lo que quedó **escrito**, no lo que el motor creía haber escrito.

### Checklist de dependencias restantes

- [x] **Aplicar las migraciones 005 y 006** — resuelto: verificadas como aplicadas el 2026-08-31.
- [x] **Verificar el motor contra PostgreSQL real** — resuelto el 2026-08-31 con el runner y el e2e.
- [x] **`test/jest-e2e.json` sin `moduleNameMapper`** — resuelto el 2026-08-31; `app.e2e-spec.ts`
      vuelve a ejecutarse.
- [ ] **Ejercitar el mutex `idx_flujo_activo` contra la base**: cada corrida crea su propio flujo, así
      que dos ejecuciones nunca colisionan. Falta una prueba que fuerce dos `EN_PROCESO` del mismo
      `id_flujo` y espere la violación de unicidad.
- [ ] **Ejercitar la reanudación y la pausa contra la base**: el e2e solo cubre el camino feliz. Falta
      un flujo que falle sin `onErrorStep`, quede `PAUSADO` y se reanude desde el cursor persistido.
- [ ] **Estrategias reales** en `src/strategies/`: las dummy son andamiaje, no implementan IMAP,
      plantillas ni publicación HTTP.
- [ ] **Quién invoca `executeWorkflow`** en producción: endpoint, disparador o consumidor de cola.
- [ ] **Volcado a `.log` con Winston** y fila en `alertas_error` (`architecture-patterns.md` §4).
- [ ] **Notificación WebSocket** a la sala `flow_${flowId}` (§4 paso 4 y §5).
- [ ] **Cola BullMQ**: el bucle sigue corriendo en el proceso que lo invoca.
- [ ] **Entidad `Flujo`**: la siembra usa SQL directo porque `flujos` aún no está mapeada.

---

## 2026-09-02 · Gestor de plantillas HTML y nodo `MAPEADOR_PLANTILLA` (PROT-11.1 / PROT-11.2) — rama `feat/html-template-mapper`

PROT-10 dejó la interpolación resuelta pero la plantilla seguía viviendo dentro del
`pipeline_schema`, en `params.template`. Cambiar un `<h1>` obligaba a editar el JSON de cada flujo
que lo usara, y dos flujos no podían compartir el mismo maquetado. Esta entrega mueve la plantilla a
`plantillas_html` y deja al nodo declarando solo `params.templateId`.

Lo que sigue son las cuatro decisiones donde el código **se separa del enunciado**, y el porqué.

### La estrategia no escribe en el contexto

El enunciado pedía que `execute()` terminase con
`context.setNamespace(outputNamespace, { compiled_markup, mapped_at })`. No se hizo.

`FsmEngineService` ya escribe `result.data` en `node.outputNamespace` en cuanto un nodo devuelve
`success: true` (`fsm-engine.service.ts`, rama `if (result.success)`). Añadir la escritura desde la
estrategia no la sustituye: la **duplica**. El payload acabaría en dos namespaces distintos —el
`params.outputNamespace` que eligiera la estrategia y el `node.outputNamespace` del esquema— y una
plantilla aguas abajo podría leer del que no toca sin que nada fallara. Además el TSDoc de
`INodeStrategy` es explícito: el contexto llega para **leerse**, y quien escribe es el motor.

La estrategia devuelve `data` y punto. El test `3.1` lo blinda comparando `getAllContext()` antes y
después: si alguien vuelve a meter un `setNamespace` aquí, la suite lo caza.

### `strict: true`, contra lo que pedía el enunciado

Handlebars con `strict: false` (lo especificado) interpola una variable ausente como cadena vacía y
sigue adelante. Eso es exactamente lo que PROT-10 decidió **no** hacer cuando
`getInterpolatedValue` pasó a lanzar `MissingContextVariableException` en vez de callar: un titular
en blanco se publicaría en Drupal sin que nadie se enterase, y el fallo aparecería lejos de su causa.

Sería incoherente que el motor fuese estricto y el nodo que consume plantillas no lo fuese. Se compila
con `strict: true` y el fallo se traduce a `NodeResult` con nivel `GRAVE`.

### El pre-chequeo de variables existe para no informar de una en una

Con `strict: true` bastaría para detener el flujo, pero Handlebars lanza en la **primera** variable
ausente. Un operador con tres variables mal cableadas tendría que arreglar, reintentar, descubrir la
siguiente, y así tres veces.

Antes de compilar se recorre `requiredVariables` con `resolvePath` —la función pura que PROT-10 ya
exportaba del contexto FSM, así que la comprobación usa exactamente la misma gramática de navegación
que la interpolación real— y se acumulan **todas** las que faltan en `missingFields`. El `try/catch`
alrededor de la compilación se queda como red: cubre el modo `rawTemplate`, donde no hay
`requiredVariables` precalculadas.

### La lista blanca valida la raíz, no dos segmentos

El regex del enunciado (`/\{\{\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\s*\}\}/g`) solo ve rutas de dos
segmentos. Pero Handlebars resuelve `{{llm_response.articles.[0].title}}` igual de bien, así que esa
ruta habría pasado sin que su namespace se comprobara nunca — el Poka-Yoke tendría un agujero del
tamaño de cualquier ruta anidada.

El patrón implementado captura la raíz y el resto por separado, a cualquier profundidad, y valida la
raíz. Las rutas se guardan normalizadas (`.[0]` → `.0`) para que `resolvePath` las navegue tal cual.

#### Y el residuo: lo que el patrón *no* reconoce

Validar lo que casa no basta. `{{titulo}}` (namespace suelto), `{{mi-var.campo}}` (guion) o un
marcador mal cerrado no casan con el patrón, así que sin más se colarían: pasarían la validación, no
figurarían en `requiredVariables` y reventarían en ejecución con Handlebars estricto.

La extracción usa el **residuo** del `replace` —el HTML con las variables válidas ya consumidas— y
rechaza cualquier `{{...}}` que sobreviva. Analizar y limpiar en la misma pasada evita mantener dos
gramáticas que podrían divergir.

### Sintaxis prohibida: el añadido que no estaba en el enunciado

`security-and-scope.md` §3 limita la transformación de datos a "sustitución determinista de
variables". Handlebars trae bastante más, y todo se rechaza **al guardar**:

| Token | Por qué se rechaza |
|---|---|
| `{{{` y `{{&` | Desactivan el escapado de HTML. Un valor del contexto (la respuesta del nodo de IA, por ejemplo) podría inyectar markup en el artículo publicado |
| `{{#` y `{{/` | Bloques y helpers: lógica dentro de la plantilla |
| `{{>` | Parciales: cargarían una plantilla externa, fuera del control del gestor |

Prohibir el triple-stash es lo que permite confiar en el escapado por defecto de `{{ }}`. El test
`1.4` de la estrategia lo comprueba de frente: un `<script>` en el contexto sale como `&lt;script&gt;`.

### Detalles de implementación

- **La tabla ya existía** en `init.sql` desde el esquema original, con `nombre VARCHAR(100)`, sin
  `descripcion`, sin `activo` y con `contenido_html`/`variables_esperadas` anulables. La migración
  `008` la alinea; `init.sql` se actualiza en paralelo para que un clonado nuevo nazca igual, como se
  hizo con `allowed_ips`.
- **`id_usuario_creador` se conserva** `NOT NULL` en vez de eliminarla. No entra por el DTO: el
  controlador la toma de `@CurrentUser()`, de modo que el cliente no puede falsificar la autoría. Es
  lo que sostiene la trazabilidad que justifica el borrado lógico.
- **`variables_esperadas` pasa a `NOT NULL DEFAULT '[]'`**: el servicio la recalcula en cada
  escritura, así que un `NULL` significaría "nunca se validó", estado que el gestor ya no permite
  alcanzar.
- **El cambio de tipo de `fecha_creacion`** (`TIMESTAMP` → `TIMESTAMPTZ`) va en su propia sentencia,
  separado del `SET DEFAULT`: combinarlos en un mismo `ALTER TABLE` obliga a PostgreSQL a recastear
  el default a medio camino del cambio de tipo.
- **El registro de la estrategia** vive en `NodesModule.onModuleInit()`, no dentro de
  `NodeStrategyFactory`. El enunciado pedía "añadir el mapeo al registro interno de la factoría",
  pero la factoría es agnóstica a propósito: registro explícito, sin descubrimiento automático, para
  que un archivo suelto no se active sin querer. `FsmModule` exporta la instancia justo para esto.
- **`DummyTemplateMapperStrategy` sigue ganando en el e2e.** `fsm-engine.e2e-spec.ts` importa
  `AppModule` (que ya registra la estrategia real) y después llama a `registerDummyStrategies`, que
  la sustituye dejando un `warn`. Es lo correcto: el runner manual no debe depender de que haya
  plantillas en la base.
- **`PUT` y no `PATCH`**, siguiendo el enunciado, aunque el resto del repo use `PATCH`.
- **El perímetro de red no necesitó nada.** El enunciado pedía `RedLocalMiddleware` sobre
  `/templates`; ese middleware solo se monta sobre las rutas de Swagger porque escapan al router de
  Nest. `/templates` ya lo cubre `IpWhitelistGuard`, registrado como `APP_GUARD` global.

### Verificación

```
npx tsc --noEmit    13 errores, todos preexistentes en allowed-ips.service.spec.ts
npm run lint        1 warning, preexistente en main.ts
npm run build       OK
npm test            18 suites, 217 pruebas (32 nuevas)
```

Las 32 pruebas nuevas se reparten en: 19 de `templates.service.spec.ts` (lista blanca, rutas
profundas, sintaxis prohibida, residuo, unicidad, borrado lógico), 12 de
`template-mapper.strategy.spec.ts` (compilación, escapado, los cinco fallos `GRAVE`, inmutabilidad
del contexto) y 1 de `nodes.module.spec.ts`, que comprueba el registro en la factoría sin arrancar
Nest ni PostgreSQL — sin ella, un cableado roto no se detectaría hasta que un flujo real reventase
con `StrategyNotFoundException`.

Los dos archivos SQL se validaron con `pglast` (el parser real de PostgreSQL, vía `libpg_query`): 11
sentencias en la migración, 29 en `init.sql`, todas correctas. La semántica sobre datos reales queda
pendiente de aplicar la migración.

### Checklist de dependencias restantes

- [ ] **Aplicar la migración 008** (`db/migrations/008-plantillas-html.sql`): la ejecuta el usuario.
      Hasta entonces, el CRUD de `/templates` fallará contra la base aunque la suite unitaria pase.
- [ ] **Entidad `Nodo` y `Flujo`**: `nodos.id_plantilla` sigue sin mapear, así que nada valida todavía
      que el `templateId` de un `params` corresponda a la plantilla enlazada en el nodo.
- [ ] **Frontend de Vista 4**: el `<q-select>` cerrado debe alimentarse de `requiredVariables`, que ya
      viaja en la respuesta de `GET /templates`.
- [ ] **Estrategias reales restantes**: IMAP, extracción web, IA y publicación HTTP siguen siendo
      dummies. `MAPEADOR_PLANTILLA` es la primera real.
- [ ] **Volcado a `.log` con Winston** y fila en `alertas_error`: los fallos `GRAVE` de este nodo aún
      no se persisten (`architecture-patterns.md` §4).

---

## 2026-09-02 · Catálogo de plantillas y tríada modular de nodos (PROT-11 · Quasar) — rama `feat/html-template-mapper`

El backend de PROT-11 quedó cerrado en el commit anterior, pero sin nada en el frontend: el catálogo
no se podía administrar y el nodo `MAPEADOR_PLANTILLA` no tenía componente de configuración. Esta
entrega cierra el ciclo, y antes fija una regla de arquitectura que no existía.

### La regla se escribió sobre un hueco, no sobre un problema

El encargo pedía "eliminar la nomenclatura secuencial acoplada (`StepN`)". Un `grep` sobre
`frontend/src` no encontró **ningún** archivo `Step`, ni un `q-stepper`, ni un wizard: las únicas
menciones a "Wizard" estaban en el propio `.md` de reglas. No había nada que renombrar.

Eso cambia la naturaleza del trabajo pero no su valor: la regla es **preventiva**. El razonamiento
que se dejó escrito es el que importa — el orden de un nodo es un dato del `pipeline_schema`, no una
propiedad del componente. Con `Step1.vue`…`Step5.vue`, reordenar un flujo obligaría a renombrar
archivos, y un mismo nodo no podría reutilizarse en dos flujos que lo colocan en posiciones
distintas. El nombre describe el tipo funcional: `TemplateMapperConfig.vue`.

### `tipo_nodo` no existe en el JSON

El encargo pedía resolver los componentes "según la propiedad `tipo_nodo` del schema JSON". No hay
tal propiedad: `PipelineNodeConfigDto` usa **`nodeType`**, y `tipo_nodo` es el nombre de la columna
SQL de la tabla `nodos`. Escribir la regla con el nombre de la columna habría enviado a quien
implemente el siguiente nodo a buscar un campo que no está, además de contradecir
`code-conventions.md` §1 (identificadores en inglés). La regla dice `nodeType`.

### El registro, y por qué no un `v-if`

```typescript
export const nodeConfigRegistry: Partial<Record<NodeType, Component>> = {
  [NodeType.MAPEADOR_PLANTILLA]: defineAsyncComponent(
    () => import('@components/nodes/TemplateMapperConfig.vue'),
  ),
};
```

Encadenar `v-if="node.nodeType === 'MAPEADOR_PLANTILLA'"` en el anfitrión funcionaría hoy, con un
solo nodo. Con siete, cada tipo nuevo obliga a editar el anfitrión — que es exactamente el
acoplamiento que la tríada quiere evitar, solo que movido de los nombres de archivo a una plantilla.
El registro deja el anfitrión cerrado a modificación.

`Partial` es deliberado: los seis tipos sin implementar simplemente no están, y el anfitrión debe
contemplar el `undefined`. Cuando existan los siete, retirar el `Partial` hará que el compilador
exija cobertura total, sin que nadie tenga que acordarse.

El build confirma que la carga diferida hace su trabajo: `TemplateMapperConfig-ChsWNX52.js` sale como
chunk propio, así que un flujo que use dos nodos no descarga los siete.

### La vista previa vive en el backend, y esa es la decisión de fondo

El encargo pedía que el servicio del nodo "probara compilación de payloads simulados", pero el
backend no tenía endpoint de previsualización. Había tres salidas y dos eran malas:

- Compilar en el navegador añadiendo `handlebars` al frontend: dos motores, y cualquier divergencia
  futura (modo estricto, sintaxis prohibida) daría una vista previa que **miente** sobre lo que se va
  a publicar. Es justo el fallo que PROT-11.1 se propuso evitar validando al guardar.
- Pintar el HTML crudo sin interpolar: no verifica que la plantilla compile de verdad.
- Añadir `POST /templates/:id/preview`. Más trabajo, pero una sola fuente de verdad.

Se eligió la tercera, y para sostenerla se extrajo `TemplateRendererService`: la lógica de Handlebars
sale de `TemplateMapperStrategy` y pasa a un servicio con **dos consumidores** —la estrategia en
tiempo de ejecución y el endpoint del gestor—, cada uno traduciendo el mismo `RenderOutcome` a su
propio contrato (`NodeResult` o respuesta HTTP). El renderer no conoce a ninguno de los dos.

#### Marcadores autogenerados

El endpoint construye el contexto a partir de `requiredVariables`, poniendo `«parsed_email.clean_title»`
donde irá el titular, y fusiona encima el `samplePayload` que envíe el cliente. Así la vista previa
**nunca falla por falta de datos**: el editor abre el diálogo y ve la maqueta al instante, y donde
aporte valores reales se ven esos. Las comillas angulares se eligieron porque no aparecen en texto
corriente y sobreviven al escapado de Handlebars sin convertirse en entidades.

### El refactor del constructor y las pruebas que casi se vuelven mentira

Extraer el renderer cambió la firma de `TemplateMapperStrategy` de uno a dos parámetros, lo que rompe
la instanciación de las 12 pruebas existentes. Lo evidente era mockear el renderer en todas.

No se hizo, porque cuatro de esas pruebas —`1.1` interpolación, `1.3` ruta con índice, `1.4` escapado
de `<script>`, `2.5` variable ausente— dejarían de ejercitar Handlebars y pasarían a comprobar que un
doble devuelve lo que se le dijo. Habrían seguido en verde sin verificar nada, y precisamente la
cobertura perdida es la que impide que la vista previa mienta.

La suite quedó partida en dos:

| Bloque | Renderer | Qué prueba |
|---|---|---|
| 1–3 (las 12 originales) | **Real** | Compilación, escapado, rutas anidadas, fallos `GRAVE`, inmutabilidad |
| 4 (nuevo, 6 pruebas) | **Mockeado** | Que se invoca `renderStrict(html, requiredVariables, namespaces)` y que las 3 variantes de `RenderOutcome` se traducen a su `NodeResult` |

El renderer real es puro —sin repositorio, red ni estado—, así que usarlo no introduce I/O ni acopla
la prueba a nada externo. `buildStrategy` lo instancia por defecto y admite el doble por parámetro.

### `iframe sandbox` y no `v-html`

El contenido de una plantilla es markup arbitrario escrito por un editor. Un `v-html` ejecutaría
cualquier `<script>` que contenga, en el mismo origen que la sesión y con el JWT en `localStorage` al
alcance. El `<iframe sandbox="">` sin ningún token `allow-*` desactiva scripts, formularios y
navegación por completo.

Es una barrera **independiente** del escapado de Handlebars, y ninguna sobra: el escapado protege de
los valores del contexto (la respuesta del nodo de IA), el sandbox protege del HTML de la propia
plantilla. Hacen falta las dos porque el vector es distinto.

### Detalles de implementación

- **Convención de nombres de store.** El encargo pedía `useTemplatesStore.ts` y
  `nodes/useTemplateMapperStore.ts`. Se mantuvo `<dominio>.store.ts` (`templates.store.ts`,
  `nodes/template-mapper.store.ts`), que es lo que usan los cinco stores existentes; adoptar el otro
  estilo habría dejado el proyecto con dos convenciones de nombre de archivo conviviendo.
- **`nativeEl`, no el ref del componente.** El primer intento de insertar el chip de namespace en el
  cursor leía `selectionStart` del ref de la `QInput`, que apunta al **componente** y no al
  `<textarea>`. Habría pasado el typecheck y fallado en silencio en tiempo de ejecución; se corrigió
  a `htmlInput.value?.nativeEl`. La recolocación del caret va dentro de `nextTick` porque antes del
  repintado el textarea aún contiene el texto viejo.
- **Las llaves no pueden vivir en la plantilla.** `<span>{{ '{{#if}}' }}</span>` rompe el compilador
  de Vue (`vue/no-parsing-error`): no distingue unas llaves literales de una interpolación anidada.
  Los ejemplos con llaves se declararon como constantes en el `<script setup>`.
- **`/templates` no lleva `requiresAdmin`.** A diferencia de `/users` y `/ip-whitelist`, el
  `TemplatesController` admite `@Roles(ADMIN, EDITOR)`: configurar plantillas es operación de flujos,
  no gestión de cuentas. La ruta espeja al backend.
- **Se reutilizó `SafeDeleteModal`** tal cual: ya implementaba la cuenta regresiva de 5 segundos, no
  se reimplementó nada.
- **`PUT` y no `PATCH`** en `updateTemplate`, porque es lo que expone el controlador — a diferencia
  de `/users` y `/allowed-ips`.
- **Banco de pruebas en lugar de wizard.** Como Vista 3+4 no existe, `NodeConfigSandboxPage.vue`
  reproduce lo único que el asistente hará con un configurador: resolverlo por `nodeType` desde el
  registro y leer `isConfigValid`. Sin él, `TemplateMapperConfig.vue` compilaría y tiparía pero no se
  podría ver funcionando hasta PROT-12.

### Verificación

```
Backend
  npm test          19 suites, 239 pruebas (antes 217; +22)
  npx tsc --noEmit  13 errores, todos preexistentes en allowed-ips.service.spec.ts
  npm run lint      1 warning, preexistente en main.ts
  npm run build     OK

Frontend
  npm run typecheck  vue-tsc --noEmit, limpio
  npm run lint       limpio
  npm run build      OK — TemplateMapperConfig sale en su propio chunk
```

Las 22 pruebas nuevas del backend: 6 de delegación en la estrategia, 7 de previsualización en
`templates.service.spec.ts` (marcadores autogenerados, override por `samplePayload`, ruta profunda,
escapado, plantilla desactivada, `404`, `400` por HTML que no compila) y 9 del
`template-renderer.service.spec.ts` aislado.

### Checklist de dependencias restantes

- [ ] **Asistente de flujos (Vista 3+4, PROT-12)**: el banco de pruebas es andamiaje. Falta el
      `<q-stepper>` real, `useFlujoDraftStore` como agregador y la topología del pipeline.
- [ ] **Los otros seis configuradores de nodo**: solo `MAPEADOR_PLANTILLA` está en el registro.
      Al completarlos, retirar el `Partial` de `nodeConfigRegistry`.
- [ ] **Sin pruebas en el frontend**: no hay runner instalado (ni vitest ni jest). `isConfigValid` y
      la inserción de chips en el cursor son lógica que merece prueba unitaria.
- [ ] **`samplePayload` real en la vista previa**: hoy siempre se envía vacío y se ven marcadores.
      Podría alimentarse del último `contexto_acumulado` de una ejecución del flujo.
- [ ] **Ocultar entradas del drawer por rol**: `/users` y `/ip-whitelist` se muestran a un EDITOR
      aunque la guarda de ruta los bloquee. No es nuevo de esta entrega, pero se hace más visible al
      añadir rutas con roles distintos.

---

## 2026-09-02 · Editor CodeMirror 6, split view y borrador en Pinia — rama `feat/html-template-mapper`

El diálogo de plantillas entregado esta mañana era un modal de 620px con un `<q-textarea>` plano. Se
podía escribir HTML, pero sin resaltado, sin números de línea y sin ninguna señal de qué era un
marcador y qué era texto: el autor descubría el error cuando el backend devolvía un `400`. Este
refactor separa las tres responsabilidades que el componente concentraba y hace el error **visible
mientras se escribe**.

### CodeMirror manda sobre el cursor, no el store

El encargo especificaba dos caminos de inserción a la vez: `store.insertMarker(ns)`, que empalma
strings sobre un `cursorPosition` guardado en Pinia, y `codeEditorRef.insertTextAtCursor(...)`, que
despacha una transacción sobre el `EditorView`. Ejecutar ambos inserta `{{ns.}}` **dos veces**.

Y no es solo eso: si el store fuese el dueño, cada inserción reemplazaría el documento entero por una
cadena nueva, CodeMirror lo recibiría por prop y el cursor se iría al principio. El punto de control
del propio encargo pedía lo contrario — "inserción atómica sin pérdida de foco".

Gobierna CodeMirror. El chip despacha la transacción; el `update:modelValue` sincroniza el store
después. `insertMarker` sobrevive como red por si el editor aún no ha resuelto su carga diferida, y
`cursorPosition` queda como espejo que alimenta ese fallback. El TSDoc de ambos lo dice, para que
nadie los tome por la ruta principal.

Que la inserción sea **una sola transacción** —texto y selección en el mismo `dispatch`— es lo que
hace que `Ctrl+Z` la deshaga entera en vez de dejar el caret descolocado.

### La guarda contra el bucle de eco

El `v-model` entre un componente Vue y un editor imperativo tiene una trampa clásica:

```
tecla → docChanged → emit → store → prop → watch → dispatch → docChanged → …
```

Sin cortar ese ciclo, cada pulsación reemplaza el documento completo y el cursor salta. El `watch`
compara antes de despachar:

```ts
if (!view || view.state.doc.toString() === value) return;   // el cambio vino de aqui
```

Tres caracteres de comparación que son la diferencia entre un editor usable y uno que se pelea con
quien escribe.

### Un solo `HighlightStyle` para los dos modos

`defaultHighlightStyle` de CodeMirror está pensado para fondo claro y sería ilegible en oscuro, que
es el modo por defecto del proyecto. La salida habitual es mantener dos temas y conmutarlos con un
`Compartment` observando `$q.dark`.

No hizo falta: el tema y el resaltado se construyen sobre custom properties `--pd-*`, que ya conmutan
solas con `body--dark`. Un único `EditorView.theme()` y un único `HighlightStyle` sirven para ambos
modos, sin reconfigurar extensiones ni observar el store de tema.

Los dos colores que el encargo pedía inline (`rgba(91,140,232,.15)` y `.25`) se añadieron antes como
tokens `--pd-accent-soft` y `--pd-accent-selection`: `app.scss` declara que la lista `--pd-*` es
cerrada y que todo color nuevo entra primero como token.

### `:deep()` no es opcional aquí

CodeMirror construye su DOM de forma imperativa, sin el atributo de scope que Vue añade a lo que él
renderiza. Un `.cm-pd-template-marker` en `<style scoped>` normal **no alcanzaría** a esos nodos. El
contenedor sí es un elemento de Vue, así que `:deep()` desde el componente hijo funciona.

### `min-height: 0`, el detalle que decide si el modal funciona

El split view es una cadena de contenedores flex: card → form → row → columna → editor. Un ítem flex
tiene `min-height: auto` por defecto y **se niega a encogerse por debajo de su contenido**, así que
sin `min-height: 0` en cada eslabón el editor empuja el modal más allá del `85vh` en vez de hacer
scroll interno. Es exactamente el desbordamiento que el punto 2 de la verificación manual buscaba.

### `vue-codemirror` no entró

El encargo lo pedía, pero el wrapper obliga igualmente a sacar el `EditorView` del payload de su
evento `@ready` para poder despachar transacciones — y con `no-unsafe-assignment` como *error* en el
lint, ese payload hay que tiparlo a mano. A cambio de dos dependencias (`vue-codemirror` más el
metapaquete `codemirror`, que declara como peer y faltaba en la lista), ahorraba unas 35 líneas de
`onMounted`/`onBeforeUnmount`. Se montó el `EditorView` directamente.

La lista de paquetes sí se corrigió por lo contrario: faltaban tres. `@codemirror/language` (sin él
el HTML se parsea pero **no se colorea**), `@codemirror/commands` (sin él no hay deshacer/rehacer, lo
que dejaría el editor por debajo de un `<textarea>`) y `@lezer/highlight` para los `tags`.

### Detalles de implementación

- **El `EditorView` no vive en un `ref`.** Envolver una instancia imperativa con estado interno en un
  proxy reactivo de Vue es una fuente conocida de rarezas, y aquí no se necesita reactividad sobre
  ella: es una variable del `setup`.
- **Carga diferida.** El diálogo monta `TemplateCodeEditor` con `defineAsyncComponent`. El build lo
  confirma: `TemplateCodeEditor-DPHlm0aB.js` pesa 451 KB y **no aparece** en el chunk principal
  (167 KB), que es lo que importa porque el diálogo lo importan dos componentes distintos.
- **El regex se alineó con el del backend**, índice `.[0]` incluido. Con el del encargo,
  `{{llm_response.articles.[0].title}}` no habría salido en los chips aunque el backend sí la
  registra en `requiredVariables`: los chips habrían mentido.
- **`detectedVariables` detecta la forma, no la validez.** `{{contacto.telefono}}` se resalta y se
  lista, y aun así el backend lo rechaza. Duplicar aquí la lista blanca crearía una segunda autoridad
  sobre qué namespaces existen; hay una sola, y está en el backend.
- **`exactOptionalPropertyTypes` en `initDraft`**: la entidad trae `description: string | null` y el
  borrador la quiere `string | undefined`. No se puede asignar `undefined`: hay que **omitir la
  clave**, con el mismo spread condicional que ya usaba `onSubmit`. Hay un test que lo fija
  (`'description' in draft === false`), porque es el tipo de cosa que un refactor rompe en silencio.
- **`.pd-btn-secondary` unificó cinco duplicados.** No existía; cinco diálogos repetían una
  `.pd-btn-cancel` local idéntica. Se creó como utilidad global, se añadió a la tabla §2 de las
  reglas y se migraron los cinco.
- **Un solo borrador por aplicación.** `activeDraft` es un singleton: dos `TemplateEditorDialog`
  montados a la vez compartirían buffer. No es un problema real porque los `<q-dialog>` son modales y
  solo uno está abierto, e `initDraft` se llama al abrir — pero queda escrito en el TSDoc para que
  nadie construya encima la suposición contraria.

### Primer runner de pruebas del frontend

Hasta ahora no había ninguno. El refactor movía a Pinia lógica pura que antes no existía —el regex de
detección y la aritmética del offset del caret— y eso pedía red. Vitest 4 (declara `vite ^8.0.0`;
instalado 8.2.2), con `vitest.config.ts` propio porque Vitest no lee los alias de `quasar.config.ts`.

Los helpers se importan explícitamente en vez de activar `globals: true`: eso exigiría añadir
`vitest/globals` a los `types` de `.quasar/tsconfig.json`, que es un archivo **generado** por
`quasar prepare` y se perdería en el siguiente `postinstall`.

`src/stores/templates.store.spec.ts`, 19 casos sin DOM ni red (`vi.mock` sobre el servicio evita
cargar `@boot/axios`): `initDraft` con `description: null`, los cuatro casos de `isDraftValid`, siete
de `detectedVariables` (dedupe, rutas profundas, índice, namespace suelto, recálculo tras cambio) y
cuatro de `insertMarker` (posición, offset del caret, cursor desfasado y acotado).

### Verificación

```
npm run typecheck   vue-tsc --noEmit, limpio
npm run lint:check  limpio (exit 0)
npm test            1 archivo, 19 pruebas
npm run build       OK — CodeMirror aislado en su propio chunk, ausente del index
```

### Checklist de dependencias restantes

- [x] **Sin pruebas en el frontend** — resuelto parcialmente: Vitest instalado y `templates.store.ts`
      cubierto. Faltan las de componente (`@vue/test-utils` + `happy-dom` cuando haga falta).
- [ ] **`TemplateCodeEditor` sin pruebas**: la guarda del bucle de eco y el offset de
      `insertTextAtCursor` solo se verifican a mano. Necesitan entorno DOM.
- [ ] **Autocompletado de campos tras el punto**: al insertar `{{parsed_email.}}` el editor podría
      ofrecer los campos conocidos del namespace, pero el backend no expone hoy ese catálogo.
- [ ] **Resaltar en rojo los namespaces fuera de la lista blanca**: el decorador valida la forma. Con
      `TEMPLATE_NAMESPACES` ya en el frontend, distinguir válido de inválido dentro del editor es
      barato y adelantaría el `400` al momento de teclear.
- [ ] **Asistente de flujos (PROT-12)** y los otros seis configuradores de nodo, sin cambios.

---

## 2026-09-03 · Blindaje XSS, filtro de tablas y contrato de namespaces — rama `feat/html-template-mapper`

Tres carencias con el mismo patrón de fondo: **el sistema no avisa hasta que ya es tarde**. Las
tablas no se podían filtrar, el markup de una plantilla llegaba crudo a Drupal, y el nodo mapeador se
declaraba válido con un contrato que se sabía roto.

### Las dos barreras XSS cubren cosas distintas

Ya existían dos protecciones y ninguna cubría el hueco real:

- El **escapado `{{ }}` de Handlebars** protege de los *valores* del contexto — la respuesta del nodo
  de IA, por ejemplo. No toca el HTML que el editor escribió en la plantilla.
- El **`<iframe sandbox>`** de la vista previa protege al *operador de Proto-Do*. Al lector del
  artículo publicado en Drupal no lo protege nadie: ahí no hay iframe.

El hueco era el cuerpo de la plantilla. Un `<script>`, un `onerror=` o un `href="javascript:"`
escritos ahí se compilaban tal cual. `sanitize-html` llevaba instalado desde el principio, sin usar.

### Lo que el enunciado daba por hecho y no era cierto

`disallowedTagsMode: 'discard'` supuestamente elimina "la etiqueta y su contenido" para `script`,
`style` e `iframe`. Ejecutando la configuración propuesta antes de escribirla:

```
script -> "<p>ok</p>"                    purgado con su contenido
iframe -> "contenido interno<p>ok</p>"   la etiqueta se fue, el TEXTO se quedó
```

`discard` solo borra el contenido de las etiquetas listadas en `nonTextTags`, y `iframe` no está en
esa lista. Sin corregirlo, el texto interno de un `<iframe>` acabaría suelto en el artículo.

#### Y el detalle que casi abre un agujero

Declarar `nonTextTags` **sustituye** la lista por defecto, no la amplía. Escribir `['iframe']` a
secas habría eliminado `script`, `style`, `textarea`, `option` y `xmp` de la protección. El propio
código de la librería avisa sobre el último:

> `xmp` is included because htmlparser2 treats it as a raw-text element, so markup inside is parsed
> as text on input but would otherwise be re-emitted unescaped, allowing XSS bypass.

La configuración declara los seis. El comentario en el código explica por qué no se puede acortar.

### Detectar al guardar: dos pasadas del mismo parser

Sanear en silencio deja al autor sin enterarse. Todo el gestor hace lo contrario —los namespaces se
rechazan al guardar con un 400 que cita la variable—, así que el saneado debía comportarse igual.

El problema: `sanitize-html` no informa de lo que elimina, y comparar su salida contra el HTML crudo
daría falsos positivos constantes, porque el parser normaliza aunque no filtre (`<br>` → `<br />`,
comillas, orden de atributos). La comparación válida es entre **dos pasadas del mismo parser**, una
con lista blanca y otra sin ella: lo que difiera lo quitó el filtro, no el formateo.

Y una trampa que solo apareció al probarlo: la primera versión **rechazaba un `<a target="_blank">`
legítimo**. La pasada estricta le *añade* `rel="noopener noreferrer"` vía `transformTags` y la
permisiva no, así que las salidas diferían por una **adición**. La sonda aplica ahora la misma
transformación; el `forceSafeLinkRel` está extraído a una constante precisamente para que no puedan
divergir.

### Una aserción que medía lo que no era

La prueba de que el escapado y el saneado se suman en vez de anularse empezó siendo
`expect(markup).not.toContain('onerror=')`. Falló, y por una razón instructiva: Handlebars escapa el
`=` como `&#x3D;`, pero `sanitize-html` lo re-serializa como `=` al normalizar entidades. El texto
literal `onerror=` **sí** aparece en la salida.

Y es inofensivo: está dentro de un nodo de texto, con el `<` como `&lt;`, así que el navegador nunca
construye la etiqueta. La aserción correcta es sobre la salida completa, no sobre una subcadena. Es
un buen recordatorio de que en seguridad la prueba tiene que medir la propiedad real —"no se forma un
elemento"— y no un proxy textual de ella.

### Jest no podía cargar sanitize-html

Añadir el import rompió las cuatro suites que lo alcanzaban:

```
node_modules/sanitize-html/node_modules/htmlparser2/dist/index.js:1
import { Parser } from "./Parser.js";
SyntaxError: Cannot use import statement outside a module
```

`htmlparser2@12` es ESM puro y **no publica build CJS**. Node 22+ lo requiere sin problema —de ahí
que la app funcione— pero el pipeline CommonJS de Jest no. La salida es dejar que ts-jest transforme
esa cadena, y el repo ya tenía el precedente con `@scure`/`@noble`.

El primer intento no funcionó: el lookahead `/node_modules/(?!htmlparser2/…)` se evalúa justo tras el
**primer** `/node_modules/`, y `htmlparser2` vive en el anidado de `sanitize-html`. Hacía falta el
prefijo `.*`, que es justo por lo que la excepción existente estaba escrita así.

### Contrato de namespaces: el fallo se adelanta a la configuración

`isConfigValid` gana una tercera condición: `missingRequiredVariables.length === 0`. Si la plantilla
interpola `{{scraped_web.headline}}` y ningún nodo previo escribe `scraped_web`, antes se podía
avanzar y el fallo aparecía en ejecución, como un `GRAVE` con `missingFields` y el flujo `PAUSADO`.

Se valida la **raíz** de la ruta, no la ruta entera: lo que un nodo previo produce es el namespace
completo, así que `llm_response.articles.0.title` se satisface con que alguien escriba
`llm_response`. El banner nombra namespaces y no rutas por la misma razón — lo que hay que añadir al
flujo es un nodo, no un campo.

`availableUpstreamNamespaces` es un mock y el TSDoc lo dice: la fuente real son los `outputNamespace`
de los nodos anteriores, que el asistente inyectará. El banco de pruebas lo suple con checkboxes, que
es la única forma hoy de ver `isConfigValid` conmutar en vivo.

### Detalles de implementación

- **`ip-whitelist/IpWhitelistManager.vue` no existe.** El componente es
  `allowed-ips/AllowedIpsManager.vue`; solo la *página* se llama `IpWhitelistPage.vue`.
- **`color="grey-5"` no entró.** El proyecto está 100 % limpio de `grey-N` y `frontend-quasar.md` §2
  lo prohíbe; el icono toma el color de `--pd-text-secondary` desde `.pd-search-input`.
- **El ref del filtro se tipa `string | null`.** El botón `clearable` de QInput escribe `null`, y
  QTable declara su prop `filter` como `any`: el compilador no habría delatado la mentira.
- **Los botones de crear no se movieron** al slot de la tabla: los tres gestores conservan su
  anatomía y el CTA su prominencia. Solo el buscador va en `#top-right`.
- **`allowedTags` se amplió** con `figure`, `figcaption`, `code`, `pre`, `caption`, `tfoot`, `sub`,
  `sup`, `small` y `time`. Todas semánticas y sin capacidad de ejecución; una imagen con pie de foto
  es markup normal en una noticia y con la lista original se habría perdido.

### Verificación

```
Backend
  npm test          19 suites, 260 pruebas (antes 239; +21)
  npx tsc --noEmit  13 errores, todos preexistentes en allowed-ips.service.spec.ts
  npm run lint      1 warning, preexistente en main.ts
  npm run build     OK

Frontend
  npm run typecheck  limpio
  npm run lint:check limpio
  npm test           2 archivos, 30 pruebas (antes 19; +11)
  npm run build      OK
```

### Checklist de dependencias restantes

- [ ] **Plantillas anteriores a este cambio** pueden contener markup no publicable: se sanea al
      compilar, pero solo se rechaza al volver a guardarlas. Una consulta que las liste ayudaría.
- [ ] **`allowedStyles` sin restringir**: el atributo `style` pasa con cualquier valor. Los vectores
      clásicos (`expression()`, `url(javascript:)`) los bloquean los navegadores modernos, pero
      acotar las propiedades permitidas cerraría el asunto del todo.
- [ ] **El filtro es cliente**: con miles de filas habrá que pasar a paginación de servidor
      (`@request` de QTable). Hoy las tres tablas caben en memoria de sobra.
- [ ] **`availableUpstreamNamespaces` sigue siendo un mock** hasta que exista el asistente (PROT-12).
- [ ] **`loadPreview` y `previewResult` del store del nodo son código muerto**: nadie los consume,
      porque `TemplateMapperConfig` pasa `selectedTemplate` directo al diálogo de vista previa.

---

## 2026-09-03 · Diagnóstico visual del marcado rechazado — rama `feat/html-template-mapper`

Desde el cambio anterior, guardar una plantilla con `<script>` devolvía un 400 y no persistía nada.
El autor se enteraba, pero no sabía **dónde**: un `$q.notify` con un párrafo genérico y un editor sin
marcar. En una plantilla de ochenta líneas eso es una búsqueda a ojo.

Ahora el backend dice qué construcción sobra y el editor la subraya en rojo, con marcador en el
gutter y tooltip, limpiándose sola al corregir.

### El caso de aceptación era, literalmente, el que no funcionaba

La receta prescribía `cheerio.load(html, null, false)` y, como comprobación manual, escribir
`<body><p>Hola</p></body>` y confirmar el subrayado. Ejecutando lo primero antes de escribir nada:

```
cheerio.load('<body> <p>Hola</p> </body>', null, false)  ->  p
cheerio.load('<p>ok</p><script>x</script>', null, true)  ->  html head body p script
```

Con `isDocument: false`, parse5 parsea en **modo fragmento** y descarta `<body>`, `<html>` y `<head>`
por ser inválidos en ese contexto: el recorrido nunca los ve, y la infracción se vuelve
indetectable. Con `isDocument: true` ocurre lo contrario — parse5 **sintetiza** los tres en cualquier
entrada, así que el 100 % de las plantillas quedarían marcadas. Ninguno de los dos modos sirve.

La salida es cambiar de parser a htmlparser2, con la opción pública `{ xml: { xmlMode: false } }`.
Como **objeto** y no `xml: true`: basta con que sea truthy para elegir htmlparser2, pero `true`
activa además el modo XML, que es sensible a mayúsculas y dejaría `<BODY>` como `BODY` — fuera de la
lista blanca, y con el target del subrayado en mayúsculas.

El beneficio de segundo orden acabó pesando más que el arreglo: htmlparser2 es el parser que ya usa
`sanitize-html`. Auditor y saneador ven ahora **un único DOM**. Con parse5 verían dos, y el auditor
podría aprobar algo que el saneador recorta, o al revés.

### La detección ya existía; lo que faltaba era la localización

Fácil de confundir: el 400 por `<body>` no es nuevo. La sonda de dos pasadas del cambio anterior ya
lo rechazaba, junto con `<section>` y `srcset`.

Eso descartó la idea de sustituir la sonda por la auditoría. Las reglas propuestas —etiqueta, `on*`,
protocolo— **no cubren `srcset`** ni ningún otro atributo fuera de la lista blanca, así que cambiar
una por otra habría sido una regresión de cobertura disfrazada de mejora. La sonda se queda como
**puerta** (compara el saneador entero, es exhaustiva por construcción) y la auditoría entra como
**localizador** que solo enriquece la excepción.

### Una segunda lista blanca es una lista blanca que va a divergir

La receta pedía declarar una constante `ALLOWED_TAGS` nueva. `TEMPLATE_SANITIZER_CONFIG.allowedTags`
ya estaba en el mismo archivo. Con dos listas, añadir `section` al saneador dejaría al auditor
marcándolo para siempre y el autor recibiría un 400 por algo que en realidad se publica sin problema.

La auditoría deriva sus tres conjuntos de la config del saneador. Contrastar ambas sobre dieciséis
casos —hay una prueba que lo hace, la 6.12— confirmó que coinciden, incluidos los que las reglas
originales dejaban fuera.

### El servicio puro sigue sin lanzar

La receta situaba el `throw new BadRequestException` dentro de `TemplateRendererService`. Ese
servicio devuelve uniones discriminadas precisamente para que cada consumidor construya su respuesta,
y uno de ellos es `TemplateMapperStrategy`, que no habla HTTP: acoplarlo al transporte lo habría
roto.

`auditPublishableMarkup` devuelve `TemplateViolation[]` y no lanza. Quien lanza sigue siendo
`TemplatesService.assertPublishableMarkup`, que ya existía y ya estaba invocado desde `create` y
`update` — **cero puntos de llamada nuevos**.

### El `target` tiene dos formas, y hay que decir cuál es cuál

Al ampliar el alcance a las variables aparecieron tres emisores más, y sus targets no se parecen a
los del markup. `invalidVariable` guarda `bad_ns.titulo`: sin llaves y con la ruta ya normalizada.
Buscar eso en el documento fallaría cuando el autor escribiese `{{ bad_ns.titulo }}` con espacios, o
`{{ llm_response.articles.[0].title }}`.

De ahí la invariante que documenta el propio tipo:

- `tag`, `attribute`, `protocol` → identificador **normalizado en minúsculas**; el editor lo busca
  con un patrón estructural insensible a mayúsculas.
- `variable` → subcadena **verbatim** del documento; búsqueda literal.

El emisor de las variables pasa el match completo del regex, que hasta ahora se descartaba como
`_match`.

### Por qué el matcher no es un `indexOf`

Es la pieza cuyo fallo sería silencioso: subrayar de menos o de más no rompe nada visible. Un
`indexOf(target)` casa `<p` dentro de `<pre>`, `onerror=` dentro de `data-onerror=`, y la palabra
«body» de un párrafo con la etiqueta. Cada tipo lleva su frontera —lookahead para las etiquetas,
lookbehind para los atributos— y el target pasa siempre por un escapador: `{{{` sin escapar es un
cuantificador inválido.

Por eso vive en `src/utils/violation-matcher.ts` y no dentro del SFC. Vitest corre en entorno `node`,
sin DOM, así que dentro del componente no habría forma de probarlo; fuera, son catorce pruebas contra
un documento con señuelos deliberados para cada falso positivo.

Los diagnósticos se limpian solos en el `updateListener` que ya existía. No hay bucle porque
`setDiagnostics` despacha efectos de estado, no cambios de documento.

### Dos cosas que se ajustaron sobre la marcha

- **`expect.stringContaining` devuelve `any`** y dispara `no-unsafe-assignment`, que en este proyecto
  es error y no aviso. Los mensajes se afirman por separado con `toContain`.
- Una aserción propia estaba mal, no el código: en `<BODY><IMG ONERROR=…></BODY>` esperaba solo la
  infracción de `body`. La guarda que salta los atributos de una etiqueta prohibida cubre los
  atributos **del propio elemento**, no los de su descendencia — y debe ser así, porque `discard`
  elimina el `<body>` pero conserva sus hijos: ese `onerror` llegaría al artículo publicado.

### Verificación

```
Backend
  npm test           19 suites, 275 pruebas (antes 260; +15)
  npx tsc --noEmit   solo los 13 errores preexistentes de allowed-ips.service.spec.ts
  npm run lint       solo el warning preexistente de main.ts
  npm run build      OK

Frontend
  npm run typecheck  limpio
  npm run lint:check limpio
  npm test           3 archivos, 44 pruebas (antes 30; +14)
  npm run build      OK
```

`cheerio` no necesitó tocar `transformIgnorePatterns`: es dual y su build CJS resuelve
`htmlparser2@10` de raíz, no la copia `@12` ESM-only anidada bajo `sanitize-html` que rompió la suite
en el cambio anterior.

### Checklist de dependencias restantes

- [ ] **Las infracciones no se acumulan**: `create` valida variables antes que markup, así que una
      plantilla con las dos cosas mal reporta solo la primera. Es el *fail-fast* declarado, pero
      obliga a dos rondas de guardado.
- [ ] **El resaltado no sobrevive a una edición**: cualquier tecla limpia los diagnósticos, porque
      las posiciones se calcularon sobre el documento enviado. Mapearlas a través de los `ChangeSet`
      de CodeMirror permitiría conservarlas mientras el autor corrige.
- [ ] **La vista previa no informa de infracciones**: `previewTemplate` compila y sanea, pero no
      audita. Una plantilla guardada antes de estos cambios se ve recortada sin explicación.

---

## 2026-09-03 · Límite de sesiones activas y retirada de la purga muerta (MOD-01) — rama `feat/auth-token-cleanup`

El encargo listaba tres defectos del ciclo de vida de los refresh tokens. **Dos no existían**, el
tercero sí, y la forma en que el encargo proponía resolverlo habría abierto un fallo peor que el
que cerraba.

### Dos de los tres defectos ya estaban resueltos

| Defecto del encargo | Realidad |
|---|---|
| «La purga solo evalúa `isRevoked`, dejando huérfanos los caducados» | `pruneDeadTokens` ya usaba un `where` en array, que en TypeORM es un **OR**: revocado **o** caducado. Ambos criterios, desde la entrada de poda transaccional del 27-08 |
| «Múltiples peticiones del mismo `deviceId` generan filas redundantes» | `issue()` ya revocaba `{userId, deviceId, isRevoked: false}` **antes** de insertar, dentro de la transacción. `id_dispositivo` existe de punta a punta desde la migración `004` |
| «Máximo de 5 dispositivos activos» | **Cierto, no existía.** El único trabajo real |

Fácil de confundir con lo segundo: en el archivo ya había un `RETAINED_DEAD_TOKENS = 5`. Es otra
cosa por completo — cuántos tokens *muertos* se conservan como ventana de detección de reuso, no
cuántas sesiones *vivas* se permiten. Las dos constantes valen 5 y no tienen relación; el docblock
de la nueva lo dice de forma explícita porque el próximo que lo lea va a asumir lo contrario.

Añadí pruebas para los dos defectos inexistentes. No por ceremonia: el encargo los daba por rotos,
así que conviene que quede escrito que funcionan y que no puedan romperse en silencio.

### Revocar las sesiones sobrantes habría sido el fallo

El encargo ofrecía «revocar **o** eliminar los más antiguos» como si fuesen intercambiables. No lo
son, por cómo está construido `rotate()`:

```
El dispositivo expulsado presenta su token en /auth/refresh
   │
   ├── si se REVOCÓ   → la fila sigue ahí, con isRevoked = true
   │                    → rotate() lo lee como REUTILIZACIÓN
   │                    → revokeAllForUser() TUMBA LAS OTRAS 5 SESIONES
   │                    → y deja una alerta de robo FALSA en el log
   │
   └── si se ELIMINÓ  → no hay fila → 401 corriente, mensaje opaco de siempre
```

Cada expulsión rutinaria por cupo se habría convertido en una falsa alarma de robo que echa al
usuario de todos sus equipos. El límite **borra**.

Es la contrapartida exacta de una decisión anterior: los tokens muertos se conservan porque son la
ventana de detección, pero una sesión **viva** expulsada por cupo no debe dejar rastro revocado.
Ese es el motivo de que no se reutilizara `revokeAllForUser` ni nada parecido.

### Por qué el `skip` va después del `save`

`enforceSessionLimit` corre dentro de la transacción que `issue()` ya abría, después del `save`.
El token recién insertado es el más reciente, así que ordenando por `createdAt DESC` nunca cae en
la cola del `skip` y no puede expulsarse a sí mismo — el mismo razonamiento que ya justificaba el
orden insertar → podar.

Se ordena por `createdAt DESC, id DESC`. El desempate no es adorno: dos tokens emitidos en el mismo
instante comparten `createdAt`, y sin él, cuál de los dos cae del lado del corte lo decidiría el
plan de ejecución de PostgreSQL.

### El fallback de la vigencia no cubría lo que parecía

`?? DEFAULT_EXPIRATION_DAYS` solo atrapa la variable ausente, y del `.env` siempre llega una cadena:

| `REFRESH_TOKEN_EXPIRES_IN_DAYS` | Antes | Ahora |
|---|---|---|
| ausente | 7 días ✓ | 7 días |
| `` (vacía) | `Number('') === 0` → **el token nace caducado y el login queda roto** | 7 días |
| `abc` | `NaN` → fecha inválida | 7 días |
| `-3` / `0` | expiración en el pasado | 7 días |

El primero es el que asusta: la sesión no se abriría nunca y no habría un solo error en el log que
lo explicara. Ahora se valida el número resultante, no la mera presencia de la variable.

Se conservó el nombre `REFRESH_TOKEN_EXPIRES_IN_DAYS` en vez del `REFRESH_TOKEN_EXPIRES_IN` que
pedía el encargo: lleva la unidad en el nombre, ya está en `.env` y `.env.example`, y el corto
quedaría ambiguo junto a `JWT_EXPIRES_IN=1h`, que la lleva en el valor.

### `purgeExpired()` retirada

Código muerto: cero llamadas en todo `backend/src`, ni siquiera en tests. Y además incompleta —solo
miraba `expiresAt`, sin retención—, así que engancharla a un `@Cron` habría borrado la ventana de
detección de reuso de todos los usuarios. Un método muerto que encima es una trampa para el
siguiente que lo encuentre no merece conservarse; la ruta viva ya purga en cada emisión.

### El arnés de pruebas tuvo que aprender a distinguir dos consultas

`issue()` lanza ahora **dos** `find` en la misma transacción, y el doble devolvía `[]` para
cualquiera. Se discriminan por la forma del `where` —objeto para el cupo, array para el OR de la
poda— y no por el orden de llamada: indexar por posición ataría las pruebas al orden interno de
`issue()`, que es un detalle de implementación y ya cambió una vez en esta misma tarea.

### Verificación

```
Backend
  npm test           19 suites, 289 pruebas (antes 275; +14)
  npx tsc --noEmit   solo los 13 errores preexistentes de allowed-ips.service.spec.ts
  npm run lint       solo el warning preexistente de main.ts
  npm run build      OK
```

Sin migración y sin tocar `.env`: no hay columna nueva y el nombre de la variable se mantiene.
La migración `004` ya dejó dicho que `idx_refresh_tokens_id_usuario` cubre este filtro.

### Checklist de dependencias restantes

- [ ] **El cupo no se aplica al renovar sin emitir.** `enforceSessionLimit` vive en `issue()`, así
      que un usuario con 6 sesiones abiertas de antes no baja a 5 hasta que alguna emita. En la
      práctica renovar pasa por `issue()`, pero una cuenta inactiva conserva el exceso.
- [ ] **`MAX_ACTIVE_SESSIONS` no es configurable por entorno.** Está fijo a 5, como pedía el
      encargo. Si alguna vez hay que ajustarlo por despliegue, la variable no existe.
- [ ] **Sigue sin haber barrido periódico.** `@nestjs/schedule` está instalado y `ScheduleModule`
      nunca se importa. Si se añade, el barrido debe respetar la retención **por usuario**: uno
      global destruiría la ventana de detección de reuso.
- [ ] **`rotate()` e `issue()` no comparten transacción** (pendiente preexistente): si la emisión
      fallara tras la revocación, el usuario queda sin sesión y debe reentrar por OTP.

---

## 2026-09-04 · Habilitador de despacho manual (Camino B) y namespace `_assets` — rama `feat/html-template-mapper`

Primera ejecución del pipeline **completo** disparada por HTTP: `POST /api/workflows/:id/run-test`
recorre `FsmEngineService` → `StatePayloadContext` → `TemplateMapperStrategy` →
`TemplateRendererService` sin depender del listener IMAP.

### Estados de la FSM ejercitados

| Transición | Cómo se provocó | Resultado verificado |
|---|---|---|
| `INACTIVO → EN_PROCESO → EXITOSO` | Despacho con `initialPayload` completo | 200, `activeCursor: null`, markup compilado |
| `INACTIVO → EN_PROCESO → PAUSADO` | Nodo `MAPEADOR_PLANTILLA` sin variable requerida | 200 con `finalState: PAUSADO` y el cursor culpable |
| Rechazo previo al alta | Fila `EN_PROCESO` preexistente del mismo flujo | **409** `ConflictException` sin crear fila |
| Rechazo previo a la validación | UUID sin fila en `flujos` | **404** `NotFoundException` |

### El plan pedía `id_flujo: 'wf-test-template-e2e'` y eso no puede existir

`flujos.id_flujo` es `UUID PRIMARY KEY` (`init.sql:83`) y el endpoint valida el parámetro con
`ParseUUIDPipe`. Un identificador legible se habría rechazado con un 400 **antes de llegar al
servicio**, o habría reventado en el `INSERT`. El seed usa una constante UUID v4 escrita a mano
(`11111111-2222-4333-8444-555555555555`) y no un UUID aleatorio: fijarla permite dejar el `curl` en la
documentación sin releer la base tras cada siembra. El seed la imprime ya sustituida.

### `createExecution` no existía

El plan lo daba por implementado. `FsmEngineService` solo tenía `executeWorkflow`, que **espera una
fila ya creada**; las pruebas anteriores la sembraban a mano desde el fixture del runner. Se añadió
con la guarda de cupo dentro, para que el 409 se decida en un solo sitio.

También hubo que reconciliar nombres: el plan hablaba de `workflowId` y `fsmExecutionRepository`, pero
la entidad expone `flowId` (columna `id_flujo`) y el motor inyecta `fsmExecutionRepo`. Se respetó lo
que ya había: renombrar la columna habría arrastrado a `logs_nodo` y `alertas_error`, que le apuntan
con clave foránea.

### Por qué el cupo configurable no relaja nada

`MAX_CONCURRENT_EXECUTIONS_PER_FLOW=1` coincide con lo que ya impone `idx_flujo_activo`, el índice
único **parcial** de PROT-08. La guarda de aplicación no es la barrera —hay una ventana entre su
`count` y el `UPDATE` a `EN_PROCESO`— sino el **diagnóstico**: convierte un 500 por violación de
unicidad en un 409 que dice qué flujo y qué cupo. Subir la variable no levanta el límite real; solo
devuelve el fallo feo. Queda anotado en el checklist.

### `_assets` cupo en la gramática existente sin tocarla

`TEMPLATE_VARIABLE_PATTERN` ya aceptaba `[a-zA-Z0-9_]+` como raíz del namespace, así que
`{{_assets.base_url}}` se parsea sin modificar el validador. Solo hubo que añadir `_assets` a
`ALLOWED_NAMESPACES` — y a su réplica del frontend (`TEMPLATE_NAMESPACES`), que alimenta los chips
Poka-Yoke del editor. Dejarla desincronizada habría hecho que el backend aceptara una variable que el
autor no puede seleccionar, que es exactamente el fallo que esa réplica existe para evitar.

Se fusiona **al final** del spread, no al principio: un nodo que escribiera en `_assets` podría
redirigir todas las imágenes del artículo a un dominio ajeno. Hay prueba dedicada (7.7).

Y se inyecta **antes** del pre-chequeo de variables. Con el orden inverso, `_assets.base_url` figura
en `requiredVariables` pero no en el contexto crudo, y el nodo fallaría siempre con un `missingFields`
que el operador no podría corregir de ninguna manera.

### La normalización de barras se limitó a las claves de ruta

El plan decía «si un campo `image_path` (o ruta relativa) inicia con `/`, recortarlo». Interpretarlo
como «toda cadena del contexto» habría corrompido datos: un `clean_body` que arranque con `/` o un
`source_url` relativo perderían su primer carácter, y eso es un fallo silencioso mucho peor que la
doble barra visible que se pretende evitar.

La regla es determinista y está documentada en el código: `ASSET_PATH_KEY_PATTERN = /(?:^|_)path$/`,
que cubre `image_path`, `path`, `file_path`, `thumbnail_path`. El recorrido es de un solo nivel; bajar
recursivamente obligaría a clonar en profundidad todo el contexto en cada render para respetar la
inmutabilidad del `StatePayloadContext`, y las rutas de asset que el pipeline produce viven en la raíz
del namespace de su nodo.

De paso se recorta la barra **final** del prefijo (`ASSETS_BASE_URL=…/uploads///`), que es el error de
`.env` complementario y no cuesta nada cubrir.

### `ConfigService` en el renderer obligó a tocar cuatro suites

`TemplateRendererService` se instanciaba con `new TemplateRendererService()` en cuatro sitios
(`nodes.module.spec`, `template-mapper.strategy.spec`, `templates.service.spec` y su propio spec).
En vez de repetir el doble cuatro veces se añadió `test/factories/template-renderer.factory.ts`, con
el `ConfigService` **real** sembrado por `internalConfig` y no un objeto casteado: así la prueba
verifica también que la clave que el servicio pide (`ASSETS_BASE_URL`) es la que existe de verdad.

Anotado en el propio archivo: `ConfigService.get()` da prioridad a `process.env` sobre el objeto
interno, así que exportar `ASSETS_BASE_URL` en el shell haría que estas pruebas leyeran ese valor.

Con la factoría hizo falta un alias: `@test/*` en `tsconfig.json`, `package.json` (jest) y
`test/jest-e2e.json`. Sin él, importarla desde `src/modules/**` exigía `../../../../test/…`, que
`code-conventions.md` §6 prohíbe.

### Una prueba ajena se rompió, y estaba bien que se rompiera

`templates.service.spec.ts` 8.1 transcribía la lista de namespaces dentro del mensaje esperado.
Añadir `_assets` la tumbó. Se cambió por una plantilla derivada de `ALLOWED_NAMESPACES.join(', ')`:
esa prueba verifica el **localizador de infracciones**, no el contenido de la lista blanca, y no debe
volver a caerse cada vez que se añada un namespace.

### El seed dejó de exportar sus constantes

Al verificar contra PostgreSQL se importó `TEST_FLOW_ID` desde el seed… y el seed **se ejecutó**:
el archivo llama a `main()` en el nivel superior. Exportar constantes desde un módulo autoejecutable
es una trampa para el siguiente que las necesite, así que pasaron a locales. Lo que haya que
compartir irá a un `*.fixture.ts` aparte, como ya hace `dummy-pipeline.fixture.ts` frente a
`run-dummy-e2e.ts`.

### `HttpStatus.OK` y no el 201 por defecto de `@Post`

La petición es síncrona y el cuerpo devuelve el **resultado**, no la fila creada. Un flujo `PAUSADO`
tampoco es un error HTTP: es un 200 con `finalState` y `activeCursor`, que es lo que necesita CU-09
para el reintento manual.

### Verificación

```
Backend
  npm run build              OK
  npm test                   20 suites, 307 pruebas (antes 289; +18)
  npx tsc --noEmit           solo los 13 errores preexistentes de allowed-ips.service.spec.ts
  npx eslint (ficheros tocados)  limpio
  npm run seed:fsm-runner    OK, idempotente en la segunda pasada

Frontend
  npm run typecheck          OK
  npm test                   3 ficheros, 44 pruebas

E2E contra PostgreSQL (5433)
  finalState                 EXITOSO
  activeCursor               null
  namespaces                 parsed_email, rendered_html
  markup                     <img src="http://localhost:3000/static/uploads/2026/09/laboratorio.jpg" …>
  doble barra                ausente
  fila EN_PROCESO previa     409 ConflictException
  UUID inexistente           404 NotFoundException
```

El `image_path` de entrada llevaba barra inicial (`/2026/09/laboratorio.jpg`): la URL de salida es la
prueba de que la normalización actúa.

### Checklist de dependencias restantes

- [x] ~~**`ASSETS_BASE_URL` apunta al puerto 3000 y la API escucha en el 5000.**~~ Falsa alarma: el
      `PORT=5000` que vi era el de `backend/.env.example`; el `backend/.env` real declara `PORT=3000`.
      No había discrepancia.
- [x] ~~**No existe la ruta `/static/uploads`.**~~ Resuelto el 2026-09-04 con `ServeStaticModule`
      (ver la entrada siguiente).
- [ ] **La carrera del cupo devuelve 500, no 409.** Dos despachos verdaderamente simultáneos pueden
      pasar los dos el `count`; el segundo choca contra `idx_flujo_activo` en el `UPDATE` a
      `EN_PROCESO`, que ocurre **fuera** del `try` de `executeWorkflow` y sube como `QueryFailedError`.
      Traducirla exigiría atrapar la violación de unicidad de PostgreSQL (`23505`) y reemitirla como
      `ConflictException`.
- [ ] **El despacho manual ignora `flujos.activo` a propósito** (probar antes de habilitar). Cuando
      exista el disparador automático, es él quien debe respetarla.
- [ ] **Sin cola.** La petición bloquea el hilo HTTP hasta que el motor termina.
      `architecture-patterns.md` §5 pide BullMQ para las ejecuciones pesadas; aquí el pipeline es de
      un solo nodo y el bloqueo es aceptable para una herramienta de verificación, no para producción.
- [ ] **Sin `NotificationGateway`.** El frontend no recibe `node_started` / `flow_finished`: no hay
      WebSocket todavía, así que el resultado solo llega en la respuesta HTTP.
- [ ] **Sin prueba e2e automatizada del endpoint.** La verificación de arriba se hizo con un script
      desechable contra la base real; `test/` no tiene un `workflows.e2e-spec.ts` que la repita en CI.

---

## 2026-09-04 · Entrega de archivos estáticos (`ServeStaticModule`) — rama `feat/html-template-mapper`

Cierra el pendiente que dejó el Camino B: `{{_assets.base_url}}` componía una URL correcta que no
resolvía a ningún archivo. Ahora `backend/static/uploads/` se sirve en `/static/uploads`.

### La versión 12 de `@nestjs/serve-static` no vale aquí

`npm install @nestjs/serve-static` falló con `ERESOLVE`: la 12.0.0 exige `@nestjs/common@^12` y el
proyecto va en Nest 11.2.3. **No** se resolvió con `--force` ni `--legacy-peer-deps`, que habrían
dejado en el árbol un paquete construido contra una API distinta para que reventara en runtime. Se
instaló la línea correspondiente a Nest 11: `@nestjs/serve-static@^5.0.5`
(peer `@nestjs/common@^11.0.2`, `express@^5.0.1`; el proyecto tiene Express 5.2.1).

Las dos vulnerabilidades que reporta `npm audit` (`fast-uri` alta, `qs` moderada) son **preexistentes**
y transitivas de `ajv` y `express`; no las introduce este paquete y no se tocaron aquí.

### Por qué `process.cwd()` y no `__dirname`

`app.module.ts` se ejecuta desde `src/` en desarrollo y desde `dist/` en producción: una ruta relativa
al módulo apuntaría a dos sitios distintos. El directorio de trabajo es `backend/` en ambos casos.

Y por eso `static/` vive **fuera de `src/`**: `nest build` compila `src/` hacia `dist/` y lo limpia en
cada build, así que un binario ahí dentro se perdería. Tampoco en la raíz del monorepo: la entrega de
archivos es infraestructura del backend.

### `serveRoot` no lleva el prefijo `/api`

`ServeStaticModule` registra sus rutas con `httpAdapter.useStaticAssets()`, es decir, a nivel de
Express y **fuera del router de Nest**, así que `setGlobalPrefix('api')` no las alcanza. Es el mismo
motivo por el que Swagger vive en `/api/docs` y no en `/api/api/docs`.

### ⚠️ Ese mismo hecho abre un agujero en el perímetro

Comprobado contra el servidor en marcha, no deducido:

| Petición con `X-Forwarded-For: 203.0.113.10` (fuera de rango) | Código |
|---|---|
| `GET /api/templates` (ruta Nest, guard global) | **403** |
| `GET /api/docs` (Swagger, protegido a mano en `main.ts`) | **403** |
| `GET /static/uploads/2026/09/laboratorio.jpg` | **200** |

`IpWhitelistGuard` es un `APP_GUARD` del router de Nest y no ve estas rutas — exactamente el caso que
`main.ts` ya documenta para Swagger y resuelve montando `RedLocalMiddleware` a mano.
`security-and-scope.md` §1 exige que toda ruta protegida pase por él. **No se aplicó por decisión
propia** porque cambia quién puede leer las imágenes: si el CMS de destino las descarga desde fuera
del rango corporativo, cerrarlo rompería la publicación. Queda en el checklist para decidir.

### Endurecimiento aplicado y verificado

`index: false` y `redirect: false`. Con el servidor en marcha:

| Petición | Resultado |
|---|---|
| `…/2026/09/laboratorio.jpg` | **200**, `Content-Type: image/jpeg`, 160 bytes |
| `…/2026/09/` (directorio) | 404 — sin listado ni `index.html` implícito |
| `…/no-existe.jpg` | 404 |
| `…/..%2f..%2f.env` | 404 |
| `…/../../.env` (`curl --path-as-is`) | 404 |
| `…/.gitkeep` | 404 — `dotfiles: 'ignore'` por defecto |

### Cadena completa, extremo a extremo

```
runWorkflowTest → EXITOSO
  src interpolado : http://localhost:3000/static/uploads/2026/09/laboratorio.jpg
  GET a esa URL   : 200  image/jpeg  160 bytes
```

El `image_path` de entrada seguía llevando barra inicial. La imagen de prueba (JPEG 1×1) se dejó en
su sitio a propósito: hace que el fixture del Camino B produzca una URL que resuelve de verdad. Está
cubierta por `.gitignore`, así que no se versiona.

### Verificación

```
npm run build      OK
npm test           20 suites, 307 pruebas (sin regresiones)
npx tsc --noEmit   solo los 13 errores preexistentes de allowed-ips.service.spec.ts
npm run lint       solo el warning preexistente de main.ts:59
git check-ignore   backend/static/uploads/foto.jpg → ignorado; .gitkeep → versionado
```

### Checklist de dependencias restantes

- [ ] **`/static/uploads` está fuera del perímetro de red** (evidencia arriba). Si estas imágenes solo
      deben verse desde la red corporativa, basta replicar el patrón de Swagger en `main.ts`:
      `app.use('/static/uploads', redLocalMiddleware.use.bind(redLocalMiddleware));`
- [ ] **No hay endpoint de subida.** El directorio se puebla a mano; queda fuera del MVP igual que la
      edición gráfica (`security-and-scope.md` §3). Cuando exista, necesitará validar tipo MIME real
      —no la extensión—, tamaño máximo y un nombre de archivo saneado.
- [ ] **Sin volumen en `docker-compose.yml`.** `backend/static/uploads/` vive en el sistema de
      archivos del host; si el backend se contenedoriza, hay que mapearlo o las imágenes se pierden
      en cada recreación.
- [ ] **Sin caché.** `Cache-Control: public, max-age=0`: se revalida en cada petición. Para
      producción convendría un `maxAge` real, ya que las rutas incluyen año y mes.

---

## 2026-09-04 · Perímetro sobre `/static/uploads` y traducción del conflicto 23505 — rama `feat/html-template-mapper`

Cierra los dos huecos que quedaron anotados en las dos entradas anteriores.

### 1. El perímetro ya cubre los estáticos

`main.ts` renombra `SWAGGER_PERIMETER_PATHS` a `PERIMETER_PATHS` y le suma `/static/uploads`.
Las dos familias comparten causa: ni `SwaggerModule` ni `ServeStaticModule` registran en el
router de Nest, sino en el adaptador de Express, así que el `IpWhitelistGuard` —un `APP_GUARD`
del router— nunca las alcanza. Comprobado contra el servidor en marcha:

| Petición con `X-Forwarded-For: 203.0.113.10` | Antes | Ahora |
|---|---|---|
| `/static/uploads/2026/09/laboratorio.jpg` | 200 | **403** |
| `/api/docs` | 403 | 403 |
| Mismo estático desde localhost | 200 | 200 |

El orden de registro funciona sin trucos: `app.use()` corre en `bootstrap()`, y
`ServeStaticModule` no monta lo suyo hasta `app.init()` —o sea, dentro del `listen()` de más
abajo—, así que el middleware perimetral entra antes en la pila de Express.

### 2. La carrera del mutex ya devuelve 409, no 500

`createExecution` cuenta las ejecuciones `EN_PROCESO` antes de insertar, pero entre ese `count`
y el `UPDATE` a `EN_PROCESO` hay una ventana. Dos despachos simultáneos la pasan los dos, y el
segundo choca contra `idx_flujo_activo`. Eso subía como `QueryFailedError` crudo.

**Detección más estricta que la del encargo.** No basta con `driverError.code === '23505'`:

```
instanceof QueryFailedError  &&  driverError.code === '23505'
&& (driverError.constraint === undefined || driverError.constraint === 'idx_flujo_activo')
```

El nombre de la restricción **estrecha cuando viene, pero no se exige**. Las dos rigideces
alternativas fallan en direcciones opuestas: aceptar cualquier 23505 disfrazaría de 409 el bug
de otra unicidad (fallo silencioso), y exigir siempre el nombre devolvería 500 en una carrera
legítima si el driver no lo informa (`pg` solo asigna `code` y `constraint` cuando el servidor
los envía). El helper se llama `isActiveFlowMutexViolation` y no `isUniqueViolation` a
propósito: el predicado no es «cualquier unicidad», y el nombre genérico invitaría a
reutilizarlo mal en otro servicio.

Se verificó en `node_modules/typeorm@1.1.0` que `QueryFailedError<T extends Error = Error>`
expone `driverError` y que su constructor copia las props del driver también a la raíz — de ahí
que el `instanceof` vaya primero y la lectura sea por `driverError`, que es el camino tipado.

**Solo se envuelve la primera escritura.** El índice es *parcial* (`WHERE estado = 'EN_PROCESO'`):
una vez la fila ya está dentro, ella misma es la única entrada del índice para su `id_flujo`, y
ninguna rival puede entrar mientras tanto. Los `saveCheckpoint` del bucle no pueden violarlo. El
`try` es local y **no** el externo, conservando la intención ya documentada ahí: perder la
carrera no es un fallo del flujo y no debe marcar `FALLIDO`.

### 3. `saveCheckpoint` mutaba la entidad antes de escribir

Hacía `Object.assign(execution, patch)` y *luego* el `UPDATE`. Si la escritura fallaba, la
entidad en memoria anunciaba `EN_PROCESO` sobre una fila que seguía `INACTIVO`. Era inocuo
mientras solo pasaba en el camino catastrófico; con el 409 esa mentira pasaba a estar en un
desenlace **esperado**. Invertido el orden.

No es un detalle cosmético y la prueba lo demuestra: con el orden antiguo,
`NO deberia marcar FALLIDO al perder la carrera por el mutex` falla con
`Expected: "INACTIVO" / Received: "EN_PROCESO"`.

### Verificación

Seis pruebas nuevas en `fsm-engine.service.spec.ts` (bloque `mutex de ejecucion
idx_flujo_activo`), construyendo el `QueryFailedError` **real** de TypeORM y no un objeto de
forma parecida: la guarda arranca con un `instanceof` y un doble suelto la dejaría sin
ejercitar. Cubren el 23505 con y sin `constraint`, el 23505 de otra restricción, un
`40001` y un `Error` ajeno a TypeORM.

```
npm run build      OK
npm test           20 suites, 313 pruebas (antes 307; +6)
npx tsc --noEmit   solo los 13 errores preexistentes de allowed-ips.service.spec.ts
npm run lint       solo el warning preexistente de main.ts

Carrera real contra PostgreSQL (script desechable):
  createExecution sin rivales      -> ejecucion INACTIVO creada
  se inserta una rival EN_PROCESO  -> reproduce la ventana del count
  executeWorkflow                  -> ConflictException, httpStatus 409
  estado de la fila                -> INACTIVO (no se marco FALLIDO)
```

### Checklist de dependencias restantes

- [x] ~~`/static/uploads` está fuera del perímetro de red.~~ Resuelto aquí.
- [x] ~~La carrera del cupo devuelve 500, no 409.~~ Resuelto aquí.
- [ ] **La guarda de `createExecution` sigue sin ser atómica**, y así se queda: la barrera real
      es el índice único parcial, que funciona incluso con varios procesos. Lo que hay ahora son
      dos capas de *diagnóstico* sobre esa barrera, no dos barreras.
- [ ] **Sin prueba e2e automatizada de la carrera.** La verificación de arriba es un script
      desechable; reproducirla en CI exige dos conexiones concurrentes reales.

---

## 2026-09-07 · Nodo de ingesta `TRIGGER_IMAP` y sondeo periódico — rama `feat/trigger-imap`

Primera estrategia **productora** del motor: hasta ahora todas las piezas reales consumían un contexto
que alguien había sembrado por HTTP. `DummyInputStrategy` ocupaba el hueco de `NodeType.TRIGGER_IMAP`
devolviendo sus propios `params`, y su TSDoc anticipaba el relevo: *"el dia que exista la estrategia
IMAP de verdad ocupara exactamente este hueco"*. Ese día es hoy.

### Estado de la FSM implementado

```
flujos.activo=true + IMAP_POLLING_ENABLED=true
        │
        ▼
[intervalo imap-poll:<flowId>]  cada pollIntervalMs
        │
        ├─ STATUS unseen=0 ──────────────────────────► fin del ciclo (nada que hacer)
        │
        └─ STATUS unseen>0
                 │
                 ▼
        createExecution ─── 409 ──► aviso, el correo sigue UNSEEN, próximo ciclo
                 │
                 ▼ INACTIVO → EN_PROCESO
        ImapTriggerStrategy.execute()
                 ├─ config inválida ────────────► success:false GRAVE → PAUSADO
                 ├─ passwordEnvKey sin valor ───► success:false GRAVE → PAUSADO
                 ├─ red / auth / timeout ───────► success:false GRAVE → PAUSADO (reintentable)
                 ├─ buzón vacío ────────────────► success:true {status:NO_MESSAGES_FOUND}
                 └─ correo UNSEEN ──────────────► success:true {6 claves} + \Seen
                                                        │
                                                        ▼
                                     setNamespace(node.outputNamespace, data)
```

### El "por qué" de cuatro decisiones

**1. `validate()` y no `validateOrReject()`.** El enunciado inicial pedía la segunda. No es un detalle
de estilo: `validateOrReject` lanza, y `FsmEngineService.runNode` captura toda excepción y la normaliza
a nivel `URGENTE`. Como `canRetry` solo reintenta los `GRAVE`, un `host` mal escrito habría quedado
**permanentemente irrecuperable** en lugar de PAUSADO y corregible vía CU-09. Se valida con `validate()`
y se traducen los errores a `NodeResult` GRAVE con `missingFields`, igual que hace el mapeador de
plantillas con su plantilla ausente.

**2. La contraseña por referencia, y el patrón que la acota.** El modelo híbrido (`passwordEnvKey` en
`params`, secreto en `.env`) resuelve el problema obvio: no dejar la clave del buzón en la columna JSONB
ni mandarla al editor de flujos. Pero abre uno menos obvio, y es el hallazgo que más cambió el código:
`params` lo edita un rol EDITOR, así que con la clave libre un editor podía escribir
`host: imap.atacante.com` + `passwordEnvKey: JWT_SECRET` y el backend habría entregado el secreto de
firma de tokens, en claro, a un servidor ajeno, como si fuera una contraseña IMAP. De ahí el
`@Matches(/^IMAP_[A-Z0-9_]*PASSWORD$/)`: acota lo que el nodo puede llegar a leer del entorno. La
prueba 3.4 lo blinda comprobando que el rechazo ocurre **antes** de tocar `ConfigService`.

**3. Un solo lector del buzón.** El sondeo podría leer el correo y pasarlo al motor como
`initialPayload`, ahorrando una reconexión. Se descartó: el sondeo tendría que marcar `\Seen` al leer, y
entonces cualquier fallo posterior (un 409 de concurrencia, el proceso muriendo entre la lectura y el
arranque) dejaría el correo consumido **sin nada en el buzón que indique que hay que reprocesarlo**. Y
si no lo marcase, el ciclo siguiente lo publicaría por segunda vez. No hay tercera opción. Con el
sondeo limitado a `STATUS` —que no abre el buzón ni toca banderas— el correo permanece `UNSEEN` hasta
que lo consume la estrategia, así que un ciclo perdido no pierde nada. Efecto secundario deseable: la
misma estrategia sirve para el disparo manual del Camino B sin cambios.

**4. `SchedulerRegistry`, no `@Cron`.** `pollIntervalMs` es un parámetro por nodo, y un decorador se
evalúa una vez en tiempo de clase: no admite un periodo distinto por flujo. Tres trampas que el código
tuvo que cubrir explícitamente:
- `addInterval` **lanza** si el nombre ya está tomado ⇒ se borra antes de re-registrar.
- `addInterval` **no** envuelve el callback en try/catch ⇒ `pollInbox` no puede rechazar nunca, o una
  promesa sin manejar termina el proceso en Node ≥ 18.
- `main.ts` no llamaba a `enableShutdownHooks()` ⇒ `onModuleDestroy` no corría con SIGTERM y los
  intervalos habrían sobrevivido a cada recarga de `--watch`, sondeando el mismo buzón con varias
  generaciones del proceso. Agujero preexistente que esta rama es la primera en convertir en problema
  real; se añade la línea que faltaba.

### Poka-Yoke: por qué el sondeo nace apagado

`IMAP_POLLING_ENABLED=false` por defecto, y el código exige el literal `'true'` en lugar de
`!== 'false'`. El motivo no es la prudencia genérica: la estrategia marca `\Seen`. Un backend arrancado
en el portátil de un desarrollador apuntando al buzón corporativo **consumiría los correos de
producción**, y el entorno que sí debía procesarlos no volvería a verlos. El fallo por omisión tiene que
ser "no sondea". Con `flujos.activo` son dos interruptores en serie, uno global y otro por flujo.

### Verificación

```
npm test          → 22 suites, 360 pruebas en verde (46 nuevas)
tsc --noEmit      → limpio sobre tsconfig.build.json
eslint            → limpio
```

Cobertura nueva: 25 pruebas de la estrategia (extracción, cascada `html → textAsHtml → text`, buzón
vacío por `[]` y por `false`, resolución del secreto, exfiltración rechazada, `\Seen` posterior al
parseo, cierre en `finally` sin enmascarar el error real, inmutabilidad del contexto) y 21 del sondeo
(programación por flujo, filtros de elegibilidad, tick solapado, 409 tolerado, resiliencia del callback).

### Checklist de dependencias restantes

- [x] ~~`NodeType.TRIGGER_IMAP` sin estrategia real.~~ Resuelto aquí.
- [x] ~~`main.ts` sin `enableShutdownHooks()`.~~ Resuelto aquí.
- [x] ~~`nodo_trigger` no está en `ALLOWED_NAMESPACES`.~~ Resuelto en el commit siguiente: el default
      pasa a `raw_email`, que ya estaba en la lista blanca, y `nodo_trigger` se retira del código.
- [ ] **El disparo es en proceso, no encolado.** `architecture-patterns.md` §5 pide BullMQ para la
      ingesta Cron/IMAP. Bloquea el temporizador, nunca el hilo HTTP, y el despliegue todavía no tiene
      Redis. El salto consiste en sustituir el cuerpo de `dispatchFlow`, único punto que conoce el motor.
- [ ] **`host` sin lista blanca.** El patrón de `passwordEnvKey` acota qué secreto puede leerse, pero un
      EDITOR sigue pudiendo apuntar el nodo a un servidor IMAP arbitrario y ver ahí la contraseña del
      buzón corporativo. Restringir el dominio contra una lista en `.env`.
- [ ] **`@nestjs/schedule` es intra-proceso.** Con N réplicas del backend habría N sondeadores sobre el
      mismo buzón. Seguro con el despliegue monoinstancia actual; el día que se replique, el mutex
      `idx_flujo_activo` evita ejecuciones duplicadas pero no las conexiones IMAP redundantes.
- [ ] **Sin `PARSER_PRE_IA`.** Es el consumidor natural de este payload: `text` viaja sin sanear a
      propósito, y el escudo pre-IA es quien debe limpiarlo antes de gastar tokens.

---

## 2026-09-07 · Normalización a `raw_email`, retirada de `raw_html` y comprobación del asistente — rama `feat/trigger-imap`

Tres correcciones sobre el nodo de ingesta, más el endpoint que faltaba para que el asistente pueda
validar credenciales antes de guardar un flujo.

### 1. `raw_email` como namespace canónico

El default del DTO era `nodo_trigger`, un nombre que **no está en `ALLOWED_NAMESPACES`**: una plantilla
que interpolase `{{nodo_trigger.subject}}` habría sido rechazada por el gestor con un 400, aunque el
nodo hubiese escrito el dato correctamente en el contexto. Pasa a `raw_email`, que ya estaba reservado
en esa lista para el correo crudo desde PROT-11.1. Cero cambios en el gestor de plantillas.

`nodo_trigger` se retira del código por completo. Donde aparecía como **`nodeId`** —una clave de
topología, concepto distinto de un namespace— pasa a `trigger_imap`, que describe el tipo funcional del
nodo en lugar de su papel en el grafo. Que el mismo string sirviera para dos conceptos es precisamente
lo que hacía fácil confundirlos:

```
nodeId: 'trigger_imap'        ← clave del nodo en el grafo
outputNamespace: 'raw_email'  ← donde escribe en el StatePayloadContext
```

Se corrige también el ejemplo de Swagger de `PipelineNodeConfigDto.outputNamespace`, que enseñaba el
nombre equivocado y habría propagado el error a cada flujo creado desde la documentación.

### 2. `raw_html` fuera del payload

El nodo pasa de seis claves a cinco: `message_id`, `from`, `subject`, `text`, `date`. Desaparece
`raw_html` y con él la cascada `html → textAsHtml → text`.

El motivo es de reparto de responsabilidades: el HTML de un correo arrastra estilos en línea, imágenes
incrustadas como `data:` URI y etiquetas del cliente remitente, y **nadie aguas abajo lo necesita**.
`PARSER_PRE_IA` trabaja sobre texto plano justamente para no gastar tokens en marcado, y el HTML final
lo aporta la plantilla del gestor, no el correo de origen. Propagarlo solo engordaba el checkpoint
JSONB con datos que ningún nodo iba a consumir.

**Consecuencia que hay que conocer al configurar un flujo:** un correo que llegue únicamente en HTML,
sin parte `text/plain`, deja `text` vacío. Derivar texto del marcado sería sanitizar, y eso es
competencia del escudo pre-IA: `security-and-scope.md` §3 mantiene este nodo sin transformaciones. La
prueba 1.4 fija ese comportamiento para que nadie lo tome por un descuido.

> *Cumplido en la entrada del 2026-09-18:* el escudo pre-IA ya deriva el texto de ese marcado. La
> prueba 1.4 de `imap-trigger.strategy.spec.ts` sigue vigente sin cambios, porque el reparto no se ha
> movido: el nodo de ingesta continúa sin transformar nada.



### 3. `POST /api/wizard/check-imap`

Permite validar las credenciales antes de guardar el `pipeline_schema`, en lugar de descubrir el fallo
la primera vez que el sondeo dispare el flujo.

Comprueba **conexión y buzón** (`connect` + `status`), no solo el login: autenticar correctamente
contra un `mailbox` que no existe es un falso positivo que el operador debe ver en el asistente. Un
fallo devuelve 200 con `success: false` y severidad `GRAVE`, no un 4xx — el diagnóstico del servidor de
correo es parte de la respuesta que la interfaz tiene que mostrar, y un código de error obligaría al
cliente a distinguir "las credenciales son malas" de "la llamada al backend se rompió". La respuesta
**no** lleva `stackTrace`: revelaría rutas del servidor sin aportar nada a quien rellena un formulario.

Dos detalles que no son de gusto:

- **`ValidationPipe` local con `forbidNonWhitelisted`.** El pipe global de `main.ts` solo lleva
  `{ whitelist: true, transform: true }`, que *elimina en silencio* las propiedades desconocidas. Aquí
  hace falta que las **rechace**: un cliente que envíe `password` en el cuerpo debe recibir un 400, no
  un 200 tras haberse descartado el campo sin avisar. Es la misma opción que aplica la estrategia a los
  `params` del nodo, así que asistente y ejecución usan idéntico criterio.
- **El endpoint es un oráculo de conectividad.** Acepta `host` y `user` arbitrarios, así que sin el
  patrón `IMAP_*PASSWORD` de `passwordEnvKey` cualquiera con rol EDITOR podría pedir al backend que
  enviase `JWT_SECRET` a un servidor propio y confirmar el acierto leyendo el `success`. Las tres
  barreras —perímetro de red, JWT+RBAC y el patrón del DTO— son las que hacen publicable este endpoint.

### 4. `createImapClient`: una sola definición de las opciones endurecidas

Con el wizard, las rutas que hablan IMAP pasaban a ser tres, cada una repitiendo `logger: false`,
`emitLogs: false`, `disableAutoIdle`, los timeouts y el oyente de `error`. Son decisiones de seguridad
—sin `logger: false`, `imapflow` vuelca la conversación IMAP con las cabeceras de autenticación al
stdout del contenedor— y no pueden divergir entre consumidores. Se extraen a una función pura en
`services/imap-client.factory.ts`.

El oyente de `error` es un **parámetro obligatorio** de la firma, no opcional: `ImapFlow` es un
`EventEmitter` y un evento `error` sin oyente derriba el proceso de Node. Exigirlo en el tipo convierte
ese olvido en un error de compilación en lugar de una caída en producción.

Se mantiene como función y no como provider inyectable a propósito: así `WizardModule` la consume por
importación directa sin tener que importar `NodesModule`, que arrastraría el sondeo periódico, su
repositorio de `flujos` y `WorkflowsModule` detrás para no usar ninguno de los tres.

### Verificación

```
npm test          → 23 suites, 375 pruebas en verde (+15)
tsc --noEmit      → limpio sobre tsconfig.build.json
eslint            → limpio
```

Nuevas: 2 del namespace por defecto (incluida la que comprueba que el default está en
`ALLOWED_NAMESPACES`, para que ambos no puedan separarse sin que falle la suite) y 13 del
`WizardService`, con tres específicas de no filtración de secretos.

---

## 2026-09-07 · PROT-12.3 · Catálogo de pipelines para el asistente — rama `feat/trigger-imap`

Primera tanda del wizard: el backend que alimenta la Fase 0. El asistente necesita listar los flujos
que puede usar como plantilla, y no existía endpoint alguno — `WorkflowsController` solo tenía
`POST /:id/run-test`.

### Pasos 1-4 completados

| Archivo | Estado |
|---|---|
| `backend/src/modules/workflows/dto/pipeline-summary-response.dto.ts` | creado |
| `backend/src/modules/workflows/workflows.service.ts` | `findSelectablePipelines()` + `buildOrderedTopology()` |
| `backend/src/modules/workflows/workflows.controller.ts` | `@Get()` añadido |
| `backend/src/modules/workflows/workflows.service.spec.ts` | +9 pruebas (bloques 4, 5 y 6) |

Verificación: **384 pruebas en verde** (23 suites, +9), `tsc -p tsconfig.build.json` limpio, `eslint src`
sin errores (queda el warning preexistente de `bootstrap()` en `main.ts:78`).

### El «por qué» de tres decisiones

**1. `params` no viaja.** La proyección es deliberadamente parcial. En un nodo `TRIGGER_IMAP`, `params`
contiene `host`, `user` y `passwordEnvKey`; en un `DESTINO_HTTP`, la URL interna del CMS. Devolver el
esquema entero convertiría un endpoint de *listado* en una fuga de configuración de infraestructura
hacia el navegador, y el selector del asistente no necesita ninguno de esos datos para pintar una
tarjeta. La prueba 6.1 lo blinda serializando la respuesta y comprobando que no aparecen ni el host ni
la clave de entorno.

**2. El orden sale del grafo, no del mapa.** `schema.nodes` está indexado por `nodeId` y sus claves
conservan el orden de escritura del JSON, que no tiene por qué coincidir con el camino de ejecución.
`buildOrderedTopology` recorre desde `entrypoint` siguiendo `nextStep`. La prueba 5.1 usa un esquema
con las claves **en orden inverso** al de ejecución: si la proyección usara `Object.values`, devolvería
exactamente esa secuencia invertida y el stepper se pintaría al revés.

**3. El `Set` de visitados no es redundante.** `validatePipelineTopology` ya garantiza que el camino
activo es acíclico (garantía 5), así que sobre un esquema validado nunca hace falta. Cubre la fila
escrita por SQL directo, que se salta esa validación: sin él, un `nextStep` circular colgaría la
petición HTTP en un bucle infinito. Un puntero huérfano trunca el recorrido y registra un `warn` en
lugar de lanzar — es un esquema roto, pero el catálogo debe seguir respondiendo para que el operador
pueda verlo y corregirlo (pruebas 5.3 y 5.4).

Detalle de TypeScript que obligó a una anotación explícita: `cursor` se reasigna desde `node.nextStep`
y `node` se lee de `schema.nodes[cursor]`, así que sin anotar `node: PipelineNodeConfig | undefined` el
compilador entra en inferencia circular y falla con TS7022.

### Próximo paso exacto

**Paso 5:** extender `frontend/src/types/pipeline.ts` con `PipelineStep`, `PipelineSummary` y
`WizardStep` (este último enriquecido con `name`, derivado de `NODE_TYPE_LABELS[nodeType]`, que ya
existe en ese archivo). El enum `NodeType` y `OUTPUT_NAMESPACE_PATTERN` ya están ahí.

---

## 2026-09-07 · PROT-12.4 · Servicios, tipos y store del nodo `TRIGGER_IMAP` — rama `feat/trigger-imap`

Segunda tanda: la mitad no visual del paso 1 del asistente. Réplica de la tríada de §3.1 que el nodo
mapeador ya estableció, para un segundo tipo de nodo.

### Pasos 5-8 completados

| Archivo | Estado |
|---|---|
| `frontend/src/types/pipeline.ts` | +`PipelineStep`, `PipelineSummary`, `WizardStep`, `toWizardStep`, `CheckImapPayload`, `CheckImapResult` |
| `frontend/src/services/pipelines.service.ts` | creado |
| `frontend/src/services/nodes/trigger-imap.service.ts` | creado |
| `frontend/src/stores/nodes/trigger-imap.store.ts` | creado |
| `frontend/src/stores/nodes/trigger-imap.store.spec.ts` | creado (18 pruebas) |

Verificación: **72 pruebas en verde** (5 archivos, +18), `vue-tsc --noEmit` limpio, lint limpio.

### El «por qué» de tres decisiones

**1. Toda mutación pasa por `patchConfig`.** No es azúcar sintáctico: es lo que garantiza que no exista
ninguna vía de modificar la configuración sin invalidar `connectionVerified`. Si la vista escribiera en
`config` directamente, el store afirmaría que la conexión está probada para unos valores que ya no son
los del formulario. La prueba 4.2 recorre los seis campos de conexión uno a uno.

**2. `isConfigValid` exige conexión verificada, no solo campos válidos.** Unas credenciales con formato
correcto pero equivocadas no fallarían hasta que el sondeo disparase el flujo en producción, con el
flujo quedando PAUSADO y un `GRAVE` en la trazabilidad. Obligar a pulsar «Probar Conexión» traslada ese
descubrimiento al momento de configurar, que es el propósito del paso. La prueba 3.4 fija que campos
completos **sin probar** no bastan.

**3. `name` del paso no viaja por la red.** `NODE_TYPE_LABELS` ya vive en `types/pipeline.ts`, así que
mandar la etiqueta desde el backend duplicaría en dos idiomas la misma tabla de traducción, con el
riesgo de que divergieran. Lo deriva `toWizardStep`.

`PASSWORD_ENV_KEY_PATTERN` y `MIN_POLL_INTERVAL_MS` se replican del DTO backend. La copia no es
redundante: sin ellas el formulario dejaría enviar valores que el backend rechaza con un 400, y el
operador vería un error de servidor donde debería haber visto una regla de campo. La prueba 2.4 cubre
cinco claves de entorno ilegítimas, `JWT_SECRET` incluida.

Nota: `npm run lint` reformatea `src/utils/violation-matcher.spec.ts` (prettier, archivo ajeno a esta
rama). Se revirtió para no mezclarlo; volverá a aparecer en cualquier `npm run lint` futuro.

### Próximo paso exacto

**Paso 9:** crear `frontend/src/components/nodes/TriggerImapConfig.vue` (prop única `nodeId`, cero
HTTP, maquetación calcada de `UserDialog.vue`: `.pd-label` + `.pd-required`, inputs `outlined dense`,
`passwordEnvKey` con `.pd-mono`, botón `.pd-btn-primary` con `icon-right="north_east"` y
`:loading="store.isLoading"`) y añadir su entrada a `node-config-registry.ts`.

---

## 2026-09-07 · PROT-12.4 · Componente del trigger, registro de stores y agregador — rama `feat/trigger-imap`

Tercera tanda: la UI del nodo y el agregador del asistente. Con esto el paso 1 del wizard está
completo salvo el anfitrión que lo monta.

### Pasos 9-12 completados

| Archivo | Estado |
|---|---|
| `frontend/src/components/nodes/TriggerImapConfig.vue` | creado |
| `frontend/src/components/nodes/node-config-registry.ts` | +entrada `TRIGGER_IMAP` |
| `frontend/src/components/nodes/node-store-registry.ts` | creado |
| `frontend/src/stores/flujo-draft.store.ts` | creado |
| `frontend/src/stores/flujo-draft.store.spec.ts` | creado (21 pruebas) |

Verificación: **93 pruebas en verde** (6 archivos, +21), `vue-tsc --noEmit` limpio, `eslint src` limpio.

### El «por qué» de tres decisiones

**1. `node-store-registry.ts` es hermano del de componentes, no un duplicado.** El registro de
componentes resuelve *qué* pintar; este resuelve *a quién preguntar* si lo pintado es válido. Hacían
falta los dos: el anfitrión monta el configurador por `nodeType`, pero también tiene que leer el
`isConfigValid` del nodo activo para habilitar el botón Siguiente, y sin este mapa tendría que importar
cada store por su nombre y encadenar condicionales por tipo — exactamente lo que §3.1 prohíbe. Cierra
el TODO que `NodeConfigSandboxPage.vue` dejaba escrito.

El contrato `NodeConfigStore` es deliberadamente estrecho (solo `isConfigValid`): tiparlo así impide que
el anfitrión acabe inspeccionando la `config` interna de un nodo concreto.

**2. El componente no escribe en `config` directamente.** Todos los `q-input` usan `:model-value` +
`@update:model-value` contra `store.patchConfig(...)` en lugar de `v-model`. Con `v-model` sobre
`store.config.host`, Pinia permitiría la mutación pero se saltaría la invalidación de
`connectionVerified`, y el paso quedaría declarándose válido con unas credenciales que ya no son las
probadas. Es el mismo motivo por el que el store canaliza todo por `patchConfig`.

**3. La guarda de avance vive en el store, no solo en el `:disable`.** `goToNextStep()` comprueba
`isActiveStepValid` antes de mover el cursor. El estado del borrador no debe depender de que la vista se
acuerde de deshabilitar un botón; la prueba 4.1 lo fija llamando a la acción directamente.

Un paso cuyo `nodeType` aún no tiene store registrado devuelve `isActiveStepValid: false` (prueba 3.3,
sobre `PARSER_PRE_IA`): sin configurador no hay forma de declararlo válido, y dejar avanzar sería
ensamblar un `pipeline_schema` con un nodo sin configurar.

`upstreamNamespaces(stepIndex)` es la fuente real de lo que `template-mapper.store.ts` tiene hoy como
lista fija marcada PROVISIONAL. Excluye el paso indicado a propósito: un nodo no puede leer su propia
salida (prueba 5.3).

### Próximo paso exacto

**Paso 13:** crear `frontend/src/components/wizard/PipelineSelector.vue` (tarjetas con `--pd-gradient`,
`.pd-h2`, `.pd-subtitle`) y `frontend/src/pages/WizardPage.vue` (Fase 0 vs Fase 1..N con
`<q-stepper vertical animated>` montando `<component :is="nodeConfigRegistry[step.nodeType]" :node-id="step.nodeId" />`,
sin `v-if` por tipo, botón Siguiente con `:disable="!draftStore.isActiveStepValid"`), y registrar la
ruta en `src/router/routes.ts` más el breadcrumb y el `<q-item>` del drawer en `MainLayout.vue`.

---

## 2026-09-08 · PROT-12.3/12.4 · Anfitrión del asistente y cierre de la tanda — rama `feat/trigger-imap`

Cuarta y última tanda: el anfitrión que monta los configuradores. Con esto el asistente recorre de
punta a punta la topología que dicta el pipeline elegido.

### Pasos 13-14 completados

| Archivo | Estado |
|---|---|
| `frontend/src/components/wizard/PipelineSelector.vue` | creado (Fase 0) |
| `frontend/src/pages/WizardPage.vue` | creado (Fase 1..N) |
| `frontend/src/router/routes.ts` | +ruta `flujos/nuevo` |
| `frontend/src/layouts/MainLayout.vue` | +breadcrumb y `<q-item>` del drawer |

Verificación final de ambos lados:

```
Backend   → 384 pruebas · tsc limpio · eslint 0 errores
Frontend  →  93 pruebas · vue-tsc limpio · eslint limpio · quasar build OK
```

El `quasar build` se ejecutó a propósito además del `typecheck`: `vue-tsc` no compila los templates de
los SFC con la misma profundidad que el build real, así que es lo único que garantiza que el `<q-stepper>`
dinámico y el `<component :is>` no tengan errores de plantilla.

### El «por qué» de dos decisiones

**1. Un solo punto de resolución, cero condicionales por tipo.** `resolveStepComponent(step)` es la
única vía por la que `WizardPage` decide qué montar, y no hay ni un `v-if="step.nodeType === ..."` en la
plantilla. Añadir un tipo de nodo es añadir una entrada a cada registro; el anfitrión no se toca. Es
literalmente lo que §3.1 pide y el motivo de que los registros existan.

**2. Un tipo sin configurador avisa, no rompe.** `nodeConfigRegistry` es `Partial` a propósito, así que
un paso `PARSER_PRE_IA` (hoy sin interfaz) renderiza un panel `.pd-card--accent .pd-accent-grave` con
`role="alert"` explicando qué falta, y el botón Siguiente queda deshabilitado porque
`isActiveStepValid` devuelve `false` para un tipo sin store registrado. La alternativa —dejar el paso en
blanco— habría parecido un fallo de carga.

El selector cubre también el catálogo vacío con un estado explícito: sin él, un backend sin flujos
configurados dejaría la vista en blanco y se leería como un error de red.

### Pendientes anotados

- **`upstreamNamespaces` aún no está conectado al mapeador.** El draft store ya lo expone, pero
  `template-mapper.store.ts` sigue usando su lista fija marcada PROVISIONAL. Enlazarlos es una llamada a
  `setAvailableUpstreamNamespaces(draftStore.upstreamNamespaces(index))` desde el anfitrión, y toca un
  componente de otra tanda; queda para la siguiente.
- **El asistente todavía no ensambla ni guarda el `pipeline_schema`.** Recorre y valida los pasos, pero
  falta el `POST` final que persista el flujo con la `config` de cada store de nodo. Es el cierre natural
  de PROT-12.
- **Solo dos de los siete nodos tienen configurador** (`TRIGGER_IMAP`, `MAPEADOR_PLANTILLA`). Cuando
  estén los siete, el `Partial` de ambos registros debe caer para que el compilador exija exhaustividad.
- `npm run lint` reformatea `src/utils/violation-matcher.spec.ts` (prettier, archivo ajeno). Se revierte
  en cada tanda para no mezclarlo.

---

## 2026-09-08 · PROT-12 · Persistencia del flujo (`POST /api/workflows`) — rama `feat/trigger-imap`

Primera mitad del cierre de PROT-12: el endpoint que faltaba para que el asistente pueda guardar lo
que ensambla.

### Pasos 1-5 completados

| Archivo | Estado |
|---|---|
| `backend/src/modules/workflows/dto/create-workflow.dto.ts` | creado |
| `backend/src/modules/workflows/workflows.service.ts` | `createWorkflow()` + `toPipelineSummary()` |
| `backend/src/modules/workflows/workflows.controller.ts` | `@Post()` añadido |
| `backend/src/modules/nodes/services/imap-polling.service.ts` | reconciliación periódica |
| `backend/src/modules/workflows/workflows.service.spec.ts` | +8 pruebas (bloques 7 y 8) |
| `backend/src/modules/nodes/services/imap-polling.service.spec.ts` | +6 pruebas (bloque 4) |

Verificación: **398 pruebas en verde** (23 suites, +14), `tsc` limpio, `eslint src` sin errores.

### Desviación justificada: cómo se registra el sondeo de un flujo nuevo

El enunciado pedía que `createWorkflow` registrase el intervalo invocando `ImapPollingService`. **No se
ha hecho así, y no por comodidad:** `NodesModule` ya importa `WorkflowsModule` (el sondeo necesita
`runAutomaticWorkflow` para despachar lo que detecta), así que inyectar `ImapPollingService` en
`WorkflowsService` crearía un ciclo `workflows ⇄ nodes`. Resolverlo exigiría `forwardRef` en ambos
módulos, o instalar `@nestjs/event-emitter`, que no está en el proyecto.

En su lugar se implementó **reconciliación periódica**: un intervalo `imap-reconcile` (60 s por
defecto, ajustable con `IMAP_RECONCILE_INTERVAL_MS`) que rearma la tabla de intervalos contra `flujos`.
Es estrictamente más robusto que una notificación puntual del alta, porque cubre tres casos que esa no
vería:

- el `pipeline_schema` de un flujo **editado** después de guardarse (host, buzón o periodo nuevos),
- un `activo` cambiado por SQL directo o desde otra vía,
- un flujo **borrado** o desactivado, que debe dejar de sondearse (prueba 4.4).

Coste: latencia de un ciclo hasta que el flujo nuevo entra en sondeo. Aceptable, sobre todo porque un
flujo **nace inactivo** y no sería elegible de todos modos hasta que alguien lo active.

El callback lleva `.catch()` explícito: corre dentro de un `setInterval` y una promesa rechazada sin
manejar termina el proceso en Node ≥ 18 (prueba 4.5).

### El «por qué» de tres decisiones más

**1. El flujo nace INACTIVO.** `flujos.activo` gobierna los disparadores automáticos, y la estrategia
IMAP marca los correos con `\Seen`. Un flujo que se activase solo al crearse empezaría a **consumir el
buzón corporativo** sin que nadie hubiera revisado su configuración, y esos correos no volverían a
verse. `active` es opcional en el DTO con default `false`; activarlo es un acto deliberado posterior.

**2. `pipelineSchema` se declara como objeto y NO con `@ValidateNested()`.** `validateSchema()` ya hace
las dos capas —forma y tipos con `PipelineSchemaDto`, integridad del grafo con
`validatePipelineTopology`— y devuelve `BadRequestException` con la lista exacta de campos inválidos.
Anidar el DTO duplicaría la primera capa y produciría **dos formatos de error distintos** para el mismo
fallo según cuál saltara antes: el del `ValidationPipe` global o el del validador. La prueba 7.1 fija
que la validación ocurre antes de tocar la base de datos, y la 7.2 que se persiste el esquema **ya
validado** y no el crudo del cuerpo (guardar el crudo dejaría en la BD propiedades que `whitelist`
descarta).

**3. `toPipelineSummary` se comparte entre el alta y el listado.** Si divergieran, el cliente tendría
que tratar el flujo que acaba de crear distinto de los que lee del catálogo. Como efecto secundario, el
alta hereda gratis la exclusión de `params` (prueba 8.2).

### Próximo paso exacto

**Paso 6:** crear `frontend/src/services/workflows.service.ts` con `createWorkflow(payload)` contra
`POST /workflows`, tipando el payload como `CreateWorkflowPayload` en `types/pipeline.ts`.

---

## 2026-09-08 · PROT-12 · Ensamblado del esquema y conexión de `upstreamNamespaces` — rama `feat/trigger-imap`

Segunda mitad del cierre: el agregador ya sabe recolectar la configuración de cada nodo y persistir el
flujo, y los nodos ya conocen su contrato aguas arriba de verdad.

### Pasos 6-9 completados

| Archivo | Estado |
|---|---|
| `frontend/src/types/pipeline.ts` | +`CreateWorkflowPayload`, `AssembledPipelineNode`, `AssembledPipelineSchema` |
| `frontend/src/services/workflows.service.ts` | creado |
| `frontend/src/components/nodes/node-store-registry.ts` | contrato ampliado |
| `frontend/src/stores/nodes/trigger-imap.store.ts` | +`toNodeParams()` |
| `frontend/src/stores/nodes/template-mapper.store.ts` | +`toNodeParams()` |
| `frontend/src/stores/flujo-draft.store.ts` | +`assembleAndSaveWorkflow`, `assemblePipelineSchema`, `syncUpstreamNamespaces`, `invalidSteps`, `canSave` |
| `frontend/src/stores/flujo-draft.store.spec.ts` | +15 pruebas (bloques 7, 8 y 9) |

Verificación: **108 pruebas en verde** (6 archivos, +15), `vue-tsc` limpio, `eslint` limpio.

### El «por qué» de cuatro decisiones

**1. `toNodeParams()` en lugar de leer `config`.** El agregador podría haber copiado `store.config` tal
cual, pero eso le obligaría a conocer la forma interna de cada nodo — lo que §3.1 prohíbe. Con este
método el nodo **decide qué publica**, y hay un caso donde `config` y `params` no coinciden: el mapeador
guarda `outputNamespace` en su config para la interfaz, pero en el esquema ese valor es propiedad del
**nodo**, no de sus `params`. Publicarlo en ambos sitios crearía dos fuentes de verdad dentro del mismo
JSON, y nada garantizaría que coincidieran (pruebas 8.1 y 8.2).

Beneficio colateral de tipado: una `interface` no es asignable a `Record<string, unknown>` en
TypeScript por no tener index signature implícita, así que exponer `config` directamente habría exigido
convertir las interfaces de configuración a type aliases o meter un cast.

**2. `setAvailableUpstreamNamespaces` es opcional en el contrato.** No todo nodo depende del contexto:
un disparador es el primero del grafo y no tiene nada aguas arriba que declarar. El anfitrión comprueba
su existencia con `?.()` antes de llamarlo (prueba 7.2).

**3. La sincronización ocurre al elegir el pipeline, no al llegar al paso.** `selectPipeline` llama a
`syncUpstreamNamespaces()` de inmediato: si se esperara a que el usuario llegase al paso del mapeador,
su primera validación se haría contra una lista vacía y avisaría de variables ausentes que sí existen.
Y se recalcula sobre **todos** los pasos al cambiar de pipeline, porque arrastrar la lista anterior le
haría creer a un nodo que `raw_email` existe en un flujo donde nadie lo produce (prueba 7.3).

Esto cierra el pendiente que arrastraba `template-mapper.store.ts`: su `DEFAULT_UPSTREAM_NAMESPACES`
estaba marcado PROVISIONAL y validaba contra namespaces inventados. Ahora un flujo que arranca en
`TRIGGER_IMAP` expone `raw_email` de verdad, y el mapeador puede afirmar que `{{raw_email.subject}}` es
resoluble y que `{{scraped_web.headline}}` no lo es en ese flujo concreto (prueba 7.1).

**4. `invalidSteps` pregunta a TODOS los pasos, no solo al activo.** El asistente permite retroceder,
así que sin esta comprobación se podría guardar un flujo tras haber vaciado un paso anterior ya
visitado. El error nombra los pasos que faltan en lugar de decir «hay errores» (pruebas 9.1 y 9.2).

`onErrorStep` queda en `null` en todos los nodos: el asistente aún no ofrece configurar caminos de
recuperación, y un puntero inventado sería peor que su ausencia — con `null`, el motor detiene la
ejecución en el nodo que falla, que es el comportamiento correcto por defecto (prueba 8.4).

### Próximo paso exacto

**Paso 10:** añadir el paso terminal de «Revisión y Guardado» a `frontend/src/pages/WizardPage.vue`:
campo `name` (requerido) y `description`, resumen de la topología configurada, botón «Crear Flujo»
(`.pd-btn-primary`, `icon-right="north_east"`, `:loading="draftStore.isLoading"`,
`:disable="!draftStore.canSave"`), `$q.notify` de éxito y redirección al catálogo.

---

## 2026-09-08 · PROT-12 · Paso terminal de revisión y cierre — rama `feat/trigger-imap`

Última tanda: el asistente ya guarda. Con esto los tres pendientes que arrastraba PROT-12 quedan
cerrados.

### Pasos 10-11 completados

| Archivo | Estado |
|---|---|
| `frontend/src/pages/WizardPage.vue` | +paso terminal de revisión y guardado |

Verificación final:

```
Backend   → 398 pruebas · tsc limpio · eslint 0 errores
Frontend  → 108 pruebas · vue-tsc limpio · eslint limpio · quasar build OK
```

### El «por qué» de tres decisiones

**1. El nombre se pide AL FINAL, no al principio.** Un asistente que abre pidiendo un nombre obliga a
bautizar algo que todavía no se ha configurado, y el operador acaba escribiendo un placeholder que
nunca corrige. Al pedirlo en la revisión, ya sabe qué hace el flujo que está nombrando.

**2. El paso de revisión NO es un nodo del grafo.** Su índice se deriva de `pipelineTopology.length`, y
por eso `goToNextStep()` no lo alcanza: esa acción está pensada para moverse entre nodos y su guarda
incluye `isLastStep`. El último nodo lleva un botón «Revisar y guardar» que salta al paso terminal con
`onGoToReview`, y el terminal usa `canSave` en lugar de `isActiveStepValid` porque no tiene store de
nodo que consultar. Derivar el índice en vez de fijar una constante mantiene el paso final realmente al
final por muchos nodos que traiga el pipeline.

**3. El aviso de «se creará inactivo» es explícito.** El flujo nace inactivo por decisión de seguridad
(la estrategia marca `\Seen` y consumiría el buzón), pero eso solo es una buena decisión si el operador
lo sabe **antes** de pulsar. Un flujo que se guarda y no se dispara nunca, sin explicación, se lee como
un fallo. El mensaje se repite en la notificación de éxito.

El borrador se limpia antes de navegar: si el operador vuelve al asistente, debe empezar de cero y no
sobre los restos del flujo anterior.

### Estado de los pendientes de PROT-12

- [x] ~~`upstreamNamespaces` sin conectar al mapeador.~~ Resuelto: `syncUpstreamNamespaces()` lo propaga
      al elegir el pipeline, y `template-mapper.store.ts` ya no valida contra su lista PROVISIONAL.
- [x] ~~El asistente no ensambla ni guarda el `pipeline_schema`.~~ Resuelto: `assembleAndSaveWorkflow`
      + `POST /api/workflows`.
- [ ] **Solo 2 de los 7 nodos tienen configurador** (`TRIGGER_IMAP`, `MAPEADOR_PLANTILLA`). Un pipeline
      que incluya cualquiera de los otros cinco no se puede completar: el paso avisa y bloquea el
      avance. Cuando estén los siete, el `Partial` de ambos registros debe caer para que el compilador
      exija exhaustividad.
- [ ] **Sin endpoint para activar un flujo.** Nace inactivo por diseño, pero hoy la única vía de
      habilitarlo es SQL directo. Falta un `PATCH /api/workflows/:id` con la activación, que además es
      donde debería vivir la revalidación del esquema antes de exponerlo a los disparadores.
- [ ] **El disparo sigue siendo en proceso, no encolado** (`architecture-patterns.md` §5 pide BullMQ).
- [ ] **`host` sin lista blanca** en el nodo IMAP: el patrón de `passwordEnvKey` acota qué secreto se
      puede leer, pero un EDITOR sigue pudiendo apuntar el nodo a un servidor arbitrario.
- [ ] `npm run lint` reformatea `src/utils/violation-matcher.spec.ts` (prettier, archivo ajeno).

---

## 2026-09-08 · Correcciones arquitectónicas post-PROT-12 — rama `feat/trigger-imap`

### Paso 0 completado — inyección de `ConfigService` en el sondeo IMAP

| Archivo | Estado |
|---|---|
| `backend/src/modules/nodes/services/imap-polling.service.ts` | `import type` → import de valor |

```
Backend → 398 pruebas · 23 suites · tsc limpio · eslint 0 errores
```

**El «por qué».** `ImapPollingService` importaba `ConfigService` con `import type`. Con
`emitDecoratorMetadata` activo, un `import type` desaparece por completo en la transpilación y el
`design:paramtypes` que Nest lee para resolver el constructor queda en `Object`: **el módulo no
arrancaría en un despliegue real**, con un `Nest can't resolve dependencies`. Las 398 pruebas no lo
detectan porque instancian el servicio a mano pasándole un doble, que es precisamente el punto ciego de
la prueba unitaria frente a un fallo de contenedor.

Se auditaron los otros siete `import type { ConfigService }` del repositorio: todos están en archivos
`*.spec.ts`, donde el símbolo solo se usa como tipo del doble y el `import type` es correcto. Este era
el único archivo de producción con el patrón.

Se descartó añadir `ConfigModule` a los `imports` de `NodesModule`: `app.module.ts` ya lo declara con
`forRoot({ isGlobal: true })`, así que la entrada sería redundante y sugeriría falsamente que el módulo
necesita importarlo para que la inyección funcione — cuando el problema era exclusivamente el import.

**Próximo paso:** objetivo 1 — mover `frontend/src/components/nodes/node-store-registry.ts` a
`frontend/src/stores/nodes/node-store-registry.ts` y actualizar su único consumidor
(`flujo-draft.store.ts:4`).

### Pasos 1-2 completados — capa del registro de stores y depuración del `.env.example`

| Archivo | Estado |
|---|---|
| `frontend/src/components/nodes/node-store-registry.ts` | movido a `frontend/src/stores/nodes/` |
| `frontend/src/stores/flujo-draft.store.ts` | import actualizado a `@stores/nodes/node-store-registry` |
| `backend/.env.example` | sección 4 reducida a `IMAP_UNUWARE_PASSWORD` |

```
Frontend → 108 pruebas · 6 archivos · vue-tsc limpio · eslint limpio · quasar build OK
```

**1. El registro de stores no pertenecía a `components/`.** No importa ni resuelve un solo `.vue`
—solo stores— y su único consumidor es otro store, el agregador del borrador. §3.1 fija la ruta del
registro de COMPONENTES (`components/nodes/node-config-registry.ts`), que sí resuelve componentes y se
queda donde está; para su hermano de stores la capa la manda lo que resuelve, no con quién comparte
nombre. Un solo consumidor a actualizar y ninguna spec importaba la ruta antigua.

**2. Del entorno solo sale el secreto.** `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER` e `IMAP_SECURE` eran
residuo del modelo anterior a las credenciales híbridas: se comprobó que **ninguna línea de `src/` las
lee** (las únicas claves IMAP que el código resuelve son `IMAP_POLLING_ENABLED` e
`IMAP_RECONCILE_INTERVAL_MS`, de la sección 8). Mantenerlas en la plantilla enseñaba un modelo de
configuración que el código ya no implementa, y era una invitación a que alguien las rellenase esperando
que surtieran efecto. Host, puerto, usuario, buzón y periodo son configuración POR FLUJO y viven en el
`params` jsonb del nodo; dos flujos pueden vigilar dos buzones distintos en el mismo despliegue.

`IMAP_PASSWORD` se renombra a `IMAP_UNUWARE_PASSWORD` para que la plantilla muestre el patrón real
(`IMAP_*PASSWORD`) con un nombre de buzón concreto en vez de un genérico que se lee como «la» clave
IMAP del sistema. El bloque `SMTP_*` se conserva íntegro: lo consume `EmailService` para los OTP y sí es
configuración del servidor.

⚠️ **Acción manual pendiente del desarrollador:** renombrar `IMAP_PASSWORD` → `IMAP_UNUWARE_PASSWORD`
en el `backend/.env` real y usar ese nombre en el campo `passwordEnvKey` del asistente. Editar `.env`
exige reiniciar Nest.

Nota de formato: `npm run lint` (prettier) reflowó a 100 columnas seis archivos creados en la tanda
anterior de esta misma rama. Se conservan los reformateos —son los que el formateador del proyecto
impone— a diferencia de `src/utils/violation-matcher.spec.ts`, que es ajeno a la rama y se revierte en
cada ronda.

**Próximo paso:** objetivo 3a — envolver el setup de `trigger-imap.store.ts` y `template-mapper.store.ts`
en una factoría `defineStore(\`<id>:${nodeId}\`)` memoizada, y cambiar `NodeStoreHook` a
`(nodeId: string) => NodeConfigStore` con `resetConfig` obligatorio en el contrato.

### Pasos 3a-3d completados — aislamiento de la configuración por `nodeId`

| Archivo | Estado |
|---|---|
| `frontend/src/stores/nodes/trigger-imap.store.ts` | factoría `defineStore` por `nodeId` |
| `frontend/src/stores/nodes/template-mapper.store.ts` | factoría `defineStore` por `nodeId` |
| `frontend/src/stores/nodes/node-store-registry.ts` | `NodeStoreHook` recibe `nodeId`; `resetConfig` obligatorio |
| `frontend/src/stores/flujo-draft.store.ts` | `nodeId` propagado + `resetNodeStores()` |
| `frontend/src/components/nodes/TriggerImapConfig.vue` | store resuelto con `props.nodeId` |
| `frontend/src/components/nodes/TemplateMapperConfig.vue` | store resuelto con `props.nodeId` |
| `frontend/src/pages/nodes/NodeConfigSandboxPage.vue` | `SANDBOX_NODE_ID` compartido por componente y store |
| `frontend/src/stores/nodes/trigger-imap.store.spec.ts` | 15 llamadas con `NODE_ID` |
| `frontend/src/stores/nodes/template-mapper.store.spec.ts` | 3 llamadas con `NODE_ID` |
| `frontend/src/stores/flujo-draft.store.spec.ts` | topología con constantes + bloque 10 (5 pruebas) |

```
Backend   → 398 pruebas · 23 suites · tsc limpio · eslint 0 errores
Frontend  → 113 pruebas · 6 archivos · vue-tsc limpio · eslint limpio · quasar build OK
```

### El «por qué» de cuatro decisiones

**1. La premisa reportada no era el defecto.** Se pedía corregir una acción de guardado que sobrescribía
el diccionario `nodes` del pipeline. Esa acción no existe: `assemblePipelineSchema` construye un
diccionario **local y nuevo** en cada llamada, lo puebla por llave (`nodes[step.nodeId] = …`)
recorriendo la topología completa, y `nextStep` ya apuntaba al `nodeId` siguiente del arreglo —
invariante que la prueba **8.3** fijaba ya en verde. La solución prescrita *era* la implementación.

Lo que sí producía el síntoma («el nodo anterior desaparece») eran dos defectos adyacentes, y son los
que se corrigen. La prueba **10.3** queda como candado de la invariante que se creía rota: verifica que
los N nodos de la topología sobreviven al ensamblado y que la cadena está completa de punta a punta.

**2. La identidad del estado de un nodo es su `nodeId`, no su `nodeType`.** `resolveNodeStore` resolvía
un singleton de Pinia por tipo, así que un pipeline con dos disparadores IMAP contra buzones distintos
compartía **una sola instancia**: configurar el segundo borraba los `params` del primero, y el esquema
ensamblado salía con la misma configuración duplicada en ambos nodos. La topología canónica de Notiweb
no repite tipos, de modo que el defecto estaba latente esperando el primer flujo que lo hiciera.

Se eligió **instancia por nodo** (`defineStore(\`<prefijo>:${nodeId}\`)` con la definición memoizada)
frente a un `Record<nodeId, Config>` dentro de un store único. Con la instancia por nodo el cuerpo del
setup no cambia una línea y el contrato del anfitrión sigue siendo un `boolean` plano; con el
diccionario habría que rekeyar `isConfigValid`, `isLoading` y `connectionVerified`, y cada `computed`
pasaría a ser una función que devuelve un `computed` por nodo. El estado que se corrige no debía
complicar la lectura de lo que ya funcionaba.

Se memoiza la **definición** y no la instancia: de la instancia ya se encarga Pinia, que cachea por id.
Lo que hay que evitar es reconstruir la definición en cada render, que descarta la identidad
referencial del hook. Coste declarado: dos nodos mapeadores en el mismo flujo piden el catálogo de
plantillas una vez cada uno.

Contrapartida del HMR: con ids dinámicos no hay una definición única que declarar al cargar el módulo,
así que `acceptHMRUpdate` se arma sobre cada definición nueva. Vite conserva un solo callback
self-accept por módulo, de modo que hot-recarga el último nodo creado —en la práctica el que se está
configurando— y los demás exigen recarga completa.

**3. La instancia del store sobrevive a la topología que la creó.** Vive en la instancia de Pinia, no
en el borrador, así que `resetDraft()` vaciando `pipelineTopology` no limpiaba nada: crear un flujo y
volver al asistente arrancaba con los `params` del anterior ya cargados y `canSave` en `true` sin que
el operador hubiera tocado un campo — el escenario exacto en el que un guardado accidental publica la
configuración equivocada. `resetNodeStores()` recorre la topología **antes** de vaciarla (una vez vacía
ya no hay a quién preguntar) y se invoca también en `selectPipeline`, porque cambiar de pipeline
abandona una topología cuyos stores no deben sobrevivirle.

**4. `resetConfig` pasa a ser obligatorio en `NodeConfigStore`.** Es lo que necesita la limpieza
anterior, y exigirlo por tipo obliga a cualquier store de nodo futuro a implementarlo en vez de dejar
una fuga silenciosa. `setAvailableUpstreamNamespaces` sigue opcional: un disparador es el primero del
grafo y no tiene nada aguas arriba que declarar. Al cambiar la firma de `NodeStoreHook`, el compilador
enumeró los 20 puntos de llamada afectados — el tipo hizo de lista de tareas.

Nota de método: las cuatro pruebas de aislamiento (10.1, 10.2, 10.4 y 10.5) se comprobaron contra la
implementación anterior antes de dar el paso por cerrado. Las cuatro fallan sin su corrección; 10.3
pasa en ambas, que es precisamente su papel de candado.

**Próximo paso:** ninguno pendiente de esta tanda. Los pendientes abiertos del proyecto siguen siendo
los cinco listados al cierre de PROT-12, con el `PATCH /api/workflows/:id` de activación como el de
mayor prioridad: la vía de creación termina hoy en un flujo que nadie puede habilitar desde la interfaz.

---

## 2026-09-08 · Estandarización de `refresh_tokens` → `tokens_sesion` — rama `feat/trigger-imap`

| Archivo | Estado |
|---|---|
| `init.sql` | tabla, PK e índice renombrados + nota sobre las constraints |
| `db/migrations/009-tokens-sesion.sql` | creado |
| `db/migrations/001-refresh-tokens.sql` | nota de obsolescencia (solo cabecera) |
| `db/migrations/004-device-id-refresh-tokens.sql` | nota de obsolescencia (solo cabecera) |
| `backend/src/modules/auth/entities/refresh-token.entity.ts` | `@Entity`, PK e `@Index` |
| `backend/src/modules/auth/services/refresh-token.service.ts` | comentario |
| `backend/src/modules/auth/interfaces/jwt-payload.interface.ts` | TSDoc |
| `PLAN.md` | §2.6, línea 145 y §14 |

```
Backend → 398 pruebas · 23 suites · tsc limpio · eslint 0 errores
```

### El «por qué» de cuatro decisiones

**1. El renombrado toca seis objetos, no dos.** `ALTER TABLE … RENAME TO` en PostgreSQL **no arrastra
los índices ni las constraints**: se quedan con el nombre autogenerado a partir del nombre viejo de la
tabla. Como `init.sql` no las declara explícitamente, PostgreSQL las deriva allí del nombre nuevo, de
modo que un clonado nuevo obtiene `tokens_sesion_pkey`, `tokens_sesion_hash_token_key` y
`tokens_sesion_id_usuario_fkey` mientras una base migrada conservaría los tres `refresh_tokens_*`.
Renombrar solo tabla y columna habría dejado las dos rutas de creación divergentes — exactamente la
deriva que este repositorio evita manteniendo el DDL duplicado a propósito en `init.sql` y en
`db/migrations/`. La 009 renombra tabla, columna PK, índice y las tres constraints.

El nombre del índice además importa desde el código: la entidad lo declara con
`@Index('idx_tokens_sesion_id_usuario')`.

**2. El código se queda en inglés, y no es un renombrado a medias.** Las columnas de esta tabla ya
seguían la convención castellana (`id_usuario`, `expiracion`, `revocado`, `fecha_creacion`); lo que
quedaba fuera era el nombre de la tabla y de su PK, la última excepción del esquema. La clase
`RefreshToken` **ya cumplía** `code-conventions.md` §1, igual que `User`/`usuarios` y `Workflow`/`flujos`:
esquema en castellano, identificadores de código en inglés, puente en `@Entity()` / `@Column({ name })`.
Renombrar la clase, los archivos o el `RefreshTokenService` habría roto la norma en vez de aplicarla, y
habría dejado esta entidad como la única asimétrica de las nueve.

Por el mismo motivo no se toca el contrato HTTP (`POST /auth/refresh`, `POST /auth/logout`, campo
`refreshToken`): además de ser identificadores de código, cambiarlos invalidaría las sesiones ya
guardadas en `localStorage` y obligaría a un cambio coordinado en cinco archivos del frontend para una
ganancia nula. **Cero cambios en el frontend.** Queda anotado en el TSDoc de la entidad para que el
próximo lector no interprete la asimetría como un descuido.

**3. No se generó una migración de TypeORM porque el proyecto no tiene ese mecanismo.** No hay
directorio `migrations/`, ni `DataSource` de CLI, ni scripts `migration:*`, y `app.module.ts` fija
`synchronize: false` — que debe seguir así. El patrón vigente son archivos `.sql` idempotentes en
`db/migrations/` que aplica el desarrollador, y la 009 lo sigue. Montar el CLI habría dejado una tabla
`migrations` que no conoce ninguna de las ocho migraciones ya aplicadas: un registro de estado que
miente desde el primer día.

Idempotencia: `ALTER TABLE IF EXISTS … RENAME TO` y `ALTER INDEX IF EXISTS` lo son por sí mismos, pero
`RENAME COLUMN` y `RENAME CONSTRAINT` **no admiten `IF EXISTS`** para su objeto y abortarían al
reejecutarse. Por eso esos cuatro van dentro de un bloque `DO $$ … END $$;` con guardas contra
`information_schema` y `pg_constraint`.

**4. Las migraciones 001 y 004 se conservan intactas, solo con una nota.** Son un registro histórico
ordenado y reescribirlas falsearía lo que se ejecutó; sobre una base antigua el orden correcto sigue
siendo 001 → 004 → 009. La nota es necesaria porque la 001 es `CREATE TABLE IF NOT EXISTS
refresh_tokens`: replayarla sobre una base posterior a la 009 no ve `tokens_sesion` y crearía **en
silencio** una segunda tabla vacía con el nombre viejo.

### Lo que las pruebas NO demuestran

Las 398 pruebas pasan, pero **habrían pasado igual con el nombre de tabla equivocado**: las specs de
autenticación mockean el repositorio de TypeORM, así que ejercitan la lógica y no el mapeo
objeto-relacional. Ninguna referencia nombres de tabla, columna o índice (verificado por grep), y por eso
no hubo ni una spec que adaptar. La única verificación real del renombrado es aplicar la 009 y ejecutar
un login.

Nada se ha ejecutado contra PostgreSQL: la infraestructura de base de datos la administra el
desarrollador, y el servidor MCP `postgres-protodo` estaba caído en esta sesión (`CONNECTION_CLOSED`).

### Pendiente inmediato

- [ ] **Aplicar `db/migrations/009-tokens-sesion.sql`.** El repositorio queda en un estado que lo
      **exige antes de volver a arrancar el backend**: la entidad ya apunta a `tokens_sesion`, así que
      hasta aplicarla cualquier login o renovación falla con
      `relation "tokens_sesion" does not exist`. Mismo aviso que llevaba la 004 en su día.

      ```bash
      sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
        < db/migrations/009-tokens-sesion.sql
      ```

      Los dos `SELECT` finales deben mostrar `id_token_sesion` en primera posición y los cinco
      índices/constraints con prefijo `tokens_sesion` / `idx_tokens_sesion`. Reejecutarla una segunda
      vez debe terminar sin error.

---

## 2026-09-08 · Plantillas de flujo: separación blueprint / instancia — rama `feat/trigger-imap`

### Paso 1 completado — esquema, entidades y helper de topología

| Archivo | Estado |
|---|---|
| `db/migrations/010-plantillas-flujo.sql` | creado |
| `init.sql` | tabla `plantillas_flujo` + `flujos.id_plantilla_origen` + índice |
| `backend/src/modules/workflow-templates/entities/workflow-template.entity.ts` | creado |
| `backend/src/modules/workflows/entities/workflow.entity.ts` | `templateId` + `@ManyToOne` |
| `backend/src/core/fsm/utils/pipeline-topology.util.ts` | creado (extraído del servicio) |
| `backend/src/core/fsm/utils/pipeline-topology.util.spec.ts` | creado, 7 pruebas |
| `backend/src/modules/workflows/workflows.service.ts` | consume el helper |

```
Backend → 405 pruebas (antes 398) · 24 suites · tsc limpio · eslint 0 errores
```

### El «por qué» de cuatro decisiones

**1. Blueprint e instancia eran la misma fila.** La Fase 0 del asistente listaba flujos ya instanciados
con esquema (`findSelectablePipelines()`) y clonaba su topología. Consecuencias: editar el flujo del que
otros partieron cambiaba la plantilla de facto, y no había manera de tener un maestro que no se pudiera
disparar. `plantillas_flujo` es el catálogo de topologías base y no se ejecuta nunca: no tiene autor,
ni estado, ni ejecuciones.

**2. `flujos.id_plantilla_origen` es trazabilidad, no dependencia.** El flujo conserva su propia copia
del grafo en `configuracion_pipeline`, así que editar la plantilla después **no** altera los flujos que
ya salieron de ella. Esa independencia es el sentido de separar las dos cosas: si el flujo leyese el
grafo del maestro, retocar un blueprint cambiaría el comportamiento de flujos en producción.

Nullable por dos motivos distintos: los flujos anteriores a la 010 no vienen de ningún maestro, y el
asistente debe poder crear uno desde cero. Un `NOT NULL` habría obligado a inventar una plantilla para
las filas históricas. Sin lado inverso `@OneToMany`: nadie navega plantilla → flujos y declararlo
cerraría un ciclo de imports entre las dos entidades.

**3. La columna JSONB se llama `configuracion_pipeline`, no `pipeline_schema`.** Es una desviación
deliberada del enunciado: sería la única columna con nombre inglés del esquema, y compartir el nombre
con `flujos` es lo que hace legible el clonado. Aquí sí es `NOT NULL`, a diferencia de `flujos`: un
flujo sin esquema es un borrador legítimo del asistente, pero una plantilla sin topología no es una
plantilla. También `nombre VARCHAR(100)` y no 120 como `plantillas_html`: el nombre del blueprint se
propone como nombre del flujo, y `flujos.nombre` es `VARCHAR(100)` — con 120 un nombre válido de
plantilla no cabría en su instancia.

**4. `buildOrderedTopology` sale del servicio.** Era un método `private` de `WorkflowsService`, y las
plantillas necesitan exactamente el mismo recorrido `entrypoint → nextStep` para exponer su topología al
selector. Duplicarlo dejaría dos lecturas del mismo grafo divergiendo en silencio. Vive ahora en
`@core/fsm/utils/` como función pura con un callback `onTruncated` opcional: el aviso del puntero
huérfano queda en manos del llamante, que es quien sabe si el esquema roto es de un flujo o de una
plantilla. Su tipo de retorno se declara en el propio util y no se importa de `@modules/workflows`,
porque `@core` no puede depender de un módulo funcional sin invertir las capas.

Las 7 pruebas nuevas cubren lo que antes solo se probaba de forma indirecta: el orden real frente al de
las claves del mapa (el fixture declara los nodos en orden inverso al de ejecución), el corte
anticiclos, el truncado ante un puntero huérfano y el callback de aviso.

**Próximo paso:** paso 2 — `backend/src/modules/workflow-templates/` con sus DTOs, servicio (con
`PipelineValidatorService` y `assertNameAvailable`), controlador (`@Roles(ADMIN)` en las escrituras vía
`getAllAndOverride`), módulo, registro en `AppModule` y `workflow-templates.service.spec.ts`.

### Paso 2 completado — módulo `WorkflowTemplates`

| Archivo | Estado |
|---|---|
| `backend/src/modules/workflow-templates/dto/create-workflow-template.dto.ts` | creado |
| `backend/src/modules/workflow-templates/dto/update-workflow-template.dto.ts` | creado |
| `backend/src/modules/workflow-templates/dto/workflow-template-response.dto.ts` | creado |
| `backend/src/modules/workflow-templates/workflow-templates.service.ts` | creado |
| `backend/src/modules/workflow-templates/workflow-templates.controller.ts` | creado |
| `backend/src/modules/workflow-templates/workflow-templates.module.ts` | creado |
| `backend/src/modules/workflow-templates/workflow-templates.service.spec.ts` | creado, 24 pruebas |
| `backend/src/app.module.ts` | registra `WorkflowTemplatesModule` |
| `backend/src/modules/workflows/workflows.service.spec.ts` | fixture con `templateId`/`template` en null |

```
Backend → 429 pruebas (antes 405) · 25 suites · tsc limpio · eslint 0 errores
```

### El «por qué» de cuatro decisiones

**1. Lectura para EDITOR, escritura solo para ADMIN.** Es la diferencia con `TemplatesController`, que
admite ambos roles en todo. El selector de la Fase 0 del asistente lo usa un EDITOR, así que el `GET`
tiene que estar abierto; pero redefinir el maestro del que parten todos los flujos es más poderoso que
editar un flujo suelto —cambiar la topología base decide qué nodos existen en cada flujo que alguien
cree después. Los `@Roles(UserRole.ADMIN)` de método ganan al de clase porque `RolesGuard` resuelve con
`getAllAndOverride`; los guards siguen declarados a nivel de clase para que un endpoint futuro no nazca
desprotegido.

**2. Dos DTO de respuesta, no uno.** El listado (`WorkflowTemplateResponseDto`) proyecta la topología y
**omite** `pipelineSchema`, por el mismo criterio que `PipelineSummaryResponseDto`: los `params` de un
TRIGGER_IMAP llevan `host`, `user` y `passwordEnvKey`. Devolverlos en el listado expondría la
configuración de cada nodo de cada plantilla en la petición que el asistente hace en cada arranque. El
detalle (`WorkflowTemplateDetailResponseDto`) sí lo incluye, porque es el objeto que el editor
administrativo edita. La prueba 1.4 fija esa frontera serializando la respuesta y buscando
`passwordEnvKey`.

Reutiliza `PipelineStepDto` de `@modules/workflows` en lugar de declarar su propio paso: es la misma
proyección, y así el frontend usa un único tipo para pintar el stepper venga de una plantilla o de un
flujo.

**3. La validación del grafo es la razón de ser del servicio, no el CRUD.** Una plantilla es el punto de
partida de N flujos, así que un `nextStep` roto aquí se propaga a cada instancia que alguien cree. Se
reutiliza `PipelineValidatorService` —el mismo que valida el esquema de un flujo— para que ambos caminos
exijan exactamente lo mismo; replicarlo abriría la puerta a una plantilla que el catálogo acepta y el
motor rechaza. En `update` se revalida siempre que el grafo viaje.

El nombre se comprueba **antes** del grafo (prueba 3.4 verifica que `validateSchema` no llega a
llamarse): es la validación más barata y la que el usuario corrige más a menudo.

**4. `assertInstantiable` y no un simple `findOne`.** Lo consume `WorkflowsService` en el paso 3 para
comprobar el `templateId` recibido. Una plantilla retirada devuelve 400: permitir instanciarla vaciaría
de sentido el borrado lógico, que existe justo para que deje de usarse. Y el borrado es lógico porque
los flujos instanciados apuntan a la fila con `id_plantilla_origen`.

Nota de método: `update` comprueba `!== undefined` en cada campo y no la veracidad del valor. Es lo que
permite que `{ active: false }` inactive de verdad y que una descripción vacía se guarde vacía; con un
`if (updateDto.active)` ambos casos se ignorarían en silencio. La prueba 4.4 lo fija.

Hallazgo colateral: `npx tsc -p tsconfig.json` (el que incluye las specs) arrastra **26 errores
preexistentes** en `imap-polling.service.spec.ts` y `allowed-ips.service.spec.ts` —varianza de las
firmas de los mocks de TypeORM y un `delete` sobre propiedad `readonly`—, ajenos a esta entrega. La
puerta del proyecto es `tsconfig.build.json`, que excluye specs, y `ts-jest` transpila sin comprobar
tipos (`isolatedModules`). De los 4 errores que aparecían en `workflows.service.spec.ts`, **1 lo
introdujo esta entrega** (el fixture `buildWorkflow` dejó de satisfacer `Workflow` al ganar dos
columnas) y quedó corregido; los otros 3 son de la misma familia preexistente.

**Próximo paso:** paso 3 — `templateId` en `CreateWorkflowDto`, `WorkflowsService.createWorkflow`
validando con `assertInstantiable`, `updateWorkflow` + `UpdateWorkflowDto`, `PATCH /api/workflows/:id`
con la revalidación al activar, y ampliación de `workflows.service.spec.ts`.

### Paso 3 completado — instanciación desde plantilla y habilitación de flujos

| Archivo | Estado |
|---|---|
| `backend/src/modules/workflows/dto/create-workflow.dto.ts` | `templateId?` (`@IsUUID`) |
| `backend/src/modules/workflows/dto/update-workflow.dto.ts` | creado |
| `backend/src/modules/workflows/dto/pipeline-summary-response.dto.ts` | expone `templateId` |
| `backend/src/modules/workflows/workflows.service.ts` | `templateId` en el alta + `updateWorkflow` + `assertActivatable` |
| `backend/src/modules/workflows/workflows.controller.ts` | `@Patch(':id')` |
| `backend/src/modules/workflows/workflows.module.ts` | importa `WorkflowTemplatesModule` |
| `backend/src/modules/workflows/workflows.service.spec.ts` | bloques 9-11, 14 pruebas nuevas |

```
Backend → 443 pruebas (antes 429) · 25 suites · tsc limpio · eslint 0 errores
```

### El «por qué» de cuatro decisiones

**1. El grafo se COPIA en el flujo, no se referencia.** `flujos.configuracion_pipeline` sigue llevando
su propio esquema, e `id_plantilla_origen` es solo trazabilidad de la procedencia. Si el flujo leyese el
grafo del maestro, retocar un blueprint cambiaría el comportamiento de flujos ya en producción — un
cambio a distancia y sin aviso. La independencia es el sentido de separar blueprint e instancia, y la
prueba 9.1 fija que se persiste el vínculo sin que el esquema deje de ser propio.

**2. `UpdateWorkflowDto` no es un `PartialType(CreateWorkflowDto)`.** Ese DTO incluye `templateId`, y el
maestro del que nació un flujo es un hecho histórico: dejar reescribirlo permitiría falsear la
procedencia después de crearlo, que es justo lo que la columna existe para registrar. Se declara a mano
con los cuatro campos editables.

**3. Activar y desactivar no son simétricos.** `assertActivatable` solo se invoca al poner `active:
true`, y hace dos cosas: rechaza un flujo sin `pipeline_schema` (un borrador legítimo del asistente,
pero activarlo dejaría al sondeo disparando ejecuciones que fallan en el primer paso) y **revalida** el
esquema existente, porque la fila pudo escribirse por SQL directo o quedar obsoleta si el contrato del
grafo cambió. Habilitar un flujo lo expone al sondeo IMAP, que lo recoge en su reconciliación de 60 s
sin volver a preguntar nada: este es el último punto de control.

Desactivar, en cambio, no valida nada (pruebas 11.4 y 11.5). Retirar un flujo de los disparadores es la
vía de emergencia para pararlo, y hacerla fallar por un esquema roto sería exactamente lo contrario de
lo que hace falta en ese momento.

**4. Sin `@Delete` en el controlador.** Retirar un flujo es `PATCH { "active": false }`. Un borrado
físico dejaría las ejecuciones ya trazadas apuntando a un flujo inexistente, y la trazabilidad es el
motivo de que `ejecuciones_flujo` exista.

Con esto queda cerrado el pendiente que arrastraba PROT-12: **ya hay endpoint para activar un flujo**.
Nacía inactivo por diseño y hasta ahora la única vía de habilitarlo era SQL directo.

La comprobación de la plantilla va **antes** de validar el grafo (prueba 9.3 verifica que
`validateSchema` no llega a llamarse): es una consulta barata y un `templateId` equivocado invalida la
petición entera. `assertInstantiable` rechaza además las plantillas retiradas, porque permitir
instanciarlas vaciaría de sentido el borrado lógico.

**Próximo paso:** paso 4 — frontend completo: tipos, `workflow-templates.service.ts`, absorber
`pipelines.service.ts` en `workflows.service.ts`, tres stores (`workflow-templates`, `workflows` y el
refactor de `flujo-draft` con clonado inmutable), las vistas `/flujos` y `/plantillas-flujo`, router,
`MainLayout` y las pruebas de Vitest.

### Paso 4 completado — frontend: catálogo de flujos, CRUD de plantillas y asistente repuntado

| Archivo | Estado |
|---|---|
| `frontend/src/types/pipeline.ts` | `WorkflowTemplateSummary`/`Detail`, payloads y `templateId` |
| `frontend/src/services/workflow-templates.service.ts` | creado |
| `frontend/src/services/workflows.service.ts` | absorbe `fetchWorkflows` + `updateWorkflow` |
| `frontend/src/services/pipelines.service.ts` | **eliminado** |
| `frontend/src/stores/workflow-templates.store.ts` | creado |
| `frontend/src/stores/workflows.store.ts` | creado |
| `frontend/src/stores/flujo-draft.store.ts` | parte de plantillas, con clonado inmutable |
| `frontend/src/components/workflows/WorkflowsManager.vue` · `WorkflowDialog.vue` | creados |
| `frontend/src/components/workflow-templates/WorkflowTemplatesManager.vue` · `WorkflowTemplateDialog.vue` | creados |
| `frontend/src/pages/workflows/WorkflowsPage.vue` · `workflow-templates/WorkflowTemplatesPage.vue` | creados |
| `frontend/src/components/wizard/PipelineSelector.vue` | recibe `templates`, estado vacío con salida |
| `frontend/src/pages/WizardPage.vue` | Fase 0 desde plantillas; tras guardar va a `/flujos` |
| `frontend/src/router/routes.ts` · `layouts/MainLayout.vue` | dos rutas, drawer y migas |
| `frontend/src/stores/flujo-draft.store.spec.ts` | adaptada + bloques 11-12 |
| `frontend/src/stores/workflow-templates.store.spec.ts` · `workflows.store.spec.ts` | creadas |

```
Backend   → 443 pruebas · 25 suites · tsc limpio · eslint 0 errores
Frontend  → 149 pruebas (antes 113) · 8 archivos · vue-tsc limpio · eslint limpio · quasar build OK
```

### El «por qué» de cinco decisiones

**1. `pipelines.service.ts` se elimina, no se deja como alias.** Apuntaba a la MISMA ruta `/workflows`
que `workflows.service.ts`. `frontend-architecture.md` §1 fija un servicio por dominio, y tener dos fue
literalmente la grieta por la que el asistente acabó leyendo flujos instanciados donde debía leer
plantillas maestras: el nombre `fetchSelectablePipelines` sonaba a catálogo de blueprints y devolvía
instancias. Conservar el archivo habría dejado el mismo malentendido a mano del siguiente.

**2. El clonado inmutable se hace campo a campo, no con `structuredClone`.** Fue el intento inicial y
**falla en ejecución**: los elementos de `availableTemplates` vienen envueltos en el Proxy reactivo de
Vue, y `structuredClone` lanza `DataCloneError` sobre un Proxy. Lo detectaron las 37 pruebas del
borrador al ponerse rojas de golpe. La copia explícita (`{ nodeId, nodeType, outputNamespace }`) es
además mejor que el clon genérico: el literal obliga al compilador a exigir aquí cualquier campo que
`PipelineStep` gane en el futuro, en vez de copiarlo por referencia sin avisar.

Las pruebas 11.1-11.3 fijan las tres consecuencias: objetos distintos con los mismos valores, mutar el
borrador no toca el catálogo, y reelegir la misma plantilla arranca de ella intacta y no del recorte
anterior.

**3. La prueba 9.5 cambia de sentido, no se borra.** Antes verificaba que el flujo creado se añadía al
catálogo del asistente. Ahora verifica lo contrario: que **no** se añade, porque ese catálogo son
plantillas y colar ahí una instancia la ofrecería como blueprint — exactamente el error que esta entrega
corrige. El flujo se devuelve al llamante, que navega a `/flujos`.

**4. `/plantillas-flujo` no lleva `requiresAdmin`, aunque las escrituras del backend sí sean de ADMIN.**
Un EDITOR necesita consultar el catálogo para saber de qué puede partir; el 403 en el alta y la edición
lo impone el servidor, que es la autoridad. Bloquear la ruta entera le ocultaría información que sí
puede ver, y duplicaría en el router una regla que ya vive en el controlador.

**5. Activar va por interruptor; desactivar pasa por el temporizador de 5 s.** Habilitar un flujo no
destruye nada y el backend ya lo rechaza si el esquema no es íntegro, así que el `QToggle` basta.
Desactivar corta la ingesta de un flujo en marcha, y eso es una acción crítica: `SafeDeleteModal` con su
cuenta atrás (`frontend-quasar.md` §4). El store escribe siempre la **respuesta del servidor** y no un
parche optimista: activar puede fallar con un 400, y pintar el interruptor en verde antes de saberlo
mentiría sobre el estado real del flujo (prueba 3.3 de `workflows.store.spec.ts`).

El editor de plantillas valida el JSON en el cliente solo en cuanto a FORMA (que parsee y sea un
objeto). La coherencia del grafo la decide `PipelineValidatorService`, que es la única autoridad sobre la
topología; comprobar la sintaxis aquí solo evita gastar una petición en un 400 seguro.

### Pendientes

- [ ] **Aplicar `db/migrations/009-tokens-sesion.sql` y `010-plantillas-flujo.sql`.** Las ejecuta el
      usuario. Hasta la 009 el login falla; hasta la 010 falla cualquier consulta de flujos o
      plantillas. Nada se ha ejecutado contra PostgreSQL.
- [ ] **Sembrar la primera plantilla de flujo.** Hasta que exista una, el asistente muestra su estado
      vacío con el enlace a `/plantillas-flujo`. La topología de Notiweb de 7 nodos está en
      `pipeline-validator.service.spec.ts:15`.
- [ ] Solo 2 de los 7 tipos de nodo tienen configurador (`TRIGGER_IMAP`, `MAPEADOR_PLANTILLA`), así que
      una plantilla que incluya cualquiera de los otros cinco no se puede completar en el asistente.
- [ ] El disparo sigue siendo en proceso, no encolado (`architecture-patterns.md` §5 pide BullMQ).
- [ ] `host` sin lista blanca en el nodo IMAP.
- [ ] 26 errores de tipo preexistentes en dos specs bajo `tsconfig.json` (varianza de mocks de TypeORM);
      la puerta del proyecto es `tsconfig.build.json`, que excluye specs.

---

## 2026-09-08 · Control de estado alineado con el CRUD de usuarios (CU-10) — rama `feat/trigger-imap`

| Archivo | Estado |
|---|---|
| `frontend/src/components/workflows/WorkflowsManager.vue` | badge + par de botones de usuarios |
| `frontend/src/components/workflow-templates/WorkflowTemplatesManager.vue` | idem |
| `frontend/src/components/workflow-templates/WorkflowTemplateDialog.vue` | `q-toggle` retirado |
| `frontend/src/stores/workflow-templates.store.spec.ts` | pruebas 3.7 y 3.8 |

```
Frontend → 151 pruebas (antes 149) · 8 archivos · vue-tsc 0 errores · eslint limpio · quasar build OK
```

### El patrón replicado, verbatim de `UsersManager.vue`

| Estado | Clases | Icono | Acción |
|---|---|---|---|
| Activo | `pd-btn-icon pd-btn-icon--danger` | `block` | `requestDeactivation` → `SafeDeleteModal` (5 s) |
| Inactivo | `pd-btn-icon pd-btn-icon--positive` | `check_circle` | mutación directa |

Ambos con `outline dense size="sm"`, `aria-label` con el nombre del registro y `q-tooltip`. La columna
Estado pasa a `q-badge` con `pd-badge--active` / `pd-badge--inactive`, exactamente como
`body-cell-status` de la tabla de usuarios.

### El «por qué» de tres decisiones

**1. El `q-toggle` no era solo una inconsistencia visual: era un agujero en CU-10.** Convivía con el
botón `block` de la botonera, así que había dos controles para la misma mutación —pero solo uno pasaba
por `SafeDeleteModal`. El interruptor desactivaba un flujo en marcha con un clic, sin cuenta atrás. La
regla §4 exige el temporizador para «toda petición de borrado o desactivación», y el camino corto la
incumplía. Ahora el estado solo se informa y la conmutación vive en un par de botones excluyentes.

**2. La asimetría entre activar y desactivar es la del CRUD de usuarios, no una invención.**
`activateUser` muta directo y `requestDeactivation` abre el modal. Tiene el mismo fundamento aquí:
activar no destruye nada y es reversible, y el único riesgo real —un grafo roto expuesto al sondeo— lo
cubre el backend, que revalida el esquema antes de habilitar. Desactivar corta la ingesta, y un correo
que llegue mientras el flujo está retirado se queda en el buzón sin procesar hasta que alguien lo note.

**3. El editor de plantillas también perdió su interruptor, y por precedente explícito.** `UserDialog.vue`
no expone `isActive`: en el CRUD de usuarios el estado se cambia **solo** desde la tabla. El toggle del
editor de plantillas era una tercera vía de mutar `active` y la más silenciosa —guardar el formulario
con el toggle apagado retiraba la plantilla sin confirmación de ningún tipo. Se sustituye por un badge
de solo lectura que remite al catálogo.

Las pruebas 3.7 y 3.8 son las que hacen sostenible esa retirada: fijan que `saveDraft` conserva el
`active` existente al editar y que un alta nace publicada. Sin ellas, un cambio futuro en `initDraft`
podría reintroducir en silencio la mutación de estado al guardar.

### Lo que las pruebas cubren y lo que no

Vitest corre con `environment: 'node'` y sin `@vue/test-utils`, así que **el par de botones no es
testeable**: es lógica de plantilla y exigiría montar el componente en un DOM. Lo verificado son las dos
premisas de store sobre las que descansa el rediseño (3.7 y 3.8) más la sincronización reactiva, que ya
estaba cubierta (4.1 y 4.3 en plantillas, 3.2 y 3.3 en flujos): el store escribe la respuesta del
backend y no un parche optimista, de modo que el badge se repinta con lo que de verdad quedó guardado y
un 400 deja la fila intacta.

### Nota sobre `.pd-badge--inactive`

Queda con sus tokens originales (`--pd-disabled-bg` / `--pd-disabled-text`), los mismos que usa el badge
«Inactivo» de usuarios y plantillas HTML. Un intento anterior de moverlo a `--pd-surface-muted` se
descartó: es una clase compartida y habría cambiado también `/templates` y `/users`, ajenos a esta
petición.

---

## Adjuntos IMAP: por qué el motor libera el binario y no el nodo

### El problema que se resuelve

`ImapTriggerStrategy` descartaba `parsed.attachments` por completo: un correo con factura
adjunta entraba al pipeline sin su adjunto. Añadir la ingesta es fácil; lo que no es trivial
es el ciclo de vida de esos bytes. Un adjunto de 5 MiB son ~6,8 MB de base64, y
`getAllContext()` reserializa el contexto **entero** en cada `saveCheckpoint` —uno por nodo,
más uno por reintento—. Sin una política de liberación, una sola ejecución escribe decenas de
MB en `contexto_acumulado`.

### Por qué la purga vive en `FsmEngineService`

La primera versión la puso en `ParserEmailStrategy`, que tras procesar el adjunto haría
`context.setNamespace('raw_email', { attachments: purgados })`. Se descartó por tres motivos:

1. **No cumplía el objetivo.** El motor persiste el checkpoint tras *cada* nodo. El base64 se
   escribía en jsonb en el checkpoint posterior al nodo IMAP y solo se limpiaba en el
   posterior al parser: había una ventana en la que los bytes estaban en la base de datos.
2. **Rompe «un nodo, un namespace».** Una estrategia que escribe en un namespace ajeno y
   anterior invierte el contrato de `INodeStrategy`, donde el contexto solo se lee y es el
   motor quien escribe.
3. **No se generaliza.** Obligaría a cada estrategia futura a acordarse de purgar, y a que el
   flujo contuviera un `PARSER_PRE_IA` para que la liberación ocurriese siquiera.

En el motor, la regla se aplica sola a cualquier nodo que declare texto, en un único punto.

### Por qué la condición es «¿hubo texto útil?» y no «¿ya se procesó?»

Purgar incondicionalmente tras el primer nodo destruiría justo el dato que el caso multimodal
necesita: un PDF escaneado no tiene cuerpo textual, y sus bytes son la única fuente de
información del correo. La regla acordada —liberar solo si algún nodo produjo `clean_body`,
`text` o `extracted_text` con contenido— encadena sola:

- Correo **con** cuerpo: el propio `TRIGGER_IMAP` emite `text`, así que los adjuntos se
  liberan en el **mismo** checkpoint que los escribió. El base64 nunca toca PostgreSQL.
- Correo **sin** cuerpo: no se purga, el binario sobrevive, y el parser levanta
  `requires_multimodal_fallback` sobre ese mismo correo. Las dos decisiones coinciden porque
  miran el mismo hecho.

Una cadena en blanco no cuenta como texto: es ausencia de contenido con otra forma, y tratarla
como válida vaciaría el adjunto de un correo que solo trae espacios.

#### La condición no bastó (actualización del 2026-09-18)

Lo anterior se sostenía sobre una coincidencia que dejó de darse. Mientras el parser devolvía
`clean_body: null` en la rama HTML, el correo multimodal conservaba su binario **por
accidente**: nadie declaraba texto. En cuanto el saneador empezó a producir texto real desde
el marcado, ese mismo correo pasó a *declarar* un `clean_body` corto pero no vacío, y para el
motor eso era texto útil. La regla habría purgado los bytes del único correo que los
necesitaba.

Por eso el vocabulario del motor creció en dos direcciones: una clave de **retención**
(`requires_multimodal_fallback`) que veta la liberación, y un **listón de longitud**
(`FSM_MIN_USEFUL_TEXT_LENGTH`, def. 50) por debajo del cual el texto no cuenta. El listón hace
falta además del veto porque `TRIGGER_IMAP` emite `text` y corre *antes* del parser: un
`"Ver adjunto."` de doce caracteres purgaba el PDF escaneado antes de que nadie pudiera
vetarlo, y el veto del parser llegaba sobre un adjunto ya vacío. Ese hueco lo fija la prueba
12.12.

El veto gana sobre el texto cuando llegan juntos. La asimetría es deliberada: un binario no
liberado pesa unos bytes en una fila; uno liberado de más destruye la única copia del dato con
el checkpoint ya escrito.

### El acoplamiento es un nombre de clave, no una dependencia

`ParserEmailStrategy` no sabe que existe la purga. Publica `clean_body` porque es su salida
natural, y el motor reconoce ese nombre como señal de «ya hay texto». El parser se puede
sustituir entero sin tocar el motor, y el motor purga aunque el flujo no tenga parser.

Con el veto siguen siendo nombres de clave, solo que ahora son **dos vocabularios**: uno
positivo (`EXTRACTED_TEXT_KEYS`) y uno negativo (`BINARY_RETENTION_KEYS`). La dirección de las
dependencias no cambia —`@core` no importa nada de `@modules`, los literales se declaran en el
motor y `@modules/nodes` no importa nada del motor para esto—, y cualquier nodo futuro (un
OCR, un transcriptor de audio) puede levantar la misma bandera sin tocar una línea de `@core`.
La única novedad es que el vocabulario, que solo sabía afirmar, ahora también sabe negar.

### El escape que casi se pasa por alto

`logNodeOutcome` pasa `payloadSnapshot: result.data` al volcado forense, que escribe en
`execution-*.log`. Ese archivo rota por tamaño (20m por defecto): una sola línea de 6,8 MB
habría agotado la rotación de golpe, llevándose por delante la traza de todo lo demás. Por eso
la redacción del snapshot es parte del mismo cambio, y sustituye el base64 por
`[base64 omitido]` en vez de por `null`: en un log forense importa distinguir «aquí había
bytes que no se han escrito» de «este adjunto ya venía vacío».

### Decisiones menores con su porqué

- **Opt-in (`includeAttachments: false`).** El coste no se paga donde se ve. Encenderlo por
  defecto habría cambiado el peso de cada fila de `ejecuciones_flujo` en todos los flujos IMAP
  ya guardados sin que nadie lo pidiera.
- **`@Max` sobre `maxAttachmentBytes`.** El campo solo puede *endurecer* el tope de 5 MiB.
  Sin techo, un `500000000` escrito desde el asistente —que un rol EDITOR puede editar—
  convierte una fila en un problema de disco.
- **Presupuesto acumulado.** `maxAttachmentBytes` acota un adjunto; veinte que lo cumplen
  individualmente suman ~130 MB. `MAX_TOTAL_ATTACHMENT_BYTES` acota la suma.
- **Exclusión de los `related`.** `simpleParser` ya incrusta las imágenes referenciadas desde
  el HTML como `data:` URI dentro de `html`. Publicarlas también en `attachments` duplicaría
  los mismos bytes en la misma fila. Se mira `related` y no la mera presencia de `cid`: hay
  clientes que ponen `Content-ID` a adjuntos reales, y esos sí deben viajar.
- **`attachments: []` y nunca ausente.** El payload ya sostenía la regla de que toda clave
  está siempre presente. Que la forma del jsonb dependiera de un booleano de configuración
  haría que cualquier diagnóstico sobre checkpoints históricos empezara por «depende de cómo
  estuviera configurado ese día».

### Lo que las pruebas cubren y lo que no

El bloque 12 de `fsm-engine.service.spec.ts` es el que sostiene la regla: verifica que ningún
`contextPayload` persistido contiene el base64 cuando hubo texto, que sí lo contiene mientras
no lo hubo, que una cadena en blanco no dispara la purga y que un nodo fallido no la dispara
—purgar antes de un fallo dejaría al reintento calculando sobre un adjunto ya vaciado—.

El bloque 3 de `parser-email.strategy.spec.ts` fija la pureza: tras `execute`, el namespace
`raw_email` queda byte a byte igual. Es lo que impide que alguien «optimice» devolviendo la
purga al nodo.

Lo que **no** está cubierto es el extremo a extremo con un buzón real: los dobles de
`imapflow` y `mailparser` fijan el contrato, no el comportamiento de un servidor IMAP
concreto ante un MIME malformado.

Con el saneador se añaden: las pruebas 12.9 a 12.13 del motor —el veto, que sea *positivo
only*, que una cadena `"true"` del jsonb no vete, el listón de longitud y que la variable de
entorno se lea de verdad—, los bloques 6 a 9 de `parser-email.strategy.spec.ts` (saneado,
enlaces, asunto y métricas) y la spec nueva `email-sanitizer.util.spec.ts`, donde viven los
casos exhaustivos de cada expresión regular. El reparto es deliberado: la spec de la
estrategia comprueba que el nodo *compone* bien; la del util, que cada heurística *decide*
bien.

Sigue sin cubrirse un corpus real de correos. Las heurísticas están calibradas contra fixtures
escritos a mano, y ese es el riesgo de producto de la rama: el anti-falso-positivo del RGPD
(prueba 6.7) protege el caso que sabemos nombrar, no los que todavía no hemos visto.

### Deuda consciente — saldada el 2026-09-18

En su día se asumió que `PARSER_PRE_IA` figurase como `implemented: true` en `GET /api/nodos`
sin sanear el marcado, apoyándose en que el esqueleto ya hacía trabajo real (inventario de
adjuntos y decisión multimodal) y en que `body_source: 'html_pending_sanitize'` declaraba
honestamente lo que faltaba.

Esa deuda está saldada: el nodo sanea, `'html_pending_sanitize'` desapareció de la unión —el
valor describía una etapa del roadmap, y mantenerlo sería una mentira en el checkpoint— y el
`implemented: true` pasa a ser honesto sin matices. Queda un residuo sin migración: las filas
ya escritas de `ejecuciones_flujo.contexto_acumulado` pueden contener el literal viejo, así
que cualquier lector futuro que ramifique sobre `body_source` debe tolerar valores fuera de la
unión. Está anotado en el TSDoc del tipo.


---

## 2026-09-18 · Saneado de marcado, enlaces y métricas en `PARSER_PRE_IA` — rama `feat/parser-email`

Cierra la rama que el esqueleto del nodo había dejado abierta: convertir el marcado en texto
aprovechable, extraer los enlaces de contenido, normalizar el asunto y medir la reducción de
caracteres (RNF-01). El payload crece de siete claves a doce y `clean_body` deja de admitir `null`.

### Por qué `cheerio` y no `@mozilla/readability`

Readability está instalado desde hace semanas y era el candidato natural. Se descartó por cuatro
motivos, y el orden importa:

1. Exige un `Document` real, es decir **jsdom completo** dentro del proceso que sostiene el motor.
   Construir un `JSDOM` sobre marcado hostil de correo, en cada correo del sondeo y cada minuto, es
   un sumidero de CPU que se paga donde no se ve.
2. Su algoritmo puntúa densidad de `<p>` y **penaliza tablas**. Un correo de Outlook es,
   estructuralmente, tablas anidadas: el resultado típico es `null` por no alcanzar el
   `charThreshold`, o el pie de página.
3. Necesita `doc.documentURI` para resolver URIs relativas. Un correo no tiene URL base.
4. El payload de `parsed_email` es contrato y tiene que ser **reproducible**. El *scoring* de
   Readability no es estable entre versiones menores.

Hay además un argumento práctico: `transformIgnorePatterns` de Jest ya contempla toda la familia de
`htmlparser2`, y cheerio ya se carga en verde en dos specs. jsdom y Readability son ESM, y el
incidente de `htmlparser2@12` documentado más arriba dice bastante sobre lo que cuesta esa pelea.
Ambos siguen reservados para `EXTRACTOR_WEB`, donde sí hay un artículo y sí hay URL base.

Tampoco se usó `sanitize-html`: es el saneador de lista blanca para marcado **publicable**, y aquí no
se produce marcado sino texto. Se descartan etiquetas enteras, no se filtran atributos.

### El DOM resuelve la estructura; el regex resuelve la prosa

Es la división de trabajo de todo el saneador, y evita el error de intentar hacerlo todo con una de
las dos herramientas. Los contenedores de firma y cita (`.gmail_signature`, `#appendonsend`) son
**estructura**: se resuelven con selectores. `-----Mensaje original-----` y `El … escribió:` son
**prosa**: son texto plano, ningún `blockquote` los envuelve de forma fiable, y buscarlos en el DOM
es perder el tiempo.

Un detalle que costó una prueba: los marcadores de Outlook no *envuelven* la cita, la **preceden**
como hermanos. Borrar el nodo deja el hilo entero dentro del cuerpo. Hay que subir por los ancestros
barriendo los hermanos posteriores en cada nivel — y el barrido va **antes** de comprobar si queda
padre, porque en modo fragmento `parent()` de un elemento de primer nivel devuelve vacío y
comprobarlo en la condición del bucle deja sin barrer justo el último nivel.

El aplanado muta el árbol insertando separadores y lee `$.root().text()`, en vez de recorrerlo
recursivamente. Un *walk* obligaría a tipar los nodos con `Element` de `domhandler`, que es
dependencia transitiva y no declarada — la misma razón por la que `TemplateRendererService` se
estrecha con `'tagName' in element`. Mutar y leer solo necesita selectores.

Las celdas de tabla se separan con **espacio** y no con salto: con `\n` una fila horizontal se
convierte en una columna y una tabla de datos pierde la única estructura que tenía.

### El fallo silencioso del espacio duro

`&nbsp;` decodifica a **U+00A0**, que no es un espacio ASCII. Si la normalización del espacio duro va
después del colapso horizontal, `/[ \t]+/` no lo toca y el cuerpo acaba lleno de blancos invisibles
que inflan `character_count` sin que nada falle. El orden de los siete pasos de `normalizeWhitespace`
está fijado por la prueba 0.6 justamente por esto.

### Por qué la racha final y no todo el cuerpo

La decisión más importante de la rama, y es de producto, no de ingeniería. El corpus son **notas de
prensa institucionales**. Un comunicado sobre una nueva sede que mencione «RGPD» o «protección de
datos» en su tercer párrafo es perfectamente esperable, y barrer por todo el cuerpo destruiría justo
el contenido que el nodo existe para conservar.

Por eso `stripTrailingBoilerplate` recorre **desde el final hacia atrás** y se detiene en el primer
párrafo que no case o que supere los 800 caracteres. Que nada en mitad del artículo se pierda no es
una expectativa: es una propiedad de la construcción. La prueba 6.7 la fija.

El tope de longitud es la segunda red, para el aviso legal pegado al cuerpo sin línea en blanco de
por medio: el párrafo resultante es largo, no se retira, y se prefiere conservar ruido a perder
contenido. Por el mismo criterio se descartaron las heurísticas de teléfono, dirección y cargo para
detectar firmas: en un corpus donde el último párrafo suele ser el contacto del gabinete de prensa,
ese contacto a menudo **es** información que el flujo quiere.

Hay una tercera guarda, simétrica, en el corte de citas: si cortar deja la cabeza vacía **no se
corta**. Un reenvío puro —cuerpo vacío, toda la sustancia dentro de la cita— se quedaría sin nada, y
es preferible entregar la cita que entregar la nada.

### Por qué las URLs relativas se descartan

Un correo no tiene documento base. Absolutizar contra el dominio del remitente fabricaría una
dirección que puede no existir, y `EXTRACTOR_WEB` la descargaría, fallaría y levantaría su alerta.
Las *protocol-relative* (`//host/ruta`) sí se rescatan promoviendo a `https:`, porque ahí el host es
explícito y no se inventa nada.

La recolección va **después** de podar el árbol y **antes** de aplanarlo. Así un enlace de
desuscripción que vivía dentro de una firma ya eliminada no reaparece, y `clean_body` y
`extracted_urls` describen el mismo documento. Devolver ambas salidas juntas desde una sola pasada no
es solo ahorro: parsear dos veces permitiría que discrepasen sobre qué se eliminó.

Los parámetros `utm_*` se retiran por un motivo operativo, no estético: dos enlaces al mismo artículo
que solo difieren en `utm_content` sobreviven a la deduplicación por `Set`, y `EXTRACTOR_WEB` acaba
pagando **dos navegaciones de Playwright** por la misma página. `ref` y `spm` se conservan porque hay
sitios que los usan para enrutar.

**YouTube, TikTok, Threads, WhatsApp y Telegram quedan fuera de la lista social a propósito.** Una
nota de prensa que enlaza un vídeo institucional está enlazando contenido, y este pipeline es de
recorte de prensa. Que nadie los añada «por simetría».

En la ruta de texto plano la lista queda vacía. Rescatar enlaces con un `https?://\S+` es posible,
pero el texto plano parte las URLs con saltos de línea a 78 columnas (RFC 5322) y produciría
direcciones truncadas. Un arreglo vacío y honesto es mejor que una lista de enlaces rotos.

### Por qué `original_character_count` depende de `body_source`

Podría haber sido siempre `html.length`, y habría sido más simple. Sería también inútil: en un correo
`text/plain` puro `html` está vacío, y el porcentaje saldría 0 % por división por cero, ocultando una
reducción real. Al revés, medir siempre contra `text` daría 0 % en la ruta HTML — justo donde la
reducción es del 80-95 % y donde RNF-01 tiene algo que medir.

La pareja `(original, final)` tiene que ser la entrada y la salida de la **misma** transformación. Al
atarla a `body_source`, ambas son auto-consistentes; y comparar dos correos con `body_source` distinto
es comparar cosas distintas, que es precisamente para lo que existe esa clave.

Consecuencia que conviene conocer: **la ruta `'text'` dejó de ser un `trim()`**. También pasa por el
corte de citas, firma y pie legal. Si no, un `text/plain` con cuarenta líneas de hilo citado y un
aviso de confidencialidad entraría entero al prompt, que es exactamente el gasto que el nodo existe
para evitar.

### Por qué el DTO no crece

Se valoraron `stripSignatures` y `filterSocialUrls`, y se descartaron los dos. Cada interruptor
multiplica las formas posibles del payload **histórico**: un `extracted_urls: []` significaría a veces
«no había enlaces» y a veces «alguien apagó la extracción ese día», y ningún checkpoint de hace seis
meses puede distinguirlas. Es literalmente el mismo argumento que ya se escribió para
`attachments: []`.

Además, `stripSignatures: false` no tiene caso de uso: un flujo que quiera la firma quiere el correo
crudo, y ese sigue intacto en `raw_email`. Y `filterSocialUrls` es indecidible desde fuera: quien
configura el flujo no sabe qué enlaces trae el correo. La política «un enlace social no es contenido»
es del nodo, y si algún día resulta equivocada se corrige para todos, no flujo a flujo.

`MAX_EXTRACTED_URLS = 50` va como constante por lo mismo: es un límite de integridad —el arreglo se
reserializa entero en cada checkpoint posterior— y no una preferencia.

Sí cambió un valor: `minBodyLength` baja de 200 a 50. Los 200 estaban calibrados contra texto **sin
sanear**, donde una firma y un pie legal sumaban solos unos 300 caracteres y casi cualquier correo
superaba el listón por puro ruido. Con el saneador, `clean_body` es texto útil.

### El veto de purga y por qué gana sobre el texto

Está desarrollado arriba, en «La condición no bastó». Lo que merece quedar dicho aquí es que **la
regresión la introdujo esta rama**: mientras el parser devolvía `null`, el correo multimodal
conservaba sus bytes por accidente. El veto y el listón no son una mejora oportunista colada en el
commit, son la reparación de lo que el saneador rompía.

Y que el listón de longitud (`FSM_MIN_USEFUL_TEXT_LENGTH`) hace falta **además** del veto, porque
`TRIGGER_IMAP` corre antes que el parser y ya emitía `text`. Va calibrado contra el `minBodyLength`
del nodo, y los dos números tienen que moverse juntos: cualquier hueco entre ellos reabre la ventana
en la que un correo declara texto bastante para tirar los bytes e insuficiente para el modelo.

### Dónde vive el código y por qué

Las heurísticas salieron de la estrategia a `src/modules/nodes/utils/email-sanitizer.util.ts`, con el
precedente de `@core/fsm/utils` y `@common/utils`. Son funciones `string → string`: probarlas a
través de `strategy.execute()` obligaría a construir un `StatePayloadContext` y un `raw_email`
completo en cada assert, y a navegar `result.data?.clean_body` con `?.` para comprobar una expresión
regular. Con el util, `expect(cleanSubject(x)).toBe(y)` cabe en una línea y falla señalando la
heurística, no «el nodo».

Un solo archivo y no tres: las tres piezas comparten la misma pasada de DOM, y partirlo obligaría a
exponer el `CheerioAPI` entre módulos. Vive en `@modules/nodes/utils` y no en `@common` porque es
dominio correo y DOM, no transporte — y porque `EXTRACTOR_WEB` va a necesitar exactamente el aplanado
y la normalización de URLs.

### Lo que las pruebas cubren y lo que no

870 pruebas en 38 suites, todas en verde. El reparto es deliberado: `email-sanitizer.util.spec.ts`
(63 casos) comprueba que cada heurística **decide** bien, con sus tablas `it.each`;
`parser-email.strategy.spec.ts` (43) comprueba que el nodo **compone** bien, con un fixture de correo
de Outlook realista que sostiene a la vez los bloques de saneado, enlaces y métricas.

Lo que **no** está cubierto sigue siendo lo mismo, y conviene no olvidarlo: no hay corpus real de
correos. Las heurísticas están calibradas contra fixtures escritos a mano, así que el
anti-falso-positivo del RGPD protege el caso que sabemos nombrar, no los que todavía no hemos visto.
El primer buzón real será el que diga si los 800 caracteres del tope y la lista de patrones legales
están donde tienen que estar.

---

## 2026-09-18 · Saneado de correo pre-IA en Wizard: tríada modular, endpoint de verificación y banco de pruebas — rama `feat/parser-email-ui`

El nodo `PARSER_PRE_IA` llevaba funcionando desde el commit anterior, pero **no tenía interfaz**, y
eso no era un detalle estético: `WizardPage` lo resolvía contra `nodeConfigRegistry`, no lo
encontraba, y pintaba el panel «Configurador no disponible / No se puede continuar más allá de este
paso». Cualquier plantilla de flujo que incluyera un parser era **imposible de guardar**. Ése era el
desbloqueo real de esta tanda; todo lo demás es lo que hizo falta para que el desbloqueo fuese
honesto.

### Por qué la composición salió de la estrategia

El encargo pedía un servicio de frontend que llamase a «los endpoints de prueba del nodo en NestJS».
No existía ninguno: los once controladores del backend no tocan `ParserEmailStrategy`, y la única vía
HTTP de ejecutarla era `POST /workflows/:id/execute-test`, que exige un flujo persistido, corre el
pipeline entero y choca con el mutex de RNF-09. Había que crear el endpoint, y ahí apareció la
decisión de verdad.

`ParserEmailStrategy` es `@Injectable`, así que invocarla desde `WizardService` obligaba a importar
`NodesModule` — que el TSDoc de `WizardModule` prohíbe explícitamente, porque arrastraría el sondeo
periódico, su repositorio de `flujos` y `WorkflowsModule` detrás. Y había un segundo coste que ese
TSDoc aún no conocía: `INodeStrategy.execute()` exige un `StatePayloadContext`, de modo que el
asistente habría tenido que **fabricar un contexto falso** solo para poder llamar al nodo. Eso no es
reutilizar la lógica, es simular el motor dentro del asistente.

La alternativa perezosa —duplicar la cascada `text→html→none`, el AND multimodal y las métricas en el
service del wizard— es exactamente lo que el TSDoc de `wizard.service.ts` existe para prohibir, y el
síntoma habría sido el peor posible: un banco de pruebas anunciando «reducción 87 %» y la ejecución
real produciendo otra cosa, divergiendo desde la primera corrección.

Así que la composición se extrajo a `parsed-email-payload.util.ts` —`buildParsedEmail`,
`extractEmailBody` y todo lo que era privado de la estrategia— y la consumen las dos capas. **Fichero
nuevo y no dentro de `email-sanitizer.util.ts`** a propósito: el saneador es limpieza de texto y no
depende de nada del módulo, mientras que la composición necesita `ResolvedParserEmailConfig` y
`RawEmailAttachmentMetadata`. Son dos estratos, y el propio TSDoc de la estrategia ya lo afirmaba
(«la maquinaria de limpieza vive en el saneador; aquí queda la composición y el contrato del nodo»).

La prueba de que la extracción no cambió nada es que **`parser-email.strategy.spec.ts` pasa sus 43
casos sin tocar una sola aserción**. Ése fue el primer comando ejecutado tras el refactor, y es la
red que hace la operación defendible.

### Los hooks, o por qué la función no puede tener un `Logger` dentro

Para consumirse desde el wizard sin cablear DI, `buildParsedEmail` tiene que ser pura. Pero la
estrategia sí registraba dos cosas útiles: el aviso de marcado no saneable y el motivo del respaldo
multimodal. La salida es `ParsedEmailHooks`, con `onSanitizeFailure` y `onMultimodalFallback`, que el
llamante enchufa donde quiera. Es el mismo patrón que `createImapClient(config, password, onError)`,
que ya se consumía desde `WizardService` por esta misma razón.

Y tiene un efecto que no era el objetivo pero resultó ser lo mejor del banco de pruebas: el aviso «no
se pudo sanear el marcado», que en producción solo existe en el `.log` del servidor y que nadie que
rellene un formulario llega a ver nunca, aquí viaja en `warnings` y se muestra.

### Por qué `minBodyLength` exige `>= 1` en las dos capas

La especificación inicial pedía `>= 0` en el frontend. El backend tiene `@IsInt` + `@IsPositive`, que
impone `>= 1`, así que un `0` habría pasado la validación del formulario y reventado con un 400 al
guardar. Había dos salidas, y la elegida fue **alinear el cliente sin desvirtuar el DTO**.

Relajar el backend a `@Min(0)` era defendible sobre el papel —«0 significa: no activar nunca el
respaldo multimodal»— pero es una lectura peligrosa: con umbral cero la condición
`bodyLength < minBodyLength` es **imposible de satisfacer**, de modo que un correo cuyo único
contenido real es un PDF escaneado pasaría al modelo de lenguaje sin absolutamente nada que leer, y
el motor habría liberado sus binarios. El `@IsPositive()` no era una restricción arbitraria que
estorbase al formulario: era la que impide configurar un nodo que no puede hacer su trabajo.

De modo que el store replica el mínimo en `MIN_BODY_LENGTH = 1` y el campo lleva `min="1"` con la
regla «El umbral debe ser mayor o igual a 1». Es el mismo criterio con el que
`trigger-imap.store.ts` replica el `@Min(30000)` del backend en `MIN_POLL_INTERVAL_MS`, y por el
mismo motivo declarado allí: **sin la copia, el operador vería un error de servidor donde debería
haber visto una regla de campo**.

### Por qué el sandbox simula el adjunto con un interruptor

El panel de resultados tenía que mostrar `requires_multimodal_fallback`, y esa bandera exige **las
dos** condiciones: cuerpo corto **y** un adjunto de imagen o PDF. Con un banco de pruebas que solo
aceptase texto y HTML, el indicador habría sido una constante muerta en `false`, explicando una regla
que era incapaz de demostrar. Por el mismo motivo se añadió el campo de asunto: sin él `clean_title`
salía siempre vacío, y era otra de las cuatro cosas que el panel debía mostrar.

La forma de simularlo es un `QToggle`, no un selector de ficheros, y la razón es que **la decisión del
nodo solo mira `contentType`, nunca los bytes**. Subir un PDF real al asistente sería pagar megabytes
de base64 —ida y vuelta por la red, más el coste de codificarlo— para producir un booleano. El DTO lo
formaliza: `CheckParserAttachmentDto` no declara `contentBase64`, y como el endpoint valida con
`forbidNonWhitelisted`, enviarlo devuelve un 400. No es una omisión, es una barrera: esta ruta del
asistente no puede aceptar binarios por mucho que alguien lo intente.

Ese mismo razonamiento gobierna los topes de longitud, que `check-imap` no necesita y éste sí.
`sanitizeEmailHtml` monta un árbol DOM con cheerio, **síncrono y en el único hilo del proceso**: un
correo de veinte megabytes bloquearía el bucle de eventos del backend entero durante segundos, y
cualquier EDITOR autenticado tendría una denegación de servicio de una sola petición. Los
`MAX_CHECK_PARSER_BODY_CHARS = 50_000` no son un número redondo elegido al azar: `main.ts` **no
eleva** el límite de `express.json()`, así que su defecto de 100 kB sigue vigente, y un cuerpo por
encima devolvería un 413 crudo de Express **sin** el mensaje en castellano del DTO. El tope tiene que
quedar por debajo contando el escapado JSON, que casi dobla el tamaño en el peor caso.

### Dos registros, y el que se olvida es el caro

La especificación mencionaba `node-config-registry.ts`. Hay un segundo registro obligatorio,
`stores/nodes/node-store-registry.ts`, y dar de alta solo el primero produce el fallo más
desconcertante posible: el formulario se pinta con toda normalidad, el operador rellena los campos, y
el guardado queda bloqueado para siempre con un «Nodo no ejecutable» que no tiene nada que ver con lo
que hay escrito en la pantalla. `flujo-draft.store.ts` lo distingue explícitamente
(`SIN_CONFIGURADOR` frente a `SIN_STORE`) precisamente porque son dos averías distintas.

### El efecto colateral que registrar el nodo provoca

`flujo-draft.store.spec.ts` usaba `PARSER_PRE_IA` como **el ejemplo canónico de tipo sin
configurador**, así que registrarlo rompía tres pruebas con total certeza: la 3.3, la 16.1 y la 16.4.
No era un accidente a parchear, era la señal de que el mundo cambió.

El arreglo elegido **no toca `buildTemplate()`**, porque las pruebas de namespaces aguas arriba
dependen de que el parser siga aportando `parsed_email` antes del mapeador. En su lugar se añadió una
`UNSUPPORTED_TOPOLOGY` local con `EXTRACTOR_WEB`, que sigue sin triada, y se retargetearon solo esas
tres. El criterio: el caso «nodo no ejecutable» tiene que probarse contra un tipo que de verdad no
tenga store, o la prueba pasaría a verificar lo contrario de lo que su nombre dice.

Y se añadió la **16.4.1**, que es el reverso y la que fija el desbloqueo: con la topología por
defecto, `hasUnsupportedNodes` pasa a `false` y ningún paso reporta ya `SIN_CONFIGURADOR`. Sigue
habiendo pasos incompletos —el disparador no se ha configurado— pero eso es una tarea del operador,
no un muro.

### El banco de pruebas mentía, y de paso se arregló

`NodeConfigSandboxPage.vue` importaba `useTemplateMapperStore` directamente, de modo que elegir otro
tipo en el selector montaba su formulario pero dejaba el panel de estado mostrando el del mapeador. El
propio comentario del archivo lo anticipaba («cuando haya varios, el anfitrión resolverá también el
store por tipo»), y la pieza para hacerlo —`resolveNodeStore`— ya existía.

Al arreglarlo apareció algo más: `inspectedState` leía `requiredVariables`,
`missingRequiredVariables` y `availableUpstreamNamespaces`, que **no están en `NodeConfigStore`**. Era
justo la inspección de la configuración ajena que §3.1 prohíbe, y ataba el banco a un tipo concreto,
que es lo contrario de lo que el banco existe para demostrar. Ahora el panel muestra solo el contrato
público, y `setAvailableUpstreamNamespaces` se invoca con `?.()` porque es opcional: un disparador es
el primero del grafo y no tiene nada aguas arriba que declarar. El `SANDBOX_NODE_ID` pasó de
`'nodo_mapeador_demo'` a `'nodo_demo'` por lo mismo — un id único compartido no colisiona, porque cada
store lleva su propio prefijo de Pinia, y es lo que permite alternar entre tipos sin perder lo escrito
en cada uno.

### Detalles menores con razón detrás

- **`toNodeParams()` emite `sourceNamespace` solo si difiere de `raw_email`.** Emitirlo siempre
  congelaría el defecto de hoy dentro de cada `pipeline_schema` guardado, que es el mismo fallo que
  documenta el recalibrado de `DEFAULT_MIN_BODY_LENGTH` de 200 a 50. Omitirlo siempre reescribiría en
  silencio un nodo de autoría manual que leyese de `scraped_web`, dejándolo fallando con
  `ERR_PARSER_SOURCE_MISSING` sin que nadie lo pidiera. La prueba 3.2 del store fija el ida y vuelta.
- **El store del parser no exige haber probado el saneado.** El disparador IMAP sí lo exige, y con
  motivo: unas credenciales equivocadas no fallarían hasta el primer sondeo. Aquí no hay credenciales,
  ni red, ni nada que pueda estar mal sin que el formulario lo vea, y copiar ese Poka-Yoke haría
  imposible guardar un flujo con parser sin tener a mano un correo de ejemplo — una barrera sin
  peligro detrás. La prueba 1.2 existe para que nadie lo «arregle» por simetría.
- **`clean_body` se muestra en un `<pre>`.** Conserva los saltos de párrafo que el saneador
  normalizó, y aplanarlos ocultaría justo la estructura que el nodo produce y que el modelo va a
  recibir.
- **El badge de reducción es verde a partir del 50 % y ámbar por debajo.** Es el criterio de RNF-01
  hecho visible sobre el correo concreto que el operador acaba de pegar. Ámbar y no rojo: quedarse
  corto no es un error suyo, es una propiedad de ese correo.
- **`ParsedEmailPayload` pasó de interfaz privada a exportada.** Era el objetivo —el frontend la
  replica en `types/parser-email.ts`— pero convierte el orden de las doce claves en contrato público.
  La nota está en el TSDoc del util, y la prueba 1.1 de la estrategia es lo único que impide que un
  reordenado pase inadvertido.

### Lo que las pruebas cubren y lo que no

Backend: **40 suites, 913 pruebas**. Añadidas en esta tanda,
`parsed-email-payload.util.spec.ts` (21: las doce claves en orden, la cascada, la división por cero,
el AND multimodal en sus cuatro ramas, los hooks y la degradación ante marcado patológico), el bloque
4 de `wizard.service.spec.ts` (8, incluida la que verifica que este endpoint **no abre ninguna
conexión de red**, a diferencia de su hermano) y `check-parser.dto.spec.ts` (14: el `0` y el decimal
rechazados, los topes con mensaje en castellano, y `sourceNamespace` y `contentBase64` rechazados por
la lista blanca).

Frontend: **15 ficheros, 321 pruebas**. `parser-email.store.spec.ts` aporta 25 en seis bloques, con
el aislamiento por `nodeId` y el contrato de ida y vuelta como los más valiosos.

Lo que **no** está cubierto: `NodeConfigSandboxPage.vue` y `ParserEmailConfig.vue` no tienen prueba
automatizada. Vitest corre con `environment: 'node'` y sin DOM, así que el arreglo del banco y el
render del configurador se verifican a mano. Y sigue sin haber corpus real de correos: las heurísticas
del saneador están calibradas contra fixtures escritos a mano, de modo que el banco de pruebas es hoy
la única forma de enfrentarlas a un boletín de verdad — que es, precisamente, para lo que se
construyó.

---

## Tanda actual — La fuga del contrato de issues y el selector que dejo de adivinar

### El crash de la vista de plantillas no estaba donde parecia

El sintoma era un `TypeError` en el editor JSON al guardar una plantilla invalida, y el arreglo
evidente —una guarda en `locatePath`— tapaba el sintoma sin tocar la causa. La causa es un contrato
que se escapaba por tres rutas de cinco.

`PipelineValidatorService.rejectWith()` lanza sus incidencias en forma **interna**,
`{ field, code, constraints }`. `FsmController` las traducia al contrato publico
`{ path, message }` con `toIssueContract()`, y esa traduccion estaba **solo ahi**: el alta y la
edicion de flujos y de plantillas llaman al mismo validador a traves de sus servicios, y como el
backend no tiene ningun `ExceptionFilter`, el cuerpo interno viajaba literalmente al cliente.
`extractApiIssues()` comprueba que `issues` sea un arreglo pero no la forma de cada elemento, asi que
los dejaba pasar; `locateJsonPaths` leia `issue.path`, recibia `undefined`, y el `split` reventaba
dentro del `watch` de CodeMirror. Se perdia la vista entera en vez de un subrayado. Y la lista de
errores del dialogo, que pinta `issue.path` y `issue.message`, salia en blanco por el mismo motivo.

Se arreglo en las dos capas, y las dos hacen falta:

- **La causa.** `toIssueContractException()` en `schema-issue-contract.util.ts`, invocado desde los
  tres controladores. La traduccion sigue viviendo en el controlador y no en el servicio, que es la
  decision que ya documentaba `FsmController`: cuatro llamadores comparten el validador y cambiarlo
  alli lo cambiaria para todos a la vez.
- **La defensa.** La guarda en `locatePath`. Que el backend haya dejado de emitir esa forma no quita
  que el dato venga de un cuerpo HTTP que TypeScript no puede garantizar, y esta funcion es la unica
  capa que puede resistirlo.

**El helper DEVUELVE la excepcion en vez de lanzarla**, y el llamador escribe
`throw toIssueContractException(error)`. Se intento primero con un `(error: unknown): never` que
lanzaba por dentro, y TypeScript no propaga ese `never` a traves de la frontera del modulo: los cinco
`catch` fallaban con TS2366 por no terminar en un `return`. Anotar el tipo en el `const` tampoco
basto. Con el `throw` a la vista del compilador el problema desaparece y ademas se lee lo que pasa.

Un 400 **sin** issues se devuelve intacto. Un conflicto de nombre o un fallo del `ValidationPipe`
global sobre el DTO de la peticion no tienen nada que traducir, y envolverlos les quitaria su
`message`, que es lo unico que esos errores tienen que decir.

### El extractor web ya no supone quien va delante

`web-scraper.store.ts` declaraba `URL_SOURCE_NAMESPACE = 'parsed_email'` y
`URL_SOURCE_FIELD = 'extracted_urls'`, y ofrecia diez posiciones fijas pasara lo que pasara.
`availableUpstreamNamespaces` —que el asistente ya alimentaba con la topologia real— solo servia para
decidir si pintar un aviso. Consecuencia: un flujo que extrajera sus enlaces de cualquier otro nodo
era inconfigurable, y uno sin parser delante ofrecia diez opciones que ninguna ejecucion podria
resolver.

Ahora las opciones son la **proyeccion de la topologia**: por cada namespace anterior, los campos de
tipo `url` (una opcion) y `url[]` (diez posiciones). Ningun namespace escrito a mano en el archivo.

**El inventario de campos se pidio al backend en vez de replicarlo.** La alternativa era una tabla
`namespace -> campos` en el frontend, derivada de `ParsedEmailPayload` y `ScrapedWebPayload`. Se
descarto: esos payloads los construye la estrategia, y una segunda tabla acaba discrepando de la
primera en cuanto alguien anade una clave. `outputFields` se declara junto al codigo que lo produce y
viaja por el catalogo, que es el canal que ya existia para "que sabe ejecutar el motor".

**Se anadio un canal nuevo en vez de ampliar el existente.** `setAvailableUpstreamNamespaces` entrega
nombres y le basta al mapeador; `setAvailableUpstreamContext` entrega nombres **y** campos y es lo que
el extractor necesita. Sustituir aquel por este obligaria al mapeador a desempaquetar una estructura
de la que ignora la mitad. Ambos son opcionales, el anfitrion empuja los dos, y un disparador —que no
implementa ninguno— no paga nada.

**El componente NO inyecta `useFlujoDraftStore`.** Era la via directa, y rompia dos cosas: el
contrato §3.1 (un configurador consume solo su store) y `NodeConfigSandboxPage.vue`, que monta el
nodo sin asistente y habria mostrado el selector permanentemente deshabilitado. El anfitrion empuja,
el nodo no tira.

### Tres decisiones que cambian comportamiento existente

- **`buildInitialConfig()` arranca con `targetUrl: ''`.** Ya no hay un origen por defecto que valga
  para todo flujo. Un valor prefijado seria una eleccion que el operador no ha hecho y que
  `isConfigValid` tendria que rechazar acto seguido.
- **`hydrateFromNode` conserva el `targetUrl` guardado VERBATIM.** Antes caia a
  `urlTemplateFor(0)` cuando no reconocia el valor, lo que era reescribir en silencio la
  configuracion que el operador venia a revisar: abria el formulario afirmando una eleccion que nadie
  hizo, y guardar la persistia. Ahora se conserva, `hasStaleTargetUrl` lo distingue de "no has
  elegido nada" y `configWarnings` explica que hay que reordenar el flujo o elegir otro origen. El
  paso queda bloqueado, pero **explicado**.
- **`isConfigValid` pasa a tres filtros** y ninguno sobra: no vacio; casa el patron anclado de
  interpolacion (replica del `@Matches` del DTO, de modo que una URL literal heredada se rechace con
  una regla de campo y no con un 400); y pertenece a `urlOptions`. El patron no sustituye a la lista:
  una plantilla hacia un namespace que el flujo no produce es sintacticamente impecable e igual de
  irresoluble.

### El hueco que el validador de topologia tenia abierto

Las directrices pedian construir la validacion DAG desde cero. Ya estaba: `validatePipelineTopology`
implementa siete reglas, incluida la 7 (`detectUnreachableNamespaces`, recorrido
`entrypoint -> nextStep` acumulando lo producido, emitiendo `ERR_MISSING_UPSTREAM_CONTEXT`) y la
guarda de ciclos con un `Set` de visitados, que es mas fuerte que un tope de profundidad.

El hueco real estaba en el **origen** de las dependencias: salian solo de `getRequiredNamespaces`,
que de ocho tipos implementan dos. Un `MAPEADOR_PLANTILLA` —que deliberadamente no lo implementa,
porque sus variables viven en `plantillas_html` y derivarlas seria asincrono— o un tipo aun sin
estrategia podia interpolar `{{scraped_web.url}}` en cualquier clave de sus `params` y guardarse sin
que nadie comprobara nada.

`collectNamespaceRoots` cierra ese hueco barriendo recursivamente los `params`. **Reutiliza
`extractNamespaceRoots` en vez de escribir una regex nueva**, por el mismo motivo que aquella comparte
`INTERPOLATION_PATTERN` con `getInterpolatedValue`: dos expresiones equivalentes acaban divergiendo, y
entonces la validacion aprueba esquemas que la ejecucion no sabe resolver, o al reves. Las dos fuentes
se **suman y deduplican**: `getRequiredNamespaces` sabe cosas que el texto no dice —el parser depende
de `raw_email` aunque su `sourceNamespace` sea implicito, el extractor impone su
`FALLBACK_SCRAPER_NAMESPACE`— y el barrido cubre a todos los demas.

No se creo el decorador de clase `@ValidatePipelineTopology()` ni la `SchemaValidationException` que
las directrices sugerian. El decorador duplicaria la regla 7 y no podria iterar `nodes`, que es un
`Record` y class-validator 0.15.1 solo recorre Array/Set/Map — ese es justamente el motivo
documentado de que la topologia viva en el servicio. La excepcion romperia el contrato
`{ statusCode, error, message, issues }` que cuatro llamadores ya consumen.

### Lo que las pruebas cubren y lo que no

Backend: **47 suites, 1089 pruebas**. Nuevas: seis de `collectNamespaceRoots` (anidamiento, arreglos,
deduplicacion, tipos no textuales y el tope de profundidad), cuatro del segundo canal de la regla 7
—incluida la que fija que un namespace declarado por ambas fuentes aparezca **una sola vez** en el
mensaje—, dos de `outputFields` en el catalogo, y tres de contrato HTTP en
`workflows.controller.spec.ts` que son la regresion directa del crash: reproducen el cuerpo interno
que lanzaba el validador y aseveran que lo que sale lleva `path`/`message` y nunca
`field`/`constraints`.

Frontend: **17 ficheros, 379 pruebas**. `json-path-locator.spec.ts` suma cuatro casos de issues mal
formados, incluido el que conserva los validos que acompanan a uno roto. `web-scraper.store.spec.ts`
pasa de 30 a 42 y es donde esta el grueso: opciones derivadas de `url` y `url[]`, el rechazo de los
campos que no son URL, la reaccion a un cambio de topologia sin recrear el store, la URL literal y la
marca embebida, y la conservacion verbatim de un `targetUrl` huerfano.

Lo que **no** esta cubierto: `NodeConfigSandboxPage.vue` sigue sin prueba automatizada, asi que el
arreglo del banco —que ahora alimenta el canal rico y carga el catalogo al montar— se verifica a
mano. Tampoco hay prueba de extremo a extremo que recorra guardar una plantilla invalida desde la
interfaz hasta el subrayado; las dos mitades del arreglo del crash estan probadas por separado, la
costura no.

---

## Correccion — Tres preguntas distintas que un solo decorador intentaba responder

El sintoma enganaba: los tres constraints de `targetUrl` saltaban **a la vez**, incluido
"debe ser una cadena", y eso solo pasa cuando la propiedad no existe. No era un `targetUrl: ''`,
era un `params: {}` — exactamente lo que `DEFAULT_PARAMS_BY_NODE_TYPE[EXTRACTOR_WEB]` produce.

Chocaban dos cosas que el codigo ya tenia escritas por separado. Una plantilla de flujo es un
blueprint **sin operativa**: lo dice su propio dialogo, y por eso sus `params` van vacios. Pero
`PipelineValidatorService` aplica los `paramsSchema` a plantillas y flujos por igual, y
`WebScraperConfigDto` exigia `targetUrl`. Como EXTRACTOR_WEB es el **unico** de los ocho tipos
que declara `paramsSchema`, era el unico nodo del catalogo que no podia aparecer en una
plantilla. No "con el campo vacio fallaba": no era expresable.

El arreglo no fue relajar el decorador, sino **separar tres preguntas** que estaban fundidas en
el, y poner cada una donde hay informacion para responderla:

| Pregunta | Capa | Por que ahi |
|---|---|---|
| "esto tiene forma de interpolacion" | DTO (`@Matches`) | Es lo unico que se puede decidir viendo un nodo AISLADO |
| "hay de donde sacar una URL en este flujo" | Regla 8 de la topologia | `class-validator` no puede saber quien va delante |
| "esta completo para ejecutarse" | `getIncompleteParams`, al activar | Guardar y activar son dos exigencias distintas |

### El fallback que adivinaba

`getRequiredNamespaces` caia a `FALLBACK_SCRAPER_NAMESPACE = 'parsed_email'` cuando no habia
`targetUrl`, para que ningun extractor quedara sin dependencias declaradas y la regla 7 tuviera
algo que comprobar. Su propio TSDoc reconocia el precio: el fallback **no era una lectura, era
una suposicion**, y el operador acababa leyendo `ERR_MISSING_UPSTREAM_CONTEXT` sobre un namespace
que su esquema nunca menciono.

Se retira. La garantia no se pierde, cambia de pregunta: `requiredUpstreamFieldTypes` declara
`['url', 'url[]']` y la regla 8 comprueba que algun predecesor publique uno de esos tipos,
apoyandose en los `outputFields` que el catalogo ya expone. Se sustituye una suposicion por un
hecho, y el diagnostico pasa de *"necesita [parsed_email]"* a *"ningun paso anterior publica un
campo de tipo [url, url[]]"*, que describe el problema real: el ORDEN del flujo.

La regla 8 es **deliberadamente mas debil** que pedir el valor. No afirma que el nodo este
configurado —un `params: {}` la supera—, solo que el flujo PODRIA configurarse. Esa es justo la
distincion que hacia falta para que una plantilla exista.

### Por que un objeto de resolutores y no un tercer parametro

`validatePipelineTopology(schema, resolvers)` pasa a recibir `{ dependencies, outputFields,
requiredFieldTypes }`. Tres lambdas posicionales en la llamada no dicen cual es cual, y cada una
sigue siendo opcional por separado, de modo que omitir una desactiva solo su regla — que es lo
que permite a las pruebas de las reglas 1 a 6 seguir llamando `validatePipelineTopology(schema)`
a secas, y a las de la 7 no arrastrar issues de la 8.

### La asimetria entre guardar y activar

`ValidateSchemaOptions.requireRunnableParams` lo pide **solo** `assertActivatable`. Un flujo se
guarda a medias porque eso es un borrador, y porque la plantilla de la que nace ni siquiera trae
operativa; activarlo es ponerlo a disparar cada minuto. Se recorre el mapa entero y no solo el
camino activo: activar con una rama de `onErrorStep` a medio configurar es el fallo que se
descubre de madrugada, la primera vez que esa rama se usa.

Se anadio ademas una guarda en `resolveConfig` del extractor: sin `targetUrl` devuelve
`ERR_SCRAPER_CONFIG` nombrando el campo, en vez de dejar que `new URL('')` reviente mas abajo
como `ERR_SCRAPER_URL_MALFORMED` y mande a revisar el formato de una URL que nadie escribio.

### Comportamiento verificado sobre los dos casos reportados

| Escenario | Antes | Ahora |
|---|---|---|
| `TRIGGER_IMAP -> EXTRACTOR_WEB`, plantilla | 3 constraints sobre `targetUrl` | `ERR_MISSING_UPSTREAM_FIELD_TYPE`: ningun paso anterior publica una URL |
| `PARSER -> EXTRACTOR_WEB`, plantilla, guardar | 3 constraints sobre `targetUrl` | Se guarda |
| El mismo esquema, activar | — | `ERR_INCOMPLETE_NODE_PARAMS`: falta `targetUrl` |

Backend **47 suites / 1105 pruebas**; frontend **17 ficheros / 380 pruebas**. Nuevas: ocho de la
regla 8 (incluidas la que exige los DOS resolutores, la que impide que un nodo se satisfaga a si
mismo y la que acepta un `params: {}`), cuatro de la asimetria guardar/activar, y cuatro del
contrato de la estrategia.

Lo que **no** esta cubierto: la costura HTTP sigue sin prueba de extremo a extremo. Y el
frontend no distingue todavia `ERR_MISSING_UPSTREAM_FIELD_TYPE` de los demas issues del esquema:
los pinta en la lista del dialogo como cualquier otro, sin llevar al operador al paso culpable.

---

## Tanda actual — Los tres nodos que producian sin declarar lo que producian

La peticion pedia un endpoint nuevo, `GET /api/fsm/nodes/catalog`, alimentado por una constante
`NODE_OUTPUT_CATALOG` escrita a mano en `src/modules/fsm/constants/`. No se hizo, y conviene
dejar escrito por que: ese directorio no existe —el motor vive en `@core/fsm` y el catalogo en
`@modules/nodes`— y, sobre todo, **la funcionalidad ya estaba, construida al reves**.

`GET /api/nodos` sirve `outputFields` por tipo desde la tanda anterior, y los resuelve
preguntandole a `NodeStrategyFactory` en cada peticion. El argumento contra la tabla estatica ya
estaba escrito en el TSDoc de `INodeStrategy.outputFields` y no ha cambiado: *una fila de catalogo
y un `*-payload.util.ts` son dos fuentes que se desincronizan en cuanto alguien anade una clave, y
la que manda en ejecucion es siempre la segunda*. Una constante habria sido esa segunda fuente.

### El hueco real: 2 de 5

De las cinco estrategias que `NodesModule.onModuleInit` registra, solo `PARSER_PRE_IA` y
`EXTRACTOR_WEB` declaraban su inventario. `TRIGGER_CRON`, `TRIGGER_IMAP` y `MAPEADOR_PLANTILLA`
llegaban al catalogo con `[]` pese a tener claves `data` perfectamente deterministas, escritas
literalmente en el `return` de su `execute`. No era una decision: era el trabajo a medias.

| Nodo | Claves declaradas ahora |
|---|---|
| `TRIGGER_CRON` | `triggered_at`, `cron_expression`, `time_zone`, `next_run_at` |
| `TRIGGER_IMAP` | `message_id`, `from`, `subject`, `text`, `html`, `date`, `attachments` |
| `MAPEADOR_PLANTILLA` | `compiled_markup`, `mapped_at` |

Dos de esas claves no estaban en el enunciado y si en el payload real: `time_zone` en el cron y
`attachments` en el IMAP. Se declaran, porque el inventario describe lo que el nodo escribe, no lo
que alguien recordaba que escribia.

### Por que `status` se queda fuera del inventario de IMAP

`ImapTriggerStrategy` tiene dos vias de exito. La del correo encontrado devuelve las siete claves
de `ExtractedEmail`; la del buzon vacio devuelve `{ status: 'NO_MESSAGES_FOUND' }` **acompanado de
`halt`**. Esa segunda no produce contexto para nadie: el motor cierra la ejecucion en EXITOSO y
ningun nodo de aguas abajo llega a interpolar. Declarar `status` pondria en el selector del
asistente un campo que nunca esta presente cuando hay algo que mapear —un `{{raw_email.status}}`
que resuelve siempre a cadena vacia—, que es la clase de promesa falsa que el Poka-Yoke existe
para no hacer.

### Por que ningun campo de IMAP es `url`

`html` y `text` vienen llenos de enlaces. Aun asi se declaran `text`: contienen direcciones, pero
no **son** una direccion, y extraerlas es trabajo de `PARSER_PRE_IA`, que para eso publica
`extracted_urls` como `url[]`. Declarar `html` como `url` colaria el cuerpo entero de un correo en
el desplegable del EXTRACTOR_WEB, que es exactamente el error de tipeo que la regla 8 del
validador de topologia viene a impedir.

La consecuencia visible es que `TRIGGER_IMAP -> EXTRACTOR_WEB` sigue emitiendo
`ERR_MISSING_UPSTREAM_FIELD_TYPE`, igual que en la entrada anterior. La diferencia es que antes el
diagnostico era correcto por accidente —no habia inventario que consultar— y ahora lo es por
lectura: el inventario existe, se miro, y no hay ninguna URL en el.

### La prueba que de verdad sostiene esto

Declarar una lista a mano junto al codigo que construye el payload sigue siendo dos escrituras que
pueden separarse. Lo que impide que se separen es una prueba por estrategia que ejecuta `execute`
con los dobles que el spec ya montaba y contrasta `Object.keys(result.data)` contra los `name`
declarados. Si manana alguien anade una clave al `data` sin declararla, el spec cae con el nombre
de la clave delante. Es la unica forma de que el inventario no envejezca en silencio, que es como
envejecen los inventarios.

De paso se corrigio el TSDoc de `ParserEmailStrategy`, que decia "las doce claves" sobre un arreglo
de trece desde que se anadieron `requires_multimodal_fallback` y `multimodal_reason`.

### Lo que las pruebas cubren y lo que no

Backend **47 suites / 1114 pruebas** (nueve nuevas); frontend **17 ficheros / 380 pruebas**, sin
cambios: `frontend/src/types/node-catalog.ts` ya replicaba el contrato y ningun store asumia que
tipos publican campos.

Lo que **no** esta cubierto: la costura HTTP sigue sin prueba de extremo a extremo, asi que el
`GET /api/nodos` con los cinco inventarios llenos hay que comprobarlo a mano. Y queda abierta la
deuda de `DEFAULT_UPSTREAM_NAMESPACES` en `template-mapper.store.ts`, que sigue siendo el ultimo
mock del frontend: ahora que los cinco nodos publican campos, el editor de plantillas podria
ofrecer `{{namespace.campo}}` completo en vez de solo el nombre del namespace.

---

## Tanda actual — El mapeador dejo de fiarse del nombre del namespace

La peticion pedia un `getNodeCatalog()` en el servicio del nodo contra
`GET /api/fsm/nodes/catalog`, y en `flujo-draft.store.ts` un estado `nodeCatalog`, una accion
`fetchNodeCatalog()` y un getter `availableInterpolationVariables(currentNodeId)`. No se hizo nada
de eso, y el motivo es el mismo de la tanda anterior: **ya existia, y anadirlo habria creado
segundas fuentes**.

| Lo pedido | Donde ya vivia |
|---|---|
| `getNodeCatalog()` | `node-catalog.service.ts::fetchNodeCatalog()` → `GET /nodos` (la ruta del enunciado no existe) |
| `nodeCatalog` + `fetchNodeCatalog()` | `node-catalog.store.ts`, cargado en paralelo con las plantillas en `loadAvailableTemplates()` |
| Recorrido entrypoint → nodo anterior, cruzado con el catalogo | `upstreamContext(stepIndex)` |
| Empuje a cada nodo | `syncUpstreamNamespaces()`, que ya empujaba los DOS canales a TODOS los stores |

Y una razon de reparto: componer las opciones de `{{ns.campo}}` en el agregador lo obligaria a
saber que forma tiene la configuracion de UN tipo de nodo concreto, que es exactamente lo que
§3.1 prohibe. El getter va en el store del nodo, como `buildUrlOptions()` en el extractor web.

### De "existe el namespace" a "existe el campo"

`missingRequiredVariables` comparaba solo la RAIZ de cada ruta: `path.split('.')[0]` contra la
lista de namespaces. Con eso, una plantilla que interpolara `{{parsed_email.clean_bodyy}}` se daba
por buena con que hubiera un parser aguas arriba. El error sobrevivia a la configuracion, al
guardado y a la activacion, y aparecia en la primera ejecucion como un GRAVE con el flujo PAUSADO.

Ahora hay tres reglas, y la tercera es la que importa:

1. Ningun paso anterior escribe ese namespace → falta. Es lo que ya hacia.
2. El namespace existe y **se conoce su inventario**, pero no publica ese campo → falta. Es el
   grano fino que `outputFields` hizo posible.
3. El namespace existe pero llega con `fields: []` → **se da por satisfecha**.

La tercera no es una concesion: un inventario vacio significa "aun no se que publica" —el catalogo
viajando, o un tipo de nodo que no declara sus campos—, y asi lo fija el contrato de
`UpstreamNamespace`. Tratarlo como fallo pintaria de rojo todas las plantillas mientras dura la
peticion, y para siempre si falla. Es la misma politica que `isNodeTypeImplemented`: ante la duda
no se bloquea.

Las rutas profundas (`llm_response.articles.0.title`) se juzgan por sus **dos primeros
segmentos**. Lo que el nodo publica es `articles`; lo de dentro es la forma de ese objeto, que
ninguna estrategia declara campo a campo, y comparar la ruta entera daria por ausente toda
variable que navegue una estructura.

### El default que mentia

`DEFAULT_UPSTREAM_NAMESPACES = ['parsed_email', 'scraped_web', 'llm_response']` sembraba el store
al construirse. Su TSDoc lo marcaba PROVISIONAL "hasta que exista el asistente", y el asistente
lleva dos tandas empujando el contexto de verdad. Habia dejado de ser un apano para ser una
mentira: hasta la primera sincronizacion el nodo se validaba contra un flujo inventado, y un flujo
que arranca en TRIGGER_CRON daba por resoluble un `{{parsed_email.x}}`. Se retira, igual que se
retiro el `URL_SOURCE_NAMESPACE` del extractor web.

### Por que el aviso de "no hay variables" NO bloquea

El enunciado pedia `isConfigValid = false` cuando no hubiera variables aguas arriba. No se hizo:
una plantilla **estatica** —un pie corporativo, un aviso de cabecera fija— no interpola nada y es
legitima en un flujo que no publique un solo campo. Exigirle contexto seria inventar un requisito
que el motor no tiene. El aviso ambar se muestra (`data-test="no-upstream-variables"`), explica que
una plantilla con variables no podra resolverse ahi, y deja el badge de validez en paz. Lo que si
bloquea sigue siendo el contrato roto, que ahora se detecta mejor.

### Dos fallos, dos mensajes

El banner rojo fundia los dos casos en "faltan estos namespaces". Se separan porque el arreglo es
distinto: si falta el namespace entero hay que **anadir o reordenar un nodo**; si el namespace esta
y el campo no, hay que **corregir la plantilla**. Mandar al operador a revisar la topologia por una
errata en un nombre de campo es hacerle perder la tarde. De ahi `missingUpstreamNamespaces` y
`missingUpstreamFields` como dos derivados distintos, y el tooltip del chip diciendo cual de los
dos es.

### El editor inserta la ruta entera

Los chips de `TemplateEditorDialog` insertaban `{{namespace.}}` y dejaban el caret dentro de las
llaves para que el autor terminara el nombre a mano — que es justo donde se cometia la errata que
el punto anterior detecta. Con un flujo detras, el dialogo recibe `upstreamContext` por prop y
ofrece la ruta completa, insertada con offset `0` porque ya no falta nada que escribir.

La prop es **opcional a proposito**: el gestor de plantillas abre el mismo dialogo sin ningun flujo
detras, y ahi no hay topologia que consultar. Sin contexto se conservan los chips de namespace de
siempre. No es un degradado, es el otro caso de uso.

### Detalles con razon detras

- **`UpstreamNamespace` gana `nodeType`**, opcional. Es lo que permite agrupar el desplegable por
  `parsed_email (PARSER_PRE_IA)` en vez de por el namespace a secas. Opcional porque `_assets` no
  lo escribe ningun nodo. No se deduce invirtiendo `DEFAULT_OUTPUT_NAMESPACE_BY_NODE_TYPE` en el
  consumidor: esa relacion es una CONVENCION y un esquema puede declarar otro `outputNamespace`.
- **`outputNamespace` pasa a `q-select` cerrado.** Era el ultimo campo de texto libre del nodo
  sobre una lista cerrada; una mayuscula o un guion ahi eran un 400 al guardar el flujo entero.
- **El selector de variables NO filtra por tipo**, a diferencia del extractor web: una plantilla
  interpola cualquier cosa que sepa convertirse en texto. El tipo va en la etiqueta —`subject
  (text)`, `attachments (object)`— para que el operador sepa que esta insertando.
- **El componente no carga el catalogo.** El enunciado pedia `fetchNodeCatalog()` en su
  `onMounted`; se omitio porque el catalogo es estado del ANFITRION y los dos que existen ya lo
  piden. Un tercer cargador desde el componente lo haria alcanzar un store global que no es el
  suyo.
- **`data-test` en el contenedor y no en el `<q-select>`.** Quasar derrama los atributos sobre un
  div interno (`.q-field__native`), no sobre la raiz del componente, asi que
  `findComponent('[data-test=…]')` no encuentra nada. Localizar por posicion habria funcionado
  hasta el primer reordenamiento del formulario.

### Lo que las pruebas cubren y lo que no

Frontend **18 ficheros / 405 pruebas** (25 nuevas): 15 en el spec del store —canal rico,
`variableOptions`, las tres reglas del grano fino, `hasUpstreamVariables`— y 10 en
`TemplateMapperConfig.spec.ts`, que no existia. Backend sin cambios.

Lo que **no** esta cubierto: los chips del editor de plantillas con contexto no tienen prueba de
componente —`TemplateEditorDialog` arrastra CodeMirror y el spec del mapeador lo sustituye por un
stub—, y la costura HTTP sigue sin prueba de extremo a extremo.

---

## Tanda actual — El editor de plantillas dejo de pedir que se teclee el campo

Los chips del editor insertaban `{{namespace.}}` y dejaban el caret dentro de las llaves para que
el autor terminara el nombre **a mano**. El coste de ese "a mano" esta medido: el backend valida
solo el NAMESPACE de cada variable, nunca el campo. `extractAndValidateVariables` comprueba el
grupo 1 contra `ALLOWED_NAMESPACES` y acepta el resto de la ruta tal cual —lo dice su propio
TSDoc: *"Se valida la RAIZ de la ruta a cualquier profundidad"*—, asi que un
`{{parsed_email.clean_bodyy}}` se guarda sin protesta y falla en render.

La tanda anterior ensenio a detectar esa errata en el nodo mapeador, cruzando las
`requiredVariables` de la plantilla contra los campos reales del flujo. Esta la impide cometer.

### Un explorador en vez de tres vias de insercion

Se retiran los dos bloques de chips —los planos de `TEMPLATE_NAMESPACES` y los de ruta completa
que la tanda anterior anadio— y en su lugar va una sola secuencia:

```
1. Selecciona Origen / Namespace   ->  2. Campo a inyectar  ->  tarjeta con el token
                                                                 [Copiar] [Insertar]
```

Tres vias conviviendo en una barra lateral que ya compite con el editor no son tres comodidades,
son ruido. Y la mas rapida de las tres era justamente la que permitia la errata.

### De donde salen los origenes: la prop gana al catalogo

El dialogo lo abren dos sitios, y necesitan respuestas distintas:

| Anfitrion | Origenes que ofrece |
|---|---|
| `TemplateMapperConfig` (hay flujo) | Los del `upstreamContext`: lo que ESE flujo publica de verdad |
| `TemplatesManager` (no hay flujo) | El catalogo global: los ocho namespaces mas `_assets` |

La prop manda cuando viene con algo porque es la respuesta mas **especifica**: un flujo concreto
sabe que namespaces tiene y con que campos; el catalogo solo sabe que publicaria cada tipo de nodo
si alguien lo colocara. Y el gestor necesita justo eso ultimo, porque una plantilla suya tiene que
poder escribirse para cualquier flujo futuro.

### La inversion del mapa, subida a `src/utils/`

Resolver "namespace -> campos" sin topologia exige invertir
`DEFAULT_OUTPUT_NAMESPACE_BY_NODE_TYPE`. Esa inversion ya existia **una vez**, como `const` privada
dentro de `NodeConfigSandboxPage.vue`. Hacia falta una segunda, asi que se sube a
`@/utils/upstream-catalog` y el banco pasa a usarla: dos tablas que responden lo mismo discrepan en
cuanto se anade un tipo de nodo, y el TSDoc de `UpstreamNamespace` ya avisaba contra invertir el
mapa "en cada consumidor".

La advertencia sigue en pie y el helper no la contradice. Cuando hay flujo se usa su topologia, que
sabe quien escribe que. El helper responde la otra pregunta, la de quien no tiene flujo: *si
alguien escribiera `parsed_email`, que publicaria*.

`findByCode` entra **por parametro** y no importando el store, para que el helper quede puro y su
spec no necesite Pinia.

### `_assets` tenia que declararse a mano

Es el unico namespace que no publica ningun nodo: lo inyecta `TemplateRendererService` en cada
render, y su unica clave —`base_url`— no esta en el catalogo ni en ninguna lista; solo vivia en la
prosa de un TSDoc y en una linea del renderer. Quitar los chips planos la habria dejado sin
ninguna forma de insertarse. Se declara `ASSETS_FIELDS` en `@/types/html-template`, junto a
`TEMPLATE_NAMESPACES`, asumiendo que es una replica y diciendolo por escrito.

### Por que no se alcanza el `EditorView`

El enunciado pedia tomar la instancia de CodeMirror y despachar la transaccion desde el dialogo.
No hace falta y ademas no se puede: `TemplateCodeEditor` guarda su `view` en una variable privada
del `setup` —con un TSDoc explicando que envolver una instancia imperativa en un proxy reactivo de
Vue es fuente conocida de rarezas— y `defineExpose` publica solo tres metodos. Uno de ellos,
`insertTextAtCursor`, ya hace exactamente lo pedido: reemplaza el rango de
`view.state.selection.main`, recoloca el caret, hace `scrollIntoView` y devuelve el foco que el
clic en el boton acaba de robar.

La seleccion de CodeMirror sobrevive a perder el foco, asi que "la ultima posicion conocida" del
enunciado es precisamente lo que ese metodo usa. El unico caso degradado real es un editor que
nunca ha tenido el foco: ahi la seleccion es `{0,0}` y se inserta al principio, que para una
plantilla nueva es el mismo sitio.

Tampoco habia que tocar nada para que `requiredVariables` se actualice: la insercion despacha una
transaccion -> `docChanged` -> `update:modelValue` -> `updateHtmlContent`, y `detectedVariables` es
un `computed` sobre el borrador. El cableado ya estaba.

### El fallback del store se generalizo

`insertMarker(namespace)` solo sabia componer `{{ns.}}`, asi que la tanda anterior habia dejado en
el dialogo un `marker.replace(/^\{\{|\.[^.]*\}\}$/g, '')` para degradar un marcador completo a su
raiz. Feo y facil de romper. Ahora el store expone `insertTextAtCursor(text, caretOffset)`, que no
conoce la gramatica del marcador, e `insertMarker` delega en el. Sus cuatro pruebas siguen pasando
sin tocarlas.

### Detalles con razon detras

- **El catalogo se pide AL ABRIR, no en `onMounted`.** El dialogo vive montado y cerrado en el
  arbol de sus dos anfitriones; pedirlo al montar seria pedirlo con el gestor recien pintado y
  nadie mirando. La llamada es memoizada, asi que si el asistente ya lo cargo no cuesta peticion.
- **El componente consume el store del catalogo, no su servicio.** La frontera HTTP sigue siendo
  `node-catalog.service.ts`. Es distinto del caso del nodo mapeador, donde se omitio la carga
  porque ahi SI hay un anfitrion que la hace; el gestor de plantillas no tiene ninguno.
- **Cambiar de origen limpia el campo.** Conservarlo compondria un marcador que mezcla dos
  namespaces.
- **El badge de tipo usa `.pd-badge--role` de `app.scss`**, que tenia exactamente los tres valores
  que la `.pd-namespace-chip` scoped duplicaba. Esa clase se va con los chips.
- **El doble de CodeMirror se mockea a nivel de MODULO**, no con `stubs`: el dialogo lo carga con
  `defineAsyncComponent` y en el arbol no hay un nombre contra el que casar. El mock necesita
  `__esModule: true` o Vue toma el modulo entero por el componente.

### Lo que las pruebas cubren y lo que no

Frontend **20 ficheros / 429 pruebas** (24 nuevas): 9 del helper puro, 11 del dialogo —primer spec
de componente de `src/components/templates/`, que cierra la pendiente 35— y 4 del fallback
generico del store.

Lo que **no** esta cubierto: el camino con CodeMirror real sigue sin prueba (el doble sustituye al
editor), asi que la insercion de verdad solo se comprueba a mano; y `copyToClipboard` no se
asevera, porque el portapapeles exige contexto seguro y su fallo ya degrada a un aviso.

---

## Tanda actual — PROT-15.2: el prompt dejo de ser un campo del flujo

### Tres divergencias del enunciado, todas por la misma razon

El enunciado pedia una migracion TypeORM (`MigrationInterface`) en
`backend/src/database/migrations/`, columnas en ingles (`ai_prompts`, `prompt_text`,
`created_by_id`) y un `DELETE` fisico. Las tres se cambiaron tras consultarlo, porque las tres
chocaban con una convencion que el repo ya tenia resuelta:

1. **Migracion en SQL plano.** El runner de TypeORM no existe aqui: no hay `data-source.ts`, la
   config de `TypeOrmModule` no declara `migrations` y no hay scripts npm. Las 17 migraciones
   anteriores son `.sql` numerados que se aplican con `psql`. Una clase habria sido codigo que
   nadie ejecuta, con la tabla sin crear y la falsa sensacion de que si.
2. **Columnas en espanol.** Las diez tablas del esquema son snake_case en espanol y la FK apuntaba
   a una tabla `users` que no existe — se llama `usuarios`, con PK `id_usuario`. La regla real es
   la de `code-conventions.md` §1: identificadores en ingles, columnas en espanol. La entidad
   expone `promptText` y `createdById`; la tabla, `texto_prompt` e `id_usuario_creador`.
3. **Borrado logico.** Las dos tablas analogas de contenido curado (`plantillas_html`,
   `plantillas_flujo`) usan `activo`, y por el mismo motivo: una ejecucion ya trazada apunta al
   prompt con el que se genero su salida. Un `DELETE` fisico dejaria la auditoria sin la pieza que
   explica el resultado.

### Por que la tabla no guarda el modelo

Es la decision de diseno de la subtarea, no una simplificacion. Si `prompts_ia` tuviera `provider`
y `model`, el texto quedaria atado a un proveedor y el mismo prompt no podria probarse con Claude y
con ChatGPT sin duplicar la fila. El modelo es configuracion de EJECUCION y pertenece al nodo; el
prompt es un activo de CONTENIDO y pertenece al repositorio. Separarlos es lo que permite que
PROT-15.3 conecte cualquier prompt a cualquier nodo de IA.

### El servicio devuelve DTOs y no la entidad

`TemplatesService` devuelve `HtmlTemplate` cruda, y su TSDoc lo justifica: "aqui no hay ninguna
columna que deba quedar oculta". `AiPrompt` si la tiene, de forma indirecta: la relacion `createdBy`
apunta a `User`, que lleva `secreto_otp`. Hoy no se carga, pero basta con que alguien anada un
`relations: ['createdBy']` a una consulta para que ese campo viaje al cliente. Devolver un DTO
cierra esa puerta antes de que se abra, y de paso deja el listado sin `promptText`: la tabla muestra
decenas de filas y una instruccion puede ocupar kilobytes.

`findByName` y `findOneEntity` son la excepcion y devuelven la entidad, porque su consumidor no es
la API sino la estrategia del nodo IA.

### `findByName` devuelve null en vez de lanzar

Los demas buscadores del repo lanzan `NotFoundException`. Aqui no, y es deliberado: quien va a
llamarlo es la estrategia del `PROCESADOR_IA`, que ante un prompt ausente debe producir un
`NodeResult` con `success: false` y su nivel de severidad, no una excepcion HTTP que el motor
tendria que atrapar para traducirla. El que lanza es `findOneEntity`, que es el que sirve al CRUD.

### `ON DELETE RESTRICT` y no `CASCADE`

`tokens_sesion` usa CASCADE porque una credencial de renovacion no tiene sentido sin su dueno. Un
prompt si: es patrimonio del equipo. Dar de baja a quien lo escribio no puede llevarse por delante
las instrucciones que dejo en produccion, asi que la FK bloquea el borrado del usuario. El indice
`idx_prompts_ia_id_usuario_creador` esta justamente para poder responder "que prompts dejo esta
persona" antes de intentarlo.

### `active` en el DTO de alta, pero ignorado

`CreateAiPromptDto` declara `active?: boolean` y `create()` no lo lee: todo prompt nace activo. El
campo existe porque `UpdateAiPromptDto` es un `PartialType` del de alta, y es la UNICA via para
reactivar un prompt retirado — `softDelete` solo sabe apagar. Sin el, la tabla administrativa
mostraria filas inactivas imposibles de recuperar. Mismo criterio que `TemplatesService`. La
prueba 3.2 fija ese comportamiento para que nadie lo "arregle" propagandolo.

### Lo que las pruebas cubren y lo que no

17 pruebas sobre el servicio con el repositorio doblado, patron AAA: listado (filtro por activo,
orden alfabetico, ausencia de `promptText`), detalle y `NotFoundException`, `findByName` con
recorte y `null`, alta (autoria del JWT, `active` ignorado, descripcion a `null`, colision de
nombre), edicion (campos omitidos intactos, reactivacion, conservar el propio nombre, colision con
otro, inexistente) y retirada logica.

NO se cubre: el controlador no tiene spec propio —los guards y `@CurrentUser()` son declarativos y
el patron del repo no los prueba por separado—, y la migracion no se ha aplicado todavia contra el
contenedor, asi que la correspondencia entre `init.sql` y la entidad esta verificada por lectura y
no por ejecucion.

---

## Tanda actual — El prompt dejo de escribirse a ciegas

### Renombrar una tabla son seis objetos, no dos

`ALTER TABLE ... RENAME TO` no arrastra los nombres derivados. Sin renombrar tambien la PK, el
UNIQUE del nombre, la clave ajena y el indice, una base migrada habria conservado
`prompts_ia_pkey` mientras un clonado nuevo desde `init.sql` tendria
`plantillas_prompts_ia_pkey` — y, peor, un error de nombre duplicado habria citado una tabla que ya
no existe, mandando a quien depure al sitio equivocado. Es la tercera vez que el proyecto tropieza
con lo mismo (009 y 011), asi que la 019 lo hace explicito en su cabecera.

Cada paso va en un bloque `DO $$` porque `RENAME` no admite `IF EXISTS`. La clave ajena no se
recrea: `ON DELETE RESTRICT` sobrevive al renombrado, y volver a declararla solo abriria la puerta
a cambiar la regla sin darse cuenta.

### La PK se sigue llamando `id`

El enunciado pedia `idPlantillaPromptIa`. Se mantuvo `id` con
`@PrimaryGeneratedColumn('uuid', { name: 'id_plantilla_prompt_ia' })`. `code-conventions.md` §1
exige identificadores en ingles, y las diez entidades del proyecto ya mapean `id_flujo`,
`id_usuario` e `id_plantilla` a una propiedad `id`. Aceptarlo habria dejado el unico identificador
en espanol del backend y habria cambiado la forma del JSON, obligando al frontend a hablar espanol
en sus tipos.

### Lo que el enunciado daba por hacer y ya estaba hecho

"Asegurar que los nodos tengan definido su output_schema" no era trabajo pendiente: no existe esa
columna y no debe existir. `INodeStrategy.outputFields` es la fuente, y `NodeCatalogService` la
resuelve en cada peticion contra la factoria de estrategias. Su TSDoc explica el porque: una copia
en la tabla se desincronizaria con la estrategia a la primera. Los campos citados en el encargo
—`clean_body`, `clean_title`, `extracted_urls`, `subject`, `from`— llevaban declarados desde la
tanda de los cinco inventarios de salida.

### El explorador se extrajo en vez de duplicarse

Vivia en linea dentro de `TemplateEditorDialog` con 11 pruebas encima. Copiarlo al dialogo de
prompts habria dejado dos gramaticas `{{ns.campo}}` que divergirian a la primera correccion, asi
que se saco a `components/shared/VariableExplorer.vue` y el dialogo HTML pasa a consumirlo.

**Las 11 pruebas de `TemplateEditorDialog.spec.ts` no se tocaron, y siguen pasando.** Era el
criterio de aceptacion de la extraccion: si hubiera hecho falta editarlas, el comportamiento habria
cambiado. Los `data-test` se conservan todos, y por eso las consultas del spec siguen resolviendo
aunque ahora atraviesen un componente hijo.

El componente NO decide que origenes se ofrecen; los recibe filtrados. Cada anfitrion tiene sus
reglas —la plantilla HTML admite `_assets`, el prompt prohibe los destinos— y meterlas dentro
habria convertido un componente de presentacion en el juez de dos dominios. Tampoco inserta: emite
`insert` y que el anfitrion escriba donde sepa, porque uno despacha una transaccion de CodeMirror y
el otro manipula el caret de un textarea.

### Por que los destinos se excluyen por categoria y los otros tres por nombre

Un destino cierra el flujo: su salida es el acuse de la publicacion y nada corre despues. Esa es
una propiedad de la CATEGORIA, y hoy son dos filas pero manana seran tres — enumerarlas habria
obligado a acordarse de la lista al anadir la siguiente.

`PROCESADOR_IA`, `ESCUDO_POST_IA` y `MAPEADOR_PLANTILLA` son de PROCESAMIENTO y CONTROL, categorias
que si se admiten, asi que a esos hay que nombrarlos. Los tres comparten motivo: consumen lo que
produce la IA. Citarlos desde el prompt seria pedirle al modelo el resultado de procesar su propia
respuesta, y `llm_response` es literalmente la salida del nodo que esta leyendo el prompt.

Nota sobre las categorias del enunciado: pedia `'PROCESSING'` y `'DESTINATION'`. El enum real es
`TRIGGER | PROCESAMIENTO | CONTROL | DESTINO`, el tipo PostgreSQL `enum_categoria`. Y "permitir
CONTROL" resulta vacio en la practica: `ESCUDO_POST_IA` es el unico nodo de esa categoria y esta
excluido por nombre.

### El Escenario B esta listo pero nadie lo invoca todavia

`AiPromptTemplateDialog` acepta `upstreamContext` con el mismo contrato que `TemplateEditorDialog`,
y `filterPromptContext` lo depura. Pero hoy no hay quien se lo pase: `PROCESADOR_IA` no tiene
estrategia en el backend, ni componente en `nodeConfigRegistry`, ni store en `nodeStoreRegistry`.
La prop queda probada y documentada para que PROT-15.3 solo tenga que conectarla; construir ahi
toda la triada del nodo habria sido meter PROT-15.3 entera en esta tanda, y el nodo seguiria sin
poder ejecutarse.

### La insercion en el textarea hubo que escribirla

No hay `insertTextAtCursor` que reutilizar: el prompt se edita en un `q-input type="textarea"` y no
en CodeMirror. Se toma la referencia del QInput, se lee `selectionStart`/`selectionEnd` del elemento
nativo y se recompone la cadena. Se usan los DOS extremos y no solo el inicio para que un texto
seleccionado quede REEMPLAZADO, que es lo que espera cualquiera que seleccione algo antes de pulsar
Insertar.

El caret se recoloca dentro de un `setTimeout(0)`: cuando la funcion termina, Vue todavia no ha
propagado el `v-model` al DOM, y fijar la posicion antes la perderia en el repintado. Sin
referencia al textarea —que no deberia ocurrir— se anade al final en vez de descartar la insercion.

### Lo que las pruebas cubren y lo que no

21 pruebas nuevas: 11 de `prompt-namespaces` (los cuatro origenes exactos del Escenario A, la
exclusion por categoria con un destino inventado, el mapeador pese a ser de PROCESAMIENTO, la
propia salida de la IA, los nodos sin campos, y en el Escenario B que el contexto recibido no se
muta) y 10 de `VariableExplorer` (etiquetas, encadenado de los dos selects, limpieza al cambiar de
origen, el marcador emitido y el `reset` imperativo).

NO se cubre: la insercion real en el textarea no tiene prueba automatica —`selectionStart` sobre un
QInput montado en happy-dom no reproduce el caret de un navegador de verdad—, asi que el punto 3 de
la verificacion manual es el que la valida. Tampoco hay prueba del Escenario B de punta a punta,
porque no existe el anfitrion que lo dispare.
