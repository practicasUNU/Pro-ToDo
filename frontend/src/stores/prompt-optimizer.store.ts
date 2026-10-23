import { defineStore, acceptHMRUpdate } from 'pinia';
import { ref } from 'vue';

import * as promptsService from '@services/prompts.service';

import type { OptimizePromptPayload, PromptOptimizationResult } from '@/types/prompt-optimizer';

// Estado del asistente "Mejorar Prompt con IA". Esta capa no conoce Axios ni
// rutas (frontend-architecture.md §2.1). Los errores NO se capturan aqui: el
// `finally` apaga el indicador y la excepcion sube al componente.
export const usePromptOptimizerStore = defineStore('prompt-optimizer', () => {
  const result = ref<PromptOptimizationResult | null>(null);
  const isLoading = ref(false);

  /**
   * Pide una propuesta. Limpia la anterior ANTES de pedir: si la nueva falla,
   * el modal no debe seguir ofreciendo aplicar una propuesta de otro borrador.
   */
  const optimize = async (payload: OptimizePromptPayload): Promise<PromptOptimizationResult> => {
    isLoading.value = true;
    result.value = null;

    try {
      const loaded = await promptsService.optimizePrompt(payload);
      result.value = loaded;
      return loaded;
    } finally {
      isLoading.value = false;
    }
  };

  const clear = (): void => {
    result.value = null;
  };

  return { result, isLoading, optimize, clear };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePromptOptimizerStore, import.meta.hot));
}
