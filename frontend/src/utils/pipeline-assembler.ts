import type {
  AssembledPipelineNode,
  AssembledPipelineSchema,
  NodeType,
  PipelineExecutionPolicy,
  SelectiveErrorFallback,
} from '@/types/pipeline';

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
 * Nodo destino de una ruta de error, sea cual sea su forma.
 *
 * Replica de `declaredErrorTarget` del backend, y por el mismo motivo por el que
 * alli existe: la union tiene tres formas y ningun consumidor debe inspeccionarla
 * por su cuenta. Responde "a donde apunta", no "que codigos atrapa".
 */
export const errorRouteTarget = (
  route: string | SelectiveErrorFallback | null | undefined,
): string | null => {
  if (typeof route === 'string') return route;

  return typeof route === 'object' && route !== null ? route.targetNode : null;
};

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
  /**
   * Ruta de contingencia del paso. Ausente equivale a `null`.
   *
   * Viaja en el paso y no en los metadatos porque es propiedad del NODO: dos
   * pasos del mismo flujo pueden desviarse a sitios distintos, o solo uno de
   * ellos declarar rama.
   *
   * Que este campo exista es lo que impide que un round-trip destruya el dato.
   * Antes `disassemblePipelineSchema` no lo devolvia y `assemblePipelineSchema`
   * lo reescribia a `null`, de modo que abrir una plantilla con una ruta escrita
   * a mano en el panel JSON y volver a guardarla la borraba en silencio.
   */
  readonly onErrorStep?: string | SelectiveErrorFallback | null;
  /**
   * Solo para SATELITES: a donde devuelven el flujo, o `null` si son terminales.
   *
   * Los pasos del camino activo lo ignoran —su `nextStep` sale del ORDEN del
   * arreglo, que es la topologia— pero un satelite no esta en ese arreglo y
   * necesita decirlo por su cuenta. La alerta es terminal; la transcripcion
   * reincorpora el flujo al curso que llevaba el paso que fallo.
   */
  readonly nextStep?: string | null;
}

/** Metadatos del esquema que no salen de la secuencia de pasos. */
export interface AssemblerMeta {
  readonly flowId: string;
  readonly name: string;
  readonly version?: string;
  /**
   * Politica del flujo completo.
   *
   * Va en los metadatos y no en los pasos porque NO se deriva de la secuencia:
   * es una decision del operador que debe sobrevivir a que reordene los nodos.
   * Quien reensambla el esquema tras un cambio de secuencia esta obligado a
   * reenviarla aqui, o se borraria en silencio al tocar el selector.
   */
  readonly executionPolicy?: PipelineExecutionPolicy;
}

/**
 * Encadena una secuencia ORDENADA de pasos en un `pipeline_schema`.
 *
 * El orden del arreglo ES la topologia: `nextStep` es el `nodeId` del elemento
 * siguiente y `null` en el ultimo, y `entrypoint` es el primero. No se recorre
 * ningun grafo aqui —eso lo hace el backend al devolver `topology`, o el propio
 * operador al reordenar la lista.
 *
 * `onErrorStep` sale de cada paso, y cada una de sus TRES formas significa algo
 * distinto: la cadena es el respaldo incondicional —la unica que atrapa
 * cualquier codigo—, el objeto selectivo desvia solo ante los codigos que
 * nombra, y `null` detiene la ejecucion en el nodo que falla, que es el defecto
 * correcto de un paso sin rama declarada.
 *
 * Los SATELITES van aparte de la secuencia y no al final del arreglo. El
 * encadenado es posicional, asi que un nodo de alerta metido entre los pasos
 * heredaria un `nextStep` y acabaria en el camino feliz, ejecutandose en cada
 * pasada en vez de solo cuando algo falla. Su `nextStep` lo declara cada
 * satelite: `null` en la alerta, que es terminal, y el del paso que fallo en la
 * transcripcion, que devuelve el flujo a su curso.
 *
 * Una secuencia VACIA produce un esquema con `entrypoint: ''` y `nodes: {}` en
 * vez de lanzar: es el estado legitimo de un borrador recien abierto, y quien
 * decide si eso se puede guardar es el backend, no este helper.
 *
 * @param steps Pasos en orden de ejecucion.
 * @param meta `flowId`, `name` y, opcionalmente, la version del esquema.
 * @param satellites Nodos alcanzables SOLO por una ruta de error.
 */
