import { defineStore, acceptHMRUpdate } from 'pinia';
import { ref } from 'vue';

import * as templatesService from '@services/templates.service';

import type {
  CreateHtmlTemplatePayload,
  HtmlTemplate,
  UpdateHtmlTemplatePayload,
} from '@/types/html-template';

// Logica de negocio y estado compartido del dominio Plantillas HTML. Esta capa
// no conoce Axios ni rutas del backend (ver frontend-architecture.md §2.1): solo
// invoca al servicio y muta el estado de forma inmutable con su resultado.
export const useTemplatesStore = defineStore('templates', () => {
  const templates = ref<HtmlTemplate[]>([]);
  const selectedTemplate = ref<HtmlTemplate | null>(null);
  const isLoading = ref(false);

  const fetchTemplates = async (): Promise<void> => {
    isLoading.value = true;

    try {
      templates.value = await templatesService.fetchTemplates();
    } finally {
      isLoading.value = false;
    }
  };

  const createTemplate = async (payload: CreateHtmlTemplatePayload): Promise<HtmlTemplate> => {
    isLoading.value = true;

    try {
      const created = await templatesService.createTemplate(payload);
      templates.value = [...templates.value, created];
      return created;
    } finally {
      isLoading.value = false;
    }
  };

  const updateTemplate = async (
    id: string,
    payload: UpdateHtmlTemplatePayload,
  ): Promise<HtmlTemplate> => {
    isLoading.value = true;

    try {
      const updated = await templatesService.updateTemplate(id, payload);
      templates.value = templates.value.map((template) =>
        template.id === id ? updated : template,
      );
      return updated;
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Borrado logico. El backend devuelve la plantilla con `active: false`, pero
   * el listado solo muestra las activas: se retira de la coleccion en vez de
   * reemplazarla, para que desaparezca de la tabla sin recargar.
   */
  const deactivateTemplate = async (id: string): Promise<HtmlTemplate> => {
    isLoading.value = true;

    try {
      const deactivated = await templatesService.deactivateTemplate(id);
      templates.value = templates.value.filter((template) => template.id !== id);

      if (selectedTemplate.value?.id === id) {
        selectedTemplate.value = null;
      }

      return deactivated;
    } finally {
      isLoading.value = false;
    }
  };

  /** Compila contra un payload simulado. No toca el estado: solo devuelve. */
  const previewTemplate = async (id: string): Promise<string> => {
    isLoading.value = true;

    try {
      const { compiledMarkup } = await templatesService.previewTemplate(id);
      return compiledMarkup;
    } finally {
      isLoading.value = false;
    }
  };

  const selectTemplate = (template: HtmlTemplate | null): void => {
    selectedTemplate.value = template;
  };

  return {
    templates,
    selectedTemplate,
    isLoading,
    fetchTemplates,
    createTemplate,
    updateTemplate,
    deactivateTemplate,
    previewTemplate,
    selectTemplate,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTemplatesStore, import.meta.hot));
}
