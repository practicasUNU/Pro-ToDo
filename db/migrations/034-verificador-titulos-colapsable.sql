-- =============================================================================
-- Migracion 034 · Identificador de despliegue del panel colapsable
--
-- La 033 dejo el panel sin `href` en el enlace y sin `id` en el contenedor
-- `.collapse`, con el argumento de que el saneador descarta un atributo vacio y
-- que la IA los escribiria al rellenar. El argumento era correcto pero
-- incompleto: SIN VERLOS en la plantilla, el modelo no tiene forma de saber que
-- esos dos valores DEBEN COINCIDIR ENTRE SI. Si no coinciden, el panel se
-- publica entero y bien formado, y simplemente no despliega al pulsarlo.
--
-- EL LITERAL `collapsePanelId` ES UNA MARCA, no un valor plausible. Se siembra
-- a proposito con un nombre que nadie confundiria con un identificador real,
-- porque es el unico rastro observable de que el modelo NO lo sustituyo: el
-- ESCUDO_POST_IA no puede detectarlo —audita que la ranura este RELLENA, y un
-- placeholder sin tocar lo esta—, de modo que la comprobacion vive en la prueba
-- E2E (`npm run test:e2e:titulos`). Un valor creible como `#collapse1` habria
-- hecho ese fallo invisible tambien alli.
--
-- `data-parent` pasa de `#accordion_parent` a `#accordionCEU`. El primero era un
-- marcador de posicion heredado del DOM de ejemplo; el segundo es el
-- `containerSelector` REAL del preset VERIFICACION_TITULOS. Tenerlos distintos
-- significaba que el panel declaraba pertenecer a un acordeon distinto de aquel
-- en el que se inyecta, y Bootstrap usa ese dato para cerrar los hermanos al
-- abrir uno: con el valor equivocado, los paneles se quedan todos abiertos.
--
-- El enlace gana `class="panel-toggle-link"`: es el gancho que el prompt cita
-- para nombrar donde va el href, y el selector que el ESCUDO_POST_IA puede
-- exigir en `requiredSelectors`.
--
-- POR QUE UNA 034 Y NO EDITAR LA 033. La 033 ya esta aplicada. Una migracion ya
-- corrida que cambia de contenido es indetectable: quien la aplico antes no
-- tiene forma de saber que lo que hay en su base ya no es lo que dice el
-- fichero.
--
-- La plantilla y el prompt van en la MISMA transaccion porque son una sola
-- pieza: el prompt nombra las clases que la plantilla declara.
--
-- Idempotente: los UPDATE son asignaciones absolutas. Como en la 032 y la 033,
-- PISAN lo que se haya curado desde el CRUD; aqui el objeto de la migracion ES
-- el contenido.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' \
--     < db/migrations/034-verificador-titulos-colapsable.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

-- -----------------------------------------------------------------------------
-- PASO 1 · La plantilla base, con el identificador de despliegue a la vista
-- -----------------------------------------------------------------------------

