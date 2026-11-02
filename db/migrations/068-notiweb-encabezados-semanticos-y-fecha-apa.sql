-- =============================================================================
-- Migracion 068 · Notiweb: encabezados semanticos y fecha APA determinista
--
-- Tres correcciones sobre NOTIWEB_DEFAULT y su plantilla HTML:
--
--   1. Contradiccion de estilo. La 032 dejo "sin encabezados ni vinetas" y la
--      065 exige "AL MENOS DOS encabezados": el modelo recibia las dos ordenes
--      y a veces resolvia el conflicto con <p><strong> como falso titulo. Se
--      retira la regla vieja y se prohibe expresamente ese recurso: toda
--      division tematica es un <h2> (apartado) o un <h3> (subseccion).
--   2. Fecha de la referencia. La 067 permitia "(s. f.)" en cuanto faltaba la
--      fecha del extractor, aunque la URL la llevase en la ruta
--      (/2026/02/24/). Ahora la cita exige año y fecha completa si existen en
--      cualquiera de las dos fuentes, y "(s. f.)" queda como ultimo recurso.
--   3. Plantilla. El rotulo "<p><strong>Referencia bibliográfica:</strong></p>"
--      era justo el patron prohibido; pasa a <h2>Referencia bibliográfica</h2>.
--
-- Ademas marca como OBLIGATORIAS ({{*...}}) la directiva del editor y la
-- plantilla base: sin cualquiera de las dos el PROCESADOR_IA no tiene nada que
-- redactar ni donde volcarlo, y es preferible pausar antes de gastar tokens.
-- El articulo original y sus metadatos siguen opcionales: el extractor web
-- puede terminar en SKIPPED_EMPTY y la noticia se redacta igual.
--
-- Idempotente por marcador. Si la fila NO existe (una base cuyo seed de
-- prompts no llego a correr por falta de ADMIN), avisa y no hace nada: la 069
-- la inserta ya con el texto final. Si existe pero se edito a mano y no se
-- reconocen sus reglas, EXCEPTION, igual que la 065 y la 067.
--
-- Aplicar con:
--   npm run db:migrate          (desde backend/)
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

DO $$
DECLARE
    marker CONSTANT TEXT := 'Queda estrictamente prohibido usar parrafos <p>';
    old_style_rule CONSTANT TEXT :=
        '- El desarrollo se entrega como parrafos independientes, sin encabezados ni vinetas.';
    new_style_rule CONSTANT TEXT :=
        '- El desarrollo se entrega en parrafos, sin vinetas, organizado en secciones con encabezados semanticos (ver "Maquetacion del cuerpo").';
    old_heading_rule CONSTANT TEXT :=
        '- Estructura el desarrollo con AL MENOS DOS encabezados intermedios (<h2> o <h3>) dentro de div.notiweb-cuerpo, intercalados entre los <p> y nunca antes del primer parrafo. Cada encabezado resume en pocas palabras la seccion que introduce; no repitas el titular.';
    new_heading_rule CONSTANT TEXT :=
        '- Estructura el desarrollo con AL MENOS DOS encabezados intermedios dentro de div.notiweb-cuerpo, intercalados entre los <p> y nunca antes del primer parrafo: <h2> para cada apartado principal y <h3> para sus subsecciones. Cada encabezado resume en pocas palabras la seccion que introduce; no repitas el titular.' || E'\n' ||
        '- Queda estrictamente prohibido usar parrafos <p> o etiquetas <strong> huerfanas como titulos o separadores de seccion: toda division tematica es un <h2> o un <h3>.';
    old_date_rule CONSTANT TEXT :=
        '- Si falta el autor, empieza la referencia por el titulo; si falta la fecha, escribe (s. f.). Nunca inventes DOI, volumen ni paginas.';
    new_date_rule CONSTANT TEXT :=
        '- La referencia incluye obligatoriamente el año y, si estan disponibles, el dia y el mes, con la forma (2026, 24 de febrero). Toma la fecha de "Fecha de publicacion" y, si viene vacia, de la ruta de la URL del articulo (por ejemplo /2026/02/24/). Queda prohibido escribir (s. f.) cuando exista una fecha en cualquiera de las dos fuentes; usalo solo si no hay fecha en ningun sitio.' || E'\n' ||
        '- Si falta el autor, empieza la referencia por el titulo. Nunca inventes DOI, volumen ni paginas.';
    old_label_rule CONSTANT TEXT := 'el rotulo "Referencia bibliográfica:" y su parrafo';
    new_label_rule CONSTANT TEXT := 'el encabezado <h2>Referencia bibliográfica</h2> y su parrafo';
    current_prompt TEXT;
    updated_prompt TEXT;
