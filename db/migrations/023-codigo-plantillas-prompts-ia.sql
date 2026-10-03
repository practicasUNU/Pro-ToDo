-- =============================================================================
-- Migracion 023 · `codigo` en `plantillas_prompts_ia` y semillas de Madrid+D
--
-- POR QUE UNA CLAVE MAS. La tabla ya tiene dos identificadores y ninguno sirve
-- para referirse a un prompt desde el CODIGO:
--
--   · `id_plantilla_prompt_ia` es un UUID generado por la base. Cambia en cada
--     clonado, asi que una semilla, un test o un `pipeline_schema` versionado
--     que lo cite solo funciona en la maquina donde se genero.
--   · `nombre` es texto que el operador edita desde la tabla administrativa.
--     Es la etiqueta que reconoce una PERSONA en el selector del nodo IA.
--     Renombrar "Extraccion de licitaciones" a "Licitaciones (BOE)" es una
--     operacion legitima de interfaz que no deberia romper ningun flujo.
--
-- `codigo` es la clave de MAQUINA: mayusculas, sin espacios, inmutable una vez
-- creada. Es lo que permite que `LlmExtractorStrategy` resuelva
-- `promptCode: 'LICITACION_DEFAULT'` y que ese mismo literal valga en
-- desarrollo, en las pruebas y en produccion. Mismo papel que `clave` tiene en
-- el catalogo de nodos (migracion 011) frente a su etiqueta visible.
--
-- SIGUE SIN HABER MODELO NI TEMPERATURA AQUI, y no es un olvido: la migracion
-- 018 excluyo esos campos a proposito para que el mismo texto pueda ejecutarse
-- con Claude y con Gemini. `codigo` no rompe ese desacoplamiento porque sigue
-- siendo metadato del TEXTO, no de quien lo ejecuta. El modelo, la temperatura
-- y el maximo de tokens viven en los `params` del nodo PROCESADOR_IA
-- (`LlmExtractorConfigDto`), y la validacion estructural de la salida es
-- trabajo de ESCUDO_POST_IA.
--
-- EL ORDEN DE LOS PASOS IMPORTA. La columna nace NULLABLE, se rellenan las
-- filas existentes y solo entonces se endurece con NOT NULL y UNIQUE. Al reves,
-- una base con prompts ya creados rechazaria el ALTER y la migracion quedaria a
-- medias.
--
-- EL BACKFILL DERIVA DEL NOMBRE porque es lo unico que hay: mayusculas, lo no
-- alfanumerico a `_`, recorte a 50. Puede colisionar (dos nombres distintos que
-- normalizan igual), asi que el desempate anade un sufijo numerico. El
-- resultado es feo a proposito: quien tenga prompts previos deberia revisarlos,
-- y un codigo autogenerado se nota.
--
-- LAS SEMILLAS SON LOS TRES CASOS REALES de Madrid+D. El autor NO se escribe
-- literal: `id_usuario_creador` es NOT NULL con FK RESTRICT, asi que se resuelve
-- por subconsulta contra el ADMIN mas antiguo (el que siembra la migracion 002).
-- Sin ningun ADMIN activo la insercion no ocurre y la migracion avisa, en vez de
-- fallar con un error de clave ajena que no explicaria nada.
--
-- EL CONTRATO JSON NO VA EN EL TEXTO DE LAS SEMILLAS. Cada cliente de proveedor
-- antepone su `RESPONSE_CONTRACT_INSTRUCTION` con las claves obligatorias
-- (`headline`, `summary`, `body_paragraphs`), que son las de `LlmResponsePayload`.
-- Repetirlo aqui significaria que el primer prompt que alguien escriba sin
-- acordarse rompe el nodo. Por eso las tres semillas describen QUE extraer y lo
-- encajan en esas tres claves, en vez de inventarse una forma de salida propia.
--
-- Es idempotente: se puede reaplicar sin efectos secundarios.
--
-- `init.sql` se actualiza en el mismo commit: ese archivo solo se ejecuta con el
-- volumen de Docker vacio, asi que sin la copia una base nueva naceria sin la
-- columna ni las semillas.
--
-- MATIZ: a `init.sql` va la COLUMNA, no las semillas, y no es un descuido. Ese
-- archivo corre con el volumen vacio, cuando todavia no existe ningun usuario
-- —el ADMIN lo siembra la migracion 002—, y `id_usuario_creador` es NOT NULL
-- con FK RESTRICT. Copiar alli este INSERT solo produciria el RAISE WARNING de
-- mas abajo en cada arranque limpio. Las semillas son, por tanto, un paso de
-- migracion y hay que aplicarlas despues de la 002.
--
-- CORRECCION POSTERIOR (migracion 024). `NOTIWEB_DEFAULT` nacio sin el bloque
-- de documentos adjuntos que sus dos hermanas si traian. Aqui ya figura, para
-- las bases que se creen desde cero; una base YA sembrada no cambia con este
-- archivo —`ON CONFLICT DO NOTHING`— y por eso ese ajuste necesita su propia
-- migracion con un UPDATE.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/023-codigo-plantillas-prompts-ia.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. La columna, nullable de momento.
-- -----------------------------------------------------------------------------
ALTER TABLE plantillas_prompts_ia
    ADD COLUMN IF NOT EXISTS codigo VARCHAR(50);

