-- =============================================================================
-- Migracion 007 · Lista blanca dinamica de IPs (PROT-05)
--
-- Reemplaza la fuente estatica `ALLOWED_IP_RANGES` (leida solo como fallback de
-- arranque cuando esta tabla esta vacia) por una tabla administrable en caliente
-- desde el modulo ADMIN. TypeORM corre con `synchronize: false` e `init.sql`
-- solo se ejecuta cuando el volumen `pgdata_protodo` esta vacio, asi que esta
-- migracion se aplica a mano sobre una base de datos ya poblada. Es idempotente
-- (IF NOT EXISTS): volver a ejecutarla no altera nada.
--
-- Aplicar con:
--   docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" \
--     < db/migrations/007-allowed-ips.sql
-- =============================================================================

SET client_encoding = 'UTF8';

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS allowed_ips (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- IPv4/IPv6 exacta o notacion CIDR (ej. "192.168.1.0/24"). Unica: la
    -- deduplicacion es responsabilidad de la base, no solo del DTO.
    ip_o_cidr       VARCHAR(64) NOT NULL UNIQUE,

    descripcion     VARCHAR(255) NOT NULL,

    creado_en       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Comprobacion del resultado
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'allowed_ips'
 ORDER BY ordinal_position;
