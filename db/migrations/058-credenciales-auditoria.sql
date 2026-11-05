-- =============================================================================
-- Migracion 058 - Columnas de auditoria en `credenciales`
--
-- QUE ANADE. `creado_por` y `actualizado_por` (UUID, FK a `usuarios`) en la
-- boveda de credenciales, y renombra `creado_en` / `actualizado_en` a
-- `fecha_creacion` / `fecha_actualizacion`.
--
-- QUE PROBLEMA RESUELVE. `credenciales` era la unica tabla maestra fuera de
-- `AuditableEntity` (migracion 045): la tabla de Credenciales no podia mostrar
-- quien roto por ultima vez un secreto sin bucear en `audit_eventos`. Con esta
-- migracion comparte nombres y tipos con `flujos`, `plantillas_html`, etc., y
-- la entidad pasa a heredar de `AuditableEntity`.
--
-- DISENO.
--   * Las dos columnas de autor son NULL: las filas historicas no tienen autor
--     conocido, y un usuario borrado no debe arrastrar las credenciales que
--     toco (`ON DELETE SET NULL`), igual que en la migracion 045.
--   * El renombrado conserva los datos: no se recrea ninguna columna.
--
-- IDEMPOTENTE: `ADD COLUMN IF NOT EXISTS`, y el renombrado solo se aplica si
-- la columna antigua sigue existiendo. `init.sql` queda sincronizado en el
-- mismo commit.
--
-- Aplicar con:
--   cd backend && npm run db:migrate
-- o directamente:
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' < db/migrations/058-credenciales-auditoria.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'credenciales' AND column_name = 'creado_en'
    ) THEN
        ALTER TABLE credenciales RENAME COLUMN creado_en TO fecha_creacion;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'credenciales' AND column_name = 'actualizado_en'
    ) THEN
        ALTER TABLE credenciales RENAME COLUMN actualizado_en TO fecha_actualizacion;
    END IF;
END
$$;

ALTER TABLE credenciales
    ADD COLUMN IF NOT EXISTS creado_por UUID NULL
        REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS actualizado_por UUID NULL
        REFERENCES usuarios(id_usuario) ON DELETE SET NULL;

COMMIT;

-- Verificacion manual tras aplicar:
--   \d credenciales
-- =============================================================================
