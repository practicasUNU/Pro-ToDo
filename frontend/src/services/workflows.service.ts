import { api } from '@boot/axios';

import type { CreateWorkflowPayload, PipelineSummary } from '@/types/pipeline';

// Unica capa que conoce las rutas de `WorkflowsController`. Retorna la data ya
// desestructurada; las excepciones HTTP se propagan hacia el store y de ahi al
// componente, que es quien decide el mensaje al usuario.

/**
 * Da de alta un flujo con el pipeline que ensamblo el asistente.
 *
 * El backend valida el grafo antes de persistirlo, asi que un esquema incompleto
 * llega como 400 con la lista de campos invalidos. Devuelve el resumen del flujo
 * creado, con la misma forma que el listado del catalogo.
 */
export const createWorkflow = async (
  payload: CreateWorkflowPayload,
): Promise<PipelineSummary> => {
  const { data } = await api.post<PipelineSummary>('/workflows', payload);
  return data;
};
