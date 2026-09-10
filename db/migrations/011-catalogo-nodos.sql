-- =============================================================================
-- Migracion 011 · `nodos` pasa a ser catalogo estatico
--
-- El esquema arrastraba DOS representaciones de la misma topologia. La tabla
-- `nodos` (id_flujo, id_tipo_nodo, id_plantilla, orden_paso) describia la
-- secuencia de pasos de un flujo, que es exactamente lo que hoy vive en
-- `flujos.configuracion_pipeline` como JSONB. Mientras coexistan, nada impide
-- que se contradigan, y el motor FSM solo lee el JSONB: la tabla relacional
-- llevaba desde PROT-07 sin que ninguna ruta del backend la escribiera ni la
-- leyera.
--
-- Esta migracion se queda con una sola: el JSONB manda, y `nodos` se reconvierte
-- en el CATALOGO de tipos de nodo disponibles, que es lo que hoy es
-- `tipos_nodo`. No es una tabla de instancias renombrada: es la tabla de
-- catalogo ocupando el nombre que la de instancias dejo libre.
--
-- POR QUE EL RENOMBRADO Y NO DEJAR `tipos_nodo` COMO ESTABA: al desaparecer la
-- tabla de instancias, `tipos_nodo` deja de ser "los tipos de los nodos" para
-- ser, simplemente, "los nodos que el sistema sabe ejecutar". El nombre viejo
-- solo tenia sentido frente a una tabla de instancias que ya no existe.
--
-- CLAVE PRIMARIA DEL CATALOGO: pasa de `id_tipo_nodo` a `id_nodo`. Es el mismo
-- motivo que el renombrado de la tabla: la columna se llamaba asi por contraste
-- con una tabla de instancias que ya no esta.
--
-- `ui_schema` (jsonb): descriptor del formulario que el frontend debe pintar
-- para configurar los `params` de ese tipo de nodo. Nace con `'{}'` y NOT NULL
-- para que el consumidor nunca tenga que distinguir "sin descriptor" de "nulo";
-- un objeto vacio ya significa "este tipo no declara formulario todavia".
--
-- LOGS_NODO: su `id_nodo` apuntaba por clave ajena a la tabla de instancias, asi
-- que es el puntero relacional redundante que esta migracion existe para
-- eliminar. La tabla NO se borra —`ruta_archivo_log` es la traza que pide
-- architecture-patterns.md §4 para el volcado hibrido— sino que se realinea: la
-- columna conserva el nombre `id_nodo` pero cambia de tipo y de significado, y
-- pasa a guardar el `nodeId` del `configuracion_pipeline` como VARCHAR(50), que
-- es el limite que ya impone `PipelineNodeConfigDto.nodeId`.
--
-- IMPORTANTE: tras esta migracion `nodos.id_nodo` (UUID, PK del catalogo) y
-- `logs_nodo.id_nodo` (VARCHAR, el nodeId del JSONB) comparten nombre SIN ser
-- una clave ajena, que es justo la relacion que ese par de nombres tenia antes.
-- No se puede reponer: el nodeId de un pipeline es texto libre del JSONB y no
-- existe como fila del catalogo, asi que una FK rechazaria todos los inserts.
--
-- CONVENCION DE RESTRICCIONES: el nombre de la columna, sin prefijos
-- (`id_nodo`, no `pk_nodos`). La unica excepcion es la UNIQUE de `codigo`, que
-- se llama `nodos_codigo`: una UNIQUE crea un indice homonimo y los indices
-- comparten un unico espacio de nombres por esquema, asi que `codigo` a secas
-- bloquearia ese nombre para cualquier otra tabla con esa misma columna.
--
-- Nada en el backend leia estas tres tablas cuando se escribio la migracion (no
-- habia entidad TypeORM para ninguna, y `synchronize` esta en false). El
-- catalogo SI gana una entidad en esta entrega (`NodeCatalogEntry`), que nace ya
-- mapeada contra `id_nodo`.
--
-- ORDEN OBLIGATORIO: primero se suelta la columna con clave ajena de
-- `logs_nodo`, porque mientras exista PostgreSQL rechaza el DROP de `nodos`.
-- Solo despues se puede liberar el nombre para el renombrado.
--
-- Es idempotente: `IF EXISTS` / `IF NOT EXISTS` en todo, y los renombrados van
-- dentro de bloques `DO $$` que comprueban antes el estado, igual que la 009.
-- Cubre las tres bases posibles: sin migrar, con una pasada de la version
-- anterior de esta misma migracion (que dejaba `node_id` y `nodos_pkey`), y al
-- dia.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/011-catalogo-nodos.sql
-- =============================================================================

