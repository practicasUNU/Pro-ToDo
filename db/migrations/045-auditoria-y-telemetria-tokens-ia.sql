-- =============================================================================
-- Migracion 045 - Auditoria de tablas maestras y telemetria de tokens de IA
--
-- QUE ANADE.
--
-- 1. AUDITORIA COMUN (`AuditableEntity`). Las seis tablas maestras -
--    `allowed_ips`, `plantillas_html`, `flujos`, `usuarios`, `plantillas_flujo`
--    y `plantillas_prompts_ia`- pasan a compartir cuatro columnas con el mismo
--    nombre y el mismo tipo:
--      creado_por          UUID  -> usuarios (nullable, ON DELETE SET NULL)
--      fecha_creacion      TIMESTAMPTZ NOT NULL
--      actualizado_por     UUID  -> usuarios (nullable, ON DELETE SET NULL)
--      fecha_actualizacion TIMESTAMPTZ NOT NULL
--
-- 2. `precios_modelos_ia`: tarifas por millon de tokens, versionadas por
--    `vigente_desde`. Cambiar un precio es insertar una fila, nunca editarla.
--
-- 3. `telemetria_tokens_ia`: una fila por inferencia facturada de los nodos
--    PROCESADOR_IA y PROCESADOR_OCR.
--
-- QUE PROBLEMA RESUELVE. El gasto de IA solo sobrevivia como dos contadores
-- dentro del JSONB `ejecuciones_flujo.contexto_acumulado`: imposible de agregar
-- por flujo, proveedor o mes, sin coste y sin los tokens de razonamiento de
-- Gemini (`thoughtsTokenCount`), que se facturan aparte. Y las tablas maestras
-- no registraban quien las modificaba, con las fechas repartidas entre
-- `TIMESTAMP` y `TIMESTAMPTZ` y con nombres distintos en `allowed_ips`.
--
-- NORMALIZACION DE FECHAS.
--   * `allowed_ips.creado_en` / `actualizado_en` se RENOMBRAN a
--     `fecha_creacion` / `fecha_actualizacion`, como en el resto del esquema.
--   * `flujos`, `usuarios` y `plantillas_flujo` pasan de `TIMESTAMP` a
--     `TIMESTAMPTZ`. La conversion interpreta los valores en la zona horaria de
--     la sesion, que es la misma con la que `CURRENT_TIMESTAMP` los escribio.
--   * `fecha_actualizacion` nace donde faltaba, rellena con `fecha_creacion`:
--     es la mejor aproximacion honesta, ninguna fila consta como editada.
--
-- POR QUE `id_usuario_creador` NO SE BORRA. Es NOT NULL, lo rellena el JWT en
-- `plantillas_html`, `flujos` y `plantillas_prompts_ia`, y los servicios lo
-- leen hoy. `creado_por` se SIEMBRA desde ella para no empezar en blanco, pero
-- retirarla es otra migracion, cuando los servicios escriban la auditoria.
--
-- POR QUE LA TELEMETRIA GUARDA LAS TARIFAS Y NO UNA FK A `precios_modelos_ia`.
-- Inmutabilidad historica: el coste de una inferencia de hoy no puede cambiar
-- porque un proveedor suba precios manana. `es_estimado` marca las filas cuyo
-- coste no es exacto (sin uso informado o sin tarifa propia del modelo).
--
-- POR QUE `flujo_id` ES REDUNDANTE CON `ejecucion_id`. Es el eje de agregacion
-- mas comun; tenerlo en la fila evita un JOIN en cada informe. Lo resuelve el
-- propio INSERT desde `ejecuciones_flujo`, nunca el `flowId` del JSON.
--
-- TARIFAS SEMBRADAS. Solo las verificadas: Anthropic (precio oficial de API;
-- el thinking va dentro de `output_tokens` y se cobra a tarifa de salida) y
-- OpenAI `gpt-4o`. Las de GEMINI NO se siembran a proposito: sin fila, el coste
-- sale 0 con `es_estimado = TRUE`, que es honesto; un precio inventado no lo
-- seria. Ver el bloque TODO al final de la seccion 3.
--
-- `init.sql` se actualiza en el mismo commit.
--
-- IDEMPOTENTE. Renombrados y conversiones condicionados a `information_schema`,
-- columnas con `ADD COLUMN IF NOT EXISTS`, tablas e indices con `IF NOT EXISTS`
-- y semillas con `ON CONFLICT DO NOTHING`.
--
-- Aplicar con:
--   cd backend && npm run db:migrate
-- o directamente:
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' < db/migrations/045-auditoria-y-telemetria-tokens-ia.sql
--
-- El backend debe reiniciarse DESPUES de aplicarla: las entidades ya esperan
-- `allowed_ips.fecha_creacion` y las columnas de auditoria.
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- -----------------------------------------------------------------------------
-- 1. allowed_ips: nombres de fecha alineados con el resto del esquema
-- -----------------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'allowed_ips' AND column_name = 'creado_en'
    ) THEN
        ALTER TABLE allowed_ips RENAME COLUMN creado_en TO fecha_creacion;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'allowed_ips' AND column_name = 'actualizado_en'
    ) THEN
        ALTER TABLE allowed_ips RENAME COLUMN actualizado_en TO fecha_actualizacion;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Columnas de auditoria en las seis tablas maestras
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    tabla TEXT;
BEGIN
    FOREACH tabla IN ARRAY ARRAY[
        'allowed_ips',
        'plantillas_html',
        'flujos',
        'usuarios',
        'plantillas_flujo',
        'plantillas_prompts_ia'
    ]
    LOOP
        -- fecha_creacion: existe en todas; se crea por si acaso y se normaliza.
        EXECUTE format(
            'ALTER TABLE %I ADD COLUMN IF NOT EXISTS fecha_creacion TIMESTAMPTZ',
            tabla
        );

        IF EXISTS (
            SELECT 1 FROM information_schema.columns
             WHERE table_name = tabla
               AND column_name = 'fecha_creacion'
               AND data_type = 'timestamp without time zone'
        ) THEN
            EXECUTE format(
                'ALTER TABLE %I ALTER COLUMN fecha_creacion TYPE TIMESTAMPTZ',
                tabla
            );
        END IF;

        EXECUTE format(
            'UPDATE %I SET fecha_creacion = CURRENT_TIMESTAMP WHERE fecha_creacion IS NULL',
            tabla
        );
        EXECUTE format(
            'ALTER TABLE %I ALTER COLUMN fecha_creacion SET DEFAULT CURRENT_TIMESTAMP, '
            'ALTER COLUMN fecha_creacion SET NOT NULL',
            tabla
        );

        -- fecha_actualizacion: falta en flujos, usuarios y plantillas_flujo.
        EXECUTE format(
            'ALTER TABLE %I ADD COLUMN IF NOT EXISTS fecha_actualizacion TIMESTAMPTZ',
            tabla
        );
        EXECUTE format(
            'UPDATE %I SET fecha_actualizacion = fecha_creacion WHERE fecha_actualizacion IS NULL',
            tabla
        );
        EXECUTE format(
            'ALTER TABLE %I ALTER COLUMN fecha_actualizacion SET DEFAULT CURRENT_TIMESTAMP, '
            'ALTER COLUMN fecha_actualizacion SET NOT NULL',
            tabla
        );

        -- Autoria: nullable, y un usuario borrado no arrastra lo que toco.
        EXECUTE format(
            'ALTER TABLE %I ADD COLUMN IF NOT EXISTS creado_por UUID '
            'REFERENCES usuarios(id_usuario) ON DELETE SET NULL',
            tabla
        );
        EXECUTE format(
            'ALTER TABLE %I ADD COLUMN IF NOT EXISTS actualizado_por UUID '
            'REFERENCES usuarios(id_usuario) ON DELETE SET NULL',
            tabla
        );
    END LOOP;
