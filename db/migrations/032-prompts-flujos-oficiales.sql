-- =============================================================================
-- Migracion 032 · Codigos y textos de los prompts de los cuatro flujos oficiales
--
-- Deja `plantillas_prompts_ia` alineada con los cuatro canales reales de
-- Madrid+D: apertura de licitacion, cierre de licitacion, verificador de
-- titulos y Notiweb. Hasta ahora habia TRES prompts y sus codigos no nombraban
-- el canal: `LICITACION_DEFAULT` no decia si abria o cerraba, y
-- `PANELES_UEM_DEFAULT` citaba una universidad concreta (UEM) cuando el flujo
-- procesa paneles de cualquiera.
--
-- EL PASO 2 ES EL QUE NO SE PUEDE OLVIDAR, y es la leccion de la migracion 027.
-- El `promptCode` viaja como TEXTO dentro del JSONB `configuracion_pipeline` de
-- cada flujo y cada plantilla ya guardados (`LlmExtractorConfigDto.promptCode`).
-- Sin reescribirlo ahi, un flujo que citase `LICITACION_DEFAULT` se guardaria y
-- se activaria sin problema —el validador de topologia no comprueba que el
-- codigo exista— y reventaria EN EJECUCION al no resolver el prompt, con el
-- flujo ya PAUSADO. Por eso el renombrado y la reescritura van en la MISMA
-- transaccion: dejar una sin la otra es peor que no renombrar.
--
-- POR QUE RENOMBRAR Y NO SEMBRAR CODIGOS NUEVOS. Conservar los antiguos junto a
-- los nuevos dejaria el `<q-select>` del PROCESADOR_IA con siete entradas, dos
-- de ellas duplicados obsoletos, y nadie sabria cual es la vigente. `codigo` es
-- la clave de MAQUINA (UNIQUE, VARCHAR 50); `nombre` es la etiqueta que edita
-- el operador, y tambien se actualiza para que concuerde.
--
-- LOS CUATRO TEXTOS CITAN `{{rendered_html.compiled_markup}}`. Es lo que
-- enciende `expectsFilledMarkup` en `LlmExtractorStrategy` y hace que el nodo
-- publique `filled_markup`, cerrando el circuito
-- MAPEADOR_PLANTILLA -> PROCESADOR_IA -> ESCUDO_POST_IA. La migracion 029 ya lo
-- hizo para el de licitaciones; aqui se extiende a los cuatro. Un prompt sin
-- ese marcador deja al escudo sin nada que auditar.
--
-- SE CONSERVAN `headline`, `summary` y `body_paragraphs` en los cuatro: son
-- obligatorios en el esquema de respuesta pase lo que pase.
--
-- SE CONSERVAN LOS MARCADORES DE ENTRADA. `buildInputText` omite de la materia
-- prima todo origen que el prompt ya cite, de modo que quitarlos no ahorraria
-- nada: duplicaria el material dentro del envio.
--
-- IDEMPOTENTE. Los UPDATE de codigo filtran por el codigo ANTIGUO (tras la
-- primera pasada ninguna fila lo cumple), la reescritura del JSONB filtra por
-- `LIKE` sobre el literal antiguo, y el INSERT lleva
-- ON CONFLICT (codigo) DO NOTHING.
--
-- Los UPDATE de texto NO llevan guarda y son deliberadamente REESCRITURAS: si
-- el equipo curo un prompt desde el CRUD, esta migracion se lo pisa. Es la
-- diferencia con las semillas de plantillas (028, 031), que son altas con
-- ON CONFLICT DO NOTHING. Aqui se reescribe a proposito porque el objeto de la
-- migracion ES el contenido del prompt; aplicarla despues de haber afinado uno
-- a mano exige volver a afinarlo.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/032-prompts-flujos-oficiales.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

-- -----------------------------------------------------------------------------
-- PASO 1 · Renombrado de los codigos y sus etiquetas
-- -----------------------------------------------------------------------------

UPDATE plantillas_prompts_ia
   SET codigo = 'LICITACION_APERTURA_DEFAULT',
       nombre = 'Licitaciones · Apertura de convocatoria',
       descripcion = 'Extrae expediente, importes desglosados, fechas limite y enlaces de contratacion, y rellena la plantilla base de convocatoria abierta.'
 WHERE codigo = 'LICITACION_DEFAULT';

