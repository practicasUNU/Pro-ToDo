-- =============================================================================
-- Migracion 044 · Fijar `markAsRead: false` explicito en los nodos TRIGGER_IMAP
--
-- QUE CAMBIA. Anade la clave `params.markAsRead` con valor `false` a los nodos
-- `TRIGGER_IMAP` de `flujos.configuracion_pipeline` y de
-- `plantillas_flujo.configuracion_pipeline` que HOY NO LA DECLARAN. Ni columnas,
-- ni indices, ni filas nuevas: solo reescribe el jsonb. Los nodos que ya traen
-- un valor —sea `true` o `false`— se quedan exactamente como estan.
--
-- POR QUE. `DEFAULT_MARK_AS_READ` ya vale `false` y `resolveImapConfig` lo
-- aplica en ejecucion, de modo que un nodo sin la clave YA se comporta como
-- "no marcar". Esta migracion no corrige ningun comportamiento del motor: lo
-- que corrige es la LECTURA del esquema. Un operador que abre el JSONB de un
-- flujo heredado no ve la clave y no puede saber si el correo se marcara o no
-- sin ir a leerse el DTO del backend, y el mismo hueco obliga a cualquier
-- consulta de auditoria sobre `configuracion_pipeline` a replicar el valor por
-- defecto para responder la pregunta.
--
-- LO QUE ESTA MIGRACION NO ARREGLA. El `\Seen` que si se aplicaba al margen de
-- `markAsRead` no venia del esquema: lo ponia `InboundEmailResumeService`, que
-- marcaba TODO mensaje leido en su buzon fuera o no una orden de reanudacion.
-- Eso se corrige en el codigo del servicio, no aqui. Esta migracion sola no
-- habria cambiado nada observable.
--
-- POR QUE `false` Y NO `true`. Es el valor por defecto vigente, asi que
-- escribirlo preserva el comportamiento actual de cada flujo. Sembrar `true`
-- empezaria a marcar correo que hoy no se marca, que es justo la averia de la
-- que se viene.
--
-- SE RECORREN TODOS LOS NODOS Y NO SOLO EL `entrypoint`. El sondeo de
-- `ImapPollingService` solo atiende el disparador de entrada, pero un esquema
-- puede declarar un `TRIGGER_IMAP` en otra posicion, y dejarlo a medio describir
-- reproduciria el mismo hueco de lectura en cuanto alguien lo promocione.
--
-- IDEMPOTENTE. El `WHERE EXISTS` deja de casar en cuanto no queda ningun
-- `TRIGGER_IMAP` sin la clave, asi que repetirla no hace nada.
--
-- OPCIONAL EN UNA BASE RECIEN CREADA: si todos los disparadores ya la declaran,
-- no afecta a ninguna fila. Se aplica igual para que todas las instalaciones
-- converjan al mismo estado.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' \
--     < db/migrations/044-markasread-explicito-trigger-imap.sql
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
                      WHEN nodo->>'nodeType' = 'TRIGGER_IMAP'
                       AND NOT (nodo->'params' ? 'markAsRead')
                      -- `jsonb_set` con `create_missing = true` crea la clave
                      -- dentro de `params`. `params` siempre existe: el DTO lo
                      -- declara `@IsObject` obligatorio, asi que no hay nodo
                      -- validado sin el.
                      THEN jsonb_set(nodo, '{params,markAsRead}', 'false'::jsonb, true)
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
          WHERE nodo->>'nodeType' = 'TRIGGER_IMAP'
            AND NOT (nodo->'params' ? 'markAsRead')
       );

-- 2. Plantillas de flujo: misma estructura jsonb, mismo hueco de lectura.
UPDATE plantillas_flujo p
   SET configuracion_pipeline = jsonb_set(
         p.configuracion_pipeline,
         '{nodes}',
         (
           SELECT jsonb_object_agg(
                    clave,
                    CASE
                      WHEN nodo->>'nodeType' = 'TRIGGER_IMAP'
                       AND NOT (nodo->'params' ? 'markAsRead')
                      THEN jsonb_set(nodo, '{params,markAsRead}', 'false'::jsonb, true)
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
          WHERE nodo->>'nodeType' = 'TRIGGER_IMAP'
            AND NOT (nodo->'params' ? 'markAsRead')
       );

COMMIT;

-- Verificacion: las dos consultas deben devolver 0 filas.
SELECT f.nombre, t.clave
  FROM flujos f, jsonb_each(f.configuracion_pipeline->'nodes') AS t(clave, nodo)
 WHERE nodo->>'nodeType' = 'TRIGGER_IMAP'
   AND NOT (nodo->'params' ? 'markAsRead');

SELECT p.nombre, t.clave
  FROM plantillas_flujo p, jsonb_each(p.configuracion_pipeline->'nodes') AS t(clave, nodo)
 WHERE nodo->>'nodeType' = 'TRIGGER_IMAP'
   AND NOT (nodo->'params' ? 'markAsRead');
