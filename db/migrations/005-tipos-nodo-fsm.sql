-- =============================================================================
-- Migracion 005 · Alineacion del catalogo `tipos_nodo` con el enum NodeType (PROT-07)
--
-- El enum `NodeType` de `@core/fsm/types/pipeline-schema.types` fija los 7 tipos
-- que un `pipeline_schema` puede declarar. El seed original de `tipos_nodo` usaba
-- otros tres codigos para los mismos conceptos, asi que un flujo valido en el
-- backend no habria encontrado su fila en el catalogo:
--
--   NODO_PARSER_CORREO -> PARSER_PRE_IA    (sanitizacion previa a la IA)
--   NODO_VALIDACION    -> ESCUDO_POST_IA   (escudo de validacion tras la IA)
--   DESTINO_DRUPAL     -> DESTINO_HTTP     (destino generico por HTTP)
--
-- `tipos_nodo.codigo` es VARCHAR(50) UNIQUE, no un tipo ENUM de PostgreSQL, de
-- modo que renombrar es un simple UPDATE: no hace falta recrear el tipo ni
-- reescribir las columnas que lo usan. La `categoria` de cada fila no cambia.
--
-- NO SE BORRA NINGUNA FILA. `TRIGGER_CRON` y `DESTINO_ACENS` se quedan en el
-- catalogo aunque el enum todavia no los contemple: `nodos.id_tipo_nodo` es una
-- clave foranea contra esta tabla y un DELETE seria destructivo e irrepetible.
-- Quedan como tipos aun no expresables en `pipeline_schema`; el enum se ampliara
-- cuando se implementen sus estrategias.
--
-- Es idempotente por construccion: los UPDATE filtran por el codigo antiguo (tras
-- la primera pasada ninguna fila lo cumple) y los INSERT llevan
-- ON CONFLICT (codigo) DO NOTHING, que ademas cubre una base de datos levantada
-- sin el seed de `init.sql`.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/005-tipos-nodo-fsm.sql
-- =============================================================================

SET client_encoding = 'UTF8';

-- 1. Renombrado de los tres codigos divergentes.
UPDATE tipos_nodo
   SET codigo = 'PARSER_PRE_IA',
       nombre = 'Parser Pre-IA',
       descripcion = 'Decodifica el contenido MIME y sanitiza el texto antes de llamar al modelo'
 WHERE codigo = 'NODO_PARSER_CORREO';

UPDATE tipos_nodo
   SET codigo = 'ESCUDO_POST_IA',
       nombre = 'Escudo Post-IA',
       descripcion = 'Valida la salida del modelo contra el esquema esperado antes de propagarla'
 WHERE codigo = 'NODO_VALIDACION';

UPDATE tipos_nodo
   SET codigo = 'DESTINO_HTTP',
       nombre = 'Destino HTTP',
       descripcion = 'Publica el resultado final mediante una peticion HTTP (Drupal JSON:API u otro)'
 WHERE codigo = 'DESTINO_DRUPAL';

-- 2. Alta de los 7 tipos del enum. Solo actua si falta alguno (base sin seed).
INSERT INTO tipos_nodo (codigo, nombre, categoria, descripcion) VALUES
    ('TRIGGER_IMAP', 'Disparador IMAP', 'TRIGGER', 'Inicia el flujo mediante la lectura de correos entrantes'),
    ('PARSER_PRE_IA', 'Parser Pre-IA', 'PROCESAMIENTO', 'Decodifica el contenido MIME y sanitiza el texto antes de llamar al modelo'),
    ('EXTRACTOR_WEB', 'Extractor Web', 'PROCESAMIENTO', 'Extrae y sanitiza contenido desde una pagina web'),
    ('PROCESADOR_IA', 'Procesador de IA', 'PROCESAMIENTO', 'Ejecuta inferencia mediante un modelo de lenguaje'),
    ('ESCUDO_POST_IA', 'Escudo Post-IA', 'CONTROL', 'Valida la salida del modelo contra el esquema esperado antes de propagarla'),
    ('MAPEADOR_PLANTILLA', 'Mapeador de Plantilla', 'PROCESAMIENTO', 'Interpola variables dinamicas sobre una plantilla HTML'),
    ('DESTINO_HTTP', 'Destino HTTP', 'DESTINO', 'Publica el resultado final mediante una peticion HTTP (Drupal JSON:API u otro)')
ON CONFLICT (codigo) DO NOTHING;

-- Comprobacion del resultado: los 7 del enum mas los 2 heredados sin estrategia.
SELECT codigo, categoria, nombre
  FROM tipos_nodo
 ORDER BY categoria, codigo;
