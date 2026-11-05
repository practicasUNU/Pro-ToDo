-- =============================================================================
-- Migracion 059 - Accion de auditoria FLUJO_DESCARTADO
--
-- QUE ANADE. El literal `FLUJO_DESCARTADO` al CHECK `audit_eventos_accion_check`.
--
-- QUE PROBLEMA RESUELVE. El descarte manual de una ejecucion detenida (CU-09,
-- `DELETE /api/executions/:id/discard`) desactiva su flujo y no dejaba ninguna
-- fila en `audit_eventos`. Desde esta migracion
-- `WorkflowsService.deactivateAfterDiscard` registra `FLUJO_DESCARTADO` con el
-- estado previo, la ejecucion y el motivo opcional del descarte.
--
-- POR QUE UNA MIGRACION. Mismo motivo que la 053: el CHECK enumera las acciones
-- validas, y sin ampliarlo el INSERT best-effort se perderia en silencio.
--
-- IDEMPOTENTE: la restriccion se suelta con `IF EXISTS` y se repone completa.
-- `init.sql` queda sincronizado en el mismo commit.
--
-- Aplicar con:
--   cd backend && npm run db:migrate
-- o directamente:
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' < db/migrations/059-auditoria-accion-flujo-descartado.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

ALTER TABLE audit_eventos
    DROP CONSTRAINT IF EXISTS audit_eventos_accion_check;

ALTER TABLE audit_eventos
    ADD CONSTRAINT audit_eventos_accion_check CHECK (accion IN (
        'CREAR', 'ACTUALIZAR', 'ELIMINAR', 'CAMBIO_ROL',
        'INICIO_SESION', 'INICIO_SESION_FALLIDO', 'CIERRE_SESION',
        'ACTIVAR', 'DESACTIVAR', 'REANUDAR', 'FLUJO_DESCARTADO'
    ));

COMMIT;

-- Verificacion manual tras aplicar:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname = 'audit_eventos_accion_check';
-- =============================================================================
