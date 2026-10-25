-- =============================================================================
-- Migracion 052 - Una sola tarifa vigente por (proveedor_ia, modelo_ia)
--
-- QUE ANADE. Un indice unico PARCIAL sobre `precios_modelos_ia` que solo
-- cubre las filas con `activo = TRUE`.
--
-- QUE PROBLEMA RESUELVE. El CRUD de tarifas (`PricingService.create`) releva
-- la vigente en una transaccion: la bloquea con `SELECT ... FOR UPDATE`, la
-- pasa a historico e inserta la nueva. El bloqueo cubre la carrera entre dos
-- ADMIN que ya ven una vigente, pero NO la de dos altas simultaneas de un par
-- que todavia no tiene ninguna: no hay fila que bloquear, y las dos
-- transacciones insertarian su `activo = TRUE`. Con dos vigentes,
-- `TelemetryService.resolvePricing` elegiria una por `vigente_desde` y el coste
-- dependeria de quien gano la carrera. Este indice convierte esa carrera en un
-- `23505` que el servicio traduce a un 409 legible.
--
-- POR QUE PARCIAL. El historico SI repite el par (es justo lo que es un
-- historial); lo unico que no puede repetirse es la vigente.
--
-- DATOS PREVIOS. Comprobado antes de escribirla (2026-10-23): ningun par tiene
-- mas de una fila activa, asi que el indice se crea sin conflictos.
--
-- `init.sql` se actualiza en el mismo commit.
--
-- IDEMPOTENTE: `CREATE UNIQUE INDEX IF NOT EXISTS`.
--
-- Aplicar con:
--   cd backend && npm run db:migrate
-- o directamente:
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' < db/migrations/052-tarifa-activa-unica.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_precios_modelos_ia_activa
    ON precios_modelos_ia (proveedor_ia, modelo_ia)
 WHERE activo;

COMMIT;

-- Verificacion manual tras aplicar:
--   \d precios_modelos_ia
--   SELECT proveedor_ia, modelo_ia, COUNT(*) FILTER (WHERE activo)
--     FROM precios_modelos_ia GROUP BY 1, 2 ORDER BY 1, 2;
