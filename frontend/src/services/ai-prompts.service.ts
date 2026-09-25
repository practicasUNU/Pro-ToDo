import { api } from '@boot/axios';

import type {
  AiPrompt,
  AiPromptDetail,
  CreateAiPromptPayload,
  UpdateAiPromptPayload,
} from '@/types/ai-prompt';

// Unica capa que conoce las rutas del backend NestJS (AiPromptsController) y el
// tipo AxiosResponse. Todas las funciones retornan la data ya desestructurada;
// las excepciones HTTP se propagan hacia el store y de ahi al componente.

/**
 * Lista los prompts.
 *
 * @param onlyActive Por defecto si. El backend exige el literal `'true'` en
 *                   `includeInactive`, asi que solo se envia cuando toca: un
 *                   valor mal escrito debe caer del lado seguro.
 */
export const fetchAiPrompts = async (onlyActive = true): Promise<AiPrompt[]> => {
  const { data } = await api.get<AiPrompt[]>('/ai-prompts', {
    params: onlyActive ? {} : { includeInactive: 'true' },
  });
  return data;
};

/** Detalle con la instruccion completa, que el listado no trae. */
export const fetchAiPromptById = async (id: string): Promise<AiPromptDetail> => {
  const { data } = await api.get<AiPromptDetail>(`/ai-prompts/${id}`);
  return data;
};

export const createAiPrompt = async (payload: CreateAiPromptPayload): Promise<AiPromptDetail> => {
  const { data } = await api.post<AiPromptDetail>('/ai-prompts', payload);
  return data;
};

export const updateAiPrompt = async (
  id: string,
  payload: UpdateAiPromptPayload,
): Promise<AiPromptDetail> => {
  const { data } = await api.patch<AiPromptDetail>(`/ai-prompts/${id}`, payload);
  return data;
};

// Borrado logico: el endpoint DELETE del backend solo cambia `activo` a false y
// devuelve el registro actualizado, nunca elimina la fila. Una ejecucion ya
// trazada apunta al prompt con el que se genero su salida.
export const deactivateAiPrompt = async (id: string): Promise<AiPromptDetail> => {
  const { data } = await api.delete<AiPromptDetail>(`/ai-prompts/${id}`);
  return data;
};
