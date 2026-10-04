-- =============================================================================
-- Migracion 025 · `MAPEADOR_PLANTILLA` pasa de interpolar a inyectar
--
-- QUE CAMBIA. Solo la `descripcion` de la fila del catalogo. Ni columnas, ni
-- indices, ni datos de flujo: el cambio real vive en `TemplateMapperStrategy`.
-- Lo que esta migracion arregla es que el catalogo siga anunciando un
-- comportamiento que el nodo ya no tiene.
--
-- POR QUE. Hasta ahora el nodo COMPILABA la plantilla con Handlebars contra el
-- contexto acumulado y era el ultimo paso del flujo. Desde este cambio es la IA
-- quien estructura e inyecta el contenido, asi que el mapeador se coloca DELANTE
-- del `PROCESADOR_IA` y su trabajo es otro: resolver la plantilla del gestor,
-- sanearla con la lista blanca compartida y verificar que conserva los
-- selectores que el flujo da por hechos (`requiredSelectors`).
--
-- La descripcion no es cosmetica: `NodeCatalogService` la sirve tal cual en
-- `GET /api/nodos`, que es lo que el asistente muestra al operador cuando elige
-- el tipo de nodo. Dejarla como estaba significaba ofrecer "interpola variables
-- dinamicas" junto a un nodo que falla con `ERR_TEMPLATE_PENDING_VARS` en cuanto
-- la plantilla trae una sola variable.
--
-- SOBRE `compiled_markup`. La clave de salida CONSERVA su nombre pese a contener
-- ahora markup sin compilar. Es una concesion deliberada a la compatibilidad:
-- renombrarla dejaria sin dato a todo consumidor de
-- `rendered_html.compiled_markup`, incluido el `DESTINO_HTTP` de cualquier flujo
-- ya guardado. Quien audite una ejecucion lo distingue por la `description` del
-- `outputField`, que si lo dice de forma explicita.
--
-- IDEMPOTENTE. Un `UPDATE` sobre una clave unica se puede repetir sin efecto.
--
-- NOTA: `db/migrations/005-tipos-nodo-fsm.sql` NO se toca. Una migracion ya
-- aplicada es historia; el texto nuevo va aqui y en `init.sql`, que es la foto
-- del esquema para una base limpia. Mantener los dos en sincronia es lo que ya
-- advertian las migraciones 013 y 022.
-- =============================================================================

UPDATE nodos
   SET descripcion = 'Inyecta una plantilla HTML del gestor, ya saneada y sin interpolar, para que un PROCESADOR_IA posterior la rellene. Verifica que conserva los selectores estructurales exigidos.'
 WHERE codigo = 'MAPEADOR_PLANTILLA';

-- Comprobacion del resultado.
SELECT codigo, nombre, descripcion
  FROM nodos
 WHERE codigo = 'MAPEADOR_PLANTILLA';
