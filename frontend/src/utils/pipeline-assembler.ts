import type { AssembledPipelineNode, AssembledPipelineSchema, NodeType } from '@/types/pipeline';

// Helper puro (frontend-architecture.md §2.1): transforma un dato en otro, sin
// estado ni I/O.
//
// Vive aqui y no dentro de un store porque tiene DOS anfitriones con el mismo
// problema: el asistente de flujos (`flujo-draft.store.ts`), que ensambla desde
// una topologia de plantilla, y el editor de plantillas
// (`workflow-templates.store.ts`), que ensambla desde la secuencia que el
// operador compone a mano. Dos copias de este encadenado divergirian en cuanto
// una de las dos vistas cambiase, y el sintoma seria un grafo que el validador
// rechaza solo desde una de ellas.

/** SemVer inicial de todo esquema ensamblado por el cliente. */
export const INITIAL_SCHEMA_VERSION = '1.0.0';

/**
 * Paso ya resuelto: identidad, tipo, namespace y `params`.
 *
 * Los `params` llegan RESUELTOS y no como referencia a un store: quien conoce el
 * contrato de cada nodo es su propio store (§3.1), asi que el anfitrion los pide
 * con `toNodeParams()` antes de llamar aqui. Este helper no resuelve stores ni
 * inspecciona configuraciones internas.
 */
export interface AssemblerStep {
  readonly nodeId: string;
  readonly nodeType: NodeType;
  readonly outputNamespace: string;
  readonly params: Record<string, unknown>;
}

/** Metadatos del esquema que no salen de la secuencia de pasos. */
export interface AssemblerMeta {
  readonly flowId: string;
  readonly name: string;
  readonly version?: string;
}

/**
 * Encadena una secuencia ORDENADA de pasos en un `pipeline_schema`.
 *
 * El orden del arreglo ES la topologia: `nextStep` es el `nodeId` del elemento
 * siguiente y `null` en el ultimo, y `entrypoint` es el primero. No se recorre
 * ningun grafo aqui —eso lo hace el backend al devolver `topology`, o el propio
 * operador al reordenar la lista.
 *
 * `onErrorStep` queda en `null` en todos los nodos: ninguna vista ofrece todavia
 * configurar caminos de recuperacion, y un puntero inventado seria peor que su
 * ausencia —con `null` el motor detiene la ejecucion en el nodo que falla, que
 * es el comportamiento correcto por defecto.
 *
 * Una secuencia VACIA produce un esquema con `entrypoint: ''` y `nodes: {}` en
 * vez de lanzar: es el estado legitimo de un borrador recien abierto, y quien
 * decide si eso se puede guardar es el backend, no este helper.
 *
 * @param steps Pasos en orden de ejecucion.
 * @param meta `flowId`, `name` y, opcionalmente, la version del esquema.
 */
export const assemblePipelineSchema = (
  steps: readonly AssemblerStep[],
  meta: AssemblerMeta,
): AssembledPipelineSchema => {
  const nodes: Record<string, AssembledPipelineNode> = {};

  steps.forEach((step, index) => {
    nodes[step.nodeId] = {
      nodeId: step.nodeId,
      nodeType: step.nodeType,
      outputNamespace: step.outputNamespace,
      nextStep: steps[index + 1]?.nodeId ?? null,
      onErrorStep: null,
      params: step.params,
    };
  });

  return {
    flowId: meta.flowId,
    name: meta.name,
    version: meta.version ?? INITIAL_SCHEMA_VERSION,
    entrypoint: steps[0]?.nodeId ?? '',
    nodes,
  };
};

/**
 * Recorre un esquema desde `entrypoint` y devuelve sus pasos EN ORDEN.
 *
 * Es la inversa de `assemblePipelineSchema`, y existe para que el editor de
 * plantillas pueda abrir un grafo ya guardado con su secuencia poblada: sin
 * esto, editar una plantilla existente mostraria el selector vacio junto a un
 * JSON lleno.
 *
 * Se protege de los ciclos con un conjunto de visitados en vez de confiar en que
 * el grafo sea acíclico: el JSON es editable a mano, asi que puede llegar aqui
 * con un `nextStep` que apunte hacia atras, y un bucle infinito colgaria la
 * pestana sin ningun mensaje. Un puntero huerfano trunca el recorrido, que es la
 * misma politica que `buildOrderedTopology` aplica en el backend.
 */
export const disassemblePipelineSchema = (schema: AssembledPipelineSchema): AssemblerStep[] => {
  const steps: AssemblerStep[] = [];
  const visited = new Set<string>();

  let cursor: string | null = schema.entrypoint;

  while (cursor !== null && cursor !== '' && !visited.has(cursor)) {
    const node: AssembledPipelineNode | undefined = schema.nodes[cursor];

    if (node === undefined) break;

    visited.add(cursor);
    steps.push({
      nodeId: node.nodeId,
      nodeType: node.nodeType,
      outputNamespace: node.outputNamespace,
      params: node.params,
    });

    cursor = node.nextStep;
  }

  return steps;
};