SET client_encoding = 'UTF8';

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. `logs_nodo` deja de depender de la tabla de instancias.
--
--    La columna conserva el nombre pero cambia de tipo: un `nodeId` del pipeline
--    es una cadena ("trigger_imap"), no un UUID. Conservar el UUID obligaria a
--    mantener viva una tabla de instancias solo para resolverlo, que es justo lo
--    contrario de lo que hace esta migracion.
--
--    El guard discrimina POR TIPO y no por existencia de la columna. Si mirase
--    solo el nombre, la segunda pasada borraria la columna que la primera acaba
--    de crear: `id_nodo` es a la vez el nombre viejo y el nuevo.
--
--    La conversion descarta el valor anterior (los UUID no son traducibles a
--    nodeId sin la tabla que se va a borrar). Se asume vacia: ninguna ruta del
--    backend escribe en `logs_nodo` a dia de hoy.
DO $$
BEGIN
    -- (a) Base sin migrar: `id_nodo` es todavia el UUID que apuntaba por clave
    --     ajena a la tabla de instancias. El DROP se lleva por delante esa clave
    --     ajena y el indice `idx_logs_nodo_id_nodo`, sin necesidad de nombrarlos.
    IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_name = 'logs_nodo'
           AND column_name = 'id_nodo'
           AND data_type = 'uuid'
    ) THEN
        ALTER TABLE logs_nodo DROP COLUMN id_nodo;
    END IF;

    -- (b) Base con una pasada previa de la version anterior de esta migracion:
    --     la columna ya guarda el nodeId del pipeline, pero con el nombre en
    --     ingles que aquella dejo. Solo hay que renombrarla.
    IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_name = 'logs_nodo' AND column_name = 'node_id'
    ) AND NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_name = 'logs_nodo' AND column_name = 'id_nodo'
    ) THEN
        ALTER TABLE logs_nodo RENAME COLUMN node_id TO id_nodo;
    END IF;
END $$;

--    Nullable a proposito, al contrario que el `id_nodo NOT NULL` que sustituye:
--    un fallo puede ocurrir antes de que el motor resuelva en que nodo estaba
--    (por ejemplo al cargar un esquema corrupto), y esa traza tambien hay que
--    poder escribirla.
ALTER TABLE logs_nodo
    ADD COLUMN IF NOT EXISTS id_nodo VARCHAR(50);

--    Soporta "dame todas las trazas de este nodo", que es la consulta con la que
--    se depura un paso concreto de un flujo.
--
--    El renombrado va en su propio bloque porque `ALTER INDEX ... RENAME TO`
--    falla si el destino ya existe; no admite `IF NOT EXISTS`.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_logs_nodo_node_id')
       AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_logs_nodo_id_nodo')
    THEN
        ALTER INDEX idx_logs_nodo_node_id RENAME TO idx_logs_nodo_id_nodo;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_logs_nodo_id_nodo
    ON logs_nodo(id_nodo);

-- 2. Fuera la tabla de instancias, con todas sus restricciones e indices.
--
--    El guard discrimina POR COLUMNA y no por existencia de la tabla, por la
--    misma razon que el paso 1 discrimina por tipo: `nodos` es a la vez el
--    nombre de la tabla que se borra y el de la que la sustituye. Un
--    `DROP TABLE IF EXISTS nodos` a secas se lleva por delante el CATALOGO —con
--    sus nueve filas— en cuanto la migracion se ejecuta por segunda vez.
--
--    `id_flujo` es el discriminante: solo la tabla de instancias la tiene. El
--    catalogo nunca ha sabido a que flujo pertenece un nodo, porque esa relacion
--    vive en el JSONB.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_name = 'nodos' AND column_name = 'id_flujo'
    ) THEN
        DROP TABLE nodos;
    END IF;
END $$;

-- 3. El catalogo ocupa el nombre libre y adopta la clave primaria definitiva.
--
--    El renombrado de la COLUMNA va antes que el de las restricciones: dejar una
--    constraint llamada `id_nodo` sobre una columna que todavia se llama
--    `id_tipo_nodo` es un estado a medias que confunde a quien lo inspeccione si
--    algo se interrumpe.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tipos_nodo')
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'nodos')
    THEN
        ALTER TABLE tipos_nodo RENAME TO nodos;
    END IF;

    -- Solo puede correr con `nodos` ya convertido en catalogo: la tabla de
    -- instancias tambien tenia una columna `id_tipo_nodo`, alli una clave ajena.
    IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_name = 'nodos' AND column_name = 'id_tipo_nodo'
    ) THEN
        ALTER TABLE nodos RENAME COLUMN id_tipo_nodo TO id_nodo;
    END IF;
