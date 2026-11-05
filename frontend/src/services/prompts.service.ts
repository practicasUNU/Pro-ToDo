import { api } from '@boot/axios';

import type { OptimizePromptPayload, PromptOptimizationResult } from '@/types/prompt-optimizer';

// Unica capa que conoce las rutas de `PromptsController`. Los errores HTTP se
// propagan al store y de ahi al componente, que decide el mensaje.

/** Sin `/api`: ya esta en el `baseURL` de la instancia. */
const PROMPTS_PATH = '/prompts';

/** Pide al backend la version optimizada de un borrador de prompt. */
export const optimizePrompt = async (
  payload: OptimizePromptPayload,
): Promise<PromptOptimizationResult> => {
  const { data } = await api.post<PromptOptimizationResult>(`${PROMPTS_PATH}/optimize`, payload);

  return data;
};
