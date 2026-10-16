-- =============================================================================
-- Migracion 040 - Estado triestatal del flujo (`flujos.activo` -> `flujos.status`)
--
-- QUE PROBLEMA RESUELVE. `flujos.activo` es un booleano que responde a una sola
-- pregunta: "se puede disparar este flujo". Desde CU-09 hay un tercer caso que
-- ese tipo no puede expresar: el flujo tiene una ejecucion DETENIDA esperando un
-- reintento manual. Hasta ahora eso se representaba desactivandolo -un
-- `activo = FALSE` indistinguible de la retirada deliberada de un operador- o no
-- representandolo en absoluto, con el flujo marcado activo mientras su sondeo
-- seguia creando ejecuciones nuevas por encima de la que estaba atascada.
--
-- La interfaz ya pintaba tres estados: `WorkflowsManager.vue` ramifica sobre el
-- estado de la ejecucion viva ANTES de mirar `activo`, cruzando dos fuentes de
-- verdad. Esta columna convierte esa inferencia del cliente en un hecho de la
-- fila.
--
-- POR QUE UN ENUM Y NO DOS BOOLEANOS. `activo` + `pausado` admite la combinacion
-- `(FALSE, TRUE)` -un flujo retirado y pausado a la vez- que no significa nada, y
-- obligaria a cada consulta a comprobar las dos columnas en el orden correcto.
-- Los tres valores son MUTUAMENTE EXCLUYENTES por definicion: un flujo dispara,
-- no dispara porque alguien lo retiro, o no dispara porque algo se rompio. El
-- tipo lo hace imposible de violar.
--
-- POR QUE NO SE REUTILIZA `enum_estado`. Ese tipo describe el ciclo de vida de
-- una EJECUCION (`ejecuciones_flujo.estado`) y tiene siete valores, cinco de
-- ellos terminales. Un flujo no es EXITOSO ni DESCARTADO: es una plantilla de
-- trabajo que acumula ejecuciones. Compartir el tipo invitaria a escribir
-- `EXITOSO` en `flujos` el dia que alguien copie una consulta, y la frontera
-- entre plantilla y ciclo de vida -documentada en `workflow.entity.ts`- se
-- borraria en el esquema antes que en el codigo.
--
-- `PAUSADO` lo escribe SOLO EL MOTOR, desde `FsmEngineService.pauseAt` a traves
-- de `WorkflowStatusCoordinator`. La API de edicion acepta unicamente ACTIVO e
-- INACTIVO: un PAUSADO puesto a mano describe una ejecucion detenida que no
-- existe, y nada podria sacarlo de ahi, porque las dos salidas de PAUSADO
-- -reanudar y descartar- parten precisamente de esa ejecucion.
--
-- DEFAULT 'INACTIVO' y no 'ACTIVO'. Es la misma decision de seguridad que ya
-- toma `WorkflowsService.createWorkflow`: un flujo recien creado que se armase
-- solo empezaria a consumir el buzon corporativo sin que nadie hubiera revisado
-- su configuracion. Notese que invierte el `DEFAULT TRUE` que `init.sql` le daba
-- a `activo`, que era justo lo contrario y quedaba desmentido por el codigo.
--
-- POR QUE ESTA SI VA EN UN BLOQUE TRANSACCIONAL, a diferencia de las 030 y 039.
-- Aquellas usaban `ALTER TYPE ... ADD VALUE` sobre un tipo PREEXISTENTE, y
-- PostgreSQL prohibe usar ese valor en la misma transaccion (error 55P04). Aqui
-- el tipo NACE en esta migracion: `CREATE TYPE`, `ALTER TABLE` y el `UPDATE` de
-- respaldo pueden ir juntos y DEBEN ir juntos, porque un fallo a mitad dejaria
-- la tabla con las dos columnas y los datos solo en una.
--
-- IDEMPOTENCIA. Las cuatro operaciones se pueden reaplicar: el tipo se crea
-- condicionado a `pg_type`, la columna con `ADD COLUMN IF NOT EXISTS`, el
-- respaldo solo si `activo` aun existe -el cuerpo de un `DO` solo se planifica
-- cuando su rama se ejecuta, asi que la referencia a una columna ya borrada no
-- rompe nada- y el borrado con `DROP COLUMN IF EXISTS`.
--
-- SIN INDICE NUEVO. Los dos disparadores consultan `WHERE status = 'ACTIVO'` una
-- vez por ciclo de reconciliacion sobre una tabla de unas pocas decenas de
-- filas: un indice costaria mas mantenimiento del que ahorraria en lecturas, y
-- el planificador seguiria eligiendo el seq scan.
--
-- ORDEN DE DESPLIEGUE OBLIGATORIO: aplicar esta migracion ANTES de desplegar el
-- backend. Con `synchronize: false`, en cuanto la entidad declare `status` toda
-- lectura de `flujos` muere con `column Workflow.status does not exist`. Y al
-- reves si se aplica con el codigo viejo desplegado, porque el paso 4 borra
-- `activo`. No hay ventana en la que ambos funcionen.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/040-estado-flujo-triestatal.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. El tipo. `CREATE TYPE` no admite `IF NOT EXISTS`, de ahi el bloque.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'workflow_status_enum'
    ) THEN
        CREATE TYPE workflow_status_enum AS ENUM ('ACTIVO', 'INACTIVO', 'PAUSADO');
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 2. La columna. NOT NULL con DEFAULT es metadato puro desde PostgreSQL 11: no
--    reescribe la tabla ni toma un bloqueo largo.
-- -----------------------------------------------------------------------------
ALTER TABLE flujos
    ADD COLUMN IF NOT EXISTS status workflow_status_enum NOT NULL DEFAULT 'INACTIVO';

