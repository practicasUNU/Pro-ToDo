import { defineStore, acceptHMRUpdate } from 'pinia';
import { ref } from 'vue';

import * as nodeSandboxService from '@services/node-sandbox.service';

import { SANDBOX_ROLES_BY_NODE_TYPE } from '@/types/node-sandbox';

import type { NodeSandboxResult, RunNodeSandboxPayload } from '@/types/node-sandbox';
import type { NodeType } from '@/types/pipeline';
import type { UserRole } from '@/types/user';

// Estado de la ejecucion aislada de un nodo en el banco de pruebas. Esta capa no
// conoce Axios ni rutas (`frontend-architecture.md` §2.1): invoca al servicio y
// guarda su resultado. Los errores HTTP se propagan: es el componente quien
// decide el mensaje.

/** El rol puede ejecutar este tipo de nodo en el banco (replica del backend). */
export const canRunInSandbox = (nodeType: NodeType, role: UserRole | null | undefined): boolean =>
  role !== null &&
  role !== undefined &&
  (SANDBOX_ROLES_BY_NODE_TYPE[nodeType]?.includes(role) ?? false);

export const useNodeSandboxStore = defineStore('nodeSandbox', () => {
  const isRunning = ref(false);
  const lastResult = ref<NodeSandboxResult | null>(null);

  /** Ejecuta el nodo y guarda el resultado, exito o fallo DEL NODO. */
  const run = async (payload: RunNodeSandboxPayload): Promise<NodeSandboxResult> => {
    isRunning.value = true;

    try {
      const result = await nodeSandboxService.runNodeSandbox(payload);
      lastResult.value = result;

      return result;
    } finally {
      isRunning.value = false;
    }
  };

  /** Olvida el ultimo resultado, por ejemplo al cambiar de tipo de nodo. */
  const clearResult = (): void => {
    lastResult.value = null;
  };

  return { isRunning, lastResult, run, clearResult };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useNodeSandboxStore, import.meta.hot));
}