UPDATE plantillas_html
   SET contenido_html =
           '<div class="panel panel-default" data-protodo-injected="true" aria-expanded="false">' || E'\n' ||
           '  <div class="panel-heading">' || E'\n' ||
           '    <h5 class="panel-title">' || E'\n' ||
           '      <a class="panel-toggle-link" aria-expanded="false" data-parent="#accordionCEU" data-bs-toggle="collapse" href="#collapsePanelId">' || E'\n' ||
           '        <strong class="panel-comite-codigo"></strong>&nbsp;<span class="panel-facultad-nombre"></span>' || E'\n' ||
           '      </a>' || E'\n' ||
           '    </h5>' || E'\n' ||
           '  </div>' || E'\n' ||
           '  <div class="collapse" id="collapsePanelId">' || E'\n' ||
           '    <div class="panel-body">' || E'\n' ||
           '      <div class="pane">' || E'\n' ||
           '        <table class="tableform">' || E'\n' ||
           -- Primer tbody VACIO a proposito: el numero de titulaciones por
           -- comite varia, y la IA emite una <tr> por cada una. Es lo que en una
           -- plantilla con logica habria sido un bucle.
           '          <tbody class="panel-titulos-body"></tbody>' || E'\n' ||
           '          <tbody>' || E'\n' ||
           '            <tr>' || E'\n' ||
           '              <th>&nbsp;</th>' || E'\n' ||
           '              <th style="background-color:#A9BCF5;">Evaluador</th>' || E'\n' ||
           '              <th style="background-color:#A9BCF5;">Institución</th>' || E'\n' ||
           '            </tr>' || E'\n' ||
           '            <tr><th>Presidente:</th><th class="eval-presidente"></th><th class="inst-presidente"></th></tr>' || E'\n' ||
           '            <tr><th>Secretario:</th><th class="eval-secretario"></th><th class="inst-secretario"></th></tr>' || E'\n' ||
           '            <tr><th>Vocal:</th><th class="eval-vocal"></th><th class="inst-vocal"></th></tr>' || E'\n' ||
           '            <tr><th>Estudiante:</th><th class="eval-estudiante"></th><th class="inst-estudiante"></th></tr>' || E'\n' ||
           '            <tr>' || E'\n' ||
           '              <th style="background-color:#C6E0B4;border:1px solid black;" colspan="3">' || E'\n' ||
           '                Fecha Visita:&nbsp;&nbsp;<span class="panel-fecha-visita"></span>' || E'\n' ||
           '              </th>' || E'\n' ||
           '            </tr>' || E'\n' ||
           '          </tbody>' || E'\n' ||
           '        </table>' || E'\n' ||
           '      </div>' || E'\n' ||
           '    </div>' || E'\n' ||
           '  </div>' || E'\n' ||
           '</div>',
       variables_esperadas = '[]'::jsonb
 WHERE nombre = 'Verificación de Títulos · Panel de evaluación';

-- -----------------------------------------------------------------------------
-- PASO 2 · El prompt, con el identificador de despliegue como regla 1
--
-- NO pide `headline`, `summary` ni `body_paragraphs` como obligacion: el
-- contrato de esas tres claves lo antepone cada cliente de proveedor
-- (`buildResponseContractInstruction`), asi que el prompt no necesita
-- repetirlo para cumplir el esquema. Se da una indicacion breve al final para
-- que no salgan rellenas a capricho del modelo.
--
-- SI conserva `{{rendered_html.compiled_markup}}`: es lo que enciende
-- `expectsFilledMarkup` en LlmExtractorStrategy y hace que el nodo publique
-- `filled_markup`. Sin ese marcador el ESCUDO_POST_IA se queda sin nada que
-- auditar.
-- -----------------------------------------------------------------------------

