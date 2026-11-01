-- =============================================================================
-- Migracion 065 · Notiweb: encabezados intermedios y referencia en APA 7
--
-- Endurece la maquetacion que la 064 dejo en el prompt `NOTIWEB_DEFAULT`:
--
--   · El cuerpo lleva AL MENOS DOS encabezados intermedios (<h2> o <h3>) dentro
--     de div.notiweb-cuerpo, intercalados entre los <p> de desarrollo. Las
--     noticias salian como un bloque continuo de parrafos, dificil de escanear
--     en el portal. `h2` y `h3` ya estan en la lista blanca compartida del
--     saneador (`TEMPLATE_SANITIZER_CONFIG`), asi que el ESCUDO_POST_IA los deja
--     pasar sin tocar sus `allowedTags`.
--   · La referencia de p.notiweb-referencia pasa del orden libre de la 064
--     ("Autores. Titulo. Revista, Año. DOI o URL") a APA 7 ESTRICTO.
--
-- POR QUE UNA MIGRACION NUEVA Y NO EDITAR LA 064. La 064 ya esta aplicada y
-- registrada en `schema_migrations`, y su guarda de idempotencia se salta el
-- prompt en cuanto contiene "Referencia bibliografica:". Esta usa su propio
-- marcador ("APA 7") para no reaplicarse.
--
-- PLANTILLA. Se reafirma la estructura limpia de produccion de la 064 SOLO si
-- la base aun conserva el esqueleto de la 031 (la 064 no llego a correr sobre
-- ella). Sobre una base al dia es un NOTICE y nada mas. No se anaden ranuras de
-- encabezado a la plantilla: los encabezados los escribe la IA donde el texto
-- lo pide, y fijar su posicion en el esqueleto obligaria a un numero exacto.
--
-- NADA EN SILENCIO, como la 064: fila ausente → WARNING; prompt editado a mano
-- hasta no reconocerlo → EXCEPTION y ROLLBACK.
--
-- Aplicar con:
--   npm run db:migrate          (desde backend/)
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

-- -----------------------------------------------------------------------------
-- PASO 1 · Plantilla `Notiweb · Noticia institucional` (solo si sigue en la 031)
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
        RAISE WARNING '065: no existe la plantilla "%". No se ha modificado.', template_name;
        RETURN;
    END IF;

    IF current_html ~ '\mnotiweb-referencia\M' THEN
        RAISE NOTICE '065: la plantilla "%" ya tiene la estructura de produccion.', template_name;
        RETURN;
    END IF;

    IF current_html !~ '\mnotiweb-titular\M' THEN
        RAISE EXCEPTION '065: la plantilla "%" se ha editado a mano y no se reconoce. Revisala desde el gestor de plantillas.', template_name;
    END IF;

    UPDATE plantillas_html
       SET contenido_html =
               '<div class="notiweb-cuerpo">' || E'\n' ||
               '  <hr />' || E'\n' ||
               '  <p><strong>Referencia bibliográfica:</strong></p>' || E'\n' ||
               '  <p class="notiweb-referencia"></p>' || E'\n' ||
               '</div>',
           descripcion =
               'Cuerpo de una noticia de Notiweb: parrafos de desarrollo con encabezados intermedios y referencia bibliografica en APA 7. Titular y entradilla viajan aparte (title y body.summary).',
           variables_esperadas = '[]'::jsonb,
           fecha_actualizacion = NOW()
     WHERE nombre = template_name;

    RAISE NOTICE '065: plantilla "%" reducida a la estructura de produccion.', template_name;
END $$;

