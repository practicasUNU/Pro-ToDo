import { api } from '@boot/axios';

import type {
  ExecutionDetail,
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
export const fetchExecutions = async (
  query: ExecutionListQuery = {},
): Promise<ExecutionPage> => {
  const { data } = await api.get<ExecutionPage>(EXECUTIONS_PATH, {
    params: query,
  });

  return data;
};

/** Ejecucion completa, con su checkpoint y su estado de reintentos. */
export const fetchExecution = async (
  executionId: string,
): Promise<ExecutionDetail> => {
  const { data } = await api.get<ExecutionDetail>(
    `${EXECUTIONS_PATH}/${executionId}`,
  );

  return data;
};

/**
 * Reintento manual de una ejecucion detenida (CU-09).
 *
 * Reutiliza la MISMA fila: el historico no crece con cada intento, y el
 * `executionId` que vuelve es el mismo que se envio.
 *
 * @throws AxiosError 409 si ya no esta PAUSADO, 400 si su nodo desaparecio del
 *         esquema, 429 si el motor esta al limite de ejecuciones simultaneas.
 */
export const resumeExecution = async (
  executionId: string,
): Promise<WorkflowExecutionResult> => {
  const { data } = await api.post<WorkflowExecutionResult>(
    `${EXECUTIONS_PATH}/${executionId}/resume`,
    {},
  );

  return data;
};
