-- =============================================================================
-- Migracion 029 · Plantilla base en el prompt de licitaciones
--
-- La ejecucion E2E del flujo de contratacion termino en PAUSADO con
-- ERR_POST_IA_EMPTY_HTML: el ESCUDO_POST_IA leyo `llm_response.filled_markup` y
-- lo encontro a NULL. El nodo de IA no habia hecho nada mal; nunca se le llego a
-- pedir el marcado.
--
-- POR QUE. `LlmExtractorStrategy` decide si espera markup mirando el prompt SIN
-- interpolar contra BASE_TEMPLATE_MARKER_PATTERN —`{{<ns>.compiled_markup}}`— y
-- la semilla de la migracion 023 no cita ese campo por ninguna parte. Con la
-- bandera apagada no se emite la directiva de maquetado, `filled_markup` NO
-- entra en el `required` del esquema y el presupuesto de tokens no sube a los
-- 8192 que un HTML completo necesita. Un flujo que SI tiene MAPEADOR_PLANTILLA
-- quedaba, en la practica, sin consumidor de su plantilla.
--
-- EL CONTRATO JSON SIGUE SIN IR EN EL TEXTO. Es la misma regla que ya explicaba
-- la cabecera de la 023 y conviene repetirla, porque la tentacion aqui es
-- grande: lo correcto NO es pedirle al modelo "devuelve filled_markup" en
-- prosa. Cada cliente de proveedor antepone su propio contrato
-- (`buildResponseContractInstruction`) y, en Anthropic, el esquema viaja con
-- `additionalProperties: false` — una clave que no figure en `properties` esta
-- PROHIBIDA para el modelo por mucho que el prompt la reclame. Lo unico que
-- hace falta en esta columna es el MARCADOR; el resto lo enciende el codigo.
--
-- SOBRE EL NAMESPACE. Se cita `rendered_html` porque es el `outputNamespace`
-- que el asistente propone por defecto para el MAPEADOR_PLANTILLA. El campo
-- —`compiled_markup`— es lo que identifica una plantilla base; el namespace es
-- configurable por nodo. Si el flujo de licitaciones reconfiguro el suyo, hay
-- que ajustar este marcador al valor real, o el nodo fallara por
-- ERR_LLM_INTERPOLATION sobre una variable que nadie escribe.
--
-- SE CONSERVAN `headline`, `summary` y `body_paragraphs`. No son redundantes
-- con el markup: siguen siendo obligatorios en el esquema de respuesta pase lo
-- que pase, y el MAPEADOR_PLANTILLA los interpola como `{{llm_response.*}}`.
--
-- SE CONSERVAN LOS MARCADORES DE ENTRADA. `buildInputText` omite de la materia
-- prima todo origen que el prompt ya cite, de modo que quitar
-- `{{parsed_email.clean_body}}` no ahorraria nada: duplicaria el correo dentro
-- del envio.
--
-- Idempotente por el filtro `texto_prompt NOT LIKE '%compiled_markup%'` (mismo
-- patron que la 024): reaplicarla no vuelve a escribir. Es una SEMILLA, no un
-- cambio de esquema, asi que NO se replica en `init.sql`.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' \
--     < db/migrations/029-prompt-licitaciones-plantilla-base.sql
-- =============================================================================

SET client_encoding = 'UTF8';

UPDATE plantillas_prompts_ia
   SET texto_prompt =
           'Eres un tecnico de contratacion administrativa publica de Madrid+D y maquetador del portal. Extrae los datos del expediente que aparece en el material de mas abajo y vuelcalos sobre la plantilla base.' || E'\n\n' ||
           'Datos que debes localizar:' || E'\n' ||
           '- expediente (codigo identificador)' || E'\n' ||
           '- objeto_contrato' || E'\n' ||
           '- presupuesto_base: base_imponible, iva y total' || E'\n' ||
           '- plazo_recepcion: fecha en formato ISO 8601 y hora' || E'\n' ||
           '- duracion_meses' || E'\n' ||
           '- enlace_consulta' || E'\n\n' ||
           'Reglas:' || E'\n' ||
           '- Un dato que no aparezca en el material se deja vacio. NUNCA lo estimes ni lo deduzcas.' || E'\n' ||
           '- Los importes van en euros, con punto decimal y sin separador de millares.' || E'\n\n' ||
           -- Se mantiene el reparto de la 023: el MAPEADOR_PLANTILLA interpola
           -- estas tres claves y el esquema las exige siempre.
           'Coloca el codigo de expediente en "headline", el objeto del contrato en "summary" y, en "body_paragraphs", una entrada por cada dato restante con el formato "campo: valor".' || E'\n\n' ||
           'Correo:' || E'\n' ||
           '{{parsed_email.clean_body}}' || E'\n\n' ||
           'Documentos adjuntos:' || E'\n' ||
           '{{parsed_email.extracted_documents_text}}' || E'\n\n' ||
           -- EL MARCADOR. Es lo unico de esta migracion que cambia el
           -- comportamiento del nodo: enciende `expectsFilledMarkup`.
           'PLANTILLA BASE:' || E'\n' ||
           '{{rendered_html.compiled_markup}}'
 WHERE codigo = 'LICITACION_DEFAULT'
   AND texto_prompt NOT LIKE '%compiled_markup%';

-- Comprobacion: una fila, activa, con el marcador presente. `tiene_plantilla`
-- en false significa que el UPDATE no caso —prompt renombrado o ya editado a
-- mano— y que el nodo seguira sin pedir markup.
SELECT codigo,
       activo,
       texto_prompt LIKE '%compiled_markup%' AS tiene_plantilla,
       length(texto_prompt)                  AS bytes_prompt
  FROM plantillas_prompts_ia
 WHERE codigo = 'LICITACION_DEFAULT';
