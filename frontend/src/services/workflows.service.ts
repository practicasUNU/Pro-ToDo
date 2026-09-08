import { api } from '@boot/axios';

import type {
  CreateWorkflowPayload,
  PipelineSummary,
  UpdateWorkflowPayload,
} from '@/types/pipeline';

// Unica capa que conoce las rutas de `WorkflowsController`. Retorna la data ya
// desestructurada; las excepciones HTTP se propagan hacia el store y de ahi al
// componente, que es quien decide el mensaje al usuario.
//
// Absorbe el antiguo `pipelines.service.ts`, que apuntaba a la MISMA ruta
// `/workflows`: `frontend-architecture.md` §1 fija un servicio por dominio, y
// tener dos fue la grieta por la que el asistente acabo leyendo flujos
// instanciados donde debia leer plantillas maestras.

/**
 * Flujos ya instanciados, con su topologia en orden de ejecucion.
 *
 * Es la fuente del catalogo de `/flujos`. NO es la del selector del asistente:
 * desde la migracion 010 este parte de `workflow-templates.service.ts`.
 */
export const fetchWorkflows = async (): Promise<PipelineSummary[]> => {
  const { data } = await api.get<PipelineSummary[]>('/workflows');
  return data;
};

/**
 * Da de alta un flujo con el pipeline que ensamblo el asistente.
 *
 * El backend valida el grafo antes de persistirlo, asi que un esquema incompleto
 * llega como 400 con la lista de campos invalidos. Devuelve el resumen del flujo
 * creado, con la misma forma que el listado del catalogo.
 */
export const createWorkflow = async (payload: CreateWorkflowPayload): Promise<PipelineSummary> => {
  const { data } = await api.post<PipelineSummary>('/workflows', payload);
  return data;
};

/**
 * Edita un flujo: nombre, descripcion, grafo o habilitacion.
 *
 * Es la unica via por la que un flujo se ACTIVA. El backend revalida el esquema
 * antes de habilitarlo y devuelve 400 si el flujo no tiene ninguno, porque
 * activarlo lo expone al sondeo IMAP.
 */
export const updateWorkflow = async (
  id: string,
  payload: UpdateWorkflowPayload,
): Promise<PipelineSummary> => {
  const { data } = await api.patch<PipelineSummary>(`/workflows/${id}`, payload);
  return data;
};
