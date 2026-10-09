-- =============================================================================
-- Migracion 036 · Contrato JSON del prompt y data-parent neutro en la plantilla
--
-- PROPOSITO 1 · Eliminar la contradiccion del prompt.
--
--   El `texto_prompt` de VERIFICADOR_TITULOS_DEFAULT ordena en sus REGLAS
--   ESTRICTAS "Devuelve unica y exclusivamente el marcado HTML inyectable
--   resultante". Esa instruccion choca de frente con el contrato que el
--   proveedor impone en la MISMA llamada: `buildResponseJsonSchema`
--   (backend/src/modules/nodes/strategies/interfaces/llm-provider.interface.ts)
--   emite un `response_format: json_schema` que exige un objeto con las claves
--   headline, summary, body_paragraphs y filled_markup.
--
--   El modelo recibe entonces dos ordenes incompatibles sobre la FORMA de su
--   respuesta. Cuando obedece a la del operador, el cuerpo no parsea o
--   `filled_markup` llega vacio, y el daño no se ve hasta un nodo mas tarde,
--   como un ERR_POST_IA_EMPTY_HTML en PostIaSanitizerStrategy que no dice nada
--   de su verdadera causa. La regla pasa a decir DONDE depositar el marcado,
--   no a negar el JSON.
--
-- PROPOSITO 2 · Fallback neutro en el atributo data-parent.
--
--   La plantilla pasa a traer `data-parent="#accordion"`, el contenedor raiz,
--   como valor por defecto que el modelo sustituye por el acordeon de la
--   universidad que corresponda segun la tabla que el prompt ya incluye.
--
--   OJO AL LITERAL. La plantilla NO contiene ya `#accordionCEU`: la 035 lo
--   sustituyo por el relleno `#accordionPadreId`. Un REPLACE que buscase
--   `#accordionCEU` afectaria a cero filas y, peor, una comprobacion del tipo
--   `NOT LIKE '%#accordionCEU%'` devolveria true sin que nada hubiera
--   cambiado. El literal vigente, y el que aqui se neutraliza, es
--   `#accordionPadreId`.
--
-- NOTA SOBRE EL CAMBIO DE MODO DE FALLO. La 035 eligio un relleno inverosimil
-- a proposito: si el modelo no lo sustituia, DrupalHttpStrategy no encontraba
-- el contenedor y detenia el nodo con ERR_DRUPAL_DOM_TARGET. Con `#accordion`
-- —que SI existe en el portal— un panel sin sustituir ya no detiene nada: se
-- publica en el contenedor raiz, fuera de su universidad. Es una decision
-- tomada conscientemente; queda escrita aqui para que quien lea esta migracion
-- dentro de seis meses sepa que el silencio es deliberado y no un descuido.
--
-- DEPENDE DE LA 035, que es quien dejo el atributo en `#accordionPadreId` y
-- quien escribio en el prompt las instrucciones que lo citan.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/036-prompt-y-plantilla-titulos.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

-- -----------------------------------------------------------------------------
-- PASO 1 · El prompt deja de negar el contrato JSON
--
-- Se hace con REPLACE sobre el valor existente y no reescribiendo el
-- `texto_prompt` entero, por el mismo motivo que razona la cabecera de la 035:
-- un UPDATE con el texto completo obligaria a mantener aqui otra copia del
-- prompt, que divergiria de la 035 a la primera correccion que reciba
-- cualquiera de las dos.
-- -----------------------------------------------------------------------------

UPDATE plantillas_prompts_ia
   SET texto_prompt = REPLACE(
           texto_prompt,
           '- Devuelve unica y exclusivamente el marcado HTML inyectable resultante.',
           '- Deposita el marcado HTML resultante en la clave "filled_markup" del objeto JSON de respuesta, como una unica cadena. No lo devuelvas como texto suelto fuera del JSON ni envuelto en un bloque de codigo.'
       ),
       actualizado_en = NOW()
 WHERE codigo = 'VERIFICADOR_TITULOS_DEFAULT'
   AND texto_prompt LIKE '%unica y exclusivamente el marcado HTML%';

-- -----------------------------------------------------------------------------
-- PASO 2 · La plantilla adopta el contenedor raiz como valor por defecto
-- -----------------------------------------------------------------------------

