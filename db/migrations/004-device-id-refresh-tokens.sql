-- =============================================================================
-- Migracion 004 · Revocacion de sesiones aislada por dispositivo (PROT-06.4)
--
-- Añade `id_dispositivo` a `refresh_tokens`. El cliente genera un UUID por
-- navegador (lo persiste en `proto-do:device-id`) y lo envia al validar el OTP;
-- con esa columna, emitir un token revoca la sesion anterior de ESE dispositivo y
-- deja intactas las de los demas equipos del usuario. Antes no habia forma de
-- distinguirlas: revocar era todo o nada.
--
-- Las filas heredadas no tienen dispositivo conocido y no se les puede inventar
-- uno sin mentir sobre su origen, asi que se descartan. Coste asumido: quien
-- tuviera una sesion abierta al aplicar esto vuelve a entrar por OTP.
--
-- Es idempotente, pero el paso 2 merece una lectura atenta: el filtro
-- `IS NULL` es lo que la hace repetible. Tras el paso 3 ninguna fila puede volver
-- a cumplirlo, asi que reejecutar la migracion no borra sesiones validas. Un
-- `DELETE FROM refresh_tokens` a secas si lo haria.
--
-- REQUISITO DE ARRANQUE: hasta aplicarla, cualquier login falla con
-- `column RefreshToken.id_dispositivo does not exist`.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/004-device-id-refresh-tokens.sql
-- =============================================================================

SET client_encoding = 'UTF8';

-- 1. Nullable de entrada: no se puede imponer NOT NULL con filas sin rellenar.
ALTER TABLE refresh_tokens
    ADD COLUMN IF NOT EXISTS id_dispositivo UUID;

-- 2. Descarte de las sesiones heredadas (ver cabecera).
DELETE FROM refresh_tokens WHERE id_dispositivo IS NULL;

-- 3. Ya sin filas pendientes, la columna pasa a obligatoria.
ALTER TABLE refresh_tokens
    ALTER COLUMN id_dispositivo SET NOT NULL;

-- No se añade indice: el filtro de revocacion es
-- (id_usuario, id_dispositivo, revocado) y `idx_refresh_tokens_id_usuario` ya
-- cubre el prefijo. Con `sesiones_vivas + 5` filas por usuario no hay nada que
-- optimizar.

-- Comprobacion del resultado
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'refresh_tokens'
 ORDER BY ordinal_position;
