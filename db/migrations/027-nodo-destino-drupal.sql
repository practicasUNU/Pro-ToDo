-- =============================================================================
-- Migracion 027 · Renombrado del destino `DESTINO_HTTP` a `DESTINO_DRUPAL`
--
-- Deshace el renombrado que hizo la migracion 005, y no por capricho: aquella
-- alineo el catalogo con el enum `NodeType` de entonces, que apostaba por un
-- destino HTTP generico. El generico nunca llego. Lo que hay implementado habla
-- exclusivamente el dialecto JSON:API de Drupal, y sus hermanos del catalogo
-- —`DESTINO_SMTP`, `DESTINO_ACENS`— nombran el destino y no el transporte, de
-- modo que `DESTINO_HTTP` era el unico que desentonaba. Lo verdaderamente
-- compartido por HTTP vive ahora en la clase `BaseHttpDestinationStrategy`.
--
-- `nodos.codigo` es VARCHAR(50) UNIQUE, NO un tipo ENUM de PostgreSQL, asi que
-- renombrar sigue siendo un simple UPDATE: no hace falta recrear el tipo ni
-- reescribir las columnas que lo usan. La clave ajena desde los flujos apunta
-- al UUID de la fila, no al codigo, de modo que ninguna referencia se rompe.
--
-- EL PASO 3 ES EL QUE NO SE PUEDE OLVIDAR. El `nodeType` tambien viaja como
-- TEXTO dentro del JSONB `configuracion_pipeline` de cada flujo y cada
-- plantilla ya guardados. Sin reescribirlo ahi, esos flujos dejan de validar
-- contra `@IsEnum(NodeType)` y el asistente no puede abrirlos.
--
-- NO se tocan los `logs_nodo`: `tipo_nodo` es la traza historica de ejecuciones
-- que de verdad corrieron bajo el nombre antiguo, y reescribirla falsearia la
-- auditoria. El modulo de trazabilidad seguira mostrando `DESTINO_HTTP` en las
-- corridas anteriores a esta migracion, que es lo correcto.
--
-- Es idempotente por construccion: los UPDATE filtran por el codigo antiguo
-- (tras la primera pasada ninguna fila lo cumple) y el INSERT lleva
-- ON CONFLICT (codigo) DO NOTHING, que ademas cubre una base levantada sin el
-- seed de `init.sql`.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' \
--     < db/migrations/027-nodo-destino-drupal.sql
-- =============================================================================

SET client_encoding = 'UTF8';

-- 1. Catalogo: renombrar la fila conservando su UUID y su categoria.
UPDATE nodos
   SET codigo = 'DESTINO_DRUPAL',
       nombre = 'Destino Drupal',
       descripcion = 'Publica el resultado final en el CMS Drupal mediante JSON:API'
 WHERE codigo = 'DESTINO_HTTP';

-- 2. Alta por si la base nacio sin el seed de `init.sql`.
INSERT INTO nodos (codigo, nombre, categoria, descripcion) VALUES
    ('DESTINO_DRUPAL', 'Destino Drupal', 'DESTINO', 'Publica el resultado final en el CMS Drupal mediante JSON:API')
ON CONFLICT (codigo) DO NOTHING;

-- 3. Flujos y plantillas ya guardados. El valor va entrecomillado en el patron
--    para no tocar por accidente una descripcion que mencione el nombre en
--    prosa: dentro del JSON el tipo SIEMPRE aparece como cadena JSON.
UPDATE flujos
   SET configuracion_pipeline =
       REPLACE(configuracion_pipeline::text, '"DESTINO_HTTP"', '"DESTINO_DRUPAL"')::jsonb
 WHERE configuracion_pipeline::text LIKE '%"DESTINO_HTTP"%';

UPDATE plantillas_flujo
   SET configuracion_pipeline =
       REPLACE(configuracion_pipeline::text, '"DESTINO_HTTP"', '"DESTINO_DRUPAL"')::jsonb
 WHERE configuracion_pipeline::text LIKE '%"DESTINO_HTTP"%';

-- Comprobacion: no debe quedar rastro del codigo antiguo en ninguna de las tres.
SELECT 'nodos' AS origen, COUNT(*) AS restantes
  FROM nodos WHERE codigo = 'DESTINO_HTTP'
UNION ALL
SELECT 'flujos', COUNT(*)
  FROM flujos WHERE configuracion_pipeline::text LIKE '%"DESTINO_HTTP"%'
UNION ALL
SELECT 'plantillas_flujo', COUNT(*)
  FROM plantillas_flujo WHERE configuracion_pipeline::text LIKE '%"DESTINO_HTTP"%';
