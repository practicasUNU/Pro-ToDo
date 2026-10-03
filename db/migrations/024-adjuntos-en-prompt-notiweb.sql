-- =============================================================================
-- Migracion 024 · El bloque de adjuntos en `NOTIWEB_DEFAULT`
--
-- QUE FALTABA. De las tres semillas de la migracion 023, dos citaban ya
-- `{{parsed_email.extracted_documents_text}}` —`LICITACION_DEFAULT` y
-- `PANELES_UEM_DEFAULT`— y `NOTIWEB_DEFAULT` no. Un correo de Notiweb que
-- llegase con la directiva del editor en un .docx adjunto perdia ese texto: el
-- modelo solo veia el cuerpo del correo y el articulo extraido.
--
-- POR QUE NO SE EDITA LA 023 Y YA ESTA. Porque su INSERT lleva
-- `ON CONFLICT (codigo) DO NOTHING`, que es lo correcto —curar prompts es
-- trabajo del CRUD, no de una migracion— pero significa que reaplicarla sobre
-- una base ya sembrada no toca una sola fila. El texto de la 023 se corrige
-- igualmente, para las bases que nazcan de cero; esta migracion es la que
-- alcanza a las que ya existen.
--
-- EL MARCADOR ES SEGURO AUNQUE NO HAYA ADJUNTOS. `ParserEmailStrategy` publica
-- `extracted_documents_text` SIEMPRE, con cadena vacia cuando no hay documentos
-- que extraer, asi que `getInterpolatedValue` no puede lanzar
-- `MissingContextVariableException` por esta linea. Si el nodo parser no ha
-- corrido, el prompt ya fallaba antes por `{{parsed_email.clean_body}}`.
--
-- Es idempotente: la guarda `NOT LIKE` impide que una reaplicacion acumule el
-- bloque dos veces, y respeta a quien ya lo haya anadido a mano desde el CRUD.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/024-adjuntos-en-prompt-notiweb.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

UPDATE plantillas_prompts_ia
   SET texto_prompt = texto_prompt || E'\n\n' ||
                      'Documentos adjuntos:' || E'\n' ||
                      '{{parsed_email.extracted_documents_text}}',
       fecha_actualizacion = NOW()
 WHERE codigo = 'NOTIWEB_DEFAULT'
   AND texto_prompt NOT LIKE '%extracted_documents_text%';

COMMIT;

-- =============================================================================
-- Comprobacion del resultado
--
--   SELECT codigo,
--          texto_prompt LIKE '%extracted_documents_text%' AS lleva_adjuntos
--     FROM plantillas_prompts_ia
--    ORDER BY codigo;
--
-- Las tres semillas deben salir con `lleva_adjuntos = t`.
-- =============================================================================
