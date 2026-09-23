import { declaredErrorTarget } from '@core/fsm/utils/pipeline-topology.util';
import {
  NODE_OUTPUT_NAMESPACE_SET,
  NODE_OUTPUT_NAMESPACES,
} from '@core/fsm/types/pipeline-schema.types';

import type {
  PipelineNodeConfigDto,
  PipelineSchemaDto,
} from '@core/fsm/dto/pipeline-schema.dto';

/**
 * Resuelve los namespaces que un nodo necesita para poder ejecutarse.
 *
 * Se recibe como PARAMETRO y no se importa: este validador es una funcion pura y
 * debe seguir siendolo. Quien conoce las estrategias es
 * `PipelineValidatorService`, que si es un provider y puede inyectar la
 * factoria; pasarselo aqui deja la regla comprobable con un doble de una linea y
 * evita que un validador de topologia acabe dependiendo del contenedor de Nest.
 */
export type NodeDependencyResolver = (
  node: PipelineNodeConfigDto,
) => readonly string[];

/**
 * Campo invalido detectado durante la validacion de un `pipeline_schema`.
 *
 * `field` usa notacion con punto para que el cliente pueda senalar el control
 * exacto del wizard (ej. `nodes.nodo_ia.retryPolicy.maxRetries`).
 */
export interface SchemaIssue {
  field: string;
  constraints: string[];
}

// `nextStep` y `onErrorStep` ya no se pueden recorrer con un bucle comun: el
// primero es un `string | null` directo y el segundo admite ademas la forma
// selectiva `{ targetNode, catchErrors }`. Quien conoce esa union es
// `declaredErrorTarget`, y este validador le pregunta en vez de inspeccionarla.

/** Comprueba la pertenencia a `nodes` sin heredar claves de `Object.prototype`. */
const hasNode = (schema: PipelineSchemaDto, nodeId: string): boolean =>
  Object.hasOwn(schema.nodes, nodeId);

/**
 * Valida la integridad del grafo declarado en el pipeline.
 *
 * Se ejecuta solo cuando la forma y los tipos ya son validos: con un `nextStep`
 * numerico o un `nodes` que no es un objeto, estas comprobaciones solo generarian
 * ruido sobre el error real.
 *
 * Reglas aplicadas:
 * 1. `entrypoint` existe en `nodes`.
 * 2. La clave del mapa coincide con el `nodeId` del nodo (evita que mapa y nodo
 *    se desincronicen: el motor indexa por clave y la estrategia lee `nodeId`).
 * 3. Todo `nextStep` / `onErrorStep` no nulo resuelve a un nodo existente.
 * 4. Todo `outputNamespace` pertenece a `NODE_OUTPUT_NAMESPACES`. El formato ya
 *    lo comprueba el DTO; aqui se comprueba la PERTENENCIA, porque un namespace
 *    bien formado pero desconocido pasaria el esquema y solo reventaria despues,
 *    al guardar una plantilla que lo interpola.
 * 5. Ningun `outputNamespace` se repite: dos nodos escribiendo en el mismo
 *    namespace romperian la inmutabilidad del `StatePayloadContext`.
 * 6. El camino activo desde `entrypoint` siguiendo `nextStep` termina en un nodo
 *    terminal (`nextStep === null`) sin revisitar ninguno.
 * 7. Todo namespace que un nodo del camino activo declara necesitar lo escribe
 *    algun nodo ANTERIOR de ese mismo camino. Solo se aplica si se recibe el
 *    `resolveDependencies`, y es lo que convierte un flujo mal ordenado en un
 *    400 al guardar en vez de una ejecucion PAUSADA en produccion.
 *
 * Los nodos inalcanzables desde `entrypoint` se ignoran deliberadamente: un flujo
 * puede conservar ramas en construccion sin que eso invalide el esquema.
 * `onErrorStep` queda fuera del recorrido porque apuntar hacia atras es el patron
 * legitimo de reintento o recuperacion.
 *
 * @param schema Esquema con forma y tipos ya validados.
 * @param resolveDependencies Namespaces requeridos por nodo. Omitirlo desactiva
 *                            la regla 7, que es lo que hacen las pruebas de las
 *                            otras seis.
 * @returns Lista de incidencias; vacia si el grafo es integro.
 */
