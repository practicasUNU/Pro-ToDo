-- =============================================================================
-- Migracion 016 · Alertas anteriores a la ejecucion (`alertas_error.id_flujo`)
--
-- La 015 dejo `alertas_error` colgando de `logs_nodo`, que es correcto para todo
-- fallo OCURRIDO DENTRO de un nodo. Pero el sondeo IMAP puede fallar ANTES de
-- que exista ejecucion alguna: si `client.connect()` no responde, el worker ni
-- siquiera llega a despachar el flujo, asi que no hay `id_ejecucion` que
-- referenciar y hasta hoy esa averia solo quedaba en la consola.
--
-- Es el fallo mas grave que puede tener un disparador y el unico que nadie ve:
-- el flujo simplemente no arranca, en silencio.
--
-- POR QUE `id_ejecucion` PASA A ADMITIR NULL: no es una relajacion por comodidad
-- sino el reconocimiento de que existen dos origenes legitimos de alerta. Uno
-- nace dentro de una ejecucion y otro nace porque la ejecucion NO llego a
-- nacer. Obligar al segundo a inventarse una clave ajena seria falsear el dato.
--
-- POR QUE UN CHECK Y NO SOLO DOS COLUMNAS NULLABLES: una alerta sin ejecucion NI
-- flujo es inatribuible —el operador leeria "algo fallo" sin saber donde—, y esa
-- fila no se puede escribir por accidente si la base lo impide. El CHECK es la
-- unica garantia que sobrevive a cualquier llamante futuro.
--
-- POR QUE `ON DELETE CASCADE` HACIA `flujos`: mismo criterio que la clave ajena
-- a `ejecuciones_flujo` que ya tenia la tabla. Borrar un flujo se lleva sus
-- alertas; conservarlas huerfanas solo dejaria avisos que ya no se pueden
-- atender porque el flujo al que apuntan no existe.
--
-- IDEMPOTENTE: reaplicable sobre una base que ya la tenga. Las bases creadas
-- desde cero no la necesitan —`init.sql` ya declara el resultado final—; este
-- archivo es para los volumenes de Docker ya existentes.
-- =============================================================================

ALTER TABLE alertas_error
    ADD COLUMN IF NOT EXISTS id_flujo UUID;

ALTER TABLE alertas_error
    ALTER COLUMN id_ejecucion DROP NOT NULL;

-- -----------------------------------------------------------------------------
-- Clave ajena hacia `flujos` y regla de atribucion
--
-- Nombradas a mano, no derivadas: `init.sql` las declara con estos mismos
-- nombres, y nombrarlas en un sitio y derivarlas en el otro es como diverge una
-- base clonada de una migrada (la leccion de la migracion 009).
--
-- Los guards se acotan por `conrelid` porque los nombres de restriccion son
-- unicos POR TABLA y no por esquema; la 011 ya avisa de esto senalando
-- justamente a `alertas_error`.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    alerts_oid CONSTANT oid := 'alertas_error'::regclass;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = alerts_oid AND conname = 'fk_alertas_error_flujo'
    ) THEN
        ALTER TABLE alertas_error
            ADD CONSTRAINT fk_alertas_error_flujo FOREIGN KEY (id_flujo)
                REFERENCES flujos(id_flujo) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = alerts_oid AND conname = 'chk_alertas_error_origen'
    ) THEN
        ALTER TABLE alertas_error
            ADD CONSTRAINT chk_alertas_error_origen
                CHECK (id_ejecucion IS NOT NULL OR id_flujo IS NOT NULL);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_alertas_error_id_flujo
    ON alertas_error (id_flujo);

COMMENT ON COLUMN alertas_error.id_flujo IS
    'Flujo afectado cuando el fallo ocurre FUERA de una ejecucion (worker de sondeo). Nulo en las alertas nacidas dentro de un nodo, que ya se atribuyen por id_ejecucion.';

COMMENT ON COLUMN alertas_error.id_ejecucion IS
    'Ejecucion en la que se produjo el fallo. Nula cuando la averia impidio que la ejecucion llegara a crearse; en ese caso id_flujo es obligatorio (chk_alertas_error_origen).';

-- -----------------------------------------------------------------------------
-- Verificacion
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    alerts_oid CONSTANT oid := 'alertas_error'::regclass;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'alertas_error' AND column_name = 'id_flujo'
    ) THEN
        RAISE EXCEPTION 'Migracion 016 incompleta: falta alertas_error.id_flujo';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'alertas_error' AND column_name = 'id_ejecucion'
           AND is_nullable = 'YES'
    ) THEN
        RAISE EXCEPTION 'Migracion 016 incompleta: alertas_error.id_ejecucion sigue siendo NOT NULL';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = alerts_oid AND conname = 'chk_alertas_error_origen'
    ) THEN
        RAISE EXCEPTION 'Migracion 016 incompleta: falta chk_alertas_error_origen';
    END IF;

    RAISE NOTICE 'Migracion 016 aplicada: alertas_error admite fallos anteriores a la ejecucion.';
END $$;
