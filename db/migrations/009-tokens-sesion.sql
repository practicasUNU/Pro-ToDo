-- =============================================================================
-- Migracion 009 · Renombrado de `refresh_tokens` a `tokens_sesion` (PROT-06.4)
--
-- Las nueve tablas del esquema usan nomenclatura castellana (`usuarios`,
-- `flujos`, `plantillas_html`, `ejecuciones_flujo`...) con PK del tipo
-- `id_<entidad>`. `refresh_tokens` era la unica excepcion: sus columnas si
-- seguian la convencion (`id_usuario`, `expiracion`, `revocado`,
-- `fecha_creacion`) pero el nombre de la tabla y de su clave primaria se
-- quedaron en ingles. Esta migracion cierra esa excepcion.
--
-- SE RENOMBRAN SEIS OBJETOS, NO DOS. `ALTER TABLE ... RENAME TO` no arrastra los
-- indices ni las constraints: se quedan con el nombre autogenerado a partir del
-- nombre VIEJO de la tabla. Como `init.sql` no las declara explicitamente,
-- PostgreSQL las deriva alli del nombre nuevo, de modo que un clonado nuevo
-- obtiene `tokens_sesion_pkey` mientras una base migrada conservaria
-- `refresh_tokens_pkey`. Renombrar solo tabla y columna dejaria las dos rutas de
-- creacion divergentes, que es justo la deriva que este repositorio evita
-- manteniendo el DDL duplicado a proposito en `init.sql` y en `db/migrations/`.
--
-- El nombre del indice ademas importa desde el codigo: la entidad lo declara con
-- `@Index('idx_tokens_sesion_id_usuario')`.
--
-- IDEMPOTENTE. `ALTER TABLE IF EXISTS ... RENAME TO` y `ALTER INDEX IF EXISTS`
-- lo son por si mismos, pero `RENAME COLUMN` y `RENAME CONSTRAINT` no admiten
-- `IF EXISTS` para su objeto: reejecutarlos a secas aborta con "column/constraint
-- does not exist". Por eso van dentro de un bloque `DO` con guardas contra los
-- catalogos. Reejecutar esta migracion completa no altera nada.
--
-- REQUISITO DE ARRANQUE: hasta aplicarla, cualquier login o renovacion de sesion
-- falla con `relation "tokens_sesion" does not exist`, porque la entidad
-- `RefreshToken` ya apunta al nombre nuevo.
--
-- ORDEN: se aplica DESPUES de la 001 y la 004. Ninguna de las dos debe
-- ejecutarse tras esta (ver la nota en sus cabeceras).
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/009-tokens-sesion.sql
-- =============================================================================

SET client_encoding = 'UTF8';

-- 1. La tabla. `IF EXISTS` cubre la reejecucion y tambien el clonado nuevo, que
--    ya nace con el nombre correcto desde `init.sql` y no tiene nada que
--    renombrar.
ALTER TABLE IF EXISTS refresh_tokens RENAME TO tokens_sesion;

-- 2. La clave primaria, el indice y las tres constraints.
DO $$
BEGIN
    -- Columna PK: id_refresh_token -> id_token_sesion.
    IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_name  = 'tokens_sesion'
           AND column_name = 'id_refresh_token'
    ) THEN
        ALTER TABLE tokens_sesion
            RENAME COLUMN id_refresh_token TO id_token_sesion;
    END IF;

    -- Constraint de clave primaria.
    IF EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'refresh_tokens_pkey'
    ) THEN
        ALTER TABLE tokens_sesion
            RENAME CONSTRAINT refresh_tokens_pkey TO tokens_sesion_pkey;
    END IF;

    -- Constraint UNIQUE de hash_token.
    IF EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'refresh_tokens_hash_token_key'
    ) THEN
        ALTER TABLE tokens_sesion
            RENAME CONSTRAINT refresh_tokens_hash_token_key
                           TO tokens_sesion_hash_token_key;
    END IF;

    -- Constraint de clave ajena hacia usuarios.
    IF EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'refresh_tokens_id_usuario_fkey'
    ) THEN
        ALTER TABLE tokens_sesion
            RENAME CONSTRAINT refresh_tokens_id_usuario_fkey
                           TO tokens_sesion_id_usuario_fkey;
    END IF;
END
$$;

-- 3. El indice que soporta la revocacion por usuario. Fuera del bloque `DO`
--    porque `ALTER INDEX` si acepta `IF EXISTS`.
ALTER INDEX IF EXISTS idx_refresh_tokens_id_usuario
    RENAME TO idx_tokens_sesion_id_usuario;

-- =============================================================================
-- Comprobacion del resultado
-- =============================================================================

-- Columnas: `id_token_sesion` debe salir en primera posicion y no debe quedar
-- ninguna `id_refresh_token`.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'tokens_sesion'
 ORDER BY ordinal_position;

-- Indices y constraints: los cinco nombres deben empezar por `tokens_sesion` /
-- `idx_tokens_sesion`. Cualquier `refresh_tokens_*` que sobreviva aqui es una
-- deriva respecto a lo que `init.sql` genera en un clonado nuevo.
SELECT indexname AS objeto, 'indice' AS tipo
  FROM pg_indexes
 WHERE tablename = 'tokens_sesion'
UNION ALL
SELECT conname AS objeto, 'constraint' AS tipo
  FROM pg_constraint
 WHERE conrelid = 'tokens_sesion'::regclass
 ORDER BY tipo, objeto;
