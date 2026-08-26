-- =============================================================================
-- Migracion 003 · Secreto TOTP por usuario (PROT-04.1)
--
-- Sustituye la derivacion determinista del secreto
-- (base32(HMAC-SHA256(OTP_SECRET, correo))) por un secreto aleatorio persistido
-- por cuenta. El motivo es poder rotar o revocar la inscripcion de UN usuario sin
-- invalidar los codigos de todos los demas, que es lo que ocurria al depender de
-- una unica semilla maestra.
--
-- Contrapartida asumida: el secreto pasa a vivir en la base de datos, asi que un
-- volcado basta para forjar codigos. Con la derivacion hacia falta ademas conocer
-- OTP_SECRET. Se mitiga con `select: false` + @Exclude() en la entidad para que
-- nunca salga en una respuesta HTTP, pero no frente a un lector de la tabla.
--
-- Tambien retira `codigo_otp` y `expiracion_otp`: son de un diseño anterior de
-- codigos persistidos que ningun codigo lee. TOTP no almacena el codigo, solo el
-- secreto del que se deriva.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/003-otp-secret.sql
-- =============================================================================

SET client_encoding = 'UTF8';

-- Nullable a proposito: la inscripcion es perezosa. Las cuentas existentes reciben
-- su secreto la primera vez que piden un codigo, sin migracion de datos.
ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS secreto_otp VARCHAR(64);

ALTER TABLE usuarios
    DROP COLUMN IF EXISTS codigo_otp,
    DROP COLUMN IF EXISTS expiracion_otp;

-- Comprobacion del resultado
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'usuarios'
 ORDER BY ordinal_position;
