import { runNodeSandbox } from '@services/node-sandbox.service';

import { NodeType } from '@/types/pipeline';

import type { NodeSandboxResult } from '@/types/node-sandbox';

// Capa de servicio del nodo DESTINO_ACENS (frontend-quasar.md §3.1). No hay
// ruta propia: la prueba reutiliza el banco de pruebas de nodos, que en modo
// `CREATE_CAMPAIGN` NO crea la campana real y devuelve `status: TEST_MODE` con
// la peticion prevista. Solo un ADMIN puede lanzarla.

/** Muestra minima de contenido validado para la prueba de campana. */
const SAMPLE_VALIDATED_MARKUP =
  '<h2>Prueba de campana</h2><p>Contenido de muestra del banco de pruebas.</p>';

/**
 * Ensaya la creacion de la campana con los `params` del nodo.
 *
 * @param params Parametros del nodo tal y como se guardarian (`toNodeParams`).
 * @param contentNamespace Namespace del que la campana lee el marcado.
 */
export const testCampaignDispatch = async (
  params: Record<string, unknown>,
  contentNamespace: string,
): Promise<NodeSandboxResult> =>
  runNodeSandbox({
    nodeType: NodeType.DESTINO_ACENS,
    params: { ...params, operation: 'CREATE_CAMPAIGN' },
    upstreamContext: {
      [contentNamespace]: {
        validated_markup: SAMPLE_VALIDATED_MARKUP,
        validated_items: [],
      },
    },
  });