-- -----------------------------------------------------------------------------
-- 3. Respaldo de los datos existentes. TRUE -> ACTIVO, FALSE -> INACTIVO.
--
--    `activo` es nullable en el esquema original (`BOOLEAN DEFAULT TRUE`, sin
--    NOT NULL), asi que una fila escrita por SQL directo puede tener NULL. Se
--    trata como INACTIVO: ante la duda, un flujo no dispara. Por eso el CASE
--    comprueba `IS TRUE` y no `activo` a secas.
--
--    Ninguna fila nace PAUSADO: ese valor describe una ejecucion detenida AHORA,
--    y deducirlo del historico marcaria como pausados flujos cuya incidencia se
--    cerro hace meses.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'flujos' AND column_name = 'activo'
    ) THEN
        UPDATE flujos
           SET status = CASE
                            WHEN activo IS TRUE THEN 'ACTIVO'::workflow_status_enum
                            ELSE 'INACTIVO'::workflow_status_enum
                        END;
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 4. Retirada de la columna vieja.
--
--    Se BORRA y no se deja vacia por el mismo motivo que la 020 dio para
--    `nodos.ui_schema`: una columna que dice gobernar el disparo y ya no lo hace
--    acaba siendo consultada por alguien, y a partir de ahi el estado de un flujo
--    se define en dos sitios que divergen en la primera edicion.
--
--    La entidad TypeORM deja de mapearla en el MISMO commit: con
--    `synchronize: false` el esquema no se corrige solo, y un desfase aqui se
--    convierte en una mentira en el codigo.
-- -----------------------------------------------------------------------------
ALTER TABLE flujos
    DROP COLUMN IF EXISTS activo;

COMMIT;

-- =============================================================================
-- Comprobacion del resultado
-- =============================================================================

-- Los tres valores del tipo, en su orden de declaracion.
SELECT enumlabel AS estado,
       enumsortorder AS orden
  FROM pg_enum
 WHERE enumtypid = 'workflow_status_enum'::regtype
 ORDER BY enumsortorder;

-- `status` debe aparecer como USER-DEFINED / NOT NULL, y `activo` NO debe estar.
SELECT column_name,
       data_type,
       udt_name,
       is_nullable,
       column_default
  FROM information_schema.columns
 WHERE table_name = 'flujos'
 ORDER BY ordinal_position;

-- Cero filas confirma que la columna vieja ya no existe.
SELECT column_name
  FROM information_schema.columns
 WHERE table_name = 'flujos'
   AND column_name = 'activo';

-- Reparto del respaldo. La suma debe coincidir con el total de flujos, y
-- PAUSADO debe ser 0: ninguna fila nace pausada.
SELECT status,
       COUNT(*) AS flujos
  FROM flujos
 GROUP BY status
 ORDER BY status;