END $$;

-- Semilla de autoria: donde ya se sabia quien creo la fila.
UPDATE plantillas_html
   SET creado_por = id_usuario_creador
 WHERE creado_por IS NULL;

UPDATE flujos
   SET creado_por = id_usuario_creador
 WHERE creado_por IS NULL;

UPDATE plantillas_prompts_ia
   SET creado_por = id_usuario_creador
 WHERE creado_por IS NULL;

-- -----------------------------------------------------------------------------
-- 3. Tarifas de modelos de IA (USD por millon de tokens)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS precios_modelos_ia (
    id_precio_modelo_ia UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- Valor de `LlmProvider` (GEMINI, ANTHROPIC, OPENAI).
    proveedor_ia VARCHAR(30) NOT NULL,
    -- Modelo exacto, o '*' para la tarifa generica del proveedor: se aplica a
    -- modelos sin fila propia y deja la telemetria marcada como estimada.
    modelo_ia VARCHAR(100) NOT NULL,
    tarifa_prompt_usd_mtok NUMERIC(12, 6) NOT NULL CHECK (tarifa_prompt_usd_mtok >= 0),
    tarifa_completacion_usd_mtok NUMERIC(12, 6) NOT NULL CHECK (tarifa_completacion_usd_mtok >= 0),
    -- Solo la usa Gemini, que factura el razonamiento aparte de la salida.
    tarifa_razonamiento_usd_mtok NUMERIC(12, 6) NOT NULL CHECK (tarifa_razonamiento_usd_mtok >= 0),
    vigente_desde TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_por UUID REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_por UUID REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_precios_modelos_ia_vigencia UNIQUE (proveedor_ia, modelo_ia, vigente_desde)
);

