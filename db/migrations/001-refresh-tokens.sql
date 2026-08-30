-- =============================================================================
-- Migracion 001 · Tabla de Refresh Tokens (PROT-06.4)
--
-- TypeORM corre con `synchronize: false` e `init.sql` solo se ejecuta cuando el
-- volumen `pgdata_protodo` esta vacio, asi que esta migracion se aplica a mano
-- sobre una base de datos ya poblada. Es idempotente (IF NOT EXISTS): volver a
-- ejecutarla no altera nada.
--
-- Aplicar con:
--   docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" \
--     < db/migrations/001-refresh-tokens.sql
-- =============================================================================

SET client_encoding = 'UTF8';

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id_refresh_token UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- ON DELETE CASCADE: si algun dia se purga fisicamente un usuario, sus
    -- credenciales de renovacion no pueden sobrevivirle.
    id_usuario       UUID NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,

    -- SHA-256 en hexadecimal del token opaco. El valor en claro JAMAS se
    -- persiste: quien lea esta tabla no obtiene credenciales utilizables.
    hash_token       CHAR(64) NOT NULL UNIQUE,

    expiracion       TIMESTAMP NOT NULL,

    -- Un refresh token solo puede canjearse una vez. Se marca en lugar de
    -- borrarse para poder detectar su reutilizacion (indicio de robo).
    revocado         BOOLEAN NOT NULL DEFAULT FALSE,

    fecha_creacion   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Soporta la revocacion en bloque de toda la familia de tokens de un usuario.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_id_usuario
    ON refresh_tokens(id_usuario);
