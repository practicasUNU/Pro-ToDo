-- =============================================================================
-- Migracion 049 - Origen de la operacion en la telemetria de IA
--
-- QUE ANADE. Dos columnas en `telemetria_tokens_ia`:
--   - `origen_operacion`: 'EJECUCION_FLUJO' (nodo de IA dentro del FSM, el unico
--     origen hasta ahora y el valor por defecto) o 'PROMPT_OPTIMIZATION'
--     (asistente "Mejorar Prompt con IA").
--   - `usuario_id`: quien pidio la inferencia cuando no hay ejecucion.
-- Y relaja el NOT NULL de `ejecucion_id`, `flujo_id` y `nodo_id`.
--
-- QUE PROBLEMA RESUELVE. El asistente de prompts llama a un LLM real y cuesta
-- dinero, pero no ocurre dentro de ninguna ejecucion: con las tres columnas en
-- NOT NULL su gasto no se podia registrar, y el coste de IA del dashboard
-- habria quedado incompleto sin que nada lo delatase.
--
-- COHERENCIA. El CHECK `chk_telemetria_origen_coherente` impide filas a
-- medias: una de ejecucion trae ejecucion, flujo y nodo; una de optimizacion
-- trae el usuario. Las filas existentes cumplen la primera rama por el DEFAULT.
--
-- IDEMPOTENTE: `IF NOT EXISTS` en columnas e indice; el CHECK se recrea.
--
-- Aplicar con:
--   cd backend && npm run db:migrate
-- o directamente:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' < db/migrations/049-telemetria-origen-operacion.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

ALTER TABLE telemetria_tokens_ia
    ADD COLUMN IF NOT EXISTS origen_operacion VARCHAR(30) NOT NULL DEFAULT 'EJECUCION_FLUJO',
    ADD COLUMN IF NOT EXISTS usuario_id UUID NULL REFERENCES usuarios(id_usuario) ON DELETE SET NULL;

ALTER TABLE telemetria_tokens_ia
    ALTER COLUMN ejecucion_id DROP NOT NULL,
    ALTER COLUMN flujo_id DROP NOT NULL,
    ALTER COLUMN nodo_id DROP NOT NULL;

ALTER TABLE telemetria_tokens_ia
    DROP CONSTRAINT IF EXISTS chk_telemetria_origen_coherente;

ALTER TABLE telemetria_tokens_ia
    ADD CONSTRAINT chk_telemetria_origen_coherente CHECK (
        (origen_operacion = 'EJECUCION_FLUJO'
            AND ejecucion_id IS NOT NULL AND flujo_id IS NOT NULL AND nodo_id IS NOT NULL)
        OR (origen_operacion = 'PROMPT_OPTIMIZATION' AND usuario_id IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS idx_telemetria_tokens_origen_fecha
    ON telemetria_tokens_ia (origen_operacion, creado_en);

COMMIT;

-- Verificacion manual tras aplicar:
--   \d telemetria_tokens_ia
