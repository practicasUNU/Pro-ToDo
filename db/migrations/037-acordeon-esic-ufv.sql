-- =============================================================================
-- Migracion 037 · El acordeon de ESIC se llama #accordionUFV
--
-- EL INCIDENTE. El nodo DESTINO_DRUPAL fallo con ERR_DRUPAL_DOM_TARGET al
-- publicar los comites de ESIC. El modelo escribia `data-parent="#accordionESIC"`
-- —obedeciendo a la tabla que la 035 metio en este mismo prompt— y ese
-- contenedor NO EXISTE en la pagina agregadora.
--
-- EL NOMBRE HEREDADO. El sub-acordeon de ESIC en el portal arrastra el
-- identificador `accordionUFV` de una version anterior de la pagina. ESIC y UFV
-- son el MISMO contenedor: no hay ninguna Universidad Francisco de Vitoria en el
-- agregador. Por eso esta migracion cambia UNICAMENTE el identificador del DOM y
-- deja intacto el nombre con el que el material de entrada designa al comite.
--
-- QUIEN LEA ESTO Y SIENTA LA TENTACION DE "CORREGIRLO" de vuelta a
-- `#accordionESIC`, que lo contraste antes contra el HTML real del nodo 55938.
-- Volver atras reproduce el incidente al pie de la letra: el panel se genera
-- bien formado, el ESCUDO_POST_IA lo aprueba, y `insertDispatchedPanels` aborta
-- la tanda COMPLETA —todo o nada— porque no encuentra donde colgarlo.
--
-- LA OTRA MITAD DEL CAMBIO VIVE EN TYPESCRIPT. El `data-parent` se decide por
-- precedencia: primero el que trae el panel (lo escribe el modelo leyendo esta
-- tabla) y, si no trae ninguno, el que deduce `resolveUniversityAccordion` del
-- catalogo `DRUPAL_UNIVERSITIES_CATALOG`. Son dos fuentes para la misma verdad y
-- el test `1bis.1` de `drupal-universities.spec.ts` las compara entre si, de modo
-- que esta migracion y aquel catalogo se aplican JUNTOS o el test se pone rojo.
--
-- DEPENDE DE LA 035, que es quien sembro la tabla de las catorce universidades.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' \
--     < db/migrations/037-acordeon-esic-ufv.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

-- -----------------------------------------------------------------------------
-- PASO UNICO · Reapuntar la fila de ESIC en la tabla de mapeo del prompt
--
-- REPLACE sobre la linea ENTERA del mapeo —con el nombre de la universidad
-- delante— y no sobre el token `#accordionESIC` suelto. El token tambien aparece
-- en los ejemplos de identificador de despliegue de la instruccion 1
-- (`href="#collapseESIC1"`), y un reemplazo global los arrastraria convirtiendo
-- un ejemplo correcto en uno incomprensible.
-- -----------------------------------------------------------------------------

UPDATE plantillas_prompts_ia
   SET texto_prompt = REPLACE(
           texto_prompt,
           '- ESIC Universidad: data-parent="#accordionESIC"',
           '- ESIC Universidad: data-parent="#accordionUFV"'
       ),
       actualizado_en = NOW()
 WHERE codigo = 'VERIFICADOR_TITULOS_DEFAULT'
   AND texto_prompt LIKE '%- ESIC Universidad: data-parent="#accordionESIC"%';

COMMIT;

-- =============================================================================
-- Comprobacion del resultado
--
-- `apunta_a_ufv` en false con `prompt_filas` a 1 significa que el REPLACE no
-- encontro la linea: o la 035 no se aplico, o alguien ya edito la tabla a mano.
--
-- Los centinelas `conserva_ceu`, `conserva_urjc` y `conserva_plantilla` vigilan
-- que el REPLACE no se haya llevado por delante nada mas. El ultimo es el mas
-- importante de los tres: `{{rendered_html.compiled_markup}}` es el marcador que
-- enciende `expectsFilledMarkup` en LlmExtractorStrategy, y sin el, el nodo
-- dejaria de pedir `filled_markup` y el ESCUDO_POST_IA se quedaria sin nada que
-- auditar.
--
-- `ejemplos_despliegue_intactos` confirma lo que razona el PASO UNICO: los
-- `collapseESIC1` de la instruccion 1 son ejemplos de identificador de panel,
-- no mapeos de acordeon, y deben seguir ahi.
-- =============================================================================

SELECT COUNT(*)                                                     AS prompt_filas,
       bool_and(texto_prompt LIKE '%- ESIC Universidad: data-parent="#accordionUFV"%') AS apunta_a_ufv,
       bool_and(texto_prompt NOT LIKE '%data-parent="#accordionESIC"%')               AS esic_corregido,
       bool_and(texto_prompt LIKE '%collapseESIC1%')                AS ejemplos_despliegue_intactos,
       bool_and(texto_prompt LIKE '%#accordionCEU%')                AS conserva_ceu,
       bool_and(texto_prompt LIKE '%#accordionURJC%')               AS conserva_urjc,
       bool_and(texto_prompt LIKE '%compiled_markup%')              AS conserva_plantilla
  FROM plantillas_prompts_ia
 WHERE codigo = 'VERIFICADOR_TITULOS_DEFAULT';
