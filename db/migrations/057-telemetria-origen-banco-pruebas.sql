-- =============================================================================
-- Migracion 057 - Origen "banco de pruebas" en la telemetria de IA
--
-- QUE ANADE. El valor 'BANCO_PRUEBAS' en `telemetria_tokens_ia.origen_operacion`,
-- con la misma forma que 'PROMPT_OPTIMIZATION': sin ejecucion, flujo ni nodo, y
-- con el usuario que lanzo la prueba.
--
-- QUE PROBLEMA RESUELVE. El banco de pruebas ejecuta un nodo PROCESADOR_IA o
-- PROCESADOR_OCR AISLADO, con una inferencia real que cuesta dinero, pero sin
-- fila en `ejecuciones_flujo`. Con el CHECK de la 049 su consumo no se podia
-- registrar como "ejecucion" (exige ejecucion, flujo y nodo), y el nodo fallaba
-- con ERR_TELEMETRY_PERSIST_FAILED despues de haber pagado la inferencia.
--
-- IDEMPOTENTE: el CHECK se elimina con IF EXISTS y se recrea.
--
-- Aplicar con:
--   cd backend && npm run db:migrate
-- o directamente:
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' < db/migrations/057-telemetria-origen-banco-pruebas.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

ALTER TABLE telemetria_tokens_ia
    DROP CONSTRAINT IF EXISTS chk_telemetria_origen_coherente;

ALTER TABLE telemetria_tokens_ia
    ADD CONSTRAINT chk_telemetria_origen_coherente CHECK (
        (origen_operacion = 'EJECUCION_FLUJO'
            AND ejecucion_id IS NOT NULL AND flujo_id IS NOT NULL AND nodo_id IS NOT NULL)
        OR (origen_operacion IN ('PROMPT_OPTIMIZATION', 'BANCO_PRUEBAS') AND usuario_id IS NOT NULL)
    );

COMMIT;

-- Verificacion manual tras aplicar:
--   \d telemetria_tokens_ia