INSERT INTO precios_modelos_ia (
    proveedor_ia, modelo_ia,
    tarifa_prompt_usd_mtok, tarifa_completacion_usd_mtok, tarifa_razonamiento_usd_mtok,
    vigente_desde
) VALUES
    ('ANTHROPIC', 'claude-opus-5-5',   4.00, 20.00, 20.00, '2026-10-01 00:00:00+00'),
    ('ANTHROPIC', 'claude-sonnet-5-5', 2.00, 10.00, 10.00, '2026-10-01 00:00:00+00'),
    ('ANTHROPIC', 'claude-haiku-4-5',  1.00,  5.00,  5.00, '2026-10-01 00:00:00+00'),
    -- Generica de Anthropic a tarifa de Opus: cota superior para modelos sin
    -- fila propia, marcada siempre como estimada.
    ('ANTHROPIC', '*',                 4.00, 20.00, 20.00, '2026-10-01 00:00:00+00'),
    ('OPENAI',    'gpt-4o',            2.50, 10.00, 10.00, '2026-10-01 00:00:00+00')
ON CONFLICT (proveedor_ia, modelo_ia, vigente_desde) DO NOTHING;

-- TODO tarifas GEMINI: pendientes de confirmar contra la lista oficial de
-- Google. Hasta que se inserten, las inferencias de Gemini se registran con
-- coste 0 y `es_estimado = TRUE`. Plantilla:
--   INSERT INTO precios_modelos_ia (proveedor_ia, modelo_ia,
--       tarifa_prompt_usd_mtok, tarifa_completacion_usd_mtok,
--       tarifa_razonamiento_usd_mtok, vigente_desde)
--   VALUES ('GEMINI', 'gemini-3.6-flash', <in>, <out>, <out>, CURRENT_TIMESTAMP),
--          ('GEMINI', 'gemini-3.8-flash', <in>, <out>, <out>, CURRENT_TIMESTAMP);

-- -----------------------------------------------------------------------------
-- 4. Telemetria de tokens de IA
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS telemetria_tokens_ia (
    id_telemetria_tokens_ia UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ejecucion_id UUID NOT NULL REFERENCES ejecuciones_flujo(id_ejecucion) ON DELETE CASCADE,
    flujo_id UUID NOT NULL REFERENCES flujos(id_flujo) ON DELETE CASCADE,
    -- `nodeId` del pipeline: sin FK, igual que `logs_nodo.id_nodo`.
    nodo_id VARCHAR(50) NOT NULL,
    -- Proveedor y modelo que RESPONDIERON, no los configurados.
    proveedor_ia VARCHAR(30) NOT NULL,
    modelo_ia VARCHAR(100) NOT NULL,
    tokens_prompt INTEGER NOT NULL DEFAULT 0 CHECK (tokens_prompt >= 0),
    tokens_completacion INTEGER NOT NULL DEFAULT 0 CHECK (tokens_completacion >= 0),
    tokens_razonamiento INTEGER NOT NULL DEFAULT 0 CHECK (tokens_razonamiento >= 0),
    tokens_totales INTEGER NOT NULL DEFAULT 0 CHECK (tokens_totales >= 0),
    -- Fotografia de las tarifas aplicadas (USD por millon de tokens).
    tarifa_prompt_usd NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (tarifa_prompt_usd >= 0),
    tarifa_completacion_usd NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (tarifa_completacion_usd >= 0),
    tarifa_razonamiento_usd NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (tarifa_razonamiento_usd >= 0),
    costo_estimado_usd NUMERIC(12, 6) NOT NULL DEFAULT 0 CHECK (costo_estimado_usd >= 0),
    es_estimado BOOLEAN NOT NULL DEFAULT FALSE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_telemetria_tokens_ejecucion
    ON telemetria_tokens_ia (ejecucion_id);

CREATE INDEX IF NOT EXISTS idx_telemetria_tokens_flujo_fecha
    ON telemetria_tokens_ia (flujo_id, creado_en);

CREATE INDEX IF NOT EXISTS idx_telemetria_tokens_proveedor_modelo
    ON telemetria_tokens_ia (proveedor_ia, modelo_ia, creado_en);

COMMIT;

-- Verificacion manual tras aplicar:
--   SELECT table_name, column_name, data_type
--     FROM information_schema.columns
--    WHERE column_name IN ('creado_por', 'actualizado_por', 'fecha_creacion', 'fecha_actualizacion')
--      AND table_name IN ('allowed_ips', 'plantillas_html', 'flujos', 'usuarios',
--                         'plantillas_flujo', 'plantillas_prompts_ia')
--    ORDER BY table_name, column_name;
--   SELECT proveedor_ia, modelo_ia, tarifa_prompt_usd_mtok, tarifa_completacion_usd_mtok
--     FROM precios_modelos_ia ORDER BY proveedor_ia, modelo_ia;
--   \d telemetria_tokens_ia