BEGIN
    SELECT texto_prompt
      INTO current_prompt
      FROM plantillas_prompts_ia
     WHERE codigo = 'NOTIWEB_DEFAULT';

    IF NOT FOUND THEN
        RAISE NOTICE '068: no existe el prompt NOTIWEB_DEFAULT; lo sembrara la 069 con el texto final.';
        RETURN;
    END IF;

    IF position(marker IN current_prompt) > 0 THEN
        RAISE NOTICE '068: el prompt NOTIWEB_DEFAULT ya tiene los encabezados semanticos.';
        RETURN;
    END IF;

    IF position(old_style_rule IN current_prompt) = 0
       OR position(old_heading_rule IN current_prompt) = 0
       OR position(old_date_rule IN current_prompt) = 0
       OR position(old_label_rule IN current_prompt) = 0 THEN
        RAISE EXCEPTION '068: el prompt NOTIWEB_DEFAULT no conserva las reglas de la 065/067. Aplica la 067 o corrige los encabezados desde el gestor de prompts.';
    END IF;

    updated_prompt := replace(current_prompt, old_style_rule, new_style_rule);
    updated_prompt := replace(updated_prompt, old_heading_rule, new_heading_rule);
    updated_prompt := replace(updated_prompt, old_date_rule, new_date_rule);
    updated_prompt := replace(updated_prompt, old_label_rule, new_label_rule);
    -- Marcas obligatorias: `replace` sobre la forma opcional deja intacta la que
    -- ya estuviera marcada a mano.
    updated_prompt := replace(updated_prompt, '{{parsed_email.clean_body}}', '{{*parsed_email.clean_body}}');
    updated_prompt := replace(updated_prompt, '{{rendered_html.compiled_markup}}', '{{*rendered_html.compiled_markup}}');

    UPDATE plantillas_prompts_ia
       SET texto_prompt = updated_prompt,
           fecha_actualizacion = NOW()
     WHERE codigo = 'NOTIWEB_DEFAULT';

    RAISE NOTICE '068: encabezados <h2>/<h3>, fecha APA y marcas obligatorias aplicados a NOTIWEB_DEFAULT.';
END $$;

DO $$
DECLARE
    old_label CONSTANT TEXT := '<p><strong>Referencia bibliográfica:</strong></p>';
    new_label CONSTANT TEXT := '<h2>Referencia bibliográfica</h2>';
    current_html TEXT;
BEGIN
    SELECT contenido_html
      INTO current_html
      FROM plantillas_html
     WHERE nombre = 'Notiweb · Noticia institucional';

    IF NOT FOUND THEN
        RAISE NOTICE '068: no existe la plantilla Notiweb; la sembrara la 069 con el marcado final.';
        RETURN;
    END IF;

    IF position(new_label IN current_html) > 0 THEN
        RAISE NOTICE '068: la plantilla Notiweb ya usa <h2> en la referencia.';
        RETURN;
    END IF;

    IF position(old_label IN current_html) = 0 THEN
        -- Plantilla editada a mano: no se fuerza, pero se avisa. El prompt ya
        -- prohibe el patron, de modo que el modelo no lo reproducira.
        RAISE WARNING '068: la plantilla Notiweb no tiene el rotulo esperado. No se ha modificado.';
        RETURN;
    END IF;

    UPDATE plantillas_html
       SET contenido_html = replace(current_html, old_label, new_label),
           fecha_actualizacion = NOW()
     WHERE nombre = 'Notiweb · Noticia institucional';

    RAISE NOTICE '068: rotulo de la referencia convertido en <h2> en la plantilla Notiweb.';
END $$;

COMMIT;

-- =============================================================================
-- Comprobacion del resultado: todas las columnas en true y sin_s_f_libre en
-- true (la unica mencion a "(s. f.)" es la regla que lo restringe).
-- =============================================================================

SELECT codigo,
       position('Queda estrictamente prohibido usar parrafos <p>' IN texto_prompt) > 0 AS con_encabezados_semanticos,
       position('sin encabezados ni vinetas' IN texto_prompt) = 0                      AS sin_contradiccion,
       position('(2026, 24 de febrero)' IN texto_prompt) > 0                          AS con_fecha_apa,
       position('{{*parsed_email.clean_body}}' IN texto_prompt) > 0                   AS directiva_obligatoria
  FROM plantillas_prompts_ia
 WHERE codigo = 'NOTIWEB_DEFAULT';

SELECT nombre,
       position('<h2>Referencia bibliográfica</h2>' IN contenido_html) > 0 AS referencia_en_h2
  FROM plantillas_html
 WHERE nombre = 'Notiweb · Noticia institucional';
