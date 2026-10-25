-- =============================================================================
-- Migracion 051 - Version de token por usuario (`usuarios.token_version`)
--
-- QUE ANADE. Un contador entero por cuenta que viaja como claim dentro del JWT
-- y que `JwtStrategy` compara en cada peticion autenticada.
--
-- QUE PROBLEMA RESUELVE. El access token de este proyecto es AUTOCONTENIDO: la
-- identidad viaja firmada en el payload y la estrategia no consultaba la base
-- de datos, de modo que no habia absolutamente ninguna forma de cortar una
-- sesion ya emitida. Revocar los refresh tokens no bastaba —solo impide
-- RENOVAR—, asi que un ADMIN degradado a EDITOR, o una cuenta desactivada,
-- conservaban sus privilegios hasta que el token caducaba por su cuenta
-- (`JWT_EXPIRES_IN`, hoy 1h). Incrementar este contador invalida en el acto
-- todos los tokens vivos de esa persona.
--
-- DISENO.
--   - `INTEGER NOT NULL DEFAULT 0`: las cuentas existentes nacen en 0 y los
--     tokens que ya circulan no llevan el claim, lo que `JwtStrategy` trata
--     como 0. Asi la migracion NO expulsa a nadie al aplicarse.
--   - Solo lo incrementan los cambios que alteran los privilegios o la
--     identidad (rol, estado activo, correo). Una edicion indiferente no
--     cierra la sesion de nadie.
--   - Sin indice: la columna se lee siempre por la clave primaria.
--
-- COSTE CONSCIENTE. A partir de aqui cada peticion autenticada hace un SELECT
-- sobre `usuarios` por su PK. Es el precio de poder revocar un token
-- autocontenido, y se acota leyendo solo dos columnas.
--
-- IDEMPOTENTE: `ADD COLUMN IF NOT EXISTS`.
--
-- Aplicar con:
--   cd backend && npm run db:migrate
-- o directamente:
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' < db/migrations/051-token-version-usuarios.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

COMMIT;

-- Verificacion manual tras aplicar:
--   \d usuarios
--   SELECT correo, token_version FROM usuarios ORDER BY correo;
