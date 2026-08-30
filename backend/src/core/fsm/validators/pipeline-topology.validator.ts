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

/** Punteros de un nodo que deben resolver contra el mapa `nodes`. */
const NODE_POINTERS = ['nextStep', 'onErrorStep'] as const;

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
 * 4. Ningun `outputNamespace` se repite: dos nodos escribiendo en el mismo
 *    namespace romperian la inmutabilidad del `StatePayloadContext`.
 * 5. El camino activo desde `entrypoint` siguiendo `nextStep` termina en un nodo
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

  // 2, 3 y 4. Recorrido del mapa completo, nodo a nodo.
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

    for (const pointer of NODE_POINTERS) {
      const target = node[pointer];

      if (target !== null && !hasNode(schema, target)) {
        issues.push({
          field: `nodes.${key}.${pointer}`,
          constraints: [
            `${pointer} apunta a "${target}", que no existe en el mapa de nodos.`,
          ],
        });
      }
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