UPDATE plantillas_prompts_ia
   SET texto_prompt =
           'Eres un asistente de estructuracion tecnica para la Fundacion para el Conocimiento madri+d. Tu objetivo es procesar la informacion de los comites de evaluacion para la acreditacion de titulos universitarios recibida en el correo y los documentos, y rellenar exactamente la PLANTILLA BASE.' || E'\n\n' ||
           'INSTRUCCIONES DE EXTRACCION Y RELLENO:' || E'\n' ||
           '1. Identificador de despliegue: en el atributo href de "a.panel-toggle-link" y en el id de "div.collapse", asigna el MISMO identificador alfanumerico unico derivado del codigo del comite (ej. href="#collapseESIC1" e id="collapseESIC1", con almohadilla solo en el href). La plantilla trae el valor de relleno "collapsePanelId" en los dos sitios: SUSTITUYELO. Si los dos valores no coinciden exactamente, el boton colapsable no despliega.' || E'\n' ||
           '2. Codigo y centro: rellena ".panel-comite-codigo" con el identificador del comite (ej. "ESIC 1", "CEU 2") y ".panel-facultad-nombre" con el nombre del centro o facultad (ej. "Facultad de Ciencias Juridicas y Sociales").' || E'\n' ||
           '3. Titulaciones (.panel-titulos-body): genera exactamente una fila <tr> por cada titulacion evaluada, con la estructura <tr><th>[CODIGO_RUCT]</th><th colspan="2">[NOMBRE_OFICIAL_TITULO]</th></tr>. Ni una de mas ni una de menos.' || E'\n' ||
           '4. Comite de evaluadores: rellena el nombre y la institucion de procedencia para Presidente, Secretario, Vocal y Estudiante en sus respectivas celdas (.eval-* e .inst-*). Si algun rol no existe en el material, coloca &nbsp; en sus dos celdas. No elimines filas de la tabla.' || E'\n' ||
           '5. Fecha de visita (.panel-fecha-visita): transcribe las fechas exactas de la visita tecnica (ej. "28 y 29 de mayo").' || E'\n\n' ||
           'REGLAS ESTRICTAS:' || E'\n' ||
           '- No utilices bloques de codigo Markdown (prohibido abrir con tres acentos graves, con o sin la palabra html detras).' || E'\n' ||
           '- Devuelve unica y exclusivamente el marcado HTML inyectable resultante.' || E'\n' ||
           '- Respeta integramente las clases de Bootstrap (.panel, .panel-default, .panel-heading, .panel-title, .collapse, .tableform) y los estilos de fondo (#A9BCF5, #C6E0B4), asi como los atributos data-bs-toggle, data-parent, aria-expanded y colspan que la plantilla ya trae. Son el contrato que se verifica despues de ti: a un fragmento al que le falte una de esas clases se le rechaza entero.' || E'\n' ||
           '- Respeta la grafia de los nombres propios y de las instituciones tal y como figuran en el material. Un apellido mal transcrito en un panel de evaluacion es un error con nombre y apellidos.' || E'\n' ||
           '- Un dato que no aparezca en el material se deja vacio. NUNCA lo estimes ni lo deduzcas.' || E'\n' ||
           '- No fusiones comites distintos aunque compartan centro o universidad.' || E'\n\n' ||
           'Ademas del marcado, resume la ejecucion: en "headline" el centro y el numero de comites encontrados, en "summary" el rango de fechas de visita, y en "body_paragraphs" una entrada por comite con sus titulaciones y su fecha.' || E'\n\n' ||
           'DATOS DE ENTRADA:' || E'\n' ||
           'Correo:' || E'\n' ||
           '{{parsed_email.clean_body}}' || E'\n\n' ||
           'Documentacion adjunta:' || E'\n' ||
           '{{parsed_email.extracted_documents_text}}' || E'\n\n' ||
           'PLANTILLA BASE:' || E'\n' ||
           '{{rendered_html.compiled_markup}}'
 WHERE codigo = 'VERIFICADOR_TITULOS_DEFAULT';

COMMIT;

-- =============================================================================
-- Comprobacion del resultado
--
-- `despliegue_ok` en false significa que la plantilla no se actualizo (el nombre
-- no casa). `prompt_filas` a 0 significa que la 032 no se aplico y el prompt
-- sigue bajo el codigo antiguo `PANELES_UEM_DEFAULT`.
-- =============================================================================

SELECT nombre,
       activo,
       jsonb_array_length(variables_esperadas) AS variables_pendientes,
       (contenido_html LIKE '%panel-toggle-link%'
        AND contenido_html LIKE '%href="#collapsePanelId"%'
        AND contenido_html LIKE '%id="collapsePanelId"%'
        AND contenido_html LIKE '%data-parent="#accordionCEU"%') AS despliegue_ok
  FROM plantillas_html
 WHERE nombre = 'Verificación de Títulos · Panel de evaluación';

SELECT COUNT(*)                                            AS prompt_filas,
       bool_and(texto_prompt LIKE '%compiled_markup%')     AS tiene_plantilla,
       bool_and(texto_prompt LIKE '%panel-toggle-link%')   AS cita_el_enlace,
       bool_and(texto_prompt LIKE '%collapsePanelId%')     AS manda_sustituir
  FROM plantillas_prompts_ia
 WHERE codigo = 'VERIFICADOR_TITULOS_DEFAULT';
