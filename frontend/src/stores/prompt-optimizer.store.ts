import { defineStore, acceptHMRUpdate } from 'pinia';
import { ref } from 'vue';

import * as promptsService from '@services/prompts.service';

import type {
  OptimizePromptPayload,
  PromptCardinality,
  PromptOptimizationResult,
} from '@/types/prompt-optimizer';

// Estado del asistente "Mejorar Prompt con IA". Esta capa no conoce Axios ni
// rutas (frontend-architecture.md §2.1). Los errores NO se capturan aqui: el
// `finally` apaga el indicador y la excepcion sube al componente.
export const usePromptOptimizerStore = defineStore('prompt-optimizer', () => {
  const result = ref<PromptOptimizationResult | null>(null);
  const isLoading = ref(false);

  /** Un elemento o un lote; viaja en cada propuesta como `cardinality`. */
  const outputCardinality = ref<PromptCardinality>('SINGLE');

  /**
   * Pide una propuesta. Limpia la anterior ANTES de pedir: si la nueva falla,
   * el modal no debe seguir ofreciendo aplicar una propuesta de otro borrador.
   */
  const optimize = async (payload: OptimizePromptPayload): Promise<PromptOptimizationResult> => {
    isLoading.value = true;
    result.value = null;

    try {
      const loaded = await promptsService.optimizePrompt({
        ...payload,
        cardinality: payload.cardinality ?? outputCardinality.value,
      });
      result.value = loaded;
      return loaded;
    } finally {
      isLoading.value = false;
    }
  };

  /** Vacia la propuesta y vuelve a un elemento: cada apertura parte de cero. */
  const clear = (): void => {
    result.value = null;
    outputCardinality.value = 'SINGLE';
  };

  return { result, isLoading, outputCardinality, optimize, clear };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePromptOptimizerStore, import.meta.hot));
}
