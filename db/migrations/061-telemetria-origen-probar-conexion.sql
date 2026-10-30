-- =============================================================================
-- Migracion 061 - Origen "probar conexion" en la telemetria de IA
--
-- QUE ANADE. El valor 'PROBAR_CONEXION' en `telemetria_tokens_ia.origen_operacion`,
-- con la misma forma que 'BANCO_PRUEBAS': sin ejecucion, flujo ni nodo, y con el
-- usuario que pulso el boton.
--
-- QUE PROBLEMA RESUELVE. El boton "Probar conexion" de los nodos de IA y OCR
-- lanza una inferencia real contra el proveedor, que se factura, y no dejaba
-- rastro en el informe de consumo. Una credencial rechazada tampoco quedaba
-- registrada, de modo que la tasa por modelo no veia esos fallos.
--
-- IDEMPOTENTE: el CHECK se elimina con IF EXISTS y se recrea.
--
-- Aplicar con:
--   cd backend && npm run db:migrate
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

ALTER TABLE telemetria_tokens_ia
    DROP CONSTRAINT IF EXISTS chk_telemetria_origen_coherente;

ALTER TABLE telemetria_tokens_ia
    ADD CONSTRAINT chk_telemetria_origen_coherente CHECK (
        (origen_operacion = 'EJECUCION_FLUJO'
            AND ejecucion_id IS NOT NULL AND flujo_id IS NOT NULL AND nodo_id IS NOT NULL)
        OR (origen_operacion IN ('PROMPT_OPTIMIZATION', 'BANCO_PRUEBAS', 'PROBAR_CONEXION')
            AND usuario_id IS NOT NULL)
    );

COMMIT;

-- Verificacion manual tras aplicar:
--   \d telemetria_tokens_ia