-- -----------------------------------------------------------------------------
-- PASO 2 · Prompt `NOTIWEB_DEFAULT`
--
-- Sustituye las dos lineas de la 064 que cambian de criterio (maquetacion y
-- orden de la referencia) y deja intactas las demas. Si la 064 no llego a
-- aplicarse, inserta el bloque completo delante de la frase de mapeo de la 032.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    mapping_line CONSTANT TEXT :=
        'Coloca el titular en "headline", la entradilla en "summary" y los parrafos de desarrollo en "body_paragraphs".';
    old_layout_rule CONSTANT TEXT :=
        '- Escribe cada parrafo de desarrollo como un elemento <p> dentro de div.notiweb-cuerpo, en orden y delante del <hr>.';
    old_reference_rule CONSTANT TEXT :=
        '- Si el material cita un estudio, articulo o publicacion cientifica, escribe su referencia en p.notiweb-referencia con este orden: Autores. Titulo. Revista, Año. DOI o URL.';
    new_layout_rule CONSTANT TEXT :=
        '- Escribe cada parrafo de desarrollo como un elemento <p> dentro de div.notiweb-cuerpo, en orden y delante del <hr>.' || E'\n' ||
        '- Estructura el desarrollo con AL MENOS DOS encabezados intermedios (<h2> o <h3>) dentro de div.notiweb-cuerpo, intercalados entre los <p> y nunca antes del primer parrafo. Cada encabezado resume en pocas palabras la seccion que introduce; no repitas el titular.' || E'\n' ||
        '- Los encabezados solo van en el marcado: "body_paragraphs" contiene unicamente los parrafos.';
    new_reference_rule CONSTANT TEXT :=
        '- Si el material cita un estudio, articulo o publicacion cientifica, escribe su referencia en p.notiweb-referencia en formato APA 7 estricto: Apellido, I. I., Apellido, I. I. y Apellido, I. I. (Año). Titulo del articulo. <em>Nombre de la Revista</em>, <em>volumen</em>(numero), paginas. https://doi.org/xxxx' || E'\n' ||
        '- APA 7: hasta 20 autores, todos con apellido e iniciales separados por comas y el ultimo precedido de "y"; titulo del articulo en tipo normal y solo con mayuscula inicial; revista y volumen en cursiva (<em>); el DOI como URL https://doi.org/ completa, o la URL del articulo si no hay DOI.';
    full_block CONSTANT TEXT :=
        'Maquetacion del cuerpo:' || E'\n' ||
        '- La plantilla base NO lleva titular ni entradilla: el portal los muestra aparte a partir de "headline" y "summary". No los repitas dentro del marcado.' || E'\n' ||
        new_layout_rule || E'\n\n' ||
        'Referencia bibliografica:' || E'\n' ||
        new_reference_rule || E'\n' ||
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
        RAISE WARNING '065: no existe el prompt NOTIWEB_DEFAULT. No se ha modificado.';
        RETURN;
    END IF;

    IF position('APA 7' IN current_prompt) > 0 THEN
        RAISE NOTICE '065: el prompt NOTIWEB_DEFAULT ya exige encabezados y APA 7.';
        RETURN;
    END IF;

    IF position(old_layout_rule IN current_prompt) > 0
       AND position(old_reference_rule IN current_prompt) > 0 THEN
        UPDATE plantillas_prompts_ia
           SET texto_prompt = replace(
                   replace(current_prompt, old_layout_rule, new_layout_rule),
                   old_reference_rule, new_reference_rule),
               fecha_actualizacion = NOW()
         WHERE codigo = 'NOTIWEB_DEFAULT';

        RAISE NOTICE '065: reglas de encabezados y APA 7 aplicadas sobre las de la 064.';
        RETURN;
    END IF;

    IF position('Referencia bibliografica:' IN current_prompt) = 0
       AND position(mapping_line IN current_prompt) > 0 THEN
        UPDATE plantillas_prompts_ia
           SET texto_prompt = replace(current_prompt, mapping_line, full_block || mapping_line),
               fecha_actualizacion = NOW()
         WHERE codigo = 'NOTIWEB_DEFAULT';

        RAISE NOTICE '065: bloque de maquetacion completo anadido a NOTIWEB_DEFAULT (la 064 no estaba aplicada).';
        RETURN;
    END IF;

    RAISE EXCEPTION '065: el prompt NOTIWEB_DEFAULT se ha editado a mano y no se reconocen las reglas de la 064. Anade los encabezados y el formato APA 7 desde el gestor de prompts.';
END $$;

COMMIT;

-- =============================================================================
-- Comprobacion del resultado: `con_encabezados` y `con_apa7` en true, y la
-- frase de mapeo de la 032 intacta.
-- =============================================================================

SELECT codigo,
       position('AL MENOS DOS encabezados' IN texto_prompt) > 0 AS con_encabezados,
       position('APA 7' IN texto_prompt) > 0                    AS con_apa7,
       texto_prompt LIKE '%"body_paragraphs".%'                 AS mapeo_intacto
  FROM plantillas_prompts_ia
 WHERE codigo = 'NOTIWEB_DEFAULT';
