import { api } from '@boot/axios';

import type {
  AiPromptTemplate,
  AiPromptTemplateDetail,
  CreateAiPromptTemplatePayload,
  UpdateAiPromptTemplatePayload,
} from '@/types/ai-prompt-template';

// Unica capa que conoce las rutas del backend NestJS (AiPromptTemplatesController) y el
// tipo AxiosResponse. Todas las funciones retornan la data ya desestructurada;
// las excepciones HTTP se propagan hacia el store y de ahi al componente.

/**
 * Lista los prompts.
 *
 * @param onlyActive Por defecto si. El backend exige el literal `'true'` en
 *                   `includeInactive`, asi que solo se envia cuando toca: un
 *                   valor mal escrito debe caer del lado seguro.
 */
export const fetchAiPromptTemplates = async (onlyActive = true): Promise<AiPromptTemplate[]> => {
  const { data } = await api.get<AiPromptTemplate[]>('/ai-prompt-templates', {
    params: onlyActive ? {} : { includeInactive: 'true' },
  });
  return data;
};

/** Detalle con la instruccion completa, que el listado no trae. */
export const fetchAiPromptTemplateById = async (id: string): Promise<AiPromptTemplateDetail> => {
  const { data } = await api.get<AiPromptTemplateDetail>(`/ai-prompt-templates/${id}`);
  return data;
};

export const createAiPromptTemplate = async (payload: CreateAiPromptTemplatePayload): Promise<AiPromptTemplateDetail> => {
  const { data } = await api.post<AiPromptTemplateDetail>('/ai-prompt-templates', payload);
  return data;
};

export const updateAiPromptTemplate = async (
  id: string,
  payload: UpdateAiPromptTemplatePayload,
): Promise<AiPromptTemplateDetail> => {
  const { data } = await api.patch<AiPromptTemplateDetail>(`/ai-prompt-templates/${id}`, payload);
  return data;
};

// Borrado logico: el endpoint DELETE del backend solo cambia `activo` a false y
// devuelve el registro actualizado, nunca elimina la fila. Una ejecucion ya
// trazada apunta al prompt con el que se genero su salida.
export const deactivateAiPromptTemplate = async (id: string): Promise<AiPromptTemplateDetail> => {
  const { data } = await api.delete<AiPromptTemplateDetail>(`/ai-prompt-templates/${id}`);
  return data;
};
