import { api } from '@boot/axios';

import type { PipelineSummary } from '@/types/pipeline';

// Unica capa que conoce la ruta `/workflows` del backend NestJS
// (WorkflowsController) y el tipo AxiosResponse. Retorna la data ya
// desestructurada; las excepciones HTTP se propagan hacia el store y de ahi al
// componente, que es quien decide el mensaje al usuario.

/**
 * Flujos utilizables como plantilla en la Fase 0 del asistente.
 *
 * El backend ya filtra los que no tienen `configuracion_pipeline` y devuelve la
 * topologia EN ORDEN DE EJECUCION, asi que el cliente no recorre ningun grafo.
 * Tampoco recibe los `params` de cada nodo: son datos de infraestructura que no
 * hacen falta para poblar un selector.
 */
export const fetchSelectablePipelines = async (): Promise<PipelineSummary[]> => {
  const { data } = await api.get<PipelineSummary[]>('/workflows');
  return data;
};