UPDATE plantillas_prompts_ia
   SET codigo = 'VERIFICADOR_TITULOS_DEFAULT',
       nombre = 'Verificador de titulos · Paneles de acreditacion',
       descripcion = 'Extrae comites, evaluadores, universidades y fechas de visita de los paneles de renovacion de acreditacion.'
 WHERE codigo = 'PANELES_UEM_DEFAULT';

-- `NOTIWEB_DEFAULT` no se renombra: su codigo ya nombra el canal.

-- -----------------------------------------------------------------------------
-- PASO 2 · Reescritura de las citas dentro del JSONB de flujos y plantillas
--
-- Se compara contra el literal ENTRECOMILLADO para no tocar una subcadena que
-- aparezca dentro de un texto libre.
-- -----------------------------------------------------------------------------

UPDATE flujos
   SET configuracion_pipeline =
       REPLACE(
         configuracion_pipeline::text,
         '"LICITACION_DEFAULT"',
         '"LICITACION_APERTURA_DEFAULT"'
       )::jsonb
 WHERE configuracion_pipeline::text LIKE '%"LICITACION_DEFAULT"%';

UPDATE plantillas_flujo
   SET configuracion_pipeline =
       REPLACE(
         configuracion_pipeline::text,
         '"LICITACION_DEFAULT"',
         '"LICITACION_APERTURA_DEFAULT"'
       )::jsonb
 WHERE configuracion_pipeline::text LIKE '%"LICITACION_DEFAULT"%';

UPDATE flujos
   SET configuracion_pipeline =
       REPLACE(
         configuracion_pipeline::text,
         '"PANELES_UEM_DEFAULT"',
         '"VERIFICADOR_TITULOS_DEFAULT"'
       )::jsonb
 WHERE configuracion_pipeline::text LIKE '%"PANELES_UEM_DEFAULT"%';

UPDATE plantillas_flujo
   SET configuracion_pipeline =
       REPLACE(
         configuracion_pipeline::text,
         '"PANELES_UEM_DEFAULT"',
         '"VERIFICADOR_TITULOS_DEFAULT"'
       )::jsonb
 WHERE configuracion_pipeline::text LIKE '%"PANELES_UEM_DEFAULT"%';

-- -----------------------------------------------------------------------------
-- PASO 3 · Alta del prompt que faltaba: el cierre de licitacion
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    autor UUID;
BEGIN
    SELECT id_usuario
      INTO autor
      FROM usuarios
     WHERE rol = 'ADMIN' AND activo = TRUE
     ORDER BY fecha_creacion
     LIMIT 1;

    IF autor IS NULL THEN
        RAISE WARNING 'Sin ningun usuario ADMIN activo no se puede sembrar el prompt de cierre (id_usuario_creador es NOT NULL). Aplica db/migrations/002-bootstrap-admin.sql y vuelve a lanzar esta migracion.';
        RETURN;
    END IF;

    INSERT INTO plantillas_prompts_ia (codigo, nombre, descripcion, texto_prompt, id_usuario_creador)
    VALUES (
        'LICITACION_CIERRE_DEFAULT',
        'Licitaciones · Cierre de convocatoria',
        'Detecta el expediente que se traslada a la pagina de convocatorias cerradas y da formato a su resolucion.',
        'Eres un tecnico de contratacion administrativa publica de Madrid+D y maquetador del portal. En el material de mas abajo se comunica el CIERRE de una convocatoria. Identifica de que expediente se trata y vuelca su resolucion sobre la plantilla base.' || E'\n\n' ||
        'Datos que debes localizar:' || E'\n' ||
        '- expediente (codigo identificador; es el dato que permite encontrar el bloque a trasladar)' || E'\n' ||
        '- objeto_contrato' || E'\n' ||
        '- fecha_cierre: fecha de fin del plazo, en formato ISO 8601' || E'\n' ||
        '- estado_resolucion: adjudicada, desierta o anulada' || E'\n' ||
        '- adjudicatario (nombre de la entidad; vacio si quedo desierta o anulada)' || E'\n' ||
        '- importe_adjudicacion en euros' || E'\n' ||
        '- enlace_consulta' || E'\n\n' ||
        'Reglas:' || E'\n' ||
        '- El EXPEDIENTE es el dato critico: sin el, el bloque no se puede localizar en la pagina de origen. Si no aparece literalmente en el material, dejalo vacio en vez de componerlo a partir de otros campos.' || E'\n' ||
        '- Un dato que no aparezca en el material se deja vacio. NUNCA lo estimes ni lo deduzcas.' || E'\n' ||
        '- Los importes van en euros, con punto decimal y sin separador de millares.' || E'\n' ||
        '- Una convocatoria desierta o anulada no tiene adjudicatario ni importe: dejalos vacios, no escribas "ninguno".' || E'\n\n' ||
        'Coloca el codigo de expediente en "headline", el objeto del contrato en "summary" y, en "body_paragraphs", una entrada por cada dato restante con el formato "campo: valor".' || E'\n\n' ||
        'Correo:' || E'\n' ||
        '{{parsed_email.clean_body}}' || E'\n\n' ||
        'Documentos adjuntos:' || E'\n' ||
        '{{parsed_email.extracted_documents_text}}' || E'\n\n' ||
        'PLANTILLA BASE:' || E'\n' ||
        '{{rendered_html.compiled_markup}}',
        autor
    )
    ON CONFLICT (codigo) DO NOTHING;
