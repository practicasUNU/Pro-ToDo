-- =============================================================================
-- Migracion 067 · Notiweb: referencia bibliografica autonoma
--
-- La 065 exige APA 7 pero solo cuando el material cita un estudio; si no,
-- borraba el bloque de referencia. Esta migracion lo sustituye por una cascada:
--   1. obras citadas en el material (incluidas las "Referencias citadas" que
--      ahora extrae el EXTRACTOR_WEB),
--   2. el propio articulo original en APA 7 para paginas web, con el autor,
--      la fecha, el titulo y la URL que publica `scraped_web`,
--   3. si el extractor fallo o vino vacio, la IA reconstruye la referencia a
--      partir de la URL de la directiva del editor y de su conocimiento.
-- Ademas inserta en el prompt el bloque "Metadatos del articulo original".
--
-- Idempotente por marcador ("Referencia autonoma"). Exige la 065 aplicada;
-- si el prompt se edito a mano y no se reconocen sus reglas → EXCEPTION.
--
-- Aplicar con:
--   npm run db:migrate          (desde backend/)
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

DO $$
DECLARE
    marker CONSTANT TEXT := 'Referencia autonoma';
    old_data_rule CONSTANT TEXT :=
        '- Usa solo datos que figuren en el material. Si falta alguno, omitelo junto con su separador; nunca lo completes ni lo deduzcas.';
    old_remove_rule CONSTANT TEXT :=
        '- Si el material no cita ningun estudio, elimina del marcado el <hr>, el rotulo "Referencia bibliográfica:" y su parrafo.';
    attachments_anchor CONSTANT TEXT := 'Documentos adjuntos:' || E'\n';
    new_data_rule CONSTANT TEXT :=
        '- Referencia autonoma, por este orden de prioridad:' || E'\n' ||
        '  1. Si el material cita estudios o publicaciones (incluidas las "Referencias citadas" del articulo original), referencia esas obras con los datos que figuren en el.' || E'\n' ||
        '  2. Si no cita ninguna, referencia el propio articulo original en APA 7 para paginas web: Apellido, I. (Año, dia de mes). Titulo del articulo. <em>Nombre del sitio</em>. URL. Toma autor, fecha, titulo y URL de "Metadatos del articulo original".' || E'\n' ||
        '  3. Si el extractor web fallo o vino vacio (sin titulo ni URL), reconstruye la referencia APA 7 a partir de la URL que aparece en la directiva del editor y de tu conocimiento del tema.' || E'\n' ||
        '- Si falta el autor, empieza la referencia por el titulo; si falta la fecha, escribe (s. f.). Nunca inventes DOI, volumen ni paginas.';
    new_remove_rule CONSTANT TEXT :=
        '- Elimina del marcado el <hr>, el rotulo "Referencia bibliográfica:" y su parrafo SOLO si no hay estudio citado, ni articulo original, ni URL en la directiva del editor.';
    metadata_block CONSTANT TEXT :=
        'Metadatos del articulo original:' || E'\n' ||
        'Autor: {{scraped_web.author}}' || E'\n' ||
        'Fecha de publicacion: {{scraped_web.published_at}}' || E'\n' ||
        'Titulo: {{scraped_web.article_title}}' || E'\n' ||
        'URL: {{scraped_web.source_url}}' || E'\n' ||
        'Referencias citadas:' || E'\n' ||
        '{{scraped_web.references_text}}' || E'\n\n';
    current_prompt TEXT;
BEGIN
    SELECT texto_prompt
      INTO current_prompt
      FROM plantillas_prompts_ia
     WHERE codigo = 'NOTIWEB_DEFAULT';

    IF NOT FOUND THEN
        RAISE WARNING '067: no existe el prompt NOTIWEB_DEFAULT. No se ha modificado.';
        RETURN;
    END IF;

    IF position(marker IN current_prompt) > 0 THEN
        RAISE NOTICE '067: el prompt NOTIWEB_DEFAULT ya tiene la referencia autonoma.';
        RETURN;
    END IF;

    IF position('APA 7' IN current_prompt) = 0
       OR position(old_data_rule IN current_prompt) = 0
       OR position(old_remove_rule IN current_prompt) = 0
       OR position(attachments_anchor IN current_prompt) = 0 THEN
        RAISE EXCEPTION '067: el prompt NOTIWEB_DEFAULT no conserva las reglas de la 065 o el bloque de adjuntos. Aplica la 065 o anade la referencia autonoma desde el gestor de prompts.';
    END IF;

    UPDATE plantillas_prompts_ia
       SET texto_prompt = replace(
               replace(
                   replace(current_prompt, old_data_rule, new_data_rule),
                   old_remove_rule, new_remove_rule),
               attachments_anchor, metadata_block || attachments_anchor),
           fecha_actualizacion = NOW()
     WHERE codigo = 'NOTIWEB_DEFAULT';

    RAISE NOTICE '067: referencia autonoma y metadatos del articulo aplicados a NOTIWEB_DEFAULT.';
END $$;

COMMIT;

-- =============================================================================
-- Comprobacion del resultado: las tres columnas en true.
-- =============================================================================

SELECT codigo,
       position('Referencia autonoma' IN texto_prompt) > 0              AS con_referencia_autonoma,
       position('{{scraped_web.references_text}}' IN texto_prompt) > 0  AS con_metadatos,
       position('AL MENOS DOS encabezados' IN texto_prompt) > 0         AS con_encabezados
  FROM plantillas_prompts_ia
 WHERE codigo = 'NOTIWEB_DEFAULT';