END $$;

-- 4. Restricciones con el nombre canonico.
--
--    Se renombran A MANO. `ALTER TABLE ... RENAME TO` no arrastra los nombres
--    derivados de la tabla, asi que sin este paso una base migrada conservaria
--    `tipos_nodo_pkey` mientras un clonado nuevo desde `init.sql` tendria
--    `id_nodo`. Es la misma leccion que la migracion 009.
--
--    Cada guard acepta los DOS origenes posibles —el autoderivado original y el
--    que dejo la version anterior de esta migracion— y comprueba que el destino
--    no exista.
--    Los guards se acotan con `conrelid`: los nombres de restriccion son unicos
--    POR TABLA, no por esquema, asi que un `conname = 'id_ejecucion'` global
--    encontraria la de cualquier otra tabla y saltaria el renombrado que aqui
--    toca. `alertas_error` tiene precisamente una clave ajena homologa.
DO $$
DECLARE
    catalog_oid CONSTANT oid := 'nodos'::regclass;
    logs_oid    CONSTANT oid := 'logs_nodo'::regclass;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conrelid = catalog_oid AND conname = 'id_nodo'
    ) THEN
        IF EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conrelid = catalog_oid AND conname = 'tipos_nodo_pkey'
        ) THEN
            ALTER TABLE nodos RENAME CONSTRAINT tipos_nodo_pkey TO id_nodo;
        ELSIF EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conrelid = catalog_oid AND conname = 'nodos_pkey'
        ) THEN
            ALTER TABLE nodos RENAME CONSTRAINT nodos_pkey TO id_nodo;
        END IF;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conrelid = catalog_oid AND conname = 'nodos_codigo'
    ) THEN
        IF EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conrelid = catalog_oid AND conname = 'tipos_nodo_codigo_key'
        ) THEN
            ALTER TABLE nodos RENAME CONSTRAINT tipos_nodo_codigo_key TO nodos_codigo;
        ELSIF EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conrelid = catalog_oid AND conname = 'nodos_codigo_key'
        ) THEN
            ALTER TABLE nodos RENAME CONSTRAINT nodos_codigo_key TO nodos_codigo;
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conrelid = logs_oid AND conname = 'logs_nodo_pkey'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conrelid = logs_oid AND conname = 'id_log_nodo'
    ) THEN
        ALTER TABLE logs_nodo RENAME CONSTRAINT logs_nodo_pkey TO id_log_nodo;
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = logs_oid AND conname = 'logs_nodo_id_ejecucion_fkey'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conrelid = logs_oid AND conname = 'id_ejecucion'
    ) THEN
        ALTER TABLE logs_nodo RENAME CONSTRAINT logs_nodo_id_ejecucion_fkey TO id_ejecucion;
    END IF;
END $$;

-- 5. El descriptor de formulario del catalogo.
--
--    NOT NULL con default `'{}'`: un tipo sin formulario declarado es un objeto
--    vacio, no un nulo. Asi el frontend nunca tiene que distinguir los dos casos.
ALTER TABLE nodos
    ADD COLUMN IF NOT EXISTS ui_schema JSONB NOT NULL DEFAULT '{}';

-- =============================================================================
-- Comprobacion del resultado
-- =============================================================================

-- `nodos` debe ser ahora el catalogo: id_nodo, codigo, nombre, categoria,
-- descripcion y ui_schema. Si aparecen `id_flujo`, `id_tipo_nodo` u `orden_paso`,
-- el renombrado no ocurrio y lo que se esta viendo es la tabla de instancias.
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'nodos'
 ORDER BY ordinal_position;

-- Deben salir exactamente `id_nodo` (p) y `nodos_codigo` (u).
SELECT conname, contype
  FROM pg_constraint
 WHERE conrelid = 'nodos'::regclass
 ORDER BY conname;

-- `logs_nodo.id_nodo` debe ser `character varying`, NO `uuid`, y no debe quedar
-- ninguna columna `node_id`.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'logs_nodo'
 ORDER BY ordinal_position;

-- La unica clave ajena que le queda es `id_ejecucion` -> ejecuciones_flujo.
-- Si aparece alguna hacia `nodos`, el paso 1 no se aplico.
SELECT conname, contype, confrelid::regclass AS referencia
  FROM pg_constraint
 WHERE conrelid = 'logs_nodo'::regclass
 ORDER BY conname;

-- El catalogo conserva sus filas: el renombrado no toca los datos.
SELECT codigo, categoria FROM nodos ORDER BY codigo;
