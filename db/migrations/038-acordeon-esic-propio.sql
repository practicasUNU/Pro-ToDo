-- =============================================================================
-- Migracion 038 · ESIC recupera su propio acordeon
--
-- REVIERTE LA 037, y conviene saber por que para no volver a aplicarla.
--
-- La 037 apunto ESIC a `#accordionUFV` sobre una premisa que se comprobo falsa:
-- que el agregador no tenia ninguna Universidad Francisco de Vitoria y que
-- `accordionUFV` era un identificador heredado del propio panel de ESIC. La
-- lectura del DOM de la pagina desmiente las dos cosas. Francisco de Vitoria
-- ESTA publicada —oculta con `d-none`, la decimocuarta del acordeon raiz, con su
-- propio comite `UFV D1`— y es una universidad DISTINTA de ESIC.
--
-- La consecuencia observada: los comites `ESIC 2` acabaron publicados dentro del
-- acordeon de Francisco de Vitoria, que es el error de destino que todo este
-- despacho jerarquico existe para evitar. Y seguiria pasando con cada comite de
-- ESIC que entrase por el flujo.
--
-- ESIC vuelve por tanto a `#accordionESIC`, como las otras trece. El panel de
-- primer nivel de ESIC se repone en la propia pagina desde el script de limpieza
-- (`UNIVERSITY_PANELS_TO_RESTORE` en `cleanup-drupal-sandbox.ts`), con ese mismo
-- identificador: las dos mitades tienen que decir lo mismo o el comite vuelve a
-- quedarse sin destino.
--
-- LA OTRA MITAD DEL CAMBIO VIVE EN TYPESCRIPT, en el catalogo
-- `DRUPAL_UNIVERSITIES_CATALOG`. El test `1bis.1` de `drupal-universities.spec.ts`
-- compone el prompt recorriendo estas migraciones y lo compara con el catalogo,
-- de modo que esta migracion y aquel fichero se aplican JUNTOS o el test se pone
-- rojo.
--
-- DEPENDE DE LA 035, que sembro la tabla, y de la 037, cuyo valor sustituye.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
--     < db/migrations/038-acordeon-esic-propio.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

-- -----------------------------------------------------------------------------
-- PASO UNICO · Devolver la fila de ESIC a su propio acordeon
--
-- REPLACE sobre la linea ENTERA del mapeo, por el mismo motivo que razonaba la
-- 037: el token suelto aparece tambien en los ejemplos de identificador de
-- despliegue de la instruccion 1, y un reemplazo global los arrastraria.
-- -----------------------------------------------------------------------------

UPDATE plantillas_prompts_ia
   SET texto_prompt = REPLACE(
           texto_prompt,
           '- ESIC Universidad: data-parent="#accordionUFV"',
           '- ESIC Universidad: data-parent="#accordionESIC"'
       ),
       actualizado_en = NOW()
 WHERE codigo = 'VERIFICADOR_TITULOS_DEFAULT'
   AND texto_prompt LIKE '%- ESIC Universidad: data-parent="#accordionUFV"%';

COMMIT;

-- =============================================================================
-- Comprobacion del resultado
--
-- `sin_ufv_en_el_mapeo` vigila que ninguna universidad quede apuntando a
-- `#accordionUFV`. Hoy Francisco de Vitoria NO figura en la tabla del prompt
-- —son las catorce que la 035 sembro, y UFV no estaba entre ellas—, de modo que
-- cualquier aparicion de ese acordeon aqui seria un ESIC mal dirigido otra vez.
-- =============================================================================

SELECT COUNT(*)                                                     AS prompt_filas,
       bool_and(texto_prompt LIKE '%- ESIC Universidad: data-parent="#accordionESIC"%') AS esic_en_su_acordeon,
       bool_and(texto_prompt NOT LIKE '%#accordionUFV%')            AS sin_ufv_en_el_mapeo,
       bool_and(texto_prompt LIKE '%collapseESIC1%')                AS ejemplos_despliegue_intactos,
       bool_and(texto_prompt LIKE '%#accordionURJC%')               AS conserva_mapeo,
       bool_and(texto_prompt LIKE '%compiled_markup%')              AS conserva_plantilla
  FROM plantillas_prompts_ia
 WHERE codigo = 'VERIFICADOR_TITULOS_DEFAULT';
