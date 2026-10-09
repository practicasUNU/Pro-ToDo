-- =============================================================================
-- Migracion 035 · Cada comite dentro del acordeon de SU universidad
--
-- La pagina agregadora de Madrid+D es un acordeon de DOS NIVELES: catorce
-- paneles de universidad y, dentro de cada uno, un sub-acordeon
-- `#accordion<SIGLAS>` donde cuelgan sus comites de evaluacion.
--
-- La 034 dejo `data-parent="#accordionCEU"` CABLEADO en la plantilla. El valor
-- era correcto para CEU y erroneo para las otras trece, y el modelo lo copiaba
-- tal cual porque nada en el prompt le decia que debia cambiarlo. El resultado
-- observado: todos los comites de una tanda apuntando a CEU y publicados en el
-- contenedor raiz, fuera de la universidad que les corresponde.
--
-- QUE CAMBIA AQUI. Dos cosas que van juntas:
--
--   1. La plantilla sustituye `#accordionCEU` por el literal de relleno
--      `#accordionPadreId`. Es deliberadamente inverosimil, por el mismo motivo
--      que `collapsePanelId`: un valor creible hace que el fallo de no
--      sustituirlo sea INVISIBLE. Con el literal, `DrupalHttpStrategy` no
--      encuentra el contenedor y detiene el nodo con ERR_DRUPAL_DOM_TARGET
--      antes de publicar nada, y `findUndeployablePanelReasons` lo caza en el
--      E2E.
--
--   2. El prompt gana la tabla completa de las catorce universidades con su
--      acordeon, y la regla de asignarlo. Sin la tabla, el modelo no tiene de
--      donde sacar `#accordionUAM`: no es un dato del material de entrada, es
--      una propiedad del DOM del portal.
--
-- SI conserva `{{rendered_html.compiled_markup}}`: es lo que enciende
-- `expectsFilledMarkup` en LlmExtractorStrategy y hace que el nodo publique
-- `filled_markup`. Sin ese marcador el ESCUDO_POST_IA se queda sin nada que
-- auditar.
--
-- DEPENDE DE LA 034, que es quien introdujo el enlace con `panel-toggle-link` y
-- el identificador de despliegue. Aplicar esta sin aquella deja la plantilla a
-- medias.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/035-verificador-titulos-universidades.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

-- -----------------------------------------------------------------------------
-- PASO 1 · La plantilla deja de cablear una universidad concreta
--
-- Se hace con REPLACE sobre el valor existente y no reescribiendo el HTML
-- entero: lo unico que cambia es ese atributo, y un UPDATE con el marcado
-- completo obligaria a mantener aqui una tercera copia de la plantilla que
-- divergiria de la 034 a la primera correccion que se le haga a cualquiera de
-- las dos.
-- -----------------------------------------------------------------------------

UPDATE plantillas_html
   SET contenido_html = REPLACE(
           contenido_html,
           'data-parent="#accordionCEU"',
           'data-parent="#accordionPadreId"'
       ),
       descripcion = 'Esqueleto del panel colapsable de Bootstrap para la pagina agregadora de verificacion de titulos. Lo rellena el PROCESADOR_IA, que ademas asigna el acordeon de la universidad en data-parent; el destino es el preset VERIFICACION_TITULOS (APPEND_HTML_BLOCK sobre node--page), que reparte cada panel a su sub-acordeon.',
       actualizado_en = NOW()
 WHERE nombre = 'Verificación de Títulos · Panel de evaluación'
   AND contenido_html LIKE '%data-parent="#accordionCEU"%';

-- -----------------------------------------------------------------------------
-- PASO 2 · El prompt aprende el mapa del portal
--
-- La regla del acordeon va la PRIMERA de la lista, por delante del
-- identificador de despliegue. No es cosmetica: de las dos sustituciones que el
-- modelo debe hacer, esta es la que decide DONDE acaba el panel, y la otra solo
-- decide si despliega una vez colocado.
-- -----------------------------------------------------------------------------

