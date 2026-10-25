-- =============================================================================
-- Migracion 056 - Nodo DESTINO_HTTP_GENERICO (MOD-03)
--
-- QUE ANADE. La fila del catalogo `nodos` del conector de salida HTTP generico:
-- envia el resultado del flujo a cualquier API REST publica, con verbo,
-- cabeceras, parametros y cuerpo interpolados y autenticacion por credencial
-- de la boveda (migracion 055).
--
-- POR QUE CATEGORIA DESTINO. Escribe fuera del sistema, y la regla 11 del
-- validador de topologia exige `nextStep: null` a todo DESTINO
-- (`DESTINO_NODE_TYPES`). Su respuesta queda en `http_generic_response`.
--
-- POR QUE `ON CONFLICT DO NOTHING`. Idempotente, como la 042. `init.sql` se
-- actualiza en el mismo commit para que un volumen nuevo nazca con la fila.
--
-- Aplicar con:
--   cd backend && npm run db:migrate
-- o directamente:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' < db/migrations/056-nodo-destino-http-generico.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

INSERT INTO nodos (codigo, nombre, categoria, descripcion) VALUES
    ('DESTINO_HTTP_GENERICO', 'Destino HTTP Generico', 'DESTINO', 'Envia el resultado del flujo a una API REST publica (GET, POST, PUT, PATCH o DELETE) con cabeceras, parametros y cuerpo interpolados. Se autentica con una credencial cifrada de la boveda y rechaza destinos de redes privadas.')
ON CONFLICT (codigo) DO NOTHING;

COMMIT;

-- Verificacion manual tras aplicar:
--   SELECT codigo, nombre, categoria FROM nodos WHERE codigo = 'DESTINO_HTTP_GENERICO';
--   SELECT count(*) FROM nodos;  -- deben ser 13
