-- =============================================================================
-- Migracion 064 · Notiweb: cuerpo de produccion y referencia bibliografica
--
-- Alinea la plantilla y el prompt de Notiweb con lo que de verdad publica el
-- destino Drupal desde la entrega del resumen en `body.summary`:
--
--   title          <- llm_response.headline
--   body.summary   <- llm_response.summary
--   body.value     <- validated_drupal_json.validated_markup (esta plantilla, rellena)
--
-- Drupal pinta el titulo y el resumen POR SU CUENTA. La plantilla de la 031
-- llevaba ademas un `<h3>` de titular y un `<p>` de entradilla dentro del
-- cuerpo, de modo que la noticia salia con el titular y la entradilla DOS
-- veces. Se reduce el esqueleto a la estructura real de produccion: los
-- parrafos de desarrollo y, al final, la referencia bibliografica.
--
-- SIN MARCADORES `{{...}}`, y no por estilo: el MAPEADOR_PLANTILLA rechaza con
-- ERR_TEMPLATE_PENDING_VARS toda plantilla cuya `variables_esperadas` no venga
-- vacia (cabeceras de la 028 y la 031). Los huecos se nombran por su posicion y
-- por CLASE, y es el prompt el que dice a la IA que va en cada uno:
--
--   div.notiweb-cuerpo     -> un <p> por parrafo de desarrollo, antes del <hr>
--   p.notiweb-referencia   -> la referencia bibliografica, o el bloque entero
--                             fuera si el material no cita ningun estudio
--
-- El bloque de referencia es OPCIONAL. Ningun flujo ni plantilla de flujo
-- guardados exige hoy selectores de Notiweb en su ESCUDO_POST_IA (comprobado al
-- escribir esta migracion), asi que retirarlo cuando no hay cita no dispara
-- ERR_POST_IA_DOM_MUTATED. Quien anada `requiredSelectors` a ese escudo no debe
-- incluir `.notiweb-referencia`.
--
-- QUE SE PISA Y QUE NO. Plantilla y prompt se editan desde el gestor, asi que
-- solo se reescribe lo que esta migracion reconoce:
--
--   · Plantilla: solo si conserva el esqueleto de la 031 (`notiweb-titular`).
--     Si ya tiene `notiweb-referencia`, no hace nada.
--   · Prompt: se inserta el bloque de reglas nuevo ANTES de la frase que mapea
--     las claves de salida, que es la que deja la 032. Si ya lo tiene, no hace
--     nada.
--
-- NADA EN SILENCIO, con el mismo criterio que la 062:
--   · Fila AUSENTE (base sin ADMIN cuando corrieron la 023/031, como la de
--     pruebas E2E): WARNING y se sigue, para no detener `db:migrate`.
--   · Fila PRESENTE pero editada a mano hasta no reconocerla: EXCEPTION, y el
--     ROLLBACK deja las dos intactas. La decide una persona.
--
-- Aplicar con:
--   npm run db:migrate          (desde backend/)
-- o a mano:
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' \
--     < db/migrations/064-actualizar-plantilla-y-prompt-notiweb.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

-- -----------------------------------------------------------------------------
-- PASO 1 · Plantilla `Notiweb · Noticia institucional`
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    template_name CONSTANT TEXT := 'Notiweb · Noticia institucional';
    current_html  TEXT;
BEGIN
    SELECT contenido_html
      INTO current_html
      FROM plantillas_html
     WHERE nombre = template_name;

    IF NOT FOUND THEN
        RAISE WARNING '064: no existe la plantilla "%" (se siembra en la 031 con un ADMIN activo). No se ha modificado.', template_name;
        RETURN;
    END IF;

    IF current_html ~ '\mnotiweb-referencia\M' THEN
        RAISE NOTICE '064: la plantilla "%" ya tiene la estructura de produccion.', template_name;
        RETURN;
    END IF;

    IF current_html !~ '\mnotiweb-titular\M' THEN
        RAISE EXCEPTION '064: la plantilla "%" no conserva el esqueleto de la 031 y se ha editado a mano. Revisala desde el gestor de plantillas antes de reaplicar.', template_name;
    END IF;

    UPDATE plantillas_html
       SET contenido_html =
               '<div class="notiweb-cuerpo">' || E'\n' ||
               '  <hr />' || E'\n' ||
               '  <p><strong>Referencia bibliográfica:</strong></p>' || E'\n' ||
               '  <p class="notiweb-referencia"></p>' || E'\n' ||
               '</div>',
           descripcion =
               'Cuerpo de una noticia de Notiweb: parrafos de desarrollo y referencia bibliografica. Titular y entradilla viajan aparte (title y body.summary).',
           -- Explicito aunque ya valga '[]': un valor distinto aqui haria que
           -- el MAPEADOR_PLANTILLA rechazase la plantilla en ejecucion.
           variables_esperadas = '[]'::jsonb,
           fecha_actualizacion = NOW()
     WHERE nombre = template_name;

    RAISE NOTICE '064: plantilla "%" reducida a la estructura de produccion.', template_name;