-- -----------------------------------------------------------------------------
-- 2. Backfill de las filas previas a esta migracion.
--
--    El bucle recorre solo las que tienen `codigo` nulo, de modo que reaplicar
--    la migracion no reescribe nada. El sufijo numerico resuelve las
--    colisiones consultando la propia tabla en cada vuelta.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    fila        RECORD;
    base_code   TEXT;
    final_code  TEXT;
    sufijo      INT;
BEGIN
    FOR fila IN
        SELECT id_plantilla_prompt_ia, nombre
          FROM plantillas_prompts_ia
         WHERE codigo IS NULL
    LOOP
        -- Mayusculas, lo no alfanumerico a `_`, guiones bajos colapsados y
        -- recortados de los extremos, y como mucho 50 caracteres.
        base_code := UPPER(regexp_replace(fila.nombre, '[^a-zA-Z0-9]+', '_', 'g'));
        base_code := TRIM(BOTH '_' FROM base_code);
        base_code := LEFT(NULLIF(base_code, ''), 50);

        -- Un nombre compuesto solo de simbolos dejaria la cadena vacia.
        IF base_code IS NULL THEN
            base_code := 'PROMPT';
        END IF;

        final_code := base_code;
        sufijo := 1;

        WHILE EXISTS (
            SELECT 1 FROM plantillas_prompts_ia WHERE codigo = final_code
        ) LOOP
            sufijo := sufijo + 1;
            -- Se recorta la BASE y no el resultado: truncar despues de pegar el
            -- sufijo podria cortarlo y volver a colisionar indefinidamente.
            final_code := LEFT(base_code, 50 - LENGTH('_' || sufijo)) || '_' || sufijo;
        END LOOP;

        UPDATE plantillas_prompts_ia
           SET codigo = final_code
         WHERE id_plantilla_prompt_ia = fila.id_plantilla_prompt_ia;
    END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Endurecimiento: UNIQUE y NOT NULL.
--
--    `ADD CONSTRAINT` no admite `IF NOT EXISTS`, de ahi las guardas contra el
--    catalogo, igual que en la migracion 019. `SET NOT NULL` si es idempotente.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'plantillas_prompts_ia'::regclass
           AND conname = 'plantillas_prompts_ia_codigo_key'
    ) THEN
        ALTER TABLE plantillas_prompts_ia
            ADD CONSTRAINT plantillas_prompts_ia_codigo_key UNIQUE (codigo);
    END IF;
END $$;

ALTER TABLE plantillas_prompts_ia
    ALTER COLUMN codigo SET NOT NULL;

-- Indice explicito para la resolucion por codigo desde la FSM. El UNIQUE ya
-- crea uno, pero se declara con nombre propio por simetria con el del autor y
-- para que una futura retirada del UNIQUE no se lleve por delante la busqueda.
CREATE INDEX IF NOT EXISTS idx_plantillas_prompts_ia_codigo
    ON plantillas_prompts_ia(codigo);