UPDATE plantillas_html
   SET contenido_html = REPLACE(
           contenido_html,
           'data-parent="#accordionPadreId"',
           'data-parent="#accordion"'
       ),
       descripcion = 'Esqueleto del panel colapsable de Bootstrap para la pagina agregadora de verificacion de titulos. Lo rellena el PROCESADOR_IA, que ademas asigna el acordeon de la universidad en data-parent partiendo del contenedor raiz #accordion; el destino es el preset VERIFICACION_TITULOS (APPEND_HTML_BLOCK sobre node--page), que reparte cada panel a su sub-acordeon.',
       actualizado_en = NOW()
 WHERE nombre = 'Verificación de Títulos · Panel de evaluación'
   AND contenido_html LIKE '%data-parent="#accordionPadreId"%';

-- -----------------------------------------------------------------------------
-- PASO 3 · El prompt deja de hablar de un relleno que ya no existe
--
-- Se sustituye la FRASE COMPLETA y no solo el token `#accordionPadreId`. Un
-- reemplazo del token dejaria en pie sus dos oraciones acompañantes —"si lo
-- dejas sin tocar, el panel no se publica" y "es preferible que la publicacion
-- se detenga"—, que describian el comportamiento del relleno inverosimil y con
-- `#accordion` son sencillamente falsas. Un prompt que le miente al modelo
-- sobre las consecuencias de su salida es peor que uno que calla.
-- -----------------------------------------------------------------------------

UPDATE plantillas_prompts_ia
   SET texto_prompt = REPLACE(
           texto_prompt,
           'La plantilla trae el valor de relleno "#accordionPadreId": SUSTITUYELO en cada panel. Si lo dejas sin tocar, el panel no se publica. Si la universidad de un comite no figura en la tabla, deja el valor de relleno tal cual: es preferible que la publicacion se detenga a que el comite acabe dentro de otra universidad.',
           'La plantilla trae el contenedor raiz "#accordion" como valor por defecto: SUSTITUYELO en cada panel por el acordeon de su universidad. Si la universidad de un comite no figura en la tabla, dejalo como "#accordion".'
       ),
       actualizado_en = NOW()
 WHERE codigo = 'VERIFICADOR_TITULOS_DEFAULT'
   AND texto_prompt LIKE '%#accordionPadreId%';

COMMIT;

-- =============================================================================
-- Comprobacion del resultado
--
-- `contradiccion_resuelta` en false significa que el PASO 1 no encontro la
-- regla: o la 035 no se aplico, o el texto del prompt ya se habia editado a
-- mano y la cadena buscada ya no coincide literalmente.
--
-- `conserva_plantilla` NO es decorativo: `{{rendered_html.compiled_markup}}` es
-- el marcador que BASE_TEMPLATE_MARKER_PATTERN detecta en LlmExtractorStrategy
-- para encender `expectsFilledMarkup`. Si alguno de estos REPLACE lo hubiese
-- tocado, el nodo dejaria de pedir filled_markup y el ESCUDO_POST_IA se
-- quedaria sin nada que auditar.
--
-- `conserva_mapeo` vigila que la tabla de las catorce universidades que
-- introdujo la 035 siga intacta: es de donde el modelo saca `#accordionUAM`,
-- un dato del DOM del portal que no esta en el material de entrada.
-- =============================================================================

SELECT COUNT(*)                                                             AS prompt_filas,
       bool_and(texto_prompt NOT LIKE '%unica y exclusivamente el marcado HTML%') AS contradiccion_resuelta,
       bool_and(texto_prompt LIKE '%filled_markup%')                        AS cita_la_clave,
       bool_and(texto_prompt NOT LIKE '%#accordionPadreId%')                AS relleno_purgado,
       bool_and(texto_prompt LIKE '%compiled_markup%')                      AS conserva_plantilla,
       bool_and(texto_prompt LIKE '%#accordionURJC%')                       AS conserva_mapeo
  FROM plantillas_prompts_ia
 WHERE codigo = 'VERIFICADOR_TITULOS_DEFAULT';

SELECT COUNT(*)                                                      AS plantillas_corregidas,
       bool_and(contenido_html LIKE '%data-parent="#accordion"%')     AS fallback_neutro_ok,
       bool_and(contenido_html NOT LIKE '%#accordionCEU%')            AS ceu_neutralizado,
       bool_and(contenido_html NOT LIKE '%#accordionPadreId%')        AS relleno_neutralizado,
       bool_and(contenido_html LIKE '%href="#collapsePanelId"%'
            AND contenido_html LIKE '%id="collapsePanelId"%')         AS despliegue_intacto
  FROM plantillas_html
 WHERE nombre = 'Verificación de Títulos · Panel de evaluación';
