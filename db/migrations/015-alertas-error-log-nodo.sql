-- =============================================================================
-- Migracion 015 · `alertas_error` normalizada y vinculada a `logs_nodo`
--
-- `alertas_error` lleva desde `init.sql` con su clave ajena y su indice, y
-- huerfana: ninguna ruta del backend escribia en ella. Es el mismo estado en el
-- que estaba `logs_nodo` antes de la migracion 014, y se estrena por la misma
-- via —`HybridLoggerService`—, de modo que un fallo GRAVE o URGENTE deje algo
-- que un operador pueda listar y marcar como resuelto.
--
-- POR QUE SE ELIMINA `modulo_origen`: nunca se escribio, y su significado era
-- ambiguo desde el principio —¿el modulo de NestJS, la estrategia, el nodo del
-- esquema?—. Lo que realmente identifica el origen de una alerta es la fila de
-- `logs_nodo` que la provoco, que ya lleva `id_nodo`, `tipo_nodo` y
-- `codigo_error`. Una clave ajena dice lo que una cadena libre solo insinuaba.
--
-- POR QUE `id_log_nodo` ES NULLABLE: si la escritura en `logs_nodo` falla, la
-- alerta se registra igual y sin vinculo. Perder el aviso de un fallo URGENTE
-- porque no se pudo anotar la traza seria el peor canje posible, y es
-- precisamente cuando algo va mal cuando la alerta mas importa.
--
-- POR QUE `ON DELETE SET NULL` Y NO CASCADE: borrar una ejecucion ya se lleva la
-- alerta por su propia clave ajena a `ejecuciones_flujo`, que si es CASCADE. La
-- diferencia aparece el dia que se pode `logs_nodo` por retencion: con CASCADE
-- desapareceria de paso cualquier alerta sin resolver que le apuntara.
--
-- POR QUE `resuelto` PASA A NOT NULL: es el filtro de la bandeja de alertas, y
-- un tercer valor (NULL) no significaria nada que FALSE no diga ya. La tabla
-- esta vacia, asi que el ALTER no tiene que rellenar nada.
--
-- POR QUE EL INDICE SOBRE `resuelto` ES PARCIAL: es un booleano de dos valores;
-- un indice plano sobre el no lo usaria el planificador. La consulta real es
-- "las pendientes, las mas recientes primero", y eso es lo que se indexa.
--
-- IDEMPOTENTE: igual que el resto del directorio, debe poder reaplicarse sobre
-- una base que ya la tenga. Las bases creadas desde cero no la necesitan
-- —`init.sql` ya declara el resultado final—; este archivo es para los
-- volumenes de Docker ya existentes.
-- =============================================================================

ALTER TABLE alertas_error DROP COLUMN IF EXISTS modulo_origen;

ALTER TABLE alertas_error
    ADD COLUMN IF NOT EXISTS id_log_nodo UUID;

ALTER TABLE alertas_error
    ALTER COLUMN resuelto SET DEFAULT FALSE;

UPDATE alertas_error SET resuelto = FALSE WHERE resuelto IS NULL;

ALTER TABLE alertas_error
    ALTER COLUMN resuelto SET NOT NULL;

-- -----------------------------------------------------------------------------
-- Clave ajena hacia `logs_nodo`
--
-- Nombrada a mano y no derivada por PostgreSQL: `init.sql` la declara con este
-- mismo nombre, y nombrarla en un sitio y derivarla en el otro es exactamente
-- como diverge una base clonada de una migrada (la leccion de la migracion 009).
--
-- `ADD CONSTRAINT` no admite `IF NOT EXISTS`, de ahi el guard. Acotado por
-- `conrelid` porque los nombres de restriccion son unicos POR TABLA y no por
-- esquema: un `conname` global encontraria el de cualquier otra tabla. La 011 ya
-- avisa de esto senalando justamente a `alertas_error`.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    alerts_oid CONSTANT oid := 'alertas_error'::regclass;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = alerts_oid AND conname = 'fk_alertas_error_log_nodo'
    ) THEN
        ALTER TABLE alertas_error
            ADD CONSTRAINT fk_alertas_error_log_nodo FOREIGN KEY (id_log_nodo)
                REFERENCES logs_nodo(id_log_nodo) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_alertas_error_id_log_nodo
    ON alertas_error (id_log_nodo);

CREATE INDEX IF NOT EXISTS idx_alertas_error_pendientes
    ON alertas_error (fecha_creacion DESC)
 WHERE resuelto = FALSE;

COMMENT ON COLUMN alertas_error.id_log_nodo IS
    'Traza de logs_nodo que origino la alerta. Nula si la escritura de esa traza fallo: la alerta se registra igual, huerfana.';

COMMENT ON COLUMN alertas_error.nivel IS
    'Severidad del fallo. Solo GRAVE y URGENTE llegan aqui; el LEVE cierra sin pausar y se queda en logs_nodo como ADVERTENCIA.';

COMMENT ON COLUMN alertas_error.resuelto IS
    'Marca de atendida. Es el filtro de la bandeja, de ahi el indice parcial idx_alertas_error_pendientes.';

-- -----------------------------------------------------------------------------
-- Verificacion
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    alerts_oid CONSTANT oid := 'alertas_error'::regclass;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'alertas_error' AND column_name = 'modulo_origen'
    ) THEN
        RAISE EXCEPTION 'Migracion 015 incompleta: alertas_error.modulo_origen sigue presente';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'alertas_error' AND column_name = 'id_log_nodo'
    ) THEN
        RAISE EXCEPTION 'Migracion 015 incompleta: falta alertas_error.id_log_nodo';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = alerts_oid AND conname = 'fk_alertas_error_log_nodo'
    ) THEN
        RAISE EXCEPTION 'Migracion 015 incompleta: falta la clave ajena fk_alertas_error_log_nodo';
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'alertas_error' AND column_name = 'resuelto'
           AND is_nullable = 'YES'
    ) THEN
        RAISE EXCEPTION 'Migracion 015 incompleta: alertas_error.resuelto sigue admitiendo NULL';
    END IF;

    RAISE NOTICE 'Migracion 015 aplicada: alertas_error vinculada a logs_nodo.';
END $$;
