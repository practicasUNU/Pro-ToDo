import type {
  NodeType,
  PipelineNodeConfig,
  PipelineSchema,
} from '@core/fsm/types/pipeline-schema.types';

/**
 * Paso del pipeline en orden de ejecucion.
 *
 * Se declara aqui y no se importa de `@modules/workflows`: `@core` no puede
 * depender de un modulo funcional sin invertir la direccion de las capas. Es
 * estructuralmente identico a `PipelineStepDto`, asi que un arreglo de estos es
 * asignable a `PipelineStepDto[]` sin conversion.
 */
export interface OrderedPipelineStep {
  readonly nodeId: string;
  readonly nodeType: NodeType;
  readonly outputNamespace: string;
}

/**
 * Proyecta un `pipeline_schema` a la secuencia ORDENADA de sus nodos.
 *
 * Recorre el grafo desde `entrypoint` siguiendo `nextStep`. El orden NO puede
 * salir de `Object.values(schema.nodes)`: ese es un mapa indexado por `nodeId` y
 * su orden de claves es el de escritura del JSON, no el del camino de ejecucion.
 *
 * `visited` no es cosmetico: `validatePipelineTopology`
 * (`@core/fsm/validators/pipeline-topology.validator.ts`) ya garantiza que el
 * camino es aciclico y termina en un nodo terminal, pero solo para los esquemas
 * que pasaron por el. Una fila escrita por SQL directo se salta esa validacion,
 * y sin el `Set` un `nextStep` circular colgaria la peticion HTTP en un bucle
 * infinito.
 *
 * Un puntero huerfano —apunta a un nodo que no existe— corta el recorrido y
 * devuelve lo acumulado en vez de lanzar: es un esquema roto, pero el catalogo
 * debe seguir respondiendo para que el operador pueda verlo y arreglarlo.
 *
 * Funcion compartida por `WorkflowsService` y `WorkflowTemplatesService`: los
 * dos exponen la misma topologia proyectada, y duplicar el recorrido dejaria dos
 * lecturas del mismo grafo divergiendo en silencio.
 *
 * @param schema Grafo declarativo a proyectar.
 * @param onTruncated Se invoca con el `nodeId` huerfano si el recorrido se corta.
 *        El registro queda en manos del llamante, que es quien tiene contexto
 *        para decir si el esquema roto es de un flujo o de una plantilla.
 */
export const buildOrderedTopology = (
  schema: PipelineSchema,
  onTruncated?: (orphanNodeId: string) => void,
): OrderedPipelineStep[] => {
  const steps: OrderedPipelineStep[] = [];
  const visited = new Set<string>();

  let cursor: string | null = schema.entrypoint;

  while (cursor !== null && !visited.has(cursor)) {
    // Anotacion explicita obligada: `cursor` se reasigna desde `node.nextStep`,
    // asi que sin ella TypeScript entra en inferencia circular (TS7022).
    const node: PipelineNodeConfig | undefined = schema.nodes[cursor];

    if (node === undefined) {
      onTruncated?.(cursor);
      break;
    }

    visited.add(cursor);
    steps.push({
      nodeId: node.nodeId,
      nodeType: node.nodeType,
      outputNamespace: node.outputNamespace,
    });

    cursor = node.nextStep;
  }

  return steps;
};
