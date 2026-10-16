-- =============================================================================
-- Migracion 041 - Conversion de tablas GFM al marcado institucional
--
-- QUE PROBLEMA RESUELVE. El nodo PROCESADOR_OCR transcribe adjuntos con una
-- instruccion que le pide EXPLICITAMENTE Markdown GFM para las tablas
-- (`PROMPT_OCR_MULTIMODAL`, en `ocr-processor-config.dto.ts`: "las tablas en
-- GitHub Flavored Markdown, repitiendo el contenido de las celdas combinadas").
-- Ese texto entra despues al PROCESADOR_IA como material de partida.
--
-- El problema es lo que sale por el otro lado: el prompt del verificador de
-- titulos le exige al modelo un marcado institucional muy concreto —paneles
-- Bootstrap `.panel-default` con `.panel-title` y `.panel-body`, y tablas
-- `.tableform`— porque es lo que el portal Drupal sabe pintar y lo que audita
-- `PostIaSanitizerStrategy` cuando el nodo declara `requiredSelectors`. Sin una
-- regla de conversion, el modelo hace lo mas natural con una tabla que ya viene
-- en Markdown: copiarla tal cual, o traducirla a un `<table>` desnudo. En el
-- primer caso los pipes acaban publicados como texto; en el segundo la tabla se
-- publica sin la clase que le da formato, y el escudo la rechaza si el nodo
-- exige el selector.
--
-- POR QUE EN EL PROMPT Y NO EN CODIGO. La instruccion es una REGLA DE REDACCION,
-- y todas las de este flujo viven en `plantillas_prompts_ia` desde la migracion
-- 023: ahi las puede corregir un editor sin desplegar. Ponerla en TypeScript la
-- partiria en dos sitios y obligaria a un despliegue para afinar una frase.
--
-- POR QUE SOLO EN LOS PROMPTS QUE YA TRABAJAN CON TABLAS. El `WHERE` acota a los
-- que ya mencionan `tableform`, no a todos. Un prompt de noticias no recibe
-- tablas y anadirle una regla sobre acordeones solo gastaria contexto y abriria
-- la puerta a que inventase paneles donde debe ir un parrafo. La regla se aplica
-- donde hay tablas que convertir.
--
-- IDEMPOTENCIA. El `AND texto_prompt NOT LIKE '%GitHub Flavored Markdown%'`
-- impide que una segunda pasada concatene la directiva dos veces. Es la misma
-- precaucion que toma la 036 con su `LIKE` sobre el texto que va a sustituir.
--
-- SIN DEPENDENCIA DE LA 040. Esta migracion toca `plantillas_prompts_ia` y
-- aquella `flujos`: se pueden aplicar en cualquier orden.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/041-prompt-tablas-institucionales.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

-- -----------------------------------------------------------------------------
-- La directiva se ANEXA al final del prompt, no sustituye nada.
--
-- Va al final a proposito: las reglas de formato de salida de estos prompts ya
-- estan agrupadas ahi, y abrirlas por el medio obligaria a acertar con un
-- ancla textual que cambia cada vez que un editor corrige una frase.
--
-- Describe la conversion en los dos sentidos que el modelo puede encontrarse:
-- una tabla suelta y un bloque de secciones que deberia ser un acordeon.
-- -----------------------------------------------------------------------------
UPDATE plantillas_prompts_ia
   SET texto_prompt = texto_prompt || E'\n'
           || '- Si el material de partida trae tablas en Markdown (GitHub Flavored Markdown, con celdas separadas por | y una fila de guiones bajo la cabecera), NUNCA las copies tal cual ni las publiques como texto: conviertelas al marcado institucional. Cada tabla pasa a ser un <table class="tableform"> con su <thead> y su <tbody>, y cada celda combinada que el origen repita se vuelve a combinar con colspan o rowspan.'
           || E'\n'
           || '- Si esas tablas vienen agrupadas por secciones o epigrafes, envuelve cada seccion en un panel: <div class="panel panel-default"> con el titulo en <div class="panel-heading"><h4 class="panel-title">...</h4></div> y el contenido en <div class="panel-body">. Respeta las clases exactamente como estan escritas aqui: son las que el portal sabe pintar y las que audita el nodo de validacion posterior.',
       actualizado_en = NOW()
 WHERE texto_prompt LIKE '%tableform%'
   AND texto_prompt NOT LIKE '%GitHub Flavored Markdown%';

COMMIT;

-- =============================================================================
-- Comprobacion del resultado
-- =============================================================================

-- Los prompts alcanzados. `tiene_directiva` debe ser TRUE en todos: si alguno
-- sale FALSE, su texto menciona `tableform` pero el UPDATE no lo toco.
SELECT codigo,
       nombre,
       (texto_prompt LIKE '%GitHub Flavored Markdown%') AS tiene_directiva,
       LENGTH(texto_prompt) AS longitud,
       actualizado_en
  FROM plantillas_prompts_ia
 WHERE texto_prompt LIKE '%tableform%'
 ORDER BY codigo;

-- Cero filas confirma que la directiva no se duplico en ningun prompt.
SELECT codigo
  FROM plantillas_prompts_ia
 WHERE (LENGTH(texto_prompt) - LENGTH(REPLACE(texto_prompt, 'GitHub Flavored Markdown', '')))
       / LENGTH('GitHub Flavored Markdown') > 1;
