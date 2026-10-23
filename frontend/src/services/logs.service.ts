import { api } from '@boot/axios';

import type { ExecutionLog } from '@/types/logs';

// Unica capa que conoce las rutas de `LogsController`. Devuelve la data ya
// desestructurada; los errores HTTP suben al store y de ahi al componente.

/** Sin `/api`: ya esta en el `baseURL` de la instancia. */
const LOGS_PATH = '/logs';

/** Traza de una ejecucion: ultimo fallo y sus entradas en los `.log`. */
export const fetchExecutionLog = async (executionId: string): Promise<ExecutionLog> => {
  const { data } = await api.get<ExecutionLog>(`${LOGS_PATH}/execution/${executionId}`);

  return data;
};
