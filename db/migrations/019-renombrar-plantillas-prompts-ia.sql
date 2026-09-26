-- =============================================================================
-- Migracion 019 · `prompts_ia` pasa a ser `plantillas_prompts_ia`
--
-- POR QUE EL RENOMBRADO: lo que guarda esa tabla no es un prompt literal, es una
-- PLANTILLA con marcadores `{{nodo.campo}}` que el motor resuelve contra el
-- contexto en ejecucion. El nombre corto invitaba a leerla como un texto fijo, y
-- el dominio necesita distinguirla del prompt ya interpolado que acaba viajando
-- al modelo.
--
-- SE RENOMBRAN SEIS OBJETOS, NO DOS. `ALTER TABLE ... RENAME TO` no arrastra los
-- nombres derivados de la tabla, asi que sin este paso una base migrada
-- conservaria `prompts_ia_pkey` mientras un clonado nuevo desde `init.sql`
-- tendria `plantillas_prompts_ia_pkey`. Peor aun: un error de nombre duplicado
-- citaria una tabla que ya no existe, mandando a quien depure al sitio
-- equivocado. Misma leccion que las migraciones 009 y 011.
--
--   1. La tabla                  prompts_ia -> plantillas_prompts_ia
--   2. La columna PK             id_prompt  -> id_plantilla_prompt_ia
--   3. La restriccion PK         prompts_ia_pkey
--   4. El UNIQUE del nombre      prompts_ia_nombre_key
--   5. La clave ajena del autor  prompts_ia_id_usuario_creador_fkey
--   6. El indice del autor       idx_prompts_ia_id_usuario_creador
--
-- IDEMPOTENTE: `ALTER TABLE ... RENAME` no admite `IF EXISTS`, asi que cada paso
-- va dentro de un bloque `DO $$` que comprueba antes el estado del catalogo,
-- igual que la 011. Reaplicarla sobre una base ya migrada no hace nada.
--
-- La clave ajena NO se recrea: `ON DELETE RESTRICT` sobrevive al renombrado y
-- volver a declararla solo abriria la puerta a que alguien cambiara la regla sin
-- darse cuenta. El bloque de verificacion final comprueba que sigue siendo 'r'.
--
-- `init.sql` se actualiza en el mismo commit, pero alli van los nombres FINALES
-- y no este renombrado: ese archivo describe el estado objetivo y solo se
-- ejecuta con el volumen de Docker vacio.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/019-renombrar-plantillas-prompts-ia.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

-- 1 y 2. Tabla y columna.
--
--    La columna va DESPUES de la tabla y en el mismo bloque: dejar la tabla
--    renombrada con su PK vieja es un estado a medias, y hacerlo al reves
--    obligaria a nombrar la tabla vieja dos veces.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'prompts_ia')
       AND NOT EXISTS (
           SELECT 1 FROM information_schema.tables WHERE table_name = 'plantillas_prompts_ia'
       )
    THEN
        ALTER TABLE prompts_ia RENAME TO plantillas_prompts_ia;
    END IF;

    IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_name = 'plantillas_prompts_ia' AND column_name = 'id_prompt'
    ) THEN
        ALTER TABLE plantillas_prompts_ia RENAME COLUMN id_prompt TO id_plantilla_prompt_ia;
    END IF;
END $$;

-- 3, 4 y 5. Restricciones con el nombre canonico.
--
--    Los guards se acotan con `conrelid`: los nombres de restriccion son unicos
--    POR TABLA y no por esquema, asi que una busqueda global por `conname`
--    podria encontrar la de otra tabla y saltarse el renombrado que toca aqui.
DO $$
DECLARE
    prompts_oid CONSTANT oid := 'plantillas_prompts_ia'::regclass;
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conrelid = prompts_oid AND conname = 'prompts_ia_pkey'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = prompts_oid AND conname = 'plantillas_prompts_ia_pkey'
    ) THEN
        ALTER TABLE plantillas_prompts_ia
            RENAME CONSTRAINT prompts_ia_pkey TO plantillas_prompts_ia_pkey;
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = prompts_oid AND conname = 'prompts_ia_nombre_key'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = prompts_oid AND conname = 'plantillas_prompts_ia_nombre_key'
    ) THEN
        ALTER TABLE plantillas_prompts_ia
            RENAME CONSTRAINT prompts_ia_nombre_key TO plantillas_prompts_ia_nombre_key;
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = prompts_oid AND conname = 'prompts_ia_id_usuario_creador_fkey'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = prompts_oid
           AND conname = 'plantillas_prompts_ia_id_usuario_creador_fkey'
    ) THEN
        ALTER TABLE plantillas_prompts_ia
            RENAME CONSTRAINT prompts_ia_id_usuario_creador_fkey
                TO plantillas_prompts_ia_id_usuario_creador_fkey;
    END IF;
END $$;

-- 6. El indice del autor.
--
--    En su propio bloque porque `ALTER INDEX ... RENAME TO` tampoco admite
--    `IF EXISTS` y se consulta un catalogo distinto (`pg_indexes`).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'idx_prompts_ia_id_usuario_creador'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE indexname = 'idx_plantillas_prompts_ia_id_usuario_creador'
    ) THEN
        ALTER INDEX idx_prompts_ia_id_usuario_creador
            RENAME TO idx_plantillas_prompts_ia_id_usuario_creador;
    END IF;
END $$;

COMMIT;

-- =============================================================================
-- Comprobacion del resultado
-- =============================================================================

-- La PK debe salir como `id_plantilla_prompt_ia` y no debe quedar `id_prompt`.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'plantillas_prompts_ia'
 ORDER BY ordinal_position;

-- Las tres restricciones deben llevar ya el prefijo nuevo, y la ajena seguir en
-- RESTRICT (confdeltype = 'r'): los prompts son patrimonio del equipo y dar de
-- baja a su autor no puede borrarlos.
SELECT conname, contype, confdeltype
  FROM pg_constraint
 WHERE conrelid = 'plantillas_prompts_ia'::regclass
 ORDER BY contype;

SELECT indexname
  FROM pg_indexes
 WHERE tablename = 'plantillas_prompts_ia';
