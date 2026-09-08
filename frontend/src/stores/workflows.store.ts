import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as workflowsService from '@services/workflows.service';

import type { PipelineSummary, UpdateWorkflowPayload } from '@/types/pipeline';

// Logica de negocio y estado compartido del catalogo de flujos INSTANCIADOS.
// Esta capa no conoce Axios ni rutas (`frontend-architecture.md` §2.1): invoca
// al servicio y muta el estado de forma inmutable con su resultado.
//
// FRONTERA CON `useFlujoDraftStore`: este posee el catalogo de flujos que YA
// existen y su habilitacion; aquel es el borrador del asistente mientras se
// construye uno nuevo. Son dos ciclos de vida distintos y mezclarlos haria que
// abandonar el asistente ensuciase la tabla.
export const useWorkflowsStore = defineStore('workflows', () => {
  const workflows = ref<PipelineSummary[]>([]);
  const isLoading = ref(false);

  const activeCount = computed<number>(
    () => workflows.value.filter((workflow) => workflow.active).length,
  );

  const fetchWorkflows = async (): Promise<void> => {
    isLoading.value = true;

    try {
      workflows.value = await workflowsService.fetchWorkflows();
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Aplica un cambio y reemplaza la fila con lo que devuelve el backend.
   *
   * Se escribe la respuesta del servidor y no el parche optimista: activar puede
   * fallar con un 400 si el esquema ya no es integro, y pintar el toggle en
   * verde antes de saberlo mentiria sobre el estado real del flujo.
   *
   * No captura el error: el componente decide el mensaje (§2.1).
   */
  const updateWorkflow = async (
    id: string,
    payload: UpdateWorkflowPayload,
  ): Promise<PipelineSummary> => {
    isLoading.value = true;

    try {
      const updated = await workflowsService.updateWorkflow(id, payload);

      workflows.value = workflows.value.map((workflow) =>
        workflow.id === id ? updated : workflow,
      );

      return updated;
    } finally {
      isLoading.value = false;
    }
  };

  /** Habilita o retira el flujo frente a los disparadores automaticos. */
  const setActive = async (id: string, active: boolean): Promise<PipelineSummary> =>
    updateWorkflow(id, { active });

  return {
    workflows,
    isLoading,
    activeCount,
    fetchWorkflows,
    updateWorkflow,
    setActive,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorkflowsStore, import.meta.hot));
}
