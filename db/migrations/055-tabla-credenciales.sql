-- =============================================================================
-- Migracion 055 - Boveda de credenciales cifradas
--
-- QUE ANADE. La tabla `credenciales`: secretos de autenticacion (token Bearer,
-- usuario/contrasena Basic, API key) que usa el nodo DESTINO_HTTP_GENERICO,
-- cifrados con AES-256-GCM por `EncryptionService` y la clave
-- `CREDENTIALS_ENCRYPTION_KEY` del `.env` del backend.
--
-- QUE PROBLEMA RESUELVE. Un conector HTTP generico necesita credenciales de
-- servicios arbitrarios, y guardarlas en `flujos.configuracion_pipeline` las
-- dejaba en claro en la base, en cada checkpoint de `ejecuciones_flujo` y en
-- cualquier JSON exportado. El esquema guarda solo `authConfig.credentialId`.
--
-- DISENO.
--   * `datos_cifrados` es el JSON del secreto, cifrado; `vector_inicializacion`
--     el IV aleatorio de 12 bytes y `etiqueta_autenticacion` el tag GCM de 16.
--     Los tres en base64 (TEXT): ningun valor binario viaja por el driver.
--   * El `id_credencial` lo genera la aplicacion antes del INSERT porque es el
--     dato asociado (AAD) del cifrado: copiar el blob a otra fila lo vuelve
--     indescifrable. El DEFAULT queda solo para altas manuales por SQL.
--   * `tipo_autenticacion` lleva CHECK con los tres tipos de
--     `CredentialAuthType`. `NONE` no se guarda: no hay secreto que guardar.
--   * `creado_en` / `actualizado_en` sin columnas de autor: quien crea, rota o
--     borra una credencial queda en `audit_eventos`, con los secretos
--     enmascarados ('********').
--
-- IDEMPOTENTE: `IF NOT EXISTS` en la tabla y el indice.
--
-- Aplicar con:
--   cd backend && npm run db:migrate
-- o directamente:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' < db/migrations/055-tabla-credenciales.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

CREATE TABLE IF NOT EXISTS credenciales (
    id_credencial UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nombre VARCHAR(100) NOT NULL,
    tipo_autenticacion VARCHAR(20) NOT NULL
        CONSTRAINT credenciales_tipo_autenticacion_check
        CHECK (tipo_autenticacion IN ('BEARER_TOKEN', 'BASIC_AUTH', 'API_KEY')),
    datos_cifrados TEXT NOT NULL,
    vector_inicializacion TEXT NOT NULL,
    etiqueta_autenticacion TEXT NOT NULL,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Nombre unico: es lo que el EDITOR lee en el selector cerrado del nodo.
CREATE UNIQUE INDEX IF NOT EXISTS idx_credenciales_nombre ON credenciales (nombre);

COMMIT;

-- Verificacion manual tras aplicar:
--   \d credenciales
-- =============================================================================