export const validatePipelineTopology = (
  schema: PipelineSchemaDto,
  resolveDependencies?: NodeDependencyResolver,
): SchemaIssue[] => {
  const issues: SchemaIssue[] = [];

  // 1. El camino activo necesita un punto de partida real.
  if (!hasNode(schema, schema.entrypoint)) {
    issues.push({
      field: 'entrypoint',
      constraints: [
        `El entrypoint "${schema.entrypoint}" no existe en el mapa de nodos.`,
      ],
    });
  }

  // 2, 3, 4 y 5. Recorrido del mapa completo, nodo a nodo.
  const namespaceOwners = new Map<string, string>();

  for (const [key, node] of Object.entries(schema.nodes)) {
    if (node.nodeId !== key) {
      issues.push({
        field: `nodes.${key}.nodeId`,
        constraints: [
          `La clave del mapa "${key}" no coincide con el nodeId "${node.nodeId}".`,
        ],
      });
    }

    if (node.nextStep !== null && !hasNode(schema, node.nextStep)) {
      issues.push({
        field: `nodes.${key}.nextStep`,
        constraints: [
          `nextStep apunta a "${node.nextStep}", que no existe en el mapa de nodos.`,
        ],
      });
    }

    // Se valida el destino DECLARADO y no el efectivo: que la ruta atrape unos
    // codigos u otros es indiferente aqui, porque apuntar a un nodo inexistente
    // rompe el esquema aunque ese codigo no llegue a ocurrir nunca.
    const errorTarget = declaredErrorTarget(node.onErrorStep);

    if (errorTarget !== null && !hasNode(schema, errorTarget)) {
      issues.push({
        field: `nodes.${key}.onErrorStep`,
        constraints: [
          `onErrorStep apunta a "${errorTarget}", que no existe en el mapa de nodos.`,
        ],
      });
    }

    if (!NODE_OUTPUT_NAMESPACE_SET.has(node.outputNamespace)) {
      issues.push({
        field: `nodes.${key}.outputNamespace`,
        constraints: [
          `El namespace "${node.outputNamespace}" no esta permitido. Solo se admiten: ${NODE_OUTPUT_NAMESPACES.join(', ')}.`,
        ],
      });
    }

    const owner = namespaceOwners.get(node.outputNamespace);

    if (owner === undefined) {
      namespaceOwners.set(node.outputNamespace, key);
      continue;
    }

    issues.push({
      field: `nodes.${key}.outputNamespace`,
      constraints: [
        `El namespace "${node.outputNamespace}" ya lo escribe el nodo "${owner}".`,
      ],
    });
  }

  issues.push(...detectActivePathCycle(schema));

  if (resolveDependencies !== undefined) {
    issues.push(...detectUnreachableNamespaces(schema, resolveDependencies));
  }

  return issues;
};

/**
 * Namespaces que el motor siembra por su cuenta y que ningun nodo declara.
 *
 * `trigger` lo escribe el motor con el `initialPayload` al crear la ejecucion, y
 * `_assets` lo inyecta el renderizador de plantillas. Exigir que algun nodo los
 * produzca los haria irresolubles por construccion.
 */
const ENGINE_PROVIDED_NAMESPACES: ReadonlySet<string> = new Set([
  'trigger',
  '_assets',
]);

/**
 * Comprueba que cada nodo del camino activo encuentre lo que necesita.
 *
 * Recorre `entrypoint -> nextStep` acumulando los `outputNamespace` ya escritos,
 * de modo que un nodo solo puede depender de lo que producen sus PREDECESORES.
 * Es la misma pregunta que la guarda del motor responde en ejecucion, adelantada
 * al momento de guardar.
 *
 * DOS ACOTACIONES DELIBERADAS, ambas para no rechazar flujos validos:
 *
 * 1. Solo el camino activo. Un nodo al que solo se llega por `onErrorStep` tiene
 *    un conjunto de predecesores distinto segun por donde se entre, y afirmar
 *    algo sobre el aqui seria adivinar. Esos nodos quedan cubiertos por la
 *    guarda del motor, que si sabe que contexto hay de verdad.
 * 2. Se para en seco si un puntero no resuelve o si el camino cicla. Los dos
 *    fallos ya los reportan las reglas 3 y 6, y duplicarlos anadiria ruido sobre
 *    el error real.
 */
const detectUnreachableNamespaces = (
  schema: PipelineSchemaDto,
  resolveDependencies: NodeDependencyResolver,
): SchemaIssue[] => {
  const issues: SchemaIssue[] = [];
  const produced = new Set<string>();
  const visited = new Set<string>();
  let cursor: string | null = schema.entrypoint;

  while (cursor !== null) {
    if (!hasNode(schema, cursor) || visited.has(cursor)) {
      break;
    }

    visited.add(cursor);

    const node: PipelineNodeConfigDto = schema.nodes[cursor];
    const missing = resolveDependencies(node).filter(
      (namespace) =>
        !ENGINE_PROVIDED_NAMESPACES.has(namespace) && !produced.has(namespace),
    );

    if (missing.length > 0) {
      issues.push({
        field: `nodes.${node.nodeId}.params`,
        constraints: [
          `El nodo necesita los namespaces [${missing.join(', ')}], que ningun paso anterior del flujo escribe. Reordena el flujo o anade el nodo que los produce.`,
        ],
      });
    }

    produced.add(node.outputNamespace);
    cursor = node.nextStep;
  }

  return issues;
};

/**
 * Recorre el camino activo desde `entrypoint` en busca de un ciclo.
 *
 * El grafo de `nextStep` es funcional (cada nodo tiene como mucho un sucesor),
 * asi que basta un recorrido lineal con un `Set` de visitados: no hace falta DFS
 * ni deteccion de componentes fuertemente conexas.
 *
 * Se detiene en silencio si un puntero no resuelve; ese fallo ya lo reportan las
 * reglas 1 y 3 y duplicarlo solo anadiria ruido.
 */
const detectActivePathCycle = (schema: PipelineSchemaDto): SchemaIssue[] => {
  const visited = new Set<string>();
  const path: string[] = [];
  let cursor: string | null = schema.entrypoint;

  while (cursor !== null) {
    if (!hasNode(schema, cursor)) {
      return [];
    }

    if (visited.has(cursor)) {
      const lastNode = path[path.length - 1];

      return [
        {
          field: `nodes.${lastNode}.nextStep`,
          constraints: [
            `El camino activo forma un ciclo infinito: ${[...path, cursor].join(' -> ')}.`,
          ],
        },
      ];
    }

    visited.add(cursor);
    path.push(cursor);
    cursor = schema.nodes[cursor].nextStep;
  }

  return [];
};