END $$;

-- -----------------------------------------------------------------------------
-- PASO 2 · Prompt `NOTIWEB_DEFAULT`
--
-- Se inserta delante de la frase de mapeo de la 032 y no al final: lo que
-- sigue a esa frase son los bloques de entrada (`Directiva del editor:`, ...) y
-- la plantilla base, y una regla colocada detras se leeria como parte del
-- material de origen.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    mapping_line CONSTANT TEXT :=
        'Coloca el titular en "headline", la entradilla en "summary" y los parrafos de desarrollo en "body_paragraphs".';
    new_rules CONSTANT TEXT :=
        'Maquetacion del cuerpo:' || E'\n' ||
        '- La plantilla base NO lleva titular ni entradilla: el portal los muestra aparte a partir de "headline" y "summary". No los repitas dentro del marcado.' || E'\n' ||
        '- Escribe cada parrafo de desarrollo como un elemento <p> dentro de div.notiweb-cuerpo, en orden y delante del <hr>.' || E'\n\n' ||
        'Referencia bibliografica:' || E'\n' ||
        '- Si el material cita un estudio, articulo o publicacion cientifica, escribe su referencia en p.notiweb-referencia con este orden: Autores. Titulo. Revista, Año. DOI o URL.' || E'\n' ||
        '- Usa solo datos que figuren en el material. Si falta alguno, omitelo junto con su separador; nunca lo completes ni lo deduzcas.' || E'\n' ||
        '- Si cita varios estudios, una referencia por parrafo <p class="notiweb-referencia">, en el orden en que aparecen.' || E'\n' ||
        '- Si el material no cita ningun estudio, elimina del marcado el <hr>, el rotulo "Referencia bibliográfica:" y su parrafo.' || E'\n' ||
        '- La referencia no forma parte de "body_paragraphs".' || E'\n\n';
    current_prompt TEXT;
BEGIN
    SELECT texto_prompt
      INTO current_prompt
      FROM plantillas_prompts_ia
     WHERE codigo = 'NOTIWEB_DEFAULT';

    IF NOT FOUND THEN
        RAISE WARNING '064: no existe el prompt NOTIWEB_DEFAULT (se siembra en la 023 con un ADMIN activo). No se ha modificado.';
        RETURN;
    END IF;

    IF position('Referencia bibliografica:' IN current_prompt) > 0 THEN
        RAISE NOTICE '064: el prompt NOTIWEB_DEFAULT ya tiene la regla de referencia bibliografica.';
        RETURN;
    END IF;

    IF position(mapping_line IN current_prompt) = 0 THEN
        RAISE EXCEPTION '064: el prompt NOTIWEB_DEFAULT ya no contiene la frase de mapeo de la 032 y se ha editado a mano. Anade la regla desde el gestor de prompts.';
    END IF;

    UPDATE plantillas_prompts_ia
       SET texto_prompt = replace(current_prompt, mapping_line, new_rules || mapping_line),
           fecha_actualizacion = NOW()
     WHERE codigo = 'NOTIWEB_DEFAULT';

    RAISE NOTICE '064: regla de referencia bibliografica anadida a NOTIWEB_DEFAULT.';
END $$;

COMMIT;

-- =============================================================================
-- Comprobacion del resultado
--
-- Plantilla: `sin_titular` y `con_referencia` en true, `variables_pendientes`
-- en 0. Prompt: `con_regla` en true y `mapeo_intacto` en true; la plantilla
-- base sigue citada para que el nodo pida `filled_markup`.
-- =============================================================================

SELECT nombre,
       contenido_html !~ '\mnotiweb-(titular|entradilla)\M' AS sin_titular,
       contenido_html ~ '\mnotiweb-referencia\M'            AS con_referencia,
       jsonb_array_length(variables_esperadas)              AS variables_pendientes
  FROM plantillas_html
 WHERE nombre = 'Notiweb · Noticia institucional';

SELECT codigo,
       position('Referencia bibliografica:' IN texto_prompt) > 0 AS con_regla,
       texto_prompt LIKE '%"body_paragraphs".%'                   AS mapeo_intacto,
       texto_prompt LIKE '%compiled_markup%'                      AS usa_plantilla
  FROM plantillas_prompts_ia
 WHERE codigo = 'NOTIWEB_DEFAULT';