UPDATE plantillas_prompts_ia
   SET texto_prompt =
           'Eres un asistente de estructuracion tecnica para la Fundacion para el Conocimiento madri+d. Tu objetivo es procesar la informacion de los comites de evaluacion para la acreditacion de titulos universitarios recibida en el correo y los documentos, y rellenar exactamente la PLANTILLA BASE.' || E'\n\n' ||
           'MAPEO DE UNIVERSIDADES Y CONTENEDORES PADRE (OBLIGATORIO):' || E'\n' ||
           'Cada comite pertenece a una universidad, y cada universidad tiene su propio acordeon en la pagina. En el atributo data-parent del enlace "a.panel-toggle-link" asigna EXACTAMENTE el identificador que corresponda segun esta tabla:' || E'\n' ||
           '- Universidad San Pablo CEU: data-parent="#accordionCEU"' || E'\n' ||
           '- Universidad Alfonso X: data-parent="#accordionUAX"' || E'\n' ||
           '- Universidad Complutense de Madrid: data-parent="#accordionUCM"' || E'\n' ||
           '- Universidad a Distancia de Madrid: data-parent="#accordionUDIMA"' || E'\n' ||
           '- Universidad Internacional Villanueva: data-parent="#accordionUIV"' || E'\n' ||
           '- Universidad Europea de Madrid: data-parent="#accordionUEM"' || E'\n' ||
           '- Universidad Nebrija: data-parent="#accordionUNNE"' || E'\n' ||
           '- Universidad Politecnica de Madrid: data-parent="#accordionUPM"' || E'\n' ||
           '- Universidad de Alcala de Henares: data-parent="#accordionUAH"' || E'\n' ||
           '- Universidad Autonoma de Madrid: data-parent="#accordionUAM"' || E'\n' ||
           '- Universidad Carlos III de Madrid: data-parent="#accordionUC3M"' || E'\n' ||
           '- Universidad Camilo Jose Cela: data-parent="#accordionUCJC"' || E'\n' ||
           '- Universidad Rey Juan Carlos: data-parent="#accordionURJC"' || E'\n' ||
           '- ESIC Universidad: data-parent="#accordionESIC"' || E'\n' ||
           'La plantilla trae el valor de relleno "#accordionPadreId": SUSTITUYELO en cada panel. Si lo dejas sin tocar, el panel no se publica. Si la universidad de un comite no figura en la tabla, deja el valor de relleno tal cual: es preferible que la publicacion se detenga a que el comite acabe dentro de otra universidad.' || E'\n\n' ||
           'INSTRUCCIONES DE EXTRACCION Y RELLENO:' || E'\n' ||
           '1. Identificador de despliegue: en el atributo href de "a.panel-toggle-link" y en el id de "div.collapse", asigna el MISMO identificador alfanumerico unico derivado del codigo del comite (ej. href="#collapseESIC1" e id="collapseESIC1", con almohadilla solo en el href). La plantilla trae el valor de relleno "collapsePanelId" en los dos sitios: SUSTITUYELO. Si los dos valores no coinciden exactamente, el boton colapsable no despliega.' || E'\n' ||
           '2. Codigo y centro: rellena ".panel-comite-codigo" con el identificador del comite (ej. "ESIC 1", "CEU 2") y ".panel-facultad-nombre" con el nombre del centro o facultad (ej. "Facultad de Ciencias Juridicas y Sociales").' || E'\n' ||
           '3. Titulaciones (.panel-titulos-body): genera exactamente una fila <tr> por cada titulacion evaluada, con la estructura <tr><th>[CODIGO_RUCT]</th><th colspan="2">[NOMBRE_OFICIAL_TITULO]</th></tr>. Ni una de mas ni una de menos.' || E'\n' ||
           '4. Comite de evaluadores: rellena el nombre y la institucion de procedencia para Presidente, Secretario, Vocal y Estudiante en sus respectivas celdas (.eval-* e .inst-*). Si algun rol no existe en el material, coloca &nbsp; en sus dos celdas. No elimines filas de la tabla.' || E'\n' ||
           '5. Fecha de visita (.panel-fecha-visita): transcribe las fechas exactas de la visita tecnica (ej. "28 y 29 de mayo").' || E'\n\n' ||
           'REGLAS ESTRICTAS:' || E'\n' ||
           '- Genera un panel COMPLETO por cada comite, cada uno con su propio data-parent. No fusiones comites distintos aunque compartan centro o universidad.' || E'\n' ||
           '- No utilices bloques de codigo Markdown (prohibido abrir con tres acentos graves, con o sin la palabra html detras).' || E'\n' ||
           '- Devuelve unica y exclusivamente el marcado HTML inyectable resultante.' || E'\n' ||
           '- Respeta integramente las clases de Bootstrap (.panel, .panel-default, .panel-heading, .panel-title, .collapse, .tableform) y los estilos de fondo (#A9BCF5, #C6E0B4), asi como los atributos data-bs-toggle, data-parent, data-protodo-injected, aria-expanded y colspan que la plantilla ya trae. Son el contrato que se verifica despues de ti: a un fragmento al que le falte una de esas clases se le rechaza entero.' || E'\n' ||
           '- Respeta la grafia de los nombres propios y de las instituciones tal y como figuran en el material. Un apellido mal transcrito en un panel de evaluacion es un error con nombre y apellidos.' || E'\n' ||
           '- Un dato que no aparezca en el material se deja vacio. NUNCA lo estimes ni lo deduzcas.' || E'\n\n' ||
           'Ademas del marcado, resume la ejecucion: en "headline" el centro y el numero de comites encontrados, en "summary" el rango de fechas de visita, y en "body_paragraphs" una entrada por comite con sus titulaciones y su fecha.' || E'\n\n' ||
           'DATOS DE ENTRADA:' || E'\n' ||
           'Correo:' || E'\n' ||
           '{{parsed_email.clean_body}}' || E'\n\n' ||
           'Documentacion adjunta:' || E'\n' ||
           '{{parsed_email.extracted_documents_text}}' || E'\n\n' ||
           'PLANTILLA BASE:' || E'\n' ||
           '{{rendered_html.compiled_markup}}',
       actualizado_en = NOW()
 WHERE codigo = 'VERIFICADOR_TITULOS_DEFAULT';

