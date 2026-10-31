-- =============================================================================
-- Migracion 062 · El esqueleto de apertura de licitacion lleva la clase estandar
--
-- `APPEND_HTML_BLOCK` envuelve cada licitacion nueva en
-- `div.pd-licitacion-block[data-expediente]` (`tender-block.util.ts`), y
-- "Cerrar licitacion" la localiza despues por esa clase. Pero el envoltorio solo
-- se pone cuando hay expediente: si el PROCESADOR_IA no rellena
-- `data-expediente`, el bloque se publica con la clase de la plantilla
-- (`licitacion-entry`) y nada mas. Sembrar la clase estandar EN LA RAIZ DEL
-- ESQUELETO hace que todo bloque de apertura sea localizable por la misma
-- clase, lo rellene quien lo rellene.
--
-- NO SE SIEMBRA NINGUN MARCADOR `{{...}}`, y no por estilo: el
-- MAPEADOR_PLANTILLA rechaza con ERR_TEMPLATE_PENDING_VARS toda plantilla cuya
-- `variables_esperadas` no venga vacia (cabeceras de la 028 y la 031). Las
-- plantillas dinamicas del destino Drupal —titulo, resumen, selector del enlace,
-- expediente— viven en los PARAMS del nodo, que es donde se interpolan.
--
-- POR QUE UNA EXPRESION REGULAR Y NO UN REPLACE LITERAL. La plantilla es
-- editable desde el gestor: el atributo puede llegar con comillas simples o
-- dobles, con espacios alrededor del `=` o con otras clases junto a
-- `licitacion-entry`. Un REPLACE literal que no casa deja 0 filas cambiadas y
-- la migracion "aplicada" sin haber hecho nada. Solo se sustituye la PRIMERA
-- aparicion (sin bandera 'g'): es la raiz del esqueleto.
--
-- POR QUE EL NOMBRE SE BUSCA POR PREFIJO. La 028 la sembro como
-- 'Licitaciones · Convocatoria abierta (Madrid+D)', y en la base de desarrollo
-- ya se llama '... (Madrid+D) V1': el nombre se edita desde el gestor. Un
-- WHERE por igualdad no la habria encontrado.
--
-- NADA EN SILENCIO, con dos salidas distintas:
--   · La plantilla NO EXISTE (base sin ADMIN cuando corrio la 028, como la de
--     pruebas E2E): WARNING y se sigue, el mismo criterio que la 028 y la 031.
--     Abortar aqui pararia toda la cadena de `db:migrate` por una semilla que
--     nunca se planto.
--   · La plantilla EXISTE pero su raiz ya no lleva `licitacion-entry`: EXCEPTION.
--     Es una estructura que esta migracion no sabe tocar, y la decide una
--     persona.
--
-- El saneador de plantillas conserva `class` en cualquier etiqueta y no declara
-- `allowedClasses` (`template-renderer.service.ts`), de modo que las dos clases
-- sobreviven al MAPEADOR_PLANTILLA.
--
-- Idempotente: si la plantilla ya lleva la clase, no hace nada.
--
-- Aplicar con:
--   npm run db:migrate          (desde backend/)
-- o a mano:
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' \
--     < db/migrations/062-plantilla-apertura-envoltorio-licitacion.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

DO $$
DECLARE
    template_name_pattern CONSTANT TEXT := '^Licitaciones · Convocatoria abierta \(Madrid\+D\)';
    root_class_pattern    CONSTANT TEXT := '(class\s*=\s*)(["''])([^"'']*\mlicitacion-entry\M[^"'']*)\2';
    candidates INTEGER;
    affected   INTEGER;
BEGIN
    SELECT count(*)
      INTO candidates
      FROM plantillas_html
     WHERE nombre ~ template_name_pattern;

    IF candidates = 0 THEN
        RAISE WARNING '062: no existe la plantilla de apertura de licitacion (se siembra en la 028 con un ADMIN activo). No se ha modificado nada.';
        RETURN;
    END IF;

    UPDATE plantillas_html
       SET contenido_html      = regexp_replace(contenido_html, root_class_pattern, '\1\2\3 pd-licitacion-block\2'),
           fecha_actualizacion = NOW()
     WHERE nombre ~ template_name_pattern
       AND contenido_html !~ '\mpd-licitacion-block\M'
       AND contenido_html ~ root_class_pattern;

    GET DIAGNOSTICS affected = ROW_COUNT;

    -- Las que quedan sin la clase despues del UPDATE son las que la regex no
    -- reconocio: plantilla editada a mano con otra raiz.
    IF EXISTS (
        SELECT 1
          FROM plantillas_html
         WHERE nombre ~ template_name_pattern
           AND contenido_html !~ '\mpd-licitacion-block\M'
    ) THEN
        RAISE EXCEPTION '062: hay una plantilla de apertura cuya raiz no lleva la clase licitacion-entry. Revisala desde el gestor de plantillas antes de reaplicar.';
    END IF;

    RAISE NOTICE '062: % plantilla(s) de apertura actualizada(s); % ya estaban al dia.', affected, candidates - affected;
END $$;

COMMIT;

-- Comprobacion: `envoltorio_ok` en true y `variables_pendientes` en 0. Un valor
-- distinto de 0 significaria que alguien metio marcadores en la plantilla y
-- que el MAPEADOR_PLANTILLA va a rechazarla en ejecucion.
SELECT nombre,
       activo,
       contenido_html ~ '\mpd-licitacion-block\M' AS envoltorio_ok,
       jsonb_array_length(variables_esperadas)   AS variables_pendientes
  FROM plantillas_html
 WHERE nombre ~ '^Licitaciones · Convocatoria abierta \(Madrid\+D\)'
 ORDER BY nombre;
