import { ASSETS_FIELDS, ASSETS_NAMESPACE } from '@/types/html-template';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

/**
 * Namespaces que siembra el MOTOR y que ningun nodo publica.
 *
 * Replica de `ENGINE_PROVIDED_NAMESPACES`
 * (`backend/src/core/fsm/validators/pipeline-topology.validator.ts`), que es la
 * lista con la que la regla 7 del validador exime a estos tres de necesitar un
 * productor aguas arriba.
 *
 * POR QUE HACE FALTA REPLICARLOS. El catalogo de variables del editor de
 * prompts se construye desde `GET /api/nodos`, es decir, desde lo que declara
 * cada estrategia en `outputFields`. Estos tres no los escribe ninguna, asi que
 * por esa via no pueden aparecer NUNCA, y sin embargo son marcadores
 * perfectamente validos: `{{trigger.flow_name}}` es justo lo que lleva el
 * asunto por defecto del nodo de alerta. El operador podia teclearlos —nada
 * valida el texto del prompt— pero no elegirlos, que es exactamente lo que el
 * Poka-Yoke de la regla §4 pretende evitar.
 *
 * Es la unica replica manual aceptable aqui, y lo es porque la alternativa no
 * existe: no hay endpoint que los publique. Todo lo demas se pregunta.
 */

/** Lo que el motor deja en `trigger` al crear la ejecucion. */
const TRIGGER_FIELDS = [
  {
    name: 'flow_name',
    type: 'text' as const,
    description: 'Nombre legible del flujo en ejecucion',
  },
];

/**
 * Lo que el motor siembra ANTES de desviar por `onErrorStep`.
 *
 * Replica de `buildErrorContext`. Solo existe en las ejecuciones que se
 * desviaron, de modo que citarlo desde el camino feliz interpola vacio: por eso
 * el catalogo general lo ofrece —un prompt de rama de recuperacion lo necesita—
 * y el asistente no lo inyecta en los pasos del camino nominal.
 */
const ERROR_CONTEXT_FIELDS = [
  { name: 'failed_node_id', type: 'text' as const },
  { name: 'failed_node_type', type: 'text' as const },
  { name: 'error_code', type: 'text' as const },
  { name: 'error_level', type: 'text' as const },
  { name: 'error_message', type: 'text' as const },
  { name: 'missing_fields', type: 'object' as const },
  { name: 'attempts', type: 'number' as const },
  { name: 'failed_at', type: 'text' as const },
  {
    name: 'partial_data',
    type: 'object' as const,
    description: 'Lo que el nodo alcanzo a producir antes de fallar',
  },
];

/**
 * Los tres orígenes del motor, listos para el explorador de variables.
 *
 * `isConditional` en `error_context` por el mismo motivo que en un satelite de
 * contingencia: solo existe si la ejecucion se desvio.
 */
export const ENGINE_PROVIDED_CONTEXT: readonly UpstreamNamespace[] = [
  { namespace: 'trigger', fields: TRIGGER_FIELDS },
  {
    namespace: 'error_context',
    fields: ERROR_CONTEXT_FIELDS,
    isConditional: true,
  },
  { namespace: ASSETS_NAMESPACE, fields: ASSETS_FIELDS },
];
