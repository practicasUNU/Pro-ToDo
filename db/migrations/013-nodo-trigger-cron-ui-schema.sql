-- =============================================================================
-- Migracion 013 · Catalogo y esquema de UI del nodo TRIGGER_CRON
--
-- Dos partes sobre la misma fila: asegurar que existe (DML idempotente) y
-- describir su formulario (`ui_schema`).
--
-- POR QUE EL INSERT SI HACE FALTA: `TRIGGER_CRON` solo esta sembrado en
-- `init.sql`, que unicamente corre sobre un volumen de Docker vacio. El INSERT
-- de la migracion 005 reinserta los tipos del enum pero NO incluye este, porque
-- entonces se daba por sentado que venia del seed original. Una base construida
-- solo a base de migraciones se queda sin la fila, y el UPDATE de abajo no
-- afectaria a ninguna: el nodo no aparaceria en `GET /api/nodos` y el selector
-- del asistente no lo ofreceria nunca.
--
-- QUE SIGNIFICA ESTE `ui_schema`: es el contrato declarativo del formulario del
-- nodo, y hoy es DOCUMENTAL. El frontend resuelve que componente pintar con un
-- registro explicito (`node-config-registry.ts` -> `TriggerCronConfig.vue`), no
-- leyendo esta columna. Se rellena igualmente porque es la unica descripcion de
-- los campos que vive junto a los datos, y porque el dia que el editor pase a
-- ser polimorfico este es el formato que consumira. Las nueve filas la tenian
-- vacia (`'{}'`); esta es la primera que la declara.
--
-- Los campos replican `CronTriggerConfigDto`. No hay modo de disparo unico:
-- solo se admite programacion recurrente (ver el TSDoc del DTO).
--
-- Idempotente: se puede reaplicar sin efectos secundarios.
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

-- 1. La fila del catalogo debe existir venga de donde venga la base.
INSERT INTO nodos (codigo, nombre, categoria, descripcion) VALUES
    ('TRIGGER_CRON', 'Disparador Cron', 'TRIGGER', 'Inicia el flujo mediante una programacion temporal')
ON CONFLICT (codigo) DO NOTHING;

-- 2. Contrato declarativo del formulario de configuracion.
UPDATE nodos
   SET ui_schema = '{
     "fields": [
       {
         "name": "cronExpression",
         "type": "text",
         "label": "Expresion cron",
         "required": true,
         "placeholder": "0 9 * * 1-5",
         "helpText": "Cinco campos: minuto hora dia mes dia-semana. No se admiten segundos ni alias como @daily."
       },
       {
         "name": "timeZone",
         "type": "select",
         "label": "Zona horaria",
         "required": false,
         "default": "Europe/Madrid",
         "helpText": "Nombre IANA (Europe/Madrid, UTC). No se admiten desplazamientos fijos: no siguen el horario de verano."
       },
       {
         "name": "outputNamespace",
         "type": "text",
         "label": "Namespace de salida",
         "required": false,
         "default": "cron_trigger",
         "helpText": "Namespace declarado del nodo. El efectivo es el del pipeline_schema."
       }
     ]
   }'::jsonb
 WHERE codigo = 'TRIGGER_CRON';

COMMIT;

-- Verificacion manual tras aplicar:
--   SELECT codigo, jsonb_array_length(ui_schema -> 'fields') AS campos
--     FROM nodos WHERE codigo = 'TRIGGER_CRON';
