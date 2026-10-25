import { ExecutionState } from '@/types/execution';
import { WorkflowStatus } from '@/types/pipeline';
import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as workflowsService from '@services/workflows.service';

import type { CrudAction } from '@/types/crud-events';
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

  /**
   * Flujos armados frente a los disparadores.
   *
   * Cuenta SOLO los ACTIVO: un PAUSADO no dispara —el motor lo saco de los
   * sondeos al detener su ejecucion—, asi que sumarlo diria que hay mas flujos
   * trabajando de los que hay.
   */
  const activeCount = computed<number>(
    () => workflows.value.filter((workflow) => workflow.status === WorkflowStatus.ACTIVO).length,
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

  /**
   * Habilita o retira el flujo frente a los disparadores automaticos.
   *
   * Solo ACTIVO e INACTIVO: el backend rechaza un PAUSADO llegado por la API,
   * porque ese estado describe una ejecucion detenida y lo escribe el motor.
   */
  const setStatus = async (
    id: string,
    status: WorkflowStatus.ACTIVO | WorkflowStatus.INACTIVO,
  ): Promise<PipelineSummary> => updateWorkflow(id, { status });

  /**
   * Aplica una mutacion llegada por WebSocket.
   *
   * Es IDEMPOTENTE a proposito: quien origino el cambio ya actualizo esta lista
   * con la respuesta REST y recibe ademas su propio evento, de modo que un
   * `CREATED` que insertara a ciegas le duplicaria la fila en pantalla.
   *
   * Reemplaza la fila ENTERA en vez de fusionarla porque el backend difunde el
   * mismo resumen completo que devuelve REST; fusionar solo tendria sentido con
   * un payload parcial, y romperia la simetria con los otros cinco stores.
   *
   * La rama `DELETED` existe por contrato, pero `workflows` no la produce: no
   * hay `@Delete` en su controlador y retirar un flujo es `PATCH
   * { status: 'INACTIVO' }`, es decir un `UPDATED`.
   */
  const applyMutation = (
    action: CrudAction,
    item: PipelineSummary | undefined,
    id: string,
  ): void => {
    if (action === 'DELETED') {
      workflows.value = workflows.value.filter((workflow) => workflow.id !== id);

      return;
    }

    // Un evento sin fila solo puede ser una baja; cualquier otra cosa es un
    // emisor incoherente y se ignora antes que corromper la lista.
    if (item === undefined) {
      return;
    }

    const exists = workflows.value.some((workflow) => workflow.id === item.id);

    workflows.value = exists
      ? workflows.value.map((workflow) => (workflow.id === item.id ? item : workflow))
      : [item, ...workflows.value];
  };

  /**
   * Refleja en la fila una reanudacion anunciada por `flow:resumed`.
   *
   * Es un REFUERZO del `crud:mutation` que el backend difunde al reanudar: el
   * evento de sala llega a quien tiene el flujo abierto aunque la mutacion se
   * pierda en un micro-corte. Replica lo que hace el backend —la ejecucion pasa
   * a EN_PROCESO y un flujo PAUSADO vuelve a ACTIVO— sin inventar nada mas; la
   * siguiente mutacion completa sustituye la fila igualmente.
   */
  const markExecutionResumed = (flowId: string, executionId: string): void => {
    workflows.value = workflows.value.map((workflow) =>
      workflow.id === flowId
        ? {
            ...workflow,
            status:
              workflow.status === WorkflowStatus.PAUSADO ? WorkflowStatus.ACTIVO : workflow.status,
            activeExecutionId: executionId,
            executionState: ExecutionState.EN_PROCESO,
          }
        : workflow,
    );
  };

  return {
    workflows,
    isLoading,
    activeCount,
    fetchWorkflows,
    updateWorkflow,
    setStatus,
    applyMutation,
    markExecutionResumed,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorkflowsStore, import.meta.hot));
}
