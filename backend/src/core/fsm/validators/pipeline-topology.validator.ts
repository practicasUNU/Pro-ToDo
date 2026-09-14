import { declaredErrorTarget } from '@core/fsm/utils/pipeline-topology.util';
import {
  NODE_OUTPUT_NAMESPACE_SET,
  NODE_OUTPUT_NAMESPACES,
} from '@core/fsm/types/pipeline-schema.types';

import type { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';

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
 *
 * Los nodos inalcanzables desde `entrypoint` se ignoran deliberadamente: un flujo
 * puede conservar ramas en construccion sin que eso invalide el esquema.
 * `onErrorStep` queda fuera del recorrido porque apuntar hacia atras es el patron
 * legitimo de reintento o recuperacion.
 *
 * @param schema Esquema con forma y tipos ya validados.
 * @returns Lista de incidencias; vacia si el grafo es integro.
 */
export const validatePipelineTopology = (
  schema: PipelineSchemaDto,
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
