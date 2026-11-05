-- =============================================================================
-- Migracion 026 · Retirar `outputNamespace` de los `params` del MAPEADOR_PLANTILLA
--
-- QUE RETIRA. Una clave muerta dentro de `params` en los nodos
-- `MAPEADOR_PLANTILLA` de `flujos.configuracion_pipeline` y
-- `plantillas_flujo.configuracion_pipeline`. Ni columnas, ni indices, ni filas:
-- solo poda el jsonb.
--
-- POR QUE NUNCA HIZO NADA. El namespace que el motor usa para depositar el
-- resultado de un nodo es el `outputNamespace` del NODO
-- (`PipelineNodeConfigDto`, validado contra `NODE_OUTPUT_NAMESPACES` y unico por
-- flujo por la regla 5 de topologia). `FsmEngineService` jamas ha mirado dentro
-- de `params`. La copia era, en el mejor de los casos, un duplicado que decia lo
-- mismo; en el peor, un duplicado que decia otra cosa y que nadie leia.
--
-- POR QUE AHORA. `TemplateMapperStrategy` pasa a declarar `paramsSchema`, y
-- `PipelineValidatorService` valida con `forbidNonWhitelisted: true`. El DTO
-- declara `outputNamespace` como TOLERADO justamente para que estos esquemas
-- historicos sigan guardandose; esta migracion elimina la razon de esa
-- tolerancia, de modo que el campo del DTO pueda retirarse mas adelante.
--
-- ORDEN DE APLICACION. Esta migracion es OPCIONAL y puede aplicarse en
-- cualquier momento DESPUES del despliegue que tolera el campo: mientras el DTO
-- lo acepte, tener o no tener la clave da igual. Aplicarla ANTES de ese
-- despliegue tambien es seguro. Lo que NO se puede es retirar el campo del DTO
-- sin haber aplicado esto.
--
-- IDEMPOTENTE. El `WHERE EXISTS` deja de casar en cuanto no queda ningun nodo
-- con la clave, asi que repetirla no hace nada. El operador `-` sobre jsonb
-- tampoco falla si la clave ya no esta.
--
-- NOTA SOBRE LOS TRIGGERS. `TRIGGER_IMAP` y `TRIGGER_CRON` SI declaran
-- `outputNamespace` en sus `params` de forma legitima y documentada (es
-- informativo y su DTO lo resuelve), por eso el filtro mira el `nodeType` y no
-- barre la columna entera.
-- =============================================================================

-- 1. Flujos.
UPDATE flujos f
   SET configuracion_pipeline = jsonb_set(
         f.configuracion_pipeline,
         '{nodes}',
         (
           SELECT jsonb_object_agg(
                    clave,
                    CASE
                      WHEN nodo->>'nodeType' = 'MAPEADOR_PLANTILLA'
                      THEN jsonb_set(nodo, '{params}', (nodo->'params') - 'outputNamespace')
                      ELSE nodo
                    END
                  )
             FROM jsonb_each(f.configuracion_pipeline->'nodes') AS t(clave, nodo)
         )
       )
 WHERE EXISTS (
         SELECT 1
           FROM jsonb_each(f.configuracion_pipeline->'nodes') AS t(clave, nodo)
          WHERE nodo->>'nodeType' = 'MAPEADOR_PLANTILLA'
            AND nodo->'params' ? 'outputNamespace'
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
                      WHEN nodo->>'nodeType' = 'MAPEADOR_PLANTILLA'
                      THEN jsonb_set(nodo, '{params}', (nodo->'params') - 'outputNamespace')
                      ELSE nodo
                    END
                  )
             FROM jsonb_each(p.configuracion_pipeline->'nodes') AS t(clave, nodo)
         )
       )
 WHERE EXISTS (
         SELECT 1
           FROM jsonb_each(p.configuracion_pipeline->'nodes') AS t(clave, nodo)
          WHERE nodo->>'nodeType' = 'MAPEADOR_PLANTILLA'
            AND nodo->'params' ? 'outputNamespace'
       );

-- Comprobacion del resultado: debe devolver cero filas en ambas tablas.
SELECT 'flujos' AS tabla, f.id_flujo::text AS id, clave AS nodo
  FROM flujos f, jsonb_each(f.configuracion_pipeline->'nodes') AS t(clave, nodo)
 WHERE nodo->>'nodeType' = 'MAPEADOR_PLANTILLA'
   AND nodo->'params' ? 'outputNamespace'
 UNION ALL
SELECT 'plantillas_flujo', p.id_plantilla_flujo::text, clave
  FROM plantillas_flujo p, jsonb_each(p.configuracion_pipeline->'nodes') AS t(clave, nodo)
 WHERE nodo->>'nodeType' = 'MAPEADOR_PLANTILLA'
   AND nodo->'params' ? 'outputNamespace';