-- -----------------------------------------------------------------------------
-- 4. Semillas: los tres casos de uso reales de Madrid+D.
--
--    `ON CONFLICT (codigo) DO NOTHING`: si el equipo ya ajusto el texto de una
--    semilla, reaplicar la migracion NO se lo pisa. Curar prompts es trabajo del
--    CRUD, no de una migracion.
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
        RAISE WARNING 'Sin ningun usuario ADMIN activo no se pueden sembrar los prompts (id_usuario_creador es NOT NULL). Aplica db/migrations/002-bootstrap-admin.sql y vuelve a lanzar esta migracion.';
        RETURN;
    END IF;

    INSERT INTO plantillas_prompts_ia (codigo, nombre, descripcion, texto_prompt, id_usuario_creador)
    VALUES
        (
            'NOTIWEB_DEFAULT',
            'Notiweb · Redaccion institucional',
            'Redacta la noticia de Notiweb a partir de la directiva del correo y el articulo original.',
            'Eres el redactor jefe de Madrid+D. Redacta una noticia institucional a partir del material que se te da mas abajo.' || E'\n\n' ||
            'Reglas de estilo, de obligado cumplimiento:' || E'\n' ||
            '- El titular es institucional y sobrio. NUNCA termina en punto.' || E'\n' ||
            '- La entradilla resume la noticia en menos de 600 caracteres. Tampoco termina en punto.' || E'\n' ||
            '- El desarrollo se entrega como parrafos independientes, sin encabezados ni vinetas.' || E'\n' ||
            '- No inventes datos, cifras ni declaraciones que no esten en el material.' || E'\n\n' ||
            'Coloca el titular en "headline", la entradilla en "summary" y los parrafos de desarrollo en "body_paragraphs".' || E'\n\n' ||
            'Directiva del editor:' || E'\n' ||
            '{{parsed_email.clean_body}}' || E'\n\n' ||
            'Articulo original:' || E'\n' ||
            '{{scraped_web.full_article_content}}' || E'\n\n' ||
            'Documentos adjuntos:' || E'\n' ||
            '{{parsed_email.extracted_documents_text}}',
            autor
        ),
        (
            'LICITACION_DEFAULT',
            'Licitaciones · Extraccion de contratacion publica',
            'Extrae los datos de un expediente de contratacion administrativa desde el correo y sus adjuntos.',
            'Eres un tecnico de contratacion administrativa publica de Madrid+D. Extrae los datos del expediente que aparece en el material de mas abajo.' || E'\n\n' ||
            'Datos que debes localizar:' || E'\n' ||
            '- expediente (codigo identificador)' || E'\n' ||
            '- objeto_contrato' || E'\n' ||
            '- presupuesto_base: base_imponible, iva y total' || E'\n' ||
            '- plazo_recepcion: fecha en formato ISO 8601 y hora' || E'\n' ||
            '- duracion_meses' || E'\n' ||
            '- enlace_consulta' || E'\n\n' ||
            'Reglas:' || E'\n' ||
            '- Un dato que no aparezca en el material se deja vacio. NUNCA lo estimes ni lo deduzcas.' || E'\n' ||
            '- Los importes van en euros, con punto decimal y sin separador de millares.' || E'\n\n' ||
            'Coloca el codigo de expediente en "headline", el objeto del contrato en "summary" y, en "body_paragraphs", una entrada por cada dato restante con el formato "campo: valor".' || E'\n\n' ||
            'Correo:' || E'\n' ||
            '{{parsed_email.clean_body}}' || E'\n\n' ||
            'Documentos adjuntos:' || E'\n' ||
            '{{parsed_email.extracted_documents_text}}',
            autor
        ),
        (
            'PANELES_UEM_DEFAULT',
            'Paneles universitarios · Comisiones de acreditacion',
            'Estructura las tablas de comisiones y evaluadores de renovacion de acreditacion.',
            'Procesa las tablas de comisiones y evaluadores universitarios de renovacion de acreditacion que aparecen mas abajo, en formato Markdown.' || E'\n\n' ||
            'De cada panel debes extraer: codigo_panel, centro, ruct, titulacion, fecha_visita (ISO 8601) y la lista de evaluadores con su rol, nombre e institucion.' || E'\n\n' ||
            'Reglas:' || E'\n' ||
            '- Respeta la grafia de los nombres propios y de las instituciones tal y como figuran en la tabla.' || E'\n' ||
            '- Un panel sin evaluadores se incluye igualmente, con la lista vacia.' || E'\n' ||
            '- No fusiones paneles distintos aunque compartan centro.' || E'\n\n' ||
            'Coloca en "headline" el centro y el numero de paneles encontrados, en "summary" el rango de fechas de visita, y en "body_paragraphs" una entrada por panel con su codigo, titulacion, RUCT, fecha y evaluadores.' || E'\n\n' ||
            'Paneles de acreditacion:' || E'\n' ||
            '{{parsed_email.extracted_documents_text}}',
            autor
        )
    ON CONFLICT (codigo) DO NOTHING;
END $$;

COMMIT;

-- =============================================================================
-- Comprobacion del resultado
-- =============================================================================

-- `codigo` debe salir como varchar(50) y NOT NULL.
SELECT column_name, data_type, character_maximum_length, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'plantillas_prompts_ia'
 ORDER BY ordinal_position;

-- Debe existir la restriccion UNIQUE con el nombre canonico.
SELECT conname, contype
  FROM pg_constraint
 WHERE conrelid = 'plantillas_prompts_ia'::regclass
 ORDER BY contype;

-- Las tres semillas deben estar presentes y activas.
SELECT codigo, nombre, activo, LENGTH(texto_prompt) AS longitud_prompt
  FROM plantillas_prompts_ia
 ORDER BY codigo;
