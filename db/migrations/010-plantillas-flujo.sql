-- =============================================================================
-- Migracion 010 · Plantillas de flujo (blueprints maestros)
--
-- Hasta ahora un flujo maestro y una instancia operativa eran la MISMA fila de
-- `flujos`: la Fase 0 del asistente listaba los flujos que ya tenian esquema y
-- clonaba su topologia. Eso tenia dos consecuencias malas: editar el flujo del
-- que otros partieron cambiaba la plantilla de facto, y no habia forma de tener
-- un maestro que no se pudiera disparar.
--
-- `plantillas_flujo` separa las dos cosas. Es el catalogo de topologias base
-- (ej. TRIGGER_IMAP -> MAPEADOR_PLANTILLA) y no se ejecuta nunca: no tiene
-- estado, ni autor, ni ejecuciones. `flujos.id_plantilla_origen` registra de que
-- maestro nacio cada instancia.
--
-- La columna JSONB se llama `configuracion_pipeline`, igual que en `flujos`: es
-- el mismo concepto y compartir el nombre es lo que hace legible el clonado
-- (copiar `plantillas_flujo.configuracion_pipeline` en
-- `flujos.configuracion_pipeline`). A diferencia de `flujos`, aqui es NOT NULL:
-- una plantilla sin topologia no es una plantilla.
--
-- `nombre VARCHAR(100)` y no 120 como `plantillas_html`: el nombre del blueprint
-- se propone como nombre del flujo que lo instancia, y `flujos.nombre` es
-- VARCHAR(100). Con 120 un nombre valido de plantilla no cabria en su flujo.
--
-- BORRADO LOGICO (`activo`), igual que `plantillas_html`: hay flujos que nacieron
-- de un blueprint y su trazabilidad depende de que la fila siga existiendo. El
-- `ON DELETE SET NULL` de la clave ajena es la red de seguridad para un borrado
-- fisico por SQL directo, no la via prevista.
--
-- Es idempotente. El `REFERENCES` va inline en el `ADD COLUMN IF NOT EXISTS`:
-- PostgreSQL solo lo evalua si la columna se crea, asi que reejecutar la
-- migracion no intenta duplicar la constraint.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/010-plantillas-flujo.sql
-- =============================================================================

SET client_encoding = 'UTF8';

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. El catalogo de blueprints.
CREATE TABLE IF NOT EXISTS plantillas_flujo (
    id_plantilla_flujo     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- UNIQUE: el nombre es el identificador que el operador reconoce en el
    -- selector del asistente. Dos maestros homonimos son indistinguibles ahi.
    nombre                 VARCHAR(100) NOT NULL UNIQUE,

    -- TEXT y no VARCHAR(255): la descripcion de un maestro documenta la
    -- topologia entera y el limite corto estorba. El DTO la acota a 1000.
    descripcion            TEXT,

    -- Borrado logico. Una plantilla retirada desaparece del selector pero sigue
    -- explicando de donde salieron los flujos que la instanciaron.
    activo                 BOOLEAN NOT NULL DEFAULT TRUE,

    -- Mismo nombre que en `flujos`: es el mismo grafo declarativo.
    configuracion_pipeline JSONB NOT NULL,

    fecha_creacion         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. El vinculo instancia -> maestro.
--
-- Nullable a proposito: los flujos que ya existen no nacieron de ninguna
-- plantilla, y el asistente debe seguir pudiendo crear uno desde cero.
ALTER TABLE flujos
    ADD COLUMN IF NOT EXISTS id_plantilla_origen UUID
        REFERENCES plantillas_flujo(id_plantilla_flujo) ON DELETE SET NULL;

-- 3. Soporta la consulta "que flujos salieron de esta plantilla", que es la que
--    hay que responder antes de retirar un maestro.
CREATE INDEX IF NOT EXISTS idx_flujos_id_plantilla_origen
    ON flujos(id_plantilla_origen);

-- =============================================================================
-- Comprobacion del resultado
-- =============================================================================

SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'plantillas_flujo'
 ORDER BY ordinal_position;

-- La columna nueva de `flujos` debe salir nullable y con su clave ajena.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'flujos'
   AND column_name = 'id_plantilla_origen';

SELECT conname, confdeltype
  FROM pg_constraint
 WHERE conrelid = 'flujos'::regclass
   AND contype = 'f';
