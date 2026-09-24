import { ASSETS_NAMESPACE, ASSETS_FIELDS } from '@/types/html-template';
import { DEFAULT_OUTPUT_NAMESPACE_BY_NODE_TYPE } from '@/types/pipeline';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

import type { NodeCatalogEntry } from '@/types/node-catalog';
import type { NodeType } from '@/types/pipeline';

// Helpers puros para componer un contexto de variables a partir de NOMBRES de
// namespace, sin topologia detras (`frontend-architecture.md` §2.1: sin estado
// ni E/S). El contexto de un flujo concreto lo construye `upstreamContext()` del
// agregador recorriendo el `pipeline_schema`; esto es para los consumidores que
// no tienen flujo —el gestor de plantillas— o que lo simulan —el banco de
// pruebas.

/**
 * Tipo de nodo que escribe cada namespace, invirtiendo el mapa de defectos.
 *
 * Es la UNICA inversion del proyecto, y esta aqui precisamente por eso. El TSDoc
 * de `UpstreamNamespace.nodeType` advierte contra invertir el mapa "en cada
 * consumidor": la relacion namespace -> tipo es una CONVENCION y no una regla,
 * porque un esquema puede declarar otro `outputNamespace`. La advertencia sigue
 * en pie y este helper no la contradice: cuando hay un flujo de verdad se usa su
 * topologia, que sabe que nodo escribe que namespace. Esto responde a la otra
 * pregunta, la de quien NO tiene flujo: "si alguien escribiera `parsed_email`,
 * que publicaria".
 *
 * Se deriva y no se escribe a mano por el motivo de siempre: una segunda tabla
 * discrepa de la primera en cuanto se anade un tipo de nodo.
 */
export const NODE_TYPE_BY_NAMESPACE: Readonly<Record<string, NodeType>> = Object.fromEntries(
  Object.entries(DEFAULT_OUTPUT_NAMESPACE_BY_NODE_TYPE).map(([nodeType, namespace]) => [
    namespace,
    nodeType as NodeType,
  ]),
);

/**
 * Contexto de variables equivalente a una lista de nombres de namespace.
 *
 * @param namespaces Nombres a resolver, en el orden en que se quieren ofrecer.
 * @param findByCode Busqueda en el catalogo, inyectada en vez de importada: asi
 *                   el helper no depende de Pinia y se prueba con una funcion de
 *                   dos lineas. Lo normal es pasar `nodeCatalogStore.findByCode`.
 *
 * Un namespace sin tipo de nodo asociado sale con `fields` vacio y SIN
 * `nodeType`, no se descarta: el consumidor debe poder mostrar que existe aunque
 * no se sepa que publica. Lo mismo si el catalogo aun no ha cargado — vacio
 * significa "no hay nada que ofrecer todavia", nunca un error.
 */
export const buildContextForNamespaces = (
  namespaces: readonly string[],
  findByCode: (code: string) => NodeCatalogEntry | null,
): UpstreamNamespace[] =>
  namespaces.map((namespace) => {
    // `_assets` no lo escribe ningun nodo, asi que el catalogo no sabe nada de
    // el: sus campos son los unicos que el frontend declara por su cuenta.
    if (namespace === ASSETS_NAMESPACE) {
      return { namespace, fields: ASSETS_FIELDS };
    }

    const nodeType = NODE_TYPE_BY_NAMESPACE[namespace];
    const entry = nodeType === undefined ? null : findByCode(nodeType);

    return {
      namespace,
      // La clave se OMITE en vez de asignarse `undefined`, que
      // `exactOptionalPropertyTypes` no admite en una propiedad opcional.
      ...(nodeType === undefined ? {} : { nodeType }),
      fields: entry?.outputFields ?? [],
    };
  });
