-- =============================================================================
-- Migracion 033 · Alinea el canal de Verificacion de Titulos con el DOM real
--
-- La plantilla sembrada en la 028 (`div.panel-evaluacion`) era un panel plano.
-- El destino real, la pagina agregadora `/prueba-verificador-titulos`, presenta
-- cada comite como un PANEL COLAPSABLE de Bootstrap dentro de un acordeon. Un
-- fragmento que no reproduce esa estructura se inyecta y queda suelto fuera del
-- acordeon: no revienta, no alerta, simplemente se publica mal.
--
-- Esta migracion reescribe las DOS piezas de contenido a la vez porque son una
-- sola: el prompt nombra las clases que la plantilla declara. Separarlas en dos
-- migraciones deja una ventana en la que el modelo rellena ranuras que ya no
-- existen, y el ESCUDO_POST_IA lo rechaza con ERR_POST_IA_DOM_MUTATED.
--
-- ES UN UPDATE Y NO UN INSERT. La 028 ya dio de alta la fila con
-- ON CONFLICT (nombre) DO NOTHING, de modo que un alta nueva no la tocaria.
-- Esto PISA lo que el equipo haya curado desde el CRUD de plantillas, al
-- contrario que las semillas 028 y 031: aqui el objeto de la migracion ES el
-- contenido, igual que en los prompts de la 032.
--
-- EL NOMBRE NO CAMBIA. `plantillas_html` no tiene columna `codigo`: su unica
-- clave estable es el nombre con indice unico, y es lo que cita
-- `associatedTemplateName` del preset VERIFICACION_TITULOS en el frontend.
-- Renombrarla romperia esa pista sin que nada lo denuncie.
--
-- DEPENDE DE LA 032, que renombra `PANELES_UEM_DEFAULT` a
-- `VERIFICADOR_TITULOS_DEFAULT`. Aplicada fuera de orden, el UPDATE del prompt
-- no encuentra ninguna fila y la plantilla queda esperando a un prompt que
-- sigue extrayendo datos sueltos. El bloque de comprobacion del final lo avisa.
--
-- REQUIERE la ampliacion de la lista blanca del saneador en el mismo cambio
-- (`template-renderer.service.ts`): sin `colspan`, `rowspan` y `aria-*`, lo que
-- se publica no es lo que aqui se siembra.
--
-- Idempotente: los UPDATE son asignaciones absolutas, no incrementos.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/033-verificador-titulos-acordeon.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

-- -----------------------------------------------------------------------------
-- PASO 1 · La plantilla base: el esqueleto del panel colapsable
--
-- `variables_esperadas` se mantiene en '[]': desde la migracion 025 el
-- MAPEADOR_PLANTILLA no interpola y rechaza con ERR_TEMPLATE_PENDING_VARS
-- cualquier plantilla que aun traiga marcadores.
--
-- Las ranuras son CLASES vacias, no marcadores. El `href` del enlace y el `id`
-- del contenedor colapsable se dejan SIN escribir: los compone la IA a partir
-- del codigo de comite, y tienen que coincidir entre si o el panel no despliega.
-- Un `href=""` sembrado aqui lo descartaria el saneador de todas formas.
-- -----------------------------------------------------------------------------

UPDATE plantillas_html
   SET descripcion = 'Esqueleto del panel colapsable de Bootstrap para la pagina agregadora de verificacion de titulos. Lo rellena el PROCESADOR_IA; el destino es el preset VERIFICACION_TITULOS (APPEND_HTML_BLOCK sobre node--page, dentro de #accordionCEU).',
       contenido_html =
           '<div class="panel panel-default" data-protodo-injected="true" aria-expanded="false">' || E'\n' ||
           '  <div class="panel-heading">' || E'\n' ||
           '    <h5 class="panel-title">' || E'\n' ||
           '      <a aria-expanded="false" data-parent="#accordion_parent" data-bs-toggle="collapse">' || E'\n' ||
           '        <strong class="panel-comite-codigo"></strong>&nbsp;<span class="panel-facultad-nombre"></span>' || E'\n' ||
           '      </a>' || E'\n' ||
           '    </h5>' || E'\n' ||
           '  </div>' || E'\n' ||
           '  <div class="collapse">' || E'\n' ||
           '    <div class="panel-body">' || E'\n' ||
           '      <div class="pane">' || E'\n' ||
           '        <table class="tableform">' || E'\n' ||
           -- Primer tbody VACIO a proposito: el numero de titulaciones por
           -- comite varia, y la IA emite una <tr> por cada una. Es el mismo
           -- recurso que `tbody.panel-vocales` usaba en la plantilla anterior,
           -- y lo que en una plantilla con logica habria sido un bucle.
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
-- PASO 2 · El prompt: de extraer datos a MAQUETAR sobre la plantilla base
--
-- SE CONSERVAN `headline`, `summary` y `body_paragraphs`. No es un resto del
-- prompt anterior: `buildResponseJsonSchema` los declara obligatorios pase lo
-- que pase, de modo que un prompt que solo pidiera marcado produciria
-- respuestas que incumplen el esquema. Van al final y subordinados, porque en
-- este canal lo que se publica es el fragmento, no la redaccion.
--
-- SE CONSERVA `{{rendered_html.compiled_markup}}`. Es lo que enciende
-- `expectsFilledMarkup` en LlmExtractorStrategy y hace que el nodo publique
-- `filled_markup`. Sin ese marcador el ESCUDO_POST_IA se queda sin nada que
-- auditar y el circuito se abre.
-- -----------------------------------------------------------------------------

