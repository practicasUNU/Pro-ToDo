import type {
  NodeType,
  PipelineNodeConfig,
  PipelineSchema,
  SelectiveErrorFallback,
} from '@core/fsm/types/pipeline-schema.types';

/** Las dos formas que admite `PipelineNodeConfig.onErrorStep`, mas la ausencia. */
type ErrorRoute = string | SelectiveErrorFallback | null | undefined;

/**
 * Distingue la ruta selectiva de la cadena heredada.
 *
 * Comprueba `targetNode` y no solo que sea un objeto: un jsonb editado a mano
 * puede traer cualquier cosa, y tratarla como ruta valida haria saltar el motor
 * a `undefined`.
 */
const isSelectiveFallback = (
  route: ErrorRoute,
): route is SelectiveErrorFallback =>
  typeof route === 'object' &&
  route !== null &&
  typeof route.targetNode === 'string';

/**
 * Nodo destino DECLARADO, sea cual sea la forma de la ruta.
 *
 * Es la pregunta del validador de topologia, al que solo le importa que el
 * destino exista en el mapa: una ruta que apunta a un nodo inexistente es un
 * esquema roto, atrape los codigos que atrape.
 */
export const declaredErrorTarget = (route: ErrorRoute): string | null => {
  if (typeof route === 'string') {
    return route;
  }

  return isSelectiveFallback(route) ? route.targetNode : null;
};

/**
 * La ruta nombra EXPLICITAMENTE ese codigo en su `catchErrors`.
 *
 * Distinta de `resolveErrorRoute`, y la diferencia esta toda en la forma
 * heredada: una cadena atrapa cualquier codigo, asi que `resolveErrorRoute`
 * diria que si para todos. Esta pregunta es otra —"alguien escribio este codigo
 * a mano aqui"— y solo la forma selectiva puede responderla que si.
 *
 * La usa la regla 10 del validador, que necesita distinguir una declaracion
 * deliberada de un respaldo generico: rechazar un `onErrorStep: "alerta"` porque
 * el nodo no emite cierto codigo seria un falso positivo, ya que esa ruta esta
 * ahi para los OTROS fallos del nodo.
 */
export const catchesErrorExplicitly = (
  route: ErrorRoute,
  errorCode: string,
): boolean =>
  isSelectiveFallback(route) &&
  Array.isArray(route.catchErrors) &&
  route.catchErrors.includes(errorCode);

/** Ruta EFECTIVA resuelta para un codigo concreto. */
export interface ResolvedErrorRoute {
  readonly targetNode: string;
  /** Mensaje con el que registrar el fallo, si la ruta lo declara. */
  readonly customMessage?: string;
}

/**
 * Ruta de recuperacion EFECTIVA para un codigo de error concreto.
 *
 * Es la pregunta del motor, que ya tiene un fallo entre manos. Devuelve `null`
 * cuando no hay ruta o cuando la ruta no atrapa ESE codigo, y en ambos casos el
 * motor debe comportarse igual: como si no hubiera ruta.
 *
 * Devuelve la ruta y no solo su destino porque el motor necesita las dos cosas a
 * la vez —a donde saltar y con que texto registrar el fallo— y resolverlas por
 * separado abriria la puerta a que una consulta dijera que si y la otra que no.
 *
 * Existe separado de `declaredErrorTarget` porque las dos preguntas son
 * distintas y confundirlas haria que el validador exigiese un codigo que aun no
 * ha ocurrido, o que el motor desviase por una ruta que no le correspondia.
 */
export const resolveErrorRoute = (
  route: ErrorRoute,
  errorCode: string,
): ResolvedErrorRoute | null => {
  // La cadena heredada no discrimina: atrapa todo, que es su semantica de
  // siempre y lo que mantiene ejecutables los esquemas ya guardados. Tampoco
  // puede declarar mensaje: una cadena no tiene donde ponerlo.
  if (typeof route === 'string') {
    return { targetNode: route };
  }

  if (!isSelectiveFallback(route) || !Array.isArray(route.catchErrors)) {
    return null;
  }

  if (!route.catchErrors.includes(errorCode)) {
    return null;
  }

  return {
    targetNode: route.targetNode,
    ...(route.customMessage !== undefined
      ? { customMessage: route.customMessage }
      : {}),
  };
};

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
