-- =============================================================================
-- Migracion 063 · Prompts de Innodays e Innobar (destino Drupal, modo enlace)
--
-- Siembra en `plantillas_prompts_ia` los dos prompts que alimentan a los presets
-- INNODAYS e INNOBAR del destino Drupal (`UPDATE_LINK_SOURCE`). Ese modo no
-- publica marcado: cambia el `href` de UNA fila de la tabla de eventos de la
-- pagina, localizada por el nombre del evento. Del PROCESADOR_IA solo necesita
-- dos datos, el nombre y el enlace.
--
-- POR QUE "headline" Y "summary". El contrato de salida del PROCESADOR_IA es
-- CERRADO (`additionalProperties: false` en `buildResponseJsonSchema`): solo
-- admite `headline`, `summary` y `body_paragraphs`, y los proveedores descartan
-- cualquier otra clave. Un prompt que pidiera `evento_nombre` o `url` veria su
-- respuesta recortada a cadenas vacias. Se reutilizan los dos campos de texto
-- con la misma convencion que el prompt de licitaciones, que coloca el
-- expediente en `headline`. El preset lee:
--   linkSelector      = table tr:contains('{{llm_response.headline}}') a
--   linkValueTemplate = {{llm_response.summary}}
--
-- POR QUE NO CITAN `{{rendered_html.compiled_markup}}`. Sin plantilla base, el
-- nodo no pide `filled_markup` y no hace falta ningun ESCUDO_POST_IA detras:
-- `UPDATE_LINK_SOURCE` no consume marcado. Por lo mismo, esta migracion NO
-- siembra nada en `plantillas_html`.
--
-- POR QUE EL NOMBRE TIENE QUE SER LITERAL. `:contains()` compara texto exacto,
-- con mayusculas y tildes. Un nombre reformulado no casa con ninguna fila, y
-- uno vacio casa con todas; en los dos casos el nodo se detiene con
-- ERR_DRUPAL_DOM_TARGET sin escribir. Un enlace vacio o con un esquema
-- ejecutable se rechaza con ERR_DRUPAL_MISSING_PAYLOAD antes de leer la pagina.
--
-- El contrato JSON NO va en el texto: el backend lo anade al final de cada
-- prompt (`buildResponseContractInstruction`), igual que en la 023 y la 032.
--
-- Idempotente: `ON CONFLICT (codigo) DO NOTHING`. Si el equipo ya ajusto uno de
-- estos prompts desde el gestor, reaplicar la migracion no se lo pisa. Sin un
-- ADMIN activo AVISA y no inserta, en vez de detener `db:migrate` (la base de
-- pruebas E2E puede no tenerlo).
--
-- Aplicar con:
--   npm run db:migrate          (desde backend/)
-- o a mano:
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' \
--     < db/migrations/063-plantillas-prompts-drupal.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

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
        RAISE WARNING '063: sin ningun usuario ADMIN activo no se pueden sembrar los prompts de Innodays e Innobar (id_usuario_creador es NOT NULL). Aplica db/migrations/002-bootstrap-admin.sql y vuelve a lanzar esta migracion.';
        RETURN;
    END IF;

    INSERT INTO plantillas_prompts_ia (codigo, nombre, descripcion, texto_prompt, id_usuario_creador)
    VALUES
        (
            'INNODAYS_ENLACE_DEFAULT',
            'Innodays · Enlace de jornada sectorial',
            'Extrae el nombre literal de la jornada (headline) y el enlace a publicar (summary). Destino: preset INNODAYS (UPDATE_LINK_SOURCE).',
            'Eres el gestor de la agenda de Innodays de Madrid+D, el ciclo de jornadas sectoriales de innovacion. A partir del correo que se te da mas abajo, identifica la jornada a la que se refiere y el enlace que debe publicarse para ella en la tabla de eventos del portal.' || E'\n\n' ||
            'Datos que debes localizar:' || E'\n' ||
            '- evento_nombre (el nombre de la jornada EXACTAMENTE como figura en el correo, con sus mayusculas, tildes y signos, sin comillas ni prefijos como "Jornada:")' || E'\n' ||
            '- enlace (la URL completa de inscripcion, programa o grabacion que el correo pide publicar)' || E'\n\n' ||
            'Reglas:' || E'\n' ||
            '- No reformules, abrevies ni traduzcas el nombre: la tabla del portal se busca por ese texto literal y cualquier variacion deja el enlace sin actualizar.' || E'\n' ||
            '- El enlace empieza por https:// o http://. Si el correo trae varios, elige el que el remitente pide publicar; si no lo indica, el de inscripcion.' || E'\n' ||
            '- Si falta alguno de los dos datos, deja su campo vacio. No inventes ni completes URLs.' || E'\n\n' ||
            'Coloca el nombre de la jornada en "headline", el enlace en "summary" y deja "body_paragraphs" como una lista vacia.' || E'\n\n' ||
            'Correo:' || E'\n' ||
            '{{parsed_email.clean_body}}',
            autor
        ),
        (
            'INNOBAR_ENLACE_DEFAULT',
            'Innobar · Enlace de encuentro de networking',
            'Extrae el nombre literal del encuentro (headline) y el enlace a publicar (summary). Destino: preset INNOBAR (UPDATE_LINK_SOURCE).',
            'Eres el gestor de la agenda de Innobar de Madrid+D, los afterworks y encuentros de networking informal entre investigadores, empresas y emprendedores. A partir del correo que se te da mas abajo, identifica el encuentro al que se refiere y el enlace que debe publicarse para el en la tabla de eventos del portal.' || E'\n\n' ||
            'Datos que debes localizar:' || E'\n' ||
            '- evento_nombre (el nombre del encuentro EXACTAMENTE como figura en el correo, con sus mayusculas, tildes y signos, sin comillas ni prefijos como "Encuentro:")' || E'\n' ||
            '- enlace (la URL completa de inscripcion o de la convocatoria del encuentro que el correo pide publicar)' || E'\n\n' ||
            'Reglas:' || E'\n' ||
            '- No reformules, abrevies ni traduzcas el nombre: la tabla del portal se busca por ese texto literal y cualquier variacion deja el enlace sin actualizar.' || E'\n' ||
            '- El enlace empieza por https:// o http://. Si el correo trae varios, elige el que el remitente pide publicar; si no lo indica, el de inscripcion.' || E'\n' ||
            '- Si falta alguno de los dos datos, deja su campo vacio. No inventes ni completes URLs.' || E'\n\n' ||
            'Coloca el nombre del encuentro en "headline", el enlace en "summary" y deja "body_paragraphs" como una lista vacia.' || E'\n\n' ||
            'Correo:' || E'\n' ||
            '{{parsed_email.clean_body}}',
            autor
        )
    ON CONFLICT (codigo) DO NOTHING;
END $$;

COMMIT;

-- =============================================================================
-- Comprobacion del resultado
--
-- Dos filas activas. `mapea_headline` en true y `usa_plantilla` en false: si
-- citaran la plantilla base, el nodo pediria `filled_markup` y el flujo de
-- enlace necesitaria un ESCUDO_POST_IA que no tiene.
-- =============================================================================

SELECT codigo,
       nombre,
       activo,
       texto_prompt LIKE '%"headline"%'      AS mapea_headline,
       texto_prompt LIKE '%compiled_markup%' AS usa_plantilla,
       length(texto_prompt)                  AS bytes_prompt
  FROM plantillas_prompts_ia
 WHERE codigo IN ('INNODAYS_ENLACE_DEFAULT', 'INNOBAR_ENLACE_DEFAULT')
 ORDER BY codigo;
