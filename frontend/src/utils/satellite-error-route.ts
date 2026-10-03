import { ERROR_BRANCH_ACTIONS } from '@/types/nodes/error-branch.types';

import type { ErrorBranchAction } from '@/types/nodes/error-branch.types';

// Helper puro (frontend-architecture.md §2.1): transforma un dato en otro, sin
// estado ni I/O.
//
// Vive aqui y no dentro de un store por el mismo motivo que
// `pipeline-assembler.ts`: tiene DOS anfitriones con el mismo problema —el
// asistente de flujos (`flujo-draft.store.ts`) y el editor de plantillas
// (`workflow-templates.store.ts`)—, y los dos fijaban `onErrorStep: null` en
// todo satelite. Dos copias de esta regla divergirian, y el sintoma seria un
// flujo que avisa cuando lo crea el asistente y enmudece cuando lo crea el
// editor.

/**
 * Ruta de contingencia DEL SATELITE, o `null` si no la tiene.
 *
 * Devuelve el `nodeId` del satelite que atiende el fallo de este otro satelite,
 * segun el `satelliteFallbackAction` que declara el catalogo.
 *
 * La guarda de PROVISION no es opcional: la ruta solo se emite si la accion de
 * respaldo esta realmente provisionada en este flujo. Apuntar a un nodo que no
 * figura en el mapa rompe la regla 3 del validador de topologia —«todo
 * `onErrorStep` no nulo resuelve a un nodo existente»— y convierte un guardado
 * correcto en un 400.
 *
 * Se devuelve la forma de CADENA y no la selectiva, y es deliberado: es la
 * unica que el motor (`resolveErrorRoute`) trata como "atrapa cualquier fallo",
 * y es lo que se quiere aqui —un satelite puede fallar por configuracion, por
 * red o por el proveedor, y no hay un codigo que los agrupe—. De paso esquiva
 * la regla 10, que solo inspecciona rutas selectivas.
 *
 * @param action Accion cuyo satelite se esta ensamblando.
 * @param provisionedActions Acciones con satelite provisionado en este flujo.
 */
export const resolveSatelliteErrorRoute = (
  action: ErrorBranchAction,
  provisionedActions: readonly ErrorBranchAction[],
): string | null => {
  const { satelliteFallbackAction } = ERROR_BRANCH_ACTIONS[action];

  if (satelliteFallbackAction === null) return null;

  if (!provisionedActions.includes(satelliteFallbackAction)) return null;

  return ERROR_BRANCH_ACTIONS[satelliteFallbackAction].provisionedNodeId;
};