END $$;

-- -----------------------------------------------------------------------------
-- PASO 4 · Textos de los otros tres, con la plantilla base en los tres
-- -----------------------------------------------------------------------------

UPDATE plantillas_prompts_ia
   SET texto_prompt =
           'Eres un tecnico de contratacion administrativa publica de Madrid+D y maquetador del portal. Se anuncia la APERTURA de una convocatoria. Extrae los datos del expediente que aparece en el material de mas abajo y vuelcalos sobre la plantilla base.' || E'\n\n' ||
           'Datos que debes localizar:' || E'\n' ||
           '- expediente (codigo identificador)' || E'\n' ||
           '- objeto_contrato' || E'\n' ||
           '- pliegos: un enlace por cada documento del expediente (pliego administrativo, de prescripciones tecnicas, anexos)' || E'\n' ||
           '- presupuesto_base: base_imponible, iva e importe total, los tres por separado' || E'\n' ||
           '- valor_estimado del contrato' || E'\n' ||
           '- plazo_recepcion: fecha limite de presentacion de ofertas en formato ISO 8601, y hora' || E'\n' ||
           '- duracion_meses' || E'\n' ||
           '- direccion_postal de presentacion' || E'\n' ||
           '- enlace_consulta al perfil de contratante' || E'\n\n' ||
           'Reglas:' || E'\n' ||
           '- Un dato que no aparezca en el material se deja vacio. NUNCA lo estimes ni lo deduzcas.' || E'\n' ||
           '- Los importes van en euros, con punto decimal y sin separador de millares. Si solo consta el total, deja vacias la base imponible y el IVA en vez de calcularlas.' || E'\n' ||
           '- El numero de pliegos cambia en cada convocatoria: emite una entrada por cada uno que encuentres, ni mas ni menos.' || E'\n\n' ||
           'Coloca el codigo de expediente en "headline", el objeto del contrato en "summary" y, en "body_paragraphs", una entrada por cada dato restante con el formato "campo: valor".' || E'\n\n' ||
           'Correo:' || E'\n' ||
           '{{parsed_email.clean_body}}' || E'\n\n' ||
           'Documentos adjuntos:' || E'\n' ||
           '{{parsed_email.extracted_documents_text}}' || E'\n\n' ||
           'PLANTILLA BASE:' || E'\n' ||
           '{{rendered_html.compiled_markup}}'
 WHERE codigo = 'LICITACION_APERTURA_DEFAULT';

UPDATE plantillas_prompts_ia
   SET texto_prompt =
           'Procesa los paneles de evaluacion para la renovacion de acreditacion de titulos universitarios que aparecen en el material de mas abajo, y vuelcalos sobre la plantilla base.' || E'\n\n' ||
           'De cada panel debes extraer:' || E'\n' ||
           '- universidad y centro' || E'\n' ||
           '- codigo RUCT del titulo' || E'\n' ||
           '- titulacion evaluada' || E'\n' ||
           '- fecha_visita en formato ISO 8601' || E'\n' ||
           '- comite: la lista de evaluadores, cada uno con su rol (presidente, secretario o vocal), nombre y afiliacion' || E'\n\n' ||
           'Reglas:' || E'\n' ||
           '- Respeta la grafia de los nombres propios y de las instituciones tal y como figuran en el material. Un apellido mal transcrito en un panel de evaluacion es un error con nombre y apellidos.' || E'\n' ||
           '- El numero de vocales varia por panel: emite una entrada por cada uno, sin dejar huecos ni inventarlos.' || E'\n' ||
           '- Un panel sin evaluadores se incluye igualmente, con el comite vacio.' || E'\n' ||
           '- No fusiones paneles distintos aunque compartan centro o universidad.' || E'\n\n' ||
           'Coloca en "headline" la universidad y el numero de paneles encontrados, en "summary" el rango de fechas de visita, y en "body_paragraphs" una entrada por panel con su titulacion, RUCT, fecha y evaluadores.' || E'\n\n' ||
           'Correo:' || E'\n' ||
           '{{parsed_email.clean_body}}' || E'\n\n' ||
           'Paneles de acreditacion:' || E'\n' ||
           '{{parsed_email.extracted_documents_text}}' || E'\n\n' ||
           'PLANTILLA BASE:' || E'\n' ||
           '{{rendered_html.compiled_markup}}'
 WHERE codigo = 'VERIFICADOR_TITULOS_DEFAULT';

