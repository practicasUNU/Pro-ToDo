-- =============================================================================
-- Migracion 066 - Nodo DESTINO_ACENS con estrategia
--
-- QUE CAMBIA. La fila `DESTINO_ACENS` existe desde `init.sql` (migracion 005
-- la conservo sin estrategia). Ahora la tiene (`AcensHttpStrategy`), asi que se
-- actualiza su descripcion para el selector del asistente.
--
-- POR QUE UPSERT. Idempotente y valido tanto sobre un volumen que ya trae la
-- fila como sobre uno que la perdio. `init.sql` se actualiza en el mismo commit.
--
-- La URL base y la clave NO viven en la base de datos ni en el pipeline: salen
-- de ACENS_API_BASE_URL y ACENS_API_KEY en backend/.env.
--
-- Aplicar con:
--   cd backend && npm run db:migrate
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

INSERT INTO nodos (codigo, nombre, categoria, descripcion) VALUES
    ('DESTINO_ACENS', 'Destino Acens', 'DESTINO', 'Entrega el resultado del flujo a la API de Acens (GET, POST, PUT o DELETE) con ruta, cabeceras y cuerpo JSON interpolados y desinfectados. La URL base y la clave se leen del entorno del servidor, nunca del flujo.')
ON CONFLICT (codigo) DO UPDATE SET descripcion = EXCLUDED.descripcion;

COMMIT;

-- Verificacion manual tras aplicar:
--   SELECT codigo, nombre, categoria, descripcion FROM nodos WHERE codigo = 'DESTINO_ACENS';
