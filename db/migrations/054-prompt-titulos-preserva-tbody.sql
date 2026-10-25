-- =============================================================================
-- Migracion 054 · El prompt de Verificacion de Titulos preserva sus <tbody>
--
-- QUE ANADE. Una regla al final del prompt que rellena la plantilla
-- "Verificacion de Titulos · Panel de evaluacion": la etiqueta
-- `<tbody class="panel-titulos-body">` se conserva intacta, las filas
-- generadas van DENTRO de ella y el `<tbody>` estatico de evaluadores no se
-- toca.
--
-- QUE PROBLEMA RESUELVE. La plantilla (migraciones 033/034) lleva DOS `<tbody>`
-- en la misma `table.tableform`: `.panel-titulos-body`, vacio para que la IA
-- emita una fila por titulacion, y otro estatico. Los modelos tienden a
-- "ordenar" la tabla fusionando las dos secciones o descartando la vacia, y el
-- ESCUDO_POST_IA dejaba el flujo PAUSADO con ERR_POST_IA_DOM_MUTATED. El
-- contrato de formato que anade el backend (`buildResponseContractInstruction`)
-- ya repite la regla; esta migracion la deja tambien en el texto que el
-- operador lee y edita, para que no desaparezca si alguien reescribe el prompt.
--
-- POR QUE SE FILTRA POR EL CONTENIDO Y NO POR `codigo`. Alcanza a cualquier
-- prompt que hable de `.panel-titulos-body`, no solo al sembrado. Y, ademas,
-- `test/helpers/prompt-migrations.helper.ts` reconstruye el prompt de
-- VERIFICADOR_TITULOS_DEFAULT componiendo las migraciones que lo NOMBRAN, y
-- solo entiende asignaciones completas y REPLACE: un anexo `texto_prompt || ...`
-- que lo nombrase se leeria como una reescritura entera.
--
-- IDEMPOTENTE: el `NOT LIKE` sobre la propia frase impide anexarla dos veces.
--
-- Aplicar con:
--   cd backend && npm run db:migrate
-- o directamente:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' < db/migrations/054-prompt-titulos-preserva-tbody.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

UPDATE plantillas_prompts_ia
   SET texto_prompt = texto_prompt || E'\n'
           || '- La etiqueta <tbody class="panel-titulos-body"> debe mantenerse intacta en cada panel: las filas <tr> de las titulaciones van DENTRO de ella. Nunca la fusiones con el otro <tbody> de la tabla, no la renombres ni la elimines, y deja sin modificar el <tbody> estatico de evaluadores.',
       fecha_actualizacion = NOW()
 WHERE texto_prompt LIKE '%panel-titulos-body%'
   AND texto_prompt NOT LIKE '%<tbody class="panel-titulos-body"> debe mantenerse intacta%';

COMMIT;

-- =============================================================================
-- Comprobacion del resultado: `preserva_tbody` debe ser TRUE.
--   SELECT codigo,
--          (texto_prompt LIKE '%panel-titulos-body"> debe mantenerse intacta%') AS preserva_tbody
--     FROM plantillas_prompts_ia
--    WHERE texto_prompt LIKE '%panel-titulos-body%';
-- =============================================================================
