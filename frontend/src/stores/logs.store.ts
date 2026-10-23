import { defineStore, acceptHMRUpdate } from 'pinia';
import { ref } from 'vue';

import * as logsService from '@services/logs.service';

import type { ExecutionLog } from '@/types/logs';

// Estado del visor de logs. Esta capa no conoce Axios ni rutas
// (frontend-architecture.md §2.1). Los errores NO se capturan: el `finally`
// apaga el indicador y la excepcion sube al componente, que decide el aviso.
export const useLogsStore = defineStore('logs', () => {
  const currentLog = ref<ExecutionLog | null>(null);
  const isLoading = ref(false);

  /**
   * Carga la traza de una ejecucion. Se limpia ANTES de pedirla: si la
   * peticion falla, el visor no debe seguir mostrando la traza de otra fila.
   */
  const loadExecutionLog = async (executionId: string): Promise<void> => {
    currentLog.value = null;
    isLoading.value = true;

    try {
      currentLog.value = await logsService.fetchExecutionLog(executionId);
    } finally {
      isLoading.value = false;
    }
  };

  const clear = (): void => {
    currentLog.value = null;
  };

  return { currentLog, isLoading, loadExecutionLog, clear };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useLogsStore, import.meta.hot));
}
