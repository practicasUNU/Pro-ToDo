import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as templateMapperService from '@services/nodes/template-mapper.service';

import { OUTPUT_NAMESPACE_PATTERN } from '@/types/pipeline';

import type { HtmlTemplate } from '@/types/html-template';

/** Namespace por defecto, el mismo que asume `TemplateMapperStrategy`. */
const DEFAULT_OUTPUT_NAMESPACE = 'rendered_html';

/** `params` que el nodo aporta al `pipeline_schema`. */
export interface TemplateMapperConfig {
  templateId: string | null;
  outputNamespace: string;
}

// Estado reactivo del nodo MAPEADOR_PLANTILLA (regla frontend-quasar.md §3.1).
// No conoce Axios ni rutas: delega en su servicio y expone `isConfigValid`, que
// es lo unico que el asistente consulta para habilitar el avance.
export const useTemplateMapperStore = defineStore('templateMapperNode', () => {
  const config = ref<TemplateMapperConfig>({
    templateId: null,
    outputNamespace: DEFAULT_OUTPUT_NAMESPACE,
  });

  const availableTemplates = ref<HtmlTemplate[]>([]);
  const previewResult = ref<string | null>(null);
  const isLoading = ref(false);

  const selectedTemplate = computed<HtmlTemplate | null>(
    () =>
      availableTemplates.value.find((template) => template.id === config.value.templateId) ?? null,
  );

  /**
   * Contrato uniforme del nodo. Exige plantilla elegida y un `outputNamespace`
   * que el backend vaya a aceptar: validarlo aqui evita un 400 al guardar el
   * flujo entero por un guion en el namespace.
   */
  const isConfigValid = computed<boolean>(
    () =>
      config.value.templateId !== null &&
      OUTPUT_NAMESPACE_PATTERN.test(config.value.outputNamespace),
  );

  /** Variables que la plantilla elegida exige al contexto. */
  const requiredVariables = computed<string[]>(
    () => selectedTemplate.value?.requiredVariables ?? [],
  );

  const loadTemplates = async (): Promise<void> => {
    isLoading.value = true;

    try {
      availableTemplates.value = await templateMapperService.fetchSelectableTemplates();
    } finally {
      isLoading.value = false;
    }
  };

  const setTemplateId = (templateId: string | null): void => {
    config.value = { ...config.value, templateId };
    // La vista previa pertenece a la plantilla anterior: conservarla mostraria
    // un markup que ya no corresponde a la seleccion.
    previewResult.value = null;
  };

  const setOutputNamespace = (outputNamespace: string): void => {
    config.value = { ...config.value, outputNamespace };
  };

  const loadPreview = async (): Promise<void> => {
    const { templateId } = config.value;

    if (templateId === null) return;

    isLoading.value = true;

    try {
      const { compiledMarkup } = await templateMapperService.compilePreview(templateId);
      previewResult.value = compiledMarkup;
    } finally {
      isLoading.value = false;
    }
  };

  const resetConfig = (): void => {
    config.value = {
      templateId: null,
      outputNamespace: DEFAULT_OUTPUT_NAMESPACE,
    };
    previewResult.value = null;
  };

  return {
    config,
    availableTemplates,
    previewResult,
    isLoading,
    selectedTemplate,
    isConfigValid,
    requiredVariables,
    loadTemplates,
    setTemplateId,
    setOutputNamespace,
    loadPreview,
    resetConfig,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTemplateMapperStore, import.meta.hot));
}