UPDATE plantillas_prompts_ia
   SET texto_prompt =
           'Eres el redactor jefe de Madrid+D y maquetador del portal. Redacta una noticia institucional para Notiweb, dirigida a la comunidad cientifica e investigadora de la Comunidad de Madrid, a partir del material que se te da mas abajo, y vuelcala sobre la plantilla base.' || E'\n\n' ||
           'Reglas de estilo, de obligado cumplimiento:' || E'\n' ||
           '- Registro formal e impersonal. Tercera persona, nunca primera ni segunda.' || E'\n' ||
           '- El titular es institucional y sobrio. NUNCA termina en punto, y no usa interrogaciones, exclamaciones ni reclamos.' || E'\n' ||
           '- La entradilla resume la noticia en menos de 600 caracteres y responde a que, quien y cuando. Tampoco termina en punto.' || E'\n' ||
           '- El desarrollo se entrega como parrafos independientes, sin encabezados ni vinetas.' || E'\n' ||
           '- Los nombres de centros, institutos y programas se citan completos la primera vez, con su sigla entre parentesis si la tienen.' || E'\n' ||
           '- No inventes datos, cifras ni declaraciones que no esten en el material. Una cita entrecomillada solo puede reproducir literalmente lo que ya figura en el.' || E'\n\n' ||
           'Coloca el titular en "headline", la entradilla en "summary" y los parrafos de desarrollo en "body_paragraphs".' || E'\n\n' ||
           'Directiva del editor:' || E'\n' ||
           '{{parsed_email.clean_body}}' || E'\n\n' ||
           'Articulo original:' || E'\n' ||
           '{{scraped_web.full_article_content}}' || E'\n\n' ||
           'Documentos adjuntos:' || E'\n' ||
           '{{parsed_email.extracted_documents_text}}' || E'\n\n' ||
           'PLANTILLA BASE:' || E'\n' ||
           '{{rendered_html.compiled_markup}}'
 WHERE codigo = 'NOTIWEB_DEFAULT';

COMMIT;

-- =============================================================================
-- Comprobacion del resultado
--
-- Cuatro filas, activas, las cuatro con la plantilla base. `tiene_plantilla` en
-- false significa que el nodo no pedira markup y el ESCUDO_POST_IA se quedara
-- sin nada que auditar.
-- =============================================================================

SELECT codigo,
       nombre,
       activo,
       texto_prompt LIKE '%compiled_markup%' AS tiene_plantilla,
       length(texto_prompt)                  AS bytes_prompt
  FROM plantillas_prompts_ia
 WHERE codigo IN (
         'LICITACION_APERTURA_DEFAULT',
         'LICITACION_CIERRE_DEFAULT',
         'VERIFICADOR_TITULOS_DEFAULT',
         'NOTIWEB_DEFAULT'
       )
 ORDER BY codigo;

-- No debe quedar rastro de los codigos antiguos en ninguna de las tres tablas.
SELECT 'plantillas_prompts_ia' AS origen, COUNT(*) AS restantes
  FROM plantillas_prompts_ia
 WHERE codigo IN ('LICITACION_DEFAULT', 'PANELES_UEM_DEFAULT')
UNION ALL
SELECT 'flujos', COUNT(*)
  FROM flujos
 WHERE configuracion_pipeline::text LIKE '%"LICITACION_DEFAULT"%'
    OR configuracion_pipeline::text LIKE '%"PANELES_UEM_DEFAULT"%'
UNION ALL
SELECT 'plantillas_flujo', COUNT(*)
  FROM plantillas_flujo
 WHERE configuracion_pipeline::text LIKE '%"LICITACION_DEFAULT"%'
    OR configuracion_pipeline::text LIKE '%"PANELES_UEM_DEFAULT"%';
