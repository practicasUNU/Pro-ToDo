-- =============================================================================
-- Migracion 008 · Gestor de plantillas HTML (PROT-11.1)
--
-- Alinea `plantillas_html` con la entidad `HtmlTemplate`. La tabla ya existia en
-- `init.sql` desde el esquema original, pero le faltaba todo lo que exige el
-- gestor: nombre unico y mas largo, descripcion, borrado logico, marca de
-- actualizacion y la garantia de que el HTML y las variables detectadas nunca
-- sean nulos.
--
-- `variables_esperadas` pasa a NOT NULL DEFAULT '[]' porque el servicio la
-- recalcula en cada escritura a partir del propio HTML: un NULL ahi significaria
-- "nunca se valido", un estado que ya no puede existir.
--
-- `id_usuario_creador` se conserva NOT NULL: el controlador lo puebla desde el
-- JWT (`@CurrentUser()`) y no desde el DTO, de modo que el cliente no puede
-- falsificar la autoria. Es lo que sostiene la trazabilidad que justifica el
-- borrado logico.
--
-- TypeORM corre con `synchronize: false` e `init.sql` solo se ejecuta cuando el
-- volumen `pgdata_protodo` esta vacio, asi que esta migracion se aplica a mano
-- sobre una base de datos ya poblada. Es idempotente (IF NOT EXISTS / IF EXISTS
-- y ALTERs convergentes): volver a ejecutarla no altera nada.
--
-- Aplicar con:
--   docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" \
--     < db/migrations/008-plantillas-html.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

-- 1. Columnas nuevas -----------------------------------------------------------

ALTER TABLE plantillas_html
    ADD COLUMN IF NOT EXISTS descripcion VARCHAR(255),
    ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 2. Saneado previo a las restricciones ---------------------------------------
-- Sin esto, los dos SET NOT NULL de abajo fallarian sobre filas preexistentes.

UPDATE plantillas_html SET contenido_html = '' WHERE contenido_html IS NULL;
UPDATE plantillas_html SET variables_esperadas = '[]'::jsonb WHERE variables_esperadas IS NULL;

-- 3. Endurecimiento de columnas existentes ------------------------------------

ALTER TABLE plantillas_html
    ALTER COLUMN nombre TYPE VARCHAR(120),
    ALTER COLUMN contenido_html SET NOT NULL,
    ALTER COLUMN variables_esperadas SET NOT NULL,
    ALTER COLUMN variables_esperadas SET DEFAULT '[]'::jsonb;

-- `fecha_creacion` pasa de TIMESTAMP a TIMESTAMPTZ para no perder la zona
-- horaria en las marcas de auditoria, igual que hizo `allowed_ips`. El cambio de
-- tipo va en su propia sentencia: combinarlo con SET DEFAULT en un mismo ALTER
-- TABLE obliga a PostgreSQL a recastear el default a medio camino del cambio de
-- tipo, y el orden de las fases no esta garantizado.
ALTER TABLE plantillas_html
    ALTER COLUMN fecha_creacion TYPE TIMESTAMPTZ;

ALTER TABLE plantillas_html
    ALTER COLUMN fecha_creacion SET DEFAULT CURRENT_TIMESTAMP,
    ALTER COLUMN fecha_creacion SET NOT NULL;

-- 4. Unicidad del nombre ------------------------------------------------------
-- Indice unico en vez de un UNIQUE inline: `CREATE UNIQUE INDEX IF NOT EXISTS`
-- es idempotente, mientras que `ADD CONSTRAINT` fallaria en la segunda pasada.

CREATE UNIQUE INDEX IF NOT EXISTS idx_plantillas_html_nombre
    ON plantillas_html(nombre);

COMMIT;

-- Comprobacion del resultado
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'plantillas_html'
 ORDER BY ordinal_position;
