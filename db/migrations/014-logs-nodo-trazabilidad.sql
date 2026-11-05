-- =============================================================================
-- Migracion 014 · Trazabilidad por nodo en `logs_nodo`
--
-- `logs_nodo` existe desde `init.sql` con sus indices y su clave ajena, pero
-- estaba huerfana: ninguna ruta del backend escribia en ella, tal como declara
-- la migracion 011 en su linea 88. PROT-18.1 la estrena, y para eso le faltan
-- cuatro columnas que el motor si conoce y la tabla no recogia.
--
-- POR QUE SE CONSERVA `enum_estado_nodo` (OK | ERROR | ADVERTENCIA) y no se
-- sustituye por los estados del motor: sus tres valores ya cubren el dominio
-- real —exito, fallo, y el LEVE que cierra sin pausar— y cambiar los valores de
-- un enum en PostgreSQL obliga a recrear el tipo y reescribir la columna
-- entera. Usarlo tal como se diseno no cuesta nada. El mapeo es:
--
--   result.success              -> OK
--   fallo LEVE                  -> ADVERTENCIA
--   fallo GRAVE/URGENTE         -> ERROR
--
-- ADVERTENCIA para el LEVE no es cosmetico: quien lea la traza tiene que poder
-- distinguir "fallo y hay que mirarlo" de "no pudo y volvera a intentarlo solo".
--
-- POR QUE `nivel_severidad` USA `enum_nivel_error`: ya existe y coincide 1:1 con
-- `NodeErrorSeverity` de TypeScript. Declarar un enum paralelo habria creado dos
-- listas que mantener de acuerdo. Es NULLABLE porque una ejecucion con exito no
-- tiene severidad, y rellenarla con un valor de relleno seria inventarse un
-- dato.
--
-- NO SE TOCAN `tiempo_ejecucion_ms` NI `codigo_respuesta_http`: ya estaban y son
-- justo lo que hace accionable una traza. La primera se puebla desde ya con la
-- duracion medida por el motor; la segunda queda reservada al nodo DESTINO_HTTP,
-- que todavia no tiene estrategia.
--
-- IDEMPOTENTE (`IF NOT EXISTS`): igual que el resto del directorio, debe poder
-- reaplicarse sobre una base que ya la tenga. Las bases creadas desde cero no la
-- necesitan —`init.sql` ya declara las columnas en su `CREATE TABLE`—; este
-- archivo es para los volumenes de Docker ya existentes.
-- =============================================================================

ALTER TABLE logs_nodo
    ADD COLUMN IF NOT EXISTS tipo_nodo       VARCHAR(50),
    ADD COLUMN IF NOT EXISTS nivel_severidad enum_nivel_error,
    ADD COLUMN IF NOT EXISTS codigo_error    VARCHAR(100),
    ADD COLUMN IF NOT EXISTS mensaje         TEXT;

COMMENT ON COLUMN logs_nodo.tipo_nodo IS
    'Valor de NodeType del nodo ejecutado (TRIGGER_IMAP, MAPEADOR_PLANTILLA...). VARCHAR y no enum: el catalogo de tipos vive en la tabla `nodos`.';

COMMENT ON COLUMN logs_nodo.nivel_severidad IS
    'Severidad del fallo, nula cuando el nodo termino con exito. Misma escala que NodeResult.error.level.';

COMMENT ON COLUMN logs_nodo.codigo_error IS
    'Codigo estable del fallo (ERR_IMAP_TIMEOUT...). Es lo que compara el catchErrors de onErrorStep, asi que se guarda aparte del mensaje.';

COMMENT ON COLUMN logs_nodo.mensaje IS
    'Descripcion legible del desenlace. Recoge el customMessage de la ruta de error cuando el nodo lo declara para ese codigo.';

-- -----------------------------------------------------------------------------
-- Verificacion
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'logs_nodo' AND column_name = 'nivel_severidad'
    ) THEN
        RAISE EXCEPTION 'Migracion 014 incompleta: falta logs_nodo.nivel_severidad';
    END IF;

    RAISE NOTICE 'Migracion 014 aplicada: logs_nodo lista para la trazabilidad por nodo.';
END $$;
