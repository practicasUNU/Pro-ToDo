import { api } from '@boot/axios';

import type {
  CreateWorkflowTemplatePayload,
  UpdateWorkflowTemplatePayload,
  WorkflowTemplateDetail,
  WorkflowTemplateSummary,
} from '@/types/pipeline';

// Unica capa que conoce las rutas de `WorkflowTemplatesController`. Retorna la
// data ya desestructurada; las excepciones HTTP se propagan hacia el store y de
// ahi al componente, que es quien decide el mensaje al usuario.

/**
 * Catalogo de plantillas de flujo.
 *
 * El backend devuelve la topologia EN ORDEN DE EJECUCION, asi que el cliente no
 * recorre ningun grafo, y omite los `params` de cada nodo.
 *
 * @param includeInactive `true` trae tambien las retiradas, para la tabla
 *        administrativa. El selector del asistente las omite.
 */
export const fetchWorkflowTemplates = async (
  includeInactive = false,
): Promise<WorkflowTemplateSummary[]> => {
  const { data } = await api.get<WorkflowTemplateSummary[]>('/workflow-templates', {
    ...(includeInactive ? { params: { includeInactive: 'true' } } : {}),
  });
  return data;
};

/** Plantilla con su `pipelineSchema` completo, para el editor. */
export const fetchWorkflowTemplate = async (id: string): Promise<WorkflowTemplateDetail> => {
  const { data } = await api.get<WorkflowTemplateDetail>(`/workflow-templates/${id}`);
  return data;
};

/**
 * Da de alta una plantilla. Requiere rol ADMIN.
 *
 * El backend valida el grafo completo antes de persistirlo, asi que una
 * topologia incoherente llega como 400 con la lista de campos invalidos, y un
 * nombre repetido como 409.
 */
export const createWorkflowTemplate = async (
  payload: CreateWorkflowTemplatePayload,
): Promise<WorkflowTemplateDetail> => {
  const { data } = await api.post<WorkflowTemplateDetail>('/workflow-templates', payload);
  return data;
};

/** Edita una plantilla; tambien la activa o la inactiva. Requiere ADMIN. */
export const updateWorkflowTemplate = async (
  id: string,
  payload: UpdateWorkflowTemplatePayload,
): Promise<WorkflowTemplateDetail> => {
  const { data } = await api.put<WorkflowTemplateDetail>(`/workflow-templates/${id}`, payload);
  return data;
};

/**
 * Retira una plantilla del catalogo (borrado logico). Requiere ADMIN.
 *
 * La fila no se elimina: los flujos que la instanciaron apuntan a ella y su
 * trazabilidad depende de que siga existiendo.
 */
export const deactivateWorkflowTemplate = async (id: string): Promise<WorkflowTemplateDetail> => {
  const { data } = await api.delete<WorkflowTemplateDetail>(`/workflow-templates/${id}`);
  return data;
};
