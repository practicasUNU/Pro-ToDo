-- =============================================================================
-- Migracion 047 - Indice de alertas por ejecucion
--
-- QUE ANADE. `idx_alertas_error_id_ejecucion` sobre `alertas_error(id_ejecucion)`.
--
-- POR QUE AHORA. El listado de ejecuciones calcula `hasAlerts` con un
-- `SELECT DISTINCT id_ejecucion ... WHERE id_ejecucion IN (...)` por pagina, y
-- el visor de logs decide con esa marca si ofrece la traza. Sin indice, cada
-- pagina recorre la tabla de alertas entera.
--
-- `init.sql` ya declara el indice desde que nacio la tabla, pero ninguna
-- migracion lo creaba (la 015 y la 016 crearon los otros tres): una base
-- construida a base de migraciones no lo tiene. Por eso `init.sql` NO cambia.
--
-- IDEMPOTENTE: `CREATE INDEX IF NOT EXISTS`.
--
-- Aplicar con:
--   cd backend && npm run db:migrate
-- o directamente:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' < db/migrations/047-indice-alertas-por-ejecucion.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

CREATE INDEX IF NOT EXISTS idx_alertas_error_id_ejecucion
    ON alertas_error (id_ejecucion);

COMMIT;

-- Verificacion manual tras aplicar:
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'alertas_error' ORDER BY indexname;