export const assemblePipelineSchema = (
  steps: readonly AssemblerStep[],
  meta: AssemblerMeta,
  satellites: readonly AssemblerStep[] = [],
): AssembledPipelineSchema => {
  const nodes: Record<string, AssembledPipelineNode> = {};

  steps.forEach((step, index) => {
    nodes[step.nodeId] = {
      nodeId: step.nodeId,
      nodeType: step.nodeType,
      outputNamespace: step.outputNamespace,
      nextStep: steps[index + 1]?.nodeId ?? null,
      onErrorStep: step.onErrorStep ?? null,
      params: step.params,
    };
  });

  // Despues de los pasos y no antes: si un satelite compartiera `nodeId` con un
  // paso del camino activo, debe ganar el paso. Sobrescribir el nodo real por
  // uno terminal partiria el flujo en dos sin ningun aviso.
  satellites.forEach((satellite) => {
    if (nodes[satellite.nodeId] !== undefined) return;

    nodes[satellite.nodeId] = {
      nodeId: satellite.nodeId,
      nodeType: satellite.nodeType,
      outputNamespace: satellite.outputNamespace,
      // Ya no es `null` a ciegas: hay dos clases de satelite. El de alerta sigue
      // siendo terminal; el de transcripcion devuelve el flujo a su curso, y
      // forzarle un `null` aqui lo dejaria muerto justo despues del rescate.
      nextStep: satellite.nextStep ?? null,
      onErrorStep: satellite.onErrorStep ?? null,
      params: satellite.params,
    };
  });

  return {
    flowId: meta.flowId,
    name: meta.name,
    version: meta.version ?? INITIAL_SCHEMA_VERSION,
    entrypoint: steps[0]?.nodeId ?? '',
    nodes,
    // Se OMITE la clave cuando no hay politica en vez de emitir un objeto
    // vacio: el backend valida con `forbidNonWhitelisted` y un `{}` seria una
    // declaracion de "no hay politica" indistinguible de una a medio escribir.
    ...(meta.executionPolicy !== undefined ? { executionPolicy: meta.executionPolicy } : {}),
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
      onErrorStep: node.onErrorStep,
    });

    cursor = node.nextStep;
  }

  return steps;
};

/**
 * Nodos a los que solo se llega por una ruta de error.
 *
 * El recorrido de `disassemblePipelineSchema` sigue unicamente `nextStep`, asi
 * que un nodo de alerta no aparece en sus pasos. Sin esta funcion se perderia al
 * reensamblar: el esquema saldria con las rutas apuntando a un `targetNode` que
 * ya no existe en el mapa, y el backend lo rechazaria con la regla 3.
 *
 * Va SEPARADA del desensamblador en vez de cambiarle la firma para no obligar al
 * editor de plantillas —su otro consumidor— a desempaquetar algo que no usa.
 *
 * Se resuelve por DIFERENCIA con el camino activo y no persiguiendo cada
 * `onErrorStep`: una ruta puede apuntar hacia atras, a un nodo que ya esta en la
 * secuencia, y ese no es un satelite sino un reintento por otro camino.
 *
 * @param schema Grafo completo.
 * @param activeSteps Lo que devolvio `disassemblePipelineSchema` sobre el mismo.
 */
export const collectErrorSatellites = (
  schema: AssembledPipelineSchema,
  activeSteps: readonly AssemblerStep[],
): AssemblerStep[] => {
  const inActivePath = new Set(activeSteps.map((step) => step.nodeId));
  const referenced = new Set<string>();

  for (const node of Object.values(schema.nodes)) {
    const target = errorRouteTarget(node.onErrorStep);

    if (target !== null && !inActivePath.has(target)) {
      referenced.add(target);
    }
  }

  return [...referenced].flatMap((nodeId) => {
    const node = schema.nodes[nodeId];

    // Una ruta que apunta fuera del mapa es un esquema roto, y lo reporta el
    // backend con su regla 3. Aqui se omite en vez de inventar un nodo.
    if (node === undefined) return [];

    return [
      {
        nodeId: node.nodeId,
        nodeType: node.nodeType,
        outputNamespace: node.outputNamespace,
        params: node.params,
        onErrorStep: node.onErrorStep,
        // Se RECUPERA del grafo: sin esto, un satelite que reincorporaba el
        // flujo salia terminal del primer round-trip y el rescate dejaba de
        // publicar nada.
        nextStep: node.nextStep,
      },
    ];
  });
};