COMMIT;

-- =============================================================================
-- Comprobacion del resultado
--
-- `sin_universidad_cableada` en false significa que la plantilla sigue
-- apuntando a CEU: o la 034 no se aplico, o el REPLACE no encontro el atributo.
-- `prompt_filas` a 0 significa que la 032 no se aplico y el prompt sigue bajo el
-- codigo antiguo `PANELES_UEM_DEFAULT`.
-- =============================================================================

SELECT nombre,
       activo,
       (contenido_html LIKE '%data-parent="#accordionPadreId"%'
        AND contenido_html NOT LIKE '%#accordionCEU%') AS sin_universidad_cableada,
       (contenido_html LIKE '%panel-toggle-link%'
        AND contenido_html LIKE '%href="#collapsePanelId"%'
        AND contenido_html LIKE '%id="collapsePanelId"%') AS despliegue_ok
  FROM plantillas_html
 WHERE nombre = 'Verificación de Títulos · Panel de evaluación';

SELECT COUNT(*)                                             AS prompt_filas,
       bool_and(texto_prompt LIKE '%compiled_markup%')      AS tiene_plantilla,
       bool_and(texto_prompt LIKE '%#accordionPadreId%')    AS manda_sustituir_acordeon,
       bool_and(texto_prompt LIKE '%#accordionURJC%')       AS trae_el_mapeo,
       bool_and(texto_prompt LIKE '%collapsePanelId%')      AS manda_sustituir_id
  FROM plantillas_prompts_ia
 WHERE codigo = 'VERIFICADOR_TITULOS_DEFAULT';
