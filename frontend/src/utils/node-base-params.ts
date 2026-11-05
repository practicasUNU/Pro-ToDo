import { DEFAULT_PARAMS_BY_NODE_TYPE } from '@/types/pipeline';

import type { NodeType } from '@/types/pipeline';

/**
 * Completa los `params` de un nodo con los defaults de su tipo.
 *
 * El orden del spread es lo importante: lo que la plantilla ya traia GANA sobre
 * el default. Al reves, abrir una plantilla antigua para tocar un toggle le
 * reescribiria el `mailbox` que su autor habia cambiado, y el cambio viajaria al
 * backend sin que nadie lo hubiera pedido.
 *
 * Es una funcion pura y sin estado (`frontend-architecture.md` §2.1): no conoce
 * Pinia ni componentes, solo transforma un objeto.
 */
export const withBaseParamDefaults = (
  nodeType: NodeType,
  params: Record<string, unknown>,
): Record<string, unknown> => ({
  ...DEFAULT_PARAMS_BY_NODE_TYPE[nodeType],
  ...params,
});
