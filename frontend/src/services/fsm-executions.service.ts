import { api } from '@boot/axios';

import { ExecutionState } from '@/types/execution';

import type {
  DiscardExecutionResult,
  ExecutionDetail,
  ExecutionExportQuery,
  ExecutionListQuery,
  ExecutionPage,
  WorkflowExecutionResult,
} from '@/types/execution';

// Unica capa que conoce las rutas de `ExecutionsController`. Devuelve la data
// ya desestructurada; las excepciones HTTP se propagan hacia el store y de ahi
// al componente, que es quien decide el mensaje al usuario.

/** Las rutas NO llevan `/api`: ya esta en el `baseURL` de la instancia. */
const EXECUTIONS_PATH = '/executions';

/**
 * Pagina de ejecuciones, de la mas reciente a la mas antigua.
 *
 * El backend omite el contexto acumulado de estas filas a proposito; para
 * verlo hay que pedir el detalle.
 */
export const fetchExecutions = async (query: ExecutionListQuery = {}): Promise<ExecutionPage> => {
  const { data } = await api.get<ExecutionPage>(EXECUTIONS_PATH, {
    params: query,
  });

  return data;
};

/**
 * Bytes del historial en CSV con los filtros y el orden indicados.
 *
 * `responseType: 'blob'` es obligatorio: con el `json` por defecto Axios
 * intentaria parsear el fichero. Guardarlo en disco es cosa del componente
 * (`utils/file-download.ts`), porque toca el DOM.
 *
 * @throws AxiosError 400 si algun filtro no es valido.
 */
export const downloadExecutionsCsv = async (query: ExecutionExportQuery = {}): Promise<Blob> => {
  const { data } = await api.get<Blob>(`${EXECUTIONS_PATH}/export/csv`, {
    params: query,
    responseType: 'blob',
  });

  return data;
};

/** Ejecucion completa, con su checkpoint y su estado de reintentos. */
export const fetchExecution = async (executionId: string): Promise<ExecutionDetail> => {
  const { data } = await api.get<ExecutionDetail>(`${EXECUTIONS_PATH}/${executionId}`);

  return data;
};

/**
 * Reintento manual de una ejecucion detenida (CU-09).
 *
 * Reutiliza la MISMA fila: el historico no crece con cada intento, y el
 * `executionId` que vuelve es el mismo que se envio.
 *
 * `targetStepId` reanuda desde OTRO paso, el que el operador elige en el
 * canvas. El backend solo admite el propio cursor o un nodo que ya se ejecuto:
 * saltar hacia adelante dejaria sin escribir los namespaces intermedios. Sin el
 * argumento, el cuerpo va vacio y se reanuda desde donde se detuvo.
 *
 * @throws AxiosError 409 si ya no esta PAUSADO, 400 si su nodo desaparecio del
 *         esquema o el paso elegido no se habia ejecutado, 429 si el motor esta
 *         al limite de ejecuciones simultaneas.
 */
export const resumeExecution = async (
  executionId: string,
  targetStepId?: string,
): Promise<WorkflowExecutionResult> => {
  const { data } = await api.post<WorkflowExecutionResult>(
    `${EXECUTIONS_PATH}/${executionId}/resume`,
    targetStepId === undefined ? {} : { targetStepId },
  );

  return data;
};

/**
 * Cierre manual de una ejecucion detenida (CU-09).
 *
 * Es la segunda salida de una PAUSADO: cuando la causa es irrecuperable,
 * reanudar solo repite el mismo fallo. Ademas de cerrar la fila, el backend
 * retira el flujo de los disparadores automaticos, y por eso la respuesta trae
 * tambien el flujo ya desactivado.
 *
 * @throws AxiosError 409 si la ejecucion ya no esta PAUSADO, 404 si no existe.
 */
export const discardExecution = async (
  executionId: string,
  reason: string | null = null,
): Promise<DiscardExecutionResult> => {
  // El motivo es opcional y viaja en el cuerpo del DELETE: queda escrito en el
  // evento FLUJO_DESCARTADO de la auditoria. Sin motivo no se envia cuerpo.
  const { data } = await api.delete<DiscardExecutionResult>(
    `${EXECUTIONS_PATH}/${executionId}/discard`,
    reason === null ? undefined : { data: { reason } },
  );

  return data;
};

/**
 * Estados en los que una ejecucion sigue VIVA y merece supervision.
 *
 * Se consultan por separado y en este orden porque `EN_PROCESO` es unico por
 * flujo (lo garantiza el indice parcial `idx_flujo_activo`) mientras que las
 * PAUSADO pueden acumularse: si hay una corriendo, es la que interesa.
 */
const LIVE_STATES: readonly ExecutionState[] = [ExecutionState.EN_PROCESO, ExecutionState.PAUSADO];

/**
 * Ejecucion viva de un flujo con su contexto acumulado, o `null` si no hay.
 *
 * Compone los dos endpoints existentes en vez de estrenar uno: el listado para
 * localizarla y el detalle para traer `context` y `retryState`, que el resumen
 * omite a proposito.
 *
 * Filtra por estado EN EL SERVIDOR y no en el cliente: el listado pagina por
 * `createdAt DESC`, asi que un flujo con historico largo podria dejar su
 * ejecucion pausada fuera de la primera pagina y el canvas la daria por
 * inexistente.
 */
export const fetchActiveExecution = async (flowId: string): Promise<ExecutionDetail | null> => {
  for (const state of LIVE_STATES) {
    const page = await fetchExecutions({ flowId, state, limit: 1 });
    const [candidate] = page.items;

    if (candidate !== undefined) {
      return fetchExecution(candidate.executionId);
    }
  }

  return null;
};
