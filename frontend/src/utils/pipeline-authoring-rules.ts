import {
  DESTINO_NODE_TYPES,
  NODE_TYPE_LABELS,
  PROCESSING_NODE_TYPES,
  TRIGGER_NODE_TYPES,
} from '@/types/pipeline';

import type { NodeType } from '@/types/pipeline';

// Reglas de AUTORIA de la topologia: las que el backend exige al GUARDAR un
// flujo o una plantilla (reglas 12 y 13 de `validatePipelineTopology`). La UI
// solo se adelanta para bloquear la accion antes de gastar un 400 seguro, y por
// eso los mensajes son el MISMO texto que devuelve el backend.

/** Nodo minimo que estas reglas necesitan mirar. */
interface TypedStep {
  readonly nodeType: string;
}

const labelOf = (nodeType: string): string => NODE_TYPE_LABELS[nodeType as NodeType] ?? nodeType;

/** Disparadores y destinos: los unicos tipos que no se pueden repetir. */
export const isUniquePerFlowType = (nodeType: string): boolean =>
  TRIGGER_NODE_TYPES.has(nodeType) || DESTINO_NODE_TYPES.has(nodeType);

/** Mensaje de la regla 12, literal del backend. */
export const duplicateNodeTypeMessage = (nodeType: string): string =>
  `El tipo de nodo '${labelOf(nodeType)}' ya está presente en este flujo y no se puede duplicar.`;

/** Mensaje de la regla 13, literal del backend. */
export const destinationBeforeProcessingMessage = (nodeType: string): string =>
  `El destino '${labelOf(nodeType)}' debe ubicarse después de los nodos de ingesta y procesamiento: añade antes al menos un nodo de procesamiento (parser, extractor, IA, OCR o mapeador).`;

/**
 * Motivo por el que anadir `candidate` duplicaria un tipo restringido, o `null`.
 *
 * Se permiten varios disparadores o destinos si son de tipos DISTINTOS (IMAP y
 * Cron, Drupal y HTTP generico); lo que se prohibe es repetir el mismo tipo.
 */
export const findDuplicateAddition = (
  steps: readonly TypedStep[],
  candidate: string,
): string | null =>
  isUniquePerFlowType(candidate) && steps.some((step) => step.nodeType === candidate)
    ? duplicateNodeTypeMessage(candidate)
    : null;

/** Primer tipo restringido repetido en un conjunto de nodos, o `null`. */
export const findDuplicateNodeType = (steps: readonly TypedStep[]): string | null => {
  const seen = new Set<string>();

  for (const { nodeType } of steps) {
    if (!isUniquePerFlowType(nodeType)) continue;

    if (seen.has(nodeType)) return duplicateNodeTypeMessage(nodeType);

    seen.add(nodeType);
  }

  return null;
};

/**
 * Primer destino del CAMINO ACTIVO que llega sin procesamiento previo, o `null`.
 *
 * Recibe el camino ya ordenado: los satelites de `onErrorStep` no se juzgan,
 * porque una alerta SMTP puede atender el fallo del propio disparador.
 */
export const findDestinationBeforeProcessing = (path: readonly TypedStep[]): string | null => {
  let processed = false;

  for (const { nodeType } of path) {
    if (DESTINO_NODE_TYPES.has(nodeType) && !processed) {
      return destinationBeforeProcessingMessage(nodeType);
    }

    processed ||= PROCESSING_NODE_TYPES.has(nodeType);
  }

  return null;
};

/**
 * Veredicto de las dos reglas sobre un `pipeline_schema` sin tipar (el texto
 * del editor ya parseado), o `null` si cumple o no se puede leer.
 *
 * Ante un documento ilegible deja pasar: el JSON roto y el grafo a medias ya
 * los denuncian otras guardas, y la autoridad final sigue siendo el backend.
 */
export const describeAuthoringIssue = (schema: unknown): string | null => {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return null;

  const { entrypoint, nodes } = schema as { entrypoint?: unknown; nodes?: unknown };

  if (typeof nodes !== 'object' || nodes === null || Array.isArray(nodes)) return null;

  const nodeMap = nodes as Record<string, { nodeType?: unknown; nextStep?: unknown }>;
  const typed = Object.values(nodeMap).flatMap((node) =>
    typeof node.nodeType === 'string' ? [{ nodeType: node.nodeType }] : [],
  );

  const duplicate = findDuplicateNodeType(typed);

  if (duplicate !== null) return duplicate;

  // Camino activo por `nextStep`, con visitados: un ciclo lo denuncia el
  // backend, y aqui solo hace falta no colgarse.
  const path: TypedStep[] = [];
  const visited = new Set<string>();
  let cursor: unknown = entrypoint;

  while (typeof cursor === 'string' && !visited.has(cursor)) {
    const node = nodeMap[cursor];

    if (node === undefined || typeof node.nodeType !== 'string') break;

    visited.add(cursor);
    path.push({ nodeType: node.nodeType });
    cursor = node.nextStep;
  }

  return findDestinationBeforeProcessing(path);
};
