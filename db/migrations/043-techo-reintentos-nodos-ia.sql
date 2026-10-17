-- =============================================================================
-- Migracion 043 · Recortar `maxRetries` al nuevo techo de 3 en los nodos de IA
--
-- QUE CAMBIA. El valor de `params.maxRetries` dentro de los nodos
-- `PROCESADOR_IA` y `PROCESADOR_OCR` de `flujos.configuracion_pipeline` y
-- `plantillas_flujo.configuracion_pipeline`, cuando supera 3. Ni columnas, ni
-- indices, ni filas nuevas: solo reescribe el jsonb.
--
-- POR QUE. `MAX_LLM_RETRIES` y `MAX_OCR_RETRIES` bajan de 5 a 3. El motor
-- ejecuta los nodos EN LINEA, de modo que el tiempo que una ejecucion pasa
-- bloqueada es `timeoutMs x (maxRetries + 1)` y la cuenta se repite ademas por
-- cada proveedor de la cadena de respaldo: con cinco reintentos y el techo de
-- espera de estos nodos, un proveedor mudo retenia el mutex del flujo mas de
-- diez minutos por proveedor.
--
-- POR QUE HACE FALTA TOCAR LO YA GUARDADO. El asistente publica `maxRetries` en
-- el `pipeline_schema` aunque el operador no lo haya tocado, asi que un flujo
-- creado antes de este cambio lleva su valor clavado en el JSONB. Como el DTO
-- valida con `@Max`, ese flujo devolveria **400 al editarlo** — un fallo que el
-- operador leeria como un error del formulario y no como la consecuencia de un
-- limite nuevo. El motor ya lo recortaria en ejecucion por el techo de entorno
-- (`LLM_HTTP_MAX_RETRIES`), pero eso no salva al formulario.
--
-- EL SUELO NO SE TOCA. `maxRetries: 0` sigue siendo valido: apagar los
-- reintentos es la configuracion mas barata frente a un proveedor de pago, y
-- subirlo a 1 cambiaria el coste de flujos que nadie pidio cambiar.
--
-- IDEMPOTENTE. El `WHERE EXISTS` deja de casar en cuanto no queda ningun nodo
-- por encima del techo, asi que repetirla no hace nada.
--
-- OPCIONAL EN UNA BASE RECIEN CREADA: si ningun flujo declaro mas de 3, no
-- afecta a ninguna fila. Se aplica igual para que todas las instalaciones
-- converjan al mismo estado.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/043-techo-reintentos-nodos-ia.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

-- 1. Flujos.
UPDATE flujos f
   SET configuracion_pipeline = jsonb_set(
         f.configuracion_pipeline,
         '{nodes}',
         (
           SELECT jsonb_object_agg(
                    clave,
                    CASE
                      WHEN nodo->>'nodeType' IN ('PROCESADOR_IA', 'PROCESADOR_OCR')
                       AND (nodo->'params'->>'maxRetries') ~ '^[0-9]+$'
                       AND (nodo->'params'->>'maxRetries')::int > 3
                      THEN jsonb_set(nodo, '{params,maxRetries}', '3'::jsonb)
                      ELSE nodo
                    END
                  )
             FROM jsonb_each(f.configuracion_pipeline->'nodes') AS t(clave, nodo)
         )
       )
 WHERE f.configuracion_pipeline IS NOT NULL
   AND EXISTS (
         SELECT 1
           FROM jsonb_each(f.configuracion_pipeline->'nodes') AS t(clave, nodo)
          WHERE nodo->>'nodeType' IN ('PROCESADOR_IA', 'PROCESADOR_OCR')
            AND (nodo->'params'->>'maxRetries') ~ '^[0-9]+$'
            AND (nodo->'params'->>'maxRetries')::int > 3
       );

-- 2. Plantillas de flujo: misma estructura jsonb, mismo problema.
UPDATE plantillas_flujo p
   SET configuracion_pipeline = jsonb_set(
         p.configuracion_pipeline,
         '{nodes}',
         (
           SELECT jsonb_object_agg(
                    clave,
                    CASE
                      WHEN nodo->>'nodeType' IN ('PROCESADOR_IA', 'PROCESADOR_OCR')
                       AND (nodo->'params'->>'maxRetries') ~ '^[0-9]+$'
                       AND (nodo->'params'->>'maxRetries')::int > 3
                      THEN jsonb_set(nodo, '{params,maxRetries}', '3'::jsonb)
                      ELSE nodo
                    END
                  )
             FROM jsonb_each(p.configuracion_pipeline->'nodes') AS t(clave, nodo)
         )
       )
 WHERE p.configuracion_pipeline IS NOT NULL
   AND EXISTS (
         SELECT 1
           FROM jsonb_each(p.configuracion_pipeline->'nodes') AS t(clave, nodo)
          WHERE nodo->>'nodeType' IN ('PROCESADOR_IA', 'PROCESADOR_OCR')
            AND (nodo->'params'->>'maxRetries') ~ '^[0-9]+$'
            AND (nodo->'params'->>'maxRetries')::int > 3
       );

COMMIT;

-- Verificacion manual tras aplicar (debe devolver 0 filas):
--   SELECT f.nombre, clave, nodo->'params'->>'maxRetries'
--     FROM flujos f, jsonb_each(f.configuracion_pipeline->'nodes') AS t(clave, nodo)
--    WHERE nodo->>'nodeType' IN ('PROCESADOR_IA','PROCESADOR_OCR')
--      AND (nodo->'params'->>'maxRetries')::int > 3;
