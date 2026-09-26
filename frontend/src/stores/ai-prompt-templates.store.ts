import { defineStore, acceptHMRUpdate } from 'pinia';
import { ref } from 'vue';

import * as aiPromptTemplatesService from '@services/ai-prompt-templates.service';

import type {
  AiPromptTemplate,
  AiPromptTemplateDetail,
  CreateAiPromptTemplatePayload,
  UpdateAiPromptTemplatePayload,
} from '@/types/ai-prompt-template';

// Logica de negocio y estado compartido del dominio Prompts de IA. Esta capa no
// conoce Axios ni rutas del backend (ver frontend-architecture.md §2.1): solo
// invoca al servicio y muta el estado de forma inmutable con su resultado.
//
// Los errores NO se capturan aqui: el store solo garantiza el `finally` que
// apaga `isLoading`, y es el componente quien decide el mensaje al usuario.
export const useAiPromptTemplatesStore = defineStore('aiPromptTemplates', () => {
  const prompts = ref<AiPromptTemplate[]>([]);

  /**
   * Prompt abierto en el dialogo, CON su instruccion.
   *
   * Vive aparte de `prompts` porque el listado no trae `promptText`: son dos
   * formas distintas del mismo recurso, y meter el detalle en el arreglo
   * obligaria a que `AiPromptTemplate` mintiera sobre lo que siempre tiene.
   */
  const activePrompt = ref<AiPromptTemplateDetail | null>(null);

  const isLoading = ref(false);

  const loadPrompts = async (onlyActive = true): Promise<void> => {
    isLoading.value = true;

    try {
      prompts.value = await aiPromptTemplatesService.fetchAiPromptTemplates(onlyActive);
    } finally {
      isLoading.value = false;
    }
  };

  const loadPromptById = async (id: string): Promise<AiPromptTemplateDetail> => {
    isLoading.value = true;

    try {
      const detail = await aiPromptTemplatesService.fetchAiPromptTemplateById(id);
      activePrompt.value = detail;
      return detail;
    } finally {
      isLoading.value = false;
    }
  };

  const createPrompt = async (
    payload: CreateAiPromptTemplatePayload,
  ): Promise<AiPromptTemplateDetail> => {
    isLoading.value = true;

    try {
      const created = await aiPromptTemplatesService.createAiPromptTemplate(payload);
      prompts.value = [...prompts.value, created];
      return created;
    } finally {
      isLoading.value = false;
    }
  };

  const updatePrompt = async (
    id: string,
    payload: UpdateAiPromptTemplatePayload,
  ): Promise<AiPromptTemplateDetail> => {
    isLoading.value = true;

    try {
      const updated = await aiPromptTemplatesService.updateAiPromptTemplate(id, payload);
      prompts.value = prompts.value.map((prompt) => (prompt.id === id ? updated : prompt));
      return updated;
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Borrado logico: el backend solo pone `activo` en false.
   *
   * Se sustituye la fila con `map` y NO se saca con `filter`: la tabla
   * administrativa debe seguir mostrandola con el badge "Inactivo", que es la
   * unica via para reactivarla desde la interfaz. Mismo criterio que
   * `users.store`, no el de `templates.store`.
   */
  const deletePrompt = async (id: string): Promise<AiPromptTemplateDetail> => {
    isLoading.value = true;

    try {
      const deactivated = await aiPromptTemplatesService.deactivateAiPromptTemplate(id);
      prompts.value = prompts.value.map((prompt) => (prompt.id === id ? deactivated : prompt));
      return deactivated;
    } finally {
      isLoading.value = false;
    }
  };

  return {
    prompts,
    activePrompt,
    isLoading,
    loadPrompts,
    loadPromptById,
    createPrompt,
    updatePrompt,
    deletePrompt,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAiPromptTemplatesStore, import.meta.hot));
}