UPDATE plantillas_prompts_ia
   SET texto_prompt =
           'Procesa la informacion de los comites de evaluacion para la renovacion de acreditacion de titulos universitarios y vuelca los datos sobre la PLANTILLA BASE que encontraras al final.' || E'\n\n' ||
           'Debes extraer y rellenar en el HTML resultante:' || E'\n' ||
           '1. En .panel-comite-codigo: el codigo del comite (ej. "CEU 1", "UCM 3", "UAX 2").' || E'\n' ||
           '2. En .panel-facultad-nombre: el nombre completo del centro o facultad.' || E'\n' ||
           '3. En el href de la etiqueta <a> y en el id del contenedor .collapse: un identificador alfanumerico unico derivado del comite. Los dos valores DEBEN coincidir, con almohadilla solo en el href (ej. href="#collapseCEU1" e id="collapseCEU1"); si difieren, el panel no despliega al pulsarlo.' || E'\n' ||
           '4. En .panel-titulos-body: exactamente una fila <tr> por cada titulacion evaluada, con la estructura <tr><th>[CODIGO_RUCT]</th><th colspan="2">[NOMBRE_TITULACION]</th></tr>. Ni una fila de mas ni una de menos.' || E'\n' ||
           '5. En la tabla de evaluadores: nombre e institucion de procedencia para Presidente, Secretario, Vocal y Estudiante, cada uno en su clase (.eval-* y .inst-*). Si un rol no tiene evaluador, deja &nbsp; en sus dos celdas; no borres la fila ni escribas "ninguno".' || E'\n' ||
           '6. En .panel-fecha-visita: la fecha exacta de la visita (ej. "24 de mayo").' || E'\n\n' ||
           'Reglas estrictas:' || E'\n' ||
           '- Respeta la estructura del acordeon de Bootstrap. No omitas ni renombres las clases .panel, .panel-default, .panel-heading, .panel-title ni .tableform: son el contrato que se verifica despues de ti, y un fragmento al que le falte una de ellas se rechaza entero.' || E'\n' ||
           '- Conserva los atributos que ya trae la plantilla (data-bs-toggle, data-parent, aria-expanded, colspan y los style de las cabeceras). Son los que hacen que el panel despliegue y que la tabla no se descuadre.' || E'\n' ||
           '- Respeta la grafia de los nombres propios y de las instituciones tal y como figuran en el material. Un apellido mal transcrito en un panel de evaluacion es un error con nombre y apellidos.' || E'\n' ||
           '- Un dato que no aparezca en el material se deja vacio. NUNCA lo estimes ni lo deduzcas.' || E'\n' ||
           '- No fusiones comites distintos aunque compartan centro o universidad.' || E'\n' ||
           '- No uses Markdown ni vallas de codigo. La respuesta debe ser el fragmento de marcado inyectable, listo para Drupal.' || E'\n\n' ||
           'Ademas del marcado, rellena el resumen de la ejecucion: en "headline" la universidad y el numero de comites encontrados, en "summary" el rango de fechas de visita, y en "body_paragraphs" una entrada por comite con su centro, titulaciones y fecha.' || E'\n\n' ||
           'Correo:' || E'\n' ||
           '{{parsed_email.clean_body}}' || E'\n\n' ||
           'Documentos adjuntos:' || E'\n' ||
           '{{parsed_email.extracted_documents_text}}' || E'\n\n' ||
           'PLANTILLA BASE:' || E'\n' ||
           '{{rendered_html.compiled_markup}}'
 WHERE codigo = 'VERIFICADOR_TITULOS_DEFAULT';

COMMIT;

-- =============================================================================
-- Comprobacion del resultado
--
-- `ranuras_ok` en false significa que la plantilla no se actualizo: el nombre no
-- casa. `prompt_filas` a 0 significa que la 032 no se ha aplicado todavia y el
-- prompt sigue bajo el codigo `PANELES_UEM_DEFAULT`.
-- =============================================================================

SELECT nombre,
       activo,
       jsonb_array_length(variables_esperadas) AS variables_pendientes,
       length(contenido_html)                  AS bytes_markup,
       (contenido_html LIKE '%panel-titulos-body%'
        AND contenido_html LIKE '%panel-fecha-visita%'
        AND contenido_html LIKE '%tableform%')  AS ranuras_ok
  FROM plantillas_html
 WHERE nombre = 'Verificación de Títulos · Panel de evaluación';

SELECT COUNT(*)                                        AS prompt_filas,
       bool_and(texto_prompt LIKE '%compiled_markup%') AS tiene_plantilla,
       bool_and(texto_prompt LIKE '%panel-comite-codigo%') AS maqueta_dom
  FROM plantillas_prompts_ia
 WHERE codigo = 'VERIFICADOR_TITULOS_DEFAULT';
