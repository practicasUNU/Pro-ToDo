-- =============================================================================
-- Migracion 020 · Eliminar `nodos.ui_schema` (PROT-15.1)
--
-- La columna nacio en la migracion 011 con una promesa concreta: seria el
-- contrato DECLARATIVO del formulario que el frontend pintaria para configurar
-- cada tipo de nodo, de modo que anadir un nodo nuevo fuese una fila de SQL y
-- no codigo Vue. La 013 llego a rellenarla para TRIGGER_CRON como prueba.
--
-- La promesa no se cumplio y hoy estorba. Las nueve filas del catalogo siguen
-- con `'{}'` salvo aquella prueba, y el formulario real lo resuelve el
-- frontend con componentes TIPADOS, uno por tipo de nodo, a traves del
-- registro `node-config-registry.ts` (`frontend-quasar.md` §3.1). Ese registro
-- es lo que permite que un `TemplateMapperConfig.vue` valide con TypeScript lo
-- que un renderizador generico dirigido por JSONB solo podria comprobar en
-- tiempo de ejecucion.
--
-- POR QUE BORRARLA EN LUGAR DE DEJARLA VACIA: una columna que dice ser la
-- fuente de verdad de la UI y no lo es acaba siendo usada por alguien. A
-- partir de ahi el formulario de un nodo se define en DOS sitios —la fila y el
-- componente— y las dos definiciones se desincronizan en la primera
-- modificacion. El mismo argumento por el que los contratos de SALIDA de un
-- nodo viven en `outputFields` de su `INodeStrategy` y no en un jsonb.
--
-- ALTERNATIVA DESCARTADA: conservarla como campo libre de metadatos de la UI.
-- No hay ningun consumidor que la pida, y `nodos` es un catalogo estatico de
-- nueve filas: cuando aparezca esa necesidad se anade la columna que la
-- necesidad describa, no una generica por si acaso.
--
-- ALCANCE EN EL MISMO COMMIT: la propiedad `uiSchema` desaparece tambien de la
-- entidad `NodeCatalogEntry`, de `NodeCatalogResponseDto`, de
-- `NodeCatalogService` y del tipo `NodeCatalogEntry` del frontend. Dejar el DTO
-- prometiendo un campo que la entidad ya no tiene devolveria `undefined` por
-- `GET /api/nodos` con el tipo afirmando lo contrario.
--
-- `init.sql` se actualiza en el mismo commit: ese archivo solo se ejecuta con el
-- volumen de Docker vacio, asi que sin la copia una base de datos nueva naceria
-- otra vez con esta columna. Se retira de su CREATE TABLE y tambien el UPDATE
-- que la migracion 013 dejo sembrado para TRIGGER_CRON.
--
-- Es idempotente: `DROP COLUMN IF EXISTS` se puede reaplicar sin efectos
-- secundarios.
--
-- Aplicar con:
--   sudo docker exec -i protodo_postgres psql -U '<usuario_postgres>' -d '<nombre_bd_desarrollo>' \
--     < db/migrations/020-eliminar-ui-schema-nodos.sql
-- =============================================================================

SET client_encoding = 'UTF8';

BEGIN;

ALTER TABLE nodos
    DROP COLUMN IF EXISTS ui_schema;

COMMIT;

-- =============================================================================
-- Comprobacion del resultado
-- =============================================================================

-- El listado debe mostrar CINCO columnas y ninguna llamada `ui_schema`:
-- id_nodo, codigo, nombre, categoria, descripcion.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'nodos'
 ORDER BY ordinal_position;

-- Cero filas confirma que la columna ya no existe.
SELECT column_name
  FROM information_schema.columns
 WHERE table_name = 'nodos'
   AND column_name = 'ui_schema';
