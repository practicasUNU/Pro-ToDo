-- =============================================================================
-- Migracion 053 - Accion de auditoria REANUDAR
--
-- QUE ANADE. El literal `REANUDAR` al CHECK `audit_eventos_accion_check`.
--
-- QUE PROBLEMA RESUELVE. La reanudacion manual de una ejecucion detenida
-- (CU-09, `POST /api/executions/:id/resume` y la orden por correo entrante) no
-- dejaba ninguna fila en `audit_eventos`: solo una ADVERTENCIA en `logs_nodo`.
-- Es la intervencion humana mas delicada del motor —acepta que el fallo que lo
-- detuvo quedo resuelto y vuelve a armar el flujo— y el auditor no podia
-- responder «quien reanudo este flujo». Desde esta migracion `WorkflowsService
-- .reactivateAfterResume` registra `REANUDAR`, y `AuditInterceptor` usa el
-- mismo literal para un PATCH que lleva un flujo de PAUSADO a ACTIVO.
--
-- POR QUE UNA MIGRACION. El CHECK enumera las acciones validas: sin ampliarlo,
-- el INSERT del evento violaria la restriccion. `AuditLoggerService.record` es
-- best-effort, asi que el fallo NO tumbaria la reanudacion, pero el evento se
-- perderia en silencio salvo por un aviso en el log del servidor.
--
-- IDEMPOTENTE: la restriccion se suelta con `IF EXISTS` y se repone completa.
-- `init.sql` queda sincronizado en el mismo commit.
--
-- Aplicar con:
--   cd backend && npm run db:migrate
-- o directamente:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' < db/migrations/053-auditoria-accion-reanudar.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

ALTER TABLE audit_eventos
    DROP CONSTRAINT IF EXISTS audit_eventos_accion_check;

ALTER TABLE audit_eventos
    ADD CONSTRAINT audit_eventos_accion_check CHECK (accion IN (
        'CREAR', 'ACTUALIZAR', 'ELIMINAR', 'CAMBIO_ROL',
        'INICIO_SESION', 'INICIO_SESION_FALLIDO', 'CIERRE_SESION',
        'ACTIVAR', 'DESACTIVAR', 'REANUDAR'
    ));

COMMIT;

-- Verificacion manual tras aplicar:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname = 'audit_eventos_accion_check';
-- =============================================================================
