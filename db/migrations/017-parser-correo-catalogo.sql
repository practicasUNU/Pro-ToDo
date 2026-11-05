-- =============================================================================
-- Migracion 017 · Rotulo y descripcion del nodo PARSER_PRE_IA
--
-- Cambia SOLO como se presenta el nodo al operador. El `codigo` no se toca y no
-- puede tocarse: es la clave que viaja en `configuracion_pipeline`, la que
-- resuelve `NodeStrategyFactory` y la que replica el enum `NodeType` del
-- frontend. Renombrarlo dejaria sin estrategia a todos los flujos ya guardados.
--
-- POR QUE: "Parser Pre-IA" describe CUANDO corre el nodo (antes del modelo), no
-- QUE hace. El operador que monta un flujo elige por la tarea, no por la
-- posicion, y la descripcion anterior —"Decodifica el contenido MIME y sanitiza
-- el texto"— hablaba de MIME, que no es el vocabulario de quien usa el
-- asistente, y omitia las dos salidas que de verdad consumen los nodos
-- siguientes: el asunto y los enlaces extraidos.
--
-- POR QUE SOLO UN UPDATE, sin el `INSERT ... ON CONFLICT` de la migracion 013:
-- alli la fila de TRIGGER_CRON solo existia en `init.sql`, de modo que una base
-- levantada a base de migraciones se quedaba sin ella. Esta fila la siembran las
-- DOS vias (`init.sql` y la migracion 005), asi que no hay base donde falte.
--
-- `init.sql` se actualiza en el mismo commit: sin eso un volumen de Docker nuevo
-- naceria con el texto viejo y esta migracion haria falta para siempre.
--
-- Idempotente: se puede reaplicar sin efectos secundarios.
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

UPDATE nodos
   SET nombre = 'Parser de Correo',
       descripcion = 'Procesa y limpia correos entrantes, extrayendo asunto, texto plano sin firmas y URLs de referencia.'
 WHERE codigo = 'PARSER_PRE_IA';

COMMIT;

-- Verificacion manual tras aplicar:
--   SELECT codigo, nombre, descripcion FROM nodos WHERE codigo = 'PARSER_PRE_IA';
