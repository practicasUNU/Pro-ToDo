-- =============================================================================
-- Migracion 006 · Checkpoint del motor FSM y mutex de ejecucion (PROT-08)
--
-- La entidad `FsmExecution` mapea `ejecuciones_flujo`, que ya existia pero le
-- faltaban tres piezas para sostener el motor:
--
--   1. El estado INACTIVO. El seed de `enum_estado` arrancaba en EN_PROCESO,
--      asi que no habia forma de representar una ejecucion creada pero aun no
--      iniciada — justo el estado en que nace una fila.
--   2. `retry_state`, donde se llevan los intentos consumidos por nodo para
--      contrastarlos con su RetryPolicy, y `fecha_actualizacion` para el
--      @UpdateDateColumn de la entidad.
--   3. `idx_flujo_activo`, el mutex.
--
-- SOBRE EL MUTEX: es un indice unico PARCIAL sobre `id_flujo` que solo aplica
-- mientras `estado = 'EN_PROCESO'`. Con el, la base de datos impide por si sola
-- que un flujo tenga dos ejecuciones vivas simultaneas, sin depender de un
-- bloqueo en memoria que se perderia al escalar a varios procesos. Los estados
-- terminales quedan fuera del indice, de modo que el historico de ejecuciones
-- de un flujo crece sin restriccion.
--
-- REQUISITO DE ARRANQUE: hasta aplicarla, el backend NO levanta. `FsmModule`
-- reconcilia estados en `onModuleInit` con un UPDATE, y @UpdateDateColumn anade
-- `fecha_actualizacion` al SET: sin la columna, el arranque falla con
-- `column "fecha_actualizacion" of relation "ejecuciones_flujo" does not exist`.
--
-- NO ENVOLVER EN BEGIN/COMMIT: PostgreSQL prohibe *usar* un valor de enum en la
-- misma transaccion en que se anade. psql en autocommit ejecuta cada sentencia
-- por separado y el paso 6 funciona; un BEGIN manual lo romperia.
--
-- Es idempotente: ADD VALUE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS y un UPDATE filtrado por IS NULL.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/006-fsm-execution-mutex.sql
-- =============================================================================

SET client_encoding = 'UTF8';

-- 1. Estado inicial del ciclo de vida. BEFORE lo coloca primero en el orden del
--    tipo, que es el orden natural de la maquina de estados y el que usara
--    cualquier ORDER BY estado.
ALTER TYPE enum_estado ADD VALUE IF NOT EXISTS 'INACTIVO' BEFORE 'EN_PROCESO';

-- 2. Intentos consumidos por nodo (clave: nodeId, valor: contador y metadatos).
ALTER TABLE ejecuciones_flujo
    ADD COLUMN IF NOT EXISTS retry_state JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 3. Marca de ultima escritura para el @UpdateDateColumn de la entidad.
ALTER TABLE ejecuciones_flujo
    ADD COLUMN IF NOT EXISTS fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 4. El contexto acumulado era nullable. Un checkpoint sin objeto obligaria a
--    todo consumidor a distinguir "sin datos" de "objeto vacio"; se normaliza a
--    '{}' y se impone NOT NULL. El filtro IS NULL hace repetible el paso.
UPDATE ejecuciones_flujo
   SET contexto_acumulado = '{}'::jsonb
 WHERE contexto_acumulado IS NULL;

ALTER TABLE ejecuciones_flujo
    ALTER COLUMN contexto_acumulado SET DEFAULT '{}'::jsonb;

ALTER TABLE ejecuciones_flujo
    ALTER COLUMN contexto_acumulado SET NOT NULL;

-- 5. El mutex (ver cabecera).
CREATE UNIQUE INDEX IF NOT EXISTS idx_flujo_activo
    ON ejecuciones_flujo (id_flujo)
 WHERE estado = 'EN_PROCESO';

-- 6. Una fila nace INACTIVO, no EN_PROCESO: insertar ya en marcha reservaria el
--    mutex antes de que el motor tomase el primer paso. Va al final porque USA
--    el valor anadido en el paso 1 (ver el aviso de la cabecera).
ALTER TABLE ejecuciones_flujo
    ALTER COLUMN estado SET DEFAULT 'INACTIVO';

-- Comprobacion del resultado
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'ejecuciones_flujo'
 ORDER BY ordinal_position;

SELECT indexname, indexdef
  FROM pg_indexes
 WHERE tablename = 'ejecuciones_flujo';
